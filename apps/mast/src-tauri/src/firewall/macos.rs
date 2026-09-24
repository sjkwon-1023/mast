use std::{
    process::{Command, ExitStatus, Stdio},
    time::Duration,
};

use mast_core::capture::{capture, CaptureLimits};

use super::{AllowOutcome, FirewallStatus};

const SOCKETFILTERFW: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";
const OSASCRIPT: &str = "/usr/bin/osascript";
const READ_TIMEOUT: Duration = Duration::from_secs(3);
const APPLY_TIMEOUT: Duration = Duration::from_secs(120);
const STREAM_LIMIT: usize = 8 * 1024;
// `--listapps` 는 등록된 앱마다 두 줄을 낸다. 앱이 많은 Mac 에서도 잘리지 않게 넉넉히 두되 상한은 유지한다.
const LIST_APPS_LIMIT: usize = 256 * 1024;
const BLOCK_ALL_DETAIL: &str = "Block all incoming connections";
const APP_BLOCKED_DETAIL: &str = "This app is blocked by macOS Firewall";

const APPLESCRIPT_HEADER: &str = "use scripting additions\non run argv\n";
const APPLESCRIPT_ARGUMENT_HANDLER: &str = "    if (count of argv) is not 1 then\n\
        error \"invalid argument count\" number -50\n\
    end if\n\
    set quotedExecutablePath to quoted form of (item 1 of argv)\n";
const APPLESCRIPT_ELEVATED_ACTION: &str = "    set shellCommand to \"/usr/libexec/ApplicationFirewall/socketfilterfw --add \" & quotedExecutablePath & \" ; /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp \" & quotedExecutablePath\n\
    try\n\
        do shell script shellCommand with administrator privileges\n\
        return \"applied\"\n\
    on error errorMessage number errorNumber\n\
        if errorNumber is -128 then\n\
            return \"declined\"\n\
        end if\n\
        error errorMessage number errorNumber\n\
    end try\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AppRule {
    Blocked,
    Permitted,
    NotInFirewall,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ApplyResult {
    Applied,
    Declined,
}

struct CapturedText {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

pub fn status(port: u16) -> FirewallStatus {
    let exe = match current_exe_text() {
        Ok(exe) => exe,
        Err(reason) => return FirewallStatus::unknown(String::new(), port, reason),
    };
    status_with(port, Ok(exe), read_socketfilterfw)
}

pub fn secure_status(port: u16) -> FirewallStatus {
    status(port)
}

pub fn allow(port: u16) -> AllowOutcome {
    allow_with(port, apply_current_executable, status)
}

pub fn secure_allow(port: u16) -> AllowOutcome {
    allow(port)
}

fn current_exe_text() -> Result<String, String> {
    let path = std::env::current_exe()
        .map_err(|error| format!("cannot read this executable's path: {error}"))?;
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "this executable's path is not valid Unicode".to_owned())
}

fn status_with<F>(port: u16, exe: Result<String, String>, mut read: F) -> FirewallStatus
where
    F: FnMut(&[&str]) -> Result<String, String>,
{
    let exe = match exe {
        Ok(exe) => exe,
        Err(reason) => return FirewallStatus::unknown(String::new(), port, reason),
    };

    match read_status(port, &exe, &mut read) {
        Ok(status) => status,
        Err(reason) => FirewallStatus::unknown(exe, port, reason),
    }
}

fn read_status<F>(port: u16, exe: &str, read: &mut F) -> Result<FirewallStatus, String>
where
    F: FnMut(&[&str]) -> Result<String, String>,
{
    let global_output = read(&["--getglobalstate"])
        .map_err(|reason| format!("socketfilterfw --getglobalstate failed: {reason}"))?;
    match parse_global_state(&global_output) {
        Some(false) => return Ok(make_status("firewallOff", None, exe, port)),
        Some(true) => {}
        None => return Err("unrecognized --getglobalstate output".to_owned()),
    }

    let block_all_output = read(&["--getblockall"])
        .map_err(|reason| format!("socketfilterfw --getblockall failed: {reason}"))?;
    match parse_block_all(&block_all_output) {
        Some(true) => {
            return Ok(make_status("blocked", Some(BLOCK_ALL_DETAIL), exe, port));
        }
        Some(false) => {}
        None => return Err("unrecognized --getblockall output".to_owned()),
    }

    // `--getappblocked` 는 목록에 없는 경로(존재하지 않는 경로 포함)도 "permitted" 라고 답한다.
    // 그래서 허용 여부는 등록 목록(`--listapps`)에서 이 실행 파일의 항목으로만 판정한다.
    let list_output = read(&["--listapps"])
        .map_err(|reason| format!("socketfilterfw --listapps failed: {reason}"))?;
    match parse_listed_app(&list_output, exe) {
        Some(AppRule::Blocked) => Ok(make_status("blocked", Some(APP_BLOCKED_DETAIL), exe, port)),
        Some(AppRule::Permitted) => Ok(make_status("allowed", None, exe, port)),
        Some(AppRule::NotInFirewall) => Ok(make_status("missing", None, exe, port)),
        None => Err("unrecognized --listapps output".to_owned()),
    }
}

fn make_status(state: &'static str, detail: Option<&str>, exe: &str, port: u16) -> FirewallStatus {
    FirewallStatus {
        state,
        detail: detail.map(str::to_owned),
        exe: exe.to_owned(),
        port,
        current_profiles: Vec::new(),
    }
}

fn parse_global_state(output: &str) -> Option<bool> {
    let output = trim_output_whitespace(output);
    match output {
        "Firewall is disabled. (State = 0)" => Some(false),
        "Firewall is enabled. (State = 1)" | "Firewall is enabled. (State = 2)" => Some(true),
        _ => None,
    }
}

fn parse_block_all(output: &str) -> Option<bool> {
    let output = trim_output_whitespace(output);
    match output {
        // 현행 API(`Firewall %s.`)와 구 API 의 문구 — socketfilterfw 바이너리의 문자열 표와 대조했다.
        "Firewall is blocking all non-essential incoming connections."
        | "Firewall is set to block all non-essential incoming connections" => Some(true),
        "Firewall has block all state set to disabled." | "Block all DISABLED!" => Some(false),
        _ => None,
    }
}

/// `--listapps` 출력에서 이 실행 파일의 규칙을 찾는다. 형식은
/// `Total number of apps = N ` 다음에 앱마다 `<번호> : <경로> ` 한 줄과
/// `(Allow incoming connections)` 또는 `(Block incoming connections)` 한 줄이다.
/// 항목 수가 머리줄과 다르거나 형식이 어긋나면 None(알 수 없음)이다. 경로는 줄 전체가
/// 정확히 같아야 하고, 개행이 든 경로는 줄 단위로 대조할 수 없어 None 이다.
fn parse_listed_app(output: &str, exe: &str) -> Option<AppRule> {
    if exe.contains('\n') || exe.contains('\r') {
        return None;
    }
    let mut lines = output.split('\n').map(|line| line.trim_end_matches('\r'));
    let header = lines.next()?.trim_end_matches(' ');
    let expected: usize = header.strip_prefix("Total number of apps = ")?.parse().ok()?;
    let mut rows = lines.filter(|line| !line.trim().is_empty());
    let mut found = None;
    for index in 1..=expected {
        let path = rows
            .next()?
            .strip_prefix(&format!("{index} : "))?
            .strip_suffix(' ')?;
        let rule = match rows.next()?.trim() {
            "(Allow incoming connections)" => AppRule::Permitted,
            "(Block incoming connections)" => AppRule::Blocked,
            _ => return None,
        };
        // 같은 경로가 두 번 나오면 어느 규칙이 적용되는지 알 수 없다.
        if path == exe && found.replace(rule).is_some() {
            return None;
        }
    }
    if rows.next().is_some() {
        return None;
    }
    Some(found.unwrap_or(AppRule::NotInFirewall))
}

fn trim_output_whitespace(output: &str) -> &str {
    output.trim_end_matches(is_output_whitespace)
}

fn is_output_whitespace(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\r' | '\n')
}

fn read_socketfilterfw(arguments: &[&str]) -> Result<String, String> {
    let mut command = Command::new(SOCKETFILTERFW);
    command.args(arguments).env("LC_ALL", "C");
    let limit = if arguments == ["--listapps"] {
        LIST_APPS_LIMIT
    } else {
        STREAM_LIMIT
    };
    let captured = capture_text(&mut command, READ_TIMEOUT, limit)?;
    if !captured.status.success() {
        return Err(format!(
            "command exited unsuccessfully ({})",
            exit_status_text(&captured.status)
        ));
    }
    Ok(captured.stdout)
}

fn capture_text(
    command: &mut Command,
    timeout: Duration,
    stdout_limit: usize,
) -> Result<CapturedText, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = capture(
        command,
        CaptureLimits {
            stdout_bytes: stdout_limit,
            stderr_bytes: STREAM_LIMIT,
            timeout,
        },
    )
    .map_err(|reason| format!("cannot capture command output: {reason}"))?;

    if output.timed_out {
        return Err(format!(
            "command timed out after {} seconds",
            timeout.as_secs()
        ));
    }
    if output.stdout_truncated || output.stderr_truncated {
        return Err("command output exceeded its size limit".to_owned());
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "command stdout was not valid UTF-8".to_owned())?;
    let stderr = String::from_utf8(output.stderr)
        .map_err(|_| "command stderr was not valid UTF-8".to_owned())?;
    let status = output
        .status
        .ok_or_else(|| "command ended without an exit status".to_owned())?;

    Ok(CapturedText {
        status,
        stdout,
        stderr,
    })
}

fn apply_current_executable() -> Result<ApplyResult, String> {
    let exe = current_exe_text()?;
    run_elevation(&exe)
}

fn elevation_script() -> String {
    format!(
        "{APPLESCRIPT_HEADER}{APPLESCRIPT_ARGUMENT_HANDLER}{APPLESCRIPT_ELEVATED_ACTION}end run\n"
    )
}

fn elevation_command(exe: &str) -> Command {
    let mut command = Command::new(OSASCRIPT);
    command.arg("-e").arg(elevation_script()).arg(exe);
    command
}

fn run_elevation(exe: &str) -> Result<ApplyResult, String> {
    let mut command = elevation_command(exe);
    let captured = capture_text(&mut command, APPLY_TIMEOUT, STREAM_LIMIT).map_err(|reason| {
        if reason.starts_with("command timed out") {
            format!(
                "administrator approval timed out after {} seconds; the operation may have continued",
                APPLY_TIMEOUT.as_secs()
            )
        } else {
            reason
        }
    })?;
    if !captured.status.success() {
        let detail = captured.stderr.trim();
        return Err(if detail.is_empty() {
            format!(
                "osascript exited unsuccessfully ({})",
                exit_status_text(&captured.status)
            )
        } else {
            format!("osascript failed: {detail}")
        });
    }

    match trim_output_whitespace(&captured.stdout) {
        "applied" => Ok(ApplyResult::Applied),
        "declined" => Ok(ApplyResult::Declined),
        _ => Err("osascript returned an unrecognized result".to_owned()),
    }
}

fn exit_status_text(status: &ExitStatus) -> String {
    status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "terminated by signal".to_owned())
}

fn allow_with<A, S>(port: u16, apply: A, redetect: S) -> AllowOutcome
where
    A: FnOnce() -> Result<ApplyResult, String>,
    S: FnOnce(u16) -> FirewallStatus,
{
    let (outcome, detail) = match apply() {
        Ok(ApplyResult::Applied) => ("applied", None),
        Ok(ApplyResult::Declined) => ("declined", None),
        Err(reason) => ("failed", Some(reason)),
    };
    AllowOutcome {
        outcome,
        detail,
        status: redetect(port),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "/Applications/Mast.app/Contents/MacOS/mast";
    const PORT: u16 = 7331;
    const GLOBAL_ENABLED: &str = "Firewall is enabled. (State = 1)\n";
    const BLOCK_ALL_DISABLED: &str = "Firewall has block all state set to disabled.\n";

    /// 실제 `socketfilterfw --listapps` 형식으로 목록을 만든다.
    fn list_apps(entries: &[(&str, &str)]) -> String {
        let mut output = format!("Total number of apps = {} \n", entries.len());
        for (index, (path, rule)) in entries.iter().enumerate() {
            output.push_str(&format!(
                "{} : {path} \n             ({rule} incoming connections)\n",
                index + 1
            ));
        }
        output
    }

    fn status_for_list(list_output: &str) -> FirewallStatus {
        status_with(PORT, Ok(EXE.to_owned()), |arguments| match arguments {
            ["--getglobalstate"] => Ok(GLOBAL_ENABLED.to_owned()),
            ["--getblockall"] => Ok(BLOCK_ALL_DISABLED.to_owned()),
            ["--listapps"] => Ok(list_output.to_owned()),
            _ => Err("unexpected arguments".to_owned()),
        })
    }

    #[test]
    fn mac_status_handles_off_block_all_app_rules_and_unknown() {
        let off = status_with(PORT, Ok(EXE.to_owned()), |arguments| match arguments {
            ["--getglobalstate"] => Ok("Firewall is disabled. (State = 0)\n".to_owned()),
            _ => Err("disabled status must stop after the first query".to_owned()),
        });
        assert_eq!(off.state, "firewallOff");
        assert!(off.current_profiles.is_empty());

        assert_eq!(
            parse_global_state("Firewall is enabled. (State = 1)\n"),
            Some(true)
        );
        assert_eq!(
            parse_global_state("Firewall is enabled. (State = 2)\n"),
            Some(true)
        );
        assert_eq!(
            parse_global_state("Firewall is disabled. (State = 2)"),
            None
        );
        assert_eq!(parse_global_state("Firewall is enabled. (State = 3)"), None);

        let blocked_all = status_with(PORT, Ok(EXE.to_owned()), |arguments| match arguments {
            ["--getglobalstate"] => Ok("Firewall is enabled. (State = 2)\n".to_owned()),
            ["--getblockall"] => {
                Ok("Firewall is blocking all non-essential incoming connections.\n".to_owned())
            }
            ["--listapps"] => panic!("block-all must take precedence over app status"),
            _ => Err("unexpected arguments".to_owned()),
        });
        assert_eq!(blocked_all.state, "blocked");
        assert_eq!(blocked_all.detail.as_deref(), Some(BLOCK_ALL_DETAIL));

        // 구 API 의 block-all 문구도 인식한다.
        assert_eq!(
            parse_block_all("Firewall is set to block all non-essential incoming connections \n"),
            Some(true)
        );
        assert_eq!(parse_block_all("Block all DISABLED! \n"), Some(false));

        let blocked_app = status_for_list(&list_apps(&[
            ("/usr/sbin/cupsd", "Allow"),
            (EXE, "Block"),
        ]));
        assert_eq!(blocked_app.state, "blocked");
        assert_ne!(blocked_app.detail.as_deref(), Some(BLOCK_ALL_DETAIL));

        let permitted = status_for_list(&list_apps(&[(EXE, "Allow"), ("/usr/sbin/smbd", "Allow")]));
        assert_eq!(permitted.state, "allowed");

        // 목록에 없는 앱은 허용된 것이 아니다 — `--getappblocked` 가 뭐라고 하든 미등록이다.
        let missing = status_for_list(&list_apps(&[("/usr/libexec/remoted", "Allow")]));
        assert_eq!(missing.state, "missing");
        let empty = status_for_list("Total number of apps = 0 \n");
        assert_eq!(empty.state, "missing");

        for reason in [
            "nonzero exit status",
            "command timed out after 3 seconds",
            "command output exceeded the 8 KiB limit",
            "command stdout was not valid UTF-8",
        ] {
            let unknown = status_with(PORT, Ok(EXE.to_owned()), |_| Err(reason.to_owned()));
            assert_eq!(unknown.state, "unknown", "{reason}");
        }
        let unknown = status_with(PORT, Ok(EXE.to_owned()), |_| {
            Ok("Firewall is enabled. (State = undefined)\n".to_owned())
        });
        assert_eq!(unknown.state, "unknown");
    }

    #[test]
    fn mac_status_never_uses_windows_profiles_or_port_rules() {
        let mut invocations = Vec::new();
        let mut read = |arguments: &[&str]| {
            invocations.push(
                arguments
                    .iter()
                    .map(|arg| (*arg).to_owned())
                    .collect::<Vec<_>>(),
            );
            match arguments {
                ["--getglobalstate"] => Ok(GLOBAL_ENABLED.to_owned()),
                ["--getblockall"] => Ok(BLOCK_ALL_DISABLED.to_owned()),
                ["--listapps"] => Ok(list_apps(&[(EXE, "Allow")])),
                _ => Err("unexpected arguments".to_owned()),
            }
        };

        let tcp = status_with(PORT, Ok(EXE.to_owned()), &mut read);
        let udp = status_with(9444, Ok(EXE.to_owned()), &mut read);
        assert_eq!(tcp.state, "allowed");
        assert_eq!(udp.state, "allowed");
        assert!(tcp.current_profiles.is_empty());
        assert!(udp.current_profiles.is_empty());
        assert_eq!(tcp.port, PORT);
        assert_eq!(udp.port, 9444);
        assert_eq!(
            invocations,
            vec![
                vec!["--getglobalstate"],
                vec!["--getblockall"],
                vec!["--listapps"],
                vec!["--getglobalstate"],
                vec!["--getblockall"],
                vec!["--listapps"],
            ]
        );
    }

    #[test]
    fn path_text_cannot_forge_an_allowed_status() {
        let exe = "/tmp/permitted 'single' \"double\" \\slash $() `tick` Ω";
        assert_eq!(
            parse_listed_app(&list_apps(&[(exe, "Allow")]), exe),
            Some(AppRule::Permitted)
        );
        // 접두어만 같은 다른 경로의 허용은 이 앱의 허용이 아니다.
        assert_eq!(
            parse_listed_app(&list_apps(&[(&format!("{exe}x"), "Allow")]), exe),
            Some(AppRule::NotInFirewall)
        );
        assert_eq!(
            parse_listed_app(&list_apps(&[(&exe[..exe.len() - 3], "Allow")]), exe),
            Some(AppRule::NotInFirewall)
        );
        // 같은 경로가 두 번이면 어느 규칙인지 알 수 없다.
        assert_eq!(
            parse_listed_app(&list_apps(&[(exe, "Block"), (exe, "Allow")]), exe),
            None
        );
        // 머리줄의 항목 수와 실제 항목이 다르면 잘린 출력이다.
        let truncated = list_apps(&[(exe, "Allow")]).replace("= 1 ", "= 2 ");
        assert_eq!(parse_listed_app(&truncated, exe), None);
        let unknown_rule = list_apps(&[(exe, "Allow")]).replace("(Allow", "(Maybe");
        assert_eq!(parse_listed_app(&unknown_rule, exe), None);
        // 개행이 든 경로는 줄 단위로 대조할 수 없다.
        let multiline = "/tmp/a\n1 : /tmp/b";
        assert_eq!(parse_listed_app(&list_apps(&[("/tmp/b", "Allow")]), multiline), None);
    }

    #[test]
    fn real_listapps_output_decides_the_app_rule() {
        // macOS 26.6.2 의 `socketfilterfw --listapps` 원본 출력(공백 포함 그대로).
        const REAL: &str = "Total number of apps = 7 \n1 : /usr/libexec/remoted \n             (Allow incoming connections)\n2 : /usr/bin/python3 \n             (Allow incoming connections)\n3 : /usr/bin/ruby \n             (Allow incoming connections)\n4 : /usr/sbin/cupsd \n             (Allow incoming connections)\n5 : /usr/libexec/sharingd \n             (Allow incoming connections)\n6 : /usr/libexec/sshd-keygen-wrapper \n             (Allow incoming connections)\n7 : /usr/sbin/smbd \n             (Allow incoming connections)\n";
        assert_eq!(parse_listed_app(REAL, "/usr/sbin/cupsd"), Some(AppRule::Permitted));
        assert_eq!(
            parse_listed_app(REAL, "/System/Applications/Calculator.app"),
            Some(AppRule::NotInFirewall)
        );
        assert_eq!(parse_listed_app(REAL, "/usr/sbin/cups"), Some(AppRule::NotInFirewall));
    }

    #[test]
    fn elevation_has_one_data_argument_and_fixed_script() {
        let exe = "/tmp/a 'quoted' \"path\" $HOME `whoami`\nline";
        let command = elevation_command(exe);
        assert_eq!(command.get_program().to_str(), Some(OSASCRIPT));
        let arguments = command
            .get_args()
            .map(|argument| argument.to_str().expect("ASCII argument").to_owned())
            .collect::<Vec<_>>();
        assert_eq!(arguments.len(), 3);
        assert_eq!(arguments[0], "-e");
        assert_eq!(arguments[1], elevation_script());
        assert_eq!(arguments[2], exe);
        assert!(!arguments[1].contains(exe));
        assert!(arguments[1].contains("count of argv) is not 1"));
        assert!(arguments[1].contains("quoted form of (item 1 of argv)"));
        assert!(arguments[1].contains("socketfilterfw --add "));
        assert!(arguments[1].contains("socketfilterfw --unblockapp "));
        assert!(arguments[1].contains("with administrator privileges"));
        assert!(!arguments[1].contains("--setglobalstate"));
        assert!(!arguments[1].contains("--setblockall"));
    }

    #[test]
    fn applescript_shell_quote_roundtrips_unusual_paths() {
        let executable = "/tmp/a 'single' \"double\" \\ slash\nCR\r雪 $HOME `tick`\n";
        let expected_hex = executable
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let test_script = format!(
            "{APPLESCRIPT_HEADER}{APPLESCRIPT_ARGUMENT_HANDLER}    return do shell script \"/usr/bin/printf %s \" & quotedExecutablePath & \" | /usr/bin/xxd -p -c 4096\"\nend run\n"
        );
        assert!(!test_script.contains("with administrator privileges"));
        let mut command = Command::new(OSASCRIPT);
        command.arg("-e").arg(test_script).arg(executable);
        let captured = capture_text(&mut command, READ_TIMEOUT, STREAM_LIMIT)
            .expect("non-elevated osascript");
        assert!(captured.status.success(), "{}", captured.stderr);
        let returned_hex = captured
            .stdout
            .trim_end_matches(|character| matches!(character, '\r' | '\n'));
        assert_eq!(returned_hex, expected_hex);
    }

    #[test]
    fn allow_always_reports_the_redetected_state() {
        let calls = std::cell::RefCell::new(Vec::new());
        let outcome = allow_with(
            PORT,
            || {
                calls.borrow_mut().push("apply");
                Ok(ApplyResult::Applied)
            },
            |port| {
                calls.borrow_mut().push("redetect");
                assert_eq!(port, PORT);
                make_status("blocked", Some(APP_BLOCKED_DETAIL), EXE, port)
            },
        );
        assert_eq!(calls.borrow().as_slice(), ["apply", "redetect"]);
        assert_eq!(outcome.outcome, "applied");
        assert_eq!(outcome.status.state, "blocked");

        let declined = allow_with(
            PORT,
            || Ok(ApplyResult::Declined),
            |port| make_status("firewallOff", None, EXE, port),
        );
        assert_eq!(declined.outcome, "declined");
        assert_eq!(declined.status.state, "firewallOff");

        let failed = allow_with(
            PORT,
            || Err("osascript failed".to_owned()),
            |port| FirewallStatus::unknown(EXE.to_owned(), port, "redetection failed".to_owned()),
        );
        assert_eq!(failed.outcome, "failed");
        assert_eq!(failed.detail.as_deref(), Some("osascript failed"));
        assert_eq!(failed.status.state, "unknown");
        assert_eq!(failed.status.detail.as_deref(), Some("redetection failed"));
    }
}
