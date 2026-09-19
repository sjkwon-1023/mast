//! PTY 입력 쓰기 coordinator — 네트워크 수명과 **무기한 blocking** 쓰기를 분리하는 자리다.
//!
//! `PtySession::write` 는 `write_all` 이라 상대가 stdin 을 읽지 않으면 무기한 반환하지
//! 않는다. 그 호출을 QUIC 런타임 위에서 돌리면(또는 `spawn_blocking` 으로 미루면) 종료가
//! 그 쓰기에 묶인다. 그래서 슬롯을 인수한 쓰기마다 std 워커 스레드 하나가 그 호출을
//! 실행하고, 네트워크 쪽은 결과를 oneshot 으로 기다릴 뿐이다.
//!
//! 수명 계약은 두 문장이다.
//!
//! 1. **큐가 없다.** [`WriterLease::submit`] 이 슬롯 하나를 그 자리에서 점유하고, 그때부터
//!    쓰기는 in-flight 다. 슬롯이 차 있으면 새 제출은 실행되지 않고 `Busy` 로 거절된다.
//!    그래서 이전 페어링의 막힌 쓰기가 남아 있으면 다음 페어링의 입력은 명시적인 busy
//!    오류가 되고, 페어링이 몇 번 반복돼도 in-flight 쓰기와 워커 스레드는 **최대 1개**다.
//! 2. **이미 점유한 쓰기는 취소할 수 없다.** 이 한계를 숨기지 않는다. 대신 [`WriterLease`]
//!    가 닫힌 뒤의 제출은 어떤 슬롯 상태에서도 실행되지 않고 `Stopped` 로 거절된다 —
//!    종료된 연결의 입력이 뒤늦게 PTY 에 들어가는 경로가 없다.
//!
//! 이 coordinator 는 **호출자(Tauri 글루·테스트 Harness)가 소유**한다. `SecureRemote::start`
//! 마다 새로 만들지 않는다 — 그래야 이전 페어링의 막힌 쓰기가 다음 페어링에 보인다.
//! 프로세스 전역 singleton 이 아니라 인스턴스가 소유 경계라, 병렬 테스트는 각자의
//! coordinator 를 쥐고 서로의 슬롯에 간섭하지 않는다.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tokio::sync::oneshot;

/// 실행할 쓰기 하나. `run` 이 PTY 를 만지는 blocking 구간이다.
pub(crate) struct Job {
    run: Box<dyn FnOnce() -> Result<(), String> + Send>,
    done: oneshot::Sender<Result<(), String>>,
}

impl Job {
    pub(crate) fn new(
        run: impl FnOnce() -> Result<(), String> + Send + 'static,
        done: oneshot::Sender<Result<(), String>>,
    ) -> Self {
        Self {
            run: Box::new(run),
            done,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SubmitError {
    /// 슬롯이 이미 찼다 — 진행 중인 쓰기가 끝나야 다음 쓰기를 받는다.
    Busy,
    /// 이 lease 는 닫혔다. 잡은 실행되지 않았다.
    Stopped,
    /// 워커 스레드를 띄우지 못했다. 잡은 실행되지 않았다.
    Unavailable,
}

/// 슬롯과 워커 핸들. 워커 스레드가 `Arc` 로 함께 들고 있어, coordinator 가 먼저
/// 버려져도 진행 중인 쓰기는 끝까지 간다.
struct Shared {
    state: Mutex<State>,
}

struct State {
    /// 실행 중(또는 실행 직전으로 인수된) 쓰기가 있는가.
    in_flight: bool,
    /// 마지막으로 띄운 워커. `in_flight` 가 false 인 동안에는 곧 끝난다.
    worker: Option<JoinHandle<()>>,
}

/// 서버 하나가 쥐는 쓰기 슬롯의 소유권. `close` 뒤에는 그 서버의 제출이 실행되지 않는다.
///
/// 슬롯 자체는 coordinator 전체에 하나뿐이라, 열려 있는 lease 가 둘이면 먼저 제출한 쪽이
/// 이기고 다른 쪽은 `Busy` 를 본다 — 그 판정이 [`WriterLease::submit`] 의 lock 안에서
/// [`Self::close`] 와 원자적이다.
pub(crate) struct WriterLease {
    shared: Arc<Shared>,
    closed: AtomicBool,
}

/// 호출자가 소유하는 공유 coordinator. `SecureRemoteDeps` 가 필수로 받는다.
pub struct InputWriter {
    shared: Arc<Shared>,
}

impl InputWriter {
    /// 워커 스레드를 미리 띄우지 않는다 — 쓰기가 없으면 스레드도 없다.
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    in_flight: false,
                    worker: None,
                }),
            }),
        }
    }

    /// 이 coordinator 위의 서버 하나가 쓸 lease. 서버는 종료할 때 닫는다.
    pub(crate) fn lease(&self) -> WriterLease {
        WriterLease {
            shared: Arc::clone(&self.shared),
            closed: AtomicBool::new(false),
        }
    }

    /// 테스트·진단용: 지금 인수된(실행 중이거나 실행 직전인) 쓰기 워커 수. 0 또는 1.
    ///
    /// 끝난 워커는 여기서 회수한다 — 제품 경로의 회수는 다음 [`WriterLease::submit`] 이다.
    #[cfg(test)]
    fn live_workers(&self) -> usize {
        let finished = {
            let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            match state.worker.as_ref() {
                Some(handle) if handle.is_finished() => state.worker.take(),
                _ => None,
            }
        };
        if let Some(handle) = finished {
            let _ = handle.join();
        }
        let state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        usize::from(state.in_flight)
    }
}

impl Default for InputWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for InputWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InputWriter").finish_non_exhaustive()
    }
}

impl WriterLease {
    /// 잡 하나를 맡긴다. **점유는 여기서 일어난다** — 반환이 `Ok` 면 그 쓰기는 이미
    /// in-flight 이고, 큐에 남아 나중에 실행되는 잡은 없다.
    pub(crate) fn submit(&self, job: Job) -> Result<(), SubmitError> {
        let previous = {
            let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            // 닫힘 판정과 점유를 같은 lock 안에서 한다 — close 가 먼저면 제출은 절대
            // 실행되지 않고, submit 이 먼저면 그 쓰기는 in-flight 로 남는다.
            if self.closed.load(Ordering::SeqCst) {
                return Err(SubmitError::Stopped);
            }
            if state.in_flight {
                return Err(SubmitError::Busy);
            }
            let previous = state.worker.take();
            state.in_flight = true;
            previous
        };
        // 이전 워커 회수는 lock 밖이다. `in_flight` 가 false 였다는 것은 그 워커가
        // PTY 구간을 마치고 결과 전송만 남겼다는 뜻이라 join 은 곧 끝난다.
        if let Some(handle) = previous {
            let _ = handle.join();
        }

        let shared = Arc::clone(&self.shared);
        let spawned = std::thread::Builder::new()
            .name("mast-secure-remote-writer".into())
            .spawn(move || run_job(shared, job));
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match spawned {
            Ok(handle) => {
                state.worker = Some(handle);
                Ok(())
            }
            Err(_) => {
                state.in_flight = false;
                Err(SubmitError::Unavailable)
            }
        }
    }

    /// 이 lease 로는 더 이상 쓰기를 받지 않는다. 진행 중인 쓰기는 끝까지 간다.
    pub(crate) fn close(&self) {
        // submit 의 닫힘 판정과 같은 lock 을 잡는다 — `close` 반환 뒤에 시작하는 제출은
        // 반드시 `Stopped` 를 본다.
        let _state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        self.closed.store(true, Ordering::SeqCst);
    }
}

impl Drop for WriterLease {
    fn drop(&mut self) {
        self.close();
    }
}

/// 워커 스레드 본체. 슬롯을 놓은 뒤에 결과를 보내므로, 결과를 관측한 호출자가 곧바로
/// 다음 잡을 제출해도 `Busy` 를 보지 않는다.
fn run_job(shared: Arc<Shared>, job: Job) {
    let guard = ReleaseGuard {
        shared,
        released: Cell::new(false),
    };
    let result = (job.run)();
    guard.release();
    // 수신자가 사라졌어도(연결 종료) 쓰기 자체는 끝까지 간다.
    let _ = job.done.send(result);
}

/// 패닉 unwind 를 포함해 슬롯을 정확히 한 번 놓는다.
///
/// `released` 플래그가 없으면 두 번 lock 을 잡게 되고, 그러면 다음 `submit` 이 이
/// 스레드를 join 할 때(락 밖이지만) 마지막 drop 이 락을 기다릴 수 있다 — 회수 경계를
/// 한 번의 lock 으로 못 박아 둔다.
struct ReleaseGuard {
    shared: Arc<Shared>,
    released: Cell<bool>,
}

impl ReleaseGuard {
    fn release(&self) {
        if !self.released.replace(true) {
            let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            state.in_flight = false;
        }
    }
}

impl Drop for ReleaseGuard {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// 테스트가 결과를 기다리지 않고 "제출만" 할 때 쓰는 수신자.
    fn sink() -> oneshot::Sender<Result<(), String>> {
        let (tx, _rx) = oneshot::channel();
        tx
    }

    /// `started` 를 보낸 뒤 `unblock` 이 올 때까지 블록하는 잡 — 막힌 PTY 쓰기 하나를
    /// 스레드 관측 가능한 형태로 흉내낸다.
    fn blocking_job(
        started: mpsc::Sender<()>,
        unblock: mpsc::Receiver<()>,
        done: oneshot::Sender<Result<(), String>>,
    ) -> Job {
        Job::new(
            move || {
                started.send(()).ok();
                unblock.recv().ok();
                Ok(())
            },
            done,
        )
    }

    /// "무엇이든 실행되면 true" 를 남기는 잡 — 거절된 잡이 어딘가에서 실행됐는지 본다.
    fn watched_job(ran: Arc<Mutex<bool>>, done: oneshot::Sender<Result<(), String>>) -> Job {
        Job::new(
            move || {
                *ran.lock().unwrap() = true;
                Ok(())
            },
            done,
        )
    }

    fn wait_for_workers(writer: &InputWriter, expected: usize) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if writer.live_workers() == expected {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn runs_one_job_and_reports_the_result() {
        let writer = InputWriter::new();
        let lease = writer.lease();
        let (result_tx, result_rx) = oneshot::channel();
        lease
            .submit(Job::new(|| Ok(()), result_tx))
            .expect("submit");
        assert_eq!(result_rx.blocking_recv().unwrap(), Ok(()));
        assert!(wait_for_workers(&writer, 0), "워커가 회수되지 않았다");
    }

    #[test]
    fn a_second_job_is_rejected_while_one_is_in_flight() {
        let writer = InputWriter::new();
        let lease = writer.lease();
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let (unblock_tx, unblock_rx) = mpsc::channel::<()>();
        let (first_tx, first_rx) = oneshot::channel();
        lease
            .submit(blocking_job(started_tx, unblock_rx, first_tx))
            .expect("submit first");
        // `started` 는 워커가 실행 안에서만 보내므로, 이 시점의 두 번째 제출은
        // 결정적으로 Busy 다.
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("worker starts the first job");
        assert_eq!(writer.live_workers(), 1, "막힌 쓰기 워커는 하나다");

        let ran = Arc::new(Mutex::new(false));
        assert_eq!(
            lease.submit(watched_job(Arc::clone(&ran), sink())),
            Err(SubmitError::Busy),
            "실행 중인 슬롯인데 두 번째 잡이 받아들여졌다"
        );
        assert_eq!(writer.live_workers(), 1);
        assert!(!*ran.lock().unwrap(), "거절된 잡이 어딘가에서 실행됐다");

        unblock_tx.send(()).unwrap();
        assert_eq!(first_rx.blocking_recv().unwrap(), Ok(()));

        // 결과를 본 시점에는 슬롯이 비어 다음 잡을 받을 수 있어야 한다.
        let (third_tx, third_rx) = oneshot::channel();
        lease
            .submit(Job::new(|| Ok(()), third_tx))
            .expect("idle again after completion");
        assert_eq!(third_rx.blocking_recv().unwrap(), Ok(()));
    }

    /// 완료 조건의 회귀 시나리오 그대로다: 막힌 첫 쓰기 → 서버 종료 → 재페어링 →
    /// 두 번째 lease 의 쓰기 거절 → 첫 쓰기 해제 → 다음 쓰기 허용.
    ///
    /// coordinator 를 페어링 사이에 공유하지 않으면 두 번째 쓰기는 받아들여진다 —
    /// 그 차이가 이 테스트가 잡는 회귀다.
    #[test]
    fn a_blocked_write_from_a_closed_lease_keeps_the_next_lease_busy_until_it_ends() {
        let writer = InputWriter::new();
        let first = writer.lease();
        let second = writer.lease();

        let (started_tx, started_rx) = mpsc::channel::<()>();
        let (unblock_tx, unblock_rx) = mpsc::channel::<()>();
        let (first_tx, first_rx) = oneshot::channel();
        first
            .submit(blocking_job(started_tx, unblock_rx, first_tx))
            .expect("submit the first write");
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the first write is running");

        // 첫 페어링이 끝난다 — 막힌 쓰기는 계속되고 슬롯은 그대로다.
        first.close();
        assert_eq!(writer.live_workers(), 1, "막힌 쓰기 워커는 하나뿐이다");

        // 종료된 lease 의 제출은 실행되지 않는다.
        let ran = Arc::new(Mutex::new(false));
        assert_eq!(
            first.submit(watched_job(Arc::clone(&ran), sink())),
            Err(SubmitError::Stopped)
        );
        assert_eq!(
            first.submit(Job::new(|| Ok(()), sink())),
            Err(SubmitError::Stopped)
        );

        // 재페어링한 두 번째 lease 의 입력은 명시적인 busy 로 거절된다.
        assert_eq!(
            second.submit(watched_job(Arc::clone(&ran), sink())),
            Err(SubmitError::Busy),
            "이전 페어링의 막힌 쓰기가 있는데 새 입력이 받아들여졌다"
        );
        assert_eq!(writer.live_workers(), 1, "거절된 제출이 스레드를 만들었다");
        assert!(!*ran.lock().unwrap(), "거절된 잡이 실행됐다");

        // 첫 쓰기를 풀면 슬롯이 비고 다음 쓰기가 받아들여진다.
        unblock_tx.send(()).unwrap();
        assert_eq!(first_rx.blocking_recv().unwrap(), Ok(()));
        let (next_tx, next_rx) = oneshot::channel();
        second
            .submit(Job::new(|| Ok(()), next_tx))
            .expect("the slot is free after the blocked write ends");
        assert_eq!(next_rx.blocking_recv().unwrap(), Ok(()));
        assert!(wait_for_workers(&writer, 0), "워커가 회수되지 않았다");
    }

    /// 페어링을 여러 번 반복해도 워커 스레드가 누적되지 않는다 — 매 라운드가 같은
    /// coordinator 의 같은 슬롯을 쓴다.
    #[test]
    fn repeated_pairings_never_accumulate_workers() {
        let writer = InputWriter::new();
        for round in 0..25 {
            let lease = writer.lease();
            let (started_tx, started_rx) = mpsc::channel::<()>();
            let (unblock_tx, unblock_rx) = mpsc::channel::<()>();
            let (done_tx, done_rx) = oneshot::channel();
            lease
                .submit(blocking_job(started_tx, unblock_rx, done_tx))
                .expect("submit");
            started_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap_or_else(|_| panic!("round {round}: worker did not start"));
            assert_eq!(writer.live_workers(), 1, "round {round}");
            lease.close();
            unblock_tx.send(()).unwrap();
            assert_eq!(done_rx.blocking_recv().unwrap(), Ok(()), "round {round}");
            assert!(
                wait_for_workers(&writer, 0),
                "round {round}: worker was not reaped"
            );
        }
    }

    #[test]
    fn a_failing_job_reports_the_error_to_the_submitter() {
        let writer = InputWriter::new();
        let lease = writer.lease();
        let (result_tx, result_rx) = oneshot::channel();
        lease
            .submit(Job::new(|| Err("blocked".to_string()), result_tx))
            .expect("submit");
        assert_eq!(result_rx.blocking_recv().unwrap(), Err("blocked".into()));
    }

    /// 잡이 패닉해도 슬롯은 풀린다 — 그렇지 않으면 패닉 한 번이 그 coordinator 의
    /// 모든 후속 입력을 영구 busy 로 만든다.
    #[test]
    fn a_panicking_job_still_releases_the_slot() {
        let writer = InputWriter::new();
        let lease = writer.lease();
        let (result_tx, result_rx) = oneshot::channel();
        lease
            .submit(Job::new(|| panic!("the pty layer panicked"), result_tx))
            .expect("submit");
        // sender 가 unwind 로 사라졌으므로 수신은 Err 다.
        assert!(result_rx.blocking_recv().is_err());
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let (next_tx, next_rx) = oneshot::channel();
            match lease.submit(Job::new(|| Ok(()), next_tx)) {
                Ok(()) => {
                    assert_eq!(next_rx.blocking_recv().unwrap(), Ok(()));
                    break;
                }
                // 패닉 정리는 unwind 경로라 점유 해제가 몇 밀리초 늦을 수 있다.
                Err(SubmitError::Busy) => {
                    assert!(std::time::Instant::now() < deadline, "슬롯이 풀리지 않았다");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(other) => panic!("unexpected: {other:?}"),
            }
        }
    }
}
