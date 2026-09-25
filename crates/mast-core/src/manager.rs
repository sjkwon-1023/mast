//! 관리자(preview) 이벤트 링과 관리자 query 계약 — 성공한 변이마다 "어느
//! 워크스페이스·탭에서 무엇이 바뀌었는지"를 순번 붙은 유계 링에 쌓고, OSC 관리자
//! query의 요청·응답·오류 타입을 정의한다.
//!
//! 기록은 [`crate::command::Dispatcher::set_manager_events`] 로 켠 동안에만 일어나고,
//! 꺼져 있으면 기록 지점이 스냅샷조차 만들지 않는다. 조회 동작은
//! [`crate::command::Dispatcher::events_since`]·[`crate::command::Dispatcher::overview`]·
//! [`crate::command::Dispatcher::manager_query`] 가 맡고, 이 모듈은 그 값 타입과
//! 요청 파싱·회신 JSON 조립을 소유한다. 앱(글루)과 하네스 사이의 stdio 줄 단위
//! 메시지 타입도 여기에 있다.
//!
//! 관리자 워크스페이스에 속한 워크스페이스·탭의 이벤트는 기록하지 않는다 (R9) —
//! [`crate::command::Dispatcher`] 의 기록 헬퍼가 거른다.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::model::{AgentSession, AgentStatus, TabId, Workspace};

/// 링이 보관하는 최대 이벤트 수. 넘치면 가장 오래된 것부터 버린다.
pub const MANAGER_EVENT_CAPACITY: usize = 1024;

/// 관리자 query 요청의 **디코드 후** 바이트 상한. 넘으면
/// [`ManagerQueryError::InvalidParams`] 다.
pub const MAX_MANAGER_REQUEST_BYTES: usize = 4 * 1024;

/// 회신 JSON의 바이트 상한. 직렬화 결과가 이 값을 **넘으면** `too_large` 오류로
/// 대체한다.
pub const MAX_MANAGER_REPLY_BYTES: usize = 4 * 1024 * 1024;

/// 이벤트 종류. JSON 은 camelCase 문자열이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentEventKind {
    WorkspaceOpened,
    WorkspaceClosed,
    Status,
    Session,
    TabGone,
}

/// 이벤트 시점의 워크스페이스 요약 — `{id, name, rootPath, distro}`.
/// 워크스페이스가 사라진 뒤(`workspaceClosed`)에도 그 시점 값을 그대로 싣는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkspace {
    pub id: u64,
    pub name: String,
    pub root_path: Option<String>,
    pub distro: Option<String>,
}

impl EventWorkspace {
    pub(crate) fn from_workspace(ws: &Workspace) -> Self {
        Self {
            id: ws.id.0,
            name: ws.name.clone(),
            root_path: ws.root_path.clone(),
            distro: ws.distro.clone(),
        }
    }
}

/// 관리자 이벤트 한 건. 해당 없는 필드도 `null` 로 **항상** 직렬화한다 — 소비자가
/// 필드 존재 여부로 분기하지 않게 하는 계약이다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub seq: u64,
    pub kind: AgentEventKind,
    pub workspace: EventWorkspace,
    pub tab: Option<u64>,
    pub status: Option<AgentStatus>,
    pub message: Option<String>,
    pub agent_session: Option<AgentSession>,
}

impl AgentEvent {
    /// 종류별 필드는 빌더로 채운다. `seq` 는 링이 기록 시점에 채우므로 여기서는 0이다.
    pub(crate) fn new(kind: AgentEventKind, workspace: EventWorkspace) -> Self {
        Self {
            seq: 0,
            kind,
            workspace,
            tab: None,
            status: None,
            message: None,
            agent_session: None,
        }
    }

    pub(crate) fn with_tab(mut self, tab: TabId) -> Self {
        self.tab = Some(tab.0);
        self
    }

    pub(crate) fn with_status(mut self, status: AgentStatus, message: Option<String>) -> Self {
        self.status = Some(status);
        self.message = message;
        self
    }

    pub(crate) fn with_session(mut self, agent_session: AgentSession) -> Self {
        self.agent_session = Some(agent_session);
        self
    }
}

/// [`crate::command::Dispatcher::events_since`] 의 응답 —
/// `{"events":[…],"nextSeq":N,"gap":bool}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsSince {
    /// `since` 뒤의 이벤트를 오래된 순으로. `gap` 이면 보존된 전부다.
    pub events: Vec<AgentEvent>,
    /// 다음에 발급될 seq. 링이 비어 있으면 0건일 때의 다음 seq 값이다.
    pub next_seq: u64,
    /// `events` 앞에 누락이 생겼는가 — 링이 넘쳐 오래된 seq가 버려졌거나,
    /// 재시작 뒤 `since` 가 현재 seq보다 낡았을 때다.
    pub gap: bool,
}

/// [`crate::command::Dispatcher::overview`] 의 응답 —
/// `{"nextSeq":N,"workspaces":[…]}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerOverview {
    pub next_seq: u64,
    pub workspaces: Vec<OverviewWorkspace>,
}

/// 개요의 워크스페이스 한 항목. **관리자 워크스페이스도 `manager: true` 로
/// 포함한다** — 제외 판단은 하네스 몫이다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewWorkspace {
    pub id: u64,
    pub name: String,
    pub root_path: Option<String>,
    pub distro: Option<String>,
    pub manager: bool,
    /// 워크스페이스의 저장 파생값 (탭 상태에서 재계산된 값).
    pub agent_status: AgentStatus,
    pub tabs: Vec<OverviewTab>,
}

/// 개요의 탭 한 항목. `(kind, status)` 문자열은 `list_tabs` 와 같은 매핑을 공유한다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewTab {
    pub tab: u64,
    pub title: String,
    pub kind: &'static str,
    pub status: &'static str,
    pub agent_status: AgentStatus,
    pub last_agent_message: Option<String>,
    pub agent_session: Option<AgentSession>,
}

/// 관리자 query 요청 — `{"op":"workspaces"}` | `{"op":"events","since":<u64>}`.
///
/// 모르는 op·필드 형식 오류는 역직렬화 단계에서 거부되므로, 문자열로 들어오는
/// 호출자는 [`parse_manager_request`] 로 [`ManagerQueryError::InvalidParams`] 를
/// 받는다.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ManagerRequest {
    Workspaces,
    Events { since: u64 },
}

/// [`crate::command::Dispatcher::manager_query`] 의 성공 응답. 회신 파일에는
/// [`manager_reply_json`] 이 `{"result": …}` 로 감싼다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ManagerReply {
    Overview(ManagerOverview),
    Events(EventsSince),
}

/// 관리자 query 실패. 회신 JSON의 `error.code` 와 일대일이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagerQueryError {
    /// 요청 세션이 관리자 워크스페이스의 탭에 속하지 않는다.
    Forbidden,
    /// 요청이 4 KiB 초과이거나 UTF-8·JSON·스키마가 아니다.
    InvalidParams,
    /// 직렬화한 성공 회신이 [`MAX_MANAGER_REPLY_BYTES`] 를 넘는다.
    TooLarge,
}

impl ManagerQueryError {
    /// 회신 JSON의 `error.code`.
    pub fn code(self) -> &'static str {
        match self {
            Self::Forbidden => "forbidden",
            Self::InvalidParams => "invalid_params",
            Self::TooLarge => "too_large",
        }
    }

    /// 회신 JSON의 `error.message` — 영어 한 줄.
    pub fn message(self) -> &'static str {
        match self {
            Self::Forbidden => "the requesting tab is not in a manager workspace",
            Self::InvalidParams => "the manager request is not valid JSON within 4 KiB",
            Self::TooLarge => "the manager reply exceeds 4 MiB",
        }
    }
}

/// OSC 회신 경로로 들어온 요청 바이트를 [`ManagerRequest`] 로 만든다. 4 KiB 초과,
/// UTF-8 아님, JSON·스키마 오류는 모두 [`ManagerQueryError::InvalidParams`] 다.
pub fn parse_manager_request(bytes: &[u8]) -> Result<ManagerRequest, ManagerQueryError> {
    if bytes.len() > MAX_MANAGER_REQUEST_BYTES {
        return Err(ManagerQueryError::InvalidParams);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| ManagerQueryError::InvalidParams)?;
    serde_json::from_str(text).map_err(|_| ManagerQueryError::InvalidParams)
}

/// 회신 JSON을 만든다 — 성공은 `{"result": …}`, 실패는 `{"error":{…}}`.
/// 직렬화한 성공 회신이 [`MAX_MANAGER_REPLY_BYTES`] 를 넘으면 결과 대신
/// `too_large` 오류를 낸다.
pub fn manager_reply_json(result: Result<ManagerReply, ManagerQueryError>) -> String {
    manager_reply_json_with_limit(result, MAX_MANAGER_REPLY_BYTES)
}

/// 상한 주입 판 — 단위 테스트가 작은 상한으로 `too_large` 를 만든다.
pub(crate) fn manager_reply_json_with_limit(
    result: Result<ManagerReply, ManagerQueryError>,
    limit: usize,
) -> String {
    let reply = match result {
        Ok(reply) => reply,
        Err(error) => return error_reply_json(error),
    };
    let json = serde_json::to_string(&ManagerResultBody { result: &reply })
        .expect("관리자 회신은 직렬화 가능하다");
    if json.len() > limit {
        return error_reply_json(ManagerQueryError::TooLarge);
    }
    json
}

#[derive(Serialize)]
struct ManagerResultBody<'a> {
    result: &'a ManagerReply,
}

#[derive(Serialize)]
struct ManagerErrorBody<'a> {
    error: ManagerErrorPayload<'a>,
}

#[derive(Serialize)]
struct ManagerErrorPayload<'a> {
    code: &'static str,
    message: &'a str,
}

fn error_reply_json(error: ManagerQueryError) -> String {
    serde_json::to_string(&ManagerErrorBody {
        error: ManagerErrorPayload {
            code: error.code(),
            message: error.message(),
        },
    })
    .expect("관리자 오류 회신은 직렬화 가능하다")
}

/// 하네스 stdio 프로토콜 버전. `hello.protocol` 과 다르면 하네스가 exit 3(미지원)으로
/// 끝난다.
pub const HARNESS_PROTOCOL: u32 = 1;

/// 하네스 stdio 한 줄의 바이트 상한 — stdin·stdout 양방향 같은 값이다.
pub const MAX_HARNESS_LINE_BYTES: usize = 4 * 1024 * 1024;

/// `board` 가 실을 수 있는 항목 수 상한. 넘으면 [`parse_harness_line`] 이
/// [`HarnessLine::Invalid`] 로 거부한다.
pub const MAX_BOARD_ENTRIES: usize = 64;

/// `notify` 제목의 문자 수 상한.
const MAX_NOTIFY_TITLE_CHARS: usize = 80;

/// `notify` 본문의 문자 수 상한.
const MAX_NOTIFY_BODY_CHARS: usize = 200;

/// 앱(글루)에서 하네스 stdin 으로 가는 줄 단위 메시지.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AppToHarness {
    /// 연결 직후 한 번 보내는 인사 — 프로토콜 버전과 관리자 폴더·설정을 알린다.
    Hello {
        protocol: u32,
        manager_workspace: u64,
        manager_dir: String,
        manager_distro: Option<String>,
        default_distro: Option<String>,
        settings: HarnessSettings,
    },
    /// 연결 직후와 `gap` 때 보내는 전체 개요.
    Snapshot { overview: ManagerOverview },
    /// `events_since` 결과 그대로.
    Events {
        events: Vec<AgentEvent>,
        next_seq: u64,
    },
    /// 사용자의 이어보기(`resume`)/새로 시작(`fresh`) 선택.
    Action { action: HarnessAction, key: String },
}

/// [`AppToHarness::Action`] 의 동작.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HarnessAction {
    Resume,
    Fresh,
}

/// [`AppToHarness::Hello`] 가 싣는 모델·요약 설정. 글루가 설정 값으로 채운다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSettings {
    pub model: String,
    pub effort: String,
    pub summary_model: String,
    pub summary_effort: String,
    pub idle_seconds: u64,
}

/// 하네스 stdout 에서 앱(글루)으로 오는 줄 단위 메시지.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HarnessToApp {
    /// 하네스 상태. 없는 값은 `null` 이다.
    Status {
        state: HarnessState,
        message: Option<String>,
        last_collected_at: Option<String>,
        log_path: Option<String>,
        codex_version: Option<String>,
    },
    /// 보드 스냅샷. `entries` 는 코어가 해석하지 않는 불투명 JSON 이며, 개수 상한만
    /// [`MAX_BOARD_ENTRIES`] 로 검사한다.
    Board {
        generated_at: String,
        entries: Vec<serde_json::Value>,
    },
    /// 사용자에게 보여 줄 알림.
    Notify {
        workspace_id: u64,
        reason: NotifyReason,
        title: String,
        body: String,
    },
}

/// [`HarnessToApp::Status`] 의 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HarnessState {
    Starting,
    Ok,
    Busy,
    Failed,
    Unsupported,
}

/// [`HarnessToApp::Notify`] 의 이유 — `question` 은 입력 대기, `done`·`failed` 는
/// 작업 종료다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotifyReason {
    Question,
    Done,
    Failed,
}

/// [`parse_harness_line`] 의 결과.
#[derive(Debug, Clone, PartialEq)]
pub enum HarnessLine {
    /// 아는 `type` 이고 스키마·상한 검증을 통과했다.
    Known(HarnessToApp),
    /// 모르는 `type` — 호출자는 로그 후 무시한다(전방 호환). 값은 `type` 문자열이다.
    Unknown(String),
    /// JSON·스키마·상한 위반 진단.
    Invalid(String),
}

impl HarnessToApp {
    /// 불투명 필드를 뺀 상한 검증.
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Board { entries, .. } if entries.len() > MAX_BOARD_ENTRIES => Err(format!(
                "the board has {} entries (max {MAX_BOARD_ENTRIES})",
                entries.len()
            )),
            Self::Notify { title, .. } if title.chars().count() > MAX_NOTIFY_TITLE_CHARS => {
                Err(format!(
                    "the notify title has {} characters (max {MAX_NOTIFY_TITLE_CHARS})",
                    title.chars().count()
                ))
            }
            Self::Notify { body, .. } if body.chars().count() > MAX_NOTIFY_BODY_CHARS => {
                Err(format!(
                    "the notify body has {} characters (max {MAX_NOTIFY_BODY_CHARS})",
                    body.chars().count()
                ))
            }
            _ => Ok(()),
        }
    }
}

/// 하네스 stdout 한 줄을 해석한다.
///
/// 길이가 [`MAX_HARNESS_LINE_BYTES`] 를 넘으면 JSON 파싱 전에 Invalid 다. `type` 이
/// 없거나 문자열이 아니면 Invalid, 모르는 `type` 이면 [`HarnessLine::Unknown`],
/// 아는 `type` 이라도 스키마·상한 검증에 걸리면 Invalid 다.
pub fn parse_harness_line(line: &str) -> HarnessLine {
    if line.len() > MAX_HARNESS_LINE_BYTES {
        return HarnessLine::Invalid(format!(
            "the harness line exceeds {MAX_HARNESS_LINE_BYTES} bytes"
        ));
    }
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => return HarnessLine::Invalid(error.to_string()),
    };
    let Some(kind) = value.get("type").and_then(serde_json::Value::as_str) else {
        return HarnessLine::Invalid("the harness message has no string type field".into());
    };
    // HarnessToApp 의 variant 이름과 동기화한다.
    if !matches!(kind, "status" | "board" | "notify") {
        return HarnessLine::Unknown(kind.to_owned());
    }
    match serde_json::from_value::<HarnessToApp>(value) {
        Ok(message) => match message.validate() {
            Ok(()) => HarnessLine::Known(message),
            Err(error) => HarnessLine::Invalid(error),
        },
        Err(error) => HarnessLine::Invalid(error.to_string()),
    }
}

/// 최대 [`MANAGER_EVENT_CAPACITY`] 개를 보관하는 이벤트 링. `seq` 는 1부터 단조
/// 증가하며 persist 하지 않는다 — 프로세스가 다시 시작하면 1부터 다시 센다.
#[derive(Debug)]
pub(crate) struct ManagerEvents {
    enabled: bool,
    next_seq: u64,
    ring: VecDeque<AgentEvent>,
}

impl ManagerEvents {
    pub(crate) fn new() -> Self {
        Self {
            enabled: false,
            next_seq: 1,
            ring: VecDeque::new(),
        }
    }

    pub(crate) fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// 성공한 변이 뒤에만 호출한다. 꺼져 있으면 아무것도 하지 않는다.
    /// 호출자는 이벤트를 넘기 전에 [`Self::is_enabled`] 로 스냅샷 생성을 걸러
    /// 유휴 비용 0 을 유지한다.
    pub(crate) fn record(&mut self, mut event: AgentEvent) {
        if !self.enabled {
            return;
        }
        event.seq = self.next_seq;
        self.next_seq += 1;
        if self.ring.len() == MANAGER_EVENT_CAPACITY {
            self.ring.pop_front();
        }
        self.ring.push_back(event);
    }

    /// 테스트 접근자 — 공개 조회 API는 [`Dispatcher::events_since`](crate::command::Dispatcher::events_since) 다.
    #[cfg(test)]
    pub(crate) fn events(&self) -> &VecDeque<AgentEvent> {
        &self.ring
    }

    /// 다음에 발급될 seq.
    pub(crate) fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// `since`(이미 받은 마지막 seq) 뒤의 이벤트를 오래된 순으로 돌려준다.
    ///
    /// - 꺼져 있으면 빈 목록·현재 seq·`gap: false` 다.
    /// - 보존된 가장 오래된 seq가 `since + 1` 보다 크거나(누락), `since` 가 현재
    ///   seq 이상이면서 0보다 크면(재시작 뒤 낡은 값) `gap: true` 이며 보존분 전부를
    ///   돌려준다.
    pub(crate) fn events_since(&self, since: u64) -> EventsSince {
        let next_seq = self.next_seq;
        if !self.enabled {
            return EventsSince {
                events: Vec::new(),
                next_seq,
                gap: false,
            };
        }
        let oldest_dropped = matches!(
            self.ring.front(),
            Some(oldest) if oldest.seq > since.saturating_add(1)
        );
        let stale = since > 0 && since >= next_seq;
        let gap = oldest_dropped || stale;
        let events = self
            .ring
            .iter()
            .filter(|event| gap || event.seq > since)
            .cloned()
            .collect();
        EventsSince {
            events,
            next_seq,
            gap,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::model::{AgentKind, AgentSession};

    fn workspace(id: u64) -> EventWorkspace {
        EventWorkspace {
            id,
            name: "feature-x".into(),
            root_path: Some("/home/u/p/x".into()),
            distro: None,
        }
    }

    #[test]
    fn agent_event_serializes_the_contract_shape_with_nulls() {
        let event = AgentEvent {
            seq: 41,
            kind: AgentEventKind::Status,
            workspace: workspace(1),
            tab: Some(4),
            status: Some(AgentStatus::Idle),
            message: Some("done".into()),
            agent_session: None,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "seq": 41,
                "kind": "status",
                "workspace": {
                    "id": 1,
                    "name": "feature-x",
                    "rootPath": "/home/u/p/x",
                    "distro": null
                },
                "tab": 4,
                "status": "idle",
                "message": "done",
                "agentSession": null
            })
        );
    }

    #[test]
    fn agent_event_kinds_use_the_camel_case_contract_names() {
        for (kind, name) in [
            (AgentEventKind::WorkspaceOpened, "workspaceOpened"),
            (AgentEventKind::WorkspaceClosed, "workspaceClosed"),
            (AgentEventKind::Status, "status"),
            (AgentEventKind::Session, "session"),
            (AgentEventKind::TabGone, "tabGone"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(name));
        }
    }

    #[test]
    fn agent_event_session_field_serializes_the_agent_meta() {
        let event = AgentEvent {
            seq: 1,
            kind: AgentEventKind::Session,
            workspace: workspace(7),
            tab: Some(9),
            status: None,
            message: None,
            agent_session: Some(AgentSession {
                agent: AgentKind::Claude,
                session_id: "abc".into(),
                transcript_path: "/home/u/.claude/projects/x/abc.jsonl".into(),
            }),
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "seq": 1,
                "kind": "session",
                "workspace": {
                    "id": 7,
                    "name": "feature-x",
                    "rootPath": "/home/u/p/x",
                    "distro": null
                },
                "tab": 9,
                "status": null,
                "message": null,
                "agentSession": {
                    "agent": "claude",
                    "sessionId": "abc",
                    "transcriptPath": "/home/u/.claude/projects/x/abc.jsonl"
                }
            })
        );
    }

    #[test]
    fn ring_drops_the_oldest_event_and_keeps_the_sequence_growing() {
        let mut log = ManagerEvents::new();
        log.set_enabled(true);
        for id in 1..=(MANAGER_EVENT_CAPACITY as u64 + 1) {
            log.record(AgentEvent::new(
                AgentEventKind::WorkspaceOpened,
                workspace(id),
            ));
        }
        assert_eq!(log.events().len(), MANAGER_EVENT_CAPACITY);
        let first = log.events().front().unwrap();
        assert_eq!(first.seq, 2, "1025번째에서 가장 오래된 seq 1 이 빠진다");
        let last = log.events().back().unwrap();
        assert_eq!(last.seq, MANAGER_EVENT_CAPACITY as u64 + 1);
        assert_eq!(log.next_seq(), MANAGER_EVENT_CAPACITY as u64 + 2);
    }

    #[test]
    fn disabled_ring_records_nothing_and_keeps_sequence() {
        let mut log = ManagerEvents::new();
        log.record(AgentEvent::new(
            AgentEventKind::WorkspaceOpened,
            workspace(1),
        ));
        assert!(log.events().is_empty());
        assert_eq!(log.next_seq(), 1);

        log.set_enabled(true);
        log.record(AgentEvent::new(
            AgentEventKind::WorkspaceOpened,
            workspace(1),
        ));
        assert_eq!(log.events().len(), 1);
        assert_eq!(log.events().front().unwrap().seq, 1);
        assert_eq!(log.next_seq(), 2);
    }

    /// seq 1~3 이 담긴 켜진 링.
    fn ring_of_three() -> ManagerEvents {
        let mut log = ManagerEvents::new();
        log.set_enabled(true);
        for id in 1..=3 {
            log.record(AgentEvent::new(
                AgentEventKind::WorkspaceOpened,
                workspace(id),
            ));
        }
        log
    }

    fn seqs(reply: &EventsSince) -> Vec<u64> {
        reply.events.iter().map(|event| event.seq).collect()
    }

    #[test]
    fn events_since_filters_received_events_and_reports_next_seq() {
        let log = ring_of_three();

        let all = log.events_since(0);
        assert_eq!(seqs(&all), vec![1, 2, 3]);
        assert_eq!(all.next_seq, 4);
        assert!(!all.gap);

        let increment = log.events_since(2);
        assert_eq!(seqs(&increment), vec![3]);
        assert_eq!(increment.next_seq, 4);
        assert!(!increment.gap);

        let caught_up = log.events_since(3);
        assert!(caught_up.events.is_empty());
        assert_eq!(caught_up.next_seq, 4);
        assert!(!caught_up.gap, "since == nextSeq - 1 은 정상 따라잡기다");
    }

    #[test]
    fn events_since_flags_a_stale_since_as_gap() {
        let future = ring_of_three().events_since(9);
        assert!(future.gap);
        assert_eq!(seqs(&future), vec![1, 2, 3], "gap 이면 보존분 전부");
        assert_eq!(future.next_seq, 4);

        // 재시작 뒤 낡은 값 — 새 링은 seq 1 부터 다시 세는데 since 가 크다.
        let mut restarted = ManagerEvents::new();
        restarted.set_enabled(true);
        let stale = restarted.events_since(5);
        assert!(stale.gap);
        assert!(stale.events.is_empty());
        assert_eq!(stale.next_seq, 1);
    }

    #[test]
    fn events_since_maps_an_evicted_oldest_to_gap() {
        let mut log = ManagerEvents::new();
        log.set_enabled(true);
        for id in 1..=(MANAGER_EVENT_CAPACITY as u64 + 1) {
            log.record(AgentEvent::new(
                AgentEventKind::WorkspaceOpened,
                workspace(id),
            ));
        }

        // 아직 since+1 이 보존 최고참과 같으면 누락이 없다.
        let caught_up = log.events_since(1);
        assert!(!caught_up.gap);
        assert_eq!(caught_up.events.len(), MANAGER_EVENT_CAPACITY);
        assert_eq!(caught_up.events.first().unwrap().seq, 2);

        // 그보다 과거를 주장하면 버려진 seq 1 이 누락이다 — 보존분 전부를 돌려준다.
        let gap = log.events_since(0);
        assert!(gap.gap);
        assert_eq!(gap.events.len(), MANAGER_EVENT_CAPACITY);
        assert_eq!(gap.events.first().unwrap().seq, 2);
        assert_eq!(
            gap.events.last().unwrap().seq,
            MANAGER_EVENT_CAPACITY as u64 + 1
        );
    }

    #[test]
    fn events_since_is_empty_while_disabled() {
        let mut log = ManagerEvents::new();
        log.record(AgentEvent::new(
            AgentEventKind::WorkspaceOpened,
            workspace(1),
        ));
        let reply = log.events_since(0);
        assert!(reply.events.is_empty());
        assert_eq!(reply.next_seq, 1);
        assert!(!reply.gap);

        // 껐다 켠 링 — 보존분이 있어도 꺼져 있으면 빈 목록이고 seq 는 이어진다.
        let mut log = ring_of_three();
        log.set_enabled(false);
        let reply = log.events_since(0);
        assert!(reply.events.is_empty());
        assert_eq!(reply.next_seq, 4);
        assert!(!reply.gap);
    }

    #[test]
    fn events_since_serializes_the_contract_shape() {
        let reply = EventsSince {
            events: vec![AgentEvent {
                seq: 1,
                kind: AgentEventKind::WorkspaceOpened,
                workspace: workspace(1),
                tab: None,
                status: None,
                message: None,
                agent_session: None,
            }],
            next_seq: 42,
            gap: true,
        };
        assert_eq!(
            serde_json::to_value(&reply).unwrap(),
            json!({
                "events": [{
                    "seq": 1,
                    "kind": "workspaceOpened",
                    "workspace": {
                        "id": 1,
                        "name": "feature-x",
                        "rootPath": "/home/u/p/x",
                        "distro": null
                    },
                    "tab": null,
                    "status": null,
                    "message": null,
                    "agentSession": null
                }],
                "nextSeq": 42,
                "gap": true
            })
        );
    }

    #[test]
    fn overview_serializes_the_contract_shape() {
        let overview = ManagerOverview {
            next_seq: 42,
            workspaces: vec![OverviewWorkspace {
                id: 1,
                name: "feature-x".into(),
                root_path: Some("/home/u/p/x".into()),
                distro: None,
                manager: false,
                agent_status: AgentStatus::Idle,
                tabs: vec![OverviewTab {
                    tab: 4,
                    title: "claude".into(),
                    kind: "terminal",
                    status: "running",
                    agent_status: AgentStatus::Idle,
                    last_agent_message: Some("done".into()),
                    agent_session: Some(AgentSession {
                        agent: AgentKind::Claude,
                        session_id: "abc".into(),
                        transcript_path: "/home/u/.claude/projects/x/abc.jsonl".into(),
                    }),
                }],
            }],
        };
        assert_eq!(
            serde_json::to_value(&overview).unwrap(),
            json!({
                "nextSeq": 42,
                "workspaces": [{
                    "id": 1,
                    "name": "feature-x",
                    "rootPath": "/home/u/p/x",
                    "distro": null,
                    "manager": false,
                    "agentStatus": "idle",
                    "tabs": [{
                        "tab": 4,
                        "title": "claude",
                        "kind": "terminal",
                        "status": "running",
                        "agentStatus": "idle",
                        "lastAgentMessage": "done",
                        "agentSession": {
                            "agent": "claude",
                            "sessionId": "abc",
                            "transcriptPath": "/home/u/.claude/projects/x/abc.jsonl"
                        }
                    }]
                }]
            })
        );
    }

    #[test]
    fn manager_reply_json_wraps_success_and_errors() {
        let events = EventsSince {
            events: Vec::new(),
            next_seq: 1,
            gap: false,
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&manager_reply_json(Ok(
                ManagerReply::Events(events)
            )))
            .unwrap(),
            json!({"result": {"events": [], "nextSeq": 1, "gap": false}})
        );
        for error in [
            ManagerQueryError::Forbidden,
            ManagerQueryError::InvalidParams,
            ManagerQueryError::TooLarge,
        ] {
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&manager_reply_json(Err(error))).unwrap(),
                json!({
                    "error": {"code": error.code(), "message": error.message()}
                })
            );
        }
    }

    #[test]
    fn manager_reply_json_replaces_an_oversized_result_with_too_large() {
        let reply = ManagerReply::Events(EventsSince {
            events: vec![AgentEvent {
                seq: 1,
                kind: AgentEventKind::Status,
                workspace: workspace(1),
                tab: Some(4),
                status: Some(AgentStatus::Idle),
                message: Some("done".into()),
                agent_session: None,
            }],
            next_seq: 2,
            gap: false,
        });
        // 상한 경계: 직렬화 결과와 같은 길이는 성공, 한 바이트 작으면 too_large 다.
        let size = manager_reply_json_with_limit(Ok(reply.clone()), usize::MAX).len();
        let at_limit = manager_reply_json_with_limit(Ok(reply.clone()), size);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&at_limit).unwrap()["result"]["nextSeq"],
            2
        );
        let over = manager_reply_json_with_limit(Ok(reply), size - 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&over).unwrap(),
            json!({"error": {"code": "too_large", "message": "the manager reply exceeds 4 MiB"}})
        );
    }

    #[test]
    fn parse_manager_request_accepts_the_two_ops() {
        assert_eq!(
            parse_manager_request(br#"{"op":"workspaces"}"#).unwrap(),
            ManagerRequest::Workspaces
        );
        assert_eq!(
            parse_manager_request(br#"{"op":"events","since":3}"#).unwrap(),
            ManagerRequest::Events { since: 3 }
        );
    }

    #[test]
    fn parse_manager_request_maps_every_bad_payload_to_invalid_params() {
        for bad in [
            &b"not json"[..],
            br#"{"op":"nope"}"#,
            br#"{"op":"events"}"#,
            br#"{"op":"events","since":"soon"}"#,
            &[0xff, 0xfe],
        ] {
            assert_eq!(
                parse_manager_request(bad),
                Err(ManagerQueryError::InvalidParams),
                "payload: {bad:?}"
            );
        }
        let too_large = vec![b' '; MAX_MANAGER_REQUEST_BYTES + 1];
        assert_eq!(
            parse_manager_request(&too_large),
            Err(ManagerQueryError::InvalidParams)
        );
        // 경계: 정확히 4 KiB 는 크기로 거부하지 않는다 (뒤 공백은 JSON 파서가 허용).
        let mut exact = br#"{"op":"workspaces"}"#.to_vec();
        exact.resize(MAX_MANAGER_REQUEST_BYTES, b' ');
        assert_eq!(
            parse_manager_request(&exact).unwrap(),
            ManagerRequest::Workspaces
        );
    }
}
