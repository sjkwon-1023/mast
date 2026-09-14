//! mast-remote: 폰 브라우저용 원격 표면(LAN, 폴링)의 HTTP 서버 로직.
//!
//! Tauri에 의존하지 않는 HTTP 입력 어댑터로, 실제 리스너 테스트도 Linux에서 실행한다.
//! `server`는 연결 수명과 요청 처리를 조립하고, `http`·`routes`는 파싱과 경로 판정,
//! `token`·`ratelimit`는 인증과 요청 제한, `handlers`는 코어 호출과 응답을 맡는다.
//! 설정·토큰 경로·서버 기동·정적 자산·로그 연결은 `apps/mast/src-tauri`가 소유한다.
//!
//! 계약: `docs/adr/0016-remote-surface-over-lan.md`.
//!
//! 이 크레이트가 밖으로 내보내는 것은 서버 기동([`serve`])과 토큰 로딩뿐이다. HTTP
//! 파싱·라우팅·rate limit·핸들러는 비공개 모듈 안에 둔다.

mod handlers;
mod http;
mod ratelimit;
mod routes;
mod server;
mod token;

pub use server::{serve, AssetFn, LogFn, RemoteConfig, RemoteDeps, RemoteServer, StaticAsset};
pub use token::{load_or_create_token, TokenError};
