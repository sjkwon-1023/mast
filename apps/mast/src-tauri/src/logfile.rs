//! 옵트인 런타임 로그 파일 — 기본은 꺼져 있고 `settings.json` 의 `"log": true` 로만
//! 켜진다 (사용자 결정 2026-08-22).
//!
//! # 왜 필요한가
//!
//! 릴리스 빌드는 `windows_subsystem = "windows"` 라 `eprintln!` 이 내려앉을 콘솔이
//! 없다. 그래서 실기에서 무슨 일이 있었는지는 앱 밖의 흔적(`dmesg`, 살아남은 프로세스
//! 트리)으로 재구성해야 했고, 두 번의 실기 장애에서 그 재구성에만 몇 시간이 들었다.
//! 특히 **프론트엔드에서만 벌어지는 문제**(2026-08-22 한글 IME 조합이 풀리지 않던
//! 건)는 백엔드 로그가 있었어도 잡히지 않았다 — 그래서 이 파일은 글루뿐 아니라
//! 프론트도 쓸 수 있어야 한다 (`commands::log_line`).
//!
//! # 담지 않는 것
//!
//! **터미널 출력과 사용자가 친 텍스트는 절대 담지 않는다.** 담는 순간 이 파일은
//! 사용자가 입력한 모든 것과 에이전트가 본 모든 것의 사본이 된다. IME 조합 로그가
//! 글자 수만 남기고 글자를 남기지 않는 것도 같은 이유다 — "조합이 끝났는가"를 아는
//! 데 내용은 필요 없다.
//!
//! # 꺼져 있을 때의 비용
//!
//! [`wintrace!`] 는 켜져 있을 때만 인자를 포맷한다 — 꺼져 있으면 `AtomicBool` 한 번
//! 읽고 끝이라 문자열 할당조차 없다. 파일도 열지 않고 쓰기 스레드도 띄우지 않는다.
//! [`winlog!`] 는 stderr 로는 늘 나간다 (종전 `eprintln!` 동작 보존).
//!
//! # 두 매크로의 구분
//!
//! - [`winlog!`] — stderr + 파일. 종전에 `eprintln!` 로 찍던 것들이 그대로 이쪽이다.
//! - [`wintrace!`] — 파일만. 2026-08-22 에 "정상 동작의 상시 추적"으로 콘솔에서
//!   걷어낸 신호들(포커스·가시성·활동)이 여기로 돌아왔다. 콘솔에서 소음이던 것이
//!   파일에서는 정확히 이 용도라는 판단이다.
//!
//! # 반영 시점
//!
//! 설정은 **부팅 때 한 번** 읽는다 — 켠 뒤에는 앱을 다시 시작해야 한다 (사용자 결정).
//! 런타임 토글은 파일 핸들 수명을 관리해야 하는데, "재현되면 켜고 다시 시작해서
//! 기다린다"는 실제 사용 흐름에서 그 복잡도가 값을 하지 않는다.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

/// 한 파일의 상한. 넘으면 `.1` 로 밀고 새로 시작한다 — 파일 두 개가 상한이라
/// 로그를 켜 둔 채 잊어도 디스크가 무한히 자라지 않는다.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// 쓰기 큐 길이. 로그를 남기는 쪽은 여기 넣고 즉시 돌아오므로 디스크를 기다리지
/// 않는다. 큐가 차면 **막지 않고 버린다** — 로그가 터미널을 느리게 만드는 것이
/// 이 기능이 낼 수 있는 최악의 결과라서, 유실을 감수하고 [`DROPPED`] 로 그 사실만
/// 남긴다.
const QUEUE: usize = 1024;

/// 프론트엔드가 한 줄에 보낼 수 있는 상한 (`commands::log_line`).
pub const MAX_LINE_BYTES: usize = 2 * 1024;

static ENABLED: AtomicBool = AtomicBool::new(false);
static SENDER: OnceLock<SyncSender<String>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);

/// 매크로가 인자 포맷 전에 먼저 본다.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn write(line: String) {
    if !enabled() {
        return;
    }
    let Some(tx) = SENDER.get() else { return };
    match tx.try_send(line) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
        // 쓰기 스레드가 죽었다 — 더 쌓아 봐야 갈 곳이 없으므로 통째로 끈다.
        Err(TrySendError::Disconnected(_)) => ENABLED.store(false, Ordering::Relaxed),
    }
}

/// stderr + 로그 파일. 종전 `eprintln!("[mast] …")` 자리를 그대로 대신한다 —
/// 인자 형식도 같다 (`[mast] ` 접두사는 이 매크로가 붙인다).
#[macro_export]
macro_rules! winlog {
    ($($arg:tt)*) => {{
        let line = format!($($arg)*);
        eprintln!("[mast] {line}");
        $crate::logfile::write(line);
    }};
}

/// 로그 파일 전용 — stderr 로는 나가지 않는다. **꺼져 있으면 인자를 포맷하지
/// 않는다**: 매 이벤트마다 도는 추적을 여기 두려면 꺼졌을 때의 비용이 0이어야 한다.
#[macro_export]
macro_rules! wintrace {
    ($($arg:tt)*) => {{
        if $crate::logfile::enabled() {
            $crate::logfile::write(format!($($arg)*));
        }
    }};
}

/// 부팅 1회 초기화.
///
/// 설정 파일을 못 읽거나 파싱이 깨지면 **끈 채로 진행한다** — 그 실패는 프론트가
/// `get_ui_settings` 로 다시 만나 상태 라인에 사유를 띄우므로(그쪽이 loud-fail 계약의
/// 담당자다) 여기서 부팅을 막을 이유가 없다. 반대로 **켜라고 했는데 파일을 못 여는**
/// 것은 조용히 넘기지 않는다: 사용자가 로그를 기대하며 재현을 시도할 참이므로 그
/// 기대가 어긋났다는 사실이 stderr 에라도 남아야 한다.
pub fn init(app: &AppHandle) {
    let want = match crate::commands::read_ui_settings(app) {
        Ok(settings) => settings.log.unwrap_or(false),
        Err(_) => false,
    };
    if !want {
        return;
    }

    let path = match app.path().app_data_dir() {
        // state.json 옆 — 사용자가 상태 파일을 찾아가는 그 디렉터리다.
        Ok(dir) => dir.join("mast.log"),
        Err(err) => {
            eprintln!("[mast] log: cannot resolve the app data dir: {err}; logging stays off");
            return;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!(
                "[mast] log: cannot create {}: {err}; logging stays off",
                parent.display()
            );
            return;
        }
    }
    let file = match open_append(&path) {
        Ok(file) => file,
        Err(err) => {
            eprintln!(
                "[mast] log: cannot open {}: {err}; logging stays off",
                path.display()
            );
            return;
        }
    };

    let (tx, rx) = sync_channel::<String>(QUEUE);
    let spawned = std::thread::Builder::new()
        .name("mast-log".to_string())
        .spawn(move || writer_loop(file, path, rx));
    if let Err(err) = spawned {
        eprintln!("[mast] log: cannot start the writer thread: {err}; logging stays off");
        return;
    }
    // 순서 계약: SENDER 를 먼저 심고 ENABLED 를 켠다. 반대로 하면 그 사이의
    // write() 가 켜진 것을 보고도 보낼 곳을 못 찾아 조용히 버려진다.
    let _ = SENDER.set(tx);
    ENABLED.store(true, Ordering::Relaxed);
    winlog!("log: enabled (v{})", env!("CARGO_PKG_VERSION"));
}

fn open_append(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// 채널이 닫히면(프로세스 종료) 조용히 끝난다.
fn writer_loop(mut file: File, path: PathBuf, rx: std::sync::mpsc::Receiver<String>) {
    let mut written = file.metadata().map(|m| m.len()).unwrap_or(0);
    while let Ok(line) = rx.recv() {
        // 버린 줄이 있었다면 먼저 그 사실을 남긴다 — 로그에 구멍이 있다는 것을
        // 모르고 읽으면 "그 사이엔 아무 일도 없었다"로 오독한다.
        let dropped = DROPPED.swap(0, Ordering::Relaxed);
        if dropped > 0 {
            written += emit(&mut file, &format!("log: {dropped} line(s) dropped (queue full)"));
        }
        written += emit(&mut file, &line);
        if written < MAX_BYTES {
            continue;
        }
        match rotate(file, &path) {
            Ok(fresh) => file = fresh,
            Err(err) => {
                // 회전은 핸들을 먼저 닫으므로(아래 함수 주석) 실패하면 손에 파일이
                // 없다 — 다시 연다. 그것마저 안 되면 남길 곳이 없으니 끝낸다.
                let Ok(mut reopened) = open_append(&path) else {
                    ENABLED.store(false, Ordering::Relaxed);
                    return;
                };
                emit(&mut reopened, &format!("log: rotation failed: {err}"));
                file = reopened;
            }
        }
        // 실패한 경우에도 0 으로 되돌린다 — 줄마다 회전을 다시 시도하면 실패가
        // 반복되는 동안 로그가 그 사유로만 찬다. 다음 MAX_BYTES 뒤에 다시 시도한다.
        written = 0;
    }
}

/// 쓴 바이트 수를 돌려준다 (회전 판정용). 쓰기 실패는 삼킨다: 실패를 보고할 곳이
/// 이 파일뿐이라 보고할 방법이 없다.
fn emit(file: &mut File, line: &str) -> u64 {
    let record = format!("{} {line}\n", timestamp());
    match file.write_all(record.as_bytes()) {
        Ok(()) => {
            let _ = file.flush();
            record.len() as u64
        }
        Err(_) => 0,
    }
}

/// `.1` 은 덮어쓴다 — 보관은 두 세대까지다.
///
/// 핸들을 **먼저 닫는다**: Windows 는 `FILE_SHARE_DELETE` 없이 연 파일의 rename 을
/// 거부하고, `OpenOptions` 는 그 공유 플래그를 주지 않는다. 그래서 실패했을 때
/// 돌려줄 파일이 남지 않고, 다시 여는 것은 호출측 몫이다.
fn rotate(file: File, path: &Path) -> std::io::Result<File> {
    drop(file);
    let previous = path.with_extension("log.1");
    std::fs::rename(path, &previous)?;
    open_append(path)
}

/// `YYYY-MM-DD HH:MM:SS.mmm` — **로컬 시각**이다. 사용자가 "몇 시쯤 그랬다"와
/// 맞춰 보는 것이 이 파일의 첫 용도라 UTC 로 두지 않는다.
#[cfg(windows)]
fn timestamp() -> String {
    // windows-sys 는 이미 직접 의존이라 새 크레이트가 붙지 않는다.
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    // SAFETY: 출력 전용 구조체 하나를 넘긴다. 실패 반환이 없는 API 다.
    let t = unsafe {
        let mut t = std::mem::zeroed();
        GetLocalTime(&mut t);
        t
    };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
    )
}

/// unix 개발 실행 — 로컬 시각 변환에 크레이트를 들이지 않고 epoch 초로 둔다.
/// 이 경로의 로그를 사람이 시계와 맞춰 볼 일은 없다.
#[cfg(not(windows))]
fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{secs}")
}
