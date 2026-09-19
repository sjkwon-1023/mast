//! Secure Remote 표면 — WebTransport/HTTP3 로 나가는 두 번째 전송이다.
//!
//! Local HTTP 와 **같은 판정**을 쓴다: 상태·화면·입력의 의미는 [`crate::handlers`] 의
//! 공유 계층 하나뿐이고, 이 모듈은 그것을 프레임으로 옮긴다. 다른 것은 전송과 수명이다.
//!
//! - [`cert`] — 메모리에서만 사는 ECDSA P-256 자체 서명 인증서와 DER SHA-256.
//! - [`protocol`] — `u32` 길이 + JSON 프레임, 상한과 파싱 규율.
//! - [`writer`] — 무기한 blocking PTY 쓰기를 네트워크 수명에서 떼어 놓는, 호출자 소유
//!   coordinator([`InputWriter`])와 서버별 lease.
//! - [`conn`] — 연결 하나: 첫 auth 프레임, 요청 루프, 단일 세션.
//! - [`server`] — 엔드포인트·인증서·대기 창의 수명과 공개 API.

mod cert;
mod conn;
mod protocol;
mod server;
mod writer;

pub use server::{
    SecureRemote, SecureRemoteConfig, SecureRemoteDeps, SecureRemoteState, SecureRemoteTimeouts,
    StartError,
};
pub use writer::InputWriter;
