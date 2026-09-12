//! 소켓·스레드·응답 쓰기 — 이 크레이트에서 유일하게 I/O 를 하는 자리다.
//!
//! 구조는 accept 스레드 1개 + 커넥션당 스레드다. async 런타임을 들이지 않는 이유는
//! 부하 특성이다: 이 표면의 클라이언트는 폰 한두 대이고 요청은 2초 폴링이라, 동시성이
//! 수십을 넘을 일이 없다. 대신 상한을 자료구조가 아니라 숫자로 못박는다 — 동시 커넥션
//! [`MAX_CONNECTIONS`], 스트림 read/write 타임아웃 [`IO_TIMEOUT`], 헤드·본문 상한은
//! [`crate::http`] 가 소유한다.
//!
//! 처리 순서(ADR-0016 결정 4)는 [`handle`] 한 함수 안에 번호 그대로 있다. 순서 자체가 보안
//! 계약이라 흩어 놓지 않았다 — 예를 들어 rate limit 판정이 헤드 읽기보다 **뒤로** 가면
//! 차단된 IP 가 매번 8 KiB 를 밀어 넣을 수 있다.

use std::fmt::Write as _;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use mast_core::command::Dispatcher;
use mast_core::session::SessionManager;

use crate::handlers;
use crate::http::{read_head, Head, HeadError, MAX_BODY_BYTES};
use crate::ratelimit::{RateLimiter, DEFAULT_CAP};
use crate::routes::{route, Route};
use crate::token::token_matches;

/// 넘으면 읽지도 답하지도 않고 즉시 닫는다.
const MAX_CONNECTIONS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(10);
/// 본문을 읽지 않고 거절했을 때 남은 입력을 비우는 총 예산 (시간·바이트).
const DRAIN_BUDGET: Duration = Duration::from_secs(2);
const DRAIN_BYTES: usize = 1024 * 1024;
/// 예산을 이 단위로 나눠 쓴다.
const DRAIN_READ_TIMEOUT: Duration = Duration::from_millis(200);
/// 요청 하나(헤드 + 본문)를 다 받는 데 허용하는 wall-clock 시간. [`IO_TIMEOUT`] 은
/// **read 한 번**의 상한이라 그것만으로는 9초마다 1바이트씩 흘리는 클라이언트(slowloris)가
/// 슬롯을 무한정 붙잡는다 — 그래서 요청 단위의 마감이 따로 있다.
const CONN_DEADLINE: Duration = Duration::from_secs(15);

/// 매 read 전에 마감까지 남은 시간을 소켓 타임아웃으로 다시 거는 리더. 마감이 지났으면
/// 읽지 않고 `TimedOut` 으로 끝낸다 — 헤드·본문 읽기가 이 리더를 지나므로 요청 하나의
/// 수명이 [`CONN_DEADLINE`] 안에 묶인다.
struct DeadlineReader<'a> {
    stream: &'a mut TcpStream,
    deadline: Instant,
}

impl Read for DeadlineReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let now = Instant::now();
        if now >= self.deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "request deadline passed",
            ));
        }
        let _ = self
            .stream
            .set_read_timeout(Some((self.deadline - now).min(IO_TIMEOUT)));
        self.stream.read(buf)
    }
}

/// 글루가 임베드 자산 하나를 꺼내 준 결과.
pub struct StaticAsset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

/// 자산 키(`remote/index.html` 같은 선행 `/` 없는 형태) → 자산. `None` 이면 404 다.
/// 존재하지 않는 키에 절대 대체 자산을 돌려주면 안 된다 — Tauri release 의 자산 조회는
/// 미지 경로를 `index.html` 로 폴백하므로, 그 폴백이 여기까지 오면 데스크톱 페이지가
/// 무인증 표면에 200 으로 나간다 (ADR-0016 결정 8).
pub type AssetFn = Arc<dyn Fn(&str) -> Option<StaticAsset> + Send + Sync>;

/// 글루가 `winlog!` 로 연결한다.
pub type LogFn = Arc<dyn Fn(String) + Send + Sync>;

pub struct RemoteConfig {
    pub bind: SocketAddr,
    /// 페어링 토큰(`Authorization: Bearer`). 로그·응답 어디에도 실리지 않는다.
    pub token: String,
}

pub struct RemoteDeps {
    pub dispatcher: Arc<Mutex<Dispatcher>>,
    pub sessions: Arc<SessionManager>,
    pub assets: AssetFn,
    pub log: LogFn,
}

/// drop 하면 accept 스레드가 리스너와 함께 정리된다.
pub struct RemoteServer {
    local_addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
}

impl RemoteServer {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }
}

impl Drop for RemoteServer {
    /// accept 스레드는 블로킹 accept 에 들어가 있으므로 플래그만으로는 깨지 않는다 —
    /// 플래그를 올린 뒤 자기 자신에게 한 번 접속해 accept 를 반환시킨다. 커넥션
    /// 스레드는 기다리지 않는다: 타임아웃이 10초라 스스로 끝나고, 프로세스 수명이
    /// 서버 수명이라 매달릴 이유가 없다.
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let wake = match self.local_addr.ip() {
            // 0.0.0.0 바인드에 그대로 접속할 수는 없다 (플랫폼에 따라 의미가 다르다).
            ip if ip.is_unspecified() => {
                SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), self.local_addr.port())
            }
            _ => self.local_addr,
        };
        let _ = TcpStream::connect_timeout(&wake, Duration::from_millis(250));
    }
}

/// 바인드하고 accept 스레드를 띄운다. **바인드는 여기서 동기로** 한다 — 포트를 잡지
/// 못한 사실이 `Err` 로 돌아와야 글루가 `failed` 를 loud 하게 말할 수 있고, 스레드
/// 안에서 실패하면 그 사실이 로그 한 줄로만 남는다.
pub fn serve(cfg: RemoteConfig, deps: RemoteDeps) -> std::io::Result<RemoteServer> {
    // 엔트로피를 못 얻는 것은 바인드 실패와 같은 등급의 부팅 실패다 — 글루가 `Failed` 로
    // 보고하지, 프로세스를 죽이지 않는다.
    let epoch = random_epoch()?;
    let listener = TcpListener::bind(cfg.bind)?;
    let local_addr = listener.local_addr()?;
    let shutdown = Arc::new(AtomicBool::new(false));

    let ctx = Arc::new(ServerCtx {
        token: cfg.token,
        // 세션 토큰의 앞자리. 앱을 재시작하면 `SessionId` 는 다시 1부터 발급되므로
        // (`session.rs` 의 `SessionManager`), id 만으로는 "같은 번호의 다른 세션"을
        // 구분할 수 없다 — 폰이 옛 화면을 보고 보낸 입력이 새 셸에서 실행되는 것을
        // 막는 것이 이 epoch 의 전부다.
        epoch,
        dispatcher: deps.dispatcher,
        sessions: deps.sessions,
        assets: deps.assets,
        log: Arc::clone(&deps.log),
        rate: Mutex::new(RateLimiter::new(DEFAULT_CAP)),
        conns: AtomicUsize::new(0),
    });

    let accept_shutdown = Arc::clone(&shutdown);
    let accept_ctx = Arc::clone(&ctx);
    thread::Builder::new()
        .name("mast-remote-accept".into())
        .spawn(move || accept_loop(listener, accept_ctx, accept_shutdown))?;

    log_line(&deps.log, format!("remote: listening on {local_addr}"));
    Ok(RemoteServer {
        local_addr,
        shutdown,
    })
}

pub(crate) fn log_line(sink: &LogFn, message: String) {
    (sink.as_ref())(message);
}

/// 약한 대체값(시각·pid)은 두지 않는다 — 세션 토큰의 추측 불가능성이 곧 입력 보호다.
fn random_epoch() -> std::io::Result<u64> {
    let mut raw = [0u8; 8];
    getrandom::fill(&mut raw)
        .map_err(|err| std::io::Error::other(format!("CSPRNG unavailable: {err}")))?;
    Ok(u64::from_le_bytes(raw))
}

struct ServerCtx {
    token: String,
    epoch: u64,
    dispatcher: Arc<Mutex<Dispatcher>>,
    sessions: Arc<SessionManager>,
    assets: AssetFn,
    log: LogFn,
    rate: Mutex<RateLimiter>,
    conns: AtomicUsize,
}

impl ServerCtx {
    /// poisoned 여도 계속 센다. 실패 카운터를 버리는 것은 차단을 푸는 것과 같아서,
    /// 패닉 한 번이 rate limit 을 해제하는 경로가 되면 안 된다 (ADR-0016 결정 4).
    fn rate(&self) -> MutexGuard<'_, RateLimiter> {
        self.rate.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn accept_loop(listener: TcpListener, ctx: Arc<ServerCtx>, shutdown: Arc<AtomicBool>) {
    loop {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // 리스너가 죽은 뒤에도 도는 루프는 CPU 만 태운다.
            Err(_) => return,
        };
        if shutdown.load(Ordering::SeqCst) {
            return;
        }
        // 상한 검사는 카운터를 먼저 올리고 판정한다 — 검사 후 증가로 나누면 두 accept
        // 사이에 상한을 넘길 수 있다.
        if ctx.conns.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            ctx.conns.fetch_sub(1, Ordering::SeqCst);
            drop(stream);
            continue;
        }
        let conn_ctx = Arc::clone(&ctx);
        let spawned = thread::Builder::new()
            .name("mast-remote-conn".into())
            .spawn(move || {
                let _guard = ConnGuard(&conn_ctx);
                // 핸들러가 패닉해도 커넥션 하나만 잃는다 — accept 스레드는 다른
                // 스레드라 살아 있고, 여기서 잡지 않으면 폰이 응답도 사유도 못 받는다.
                if std::panic::catch_unwind(AssertUnwindSafe(|| handle(stream, &conn_ctx))).is_err()
                {
                    log_line(
                        &conn_ctx.log,
                        "remote: connection handler panicked".to_string(),
                    );
                }
            });
        if spawned.is_err() {
            ctx.conns.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// 커넥션 카운터를 스레드가 어떻게 끝나든(패닉 포함) 되돌린다.
struct ConnGuard<'a>(&'a Arc<ServerCtx>);

impl Drop for ConnGuard<'_> {
    fn drop(&mut self) {
        self.0.conns.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 핸들러에 넘기는 요청 재료 — 헤드, 헤드와 같은 read 에 딸려온 바이트, 요청 마감.
struct Inbound<'a> {
    head: &'a Head,
    head_len: usize,
    buf: &'a [u8],
    deadline: Instant,
}

/// 커넥션 하나의 전 과정. 번호는 ADR-0016 결정 4의 처리 순서다.
fn handle(mut stream: TcpStream, ctx: &ServerCtx) {
    let Ok(peer) = stream.peer_addr() else {
        return;
    };
    let ip = peer.ip();
    // 타임아웃을 먼저 건다 — 이 아래의 모든 read/write 가 걸려 있어야 한다.
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let deadline = Instant::now() + CONN_DEADLINE;

    // ① 차단된 IP 는 헤드를 읽지도 않는다.
    if !ctx.rate().check(ip, Instant::now()) {
        respond(&mut stream, too_many_requests());
        return;
    }

    // ② 헤드.
    let mut buf = Vec::new();
    let head_result = {
        let mut reader = DeadlineReader {
            stream: &mut stream,
            deadline,
        };
        read_head(&mut reader, &mut buf)
    };
    let (head, head_len) = match head_result {
        Ok(v) => v,
        Err(HeadError::TooLarge) => {
            respond(
                &mut stream,
                Response::error(
                    431,
                    "Request Header Fields Too Large",
                    "request head too large",
                ),
            );
            return;
        }
        Err(HeadError::Malformed) => {
            respond(
                &mut stream,
                Response::error(400, "Bad Request", "bad request"),
            );
            return;
        }
        // 헤드가 오기 전에 끊긴 연결에는 답할 상대가 없다.
        Err(HeadError::Eof) => return,
    };

    // ③ 라우팅.
    let target = route(head.method, &head.path, head.query.as_deref());
    let is_input = matches!(target, Route::Input { .. });
    let declared_body = head.content_length.is_some_and(|n| n > 0) || head.has_transfer_encoding;
    let mut response = match target {
        Route::NotFound => not_found(),
        Route::BadRequest => Response::error(400, "Bad Request", "bad request"),
        target => {
            // ④ accept 이후에 차단된 IP 의 지연 요청도 여기서 걸린다.
            if !ctx.rate().check(ip, Instant::now()) {
                too_many_requests()
            } else if needs_auth(&target) && !authorized(&head, &ctx.token) {
                // ⑤ 실패를 먼저 기록하고, 그 기록이 차단을 걸었으면 이 요청부터 429 다.
                let now = Instant::now();
                let mut rate = ctx.rate();
                let blocked = rate.record_failure(ip, now);
                let failures = rate.failures_in_window(ip, now);
                drop(rate);
                // 헤더 값도 토큰도 남기지 않는다 — 남길 수 있는 것은 출처와 횟수뿐이다.
                log_line(
                    &ctx.log,
                    format!("remote: auth failure from {ip} ({failures} in window)"),
                );
                if blocked {
                    too_many_requests()
                } else {
                    Response::error(401, "Unauthorized", "unauthorized")
                }
            } else {
                // ⑥ 핸들러.
                dispatch(
                    &mut stream,
                    ctx,
                    Inbound {
                        head: &head,
                        head_len,
                        buf: &buf,
                        deadline,
                    },
                    target,
                )
            }
        }
    };
    // 본문을 실은 GET 처럼 핸들러가 읽지 않은 본문이 남아 있으면 거절 응답과 같은 뒤처리가
    // 필요하다 — 미독 데이터가 남은 채 닫으면 RST 가 방금 쓴 응답을 지울 수 있다.
    if declared_body && !is_input {
        response.drain = true;
    }
    respond(&mut stream, response);
}

fn needs_auth(target: &Route) -> bool {
    match target {
        Route::State | Route::Screen { .. } | Route::Input { .. } => true,
        // 정적 자산은 인증이 없다 — 토큰을 담은 페이지 자체를 받아 가는 경로다.
        Route::Static { .. } | Route::NotFound | Route::BadRequest => false,
    }
}

/// `Authorization: Bearer <token>` 만 본다. 쿼리스트링·쿠키의 토큰은 읽지 않는다
/// (ADR-0016 결정 4) — URL 에 실린 비밀은 브라우저 히스토리·로그로 새기 때문이다.
fn authorized(head: &Head, expected: &str) -> bool {
    let Some(value) = head.authorization.as_deref() else {
        return false;
    };
    let Some((scheme, credential)) = value.trim().split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return false;
    }
    token_matches(expected, credential.trim())
}

fn dispatch(
    stream: &mut TcpStream,
    ctx: &ServerCtx,
    inbound: Inbound<'_>,
    target: Route,
) -> Response {
    match target {
        Route::State => handlers::state(&ctx.dispatcher),
        Route::Screen {
            tab,
            since,
            session,
        } => handlers::screen(
            &ctx.dispatcher,
            &ctx.sessions,
            ctx.epoch,
            tab,
            since,
            session.as_deref(),
        ),
        Route::Input { tab, session } => input(stream, ctx, inbound, tab, session.as_deref()),
        Route::Static { key } => handlers::static_asset(&ctx.assets, &key),
        // ③ 에서 이미 응답한 갈래다.
        Route::NotFound | Route::BadRequest => not_found(),
    }
}

/// `POST /api/tabs/{id}/input`.
///
/// 판정 순서는 **프레이밍 → 탭·세션 → 본문**이다. ADR-0016 결정 7 이 요구하는 것은 "본문을
/// 한 바이트도 읽기 전에 거절이 끝난다" 하나이고, 그 안에서 프레이밍을 먼저 보는 이유는
/// 탭도 세션도 몰라야 판정할 수 있는 것이라 Dispatcher lock 을 잡기 전에 끝나기
/// 때문이다.
fn input(
    stream: &mut TcpStream,
    ctx: &ServerCtx,
    inbound: Inbound<'_>,
    tab: u64,
    session: Option<&str>,
) -> Response {
    let Inbound {
        head,
        head_len,
        buf,
        deadline,
    } = inbound;
    if head.has_transfer_encoding {
        // chunked 를 지원하지 않는다. 지원하는 척하면 chunk 프레이밍 바이트가 그대로
        // PTY 로 들어간다.
        return Response::error(411, "Length Required", "content-length required");
    }
    if head.duplicate_content_length {
        return Response::error(400, "Bad Request", "conflicting content-length");
    }
    if head.has_expect {
        // 100-continue 를 협상하지 않는다 — 우리 클라이언트는 쓰지 않고, 응답 없이
        // 기다리는 클라이언트를 만드는 것보다 즉시 거절이 낫다.
        return Response::error(417, "Expectation Failed", "expectation failed");
    }
    let Some(length) = head.content_length else {
        return Response::error(411, "Length Required", "content-length required");
    };
    if length > MAX_BODY_BYTES {
        return Response::error(413, "Content Too Large", "body too large");
    }

    let session = match handlers::resolve_input_session(
        &ctx.dispatcher,
        &ctx.sessions,
        ctx.epoch,
        tab,
        session,
    ) {
        Ok(session) => session,
        Err(response) => return response,
    };

    let Some(body) = read_body(stream, buf, head_len, length, deadline) else {
        // 선언한 길이가 다 오지 않았다 — 반쪽짜리 입력을 PTY 에 쓰지 않는다.
        return Response::error(400, "Bad Request", "incomplete body");
    };

    handlers::write_input(&session, &body, &ctx.log)
}

/// 헤드와 같은 read 에 딸려온 바이트(`buf[head_len..]`)부터 이어서 정확히 `length`
/// 바이트를 모은다. EOF·타임아웃이면 `None`.
fn read_body(
    stream: &mut TcpStream,
    buf: &[u8],
    head_len: usize,
    length: usize,
    deadline: Instant,
) -> Option<Vec<u8>> {
    let mut reader = DeadlineReader { stream, deadline };
    let mut body: Vec<u8> = buf[head_len..].to_vec();
    // 파이프라인된 다음 요청이 딸려 왔을 수 있다 — 선언한 길이까지만 쓴다
    // (`Connection: close` 라 뒤는 볼 일이 없다).
    body.truncate(length);
    let mut chunk = [0u8; 4096];
    while body.len() < length {
        match reader.read(&mut chunk) {
            Ok(0) => return None,
            Ok(n) => {
                let want = (length - body.len()).min(n);
                body.extend_from_slice(&chunk[..want]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
    Some(body)
}

/// `drain` 은 "본문을 읽지 않고 거절했다"는 표시다.
pub(crate) struct Response {
    status: u16,
    reason: &'static str,
    content_type: String,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
    drain: bool,
}

impl Response {
    pub(crate) fn ok(content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            reason: "OK",
            content_type: sanitize_mime(content_type),
            headers: Vec::new(),
            body,
            drain: false,
        }
    }

    /// `POST /input` 의 성공 응답이다.
    pub(crate) fn ok_empty() -> Self {
        Self::ok("text/plain", Vec::new())
    }

    /// 고정 문구 JSON 에러. `message` 는 **코드 안의 리터럴만** 넘긴다 — 요청에서 온
    /// 값을 실으면 이스케이프가 필요해지고, 에러 본문에 경로·헤더가 새는 경로가 열린다
    /// (ADR-0016 의 한계 절).
    pub(crate) fn error(status: u16, reason: &'static str, message: &str) -> Self {
        Self {
            status,
            reason,
            content_type: "application/json".to_string(),
            headers: Vec::new(),
            body: format!("{{\"error\":\"{message}\"}}").into_bytes(),
            // 거절 응답은 본문을 읽지 않은 채 답한 것이라 뒤처리가 필요하다.
            drain: true,
        }
    }

    /// 값은 전부 우리가 만든 숫자·토큰이지만, 제어 문자가 섞인 값은 헤더 주입이 되므로
    /// `content_type` 과 같은 규율로 거른다 — 그런 값이 온다면 코드 결함이라 debug 에서는
    /// 즉시 드러내고, release 에서는 그 헤더만 뺀다.
    pub(crate) fn with_header(mut self, name: &'static str, value: String) -> Self {
        let clean = !value.bytes().any(|b| b < 0x20 || b == 0x7f);
        debug_assert!(clean, "header {name} carries a control character");
        if clean {
            self.headers.push((name, value));
        }
        self
    }
}

/// 자산 콜백이 준 MIME 은 우리가 만든 값이 아니다 — 개행이 섞이면 헤더 주입이 되므로
/// 이상하면 통째로 기본값으로 되돌린다.
fn sanitize_mime(mime: &str) -> String {
    let clean = mime.trim();
    if clean.is_empty() || clean.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return "application/octet-stream".to_string();
    }
    clean.to_string()
}

fn not_found() -> Response {
    Response::error(404, "Not Found", "not found")
}

fn too_many_requests() -> Response {
    Response::error(429, "Too Many Requests", "too many requests")
        .with_header("Retry-After", "60".to_string())
}

/// 응답을 쓰고 소켓을 닫는다. `Server` 헤더도 CORS 헤더도 없다 — 전자는 표면의 모양을
/// 알려 주고, 후자는 다른 오리진의 페이지에게 이 API 를 열어 준다.
fn respond(stream: &mut TcpStream, response: Response) {
    let mut head = String::new();
    let _ = write!(head, "HTTP/1.1 {} {}\r\n", response.status, response.reason);
    let _ = write!(head, "Content-Type: {}\r\n", response.content_type);
    let _ = write!(head, "Content-Length: {}\r\n", response.body.len());
    // 폴링 표면이라 캐시할 것이 없고, MIME 스니핑은 정적 자산의 타입을 뒤집을 수 있다.
    head.push_str("Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n");
    // 폰 페이지의 XSS 방어는 `textContent` 규율 하나였다 — CSP 가 그것을 브라우저가
    // 강제하는 규칙으로 만든다. 인라인 스타일은 xterm 이 동적으로 붙이므로 허용한다.
    if response.content_type.starts_with("text/html") {
        head.push_str(
            "Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data:; connect-src 'self'\r\n",
        );
    }
    for (name, value) in &response.headers {
        let _ = write!(head, "{name}: {value}\r\n");
    }
    head.push_str("Connection: close\r\n\r\n");

    if stream.write_all(head.as_bytes()).is_err() || stream.write_all(&response.body).is_err() {
        return;
    }
    let _ = stream.flush();
    if response.drain {
        drain(stream);
    }
}

/// 거절 응답 뒤 남은 입력을 비운다.
///
/// 미독 데이터가 남은 채로 닫으면 커널이 RST 를 보내고, 그러면 이미 쓴 응답이 클라이언트
/// 수신 버퍼에서 버려질 수 있다. 비우는 것은 그 확률을 **줄일 뿐 보장이 아니다** —
/// 클라이언트가 예산(2초·1 MiB)보다 더 보내면 여전히 RST 로 끝난다.
fn drain(stream: &mut TcpStream) {
    // 우리 쪽 쓰기를 먼저 닫아 클라이언트에게 "다 보냈다"를 알린다.
    let _ = stream.shutdown(Shutdown::Write);
    let _ = stream.set_read_timeout(Some(DRAIN_READ_TIMEOUT));
    let deadline = Instant::now() + DRAIN_BUDGET;
    let mut left = DRAIN_BYTES;
    let mut chunk = [0u8; 8192];
    while left > 0 && Instant::now() < deadline {
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => left = left.saturating_sub(n),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
    }
}
