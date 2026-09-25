//! 하네스 프로세스 실행기 — spawn 명령 구성, stdin writer, stdout·stderr
//! reader, 종료 대기와 중지.
//!
//! # 범위
//!
//! 한 번 띄우고 입출력하는 것까지다. 재시작 감독·백오프·`unsupported` 판정·Tauri
//! 명령·앱 종료 배선은 감독이 맡는다.
//!
//! # 스레드와 잠금
//!
//! - stdin 은 writer 스레드가 단독 소유한다. 중지는 [`Wake::close`] 로 writer 를
//!   끝내 stdin 을 닫는 것이 정상 경로이고(파이프 EOF → 하네스 정상 종료),
//!   [`STOP_TIMEOUT`] 안에 끝나지 않으면 프로세스 그룹을 kill 한다.
//! - stdout·stderr 는 reader·stderr 스레드가 각각 단독 소유한다.
//! - Dispatcher lock 은 이벤트를 뜰 때만 잡고 파이프 쓰기는 lock 밖에서 한다.
//!   상태 발행(`publish_state` → `crate::manager::wake`)이 lock 을 쥔 채 불릴 수
//!   있어, writer 가 lock 을 쥔 채 깨우기를 기다리면 서로를 기다리게 된다.
//! - 종료는 waiter 스레드가 `try_wait` 폴링으로 감지해 `Exited` 를 한 번 알린다.

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use mast_core::command::Dispatcher;
use mast_core::manager::{
    parse_harness_line, AppToHarness, HarnessAction, HarnessLine, HarnessToApp,
    MAX_HARNESS_LINE_BYTES,
};

use crate::winlog;

#[cfg(not(windows))]
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};

/// 자식 종료를 확인하는 폴링 간격. `wait()` 는 자식 lock 을 쥔 채 블록되므로
/// (중지·reap 과 경합) `try_wait` 를 쓴다 — 하네스는 분 단위로 사는 프로세스라
/// 200ms 폴링이면 충분하고, 상시 기상 비용을 줄인다.
const EXIT_POLL: Duration = Duration::from_millis(200);

/// 중지 시 stdin EOF 를 기다리는 시간. 넘으면 kill.
const STOP_TIMEOUT: Duration = Duration::from_secs(2);

/// stderr 에서 보관하는 마지막 바이트 수.
const STDERR_TAIL_BYTES: usize = 4 * 1024;

/// 하네스 실행 명령 — macOS(unix) 는 `~/.mast/bin/mast-python` 첫 줄의 인터프리터로
/// 하네스 스크립트를 exec 한다.
///
/// 파일이 없거나, 첫 줄이 비었거나, 절대 경로가 아니면 spawn 전 오류다 —
/// 감독이 이 오류를 `unsupported`(재시작 없음)로 표시한다.
#[cfg(not(windows))]
pub(crate) fn harness_command(home: &Path) -> Result<Command, String> {
    let bin = home.join(".mast").join("bin");
    let py_file = bin.join("mast-python");
    let text = std::fs::read_to_string(&py_file)
        .map_err(|err| format!("cannot read {}: {err}", py_file.display()))?;
    let py = text.lines().next().unwrap_or_default();
    if py.is_empty() {
        return Err(format!(
            "{} has no interpreter on its first line",
            py_file.display()
        ));
    }
    if !Path::new(py).is_absolute() {
        return Err(format!(
            "{} does not contain an absolute interpreter path: {py:?}",
            py_file.display()
        ));
    }
    let mut command = Command::new(py);
    command.arg("-I").arg(bin.join("mast-manager-harness.py"));
    Ok(command)
}

/// 하네스 실행 명령 — Windows 는 `wsl.exe` 로 관리자 배포판 안 런처를 실행한다.
/// distro 는 부팅 예열과 같은 해석(`host::resolve_distro(None)`)을 쓴다.
#[cfg(windows)]
pub(crate) fn harness_command() -> Command {
    use std::os::windows::process::CommandExt;

    // 콘솔 창 억제 — `boot::warm_wsl`·`commands.rs` 의 wsl.exe 호출과 같은 플래그다.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = Command::new("wsl.exe");
    command.args(harness_wsl_args(
        crate::host::resolve_distro(None).as_deref(),
    ));
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// 런처의 `$HOME` 은 WSL 안에서 해석한다 — Windows 쪽 홈과 같다는 보장이 없다.
/// `mast-python` 이 없거나 첫 줄을 못 읽으면 `read` 가 실패해 exit 4 다
/// (미프로비저닝).
#[cfg(windows)]
const HARNESS_LAUNCHER: &str = r#"IFS= read -r py < "$HOME/.mast/bin/mast-python" || exit 4; exec "$py" -I "$HOME/.mast/bin/mast-manager-harness.py""#;

/// `wsl.exe` 인자 — `--cd ~` 로 WSL 홈에서 시작하고, `--exec /bin/sh -c` 로
/// 셸 평가를 한 번만 받는다 (`host::spawn_spec` 과 같은 이유).
#[cfg(windows)]
fn harness_wsl_args(distro: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(distro) = distro {
        args.push("-d".to_owned());
        args.push(distro.to_owned());
    }
    args.extend(["--cd", "~", "--exec", "/bin/sh", "-c", HARNESS_LAUNCHER].map(str::to_owned));
    args
}

/// writer 스레드 깨우기 — 상태 발행이 신호만 넣고 writer 가 Dispatcher lock 밖에서
/// 이벤트를 뜨게 한다.
///
/// 신호는 bool 하나로 합쳐진다: 발행이 연달아 와도 writer 는 한 번 깨어 최신
/// `events_since` 를 뜨면 된다 (`nextSeq` 동일 판정도 그 뒤에 선다). Dispatcher
/// lock 을 잡지 않으므로 `publish_state` 의 호출 맥락(lock 안)과 교착이 없다.
#[derive(Default)]
pub(crate) struct Wake {
    inner: Mutex<WakeState>,
    condvar: Condvar,
}

#[derive(Default)]
struct WakeState {
    signaled: bool,
    closed: bool,
}

impl Wake {
    /// 변이가 발행됐다고 알린다. writer 가 이미 끝났어도 무해하다.
    pub(crate) fn signal(&self) {
        let mut state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        state.signaled = true;
        self.condvar.notify_one();
    }

    /// writer 를 끝낸다 — 이후 대기는 즉시 false 로 돌아온다.
    pub(crate) fn close(&self) {
        let mut state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        state.closed = true;
        self.condvar.notify_one();
    }

    /// 신호를 기다린다. 닫혔으면 false, 아니면 신호를 소비하고 true.
    pub(crate) fn wait_for_signal(&self) -> bool {
        let mut state = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        while !state.signaled && !state.closed {
            state = self
                .condvar
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        if state.closed {
            return false;
        }
        state.signaled = false;
        true
    }

    /// 테스트 전용 — 신호를 소비하지 않고 서 있는지 본다.
    #[cfg(test)]
    pub(crate) fn is_signaled(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .signaled
    }
}

/// 실행기 출력 — reader 가 아는 메시지만 [`Self::Message`] 로 넘기고, 종료는
/// waiter 가 한 번 [`Self::Exited`] 로 알린다. 모르는 type·잘못된 줄은 로그만 남는다.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum HarnessEvent {
    Message(HarnessToApp),
    /// `code` 는 unix 신호 종료처럼 없을 수 있다.
    Exited {
        code: Option<i32>,
    },
}

/// 실행 중인 하네스 핸들 — 감독이 소유하고, Tauri 명령이 action 을 넣는다.
pub(crate) struct HarnessProcess {
    child: Arc<Mutex<Child>>,
    wake: Arc<Wake>,
    actions: mpsc::Sender<AppToHarness>,
    /// 테스트 전용 — 재시작 경로가 이전 실행의 writer 를 끝냈는지 관측한다.
    #[cfg(test)]
    writer: Mutex<std::thread::JoinHandle<()>>,
}

impl Drop for HarnessProcess {
    fn drop(&mut self) {
        // Wake 를 닫지 않으면 writer 가 영원히 대기하며 stdin fd·Dispatcher 참조를
        // 붙잡는다. `stop()`·[`Self::close_wake`] 와 중복 호출돼도 무해하다.
        self.wake.close();
    }
}

impl HarnessProcess {
    /// action 큐에 넣고 writer 를 깨운다. `manager_action` 이 쓴다.
    pub(crate) fn send_action(&self, action: HarnessAction, key: String) {
        if self
            .actions
            .send(AppToHarness::Action { action, key })
            .is_err()
        {
            // writer 가 이미 끝났다 — 보낼 곳이 없다. 감독이 곧 exit 을 본다.
            winlog!("manager: the harness writer has stopped; action dropped");
        }
        self.wake.signal();
    }

    /// writer 를 끝낸다 — 하네스가 스스로 끝나 Exited 를 받은 감독이 부른다.
    /// 닫지 않으면 writer 가 영구 대기하며 stdin·Dispatcher 참조를 놓지 못한다.
    pub(crate) fn close_wake(&self) {
        self.wake.close();
    }

    /// 테스트 전용 — writer 스레드가 끝났는가.
    #[cfg(test)]
    pub(crate) fn writer_finished(&self) -> bool {
        self.writer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_finished()
    }

    /// 하네스를 끝낸다 — writer 를 닫아 stdin EOF 를 만들고(정상 경로) 2초까지
    /// 기다린 뒤 프로세스 그룹을 kill 한다. 앱 종료 때 부른다.
    pub(crate) fn stop(&self) {
        self.wake.close();
        let deadline = Instant::now() + STOP_TIMEOUT;
        loop {
            {
                let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    // 이미 거둔 자식·알 수 없는 오류 — 여기서 더 할 일이 없다.
                    Err(_) => return,
                    Ok(None) => {}
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(EXIT_POLL);
        }
        let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        kill_harness(&mut child);
        let _ = child.wait();
    }
}

/// 하네스를 spawn 하고 writer·reader·stderr·waiter 스레드를 붙인다.
///
/// `command` 는 플랫폼 빌더([`harness_command`])가 만든 것이고, stdio pipe 와
/// 프로세스 그룹 설정은 여기서 한다(호출자가 빠뜨릴 수 없게). `wake` 는
/// `ManagerRuntime` 에도 등록해 상태 발행이 writer 를 깨우게 한다.
///
/// 재시작은 하지 않는다 — `Exited` 를 받은 감독이 맡는다.
pub(crate) fn spawn_harness(
    mut command: Command,
    hello: AppToHarness,
    dispatcher: Arc<Mutex<Dispatcher>>,
    wake: Arc<Wake>,
    on_event: Arc<dyn Fn(HarnessEvent) + Send + Sync>,
) -> std::io::Result<HarnessProcess> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // unix: 새 프로세스 그룹의 리더로 띄운다 — 중지가 자손(codex 등)까지 거둘 수 있게.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let child = Arc::new(Mutex::new(child));

    let (actions, queued) = mpsc::channel();
    let writer = {
        let dispatcher = Arc::clone(&dispatcher);
        let wake = Arc::clone(&wake);
        move || writer_loop(stdin, dispatcher, wake, hello, queued)
    };
    let reader = {
        let on_event = Arc::clone(&on_event);
        move || reader_loop(stdout, on_event)
    };
    let errors = move || stderr_loop(stderr);
    let waiter = {
        let child = Arc::clone(&child);
        move || waiter_loop(child, on_event)
    };

    let writer_thread = std::thread::Builder::new()
        .name("mast-manager-writer".into())
        .spawn(writer);
    let started = match writer_thread {
        Ok(writer) => std::thread::Builder::new()
            .name("mast-manager-reader".into())
            .spawn(reader)
            .and_then(|_| {
                std::thread::Builder::new()
                    .name("mast-manager-stderr".into())
                    .spawn(errors)
            })
            .and_then(|_| {
                std::thread::Builder::new()
                    .name("mast-manager-wait".into())
                    .spawn(waiter)
            })
            .map(|_| writer),
        Err(err) => Err(err),
    };
    let writer = match started {
        Ok(writer) => writer,
        Err(err) => {
            // 반쪽만 뜬 하네스를 남기지 않는다 — writer 를 깨워 끝내고 자식을 거둔다.
            wake.close();
            let mut child = child.lock().unwrap_or_else(PoisonError::into_inner);
            kill_harness(&mut child);
            let _ = child.wait();
            return Err(err);
        }
    };
    #[cfg(not(test))]
    drop(writer);

    Ok(HarnessProcess {
        child,
        wake,
        actions,
        #[cfg(test)]
        writer: Mutex::new(writer),
    })
}

/// stdin 을 단독 소유하는 writer — hello·snapshot 을 먼저 쓰고, 깨우기마다
/// `events_since`(gap 이면 overview)와 action 큐를 내보낸다. 쓰기 실패(EPIPE)는
/// 하네스 종료로 본다.
fn writer_loop(
    mut stdin: ChildStdin,
    dispatcher: Arc<Mutex<Dispatcher>>,
    wake: Arc<Wake>,
    hello: AppToHarness,
    actions: mpsc::Receiver<AppToHarness>,
) {
    if !write_line(&mut stdin, &hello) {
        return;
    }
    let overview = dispatcher
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .overview();
    // 스냅샷이 담은 상태는 nextSeq-1 까지의 이벤트를 반영한 것이다 — `events_since`
    // 의 `since` 는 그 마지막 seq 다 (nextSeq 자체를 넘기면 직전 이벤트를 건너뛴다).
    let mut last_seq = overview.next_seq.saturating_sub(1);
    let mut last_next_seq = overview.next_seq;
    if !write_line(&mut stdin, &AppToHarness::Snapshot { overview }) {
        return;
    }

    loop {
        if !wake.wait_for_signal() {
            return;
        }
        // action 이 먼저다 — 사용자 선택은 이벤트보다 지연이 덜 용서된다.
        while let Ok(action) = actions.try_recv() {
            if !write_line(&mut stdin, &action) {
                return;
            }
        }
        // Dispatcher lock 안에서는 뜨기만 하고, 쓰기는 lock 밖에서 한다.
        let message = {
            let dispatcher = dispatcher.lock().unwrap_or_else(PoisonError::into_inner);
            let since = dispatcher.events_since(last_seq);
            if since.gap {
                let overview = dispatcher.overview();
                last_seq = overview.next_seq.saturating_sub(1);
                last_next_seq = overview.next_seq;
                Some(AppToHarness::Snapshot { overview })
            } else if since.next_seq != last_next_seq {
                last_seq = since.next_seq.saturating_sub(1);
                last_next_seq = since.next_seq;
                Some(AppToHarness::Events {
                    events: since.events,
                    next_seq: since.next_seq,
                })
            } else {
                // 제목·cwd 만 바뀐 발행 — nextSeq 가 그대로면 보낼 것이 없다.
                None
            }
        };
        if let Some(message) = message {
            if !write_line(&mut stdin, &message) {
                return;
            }
        }
    }
}

/// 줄 하나를 JSON + `\n` 으로 쓴다. 실패(EPIPE 포함)는 false — 호출자는 종료로 본다.
fn write_line(stdin: &mut ChildStdin, message: &AppToHarness) -> bool {
    let json = match serde_json::to_string(message) {
        Ok(json) => json,
        Err(err) => {
            winlog!("manager: cannot serialize a harness message: {err}");
            return false;
        }
    };
    let written = stdin
        .write_all(json.as_bytes())
        .and_then(|()| stdin.write_all(b"\n"))
        .and_then(|()| stdin.flush());
    if let Err(err) = written {
        winlog!("manager: cannot write to the harness: {err}");
        return false;
    }
    true
}

/// stdout 줄을 상한 안에서 읽어 콜백에 넘긴다. 모르는 type·스키마 위반은 로그만
/// 남기고 무시한다(전방 호환).
fn reader_loop(stdout: ChildStdout, on_event: Arc<dyn Fn(HarnessEvent) + Send + Sync>) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_capped_line(&mut reader) {
            CappedLine::Line(line) => {
                let Ok(text) = std::str::from_utf8(&line) else {
                    winlog!("manager: the harness line is not UTF-8; dropped");
                    continue;
                };
                match parse_harness_line(text) {
                    HarnessLine::Known(message) => on_event(HarnessEvent::Message(message)),
                    HarnessLine::Unknown(kind) => {
                        winlog!("manager: ignoring an unknown harness message type {kind:?}");
                    }
                    HarnessLine::Invalid(error) => {
                        winlog!("manager: ignoring an invalid harness line: {error}");
                    }
                }
            }
            CappedLine::Overlong => {
                discard_line(&mut reader);
                winlog!(
                    "manager: the harness wrote a line over {MAX_HARNESS_LINE_BYTES} bytes; dropped"
                );
            }
            CappedLine::Eof => return,
            CappedLine::Error(err) => {
                winlog!("manager: cannot read the harness output: {err}");
                return;
            }
        }
    }
}

/// [`read_capped_line`] 의 결과.
enum CappedLine {
    Line(Vec<u8>),
    Overlong,
    Eof,
    Error(std::io::Error),
}

/// 상한+개행까지 읽는다. 상한을 넘긴 줄은 [`CappedLine::Overlong`] 으로 알리고
/// 호출자가 나머지를 [`discard_line`] 으로 버린다.
fn read_capped_line(reader: &mut impl BufRead) -> CappedLine {
    let mut line = Vec::new();
    loop {
        let remaining = (MAX_HARNESS_LINE_BYTES + 1).saturating_sub(line.len());
        match reader
            .by_ref()
            .take(remaining as u64)
            .read_until(b'\n', &mut line)
        {
            Ok(0) => {
                return if line.is_empty() {
                    CappedLine::Eof
                } else {
                    classify_line(line)
                };
            }
            Ok(_) => {
                if line.ends_with(b"\n") || line.len() > MAX_HARNESS_LINE_BYTES {
                    return classify_line(line);
                }
                // 개행 전이고 아직 상한 아래 — 이어서 읽는다.
            }
            Err(err) => return CappedLine::Error(err),
        }
    }
}

/// 개행·CR 을 떼고 상한을 판정한다. 새 줄 없이 EOF 로 끝난 줄도 낸다(JSON 이면 처리).
fn classify_line(mut line: Vec<u8>) -> CappedLine {
    if line.last() == Some(&b'\n') {
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
    }
    if line.len() > MAX_HARNESS_LINE_BYTES {
        return CappedLine::Overlong;
    }
    CappedLine::Line(line)
}

/// 상한을 넘긴 줄의 나머지를 개행까지 버린다 — 다음 줄 파싱을 오염시키지 않게.
fn discard_line(reader: &mut impl BufRead) {
    loop {
        let mut sink = Vec::new();
        match reader.by_ref().take(64 * 1024).read_until(b'\n', &mut sink) {
            Ok(0) => return,
            Ok(_) if sink.ends_with(b"\n") => return,
            Ok(_) => {}
            Err(_) => return,
        }
    }
}

/// stderr 를 끝까지 읽고 마지막 [`STDERR_TAIL_BYTES`] 만 남겨 종료 시 로그 한 줄로
/// 남긴다.
fn stderr_loop(mut stderr: ChildStderr) {
    let mut tail: Vec<u8> = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > STDERR_TAIL_BYTES {
                    tail.drain(..tail.len() - STDERR_TAIL_BYTES);
                }
            }
            Err(err) => {
                winlog!("manager: cannot read the harness stderr: {err}");
                break;
            }
        }
    }
    if !tail.is_empty() {
        winlog!(
            "manager: harness stderr: {}",
            String::from_utf8_lossy(&tail).trim_end()
        );
    }
}

/// 자식 종료를 폴링해 한 번 알린다. 재시작·백오프는 감독이 맡는다.
fn waiter_loop(child: Arc<Mutex<Child>>, on_event: Arc<dyn Fn(HarnessEvent) + Send + Sync>) {
    let code = loop {
        // try_wait 는 거둔 자식의 상태를 캐시에서 돌려준다 — 중지가 먼저 reap 해도
        // 여기서 Some 이 와 Exited 를 반드시 한 번 알린다.
        let status = {
            let mut child = child.lock().unwrap_or_else(PoisonError::into_inner);
            match child.try_wait() {
                Ok(Some(status)) => Some(status),
                Ok(None) => None,
                Err(err) => {
                    winlog!("manager: cannot wait for the harness: {err}");
                    return;
                }
            }
        };
        match status {
            Some(status) => break status.code(),
            None => std::thread::sleep(EXIT_POLL),
        }
    };
    on_event(HarnessEvent::Exited { code });
}

/// 프로세스 그룹째 kill — unix 는 [`spawn_harness`] 가 자식을 그룹 리더로 띄웠다.
/// 그룹 kill 이 실패해도 직접 자식은 반드시 죽인다.
#[cfg(target_os = "macos")]
fn kill_harness(child: &mut Child) {
    let pid = child.id() as i32;
    // SAFETY: kill(2) 에 음수 pid 는 프로세스 그룹이다. 실패해도 아래 child.kill 이 있다.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.kill();
}

/// macOS 밖(unix 개발·Windows) — 프로세스 그룹 API 가 없어 직접 자식만 죽인다.
#[cfg(not(target_os = "macos"))]
fn kill_harness(child: &mut Child) {
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 준비된 조건이 참이 될 때까지 폴링한다 — 통합 테스트의 시간 상한.
    #[cfg(unix)]
    fn wait_until(timeout: Duration, mut ready: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if ready() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// 임시 경로 — 프로세스 id + 증가 번호로 겹치지 않게 하고 Drop 에서 지운다.
    #[cfg(not(windows))]
    struct TempPath(std::path::PathBuf);

    #[cfg(not(windows))]
    impl TempPath {
        fn new(label: &str) -> Self {
            use std::sync::atomic::{AtomicUsize, Ordering};
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "mast-manager-{}-{}-{label}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn as_arg(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    #[cfg(not(windows))]
    impl Drop for TempPath {
        fn drop(&mut self) {
            if self.0.is_dir() {
                let _ = std::fs::remove_dir_all(&self.0);
            } else {
                let _ = std::fs::remove_file(&self.0);
            }
        }
    }

    // ── 플랫폼 spawn 명령 구성 (순수) ─────────────────────────────────────

    #[cfg(not(windows))]
    #[test]
    fn macos_command_reads_the_interpreter_from_mast_python() {
        let home = TempPath::new("home");
        let bin = home.path().join(".mast/bin");
        std::fs::create_dir_all(&bin).unwrap();

        // 첫 줄만 쓴다 — 둘째 줄은 무시된다.
        std::fs::write(bin.join("mast-python"), "/usr/bin/python3\nextra\n").unwrap();
        let command = harness_command(home.path()).unwrap();
        let script = bin.join("mast-manager-harness.py");
        assert_eq!(command.get_program(), "/usr/bin/python3");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec!["-I".as_ref(), script.as_os_str()]
        );

        // 없음
        std::fs::remove_file(bin.join("mast-python")).unwrap();
        assert!(harness_command(home.path())
            .unwrap_err()
            .contains("cannot read"));

        // 빈 값
        std::fs::write(bin.join("mast-python"), "").unwrap();
        assert!(harness_command(home.path())
            .unwrap_err()
            .contains("no interpreter"));

        // 상대 경로
        std::fs::write(bin.join("mast-python"), "python3\n").unwrap();
        assert!(harness_command(home.path())
            .unwrap_err()
            .contains("absolute"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_command_follows_the_wsl_exec_shape() {
        assert_eq!(
            HARNESS_LAUNCHER,
            "IFS= read -r py < \"$HOME/.mast/bin/mast-python\" || exit 4; exec \"$py\" -I \"$HOME/.mast/bin/mast-manager-harness.py\""
        );

        assert_eq!(harness_command().get_program(), "wsl.exe");
        assert_eq!(
            harness_wsl_args(Some("Ubuntu")),
            [
                "-d",
                "Ubuntu",
                "--cd",
                "~",
                "--exec",
                "/bin/sh",
                "-c",
                HARNESS_LAUNCHER
            ]
        );
        assert_eq!(
            harness_wsl_args(None),
            ["--cd", "~", "--exec", "/bin/sh", "-c", HARNESS_LAUNCHER]
        );
    }

    // ── unix 통합 ───────────────────────────────────────────────────────

    #[cfg(unix)]
    mod integration {
        use std::path::Path;
        use std::process::Command;
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};

        use mast_core::command::{Command as CoreCommand, Dispatcher, SessionHost, ShellSpawnReq};
        use mast_core::manager::{
            AppToHarness, HarnessAction, HarnessSettings, HarnessState, HarnessToApp,
            HARNESS_PROTOCOL,
        };
        use mast_core::session::SessionId;
        use serde_json::Value;

        use super::super::{spawn_harness, HarnessEvent, Wake};
        use super::{wait_until, TempPath};

        /// hello → snapshot 을 기록하고, 아는 3종 + 모르는 type + 잘못된 줄을 낸 뒤
        /// stdin 을 메아리치다가 EOF 에 exit 7 로 끝난다.
        const FAKE_HARNESS: &str = r#"
import json
import sys

record = open(sys.argv[1], "a", buffering=1)

def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()

emit({"type": "status", "state": "starting", "message": "boot", "lastCollectedAt": None, "logPath": None, "codexVersion": None})
emit({"type": "board", "generatedAt": "2026-09-25T00:00:00Z", "entries": []})
emit({"type": "notify", "workspaceId": 1, "reason": "done", "title": "t", "body": "b"})
emit({"type": "future-message", "value": 1})
sys.stdout.write("{not json}\n")
sys.stdout.flush()

for line in sys.stdin:
    record.write(line)
    record.flush()
record.close()
sys.exit(7)
"#;

        /// stdin 을 무시하고 자지 않는다 — 중지가 EOF 로 안 끝나 kill 로 끝나는 경로.
        const STUCK_HARNESS: &str = "import time\ntime.sleep(10)\n";

        struct IdleHost;

        impl SessionHost for IdleHost {
            fn spawn_shell(&self, _req: ShellSpawnReq) -> anyhow::Result<SessionId> {
                Err(anyhow::anyhow!("the test host does not spawn shells"))
            }

            fn kill(&self, _id: SessionId) {}
        }

        fn hello() -> AppToHarness {
            AppToHarness::Hello {
                protocol: HARNESS_PROTOCOL,
                manager_workspace: 7,
                manager_dir: "/home/u/.mast/manager".into(),
                manager_distro: None,
                default_distro: Some("Ubuntu".into()),
                settings: HarnessSettings {
                    model: "gpt-6-luna".into(),
                    effort: "high".into(),
                    summary_model: "gpt-6-luna".into(),
                    summary_effort: "low".into(),
                    idle_seconds: 45,
                },
            }
        }

        fn recorded_lines(path: &Path) -> Vec<String> {
            std::fs::read_to_string(path)
                .map(|text| text.lines().map(str::to_owned).collect())
                .unwrap_or_default()
        }

        fn fake_harness_command(script: &'static str, record: Option<&TempPath>) -> Command {
            let mut command = Command::new("python3");
            match record {
                Some(record) => {
                    let path = record.as_arg();
                    command.args(["-c", script, path.as_str()]);
                }
                None => {
                    command.args(["-c", script]);
                }
            }
            command
        }

        #[test]
        fn harness_exchanges_lines_and_reports_exit() {
            let dispatcher = Arc::new(Mutex::new(Dispatcher::new(Box::new(IdleHost))));
            {
                let mut dispatcher = dispatcher.lock().unwrap();
                dispatcher.set_manager_events(true);
                dispatcher
                    .dispatch(CoreCommand::CreateWorkspace {
                        name: "feature-x".into(),
                        root_path: None,
                        distro: None,
                        tab: None,
                    })
                    .unwrap();
            }
            let expected_overview = dispatcher.lock().unwrap().overview();

            let record = TempPath::new("stdin.jsonl");
            let wake = Arc::new(Wake::default());
            let seen = Arc::new(Mutex::new(Vec::new()));
            let seen_cb = Arc::clone(&seen);
            let process = spawn_harness(
                fake_harness_command(FAKE_HARNESS, Some(&record)),
                hello(),
                Arc::clone(&dispatcher),
                Arc::clone(&wake),
                Arc::new(move |event| seen_cb.lock().unwrap().push(event)),
            )
            .expect("python3 must be available to run the fake harness");

            // (a) 첫 두 줄이 hello → snapshot 이고, hello 필드가 계약대로다.
            assert!(
                wait_until(Duration::from_secs(5), || recorded_lines(record.path())
                    .len()
                    >= 2),
                "the fake harness did not record hello and snapshot"
            );
            let recorded = recorded_lines(record.path());
            let hello_json: Value = serde_json::from_str(&recorded[0]).unwrap();
            assert_eq!(hello_json, serde_json::to_value(hello()).unwrap());
            assert_eq!(hello_json["protocol"], 1);
            assert_eq!(hello_json["settings"]["idleSeconds"], 45);
            let snapshot_json: Value = serde_json::from_str(&recorded[1]).unwrap();
            assert_eq!(snapshot_json["type"], "snapshot");
            assert_eq!(
                snapshot_json["overview"],
                serde_json::to_value(&expected_overview).unwrap()
            );

            // (b) 아는 3종만 순서대로 콜백에 온다 — 모르는 type·잘못된 줄은 오지 않는다.
            assert!(wait_until(Duration::from_secs(5), || {
                seen.lock().unwrap().len() >= 3
            }));
            std::thread::sleep(Duration::from_millis(200));
            let messages = seen.lock().unwrap().clone();
            assert_eq!(
                messages.len(),
                3,
                "unknown/invalid lines must not reach the callback"
            );
            assert!(matches!(
                &messages[0],
                HarnessEvent::Message(HarnessToApp::Status {
                    state: HarnessState::Starting,
                    ..
                })
            ));
            assert!(matches!(
                &messages[1],
                HarnessEvent::Message(HarnessToApp::Board { .. })
            ));
            assert!(matches!(
                &messages[2],
                HarnessEvent::Message(HarnessToApp::Notify { title, .. }) if title == "t"
            ));

            // 변이 → 이벤트가 있으면 깨우기에 events 줄이 간다.
            dispatcher
                .lock()
                .unwrap()
                .dispatch(CoreCommand::CreateWorkspace {
                    name: "second".into(),
                    root_path: None,
                    distro: None,
                    tab: None,
                })
                .unwrap();
            wake.signal();
            assert!(wait_until(Duration::from_secs(5), || {
                recorded_lines(record.path()).len() >= 3
            }));
            let events_json: Value =
                serde_json::from_str(&recorded_lines(record.path())[2]).unwrap();
            assert_eq!(events_json["type"], "events");
            assert_eq!(events_json["nextSeq"], 3);
            assert_eq!(events_json["events"][0]["seq"], 2);
            assert_eq!(events_json["events"][0]["kind"], "workspaceOpened");

            // nextSeq 가 같으면 아무것도 쓰지 않는다 — action 만 나간다.
            wake.signal();
            process.send_action(HarnessAction::Resume, "k1".into());
            assert!(wait_until(Duration::from_secs(5), || {
                recorded_lines(record.path()).len() >= 4
            }));
            let recorded = recorded_lines(record.path());
            assert_eq!(
                recorded.len(),
                4,
                "a wake with the same nextSeq must not write"
            );
            let action_json: Value = serde_json::from_str(&recorded[3]).unwrap();
            assert_eq!(action_json["type"], "action");
            assert_eq!(action_json["action"], "resume");
            assert_eq!(action_json["key"], "k1");

            // (c) 중지 — stdin EOF 로 하네스가 exit 7 하고 2초 안에 끝난다.
            let started = Instant::now();
            process.stop();
            let elapsed = started.elapsed();
            assert!(elapsed < Duration::from_secs(2), "stop took {elapsed:?}");

            assert!(wait_until(Duration::from_secs(5), || {
                seen.lock()
                    .unwrap()
                    .iter()
                    .any(|event| matches!(event, HarnessEvent::Exited { .. }))
            }));
            let messages = seen.lock().unwrap().clone();
            assert_eq!(messages.len(), 4);
            assert_eq!(messages[3], HarnessEvent::Exited { code: Some(7) });
        }

        #[test]
        fn stop_kills_a_harness_that_ignores_stdin_eof() {
            let dispatcher = Arc::new(Mutex::new(Dispatcher::new(Box::new(IdleHost))));
            let seen = Arc::new(Mutex::new(Vec::new()));
            let seen_cb = Arc::clone(&seen);
            let process = spawn_harness(
                fake_harness_command(STUCK_HARNESS, None),
                hello(),
                dispatcher,
                Arc::new(Wake::default()),
                Arc::new(move |event| seen_cb.lock().unwrap().push(event)),
            )
            .expect("python3 must be available to run the fake harness");

            // EOF 를 무시하는 하네스라도 2초 대기 뒤 kill 로 끝난다.
            let started = Instant::now();
            process.stop();
            let elapsed = started.elapsed();
            assert!(elapsed < Duration::from_secs(3), "stop took {elapsed:?}");

            assert!(wait_until(Duration::from_secs(5), || {
                seen.lock()
                    .unwrap()
                    .iter()
                    .any(|event| matches!(event, HarnessEvent::Exited { .. }))
            }));
            let last = seen.lock().unwrap().last().cloned().unwrap();
            assert_eq!(
                last,
                HarnessEvent::Exited { code: None },
                "SIGKILL 은 code 가 없다"
            );
        }
    }
}
