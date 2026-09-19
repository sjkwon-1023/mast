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
//!   (18단계 계획, 터미널-계획-v2.md 11장): 전 탭의 `agent_status` = `Idle`,
//!   `last_agent_message`·`last_agent_message_seq` = `None`, `notification` =
//!   `NotificationState::None`, `last_activity_ms` = `None`, 그리고 그 파생값인
//!   각 워크스페이스의 `agent_status` = `Idle`, `last_agent_message` = `None`.
//!   pty_session 과 동일한 이유 — 죽은 세션이 남긴 needsInput 이 재시작을 넘어
//!   사이드바에 유령처럼 남는 걸 막는다.
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
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
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
    let mut compatibility_value = value;
    let removed_unknown_tabs = replace_unknown_tab_kinds(&mut compatibility_value);
    // unknown kind 를 placeholder 로 바꾼 상태도 먼저 전체 검증한다. 탭을 지운 뒤
    // 검증하면 중복 id 나 dangling layout 같은 기존 손상이 함께 사라질 수 있다.
    let persisted: PersistedState = match serde_json::from_value(compatibility_value) {
        Ok(persisted) => persisted,
        Err(err) => return fresh_corrupt(path, format!("deserialize failed: {err}")),
    };
    let mut state = persisted.state;
    if let Err(err) = validate_app(&state) {
        return fresh_corrupt(path, format!("invariant violation: {err}"));
    }
    remove_unknown_tabs(&mut state, &removed_unknown_tabs);
    if let Err(err) = validate_app(&state) {
        return fresh_corrupt(path, format!("invariant violation: {err}"));
    }
    let mut repairs = removed_unknown_tabs
        .iter()
        .map(|tab| {
            format!(
                "removed unknown tab kind {:?} (tab id {})",
                tab.kind, tab.id
            )
        })
        .collect::<Vec<_>>();
    let dropped_max_id = removed_unknown_tabs.iter().map(|tab| tab.id).max();
    let sanitize_repairs = match sanitize(&mut state, dropped_max_id) {
        Ok(repairs) => repairs,
        Err(err) => return fresh_corrupt(path, format!("invariant violation: {err}")),
    };
    repairs.extend(sanitize_repairs);
    LoadOutcome::Restored { state, repairs }
}

#[derive(Debug, Clone)]
struct RemovedUnknownTab {
    id: u64,
    kind: String,
}

/// 현재 binary 가 이해하는 탭 kind tag 목록. 새 kind 를 추가할 때 이 목록도 함께
/// 갱신해야 그 kind 가 호환성 제거 대상이 아니라 정상 역직렬화 대상이 된다.
fn is_known_tab_kind(kind: &str) -> bool {
    matches!(
        kind,
        "terminal" | "folderBrowser" | "textViewer" | "markdownViewer" | "changesViewer"
    )
}

/// typed deserialize 전에 unknown 탭의 kind 만 placeholder 로 치환한다. 탭의 다른
/// 필드와 앱 구조는 이후 placeholder 상태를 deserialize·validate 하며 그대로 검증한다.
fn replace_unknown_tab_kinds(value: &mut serde_json::Value) -> Vec<RemovedUnknownTab> {
    let mut removed = Vec::new();
    let Some(state) = value
        .get_mut("state")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return removed;
    };
    let Some(workspaces) = state
        .get_mut("workspaces")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return removed;
    };
    for workspace in workspaces {
        let Some(panes) = workspace
            .get_mut("panes")
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        for pane in panes.values_mut() {
            let Some(tabs) = pane
                .get_mut("tabs")
                .and_then(serde_json::Value::as_array_mut)
            else {
                continue;
            };
            for tab in tabs {
                let Some(kind_name) = tab
                    .get("kind")
                    .and_then(serde_json::Value::as_object)
                    .and_then(|kind| kind.get("type"))
                    .and_then(serde_json::Value::as_str)
                    .filter(|kind| !is_known_tab_kind(kind))
                    .map(str::to_owned)
                else {
                    continue;
                };
                let Some(id) = tab.get("id").and_then(serde_json::Value::as_u64) else {
                    continue;
                };
                let Some(tab_object) = tab.as_object_mut() else {
                    continue;
                };
                tab_object.insert("kind".into(), terminal_placeholder_kind());
                removed.push(RemovedUnknownTab {
                    id,
                    kind: kind_name,
                });
            }
        }
    }
    removed
}

fn terminal_placeholder_kind() -> serde_json::Value {
    serde_json::to_value(TabKind::Terminal {
        pty_session: None,
        status: TerminalStatus::Running,
        cwd: None,
    })
    .expect("terminal placeholder serialization cannot fail")
}

/// placeholder 상태의 구조 검증이 끝난 뒤 unknown 탭을 제거하고, 그 탭이 active 였던
/// pane 은 남은 탭의 첫 항목으로 전환한다. 탭이 모두 사라지는 pane 은 유효한 빈 pane 이다.
fn remove_unknown_tabs(state: &mut AppState, removed: &[RemovedUnknownTab]) {
    if removed.is_empty() {
        return;
    }
    let removed_ids: std::collections::BTreeSet<u64> = removed.iter().map(|tab| tab.id).collect();
    for workspace in &mut state.workspaces {
        for pane in workspace.panes.values_mut() {
            let active_id = pane.active_tab;
            let old_tabs = std::mem::take(&mut pane.tabs);
            let mut survivors = Vec::with_capacity(old_tabs.len());
            let mut active_removed = false;
            for tab in old_tabs {
                if removed_ids.contains(&tab.id.0) {
                    active_removed |= active_id == Some(tab.id);
                } else {
                    survivors.push(tab);
                }
            }
            pane.tabs = survivors;
            if active_removed {
                pane.active_tab = pane.tabs.first().map(|tab| tab.id);
            }
        }
    }
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
/// 정상 동작이라 사유에 포함하지 않는다. 안정 ID의 다음 값을 만들 수 없으면 오류를
/// 반환한다.
fn sanitize(state: &mut AppState, reserved_max_id: Option<u64>) -> Result<Vec<String>, String> {
    let mut repairs = Vec::new();
    for ws in &mut state.workspaces {
        ws.agent_status = AgentStatus::Idle;
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
                tab.agent_status = AgentStatus::Idle;
                tab.last_agent_message = None;
                tab.last_agent_message_seq = None;
            }
        }
    }
    let max_id = max_used_id(state).max(reserved_max_id.unwrap_or(0));
    if state.next_id <= max_id {
        let next_id = max_id
            .checked_add(1)
            .ok_or_else(|| format!("max stable id {max_id} leaves no available next id"))?;
        repairs.push(format!(
            "next_id {} <= max used stable id {max_id} — repaired to {next_id}",
            state.next_id,
        ));
        state.next_id = next_id;
    }
    Ok(repairs)
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

/// [`Saver`] worker 와 호출자가 공유하는 슬롯. 채널이 아니라 **최신 1개짜리
/// 슬롯**인 이유: `schedule` 은 `publish_state` 가 Dispatcher lock 을 쥔 채
/// 부르므로 프로듀서 폭주가 곧 `AppState` clone 의 무한 적재가 된다 (CLAUDE.md
/// "queue·buffer 는 전부 bounded"). 슬롯 교체는 큐잉이 아니라 덮어쓰기라
/// 대기분이 1개를 넘지 않는다.
struct SaverSlot {
    /// 아직 기록되지 않은 최신 상태. 새 `schedule` 은 이 자리를 **교체**한다.
    pending: Option<Box<AppState>>,
    /// `pending` 이 `None → Some` 이 되는 순간 고정된다 — 연속 변이 중에도
    /// 유실 창이 `debounce` 로 유계이게 하는 trailing debounce 의 핵심.
    /// `pending` 이 `None` 이면 의미 없다.
    deadline: Instant,
    /// 지금까지 발급된 예약 세대 — `schedule` 마다 1 오른다. 슬롯은 큐가 아니라
    /// 교체라 `pending` 에 든 상태의 세대가 곧 이 값이다.
    scheduled: u64,
    /// worker 가 **디스크에 쓴** 마지막 상태의 세대. worker 는 `pending` 을 집어갈 때
    /// 본 `scheduled` 를 기억했다가 write 를 마친 뒤 그 값을 여기에 적는다 — 쓰고 난
    /// 뒤의 `scheduled` 를 적으면 쓰는 동안 들어온 예약까지 쓴 것으로 ack 하게 된다.
    ///
    /// 완료 판정이 세대인 이유: "`pending` 이 빌 때까지" 로 판정하면 저장이 상태
    /// 갱신보다 느린 환경에서 슬롯이 영영 비지 않아 종료 경로(`main.rs` 의
    /// `router.flush_now()` → `saver.flush()`)가 끝나지 않는다 — OSC 프로듀서는
    /// `flush_now()` 로 멈추지 않는다 (2026-09-12 리뷰).
    written: u64,
    /// flush 를 기다리는 호출자가 지목한 세대 — `written` 이 여기 닿을 때까지 worker 는
    /// deadline 을 무시하고 즉시 쓴다. 불리언 플래그가 아닌 이유: 플래그는 "슬롯이 비는
    /// 순간" 말고는 내릴 자리가 없어, 프로듀서가 write 마다 슬롯을 다시 채우는 동안
    /// 한 번의 flush 가 trailing debounce 를 영구히 꺼 버린다 (2026-09-12 리뷰).
    flush_target: u64,
    /// Saver 가 Drop 중 — worker 는 대기분을 쓰고 종료한다.
    closed: bool,
    /// worker 가 사라졌다 (패닉·정상 종료). 이후의 `schedule`·`flush` 는 무한
    /// 대기 대신 loud 하게 포기한다.
    worker_dead: bool,
}

struct SaverShared {
    slot: Mutex<SaverSlot>,
    cond: Condvar,
}

/// 슬롯 lock — 포이즌은 무시하고 내용을 그대로 쓴다. 안에 든 것은 다음 저장
/// 대상과 카운터뿐이라 패닉이 남긴 값도 의미가 유효하고, 여기서 패닉하면
/// 종료 경로(`flush`)가 통째로 죽는다.
fn lock_slot(shared: &SaverShared) -> MutexGuard<'_, SaverSlot> {
    shared.slot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// worker 가 어떤 경로로 끝나든 (패닉 포함) `worker_dead` 를 세우고 깨운다 —
/// 없으면 `flush` 가 영영 오지 않을 ack 를 기다린다.
struct WorkerDeadGuard<'a> {
    shared: &'a SaverShared,
}

impl Drop for WorkerDeadGuard<'_> {
    fn drop(&mut self) {
        lock_slot(self.shared).worker_dead = true;
        self.shared.cond.notify_all();
    }
}

/// debounce 백그라운드 저장기. [`Saver::schedule`] 은 최신 상태만 남기고
/// (대기분 ≤ 1), 첫 schedule 시점부터 `debounce` 경과 후 한 번 기록한다 (trailing).
///
/// - **유실 창**: 프로세스가 크래시하면 마지막 기록 이후 debounce 창(≤ `debounce`)
///   안의 변이는 유실된다 — MVP 수용 (계획 B-1). deadline 을 첫 schedule 에
///   고정하므로 연속 변이 중에도 유실 창은 `debounce` 로 유계다.
/// - **메모리**: 대기분은 항상 1개 — `schedule` 은 큐에 넣지 않고 슬롯을 교체한다.
/// - **저장 실패**: loud stderr 만 남기고 패닉하지 않는다. 별도 재시도 루프 없이
///   다음 schedule 이 자연 재시도가 된다.
/// - **종료**: [`Saver::flush`] 는 호출 시점까지의 예약분을 동기적으로 기록하고
///   (그 뒤에 들어오는 예약은 기다리지 않는다 — 그쪽을 기다리면 반환이 프로듀서에
///   묶인다), Drop 도 대기분을 flush 한 뒤 worker 를 join 한다.
pub struct Saver {
    shared: Arc<SaverShared>,
    debounce: Duration,
    worker: Option<thread::JoinHandle<()>>,
}

impl Saver {
    /// worker 스레드를 띄운다. `path` 는 [`save_atomic`] 대상.
    pub fn spawn(path: PathBuf, debounce: Duration) -> Self {
        let shared = Arc::new(SaverShared {
            slot: Mutex::new(SaverSlot {
                pending: None,
                deadline: Instant::now(),
                scheduled: 0,
                written: 0,
                flush_target: 0,
                closed: false,
                worker_dead: false,
            }),
            cond: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("mast-saver".into())
            .spawn(move || worker_loop(&path, &worker_shared))
            .expect("saver worker spawn failed");
        Self {
            shared,
            debounce,
            worker: Some(worker),
        }
    }

    /// 저장 예약 — 이미 대기 중이면 최신 상태로 교체된다 (대기분 ≤ 1).
    ///
    /// 호출자(`publish_state`)가 Dispatcher lock 을 쥔 채 부르므로 이 함수는
    /// 슬롯 lock 만 짧게 잡는다 — 디스크 IO 는 worker 가 lock 밖에서 한다.
    pub fn schedule(&self, state: AppState) {
        let mut slot = lock_slot(&self.shared);
        if slot.worker_dead {
            // worker 가 죽은 상태 — 저장이 안 되고 있음을 숨기지 않는다.
            eprintln!("[mast] persist: saver worker is gone; schedule dropped");
            return;
        }
        if slot.pending.is_none() {
            slot.deadline = Instant::now() + self.debounce;
        }
        slot.scheduled += 1;
        slot.pending = Some(Box::new(state));
        drop(slot);
        self.shared.cond.notify_all();
    }

    /// 대기분을 지금 기록하고 완료까지 동기 대기한다. 대기분이 없으면 no-op ack.
    ///
    /// 반환 시점에는 **이 호출 이전의 모든 `schedule` 이 디스크에 있다.** 근거는
    /// 슬롯이 큐가 아니라는 것이다: 호출 시점의 세대(`scheduled`)가 디스크에 닿으면
    /// 그 세대의 상태가 이전 예약을 전부 흡수한 최신본이므로 더 기다릴 것이 없다.
    /// **호출 뒤에 들어온 예약은 기다리지 않는다** — 슬롯이 빌 때까지 기다리면 예약이
    /// 저장보다 빠른 환경에서 영영 반환하지 못한다.
    pub fn flush(&self) {
        let mut slot = lock_slot(&self.shared);
        if slot.worker_dead {
            eprintln!("[mast] persist: saver worker is gone; flush dropped");
            return;
        }
        let target = slot.scheduled;
        if slot.written >= target {
            return;
        }
        slot.flush_target = slot.flush_target.max(target);
        self.shared.cond.notify_all();
        while slot.written < target {
            if slot.worker_dead {
                eprintln!("[mast] persist: saver worker died before flush ack");
                return;
            }
            slot = self
                .shared
                .cond
                .wait(slot)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

impl Drop for Saver {
    fn drop(&mut self) {
        lock_slot(&self.shared).closed = true;
        self.shared.cond.notify_all();
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                eprintln!("[mast] persist: saver worker thread panicked");
            }
        }
    }
}

fn worker_loop(path: &Path, shared: &SaverShared) {
    let _dead = WorkerDeadGuard { shared };
    let mut slot = lock_slot(shared);
    loop {
        // flush 요구는 그것이 지목한 세대가 디스크에 닿는 순간 스스로 꺼진다 — 슬롯이
        // 비기를 기다려 내리지 않는다.
        let flush_wanted = slot.written < slot.flush_target;
        let due = slot.pending.is_some()
            && (flush_wanted || slot.closed || Instant::now() >= slot.deadline);
        if due {
            // 집어가는 상태의 세대를 **여기서** 붙든다 — write 중에 들어온 예약이
            // `scheduled` 를 올리므로, 쓴 뒤에 읽으면 쓰지 않은 상태를 ack 하게 된다.
            let generation = slot.scheduled;
            let state = slot.pending.take().expect("due 는 pending 이 Some 일 때만 참");
            // 디스크 IO 는 반드시 lock 밖에서 — schedule 은 Dispatcher lock 을 쥔
            // 프로듀서가 부른다.
            drop(slot);
            write_state(path, &state);
            slot = lock_slot(shared);
            slot.written = generation;
            shared.cond.notify_all();
            continue;
        }
        if slot.closed {
            return;
        }
        slot = if slot.pending.is_some() {
            let timeout = slot.deadline.saturating_duration_since(Instant::now());
            shared
                .cond
                .wait_timeout(slot, timeout)
                .unwrap_or_else(PoisonError::into_inner)
                .0
        } else {
            shared
                .cond
                .wait(slot)
                .unwrap_or_else(PoisonError::into_inner)
        };
    }
}

/// 실패는 loud stderr — 다음 schedule 이 자연 재시도.
fn write_state(path: &Path, state: &AppState) {
    if let Err(err) = save_atomic(path, state) {
        eprintln!(
            "[mast] persist: state save failed ({}): {err}",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc;

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
                agent_status: AgentStatus::Idle,
                last_agent_message: None,
                last_agent_message_seq: None,
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

    fn second_split_workspace() -> Workspace {
        let mut workspace = sample_state(None, 100).workspaces.pop().unwrap();
        workspace.id = WorkspaceId(7);
        workspace.layout = SplitTree::Split {
            id: SplitId(10),
            direction: SplitDirection::Vertical,
            ratio: 0.4,
            first: Box::new(SplitTree::Leaf { pane: PaneId(8) }),
            second: Box::new(SplitTree::Leaf { pane: PaneId(9) }),
        };
        workspace.panes = [
            (PaneId(8), pane_with_tab(8, 11, None)),
            (PaneId(9), pane_with_tab(9, 12, None)),
        ]
        .into();
        workspace.active_pane = PaneId(8);
        workspace
    }

    fn raw_persisted_value(state: AppState) -> serde_json::Value {
        serde_json::to_value(PersistedState {
            version: PERSIST_VERSION,
            state,
        })
        .unwrap()
    }

    fn unknown_tab(id: u64, kind: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "title": format!("future-{id}"),
            "kind": {"type": kind, "path": "/future"},
            "notification": "unread",
            "lastActivityMs": 123,
        })
    }

    fn write_raw(path: &Path, value: &serde_json::Value) {
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn assert_corrupt_value(value: serde_json::Value) {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        write_raw(&path, &value);
        match load(&path) {
            LoadOutcome::Fresh(FreshReason::Corrupt { backup, error }) => {
                assert!(backup.unwrap().exists());
                assert!(
                    error.contains("deserialize failed") || error.contains("invariant violation")
                );
            }
            other => panic!("malformed persistence value must be Corrupt: {other:?}"),
        }
    }

    #[test]
    fn unknown_tab_kinds_are_removed_without_disturbing_layout_or_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        let mut state = sample_state(None, 100);
        state.workspaces.push(second_split_workspace());
        let mut value = raw_persisted_value(state);

        value["state"]["workspaces"][0]["panes"]["2"]["tabs"]
            .as_array_mut()
            .unwrap()
            .push(unknown_tab(50, "futureViewer"));
        value["state"]["workspaces"][0]["panes"]["2"]["tabs"][0]["kind"]["cwd"] =
            serde_json::json!("/survivor/cwd");
        value["state"]["workspaces"][0]["panes"]["3"]["tabs"]
            .as_array_mut()
            .unwrap()
            .push(unknown_tab(51, "futureViewer"));
        value["state"]["workspaces"][0]["panes"]["3"]["activeTab"] = serde_json::json!(51);
        value["state"]["workspaces"][1]["rootPath"] = serde_json::json!("/workspace/two");
        value["state"]["workspaces"][1]["panes"]["8"]["tabs"] =
            serde_json::json!([unknown_tab(80, "futureViewer")]);
        value["state"]["workspaces"][1]["panes"]["8"]["activeTab"] = serde_json::json!(80);
        write_raw(&path, &value);

        let LoadOutcome::Restored { state, repairs } = load(&path) else {
            panic!("unknown tab kinds with valid surrounding state must restore");
        };
        assert_eq!(state.active_workspace, Some(WorkspaceId(1)));
        assert_eq!(state.workspaces.len(), 2);
        assert_eq!(
            state.workspaces[0].layout.leaves(),
            vec![PaneId(2), PaneId(3)]
        );
        assert_eq!(
            state.workspaces[1].layout.leaves(),
            vec![PaneId(8), PaneId(9)]
        );
        assert_eq!(
            state.workspaces[1].root_path.as_deref(),
            Some("/workspace/two")
        );

        let pane2 = &state.workspaces[0].panes[&PaneId(2)];
        assert_eq!(pane2.active_tab, Some(TabId(5)));
        assert_eq!(
            pane2.tabs.iter().map(|tab| tab.id).collect::<Vec<_>>(),
            vec![TabId(5)]
        );
        let TabKind::Terminal { cwd, .. } = &pane2.tabs[0].kind else {
            panic!("the surviving tab must stay terminal");
        };
        assert_eq!(cwd.as_deref(), Some("/survivor/cwd"));

        let pane3 = &state.workspaces[0].panes[&PaneId(3)];
        assert_eq!(pane3.active_tab, Some(TabId(6)));
        assert_eq!(
            pane3.tabs.iter().map(|tab| tab.id).collect::<Vec<_>>(),
            vec![TabId(6)]
        );

        let pane8 = &state.workspaces[1].panes[&PaneId(8)];
        assert!(pane8.tabs.is_empty());
        assert_eq!(pane8.active_tab, None);
        for workspace in &state.workspaces {
            workspace.validate().unwrap();
        }
        assert_eq!(
            repairs,
            vec![
                "removed unknown tab kind \"futureViewer\" (tab id 50)",
                "removed unknown tab kind \"futureViewer\" (tab id 51)",
                "removed unknown tab kind \"futureViewer\" (tab id 80)",
            ]
        );

        let roundtrip_path = dir.path().join("roundtrip.json");
        save_atomic(&roundtrip_path, &state).unwrap();
        let LoadOutcome::Restored {
            state: roundtripped,
            repairs,
        } = load(&roundtrip_path)
        else {
            panic!("a repaired state must round-trip");
        };
        assert!(repairs.is_empty(), "round-trip repairs: {repairs:?}");
        assert_eq!(roundtripped, state);
    }

    #[test]
    fn unknown_tab_removal_does_not_mask_structural_corruption() {
        let mut value = raw_persisted_value(sample_state(None, 100));
        value["state"]["workspaces"][0]["panes"]["2"]["tabs"]
            .as_array_mut()
            .unwrap()
            .push(unknown_tab(50, "futureViewer"));
        value["state"]["workspaces"][0]["panes"]
            .as_object_mut()
            .unwrap()
            .remove("3");
        assert_corrupt_value(value);
    }

    #[test]
    fn malformed_unknown_tab_is_corrupt() {
        let mut value = raw_persisted_value(sample_state(None, 100));
        let mut tab = unknown_tab(50, "futureViewer");
        tab.as_object_mut().unwrap().remove("id");
        value["state"]["workspaces"][0]["panes"]["2"]["tabs"]
            .as_array_mut()
            .unwrap()
            .push(tab);
        assert_corrupt_value(value);
    }

    #[test]
    fn malformed_known_or_tagged_kind_is_corrupt() {
        let mut missing_field = raw_persisted_value(sample_state(None, 100));
        missing_field
            .pointer_mut("/state/workspaces/0/panes/2/tabs/0/kind")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("status");
        assert_corrupt_value(missing_field);

        let mut missing_tag = raw_persisted_value(sample_state(None, 100));
        missing_tag
            .pointer_mut("/state/workspaces/0/panes/2/tabs/0/kind")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("type");
        assert_corrupt_value(missing_tag);

        let mut nonstring_tag = raw_persisted_value(sample_state(None, 100));
        *nonstring_tag
            .pointer_mut("/state/workspaces/0/panes/2/tabs/0/kind/type")
            .unwrap() = serde_json::json!(42);
        assert_corrupt_value(nonstring_tag);
    }

    #[test]
    fn removed_unknown_ids_remain_reserved_for_the_allocator() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        let mut value = raw_persisted_value(sample_state(None, 2));
        value["state"]["workspaces"][0]["panes"]["2"]["tabs"]
            .as_array_mut()
            .unwrap()
            .push(unknown_tab(80, "futureViewer"));
        write_raw(&path, &value);

        let LoadOutcome::Restored { mut state, repairs } = load(&path) else {
            panic!("unknown tab with valid surrounding state must restore");
        };
        assert_eq!(state.next_id, 81);
        assert!(repairs.iter().any(|repair| repair.contains("tab id 80")));
        assert!(repairs.iter().any(|repair| repair.contains("next_id")));
        assert_eq!(state.alloc_id(), 81);
    }

    #[test]
    fn dropped_max_id_is_reported_as_allocator_exhaustion() {
        let mut value = raw_persisted_value(sample_state(None, 2));
        value["state"]["workspaces"][0]["panes"]["2"]["tabs"]
            .as_array_mut()
            .unwrap()
            .push(unknown_tab(u64::MAX, "futureViewer"));
        assert_corrupt_value(value);
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
            ws.last_agent_message = Some("waiting for input".into());
            for pane in ws.panes.values_mut() {
                for tab in &mut pane.tabs {
                    tab.notification = NotificationState::Unread;
                    tab.last_activity_ms = Some(123_456);
                    tab.agent_status = AgentStatus::NeedsInput;
                    tab.last_agent_message = Some("waiting for input".into());
                    tab.last_agent_message_seq = Some(3);
                }
            }
        }
        save_atomic(&path, &state).unwrap();
        match load(&path) {
            LoadOutcome::Restored { state, .. } => {
                let ws = &state.workspaces[0];
                assert_eq!(ws.agent_status, AgentStatus::Idle);
                assert_eq!(ws.last_agent_message, None);
                for pane in ws.panes.values() {
                    for tab in &pane.tabs {
                        assert_eq!(tab.notification, NotificationState::None);
                        assert_eq!(tab.last_activity_ms, None);
                        assert_eq!(tab.agent_status, AgentStatus::Idle);
                        assert_eq!(tab.last_agent_message, None);
                        assert_eq!(tab.last_agent_message_seq, None);
                    }
                }
            }
            other => panic!("Restored 여야 함: {other:?}"),
        }
    }

    #[test]
    fn legacy_state_without_tab_agent_fields_loads() {
        // 탭 단위 에이전트 필드가 생기기 전 v1 파일: 탭에는 agentStatus/lastAgentMessage
        // 가 없고, 워크스페이스에는 제거된 agentStatusSource 키가 남아 있다. 이 파일이
        // Corrupt 로 떨어지면 백업 후 새로 시작하므로 사용자 워크스페이스가 전부 사라진다.
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        let legacy = r#"{
  "version": 1,
  "state": {
    "workspaces": [
      {
        "id": 1,
        "name": "legacy",
        "rootPath": "/home/dev/legacy",
        "distro": "Ubuntu-24.04",
        "gitBranch": null,
        "gitDirty": null,
        "layout": {
          "type": "split",
          "id": 4,
          "direction": "horizontal",
          "ratio": 0.5,
          "first": { "type": "leaf", "pane": 2 },
          "second": { "type": "leaf", "pane": 3 }
        },
        "panes": {
          "2": {
            "id": 2,
            "tabs": [
              {
                "id": 5,
                "title": "Terminal",
                "kind": {
                  "type": "terminal",
                  "ptySession": 9,
                  "status": { "type": "running" },
                  "cwd": "/home/dev/legacy/src"
                },
                "notification": "unread",
                "lastActivityMs": 1723100000000
              }
            ],
            "activeTab": 5
          },
          "3": {
            "id": 3,
            "tabs": [
              {
                "id": 6,
                "title": "notes.txt",
                "kind": {
                  "type": "textViewer",
                  "path": "/home/dev/legacy/notes.txt",
                  "scrollTop": 0.0
                },
                "notification": "none",
                "lastActivityMs": null
              }
            ],
            "activeTab": 6
          }
        },
        "activePane": 2,
        "agentStatus": "needsInput",
        "lastAgentMessage": "approve?",
        "agentStatusSource": 5
      }
    ],
    "activeWorkspace": 1,
    "nextId": 7,
    "revision": 12
  }
}"#;
        fs::write(&path, legacy).unwrap();

        let LoadOutcome::Restored { state, repairs } = load(&path) else {
            panic!("legacy v1 state must restore");
        };
        assert!(repairs.is_empty(), "repairs: {repairs:?}");
        assert!(corrupt_backups(&dir).is_empty(), "corrupt 백업 경로를 타면 안 된다");
        assert!(path.exists(), "원본이 백업으로 치워지면 안 된다");

        assert_eq!(state.active_workspace, Some(WorkspaceId(1)));
        assert_eq!(state.next_id, 7);
        let ws = &state.workspaces[0];
        assert_eq!(ws.root_path.as_deref(), Some("/home/dev/legacy"));
        assert_eq!(ws.layout.leaves(), vec![PaneId(2), PaneId(3)]);
        let TabKind::Terminal { cwd, .. } = &ws.panes[&PaneId(2)].tabs[0].kind else {
            panic!("tab 5 must stay terminal");
        };
        assert_eq!(cwd.as_deref(), Some("/home/dev/legacy/src"));
        assert_eq!(
            ws.panes[&PaneId(3)].tabs[0].kind,
            TabKind::TextViewer {
                path: "/home/dev/legacy/notes.txt".into(),
                scroll_top: 0.0,
            }
        );

        assert_eq!(ws.agent_status, AgentStatus::Idle);
        assert_eq!(ws.last_agent_message, None);
        for pane in ws.panes.values() {
            for tab in &pane.tabs {
                assert_eq!(tab.agent_status, AgentStatus::Idle);
                assert_eq!(tab.last_agent_message, None);
                assert_eq!(tab.last_agent_message_seq, None);
            }
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

    #[test]
    fn saver_keeps_at_most_one_pending_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // debounce 를 크게 잡아 worker 가 창 안에서 슬롯을 비우지 않게 한다.
        let saver = Saver::spawn(path.clone(), Duration::from_secs(60));
        for revision in 1..=8u64 {
            let mut state = sample_state(None, 7);
            state.revision = revision;
            saver.schedule(state);
        }
        {
            let slot = lock_slot(&saver.shared);
            let pending = slot.pending.as_ref().expect("대기분이 있어야 함");
            assert_eq!(
                pending.revision, 8,
                "슬롯은 큐가 아니라 교체 — 8회 예약 뒤에도 대기분은 최신 1개"
            );
        }
        assert!(!path.exists(), "창 안에서는 중간 기록이 없다");
    }

    #[test]
    fn saver_debounce_deadline_is_fixed_at_the_first_schedule() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        let saver = Saver::spawn(path.clone(), Duration::from_millis(150));
        // 30ms 간격으로 20회 예약한다. deadline 이 schedule 마다 밀리는 구현이면
        // 마지막 예약(≈570ms) + 150ms 전에는 아무것도 쓰이지 않으므로, 루프가 끝난
        // 직후의 이 관측이 두 구현을 가른다.
        for revision in 1..=20u64 {
            let mut state = sample_state(None, 7);
            state.revision = revision;
            saver.schedule(state);
            thread::sleep(Duration::from_millis(30));
        }
        assert!(
            path.exists(),
            "deadline 이 첫 schedule 에 고정되면 연속 예약 중에도 기록이 난다"
        );
    }

    #[test]
    fn saver_flush_covers_every_schedule_made_before_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // 4 MiB 짜리 상태 — save_atomic 의 write + fsync 가 수 ms 걸려야 "worker 가
        // 쓰는 중" 이라는 창이 교체를 끼워 넣을 만큼 넓어진다. 작은 상태로는 창이
        // 너무 좁아 교체가 항상 write 바깥에 떨어지고, 그러면 ack 순서를 어긴
        // 구현도 통과해 버린다.
        let bulky = |revision: u64| {
            let mut state = sample_state(None, 7);
            state.workspaces[0].name = "x".repeat(4 * 1024 * 1024);
            state.revision = revision;
            state
        };
        // debounce 0 — worker 가 예약분을 즉시 집어 간다.
        let saver = Arc::new(Saver::spawn(path.clone(), Duration::ZERO));
        saver.schedule(bulky(1));
        // 슬롯이 비는 순간이 곧 "worker 가 lock 밖에서 1 을 쓰는 중" 이다. 교체는
        // 반드시 그 안에서, 그리고 flush 호출보다 먼저 들어가야 한다 — 이 순서라야
        // "write 를 끝낸 worker 가 pending 을 다시 보지 않고 flush 를 ack 하는"
        // 구현이 갈라진다.
        let deadline = Instant::now() + Duration::from_secs(5);
        while lock_slot(&saver.shared).pending.is_some() {
            assert!(Instant::now() < deadline, "worker 가 대기분을 가져가지 않음");
            thread::yield_now();
        }
        saver.schedule(bulky(2));
        assert!(
            flush_within(&saver, Duration::from_secs(10)),
            "flush 가 반환하지 않았다"
        );
        assert_eq!(
            read_revision(&path),
            2,
            "worker 가 쓰는 동안 들어온 교체분까지 flush 가 덮어야 함"
        );
        let slot = lock_slot(&saver.shared);
        assert_eq!(
            slot.written, slot.scheduled,
            "ack 시점의 written 은 마지막 예약 세대여야 함"
        );
    }

    /// `flush()` 를 떼어 낸 스레드에서 돌리고 `limit` 안에 반환했는지만 돌려준다.
    /// 직접 부르면 "ack 을 영영 올리지 않는" 부류의 회귀가 테스트 실패가 아니라 멈춘
    /// CI 잡으로 나타난다 — `cargo test` 에는 테스트별 타임아웃이 없다.
    fn flush_within(saver: &Arc<Saver>, limit: Duration) -> bool {
        let flushing = Arc::clone(saver);
        let (tx, rx) = mpsc::channel();
        let flusher = thread::spawn(move || {
            flushing.flush();
            let _ = tx.send(());
        });
        let returned = rx.recv_timeout(limit).is_ok();
        if returned {
            flusher.join().unwrap();
        }
        returned
    }

    #[test]
    fn saver_flush_returns_while_another_thread_keeps_scheduling() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(&dir);
        // 예약이 저장을 앞지르는 상황을 재현한다: 256 KiB 짜리 상태라 write 한 번이
        // 수십 ms 걸리고, 프로듀서는 그 사이마다 슬롯을 다시 채운다. 프로듀서를 멈추는
        // 것은 벽시계가 아니라 **이 스레드**다 — 느린 러너에서 프로듀서가 먼저 끝나
        // 판정이 흐려지는 일이 없고, 슬롯이 비기를 기다리는 구현에서는 flush 가
        // 반환하지 못해 프로듀서도 영영 멈추지 않는다.
        let mut bulky = sample_state(None, 7);
        bulky.workspaces[0].name = "x".repeat(256 * 1024);
        let saver = Arc::new(Saver::spawn(path.clone(), Duration::ZERO));
        let stop = Arc::new(AtomicBool::new(false));
        let scheduled = Arc::new(AtomicU64::new(0));
        let producer = {
            let saver = Arc::clone(&saver);
            let stop = Arc::clone(&stop);
            let scheduled = Arc::clone(&scheduled);
            thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let mut state = bulky.clone();
                    state.revision = scheduled.fetch_add(1, Ordering::SeqCst) + 1;
                    saver.schedule(state);
                }
            })
        };
        // 슬롯이 실제로 다시 차기 시작한 뒤에 flush 한다.
        while scheduled.load(Ordering::SeqCst) < 3 {
            thread::yield_now();
        }
        let returned = flush_within(&saver, Duration::from_secs(10));
        stop.store(true, Ordering::SeqCst);
        producer.join().unwrap();
        assert!(
            returned,
            "flush 가 프로듀서가 멈출 때까지 묶였다 — 세대가 아니라 슬롯이 비는 것으로 \
             완료를 판정하고 있다"
        );
    }
}
