//! 자동 UI 리셋 supervisor — `mast_core::reset::ResetPolicy` 의 글루 (계획 16단계
//! C-2, 계획 v2 12장 "WebView 리셋 안전망").
//!
//! 순수 정책(코어)이 "언제 리셋해도 안전한가"를 판정하고, 이 모듈은 그 주변만
//! 담당한다: env 설정 파싱, 단조 시계(ms) 공급, 신호 수신(입력·focus·visibility·
//! 워크스페이스 전환), Windows 에서의 WebView2 메모리 샘플링, 그리고 발화 시
//! 실제 리로드([`perform_reset`]).
//!
//! # 스레딩
//!
//! supervisor 스레드 1개가 `Mutex<Guarded>` + `Condvar` 로 잔다. 정책의
//! `next_deadline` 까지 `wait_timeout` 하고, 신호 메서드는 상태 반영 후 notify 로
//! 재계산을 깨운다 — 무조건적 주기 타이머 금지(계획 v2 12장)는 코어 정책의
//! 데드라인 파생 구조가 보장하고, 여기는 그 데드라인까지만 잔다 (예외: 메모리
//! 워치독 on 이면 샘플 주기마다 깨어나는데, 이는 12장이 명시한 워치독 샘플링
//! 자체다).
//!
//! 스레드는 **detach 로 수용한다** — JoinHandle 을 보관하지 않고 종료 경로도
//! 없으며, 프로세스 종료가 수거한다. 앱 teardown 중 창이 닫힌 뒤 리로드를
//! 시도하면 실패하는데, 그 경우 loud 로그로 끝나 무해하다 (의도적 수용 — 리뷰).
//!
//! # 시각
//!
//! 정책의 u64 ms 틱은 [`Instant`] 기준 단조 시계다 — supervisor 생성 시점이
//! 원점(0)이고, 벽시계 조정의 영향을 받지 않는다.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use mast_core::reset::{ResetConfig, ResetPolicy, ResetTrigger};
use crate::state::AppState;
use crate::{winlog, wintrace};

/// env 하나를 u64 로 파싱한다. 미설정은 기본값, 잘못된 값(비정수·음수·비UTF-8)은
/// 기본값 + loud 경고 — 조용히 다른 의미로 해석하지 않는다.
fn env_u64(name: &str, default: u64) -> u64 {
    match std::env::var(name) {
        Err(std::env::VarError::NotPresent) => default,
        Err(err) => {
            winlog!("reset: {name} unreadable ({err}); using default {default}");
            default
        }
        Ok(raw) => match raw.trim().parse::<u64>() {
            Ok(v) => v,
            Err(_) => {
                winlog!(
                    "reset: {name}={raw:?} is not a non-negative integer; \
                     using default {default}"
                );
                default
            }
        },
    }
}

/// env 6종 → [`ResetConfig`] (계획 C-2). 트리거 3종(idle·hidden·mem)은 0=off,
/// safe_idle·cooldown 의 0 은 유효값(즉시 safe / cooldown 없음), 샘플 주기 0 은
/// busy-loop 이 되는 설정 오류라 기본값으로 되돌린다 (loud).
fn config_from_env() -> ResetConfig {
    let nonzero = |v: u64| (v > 0).then_some(v);

    let idle_secs = env_u64("MAST_RESET_IDLE_SECS", 1800);
    let hidden_secs = env_u64("MAST_RESET_HIDDEN_SECS", 600);
    let mem_mb = env_u64("MAST_RESET_MEM_MB", 1536);
    let mut mem_poll_secs = env_u64("MAST_RESET_MEM_POLL_SECS", 60);
    if mem_poll_secs == 0 {
        winlog!("reset: MAST_RESET_MEM_POLL_SECS=0 would busy-loop; using default 60");
        mem_poll_secs = 60;
    }
    let safe_idle_secs = env_u64("MAST_RESET_SAFE_IDLE_SECS", 60);
    let cooldown_secs = env_u64("MAST_RESET_COOLDOWN_SECS", 300);

    let mem_limit_bytes = nonzero(mem_mb).map(|mb| mb.saturating_mul(1024 * 1024));
    // 비Windows 에는 메모리 측정 구현이 없다 — 가짜 0 샘플로 워치독이 살아있는
    // 척하지 않고, 미지원을 부팅 1회 명시한 뒤 off 로 둔다 (계획 0장).
    #[cfg(not(windows))]
    let mem_limit_bytes = match mem_limit_bytes {
        Some(_) => {
            winlog!("reset: mem watchdog unsupported on this platform; disabled");
            None
        }
        None => None,
    };

    ResetConfig {
        idle_ms: nonzero(idle_secs).map(|s| s.saturating_mul(1000)),
        hidden_ms: nonzero(hidden_secs).map(|s| s.saturating_mul(1000)),
        mem_limit_bytes,
        mem_poll_ms: mem_poll_secs.saturating_mul(1000),
        safe_idle_ms: safe_idle_secs.saturating_mul(1000),
        cooldown_ms: cooldown_secs.saturating_mul(1000),
    }
}

/// supervisor 뮤텍스 아래 상태 — 정책 본체 + 로그·샘플링용 부속.
struct Guarded {
    policy: ResetPolicy,
    /// 로그용 사본 — 마지막 실제 입력 시각(ms). 정책 내부 값과 같은 시점에
    /// 갱신한다 (정책은 이 값을 노출하지 않는다).
    last_input_at: u64,
    /// 로그용 — 마지막 메모리 샘플(bytes). 워치독 off 또는 첫 샘플 전이면 None.
    last_mem_bytes: Option<u64>,
    /// 다음 메모리 샘플 예정 시각 — 정책 내부 스케줄과 같은 규칙(now + poll)로
    /// 동행 갱신한다 (정책은 이 값을 노출하지 않으므로 worker 가 직접 든다).
    #[cfg_attr(not(windows), allow(dead_code))]
    next_mem_sample_at: u64,
    /// "WebView2 자손 0개" loud 로그의 반복 억제 — 상태 진입 시 1회만 남기고,
    /// 다시 발견되면 재무장한다 (다른 인스턴스와 브라우저 프로세스 공유 케이스는
    /// 지속 상태라 매 샘플 로그는 잡음이다).
    #[cfg_attr(not(windows), allow(dead_code))]
    zero_scan_logged: bool,
    /// suppressed(워치독 cooldown 억제) loud 로그의 반복 억제 — 에피소드당 1회.
    suppressed_logged: bool,
}

struct Shared {
    app: AppHandle,
    /// 단조 시계 원점 — [`Shared::now_ms`] 의 0 시점.
    origin: Instant,
    /// 설정 사본 — worker 의 샘플링 판단·로그용 (정책 내부 cfg 는 비공개).
    cfg: ResetConfig,
    guarded: Mutex<Guarded>,
    cond: Condvar,
}

impl Shared {
    /// 원점 기준 경과 ms. u64 포화 변환 — 오버플로는 5억 년 뒤라 실질 무한.
    fn now_ms(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// 자동 리셋 supervisor 핸들. 커맨드·이벤트 글루가 신호 메서드를 부르고, 발화는
/// 내부 worker 스레드(또는 전환 신호의 즉시 경로)가 [`perform_reset`] 으로 한다.
pub struct ResetSupervisor {
    app: AppHandle,
    shared: Option<Arc<Shared>>,
}

impl ResetSupervisor {
    /// 활성 트리거가 있을 때만 정책과 worker를 만든다. 유효 설정을 부팅
    /// 로그로 남긴다 (체크포인트 검증에서 env 반영 여부를 눈으로 확인하는 근거).
    pub fn spawn(app: AppHandle) -> Self {
        let cfg = config_from_env();
        winlog!(
            "reset: config idle_ms={:?} hidden_ms={:?} mem_limit_bytes={:?} \
             mem_poll_ms={} safe_idle_ms={} cooldown_ms={} (None/off = disabled)",
            cfg.idle_ms,
            cfg.hidden_ms,
            cfg.mem_limit_bytes,
            cfg.mem_poll_ms,
            cfg.safe_idle_ms,
            cfg.cooldown_ms
        );
        if !cfg.enabled() {
            return Self { app, shared: None };
        }
        let policy = ResetPolicy::new(cfg.clone(), 0);
        let shared = Arc::new(Shared {
            app: app.clone(),
            origin: Instant::now(),
            guarded: Mutex::new(Guarded {
                policy,
                last_input_at: 0,
                last_mem_bytes: None,
                // 정책 생성(now=0)과 같은 규칙: 0 + poll (`ResetPolicy::new`).
                next_mem_sample_at: cfg.mem_poll_ms,
                zero_scan_logged: false,
                suppressed_logged: false,
            }),
            cfg,
            cond: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("mast-reset".into())
            .spawn(move || worker(&worker_shared))
            // 스레드 생성 실패 = 자동 리셋 안전망 전체 불능 — 가리지 않고 부팅
            // 실패로 만든다.
            .expect("failed to spawn reset supervisor thread");
        Self {
            app,
            shared: Some(shared),
        }
    }

    pub fn enabled(&self) -> bool {
        self.shared.is_some()
    }

    /// 실제 사용자 입력 신호 — dispatch 성공·activity 핑. attach/resize/ack/
    /// stdin 은 부르지 않는다 (리셋 후 자동 동작·단말 자동 응답의 자기루프 차단).
    ///
    /// `source` 는 로그 파일 전용 출처 태그다 — 체크포인트 1 에서 idle 이 무입력에도
    /// 재발화한 원인을 판별하려면 재무장이 어디서 왔는지가 필요했다. 콘솔에서는
    /// 소음이라 걷어냈고(2026-08-22), 로그 파일이 생기면서 제자리를 찾았다.
    pub fn user_input(&self, source: &'static str) {
        let Some(shared) = &self.shared else {
            return;
        };
        let now = shared.now_ms();
        let mut g = shared.guarded.lock().unwrap();
        g.policy.on_user_input(now);
        g.last_input_at = now;
        drop(g);
        wintrace!("reset: activity source={source} (idle/hidden re-armed)");
        shared.cond.notify_all();
    }

    /// 창 포커스 변화 (`WindowEvent::Focused`) — hidden OR 판정 신호.
    pub fn focus(&self, focused: bool) {
        let Some(shared) = &self.shared else {
            return;
        };
        let now = shared.now_ms();
        let mut g = shared.guarded.lock().unwrap();
        g.policy.on_focus(focused, now);
        drop(g);
        // 실기에서 최소화·포커스아웃 때 어떤 신호가 실제로 도착하는지 판별하는 줄.
        wintrace!("reset: signal focused={focused}");
        shared.cond.notify_all();
    }

    /// 프론트 visibility 보조 신호 (`document.visibilitychange` → user_activity)
    /// — hidden OR 판정 신호.
    pub fn visibility(&self, visible: bool) {
        let Some(shared) = &self.shared else {
            return;
        };
        let now = shared.now_ms();
        let mut g = shared.guarded.lock().unwrap();
        g.policy.on_visibility(visible, now);
        drop(g);
        wintrace!("reset: signal visible={visible}");
        shared.cond.notify_all();
    }

    /// 워크스페이스 전환 성공 직후 — pending 워치독의 "안전한 순간". 발화가
    /// 나오면 worker 를 기다리지 않고 이 자리에서 리로드한다 (전환 직후 = 이미
    /// 화면이 갈리는 순간이라는 근거가 시점 그 자체이므로).
    pub fn workspace_switch(&self) {
        let Some(shared) = &self.shared else {
            return;
        };
        let now = shared.now_ms();
        let mut g = shared.guarded.lock().unwrap();
        let fired = g.policy.on_workspace_switch(now);
        if let Some(trigger) = fired {
            let reason = describe_trigger(trigger, &g, &shared.cfg, now);
            g.suppressed_logged = false;
            drop(g);
            perform_reset(&shared.app, &reason, Some(trigger));
        } else {
            drop(g);
        }
        // 발화 여부와 무관하게 재계산을 깨운다 — 발화면 cooldown 시작으로,
        // 억제면 suppressed loud 로그 표출을 위해 데드라인이 바뀌었을 수 있다.
        shared.cond.notify_all();
    }

    /// dev 훅(`reset_ui`) 전용 수동 리셋 — 정책(트리거·cooldown)을 거치지 않는
    /// 직접 경로다. **UI 버튼으로 노출하지 않는다** (계획 v2 12장 원칙 — 디버깅·
    /// 향후 MCP 전용).
    pub fn reset_now(&self) {
        perform_reset(&self.app, "trigger=manual (reset_ui dev hook)", None);
    }
}

/// 발화 로그용 상세 — 트리거·경과·수치 (계획 C-2 loud 계약).
fn describe_trigger(trigger: ResetTrigger, g: &Guarded, cfg: &ResetConfig, now: u64) -> String {
    let since_input = now.saturating_sub(g.last_input_at);
    match trigger {
        ResetTrigger::Idle => format!(
            "trigger=idle since_last_input_ms={since_input} idle_limit_ms={}",
            cfg.idle_ms.unwrap_or_default()
        ),
        ResetTrigger::Hidden => format!(
            "trigger=hidden hidden_limit_ms={} since_last_input_ms={since_input}",
            cfg.hidden_ms.unwrap_or_default()
        ),
        ResetTrigger::MemWatchdog => format!(
            "trigger=memWatchdog last_sample_bytes={} limit_bytes={} \
             since_last_input_ms={since_input}",
            g.last_mem_bytes.unwrap_or_default(),
            cfg.mem_limit_bytes.unwrap_or_default()
        ),
    }
}

/// WebView 리로드 — 세션·레이아웃·replay 는 전부 Rust 소유라 UI 만 원점으로
/// 돌아가고, 프론트는 attach 프로토콜로 복원한다 (계획 v2 12장). 실패는 삼키지
/// 않고 loud — 다음 트리거·수동 리로드(Ctrl+Shift+R)가 재시도 경로다.
fn perform_reset(app: &AppHandle, reason: &str, trigger: Option<ResetTrigger>) {
    winlog!("reset: reloading webview ({reason})");
    // 메모리 임계 발화는 "무언가가 자원을 붙잡고 있다"는 유일한 자동 신호다 — 그때의
    // 백엔드 그림을 한 줄 남긴다 (ADR-0018 진단). 다른 트리거(idle·hidden·수동)는
    // 자원과 무관하므로 찍지 않는다.
    if matches!(trigger, Some(ResetTrigger::MemWatchdog)) {
        // 수집은 **떼어 낸 스레드**에서 돈다. `diagnostics::collect` 가 탭을 세는 동안
        // Dispatcher lock 을 기다리는데, 이 함수는 워크스페이스 전환 신호를 통해
        // async `dispatch` 커맨드에서도 불린다 — 거기서 기다리면 다른 스폰이 쥔 lock
        // 동안 Tokio worker 를 점유하고 리로드까지 늦춘다. 리로드는 백엔드 그림을
        // 기다릴 이유가 없으므로 결과를 회수하지 않는다 (fire-and-forget).
        //
        // 대가는 이 줄이 **리로드 이전의 그림이 아니라는 것**이다: lock 대기가 길면
        // 탭·세션·프로세스 수치가 리로드가 시작된 뒤의 값일 수 있고, 로그만 보고는
        // 어느 쪽인지 가릴 수 없다. 그래서 context 가 그 사실까지 말한다.
        let diag_app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("mast-diag".into())
            .spawn(move || match diag_app.try_state::<AppState>() {
                Some(state) => {
                    // 여기서 검사를 새로 돌리지 않는다 (주기 검사 없음이 D5 다) — 그래서
                    // 줄의 `audit ...` 필드만 다른 시점의 값이다. 몇 시간 전 결과일 수 있는
                    // 것을 갓 잰 수치와 한 줄에 두므로 context 가 그 사실을 말한다.
                    let audit = state.last_audit.lock().unwrap().clone();
                    let context = "reset memWatchdog (sampled around the reload; audit: last seen)";
                    crate::diagnostics::log_summary(&state, &audit, context);
                }
                None => winlog!("reset: managed state unavailable; diagnostics skipped"),
            });
        if let Err(err) = spawned {
            winlog!("reset: cannot spawn the diagnostics thread: {err}");
        }
    }
    match app.get_webview("main") {
        Some(window) => {
            if let Err(err) = window.reload() {
                winlog!("reset: reload failed: {err}");
            }
        }
        None => winlog!("reset: webview window \"main\" not found; reset skipped"),
    }
}

/// supervisor 본체 — 샘플링 → 발화 판정 → suppressed 표출 → 다음 데드라인까지
/// 대기. 데드라인 없음(전 트리거 off 또는 대기 대상 없음)이면 신호가 올 때까지
/// 무기한 잔다.
fn worker(shared: &Shared) {
    let mut g = shared.guarded.lock().unwrap();
    loop {
        // 1) 메모리 샘플 — 예정 시각 도래 시 (Windows 전용). Toolhelp 스캔은 수
        //    ms 걸릴 수 있어 lock 을 놓고 수행한다 (핫패스 신호 무블록).
        #[cfg(windows)]
        if shared.cfg.mem_limit_bytes.is_some() && shared.now_ms() >= g.next_mem_sample_at {
            drop(g);
            let scan = mem::scan_descendant_webviews();
            g = shared.guarded.lock().unwrap();
            let now = shared.now_ms();
            g.next_mem_sample_at = now.saturating_add(shared.cfg.mem_poll_ms);
            let bytes = match scan {
                Ok(scan) if scan.matched > 0 => {
                    if scan.failed > 0 {
                        // 자손인데 조회가 거부되는 비정상 — 합산이 과소평가라는
                        // 사실을 가리지 않는다.
                        winlog!(
                            "reset: mem scan: {}/{} webview processes unreadable; \
                             sum is an undercount",
                            scan.failed, scan.matched
                        );
                    }
                    g.zero_scan_logged = false;
                    scan.bytes
                }
                Ok(_) => {
                    // 자손 0개 — 같은 user data folder 의 다른 인스턴스가 WebView2
                    // 브라우저 프로세스를 소유한 공유 케이스 (계획 0장). 측정
                    // 불능이므로 0 으로 넣는다 (pending 유지 근거도 함께 사라짐)
                    // — 단 반드시 loud 로 드러낸다.
                    if !g.zero_scan_logged {
                        winlog!(
                            "reset: mem watchdog found no msedgewebview2.exe \
                             descendants — another instance may own the shared WebView2 \
                             browser process; memory is unmeasurable (watchdog inert)"
                        );
                        g.zero_scan_logged = true;
                    }
                    0
                }
                Err(err) => {
                    winlog!("reset: mem scan failed: {err}");
                    0
                }
            };
            g.last_mem_bytes = Some(bytes);
            g.policy.on_mem_sample(if crate::browser::has_pages(&shared.app) { 0 } else { bytes }, now);
        }

        // 2) 발화 판정 — 리로드는 lock 밖에서 (Tauri 호출 중 신호 블록 방지).
        let now = shared.now_ms();
        if let Some(trigger) = g.policy.poll(now) {
            let reason = describe_trigger(trigger, &g, &shared.cfg, now);
            g.suppressed_logged = false;
            drop(g);
            perform_reset(&shared.app, &reason, Some(trigger));
            g = shared.guarded.lock().unwrap();
            continue; // cooldown 반영된 상태로 즉시 재판정 (연쇄 트리거 처리).
        }

        // 3) 워치독 억제 표출 — "리셋 직후에도 임계 초과 지속 = 진짜 누수 의심"
        //    을 cooldown 이 가리는 창 (코어 rustdoc). 에피소드당 1회 loud.
        if g.policy.suppressed() {
            if !g.suppressed_logged {
                winlog!(
                    "reset: mem watchdog fire suppressed by cooldown — memory \
                     still over limit right after a reset (possible real leak); will \
                     fire when cooldown ends"
                );
                g.suppressed_logged = true;
            }
        } else {
            g.suppressed_logged = false;
        }

        // 4) 다음 데드라인까지 대기. 이미 지난 데드라인이면 즉시 재판정한다 —
        //    진행 보장: 도래한 데드라인은 위 poll/샘플링이 소진(발화·disarm·
        //    스케줄 갱신)하거나 cooldown 종료 시각으로 clamp 되므로 busy loop 가
        //    되지 않는다.
        match g.policy.next_deadline(now) {
            None => g = shared.cond.wait(g).unwrap(),
            Some(deadline) => {
                let now = shared.now_ms();
                if deadline > now {
                    let (guard, _timeout) = shared
                        .cond
                        .wait_timeout(g, Duration::from_millis(deadline - now))
                        .unwrap();
                    g = guard;
                }
            }
        }
    }
}

/// Windows 프로세스 측정 (Windows 전용). 워치독이 쓰는
/// [`scan_descendant_webviews`] 는 Toolhelp 스냅샷으로 자기 PID 의 자손 트리를 만들고,
/// 이미지명이 msedgewebview2.exe 인 프로세스의 PrivateUsage
/// (PROCESS_MEMORY_COUNTERS_EX)를 합산한다 (계획 C-2). 프로세스 하나를 재는
/// [`memory`]·[`handle_count`]·[`thread_count`] 는 백엔드 **자신**을 재는 진단
/// ([`crate::diagnostics`], ADR-0018)도 쓴다 — 그래서 이 모듈이 `pub(crate)` 다.
#[cfg(windows)]
pub(crate) mod mem {
    use std::collections::{HashMap, HashSet};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessHandleCount, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// 합산 대상 이미지명 (대소문자 무시 비교).
    const WEBVIEW_EXE: &str = "msedgewebview2.exe";

    /// 스캔 결과. `matched` 는 발견한 WebView2 자손 수, `failed` 는 그중 측정
    /// 실패 수 (OpenProcess/메모리 조회 거부) — `bytes` 는 성공분 합산이다.
    pub struct Scan {
        pub bytes: u64,
        pub matched: u32,
        pub failed: u32,
    }

    /// 자기 PID 자손 중 WebView2 프로세스의 PrivateUsage 합산. `Err` 는 스냅샷
    /// 생성 실패 (전체 측정 불능).
    pub fn scan_descendant_webviews() -> Result<Scan, String> {
        let procs = snapshot_processes()?;
        // ppid → 자식 인접 리스트로 자손 집합을 만든다. PID 재사용으로 인한
        // 겉보기 순환은 insert 성공 시에만 스택에 넣어 차단한다.
        // 한계(리뷰): 죽은 부모의 PID 를 우리 자손이 재사용하면 무관한 프로세스가
        // stale th32ParentProcessID 체인으로 트리에 붙어 합산이 부풀 수 있다 —
        // 발생 확률이 낮고 오탐 방향(허위 pending)이라 수용한다.
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, ppid, _) in &procs {
            children.entry(*ppid).or_default().push(*pid);
        }
        let mut descendants: HashSet<u32> = HashSet::new();
        let mut stack = vec![std::process::id()];
        while let Some(pid) = stack.pop() {
            if let Some(kids) = children.get(&pid) {
                for &kid in kids {
                    if descendants.insert(kid) {
                        stack.push(kid);
                    }
                }
            }
        }
        let mut scan = Scan {
            bytes: 0,
            matched: 0,
            failed: 0,
        };
        for (pid, _, is_webview) in procs {
            if !is_webview || !descendants.contains(&pid) {
                continue;
            }
            scan.matched += 1;
            match memory(pid) {
                Some(m) => scan.bytes = scan.bytes.saturating_add(m.private_bytes),
                None => scan.failed += 1,
            }
        }
        Ok(scan)
    }

    /// Toolhelp 스냅샷 → 전 프로세스 `(pid, ppid, is_webview)` 목록.
    fn snapshot_processes() -> Result<Vec<(u32, u32, bool)>, String> {
        // SAFETY: TH32CS_SNAPPROCESS 스냅샷 핸들은 아래에서 CloseHandle 로 닫는다.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            // SAFETY: 실패 직후의 스레드-로컬 에러 코드 조회.
            let err = unsafe { GetLastError() };
            return Err(format!("CreateToolhelp32Snapshot failed (err={err})"));
        }
        let mut procs = Vec::new();
        // SAFETY: PROCESSENTRY32W 는 POD — zeroed 후 dwSize 만 채우는 관례 그대로.
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        // SAFETY: 유효한 스냅샷 핸들과 dwSize 초기화된 entry.
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
        if ok == 0 {
            // 첫 호출 실패 — 빈 목록(ERROR_NO_MORE_FILES)과 실제 열거 에러를
            // 구분한다. 구분 없이 빈 Ok 를 돌려주면 호출측이 "자손 0개(공유
            // 브라우저 프로세스 케이스)"로 오진단한다 (리뷰 finding).
            // SAFETY: 실패 직후의 스레드-로컬 에러 코드 조회.
            let err = unsafe { GetLastError() };
            // SAFETY: 위에서 연 스냅샷 핸들.
            unsafe { CloseHandle(snapshot) };
            if err == ERROR_NO_MORE_FILES {
                return Ok(Vec::new());
            }
            return Err(format!("Process32FirstW failed (err={err})"));
        }
        while ok != 0 {
            procs.push((
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                is_webview_exe(&entry.szExeFile),
            ));
            // SAFETY: 위와 동일.
            ok = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        // SAFETY: 위에서 연 스냅샷 핸들.
        unsafe { CloseHandle(snapshot) };
        Ok(procs)
    }

    /// NUL 종단 UTF-16 이미지명이 WebView2 인지 (대소문자 무시).
    fn is_webview_exe(exe: &[u16; 260]) -> bool {
        let len = exe.iter().position(|&c| c == 0).unwrap_or(exe.len());
        String::from_utf16_lossy(&exe[..len]).eq_ignore_ascii_case(WEBVIEW_EXE)
    }

    /// 한 프로세스의 메모리 수치. 워치독은 `private_bytes` 만 합산하고, 진단
    /// ([`crate::diagnostics`])은 백엔드 자신의 working set 까지 읽는다.
    pub(crate) struct Memory {
        pub private_bytes: u64,
        pub working_set_bytes: u64,
    }

    /// 프로세스의 PrivateUsage·WorkingSetSize(bytes). 열기/조회 거부는 None —
    /// 워치독 쪽 호출측이 failed 로 집계해 과소평가를 드러낸다.
    pub(crate) fn memory(pid: u32) -> Option<Memory> {
        // SAFETY: 실패 시 null 반환을 바로 검사한다.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        // SAFETY: POD zeroed + cb 설정 후, EX 구조체를 기본 카운터 포인터로 넘기는
        // 문서화된 관례 (cb 로 실제 크기를 알린다).
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = unsafe {
            K32GetProcessMemoryInfo(
                handle,
                std::ptr::from_mut(&mut counters).cast::<PROCESS_MEMORY_COUNTERS>(),
                counters.cb,
            )
        };
        // SAFETY: 위에서 연 프로세스 핸들.
        unsafe { CloseHandle(handle) };
        (ok != 0).then_some(Memory {
            private_bytes: counters.PrivateUsage as u64,
            working_set_bytes: counters.WorkingSetSize as u64,
        })
    }

    /// 프로세스가 열고 있는 커널 핸들 수. 핸들 누수는 PTY 를 만들고 닫는 앱에서
    /// 메모리보다 먼저 드러나는 신호라 진단이 따로 읽는다.
    pub(crate) fn handle_count(pid: u32) -> Option<u32> {
        // SAFETY: 실패 시 null 반환을 바로 검사한다.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let mut count: u32 = 0;
        // SAFETY: 유효한 프로세스 핸들과 스택 위 u32 출력 자리.
        let ok = unsafe { GetProcessHandleCount(handle, &mut count) };
        // SAFETY: 위에서 연 프로세스 핸들.
        unsafe { CloseHandle(handle) };
        (ok != 0).then_some(count)
    }

    /// 프로세스의 스레드 수. Win32 에 직접 묻는 API 가 없어 Toolhelp 스레드 스냅샷을
    /// 훑어 소유 pid 로 거른다 — 스냅샷은 **전 시스템** 분량이라 프로세스 스캔과 같은
    /// 비용이고, 그래서 진단 커맨드처럼 사람이 부를 때만 도는 자리에서만 쓴다.
    pub(crate) fn thread_count(pid: u32) -> Option<u32> {
        // SAFETY: 스냅샷 핸들은 아래에서 CloseHandle 로 닫는다.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        // SAFETY: THREADENTRY32 는 POD — zeroed 후 dwSize 만 채우는 관례 그대로.
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        // SAFETY: 유효한 스냅샷 핸들과 dwSize 초기화된 entry.
        let mut ok = unsafe { Thread32First(snapshot, &mut entry) };
        // 첫 호출 실패는 열거 불능이다 — 0 개로 보고하면 "스레드가 없다"는 거짓이
        // 되므로 프로세스 스캔과 같이 실패를 그대로 돌려준다.
        if ok == 0 {
            // SAFETY: 위에서 연 스냅샷 핸들.
            unsafe { CloseHandle(snapshot) };
            return None;
        }
        let mut count = 0u32;
        while ok != 0 {
            if entry.th32OwnerProcessID == pid {
                count += 1;
            }
            // SAFETY: 위와 동일.
            ok = unsafe { Thread32Next(snapshot, &mut entry) };
        }
        // SAFETY: 위에서 연 스냅샷 핸들.
        unsafe { CloseHandle(snapshot) };
        Some(count)
    }
}
