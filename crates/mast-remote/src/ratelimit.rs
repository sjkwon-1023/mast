//! 소스 IP 단위 인증 실패 카운터.
//!
//! ADR-0016 결정 4의 처방: 한 IP 의 인증 실패가 60초 창 안에서 10회를 넘으면 그 IP 의 **모든**
//! 요청을(정적 자산 포함) 60초 동안 429 로 돌려보낸다. 항목은 256개까지만 들고, 넘치면
//! 가장 오래 안 보인 항목을 버린다.
//!
//! `now` 를 인자로 받는 이유는 테스트다 — 창이 닫히는 순간·만료 직후를 실제로 60초 기다리지
//! 않고 확인하려면 시계가 밖에서 들어와야 한다. 서버는 `Instant::now()` 를 넣는다.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

/// 실패를 세는 창의 길이이자, 차단이 유지되는 길이.
const WINDOW: Duration = Duration::from_secs(60);
/// 창 안에서 허용하는 인증 실패 횟수. 이 수를 **넘는** 실패(11번째)가 차단을 건다.
const MAX_FAILURES: usize = 10;
/// 기본 항목 상한.
pub(crate) const DEFAULT_CAP: usize = 256;

struct Entry {
    /// 창 안에 남아 있는 실패 시각들.
    failures: Vec<Instant>,
    blocked_until: Option<Instant>,
    /// 항목이 넘칠 때 무엇을 버릴지 정하는 기준.
    last_seen: Instant,
}

pub(crate) struct RateLimiter {
    cap: usize,
    entries: HashMap<IpAddr, Entry>,
}

impl RateLimiter {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            entries: HashMap::new(),
        }
    }

    /// 이 IP 의 요청을 처리해도 되는가. 차단 중이면 false (서버는 429 + `Retry-After: 60`).
    ///
    /// **모르는 IP 에 항목을 만들지 않는다.** 요청만으로 항목이 생기면 여러 IP 에서 오는
    /// 평범한 트래픽이 상한을 채워 실제 차단 기록을 밀어낸다 — 차단을 지우는 가장 싼 방법이
    /// 되어서는 안 된다.
    pub(crate) fn check(&mut self, ip: IpAddr, now: Instant) -> bool {
        let Some(entry) = self.entries.get_mut(&ip) else {
            return true;
        };
        entry.last_seen = now;
        match entry.blocked_until {
            Some(until) if now < until => false,
            Some(_) => {
                entry.blocked_until = None;
                true
            }
            None => true,
        }
    }

    /// 인증 실패를 기록한다. 반환값은 **이 실패로 차단이 걸렸는가** — 서버는 true 면 이
    /// 요청부터 401 대신 429 로 답한다.
    pub(crate) fn record_failure(&mut self, ip: IpAddr, now: Instant) -> bool {
        // 이미 항목이 있는 IP 는 자리를 새로 차지하지 않는다 — 여기서 무조건 비우면 한
        // IP 의 반복 실패가 남의 차단 기록을 지운다.
        if !self.entries.contains_key(&ip) {
            self.make_room();
        }
        let entry = self.entries.entry(ip).or_insert_with(|| Entry {
            failures: Vec::new(),
            blocked_until: None,
            last_seen: now,
        });
        entry.last_seen = now;
        entry
            .failures
            .retain(|at| now.saturating_duration_since(*at) < WINDOW);
        entry.failures.push(now);

        if entry.failures.len() > MAX_FAILURES {
            entry.blocked_until = Some(now + WINDOW);
            true
        } else {
            false
        }
    }

    /// 창 안에 남아 있는 실패 횟수. 로그 한 줄이 "이 IP 의 몇 번째 실패인가"를 말할 수
    /// 있게 하는 값이고, 판정에는 쓰이지 않는다 — 판정은
    /// [`record_failure`](Self::record_failure) 의 반환이 단독으로 한다.
    pub(crate) fn failures_in_window(&self, ip: IpAddr, now: Instant) -> usize {
        match self.entries.get(&ip) {
            Some(entry) => entry
                .failures
                .iter()
                .filter(|at| now.saturating_duration_since(**at) < WINDOW)
                .count(),
            None => 0,
        }
    }

    /// 상한에 닿았으면 `last_seen` 이 가장 오래된 항목 하나를 버린다. 차단 중인 항목도
    /// 예외가 아니지만, 차단된 IP 는 계속 두드리는 동안 [`RateLimiter::check`] 가
    /// `last_seen` 을 갱신해 주므로 실제로 밀려나는 것은 조용해진 IP 다.
    fn make_room(&mut self) {
        if self.entries.len() < self.cap {
            return;
        }
        let victim = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_seen)
            .map(|(ip, _)| *ip);
        if let Some(ip) = victim {
            self.entries.remove(&ip);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(192, 168, 0, last))
    }

    fn secs(base: Instant, n: u64) -> Instant {
        base + Duration::from_secs(n)
    }

    #[test]
    fn allows_ten_failures_inside_the_window() {
        let base = Instant::now();
        let mut limiter = RateLimiter::new(DEFAULT_CAP);
        for i in 0..10 {
            assert!(
                !limiter.record_failure(ip(1), secs(base, i)),
                "{}번째 실패에서 차단되면 안 된다",
                i + 1
            );
        }
        assert!(limiter.check(ip(1), secs(base, 10)));
    }

    #[test]
    fn the_eleventh_failure_blocks_and_reports_it() {
        let base = Instant::now();
        let mut limiter = RateLimiter::new(DEFAULT_CAP);
        for i in 0..10 {
            assert!(!limiter.record_failure(ip(1), secs(base, i)));
        }
        assert!(limiter.record_failure(ip(1), secs(base, 10)));
        assert!(!limiter.check(ip(1), secs(base, 10)));
        // 차단은 그 IP 한정이다.
        assert!(limiter.check(ip(2), secs(base, 10)));
    }

    #[test]
    fn the_block_expires_after_the_window() {
        let base = Instant::now();
        let mut limiter = RateLimiter::new(DEFAULT_CAP);
        for i in 0..11 {
            limiter.record_failure(ip(1), secs(base, i));
        }
        assert!(!limiter.check(ip(1), secs(base, 30)));
        assert!(limiter.check(ip(1), secs(base, 71)));
        // 창이 지난 뒤의 실패 하나가 다시 차단을 걸지 않는다 — 옛 실패는 창 밖이다.
        assert!(!limiter.record_failure(ip(1), secs(base, 72)));
        assert!(limiter.check(ip(1), secs(base, 72)));
    }

    #[test]
    fn failures_age_out_of_the_window() {
        let base = Instant::now();
        let mut limiter = RateLimiter::new(DEFAULT_CAP);
        for i in 0..10 {
            assert!(!limiter.record_failure(ip(1), secs(base, i)));
        }
        // 마지막 실패(t=9)로부터도 60초가 지났다 = 앞의 10회 전부 창 밖. 통산 11번째
        // 실패지만 창 안에서는 첫 번째라 차단되지 않는다.
        assert!(!limiter.record_failure(ip(1), secs(base, 70)));
        assert!(limiter.check(ip(1), secs(base, 70)));
    }

    #[test]
    fn evicts_the_least_recently_seen_entry_past_the_cap() {
        let base = Instant::now();
        let cap = 4;
        let mut limiter = RateLimiter::new(cap);
        for i in 0..cap {
            limiter.record_failure(ip(i as u8), secs(base, i as u64));
        }
        assert_eq!(limiter.entries.len(), cap);

        limiter.record_failure(ip(99), secs(base, 100));
        assert_eq!(limiter.entries.len(), cap);
        assert!(
            !limiter.entries.contains_key(&ip(0)),
            "가장 오래 안 보인 항목이 나가야 한다"
        );
        assert!(limiter.entries.contains_key(&ip(99)));

        // check 도 last_seen 을 갱신하므로, 최근에 요청한 항목은 살아남는다.
        limiter.check(ip(1), secs(base, 101));
        limiter.record_failure(ip(98), secs(base, 102));
        assert!(limiter.entries.contains_key(&ip(1)));
        assert!(!limiter.entries.contains_key(&ip(2)));
    }

    #[test]
    fn a_blocked_ip_stays_blocked_until_the_window_ends() {
        let base = Instant::now();
        let mut limiter = RateLimiter::new(DEFAULT_CAP);
        for i in 0..11 {
            limiter.record_failure(ip(1), secs(base, i));
        }
        // 차단 시각은 11번째 실패(t=10) 기준이라 t=70 까지 이어진다.
        for at in [10, 30, 59, 69] {
            assert!(!limiter.check(ip(1), secs(base, at)), "t={at} 에서 풀렸다");
        }
        assert!(limiter.check(ip(1), secs(base, 70)));
    }
}
