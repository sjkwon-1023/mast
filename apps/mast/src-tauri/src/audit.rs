//! 모델 ↔ 레지스트리 정합성 검사의 글루 (ADR-0018 D5).
//!
//! 판정은 코어의 순수 함수 [`audit_registries`] 가 한다 — 이 모듈이 맡는 것은
//! **잠금 순서**와 그 결과에 대한 두 가지 반응(탭 수리·고아 해제)뿐이다.
//!
//! # 순서
//!
//! Dispatcher lock 을 **먼저** 잡고 그 아래에서 두 레지스트리의 id 를 뜬다. 반대
//! 순서는 갓 만들어진 멀쩡한 탭을 dangling 으로 오판해 살아 있는 셸을 Exited 로
//! 끊는다 — 근거 전문은 [`audit_registries`] 의 rustdoc 에 있다. 잠금 방향이
//! dispatch 와 같아(Dispatcher → 레지스트리) 순환은 생기지 않는다.
//!
//! 고아 해제(`kill` 포함)는 lock 을 놓은 뒤다. 해제는 멱등이라 `on_exit` ④ 나
//! 마감 뒤 늦은 스폰의 자기 정리와 겹쳐도 무해하다.
//!
//! # 진행 중인 exit 은 고아가 아니다
//!
//! exit 은 모델 갱신(③)과 레지스트리 해제(④)를 lock 을 사이에 두고 나눈다
//! ([`crate::sink`]). 그 창의 세션은 "탭이 참조하지 않는데 레지스트리에 있다" —
//! 고아의 정의 그대로다. 그래서 검사는 lock 아래에서 `exits_in_flight` 의 **세션 id
//! 집합**을 스냅샷보다 먼저 읽고, 거기 있는 id 만 그 회차의 고아 후보에서 뺀다.
//! 순서가 뒤집히면 방금 ④ 를 끝낸 exit 이 표식을 거둔 뒤에 찍힌 낡은 스냅샷을 믿게
//! 된다. 함수적 피해는 없지만(어차피 죽는 세션이다) 진단이 정상 종료마다 "고아"를
//! 외치면 이 검사가 존재하는 이유가 사라진다.
//!
//! 빼는 것이 **그 id 들뿐**인 것은 판정을 최대한 살리기 위해서다: 회차 전체를 버리면
//! 셸 하나가 죽는 동안 생긴 진짜 고아가 그 exit 에 가려 보이지 않는다. 표식은 RAII
//! 가드([`crate::state::ExitInFlight`])가 넣고 뺀다 — 되감기로 빠져나간 exit 하나가
//! 표식을 남겨 이후의 모든 판정을 조용히 버리게 두지 않는다.
//!
//! 검사 결과에 **백엔드 재시작도 webview 리로드도 달지 않는다** (CLAUDE.md 비목표):
//! 반응은 이 두 가지와 로그 한 줄이 전부다. 주기 타이머도 없다 — 호출 지점은
//! exit, Close* 성공, 부팅 웨이브 끝, 진단 커맨드 네 곳이다.

use std::sync::PoisonError;

use tauri::AppHandle;
use mast_core::command::{audit_registries, RegistryAudit, SessionEvent};

use crate::diagnostics;
use crate::router::now_ms;
use crate::state::{publish_state, AppState};
use crate::{winlog, wintrace};

/// 검사 1회 + 무언가 찾았을 때의 `diag:` 한 줄. 호출 지점 넷 중 진단 커맨드를
/// 제외한 셋이 이 문을 쓴다.
pub fn run_audit(app: &AppHandle, state: &AppState, context: &str) -> RegistryAudit {
    let audit = audit_once(app, state, context);
    if !audit.is_empty() {
        // 어긋남이 보인 순간이 자원 그림을 남길 순간이다 (ADR-0018 진단).
        diagnostics::log_summary(state, &audit, context);
    }
    audit
}

/// 검사 본체 — 수리·해제까지 끝내고 결과를 돌려준다. `context` 는 호출 지점 이름이며
/// 로그에만 쓴다 (어느 경로가 어긋남을 만들었는지는 로그에서만 알 수 있다). 결과는
/// `state.last_audit` 에도 남는다 — 진단 커맨드가 "마지막으로 본 그림"을 그리는 자리다.
///
/// [`run_audit`] 과 달리 `diag:` 줄은 남기지 않는다. 검사 **뒤**의 수치를 어차피 스스로
/// 뜨는 호출자([`crate::diagnostics::get_diagnostics`])를 위한 문이다 — 그쪽이
/// `run_audit` 을 부르면 같은 스냅샷을 두 번 뜨게 되고, 그 수집은 시스템 전역 Toolhelp
/// 스냅샷을 도는 작업이라 사람이 부르는 유일한 경로가 값을 두 번 치른다.
pub fn audit_once(app: &AppHandle, state: &AppState, context: &str) -> RegistryAudit {
    let audit = {
        let mut dispatcher = state.dispatcher.lock().unwrap();
        // 표식 → 스냅샷 순서가 계약이다 (모듈 doc).
        let exiting = state
            .exits_in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        // 두 스냅샷은 이 lock 아래에서 뜬다 (모듈 doc). 각 `ids()` 는 자기 레지스트리
        // 내부 lock 을 복사 동안만 잡는다.
        let mut audit = audit_registries(
            dispatcher.state(),
            &state.sessions.ids(),
            &state.sinks.ids(),
        );
        if !exiting.is_empty() {
            let before = audit.orphan_sessions.len() + audit.orphan_sinks.len();
            audit.orphan_sessions.retain(|id| !exiting.contains(id));
            audit.orphan_sinks.retain(|id| !exiting.contains(id));
            let excluded = before - (audit.orphan_sessions.len() + audit.orphan_sinks.len());
            if excluded > 0 {
                wintrace!(
                    "audit ({context}): {excluded} orphan candidate(s) excluded — their exit is between its model update and its registry release"
                );
            }
        }
        // 탭이 참조하는 세션이 레지스트리에 없다 — 죽일 대상이 없으므로 탭만 Exited 로
        // 되돌린다. 그러면 `pty_session` 이 비어 배너의 Restart 로 되살릴 수 있다.
        // code 는 모른다(우리가 관측한 exit 이 아니다) — 그래서 None 이다.
        for (tab, session) in &audit.dangling_tabs {
            winlog!(
                "audit ({context}): tab {} references session {session} which no longer exists; marking it exited",
                tab.0
            );
            dispatcher.apply_event(SessionEvent::SessionExited {
                session: *session,
                code: None,
                ended_at_ms: now_ms(),
            });
        }
        if !audit.dangling_tabs.is_empty() {
            publish_state(app, &dispatcher);
        }
        audit
    };

    // 고아는 양쪽에서 지운다: 한쪽에만 남은 짝도 attach 가 성립하지 않아 아무도 닿지
    // 못하는 자원이고, 미지 id 의 제거는 양쪽 다 no-op 이다.
    for id in audit
        .orphan_sessions
        .iter()
        .chain(audit.orphan_sinks.iter())
        .copied()
    {
        state.sinks.remove(id);
        state.sessions.remove(id);
    }

    *state.last_audit.lock().unwrap() = audit.clone();

    if audit.is_empty() {
        wintrace!("audit ({context}): model and registries agree");
    } else {
        winlog!(
            "audit ({context}): released {} orphan session(s) {:?} and {} orphan sink(s) {:?}; repaired {} dangling tab(s)",
            audit.orphan_sessions.len(),
            audit.orphan_sessions,
            audit.orphan_sinks.len(),
            audit.orphan_sinks,
            audit.dangling_tabs.len()
        );
    }
    audit
}
