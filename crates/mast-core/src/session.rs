//! PTY 세션 — 셸 프로세스를 PTY 로 띄우고 출력 파이프라인을 구동한다.
//!
//! `portable-pty` 를 사용해 Windows(ConPTY)/Unix(표준 PTY) 양쪽에서 동작한다.
//!
//! # 출력 파이프라인 계약
//!
//! 세션마다 리더 스레드 하나가 PTY 출력을 chunk 단위로 읽어 다음 순서로 처리한다.
//!
//! 1. `OscScanner::feed` 로 제어 시퀀스를 감지하고(passthrough — 원본 바이트는
//!    그대로 흘러간다) **OSC 이벤트만** `sink.on_osc` 로 전달한다 (lock 밖).
//!    DEC private mode·리셋은 OSC 가 아니므로 세션이 소비한다 — sink 로도 가지
//!    않고 OSC 계정에도 잡히지 않는다 ([`PtySession::reattach`] 의 preamble).
//! 2. 상태 lock **안**에서 OSC 계정 → 모드 추적 갱신 → `offset = bytes_out`
//!    캡처 → `replay.push` → `flow.on_sent(n)` → `bytes_out += n` 까지 끝낸다.
//!    모드 맵과 replay 가 같은 lock 에서 확정되므로 둘은 chunk 단위로 정합하고,
//!    offset·replay·flow 계정도 한 lock 에서 일관되게 확정된다.
//! 3. lock 을 놓은 **뒤** `sink.on_output(offset, chunk)` 를 호출한다 — 콜백이
//!    `ack()` 등을 재진입 호출해도 안전하다. `Dropped` 반환 시 lock 재취득 후
//!    `flow.on_acked(n)` 보상 롤백 (순서 근거는 리더 루프 주석 참조).
//!
//! flow control 이 Pause 상태이면 전달만 멈추는 게 아니라 **PTY read 자체를
//! 중단**(condvar 대기)해 OS 파이프에 backpressure 를 넘긴다.
//!
//! # 스레드 구조와 종료 감지 (리더 + waiter)
//!
//! 세션마다 스레드 둘이 돈다 — **리더**(위 출력 파이프라인 전담)와 **waiter**
//! (수명 전담 — `Child` 를 소유하고 `child.wait()` 로 종료를 관측한다).
//!
//! 종료 감지를 waiter 로 분리한 근거는 Windows ConPTY 다: **ConPTY 는 자식
//! 프로세스가 종료해도 출력 파이프를 EOF 시키지 않는다** — conhost 가
//! `ClosePseudoConsole` 전까지 파이프를 유지한다. 따라서 "read 탈출(EOF/EIO)
//! 후 wait" 하는 Unix 식 단일 스레드 구조로는 Windows 자연 종료 시 리더가
//! read 에 영구 블록돼 종료를 영영 감지하지 못한다. waiter 는 wait 반환 시
//! 다음 순서로 종료를 전파한다: lock 안에서 alive=false·killed=true 확정 →
//! `notify_all`(paused 리더 해제) → writer·master drop(=`ClosePseudoConsole`
//! — 블록된 read 가 에러로 풀려 리더 탈출; Unix 에선 fd 회수만) →
//! `sink.on_exit(code)`.
//!
//! `on_exit` 는 자연 종료·kill 어느 경로든 **waiter 만, 세션당 정확히 1회**
//! 호출한다 — 리더와 [`PtySession::kill`] 은 호출 경로가 아니다.
//!
//! # offset 스트림과 reattach
//!
//! `offset` 은 세션 시작부터의 누적 출력 오프셋(u64)이다. 각 chunk 는 자기 시작
//! offset 을 달고 나가며, 연속 전달이라면 다음 chunk 의 offset 은 직전
//! offset + len 과 같다. 프론트 재접속은 [`PtySession::reattach`] 로 한다 —
//! "채널 먼저 장착, reattach 나중" 불변식과 offset 기반 dedup 규칙은 해당
//! rustdoc 이 호출자 계약으로 명시한다.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, ensure};
use portable_pty::{
    native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtyPair, PtySize,
};

use crate::flow::{FlowAction, FlowControl};
use crate::osc::{OscEvent, OscScanner};
use crate::replay::ReplayBuffer;

/// 리더 스레드의 1회 read 버퍼 크기.
const READ_BUF_BYTES: usize = 16 * 1024;

/// 재-attach 때 다시 세워 줄 DEC private mode 의 최대 가짓수. 실제 TUI 가 쓰는
/// 모드는 열 몇 개 수준이라 정상 사용은 닿지 않는 선이고, 넘어가는 것은 모드
/// 번호를 흘리는 스트림뿐이다 — 맵이 무한히 자라지 않게 하는 메모리 방어선이다.
const MAX_TRACKED_DEC_MODES: usize = 64;

/// **추적하지 않는** DEC private mode. 여기 있는 번호들은 설정값이 아니라
/// **부수효과가 있는 전이(transition)** 라서, 나중에 다시 세우는 것 자체가 틀린
/// 동작이 된다.
///
/// - 대체 화면 전환(47·1047·1049)과 커서 저장/복원(1048·1049): xterm.js 의
///   `setModePrivate` 은 1049 에서 `saveCursor()` 후 `activateAltBuffer()` 로
///   흘러가는데, `BufferSet.activateAltBuffer` 는 **이미 alt 버퍼면 곧바로
///   반환한다**(`src/common/buffer/BufferSet.ts` ~:99-102). preamble 이 replay
///   보다 앞서므로 `ESC[?1049h` 를 먼저 세우면 replay 안의 진짜 `ESC[?1049h` 가
///   no-op 이 되고, **전환 이전의 replay(셸 스크롤백)까지 스크롤백이 없는 alt
///   버퍼에 그려진다**. 반대로 `resetModePrivate` 의 1049 는 `restoreCursor()` 를
///   불러 커서를 저장된 위치(없으면 0,0)로 옮기므로, 뒤늦은 `ESC[?1049l` 은 살아
///   있는 프롬프트의 커서를 엉뚱한 데로 보낸다.
/// - synchronized output(2026): begin(`?2026h`)/end(`?2026l`) 쌍으로만 의미가
///   있는 일시 상태라, begin 을 다시 세우면 짝이 되는 end 가 영영 오지 않아
///   xterm 이 replay 전체를 프레임에 묶어 둔 채 아무것도 그리지 않는다.
const UNTRACKED_DEC_MODES: [u16; 5] = [47, 1047, 1048, 1049, 2026];

/// DECSTR(soft reset)이 기본값으로 되돌리는 DEC private mode. RIS 와 달리 단말
/// 전체를 초기화하지 않으므로, 추적 맵에서도 이 번호들만 지운다.
///
/// 목록은 xterm.js 가 실제로 되돌리는 것과 맞춘 값이다 —
/// `InputHandler.ts::softReset` 이 `isCursorHidden = false`(25)와
/// `decPrivateModes.origin = false`(6)를 직접 놓고, `CoreService::reset` 이
/// `DEFAULT_DEC_PRIVATE_MODES` 로 되돌리는 필드가 `applicationCursorKeys`(1)·
/// `origin`(6)·`wraparound`(7)·`reverseWraparound`(45)·`applicationKeypad`(66)·
/// `sendFocus`(1004)·`bracketedPasteMode`(2004)다. 마우스 트래킹은
/// `CoreMouseService` 에, 대체 화면은 `BufferSet` 에 있어 **둘 다 soft reset 이
/// 건드리지 않는다** — 그래서 DECSTR 뒤에도 그 모드들은 추적을 유지해야 한다.
const SOFT_RESET_DEC_MODES: [u16; 8] = [1, 6, 7, 25, 45, 66, 1004, 2004];

/// PTY 세션의 휘발성 런타임 식별자. `SessionManager` 가 발급하며 프로세스 수명
/// 안에서 재사용하지 않는다. persistence·MCP 대상인 안정 ID(u64 newtype)와는
/// 별개의 공간이다.
pub type SessionId = u32;

/// `SessionSink::on_output` 의 결과 — sink 가 chunk 를 실제로 전달했는지 여부.
/// 리더 스레드의 flow 계정 처리(유지 vs 보상 롤백)를 가른다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// 프론트로 전달됐다 — flow 계정을 유지한다 (이후 ack 으로 회수).
    Delivered,
    /// 전달되지 않았다 (채널 부재·전송 실패 등) — 리더가 flow 계정을 보상
    /// 롤백한다.
    Dropped,
}

/// 세션 이벤트 수신자. Tauri 글루(채널 emit)나 테스트 하네스가 구현한다.
/// 리더 스레드(`on_output`·`on_osc`)와 waiter 스레드(`on_exit`)에서 호출되므로
/// 구현은 블로킹을 최소화해야 한다.
pub trait SessionSink: Send + Sync + 'static {
    /// PTY 출력 chunk. OSC 감지는 passthrough 라 원본 바이트가 그대로 온다.
    /// `offset` = 이 chunk 시작 시점의 누적 스트림 오프셋. `Dropped` 반환 시
    /// 리더는 이 chunk 의 flow 계정을 보상 롤백한다 (detach 모드).
    ///
    /// 주의 — detach 가 무조건 자유 진행을 뜻하지는 않는다: (a) 이미 paused 인
    /// 상태에서 프론트가 사라지면(ack 두절) 리더는 read 자체를 안 하므로 Dropped
    /// 경로가 실행되지 않고 휴면이 지속되며, (b) Dropped 전환 시점의 잔여 pending
    /// 이 low_water 를 웃돌면 롤백 후에도 paused 가 남는다. 두 경우 모두
    /// `reset_flow()`(detach 시점 자동 치유 — 계획 D4)·`reattach()`(flow reset
    /// 포함) 또는 `kill()` 이 회복 경로다.
    fn on_output(&self, offset: u64, bytes: &[u8]) -> Delivery;
    /// 감지된 OSC 이벤트. 같은 chunk 의 `on_output` 보다 먼저 호출된다.
    fn on_osc(&self, event: &OscEvent);
    /// 프로세스 종료. 자연 종료·kill 어느 쪽이든 세션당 정확히 1회 호출된다.
    /// `code` 는 exit code (signal 종료 등으로 알 수 없으면 None).
    fn on_exit(&self, code: Option<u32>);
    /// `SessionOptions::startup_deadline` 안에 시작 표식이 오지 않았다. 최대 1회다
    /// (마감은 한 번만 지나간다).
    ///
    /// **세션은 살아 있다.** 죽이지 않는 것이 계약이라, 늦게 도착한 표식은
    /// `Osc777Started` 로 정상 전달되고 상위가 경고를 거둘 수 있다. 기본 구현이
    /// no-op 인 이유도 그것이다 — 이 신호를 안 보는 구현에게 이 기능은 존재하지 않는
    /// 것과 같고, 세션 동작은 어느 쪽이든 동일하다.
    fn on_startup_timeout(&self) {}
}

/// 스폰할 프로세스 사양.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// 세션 튜닝 옵션. `Default` 는 replay 1MB, high 2MB, low 512KB.
#[derive(Debug, Clone, Copy)]
pub struct SessionOptions {
    pub replay_cap: usize,
    pub high_water: usize,
    pub low_water: usize,
    /// 이 시간 안에 시작 표식([`OscEvent::Osc777Started`])이 오지 않으면
    /// `on_startup_timeout` 을 부른다. `None` 이면 감시하지 않는다 — 표식을 낼 래퍼가
    /// 없는 경로(unix 개발 실행은 `$SHELL -l` 을 직접 띄운다)가 그렇다.
    ///
    /// 마감을 넘겨도 **세션을 죽이지 않기 때문에** 오탐의 대가가 경고 한 번뿐이고,
    /// 그래서 값을 넉넉히 증명하지 않아도 안전하다. WSL 콜드 스타트가 수 초에서 수
    /// 분까지 걸린 보고가 있어, 죽이는 설계였다면 이 값은 정당화가 불가능했다.
    pub startup_deadline: Option<Duration>,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            replay_cap: 1024 * 1024,
            high_water: 2 * 1024 * 1024,
            low_water: 512 * 1024,
            startup_deadline: None,
        }
    }
}

/// 세션 상태 스냅샷. `last_osc` 는 사람이 읽을 요약 문자열 (예: "777:title").
/// id 는 담지 않는다 — 세션의 id 는 `SessionManager` 레지스트리가 소유한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStats {
    pub bytes_out: u64,
    pub pending: usize,
    pub paused: bool,
    pub osc_count: u64,
    pub last_osc: Option<String>,
    pub alive: bool,
}

/// [`PtySession::screen_since`] 의 반환 — 폴링 소비자가 화면을 세우는 데 필요한
/// 전부다. `reset` 이면 `bytes` 는 처음부터 그릴 재료(모드 preamble + 스냅샷)이고,
/// 아니면 `since` 이후의 raw 델타다. `cols`/`rows` 는 이 세션의 현재 PTY 크기 —
/// 수신자가 같은 크기로 터미널을 만들어야 replay 가 맞게 그려진다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    pub end_offset: u64,
    pub reset: bool,
    pub cols: u16,
    pub rows: u16,
    pub bytes: Vec<u8>,
}

/// 리더 스레드와 세션 핸들이 공유하는 상태.
struct Shared {
    inner: Mutex<Inner>,
    /// paused → resume/kill 전환을 리더 스레드에 알리는 신호.
    cond: Condvar,
}

struct Inner {
    flow: FlowControl,
    replay: ReplayBuffer,
    /// 실행 중인 프로그램이 DECSET/DECRST 로 건드린 private mode 의 **현재 값**.
    /// 재-attach preamble 의 재료다 ([`PtySession::reattach`]). 오름차순 순회가
    /// 필요해 `BTreeMap` 을 쓴다 — preamble 바이트열이 재현 가능해진다.
    dec_modes: BTreeMap<u16, bool>,
    bytes_out: u64,
    osc_count: u64,
    last_osc: Option<String>,
    /// waiter 스레드가 프로세스 종료를 관측(`child.wait()` 반환)하면 false 로
    /// 내린다.
    alive: bool,
    /// `kill()` 또는 waiter(자식 종료 관측)가 올린다 — 리더 스레드는 이를 보면
    /// 즉시 루프를 빠져나간다.
    killed: bool,
    /// 시작 표식을 본 적이 있는지. 리더가 **sink 콜백보다 먼저** 올린다 — 콜백이
    /// 지연되는 사이 워치독이 마감을 지나면 살아 있는 셸을 못 떴다고 보고하게 된다.
    startup_seen: bool,
}

/// waiter 스레드와 공유하는 PTY 입력 writer. 종료 후에는 None (fd 회수됨).
type SharedWriter = Arc<Mutex<Option<Box<dyn Write + Send>>>>;
/// waiter 스레드와 공유하는 PTY master. drop 이 Windows 에서는
/// `ClosePseudoConsole` 이라 블록된 read 를 풀어주는 종료 전파 수단이기도 하다.
type SharedMaster = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

/// PTY 세션 핸들. 스레드 간 공유 가능(`&self` API + 내부 Mutex).
pub struct PtySession {
    shared: Arc<Shared>,
    /// PTY 입력 writer. waiter 와 공유 — kill·종료 후에는 None (fd 회수).
    writer: SharedWriter,
    /// PTY master. resize 에 사용하며 kill·종료 시 drop 해 fd 를 회수한다.
    /// waiter 와 공유 — Windows 자연 종료 시 waiter 가 이 drop 으로 리더의
    /// 블록된 read 를 풀어준다 (모듈 rustdoc "스레드 구조와 종료 감지").
    master: SharedMaster,
    /// waiter 스레드가 `Child` 본체(wait 용)를 가져가므로 kill 신호는 분리된 killer 로 보낸다.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// 현재 PTY 창 크기 (`cols << 16 | rows`). [`screen_since`](Self::screen_since)
    /// 의 소비자는 데스크톱과 같은 크기의 터미널을 만들어야 하는데 PTY master 에는
    /// 크기를 되묻는 경로가 없어 세션이 기억한다. `inner` 와 겹치지 않는 별도
    /// Atomic 인 것은 이 파일에 없던 lock 순서 규약(`inner` ↔ `master`)을 새로
    /// 만들지 않기 위해서다.
    size: AtomicU32,
}

impl PtySession {
    /// 프로세스를 PTY 로 스폰하고 리더(출력)·waiter(수명) 스레드를 시작한다.
    pub fn spawn(
        spec: SpawnSpec,
        sink: Box<dyn SessionSink>,
        opts: SessionOptions,
    ) -> anyhow::Result<Self> {
        ensure!(
            opts.low_water <= opts.high_water,
            "low_water ({}) must be <= high_water ({})",
            opts.low_water,
            opts.high_water
        );

        let PtyPair { master, slave } = native_pty_system().openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        if let Some(cwd) = &spec.cwd {
            cmd.cwd(cwd);
        }
        let child = slave.spawn_command(cmd)?;
        // slave fd 는 자식 프로세스가 물려받았으므로 우리 쪽 핸들은 바로 닫는다.
        // (이걸 잡고 있으면 자식 종료 후에도 master read 가 EOF 를 받지 못한다.)
        drop(slave);

        let killer = child.clone_killer();
        let reader = master.try_clone_reader()?;
        let writer = master.take_writer()?;

        let shared = Arc::new(Shared {
            inner: Mutex::new(Inner {
                flow: FlowControl::new(opts.high_water, opts.low_water),
                replay: ReplayBuffer::new(opts.replay_cap),
                dec_modes: BTreeMap::new(),
                bytes_out: 0,
                osc_count: 0,
                last_osc: None,
                alive: true,
                killed: false,
                startup_seen: false,
            }),
            cond: Condvar::new(),
        });

        // sink 는 리더(on_output·on_osc)·waiter(on_exit) 양쪽에서 쓰므로 Arc 로
        // 공유한다 (공개 API 는 Box 를 받고 내부에서만 변환 — 메서드가 전부
        // &self 라 가능).
        let sink: Arc<dyn SessionSink> = Arc::from(sink);
        let writer: SharedWriter = Arc::new(Mutex::new(Some(writer)));
        let master: SharedMaster = Arc::new(Mutex::new(Some(master)));

        // JoinHandle 은 보관하지 않는다(detach). 리더는 EOF/에러/killed 로, waiter
        // 는 child.wait() 반환으로 반드시 종료되고, 종료하면서 자신이 가진
        // reader fd·child 핸들을 놓는다.
        std::thread::Builder::new()
            .name("mast-pty-reader".into())
            .spawn({
                let sink = Arc::clone(&sink);
                let shared = Arc::clone(&shared);
                move || reader_loop(reader, sink, shared)
            })?;
        std::thread::Builder::new()
            .name("mast-pty-waiter".into())
            .spawn({
                let sink = Arc::clone(&sink);
                let shared = Arc::clone(&shared);
                let writer = Arc::clone(&writer);
                let master = Arc::clone(&master);
                move || waiter_loop(child, sink, shared, writer, master)
            })?;
        // 워치독은 마감을 요구한 경우에만, 그리고 마감까지만 산다 — 표식이 오거나
        // 세션이 죽으면 리더·waiter 의 notify 로 즉시 회수된다. 상시 스레드 수는
        // 세션당 둘 그대로다.
        if let Some(deadline) = opts.startup_deadline {
            let started = std::thread::Builder::new()
                .name("mast-pty-startup".into())
                .spawn({
                    let sink = Arc::clone(&sink);
                    let shared = Arc::clone(&shared);
                    move || startup_watchdog(deadline, sink, shared)
                });
            // 실패를 `?` 로 올리지 않는다. 이 시점에는 자식과 reader·waiter 가 이미 떠
            // 있는데 `PtySession` 값은 아직 없어서, 여기서 반환하면 Drop 도 레지스트리
            // 등록도 없이 아무도 죽일 수 없는 프로세스가 남는다 — 이 기능이 없애려는
            // 좀비와 같은 종류다. 워치독은 감시일 뿐 세션의 전제가 아니므로, 없으면
            // 감시만 빠진 종전 동작이 된다.
            if let Err(err) = started {
                eprintln!(
                    "[mast] startup watchdog not started ({err}); this session runs unwatched"
                );
            }
        }

        Ok(Self {
            shared,
            writer,
            master,
            killer: Mutex::new(killer),
            size: AtomicU32::new(pack_size(spec.cols, spec.rows)),
        })
    }

    /// PTY 입력(stdin)으로 bytes 를 쓴다. kill 이후에는 에러.
    pub fn write(&self, bytes: &[u8]) -> anyhow::Result<()> {
        let mut guard = self.writer.lock().unwrap();
        let writer = guard
            .as_mut()
            .ok_or_else(|| anyhow!("session already killed"))?;
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    /// PTY 창 크기를 변경한다 (자식에게 SIGWINCH 전달). kill 이후에는 에러.
    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        let guard = self.master.lock().unwrap();
        let master = guard
            .as_ref()
            .ok_or_else(|| anyhow!("session already killed"))?;
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        // guard 를 놓기 전에 기록한다 — 잠금 밖에서 순차로 쓰면 동시에 온 두 resize 가
        // PTY 와 이 기록에 서로 다른 순서로 들어가, 실제 크기와 다른 값이 굳는 창이 있다.
        self.size.store(pack_size(cols, rows), Ordering::Relaxed);
        Ok(())
    }

    /// 프론트엔드가 n bytes 소비를 완료했다. Resume 전환 시 리더를 깨운다.
    pub fn ack(&self, n: usize) {
        let mut inner = self.shared.inner.lock().unwrap();
        if inner.flow.on_acked(n) == FlowAction::Resume {
            self.shared.cond.notify_all();
        }
    }

    /// flow 계정 리셋(pending = 0, paused = false) + paused 로 대기 중인 리더
    /// wake — **detach 자동 치유 경로** (11~12단계 계획 D4).
    ///
    /// detach(채널 분리)만으로는 자유 진행이 보장되지 않는다: **이미 paused 인
    /// 상태에서 채널이 죽으면**(F5 리로드 등 — dispose 를 타지 않는 소멸) 리더는
    /// condvar 대기 중이라 read 자체를 하지 않고, 따라서 `Dropped` 보상 롤백
    /// 경로가 실행되지 않아 세션이 paused 에 고착된다 (`SessionSink::on_output`
    /// rustdoc 의 (a)·(b) 케이스). detach 시점에 이 함수를 호출하면 detach 된
    /// 세션은 어떤 경로로든 paused 에 남지 않는다.
    ///
    /// 리셋 후 구채널의 잔여 ack 이 늦게 도착해도 saturating 으로 무해하다
    /// (`FlowControl::reset` rustdoc). [`reattach`](Self::reattach) 는 이 리셋에
    /// replay 스냅샷 확정까지 **한 lock 안에서** 묶은 상위 경로다 — 스냅샷 일관성
    /// 계약 때문에 이 함수를 재사용하지 못하고 lock 구간을 따로 가진다.
    pub fn reset_flow(&self) {
        self.shared.inner.lock().unwrap().flow.reset();
        // lock 을 놓은 뒤 notify — paused 로 대기하던 리더가 즉시 재개된다.
        self.shared.cond.notify_all();
    }

    /// 프론트 재접속 — 한 lock 안에서 flow 계정 리셋 + replay 스냅샷 + 스냅샷 끝
    /// 오프셋(= 현재 `bytes_out`)을 일관되게 확정해 반환하고, lock 해제 후
    /// paused 로 대기 중이던 리더를 깨운다. (flow 리셋만 필요한 detach 치유는
    /// [`reset_flow`](Self::reset_flow) — 스냅샷 없는 하위 경로.)
    ///
    /// 반환 `(end_offset, bytes)`: `bytes` 는 **모드 preamble + replay 스냅샷**이다.
    /// preamble 은 **추적 중인** DEC private mode 를 새 터미널에 다시 세우는
    /// `ESC [ ? <mode> h|l` 들이고(모드 번호 오름차순), 그 뒤에 replay buffer 의
    /// 최근 출력이 이어진다. 관측한 모드가 전부 추적되는 것은 아니다 —
    /// 대체 화면 전환처럼 "다시 세우는 것 자체가 틀린" 모드는 제외된다
    /// (`UNTRACKED_DEC_MODES`).
    ///
    /// preamble 이 필요한 이유는 프론트가 재-attach 때 **새 xterm 인스턴스**를
    /// 만들고 상태를 오직 이 바이트열에서만 되살리기 때문이다. 모드를 켠 시퀀스가
    /// replay 창 밖으로 밀려난 장수 TUI 는 그 방법으로는 모드를 되찾지 못한다
    /// ([`OscEvent::DecPrivateMode`] rustdoc 의 실기 사례).
    ///
    /// **길이로 오프셋을 역산하지 말 것.** preamble 은 스트림에 없던 바이트라
    /// `bytes` 의 길이는 더 이상 스냅샷 구간의 폭이 아니다 — 스냅샷 구간의 끝은
    /// `end_offset` 하나로만 말해지고, dedup 규칙(`offset < end_offset`)도 길이를
    /// 쓰지 않는다.
    ///
    /// # 호출자 계약
    ///
    /// - **채널 먼저 장착, reattach 나중.** 새 출력 수신 경로(sink 채널)를 먼저
    ///   연결한 뒤 이 함수를 호출해야 한다. 순서를 어기면 reattach 와 채널 장착
    ///   사이의 출력이 스냅샷에도 채널에도 담기지 않는 유실 창이 생긴다.
    /// - **dedup 규칙.** 채널을 먼저 장착했으므로 스냅샷 구간과 겹치는 chunk 가
    ///   채널로 도착할 수 있다. 호출자는 `offset < end_offset` 인 chunk 를
    ///   폐기하되, **폐기분 포함 받은 전량을 ack** 한다 — "받은 만큼 ack" 단일
    ///   규칙이라야 어떤 인터리빙에서도 flow 계정이 맞고, 계정이 리셋된 에폭에
    ///   대한 초과 ack 은 saturating 으로 무해하다 (`FlowControl::reset` 참조).
    pub fn reattach(&self) -> (u64, Vec<u8>) {
        let (end_offset, bytes) = {
            let mut inner = self.shared.inner.lock().unwrap();
            inner.flow.reset();
            let mut bytes = dec_mode_preamble(&inner.dec_modes);
            let mut snapshot = inner.replay.snapshot();
            bytes.append(&mut snapshot);
            (inner.bytes_out, bytes)
        };
        // lock 을 놓은 뒤 notify — paused 로 대기하던 리더가 즉시 재개된다.
        self.shared.cond.notify_all();
        (end_offset, bytes)
    }

    /// replay buffer 에 보관 중인 최근 출력 스냅샷 — **버퍼 원본 그대로**다.
    /// 모드 preamble 이 붙지 않으므로 새 터미널을 여기서 되살리면 안 된다
    /// (그 경로는 [`reattach`](Self::reattach)). 진단용 관측 창이다.
    pub fn replay(&self) -> Vec<u8> {
        self.shared.inner.lock().unwrap().replay.snapshot()
    }

    /// 원격(폴링) 소비자용 **read-only 관측** — `since` 이후에 나온 출력만 돌려준다.
    /// [`reattach`](Self::reattach) 와 달리 flow 를 리셋하지 않고 sink·dec_modes 도
    /// 건드리지 않으며 리더를 깨우지도 않는다. 폴링 소비자는 데스크톱 소비자와 **같은
    /// 세션을 동시에** 보므로, 여기서 flow 를 리셋하면 폰의 폴 한 번이 데스크톱의
    /// backpressure 계정을 지운다.
    ///
    /// `reset` 이 true 면 `bytes` 는 [`reattach`](Self::reattach) 와 같은 재료
    /// (모드 preamble + replay 스냅샷)이고 수신자는 터미널을 새로 만들어 처음부터
    /// 그린다. false 면 `bytes` 는 `since` 부터 `end_offset` 까지의 raw 델타이므로
    /// `end_offset == since + bytes.len()` 이 성립한다.
    ///
    /// reset 이 되는 갈래는 셋이다 — `since` 없음(첫 요청), 보관 창보다 오래된 `since`
    /// (그 구간은 이미 evict 됐다), 그리고 **`since > bytes_out`**. 마지막은 탭
    /// respawn(ADR-0010)처럼 수신자가 **다른 세션의 오프셋**을 들고 온 경우다: 새
    /// 세션의 `bytes_out` 은 0 부터 다시 시작하므로 옛 오프셋이 미래처럼 보인다.
    pub fn screen_since(&self, since: Option<u64>) -> Screen {
        // 크기는 `inner` 밖의 Atomic 이다. 다른 데이터를 발행하지 않는 단일 값이라
        // Relaxed 로 충분하고, 여기서 `master` 를 잡으면 lock 순서 규약이 생긴다.
        let (cols, rows) = unpack_size(self.size.load(Ordering::Relaxed));
        let inner = self.shared.inner.lock().unwrap();
        let end_offset = inner.bytes_out;
        // 보관 창의 시작 오프셋. replay 는 evict 로 앞이 잘리므로 스트림 좌표계로
        // 환산해야 `since` 가 창 안인지 판정할 수 있다.
        let retained_start = end_offset.saturating_sub(inner.replay.len() as u64);
        let (reset, bytes) = match since {
            Some(since) if since == end_offset => (false, Vec::new()),
            Some(since) if since >= retained_start && since < end_offset => (
                false,
                inner.replay.bytes_from((since - retained_start) as usize),
            ),
            _ => {
                let mut bytes = dec_mode_preamble(&inner.dec_modes);
                let mut snapshot = inner.replay.snapshot();
                bytes.append(&mut snapshot);
                (true, bytes)
            }
        };
        Screen {
            end_offset,
            reset,
            cols,
            rows,
            bytes,
        }
    }

    /// 현재 상태 스냅샷.
    pub fn stats(&self) -> SessionStats {
        let inner = self.shared.inner.lock().unwrap();
        SessionStats {
            bytes_out: inner.bytes_out,
            pending: inner.flow.pending(),
            paused: inner.flow.is_paused(),
            osc_count: inner.osc_count,
            last_osc: inner.last_osc.clone(),
            alive: inner.alive,
        }
    }

    /// 세션을 종료한다: 자식 프로세스 kill + 리더 스레드 정리 + PTY fd 회수.
    /// 멱등 — 두 번째 호출부터는 아무것도 하지 않는다 (waiter 가 자연 종료를
    /// 먼저 관측해 killed 를 올린 뒤의 호출도 no-op).
    ///
    /// `on_exit` 는 여기서 호출하지 않는다 — kill 로 죽인 자식도 waiter 의
    /// `child.wait()` 를 반환시키므로, 자연 종료·kill 어느 경로든 **waiter 가
    /// 단독으로 정확히 1회** 호출한다 ([`waiter_loop`] 참조).
    pub fn kill(&self) {
        {
            let mut inner = self.shared.inner.lock().unwrap();
            if inner.killed {
                return;
            }
            inner.killed = true;
        }
        // paused 로 condvar 대기 중인 리더 스레드를 깨워 종료 경로로 보낸다.
        self.shared.cond.notify_all();

        // 자식이 방금 자연 종료했다면(waiter 가 아직 관측 전) 신호 전송이 실패
        // (ESRCH 등)할 수 있다. "프로세스가 죽어 있어야 한다"는 의도는 이미
        // 충족된 상태이므로 이 에러는 무시한다 (멱등 kill — 에러 은폐가 아님).
        let _ = self.killer.lock().unwrap().kill();

        // writer/master 를 즉시 drop 해 우리가 쥔 PTY fd 를 회수한다. waiter 도
        // wait 반환 후 같은 drop 을 수행하지만 Option take 라 이중 drop 은 없다
        // — 여기서는 회수 시점을 앞당길 뿐이다. 리더 스레드의 복제 reader 는
        // 스레드 종료 시 함께 drop 된다.
        *self.writer.lock().unwrap() = None;
        *self.master.lock().unwrap() = None;
    }
}

impl Drop for PtySession {
    /// 핸들이 사라질 때 자원(자식 프로세스·PTY fd)을 남기지 않는다.
    fn drop(&mut self) {
        self.kill();
    }
}

/// 리더 스레드 본체 — 출력 파이프라인 전담. 종료 시(EOF·read 에러·killed) 그냥
/// 리턴한다 — exit 관측·`on_exit`·alive 갱신·자식 회수(reap)는 전부 waiter 몫이다
/// ([`waiter_loop`]).
fn reader_loop(mut reader: Box<dyn Read + Send>, sink: Arc<dyn SessionSink>, shared: Arc<Shared>) {
    let mut scanner = OscScanner::new();
    let mut buf = [0u8; READ_BUF_BYTES];
    loop {
        // Pause 상태면 read 를 하지 않고 여기서 대기한다 — OS 파이프가 차면서
        // 자식 프로세스까지 backpressure 가 전파된다. kill·reattach 시에도 깨어난다.
        {
            let mut inner = shared.inner.lock().unwrap();
            while inner.flow.is_paused() && !inner.killed {
                inner = shared.cond.wait(inner).unwrap();
            }
            if inner.killed {
                break;
            }
        }

        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // 자식 종료 시 Unix 에서는 EOF 대신 EIO 가 오는 경우가 많다 —
            // 어느 쪽이든 "출력 끝"이므로 종료 처리로 넘어간다.
            Err(_) => break,
        };
        let chunk = &buf[..n];

        // 계약 순서: feed → on_osc(lock 밖) → [lock 안: osc 계정 → 모드 추적 →
        // offset 캡처 → replay.push → flow.on_sent → bytes_out += n] →
        // on_output(lock 밖).
        let events = scanner.feed(chunk);
        // 모드·리셋은 세션이 **소비**한다 — OSC 가 아니라서 sink 로도, osc 계정
        // 으로도 가지 않는다 (모듈 rustdoc 1단계).
        let (mode_events, osc_events): (Vec<OscEvent>, Vec<OscEvent>) =
            events.into_iter().partition(|event| {
                matches!(
                    event,
                    OscEvent::DecPrivateMode { .. } | OscEvent::TerminalReset { .. }
                )
            });
        // 표식 반영이 sink 콜백보다 앞서는 이유는 `Inner::startup_seen` 주석에 있다.
        if osc_events.contains(&OscEvent::Osc777Started) {
            let mut inner = shared.inner.lock().unwrap();
            if !inner.startup_seen {
                inner.startup_seen = true;
                drop(inner);
                shared.cond.notify_all();
            }
        }
        for event in &osc_events {
            sink.on_osc(event);
        }
        let offset = {
            let mut inner = shared.inner.lock().unwrap();
            inner.osc_count += osc_events.len() as u64;
            if let Some(event) = osc_events.last() {
                inner.last_osc = Some(summarize_osc(event));
            }
            for event in &mode_events {
                apply_mode_event(&mut inner.dec_modes, event);
            }
            // 이 chunk 의 시작 오프셋 — bytes_out 가산 전에 캡처해야 한다.
            let offset = inner.bytes_out;
            inner.replay.push(chunk);
            // Pause 지시는 다음 루프 상단의 is_paused 검사로 집행되므로
            // 반환 액션에 별도 분기가 필요 없다.
            let _ = inner.flow.on_sent(n);
            inner.bytes_out += n as u64;
            offset
        };
        // sink 콜백은 lock 밖에서 — 콜백이 ack() 등을 재진입 호출해도 안전하다.
        if sink.on_output(offset, chunk) == Delivery::Dropped {
            // 전달되지 않은 chunk 는 flow 계정을 보상 롤백해 미전달 바이트로
            // 계상한다 (detach 모드 — 잔여 pending 에 따라 paused 휴면이 남을 수
            // 있으며 회복은 reattach/kill, trait 문서 참조). on_sent 를 on_output
            // 뒤로 미루는 재배열 대신 롤백을 쓰는 이유: on_output 이 먼저면
            // 콜백 경로에서 유발된 ack 이 on_sent 보다 먼저 도착하는 경합에서
            // saturating_sub 가 그 ack 을 소실시켜 pending 이 영구 누수(래칫)
            // 된다. on_sent 선행을 유지한 채 미전달분만 롤백하면 그 경합이
            // 원천적으로 없다. 롤백이 Resume 을 반환해도 리더 자신이 루프
            // 상단에서 is_paused 를 재검사하므로 별도 notify 는 불필요하다.
            let mut inner = shared.inner.lock().unwrap();
            let _ = inner.flow.on_acked(n);
        }
    }
}

/// waiter 스레드 본체 — 세션 수명 전담. 자연 종료·kill 어느 경로든
/// `child.wait()` 가 반환하면 종료 시퀀스를 수행한다.
///
/// `sink.on_exit` 는 **이 스레드만** 호출한다 — 리더도 `kill()` 도 호출 경로가
/// 아니므로 "세션당 정확히 1회" 계약이 코드 구조로 보장된다.
///
/// 순서가 중요하다 (모듈 rustdoc "스레드 구조와 종료 감지"):
/// 1. lock 안에서 alive=false·killed=true — stats 관측과 리더 탈출 지시를 한
///    시점에 확정한다.
/// 2. `notify_all` — paused 로 condvar 대기 중인 리더를 깨워 탈출시킨다.
/// 3. writer·master drop — ConPTY 는 자식이 죽어도 출력 파이프를 EOF 시키지
///    않으므로 master drop(=`ClosePseudoConsole`)으로 블록된 read 를 에러로
///    풀어야 리더가 탈출한다. 이게 Windows 자연 종료 감지의 핵심이다 (Unix 는
///    EOF/EIO 로 이미 탈출하므로 fd 회수만 담당). kill() 경로에서는 이미 None
///    일 수 있다 — Option take 라 이중 drop 없음.
/// 4. `sink.on_exit(code)` — lock 밖에서 호출한다.
///
/// killed=true 지시와 리더의 잔여 read 사이 경합으로, 자식이 종료 직전 파이프에
/// 남긴 tail 출력 일부가 전달되지 않을 수 있다 — 종료 감지의 확실성(리더 블록
/// 해제)을 tail 완전 배출보다 우선한 트레이드오프다.
fn waiter_loop(
    mut child: Box<dyn Child + Send + Sync>,
    sink: Arc<dyn SessionSink>,
    shared: Arc<Shared>,
    writer: SharedWriter,
    master: SharedMaster,
) {
    // 자식을 회수(reap)해 exit code 를 얻는다. kill 경로에서는 신호가 이미
    // 전송됐으므로 곧 반환된다. wait 실패 시 code 는 알 수 없음(None).
    let code = child.wait().ok().map(|status| status.exit_code());
    {
        let mut inner = shared.inner.lock().unwrap();
        inner.alive = false;
        inner.killed = true;
    }
    shared.cond.notify_all();
    *writer.lock().unwrap() = None;
    *master.lock().unwrap() = None;
    sink.on_exit(code);
}

/// 시작 표식 감시 — 마감까지 표식이 없으면 sink 에 한 번 알리고 끝난다.
/// **세션을 죽이지 않는다** (계약은 [`SessionOptions::startup_deadline`] rustdoc).
///
/// 마감을 절대 시각으로 잡는 이유: `wait_timeout` 에 매번 전체 마감을 넘기면 spurious
/// wakeup 마다 타이머가 처음부터 다시 시작해 마감이 무한정 밀린다.
///
/// 깨어날 조건이 세 경로(표식 도착·kill·자연 종료) 모두에서 통지된다는 전제 위에
/// 선다 — 리더는 표식을 보면, `kill()` 과 waiter 는 `killed` 를 올리면서 각각
/// `notify_all` 한다. predicate 를 매번 재검사하므로 통지가 wait 보다 먼저 와도
/// 놓치지 않는다.
fn startup_watchdog(deadline: Duration, sink: Arc<dyn SessionSink>, shared: Arc<Shared>) {
    // env 로 임의의 밀리초를 받을 수 있어(`host.rs`) 덧셈이 시계 표현 범위를 넘길 수
    // 있다. panic 하면 그 세션만 조용히 감시에서 빠지므로 loud 하게 알리고 물러난다.
    let Some(mark) = Instant::now().checked_add(deadline) else {
        eprintln!("[mast] startup deadline {deadline:?} overflows the clock; not watching");
        return;
    };
    let mut inner = shared.inner.lock().unwrap();
    loop {
        if inner.startup_seen || inner.killed {
            return;
        }
        let remaining = mark.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let (guard, _) = shared.cond.wait_timeout(inner, remaining).unwrap();
        inner = guard;
    }
    drop(inner);
    sink.on_startup_timeout();
}

/// stats 표시용 OSC 요약 문자열 (예: "777:title").
fn summarize_osc(event: &OscEvent) -> String {
    match event {
        OscEvent::Osc0Title(title) => format!("0:{title}"),
        OscEvent::Osc7Cwd(uri) => format!("7:{uri}"),
        OscEvent::Osc9Notify(message) => format!("9:{message}"),
        OscEvent::Osc777Notify { title, .. } => format!("777:{title}"),
        // 전송 payload(base64)는 요약에 싣지 않는다 — 대상만 있으면 충분하고,
        // stats 문자열에 사용자 텍스트를 흘릴 이유가 없다.
        OscEvent::Osc777Send { target, .. } => format!("777-send:{target}"),
        // 질의도 같은 규율 — 종류만 싣고 회신 **경로는 싣지 않는다** (로그·stats
        // 에 파일시스템 경로를 흘릴 이유가 없다).
        OscEvent::Osc777Query { kind, .. } => format!("777-query:{kind}"),
        OscEvent::Osc777Started => "777-started".to_string(),
        // 색상 질의는 코드(10 = 전경, 11 = 배경)만으로 관측이 끝난다.
        OscEvent::OscColorQuery { code } => format!("color-query:{code}"),
        // 아래 둘은 OSC 가 아니라 리더가 소비하므로 `last_osc` 에 실리지 않는다.
        // 형식만 정의해 둔다 — 나중에 이 요약을 다른 곳에서 쓰게 돼도 조용히
        // 틀리지 않게.
        OscEvent::DecPrivateMode { modes, set } => {
            let verb = if *set { "set" } else { "reset" };
            format!("dec-mode-{verb}:{modes:?}")
        }
        OscEvent::TerminalReset { soft } => {
            let kind = if *soft { "soft" } else { "hard" };
            format!("terminal-reset:{kind}")
        }
    }
}

/// 모드 이벤트를 추적 맵에 반영한다. **정책은 여기 있고 스캐너에는 없다** —
/// 스캐너는 바이트를 알아볼 뿐이고, 무엇을 기억해 둘지는 세션의 판단이다.
fn apply_mode_event(modes: &mut BTreeMap<u16, bool>, event: &OscEvent) {
    match event {
        OscEvent::DecPrivateMode {
            modes: touched,
            set,
        } => {
            for &mode in touched {
                if UNTRACKED_DEC_MODES.contains(&mode) {
                    continue;
                }
                // 새 모드는 상한까지만 받는다. 이미 아는 모드의 값 갱신은 맵을
                // 키우지 않으므로 상한과 무관하게 통과시킨다 — 상한에 걸린 뒤
                // 추적 중인 모드가 옛 값으로 굳는 쪽이 더 나쁘다.
                if !modes.contains_key(&mode) && modes.len() >= MAX_TRACKED_DEC_MODES {
                    continue;
                }
                modes.insert(mode, *set);
            }
        }
        // 리셋 뒤에도 옛 값을 들고 있으면 재-attach 가 이미 꺼진 모드를 되살린다.
        // 지우는 범위는 리셋의 종류를 따른다 — RIS 는 단말 전체, DECSTR 은
        // `SOFT_RESET_DEC_MODES` 만.
        OscEvent::TerminalReset { soft } => {
            if *soft {
                modes.retain(|mode, _| !SOFT_RESET_DEC_MODES.contains(mode));
            } else {
                modes.clear();
            }
        }
        // 나머지는 이 함수의 호출자가 걸러 낸다 (리더 루프의 partition).
        _ => {}
    }
}

/// 재-attach 때 새 터미널에 모드를 다시 세우는 바이트열. 모드 번호 오름차순이라
/// 같은 맵이면 같은 바이트열이 나온다.
fn dec_mode_preamble(modes: &BTreeMap<u16, bool>) -> Vec<u8> {
    let mut out = Vec::new();
    for (mode, set) in modes {
        out.extend_from_slice(b"\x1b[?");
        out.extend_from_slice(mode.to_string().as_bytes());
        out.push(if *set { b'h' } else { b'l' });
    }
    out
}

/// `PtySession::size` 의 패킹 — cols 를 상위 16비트, rows 를 하위 16비트에 둔다.
fn pack_size(cols: u16, rows: u16) -> u32 {
    ((cols as u32) << 16) | rows as u32
}

fn unpack_size(packed: u32) -> (u16, u16) {
    ((packed >> 16) as u16, packed as u16)
}

/// 세션 레지스트리 — `SessionId` 를 발급하고 세션을 보관한다. 내부 동기화는
/// std Mutex (외부 lock 없이 스레드 간 공유 가능).
pub struct SessionManager {
    next_id: Mutex<SessionId>,
    sessions: Mutex<HashMap<SessionId, Arc<PtySession>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            next_id: Mutex::new(1),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 세션을 생성한다: id 를 먼저 발급하고, 그 id 로 `make_sink` 를 호출해 sink 를
    /// 만든 뒤 스폰·등록한다. sink 가 자기 세션의 id 를 알아야 하는 경우(이벤트에
    /// id 를 실어 보내는 글루)를 순환 없이 지원하기 위한 factory 시그니처다.
    ///
    /// 스폰이 실패하면 발급된 id 는 그대로 버려진다 — id 는 재사용하지 않는
    /// 휘발성 카운터라 구멍이 나도 무해하다.
    pub fn create(
        &self,
        spec: SpawnSpec,
        opts: SessionOptions,
        make_sink: impl FnOnce(SessionId) -> Box<dyn SessionSink>,
    ) -> anyhow::Result<SessionId> {
        let id = {
            let mut next = self.next_id.lock().unwrap();
            let id = *next;
            *next += 1;
            id
        };
        let sink = make_sink(id);
        let session = PtySession::spawn(spec, sink, opts)?;
        self.sessions.lock().unwrap().insert(id, Arc::new(session));
        Ok(id)
    }

    pub fn get(&self, id: SessionId) -> Option<Arc<PtySession>> {
        self.sessions.lock().unwrap().get(&id).cloned()
    }

    /// 세션을 레지스트리에서 제거하고 kill 한다. 존재했으면 true.
    pub fn remove(&self, id: SessionId) -> bool {
        // kill 은 sessions lock 을 놓은 뒤 수행한다 — sink 콜백·wait 지연이
        // 레지스트리 전체를 잡아두지 않게.
        let removed = self.sessions.lock().unwrap().remove(&id);
        match removed {
            Some(session) => {
                session.kill();
                true
            }
            None => false,
        }
    }

    /// 전체 세션의 (id, stats) 목록 — id 오름차순.
    pub fn stats(&self) -> Vec<(SessionId, SessionStats)> {
        // 세션별 stats lock 을 잡는 동안 레지스트리 lock 을 들고 있지 않도록
        // (id, 핸들) 쌍만 먼저 복사한다.
        let sessions: Vec<(SessionId, Arc<PtySession>)> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(id, session)| (*id, Arc::clone(session)))
            .collect();
        let mut stats: Vec<(SessionId, SessionStats)> = sessions
            .into_iter()
            .map(|(id, session)| (id, session.stats()))
            .collect();
        stats.sort_by_key(|&(id, _)| id);
        stats
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc_summaries_carry_no_user_payload() {
        // stats 표시용 요약은 종류·대상만 싣는다 — 전송 텍스트와 회신 경로는
        // 사용자 데이터라 이 문자열(로그·stats 표면)에 흘리지 않는다.
        assert_eq!(
            summarize_osc(&OscEvent::Osc777Send {
                target: "build".into(),
                text_b64: "Y2FyZ28gdGVzdAo=".into(),
            }),
            "777-send:build"
        );
        let summary = summarize_osc(&OscEvent::Osc777Query {
            kind: "list-tabs".into(),
            reply_b64: "L3RtcC9tYXN0LXRhYnMtNDIuanNvbg==".into(),
        });
        assert_eq!(summary, "777-query:list-tabs");
        assert!(!summary.contains("tmp"), "회신 경로가 요약에 실렸다: {summary}");
        // 기존 종류의 요약 형태는 그대로다 (회귀 잠금).
        assert_eq!(
            summarize_osc(&OscEvent::Osc777Notify {
                title: "mast:idle".into(),
                body: "done".into(),
            }),
            "777:mast:idle"
        );
        assert_eq!(summarize_osc(&OscEvent::Osc0Title("t".into())), "0:t");
        // 색상 질의 — 코드만.
        assert_eq!(
            summarize_osc(&OscEvent::OscColorQuery { code: 11 }),
            "color-query:11"
        );
    }

    fn dec(modes: &[u16], set: bool) -> OscEvent {
        OscEvent::DecPrivateMode {
            modes: modes.to_vec(),
            set,
        }
    }

    fn preamble_after(events: &[OscEvent]) -> Vec<u8> {
        let mut modes = BTreeMap::new();
        for event in events {
            apply_mode_event(&mut modes, event);
        }
        dec_mode_preamble(&modes)
    }

    #[test]
    fn preamble_reasserts_last_value_per_mode_in_ascending_order() {
        // 같은 모드를 여러 번 건드리면 마지막 값만 남고, 순서는 모드 번호순이다.
        assert_eq!(
            preamble_after(&[
                dec(&[2004], true),
                dec(&[25], false),
                dec(&[1000, 1006], true),
                dec(&[1000], false),
            ]),
            b"\x1b[?25l\x1b[?1000l\x1b[?1006h\x1b[?2004h".to_vec()
        );
        assert!(preamble_after(&[]).is_empty());
    }

    #[test]
    fn transition_modes_are_never_tracked() {
        // 대체 화면·커서 저장·synchronized output 은 설정이 아니라 전이라서
        // preamble 로 다시 세우는 것 자체가 틀린 동작이다 (const 주석).
        for mode in UNTRACKED_DEC_MODES {
            assert!(
                preamble_after(&[dec(&[mode], true)]).is_empty(),
                "{mode} must not be tracked"
            );
            assert!(
                preamble_after(&[dec(&[mode], false)]).is_empty(),
                "{mode} must not be tracked"
            );
        }
        // 같은 시퀀스에 섞여 와도 나머지 모드만 남는다.
        assert_eq!(
            preamble_after(&[dec(&[1049, 25, 2026], true)]),
            b"\x1b[?25h".to_vec()
        );
    }

    #[test]
    fn a_hard_reset_clears_every_tracked_mode() {
        let reset = OscEvent::TerminalReset { soft: false };
        assert!(preamble_after(&[dec(&[1000, 2004], true), reset.clone()]).is_empty());
        // 리셋 이후에 세운 모드는 다시 추적된다.
        assert_eq!(
            preamble_after(&[dec(&[1000], true), reset, dec(&[25], false)]),
            b"\x1b[?25l".to_vec()
        );
    }

    #[test]
    fn a_soft_reset_clears_only_the_modes_decstr_resets() {
        // DECSTR 은 마우스 트래킹을 건드리지 않으므로 1000/1002/1006 은 살아남고,
        // bracketed paste(2004)·커서 표시(25)는 기본값으로 돌아간다 (const 주석).
        assert_eq!(
            preamble_after(&[
                dec(&[1000, 1002, 1006], true),
                dec(&[2004], true),
                dec(&[25], false),
                OscEvent::TerminalReset { soft: true },
            ]),
            b"\x1b[?1000h\x1b[?1002h\x1b[?1006h".to_vec()
        );
    }

    #[test]
    fn tracked_mode_count_is_capped_but_known_modes_keep_updating() {
        let mut modes = BTreeMap::new();
        for mode in 1..=(MAX_TRACKED_DEC_MODES as u16 + 10) {
            apply_mode_event(&mut modes, &dec(&[mode], true));
        }
        assert_eq!(modes.len(), MAX_TRACKED_DEC_MODES);
        // 상한에 걸린 뒤에도 이미 아는 모드의 값 갱신은 통과해야 한다 —
        // 그러지 않으면 추적 중인 모드가 옛 값으로 굳는다.
        apply_mode_event(&mut modes, &dec(&[1], false));
        assert_eq!(modes.get(&1), Some(&false));
        assert_eq!(modes.len(), MAX_TRACKED_DEC_MODES);
    }
}
