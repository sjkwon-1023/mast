//! Antigravity CLI(agy) 훅. `running` 또는 `idle` 인자로 불리며, mast 탭 안에서만 상태 OSC를 낸다.
//! agy 는 stdout 을 JSON 으로 읽으므로 OSC 는 콘솔(CONOUT$)에 쓰고 stdout 에는 `{}` 한 줄만 남긴다.

use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{self, IsTerminal, Write};
use std::process::ExitCode;

const USAGE: &str = "usage: mast-agy-hook running|idle";

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
    if let Some(osc) = notification_for(event, mast_tab.as_deref(), other_agent) {
        write_console(osc);
    }

    // 콘솔 stdin 은 사용자 입력을 기다리게 되므로 읽지 않는다. 파이프는 EOF 까지 비워서 agy 의 쓰기가 막히지 않게 한다.
    let stdin = io::stdin();
    if should_drain_stdin(stdin.is_terminal()) {
        let _ = io::copy(&mut stdin.lock(), &mut io::sink());
    }
    ExitCode::SUCCESS
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
}
