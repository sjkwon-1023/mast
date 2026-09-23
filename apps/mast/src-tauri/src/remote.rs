//! 원격 표면(LAN 폴링)의 글루 — 설정·토큰 파일·자산 콜백·로그 싱크·서버 기동,
//! 그리고 데스크톱 UI 가 상태와 페어링 URL 을 묻는 커맨드 두 개.
//!
//! 서버 본체는 `mast-remote` 크레이트에 있다. 여기 남은 것은 Tauri 에서만 얻을 수
//! 있는 것들(설정 경로, 임베드 자산, 로그 매크로)뿐이다 — `src-tauri` 는 Linux
//! 개발기에서 컴파일되지 않아(webkit2gtk 부재, Windows 타깃 check 만이 게이트)
//! 여기 놓인 코드는 `cargo test` 로 한 줄도 돌릴 수 없다. 인증·라우팅처럼 틀리면
//! 조용히 위험해지는 판정은 그래서 전부 저쪽에 있다.
//!
//! 계약: `docs/adr/0016-remote-surface-over-lan.md`.

use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};

use mast_core::command::Dispatcher;
use mast_core::session::SessionManager;
use tauri::{AppHandle, Manager, State};

use crate::winlog;

/// 폰 페이지의 진입 자산 키. `mast-remote` 의 라우터가 `/` 를 이 키로 옮기므로,
/// 부팅 검사가 보는 이름과 같아야 한다.
const REMOTE_INDEX_KEY: &str = "remote/index.html";

/// 원격 표면의 부팅 결과. 꺼져 있어도 **항상** managed state 로 등록된다 — 커맨드가
/// 상태 부재로 실패하면 프론트는 "꺼짐"과 "글루가 깨짐"을 구분할 수 없다.
pub enum RemoteState {
    Off,
    On {
        port: u16,
        /// 페어링 URL 을 만들 때만 읽는다. 상태 응답에는 절대 싣지 않는다.
        token: String,
        /// 살아 있는 서버. 이 값이 drop 되면 리스너가 닫히므로, managed state 로
        /// 앱 수명 동안 붙잡아 두는 것 자체가 서버를 살려 두는 방법이다 — 읽을 일이
        /// 없는 것이 정상이라 `dead_code` 를 끈다.
        #[allow(dead_code)]
        server: mast_remote::RemoteServer,
    },
    Failed {
        reason: String,
    },
}

/// 부팅 실패를 한 자리에서 기록한다 — 사유 문자열이 로그와 프론트 상태 라인에
/// 같은 문장으로 나가야 사용자가 본 것과 우리가 남긴 것이 대조된다.
fn failed(reason: String) -> RemoteState {
    winlog!("remote: {reason}");
    RemoteState::Failed { reason }
}

/// setup 의 맨 끝에서 한 번 부른다.
///
/// 순서가 계약이다: 설정 → 토큰 → 자산 키 집합 → 부팅 검사 → 바인드. 바인드가
/// 마지막인 이유는 그 앞의 어느 것이라도 실패하면 **리스너를 열지 않은 채** 끝나야
/// 하기 때문이다.
pub fn init(
    app: &AppHandle,
    dispatcher: Arc<Mutex<Dispatcher>>,
    sessions: Arc<SessionManager>,
) -> RemoteState {
    if cfg!(target_os = "macos") { return RemoteState::Off; }
    // 설정을 못 읽는 것은 여기서 말하지 않는다. 같은 파일을 `get_ui_settings` 가
    // 다시 읽어 프론트 상태 라인에 사유를 띄우는 것이 loud-fail 계약의 담당자이고
    // (`logfile::init` 과 같은 판단), 여기서 `failed` 로 바꾸면 폰트 오타 하나가
    // 원격 실패로 둔갑해 보고된다.
    let Ok(settings) = crate::commands::read_ui_settings(app) else {
        return RemoteState::Off;
    };
    let Some(remote) = settings.remote else {
        return RemoteState::Off;
    };
    let port = remote.port;

    let data_dir = match app.path().app_data_dir() {
        // state.json 옆 — 사용자가 토큰을 지워 재발급하는 그 디렉터리다.
        Ok(dir) => dir,
        Err(err) => return failed(format!("cannot resolve the app data dir: {err}")),
    };
    // 첫 부팅에서는 이 디렉터리가 아직 없을 수 있다: state.json 을 쓰는 Saver 는
    // debounce 뒤에 돌고, 로그는 꺼져 있으면 디렉터리를 만들지 않는다.
    if let Err(err) = std::fs::create_dir_all(&data_dir) {
        return failed(format!("cannot create {}: {err}", data_dir.display()));
    }
    let token = match mast_remote::load_or_create_token(&data_dir.join("remote-token")) {
        Ok(token) => token,
        Err(err) => return failed(err.to_string()),
    };

    // 임베드 키에는 선행 `/` 가 붙어 있고(`tauri-utils` 의 `AssetKey`), 조회
    // (`AssetResolver::get`)는 선행 `/` 없는 경로를 받아 스스로 다시 붙인다.
    // 라우터가 만드는 키에도 선행 `/` 가 없으므로 여기서 떼어 양쪽을 맞춘다.
    let resolver = app.asset_resolver();
    let keys: HashSet<String> = resolver
        .iter()
        .map(|(key, _)| key.trim_start_matches('/').to_string())
        .collect();

    // release 빌드의 자산 조회는 없는 경로에 절대 `None` 을 주지 않는다 — 순서대로
    // `<path>.html`, `<path>/index.html`, 마지막에 `index.html` 로 폴백한다
    // (tauri 2.11.5 `manager/mod.rs`). 그 마지막 폴백이 데스크톱 페이지이므로,
    // 게이트 없이 서버를 띄우면 `/remote/오타` 하나가 데스크톱 UI 를 무인증 표면에
    // 200 으로 내보낸다. 폰 페이지가 번들에 없다면 그 사고만 남으므로 아예 뜨지
    // 않는다.
    if !keys.is_empty() && !keys.contains(REMOTE_INDEX_KEY) {
        return failed("remote page missing from the bundle".to_string());
    }

    let assets: mast_remote::AssetFn = Arc::new(move |key: &str| {
        // 키 집합이 비어 있는 것은 dev(devUrl) 빌드뿐이다 — 임베드가 없으니 걸러낼
        // 목록도 없고, Tauri 의 dev 갈래는 `../dist/<path>` 를 직접 읽어 없으면
        // 정직하게 `None` 을 준다. 위의 폴백 사슬이 없는 쪽이라 게이트도 필요 없다.
        if !keys.is_empty() && !keys.contains(key) {
            return None;
        }
        resolver
            .get(key.to_string())
            .map(|asset| mast_remote::StaticAsset {
                bytes: asset.bytes,
                mime_type: asset.mime_type,
            })
    });

    let started = mast_remote::serve(
        mast_remote::RemoteConfig {
            bind: SocketAddr::from(([0, 0, 0, 0], port)),
            token: token.clone(),
            mobile_lease: mast_remote::MOBILE_SIZE_LEASE,
        },
        mast_remote::RemoteDeps {
            dispatcher,
            sessions,
            assets,
            log: Arc::new(|line: String| winlog!("{line}")),
        },
    );
    match started {
        Ok(server) => {
            log_firewall_state(port);
            RemoteState::On {
                port,
                token,
                server,
            }
        }
        Err(err) => failed(format!("cannot listen on 0.0.0.0:{port}: {err}")),
    }
}

/// 원격이 실제로 열린 부팅에서 방화벽 판정을 한 줄 남긴다.
///
/// 별도 스레드인 이유는 COM 열거가 수백 개의 규칙을 도는 동안 부팅을 잡지 않기
/// 위해서다. `allowed` 도 남긴다 — 현장 진단에서 "확인했더니 허용" 과 "아예 확인하지
/// 않았다" 는 다른 정보이고, 폰이 안 붙는다는 신고의 첫 질문이 바로 이것이다.
fn log_firewall_state(port: u16) {
    std::thread::spawn(move || {
        let status = crate::firewall::status(port);
        let detail = status
            .detail
            .as_deref()
            .map(|detail| format!(" — {detail}"))
            .unwrap_or_default();
        winlog!(
            "remote: firewall {} for {}:{port}{detail}",
            status.state,
            status.exe
        );
    });
}

/// 프론트 미러는 `backend.ts` 의 같은 이름 타입이다.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    state: &'static str,
    port: Option<u16>,
    reason: Option<String>,
}

/// 토큰이 렌더러로 건너가는 유일한 값이다.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    url: String,
}

/// 프론트가 **설정과 무관하게** 부팅당 한 번 부른다 — 설정 파일은 webview 가 뜰
/// 때마다 다시 읽히지만 서버는 부팅 때 한 번 결정되므로, 프론트가 설정으로 게이트하면
/// 재시작 전에 편집된 파일이 실제 상태와 어긋난다.
///
/// **토큰을 싣지 않는다.** 이 값은 상태 라인과 사이드바가 늘 들고 있는 것이라,
/// 여기에 토큰이 있으면 페어링을 열지도 않은 세션의 DOM 에 비밀이 남는다.
#[tauri::command]
pub fn remote_status(state: State<'_, RemoteState>) -> RemoteStatus {
    match &*state {
        RemoteState::Off => RemoteStatus {
            state: "off",
            port: None,
            reason: None,
        },
        RemoteState::On { port, .. } => RemoteStatus {
            state: "on",
            port: Some(*port),
            reason: None,
        },
        RemoteState::Failed { reason } => RemoteStatus {
            state: "failed",
            port: None,
            reason: Some(reason.clone()),
        },
    }
}

/// 페어링 URL — 다이얼로그를 **열 때만** 부른다.
///
/// 꺼져 있으면 `Ok(None)`(다이얼로그가 뜰 이유가 없다), 부팅에 실패했으면 그 사유로
/// reject 한다. LAN 주소를 못 얻는 것도 reject 다: 주소 없이 URL 을 만들면 폰이
/// 접속하지 못하는 QR 이 나가고, 그 실패는 폰 쪽에서만 보인다.
#[tauri::command]
pub fn remote_pairing(state: State<'_, RemoteState>) -> Result<Option<Pairing>, String> {
    match &*state {
        RemoteState::Off => Ok(None),
        RemoteState::Failed { reason } => Err(reason.clone()),
        RemoteState::On { port, token, .. } => Ok(Some(Pairing {
            url: pairing_url(lan_ip()?, *port, token),
        })),
    }
}

/// 방화벽 커맨드 둘이 공유하는 전제 — 꺼져 있거나 부팅에 실패한 원격에는 물어볼
/// 포트가 없다. 그 두 경우만 `Err` 이고, 방화벽 쪽 실패는 전부 `Ok` 안의 상태로
/// 나간다 (대화상자가 "확인하지 못했다" 를 보여 줄 수 있어야 한다).
fn active_port(state: &RemoteState) -> Result<u16, String> {
    match state {
        RemoteState::Off => Err("remote surface is off".to_owned()),
        RemoteState::Failed { reason } => Err(reason.clone()),
        RemoteState::On { port, .. } => Ok(*port),
    }
}

/// 지금 이 exe·이 포트가 Windows 방화벽에 허용돼 있는가 — 페어링 대화상자를 **열 때**
/// 부른다.
///
/// COM 열거는 수백 개의 규칙을 도므로 `spawn_blocking` 에서 돌린다 (`open_url` 과 같은
/// 이유). 포트만 복사해 넘기고 managed state 는 await 너머로 들고 가지 않는다.
#[tauri::command]
pub async fn remote_firewall_status(
    state: State<'_, RemoteState>,
) -> Result<crate::firewall::FirewallStatus, String> {
    let port = active_port(&state)?;
    tauri::async_runtime::spawn_blocking(move || crate::firewall::status(port))
        .await
        .map_err(|err| format!("remote_firewall_status task join failed: {err}"))
}

/// 허용 규칙을 만든다 — **사용자가 버튼을 눌렀을 때만** 부른다. UAC 창이 한 번 뜨고,
/// 응답은 사용자가 그 창에 답할 때까지 돌아오지 않는다(상한 없음 — `ShellExecuteExW`
/// 가 그 안에서 기다린다; 120 s 는 그 뒤 netsh 실행의 상한이다).
#[tauri::command]
pub async fn remote_firewall_allow(
    state: State<'_, RemoteState>,
) -> Result<crate::firewall::AllowOutcome, String> {
    let port = active_port(&state)?;
    tauri::async_runtime::spawn_blocking(move || crate::firewall::allow(port))
        .await
        .map_err(|err| format!("remote_firewall_allow task join failed: {err}"))
}

/// 토큰을 fragment 에 싣는다 — fragment 는 요청에 실리지 않으므로 폰의 첫 GET 이
/// 토큰을 액세스 로그·중계에 흘리지 않는다. 폰 페이지가 이 값을 localStorage 로
/// 옮기고 주소창에서 지운다.
fn pairing_url(ip: IpAddr, port: u16, token: &str) -> String {
    format!("http://{ip}:{port}/#t={token}")
}

/// 폰이 접속할 이 기기의 LAN 주소.
///
/// UDP 소켓의 `connect` 는 커널에 상대 주소를 적어 둘 뿐 **패킷을 보내지 않는다**.
/// 그 뒤 `local_addr` 을 읽으면 라우팅 테이블이 그 목적지에 어떤 인터페이스를
/// 고르는지가 그대로 나온다. 목적지 192.0.2.1 은 TEST-NET-1(RFC 5737)이라 실제로
/// 라우팅될 일이 없어, 질문은 "기본 경로가 나가는 인터페이스가 무엇인가"로 좁혀진다.
/// 인터페이스를 열거해 사설 대역을 고르는 방법보다 정확하다 — 어느 것이 폰과 같은
/// 링크인지는 라우팅 테이블만 안다.
///
/// Secure Remote QR 도 같은 질문을 쓰므로 `pub(crate)` 다 (`secure_remote` 가 IPv4 로
/// 좁혀 쓴다).
pub(crate) fn lan_ip() -> Result<IpAddr, String> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|err| format!("cannot open a socket to find the LAN address: {err}"))?;
    socket
        .connect("192.0.2.1:9")
        .map_err(|err| format!("cannot resolve the LAN address: {err}"))?;
    socket
        .local_addr()
        .map(|addr| addr.ip())
        .map_err(|err| format!("cannot read the LAN address: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn pairing_url_carries_the_token_in_the_fragment() {
        let url = pairing_url(IpAddr::V4(Ipv4Addr::new(192, 168, 0, 12)), 7331, "abc");
        assert_eq!(url, "http://192.168.0.12:7331/#t=abc");
    }
}
