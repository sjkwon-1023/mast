//! 관리자 워크스페이스(preview) 글루 — 부팅 시 보장·제거, 홈 경로 탐지,
//! 하네스 감독 배선과 Tauri 명령·이벤트.
//!
//! # 이 모듈의 범위
//!
//! - `main.rs` 배선: 설정이 꺼져 있으면 복원된 관리자 워크스페이스를 걷어내고,
//!   켜져 있으면 이벤트 기록을 켜고 관리자 배포판을 WSL 진단 대상에 넣는다.
//! - `boot::BootWork::apply` 가 초기 생성 뒤 [`ensure_workspace`] 로 관리자
//!   워크스페이스 하나를 보장하고, [`start_supervisor`] 로 하네스 감독을 한 번만
//!   시작한다.
//! - 하네스 한 번 실행기는 [`harness`], 재시작·백오프·status·board 캐시는
//!   [`supervisor`] 가 소유한다. 이 모듈은 그 둘을 부팅·Tauri 표면에 연결한다.
//!
//! # 홈 탐지가 WSL 프로브인 이유
//!
//! 관리자 워크스페이스의 `root_path` 는 **WSL 안의 리눅스 절대 경로**여야 한다
//! (코어 `CreateManagerWorkspace` 의 `validate_linux_path`·`/mnt` 규칙). Windows
//! 앱 프로세스의 홈(`%USERPROFILE%`)은 WSL 홈과 같다는 보장이 없으므로, `wsl.exe`
//! 안에서 `$HOME` 을 물어보는 것이 유일하게 정확한 방법이다. macOS 에서는 네이티브
//! 홈을 그대로 쓴다.
//!
//! 탐지·생성 실패는 로그 한 줄과 글루 status `failed`(이유 요약)로 남기고 부팅을
//! 계속한다 — 사용자에게 보이는 표시는 이 모듈과 [`supervisor`] 가 맡는다.

use std::sync::{Arc, Mutex};
#[cfg(windows)]
use std::time::Duration;

use mast_core::command::{Command, CommandError, Dispatcher};
use mast_core::manager::{AppToHarness, HarnessSettings, HARNESS_PROTOCOL};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::ResolvedManagerSettings;
use crate::{state, winlog};

mod harness;
mod supervisor;

/// 관리자 보드 payload 이벤트 — 프론트 `onManagerBoard` 와 짝이다.
const MANAGER_BOARD_EVENT: &str = "manager-board";

/// 하네스 notify 이벤트 — 하네스가 보낸 notify 본문을 그대로 싣는다.
const MANAGER_NOTIFY_EVENT: &str = "manager-notify";

/// 홈 탐지 출력의 바이트 상한. root_path 자체도 이 상한 안에서만 만든다 —
/// 코어의 `validate_linux_path` 가 길이를 보지 않으므로 여기서 막는다.
const HOME_MAX_BYTES: usize = 4096;

/// `HOME` 출력 검증 — 통과한 문자열만 root_path 의 재료가 된다. 개행·NUL 은
/// root_path 를 오염시키고(코어도 NUL 을 거부한다), 상대 경로는 프로세스 cwd 에
/// 따라 다른 곳에 워크스페이스를 만들며, 비 UTF-8 은 Rust 문자열이 될 수 없다.
fn parse_home_output(bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("the home probe returned no output".to_owned());
    }
    if bytes.len() > HOME_MAX_BYTES {
        return Err(format!(
            "the home probe output is {} bytes (limit {HOME_MAX_BYTES})",
            bytes.len()
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "the home probe output is not UTF-8".to_owned())?;
    if text.contains(['\n', '\r', '\0']) {
        return Err(format!("the home probe output must not contain newline or NUL: {text:?}"));
    }
    if !text.starts_with('/') {
        return Err(format!("the home probe output must be an absolute Linux path: {text:?}"));
    }
    Ok(text.to_owned())
}

/// 탐지한 홈 → 관리자 루트. 후행 `/` 를 접어 `//` 를 만들지 않는다 (`/` 홈 포함).
fn manager_root(home: &str) -> String {
    format!("{}/.mast/manager", home.trim_end_matches('/'))
}

/// 설정의 preview 스위치 — 객체가 없으면 꺼짐, 있으면 `enabled` 다.
/// (`enabled` 는 객체가 있으면 필수라 serde 가 이미 보장한다 — `commands.rs` 계약.)
pub(crate) fn enabled(settings: Option<&ResolvedManagerSettings>) -> bool {
    settings.is_some_and(|settings| settings.enabled)
}

/// 관리자 실행기의 관리 상태 — 설정이 켜진 부팅에서만 `app.manage` 된다.
///
/// 여기 있는 이유: [`crate::state::publish_state`] 가 상태를 발행할 때마다
/// [`wake`] 가 이 상태를 찾아 writer 를 깨운다 — 실행기가 없으면 no-op 이라
/// preview 가 꺼진 앱의 유휴 비용은 0 이다. status·board 캐시와 감독 핸들은
/// [`supervisor::ManagerShared`] 가 소유한다.
pub(crate) struct ManagerRuntime {
    shared: Arc<supervisor::ManagerShared>,
}

impl ManagerRuntime {
    pub(crate) fn new(settings: ResolvedManagerSettings) -> Self {
        Self {
            shared: Arc::new(supervisor::ManagerShared::new(settings)),
        }
    }

    fn shared(&self) -> &Arc<supervisor::ManagerShared> {
        &self.shared
    }

    /// 하네스가 떠 있으면 writer 를 깨운다. 없으면 아무 일도 하지 않는다.
    /// Dispatcher lock 을 잡지 않는다 — `publish_state` 가 lock 안에서 부른다.
    pub(crate) fn wake_writer(&self) {
        self.shared.wake_writer();
    }

    /// 테스트 전용 — 실행기 깨우기 배선을 잠근다 (감독은 `ManagerShared` 를 직접 쓴다).
    #[cfg(test)]
    pub(crate) fn set_wake(&self, wake: Option<Arc<harness::Wake>>) {
        self.shared.set_wake(wake);
    }

    /// 앱 종료 — 감독 정지와 실행 중 하네스 종료.
    pub(crate) fn stop(&self) {
        self.shared.stop_supervisor();
    }
}

/// 상태 발행 훅 — 관리자 실행기가 떠 있으면 writer 에게 이벤트를 확인하라고 알린다.
/// 실행기가 없으면(설정 꺼짐) no-op 이다.
pub(crate) fn wake(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<ManagerRuntime>() {
        runtime.wake_writer();
    }
}

/// 관리자 하네스 감독을 한 번만 시작한다 — [`BootWork::apply`] 가
/// `ensure_workspace` 뒤에 부른다. 재검사 재진입은 [`supervisor::ManagerShared`] 의
/// 원자적 플래그가 막는다. 관리자 워크스페이스가 상태에 없으면 아무것도 하지 않는다
/// (생성 실패는 `ensure_workspace` 가 이미 `failed` 로 표시했다).
pub(crate) fn start_supervisor(handle: &AppHandle, dispatcher: &Arc<Mutex<Dispatcher>>) {
    let Some(runtime) = handle.try_state::<ManagerRuntime>() else {
        return;
    };
    let shared = Arc::clone(runtime.shared());
    let target = {
        let d = dispatcher.lock().unwrap();
        d.state()
            .workspaces
            .iter()
            .find(|workspace| workspace.manager)
            .map(|workspace| {
                (
                    workspace.id.0,
                    workspace.root_path.clone(),
                    workspace.distro.clone(),
                )
            })
    };
    let Some((manager_workspace, root_path, manager_distro)) = target else {
        return;
    };
    let Some(manager_dir) = root_path else {
        // 관리자 워크스페이스는 항상 root_path 를 가진다 — 도달하면 계약 위반이다.
        if shared.fail("the manager workspace has no root path".to_owned()) {
            emit_board(handle, &shared);
        }
        return;
    };
    if !shared.begin_supervisor() {
        return;
    }
    let hello = AppToHarness::Hello {
        protocol: HARNESS_PROTOCOL,
        manager_workspace,
        manager_dir,
        manager_distro,
        default_distro: crate::host::env_distro(),
        settings: harness_settings(shared.settings()),
    };
    let on_update = {
        let app = handle.clone();
        let shared = Arc::clone(&shared);
        Arc::new(move || emit_board(&app, &shared))
    };
    let on_notify = {
        let app = handle.clone();
        Arc::new(move |message: mast_core::manager::HarnessToApp| {
            let Some(payload) = supervisor::notification_payload(&message) else {
                return;
            };
            if let Err(err) = app.emit(MANAGER_NOTIFY_EVENT, payload) {
                winlog!("manager-notify emit failed: {err}");
            }
        })
    };
    let supervisor = supervisor::start(
        shared,
        supervisor::SupervisorOptions {
            hello,
            dispatcher: Arc::clone(dispatcher),
            build_command: command_builder(),
            backoff: supervisor::Backoff::standard(),
        },
        on_update,
        on_notify,
    );
    runtime.shared().attach_supervisor(supervisor);
}

/// 하네스 실행 명령 빌더 — 재시작마다 새 `Command` 를 만든다.
///
/// macOS(unix) 는 네이티브 홈에서 `~/.mast/bin/mast-python` 을 읽으므로 여기서
/// spawn 전 오류가 날 수 있고, 그것은 감독이 `unsupported` 로 표시한다.
#[cfg(not(windows))]
fn command_builder() -> Arc<dyn Fn() -> Result<std::process::Command, String> + Send + Sync> {
    Arc::new(|| {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_owned())?;
        harness::harness_command(std::path::Path::new(&home))
    })
}

/// Windows 는 `wsl.exe` 런처가 `mast-python` 부재를 exit 4(미프로비저닝)로 판정한다.
#[cfg(windows)]
fn command_builder() -> Arc<dyn Fn() -> Result<std::process::Command, String> + Send + Sync> {
    Arc::new(|| Ok(harness::harness_command()))
}

/// hello 의 설정 값 — 부팅 때 해석한 [`ResolvedManagerSettings`] 를 하네스 계약으로 옮긴다.
fn harness_settings(settings: &ResolvedManagerSettings) -> HarnessSettings {
    HarnessSettings {
        model: settings.model.clone(),
        effort: settings.effort.clone(),
        summary_model: settings.summary_model.clone(),
        summary_effort: settings.summary_effort.clone(),
        idle_seconds: u64::from(settings.idle_seconds),
    }
}

/// `manager-board` emit — status·board 가 바뀐 뒤에만 호출자가 부른다.
fn emit_board(app: &AppHandle, shared: &supervisor::ManagerShared) {
    if let Err(err) = app.emit(MANAGER_BOARD_EVENT, shared.payload()) {
        winlog!("manager-board emit failed: {err}");
    }
}

/// 실패 이유를 글루 status `failed` 로 남기고 `manager-board` 를 emit 한다.
fn report_failed(handle: &AppHandle, reason: String) {
    let Some(runtime) = handle.try_state::<ManagerRuntime>() else {
        return;
    };
    let shared = runtime.shared();
    if shared.fail(reason) {
        emit_board(handle, shared);
    }
}

/// `get_manager_board` — 프론트 보드 뷰의 초기 스냅샷.
/// 기능이 꺼져 있으면(관리 상태 없음) `disabled` + `board: null` 이다.
#[tauri::command]
pub(crate) fn get_manager_board(app: AppHandle) -> supervisor::ManagerBoardPayload {
    match app.try_state::<ManagerRuntime>() {
        Some(runtime) => runtime.shared().payload(),
        None => supervisor::ManagerBoardPayload::disabled(),
    }
}

/// `manager_action` — choice 카드의 이어보기(`resume`)/새로 시작(`fresh`)을 실행 중
/// 하네스의 action 큐에 넣는다.
#[tauri::command]
pub(crate) fn manager_action(app: AppHandle, action: String, key: String) -> Result<(), String> {
    let action = supervisor::parse_action(&action)?;
    if !supervisor::valid_manager_key(&key) {
        return Err("the manager key must be k followed by 20 hex digits".to_owned());
    }
    let Some(runtime) = app.try_state::<ManagerRuntime>() else {
        return Err(supervisor::HARNESS_NOT_RUNNING.to_owned());
    };
    runtime.shared().send_action(action, key)
}

/// 관리자 워크스페이스 하나를 보장한다 — 이미 있으면 아무것도 하지 않는다(복원 상태).
/// 홈 탐지·생성이 실패하거나 스폰이 실패하면 로그만 남기고 부팅을 계속한다.
pub(crate) fn ensure_workspace(handle: &AppHandle, dispatcher: &Arc<Mutex<Dispatcher>>) {
    if dispatcher
        .lock()
        .unwrap()
        .state()
        .workspaces
        .iter()
        .any(|workspace| workspace.manager)
    {
        return;
    }
    let distro = crate::host::resolve_distro(None);
    // 홈 탐지는 wsl.exe 프로브(Windows)라 수 초가 걸릴 수 있다 — Dispatcher lock 을
    // 쥔 채로 두면 무관한 커맨드가 전부 밀리므로 lock 밖에서 한다.
    let home = match detect_home(distro.clone()) {
        Ok(home) => home,
        Err(err) => {
            winlog!("manager: cannot resolve the manager home: {err}");
            report_failed(handle, format!("cannot resolve the manager home: {err}"));
            return;
        }
    };
    let root_path = manager_root(&home);
    let mut d = dispatcher.lock().unwrap();
    // 다운그레이드 흔적 — 같은 root_path 를 쓰는 일반 워크스페이스가 이미 있으면
    // 코어는 그래도 관리자 워크스페이스를 만든다(정체성이 다른 별개 워크스페이스).
    // 그 사실을 로그 한 줄로만 남긴다.
    if d.state()
        .workspaces
        .iter()
        .any(|workspace| !workspace.manager && workspace.root_path.as_deref() == Some(root_path.as_str()))
    {
        winlog!(
            "manager: a regular workspace already uses {root_path}; creating the manager workspace alongside it"
        );
    }
    match d.dispatch(Command::CreateManagerWorkspace { root_path, distro }) {
        Ok(_) => state::publish_state(handle, &d),
        // 이미 있으면 정상이다 — 위 사전 검사와 dispatch 사이에 다른 경로가 만들었을
        // 수 있다. 상태·revision 이 불변이라 할 일이 없다.
        Err(CommandError::ManagerExists) => {}
        Err(err) => {
            winlog!("manager: cannot create the manager workspace: {err}");
            report_failed(handle, format!("cannot create the manager workspace: {err}"));
        }
    }
}

/// 상태에 관리자 워크스페이스가 있으면 해체하고 publish 한다. 없으면 no-op.
/// 실패는 로그 한 줄로 끝낸다 — 부팅을 막지 않는다.
pub(crate) fn remove_workspace(handle: &AppHandle, dispatcher: &Arc<Mutex<Dispatcher>>) {
    let mut d = dispatcher.lock().unwrap();
    if !d.state().workspaces.iter().any(|workspace| workspace.manager) {
        return;
    }
    match d.dispatch(Command::RemoveManagerWorkspace) {
        Ok(_) => state::publish_state(handle, &d),
        Err(err) => winlog!("manager: cannot remove the manager workspace: {err}"),
    }
}

/// Windows — `wsl.exe` 안에서 `$HOME/.mast/manager` 를 만들고 `$HOME` 을 받아온다.
/// `mkdir` 이 실패하면 `&&` 가 끊겨 stdout 이 비고, 그것도 아래 검증이 거른다.
#[cfg(windows)]
fn detect_home(distro: Option<String>) -> Result<String, String> {
    let mut command = std::process::Command::new("wsl.exe");
    command.args(home_probe_args(distro.as_deref()));
    // `capture` 가 stdin null·stdout/stderr 파이프·CREATE_NO_WINDOW 를 설정하고
    // 상한 초과 시 자식을 죽여 거둔다 (`warm_wsl` 과 같은 콘솔 창 억제).
    let captured = mast_core::capture::capture(&mut command, HOME_CAPTURE_LIMITS)
        .map_err(|err| format!("cannot run the WSL home probe: {err}"))?;
    if captured.timed_out {
        return Err(format!(
            "the WSL home probe exceeded {} s",
            HOME_CAPTURE_LIMITS.timeout.as_secs()
        ));
    }
    if captured.stdout_truncated {
        return Err(format!(
            "the WSL home probe wrote more than {HOME_MAX_BYTES} bytes"
        ));
    }
    let Some(status) = captured.status else {
        return Err("the WSL home probe did not report an exit status".to_owned());
    };
    if !status.success() {
        return Err(format!(
            "the WSL home probe exited with {status}: {}",
            String::from_utf8_lossy(&captured.stderr).trim()
        ));
    }
    parse_home_output(&captured.stdout)
}

/// Windows 밖(macOS·개발 unix) — 네이티브 홈을 그대로 쓰고, 디렉터리를 먼저 만든다.
/// 프로브 출력과 같은 검증을 통과해야 한다.
#[cfg(not(windows))]
fn detect_home(_distro: Option<String>) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_owned())?;
    let home = parse_home_output(home.as_bytes())?;
    let root = manager_root(&home);
    std::fs::create_dir_all(&root)
        .map_err(|err| format!("cannot create {root}: {err}"))?;
    Ok(home)
}

/// 홈 프로브 상한 — stdout/stderr 각 4 KiB, 전체 10초.
#[cfg(windows)]
const HOME_CAPTURE_LIMITS: mast_core::capture::CaptureLimits = mast_core::capture::CaptureLimits {
    stdout_bytes: HOME_MAX_BYTES,
    stderr_bytes: 4 * 1024,
    timeout: Duration::from_secs(10),
};

/// 홈 탐지 스크립트 — 디렉터리를 먼저 만들고 홈을 그대로 출력한다 (`printf %s` 라
/// 개행이 없다). `~` 가 아니라 `$HOME` 인 것은 배포판 기본 셸과 무관하게 같은 값을
/// 얻기 위함이다 (`/bin/sh` 가 실행한다).
#[cfg(windows)]
const HOME_PROBE_SCRIPT: &str = r#"mkdir -p "$HOME/.mast/manager" && printf %s "$HOME""#;

/// `wsl.exe` 홈 탐지 인자 — `--exec /bin/sh -c` 로 셸 평가를 한 번만 받는다
/// (`host::spawn_spec` 과 같은 이유 — `--` 는 기본 셸을 한 번 더 거친다).
#[cfg(windows)]
fn home_probe_args(distro: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(distro) = distro {
        args.push("-d".to_owned());
        args.push(distro.to_owned());
    }
    args.extend(["--exec", "/bin/sh", "-c", HOME_PROBE_SCRIPT].map(str::to_owned));
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ResolvedManagerSettings;

    fn resolved(enabled: bool) -> ResolvedManagerSettings {
        ResolvedManagerSettings {
            enabled,
            model: "m".to_owned(),
            effort: "high".to_owned(),
            summary_model: "m".to_owned(),
            summary_effort: "low".to_owned(),
            idle_seconds: 45,
        }
    }

    #[test]
    fn preview_switch_is_off_without_settings_and_follows_enabled() {
        assert!(!enabled(None));
        assert!(!enabled(Some(&resolved(false))));
        assert!(enabled(Some(&resolved(true))));
    }

    #[test]
    fn home_output_must_be_a_plain_absolute_path() {
        assert_eq!(parse_home_output(b"/home/user").unwrap(), "/home/user");
        let rejected: [&[u8]; 6] = [
            b"",
            b"home/user",
            b"/home/user\n",
            b"/home/user\r",
            b"/home/user\0",
            b"/home/\x80user",
        ];
        for bytes in rejected {
            assert!(parse_home_output(bytes).is_err(), "{bytes:?}");
        }
    }

    #[test]
    fn home_output_cap_is_4096_bytes() {
        let max = format!("/{}", "a".repeat(HOME_MAX_BYTES - 1));
        assert_eq!(max.len(), HOME_MAX_BYTES);
        assert_eq!(parse_home_output(max.as_bytes()).unwrap(), max);

        let over = format!("/{}", "a".repeat(HOME_MAX_BYTES));
        assert_eq!(over.len(), HOME_MAX_BYTES + 1);
        assert!(parse_home_output(over.as_bytes()).is_err());
    }

    #[test]
    fn manager_root_joins_with_a_single_slash() {
        assert_eq!(manager_root("/home/user"), "/home/user/.mast/manager");
        assert_eq!(manager_root("/home/user/"), "/home/user/.mast/manager");
        assert_eq!(manager_root("/"), "/.mast/manager");
    }

    #[test]
    fn runtime_wake_signals_only_when_a_harness_is_installed() {
        let runtime = ManagerRuntime::new(resolved(true));
        // 실행기가 없으면 no-op — 패닉도, 신호도 없다.
        runtime.wake_writer();

        let wake = std::sync::Arc::new(harness::Wake::default());
        runtime.set_wake(Some(std::sync::Arc::clone(&wake)));
        runtime.wake_writer();
        assert!(wake.wait_for_signal(), "설치된 깨우기에는 신호가 간다");

        runtime.set_wake(None);
        runtime.wake_writer();
        assert!(!wake.is_signaled(), "실행기가 내려가면 신호도 없다");
    }

    #[cfg(windows)]
    #[test]
    fn home_probe_args_follow_the_wsl_exec_shape() {
        assert_eq!(
            home_probe_args(Some("Ubuntu")),
            ["-d", "Ubuntu", "--exec", "/bin/sh", "-c", HOME_PROBE_SCRIPT]
        );
        assert_eq!(
            home_probe_args(None),
            ["--exec", "/bin/sh", "-c", HOME_PROBE_SCRIPT]
        );
    }
}
