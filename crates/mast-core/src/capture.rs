//! 짧은 backend 명령의 출력에 상한과 deadline 을 적용해 캡처한다.

use std::{
    process::{Command, ExitStatus},
    time::Duration,
};

const READ_CHUNK: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CaptureLimits {
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub timeout: Duration,
}

#[derive(Debug)]
pub struct CapturedOutput {
    pub status: Option<ExitStatus>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
}

/// [`capture_with_spawn`] 의 실패 — 스폰 실패를 **구조적으로** 알아야 하는 호출자
/// (예: 실행 파일 자체가 없는지 봐야 하는 WSL 진단)를 위해 있다.
#[derive(Debug, Clone)]
pub struct CaptureFailure {
    pub message: String,
    /// 프로그램을 찾지 못해 스폰하지 못했다 (io `NotFound`).
    pub not_found: bool,
}

impl From<String> for CaptureFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            not_found: false,
        }
    }
}

pub fn capture(command: &mut Command, limits: CaptureLimits) -> Result<CapturedOutput, String> {
    capture_with_spawn(command, limits).map_err(|failure| failure.message)
}

/// [`capture`] 와 같지만 스폰 실패의 종류를 [`CaptureFailure`] 로 돌려준다 — 기존
/// 호출자는 문자열만 받는 [`capture`] 를 그대로 쓴다.
pub fn capture_with_spawn(
    command: &mut Command,
    limits: CaptureLimits,
) -> Result<CapturedOutput, CaptureFailure> {
    implementation::capture(command, limits)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DrainOutcome {
    NoData,
    Progress,
    Eof,
    Overflow,
}

#[cfg(any(unix, windows))]
mod implementation {
    use super::{CaptureFailure, CaptureLimits, CapturedOutput, DrainOutcome, READ_CHUNK};
    use std::{
        io::{self, Read},
        process::{Child, Command, ExitStatus},
        thread,
        time::{Duration, Instant},
    };

    const POLL_INTERVAL: Duration = Duration::from_millis(10);

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum ReadOutcome {
        NoData,
        Eof,
        Bytes(usize),
    }

    trait CapturePipe: Read {
        fn read_available(&mut self, buffer: &mut [u8]) -> io::Result<ReadOutcome>;
    }

    pub(super) fn capture(
        command: &mut Command,
        limits: CaptureLimits,
    ) -> Result<CapturedOutput, CaptureFailure> {
        os::prepare_command(command);
        let mut child = command.spawn().map_err(|error| CaptureFailure {
            message: format!("cannot spawn capture command: {error}"),
            not_found: error.kind() == io::ErrorKind::NotFound,
        })?;
        let child_pid = child.id();

        let stdout = match child.stdout.take() {
            Some(pipe) => pipe,
            None => {
                return Err(cleanup_error(
                    &mut child,
                    child_pid,
                    None,
                    "capture command did not provide stdout pipe".to_string(),
                ))
            }
        };
        let stderr = match child.stderr.take() {
            Some(pipe) => pipe,
            None => {
                return Err(cleanup_error(
                    &mut child,
                    child_pid,
                    None,
                    "capture command did not provide stderr pipe".to_string(),
                ))
            }
        };

        if let Err(error) = os::prepare_pipe(&stdout) {
            return Err(cleanup_error(
                &mut child,
                child_pid,
                None,
                format!("cannot prepare stdout pipe for capture: {error}"),
            ));
        }
        if let Err(error) = os::prepare_pipe(&stderr) {
            return Err(cleanup_error(
                &mut child,
                child_pid,
                None,
                format!("cannot prepare stderr pipe for capture: {error}"),
            ));
        }

        let started = Instant::now();
        let mut stdout = StreamState::new(stdout);
        let mut stderr = StreamState::new(stderr);
        let mut status: Option<ExitStatus> = None;
        let mut stopped = false;
        let mut timed_out = false;

        loop {
            if status.is_none() {
                match child.try_wait() {
                    Ok(Some(exit)) => status = Some(exit),
                    Ok(None) => {}
                    Err(error) => {
                        return Err(cleanup_error(
                            &mut child,
                            child_pid,
                            Some(&mut status),
                            format!("cannot poll capture command: {error}"),
                        ));
                    }
                }
            }

            let deadline_reached = started.elapsed() >= limits.timeout;
            if deadline_reached {
                timed_out = true;
                if !stopped {
                    stop_process(&mut child, child_pid, &mut status)?;
                    stopped = true;
                }
            }

            let mut progress = false;
            if stdout.active() {
                match stdout.drain(limits.stdout_bytes) {
                    Ok(DrainOutcome::Progress) => progress = true,
                    Ok(DrainOutcome::Overflow) => {
                        progress = true;
                        if !stopped {
                            stop_process(&mut child, child_pid, &mut status)?;
                            stopped = true;
                        }
                    }
                    Ok(DrainOutcome::NoData | DrainOutcome::Eof) => {}
                    Err(error) => {
                        return Err(cleanup_error(
                            &mut child,
                            child_pid,
                            Some(&mut status),
                            format!("cannot read capture stdout: {error}"),
                        ));
                    }
                }
            }
            if stderr.active() {
                match stderr.drain(limits.stderr_bytes) {
                    Ok(DrainOutcome::Progress) => progress = true,
                    Ok(DrainOutcome::Overflow) => {
                        progress = true;
                        if !stopped {
                            stop_process(&mut child, child_pid, &mut status)?;
                            stopped = true;
                        }
                    }
                    Ok(DrainOutcome::NoData | DrainOutcome::Eof) => {}
                    Err(error) => {
                        return Err(cleanup_error(
                            &mut child,
                            child_pid,
                            Some(&mut status),
                            format!("cannot read capture stderr: {error}"),
                        ));
                    }
                }
            }

            if status.is_some() && !stdout.active() && !stderr.active() {
                break;
            }
            if deadline_reached {
                break;
            }

            if !progress {
                let left = limits.timeout.saturating_sub(started.elapsed());
                if !left.is_zero() {
                    thread::sleep(left.min(POLL_INTERVAL));
                }
            }
        }

        Ok(CapturedOutput {
            status,
            stdout: stdout.bytes,
            stderr: stderr.bytes,
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
            timed_out,
        })
    }

    struct StreamState<R> {
        pipe: R,
        bytes: Vec<u8>,
        eof: bool,
        truncated: bool,
    }

    impl<R> StreamState<R> {
        fn new(pipe: R) -> Self {
            Self {
                pipe,
                bytes: Vec::new(),
                eof: false,
                truncated: false,
            }
        }

        fn active(&self) -> bool {
            !self.eof && !self.truncated
        }
    }

    impl<R: CapturePipe> StreamState<R> {
        fn drain(&mut self, cap: usize) -> io::Result<DrainOutcome> {
            if !self.active() {
                return Ok(DrainOutcome::NoData);
            }

            let remaining = cap.saturating_sub(self.bytes.len());
            let requested = remaining.saturating_add(1).min(READ_CHUNK);
            let mut chunk = [0u8; READ_CHUNK];
            match self.pipe.read_available(&mut chunk[..requested])? {
                ReadOutcome::NoData => Ok(DrainOutcome::NoData),
                ReadOutcome::Eof => {
                    self.eof = true;
                    Ok(DrainOutcome::Eof)
                }
                ReadOutcome::Bytes(read) => {
                    let keep = read.min(remaining);
                    if keep > 0 {
                        self.bytes.try_reserve_exact(keep).map_err(|error| {
                            io::Error::other(format!("capture buffer allocation failed: {error}"))
                        })?;
                        self.bytes.extend_from_slice(&chunk[..keep]);
                    }
                    if read > remaining {
                        self.truncated = true;
                        Ok(DrainOutcome::Overflow)
                    } else {
                        Ok(DrainOutcome::Progress)
                    }
                }
            }
        }
    }

    fn stop_process(
        child: &mut Child,
        child_pid: u32,
        status: &mut Option<ExitStatus>,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        let group_killed = match os::kill_process_group(child_pid) {
            Ok(killed) => killed,
            Err(error) => {
                errors.push(format!("cannot kill capture process group: {error}"));
                false
            }
        };

        if status.is_none() {
            let child_killed = match child.kill() {
                Ok(()) => true,
                Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                Err(error) => {
                    errors.push(format!("cannot kill capture command: {error}"));
                    false
                }
            };
            if !group_killed && !child_killed {
                match child.try_wait() {
                    Ok(Some(exit)) => *status = Some(exit),
                    Ok(None) => {
                        return Err(if errors.is_empty() {
                            "capture command could not be stopped".to_string()
                        } else {
                            errors.join("; ")
                        });
                    }
                    Err(error) => {
                        return Err(format!(
                            "{}; cannot poll capture command after stop failure: {error}",
                            errors.join("; ")
                        ));
                    }
                }
            }
            if status.is_none() {
                match child.wait() {
                    Ok(exit) => *status = Some(exit),
                    Err(error) => {
                        errors.push(format!("cannot reap stopped capture command: {error}"))
                    }
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    fn cleanup_error(
        child: &mut Child,
        child_pid: u32,
        status: Option<&mut Option<ExitStatus>>,
        message: String,
    ) -> CaptureFailure {
        let result = if let Some(status) = status {
            stop_process(child, child_pid, status)
        } else {
            let mut temporary_status = None;
            stop_process(child, child_pid, &mut temporary_status)
        };
        match result {
            Ok(()) => message.into(),
            Err(cleanup) => format!("{message}; cleanup failed: {cleanup}").into(),
        }
    }

    #[cfg(unix)]
    mod os {
        use super::{CapturePipe, ReadOutcome};
        use std::{
            io::{self, Read},
            os::fd::AsRawFd,
            os::unix::process::CommandExt,
            process::{Command, Stdio},
        };

        pub(super) fn prepare_command(command: &mut Command) {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0);
        }

        pub(super) fn prepare_pipe<R: AsRawFd>(pipe: &R) -> io::Result<()> {
            let fd = pipe.as_raw_fd();
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 {
                return Err(io::Error::last_os_error());
            }
            if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        impl<R: Read> CapturePipe for R {
            fn read_available(&mut self, buffer: &mut [u8]) -> io::Result<ReadOutcome> {
                match self.read(buffer) {
                    Ok(0) => Ok(ReadOutcome::Eof),
                    Ok(read) => Ok(ReadOutcome::Bytes(read)),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        Ok(ReadOutcome::NoData)
                    }
                    Err(error) => Err(error),
                }
            }
        }

        pub(super) fn kill_process_group(pid: u32) -> io::Result<bool> {
            let pid = pid as libc::pid_t;
            if pid <= 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "capture child has invalid process id",
                ));
            }
            let result = unsafe { libc::kill(-pid, libc::SIGKILL) };
            if result == 0 {
                return Ok(true);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err(error)
            }
        }
    }

    #[cfg(windows)]
    mod os {
        use super::{CapturePipe, ReadOutcome};
        use std::{
            io::{self, Read},
            os::windows::{io::AsRawHandle, process::CommandExt},
            process::{Command, Stdio},
        };
        use windows_sys::Win32::{
            Foundation::{ERROR_BROKEN_PIPE, HANDLE},
            System::{Pipes::PeekNamedPipe, Threading::CREATE_NO_WINDOW},
        };

        pub(super) fn prepare_command(command: &mut Command) {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(CREATE_NO_WINDOW);
        }

        pub(super) fn prepare_pipe<R>(_pipe: &R) -> io::Result<()> {
            Ok(())
        }

        impl<R: Read + AsRawHandle> CapturePipe for R {
            fn read_available(&mut self, buffer: &mut [u8]) -> io::Result<ReadOutcome> {
                let mut available = 0u32;
                let peeked = unsafe {
                    PeekNamedPipe(
                        self.as_raw_handle() as HANDLE,
                        std::ptr::null_mut(),
                        0,
                        std::ptr::null_mut(),
                        &mut available,
                        std::ptr::null_mut(),
                    )
                };
                if peeked == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                        return Ok(ReadOutcome::Eof);
                    }
                    return Err(error);
                }
                if available == 0 {
                    return Ok(ReadOutcome::NoData);
                }

                let requested = (available as usize).min(buffer.len());
                let read = self.read(&mut buffer[..requested])?;
                if read == 0 {
                    Ok(ReadOutcome::Eof)
                } else {
                    Ok(ReadOutcome::Bytes(read))
                }
            }
        }

        pub(super) fn kill_process_group(_pid: u32) -> io::Result<bool> {
            Ok(false)
        }
    }
}

#[cfg(not(any(unix, windows)))]
mod implementation {
    use super::{CaptureFailure, CaptureLimits, CapturedOutput};
    use std::process::Command;

    pub(super) fn capture(
        _command: &mut Command,
        _limits: CaptureLimits,
    ) -> Result<CapturedOutput, CaptureFailure> {
        Err("bounded capture is unsupported on this platform".to_string().into())
    }
}
