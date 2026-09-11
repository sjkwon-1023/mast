//! Tauri 커맨드 — 프론트엔드 ↔ mast-core 글루.
//!
//! 세 갈래로 나뉜다 (10단계 계획 0-3 잠금 배치 + 21단계 뷰어):
//!
//! - **구조 변이** (`dispatch`, `get_state`): `Mutex<Dispatcher>` 를 잡는다.
//!   dispatch 는 내부 스폰이 블로킹이라 전체를 `spawn_blocking` 에서 돈다.
//! - **핫패스** (`attach_terminal`/`write_stdin`/`send_raw`/`resize`/`ack_output`/
//!   `get_stats`): Dispatcher lock 을 절대 타지 않는다 — `SessionManager`·sink
//!   레지스트리의 짧은 내부 lock 만 스친다. write·resize 는 블로킹 가능성이
//!   있어 `spawn_blocking`, ack 은 뮤텍스 갱신 + condvar notify 뿐이라 sync 즉시
//!   처리한다 (paused 재개 최단 경로 — spike 와 동일 규율).
//! - **뷰어 파일 접근** (`fs_list_dir`/`fs_stat`/`fs_read_chunk` — 21단계): 상태를
//!   건드리지 않는 읽기 전용 콘텐츠 플레인이라 Dispatcher lock 도 관리 상태도
//!   타지 않는다. 9P(`\\wsl.localhost`) I/O 와 distro 질의(프로세스 스폰)가 전부
//!   블로킹이라 **경로 해석까지 통째로** `spawn_blocking` 안에서 돈다.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, Manager, State};
use mast_core::command::{Command, CommandError, CommandOutput};
use mast_core::model::TabId;
use mast_core::session::{PtySession, SessionId};
use mast_core::wslpath;

use crate::state::{publish_state, AppState};

/// `get_stats` 직렬화형 (spike 이식). 코어 `SessionStats` 는 serde 의존이 없어
/// 글루 DTO 로 내보낸다. `id` 는 레지스트리 발급 `SessionId` — 커맨드·이벤트의
/// id 와 같은 공간이다.
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

/// id 로 세션 핸들을 얻는다. 매니저 내부 lock 은 이 조회 안에서만 잡힌다 —
/// 반환된 핸들에 대한 호출은 전부 lock 밖에서 이뤄진다.
fn session(state: &AppState, id: SessionId) -> Result<Arc<PtySession>, String> {
    state
        .sessions
        .get(id)
        .ok_or_else(|| format!("unknown session id: {id}"))
}

/// 구조 변이 단일 진입점 — 커맨드 bus. 성공 시 `state-changed` 로 새 스냅샷을
/// emit + 저장 예약하고(`publish_state`) `CommandOutput` 을 돌려준다 (dev 훅·
/// MCP 가 생성 id 를 후속 조작에 쓴다). 실패(`CommandError`)는 상태 불변이
/// 보장되므로 emit 도 저장도 하지 않는다.
#[tauri::command]
pub async fn dispatch(
    app: AppHandle,
    state: State<'_, AppState>,
    cmd: Command,
) -> Result<CommandOutput, CommandError> {
    // 활동 신호용 판별 — cmd 는 아래 클로저로 move 되므로 먼저 본다.
    let is_workspace_switch = matches!(cmd, Command::SwitchWorkspace { .. });
    // 새 워크스페이스의 distro 도 먼저 복사해 둔다 (성공 후 프로비저닝 대상).
    // 부팅 때 없던 distro 가 이 경로로만 들어오므로 여기가 두 번째 호출 지점이다.
    let created_distro = match &cmd {
        Command::CreateWorkspace { distro, .. } => Some(distro.clone()),
        _ => None,
    };
    let provision_app = app.clone();
    // 전체를 spawn_blocking 에서: CreateTab 의 셸 스폰(프로세스 생성 — 수십 ms
    // 블로킹)이 Dispatcher lock 아래에서 일어난다 (계획 0-3 — 핫패스와 무간섭
    // 이라 수용). 메인(이벤트 루프) 스레드는 잡지 않는다.
    let dispatcher = Arc::clone(&state.dispatcher);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut d = dispatcher.lock().unwrap();
        let out = d.dispatch(cmd)?;
        // emit + 저장 예약은 lock 안에서 — revision 과 상태가 일관된 스냅샷만
        // 나가고, 같은 상태가 디스크 저장으로도 예약된다.
        publish_state(&app, &d);
        Ok(out)
    })
    .await
    // join 실패 = 위 클로저의 패닉(락 poison 등 프로그램 결함) — 가려서 ok 로
    // 만들지 않고 그대로 크게 터뜨린다.
    .expect("dispatch task panicked");
    // 성공한 dispatch 는 실제 사용자 활동이다 (UI·dev 훅 발) — 계획 16단계 C-2.
    // SwitchWorkspace 성공은 추가로 pending 워치독의 "안전한 순간" 신호.
    if result.is_ok() {
        state.reset.user_input("dispatch");
        if is_workspace_switch {
            state.reset.workspace_switch();
        }
        // 워크스페이스가 실제로 생겼을 때만 — 이미 프로비저닝한 distro(부팅 때
        // 건 것 포함)는 `ensure_provisioned` 의 프로세스 수명 캐시가 걸러 낸다.
        if let Some(distro) = created_distro {
            crate::provision::ensure_provisioned(&provision_app, distro.as_deref());
        }
    }
    result
}

/// 셸이 없는 탭에 셸을 다시 띄운다 — `NotStarted`(시작 못 함)와 `Exited`(죽음) 양쪽이
/// 대상이고, pane 배너의 Retry / Restart 버튼이 이 커맨드를 부른다 (적격성 계약은
/// `Dispatcher::respawn_tab` rustdoc).
///
/// **성공·실패 어느 쪽이든 publish 한다.** `dispatch` 의 "실패 = 상태 불변" 계약과 달리
/// `Dispatcher::respawn_tab` 은 스폰이 실패하면 그 탭을 강등하고 revision 을 올리므로,
/// 성공 시에만 publish 하면 실패한 재시도가 화면에 닿지 않는다 (부팅 복원 경로인
/// `main.rs` 가 무조건 publish 하는 것과 같은 규율).
#[tauri::command]
pub async fn respawn_tab(
    app: AppHandle,
    state: State<'_, AppState>,
    tab: u64,
) -> Result<SessionId, CommandError> {
    let dispatcher = Arc::clone(&state.dispatcher);
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = dispatcher.lock().unwrap();
        let result = d.respawn_tab(TabId(tab));
        publish_state(&app, &d);
        result
    })
    .await
    .expect("respawn_tab task panicked")
}

/// 현재 상태 스냅샷 (`{ revision, state }`) — 부팅·재동기화용.
/// async 인 이유: dispatch(spawn_blocking)가 스폰 수십 ms 동안 Dispatcher lock 을
/// 쥘 수 있는데, sync 커맨드로 메인 스레드에서 그 lock 을 기다리면 뒤에 줄 선
/// sync 핫패스(ack_output)까지 지연이 전파된다 (리뷰 finding).
#[tauri::command]
pub async fn get_state(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let dispatcher = Arc::clone(&state.dispatcher);
    tauri::async_runtime::spawn_blocking(move || {
        let d = dispatcher.lock().unwrap();
        // 순수 데이터 직렬화라 실패는 프로그램 결함뿐 — 가리지 않고 패닉.
        serde_json::to_value(d.snapshot()).expect("state snapshot must serialize")
    })
    .await
    .map_err(|err| format!("get_state task join failed: {err}"))
}

/// 터미널 출력 스트림 접속(재접속). raw body
/// `[u64 LE end_offset][u8 first_attach][replay bytes]` 를 돌려주고, 이후 출력은
/// `on_output` 채널로 `[u64 LE offset][bytes]` 프레임이 흐른다. Dispatcher lock
/// 불필요 (핫패스).
///
/// `first_attach` (1 = 이 세션의 최초 attach): 프론트가 replay 속 단말 질의에
/// 대한 xterm 자동 응답을 허용할지 판정한다 — 최초 attach 의 질의는 아직 응답이
/// 안 간 라이브 질의(억제 시 conhost 가 CPR 대기로 셸이 멈춤), 재-attach 의
/// 질의는 이미 응답된 낡은 질의(재응답 시 stray `R`)다. `TerminalSink::mark_attached`
/// rustdoc 참조.
///
/// **순서 불변식**: 채널을 sink 슬롯에 먼저 장착하고 그 다음 `reattach()` —
/// 순서를 바꾸면 그 사이 출력이 스냅샷에도 채널에도 없는 유실 창이 생긴다
/// (`PtySession::reattach` rustdoc). 겹침은 프론트가 `offset < end_offset` 폐기로
/// dedup 하되 폐기분 포함 전량 ack 한다.
#[tauri::command]
pub fn attach_terminal(
    state: State<'_, AppState>,
    session: SessionId,
    on_output: Channel<InvokeResponseBody>,
) -> Result<Response, String> {
    let sink = state
        .sinks
        .get(session)
        .ok_or_else(|| format!("unknown session id: {session}"))?;
    let handle = self::session(&state, session)?;
    let first_attach = !sink.mark_attached();
    // 1) 채널 먼저 장착 —
    sink.attach(on_output);
    // 2) — 그 다음 reattach (flow 리셋 + 일관 스냅샷).
    let (end_offset, replay) = handle.reattach();
    let mut body = Vec::with_capacity(9 + replay.len());
    body.extend_from_slice(&end_offset.to_le_bytes());
    body.push(u8::from(first_attach));
    body.extend_from_slice(&replay);
    Ok(Response::new(body))
}

/// 출력 채널 분리 — 뷰 dispose 시, 그리고 부트 리컨실 스윕(attach 하지 않는 전
/// 터미널 세션 대상 — 프론트 배선은 12단계 청크 C)에서 호출된다. 채널 분리 후 이후
/// 출력은 Dropped(detach 모드)로 보상 롤백된다 (`TerminalSink::detach` rustdoc).
/// 이어서 `reset_flow()` 로 flow 계정까지 리셋한다 (계획 D4 자동 치유) — 이미
/// paused 인 세션은 리더가 read 를 안 해 Dropped 롤백 경로 자체가 실행되지
/// 않으므로, detach 시점에 리셋해야 detach 된 세션이 어떤 경로로든 paused 에
/// 고착되지 않는다. 미지 id 는 무해한 no-op (이미 닫힌 세션의 늦은 dispose 가
/// 정상 순서로 도착할 수 있고, 스윕은 멱등해야 한다).
#[tauri::command]
pub fn detach_terminal(state: State<'_, AppState>, session: SessionId) {
    if let Some(sink) = state.sinks.get(session) {
        sink.detach();
    }
    if let Some(handle) = state.sessions.get(session) {
        handle.reset_flow();
    }
}

#[tauri::command]
pub async fn write_stdin(
    state: State<'_, AppState>,
    id: SessionId,
    data: String,
) -> Result<(), String> {
    // paused 상태에서 자식이 stdin 을 읽지 않으면 write 가 블록될 수 있다 —
    // 메인 스레드가 잡히면 ack_output 도 못 돌아 영구 교착이므로 blocking 풀로.
    let session = session(&state, id)?;
    tauri::async_runtime::spawn_blocking(move || session.write(data.as_bytes()))
        .await
        .map_err(|err| format!("write task join failed (id={id}): {err}"))?
        .map_err(|err| format!("write_stdin failed (id={id}): {err:#}"))
    // 주의: stdin 기록은 활동 신호로 치지 **않는다** (16단계 리뷰 finding).
    // xterm 의 onData 는 사용자 타이핑뿐 아니라 단말 질의(DA·DSR·OSC 색상 질의)에
    // 대한 **자동 응답**에도 발화하고, 그 질의는 replay 에 보존돼 리셋 후 재생된다
    // — 여기서 활동으로 집계하면 리셋 → replay → 자동 응답 → idle 재무장의
    // 자기루프가 된다. 실제 타이핑은 프론트 활동 핑(window capture keydown)이
    // 이미 잡으므로 유실도 없다.
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
    // write_stdin 과 동일하게 활동 신호로 치지 않는다 (자동 응답 자기루프 —
    // write_stdin 의 주석 참조).
}

#[tauri::command]
pub async fn resize(
    state: State<'_, AppState>,
    id: SessionId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // ConPTY resize 는 conhost 채널 경유라 이론상 블록 가능 — write 와 같은 경로.
    let session = session(&state, id)?;
    tauri::async_runtime::spawn_blocking(move || session.resize(cols, rows))
        .await
        .map_err(|err| format!("resize task join failed (id={id}): {err}"))?
        .map_err(|err| format!("resize failed (id={id}): {err:#}"))
}

#[tauri::command]
pub fn ack_output(state: State<'_, AppState>, id: SessionId, n: usize) -> Result<(), String> {
    // ack 는 뮤텍스 갱신 + condvar notify 뿐 — sync 즉시 처리해 paused 세션이
    // 최대한 빨리 재개되게 한다.
    let session = session(&state, id)?;
    session.ack(n);
    Ok(())
}

/// 프론트 활동 핑 (계획 16단계 C-2/C-3) — throttled 사용자 입력 신호
/// (wheel/mousedown/keydown, 10초당 1회) + `document.visibilitychange` 보조 신호.
/// `visible` 이 Some 이면 visibility 전이도 함께 반영한다. 순수 열람(스크롤백
/// wheel)도 여기로 잡혀 "활성 사용 중 절대 리셋 금지"가 성립한다 (ADR-0016 결정 8).
#[tauri::command]
pub fn user_activity(state: State<'_, AppState>, visible: Option<bool>) {
    match visible {
        // visibility 전이 보고는 **활동이 아니다** (체크포인트 1 버그 4·5).
        // 활동으로 집계하면: 최소화 보고(visible=false)가 hidden 카운트다운을
        // 스스로 재무장해 hidden 리셋이 영원히 발화하지 못하고, 리로드 직후의
        // visible=true 동기화는 idle 을 재무장해 30초 주기 재발화 루프가 된다.
        // 최소화 클릭 같은 실제 제스처는 그 직전의 mousedown 핑이 이미 잡는다.
        Some(visible) => state.reset.visibility(visible),
        None => state.reset.user_input("ping"),
    }
}

// ---------------------------------------------------------------------------
// UI 설정 (`settings.json`)
//
// 설정 **UI 는 없다** — 사용자가 앱 설정 디렉터리의 `settings.json` 을 직접 쓰고
// 앱을 재시작한다 (v0.3.1 범위). 그래서 이 커맨드는 부팅 때 한 번 불린다.
// ---------------------------------------------------------------------------

/// 설정 파일에서 오는 프론트 UI 설정 — 터미널 폰트와 뷰어 하이라이트 언어 목록.
///
/// 필드는 전부 `Option` 이고 **None = 미설정**(프론트의 기존 하드코딩 기본값을
/// 그대로 쓴다)이다. serde 는 camelCase 로 읽고 쓴다 — 사용자가 손으로 쓰는
/// 파일의 키(`fontFamily`/`fontSize`/`highlightLanguages`)와 프론트 미러 타입
/// (`backend.ts` 의 `UiSettings`)이 같은 이름이어야 하기 때문이다.
///
/// `deny_unknown_fields` 는 **일부러 걸지 않는다** — 뒤 버전이 넣을 키가 든
/// 파일을 옛 빌드가 통째로 거부하면 폰트까지 같이 죽는다 (전방 호환).
#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSettings {
    /// xterm `fontFamily` — CSS font-family 문자열 그대로.
    pub font_family: Option<String>,
    /// xterm `fontSize` (px). [`FONT_SIZE_RANGE`] 밖이면 에러다.
    pub font_size: Option<u16>,
    /// 텍스트 뷰어에서 구문 하이라이팅을 켤 언어 이름. [`HIGHLIGHT_LANGUAGES`]
    /// 밖의 이름이 하나라도 있으면 에러이고, **빈 배열은 "끄기"** 로 유효하다.
    pub highlight_languages: Option<Vec<String>>,
    /// 런타임 로그 파일(`mast.log`)을 켤지. 미설정·`false` 면 꺼진 것이고, 그때는
    /// 파일도 열지 않고 쓰기 스레드도 뜨지 않는다 ([`crate::logfile`]). 켠 뒤에는
    /// 앱을 다시 시작해야 한다 — 부팅 때 한 번만 읽는다.
    pub log: Option<bool>,
    /// 원격 표면(LAN 폴링, [`crate::remote`]). **키가 있으면 켜짐**이고 없으면
    /// 리스너도 스레드도 토큰 파일도 생기지 않는다. `log` 와 같은 규율으로 부팅 때
    /// 한 번만 읽으므로 바꾼 뒤에는 앱을 다시 시작해야 한다.
    pub remote: Option<RemoteSettings>,
}

/// `settings.json` 의 `remote` 객체.
///
/// `port` 를 `Option` 으로 두지 않는 것이 계약이다 — 빠지면 serde 가 "missing field"
/// 로 파일 전체의 파싱을 실패시켜 사용자가 상태 라인에서 이유를 본다. 기본 포트를
/// 몰래 채우면 사용자가 쓰지 않은 포트가 LAN 에 열린다.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettings {
    /// 바인드할 TCP 포트. [`REMOTE_PORT_RANGE`] 밖이면 에러다.
    pub port: u16,
}

/// 허용 폰트 크기(px). 밖의 값은 조용히 조정하지 않고 **거부**한다 — 0 이나 5000
/// 이 들어간 파일을 말없이 고쳐 쓰면 사용자는 자기가 쓴 값이 먹은 줄 안다.
const FONT_SIZE_RANGE: std::ops::RangeInclusive<u16> = 6..=72;

/// 허용 원격 포트. 1024 미만은 Windows 에서도 관리자 권한이 필요한 well-known 대역이라
/// 실수로 쓰면 바인드가 통째로 실패한다.
const REMOTE_PORT_RANGE: std::ops::RangeInclusive<u16> = 1024..=65535;

/// 구문 하이라이팅을 지원하는 언어 이름. 프론트가 언어당 하나씩 lazy-load 하는
/// hljs 모듈 목록(`apps/mast/src/text-view.ts` 의 `LANGUAGE_LOADERS`)과 **같은
/// 목록이어야 한다** — 여기만 넓히면 로드할 모듈이 없는 이름이 통과한다.
const HIGHLIGHT_LANGUAGES: [&str; 8] = [
    "css",
    "html",
    "javascript",
    "json",
    "python",
    "rust",
    "toml",
    "typescript",
];

/// 앱 설정 디렉터리(`%AppData%\app.mast.desktop`)의 `settings.json` 을 읽는다.
///
/// - 파일 없음 → `Ok(기본값)`. 설정을 쓴 적 없는 것이 정상 상태다.
/// - 파싱 실패·범위 밖 값 → `Err(사유)`. **가라 기본값으로 가리지 않는다** —
///   프론트가 상태 라인에 사유를 띄우고 기본 폰트로 진행하므로, 사용자는 자기
///   파일이 안 먹었다는 사실과 이유를 함께 본다.
///
/// sync 커맨드인 이유: 앱 설정 디렉터리는 Windows 로컬 디스크라(뷰어의 9P 경로와
/// 다르다) 작은 파일 읽기 한 번이고, 호출도 부팅당 1회다.
#[tauri::command]
pub fn get_ui_settings(app: AppHandle) -> Result<UiSettings, String> {
    read_ui_settings(&app)
}

/// [`get_ui_settings`] 의 알맹이 — 커맨드가 아닌 호출자도 쓴다. 부팅 시
/// [`crate::logfile::init`] 이 `log` 플래그를 보려고 프론트보다 먼저 부른다
/// (프론트의 `get_ui_settings` 는 webview 가 뜬 뒤라 너무 늦다).
pub(crate) fn read_ui_settings(app: &AppHandle) -> Result<UiSettings, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("cannot resolve the app config dir: {err}"))?;
    let path = dir.join("settings.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(UiSettings::default());
        }
        Err(err) => return Err(format!("cannot read {}: {err}", path.display())),
    };
    let settings: UiSettings = serde_json::from_str(&text)
        .map_err(|err| format!("cannot parse {}: {err}", path.display()))?;
    if let Some(size) = settings.font_size {
        if !FONT_SIZE_RANGE.contains(&size) {
            return Err(format!(
                "fontSize {size} in {} is out of range ({}-{})",
                path.display(),
                FONT_SIZE_RANGE.start(),
                FONT_SIZE_RANGE.end()
            ));
        }
    }
    if let Some(remote) = &settings.remote {
        if !REMOTE_PORT_RANGE.contains(&remote.port) {
            return Err(format!(
                "remote.port {} in {} is out of range ({}-{})",
                remote.port,
                path.display(),
                REMOTE_PORT_RANGE.start(),
                REMOTE_PORT_RANGE.end()
            ));
        }
    }
    // fontSize 와 같은 loud-fail 대칭 (리뷰 finding): 공백뿐인 fontFamily 를 조용히
    // 넘기면 xterm 등폭 렌더가 깨진 채 원인이 숨는다.
    if let Some(family) = &settings.font_family {
        if family.trim().is_empty() {
            return Err(format!("fontFamily in {} must not be blank", path.display()));
        }
    }
    // 같은 loud-fail 규율: 오타 난 언어 이름("pyton")을 조용히 무시하면 사용자는
    // 그 파일만 색이 안 붙는 이유를 영영 알 수 없다. 지원 목록을 같이 알려 준다.
    if let Some(languages) = &settings.highlight_languages {
        if let Some(unknown) = languages
            .iter()
            .find(|name| !HIGHLIGHT_LANGUAGES.contains(&name.as_str()))
        {
            return Err(format!(
                "highlightLanguages in {} has an unsupported language {unknown:?} (supported: {})",
                path.display(),
                HIGHLIGHT_LANGUAGES.join(", ")
            ));
        }
    }
    Ok(settings)
}

/// 프론트엔드가 런타임 로그 파일에 한 줄 남긴다 — 로그가 켜져 있을 때만이고,
/// 꺼져 있으면 이 커맨드 자체가 no-op 이다 (프론트도 꺼져 있으면 부르지 않는다).
///
/// **이 창구가 있는 이유**: 2026-08-22 한글 IME 조합이 풀리지 않던 건처럼 전부
/// WebView 안에서 벌어지는 문제는 글루 로그로는 한 줄도 안 잡힌다.
///
/// 길이를 자르는 것은 방어다 — 프론트의 버그 하나가 루프에서 부르면 로그가 그
/// 내용으로만 차 정작 필요한 줄이 회전으로 밀려난다. 자를 때는 잘랐다는 사실을
/// 남긴다 (조용히 잘라 내면 읽는 사람이 원문으로 오독한다).
#[tauri::command]
pub fn log_line(text: String) {
    if !crate::logfile::enabled() {
        return;
    }
    let line = if text.len() > crate::logfile::MAX_LINE_BYTES {
        let mut cut = crate::logfile::MAX_LINE_BYTES;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}… (truncated)", &text[..cut])
    } else {
        text
    };
    crate::logfile::write(line);
}

/// 수동 WebView 리셋 — **dev 훅(`window.__mast.resetUi`)·향후 MCP 전용이며 UI
/// 버튼으로 노출하지 않는다** (계획 v2 12장 원칙). 코어 Command bus 는 구조 변이
/// 전용(ADR-0002)이고 리셋은 상태 무변이·Tauri 의존 동작이라 글루 커맨드로 둔다
/// (ADR-0016 결정 8의 의도적 이탈 — ADR 증류 시 기록).
#[tauri::command]
pub fn reset_ui(state: State<'_, AppState>) {
    state.reset.reset_now();
}

/// 토스트 진단 로그 파일 — 앱 데이터 디렉터리(`%APPDATA%\app.mast.desktop`)의
/// `toast.log`. 다음 필드 라운드에서 "토스트가 안 보였다"를 앱 밖에서 판별하기 위한
/// 창구다: 시도 자체가 없었는지(줄이 없다), 발송은 했는데 화면에 안 떴는지(`ok`),
/// WinRT 가 거부했는지(`err` + 사유)가 파일 하나로 갈린다.
#[cfg(windows)]
const TOAST_LOG_FILE: &str = "toast.log";

/// 토스트 로그 크기 상한 (64 KiB). 넘으면 잘라 내고 새로 시작한다 — 진단에 필요한
/// 건 최근 몇 줄이고, 상시 도는 앱의 로그가 무한히 자라면 안 된다.
#[cfg(windows)]
const TOAST_LOG_MAX_BYTES: u64 = 64 * 1024;

/// needsInput OS 토스트 (백로그 2026-08-11, v0.3.7 재작성) — WinRT 토스트를 **직접**
/// 띄운다.
///
/// v0.3.6 까지는 `tauri-plugin-notification` 을 거쳤는데, 그 플러그인이 발송을
/// `tauri::async_runtime::spawn(async move { let _ = notification.show(); })`
/// (2.3.3 `desktop.rs:216`) 로 던져 **오류를 통째로 삼켰다** — 실기에서 토스트가 안
/// 뜨는데 앱은 성공만 보고하는 상태라 원인 구간을 좁힐 수 없었다. 그래서 층을
/// 걷어내고 `Toast::show()` 의 결과를 그대로 들고 온다.
///
/// 발신 AUMID 는 [`crate::app_identity::APP_USER_MODEL_ID`] — 셸에 **등록하는 값과
/// 같은 상수 하나**다 (v0.3.6 의 "플러그인이 무엇을 싣는가" 추론 사슬이 사라졌다).
///
/// **언제 부를지는 전적으로 프론트 계약이다**: `main.ts` 의 `notifyNeedsInput` 이
/// needsInput 상승 전이(`chime.ts::detectNeedsInputOnset` 의 `onsets`) 중
/// `chime.ts::needsInputToastTargets` 가 남긴 것만 부른다 — 창이 포커스이고 그
/// 워크스페이스가 활성일 때(=이미 화면에 보인다)만 조용하고, 비포커스거나 다른
/// 워크스페이스면 띄운다. 여기서 포커스를 다시 판정하지 않는 이유는 판정을 두 곳에
/// 두면 두 사실이 어긋나기 때문이다 — 프론트가 쓰는 포커스도 결국 이 프로세스가
/// 보낸 OS 신호(`main.rs` `window-focus`)다.
///
/// 실패는 ① `toast.log` 에 한 줄, ② `Err(사유)` 로 프론트(console.debug) — 두 곳
/// 모두에 남긴다. 삼키지 않되 UI 동작을 막지도 않는다. 상태도 Dispatcher lock 도
/// 타지 않고, 호출 빈도가 전이당 1회라 sync 커맨드로 둔다 (sync 커맨드는 메인
/// 스레드에서 도는데, WinRT 호출에는 그게 오히려 안전하다 — 웹뷰가 이미 초기화해 둔
/// COM 아파트가 그 스레드에 있다).
#[cfg(windows)]
#[tauri::command]
pub fn notify_toast(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let result = tauri_winrt_notification::Toast::new(crate::app_identity::APP_USER_MODEL_ID)
        .title(&title)
        .text1(&body)
        .show()
        .map_err(|err| format!("cannot show the toast: {err}"));
    log_toast_attempt(&app, &title, &result);
    result
}

/// unix(개발 실행)에는 띄울 WinRT 토스트가 없다 — 조용한 성공으로 가리지 않고
/// 명시적으로 실패한다 (`pick_workspace_folder` 의 cfg 분기와 같은 규율).
#[cfg(not(windows))]
#[tauri::command]
pub fn notify_toast(title: String, body: String) -> Result<(), String> {
    Err(format!("toasts are Windows-only (dropped: {title} / {body})"))
}

/// 토스트 시도를 [`TOAST_LOG_FILE`] 에 한 줄 append 한다 — **베스트에포트**다.
/// 로그를 못 남기는 것 자체는 알림 동작과 무관하므로 어떤 실패도 조용히 포기한다
/// (여기서 다시 Err 를 만들면 진단 장치가 진단 대상을 가린다).
///
/// 본문(에이전트 마지막 메시지)은 **일부러 남기지 않는다** — 어느 워크스페이스에
/// 무슨 결과로 시도했는지가 진단에 필요한 전부이고, 대화 내용을 디스크에 쌓을
/// 이유는 없다. 제목의 줄바꿈은 공백으로 눕혀 "시도 1건 = 1줄"을 지킨다.
#[cfg(windows)]
fn log_toast_attempt(app: &AppHandle, title: &str, result: &Result<(), String>) {
    use std::io::Write;

    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(TOAST_LOG_FILE);
    // 상한을 넘었으면 append 대신 truncate 로 연다 (회전 파일을 따로 두지 않는다 —
    // 최근 이력만 있으면 되는 진단 로그다).
    let rotate = std::fs::metadata(&path).is_ok_and(|meta| meta.len() > TOAST_LOG_MAX_BYTES);
    let mut options = std::fs::OpenOptions::new();
    options.create(true);
    if rotate {
        options.write(true).truncate(true);
    } else {
        options.append(true);
    }
    let Ok(mut file) = options.open(&path) else {
        return;
    };
    let flat_title = title.replace(['\r', '\n'], " ");
    let line = match result {
        Ok(()) => format!("{} ok title=\"{flat_title}\"", local_timestamp()),
        Err(err) => format!("{} err title=\"{flat_title}\": {err}", local_timestamp()),
    };
    let _ = writeln!(file, "{line}");
}

/// 로그용 현지 시각 `YYYY-MM-DD HH:MM:SS`. 사용자가 "몇 시쯤 토스트를 못 봤다"와
/// 대조하는 파일이라 epoch 초로 남기지 않는다.
#[cfg(windows)]
fn local_timestamp() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;

    // SAFETY: 인자도 포인터도 없는 조회 호출이다 — 채워진 SYSTEMTIME 을 값으로 받는다.
    let now = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond
    )
}

/// `pick_workspace_folder` 응답 — 고른 폴더를 워크스페이스 생성 인자로 편 형태.
/// 필드명은 글루 DTO 관례(serde 기본 snake_case, `DirEntryDto` 전례) 그대로다.
/// 터미널에서 클릭한 URL 을 Windows 기본 브라우저로 넘긴다 (ADR-0012).
///
/// **스킴 검사를 프런트와 여기 양쪽에서 하는 이유**: 이 커맨드는 webview 안의 어떤
/// 코드에서도 부를 수 있으므로 프런트의 판정은 UX 이지 계약이 아니다. `ShellExecute` 는
/// 등록된 프로토콜 핸들러를 전부 열 수 있어서(`file:`·`ms-settings:`·서드파티 스킴),
/// 터미널에 텍스트를 찍을 수 있는 쪽이 그 표면을 겨누지 못하게 마지막 문을 여기서 닫는다.
///
/// 호출은 `spawn_blocking` 에서 돈다 — `ShellExecuteW` 는 COM/셸을 거치므로 이벤트 루프
/// 스레드에서 부를 일이 아니다. Dispatcher lock 은 타지 않는다.
#[cfg(windows)]
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let url = validated_http_url(url)?;
    tauri::async_runtime::spawn_blocking(move || shell_execute(&url))
        .await
        .map_err(|err| format!("open_url task join failed: {err}"))?
}

/// unix(개발 실행)에는 넘길 Windows 셸이 없다 — 가짜로 성공하지 않고 명시적으로 실패한다
/// (`pick_workspace_folder` 와 같은 규율).
#[cfg(not(windows))]
#[tauri::command]
pub async fn open_url(_url: String) -> Result<(), String> {
    Err("opening links is Windows-only".to_owned())
}

/// http/https 만 통과시킨다. 제어문자·공백은 거부한다 — URL 로 쓰일 수 없는 문자이고,
/// 로그·파일 내용에서 잘못 잘려 나온 문자열이 여기까지 오는 것을 막는다. 길이 상한은
/// 브라우저들이 실질적으로 다루는 범위(2048)를 기준으로 둔다.
#[cfg(windows)]
fn validated_http_url(url: String) -> Result<String, String> {
    const MAX_LEN: usize = 2048;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("refusing to open a non-http(s) URL: {url}"));
    }
    if url.len() > MAX_LEN {
        return Err(format!("URL is longer than {MAX_LEN} bytes"));
    }
    // 제어문자·공백에 더해 `"` 와 `\` 도 거부한다. RFC 3986 상 URL 에 그대로 올 수 없는
    // 문자이고, 브라우저 등록 템플릿 중에는 `%1` 을 순진하게 인용하는 것이 있어 인자 주입
    // 표면이 된다 — 잃는 것 없이 닫을 수 있는 문이라 닫는다 (심층방어).
    if url
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '"' || c == '\\')
    {
        return Err("URL contains control, whitespace, quote or backslash characters".to_owned());
    }
    Ok(url)
}

/// `ShellExecuteW` 로 기본 브라우저에 넘긴다. **커맨드라인을 만들지 않는 것이 요점이다**
/// — `cmd /c start <url>` 은 `&` 가 든 URL(OAuth 콜백에 흔하다)에서 인용 지옥이 되고,
/// 그 실수의 대가가 임의 명령 실행이다.
#[cfg(windows)]
fn shell_execute(url: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let verb = HSTRING::from("open");
    let file = HSTRING::from(url);
    // 반환값은 레거시 HINSTANCE 규약이다: **32 초과만 성공**이고 그 이하는 오류 코드다.
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let code = result.0 as usize;
    if code > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecute refused to open the URL (code {code})"))
    }
}

#[derive(serde::Serialize)]
pub struct PickedFolder {
    /// 워크스페이스 `rootPath` 로 그대로 쓰는 리눅스 절대 경로.
    pub linux_path: String,
    /// `\\wsl.localhost\<distro>\...` 를 골랐을 때의 배포판 이름. 드라이브 경로
    /// (`C:\...` → `/mnt/c/...`)는 배포판을 알 수 없어 None 이고, 그때는 기존
    /// 기본값 해석(워크스페이스 distro 미지정 → MAST_DISTRO → wsl 기본)을 탄다.
    pub distro: Option<String>,
    /// 워크스페이스 이름 기본값 — 고른 폴더의 마지막 세그먼트.
    pub name: String,
}

/// 워크스페이스 폴더 선택 (Windows 네이티브 대화상자). 취소는 `Ok(None)` —
/// 에러가 아니다. 선택된 Windows 경로는 `wslpath::from_windows_path` 로 리눅스
/// 경로 + 배포판으로 되돌리고, 되돌릴 수 없는 경로(네트워크 UNC 등)는 그 사유를
/// 그대로 Err 로 올린다 (프론트가 상태 라인에 표시).
///
/// 대화상자는 블로킹 모달이라 통째로 `spawn_blocking` 에서 돈다 — 메인(이벤트
/// 루프) 스레드를 잡으면 대화상자가 떠 있는 동안 앱 전체가 멈춘다. Dispatcher
/// lock 은 타지 않는다 (선택 결과로 CreateWorkspace 를 보내는 것은 프론트 몫).
#[cfg(windows)]
#[tauri::command]
pub async fn pick_workspace_folder() -> Result<Option<PickedFolder>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Select a workspace folder")
            .pick_folder()
    })
    .await
    .map_err(|err| format!("pick_workspace_folder task join failed: {err}"))?;
    let Some(picked) = picked else {
        return Ok(None); // 사용자 취소 — 조용한 no-op
    };
    // 비 UTF-8 Windows 경로는 코어 경로 계약(String)에 실을 수 없다 — 조용히
    // lossy 변환해 다른 폴더를 가리키게 두지 않고 거부한다.
    let path = picked
        .to_str()
        .ok_or_else(|| format!("selected path is not valid UTF-8: {}", picked.display()))?;
    let (distro, linux_path) = wslpath::from_windows_path(path)?;
    // Windows 드라이브 픽(UNC 가 아닌 경로 → distro None → /mnt/<d>/...)은 워크
    // 스페이스 루트가 될 수 없다 (사용자 결정 2026-08-11 — 코어 CreateWorkspace
    // 도 /mnt 를 거부하지만, 여기서 잡아야 문구가 픽커 상황에 맞는다). 드라이브
    // 데이터는 뷰어(폴더 브라우저)로 접근한다.
    if distro.is_none() {
        return Err(format!(
            "Windows drives cannot host a workspace (data-only; browse them with the folder \
             viewer instead) — pick a folder under \\\\wsl.localhost\\<distro>\\...: {path}"
        ));
    }
    Ok(Some(PickedFolder {
        name: folder_name(&linux_path, distro.as_deref()),
        linux_path,
        distro,
    }))
}

/// unix(개발 실행)에는 띄울 네이티브 대화상자가 없다 — 조용한 no-op 이나 가짜
/// 경로로 가리지 않고 명시적으로 실패한다 (`host.rs`·`host_path` 의 cfg 분기와
/// 같은 규율: Windows 전용 기능은 dev 경로에서 loud 하게 없음을 알린다).
#[cfg(not(windows))]
#[tauri::command]
pub async fn pick_workspace_folder() -> Result<Option<PickedFolder>, String> {
    Err("folder picker is Windows-only".to_owned())
}

/// 리눅스 경로의 마지막 세그먼트 (빈 세그먼트는 건너뛴다) — 코어의 탭 제목
/// 규칙(`command.rs::path_title`)과 같은 계산이되, distro 루트("/") 픽의 퇴화만
/// 보정한다 (리뷰 finding): `"/"` 대신 distro 이름이 워크스페이스 이름으로
/// 자연스럽다. (드라이브 루트 보정은 드라이브 픽 자체가 거부되면서 제거됐다.)
#[cfg(windows)]
fn folder_name(linux_path: &str, distro: Option<&str>) -> String {
    if linux_path == "/" {
        if let Some(d) = distro {
            return d.to_owned();
        }
    }
    linux_path
        .rsplit('/')
        .find(|component| !component.is_empty())
        .unwrap_or("/")
        .to_owned()
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> Vec<SessionStatsDto> {
    // 코어 `stats()` 가 레지스트리 lock 을 놓은 채 세션별 stats 를 뜨고 id
    // 오름차순 (id, stats) 쌍을 돌려준다.
    state
        .sessions
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

// ---------------------------------------------------------------------------
// 뷰어 파일 접근 (21단계 계획 glue 계약)
//
// folderBrowser·textViewer 가 쓰는 읽기 전용 커맨드 3종. Windows 에서는
// `\\wsl.localhost\<distro>\...` UNC 로 접근한다 — Windows→WSL 방향이라 interop 을
// 잠근 배포판에서도 동작한다 (계획 v2 5장). 경로 형태 검증·UNC 조립은 순수 함수
// (`mast_core::wslpath`)에 있고 테스트도 거기 있다 — 게이트가 `-p mast-core` 만
// 돌기 때문이다.
//
// **이 3종의 실동작 검증은 UNC·9P 가 필요해 Linux 게이트로는 불가능하다 —
// 체크포인트 2 사용자 체크리스트로 이월하는 것이 계획 명문이다** (21단계 계획
// "완료 기준" 3·6·9·12번 항목).
// ---------------------------------------------------------------------------

/// `fs_list_dir` 한 번이 돌려주는 최대 항목 수. 9P 는 대형 디렉터리에서 느리고
/// 프론트도 이 이상을 한 번에 그리지 않는다 — 넘치면 잘라내고 `truncated` 로
/// 알린다 (계획 리스크 [med] 완화).
const MAX_DIR_ENTRIES: usize = 5_000;

/// `fs_read_chunk` 한 번의 최대 길이 (4 MiB). textViewer 의 윈도우는 512KiB 라
/// 통상 한참 아래고, 이 상한은 프론트 결함이 IPC 로 거대 버퍼를 요구하는 것을
/// 막는다.
const MAX_READ_LEN: u32 = 4 * 1024 * 1024;

/// `fs_list_dir` 응답. **정렬하지 않는다** — dirs-first·name asc 정렬은 프론트
/// 순수 함수(vitest 대상)의 몫이다 (계획 프론트 계약).
#[derive(serde::Serialize)]
pub struct DirListing {
    pub entries: Vec<DirEntryDto>,
    /// 상한(`MAX_DIR_ENTRIES`) 초과로 목록을 잘랐다 — 프론트가 배너로 알린다.
    pub truncated: bool,
}

/// 디렉터리 항목 하나. 필드명은 serde 기본(snake_case) 그대로 나간다 — 글루 DTO
/// 는 `SessionStatsDto` 전례를 따르고 계획의 glue 계약도 이 이름으로 적혀 있다
/// (코어 모델의 camelCase 는 코어 타입 쪽 rename 계약이라 별개다). 타입 이름만
/// `std::fs::DirEntry` 와 겹치지 않게 `Dto` 접미사를 붙였다.
#[derive(serde::Serialize)]
pub struct DirEntryDto {
    pub name: String,
    pub is_dir: bool,
    /// 디렉터리이거나 항목 metadata 조회가 실패하면 None.
    pub size: Option<u64>,
}

/// `fs_stat` 응답 — 링크는 따라간 뒤의 **최종 대상** 기준이다.
#[derive(serde::Serialize)]
pub struct FileStat {
    pub size: u64,
    pub mtime_ms: u64,
    pub is_dir: bool,
}

/// 뷰어 디렉터리 목록 (folderBrowser).
#[tauri::command]
pub async fn fs_list_dir(distro: Option<String>, path: String) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 경로 해석도 블로킹이다 — Windows 경로는 distro 질의(wsl.exe 스폰)를
        // 유발할 수 있어 해석까지 이 안에서 한다.
        let root = host_path(distro, &path)?;
        list_dir(&root)
    })
    .await
    .map_err(|err| format!("fs_list_dir task join failed: {err}"))?
}

/// 파일 크기·수정시각 조회 (textViewer 윈도우 계산, 청크 D 의 mtime 폴링).
#[tauri::command]
pub async fn fs_stat(distro: Option<String>, path: String) -> Result<FileStat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = host_path(distro, &path)?;
        // `metadata` 는 링크를 따라간다 — 뷰어가 알고 싶은 것은 최종 대상이다.
        let meta = std::fs::metadata(&target)
            .map_err(|err| format!("cannot stat {}: {err}", target.display()))?;
        let modified = meta
            .modified()
            .map_err(|err| format!("cannot read mtime of {}: {err}", target.display()))?;
        // 라이브 리로드의 판정 기준값이라 조회 실패를 조용한 0 으로 대체하지
        // 않는다 (epoch 이전 시각도 이 용도에선 의미가 없어 그대로 에러).
        let since_epoch = modified.duration_since(UNIX_EPOCH).map_err(|err| {
            format!(
                "mtime of {} is before the unix epoch: {err}",
                target.display()
            )
        })?;
        Ok(FileStat {
            size: meta.len(),
            // u128 → u64 는 포화시킨다 (실재하지 않는 범위지만 조용한 절단 금지).
            mtime_ms: u64::try_from(since_epoch.as_millis()).unwrap_or(u64::MAX),
            is_dir: meta.is_dir(),
        })
    })
    .await
    .map_err(|err| format!("fs_stat task join failed: {err}"))?
}

/// 파일의 바이트 윈도우 읽기 (textViewer). 응답은 **raw 바이트** —
/// `attach_terminal` 과 같은 `tauri::ipc::Response` 경로라 base64 왕복이 없다.
/// UTF-8 파단·부분행 절삭은 프론트 몫이다 (계획 프론트 계약).
///
/// `len` 상한 초과는 조용히 줄이지 않고 **거부**한다 — 요청한 크기와 다른 윈도우가
/// 돌아가면 프론트의 오프셋 계산이 어긋난다. EOF 를 넘는 `offset` 은 빈 응답이며
/// 에러가 아니다 (파일이 그새 줄어든 경우 — 프론트가 윈도우를 되감는다).
#[tauri::command]
pub async fn fs_read_chunk(
    distro: Option<String>,
    path: String,
    offset: u64,
    len: u32,
) -> Result<Response, String> {
    if len > MAX_READ_LEN {
        return Err(format!(
            "fs_read_chunk len {len} exceeds the {MAX_READ_LEN} byte limit"
        ));
    }
    let bytes =
        tauri::async_runtime::spawn_blocking(move || read_chunk(distro, &path, offset, len))
            .await
            .map_err(|err| format!("fs_read_chunk task join failed: {err}"))??;
    Ok(Response::new(bytes))
}

/// 블로킹 디렉터리 열거 — fs 순서 그대로, 상한 초과분은 잘라낸다.
fn list_dir(root: &Path) -> Result<DirListing, String> {
    let iter =
        std::fs::read_dir(root).map_err(|err| format!("cannot list {}: {err}", root.display()))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in iter {
        // 상한 도달 후 **다음 항목이 실재할 때만** truncated 다.
        if entries.len() >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let entry = entry.map_err(|err| format!("cannot list {}: {err}", root.display()))?;
        entries.push(dir_entry(&entry));
    }
    Ok(DirListing { entries, truncated })
}

/// 항목 하나의 표시 정보. 개별 metadata 조회 실패는 그 항목만 "파일·크기 미상"으로
/// 낮춰 담는다 — 9P 에서 항목 하나의 권한·경합 실패가 목록 전체를 죽이지 않게.
fn dir_entry(entry: &std::fs::DirEntry) -> DirEntryDto {
    let name = entry.file_name().to_string_lossy().into_owned();
    // `file_type`·`DirEntry::metadata` 는 링크를 따라가지 않는다. 클릭 동작이
    // 종류로 갈리므로(디렉터리 탐색 vs 파일 열기) 링크일 때만 대상 metadata 를
    // 한 번 더 조회한다 — 링크가 아닌 항목에는 추가 I/O 가 없다.
    let meta = match entry.file_type() {
        Ok(file_type) if file_type.is_symlink() => std::fs::metadata(entry.path()).ok(),
        _ => entry.metadata().ok(),
    };
    match meta {
        Some(meta) if meta.is_dir() => DirEntryDto {
            name,
            is_dir: true,
            size: None,
        },
        Some(meta) => DirEntryDto {
            name,
            is_dir: false,
            size: Some(meta.len()),
        },
        None => DirEntryDto {
            name,
            is_dir: false,
            size: None,
        },
    }
}

/// 블로킹 윈도우 읽기 — `offset` 에서 최대 `len` 바이트.
fn read_chunk(
    distro: Option<String>,
    path: &str,
    offset: u64,
    len: u32,
) -> Result<Vec<u8>, String> {
    let target = host_path(distro, path)?;
    let mut file = std::fs::File::open(&target)
        .map_err(|err| format!("cannot open {}: {err}", target.display()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| format!("cannot seek {} to {offset}: {err}", target.display()))?;
    let mut buf = Vec::new();
    file.take(u64::from(len))
        .read_to_end(&mut buf)
        .map_err(|err| format!("cannot read {}: {err}", target.display()))?;
    Ok(buf)
}

/// 리눅스 경로 → 이 프로세스가 실제로 열 수 있는 호스트 경로.
///
/// Windows 는 `\\wsl.localhost\<distro>\...` UNC 로 조립하고, unix(개발 실행)는
/// 형태 검증만 한 뒤 리눅스 경로를 직접 쓴다 (distro 는 의미가 없다). 스폰 쪽
/// `host.rs::spawn_spec` 의 cfg 분기와 같은 대칭이다.
///
/// 뷰어 읽기 경로와 질의 회신 쓰기 경로(`sink.rs`)가 공유한다 — 같은 distro
/// 해석·같은 UNC 조립을 두 벌 두지 않기 위해서다.
#[cfg(windows)]
pub(crate) fn host_path(distro: Option<String>, path: &str) -> Result<PathBuf, String> {
    let distro = resolve_distro(distro)?;
    Ok(PathBuf::from(wslpath::to_unc(&distro, path)?))
}

#[cfg(not(windows))]
pub(crate) fn host_path(_distro: Option<String>, path: &str) -> Result<PathBuf, String> {
    wslpath::validate_linux_path(path)?;
    Ok(PathBuf::from(path))
}

/// distro 해석 (계획 21단계 핵심 결정): 인자(workspace.distro) → env `MAST_DISTRO`
/// → `wsl.exe -l -q` 기본 배포판 lazy 질의. **셋 다 실패해야** 에러다 — 터미널
/// 스폰(`host.rs`: distro 없으면 wsl.exe 기본값)과 정합을 맞춘 것으로, 둘 다
/// 미설정인 가장 흔한 구성에서 뷰어만 죽는 비대칭을 만들지 않는다. 빈 문자열은
/// 미설정 취급 (`host.rs::spawn_spec` 과 동일).
#[cfg(windows)]
fn resolve_distro(distro: Option<String>) -> Result<String, String> {
    if let Some(distro) = distro.filter(|d| !d.is_empty()) {
        return Ok(distro);
    }
    if let Some(distro) = std::env::var("MAST_DISTRO").ok().filter(|d| !d.is_empty()) {
        return Ok(distro);
    }
    default_distro()
}

/// 기본 배포판 이름을 프로세스 수명 동안 캐시한다 — 파일 접근마다 wsl.exe 를
/// 띄우지 않기 위한 캐시라 **성공만** 담는다. 실패까지 캐시하면 앱을 켠 뒤
/// 배포판을 설치·복구한 사용자가 재시작 전까지 영구히 막힌다. (초기 경합으로
/// 질의가 두 번 나갈 수 있으나 결과는 하나로 수렴한다.)
#[cfg(windows)]
pub(crate) fn default_distro() -> Result<String, String> {
    static DEFAULT_DISTRO: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if let Some(cached) = DEFAULT_DISTRO.get() {
        return Ok(cached.clone());
    }
    let distro = query_default_distro()?;
    Ok(DEFAULT_DISTRO.get_or_init(|| distro).clone())
}

/// `wsl.exe -l -q` 질의. 출력은 **UTF-16LE** 이고(파이프로 리다이렉트해도 그렇다 —
/// 실검증은 체크포인트 2 항목 12), `-l` 은 기본 배포판을 맨 앞에 내므로 디코드 후
/// 첫 비어있지 않은 줄이 답이다. 실패 메시지에는 사용자가 취할 조치를 함께 적는다.
#[cfg(windows)]
fn query_default_distro() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    let output = std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        // 릴리스 빌드는 windows_subsystem="windows" 라 콘솔이 없다 — 이 플래그가
        // 없으면 질의마다 콘솔 창이 깜빡인다.
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|err| {
            format!(
                "cannot run 'wsl.exe -l -q' to find the default distro: {err}; \
                 set workspace distro or MAST_DISTRO"
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "'wsl.exe -l -q' failed ({}): {}; set workspace distro or MAST_DISTRO",
            output.status,
            decode_utf16le(&output.stderr).trim()
        ));
    }
    let listing = decode_utf16le(&output.stdout);
    // BOM(U+FEFF)은 공백류가 아니라 trim 으로 떨어지지 않는다 — 명시적으로 벗긴다.
    listing
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            "'wsl.exe -l -q' listed no distro; set workspace distro or MAST_DISTRO".to_owned()
        })
}

/// UTF-16LE 바이트열 → String. 짝이 안 맞는 마지막 바이트는 버리고, 부적합
/// 서로게이트는 U+FFFD 로 둔다 (진단 문자열 용도라 lossy 로 충분하다).
#[cfg(windows)]
fn decode_utf16le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}
