//! mast-remote 서버 통합 테스트 — 실제 `sh` 를 PTY 로 띄우는 부분 (unix 전용).
//!
//! `PtyHost` 가 `SessionManager::create` 로 진짜 셸을 스폰하므로, `/screen` 이 돌려주는
//! 바이트와 `/input` 이 PTY 에 쓰는 바이트를 끝에서 끝까지 본다. sink 는 출력을 버리는
//! `DropSink` 다 — ack 없이도 세션이 자유 진행하는 성질(코어의
//! `dropped_sink_keeps_session_free_running`)에 기댄다.
//!
//! 이 파일은 **통째로** unix 에 가둔다 — 함수 단위로 가르면 남는 헬퍼가 dead code 로
//! 잡혀 `-D warnings` 가 빨개진다. 그 결과 Windows 타깃 clippy 는 파일 내용을 보지
//! 못한다. Linux CI 는 테스트를 실행하지만 이 타깃에 clippy 를 돌리지는 않는다.
#![cfg(unix)]

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use mast_core::command::{Command, CommandOutput, Dispatcher, NewTab, SessionHost, ShellSpawnReq};
use mast_core::osc::OscEvent;
use mast_core::session::{
    Delivery, SessionId, SessionManager, SessionOptions, SessionSink, SpawnSpec,
};
use mast_remote::{serve, RemoteConfig, RemoteDeps, RemoteServer};

const TOKEN: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const TIMEOUT: Duration = Duration::from_secs(10);
/// 만료 경로 테스트 전용 리스 — 운영값(30초)을 기다릴 수는 없다.
const TEST_LEASE: Duration = Duration::from_millis(300);
/// 대화형 `sh` 가 띄우는 프롬프트의 공통 꼬리 — dash 는 `$ `, bash-as-sh 는 `sh-5.2$ `.
const PROMPT: &[u8] = b"$ ";

struct DropSink;

impl SessionSink for DropSink {
    fn on_output(&self, _offset: u64, _bytes: &[u8]) -> Delivery {
        Delivery::Dropped
    }
    fn on_osc(&self, _event: &OscEvent) {}
    fn on_exit(&self, _code: Option<u32>) {}
}

/// 사양은 코어 테스트의 `sh_spec` 과 같다.
struct PtyHost {
    sessions: Arc<SessionManager>,
}

impl SessionHost for PtyHost {
    fn spawn_shell(&self, req: ShellSpawnReq) -> anyhow::Result<SessionId> {
        self.sessions.create(
            SpawnSpec {
                program: "sh".into(),
                args: vec![],
                cwd: None,
                cols: req.cols,
                rows: req.rows,
            },
            SessionOptions::default(),
            |_| Box::new(DropSink),
        )
    }

    fn kill(&self, id: SessionId) {
        self.sessions.remove(id);
    }
}

struct Harness {
    server: RemoteServer,
    dispatcher: Arc<Mutex<Dispatcher>>,
    sessions: Arc<SessionManager>,
    log: Arc<Mutex<Vec<String>>>,
    tab: u64,
    session: SessionId,
    /// 이 서버가 쓰는 모바일 크기 리스 — `serve_again` 이 같은 값으로 서버를 하나 더 띄운다.
    lease: Duration,
}

impl Harness {
    fn addr(&self) -> SocketAddr {
        self.server.local_addr()
    }
}

/// 서버 + 워크스페이스 + 살아 있는 `sh` 탭 하나. 리스는 운영값(30초)이라 폴 몇 번으로는
/// 만료되지 않는다 — 만료 경로는 [`harness_with_lease`] 로 짧게 잡아 검증한다.
fn harness() -> Harness {
    harness_with_lease(mast_remote::MOBILE_SIZE_LEASE)
}

fn harness_with_lease(lease: Duration) -> Harness {
    let sessions = Arc::new(SessionManager::new());
    let dispatcher = Arc::new(Mutex::new(Dispatcher::new(Box::new(PtyHost {
        sessions: Arc::clone(&sessions),
    }))));
    let (tab, session) = {
        let out = dispatcher
            .lock()
            .unwrap()
            .dispatch(Command::CreateWorkspace {
                name: "ws".into(),
                root_path: None,
                distro: None,
                tab: Some(NewTab::Terminal { cwd: None }),
            })
            .expect("spawn sh");
        match out {
            CommandOutput::WorkspaceCreated {
                tab: Some(tab),
                session: Some(session),
                ..
            } => (tab.0, session),
            other => panic!("unexpected output: {other:?}"),
        }
    };
    let log = Arc::new(Mutex::new(Vec::new()));
    let log_sink = Arc::clone(&log);
    let server = serve(
        RemoteConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            token: TOKEN.to_string(),
            mobile_lease: lease,
        },
        RemoteDeps {
            dispatcher: Arc::clone(&dispatcher),
            sessions: Arc::clone(&sessions),
            assets: Arc::new(|_: &str| None),
            log: Arc::new(move |line: String| log_sink.lock().unwrap().push(line)),
        },
    )
    .expect("bind 127.0.0.1:0");
    Harness {
        server,
        dispatcher,
        sessions,
        log,
        tab,
        session,
        lease,
    }
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> &str {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
            .unwrap_or_else(|| panic!("no {name} header"))
    }

    fn end_offset(&self) -> u64 {
        self.header("X-Mast-End-Offset").parse().unwrap()
    }

    fn reset(&self) -> bool {
        self.header("X-Mast-Reset") == "1"
    }

    fn session(&self) -> String {
        self.header("X-Mast-Session").to_string()
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

fn connect(addr: SocketAddr) -> TcpStream {
    let stream = TcpStream::connect(addr).expect("connect");
    stream.set_read_timeout(Some(TIMEOUT)).unwrap();
    stream
}

fn read_reply(stream: &mut TcpStream) -> Reply {
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("read response");
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("head terminator");
    let head = std::str::from_utf8(&raw[..split]).unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse().ok())
        .expect("status line");
    let headers = lines
        .map(|line| {
            let (k, v) = line.split_once(':').unwrap();
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
    stream.write_all(raw).unwrap();
    read_reply(&mut stream)
}

/// 같은 Dispatcher·세션 위에 서버를 하나 더 띄운다 — 앱을 재시작한 뒤의 두 번째 프로세스와
/// 같은 상황(세션 id 는 같고 epoch 만 다르다)을 만드는 가장 가까운 방법이다.
fn serve_again(h: &Harness) -> RemoteServer {
    serve(
        RemoteConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            token: TOKEN.to_string(),
            mobile_lease: h.lease,
        },
        RemoteDeps {
            dispatcher: Arc::clone(&h.dispatcher),
            sessions: Arc::clone(&h.sessions),
            assets: Arc::new(|_: &str| None),
            log: Arc::new(|_: String| {}),
        },
    )
    .expect("bind a second server")
}

/// `since` 는 (offset, 세션 토큰) — 둘 다 없으면 첫 요청(reset)이다.
fn screen(h: &Harness, since: Option<(u64, &str)>) -> Reply {
    screen_on(h.addr(), h.tab, since)
}

fn screen_on(addr: SocketAddr, tab: u64, since: Option<(u64, &str)>) -> Reply {
    let query = match since {
        Some((offset, session)) => format!("?since={offset}&session={session}"),
        None => String::new(),
    };
    exchange(
        addr,
        format!(
            "GET /api/tabs/{tab}/screen{query} HTTP/1.1\r\nHost: mast\r\n\
             Authorization: Bearer {TOKEN}\r\n\r\n"
        )
        .as_bytes(),
    )
}

fn input(h: &Harness, session: &str, body: &[u8]) -> Reply {
    let mut raw = format!(
        "POST /api/tabs/{}/input?session={session} HTTP/1.1\r\nHost: mast\r\n\
         Authorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n",
        h.tab,
        body.len()
    )
    .into_bytes();
    raw.extend_from_slice(body);
    exchange(h.addr(), &raw)
}

/// `POST /api/tabs/{id}/resize?mode=…`. `session` 이 None 이면 토큰 없이 보낸다.
fn resize(h: &Harness, session: Option<&str>, mode_query: &str) -> Reply {
    let session_query = match session {
        Some(token) => format!("session={token}&"),
        None => String::new(),
    };
    exchange(
        h.addr(),
        format!(
            "POST /api/tabs/{}/resize?{session_query}{mode_query} HTTP/1.1\r\nHost: mast\r\n\
             Authorization: Bearer {TOKEN}\r\nContent-Length: 0\r\n\r\n",
            h.tab
        )
        .as_bytes(),
    )
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn wait_for(h: &Harness, needle: &[u8]) -> Reply {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let reply = screen(h, None);
        assert_eq!(reply.status, 200, "{}", reply.text());
        if contains(&reply.body, needle) {
            return reply;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {:?}; screen was {:?}",
            String::from_utf8_lossy(needle),
            reply.text()
        );
        thread::sleep(Duration::from_millis(50));
    }
}

/// 조용해질 시간을 준 뒤의 스냅샷 — "나타나지 **않는다**" 를 말할 때 쓴다.
fn settled_screen(h: &Harness) -> Reply {
    thread::sleep(Duration::from_millis(400));
    screen(h, None)
}

#[test]
fn screen_returns_a_reset_snapshot_then_an_empty_delta_then_new_bytes() {
    let h = harness();
    let first = wait_for(&h, PROMPT);
    assert!(first.reset(), "a first request is a reset");
    assert_eq!(first.header("X-Mast-Cols"), "80");
    assert_eq!(first.header("X-Mast-Rows"), "24");
    let token = first.session();
    assert!(
        token.ends_with(&format!(":{}", h.session)),
        "session token {token} must end with the session id"
    );
    assert_eq!(first.header("Content-Type"), "application/octet-stream");

    // 프롬프트 뒤로 조용하므로 델타는 비어 있다.
    thread::sleep(Duration::from_millis(200));
    let settled = screen(&h, None);
    let delta = screen(&h, Some((settled.end_offset(), &token)));
    assert_eq!(delta.status, 200);
    assert!(!delta.reset());
    assert!(delta.body.is_empty(), "{:?}", delta.text());
    assert_eq!(delta.end_offset(), settled.end_offset());

    assert_eq!(input(&h, &token, b"echo NEW-1\r").status, 200);
    let deadline = Instant::now() + TIMEOUT;
    let grown = loop {
        let delta = screen(&h, Some((settled.end_offset(), &token)));
        assert!(!delta.reset(), "the offset is inside the retained window");
        if contains(&delta.body, b"NEW-1") {
            break delta;
        }
        assert!(Instant::now() < deadline, "no NEW-1 in {:?}", delta.text());
        thread::sleep(Duration::from_millis(50));
    };
    // 델타 계약: end_offset = since + 델타 길이.
    assert_eq!(
        grown.end_offset(),
        settled.end_offset() + grown.body.len() as u64
    );
}

#[test]
fn screen_delta_with_a_stale_session_token_is_a_reset() {
    let h = harness();
    let first = wait_for(&h, PROMPT);
    let stale = format!("1:{}", h.session + 1000);
    let reply = screen(&h, Some((first.end_offset(), &stale)));
    assert_eq!(reply.status, 200);
    assert!(reply.reset(), "an offset from another session must reset");
    assert!(contains(&reply.body, PROMPT));
    assert_eq!(reply.session(), first.session());
}

#[test]
fn screen_delta_with_a_token_from_an_earlier_process_is_a_reset() {
    let h = harness();
    let first = wait_for(&h, PROMPT);
    let old_token = first.session();
    // 두 번째 서버는 같은 세션 id 를 다른 epoch 아래에서 낸다 — 앱 재시작 뒤의 모양이다.
    let restarted = serve_again(&h);
    let reply = screen_on(
        restarted.local_addr(),
        h.tab,
        Some((first.end_offset(), &old_token)),
    );
    assert_eq!(reply.status, 200);
    assert!(reply.reset(), "a token from another epoch must reset");
    assert_ne!(reply.session(), old_token, "the epoch must differ");
    assert!(
        reply.session().ends_with(&format!(":{}", h.session)),
        "the session id itself is unchanged"
    );
    // 입력도 같은 판정이다 — 옛 epoch 의 토큰으로는 쓰지 못한다.
    let refused = exchange(
        restarted.local_addr(),
        format!(
            "POST /api/tabs/{}/input?session={old_token} HTTP/1.1\r\nHost: mast\r\n\
             Authorization: Bearer {TOKEN}\r\nContent-Length: 6\r\n\r\necho x\r",
            h.tab
        )
        .as_bytes(),
    );
    assert_eq!(refused.status, 409);
}

#[test]
fn input_reaches_the_pty_and_appears_in_the_next_screen() {
    let h = harness();
    let token = wait_for(&h, PROMPT).session();
    // CR 없이 보낸다 — 서버가 CR 을 덧붙이지 않으므로 셸은 줄을 실행하지 않고 echo 만 한다.
    assert_eq!(input(&h, &token, b"printf 'A%sB\\n' LIVE").status, 200);
    let echoed = wait_for(&h, b"printf 'A%sB");
    assert!(
        !contains(&echoed.body, b"ALIVEB"),
        "the line ran without a CR: {:?}",
        echoed.text()
    );
    assert_eq!(input(&h, &token, b"\r").status, 200);
    wait_for(&h, b"ALIVEB");
}

#[test]
fn input_arriving_split_across_reads_is_written_once_and_whole() {
    let h = harness();
    let token = wait_for(&h, PROMPT).session();
    let body = b"printf 'S%sE\\n' PLIT\r";
    let head = format!(
        "POST /api/tabs/{}/input?session={token} HTTP/1.1\r\nHost: mast\r\n\
         Authorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n",
        h.tab,
        body.len()
    );
    let mut stream = connect(h.addr());
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(&body[..6]).unwrap();
    stream.flush().unwrap();
    thread::sleep(Duration::from_millis(150));
    stream.write_all(&body[6..]).unwrap();
    let reply = read_reply(&mut stream);
    assert_eq!(reply.status, 200, "{}", reply.text());
    wait_for(&h, b"SPLITE");
}

#[test]
fn input_with_a_stale_session_token_is_409_and_not_written() {
    let h = harness();
    wait_for(&h, PROMPT);
    let stale = format!("1:{}", h.session + 1000);
    let reply = input(&h, &stale, b"echo NOPE-STALE\r");
    assert_eq!(reply.status, 409);
    assert_eq!(reply.text(), "{\"error\":\"session changed\"}");
    let after = settled_screen(&h);
    assert!(
        !contains(&after.body, b"NOPE-STALE"),
        "a rejected input reached the pty: {:?}",
        after.text()
    );
}

#[test]
fn input_success_is_200_with_an_empty_body() {
    let h = harness();
    let token = wait_for(&h, PROMPT).session();
    let reply = input(&h, &token, b"\r");
    assert_eq!(reply.status, 200);
    assert!(reply.body.is_empty());
    assert_eq!(reply.header("Content-Length"), "0");
}

#[test]
fn input_to_a_killed_session_is_500() {
    let h = harness();
    let token = wait_for(&h, PROMPT).session();
    // 레지스트리에는 남기고 세션만 죽인다 — 탭은 여전히 Running 이라 write 까지 간다.
    h.sessions.get(h.session).unwrap().kill();
    let reply = input(&h, &token, b"echo x\r");
    assert_eq!(reply.status, 500);
    assert_eq!(reply.text(), "{\"error\":\"write failed\"}");
    let log = h.log.lock().unwrap().clone();
    assert!(
        log.iter()
            .any(|l| l.starts_with("remote: input write failed")),
        "log: {log:?}"
    );
}

#[test]
fn input_truncated_before_content_length_is_400_and_not_written() {
    let h = harness();
    let token = wait_for(&h, PROMPT).session();
    let head = format!(
        "POST /api/tabs/{}/input?session={token} HTTP/1.1\r\nHost: mast\r\n\
         Authorization: Bearer {TOKEN}\r\nContent-Length: 40\r\n\r\n",
        h.tab
    );
    let mut stream = connect(h.addr());
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(b"echo TRUNC").unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    let reply = read_reply(&mut stream);
    assert_eq!(reply.status, 400, "{}", reply.text());
    assert_eq!(reply.text(), "{\"error\":\"incomplete body\"}");
    let after = settled_screen(&h);
    assert!(
        !contains(&after.body, b"TRUNC"),
        "a partial body reached the pty: {:?}",
        after.text()
    );
}

#[test]
fn a_second_client_gets_its_own_reset_snapshot() {
    let h = harness();
    let first = wait_for(&h, PROMPT);
    let second = screen(&h, None);
    assert!(second.reset());
    assert!(contains(&second.body, PROMPT));
    assert_eq!(second.session(), first.session());
    assert_eq!(second.header("X-Mast-Cols"), "80");
}

// --- PTY 크기 소유권 (`/resize` — ADR-0016 개정) ---
//
// 폰의 Mobile 버튼은 이 탭의 셸을 폰 크기로 줄이고, Desktop 버튼은 데스크톱 pane
// 크기로 되돌린다. 데스크톱의 자동 resize(글루의 `resize` 커맨드가 부르는
// `PtySession::resize`)는 폰이 소유하는 동안 억제된다 — 여기서는 그 커맨드가 부르는
// 것과 **같은 메서드**를 직접 불러 그 경로를 검증한다.

#[test]
fn mobile_resize_shrinks_the_pty_and_the_screen_reports_the_owner() {
    let h = harness();
    let first = wait_for(&h, PROMPT);
    let token = first.session();
    assert_eq!(first.header("X-Mast-Size-Owner"), "desktop");

    let reply = resize(&h, Some(&token), "mode=mobile&cols=60&rows=20");
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.header("X-Mast-Size-Owner"), "mobile");
    assert_eq!(reply.header("X-Mast-Cols"), "60");
    assert_eq!(reply.header("X-Mast-Rows"), "20");

    // 세션이 기억한 값이 아니라 **커널이 본** 크기로 확인한다 — `stty size` 는
    // rows cols 를 찍으므로 resize 가 실제 PTY 에 들어갔는지 끝에서 끝까지 본다.
    input(&h, &token, b"stty size\r");
    let printed = wait_for(&h, b"20 60");
    assert!(
        contains(&printed.body, b"20 60"),
        "stty size did not see 20 60: {:?}",
        printed.text()
    );

    // 화면 응답도 같은 크기·소유자를 싣는다.
    let screen = screen(&h, None);
    assert_eq!(screen.header("X-Mast-Cols"), "60");
    assert_eq!(screen.header("X-Mast-Rows"), "20");
    assert_eq!(screen.header("X-Mast-Size-Owner"), "mobile");
}

#[test]
fn desktop_resize_is_suppressed_while_mobile_owns_and_release_restores_the_current_size() {
    let h = harness();
    let token = wait_for(&h, PROMPT).session();
    let pty = h.sessions.get(h.session).expect("live session");

    assert_eq!(
        resize(&h, Some(&token), "mode=mobile&cols=48&rows=18").status,
        200
    );

    // 데스크톱이 창을 두 번 옮겼다 — 둘 다 PTY 에 닿지 않고 기록만 갱신된다.
    pty.resize(100, 40).expect("desktop resize");
    pty.resize(120, 35).expect("desktop resize");
    let held = screen(&h, None);
    assert_eq!(
        (held.header("X-Mast-Cols"), held.header("X-Mast-Rows")),
        ("48", "18"),
        "데스크톱 자동 resize 가 폰 크기를 덮었다"
    );

    // Desktop 버튼 — 주장 시점의 크기가 아니라 마지막 pane 크기(120x35)로 돌아간다.
    let reply = resize(&h, Some(&token), "mode=desktop");
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.header("X-Mast-Size-Owner"), "desktop");
    assert_eq!(reply.header("X-Mast-Cols"), "120");
    assert_eq!(reply.header("X-Mast-Rows"), "35");

    let restored = screen(&h, None);
    assert_eq!(restored.header("X-Mast-Cols"), "120");
    assert_eq!(restored.header("X-Mast-Rows"), "35");
    assert_eq!(restored.header("X-Mast-Size-Owner"), "desktop");
}

#[test]
fn a_lapsed_lease_is_released_by_the_next_token_poll() {
    let h = harness_with_lease(TEST_LEASE);
    let token = wait_for(&h, PROMPT).session();
    let pty = h.sessions.get(h.session).expect("live session");
    assert_eq!(
        resize(&h, Some(&token), "mode=mobile&cols=48&rows=18").status,
        200
    );
    // 폰이 사라진 사이 데스크톱이 창을 옮겼다 — 기록만 남는다.
    pty.resize(120, 35).expect("desktop resize");

    // 리스(TEST_LEASE)가 지나고 돌아온 폴 — 그 자리에서 데스크톱 크기가 복원된다.
    thread::sleep(TEST_LEASE + Duration::from_millis(150));
    let screen = screen(&h, Some((0, &token)));
    assert_eq!(screen.status, 200);
    assert_eq!(screen.header("X-Mast-Size-Owner"), "desktop");
    assert_eq!(screen.header("X-Mast-Cols"), "120");
    assert_eq!(screen.header("X-Mast-Rows"), "35");
    let log = h.log.lock().unwrap().clone();
    assert!(
        log.iter()
            .any(|l| l.starts_with("remote: mobile size lease lapsed")),
        "log: {log:?}"
    );
}

#[test]
fn a_tokenless_poll_neither_renews_nor_releases_a_lapsed_lease() {
    let h = harness_with_lease(TEST_LEASE);
    let token = wait_for(&h, PROMPT).session();
    assert_eq!(
        resize(&h, Some(&token), "mode=mobile&cols=48&rows=18").status,
        200
    );

    thread::sleep(TEST_LEASE + Duration::from_millis(150));
    // since 없는 폴(첫 요청·↻)은 하트비트가 아니다 — 소유권을 연장하지도, 그렇다고
    // 이 요청이 복원을 대신하지도 않는다. 소유자만 데스크톱으로 보고되고 PTY 는
    // 아직 폰 크기다 (screen_since rustdoc 의 그 순간).
    let since_less = screen(&h, None);
    assert_eq!(since_less.header("X-Mast-Size-Owner"), "desktop");
    assert_eq!(since_less.header("X-Mast-Cols"), "48");

    // 다음 토큰 폴이 복원을 수행한다 — 이 테스트에서는 데스크톱 resize 가 없었으니
    // 데스크톱 기록은 스폰 크기(80x24)다.
    let token_poll = screen(&h, Some((0, &token)));
    assert_eq!(token_poll.header("X-Mast-Size-Owner"), "desktop");
    assert_eq!(token_poll.header("X-Mast-Cols"), "80");
    assert_eq!(token_poll.header("X-Mast-Rows"), "24");
}

#[test]
fn resize_with_a_stale_session_token_is_409_and_does_not_touch_the_size() {
    let h = harness();
    let token = wait_for(&h, PROMPT).session();
    let stale = format!("1:{}", h.session + 1000);
    let reply = resize(&h, Some(&stale), "mode=mobile&cols=48&rows=18");
    assert_eq!(reply.status, 409);
    assert_eq!(reply.text(), "{\"error\":\"session changed\"}");
    let after = screen(&h, None);
    assert_eq!(after.header("X-Mast-Cols"), "80");
    assert_eq!(after.header("X-Mast-Rows"), "24");
    assert_eq!(after.header("X-Mast-Size-Owner"), "desktop");
}

#[test]
fn resize_clamps_extreme_mobile_sizes() {
    let h = harness();
    let token = wait_for(&h, PROMPT).session();
    let reply = resize(&h, Some(&token), "mode=mobile&cols=65535&rows=1");
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.header("X-Mast-Size-Owner"), "mobile");
    assert_eq!(reply.header("X-Mast-Cols"), "400");
    assert_eq!(reply.header("X-Mast-Rows"), "5");
}
