//! Command dispatcher — 모든 구조 변이의 단일 진입점 (계획 v2 4장, 10단계 계획 3-B).
//!
//! 키보드·마우스·(v2) MCP 가 전부 같은 [`Command`] bus 로 [`Dispatcher::dispatch`] 를
//! 호출한다. PTY 부수효과는 [`SessionHost`] 포트로 격리해 모델을 PTY·Tauri 없이
//! 테스트한다 — 실제 앱 글루가 `SessionManager` 위에 이 포트를 구현한다.
//!
//! # 의미론 요약
//!
//! - 대상 id(pane/tab/workspace) 탐색은 **전 워크스페이스 범위** — 안정 ID 는 단일
//!   카운터 발급이라 전역 유일하다. 미지 id 는 [`CommandError::UnknownTarget`].
//! - **예외: 에이전트 채널** ([`Dispatcher::resolve_send_target`]·
//!   [`Dispatcher::list_tabs`])은 요청자의 **워크스페이스 안**으로 범위가 좁혀진다
//!   (사용자 결정 2026-08-11 — 워크스페이스가 프로젝트 격리 단위라, 채널이 그
//!   경계를 넘으면 오발사 반경이 프로젝트 밖까지 불필요하게 넓어진다). 이 둘은
//!   `dispatch` 를 타지 않는 순수 조회라 위 규칙과 독립이다.
//! - 성공한 dispatch 마다 `revision += 1`. 실패 시 상태·revision 불변 (원자성 —
//!   각 핸들러는 검증을 전부 마친 뒤에만 변이하고, spawn 은 탭 추가 전에 수행).
//! - [`Dispatcher::apply_event`] 의 미지 session 은 무해한 no-op (10단계 계획 0-5 —
//!   CloseTab 이 탭을 먼저 제거한 뒤 리더 스레드의 exit 통지가 도착하는 정상 순서).
//!   상태가 실제로 바뀔 때만 revision 이 증가한다.
//! - [`Dispatcher::apply_osc`] 는 flush 창 하나에 모인 OSC 델타를 통째로 반영하고
//!   revision 을 **배치당 최대 1회** 올린다 (18단계 계획 core 계약 — OSC 플러드가
//!   스냅샷 발행을 이벤트 수만큼 유발하지 않게 하는 coalescing 의 착지점).

use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::model::{
    AgentStatus, AppState, NotificationState, Pane, PaneId, SplitDirection, SplitId, SplitTree,
    Tab, TabId, TabKind, TerminalStatus, Workspace, WorkspaceId,
};
use crate::notify::{OscBatch, OscDelta};
use crate::send::SendTargetError;
use crate::session::SessionId;

/// 직렬화 가능한 command bus 의 명령 집합.
///
/// JSON 은 internal tag: `{"type": "createWorkspace", "name": ...}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    /// 워크스페이스 + pane 1개(Leaf)를 만들고 active 로 지정한다. `tab` 이
    /// Some 이면 초기 pane 에 그 탭까지 **원자적으로** 생성한다 (계획 13-D1 —
    /// CreateTab 과 동일한 spawn-first 순서라 스폰 실패 시 워크스페이스·pane·
    /// next_id 전부 불변이고, 빈 워크스페이스 중간 상태가 스냅샷에 노출되지
    /// 않는다). None 이면 기존처럼 빈 pane 을 만든다 — 필드 누락 JSON 도
    /// None 으로 파싱된다 (13단계 이전 클라이언트 하위호환).
    CreateWorkspace {
        name: String,
        root_path: Option<String>,
        distro: Option<String>,
        tab: Option<NewTab>,
    },
    SwitchWorkspace {
        workspace: WorkspaceId,
    },
    /// 소속 terminal 세션을 전부 kill 하고 제거한다. 마지막 워크스페이스도 닫을 수
    /// 있다 (active_workspace 가 None 이 된다).
    CloseWorkspace {
        workspace: WorkspaceId,
    },
    /// 워크스페이스 이름만 바꾼다 (사이드바 인라인 편집 — F2). `name` 이 비어
    /// 있거나 공백뿐이면 [`CommandError::InvalidName`] — 이름은 사이드바에서
    /// 워크스페이스를 식별하는 유일한 표시라 빈 카드를 만들지 않는다. 그 외의
    /// 다듬기(앞뒤 공백 제거)는 하지 않는다: 코어는 받은 값을 그대로 보관하고
    /// (CreateWorkspace 와 동일), 표시용 정규화는 입력 UI 몫이다.
    RenameWorkspace {
        workspace: WorkspaceId,
        name: String,
    },
    /// 사이드바에서 워크스페이스 순서를 바꾼다 (드래그 재배치). `workspace` 를
    /// 빼서 `before` **바로 앞**에 넣고, `before` 가 None 이면 맨 뒤로 보낸다.
    ///
    /// 목적지를 **인덱스가 아니라 이웃의 id 로** 받는 이유가 둘이다. 하나는
    /// 인덱스의 "빼기 전 기준인가 뺀 뒤 기준인가"라는 해묵은 모호함이 아예 없어서고,
    /// 다른 하나는 프론트가 보는 스냅샷이 낡았을 때의 결과가 낫기 때문이다 — 그
    /// 사이 목록이 바뀌었어도 "이 카드 앞"은 여전히 뜻이 통하고, 이웃이 사라졌으면
    /// 엉뚱한 자리에 꽂히는 대신 [`CommandError::UnknownTarget`] 으로 깨끗이 실패한다.
    /// 인덱스였다면 같은 상황에서 조용히 다른 자리로 갔을 것이다.
    ///
    /// `before == Some(workspace)` 는 "자기 앞으로"라 아무 일도 일어나지 않지만
    /// 에러도 아니다 (제자리에 놓은 드래그의 자연스러운 표현).
    ///
    /// **순서가 곧 `Ctrl+1`~`Ctrl+9` 의 번호다** (사이드바 순서 1-based — `keys.ts`).
    /// 재배치는 그 번호까지 같이 옮긴다 — 자주 쓰는 워크스페이스를 `Ctrl+1` 로
    /// 만드는 것이 이 기능의 실질적 값어치라는 사용자 판단(2026-08-22)이다.
    /// active_workspace 는 건드리지 않는다: 정리하려고 끈 드래그가 화면까지 바꾸면
    /// 안 된다 (SwitchWorkspace 와의 직교성 — FocusPane 주석과 같은 규율).
    MoveWorkspace {
        workspace: WorkspaceId,
        before: Option<WorkspaceId>,
    },
    /// 소속 워크스페이스의 active_pane 을 바꾼다. active_workspace 는 바꾸지
    /// 않는다 — 워크스페이스 전환은 SwitchWorkspace 로 명시한다 (명령 직교성).
    FocusPane {
        pane: PaneId,
    },
    /// `pane` 의 leaf 를 분할해 새 pane 을 second(우/하)로 만들고 포커스를 새
    /// pane 으로 옮긴다. `tab` 이 Some 이면 새 pane 에 그 탭까지 **원자적으로**
    /// 생성한다 (계획 D5 — CreateTab 과 동일한 spawn-first 순서라 스폰 실패 시
    /// 트리·panes 불변이고, 분할만 된 중간 상태가 스냅샷에 노출되지 않는다).
    /// None 이면 기존처럼 빈 pane 을 만든다 (dev 훅·MCP 용).
    SplitPane {
        pane: PaneId,
        direction: SplitDirection,
        tab: Option<NewTab>,
    },
    /// `split` 노드의 ratio 를 갱신한다. ratio 는 finite 하고 개구간 (0, 1) 안이
    /// 어야 한다 — 아니면 [`CommandError::InvalidRatio`] (검증은 모델이 loud 하게,
    /// 픽셀 클램프는 UI 가 분담 — 계획 D2). 스테일 split id 는 UnknownTarget.
    ResizeSplit {
        split: SplitId,
        ratio: f64,
    },
    /// 소속 세션 kill + tree collapse. 워크스페이스의 마지막 pane 은 닫을 수 없다
    /// ([`CommandError::LastPane`]). 12단계 UI 의 pane 정리는 CloseTab
    /// auto-collapse 가 담당하고, 이 커맨드는 dev 훅·MCP 용으로 존치한다 (계획 D6).
    ClosePane {
        pane: PaneId,
    },
    CreateTab {
        pane: PaneId,
        tab: NewTab,
    },
    ActivateTab {
        tab: TabId,
    },
    /// terminal 탭이면 세션 kill. active_tab 이었다면 직전 탭으로 조정 (첫 탭이었
    /// 으면 다음 탭).
    ///
    /// **auto-collapse 규칙 (계획 D6)**: 마지막 탭이 닫혀 pane 이 비면, 그 pane
    /// 이 워크스페이스의 마지막 pane 이 아닌 한 pane 자체를 collapse 한다 (tree
    /// remove + panes remove + active_pane fixup — ClosePane 과 공유 헬퍼).
    /// 워크스페이스의 마지막 pane 은 예외로 빈 pane(active_tab = None)으로 남는다.
    CloseTab {
        tab: TabId,
    },
    /// folderBrowser 탭의 경로를 바꾼다 — 디렉터리 탐색도 뷰 내부 상태가 아니라
    /// dispatcher 를 경유한다 (계획 v2 4장 + persist 최신성, 21단계). 대상이
    /// folderBrowser 가 아니면 [`CommandError::KindMismatch`], 경로 형태가
    /// 불량하면 [`CommandError::InvalidPath`] (실존 여부는 검사하지 않는다 —
    /// 코어 무 I/O). 성공 시 `Tab.title` 도 새 경로의 basename 으로 갱신된다.
    NavigateFolder {
        tab: TabId,
        path: String,
    },
    /// 뷰어 스크롤 위치를 기록한다 — unmount 복원·persist 용 (21단계). 값 시맨틱은
    /// 탭 종류별로 다르다 ([`TabKind`] rustdoc 참조): textViewer 는 최상단 가시
    /// 행의 전역 byte offset, markdownViewer 는 렌더 컨테이너의 **px** 다. 코어는
    /// 둘을 구분하지 않고 f64 를 그대로 보관한다 — 해석은 그 종류의 뷰 몫이다.
    /// finite·0 이상이어야 하고 (아니면 [`CommandError::InvalidScroll`]), 대상은
    /// 스크롤 위치를 모델에 가진 뷰어 탭(textViewer·markdownViewer)이어야 한다 —
    /// folderBrowser 는 그 필드가 없으므로 [`CommandError::KindMismatch`]
    /// (기결정).
    SetViewerScroll {
        tab: TabId,
        scroll_top: f64,
    },
}

/// 탭 생성 명세 — CreateTab·SplitPane·CreateWorkspace 가 공유한다. 21단계 뷰어
/// 3종이 모두 착지해 [`TabKind`] 와 종류가 일대일이다 (terminal 은 스폰을
/// 동반하고, 뷰어 3종은 순수 변이다).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NewTab {
    Terminal {
        /// None 이면 워크스페이스 root_path 를 기본 cwd 로 쓴다 (계획 v2 4장).
        cwd: Option<String>,
    },
    /// 디렉터리 탐색 탭. spawn 이 없는 순수 변이로 생성된다.
    FolderBrowser {
        /// None 이면 워크스페이스 root_path, 그것도 None 이면 `"/"` (Terminal
        /// cwd 와 대칭 — 계획 21단계 core 계약).
        path: Option<String>,
    },
    /// 텍스트 파일 뷰어 탭 (에디터가 아니다 — 읽기 전용). 경로는 필수다.
    TextViewer {
        path: String,
    },
    /// 마크다운 렌더 뷰어 탭 (21단계 청크 D). TextViewer 와 같은 파일을 다른
    /// 방식으로 볼 뿐이라 계약은 동일하다 — 읽기 전용, 경로 필수. 스크롤
    /// 시맨틱만 다르다 (렌더된 px — [`TabKind`] rustdoc).
    MarkdownViewer {
        path: String,
    },
}

/// dispatch 성공 결과. 생성된 안정 ID 를 돌려줘 dev 훅·MCP 가 후속 조작에 쓴다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CommandOutput {
    /// CreateWorkspace 결과 — 생성된 안정 ID 전부를 돌려준다 (계획 13-D1).
    /// `tab` 은 `CreateWorkspace.tab` 이 Some 이었을 때만 Some 이고, `session`
    /// 은 그 탭이 **terminal 일 때만** Some 이다 (뷰어 탭은 스폰이 없다 — 21단계).
    WorkspaceCreated {
        workspace: WorkspaceId,
        pane: PaneId,
        tab: Option<TabId>,
        session: Option<SessionId>,
    },
    /// SplitPane 결과 — 생성된 안정 ID 전부를 돌려준다 (계획 D5). `tab` 은
    /// `SplitPane.tab` 이 Some 이었을 때만 Some 이고, `session` 은 그 탭이
    /// **terminal 일 때만** Some 이다 (뷰어 탭은 스폰이 없다 — 21단계).
    PaneCreated {
        pane: PaneId,
        split: SplitId,
        tab: Option<TabId>,
        session: Option<SessionId>,
    },
    TabCreated {
        tab: TabId,
        /// terminal 탭이면 스폰된 PTY 세션 id, 뷰어 탭이면 None (스폰 없는 순수
        /// 변이 — 21단계).
        session: Option<SessionId>,
    },
    /// id 를 새로 만들지 않는 명령의 성공.
    Done,
}

/// dispatch 실패. 상태는 변하지 않았음이 보장된다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CommandError {
    /// 대상 id 가 전 워크스페이스 어디에도 없다.
    UnknownTarget { target: String },
    /// 워크스페이스의 마지막 pane 은 닫을 수 없다.
    LastPane,
    /// 셸 스폰 실패 — 탭은 추가되지 않았다 (spawn 이 탭 추가보다 먼저).
    SpawnFailed { message: String },
    /// ResizeSplit 의 ratio 가 유효 범위 밖 — finite 하고 개구간 (0, 1) 안이어야
    /// 한다 (계획 D2 — 모델은 loud-fail, 픽셀 클램프는 UI 분담).
    InvalidRatio { ratio: f64 },
    /// 대상 탭의 종류가 이 명령을 받을 수 없다 — NavigateFolder 는
    /// folderBrowser 만, SetViewerScroll 은 스크롤 위치를 모델에 가진 뷰어만
    /// 받는다 (21단계).
    KindMismatch { tab: TabId },
    /// 뷰어 경로의 형태가 불량하다 — 사유는 `wslpath::validate_linux_path` 의
    /// 문자열을 그대로 싣는다 (21단계). 실존 여부와는 무관하다 (코어 무 I/O).
    InvalidPath { message: String },
    /// SetViewerScroll 의 scroll_top 이 finite·0 이상이 아니다 (InvalidRatio 와
    /// 같은 loud-fail 방침).
    InvalidScroll { value: f64 },
    /// 이름 값이 불량하다 — RenameWorkspace 의 빈/공백뿐인 이름. 경로가 아니므로
    /// InvalidPath 를 재사용하지 않는다 (사유 문자열을 그대로 싣는 형태는 동일).
    InvalidName { message: String },
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CommandError::UnknownTarget { target } => {
                write!(f, "unknown target: {target}")
            }
            CommandError::LastPane => {
                write!(f, "cannot close the last pane of a workspace")
            }
            CommandError::SpawnFailed { message } => {
                write!(f, "shell spawn failed: {message}")
            }
            CommandError::InvalidRatio { ratio } => {
                write!(
                    f,
                    "invalid split ratio {ratio}: must be finite and in (0, 1)"
                )
            }
            CommandError::KindMismatch { tab } => {
                write!(f, "tab {} has the wrong kind for this command", tab.0)
            }
            CommandError::InvalidPath { message } => {
                write!(f, "invalid path: {message}")
            }
            CommandError::InvalidScroll { value } => {
                write!(
                    f,
                    "invalid scroll offset {value}: must be finite and >= 0"
                )
            }
            CommandError::InvalidName { message } => {
                write!(f, "invalid name: {message}")
            }
        }
    }
}

impl std::error::Error for CommandError {}

/// PTY 쪽에서 dispatcher 로 흘러오는 세션 이벤트.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionEvent {
    SessionExited {
        session: SessionId,
        code: Option<u32>,
    },
    /// 시작 표식이 마감 안에 오지 않았다. 세션은 **살아 있고** `pty_session` 도 그대로
    /// 유지된다 — 늦게 온 표식이 상태를 되돌릴 수 있어야 하기 때문이다.
    SessionStartupTimeout { session: SessionId },
}

/// 셸 스폰 요청. cols/rows 는 기본 80×24 — 실측 resize 는 attach 후 프론트가
/// 수행한다 (10단계 계획 2장 attach 프로토콜).
#[derive(Debug, Clone, PartialEq)]
pub struct ShellSpawnReq {
    pub cwd: Option<String>,
    pub distro: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// 이 셸이 쓸 **탭별 명령 history** 의 키 — 이 세션이 실릴 터미널 탭의 안정
    /// ID 다 (체크포인트 2 UX 요청). 안정 ID 는 재시작을 넘어 유지되므로 글루가
    /// 탭마다 다른 HISTFILE 을 물려 주면 재시작 후에도 같은 탭의 history 만
    /// 복원된다. 코어는 값을 만들어 넘기기만 하고 파일 배치는 글루 몫이다.
    /// None 이면 셸 기본 history 파일 (히스토리 분리 없음).
    pub history_tab: Option<u64>,
}

impl Default for ShellSpawnReq {
    fn default() -> Self {
        Self {
            cwd: None,
            distro: None,
            cols: 80,
            rows: 24,
            history_tab: None,
        }
    }
}

/// PTY 부수효과 포트. 실제 구현은 앱 글루(`SessionManager` 래핑), 테스트는 fake.
pub trait SessionHost: Send {
    /// 셸 세션을 스폰하고 휘발성 세션 id 를 돌려준다.
    fn spawn_shell(&self, req: ShellSpawnReq) -> anyhow::Result<SessionId>;

    /// 세션 종료. 미지·이미 종료된 id 에도 무해해야 한다 (멱등 —
    /// `PtySession::kill` 과 동일 계약).
    fn kill(&self, id: SessionId);

    /// 탭들이 **영구히** 사라졌음을 알린다 — 그 탭 전용으로 만들어 둔 셸측 자원
    /// (탭별 `HISTFILE`·resume 힌트)을 정리하라는 신호다. 탭 id 는 재사용되지
    /// 않으므로 되살아날 일이 없다.
    ///
    /// **`SessionExited` 는 이 경로가 아니다** — 죽은 탭은 재시작으로 되살아나고
    /// (ADR-0010) 그때 같은 탭 id 로 자기 history 를 다시 물어야 한다. 여기로 오는
    /// 것은 `CloseTab`·`ClosePane`·`CloseWorkspace` 뿐이다.
    ///
    /// 여러 탭을 한 번에 받는 이유는 워크스페이스·pane 하나가 탭 N 개를 데리고
    /// 사라지기 때문이다. 탭마다 부르면 정리 명령이 N 개 동시에 나가는데, 그것이
    /// 부팅 재스폰이 콜드 VM 과 부딪혔던 바로 그 모양이다 (ADR-0010 개정).
    ///
    /// 기본 구현은 no-op — 탭별 셸측 자원이 없는 호스트(테스트·unix 개발 경로)를
    /// 위해서다.
    fn release_tabs(&self, _tabs: &[TabId], _distro: Option<&str>) {}
}

/// revision 을 곁들인 상태 직렬화 뷰 — `state-changed` emit·`get_state` 응답 형태.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot<'a> {
    pub revision: u64,
    pub state: &'a AppState,
}

/// 탭 하나의 열거용 메타데이터 ([`Dispatcher::list_tabs`]).
///
/// **JSON 출구 전용 DTO** 다 — 에이전트 질의(`mast-query;list-tabs`)의 회신
/// 형태이고, 스냅샷 모델([`AppState`])의 직렬화 계약과는 무관하다. 그래서 id 들이
/// newtype 이 아니라 평평한 `u64` 이고, `kind`/`status` 는 열거 대신 문자열이다:
/// 이 표면의 소비자는 프론트가 아니라 셸·에이전트라 읽어서 바로 쓸 수 있는 형태가
/// 낫고, 모델 enum 을 그대로 노출하면 모델 변경이 곧 외부 계약 파손이 된다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    /// 탭의 안정 ID — `#<id>` 전송 주소이자 터미널의 `MAST_TAB` 값이다.
    pub tab: u64,
    pub title: String,
    pub workspace_id: u64,
    pub workspace_name: String,
    pub pane: u64,
    /// 이 탭이 소속 pane 의 active_tab 인가 (= 그 pane 에서 화면에 보이는 탭).
    /// 워크스페이스 자체가 백그라운드일 수 있으므로 "지금 눈에 보인다"는 뜻은 아니다.
    pub active: bool,
    /// 탭 종류 — 모델 [`TabKind`] 의 camelCase 이름
    /// (`terminal` | `folderBrowser` | `textViewer` | `markdownViewer`).
    pub kind: &'static str,
    /// `running` | `exited` (터미널) | `viewer` (프로세스가 없는 뷰어 탭).
    pub status: &'static str,
}

/// 상태 소유자. 모든 구조 변이는 [`Dispatcher::dispatch`] 를 경유한다.
pub struct Dispatcher {
    state: AppState,
    host: Box<dyn SessionHost>,
    /// 시작 표식을 이미 본 세션.
    ///
    /// 표식과 마감 보고는 **서로 다른 경로로** 들어온다 — 표식은 OSC 라우터의 코얼레싱
    /// 배치를 거치고, 마감은 워치독에서 곧장 온다. 둘이 여기서 만날 때 순서는 보장되지
    /// 않고, 표식이 먼저 도착하면 그때 탭은 아직 `Running` 이라 되돌릴 것이 없어 신호가
    /// 그대로 소모된다. 뒤늦게 도착한 마감이 그 탭을 `NotStarted` 로 떨어뜨리면 표식은
    /// 세션당 한 번뿐이라 회복 수단이 남지 않는다. 그래서 "봤다"는 사실을 상태와 별개로
    /// 기억한다. persist 대상이 아니다 — 세션 id 는 휘발성이다.
    started_sessions: HashSet<SessionId>,
}

impl Dispatcher {
    pub fn new(host: Box<dyn SessionHost>) -> Self {
        Self {
            state: AppState::new(),
            host,
            started_sessions: HashSet::new(),
        }
    }

    /// 복원(sanitize 완료)된 상태를 **스폰 없이** 채택한다 — manage-first 부팅
    /// (계획 15단계 B-2)의 코어 절반. 글루는 이 dispatcher 를 즉시 manage 한 뒤
    /// [`Self::running_terminal_tabs`] 로 대상을 뽑아 탭별로 [`Self::respawn_tab`]
    /// 을 호출해 재스폰한다. adopt 시점에는 살아 있는 PTY 가 없다 — persist
    /// sanitize 가 전 터미널 탭의 `pty_session` 을 소거한 상태를 전제한다.
    pub fn adopt(state: AppState, host: Box<dyn SessionHost>) -> Self {
        // persist::load 가 릴리즈에서도 validate 를 마쳤지만, 다른 호출자(테스트
        // 등)의 실수는 debug 에서 즉시 드러낸다.
        for ws in &state.workspaces {
            ws.debug_assert_invariants();
        }
        Self {
            state,
            host,
            started_sessions: HashSet::new(),
        }
    }

    /// 테스트·글루용 상태 접근자.
    pub fn state(&self) -> &AppState {
        &self.state
    }

    pub fn snapshot(&self) -> StateSnapshot<'_> {
        StateSnapshot {
            revision: self.state.revision,
            state: &self.state,
        }
    }

    /// 명령 실행. 성공 시에만 `revision += 1`, 실패 시 상태 불변.
    pub fn dispatch(&mut self, cmd: Command) -> Result<CommandOutput, CommandError> {
        let out = self.execute(cmd)?;
        self.state.revision += 1;
        for ws in &self.state.workspaces {
            ws.debug_assert_invariants();
        }
        Ok(out)
    }

    /// 세션 이벤트 반영. 상태가 실제로 바뀔 때만 `revision += 1`.
    pub fn apply_event(&mut self, ev: SessionEvent) {
        match ev {
            SessionEvent::SessionExited { session, code } => {
                self.started_sessions.remove(&session);
                let mut changed = false;
                for ws in &mut self.state.workspaces {
                    let mut exited = Vec::new();
                    for pane in ws.panes.values_mut() {
                        for tab in &mut pane.tabs {
                            if let TabKind::Terminal {
                                pty_session: Some(s),
                                status,
                                ..
                            } = &mut tab.kind
                            {
                                if *s == session {
                                    // pty_session 은 유지한다 (Exited 탭 표시용).
                                    let next = TerminalStatus::Exited { code };
                                    if *status != next {
                                        *status = next;
                                        changed = true;
                                    }
                                    exited.push(tab.id);
                                }
                            }
                        }
                    }
                    // 죽은 세션의 탭이 워크스페이스 상태의 출처였으면 되돌린다 —
                    // 탭 소멸 3경로(CloseTab·ClosePane·SessionExited)가 공유하는 규칙.
                    for tab in exited {
                        changed |= reset_agent_source(ws, tab);
                    }
                }
                // 미지 session 이면 changed == false — 무해한 no-op (모듈 doc 참조).
                if changed {
                    self.state.revision += 1;
                }
            }
            SessionEvent::SessionStartupTimeout { session } => {
                // 표식이 이미 왔으면 이 보고는 낡은 것이다 (필드 주석 참조).
                if self.started_sessions.contains(&session) {
                    return;
                }
                let mut changed = false;
                for ws in &mut self.state.workspaces {
                    for pane in ws.panes.values_mut() {
                        for tab in &mut pane.tabs {
                            if let TabKind::Terminal {
                                pty_session: Some(s),
                                status,
                                ..
                            } = &mut tab.kind
                            {
                                // Running 만 강등한다. 마감 직전에 종료한 세션의
                                // Exited 를 덮으면 이미 끝난 탭이 "시작 안 됨"으로
                                // 되살아나고, 그 오분류는 워치독과 waiter 의 경합
                                // 순서에 따라 재현조차 안 된다.
                                if *s == session && *status == TerminalStatus::Running {
                                    *status = TerminalStatus::NotStarted;
                                    changed = true;
                                }
                            }
                        }
                    }
                }
                // agent_status 출처는 건드리지 않는다 — 세션이 살아 있고 표식이 늦게
                // 오면 되돌아가므로, 죽은 탭 정리(SessionExited)와 규칙이 다르다.
                if changed {
                    self.state.revision += 1;
                }
            }
        }
    }

    /// flush 창 하나에 모인 OSC 델타를 모델에 반영한다 (18단계 계획 core 계약).
    /// 반환값은 "상태가 실제로 바뀌었는가" — 글루는 true 일 때만 스냅샷을 발행한다.
    ///
    /// - 세션→탭 역매핑은 [`Self::apply_event`] 와 같은 선형 탐색이고, **미지 세션
    ///   은 무해한 no-op** 이다 (창이 열려 있는 동안 탭이 닫히는 정상 순서).
    /// - **Exited 탭은 델타를 통째로 스킵**한다: 100ms 창 안에서 세션이 끝나면 즉시
    ///   처리된 `SessionExited` 의 Idle 리셋 뒤에 지연된 배치가 죽은 탭에 알림을
    ///   다시 도장하는 구멍이 생긴다.
    /// - `now_ms` 는 글루가 주입한다 (코어는 시계를 읽지 않는다).
    /// - revision 은 변경이 하나라도 있을 때 **배치당 1회** 오른다.
    pub fn apply_osc(&mut self, batch: OscBatch, now_ms: u64) -> bool {
        let mut changed = false;
        for (session, delta) in &batch.entries {
            if delta.started {
                self.started_sessions.insert(*session);
            }
            let Some((wi, pane, ti)) = self.locate_session(*session) else {
                continue;
            };
            changed |= self.apply_delta(wi, pane, ti, delta, now_ms);
        }
        if changed {
            self.state.revision += 1;
        }
        changed
    }

    /// 델타 하나를 이미 역매핑된 탭에 반영한다. 반환값은 이 델타가 상태를 바꿨는가.
    fn apply_delta(
        &mut self,
        wi: usize,
        pane: PaneId,
        ti: usize,
        delta: &OscDelta,
        now_ms: u64,
    ) -> bool {
        // 가시 탭 = active 워크스페이스에 속하고 그 pane 의 active_tab 인 탭. pane 은
        // 전부 화면에 보이므로 active_pane 여부는 따지지 않는다. 창 포커스와도
        // 결합하지 않는다 (v1 결정 — 자리를 비운 사용자에게는 사이드바 상태가 남는다).
        let ws_ref = &self.state.workspaces[wi];
        let tab_id = ws_ref.panes[&pane].tabs[ti].id;
        let visible = self.state.active_workspace == Some(ws_ref.id)
            && ws_ref.panes[&pane].active_tab == Some(tab_id);

        let ws = &mut self.state.workspaces[wi];
        let tab = &mut ws
            .panes
            .get_mut(&pane)
            .expect("locate_session 이 존재를 보장")
            .tabs[ti];
        if matches!(
            tab.kind,
            TabKind::Terminal {
                status: TerminalStatus::Exited { .. },
                ..
            }
        ) {
            return false;
        }

        let mut changed = false;
        // 늦게 도착한 표식이 경고를 거두는 경로다. 감지가 세션을 죽이지 않기 때문에
        // 존재할 수 있는 전이이며, 느린 콜드 스타트를 오탐해도 대가가 없는 근거이기도
        // 하다.
        if delta.started {
            if let TabKind::Terminal { status, .. } = &mut tab.kind {
                if *status == TerminalStatus::NotStarted {
                    *status = TerminalStatus::Running;
                    changed = true;
                }
            }
        }
        if let Some(title) = &delta.title {
            if tab.title != *title {
                tab.title.clone_from(title);
                changed = true;
            }
        }
        if let Some(next_cwd) = &delta.cwd {
            // respawn 이 탭 cwd 를 쓰므로(재시작 후 마지막 디렉터리 복원) OSC 7 은
            // 탭에 기록된 cwd 를 갱신한다.
            if let TabKind::Terminal { cwd, .. } = &mut tab.kind {
                if cwd.as_deref() != Some(next_cwd.as_str()) {
                    *cwd = Some(next_cwd.clone());
                    changed = true;
                }
            }
        }
        // 가시 탭의 unread 는 억제한다 — 내용이 이미 눈앞에 있으므로 dot 이 의미가
        // 없고, 이미 활성인 탭에는 ActivateTab 해제가 다시 오지 않는다.
        if delta.unread && !visible && tab.notification != NotificationState::Unread {
            tab.notification = NotificationState::Unread;
            changed = true;
        }
        if tab.last_activity_ms != Some(now_ms) {
            tab.last_activity_ms = Some(now_ms);
            changed = true;
        }

        if let Some(status) = delta.status {
            // needsInput 우선: 입력 대기 중인 워크스페이스는 **다른 탭**의 상태
            // 알림으로 덮이지 않는다 (사이드바만 훑어도 입력 대기가 보여야 한다 —
            // 계획 v2 9장). 사용자가 응답하면 같은 출처 탭의 running 이 강등한다.
            let allowed = ws.agent_status != AgentStatus::NeedsInput
                || status == AgentStatus::NeedsInput
                || ws.agent_status_source == Some(tab_id);
            if allowed {
                if ws.agent_status != status {
                    ws.agent_status = status;
                    changed = true;
                }
                if ws.agent_status_source != Some(tab_id) {
                    ws.agent_status_source = Some(tab_id);
                    changed = true;
                }
            }
        }
        // 미리보기 메시지는 상태 우선 규칙과 독립이다 — 우선 규칙의 대상은
        // agent_status 뿐이고, 메시지는 마지막으로 도착한 알림 본문을 보여준다.
        if let Some(message) = &delta.message {
            if ws.last_agent_message.as_deref() != Some(message.as_str()) {
                ws.last_agent_message = Some(message.clone());
                changed = true;
            }
        }
        changed
    }

    /// respawn 대상 열거 — **Running 터미널 탭 중 `pty_session` 이 None** 인 탭
    /// (= adopt 직후의 재스폰 대상).
    ///
    /// 디스크에 `Exited` 로 저장된 탭은 persist sanitize 가 복원 시 `Running` 으로
    /// 되돌리므로(ADR-0010) 여기에 그대로 잡힌다 — 재시작이 곧 되살리기다. 반면
    /// **런타임에 죽어 `Exited` 가 된 탭은 이 열거의 대상이 아니다**: 이 함수는 부팅
    /// 1회용이고, 실행 중 죽은 탭은 사용자가 pane 배너의 Restart 로
    /// [`Self::respawn_tab`] 을 직접 부르는 경로를 탄다 (멋대로 되살리면 사용자가
    /// 의도적으로 끝낸 셸까지 되살아난다).
    pub fn running_terminal_tabs(&self) -> Vec<TabId> {
        let mut tabs = Vec::new();
        for ws in &self.state.workspaces {
            for pane in ws.panes.values() {
                for tab in &pane.tabs {
                    if matches!(
                        tab.kind,
                        TabKind::Terminal {
                            pty_session: None,
                            status: TerminalStatus::Running,
                            ..
                        }
                    ) {
                        tabs.push(tab.id);
                    }
                }
            }
        }
        tabs
    }

    /// pane 간 전송의 **대상 해석** — 순수 조회다 (상태·revision 불변).
    ///
    /// 규칙 (에이전트 채널 계약 — `scripts/wsl/skills/mast-send/SKILL.md`):
    ///
    /// - 후보는 **송신자와 같은 워크스페이스**의 running 터미널 탭뿐이다 (아래
    ///   "워크스페이스 격리"). 그 워크스페이스가 백그라운드여도 상관없다 — 이 채널의
    ///   요점은 "지금 화면에 없는 pane 에도 보낼 수 있다"는 것이고, 그 반경이
    ///   워크스페이스 경계에서 멈출 뿐이다.
    /// - `target` 이 **`#<탭 id>`** 형태면 **id 직지정**이다 (아래 "id 주소지정").
    /// - 그 외에는 제목 매칭이다.
    /// - `target` 은 [`Tab::title`] 에 대한 **부분일치·대소문자 무시**다 (대상 탭이
    ///   `OSC 0` 으로 정한 제목).
    /// - **송신자 자신은 제외**한다 (자기 stdin 에 되먹임 금지).
    /// - 0건이면 [`SendTargetError::NoMatch`], 2건 이상이면
    ///   [`SendTargetError::Ambiguous`] — **첫 매치를 고르지 않는다.** 엉뚱한 pane 에
    ///   명령이 들어가는 것보다 아무 데도 안 가는 쪽이 낫다 (오발사 방지).
    /// - Exited 탭·뷰어 탭·세션 없는 탭은 애초에 후보가 아니다 (쓸 stdin 이 없다).
    ///
    /// 빈 `target` 은 모든 제목에 부분일치하므로, 후보가 정확히 하나일 때만 전달되고
    /// 그 외에는 위 규칙대로 거부된다 (별도 특례를 두지 않는다).
    ///
    /// # 워크스페이스 격리 (사용자 결정 2026-08-11)
    ///
    /// **워크스페이스는 프로젝트 격리 단위다.** 채널이 그 경계를 넘으면, 잘못 겨눈
    /// 한 줄이 지금 하는 일과 아무 상관없는 프로젝트의 셸에서 실행될 수 있다 —
    /// 오발사 반경이 격리 단위 밖까지 불필요하게 넓어진다. 그래서 송신자 세션이
    /// 실린 탭의 워크스페이스를 먼저 찾고([`Self::workspace_index_of_session`]),
    /// 후보를 그 워크스페이스 하나로 한정한다.
    ///
    /// 이 경계는 **제목 매칭과 id 직지정 양쪽에 똑같이** 걸린다: 안정 ID 가 전역
    /// 유일하다는 사실은 주소의 성질이지 경계를 뚫는 열쇠가 아니므로, 다른
    /// 워크스페이스의 `#id` 도 [`SendTargetError::NoMatch`] 다. 송신자 세션이 어느
    /// 탭에도 없으면(이론상 불가 — OSC 를 낸 살아 있는 세션이다) 경계를 정할 수
    /// 없으므로 조용히 전 워크스페이스로 넓어지지 않고 역시 NoMatch 다.
    ///
    /// 열거([`Self::list_tabs`])도 같은 경계를 쓴다 — 보이는 것과 닿는 것이 어긋나면
    /// 에이전트가 목록에서 고른 대상이 말없이 실패한다.
    ///
    /// # id 주소지정 (`#<u64>`)
    ///
    /// `#` 뒤가 **10진 숫자만으로 이루어져 `u64` 로 파싱될 때에만** id 모드다. 그
    /// 파싱이 실패하면(`#build`·`#`·`#1.2`·범위 초과 숫자) 아무 일도 없었던 것처럼
    /// **제목 매칭으로 되돌아간다** — 제목이 `#` 로 시작하는 탭을 제목으로 부르는
    /// 길을 죽이지 않기 위해서다.
    ///
    /// id 모드의 판정은 위 제목 규칙과 같은 가드를 그대로 쓰되 결과가 이분법이다:
    /// 그 id 의 탭이 **송신자의 워크스페이스에** 존재하고 running 터미널이며 송신자
    /// 자신이 아니면 배달, 아니면 [`SendTargetError::NoMatch`] 다. 안정 ID 는 전역
    /// 유일하므로 [`SendTargetError::Ambiguous`] 가 나올 수 없다.
    ///
    /// 에이전트는 자기 탭 id 를 `MAST_TAB` 환경변수로 알고 있고, 열거
    /// ([`Self::list_tabs`])가 상대의 id 를 준다 — 제목이 겹치거나 자주 바뀌는
    /// 상황에서도 흔들리지 않는 주소가 이 형태다.
    pub fn resolve_send_target(
        &self,
        sender: SessionId,
        target: &str,
    ) -> Result<SessionId, SendTargetError> {
        // 격리 경계부터 정한다 — 못 정하면 아무 데도 보내지 않는다 (rustdoc
        // "워크스페이스 격리").
        let Some(wi) = self.workspace_index_of_session(sender) else {
            return Err(SendTargetError::NoMatch);
        };
        if let Some(tab) = parse_tab_id_target(target) {
            return self.resolve_send_target_by_id(wi, sender, tab);
        }
        // 한국어 등 대소문자가 없는 문자도 그대로 통과하도록 Unicode lowercase 를 쓴다.
        let needle = target.to_lowercase();
        let mut first = None;
        let mut count = 0usize;
        for pane in self.state.workspaces[wi].panes.values() {
            for tab in &pane.tabs {
                let TabKind::Terminal {
                    pty_session: Some(session),
                    status: TerminalStatus::Running,
                    ..
                } = &tab.kind
                else {
                    continue;
                };
                if *session == sender || !tab.title.to_lowercase().contains(&needle) {
                    continue;
                }
                count += 1;
                first.get_or_insert(*session);
            }
        }
        match count {
            0 => Err(SendTargetError::NoMatch),
            1 => Ok(first.expect("count 1 이면 매치가 기록돼 있다")),
            count => Err(SendTargetError::Ambiguous { count }),
        }
    }

    /// id 직지정 경로 ([`Self::resolve_send_target`] 의 `#<u64>` 모드). 안정 ID 는
    /// 전역 유일하므로 판정이 이분법이다 — 조건을 하나라도 어기면
    /// [`SendTargetError::NoMatch`] 이고 `Ambiguous` 는 발생하지 않는다.
    ///
    /// `wi` 는 호출자가 이미 정한 **송신자의 워크스페이스** 인덱스다 — 순회가 그
    /// 하나로 제한되므로 다른 워크스페이스의 id 는 "없는 id" 와 같은 취급을 받는다
    /// (전역 유일한 id 로도 경계를 넘지 못한다는 계약의 구현 지점).
    fn resolve_send_target_by_id(
        &self,
        wi: usize,
        sender: SessionId,
        target: TabId,
    ) -> Result<SessionId, SendTargetError> {
        for pane in self.state.workspaces[wi].panes.values() {
            for tab in &pane.tabs {
                if tab.id != target {
                    continue;
                }
                // 제목 경로와 같은 가드: running 터미널 + 세션 보유 + 송신자 아님.
                let TabKind::Terminal {
                    pty_session: Some(session),
                    status: TerminalStatus::Running,
                    ..
                } = &tab.kind
                else {
                    return Err(SendTargetError::NoMatch);
                };
                if *session == sender {
                    return Err(SendTargetError::NoMatch);
                }
                return Ok(*session);
            }
        }
        Err(SendTargetError::NoMatch)
    }

    /// **요청자와 같은 워크스페이스**에 열려 있는 탭의 메타데이터 열거 — 순수
    /// 조회다 (상태·revision 불변).
    ///
    /// 에이전트 질의 채널(`mast-query;list-tabs`)의 데이터 원천이다. 범위는
    /// 전송([`Self::resolve_send_target`])의 워크스페이스 격리를 그대로 따른다 —
    /// 열거는 실질적으로 "어디로 보낼 수 있나"의 후보 목록이라, 두 표면의 경계가
    /// 어긋나면 에이전트가 목록에서 고른 대상이 무음으로 실패한다. `requester`
    /// 세션이 어느 탭에도 없으면 경계를 정할 수 없으므로 **빈 목록**이다.
    ///
    /// 터미널이 아닌 **뷰어 탭도 포함**한다 — 에이전트가 "무엇이 열려 있나"를 보는
    /// 창이지 "어디로 보낼 수 있나" 목록이 아니기 때문이다. 보낼 수 있는지는
    /// [`TabInfo::status`] 로 드러난다.
    ///
    /// 순서는 pane id 순 → 탭 순(pane 안의 표시 순서)이다.
    ///
    /// [`TabInfo`] 의 `workspace_id`/`workspace_name` 은 그대로 유지한다: 이제 모든
    /// 행이 같은 값을 갖지만 "내가 어느 워크스페이스에 있나"라는 문맥이고, 회신
    /// 스키마를 깎으면 이미 배포된 CLI 가 깨진다 (JSON 출구 계약 불변).
    ///
    /// 여기 실리는 것은 **모델이 아는 메타데이터뿐**이다. 각 탭에서 실제로 도는
    /// 명령 같은 것은 코어가 모르고(무 I/O), 필요하면 상위 계층이 `/proc` 에서
    /// 채운다.
    pub fn list_tabs(&self, requester: SessionId) -> Vec<TabInfo> {
        let mut out = Vec::new();
        let Some(wi) = self.workspace_index_of_session(requester) else {
            return out;
        };
        let ws = &self.state.workspaces[wi];
        for pane in ws.panes.values() {
            for tab in &pane.tabs {
                let (kind, status) = match &tab.kind {
                    TabKind::Terminal { status, .. } => (
                        "terminal",
                        match status {
                            TerminalStatus::Running => "running",
                            TerminalStatus::Exited { .. } => "exited",
                            TerminalStatus::NotStarted => "not-started",
                        },
                    ),
                    // 뷰어 탭에는 프로세스가 없다 — 세 번째 상태로 구분한다.
                    TabKind::FolderBrowser { .. } => ("folderBrowser", "viewer"),
                    TabKind::TextViewer { .. } => ("textViewer", "viewer"),
                    TabKind::MarkdownViewer { .. } => ("markdownViewer", "viewer"),
                };
                out.push(TabInfo {
                    tab: tab.id.0,
                    title: tab.title.clone(),
                    workspace_id: ws.id.0,
                    workspace_name: ws.name.clone(),
                    pane: pane.id.0,
                    active: pane.active_tab == Some(tab.id),
                    kind,
                    status,
                });
            }
        }
        out
    }

    /// adopt 된 상태의 터미널 탭 하나에 새 셸을 재스폰한다 — manage-first 부팅의
    /// 탭별 단계 (글루가 회당 lock 으로 호출, 계획 0장).
    ///
    /// - 대상은 세 가지다. **(a) Running 터미널 탭이면서 `pty_session` 이 None** 인
    ///   탭(부팅 복원 경로 — 글루가 [`Self::running_terminal_tabs`] 스냅샷에서 뽑는다),
    ///   **(b) `NotStarted` 탭**(사용자 재시도 경로), **(c) `Exited` 탭**(죽은 셸
    ///   되살리기 — ADR-0010). (b)·(c)는 아직 세션 id 를 물고 있을 수 있어 — (b)는 감지가
    ///   세션을 죽이지 않아서, (c)는 replay 표시를 위해 죽은 세션의 id 를 남겨 두어서 —
    ///   새로 띄우기 전에 `host.kill` 로 정리한다(멱등 계약이라 이미 죽은 세션에도
    ///   무해하고, 레지스트리에서 지워져야 이후 attach 가 옛 id 로 새지 않는다).
    ///   재시작 복원 뒤라면 persist 가 `pty_session` 을 비워 두므로 None 인 채로 온다.
    ///   그 외(미지 id·Running 인데 세션 있음)는 [`CommandError::UnknownTarget`] 이고
    ///   상태·revision 은 불변이다.
    ///
    ///   (c)가 대상인 이유: 셸이 앱보다 먼저 죽는 경우(PC 절전·`wsl --shutdown`·WSL OOM·
    ///   사용자의 `exit`)에 탭을 되살릴 길이 아예 없었다. 같은 탭 id 로 다시 스폰하므로
    ///   `HISTFILE` 과 resume 힌트가 그대로 다시 붙는다 — 죽은 에이전트 세션을 ↑ 한 번으로
    ///   resume 할 수 있다는 것이 이 경로의 요점이다.
    /// - 스폰은 cwd = 탭 cwd(없으면 워크스페이스 root_path), distro = 워크스페이스
    ///   기본값, 80×24, history_tab = 이 탭의 id — [`Command::CreateTab`] 과 같은
    ///   스폰 경로를 공유한다. 탭에 기록된 cwd 는 바꾸지 않는다 (생성 시점 값
    ///   보존 — 계획 0장 충실도 한계 명시).
    /// - 성공 시 `pty_session` 에 새 id 를 채우고, **스폰 실패 시 그 탭을
    ///   `Exited { code: None }` 으로 강등한다** — dispatch 의 "실패 = 상태 불변"
    ///   계약과 달리 강등 자체가 설계된 결과 상태다. 성공·강등 어느 쪽이든
    ///   `revision += 1` 로 스냅샷에 전파된다.
    pub fn respawn_tab(&mut self, tab: TabId) -> Result<SessionId, CommandError> {
        let (wi, pane, ti) = self.locate_tab(tab)?;
        // 적격성 검사 — 통과 못 하면 상태·revision 불변으로 에러.
        let (tab_cwd, stale) = match &self.state.workspaces[wi].panes[&pane].tabs[ti].kind {
            TabKind::Terminal {
                pty_session: None,
                status: TerminalStatus::Running,
                cwd,
            } => (cwd.clone(), None),
            TabKind::Terminal {
                pty_session,
                status: TerminalStatus::NotStarted | TerminalStatus::Exited { .. },
                cwd,
            } => (cwd.clone(), *pty_session),
            _ => return Err(unknown("respawnable tab", tab.0)),
        };
        // 새 셸을 띄우기 전에 정리한다 — 남겨 두면 이 탭이 놓아 버린 세션이 되고,
        // 실기 사고에서 몇 시간을 살아남은 좀비가 정확히 그런 것이었다.
        if let Some(old) = stale {
            self.host.kill(old);
        }
        // 재스폰은 탭 id 가 이미 있으므로 peek 없이 그대로 넘긴다 — 같은 탭이면
        // 재시작 전후로 같은 HISTFILE 을 다시 물게 되는 것이 이 기능의 요점이다.
        let spawned = self.spawn_terminal(wi, tab_cwd, tab.0);
        let pane_ref = self.state.workspaces[wi]
            .panes
            .get_mut(&pane)
            .expect("locate_tab 이 존재를 보장");
        let TabKind::Terminal {
            pty_session,
            status,
            ..
        } = &mut pane_ref.tabs[ti].kind
        else {
            unreachable!("적격성 검사를 통과한 terminal 탭");
        };
        let result = match spawned {
            Ok((session, _effective_cwd)) => {
                *pty_session = Some(session);
                // NotStarted·Exited 에서 온 재시도는 여기서 정상으로 돌아온다. 부팅 복원
                // 경로는 이미 Running 이라 이 대입이 아무것도 바꾸지 않는다.
                *status = TerminalStatus::Running;
                Ok(session)
            }
            Err(err) => {
                // 스폰 실패 강등. NotStarted·Exited 에서 온 재시도는 위에서 옛 세션을 kill 했고
                // host 가 레지스트리에서도 지웠으므로, 그 id 를 남기면 이후 attach 가
                // 미지 세션으로 실패한다 — Exited 탭이 세션 id 를 유지하는 이유(replay
                // attach)를 만족하지 못하는 id 다.
                *pty_session = None;
                *status = TerminalStatus::Exited { code: None };
                Err(err)
            }
        };
        self.state.revision += 1;
        for ws in &self.state.workspaces {
            ws.debug_assert_invariants();
        }
        result
    }

    fn execute(&mut self, cmd: Command) -> Result<CommandOutput, CommandError> {
        match cmd {
            Command::CreateWorkspace {
                name,
                root_path,
                distro,
                tab,
            } => {
                // Windows 스토리지(/mnt)는 워크스페이스 루트가 될 수 없다 (사용자
                // 결정 2026-08-11): 드라이브는 뷰어로 데이터를 가져올 때만 쓰는
                // 읽기 표면이고, 워크스페이스(셸·에이전트 작업)는 WSL 파일시스템에
                // 산다. 픽커·Ctrl+Shift+N 이 먼저 거르지만 dev 훅·MCP 경유까지
                // 막으려면 코어가 최종 관문이어야 한다. 뷰어 경로(NavigateFolder·
                // 뷰어 탭)는 이 규칙의 대상이 아니다.
                if let Some(path) = root_path.as_deref() {
                    if path == "/mnt" || path.starts_with("/mnt/") {
                        return Err(CommandError::InvalidPath {
                            message: format!(
                                "workspace root cannot live under /mnt (Windows drives are \
                                 data-only): {path}"
                            ),
                        });
                    }
                }
                // 원자성: 탭 동반 생성은 준비 단계(terminal = spawn, 뷰어 = 경로
                // 검증)를 **모든 상태 변이보다 먼저** 수행한다 (CreateTab 과 동일
                // 한 순서) — 실패 시 워크스페이스·pane·next_id·revision 전부
                // 불변이다. 워크스페이스가 아직 상태에 없으므로 기본값
                // (root_path·distro)을 직접 넘긴다.
                //
                // history_tab: 스폰이 id 발급보다 먼저이므로 이 핸들러의 할당 순서
                // (workspace → pane → tab)를 반영해 탭이 받게 될 id 를 peek 한다.
                let history_tab = self.state.peek_id(2);
                let prepared = match tab {
                    Some(spec) => {
                        Some(self.prepare_tab_with(&root_path, &distro, spec, history_tab)?)
                    }
                    None => None,
                };
                let workspace = WorkspaceId(self.state.alloc_id());
                let pane = PaneId(self.state.alloc_id());
                let tab_id = prepared.as_ref().map(|_| TabId(self.state.alloc_id()));
                if let Some(tab_id) = tab_id {
                    // 할당 순서가 바뀌면 peek 이 어긋난다 — 여기서 즉시 터뜨려
                    // 커플링을 드러낸다 (peek_id rustdoc).
                    debug_assert_eq!(tab_id.0, history_tab, "peek 한 탭 id 와 실제 발급 불일치");
                }
                let session = prepared.as_ref().and_then(PreparedTab::session);
                let mut initial = empty_pane(pane);
                if let (Some(tab_id), Some(prepared)) = (tab_id, prepared) {
                    initial.tabs.push(prepared.into_tab(tab_id));
                    initial.active_tab = Some(tab_id);
                }
                self.state.workspaces.push(Workspace {
                    id: workspace,
                    name,
                    root_path,
                    distro,
                    git_branch: None,
                    git_dirty: None,
                    layout: SplitTree::Leaf { pane },
                    panes: [(pane, initial)].into(),
                    active_pane: pane,
                    agent_status: AgentStatus::Idle,
                    last_agent_message: None,
                    agent_status_source: None,
                });
                self.state.active_workspace = Some(workspace);
                Ok(CommandOutput::WorkspaceCreated {
                    workspace,
                    pane,
                    tab: tab_id,
                    session,
                })
            }

            Command::SwitchWorkspace { workspace } => {
                let ws = self
                    .state
                    .workspace_mut(workspace)
                    .ok_or_else(|| unknown("workspace", workspace.0))?;
                // "가시화 = 읽음": 전환하면 각 pane 의 active_tab 이 곧바로 화면에
                // 드러나므로 그 탭들의 unread 를 내린다 (비활성 탭은 그대로).
                clear_visible_unread(ws);
                self.state.active_workspace = Some(workspace);
                Ok(CommandOutput::Done)
            }

            Command::CloseWorkspace { workspace } => {
                let wi = self
                    .state
                    .workspaces
                    .iter()
                    .position(|ws| ws.id == workspace)
                    .ok_or_else(|| unknown("workspace", workspace.0))?;
                let removed = self.state.workspaces.remove(wi);
                self.retire_tabs(
                    removed.distro.as_deref(),
                    removed.panes.values().flat_map(|pane| &pane.tabs),
                );
                if self.state.active_workspace == Some(workspace) {
                    // 닫은 워크스페이스가 active 였으면 남은 것 중 첫 번째로,
                    // 없으면 None (마지막 워크스페이스 닫기 허용). fallback 으로
                    // 드러나는 워크스페이스에는 SwitchWorkspace 와 같은
                    // "가시화 = 읽음" 규칙을 적용한다 (18단계 리뷰 finding).
                    self.state.active_workspace = self.state.workspaces.first().map(|ws| ws.id);
                    if let Some(shown) = self.state.workspaces.first_mut() {
                        clear_visible_unread(shown);
                    }
                }
                Ok(CommandOutput::Done)
            }

            Command::RenameWorkspace { workspace, name } => {
                // 값 검증을 대상 탐색보다 먼저 (ResizeSplit·NavigateFolder 와 같은
                // 순서) — 실패 시 상태·revision 불변.
                if name.trim().is_empty() {
                    return Err(CommandError::InvalidName {
                        message: "workspace name must not be empty or whitespace only".to_owned(),
                    });
                }
                let ws = self
                    .state
                    .workspace_mut(workspace)
                    .ok_or_else(|| unknown("workspace", workspace.0))?;
                // 바꾸는 것은 워크스페이스 이름뿐이다 — 탭 제목(OSC 2 소유)은
                // 건드리지 않는다.
                ws.name = name;
                Ok(CommandOutput::Done)
            }

            Command::MoveWorkspace { workspace, before } => {
                // 검증을 전부 마친 뒤에 옮긴다 — 중간에 실패하면 반쯤 옮겨진
                // 목록이 남는다 ("실패 시 상태 불변" 계약, 모듈 doc).
                let from = self
                    .state
                    .workspaces
                    .iter()
                    .position(|ws| ws.id == workspace)
                    .ok_or_else(|| unknown("workspace", workspace.0))?;
                if let Some(target) = before {
                    if target == workspace {
                        // 자기 앞 = 제자리. 옮길 것이 없다 (variant rustdoc).
                        return Ok(CommandOutput::Done);
                    }
                    if !self.state.workspaces.iter().any(|ws| ws.id == target) {
                        return Err(unknown("workspace", target.0));
                    }
                }

                let moved = self.state.workspaces.remove(from);
                // 삽입 위치는 **뺀 뒤의** 목록에서 다시 찾는다. 빼기 전 인덱스를
                // 그대로 쓰면 뒤로 옮길 때 한 칸씩 어긋난다.
                let at = match before {
                    None => self.state.workspaces.len(),
                    Some(target) => self
                        .state
                        .workspaces
                        .iter()
                        .position(|ws| ws.id == target)
                        .expect("위에서 존재를 확인했고 그 뒤로 목록은 remove 뿐이다"),
                };
                self.state.workspaces.insert(at, moved);
                Ok(CommandOutput::Done)
            }

            Command::FocusPane { pane } => {
                let wi = self.ws_index_of_pane(pane)?;
                self.state.workspaces[wi].active_pane = pane;
                Ok(CommandOutput::Done)
            }

            Command::SplitPane {
                pane,
                direction,
                tab,
            } => {
                let wi = self.ws_index_of_pane(pane)?;
                // 원자성: 탭 동반 분할은 준비 단계(terminal = spawn, 뷰어 = 경로
                // 검증)를 **모든 상태 변이보다 먼저** 수행한다 (CreateTab 과 동일
                // 한 순서) — 실패 시 트리·panes·next_id 가 전부 불변이라 분할만
                // 된 중간 상태가 없다.
                //
                // history_tab: 이 핸들러의 할당 순서(pane → split → tab)를 반영해
                // 탭이 받게 될 id 를 peek 한다 (CreateWorkspace 와 같은 방식).
                let history_tab = self.state.peek_id(2);
                let prepared = match tab {
                    Some(spec) => Some(self.prepare_tab(wi, spec, history_tab)?),
                    None => None,
                };
                let new_pane = PaneId(self.state.alloc_id());
                let split_id = SplitId(self.state.alloc_id());
                let tab_id = prepared.as_ref().map(|_| TabId(self.state.alloc_id()));
                if let Some(tab_id) = tab_id {
                    debug_assert_eq!(tab_id.0, history_tab, "peek 한 탭 id 와 실제 발급 불일치");
                }
                let session = prepared.as_ref().and_then(PreparedTab::session);
                let ws = &mut self.state.workspaces[wi];
                let split_ok = ws.layout.split(pane, direction, new_pane, split_id);
                debug_assert!(split_ok, "불변식: panes 의 pane 은 layout leaf 로 존재");
                let mut created = empty_pane(new_pane);
                if let (Some(tab_id), Some(prepared)) = (tab_id, prepared) {
                    created.tabs.push(prepared.into_tab(tab_id));
                    created.active_tab = Some(tab_id);
                }
                ws.panes.insert(new_pane, created);
                ws.active_pane = new_pane;
                Ok(CommandOutput::PaneCreated {
                    pane: new_pane,
                    split: split_id,
                    tab: tab_id,
                    session,
                })
            }

            Command::ResizeSplit { split, ratio } => {
                if !(ratio.is_finite() && 0.0 < ratio && ratio < 1.0) {
                    return Err(CommandError::InvalidRatio { ratio });
                }
                // split id 도 전 워크스페이스 범위 탐색 (안정 ID 전역 유일).
                let found = self
                    .state
                    .workspaces
                    .iter_mut()
                    .any(|ws| ws.layout.set_ratio(split, ratio));
                if !found {
                    return Err(unknown("split", split.0));
                }
                Ok(CommandOutput::Done)
            }

            Command::ClosePane { pane } => {
                let wi = self.ws_index_of_pane(pane)?;
                if self.state.workspaces[wi].panes.len() <= 1 {
                    return Err(CommandError::LastPane);
                }
                let removed = collapse_pane(&mut self.state.workspaces[wi], pane);
                for tab in &removed.tabs {
                    // 사라지는 탭이 워크스페이스 상태의 출처면 Idle 로 되돌린다
                    // (pane 하나에 여러 탭이 있을 수 있어 제거되는 탭 전부 확인).
                    reset_agent_source(&mut self.state.workspaces[wi], tab.id);
                }
                let distro = self.state.workspaces[wi].distro.clone();
                self.retire_tabs(distro.as_deref(), removed.tabs.iter());
                Ok(CommandOutput::Done)
            }

            Command::CreateTab { pane, tab } => {
                let wi = self.ws_index_of_pane(pane)?;
                // 원자성: 준비 단계(spawn·경로 검증) 실패 시 상태(탭·next_id)가
                // 변하지 않도록 준비를 먼저 마친다.
                //
                // history_tab: 이 핸들러는 탭 id 만 발급하므로 peek offset 0.
                let history_tab = self.state.peek_id(0);
                let prepared = self.prepare_tab(wi, tab, history_tab)?;
                let session = prepared.session();
                let tab_id = TabId(self.state.alloc_id());
                debug_assert_eq!(tab_id.0, history_tab, "peek 한 탭 id 와 실제 발급 불일치");
                let pane_ref = self.state.workspaces[wi]
                    .panes
                    .get_mut(&pane)
                    .expect("ws_index_of_pane 이 존재를 보장");
                pane_ref.tabs.push(prepared.into_tab(tab_id));
                pane_ref.active_tab = Some(tab_id);
                Ok(CommandOutput::TabCreated {
                    tab: tab_id,
                    session,
                })
            }

            Command::ActivateTab { tab } => {
                let (wi, pane, ti) = self.locate_tab(tab)?;
                let pane_ref = self.state.workspaces[wi]
                    .panes
                    .get_mut(&pane)
                    .expect("locate_tab 이 존재를 보장");
                pane_ref.active_tab = Some(tab);
                // "가시화 = 읽음" — 활성화된 탭의 unread 는 여기서 내려간다.
                pane_ref.tabs[ti].notification = NotificationState::None;
                Ok(CommandOutput::Done)
            }

            Command::CloseTab { tab } => {
                let (wi, pane, ti) = self.locate_tab(tab)?;
                let ws = &mut self.state.workspaces[wi];
                let pane_ref = ws.panes.get_mut(&pane).expect("locate_tab 이 존재를 보장");
                let removed = pane_ref.tabs.remove(ti);
                if pane_ref.active_tab == Some(tab) {
                    // 직전 탭으로 조정. 첫 탭이었으면 (제거 후 index 0 에 온) 다음
                    // 탭, 마지막 남은 탭이었으면 None.
                    pane_ref.active_tab = if pane_ref.tabs.is_empty() {
                        None
                    } else {
                        Some(pane_ref.tabs[ti.saturating_sub(1)].id)
                    };
                    // 승격도 가시화다 (18단계 리뷰 finding): 이 워크스페이스가
                    // 보이는 중이면 화면에 드러난 승격 탭의 unread 를 내린다.
                    if self.state.active_workspace == Some(ws.id) {
                        if let Some(promoted) = pane_ref.active_tab {
                            if let Some(t) = pane_ref.tabs.iter_mut().find(|t| t.id == promoted) {
                                t.notification = NotificationState::None;
                            }
                        }
                    }
                }
                // auto-collapse (계획 D6): 마지막 탭이 닫혀 pane 이 비면 pane 자체
                // 를 collapse 한다 — 단 워크스페이스의 마지막 pane 은 예외로 빈
                // pane 으로 남긴다 (variant rustdoc 의 규칙 명세 참조).
                if pane_ref.tabs.is_empty() && ws.panes.len() > 1 {
                    let collapsed = collapse_pane(ws, pane);
                    debug_assert!(collapsed.tabs.is_empty(), "빈 pane 만 collapse 대상");
                }
                // 닫힌 탭이 워크스페이스 상태의 출처면 Idle 로 되돌린다.
                reset_agent_source(ws, tab);
                let distro = ws.distro.clone();
                self.retire_tabs(distro.as_deref(), std::iter::once(&removed));
                Ok(CommandOutput::Done)
            }

            Command::NavigateFolder { tab, path } => {
                // 값 검증을 대상 탐색보다 먼저 (ResizeSplit 과 같은 순서).
                validate_viewer_path(&path)?;
                let title = path_title(&path);
                let (wi, pane, ti) = self.locate_tab(tab)?;
                let tab_ref = &mut self.state.workspaces[wi]
                    .panes
                    .get_mut(&pane)
                    .expect("locate_tab 이 존재를 보장")
                    .tabs[ti];
                let TabKind::FolderBrowser { path: current } = &mut tab_ref.kind else {
                    return Err(CommandError::KindMismatch { tab });
                };
                *current = path;
                // 제목도 새 경로의 basename 으로 따라간다 (탭 스트립 표시).
                tab_ref.title = title;
                Ok(CommandOutput::Done)
            }

            Command::SetViewerScroll { tab, scroll_top } => {
                if !(scroll_top.is_finite() && scroll_top >= 0.0) {
                    return Err(CommandError::InvalidScroll { value: scroll_top });
                }
                let (wi, pane, ti) = self.locate_tab(tab)?;
                let tab_ref = &mut self.state.workspaces[wi]
                    .panes
                    .get_mut(&pane)
                    .expect("locate_tab 이 존재를 보장")
                    .tabs[ti];
                // folderBrowser·terminal 은 모델에 스크롤 위치가 없다 — 조용한
                // no-op 대신 KindMismatch 로 드러낸다. 값의 단위는 종류마다
                // 다르지만(byte offset vs px) 코어는 f64 를 그대로 보관한다.
                let (TabKind::TextViewer {
                    scroll_top: current,
                    ..
                }
                | TabKind::MarkdownViewer {
                    scroll_top: current,
                    ..
                }) = &mut tab_ref.kind
                else {
                    return Err(CommandError::KindMismatch { tab });
                };
                *current = scroll_top;
                Ok(CommandOutput::Done)
            }
        }
    }

    /// 워크스페이스 기본값(root_path·distro)을 적용한 [`Self::prepare_tab_with`]
    /// — 이미 상태에 있는 워크스페이스(CreateTab·SplitPane)용.
    fn prepare_tab(
        &self,
        wi: usize,
        spec: NewTab,
        history_tab: u64,
    ) -> Result<PreparedTab, CommandError> {
        let ws = &self.state.workspaces[wi];
        self.prepare_tab_with(&ws.root_path, &ws.distro, spec, history_tab)
    }

    /// 탭 생성의 **앞단** — terminal 은 셸 스폰, 뷰어는 경로 기본값 해석 + 형태
    /// 검증. 세 생성 지점(CreateTab·SplitPane·CreateWorkspace)이 공유하며,
    /// 호출자는 **모든 상태 변이 전에** 이걸 마쳐 실패 시 상태 불변을 보장한다
    /// (뷰어는 스폰이 없어도 InvalidPath 로 실패할 수 있다 — 계획 21단계).
    ///
    /// `history_tab` 은 이 탭이 **받게 될** 안정 ID 다 — 스폰이 발급보다 먼저라
    /// 호출자가 [`AppState::peek_id`] 로 미리 읽어 넘긴다 (뷰어 탭은 스폰이 없어
    /// 쓰지 않는다).
    fn prepare_tab_with(
        &self,
        root_path: &Option<String>,
        distro: &Option<String>,
        spec: NewTab,
        history_tab: u64,
    ) -> Result<PreparedTab, CommandError> {
        match spec {
            NewTab::Terminal { cwd } => {
                let (session, cwd) =
                    self.spawn_terminal_with(root_path, distro, cwd, history_tab)?;
                Ok(PreparedTab::Terminal { session, cwd })
            }
            NewTab::FolderBrowser { path } => {
                // 이중 기본값: 탭 path → 워크스페이스 root_path → "/".
                let path = path
                    .or_else(|| root_path.clone())
                    .unwrap_or_else(|| "/".to_owned());
                validate_viewer_path(&path)?;
                Ok(PreparedTab::Viewer {
                    title: path_title(&path),
                    kind: TabKind::FolderBrowser { path },
                })
            }
            NewTab::TextViewer { path } => {
                validate_viewer_path(&path)?;
                Ok(PreparedTab::Viewer {
                    title: path_title(&path),
                    // 새 탭은 항상 파일 선두에서 시작한다 (복원은 persist 몫).
                    kind: TabKind::TextViewer {
                        path,
                        scroll_top: 0.0,
                    },
                })
            }
            NewTab::MarkdownViewer { path } => {
                validate_viewer_path(&path)?;
                Ok(PreparedTab::Viewer {
                    title: path_title(&path),
                    // TextViewer 와 같이 문서 선두(px 0)에서 시작한다.
                    kind: TabKind::MarkdownViewer {
                        path,
                        scroll_top: 0.0,
                    },
                })
            }
        }
    }

    /// 워크스페이스 기본값(cwd·distro)을 적용해 터미널 셸을 스폰한다 — CreateTab·
    /// SplitPane(tab 포함)이 공유하는 spawn-first 원자성의 앞단: **모든 상태 변이
    /// 전에** 호출해 실패 시 상태 불변을 보장한다. 탭 cwd 미지정 시 워크스페이스
    /// root_path 가 기본 (계획 v2 4장). 반환: (세션 id, 탭에 기록할 실제 cwd).
    fn spawn_terminal(
        &self,
        wi: usize,
        cwd: Option<String>,
        history_tab: u64,
    ) -> Result<(SessionId, Option<String>), CommandError> {
        let ws = &self.state.workspaces[wi];
        self.spawn_terminal_with(&ws.root_path, &ws.distro, cwd, history_tab)
    }

    /// [`Self::spawn_terminal`] 의 기본값 명시 버전 — CreateWorkspace(tab 포함)는
    /// 워크스페이스가 아직 상태에 없어 인덱스 대신 만들려는 값의 기본값을 직접
    /// 넘긴다 (spawn-first 계약은 동일).
    fn spawn_terminal_with(
        &self,
        root_path: &Option<String>,
        distro: &Option<String>,
        cwd: Option<String>,
        history_tab: u64,
    ) -> Result<(SessionId, Option<String>), CommandError> {
        let cwd = cwd.or_else(|| root_path.clone());
        let req = ShellSpawnReq {
            cwd: cwd.clone(),
            distro: distro.clone(),
            history_tab: Some(history_tab),
            ..ShellSpawnReq::default()
        };
        let session = self
            .host
            .spawn_shell(req)
            .map_err(|e| CommandError::SpawnFailed {
                message: e.to_string(),
            })?;
        Ok((session, cwd))
    }

    /// 영구히 사라지는 탭들의 정리 — terminal 탭마다 소속 세션을 kill 하고, 그
    /// 탭들의 셸측 자원 해제를 호스트에 **한 번** 알린다. 뷰어 탭은 어느 쪽도 아니다.
    ///
    /// kill 은 status 와 무관하다 (이미 Exited 여도 무해 — `SessionHost::kill` 은
    /// 멱등 계약). 해제 통지는 세션 유무와도 무관하다: 스폰이 실패했거나 시작 표식이
    /// 오지 않아 세션이 없는 탭도 자기 `HISTFILE` 은 이미 만들어져 있을 수 있다.
    ///
    /// kill 이 먼저인 것은 순서 계약이다 — 셸은 종료할 때 `HISTFILE` 을 쓰므로,
    /// 지우기부터 하면 죽어 가는 셸이 파일을 되살린다. 반대 순서라면 남는 경합은
    /// "kill 통지가 셸에 닿기 전에 해제가 끝나는" 경우뿐인데, 해제는 WSL 왕복이라
    /// 셸의 종료 flush 보다 자릿수가 느리다.
    fn retire_tabs<'a>(&self, distro: Option<&str>, tabs: impl Iterator<Item = &'a Tab>) {
        let mut released = Vec::new();
        for tab in tabs {
            let TabKind::Terminal { pty_session, .. } = &tab.kind else {
                continue;
            };
            if let Some(s) = pty_session {
                self.host.kill(*s);
            }
            released.push(tab.id);
        }
        if !released.is_empty() {
            self.host.release_tabs(&released, distro);
        }
    }

    /// `pane` 을 소유한 워크스페이스의 인덱스 (전 워크스페이스 범위 탐색).
    fn ws_index_of_pane(&self, pane: PaneId) -> Result<usize, CommandError> {
        self.state
            .workspaces
            .iter()
            .position(|ws| ws.panes.contains_key(&pane))
            .ok_or_else(|| unknown("pane", pane.0))
    }

    /// `session` 이 실린 탭의 (워크스페이스 인덱스, pane id, tab 인덱스).
    /// 세션 id 는 탭 하나에만 실리므로 첫 일치에서 멈춘다. 미지 세션은 None —
    /// 호출자(OSC 반영)가 no-op 으로 처리한다.
    fn locate_session(&self, session: SessionId) -> Option<(usize, PaneId, usize)> {
        for (wi, ws) in self.state.workspaces.iter().enumerate() {
            for (pid, pane) in &ws.panes {
                let found = pane.tabs.iter().position(|t| {
                    matches!(
                        t.kind,
                        TabKind::Terminal {
                            pty_session: Some(s),
                            ..
                        } if s == session
                    )
                });
                if let Some(ti) = found {
                    return Some((wi, *pid, ti));
                }
            }
        }
        None
    }

    /// `session` 이 실린 탭이 속한 **워크스페이스 인덱스** — 에이전트 채널
    /// ([`Self::resolve_send_target`]·[`Self::list_tabs`])의 격리 경계 기준점이다.
    /// 역매핑은 [`Self::locate_session`] 을 그대로 재사용하고 pane·tab 위치만
    /// 버린다. 미지 세션은 None — 호출자가 각각 NoMatch·빈 목록으로 닫는다.
    fn workspace_index_of_session(&self, session: SessionId) -> Option<usize> {
        self.locate_session(session).map(|(wi, _, _)| wi)
    }

    /// `tab` 을 소유한 (워크스페이스 인덱스, pane id, tab 인덱스).
    fn locate_tab(&self, tab: TabId) -> Result<(usize, PaneId, usize), CommandError> {
        for (wi, ws) in self.state.workspaces.iter().enumerate() {
            for (pid, pane) in &ws.panes {
                if let Some(ti) = pane.tabs.iter().position(|t| t.id == tab) {
                    return Ok((wi, *pid, ti));
                }
            }
        }
        Err(unknown("tab", tab.0))
    }
}

/// 탭 생성 앞단([`Dispatcher::prepare_tab_with`])의 결과 — terminal 은 스폰된
/// 세션과 실제 cwd, 뷰어는 검증을 마친 제목·종류. 어느 쪽이든 상태 변이 전에
/// 만들어지므로 이 값이 손에 들어온 시점에는 "실패할 일이 남아 있지 않다".
enum PreparedTab {
    Terminal {
        session: SessionId,
        cwd: Option<String>,
    },
    Viewer {
        title: String,
        kind: TabKind,
    },
}

impl PreparedTab {
    /// 발급된 안정 ID 로 탭 값을 완성한다.
    fn into_tab(self, id: TabId) -> Tab {
        match self {
            PreparedTab::Terminal { session, cwd } => terminal_tab(id, session, cwd),
            PreparedTab::Viewer { title, kind } => viewer_tab(id, title, kind),
        }
    }

    /// 출력(`TabCreated` 등)에 실을 세션 id — 뷰어 탭은 None.
    fn session(&self) -> Option<SessionId> {
        match self {
            PreparedTab::Terminal { session, .. } => Some(*session),
            PreparedTab::Viewer { .. } => None,
        }
    }
}

fn empty_pane(id: PaneId) -> Pane {
    Pane {
        id,
        tabs: Vec::new(),
        active_tab: None,
    }
}

/// 갓 스폰된 터미널 세션의 탭 값 — CreateTab·SplitPane·CreateWorkspace(tab
/// 포함)가 공유한다.
fn terminal_tab(id: TabId, session: SessionId, cwd: Option<String>) -> Tab {
    Tab {
        id,
        title: "Terminal".to_owned(),
        kind: TabKind::Terminal {
            pty_session: Some(session),
            status: TerminalStatus::Running,
            cwd,
        },
        notification: NotificationState::None,
        last_activity_ms: None,
    }
}

/// 갓 만들어진 뷰어 탭의 값 — [`terminal_tab`] 의 뷰어 짝 (CreateTab·SplitPane·
/// CreateWorkspace 공유). 스폰이 없으므로 순수 변이다.
fn viewer_tab(id: TabId, title: String, kind: TabKind) -> Tab {
    Tab {
        id,
        title,
        kind,
        notification: NotificationState::None,
        last_activity_ms: None,
    }
}

/// 뷰어 경로의 형태 검증 — 사유 문자열을 그대로 [`CommandError::InvalidPath`] 에
/// 싣는다 (생성·NavigateFolder 공유). 실존 여부는 검사하지 않는다 (코어 무 I/O —
/// 없는 경로는 뷰 로드 실패로 표면화).
fn validate_viewer_path(path: &str) -> Result<(), CommandError> {
    crate::wslpath::validate_linux_path(path)
        .map_err(|message| CommandError::InvalidPath { message })
}

/// 경로에서 탭 제목으로 쓸 basename 을 뽑는다. 빈 세그먼트(`//`·후행 `/`)는
/// 건너뛰고, 남는 컴포넌트가 없으면(루트) `"/"` 를 쓴다.
fn path_title(path: &str) -> String {
    path.rsplit('/')
        .find(|component| !component.is_empty())
        .unwrap_or("/")
        .to_owned()
}

/// pane 을 워크스페이스에서 제거한다: panes remove + tree collapse(형제 승격) +
/// active_pane fixup(닫힌 pane 이 포커스였으면 collapse 후 leaf 순서상 첫 pane
/// 으로). ClosePane 과 CloseTab auto-collapse 가 공유한다 (계획 D6).
///
/// # 호출자 계약
///
/// - `pane` 은 `ws.panes` 에 존재해야 하고, 워크스페이스의 마지막 pane 이면 안
///   된다 (루트 단일 leaf 는 collapse 불가 — ClosePane 은 `LastPane` 으로, CloseTab
///   은 빈 pane 예외로 사전에 거른다).
/// - 반환된 Pane 소속 탭들의 세션 kill 은 호출자 책임이다.
fn collapse_pane(ws: &mut Workspace, pane: PaneId) -> Pane {
    let removed = ws.panes.remove(&pane).expect("호출자가 pane 존재를 보장");
    let collapse_ok = ws.layout.remove(pane);
    debug_assert!(collapse_ok, "불변식: panes 의 pane 은 layout leaf 로 존재");
    if ws.active_pane == pane {
        ws.active_pane = ws.layout.leaves()[0];
    }
    removed
}

/// 사라지는 탭이 워크스페이스 `agent_status` 의 출처였으면 상태를 Idle 로 되돌린다
/// (18단계 계획 core 계약). 죽은 탭의 needsInput 이 사이드바에 남아 영원히 입력
/// 대기로 보이는 것을 막는 규칙이라, 탭이 사라지는 세 경로(`CloseTab`·`ClosePane`
/// 의 제거 탭 각각·`SessionExited`)가 전부 이 헬퍼를 거친다.
/// 반환값은 상태가 바뀌었는가 (revision 판정용).
fn reset_agent_source(ws: &mut Workspace, tab: TabId) -> bool {
    if ws.agent_status_source != Some(tab) {
        return false;
    }
    ws.agent_status_source = None;
    ws.agent_status = AgentStatus::Idle;
    true
}

/// "가시화 = 읽음" 의 워크스페이스 단위 적용 — 이 워크스페이스가 화면에 드러나는
/// 순간(SwitchWorkspace·CloseWorkspace fallback) 각 pane 의 active_tab unread 를
/// 내린다 (비활성 탭은 그대로). 탭 단위 짝은 ActivateTab·CloseTab 승격이다.
fn clear_visible_unread(ws: &mut Workspace) {
    for pane in ws.panes.values_mut() {
        let Some(active) = pane.active_tab else {
            continue;
        };
        if let Some(tab) = pane.tabs.iter_mut().find(|t| t.id == active) {
            tab.notification = NotificationState::None;
        }
    }
}

fn unknown(kind: &str, id: u64) -> CommandError {
    CommandError::UnknownTarget {
        target: format!("{kind} {id}"),
    }
}

/// 전송 대상 문자열이 `#<u64>` 형태면 탭 id 로 파싱한다
/// ([`Dispatcher::resolve_send_target`] 의 id 모드 판정).
///
/// `#` 뒤는 **10진 숫자만** 받는다 — `+5`·공백처럼 `u64::from_str` 이 관대하게
/// 받아 주는 형태까지 id 로 삼으면 "무엇이 id 이고 무엇이 제목인가"의 경계가
/// 흐려진다. 파싱이 실패하면 None 이고, 호출자는 제목 매칭으로 되돌아간다.
fn parse_tab_id_target(target: &str) -> Option<TabId> {
    let digits = target.strip_prefix('#')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok().map(TabId)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::osc::OscEvent;

    /// 테스트용 fake 호스트 — 스폰 id 순차 발급(1부터), kill·스폰·해제 통지 기록,
    /// 스폰 실패 주입.
    #[derive(Default)]
    struct FakeHostInner {
        next_session: AtomicU32,
        kills: Mutex<Vec<SessionId>>,
        spawns: Mutex<Vec<ShellSpawnReq>>,
        /// `release_tabs` 호출 한 번이 원소 하나 — 배치 계약(호출 횟수)까지
        /// 검사할 수 있게 탭 목록을 평탄화하지 않는다.
        releases: Mutex<Vec<(Vec<TabId>, Option<String>)>>,
        fail_spawn: AtomicBool,
    }

    #[derive(Clone, Default)]
    struct FakeSessionHost(Arc<FakeHostInner>);

    impl FakeSessionHost {
        fn kills(&self) -> Vec<SessionId> {
            self.0.kills.lock().unwrap().clone()
        }

        fn spawns(&self) -> Vec<ShellSpawnReq> {
            self.0.spawns.lock().unwrap().clone()
        }

        fn releases(&self) -> Vec<(Vec<TabId>, Option<String>)> {
            self.0.releases.lock().unwrap().clone()
        }

        fn set_fail_spawn(&self, fail: bool) {
            self.0.fail_spawn.store(fail, Ordering::SeqCst);
        }
    }

    impl SessionHost for FakeSessionHost {
        fn spawn_shell(&self, req: ShellSpawnReq) -> anyhow::Result<SessionId> {
            if self.0.fail_spawn.load(Ordering::SeqCst) {
                anyhow::bail!("injected spawn failure");
            }
            self.0.spawns.lock().unwrap().push(req);
            Ok(self.0.next_session.fetch_add(1, Ordering::SeqCst) + 1)
        }

        fn kill(&self, id: SessionId) {
            self.0.kills.lock().unwrap().push(id);
        }

        fn release_tabs(&self, tabs: &[TabId], distro: Option<&str>) {
            self.0
                .releases
                .lock()
                .unwrap()
                .push((tabs.to_vec(), distro.map(str::to_string)));
        }
    }

    fn dispatcher() -> (Dispatcher, FakeSessionHost) {
        let host = FakeSessionHost::default();
        (Dispatcher::new(Box::new(host.clone())), host)
    }

    /// 워크스페이스 1개(tab 없음)를 만들고 (workspace, 초기 pane) id 를
    /// 돌려주는 헬퍼.
    fn create_ws(d: &mut Dispatcher, name: &str) -> (WorkspaceId, PaneId) {
        match d
            .dispatch(Command::CreateWorkspace {
                name: name.into(),
                root_path: None,
                distro: None,
                tab: None,
            })
            .unwrap()
        {
            CommandOutput::WorkspaceCreated {
                workspace,
                pane,
                tab: None,
                session: None,
            } => (workspace, pane),
            other => panic!("unexpected output: {other:?}"),
        }
    }

    fn create_terminal_tab(d: &mut Dispatcher, pane: PaneId) -> (TabId, SessionId) {
        match d
            .dispatch(Command::CreateTab {
                pane,
                tab: NewTab::Terminal { cwd: None },
            })
            .unwrap()
        {
            CommandOutput::TabCreated {
                tab,
                session: Some(s),
            } => (tab, s),
            other => panic!("unexpected output: {other:?}"),
        }
    }

    /// 탭 없는 분할 헬퍼 — (새 pane, 새 split 노드) id 를 돌려준다.
    fn split_empty(
        d: &mut Dispatcher,
        pane: PaneId,
        direction: SplitDirection,
    ) -> (PaneId, SplitId) {
        match d
            .dispatch(Command::SplitPane {
                pane,
                direction,
                tab: None,
            })
            .unwrap()
        {
            CommandOutput::PaneCreated {
                pane,
                split,
                tab: None,
                session: None,
            } => (pane, split),
            other => panic!("unexpected output: {other:?}"),
        }
    }

    #[test]
    fn create_workspace_makes_empty_pane_and_activates() {
        let (mut d, _host) = dispatcher();
        let out = d
            .dispatch(Command::CreateWorkspace {
                name: "ws".into(),
                root_path: Some("/proj".into()),
                distro: Some("Ubuntu".into()),
                tab: None,
            })
            .unwrap();
        assert_eq!(
            out,
            CommandOutput::WorkspaceCreated {
                workspace: WorkspaceId(1),
                pane: PaneId(2),
                tab: None,
                session: None,
            }
        );
        let ws = d.state().workspace(WorkspaceId(1)).unwrap();
        assert_eq!(ws.layout, SplitTree::Leaf { pane: PaneId(2) });
        assert_eq!(ws.active_pane, PaneId(2));
        assert_eq!(ws.agent_status, AgentStatus::Idle);
        assert!(ws.panes[&PaneId(2)].tabs.is_empty());
        assert_eq!(ws.panes[&PaneId(2)].active_tab, None);
        assert_eq!(d.state().active_workspace, Some(WorkspaceId(1)));
        assert_eq!(d.state().revision, 1);
        assert_eq!(d.state().next_id, 3);
    }

    #[test]
    fn create_workspace_with_tab_creates_tab_atomically() {
        let (mut d, host) = dispatcher();
        let out = d
            .dispatch(Command::CreateWorkspace {
                name: "ws".into(),
                root_path: Some("/proj".into()),
                distro: Some("Ubuntu".into()),
                tab: Some(NewTab::Terminal { cwd: None }),
            })
            .unwrap();
        // 생성된 안정 ID 전부 반환 (계획 13-D1) — 발급 순서는 workspace →
        // pane → tab.
        let CommandOutput::WorkspaceCreated {
            workspace,
            pane,
            tab: Some(tab),
            session: Some(session),
        } = out
        else {
            panic!("unexpected output: {out:?}");
        };
        assert!(workspace.0 < pane.0 && pane.0 < tab.0);

        let w = d.state().workspace(workspace).unwrap();
        assert_eq!(w.layout, SplitTree::Leaf { pane });
        assert_eq!(w.active_pane, pane);
        let p = &w.panes[&pane];
        assert_eq!(p.tabs.len(), 1);
        assert_eq!(p.tabs[0].id, tab);
        assert_eq!(p.active_tab, Some(tab));
        let TabKind::Terminal {
            pty_session,
            status,
            cwd,
        } = &p.tabs[0].kind
        else {
            panic!("terminal 탭이 아님");
        };
        assert_eq!(*pty_session, Some(session));
        assert_eq!(*status, TerminalStatus::Running);
        // cwd 미지정 → 워크스페이스 root_path 상속, distro 도 워크스페이스
        // 기본값 — CreateTab·SplitPane 과 공유하는 스폰 경로.
        assert_eq!(cwd.as_deref(), Some("/proj"));
        assert_eq!(host.spawns()[0].cwd.as_deref(), Some("/proj"));
        assert_eq!(host.spawns()[0].distro.as_deref(), Some("Ubuntu"));
        assert_eq!(d.state().active_workspace, Some(workspace));
        assert_eq!(d.state().revision, 1);
    }

    #[test]
    fn create_workspace_with_tab_spawn_failure_leaves_state_untouched() {
        let (mut d, host) = dispatcher();
        // 기존 워크스페이스를 하나 두어 active_workspace 불변까지 함께 잠근다.
        create_ws(&mut d, "existing");
        host.set_fail_spawn(true);
        let before = serde_json::to_value(d.state()).unwrap();

        let err = d
            .dispatch(Command::CreateWorkspace {
                name: "ws".into(),
                root_path: None,
                distro: None,
                tab: Some(NewTab::Terminal { cwd: None }),
            })
            .unwrap_err();
        assert!(matches!(err, CommandError::SpawnFailed { .. }));
        // 워크스페이스·pane·next_id·revision 전부 불변 (spawn-first 원자성).
        let after = serde_json::to_value(d.state()).unwrap();
        assert_eq!(before, after, "spawn 실패가 상태를 바꿈 (원자성 위반)");
    }

    #[test]
    fn create_workspace_tab_field_missing_deserializes_to_none() {
        // 하위호환 (계획 13-D1): 13단계 이전 클라이언트의 tab 필드 없는 JSON 은
        // tab: None 으로 파싱된다 (fixture 쪽 잠금은 dispatcher.rs 참조).
        let cmd: Command = serde_json::from_str(
            r#"{ "type": "createWorkspace", "name": "ws", "rootPath": null, "distro": null }"#,
        )
        .unwrap();
        assert_eq!(
            cmd,
            Command::CreateWorkspace {
                name: "ws".into(),
                root_path: None,
                distro: None,
                tab: None,
            }
        );
    }

    #[test]
    fn full_flow_kills_sessions_and_collapses() {
        let (mut d, host) = dispatcher();
        let (ws, pane1) = create_ws(&mut d, "ws");

        // 분할(탭 없음) → 새 빈 pane 이 second 로 생기고 포커스 이동.
        let (pane2, split_id) = split_empty(&mut d, pane1, SplitDirection::Vertical);
        {
            let w = d.state().workspace(ws).unwrap();
            assert_eq!(w.active_pane, pane2);
            assert_eq!(w.layout.leaves(), vec![pane1, pane2]);
            assert_eq!(w.layout.split_ids(), vec![split_id]);
        }

        // 탭 3개: pane1 에 1개, pane2 에 2개.
        let (_tab1, s1) = create_terminal_tab(&mut d, pane1);
        let (tab2, s2) = create_terminal_tab(&mut d, pane2);
        let (tab3, s3) = create_terminal_tab(&mut d, pane2);
        assert_eq!((s1, s2, s3), (1, 2, 3));
        assert_eq!(
            d.state().workspace(ws).unwrap().panes[&pane2].active_tab,
            Some(tab3)
        );

        // 탭 닫기 → 그 세션만 kill, active_tab 은 직전 탭으로.
        d.dispatch(Command::CloseTab { tab: tab3 }).unwrap();
        assert_eq!(host.kills(), vec![s3]);
        assert_eq!(
            d.state().workspace(ws).unwrap().panes[&pane2].active_tab,
            Some(tab2)
        );

        // pane 닫기 → 남은 세션 kill + tree collapse + 포커스 회귀.
        d.dispatch(Command::ClosePane { pane: pane2 }).unwrap();
        assert_eq!(host.kills(), vec![s3, s2]);
        {
            let w = d.state().workspace(ws).unwrap();
            assert_eq!(w.layout, SplitTree::Leaf { pane: pane1 });
            assert_eq!(w.active_pane, pane1);
        }

        // 워크스페이스 닫기 → 남은 세션 전부 kill, active 는 None.
        d.dispatch(Command::CloseWorkspace { workspace: ws })
            .unwrap();
        assert_eq!(host.kills(), vec![s3, s2, s1]);
        assert!(d.state().workspaces.is_empty());
        assert_eq!(d.state().active_workspace, None);

        // revision 은 dispatch 성공 횟수(8)와 일치 — 단조 증가.
        assert_eq!(d.state().revision, 8);
    }

    #[test]
    fn exited_tab_close_still_kills_session() {
        // "kill 은 status 무관" 의미론 고정 — 자연 종료(SessionExited 반영)된
        // 탭을 닫아도 host.kill 이 호출된다 (kill 은 멱등 계약이라 늦은 호출 무해).
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (tab, session) = create_terminal_tab(&mut d, pane);
        d.apply_event(SessionEvent::SessionExited {
            session,
            code: Some(0),
        });
        d.dispatch(Command::CloseTab { tab }).unwrap();
        assert_eq!(host.kills(), vec![session]);
    }

    #[test]
    fn close_last_pane_is_rejected() {
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let rev = d.state().revision;
        let err = d.dispatch(Command::ClosePane { pane }).unwrap_err();
        assert_eq!(err, CommandError::LastPane);
        assert_eq!(d.state().revision, rev);
        assert!(host.kills().is_empty());
        assert!(d.state().workspaces[0].panes.contains_key(&pane));
    }

    #[test]
    fn unknown_targets_error_without_state_change() {
        let (mut d, _host) = dispatcher();
        create_ws(&mut d, "ws");
        let rev = d.state().revision;
        let cases = [
            Command::SwitchWorkspace {
                workspace: WorkspaceId(99),
            },
            Command::CloseWorkspace {
                workspace: WorkspaceId(99),
            },
            Command::FocusPane { pane: PaneId(99) },
            Command::SplitPane {
                pane: PaneId(99),
                direction: SplitDirection::Horizontal,
                tab: None,
            },
            Command::ResizeSplit {
                split: SplitId(99),
                ratio: 0.5,
            },
            Command::ClosePane { pane: PaneId(99) },
            Command::CreateTab {
                pane: PaneId(99),
                tab: NewTab::Terminal { cwd: None },
            },
            Command::ActivateTab { tab: TabId(99) },
            Command::CloseTab { tab: TabId(99) },
            Command::NavigateFolder {
                tab: TabId(99),
                path: "/proj".into(),
            },
            Command::SetViewerScroll {
                tab: TabId(99),
                scroll_top: 0.0,
            },
        ];
        for cmd in cases {
            let err = d.dispatch(cmd.clone()).unwrap_err();
            assert!(
                matches!(err, CommandError::UnknownTarget { .. }),
                "{cmd:?} → {err:?}"
            );
            assert_eq!(d.state().revision, rev, "{cmd:?} 가 상태를 바꿈");
        }
    }

    #[test]
    fn spawn_failure_leaves_state_untouched() {
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        host.set_fail_spawn(true);
        let before = serde_json::to_value(d.state()).unwrap();
        let err = d
            .dispatch(Command::CreateTab {
                pane,
                tab: NewTab::Terminal { cwd: None },
            })
            .unwrap_err();
        assert!(matches!(err, CommandError::SpawnFailed { .. }));
        let after = serde_json::to_value(d.state()).unwrap();
        assert_eq!(before, after, "spawn 실패가 상태를 바꿈 (원자성 위반)");
    }

    #[test]
    fn resize_split_updates_ratio() {
        let (mut d, _host) = dispatcher();
        let (ws, pane1) = create_ws(&mut d, "ws");
        let (_pane2, split_id) = split_empty(&mut d, pane1, SplitDirection::Horizontal);
        let rev = d.state().revision;

        let out = d
            .dispatch(Command::ResizeSplit {
                split: split_id,
                ratio: 0.25,
            })
            .unwrap();
        assert_eq!(out, CommandOutput::Done);
        assert_eq!(d.state().revision, rev + 1);
        let SplitTree::Split { id, ratio, .. } = &d.state().workspace(ws).unwrap().layout else {
            panic!("split 이어야 함");
        };
        assert_eq!(*id, split_id);
        assert_eq!(*ratio, 0.25);
    }

    #[test]
    fn resize_split_reaches_inactive_workspace() {
        // split id 탐색은 전 워크스페이스 범위 — 비활성 워크스페이스의 split 도
        // id 로 조준된다 (안정 ID 전역 유일).
        let (mut d, _host) = dispatcher();
        let (ws1, pane1) = create_ws(&mut d, "one");
        let (_pane2, split_id) = split_empty(&mut d, pane1, SplitDirection::Vertical);
        let (ws2, _) = create_ws(&mut d, "two");
        assert_eq!(d.state().active_workspace, Some(ws2));

        d.dispatch(Command::ResizeSplit {
            split: split_id,
            ratio: 0.7,
        })
        .unwrap();
        let SplitTree::Split { ratio, .. } = &d.state().workspace(ws1).unwrap().layout else {
            panic!("split 이어야 함");
        };
        assert_eq!(*ratio, 0.7);
    }

    #[test]
    fn resize_split_stale_id_is_unknown_target() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane1) = create_ws(&mut d, "ws");
        let (pane2, split_id) = split_empty(&mut d, pane1, SplitDirection::Horizontal);
        // collapse 로 split 노드가 사라진 뒤 옛 id 로 resize — 스테일 주소.
        d.dispatch(Command::ClosePane { pane: pane2 }).unwrap();
        let rev = d.state().revision;

        let err = d
            .dispatch(Command::ResizeSplit {
                split: split_id,
                ratio: 0.5,
            })
            .unwrap_err();
        assert!(matches!(err, CommandError::UnknownTarget { .. }), "{err:?}");
        assert_eq!(d.state().revision, rev);
    }

    #[test]
    fn resize_split_invalid_ratio_rejected_without_state_change() {
        let (mut d, _host) = dispatcher();
        let (ws, pane1) = create_ws(&mut d, "ws");
        let (_pane2, split_id) = split_empty(&mut d, pane1, SplitDirection::Horizontal);
        let rev = d.state().revision;

        // 개구간 (0, 1) 밖·비유한 값 전부 InvalidRatio — 경계 0.0·1.0 포함.
        for ratio in [f64::NAN, 0.0, 1.0, -0.25, 1.5, f64::INFINITY] {
            let err = d
                .dispatch(Command::ResizeSplit {
                    split: split_id,
                    ratio,
                })
                .unwrap_err();
            assert!(
                matches!(err, CommandError::InvalidRatio { .. }),
                "ratio {ratio} → {err:?}"
            );
            assert_eq!(d.state().revision, rev, "ratio {ratio} 가 상태를 바꿈");
        }
        let SplitTree::Split { ratio, .. } = &d.state().workspace(ws).unwrap().layout else {
            panic!("split 이어야 함");
        };
        assert_eq!(*ratio, 0.5, "실패한 resize 가 ratio 를 바꿈");
    }

    #[test]
    fn split_pane_with_tab_creates_pane_and_tab_atomically() {
        let (mut d, host) = dispatcher();
        let out = d
            .dispatch(Command::CreateWorkspace {
                name: "ws".into(),
                root_path: Some("/proj".into()),
                distro: Some("Ubuntu".into()),
                tab: None,
            })
            .unwrap();
        let CommandOutput::WorkspaceCreated {
            workspace: ws,
            pane: pane1,
            ..
        } = out
        else {
            panic!("unexpected output: {out:?}");
        };

        let out = d
            .dispatch(Command::SplitPane {
                pane: pane1,
                direction: SplitDirection::Vertical,
                tab: Some(NewTab::Terminal { cwd: None }),
            })
            .unwrap();
        // 생성된 안정 ID 전부 반환 (계획 D5) — 발급 순서는 pane → split → tab.
        let CommandOutput::PaneCreated {
            pane: pane2,
            split,
            tab: Some(tab),
            session: Some(session),
        } = out
        else {
            panic!("unexpected output: {out:?}");
        };
        assert!(pane2.0 < split.0 && split.0 < tab.0);

        let w = d.state().workspace(ws).unwrap();
        assert_eq!(w.active_pane, pane2);
        assert_eq!(w.layout.leaves(), vec![pane1, pane2]);
        assert_eq!(w.layout.split_ids(), vec![split]);
        let p2 = &w.panes[&pane2];
        assert_eq!(p2.tabs.len(), 1);
        assert_eq!(p2.active_tab, Some(tab));
        let TabKind::Terminal {
            pty_session,
            status,
            cwd,
        } = &p2.tabs[0].kind
        else {
            panic!("terminal 탭이 아님");
        };
        assert_eq!(*pty_session, Some(session));
        assert_eq!(*status, TerminalStatus::Running);
        // 워크스페이스 기본값(cwd·distro) 적용 — CreateTab 과 공유하는 스폰 경로.
        assert_eq!(cwd.as_deref(), Some("/proj"));
        assert_eq!(host.spawns()[0].cwd.as_deref(), Some("/proj"));
        assert_eq!(host.spawns()[0].distro.as_deref(), Some("Ubuntu"));
    }

    #[test]
    fn split_pane_with_tab_spawn_failure_leaves_state_untouched() {
        let (mut d, host) = dispatcher();
        let (_ws, pane1) = create_ws(&mut d, "ws");
        host.set_fail_spawn(true);
        let before = serde_json::to_value(d.state()).unwrap();

        let err = d
            .dispatch(Command::SplitPane {
                pane: pane1,
                direction: SplitDirection::Horizontal,
                tab: Some(NewTab::Terminal { cwd: None }),
            })
            .unwrap_err();
        assert!(matches!(err, CommandError::SpawnFailed { .. }));
        // 트리·panes·next_id·revision 전부 불변 (spawn-first 원자성).
        let after = serde_json::to_value(d.state()).unwrap();
        assert_eq!(before, after, "spawn 실패가 상태를 바꿈 (원자성 위반)");
    }

    #[test]
    fn close_last_tab_collapses_pane_and_fixes_focus() {
        // multi-pane 워크스페이스에서 pane 의 마지막 탭 닫기 → 세션 kill +
        // collapse + active_pane fixup (계획 D6).
        let (mut d, host) = dispatcher();
        let (ws, pane1) = create_ws(&mut d, "ws");
        let out = d
            .dispatch(Command::SplitPane {
                pane: pane1,
                direction: SplitDirection::Horizontal,
                tab: Some(NewTab::Terminal { cwd: None }),
            })
            .unwrap();
        let CommandOutput::PaneCreated {
            pane: pane2,
            tab: Some(tab2),
            session: Some(s2),
            ..
        } = out
        else {
            panic!("unexpected output: {out:?}");
        };
        assert_eq!(d.state().workspace(ws).unwrap().active_pane, pane2);

        d.dispatch(Command::CloseTab { tab: tab2 }).unwrap();
        assert_eq!(host.kills(), vec![s2]);
        let w = d.state().workspace(ws).unwrap();
        assert_eq!(w.layout, SplitTree::Leaf { pane: pane1 });
        assert!(!w.panes.contains_key(&pane2));
        // 닫힌 pane 이 포커스였으므로 leaf 순서상 첫 pane 으로 fixup.
        assert_eq!(w.active_pane, pane1);
    }

    #[test]
    fn close_last_tab_of_inactive_pane_collapses_and_keeps_focus() {
        let (mut d, host) = dispatcher();
        let (ws, pane1) = create_ws(&mut d, "ws");
        let out = d
            .dispatch(Command::SplitPane {
                pane: pane1,
                direction: SplitDirection::Vertical,
                tab: Some(NewTab::Terminal { cwd: None }),
            })
            .unwrap();
        let CommandOutput::PaneCreated {
            pane: pane2,
            tab: Some(tab2),
            session: Some(s2),
            ..
        } = out
        else {
            panic!("unexpected output: {out:?}");
        };
        // 포커스를 pane1 로 되돌린 뒤 비활성 pane2 의 마지막 탭을 닫는다.
        d.dispatch(Command::FocusPane { pane: pane1 }).unwrap();

        d.dispatch(Command::CloseTab { tab: tab2 }).unwrap();
        assert_eq!(host.kills(), vec![s2]);
        let w = d.state().workspace(ws).unwrap();
        assert_eq!(w.layout, SplitTree::Leaf { pane: pane1 });
        assert!(!w.panes.contains_key(&pane2));
        // 포커스는 원래부터 pane1 — fixup 없이 그대로.
        assert_eq!(w.active_pane, pane1);
    }

    #[test]
    fn create_tab_uses_workspace_defaults_for_spawn() {
        let (mut d, host) = dispatcher();
        let out = d
            .dispatch(Command::CreateWorkspace {
                name: "ws".into(),
                root_path: Some("/proj".into()),
                distro: Some("Ubuntu".into()),
                tab: None,
            })
            .unwrap();
        let CommandOutput::WorkspaceCreated { pane, .. } = out else {
            panic!("unexpected output: {out:?}");
        };

        // cwd 미지정 → root_path 상속, cols/rows 는 기본 80×24.
        create_terminal_tab(&mut d, pane);
        // cwd 명시 → 그대로 사용.
        d.dispatch(Command::CreateTab {
            pane,
            tab: NewTab::Terminal {
                cwd: Some("/elsewhere".into()),
            },
        })
        .unwrap();

        let spawns = host.spawns();
        assert_eq!(
            spawns[0],
            ShellSpawnReq {
                cwd: Some("/proj".into()),
                distro: Some("Ubuntu".into()),
                cols: 80,
                rows: 24,
                // 워크스페이스(1)·pane(2) 다음 발급이므로 첫 탭은 3.
                history_tab: Some(3),
            }
        );
        assert_eq!(spawns[1].cwd, Some("/elsewhere".into()));

        // 탭에도 실제 적용된 cwd 가 기록된다.
        let ws = &d.state().workspaces[0];
        let TabKind::Terminal { cwd, .. } = &ws.panes[&pane].tabs[0].kind else {
            panic!("terminal 탭이 아님");
        };
        assert_eq!(cwd.as_deref(), Some("/proj"));
    }

    /// 탭별 명령 history 계약 (체크포인트 2 UX): 스폰 3경로 전부에서 호스트가
    /// 받은 `history_tab` 이 **그 스폰으로 생긴 탭의 안정 ID** 와 같아야 한다.
    /// 스폰이 id 발급보다 먼저라 peek 으로 계산하는 값이므로, 할당 순서가 바뀌면
    /// 핸들러의 debug_assert 와 이 테스트가 함께 터진다.
    #[test]
    fn spawn_carries_history_tab_of_the_created_tab() {
        let (mut d, host) = dispatcher();
        // 1) CreateWorkspace(tab 동반) — 발급 순서 workspace → pane → tab.
        let out = d
            .dispatch(Command::CreateWorkspace {
                name: "ws".into(),
                root_path: None,
                distro: None,
                tab: Some(NewTab::Terminal { cwd: None }),
            })
            .unwrap();
        let CommandOutput::WorkspaceCreated {
            pane,
            tab: Some(ws_tab),
            ..
        } = out
        else {
            panic!("unexpected output: {out:?}");
        };
        // 2) CreateTab — 탭 id 만 발급.
        let (created_tab, _session) = create_terminal_tab(&mut d, pane);
        // 3) SplitPane(tab 동반) — 발급 순서 pane → split → tab.
        let out = d
            .dispatch(Command::SplitPane {
                pane,
                direction: SplitDirection::Vertical,
                tab: Some(NewTab::Terminal { cwd: None }),
            })
            .unwrap();
        let CommandOutput::PaneCreated {
            tab: Some(split_tab),
            ..
        } = out
        else {
            panic!("unexpected output: {out:?}");
        };

        let history: Vec<Option<u64>> = host.spawns().iter().map(|r| r.history_tab).collect();
        assert_eq!(
            history,
            vec![Some(ws_tab.0), Some(created_tab.0), Some(split_tab.0)]
        );
    }

    #[test]
    fn close_tab_adjusts_active_to_previous() {
        let (mut d, _host) = dispatcher();
        let (ws, pane) = create_ws(&mut d, "ws");
        let (tab1, _) = create_terminal_tab(&mut d, pane);
        let (tab2, _) = create_terminal_tab(&mut d, pane);
        let (tab3, _) = create_terminal_tab(&mut d, pane);

        // active(=tab3) 닫기 → 직전 탭 tab2.
        d.dispatch(Command::CloseTab { tab: tab3 }).unwrap();
        let active = |d: &Dispatcher| d.state().workspace(ws).unwrap().panes[&pane].active_tab;
        assert_eq!(active(&d), Some(tab2));

        // active 가 아닌 첫 탭 닫기 → active 유지.
        d.dispatch(Command::CloseTab { tab: tab1 }).unwrap();
        assert_eq!(active(&d), Some(tab2));

        // 마지막 탭 닫기 → 워크스페이스의 마지막 pane 이므로 collapse 예외:
        // 빈 pane (active_tab = None)으로 남는다 (계획 D6).
        d.dispatch(Command::CloseTab { tab: tab2 }).unwrap();
        assert_eq!(active(&d), None);
        let w = d.state().workspace(ws).unwrap();
        assert!(w.panes[&pane].tabs.is_empty());
        assert_eq!(w.layout, SplitTree::Leaf { pane });
        assert_eq!(w.active_pane, pane);
    }

    #[test]
    fn close_first_tab_while_active_falls_to_next() {
        let (mut d, _host) = dispatcher();
        let (ws, pane) = create_ws(&mut d, "ws");
        let (tab1, _) = create_terminal_tab(&mut d, pane);
        let (tab2, _) = create_terminal_tab(&mut d, pane);
        d.dispatch(Command::ActivateTab { tab: tab1 }).unwrap();

        // 첫 탭이 active 인 채로 닫기 → 다음 탭(tab2)으로.
        d.dispatch(Command::CloseTab { tab: tab1 }).unwrap();
        assert_eq!(
            d.state().workspace(ws).unwrap().panes[&pane].active_tab,
            Some(tab2)
        );
    }

    #[test]
    fn focus_pane_does_not_switch_workspace() {
        let (mut d, _host) = dispatcher();
        let (ws1, _pane1) = create_ws(&mut d, "one");
        let (ws2, pane2) = create_ws(&mut d, "two");
        let (pane3, _split) = split_empty(&mut d, pane2, SplitDirection::Horizontal);

        d.dispatch(Command::SwitchWorkspace { workspace: ws1 })
            .unwrap();
        assert_eq!(d.state().active_workspace, Some(ws1));
        assert_eq!(d.state().workspace(ws2).unwrap().active_pane, pane3);

        // 비활성 워크스페이스의 pane 포커스 — 그 워크스페이스의 active_pane 만
        // 바뀌고 active_workspace 는 그대로 (명령 직교성).
        d.dispatch(Command::FocusPane { pane: pane2 }).unwrap();
        assert_eq!(d.state().active_workspace, Some(ws1));
        assert_eq!(d.state().workspace(ws2).unwrap().active_pane, pane2);
    }

    #[test]
    fn close_active_workspace_falls_back_to_first_remaining() {
        let (mut d, _host) = dispatcher();
        let (ws1, _) = create_ws(&mut d, "one");
        let (ws2, _) = create_ws(&mut d, "two");
        assert_eq!(d.state().active_workspace, Some(ws2));
        d.dispatch(Command::CloseWorkspace { workspace: ws2 })
            .unwrap();
        assert_eq!(d.state().active_workspace, Some(ws1));

        // 비활성 워크스페이스를 닫으면 active 는 그대로.
        let (ws3, _) = create_ws(&mut d, "three");
        d.dispatch(Command::SwitchWorkspace { workspace: ws1 })
            .unwrap();
        d.dispatch(Command::CloseWorkspace { workspace: ws3 })
            .unwrap();
        assert_eq!(d.state().active_workspace, Some(ws1));
    }

    #[test]
    fn rename_workspace_updates_only_the_name() {
        let (mut d, _host) = dispatcher();
        let (ws, pane) = create_ws(&mut d, "one");
        let (tab, _session) = create_terminal_tab(&mut d, pane);
        let rev = d.state().revision;

        d.dispatch(Command::RenameWorkspace {
            workspace: ws,
            name: "renamed".into(),
        })
        .unwrap();

        assert_eq!(d.state().workspace(ws).unwrap().name, "renamed");
        assert_eq!(d.state().revision, rev + 1);
        // 탭 제목은 워크스페이스 이름과 별개 (OSC 2 소유).
        assert_eq!(tab_view(&d, tab).title, "Terminal");
        // 활성 워크스페이스도 그대로 — 이름 변경은 전환이 아니다.
        assert_eq!(d.state().active_workspace, Some(ws));
    }

    #[test]
    fn rename_workspace_reaches_inactive_workspace() {
        let (mut d, _host) = dispatcher();
        let (ws1, _) = create_ws(&mut d, "one");
        let (ws2, _) = create_ws(&mut d, "two");
        assert_eq!(d.state().active_workspace, Some(ws2));

        d.dispatch(Command::RenameWorkspace {
            workspace: ws1,
            name: "background".into(),
        })
        .unwrap();

        assert_eq!(d.state().workspace(ws1).unwrap().name, "background");
        assert_eq!(d.state().workspace(ws2).unwrap().name, "two");
        assert_eq!(d.state().active_workspace, Some(ws2));
    }

    #[test]
    fn rename_workspace_rejects_blank_names_without_state_change() {
        let (mut d, _host) = dispatcher();
        let (ws, _pane) = create_ws(&mut d, "one");
        let before = serde_json::to_value(d.state()).unwrap();

        for name in ["", " ", "\t\n  "] {
            let err = d
                .dispatch(Command::RenameWorkspace {
                    workspace: ws,
                    name: name.into(),
                })
                .unwrap_err();
            assert!(
                matches!(err, CommandError::InvalidName { .. }),
                "{name:?} → {err:?}"
            );
        }
        // 미지 워크스페이스는 UnknownTarget (검증은 이름이 먼저).
        let err = d
            .dispatch(Command::RenameWorkspace {
                workspace: WorkspaceId(999),
                name: "x".into(),
            })
            .unwrap_err();
        assert!(matches!(err, CommandError::UnknownTarget { .. }), "{err:?}");

        // 실패 dispatch 는 상태·revision 을 건드리지 않는다.
        assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
    }

    #[test]
    fn rename_workspace_keeps_the_given_name_verbatim() {
        // 앞뒤 공백 다듬기는 코어의 일이 아니다 (입력 UI 몫) — 공백을 **포함한**
        // 이름은 정상 값이다.
        let (mut d, _host) = dispatcher();
        let (ws, _pane) = create_ws(&mut d, "one");
        d.dispatch(Command::RenameWorkspace {
            workspace: ws,
            name: " my  project ".into(),
        })
        .unwrap();
        assert_eq!(d.state().workspace(ws).unwrap().name, " my  project ");
    }

    #[test]
    fn session_exited_marks_tab_and_keeps_session_id() {
        let (mut d, _host) = dispatcher();
        let (ws, pane) = create_ws(&mut d, "ws");
        let (_tab, session) = create_terminal_tab(&mut d, pane);
        let rev = d.state().revision;

        d.apply_event(SessionEvent::SessionExited {
            session,
            code: Some(0),
        });
        assert_eq!(d.state().revision, rev + 1);
        let TabKind::Terminal {
            pty_session,
            status,
            ..
        } = &d.state().workspace(ws).unwrap().panes[&pane].tabs[0].kind
        else {
            panic!("terminal 탭이 아님");
        };
        assert_eq!(*pty_session, Some(session), "pty_session 은 유지");
        assert_eq!(*status, TerminalStatus::Exited { code: Some(0) });

        // 동일 이벤트 재도착 → 상태 변화 없음, revision 불변.
        d.apply_event(SessionEvent::SessionExited {
            session,
            code: Some(0),
        });
        assert_eq!(d.state().revision, rev + 1);
    }

    #[test]
    fn session_exited_unknown_session_is_noop() {
        let (mut d, _host) = dispatcher();
        create_ws(&mut d, "ws");
        let before = serde_json::to_value(d.state()).unwrap();
        // CloseTab 선행 후 exit 통지가 도착하는 정상 순서 — 패닉·변이 없어야 한다.
        d.apply_event(SessionEvent::SessionExited {
            session: 999,
            code: None,
        });
        assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
    }

    #[test]
    fn revision_increases_by_one_per_successful_dispatch() {
        let (mut d, _host) = dispatcher();
        assert_eq!(d.state().revision, 0);
        let (_ws, pane) = create_ws(&mut d, "ws");
        assert_eq!(d.state().revision, 1);
        create_terminal_tab(&mut d, pane);
        assert_eq!(d.state().revision, 2);
        assert_eq!(d.snapshot().revision, 2);
    }

    // ---- 뷰어 탭 (21단계 계획 청크 A) ----

    /// root_path 를 지정해 워크스페이스를 만드는 헬퍼 (뷰어 기본값 검증용).
    fn create_ws_rooted(
        d: &mut Dispatcher,
        name: &str,
        root_path: Option<&str>,
    ) -> (WorkspaceId, PaneId) {
        match d
            .dispatch(Command::CreateWorkspace {
                name: name.into(),
                root_path: root_path.map(String::from),
                distro: None,
                tab: None,
            })
            .unwrap()
        {
            CommandOutput::WorkspaceCreated {
                workspace,
                pane,
                tab: None,
                session: None,
            } => (workspace, pane),
            other => panic!("unexpected output: {other:?}"),
        }
    }

    /// 뷰어 탭 생성 헬퍼 — 스폰이 없으므로 출력의 session 은 항상 None 이다.
    fn create_viewer_tab(d: &mut Dispatcher, pane: PaneId, spec: NewTab) -> TabId {
        match d.dispatch(Command::CreateTab { pane, tab: spec }).unwrap() {
            CommandOutput::TabCreated {
                tab,
                session: None,
            } => tab,
            other => panic!("unexpected output: {other:?}"),
        }
    }

    #[test]
    fn create_folder_browser_inherits_root_path_without_spawning() {
        let (mut d, host) = dispatcher();
        let (ws, pane) = create_ws_rooted(&mut d, "ws", Some("/proj/app"));
        let tab = create_viewer_tab(&mut d, pane, NewTab::FolderBrowser { path: None });

        assert!(host.spawns().is_empty(), "뷰어 탭 생성은 스폰이 없다");
        let t = tab_view(&d, tab);
        // path 미지정 → 워크스페이스 root_path 상속, 제목은 basename.
        assert_eq!(
            t.kind,
            TabKind::FolderBrowser {
                path: "/proj/app".into()
            }
        );
        assert_eq!(t.title, "app");
        assert_eq!(
            d.state().workspace(ws).unwrap().panes[&pane].active_tab,
            Some(tab)
        );
    }

    #[test]
    fn folder_browser_falls_back_to_root_when_both_paths_are_none() {
        // 탭 path 도 워크스페이스 root_path 도 없으면 "/" (계획 21단계 core 계약).
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let tab = create_viewer_tab(&mut d, pane, NewTab::FolderBrowser { path: None });
        let t = tab_view(&d, tab);
        assert_eq!(t.kind, TabKind::FolderBrowser { path: "/".into() });
        assert_eq!(t.title, "/");
    }

    #[test]
    fn create_text_viewer_starts_at_offset_zero() {
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws_rooted(&mut d, "ws", Some("/proj"));
        let tab = create_viewer_tab(
            &mut d,
            pane,
            NewTab::TextViewer {
                path: "/proj/notes.txt".into(),
            },
        );
        assert!(host.spawns().is_empty());
        let t = tab_view(&d, tab);
        assert_eq!(
            t.kind,
            TabKind::TextViewer {
                path: "/proj/notes.txt".into(),
                scroll_top: 0.0,
            }
        );
        assert_eq!(t.title, "notes.txt");
    }

    #[test]
    fn create_markdown_viewer_starts_at_pixel_zero() {
        // markdownViewer 는 TextViewer 와 같은 생성 계약(스폰 없음·basename 제목)
        // 이고 scroll_top 만 px 시맨틱이다 (21단계 청크 D).
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws_rooted(&mut d, "ws", Some("/proj"));
        let tab = create_viewer_tab(
            &mut d,
            pane,
            NewTab::MarkdownViewer {
                path: "/proj/README.md".into(),
            },
        );
        assert!(host.spawns().is_empty(), "뷰어 탭 생성은 스폰이 없다");
        let t = tab_view(&d, tab);
        assert_eq!(
            t.kind,
            TabKind::MarkdownViewer {
                path: "/proj/README.md".into(),
                scroll_top: 0.0,
            }
        );
        assert_eq!(t.title, "README.md");
    }

    #[test]
    fn create_workspace_and_split_pane_accept_viewer_tabs_atomically() {
        let (mut d, host) = dispatcher();
        // 워크스페이스 + 뷰어 탭 원자 생성 — session 만 None 이고 tab 은 Some.
        let out = d
            .dispatch(Command::CreateWorkspace {
                name: "ws".into(),
                root_path: Some("/proj".into()),
                distro: None,
                tab: Some(NewTab::FolderBrowser { path: None }),
            })
            .unwrap();
        let CommandOutput::WorkspaceCreated {
            workspace,
            pane,
            tab: Some(tab),
            session: None,
        } = out
        else {
            panic!("unexpected output: {out:?}");
        };
        assert!(workspace.0 < pane.0 && pane.0 < tab.0);
        let p = &d.state().workspace(workspace).unwrap().panes[&pane];
        assert_eq!(p.tabs.len(), 1);
        assert_eq!(p.active_tab, Some(tab));
        assert_eq!(
            p.tabs[0].kind,
            TabKind::FolderBrowser {
                path: "/proj".into()
            }
        );

        // 분할 + 뷰어 탭 원자 생성.
        let out = d
            .dispatch(Command::SplitPane {
                pane,
                direction: SplitDirection::Vertical,
                tab: Some(NewTab::TextViewer {
                    path: "/proj/a.txt".into(),
                }),
            })
            .unwrap();
        let CommandOutput::PaneCreated {
            pane: pane2,
            split,
            tab: Some(tab2),
            session: None,
        } = out
        else {
            panic!("unexpected output: {out:?}");
        };
        assert!(pane2.0 < split.0 && split.0 < tab2.0);
        let w = d.state().workspace(workspace).unwrap();
        assert_eq!(w.active_pane, pane2);
        assert_eq!(w.panes[&pane2].active_tab, Some(tab2));
        assert_eq!(tab_view(&d, tab2).title, "a.txt");
        assert!(host.spawns().is_empty(), "뷰어 탭 생성은 스폰이 없다");
    }

    #[test]
    fn navigate_folder_updates_path_and_title() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let tab = create_viewer_tab(
            &mut d,
            pane,
            NewTab::FolderBrowser {
                path: Some("/proj".into()),
            },
        );

        let out = d
            .dispatch(Command::NavigateFolder {
                tab,
                path: "/proj/src/model".into(),
            })
            .unwrap();
        assert_eq!(out, CommandOutput::Done);
        let t = tab_view(&d, tab);
        assert_eq!(
            t.kind,
            TabKind::FolderBrowser {
                path: "/proj/src/model".into()
            }
        );
        assert_eq!(t.title, "model");

        // 루트로 올라가면 제목도 "/" (basename 이 없는 경로).
        d.dispatch(Command::NavigateFolder {
            tab,
            path: "/".into(),
        })
        .unwrap();
        let t = tab_view(&d, tab);
        assert_eq!(t.kind, TabKind::FolderBrowser { path: "/".into() });
        assert_eq!(t.title, "/");
    }

    #[test]
    fn viewer_commands_reject_wrong_tab_kinds_without_state_change() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (terminal, _s) = create_terminal_tab(&mut d, pane);
        let folder = create_viewer_tab(
            &mut d,
            pane,
            NewTab::FolderBrowser {
                path: Some("/proj".into()),
            },
        );
        let text = create_viewer_tab(
            &mut d,
            pane,
            NewTab::TextViewer {
                path: "/proj/a.txt".into(),
            },
        );
        let markdown = create_viewer_tab(
            &mut d,
            pane,
            NewTab::MarkdownViewer {
                path: "/proj/a.md".into(),
            },
        );
        let before = serde_json::to_value(d.state()).unwrap();

        let cases = [
            // NavigateFolder 는 folderBrowser 만 받는다.
            (
                Command::NavigateFolder {
                    tab: terminal,
                    path: "/x".into(),
                },
                terminal,
            ),
            (
                Command::NavigateFolder {
                    tab: text,
                    path: "/x".into(),
                },
                text,
            ),
            (
                Command::NavigateFolder {
                    tab: markdown,
                    path: "/x".into(),
                },
                markdown,
            ),
            // SetViewerScroll 은 스크롤 위치를 모델에 가진 뷰어만 받는다 —
            // folderBrowser 는 그 필드가 없어 KindMismatch (기결정).
            (
                Command::SetViewerScroll {
                    tab: folder,
                    scroll_top: 10.0,
                },
                folder,
            ),
            (
                Command::SetViewerScroll {
                    tab: terminal,
                    scroll_top: 10.0,
                },
                terminal,
            ),
        ];
        for (cmd, target) in cases {
            let err = d.dispatch(cmd.clone()).unwrap_err();
            assert_eq!(err, CommandError::KindMismatch { tab: target }, "{cmd:?}");
            assert_eq!(
                serde_json::to_value(d.state()).unwrap(),
                before,
                "{cmd:?} 가 상태를 바꿈"
            );
        }
    }

    #[test]
    fn create_workspace_rejects_mnt_roots() {
        // Windows 스토리지는 워크스페이스 루트 금지 — /mnt 정확히·하위 경로 둘 다.
        // 접두 경계는 지킨다 (/mnta 는 무관한 디렉터리다). 거부는 상태 불변이다.
        let (mut d, _host) = dispatcher();
        let before = serde_json::to_string(&d.snapshot()).unwrap();
        for path in ["/mnt", "/mnt/c", "/mnt/c/Users/dev/code"] {
            let err = d
                .dispatch(Command::CreateWorkspace {
                    name: "w".into(),
                    root_path: Some(path.into()),
                    distro: None,
                    tab: None,
                })
                .unwrap_err();
            assert!(matches!(err, CommandError::InvalidPath { .. }), "{path}");
        }
        assert_eq!(serde_json::to_string(&d.snapshot()).unwrap(), before);
        d.dispatch(Command::CreateWorkspace {
            name: "w".into(),
            root_path: Some("/mnta/data".into()),
            distro: None,
            tab: None,
        })
        .unwrap();
    }

    #[test]
    fn viewer_paths_are_validated_on_create_and_navigate() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let folder = create_viewer_tab(
            &mut d,
            pane,
            NewTab::FolderBrowser {
                path: Some("/proj".into()),
            },
        );
        let before = serde_json::to_value(d.state()).unwrap();

        // wslpath 거부 규칙별 대표 1개씩 — 사유는 wslpath.rs 테스트가 잠근다.
        for path in [
            "relative/path",
            "/proj/../etc",
            r"/proj/a\b",
            "/proj/a:stream",
            "/proj/trailing.",
            "",
        ] {
            for cmd in [
                Command::CreateTab {
                    pane,
                    tab: NewTab::TextViewer { path: path.into() },
                },
                Command::CreateTab {
                    pane,
                    tab: NewTab::MarkdownViewer { path: path.into() },
                },
                Command::CreateTab {
                    pane,
                    tab: NewTab::FolderBrowser {
                        path: Some(path.into()),
                    },
                },
                Command::NavigateFolder {
                    tab: folder,
                    path: path.into(),
                },
            ] {
                let err = d.dispatch(cmd.clone()).unwrap_err();
                assert!(
                    matches!(err, CommandError::InvalidPath { .. }),
                    "{cmd:?} → {err:?}"
                );
                // next_id 까지 불변 (검증이 id 발급보다 먼저).
                assert_eq!(
                    serde_json::to_value(d.state()).unwrap(),
                    before,
                    "{cmd:?} 가 상태를 바꿈"
                );
            }
        }
    }

    #[test]
    fn set_viewer_scroll_records_offset_and_rejects_bad_values() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let tab = create_viewer_tab(
            &mut d,
            pane,
            NewTab::TextViewer {
                path: "/proj/a.txt".into(),
            },
        );

        let out = d
            .dispatch(Command::SetViewerScroll {
                tab,
                scroll_top: 4096.0,
            })
            .unwrap();
        assert_eq!(out, CommandOutput::Done);
        assert_eq!(
            tab_view(&d, tab).kind,
            TabKind::TextViewer {
                path: "/proj/a.txt".into(),
                scroll_top: 4096.0,
            }
        );

        // finite·0 이상이 아니면 InvalidScroll, 상태 불변 (0.0 은 유효 경계).
        let before = serde_json::to_value(d.state()).unwrap();
        for value in [f64::NAN, -1.0, f64::INFINITY, f64::NEG_INFINITY] {
            let err = d
                .dispatch(Command::SetViewerScroll {
                    tab,
                    scroll_top: value,
                })
                .unwrap_err();
            assert!(
                matches!(err, CommandError::InvalidScroll { .. }),
                "{value} → {err:?}"
            );
            assert_eq!(
                serde_json::to_value(d.state()).unwrap(),
                before,
                "{value} 가 상태를 바꿈"
            );
        }
        d.dispatch(Command::SetViewerScroll {
            tab,
            scroll_top: 0.0,
        })
        .unwrap();
    }

    #[test]
    fn set_viewer_scroll_records_pixel_offset_for_markdown_viewer() {
        // 같은 명령이 markdownViewer 도 받는다 — 값은 렌더 px 지만 코어는 단위를
        // 해석하지 않고 f64 를 그대로 보관한다 (21단계 청크 D).
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let tab = create_viewer_tab(
            &mut d,
            pane,
            NewTab::MarkdownViewer {
                path: "/proj/README.md".into(),
            },
        );

        let out = d
            .dispatch(Command::SetViewerScroll {
                tab,
                scroll_top: 120.5,
            })
            .unwrap();
        assert_eq!(out, CommandOutput::Done);
        assert_eq!(
            tab_view(&d, tab).kind,
            TabKind::MarkdownViewer {
                path: "/proj/README.md".into(),
                scroll_top: 120.5,
            }
        );

        let before = serde_json::to_value(d.state()).unwrap();
        let err = d
            .dispatch(Command::SetViewerScroll {
                tab,
                scroll_top: -1.0,
            })
            .unwrap_err();
        assert!(matches!(err, CommandError::InvalidScroll { .. }), "{err:?}");
        assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
    }

    #[test]
    fn viewer_tabs_survive_persist_round_trip() {
        // 뷰어 탭은 sanitize 대상이 아니다 — 경로·스크롤이 재시작을 넘어 남아야
        // 뷰어 재로드(계획 v2 "상태 저장")가 성립한다.
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws_rooted(&mut d, "ws", Some("/proj"));
        let (terminal, _s) = create_terminal_tab(&mut d, pane);
        let folder = create_viewer_tab(&mut d, pane, NewTab::FolderBrowser { path: None });
        let text = create_viewer_tab(
            &mut d,
            pane,
            NewTab::TextViewer {
                path: "/proj/notes.txt".into(),
            },
        );
        let markdown = create_viewer_tab(
            &mut d,
            pane,
            NewTab::MarkdownViewer {
                path: "/proj/README.md".into(),
            },
        );
        d.dispatch(Command::SetViewerScroll {
            tab: text,
            scroll_top: 4096.0,
        })
        .unwrap();
        d.dispatch(Command::SetViewerScroll {
            tab: markdown,
            scroll_top: 120.5,
        })
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        crate::persist::save_atomic(&path, d.state()).unwrap();
        let crate::persist::LoadOutcome::Restored { state, repairs } =
            crate::persist::load(&path)
        else {
            panic!("Restored 여야 함");
        };
        assert!(repairs.is_empty(), "정상 상태에 수리 사유: {repairs:?}");

        let kind_of = |state: &AppState, id: TabId| {
            state
                .workspaces
                .iter()
                .flat_map(|ws| ws.panes.values())
                .flat_map(|p| p.tabs.iter())
                .find(|t| t.id == id)
                .expect("탭이 존재해야 함")
                .kind
                .clone()
        };
        assert_eq!(
            kind_of(&state, folder),
            TabKind::FolderBrowser {
                path: "/proj".into()
            }
        );
        assert_eq!(
            kind_of(&state, text),
            TabKind::TextViewer {
                path: "/proj/notes.txt".into(),
                scroll_top: 4096.0,
            },
            "sanitize 가 뷰어 스크롤을 건드리면 안 된다"
        );
        assert_eq!(
            kind_of(&state, markdown),
            TabKind::MarkdownViewer {
                path: "/proj/README.md".into(),
                scroll_top: 120.5,
            }
        );

        // 재스폰 대상은 terminal 탭뿐 — 뷰어 탭은 열거에 끼지 않는다.
        let adopted = Dispatcher::adopt(state, Box::new(FakeSessionHost::default()));
        assert_eq!(adopted.running_terminal_tabs(), vec![terminal]);
    }

    // ---- OSC 델타 반영 (18단계 계획 core 계약) ----

    fn status_notify(token: &str, body: &str) -> OscEvent {
        OscEvent::Osc777Notify {
            title: token.into(),
            body: body.into(),
        }
    }

    /// (세션, 이벤트) 목록을 한 배치로 병합한다 — 글루의 flush 창 한 번에 해당.
    fn batch(events: &[(SessionId, OscEvent)]) -> OscBatch {
        let mut b = OscBatch::default();
        for (session, ev) in events {
            b.merge(*session, ev);
        }
        b
    }

    /// 워크스페이스의 에이전트 상태 3종 (상태, 출처 탭, 미리보기 메시지).
    fn agent(d: &Dispatcher, ws: WorkspaceId) -> (AgentStatus, Option<TabId>, Option<String>) {
        let w = d.state().workspace(ws).unwrap();
        (
            w.agent_status,
            w.agent_status_source,
            w.last_agent_message.clone(),
        )
    }

    /// 탭 값 관측 헬퍼 — 전 워크스페이스 범위 탐색.
    fn tab_view(d: &Dispatcher, tab: TabId) -> &Tab {
        d.state()
            .workspaces
            .iter()
            .flat_map(|ws| ws.panes.values())
            .flat_map(|pane| pane.tabs.iter())
            .find(|t| t.id == tab)
            .expect("탭이 존재해야 함")
    }

    fn tab_cwd(d: &Dispatcher, tab: TabId) -> Option<String> {
        let TabKind::Terminal { cwd, .. } = &tab_view(d, tab).kind else {
            panic!("terminal 탭이어야 함");
        };
        cwd.clone()
    }

    #[test]
    fn apply_osc_routes_delta_to_the_tab_owning_the_session() {
        let (mut d, _host) = dispatcher();
        let (ws, pane) = create_ws(&mut d, "ws");
        let (tab1, s1) = create_terminal_tab(&mut d, pane);
        // 나중에 만든 tab2 가 active — tab1 은 뒤에 숨는다.
        let (tab2, _s2) = create_terminal_tab(&mut d, pane);
        let rev = d.state().revision;

        let changed = d.apply_osc(
            batch(&[
                (s1, OscEvent::Osc0Title("agent".into())),
                (s1, OscEvent::Osc7Cwd("file://h/home/u/my%20proj".into())),
                (s1, status_notify("mast:needsInput", "approve?")),
            ]),
            1_000,
        );
        assert!(changed);
        assert_eq!(d.state().revision, rev + 1);

        // 역매핑된 탭에만 필드가 반영된다.
        let t1 = tab_view(&d, tab1);
        assert_eq!(t1.title, "agent");
        assert_eq!(t1.notification, NotificationState::Unread);
        assert_eq!(t1.last_activity_ms, Some(1_000));
        assert_eq!(tab_cwd(&d, tab1).as_deref(), Some("/home/u/my proj"));

        // 같은 pane 의 다른 탭은 그대로.
        let t2 = tab_view(&d, tab2);
        assert_eq!(t2.title, "Terminal");
        assert_eq!(t2.notification, NotificationState::None);
        assert_eq!(t2.last_activity_ms, None);
        assert_eq!(tab_cwd(&d, tab2), None);

        // 워크스페이스 레벨 상태 + 출처 탭 기록.
        assert_eq!(
            agent(&d, ws),
            (
                AgentStatus::NeedsInput,
                Some(tab1),
                Some("approve?".to_owned())
            )
        );
    }

    #[test]
    fn apply_osc_unknown_session_is_noop() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        create_terminal_tab(&mut d, pane);
        let before = serde_json::to_value(d.state()).unwrap();

        // 창이 열려 있는 동안 탭이 닫히는 정상 순서 — 패닉·변이 없이 false.
        assert!(!d.apply_osc(batch(&[(999, status_notify("mast:needsInput", "x"))]), 1_000));
        assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
    }

    #[test]
    fn apply_osc_skips_whole_delta_for_exited_tab() {
        // 100ms 창 안에서 세션이 끝나면 즉시 처리된 SessionExited 의 Idle 리셋 뒤에
        // 지연 배치가 도착한다 — 죽은 탭에 알림·상태를 다시 도장하면 안 된다.
        let (mut d, _host) = dispatcher();
        let (ws, pane) = create_ws(&mut d, "ws");
        let (_tab, session) = create_terminal_tab(&mut d, pane);
        d.apply_osc(
            batch(&[(session, status_notify("mast:needsInput", "approve?"))]),
            1_000,
        );
        d.apply_event(SessionEvent::SessionExited {
            session,
            code: Some(0),
        });
        assert_eq!(agent(&d, ws).0, AgentStatus::Idle);
        let before = serde_json::to_value(d.state()).unwrap();

        // 제목·활동 시각까지 통째로 스킵 — 상태 변화 없음.
        assert!(!d.apply_osc(
            batch(&[
                (session, OscEvent::Osc0Title("late".into())),
                (session, status_notify("mast:needsInput", "still?")),
            ]),
            2_000,
        ));
        assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
    }

    #[test]
    fn apply_osc_keeps_needs_input_against_other_tabs() {
        let (mut d, _host) = dispatcher();
        let (ws, pane) = create_ws(&mut d, "ws");
        let (tab1, s1) = create_terminal_tab(&mut d, pane);
        let (tab2, s2) = create_terminal_tab(&mut d, pane);
        d.apply_osc(
            batch(&[(s1, status_notify("mast:needsInput", "approve?"))]),
            1_000,
        );
        assert_eq!(agent(&d, ws).1, Some(tab1));

        // 다른 탭의 running·idle 은 입력 대기를 가리지 못한다 (출처도 유지).
        for token in ["mast:running", "mast:idle"] {
            d.apply_osc(batch(&[(s2, status_notify(token, ""))]), 2_000);
            assert_eq!(agent(&d, ws).0, AgentStatus::NeedsInput, "{token}");
            assert_eq!(agent(&d, ws).1, Some(tab1), "{token}");
        }

        // 단 다른 탭의 needsInput 은 반영되고 출처가 그 탭으로 옮겨간다.
        d.apply_osc(
            batch(&[(s2, status_notify("mast:needsInput", "second"))]),
            3_000,
        );
        assert_eq!(agent(&d, ws).0, AgentStatus::NeedsInput);
        assert_eq!(agent(&d, ws).1, Some(tab2));
    }

    #[test]
    fn apply_osc_lets_the_same_source_leave_needs_input() {
        // 사용자가 응답하면 같은 출처 탭의 UserPromptSubmit(running)이 자연 강등한다.
        let (mut d, _host) = dispatcher();
        let (ws, pane) = create_ws(&mut d, "ws");
        let (tab1, s1) = create_terminal_tab(&mut d, pane);
        d.apply_osc(
            batch(&[(s1, status_notify("mast:needsInput", "approve?"))]),
            1_000,
        );
        assert!(d.apply_osc(batch(&[(s1, status_notify("mast:running", ""))]), 2_000));
        assert_eq!(
            agent(&d, ws),
            (
                AgentStatus::Running,
                Some(tab1),
                // 빈 body 는 앞선 메시지를 지우지 않는다 (notify.rs last-non-empty).
                Some("approve?".to_owned())
            )
        );
    }

    #[test]
    fn apply_osc_suppresses_unread_on_visible_tab_only() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (tab1, s1) = create_terminal_tab(&mut d, pane);
        let (tab2, s2) = create_terminal_tab(&mut d, pane);

        d.apply_osc(
            batch(&[
                (s1, status_notify("mast:idle", "done")),
                (s2, status_notify("mast:idle", "done")),
            ]),
            1_000,
        );
        // 가시 탭(active 워크스페이스 + 그 pane 의 active_tab)은 억제, 숨은 탭은 세팅.
        assert_eq!(tab_view(&d, tab2).notification, NotificationState::None);
        assert_eq!(tab_view(&d, tab1).notification, NotificationState::Unread);

        // 다른 워크스페이스로 나가면 같은 탭도 비가시가 된다.
        create_ws(&mut d, "other");
        d.apply_osc(batch(&[(s2, status_notify("mast:idle", "done"))]), 2_000);
        assert_eq!(tab_view(&d, tab2).notification, NotificationState::Unread);
    }

    #[test]
    fn activate_tab_clears_unread() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (tab1, s1) = create_terminal_tab(&mut d, pane);
        create_terminal_tab(&mut d, pane);
        d.apply_osc(batch(&[(s1, status_notify("mast:idle", "done"))]), 1_000);
        assert_eq!(tab_view(&d, tab1).notification, NotificationState::Unread);

        d.dispatch(Command::ActivateTab { tab: tab1 }).unwrap();
        assert_eq!(tab_view(&d, tab1).notification, NotificationState::None);
    }

    #[test]
    fn switch_workspace_clears_unread_of_each_panes_active_tab() {
        let (mut d, _host) = dispatcher();
        let (ws1, pane1) = create_ws(&mut d, "one");
        let (tab_a, sa) = create_terminal_tab(&mut d, pane1);
        let (tab_b, sb) = create_terminal_tab(&mut d, pane1);
        let (pane2, _split) = split_empty(&mut d, pane1, SplitDirection::Horizontal);
        let (tab_c, sc) = create_terminal_tab(&mut d, pane2);
        // 다른 워크스페이스로 나가 전 탭을 비가시로 만든 뒤 알림을 세운다.
        create_ws(&mut d, "two");
        d.apply_osc(
            batch(&[
                (sa, status_notify("mast:idle", "a")),
                (sb, status_notify("mast:idle", "b")),
                (sc, status_notify("mast:idle", "c")),
            ]),
            1_000,
        );
        for tab in [tab_a, tab_b, tab_c] {
            assert_eq!(tab_view(&d, tab).notification, NotificationState::Unread);
        }

        d.dispatch(Command::SwitchWorkspace { workspace: ws1 })
            .unwrap();
        // 각 pane 의 active_tab 만 해제 — 뒤에 숨은 탭 a 는 그대로.
        assert_eq!(tab_view(&d, tab_b).notification, NotificationState::None);
        assert_eq!(tab_view(&d, tab_c).notification, NotificationState::None);
        assert_eq!(tab_view(&d, tab_a).notification, NotificationState::Unread);
    }

    #[test]
    fn close_tab_clears_unread_of_promoted_tab_when_visible() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (tab_a, sa) = create_terminal_tab(&mut d, pane);
        let (tab_b, _sb) = create_terminal_tab(&mut d, pane);
        // tab_b 가 active 라 tab_a 는 숨어 있다 — unread 가 선다.
        d.apply_osc(batch(&[(sa, status_notify("mast:idle", "a"))]), 1_000);
        assert_eq!(tab_view(&d, tab_a).notification, NotificationState::Unread);

        // active 탭을 닫으면 tab_a 가 승격돼 곧바로 화면에 드러난다 — 가시화 = 읽음.
        d.dispatch(Command::CloseTab { tab: tab_b }).unwrap();
        assert_eq!(tab_view(&d, tab_a).notification, NotificationState::None);
    }

    #[test]
    fn close_tab_keeps_unread_of_promoted_tab_in_background_workspace() {
        let (mut d, _host) = dispatcher();
        let (_ws1, pane) = create_ws(&mut d, "one");
        let (tab_a, sa) = create_terminal_tab(&mut d, pane);
        let (tab_b, _sb) = create_terminal_tab(&mut d, pane);
        create_ws(&mut d, "two"); // ws1 전체가 비가시로.
        d.apply_osc(batch(&[(sa, status_notify("mast:idle", "a"))]), 1_000);

        // 백그라운드 워크스페이스 안의 승격은 가시화가 아니다 — unread 유지.
        d.dispatch(Command::CloseTab { tab: tab_b }).unwrap();
        assert_eq!(tab_view(&d, tab_a).notification, NotificationState::Unread);
    }

    #[test]
    fn close_workspace_fallback_clears_unread_of_newly_visible_tabs() {
        let (mut d, _host) = dispatcher();
        let (_ws1, pane) = create_ws(&mut d, "one");
        let (tab_a, sa) = create_terminal_tab(&mut d, pane);
        let (tab_b, sb) = create_terminal_tab(&mut d, pane);
        let (ws2, _pane2) = create_ws(&mut d, "two"); // ws1 비가시 상태에서 알림.
        d.apply_osc(
            batch(&[
                (sa, status_notify("mast:idle", "a")),
                (sb, status_notify("mast:idle", "b")),
            ]),
            1_000,
        );

        // active 워크스페이스를 닫으면 ws1 이 fallback 으로 드러난다 —
        // SwitchWorkspace 와 같은 규칙: active_tab(b)만 해제, 숨은 a 는 유지.
        d.dispatch(Command::CloseWorkspace { workspace: ws2 })
            .unwrap();
        assert_eq!(tab_view(&d, tab_b).notification, NotificationState::None);
        assert_eq!(tab_view(&d, tab_a).notification, NotificationState::Unread);
    }

    #[test]
    fn close_tab_resets_agent_status_source() {
        let (mut d, _host) = dispatcher();
        let (ws, pane) = create_ws(&mut d, "ws");
        let (tab1, s1) = create_terminal_tab(&mut d, pane);
        create_terminal_tab(&mut d, pane);
        d.apply_osc(
            batch(&[(s1, status_notify("mast:needsInput", "approve?"))]),
            1_000,
        );

        d.dispatch(Command::CloseTab { tab: tab1 }).unwrap();
        // 상태·출처만 되돌아간다 (미리보기 메시지는 리셋 대상이 아니다).
        assert_eq!(
            agent(&d, ws),
            (AgentStatus::Idle, None, Some("approve?".to_owned()))
        );
    }

    #[test]
    fn close_pane_resets_agent_status_source_for_any_removed_tab() {
        // pane 의 두 번째 탭이 출처여도 리셋된다 — 제거되는 탭 전부를 확인하지
        // 않으면 죽은 탭의 needsInput 이 사이드바에 영원히 남는다.
        let (mut d, _host) = dispatcher();
        let (ws, pane1) = create_ws(&mut d, "ws");
        let (pane2, _split) = split_empty(&mut d, pane1, SplitDirection::Vertical);
        create_terminal_tab(&mut d, pane2);
        let (second, s2) = create_terminal_tab(&mut d, pane2);
        d.apply_osc(
            batch(&[(s2, status_notify("mast:needsInput", "approve?"))]),
            1_000,
        );
        assert_eq!(agent(&d, ws).1, Some(second));

        d.dispatch(Command::ClosePane { pane: pane2 }).unwrap();
        assert_eq!(agent(&d, ws).0, AgentStatus::Idle);
        assert_eq!(agent(&d, ws).1, None);
    }

    /// distro 를 단 워크스페이스 헬퍼 — 해제 통지가 어느 배포판으로 가야 하는지
    /// 검사하려면 distro 가 실려 있어야 한다.
    fn create_ws_on(d: &mut Dispatcher, name: &str, distro: &str) -> (WorkspaceId, PaneId) {
        match d
            .dispatch(Command::CreateWorkspace {
                name: name.into(),
                root_path: None,
                distro: Some(distro.into()),
                tab: None,
            })
            .unwrap()
        {
            CommandOutput::WorkspaceCreated { workspace, pane, .. } => (workspace, pane),
            other => panic!("unexpected output: {other:?}"),
        }
    }

    /// 사이드바 순서 = `state.workspaces` 순서. 이름 목록으로 읽어야 재배치가
    /// 눈에 보인다 (id 는 생성 순서라 순서 변화를 못 보여 준다).
    fn order(d: &Dispatcher) -> Vec<&str> {
        d.state()
            .workspaces
            .iter()
            .map(|ws| ws.name.as_str())
            .collect()
    }

    #[test]
    fn moving_a_workspace_puts_it_before_the_named_neighbour() {
        let (mut d, _host) = dispatcher();
        let (a, _) = create_ws(&mut d, "a");
        let (b, _) = create_ws(&mut d, "b");
        let (c, _) = create_ws(&mut d, "c");
        assert_eq!(order(&d), ["a", "b", "c"]);

        // 뒤에서 앞으로.
        d.dispatch(Command::MoveWorkspace {
            workspace: c,
            before: Some(a),
        })
        .unwrap();
        assert_eq!(order(&d), ["c", "a", "b"]);

        // 앞에서 뒤로 — 삽입 위치를 뺀 뒤의 목록에서 다시 찾지 않으면 여기서
        // 한 칸 어긋난다.
        d.dispatch(Command::MoveWorkspace {
            workspace: c,
            before: Some(b),
        })
        .unwrap();
        assert_eq!(order(&d), ["a", "c", "b"]);
    }

    #[test]
    fn a_none_neighbour_moves_it_to_the_end() {
        let (mut d, _host) = dispatcher();
        let (a, _) = create_ws(&mut d, "a");
        create_ws(&mut d, "b");
        create_ws(&mut d, "c");

        d.dispatch(Command::MoveWorkspace {
            workspace: a,
            before: None,
        })
        .unwrap();
        assert_eq!(order(&d), ["b", "c", "a"]);
    }

    #[test]
    fn moving_a_workspace_before_itself_changes_nothing() {
        // 제자리에 놓은 드래그 — 에러가 아니다 (variant rustdoc).
        let (mut d, _host) = dispatcher();
        let (a, _) = create_ws(&mut d, "a");
        create_ws(&mut d, "b");

        d.dispatch(Command::MoveWorkspace {
            workspace: a,
            before: Some(a),
        })
        .unwrap();
        assert_eq!(order(&d), ["a", "b"]);
    }

    #[test]
    fn a_move_does_not_change_the_active_workspace() {
        // 정리하려고 끈 드래그가 화면까지 바꾸면 안 된다 (사용자 결정 2026-08-22).
        let (mut d, _host) = dispatcher();
        let (a, _) = create_ws(&mut d, "a");
        let (b, _) = create_ws(&mut d, "b");
        d.dispatch(Command::SwitchWorkspace { workspace: a }).unwrap();
        assert_eq!(d.state().active_workspace, Some(a));

        d.dispatch(Command::MoveWorkspace {
            workspace: b,
            before: Some(a),
        })
        .unwrap();
        assert_eq!(order(&d), ["b", "a"]);
        assert_eq!(d.state().active_workspace, Some(a));
    }

    #[test]
    fn an_unknown_id_on_either_side_leaves_the_order_untouched() {
        // 낡은 스냅샷으로 사라진 이웃 앞에 놓으려 한 경우 — 인덱스 계약이었다면
        // 조용히 다른 자리로 갔을 자리다 (variant rustdoc).
        let (mut d, _host) = dispatcher();
        let (a, _) = create_ws(&mut d, "a");
        create_ws(&mut d, "b");
        let revision = d.snapshot().revision;

        assert!(matches!(
            d.dispatch(Command::MoveWorkspace {
                workspace: a,
                before: Some(WorkspaceId(999)),
            }),
            Err(CommandError::UnknownTarget { .. })
        ));
        assert!(matches!(
            d.dispatch(Command::MoveWorkspace {
                workspace: WorkspaceId(999),
                before: Some(a),
            }),
            Err(CommandError::UnknownTarget { .. })
        ));
        assert_eq!(order(&d), ["a", "b"]);
        assert_eq!(d.snapshot().revision, revision, "실패는 revision 도 안 올린다");
    }

    #[test]
    fn closing_a_tab_releases_its_shell_side_files() {
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws_on(&mut d, "ws", "Ubuntu");
        let (tab, _s) = create_terminal_tab(&mut d, pane);

        d.dispatch(Command::CloseTab { tab }).unwrap();

        assert_eq!(
            host.releases(),
            vec![(vec![tab], Some("Ubuntu".to_string()))]
        );
    }

    #[test]
    fn a_pane_or_workspace_releases_all_of_its_tabs_in_one_call() {
        // 배치 계약: 탭 N 개가 함께 사라져도 통지는 한 번이다. 탭마다 통지하면
        // 호스트가 정리 왕복을 N 개 동시에 띄운다 (SessionHost rustdoc).
        let (mut d, host) = dispatcher();
        let (_ws, pane1) = create_ws_on(&mut d, "ws", "Ubuntu");
        let (pane2, _split) = split_empty(&mut d, pane1, SplitDirection::Vertical);
        let (a, _sa) = create_terminal_tab(&mut d, pane2);
        let (b, _sb) = create_terminal_tab(&mut d, pane2);

        d.dispatch(Command::ClosePane { pane: pane2 }).unwrap();
        assert_eq!(host.releases(), vec![(vec![a, b], Some("Ubuntu".into()))]);

        let (ws2, pane3) = create_ws_on(&mut d, "ws2", "Debian");
        let (c, _sc) = create_terminal_tab(&mut d, pane3);
        let (dd, _sd) = create_terminal_tab(&mut d, pane3);
        d.dispatch(Command::CloseWorkspace { workspace: ws2 })
            .unwrap();
        assert_eq!(
            host.releases().last().cloned(),
            Some((vec![c, dd], Some("Debian".into())))
        );
    }

    #[test]
    fn a_tab_whose_shell_exited_keeps_its_files() {
        // Exited 는 되살아나는 상태다 (ADR-0010) — 같은 탭 id 로 재시작하면 자기
        // history 를 다시 물어야 하므로 지우면 안 된다.
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws_on(&mut d, "ws", "Ubuntu");
        let (_tab, session) = create_terminal_tab(&mut d, pane);

        d.apply_event(SessionEvent::SessionExited {
            session,
            code: Some(1),
        });

        assert!(host.releases().is_empty());
    }

    #[test]
    fn a_terminal_tab_with_no_session_is_still_released() {
        // 세션을 잃은 탭 — 셸이 죽은 뒤 재시작마저 실패하면 `pty_session` 이
        // 비워진다 (ADR-0009). 그래도 HISTFILE 은 이미 만들어져 있으므로 세션
        // 유무로 거르면 그 파일이 영원히 남는다.
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws_on(&mut d, "ws", "Ubuntu");
        let (tab, session) = create_terminal_tab(&mut d, pane);
        d.apply_event(SessionEvent::SessionExited {
            session,
            code: Some(1),
        });
        host.set_fail_spawn(true);
        assert!(d.respawn_tab(tab).is_err());

        d.dispatch(Command::CloseTab { tab }).unwrap();
        assert_eq!(host.releases(), vec![(vec![tab], Some("Ubuntu".into()))]);
    }

    #[test]
    fn closing_a_viewer_tab_releases_nothing() {
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws_on(&mut d, "ws", "Ubuntu");
        let tab = match d
            .dispatch(Command::CreateTab {
                pane,
                tab: NewTab::FolderBrowser { path: None },
            })
            .unwrap()
        {
            CommandOutput::TabCreated { tab, session: None } => tab,
            other => panic!("unexpected output: {other:?}"),
        };

        d.dispatch(Command::CloseTab { tab }).unwrap();

        assert!(host.releases().is_empty());
    }

    #[test]
    fn session_exited_resets_agent_status_source() {
        let (mut d, _host) = dispatcher();
        let (ws, pane) = create_ws(&mut d, "ws");
        let (tab1, s1) = create_terminal_tab(&mut d, pane);
        let (tab2, s2) = create_terminal_tab(&mut d, pane);
        d.apply_osc(
            batch(&[(s2, status_notify("mast:needsInput", "approve?"))]),
            1_000,
        );
        assert_eq!(agent(&d, ws).1, Some(tab2));

        // 출처가 아닌 탭의 종료는 상태를 건드리지 않는다.
        d.apply_event(SessionEvent::SessionExited {
            session: s1,
            code: Some(0),
        });
        assert_eq!(agent(&d, ws).0, AgentStatus::NeedsInput);
        assert_eq!(agent(&d, ws).1, Some(tab2));

        // 출처 탭의 종료는 Idle 로 되돌린다.
        let rev = d.state().revision;
        d.apply_event(SessionEvent::SessionExited {
            session: s2,
            code: Some(0),
        });
        assert_eq!(agent(&d, ws).0, AgentStatus::Idle);
        assert_eq!(agent(&d, ws).1, None);
        assert_eq!(d.state().revision, rev + 1);
        let _ = tab1;
    }

    #[test]
    fn apply_osc_bumps_revision_once_per_batch() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (_tab1, s1) = create_terminal_tab(&mut d, pane);
        let (_tab2, s2) = create_terminal_tab(&mut d, pane);
        let rev = d.state().revision;

        // 두 세션 × 여러 이벤트가 한 배치에 모여도 revision 은 1회만 오른다.
        assert!(d.apply_osc(
            batch(&[
                (s1, OscEvent::Osc0Title("a".into())),
                (s1, status_notify("mast:running", "one")),
                (s2, OscEvent::Osc0Title("b".into())),
                (s2, status_notify("mast:idle", "two")),
            ]),
            1_000,
        ));
        assert_eq!(d.state().revision, rev + 1);

        // 바뀔 것이 없는 배치는 false — 글루가 스냅샷 발행을 건너뛴다.
        assert!(!d.apply_osc(
            batch(&[
                (s2, OscEvent::Osc0Title("b".into())),
                (s2, status_notify("mast:idle", "two")),
            ]),
            1_000,
        ));
        assert_eq!(d.state().revision, rev + 1);
    }

    /// pty_session 없는 터미널 탭 값 — persist sanitize 직후 형태.
    fn sessionless_tab(id: u64, status: TerminalStatus, cwd: Option<&str>) -> Tab {
        Tab {
            id: TabId(id),
            title: format!("tab-{id}"),
            kind: TabKind::Terminal {
                pty_session: None,
                status,
                cwd: cwd.map(String::from),
            },
            notification: NotificationState::None,
            last_activity_ms: None,
        }
    }

    /// 복원 직후(sanitize 완료) 모양의 상태 — ws 1, split 4 아래 pane 2·3.
    /// pane 2: tab 5 (Running, cwd 없음 → root_path 상속 대상).
    /// pane 3: tab 6 (Running, cwd /custom), tab 7 (Exited — 부팅 열거 비대상,
    /// Restart 경로로는 되살아난다).
    /// next_id 8, revision 3.
    fn adopted_state() -> AppState {
        AppState {
            workspaces: vec![Workspace {
                id: WorkspaceId(1),
                name: "restored".into(),
                root_path: Some("/root".into()),
                distro: Some("Ubuntu".into()),
                git_branch: None,
                git_dirty: None,
                layout: SplitTree::Split {
                    id: SplitId(4),
                    direction: SplitDirection::Horizontal,
                    ratio: 0.5,
                    first: Box::new(SplitTree::Leaf { pane: PaneId(2) }),
                    second: Box::new(SplitTree::Leaf { pane: PaneId(3) }),
                },
                panes: [
                    (
                        PaneId(2),
                        Pane {
                            id: PaneId(2),
                            tabs: vec![sessionless_tab(5, TerminalStatus::Running, None)],
                            active_tab: Some(TabId(5)),
                        },
                    ),
                    (
                        PaneId(3),
                        Pane {
                            id: PaneId(3),
                            tabs: vec![
                                sessionless_tab(6, TerminalStatus::Running, Some("/custom")),
                                sessionless_tab(7, TerminalStatus::Exited { code: Some(1) }, None),
                            ],
                            active_tab: Some(TabId(6)),
                        },
                    ),
                ]
                .into(),
                active_pane: PaneId(2),
                agent_status: AgentStatus::Idle,
                last_agent_message: None,
                agent_status_source: None,
            }],
            active_workspace: Some(WorkspaceId(1)),
            next_id: 8,
            revision: 3,
        }
    }

    fn adopted_dispatcher() -> (Dispatcher, FakeSessionHost) {
        let host = FakeSessionHost::default();
        (
            Dispatcher::adopt(adopted_state(), Box::new(host.clone())),
            host,
        )
    }

    /// `tab.kind` 의 (pty_session, status) 를 읽는 관측 헬퍼.
    fn terminal_kind(
        d: &Dispatcher,
        pane: PaneId,
        ti: usize,
    ) -> (Option<SessionId>, TerminalStatus) {
        let TabKind::Terminal {
            pty_session,
            status,
            ..
        } = &d.state().workspaces[0].panes[&pane].tabs[ti].kind
        else {
            panic!("terminal 탭이어야 함");
        };
        (*pty_session, *status)
    }

    #[test]
    fn adopt_takes_state_without_spawning() {
        let (d, host) = adopted_dispatcher();
        // 채택만 — 스폰·kill 부수효과 전혀 없음, 상태 원본 그대로.
        assert!(host.spawns().is_empty());
        assert!(host.kills().is_empty());
        assert_eq!(*d.state(), adopted_state());
    }

    #[test]
    fn running_terminal_tabs_lists_only_sessionless_running() {
        let (mut d, _host) = adopted_dispatcher();
        // Exited 탭(7)은 제외 — Running·pty_session None 인 5·6 만.
        assert_eq!(d.running_terminal_tabs(), vec![TabId(5), TabId(6)]);
        // 재스폰돼 세션이 채워진 탭은 열거에서 빠진다.
        d.respawn_tab(TabId(5)).unwrap();
        assert_eq!(d.running_terminal_tabs(), vec![TabId(6)]);
    }

    #[test]
    fn respawn_fills_session_and_bumps_revision() {
        let (mut d, host) = adopted_dispatcher();
        let s5 = d.respawn_tab(TabId(5)).unwrap();
        let s6 = d.respawn_tab(TabId(6)).unwrap();
        assert_eq!((s5, s6), (1, 2));
        assert_eq!(
            terminal_kind(&d, PaneId(2), 0),
            (Some(s5), TerminalStatus::Running)
        );
        assert_eq!(
            terminal_kind(&d, PaneId(3), 0),
            (Some(s6), TerminalStatus::Running)
        );
        // 회당 revision += 1 (스냅샷 전파) — adopted revision 3 에서 시작.
        assert_eq!(d.state().revision, 5);

        // 스폰 파라미터: cwd = 탭 cwd(없으면 root_path), distro = ws 기본, 80×24,
        // history_tab = 재스폰 대상 탭의 id (재시작 전과 같은 history 파일).
        let spawns = host.spawns();
        assert_eq!(
            spawns[0],
            ShellSpawnReq {
                cwd: Some("/root".into()),
                distro: Some("Ubuntu".into()),
                cols: 80,
                rows: 24,
                history_tab: Some(5),
            }
        );
        assert_eq!(spawns[1].cwd.as_deref(), Some("/custom"));
        // 탭에 기록된 cwd 는 재스폰이 바꾸지 않는다 (생성 시점 값 보존).
        let TabKind::Terminal { cwd, .. } = &d.state().workspaces[0].panes[&PaneId(2)].tabs[0].kind
        else {
            panic!("terminal 탭이어야 함");
        };
        assert_eq!(*cwd, None);
    }

    /// 재스폰은 탭 id 를 그대로 history 키로 쓴다 — 재시작 후에도 같은 탭이 같은
    /// history 파일을 물게 하는 것이 탭별 history 의 요점이다 (체크포인트 2 UX).
    #[test]
    fn respawn_carries_history_tab_of_the_same_tab() {
        let (mut d, host) = adopted_dispatcher();
        d.respawn_tab(TabId(5)).unwrap();
        d.respawn_tab(TabId(6)).unwrap();
        let history: Vec<Option<u64>> = host.spawns().iter().map(|r| r.history_tab).collect();
        assert_eq!(history, vec![Some(TabId(5).0), Some(TabId(6).0)]);
    }

    #[test]
    fn respawn_failure_demotes_tab_to_exited() {
        let (mut d, host) = adopted_dispatcher();
        host.set_fail_spawn(true);
        let err = d.respawn_tab(TabId(5)).unwrap_err();
        assert!(matches!(err, CommandError::SpawnFailed { .. }), "{err:?}");
        // 강등이 설계된 결과 상태 — pty_session 은 None 유지, revision 반영.
        assert_eq!(
            terminal_kind(&d, PaneId(2), 0),
            (None, TerminalStatus::Exited { code: None })
        );
        assert_eq!(d.state().revision, 4);
        // 강등된 탭도 다시 시도할 수 있다 (ADR-0010 — pane 배너의 Restart).
        host.set_fail_spawn(false);
        let s5 = d.respawn_tab(TabId(5)).unwrap();
        assert_eq!(
            terminal_kind(&d, PaneId(2), 0),
            (Some(s5), TerminalStatus::Running)
        );
        // 부팅 열거는 여전히 세션 없는 Running 탭만 — 방금 살아난 탭은 빠진다.
        assert_eq!(d.running_terminal_tabs(), vec![TabId(6)]);
    }

    /// 실행 중 죽은 탭을 되살리는 경로 (ADR-0010). replay 표시용으로 남아 있던 죽은
    /// 세션을 먼저 정리하고, **같은 탭 id** 로 다시 스폰해 HISTFILE·resume 힌트를
    /// 그대로 물린다 — ↑ 한 번으로 죽은 에이전트 세션을 resume 하는 것이 요점이다.
    #[test]
    fn respawn_revives_a_tab_that_died_at_runtime() {
        let (mut d, host) = adopted_dispatcher();
        let s5 = d.respawn_tab(TabId(5)).unwrap();
        // 셸이 강제 종료됐다 (실기: PC 절전으로 WSL 이 통째로 내려간 경우의 코드).
        d.apply_event(SessionEvent::SessionExited {
            session: s5,
            code: Some(1_073_807_364),
        });
        assert_eq!(
            terminal_kind(&d, PaneId(2), 0),
            (
                Some(s5),
                TerminalStatus::Exited {
                    code: Some(1_073_807_364)
                }
            ),
            "Exited 여도 replay 를 위해 세션 id 는 남는다"
        );

        let revived = d.respawn_tab(TabId(5)).unwrap();
        assert_ne!(revived, s5);
        assert_eq!(
            terminal_kind(&d, PaneId(2), 0),
            (Some(revived), TerminalStatus::Running)
        );
        assert_eq!(host.kills(), vec![s5], "죽은 세션을 레지스트리에서 정리한다");
        assert_eq!(host.spawns().last().unwrap().history_tab, Some(TabId(5).0));
    }

    /// 디스크에서 온 `Exited` 탭(세션 id 없음)도 되살아난다 — persist sanitize 가
    /// Running 으로 되돌리기 전에 직접 호출돼도 같은 결과여야 한다.
    #[test]
    fn respawn_revives_a_stored_exited_tab_without_a_session() {
        let (mut d, host) = adopted_dispatcher();
        let s7 = d.respawn_tab(TabId(7)).unwrap();
        assert_eq!(
            terminal_kind(&d, PaneId(3), 1),
            (Some(s7), TerminalStatus::Running)
        );
        // 정리할 세션이 없으므로 kill 은 일어나지 않는다.
        assert!(host.kills().is_empty());
        assert_eq!(host.spawns().last().unwrap().history_tab, Some(TabId(7).0));
    }

    #[test]
    fn respawn_rejects_ineligible_targets_without_state_change() {
        let (mut d, host) = adopted_dispatcher();
        let s5 = d.respawn_tab(TabId(5)).unwrap();
        let before = serde_json::to_value(d.state()).unwrap();
        // 부적합 2종: 이미 세션 있는 Running 탭 / 미지 id — 둘 다 UnknownTarget
        // 에러이고 상태·revision 불변 (부적합 호출 = 프로그램 결함). Exited 탭은
        // ADR-0010 이후 부적합이 아니다 (아래 respawn_revives_* 참조).
        for tab in [TabId(5), TabId(99)] {
            let err = d.respawn_tab(tab).unwrap_err();
            assert!(
                matches!(err, CommandError::UnknownTarget { .. }),
                "tab {tab:?} → {err:?}"
            );
            assert_eq!(
                serde_json::to_value(d.state()).unwrap(),
                before,
                "tab {tab:?} 가 상태를 바꿈"
            );
        }
        // 성공한 첫 재스폰 외에 스폰이 더 일어나지 않았다.
        assert_eq!(host.spawns().len(), 1);
        assert_eq!(
            terminal_kind(&d, PaneId(2), 0),
            (Some(s5), TerminalStatus::Running)
        );
    }

    #[test]
    fn adopt_preserves_id_continuity_for_later_dispatch() {
        let (mut d, _host) = adopted_dispatcher();
        d.respawn_tab(TabId(5)).unwrap();
        d.respawn_tab(TabId(6)).unwrap();
        // adopt 된 next_id(8)에서 발급이 이어진다 — 복원 후 생성이 기존 id 와
        // 충돌하지 않는다 (dispatch 가 debug 불변식 검사도 수행).
        let (tab, _session) = create_terminal_tab(&mut d, PaneId(2));
        assert_eq!(tab, TabId(8));
        assert_eq!(d.state().next_id, 9);
    }

    // ---- pane 간 전송 대상 해석 (에이전트 채널) ----

    /// 탭 제목을 대상 탭이 스스로 정한 것처럼 세운다 (OSC 0 경로).
    fn set_title(d: &mut Dispatcher, session: SessionId, title: &str) {
        d.apply_osc(
            batch(&[(session, OscEvent::Osc0Title(title.into()))]),
            1_000,
        );
    }

    #[test]
    fn resolve_send_target_matches_title_substring_case_insensitively() {
        let (mut d, _host) = dispatcher();
        let (_ws1, pane1) = create_ws(&mut d, "one");
        let (_sender_tab, sender) = create_terminal_tab(&mut d, pane1);
        let (_tab_build, s_build) = create_terminal_tab(&mut d, pane1);
        set_title(&mut d, sender, "claude");
        set_title(&mut d, s_build, "Build Shell");

        // 부분일치 + 대소문자 무시.
        assert_eq!(d.resolve_send_target(sender, "build"), Ok(s_build));
        assert_eq!(d.resolve_send_target(sender, "UILD SH"), Ok(s_build));
        assert_eq!(d.resolve_send_target(sender, "Build Shell"), Ok(s_build));
    }

    /// 격리 반증 (사용자 결정 2026-08-11): 제목이 정확히 일치해도 다른 워크스페이스의
    /// 탭에는 닿지 않는다. 예전 계약("전 워크스페이스 도달")을 뒤집은 테스트다.
    #[test]
    fn resolve_send_target_is_confined_to_the_senders_workspace() {
        let (mut d, _host) = dispatcher();
        let (_ws1, pane1) = create_ws(&mut d, "one");
        let (_sender_tab, sender) = create_terminal_tab(&mut d, pane1);
        // 두 번째 워크스페이스가 active 가 되므로 첫 워크스페이스가 백그라운드다.
        let (_ws2, pane2) = create_ws(&mut d, "two");
        let (_other_tab, other) = create_terminal_tab(&mut d, pane2);
        set_title(&mut d, sender, "claude");
        set_title(&mut d, other, "agent zero");

        // 백그라운드 → active, active → 백그라운드 어느 방향도 경계를 넘지 못한다.
        assert_eq!(
            d.resolve_send_target(sender, "agent"),
            Err(SendTargetError::NoMatch)
        );
        assert_eq!(
            d.resolve_send_target(other, "claude"),
            Err(SendTargetError::NoMatch)
        );

        // 회귀 대조군: 같은 워크스페이스 안에서는 (그 워크스페이스가 백그라운드여도)
        // 그대로 도달한다 — 좁아진 것은 반경뿐이다.
        let (_peer_tab, peer) = create_terminal_tab(&mut d, pane1);
        set_title(&mut d, peer, "agent one");
        assert_eq!(d.resolve_send_target(sender, "agent"), Ok(peer));
    }

    /// 송신자 세션이 어느 탭에도 없으면(이론상 불가) 경계를 정할 수 없다 — 조용히
    /// 전 워크스페이스로 넓어지지 않고 NoMatch·빈 목록으로 닫힌다.
    #[test]
    fn agent_channel_closes_for_a_session_that_belongs_to_no_tab() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (target_tab, _target) = create_terminal_tab(&mut d, pane);
        let ghost: SessionId = 9_999;

        assert_eq!(
            d.resolve_send_target(ghost, "terminal"),
            Err(SendTargetError::NoMatch)
        );
        assert_eq!(
            d.resolve_send_target(ghost, &format!("#{}", target_tab.0)),
            Err(SendTargetError::NoMatch)
        );
        assert!(d.list_tabs(ghost).is_empty());
    }

    #[test]
    fn resolve_send_target_excludes_the_sender() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (_t1, sender) = create_terminal_tab(&mut d, pane);
        let (_t2, twin) = create_terminal_tab(&mut d, pane);
        // 제목이 같은 두 탭 — 송신자를 뺀 나머지가 하나뿐이라 모호하지 않다.
        set_title(&mut d, sender, "twin");
        set_title(&mut d, twin, "twin");
        assert_eq!(d.resolve_send_target(sender, "twin"), Ok(twin));
        assert_eq!(d.resolve_send_target(twin, "twin"), Ok(sender));
    }

    #[test]
    fn resolve_send_target_rejects_no_match_and_ambiguity() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (_t1, sender) = create_terminal_tab(&mut d, pane);
        let (_t2, _a) = create_terminal_tab(&mut d, pane);
        let (_t3, _b) = create_terminal_tab(&mut d, pane);
        set_title(&mut d, sender, "claude");

        assert_eq!(
            d.resolve_send_target(sender, "nope"),
            Err(SendTargetError::NoMatch)
        );
        // 갓 만든 탭의 기본 제목은 둘 다 "Terminal" — 첫 매치를 고르지 않는다.
        assert_eq!(
            d.resolve_send_target(sender, "terminal"),
            Err(SendTargetError::Ambiguous { count: 2 })
        );
    }

    #[test]
    fn resolve_send_target_skips_exited_and_viewer_tabs() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (_t1, sender) = create_terminal_tab(&mut d, pane);
        let (_t2, dead) = create_terminal_tab(&mut d, pane);
        set_title(&mut d, sender, "claude");
        set_title(&mut d, dead, "build");
        // 뷰어 탭의 제목도 "build" 로 겹치게 만든다 (경로 마지막 조각이 제목).
        create_viewer_tab(
            &mut d,
            pane,
            NewTab::FolderBrowser {
                path: Some("/home/u/build".into()),
            },
        );

        // 아직 살아 있는 동안은 유일 매치.
        assert_eq!(d.resolve_send_target(sender, "build"), Ok(dead));

        // 세션이 죽으면 후보에서 빠진다 — 쓸 stdin 이 없다. 뷰어 탭은 제목이
        // 일치해도 애초에 후보가 아니므로 남는 매치는 0건이다.
        d.apply_event(SessionEvent::SessionExited {
            session: dead,
            code: Some(0),
        });
        assert_eq!(
            d.resolve_send_target(sender, "build"),
            Err(SendTargetError::NoMatch)
        );
    }

    #[test]
    fn resolve_send_target_is_a_pure_query() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (_t1, sender) = create_terminal_tab(&mut d, pane);
        let (_t2, other) = create_terminal_tab(&mut d, pane);
        set_title(&mut d, other, "build");
        let before = serde_json::to_value(d.state()).unwrap();

        // 성공·NoMatch·Ambiguous 어느 경로도 상태·revision 을 건드리지 않는다.
        assert_eq!(d.resolve_send_target(sender, "build"), Ok(other));
        assert_eq!(
            d.resolve_send_target(sender, "nope"),
            Err(SendTargetError::NoMatch)
        );
        assert_eq!(
            d.resolve_send_target(sender, ""),
            Ok(other),
            "빈 대상은 후보가 하나뿐일 때만 전달된다"
        );
        assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
    }

    // ---- id 주소지정 (`#<탭 id>`) ----

    /// 격리 반증: 안정 ID 가 전역 유일하다는 사실은 주소의 성질이지 경계를 뚫는
    /// 열쇠가 아니다 — 다른 워크스페이스의 `#id` 는 "없는 id" 와 같은 취급이다.
    #[test]
    fn resolve_send_target_by_tab_id_stops_at_the_workspace_boundary() {
        let (mut d, _host) = dispatcher();
        let (_ws1, pane1) = create_ws(&mut d, "one");
        let (_sender_tab, sender) = create_terminal_tab(&mut d, pane1);
        let (peer_tab, peer) = create_terminal_tab(&mut d, pane1);
        let (_decoy_tab, _decoy) = create_terminal_tab(&mut d, pane1);
        // 두 번째 워크스페이스가 active 가 되므로 첫 워크스페이스는 백그라운드다.
        let (_ws2, pane2) = create_ws(&mut d, "two");
        let (other_tab, _other) = create_terminal_tab(&mut d, pane2);

        assert_eq!(
            d.resolve_send_target(sender, &format!("#{}", other_tab.0)),
            Err(SendTargetError::NoMatch)
        );
        // 회귀 대조군: 같은 워크스페이스 안의 세 탭은 기본 제목이 모두 "Terminal"
        // 이라 제목으로는 모호하다. 그 상황에서도 id 는 유일하게 꽂힌다 — 그것이
        // 이 주소 형태의 요점이고, 격리는 그 요점을 건드리지 않는다.
        assert_eq!(
            d.resolve_send_target(sender, &format!("#{}", peer_tab.0)),
            Ok(peer)
        );
        assert_eq!(
            d.resolve_send_target(sender, "terminal"),
            Err(SendTargetError::Ambiguous { count: 2 })
        );
    }

    #[test]
    fn resolve_send_target_by_tab_id_rejects_unknown_exited_viewer_and_self() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (sender_tab, sender) = create_terminal_tab(&mut d, pane);
        let (dead_tab, dead) = create_terminal_tab(&mut d, pane);
        let viewer_tab = create_viewer_tab(
            &mut d,
            pane,
            NewTab::FolderBrowser {
                path: Some("/home/u/build".into()),
            },
        );

        // 없는 id.
        assert_eq!(
            d.resolve_send_target(sender, "#9999"),
            Err(SendTargetError::NoMatch)
        );
        // 뷰어 탭 — 쓸 stdin 이 없다.
        assert_eq!(
            d.resolve_send_target(sender, &format!("#{}", viewer_tab.0)),
            Err(SendTargetError::NoMatch)
        );
        // 자기 자신 — 되먹임 금지.
        assert_eq!(
            d.resolve_send_target(sender, &format!("#{}", sender_tab.0)),
            Err(SendTargetError::NoMatch)
        );
        // 살아 있는 동안은 히트하고, 세션이 죽으면 같은 id 가 NoMatch 가 된다.
        assert_eq!(
            d.resolve_send_target(sender, &format!("#{}", dead_tab.0)),
            Ok(dead)
        );
        d.apply_event(SessionEvent::SessionExited {
            session: dead,
            code: Some(0),
        });
        assert_eq!(
            d.resolve_send_target(sender, &format!("#{}", dead_tab.0)),
            Err(SendTargetError::NoMatch)
        );
    }

    #[test]
    fn resolve_send_target_falls_back_to_title_when_the_hash_is_not_a_number() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (_t1, sender) = create_terminal_tab(&mut d, pane);
        let (_t2, hashed) = create_terminal_tab(&mut d, pane);
        // 제목이 `#` 로 시작하는 탭 — id 모드가 이 길을 죽이면 안 된다.
        set_title(&mut d, sender, "claude");
        set_title(&mut d, hashed, "#abc channel");

        for target in ["#abc", "#", "#1.2", "#-3", "#+4", "# 5"] {
            assert_eq!(
                parse_tab_id_target(target),
                None,
                "{target:?} 는 id 로 파싱되지 않는다"
            );
        }
        // 그래서 `#abc` 는 제목 매칭으로 흘러 그 탭에 도달한다.
        assert_eq!(d.resolve_send_target(sender, "#abc"), Ok(hashed));
        // u64 범위를 넘는 숫자도 파싱 실패 → 제목 매칭(일치 없음)으로 떨어진다.
        assert_eq!(parse_tab_id_target("#99999999999999999999999"), None);
        assert_eq!(
            d.resolve_send_target(sender, "#99999999999999999999999"),
            Err(SendTargetError::NoMatch)
        );
        // 대조군: 숫자만 있으면 id 모드다.
        assert_eq!(parse_tab_id_target("#42"), Some(TabId(42)));
        assert_eq!(parse_tab_id_target("#007"), Some(TabId(7)));
    }

    #[test]
    fn resolve_send_target_by_tab_id_is_a_pure_query() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (_t1, sender) = create_terminal_tab(&mut d, pane);
        let (other_tab, other) = create_terminal_tab(&mut d, pane);
        let before = serde_json::to_value(d.state()).unwrap();

        assert_eq!(
            d.resolve_send_target(sender, &format!("#{}", other_tab.0)),
            Ok(other)
        );
        assert_eq!(
            d.resolve_send_target(sender, "#9999"),
            Err(SendTargetError::NoMatch)
        );
        assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
    }

    // ---- 탭 열거 (질의 채널) ----

    /// 격리 반증 + 필드 계약: 요청자에게는 **자기 워크스페이스의 탭만** 보이고,
    /// 반대편 요청자에게는 반대편 탭만 보인다. 워크스페이스 문맥 필드는 유지된다.
    #[test]
    fn list_tabs_is_scoped_to_the_requesters_workspace_with_exact_fields() {
        let (mut d, _host) = dispatcher();
        let (ws1, pane1) = create_ws(&mut d, "alpha");
        let (t_sender, sender) = create_terminal_tab(&mut d, pane1);
        let (t_dead, dead) = create_terminal_tab(&mut d, pane1);
        let viewer = create_viewer_tab(
            &mut d,
            pane1,
            NewTab::MarkdownViewer {
                path: "/home/u/notes.md".into(),
            },
        );
        // 두 번째 워크스페이스가 active 가 되므로 alpha 는 백그라운드다 — 요청자가
        // 백그라운드에 있어도 자기 워크스페이스는 온전히 열거된다.
        let (ws2, pane2) = create_ws(&mut d, "beta");
        let (t_other, other) = create_terminal_tab(&mut d, pane2);
        set_title(&mut d, sender, "claude");
        set_title(&mut d, dead, "build");
        set_title(&mut d, other, "agent");
        d.apply_event(SessionEvent::SessionExited {
            session: dead,
            code: Some(1),
        });

        let tabs = d.list_tabs(sender);
        // pane id 순 → 탭 순. 뷰어 탭도 빠짐없이 실리고, beta 의 탭은 빠진다.
        assert_eq!(
            tabs.iter().map(|t| t.tab).collect::<Vec<_>>(),
            vec![t_sender.0, t_dead.0, viewer.0]
        );
        assert_eq!(
            tabs[0],
            TabInfo {
                tab: t_sender.0,
                title: "claude".into(),
                workspace_id: ws1.0,
                workspace_name: "alpha".into(),
                pane: pane1.0,
                active: false,
                kind: "terminal",
                status: "running",
            }
        );
        // 죽은 터미널은 status 로 드러난다 (목록에서 사라지지 않는다).
        assert_eq!(tabs[1].status, "exited");
        assert_eq!(tabs[1].kind, "terminal");
        assert_eq!(tabs[1].title, "build");
        // 뷰어 탭 — 프로세스가 없으므로 세 번째 상태. 제목은 경로의 basename.
        assert_eq!(tabs[2].kind, "markdownViewer");
        assert_eq!(tabs[2].status, "viewer");
        assert_eq!(tabs[2].title, "notes.md");
        // 마지막 생성 탭이 그 pane 의 active_tab 이다.
        assert!(tabs[2].active, "뷰어가 pane1 의 active_tab");

        // 반대편 요청자는 beta 만 본다 — 경계는 요청자마다 따로 그어진다.
        assert_eq!(
            d.list_tabs(other),
            vec![TabInfo {
                tab: t_other.0,
                title: "agent".into(),
                workspace_id: ws2.0,
                workspace_name: "beta".into(),
                pane: pane2.0,
                active: true,
                kind: "terminal",
                status: "running",
            }]
        );
    }

    #[test]
    fn list_tabs_covers_every_tab_kind_and_pane() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        create_viewer_tab(
            &mut d,
            pane,
            NewTab::FolderBrowser {
                path: Some("/home/u/proj".into()),
            },
        );
        create_viewer_tab(
            &mut d,
            pane,
            NewTab::TextViewer {
                path: "/home/u/a.txt".into(),
            },
        );
        // 분할한 pane 의 탭도 같은 열거에 들어온다 — 격리 경계는 워크스페이스지
        // pane 이 아니다 (요청자는 pane_b 에 있고 pane 의 탭들도 보인다).
        let (pane_b, _split) = split_empty(&mut d, pane, SplitDirection::Horizontal);
        let (t_term, requester) = create_terminal_tab(&mut d, pane_b);

        let tabs = d.list_tabs(requester);
        assert_eq!(
            tabs.iter().map(|t| (t.pane, t.kind)).collect::<Vec<_>>(),
            vec![
                (pane.0, "folderBrowser"),
                (pane.0, "textViewer"),
                (pane_b.0, "terminal"),
            ]
        );
        assert_eq!(
            tabs.iter().map(|t| t.active).collect::<Vec<_>>(),
            vec![false, true, true],
            "pane 마다 자기 active_tab 이 따로 있다"
        );
        assert_eq!(tabs[2].tab, t_term.0);
    }

    #[test]
    fn list_tabs_is_a_pure_query_and_serializes_camel_case() {
        let (mut d, _host) = dispatcher();
        assert!(
            d.list_tabs(999).is_empty(),
            "워크스페이스가 없으면(=요청자를 찾을 수 없으면) 빈 목록"
        );
        let (ws, pane) = create_ws(&mut d, "ws");
        let (tab, requester) = create_terminal_tab(&mut d, pane);
        let before = serde_json::to_value(d.state()).unwrap();

        let tabs = d.list_tabs(requester);
        assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
        // JSON 출구 계약 — camelCase 키에 평평한 u64 id.
        assert_eq!(
            serde_json::to_value(&tabs[0]).unwrap(),
            serde_json::json!({
                "tab": tab.0,
                "title": "Terminal",
                "workspaceId": ws.0,
                "workspaceName": "ws",
                "pane": pane.0,
                "active": true,
                "kind": "terminal",
                "status": "running",
            })
        );
    }

    /// 시작 표식 계열 테스트가 보는 것 — 상태와 세션 보유 여부.
    fn terminal_of(d: &Dispatcher, tab: TabId) -> (TerminalStatus, Option<SessionId>) {
        for ws in &d.state().workspaces {
            for pane in ws.panes.values() {
                for t in &pane.tabs {
                    if t.id == tab {
                        if let TabKind::Terminal {
                            status, pty_session, ..
                        } = &t.kind
                        {
                            return (*status, *pty_session);
                        }
                    }
                }
            }
        }
        panic!("terminal tab {tab:?} not found");
    }

    #[test]
    fn startup_timeout_marks_the_tab_not_started_without_dropping_the_session() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (tab, session) = create_terminal_tab(&mut d, pane);
        let rev = d.state().revision;

        d.apply_event(SessionEvent::SessionStartupTimeout { session });

        // 세션을 유지하는 것이 계약이다 — 늦게 온 표식이 되돌릴 수 있어야 한다.
        assert_eq!(
            terminal_of(&d, tab),
            (TerminalStatus::NotStarted, Some(session))
        );
        assert!(d.state().revision > rev, "the transition must reach snapshots");
    }

    #[test]
    fn startup_timeout_does_not_touch_an_exited_tab() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (tab, session) = create_terminal_tab(&mut d, pane);
        d.apply_event(SessionEvent::SessionExited {
            session,
            code: Some(0),
        });
        let rev = d.state().revision;

        // 마감이 종료 직후에 지나가는 경합 — 끝난 탭이 "시작 안 됨"으로 되살아나면
        // 그 오분류는 워치독과 waiter 의 순서에 달려 재현조차 되지 않는다.
        d.apply_event(SessionEvent::SessionStartupTimeout { session });

        assert_eq!(
            terminal_of(&d, tab).0,
            TerminalStatus::Exited { code: Some(0) }
        );
        assert_eq!(d.state().revision, rev, "a no-op must not bump the revision");
    }

    #[test]
    fn a_late_startup_marker_clears_not_started() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (tab, session) = create_terminal_tab(&mut d, pane);
        d.apply_event(SessionEvent::SessionStartupTimeout { session });

        let mut batch = OscBatch::default();
        batch.merge(session, &OscEvent::Osc777Started);
        assert!(d.apply_osc(batch, 1), "the marker must change state");

        assert_eq!(terminal_of(&d, tab).0, TerminalStatus::Running);
    }

    #[test]
    fn retrying_a_not_started_tab_kills_the_session_it_still_holds() {
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (tab, session) = create_terminal_tab(&mut d, pane);
        d.apply_event(SessionEvent::SessionStartupTimeout { session });

        let new_session = d
            .respawn_tab(tab)
            .expect("a not-started tab must be respawnable");

        assert_ne!(new_session, session);
        assert_eq!(
            host.kills(),
            vec![session],
            "the session the tab still held must be cleaned up"
        );
        assert_eq!(
            terminal_of(&d, tab),
            (TerminalStatus::Running, Some(new_session))
        );
    }

    #[test]
    fn a_marker_that_arrives_before_the_timeout_report_still_wins() {
        let (mut d, _host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (tab, session) = create_terminal_tab(&mut d, pane);

        // 표식이 먼저 도착한다 — 이때 탭은 아직 Running 이라 되돌릴 것이 없고, 상태만
        // 보는 구현에서는 이 신호가 그대로 소모된다.
        let mut batch = OscBatch::default();
        batch.merge(session, &OscEvent::Osc777Started);
        d.apply_osc(batch, 1);

        // 뒤늦게 마감 보고가 들어온다. 두 신호는 서로 다른 경로(라우터 배치 / 워치독
        // 직행)로 오므로 이 순서가 실제로 발생하며, 여기서 NotStarted 가 되면 표식은
        // 세션당 한 번뿐이라 회복 수단이 남지 않는다.
        d.apply_event(SessionEvent::SessionStartupTimeout { session });

        assert_eq!(terminal_of(&d, tab).0, TerminalStatus::Running);
    }

    #[test]
    fn a_failed_retry_does_not_keep_the_removed_session_id() {
        let (mut d, host) = dispatcher();
        let (_ws, pane) = create_ws(&mut d, "ws");
        let (tab, session) = create_terminal_tab(&mut d, pane);
        d.apply_event(SessionEvent::SessionStartupTimeout { session });
        host.set_fail_spawn(true);

        assert!(d.respawn_tab(tab).is_err());

        // 옛 세션은 kill 되어 레지스트리에서 사라졌다 — 그 id 를 탭에 남기면 이후
        // attach 가 미지 세션으로 실패한다.
        assert_eq!(
            terminal_of(&d, tab),
            (TerminalStatus::Exited { code: None }, None)
        );
        assert_eq!(host.kills(), vec![session]);
    }
}
