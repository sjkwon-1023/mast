//! 구조 변경 명령을 실행한다. revision 증가와 최종 불변식 검사는 dispatch가 맡는다.

use super::events::recompute_agent_summary;
use super::tabs::{path_title, validate_viewer_path, viewer_tab, PreparedTab};
use super::{unknown, Command, CommandError, CommandOutput, Dispatcher, NewTab};
use crate::manager::{AgentEvent, AgentEventKind};
use crate::model::{
    AgentStatus, NotificationState, Pane, PaneId, SplitId, SplitTree, TabId, TabKind, Workspace,
    WorkspaceId,
};

impl Dispatcher {
    pub(super) fn execute(&mut self, cmd: Command) -> Result<CommandOutput, CommandError> {
        match cmd {
            Command::CreateWorkspace {
                name,
                root_path,
                distro,
                tab,
            } => {
                // 워크스페이스 루트는 WSL 파일시스템이어야 한다. /mnt는 뷰어의 읽기 경로로만 허용한다.
                // 프런트 검사를 우회하는 호출도 이 코어 경계에서 거부한다.
                #[cfg(not(target_os = "macos"))]
                if let Some(path) = root_path.as_deref() {
                    reject_mnt_root(path)?;
                }
                #[cfg(target_os = "macos")]
                let distro = { let _ = distro; None };
                // 스폰·경로 검증은 모든 상태 변이 전에 끝내 실패 시 상태와 ID를 보존한다.
                // 아직 없는 워크스페이스의 기본값을 넘기고 workspace → pane → tab 순서로 탭 ID를 예측한다.
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
                let created = Workspace {
                    id: workspace,
                    name,
                    root_path,
                    distro,
                    git_branch: None,
                    git_dirty: None,
                    manager: false,
                    layout: SplitTree::Leaf { pane },
                    panes: [(pane, initial)].into(),
                    active_pane: pane,
                    agent_status: AgentStatus::Idle,
                    last_agent_message: None,
                };
                // 기록 시점은 성공한 변이 뒤 — 스냅샷은 방금 만든 값에서 뜬다.
                let recorded = self.manager_snapshot(&created);
                self.state.workspaces.push(created);
                self.state.active_workspace = Some(workspace);
                if let Some(recorded) = recorded {
                    self.manager_events
                        .record(AgentEvent::new(AgentEventKind::WorkspaceOpened, recorded));
                }
                Ok(CommandOutput::WorkspaceCreated {
                    workspace,
                    pane,
                    tab: tab_id,
                    session,
                })
            }

            Command::CreateManagerWorkspace { root_path, distro } => {
                // 관리자 워크스페이스는 하나뿐이다 — 검증이 상태 변이보다 먼저라
                // 실패 시 상태·next_id·revision 이 전부 불변이다.
                if self.state.workspaces.iter().any(|ws| ws.manager) {
                    return Err(CommandError::ManagerExists);
                }
                crate::wslpath::validate_linux_path(&root_path)
                    .map_err(|message| CommandError::InvalidPath { message })?;
                #[cfg(not(target_os = "macos"))]
                reject_mnt_root(&root_path)?;
                #[cfg(target_os = "macos")]
                let distro = {
                    let _ = distro;
                    None
                };
                // 스폰·할당 순서는 CreateWorkspace 와 같다 — workspace → pane →
                // 터미널 탭 → 보드 탭 순으로 발급하므로 터미널 탭 id 는 peek_id(2) 다.
                let history_tab = self.state.peek_id(2);
                let root = Some(root_path);
                let prepared = self.prepare_tab_with(
                    &root,
                    &distro,
                    NewTab::Terminal { cwd: None },
                    history_tab,
                )?;
                let workspace = WorkspaceId(self.state.alloc_id());
                let pane = PaneId(self.state.alloc_id());
                let terminal = TabId(self.state.alloc_id());
                debug_assert_eq!(terminal.0, history_tab, "peek 한 탭 id 와 실제 발급 불일치");
                let board = TabId(self.state.alloc_id());
                let session = prepared.session();
                let mut initial = empty_pane(pane);
                initial.tabs.push(prepared.into_tab(terminal));
                initial.tabs.push(viewer_tab(
                    board,
                    "Manager".to_owned(),
                    TabKind::ManagerBoard,
                ));
                initial.active_tab = Some(board);
                self.state.workspaces.push(Workspace {
                    id: workspace,
                    name: "Manager".to_owned(),
                    root_path: root,
                    distro,
                    git_branch: None,
                    git_dirty: None,
                    manager: true,
                    layout: SplitTree::Leaf { pane },
                    panes: [(pane, initial)].into(),
                    active_pane: pane,
                    agent_status: AgentStatus::Idle,
                    last_agent_message: None,
                });
                // active_workspace 는 바꾸지 않는다 — None 이었을 때만 새 워크스페이스.
                if self.state.active_workspace.is_none() {
                    self.state.active_workspace = Some(workspace);
                }
                Ok(CommandOutput::WorkspaceCreated {
                    workspace,
                    pane,
                    tab: Some(terminal),
                    session,
                })
            }

            Command::RemoveManagerWorkspace => {
                let wi = self
                    .state
                    .workspaces
                    .iter()
                    .position(|ws| ws.manager)
                    .ok_or_else(|| CommandError::UnknownTarget {
                        target: "manager workspace".to_owned(),
                    })?;
                // 해체는 CloseWorkspace 와 같다 — retire_tabs 가 kill 과 자원 해제를
                // 모두 맡고, active fallback 은 그대로 첫 워크스페이스다.
                let removed = self.state.workspaces.remove(wi);
                let removed_id = removed.id;
                self.retire_tabs(
                    removed.distro.as_deref(),
                    removed.panes.values().flat_map(|pane| &pane.tabs),
                );
                if self.state.active_workspace == Some(removed_id) {
                    self.state.active_workspace = self.state.workspaces.first().map(|ws| ws.id);
                    if let Some(shown) = self.state.workspaces.first_mut() {
                        clear_visible_unread(shown);
                    }
                }
                Ok(CommandOutput::Done)
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
                // 관리자 워크스페이스는 고정 — 제거는 RemoveManagerWorkspace 뿐이다.
                if self.state.workspaces[wi].manager {
                    return Err(CommandError::ManagerPinned);
                }
                let removed = self.state.workspaces.remove(wi);
                // 닫히기 직전 이름·경로를 담는다 — 제거 뒤에는 읽을 수 없다.
                let recorded = self.manager_snapshot(&removed);
                let terminal_tabs: Vec<TabId> = removed
                    .panes
                    .values()
                    .flat_map(|pane| &pane.tabs)
                    .filter(|tab| matches!(tab.kind, TabKind::Terminal { .. }))
                    .map(|tab| tab.id)
                    .collect();
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
                // tabGone(터미널 탭마다)을 먼저, workspaceClosed 를 마지막에 — 순서가 계약이다.
                if let Some(recorded) = recorded {
                    for tab in terminal_tabs {
                        self.manager_events.record(
                            AgentEvent::new(AgentEventKind::TabGone, recorded.clone())
                                .with_tab(tab),
                        );
                    }
                    self.manager_events
                        .record(AgentEvent::new(AgentEventKind::WorkspaceClosed, recorded));
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
                // 관리자 워크스페이스는 자리도 고정이다 — 자기 이동과 이웃 지정
                // (before) 양쪽 모두 거부한다.
                if self.state.workspaces[from].manager {
                    return Err(CommandError::ManagerPinned);
                }
                if let Some(target) = before {
                    if target == workspace {
                        // 자기 앞 = 제자리. 옮길 것이 없다 (variant rustdoc).
                        return Ok(CommandOutput::Done);
                    }
                    let Some(target_ws) = self.state.workspaces.iter().find(|ws| ws.id == target)
                    else {
                        return Err(unknown("workspace", target.0));
                    };
                    if target_ws.manager {
                        return Err(CommandError::ManagerPinned);
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
                // 스폰·경로 검증은 트리 변이 전에 끝낸다. pane → split → tab 할당 순서로 탭 ID를 예측한다.
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
                // 보드 탭이 든 pane 은 고정 — LastPane 보다 이 판정이 먼저다
                // (관리자 워크스페이스는 pane 하나뿐이라 그대로면 LastPane 이 된다).
                if self.state.workspaces[wi].panes[&pane]
                    .tabs
                    .iter()
                    .any(|t| matches!(t.kind, TabKind::ManagerBoard))
                {
                    return Err(CommandError::ManagerPinned);
                }
                if self.state.workspaces[wi].panes.len() <= 1 {
                    return Err(CommandError::LastPane);
                }
                let removed = collapse_pane(&mut self.state.workspaces[wi], pane);
                recompute_agent_summary(&mut self.state.workspaces[wi]);
                let distro = self.state.workspaces[wi].distro.clone();
                let recorded = self.manager_snapshot(&self.state.workspaces[wi]);
                self.retire_tabs(distro.as_deref(), removed.tabs.iter());
                // 은퇴하는 터미널 탭마다 tabGone — 뷰어 탭은 에이전트 수명이 없다.
                if let Some(recorded) = recorded {
                    for tab in &removed.tabs {
                        if matches!(tab.kind, TabKind::Terminal { .. }) {
                            self.manager_events.record(
                                AgentEvent::new(AgentEventKind::TabGone, recorded.clone())
                                    .with_tab(tab.id),
                            );
                        }
                    }
                }
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
                // 보드 탭은 고정 — 관리자 터미널 탭은 기존대로 닫을 수 있다.
                if matches!(
                    self.state.workspaces[wi].panes[&pane].tabs[ti].kind,
                    TabKind::ManagerBoard
                ) {
                    return Err(CommandError::ManagerPinned);
                }
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
                recompute_agent_summary(ws);
                let distro = ws.distro.clone();
                let recorded = self.manager_snapshot(&self.state.workspaces[wi]);
                self.retire_tabs(distro.as_deref(), std::iter::once(&removed));
                // 은퇴하는 터미널 탭만 tabGone — 뷰어 탭은 에이전트 수명이 없다.
                if let Some(recorded) = recorded {
                    if matches!(removed.kind, TabKind::Terminal { .. }) {
                        self.manager_events.record(
                            AgentEvent::new(AgentEventKind::TabGone, recorded).with_tab(removed.id),
                        );
                    }
                }
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
}

/// Windows 드라이브는 데이터 전용이라 워크스페이스 루트가 될 수 없다 —
/// CreateWorkspace·CreateManagerWorkspace 공유 계약 (macOS 에는 /mnt 규칙이 없다).
#[cfg(not(target_os = "macos"))]
fn reject_mnt_root(path: &str) -> Result<(), CommandError> {
    if path == "/mnt" || path.starts_with("/mnt/") {
        return Err(CommandError::InvalidPath {
            message: format!(
                "workspace root cannot live under /mnt (Windows drives are data-only): {path}"
            ),
        });
    }
    Ok(())
}

fn empty_pane(id: PaneId) -> Pane {
    Pane {
        id,
        tabs: Vec::new(),
        active_tab: None,
    }
}

/// pane 제거·트리 collapse·active_pane 보정을 수행한다. 새 활성 pane은 leaf 순서의 첫 pane이다.
/// 호출자는 pane의 존재와 마지막 pane이 아님을 보장하고, 반환된 탭들의 세션을 종료해야 한다.
fn collapse_pane(ws: &mut Workspace, pane: PaneId) -> Pane {
    let removed = ws.panes.remove(&pane).expect("호출자가 pane 존재를 보장");
    let collapse_ok = ws.layout.remove(pane);
    debug_assert!(collapse_ok, "불변식: panes 의 pane 은 layout leaf 로 존재");
    if ws.active_pane == pane {
        ws.active_pane = ws.layout.leaves()[0];
    }
    removed
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
