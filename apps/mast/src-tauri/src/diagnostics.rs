//! 장시간 켜 둔 세션의 자원 그림 (ADR-0018).
//!
//! 경고가 떴을 때 붙잡을 수치가 하나도 없다는 것이 이 모듈이 생긴 이유다 — 프로세스
//! 메모리·핸들·스레드, 등록 세션과 그들이 붙잡은 replay 바이트, 상태별 탭 수, 그리고
//! 마지막 정합성 검사 결과를 한자리에 모은다.
//!
//! **주기 폴링은 없다.** 커맨드([`get_diagnostics`])는 사람이 부를 때만 돌고, 로그
//! 한 줄([`log_summary`])은 세 지점에서만 나간다: 부팅 재스폰 웨이브의 끝, 정합성
//! 검사가 무언가를 찾았을 때, 그리고 리셋 supervisor 의 메모리 임계 발화. 워치독을
//! 새로 다는 것이 아니라 이미 있는 사건에 수치를 붙이는 것이다.
//!
//! 수치는 **반응을 달지 않는다** — 백엔드 재시작은 살아 있는 PTY 와 그 안의 에이전트를
//! 죽이므로 CLAUDE.md 의 비목표다.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use mast_core::command::RegistryAudit;
use mast_core::model::{TabKind, TerminalStatus};

use crate::state::AppState;
use crate::winlog;

/// 백엔드 프로세스 자체의 OS 수치. 플랫폼에 구현이 없으면 [`Diagnostics::process`]
/// 가 통째로 None 이고, 구현은 있는데 개별 조회가 거부되면 그 필드만 None 이다 —
/// 못 잰 값을 0 으로 채우지 않는다 (리셋 워치독의 "가짜 0 샘플 금지"와 같은 규율).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetrics {
    pub private_bytes: Option<u64>,
    pub working_set_bytes: Option<u64>,
    pub handle_count: Option<u32>,
    pub thread_count: Option<u32>,
}

/// 세션 레지스트리 쪽 합계. `replay_bytes` 는 살아 있는 세션들이 지금 붙잡은 메모리의
/// 대부분이다 — 기록(ADR-0018)이 실제로 버퍼를 반납하는지 보는 수치이기도 하다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCounts {
    pub registered: usize,
    pub alive: usize,
    pub sinks: usize,
    pub replay_bytes: usize,
}

/// 모델 쪽 터미널 탭 수. 뷰어 탭은 세지 않는다 — 세션도 기록도 갖지 않는다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabCounts {
    pub running: usize,
    pub exited: usize,
    pub not_started: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub process: Option<ProcessMetrics>,
    pub sessions: SessionCounts,
    pub tabs: TabCounts,
    pub audit: RegistryAudit,
}

/// 지금의 수치를 모은다. `audit` 는 호출자가 방금 돌린 결과다 — 여기서 검사를 돌리지
/// 않는 것은 [`crate::audit::run_audit`] 이 발견 시 이 함수를 부르기 때문이다(재귀 방지).
///
/// 잠금은 **겹치지 않는다**: 레지스트리 수치(`sessions.stats()`·`sinks.ids()`)를 먼저
/// 각자의 lock 아래에서 뜨고, 그 lock 들을 다 놓은 뒤에 Dispatcher lock 을 탭 세는
/// 동안만 잡는다. 어느 쪽도 다른 쪽 안에서 잡히지 않으므로 정합성 검사의 잠금 순서
/// (Dispatcher 먼저, [`crate::audit`])와 충돌할 여지가 없다. 두 수치가 같은 순간의
/// 것이 아니라는 뜻이기도 한데, 진단은 어긋남을 **판정**하는 자리가 아니라 수치를
/// 보여 주는 자리다 — 판정은 그 검사가 한다.
pub fn collect(state: &AppState, audit: RegistryAudit) -> Diagnostics {
    let stats = state.sessions.stats();
    let sessions = SessionCounts {
        registered: stats.len(),
        alive: stats.iter().filter(|(_, s)| s.alive).count(),
        sinks: state.sinks.ids().len(),
        replay_bytes: stats.iter().map(|(_, s)| s.replay_bytes).sum(),
    };
    let tabs = {
        let dispatcher = state.dispatcher.lock().unwrap();
        count_tabs(dispatcher.state())
    };
    Diagnostics {
        process: process_metrics(),
        sessions,
        tabs,
        audit,
    }
}

fn count_tabs(model: &mast_core::model::AppState) -> TabCounts {
    let mut counts = TabCounts {
        running: 0,
        exited: 0,
        not_started: 0,
    };
    for tab in model
        .workspaces
        .iter()
        .flat_map(|ws| ws.panes.values())
        .flat_map(|pane| &pane.tabs)
    {
        // 상태 쪽은 와일드카드 없이 센다 — 새 `TerminalStatus` 변종이 생기면 세 수의
        // 합이 조용히 터미널 탭 수보다 작아지는 대신 여기서 컴파일이 깨진다.
        let TabKind::Terminal { status, .. } = &tab.kind else {
            continue;
        };
        match status {
            TerminalStatus::Running => counts.running += 1,
            TerminalStatus::Exited { .. } => counts.exited += 1,
            TerminalStatus::NotStarted => counts.not_started += 1,
        }
    }
    counts
}

/// `diag:` 한 줄 — 한 줄인 것이 계약이다. 사고 뒤에 `mast.log` 를 grep 하는 사람이
/// 시점별 수치를 바로 세로로 읽을 수 있어야 한다.
pub fn log_summary(state: &AppState, audit: &RegistryAudit, context: &str) {
    log_line(&collect(state, audit.clone()), context);
}

/// 이미 뜬 스냅샷으로 같은 줄을 찍는다 — 스냅샷을 스스로 만드는 호출자
/// ([`get_diagnostics`])가 [`collect`] 를 두 번 돌지 않게 갈라 둔 반쪽이다.
pub fn log_line(d: &Diagnostics, context: &str) {
    let (private, working, handles, threads) = match &d.process {
        Some(p) => (
            opt(p.private_bytes),
            opt(p.working_set_bytes),
            opt(p.handle_count),
            opt(p.thread_count),
        ),
        None => ("n/a".into(), "n/a".into(), "n/a".into(), "n/a".into()),
    };
    winlog!(
        "diag: {context} private={private} working_set={working} handles={handles} \
         threads={threads} sessions={}/{} sinks={} replay_bytes={} tabs running={} exited={} \
         not_started={} audit orphan_sessions={} orphan_sinks={} dangling_tabs={}",
        d.sessions.alive,
        d.sessions.registered,
        d.sessions.sinks,
        d.sessions.replay_bytes,
        d.tabs.running,
        d.tabs.exited,
        d.tabs.not_started,
        d.audit.orphan_sessions.len(),
        d.audit.orphan_sinks.len(),
        d.audit.dangling_tabs.len(),
    );
}

fn opt<T: std::fmt::Display>(value: Option<T>) -> String {
    match value {
        Some(v) => v.to_string(),
        None => "n/a".to_string(),
    }
}

/// 진단 스냅샷 — 정합성 검사를 한 번 돌린 **뒤**의 그림이다 (검사가 고아를 지우면
/// 그 결과가 반영된 수치가 나간다).
///
/// `get_state` 선례대로 async + `spawn_blocking`: 검사가 Dispatcher lock 을 잡는데,
/// sync 커맨드로 메인 스레드에서 그 lock 을 기다리면 뒤에 줄 선 핫패스(ack_output)까지
/// 지연이 전파된다.
#[tauri::command]
pub async fn get_diagnostics(app: AppHandle) -> Result<Diagnostics, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<AppState>()
            .ok_or_else(|| "managed state unavailable".to_string())?;
        // `run_audit` 이 아니라 그 본체를 부른다 — `diag:` 줄은 아래에서 방금 뜬
        // 스냅샷으로 찍으므로, 검사가 찾은 회차에 같은 수집을 두 번 돌 이유가 없다.
        let audit = crate::audit::audit_once(&app, &state, "diagnostics");
        let d = collect(&state, audit);
        if !d.audit.is_empty() {
            log_line(&d, "diagnostics");
        }
        Ok(d)
    })
    .await
    .map_err(|err| format!("get_diagnostics task join failed: {err}"))?
}

/// Windows 프로세스 수치 — 측정은 리셋 워치독의 Toolhelp/PSAPI 헬퍼를 그대로 쓴다
/// ([`crate::reset_supervisor::mem`]). 그쪽은 WebView2 **자손**을 재고 여기는 백엔드
/// **자신**을 잰다.
#[cfg(windows)]
fn process_metrics() -> Option<ProcessMetrics> {
    use crate::reset_supervisor::mem;

    let pid = std::process::id();
    let memory = mem::memory(pid);
    Some(ProcessMetrics {
        private_bytes: memory.as_ref().map(|m| m.private_bytes),
        working_set_bytes: memory.as_ref().map(|m| m.working_set_bytes),
        handle_count: mem::handle_count(pid),
        thread_count: mem::thread_count(pid),
    })
}

/// unix 개발 실행에는 측정 구현이 없다 — 0 으로 채워 재고 있는 척하지 않고 통째로
/// 비운다 (리셋 워치독이 비Windows 에서 스스로를 끄는 것과 같은 규율).
#[cfg(not(windows))]
fn process_metrics() -> Option<ProcessMetrics> {
    None
}
