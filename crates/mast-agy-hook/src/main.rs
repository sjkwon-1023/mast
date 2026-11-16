//! Antigravity CLI(agy) 훅. `running` 또는 `idle` 인자로 불리며, mast 탭 안에서만 상태 OSC를 낸다.
//! agy 는 stdout 을 JSON 으로 읽으므로 OSC 는 콘솔(CONOUT$)에 쓰고 stdout 에는 `{}` 한 줄만 남긴다.
//! 같은 조건에서 `%USERPROFILE%\.mast\resume\tab-<id>` 에 resume 힌트도 쓴다. 읽는 쪽은
//! `scripts/win/powershell-integration.ps1` 이다.

use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{self, ExitCode};
use std::time::{SystemTime, UNIX_EPOCH};

const USAGE: &str = "usage: mast-agy-hook running|idle";

/// 훅 입력 가운데 보관하는 앞부분. 나머지는 버리면서 EOF 까지 읽는다. WSL 훅과 같은 1 MiB 다.
const PAYLOAD_LIMIT: u64 = 1024 * 1024;

// idle 본문은 WSL 훅과 달리 agy 응답을 싣지 않고 `done` 으로 고정한다. Windows 쪽은 본문 정리 경로를 두지 않는다.
const RUNNING_OSC: &[u8] = b"\x1b]777;notify;mast:running;\x07";
const IDLE_OSC: &[u8] = b"\x1b]777;notify;mast:idle;done\x07";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Event {
    Running,
    Idle,
}

fn main() -> ExitCode {
    if !cfg!(windows) {
        eprintln!("mast-agy-hook runs only on Windows");
        return ExitCode::FAILURE;
    }
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let Some(event) = parse_event(&args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };

    // agy 가 stdout 을 먼저 닫아도 OSC 까지 건너뛰지 않는다. 쓰기 실패는 훅의 성공 여부에 영향을 주지 않는다.
    let mut stdout = io::stdout();
    let _ = stdout.write_all(b"{}\n");
    let _ = stdout.flush();

    // OSC 는 stdin 을 비우기 전에 쓴다. 비우기는 파이프가 EOF 를 줄 때까지 기다리므로, 그 사이에도 상태가 먼저 도착하게 한다.
    let mast_tab = env::var_os("MAST_TAB");
    let other_agent = inside_other_agent(|name| env::var_os(name).is_some());
    let osc = notification_for(event, mast_tab.as_deref(), other_agent);
    if let Some(osc) = osc {
        write_console(osc);
    }

    // 콘솔 stdin 은 사용자 입력을 기다리게 되므로 읽지 않는다. 파이프는 EOF 까지 비워서 agy 의 쓰기가 막히지 않게 한다.
    let stdin = io::stdin();
    if !should_drain_stdin(stdin.is_terminal()) {
        return ExitCode::SUCCESS;
    }
    let payload = read_payload(&mut stdin.lock());

    // 상태 OSC 를 낸 호출만 힌트를 쓴다. mast 밖의 agy 나 다른 에이전트가 띄운 agy 는 탭의 힌트를 바꾸지 않는다.
    if osc.is_some() {
        let tab = mast_tab.as_deref().and_then(OsStr::to_str).unwrap_or_default();
        if let (Some(conversation), Some(dir)) = (resume_conversation(&payload), resume_dir()) {
            let generation = env::var("MAST_PROMPT_GEN").ok();
            let text = hint_text(&conversation, unix_seconds(), generation.as_deref());
            let _ = write_hint(&dir, tab, &text);
        }
    }
    ExitCode::SUCCESS
}

fn read_payload(reader: &mut impl Read) -> Vec<u8> {
    let mut kept = Vec::new();
    let _ = reader.by_ref().take(PAYLOAD_LIMIT).read_to_end(&mut kept);
    let _ = io::copy(reader, &mut io::sink());
    kept
}

/// 힌트로 남길 루트 대화의 id. 서브에이전트 대화도 같은 훅을 부르고 `parentConversationId` 를 채우지 않는다
/// (agy 1.5.9 에서 확인). 그 대화의 `lastUserInput` 은 빈 문자열이라 이것이 루트 대화와의 유일한 차이다.
/// 그래서 사용자 입력이 있는 대화만 받는다. 필드가 없는 agy(1.4.7 이전)는 힌트를 쓰지 않는다.
fn resume_conversation(payload: &[u8]) -> Option<String> {
    let input: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let user_input = input.get("lastUserInput")?.as_str()?;
    let conversation = input.get("conversationId")?.as_str()?;
    (!user_input.is_empty() && is_plain_token(conversation, usize::MAX)).then(|| conversation.to_owned())
}

/// `[A-Za-z0-9_-]` 로만 된 비지 않은 문자열. 읽는 쪽이 같은 규칙으로 다시 검사하고 고정 인자로만 실행한다.
fn is_plain_token(value: &str, max_len: usize) -> bool {
    (1..=max_len).contains(&value.len())
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 1행 명령, 2행 기록 시각(epoch 초), 3행 프롬프트 세대. 세대는 형식이 맞을 때만 쓴다. WSL 힌트와 같은 형식이다.
fn hint_text(conversation: &str, seconds: u64, generation: Option<&str>) -> String {
    let mut text = format!("agy --conversation {conversation}\n{seconds}\n");
    if let Some(generation) = generation.filter(|gen| is_plain_token(gen, 128)) {
        text.push_str(generation);
        text.push('\n');
    }
    text
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn resume_dir() -> Option<PathBuf> {
    let profile = env::var_os("USERPROFILE").filter(|profile| !profile.is_empty())?;
    Some(Path::new(&profile).join(".mast").join("resume"))
}

/// 임시 파일에 쓴 뒤 이름을 바꿔 교체한다. 읽는 쪽은 옛 파일이나 새 파일 중 하나만 본다. 같은 탭에서
/// 두 훅이 동시에 돌아도 pid 접미사가 달라 임시 파일이 겹치지 않는다. 실패하면 임시 파일을 지운다.
fn write_hint(dir: &Path, tab: &str, text: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let target = dir.join(format!("tab-{tab}"));
    let temp = dir.join(format!("tab-{tab}.tmp.{}", process::id()));
    let result = fs::write(&temp, text).and_then(|()| fs::rename(&temp, &target));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// 인자는 정확히 하나여야 한다. 남는 인자를 무시하면 `running extra` 가 조용히 `running` 으로 읽힌다.
fn parse_event(args: &[OsString]) -> Option<Event> {
    let [arg] = args else {
        return None;
    };
    match arg.to_str()? {
        "running" => Some(Event::Running),
        "idle" => Some(Event::Idle),
        _ => None,
    }
}

// mast 탭 셸만 MAST_TAB 을 내보낸다. hooks.json 은 전역이라 mast 밖에서 도는 agy 도 이 훅을 부르므로,
// 십진수가 아니면 아무것도 내지 않는다. `char::is_numeric` 은 전각 숫자 같은 non-ASCII 숫자도 받으므로 쓰지 않는다.
fn is_mast_tab(value: Option<&OsStr>) -> bool {
    value
        .and_then(OsStr::to_str)
        .is_some_and(|tab| !tab.is_empty() && tab.bytes().all(|b| b.is_ascii_digit()))
}

// 같은 탭에서 Claude Code 나 Codex 가 띄운 agy 는 그 에이전트의 상태를 덮지 않도록 빠진다.
fn inside_other_agent(is_set: impl Fn(&str) -> bool) -> bool {
    is_set("CLAUDECODE") || is_set("CODEX_THREAD_ID")
}

fn notification_for(
    event: Event,
    mast_tab: Option<&OsStr>,
    other_agent: bool,
) -> Option<&'static [u8]> {
    if !is_mast_tab(mast_tab) || other_agent {
        return None;
    }
    Some(match event {
        Event::Running => RUNNING_OSC,
        Event::Idle => IDLE_OSC,
    })
}

fn should_drain_stdin(stdin_is_terminal: bool) -> bool {
    !stdin_is_terminal
}

#[cfg(windows)]
fn write_console(bytes: &[u8]) {
    console::write_virtual_terminal(bytes);
}

#[cfg(not(windows))]
fn write_console(_bytes: &[u8]) {}

#[cfg(windows)]
mod console {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, WriteFile, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, SetConsoleMode, CONSOLE_MODE, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
    };

    // CONOUT$ 는 탭 셸과 같은 콘솔 버퍼다. VT 처리를 켠 채로 두면 셸의 출력 해석이 바뀌므로 드롭 때 원래 모드로 되돌린다.
    struct ConsoleOutput {
        handle: HANDLE,
        original_mode: Option<CONSOLE_MODE>,
    }

    impl Drop for ConsoleOutput {
        fn drop(&mut self) {
            unsafe {
                if let Some(mode) = self.original_mode {
                    SetConsoleMode(self.handle, mode);
                }
                CloseHandle(self.handle);
            }
        }
    }

    pub fn write_virtual_terminal(bytes: &[u8]) {
        let name: Vec<u16> = "CONOUT$".encode_utf16().chain([0]).collect();
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return;
        }

        let mut mode: CONSOLE_MODE = 0;
        let original_mode = (unsafe { GetConsoleMode(handle, &mut mode) } != 0).then_some(mode);
        let output = ConsoleOutput {
            handle,
            original_mode,
        };
        if let Some(mode) = original_mode {
            unsafe { SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) };
        }

        let mut written = 0;
        unsafe {
            WriteFile(
                handle,
                bytes.as_ptr(),
                bytes.len() as u32,
                &mut written,
                null_mut(),
            )
        };
        drop(output);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(words: &[&str]) -> Vec<OsString> {
        words.iter().map(|word| OsString::from(*word)).collect()
    }

    #[test]
    fn parses_exactly_one_running_or_idle_argument() {
        assert_eq!(parse_event(&argv(&["running"])), Some(Event::Running));
        assert_eq!(parse_event(&argv(&["idle"])), Some(Event::Idle));
        let bad: [&[&str]; 8] = [
            &[],
            &[""],
            &["Running"],
            &["idle "],
            &["stop"],
            &["running", "extra"],
            &["idle", "idle"],
            &["running", "idle", "idle"],
        ];
        for words in bad {
            assert_eq!(parse_event(&argv(words)), None, "{words:?}");
        }
    }

    #[test]
    fn mast_tab_must_be_nonempty_ascii_digits() {
        for good in ["0", "7", "280"] {
            assert!(is_mast_tab(Some(OsStr::new(good))), "{good:?}");
        }
        for bad in ["", " 7", "7 ", "-1", "7a", "0x7", "\u{0663}", "\u{ff17}"] {
            assert!(!is_mast_tab(Some(OsStr::new(bad))), "{bad:?}");
        }
        assert!(!is_mast_tab(None));
    }

    #[test]
    fn claude_code_or_codex_marker_counts_as_other_agent() {
        assert!(inside_other_agent(|name| name == "CLAUDECODE"));
        assert!(inside_other_agent(|name| name == "CODEX_THREAD_ID"));
        assert!(!inside_other_agent(|name| name == "MAST_TAB"));
        assert!(!inside_other_agent(|_| false));
    }

    #[test]
    fn osc_bytes_match_the_notify_contract() {
        assert_eq!(RUNNING_OSC, b"\x1b]777;notify;mast:running;\x07".as_slice());
        assert_eq!(IDLE_OSC, b"\x1b]777;notify;mast:idle;done\x07".as_slice());
    }

    #[test]
    fn notification_requires_a_mast_tab_and_no_other_agent() {
        let tab = OsStr::new("7");
        assert_eq!(
            notification_for(Event::Running, Some(tab), false),
            Some(RUNNING_OSC)
        );
        assert_eq!(
            notification_for(Event::Idle, Some(tab), false),
            Some(IDLE_OSC)
        );
        assert_eq!(notification_for(Event::Running, None, false), None);
        assert_eq!(
            notification_for(Event::Idle, Some(OsStr::new("")), false),
            None
        );
        assert_eq!(notification_for(Event::Idle, Some(tab), true), None);
    }

    #[test]
    fn stdin_is_drained_only_when_it_is_not_a_console() {
        assert!(should_drain_stdin(false));
        assert!(!should_drain_stdin(true));
    }

    const ROOT: &str = "c18e460e-c48b-4597-b22c-3d777e0dbf67";

    #[test]
    fn a_root_conversation_with_user_input_is_resumable() {
        let payload = format!(
            r#"{{"conversationId":"{ROOT}","hookEventName":"PreInvocation","lastUserInput":"fix it"}}"#
        );
        assert_eq!(resume_conversation(payload.as_bytes()), Some(ROOT.to_owned()));
        // agy 는 줄바꿈으로 끝나는 JSON 을 보낼 수 있다.
        assert_eq!(resume_conversation(format!("{payload}\r\n").as_bytes()), Some(ROOT.to_owned()));
    }

    #[test]
    fn subagents_old_agy_and_malformed_ids_are_not_resumable() {
        let cases = [
            // 서브에이전트 대화 (agy 1.5.9 실측 모양)
            format!(r#"{{"conversationId":"{ROOT}","lastUserInput":""}}"#),
            // lastUserInput 이 없는 1.4.7 이전 agy
            format!(r#"{{"conversationId":"{ROOT}"}}"#),
            format!(r#"{{"conversationId":"{ROOT}","lastUserInput":3}}"#),
            r#"{"lastUserInput":"hi"}"#.to_owned(),
            r#"{"conversationId":"","lastUserInput":"hi"}"#.to_owned(),
            r#"{"conversationId":"a;calc","lastUserInput":"hi"}"#.to_owned(),
            r#"{"conversationId":"a b","lastUserInput":"hi"}"#.to_owned(),
            r#"{"conversationId":"a\nb","lastUserInput":"hi"}"#.to_owned(),
            r#"{"conversationId":"한글","lastUserInput":"hi"}"#.to_owned(),
            r#"{"conversationId":7,"lastUserInput":"hi"}"#.to_owned(),
            r#"["not","an","object"]"#.to_owned(),
            "not json".to_owned(),
            String::new(),
        ];
        for payload in cases {
            assert_eq!(resume_conversation(payload.as_bytes()), None, "{payload:?}");
        }
    }

    #[test]
    fn hint_has_the_command_the_time_and_only_a_well_formed_generation() {
        assert_eq!(
            hint_text(ROOT, 1_700_000_000, Some("4242-638700000000000000-3")),
            format!("agy --conversation {ROOT}\n1700000000\n4242-638700000000000000-3\n")
        );
        let two_lines = format!("agy --conversation {ROOT}\n5\n");
        assert_eq!(hint_text(ROOT, 5, None), two_lines);
        for bad in ["", "bad gen", "a;b", "가", &"g".repeat(129)] {
            assert_eq!(hint_text(ROOT, 5, Some(bad)), two_lines, "{bad:?}");
        }
        assert_eq!(hint_text(ROOT, 5, Some(&"g".repeat(128))), format!("{two_lines}{}\n", "g".repeat(128)));
    }

    #[test]
    fn writing_a_hint_replaces_the_previous_one_and_leaves_no_temporary_file() {
        let dir = env::temp_dir().join(format!("mast-agy-hook-test-{}", process::id()));
        let _ = fs::remove_dir_all(&dir);
        let resume = dir.join(".mast").join("resume");

        write_hint(&resume, "7", "first\n").unwrap();
        write_hint(&resume, "7", "second\n").unwrap();
        assert_eq!(fs::read_to_string(resume.join("tab-7")).unwrap(), "second\n");
        let names: Vec<_> = fs::read_dir(&resume)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [OsString::from("tab-7")]);

        // 디렉터리 자리에 파일이 있으면 실패를 돌려줄 뿐 패닉하지 않는다.
        let blocked = dir.join("blocked");
        fs::write(&blocked, "a file").unwrap();
        assert!(write_hint(&blocked, "7", "x\n").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn payload_keeps_the_first_mebibyte_and_drains_the_rest() {
        let size = PAYLOAD_LIMIT as usize + 4096;
        let mut reader = io::Cursor::new(vec![b'x'; size]);
        let kept = read_payload(&mut reader);
        assert_eq!(kept.len(), PAYLOAD_LIMIT as usize);
        assert_eq!(reader.position() as usize, size);
    }
}
