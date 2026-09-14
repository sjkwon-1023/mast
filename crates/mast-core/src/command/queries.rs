//! 탭·세션 위치와 워크스페이스 안의 에이전트 전송 대상을 조회한다.

use super::{unknown, CommandError, Dispatcher, TabInfo};
use crate::model::{PaneId, TabId, TabKind, TerminalStatus};
use crate::send::SendTargetError;
use crate::session::SessionId;

impl Dispatcher {
    /// 상태·revision을 바꾸지 않고 전송 대상을 찾는다.
    /// 후보는 송신자와 같은 워크스페이스의 세션이 있는 Running 터미널이며 자신은 제외한다.
    /// 송신자 세션을 찾을 수 없거나 다른 워크스페이스를 겨누면 NoMatch다.
    ///
    /// #<10진 u64>는 ID 직접 지정이다. 조건 불일치는 NoMatch이며 Ambiguous는 없다.
    /// ID 파싱 실패는 제목 검색으로 돌아간다 (#build, #, #1.2, 범위 초과 포함).
    /// 제목은 대소문자 무시 부분일치다. 0건은 NoMatch, 2건 이상은 Ambiguous로 거부한다.
    /// 빈 검색어도 같은 규칙을 적용하므로 후보가 정확히 하나일 때만 성공한다.
    /// 열거 범위도 [`Self::list_tabs`]와 동일하다.
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

    /// wi는 송신자의 워크스페이스 인덱스다. 직접 지정한 ID도 이 경계를 넘을 수 없다.
    /// 조건 불일치는 NoMatch이며 전역 유일 ID이므로 Ambiguous는 발생하지 않는다.
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

    /// 요청자와 같은 워크스페이스의 모델 메타데이터를 상태 변경 없이 열거한다.
    /// 요청자 세션이 없으면 빈 목록이다. 뷰어도 포함하며 pane ID → 탭 표시 순서로 정렬된다.
    /// workspace_id/name은 외부 JSON 계약이므로 유지한다. 실행 중인 명령 등 OS 정보는 읽지 않는다.
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
                    TabKind::ChangesViewer { .. } => ("changesViewer", "viewer"),
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

    /// `pane` 을 소유한 워크스페이스의 인덱스 (전 워크스페이스 범위 탐색).
    pub(super) fn ws_index_of_pane(&self, pane: PaneId) -> Result<usize, CommandError> {
        self.state
            .workspaces
            .iter()
            .position(|ws| ws.panes.contains_key(&pane))
            .ok_or_else(|| unknown("pane", pane.0))
    }

    /// `session` 이 실린 탭의 (워크스페이스 인덱스, pane id, tab 인덱스).
    /// 세션 id 는 탭 하나에만 실리므로 첫 일치에서 멈춘다. 미지 세션은 None —
    /// 호출자(OSC 반영)가 no-op 으로 처리한다.
    pub(super) fn locate_session(&self, session: SessionId) -> Option<(usize, PaneId, usize)> {
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

    /// `session` 을 실은 탭의 id — 글루의 exit 경로가 "이 세션을 이 탭이 채택했는가"
    /// 를 묻는 자리다 (ADR-0018 D2). 스폰이 실패하거나 늦어 모델이 다른 세션을 채택한
    /// 뒤라면 다른 탭 id 이거나 None 이고, 그 세션의 exit 은 남의 탭 기록을 건드리면
    /// 안 된다.
    pub fn tab_of_session(&self, session: SessionId) -> Option<TabId> {
        self.locate_session(session)
            .map(|(wi, pane, ti)| self.state.workspaces[wi].panes[&pane].tabs[ti].id)
    }

    /// `session` 이 실린 탭이 속한 **워크스페이스 인덱스** — 에이전트 채널
    /// ([`Self::resolve_send_target`]·[`Self::list_tabs`])의 격리 경계 기준점이다.
    /// 역매핑은 [`Self::locate_session`] 을 그대로 재사용하고 pane·tab 위치만
    /// 버린다. 미지 세션은 None — 호출자가 각각 NoMatch·빈 목록으로 닫는다.
    fn workspace_index_of_session(&self, session: SessionId) -> Option<usize> {
        self.locate_session(session).map(|(wi, _, _)| wi)
    }

    /// `tab` 을 소유한 (워크스페이스 인덱스, pane id, tab 인덱스).
    pub(super) fn locate_tab(&self, tab: TabId) -> Result<(usize, PaneId, usize), CommandError> {
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

/// # 뒤가 10진 숫자로만 이루어진 u64일 때 ID로 해석한다. +부호·공백은 허용하지 않는다.
/// 실패하면 None이며 호출자는 제목 매칭으로 돌아간다.
pub(super) fn parse_tab_id_target(target: &str) -> Option<TabId> {
    let digits = target.strip_prefix('#')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok().map(TabId)
}
