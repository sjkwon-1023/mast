//! 하네스 감독 — 종료 코드 해석, 백오프 재시작, 글루 status·board 캐시.
//!
//! # 범위
//!
//! 한 번 실행기를 되풀이해 띄우고, 종료 코드에 따라 재시작 여부를 정한다.
//! 글루가 정하는 status(`restarting`/`failed`/`unsupported`)와 하네스가 보낸 status 를
//! 한 곳에 병합하고, 마지막 board 를 캐시해 하네스가 죽어도 유지한다.
//!
//! # 스레드와 잠금
//!
//! - 감독 스레드 하나가 spawn → Exited 대기 → (백오프) → spawn 을 반복한다.
//! - `on_event` 콜백(reader·waiter 스레드)은 [`ManagerShared`] 캐시만 갱신하고
//!   Exited 만 감독 스레드로 넘긴다 — 파이프 I/O 를 감독 스레드가 기다리지 않는다.
//! - 재시작 지연은 `recv_timeout` 으로 기다려 중지 명령이 즉시 끼어들 수 있다.
//! - 백오프 계산과 종료 코드 판정은 순수 함수([`backoff_delay`]·[`next_attempt`]·
//!   [`exit_decision`])로 분리해 테스트가 시간·프로세스 없이 잠근다.

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use mast_core::command::Dispatcher;
use mast_core::manager::{
    AppToHarness, HarnessAction, HarnessState, HarnessToApp, NotifyReason,
};
use serde::Serialize;

use super::harness::{self, HarnessEvent, HarnessProcess, Wake};
use crate::commands::ResolvedManagerSettings;
use crate::winlog;

/// 정상 가동으로 보는 가동 시간 — 이 이상이면 다음 재시작 지연을 1초로 되돌린다.
pub(crate) const BACKOFF_RESET_AFTER: Duration = Duration::from_secs(300);

/// 재시작 지연 상한.
const BACKOFF_MAX: Duration = Duration::from_secs(60);

/// 하네스 종료 코드.
pub(crate) const EXIT_UNSUPPORTED: i32 = 3;
pub(crate) const EXIT_NOT_PROVISIONED: i32 = 4;
pub(crate) const EXIT_ALREADY_RUNNING: i32 = 5;

const FAILED_ALREADY_RUNNING: &str = "another manager harness is already running";
const RESTARTING_NOT_PROVISIONED: &str = "manager scripts are not installed yet; waiting for setup";
/// macOS 네이티브 프로비저닝은 Python 3.11+ 를 요구하고 재시작 때 자동으로 다시 돈다.
#[cfg(target_os = "macos")]
const SPAWN_SETUP_HINT: &str = "Python 3.11+ for mast is not set up; restart mast to run setup";
/// WSL 프로비저닝은 Python 3.8+ 를 요구한다.
#[cfg(not(target_os = "macos"))]
const SPAWN_SETUP_HINT: &str = "Python 3.8+ for mast is not set up; run mast setup";

/// `manager_action` 이 하네스 부재 시 돌려주는 문장.
pub(crate) const HARNESS_NOT_RUNNING: &str = "manager harness is not running";

/// 글루가 정하는 status 상태. 하네스의 [`HarnessState`] 와 이름이 겹치는
/// 다섯은 그대로 반영되고, `disabled`·`restarting` 은 글루만 만든다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GlueState {
    Disabled,
    Starting,
    Ok,
    Busy,
    Failed,
    Unsupported,
    Restarting,
}

impl From<HarnessState> for GlueState {
    fn from(state: HarnessState) -> Self {
        match state {
            HarnessState::Starting => Self::Starting,
            HarnessState::Ok => Self::Ok,
            HarnessState::Busy => Self::Busy,
            HarnessState::Failed => Self::Failed,
            HarnessState::Unsupported => Self::Unsupported,
        }
    }
}

/// `get_manager_board`/`manager-board` 가 싣는 글루 status.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlueStatus {
    pub(crate) state: GlueState,
    pub(crate) message: Option<String>,
    pub(crate) last_collected_at: Option<String>,
    pub(crate) log_path: Option<String>,
}

impl GlueStatus {
    fn new(state: GlueState) -> Self {
        Self {
            state,
            message: None,
            last_collected_at: None,
            log_path: None,
        }
    }
}

/// `get_manager_board`/`manager-board` 의 payload — `board` 는 하네스가 보낸 board
/// 메시지(`{"type":"board","generatedAt":…,"entries":[…]}`) 그대로다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagerBoardPayload {
    pub(crate) status: GlueStatus,
    pub(crate) board: Option<serde_json::Value>,
}

impl ManagerBoardPayload {
    /// 기능이 꺼진 앱 — 관리 상태 자체가 없다.
    pub(crate) fn disabled() -> Self {
        Self {
            status: GlueStatus::new(GlueState::Disabled),
            board: None,
        }
    }
}

/// attempt 번째 재시작 지연: 1, 2, 4, 8, 16, 32, 60, 60, …초.
pub(crate) fn backoff_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(BACKOFF_MAX.as_secs()))
}

/// 방금 끝난 실행 뒤의 attempt 값 — [`BACKOFF_RESET_AFTER`] 이상 가동했으면 0이다.
pub(crate) fn next_attempt(attempt: u32, uptime: Duration) -> u32 {
    if uptime >= BACKOFF_RESET_AFTER {
        0
    } else {
        attempt.saturating_add(1)
    }
}

/// status.message 를 어떻게 할지 — `Keep` 은 하네스가 보낸 마지막 문장 유지다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MessageUpdate {
    Keep,
    Set(String),
}

/// 종료 뒤의 다음 동작 — 순수 판정.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExitDecision {
    /// 지연 뒤 재시작. `message` 가 Some 이면 restarting status 에 함께 싣는다(exit 4 안내).
    Restart { message: Option<String> },
    /// 재시작하지 않는다.
    Stop {
        state: GlueState,
        message: MessageUpdate,
    },
}

pub(crate) fn exit_decision(code: Option<i32>) -> ExitDecision {
    match code {
        // 3 = 미지원(하네스가 사유를 이미 보냈다) — 그 문장을 유지하고 끝낸다.
        Some(EXIT_UNSUPPORTED) => ExitDecision::Stop {
            state: GlueState::Unsupported,
            message: MessageUpdate::Keep,
        },
        // 5 = 다른 인스턴스가 이미 실행 중 — 하네스는 아무 status 도 보내지 않는다.
        Some(EXIT_ALREADY_RUNNING) => ExitDecision::Stop {
            state: GlueState::Failed,
            message: MessageUpdate::Set(FAILED_ALREADY_RUNNING.to_owned()),
        },
        // 4 = 미프로비저닝 — 재시작은 하되 이유를 보여 준다.
        Some(EXIT_NOT_PROVISIONED) => ExitDecision::Restart {
            message: Some(RESTARTING_NOT_PROVISIONED.to_owned()),
        },
        _ => ExitDecision::Restart { message: None },
    }
}

/// spawn 전 오류 — 미지원으로 끝내고 재시작하지 않는다.
pub(crate) fn spawn_failure_status(error: &str) -> GlueStatus {
    GlueStatus {
        state: GlueState::Unsupported,
        message: Some(format!("{SPAWN_SETUP_HINT} ({error})")),
        last_collected_at: None,
        log_path: None,
    }
}

/// board 메시지 → `manager-board`·`get_manager_board` 가 싣는 JSON. 하네스가 보낸
/// `type`·`generatedAt`·`entries` 를 그대로 옮긴다 (`HarnessToApp` 은 역직렬화 전용이라
/// 직접 조립한다).
fn board_value(generated_at: &str, entries: &[serde_json::Value]) -> serde_json::Value {
    serde_json::json!({
        "type": "board",
        "generatedAt": generated_at,
        "entries": entries,
    })
}

/// notify 메시지 → `manager-notify` payload. notify 가 아니면 None.
pub(crate) fn notification_payload(message: &HarnessToApp) -> Option<serde_json::Value> {
    match message {
        HarnessToApp::Notify {
            workspace_id,
            reason,
            title,
            body,
        } => Some(serde_json::json!({
            "type": "notify",
            "workspaceId": workspace_id,
            "reason": match reason {
                NotifyReason::Question => "question",
                NotifyReason::Done => "done",
                NotifyReason::Failed => "failed",
            },
            "title": title,
            "body": body,
        })),
        _ => None,
    }
}

/// `manager_action` 키 형식 — `k` + 소문자 hex 20자리.
pub(crate) fn valid_manager_key(key: &str) -> bool {
    let Some(hex) = key.strip_prefix('k') else {
        return false;
    };
    hex.len() == 20
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 프론트가 보낸 action 문자열 → 코어 action.
pub(crate) fn parse_action(action: &str) -> Result<HarnessAction, String> {
    match action {
        "resume" => Ok(HarnessAction::Resume),
        "fresh" => Ok(HarnessAction::Fresh),
        other => Err(format!("unknown manager action: {other:?}")),
    }
}

/// 글루·감독 스레드·Tauri 커맨드가 공유하는 관리 상태.
///
/// status·board 는 여기 한 곳에만 있고, 하네스가 죽어도 board 를 지우지 않는다.
/// `wake`·`process` 는 실행 중 하네스 수명에 맞춰 감독 스레드가 등록·해제한다.
pub(crate) struct ManagerShared {
    settings: ResolvedManagerSettings,
    status: Mutex<GlueStatus>,
    board: Mutex<Option<serde_json::Value>>,
    wake: Mutex<Option<Arc<Wake>>>,
    process: Mutex<Option<Arc<HarnessProcess>>>,
    supervisor_started: AtomicBool,
    supervisor: Mutex<Option<Arc<Supervisor>>>,
}

impl ManagerShared {
    pub(crate) fn new(settings: ResolvedManagerSettings) -> Self {
        Self {
            settings,
            status: Mutex::new(GlueStatus::new(GlueState::Starting)),
            board: Mutex::new(None),
            wake: Mutex::new(None),
            process: Mutex::new(None),
            supervisor_started: AtomicBool::new(false),
            supervisor: Mutex::new(None),
        }
    }

    pub(crate) fn settings(&self) -> &ResolvedManagerSettings {
        &self.settings
    }

    pub(crate) fn status(&self) -> GlueStatus {
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn board(&self) -> Option<serde_json::Value> {
        self.board
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn payload(&self) -> ManagerBoardPayload {
        ManagerBoardPayload {
            status: self.status(),
            board: self.board(),
        }
    }

    /// 하네스가 떠 있으면 writer 를 깨운다. 없으면 no-op — `publish_state` 가
    /// Dispatcher lock 안에서 부른다.
    pub(crate) fn wake_writer(&self) {
        let wake = self
            .wake
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(wake) = wake {
            wake.signal();
        }
    }

    pub(crate) fn set_wake(&self, wake: Option<Arc<Wake>>) {
        *self.wake.lock().unwrap_or_else(PoisonError::into_inner) = wake;
    }

    /// 하네스 status·board 를 캐시에 반영한다. 바뀌었으면 true.
    /// 모르는 종류·Exited 는 감독 스레드 몫이라 여기서는 false 다.
    pub(crate) fn apply_event(&self, event: &HarnessEvent) -> bool {
        match event {
            HarnessEvent::Message(HarnessToApp::Status {
                state,
                message,
                last_collected_at,
                log_path,
                ..
            }) => self.replace_status(GlueStatus {
                state: GlueState::from(*state),
                message: message.clone(),
                last_collected_at: last_collected_at.clone(),
                log_path: log_path.clone(),
            }),
            HarnessEvent::Message(HarnessToApp::Board {
                generated_at,
                entries,
            }) => self.replace_board(Some(board_value(generated_at, entries))),
            _ => false,
        }
    }

    /// 글루 판정 status. `lastCollectedAt`·`logPath` 는 유지한다.
    pub(crate) fn set_glue_status(&self, state: GlueState, message: MessageUpdate) -> bool {
        let mut status = self.status.lock().unwrap_or_else(PoisonError::into_inner);
        let next_message = match message {
            MessageUpdate::Keep => status.message.clone(),
            MessageUpdate::Set(message) => Some(message),
        };
        let next = GlueStatus {
            state,
            message: next_message,
            ..status.clone()
        };
        if *status == next {
            return false;
        }
        *status = next;
        true
    }

    /// failed + 이유 — 생성 실패 경로가 쓴다.
    pub(crate) fn fail(&self, reason: String) -> bool {
        self.set_glue_status(GlueState::Failed, MessageUpdate::Set(reason))
    }

    /// restarting — 이전 실행의 board·lastCollectedAt·logPath 는 유지한다.
    pub(crate) fn set_restarting(&self, message: Option<String>) -> bool {
        let mut status = self.status.lock().unwrap_or_else(PoisonError::into_inner);
        let next = GlueStatus {
            state: GlueState::Restarting,
            message,
            ..status.clone()
        };
        if *status == next {
            return false;
        }
        *status = next;
        true
    }

    fn replace_status(&self, next: GlueStatus) -> bool {
        let mut status = self.status.lock().unwrap_or_else(PoisonError::into_inner);
        if *status == next {
            return false;
        }
        *status = next;
        true
    }

    /// board 는 종료 뒤에도 지우지 않는다 — 프론트가 stale 로 표시한다.
    fn replace_board(&self, next: Option<serde_json::Value>) -> bool {
        let mut board = self.board.lock().unwrap_or_else(PoisonError::into_inner);
        if *board == next {
            return false;
        }
        *board = next;
        true
    }

    fn set_process(&self, process: Option<Arc<HarnessProcess>>) {
        *self.process.lock().unwrap_or_else(PoisonError::into_inner) = process;
    }

    fn take_process(&self) -> Option<Arc<HarnessProcess>> {
        self.process
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }

    /// 테스트 전용 — 실행 중 하네스 핸들 (재시작 뒤 이전 writer 종료 확인).
    #[cfg(test)]
    pub(crate) fn process(&self) -> Option<Arc<HarnessProcess>> {
        self.process
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// `manager_action` — 실행 중 하네스에 action 을 넣는다.
    pub(crate) fn send_action(&self, action: HarnessAction, key: String) -> Result<(), String> {
        let process = self
            .process
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        match process {
            Some(process) => {
                process.send_action(action, key);
                Ok(())
            }
            None => Err(HARNESS_NOT_RUNNING.to_owned()),
        }
    }

    /// 감독을 한 번만 시작하게 하는 CAS — 재검사 재진입이 중복 시작하지 않게 한다.
    pub(crate) fn begin_supervisor(&self) -> bool {
        !self.supervisor_started.swap(true, Ordering::SeqCst)
    }

    pub(crate) fn attach_supervisor(&self, supervisor: Arc<Supervisor>) {
        *self
            .supervisor
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(supervisor);
    }

    /// 앱 종료 — 감독을 멈추고 실행 중 하네스를 중지 API 로 끝낸다.
    pub(crate) fn stop_supervisor(&self) {
        let supervisor = self
            .supervisor
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(supervisor) = supervisor {
            supervisor.stop();
        }
    }
}

/// 재시작 지연 정책 — 테스트가 짧은 지연을 주입한다.
#[derive(Clone)]
pub(crate) struct Backoff {
    reset_after: Duration,
    delay: Arc<dyn Fn(u32) -> Duration + Send + Sync>,
}

impl Backoff {
    pub(crate) fn standard() -> Self {
        Self {
            reset_after: BACKOFF_RESET_AFTER,
            delay: Arc::new(backoff_delay),
        }
    }

    #[cfg(test)]
    pub(crate) fn fast() -> Self {
        Self {
            reset_after: BACKOFF_RESET_AFTER,
            delay: Arc::new(|_| Duration::from_millis(10)),
        }
    }

    /// 방금 끝난 실행의 가동 시간으로 다음 지연을 정하고 attempt 를 갱신한다.
    /// 긴 정상 가동(≥ [`BACKOFF_RESET_AFTER`])이면 1초로 되돌린다.
    fn after_run(&self, attempt: &mut u32, uptime: Duration) -> Duration {
        let due = if uptime >= self.reset_after { 0 } else { *attempt };
        let delay = (self.delay)(due);
        *attempt = next_attempt(due, uptime);
        delay
    }
}

/// 감독 스레드 핸들. 소유자는 [`ManagerShared`] 하나다.
pub(crate) struct Supervisor {
    shared: Arc<ManagerShared>,
    commands: mpsc::Sender<SupervisorMessage>,
    stopping: AtomicBool,
    joined: Mutex<Option<JoinHandle<()>>>,
}

enum SupervisorMessage {
    Event(HarnessEvent),
    Stop,
}

/// 감독 시작 인자.
pub(crate) struct SupervisorOptions {
    pub(crate) hello: AppToHarness,
    pub(crate) dispatcher: Arc<Mutex<Dispatcher>>,
    /// 재시작마다 실행 명령을 새로 만든다 — macOS 는 여기서 spawn 전 오류가 날 수 있다.
    pub(crate) build_command: Arc<dyn Fn() -> Result<Command, String> + Send + Sync>,
    pub(crate) backoff: Backoff,
}

/// 감독 스레드를 띄운다. `on_update` 는 status·board 가 바뀔 때마다, `on_notify` 는
/// 하네스 notify 마다 불린다(둘 다 파이프 스레드에서 온다).
pub(crate) fn start(
    shared: Arc<ManagerShared>,
    options: SupervisorOptions,
    on_update: Arc<dyn Fn() + Send + Sync>,
    on_notify: Arc<dyn Fn(HarnessToApp) + Send + Sync>,
) -> Arc<Supervisor> {
    let (commands, receiver) = mpsc::channel();
    let supervisor = Arc::new(Supervisor {
        shared: Arc::clone(&shared),
        commands,
        stopping: AtomicBool::new(false),
        joined: Mutex::new(None),
    });
    let worker = Arc::clone(&supervisor);
    let worker_update = Arc::clone(&on_update);
    let spawned = std::thread::Builder::new()
        .name("mast-manager-supervisor".to_owned())
        .spawn(move || worker.run(options, receiver, worker_update, on_notify));
    match spawned {
        Ok(join) => {
            *supervisor
                .joined
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(join);
        }
        // 스레드를 못 띄운 것은 조용히 넘기지 않는다 — failed 로 표시하고 끝낸다.
        Err(err) => {
            if shared.fail(format!("cannot start the manager supervisor: {err}")) {
                on_update();
            }
        }
    }
    supervisor
}

impl Supervisor {
    /// 감독을 멈추고 실행 중 하네스를 정지 API 로 끝낸다 (stdin EOF → 2초 → kill).
    /// 앱 종료 경로에서 한 번만 불리며, 여러 번 불러도 안전하다.
    pub(crate) fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _ = self.commands.send(SupervisorMessage::Stop);
        if let Some(process) = self.shared.take_process() {
            process.stop();
        }
    }

    fn run(
        &self,
        options: SupervisorOptions,
        receiver: mpsc::Receiver<SupervisorMessage>,
        on_update: Arc<dyn Fn() + Send + Sync>,
        on_notify: Arc<dyn Fn(HarnessToApp) + Send + Sync>,
    ) {
        let mut attempt = 0u32;
        loop {
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            let command = match (options.build_command)() {
                Ok(command) => command,
                Err(err) => {
                    self.stop_unsupported(&err, &on_update);
                    return;
                }
            };
            let wake = Arc::new(Wake::default());
            self.shared.set_wake(Some(Arc::clone(&wake)));
            let process = match harness::spawn_harness(
                command,
                options.hello.clone(),
                Arc::clone(&options.dispatcher),
                Arc::clone(&wake),
                self.event_callback(&on_update, &on_notify),
            ) {
                Ok(process) => Arc::new(process),
                Err(err) => {
                    self.shared.set_wake(None);
                    self.stop_unsupported(&format!("cannot start the harness: {err}"), &on_update);
                    return;
                }
            };
            self.shared.set_process(Some(Arc::clone(&process)));
            if self.stopping.load(Ordering::SeqCst) {
                process.stop();
                return;
            }
            let started = Instant::now();
            let code = loop {
                match receiver.recv() {
                    Ok(SupervisorMessage::Event(HarnessEvent::Exited { code })) => break code,
                    Ok(SupervisorMessage::Event(_)) => continue,
                    Ok(SupervisorMessage::Stop) | Err(_) => {
                        process.stop();
                        return;
                    }
                }
            };
            self.shared.set_process(None);
            self.shared.set_wake(None);
            // 하네스가 스스로 끝난 경로 — Wake 를 닫아야 writer 가 끝나 stdin fd 와
            // Dispatcher 참조를 놓는다. 닫지 않으면 재시작마다 writer 가 하나씩 샌다.
            process.close_wake();
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            let code_label = code.map_or_else(|| "signal".to_owned(), |code| code.to_string());
            match exit_decision(code) {
                ExitDecision::Stop { state, message } => {
                    if state == GlueState::Failed {
                        winlog!("manager: {FAILED_ALREADY_RUNNING} (exit {code_label})");
                    } else {
                        winlog!("manager: the harness exited with {code_label}; not restarting");
                    }
                    if self.shared.set_glue_status(state, message) {
                        on_update();
                    }
                    return;
                }
                ExitDecision::Restart { message } => {
                    winlog!("manager: the harness exited with {code_label}; restarting");
                    if self.shared.set_restarting(message) {
                        on_update();
                    }
                }
            }
            let delay = options.backoff.after_run(&mut attempt, started.elapsed());
            match receiver.recv_timeout(delay) {
                Ok(SupervisorMessage::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                // 대기 중 이벤트는 이미 캐시에 반영됐다 — Exited 는 하나뿐이라 올 수 없다.
                Ok(SupervisorMessage::Event(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }

    /// 파이프 스레드 콜백 — 캐시 반영·notify 발행·Exited 전달만 한다.
    fn event_callback(
        &self,
        on_update: &Arc<dyn Fn() + Send + Sync>,
        on_notify: &Arc<dyn Fn(HarnessToApp) + Send + Sync>,
    ) -> Arc<dyn Fn(HarnessEvent) + Send + Sync> {
        let shared = Arc::clone(&self.shared);
        let commands = self.commands.clone();
        let on_update = Arc::clone(on_update);
        let on_notify = Arc::clone(on_notify);
        Arc::new(move |event: HarnessEvent| {
            if let HarnessEvent::Message(message) = &event {
                if matches!(message, HarnessToApp::Notify { .. }) {
                    on_notify(message.clone());
                }
            }
            if shared.apply_event(&event) {
                on_update();
            }
            if matches!(event, HarnessEvent::Exited { .. }) {
                // 감독 스레드가 대기 중이 아니면(중지 직후) 무해하게 버려진다.
                let _ = commands.send(SupervisorMessage::Event(event));
            }
        })
    }

    /// spawn 전 오류 — unsupported 로 끝내고 재시작하지 않는다.
    fn stop_unsupported(&self, error: &str, on_update: &Arc<dyn Fn() + Send + Sync>) {
        winlog!("manager: {error}");
        if self.shared.replace_status(spawn_failure_status(error)) {
            on_update();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> ResolvedManagerSettings {
        ResolvedManagerSettings {
            enabled: true,
            model: "gpt-6-luna".to_owned(),
            effort: "high".to_owned(),
            summary_model: "gpt-6-luna".to_owned(),
            summary_effort: "low".to_owned(),
            idle_seconds: 45,
        }
    }

    fn status_message(state: HarnessState) -> HarnessEvent {
        HarnessEvent::Message(HarnessToApp::Status {
            state,
            message: Some("harness message".to_owned()),
            last_collected_at: Some("2026-09-25T00:00:00Z".to_owned()),
            log_path: Some("/home/u/.mast/manager/logs/harness.log".to_owned()),
            codex_version: Some("1.2.3".to_owned()),
        })
    }

    fn board_message() -> HarnessEvent {
        HarnessEvent::Message(HarnessToApp::Board {
            generated_at: "2026-09-25T00:00:00Z".to_owned(),
            entries: vec![serde_json::json!({"workspaceId": 1})],
        })
    }

    #[test]
    fn backoff_delay_grows_to_a_minute_and_caps() {
        let seconds: Vec<u64> = (0..8).map(|attempt| backoff_delay(attempt).as_secs()).collect();
        assert_eq!(seconds, [1, 2, 4, 8, 16, 32, 60, 60]);
        assert_eq!(backoff_delay(99).as_secs(), 60, "상한은 60초다");
    }

    #[test]
    fn a_long_run_resets_the_backoff_to_one_second() {
        assert_eq!(next_attempt(5, Duration::from_secs(299)), 6);
        assert_eq!(next_attempt(5, BACKOFF_RESET_AFTER), 0);
        assert_eq!(next_attempt(5, Duration::from_secs(600)), 0);

        let backoff = Backoff::standard();
        let mut attempt = 5;
        assert_eq!(backoff.after_run(&mut attempt, Duration::from_secs(301)), Duration::from_secs(1));
        assert_eq!(attempt, 0, "초기화 뒤 첫 재시작 지연이 1초다");
    }

    #[test]
    fn exit_codes_map_to_restart_or_stop() {
        for code in [Some(0), Some(1), Some(4), None] {
            assert!(
                matches!(exit_decision(code), ExitDecision::Restart { .. }),
                "{code:?} 는 재시작이다"
            );
        }
        assert_eq!(
            exit_decision(Some(EXIT_NOT_PROVISIONED)),
            ExitDecision::Restart {
                message: Some(RESTARTING_NOT_PROVISIONED.to_owned())
            }
        );
        assert_eq!(
            exit_decision(Some(EXIT_UNSUPPORTED)),
            ExitDecision::Stop {
                state: GlueState::Unsupported,
                message: MessageUpdate::Keep
            }
        );
        assert_eq!(
            exit_decision(Some(EXIT_ALREADY_RUNNING)),
            ExitDecision::Stop {
                state: GlueState::Failed,
                message: MessageUpdate::Set(FAILED_ALREADY_RUNNING.to_owned())
            }
        );
    }

    #[test]
    fn pre_spawn_errors_become_unsupported_without_restart() {
        let status = spawn_failure_status("cannot read /home/u/.mast/bin/mast-python: No such file");
        assert_eq!(status.state, GlueState::Unsupported);
        let message = status.message.expect("spawn 오류에는 문장이 있다");
        assert!(message.contains(SPAWN_SETUP_HINT), "{message}");
        assert!(message.contains("cannot read"), "{message}");
    }

    #[test]
    fn manager_keys_are_k_plus_twenty_lowercase_hex_digits() {
        assert!(valid_manager_key("k0123456789abcdef0123"));
        for bad in [
            "k0123456789abcdef012",   // 19자리
            "k0123456789abcdef01234", // 21자리
            "K0123456789abcdef0123",  // 대문자 접두사
            "0123456789abcdef0123",   // 접두사 없음
            "k0123456789ABCDEF0123",  // 대문자 hex
            "k0123456789abcdef012g",  // hex 아님
            "",
            "k",
        ] {
            assert!(!valid_manager_key(bad), "{bad:?}");
        }
    }

    #[test]
    fn actions_parse_only_resume_and_fresh() {
        assert_eq!(parse_action("resume").unwrap(), HarnessAction::Resume);
        assert_eq!(parse_action("fresh").unwrap(), HarnessAction::Fresh);
        for bad in ["", "Resume", "restart"] {
            assert!(parse_action(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn harness_status_is_reflected_and_the_board_survives_exit() {
        let shared = ManagerShared::new(settings());
        assert_eq!(shared.status().state, GlueState::Starting);

        assert!(shared.apply_event(&status_message(HarnessState::Busy)));
        let status = shared.status();
        assert_eq!(status.state, GlueState::Busy);
        assert_eq!(status.message.as_deref(), Some("harness message"));
        assert_eq!(status.last_collected_at.as_deref(), Some("2026-09-25T00:00:00Z"));
        assert_eq!(status.log_path.as_deref(), Some("/home/u/.mast/manager/logs/harness.log"));

        assert!(shared.apply_event(&board_message()));
        let board = shared.board().expect("board 캐시");
        assert_eq!(board["type"], "board");
        assert_eq!(board["generatedAt"], "2026-09-25T00:00:00Z");
        assert_eq!(board["entries"][0]["workspaceId"], 1);

        // 같은 status 를 다시 반영하면 변경이 아니다 — 중복 emit 을 만들지 않는다.
        assert!(!shared.apply_event(&status_message(HarnessState::Busy)));

        // 하네스가 죽어 restarting 이 돼도 board 는 유지된다.
        assert!(shared.set_restarting(None));
        let payload = shared.payload();
        assert_eq!(payload.status.state, GlueState::Restarting);
        assert!(payload.board.is_some(), "종료 뒤에도 마지막 보드를 유지한다");
        assert!(!shared.set_restarting(None), "같은 restarting 은 변경이 아니다");
    }

    #[test]
    fn exit_three_keeps_the_last_harness_message() {
        let shared = ManagerShared::new(settings());
        shared.apply_event(&status_message(HarnessState::Unsupported));
        shared.set_glue_status(
            GlueState::Unsupported,
            MessageUpdate::Keep,
        );
        let status = shared.status();
        assert_eq!(status.state, GlueState::Unsupported);
        assert_eq!(
            status.message.as_deref(),
            Some("harness message"),
            "exit 3 은 하네스가 보낸 문장을 유지한다"
        );
    }

    #[test]
    fn notification_payload_is_the_notify_body() {
        let message = HarnessToApp::Notify {
            workspace_id: 3,
            reason: NotifyReason::Question,
            title: "t".to_owned(),
            body: "b".to_owned(),
        };
        assert_eq!(
            notification_payload(&message).unwrap(),
            serde_json::json!({
                "type": "notify",
                "workspaceId": 3,
                "reason": "question",
                "title": "t",
                "body": "b"
            })
        );
        assert!(notification_payload(&HarnessToApp::Board {
            generated_at: "t".to_owned(),
            entries: Vec::new(),
        })
        .is_none());
    }

    #[test]
    fn manager_action_without_a_harness_is_an_error() {
        let shared = ManagerShared::new(settings());
        assert_eq!(
            shared.send_action(HarnessAction::Resume, "k0123456789abcdef0123".to_owned()),
            Err(HARNESS_NOT_RUNNING.to_owned())
        );
    }

    #[test]
    fn board_payload_serializes_the_contract_shape() {
        assert_eq!(
            serde_json::to_value(ManagerBoardPayload::disabled()).unwrap(),
            serde_json::json!({
                "status": {
                    "state": "disabled",
                    "message": null,
                    "lastCollectedAt": null,
                    "logPath": null
                },
                "board": null
            })
        );

        let shared = ManagerShared::new(settings());
        shared.apply_event(&status_message(HarnessState::Ok));
        shared.apply_event(&board_message());
        assert_eq!(
            serde_json::to_value(shared.payload()).unwrap(),
            serde_json::json!({
                "status": {
                    "state": "ok",
                    "message": "harness message",
                    "lastCollectedAt": "2026-09-25T00:00:00Z",
                    "logPath": "/home/u/.mast/manager/logs/harness.log"
                },
                "board": {
                    "type": "board",
                    "generatedAt": "2026-09-25T00:00:00Z",
                    "entries": [{"workspaceId": 1}]
                }
            })
        );
    }

    #[cfg(unix)]
    mod integration {
        use std::path::{Path, PathBuf};
        use std::process::Command;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};

        use mast_core::command::{Dispatcher, SessionHost, ShellSpawnReq};
        use mast_core::manager::{
            AppToHarness, HarnessSettings, HarnessToApp, HARNESS_PROTOCOL,
        };
        use mast_core::session::SessionId;

        use super::super::{
            start, Backoff, GlueState, ManagerShared, SupervisorOptions,
        };

        struct IdleHost;

        impl SessionHost for IdleHost {
            fn spawn_shell(&self, _req: ShellSpawnReq) -> anyhow::Result<SessionId> {
                Err(anyhow::anyhow!("the test host does not spawn shells"))
            }

            fn kill(&self, _id: SessionId) {}
        }

        fn hello() -> AppToHarness {
            AppToHarness::Hello {
                protocol: HARNESS_PROTOCOL,
                manager_workspace: 7,
                manager_dir: "/home/u/.mast/manager".into(),
                manager_distro: None,
                default_distro: Some("Ubuntu".into()),
                settings: HarnessSettings {
                    model: "gpt-6-luna".into(),
                    effort: "high".into(),
                    summary_model: "gpt-6-luna".into(),
                    summary_effort: "low".into(),
                    idle_seconds: 45,
                },
            }
        }

        fn wait_until(timeout: Duration, mut ready: impl FnMut() -> bool) -> bool {
            let deadline = Instant::now() + timeout;
            loop {
                if ready() {
                    return true;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        struct TempPath(PathBuf);

        impl TempPath {
            fn new(label: &str) -> Self {
                use std::sync::atomic::AtomicUsize;
                static NEXT: AtomicUsize = AtomicUsize::new(0);
                let path = std::env::temp_dir().join(format!(
                    "mast-manager-supervisor-{}-{}-{label}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                Self(path)
            }

            fn path(&self) -> &Path {
                &self.0
            }

            fn as_arg(&self) -> String {
                self.0.to_string_lossy().into_owned()
            }
        }

        impl Drop for TempPath {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }

        fn recorded_lines(path: &Path) -> Vec<String> {
            std::fs::read_to_string(path)
                .map(|text| text.lines().map(str::to_owned).collect())
                .unwrap_or_default()
        }

        fn fake_command(
            script: &'static str,
            args: Vec<String>,
        ) -> Arc<dyn Fn() -> Result<Command, String> + Send + Sync> {
            Arc::new(move || {
                let mut command = Command::new("python3");
                command.args(["-c", script]);
                command.args(&args);
                Ok(command)
            })
        }

        /// 실행 횟수(카운터 파일 줄 수)에 따라 `exits` 의 코드를 고르는 가짜 하네스.
        /// 음수 코드는 stdin 이 EOF 될 때까지 살아 있다가 정상 종료한다.
        const FLAPPY_HARNESS: &str = r#"
import json
import sys

record, counter, plan = sys.argv[1], sys.argv[2], sys.argv[3]
exits = [int(part) for part in plan.split(",")]
try:
    with open(counter) as handle:
        run = sum(1 for line in handle if line.strip())
except FileNotFoundError:
    run = 0
with open(counter, "a") as handle:
    handle.write("run\n")
exit_code = exits[min(run, len(exits) - 1)]

hello = sys.stdin.readline()
with open(record, "a") as handle:
    handle.write(hello)

def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()

emit({"type": "status", "state": "ok", "message": None, "lastCollectedAt": None, "logPath": None, "codexVersion": None})
emit({"type": "board", "generatedAt": "2026-09-25T00:00:00Z", "entries": []})

if exit_code >= 0:
    sys.exit(exit_code)
for _ in sys.stdin:
    pass
"#;

        /// status unsupported 를 보내고 exit 3 으로 끝나는 가짜 하네스.
        const UNSUPPORTED_HARNESS: &str = r#"
import json
import sys

record = sys.argv[1]
with open(record, "a") as handle:
    handle.write("run\n")

sys.stdin.readline()
sys.stdout.write(json.dumps({"type": "status", "state": "unsupported", "message": "codex is missing", "lastCollectedAt": None, "logPath": None, "codexVersion": None}) + "\n")
sys.stdout.flush()
sys.exit(3)
"#;

        #[test]
        fn a_harness_that_dies_restarts_and_the_second_run_gets_hello() {
            let dispatcher = Arc::new(Mutex::new(Dispatcher::new(Box::new(IdleHost))));
            dispatcher.lock().unwrap().set_manager_events(true);
            let shared = Arc::new(ManagerShared::new(super::settings()));
            let record = TempPath::new("hello.jsonl");
            let counter = TempPath::new("runs");
            let seen: Arc<Mutex<Vec<GlueState>>> = Arc::new(Mutex::new(Vec::new()));
            let observed = Arc::clone(&seen);
            let observed_shared = Arc::clone(&shared);
            let on_update = Arc::new(move || {
                observed
                    .lock()
                    .unwrap()
                    .push(observed_shared.status().state);
            });
            let supervisor = start(
                Arc::clone(&shared),
                SupervisorOptions {
                    hello: hello(),
                    dispatcher,
                    build_command: fake_command(
                        FLAPPY_HARNESS,
                        vec![record.as_arg(), counter.as_arg(), "1,-1".to_owned()],
                    ),
                    backoff: Backoff::fast(),
                },
                on_update,
                Arc::new(|_| {}),
            );

            // 첫 실행: status ok 와 board 가 캐시에 반영된다. 이때 핸들을 붙잡아
            // 재시작 뒤 이전 실행의 writer 가 끝났는지 본다.
            let captured = Arc::new(Mutex::new(Vec::new()));
            let capture = Arc::clone(&captured);
            assert!(wait_until(Duration::from_secs(5), || {
                if let Some(process) = shared.process() {
                    let mut seen = capture.lock().unwrap();
                    if !seen.iter().any(|kept| Arc::ptr_eq(kept, &process)) {
                        seen.push(process);
                    }
                }
                !recorded_lines(record.path()).is_empty()
                    && shared.status().state == GlueState::Ok
            }));
            assert!(shared.board().is_some(), "board 가 캐시되어야 한다");

            // exit 1 → restarting 을 거쳐 재시작하고, 두 번째 실행이 hello 를 다시 받는다.
            assert!(wait_until(Duration::from_secs(5), || {
                recorded_lines(record.path()).len() >= 2
            }));
            // 이전 실행(현재 실행이 아닌)의 writer 는 Wake 가 닫혀 끝나야 한다.
            let previous = captured
                .lock()
                .unwrap()
                .iter()
                .find(|process| {
                    shared
                        .process()
                        .is_none_or(|current| !Arc::ptr_eq(&current, process))
                })
                .cloned()
                .expect("이전 실행 핸들을 붙잡아야 한다");
            assert!(
                wait_until(Duration::from_secs(5), || previous.writer_finished()),
                "이전 실행의 writer 스레드가 끝나야 한다"
            );
            assert!(
                seen.lock().unwrap().contains(&GlueState::Restarting),
                "재시작 전에 restarting 을 거친다"
            );
            let lines = recorded_lines(record.path());
            assert_eq!(lines[0], lines[1], "두 번째 실행도 같은 hello 를 받는다");
            let second: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
            assert_eq!(second["type"], "hello");
            assert_eq!(second["managerWorkspace"], 7);

            // 중지 API 로 끝내면 재시작하지 않는다 — 10ms 백오프보다 오래 기다린다.
            supervisor.stop();
            let before = recorded_lines(record.path()).len();
            std::thread::sleep(Duration::from_millis(200));
            assert_eq!(
                recorded_lines(record.path()).len(),
                before,
                "중지 뒤에는 재시작하지 않는다"
            );
        }

        #[test]
        fn exit_three_keeps_the_message_and_never_restarts() {
            let dispatcher = Arc::new(Mutex::new(Dispatcher::new(Box::new(IdleHost))));
            let shared = Arc::new(ManagerShared::new(super::settings()));
            let record = TempPath::new("runs");
            let seen: Arc<Mutex<Vec<GlueState>>> = Arc::new(Mutex::new(Vec::new()));
            let observed = Arc::clone(&seen);
            let observed_shared = Arc::clone(&shared);
            let on_update = Arc::new(move || {
                observed
                    .lock()
                    .unwrap()
                    .push(observed_shared.status().state);
            });
            let supervisor = start(
                Arc::clone(&shared),
                SupervisorOptions {
                    hello: hello(),
                    dispatcher,
                    build_command: fake_command(UNSUPPORTED_HARNESS, vec![record.as_arg()]),
                    backoff: Backoff::fast(),
                },
                on_update,
                Arc::new(|_| {}),
            );

            assert!(wait_until(Duration::from_secs(5), || {
                shared.status().state == GlueState::Unsupported
            }));
            assert_eq!(
                shared.status().message.as_deref(),
                Some("codex is missing"),
                "하네스가 보낸 문장을 유지한다"
            );

            std::thread::sleep(Duration::from_millis(200));
            assert_eq!(recorded_lines(record.path()).len(), 1, "exit 3 은 재시작하지 않는다");
            assert!(!seen.lock().unwrap().contains(&GlueState::Restarting));
            supervisor.stop();
        }

        #[test]
        fn a_pre_spawn_error_marks_unsupported_without_restart() {
            let dispatcher = Arc::new(Mutex::new(Dispatcher::new(Box::new(IdleHost))));
            let shared = Arc::new(ManagerShared::new(super::settings()));
            let calls = Arc::new(AtomicUsize::new(0));
            let calls_cb = Arc::clone(&calls);
            let build_command: Arc<dyn Fn() -> Result<Command, String> + Send + Sync> =
                Arc::new(move || {
                    calls_cb.fetch_add(1, Ordering::SeqCst);
                    Err("cannot read /home/u/.mast/bin/mast-python: No such file".to_owned())
                });
            let supervisor = start(
                Arc::clone(&shared),
                SupervisorOptions {
                    hello: hello(),
                    dispatcher,
                    build_command,
                    backoff: Backoff::fast(),
                },
                Arc::new(|| {}),
                Arc::new(|_| {}),
            );

            assert!(wait_until(Duration::from_secs(5), || {
                shared.status().state == GlueState::Unsupported
            }));
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(calls.load(Ordering::SeqCst), 1, "spawn 전 오류는 재시작하지 않는다");
            supervisor.stop();
        }

        // 하네스 notify 가 on_notify 로 그대로 전달되는지 — 상태 캐시와 별개 경로다.
        #[test]
        fn notify_messages_are_forwarded_to_the_callback() {
            const NOTIFY_HARNESS: &str = r#"
import json
import sys

sys.stdin.readline()
sys.stdout.write(json.dumps({"type": "notify", "workspaceId": 3, "reason": "question", "title": "t", "body": "b"}) + "\n")
sys.stdout.flush()
for _ in sys.stdin:
    pass
"#;
            let dispatcher = Arc::new(Mutex::new(Dispatcher::new(Box::new(IdleHost))));
            let shared = Arc::new(ManagerShared::new(super::settings()));
            let seen: Arc<Mutex<Vec<HarnessToApp>>> = Arc::new(Mutex::new(Vec::new()));
            let seen_cb = Arc::clone(&seen);
            let supervisor = start(
                Arc::clone(&shared),
                SupervisorOptions {
                    hello: hello(),
                    dispatcher,
                    build_command: fake_command(NOTIFY_HARNESS, Vec::new()),
                    backoff: Backoff::fast(),
                },
                Arc::new(|| {}),
                Arc::new(move |message| seen_cb.lock().unwrap().push(message)),
            );

            assert!(wait_until(Duration::from_secs(5), || {
                !seen.lock().unwrap().is_empty()
            }));
            let messages = seen.lock().unwrap().clone();
            assert!(matches!(
                &messages[0],
                HarnessToApp::Notify { workspace_id: 3, title, body, .. }
                    if title == "t" && body == "b"
            ));
            supervisor.stop();
        }
    }
}
