//! mast-remote: 폰 브라우저용 원격 표면(LAN)의 서버 로직.
//!
//! Tauri에 의존하지 않는 어댑터로, 실제 리스너 테스트도 Linux에서 실행한다. 표면이 둘이다:
//!
//! - **Local HTTP**(ADR-0016): `server`가 연결 수명과 요청 처리를 조립하고,
//!   `http`·`routes`는 파싱과 경로 판정, `token`·`ratelimit`는 인증과 요청 제한,
//!   `handlers`는 코어 호출과 응답을 맡는다.
//! - **Secure Remote WebTransport**: `wt`가 QUIC/HTTP3 어댑터·일회용 인증서·프레임을
//!   맡고, 상태·화면·입력의 판정은 `handlers`를 공유한다.
//!
//! 설정·토큰 경로·서버 기동·정적 자산·로그 연결은 `apps/mast/src-tauri`가 소유한다.
//!
//! 계약: `docs/adr/0016-remote-surface-over-lan.md` (HTTP), Secure Remote 는 이 계획의
//! 후속 ADR.
//!
//! 이 크레이트가 밖으로 내보내는 것은 두 서버의 기동과 토큰 로딩, Secure Remote
//! 페어링마다 새로 만드는 토큰(`generate_secure_token`), 그리고 Secure Remote 입력
//! 쓰기를 실행하는 호출자 소유 coordinator(`InputWriter`)뿐이다. HTTP 파싱·라우팅·
//! rate limit·핸들러는 비공개 모듈 안에 둔다.

mod handlers;
mod http;
mod ratelimit;
mod routes;
mod server;
mod token;
mod wt;

pub use server::{
    serve, AssetFn, LogFn, RemoteConfig, RemoteDeps, RemoteServer, StaticAsset, MOBILE_SIZE_LEASE,
};
pub use token::{generate_secure_token, load_or_create_token, TokenError};
pub use wt::{
    InputWriter, SecureRemote, SecureRemoteConfig, SecureRemoteDeps, SecureRemoteState,
    SecureRemoteTimeouts, StartError,
};
