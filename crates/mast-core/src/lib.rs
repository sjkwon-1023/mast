//! mast의 상태 모델·명령 처리·PTY 실행 엔진. Tauri에 의존하지 않는다.
//!
//! 수정 위치를 찾기 위한 모듈 지도:
//! - 상태와 명령: [`model`]은 워크스페이스·패널·탭 상태, [`command`]는
//!   `Dispatcher`와 호스트·이벤트 싱크 계약을 소유한다. 명령 실행·세션 이벤트·질의·
//!   진단은 `command/`의 비공개 모듈로 나뉜다.
//! - PTY 엔진: [`session`]은 세션과 입출력을 관리한다. 내부 `flow`는 역압,
//!   `replay`는 재연결 버퍼, [`osc`]는 출력 스트림의 제어 시퀀스 해석을 맡는다.
//! - 저장과 환경 접근: [`persist`]는 상태 저장·복원, [`record`]는 종료된 탭 기록,
//!   [`capture`]는 외부 명령의 출력 캡처, [`git`]은 Git 조회, [`wslpath`]는 WSL 경로 변환을 맡는다.
//! - 정책과 프로토콜: [`notify`]는 알림 배치, [`send`]는 에이전트 간 전송 규약,
//!   [`reset`]은 UI 리셋 판정, [`deadline`]은 동기 호출의 시간 상한, [`firewall`]과 [`update`]는
//!   방화벽·업데이트 판정 로직을 제공한다.
//!
//! 이 크레이트에는 파일·프로세스·PTY I/O도 있다. 순수 도메인 계층이 아니라
//! 앱 프레임워크로부터 독립된 실행 코어다. HTTP 입력은 `mast-remote`,
//! 데스크톱·OS 어댑터와 조립은 `apps/mast/src-tauri`가 맡는다.

pub mod capture;
pub mod command;
pub mod deadline;
pub mod firewall;
pub(crate) mod flow;
pub mod git;
pub mod model;
pub mod notify;
pub mod osc;
pub mod persist;
pub mod record;
pub(crate) mod replay;
pub mod reset;
pub mod send;
pub mod session;
pub mod update;
pub mod wslpath;
