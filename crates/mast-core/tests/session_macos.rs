//! Native process-lifetime regressions. These run only on real macOS, not via a
//! mocked process table, and use separate foreground/background job groups.
#![cfg(target_os = "macos")]
use mast_core::osc::OscEvent;
use mast_core::session::{
    Delivery, PtySession, SessionManager, SessionOptions, SessionSink, SpawnSpec,
};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Captured {
    bytes: Vec<u8>,
    exits: usize,
}
struct Sink(Arc<Mutex<Captured>>);
impl SessionSink for Sink {
    fn on_output(&self, _offset: u64, bytes: &[u8]) -> Delivery {
        self.0.lock().unwrap().bytes.extend_from_slice(bytes);
        Delivery::Dropped
    }
    fn on_osc(&self, _event: &OscEvent) {}
    fn on_exit(&self, _code: Option<u32>) {
        self.0.lock().unwrap().exits += 1;
    }
}
fn spec(exit: bool) -> SpawnSpec {
    SpawnSpec {
        program: "/bin/bash".into(),
        args: vec!["-c".into(), format!(
            "set -m; trap '' HUP; (trap '' HUP; exec sleep 600) & child=$!; printf 'MAST_CHILD:%s\\n' \"$child\"; {}",
            if exit { "exit 0" } else { "wait" }
        )], cwd: None, cols: 80, rows: 24,
    }
}
fn until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "native PTY operation did not finish"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn child_pid(output: &Arc<Mutex<Captured>>) -> libc::pid_t {
    let mut pid = None;
    until(|| {
        let output = output.lock().unwrap();
        for line in String::from_utf8_lossy(&output.bytes).lines() {
            if let Some(value) = line.strip_prefix("MAST_CHILD:") {
                pid = value.trim().parse().ok();
            }
        }
        pid.is_some()
    });
    pid.unwrap()
}
fn gone(pid: libc::pid_t) -> bool {
    (unsafe { libc::kill(pid, 0) }) == -1
}

#[test]
fn closing_tab_kills_background_jobs_that_ignore_hup() {
    let output = Arc::new(Mutex::new(Captured::default()));
    let session = PtySession::spawn(
        spec(false),
        Box::new(Sink(output.clone())),
        SessionOptions::default(),
    )
    .unwrap();
    let child = child_pid(&output);
    assert!(!gone(child));
    session.kill();
    session.kill(); // idempotent; never signal a subsequently reused PID
    until(|| gone(child));
    until(|| output.lock().unwrap().exits == 1);
}

#[test]
fn natural_shell_exit_also_cleans_background_jobs() {
    let output = Arc::new(Mutex::new(Captured::default()));
    let _session = PtySession::spawn(
        spec(true),
        Box::new(Sink(output.clone())),
        SessionOptions::default(),
    )
    .unwrap();
    let child = child_pid(&output);
    until(|| gone(child));
    until(|| output.lock().unwrap().exits == 1);
}

#[test]
fn app_shutdown_ends_owned_jobs_without_changing_restorable_tab_state() {
    let manager = SessionManager::new();
    let output = Arc::new(Mutex::new(Captured::default()));
    let id = manager
        .create(spec(false), SessionOptions::default(), |_| {
            Box::new(Sink(output.clone()))
        })
        .unwrap();
    let retained_handle = manager.get(id).unwrap();
    let child = child_pid(&output);
    manager.shutdown();
    manager.shutdown();
    until(|| gone(child));
    assert!(manager.ids().is_empty());
    assert!(retained_handle.write(b"echo should-not-run\n").is_err());
    assert!(manager
        .create(spec(false), SessionOptions::default(), |_| Box::new(Sink(
            output.clone()
        )))
        .is_err());
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        output.lock().unwrap().exits,
        0,
        "shutdown must not mark saved Running tabs Exited"
    );
}
