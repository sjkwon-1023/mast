//! 라우트별 응답 만들기. 소켓을 만지지 않는다 — 본문 읽기는 [`crate::server`] 가 하고
//! 여기 오는 것은 이미 모인 바이트다.
//!
//! 이 모듈의 규율 하나는 **Dispatcher lock 안에서 하는 일의 크기**다. 그 lock 은 글루
//! 전역이 `.lock().unwrap()` 으로 쓰는 것이라, 원격 스레드가 그 안에서 패닉하면 poison
//! 이 데스크톱까지 번져 앱이 죽는다. 그래서 lock 안에서는 스냅샷 직렬화와 탭 순회만
//! 하고, 인덱싱·`unwrap`·패닉 가능 연산을 두지 않는다. `lock()` 자체도 `match` 로 받아
//! 이미 poisoned 인 경우 500 으로 답한다 (ADR-0016 결정 4).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use mast_core::command::Dispatcher;
use mast_core::model::{TabId, TabKind, TerminalStatus};
use mast_core::session::{LeaseRenewal, PtySession, SessionId, SessionManager};

use crate::routes::ResizeMode;
use crate::server::{log_line, AssetFn, LogFn, Response};

/// 클라이언트에게는 불투명 값이다.
pub(crate) fn session_token(epoch: u64, id: SessionId) -> String {
    format!("{epoch}:{id}")
}

/// `GET /api/state` — 데스크톱의 `state-changed` 와 같은 JSON 이다.
pub(crate) fn state(dispatcher: &Mutex<Dispatcher>) -> Response {
    let encoded = {
        let Ok(guard) = dispatcher.lock() else {
            return unavailable();
        };
        serde_json::to_vec(&guard.snapshot())
    };
    match encoded {
        Ok(body) => Response::ok("application/json", body),
        Err(_) => unavailable(),
    }
}

/// `GET /api/tabs/{id}/screen` 의 요청 재료 — 요청 하나의 좌표(탭·오프셋·세션 토큰)가
/// 함께 다니므로 묶었다. 서버가 라우트에서 뜯어 온 값을 그대로 싣는다.
pub(crate) struct ScreenRequest<'a> {
    pub tab: u64,
    pub since: Option<u64>,
    /// 지금 세션과 같은지 비교할 뿐, 모양은 보지 않는 불투명 토큰이다.
    pub session: Option<&'a str>,
}

/// `GET /api/tabs/{id}/screen`.
///
/// `since` 를 그대로 믿지 않는다: 세션 토큰이 없거나 지금 세션의 것이 아니면 그 오프셋은
/// **다른 세션의 좌표**라 reset 으로 되돌린다 (탭 Restart·앱 재시작 — ADR-0016 결정 6).
///
/// 토큰이 맞은 폴은 모바일 크기 리스의 **하트비트**이기도 하다 (`lease`) — 이 탭을
/// 지금 보고 있는 클라이언트가 있다는 뜻이므로, 폰이 소유한 크기는 폴이 이어지는 동안
/// 유지된다. 리스가 이미 지났으면 여기서 데스크톱 크기로 복원되고, 이어지는
/// `screen_since` 가 복원된 크기·소유자를 그대로 보고한다 (폰이 끊긴 뒤 돌아온 폴이
/// 곧바로 데스크톱 화면을 받는 경로). 토큰이 맞지 않는 폴은 하트비트가 아니다 —
/// 어느 세션을 보고 있는지 모르는 요청으로 소유권을 연장할 수는 없다.
pub(crate) fn screen(
    dispatcher: &Mutex<Dispatcher>,
    sessions: &SessionManager,
    epoch: u64,
    request: ScreenRequest<'_>,
    lease: Duration,
    log: &LogFn,
) -> Response {
    let ScreenRequest {
        tab,
        since,
        session,
    } = request;
    let (id, pty) = match live_session(dispatcher, sessions, tab) {
        Ok(found) => found,
        Err(response) => return response,
    };
    let token = session_token(epoch, id);
    let since = match since {
        Some(since) if session == Some(token.as_str()) => {
            renew_lease(&pty, lease, log);
            Some(since)
        }
        // 토큰 없는 폴(첫 요청·↻)과 다른 세션의 토큰을 든 폴은 하트비트가 아니다 —
        // 이 탭의 지금 세션을 보고 있다는 근거가 없어 소유권을 연장하지 않는다.
        // (offset 도 예전처럼 reset 으로 되돌린다: 어느 세션의 좌표인지 모른다.)
        _ => None,
    };

    let screen = pty.screen_since(since);
    Response::ok("application/octet-stream", screen.bytes)
        .with_header("X-Mast-End-Offset", screen.end_offset.to_string())
        .with_header(
            "X-Mast-Reset",
            if screen.reset { "1" } else { "0" }.to_string(),
        )
        .with_header("X-Mast-Cols", screen.cols.to_string())
        .with_header("X-Mast-Rows", screen.rows.to_string())
        .with_header("X-Mast-Size-Owner", screen.size_owner.as_str().to_string())
        .with_header("X-Mast-Session", token)
}

/// 만료된 모바일 리스는 복원한다. 리스 연장 실패는 폴을 실패로 만들지 않는다 —
/// worst case 는 리스가 지나 데스크톱 크기로 돌아가는 것뿐이다 (복원 경로와 같은 결말).
fn renew_lease(pty: &PtySession, lease: Duration, log: &LogFn) {
    if let LeaseRenewal::Lapsed { cols, rows } = pty.renew_mobile_lease(lease) {
        log_line(
            log,
            format!("remote: mobile size lease lapsed; restored {cols}x{rows}"),
        );
    }
}

/// `POST /api/tabs/{id}/resize` — 폰의 Mobile/Desktop 버튼.
///
/// 모바일 크기는 상한·하한으로 자른다: 폰이 글자 크기로 계산한 값은 기기·폰트에 따라
/// 넓게 흔들리고, TUI 가 성립하지 않는 극단(1열·3행)은 잘라야 한다. 적용값을
/// 헤더로 돌려주므로 클라이언트는 잘렸다는 사실을 알고 버튼 상태를 맞출 수 있다.
pub(crate) fn resize(pty: &PtySession, mode: ResizeMode, lease: Duration, log: &LogFn) -> Response {
    let outcome = match mode {
        ResizeMode::Mobile { cols, rows } => pty.resize_mobile(
            cols.clamp(MIN_MOBILE_COLS, MAX_MOBILE_COLS),
            rows.clamp(MIN_MOBILE_ROWS, MAX_MOBILE_ROWS),
            lease,
        ),
        ResizeMode::Desktop => pty.release_mobile_size(),
    };
    match outcome {
        Ok(()) => {
            let (cols, rows) = pty.size();
            Response::ok_empty()
                .with_header("X-Mast-Size-Owner", pty.size_owner().as_str().to_string())
                .with_header("X-Mast-Cols", cols.to_string())
                .with_header("X-Mast-Rows", rows.to_string())
        }
        Err(e) => {
            log_line(log, format!("remote: resize failed: {e}"));
            Response::error(500, "Internal Server Error", "resize failed")
        }
    }
}

/// 모바일 크기 요청의 하한·상한. 하한은 TUI 가 성립하는 최소치, 상한은 폰에서
/// 계산될 수 있는 값보다 넉넉하되 PTY 자체가 비정상이 될 만한 크기를 막는 선이다.
const MIN_MOBILE_COLS: u16 = 20;
const MAX_MOBILE_COLS: u16 = 400;
const MIN_MOBILE_ROWS: u16 = 5;
const MAX_MOBILE_ROWS: u16 = 150;

/// 입력·크기 변경처럼 **이 탭의 지금 세션에 작용하는** 요청의 대상 세션을 찾는다 —
/// 본문을 읽기 전에 부른다 (input 의 프레이밍 검사 순서).
///
/// 세션 토큰이 없는 것과 다른 세션의 것은 같은 결론이다: 폰이 보고 있던 셸이 지금 이
/// 탭의 셸이라는 근거가 없으므로 건드리지 않는다.
pub(crate) fn resolve_session(
    dispatcher: &Mutex<Dispatcher>,
    sessions: &SessionManager,
    epoch: u64,
    tab: u64,
    session: Option<&str>,
) -> Result<Arc<PtySession>, Response> {
    let Some(given) = session else {
        return Err(session_changed());
    };
    let (id, pty) = live_session(dispatcher, sessions, tab)?;
    if given != session_token(epoch, id) {
        return Err(session_changed());
    }
    Ok(pty)
}

/// 모인 본문을 PTY 에 그대로 쓴다 — CR 도 개행도 덧붙이지 않는다. 무엇을 보낼지는
/// 클라이언트의 인코더가 정한다 (ADR-0016 결정 7: bracketed paste·CR 분리 전송).
pub(crate) fn write_input(pty: &PtySession, body: &[u8], log: &LogFn) -> Response {
    match pty.write(body) {
        Ok(()) => Response::ok_empty(),
        Err(e) => {
            log_line(log, format!("remote: input write failed: {e}"));
            Response::error(500, "Internal Server Error", "write failed")
        }
    }
}

/// 키 게이트는 라우터가 이미 지났고, 여기서는 콜백이 준 것만 내보낸다.
pub(crate) fn static_asset(assets: &AssetFn, key: &str) -> Response {
    match (assets.as_ref())(key) {
        Some(asset) => Response::ok(&asset.mime_type, asset.bytes),
        None => Response::error(404, "Not Found", "not found"),
    }
}

/// 탭 → 살아 있는 세션. **살아 있음의 판정은 `TerminalStatus`** 까지 본다: `NotStarted`
/// 탭은 `pty_session` 을 그대로 들고 있어(감지가 세션을 죽이지 않는다) id 만 보면
/// 시작도 못 한 탭을 살아 있다고 답하게 된다. `Exited` 탭은 세션을 이미 놓았으므로
/// (ADR-0018) 두 검사 중 어느 쪽에서든 걸린다.
fn live_session(
    dispatcher: &Mutex<Dispatcher>,
    sessions: &SessionManager,
    tab: u64,
) -> Result<(SessionId, Arc<PtySession>), Response> {
    let found = {
        let Ok(guard) = dispatcher.lock() else {
            return Err(unavailable());
        };
        find_terminal(&guard, TabId(tab))
    };
    let Some(found) = found else {
        return Err(Response::error(404, "Not Found", "unknown tab"));
    };
    // 뷰어 탭·죽은 탭·레지스트리에서 이미 사라진 세션은 전부 같은 결론이다.
    let (Some(id), TerminalStatus::Running) = (found.session, found.status) else {
        return Err(no_live_session());
    };
    match sessions.get(id) {
        Some(pty) => Ok((id, pty)),
        None => Err(no_live_session()),
    }
}

/// Dispatcher lock 안에서 꺼내 오는 전부.
struct FoundTab {
    session: Option<SessionId>,
    status: TerminalStatus,
}

/// 뷰어 탭이면 세션 없음(`status` 는 `Exited`)으로 접어 돌려준다 — 호출자에게는
/// "터미널이 아니다"와 "세션이 없다"가 같은 응답이다.
fn find_terminal(dispatcher: &Dispatcher, tab: TabId) -> Option<FoundTab> {
    for workspace in &dispatcher.state().workspaces {
        for pane in workspace.panes.values() {
            for candidate in &pane.tabs {
                if candidate.id != tab {
                    continue;
                }
                return Some(match candidate.kind {
                    TabKind::Terminal {
                        pty_session,
                        status,
                        ..
                    } => FoundTab {
                        session: pty_session,
                        status,
                    },
                    _ => FoundTab {
                        session: None,
                        status: TerminalStatus::Exited {
                            code: None,
                            ended_at_ms: None,
                        },
                    },
                });
            }
        }
    }
    None
}

fn no_live_session() -> Response {
    Response::error(409, "Conflict", "tab has no live session")
}

fn session_changed() -> Response {
    Response::error(409, "Conflict", "session changed")
}

/// Dispatcher lock 이 poisoned 이거나 직렬화가 실패했다 — 상태를 말할 수 없다는 뜻이지
/// 요청이 잘못됐다는 뜻이 아니다.
fn unavailable() -> Response {
    Response::error(500, "Internal Server Error", "state unavailable")
}
