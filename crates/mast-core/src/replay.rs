//! Replay buffer — 최근 PTY 출력을 바이트 상한 내에서 보관한다.
//!
//! 프론트엔드 재접속·재렌더 시 최근 화면 내용을 다시 흘려보내기 위한 버퍼.
//! chunk 단위 VecDeque 와 총 바이트 계정으로 구현하며, 상한 초과 시 오래된
//! chunk 를 통째로 evict 한다.
//!
//! # evicted head 트림 (14단계)
//!
//! evict 는 chunk 경계에서 일어나고 chunk 는 PTY read 단위라 아무 데서나 잘린다
//! — 스냅샷 선두가 행 중간·escape 시퀀스 중간에서 시작할 수 있다. Spike 에서
//! "escape-cut 허용"이던 이 한계는 14단계에서 **완화됐다**: evict 가 한 번이라도
//! 일어난 버퍼의 [`ReplayBuffer::snapshot`] 은 앞쪽 `TRIM_SCAN_BYTES` 내 첫
//! `\n` 뒤부터 반환해 행 경계 시작을 보장한다 (휴리스틱 근거는 해당 rustdoc).
//! 트림이 못 미치는 무개행 출력(TUI 전체 화면 프레임)의 재그리기는 attach 시
//! SIGWINCH nudge(프론트 terminal-view) 수위가 담당한다. 계약:
//! `docs/plans/spike-plan.md` 4.2장 + ADR-0004 결정 2.

use std::collections::VecDeque;

/// evicted 스냅샷의 head 트림에서 행 경계(`\n`)를 찾는 앞쪽 윈도우 크기.
/// "한 행"의 길이 상한으로 삼는 값 — 이 안에 `\n` 이 없으면 행 구조가 아닌
/// 출력로 보고 트림하지 않는다 ([`ReplayBuffer::snapshot`] 참조).
const TRIM_SCAN_BYTES: usize = 4096;

pub struct ReplayBuffer {
    chunks: VecDeque<Vec<u8>>,
    /// 보관 중인 총 바이트 수 (chunks 내 길이 합계와 항상 일치).
    total: usize,
    cap: usize,
    /// evict 가 한 번이라도 일어났다 — `snapshot()` head 트림의 발동 조건.
    /// 리셋되지 않는다: evict 이후의 버퍼 선두는 언제나 chunk 경계 절단으로
    /// 시작했을 수 있기 때문이다.
    evicted: bool,
}

impl ReplayBuffer {
    /// `cap_bytes` — 보관 총량 상한. Spike 기본값은 호출자(session)에서 1MB.
    pub fn new(cap_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total: 0,
            cap: cap_bytes,
            evicted: false,
        }
    }

    /// chunk 하나를 보관한다. 총량이 cap 을 넘으면 오래된 chunk 부터 통째로
    /// evict 한다. 단일 chunk 가 cap 자체를 넘는 극단 케이스에서는 그 chunk 도
    /// evict 되어 버퍼가 빌 수 있다 — cap 은 메모리 방어선이므로 위반하지 않는다.
    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.total += bytes.len();
        self.chunks.push_back(bytes.to_vec());
        while self.total > self.cap {
            match self.chunks.pop_front() {
                Some(dropped) => {
                    self.total -= dropped.len();
                    self.evicted = true;
                }
                None => break,
            }
        }
    }

    /// 보관 중인 데이터를 오래된 것부터 순서대로 이어붙여 반환한다.
    ///
    /// # evicted head 트림
    ///
    /// evict 가 한 번이라도 일어났으면 선두가 행·escape 시퀀스 중간일 수 있으므로
    /// 앞쪽 `TRIM_SCAN_BYTES`(4096B) 내 **첫 `\n` 뒤**부터 반환한다. 근거:
    ///
    /// - `\n` 을 행 경계로 보는 것은 셸 스크롤 출력 대상 휴리스틱이다 — OSC/DCS
    ///   페이로드 안의 `\n` 을 오인할 이론적 여지는 있으나 이 레포 사용례
    ///   (OSC 0/7/9/777 제목·알림 — payload 에 개행 없음)에서는 실질 무해하다.
    /// - 4096B 는 "한 행"의 길이 상한이다. 이 안에 `\n` 이 없으면 행 구조가 아닌
    ///   출력(TUI 전체 화면 프레임 등)로 보고 트림하지 않는다 — 그 재그리기는
    ///   attach 시 SIGWINCH nudge 수위로 위임한다 (모듈 rustdoc).
    /// - 트림 결과가 빈 스냅샷이 되는 경우(첫 `\n` 이 버퍼 마지막 바이트)에도
    ///   트림하지 않는다 — 내용이 있는데 빈 화면을 돌려주지 않는다.
    ///
    /// 트림은 반환 스냅샷에만 적용된다 — [`len`](Self::len) 은 보관량 그대로다.
    pub fn snapshot(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.total);
        for chunk in &self.chunks {
            out.extend_from_slice(chunk);
        }
        if self.evicted {
            let window = &out[..out.len().min(TRIM_SCAN_BYTES)];
            if let Some(pos) = window.iter().position(|&b| b == b'\n') {
                // pos + 1 == out.len() 이면 트림 결과가 빈 스냅샷 — 무트림.
                if pos + 1 < out.len() {
                    out.drain(..=pos);
                }
            }
        }
        out
    }

    /// 보관 바이트 중 앞 `pos` 를 건너뛴 나머지를 chunk 순서대로 이어붙인다.
    /// `pos` 는 [`len`](Self::len) 과 같은 좌표계(= 보관량)이고, `pos >= len()`
    /// 이면 빈 Vec 이다.
    ///
    /// [`snapshot`](Self::snapshot) 과 달리 **evicted head 트림을 적용하지 않는다**.
    /// 트림은 새 터미널을 처음 그릴 때 선두가 행 중간에서 시작하지 않게 하는 장치인데,
    /// 이 함수의 소비자(원격 폴링의 델타)는 앞부분을 이미 받아 둔 상태라 여기서
    /// 트림하면 받은 곳과 이어지지 않는 구멍이 스트림에 생긴다.
    pub fn bytes_from(&self, pos: usize) -> Vec<u8> {
        if pos >= self.total {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(self.total - pos);
        let mut seen = 0usize;
        for chunk in &self.chunks {
            if seen + chunk.len() <= pos {
                seen += chunk.len();
                continue;
            }
            // 첫 부분 포함 chunk 이후로는 seen 이 pos 를 넘어서므로 start 가 0 이 된다.
            out.extend_from_slice(&chunk[pos.saturating_sub(seen)..]);
            seen += chunk.len();
        }
        out
    }

    /// 보관 중인 총 바이트 수. evicted head 트림과 무관한 **보관량**이다 —
    /// `snapshot().len()` 과 다를 수 있다 (트림은 snapshot 반환값에만 적용).
    pub fn len(&self) -> usize {
        self.total
    }

    pub fn is_empty(&self) -> bool {
        self.total == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_under_cap() {
        let mut buf = ReplayBuffer::new(100);
        buf.push(b"hello ");
        buf.push(b"world");
        assert_eq!(buf.len(), 11);
        assert_eq!(buf.snapshot(), b"hello world");
    }

    #[test]
    fn evicts_oldest_chunk_first() {
        let mut buf = ReplayBuffer::new(10);
        buf.push(b"aaaa"); // 4
        buf.push(b"bbbb"); // 8
        buf.push(b"cccc"); // 12 → "aaaa" evict → 8
        assert_eq!(buf.snapshot(), b"bbbbcccc");
        assert_eq!(buf.len(), 8);
    }

    #[test]
    fn evicts_multiple_chunks_if_needed() {
        let mut buf = ReplayBuffer::new(10);
        buf.push(b"aa"); // 2
        buf.push(b"bb"); // 4
        buf.push(b"cccccccc"); // 12 → "aa" evict → 10 (정확히 cap, 유지)
        assert_eq!(buf.snapshot(), b"bbcccccccc");
        assert_eq!(buf.len(), 10);
        buf.push(b"d"); // 11 → "bb" evict → 9
        assert_eq!(buf.snapshot(), b"ccccccccd");
        assert_eq!(buf.len(), 9);
    }

    #[test]
    fn exact_cap_is_not_evicted() {
        let mut buf = ReplayBuffer::new(8);
        buf.push(b"aaaa");
        buf.push(b"bbbb"); // 정확히 cap — evict 없음
        assert_eq!(buf.len(), 8);
        assert_eq!(buf.snapshot(), b"aaaabbbb");
    }

    #[test]
    fn snapshot_preserves_push_order() {
        let mut buf = ReplayBuffer::new(1024);
        buf.push(b"1");
        buf.push(b"22");
        buf.push(b"333");
        assert_eq!(buf.snapshot(), b"122333");
    }

    #[test]
    fn single_chunk_larger_than_cap_leaves_buffer_empty() {
        // cap 을 혼자 넘는 chunk 는 보관하지 않는다 (cap 은 메모리 방어선).
        let mut buf = ReplayBuffer::new(4);
        buf.push(b"toolong");
        assert_eq!(buf.len(), 0);
        assert!(buf.is_empty());
        assert_eq!(buf.snapshot(), b"");
        // 이후 정상 push 는 계속 동작한다.
        buf.push(b"ok");
        assert_eq!(buf.snapshot(), b"ok");
    }

    #[test]
    fn empty_push_is_noop() {
        let mut buf = ReplayBuffer::new(4);
        buf.push(b"");
        assert!(buf.is_empty());
        assert_eq!(buf.len(), 0);
    }

    #[test]
    fn len_stays_accurate_across_evictions() {
        let mut buf = ReplayBuffer::new(6);
        for _ in 0..100 {
            buf.push(b"abc"); // 3 bytes — 항상 최근 2개(6 bytes)만 남아야 한다
        }
        assert_eq!(buf.len(), 6);
        assert_eq!(buf.snapshot(), b"abcabc");
    }

    // --- evicted head 트림 (14단계 계획 1장 A-1) ---

    #[test]
    fn trims_snapshot_head_to_line_boundary_after_evict() {
        let mut buf = ReplayBuffer::new(16);
        buf.push(b"aaaa"); // 4
        buf.push(b"bb\ncc"); // 9
        buf.push(b"ddddddddd"); // 18 → "aaaa" evict → 14
                                // evict 발생 → 첫 `\n`(index 2) 뒤부터 반환. len() 은 보관량 유지 —
                                // 스냅샷 길이와 달라진다 (트림 자체를 잠그는 assert).
        assert_eq!(buf.snapshot(), b"ccddddddddd");
        assert_eq!(buf.len(), 14);
    }

    #[test]
    fn does_not_trim_when_window_has_no_newline() {
        let mut buf = ReplayBuffer::new(4);
        buf.push(b"aaaa");
        buf.push(b"bbb"); // 7 → "aaaa" evict → 3
                          // evict 는 됐지만 `\n` 이 없다 — 무개행 출력은 트림하지 않는다.
        assert_eq!(buf.snapshot(), b"bbb");
        assert_eq!(buf.len(), 3);
    }

    #[test]
    fn does_not_trim_before_any_evict() {
        let mut buf = ReplayBuffer::new(100);
        buf.push(b"aa\nbb");
        // evict 전에는 선두가 스트림 시작 그대로다 — `\n` 이 있어도 무트림.
        assert_eq!(buf.snapshot(), b"aa\nbb");
    }

    #[test]
    fn trims_past_crlf_leaving_no_dangling_cr() {
        let mut buf = ReplayBuffer::new(12);
        buf.push(b"xx"); // 2
        buf.push(b"ab\r\ncd"); // 8
        buf.push(b"efgh"); // 12 (== cap, evict 없음)
        buf.push(b"ij"); // 14 → "xx" evict → 12
                         // `\r\n` 도 "첫 `\n` 뒤" 규칙 하나로 처리된다 — `\r` 이 남지 않는다.
        assert_eq!(buf.snapshot(), b"cdefghij");
    }

    #[test]
    fn does_not_trim_to_empty_when_newline_is_last_byte() {
        let mut buf = ReplayBuffer::new(4);
        buf.push(b"abc");
        buf.push(b"d\n"); // 5 → "abc" evict → 2
                          // 유일한 `\n` 이 마지막 바이트 — 트림하면 빈 스냅샷이 되므로 무트림.
        assert_eq!(buf.snapshot(), b"d\n");
    }

    // --- bytes_from (원격 델타) ---

    #[test]
    fn bytes_from_zero_returns_everything_untrimmed() {
        let mut buf = ReplayBuffer::new(100);
        buf.push(b"hello ");
        buf.push(b"world");
        assert_eq!(buf.bytes_from(0), b"hello world");
    }

    #[test]
    fn bytes_from_skips_across_chunk_boundaries() {
        let mut buf = ReplayBuffer::new(100);
        buf.push(b"aaa");
        buf.push(b"bbb");
        buf.push(b"ccc");
        // chunk 중간에서 시작하는 경우와 chunk 경계에서 시작하는 경우 둘 다.
        assert_eq!(buf.bytes_from(4), b"bbccc");
        assert_eq!(buf.bytes_from(3), b"bbbccc");
        assert_eq!(buf.bytes_from(8), b"c");
    }

    #[test]
    fn bytes_from_at_len_returns_empty() {
        let mut buf = ReplayBuffer::new(100);
        buf.push(b"abcd");
        assert_eq!(buf.bytes_from(buf.len()), b"");
    }

    #[test]
    fn bytes_from_beyond_len_returns_empty() {
        let mut buf = ReplayBuffer::new(100);
        buf.push(b"abcd");
        assert_eq!(buf.bytes_from(buf.len() + 10), b"");
    }

    #[test]
    fn bytes_from_ignores_the_evicted_head_trim() {
        let mut buf = ReplayBuffer::new(16);
        buf.push(b"aaaa"); // 4
        buf.push(b"bb\ncc"); // 9
        buf.push(b"ddddddddd"); // 18 → "aaaa" evict → 14
                                // snapshot 은 첫 `\n` 뒤부터지만 델타는 보관 바이트 전체다 —
                                // 트림하면 수신자가 이미 가진 지점과 이어지지 않는다.
        assert_eq!(buf.snapshot(), b"ccddddddddd");
        assert_eq!(buf.bytes_from(0), b"bb\nccddddddddd");
        assert_eq!(buf.bytes_from(0).len(), buf.len());
    }

    #[test]
    fn ignores_newline_beyond_scan_window() {
        let mut buf = ReplayBuffer::new(2 * TRIM_SCAN_BYTES);
        buf.push(&[b'x'; TRIM_SCAN_BYTES]);
        buf.push(&[b'y'; TRIM_SCAN_BYTES]); // == cap, evict 없음
        buf.push(b"zz\nw"); // 초과 → 첫 chunk evict → 4100
                            // 첫 `\n` 위치(4098)가 윈도우(4096) 밖 — 행 길이 상한 초과로 보고 무트림.
        let snap = buf.snapshot();
        assert_eq!(snap.len(), TRIM_SCAN_BYTES + 4);
        assert_eq!(&snap[..TRIM_SCAN_BYTES], &[b'y'; TRIM_SCAN_BYTES][..]);
        assert_eq!(&snap[TRIM_SCAN_BYTES..], b"zz\nw");
    }
}
