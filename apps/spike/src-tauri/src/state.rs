//! 세션 레지스트리 상태.
//!
//! Tauri managed state 로 올라가는 `AppState` 가 mast-core 의 `SessionManager` 를
//! 보유한다. id 발급과 id→`PtySession` 매핑은 전부 코어 레지스트리 책임이고,
//! 프론트엔드 계약(이벤트·커맨드의 `id`)도 코어가 발급한 `SessionId` 를 그대로
//! 쓴다 — spike 자체 id 공간은 더 이상 없다.
//!
//! # 잠금 규율
//!
//! `SessionManager` 는 자체 std Mutex 로 내부 동기화하므로 바깥 Mutex 를 두지
//! 않는다. 매니저의 내부 lock 아래에서는 id 발급과 `Arc<PtySession>` 핸들
//! 복사만 일어나고, 블로킹 가능성이 있는 세션 호출(PTY write 등)은 반드시
//! 핸들을 얻은 뒤 lock 밖에서 수행한다 (코어 `SessionManager` 구현이 이 규율을
//! 스스로 지킨다). 레지스트리 lock 을 쥔 채 블로킹하면 ack_output 까지 막혀
//! flow control 이 영구 교착된다 (paused → 자식 stdout 블록 → write 블록 →
//! ack 불가 체인).

use std::sync::Arc;

use mast_core::session::SessionManager;

/// Tauri managed state. `Arc` 는 동기화용이 아니라 — 동기화는 `SessionManager`
/// 내부 Mutex 담당 — `spawn_blocking` 의 `'static` 클로저에 매니저 핸들을
/// 넘기기 위한 소유 핸들이다.
#[derive(Default)]
pub struct AppState {
    pub manager: Arc<SessionManager>,
}
