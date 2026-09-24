//! WSL 준비 상태 진단의 글루 — 실제 `wsl.exe -l -q` 프로브를 코어 진단기에 물리고,
//! 결과를 프론트 계약(DTO)·이벤트로 내보낸다.
//!
//! # 부팅 순서에서의 위치
//!
//! `main.rs` 가 상태 로드 직후 진단기를 만들어 첫 진단을 백그라운드 스레드로
//! 띄운다 (`WslHealth::start`). 모든 터미널 스폰은 `host.rs` 의 게이트를 지나므로
//! **진단이 끝나기 전에는 어떤 셸도 스폰되지 않는다**. 부팅 재스폰·초기 탭 생성·
//! 프로비저닝은 `boot::BootWork` 가 첫 진단을 기다린 뒤 시작하고, 진단이 "준비
//! 안 됨"이면 아무것도 실행하지 않는다 (사용자 재검사가 유일한 재시도 경로다).
//!
//! # 분류는 코어가 한다
//!
//! `wsl.exe` 의 오류 문구는 시스템 언어로 나오므로 여기서 문자열을 보지 않는다.
//! [`mast_core::wsl::classify`] 가 종료 코드와 배포판 목록으로 분류하고, 원문
//! 출력은 [`WslStatusDto::detail`] 로 그대로 실어 UI 가 보여 준다.
//!
//! # unix 개발 실행
//!
//! WSL 이 없는 호스트에서는 프로브가 [`WslStatus::NotApplicable`] 을 돌려주고
//! 게이트가 열린 채로 남는다 (`host.rs` 의 게이트는 Windows 전용이다).

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use mast_core::command::Dispatcher;
use mast_core::wsl::{self, WslHealth, WslStatus};
use tauri::{AppHandle, Emitter, Manager};

use crate::winlog;

/// 진단 결과가 갱신될 때마다 프론트에 보내는 이벤트 이름 — 프론트
/// `infrastructure/backend.ts` 의 `onWslStatusChanged` 와 짝이다.
pub const WSL_STATUS_EVENT: &str = "wsl-status-changed";

/// 첫 진단·재검사를 기다리는 상한 — 프로브 자체 상한(기본 8초)보다 넉넉하다.
/// 넘기면 호출자는 "아직 모른다"(`Probing`)로 취급해야 한다.
pub const STATUS_WAIT: Duration = Duration::from_secs(15);

/// 시간 초과 안내 재현용 상한(ms). 0은 기본값이고 최대 8초다.
const PROBE_TIMEOUT_ENV: &str = "MAST_WSL_PROBE_TIMEOUT_MS";

/// 진단을 무기한 대기시키는 설정은 허용하지 않는다.
#[cfg(windows)]
const MAX_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// 프론트 DTO. `state` 는 코어 [`WslStatus`] 의 태그와 같은 이름이고, 나머지는
/// 원문 세부 정보·원시 코드·배포판 목록, 그리고 **워크스페이스가 요구하는데 설치돼
/// 있지 않은 distro 목록**이다 (UI 의 "선택 배포판 없음" 안내 근거).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslStatusDto {
    pub state: &'static str,
    pub detail: Option<String>,
    pub code: Option<u32>,
    pub distros: Vec<String>,
    pub missing_distros: Vec<String>,
    pub failures: Vec<wsl::DistroFailure>,
}

/// 진단기를 만든다. 완료 콜백은 [`attach_emitter`] 로 따로 단다 — `TauriHost` 가
/// 진단기를 들고 `Dispatcher` 가 `TauriHost` 를 들기 때문에, 콜백이 잡을
/// Dispatcher 핸들은 진단기가 `Arc` 로 공유된 뒤에야 생긴다.
static TARGETS: Mutex<Vec<Option<String>>> = Mutex::new(Vec::new());

pub fn include_target(distro: Option<String>) {
    let mut targets = TARGETS.lock().unwrap();
    if !targets.contains(&distro) {
        targets.push(distro);
    }
}

pub fn ensure_target(health: &Arc<WslHealth>, distro: Option<String>) {
    if !cfg!(windows) {
        return;
    }
    include_target(distro.clone());
    let status = health.wait_for_first(STATUS_WAIT);
    if let WslStatus::Ready {
        distros, checked, ..
    } = &status
    {
        let name = distro
            .as_deref()
            .or_else(|| distros.first().map(String::as_str));
        if name.is_some_and(|name| {
            distros.iter().any(|d| d.eq_ignore_ascii_case(name))
                && !checked.iter().any(|d| d.eq_ignore_ascii_case(name))
        }) {
            health.refresh(STATUS_WAIT);
        }
    }
}

pub fn create() -> Arc<WslHealth> {
    #[cfg(windows)]
    let probe: wsl::ProbeFn = Box::new(probe_now);
    // unix 개발 실행에는 WSL 이 없다 — 게이트가 열린 상태로 고정한다.
    #[cfg(not(windows))]
    let probe: wsl::ProbeFn = Box::new(|| WslStatus::NotApplicable);

    Arc::new(WslHealth::new(probe))
}

/// 완료 콜백 연결 — 진단이 끝날 때마다 프론트로 `wsl-status-changed` 를 보낸다.
/// 콜백은 코어 계약상 **캐시 갱신 뒤**에 불리므로, 이벤트를 받은 프론트가 곧바로
/// `get_wsl_status` 로 되읽어도 새 값을 본다. 첫 진단 시작 전에 부른다.
pub fn attach_emitter(health: &Arc<WslHealth>, app: AppHandle, dispatcher: Arc<Mutex<Dispatcher>>) {
    health.set_callback(Box::new(move |status| {
        emit(&app, &dispatcher.lock().unwrap(), status);
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            state.boot.retry(
                app.clone(),
                Arc::clone(&state.dispatcher),
                Arc::clone(&state.records),
                Arc::clone(&state.wsl),
                status.clone(),
            );
        }
    }));
}

/// 프로브 1회 — `wsl.exe -l -q`. 상한 안에서 실행하고 분류는 코어에 맡긴다.
#[cfg(windows)]
fn probe_now() -> WslStatus {
    let mut command = std::process::Command::new("wsl.exe");
    command.args(["-l", "-q"]);
    // `capture` 가 stdin null·stdout/stderr 파이프·CREATE_NO_WINDOW 를 설정하고
    // 상한 초과 시 자식을 죽여 거둔다 (타임아웃 정리 계약).
    let mut status = wsl::classify(wsl::probe(&mut command, probe_timeout()));
    if let WslStatus::Ready {
        distros,
        failures,
        checked,
    } = &mut status
    {
        let targets = TARGETS.lock().unwrap().clone();
        for distro in distros.iter().filter(|d| {
            targets.iter().any(|target| {
                target
                    .as_deref()
                    .or_else(|| distros.first().map(String::as_str))
                    .is_some_and(|name| name.eq_ignore_ascii_case(d))
            })
        }) {
            checked.push(distro.clone());
            let mut command = std::process::Command::new("wsl.exe");
            command.args([
                "-d",
                distro,
                "--exec",
                "bash",
                "--noprofile",
                "--norc",
                "-c",
                "printf mast-ready",
            ]);
            let result = wsl::probe(&mut command, probe_timeout());
            if result.outcome == (wsl::ProbeOutcome::Exited { code: Some(0) })
                && result.stdout == b"mast-ready"
            {
                continue;
            }
            let code = match result.outcome {
                wsl::ProbeOutcome::Exited { code } => code,
                _ => None,
            };
            let timed_out = result.outcome == wsl::ProbeOutcome::TimedOut;
            let detail = match &result.outcome {
                wsl::ProbeOutcome::NotRunnable { detail, .. } => detail.clone(),
                _ => format!(
                    "{}{}{}",
                    if timed_out {
                        "Execution timed out. "
                    } else {
                        "Shell readiness check failed. "
                    },
                    wsl::decode_output(&result.stdout),
                    wsl::decode_output(&result.stderr)
                ),
            };
            failures.push(wsl::DistroFailure {
                distro: distro.clone(),
                detail,
                code,
                timed_out,
            });
        }
    }
    status
}

#[cfg(windows)]
fn probe_timeout() -> Duration {
    static CACHED: OnceLock<Duration> = OnceLock::new();
    *CACHED.get_or_init(|| {
        let Ok(raw) = std::env::var(PROBE_TIMEOUT_ENV) else {
            return wsl::PROBE_TIMEOUT;
        };
        match raw.trim().parse::<u64>() {
            Ok(0) => wsl::PROBE_TIMEOUT,
            Ok(ms) => Duration::from_millis(ms).min(MAX_PROBE_TIMEOUT),
            Err(err) => {
                winlog!("{PROBE_TIMEOUT_ENV}={raw:?} is not a number ({err}); using the default");
                wsl::PROBE_TIMEOUT
            }
        }
    })
}

/// 현재 상태 → 프론트 DTO. `missingDistros` 계산을 위해 Dispatcher 상태를 짧게
/// 읽는다 — 호출자가 `spawn_blocking` 안에서 부른다.
pub fn dto(status: &WslStatus, dispatcher: &Dispatcher) -> WslStatusDto {
    let mut resolved: Vec<Option<String>> = dispatcher
        .state()
        .workspaces
        .iter()
        .map(|workspace| crate::host::resolve_distro(workspace.distro.clone()))
        .collect();
    resolved.push(crate::host::resolve_distro(None));
    WslStatusDto {
        failures: match status {
            WslStatus::Ready { failures, .. } => failures.clone(),
            _ => Vec::new(),
        },
        state: status.state_name(),
        detail: status.detail().map(str::to_owned),
        code: status.code(),
        distros: status.distros().to_vec(),
        missing_distros: wsl::missing_distros(&resolved, status),
    }
}

/// 상태를 `wsl-status-changed` 로 보낸다. 실패는 가리지 않고 로그만 — 프론트에는
/// `get_wsl_status` 재조회 경로가 있어 치명적이지 않다.
pub fn emit(app: &AppHandle, dispatcher: &Dispatcher, status: &WslStatus) {
    if let Err(err) = app.emit(WSL_STATUS_EVENT, dto(status, dispatcher)) {
        winlog!("wsl: status emit failed: {err}");
    }
}

// 글루는 Linux 개발 호스트에서 컴파일되지 않으므로 이 테스트는 Windows CI 에서만
// 돈다 (ci.yml 의 `cargo test --workspace --target x86_64-pc-windows-msvc`).
// `AppHandle` 을 타지 않는 DTO 계약만 여기서 잠근다 — 프론트 타입 미러가 이
// 키 이름(camelCase)에 걸려 있다. macOS 워크스페이스는 distro 를 저장하지 않아 없는
// 배포판 목록이 생기지 않으므로 macOS 에서는 돌리지 않는다.
#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    use mast_core::command::{Command, Dispatcher, SessionHost, ShellSpawnReq};
    use mast_core::session::SessionId;

    use super::*;

    struct NoSpawn;

    impl SessionHost for NoSpawn {
        fn spawn_shell(&self, _req: ShellSpawnReq) -> anyhow::Result<SessionId> {
            anyhow::bail!("the DTO test never spawns a shell")
        }

        fn kill(&self, _id: SessionId) {}
    }

    #[test]
    fn dto_mirrors_the_state_and_lists_missing_workspace_distros() {
        let mut dispatcher = Dispatcher::new(Box::new(NoSpawn));
        dispatcher
            .dispatch(Command::CreateWorkspace {
                name: "ws".to_owned(),
                root_path: None,
                distro: Some("Fedora".to_owned()),
                tab: None,
            })
            .expect("empty workspace dispatch");

        let ready = WslStatus::Ready {
            distros: vec!["Ubuntu".to_owned()],
            failures: Vec::new(),
            checked: vec!["Ubuntu".into()],
        };
        let ready_dto = dto(&ready, &dispatcher);
        assert_eq!(ready_dto.state, "ready");
        assert_eq!(ready_dto.distros, vec!["Ubuntu"]);
        assert_eq!(ready_dto.missing_distros, vec!["Fedora"]);
        assert_eq!(ready_dto.detail, None);
        assert_eq!(ready_dto.code, None);

        // 프론트 계약은 camelCase 키다 (`infrastructure/backend.ts` 의 WslStatus).
        let json = serde_json::to_value(&ready_dto).expect("dto serializes");
        assert_eq!(json["state"], "ready");
        assert_eq!(json["missingDistros"], serde_json::json!(["Fedora"]));
        assert!(json.get("missing_distros").is_none());

        // 상태 태그는 코어의 `state_name` 과 같아야 한다 — 두 곳이 갈라지면
        // 프론트 스위치가 조용히 기본 분기를 탄다.
        let probing = dto(&WslStatus::Probing, &dispatcher);
        assert_eq!(probing.state, "probing");
        assert!(probing.missing_distros.is_empty());
    }
}
