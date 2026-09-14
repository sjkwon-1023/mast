//! 상태 변이 전 탭 준비, 터미널 재스폰과 영구 탭 자원 해제를 담당한다.

use super::{unknown, CommandError, Dispatcher, NewTab, ShellSpawnReq};
use crate::model::{NotificationState, Tab, TabId, TabKind, TerminalStatus};
use crate::session::SessionId;

impl Dispatcher {
    /// 부팅 재스폰 대상: Running 터미널 중 pty_session이 없는 탭만 열거한다.
    /// Exited는 자동 복원하지 않고 사용자 Restart를 기다린다 (ADR-0018).
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

    /// 세션 없는 Running, NotStarted, Exited 탭을 같은 탭 ID로 재스폰한다.
    /// 남아 있는 이전 세션은 먼저 kill한다. 다른 대상은 상태 변경 없이 UnknownTarget이다.
    /// cwd는 탭 cwd → 워크스페이스 root_path, distro는 워크스페이스 값, 크기는 80×24다.
    /// history_tab은 같은 탭 ID이며 기록된 cwd는 바꾸지 않는다.
    ///
    /// 성공 시 새 세션 ID를 넣고, 스폰 실패 시 Exited로 내린다 (dispatch의 원자성 계약과 다름).
    /// 기존 Exited의 code/ended_at_ms는 유지하고, 다른 상태에서 실패하면 둘 다 None이다.
    /// 성공·강등 모두 revision을 증가시킨다. 마지막 화면 기록의 수명은 ADR-0018을 따른다.
    pub fn respawn_tab(&mut self, tab: TabId) -> Result<SessionId, CommandError> {
        let (wi, pane, ti) = self.locate_tab(tab)?;
        // 적격성 검사 — 통과 못 하면 상태·revision 불변으로 에러. 함께 떠 두는
        // `prior_exit` 은 스폰이 실패했을 때 되돌려 놓을 종료 정보다.
        let kind = &self.state.workspaces[wi].panes[&pane].tabs[ti].kind;
        let (tab_cwd, stale, prior_exit) = match kind {
            TabKind::Terminal {
                pty_session: None,
                status: TerminalStatus::Running,
                cwd,
            } => (cwd.clone(), None, None),
            TabKind::Terminal {
                pty_session,
                status: status @ (TerminalStatus::NotStarted | TerminalStatus::Exited { .. }),
                cwd,
            } => {
                let prior_exit = match status {
                    TerminalStatus::Exited { code, ended_at_ms } => Some((*code, *ended_at_ms)),
                    _ => None,
                };
                (cwd.clone(), *pty_session, prior_exit)
            }
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
                // 스폰 실패 강등. 원래 Exited 였다면 그 종료 정보를 그대로 되돌려 놓는다 —
                // 실패한 재스폰은 기록 파일을 지우지 않아 화면은 여전히 그 셸의 것이고,
                // 여기서 code·시각을 지우면 배너만 화면과 다른 이야기를 하게 된다.
                // NotStarted·세션 없는 Running 에서 온 강등에는 지목할 종료가 없어 둘 다
                // None 이고, 배너가 그 조각들을 생략한다.
                let (code, ended_at_ms) = prior_exit.unwrap_or((None, None));
                *pty_session = None;
                *status = TerminalStatus::Exited { code, ended_at_ms };
                Err(err)
            }
        };
        self.state.revision += 1;
        for ws in &self.state.workspaces {
            ws.debug_assert_invariants();
        }
        result
    }

    /// 워크스페이스 기본값(root_path·distro)을 적용한 [`Self::prepare_tab_with`]
    /// — 이미 상태에 있는 워크스페이스(CreateTab·SplitPane)용.
    pub(super) fn prepare_tab(
        &self,
        wi: usize,
        spec: NewTab,
        history_tab: u64,
    ) -> Result<PreparedTab, CommandError> {
        let ws = &self.state.workspaces[wi];
        self.prepare_tab_with(&ws.root_path, &ws.distro, spec, history_tab)
    }

    /// 스폰 또는 뷰어 경로 검증을 준비한다. 호출자는 모든 상태 변이 전에 이 단계를 끝낸다.
    /// history_tab은 아직 발급되지 않은 안정 ID를 [`crate::model::AppState::peek_id`]로 읽어 넘긴 값이다.
    pub(super) fn prepare_tab_with(
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
            NewTab::ChangesViewer { path } => {
                let path = path
                    .or_else(|| root_path.clone())
                    .unwrap_or_else(|| "/".to_owned());
                validate_viewer_path(&path)?;
                Ok(PreparedTab::Viewer {
                    title: "Changes".to_owned(),
                    kind: TabKind::ChangesViewer { path },
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

    /// 영구히 닫힌 터미널은 pty_session이 있으면 status와 무관하게 kill한다.
    /// 세션이 없는 탭도 HISTFILE이 있을 수 있어 자원 해제는 모든 터미널 탭을 한 배치로 알린다.
    /// 셸의 종료 flush가 HISTFILE을 되살리지 않도록 kill을 해제보다 먼저 요청한다.
    pub(super) fn retire_tabs<'a>(
        &self,
        distro: Option<&str>,
        tabs: impl Iterator<Item = &'a Tab>,
    ) {
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
pub(super) fn validate_viewer_path(path: &str) -> Result<(), CommandError> {
    crate::wslpath::validate_linux_path(path)
        .map_err(|message| CommandError::InvalidPath { message })
}

/// 경로에서 탭 제목으로 쓸 basename 을 뽑는다. 빈 세그먼트(`//`·후행 `/`)는
/// 건너뛰고, 남는 컴포넌트가 없으면(루트) `"/"` 를 쓴다.
pub(super) fn path_title(path: &str) -> String {
    path.rsplit('/')
        .find(|component| !component.is_empty())
        .unwrap_or("/")
        .to_owned()
}

/// 탭 생성 앞단([`Dispatcher::prepare_tab_with`])의 결과 — terminal 은 스폰된
/// 세션과 실제 cwd, 뷰어는 검증을 마친 제목·종류. 어느 쪽이든 상태 변이 전에
/// 만들어지므로 이 값이 손에 들어온 시점에는 "실패할 일이 남아 있지 않다".
pub(super) enum PreparedTab {
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
    pub(super) fn into_tab(self, id: TabId) -> Tab {
        match self {
            PreparedTab::Terminal { session, cwd } => terminal_tab(id, session, cwd),
            PreparedTab::Viewer { title, kind } => viewer_tab(id, title, kind),
        }
    }

    /// 출력(`TabCreated` 등)에 실을 세션 id — 뷰어 탭은 None.
    pub(super) fn session(&self) -> Option<SessionId> {
        match self {
            PreparedTab::Terminal { session, .. } => Some(*session),
            PreparedTab::Viewer { .. } => None,
        }
    }
}
