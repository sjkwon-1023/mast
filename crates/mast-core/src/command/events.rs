//! 세션 종료·시작과 OSC 배치를 모델에 반영한다.

use std::cmp::Reverse;

use super::{Dispatcher, SessionEvent};
use crate::model::{
    AgentStatus, NotificationState, PaneId, Tab, TabId, TabKind, TerminalStatus, Workspace,
};
use crate::notify::{OscBatch, OscDelta};

impl Dispatcher {
    /// 세션 이벤트 반영. 상태가 실제로 바뀔 때만 `revision += 1`.
    pub fn apply_event(&mut self, ev: SessionEvent) {
        match ev {
            SessionEvent::SessionExited {
                session,
                code,
                ended_at_ms,
            } => {
                self.started_sessions.remove(&session);
                let mut changed = false;
                for ws in &mut self.state.workspaces {
                    let mut exited = Vec::new();
                    for pane in ws.panes.values_mut() {
                        for tab in &mut pane.tabs {
                            if let TabKind::Terminal {
                                pty_session,
                                status,
                                ..
                            } = &mut tab.kind
                            {
                                if *pty_session == Some(session) {
                                    // 세션을 놓는다 — 죽은 세션에 attach 할 길을 남기지
                                    // 않는 것이 기록(ADR-0018)의 전제다. 글루는 이 이벤트를
                                    // 반영한 뒤 레지스트리에서도 세션·sink 를 지운다.
                                    *pty_session = None;
                                    *status = TerminalStatus::Exited {
                                        code,
                                        ended_at_ms: Some(ended_at_ms),
                                    };
                                    changed = true;
                                    exited.push(tab.id);
                                }
                            }
                        }
                    }
                    // 죽은 셸의 에이전트는 더 이상 입력을 기다리지 않는다 — 비우지 않으면
                    // 그 needsInput 과 문구가 워크스페이스 파생값에 계속 남는다.
                    for tab in exited {
                        changed |= clear_tab_agent(ws, tab);
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
                                // Running 만 강등해 NotStarted 재보고를 no-op 으로
                                // 닫는다. 마감 직전에 종료한 세션의 경합 — 끝난 탭이
                                // "시작 안 됨"으로 되살아나는 오분류 — 은 이제 위쪽
                                // 패턴이 막는다: 자연 종료한 탭은 세션을 놓으므로
                                // (ADR-0018) `pty_session: Some(s)` 에 걸리지 않는다.
                                if *s == session && *status == TerminalStatus::Running {
                                    *status = TerminalStatus::NotStarted;
                                    changed = true;
                                }
                            }
                        }
                    }
                }
                // 에이전트 상태는 건드리지 않는다 — 세션이 살아 있고 표식이 늦게
                // 오면 되돌아가므로, 죽은 탭 정리(SessionExited)와 규칙이 다르다.
                if changed {
                    self.state.revision += 1;
                }
            }
        }
    }

    /// OSC 배치를 반영하고 실제 변경 여부를 반환한다. 변경 시 revision은 배치당 한 번 증가한다.
    /// 미지·종료 세션은 무시하며 now_ms는 호출자가 주입한다.
    pub fn apply_osc(&mut self, batch: OscBatch, now_ms: u64) -> bool {
        self.osc_batch_seq += 1;
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
        let message_seq = self.osc_batch_seq;

        let ws = &mut self.state.workspaces[wi];
        let tab = &mut ws
            .panes
            .get_mut(&pane)
            .expect("locate_session 이 존재를 보장")
            .tabs[ti];
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
            if tab.agent_status != status {
                tab.agent_status = status;
                changed = true;
            }
        }
        if let Some(message) = &delta.message {
            if tab.last_agent_message.as_deref() != Some(message.as_str()) {
                tab.last_agent_message = Some(message.clone());
                changed = true;
            }
            tab.last_agent_message_seq = Some(message_seq);
        }
        changed |= recompute_agent_summary(ws);
        changed
    }
}

/// 워크스페이스의 저장 파생값(`agent_status`·`last_agent_message`)을 탭들에서 다시
/// 계산한다. 반환값은 파생값이 바뀌었는가 (revision 판정용).
///
/// - 상태: 모든 탭 중 [`AgentStatus::urgency`] 최대.
/// - 메시지(NeedsInput): NeedsInput 탭 중 메시지가 있는 탭의 가장 최근 것, 그런 탭이
///   없으면 `None`. 기다리는 카드에 다른 탭의 문구("done" 등)를 빌려 싣지 않는다.
/// - 메시지(Running·Idle): 전체 탭 중 가장 최근 것. Running 훅은 본문이 없어 탭의
///   이전 문구를 지우지 못하므로, Running 탭으로 좁히면 그 탭이 전에 받은 문구가
///   다른 탭의 더 새 알림을 가린다.
/// - 최근 = `last_agent_message_seq`, 동률(같은 배치)은 작은 TabId. `last_activity_ms`
///   는 제목·cwd 델타에도 갱신돼 "마지막으로 알린 탭"의 기준이 되지 못한다.
pub(super) fn recompute_agent_summary(ws: &mut Workspace) -> bool {
    let tabs = || ws.panes.values().flat_map(|pane| pane.tabs.iter());
    let status = tabs()
        .map(|tab| tab.agent_status)
        .max_by_key(|status| status.urgency())
        .unwrap_or_default();
    let message = if status == AgentStatus::NeedsInput {
        latest_message(tabs().filter(|tab| tab.agent_status == AgentStatus::NeedsInput))
    } else {
        latest_message(tabs())
    };

    let changed = ws.agent_status != status || ws.last_agent_message != message;
    ws.agent_status = status;
    ws.last_agent_message = message;
    changed
}

fn latest_message<'a>(tabs: impl Iterator<Item = &'a Tab>) -> Option<String> {
    tabs.filter(|tab| tab.last_agent_message.is_some())
        .max_by_key(|tab| (tab.last_agent_message_seq, Reverse(tab.id)))
        .and_then(|tab| tab.last_agent_message.clone())
}

/// 탭의 에이전트 상태를 비우고 워크스페이스를 재계산한다. 반환값은 탭이나 파생값이
/// 바뀌었는가.
pub(super) fn clear_tab_agent(ws: &mut Workspace, tab: TabId) -> bool {
    let mut changed = false;
    if let Some(target) = ws
        .panes
        .values_mut()
        .flat_map(|pane| pane.tabs.iter_mut())
        .find(|t| t.id == tab)
    {
        changed = target.agent_status != AgentStatus::Idle || target.last_agent_message.is_some();
        target.agent_status = AgentStatus::Idle;
        target.last_agent_message = None;
        target.last_agent_message_seq = None;
    }
    recompute_agent_summary(ws) || changed
}
