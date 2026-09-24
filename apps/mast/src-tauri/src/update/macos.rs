use std::{process::Command, time::Duration};

use mast_core::{
    capture::{capture, CaptureLimits},
    update::MAX_RELEASE_BYTES,
};

const CURL_PATH: &str = "/usr/bin/curl";
const RELEASE_URL: &str = "https://api.github.com/repos/sjkwon-1023/mast/releases/latest";
const MAX_HEADER_BYTES: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);

const REQUEST_LIMITS: CaptureLimits = CaptureLimits {
    stdout_bytes: MAX_RELEASE_BYTES,
    stderr_bytes: MAX_HEADER_BYTES,
    timeout: REQUEST_TIMEOUT,
};

pub(super) fn fetch() -> Result<Vec<u8>, String> {
    capture_response(&mut curl_command(), REQUEST_LIMITS)
}

fn curl_command() -> Command {
    let mut command = Command::new(CURL_PATH);
    command.env_clear().env("LC_ALL", "C").args([
        "--disable",
        "--silent",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--http1.1",
        "--suppress-connect-headers",
        "--dump-header",
        "/dev/stderr",
        "--connect-timeout",
        "3",
        "--speed-limit",
        "1",
        "--speed-time",
        "3",
        "--max-time",
        "11",
        "--user-agent",
        concat!("mast/", env!("CARGO_PKG_VERSION")),
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        "X-GitHub-Api-Version: 2022-11-28",
        RELEASE_URL,
    ]);
    command
}

fn capture_response(command: &mut Command, limits: CaptureLimits) -> Result<Vec<u8>, String> {
    let output = capture(command, limits)
        .map_err(|error| format!("cannot capture macOS release response: {error}"))?;
    if output.timed_out {
        return Err("macOS release request exceeded its deadline".into());
    }
    if output.stdout_truncated {
        return Err("release body exceeds 64 KiB".into());
    }
    if output.stderr_truncated {
        return Err("release headers exceed 16 KiB".into());
    }
    let status = output
        .status
        .ok_or_else(|| "macOS release request produced no exit status".to_string())?;
    if !status.success() {
        return Err(format!("curl failed with status {status}"));
    }

    validate_response_headers(&output.stderr)?;
    Ok(output.stdout)
}

fn validate_response_headers(bytes: &[u8]) -> Result<(), String> {
    let mut cursor = 0;
    let mut final_status = None;

    while cursor < bytes.len() {
        if final_status.is_some() {
            return Err("unexpected data after final HTTP response headers".into());
        }

        let status_line = next_header_line(bytes, &mut cursor)?;
        let status = parse_status_line(status_line)?;
        loop {
            let line = next_header_line(bytes, &mut cursor)?;
            if line.is_empty() {
                break;
            }
            validate_header_line(line)?;
        }

        if (100..200).contains(&status) && status != 101 {
            continue;
        }
        if status != 200 {
            return Err(format!("GitHub returned HTTP {status}"));
        }
        final_status = Some(status);
    }

    if final_status.is_some() {
        Ok(())
    } else {
        Err("release response has no final HTTP 200 headers".into())
    }
}

fn next_header_line<'a>(bytes: &'a [u8], cursor: &mut usize) -> Result<&'a [u8], String> {
    let remaining = &bytes[*cursor..];
    let end = remaining
        .windows(2)
        .position(|pair| pair == b"\r\n")
        .ok_or_else(|| "release response has an incomplete HTTP header line".to_string())?;
    let line = &remaining[..end];
    if line.contains(&b'\r') || line.contains(&b'\n') {
        return Err("release response has a malformed HTTP header line".into());
    }
    *cursor += end + 2;
    Ok(line)
}

fn parse_status_line(line: &[u8]) -> Result<u16, String> {
    if line.len() < 13
        || &line[..7] != b"HTTP/1."
        || !line[7].is_ascii_digit()
        || line[8] != b' '
        || !line[9..12].iter().all(u8::is_ascii_digit)
        || line[12] != b' '
        || line[13..]
            .iter()
            .any(|byte| (*byte < b' ' && *byte != b'\t') || *byte == 0x7f)
    {
        return Err("release response has a malformed HTTP/1.x status line".into());
    }

    let status = u16::from(line[9] - b'0') * 100
        + u16::from(line[10] - b'0') * 10
        + u16::from(line[11] - b'0');
    if !(100..=599).contains(&status) {
        return Err("release response has an invalid HTTP status code".into());
    }
    Ok(status)
}

fn validate_header_line(line: &[u8]) -> Result<(), String> {
    let colon = line
        .iter()
        .position(|byte| *byte == b':')
        .ok_or_else(|| "release response has a malformed HTTP header".to_string())?;
    if colon == 0
        || !line[..colon]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(byte))
        || line[colon + 1..]
            .iter()
            .any(|byte| (*byte < b' ' && *byte != b'\t') || *byte == 0x7f)
    {
        return Err("release response has a malformed HTTP header".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::OsString,
        process::Command,
        time::{Duration, Instant},
    };

    use mast_core::update::{newer_release, MAX_RELEASE_BYTES};

    use super::{capture_response, curl_command, CaptureLimits, MAX_HEADER_BYTES, REQUEST_LIMITS};

    #[test]
    fn curl_request_is_fixed_and_ignores_user_configuration() {
        let command = curl_command();
        let args = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(command.get_program(), super::CURL_PATH);
        assert_eq!(args.first().map(String::as_str), Some("--disable"));
        assert!(args.windows(2).any(|pair| pair == ["--proto", "=https"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--connect-timeout", "3"]));
        assert!(args.windows(2).any(|pair| pair == ["--speed-limit", "1"]));
        assert!(args.windows(2).any(|pair| pair == ["--speed-time", "3"]));
        assert!(args.windows(2).any(|pair| pair == ["--max-time", "11"]));
        assert!(args
            .windows(2)
            .any(|pair| { pair == ["--user-agent", concat!("mast/", env!("CARGO_PKG_VERSION"))] }));
        assert!(args
            .windows(2)
            .any(|pair| { pair == ["--header", "Accept: application/vnd.github+json"] }));
        assert!(args
            .windows(2)
            .any(|pair| { pair == ["--header", "X-GitHub-Api-Version: 2022-11-28"] }));
        assert_eq!(args.last().map(String::as_str), Some(super::RELEASE_URL));
        assert!(args.contains(&"--tlsv1.2".to_string()));
        assert!(args.contains(&"--http1.1".to_string()));
        assert!(args.contains(&"/dev/stderr".to_string()));
        assert_eq!(REQUEST_LIMITS.stdout_bytes, MAX_RELEASE_BYTES);
        assert_eq!(REQUEST_LIMITS.stderr_bytes, MAX_HEADER_BYTES);
        assert_eq!(REQUEST_LIMITS.timeout, Duration::from_secs(12));

        let environment = command
            .get_envs()
            .map(|(key, value)| (key.to_owned(), value.map(OsString::from)))
            .collect::<Vec<_>>();
        assert_eq!(
            environment,
            vec![(OsString::from("LC_ALL"), Some(OsString::from("C")))]
        );

        for forbidden in [
            "--location",
            "-L",
            "--cookie",
            "--netrc",
            "--user",
            "--retry",
            "--insecure",
            "-k",
            "--config",
            "--output",
        ] {
            assert!(!args.iter().any(|argument| argument == forbidden));
        }
    }

    #[test]
    fn only_complete_http_200_returns_a_body() {
        let accepted = [
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n",
            "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n\r\n",
            "HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\n\r\n",
        ];
        for headers in accepted {
            assert_eq!(
                run_fixture(headers, "release body").unwrap(),
                b"release body"
            );
        }

        let rejected = [
            "HTTP/1.1 301 Moved Permanently\r\nLocation: https://example.test/\r\n\r\n",
            "HTTP/1.1 403 Forbidden\r\n\r\n",
            "HTTP/1.1 429 Too Many Requests\r\n\r\n",
            "HTTP/1.1 500 Internal Server Error\r\n\r\n",
            "HTTP/1.1 200 OK\r\n",
            "HTTP/1.1 200 OK\r\nContent-Type: application/json",
            "HTTP/1.1 100 Continue\r\n\r\n",
            "HTTP/1.1 200 OK\r\ninvalid header\r\n\r\n",
        ];
        for headers in rejected {
            assert!(
                run_fixture(headers, "must not be returned").is_err(),
                "{headers:?}"
            );
        }
    }

    #[test]
    fn body_and_headers_have_independent_limits() {
        let oversized_body = "x".repeat(MAX_RELEASE_BYTES + 1);
        let error = run_fixture("HTTP/1.1 200 OK\r\n\r\n", &oversized_body).unwrap_err();
        assert!(error.contains("body exceeds 64 KiB"));

        let oversized_headers = format!(
            "HTTP/1.1 200 OK\r\nX-Fill: {}\r\n\r\n",
            "x".repeat(MAX_HEADER_BYTES)
        );
        let error = run_fixture(&oversized_headers, "small body").unwrap_err();
        assert!(error.contains("headers exceed 16 KiB"));
    }

    #[test]
    fn stalled_child_is_stopped_and_failure_has_no_release() {
        let started = Instant::now();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 5"]);
        let limits = CaptureLimits {
            timeout: Duration::from_millis(100),
            ..REQUEST_LIMITS
        };

        let error = capture_response(&mut command, limits).unwrap_err();
        assert!(error.contains("exceeded its deadline"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    #[ignore = "manual GitHub network probe"]
    fn github_release_probe_macos() {
        let body = super::fetch().unwrap();
        let latest = newer_release("0.0.0", &body).unwrap();
        assert!(latest.is_some());
    }

    fn run_fixture(headers: &str, body: &str) -> Result<Vec<u8>, String> {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "printf '%s' \"$1\"; printf '%s' \"$2\" >&2",
            "release-fixture",
            body,
            headers,
        ]);
        capture_response(&mut command, REQUEST_LIMITS)
    }
}
