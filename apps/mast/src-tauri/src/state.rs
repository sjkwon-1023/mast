//! Tauri managed state — 잠금 배치의 핵심 (10단계 계획 0-3).
//!
//! # 잠금 규율
//!
//! - `Mutex<Dispatcher>` 는 **구조 변이 전용**이다: `dispatch`(커맨드 실행)와
//!   `apply_event`(세션 exit 반영)만 이 lock 을 잡는다. dispatch 안의 셸 스폰
//!   (수십 ms 블로킹)까지 lock 아래에서 일어나지만, 핫패스와 무간섭이므로
//!   수용한다 (계획 0-3).
//! - `SessionManager` 와 sink 레지스트리는 **Dispatcher Mutex 밖** 자체 동기화다.
//!   핫패스(write/ack/resize/attach/출력 전달)는 Dispatcher lock 을 절대 타지
//!   않는다 — 구조 변이가 느려도 터미널 IO 는 멈추지 않는다.
//! - 레지스트리 내부 lock 아래에서는 핸들 복사·삽입·제거만 일어난다. 블로킹
//!   가능성이 있는 세션 호출(write·resize·spawn)은 핸들을 얻은 뒤 lock 밖,
//!   그리고 `spawn_blocking` 스레드에서 수행한다 (스파이크와 동일 규율 —
//!   메인 스레드가 write 에 잡히면 ack_output 도 못 돌아 flow 영구 교착).
//! - 기록 파일([`RecordStore`], ADR-0018)도 같은 규율 아래 있다: 디스크 I/O 는
//!   Dispatcher lock 밖에서만 한다. exit 경로가 기록을 **모델 갱신보다 먼저**
//!   쓰는 것도 여기서 나온다 ([`crate::sink`] 의 `on_exit`) — 프론트가
//!   `state-changed` 를 보고 기록을 읽으므로 파일이 그때 이미 있어야 한다.

use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager};
use mast_core::command::{Dispatcher, RegistryAudit};
use mast_core::persist::Saver;
use mast_core::record::RecordStore;
use mast_core::session::{SessionId, SessionManager};

use crate::reset_supervisor::ResetSupervisor;
use crate::router::OscRouter;
use crate::sink::TerminalSink;
use crate::winlog;

/// 세션별 출력 sink 레지스트리 — `attach_terminal` 이 채널을 장착할 대상을
/// 찾는 곳. `SessionManager` 와 마찬가지로 Dispatcher lock 밖 자체 동기화.
#[derive(Default)]
pub struct SinkRegistry {
    sinks: Mutex<HashMap<SessionId, Arc<TerminalSink>>>,
}

impl SinkRegistry {
    pub fn insert(&self, id: SessionId, sink: Arc<TerminalSink>) {
        self.sinks.lock().unwrap().insert(id, sink);
    }

    pub fn get(&self, id: SessionId) -> Option<Arc<TerminalSink>> {
        self.sinks.lock().unwrap().get(&id).cloned()
    }

    /// 제거 — 미지 id 는 무해한 no-op (kill 멱등 계약과 짝).
    pub fn remove(&self, id: SessionId) {
        self.sinks.lock().unwrap().remove(&id);
    }

    /// 등록된 sink id 목록 — 오름차순, 내부 lock 은 복사 동안만. 코어의
    /// [`SessionManager::ids`] 와 짝이며, 정합성 검사
    /// ([`mast_core::command::audit_registries`])가 **Dispatcher lock 아래에서**
    /// 두 레지스트리 스냅샷을 같이 뜨는 데 쓴다 — 그 순서의 근거는 그쪽 rustdoc.
    pub fn ids(&self) -> Vec<SessionId> {
        let mut ids: Vec<SessionId> = self.sinks.lock().unwrap().keys().copied().collect();
        ids.sort_unstable();
        ids
    }
}

/// Tauri managed state. `Arc` 는 `spawn_blocking` 의 `'static` 클로저와 sink
/// factory 에 핸들을 넘기기 위한 소유 핸들이다 — 동기화는 각 필드 내부 Mutex 담당.
pub struct AppState {
    /// 구조 변이 전용 lock (모듈 doc 참조).
    pub dispatcher: Arc<Mutex<Dispatcher>>,
    /// PTY 세션 레지스트리 — 핫패스 전용, Dispatcher lock 밖.
    pub sessions: Arc<SessionManager>,
    /// 세션별 출력 sink — 핫패스 전용, Dispatcher lock 밖.
    pub sinks: Arc<SinkRegistry>,
    /// debounce 저장기 (계획 15단계 B) — [`publish_state`] 가 emit 후 최신 상태를
    /// schedule 한다. `Arc` 는 setup(생성 시점)과 관리 상태가 공유하기 위함.
    pub saver: Arc<Saver>,
    /// 자동 UI 리셋 supervisor (계획 16단계 C-2) — 커맨드의 활동 신호와 창
    /// 이벤트(Focused)가 여기로 모인다. 내부가 Arc 공유라 별도 Arc 불필요.
    pub reset: ResetSupervisor,
    /// OSC 배치 라우터 (계획 18단계 glue) — sink 와 `Arc` 로 공유하며, 종료 시
    /// `RunEvent::Exit` 가 여기서 `flush_now` 를 부른다.
    pub router: Arc<OscRouter>,
    /// 끝난 탭의 마지막 화면 기록 (ADR-0018) — 디렉터리 경로만 드는 값이라 자체
    /// lock 이 없다. `TauriHost` 도 같은 `Arc` 를 들어 탭 닫기 경로에서 지운다.
    pub records: Arc<RecordStore>,
    /// 마지막 정합성 검사 결과 — [`crate::audit::run_audit`] 이 쓰고 진단 커맨드가
    /// 읽는다. 검사 자체가 짧아 결과를 들고 있는 것은 표면을 위한 것이지 캐시가 아니다.
    pub last_audit: Mutex<RegistryAudit>,
    /// ③(모델 갱신)과 ④(레지스트리 해제) 사이에 있는 exit 의 수 ([`crate::sink`]).
    /// 그 창 안의 세션은 어떤 탭도 참조하지 않으면서 두 레지스트리에 아직 살아 있어
    /// 정합성 검사의 고아 정의에 그대로 걸린다 — 셸 열 개가 한꺼번에 죽는
    /// `wsl --shutdown` 이면 매번 걸린다. 검사는 Dispatcher lock 아래에서 이 값을
    /// 먼저 읽고, 0 이 아니면 그 회차의 고아 판정을 버린다 ([`crate::audit`]).
    pub exits_in_flight: AtomicUsize,
}

/// 현재 스냅샷을 `state-changed` 이벤트로 emit 하고 저장을 예약한다 (emit +
/// `saver.schedule` — 계획 B-2 저장 훅). 호출자가 Dispatcher lock 을 쥔 채
/// 부른다 — lock 안에서 직렬화까지 마쳐 revision 과 상태가 일관된 스냅샷만
/// 나간다. emit 실패는 삼키지 않고 stderr 에 남긴다 (프론트는 get_state
/// 재동기화 경로가 있어 치명적이지 않다).
///
/// 저장 훅이 여기 한 곳인 근거: 상태 변이의 두 경로(dispatch 성공·sink on_exit)
/// 모두 이 함수를 유일하게 경유한다 (계획 B-2 검증). state clone 은 lock 안에서
/// 일어나지만 코어 AppState 는 구조 메타(워크스페이스·pane·탭)뿐인 작은 값이라
/// 수용한다 — 실제 디스크 IO 는 Saver worker 스레드가 lock 밖에서 한다.
pub fn publish_state(app: &AppHandle, dispatcher: &Dispatcher) {
    match serde_json::to_value(dispatcher.snapshot()) {
        Ok(payload) => {
            if let Err(err) = app.emit("state-changed", payload) {
                winlog!("state-changed emit failed: {err}");
            }
        }
        Err(err) => winlog!("state snapshot serialize failed: {err}"),
    }
    match app.try_state::<AppState>() {
        Some(managed) => managed.saver.schedule(dispatcher.state().clone()),
        // manage-first 부팅 계약상 이 함수는 manage 후에만 불린다 — 아니라면
        // 저장이 누락되고 있는 프로그램 결함이므로 숨기지 않는다.
        None => winlog!("publish_state: managed state unavailable; save skipped"),
    }
}
