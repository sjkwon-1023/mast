//! Secure Remote(WebTransport)의 Tauri 수명 관리와 Windows UDP 방화벽 글루.
//!
//! 코어(`mast_remote::wt`)는 서버 **하나**의 수명만 안다. 여기서는 UI 가 만든
//! `pairingId` 별로 그 서버를 최대 하나만 살리고
//! `Idle → Starting → Waiting → Connected → Stopping → Idle` 전이를 직렬화한다.
//!
//! 계약의 뿌리:
//!
//! - **부팅에는 아무것도 열지 않는다.** managed state 는 앱 수명 동안 [`InputWriter`]
//!   하나를 소유할 뿐이고(제출이 없으면 스레드도 만들지 않는다), UDP 리스너·인증서·TLS
//!   자원은 `secure_remote_start` 가 QR 페어링을 실제로 시작할 때만 생긴다.
//! - **쓰기 coordinator 는 하나다.** `start` 마다 새로 만들면 이전 페어링의 막힌
//!   쓰기가 다음 페어링의 busy 거절 근거로 보이지 않는다 — 청크 1 의 유한성 계약이
//!   여기 걸려 있다.
//! - **취소가 먼저 도착한 ID 는 기억한다.** 늦게 도착한 `start` 는 바인드 전에
//!   거절되므로 리스너가 남지 않는다. 바인드가 끝난 **뒤** 취소가 확인된 서버는
//!   정지 표지([`Shared::stopping`])를 쥔 채 내려가고, 정지가 끝나 UDP 소켓이
//!   돌아온 뒤에야 그 슬롯이 열린다 — 그 창의 새 `start` 는 `AddrInUse`/`failed` 가
//!   아니라 `stopping` 을 받는다. 취소와 인증 중 먼저 승인된 쪽이 이긴다는 판정은
//!   코어 `SecureRemote::cancel` 이 원자적으로 하고(그것이 인증이면 `false`), 글루는
//!   그 결과만 상태에 반영한다.
//! - **오래된 ID 의 취소는 현재 페어링을 건드리지 않는다.** 같은 ID 일 때만 서버에
//!   정지를 지시한다.
//! - **긴 작업 중 lock 을 잡지 않는다.** 인증서 생성·UDP 바인드는 `spawn_blocking`
//!   에서, 정지(join)는 lock 밖에서 돈다.
//!
//! 반환 JSON 계약(프론트 미러는 청크 4 의 타입):
//!
//! 인증된 페어링은 통신 종료 후에도 인증서 만료 또는 앱 종료까지 메모리에 유지한다.
//!
//! - `secure_remote_status() -> { state, pairingId, reason }` — `state` 는
//!   `idle|starting|waiting|connected|stopping|failed`, `pairingId` 는 그 상태가
//!   가리키는 페어링(없으면 null), `reason` 은 실패 사유. **token·cert hash·개인키는
//!   어떤 필드에도 싣지 않는다.**
//! - `secure_remote_start(pairingId) -> { state: "waiting", pairingId, url }` —
//!   URL(QR)은 **성공한 start 응답에만** 실린다. 바인드와 LAN IPv4 확인 뒤에만 만든다.
//! - `secure_remote_cancel(pairingId) -> status` — 적용 뒤의 상태를 그대로 돌려준다.
//! - 오류(거절)는 `{ code, message }` 다. `code` 는 `busy`(다른 페어링 진행 중),
//!   `connected`(이미 연결됨), `stopping`(이전 종료가 끝나지 않음),
//!   `cancelled`(이 ID 는 취소됨), `failed`(생성 실패 — `message` 에 사유).
//! - `secure_remote_firewall_status()` / `secure_remote_firewall_allow()` — UDP 7331
//!   전용이며 기존 TCP 커맨드(`remote_firewall_*`)와 완전히 별개다.

use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use mast_core::command::Dispatcher;
use mast_core::session::SessionManager;
use mast_remote::{
    generate_secure_token, InputWriter, SecureRemote, SecureRemoteConfig, SecureRemoteDeps,
    SecureRemoteState, SecureRemoteTimeouts,
};
use tauri::State;

use crate::winlog;

/// Secure Remote 의 고정 UDP 포트. 충돌하면 대체 포트로 조용히 옮기지 않고 실패한다.
pub const SECURE_REMOTE_PORT: u16 = 7331;

/// QR 의 base 와 서버가 허용하는 유일한 Origin — 공개 페이지 주소가 바뀌면 둘이 함께
/// 바뀌어야 하므로 한 곳에서 나온다.
const PAGES_URL: &str = "https://sjkwon-1023.github.io/mast/";
const ORIGIN: &str = "https://sjkwon-1023.github.io";

/// 취소가 `start` 보다 먼저 도착한 pairing id 를 기억하는 상한. UI 는 시도마다 새
/// UUID 를 만들므로 이 창을 넘겨 되살아날 ID 가 없고, 넘치면 가장 오래된 것부터 잊는다.
const CANCELLED_WINDOW: usize = 32;

/// 프론트 미러 계약 — `backend.ts` 의 같은 이름 타입이다.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecureRemoteStatus {
    state: &'static str,
    pairing_id: Option<String>,
    reason: Option<String>,
}

/// 성공한 `start` 의 응답. URL 은 이 응답에만 실린다.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecureRemoteStart {
    state: &'static str,
    pairing_id: String,
    url: String,
}

/// 거절의 사유. 프론트는 `code` 로 분기하고 `message` 를 그대로 보여 줄 수 있다.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecureRemoteCommandError {
    code: &'static str,
    message: String,
}

impl SecureRemoteCommandError {
    fn busy(pairing_id: &str) -> Self {
        Self {
            code: "busy",
            message: format!("a pairing ({pairing_id}) is already starting or waiting for a phone"),
        }
    }

    fn connected(pairing_id: &str) -> Self {
        Self {
            code: "connected",
            message: format!("a phone is already connected ({pairing_id})"),
        }
    }

    fn stopping(pairing_id: &str) -> Self {
        Self {
            code: "stopping",
            message: format!("the previous pairing ({pairing_id}) is still shutting down"),
        }
    }

    fn cancelled(pairing_id: &str) -> Self {
        Self {
            code: "cancelled",
            message: format!("the pairing {pairing_id} was cancelled"),
        }
    }

    fn failed(message: String) -> Self {
        Self {
            code: "failed",
            message,
        }
    }
}

/// 서버 생성에 쓰는 고정 값. 프로덕션 기본값이 계약이고(포트 7331·계획의 타임아웃),
/// 테스트는 포트 0(OS 배정)과 짧은 대기 창으로 **같은 경로**를 돈다 — 판정 코드에
/// 테스트 전용 분기를 만들지 않기 위한 이음매다.
#[derive(Clone)]
struct Settings {
    port: u16,
    timeouts: SecureRemoteTimeouts,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: SECURE_REMOTE_PORT,
            timeouts: SecureRemoteTimeouts::default(),
        }
    }
}

#[derive(Default)]
struct Shared {
    /// 지금 살아 있는 서버 — 있으면 정확히 하나다.
    active: Option<Active>,
    /// 바인드가 진행 중인 pairing id — 동시에 하나만 허용한다.
    starting: Option<String>,
    /// 바인드가 끝난 서버를 취소로 내리는 중인 pairing id. 정지(join)가 끝나 UDP 소켓이
    /// 돌아오기 전까지 시작 슬롯을 대신 쥔다 — 그 창의 새 `start` 는 `stopping` 을 받는다.
    stopping: Option<String>,
    /// 취소가 먼저 도착한 pairing id (늦은 start 폐기 근거).
    cancelled: VecDeque<String>,
    /// 마지막 실패 (pairing id, 사유). 다음 `start` 가 지운다.
    failure: Option<(String, String)>,
}

impl Shared {
    fn remember_cancelled(&mut self, pairing_id: &str) {
        if self.cancelled.iter().any(|id| id == pairing_id) {
            return;
        }
        if self.cancelled.len() >= CANCELLED_WINDOW {
            self.cancelled.pop_front();
        }
        self.cancelled.push_back(pairing_id.to_owned());
    }

    fn was_cancelled(&self, pairing_id: &str) -> bool {
        self.cancelled.iter().any(|id| id == pairing_id)
    }

    /// 끝난 서버를 회수한다. 런타임 스레드가 끝났다는 것은 UDP 소켓도 돌아왔다는
    /// 뜻이라(청크 1 계약) 이 뒤의 재바인드가 안전하다 — join 은 즉시 끝난다.
    fn reap_finished(&mut self) {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.server.is_finished())
        {
            self.active = None;
        }
    }

    /// 바인드된 서버를 취소·종료로 내릴 때 시작 슬롯을 **정지 표지로** 옮긴다. 이 표지가
    /// 있는 동안 새 `start` 는 `busy` 가 아니라 `stopping` 을 받는다 — 정지가 끝나 UDP
    /// 소켓이 실제로 돌아오기 전에 재바인드를 시도해 `AddrInUse`/`failed` 로 끝나는 창을
    /// 없앤다. 이 pairing 의 슬롯이 아니면(이미 종료 경로가 비웠으면) 아무것도 하지 않는다.
    /// 호출자가 lock 을 쥔 채로 부른다 — 취소 확인과 슬롯 이동 사이에 새 `start` 가
    /// 끼어들 틈이 없어야 하기 때문이다.
    fn begin_stop(&mut self, pairing_id: &str) -> bool {
        if self.starting.as_deref() != Some(pairing_id) {
            return false;
        }
        self.starting = None;
        self.stopping = Some(pairing_id.to_owned());
        true
    }
}

struct Active {
    pairing_id: String,
    /// 인증 **전** 취소가 승인됐다 — 상태 표시를 `stopping` 으로 고정한다.
    /// 인증이 먼저 승인된 세션은 취소 요청에도 살아 있다(`cancelled == false`).
    cancelled: bool,
    server: SecureRemote,
}

/// 앱 수명 동안 하나뿐인 Secure Remote 수명 관리자. managed state 로 등록된다.
pub struct SecureRemoteManager {
    dispatcher: Arc<Mutex<Dispatcher>>,
    sessions: Arc<SessionManager>,
    /// 모든 페어링이 **같은** coordinator 를 쓴다 (모듈 doc 의 계약).
    writer: Arc<InputWriter>,
    settings: Settings,
    shared: Mutex<Shared>,
}

impl SecureRemoteManager {
    /// 부팅에서 한 번. 리스너도 TLS 자원도 열지 않는다 — `InputWriter::new()` 는
    /// 제출이 없으면 스레드를 만들지 않는다.
    pub fn new(dispatcher: Arc<Mutex<Dispatcher>>, sessions: Arc<SessionManager>) -> Self {
        Self {
            dispatcher,
            sessions,
            writer: Arc::new(InputWriter::new()),
            settings: Settings::default(),
            shared: Mutex::new(Shared::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// 시작 가능한지 판정하고 바인드 슬롯을 차지한다. 실제 생성은 lock 밖에서 하므로
    /// 이 시점의 `starting` 표지가 다른 `start` 를 막는 유일한 장치다.
    fn claim(&self, pairing_id: &str) -> Result<(), SecureRemoteCommandError> {
        let mut shared = self.lock();
        if shared.was_cancelled(pairing_id) {
            return Err(SecureRemoteCommandError::cancelled(pairing_id));
        }
        // 정지 중인 서버가 UDP 를 쥐고 있다 — 곧 풀린다는 사실을 `busy` 와 구분해 알린다.
        if let Some(stopping) = &shared.stopping {
            return Err(SecureRemoteCommandError::stopping(stopping));
        }
        if let Some(starting) = &shared.starting {
            return Err(SecureRemoteCommandError::busy(starting));
        }
        if let Some(active) = &shared.active {
            if !active.server.is_finished() {
                return Err(occupied_error(observed_state(active), &active.pairing_id));
            }
        }
        // 끝난 서버 회수 — 이전 종료가 **완료된** 뒤에만 새 bind 를 허용한다.
        shared.active = None;
        shared.failure = None;
        shared.starting = Some(pairing_id.to_owned());
        Ok(())
    }

    /// 생성 실패 — 슬롯을 비우고 사유를 `failed` 상태로 남긴다.
    fn fail(&self, pairing_id: &str, reason: String) -> SecureRemoteCommandError {
        let mut shared = self.lock();
        if shared.starting.as_deref() == Some(pairing_id) {
            shared.starting = None;
        }
        let error = SecureRemoteCommandError::failed(reason);
        shared.failure = Some((pairing_id.to_owned(), error.message.clone()));
        error
    }

    /// 바인드된 서버를 취소·종료로 내릴 때 시작 슬롯을 정지 표지로 옮긴다 — 설치가
    /// 취소를 확인한 lock 안에서 [`Shared::begin_stop`] 을 부른다.
    fn finish_stop(&self, pairing_id: &str) {
        let mut shared = self.lock();
        if shared.stopping.as_deref() == Some(pairing_id) {
            shared.stopping = None;
        }
    }

    /// 바인드가 끝난 서버를 설치한다. 그 사이 취소가 승인됐으면 서버를 **남기지 않고**
    /// 정지시킨다 — "취소 뒤 늦은 start 가 리스너를 남기지 않는다"의 본체다. 취소 확인과
    /// 슬롯 이동(정지 표지)은 같은 lock 안이라 그 사이에 새 `start` 가 끼어들 틈이 없다.
    fn install(
        &self,
        pairing_id: String,
        url: String,
        mut server: SecureRemote,
    ) -> Result<SecureRemoteStart, SecureRemoteCommandError> {
        let mut shared = self.lock();
        let ours = shared.starting.as_deref() == Some(pairing_id.as_str());
        if !ours {
            // 종료 경로가 슬롯을 비웠다 — 이 서버는 더 이상 현재 페어링이 아니다.
            // (앱 Exit 경로라 슬롯을 새로 잡지 않는다.)
            drop(shared);
            server.stop();
            return Err(SecureRemoteCommandError::cancelled(&pairing_id));
        }
        if shared.was_cancelled(&pairing_id) {
            // 슬롯을 정지 표지로 옮긴 뒤 정지(join)를 lock 밖에서 돌린다 — 그 창의 새
            // start 는 `stopping` 을 받고, UDP 가 돌아온 뒤에야 슬롯이 열린다.
            let marked = shared.begin_stop(&pairing_id);
            drop(shared);
            server.stop();
            if marked {
                self.finish_stop(&pairing_id);
            }
            return Err(SecureRemoteCommandError::cancelled(&pairing_id));
        }
        shared.starting = None;
        shared.active = Some(Active {
            pairing_id: pairing_id.clone(),
            cancelled: false,
            server,
        });
        drop(shared);
        Ok(SecureRemoteStart {
            state: "waiting",
            pairing_id,
            url,
        })
    }

    /// 취소. 같은 ID 의 살아 있는 서버에만 정지를 지시하고, 인증이 먼저 승인된
    /// 세션이면 코어가 `false` 를 돌려주므로 그대로 둔다 (계획 계약).
    fn cancel(&self, pairing_id: &str) -> SecureRemoteStatus {
        {
            let mut shared = self.lock();
            shared.remember_cancelled(pairing_id);
            if let Some(active) = shared.active.as_mut() {
                // 인증이 먼저 승인된 세션이면 `cancel()` 이 false 를 돌려준다 — 그때는
                // 살아 있는 연결의 수명에 맡긴다 (계획 계약).
                if active.pairing_id == pairing_id
                    && !active.server.is_finished()
                    && active.server.cancel()
                {
                    active.cancelled = true;
                }
            }
        }
        self.snapshot()
    }

    fn snapshot(&self) -> SecureRemoteStatus {
        let mut shared = self.lock();
        shared.reap_finished();
        if let Some(starting) = &shared.starting {
            return SecureRemoteStatus {
                state: "starting",
                pairing_id: Some(starting.clone()),
                reason: None,
            };
        }
        // 바인드는 끝났지만 취소로 정지 중이다 — 곧 사라질 서버의 상태를 그대로 알린다.
        if let Some(stopping) = &shared.stopping {
            return SecureRemoteStatus {
                state: "stopping",
                pairing_id: Some(stopping.clone()),
                reason: None,
            };
        }
        if let Some(active) = &shared.active {
            return SecureRemoteStatus {
                state: observed_state(active),
                pairing_id: Some(active.pairing_id.clone()),
                reason: None,
            };
        }
        if let Some((pairing_id, reason)) = &shared.failure {
            return SecureRemoteStatus {
                state: "failed",
                pairing_id: Some(pairing_id.clone()),
                reason: Some(reason.clone()),
            };
        }
        SecureRemoteStatus {
            state: "idle",
            pairing_id: None,
            reason: None,
        }
    }

    /// 앱 Exit 에서 서버를 확실히 내린다. 정지는 짧다(정지 신호 → 최대 250ms 의
    /// CONNECTION_CLOSE flush) — 프로세스가 사라지면 OS 가 소켓을 거둬 가지만,
    /// 그러면 "종료 시점에 리스너가 어떻게 끝났나"를 로그로 남길 수 없다.
    pub fn shutdown(&self) {
        let active = {
            let mut shared = self.lock();
            shared.starting = None;
            shared.active.take()
        };
        if let Some(mut active) = active {
            active.server.stop();
        }
    }
}

/// 이미 페어링이 있는데 새 `start` 가 들어왔을 때의 거절 사유. `connected`(UI 는
/// "연결 중"으로 안내)와 `stopping`(곧 풀린다)은 `busy` 로 뭉뚱그리면 안 되는
/// 별개 상황이라 코드가 갈린다.
fn occupied_error(state: &'static str, pairing_id: &str) -> SecureRemoteCommandError {
    match state {
        "connected" | "remembered" => SecureRemoteCommandError::connected(pairing_id),
        "stopping" => SecureRemoteCommandError::stopping(pairing_id),
        _ => SecureRemoteCommandError::busy(pairing_id),
    }
}

/// 서버가 도는 상태의 UI 이름. 순수 함수라 다섯 갈래를 서버 없이 전부 시험한다.
fn state_name(state: SecureRemoteState) -> &'static str {
    match state {
        SecureRemoteState::Starting => "starting",
        SecureRemoteState::Waiting => "waiting",
        SecureRemoteState::Connected => "connected",
        SecureRemoteState::Remembered => "remembered",
        SecureRemoteState::Stopping => "stopping",
        SecureRemoteState::Idle => "idle",
    }
}

/// 지금 살아 있는 서버의 상태. 취소가 승인된(인증 전) 서버는 런타임이 `Stopping` 을
/// 적기 전의 `Waiting` 창에도 `stopping` 으로 보여 준다 — UI 가 곧 끝난다는 사실을
/// 알아야 하기 때문이다. 인증된 세션은 취소에도 살아 있으므로 `connected` 다.
fn observed_state(active: &Active) -> &'static str {
    if active.server.is_finished() {
        return "idle";
    }
    if active.cancelled {
        return "stopping";
    }
    state_name(active.server.state())
}

/// QR 의 fragment 계약: `v=1&host=<LAN IPv4>&port=<UDP>&cert=<base64url>&token=<43자>`.
/// fragment 는 정적 서버로 전송되지 않아 토큰이 액세스 로그에 남지 않는다.
fn pairing_url(ip: Ipv4Addr, port: u16, cert: &str, token: &str) -> String {
    format!("{PAGES_URL}#v=1&host={ip}&port={port}&cert={cert}&token={token}")
}

/// 폰이 접속할 이 기기의 LAN IPv4. 라우팅 질문은 [`crate::remote::lan_ip`] 와 같고,
/// 인증서 SAN 과 QR host 가 IPv4 만 받으므로 여기서 좁힌다.
fn lan_ipv4() -> Result<Ipv4Addr, String> {
    match crate::remote::lan_ip()? {
        IpAddr::V4(ip) => Ok(ip),
        IpAddr::V6(ip) => Err(format!(
            "the default route resolved to IPv6 ({ip}); secure remote needs the LAN IPv4 address"
        )),
    }
}

/// 인증서·토큰·UDP 바인드·QR URL — 실패는 전부 사유 문자열로 돌아온다.
///
/// 순서가 계약이다: LAN IPv4 → 토큰 → 인증서(SAN) → UDP 바인드 → URL. URL 을 마지막에
/// 만드는 것이 "바인드 성공 뒤에만 QR 을 낸다"의 구현이다.
fn create_server(
    dispatcher: Arc<Mutex<Dispatcher>>,
    sessions: Arc<SessionManager>,
    writer: Arc<InputWriter>,
    settings: Settings,
) -> Result<(SecureRemote, String), String> {
    let lan_ip = lan_ipv4()?;
    // 페어링마다 새 32B CSPRNG 토큰 — Local HTTP 의 파일 토큰과는 별개이고 저장하지 않는다.
    let token = generate_secure_token().map_err(|err| err.to_string())?;
    let server = SecureRemote::start(
        SecureRemoteConfig {
            bind: SocketAddr::from(([0, 0, 0, 0], settings.port)),
            lan_ip,
            origin: ORIGIN.to_owned(),
            token: token.clone(),
            timeouts: settings.timeouts,
        },
        SecureRemoteDeps {
            dispatcher,
            sessions,
            log: Arc::new(|line: String| winlog!("{line}")),
            writer,
        },
    )
    .map_err(|err| err.to_string())?;
    let url = pairing_url(
        lan_ip,
        server.local_addr().port(),
        server.cert_hash_base64(),
        &token,
    );
    Ok((server, url))
}

/// QR 페어링을 시작한다. 실제 바인드는 `spawn_blocking` 에서 돈다.
#[tauri::command]
pub async fn secure_remote_start(
    state: State<'_, SecureRemoteManager>,
    pairing_id: String,
) -> Result<SecureRemoteStart, SecureRemoteCommandError> {
    state.claim(&pairing_id)?;
    let dispatcher = Arc::clone(&state.dispatcher);
    let sessions = Arc::clone(&state.sessions);
    let writer = Arc::clone(&state.writer);
    let settings = state.settings.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        create_server(dispatcher, sessions, writer, settings)
    })
    .await;
    match started {
        Ok(Ok((server, url))) => state.install(pairing_id, url, server),
        Ok(Err(reason)) => Err(state.fail(&pairing_id, reason)),
        Err(err) => Err(state.fail(
            &pairing_id,
            format!("the secure remote start task failed: {err}"),
        )),
    }
}

/// 취소 — 적용 뒤의 상태를 그대로 돌려준다 (UI 가 왕복 없이 화면을 맞춘다).
#[tauri::command]
pub fn secure_remote_cancel(
    state: State<'_, SecureRemoteManager>,
    pairing_id: String,
) -> SecureRemoteStatus {
    state.cancel(&pairing_id)
}

/// 상태 조회. 비밀(token·hash·개인키)은 어떤 필드에도 싣지 않는다.
#[tauri::command]
pub fn secure_remote_status(state: State<'_, SecureRemoteManager>) -> SecureRemoteStatus {
    state.snapshot()
}

/// Secure Remote UDP 7331 의 방화벽 판정 — Local HTTP 커맨드와 별개 경로다.
#[tauri::command]
pub async fn secure_remote_firewall_status() -> Result<crate::firewall::FirewallStatus, String> {
    tauri::async_runtime::spawn_blocking(|| crate::firewall::secure_status(SECURE_REMOTE_PORT))
        .await
        .map_err(|err| format!("secure_remote_firewall_status task join failed: {err}"))
}

/// UDP 규칙 생성 — **사용자가 UI 버튼을 누를 때만** 불린다. 시작·QR 생성 경로는
/// 이 커맨드를 부르지 않으므로 UAC 가 자동으로 뜨는 일이 없다.
#[tauri::command]
pub async fn secure_remote_firewall_allow() -> Result<crate::firewall::AllowOutcome, String> {
    tauri::async_runtime::spawn_blocking(|| crate::firewall::secure_allow(SECURE_REMOTE_PORT))
        .await
        .map_err(|err| format!("secure_remote_firewall_allow task join failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    use mast_core::command::{SessionHost, ShellSpawnReq};
    use mast_core::session::SessionId;

    /// 수명 테스트는 셸을 스폰하지 않는다 — 서버만으로 전이를 본다.
    struct NoSessions;

    impl SessionHost for NoSessions {
        fn spawn_shell(&self, _req: ShellSpawnReq) -> anyhow::Result<SessionId> {
            anyhow::bail!("the lifecycle tests never spawn a shell")
        }

        fn kill(&self, _id: SessionId) {}
    }

    /// 실제 UDP 소켓을 쓰는 테스트끼리 직렬화한다 — 포트를 잡고 노는 구간이 겹치면
    /// 재바인드 검증이 다른 테스트의 OS 배정 포트와 부딪힐 수 있다.
    static LIFECYCLE: Mutex<()> = Mutex::new(());

    fn manager(port: u16) -> SecureRemoteManager {
        manager_with(
            port,
            SecureRemoteTimeouts {
                wait: Duration::from_secs(30),
                ..SecureRemoteTimeouts::default()
            },
        )
    }

    fn manager_with(port: u16, timeouts: SecureRemoteTimeouts) -> SecureRemoteManager {
        SecureRemoteManager {
            dispatcher: Arc::new(Mutex::new(Dispatcher::new(Box::new(NoSessions)))),
            sessions: Arc::new(SessionManager::new()),
            writer: Arc::new(InputWriter::new()),
            settings: Settings { port, timeouts },
            shared: Mutex::new(Shared::default()),
        }
    }

    /// 매니저의 `start` 경로 그대로: 슬롯 선점 → 생성 → 설치. 바인드된 포트를 함께 돌려준다.
    fn start_pairing(manager: &SecureRemoteManager, pairing_id: &str) -> (SecureRemoteStart, u16) {
        manager.claim(pairing_id).unwrap_or_else(|err| {
            panic!("claim {pairing_id} failed: {err:?}");
        });
        let (server, url) = create_server(
            Arc::clone(&manager.dispatcher),
            Arc::clone(&manager.sessions),
            Arc::clone(&manager.writer),
            manager.settings.clone(),
        )
        .unwrap_or_else(|err| panic!("bind failed: {err}"));
        let port = server.local_addr().port();
        let started = manager
            .install(pairing_id.to_owned(), url, server)
            .unwrap_or_else(|err| panic!("install {pairing_id} failed: {err:?}"));
        (started, port)
    }

    fn wait_for_state(manager: &SecureRemoteManager, state: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let now = manager.snapshot();
            if now.state == state {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "state never became {state}: {now:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn pairing_url_follows_the_fragment_contract() {
        assert_eq!(
            pairing_url(
                Ipv4Addr::new(192, 168, 0, 20),
                7331,
                "CERT",
                "0123456789012345678901234567890123456789012"
            ),
            "https://sjkwon-1023.github.io/mast/#v=1&host=192.168.0.20&port=7331\
             &cert=CERT&token=0123456789012345678901234567890123456789012"
        );
    }

    #[test]
    fn the_occupied_error_separates_connected_and_stopping_from_busy() {
        assert_eq!(occupied_error("connected", "p").code, "connected");
        assert_eq!(occupied_error("remembered", "p").code, "connected");
        assert_eq!(occupied_error("stopping", "p").code, "stopping");
        for state in ["starting", "waiting", "idle"] {
            assert_eq!(occupied_error(state, "p").code, "busy", "{state}");
        }
    }

    #[test]
    fn state_name_covers_every_server_state() {
        assert_eq!(state_name(SecureRemoteState::Starting), "starting");
        assert_eq!(state_name(SecureRemoteState::Waiting), "waiting");
        assert_eq!(state_name(SecureRemoteState::Connected), "connected");
        assert_eq!(state_name(SecureRemoteState::Remembered), "remembered");
        assert_eq!(state_name(SecureRemoteState::Stopping), "stopping");
        assert_eq!(state_name(SecureRemoteState::Idle), "idle");
    }

    #[test]
    fn the_cancelled_ledger_forgets_the_oldest_id_beyond_its_window() {
        let mut shared = Shared::default();
        shared.remember_cancelled("first");
        shared.remember_cancelled("first");
        assert_eq!(
            shared.cancelled.len(),
            1,
            "같은 ID 를 두 번 기억하면 안 된다"
        );
        for index in 0..CANCELLED_WINDOW {
            shared.remember_cancelled(&format!("id-{index}"));
        }
        assert_eq!(shared.cancelled.len(), CANCELLED_WINDOW);
        assert!(!shared.was_cancelled("first"), "가장 오래된 ID 부터 잊는다");
        assert!(shared.was_cancelled(&format!("id-{}", CANCELLED_WINDOW - 1)));
    }

    #[test]
    fn a_start_after_a_bind_failure_reports_it_once_and_clears_it_on_the_next_attempt() {
        let manager = manager(0);
        manager.claim("a").unwrap();
        let error = manager.fail("a", "cannot bind".to_owned());
        assert_eq!(error.code, "failed");
        let status = manager.snapshot();
        assert_eq!(status.state, "failed");
        assert_eq!(status.pairing_id.as_deref(), Some("a"));
        assert_eq!(status.reason.as_deref(), Some("cannot bind"));

        manager.claim("b").unwrap();
        assert_eq!(manager.snapshot().state, "starting");
        // 뒤처리 — 슬롯을 비워 두지 않으면 이 테스트가 다음 테스트의 매니저와 무관하게 끝난다.
        manager.fail("b", "cleanup".to_owned());
    }

    #[test]
    fn a_cancel_before_the_start_arrives_discards_the_late_start() {
        let _guard = LIFECYCLE.lock().unwrap_or_else(|err| err.into_inner());
        let manager = manager(0);
        let status = manager.cancel("late");
        assert_eq!(status.state, "idle");
        assert_eq!(status.pairing_id, None);

        // 늦게 도착한 start 는 **바인드 전에** 거절된다 — 리스너가 만들어질 기회가 없다.
        let error = manager.claim("late").unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert_eq!(manager.snapshot().state, "idle");
    }

    #[test]
    fn a_cancelled_pairing_frees_the_udp_port_for_the_next_start() {
        let _guard = LIFECYCLE.lock().unwrap_or_else(|err| err.into_inner());
        let first = manager(0);
        let (started, port) = start_pairing(&first, "first");
        assert_eq!(started.state, "waiting");
        // 런타임이 Waiting 을 적기까지의 짧은 창이 있다 — 상태 조회가 아니라 그 전이를 기다린다.
        wait_for_state(&first, "waiting");

        let status = first.cancel("first");
        assert!(matches!(status.state, "stopping" | "idle"), "{status:?}");
        wait_for_state(&first, "idle");

        // 같은 포트를 쓰는 새 매니저가 바인드에 성공한다 = 이전 서버의 UDP 소켓이
        // 실제로 돌아왔다 (살아 있으면 AddrInUse 로 start 가 실패한다).
        let second = manager(port);
        let (started, bound) = start_pairing(&second, "second");
        assert_eq!(started.state, "waiting");
        assert_eq!(bound, port);
        second.cancel("second");
    }

    #[test]
    fn an_open_pairing_blocks_a_second_start_and_a_stale_cancel_leaves_it_alone() {
        let _guard = LIFECYCLE.lock().unwrap_or_else(|err| err.into_inner());
        let manager = manager(0);
        let _ = start_pairing(&manager, "a");
        wait_for_state(&manager, "waiting");

        let error = manager.claim("b").unwrap_err();
        assert_eq!(error.code, "busy");

        // 예전 ID 의 취소는 현재 페어링을 건드리지 않는다.
        let status = manager.cancel("stale");
        assert_eq!(status.pairing_id.as_deref(), Some("a"));
        assert_eq!(status.state, "waiting");
        assert_eq!(manager.claim("b").unwrap_err().code, "busy");

        // 현재 ID 의 취소는 정상 동작하고, 취소된 ID 는 다시 시작할 수 없다.
        let status = manager.cancel("a");
        assert!(matches!(status.state, "stopping" | "idle"), "{status:?}");
        wait_for_state(&manager, "idle");
        assert_eq!(manager.claim("a").unwrap_err().code, "cancelled");
    }

    #[test]
    fn the_waiting_window_expiry_returns_to_idle_and_frees_the_port() {
        let _guard = LIFECYCLE.lock().unwrap_or_else(|err| err.into_inner());
        let timeouts = SecureRemoteTimeouts {
            wait: Duration::from_millis(300),
            ..SecureRemoteTimeouts::default()
        };
        let first = manager_with(0, timeouts);
        let (_, port) = start_pairing(&first, "expiring");
        wait_for_state(&first, "waiting");

        // 서버 스스로 끝난다 (조회가 아니라 서버 수명이 원인이다).
        wait_for_state(&first, "idle");

        let second = manager(port);
        let (_, bound) = start_pairing(&second, "next");
        assert_eq!(
            bound, port,
            "만료 뒤에도 같은 포트를 다시 쓸 수 있어야 한다"
        );
        second.cancel("next");
    }

    /// install 취소 경로의 슬롯 전이를 직접 검증한다. 바인드된 서버의 정지(join)를
    /// 흉내 낼 결정적 이음매가 없어서, install 이 취소를 확인한 lock 안에서 부르는
    /// `Shared::begin_stop` 과 `finish_stop` 을 그대로 쓴다 — **정지가 도는 동안의 관측**
    /// (새 start 가 `stopping` 을 받는지)을 이 상태 수준에서 잠그고, 실제 정지·포트
    /// 반환은 아래 통합 테스트가 본다.
    #[test]
    fn the_stopping_slot_answers_new_starts_with_stopping_not_busy() {
        let manager = manager(0);
        manager.claim("late").unwrap();
        manager.cancel("late");

        assert!(
            manager.lock().begin_stop("late"),
            "우리 슬롯은 정지 표지로 옮긴다"
        );
        assert!(
            !manager.lock().begin_stop("other"),
            "남의 슬롯은 옮기지 않는다"
        );
        let error = manager.claim("next").unwrap_err();
        assert_eq!(
            error.code, "stopping",
            "정지 중에는 busy 가 아니라 stopping 이다"
        );
        let status = manager.snapshot();
        assert_eq!(status.state, "stopping");
        assert_eq!(status.pairing_id.as_deref(), Some("late"));

        manager.finish_stop("late");
        assert_eq!(manager.snapshot().state, "idle");
        manager.claim("next").unwrap();
        manager.fail("next", "cleanup".to_owned());
    }

    /// 취소가 바인드 뒤에 확인된 서버는 정지가 끝난 뒤에야 슬롯을 연다 — install 이
    /// 돌아온 직후 같은 UDP 포트로 재바인드가 성공하는지로 확인한다 (정지가 끝나기 전에
    /// 슬롯이 열렸다면 새 바인드가 AddrInUse 로 실패한다).
    #[test]
    fn a_cancelled_install_releases_the_udp_port_before_the_slot_opens() {
        let _guard = LIFECYCLE.lock().unwrap_or_else(|err| err.into_inner());
        let first = manager(0);
        first.claim("late").unwrap();
        // 바인드 **전**에 취소가 먼저 도착한 경우다.
        first.cancel("late");
        let (server, url) = create_server(
            Arc::clone(&first.dispatcher),
            Arc::clone(&first.sessions),
            Arc::clone(&first.writer),
            first.settings.clone(),
        )
        .unwrap_or_else(|err| panic!("bind failed: {err}"));
        let port = server.local_addr().port();

        let error = first.install("late".to_owned(), url, server).unwrap_err();
        assert_eq!(error.code, "cancelled");
        // install 이 돌아온 시점에 정지와 슬롯 해제가 모두 끝나 있다.
        assert_eq!(first.snapshot().state, "idle");

        let second = manager(port);
        let (started, bound) = start_pairing(&second, "next");
        assert_eq!(started.state, "waiting");
        assert_eq!(
            bound, port,
            "정지가 끝난 뒤에는 같은 포트를 다시 쓸 수 있다"
        );
        second.cancel("next");
    }

    #[test]
    fn a_shutdown_stops_the_live_pairing_and_releases_the_udp_port() {
        let _guard = LIFECYCLE.lock().unwrap_or_else(|err| err.into_inner());
        let first = manager(0);
        let (_, port) = start_pairing(&first, "a");
        wait_for_state(&first, "waiting");

        first.shutdown();
        // `take()` 뒤의 idle 만이 아니라, 실제로 같은 UDP 포트를 다시 바인드해
        // 소켓이 돌아왔는지 본다 (살아 있으면 새 바인드가 AddrInUse 로 실패한다).
        assert_eq!(first.snapshot().state, "idle");
        let second = manager(port);
        let (started, bound) = start_pairing(&second, "b");
        assert_eq!(started.state, "waiting");
        assert_eq!(
            bound, port,
            "shutdown 뒤에도 같은 포트를 다시 쓸 수 있어야 한다"
        );
        second.cancel("b");
    }
}
