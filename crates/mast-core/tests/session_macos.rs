//! 네이티브 PTY 프로세스 수명 회귀 테스트. 프로세스 테이블을 흉내 내지 않고 실제 macOS 에서
//! 대화형 셸을 PTY 로 띄워 확인한다. `bash -c` 같은 비대화형 셸은 SIGHUP 을 자기 job 에
//! 다시 보내지 않으므로, leader 는 항상 대화형 셸이고 job 은 입력으로 만든다.
#![cfg(target_os = "macos")]
use mast_core::osc::OscEvent;
use mast_core::session::{
    Delivery, PtySession, SessionManager, SessionOptions, SessionSink, SpawnSpec,
};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Captured {
    bytes: Vec<u8>,
    exits: usize,
}
struct Sink(Arc<Mutex<Captured>>);
impl SessionSink for Sink {
    fn on_output(&self, _offset: u64, bytes: &[u8]) -> Delivery {
        self.0.lock().unwrap().bytes.extend_from_slice(bytes);
        Delivery::Dropped
    }
    fn on_osc(&self, _event: &OscEvent) {}
    fn on_exit(&self, _code: Option<u32>) {
        self.0.lock().unwrap().exits += 1;
    }
}

fn interactive(program: &str, args: &[&str]) -> SpawnSpec {
    SpawnSpec {
        program: program.into(),
        args: args.iter().map(|arg| (*arg).into()).collect(),
        cwd: None,
        cols: 80,
        rows: 24,
    }
}
fn bash() -> SpawnSpec {
    interactive("/bin/bash", &["--norc", "--noprofile", "-i"])
}
fn zsh() -> SpawnSpec {
    interactive("/bin/zsh", &["-f", "-i"])
}

/// 셸에 넣을 입력. 표식은 `printf` 로 조립해 출력하므로, 터미널이 되돌려 보여 주는 입력
/// 줄에는 `MAST_<이름>:` 이 나타나지 않는다.
fn report(name: &str, value: &str) -> String {
    format!("printf 'MAST_%s:%s\\n' {name} {value}\n")
}
const START_JOB: &str = "sleep 600 &\n";
const START_HUP_IGNORING_JOB: &str = "(trap '' HUP; exec sleep 600) &\n";

/// 셸이 표식을 찍은 뒤 전경 명령을 실행하게 한다. 표식이 보이면 셸은 이미 줄을 다 읽고
/// 입력을 더 읽지 않는 상태다 — kill 이 writer 를 닫으며 보내는 EOF 도, 그 뒤 출력이 없으니
/// PTY 를 완전히 닫는 커널 hangup 도 셸에 닿지 않는다. 셸을 끝낼 수 있는 것은 Mast 가 보내는
/// 신호뿐이다.
fn run_in_foreground(prelude: &str, command: &str) -> String {
    format!("{prelude}printf 'MAST_%s:%s\\n' BUSY $$; {command}\n")
}

fn wait_until(limit: Duration, what: &str, mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while !predicate() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn until(what: &str, predicate: impl FnMut() -> bool) {
    wait_until(Duration::from_secs(10), what, predicate);
}

/// 출력에서 `MAST_<name>:<pid>` 표식을 기다려 PID 를 읽는다.
fn marker(output: &Arc<Mutex<Captured>>, name: &str) -> libc::pid_t {
    let tag = format!("MAST_{name}:");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let output = output.lock().unwrap();
        let text = String::from_utf8_lossy(&output.bytes);
        let pid = text.find(&tag).and_then(|at| {
            let digits: String = text[at + tag.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        });
        if let Some(pid) = pid {
            return pid;
        }
        assert!(Instant::now() < deadline, "shell never printed {tag}; output: {text:?}");
        drop(output);
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// 더 이상 실행 중이 아닌가. reap 전 zombie 에도 `kill(pid, 0)` 은 성공하므로 쓰지 않는다 —
/// macOS 의 `proc_pidinfo(PROC_PIDTBSDINFO)` 는 없는 프로세스와 zombie 모두에 0 을 돌려준다.
fn ended(pid: libc::pid_t) -> bool {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: 쓰기 가능한 버퍼와 그 크기를 넘긴다.
    let written = unsafe {
        libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size)
    };
    written <= 0
}

/// 테스트가 만든 프로세스를 단언 실패와 무관하게 치운다.
struct KillOnDrop(Vec<libc::pid_t>);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        for &pid in &self.0 {
            if !ended(pid) {
                // SAFETY: 이 테스트가 만든 프로세스의 PID 다.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }
}

struct Tab {
    session: PtySession,
    output: Arc<Mutex<Captured>>,
}
impl Tab {
    fn open(spec: SpawnSpec) -> Self {
        let output = Arc::new(Mutex::new(Captured::default()));
        let session =
            PtySession::spawn(spec, Box::new(Sink(output.clone())), SessionOptions::default())
                .unwrap();
        Self { session, output }
    }
    fn type_line(&self, line: &str) {
        self.session.write(line.as_bytes()).unwrap();
    }
    fn exits(&self) -> usize {
        self.output.lock().unwrap().exits
    }
}

/// 이미 떠 있는 셸을 SIGHUP 을 무시하며 전경 루프를 도는 leader 로 만들고 그 PID 를 돌려준다.
/// 이 leader 는 SIGKILL 에스컬레이션으로만 끝난다.
fn busy_hup_ignoring_leader(write: impl Fn(&str), output: &Arc<Mutex<Captured>>) -> libc::pid_t {
    write(&run_in_foreground("trap '' HUP; ", "while :; do sleep 1; done"));
    marker(output, "BUSY")
}

#[test]
fn closing_tab_hangs_up_ordinary_jobs_and_spares_hup_ignoring_ones() {
    let tab = Tab::open(bash());
    tab.type_line(START_JOB);
    tab.type_line(&report("JOB", "$!"));
    let job = marker(&tab.output, "JOB");
    tab.type_line(START_HUP_IGNORING_JOB);
    tab.type_line(&report("KEEPER", "$!"));
    let keeper = marker(&tab.output, "KEEPER");
    let _cleanup = KillOnDrop(vec![job, keeper]);
    // echo 를 끈다 — 에이전트 TUI 처럼 echo 가 꺼진 전경 프로그램이면 kill 이 보내는 EOF 가
    // 출력으로 돌아오지 않아, PTY 가 완전히 닫히며 커널이 보내는 hangup 도 오지 않는다.
    // 그래도 탭 닫기는 셸을 통해 job 을 끝내야 한다.
    tab.type_line(&run_in_foreground("stty -echo; ", "sleep 600"));
    marker(&tab.output, "BUSY");
    assert!(!ended(job) && !ended(keeper));

    tab.session.kill();
    tab.session.kill(); // 멱등 — 두 번째 호출은 아무것도 하지 않는다

    until("the tab's ordinary job survived closing the tab", || ended(job));
    until("the shell never reported its exit", || tab.exits() == 1);
    // leader 가 끝난 뒤, 에스컬레이션 대기가 지나도 HUP 을 무시한 job 은 남아 있다.
    std::thread::sleep(Duration::from_secs(1));
    assert!(!ended(keeper), "a HUP-ignoring job must survive closing its tab");
    assert_eq!(tab.exits(), 1);
}

#[test]
fn kill_returns_at_once_and_a_hup_ignoring_leader_is_killed_later() {
    let tabs: Vec<Tab> = (0..3).map(|_| Tab::open(bash())).collect();
    let leaders: Vec<libc::pid_t> = tabs
        .iter()
        .map(|tab| busy_hup_ignoring_leader(|line| tab.type_line(line), &tab.output))
        .collect();
    let _cleanup = KillOnDrop(leaders.clone());

    for tab in &tabs {
        tab.session.kill();
    }
    // kill() 이 에스컬레이션을 기다렸다면 HUP 을 무시한 leader 는 여기서 이미 끝나 있다.
    for &leader in &leaders {
        assert!(!ended(leader), "kill() must not wait for the escalation");
    }

    for (tab, &leader) in tabs.iter().zip(&leaders) {
        until("a HUP-ignoring leader outlived the escalation", || ended(leader));
        until("the killed shell never reported its exit", || tab.exits() == 1);
    }
    std::thread::sleep(Duration::from_millis(200));
    for tab in &tabs {
        assert_eq!(tab.exits(), 1, "on_exit must fire exactly once");
    }
}

#[test]
fn natural_shell_exit_leaves_job_handling_to_the_shell() {
    // macOS 기본 셸 zsh 는 끝날 때 HUP 옵션에 따라 job 에 SIGHUP 을 보낸다. Mast 는 자연 종료에
    // 아무 신호도 보내지 않으므로, 결과는 셸 자신의 규칙 그대로여야 한다.
    let tab = Tab::open(zsh());
    tab.type_line(START_JOB);
    tab.type_line(&report("JOB", "$!"));
    let job = marker(&tab.output, "JOB");
    tab.type_line(START_HUP_IGNORING_JOB);
    tab.type_line(&report("KEEPER", "$!"));
    let keeper = marker(&tab.output, "KEEPER");
    let _cleanup = KillOnDrop(vec![job, keeper]);

    tab.type_line("setopt no_check_jobs; exit\n");

    until("the shell's HUP did not end its ordinary job", || ended(job));
    // HUP 을 무시한 생존자가 slave 를 쥐고 있어도 탭 종료는 한 번 전달된다.
    until("the shell never reported its exit", || tab.exits() == 1);
    std::thread::sleep(Duration::from_secs(1));
    assert!(!ended(keeper), "a HUP-ignoring job must survive a natural shell exit");
    assert_eq!(tab.exits(), 1);
}

fn manager_tab(
    manager: &SessionManager,
) -> (mast_core::session::SessionId, Arc<PtySession>, Arc<Mutex<Captured>>) {
    let output = Arc::new(Mutex::new(Captured::default()));
    let id = manager
        .create(bash(), SessionOptions::default(), |_| {
            Box::new(Sink(output.clone()))
        })
        .unwrap();
    let session = manager.get(id).unwrap();
    (id, session, output)
}

#[test]
fn app_shutdown_also_ends_a_leader_whose_tab_was_just_closed() {
    let manager = SessionManager::new();
    let (id, session, output) = manager_tab(&manager);
    let leader = busy_hup_ignoring_leader(|line| session.write(line.as_bytes()).unwrap(), &output);
    let _cleanup = KillOnDrop(vec![leader]);
    drop(session);

    assert!(manager.remove(id));
    manager.shutdown();
    // 탭 닫기의 에스컬레이션 스레드는 앱 종료와 함께 사라지므로, shutdown 이 반환될 때
    // leader 는 이미 끝났어야 한다. 에스컬레이션 스레드의 grace 가 지나기 전에 확인한다.
    wait_until(
        Duration::from_millis(300),
        "shutdown returned while a closing tab's leader was still running",
        || ended(leader),
    );
}

#[test]
fn app_shutdown_ends_hup_ignoring_leaders_after_one_shared_grace() {
    let manager = SessionManager::new();
    let tabs: Vec<_> = (0..3).map(|_| manager_tab(&manager)).collect();
    let leaders: Vec<libc::pid_t> = tabs
        .iter()
        .map(|(_, session, output)| {
            busy_hup_ignoring_leader(|line| session.write(line.as_bytes()).unwrap(), output)
        })
        .collect();
    let _cleanup = KillOnDrop(leaders.clone());

    let started = Instant::now();
    manager.shutdown();
    let elapsed = started.elapsed();
    for &leader in &leaders {
        wait_until(
            Duration::from_millis(300),
            "shutdown returned while a HUP-ignoring leader was still running",
            || ended(leader),
        );
    }
    // 세션마다 grace 를 따로 기다렸다면 세 배가 걸린다. 넉넉하게 grace 두 번분 미만만 요구한다.
    assert!(
        elapsed < Duration::from_millis(1000),
        "shutdown waited per session: {elapsed:?}"
    );

    let again = Instant::now();
    manager.shutdown();
    assert!(again.elapsed() < Duration::from_millis(200), "second shutdown must be a no-op");
    assert!(manager.create(bash(), SessionOptions::default(), |_| {
        Box::new(Sink(Arc::new(Mutex::new(Captured::default()))))
    })
    .is_err());
    std::thread::sleep(Duration::from_millis(200));
    for (_, _, output) in &tabs {
        assert_eq!(
            output.lock().unwrap().exits,
            0,
            "shutdown must not mark saved Running tabs Exited"
        );
    }
}

#[test]
fn app_shutdown_ends_owned_jobs_without_changing_restorable_tab_state() {
    let manager = SessionManager::new();
    let (id, retained_handle, output) = manager_tab(&manager);
    retained_handle.write(START_JOB.as_bytes()).unwrap();
    retained_handle.write(report("JOB", "$!").as_bytes()).unwrap();
    let job = marker(&output, "JOB");
    let _cleanup = KillOnDrop(vec![job]);
    assert!(manager.ids().contains(&id));

    manager.shutdown();
    manager.shutdown();
    until("app shutdown left the shell's ordinary job running", || ended(job));
    assert!(manager.ids().is_empty());
    assert!(retained_handle.write(b"echo should-not-run\n").is_err());
    assert!(manager
        .create(bash(), SessionOptions::default(), |_| Box::new(Sink(
            output.clone()
        )))
        .is_err());
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        output.lock().unwrap().exits,
        0,
        "shutdown must not mark saved Running tabs Exited"
    );
}
