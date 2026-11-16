//! 빌드된 훅을 agy 처럼 실행해 resume 힌트 파일까지 확인한다. 훅은 Windows 에서만 동작하므로 이 테스트도
//! Windows 대상에서만 컴파일된다 (CI windows-gates 의 `cargo test -p mast-agy-hook`).
#![cfg(windows)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const ROOT: &str = "c18e460e-c48b-4597-b22c-3d777e0dbf67";

struct Profile(PathBuf);

impl Profile {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("mast-agy-hook-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn hint(&self, tab: &str) -> PathBuf {
        self.0.join(".mast").join("resume").join(format!("tab-{tab}"))
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run_hook(profile: &Path, event: &str, payload: &str, env: &[(&str, &str)]) -> String {
    let mut command = Command::new(env!("CARGO_BIN_EXE_mast-agy-hook"));
    command
        .arg(event)
        .env("USERPROFILE", profile)
        .env_remove("MAST_TAB")
        .env_remove("MAST_PROMPT_GEN")
        .env_remove("CLAUDECODE")
        .env_remove("CODEX_THREAD_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap()
}

fn root_payload() -> String {
    format!(r#"{{"conversationId":"{ROOT}","hookEventName":"Stop","lastUserInput":"fix it"}}"#)
}

#[test]
fn a_root_conversation_in_a_mast_tab_writes_the_hint() {
    let profile = Profile::new("root");
    for event in ["running", "idle"] {
        let stdout = run_hook(
            &profile.0,
            event,
            &root_payload(),
            &[("MAST_TAB", "7"), ("MAST_PROMPT_GEN", "4242-6387-3")],
        );
        assert_eq!(stdout, "{}\n");
        let hint = fs::read_to_string(profile.hint("7")).unwrap();
        let lines: Vec<&str> = hint.split('\n').collect();
        assert_eq!(lines.len(), 4, "{hint:?}");
        assert_eq!(lines[0], format!("agy --conversation {ROOT}"));
        assert!(!lines[1].is_empty() && lines[1].bytes().all(|b| b.is_ascii_digit()), "{hint:?}");
        assert_eq!(lines[2..], ["4242-6387-3", ""]);
    }
    let names: Vec<_> = fs::read_dir(profile.hint("7").parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, ["tab-7"]);
}

#[test]
fn subagents_and_hooks_outside_a_mast_tab_write_nothing() {
    let profile = Profile::new("none");
    let subagent = format!(r#"{{"conversationId":"{ROOT}","lastUserInput":""}}"#);
    let root = root_payload();
    let cases: [(&str, &[(&str, &str)]); 4] = [
        (&subagent, &[("MAST_TAB", "7")]),
        (&root, &[]),
        (&root, &[("MAST_TAB", "7"), ("CLAUDECODE", "1")]),
        (&root, &[("MAST_TAB", "7"), ("CODEX_THREAD_ID", "t")]),
    ];
    for (payload, env) in cases {
        assert_eq!(run_hook(&profile.0, "idle", payload, env), "{}\n");
    }
    assert!(!profile.0.join(".mast").exists());
}
