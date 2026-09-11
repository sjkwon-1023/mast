//! mast-remote 서버 통합 테스트 — 플랫폼 무관 부분.
//!
//! 실제 `TcpListener`(127.0.0.1:0) 위에서 원시 HTTP 바이트를 주고받는다. 세션은 만들지
//! 않는다 — `FakeHost` 가 id 만 발급하고 레지스트리에는 아무것도 없어서 "탭은 있는데
//! 살아 있는 세션이 없다"(409) 가 기본 상태다. 실제 PTY 가 필요한 케이스는
//! `server_pty.rs`(unix 전용)에 있다.
//!
//! HTTP 클라이언트 크레이트를 쓰지 않는 이유: 본문 없는 `Content-Length`, 헤드 상한 초과,
//! 아무것도 보내지 않는 연결처럼 **잘못된** 요청을 만들어야 하고, 그것은 원시 쓰기라야
//! 가능하다.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mast_core::command::{
    Command, CommandOutput, Dispatcher, NewTab, SessionEvent, SessionHost, ShellSpawnReq,
};
use mast_core::session::{SessionId, SessionManager};
use mast_remote::{serve, RemoteConfig, RemoteDeps, RemoteServer, StaticAsset};

const TOKEN: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const INDEX_HTML: &[u8] = b"<!doctype html><title>mast remote</title>";
const APP_JS: &[u8] = b"console.log('remote');";

/// 세션을 만들지 않는 호스트 — 탭에는 `pty_session: Some(id)` 가 실리지만 레지스트리에
/// 그 id 가 없다.
struct FakeHost {
    next: AtomicU32,
}

impl SessionHost for FakeHost {
    fn spawn_shell(&self, _req: ShellSpawnReq) -> anyhow::Result<SessionId> {
        Ok(self.next.fetch_add(1, Ordering::SeqCst))
    }

    fn kill(&self, _id: SessionId) {}
}

struct Harness {
    server: RemoteServer,
    dispatcher: Arc<Mutex<Dispatcher>>,
    log: Arc<Mutex<Vec<String>>>,
}

impl Harness {
    fn addr(&self) -> SocketAddr {
        self.server.local_addr()
    }

    fn log_lines(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

fn harness() -> Harness {
    let dispatcher = Arc::new(Mutex::new(Dispatcher::new(Box::new(FakeHost {
        next: AtomicU32::new(1),
    }))));
    let log = Arc::new(Mutex::new(Vec::new()));
    let log_sink = Arc::clone(&log);
    let server = serve(
        RemoteConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            token: TOKEN.to_string(),
        },
        RemoteDeps {
            dispatcher: Arc::clone(&dispatcher),
            sessions: Arc::new(SessionManager::new()),
            assets: Arc::new(|key: &str| match key {
                "remote/index.html" => Some(StaticAsset {
                    bytes: INDEX_HTML.to_vec(),
                    mime_type: "text/html".into(),
                }),
                "remote/assets/app.js" => Some(StaticAsset {
                    bytes: APP_JS.to_vec(),
                    mime_type: "text/javascript".into(),
                }),
                _ => None,
            }),
            log: Arc::new(move |line: String| log_sink.lock().unwrap().push(line)),
        },
    )
    .expect("bind 127.0.0.1:0");
    Harness {
        server,
        dispatcher,
        log,
    }
}

/// 워크스페이스 + 터미널 탭 하나. 돌려주는 세션 id 는 FakeHost 가 발급한 것이라
/// 레지스트리에는 없다.
fn terminal_tab(dispatcher: &Mutex<Dispatcher>) -> (u64, SessionId) {
    let out = dispatcher
        .lock()
        .unwrap()
        .dispatch(Command::CreateWorkspace {
            name: "ws".into(),
            root_path: Some("/tmp".into()),
            distro: None,
            tab: Some(NewTab::Terminal { cwd: None }),
        })
        .expect("create workspace with a terminal tab");
    match out {
        CommandOutput::WorkspaceCreated {
            tab: Some(tab),
            session: Some(session),
            ..
        } => (tab.0, session),
        other => panic!("unexpected output: {other:?}"),
    }
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

fn connect(addr: SocketAddr) -> TcpStream {
    let stream = TcpStream::connect(addr).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
}

/// 서버는 응답 뒤 연결을 닫으므로 EOF 까지 읽으면 응답 하나가 온전히 모인다. 서버가
/// drain 예산을 넘겨 RST 로 끝낸 경우에도 이미 받은 만큼은 살린다.
fn read_reply(stream: &mut TcpStream) -> Reply {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset && !raw.is_empty() => break,
            Err(e) => panic!("read response: {e}"),
        }
    }
    parse_reply(&raw)
}

fn parse_reply(raw: &[u8]) -> Reply {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .unwrap_or_else(|| panic!("no head terminator in {:?}", String::from_utf8_lossy(raw)));
    let head = std::str::from_utf8(&raw[..split]).expect("ascii head");
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap();
    let status: u16 = status_line
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("bad status line {status_line:?}"));
    let headers = lines
        .map(|line| {
            let (k, v) = line.split_once(':').expect("header line");
            (k.trim().to_string(), v.trim().to_string())
        })
        .collect();
    Reply {
        status,
        headers,
        body: raw[split + 4..].to_vec(),
    }
}

fn exchange(addr: SocketAddr, raw: &[u8]) -> Reply {
    let mut stream = connect(addr);
    stream.write_all(raw).expect("write request");
    read_reply(&mut stream)
}

fn get(addr: SocketAddr, path: &str, auth: Option<&str>) -> Reply {
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: mast\r\n");
    if let Some(token) = auth {
        req.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    req.push_str("\r\n");
    exchange(addr, req.as_bytes())
}

fn post(
    addr: SocketAddr,
    path: &str,
    auth: Option<&str>,
    extra: &[(&str, &str)],
    body: &[u8],
) -> Reply {
    let mut req = format!("POST {path} HTTP/1.1\r\nHost: mast\r\n");
    if let Some(token) = auth {
        req.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    for (name, value) in extra {
        req.push_str(&format!("{name}: {value}\r\n"));
    }
    req.push_str("\r\n");
    let mut raw = req.into_bytes();
    raw.extend_from_slice(body);
    exchange(addr, &raw)
}

/// 같은 IP 에서 잘못된 토큰으로 11번 두드려 차단을 건다.
fn block_this_ip(h: &Harness) {
    for i in 0..10 {
        assert_eq!(
            get(h.addr(), "/api/state", Some("wrong")).status,
            401,
            "try {i}"
        );
    }
    assert_eq!(get(h.addr(), "/api/state", Some("wrong")).status, 429);
}

fn assert_json_error(reply: &Reply, status: u16, message: &str) {
    assert_eq!(reply.status, status, "body: {}", reply.text());
    assert_eq!(reply.header("Content-Type"), Some("application/json"));
    assert_eq!(reply.text(), format!("{{\"error\":\"{message}\"}}"));
}

#[test]
fn state_requires_a_bearer_token() {
    let h = harness();
    assert_json_error(&get(h.addr(), "/api/state", None), 401, "unauthorized");
    let ok = get(h.addr(), "/api/state", Some(TOKEN));
    assert_eq!(ok.status, 200);
    assert_eq!(ok.header("Content-Type"), Some("application/json"));
}

#[test]
fn state_body_equals_the_dispatcher_snapshot() {
    let h = harness();
    terminal_tab(&h.dispatcher);
    let expected = serde_json::to_vec(&h.dispatcher.lock().unwrap().snapshot()).unwrap();
    let reply = get(h.addr(), "/api/state", Some(TOKEN));
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, expected);
    assert!(reply.text().contains("\"workspaces\""));
}

#[test]
fn a_wrong_token_is_401_with_a_fixed_body() {
    let h = harness();
    let reply = get(h.addr(), "/api/state", Some("not-the-token"));
    assert_json_error(&reply, 401, "unauthorized");
    // 길이만 같은 오답도 같은 문구다 — 본문으로 새는 것이 없다.
    let same_length = "x".repeat(TOKEN.len());
    assert_json_error(
        &get(h.addr(), "/api/state", Some(&same_length)),
        401,
        "unauthorized",
    );
}

#[test]
fn a_token_in_the_query_string_is_ignored_and_401() {
    let h = harness();
    let reply = get(h.addr(), &format!("/api/state?token={TOKEN}"), None);
    assert_json_error(&reply, 401, "unauthorized");
}

#[test]
fn the_eleventh_wrong_token_from_one_ip_is_429() {
    let h = harness();
    for i in 0..10 {
        assert_eq!(
            get(h.addr(), "/api/state", Some("wrong")).status,
            401,
            "try {i}"
        );
    }
    let blocked = get(h.addr(), "/api/state", Some("wrong"));
    assert_eq!(blocked.status, 429);
    assert_eq!(blocked.header("Retry-After"), Some("60"));
    // 차단 중에는 맞는 토큰도 소용없다 — IP 단위 차단이다.
    assert_eq!(get(h.addr(), "/api/state", Some(TOKEN)).status, 429);
    let log = h.log_lines();
    assert!(
        log.iter()
            .any(|l| l.starts_with("remote: auth failure from 127.0.0.1")),
        "log: {log:?}"
    );
    assert!(
        log.iter()
            .all(|l| !l.contains("wrong") && !l.contains(TOKEN)),
        "a log line carries a credential: {log:?}"
    );
}

#[test]
fn a_blocked_ip_gets_429_on_static_assets_too() {
    let h = harness();
    assert_eq!(get(h.addr(), "/", None).status, 200);
    block_this_ip(&h);
    assert_eq!(get(h.addr(), "/", None).status, 429);
    assert_eq!(get(h.addr(), "/remote/assets/app.js", None).status, 429);
}

#[test]
fn a_blocked_ip_is_refused_before_its_head_is_read() {
    let h = harness();
    block_this_ip(&h);
    // 아무것도 보내지 않는다 — accept 직후의 판정만으로 429 가 와야 한다.
    let mut stream = connect(h.addr());
    let reply = read_reply(&mut stream);
    assert_eq!(reply.status, 429);
}

#[test]
fn an_unknown_path_is_404() {
    let h = harness();
    for path in [
        "/nope",
        "/api",
        "/api/state/extra",
        "/index.html",
        "/assets/app.js",
    ] {
        assert_json_error(&get(h.addr(), path, Some(TOKEN)), 404, "not found");
    }
}

#[test]
fn options_is_404() {
    let h = harness();
    for path in ["/api/state", "/api/tabs/1/input", "/"] {
        let reply = exchange(
            h.addr(),
            format!("OPTIONS {path} HTTP/1.1\r\nHost: mast\r\nOrigin: http://evil\r\n\r\n")
                .as_bytes(),
        );
        assert_eq!(reply.status, 404, "path {path}");
    }
}

#[test]
fn no_response_carries_a_cors_header() {
    let h = harness();
    block_free_replies(&h)
        .into_iter()
        .for_each(|(label, reply)| {
            for (name, _) in &reply.headers {
                assert!(
                    !name.to_ascii_lowercase().starts_with("access-control-"),
                    "{label} carries {name}"
                );
                assert!(
                    !name.eq_ignore_ascii_case("server"),
                    "{label} carries Server"
                );
            }
        });
}

/// 여러 종류의 응답 한 벌 — 헤더·본문 규칙을 응답 종류마다 확인하는 테스트가 공유한다.
fn block_free_replies(h: &Harness) -> Vec<(&'static str, Reply)> {
    let (tab, _) = terminal_tab(&h.dispatcher);
    vec![
        ("state 200", get(h.addr(), "/api/state", Some(TOKEN))),
        ("state 401", get(h.addr(), "/api/state", Some("wrong"))),
        ("unknown 404", get(h.addr(), "/nope", Some(TOKEN))),
        ("static 200", get(h.addr(), "/", None)),
        ("static 404", get(h.addr(), "/remote/nope.js", None)),
        (
            "screen 409",
            get(h.addr(), &format!("/api/tabs/{tab}/screen"), Some(TOKEN)),
        ),
        (
            "input 411",
            post(
                h.addr(),
                &format!("/api/tabs/{tab}/input"),
                Some(TOKEN),
                &[],
                b"",
            ),
        ),
    ]
}

#[test]
fn every_response_closes_the_connection() {
    let h = harness();
    for (label, reply) in block_free_replies(&h) {
        assert_eq!(reply.header("Connection"), Some("close"), "{label}");
        assert!(reply.header("Content-Length").is_some(), "{label}");
    }
}

#[test]
fn static_assets_need_no_token() {
    let h = harness();
    let index = get(h.addr(), "/", None);
    assert_eq!(index.status, 200);
    assert_eq!(index.header("Content-Type"), Some("text/html"));
    assert_eq!(index.body, INDEX_HTML);

    let js = get(h.addr(), "/remote/assets/app.js", None);
    assert_eq!(js.status, 200);
    assert_eq!(js.header("Content-Type"), Some("text/javascript"));
    assert_eq!(js.body, APP_JS);

    // 토큰을 붙여도 정적 자산은 같은 응답이다.
    assert_eq!(
        get(h.addr(), "/remote/index.html", Some(TOKEN)).body,
        INDEX_HTML
    );
}

#[test]
fn a_static_miss_is_404() {
    let h = harness();
    for path in [
        "/remote/nope.js",
        "/remote/assets/",
        "/remote/../index.html",
    ] {
        assert_json_error(&get(h.addr(), path, None), 404, "not found");
    }
}

#[test]
fn screen_for_an_unknown_tab_is_404_json() {
    let h = harness();
    assert_json_error(
        &get(h.addr(), "/api/tabs/999/screen", Some(TOKEN)),
        404,
        "unknown tab",
    );
}

#[test]
fn screen_for_a_tab_without_a_session_is_409_json() {
    let h = harness();
    let (tab, _) = terminal_tab(&h.dispatcher);
    assert_json_error(
        &get(h.addr(), &format!("/api/tabs/{tab}/screen"), Some(TOKEN)),
        409,
        "tab has no live session",
    );
}

#[test]
fn screen_for_an_exited_tab_is_409_json() {
    let h = harness();
    let (tab, session) = terminal_tab(&h.dispatcher);
    h.dispatcher
        .lock()
        .unwrap()
        .apply_event(SessionEvent::SessionExited {
            session,
            code: Some(0),
        });
    assert_json_error(
        &get(h.addr(), &format!("/api/tabs/{tab}/screen"), Some(TOKEN)),
        409,
        "tab has no live session",
    );
}

#[test]
fn input_without_content_length_is_411() {
    let h = harness();
    let (tab, _) = terminal_tab(&h.dispatcher);
    let path = format!("/api/tabs/{tab}/input?session=1:1");
    assert_json_error(
        &post(h.addr(), &path, Some(TOKEN), &[], b""),
        411,
        "content-length required",
    );
}

#[test]
fn input_with_transfer_encoding_is_411() {
    let h = harness();
    let (tab, _) = terminal_tab(&h.dispatcher);
    let path = format!("/api/tabs/{tab}/input?session=1:1");
    let reply = post(
        h.addr(),
        &path,
        Some(TOKEN),
        &[("Transfer-Encoding", "chunked")],
        b"5\r\nhello\r\n0\r\n\r\n",
    );
    assert_json_error(&reply, 411, "content-length required");
}

#[test]
fn input_with_conflicting_content_lengths_is_400() {
    let h = harness();
    let (tab, _) = terminal_tab(&h.dispatcher);
    let path = format!("/api/tabs/{tab}/input?session=1:1");
    let reply = post(
        h.addr(),
        &path,
        Some(TOKEN),
        &[("Content-Length", "5"), ("Content-Length", "6")],
        b"hello!",
    );
    assert_json_error(&reply, 400, "conflicting content-length");
}

#[test]
fn input_with_expect_is_417() {
    let h = harness();
    let (tab, _) = terminal_tab(&h.dispatcher);
    let path = format!("/api/tabs/{tab}/input?session=1:1");
    let reply = post(
        h.addr(),
        &path,
        Some(TOKEN),
        &[("Content-Length", "5"), ("Expect", "100-continue")],
        b"hello",
    );
    assert_json_error(&reply, 417, "expectation failed");
}

#[test]
fn input_over_the_body_cap_is_413_before_the_body_is_sent() {
    let h = harness();
    let (tab, _) = terminal_tab(&h.dispatcher);
    // 헤드만 보내고 본문은 한 바이트도 보내지 않는다 — 판정이 헤드만으로 끝나야 한다.
    let mut stream = connect(h.addr());
    let head = format!(
        "POST /api/tabs/{tab}/input?session=1:1 HTTP/1.1\r\nHost: mast\r\n\
         Authorization: Bearer {TOKEN}\r\nContent-Length: 70000\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).unwrap();
    let reply = read_reply(&mut stream);
    assert_json_error(&reply, 413, "body too large");
}

#[test]
fn a_client_that_already_sent_a_large_body_still_reads_the_413() {
    let h = harness();
    let (tab, _) = terminal_tab(&h.dispatcher);
    let body = vec![b'x'; 128 * 1024];
    let mut raw = format!(
        "POST /api/tabs/{tab}/input?session=1:1 HTTP/1.1\r\nHost: mast\r\n\
         Authorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    raw.extend_from_slice(&body);
    let reply = exchange(h.addr(), &raw);
    assert_json_error(&reply, 413, "body too large");
}

#[test]
fn an_oversized_request_head_is_431() {
    let h = harness();
    let mut raw = b"GET /api/state HTTP/1.1\r\nHost: mast\r\nX-Long: ".to_vec();
    raw.extend(std::iter::repeat_n(b'a', 9000));
    raw.extend_from_slice(b"\r\n\r\n");
    let reply = exchange(h.addr(), &raw);
    assert_json_error(&reply, 431, "request head too large");
}

#[test]
fn a_garbage_since_is_400() {
    let h = harness();
    let (tab, _) = terminal_tab(&h.dispatcher);
    for query in ["since=abc", "since=-1", "since=+1"] {
        let reply = get(
            h.addr(),
            &format!("/api/tabs/{tab}/screen?{query}"),
            Some(TOKEN),
        );
        assert_json_error(&reply, 400, "bad request");
    }
}

#[test]
fn input_without_a_session_token_is_409() {
    let h = harness();
    let (tab, _) = terminal_tab(&h.dispatcher);
    let reply = post(
        h.addr(),
        &format!("/api/tabs/{tab}/input"),
        Some(TOKEN),
        &[("Content-Length", "5")],
        b"hello",
    );
    assert_json_error(&reply, 409, "session changed");
}

#[test]
fn no_response_body_contains_the_token() {
    let h = harness();
    let mut replies = block_free_replies(&h);
    // 위 한 벌에 401 이 하나 섞여 있어 정확히 몇 번째에 차단되는지는 세지 않는다 —
    // 429 가 나올 때까지 두드리고 그 응답을 검사 대상에 넣는다.
    let blocked = (0..12)
        .map(|_| get(h.addr(), "/api/state", Some("wrong")))
        .find(|reply| reply.status == 429)
        .expect("the ip gets blocked within twelve failures");
    replies.push(("blocked 429", blocked));
    for (label, reply) in replies {
        assert!(
            !reply.text().contains(TOKEN),
            "{label} body leaks the token"
        );
        for (name, value) in &reply.headers {
            assert!(
                !value.contains(TOKEN),
                "{label} header {name} leaks the token"
            );
        }
    }
}
