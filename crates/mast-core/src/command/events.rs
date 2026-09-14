//! 세션 종료·시작과 OSC 배치를 모델에 반영한다.

use super::{Dispatcher, SessionEvent};
use crate::model::{
    AgentStatus, NotificationState, PaneId, TabId, TabKind, TerminalStatus, Workspace,
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
                // agent_status 출처는 건드리지 않는다 — 세션이 살아 있고 표식이 늦게
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
}

/// 사라지는 탭이 워크스페이스 `agent_status` 의 출처였으면 상태를 Idle 로 되돌린다
/// (18단계 계획 core 계약). 죽은 탭의 needsInput 이 사이드바에 남아 영원히 입력
/// 대기로 보이는 것을 막는 규칙이라, 탭이 사라지는 세 경로(`CloseTab`·`ClosePane`
/// 의 제거 탭 각각·`SessionExited`)가 전부 이 헬퍼를 거친다.
/// 반환값은 상태가 바뀌었는가 (revision 판정용).
pub(super) fn reset_agent_source(ws: &mut Workspace, tab: TabId) -> bool {
    if ws.agent_status_source != Some(tab) {
        return false;
    }
    ws.agent_status_source = None;
    ws.agent_status = AgentStatus::Idle;
    true
}
