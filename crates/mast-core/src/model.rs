//! 애플리케이션 순수 상태 모델 (계획 v2 4장, 10단계 계획 3-B).
//!
//! UI·PTY·Tauri 에 의존하지 않는 상태 트리. 계층은
//! `AppState → Workspace → SplitTree → Pane → Tab` 이며, 워크스페이스 레벨 탭은
//! 없다 — 탭 층은 pane 내부 하나뿐이다 (계획 v2 4장).
//!
//! # 안정 ID
//!
//! [`WorkspaceId`]/[`PaneId`]/[`TabId`]/[`SplitId`] 는 `AppState::next_id` **단일
//! u64 카운터**에서 발급되는 세션 내 안정 ID 다 (persistence 15단계·MCP v2 의
//! 참조 대상). PTY 의 휘발성 [`SessionId`](crate::session::SessionId)(u32 alias)
//! 와는 newtype 으로 타입 수준에서 구분된다.
//!
//! # 직렬화 계약
//!
//! 전 타입 `#[serde(rename_all = "camelCase")]`. 이 JSON 형태가 프론트 스냅샷과
//! 15단계 persistence 의 계약이며, golden fixture(`fixtures/stage10-*.json`)를
//! cargo test 와 프론트 vitest 가 공유 소비해 표류를 막는다. `panes` 맵의 키는
//! JSON 에서 문자열 숫자(`"2"`)로 직렬화된다 (JSON object 키 제약).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::session::SessionId;

/// 워크스페이스의 안정 ID. `AppState::alloc_id` 단일 카운터에서 발급.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct WorkspaceId(pub u64);

/// pane(= TabContainer)의 안정 ID. 외부(MCP v2)에서 대상 지정에 쓰인다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PaneId(pub u64);

/// 탭의 안정 ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct TabId(pub u64);

/// split 노드의 안정 ID — ResizeSplit 등 커맨드의 대상 지정에 쓰인다. 경로
/// 인덱스 주소는 트리 변이 후 다른 노드를 조용히 가리킬 수 있어(silent
/// misdirection) 배제했다 (11~12단계 계획 D1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct SplitId(pub u64);

/// 앱 전체 상태의 루트. 소유자는 Rust 쪽 dispatcher — 프론트는 스냅샷 뷰만 받는다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub workspaces: Vec<Workspace>,
    /// 마지막 워크스페이스를 닫으면 None 이 될 수 있다.
    pub active_workspace: Option<WorkspaceId>,
    /// 다음에 발급될 안정 ID. Workspace/Pane/Tab 전 종류가 공유한다 (1부터).
    pub next_id: u64,
    /// 성공한 상태 변이마다 +1. 프론트 스냅샷의 stale 판정 가드.
    pub revision: u64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            workspaces: Vec::new(),
            active_workspace: None,
            next_id: 1,
            revision: 0,
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 안정 ID 발급 — 전 종류(Workspace/Pane/Tab)가 이 단일 카운터를 공유하므로
    /// id 값만으로도 전역 유일하다.
    pub fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// 앞으로 발급될 안정 ID 를 **변이 없이** 미리 읽는다 (peek). `offset` 은
    /// 지금부터 몇 번째 발급인지 — 0 이면 다음 [`Self::alloc_id`] 가 돌려줄 값이다.
    ///
    /// 스폰이 id 발급보다 먼저 일어나는 spawn-first 원자성(command dispatcher) 때
    /// 문에, 스폰 요청에 "그 탭이 받게 될 id" 를 실어야 하는 경우가 있다. 호출자는
    /// 자기 핸들러의 할당 순서를 offset 으로 계산해 쓰고, 실제 발급 직후
    /// `debug_assert_eq!` 로 peek 값과 일치함을 잠근다 — 할당 순서를 바꾸면 코어
    /// 테스트가 즉시 터져 이 커플링이 드러난다.
    pub fn peek_id(&self, offset: u64) -> u64 {
        self.next_id + offset
    }

    pub fn workspace(&self, id: WorkspaceId) -> Option<&Workspace> {
        self.workspaces.iter().find(|ws| ws.id == id)
    }

    pub fn workspace_mut(&mut self, id: WorkspaceId) -> Option<&mut Workspace> {
        self.workspaces.iter_mut().find(|ws| ws.id == id)
    }
}

/// 워크스페이스 — 레이아웃(SplitTree) 1개와 pane 들을 소유한다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    /// 워크스페이스의 정체성이자 새 탭의 기본 cwd (계획 v2 4장).
    pub root_path: Option<String>,
    /// 이 워크스페이스의 터미널이 연결될 WSL 배포판 (계획 v2 5장).
    pub distro: Option<String>,
    /// git 정보 — 타입 공간만 확정, 값 채움은 19단계 (10단계 계획 1장).
    pub git_branch: Option<String>,
    pub git_dirty: Option<bool>,
    pub layout: SplitTree,
    pub panes: BTreeMap<PaneId, Pane>,
    pub active_pane: PaneId,
    /// OSC 알림이 갱신하는 에이전트 상태 (계획 v2 9장). 기록한 탭은
    /// [`Workspace::agent_status_source`] 에 남는다.
    pub agent_status: AgentStatus,
    /// 사이드바 미리보기용 OSC 777 body (계획 v2 9장).
    pub last_agent_message: Option<String>,
    /// `agent_status` 를 마지막으로 기록한 탭 (18단계 계획 core 계약). needsInput
    /// 우선 규칙에서 "같은 출처의 강등만 허용"을 판정하고, 그 탭이 사라질 때
    /// 상태를 Idle 로 되돌리는 리셋 대상을 알아내는 데 쓴다.
    ///
    /// None 이면 JSON 에 아예 나타나지 않는다 — 이 필드를 모르는 기존 스냅샷
    /// (golden fixture·디스크의 state.json)과 계약이 그대로 유지된다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_status_source: Option<TabId>,
}

impl Workspace {
    /// 상태 불변식 검사 — Result 판. persistence 복원(15단계) 등 릴리즈 빌드에서도
    /// 신뢰할 수 없는 입력(디스크의 state.json)을 검증해야 하는 경로가 쓴다.
    ///
    /// - layout 의 leaf 집합 == `panes` 키 집합 (중복 leaf 도 불허)
    /// - layout 의 split id 는 트리 전체에서 유일
    /// - `active_pane` 은 `panes` 에 존재
    /// - 각 pane 의 `active_tab` 은 그 pane 의 `tabs` 에 존재
    ///
    /// 첫 위반에서 사람이 읽을 사유 문자열로 실패한다.
    pub fn validate(&self) -> Result<(), String> {
        let leaf_list = self.layout.leaves();
        let leaf_set: std::collections::BTreeSet<PaneId> = leaf_list.iter().copied().collect();
        if leaf_list.len() != leaf_set.len() {
            return Err(format!("workspace {:?}: layout 에 중복 leaf", self.id));
        }
        let split_list = self.layout.split_ids();
        let split_set: std::collections::BTreeSet<SplitId> = split_list.iter().copied().collect();
        if split_list.len() != split_set.len() {
            return Err(format!("workspace {:?}: layout 에 중복 split id", self.id));
        }
        self.layout
            .validate_ratios()
            .map_err(|e| format!("workspace {:?}: {e}", self.id))?;
        let key_set: std::collections::BTreeSet<PaneId> = self.panes.keys().copied().collect();
        if leaf_set != key_set {
            return Err(format!(
                "workspace {:?}: layout leaf 집합 {:?} != panes 키 집합 {:?}",
                self.id, leaf_set, key_set
            ));
        }
        if !self.panes.contains_key(&self.active_pane) {
            return Err(format!(
                "workspace {:?}: active_pane {:?} 이 panes 에 없음",
                self.id, self.active_pane
            ));
        }
        for pane in self.panes.values() {
            if let Some(tab) = pane.active_tab {
                if !pane.tabs.iter().any(|t| t.id == tab) {
                    return Err(format!(
                        "pane {:?}: active_tab {:?} 이 tabs 에 없음",
                        pane.id, tab
                    ));
                }
            }
        }
        Ok(())
    }

    /// 상태 불변식 검사 (debug 빌드 전용) — [`Workspace::validate`] 의 assert 래퍼.
    /// 커맨드 변이 직후처럼 "위반 = 코어 버그"인 내부 경로에서 쓴다.
    pub fn debug_assert_invariants(&self) {
        #[cfg(debug_assertions)]
        if let Err(msg) = self.validate() {
            panic!("불변식 위반: {msg}");
        }
    }
}

/// 에이전트 상태 3값 enum — 이진 unread 가 아니다 (계획 v2 9장).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    Running,
    NeedsInput,
    Idle,
}

/// 탭 알림 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationState {
    None,
    Unread,
}

/// 분할 방향.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

/// 워크스페이스 레이아웃 이진 트리. leaf 가 pane 하나에 대응한다.
///
/// JSON 은 다른 계약(TabKind·Command 등)과 동일한 internal tag 를 쓴다:
/// `{"type": "leaf", "pane": 2}` | `{"type": "split", ...}` — TS 쪽이 `type`
/// discriminant 하나로 일관되게 narrowing 하고, persistence(15단계)도 같은
/// 규약을 따른다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SplitTree {
    #[serde(rename_all = "camelCase")]
    Leaf { pane: PaneId },
    #[serde(rename_all = "camelCase")]
    Split {
        /// split 노드의 안정 ID — ResizeSplit 의 대상 주소 (계획 D1).
        id: SplitId,
        direction: SplitDirection,
        /// first 가 차지하는 비율 (0.0~1.0 개구간). 생성 시 0.5, 이후
        /// ResizeSplit 커맨드로 변경된다.
        /// f64 인 이유: JSON/TS 의 수 표현이 f64 라, f32 는 0.3 같은 값의
        /// 왕복에서 미세 변형을 일으켜 fixture 동등성·persistence 안정성을 깬다.
        ratio: f64,
        first: Box<SplitTree>,
        second: Box<SplitTree>,
    },
}

impl SplitTree {
    /// `target` leaf 를 `Split` 로 치환한다. 기존 pane 이 `first`(좌/상),
    /// 새 pane 이 `second`(우/하)로 들어가며 ratio 는 0.5. 새 split 노드의 id 는
    /// 호출자가 발급해 주입한다 (트리는 allocator 접근이 없다 — 계획 D1).
    /// `target` 이 tree 에 없으면 false 를 반환하고 변경 없음.
    pub fn split(
        &mut self,
        target: PaneId,
        direction: SplitDirection,
        new_pane: PaneId,
        split_id: SplitId,
    ) -> bool {
        match self {
            SplitTree::Leaf { pane } if *pane == target => {
                *self = SplitTree::Split {
                    id: split_id,
                    direction,
                    ratio: 0.5,
                    first: Box::new(SplitTree::Leaf { pane: target }),
                    second: Box::new(SplitTree::Leaf { pane: new_pane }),
                };
                true
            }
            SplitTree::Leaf { .. } => false,
            SplitTree::Split { first, second, .. } => {
                first.split(target, direction, new_pane, split_id)
                    || second.split(target, direction, new_pane, split_id)
            }
        }
    }

    /// `target` split 노드의 ratio 를 갱신한다. 값 검증(개구간·finite)은
    /// 호출자(ResizeSplit 핸들러) 책임이다. 없으면 false, 변경 없음.
    pub fn set_ratio(&mut self, target: SplitId, ratio: f64) -> bool {
        match self {
            SplitTree::Leaf { .. } => false,
            SplitTree::Split {
                id,
                ratio: r,
                first,
                second,
                ..
            } => {
                if *id == target {
                    *r = ratio;
                    true
                } else {
                    first.set_ratio(target, ratio) || second.set_ratio(target, ratio)
                }
            }
        }
    }

    /// `target` leaf 를 제거하고 형제 subtree 를 부모 자리로 승격(collapse)한다.
    /// 루트가 단일 leaf 인 경우(워크스페이스의 마지막 pane)는 제거할 수 없어
    /// false — 호출자(ClosePane)가 `LastPane` 에러로 사전에 막는다.
    pub fn remove(&mut self, target: PaneId) -> bool {
        let SplitTree::Split { first, second, .. } = self else {
            return false;
        };
        if matches!(**first, SplitTree::Leaf { pane } if pane == target) {
            // second 를 루트 자리로 승격. mem::replace 의 대체값은 곧바로
            // *self 에 덮여 버려지는 dummy 다.
            let promoted = std::mem::replace(&mut **second, SplitTree::Leaf { pane: target });
            *self = promoted;
            return true;
        }
        if matches!(**second, SplitTree::Leaf { pane } if pane == target) {
            let promoted = std::mem::replace(&mut **first, SplitTree::Leaf { pane: target });
            *self = promoted;
            return true;
        }
        first.remove(target) || second.remove(target)
    }

    /// leaf 들을 좌→우(in-order) 순으로 나열한다.
    pub fn leaves(&self) -> Vec<PaneId> {
        let mut out = Vec::new();
        self.collect_leaves(&mut out);
        out
    }

    fn collect_leaves(&self, out: &mut Vec<PaneId>) {
        match self {
            SplitTree::Leaf { pane } => out.push(*pane),
            SplitTree::Split { first, second, .. } => {
                first.collect_leaves(out);
                second.collect_leaves(out);
            }
        }
    }

    /// ratio 가 finite·개구간 (0,1) 인지 재귀 검증한다 — persistence 복원 경로용.
    /// 커맨드 경로는 ResizeSplit 검증이 막지만, JSON 은 5.0·음수 같은 범위 밖
    /// 값을 실을 수 있어 디스크 입력에는 별도 검증이 필요하다 (14~15 리뷰 finding).
    pub fn validate_ratios(&self) -> Result<(), String> {
        match self {
            SplitTree::Leaf { .. } => Ok(()),
            SplitTree::Split {
                id,
                ratio,
                first,
                second,
                ..
            } => {
                if !ratio.is_finite() || *ratio <= 0.0 || *ratio >= 1.0 {
                    return Err(format!("split {id:?} ratio {ratio} 가 개구간 (0,1) 밖"));
                }
                first.validate_ratios()?;
                second.validate_ratios()
            }
        }
    }

    /// split 노드 id 들을 전위(pre-order) 순으로 나열한다 (불변식 검사용).
    pub fn split_ids(&self) -> Vec<SplitId> {
        let mut out = Vec::new();
        self.collect_split_ids(&mut out);
        out
    }

    fn collect_split_ids(&self, out: &mut Vec<SplitId>) {
        match self {
            SplitTree::Leaf { .. } => {}
            SplitTree::Split {
                id, first, second, ..
            } => {
                out.push(*id);
                first.collect_split_ids(out);
                second.collect_split_ids(out);
            }
        }
    }

    /// `pane` 이 leaf 로 존재하는지.
    pub fn contains(&self, pane: PaneId) -> bool {
        match self {
            SplitTree::Leaf { pane: p } => *p == pane,
            SplitTree::Split { first, second, .. } => first.contains(pane) || second.contains(pane),
        }
    }
}

/// pane(= TabContainer). 탭이 0개인 빈 pane 이 남는 경로는 두 가지다:
/// **워크스페이스의 마지막 pane**(CloseTab auto-collapse 의 예외 — 11~12단계 계획
/// D6, `Command::CloseTab` rustdoc 참조)과 `SplitPane { tab: None }`(dev 훅·MCP 용
/// 존치 경로 — UI 분할 아이콘은 항상 tab 을 실어 원자 생성한다).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    pub id: PaneId,
    pub tabs: Vec<Tab>,
    pub active_tab: Option<TabId>,
}

/// 탭 — 종류는 [`TabKind`] 로 구분한다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: TabId,
    pub title: String,
    pub kind: TabKind,
    pub notification: NotificationState,
    /// 마지막 활동 시각 (epoch ms) — OSC 델타 반영 시 글루가 주입한 시각으로
    /// 갱신된다 (코어는 시계를 읽지 않는다).
    pub last_activity_ms: Option<u64>,
}

/// 탭 종류별 상태 (10단계 계획 1장 "타입 공간은 지금 확정" 기준). 생성 경로는
/// folderBrowser·textViewer 가 21단계, markdownViewer 는 그 마지막 청크다
/// (`command::NewTab` 은 착지한 종류만 싣는다).
///
/// # scroll_top 시맨틱
///
/// 뷰어의 스크롤 위치는 종류마다 단위가 다르다 — textViewer 는 **최상단 가시
/// 행의 전역 byte offset**(파일이 커도 창 이동과 무관하게 같은 지점을 가리키게
/// 하는 값), markdownViewer 는 **렌더된 픽셀 offset** 이다. folderBrowser 는
/// 스크롤 위치를 기억하지 않아 필드 자체가 없다 (`SetViewerScroll` 대상이 되면
/// `KindMismatch`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TabKind {
    Terminal {
        /// 휘발성 PTY 세션 id. 세션 종료 후에도 유지된다 (Exited 탭 표시용).
        pty_session: Option<SessionId>,
        status: TerminalStatus,
        cwd: Option<String>,
    },
    FolderBrowser {
        path: String,
    },
    TextViewer {
        path: String,
        /// 최상단 가시 행의 전역 byte offset (enum rustdoc 참조).
        scroll_top: f64,
    },
    MarkdownViewer {
        path: String,
        /// 렌더된 픽셀 offset (enum rustdoc 참조).
        scroll_top: f64,
    },
}

/// 터미널 탭의 프로세스 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalStatus {
    Running,
    Exited { code: Option<u32> },
    /// 시작 표식이 마감 안에 오지 않았다 (`SessionOptions::startup_deadline`).
    ///
    /// 감지 시점에는 프로세스가 **살아 있다** — 감지는 세션을 죽이지 않는다. 다만 재시작
    /// 복원 뒤에는 persist sanitize 가 `pty_session` 을 비우므로 이 상태로 남은 탭에
    /// 프로세스가 없을 수 있다 (그때도 재시도 경로는 열려 있다).
    ///
    /// `Exited` 와 나누는 이유는 사용자에게 전혀 다른 상황이기 때문이다 — "끝났다"가
    /// 아니라 "아직 시작도 못 했다"이고, 후자는 대개 WSL 이 느리거나 응답하지 않는다는
    /// 신호라 안내가 달라야 한다. 이 구분이 없어서 실기 사고 때 빈 탭의 원인이 앱인지
    /// WSL 인지 알 수 없었다.
    ///
    /// **종착 상태가 아니다.** 감지는 세션을 죽이지 않으므로, 표식이 늦게라도 도착하면
    /// `Running` 으로 되돌아간다 (`Dispatcher::apply_delta`).
    NotStarted,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(id: u64) -> SplitTree {
        SplitTree::Leaf { pane: PaneId(id) }
    }

    #[test]
    fn validate_ratios_rejects_out_of_range() {
        let mut tree = SplitTree::Split {
            id: SplitId(9),
            direction: SplitDirection::Horizontal,
            ratio: 5.0,
            first: Box::new(leaf(1)),
            second: Box::new(leaf(2)),
        };
        assert!(tree.validate_ratios().is_err());
        if let SplitTree::Split { ratio, .. } = &mut tree {
            *ratio = 0.5;
        }
        assert!(tree.validate_ratios().is_ok());
        assert!(leaf(1).validate_ratios().is_ok());
    }

    fn split(id: u64, direction: SplitDirection, first: SplitTree, second: SplitTree) -> SplitTree {
        SplitTree::Split {
            id: SplitId(id),
            direction,
            ratio: 0.5,
            first: Box::new(first),
            second: Box::new(second),
        }
    }

    #[test]
    fn split_replaces_leaf_with_split() {
        let mut tree = leaf(1);
        assert!(tree.split(
            PaneId(1),
            SplitDirection::Horizontal,
            PaneId(2),
            SplitId(10)
        ));
        assert_eq!(
            tree,
            split(10, SplitDirection::Horizontal, leaf(1), leaf(2))
        );
    }

    #[test]
    fn split_nested_targets_inner_leaf() {
        let mut tree = split(10, SplitDirection::Horizontal, leaf(1), leaf(2));
        assert!(tree.split(PaneId(2), SplitDirection::Vertical, PaneId(3), SplitId(11)));
        assert_eq!(
            tree,
            split(
                10,
                SplitDirection::Horizontal,
                leaf(1),
                split(11, SplitDirection::Vertical, leaf(2), leaf(3)),
            )
        );
        assert_eq!(tree.split_ids(), vec![SplitId(10), SplitId(11)]);
    }

    #[test]
    fn split_missing_target_is_noop() {
        let mut tree = split(10, SplitDirection::Horizontal, leaf(1), leaf(2));
        let before = tree.clone();
        assert!(!tree.split(PaneId(9), SplitDirection::Vertical, PaneId(3), SplitId(11)));
        assert_eq!(tree, before);
    }

    #[test]
    fn set_ratio_targets_split_by_id() {
        let mut tree = split(
            10,
            SplitDirection::Horizontal,
            leaf(1),
            split(11, SplitDirection::Vertical, leaf(2), leaf(3)),
        );
        // 중첩 split 을 id 로 조준 — 다른 노드의 ratio 는 그대로.
        assert!(tree.set_ratio(SplitId(11), 0.3));
        let SplitTree::Split { ratio, second, .. } = &tree else {
            panic!("split 이어야 함");
        };
        assert_eq!(*ratio, 0.5);
        let SplitTree::Split { ratio: inner, .. } = &**second else {
            panic!("split 이어야 함");
        };
        assert_eq!(*inner, 0.3);
    }

    #[test]
    fn set_ratio_missing_id_is_noop() {
        let mut tree = split(10, SplitDirection::Horizontal, leaf(1), leaf(2));
        let before = tree.clone();
        assert!(!tree.set_ratio(SplitId(99), 0.3));
        assert_eq!(tree, before);
    }

    #[test]
    fn remove_promotes_sibling_subtree() {
        // (1 | (2 / 3)) 에서 2 제거 → (1 | 3), 다시 3 제거 → 1 단일 leaf.
        // collapse 로 사라지는 것은 제거 대상의 **부모 split 노드**(여기선 id 11)
        // 이고, 승격되는 형제 subtree 는 자기 구조·id 를 유지한다.
        let mut tree = split(
            10,
            SplitDirection::Horizontal,
            leaf(1),
            split(11, SplitDirection::Vertical, leaf(2), leaf(3)),
        );
        assert!(tree.remove(PaneId(2)));
        assert_eq!(
            tree,
            split(10, SplitDirection::Horizontal, leaf(1), leaf(3))
        );
        assert!(tree.remove(PaneId(3)));
        assert_eq!(tree, leaf(1));
    }

    #[test]
    fn remove_first_child_promotes_second() {
        // ((1 / 2) | 3) 에서 3 제거 → (1 / 2) subtree 가 루트로 승격 (id 11 유지).
        let inner = split(11, SplitDirection::Vertical, leaf(1), leaf(2));
        let mut tree = split(10, SplitDirection::Horizontal, inner.clone(), leaf(3));
        assert!(tree.remove(PaneId(3)));
        assert_eq!(tree, inner);
    }

    #[test]
    fn remove_root_leaf_is_rejected() {
        let mut tree = leaf(1);
        assert!(!tree.remove(PaneId(1)));
        assert_eq!(tree, leaf(1));
    }

    #[test]
    fn remove_missing_target_is_noop() {
        let mut tree = split(10, SplitDirection::Horizontal, leaf(1), leaf(2));
        let before = tree.clone();
        assert!(!tree.remove(PaneId(9)));
        assert_eq!(tree, before);
    }

    #[test]
    fn leaves_are_in_left_to_right_order() {
        let tree = split(
            10,
            SplitDirection::Horizontal,
            split(11, SplitDirection::Vertical, leaf(1), leaf(2)),
            leaf(3),
        );
        assert_eq!(tree.leaves(), vec![PaneId(1), PaneId(2), PaneId(3)]);
        assert_eq!(tree.split_ids(), vec![SplitId(10), SplitId(11)]);
    }

    #[test]
    fn contains_checks_leaves_only() {
        let tree = split(10, SplitDirection::Horizontal, leaf(1), leaf(2));
        assert!(tree.contains(PaneId(1)));
        assert!(tree.contains(PaneId(2)));
        assert!(!tree.contains(PaneId(3)));
    }

    fn test_pane(id: u64) -> Pane {
        Pane {
            id: PaneId(id),
            tabs: Vec::new(),
            active_tab: None,
        }
    }

    fn test_workspace() -> Workspace {
        Workspace {
            id: WorkspaceId(1),
            name: "test".into(),
            root_path: None,
            distro: None,
            git_branch: None,
            git_dirty: None,
            layout: split(4, SplitDirection::Horizontal, leaf(2), leaf(3)),
            panes: [(PaneId(2), test_pane(2)), (PaneId(3), test_pane(3))].into(),
            active_pane: PaneId(2),
            agent_status: AgentStatus::Idle,
            last_agent_message: None,
            agent_status_source: None,
        }
    }

    #[test]
    fn agent_status_source_is_omitted_while_none() {
        // None → JSON 에 키 자체가 없다 (이 필드를 모르는 기존 스냅샷과의 계약
        // 유지 — fixtures/stage10-snapshot.json round-trip 은 tests/dispatcher.rs).
        let mut ws = test_workspace();
        let json = serde_json::to_value(&ws).unwrap();
        assert!(
            json.get("agentStatusSource").is_none(),
            "None 인데 키가 나타남: {json}"
        );

        // Some → camelCase 키로 탭 id 가 실린다.
        ws.agent_status_source = Some(TabId(7));
        let json = serde_json::to_value(&ws).unwrap();
        assert_eq!(json["agentStatusSource"], serde_json::json!(7));

        // 키 없는 JSON 은 None 으로 역직렬화된다 (serde default).
        let mut without = json.as_object().unwrap().clone();
        without.remove("agentStatusSource");
        let parsed: Workspace = serde_json::from_value(without.into()).unwrap();
        assert_eq!(parsed.agent_status_source, None);
    }

    #[test]
    fn workspace_invariants_hold_for_consistent_state() {
        let ws = test_workspace();
        assert_eq!(ws.validate(), Ok(()));
        ws.debug_assert_invariants();
    }

    #[test]
    fn validate_rejects_each_invariant_violation() {
        // leaf 집합 != panes 키 집합 (pane 3 누락).
        let mut ws = test_workspace();
        ws.panes.remove(&PaneId(3));
        assert!(ws.validate().unwrap_err().contains("panes 키 집합"));

        // 중복 leaf.
        let mut ws = test_workspace();
        ws.layout = split(4, SplitDirection::Horizontal, leaf(2), leaf(2));
        assert!(ws.validate().unwrap_err().contains("중복 leaf"));

        // 중복 split id.
        let mut ws = test_workspace();
        ws.layout = split(
            4,
            SplitDirection::Horizontal,
            split(4, SplitDirection::Vertical, leaf(2), leaf(5)),
            leaf(3),
        );
        ws.panes.insert(PaneId(5), test_pane(5));
        assert!(ws.validate().unwrap_err().contains("중복 split id"));

        // active_pane 이 panes 에 없음.
        let mut ws = test_workspace();
        ws.active_pane = PaneId(99);
        assert!(ws.validate().unwrap_err().contains("active_pane"));

        // active_tab 이 tabs 에 없음.
        let mut ws = test_workspace();
        ws.panes.get_mut(&PaneId(2)).unwrap().active_tab = Some(TabId(42));
        assert!(ws.validate().unwrap_err().contains("active_tab"));
    }
}
