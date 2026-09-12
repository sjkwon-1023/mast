//! 상태 영속화 (15단계 계획 B-1) — `state.json` 의 load / atomic save / debounce Saver.
//!
//! # 계약
//!
//! 디스크 포맷은 [`PersistedState`] envelope (`{"version": 1, "state": {...}}`,
//! camelCase — model.rs 직렬화 계약과 동일). 로드는 실패해도 앱을 죽이지 않는다 —
//! 손상·미지원 버전은 원본을 `state.json.corrupt-<unix epoch초>` 로 rename 백업한 뒤
//! [`LoadOutcome::Fresh`] 로 강등한다 (가짜 복구 금지: 원인은 [`FreshReason`] 에
//! 그대로 실어 호출자와 stderr 양쪽에 드러낸다).
//!
//! # 복원 시 sanitize
//!
//! - **전 terminal 탭의 `pty_session` 을 무조건 `None` 으로 소거한다.** PTY 의
//!   [`SessionId`](crate::session::SessionId) 는 프로세스 수명의 휘발성 u32 라,
//!   저장된 구 id 를 남겨두면 재시작 후 새 레지스트리가 발급한 동일 숫자의 다른
//!   세션과 충돌(오배선)한다. 재스폰 시 새 id 가 다시 채워진다 (B-2).
//! - **에이전트 상태·알림도 pty_session 소거와 동급으로 무조건 초기화한다**
//!   (18단계 계획, 터미널-계획-v2.md 11장): 각 워크스페이스의 `agent_status` =
//!   `Idle`, `agent_status_source` = `None`, `last_agent_message` = `None`,
//!   전 탭의 `notification` = `NotificationState::None`, `last_activity_ms` =
//!   `None`. pty_session 과 동일한 이유 — 죽은 세션이 남긴 needsInput 이
//!   재시작을 넘어 사이드바에 유령처럼 남는 걸 막는다.
//! - **`NotStarted` 탭만 `Running` 으로 되돌린다**. 그 상태로 저장되면 부팅 재스폰 열거
//!   ([`Dispatcher::running_terminal_tabs`](crate::command::Dispatcher::running_terminal_tabs))
//!   에서 빠져 사용자가 탭마다 Retry 를 눌러야 한다 — 실기에서 되살린 탭 11개가 콜드 VM
//!   에 몰려 6개가 시작 표식을 못 낸 채 남은 상태다 (2026-08-20).
//! - **`Exited` 는 그대로 둔다** (ADR-0018 D3, ADR-0010 의 되돌림을 반쪽 뒤집는다).
//!   끝난 탭의 마지막 화면은 기록 파일로 남아 있어 복원 후에도 그대로 읽히고, 되살릴
//!   길은 pane 배너의 Restart 다 — ADR-0010 의 되돌림은 그 버튼이 없던 시절 "되살릴
//!   길이 아예 없다"를 푸는 장치였다. 되돌리면 사용자가 의도적으로 끝낸 셸까지 앱을
//!   켤 때마다 되살아난다.
//! - `next_id` 가 사용 중인 최대 안정 id(워크스페이스·pane·탭·**split** 포함 —
//!   split 노드도 같은 단일 카운터 발급, ADR-0003) 이하면 `max+1` 로 수리하고
//!   사유를 [`LoadOutcome::Restored`] 의 `repairs` 로 보고한다.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::model::{AgentStatus, AppState, NotificationState, TabKind, TerminalStatus};

/// 현재 디스크 포맷 버전. 다른 값은 [`FreshReason::UnsupportedVersion`] 으로 강등.
pub const PERSIST_VERSION: u32 = 1;

/// `state.json` 의 디스크 envelope. 상태 본문과 포맷 버전을 함께 싣는다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub version: u32,
    pub state: AppState,
}

/// [`load`] 의 결과.
#[derive(Debug)]
pub enum LoadOutcome {
    /// 복원 성공. `repairs` 는 sanitize 가 수행한 수리 사유들 (없으면 빈 벡터) —
    /// 호출자가 로그로 남길 수 있게 데이터로 반환한다.
    Restored {
        state: AppState,
        repairs: Vec<String>,
    },
    /// 새로 시작해야 한다. 사유는 [`FreshReason`] 참조.
    Fresh(FreshReason),
}

/// [`LoadOutcome::Fresh`] 의 사유. `backup` 은 원본 rename 백업의 결과 —
/// rename 실패 시에도 Fresh 진행은 유지하되 실패 원인을 `Err` 로 실어 보낸다
/// (에러 삼키기 금지).
#[derive(Debug)]
pub enum FreshReason {
    /// 파일이 없다 — 첫 실행. 백업할 것도 없다.
    NoFile,
    /// 읽기/파싱/구조 검증 실패. `error` 는 진단용 원인 문자열.
    Corrupt {
        backup: Result<PathBuf, String>,
        error: String,
    },
    /// envelope 버전이 [`PERSIST_VERSION`] 과 다르다.
    UnsupportedVersion {
        found: u64,
        backup: Result<PathBuf, String>,
    },
}

/// `path` 에서 상태를 읽어 복원한다. 어떤 실패에도 panic 하지 않고
/// [`LoadOutcome::Fresh`] 로 강등하며, 손상 원본은 백업 rename 으로 보존한다.
///
/// 단계: 읽기 → JSON 파싱 → 버전 확인 → 역직렬화 → 구조 검증
/// ([`Workspace::validate`](crate::model::Workspace::validate) + `active_workspace`
/// 존재 확인) → sanitize (모듈 rustdoc 참조). 구조 검증 실패는 손상(Corrupt)으로
/// 취급한다.
pub fn load(path: &Path) -> LoadOutcome {
    sweep_stale_tmp(path);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return LoadOutcome::Fresh(FreshReason::NoFile);
        }
        // NotFound 외의 읽기 실패(권한 등)도 손상 취급 — 조용히 새 상태로 덮어쓰기
        // 전에 원본을 백업으로 치워 둔다.
        Err(err) => return fresh_corrupt(path, format!("read failed: {err}")),
    };
    // 버전을 먼저 보기 위해 Value 로 파싱한다 — 미래 버전의 state 본문은 현재
    // 스키마로 역직렬화되지 않을 수 있어, 역직렬화 실패(Corrupt)와 버전 불일치
    // (UnsupportedVersion)를 구분하려면 이 순서여야 한다.
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(err) => return fresh_corrupt(path, format!("JSON parse failed: {err}")),
    };
    match value.get("version").and_then(|v| v.as_u64()) {
        None => return fresh_corrupt(path, "missing or non-numeric `version` field".into()),
        Some(found) if found != u64::from(PERSIST_VERSION) => {
            let backup = backup_corrupt(path);
            eprintln!(
                "[mast] persist: unsupported state version {found} (expected {PERSIST_VERSION}) — starting fresh"
            );
            return LoadOutcome::Fresh(FreshReason::UnsupportedVersion { found, backup });
        }
        Some(_) => {}
    }
    let persisted: PersistedState = match serde_json::from_value(value) {
        Ok(persisted) => persisted,
        Err(err) => return fresh_corrupt(path, format!("deserialize failed: {err}")),
    };
    let mut state = persisted.state;
    if let Err(err) = validate_app(&state) {
        return fresh_corrupt(path, format!("invariant violation: {err}"));
    }
    let repairs = sanitize(&mut state);
    LoadOutcome::Restored { state, repairs }
}

/// 손상 처리 공통 경로: loud stderr + 백업 rename + `Fresh(Corrupt)`.
fn fresh_corrupt(path: &Path, error: String) -> LoadOutcome {
    let backup = backup_corrupt(path);
    eprintln!(
        "[mast] persist: state file corrupt ({}): {error} — starting fresh",
        path.display()
    );
    LoadOutcome::Fresh(FreshReason::Corrupt { backup, error })
}

/// 원본을 `<파일명>.corrupt-<unix epoch초>` 로 rename 백업한다. 실패해도 호출측은
/// Fresh 로 진행한다 — 실패 원인은 `Err(String)` 으로 보고하고 stderr 에도 남긴다.
fn backup_corrupt(path: &Path) -> Result<PathBuf, String> {
    let epoch_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut name = path
        .file_name()
        .map(OsString::from)
        .unwrap_or_else(|| OsString::from("state.json"));
    name.push(format!(".corrupt-{epoch_secs}"));
    let backup = path.with_file_name(name);
    match fs::rename(path, &backup) {
        Ok(()) => Ok(backup),
        Err(err) => {
            let msg = format!(
                "backup rename failed ({} -> {}): {err}",
                path.display(),
                backup.display()
            );
            eprintln!("[mast] persist: {msg}");
            Err(msg)
        }
    }
}

/// 이전 크래시 런이 남긴 stale tmp(`<파일명>.tmp-<다른 pid>`)를 best-effort 로
/// 청소한다 — pid 가 런마다 달라 저절로 누적되기 때문 (리뷰 finding). 삭제 실패는
/// 무시한다 (진단 증거보다 누적 방지가 목적이고, 다음 부팅이 재시도한다).
/// 동시 실행 중인 다른 인스턴스가 쓰는 중인 tmp 를 지울 수도 있다 — 그쪽 rename
/// 이 loud 실패 후 다음 저장에서 자연 재시도되므로 무해 (두 인스턴스 동시 실행은
/// MVP 수용 — 계획 0장).
fn sweep_stale_tmp(path: &Path) {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
    else {
        return;
    };
    let prefix = format!("{name}.tmp-");
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let entry_name = entry.file_name();
        if entry_name.to_str().is_some_and(|n| n.starts_with(&prefix)) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// 앱 수준 구조 검증 — 각 워크스페이스의 불변식 + `active_workspace` 존재 +
/// **안정 id 전역 유일성**. id 는 단일 카운터 발급이라 종류 불문 전역에서 겹칠 수
/// 없다 — 디스크는 신뢰 경계(수기 편집·손상)이므로 중복을 통과시키면 by-id
/// dispatch 의 표적(`locate_*` 첫 매치)이 모호해진다 (14~15 리뷰 finding).
fn validate_app(state: &AppState) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut claim = |id: u64, what: &str| -> Result<(), String> {
        if !seen.insert(id) {
            return Err(format!("stable id {id} 가 전역에서 중복 ({what})"));
        }
        Ok(())
    };
    for ws in &state.workspaces {
        claim(ws.id.0, "workspace")?;
        for split_id in ws.layout.split_ids() {
            claim(split_id.0, "split")?;
        }
        for (pane_id, pane) in &ws.panes {
            claim(pane_id.0, "pane")?;
            for tab in &pane.tabs {
                claim(tab.id.0, "tab")?;
            }
        }
    }
    for ws in &state.workspaces {
        ws.validate()?;
    }
    if let Some(active) = state.active_workspace {
        if state.workspace(active).is_none() {
            return Err(format!("active_workspace {active:?} 가 workspaces 에 없음"));
        }
    }
    Ok(())
}

/// 복원 상태 sanitize (모듈 rustdoc 참조). 수리 사유들을 반환한다 — pty_session
/// 소거·`NotStarted` → `Running` 되돌림·에이전트 상태/알림 초기화는 무조건 수행되는
/// 정상 동작이라 사유에 포함하지 않는다.
fn sanitize(state: &mut AppState) -> Vec<String> {
    let mut repairs = Vec::new();
    for ws in &mut state.workspaces {
        ws.agent_status = AgentStatus::Idle;
        ws.agent_status_source = None;
        ws.last_agent_message = None;
        for pane in ws.panes.values_mut() {
            for tab in &mut pane.tabs {
                if let TabKind::Terminal {
                    pty_session,
                    status,
                    ..
                } = &mut tab.kind
                {
                    *pty_session = None;
                    // 모듈 rustdoc "복원 시 sanitize" — NotStarted 만 되돌린다.
                    if matches!(status, TerminalStatus::NotStarted) {
                        *status = TerminalStatus::Running;
                    }
                }
                tab.notification = NotificationState::None;
                tab.last_activity_ms = None;
            }
        }
    }
    let max_id = max_used_id(state);
    if state.next_id <= max_id {
        repairs.push(format!(
            "next_id {} <= max used stable id {max_id} — repaired to {}",
            state.next_id,
            max_id + 1
        ));
        state.next_id = max_id + 1;
    }
    repairs
}

/// 사용 중인 안정 id 의 최댓값 — 워크스페이스·pane·탭·split 전부 (단일 카운터 발급).
fn max_used_id(state: &AppState) -> u64 {
    let mut max_id = 0u64;
    for ws in &state.workspaces {
        max_id = max_id.max(ws.id.0);
        for split_id in ws.layout.split_ids() {
            max_id = max_id.max(split_id.0);
        }
        for (pane_id, pane) in &ws.panes {
            max_id = max_id.max(pane_id.0);
            for tab in &pane.tabs {
                max_id = max_id.max(tab.id.0);
            }
        }
    }
    max_id
}

/// `state` 를 `path` 에 원자적으로 저장한다: **같은 디렉터리**의
/// `<파일명>.tmp-<pid>` 에 전체를 쓰고 fsync 한 뒤 rename 으로 교체한다.
///
/// tmp 를 같은 디렉터리에 두는 이유: Windows 의 rename 원자성(기존 파일 교체 포함)
/// 은 **동일 볼륨** 전제라, 시스템 temp 디렉터리를 쓰면 볼륨 경계를 넘는 복사로
/// 강등되어 부분 쓰기가 관측될 수 있다. 부모 디렉터리가 없으면 만든다. 실패 시
/// tmp 파일은 진단 증거로 남을 수 있다 — 같은 프로세스 안에서는 파일명이 pid 로
/// 고정이라 누적되지 않지만, **크래시 런마다 pid 가 달라 stale tmp 가 쌓일 수
/// 있으므로** 다음 부팅의 [`load`] 가 best-effort 로 청소한다 (리뷰 finding).
pub fn save_atomic(path: &Path, state: &AppState) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    // 소유권 이동 없이 직렬화하기 위한 참조판 envelope (디스크 형태는
    // PersistedState 와 동일 — 필드 구성이 같아야 한다).
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PersistedStateRef<'a> {
        version: u32,
        state: &'a AppState,
    }
    let json = serde_json::to_vec_pretty(&PersistedStateRef {
        version: PERSIST_VERSION,
        state,
    })?;
    let mut tmp_name = path
        .file_name()
        .map(OsString::from)
        .unwrap_or_else(|| OsString::from("state.json"));
    tmp_name.push(format!(".tmp-{}", std::process::id()));
    let tmp = path.with_file_name(tmp_name);
    let mut file = fs::File::create(&tmp)?;
    file.write_all(&json)?;
    // rename 전에 내용을 디스크로 밀어 둔다 — 크래시 시 "이름은 바뀌었는데 내용이
    // 빈 파일" 을 막는다.
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Saver worker 로 보내는 메시지.
enum SaverMsg {
    /// 최신 상태로 교체 (coalesce). Box 는 채널 페이로드 이동 비용 절감용.
    Schedule(Box<AppState>),
    /// 대기분을 즉시 기록하고 ack — [`Saver::flush`] 의 동기성 보장.
    Flush(mpsc::Sender<()>),
}

/// debounce 백그라운드 저장기. [`Saver::schedule`] 은 최신 상태만 남기고
/// (coalesce), 첫 schedule 시점부터 `debounce` 경과 후 한 번 기록한다 (trailing).
///
/// - **유실 창**: 프로세스가 크래시하면 마지막 기록 이후 debounce 창(≤ `debounce`)
///   안의 변이는 유실된다 — MVP 수용 (계획 B-1). deadline 을 첫 schedule 에
///   고정하므로 연속 변이 중에도 유실 창은 `debounce` 로 유계다.
/// - **저장 실패**: loud stderr 만 남기고 패닉하지 않는다. 별도 재시도 루프 없이
///   다음 schedule 이 자연 재시도가 된다.
/// - **종료**: [`Saver::flush`] 는 대기분을 동기적으로 기록하고, Drop 도 대기분을
///   flush 한 뒤 worker 를 join 한다.
pub struct Saver {
    /// Drop 에서 먼저 끊기 위해 Option — 끊기면 worker 가 대기분을 쓰고 종료한다.
    tx: Option<mpsc::Sender<SaverMsg>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Saver {
    /// worker 스레드를 띄운다. `path` 는 [`save_atomic`] 대상.
    pub fn spawn(path: PathBuf, debounce: Duration) -> Self {
        let (tx, rx) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("mast-saver".into())
            .spawn(move || worker_loop(&path, debounce, &rx))
            .expect("saver worker spawn failed");
        Self {
            tx: Some(tx),
            worker: Some(worker),
        }
    }

    /// 저장 예약 — 이미 대기 중이면 최신 상태로 교체된다 (coalesce).
    pub fn schedule(&self, state: AppState) {
        let Some(tx) = &self.tx else { return };
        if tx.send(SaverMsg::Schedule(Box::new(state))).is_err() {
            // worker 가 죽은 상태 — 저장이 안 되고 있음을 숨기지 않는다.
            eprintln!("[mast] persist: saver worker is gone; schedule dropped");
        }
    }

    /// 대기분을 지금 기록하고 완료까지 동기 대기한다. 대기분이 없으면 no-op ack.
    pub fn flush(&self) {
        let Some(tx) = &self.tx else { return };
        let (ack_tx, ack_rx) = mpsc::channel();
        if tx.send(SaverMsg::Flush(ack_tx)).is_err() {
            eprintln!("[mast] persist: saver worker is gone; flush dropped");
            return;
        }
        if ack_rx.recv().is_err() {
            eprintln!("[mast] persist: saver worker died before flush ack");
        }
    }
}

impl Drop for Saver {
    fn drop(&mut self) {
        // 송신단을 끊으면 worker 가 disconnect 를 보고 대기분을 flush 하고 종료한다.
        drop(self.tx.take());
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                eprintln!("[mast] persist: saver worker thread panicked");
            }
        }
    }
}

fn worker_loop(path: &Path, debounce: Duration, rx: &mpsc::Receiver<SaverMsg>) {
    let mut pending: Option<Box<AppState>> = None;
    // pending 이 Some 일 때만 유효 — pending 이 None→Some 이 되는 순간 고정된다.
    let mut deadline = Instant::now();
    loop {
        let msg = if pending.is_some() {
            let now = Instant::now();
            if now >= deadline {
                write_pending(path, &mut pending);
                continue;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(msg) => msg,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    write_pending(path, &mut pending);
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // Drop 경로 — 대기분을 마지막으로 기록하고 종료.
                    write_pending(path, &mut pending);
                    return;
                }
            }
        } else {
            match rx.recv() {
                Ok(msg) => msg,
                Err(_) => return,
            }
        };
        match msg {
            SaverMsg::Schedule(state) => {
                if pending.is_none() {
                    deadline = Instant::now() + debounce;
                }
                pending = Some(state);
            }
            SaverMsg::Flush(ack) => {
                write_pending(path, &mut pending);
                // ack 수신측(flush 호출자)이 먼저 사라진 경우는 알릴 곳이 없다 —
                // 데이터는 이미 기록됐으므로 무시해도 안전하다.
                let _ = ack.send(());
            }
        }
    }
}

/// 대기분이 있으면 기록. 실패는 loud stderr — 다음 schedule 이 자연 재시도.
fn write_pending(path: &Path, pending: &mut Option<Box<AppState>>) {
    if let Some(state) = pending.take() {
        if let Err(err) = save_atomic(path, &state) {
            eprintln!(
                "[mast] persist: state save failed ({}): {err}",
                path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        AgentStatus, NotificationState, Pane, PaneId, SplitDirection, SplitId, SplitTree, Tab,
        TabId, TerminalStatus, Workspace, WorkspaceId,
    };
    use crate::session::SessionId;

    /// terminal 탭 하나짜리 pane.
    fn pane_with_tab(pane_id: u64, tab_id: u64, pty: Option<SessionId>) -> Pane {
        Pane {
            id: PaneId(pane_id),
            tabs: vec![Tab {
                id: TabId(tab_id),
                title: format!("tab-{tab_id}"),
                kind: TabKind::Terminal {
                    pty_session: pty,
                    status: TerminalStatus::Running,
                    cwd: None,
                },
                notification: NotificationState::None,
                last_activity_ms: None,
            }],
            active_tab: Some(TabId(tab_id)),
        }
    }

    /// 워크스페이스 1개(split 포함) 샘플 — id 사용: ws 1, pane 2·3, split 4,
    /// tab 5·6 → 유효한 next_id 는 7 이상.
    fn sample_state(pty: Option<SessionId>, next_id: u64) -> AppState {
        AppState {
            workspaces: vec![Workspace {
                id: WorkspaceId(1),
                name: "ws".into(),
                root_path: None,
                distro: None,
                git_branch: None,
                git_dirty: None,
                layout: SplitTree::Split {
                    id: SplitId(4),
                    direction: SplitDirection::Horizontal,
                    ratio: 0.5,
                    first: Box::new(SplitTree::Leaf { pane: PaneId(2) }),
                    second: Box::new(SplitTree::Leaf { pane: PaneId(3) }),
                },
                panes: [
                    (PaneId(2), pane_with_tab(2, 5, pty)),
                    (PaneId(3), pane_with_tab(3, 6, pty)),
                ]
                .into(),
                active_pane: PaneId(2),
                agent_status: AgentStatus::Idle,
                last_agent_message: None,
                agent_status_source: None,
            }],
            active_workspace: Some(WorkspaceId(1)),
            next_id,
            revision: 3,
        }
    }

    fn state_path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("state.json")
    }

    /// 디스크의 corrupt 백업 파일들을 나열한다.
    fn corrupt_backups(dir: &tempfile::TempDir) -> Vec<PathBuf> {
        fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.contains(".corrupt-"))
            })
            .collect()
    }

    #[test]
    fn duplicate_stable_ids_are_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        let mut state = sample_state(None, 9);
        // 두 번째 워크스페이스가 첫 번째와 id 전부를 공유 — 전역 유일성 위반.
        let dup = state.workspaces[0].clone();
        state.workspaces.push(dup);
        save_atomic(&path, &state).unwrap();
        match load(&path) {
            LoadOutcome::Fresh(FreshReason::Corrupt { .. }) => {}
            other => panic!("전역 id 중복은 Corrupt 여야 함: {other:?}"),
        }
        assert_eq!(corrupt_backups(&dir).len(), 1);
    }

    #[test]
    fn out_of_range_ratio_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        let mut state = sample_state(None, 9);
        if let SplitTree::Split { ratio, .. } = &mut state.workspaces[0].layout {
            *ratio = 5.0;
        }
        save_atomic(&path, &state).unwrap();
        match load(&path) {
            LoadOutcome::Fresh(FreshReason::Corrupt { .. }) => {}
            other => panic!("범위 밖 ratio 는 Corrupt 여야 함: {other:?}"),
        }
    }

    #[test]
    fn load_sweeps_stale_tmp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        save_atomic(&path, &sample_state(None, 7)).unwrap();
        // 크래시 런이 남긴 다른 pid 의 stale tmp 를 흉내낸다.
        let stale = dir.path().join("state.json.tmp-99999");
        fs::write(&stale, b"partial").unwrap();
        assert!(matches!(load(&path), LoadOutcome::Restored { .. }));
        assert!(!stale.exists(), "load 가 stale tmp 를 청소해야 함");
    }

    #[test]
    fn round_trip_restores_saved_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        let state = sample_state(None, 7);
        save_atomic(&path, &state).unwrap();
        match load(&path) {
            LoadOutcome::Restored {
                state: loaded,
                repairs,
            } => {
                assert_eq!(loaded, state);
                assert!(
                    repairs.is_empty(),
                    "정상 상태에 수리 사유가 없어야 함: {repairs:?}"
                );
            }
            other => panic!("Restored 여야 함: {other:?}"),
        }
        // tmp 파일이 남지 않는다.
        assert!(!path
            .with_file_name(format!("state.json.tmp-{}", std::process::id()))
            .exists());
    }

    #[test]
    fn save_atomic_creates_missing_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/deeper/state.json");
        save_atomic(&path, &sample_state(None, 7)).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn load_missing_file_is_fresh_nofile() {
        let dir = tempfile::tempdir().unwrap();
        match load(&state_path(&dir)) {
            LoadOutcome::Fresh(FreshReason::NoFile) => {}
            other => panic!("Fresh(NoFile) 여야 함: {other:?}"),
        }
    }

    #[test]
    fn corrupt_json_backs_up_and_starts_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        fs::write(&path, b"{ this is not json").unwrap();
        match load(&path) {
            LoadOutcome::Fresh(FreshReason::Corrupt { backup, error }) => {
                let backup = backup.expect("백업 rename 은 성공해야 함");
                assert_eq!(fs::read(&backup).unwrap(), b"{ this is not json");
                assert!(error.contains("JSON parse failed"), "error: {error}");
            }
            other => panic!("Fresh(Corrupt) 여야 함: {other:?}"),
        }
        // 원본은 치워졌고 백업 하나만 남는다.
        assert!(!path.exists());
        assert_eq!(corrupt_backups(&dir).len(), 1);
    }

    #[test]
    fn unsupported_version_backs_up_and_starts_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // 유효한 v1 envelope 를 만든 뒤 버전만 2 로 조작한다.
        let mut value = serde_json::to_value(PersistedState {
            version: PERSIST_VERSION,
            state: sample_state(None, 7),
        })
        .unwrap();
        value["version"] = serde_json::json!(2);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        match load(&path) {
            LoadOutcome::Fresh(FreshReason::UnsupportedVersion { found, backup }) => {
                assert_eq!(found, 2);
                assert!(backup.expect("백업 rename 은 성공해야 함").exists());
            }
            other => panic!("Fresh(UnsupportedVersion) 여야 함: {other:?}"),
        }
        assert!(!path.exists());
    }

    #[test]
    fn sanitize_clears_pty_sessions_and_repairs_next_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // 구 pty id 가 남아 있고 next_id(2) 가 최대 사용 id(6 — tab id) 이하인 상태.
        save_atomic(&path, &sample_state(Some(9), 2)).unwrap();
        match load(&path) {
            LoadOutcome::Restored { state, repairs } => {
                for ws in &state.workspaces {
                    for pane in ws.panes.values() {
                        for tab in &pane.tabs {
                            let TabKind::Terminal { pty_session, .. } = &tab.kind else {
                                panic!("terminal 탭이어야 함");
                            };
                            assert_eq!(*pty_session, None, "pty_session 은 무조건 소거");
                        }
                    }
                }
                // max id = 6 (tab), split id 4 도 계산에 포함됐다면 next_id 는 7.
                assert_eq!(state.next_id, 7);
                assert_eq!(repairs.len(), 1);
                assert!(repairs[0].contains("next_id"), "repairs: {repairs:?}");
            }
            other => panic!("Restored 여야 함: {other:?}"),
        }
    }

    #[test]
    fn sanitize_revives_not_started_terminal_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // 실기 재현(2026-08-20): 되살린 탭 11개가 콜드 WSL 에 몰려 6개가 시작 표식을
        // 못 낸 채 남았다. 그 상태로 저장되면 다음 부팅에서도 재스폰 대상이 아니라
        // 사용자가 탭마다 Restart 를 눌러야 한다.
        let mut state = sample_state(Some(9), 7);
        for pane in state.workspaces[0].panes.values_mut() {
            for tab in &mut pane.tabs {
                let TabKind::Terminal { status, .. } = &mut tab.kind else {
                    panic!("terminal 탭이어야 함");
                };
                *status = TerminalStatus::NotStarted;
            }
        }
        save_atomic(&path, &state).unwrap();
        match load(&path) {
            LoadOutcome::Restored { state, .. } => {
                for pane in state.workspaces[0].panes.values() {
                    for tab in &pane.tabs {
                        let TabKind::Terminal { status, .. } = &tab.kind else {
                            panic!("terminal 탭이어야 함");
                        };
                        assert_eq!(*status, TerminalStatus::Running);
                    }
                }
            }
            other => panic!("Restored 여야 함: {other:?}"),
        }
    }

    #[test]
    fn sanitize_keeps_exited_terminal_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // 실기 재현(2026-08-20): 앱이 살아 있는 동안 PC 절전으로 WSL 이 내려가 전 탭이
        // 강제 종료 코드와 함께 Exited 로 저장된 상태. 기록 파일이 남아 있으므로 복원
        // 후에도 마지막 화면이 그대로 읽히고, 되살리기는 배너의 Restart 다 (ADR-0018 D3).
        let mut state = sample_state(Some(9), 7);
        for pane in state.workspaces[0].panes.values_mut() {
            for tab in &mut pane.tabs {
                let TabKind::Terminal { status, .. } = &mut tab.kind else {
                    panic!("terminal 탭이어야 함");
                };
                *status = TerminalStatus::Exited {
                    code: Some(1_073_807_364),
                    ended_at_ms: Some(1_723_100_000_000),
                };
            }
        }
        save_atomic(&path, &state).unwrap();
        match load(&path) {
            LoadOutcome::Restored { state, repairs } => {
                for pane in state.workspaces[0].panes.values() {
                    for tab in &pane.tabs {
                        let TabKind::Terminal {
                            pty_session,
                            status,
                            ..
                        } = &tab.kind
                        else {
                            panic!("terminal 탭이어야 함");
                        };
                        assert_eq!(*pty_session, None, "pty_session 은 무조건 소거");
                        assert_eq!(
                            *status,
                            TerminalStatus::Exited {
                                code: Some(1_073_807_364),
                                ended_at_ms: Some(1_723_100_000_000)
                            },
                            "Exited 는 종료 코드·시각과 함께 그대로 남아야 함"
                        );
                    }
                }
                assert!(repairs.is_empty(), "repairs: {repairs:?}");
            }
            other => panic!("Restored 여야 함: {other:?}"),
        }
    }

    #[test]
    fn sanitize_resets_agent_status_and_notifications() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // 채워진 알림/에이전트 상태로 저장 — 죽은 세션의 needsInput 이 재시작을
        // 넘지 않아야 한다 (18단계 계획, pty_session 소거와 동급 규칙).
        let mut state = sample_state(None, 7);
        {
            let ws = &mut state.workspaces[0];
            ws.agent_status = AgentStatus::NeedsInput;
            ws.agent_status_source = Some(TabId(5));
            ws.last_agent_message = Some("waiting for input".into());
            for pane in ws.panes.values_mut() {
                for tab in &mut pane.tabs {
                    tab.notification = NotificationState::Unread;
                    tab.last_activity_ms = Some(123_456);
                }
            }
        }
        save_atomic(&path, &state).unwrap();
        match load(&path) {
            LoadOutcome::Restored { state, .. } => {
                let ws = &state.workspaces[0];
                assert_eq!(ws.agent_status, AgentStatus::Idle);
                assert_eq!(ws.agent_status_source, None);
                assert_eq!(ws.last_agent_message, None);
                for pane in ws.panes.values() {
                    for tab in &pane.tabs {
                        assert_eq!(tab.notification, NotificationState::None);
                        assert_eq!(tab.last_activity_ms, None);
                    }
                }
            }
            other => panic!("Restored 여야 함: {other:?}"),
        }
    }

    #[test]
    fn next_id_repair_includes_split_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // split id 를 최댓값(40)으로 만든 상태 — split 을 max 계산에서 빠뜨리면
        // next_id 7 이 유효해 보인다 (탭 최대 6).
        let mut state = sample_state(None, 7);
        let SplitTree::Split { id, .. } = &mut state.workspaces[0].layout else {
            panic!("split 이어야 함");
        };
        *id = SplitId(40);
        save_atomic(&path, &state).unwrap();
        match load(&path) {
            LoadOutcome::Restored { state, repairs } => {
                assert_eq!(state.next_id, 41, "split id 40 이 max 계산에 포함돼야 함");
                assert_eq!(repairs.len(), 1);
            }
            other => panic!("Restored 여야 함: {other:?}"),
        }
    }

    #[test]
    fn structural_violation_is_corrupt_with_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // layout 은 pane 2·3 을 가리키는데 panes 에서 3 을 제거 — 불변식 위반.
        let mut state = sample_state(None, 7);
        state.workspaces[0].panes.remove(&PaneId(3));
        save_atomic(&path, &state).unwrap();
        match load(&path) {
            LoadOutcome::Fresh(FreshReason::Corrupt { backup, error }) => {
                assert!(backup.expect("백업 rename 은 성공해야 함").exists());
                assert!(error.contains("invariant violation"), "error: {error}");
            }
            other => panic!("Fresh(Corrupt) 여야 함: {other:?}"),
        }
        assert!(!path.exists());
    }

    #[test]
    fn dangling_active_workspace_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        let mut state = sample_state(None, 7);
        state.active_workspace = Some(WorkspaceId(99));
        save_atomic(&path, &state).unwrap();
        match load(&path) {
            LoadOutcome::Fresh(FreshReason::Corrupt { error, .. }) => {
                assert!(error.contains("active_workspace"), "error: {error}");
            }
            other => panic!("Fresh(Corrupt) 여야 함: {other:?}"),
        }
    }

    /// 파일에서 revision 을 읽는다 (Saver 테스트 관측용).
    fn read_revision(path: &Path) -> u64 {
        let persisted: PersistedState = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        persisted.state.revision
    }

    #[test]
    fn saver_coalesces_rapid_schedules_to_latest() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        let saver = Saver::spawn(path.clone(), Duration::from_millis(200));
        let mut first = sample_state(None, 7);
        first.revision = 10;
        let mut second = sample_state(None, 7);
        second.revision = 11;
        saver.schedule(first);
        saver.schedule(second);
        // trailing debounce — 창 안에는 아직 기록되지 않는다.
        assert!(!path.exists(), "debounce 창 안에 조기 기록됨");
        // 창 경과 후 최종값 한 번만 기록된다.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(Instant::now() < deadline, "debounce 기록이 5초 내에 없음");
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(read_revision(&path), 11, "coalesce 후 최신값만 남아야 함");
        drop(saver);
    }

    #[test]
    fn saver_flush_writes_pending_synchronously() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // debounce 를 크게 잡아 타이머 경로가 아님을 보장한다.
        let saver = Saver::spawn(path.clone(), Duration::from_secs(60));
        let mut state = sample_state(None, 7);
        state.revision = 42;
        saver.schedule(state);
        saver.flush();
        // flush 반환 즉시 파일이 있어야 한다 (동기성).
        assert_eq!(read_revision(&path), 42);
        // 대기분이 없을 때의 flush 는 no-op ack.
        saver.flush();
        assert_eq!(read_revision(&path), 42);
    }

    #[test]
    fn saver_drop_flushes_pending() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        let saver = Saver::spawn(path.clone(), Duration::from_secs(60));
        let mut state = sample_state(None, 7);
        state.revision = 77;
        saver.schedule(state);
        drop(saver); // Drop 이 대기분을 flush 하고 join 한다.
        assert_eq!(read_revision(&path), 77);
    }
}
