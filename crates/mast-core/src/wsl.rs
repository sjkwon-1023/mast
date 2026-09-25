//! WSL 준비 상태 진단 — `wsl.exe -l -q` 질의를 상한 안에서 실행하고, 그 결과를
//! 앱이 안내·게이트에 쓸 수 있는 상태로 분류한다.
//!
//! # 왜 코어인가
//!
//! 분류·게이트·진단기 상태 기계는 플랫폼 I/O 없이 테스트 가능해야 한다. 글루
//! (`apps/mast/src-tauri`)는 Linux 개발 호스트에서 컴파일되지 않아 그 안에 두면
//! `cargo test` 가 한 줄도 돌지 않는다. 그래서 여기에는 순수 로직이 있고, 실제
//! `wsl.exe` 스폰은 [`probe`] 에 `Command` 를 넘기는 글루 몫이다.
//!
//! # 분류 원칙
//!
//! **로캘 문자열에 의존하지 않는다.** `wsl.exe` 의 오류 메시지는 시스템 언어로
//! 나오므로 문구 매칭은 한국어 Windows 에서 곧바로 깨진다. 대신 종료 코드와
//! 배포판 목록이라는 구조적 신호를 쓴다 ([`classify`] 참조). 원문 출력은 버리지
//! 않고 `detail` 로 실어 UI 가 그대로 보여 준다 — 분류와 원문은 별개다.
//!
//! # 진단기 ([`WslHealth`])
//!
//! 진단은 부팅에 한 번 비동기로 돌고, 결과는 캐시되어 모든 스폰 경로가 공유한다
//! (정상 탭 생성마다 WSL 프로세스를 새로 띄우지 않는다). 명시적 재검사
//! ([`WslHealth::refresh`])만 새 프로브를 돌리며, 동시에 들어온 재검사 요청은
//! 하나의 프로브로 합쳐진다.

use std::process::Command;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::capture::{capture_with_spawn, CaptureLimits};
use crate::model::{AppState, TabId, TabKind, TerminalStatus};

/// 개별 WSL 프로브의 유한 실행 상한.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// 프로브 출력 상한 — 배포판 이름 목록은 수 KB 를 넘지 않는다.
const PROBE_STDOUT_CAP: usize = 64 * 1024;
const PROBE_STDERR_CAP: usize = 64 * 1024;

/// 배포판이 하나도 없을 때 `wsl.exe -l -q` 가 내는 종료 코드 (0xFFFFFFFF).
pub const NO_DISTRO_CODE: u32 = 0xFFFF_FFFF;

/// WSL 선택적 구성 요소가 꺼져 있을 때의 HRESULT
/// (`WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED`) — 사실상 "WSL 미설치"다.
pub const COMPONENT_REQUIRED_CODE: u32 = 0x8007_019E;

/// 프로브의 실행 결과 — 분류 이전의 원시값.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// 프로세스가 끝났다. `code` 는 종료 코드의 u32 원값(Windows 는 HRESULT 포함),
    /// 시그널 등으로 코드가 없는 종료는 None 이다.
    Exited { code: Option<u32> },
    /// 상한을 넘겨 자식을 죽이고 거둔 뒤 끝냈다.
    TimedOut,
    /// 프로세스를 띄우지 못했다. `not_found` 는 실행 파일 자체가 없는 경우다.
    NotRunnable { not_found: bool, detail: String },
}

/// 프로브 원시 결과 — 종료 상태와 두 스트림.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeResult {
    pub outcome: ProbeOutcome,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// `command` 를 `timeout` 안에서 실행하고 출력을 캡처한다. 상한을 넘기면 자식을
/// 죽이고 [`ProbeOutcome::TimedOut`] 으로 끝난다 (정리·회수는
/// [`crate::capture`] 가 보장한다 — 좀비 relay 를 남기지 않는다).
pub fn probe(command: &mut Command, timeout: Duration) -> ProbeResult {
    let captured = capture_with_spawn(
        command,
        CaptureLimits {
            stdout_bytes: PROBE_STDOUT_CAP,
            stderr_bytes: PROBE_STDERR_CAP,
            timeout,
        },
    );
    match captured {
        Ok(output) => {
            let outcome = if output.timed_out {
                ProbeOutcome::TimedOut
            } else {
                ProbeOutcome::Exited {
                    code: output
                        .status
                        .as_ref()
                        .and_then(|status| status.code())
                        .map(|code| code as u32),
                }
            };
            ProbeResult {
                outcome,
                stdout: output.stdout,
                stderr: output.stderr,
            }
        }
        Err(failure) => ProbeResult {
            outcome: ProbeOutcome::NotRunnable {
                not_found: failure.not_found,
                detail: failure.message,
            },
            stdout: Vec::new(),
            stderr: Vec::new(),
        },
    }
}

/// `wsl.exe` 자신이 내는 텍스트는 UTF-16LE(파이프로 리다이렉트해도 그렇다),
/// 리눅스 쪽 도구가 내는 텍스트는 UTF-8 이다. NUL 바이트가 섞였는지로 가른다 —
/// `provision.rs::decode_message` 와 같은 규율이고, 진단 문자열이라 lossy 로 충분하다.
pub fn decode_output(bytes: &[u8]) -> String {
    if bytes.contains(&0) || bytes.starts_with(&[0xFF, 0xFE]) {
        decode_utf16le(bytes)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// UTF-16LE 바이트열 → String. 선두 BOM 은 바이트 순서가 이미 확정이라 벗기고,
/// 짝이 안 맞는 마지막 바이트는 버리며, 부적합 서로게이트는 U+FFFD 로 둔다.
pub fn decode_utf16le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let text = String::from_utf16_lossy(&units);
    match text.strip_prefix('\u{feff}') {
        Some(text) => text.to_owned(),
        None => text,
    }
}

/// `wsl.exe -l -q` 출력 → 배포판 이름 목록. BOM·CRLF·빈 줄을 걷어낸다.
/// **첫 항목이 기본 배포판이다** — `wsl -l` 이 기본 배포판을 맨 앞에 낸다
/// (`commands.rs::query_default_distro` 와 같은 전제).
pub fn parse_distro_list(bytes: &[u8]) -> Vec<String> {
    decode_output(bytes)
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

/// 앱이 안내·게이트에 쓰는 준비 상태.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WslStatus {
    /// 첫 진단이 아직 끝나지 않았다 — 이 상태에서는 어떤 터미널 스폰도 허용하지
    /// 않는다 (진단 전 실행 금지).
    Probing,
    /// 이 호스트에는 WSL 이 없다 (unix 개발 실행).
    NotApplicable,
    /// `wsl.exe` 를 실행할 수 없거나 WSL 구성 요소가 꺼져 있다.
    NotInstalled { code: Option<u32>, detail: String },
    /// `wsl.exe` 는 돌지만 배포판이 하나도 없다.
    NoDistro { code: Option<u32>, detail: String },
    /// 배포판 목록을 읽었다 — 첫 항목이 기본 배포판이다.
    Ready {
        distros: Vec<String>,
        failures: Vec<DistroFailure>,
        checked: Vec<String>,
    },
    /// 질의가 실패로 끝났다 (종료 코드·스폰 오류).
    Failed { code: Option<u32>, detail: String },
    /// 질의가 상한을 넘겼다 — 자식은 정리했다.
    TimedOut { detail: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistroFailure {
    pub distro: String,
    pub detail: String,
    pub code: Option<u32>,
    pub timed_out: bool,
}

impl WslStatus {
    /// 프론트 DTO 의 `state` 태그와 같은 이름.
    pub fn state_name(&self) -> &'static str {
        match self {
            WslStatus::Probing => "probing",
            WslStatus::NotApplicable => "notApplicable",
            WslStatus::NotInstalled { .. } => "notInstalled",
            WslStatus::NoDistro { .. } => "noDistro",
            WslStatus::Ready { .. } => "ready",
            WslStatus::Failed { .. } => "failed",
            WslStatus::TimedOut { .. } => "timeout",
        }
    }

    /// 원문 세부 정보 — 없으면 None. 분류가 실패해도 이 텍스트는 그대로 보여 준다.
    pub fn detail(&self) -> Option<&str> {
        match self {
            WslStatus::NotInstalled { detail, .. }
            | WslStatus::NoDistro { detail, .. }
            | WslStatus::Failed { detail, .. }
            | WslStatus::TimedOut { detail } => {
                Some(detail.as_str()).filter(|text| !text.is_empty())
            }
            _ => None,
        }
    }

    /// 원시 종료 코드 — 없으면 None.
    pub fn code(&self) -> Option<u32> {
        match self {
            WslStatus::NotInstalled { code, .. }
            | WslStatus::NoDistro { code, .. }
            | WslStatus::Failed { code, .. } => *code,
            _ => None,
        }
    }

    /// 설치된 배포판 목록 — Ready 일 때만 비어 있지 않다.
    pub fn distros(&self) -> &[String] {
        match self {
            WslStatus::Ready { distros, .. } => distros,
            _ => &[],
        }
    }

    /// 기본 배포판 이름 — Ready 의 첫 항목 (`wsl -l` 순서 계약).
    pub fn default_distro(&self) -> Option<&str> {
        match self {
            WslStatus::Ready { distros, .. } => distros.first().map(String::as_str),
            _ => None,
        }
    }

    /// 셸 스폰을 허용하는 상태인가 — Ready(배포판이 있다) 또는 NotApplicable(unix).
    /// **개별 distro 의 적격성은 [`spawn_block_reason`]** 이 판단한다: 하나의
    /// distro 가 없어도 다른 distro 의 탭은 살아나야 하므로, 재스폰 웨이브처럼
    /// 전체를 한 번에 결정하는 자리는 이 술어로 "WSL 자체가 되는가"만 본다.
    pub fn permits_spawns(&self) -> bool {
        matches!(self, WslStatus::Ready { .. } | WslStatus::NotApplicable)
    }

    /// 로그 한 줄용 요약 (사용자 대면 문구는 프론트 `features/wsl/notice.ts` 소유).
    pub fn summary(&self) -> String {
        match self {
            WslStatus::Probing => "not checked yet".to_owned(),
            WslStatus::NotApplicable => "not applicable on this host".to_owned(),
            WslStatus::NotInstalled { .. } => "WSL is not installed or not enabled".to_owned(),
            WslStatus::NoDistro { .. } => "no WSL distribution is installed".to_owned(),
            WslStatus::Ready { distros, .. } => {
                format!("ready ({} distribution(s))", distros.len())
            }
            WslStatus::Failed { .. } => "the distribution listing failed".to_owned(),
            WslStatus::TimedOut { .. } => "the distribution listing timed out".to_owned(),
        }
    }
}

/// 프로브 원시 결과 → 준비 상태. **구조적 신호만 쓴다** (종료 코드·출력 유무) —
/// 원문 문자열은 `detail` 로 실어 보낼 뿐 판정에 쓰지 않는다.
pub fn classify(probe: ProbeResult) -> WslStatus {
    let detail = primary_detail(&probe);
    match probe.outcome {
        ProbeOutcome::TimedOut => WslStatus::TimedOut { detail },
        ProbeOutcome::NotRunnable { not_found, detail } => {
            if not_found {
                WslStatus::NotInstalled { code: None, detail }
            } else {
                WslStatus::Failed { code: None, detail }
            }
        }
        ProbeOutcome::Exited { code } => {
            let distros = parse_distro_list(&probe.stdout);
            match code {
                // 성공 + 빈 목록 = WSL 은 살아 있으나 배포판이 없다.
                Some(0) if distros.is_empty() => WslStatus::NoDistro {
                    code: Some(0),
                    detail,
                },
                Some(0) => WslStatus::Ready {
                    distros,
                    failures: Vec::new(),
                    checked: Vec::new(),
                },
                // 0xFFFFFFFF 를 포함한 상위 비트 코드는 `ExitStatus::code()` 가
                // i32 로 되돌려주므로 u32 로 복원해 비교한다.
                Some(NO_DISTRO_CODE) if distros.is_empty() => WslStatus::NoDistro {
                    code: Some(NO_DISTRO_CODE),
                    detail,
                },
                Some(COMPONENT_REQUIRED_CODE) => WslStatus::NotInstalled {
                    code: Some(COMPONENT_REQUIRED_CODE),
                    detail,
                },
                other => WslStatus::Failed {
                    code: other,
                    detail,
                },
            }
        }
    }
}

/// 원문 세부 정보 — stderr 를 우선하고 비어 있으면 stdout 을 쓴다.
fn primary_detail(probe: &ProbeResult) -> String {
    let stderr = decode_output(&probe.stderr);
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_owned();
    }
    decode_output(&probe.stdout).trim().to_owned()
}

/// 이 distro 로 셸을 띄워도 되는가 — 아니면 사용자에게 보여 줄 사유.
///
/// `requested` 가 None/빈 문자열이면 `wsl.exe` 의 기본 배포판을 쓴다는 뜻이고,
/// Ready 목록이 비어 있지 않으면 기본 배포판이 존재한다 (첫 항목).
pub fn spawn_block_reason(status: &WslStatus, requested: Option<&str>) -> Option<String> {
    let requested = requested.filter(|distro| !distro.is_empty());
    match status {
        WslStatus::Ready {
            distros,
            failures,
            checked,
        } => match requested.or_else(|| distros.first().map(String::as_str)) {
            Some(name) if failures.iter().any(|f| f.distro.eq_ignore_ascii_case(name)) => {
                let failure = failures
                    .iter()
                    .find(|f| f.distro.eq_ignore_ascii_case(name))
                    .unwrap();
                Some(format!(
                    "WSL distribution {name:?} could not start: {}",
                    failure.detail
                ))
            }
            None => None,
            Some(name)
                if checked
                    .iter()
                    .any(|distro| distro.eq_ignore_ascii_case(name)) =>
            {
                None
            }
            Some(name)
                if distros
                    .iter()
                    .any(|distro| distro.eq_ignore_ascii_case(name)) =>
            {
                Some(format!(
                    "WSL distribution {name:?} has not been checked yet; recheck WSL"
                ))
            }
            Some(name) => Some(format!(
                "WSL distribution {name:?} is not installed (installed: {})",
                distros.join(", ")
            )),
        },
        // unix 개발 실행에는 WSL 게이트가 없다.
        WslStatus::NotApplicable => None,
        WslStatus::Probing => {
            Some("WSL readiness has not been checked yet; try again in a moment".to_owned())
        }
        WslStatus::NotInstalled { code, detail } => Some(format!(
            "WSL is not installed or not enabled{}{}",
            code_suffix(*code),
            detail_suffix(detail)
        )),
        WslStatus::NoDistro { .. } => {
            Some("no WSL distribution is installed; install one and recheck".to_owned())
        }
        WslStatus::Failed { code, detail } => Some(format!(
            "the WSL distribution query failed{}{}",
            code_suffix(*code),
            detail_suffix(detail)
        )),
        WslStatus::TimedOut { .. } => {
            Some("WSL did not answer the distribution query in time".to_owned())
        }
    }
}

fn code_suffix(code: Option<u32>) -> String {
    match code {
        Some(code) => format!(" (0x{code:08X})"),
        None => String::new(),
    }
}

fn detail_suffix(detail: &str) -> String {
    if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    }
}

/// Ready 인데 설치 목록에 없는 distro 들 (중복 제거, 입력 순서 유지). `None`
/// (기본 배포판 사용)은 Ready 면 항상 만족이다.
pub fn missing_distros(resolved: &[Option<String>], status: &WslStatus) -> Vec<String> {
    let WslStatus::Ready { distros, .. } = status else {
        return Vec::new();
    };
    let mut missing: Vec<String> = Vec::new();
    for name in resolved.iter().flatten() {
        if !distros
            .iter()
            .any(|distro| distro.eq_ignore_ascii_case(name))
            && !missing.contains(name)
        {
            missing.push(name.clone());
        }
    }
    missing
}

/// 부팅 재스폰 계획 — 준비된 distro 의 탭과 건너뛴 탭을 가른다.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RespawnPlan {
    /// 지금 재스폰할 탭 (준비된 distro).
    pub ready: Vec<TabId>,
    /// 건너뛴 탭과 사유.
    pub skipped: Vec<(TabId, String)>,
}

/// 세션이 없는 `Running` 터미널 탭을 WSL 준비 상태로 가른다. **상태는 건드리지
/// 않는다** — 건너뛴 탭은 세션 없는 Running 으로 남아 다음 재검사에서 다시
/// 대상이 된다. `Exited` 로 강등하지 않는 이유: 기록·cwd 를 그대로 보존하고,
/// WSL 이 고쳐지면 사용자가 아무것도 하지 않아도 살아나야 하기 때문이다
/// (ADR-0018 의 기록 수명과 `respawn_tab` 의 실패 강등은 WSL 문제를 탭 상태에
/// 각인시키므로 여기서는 쓰지 않는다).
///
/// `fallback_distro` 는 워크스페이스에 distro 가 없을 때 쓸 이름이다 (글루의
/// `MAST_DISTRO`) — 스폰 경로의 distro 해석과 같은 순서를 지켜, 계획이 "준비됨"
/// 이라 한 탭이 게이트에서 거부되는 어긋남을 만들지 않는다.
pub fn respawn_plan(
    state: &AppState,
    status: &WslStatus,
    fallback_distro: Option<&str>,
) -> RespawnPlan {
    let fallback = fallback_distro.filter(|distro| !distro.is_empty());
    let mut plan = RespawnPlan::default();
    for workspace in &state.workspaces {
        let requested = workspace
            .distro
            .as_deref()
            .filter(|distro| !distro.is_empty())
            .or(fallback);
        for pane in workspace.panes.values() {
            for tab in &pane.tabs {
                if !matches!(
                    tab.kind,
                    TabKind::Terminal {
                        pty_session: None,
                        status: TerminalStatus::Running,
                        ..
                    }
                ) {
                    continue;
                }
                match spawn_block_reason(status, requested) {
                    None => plan.ready.push(tab.id),
                    Some(reason) => plan.skipped.push((tab.id, reason)),
                }
            }
        }
    }
    plan
}

/// 탭이 속한 워크스페이스의 distro — 대상이 없으면 None.
pub fn tab_distro(state: &AppState, tab: TabId) -> Option<Option<String>> {
    state.workspaces.iter().find_map(|workspace| {
        workspace
            .panes
            .values()
            .any(|pane| pane.tabs.iter().any(|candidate| candidate.id == tab))
            .then(|| workspace.distro.clone())
    })
}

/// 프로브 함수 — 글루가 `wsl.exe` 스폰을, 테스트가 가짜를 넣는다.
pub type ProbeFn = Box<dyn Fn() -> WslStatus + Send + Sync>;

/// 진단 완료 콜백 — 캐시 갱신 **뒤**에 불린다 (글루가 이 시점에 프론트로 이벤트를
/// 보내므로 리스너가 `status()` 로 되읽어도 새 값을 본다).
pub type StatusCallback = Box<dyn Fn(&WslStatus) + Send + Sync>;

/// 비동기·공유·캐시 진단기. 부팅에 한 번 [`WslHealth::start`] 로 첫 진단을 띄우고,
/// 모든 스폰 경로는 [`WslHealth::status`] 로 캐시를 읽는다. 명시적 재검사만
/// [`WslHealth::refresh`] 로 새 프로브를 돌린다 — 동시에 들어온 재검사는 하나로
/// 합쳐진다.
pub struct WslHealth {
    probe: ProbeFn,
    /// 완료 콜백 — 글루가 첫 진단 시작 전에 단다. `&self` 로 다는 이유는 순서
    /// 때문이다: 글루의 host 가 진단기를 들고, Dispatcher 가 host 를 들므로
    /// 진단기가 `Arc` 로 공유된 뒤에야 콜백이 잡을 Dispatcher 핸들이 생긴다.
    callback: Mutex<Option<StatusCallback>>,
    inner: Mutex<HealthInner>,
    completed: Condvar,
}

struct HealthInner {
    status: WslStatus,
    /// 완료된 진단 횟수 — 0 이면 첫 진단이 아직 없다.
    generation: u64,
    in_flight: bool,
}

impl WslHealth {
    /// 첫 진단 전 상태는 [`WslStatus::Probing`] 이다.
    pub fn new(probe: ProbeFn) -> Self {
        Self {
            probe,
            callback: Mutex::new(None),
            inner: Mutex::new(HealthInner {
                status: WslStatus::Probing,
                generation: 0,
                in_flight: false,
            }),
            completed: Condvar::new(),
        }
    }

    /// 완료 콜백 등록 — 첫 진단 시작 전에 부른다.
    pub fn set_callback(&self, callback: StatusCallback) {
        *self.callback.lock().unwrap() = Some(callback);
    }

    /// 캐시된 상태 (진단 전이면 Probing).
    pub fn status(&self) -> WslStatus {
        self.inner.lock().unwrap().status.clone()
    }

    /// 첫 진단을 백그라운드 스레드에서 시작한다. 이미 돌았거나 도는 중이면 no-op.
    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.in_flight || inner.generation > 0 {
                return Ok(());
            }
            inner.in_flight = true;
        }
        let health = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("mast-wsl-probe".to_owned())
            .spawn(move || health.run_probe());
        match spawned {
            Ok(_) => Ok(()),
            Err(err) => {
                // 스레드를 못 띄웠으면 표식을 되돌려 다음 refresh 가 재시도하게 한다.
                self.inner.lock().unwrap().in_flight = false;
                Err(format!("cannot start the WSL diagnosis thread: {err}"))
            }
        }
    }

    /// 첫 진단이 끝날 때까지 (상한 안에서) 기다린 뒤 현재 상태를 돌려준다.
    /// 상한을 넘기면 `Probing` 그대로다 — 호출자는 "아직 모른다"로 취급해야 한다.
    pub fn wait_for_first(&self, timeout: Duration) -> WslStatus {
        let mut inner = self.inner.lock().unwrap();
        let deadline = Instant::now() + timeout;
        while inner.generation == 0 && inner.in_flight {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let (guard, _) = self.completed.wait_timeout(inner, left).unwrap();
            inner = guard;
        }
        inner.status.clone()
    }

    /// 명시적 재검사. 도는 진단이 있으면 **그 결과를 기다린다** (동시 요청이
    /// `wsl.exe` 를 두 번 띄우지 않는다). `timeout` 안에 완료가 안 보이면 None.
    pub fn refresh(self: &Arc<Self>, timeout: Duration) -> Option<WslStatus> {
        let observed = {
            let mut inner = self.inner.lock().unwrap();
            let generation = inner.generation;
            if !inner.in_flight {
                inner.in_flight = true;
                let health = Arc::clone(self);
                if std::thread::Builder::new()
                    .name("mast-wsl-recheck".into())
                    .spawn(move || health.run_probe())
                    .is_err()
                {
                    inner.in_flight = false;
                    return None;
                }
            }
            generation
        };
        let mut inner = self.inner.lock().unwrap();
        let deadline = Instant::now() + timeout;
        while inner.in_flight && inner.generation == observed {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                // 마감과 완료가 겹친 경우 — 진단이 실제로 끝났으면 결과를 돌려준다.
                if inner.generation != observed || !inner.in_flight {
                    break;
                }
                return None;
            }
            let (guard, _) = self.completed.wait_timeout(inner, left).unwrap();
            inner = guard;
        }
        Some(inner.status.clone())
    }

    /// 프로브 1회 실행 → 캐시 갱신 → 대기자 통지 → 콜백. 콜백은 **락 밖**에서
    /// 부른다 — 콜백이 상태를 다시 읽거나(글루의 이벤트 발신) 다른 락을 잡아도
    /// 진단기 락과 엮이지 않게 하기 위해서다.
    fn run_probe(&self) {
        let status = (self.probe)();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.status = status.clone();
            inner.generation += 1;
            inner.in_flight = false;
        }
        self.completed.notify_all();
        // 콜백 락은 호출 동안만 잡는다 — 콜백이 다른 락(글루의 Dispatcher)을 잡아도
        // 진단기 락과 엮이지 않는다. 콜백 등록은 첫 진단 전 한 번뿐이라 경합이 없다.
        if let Some(callback) = self.callback.lock().unwrap().as_ref() {
            callback(&status);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::model::{
        AgentStatus, NotificationState, Pane, PaneId, SplitTree, Tab, Workspace, WorkspaceId,
    };
    use crate::record::RecordStore;

    fn utf16le(lines: &[&str]) -> Vec<u8> {
        let text = lines.join("\r\n");
        let mut bytes = vec![0xFF, 0xFE]; // BOM
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    fn exited(code: u32, stdout: &[u8], stderr: &str) -> ProbeResult {
        ProbeResult {
            outcome: ProbeOutcome::Exited { code: Some(code) },
            stdout: stdout.to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    fn ready(distros: &[&str]) -> WslStatus {
        WslStatus::Ready {
            distros: distros.iter().map(|d| (*d).to_owned()).collect(),
            failures: Vec::new(),
            checked: distros.iter().map(|d| (*d).to_owned()).collect(),
        }
    }

    #[test]
    fn refresh_deadline_bounds_the_request_that_starts_the_probe() {
        let health = Arc::new(WslHealth::new(Box::new(|| {
            std::thread::sleep(Duration::from_millis(150));
            ready(&["Ubuntu"])
        })));
        assert_eq!(health.refresh(Duration::from_millis(10)), None);
        assert_eq!(
            health.wait_for_first(Duration::from_secs(2)),
            ready(&["Ubuntu"])
        );
    }

    #[test]
    fn listed_but_broken_distro_is_blocked_without_blocking_healthy_distro() {
        let status = WslStatus::Ready {
            distros: vec!["Broken".into(), "Ubuntu".into()],
            failures: vec![DistroFailure {
                distro: "Broken".into(),
                detail: "kernel failed".into(),
                code: Some(1),
                timed_out: false,
            }],
            checked: vec!["Broken".into(), "Ubuntu".into()],
        };
        assert!(spawn_block_reason(&status, None).is_some());
        assert!(spawn_block_reason(&status, Some("broken")).is_some());
        assert!(spawn_block_reason(&status, Some("ubuntu")).is_none());
    }

    #[test]
    fn distro_list_decodes_utf16le_with_bom_case_and_blank_lines() {
        let bytes = utf16le(&["Ubuntu", "", "Debian Preview"]);
        assert_eq!(parse_distro_list(&bytes), vec!["Ubuntu", "Debian Preview"]);
        // UTF-8 폴백과 홀수 길이(짝이 안 맞는 마지막 바이트)도 죽지 않는다.
        assert_eq!(parse_distro_list(b"Ubuntu\n"), vec!["Ubuntu"]);
        assert!(parse_distro_list(&[0xFF, 0xFE, 0x41]).is_empty());
        assert!(parse_distro_list(b"").is_empty());
    }

    #[test]
    fn a_successful_listing_classifies_by_emptiness() {
        let empty = classify(exited(0, b"", ""));
        assert_eq!(
            empty,
            WslStatus::NoDistro {
                code: Some(0),
                detail: String::new()
            }
        );
        let listed = classify(ProbeResult {
            outcome: ProbeOutcome::Exited { code: Some(0) },
            stdout: utf16le(&["Ubuntu", "Debian"]),
            stderr: Vec::new(),
        });
        assert!(
            matches!(listed, WslStatus::Ready { distros, checked, .. } if distros.len() == 2 && checked.is_empty())
        );
    }

    #[test]
    fn the_no_distro_exit_code_is_read_back_even_though_it_is_negative_as_i32() {
        // `ExitStatus::code()` 는 u32 원값을 i32 로 되돌려준다 (0xFFFFFFFF → -1).
        // 프로브는 그 값을 다시 u32 로 복원하므로 여기서도 그 형태로 넣는다.
        let result = classify(exited(
            NO_DISTRO_CODE,
            b"",
            "Windows Subsystem for Linux has no installed distributions.",
        ));
        match result {
            WslStatus::NoDistro { code, detail } => {
                assert_eq!(code, Some(NO_DISTRO_CODE));
                assert!(detail.contains("no installed distributions"), "{detail}");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn a_disabled_component_is_not_installed_and_a_kernel_error_is_a_failure() {
        assert!(matches!(
            classify(exited(COMPONENT_REQUIRED_CODE, b"", "not enabled")),
            WslStatus::NotInstalled {
                code: Some(COMPONENT_REQUIRED_CODE),
                ..
            }
        ));
        assert!(matches!(
            classify(exited(0x8007_01BC, b"", "kernel missing")),
            WslStatus::Failed {
                code: Some(0x8007_01BC),
                ..
            }
        ));
        // 낮은 코드의 실패도 같은 Failed 로 분류된다.
        assert!(matches!(
            classify(exited(1, b"", "")),
            WslStatus::Failed { code: Some(1), .. }
        ));
    }

    #[test]
    fn a_missing_program_and_a_stuck_query_have_their_own_states() {
        assert!(matches!(
            classify(ProbeResult {
                outcome: ProbeOutcome::NotRunnable {
                    not_found: true,
                    detail: "cannot spawn capture command: not found".to_owned(),
                },
                stdout: Vec::new(),
                stderr: Vec::new(),
            }),
            WslStatus::NotInstalled { code: None, .. }
        ));
        assert!(matches!(
            classify(ProbeResult {
                outcome: ProbeOutcome::NotRunnable {
                    not_found: false,
                    detail: "access denied".to_owned(),
                },
                stdout: Vec::new(),
                stderr: Vec::new(),
            }),
            WslStatus::Failed { code: None, .. }
        ));
        assert!(matches!(
            classify(ProbeResult {
                outcome: ProbeOutcome::TimedOut,
                stdout: Vec::new(),
                stderr: Vec::new(),
            }),
            WslStatus::TimedOut { .. }
        ));
    }

    #[test]
    fn the_gate_requires_a_listed_distro_and_explains_every_refusal() {
        assert_eq!(
            spawn_block_reason(&ready(&["Ubuntu"]), Some("Ubuntu")),
            None
        );
        assert_eq!(spawn_block_reason(&ready(&["Ubuntu"]), None), None);
        assert_eq!(
            spawn_block_reason(&WslStatus::NotApplicable, Some("X")),
            None
        );
        let missing = spawn_block_reason(&ready(&["Ubuntu"]), Some("Debian")).unwrap();
        assert!(
            missing.contains("Debian") && missing.contains("Ubuntu"),
            "{missing}"
        );
        for status in [
            WslStatus::Probing,
            WslStatus::NotInstalled {
                code: Some(COMPONENT_REQUIRED_CODE),
                detail: "not enabled".to_owned(),
            },
            WslStatus::NoDistro {
                code: Some(NO_DISTRO_CODE),
                detail: String::new(),
            },
            WslStatus::Failed {
                code: Some(1),
                detail: "boom".to_owned(),
            },
            WslStatus::TimedOut {
                detail: String::new(),
            },
        ] {
            assert!(!status.permits_spawns(), "{status:?}");
            let reason = spawn_block_reason(&status, None)
                .unwrap_or_else(|| panic!("{status:?} must block a spawn"));
            assert!(!reason.is_empty());
        }
        // WSL 자체는 되지만 일부 distro 만 없는 경우 — 웨이브 전체를 멈추지 않는다.
        assert!(ready(&["Ubuntu"]).permits_spawns());
        assert!(WslStatus::NotApplicable.permits_spawns());
    }

    #[test]
    fn missing_distros_only_reports_unlisted_names() {
        let status = ready(&["Ubuntu"]);
        let resolved = vec![Some("Ubuntu".to_owned()), Some("Debian".to_owned()), None];
        assert_eq!(missing_distros(&resolved, &status), vec!["Debian"]);
        // 중복은 한 번만, Ready 가 아니면 빈 목록.
        let resolved = vec![Some("Debian".to_owned()), Some("Debian".to_owned())];
        assert_eq!(missing_distros(&resolved, &status), vec!["Debian"]);
        assert!(missing_distros(&resolved, &WslStatus::Probing).is_empty());
    }

    fn terminal_tab(id: u64, status: TerminalStatus) -> Tab {
        Tab {
            id: TabId(id),
            title: "Terminal".to_owned(),
            kind: TabKind::Terminal {
                pty_session: None,
                status,
                cwd: Some("/home/me".to_owned()),
            },
            notification: NotificationState::None,
            last_activity_ms: None,
            agent_status: AgentStatus::Idle,
            last_agent_message: None,
            last_agent_message_seq: None,
            agent_session: None,
        }
    }

    fn workspace(id: u64, pane: u64, distro: Option<&str>, tab: Tab) -> Workspace {
        let pane_id = PaneId(pane);
        Workspace {
            id: WorkspaceId(id),
            name: format!("ws{id}"),
            root_path: None,
            distro: distro.map(str::to_owned),
            git_branch: None,
            git_dirty: None,
            manager: false,
            layout: SplitTree::Leaf { pane: pane_id },
            panes: BTreeMap::from([(
                pane_id,
                Pane {
                    id: pane_id,
                    tabs: vec![tab],
                    active_tab: Some(TabId(pane)),
                },
            )]),
            active_pane: pane_id,
            agent_status: AgentStatus::Idle,
            last_agent_message: None,
        }
    }

    fn app_state(workspaces: Vec<Workspace>) -> AppState {
        AppState {
            workspaces,
            active_workspace: None,
            next_id: 100,
            revision: 0,
        }
    }

    #[test]
    fn respawn_plan_splits_by_distro_and_leaves_state_untouched() {
        let state = app_state(vec![
            workspace(
                1,
                11,
                Some("Ubuntu"),
                terminal_tab(11, TerminalStatus::Running),
            ),
            workspace(
                2,
                22,
                Some("Debian"),
                terminal_tab(22, TerminalStatus::Running),
            ),
            workspace(3, 33, None, terminal_tab(33, TerminalStatus::Running)),
        ]);
        let before = state.clone();
        let plan = respawn_plan(&state, &ready(&["Ubuntu"]), None);
        // 기본 배포판(None) 탭은 Ready 면 살아난다 — 첫 항목이 기본 배포판이다.
        assert_eq!(plan.ready, vec![TabId(11), TabId(33)]);
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].0, TabId(22));
        assert!(plan.skipped[0].1.contains("Debian"), "{:?}", plan.skipped);
        assert_eq!(state, before, "계획 계산은 상태를 바꾸지 않는다");
    }

    #[test]
    fn respawn_plan_applies_the_fallback_distro_only_without_a_workspace_distro() {
        let state = app_state(vec![
            workspace(1, 11, None, terminal_tab(11, TerminalStatus::Running)),
            workspace(
                2,
                22,
                Some("Ubuntu"),
                terminal_tab(22, TerminalStatus::Running),
            ),
        ]);
        // MAST_DISTRO 가 목록에 없으면 그 fallback 을 쓰는 탭만 건너뛴다.
        let plan = respawn_plan(&state, &ready(&["Ubuntu"]), Some("Fedora"));
        assert_eq!(plan.ready, vec![TabId(22)]);
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].0, TabId(11));
        // 워크스페이스 distro 가 있으면 fallback 은 무시된다 (스폰 해석 순서).
        let plan = respawn_plan(&state, &ready(&["Ubuntu"]), Some("Ubuntu"));
        assert_eq!(plan.ready, vec![TabId(11), TabId(22)]);
    }

    #[test]
    fn respawn_plan_defers_everything_when_wsl_is_unavailable() {
        let state = app_state(vec![
            workspace(
                1,
                11,
                Some("Ubuntu"),
                terminal_tab(11, TerminalStatus::Running),
            ),
            workspace(2, 22, None, terminal_tab(22, TerminalStatus::Running)),
        ]);
        for status in [
            WslStatus::Probing,
            WslStatus::NotInstalled {
                code: None,
                detail: String::new(),
            },
            WslStatus::NoDistro {
                code: Some(0),
                detail: String::new(),
            },
            WslStatus::TimedOut {
                detail: String::new(),
            },
        ] {
            let plan = respawn_plan(&state, &status, None);
            assert!(plan.ready.is_empty(), "{status:?}");
            assert_eq!(plan.skipped.len(), 2, "{status:?}");
        }
    }

    #[test]
    fn respawn_plan_skips_tabs_that_already_have_a_session_or_other_states() {
        let mut running = terminal_tab(11, TerminalStatus::Running);
        let mut exited = terminal_tab(
            12,
            TerminalStatus::Exited {
                code: None,
                ended_at_ms: None,
            },
        );
        let mut not_started = terminal_tab(13, TerminalStatus::NotStarted);
        for tab in [&mut running, &mut exited, &mut not_started] {
            // 세션 id 를 채워 둔 탭은 재스폰 대상이 아니다 (살아 있다).
            if let TabKind::Terminal { pty_session, .. } = &mut tab.kind {
                *pty_session = Some(9);
            }
        }
        let state = app_state(vec![workspace(1, 11, Some("Ubuntu"), running)]);
        let plan = respawn_plan(&state, &ready(&["Ubuntu"]), None);
        assert!(plan.ready.is_empty() && plan.skipped.is_empty());

        // Exited·NotStarted 는 자동 복원 대상이 아니다 (사용자 Restart 대기).
        let state = app_state(vec![workspace(
            1,
            11,
            Some("Ubuntu"),
            terminal_tab(11, TerminalStatus::NotStarted),
        )]);
        let plan = respawn_plan(&state, &ready(&["Ubuntu"]), None);
        assert!(plan.ready.is_empty() && plan.skipped.is_empty());
    }

    #[test]
    fn tabs_skipped_by_the_plan_keep_their_last_screen_record() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let records = RecordStore::new(directory.path().join("records"));
        records
            .write(TabId(22), b"last screen")
            .expect("record write");

        let state = app_state(vec![
            workspace(
                1,
                11,
                Some("Ubuntu"),
                terminal_tab(11, TerminalStatus::Running),
            ),
            workspace(
                2,
                22,
                Some("Debian"),
                terminal_tab(22, TerminalStatus::Running),
            ),
        ]);
        let plan = respawn_plan(&state, &ready(&["Ubuntu"]), None);
        assert_eq!(plan.ready, vec![TabId(11)]);
        assert_eq!(plan.skipped.len(), 1);
        // 건너뛴 탭의 기록은 그대로다 — 계획 경로는 기록을 지우지 않는다.
        assert_eq!(
            records.read(TabId(22)).expect("record read").as_deref(),
            Some(&b"last screen"[..])
        );
    }

    #[test]
    fn tab_distro_finds_the_owning_workspace_or_nothing() {
        let state = app_state(vec![
            workspace(
                1,
                11,
                Some("Ubuntu"),
                terminal_tab(11, TerminalStatus::Running),
            ),
            workspace(2, 22, None, terminal_tab(22, TerminalStatus::Running)),
        ]);
        assert_eq!(
            tab_distro(&state, TabId(11)),
            Some(Some("Ubuntu".to_owned()))
        );
        assert_eq!(tab_distro(&state, TabId(22)), Some(None));
        assert_eq!(tab_distro(&state, TabId(99)), None);
    }

    #[cfg(unix)]
    #[test]
    fn probe_reports_exit_code_and_streams() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "printf 'Ubuntu\\nDebian\\n'; printf 'warn' >&2; exit 3",
        ]);
        let result = probe(&mut command, Duration::from_secs(2));
        assert_eq!(result.outcome, ProbeOutcome::Exited { code: Some(3) });
        assert_eq!(parse_distro_list(&result.stdout), vec!["Ubuntu", "Debian"]);
        assert_eq!(decode_output(&result.stderr), "warn");
    }

    #[cfg(unix)]
    #[test]
    fn probe_reports_a_missing_program_without_pretending_it_ran() {
        let mut command = Command::new("/nonexistent/mast-probe-program");
        let result = probe(&mut command, Duration::from_secs(2));
        match &result.outcome {
            ProbeOutcome::NotRunnable { not_found, detail } => {
                assert!(not_found, "{detail}");
            }
            other => panic!("unexpected: {other:?}"),
        }
        assert!(matches!(classify(result), WslStatus::NotInstalled { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn probe_timeout_stops_and_reaps_the_child() {
        let started = Instant::now();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        let result = probe(&mut command, Duration::from_millis(150));
        assert_eq!(result.outcome, ProbeOutcome::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "the probe must not wait for the child: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn health_caches_the_first_result_and_only_recheck_runs_again() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let health = Arc::new(WslHealth::new(Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            ready(&["Ubuntu"])
        })));
        // start 전에는 Probing 이고, 첫 진단을 기다려도 그대로다.
        assert_eq!(health.status(), WslStatus::Probing);
        assert_eq!(
            health.wait_for_first(Duration::from_millis(20)),
            WslStatus::Probing
        );

        assert_eq!(
            health.refresh(Duration::from_secs(2)),
            Some(ready(&["Ubuntu"]))
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // 캐시는 다시 읽어도 프로브를 늘리지 않는다 — 배포판 조회가 스폰마다
        // wsl.exe 를 띄우면 안 된다.
        assert_eq!(health.status(), ready(&["Ubuntu"]));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // 명시적 재검사만 새 프로브다.
        assert_eq!(
            health.refresh(Duration::from_secs(2)),
            Some(ready(&["Ubuntu"]))
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_refreshes_share_one_probe() {
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let health = Arc::new(WslHealth::new(Box::new({
            let calls = Arc::clone(&calls);
            let gate = Arc::clone(&gate);
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                // 두 번째 요청자가 in_flight 를 보게 될 때까지 프로브를 붙잡는다.
                let (lock, completed) = &*gate;
                let mut open = lock.lock().unwrap();
                while !*open {
                    open = completed
                        .wait_timeout(open, Duration::from_secs(3))
                        .unwrap()
                        .0;
                }
                ready(&["Ubuntu"])
            }
        })));

        let first = {
            let health = Arc::clone(&health);
            std::thread::spawn(move || health.refresh(Duration::from_secs(5)))
        };
        while calls.load(Ordering::SeqCst) == 0 {
            std::thread::sleep(Duration::from_millis(5));
        }
        let second = {
            let health = Arc::clone(&health);
            std::thread::spawn(move || health.refresh(Duration::from_secs(5)))
        };
        std::thread::sleep(Duration::from_millis(50));
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();

        let first = first.join().unwrap();
        let second = second.join().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "재검사 요청이 합쳐져야 한다"
        );
        assert_eq!(first, Some(ready(&["Ubuntu"])));
        assert_eq!(second, first);
    }

    #[test]
    fn a_completed_probe_notifies_waiters_and_fires_the_callback_once() {
        let (sender, seen) = std::sync::mpsc::channel();
        let sender = Mutex::new(sender);
        let health = WslHealth::new(Box::new(|| ready(&["Ubuntu"])));
        health.set_callback(Box::new(move |status| {
            let _ = sender.lock().unwrap().send(status.clone());
        }));
        let health = Arc::new(health);

        health.start().expect("diagnosis thread starts");
        assert_eq!(
            health.wait_for_first(Duration::from_secs(3)),
            ready(&["Ubuntu"])
        );
        // 대기자를 먼저 깨우고 콜백을 부르므로(run_probe) 콜백 도착은 따로 기다린다.
        assert_eq!(
            seen.recv_timeout(Duration::from_secs(3)),
            Ok(ready(&["Ubuntu"]))
        );
        assert!(seen.try_recv().is_err(), "콜백은 완료마다 한 번");
    }
}
