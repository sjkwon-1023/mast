//! 모델과 세션·sink 레지스트리의 불일치를 읽기 전용으로 진단한다.

use crate::model::{AppState, TabId, TabKind};
use crate::session::SessionId;
use serde::Serialize;
use std::collections::HashSet;

/// 모델 ↔ 레지스트리 정합성 검사의 결과 ([`audit_registries`]). 진단 표면으로
/// 그대로 나간다(`get_diagnostics`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAudit {
    /// 레지스트리에 있는데 어떤 탭도 참조하지 않는 세션 — 해제 대상.
    pub orphan_sessions: Vec<SessionId>,
    /// 같은 판정의 sink 쪽.
    pub orphan_sinks: Vec<SessionId>,
    /// 탭이 `pty_session: Some(s)` 인데 `s` 가 두 레지스트리 중 **한쪽에라도**
    /// 없다 — attach 는 세션·sink 가 둘 다 있어야 사니 한쪽만 비어도 그 탭은 이미
    /// 못 쓴다. 이 버킷이 지시하는 수리는 탭을 Exited 로 되돌리는 것뿐이고, 한쪽에
    /// 살아남은 짝은 더 이상 어떤 탭도 참조하지 않으므로 **같은 라운드의 고아 버킷에
    /// 실려 해제(kill)된다** (ADR-0018 D5).
    pub dangling_tabs: Vec<(TabId, SessionId)>,
}

impl RegistryAudit {
    /// 하나라도 찾았는가 — 호출자가 loud 로그와 조용한 trace 를 가르는 데 쓴다.
    pub fn is_empty(&self) -> bool {
        self.orphan_sessions.is_empty()
            && self.orphan_sinks.is_empty()
            && self.dangling_tabs.is_empty()
    }
}

/// 모델의 pty_session 참조를 세션·sink 레지스트리와 대조한다. 결과는 입력 순서를 유지한다.
/// 호출자는 Dispatcher → 레지스트리 순서로 잠근 뒤 같은 시점의 스냅샷을 넘겨야 한다.
/// Dispatcher lock보다 먼저 읽으면 갓 생성된 세션을 dangling으로 오판해 정상 셸을 끊을 수 있다.
/// 마감 뒤 늦게 끝난 스폰은 모델에 실리지 않은 고아이므로 이 순서에서도 정리 대상이다 (ADR-0018).
pub fn audit_registries(
    model: &AppState,
    session_ids: &[SessionId],
    sink_ids: &[SessionId],
) -> RegistryAudit {
    let mut referenced: HashSet<SessionId> = HashSet::new();
    let mut dangling_tabs = Vec::new();
    let sessions: HashSet<SessionId> = session_ids.iter().copied().collect();
    let sinks: HashSet<SessionId> = sink_ids.iter().copied().collect();
    for ws in &model.workspaces {
        for pane in ws.panes.values() {
            for tab in &pane.tabs {
                let TabKind::Terminal {
                    pty_session: Some(session),
                    ..
                } = tab.kind
                else {
                    continue;
                };
                if !sessions.contains(&session) || !sinks.contains(&session) {
                    // 참조자로 세지 않는다 — 이 탭은 Exited 로 수리되어 세션을
                    // 놓을 것이므로, 반대쪽 레지스트리에 남은 짝은 아무도 닿지
                    // 못하는 고아다. 세었다면 한 번의 audit 이 수렴하지 못하고
                    // 그 짝 뒤의 셸이 살아남는다.
                    dangling_tabs.push((tab.id, session));
                    continue;
                }
                referenced.insert(session);
            }
        }
    }
    RegistryAudit {
        orphan_sessions: session_ids
            .iter()
            .copied()
            .filter(|id| !referenced.contains(id))
            .collect(),
        orphan_sinks: sink_ids
            .iter()
            .copied()
            .filter(|id| !referenced.contains(id))
            .collect(),
        dangling_tabs,
    }
}
