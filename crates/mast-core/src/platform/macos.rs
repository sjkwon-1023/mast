//! Native process-session cleanup. portable-pty calls setsid() before exec, so
//! foreground AND background job groups belong to this shell's private session.
//! No process polling service is kept alive. Enumeration happens only at exit.
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[link(name = "proc")]
extern "C" {
    fn proc_listpids(kind: u32, typeinfo: u32, buffer: *mut libc::c_void, size: i32) -> i32;
}

pub(crate) struct ProcessScope {
    // The direct child's PID stays reserved until the waiter reaps it. Clearing
    // this while holding the mutex makes kill / natural-exit cleanup single-shot.
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

    pub(crate) fn terminate(&self) {
        let mut root = self.root.lock().unwrap();
        if let Some(pid) = root.take() {
            terminate_session(pid);
        }
    }

    /// Observe exit without reaping: otherwise a reused root PID could name an
    /// unrelated session between wait() and our cleanup. Only this thread reaps.
    pub(crate) fn before_reap(&self) {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        loop {
            // SAFETY: valid initialized output storage; pid is our direct child.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.pid as libc::id_t,
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if result == 0 {
                self.terminate();
                return;
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            // Without the unreaped-child guarantee, never signal a numeric PID.
            *self.root.lock().unwrap() = None;
            eprintln!(
                "[mast] cannot observe child {} before cleanup: {error}",
                self.pid
            );
            return;
        }
    }
}

fn session_members(root: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
    // libproc returns byte counts. Retry a full buffer to cover concurrent forks,
    // with a hard allocation cap rather than trusting an unbounded process count.
    let mut pids = vec![0 as libc::pid_t; 4096];
    loop {
        let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as i32;
        // SAFETY: writable, properly aligned buffer of the advertised byte size.
        let count = unsafe { proc_listpids(1, 0, pids.as_mut_ptr().cast(), bytes) };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        if count < bytes || pids.len() >= 262_144 {
            pids.truncate(count as usize / std::mem::size_of::<libc::pid_t>());
            pids.retain(|&pid| pid > 1 && pid != root && unsafe { libc::getsid(pid) } == root);
            return Ok(pids);
        }
        pids.resize(pids.len() * 2, 0);
    }
}

fn signal_session(root: libc::pid_t, signal: libc::c_int) {
    match session_members(root) {
        Ok(pids) => {
            for pid in pids {
                // Recheck after enumeration; a PID could have exited meanwhile.
                // Only members of the still-reserved PTY session are eligible.
                unsafe {
                    if libc::getsid(pid) == root {
                        libc::kill(pid, signal);
                    }
                }
            }
        }
        Err(error) => eprintln!("[mast] cannot enumerate PTY session {root}: {error}"),
    }
    // The session leader is also our unreaped child (including a zombie at normal
    // exit). Signal it last so its jobs have a chance to handle HUP first.
    unsafe {
        libc::kill(root, signal);
    }
}

fn terminate_session(root: libc::pid_t) {
    if root <= 1 || root == unsafe { libc::getpid() } {
        return;
    }
    signal_session(root, libc::SIGHUP);
    std::thread::sleep(Duration::from_millis(100));
    // Interactive shells / agents can ignore HUP. Do not leave them running when
    // the tab or app was explicitly closed. Re-enumerate for children forked by a
    // HUP handler; independently daemonized processes are outside the PTY session.
    signal_session(root, libc::SIGKILL);
}

/// Until the waiter owns reaping, every spawn error must clean up its child.
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
        self.scope.terminate();
        // No waiter was successfully started, so we remain the only reaper.
        loop {
            let result = unsafe { libc::waitpid(self.scope.pid, std::ptr::null_mut(), 0) };
            if result >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                break;
            }
        }
    }
}
