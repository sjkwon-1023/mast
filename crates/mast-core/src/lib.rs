//! mast-core: mast 스파이크의 순수 Rust 코어 크레이트.
//!
//! Tauri 등 앱 프레임워크에 의존하지 않고 OSC 시퀀스 감지, replay buffer,
//! flow control 상태 머신, PTY 세션 관리를 제공한다. 모듈별 계약은
//! `docs/plans/spike-plan.md` 4장을 참조.

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
