//! 반환하지 않을 수 있는 동기 호출에 시간 상한을 준다.
//!
//! 존재 이유는 `dispatch` 의 잠금 구조다: 앱의 모든 상태 변이가 Dispatcher lock 하나를
//! 공유하는데 셸 스폰이 **그 lock 아래에서** 일어난다(`commands.rs` 의 dispatch 주석이
//! "프로세스 생성 — 수십 ms" 를 전제로 그 설계를 수용한다고 밝힌다). 그 전제가 깨지면
//! 탭 하나를 만들려다 앱 전체가 멈추므로, 여기서 점유 시간에 상한을 씌운다.
//!
//! # 늦게 끝난 작업의 자원
//!
//! 마감을 넘긴 뒤 작업이 끝나면 그 결과물(스폰된 세션 등)은 아무도 기다리지 않는 자원이
//! 된다. 그것을 회수하는 것이 `discard` 이고, **rendezvous 채널(`sync_channel(0)`)이 그
//! 회수를 빈틈없게 만드는 장치다.** 버퍼가 있는 채널이면 "수신자가 타임아웃을 반환한 뒤
//! 아직 살아 있는 동안 `send` 가 성공해, 값이 버퍼에 앉은 채 수신자와 함께 사라지는" 창이
//! 생긴다 — 그러면 정리 훅이 영영 실행되지 않는다(프로토타입으로 재현 확인). 용량 0
//! 채널에는 값이 머물 자리가 없어서, 값은 언제나 **수신자가 받았거나 `SendError` 로
//! 워커에게 돌아가거나** 둘 중 하나다.
//!
//! 이 모듈이 해결하지 않는 것: `f` 가 **영영 반환하지 않으면** 스레드와 그 안의 자원은
//! 그대로 남는다. 그 경우에도 Dispatcher lock 은 풀린다는 것이 이 장치의 요점이고,
//! 매달린 스레드 하나는 그 대가로 수용한다.

use std::sync::mpsc;
use std::time::Duration;

/// `f` 를 전용 스레드에서 실행하고 `deadline` 까지 기다린다. 시간 안에 끝나면
/// `Some(값)`, 아니면 `None` 이고 그때 늦게 도착한 값은 `discard` 가 워커 스레드에서
/// 회수한다 — 호출자 쪽에서 정리가 돌면 그 정리가 다시 블록될 때 상한이 무의미해진다.
///
/// 스레드를 띄우지 못하거나 `f` 가 panic 하면 `None` 이다.
///
/// **panic 경로에는 회수 보장이 없다.** 값이 만들어지기 전이면 회수할 것도 없지만, `f`
/// 가 외부 레지스트리를 먼저 건드린 뒤 panic 하면 그 흔적은 여기서 정리되지 않는다 —
/// `discard` 는 값을 받아야 돌기 때문이다. 호출자에게는 그 경우가 타임아웃과 구분되지
/// 않는다는 것도 함께 수용한다: panic 은 프로그램 결함이고, 이 장치는 정상 경로의 늦은
/// 완료를 회수하는 데까지가 책임 범위다.
pub fn call_with_deadline<T, F, D>(
    thread_name: &str,
    deadline: Duration,
    f: F,
    discard: D,
) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
    D: FnOnce(T) + Send + 'static,
{
    let (tx, rx) = mpsc::sync_channel::<T>(0);
    let spawned = std::thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            let value = f();
            if let Err(mpsc::SendError(value)) = tx.send(value) {
                discard(value);
            }
        });
    if let Err(err) = spawned {
        eprintln!("[mast] {thread_name}: cannot spawn the worker thread ({err})");
        return None;
    }
    rx.recv_timeout(deadline).ok()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    /// 값 하나를 흉내내는 자원 — 회수되지 않으면 누수다.
    struct Resource(u32);

    #[test]
    fn a_call_that_finishes_in_time_returns_its_value() {
        let discarded = Arc::new(AtomicUsize::new(0));
        let sink = Arc::clone(&discarded);
        let got = call_with_deadline(
            "test-fast",
            Duration::from_secs(5),
            || Resource(7),
            move |_| {
                sink.fetch_add(1, Ordering::SeqCst);
            },
        );
        assert_eq!(got.map(|r| r.0), Some(7));
        assert_eq!(discarded.load(Ordering::SeqCst), 0, "nothing to discard");
    }

    #[test]
    fn a_late_value_is_handed_to_discard() {
        let discarded = Arc::new(AtomicUsize::new(0));
        let sink = Arc::clone(&discarded);
        let got = call_with_deadline(
            "test-late",
            Duration::from_millis(30),
            || {
                std::thread::sleep(Duration::from_millis(300));
                Resource(9)
            },
            move |r| {
                assert_eq!(r.0, 9);
                sink.fetch_add(1, Ordering::SeqCst);
            },
        );
        assert!(got.is_none(), "the deadline must win");
        // 워커가 send 에 실패하고 값을 되찾을 때까지 기다린다.
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while discarded.load(Ordering::SeqCst) == 0 {
            assert!(std::time::Instant::now() < until, "the late value leaked");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// 마감과 완료가 겹치는 구간을 반복해 훑는다. 어느 쪽이 이기든 값은 **정확히 한 번**
    /// 회계돼야 한다 — 반환되거나 회수되거나. 버퍼 있는 채널이었다면 이 구간에서 값이
    /// 조용히 사라진다.
    #[test]
    fn a_value_is_never_lost_at_the_boundary() {
        for step in 0..40u64 {
            let discarded = Arc::new(AtomicUsize::new(0));
            let sink = Arc::clone(&discarded);
            let work = Duration::from_micros(step * 250);
            let got = call_with_deadline(
                "test-boundary",
                Duration::from_millis(5),
                move || {
                    std::thread::sleep(work);
                    Resource(1)
                },
                move |_| {
                    sink.fetch_add(1, Ordering::SeqCst);
                },
            );
            let until = std::time::Instant::now() + Duration::from_secs(5);
            let accounted = loop {
                let d = discarded.load(Ordering::SeqCst);
                if got.is_some() {
                    // 받아 갔으면 회수는 일어나지 않는다 (이중 회계 금지).
                    assert_eq!(d, 0, "step {step}: a received value was also discarded");
                    break true;
                }
                if d == 1 {
                    break true;
                }
                assert!(
                    std::time::Instant::now() < until,
                    "step {step}: the value was neither returned nor discarded"
                );
                std::thread::sleep(Duration::from_millis(5));
            };
            assert!(accounted);
        }
    }
}
