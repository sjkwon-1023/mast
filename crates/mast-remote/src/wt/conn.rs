//! 인증된 연결 하나의 수명 — 첫 스트림·auth 프레임·요청 루프.
//!
//! 여기서 지키는 순서가 곧 보안 계약이다: **auth 프레임을 처리하기 전에는 상태·화면·
//! 입력을 만들지 않는다**. 첫 프레임이 auth 가 아니면 그 자리에서 401 로 끝내고, 토큰
//! 비교는 상수 시간이며, 실패 횟수는 IP 단위로만 기록된다 (토큰도 입력도 로그에 남기지
//! 않는다). 인증된 연결은 서버에 하나뿐이다 — 두 번째가 같은 토큰으로 이겨도
//! compare-exchange 에서 지고 409 로 끝난다.
//!
//! 요청은 **순차 처리**다. 그래서 "동시 미완료 요청 최대 1개"가 자료구조가 아니라
//! 제어 흐름으로 보장되고, 입력 순서도 스트림 순서 그대로다.
//!
//! 인증 전 단계(응답 헤더 → 첫 스트림 → 첫 프레임)는 하나의 총 마감을 공유하고,
//! 실패하는 모든 경로가 세션을 닫는다 — `Session::new` 가 띄운 수신 task 가
//! `Connection` clone 을 쥐고 있어 drop 만으로는 quinn 의 implicit close 가 일어나지
//! 않기 때문이다. 인증 뒤의 입력 쓰기는 시작된 뒤에는 취소할 수 없지만, 기다림에는
//! 상한이 있어 막힌 쓰기가 세션 전체를 응답 불능으로 만들지 않는다.
//!
//! 로그에 실리는 오류는 분류명이거나 한 줄로 정리한 값이다. peer 가 정한 close
//! reason 은 lossy UTF-8 로 오류 문자열에 들어오므로 그대로 포맷하면 개행·가짜 줄을
//! 주입할 수 있다.

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use mast_core::command::Dispatcher;
use mast_core::session::SessionManager;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, timeout_at};
use web_transport_quinn::{RecvStream, Request, SendStream};

use crate::handlers;
use crate::ratelimit::RateLimiter;
use crate::server::{log_line, LogFn};
use crate::token::token_matches;

use super::protocol::{self, Payload};
use super::server::{AuthDecision, SecureRemoteTimeouts};
use super::writer::{Job, SubmitError, WriterLease};

/// 연결 task → 런타임. 인증 여부가 서버 수명을 가른다.
pub(crate) enum ConnEvent {
    Authenticated,
    /// `ip` 는 IP 단위 미인증 슬롯 회계에 필요하다 (accept 루프가 센다).
    Closed {
        ip: IpAddr,
        authenticated: bool,
    },
}

/// 런타임과 연결 task 가 공유하는 전부. 토큰은 여기에만 있고 응답·로그로 나가지 않는다.
pub(crate) struct ServerShared {
    pub(crate) dispatcher: Arc<Mutex<Dispatcher>>,
    pub(crate) sessions: Arc<SessionManager>,
    /// 세션 토큰의 앞자리 — Secure Remote 시작마다 새로 뽑는다 (HTTP 표면의 epoch 와
    /// 같은 이유: 재시작 뒤 SessionId 가 1 부터 다시 발급돼도 옛 오프셋의 입력이 새
    /// 셸에 들어가지 않게 한다).
    pub(crate) epoch: u64,
    pub(crate) token: String,
    pub(crate) log: LogFn,
    pub(crate) timeouts: SecureRemoteTimeouts,
    /// 이 서버가 쥔 쓰기 슬롯 소유권. coordinator 는 호출자 것이고 여기에는 lease 만 있다.
    pub(crate) lease: Arc<WriterLease>,
    pub(crate) rate: Mutex<RateLimiter>,
    /// 취소/인증 승인을 원자적으로 판정하는 게이트 (수명 소유자는 `server`).
    pub(crate) handle: Arc<super::server::Handle>,
    pub(crate) events: mpsc::UnboundedSender<ConnEvent>,
}

impl ServerShared {
    /// poisoned 여도 계속 센다 — 실패 카운터를 버리는 것은 차단을 푸는 것과 같다.
    pub(crate) fn rate(&self) -> std::sync::MutexGuard<'_, RateLimiter> {
        self.rate.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 인증 전 실패 하나를 IP 단위로 세고 로그 한 줄을 남긴다. 반환값은 **이 실패로
    /// 차단이 걸렸는가** — 호출자가 401/400 대신 429 를 고를 수 있다.
    ///
    /// 토큰 불일치뿐 아니라 핸드셰이크·스트림·프레임 실패와 타임아웃도 센다. 그래야
    /// 슬롯을 굶기는 것만으로 IP당 차단 전에 무한히 반복할 수 없다 (`reason` 은 호출자가
    /// 만든 한 줄짜리 분류명이고 peer 값을 그대로 싣지 않는다).
    pub(crate) fn record_failure(&self, ip: IpAddr, reason: &str) -> bool {
        let now = Instant::now();
        let (blocked, failures) = {
            let mut rate = self.rate();
            let blocked = rate.record_failure(ip, now);
            (blocked, rate.failures_in_window(ip, now))
        };
        log_line(
            &self.log,
            format!("secure-remote: {reason} from {ip} ({failures} in window)"),
        );
        blocked
    }
}

/// 연결 하나를 끝까지 처리하고 종료 이벤트를 보낸다. 패닉하지 않는 것이 계약이다 —
/// 패닉하면 인증 카운터가 영원히 줄지 않는다.
pub(crate) async fn handle(
    request: Request,
    shared: Arc<ServerShared>,
    deadline: tokio::time::Instant,
) {
    let ip = request.conn().remote_address().ip();
    let authenticated = serve(request, &shared, deadline).await;
    let _ = shared.events.send(ConnEvent::Closed { ip, authenticated });
}

/// 반환값은 "인증된 연결이었는가" — true 면 서버 전체가 수명을 다한다.
///
/// 인증 전 실패는 **모두** 세션(또는 핸드셰이크 전이면 QUIC 연결)을 닫고 나간다.
/// `Session::new` 가 띄운 수신 task 가 `Connection` clone 과 CONNECT recv 스트림을
/// 쥐고 있어서, drop 만으로는 quinn 의 implicit close 가 일어나지 않는다 — 닫지 않으면
/// 미인증 연결이 QUIC idle(30초)까지 살아 남고, 슬롯 회계와 무관하게 쌓일 수 있다.
async fn serve(request: Request, shared: &ServerShared, deadline: tokio::time::Instant) -> bool {
    let ip = request.conn().remote_address().ip();
    let conn = request.conn().clone();
    // 인증 전 단계(응답 헤더 → 첫 스트림 → 첫 프레임)의 **총** 마감이다. 단계마다 같은
    // `auth` 를 새로 주면 최대 세 배가 열린 채 남는다 — 계획의 "연결 후 10초".
    // QUIC 수락 시 만든 마감을 이어받아 CONNECT 이전 대기도 포함한다.

    let session = match timeout_at(deadline, request.ok()).await {
        Ok(Ok(session)) => session,
        Ok(Err(e)) => {
            shared.record_failure(
                ip,
                &format!("handshake failure ({})", server_error_label(&e)),
            );
            conn.close(0u32.into(), b"handshake failed");
            return false;
        }
        Err(_) => {
            // 응답 헤더도 보내지 못한 연결이다 — 아직 Session 이 없으므로 연결을 직접 닫는다.
            shared.record_failure(ip, "handshake timeout");
            conn.close(0u32.into(), b"handshake timeout");
            return false;
        }
    };

    // ① 첫 bidirectional stream. 여기서 늦어지면 auth 자체가 없는 연결이다.
    let (mut send, mut recv) = match timeout_at(deadline, session.accept_bi()).await {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            shared.record_failure(ip, &format!("stream failure ({})", session_error_label(&e)));
            session.close(0, b"stream failed");
            return false;
        }
        Err(_) => {
            shared.record_failure(ip, "auth stream timeout");
            session.close(0, b"auth timeout");
            return false;
        }
    };

    // ② 첫 프레임. 반드시 auth 여야 한다.
    let raw = match timeout_at(
        deadline,
        protocol::read_frame(&mut recv, protocol::MAX_FRAME_BYTES),
    )
    .await
    {
        Ok(Ok(raw)) => raw,
        Ok(Err(e)) => {
            shared.record_failure(ip, &format!("first frame failure ({e})"));
            session.close(0, b"frame failed");
            return false;
        }
        Err(_) => {
            shared.record_failure(ip, "auth frame timeout");
            session.close(0, b"auth timeout");
            return false;
        }
    };

    let request = match protocol::parse_request(&raw) {
        Ok(request) => request,
        Err(e) => {
            // 사유만 남긴다 — 프레임 내용은 로그로도 가지 않는다. 필드 **이름**은 peer 가
            // 정한 값이라 한 줄로 정리해서 싣는다.
            let _ = shared.record_failure(ip, &format!("bad first frame ({})", one_line(&e)));
            // id 가 읽히면 그 id 로 돌려준다 — 클라이언트가 pending 요청과 대조해 400 을
            // 화면에 띄울 수 있다. 없는 id 를 지어내지 않는다 (상관 불가 → 0).
            let id = protocol::request_id(&raw).unwrap_or(0);
            let _ = send_frame(
                &mut send,
                protocol::error_frame(id, 400, "bad request"),
                shared.timeouts,
            )
            .await;
            session.close(0, b"protocol error");
            return false;
        }
    };
    let auth_id = request.id;
    let Payload::Auth { token } = request.payload else {
        let blocked = shared.record_failure(ip, "first frame was not auth");
        let (status, message) = if blocked {
            (429, "too many requests")
        } else {
            (401, "unauthorized")
        };
        let _ = send_frame(
            &mut send,
            protocol::error_frame(auth_id, status, message),
            shared.timeouts,
        )
        .await;
        session.close(0, b"unauthorized");
        return false;
    };

    if !token_matches(&shared.token, &token) {
        // 토큰도 헤더도 남기지 않는다 — 출처와 횟수뿐이다.
        let blocked = shared.record_failure(ip, "auth failure");
        let (status, message) = if blocked {
            (429, "too many requests")
        } else {
            (401, "unauthorized")
        };
        let _ = send_frame(
            &mut send,
            protocol::error_frame(auth_id, status, message),
            shared.timeouts,
        )
        .await;
        session.close(0, b"unauthorized");
        return false;
    }

    // 인증된 연결은 하나뿐이다. 취소와의 승부는 게이트가 원자적으로 판정한다 —
    // 취소가 먼저 승인됐으면 여기서 지고, 인증이 먼저면 cancel() 이 false 를 돌려준다.
    match shared.handle.approve_auth() {
        AuthDecision::Approved => {}
        AuthDecision::AlreadyPaired => {
            log_line(
                &shared.log,
                format!("secure-remote: second session refused from {ip}"),
            );
            let _ = send_frame(
                &mut send,
                protocol::error_frame(auth_id, 409, "already paired"),
                shared.timeouts,
            )
            .await;
            session.close(0, b"already paired");
            return false;
        }
        AuthDecision::Cancelled => {
            log_line(
                &shared.log,
                format!("secure-remote: auth refused after cancel from {ip}"),
            );
            let _ = send_frame(
                &mut send,
                protocol::error_frame(auth_id, 503, "pairing cancelled"),
                shared.timeouts,
            )
            .await;
            session.close(0, b"pairing cancelled");
            return false;
        }
    }

    if send_frame(&mut send, protocol::ok_frame(auth_id, &[]), shared.timeouts)
        .await
        .is_err()
    {
        return true;
    }
    log_line(&shared.log, format!("secure-remote: paired with {ip}"));
    let _ = shared.events.send(ConnEvent::Authenticated);

    request_loop(&mut send, &mut recv, shared, auth_id, &session).await
}

/// 인증 뒤 요청 루프. `true` 는 인증된 연결이었다는 뜻이다.
async fn request_loop(
    send: &mut SendStream,
    recv: &mut RecvStream,
    shared: &ServerShared,
    first_id: u64,
    session: &web_transport_quinn::Session,
) -> bool {
    let mut last_id = first_id;
    loop {
        // 요청과 요청 사이의 유휴(30초)와, 시작된 프레임을 끝내는 마감(15초)이 다르다.
        let len = match timeout(
            shared.timeouts.idle,
            protocol::read_len(recv, protocol::MAX_FRAME_BYTES),
        )
        .await
        {
            Ok(Ok(len)) => len,
            Ok(Err(e)) => {
                log_line(&shared.log, format!("secure-remote: connection ended: {e}"));
                return true;
            }
            Err(_) => {
                log_line(&shared.log, "secure-remote: idle timeout".to_string());
                session.close(0, b"idle timeout");
                return true;
            }
        };
        let raw = match timeout(shared.timeouts.frame_io, protocol::read_payload(recv, len)).await {
            Ok(Ok(raw)) => raw,
            Ok(Err(e)) => {
                log_line(
                    &shared.log,
                    format!("secure-remote: frame read failed: {e}"),
                );
                return true;
            }
            Err(_) => {
                log_line(
                    &shared.log,
                    "secure-remote: frame read timed out".to_string(),
                );
                session.close(0, b"frame timeout");
                return true;
            }
        };

        let request = match protocol::parse_request(&raw) {
            Ok(request) => request,
            Err(e) => {
                log_line(
                    &shared.log,
                    format!("secure-remote: bad frame: {}", one_line(&e)),
                );
                // 실패한 프레임의 id 가 읽히면 그 id 로 돌려준다 — 그래야 클라이언트가
                // 자기 pending 과 대조해 400 을 그대로 보여 준다. 읽히지 않으면 0 으로
                // 닫는다 (지난 요청의 id 를 빌려 오면 상관만 어긋난다).
                let id = protocol::request_id(&raw).unwrap_or(0);
                let _ = send_frame(
                    send,
                    protocol::error_frame(id, 400, "bad request"),
                    shared.timeouts,
                )
                .await;
                session.close(0, b"protocol error");
                return true;
            }
        };
        // 요청 ID 는 단조 증가해야 한다 — 순서를 되돌리는 프레임은 재생·혼동의 신호라
        // 응답하지 않고 끊는다.
        if request.id <= last_id {
            log_line(
                &shared.log,
                format!(
                    "secure-remote: request id {} did not advance past {last_id}",
                    request.id
                ),
            );
            session.close(0, b"protocol error");
            return true;
        }
        last_id = request.id;

        let reply = handle_payload(request.id, request.payload, shared, session).await;
        let (frame, close) = match reply {
            Reply::Send(frame) => (frame, false),
            Reply::Close(frame) => (frame, true),
            // 클라이언트가 끊겼다 — 응답을 시도하지 않고 루프를 끝낸다. 여기서 돌아야
            // 종료 이벤트가 나가고 서버 수명이 끝난다.
            Reply::ConnectionClosed => return true,
        };
        if send_frame(send, frame, shared.timeouts).await.is_err() {
            return true;
        }
        if close {
            session.close(0, b"protocol error");
            return true;
        }
    }
}

/// 응답 하나. `Close` 는 보낸 뒤 연결을 끝내는 프로토콜 위반이고, `ConnectionClosed` 는
/// 응답할 상대가 이미 없다는 뜻이다.
enum Reply {
    Send(Vec<u8>),
    Close(Vec<u8>),
    ConnectionClosed,
}

async fn handle_payload(
    id: u64,
    payload: Payload,
    shared: &ServerShared,
    connection: &web_transport_quinn::Session,
) -> Reply {
    match payload {
        Payload::Auth { .. } => {
            // auth 는 첫 프레임 하나뿐이다.
            Reply::Close(protocol::error_frame(id, 400, "bad request"))
        }
        Payload::Heartbeat => Reply::Send(protocol::ok_frame(id, &[])),
        Payload::State => match handlers::state_bytes(&shared.dispatcher) {
            Ok(snapshot) => Reply::Send(protocol::state_ok_frame(id, &snapshot)),
            Err(error) => Reply::Send(protocol::error_frame(id, error.status(), error.message())),
        },
        Payload::Screen {
            tab,
            since,
            session,
        } => {
            let screen = match handlers::screen_data(
                &shared.dispatcher,
                &shared.sessions,
                shared.epoch,
                tab,
                since,
                session.as_deref(),
            ) {
                Ok(screen) => screen,
                Err(error) => {
                    return Reply::Send(protocol::error_frame(id, error.status(), error.message()))
                }
            };
            // replay 상한(1 MiB)과 모드 preamble 상한(64개)의 합을 넘는 화면은 계약
            // 위반이다 — 프레임 상한에 걸려 조용히 잘리는 것보다 명시적 오류가 낫다.
            if screen.bytes.len() > protocol::MAX_SCREEN_BYTES {
                log_line(
                    &shared.log,
                    format!(
                        "secure-remote: screen of {} bytes exceeds the contract",
                        screen.bytes.len()
                    ),
                );
                return Reply::Send(protocol::error_frame(id, 500, "screen too large"));
            }
            Reply::Send(protocol::ok_frame(
                id,
                &[
                    ("endOffset", Value::from(screen.end_offset)),
                    ("reset", Value::from(screen.reset)),
                    ("cols", Value::from(screen.cols)),
                    ("rows", Value::from(screen.rows)),
                    ("session", Value::from(screen.session)),
                    ("sizeOwner", Value::from(screen.size_owner.as_str())),
                    ("bytes", Value::from(protocol::encode_bytes(&screen.bytes))),
                ],
            ))
        }
        Payload::Input { tab, session, data } => {
            let pty = match handlers::resolve_session(
                &shared.dispatcher,
                &shared.sessions,
                shared.epoch,
                tab,
                Some(&session),
            ) {
                Ok(pty) => pty,
                Err(error) => {
                    return Reply::Send(protocol::error_frame(id, error.status(), error.message()))
                }
            };
            let (done_tx, done_rx) = oneshot::channel();
            let log = Arc::clone(&shared.log);
            let job = Job::new(
                move || handlers::write_input(&pty, &data, &log).map_err(str::to_string),
                done_tx,
            );
            match shared.lease.submit(job) {
                Ok(()) => {}
                // 이전 페어링의 막힌 쓰기가 슬롯을 쥐고 있다 — 큐에 넣지 않고 그대로
                // 거절한다. 클라이언트는 같은 요청을 나중에 다시 보낼 수 있다.
                Err(SubmitError::Busy) => {
                    return Reply::Send(protocol::error_frame(id, 503, "input busy"))
                }
                Err(SubmitError::Stopped) => {
                    return Reply::Send(protocol::error_frame(id, 503, "server stopping"))
                }
                Err(SubmitError::Unavailable) => {
                    log_line(
                        &shared.log,
                        "secure-remote: cannot start an input write thread".to_string(),
                    );
                    return Reply::Send(protocol::error_frame(id, 500, "write failed"));
                }
            }
            // 쓰기가 막혀 있는 동안 클라이언트가 끊기거나 서버가 종료되면
            // `done_rx` 는 영원히 오지 않는다 — 연결 종료와 경쟁시켜 여기서 빠져나와야
            // 종료 이벤트가 나가고 서버 수명이 끝난다 (그러지 않으면 인증 후에는 대기
            // 타이머도 없어 포트가 영원히 남는다).
            //
            // 브라우저가 **붙어 있는 채로** PTY 쓰기만 막힌 경우에도 같은 문제가 된다:
            // 이 await 에 상한이 없으면 그 세션은 어떤 요청에도 응답하지 못하고,
            // 데스크톱에는 세션을 끊는 경로가 없어 재페어링 전까지 복구되지 않는다.
            // `frame_io` 안에서 끝나지 않으면 명시적 실패를 보내고 요청 루프로 돌아온다.
            // **이미 시작한 쓰기는 취소하지 않는다** — 슬롯은 그대로 busy 이고 다음
            // 입력은 `input busy` 로 거절된다.
            let wait = async {
                tokio::select! {
                    result = done_rx => Some(result),
                    _ = connection.closed() => None,
                }
            };
            match timeout(shared.timeouts.frame_io, wait).await {
                Ok(Some(result)) => match result {
                    Ok(Ok(())) => Reply::Send(protocol::ok_frame(id, &[])),
                    Ok(Err(_)) => Reply::Send(protocol::error_frame(id, 500, "write failed")),
                    // 워커가 결과를 보내기 전에 사라진 경우 (프로세스 종료 경로).
                    Err(_) => Reply::Send(protocol::error_frame(id, 500, "write failed")),
                },
                Ok(None) => {
                    log_line(
                        &shared.log,
                        "secure-remote: client disconnected during an input write".to_string(),
                    );
                    Reply::ConnectionClosed
                }
                Err(_) => {
                    log_line(
                        &shared.log,
                        "secure-remote: an input write did not finish in time".to_string(),
                    );
                    Reply::Send(protocol::error_frame(id, 503, "input write timed out"))
                }
            }
        }
    }
}

/// peer 가 정한 값이 로그 줄을 넘어가지 않게 제어문자를 지우고 길이를 자른다. 프레임
/// 파싱 오류의 `unknown field: <name>` 처럼 필드 **이름**에 peer 입력이 섞인다.
fn one_line(text: impl std::fmt::Display) -> String {
    let mut out = String::new();
    for (index, ch) in text.to_string().chars().enumerate() {
        if index >= 96 {
            break;
        }
        if ch.is_control() {
            out.push('?');
        } else {
            out.push(ch);
        }
    }
    out
}

/// 핸드셰이크 오류를 분류명으로만 줄인다 — `ServerError` 의 `Display` 는
/// `ConnectionError(ApplicationClosed)` 를 거쳐 peer 의 close reason 을 그대로 싣는다.
fn server_error_label(e: &web_transport_quinn::ServerError) -> &'static str {
    use web_transport_quinn::ServerError;
    match e {
        ServerError::UnexpectedEnd => "unexpected end of stream",
        ServerError::Connection(_) => "connection lost",
        ServerError::WriteError(_) => "write failed",
        ServerError::ReadError(_) => "read failed",
        ServerError::SettingsError(_) => "h3 settings failed",
        ServerError::ConnectError(_) => "h3 connect failed",
        ServerError::IoError(_) => "io error",
        ServerError::Rustls(_) => "tls error",
    }
}

/// `Session` 쪽 오류도 같은 이유로 분류명만 남긴다.
fn session_error_label(e: &web_transport_quinn::SessionError) -> &'static str {
    use web_transport_quinn::SessionError;
    match e {
        SessionError::ConnectionError(_) => "connection lost",
        SessionError::WebTransportError(_) => "session closed",
        SessionError::SendDatagramError(_) => "datagram error",
    }
}

/// 응답 프레임 하나를 `frame_io` 마감 안에 쓴다. 실패는 연결이 이미 죽었다는 뜻이라
/// 호출자는 이유를 구분하지 않고 루프를 끝낸다.
async fn send_frame(
    send: &mut SendStream,
    frame: Vec<u8>,
    timeouts: SecureRemoteTimeouts,
) -> Result<(), ()> {
    match timeout(timeouts.frame_io, protocol::write_frame(send, &frame)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) | Err(_) => Err(()),
    }
}
