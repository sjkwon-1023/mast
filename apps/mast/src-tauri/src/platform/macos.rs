//! Apple Silicon 호스트 통합. 별도 제품·터미널 엔진·데몬은 없다.
use std::ffi::CStr;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use mast_core::command::ShellSpawnReq;
use mast_core::model::TabId;
use mast_core::session::SpawnSpec;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::sel;
use tauri::{AppHandle, Manager};

use crate::winlog;

struct ShellConfig {
    home: PathBuf,
    shell: String,
    config_path: PathBuf,
}
static CONFIG: OnceLock<ShellConfig> = OnceLock::new();

macro_rules! asset {
    ($dest:literal, $source:literal) => {
        (
            $dest,
            include_str!(concat!("../../../../../scripts/", $source)),
        )
    };
}
const ASSETS: &[(&str, &str)] = &[
    asset!("shell/launch.sh", "macos/launch.sh"),
    asset!("shell/integration.sh", "macos/integration.sh"),
    asset!("shell/bashrc", "macos/bashrc"),
    asset!("shell/zsh-integration.zsh", "macos/zsh-integration.zsh"),
    asset!("shell/zsh/.zshenv", "macos/zshenv"),
    asset!("shell/zsh/.zprofile", "macos/zprofile"),
    asset!("shell/zsh/.zshrc", "macos/zshrc"),
    asset!("shell/zsh/.zlogin", "macos/zlogin"),
    asset!("bin/mast.py", "macos/mast.py"),
    asset!("bin/mast-notify.py", "macos/notify.py"),
    asset!("bin/mast-setup.py", "macos/setup.py"),
    asset!("bin/mast-agent-hook.py", "wsl/mast-agent-hook.py"),
    asset!("bin/mast-hooks-merge.py", "wsl/mast-hooks-merge.py"),
    asset!("bin/mast-config.py", "wsl/mast-config.py"),
    asset!("bin/mast-claude-hook.sh", "wsl/mast-claude-hook.sh"),
    asset!("bin/mast-codex-hook.sh", "wsl/mast-codex-hook.sh"),
    asset!("bin/mast-opencode-plugin.js", "wsl/mast-opencode-plugin.js"),
    asset!("bin/mast-skill.md", "wsl/skills/mast/SKILL.md"),
    asset!("bin/mast-send-skill.md", "wsl/skills/mast-send/SKILL.md"),
];

fn install(path: &Path, text: &str) -> anyhow::Result<()> {
    let text = text.replace("\r\n", "\n");
    if std::fs::read(path).ok().as_deref() == Some(text.as_bytes()) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("asset has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    std::io::Write::write_all(&mut temporary, text.as_bytes())?;
    temporary
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))?;
    temporary.persist(path)?;
    Ok(())
}

/// 손자 프로세스가 열어 둔 채 남을 수 있는 파이프 없이, 크기가 제한된 진단 출력을 받는다.
/// 시간이 초과되면 명령의 전용 프로세스 그룹을 죽이고 직계 자식을 reap 한다.
pub(crate) fn run(mut command: Command, seconds: u64) -> Result<String, String> {
    let mut output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut child = command
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(output.try_clone().map_err(|e| e.to_string())?)
        .stderr(output.try_clone().map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| format!("cannot start native helper: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            None => {
                // SAFETY: process_group(0) 이 아직 reap 되지 않은 이 자식의 그룹을 만들었다.
                unsafe {
                    libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
                }
                let _ = child.wait();
                return Err(format!("native helper timed out after {seconds}s"));
            }
        }
    };
    output.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    output
        .take(64 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if status.success() {
        Ok(text)
    } else {
        Err(format!("native helper exited {status}: {}", text.trim()))
    }
}

fn login_shell() -> Option<String> {
    let mut storage = vec![0u8; 16 * 1024];
    let mut pwd = std::mem::MaybeUninit::<libc::passwd>::zeroed();
    let mut result = std::ptr::null_mut();
    // getpwuid_r 는 멀티스레드 앱에서 libc 의 프로세스 전역 passwd 저장소를 피한다.
    let code = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            pwd.as_mut_ptr(),
            storage.as_mut_ptr().cast(),
            storage.len(),
            &mut result,
        )
    };
    if code != 0 || result.is_null() {
        return None;
    }
    let pwd = unsafe { pwd.assume_init() };
    if pwd.pw_shell.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(pwd.pw_shell) }
        .to_str()
        .ok()
        .map(str::to_owned)
}

pub(crate) fn validate_shell(shell: &str) -> Result<(), String> {
    let path = Path::new(shell);
    if !path.is_absolute()
        || shell.contains('\0')
        || !matches!(
            path.file_name().and_then(|n| n.to_str()),
            Some("zsh" | "bash")
        )
    {
        return Err("shell must be an absolute path to zsh or bash".into());
    }
    // metadata 는 symlink 를 따라가므로 판정 대상은 링크가 가리키는 실제 파일이다.
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("cannot open shell {shell}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("shell is not a regular file: {shell}"));
    }
    // 모드 비트(누군가에게 실행 권한이 있는지)가 아니라 **지금 이 사용자가** 실행할 수
    // 있는지를 커널에 묻는다 — mast-config.py 의 `os.access(X_OK)` 와 같은 규칙이다.
    // NUL 은 위에서 이미 걸렀으므로 CString 변환은 실패하지 않는다.
    let c_path = std::ffi::CString::new(shell).map_err(|e| e.to_string())?;
    // SAFETY: c_path 는 이 호출 동안 살아 있는 NUL 종료 문자열이다.
    if unsafe { libc::access(c_path.as_ptr(), libc::X_OK) } != 0 {
        return Err(format!(
            "shell is not executable by the current user: {shell}: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// 셸 경로를 어디서 골랐는지 — 시작 실패 대화상자가 출처별로 다른 복구 방법을
/// 안내하는 데 쓴다. 순서는 [`initialize`] 의 선택 순서와 같다.
#[derive(Clone, Copy)]
enum ShellSource {
    Settings,
    MastShellEnv,
    LoginShell,
    ShellEnv,
    Fallback,
}

/// 셸 검증 실패를 사용자에게 보여 줄 문구로 바꾼다. 이 문구를 보는 시점에는 Mast
/// 탭이 없으므로 `mast config` CLI 가 아니라 파일·환경 변수를 고치는 방법을 적는다.
fn shell_error_message(
    source: ShellSource,
    shell: &str,
    error: &str,
    config_path: &Path,
) -> String {
    let config = config_path.display();
    match source {
        ShellSource::Settings => format!(
            "The shell set in {config} cannot be used: {error}\n\n\
             Fix or remove the \"shell\" entry in that file. Supported shells are zsh and \
             bash, given as an absolute path such as /bin/zsh."
        ),
        ShellSource::MastShellEnv => format!(
            "The shell named by the MAST_SHELL environment variable cannot be used: \
             {error}\n\nSet MAST_SHELL to an absolute path to zsh or bash (for example \
             /bin/zsh), or unset it."
        ),
        ShellSource::LoginShell | ShellSource::ShellEnv | ShellSource::Fallback => {
            let origin = match source {
                ShellSource::LoginShell => "Your account's login shell",
                ShellSource::ShellEnv => "The shell named by the SHELL environment variable",
                _ => "The default shell",
            };
            format!(
                "{origin} ({shell}) cannot be used: {error}\n\n\
                 Mast runs zsh or bash. Choose one by adding \"shell\": \"/bin/zsh\" to \
                 {config} (create the file if it does not exist)."
            )
        }
    }
}

/// 시작을 막는 오류를 네이티브 대화상자로 보여 주고, setup 에 돌려줄 Err 를 만든다.
///
/// parent 없이 띄운다 — rfd 는 메인 스레드에서 `CFUserNotificationDisplayAlert` 로
/// 즉시 띄우므로 NSApp run loop 가 아직 돌지 않는 setup 시점에도 보인다. 대화상자를
/// 닫으면 호출자가 Err 를 올리고, setup 의 Err 는 tauri 2.11 에서 `RunEvent::Ready` 안의
/// `panic!("Failed to setup app: …")` 로 프로세스를 끝낸다. 기본값으로 대신 진행하는
/// 경로는 두지 않는다.
fn startup_failure(message: String) -> anyhow::Error {
    winlog!("startup failed: {message}");
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("Mast cannot start")
        .set_description(message.as_str())
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    anyhow::Error::msg(message)
}

/// 첫 탭을 스폰하기 전에 끝나야 한다. 자산 설치는 로컬에서 원자적으로 하며,
/// .zshrc/.bashrc/.profile 을 수정하거나 그 내용을 실행하지 않는다.
pub(crate) fn initialize(app: &AppHandle) -> anyhow::Result<()> {
    install_menu(app)?;
    install_terminate_guard(app)?;
    let home = app.path().home_dir()?;
    let config_path = app.path().app_config_dir()?.join("settings.json");
    // 읽기·파싱 실패를 기본값으로 덮지 않는다 — 사용자가 쓴 shell 이 무시된 채 다른
    // 셸로 뜨면 무엇이 잘못됐는지 알 길이 없다. 오류 문구에는 이미 절대경로가 들어 있다.
    let settings = crate::commands::read_ui_settings(app).map_err(|error| {
        startup_failure(format!(
            "Mast could not read its settings file: {error}\n\n\
             Fix the file, or move it aside to use the default settings: {}",
            config_path.display()
        ))
    })?;
    let (shell, source) = match (settings.shell, std::env::var("MAST_SHELL").ok()) {
        (Some(shell), _) => (shell, ShellSource::Settings),
        (None, Some(shell)) => (shell, ShellSource::MastShellEnv),
        (None, None) => match login_shell() {
            Some(shell) => (shell, ShellSource::LoginShell),
            None => match std::env::var("SHELL").ok() {
                Some(shell) => (shell, ShellSource::ShellEnv),
                None => ("/bin/zsh".into(), ShellSource::Fallback),
            },
        },
    };
    validate_shell(&shell).map_err(|error| {
        startup_failure(shell_error_message(source, &shell, &error, &config_path))
    })?;
    let mast = home.join(".mast");
    for &(destination, content) in ASSETS {
        install(&mast.join(destination), content)?;
    }
    install(
        &mast.join("bin/mast"),
        r#"#!/bin/bash
py=
IFS= read -r py < "$HOME/.mast/bin/mast-python" || true
if [[ -z $py || ! -x $py ]]; then
  printf 'mast: Python 3.11+ is required; see ~/.mast/setup.log\n' >&2
  exit 1
fi
exec "$py" -I "$HOME/.mast/bin/mast.py" "$@"
"#,
    )?;
    for (name, args) in [("mast-notify.sh", ""), ("mast-codex-notify.sh", "codex ")] {
        install(
            &mast.join("bin").join(name),
            &format!(
                r#"#!/bin/bash
[[ ${{MAST:-}} == 1 ]] || exit 0
py=
IFS= read -r py < "$HOME/.mast/bin/mast-python" 2>/dev/null || true
if [[ -n $py && -x $py ]]; then
  "$py" -I "$HOME/.mast/bin/mast-notify.py" {args}"$@" >/dev/null 2>&1
fi
exit 0
"#
            ),
        )?;
    }
    CONFIG
        .set(ShellConfig {
            home,
            shell,
            config_path,
        })
        .map_err(|_| anyhow::anyhow!("native shell configuration initialized twice"))?;
    provision();
    Ok(())
}

/// 에이전트 연동 준비(python 탐색 + `mast-setup.py`)를 시작하고 **즉시 반환한다**.
///
/// 진입점이 여럿이다(`initialize` 끝, `provision::ensure_provisioned` 의 setup 끝·
/// 워크스페이스 생성). 어느 쪽에서 불려도 호출 스레드(setup 의 메인 스레드, Dispatcher
/// 경로)가 python 실행을 기다리지 않도록 once 가드만 호출 스레드에서 확정하고 실제
/// 작업은 `mast-native-provision` 스레드에서 한다. setup helper 는 자기 프로세스
/// 그룹에서 돌고 내부 외부 명령이 모두 timeout 으로 묶여 있어 앱이 먼저 끝나도 스스로
/// 끝난다 — 그 회차의 `setup.log` 는 남지 않을 수 있고, 다음 실행이 marker 기준으로
/// 다시 시도한다.
pub(crate) fn provision() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    let Some(config) = CONFIG.get() else {
        return;
    };
    let spawned = std::thread::Builder::new()
        .name("mast-native-provision".into())
        .spawn(move || provision_now(config));
    if let Err(error) = spawned {
        // 스레드를 못 띄우면 이번 실행은 준비를 건너뛴다. 조용히 넘기지 않고 로그와
        // `mast` 래퍼가 가리키는 setup.log 양쪽에 남긴다.
        let text = format!("native agent setup did not start: cannot spawn its thread: {error}");
        winlog!("{text}");
        if let Err(error) = install(&config.home.join(".mast/setup.log"), &text) {
            winlog!("native agent setup: cannot write setup.log: {error}");
        }
    }
}

fn provision_now(config: &ShellConfig) {
    let bin = config.home.join(".mast/bin");
    let candidates = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ];
    let mut python = None;
    for candidate in candidates {
        if !Path::new(candidate).is_file() {
            continue;
        }
        let mut command = Command::new(candidate);
        command.args([
            "-I",
            "-c",
            "import sys; sys.exit(sys.version_info < (3, 11))",
        ]);
        if run(command, 3).is_ok() {
            python = Some(candidate);
            break;
        }
    }
    let outcome = match python {
        Some(python) => {
            if let Err(error) = install(&bin.join("mast-python"), &format!("{python}\n")) {
                Err(error.to_string())
            } else {
                let mut command = Command::new(python);
                command.arg("-I").arg(bin.join("mast-setup.py")).env(
                    "PATH",
                    format!(
                        "{}:/opt/homebrew/bin:/usr/local/bin:{}",
                        bin.display(),
                        std::env::var("PATH").unwrap_or_default()
                    ),
                );
                run(command, 30)
            }
        }
        None => {
            let _ = std::fs::remove_file(bin.join("mast-python"));
            Err("Python 3.11+ not found. Install it (for example with Homebrew), then restart Mast to enable the CLI, notifications, and agent resume hints.".into())
        }
    };
    let text = match outcome {
        Ok(text) => text,
        Err(error) => {
            eprintln!("[mast] native agent setup: {error}");
            error
        }
    };
    // 실행마다 크기가 제한된 진단 하나만 남긴다 — setup 로그에 한없이 덧붙이지 않는다.
    let _ = install(&config.home.join(".mast/setup.log"), &text);
}

pub(crate) fn spawn_spec(req: &ShellSpawnReq) -> SpawnSpec {
    let config = CONFIG
        .get()
        .expect("native shell assets installed before spawning tabs");
    SpawnSpec {
        program: "/bin/bash".into(),
        args: vec![
            config
                .home
                .join(".mast/shell/launch.sh")
                .to_string_lossy()
                .into_owned(),
            config.shell.clone(),
            req.history_tab.map(|n| n.to_string()).unwrap_or_default(),
            req.cwd.clone().unwrap_or_default(),
            config.config_path.to_string_lossy().into_owned(),
        ],
        cwd: None,
        cols: req.cols,
        rows: req.rows,
    }
}

pub(crate) fn release_tab_files(tabs: &[TabId]) {
    let Some(config) = CONFIG.get() else {
        return;
    };
    let root = config.home.join(".mast");
    let ids: Vec<u64> = tabs.iter().map(|t| t.0).collect();
    let _ = std::thread::Builder::new()
        .name("mast-release-native-tabs".into())
        .spawn(move || {
            for dir in ["history", "resume", "agent-hooks"] {
                let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let Some(name) = name.to_str() else {
                        continue;
                    };
                    let owned = ids.iter().any(|id| {
                        [
                            format!("tab-{id}"),
                            format!("bash-tab-{id}"),
                            format!("zsh-tab-{id}"),
                            format!("tab-{id}.json"),
                            format!("tab-{id}.lock"),
                            format!("tab-{id}.diag"),
                        ]
                        .iter()
                        .any(|base| name == base || name.starts_with(&format!("{base}.tmp.")))
                    });
                    if owned {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_selection_rejects_commands_and_relative_paths() {
        for value in ["zsh", "/bin/zsh -c id", "/bin/sh", "/bin/zsh\0"] {
            assert!(validate_shell(value).is_err());
        }
        assert!(validate_shell("/bin/zsh").is_ok());
        assert!(validate_shell("/bin/bash").is_ok());
    }
    #[test]
    fn shell_selection_requires_a_file_this_user_can_execute() {
        let dir = tempfile::tempdir().unwrap();
        let path = |name: &str| dir.path().join(name).to_str().unwrap().to_owned();
        let write = |name: &str, mode: u32| {
            std::fs::write(dir.path().join(name), "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(dir.path().join(name), std::fs::Permissions::from_mode(mode))
                .unwrap();
        };
        std::fs::create_dir(dir.path().join("plain")).unwrap();
        write("plain/zsh", 0o644);
        std::fs::create_dir(dir.path().join("exec")).unwrap();
        write("exec/zsh", 0o755);
        std::fs::create_dir(dir.path().join("link")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("exec/zsh"), dir.path().join("link/bash"))
            .unwrap();
        std::fs::create_dir(dir.path().join("noexec")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("plain/zsh"), dir.path().join("noexec/bash"))
            .unwrap();

        assert!(validate_shell(&path("missing/zsh")).is_err());
        assert!(validate_shell(&path("plain/zsh")).is_err());
        assert!(validate_shell(&path("noexec/bash")).is_err());
        assert!(validate_shell(&path("exec/zsh")).is_ok());
        assert!(validate_shell(&path("link/bash")).is_ok());
    }
    #[test]
    fn shipped_assets_have_no_crlf_or_unexpanded_placeholder() {
        for (name, content) in ASSETS {
            assert!(!content.is_empty(), "{name}");
            assert!(!content.contains("@SETUP_VERSION@"), "{name}");
        }
    }
}

/// Tauri 기본 Cmd+W "Close Window" 항목을 설치하지 않는다 — Cmd+W 는 Mast 의
/// 활성 탭 몫이다. 종료는 기존 Markdown close guard 를 거친다.
pub(crate) fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let quit = MenuItem::with_id(app, "mast-quit", "Quit Mast", true, Some("Cmd+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "Mast",
        true,
        &[
            &P::about(app, None, None)?,
            &P::separator(app)?,
            &P::services(app, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&P::minimize(app, None)?, &P::maximize(app, None)?],
    )?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &edit, &window])?)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "mast-quit" {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
    });
    Ok(())
}

/// 프론트엔드가 알려 준 Markdown draft 상태. 프론트가 부팅 seed 를 보내기 전·WebView
/// 리로드 중·통지가 실패한 뒤에는 `Unknown` 이고, 종료 판정은 이를 dirty 와 같이
/// 안전한 쪽(확인 경로)으로 다룬다.
#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DraftState {
    Unknown = 0,
    Clean = 1,
    Dirty = 2,
}

static DRAFT_STATE: AtomicU8 = AtomicU8::new(DraftState::Unknown as u8);
static TERMINATE_APP: OnceLock<AppHandle> = OnceLock::new();

pub(crate) fn set_draft_state(state: DraftState) {
    DRAFT_STATE.store(state as u8, Ordering::SeqCst);
}

/// `NSApplicationTerminateReply` 값 (AppKit: Cancel = 0, Now = 1).
const NS_TERMINATE_CANCEL: usize = 0;
const NS_TERMINATE_NOW: usize = 1;

/// Dock Quit·로그아웃·AppleScript quit 이 부르는 `[NSApp terminate:]` 의 판정.
///
/// tao 의 델리게이트에는 이 메서드가 없어 그런 종료가 Markdown 확인 없이 바로
/// `applicationWillTerminate:` 로 갔다. draft 가 확실히 없을 때(`Clean`)만 곧바로
/// 종료를 허락하고, 그 밖에는 종료(로그아웃·재시동 포함)를 취소한 뒤 Cmd+Q 메뉴와
/// 같은 경로 — main 창 close → 프론트 `onCloseRequested` 확인 — 를 태운다. 확인 뒤의
/// 종료는 `terminate:` 를 거치지 않으므로(창 Destroyed → `exit(0)`) 여기로 되돌아와
/// 다시 취소되는 일은 없다. `window.close()` 는 이벤트 루프에 메시지만 보내는 비동기
/// 호출이라 이 콜백 안에서 불러도 된다.
///
/// FFI 경계라 panic 이 나면 unwind 하지 않고 abort 한다(`extern "C"`).
extern "C" fn application_should_terminate(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> usize {
    if DRAFT_STATE.load(Ordering::SeqCst) == DraftState::Clean as u8 {
        return NS_TERMINATE_NOW;
    }
    let Some(window) = TERMINATE_APP
        .get()
        .and_then(|app| app.get_webview_window("main"))
    else {
        // main 창이 없으면 지킬 draft 도, 확인을 띄울 곳도 없다. 여기서 취소하면 Dock
        // Quit·로그아웃으로는 앱을 영영 끝낼 수 없으므로 종료를 허락한다.
        winlog!("terminate: no main window to confirm unsaved Markdown; quitting");
        return NS_TERMINATE_NOW;
    };
    if let Err(error) = window.close() {
        winlog!("terminate: cannot ask the main window to confirm quitting: {error}");
    }
    NS_TERMINATE_CANCEL
}

/// tao 의 앱 델리게이트 클래스(`TaoAppDelegateParent`)에 `applicationShouldTerminate:`
/// 를 런타임에 추가한다. 클래스가 없거나(tao 가 이름을 바꿈), 클래스가 이미 **자기
/// 메서드로** 구현하고 있거나(tao 가 같은 selector 를 구현하기 시작함 — 덮으면 tao 의
/// 동작을 가린다), 추가가 실패하면 대화상자를 띄우고 시작을 멈춘다. guard 없이 조용히
/// 진행하지 않는다.
fn install_terminate_guard(app: &AppHandle) -> anyhow::Result<()> {
    const CLASS: &CStr = c"TaoAppDelegateParent";
    let selector = sel!(applicationShouldTerminate:);
    let Some(class) = AnyClass::get(CLASS) else {
        return Err(startup_failure(
            "Mast could not install its quit confirmation: the application delegate class \
             TaoAppDelegateParent was not found."
                .into(),
        ));
    };
    // 판정은 클래스 **자신의** 메서드 목록으로 한다 — superclass 의 구현은 추가가 덮어
    // 쓰는 것이 정상이다.
    if class.instance_methods().iter().any(|method| method.name() == selector) {
        return Err(startup_failure(
            "Mast could not install its quit confirmation: TaoAppDelegateParent already \
             implements applicationShouldTerminate:."
                .into(),
        ));
    }
    // 핸들러가 main 창을 찾으려면 AppHandle 이 필요하다. 메서드보다 먼저 둔다.
    if TERMINATE_APP.set(app.clone()).is_err() {
        return Err(anyhow::anyhow!("quit confirmation installed twice"));
    }
    let handler: extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize =
        application_should_terminate;
    // SAFETY: 타입 인코딩 "Q@:@" 는 핸들러 시그니처(NSUInteger 반환, self, _cmd, sender)와
    // 일치하고, 호출 규약이 같은 함수 포인터끼리의 변환이다. class 는 등록이 끝난 실제
    // 클래스이며 class_addMethod 는 런타임이 동기화한다.
    let added = unsafe {
        objc2::ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            selector,
            std::mem::transmute::<
                extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
                objc2::runtime::Imp,
            >(handler),
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        return Err(startup_failure(
            "Mast could not install its quit confirmation: adding \
             applicationShouldTerminate: to TaoAppDelegateParent failed."
                .into(),
        ));
    }
    Ok(())
}
