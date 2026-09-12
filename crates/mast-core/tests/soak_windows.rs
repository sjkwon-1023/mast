//! Windows ConPTY resource soak — create / close(kill) / respawn a `PtySession`
//! several hundred times and check that the process's resources come back to
//! where they started.
//!
//! 이 파일이 재는 것은 [`mast_core::session::PtySession`] 하나뿐이다. 앱의
//! `SessionManager`·`SinkRegistry`·Tauri 글루는 범위 밖이라, 여기가 green 이어도
//! 앱 수준 누수는 여전히 가능하다 — 반대로 여기가 red 면 원인은 코어나
//! `portable-pty`/ConPTY 쪽에 있다는 뜻이라 조사 범위가 좁아진다.
//!
//! 판정 기준은 **절대값이 아니라 복귀**다. 핸들·스레드·private bytes 가 얼마인지가
//! 아니라, 수백 사이클을 돌고 난 뒤 baseline 으로 돌아왔는지를 본다 — 사이클 안에서
//! 값이 오르내리는 것은 정상이고(ConPTY 는 conhost 프로세스를 동반한다), 사이클이
//! 끝난 뒤에도 남아 있는 것만이 누수다.
//!
//! 기본 `cargo test` 에서는 돌지 않는다(`#[ignore]`). 실행:
//!
//! ```text
//! cargo test -p mast-core --release --test soak_windows -- --ignored --nocapture
//! ```
//!
//! 조정은 전부 env 로 한다 — `MAST_SOAK_CYCLES`, `MAST_SOAK_MODE`,
//! `MAST_SOAK_SAMPLE_EVERY`, `MAST_SOAK_WARMUP`, `MAST_SOAK_SETTLE_SECS`,
//! `MAST_SOAK_CSV`, `MAST_SOAK_HANDLE_SLACK`, `MAST_SOAK_THREAD_SLACK`,
//! `MAST_SOAK_PRIVATE_SLACK_MB`. 목록과 의미는 `docs/WINDOWS-BUILD.md` 의
//! "PTY resource soak test" 절에 있다.
#![cfg(windows)]

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use mast_core::osc::OscEvent;
use mast_core::session::{Delivery, PtySession, SessionOptions, SessionSink, SpawnSpec};

/// 한 사이클의 `on_exit` 대기 상한. 넘기면 세션이 느린 게 아니라 걸린 것이므로
/// 행(hang)으로 두지 않고 테스트를 실패시킨다 — soak 는 밤새 돌 수도 있어서, 걸린
/// 채 방치되면 아무 보고도 남지 않는다.
const EXIT_TIMEOUT: Duration = Duration::from_secs(60);

/// 패턴 B 가 kill 하기 전에 첫 출력을 기다리는 시간. 출력이 오면 ConPTY 가 실제로
/// 붙은 뒤에 죽이는 것이 보장되고, 안 와도 이 시간이 지나면 그냥 죽인다.
const FIRST_OUTPUT_WAIT: Duration = Duration::from_millis(200);

/// settle 폴링 간격. 기본 상한(30s) 안에 60 표본이 나오는 간격이고, 더 촘촘히 떠도
/// 스레드가 빠져나가는 속도보다 Toolhelp 스냅샷 비용이 먼저 는다.
const SETTLE_POLL: Duration = Duration::from_millis(500);

/// 패턴 B/C 가 죽이는 "오래 사는" 프로그램의 수명(초). settle 상한보다 확실히 짧아야
/// 한다 — kill 이 WSL 릴레이를 즉시 회수하지 못하면 남은 프로세스는 이 시간 안에
/// 스스로 사라지고, 그 뒤에도 남아 있는 것만이 누수다. 수명이 settle 상한과 비슷하면
/// "새는 것"과 "아직 제 수명을 못 채운 것"을 구분할 수 없어 판정이 거짓 FAIL 이 된다.
const LONG_LIVED_SECS: &str = "5";

/// PTY 창 크기 — 앱의 기본과 같을 필요는 없다. 출력량만 정하는 값이다.
const COLS: u16 = 80;
const ROWS: u16 = 24;

/// 개수를 세는 이미지명 (대소문자 무시). ConPTY 는 conhost/OpenConsole 을,
/// WSL 모드는 wsl/wslhost/wslrelay 를 동반한다 — 사이클이 끝난 뒤에도 남아 있으면
/// 그것이 이 테스트가 찾는 좀비다.
const WATCHED: [&str; 5] = [
    "conhost.exe",
    "OpenConsole.exe",
    "wsl.exe",
    "wslhost.exe",
    "wslrelay.exe",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// `wsl.exe --exec …` — 실제 앱이 쓰는 경로. WSL 릴레이까지 포함해 잰다.
    Wsl,
    /// `cmd.exe` — WSL 을 빼고 ConPTY 자체만 빠르게 돈다.
    Cmd,
}

struct Config {
    cycles: u32,
    mode: Mode,
    sample_every: u32,
    warmup: u32,
    settle: Duration,
    csv: Option<PathBuf>,
    handle_slack: u32,
    thread_slack: u32,
    private_slack_bytes: u64,
}

impl Config {
    fn from_env() -> Self {
        let mode = match env::var("MAST_SOAK_MODE").as_deref() {
            Ok("wsl") | Err(_) => Mode::Wsl,
            Ok("cmd") => Mode::Cmd,
            Ok(other) => panic!("MAST_SOAK_MODE must be 'wsl' or 'cmd' (got {other:?})"),
        };
        Self {
            cycles: env_u32("MAST_SOAK_CYCLES", 500),
            mode,
            sample_every: env_u32("MAST_SOAK_SAMPLE_EVERY", 25).max(1),
            warmup: env_u32("MAST_SOAK_WARMUP", 10),
            settle: Duration::from_secs(env_u64("MAST_SOAK_SETTLE_SECS", 30)),
            csv: env::var_os("MAST_SOAK_CSV").map(PathBuf::from),
            handle_slack: env_u32("MAST_SOAK_HANDLE_SLACK", 16),
            thread_slack: env_u32("MAST_SOAK_THREAD_SLACK", 4),
            private_slack_bytes: env_u64("MAST_SOAK_PRIVATE_SLACK_MB", 32)
                .saturating_mul(1024 * 1024),
        }
    }
}

/// 잘못 적은 env 는 기본값으로 삼키지 않고 즉시 실패시킨다 — 조용히 다른 설정으로
/// 돈 soak 의 결과는 읽을 수 없다.
fn env_u64(name: &str, default: u64) -> u64 {
    match env::var(name) {
        Err(_) => default,
        Ok(raw) => raw
            .trim()
            .parse::<u64>()
            .unwrap_or_else(|err| panic!("{name} must be a non-negative integer ({err}): {raw:?}")),
    }
}

/// 32비트 카운터용. 범위를 벗어난 값을 잘라내면 `MAST_SOAK_CYCLES=4294967296` 이 0
/// 사이클(= 아무것도 안 재고 PASS)이 되고 `MAST_SOAK_SAMPLE_EVERY` 는 0 으로 나누기가
/// 되므로, 잘라내지 않고 위 규칙대로 실패시킨다.
fn env_u32(name: &str, default: u32) -> u32 {
    let raw = env_u64(name, u64::from(default));
    u32::try_from(raw).unwrap_or_else(|_| panic!("{name} must be at most {}: {raw}", u32::MAX))
}

/// 사이클 패턴. 셋을 번갈아 돌려 종료 경로 세 가지를 모두 지나간다.
#[derive(Debug, Clone, Copy)]
enum Kind {
    /// 즉시 끝나는 프로그램 → 자연 종료 관측 (waiter 경로).
    NaturalExit,
    /// 오래 사는 프로그램 → 붙은 뒤 kill.
    KillAfterOutput,
    /// spawn 직후 즉시 kill — 가장 짧은 수명 (rapid respawn).
    KillImmediately,
}

impl Kind {
    fn of(index: u32) -> Self {
        match index % 3 {
            0 => Kind::NaturalExit,
            1 => Kind::KillAfterOutput,
            _ => Kind::KillImmediately,
        }
    }
}

enum Ev {
    FirstOutput,
    /// conhost 의 커서 위치 질의(`ESC[6n`)가 도착했다 — 답해야 자식이 돈다 (아래).
    CursorQuery,
    Exit,
}

/// ConPTY 가 세션 첫머리에 보내는 커서 위치 질의(DSR). `portable-pty` 는 모든
/// 의사 콘솔을 `PSEUDOCONSOLE_INHERIT_CURSOR` 로 열고, 그러면 conhost 는 이 질의에
/// 대한 응답(CPR, `ESC[<row>;<col>R`)이 올 때까지 **자식 프로세스를 세워 둔다** —
/// 답이 없으면 `cmd.exe /c exit` 조차 끝나지 않아 `child.wait()` 가 영영 돌아오지
/// 않는다 (2026-09-12 첫 Windows 실행에서 0번 사이클이 정확히 이렇게 60초에 걸렸다;
/// 앱은 xterm 이 답해 주므로 같은 문제가 없다 — terminal-view.ts 의 체크포인트 1
/// "빈 화면, bytes_out=4" 사고와 같은 서명). 그래서 이 sink 는 질의를 보면 알리고,
/// 사이클 루프가 xterm 대신 답한다.
const CURSOR_QUERY: &[u8] = b"\x1b[6n";
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

/// 최소 sink. `on_output` 이 `Dropped` 를 돌려주므로 리더가 flow 계정을 스스로
/// 보상 롤백한다 — ack 하는 소비자가 없어도 paused 로 고착되지 않는다.
struct SoakSink {
    tx: Sender<Ev>,
    saw_output: AtomicBool,
}

impl SessionSink for SoakSink {
    fn on_output(&self, _offset: u64, bytes: &[u8]) -> Delivery {
        if !self.saw_output.swap(true, Ordering::Relaxed) {
            let _ = self.tx.send(Ev::FirstOutput);
        }
        // 실측상 질의는 자기 chunk 하나로 온다 (4바이트 첫 read). chunk 경계에 걸치는
        // 경우는 다루지 않는다 — 그러면 사이클이 EXIT_TIMEOUT 에 걸려 실패로 드러난다.
        if bytes.windows(CURSOR_QUERY.len()).any(|w| w == CURSOR_QUERY) {
            let _ = self.tx.send(Ev::CursorQuery);
        }
        Delivery::Dropped
    }
    fn on_osc(&self, _event: &OscEvent) {}
    fn on_exit(&self, _code: Option<u32>) {
        let _ = self.tx.send(Ev::Exit);
    }
}

fn spec(mode: Mode, long_lived: bool) -> SpawnSpec {
    // `cmd.exe /k` 는 스스로 끝나지 않지만 ConPTY 의 직계 자식이라 kill 이 곧 회수다.
    // 중간에 릴레이가 끼는 것은 WSL 쪽뿐이고, 그래서 수명 상한이 필요한 것도 그쪽이다.
    let (program, args): (&str, Vec<&str>) = match (mode, long_lived) {
        (Mode::Wsl, false) => ("wsl.exe", vec!["--exec", "/bin/true"]),
        (Mode::Wsl, true) => ("wsl.exe", vec!["--exec", "sleep", LONG_LIVED_SECS]),
        (Mode::Cmd, false) => ("cmd.exe", vec!["/c", "exit"]),
        (Mode::Cmd, true) => ("cmd.exe", vec!["/k"]),
    };
    SpawnSpec {
        program: program.to_string(),
        args: args.into_iter().map(str::to_string).collect(),
        cwd: None,
        cols: COLS,
        rows: ROWS,
    }
}

fn run_cycle(cfg: &Config, kind: Kind, cycle: u32) {
    let (tx, rx) = mpsc::channel();
    let long_lived = !matches!(kind, Kind::NaturalExit);
    let sink = SoakSink {
        tx,
        saw_output: AtomicBool::new(false),
    };
    let session = PtySession::spawn(
        spec(cfg.mode, long_lived),
        Box::new(sink),
        SessionOptions::default(),
    )
    .unwrap_or_else(|err| panic!("cycle {cycle}: PtySession::spawn failed: {err}"));

    let mut exited = false;
    match kind {
        Kind::NaturalExit => {}
        Kind::KillAfterOutput => {
            // 첫 출력이 오기 전에 프로세스가 끝나 버릴 수도 있다 — 그 경우 여기서
            // 받는 것은 Exit 이고, 아래 wait_exit 를 건너뛰어야 영영 기다리지 않는다.
            // 질의는 첫 출력 그 자체이므로 여기서도 답한다.
            let deadline = Instant::now() + FIRST_OUTPUT_WAIT;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(left) {
                    Ok(Ev::CursorQuery) => {
                        answer_cursor_query(&session);
                        continue;
                    }
                    Ok(Ev::Exit) => exited = true,
                    Ok(Ev::FirstOutput) => {
                        // 첫 출력이 곧 질의다 — 같은 chunk 의 CursorQuery 가 바로 뒤에
                        // 줄 서 있으므로 kill 전에 꺼내 답한다. 순서를 지키지 않으면
                        // 답장이 죽은 세션에 가고, 실측상 그것 자체는 무해하지만
                        // "kill 뒤 질의 응답" 이라는 잡음이 사이클 셋마다 남는다.
                        while let Ok(Ev::CursorQuery) = rx.try_recv() {
                            answer_cursor_query(&session);
                        }
                    }
                    Err(_) => {}
                }
                break;
            }
            session.kill();
        }
        Kind::KillImmediately => session.kill(),
    }
    if !exited {
        wait_exit(&session, &rx, cycle);
    }
    // 명시적 drop — Drop 이 kill 을 한 번 더 부르고(멱등) master·writer 를 회수한다.
    drop(session);
}

/// conhost 의 커서 위치 질의에 xterm 대신 답한다 (`CURSOR_QUERY` 주석). 쓰기 실패는
/// 세션이 이미 죽었거나 kill 된 뒤라는 뜻이라 무시한다 — 그 exit 은 곧 채널로 온다.
fn answer_cursor_query(session: &PtySession) {
    let _ = session.write(CURSOR_REPLY);
}

fn wait_exit(session: &PtySession, rx: &Receiver<Ev>, cycle: u32) {
    let deadline = Instant::now() + EXIT_TIMEOUT;
    loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or_else(|| {
                panic!(
                    "cycle {cycle}: on_exit was not called within {}s — the session is hung, \
                     not slow; stopping here rather than hanging the soak",
                    EXIT_TIMEOUT.as_secs()
                )
            });
        match rx.recv_timeout(left) {
            Ok(Ev::Exit) => return,
            Ok(Ev::CursorQuery) => answer_cursor_query(session),
            Ok(Ev::FirstOutput) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                panic!("cycle {cycle}: the sink was dropped before on_exit fired")
            }
        }
    }
}

#[derive(Debug, Clone)]
struct Sample {
    phase: &'static str,
    cycle: u32,
    elapsed_ms: u128,
    handles: u32,
    threads: u32,
    private_bytes: u64,
    working_set: u64,
    procs: [u32; WATCHED.len()],
    kernel_paged: u64,
    kernel_nonpaged: u64,
}

impl Sample {
    /// 판정에 쓰이는 카운터가 모두 같은지 — settle 수렴 판단의 기준이다.
    /// 커널 풀과 working set 은 시스템 전체 잡음이라 여기서 뺀다.
    fn judged_eq(&self, other: &Self) -> bool {
        self.handles == other.handles
            && self.threads == other.threads
            && self.private_bytes == other.private_bytes
            && self.procs == other.procs
    }
}

fn take_sample(phase: &'static str, cycle: u32, start: Instant) -> Sample {
    let (private_bytes, working_set) = win::process_memory().unwrap_or_else(|err| panic!("{err}"));
    let (kernel_paged, kernel_nonpaged) = win::kernel_pool().unwrap_or_else(|err| panic!("{err}"));
    Sample {
        phase,
        cycle,
        elapsed_ms: start.elapsed().as_millis(),
        handles: win::handle_count().unwrap_or_else(|err| panic!("{err}")),
        threads: win::thread_count().unwrap_or_else(|err| panic!("{err}")),
        private_bytes,
        working_set,
        procs: win::process_counts(&WATCHED).unwrap_or_else(|err| panic!("{err}")),
        kernel_paged,
        kernel_nonpaged,
    }
}

/// 값이 안정될 때까지 폴링한다. 상한(`MAST_SOAK_SETTLE_SECS`)에 닿으면 마지막 표본을
/// 쓴다. 반환은 `rows` 안의 그 표본 index — 호출측이 phase 를 baseline/final 로 다시
/// 라벨링한다.
///
/// 조기 종료 조건이 두 단계인 이유: "두 번 연속 같다"만으로는 **올라간 채 멈춘** 값도
/// 안정으로 읽힌다. 마지막 kill 직후 아직 빠져나가는 중인 릴레이가 0.5초 간격 두 표본
/// 모두에서 같은 수로 잡히면 그대로 final 이 되고, 프로세스 수는 slack 이 0 이라 스스로
/// 사라졌을 프로세스가 누수로 보고된다. 그래서 `baseline` 이 주어진 final 폴링에서는
/// 판정 카운터가 모두 허용치 안으로 돌아온 표본만 조기 종료로 인정하고, 아니면 상한까지
/// 계속 센다 — 진짜 누수는 상한 뒤에 그대로 FAIL 이고, 늦게 죽는 놈은 기회를 얻는다.
///
/// baseline 에도 이 폴링을 거는 것은 의도적이다. warm-up 마지막 사이클의 스레드가
/// 아직 빠져나가는 중에 baseline 을 잡으면 baseline 이 부풀고, 그만큼 판정이
/// 느슨해져 진짜 누수를 통과시킨다. 기준선은 항상 안정된 값이어야 한다.
fn settle(
    cfg: &Config,
    phase: &'static str,
    cycle: u32,
    start: Instant,
    baseline: Option<&Sample>,
    rows: &mut Vec<Sample>,
) -> usize {
    let deadline = Instant::now() + cfg.settle;
    let mut prev: Option<Sample> = None;
    loop {
        let sample = take_sample(phase, cycle, start);
        rows.push(sample.clone());
        let stable = prev.as_ref().is_some_and(|p| p.judged_eq(&sample));
        let recovered = baseline.is_none_or(|base| violations(cfg, base, &sample).is_empty());
        if (stable && recovered) || Instant::now() >= deadline {
            return rows.len() - 1;
        }
        prev = Some(sample);
        std::thread::sleep(SETTLE_POLL);
    }
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

fn table(rows: &[Sample]) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{:<14} {:>6} {:>10} {:>8} {:>8} {:>11} {:>11} {:>8} {:>12} {:>5} {:>8} {:>9} {:>12} {:>13}",
        "phase",
        "cycle",
        "elapsed_ms",
        "handles",
        "threads",
        "private_MB",
        "workset_MB",
        "conhost",
        "OpenConsole",
        "wsl",
        "wslhost",
        "wslrelay",
        "kpaged_MB",
        "knonpaged_MB",
    );
    for row in rows {
        let _ = writeln!(
            out,
            "{:<14} {:>6} {:>10} {:>8} {:>8} {:>11.2} {:>11.2} {:>8} {:>12} {:>5} {:>8} {:>9} {:>12.2} {:>13.2}",
            row.phase,
            row.cycle,
            row.elapsed_ms,
            row.handles,
            row.threads,
            mb(row.private_bytes),
            mb(row.working_set),
            row.procs[0],
            row.procs[1],
            row.procs[2],
            row.procs[3],
            row.procs[4],
            mb(row.kernel_paged),
            mb(row.kernel_nonpaged),
        );
    }
    out
}

fn csv(rows: &[Sample]) -> String {
    let mut out = String::from(
        "phase,cycle,elapsed_ms,handles,threads,private_bytes,working_set_bytes,\
         conhost,openconsole,wsl,wslhost,wslrelay,kernel_paged_bytes,kernel_nonpaged_bytes\n",
    );
    for row in rows {
        let _ = writeln!(
            out,
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
            row.phase,
            row.cycle,
            row.elapsed_ms,
            row.handles,
            row.threads,
            row.private_bytes,
            row.working_set,
            row.procs[0],
            row.procs[1],
            row.procs[2],
            row.procs[3],
            row.procs[4],
            row.kernel_paged,
            row.kernel_nonpaged,
        );
    }
    out
}

/// baseline 대비 final 의 위반 목록. 비어 있으면 통과다.
fn violations(cfg: &Config, base: &Sample, last: &Sample) -> Vec<String> {
    let mut out = Vec::new();
    if last.handles > base.handles + cfg.handle_slack {
        out.push(format!(
            "handles did not come back: {} -> {} (+{}, slack {})",
            base.handles,
            last.handles,
            last.handles - base.handles,
            cfg.handle_slack
        ));
    }
    if last.threads > base.threads + cfg.thread_slack {
        out.push(format!(
            "threads did not come back: {} -> {} (+{}, slack {})",
            base.threads,
            last.threads,
            last.threads - base.threads,
            cfg.thread_slack
        ));
    }
    if last.private_bytes > base.private_bytes + cfg.private_slack_bytes {
        out.push(format!(
            "private bytes did not come back: {:.2} MB -> {:.2} MB (+{:.2} MB, slack {:.0} MB)",
            mb(base.private_bytes),
            mb(last.private_bytes),
            mb(last.private_bytes - base.private_bytes),
            mb(cfg.private_slack_bytes)
        ));
    }
    for (i, name) in WATCHED.iter().enumerate() {
        if last.procs[i] > base.procs[i] {
            out.push(format!(
                "{name} processes did not come back: {} -> {} (+{}, slack 0)",
                base.procs[i],
                last.procs[i],
                last.procs[i] - base.procs[i]
            ));
        }
    }
    out
}

#[test]
#[ignore = "Windows-only resource soak; hundreds of PTY cycles, run it deliberately"]
fn pty_resource_soak() {
    let cfg = Config::from_env();
    let start = Instant::now();

    println!(
        "mast PTY soak: mode={:?} cycles={} warmup={} sample_every={} settle={}s \
         slack(handles={}, threads={}, private={:.0} MB, processes=0)",
        cfg.mode,
        cfg.cycles,
        cfg.warmup,
        cfg.sample_every,
        cfg.settle.as_secs(),
        cfg.handle_slack,
        cfg.thread_slack,
        mb(cfg.private_slack_bytes),
    );

    let mut rows: Vec<Sample> = Vec::new();

    // 측정 구간을 catch_unwind 로 감싼다. 걸린 세션(on_exit 상한), spawn 실패, Toolhelp
    // 실패는 전부 panic 이고, 그대로 두면 몇 시간 돈 run 이 모아 둔 표가 언와인딩과 함께
    // 사라진다 — 실패했을 때야말로 추이가 필요하다. 표·CSV 를 먼저 내보낸 뒤 원래 panic
    // 을 그대로 되던진다.
    let measured = panic::catch_unwind(AssertUnwindSafe(|| {
        let mut index = 0u32;
        for _ in 0..cfg.warmup {
            run_cycle(&cfg, Kind::of(index), index);
            index += 1;
        }
        let base_at = settle(&cfg, "warmup_settle", index, start, None, &mut rows);
        rows[base_at].phase = "baseline";
        let base = rows[base_at].clone();

        for cycle in 1..=cfg.cycles {
            run_cycle(&cfg, Kind::of(index), index);
            index += 1;
            if cycle % cfg.sample_every == 0 {
                let sample = take_sample("cycle", cycle, start);
                rows.push(sample);
            }
        }

        let final_at = settle(
            &cfg,
            "final_settle",
            cfg.cycles,
            start,
            Some(&base),
            &mut rows,
        );
        rows[final_at].phase = "final";
        (base, rows[final_at].clone())
    }));

    // 표는 통과/실패와 무관하게 항상 낸다.
    println!("\n{}", table(&rows));
    if let Some(path) = &cfg.csv {
        match fs::write(path, csv(&rows)) {
            Ok(()) => println!("CSV written: {}", path.display()),
            // 이미 사이클이 실패한 상태라면 원래 원인을 CSV 실패로 덮지 않는다.
            Err(err) if measured.is_ok() => {
                panic!("failed to write MAST_SOAK_CSV {}: {err}", path.display())
            }
            Err(err) => println!("failed to write MAST_SOAK_CSV {}: {err}", path.display()),
        }
    }

    let (base, last) = match measured {
        Ok(pair) => pair,
        Err(payload) => panic::resume_unwind(payload),
    };

    let violations = violations(&cfg, &base, &last);
    if violations.is_empty() {
        println!(
            "PASS — after {} cycles every counter returned to baseline within its slack.",
            cfg.cycles
        );
    } else {
        panic!(
            "FAIL — after {} cycles {} counter(s) did not return to baseline:\n  {}",
            cfg.cycles,
            violations.len(),
            violations.join("\n  ")
        );
    }
}

/// 프로세스 리소스 측정 — `apps/mast/src-tauri/src/reset_supervisor.rs` 의 `mem`
/// 모듈과 같은 raw FFI 스타일이다(windows-sys + 명시적 CloseHandle).
mod win {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_BAD_LENGTH, ERROR_NO_MORE_FILES, HANDLE,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
        CREATE_TOOLHELP_SNAPSHOT_FLAGS, PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD,
        THREADENTRY32,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetPerformanceInfo, K32GetProcessMemoryInfo, PERFORMANCE_INFORMATION,
        PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};

    /// Toolhelp 스냅샷 재시도 횟수. `CreateToolhelp32Snapshot` 은 스냅샷을 뜨는
    /// 사이에 프로세스/스레드 표가 커지면 `ERROR_BAD_LENGTH` 로 실패하는 것이
    /// 문서화된 동작이고, 권장 대응이 재시도다. soak 는 쉬지 않고 프로세스를
    /// 만들고 죽이므로 이 경합이 실제로 일어난다.
    const SNAPSHOT_RETRIES: u32 = 8;

    /// 재시도 사이의 간격. 쉬지 않고 다시 부르면 여덟 번이 모두 첫 실패를 만든 것과
    /// 같은 마이크로초 단위 churn 안에 들어가 재시도가 재시도 구실을 못 한다.
    const SNAPSHOT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(20);

    fn snapshot(flags: CREATE_TOOLHELP_SNAPSHOT_FLAGS) -> Result<HANDLE, String> {
        for attempt in 0..SNAPSHOT_RETRIES {
            // SAFETY: 반환 핸들은 호출측이 CloseHandle 로 닫는다.
            let handle = unsafe { CreateToolhelp32Snapshot(flags, 0) };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(handle);
            }
            // SAFETY: 실패 직후의 스레드-로컬 에러 코드 조회.
            let err = unsafe { GetLastError() };
            if err != ERROR_BAD_LENGTH {
                return Err(format!("CreateToolhelp32Snapshot failed (err={err})"));
            }
            if attempt + 1 < SNAPSHOT_RETRIES {
                std::thread::sleep(SNAPSHOT_RETRY_DELAY);
            }
        }
        Err(format!(
            "CreateToolhelp32Snapshot kept failing with ERROR_BAD_LENGTH after {SNAPSHOT_RETRIES} tries"
        ))
    }

    pub fn handle_count() -> Result<u32, String> {
        let mut count = 0u32;
        // SAFETY: GetCurrentProcess 는 닫을 필요 없는 의사 핸들이고, count 는 유효한 out 포인터다.
        let ok = unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) };
        if ok == 0 {
            // SAFETY: 실패 직후의 스레드-로컬 에러 코드 조회.
            let err = unsafe { GetLastError() };
            return Err(format!("GetProcessHandleCount failed (err={err})"));
        }
        Ok(count)
    }

    /// 자기 프로세스의 스레드 수. 스레드 스냅샷은 프로세스별로 뜰 수 없어
    /// (TH32CS_SNAPTHREAD 는 th32ProcessID 를 무시한다) 전체를 받아 owner pid 로 거른다.
    pub fn thread_count() -> Result<u32, String> {
        let me = std::process::id();
        let snapshot = snapshot(TH32CS_SNAPTHREAD)?;
        // SAFETY: THREADENTRY32 는 POD — zeroed 후 dwSize 만 채우는 관례 그대로.
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        // SAFETY: 유효한 스냅샷 핸들과 dwSize 초기화된 entry.
        let mut ok = unsafe { Thread32First(snapshot, &mut entry) };
        if ok == 0 {
            // SAFETY: 실패 직후의 스레드-로컬 에러 코드 조회.
            let err = unsafe { GetLastError() };
            // SAFETY: 위에서 연 스냅샷 핸들.
            unsafe { CloseHandle(snapshot) };
            // 빈 스냅샷은 우리 스레드조차 못 봤다는 뜻이라 0 으로 넘기지 않는다.
            return Err(format!("Thread32First failed (err={err})"));
        }
        let mut count = 0u32;
        while ok != 0 {
            if entry.th32OwnerProcessID == me {
                count += 1;
            }
            // SAFETY: 위와 동일.
            ok = unsafe { Thread32Next(snapshot, &mut entry) };
        }
        // SAFETY: 위에서 연 스냅샷 핸들.
        unsafe { CloseHandle(snapshot) };
        Ok(count)
    }

    /// 자기 프로세스의 (PrivateUsage, WorkingSetSize).
    pub fn process_memory() -> Result<(u64, u64), String> {
        // SAFETY: POD zeroed + cb 설정 후, EX 구조체를 기본 카운터 포인터로 넘기는
        // 문서화된 관례 (cb 로 실제 크기를 알린다).
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = unsafe {
            K32GetProcessMemoryInfo(
                GetCurrentProcess(),
                std::ptr::from_mut(&mut counters).cast::<PROCESS_MEMORY_COUNTERS>(),
                counters.cb,
            )
        };
        if ok == 0 {
            // SAFETY: 실패 직후의 스레드-로컬 에러 코드 조회.
            let err = unsafe { GetLastError() };
            return Err(format!("K32GetProcessMemoryInfo failed (err={err})"));
        }
        Ok((counters.PrivateUsage as u64, counters.WorkingSetSize as u64))
    }

    /// 시스템 전체 커널 풀 (paged, nonpaged) bytes. **보고용**이다 — 머신 전체가
    /// 공유하는 값이라 이 프로세스가 원인인지 가릴 수 없어 판정에 쓰지 않는다.
    pub fn kernel_pool() -> Result<(u64, u64), String> {
        // SAFETY: POD zeroed + cb 설정.
        let mut info: PERFORMANCE_INFORMATION = unsafe { std::mem::zeroed() };
        info.cb = std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32;
        // SAFETY: 유효한 out 포인터와 그 크기.
        let ok = unsafe { K32GetPerformanceInfo(&mut info, info.cb) };
        if ok == 0 {
            // SAFETY: 실패 직후의 스레드-로컬 에러 코드 조회.
            let err = unsafe { GetLastError() };
            return Err(format!("K32GetPerformanceInfo failed (err={err})"));
        }
        let page = info.PageSize as u64;
        Ok((
            info.KernelPaged as u64 * page,
            info.KernelNonpaged as u64 * page,
        ))
    }

    /// 이미지명별 프로세스 수 (대소문자 무시). 시스템 전체를 세므로 다른 터미널이
    /// 띄운 conhost 도 함께 잡힌다 — 그래서 절대값이 아니라 baseline 대비 증가만 본다.
    pub fn process_counts<const N: usize>(names: &[&str; N]) -> Result<[u32; N], String> {
        let snapshot = snapshot(TH32CS_SNAPPROCESS)?;
        // SAFETY: PROCESSENTRY32W 는 POD — zeroed 후 dwSize 만 채우는 관례 그대로.
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        // SAFETY: 유효한 스냅샷 핸들과 dwSize 초기화된 entry.
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
        let mut counts = [0u32; N];
        if ok == 0 {
            // SAFETY: 실패 직후의 스레드-로컬 에러 코드 조회.
            let err = unsafe { GetLastError() };
            // SAFETY: 위에서 연 스냅샷 핸들.
            unsafe { CloseHandle(snapshot) };
            if err == ERROR_NO_MORE_FILES {
                return Ok(counts);
            }
            return Err(format!("Process32FirstW failed (err={err})"));
        }
        while ok != 0 {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
            for (i, name) in names.iter().enumerate() {
                if exe.eq_ignore_ascii_case(name) {
                    counts[i] += 1;
                }
            }
            // SAFETY: 위와 동일.
            ok = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        // SAFETY: 위에서 연 스냅샷 핸들.
        unsafe { CloseHandle(snapshot) };
        Ok(counts)
    }
}
