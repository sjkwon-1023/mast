//! 네이티브 PTY 프로세스 수명 관리. portable-pty 는 exec 전에 setsid() 를 부르므로
//! 셸(leader)은 자기 세션의 리더이자 우리의 직계 자식이다.
//!
//! 신호는 **leader 하나에만** 보낸다. 세션 멤버의 PID 를 숫자로 열거해 신호를 보내면,
//! 확인과 전송 사이에 그 멤버가 다른 부모에게 reap 되고 PID 가 재사용될 때 무관한
//! 프로세스를 맞힐 수 있다 — 멤버는 우리가 reap 하지 않으므로 PID 를 붙잡아 둘 수단이
//! 없다. leader 는 대화형 zsh/bash 라 SIGHUP 을 받으면 자기 job 전체에 SIGHUP 을 다시
//! 보내고 끝난다. 그래서 탭 닫기의 결과는 Terminal.app·Linux 경로와 같다: 보통 job 은
//! 끝나고, HUP 을 무시하는 job(nohup·`trap '' HUP`·disown)은 살아남는다.
//!
//! leader PID 의 재사용 안전은 [`ProcessScope`] 의 `root`(신호 권한)가 보장한다.
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// HUP 을 보낸 뒤 leader 가 스스로 끝나기를 기다리는 시간. 넘기면 leader 만 SIGKILL 한다.
const GRACE: Duration = Duration::from_millis(500);
/// grace 동안 leader 의 reap 여부를 다시 보는 간격. 셸이 HUP 에 바로 끝나면 대기도 곧 끝난다.
const POLL: Duration = Duration::from_millis(10);

pub(crate) struct ProcessScope {
    // leader 에 신호를 보낼 권한. `Some` 인 동안 그 PID 는 아직 reap 되지 않은 우리 자식이라
    // 재사용될 수 없다. 권한을 닫는(None) 곳은 waiter 의 before_reap 과 SpawnGuard 뿐이고,
    // 둘 다 이 mutex 아래에서 닫은 뒤에 reap 한다. 신호 전송도 같은 mutex 아래에서 한다.
    root: Mutex<Option<libc::pid_t>>,
    pid: libc::pid_t,
}

impl ProcessScope {
    pub(crate) fn new(pid: u32) -> Self {
        let pid = libc::pid_t::try_from(pid).expect("macOS child PID fits pid_t");
        Self {
            root: Mutex::new(Some(pid)),
            pid,
        }
    }

    /// 권한이 살아 있을 때만 leader 에 신호를 보낸다. 권한 확인과 전송이 한 임계구역
    /// 안에 있으므로 reap 된(재사용됐을 수 있는) PID 에는 절대 보내지 않는다.
    fn signal(&self, signal: libc::c_int) {
        let root = self.root.lock().unwrap();
        if let Some(pid) = *root {
            // SAFETY: pid 는 아직 reap 되지 않은 우리 직계 자식이다(위 불변식).
            // 이미 끝나 zombie 인 경우의 실패(ESRCH 등)는 의도가 이미 충족된 상태라 무시한다.
            unsafe {
                libc::kill(pid, signal);
            }
        }
    }

    /// 탭 닫기·앱 종료의 첫 단계 — leader 에 SIGHUP 만 보낸다. 대기하지 않는다.
    pub(crate) fn hang_up(&self) {
        self.signal(libc::SIGHUP);
    }

    pub(crate) fn unreaped(&self) -> bool {
        self.root.lock().unwrap().is_some()
    }

    /// leader 종료를 reap 없이(WNOWAIT) 관측한 뒤 신호 권한만 닫는다. 신호는 보내지 않는다 —
    /// 자연 종료 때 job 처리는 셸 자신의 규칙(zsh HUP 옵션, bash huponexit)에 맡긴다.
    /// 대기는 mutex 밖에서 하고, 권한을 닫는 것만 mutex 안에서 한다. 이 함수가 반환한 뒤에야
    /// waiter 가 실제로 reap 한다.
    pub(crate) fn before_reap(&self) {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        loop {
            // SAFETY: 초기화된 출력 버퍼이고 pid 는 우리 직계 자식이다.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.pid as libc::id_t,
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if result == 0 {
                *self.root.lock().unwrap() = None;
                return;
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            // 미reap 보장을 잃었으니 이후 어떤 경로도 이 숫자 PID 에 신호를 보내지 않게 한다.
            *self.root.lock().unwrap() = None;
            eprintln!(
                "[mast] cannot observe child {} before cleanup: {error}",
                self.pid
            );
            return;
        }
    }
}

/// grace 를 **한 번** 기다린 뒤 아직 reap 되지 않은 leader 만 SIGKILL 한다. 모든 leader 가
/// 먼저 끝나면 곧바로 반환한다. mutex 는 확인·전송하는 순간에만 잡고, 잡은 채로 sleep 하지 않는다.
pub(crate) fn kill_unreaped_after_grace(scopes: &[Arc<ProcessScope>]) {
    let deadline = Instant::now() + GRACE;
    while scopes.iter().any(|scope| scope.unreaped()) {
        let now = Instant::now();
        if now >= deadline {
            for scope in scopes {
                scope.signal(libc::SIGKILL);
            }
            return;
        }
        std::thread::sleep(POLL.min(deadline - now));
    }
}

/// 탭 닫기의 에스컬레이션을 분리 스레드로 넘긴다 — 호출자(Dispatcher lock 아래일 수 있다)는
/// grace 를 기다리지 않는다. 스레드를 만들 수 없으면 그 사실을 남기고 이 자리에서 동기로
/// 수행한다. 느려질 뿐 HUP 을 무시하는 leader 가 남는 일은 없다.
pub(crate) fn escalate_in_background(scope: Arc<ProcessScope>) {
    let spawned = std::thread::Builder::new()
        .name("mast-pty-escalate".into())
        .spawn({
            let scope = Arc::clone(&scope);
            move || kill_unreaped_after_grace(&[scope])
        });
    if let Err(error) = spawned {
        eprintln!("[mast] cannot start PTY escalation thread ({error}); escalating inline");
        kill_unreaped_after_grace(&[scope]);
    }
}

/// waiter 가 뜨기 전의 스폰 실패 경로에서 자식을 정리한다. 이때는 우리만 reap 할 수 있으므로
/// HUP → grace → KILL → reap 을 동기로 끝낸다. 스폰 실패 때만 타는 드문 경로다.
pub(crate) struct SpawnGuard {
    scope: Arc<ProcessScope>,
    armed: bool,
}
impl SpawnGuard {
    pub(crate) fn new(scope: Arc<ProcessScope>) -> Self {
        Self { scope, armed: true }
    }
    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }
}
impl Drop for SpawnGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let pid = self.scope.pid;
        self.scope.hang_up();
        let deadline = Instant::now() + GRACE;
        while Instant::now() < deadline {
            match child_state(pid) {
                ChildState::Running => std::thread::sleep(POLL),
                ChildState::Exited => break,
                ChildState::Unobservable(error) => {
                    // 누군가 이미 reap 했을 수 있다 — 그러면 이 숫자 PID 는 재사용됐을 수 있으므로
                    // before_reap 의 실패 경로처럼 권한만 닫고 KILL 도 reap 도 하지 않는다.
                    *self.scope.root.lock().unwrap() = None;
                    eprintln!("[mast] cannot observe child {pid} during spawn cleanup: {error}");
                    return;
                }
            }
        }
        // 권한을 닫기 전에 KILL 한다 — 여기까지 reap 한 주체가 없으니 PID 는 아직 우리 자식이다.
        self.scope.signal(libc::SIGKILL);
        *self.scope.root.lock().unwrap() = None;
        loop {
            // SAFETY: waiter 가 없으므로 이 자식을 reap 하는 것은 우리뿐이다.
            let result = unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
            if result >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                break;
            }
        }
    }
}

enum ChildState {
    /// 아직 끝나지 않았다(EINTR 로 확인하지 못한 경우도 다음 확인으로 넘긴다).
    Running,
    /// 끝났고 아직 reap 되지 않았다.
    Exited,
    /// waitid 가 EINTR 외 오류(ECHILD 등)를 냈다 — 더는 우리 미reap 자식이라고 볼 수 없다.
    Unobservable(io::Error),
}

/// 자식이 끝났는지 reap 하지 않고(WNOWAIT) 기다림 없이(WNOHANG) 확인한다.
fn child_state(pid: libc::pid_t) -> ChildState {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: 초기화된 출력 버퍼다. pid 가 우리 자식이 아니면 커널이 ECHILD 로 거절한다.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return ChildState::Running;
        }
        return ChildState::Unobservable(error);
    }
    // WNOHANG 에서 아직 끝나지 않았으면 0 을 반환하고 si_pid 는 0 으로 남는다(버퍼를 0 으로 초기화했다).
    // SAFETY: waitid 가 성공했으므로 버퍼는 초기화돼 있다(0 초기화 위에 커널이 채운다).
    if unsafe { info.assume_init().si_pid } != 0 {
        ChildState::Exited
    } else {
        ChildState::Running
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    fn running(pid: libc::pid_t) -> bool {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: 쓰기 가능한 버퍼와 그 크기를 넘긴다.
        let written = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size)
        };
        written > 0
    }

    #[test]
    fn spawn_cleanup_never_kills_a_pid_it_cannot_observe_as_its_child() {
        // 우리 자식이 아닌(이미 다른 쪽이 reap 한 PID 를 재사용한 것과 같은) 프로세스를
        // 스폰 실패 정리에 넘긴다. waitid 가 ECHILD 를 내는 대상이므로 정리는 신호 권한을
        // 닫고 물러나야 한다. HUP 은 무시하도록 만들어, 살아 있는지로 SIGKILL 여부를 본다.
        let mut shell = Command::new("/bin/sh")
            .args(["-c", "trap '' HUP; /bin/sleep 30 </dev/null >/dev/null 2>&1 & echo $!"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(shell.stdout.take().unwrap()).read_line(&mut line).unwrap();
        shell.wait().unwrap();
        let stranger: libc::pid_t = line.trim().parse().unwrap();
        assert!(running(stranger));

        drop(SpawnGuard::new(Arc::new(ProcessScope::new(stranger as u32))));

        std::thread::sleep(Duration::from_millis(100));
        let survived = running(stranger);
        // SAFETY: 방금 살아 있음을 확인한, 이 테스트가 만든 프로세스다.
        unsafe {
            libc::kill(stranger, libc::SIGKILL);
        }
        assert!(survived, "spawn cleanup killed a process that is not its unreaped child");
    }
}
