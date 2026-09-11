//! Flow control(backpressure) 상태 머신.
//!
//! 프론트엔드로 보냈지만 아직 소비(ack)되지 않은 바이트 수(pending)를 추적해
//! PTY 읽기를 멈출지(Pause)/재개할지(Resume) 결정한다. 판단만 하는 순수 상태
//! 머신이며 실제 읽기 중단은 세션 리더 스레드가 수행한다.
//!
//! # 계약
//!
//! - `on_sent(n)`: pending += n. paused 가 아닌 상태에서 pending ≥ high_water 에
//!   도달하는 순간 정확히 한 번 `Pause` 를 지시한다. 이미 paused 면 (리더가 멈추기
//!   전의 잔여 전송이 있어도) `None`.
//! - `on_acked(n)`: pending -= n (saturating — 초과 ack 이 와도 0 밑으로 내려가지
//!   않는다). paused 상태에서 pending ≤ low_water 에 도달하는 순간 정확히 한 번
//!   `Resume`.
//! - `reset()`: reattach 시 계정 재시작 (pending = 0, paused = false). 상세는 해당
//!   rustdoc 참조.
//! - 경계: high == low 는 유효, low > high 는 Resume 이 불가능한 설정 오류라 생성
//!   시 즉시 panic.

/// `on_sent`/`on_acked` 가 호출자에게 지시하는 동작.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowAction {
    None,
    Pause,
    Resume,
}

pub struct FlowControl {
    high_water: usize,
    low_water: usize,
    /// 보냈지만 아직 ack 되지 않은 바이트 수.
    pending: usize,
    paused: bool,
}

impl FlowControl {
    /// Spike 기본값은 호출자(session)에서 high 2MB / low 512KB.
    /// low > high 는 Resume 이 불가능한 설정 오류이므로 즉시 실패시킨다.
    pub fn new(high_water: usize, low_water: usize) -> Self {
        assert!(
            low_water <= high_water,
            "low_water ({low_water}) must be <= high_water ({high_water})"
        );
        Self {
            high_water,
            low_water,
            pending: 0,
            paused: false,
        }
    }

    /// 프론트로 n bytes 를 보냈다. pending ≥ high 가 되는 순간 한 번만 `Pause`.
    /// 이미 paused 면 (리더가 멈추기 전 잔여 전송이 있어도) `None`.
    pub fn on_sent(&mut self, n: usize) -> FlowAction {
        self.pending = self.pending.saturating_add(n);
        if !self.paused && self.pending >= self.high_water {
            self.paused = true;
            FlowAction::Pause
        } else {
            FlowAction::None
        }
    }

    /// 프론트가 n bytes 소비를 완료했다. paused 상태에서 pending ≤ low 가 되는
    /// 순간 한 번만 `Resume`. 초과 ack 이 와도 pending 은 0 밑으로 내려가지
    /// 않는다(saturating).
    pub fn on_acked(&mut self, n: usize) -> FlowAction {
        self.pending = self.pending.saturating_sub(n);
        if self.paused && self.pending <= self.low_water {
            self.paused = false;
            FlowAction::Resume
        } else {
            FlowAction::None
        }
    }

    /// flow 계정을 초기 상태로 되돌린다 (pending = 0, paused = false).
    ///
    /// reattach(프론트 재접속) 시 호출된다 — 이전 채널로 보냈던 미ack 바이트는
    /// 새 프론트가 replay 스냅샷으로 다시 받으므로, 계정을 0 에서 새로 시작해야
    /// 스냅샷 이후의 전송·ack 만 대칭으로 계상된다.
    ///
    /// 리셋 직후 구채널의 잔여 ack 이 뒤늦게 도착해도 무해하다: `on_acked` 의
    /// saturating_sub 가 pending 을 0 밑으로 내리지 않으므로 계정이 언더플로로
    /// 붕괴하는 일이 없고, 최악의 경우에도 새 에폭의 pending 을 일회성으로 조금
    /// 일찍 줄여 Resume 이 앞당겨질 뿐 영구적인 누수·정지는 생기지 않는다.
    pub fn reset(&mut self) {
        self.pending = 0;
        self.paused = false;
    }

    pub fn pending(&self) -> usize {
        self.pending
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn below_high_water_no_action() {
        let mut fc = FlowControl::new(100, 20);
        assert_eq!(fc.on_sent(99), FlowAction::None);
        assert!(!fc.is_paused());
        assert_eq!(fc.pending(), 99);
    }

    #[test]
    fn exactly_high_water_pauses() {
        // 경계값: pending == high 에서 Pause (초과가 아니라 도달 기준).
        let mut fc = FlowControl::new(100, 20);
        assert_eq!(fc.on_sent(100), FlowAction::Pause);
        assert!(fc.is_paused());
    }

    #[test]
    fn no_duplicate_pause_while_paused() {
        let mut fc = FlowControl::new(100, 20);
        assert_eq!(fc.on_sent(150), FlowAction::Pause);
        // 리더가 멈추기 전 잔여 전송 — 이미 paused 이므로 None.
        assert_eq!(fc.on_sent(50), FlowAction::None);
        assert!(fc.is_paused());
        assert_eq!(fc.pending(), 200);
    }

    #[test]
    fn exactly_low_water_resumes() {
        // 경계값: pending == low 에서 Resume (미만이 아니라 도달 기준).
        let mut fc = FlowControl::new(100, 20);
        fc.on_sent(100);
        assert_eq!(fc.on_acked(79), FlowAction::None); // pending 21 > low
        assert_eq!(fc.on_acked(1), FlowAction::Resume); // pending 20 == low
        assert!(!fc.is_paused());
    }

    #[test]
    fn no_resume_when_not_paused() {
        let mut fc = FlowControl::new(100, 20);
        fc.on_sent(50);
        // paused 가 아니면 pending ≤ low 여도 Resume 을 내지 않는다.
        assert_eq!(fc.on_acked(40), FlowAction::None);
        assert_eq!(fc.pending(), 10);
    }

    #[test]
    fn no_duplicate_resume_after_resume() {
        let mut fc = FlowControl::new(100, 20);
        fc.on_sent(100);
        assert_eq!(fc.on_acked(90), FlowAction::Resume);
        assert_eq!(fc.on_acked(5), FlowAction::None);
        assert_eq!(fc.pending(), 5);
    }

    #[test]
    fn over_ack_saturates_at_zero() {
        // ack 초과 — pending 이 음수로 내려가지 않고 0 에서 멈춘다.
        let mut fc = FlowControl::new(100, 20);
        fc.on_sent(50);
        assert_eq!(fc.on_acked(200), FlowAction::None); // not paused → None
        assert_eq!(fc.pending(), 0);
    }

    #[test]
    fn over_ack_while_paused_resumes_once() {
        let mut fc = FlowControl::new(100, 20);
        fc.on_sent(100);
        assert_eq!(fc.on_acked(500), FlowAction::Resume);
        assert_eq!(fc.pending(), 0);
        assert_eq!(fc.on_acked(10), FlowAction::None);
    }

    #[test]
    fn pause_resume_cycle_repeats() {
        // Resume 후 다시 high 에 도달하면 다시 Pause — 상태 머신이 순환한다.
        let mut fc = FlowControl::new(100, 20);
        assert_eq!(fc.on_sent(100), FlowAction::Pause);
        assert_eq!(fc.on_acked(80), FlowAction::Resume);
        assert_eq!(fc.on_sent(80), FlowAction::Pause); // pending 100
        assert!(fc.is_paused());
        assert_eq!(fc.on_acked(100), FlowAction::Resume);
        assert_eq!(fc.pending(), 0);
    }

    #[test]
    fn pending_accumulates_across_sends() {
        let mut fc = FlowControl::new(1000, 100);
        fc.on_sent(300);
        fc.on_sent(300);
        assert_eq!(fc.pending(), 600);
        fc.on_acked(100);
        assert_eq!(fc.pending(), 500);
    }

    #[test]
    #[should_panic(expected = "low_water")]
    fn low_above_high_is_rejected() {
        // 설정 오류는 조용히 넘어가지 않고 즉시 실패시킨다.
        let _ = FlowControl::new(100, 200);
    }

    #[test]
    fn reset_clears_pending_and_paused() {
        let mut fc = FlowControl::new(100, 20);
        assert_eq!(fc.on_sent(150), FlowAction::Pause);
        fc.reset();
        assert_eq!(fc.pending(), 0);
        assert!(!fc.is_paused());
        // 리셋 후에도 상태 머신은 처음처럼 다시 순환한다.
        assert_eq!(fc.on_sent(100), FlowAction::Pause);
    }

    #[test]
    fn stale_ack_after_reset_is_harmless() {
        let mut fc = FlowControl::new(100, 20);
        fc.on_sent(150);
        fc.reset();
        // 구채널 잔여 ack — saturating 으로 0 에 머문다 (paused 아님 → None).
        assert_eq!(fc.on_acked(150), FlowAction::None);
        assert_eq!(fc.pending(), 0);
        assert!(!fc.is_paused());
    }

    #[test]
    fn equal_high_and_low_allowed() {
        // high == low 도 유효 — high 도달 시 Pause, 같은 값 이하로 ack 시 Resume.
        let mut fc = FlowControl::new(50, 50);
        assert_eq!(fc.on_sent(50), FlowAction::Pause);
        assert_eq!(fc.on_acked(0), FlowAction::Resume); // pending 50 == low
    }
}
