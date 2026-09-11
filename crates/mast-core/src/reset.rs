//! 자동 UI 리셋 정책 (계획 v2 12장 "WebView 리셋 안전망").
//!
//! 모든 영속 상태(PTY 세션·레이아웃·replay buffer)가 Rust 에 있으므로 WebView 는
//! 세션 손실 없이 통째로 리로드할 수 있다. 이 모듈은 "언제 리셋해도 안전한가"만
//! 판정하는 순수 정책이다 — 시계·스레드·Tauri 무의존이며, 시간은 호출자가 넘기는
//! 단조 u64 ms 틱(원점 임의)으로만 흐른다. 실제 리로드·메모리 측정·이벤트 배선은
//! src-tauri 글루(reset supervisor)가 담당한다.
//!
//! # 트리거 3종 (계획 v2 12장 기반 — 2번은 의도적 보수화, 아래 참조)
//!
//! 1. **Idle**: 마지막 실제 사용자 입력에서 `idle_ms` 경과 시 1회 발화 후 disarm.
//!    재무장은 다음 실제 입력([`ResetPolicy::on_user_input`])뿐이다 — 리셋 후의
//!    자동 attach/resize/ack 은 물론 **stdin 기록 자체도** 입력으로 치지 않는다
//!    (글루 계약 — xterm 은 단말 질의(DA·DSR 등)에 자동 응답하는 write 를 만들고
//!    그 질의는 replay 재생에도 들어 있어, stdin 을 활동으로 치면 리셋 후 재발화
//!    자기루프가 된다. 실제 타이핑은 프론트 활동 핑이 잡는다 — 16단계 리뷰).
//! 2. **Hidden**: unfocused **또는** invisible 인 상태가 `hidden_ms` 연속되면
//!    발화 — 계획 v2 원문("최소화 또는 포커스 아웃") 그대로의 **OR** 판정이다.
//!    실기 이력: AND(둘 다 숨김)는 최소화 시 visibility 신호가 도착하지 않아
//!    미발화였고(체크포인트 1 — wry 가 최소화에서 WebView2 IsVisible 을 갱신하지
//!    않는 것으로 추정), visibility 단독도 같은 이유로 미발화였다. OR 는 두 신호
//!    중 어느 쪽이 도착해도 카운트한다. "포커스만 잃고 창이 보이는데 사용자가
//!    지켜보는 중" 우려는 활동 핑(wheel 등)의 재무장과 기본 10분 임계로 완화한다.
//!    같은 연속 숨김 구간에서는 1회만 발화하며, 완전 표시 복귀(focused && visible)
//!    또는 실제 입력이 카운트다운을 재시작한다.
//! 3. **MemWatchdog**: 메모리 샘플이 임계를 초과하면 pending 예약만 한다 (직접
//!    발화 금지). 발화는 다음 안전한 순간 — 마지막 입력에서 `safe_idle_ms` 경과
//!    ([`ResetPolicy::poll`]) 또는 워크스페이스 전환 직후
//!    ([`ResetPolicy::on_workspace_switch`]) — 에만 한다.
//!
//! # 3금지 (계획 v2 12장 원문)
//!
//! - 활성 사용 중 발화 금지 — 모든 발화 경로가 입력·표시 상태로 게이트된다.
//! - 무조건적 주기 타이머 금지 — 모든 데드라인은 상태 전이(입력·숨김·pending)에서
//!   파생된다.
//! - 워크스페이스 전환 자체는 트리거가 아니다 — 전환은 pending 워치독의 "안전한
//!   순간"일 뿐, pending 이 없으면 아무 일도 없다.
//!
//! # 공통 cooldown
//!
//! 발화 직후 `cooldown_ms` 동안 전 트리거의 발화를 억제한다. 억제된 워치독
//! pending 은 유지된다 — 이 상황은 "리셋 직후에도 임계 초과 지속 = 진짜 누수
//! 의심"을 cooldown 이 가리는 창이므로, [`ResetPolicy::suppressed`] 로 노출해
//! 글루가 loud 로그하게 한다.

/// 자동 리셋 설정. `Option` 필드의 `None` 은 해당 트리거 off.
#[derive(Debug, Clone)]
pub struct ResetConfig {
    /// 마지막 실제 입력 후 이 시간(ms) 경과 시 Idle 발화. `None` = off.
    pub idle_ms: Option<u64>,
    /// 숨김(invisible — 최소화·완전 가림)이 이 시간(ms) 연속되면 Hidden 발화.
    /// `None` = off.
    pub hidden_ms: Option<u64>,
    /// 메모리 샘플이 이 값(bytes)을 초과하면 워치독 pending. `None` = off.
    pub mem_limit_bytes: Option<u64>,
    /// 메모리 샘플 주기(ms). 워치독 on 이면 0 금지 (busy loop 방지 — 생성 시 검증).
    pub mem_poll_ms: u64,
    /// 마지막 실제 입력 후 이 시간(ms)이 지나면 워치독 발화에 안전한 순간으로 본다.
    pub safe_idle_ms: u64,
    /// 발화 후 전 트리거 공통 억제 시간(ms). 0 = cooldown 없음.
    pub cooldown_ms: u64,
}

/// 발화한 리셋의 원인 트리거. 글루가 로그·계측에 사용한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetTrigger {
    Idle,
    Hidden,
    MemWatchdog,
}

/// 자동 리셋 판정 상태 머신. 모듈 문서의 트리거·금지·cooldown 계약을 구현한다.
///
/// 호출 계약: 글루는 활동 신호(write_stdin·send_raw·dispatch·activity 핑)마다
/// [`Self::on_user_input`], 창 이벤트마다 [`Self::on_focus`]/[`Self::on_visibility`],
/// 메모리 샘플마다 [`Self::on_mem_sample`], 워크스페이스 전환 성공 직후
/// [`Self::on_workspace_switch`] 를 호출하고, [`Self::next_deadline`] 까지
/// wait_timeout 한 뒤 [`Self::poll`] 로 발화 여부를 묻는다.
pub struct ResetPolicy {
    cfg: ResetConfig,
    /// 마지막 실제 사용자 입력 시각. 생성 시각으로 초기화한다.
    last_input: u64,
    /// Idle 발화 대기 상태 — 발화 시 false, 다음 실제 입력에서 true.
    idle_armed: bool,
    /// 마지막으로 보고된 창 포커스 상태 — hidden 판정의 OR 신호 중 하나
    /// (모듈 문서 트리거 2).
    focused: bool,
    visible: bool,
    /// 현재 숨김 구간의 카운트다운 시작 시각. 표시 중이면 `None`.
    hidden_since: Option<u64>,
    /// 현재 숨김 구간에서 이미 발화했는지 (구간당 1회 제한).
    hidden_fired: bool,
    /// 워치독 예약. 임계 초과 샘플로 set, 발화 또는 임계 이하 회복 샘플로 clear.
    mem_pending: bool,
    /// 다음 메모리 샘플 예정 시각 (워치독 on 일 때만 의미).
    next_mem_sample_at: u64,
    /// 워치독 발화 시도가 cooldown 에 막힌 상태 (글루 loud 로그용).
    suppressed: bool,
    /// 발화 억제가 끝나는 시각. `None` = 아직 발화한 적 없음.
    cooldown_until: Option<u64>,
}

impl ResetPolicy {
    /// 정책을 생성한다. 앱 시작 시점을 활동 기준선으로 삼고(입력 없이 `idle_ms`
    /// 경과하면 발화), 창은 표시 상태로 가정한다 (실제 상태는 곧 이벤트로 동기화).
    ///
    /// 워치독 on 인데 `mem_poll_ms == 0` 이면 다음 샘플 시각이 항상 현재가 되어
    /// supervisor 가 busy loop 에 빠지는 설정 오류이므로 즉시 실패시킨다.
    pub fn new(cfg: ResetConfig, now: u64) -> Self {
        assert!(
            cfg.mem_limit_bytes.is_none() || cfg.mem_poll_ms > 0,
            "mem_poll_ms must be > 0 when the mem watchdog is enabled"
        );
        let next_mem_sample_at = now.saturating_add(cfg.mem_poll_ms);
        Self {
            cfg,
            last_input: now,
            idle_armed: true,
            focused: true,
            visible: true,
            hidden_since: None,
            hidden_fired: false,
            mem_pending: false,
            next_mem_sample_at,
            suppressed: false,
            cooldown_until: None,
        }
    }

    /// 실제 사용자 입력(타이핑·붙여넣기·dispatch·throttled 활동 핑). idle 과
    /// hidden 대기를 **모두** 재무장한다 — 숨김 카운트다운도 현재 시각에서
    /// 재시작하므로, invisible 보고가 잘못 남아 있는 상태에서 타이핑 중이어도
    /// hidden 이 발화할 수 없다.
    pub fn on_user_input(&mut self, now: u64) {
        self.last_input = now;
        self.idle_armed = true;
        if self.hidden_since.is_some() {
            self.hidden_since = Some(now);
            self.hidden_fired = false;
        }
    }

    /// 창 포커스 변화 보고 — hidden 판정의 OR 신호 중 하나 (모듈 문서 트리거 2).
    /// 포커스 이벤트는 활동이 아니므로 idle 타이머는 건드리지 않는다.
    pub fn on_focus(&mut self, focused: bool, now: u64) {
        self.focused = focused;
        self.sync_hidden(now);
    }

    /// 프론트 visibility 변화 (`document.visibilitychange`) — hidden 판정의 OR
    /// 신호 중 하나. visibility 이벤트는 활동이 아니므로 idle 타이머는 건드리지
    /// 않는다.
    pub fn on_visibility(&mut self, visible: bool, now: u64) {
        self.visible = visible;
        self.sync_hidden(now);
    }

    /// focus·visibility 상태로 숨김 구간의 시작/종료 전이를 반영한다 —
    /// unfocused **또는** invisible 이면 숨김 (계획 v2 원문 OR, 모듈 문서 트리거 2).
    fn sync_hidden(&mut self, now: u64) {
        let hidden = !self.visible || !self.focused;
        match (hidden, self.hidden_since) {
            (true, None) => {
                // 표시 → 숨김 전이: 카운트다운 시작.
                self.hidden_since = Some(now);
                self.hidden_fired = false;
            }
            (false, Some(_)) => {
                // 숨김 → 표시 전이: 구간 종료. 다음 숨김은 새 구간으로 센다.
                self.hidden_since = None;
                self.hidden_fired = false;
            }
            // 전이가 아니면 기존 카운트다운을 유지한다 (같은 방향 중복 이벤트 무해).
            _ => {}
        }
    }

    /// WebView 프로세스 메모리 샘플. 임계 초과면 pending 예약만 하고 절대 직접
    /// 발화하지 않는다. 임계 이하로 회복된 샘플은 pending 을 해제한다 — 이
    /// 트리거는 실제 메모리 압력에 반응하므로 압력이 사라지면 리셋할 이유도
    /// 사라진다 (다시 초과하면 다음 샘플이 재예약한다).
    pub fn on_mem_sample(&mut self, bytes: u64, now: u64) {
        let Some(limit) = self.cfg.mem_limit_bytes else {
            return; // 워치독 off — 샘플 무시.
        };
        self.next_mem_sample_at = now.saturating_add(self.cfg.mem_poll_ms);
        if bytes > limit {
            self.mem_pending = true;
        } else {
            self.mem_pending = false;
            self.suppressed = false;
        }
    }

    /// 워크스페이스 전환 성공 직후 호출. 전환 자체는 트리거가 아니고, pending
    /// 워치독이 있을 때만 그 "안전한 순간"으로서 즉시 발화한다 (safe_idle 경과
    /// 여부와 무관 — 글루가 dispatch 를 활동으로도 취급해 `on_user_input` 을 같이
    /// 호출하더라도 성립). cooldown 중이면 억제하고 [`Self::suppressed`] 로
    /// 표출한다.
    #[must_use]
    pub fn on_workspace_switch(&mut self, now: u64) -> Option<ResetTrigger> {
        if !self.mem_pending {
            return None;
        }
        if self.in_cooldown(now) {
            self.suppressed = true;
            return None;
        }
        Some(self.fire_mem(now))
    }

    /// supervisor 의 다음 기상 시각 — 아래 후보들의 최솟값. 후보가 없으면 `None`
    /// (모든 트리거 off 또는 대기 중인 데드라인 없음).
    ///
    /// - Idle 만료 (`last_input + idle_ms`, armed 일 때)
    /// - Hidden 만료 (`hidden_since + hidden_ms`, 숨김 구간·미발화일 때)
    /// - 워치독 safe 도달 (`last_input + safe_idle_ms`, pending 일 때)
    /// - 다음 메모리 샘플 시각 (워치독 on 일 때)
    ///
    /// 발화 데드라인은 cooldown 중이면 cooldown 종료 시각으로 clamp 한다 (그 전엔
    /// 발화 불가 — 불필요한 조기 기상 방지). 샘플 시각만은 clamp 하지 않는다 —
    /// cooldown 중에도 샘플링은 계속되어야 pending 상태가 갱신된다. 반환값이
    /// `now` 이전일 수 있다 (이미 도래한 데드라인 — 즉시 `poll` 하라는 뜻).
    #[must_use]
    pub fn next_deadline(&self, now: u64) -> Option<u64> {
        let clamp = |t: u64| match self.cooldown_until {
            Some(until) if now < until => t.max(until),
            _ => t,
        };
        let mut best: Option<u64> = None;
        let mut consider = |t: u64| best = Some(best.map_or(t, |b| b.min(t)));

        if let Some(idle_ms) = self.cfg.idle_ms {
            if self.idle_armed {
                consider(clamp(self.last_input.saturating_add(idle_ms)));
            }
        }
        if let Some(hidden_ms) = self.cfg.hidden_ms {
            if let Some(since) = self.hidden_since {
                if !self.hidden_fired {
                    consider(clamp(since.saturating_add(hidden_ms)));
                }
            }
        }
        if self.cfg.mem_limit_bytes.is_some() {
            if self.mem_pending {
                consider(clamp(self.last_input.saturating_add(self.cfg.safe_idle_ms)));
            }
            consider(self.next_mem_sample_at);
        }
        best
    }

    /// 현재 시각 기준 발화 판정. 호출당 최대 1개 트리거를 반환하고 cooldown 을
    /// 시작한다.
    ///
    /// 우선순위는 MemWatchdog > Idle > Hidden — 워치독은 실제 메모리 압력에
    /// 반응하는 가장 중요한 트리거이고, 먼저 발화해야 pending 이 남아 cooldown
    /// 억제(suppressed)로 오인 표출되는 잡음을 피한다. 발화는 `last_input` 을
    /// 건드리지 않는다 — 리셋 후 자동 동작이 idle 을 재무장하는 자기루프 차단은
    /// "무엇을 입력으로 치는가"(글루 계약)에서 성립한다.
    #[must_use]
    pub fn poll(&mut self, now: u64) -> Option<ResetTrigger> {
        // 1) MemWatchdog: pending 이고 safe_idle 경과 시.
        if self.mem_pending && now >= self.last_input.saturating_add(self.cfg.safe_idle_ms) {
            if self.in_cooldown(now) {
                self.suppressed = true;
            } else {
                return Some(self.fire_mem(now));
            }
        }
        // 2) Idle: armed 이고 idle_ms 경과 시 1회 발화 후 disarm. cooldown 에
        //    막히면 armed 를 유지해 cooldown 종료 후 발화한다.
        if let Some(idle_ms) = self.cfg.idle_ms {
            if self.idle_armed
                && now >= self.last_input.saturating_add(idle_ms)
                && !self.in_cooldown(now)
            {
                self.idle_armed = false;
                self.start_cooldown(now);
                return Some(ResetTrigger::Idle);
            }
        }
        // 3) Hidden: 숨김 구간이 hidden_ms 연속되면 구간당 1회 발화.
        if let Some(hidden_ms) = self.cfg.hidden_ms {
            if let Some(since) = self.hidden_since {
                if !self.hidden_fired
                    && now >= since.saturating_add(hidden_ms)
                    && !self.in_cooldown(now)
                {
                    self.hidden_fired = true;
                    self.start_cooldown(now);
                    return Some(ResetTrigger::Hidden);
                }
            }
        }
        None
    }

    /// 워치독 발화 시도가 cooldown 에 막혀 있는지. true 는 "리셋 직후에도 임계
    /// 초과가 지속된다"는 뜻이므로(진짜 누수 의심) 글루가 loud 로그해야 한다.
    /// 실제 발화 또는 임계 이하 회복 샘플로 해제된다.
    pub fn suppressed(&self) -> bool {
        self.suppressed
    }

    /// 워치독 pending 여부 (글루 로그·계측용).
    pub fn mem_pending(&self) -> bool {
        self.mem_pending
    }

    /// 워치독 발화 — pending·suppressed 를 해제하고 cooldown 을 시작한다.
    fn fire_mem(&mut self, now: u64) -> ResetTrigger {
        self.mem_pending = false;
        self.suppressed = false;
        self.start_cooldown(now);
        ResetTrigger::MemWatchdog
    }

    fn start_cooldown(&mut self, now: u64) {
        self.cooldown_until = Some(now.saturating_add(self.cfg.cooldown_ms));
    }

    fn in_cooldown(&self, now: u64) -> bool {
        self.cooldown_until.is_some_and(|until| now < until)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 기본 테스트 설정 — cooldown 0 으로 트리거 의미론을 격리한다.
    fn cfg() -> ResetConfig {
        ResetConfig {
            idle_ms: Some(1_000),
            hidden_ms: Some(500),
            mem_limit_bytes: Some(1_000_000),
            mem_poll_ms: 100,
            safe_idle_ms: 200,
            cooldown_ms: 0,
        }
    }

    fn idle_only() -> ResetConfig {
        ResetConfig {
            hidden_ms: None,
            mem_limit_bytes: None,
            ..cfg()
        }
    }

    fn hidden_only() -> ResetConfig {
        ResetConfig {
            idle_ms: None,
            mem_limit_bytes: None,
            ..cfg()
        }
    }

    fn mem_only() -> ResetConfig {
        ResetConfig {
            idle_ms: None,
            hidden_ms: None,
            ..cfg()
        }
    }

    // ---- Idle ----

    #[test]
    fn idle_fires_once_then_disarms_until_next_input() {
        let mut p = ResetPolicy::new(idle_only(), 0);
        assert_eq!(p.poll(999), None);
        // 경계값: 도달 시점에 발화.
        assert_eq!(p.poll(1_000), Some(ResetTrigger::Idle));
        // disarm — 시간이 더 지나도 재발화 없음 (재무장은 다음 실제 입력뿐).
        assert_eq!(p.poll(50_000), None);
        p.on_user_input(60_000);
        assert_eq!(p.poll(60_999), None);
        assert_eq!(p.poll(61_000), Some(ResetTrigger::Idle));
    }

    #[test]
    fn idle_never_fires_while_active() {
        // 활동(타이핑·throttled 핑)이 idle_ms 안에 계속 들어오면 절대 발화하지 않는다.
        let mut p = ResetPolicy::new(idle_only(), 0);
        for i in 1..=20u64 {
            let t = i * 500;
            p.on_user_input(t);
            assert_eq!(p.poll(t + 499), None);
        }
    }

    #[test]
    fn idle_stays_disarmed_without_input_despite_time_and_polls() {
        // 회귀(실기): idle 리셋이 입력 없이 30초마다 반복 발화했다 — 원인은
        // 글루가 visibility 보고를 user_input 으로 집계한 것. 정책 자체는 발화
        // 후 disarm 상태에서 어떤 시간 경과·poll 반복에도 재발화하면 안 된다.
        let mut p = ResetPolicy::new(idle_only(), 0);
        assert_eq!(p.poll(1_000), Some(ResetTrigger::Idle));
        // idle_ms 간격으로 idle_ms×10 까지 반복 poll — 전부 미발화.
        for i in 1..=10u64 {
            let t = 1_000 + i * 1_000;
            assert_eq!(p.poll(t), None, "idle refired at t={t} without input");
            // disarm 중에는 대기할 idle 데드라인 자체가 없어야 한다.
            assert_eq!(p.next_deadline(t), None);
        }
    }

    #[test]
    fn idle_not_rearmed_by_visibility_or_focus_events() {
        // visibility·focus 이벤트는 활동이 아니다 — disarm 된 idle 을 재무장하면
        // 안 된다 (재무장은 on_user_input 뿐).
        let mut p = ResetPolicy::new(idle_only(), 0);
        assert_eq!(p.poll(1_000), Some(ResetTrigger::Idle));
        for i in 0..5u64 {
            let t = 2_000 + i * 2_000;
            p.on_visibility(false, t);
            p.on_focus(false, t);
            p.on_visibility(true, t + 1_000);
            p.on_focus(true, t + 1_000);
            assert_eq!(p.poll(t + 1_999), None, "idle refired after window events");
        }
        assert_eq!(p.poll(60_000), None);
        assert_eq!(p.next_deadline(60_000), None);
    }

    // ---- Hidden ----

    #[test]
    fn hidden_counts_on_either_focus_loss_or_invisibility() {
        // OR 판정 (계획 v2 원문): 포커스 상실 단독으로도 카운트한다 — 실기에서
        // 최소화 시 visibility 신호가 도착하지 않는 환경의 커버리지.
        let mut p = ResetPolicy::new(hidden_only(), 0);
        p.on_focus(false, 0);
        assert_eq!(p.poll(499), None);
        assert_eq!(p.poll(500), Some(ResetTrigger::Hidden));

        // 완전 표시 복귀(focused && visible)만 구간을 종료한다.
        let mut p = ResetPolicy::new(hidden_only(), 0);
        p.on_focus(false, 0);
        p.on_visibility(false, 100);
        p.on_focus(true, 200); // 아직 invisible — 구간 유지 (시작 시각 0 유지)
        assert_eq!(p.poll(499), None);
        assert_eq!(p.poll(500), Some(ResetTrigger::Hidden));
    }

    #[test]
    fn hidden_fires_after_minimize_without_any_focus_event() {
        // 실기 시나리오: 최소화 시 visibilitychange(false)만 오고 Focused(false)
        // 는 오지 않는다 — visibility 단독으로 발화해야 한다.
        let mut p = ResetPolicy::new(hidden_only(), 0);
        p.on_visibility(false, 0);
        assert_eq!(p.poll(499), None);
        assert_eq!(p.poll(500), Some(ResetTrigger::Hidden));
    }

    #[test]
    fn hidden_rearms_on_show_transition() {
        let mut p = ResetPolicy::new(hidden_only(), 0);
        p.on_visibility(false, 0);
        // 만료 전에 표시로 복귀 → 구간 종료.
        p.on_visibility(true, 400);
        assert_eq!(p.poll(10_000), None);
        // 다시 숨김 → 새 구간으로 처음부터 센다.
        p.on_visibility(false, 10_000);
        assert_eq!(p.poll(10_499), None);
        assert_eq!(p.poll(10_500), Some(ResetTrigger::Hidden));
    }

    #[test]
    fn hidden_rearms_on_user_input_while_hidden() {
        // invisible 보고가 남은 채 타이핑하는 시나리오 — 입력이 숨김 카운트다운을
        // 재시작한다.
        let mut p = ResetPolicy::new(hidden_only(), 0);
        p.on_visibility(false, 0);
        p.on_user_input(300);
        assert_eq!(p.poll(500), None); // 원래 만료 시각(0+500)에는 미발화
        assert_eq!(p.poll(799), None);
        assert_eq!(p.poll(800), Some(ResetTrigger::Hidden)); // 300+500
    }

    #[test]
    fn hidden_fires_once_per_stretch() {
        let mut p = ResetPolicy::new(hidden_only(), 0);
        p.on_visibility(false, 0);
        assert_eq!(p.poll(500), Some(ResetTrigger::Hidden));
        // 같은 숨김 구간이 계속되는 동안은 재발화 없음 (cooldown 0 이어도).
        assert_eq!(p.poll(100_000), None);
        // 표시 복귀 후 다시 숨김 → 새 구간에서 다시 발화 가능.
        p.on_visibility(true, 100_000);
        p.on_visibility(false, 100_000);
        assert_eq!(p.poll(100_500), Some(ResetTrigger::Hidden));
    }

    #[test]
    fn duplicate_hide_events_keep_countdown() {
        // 같은 방향 중복 이벤트가 카운트다운을 리셋하면 안 된다.
        let mut p = ResetPolicy::new(hidden_only(), 0);
        p.on_visibility(false, 0);
        p.on_visibility(false, 400); // 중복 — 시작 시각 0 유지
        assert_eq!(p.poll(500), Some(ResetTrigger::Hidden));
    }

    // ---- MemWatchdog ----

    #[test]
    fn mem_sample_never_fires_directly_and_fires_at_safe_idle() {
        let mut p = ResetPolicy::new(mem_only(), 0);
        p.on_user_input(50);
        p.on_mem_sample(1_000_001, 100); // 초과 → pending
        assert!(p.mem_pending());
        assert_eq!(p.poll(100), None); // 직접 발화 금지
        p.on_user_input(150); // 사용 계속 — safe 아님
        assert_eq!(p.poll(349), None); // 150+200 미도달
        assert_eq!(p.poll(350), Some(ResetTrigger::MemWatchdog));
        assert!(!p.mem_pending());
        assert_eq!(p.poll(10_000), None); // pending 소진 — 재발화 없음
    }

    #[test]
    fn mem_sample_at_limit_is_not_over() {
        // 경계값: 임계 "초과"만 pending — 정확히 임계값이면 아니다.
        let mut p = ResetPolicy::new(mem_only(), 0);
        p.on_mem_sample(1_000_000, 100);
        assert!(!p.mem_pending());
        assert_eq!(p.poll(10_000), None);
        p.on_mem_sample(1_000_001, 200);
        assert!(p.mem_pending());
    }

    #[test]
    fn mem_recovery_clears_pending() {
        let mut p = ResetPolicy::new(mem_only(), 0);
        p.on_mem_sample(2_000_000, 100);
        assert!(p.mem_pending());
        // 임계 이하로 회복 → 예약 해제, 이후 safe 순간에도 미발화.
        p.on_mem_sample(500_000, 200);
        assert!(!p.mem_pending());
        assert_eq!(p.poll(10_000), None);
        assert_eq!(p.on_workspace_switch(10_000), None);
    }

    #[test]
    fn workspace_switch_fires_pending_immediately() {
        let mut p = ResetPolicy::new(mem_only(), 0);
        p.on_mem_sample(2_000_000, 100);
        // 방금 입력이 있어 safe_idle 미경과여도 전환 직후는 안전한 순간이다.
        p.on_user_input(150);
        assert_eq!(p.on_workspace_switch(160), Some(ResetTrigger::MemWatchdog));
        assert!(!p.mem_pending());
    }

    #[test]
    fn workspace_switch_without_pending_is_not_a_trigger() {
        let mut p = ResetPolicy::new(mem_only(), 0);
        assert_eq!(p.on_workspace_switch(100), None);
        assert_eq!(p.poll(10_000), None);
    }

    #[test]
    fn mem_fires_before_idle_and_idle_stays_armed() {
        // 동시 도래 시 우선순위: MemWatchdog > Idle. idle 은 armed 유지.
        let mut p = ResetPolicy::new(
            ResetConfig {
                idle_ms: Some(100),
                hidden_ms: None,
                mem_limit_bytes: Some(100),
                mem_poll_ms: 50,
                safe_idle_ms: 100,
                cooldown_ms: 0,
            },
            0,
        );
        p.on_mem_sample(101, 50);
        // now=100 은 idle 만료(0+100)이자 safe 도달(0+100) — 워치독이 우선.
        assert_eq!(p.poll(100), Some(ResetTrigger::MemWatchdog));
        // cooldown 0 이므로 idle 은 곧바로 이어서 발화한다 (armed 유지 확인).
        assert_eq!(p.poll(100), Some(ResetTrigger::Idle));
    }

    // ---- cooldown ----

    #[test]
    fn cooldown_suppresses_watchdog_and_exposes_it() {
        let mut p = ResetPolicy::new(
            ResetConfig {
                cooldown_ms: 10_000,
                ..cfg()
            },
            0,
        );
        assert_eq!(p.poll(1_000), Some(ResetTrigger::Idle)); // cooldown → 11_000
        p.on_mem_sample(2_000_000, 1_100); // pending
        assert!(!p.suppressed()); // 아직 발화 시도 전
                                  // safe 도달(0+200)했지만 cooldown 에 막힘 → 억제 + 표출.
        assert_eq!(p.poll(1_200), None);
        assert!(p.suppressed());
        // 전환 직후도 cooldown 중엔 억제.
        assert_eq!(p.on_workspace_switch(1_300), None);
        assert!(p.suppressed());
        assert!(p.mem_pending()); // 억제된 pending 은 유지
                                  // cooldown 종료 후 발화·해제.
        assert_eq!(p.poll(11_000), Some(ResetTrigger::MemWatchdog));
        assert!(!p.suppressed());
    }

    #[test]
    fn cooldown_blocks_other_triggers_without_suppressed_flag() {
        let mut p = ResetPolicy::new(
            ResetConfig {
                idle_ms: Some(1_000),
                hidden_ms: Some(100),
                mem_limit_bytes: None,
                mem_poll_ms: 100,
                safe_idle_ms: 200,
                cooldown_ms: 5_000,
            },
            0,
        );
        p.on_visibility(false, 0);
        assert_eq!(p.poll(100), Some(ResetTrigger::Hidden)); // cooldown → 5_100
                                                             // idle 만료(1_000)가 cooldown 안 — 억제되지만 suppressed 는 워치독 전용.
        assert_eq!(p.poll(1_000), None);
        assert!(!p.suppressed());
        // idle 은 armed 유지 → cooldown 종료 후 발화.
        assert_eq!(p.poll(5_100), Some(ResetTrigger::Idle));
    }

    // ---- 트리거별 off ----

    #[test]
    fn disabled_triggers_never_fire() {
        let mut p = ResetPolicy::new(
            ResetConfig {
                idle_ms: None,
                hidden_ms: None,
                mem_limit_bytes: None,
                mem_poll_ms: 100,
                safe_idle_ms: 0,
                cooldown_ms: 0,
            },
            0,
        );
        p.on_focus(false, 0);
        p.on_visibility(false, 0);
        p.on_mem_sample(u64::MAX, 10); // 워치독 off — 무시
        assert!(!p.mem_pending());
        assert_eq!(p.poll(u64::MAX), None);
        assert_eq!(p.on_workspace_switch(20), None);
        assert_eq!(p.next_deadline(30), None);
    }

    #[test]
    #[should_panic(expected = "mem_poll_ms")]
    fn mem_watchdog_with_zero_poll_is_rejected() {
        // 설정 오류는 조용히 넘어가지 않고 즉시 실패시킨다.
        let _ = ResetPolicy::new(
            ResetConfig {
                mem_poll_ms: 0,
                ..cfg()
            },
            0,
        );
    }

    // ---- next_deadline ----

    #[test]
    fn next_deadline_takes_minimum_of_candidates() {
        let mut p = ResetPolicy::new(cfg(), 0);
        // 초기: idle 만료 1_000 vs 다음 샘플 100 → 100.
        assert_eq!(p.next_deadline(0), Some(100));
        p.on_mem_sample(0, 100); // 다음 샘플 200
        assert_eq!(p.next_deadline(100), Some(200));
        // 숨김 시작(만료 620)·pending(safe 도달 0+200=200) 추가.
        p.on_visibility(false, 120);
        p.on_mem_sample(2_000_000, 200); // pending, 다음 샘플 300
                                         // 이미 지난 데드라인(200)도 그대로 반환 — 즉시 poll 하라는 신호.
        assert_eq!(p.next_deadline(210), Some(200));
    }

    #[test]
    fn next_deadline_reflects_idle_disarm_and_rearm() {
        let mut p = ResetPolicy::new(idle_only(), 0);
        assert_eq!(p.next_deadline(0), Some(1_000));
        assert_eq!(p.poll(1_000), Some(ResetTrigger::Idle));
        // disarm 중에는 대기할 데드라인이 없다.
        assert_eq!(p.next_deadline(1_500), None);
        p.on_user_input(2_000);
        assert_eq!(p.next_deadline(2_000), Some(3_000));
    }

    #[test]
    fn next_deadline_excludes_fired_hidden_stretch() {
        let mut p = ResetPolicy::new(hidden_only(), 0);
        p.on_visibility(false, 0);
        assert_eq!(p.next_deadline(0), Some(500));
        assert_eq!(p.poll(500), Some(ResetTrigger::Hidden));
        // 구간 내 발화 완료 — 표시 복귀 전까지 데드라인 없음.
        assert_eq!(p.next_deadline(600), None);
    }

    #[test]
    fn next_deadline_clamps_firing_deadlines_to_cooldown_end() {
        let mut p = ResetPolicy::new(
            ResetConfig {
                cooldown_ms: 5_000,
                ..idle_only()
            },
            0,
        );
        assert_eq!(p.poll(1_000), Some(ResetTrigger::Idle)); // cooldown → 6_000
        p.on_user_input(1_100); // 재무장 — 원 데드라인 2_100
                                // cooldown 종료 전엔 발화 불가이므로 6_000 으로 clamp.
        assert_eq!(p.next_deadline(1_200), Some(6_000));
        // cooldown 이 끝난 시점에는 원 데드라인(이미 과거)이 그대로 나온다.
        assert_eq!(p.next_deadline(6_000), Some(2_100));
        assert_eq!(p.poll(6_000), Some(ResetTrigger::Idle));
    }

    #[test]
    fn next_deadline_does_not_clamp_mem_sample_time() {
        let mut p = ResetPolicy::new(
            ResetConfig {
                mem_poll_ms: 1_000,
                safe_idle_ms: 0,
                cooldown_ms: 10_000,
                ..mem_only()
            },
            0,
        );
        p.on_mem_sample(2_000_000, 500); // pending, 다음 샘플 1_500
        assert_eq!(p.poll(500), Some(ResetTrigger::MemWatchdog)); // cooldown → 10_500
                                                                  // 샘플링은 cooldown 중에도 계속 — 샘플 시각은 clamp 되지 않는다.
        assert_eq!(p.next_deadline(600), Some(1_500));
    }
}
