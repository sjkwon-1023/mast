//! Secure Remote 서버 통합 테스트 — 실제 QUIC 클라이언트(같은 크레이트의 client)와
//! 실제 `sh` PTY 를 끝에서 끝까지 붙인다.
//!
//! 클라이언트는 `serverCertificateHashes` 검증을 그대로 쓴다: 올바른 DER SHA-256 만
//! 연결되고 다른 hash 는 핸드셰이크에서 실패한다 — Chromium 이 하는 검증의 로컬 대응이다.
//! 실제 브라우저 왕복은 이 테스트가 아니라 `docs/WINDOWS-BUILD.md` §17 의 현장 체크가
//! 확인한다.
//!
//! PTY 로 `sh` 를 쓰므로 이 파일은 **통째로** unix 에 가둔다 (`server_pty.rs` 와 같다).
//! 그 결과 CI 린트 사각지대가 있다: `--all-targets` 로 이 테스트 타깃도 컴파일하는
//! Windows 타깃 clippy 에서는 `#![cfg(unix)]` 가 파일을 비워 내용을 보지 못하고, Linux
//! 게이트는 테스트만 실행하고 clippy 를 돌리지 않는다 — 이 파일은 어느 쪽에서도 린트되지
//! 않는다.
#![cfg(unix)]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mast_core::command::{Command, CommandOutput, Dispatcher, NewTab, SessionHost, ShellSpawnReq};
use mast_core::osc::OscEvent;
use mast_core::session::{
    Delivery, SessionId, SessionManager, SessionOptions, SessionSink, SpawnSpec,
};
use mast_remote::{
    InputWriter, SecureRemote, SecureRemoteConfig, SecureRemoteDeps, SecureRemoteState,
    SecureRemoteTimeouts,
};
use serde_json::{json, Value};
use tokio::time::timeout;
use web_transport_quinn::http::{HeaderName, HeaderValue};
use web_transport_quinn::proto::ConnectRequest;
use web_transport_quinn::quinn;
use web_transport_quinn::{Client, ClientBuilder, RecvStream, SendStream, Session};

const TOKEN: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const NEW_TOKEN: &str = "ABCDEFGabcdefghijklmnopqrstuvwxyz0123456789";
const ORIGIN: &str = "https://sjkwon-1023.github.io";
const REPLY_DEADLINE: Duration = Duration::from_secs(10);

struct DropSink;

impl SessionSink for DropSink {
    fn on_output(&self, _offset: u64, _bytes: &[u8]) -> Delivery {
        Delivery::Dropped
    }
    fn on_osc(&self, _event: &OscEvent) {}
    fn on_exit(&self, _code: Option<u32>) {}
}

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
    server: Option<SecureRemote>,
    dispatcher: Arc<Mutex<Dispatcher>>,
    sessions: Arc<SessionManager>,
    /// 페어링 사이에 **같은** coordinator 를 들고 있다 — 이전 페어링의 막힌 쓰기가
    /// 다음 페어링의 슬롯에 보이는 것이 이 테스트 파일의 계약이다.
    writer: Arc<InputWriter>,
    log: Arc<Mutex<Vec<String>>>,
    tab: u64,
    session: SessionId,
    token: String,
    port: u16,
    hash: [u8; 32],
}

impl Harness {
    fn new(token: &str, timeouts: SecureRemoteTimeouts) -> Self {
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
        let writer = Arc::new(InputWriter::new());
        let server = start_server(
            "127.0.0.1:0".parse().unwrap(),
            &dispatcher,
            &sessions,
            &writer,
            &log,
            token,
            timeouts,
        );
        let port = server.local_addr().port();
        let hash = *server.cert_hash();
        Harness {
            server: Some(server),
            dispatcher,
            sessions,
            writer,
            log,
            tab,
            session,
            token: token.to_string(),
            port,
            hash,
        }
    }

    fn server(&self) -> &SecureRemote {
        self.server.as_ref().expect("server is running")
    }

    fn port(&self) -> u16 {
        self.port
    }

    fn hash(&self) -> [u8; 32] {
        self.hash
    }

    fn pty(&self) -> Arc<mast_core::session::PtySession> {
        self.sessions.get(self.session).expect("live session")
    }

    fn logs(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn stop(&mut self) {
        if let Some(mut server) = self.server.take() {
            server.stop();
        }
    }

    /// 같은 Dispatcher·세션 위에 새 토큰·새 인증서로 다시 띄운다 (재페어링).
    ///
    /// 새 OS 배정 포트(`127.0.0.1:0`)를 쓴다 — 이전 포트를 그대로 다시 잡으면 그 사이
    /// 다른 테스트의 QUIC 엔드포인트가 그 번호를 가져가 바인드가 깨진다. 이전 포트의
    /// 해제 자체는 `stop_releases_the_udp_socket` 이 inode 로 검증한다.
    fn restart(&mut self, token: &str, timeouts: SecureRemoteTimeouts) {
        assert!(self.server.is_none(), "stop first");
        let server = start_server(
            "127.0.0.1:0".parse().unwrap(),
            &self.dispatcher,
            &self.sessions,
            &self.writer,
            &self.log,
            token,
            timeouts,
        );
        self.port = server.local_addr().port();
        self.hash = *server.cert_hash();
        self.token = token.to_string();
        self.server = Some(server);
    }
}

fn start_server(
    bind: std::net::SocketAddr,
    dispatcher: &Arc<Mutex<Dispatcher>>,
    sessions: &Arc<SessionManager>,
    writer: &Arc<InputWriter>,
    log: &Arc<Mutex<Vec<String>>>,
    token: &str,
    timeouts: SecureRemoteTimeouts,
) -> SecureRemote {
    let log_sink = Arc::clone(log);
    SecureRemote::start(
        SecureRemoteConfig {
            bind,
            lan_ip: std::net::Ipv4Addr::LOCALHOST,
            origin: ORIGIN.to_string(),
            token: token.to_string(),
            timeouts,
        },
        SecureRemoteDeps {
            dispatcher: Arc::clone(dispatcher),
            sessions: Arc::clone(sessions),
            writer: Arc::clone(writer),
            log: Arc::new(move |line: String| log_sink.lock().unwrap().push(line)),
        },
    )
    .expect("start secure remote")
}

fn default_timeouts() -> SecureRemoteTimeouts {
    SecureRemoteTimeouts::default()
}

fn client(hash: &[u8; 32]) -> Client {
    ClientBuilder::new()
        .with_server_certificate_hashes(vec![hash.to_vec()])
        .expect("build client")
}

/// 해시 하나만 신뢰하는 테스트 전용 검증기 — 제품 클라이언트의
/// `serverCertificateHashes` 판정을 로컬 rustls 로 그대로 옮긴 것이다.
#[derive(Debug)]
struct HashVerifier {
    provider: web_transport_quinn::crypto::Provider,
    hash: [u8; 32],
}

impl rustls::client::danger::ServerCertVerifier for HashVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let digest = web_transport_quinn::crypto::sha256(&self.provider, end_entity);
        if digest.as_ref() == self.hash {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::UnknownIssuer,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// 바인드 주소를 고를 수 있는 WebTransport 클라이언트. `ClientBuilder` 는 QUIC
/// endpoint 의 로컬 주소를 노출하지 않아, 같은 머신의 다른 IP(루프백 별칭
/// `127.0.0.x`)에서 온 페어링을 흉내내려면 TLS/QUIC 설정을 직접 조립해야 한다.
fn client_from(local: &str, hash: &[u8; 32]) -> Client {
    let (endpoint, config) = client_parts(local, hash);
    Client::new(endpoint, config)
}

fn client_parts(local: &str, hash: &[u8; 32]) -> (quinn::Endpoint, quinn::ClientConfig) {
    let provider = web_transport_quinn::crypto::default_provider();
    let mut crypto = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("TLS 1.3")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(HashVerifier {
            provider,
            hash: *hash,
        }))
        .with_no_client_auth();
    crypto.alpn_protocols = vec![web_transport_quinn::ALPN.as_bytes().to_vec()];
    let quic =
        quinn::crypto::rustls::QuicClientConfig::try_from(crypto).expect("QUIC client config");
    let mut config = quinn::ClientConfig::new(Arc::new(quic));
    config.transport_config(Arc::new(quinn::TransportConfig::default()));
    let endpoint = quinn::Endpoint::client(local.parse().expect("local address"))
        .expect("bind the test client");
    (endpoint, config)
}

async fn connect_with(
    h: &Harness,
    hash: &[u8; 32],
    origin: &str,
    path: &str,
) -> Result<Session, web_transport_quinn::ClientError> {
    let url = url::Url::parse(&format!("https://127.0.0.1:{}{path}", h.port())).unwrap();
    let request = ConnectRequest::new(url).with_header(
        HeaderName::from_static("origin"),
        HeaderValue::from_str(origin).expect("origin header"),
    );
    client(hash).connect(request).await
}

async fn connect(h: &Harness) -> Session {
    connect_with(h, &h.hash(), ORIGIN, "/wt")
        .await
        .expect("connect")
}

/// 지정한 로컬 주소에서 접속하는 클라이언트로 CONNECT 를 건다.
async fn connect_as(
    h: &Harness,
    local: &str,
    path: &str,
) -> Result<Session, web_transport_quinn::ClientError> {
    connect_as_with(h, local, ORIGIN, path).await
}

/// Origin 까지 지정하는 판 — path·Origin 거절을 같은 헬퍼로 만든다.
async fn connect_as_with(
    h: &Harness,
    local: &str,
    origin: &str,
    path: &str,
) -> Result<Session, web_transport_quinn::ClientError> {
    let url = url::Url::parse(&format!("https://127.0.0.1:{}{path}", h.port())).unwrap();
    let request = ConnectRequest::new(url).with_header(
        HeaderName::from_static("origin"),
        HeaderValue::from_str(origin).expect("origin header"),
    );
    client_from(local, &h.hash()).connect(request).await
}

/// 소유 값만으로 CONNECT 를 걸어 `tokio::spawn` 에 넣을 수 있게 한 판 (거절 폭주 테스트).
async fn connect_owned(
    port: u16,
    hash: [u8; 32],
    origin: &'static str,
    path: &'static str,
) -> Result<Session, web_transport_quinn::ClientError> {
    let url = url::Url::parse(&format!("https://127.0.0.1:{port}{path}")).unwrap();
    let request = ConnectRequest::new(url).with_header(
        HeaderName::from_static("origin"),
        HeaderValue::from_str(origin).expect("origin header"),
    );
    client(&hash).connect(request).await
}

/// 로컬 주소까지 지정하되 소유 값만 쓰는 판 — 차단된 IP(127.0.0.2)의 재시도 폭주를
/// `tokio::spawn` 에 넣기 위한 것이다 ( [`connect_as`] 는 `&Harness` 를 빌린다).
async fn connect_as_owned(
    local: &'static str,
    port: u16,
    hash: [u8; 32],
    origin: &'static str,
    path: &'static str,
) -> Result<Session, web_transport_quinn::ClientError> {
    let url = url::Url::parse(&format!("https://127.0.0.1:{port}{path}")).unwrap();
    let request = ConnectRequest::new(url).with_header(
        HeaderName::from_static("origin"),
        HeaderValue::from_str(origin).expect("origin header"),
    );
    client_from(local, &hash).connect(request).await
}

async fn send_json(send: &mut SendStream, value: &Value) {
    let payload = serde_json::to_vec(value).unwrap();
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    send.write_all(&frame).await.expect("write frame");
}

async fn recv_json_with(recv: &mut RecvStream, deadline: Duration) -> Value {
    let read = async {
        let mut len = [0u8; 4];
        recv.read_exact(&mut len).await.expect("read frame length");
        let n = u32::from_be_bytes(len) as usize;
        let mut buf = vec![0u8; n];
        recv.read_exact(&mut buf).await.expect("read frame payload");
        serde_json::from_slice(&buf).expect("frame is json")
    };
    timeout(deadline, read).await.expect("frame in time")
}

async fn recv_json(recv: &mut RecvStream) -> Value {
    recv_json_with(recv, REPLY_DEADLINE).await
}

/// 패닉 없이 기다려 보는 판 — "오지 않는다"를 확인할 때만 쓴다. 타임아웃이면 `Err`.
async fn try_recv_json(recv: &mut RecvStream, deadline: Duration) -> Result<Value, ()> {
    let read = async {
        let mut len = [0u8; 4];
        recv.read_exact(&mut len).await.ok()?;
        let n = u32::from_be_bytes(len) as usize;
        let mut buf = vec![0u8; n];
        recv.read_exact(&mut buf).await.ok()?;
        serde_json::from_slice(&buf).ok()
    };
    match timeout(deadline, read).await {
        Ok(Some(value)) => Ok(value),
        Ok(None) | Err(_) => Err(()),
    }
}

/// 다음 바이트가 오지 않고 스트림이 끝나는 것을 확인한다 (서버가 연결을 닫았다).
async fn expect_closed(recv: &mut RecvStream) {
    let mut byte = [0u8; 1];
    match timeout(REPLY_DEADLINE, recv.read(&mut byte)).await {
        Ok(Ok(None)) | Ok(Err(_)) => {}
        Ok(Ok(Some(_))) => panic!("unexpected data on a closing stream"),
        Err(_) => panic!("connection did not close"),
    }
}

/// auth 왕복까지 끝낸 (session, send, recv). 실패하면 패닉한다.
async fn authenticate(h: &Harness, token: &str) -> (Session, SendStream, RecvStream) {
    let session = connect(h).await;
    let (mut send, mut recv) = session.open_bi().await.expect("open_bi");
    send_json(
        &mut send,
        &json!({"v": 1, "id": 1, "type": "auth", "token": token}),
    )
    .await;
    let reply = recv_json(&mut recv).await;
    assert_eq!(reply["ok"], true, "auth reply: {reply}");
    (session, send, recv)
}

fn encode(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode(text: &str) -> Vec<u8> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    URL_SAFE_NO_PAD.decode(text).expect("base64url")
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// `/proc/net/udp` 에서 정확히 `127.0.0.1:<port>` 에 바인드된 UDP 소켓의 inode 를 찾는다.
///
/// 서버가 살아 있는 동안 그 (주소, 포트) 조합은 유일하다 — 다른 병렬 테스트의 QUIC
/// 엔드포인트가 같은 포트 번호를 배정받아도 다른 주소(`[::]`)의 소켓이므로 이 inode 는
/// 우리 서버 소켓의 것이다. inode 는 커널이 소켓마다 새로 발급하고 사실상 재사용하지
/// 않으므로, "우리 소켓이 닫혔는가"를 포트 상태와 무관하게 볼 수 있다.
#[cfg(target_os = "linux")]
fn server_udp_socket_inode(port: u16) -> Option<u64> {
    // /proc/net/udp 의 local_address 는 리틀엔디안 16진수다 (127.0.0.1 → 0100007F).
    const LOCALHOST_HEX: &str = "0100007F";
    let text = std::fs::read_to_string("/proc/net/udp").ok()?;
    text.lines().skip(1).find_map(|line| {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let (addr, port_hex) = cols.get(1)?.split_once(':')?;
        if addr != LOCALHOST_HEX || u16::from_str_radix(port_hex, 16).ok()? != port {
            return None;
        }
        // 컬럼: sl local rem st tx:rx tr:when retrnsmt uid timeout inode ...
        cols.get(9)?.parse().ok()
    })
}

/// 다른 Unix(macOS)에는 /proc 가 없어 소켓 inode 를 볼 수 없다 — 포트 폴백을 쓴다.
#[cfg(not(target_os = "linux"))]
fn server_udp_socket_inode(_port: u16) -> Option<u64> {
    None
}

/// stop 전에 서버 소켓을 식별해 둔다. Linux 에서 inode 를 못 찾으면 이 테스트는
/// 아무것도 검증하지 못하므로 조용히 넘어가지 않고 실패한다.
fn capture_server_socket(port: u16) -> Option<u64> {
    let inode = server_udp_socket_inode(port);
    #[cfg(target_os = "linux")]
    assert!(
        inode.is_some(),
        "127.0.0.1:{port} 소켓이 /proc/net/udp 에 없다 — 확인 전제가 깨졌다"
    );
    inode
}

/// 이 inode 를 쥔 fd 가 이 프로세스에 남아 있는가. 서버 런타임은 테스트와 같은
/// 프로세스의 스레드이므로 `/proc/self/fd` 가 정확한 범위다.
#[cfg(target_os = "linux")]
fn socket_inode_is_held(inode: u64) -> bool {
    let target = format!("socket:[{inode}]");
    let fds = std::fs::read_dir("/proc/self/fd").expect("/proc/self/fd");
    fds.flatten().any(|entry| {
        std::fs::read_link(entry.path())
            .map(|path| path.to_string_lossy() == target)
            .unwrap_or(false)
    })
}

/// `stop()`(또는 자연 종료) 뒤 서버 소켓이 실제로 닫혔는지 확인한다.
///
/// Linux: `capture_server_socket` 이 잡아 둔 inode 를 쥔 fd 가 사라졌는지 본다. 같은
/// 포트 번호를 다시 잡아 보는 방식은 다른 테스트의 QUIC 엔드포인트가 그 번호를
/// 선점하면 EADDRINUSE 로 실패한다 — inode 검사는 그 경합과 무관하게 결정적이다.
///
/// 다른 Unix: fd 수준 확인이 불가능해 포트 재바인드를 기한까지 재시도하는 폴백을 쓴다.
/// 선점자가 곧 닫히면 성공하지만 "그 번호가 지금 비었는가"의 근사라 inode 확인보다 약하다.
#[cfg(target_os = "linux")]
fn assert_server_socket_released(inode: Option<u64>, _port: u16) {
    let inode = inode.expect("capture_server_socket 이 먼저 필요하다");
    assert!(
        !socket_inode_is_held(inode),
        "stop 뒤에도 소켓 inode {inode} 를 쥔 fd 가 남아 있다"
    );
}

#[cfg(not(target_os = "linux"))]
fn assert_server_socket_released(_inode: Option<u64>, port: u16) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match std::net::UdpSocket::bind(("127.0.0.1", port)) {
            Ok(socket) => {
                drop(socket);
                return;
            }
            Err(error) => {
                assert!(Instant::now() < deadline, "포트가 해제되지 않았다: {error}");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

/// `screen` 요청 하나를 보내고 응답을 받는다. `id` 는 호출자가 단조 증가로 관리한다.
async fn screen_request(
    send: &mut SendStream,
    recv: &mut RecvStream,
    id: u64,
    tab: u64,
    since: Option<(u64, &str)>,
) -> Value {
    let mut request = json!({"v": 1, "id": id, "type": "screen", "tab": tab});
    if let Some((offset, session)) = since {
        request["since"] = Value::from(offset);
        request["session"] = Value::from(session);
    }
    send_json(send, &request).await;
    recv_json(recv).await
}

#[tokio::test]
async fn auth_then_state_screen_input_and_heartbeat() {
    let h = Harness::new(TOKEN, default_timeouts());
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;

    // heartbeat
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);

    // state — 기존 /api/state 와 같은 스냅샷이다.
    send_json(&mut send, &json!({"v": 1, "id": 3, "type": "state"})).await;
    let state = recv_json(&mut recv).await;
    assert_eq!(state["ok"], true);
    let expected = serde_json::to_value(h.dispatcher.lock().unwrap().snapshot()).unwrap();
    assert_eq!(state["state"], expected);

    // screen — 첫 요청은 reset 이고 프롬프트가 들어 있다.
    let screen = screen_request(&mut send, &mut recv, 4, h.tab, None).await;
    assert_eq!(screen["ok"], true, "screen: {screen}");
    assert_eq!(screen["reset"], true);
    assert_eq!(screen["cols"], 80);
    assert_eq!(screen["rows"], 24);
    let bytes = decode(screen["bytes"].as_str().unwrap());
    assert!(contains(&bytes, b"$ "), "no prompt in the screen");
    let token = screen["session"].as_str().unwrap().to_string();
    assert!(
        token.ends_with(&format!(":{}", h.session)),
        "session token {token}"
    );
    let mut offset = screen["endOffset"].as_u64().unwrap();

    // input — PTY 에 그대로 들어가고 화면 델타로 되돌아온다.
    let mut id = 5;
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": id, "type": "input", "tab": h.tab,
            "session": token, "data": encode(b"echo WT-OK\r"),
        }),
    )
    .await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        id += 1;
        let delta = screen_request(&mut send, &mut recv, id, h.tab, Some((offset, &token))).await;
        assert_eq!(delta["ok"], true, "screen delta: {delta}");
        assert_eq!(delta["reset"], false, "offset is inside the window");
        let bytes = decode(delta["bytes"].as_str().unwrap());
        if contains(&bytes, b"WT-OK") {
            break;
        }
        assert!(Instant::now() < deadline, "WT-OK did not appear");
        tokio::time::sleep(Duration::from_millis(50)).await;
        offset = delta["endOffset"].as_u64().unwrap();
    }
}

#[tokio::test]
async fn the_server_reports_connected_after_auth() {
    let h = Harness::new(TOKEN, default_timeouts());
    let (_session, _send, _recv) = authenticate(&h, TOKEN).await;
    let deadline = Instant::now() + Duration::from_secs(2);
    while h.server().state() != SecureRemoteState::Connected {
        assert!(Instant::now() < deadline, "state: {:?}", h.server().state());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_wrong_token_is_rejected_without_leaking_secrets() {
    let h = Harness::new(TOKEN, default_timeouts());
    let session = connect(&h).await;
    let (mut send, mut recv) = session.open_bi().await.expect("open_bi");
    send_json(
        &mut send,
        &json!({"v": 1, "id": 1, "type": "auth", "token": "not-the-token"}),
    )
    .await;
    let reply = recv_json(&mut recv).await;
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["status"], 401);
    assert_eq!(reply["message"], "unauthorized");
    let text = reply.to_string();
    assert!(!text.contains(TOKEN) && !text.contains("not-the-token"));
    expect_closed(&mut recv).await;

    let logs = h.logs();
    assert!(
        logs.iter()
            .any(|line| line.starts_with("secure-remote: auth failure from 127.0.0.1")),
        "logs: {logs:?}"
    );
    assert!(
        logs.iter()
            .all(|line| !line.contains(TOKEN) && !line.contains("not-the-token")),
        "a log line carries a credential: {logs:?}"
    );
}

#[tokio::test]
async fn state_before_auth_is_refused() {
    let h = Harness::new(TOKEN, default_timeouts());
    let session = connect(&h).await;
    let (mut send, mut recv) = session.open_bi().await.expect("open_bi");
    send_json(&mut send, &json!({"v": 1, "id": 1, "type": "state"})).await;
    let reply = recv_json(&mut recv).await;
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["status"], 401);
    assert!(reply.get("state").is_none(), "state was served before auth");
    expect_closed(&mut recv).await;
}

#[tokio::test]
async fn a_different_certificate_hash_fails_the_handshake() {
    let h = Harness::new(TOKEN, default_timeouts());
    let mut wrong = h.hash();
    wrong[0] ^= 0xff;
    let result = connect_with(&h, &wrong, ORIGIN, "/wt").await;
    assert!(result.is_err(), "wrong hash must not connect");
    assert_eq!(
        h.server().state(),
        SecureRemoteState::Waiting,
        "a failed handshake must not leave the waiting state"
    );
}

#[tokio::test]
async fn wrong_origin_or_path_is_refused() {
    let h = Harness::new(TOKEN, default_timeouts());
    let foreign = connect_with(&h, &h.hash(), "https://evil.example", "/wt").await;
    assert!(foreign.is_err(), "a foreign origin must be refused");
    let wrong_path = connect_with(&h, &h.hash(), ORIGIN, "/nope").await;
    assert!(wrong_path.is_err(), "a path other than /wt must be refused");
    // 상태 코드가 peer 에게 실제로 전달된다 — 거절은 마감 안에 끝나고, 그때까지 기다린
    // 응답은 버리지 않는다.
    let foreign = format!("{}", foreign.unwrap_err());
    assert!(foreign.contains("403"), "no status reply: {foreign}");
    let wrong_path = format!("{}", wrong_path.unwrap_err());
    assert!(wrong_path.contains("404"), "no status reply: {wrong_path}");
    assert_eq!(h.server().state(), SecureRemoteState::Waiting);
    assert_eq!(h.server().state(), SecureRemoteState::Waiting);
}

#[tokio::test]
async fn an_oversized_frame_closes_the_connection() {
    let h = Harness::new(TOKEN, default_timeouts());
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;

    // 길이 프리픽스만 1.5 MiB + 1 로 선언하고 본문은 보내지 않는다 — 서버는 바이트를
    // 읽기 전에 상한에서 끊어야 한다.
    let declared = (1_572_864u32 + 1).to_be_bytes();
    send.write_all(&declared).await.expect("write prefix");
    expect_closed(&mut recv).await;
    let logs = h.logs();
    assert!(
        logs.iter().any(|line| line.contains("frame length")),
        "logs: {logs:?}"
    );
}

#[tokio::test]
async fn a_bad_request_frame_is_an_error_and_then_close() {
    let h = Harness::new(TOKEN, default_timeouts());
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "exec"})).await;
    let reply = recv_json(&mut recv).await;
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["status"], 400);
    expect_closed(&mut recv).await;
}

/// 파싱에 실패한 프레임이라도 id 가 읽히면 그 id 로 400 을 돌려준다 — 클라이언트가
/// pending 응답과 대조해 "unexpected reply" 대신 서버가 준 상태를 화면에 띄운다.
#[tokio::test]
async fn an_unsupported_version_with_a_valid_id_is_reported_under_that_id() {
    let h = Harness::new(TOKEN, default_timeouts());
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;

    send_json(&mut send, &json!({"v": 2, "id": 7, "type": "state"})).await;
    let reply = recv_json(&mut recv).await;
    assert_eq!(reply["id"], 7, "the error lost the request id: {reply}");
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["status"], 400);
    expect_closed(&mut recv).await;
}

/// v1 이 모르는 필드도 id 가 읽히면 그 id 로 400 이 간다. peer 가 넣은 **값**은
/// 응답·로그 어디에도 실리지 않는다 (오류 문구에는 필드 분류만 온다).
#[tokio::test]
async fn an_unknown_field_with_a_valid_id_is_reported_under_that_id() {
    let h = Harness::new(TOKEN, default_timeouts());
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;

    send_json(
        &mut send,
        &json!({"v": 1, "id": 8, "type": "state", "probe": "leak-probe-value"}),
    )
    .await;
    let reply = recv_json(&mut recv).await;
    assert_eq!(reply["id"], 8, "the error lost the request id: {reply}");
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["status"], 400);
    assert!(
        !reply.to_string().contains("leak-probe-value"),
        "the reply reflects a peer value: {reply}"
    );
    expect_closed(&mut recv).await;

    let logs = h.logs();
    assert!(
        logs.iter().all(|line| !line.contains("leak-probe-value")),
        "a log line carries a peer value: {logs:?}"
    );
}

/// 첫 프레임이 버전 불일치여도 id 가 읽히면 그 id 로 400 이 간다 — 401 이 아니라
/// "버전이 맞지 않는다"를 폰이 화면에 띄울 수 있다. auth-first 계약은 그대로다:
/// auth 가 아닌 첫 프레임은 여전히 거절된다.
#[tokio::test]
async fn a_version_mismatch_on_the_first_frame_is_reported_under_its_id() {
    let h = Harness::new(TOKEN, default_timeouts());
    let session = connect(&h).await;
    let (mut send, mut recv) = session.open_bi().await.expect("open_bi");
    send_json(
        &mut send,
        &json!({"v": 9, "id": 42, "type": "auth", "token": TOKEN}),
    )
    .await;
    let reply = recv_json(&mut recv).await;
    assert_eq!(reply["id"], 42, "{reply}");
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["status"], 400);
    expect_closed(&mut recv).await;
    // 인증되지 않은 채 남지 않는다 — 대기 창은 계속 돈다.
    assert_eq!(h.server().state(), SecureRemoteState::Waiting);
}

/// 인증 전 단계(응답 헤더 → 첫 스트림 → 첫 auth 프레임)는 **하나의 총 마감**을 공유한다.
/// 단계마다 새 마감을 주면 최대 세 배가 열린 채 남는다.
///
/// 판별 구조: 두 후반 단계에 나눠 지연을 넣는다. 첫 스트림은 `auth` 안에 열고(1초),
/// 프레임은 그 뒤에 `auth` 를 넘겨 보낸다(총 2.5초 > 2초). 각 지연은 단독으로 `auth` 보다
/// 짧으므로, 단계별 마감이라면 stage 3 의 새 2초 안이라 프레임이 받아들여졌을 것이다.
#[tokio::test]
async fn the_auth_deadline_is_shared_across_the_pre_auth_stages() {
    let mut timeouts = default_timeouts();
    timeouts.auth = Duration::from_millis(2_000);
    let mut h = Harness::new(TOKEN, timeouts);
    let session = connect(&h).await;

    // ① 첫 스트림은 총 마감 안에 연다 — 여기서 1초를 쓴다.
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    let (mut send, mut recv) = session.open_bi().await.expect("open_bi");

    // ② 프레임은 1.5초를 더 쓴 뒤 보낸다. 총 경과 2.5초는 마감 2초를 넘지만, 마지막
    //    지연 하나만 보면 1.5초 < 2초라 단계별 마감이면 통과했을 것이다.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let frame =
        serde_json::to_vec(&json!({"v": 1, "id": 1, "type": "auth", "token": TOKEN})).unwrap();
    let mut bytes = Vec::with_capacity(4 + frame.len());
    bytes.extend_from_slice(&(frame.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&frame);
    // 서버가 이미 마감에서 닫았을 수 있다 — 쓰기 실패 자체는 판정과 모순되지 않는다.
    let _ = send.write_all(&bytes).await;

    // auth 왕복은 끝내 오지 않는다: 총 마감이 프레임 읽기를 끝냈다.
    let reply = try_recv_json(&mut recv, Duration::from_secs(1)).await;
    assert!(
        reply.is_err(),
        "the frame was accepted after the shared deadline: {reply:?}"
    );
    timeout(Duration::from_secs(3), session.closed())
        .await
        .expect("the timed-out session was not closed");
    assert!(
        h.logs()
            .iter()
            .any(|line| line.contains("auth frame timeout")),
        "the frame read did not hit the shared deadline: {:?}",
        h.logs()
    );
    // 미인증 연결은 `Connected` 로 가지 않는다 — 페어링 창은 계속 돈다.
    assert_eq!(h.server().state(), SecureRemoteState::Waiting);
    h.stop();
}

#[tokio::test]
async fn auth_failures_are_rate_limited_per_ip() {
    let h = Harness::new(TOKEN, default_timeouts());
    for attempt in 0..10 {
        let session = connect(&h).await;
        let (mut send, mut recv) = session.open_bi().await.expect("open_bi");
        send_json(
            &mut send,
            &json!({"v": 1, "id": 1, "type": "auth", "token": "wrong"}),
        )
        .await;
        let reply = recv_json(&mut recv).await;
        assert_eq!(reply["status"], 401, "attempt {attempt}: {reply}");
    }
    // 11번째는 429 이고, 그 뒤로는 새 연결 자체가 거절된다.
    let session = connect(&h).await;
    let (mut send, mut recv) = session.open_bi().await.expect("open_bi");
    send_json(
        &mut send,
        &json!({"v": 1, "id": 1, "type": "auth", "token": "wrong"}),
    )
    .await;
    let reply = recv_json(&mut recv).await;
    assert_eq!(reply["status"], 429, "{reply}");
    assert!(
        connect_with(&h, &h.hash(), ORIGIN, "/wt").await.is_err(),
        "a blocked ip must not open a new session"
    );
}

#[tokio::test]
async fn stop_releases_the_udp_socket() {
    let mut h = Harness::new(TOKEN, default_timeouts());
    let port = h.port();
    let socket = capture_server_socket(port);
    h.stop();
    // 원래 소켓의 inode 가 사라졌는지로 확인한다 — 같은 번호를 다시 잡아 보는 방식은
    // 다른 테스트가 그 사이 그 번호를 선점하면 실패하지만, inode 검사는 그 경합과
    // 무관하다. 재바인드 가능성의 폴백은 비 Linux 에서만 쓴다.
    assert_server_socket_released(socket, port);
}

#[tokio::test]
async fn re_pairing_uses_a_new_token_and_epoch() {
    let mut h = Harness::new(TOKEN, default_timeouts());
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    let first = screen_request(&mut send, &mut recv, 2, h.tab, None).await;
    let first_token = first["session"].as_str().unwrap().to_string();
    h.stop();

    h.restart(NEW_TOKEN, default_timeouts());

    // 옛 토큰은 401, 새 토큰은 통과.
    let session = connect(&h).await;
    let (mut send, mut recv) = session.open_bi().await.expect("open_bi");
    send_json(
        &mut send,
        &json!({"v": 1, "id": 1, "type": "auth", "token": TOKEN}),
    )
    .await;
    assert_eq!(recv_json(&mut recv).await["status"], 401);

    let (_session, mut send, mut recv) = authenticate(&h, NEW_TOKEN).await;
    let second = screen_request(&mut send, &mut recv, 2, h.tab, None).await;
    let second_token = second["session"].as_str().unwrap().to_string();
    assert_ne!(
        first_token, second_token,
        "a new pairing must use a new epoch"
    );
    assert!(second_token.ends_with(&format!(":{}", h.session)));
}

#[tokio::test]
async fn a_full_replay_with_64_dec_modes_fits_the_frame_limits() {
    let h = Harness::new(TOKEN, default_timeouts());
    // 셸에 64개 모드를 켜고 replay 상한(1 MiB)을 넘기는 출력을 흘린다.
    //
    // 완료 표식은 에코된 명령 줄에 나타나면 안 된다 — `echo READY-REPLAY` 를 쓰면
    // 셸이 되비춘 입력 줄이 출력보다 먼저 매칭돼 대기 루프가 일찍 빠져나간다
    // (진단: 5중 병렬에서 replay 가 55만~60만 바이트일 때 실패). `printf
    // 'READY-REPL%s\n' AY` 는 에코에는 `READY-REPL%s` 로, 출력에만 `READY-REPLAY`
    // 로 나타난다.
    let command = "for i in $(seq 100 163); do printf '\\033[?%dh' \"$i\"; done; \
                   head -c 1200000 /dev/zero | tr '\\0' A; printf 'READY-REPL%s\\n' AY\r";
    h.pty()
        .write(command.as_bytes())
        .expect("write setup command");

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let screen = h.pty().screen_since(None);
        if contains(&screen.bytes, b"READY-REPLAY") {
            break;
        }
        assert!(Instant::now() < deadline, "the replay never filled");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    let screen = screen_request(&mut send, &mut recv, 2, h.tab, None).await;
    assert_eq!(screen["ok"], true, "screen: {screen}");
    assert_eq!(screen["reset"], true);
    let bytes = decode(screen["bytes"].as_str().unwrap());
    // replay 1 MiB + 64개 모드 preamble(모드당 최대 9바이트).
    const MAX_SCREEN_BYTES: usize = 1_048_576 + 64 * 9;
    assert!(
        bytes.len() <= MAX_SCREEN_BYTES,
        "screen bytes {} exceed the contract",
        bytes.len()
    );
    assert!(
        bytes.len() > 1_000_000,
        "the replay did not fill: {}",
        bytes.len()
    );
    assert!(contains(&bytes, b"\x1b[?100h"), "missing mode preamble");
    assert!(contains(&bytes, b"\x1b[?163h"), "missing the last mode");
    assert!(contains(&bytes, b"READY-REPLAY"));
}

#[tokio::test]
async fn a_blocked_pty_write_does_not_hold_the_stop() {
    let mut h = Harness::new(TOKEN, default_timeouts());
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    let screen = screen_request(&mut send, &mut recv, 2, h.tab, None).await;
    let token = screen["session"].as_str().unwrap().to_string();

    // 셸을 raw 모드로 바꾸고 읽지 않는 프로세스로 교체한다. canonical 모드에서는
    // 커널이 초과 입력을 흘려보내 쓰기가 막히지 않으므로, TUI 가 실제로 쓰는 raw 모드가
    // "무기한 blocking write" 를 재현하는 조건이다 (개발기 실측).
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": 3, "type": "input", "tab": h.tab,
            "session": token, "data": encode(b"stty raw -echo; exec sleep 300\r"),
        }),
    )
    .await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
    tokio::time::sleep(Duration::from_millis(500)).await;

    // 64 KiB 입력은 raw 모드의 PTY 버퍼를 넘겨 writer 스레드를 막는다. 응답은
    // 기다리지 않고, 오지 않는 것으로 막힘을 확인한다.
    let blocked = vec![b'x'; 65_536];
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": 4, "type": "input", "tab": h.tab,
            "session": token, "data": encode(&blocked),
        }),
    )
    .await;
    assert!(
        try_recv_json(&mut recv, Duration::from_millis(700))
            .await
            .is_err(),
        "the pty write did not block"
    );

    // 막힌 쓰기가 있어도 네트워크 종료는 그 쓰기를 기다리지 않는다.
    let port = h.port();
    let socket = capture_server_socket(port);
    let start = Instant::now();
    h.stop();
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(3),
        "stop waited for the blocked write: {elapsed:?}"
    );

    // 소켓이 실제로 닫혔고(원래 inode 를 쥔 fd 가 사라짐), 연결도 닫혀 있다 —
    // 막힌 쓰기의 응답은 끝내 오지 않는다.
    assert_server_socket_released(socket, port);
    expect_closed(&mut recv).await;
}

/// 완료 조건 3의 네트워크 판: 막힌 첫 쓰기 → 서버 종료 → 재페어링 → 새 쓰기 거절
/// (busy) → 첫 쓰기 해제 → 다음 쓰기 허용.
///
/// 해제를 타이머가 아니라 **테스트가 만든 파일**로 한다: 셸이 그 파일을 보는 순간
/// stdin 을 읽기 시작하므로, "거절"을 관측하는 창이 느린 기계에서도 사라지지 않는다.
/// Harness 가 페어링 사이에 같은 coordinator 를 들고 있지 않으면 두 번째 페어링의
/// 입력이 받아들여져 이 테스트가 깨진다.
#[tokio::test]
async fn a_blocked_write_survives_the_pairing_and_keeps_the_next_input_busy() {
    let mut h = Harness::new(TOKEN, default_timeouts());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let release = format!("/tmp/mast-wt-release-{}-{nanos}", std::process::id());
    let _ = std::fs::remove_file(&release);

    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    let screen = screen_request(&mut send, &mut recv, 2, h.tab, None).await;
    let token = screen["session"].as_str().unwrap().to_string();

    // 셸을 raw 모드로 바꾸고 release 파일이 생길 때까지 stdin 을 읽지 않는다. 완료
    // 표식은 에코에 나타나지 않는 형태로 만든다 — 에코를 보고 raw 진입을 일찍
    // 판정하면 64 KiB 를 canonical 모드로 보내게 되고, 그러면 커널이 초과분을
    // 흘려보내 쓰기가 막히지 않는다.
    let command = format!(
        "stty raw -echo; printf 'READY-BLO%s\\r' CK; \
         while [ ! -e {release} ]; do sleep 0.1; done; exec cat >/dev/null\r"
    );
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": 3, "type": "input", "tab": h.tab,
            "session": token, "data": encode(command.as_bytes()),
        }),
    )
    .await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);

    let deadline = Instant::now() + Duration::from_secs(5);
    while !contains(&h.pty().screen_since(None).bytes, b"READY-BLOCK") {
        assert!(
            Instant::now() < deadline,
            "the shell never entered raw mode"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // 64 KiB 는 raw 모드의 PTY 입력 버퍼를 넘겨 writer 스레드를 막는다.
    let blocked = vec![b'x'; 65_536];
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": 4, "type": "input", "tab": h.tab,
            "session": token, "data": encode(&blocked),
        }),
    )
    .await;
    assert!(
        try_recv_json(&mut recv, Duration::from_millis(700))
            .await
            .is_err(),
        "the pty write did not block"
    );

    // 첫 페어링을 내린다 — 막힌 쓰기는 계속되고 슬롯을 쥐고 있다.
    h.stop();
    h.restart(NEW_TOKEN, default_timeouts());
    let (_session, mut send, mut recv) = authenticate(&h, NEW_TOKEN).await;
    let screen = screen_request(&mut send, &mut recv, 2, h.tab, None).await;
    let token = screen["session"].as_str().unwrap().to_string();

    // 이전 페어링의 막힌 쓰기가 슬롯을 쥐고 있으므로 새 입력은 명시적인 busy 다.
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": 3, "type": "input", "tab": h.tab,
            "session": token, "data": encode(b"echo BUSY-PROBE\r"),
        }),
    )
    .await;
    let reply = recv_json(&mut recv).await;
    assert_eq!(reply["ok"], false, "the input was not refused: {reply}");
    assert_eq!(reply["status"], 503, "{reply}");
    assert_eq!(reply["message"], "input busy", "{reply}");

    // 첫 쓰기를 푼다 — 셸이 stdin 을 읽기 시작하면 64 KiB 가 빠져나가고 슬롯이 빈다.
    std::fs::write(&release, b"").expect("create the release file");

    // 다음 입력은 기한 안에 받아들여진다. busy 인 동안에는 매 시도가 즉시 거절된다.
    let mut id = 4;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        id += 1;
        send_json(
            &mut send,
            &json!({
                "v": 1, "id": id, "type": "input", "tab": h.tab,
                "session": token, "data": encode(b"echo NEXT\r"),
            }),
        )
        .await;
        let reply = recv_json(&mut recv).await;
        if reply["ok"] == true {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the next input was never accepted: {reply}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = std::fs::remove_file(&release);
    h.stop();
}

#[tokio::test]
async fn the_idle_timeout_keeps_the_pairing_for_reconnection() {
    let mut timeouts = default_timeouts();
    timeouts.idle = Duration::from_millis(300);
    let h = Harness::new(TOKEN, timeouts);
    let (_session, _send, mut recv) = authenticate(&h, TOKEN).await;
    // 요청도 heartbeat 도 보내지 않는다.
    expect_closed(&mut recv).await;

    let deadline = Instant::now() + Duration::from_secs(3);
    while h.server().state() != SecureRemoteState::Remembered {
        assert!(
            Instant::now() < deadline,
            "server did not finish: {:?}",
            h.server().state()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(h.server().state(), SecureRemoteState::Remembered);
    assert!(
        !h.server().cancel(),
        "닫힌 다이얼로그가 기억한 페어링을 취소하면 안 된다"
    );
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    send_json(&mut send, &json!({"v":1,"id":2,"type":"state"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
}

#[tokio::test]
async fn the_pairing_window_expiry_stops_the_server() {
    let mut timeouts = default_timeouts();
    timeouts.wait = Duration::from_millis(300);
    let h = Harness::new(TOKEN, timeouts);
    let deadline = Instant::now() + Duration::from_secs(3);
    while !h.server().is_finished() {
        assert!(
            Instant::now() < deadline,
            "server did not finish: {:?}",
            h.server().state()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(h.server().state(), SecureRemoteState::Idle);
    assert!(
        h.logs()
            .iter()
            .any(|line| line.contains("pairing window expired")),
        "logs: {:?}",
        h.logs()
    );
}

#[tokio::test]
async fn cancel_closes_a_waiting_server_but_not_a_connected_one() {
    let mut h = Harness::new(TOKEN, default_timeouts());
    assert!(h.server().cancel(), "a waiting server closes on cancel");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !h.server().is_finished() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    h.stop();

    h.restart(TOKEN, default_timeouts());
    let (_session, _send, _recv) = authenticate(&h, TOKEN).await;
    // 승패는 cancel() 반환값이 즉시 알려 준다 — 인증 승인과 같은 게이트에서 원자 판정.
    assert!(
        !h.server().cancel(),
        "a connected server is left to the session lifetime"
    );
    // `Connected` 전이는 런타임 task 가 Authenticated 이벤트를 처리한 뒤라 관측에 창이
    // 있다 (진단 실측: 무부하 p50 1.25µs, 부하 시 최대 8ms). 제품 전이 순서를 바꾸지
    // 않고 기한을 두고 기다린다.
    let deadline = Instant::now() + Duration::from_secs(2);
    while h.server().state() != SecureRemoteState::Connected {
        assert!(Instant::now() < deadline, "state: {:?}", h.server().state());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    h.stop();
}

#[tokio::test]
async fn a_client_disconnect_during_a_blocked_write_keeps_the_pairing() {
    let mut h = Harness::new(TOKEN, default_timeouts());
    let (session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    let screen = screen_request(&mut send, &mut recv, 2, h.tab, None).await;
    let token = screen["session"].as_str().unwrap().to_string();

    // raw 모드 + stdin 을 읽지 않는 프로세스 — writer 를 확실히 막는다.
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": 3, "type": "input", "tab": h.tab,
            "session": token, "data": encode(b"stty raw -echo; exec sleep 300\r"),
        }),
    )
    .await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
    tokio::time::sleep(Duration::from_millis(500)).await;

    let blocked = vec![b'x'; 65_536];
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": 4, "type": "input", "tab": h.tab,
            "session": token, "data": encode(&blocked),
        }),
    )
    .await;
    assert!(
        try_recv_json(&mut recv, Duration::from_millis(700))
            .await
            .is_err(),
        "the pty write did not block"
    );

    // 쓰기는 여전히 막혀 있다. 이때 클라이언트가 끊기면 서버는 `done_rx` 가 아니라
    // 연결 종료를 보고 빠져나와야 한다 — 그러지 않으면 인증 후에는 대기 타이머도 없어
    // 포트가 영원히 남는다.
    let port = h.port();
    let socket = capture_server_socket(port);
    drop(send);
    drop(recv);
    drop(session);

    let deadline = Instant::now() + Duration::from_secs(5);
    while h.server().state() != SecureRemoteState::Remembered {
        assert!(
            Instant::now() < deadline,
            "server did not finish after the client vanished: {:?}",
            h.server().state()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(h.server().state(), SecureRemoteState::Remembered);
    assert!(
        h.logs()
            .iter()
            .any(|line| line.contains("client disconnected during an input write")),
        "the disconnect path was not taken: {:?}",
        h.logs()
    );
    h.stop();
    assert_server_socket_released(socket, port);
}

/// 취소가 **먼저** 승인된 순서를 고정한다. 연결과 첫 스트림은 이미 열어 둔 채 취소하고,
/// 그 뒤에 auth 프레임을 보낸다. 승자는 취소 하나다 — 인증이 먼저 승인됐다면 서버는
/// Connected 로 남아 스스로 끝나지 않는다.
///
/// `tokio::join!` 경합을 쓰지 않는 이유: `cancel()` 이 첫 poll 에서 동기로 끝나므로
/// 항상 취소가 먼저 도착했고, 인증 승리 분기는 실행되지 않았으며, 응답이 `Err` 면
/// 아무 단언도 없이 통과했다. 순서를 실제로 만들어 두면 게이트의 판정을 검증한다.
#[tokio::test]
async fn a_cancel_approved_before_the_auth_refuses_it() {
    let mut h = Harness::new(TOKEN, default_timeouts());
    let session = connect(&h).await;
    let (mut send, mut recv) = session.open_bi().await.expect("open_bi");

    assert!(h.server().cancel(), "the first cancel is approved");

    // 취소 뒤에 도착하는 auth. 503 이 도착하면 그대로 확인하고, QUIC 종료가 먼저
    // 도착하면 스트림/세션이 끝난다 — 어느 쪽이든 인증은 승인되지 않는다.
    let frame =
        serde_json::to_vec(&json!({"v": 1, "id": 1, "type": "auth", "token": TOKEN})).unwrap();
    let mut bytes = Vec::with_capacity(4 + frame.len());
    bytes.extend_from_slice(&(frame.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&frame);
    // 연결이 이미 닫혔을 수 있다 — 쓰기 실패 자체는 위 판정과 모순되지 않는다.
    let _ = send.write_all(&bytes).await;

    let reply = try_recv_json(&mut recv, Duration::from_secs(3)).await;
    let logs = h.logs();
    match &reply {
        Ok(value) => {
            // 인증 요청이 게이트에 닿은 경우 — 취소가 먼저 승인됐으므로 503 이다.
            assert_eq!(
                value["ok"], false,
                "cancel-first let the auth through: {value}"
            );
            assert_eq!(value["status"], 503, "{value}");
            assert!(
                logs.iter()
                    .any(|line| line.contains("auth refused after cancel")),
                "the refusal path was not taken: {logs:?}"
            );
        }
        Err(()) => {
            // auth 프레임을 읽기 전에 QUIC 연결이 닫힌 경우다 (실측: 두 관측이 모두
            // 나온다). 이때도 인증은 승인되지 않았고 — 성공 페어링 로그가 없다 —
            // 세션은 끝나 있어야 한다.
            assert!(
                logs.iter().all(|line| !line.contains("paired with")),
                "an unpaired connection logged a successful pairing: {logs:?}"
            );
            timeout(Duration::from_secs(3), session.closed())
                .await
                .expect("the refused session must be closed");
        }
    }

    // 승자는 취소다: 인증이 먼저 승인됐다면 서버는 세션이 끝날 때까지 Connected 로
    // 남아 스스로 끝나지 않는다. 서버가 끝났다는 사실 자체가 그 창이 없었다는 뜻이다.
    let deadline = Instant::now() + Duration::from_secs(3);
    while !h.server().is_finished() {
        assert!(
            Instant::now() < deadline,
            "the cancelled server did not finish: {:?}",
            h.server().state()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(h.server().state(), SecureRemoteState::Idle);
    h.stop();
}

/// 인증이 **먼저** 승인된 순서를 고정한다. auth 왕복을 끝낸 뒤의 취소는 게이트가
/// 거절(`false`)하고, 세션은 그대로 쓸 수 있다.
#[tokio::test]
async fn an_auth_approved_before_the_cancel_keeps_the_session() {
    let mut h = Harness::new(TOKEN, default_timeouts());
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;

    assert!(
        !h.server().cancel(),
        "an authenticated session must not be cancelled"
    );
    // `Connected` 전이는 Authenticated 이벤트 처리 뒤라 관측에 창이 있다 — 전이를
    // 기다린다 (제품 순서를 바꾸지 않는다).
    let deadline = Instant::now() + Duration::from_secs(2);
    while h.server().state() != SecureRemoteState::Connected {
        assert!(
            Instant::now() < deadline,
            "state never became connected: {:?}",
            h.server().state()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // 인증이 이긴 세션은 계속 쓸 수 있어야 한다 — 취소가 이겼다면 여기서 실패한다.
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
    h.stop();
}

/// 첫 프레임 읽기 오류(`Ok(Err)`)는 세션을 닫고 나가야 한다. 닫지 않으면
/// `Session::new` 의 수신 task 가 Connection clone 을 계속 쥐어 미인증 연결이 QUIC
/// idle(30초)까지 살아 남고, 슬롯 회계와 무관하게 쌓일 수 있다.
#[tokio::test]
async fn a_bad_first_frame_closes_the_session_and_frees_the_slot() {
    let h = Harness::new(TOKEN, default_timeouts());
    for round in 0..5 {
        let session = connect(&h).await;
        let (mut send, _recv) = session.open_bi().await.expect("open_bi");
        // 길이 0 프리픽스 — `read_len` 이 본문을 읽기 전에 `BadLength` 로 끝난다.
        send.write_all(&0u32.to_be_bytes())
            .await
            .expect("write prefix");
        timeout(Duration::from_secs(3), session.closed())
            .await
            .unwrap_or_else(|_| panic!("round {round}: the bad session was not closed"));
    }
    // 실패한 연결들이 슬롯을 쥐고 있지 않으므로 진짜 인증이 들어간다.
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
    assert!(
        h.logs()
            .iter()
            .any(|line| line.contains("first frame failure")),
        "logs: {:?}",
        h.logs()
    );
}

/// 한 IP 가 미인증 슬롯을 모두 쥐지 못한다 — 3번째 연결은 거절되고, 다른 IP 의 진짜
/// 페어링은 그 사이에도 들어간다 (같은 IP 를 나눠 쓰는 기기는 이 상한의 대가다).
#[tokio::test]
async fn one_abusive_ip_cannot_take_every_unauthenticated_slot() {
    let h = Harness::new(TOKEN, default_timeouts());
    // 미인증으로만 남는 연결 — 셸 대신 CONNECT 만 끝내고 첫 프레임을 보내지 않는다.
    let first = connect_as(&h, "127.0.0.2:0", "/wt")
        .await
        .expect("first stalled connection");
    let second = connect_as(&h, "127.0.0.2:0", "/wt")
        .await
        .expect("second stalled connection");
    let third = connect_as(&h, "127.0.0.2:0", "/wt").await;
    assert!(third.is_err(), "one ip occupied every unauthenticated slot");
    // 진짜 폰(다른 IP)은 공격 중에도 페어링할 수 있다.
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);

    drop((first, second));
}

/// 프로토콜 위반도 IP 단위 실패로 남는다 — 슬롯을 굶기는 것만으로 반복할 수 없고,
/// 11번째 실패가 그 IP 를 차단한다. 다른 IP 의 페어링은 계속된다.
#[tokio::test]
async fn repeated_unauthenticated_failures_are_throttled_per_ip() {
    let h = Harness::new(TOKEN, default_timeouts());
    let mut blocked_at = None;
    for attempt in 1..=11 {
        let session = connect_as(&h, "127.0.0.2:0", "/wt")
            .await
            .unwrap_or_else(|e| panic!("attempt {attempt}: connect failed: {e}"));
        let (mut send, mut recv) = session.open_bi().await.expect("open_bi");
        send_json(&mut send, &json!({"v": 1, "id": 1, "type": "state"})).await;
        let reply = recv_json(&mut recv).await;
        assert_eq!(reply["ok"], false, "attempt {attempt}: {reply}");
        if reply["status"] == 429 {
            blocked_at = Some(attempt);
            break;
        }
        assert_eq!(reply["status"], 401, "attempt {attempt}: {reply}");
    }
    assert_eq!(
        blocked_at,
        Some(11),
        "the eleventh failure must trip the block"
    );
    assert!(
        connect_as(&h, "127.0.0.2:0", "/wt").await.is_err(),
        "the abusive ip was not throttled"
    );
    // 다른 IP 의 진짜 페어링은 계속 들어간다.
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
}

/// 인증 단계의 **타임아웃**도 IP 단위 실패로 집계된다 — 스트림을 열지 않고 슬롯만
/// 굶기는 느린 연결로는 차단 전에 무한히 반복할 수 없다.
///
/// 판별 구조: 같은 IP(127.0.0.2)에서 토큰 오류 9회를 먼저 만들고, 그다음 스트림을 열지
/// 않은 채 첫 스트림 마감을 지나 **10번째** 실패를 만든다. 타임아웃이 집계되면 이어지는
/// 토큰 오류가 11번째 실패가 되어 429 이고(차단), 집계되지 않으면 10번째 실패라 401 이다.
/// 먼저 타임아웃 로그 줄을 확인해 그 판정이 실제로 지나간 경로임을 고정한다.
#[tokio::test]
async fn a_pre_auth_timeout_counts_toward_the_ip_block() {
    let mut timeouts = default_timeouts();
    timeouts.auth = Duration::from_millis(1_000);
    let h = Harness::new(TOKEN, timeouts);
    let abusive = "127.0.0.2:0";

    // 9번째 실패까지는 토큰 오류로 빠르게 만든다.
    for attempt in 1..=9 {
        let session = connect_as(&h, abusive, "/wt")
            .await
            .unwrap_or_else(|e| panic!("attempt {attempt}: connect failed: {e}"));
        let (mut send, mut recv) = session.open_bi().await.expect("open_bi");
        send_json(
            &mut send,
            &json!({"v": 1, "id": 1, "type": "auth", "token": "wrong"}),
        )
        .await;
        let reply = recv_json(&mut recv).await;
        assert_eq!(reply["status"], 401, "attempt {attempt}: {reply}");
    }

    // 10번째 실패는 프로토콜 오류가 아니라 첫 스트림 **마감**이다 — 스트림을 열지
    // 않으면 서버의 총 마감이 그 단계에서 끝난다.
    let stalled = connect_as(&h, abusive, "/wt")
        .await
        .expect("the tenth connection");
    timeout(Duration::from_secs(5), stalled.closed())
        .await
        .expect("the stalled connection was not closed at the auth deadline");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !h
        .logs()
        .iter()
        .any(|line| line.contains("auth stream timeout from 127.0.0.2"))
    {
        assert!(
            Instant::now() < deadline,
            "the timeout was not recorded: {:?}",
            h.logs()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // 11번째 실패 — 타임아웃이 집계됐다면 여기서 차단이 걸린다. 401 이면 집계 누락이다.
    let session = connect_as(&h, abusive, "/wt")
        .await
        .expect("the eleventh connection");
    let (mut send, mut recv) = session.open_bi().await.expect("open_bi");
    send_json(
        &mut send,
        &json!({"v": 1, "id": 1, "type": "auth", "token": "wrong"}),
    )
    .await;
    let reply = recv_json(&mut recv).await;
    assert_eq!(
        reply["status"], 429,
        "the timeout did not count toward the block: {reply}"
    );

    // 차단은 CONNECT 단계까지 이어지고, 다른 IP 의 진짜 페어링은 그대로 들어간다.
    assert!(
        connect_as(&h, abusive, "/wt").await.is_err(),
        "the abusive ip was not throttled"
    );
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
}

/// 잘못된 Origin 도 IP 단위 실패로 집계된다 — 슬롯을 굶기지 않고 CONNECT 만 반복해도
/// 11번째에서 차단되고, 그때의 거절은 429 로 바뀐다. 차단된 뒤의 재시도는 처리되지만
/// (429) 집계도 새 로그 줄도 늘리지 않는다. 다른 IP 의 진짜 페어링은 계속 들어간다.
///
/// rate 검사가 path·Origin 검사보다 앞이라는 순서가 이 테스트의 계약이다 — 순서가
/// 뒤집히면 차단된 IP 의 재시도가 매번 `record_failure` 를 불러 로그가 다시 쌓인다.
#[tokio::test]
async fn malformed_origin_attempts_count_toward_the_rate_block() {
    let h = Harness::new(TOKEN, default_timeouts());
    let abusive = "127.0.0.2:0";
    let evil = "https://evil.example";

    for attempt in 1..=10 {
        let error = format!(
            "{}",
            connect_as_with(&h, abusive, evil, "/wt")
                .await
                .expect_err("a foreign origin must be refused")
        );
        assert!(error.contains("403"), "attempt {attempt}: {error}");
    }
    // 11번째 실패가 차단을 건다 — 이때부터 거절 상태가 429 로 바뀐다.
    let error = format!(
        "{}",
        connect_as_with(&h, abusive, evil, "/wt")
            .await
            .expect_err("the eleventh failure must be refused")
    );
    assert!(error.contains("429"), "{error}");

    let origin_lines = |lines: &[String]| {
        lines
            .iter()
            .filter(|line| line.starts_with("secure-remote: refused origin from 127.0.0.2"))
            .count()
    };
    assert_eq!(origin_lines(&h.logs()), 11, "logs: {:?}", h.logs());

    // 차단 중 재시도는 QUIC 단계에서 거절하고 로그를 추가하지 않는다.
    for _ in 0..3 {
        let error = format!(
            "{}",
            connect_as_with(&h, abusive, evil, "/wt")
                .await
                .expect_err("a blocked ip must not connect")
        );
        assert!(error.contains("refused to accept"), "{error}");
    }
    assert_eq!(
        origin_lines(&h.logs()),
        11,
        "blocked retries added log lines: {:?}",
        h.logs()
    );

    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
}

/// 차단된 IP 의 재시도는 거절 task 상한(4)이 밀린 상태에서도 **어떤 로그 줄도** 늘리지
/// 않는다.
///
/// 상한 초과 경로는 응답 없이 그 자리에서 연결만 닫는데, 예전에는 그때마다
/// `closed <ip> without a rejection reply (tasks busy)` 한 줄을 남겨 차단된 IP 의 재시도
/// 폭주가 상한 가지에서 로그 flood 를 되살릴 수 있었다 (리뷰 지적). 여기서는 차단된
/// IP 에서 병렬 재시도를 쏟아 상한에 압력을 준 뒤 로그 **전체 길이**가 그대로임을
/// 확인한다 — 특정 문구가 아니라 새 줄 자체를 금지한다.
///
/// 한계: 응답 credit 을 주지 않는 peer 를 quinn 공개 API 로 만들 수 없어(server.rs 의
/// `reject_with_grace` 주석에 실측 근거) 상한 포화를 결정적으로 만들 수는 없다. 상한·
/// 즉시 종료·task 비대기 계약은 pending future 를 쓰는 단위 테스트가 고정한다.
#[tokio::test]
async fn blocked_ip_retries_do_not_add_log_lines_under_rejection_pressure() {
    let mut h = Harness::new(TOKEN, default_timeouts());
    let abusive = "127.0.0.2:0";

    // 10번의 404 뒤 11번째 실패가 차단을 건다 (그 실패의 응답이 429 로 바뀐다). 그
    // 뒤로는 rate 검사가 path 검사보다 앞이라 이 IP 의 모든 시도가 `record_failure`
    // 없이 여기서 429 다 — 유효한 path 로 와도 그렇다.
    for attempt in 1..=10 {
        let error = format!(
            "{}",
            connect_as(&h, abusive, "/nope")
                .await
                .expect_err("a path other than /wt must be refused")
        );
        assert!(error.contains("404"), "attempt {attempt}: {error}");
    }
    let error = format!(
        "{}",
        connect_as(&h, abusive, "/nope")
            .await
            .expect_err("the eleventh failure must be refused")
    );
    assert!(error.contains("429"), "{error}");
    let error = format!(
        "{}",
        connect_as(&h, abusive, "/wt")
            .await
            .expect_err("a blocked ip must not connect")
    );
    assert!(error.contains("refused to accept"), "{error}");

    let before = h.logs();
    // 상한(4)보다 훨씬 많은 병렬 재시도 — 거절 task 가 밀리는 순간이 있으면 상한 초과
    // 경로가 실제로 지나간다.
    let mut burst = Vec::new();
    for _ in 0..24 {
        burst.push(tokio::spawn(connect_as_owned(
            abusive,
            h.port(),
            h.hash(),
            ORIGIN,
            "/wt",
        )));
    }
    for (index, task) in burst.into_iter().enumerate() {
        let result = task.await.expect("the retry task did not panic");
        assert!(result.is_err(), "retry {index} unexpectedly connected");
    }

    let after = h.logs();
    assert_eq!(
        after.len(),
        before.len(),
        "blocked retries added log lines: {:?}",
        &after[before.len()..]
    );

    // 다른 IP 의 진짜 페어링은 폭주 중에도 들어간다 — 로그를 줄이려고 거절 자체가
    // 서버를 굶기게 두지 않았다.
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
    h.stop();
}

/// 잘못된 path 도 같은 집계를 쓴다 — 10번은 404, 11번째가 429(차단), 그 뒤에는
/// 유효한 path 로 와도 그 IP 는 CONNECT 단계에서 429 다.
#[tokio::test]
async fn malformed_path_attempts_count_toward_the_rate_block() {
    let h = Harness::new(TOKEN, default_timeouts());
    let abusive = "127.0.0.2:0";

    for attempt in 1..=10 {
        let error = format!(
            "{}",
            connect_as(&h, abusive, "/nope")
                .await
                .expect_err("a path other than /wt must be refused")
        );
        assert!(error.contains("404"), "attempt {attempt}: {error}");
    }
    let error = format!(
        "{}",
        connect_as(&h, abusive, "/nope")
            .await
            .expect_err("the eleventh failure must be refused")
    );
    assert!(error.contains("429"), "{error}");
    let error = format!(
        "{}",
        connect_as(&h, abusive, "/wt")
            .await
            .expect_err("a blocked ip must not connect")
    );
    assert!(error.contains("refused to accept"), "{error}");
}

/// 거절이 밀려도 진짜 폰의 CONNECT/auth 는 그 사이에 들어간다 — 거절 응답은 accept
/// 루프 밖 task 가 보내므로 루프는 거절 하나에 묶이지 않는다.
///
/// 응답 헤더 credit 을 주지 않는 peer 가 REJECT_GRACE 를 쓰는 상황 자체는 quinn 공개
/// API 로 만들 수 없다(server.rs 의 `reject_with_grace` 주석에 실측 근거가 있다).
/// 그래서 여기서는 실서버에서 거절 폭주와 정상 페어링을 동시에 진행시켜, 굶김·교착·
/// 슬롯 회계 오류가 생기면 드러나게 한다 — 지연 거절의 비차단성은 server.rs 의
/// `spawn_bounded_rejection` 단위 테스트가 고정한다.
#[tokio::test]
async fn a_rejection_burst_does_not_delay_a_valid_pairing() {
    let mut h = Harness::new(TOKEN, default_timeouts());
    let mut rejections = Vec::new();
    for _ in 0..8 {
        rejections.push(tokio::spawn(connect_owned(
            h.port(),
            h.hash(),
            "https://evil.example",
            "/wt",
        )));
    }

    // 여기서 보이는 것은 "거절 여덟 건을 순차로 기다리지 않았다"이지 엄밀한 지연 측정이
    // 아니다. 거절 하나가 REJECT_GRACE(2초)를 다 쓰는 순차 처리라면 16초가 걸리므로
    // 5초만으로도 구분되고, 부하 걸린 Windows/Linux CI 에서 2초는 흔들린다 (리뷰 지적).
    // 엄밀한 비차단성은 pending future 를 쓰는 `spawn_bounded_rejection` 단위 테스트가
    // 고정한다.
    let start = Instant::now();
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "the pairing was delayed behind rejections: {:?}",
        start.elapsed()
    );
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);

    for (index, task) in rejections.into_iter().enumerate() {
        let result = task.await.expect("the rejection task did not panic");
        assert!(result.is_err(), "rejection {index} unexpectedly connected");
    }
    h.stop();
}

/// 브라우저가 붙어 있는 채로 PTY 쓰기만 막혀도 세션이 응답 불능으로 고정되지 않는다.
/// `frame_io` 가 지나면 명시적 503 이 오고 요청 루프는 계속 돈다 — 이미 시작한 쓰기는
/// 취소하지 않고 슬롯은 busy 로 남아, 뒤이은 입력이 그 자리에서 503 `input busy` 로
/// 거절된다(수용됐다면 같은 막힘을 다시 만나 다시 `input write timed out` 이 됐을 것이다).
#[tokio::test]
async fn a_blocked_input_write_does_not_pin_the_session() {
    let mut timeouts = default_timeouts();
    timeouts.frame_io = Duration::from_millis(300);
    let mut h = Harness::new(TOKEN, timeouts);
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    let screen = screen_request(&mut send, &mut recv, 2, h.tab, None).await;
    let token = screen["session"].as_str().unwrap().to_string();

    // raw 모드 + stdin 을 읽지 않는 프로세스 — canonical 모드는 초과 입력을 흘려보낸다.
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": 3, "type": "input", "tab": h.tab,
            "session": token, "data": encode(b"stty raw -echo; exec sleep 300\r"),
        }),
    )
    .await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
    tokio::time::sleep(Duration::from_millis(500)).await;

    let blocked = vec![b'x'; 65_536];
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": 4, "type": "input", "tab": h.tab,
            "session": token, "data": encode(&blocked),
        }),
    )
    .await;
    let reply = recv_json_with(&mut recv, Duration::from_secs(3)).await;
    assert_eq!(
        reply["ok"], false,
        "the blocked write reported success: {reply}"
    );
    assert_eq!(reply["status"], 503, "{reply}");
    assert_eq!(reply["message"], "input write timed out", "{reply}");

    // 세션은 계속 응답한다 — 요청 루프가 막힌 쓰기에 묶여 있지 않다.
    send_json(&mut send, &json!({"v": 1, "id": 5, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);

    // 막힌 첫 쓰기가 아직 슬롯을 쥐고 있으므로 두 번째 입력은 큐에 들어가지 않고 그
    // 자리에서 거절된다. 받아들여졌다면 같은 막힘을 다시 만나 503
    // `input write timed out` 이 됐을 것이므로, `input busy` 가 곧 "두 번째 쓰기가
    // PTY 에 시작되지 않았다"는 관측이다 (거절된 잡은 실행되지 않는다 — writer.rs 계약).
    send_json(
        &mut send,
        &json!({
            "v": 1, "id": 6, "type": "input", "tab": h.tab,
            "session": token, "data": encode(b"echo BUSY-PROBE\r"),
        }),
    )
    .await;
    let reply = recv_json_with(&mut recv, Duration::from_secs(3)).await;
    assert_eq!(
        reply["ok"], false,
        "the second input was accepted while the slot was busy: {reply}"
    );
    assert_eq!(reply["status"], 503, "{reply}");
    assert_eq!(reply["message"], "input busy", "{reply}");

    // 거절 뒤에도 세션은 계속 응답한다.
    send_json(&mut send, &json!({"v": 1, "id": 7, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
    h.stop();
}

/// HTTP/3 SETTINGS조차 보내지 않는 연결도 IP별 상한에 포함되고 총 인증 마감에 닫힌다.
#[tokio::test]
async fn stalled_quic_connections_are_bounded_before_http3_and_expire() {
    let mut timeouts = default_timeouts();
    timeouts.auth = Duration::from_millis(700);
    let h = Harness::new(TOKEN, timeouts);
    let (endpoint, config) = client_parts("127.0.0.2:0", &h.hash());
    let address = format!("127.0.0.1:{}", h.port()).parse().unwrap();
    let started = Instant::now();
    let first = endpoint
        .connect_with(config.clone(), address, "localhost")
        .unwrap()
        .await
        .unwrap();
    let second = endpoint
        .connect_with(config.clone(), address, "localhost")
        .unwrap()
        .await
        .unwrap();
    let third = endpoint
        .connect_with(config.clone(), address, "localhost")
        .unwrap()
        .await;
    assert!(third.is_err(), "HTTP/3 이전 연결이 IP별 상한을 우회했다");
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
    timeout(Duration::from_secs(2), first.closed())
        .await
        .expect("첫 핸드셰이크 마감");
    timeout(Duration::from_secs(2), second.closed())
        .await
        .expect("두 번째 핸드셰이크 마감");
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(h
        .logs()
        .iter()
        .any(|line| line.contains("handshake failure or timeout")));
}

/// 서로 다른 IP에서도 CONNECT 이전 연결의 총수가 4개를 넘지 않고 만료 후 슬롯을 회수한다.
#[tokio::test]
async fn stalled_quic_connections_share_the_global_limit_and_release_slots() {
    let mut timeouts = default_timeouts();
    timeouts.auth = Duration::from_millis(700);
    let h = Harness::new(TOKEN, timeouts);
    let address = format!("127.0.0.1:{}", h.port()).parse().unwrap();
    let mut endpoints = Vec::new();
    let mut connections = Vec::new();
    for local in ["127.0.0.2:0", "127.0.0.3:0"] {
        let (endpoint, config) = client_parts(local, &h.hash());
        for _ in 0..2 {
            connections.push(
                endpoint
                    .connect_with(config.clone(), address, "localhost")
                    .unwrap()
                    .await
                    .unwrap(),
            );
        }
        endpoints.push(endpoint);
    }
    let (endpoint, config) = client_parts("127.0.0.4:0", &h.hash());
    assert!(endpoint
        .connect_with(config, address, "localhost")
        .unwrap()
        .await
        .is_err());
    for conn in &connections {
        timeout(Duration::from_secs(2), conn.closed())
            .await
            .expect("핸드셰이크 슬롯 만료");
    }
    let (_session, mut send, mut recv) = authenticate(&h, TOKEN).await;
    send_json(&mut send, &json!({"v": 1, "id": 2, "type": "heartbeat"})).await;
    assert_eq!(recv_json(&mut recv).await["ok"], true);
}

#[tokio::test]
async fn remembered_pairing_has_a_fixed_expiry_even_while_connected() {
    let mut timeouts = default_timeouts();
    timeouts.lifetime = Duration::from_secs(1);
    let h = Harness::new(TOKEN, timeouts);
    let session = connect(&h).await;
    let (mut send, mut recv) = session.open_bi().await.unwrap();
    send_json(
        &mut send,
        &json!({"v":1,"id":1,"type":"auth","token":TOKEN}),
    )
    .await;
    let auth = recv_json(&mut recv).await;
    assert_eq!(auth["ok"], true);
    assert!(auth["expiresAt"].as_u64().unwrap() > 0);
    let deadline = Instant::now() + Duration::from_secs(3);
    while !h.server().is_finished() {
        assert!(
            Instant::now() < deadline,
            "인증서 수명 뒤에도 서버가 남았다"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(h.server().state(), SecureRemoteState::Idle);
    expect_closed(&mut recv).await;
}

#[tokio::test]
async fn repeated_reconnections_release_connection_slots() {
    let mut timeouts = default_timeouts();
    timeouts.idle = Duration::from_millis(100);
    timeouts.wait = Duration::from_millis(500);
    let h = Harness::new(TOKEN, timeouts);
    for _ in 0..8 {
        let (_session, _send, mut recv) = authenticate(&h, TOKEN).await;
        expect_closed(&mut recv).await;
        let deadline = Instant::now() + Duration::from_secs(2);
        while h.server().state() != SecureRemoteState::Remembered {
            assert!(Instant::now() < deadline, "재연결 슬롯이 반환되지 않았다");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
