//! mast-remote: 폰 브라우저용 원격 표면(LAN, 폴링)의 HTTP 서버 로직.
//!
//! Tauri 에 의존하지 않는 순수 Rust 크레이트다. 서버를 Tauri 글루
//! (`apps/mast/src-tauri`) 안에 두지 않는 이유는 테스트다 — 글루는 Linux 개발기에서
//! 컴파일되지 않고(webkit2gtk 부재, Windows 타깃 check 만 게이트) 거기 놓인 코드는
//! `cargo test` 로 한 줄도 돌릴 수 없다. 인증·rate limit·경로 판정처럼 틀리면 조용히
//! 위험해지는 로직이라 Linux 게이트에서 실제로 실행되는 자리에 둔다. 글루가 맡는 것은
//! 설정 읽기·토큰 파일 경로·서버 spawn·정적 자산 콜백·로그 싱크뿐이다.
//!
//! 계약: `docs/adr/0016-remote-surface-over-lan.md`.
//!
//! 이 크레이트가 밖으로 내보내는 것은 서버 기동([`serve`])과 토큰 로딩뿐이다. HTTP
//! 파싱·라우팅·rate limit·핸들러는 서버만의 내부 부품이라 `pub(crate)` 로 닫아 둔다.

mod handlers;
mod http;
mod ratelimit;
mod routes;
mod server;
mod token;

pub use server::{serve, AssetFn, LogFn, RemoteConfig, RemoteDeps, RemoteServer, StaticAsset};
pub use token::{load_or_create_token, TokenError};
