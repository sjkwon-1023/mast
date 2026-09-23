//! Apple Silicon host integration. No separate product, terminal engine or daemon.
use std::ffi::CStr;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use mast_core::command::ShellSpawnReq;
use mast_core::model::TabId;
use mast_core::session::SpawnSpec;
use tauri::{AppHandle, Manager};

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

/// Capture bounded diagnostic output without a pipe that a grandchild could keep
/// open. A timeout kills the command's private group and reaps the direct child.
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
                // SAFETY: process_group(0) created this unreaped child's group.
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
    // getpwuid_r avoids libc's process-global passwd storage in a multithreaded app.
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
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("cannot open shell {shell}: {e}"))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(format!("shell is not an executable file: {shell}"));
    }
    Ok(())
}

/// Must finish before the first tab is spawned. Asset installation is local,
/// atomic, and does not edit .zshrc/.bashrc/.profile or execute their contents.
pub(crate) fn initialize(app: &AppHandle) -> anyhow::Result<()> {
    install_menu(app)?;
    let home = app.path().home_dir()?;
    let config_path = app.path().app_config_dir()?.join("settings.json");
    let settings = crate::commands::read_ui_settings(app).unwrap_or_else(|error| {
        eprintln!("[mast] UI settings: {error}; using the account login shell");
        crate::commands::UiSettings::default()
    });
    let explicit = settings.shell.or_else(|| std::env::var("MAST_SHELL").ok());
    let shell = explicit.unwrap_or_else(|| {
        login_shell()
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/zsh".into())
    });
    validate_shell(&shell).map_err(anyhow::Error::msg)?;
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

pub(crate) fn provision() {
    static DONE: OnceLock<()> = OnceLock::new();
    if DONE.set(()).is_err() {
        return;
    }
    let Some(config) = CONFIG.get() else {
        return;
    };
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
    // One bounded diagnostic per launch; do not append an unbounded setup log.
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
    fn shipped_assets_have_no_crlf_or_unexpanded_placeholder() {
        for (name, content) in ASSETS {
            assert!(!content.is_empty(), "{name}");
            assert!(!content.contains("@SETUP_VERSION@"), "{name}");
        }
    }
}

/// Do not install Tauri's default Cmd+W "Close Window" item: Cmd+W belongs to
/// Mast's active tab. Quit goes through the existing Markdown close guard.
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
