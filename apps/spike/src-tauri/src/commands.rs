//! Tauri 커맨드 — 프론트엔드 ↔ mast-core 글루 (spike-plan 4.5).
//!
//! 잠금 규율: 코어 `SessionManager` 의 내부 lock 아래에서는 id 발급과
//! `Arc<PtySession>` 핸들 복사만 일어난다. 블로킹 가능성이 있는 호출(PTY
//! write·resize·spawn)은 핸들을 얻은 뒤 lock 밖에서, 그리고 메인(이벤트 루프)
//! 스레드가 아닌 `spawn_blocking` 스레드에서 수행한다 — paused 상태에서 자식이
//! stdin 을 읽지 않아 write 가 블록되면, 메인 스레드가 잡혀 있는 한
//! `ack_output` 도 처리되지 못해 영구 교착이 되기 때문이다.

use std::sync::Arc;

use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, State};
use mast_core::session::{PtySession, SessionId, SessionOptions, SpawnSpec};

use crate::sink::ChannelSink;
use crate::state::AppState;

/// spike 기본 버퍼 설정 (spike-plan 4.5): replay 1MB, high water 2MB, low water 512KB.
const REPLAY_CAP: usize = 1024 * 1024;
const HIGH_WATER: usize = 2 * 1024 * 1024;
const LOW_WATER: usize = 512 * 1024;

/// `get_stats` 직렬화형. mast-core 의 `SessionStats` 는 serde 의존이 없으므로
/// 글루에서 DTO 로 옮겨 내보낸다. `id` 는 `SessionManager::stats` 가 쌍으로
/// 돌려주는 레지스트리 id — 이벤트·커맨드의 id 와 같은 공간이다.
#[derive(serde::Serialize)]
pub struct SessionStatsDto {
    pub id: SessionId,
    pub bytes_out: u64,
    pub pending: usize,
    pub paused: bool,
    pub osc_count: u64,
    pub last_osc: Option<String>,
    pub alive: bool,
}

/// 플랫폼별 기본 spawn 명령 (spike-plan 4.5).
/// - Windows: `wsl.exe [-d $MAST_DISTRO] -- bash -l` (MAST_DISTRO 미설정이면 기본 배포판).
/// - Unix(개발 실행): `$SHELL -l`, `$SHELL` 없으면 `bash -l`.
fn default_spawn_spec(cols: u16, rows: u16) -> SpawnSpec {
    #[cfg(windows)]
    {
        let mut args: Vec<String> = Vec::new();
        // 빈 문자열은 미설정으로 취급한다.
        if let Ok(distro) = std::env::var("MAST_DISTRO") {
            if !distro.is_empty() {
                args.push("-d".to_string());
                args.push(distro);
            }
        }
        args.extend(["--", "bash", "-l"].map(String::from));
        SpawnSpec {
            program: "wsl.exe".to_string(),
            args,
            cwd: None,
            cols,
            rows,
        }
    }
    #[cfg(not(windows))]
    {
        let program = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "bash".to_string());
        SpawnSpec {
            program,
            args: vec!["-l".to_string()],
            cwd: None,
            cols,
            rows,
        }
    }
}

/// id 로 세션 핸들을 얻는다. 매니저 내부 lock 은 이 조회 안에서만 잡힌다 —
/// 반환된 핸들에 대한 호출은 전부 lock 밖에서 이뤄진다.
fn session(state: &AppState, id: SessionId) -> Result<Arc<PtySession>, String> {
    state
        .manager
        .get(id)
        .ok_or_else(|| format!("unknown terminal id: {id}"))
}

#[tauri::command]
pub async fn create_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<SessionId, String> {
    // id 발급·sink 생성·스폰·등록은 전부 코어 `SessionManager::create` 가
    // 수행한다 — sink 가 osc/exit 이벤트에 실을 id 는 factory 인자로 받는다
    // (id 선발급 계약). spawn(프로세스 생성 — 수십 ms 이상)이 포함되므로
    // blocking 스레드에서 돌린다.
    let manager = Arc::clone(&state.manager);
    let opts = SessionOptions {
        replay_cap: REPLAY_CAP,
        high_water: HIGH_WATER,
        low_water: LOW_WATER,
        // frozen 하네스에는 표식을 낼 셸 래퍼가 없다 — 감시를 켜면 모든 세션이
        // 마감을 넘긴다.
        startup_deadline: None,
    };
    let spec = default_spawn_spec(cols, rows);
    tauri::async_runtime::spawn_blocking(move || {
        manager.create(spec, opts, |id| {
            Box::new(ChannelSink::new(id, on_output, app))
        })
    })
    .await
    .map_err(|err| format!("spawn task join failed: {err}"))?
    .map_err(|err| format!("failed to spawn terminal: {err:#}"))
}

#[tauri::command]
pub async fn write_stdin(
    state: State<'_, AppState>,
    id: SessionId,
    data: String,
) -> Result<(), String> {
    let session = session(&state, id)?;
    tauri::async_runtime::spawn_blocking(move || session.write(data.as_bytes()))
        .await
        .map_err(|err| format!("write task join failed (id={id}): {err}"))?
        .map_err(|err| format!("write_stdin failed (id={id}): {err:#}"))
}

#[tauri::command]
pub async fn send_raw(
    state: State<'_, AppState>,
    id: SessionId,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let session = session(&state, id)?;
    tauri::async_runtime::spawn_blocking(move || session.write(&bytes))
        .await
        .map_err(|err| format!("write task join failed (id={id}): {err}"))?
        .map_err(|err| format!("send_raw failed (id={id}): {err:#}"))
}

#[tauri::command]
pub async fn resize(
    state: State<'_, AppState>,
    id: SessionId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // ConPTY resize는 conhost 채널을 경유하므로 이론상 블록 가능 — write와 같은 경로로 내린다.
    let session = session(&state, id)?;
    tauri::async_runtime::spawn_blocking(move || session.resize(cols, rows))
        .await
        .map_err(|err| format!("resize task join failed (id={id}): {err}"))?
        .map_err(|err| format!("resize failed (id={id}): {err:#}"))
}

#[tauri::command]
pub fn ack_output(state: State<'_, AppState>, id: SessionId, n: usize) -> Result<(), String> {
    // ack는 뮤텍스 갱신 + condvar notify뿐이라 블로킹하지 않는다 — sync로 즉시 처리해
    // paused 세션이 최대한 빨리 재개되게 한다.
    let session = session(&state, id)?;
    session.ack(n);
    Ok(())
}

/// replay 스냅샷도 터미널 출력이므로 JSON 배열이 아니라 raw body로 되돌린다 —
/// 프론트엔드 `invoke`는 ArrayBuffer를 받는다.
#[tauri::command]
pub fn replay(state: State<'_, AppState>, id: SessionId) -> Result<Response, String> {
    let session = session(&state, id)?;
    Ok(Response::new(session.replay()))
}

#[tauri::command]
pub fn close_terminal(state: State<'_, AppState>, id: SessionId) -> Result<(), String> {
    // `SessionManager::remove` 는 레지스트리 lock 을 놓은 뒤 kill 한다 (코어
    // 계약) — 자식 kill 신호가 먼저 나가므로, 블록 중이던 write 가 있어도 자식
    // 종료(EPIPE)로 풀린다. kill 은 신호 전송 + fd 회수뿐이라 sync 로 충분하다.
    if state.manager.remove(id) {
        Ok(())
    } else {
        Err(format!("unknown terminal id: {id}"))
    }
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> Vec<SessionStatsDto> {
    // 코어 `stats()` 가 레지스트리 lock 을 놓은 채 세션별 stats 를 뜨고
    // id 오름차순으로 정렬해 (id, stats) 쌍을 돌려준다.
    state
        .manager
        .stats()
        .into_iter()
        .map(|(id, stats)| SessionStatsDto {
            id,
            bytes_out: stats.bytes_out,
            pending: stats.pending,
            paused: stats.paused,
            osc_count: stats.osc_count,
            last_osc: stats.last_osc,
            alive: stats.alive,
        })
        .collect()
}
