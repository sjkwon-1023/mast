#![cfg(unix)]

use std::{
    fs,
    process::Command,
    time::{Duration, Instant},
};

use mast_core::capture::{capture, CaptureLimits, CapturedOutput};

fn run(
    script: &str,
    stdout_bytes: usize,
    stderr_bytes: usize,
    timeout: Duration,
) -> CapturedOutput {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]);
    capture(
        &mut command,
        CaptureLimits {
            stdout_bytes,
            stderr_bytes,
            timeout,
        },
    )
    .expect("capture command should complete")
}

#[test]
fn captures_both_streams_and_nonzero_status() {
    let output = run(
        "printf out; printf err >&2; exit 7",
        64,
        64,
        Duration::from_secs(1),
    );

    assert_eq!(output.stdout, b"out");
    assert_eq!(output.stderr, b"err");
    assert_eq!(
        output.status.as_ref().and_then(|status| status.code()),
        Some(7)
    );
    assert!(!output.stdout_truncated);
    assert!(!output.stderr_truncated);
    assert!(!output.timed_out);
}

#[test]
fn child_stdin_is_null_and_already_at_eof() {
    let output = run(
        "if read value; then printf unexpected; else printf eof; fi",
        64,
        64,
        Duration::from_secs(1),
    );

    assert_eq!(output.stdout, b"eof");
    assert!(!output.timed_out);
}

#[test]
fn exact_caps_and_zero_caps_are_not_reported_as_truncated() {
    let exact = run("printf 1234; printf abcd >&2", 4, 4, Duration::from_secs(1));
    assert_eq!(exact.stdout, b"1234");
    assert_eq!(exact.stderr, b"abcd");
    assert!(!exact.stdout_truncated);
    assert!(!exact.stderr_truncated);

    let zero_empty = run(":", 0, 0, Duration::from_secs(1));
    assert!(zero_empty.stdout.is_empty());
    assert!(zero_empty.stderr.is_empty());
    assert!(!zero_empty.stdout_truncated);
    assert!(!zero_empty.stderr_truncated);

    let zero_overflow = run("printf x; printf y >&2", 0, 0, Duration::from_secs(1));
    assert!(zero_overflow.stdout.is_empty());
    assert!(zero_overflow.stderr.is_empty());
    assert!(zero_overflow.stdout_truncated);

    let overflow = run(
        "printf 12345; printf abcde >&2",
        4,
        4,
        Duration::from_secs(1),
    );
    assert_eq!(overflow.stdout, b"1234");
    assert!(b"abcd".starts_with(&overflow.stderr));
    assert!(overflow.stdout_truncated);
    let stderr_only = run("printf abcde >&2", 64, 4, Duration::from_secs(1));
    assert_eq!(stderr_only.stderr, b"abcd");
    assert!(stderr_only.stderr_truncated);
    assert!(!stderr_only.stdout_truncated);
}

#[test]
fn concurrent_flood_is_bounded_on_both_streams() {
    let output = run(
        "while :; do printf '%*s' 1024 ''; printf '%*s' 1024 '' >&2; done",
        8192,
        8192,
        Duration::from_secs(2),
    );

    assert!(output.stdout.len() <= 8192);
    assert!(output.stderr.len() <= 8192);
    assert!(output.stdout_truncated || output.stderr_truncated);
    assert!(!output.timed_out);
}

#[test]
fn timeout_stops_and_reaps_a_hung_child() {
    let started = Instant::now();
    let output = run(
        "while :; do :; done",
        1024,
        1024,
        Duration::from_millis(100),
    );

    assert!(output.timed_out);
    assert!(output.status.is_some());
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn cap_stop_reaps_the_direct_child() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let pid_path = directory.path().join("pid");
    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            "printf '%s' \"$$\" > \"$CAPTURE_PID\"; while :; do printf x; done",
        ])
        .env("CAPTURE_PID", &pid_path);

    let output = capture(
        &mut command,
        CaptureLimits {
            stdout_bytes: 32,
            stderr_bytes: 32,
            timeout: Duration::from_secs(2),
        },
    )
    .expect("capture command should complete");
    assert!(output.stdout_truncated);
    assert!(!output.timed_out);

    let pid: libc::pid_t = fs::read_to_string(pid_path)
        .expect("child should record its pid")
        .parse()
        .expect("pid should be numeric");
    let result = unsafe { libc::kill(pid, 0) };
    assert_eq!(result, -1, "stopped child still exists: pid {pid}");
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[test]
fn parent_exit_does_not_wait_for_a_descendant_holding_the_pipe() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let marker = directory.path().join("late");
    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            "(sleep 1; printf late > \"$CAPTURE_MARKER\") & printf parent; exit 0",
        ])
        .env("CAPTURE_MARKER", &marker);
    let started = Instant::now();
    let output = capture(
        &mut command,
        CaptureLimits {
            stdout_bytes: 64,
            stderr_bytes: 64,
            timeout: Duration::from_millis(200),
        },
    )
    .expect("capture command should complete");

    assert_eq!(output.stdout, b"parent");
    assert_eq!(
        output.status.as_ref().and_then(|status| status.code()),
        Some(0)
    );
    assert!(output.timed_out);
    assert!(started.elapsed() < Duration::from_secs(1));
    std::thread::sleep(Duration::from_millis(1_100));
    assert!(
        !marker.exists(),
        "descendant survived process-group cleanup"
    );
}

#[test]
fn descendant_output_arriving_after_parent_exit_is_drained() {
    let output = run(
        "(sleep 0.05; printf late) & printf parent; exit 0",
        64,
        64,
        Duration::from_secs(1),
    );

    assert_eq!(output.stdout, b"parentlate");
    assert!(!output.timed_out);
    assert!(!output.stdout_truncated);
}
