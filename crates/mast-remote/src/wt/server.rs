//! Secure Remote 서버 — QUIC 엔드포인트·인증서·단일 연결의 수명.
//!
//! 수명 규칙(계획): **Secure Remote 를 시작할 때만** UDP 리스너와 런타임이 열린다.
//! QR 대기는 [`SecureRemoteTimeouts::wait`] 안에서 끝나고, 인증된 **단일** 연결이
//! 끝나거나 유휴가 지나면 엔드포인트·연결·TLS 설정·개인키가 함께 끝난다. 다음 페어링은
//! 새 토큰과 새 인증서로 시작한다. Local HTTP 표면의 수명과는 무관하다.
//!
//! 종료 순서가 계약이다: `server.close` → 엔드포인트 drop(소켓 회수) → lease 닫기.
//! PTY 쓰기는 별도 스레드라( [`super::writer`] ) 이 순서가 막힐 수 없고, 이미 시작한
//! 쓰기는 취소되지 않는다는 한계만 남는다. 쓰기 슬롯은 [`SecureRemoteDeps::writer`] 가
//! 소유하는 공유 coordinator 에 있고, `start` 는 그 coordinator 에서 이 서버 몫의
//! [`WriterLease`] 만 받는다 — 그래야 이전 페어링의 막힌 쓰기가 다음 페어링에 보인다.
//!
//! accept 루프는 CONNECT 거절을 **직접 await 하지 않는다**. 거절 응답은
//! [`MAX_CONCURRENT_REJECTIONS`] 개로 상한을 둔 독립 task 가 보내고(각 task 본체는
//! [`REJECT_GRACE`] 상한을 가진다), 슬롯이 없으면 그 자리에서 연결만 닫는다. 그래서
//! 거절 한 건이 루프를 늦추거나 QR 대기 창을 굶길 수 없고, `stop()`·Drop 의 join 도
//! task 를 기다리지 않는다 — 남은 task 는 런타임 drop 과 함께 사라지고 연결·소켓
//! 정리는 그대로 끝난다. 루프가 await 하는 나머지 구간은 [`SecureRemoteTimeouts`]
//! 상한을 가진다.

use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use mast_core::command::Dispatcher;
use mast_core::session::SessionManager;
use tokio::sync::{mpsc as tokio_mpsc, Notify, Semaphore};
use web_transport_quinn::http::StatusCode;
use web_transport_quinn::{Request, Server, ServerBuilder};

use crate::ratelimit::{RateLimiter, DEFAULT_CAP};
use crate::server::{log_line, LogFn};

use super::cert::Certificate;
use super::conn::{self, ConnEvent, ServerShared};
use super::writer::{InputWriter, WriterLease};

/// 미인증 QUIC 연결의 동시 상한 — 인증 전 연결이 QR 대기 창을 독점하지 못하게 한다.
const MAX_UNAUTHENTICATED: usize = 4;
/// 같은 IP 하나가 쥘 수 있는 미인증 연결 수. 남는 슬롯이 다른 기기(진짜 폰)에 남는다.
///
/// 2 인 이유: 클라이언트가 끊겨도 서버는 그 연결의 첫 프레임 마감(최대 `auth`)까지
/// 슬롯을 쥐고 있으므로, 1 이면 곧바로 재시도하는 같은 기기를 거절할 수 있다. 대가로
/// 폰과 공격자가 **같은 IP**(예: 폰 위의 악성 앱)면 그 폰도 2 슬롯을 나눠 써야 한다.
const MAX_UNAUTHENTICATED_PER_IP: usize = 2;
/// CONNECT 거절(HTTP 상태)을 peer 에게 보내 줄 기회. peer 가 응답 헤더용 QUIC send
/// credit 을 주지 않으면 이 시간만 기다리고 연결을 명시적으로 닫는다 — 그러지 않으면
/// 거절 task 하나가 그 peer 에 묶여 상한 없이 남는다.
const REJECT_GRACE: Duration = Duration::from_secs(2);
/// 동시에 살아 있을 수 있는 거절 응답 task 수. 각 task 는 최대 [`REJECT_GRACE`] 를
/// 쓰므로, 이 수가 "거절 때문에 동시에 붙들리는 연결(task·요청)"의 상한이다. 슬롯이
/// 없으면 새 거절은 응답을 포기하고 연결만 즉시 닫는다 — 요청을 큐에 쌓지 않는다.
const MAX_CONCURRENT_REJECTIONS: usize = 4;
/// 시작 스레드가 바인드 결과를 돌려주길 기다리는 상한. 바인드는 즉시 끝난다.
const START_TIMEOUT: Duration = Duration::from_secs(5);
/// 기본 유효기간 상한. 테스트가 짧게 줄일 수 있게 설정으로 뺐다.
#[derive(Debug, Clone, Copy)]
pub struct SecureRemoteTimeouts {
    /// QR 대기 — 이 시간이 지나면 인증 전 연결까지 닫고 끝난다.
    pub wait: Duration,
    /// 인증 전 단계 **전체**(QUIC → HTTP/3 CONNECT → 첫 auth 프레임)에 걸리는
    /// 공유 마감. 단계마다 새로 주지 않는다 — 그러면 최대 세 배가 열린 채 남는다.
    pub auth: Duration,
    /// 시작된 프레임의 읽기·응답 쓰기에 걸리는 마감. 인증 뒤 막힌 입력 쓰기를
    /// 기다리는 상한이기도 하다 (지나면 503 `input write timed out`).
    pub frame_io: Duration,
    /// 인증된 연결에서 요청·heartbeat 사이의 유휴 상한.
    pub idle: Duration,
}

impl Default for SecureRemoteTimeouts {
    fn default() -> Self {
        Self {
            wait: Duration::from_secs(120),
            auth: Duration::from_secs(10),
            frame_io: Duration::from_secs(15),
            idle: Duration::from_secs(30),
        }
    }
}

pub struct SecureRemoteConfig {
    /// UDP 바인드 주소. 포트 충돌은 조용한 대체 없이 [`SecureRemote::start`] 의 실패다.
    pub bind: SocketAddr,
    /// 인증서 SAN 에 들어가는 이 머신의 LAN IPv4.
    pub lan_ip: Ipv4Addr,
    /// 허용하는 단 하나의 Origin (경로 없음, 예: `https://sjkwon-1023.github.io`).
    pub origin: String,
    /// 이번 페어링의 토큰. CSPRNG 32바이트의 base64url 43자 — 기존 HTTP 의
    /// `remote-token` 파일과는 별개다.
    pub token: String,
    pub timeouts: SecureRemoteTimeouts,
}

pub struct SecureRemoteDeps {
    pub dispatcher: Arc<Mutex<Dispatcher>>,
    pub sessions: Arc<SessionManager>,
    pub log: LogFn,
    /// PTY 입력 쓰기를 실행하는 **호출자 소유** coordinator. 앱 수명 동안 하나를 두고
    /// 모든 `start` 가 같은 것을 넘긴다. `start` 안에서 만들지 않는 이유: 이전 페어링의
    /// 막힌 쓰기가 다음 페어링의 슬롯에 보여야 새 입력을 busy 로 거절할 수 있다.
    pub writer: Arc<InputWriter>,
}

/// 서버가 스스로 도는 상태. `Idle` 은 종료가 끝났다는 뜻이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecureRemoteState {
    Idle,
    Starting,
    Waiting,
    Connected,
    Stopping,
}

/// 시작 실패의 사유 — 글루가 UI 에 그대로 보여 줄 수 있게 문자열로 말한다.
#[derive(Debug)]
pub enum StartError {
    /// CSPRNG 를 못 얻었다. 약한 epoch 로 대체하지 않는다.
    Entropy(String),
    Certificate(rcgen::Error),
    /// 발급 직후 유효하지 않은 인증서 — 시계가 망가진 경우다.
    CertificateLifetime,
    Bind(String),
    Thread(String),
    /// 바인드 결과가 제때 오지 않았다.
    Timeout,
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::Entropy(e) => write!(f, "cannot draw a pairing epoch: {e}"),
            StartError::Certificate(e) => {
                write!(f, "cannot issue the secure remote certificate: {e}")
            }
            StartError::CertificateLifetime => {
                write!(f, "the issued certificate is not valid at the current time")
            }
            StartError::Bind(e) => write!(f, "cannot bind the secure remote UDP socket: {e}"),
            StartError::Thread(e) => write!(f, "cannot start the secure remote runtime: {e}"),
            StartError::Timeout => write!(f, "the secure remote runtime did not become ready"),
        }
    }
}

impl std::error::Error for StartError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StartError::Certificate(e) => Some(e),
            _ => None,
        }
    }
}

/// UI 스레드가 들고 있는 런타임 핸들.
pub(crate) struct Handle {
    state: Mutex<SecureRemoteState>,
    /// 취소와 인증 중 **먼저 승인된 쪽이 이긴다**는 판정을 직렬화하는 게이트.
    gate: Mutex<Gate>,
    stop: AtomicBool,
    notify: Notify,
}

/// 게이트가 기억하는 승인 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gate {
    /// 아직 아무도 승인하지 않았다.
    Open,
    /// 취소가 먼저 승인됐다 — 이후 인증은 거절된다.
    Cancelled,
    /// 인증이 먼저 승인됐다 — 이후 취소는 세션에 손대지 않는다.
    Authenticated,
}

/// 인증 시도가 게이트에서 받는 판정.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuthDecision {
    Approved,
    AlreadyPaired,
    /// 취소가 먼저 승인됐다 — 서버가 종료 중이므로 인증을 받아들이지 않는다.
    Cancelled,
}

impl Handle {
    fn new() -> Self {
        Self {
            state: Mutex::new(SecureRemoteState::Starting),
            gate: Mutex::new(Gate::Open),
            stop: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn set_state(&self, state: SecureRemoteState) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = state;
    }

    fn state(&self) -> SecureRemoteState {
        *self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 취소를 승인한다. 반환값은 "이 호출이 취소를 승인했는가"(또는 이미 취소됨).
    ///
    /// **state 를 읽고 나중에 플래그를 세우는 두 단계가 아니다** — 인증 승인과 같은
    /// lock 을 쓰므로, `Waiting` 을 읽은 뒤 인증이 완료되는 창이 없다. 인증이 먼저
    /// 승인됐으면 `false` 를 돌려주고 세션 수명에 맡긴다.
    fn cancel(&self) -> bool {
        let mut gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        match *gate {
            Gate::Open => {
                *gate = Gate::Cancelled;
                self.request_stop();
                true
            }
            Gate::Cancelled => true,
            Gate::Authenticated => false,
        }
    }

    /// 인증 성공을 승인한다. 취소가 먼저 승인됐으면 거절한다.
    pub(crate) fn approve_auth(&self) -> AuthDecision {
        let mut gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        match *gate {
            Gate::Open => {
                *gate = Gate::Authenticated;
                AuthDecision::Approved
            }
            Gate::Authenticated => AuthDecision::AlreadyPaired,
            Gate::Cancelled => AuthDecision::Cancelled,
        }
    }

    pub(crate) fn is_authenticated(&self) -> bool {
        *self.gate.lock().unwrap_or_else(|e| e.into_inner()) == Gate::Authenticated
    }

    fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // permit 이 저장되므로 accept 대기 중이 아니어도 다음 notified() 가 즉시 끝난다.
        self.notify.notify_one();
    }

    fn stop_requested(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    async fn stop_notified(&self) {
        self.notify.notified().await;
    }
}

/// 진행 중인 Secure Remote 서버 하나. `stop`/drop 이 런타임 스레드를 정리한다.
pub struct SecureRemote {
    handle: Arc<Handle>,
    thread: Option<JoinHandle<()>>,
    local_addr: SocketAddr,
    cert_hash: [u8; 32],
    cert_hash_base64: String,
}

impl SecureRemote {
    /// 인증서를 발급하고 UDP 를 바인드한 뒤 런타임 스레드를 띄운다.
    ///
    /// **바인드 실패는 여기서 동기로 돌아온다** — `start` 가 `Ok` 를 준 뒤에 포트가
    /// 없었다는 사실이 로그 한 줄로만 남는 일이 없어야 한다.
    ///
    /// 쓰기 슬롯은 [`SecureRemoteDeps::writer`] 가 소유하는 coordinator 에 있고, 여기서는
    /// 이 서버 몫의 lease 만 받는다. 그래서 이전 페어링의 막힌 쓰기가 있으면 이 서버의
    /// 입력은 busy 로 거절된다 — 세션마다 coordinator 를 새로 만들면 그 계약이 사라진다.
    pub fn start(cfg: SecureRemoteConfig, deps: SecureRemoteDeps) -> Result<Self, StartError> {
        let epoch =
            crate::server::random_epoch().map_err(|e| StartError::Entropy(e.to_string()))?;
        let cert = Certificate::generate(cfg.lan_ip).map_err(StartError::Certificate)?;
        // 발급 자체가 수명 확인이다: 새 인증서가 지금 유효하지 않으면 시계가 망가진 것이다.
        if !cert.is_valid_at(time::OffsetDateTime::now_utc()) {
            return Err(StartError::CertificateLifetime);
        }
        let cert_hash = cert.hash;
        let cert_hash_base64 = cert.hash_base64();
        let handle = Arc::new(Handle::new());
        // 이 서버 몫의 슬롯 소유권만 받는다 — coordinator 자체는 호출자가 계속 들고 있다.
        let lease = deps.writer.lease();
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("mast-secure-remote".into())
            .spawn({
                let handle = Arc::clone(&handle);
                move || runtime_main(cfg, deps, cert, epoch, handle, lease, ready_tx)
            })
            .map_err(|e| StartError::Thread(e.to_string()))?;

        match ready_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(local_addr)) => Ok(Self {
                handle,
                thread: Some(thread),
                local_addr,
                cert_hash,
                cert_hash_base64,
            }),
            Ok(Err(message)) => {
                let _ = thread.join();
                Err(StartError::Bind(message))
            }
            Err(RecvTimeoutError::Timeout) => {
                handle.request_stop();
                let _ = thread.join();
                Err(StartError::Timeout)
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = thread.join();
                Err(StartError::Thread(
                    "runtime thread exited before reporting a bind".to_string(),
                ))
            }
        }
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// QR 의 `cert` 값 (raw 32바이트).
    pub fn cert_hash(&self) -> &[u8; 32] {
        &self.cert_hash
    }

    /// QR 의 `cert` 값 (base64url 무패딩 43자).
    pub fn cert_hash_base64(&self) -> &str {
        &self.cert_hash_base64
    }

    pub fn state(&self) -> SecureRemoteState {
        self.handle.state()
    }

    /// 인증 전이면 닫는다. 인증된 세션의 수명은 세션 연결에 맡긴다.
    ///
    /// 반환값은 "닫으라고 지시했는가"다 — 인증이 먼저 승인된 연결이 있으면 `false`.
    /// 판정은 [`Handle::cancel`] 의 게이트에서 인증 승인과 원자적으로 경합한다.
    pub fn cancel(&self) -> bool {
        self.handle.cancel()
    }

    /// 인증 여부와 무관하게 닫고 런타임 스레드를 join 한다. UDP 포트는 돌아온 뒤
    /// 재바인드할 수 있다.
    ///
    /// join 은 거절 task 를 기다리지 않는다: accept 루프는 정지 신호를 즉시 보고,
    /// 아직 도는 거절 task 는 join 대상이 아니라 런타임 drop 과 함께 취소된다. 끝나면
    /// `close` + 250ms flush 다. 예외는 글루 핸들러가 동기로 잡는 `Dispatcher`
    /// lock 이며( [`super::conn`] ), 그 lock 이 오래 잡히면 이 join 도 같이 기다린다 —
    /// 그 구간의 실제 증거는 별도다.
    pub fn stop(&mut self) {
        self.handle.request_stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    /// 런타임 스레드가 이미 끝났는가 (QR 대기 만료·연결 종료·취소).
    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(|t| t.is_finished())
    }
}

impl Drop for SecureRemote {
    fn drop(&mut self) {
        // stop 을 명시적으로 부르지 않아도 서버가 남지 않는다. 막힌 PTY 쓰기는 별도
        // 스레드라 join 을 붙잡지 못하고, 남아 있는 거절 task 도 join 대상이 아니며,
        // accept 루프의 네트워크 대기는 모두 상한이 있다 — 다만 글루 핸들러가 동기로
        // 잡는 Dispatcher lock 만은 join 밖이 아니다 (`stop` 의 주석 참조).
        self.handle.request_stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 런타임 스레드 본체. `block_on` 이 끝나면 런타임이 drop 되며 모든 task·소켓이 정리된다.
fn runtime_main(
    cfg: SecureRemoteConfig,
    deps: SecureRemoteDeps,
    cert: Certificate,
    epoch: u64,
    handle: Arc<Handle>,
    lease: WriterLease,
    ready: Sender<Result<SocketAddr, String>>,
) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            let _ = ready.send(Err(format!("tokio runtime: {e}")));
            handle.set_state(SecureRemoteState::Idle);
            return;
        }
    };

    runtime.block_on(async move {
        let log = Arc::clone(&deps.log);
        let server = ServerBuilder::new()
            .with_addr(cfg.bind)
            .with_certificate(cert.chain, cert.key);
        let mut server = match server {
            Ok(server) => server,
            Err(e) => {
                let _ = ready.send(Err(e.to_string()));
                handle.set_state(SecureRemoteState::Idle);
                return;
            }
        };
        let local_addr = match server.local_addr() {
            Ok(addr) => addr,
            Err(e) => {
                let _ = ready.send(Err(e.to_string()));
                handle.set_state(SecureRemoteState::Idle);
                return;
            }
        };
        let _ = ready.send(Ok(local_addr));
        log_line(
            &log,
            format!("secure-remote: listening on udp {local_addr}"),
        );

        let (events_tx, mut events) = tokio_mpsc::unbounded_channel();
        let shared = Arc::new(ServerShared {
            dispatcher: deps.dispatcher,
            sessions: deps.sessions,
            epoch,
            token: cfg.token,
            log: Arc::clone(&log),
            timeouts: cfg.timeouts,
            lease: Arc::new(lease),
            rate: Mutex::new(RateLimiter::new(DEFAULT_CAP)),
            handle: Arc::clone(&handle),
            events: events_tx,
        });

        handle.set_state(SecureRemoteState::Waiting);
        // 거절 task 의 동시 상한. 런타임과 함께 살고 죽으므로 여기서 만든다.
        let rejection_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_REJECTIONS));
        accept_loop(
            &mut server,
            &cfg.origin,
            &handle,
            &mut events,
            &shared,
            &rejection_slots,
        )
        .await;

        handle.set_state(SecureRemoteState::Stopping);
        // ① 네트워크 먼저: CONNECTION_CLOSE 를 보내고 소켓을 놓는다. close 직후 바로
        // drop 하면 드라이버가 close 패킷을 내보내기 전에 런타임이 사라져 클라이언트가
        // 유휴 타임아웃까지 연결이 살아 있다고 본다 — 짧게 flush 할 틈을 준다.
        server.close(0u32.into(), b"secure remote stopped");
        let _ = tokio::time::timeout(Duration::from_millis(250), server.wait_idle()).await;
        drop(server);
        // ② 그다음 입력 슬롯: 종료 뒤 이 서버의 제출은 실행되지 않고, 진행 중인
        // 쓰기는 끝나게 둔다 (그 쓰기가 다음 페어링의 busy 근거로 남는다).
        shared.lease.close();
        handle.set_state(SecureRemoteState::Idle);
        log_line(&log, "secure-remote: stopped".to_string());
    });
}

/// 페어링 대기 창 동안 연결을 받는 루프. 인증된 연결이 끝나거나 대기 만료·취소면 끝난다.
///
/// 대기 만료는 **로컬 플래그가 아니라 인증 게이트**를 본다. 플래그는
/// `ConnEvent::Authenticated` 를 처리해야 서는데, 인증 승인(`approve_auth`)과 그 이벤트
/// 처리 사이의 창에서 만료가 먼저 깨어나면 방금 인증된 세션을 끊는다.
///
/// 거절은 여기서 보내지 않는다 — [`spawn_rejection`] 이 task 로 넘긴다. 루프는 다음
/// 연결을 받거나 정지 신호를 보는 일만 하고, 거절 task 가 남아 있어도 멈추지 않는다.
async fn accept_loop(
    server: &mut Server,
    origin: &str,
    handle: &Handle,
    events: &mut tokio_mpsc::UnboundedReceiver<ConnEvent>,
    shared: &Arc<ServerShared>,
    rejection_slots: &Arc<Semaphore>,
) {
    let wait_deadline = tokio::time::Instant::now() + shared.timeouts.wait;
    let mut unauth = 0usize;
    let mut unauth_by_ip: HashMap<IpAddr, usize> = HashMap::new();
    let mut wait_armed = true;
    let (handshakes_tx, mut handshakes) = tokio_mpsc::unbounded_channel();

    loop {
        if handle.stop_requested() {
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep_until(wait_deadline), if wait_armed => {
                if handle.is_authenticated() {
                    // 인증 승인이 이긴 경합이다 — 세션 수명에 맡기고 만료를 다시 걸지 않는다.
                    wait_armed = false;
                } else {
                    log_line(&shared.log, "secure-remote: pairing window expired".to_string());
                    break;
                }
            }
            _ = handle.stop_notified() => break,
            Some(event) = events.recv() => match event {
                ConnEvent::Authenticated => {
                    wait_armed = false;
                    handle.set_state(SecureRemoteState::Connected);
                }
                ConnEvent::Closed { ip, authenticated } => {
                    if authenticated {
                        log_line(&shared.log, "secure-remote: client disconnected".to_string());
                        break;
                    }
                    unauth = unauth.saturating_sub(1);
                    if let Some(count) = unauth_by_ip.get_mut(&ip) {
                        *count = count.saturating_sub(1);
                        if *count == 0 {
                            unauth_by_ip.remove(&ip);
                        }
                    }
                }
            },
            incoming = web_transport_quinn::quinn::Endpoint::accept(server) => {
                let Some(incoming) = incoming else { break };
                let ip = incoming.remote_address().ip();
                if !shared.rate().check(ip, Instant::now())
                    || unauth >= MAX_UNAUTHENTICATED
                    || unauth_by_ip.get(&ip).copied().unwrap_or(0) >= MAX_UNAUTHENTICATED_PER_IP
                {
                    incoming.refuse();
                    continue;
                }
                unauth += 1;
                *unauth_by_ip.entry(ip).or_insert(0) += 1;
                let deadline = tokio::time::Instant::now() + shared.timeouts.auth;
                let tx = handshakes_tx.clone();
                tokio::spawn(async move {
                    // CONNECT 이전에도 슬롯과 같은 총 마감을 쓴다. timeout 뒤에는
                    // HTTP/3 내부 future가 연결을 쥐지 못하도록 명시적으로 닫는다.
                    let mut connection = None;
                    let result = tokio::time::timeout_at(deadline, async {
                        let conn = incoming.await.map_err(|_| ())?;
                        connection = Some(conn.clone());
                        Request::accept(conn).await.map_err(|_| ())
                    }).await;
                    let request = match result {
                        Ok(Ok(request)) => Some(request),
                        _ => {
                            if let Some(conn) = connection {
                                conn.close(0u32.into(), b"handshake failed");
                            }
                            None
                        }
                    };
                    let _ = tx.send((ip, deadline, request));
                });
            }
            Some((ip, deadline, request)) = handshakes.recv() => {
                unauth = unauth.saturating_sub(1);
                if let Some(count) = unauth_by_ip.get_mut(&ip) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        unauth_by_ip.remove(&ip);
                    }
                }
                let Some(request) = request else {
                    shared.record_failure(ip, "handshake failure or timeout");
                    continue;
                };
                let ip = request.conn().remote_address().ip();
                // rate 검사가 path·Origin 검사보다 **앞**이다. 그래야 잘못된 경로·Origin
                // 도 IP 단위 실패로 집계되어(11번째에 차단) 슬롯을 굶기며 무한히 반복할
                // 수 없고, 이미 차단된 IP 의 재시도는 여기서 끝나므로 다시 세지도 새
                // 로그 줄을 남기지도 않는다 — 차단 전이는 record_failure 의 줄 하나다
                // (Local HTTP 와 같은 규율).
                let now = Instant::now();
                if !shared.rate().check(ip, now) {
                    spawn_rejection(
                        request,
                        StatusCode::TOO_MANY_REQUESTS,
                        shared,
                        rejection_slots,
                    );
                    continue;
                }
                if request.url.path() != "/wt" {
                    let status = blocked_status(
                        shared.record_failure(ip, "refused path"),
                        StatusCode::NOT_FOUND,
                    );
                    spawn_rejection(request, status, shared, rejection_slots);
                    continue;
                }
                let request_origin = request.headers.get("origin").and_then(|v| v.to_str().ok());
                if request_origin != Some(origin) {
                    // 받은 값을 로그에 남기지 않는다 — 출처와 사실만 남긴다.
                    let status = blocked_status(
                        shared.record_failure(ip, "refused origin"),
                        StatusCode::FORBIDDEN,
                    );
                    spawn_rejection(request, status, shared, rejection_slots);
                    continue;
                }
                if handle.is_authenticated() {
                    log_line(&shared.log, format!("secure-remote: refused second session from {ip}"));
                    spawn_rejection(request, StatusCode::CONFLICT, shared, rejection_slots);
                    continue;
                }
                if unauth >= MAX_UNAUTHENTICATED {
                    log_line(&shared.log, format!("secure-remote: refused excess attempt from {ip}"));
                    spawn_rejection(
                        request,
                        StatusCode::TOO_MANY_REQUESTS,
                        shared,
                        rejection_slots,
                    );
                    continue;
                }
                if unauth_by_ip.get(&ip).copied().unwrap_or(0) >= MAX_UNAUTHENTICATED_PER_IP {
                    log_line(&shared.log, format!("secure-remote: refused excess attempt from {ip} (per-ip limit)"));
                    spawn_rejection(
                        request,
                        StatusCode::TOO_MANY_REQUESTS,
                        shared,
                        rejection_slots,
                    );
                    continue;
                }
                unauth += 1;
                *unauth_by_ip.entry(ip).or_insert(0) += 1;
                tokio::spawn(conn::handle(request, Arc::clone(shared), deadline));
            }
        }
    }
}

/// 이번 실패로 차단이 걸렸으면 429 를, 아니면 원래의 거절 상태를 고른다.
///
/// 차단 전이의 응답을 429 로 바꾸는 것은 conn.rs 의 auth 거절과 같은 규율이다 —
/// 평소의 의미(404/403)는 차단 전까지 그대로 전달된다.
fn blocked_status(blocked: bool, fallback: StatusCode) -> StatusCode {
    if blocked {
        StatusCode::TOO_MANY_REQUESTS
    } else {
        fallback
    }
}

/// CONNECT 거절 하나를 [`MAX_CONCURRENT_REJECTIONS`] 상한 안의 독립 task 로 넘긴다.
///
/// 슬롯이 없으면 task 를 만들지 않고 **그 자리에서** 연결을 닫는다 — 응답 상태는
/// 전달되지 않지만 상한을 넘는 task 도, 보관되는 요청도 없다. 어느 경로든 accept
/// 루프는 여기서 기다리지 않는다.
///
/// 슬롯 부족으로 응답을 포기한 연결은 **로그를 남기지 않는다**. 이 자리는 이미 rate
/// 차단된 IP 의 재시도가 반복해 지나갈 수 있어, 시도마다 한 줄씩 남기면 11번 청크가
/// 없앤 로그 flood 가 상한 가지에서 그대로 되살아난다 (리뷰 지적). 재시도의 맥락은
/// 차단을 건 `record_failure` 한 줄이 이미 들고 있고, 응답을 못 준 사실은 peer 가
/// 연결 종료로 즉시 본다. 상한 초과 진단이 다시 필요해지면 시도별이 아니라 서버
/// 수명 동안 유계인 형태로 넣는다.
fn spawn_rejection(
    request: Request,
    status: StatusCode,
    shared: &Arc<ServerShared>,
    slots: &Arc<Semaphore>,
) {
    let conn = request.conn().clone();
    let inner = Arc::clone(shared);
    spawn_bounded_rejection(
        slots,
        async move { reject_bounded(request, status, &inner).await },
        move || conn.close(0u32.into(), b"rejection capacity"),
    );
}

/// 거절 task 하나를 상한 안에서 띄운다. 반환값은 "task 를 띄웠는가".
///
/// 슬롯(permit)은 task 가 끝날 때까지 그 task 가 쥔다. 그래서 동시에 도는 거절 task
/// 수가 곧 상한이고, `close` 는 슬롯이 없을 때만 **동기로** 불린다.
fn spawn_bounded_rejection<F, C>(slots: &Arc<Semaphore>, work: F, close: C) -> bool
where
    F: Future<Output = ()> + Send + 'static,
    C: FnOnce(),
{
    match Arc::clone(slots).try_acquire_owned() {
        Ok(permit) => {
            tokio::spawn(async move {
                let _permit = permit;
                work.await;
            });
            true
        }
        Err(_) => {
            close();
            false
        }
    }
}

/// 거절 task 의 본체. 응답 헤더가 peer 의 flow control(QUIC send credit)에 막히면
/// [`REJECT_GRACE`] 안에서만 기다리고 연결을 **명시적으로** 닫는다.
///
/// accept 루프가 아니라 task 에서 돌기 때문에, 상한이 지나도 루프·`stop()`·Drop 의
/// join 이 이 peer 에 묶이지 않는다. 상한이 지나면 상태 코드는 전달되지 않지만 연결은
/// 닫히므로 peer 는 즉시 실패를 본다 (`conn.close` 는 큐가 아니라 연결을 끊는다).
async fn reject_bounded(request: Request, status: StatusCode, shared: &Arc<ServerShared>) {
    let conn = request.conn().clone();
    let ip = request.conn().remote_address().ip();
    let completed = reject_with_grace(
        REJECT_GRACE,
        async {
            // `reject` 는 응답을 쓴 직후 Request 를 버려서, 마지막 `Connection` handle 이
            // 사라지면 quinn 의 implicit close 가 아직 내보내지 못한 응답을 버린다
            // (실측: 클라이언트가 상태 코드 대신 EOF 를 봤다). `respond` 는 세션 핸들을
            // 돌려주고, 그 `close` 가 닫기 전에 드라이버가 내보낼 창을 준다 —
            // 캡슐 쓰기·peer 대기는 `max(3*RTT, 100ms)` 로 묶여 있고 실패하면 즉시
            // 강제 종료한다. 이 task 는 최대 REJECT_GRACE 를 쓰고 사라진다.
            if let Ok(session) = request.respond(status).await {
                session.close(0, b"rejected");
            }
        },
        || conn.close(0u32.into(), b"response stalled"),
    )
    .await;
    if !completed {
        log_line(
            &shared.log,
            format!("secure-remote: closed {ip} after a stalled rejection"),
        );
    }
}

/// `work` 를 `grace` 안에서 기다린다. 마감이 지나면 `close` 로 peer 를 끊고 `false`.
///
/// Request 없이 단위 테스트할 수 있게 분리했다 — 응답 헤더 credit 을 주지 않는 peer 는
/// quinn 의 공개 API 로 만들 수 없다: `TransportConfig::stream_receive_window` 하나가
/// bidi_local·bidi_remote·uni 세 파라미터를 함께 정하므로(quinn-proto 0.11
/// `transport_parameters.rs:158-160`) CONNECT 응답만 굶기면 HTTP/3 SETTINGS 교환도 같이
/// 멈춰 Request 가 아예 오지 않고, 창을 조금 줄인 peer 는 응답 헤더를 읽는 만큼
/// credit 이 돌아 스스로 풀린다. 그 상황 대신 상한·비차단 동작은 이 함수와
/// [`spawn_bounded_rejection`] 의 단위 테스트가 고정하고, tests/wt.rs 는 실서버에서
/// 거절 폭주와 rate 집계만 확인한다.
async fn reject_with_grace<F, C>(grace: Duration, work: F, close: C) -> bool
where
    F: std::future::Future<Output = ()>,
    C: FnOnce(),
{
    if tokio::time::timeout(grace, work).await.is_ok() {
        true
    } else {
        close();
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_before_auth_wins() {
        let handle = Handle::new();
        assert!(handle.cancel(), "the first cancel is approved");
        // 취소가 먼저 승인됐으면 이후 인증은 거절되고 런타임은 정지 신호를 본다.
        assert_eq!(handle.approve_auth(), AuthDecision::Cancelled);
        assert!(handle.stop_requested());
        // 두 번째 취소도 같은 승인 결과를 돌려준다 (멱등).
        assert!(handle.cancel());
    }

    #[test]
    fn auth_before_cancel_wins() {
        let handle = Handle::new();
        assert_eq!(handle.approve_auth(), AuthDecision::Approved);
        // 인증이 먼저 승인됐으면 취소는 세션에 손대지 않는다 — 정지 신호도 없다.
        assert!(!handle.cancel(), "an authenticated session is left alone");
        assert!(!handle.stop_requested());
        assert!(handle.is_authenticated());
    }

    #[test]
    fn a_second_auth_loses_to_the_first() {
        let handle = Handle::new();
        assert_eq!(handle.approve_auth(), AuthDecision::Approved);
        assert_eq!(handle.approve_auth(), AuthDecision::AlreadyPaired);
    }

    /// 상한이 없던 거절 경로의 하위 회귀다. QUIC flow control 을 스트림 단위로 굶긴
    /// 클라이언트는 quinn 의 공개 API 로 만들 수 없다 — `TransportConfig` 는
    /// `stream_receive_window` 하나로 bidi_local·bidi_remote·uni 세 파라미터를 함께
    /// 정하므로, CONNECT 스트림만 굶기면 HTTP/3 SETTINGS 교환이 먼저 멈춘다. 그래서
    /// "응답이 끝나지 않는 peer 는 마감 안에 끊긴다"를 여기서 직접 검증한다.
    #[tokio::test]
    async fn a_stalled_rejection_is_closed_at_the_grace() {
        let closed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&closed);
        let start = Instant::now();
        let completed = reject_with_grace(
            Duration::from_millis(50),
            std::future::pending::<()>(),
            move || flag.store(true, Ordering::SeqCst),
        )
        .await;
        assert!(!completed, "a stalled rejection must not report completion");
        assert!(
            closed.load(Ordering::SeqCst),
            "the stalled peer was left connected"
        );
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "the grace did not bound the wait: {:?}",
            start.elapsed()
        );
    }

    #[tokio::test]
    async fn a_rejection_that_finishes_in_time_is_not_forced_closed() {
        let closed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&closed);
        let completed = reject_with_grace(Duration::from_secs(2), async {}, move || {
            flag.store(true, Ordering::SeqCst)
        })
        .await;
        assert!(completed, "a normal rejection must report completion");
        assert!(
            !closed.load(Ordering::SeqCst),
            "a peer that accepted the reply was closed anyway"
        );
    }

    /// 거절 task 수의 상한이 실제로 걸리고, 슬롯이 없으면 요청을 쌓지 않고 그 자리에서
    /// 연결을 닫는 경로가 도는지 고정한다. 스케줄링은 pending 인 task 에도 즉시
    /// 돌아온다 — accept 루프가 거절 하나를 기다리지 않는다는 계약의 하위 검증이다.
    #[tokio::test]
    async fn rejection_tasks_are_bounded_and_overflow_is_closed_on_the_spot() {
        let slots = Arc::new(Semaphore::new(2));
        let start = Instant::now();
        for _ in 0..2 {
            assert!(spawn_bounded_rejection(
                &slots,
                std::future::pending::<()>(),
                || panic!("capacity was free"),
            ));
        }
        assert!(
            start.elapsed() < Duration::from_millis(100),
            "scheduling waited for a pending rejection: {:?}",
            start.elapsed()
        );

        let closed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&closed);
        let spawned = spawn_bounded_rejection(&slots, std::future::pending::<()>(), move || {
            flag.store(true, Ordering::SeqCst)
        });
        assert!(!spawned, "a task beyond the bound was spawned");
        assert!(
            closed.load(Ordering::SeqCst),
            "the overflow connection was not closed on the spot"
        );
    }

    /// 상한은 영구 잠금이 아니다 — task 가 끝나면 슬롯이 돌아와 다음 거절을 받는다.
    /// 회수는 task 종료 시점이라 비동기다: 양보하며 기한 안에 확인한다.
    #[tokio::test]
    async fn a_finished_rejection_releases_its_slot() {
        let slots = Arc::new(Semaphore::new(1));
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        assert!(spawn_bounded_rejection(
            &slots,
            async move {
                let _ = done_tx.send(());
            },
            || panic!("capacity was free"),
        ));
        done_rx.await.expect("the rejection task ran");

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if spawn_bounded_rejection(&slots, async {}, || panic!("capacity was free")) {
                break;
            }
            assert!(Instant::now() < deadline, "the slot was never released");
            tokio::task::yield_now().await;
        }
    }

    /// 도는 거절 task 는 join 대상이 아니다 — 런타임 drop 은 pending task 를 기다리지
    /// 않는다. `stop()`/Drop 의 join 이 거절 하나에 묶이지 않는다는 계약의 하위 검증이며,
    /// 실제 peer 를 QUIC flow control 로 굶기는 통합 테스트가 불가능한 대신이다
    /// (`reject_with_grace` 의 주석 참조).
    #[test]
    fn pending_rejection_tasks_are_dropped_with_the_runtime() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_REJECTIONS));
        runtime.block_on(async {
            for _ in 0..MAX_CONCURRENT_REJECTIONS {
                assert!(spawn_bounded_rejection(
                    &slots,
                    std::future::pending::<()>(),
                    || panic!("capacity was free"),
                ));
            }
        });
        let start = Instant::now();
        drop(runtime);
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "runtime teardown waited for pending rejections: {:?}",
            start.elapsed()
        );
    }
}
