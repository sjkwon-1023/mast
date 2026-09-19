//! PtySession unix 통합 테스트 — 실제 `sh` 를 PTY 로 띄워 계약을 검증한다.
//! 계약은 `mast_core::session` 모듈 rustdoc 이 정의한다. Windows 에서는
//! 컴파일되지 않는다.
#![cfg(unix)]

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use mast_core::osc::OscEvent;
use mast_core::session::{
    Delivery, LeaseRenewal, PtySession, SessionId, SessionManager, SessionOptions, SessionSink,
    SizeOwner, SpawnSpec,
};

/// 개별 대기 상한 — hang 방지 가드. WSL 부하를 감안해 넉넉히 잡는다.
const TIMEOUT: Duration = Duration::from_secs(10);

/// sink 콜백을 채널로 옮겨 테스트 본문에서 순서대로 검사한다.
#[derive(Debug)]
enum Event {
    Output { offset: u64, bytes: Vec<u8> },
    Osc(OscEvent),
    Exit(Option<u32>),
    StartupTimeout,
}

struct ChannelSink {
    tx: Sender<Event>,
}

impl SessionSink for ChannelSink {
    fn on_output(&self, offset: u64, bytes: &[u8]) -> Delivery {
        // 테스트가 먼저 끝나 수신자가 drop 된 뒤의 send 실패는 무해하다.
        let _ = self.tx.send(Event::Output {
            offset,
            bytes: bytes.to_vec(),
        });
        Delivery::Delivered
    }
    fn on_osc(&self, event: &OscEvent) {
        let _ = self.tx.send(Event::Osc(event.clone()));
    }
    fn on_exit(&self, code: Option<u32>) {
        let _ = self.tx.send(Event::Exit(code));
    }
    fn on_startup_timeout(&self) {
        let _ = self.tx.send(Event::StartupTimeout);
    }
}

/// 항상 `Dropped` 를 반환하는 sink — 수신자 없는 detach 모드 시뮬레이션.
struct DropSink;

impl SessionSink for DropSink {
    fn on_output(&self, _offset: u64, _bytes: &[u8]) -> Delivery {
        Delivery::Dropped
    }
    fn on_osc(&self, _event: &OscEvent) {}
    fn on_exit(&self, _code: Option<u32>) {}
}

fn sh_spec() -> SpawnSpec {
    SpawnSpec {
        program: "sh".into(),
        args: vec![],
        cwd: None,
        cols: 80,
        rows: 24,
    }
}

/// 출력을 통제할 수 있는 spec — 시작 표식 감시 테스트가 "조용한 프로세스"와 "표식을
/// 내는 프로세스"를 만들어야 해서 필요하다.
fn sh_c_spec(script: &str) -> SpawnSpec {
    SpawnSpec {
        program: "sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: None,
        cols: 80,
        rows: 24,
    }
}

fn spawn_script(script: &str, opts: SessionOptions) -> (PtySession, Receiver<Event>) {
    let (tx, rx) = mpsc::channel();
    let session = PtySession::spawn(sh_c_spec(script), Box::new(ChannelSink { tx }), opts)
        .expect("failed to spawn sh in pty");
    (session, rx)
}

fn spawn_sh(opts: SessionOptions) -> (PtySession, Receiver<Event>) {
    let (tx, rx) = mpsc::channel();
    let session = PtySession::spawn(sh_spec(), Box::new(ChannelSink { tx }), opts)
        .expect("failed to spawn sh in pty");
    (session, rx)
}

/// deadline 까지 남은 시간. 이미 지났으면 무엇을 기다리다 초과했는지 알리며 실패.
fn remaining(deadline: Instant, waiting_for: &str) -> Duration {
    deadline
        .checked_duration_since(Instant::now())
        .unwrap_or_else(|| panic!("timed out waiting for {waiting_for}"))
}

/// `reattach` 반환값 앞머리의 `ESC [ ? <digits> (h|l)` 를 전부 건너뛴다.
/// preamble 은 스트림에 없던 바이트라 반환값의 길이로 스냅샷 구간을 역산할 수
/// 없다 (`PtySession::reattach` rustdoc) — 스냅샷만 보려면 여기서 잘라 낸다.
fn strip_mode_preamble(bytes: &[u8]) -> &[u8] {
    let mut rest = bytes;
    while let Some(after) = rest.strip_prefix(b"\x1b[?") {
        let digits = after.iter().take_while(|b| b.is_ascii_digit()).count();
        match after.get(digits) {
            Some(b'h' | b'l') if digits > 0 => rest = &after[digits + 1..],
            _ => break,
        }
    }
    rest
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

// 1) sh spawn → "echo hello" write → on_output 으로 hello 수신.
#[test]
fn spawn_sh_and_receive_echo_output() {
    let (session, rx) = spawn_sh(SessionOptions::default());
    session.write(b"echo hello\n").expect("write echo command");

    let deadline = Instant::now() + TIMEOUT;
    let mut acc: Vec<u8> = Vec::new();
    while !contains(&acc, b"hello") {
        match rx.recv_timeout(remaining(deadline, "echo output")) {
            Ok(Event::Output { bytes, .. }) => acc.extend_from_slice(&bytes),
            Ok(_) => {}
            Err(err) => panic!(
                "no output containing 'hello' ({err}); received {} bytes: {:?}",
                acc.len(),
                String::from_utf8_lossy(&acc)
            ),
        }
    }
    session.kill();
}

// 2) printf 로 OSC 777 방출 → on_osc 이벤트 수신 (BEL 종결·ST 종결 각 1회).
#[test]
fn osc777_events_received_for_bel_and_st() {
    let (session, rx) = spawn_sh(SessionOptions::default());
    // BEL(\007) 종결. sh 의 printf 가 \033/\007 을 실제 제어 바이트로 변환한다.
    session
        .write(b"printf '\\033]777;notify;T1;B1\\007'\n")
        .expect("write printf (BEL)");
    // ST(ESC \) 종결. 작은따옴표 안 `\\` 는 printf 가 `\` 하나로 변환한다.
    session
        .write(b"printf '\\033]777;notify;T2;B2\\033\\\\'\n")
        .expect("write printf (ST)");

    let deadline = Instant::now() + TIMEOUT;
    let mut oscs: Vec<OscEvent> = Vec::new();
    while oscs.len() < 2 {
        match rx.recv_timeout(remaining(deadline, "2 OSC events")) {
            Ok(Event::Osc(event)) => oscs.push(event),
            Ok(_) => {}
            Err(err) => panic!("expected 2 OSC events, got {oscs:?} ({err})"),
        }
    }
    assert_eq!(
        oscs,
        vec![
            OscEvent::Osc777Notify {
                title: "T1".into(),
                body: "B1".into()
            },
            OscEvent::Osc777Notify {
                title: "T2".into(),
                body: "B2".into()
            },
        ]
    );
    session.kill();
}

// 3) 대량 출력 + 무ack → paused 전환, pending 이 high_water 부근에서 멈춤,
//    전량 ack → 재개되어 추가 출력 수신.
#[test]
fn flood_without_ack_pauses_then_full_ack_resumes() {
    const HIGH: usize = 64 * 1024;
    const LOW: usize = 16 * 1024;
    let opts = SessionOptions {
        replay_cap: 64 * 1024,
        high_water: HIGH,
        low_water: LOW,
        startup_deadline: None,
    };
    let (session, rx) = spawn_sh(opts);
    session.write(b"seq 200000\n").expect("write seq command");

    // ack 없이 paused 전환을 기다린다.
    let deadline = Instant::now() + TIMEOUT;
    while !session.stats().paused {
        let _ = remaining(deadline, "paused transition");
        thread::sleep(Duration::from_millis(10));
    }

    // pending 은 high_water 도달 직후에서 멈춰야 한다 — 마지막 read chunk
    // 하나만큼의 overshoot 만 허용한다.
    let paused_stats = session.stats();
    assert!(
        paused_stats.pending >= HIGH,
        "pending {} below high_water {HIGH} while paused",
        paused_stats.pending
    );
    assert!(
        paused_stats.pending < HIGH + 64 * 1024,
        "pending {} ran away past high_water {HIGH}",
        paused_stats.pending
    );

    // read 자체가 멈췄는지 확인: pause 직전 chunk 의 in-flight 송신을 정리한 뒤
    // 조용한지, pending 이 변하지 않는지 본다.
    thread::sleep(Duration::from_millis(200));
    while rx.try_recv().is_ok() {}
    thread::sleep(Duration::from_millis(300));
    assert!(
        rx.try_recv().is_err(),
        "output kept flowing while session was paused"
    );
    assert_eq!(
        session.stats().pending,
        paused_stats.pending,
        "pending changed while paused without ack"
    );

    // 전량 ack → Resume → 추가 출력이 도착해야 한다.
    session.ack(paused_stats.pending);
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match rx.recv_timeout(remaining(deadline, "output after resume")) {
            Ok(Event::Output { .. }) => break,
            Ok(_) => {}
            Err(err) => panic!("no output arrived after full ack ({err})"),
        }
    }
    session.kill();
}

// 4) exit → on_exit 호출 (exit code 전달, stats.alive false).
#[test]
fn exit_invokes_on_exit_with_code() {
    let (session, rx) = spawn_sh(SessionOptions::default());
    session.write(b"exit 3\n").expect("write exit command");

    let deadline = Instant::now() + TIMEOUT;
    let code = loop {
        match rx.recv_timeout(remaining(deadline, "exit event")) {
            Ok(Event::Exit(code)) => break code,
            Ok(_) => {}
            Err(err) => panic!("no exit event received ({err})"),
        }
    };
    assert_eq!(code, Some(3));
    // on_exit 직전에 alive 가 내려가므로 이벤트 수신 후에는 false 가 보장된다.
    assert!(
        !session.stats().alive,
        "stats.alive must be false after exit"
    );
}

// 5) SessionManager — id 발급, create/get/remove/stats.
#[test]
fn manager_create_get_remove_stats() {
    let manager = SessionManager::new();
    let (tx, _rx) = mpsc::channel();

    let tx1 = tx.clone();
    let id1 = manager
        .create(sh_spec(), SessionOptions::default(), move |_| {
            Box::new(ChannelSink { tx: tx1 })
        })
        .expect("create session 1");
    let tx2 = tx.clone();
    let id2 = manager
        .create(sh_spec(), SessionOptions::default(), move |_| {
            Box::new(ChannelSink { tx: tx2 })
        })
        .expect("create session 2");
    assert_ne!(id1, id2);
    assert!(manager.get(id1).is_some());
    assert!(manager.get(id2).is_some());

    let stats = manager.stats();
    assert_eq!(stats.len(), 2);
    let ids: Vec<SessionId> = stats.iter().map(|&(id, _)| id).collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    assert_eq!(ids, sorted, "stats must be sorted by id ascending");
    assert!(ids.contains(&id1) && ids.contains(&id2));
    assert!(stats.iter().all(|(_, s)| s.alive));

    assert!(manager.remove(id1));
    assert!(manager.get(id1).is_none());
    assert!(!manager.remove(id1), "second remove must be a no-op");
    assert_eq!(manager.stats().len(), 1);
    assert!(manager.remove(id2));
    assert!(manager.stats().is_empty());
}

// 신규 (a) manager.create 의 sink factory 가 받는 id == create 가 반환하는 id.
//    동기 경로만 검증하므로 대기(타임아웃 가드 대상)가 없다.
#[test]
fn manager_create_passes_issued_id_to_sink_factory() {
    let manager = SessionManager::new();
    let captured: Arc<Mutex<Option<SessionId>>> = Arc::new(Mutex::new(None));
    let captured_in_factory = Arc::clone(&captured);
    let id = manager
        .create(sh_spec(), SessionOptions::default(), move |issued| {
            *captured_in_factory.lock().unwrap() = Some(issued);
            // 출력은 버린다 — 이 테스트는 id 전달만 본다.
            Box::new(DropSink)
        })
        .expect("create session");
    assert_eq!(
        *captured.lock().unwrap(),
        Some(id),
        "sink factory must receive the same id create returns"
    );
    assert!(manager.remove(id));
}

// 신규 (b) flood → paused → reattach() → paused 해제 + end_offset·offset 연속성.
#[test]
fn reattach_resumes_paused_session_with_continuous_offsets() {
    // HIGH 를 넉넉히 잡아 reattach 직후 재-pause 까지의 여유(재-pause 에는 256KB
    // 재유입 필요)를 확보한다. seq 200000 출력(약 1.4MB)이면 pause 는 확실히 온다.
    const HIGH: usize = 256 * 1024;
    const LOW: usize = 64 * 1024;
    let opts = SessionOptions {
        replay_cap: 64 * 1024,
        high_water: HIGH,
        low_water: LOW,
        startup_deadline: None,
    };
    let (session, rx) = spawn_sh(opts);
    session.write(b"seq 200000\n").expect("write seq command");

    // ack 없이 paused 전환을 기다린다.
    let deadline = Instant::now() + TIMEOUT;
    while !session.stats().paused {
        let _ = remaining(deadline, "paused transition");
        thread::sleep(Duration::from_millis(10));
    }

    // paused 동안 리더는 read 를 멈추므로 bytes_out 은 고정이다. pause 직전까지
    // 계정된 chunk 의 in-flight 송신을 전부 수신해 reattach 경계를 결정적으로
    // 만든다 (offset 연속성 덕에 마지막 chunk 끝 == bytes_out 이 수렴 조건).
    let frozen = session.stats().bytes_out;
    let mut chunks: Vec<(u64, usize)> = Vec::new();
    // 수신 바이트도 누적한다 — replay 스냅샷이 이 스트림의 tail 과 바이트 단위로
    // 일치하는지(내용 검증)까지 보기 위해서다.
    let mut stream: Vec<u8> = Vec::new();
    let deadline = Instant::now() + TIMEOUT;
    while chunks.last().map(|&(offset, len)| offset + len as u64) != Some(frozen) {
        match rx.recv_timeout(remaining(deadline, "in-flight chunks before reattach")) {
            Ok(Event::Output { offset, bytes }) => {
                chunks.push((offset, bytes.len()));
                stream.extend_from_slice(&bytes);
            }
            Ok(_) => {}
            Err(err) => panic!("in-flight chunks did not drain up to bytes_out {frozen} ({err})"),
        }
    }
    let pre_reattach_count = chunks.len();

    let (end_offset, bytes) = session.reattach();
    assert_eq!(
        end_offset, frozen,
        "end_offset must equal bytes_out at reattach"
    );
    // 내용 검증: 모드 preamble 을 걷어 낸 나머지가 전달된 스트림의 tail 과 바이트
    // 단위로 일치해야 한다 (offset dedup 계약의 나머지 절반 — 위치만이 아니라
    // 내용의 정합). preamble 의 유무는 셸이 무엇이냐에 달렸으므로 — dash 는 모드를
    // 하나도 켜지 않지만 bash 는 프롬프트에서 bracketed paste 를 건드린다 —
    // 길이를 빼서 구간을 역산하지 않고 tail 일치로 본다.
    let snapshot = strip_mode_preamble(&bytes);
    assert!(
        !snapshot.is_empty(),
        "replay snapshot must not be empty after flood"
    );
    assert_eq!(
        stream.len() as u64,
        frozen,
        "accumulated stream must cover exactly [0, end_offset)"
    );
    assert!(
        stream.ends_with(snapshot),
        "replay snapshot must be the byte-exact tail of the delivered stream"
    );
    // reattach 가 lock 안에서 paused 를 내렸다. 리더가 이 관측 전에 재-pause
    // 하려면 HIGH(256KB) 를 무ack 로 다시 채워야 하므로 즉시 관측은 안정적이다.
    assert!(!session.stats().paused, "reattach must clear paused");

    // 재개 증명: 새 chunk 가 도착해야 한다. 재-pause 를 막기 위해 받는 즉시
    // 전량 ack 한다 (reattach 호출자 계약과 동일한 "받은 만큼 ack" 규칙).
    let deadline = Instant::now() + TIMEOUT;
    while chunks.len() < pre_reattach_count + 3 {
        match rx.recv_timeout(remaining(deadline, "post-reattach output")) {
            Ok(Event::Output { offset, bytes }) => {
                session.ack(bytes.len());
                chunks.push((offset, bytes.len()));
            }
            Ok(_) => {}
            Err(err) => panic!("no output arrived after reattach ({err})"),
        }
    }

    // 첫 post-reattach chunk 는 스냅샷 이후 구간이어야 한다 (dedup 경계 계약).
    let (first_offset, _) = chunks[pre_reattach_count];
    assert!(
        first_offset >= end_offset,
        "first post-reattach chunk offset {first_offset} precedes snapshot end {end_offset}"
    );
    // 전 구간 offset 연속성: 각 chunk 의 offset == 직전 offset + 직전 len.
    // (reattach 경계를 포함한 전체 스트림이 끊김 없이 이어져야 한다.)
    for pair in chunks.windows(2) {
        let (prev_offset, prev_len) = pair[0];
        let (next_offset, _) = pair[1];
        assert_eq!(
            next_offset,
            prev_offset + prev_len as u64,
            "offset stream must be continuous"
        );
    }
    session.kill();
}

// 신규 (c) 항상 Dropped 를 반환하는 sink — pending 무누적(pause 없음)·bytes_out
//    증가·replay 기록을 검증한다 (보상 롤백 경로).
#[test]
fn dropped_sink_keeps_session_free_running() {
    const HIGH: usize = 64 * 1024;
    let opts = SessionOptions {
        replay_cap: 64 * 1024,
        high_water: HIGH,
        low_water: 16 * 1024,
        startup_deadline: None,
    };
    let session =
        PtySession::spawn(sh_spec(), Box::new(DropSink), opts).expect("failed to spawn sh in pty");
    session.write(b"seq 200000\n").expect("write seq command");

    // 보상 롤백이 없다면 pending 이 HIGH 에 도달해 pause 로 굳는다 — bytes_out 이
    // HIGH 를 훌쩍 넘겨 계속 증가하는 것이 자유 진행(pause 없음)의 증거다.
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let stats = session.stats();
        assert!(!stats.paused, "session paused despite Dropped rollback");
        // 순간 샘플은 롤백 직전 in-flight chunk 1개 분량(≤ read 버퍼)일 수 있으나
        // 누적은 없어야 한다 — HIGH 미만이면 누수가 아니다.
        assert!(
            stats.pending < HIGH,
            "pending {} accumulated despite Dropped rollback",
            stats.pending
        );
        if stats.bytes_out >= (4 * HIGH) as u64 {
            break;
        }
        let _ = remaining(deadline, "bytes_out growth with Dropped sink");
        thread::sleep(Duration::from_millis(10));
    }

    // 출력이 조용해진 뒤에는 in-flight chunk 가 없으므로 pending 은 정확히 0.
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let before = session.stats().bytes_out;
        thread::sleep(Duration::from_millis(200));
        let after = session.stats();
        if after.bytes_out == before {
            assert_eq!(after.pending, 0, "pending must settle to 0 after quiesce");
            assert!(!after.paused, "session must not be paused after quiesce");
            break;
        }
        let _ = remaining(deadline, "output quiesce with Dropped sink");
    }

    assert!(
        !session.replay().is_empty(),
        "replay must record output even when the sink drops it"
    );
    session.kill();
}

// 신규 (d) kill() → on_exit 정확히 1회 (waiter 단독 호출)·stats.alive=false·
//    멱등 kill 재호출에도 추가 on_exit 없음.
#[test]
fn kill_invokes_on_exit_exactly_once() {
    let (session, rx) = spawn_sh(SessionOptions::default());
    session.kill();

    let deadline = Instant::now() + TIMEOUT;
    loop {
        match rx.recv_timeout(remaining(deadline, "exit event after kill")) {
            Ok(Event::Exit(_)) => break,
            Ok(_) => {}
            Err(err) => panic!("no exit event after kill ({err})"),
        }
    }
    // waiter 가 on_exit 직전에 alive 를 내리므로 수신 후에는 false 가 보장된다.
    assert!(
        !session.stats().alive,
        "stats.alive must be false after kill"
    );

    // 멱등성: 두 번째 kill 은 no-op — 두 번째 Exit 이 오면 안 된다.
    session.kill();
    thread::sleep(Duration::from_millis(300));
    while let Ok(event) = rx.try_recv() {
        assert!(
            !matches!(event, Event::Exit(_)),
            "on_exit must fire exactly once per session"
        );
    }
}

// 시작 표식 감시 — 마감을 넘긴 세션을 **보고하되 죽이지 않는다**는 계약. 죽이지 않기
// 때문에 오탐의 대가가 경고 한 번뿐이고, 그래서 짧은 마감도 안전하다.
#[test]
fn startup_deadline_reports_a_silent_session_without_killing_it() {
    let opts = SessionOptions {
        startup_deadline: Some(Duration::from_millis(300)),
        ..SessionOptions::default()
    };
    // 표식도 프롬프트도 내지 않는 프로세스 — 실기 사고의 "셸이 안 뜬 탭"에 해당한다.
    let (session, rx) = spawn_script("sleep 30", opts);

    let deadline = Instant::now() + TIMEOUT;
    loop {
        match rx
            .recv_timeout(remaining(deadline, "startup timeout report"))
            .expect("sink channel closed before the startup timeout")
        {
            Event::StartupTimeout => break,
            _ => continue,
        }
    }

    assert!(
        session.stats().alive,
        "startup timeout must leave the session running"
    );
    session.kill();
}

// 표식이 오면 마감이 지나도 보고하지 않는다 — 정상 세션에 경고가 붙지 않는다는 쪽.
#[test]
fn startup_marker_disarms_the_watchdog() {
    const DEADLINE: Duration = Duration::from_secs(1);
    let opts = SessionOptions {
        startup_deadline: Some(DEADLINE),
        ..SessionOptions::default()
    };
    let (session, rx) = spawn_script(r"printf '\033]777;mast-started\007'; sleep 30", opts);

    let deadline = Instant::now() + TIMEOUT;
    loop {
        match rx
            .recv_timeout(remaining(deadline, "startup marker"))
            .expect("sink channel closed before the marker")
        {
            Event::Osc(OscEvent::Osc777Started) => break,
            Event::StartupTimeout => panic!("watchdog fired before the marker arrived"),
            _ => continue,
        }
    }

    // 마감을 넉넉히 지나 보내고도 보고가 없어야 한다.
    let watch_until = Instant::now() + DEADLINE * 2;
    while let Some(left) = watch_until.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(Event::StartupTimeout) => panic!("watchdog fired after the marker arrived"),
            Ok(_) => continue,
            Err(_) => break,
        }
    }
    session.kill();
}

// --- 재-attach 모드 preamble (DECSET/DECRST) ---
//
// 실기 결함: 장수 TUI 는 시작할 때 한 번 모드를 켜는데, 그 시퀀스가 replay 창 밖으로
// 밀려난 뒤 워크스페이스를 왕복하면 새 xterm 이 모드를 통째로 잃는다 (bracketed
// paste 가 꺼져 여러 줄 붙여넣기의 첫 줄이 제출됐다). 계약은
// `PtySession::reattach` rustdoc.

/// replay 창을 작게 잡아 evict 를 강제한다 — 아래 스크립트의 `seq 1 4000`(≈23KB)
/// 이면 모드를 켠 첫 chunk 는 확실히 밀려난다.
fn small_replay_opts() -> SessionOptions {
    SessionOptions {
        replay_cap: 8192,
        ..SessionOptions::default()
    }
}

/// `marker` 가 출력에 나타날 때까지 sink 이벤트를 소비한다 — 그 시점이면 그 앞의
/// 출력은 전부 replay·모드 맵에 반영돼 있다 (리더가 한 lock 에서 확정한다).
fn wait_for_marker(rx: &Receiver<Event>, marker: &str) {
    let deadline = Instant::now() + TIMEOUT;
    let mut acc: Vec<u8> = Vec::new();
    while !contains(&acc, marker.as_bytes()) {
        match rx.recv_timeout(remaining(deadline, marker)) {
            Ok(Event::Output { bytes, .. }) => acc.extend_from_slice(&bytes),
            Ok(_) => {}
            Err(err) => panic!("marker {marker} never arrived ({err})"),
        }
    }
}

#[test]
fn reattach_reasserts_dec_modes_evicted_from_the_replay_window() {
    let (session, rx) = spawn_script(
        r"printf '\033[?25l\033[?2004h'; seq 1 4000; printf 'MARK1\n'; sleep 30",
        small_replay_opts(),
    );
    wait_for_marker(&rx, "MARK1");

    let (_end_offset, bytes) = session.reattach();
    const PREAMBLE: &[u8] = b"\x1b[?25l\x1b[?2004h";
    assert!(
        bytes.starts_with(PREAMBLE),
        "reattach must lead with the tracked modes in ascending order"
    );
    // 이 테스트의 핵심 — 원본 시퀀스는 이미 replay 창에서 밀려났다. preamble 이
    // 없으면 새 터미널은 두 모드를 되찾을 방법이 없다.
    assert!(
        !contains(&bytes[PREAMBLE.len()..], b"\x1b[?2004h"),
        "the script's own DECSET must already be evicted from the replay window"
    );
    session.kill();
}

#[test]
fn reattach_preamble_carries_the_latest_value_of_a_mode() {
    // 스크립트가 `read` 로 멈춰 서므로 두 번째 단계는 테스트가 stdin 을 열어 줄
    // 때만 진행된다 — `sleep` 으로 시점을 맞추면 부하 걸린 러너에서 첫 관측이
    // 이미 두 번째 단계 뒤일 수 있다.
    let (session, rx) = spawn_script(
        r"printf '\033[?25l\033[?2004h'; seq 1 4000; printf 'MARK1\n'; read -r _; printf '\033[?2004lMARK2\n'; sleep 30",
        small_replay_opts(),
    );
    wait_for_marker(&rx, "MARK1");
    let (_, before) = session.reattach();
    assert!(
        before.starts_with(b"\x1b[?25l\x1b[?2004h"),
        "bracketed paste must still be on before the script turns it off"
    );

    session.write(b"\n").expect("release the script's read");
    wait_for_marker(&rx, "MARK2");
    let (_, after) = session.reattach();
    assert!(
        after.starts_with(b"\x1b[?25l\x1b[?2004l"),
        "the preamble must follow the reset, not re-assert the stale value"
    );
    session.kill();
}

#[test]
fn a_terminal_reset_empties_the_reattach_preamble() {
    // 같은 핸드셰이크로 RIS 앞뒤를 갈라, "preamble 이 사라졌다"에 양성 대조군을
    // 붙인다 — 앞 단계에서 preamble 이 실제로 있었음을 보지 않으면 이 테스트는
    // 모드 추적이 통째로 고장 나도 통과한다.
    let (session, rx) = spawn_script(
        r"printf '\033[?25l\033[?2004hMARK1\n'; read -r _; printf '\033c'; seq 1 4000; printf 'MARK2\n'; sleep 30",
        small_replay_opts(),
    );
    wait_for_marker(&rx, "MARK1");
    let (_, before) = session.reattach();
    assert!(
        before.starts_with(b"\x1b[?25l\x1b[?2004h"),
        "the modes must be tracked before the reset"
    );

    session.write(b"\n").expect("release the script's read");
    wait_for_marker(&rx, "MARK2");
    let (_, after) = session.reattach();
    // RIS 가 추적 맵을 비웠고 원본 시퀀스는 evict 됐으므로, 스냅샷 어디에도 private
    // mode 바이트가 남아 있으면 안 된다.
    assert!(
        !contains(&after, b"\x1b[?"),
        "RIS must clear the tracked modes"
    );
    session.kill();
}

// --- screen_since (원격 폴링 관측) ---
//
// 폴링 소비자는 데스크톱과 같은 세션을 동시에 본다 — 그래서 이 경로는 flow·sink·
// dec_modes 어느 것도 건드리지 않는 read-only 여야 한다. 계약은
// `PtySession::screen_since` rustdoc.

/// `bytes` 선두의 모드 preamble 구간. `dec_mode_preamble` 은 비공개라 기대값을
/// 만들 수 없으므로, `strip_mode_preamble` 이 걷어 낸 만큼을 preamble 로 본다.
fn mode_preamble_of(bytes: &[u8]) -> &[u8] {
    &bytes[..bytes.len() - strip_mode_preamble(bytes).len()]
}

#[test]
fn screen_since_none_returns_a_reset_snapshot_with_the_dec_mode_preamble() {
    let (session, rx) = spawn_script(
        r"printf '\033[?2004hMARK1\n'; sleep 30",
        SessionOptions::default(),
    );
    wait_for_marker(&rx, "MARK1");

    let screen = session.screen_since(None);
    assert!(screen.reset, "a first request must be a reset snapshot");
    // 기대 프리앰블은 하드코딩이다 — `dec_mode_preamble` 이 비공개라 다른 방법이 없고,
    // `sh -c` 는 비대화형이라 스크립트가 켠 2004 말고는 모드를 건드리지 않는다.
    assert!(
        screen.bytes.starts_with(b"\x1b[?2004h"),
        "reset bytes must lead with the tracked mode; got {:?}",
        &screen.bytes[..screen.bytes.len().min(32)]
    );
    assert!(
        contains(&screen.bytes, b"MARK1"),
        "reset bytes must carry the replay snapshot as well"
    );
    assert_eq!(screen.end_offset, session.stats().bytes_out);
    session.kill();
}

#[test]
fn screen_since_at_the_current_offset_returns_an_empty_delta() {
    let (session, rx) = spawn_script(r"printf 'MARK1\n'; sleep 30", SessionOptions::default());
    wait_for_marker(&rx, "MARK1");

    // 스크립트가 sleep 으로 조용해진 뒤라 두 호출 사이에 새 출력이 끼지 않는다.
    let first = session.screen_since(None);
    let delta = session.screen_since(Some(first.end_offset));
    assert!(!delta.reset, "an up-to-date poll must not force a reset");
    assert!(delta.bytes.is_empty(), "nothing new means no bytes");
    assert_eq!(delta.end_offset, first.end_offset);
    session.kill();
}

#[test]
fn screen_since_mid_stream_returns_only_the_new_bytes() {
    // `read` 핸드셰이크로 두 단계를 가른다 — sleep 으로 시점을 맞추면 부하 걸린
    // 러너에서 첫 관측이 이미 두 번째 단계 뒤일 수 있다.
    let (session, rx) = spawn_script(
        r"printf 'MARK1\n'; read -r _; printf 'SECOND\n'; sleep 30",
        SessionOptions::default(),
    );
    wait_for_marker(&rx, "MARK1");
    let first = session.screen_since(None);

    session.write(b"\n").expect("release the script's read");
    wait_for_marker(&rx, "SECOND");

    let delta = session.screen_since(Some(first.end_offset));
    assert!(!delta.reset, "the offset is inside the retained window");
    assert!(
        contains(&delta.bytes, b"SECOND"),
        "the delta must carry the output produced after the offset"
    );
    assert!(
        !contains(&delta.bytes, b"MARK1"),
        "the delta must not repeat what the caller already had"
    );
    // 델타 구간의 계약: end_offset 은 since 에 델타 길이를 더한 값이다 (reset 과 달리
    // 스트림에 없던 바이트가 섞이지 않으므로 길이로 구간을 말할 수 있다).
    assert_eq!(
        delta.end_offset,
        first.end_offset + delta.bytes.len() as u64
    );
    session.kill();
}

#[test]
fn screen_since_older_than_the_retained_window_falls_back_to_reset() {
    let (session, rx) = spawn_script(
        r"printf 'MARK1\n'; read -r _; seq 1 4000; printf 'MARK2\n'; sleep 30",
        small_replay_opts(),
    );
    wait_for_marker(&rx, "MARK1");
    let first = session.screen_since(None);

    // `seq 1 4000`(≈23KB)이 8KB 창을 여러 번 갈아치우므로 first.end_offset 구간의
    // 바이트는 확실히 evict 됐다.
    session.write(b"\n").expect("release the script's read");
    wait_for_marker(&rx, "MARK2");

    let screen = session.screen_since(Some(first.end_offset));
    assert!(
        screen.reset,
        "an offset older than the retained window cannot be served as a delta"
    );
    assert!(
        !screen.bytes.is_empty(),
        "the fallback must carry the current snapshot"
    );
    assert!(screen.end_offset > first.end_offset);
    session.kill();
}

#[test]
fn screen_since_ahead_of_bytes_out_falls_back_to_reset() {
    let (session, rx) = spawn_script(r"printf 'MARK1\n'; sleep 30", SessionOptions::default());
    wait_for_marker(&rx, "MARK1");

    let current = session.screen_since(None).end_offset;
    // 다른 세션(탭 respawn 뒤의 새 PtySession)의 오프셋을 들고 온 경우 — 새 세션의
    // bytes_out 은 0 부터 다시 시작하므로 옛 오프셋이 미래처럼 보인다.
    let screen = session.screen_since(Some(current + 4096));
    assert!(screen.reset, "an offset from another session must reset");
    assert_eq!(screen.end_offset, current);
    session.kill();
}

#[test]
fn screen_since_carries_the_spawn_size_and_follows_resize() {
    let (session, rx) = spawn_script(r"printf 'MARK1\n'; sleep 30", SessionOptions::default());
    wait_for_marker(&rx, "MARK1");

    let spawned = session.screen_since(None);
    assert_eq!((spawned.cols, spawned.rows), (80, 24));

    session.resize(100, 40).expect("resize the pty");
    let resized = session.screen_since(None);
    assert_eq!((resized.cols, resized.rows), (100, 40));
    session.kill();
}

#[test]
fn screen_since_leaves_flow_and_reattach_untouched() {
    const HIGH: usize = 256 * 1024;
    let opts = SessionOptions {
        replay_cap: 64 * 1024,
        high_water: HIGH,
        low_water: 64 * 1024,
        startup_deadline: None,
    };
    // 수신자를 비우지 않으므로 ack 이 오지 않는다 — pending 이 쌓여 flow 가 pause 로
    // 간다. 원격 관측이 그 상태를 건드리면 데스크톱의 backpressure 계정이 지워진다.
    let (session, _rx) = spawn_script(r"printf '\033[?2004h'; seq 1 200000; sleep 30", opts);

    let deadline = Instant::now() + TIMEOUT;
    while !session.stats().paused {
        let _ = remaining(deadline, "paused transition");
        thread::sleep(Duration::from_millis(10));
    }
    // paused 동안 리더는 read 를 멈추므로 bytes_out·pending 이 고정이다.
    let before = session.stats();

    let screen = session.screen_since(None);
    assert!(screen.reset);
    assert_eq!(screen.end_offset, before.bytes_out);
    let delta = session.screen_since(Some(screen.end_offset));
    assert!(delta.bytes.is_empty());

    let after = session.stats();
    assert!(
        after.paused,
        "screen_since must not resume a paused session"
    );
    assert_eq!(
        after.pending, before.pending,
        "flow accounting must not move"
    );
    assert_eq!(after.bytes_out, before.bytes_out);

    // reattach 는 그대로 동작해야 한다 — 관측이 그 앞에 끼어들어도 스냅샷 경계와
    // preamble 이 달라지지 않는다.
    let (end_offset, bytes) = session.reattach();
    assert_eq!(end_offset, before.bytes_out);
    assert!(bytes.starts_with(b"\x1b[?2004h"));
    assert_eq!(
        mode_preamble_of(&screen.bytes),
        mode_preamble_of(&bytes),
        "both paths must re-assert the same modes"
    );
    session.kill();
}

// --- 모바일 크기 소유권 (원격 `/resize` — ADR-0016 개정) ---
//
// 폰이 "Mobile" 을 누르면 PTY 크기를 폰이 소유하고, "Desktop" 을 누르거나 폴 리스가
// 끝나면 데스크톱 pane 크기로 돌아간다. 계약은 `PtySession::resize`·
// `release_mobile_size`·`renew_mobile_lease` rustdoc.

/// MARK1 을 찍고 조용히 사는 스크립트 — 크기 주장만 검사하는 테스트의 공통 대기점.
fn spawn_quiet_session() -> (PtySession, Receiver<Event>) {
    let (session, rx) = spawn_script(r"printf 'MARK1\n'; sleep 30", SessionOptions::default());
    wait_for_marker(&rx, "MARK1");
    (session, rx)
}

#[test]
fn desktop_resize_is_suppressed_while_mobile_owns_the_size_and_restores_the_latest_pane_size() {
    let (session, _rx) = spawn_quiet_session();
    let lease = Duration::from_secs(30);

    session.resize_mobile(60, 20, lease).expect("claim mobile size");
    let owned = session.screen_since(None);
    assert_eq!((owned.cols, owned.rows), (60, 20));
    assert_eq!(owned.size_owner, SizeOwner::Mobile);

    // 폰이 소유하는 동안의 데스크톱 resize — 전부 억제되고 기록만 갱신된다.
    session.resize(100, 40).expect("desktop resize");
    session.resize(120, 35).expect("desktop resize");
    let still_mobile = session.screen_since(None);
    assert_eq!(
        (still_mobile.cols, still_mobile.rows),
        (60, 20),
        "데스크톱 자동 resize 가 폰 크기를 덮었다"
    );
    assert_eq!(still_mobile.size_owner, SizeOwner::Mobile);

    // 복원은 주장 시점(100x40 중간값이 아니라) 마지막 pane 크기인 120x35 로 간다.
    session.release_mobile_size().expect("release mobile size");
    let restored = session.screen_since(None);
    assert_eq!((restored.cols, restored.rows), (120, 35));
    assert_eq!(restored.size_owner, SizeOwner::Desktop);
    session.kill();
}

#[test]
fn release_without_mobile_ownership_leaves_the_size_alone() {
    let (session, _rx) = spawn_quiet_session();
    session.resize(100, 40).expect("desktop resize");
    session
        .release_mobile_size()
        .expect("release is idempotent");
    let screen = session.screen_since(None);
    assert_eq!((screen.cols, screen.rows), (100, 40));
    assert_eq!(screen.size_owner, SizeOwner::Desktop);
    session.kill();
}

#[test]
fn a_lapsed_lease_is_restored_by_the_next_heartbeat() {
    let (session, _rx) = spawn_quiet_session();
    // 리스가 살아 있는 동안 데스크톱이 창을 옮겼다 — 기록만 갱신된다.
    session
        .resize_mobile(50, 15, Duration::from_millis(40))
        .expect("claim mobile size");
    session.resize(120, 30).expect("desktop resize");

    thread::sleep(Duration::from_millis(120));
    // 하트비트가 만료를 발견하면 그 자리에서 복원한다 (폰이 끊겼다 돌아온 폴).
    let renewal = session.renew_mobile_lease(Duration::from_secs(30));
    assert_eq!(renewal, LeaseRenewal::Lapsed { cols: 120, rows: 30 });
    let screen = session.screen_since(None);
    assert_eq!((screen.cols, screen.rows), (120, 30));
    assert_eq!(screen.size_owner, SizeOwner::Desktop);

    // 이미 데스크톱 소유라 다음 하트비트는 할 일이 없다.
    assert_eq!(
        session.renew_mobile_lease(Duration::from_secs(30)),
        LeaseRenewal::NotOwned
    );
    session.kill();
}

#[test]
fn a_live_heartbeat_keeps_the_mobile_size_owned() {
    let (session, _rx) = spawn_quiet_session();
    // 부하 걸린 러너에서도 20ms 짜리 잠들기가 리스를 넘기지 않도록 넉넉히 잡는다.
    let lease = Duration::from_millis(400);
    session
        .resize_mobile(50, 15, lease)
        .expect("claim mobile size");

    // 리스보다 짧은 간격으로 계속 두드리면 소유가 유지된다.
    for _ in 0..4 {
        thread::sleep(Duration::from_millis(50));
        assert_eq!(
            session.renew_mobile_lease(lease),
            LeaseRenewal::Renewed
        );
    }
    assert_eq!(session.screen_since(None).size_owner, SizeOwner::Mobile);

    // 두드리기를 멈추면 다음 하트비트가 만료를 정리한다.
    thread::sleep(Duration::from_millis(600));
    assert_eq!(
        session.renew_mobile_lease(lease),
        LeaseRenewal::Lapsed { cols: 80, rows: 24 }
    );
    session.kill();
}

#[test]
fn an_expired_lease_reports_desktop_before_anything_restores_the_pty() {
    let (session, _rx) = spawn_quiet_session();
    session
        .resize_mobile(50, 15, Duration::from_millis(30))
        .expect("claim mobile size");
    thread::sleep(Duration::from_millis(80));

    // 소유권은 이미 데스크톱에게 돌아갔지만 PTY 는 아직 폰 크기다 — 이 순간을
    // 숨기지 않고 드러낸다 (screen_since rustdoc). 복원은 적용 경로의 몫이다.
    let lapsed = session.screen_since(None);
    assert_eq!(lapsed.size_owner, SizeOwner::Desktop);
    assert_eq!((lapsed.cols, lapsed.rows), (50, 15));

    session.resize(120, 30).expect("desktop resize applies");
    assert_eq!(session.screen_since(None).cols, 120);
    session.kill();
}

#[test]
fn a_mobile_claim_on_a_killed_session_errors_but_release_is_tolerant() {
    let (session, _rx) = spawn_quiet_session();
    session
        .resize_mobile(50, 15, Duration::from_secs(30))
        .expect("claim mobile size");
    session.kill();

    assert!(
        session.resize_mobile(40, 12, Duration::from_secs(30)).is_err(),
        "적용할 master 가 없는데 성공을 보고하면 폰이 거짓말을 듣는다"
    );
    session
        .release_mobile_size()
        .expect("죽은 세션의 해제는 할 일이 없을 뿐이다");
}

// --- take_record (끝난 탭의 기록) ---
//
// 끝난 탭은 세션이 아니라 디스크 기록으로 남는다 — 그 재료를 떠내고 replay 메모리를
// 곧바로 반납하는 경로다. 계약은 `PtySession::take_record` rustdoc (ADR-0018 D1).

/// exit 이벤트가 올 때까지 sink 이벤트를 소비하고 exit code 를 돌려준다.
fn wait_for_exit(rx: &Receiver<Event>) -> Option<u32> {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match rx.recv_timeout(remaining(deadline, "exit event")) {
            Ok(Event::Exit(code)) => return code,
            Ok(_) => {}
            Err(err) => panic!("no exit event received ({err})"),
        }
    }
}

/// MARK1 을 찍고 한 줄 입력을 기다리다 3 으로 끝나는 스크립트. `read` 핸드셰이크가
/// "출력이 replay 에 들어간 시점"과 "종료 시점"을 갈라 준다 — sleep 으로 맞추면
/// 부하 걸린 러너에서 둘이 뒤섞인다.
fn spawn_marked_then_exit() -> (PtySession, Receiver<Event>) {
    spawn_script(
        r"printf 'MARK1\n'; read -r _; exit 3",
        SessionOptions::default(),
    )
}

/// 같은 핸드셰이크에 DEC 모드 두 개를 얹는다 — 모드 맵이 비지 않은 세션이라야
/// "화면이 없으면 preamble 도 내주지 않는다"가 자명하지 않은 주장이 된다.
fn spawn_marked_with_modes_then_exit() -> (PtySession, Receiver<Event>) {
    spawn_script(
        r"printf '\033[?25l\033[?2004hMARK1\n'; read -r _; exit 3",
        SessionOptions::default(),
    )
}

/// exit 이벤트 뒤 sink 채널이 조용해질 때까지 비운다. 리더는 waiter 와 다른
/// 스레드라 `alive` 가 내려간 뒤에도 마지막 chunk 를 `replay.push` 하는 중일 수
/// 있고(`take_record` rustdoc 의 tail 경합), 리더는 **push 를 마친 뒤** `on_output`
/// 을 부르므로 채널의 정적이 곧 "그 push 는 이미 끝났다"다. 계약이 보장하지 않는
/// 순간을 가정하는 대신 관측으로 확정하는 자리다.
fn drain_until_quiet(rx: &Receiver<Event>) {
    while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
}

#[test]
fn take_record_is_none_while_the_session_is_alive() {
    let (session, rx) = spawn_marked_then_exit();
    wait_for_marker(&rx, "MARK1");

    assert!(
        session.take_record().is_none(),
        "살아 있는 세션의 replay 를 떠내면 재접속한 프론트가 화면을 잃는다"
    );
    // 거절이 replay 를 건드리지 않았는지까지 본다.
    assert!(
        session.stats().replay_bytes > 0,
        "출력이 replay 에 쌓이면 replay_bytes 가 따라 오른다"
    );
    session.kill();
}

#[test]
fn take_record_after_exit_returns_the_last_screen_and_empties_the_replay() {
    let (session, rx) = spawn_marked_then_exit();
    wait_for_marker(&rx, "MARK1");
    let held = session.stats().replay_bytes;
    assert!(held > 0);

    session.write(b"\n").expect("release the script's read");
    assert_eq!(wait_for_exit(&rx), Some(3));
    drain_until_quiet(&rx);

    let record = session.take_record().expect("끝난 세션은 기록을 내준다");
    assert!(
        contains(&record, b"MARK1"),
        "record must carry the replay snapshot: {:?}",
        String::from_utf8_lossy(&record)
    );
    assert_eq!(
        session.stats().replay_bytes,
        0,
        "기록을 떠냈으면 같은 바이트를 메모리에도 들고 있지 않는다"
    );
}

#[test]
fn a_second_take_record_finds_nothing_left_to_record() {
    let (session, rx) = spawn_marked_with_modes_then_exit();
    wait_for_marker(&rx, "MARK1");
    session.write(b"\n").expect("release the script's read");
    wait_for_exit(&rx);
    drain_until_quiet(&rx);

    let first = session.take_record().expect("첫 호출은 기록을 내준다");
    assert!(
        first.starts_with(b"\x1b[?25l\x1b[?2004h"),
        "첫 기록은 모드 preamble 을 앞에 달고 나온다: {:?}",
        String::from_utf8_lossy(&first)
    );
    // 모드 맵은 clear 대상이 아니라서 두 번째 호출도 preamble 을 만들 수 있다 —
    // 화면이 없으면 그것까지 버린다는 것이 여기서 잠그는 계약이다. 그러지 않으면
    // 글루의 "빈 바이트면 기록을 지운다" 규칙이 빈 화면 파일을 남긴다.
    assert_eq!(session.take_record(), Some(Vec::new()));
}
