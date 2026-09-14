//! 모든 구조 변이는 [`Command`]와 [`Dispatcher::dispatch`]를 거친다.
//! PTY 부수효과는 [`SessionHost`]로 격리한다.
//!
//! 대상 ID는 전역에서 찾지만 에이전트 채널의 조회·전송은 요청자의 워크스페이스로 제한한다.
//! dispatch 성공마다 revision이 증가하고, 실패 시 상태와 revision은 불변이다.
//! 미지 세션의 이벤트는 무시한다. OSC는 실제 변경이 있을 때 배치당 한 번 revision을 올린다.

use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::model::{AppState, PaneId, SplitDirection, SplitId, TabId, WorkspaceId};
use crate::session::SessionId;

mod audit;
mod events;
mod mutations;
mod queries;
mod tabs;

pub use audit::{audit_registries, RegistryAudit};

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
    /// 워크스페이스와 pane 하나를 만들고 활성화한다. tab이 있으면 함께 원자적으로 만든다.
    /// 스폰 실패 시 상태·next_id는 불변이다. tab 누락/null은 빈 pane을 뜻한다.
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
    /// workspace를 before 바로 앞에 옮긴다. None은 맨 뒤, 자기 자신은 무변경이다.
    /// 인덱스 대신 이웃 ID를 받아 낡은 스냅샷에서 이웃이 사라지면 UnknownTarget으로 실패한다.
    /// 순서는 Ctrl+1~9 번호도 바꾸지만 active_workspace는 바꾸지 않는다.
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
    /// terminal 세션을 종료하고 활성 탭을 직전 탭(첫 탭이면 다음 탭)으로 조정한다.
    /// 빈 pane은 collapse하되 워크스페이스의 마지막 pane은 빈 상태로 남긴다.
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
    /// textViewer는 전역 byte offset, markdownViewer는 px를 저장한다 ([`crate::model::TabKind`]).
    /// 값은 finite·0 이상이어야 한다. 다른 탭 종류는 KindMismatch로 거부한다.
    SetViewerScroll {
        tab: TabId,
        scroll_top: f64,
    },
}

/// 탭 생성 명세 — CreateTab·SplitPane·CreateWorkspace 가 공유한다. 21단계 뷰어
/// 3종이 모두 착지해 [`crate::model::TabKind`] 와 종류가 일대일이다 (terminal 은 스폰을
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
    ChangesViewer {
        path: Option<String>,
    },
    /// 텍스트 파일 뷰어 탭 (에디터가 아니다 — 읽기 전용). 경로는 필수다.
    TextViewer {
        path: String,
    },
    /// 마크다운 렌더 뷰어 탭 (21단계 청크 D). TextViewer 와 같은 파일을 다른
    /// 방식으로 볼 뿐이라 계약은 동일하다 — 읽기 전용, 경로 필수. 스크롤
    /// 시맨틱만 다르다 (렌더된 px — [`crate::model::TabKind`] rustdoc).
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
                write!(f, "invalid scroll offset {value}: must be finite and >= 0")
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
        /// 종료 시각 (epoch ms) — 코어는 시계를 읽지 않으므로 글루가 주입한다.
        ended_at_ms: u64,
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

    /// 영구히 닫힌 터미널 탭의 HISTFILE·resume 힌트를 한 배치로 해제한다.
    /// SessionExited는 재시작에 자원을 재사용하므로 이 경로에 들어오지 않는다.
    /// 탭별 자원이 없는 호스트를 위해 기본 구현은 비어 있다.
    fn release_tabs(&self, _tabs: &[TabId], _distro: Option<&str>) {}
}

/// revision 을 곁들인 상태 직렬화 뷰 — `state-changed` emit·`get_state` 응답 형태.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot<'a> {
    pub revision: u64,
    pub state: &'a AppState,
}

/// [`Dispatcher::list_tabs`]의 JSON 응답 DTO. 스냅샷 모델과 독립된 외부 계약이다.
/// 셸·에이전트 소비자를 위해 ID는 u64, kind/status는 문자열로 내보낸다.
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
    /// 탭 종류 — 모델 [`crate::model::TabKind`] 의 camelCase 이름
    /// (`terminal` | `folderBrowser` | `textViewer` | `markdownViewer`).
    pub kind: &'static str,
    /// `running` | `exited` (터미널) | `viewer` (프로세스가 없는 뷰어 탭).
    pub status: &'static str,
}

/// 상태 소유자. 모든 구조 변이는 [`Dispatcher::dispatch`] 를 경유한다.
pub struct Dispatcher {
    state: AppState,
    host: Box<dyn SessionHost>,
    /// OSC 시작 표식과 워치독 마감 보고는 순서가 보장되지 않는다.
    /// 이미 본 표식은 별도로 기억해 늦은 마감이 Running을 NotStarted로 되돌리지 못하게 한다.
    /// 세션 ID는 휘발성이므로 persist하지 않는다.
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
}

fn unknown(kind: &str, id: u64) -> CommandError {
    CommandError::UnknownTarget {
        target: format!("{kind} {id}"),
    }
}

#[cfg(test)]
mod tests;
