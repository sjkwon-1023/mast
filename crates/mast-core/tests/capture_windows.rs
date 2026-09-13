#![cfg(windows)]

use std::{
    env,
    io::{self, Write},
    process::Command,
    time::{Duration, Instant},
};

use mast_core::capture::{capture, CaptureLimits, CapturedOutput};

const STDOUT_MARKER: &[u8] = b"capture-windows-stdout";
const STDERR_MARKER: &[u8] = b"capture-windows-stderr";
const FLOOD_STDOUT: &[u8] = b"windows-stdout-flood-";
const FLOOD_STDERR: &[u8] = b"windows-stderr-flood-";

#[test]
fn child_process() {
    let Ok(mode) = env::var("MAST_CAPTURE_TEST_MODE") else {
        return;
    };

    match mode.as_str() {
        "normal" => {
            io::stdout().write_all(STDOUT_MARKER).unwrap();
            io::stderr().write_all(STDERR_MARKER).unwrap();
        }
        "flood" => {
            let mut stdout = io::stdout();
            let mut stderr = io::stderr();
            for _ in 0..4096 {
                stdout.write_all(FLOOD_STDOUT).unwrap();
                stderr.write_all(FLOOD_STDERR).unwrap();
            }
        }
        "park" => loop {
            std::thread::sleep(Duration::from_millis(10));
        },
        "nonzero" => {
            io::stderr().write_all(STDERR_MARKER).unwrap();
            panic!("capture child requested a nonzero status");
        }
        other => panic!("unknown capture child mode: {other}"),
    }
}

fn run_child(
    mode: &str,
    stdout_bytes: usize,
    stderr_bytes: usize,
    timeout: Duration,
) -> CapturedOutput {
    let executable = env::current_exe().expect("capture test executable path");
    let mut command = Command::new(executable);
    command
        .args(["--exact", "child_process", "--nocapture", "--quiet"])
        .env("MAST_CAPTURE_TEST_MODE", mode);
    capture(
        &mut command,
        CaptureLimits {
            stdout_bytes,
            stderr_bytes,
            timeout,
        },
    )
    .expect("capture child should be reaped")
}

#[test]
fn captures_native_windows_pipes_without_blocking() {
    let output = run_child("normal", 1024, 1024, Duration::from_secs(2));

    assert!(!output.timed_out);
    assert!(output
        .status
        .as_ref()
        .is_some_and(|status| status.success()));
    assert!(output
        .stdout
        .windows(STDOUT_MARKER.len())
        .any(|window| window == STDOUT_MARKER));
    assert!(output
        .stderr
        .windows(STDERR_MARKER.len())
        .any(|window| window == STDERR_MARKER));
}

#[test]
fn native_windows_flood_is_bounded_on_both_streams() {
    let output = run_child("flood", 256, 256, Duration::from_secs(2));

    assert!(output.stdout.len() <= 256);
    assert!(output.stderr.len() <= 256);
    assert!(output.stdout_truncated || output.stderr_truncated);
    assert!(!output.timed_out);
}

#[test]
fn native_windows_timeout_reaps_test_child() {
    let started = Instant::now();
    let output = run_child("park", 256, 256, Duration::from_millis(100));

    assert!(output.timed_out);
    assert!(output.status.is_some());
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn native_windows_nonzero_status_is_preserved() {
    let output = run_child("nonzero", 1024, 1024, Duration::from_secs(2));

    assert!(!output.timed_out);
    assert!(output
        .status
        .as_ref()
        .is_some_and(|status| !status.success()));
    assert!(output
        .stderr
        .windows(STDERR_MARKER.len())
        .any(|window| window == STDERR_MARKER));
}
