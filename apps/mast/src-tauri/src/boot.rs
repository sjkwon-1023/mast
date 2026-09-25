//! 부팅 재스폰 페이싱과 WSL 준비 상태 게이트 — 복원된 탭의 셸을 다시 띄우는 일과
//! Fresh 부팅의 초기 탭 생성을 setup 스레드에서 떼어내고, **첫 WSL 진단 뒤로**
//! 미룬다.
//!
//! # 왜 (실기 사고 2026-08-20)
//!
//! 죽은 탭 되살리기(ADR-0010)가 처음 도는 부팅에서 탭 11개가 **1초 안에** `wsl.exe` 를
//! 11번 띄웠고, 콜드 VM 이 그중 6개의 relay 를 세우지 못해 셸이 아예 시작되지 않았다
//! (탭은 `NotStarted` 로 남았다). 프로세스 포렌식이 원인을 갈랐다: 살아 있는 `bash -l`
//! 은 정확히 running 탭 수(5)만큼이었고 **자식 없는 좀비 relay 는 하나도 없었다** —
//! WSL 이 VM 부팅과 경합해 진 것이지 우리가 죽인 것도, ADR-0009 의 메모리 고갈도
//! 아니다. Windows 쪽 `wsl.exe` 13개의 시작 시각이 전부 같은 1초 안이었다.
//!
//! 그래서 두 가지를 한다.
//!
//! - **예열**: 재스폰 전에 distro 당 `wsl.exe --exec true` 를 한 번 돌려 VM 을 세워 둔다.
//!   콜드 부팅 비용을 경합 없이 **한 번만** 치르게 하는 것이 요점이다.
//! - **간격**: 탭 사이를 쉬어 relay 생성이 몰리지 않게 한다 ([`STAGGER_ENV`] 로 조절).
//!
//! knob 을 `0` 으로 두면 **둘 다 꺼져** v0.3.9 의 버스트가 그대로 재현된다 — 검증 절차가
//! 사고를 먼저 재현한 뒤 수정을 확인하는 순서이기 때문이다.
//!
//! # WSL 진단 게이트 (2026-09-22)
//!
//! WSL 이 없는/깨진 PC 에서 이 웨이브는 탭마다 실패하고 그 실패를 `Exited` 로
//! 각인시켰다 — 사용자가 WSL 을 고쳐도 탭은 죽은 채였고, 부팅마다 같은 실패를
//! 반복했다. 이제 [`BootWork`] 가 **첫 진단을 기다린 뒤** 시작한다:
//!
//! - 진단이 준비되면 지금까지와 같다 (초기 탭 생성 → 재스폰 → 프로비저닝).
//! - 준비되지 않았으면 **아무것도 실행하지 않는다**. 탭은 세션 없는 `Running` 으로
//!   남아 기록·cwd 가 보존되고, UI 가 안내를 띄운다.
//! - 사용자가 **명시적으로 재검사**해 준비되면 [`BootWork::retry`] 가 밀린 작업을
//!   다시 적용한다 (자동 반복 없음 — 재검사가 유일한 재시도다).
//!
//! 배포판별 실패는 서로 독립이다: 준비된 distro 의 탭만 재스폰하고 나머지는
//! 건너뛴다 ([`mast_core::wsl::respawn_plan`]).
//!
//! # 왜 별도 스레드인가
//!
//! 예열은 콜드 VM 에서 수 초가 걸리고 간격은 탭 수에 비례한다 — setup 스레드에서 하면
//! 창이 그만큼 늦게 뜬다. manage 는 이미 끝난 뒤에 부르므로 manage-first 불변식
//! (`main.rs` 모듈 doc)은 그대로다. 재스폰 전 스냅샷에 세션 없는 `Running` 탭이 보이는
//! 것도 종전과 같다 — 프론트는 세션 없는 탭을 attach 하지 않고 publish 마다 점진
//! attach 한다.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mast_core::command::{Command, CommandError, Dispatcher, NewTab};
use mast_core::record::RecordStore;
use mast_core::wsl::{self, WslHealth, WslStatus};
use tauri::{AppHandle, Manager};

use crate::commands::forget_record_after_respawn;
use crate::state;
use crate::winlog;

/// 탭 사이 간격 (ms). 미설정이면 [`DEFAULT_STAGGER`], `0` 이면 간격 없음.
const STAGGER_ENV: &str = "MAST_RESPAWN_STAGGER_MS";

/// 기본 간격. 실기에서 11개가 1초 안에 몰려 6개가 실패했으므로 그 밀도를 한 자릿수
/// 배 낮추는 값으로 잡았다 — 11개면 총 2.5초에 나눠 뿌려진다. 창은 이미 떠 있으므로
/// 사용자가 기다리는 시간이 아니라 탭이 차례로 살아나는 시간이다.
const DEFAULT_STAGGER: Duration = Duration::from_millis(250);

/// 예열 1회의 상한. 넘기면 예열을 포기하고 재스폰으로 넘어간다 — 예열은 최적화이지
/// 전제가 아니므로, WSL 이 응답하지 않을 때 그것 때문에 탭이 하나도 안 살아나면 안 된다.
const WARMUP_DEADLINE: Duration = Duration::from_secs(30);

/// 부팅 시 WSL 이 필요한 작업의 조정자 — 초기 탭 생성, 재스폰 웨이브, 프로비저닝을
/// 첫 진단 뒤로 미루고, 명시적 재검사에서 밀린 작업을 다시 적용한다.
pub struct BootWork {
    /// Fresh 부팅이라 초기 워크스페이스+터미널 탭을 아직 만들지 않았을 수 있다.
    needs_initial: bool,
    /// 관리자 preview 가 켜져 있다 — 웨이브가 관리자 워크스페이스 하나를 보장한다.
    /// 꺼져 있을 때의 제거는 `main.rs` 배선이 manage 직후에 맡는다.
    manager: bool,
    /// 초기 생성 결정이 끝났다 (성공했거나 이미 워크스페이스가 있었다). 실패하면
    /// 되돌려 다음 재검사가 다시 시도하게 한다.
    initial_decided: AtomicBool,
    /// 재스폰 웨이브가 도는 중 — 재검사가 겹쳐도 웨이브는 하나만 돈다.
    wave_running: AtomicBool,
}

impl BootWork {
    pub fn new(needs_initial: bool, manager: bool) -> Self {
        Self {
            needs_initial,
            manager,
            initial_decided: AtomicBool::new(false),
            wave_running: AtomicBool::new(false),
        }
    }

    /// 부팅 스레드 — 첫 진단을 기다린 뒤 초기 탭 생성·재스폰·프로비저닝을 적용하고,
    /// 웨이브 끝에 정합성 검사 한 줄을 남긴다.
    pub fn start(
        self: &Arc<Self>,
        handle: AppHandle,
        dispatcher: Arc<Mutex<Dispatcher>>,
        records: Arc<RecordStore>,
        wsl: Arc<WslHealth>,
    ) {
        let work = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("mast-boot".to_owned())
            .spawn(move || {
                let status = wsl.wait_for_first(crate::wsl_health::STATUS_WAIT);
                winlog!("boot: WSL status: {} ({})", status.summary(), status.state_name());
                work.apply(&handle, &dispatcher, &records, &wsl, &status);
                work.audit(&handle);
            });
        if let Err(err) = spawned {
            winlog!("boot: respawn thread failed to start: {err}");
        }
    }

    /// 명시적 재검사 뒤 — 밀린 초기 생성·재스폰·프로비저닝을 다시 적용한다.
    /// 이미 끝난 작업은 각자의 가드가 걸러 내므로 멱등이다.
    pub fn retry(
        self: &Arc<Self>,
        handle: AppHandle,
        dispatcher: Arc<Mutex<Dispatcher>>,
        records: Arc<RecordStore>,
        wsl: Arc<WslHealth>,
        status: WslStatus,
    ) {
        let work = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("mast-boot-retry".to_owned())
            .spawn(move || {
                work.apply(&handle, &dispatcher, &records, &wsl, &status);
                work.audit(&handle);
            });
        if let Err(err) = spawned {
            winlog!("boot: retry thread failed to start: {err}");
        }
    }

    /// 준비 상태에 따라 밀린 작업을 적용한다. 준비되지 않았으면 **아무것도 하지
    /// 않는다** — 탭 상태도 건드리지 않는다 (자동 반복 실패 금지).
    fn apply(
        &self,
        handle: &AppHandle,
        dispatcher: &Arc<Mutex<Dispatcher>>,
        records: &Arc<RecordStore>,
        wsl: &Arc<WslHealth>,
        status: &WslStatus,
    ) {
        // "WSL 자체가 되는가"만 본다 — 개별 distro 가 없어도 다른 distro 의 탭은
        // 살아나야 하므로 그 판정은 재스폰 계획(`respawn_plan`)과 스폰 게이트 몫이다.
        if !status.permits_spawns() {
            winlog!(
                "boot: WSL is not ready ({}); terminals and provisioning are deferred",
                status.summary()
            );
            return;
        }
        self.create_initial(handle, dispatcher);
        // 관리자 워크스페이스 보장 — 초기 생성 뒤·재스폰 앞. 이미 있으면 no-op.
        // 감독 시작은 그 뒤에 한 번만 — 워크스페이스가 상태에 있을 때만
        // 실제로 뜨고, 재검사 재진입은 `ManagerShared` 의 CAS 가 막는다.
        if self.manager {
            crate::manager::ensure_workspace(handle, dispatcher);
            crate::manager::start_supervisor(handle, dispatcher);
        }
        self.respawn(handle, dispatcher, records, status);
        self.provision(handle, dispatcher, wsl);
    }

    /// Fresh 부팅의 초기 워크스페이스+터미널 탭 — 진단이 준비된 뒤에만 만든다.
    ///
    /// **중복 생성 방지**: `initial_decided` CAS 와 Dispatcher lock 안의 "이미
    /// 워크스페이스가 있는가" 검사를 함께 쓴다. 부팅 스레드와 재검사가 겹쳐도
    /// 하나만 만들어진다. 생성이 실패하면 표식을 되돌려 다음 재검사가 재시도한다.
    fn create_initial(&self, handle: &AppHandle, dispatcher: &Arc<Mutex<Dispatcher>>) {
        if !self.needs_initial || self.initial_decided.swap(true, Ordering::SeqCst) {
            return;
        }
        let created = {
            let mut d = dispatcher.lock().unwrap();
            if !d.state().workspaces.is_empty() {
                // 다른 경로가 이미 만들었다 — 이 부팅의 초기 생성은 끝난 것으로 본다.
                true
            } else {
                match d.dispatch(Command::CreateWorkspace {
                    name: "main".to_owned(),
                    root_path: None,
                    distro: None,
                    tab: Some(NewTab::Terminal { cwd: None }),
                }) {
                    Ok(_) => {
                        state::publish_state(handle, &d);
                        true
                    }
                    Err(err) => {
                        winlog!("boot: initial workspace creation failed: {err}");
                        false
                    }
                }
            }
        };
        if !created {
            self.initial_decided.store(false, Ordering::SeqCst);
        }
    }

    /// 재스폰 웨이브 — 준비된 distro 의 탭만, 예열 뒤 간격을 두고.
    fn respawn(
        &self,
        handle: &AppHandle,
        dispatcher: &Arc<Mutex<Dispatcher>>,
        records: &Arc<RecordStore>,
        status: &WslStatus,
    ) {
        if self.wave_running.swap(true, Ordering::SeqCst) {
            winlog!("boot: a respawn wave is already running; this request is skipped");
            return;
        }
        // 웨이브가 panic 으로 끝나도 표식이 남지 않게 RAII 로 되돌린다.
        let _running = WaveGuard(&self.wave_running);

        let (plan, distros) = {
            let d = dispatcher.lock().unwrap();
            // fallback 은 env `MAST_DISTRO` — 스폰 게이트와 같은 distro 해석 순서다.
            (
                wsl::respawn_plan(d.state(), status, crate::host::env_distro().as_deref()),
                distinct_distros(&d),
            )
        };
        for (tab, reason) in &plan.skipped {
            winlog!("boot: tab {} is not respawned yet: {reason}", tab.0);
        }
        let targets = plan.ready;
        // 되살릴 탭이 없는 부팅에서는 페이싱 knob 을 읽지도 않는다 — 쓰이지 않을 값의
        // 파싱 경고만 남으면 그 부팅이 페이싱을 했다는 오해를 준다.
        let stagger = if targets.is_empty() {
            Duration::ZERO
        } else {
            let stagger = stagger_from_env();
            winlog!(
                "boot: respawning {} tab(s), stagger {} ms",
                targets.len(),
                stagger.as_millis()
            );
            stagger
        };
        // knob 0 은 **페이싱 전체를 끈다**는 뜻이다 — 예열까지 건너뛰어야 v0.3.9 의
        // 버스트가 그대로 재현되고, 그 재현이 이 수정의 검증 절차다
        // (WINDOWS-BUILD §10 v0.3.10 item 1). 예열만 남기면 웜 VM 을 때리게 되어
        // 재현이 실패하고, 그러면 수정이 듣는지도 확인할 수 없다.
        if !targets.is_empty() && !stagger.is_zero() {
            // 예열은 준비된 distro 만 — 없는 배포판에 `wsl.exe -d` 를 띄우면 실패만
            // 쌓이고 그 실패가 로그를 덮는다.
            let ready_distros: Vec<Option<String>> = distros
                .into_iter()
                .filter(|distro| wsl::spawn_block_reason(status, distro.as_deref()).is_none())
                .collect();
            warm_wsl(&ready_distros);
        }
        for (i, tab) in targets.iter().enumerate() {
            if i > 0 && !stagger.is_zero() {
                std::thread::sleep(stagger);
            }
            let respawned = {
                let d_guard = &mut *dispatcher.lock().unwrap();
                let result = d_guard.respawn_tab(*tab);
                match &result {
                    Ok(_) => {}
                    // 사용자가 wave 도중 그 탭·워크스페이스를 닫았다. wave 가 별도
                    // 스레드로 옮겨 가면서 **정상 동작이 된** 경합이라 실패로 적지
                    // 않는다 (상태·revision 은 불변이다).
                    Err(CommandError::UnknownTarget { .. }) => {
                        winlog!("boot: tab {} closed before respawn; skipped", tab.0);
                    }
                    // 스폰 실패는 respawn_tab 이 이미 그 탭을 Exited{None} 으로 강등해
                    // 상태에 반영했다 — 여기서는 loud 기록만 남긴다.
                    Err(err) => {
                        winlog!("boot: respawn failed (tab={}): {err}", tab.0);
                    }
                }
                state::publish_state(handle, d_guard);
                result.is_ok()
            };
            // 되살아난 탭의 옛 화면은 이제 새 셸의 것이다 — 삭제는 lock 을 놓은
            // 뒤다 (Restart 버튼 경로와 같은 헬퍼·같은 규율).
            if respawned {
                forget_record_after_respawn(records, *tab);
            }
        }
    }

    /// 상태에 있는 distro 들 + 기본 distro 를 프로비저닝 대상으로 건다 — 실제
    /// 스킵/실행 판정은 `provision::ensure_provisioned` 안의 준비 상태 게이트가 한다.
    fn provision(
        &self,
        handle: &AppHandle,
        dispatcher: &Arc<Mutex<Dispatcher>>,
        wsl: &Arc<WslHealth>,
    ) {
        let distros: Vec<Option<String>> = dispatcher
            .lock()
            .unwrap()
            .state()
            .workspaces
            .iter()
            .filter(|workspace| workspace.panes.values().flat_map(|p| &p.tabs).any(|t| matches!(t.kind, mast_core::model::TabKind::Terminal { .. })))
            .map(|workspace| crate::host::resolve_distro(workspace.distro.clone()))
            .collect();

        for distro in &distros {
            crate::provision::ensure_provisioned(handle, wsl, distro.as_deref());
        }
    }

    /// 웨이브의 끝 — 부팅이 남긴 어긋남(스폰 실패로 강등된 탭, 복원이 놓친 세션)을
    /// 한 번 본다. 같은 자리에서 자원 그림 한 줄을 남기는 것이 진단의 기준선이다
    /// (ADR-0018): 이후 수치는 이 줄과 비교해 읽는다.
    fn audit(&self, handle: &AppHandle) {
        match handle.try_state::<state::AppState>() {
            Some(app_state) => {
                let audit = crate::audit::run_audit(handle, &app_state, "boot");
                // 무언가 찾았다면 검사 쪽이 이미 같은 줄을 남겼다 — 두 번 찍지 않는다.
                if audit.is_empty() {
                    crate::diagnostics::log_summary(&app_state, &audit, "boot");
                }
            }
            None => winlog!("boot: managed state unavailable; audit skipped"),
        }
    }
}

/// 재스폰 웨이브 진행 표식의 RAII 가드 — panic 경로에서도 표식을 내린다.
struct WaveGuard<'a>(&'a AtomicBool);

impl Drop for WaveGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 상태에 있는 distro 선택지들 (중복 제거, 순서 유지). `None` = WSL 기본 배포판이며
/// 그것도 예열 대상이다 — 워크스페이스에 distro 가 안 박힌 탭이 그 경로로 뜬다.
fn distinct_distros(dispatcher: &Dispatcher) -> Vec<Option<String>> {
    let mut seen: Vec<Option<String>> = Vec::new();
    for ws in &dispatcher.state().workspaces {
        let resolved = crate::host::resolve_distro(ws.distro.clone());
        if !seen.contains(&resolved) {
            seen.push(resolved);
        }
    }
    seen
}

fn stagger_from_env() -> Duration {
    // `MAST_RESET_*`·`MAST_STARTUP_DEADLINE_MS` 와 같은 규율: 미설정은 기본값,
    // 파싱 실패는 조용히 넘기지 않고 기본값으로 되돌리며 이유를 남긴다.
    match std::env::var(STAGGER_ENV) {
        Err(_) => DEFAULT_STAGGER,
        Ok(raw) => match raw.trim().parse::<u64>() {
            Ok(ms) => Duration::from_millis(ms),
            Err(err) => {
                winlog!("boot: {STAGGER_ENV}={raw:?} is not a number ({err}); using default");
                DEFAULT_STAGGER
            }
        },
    }
}

/// distro 당 한 번 `wsl.exe --exec true` — VM 을 세워 두기 위한 동기 호출이다.
/// 결과는 로그로만 쓴다: 실패해도 재스폰은 그대로 진행하며, 그 실패는 뒤따르는 스폰이
/// 자기 방식으로(시작 표식 부재 → `NotStarted`) 다시 드러낸다.
#[cfg(windows)]
fn warm_wsl(distros: &[Option<String>]) {
    use std::os::windows::process::CommandExt;
    use std::time::Instant;

    // 콘솔 창 억제 — commands.rs 의 wsl.exe 호출과 같은 플래그다.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    for distro in distros {
        let label = distro.clone().unwrap_or_else(|| "(default)".to_string());
        let distro = distro.clone();
        let started = Instant::now();
        let status = mast_core::deadline::call_with_deadline(
            "mast-warm",
            WARMUP_DEADLINE,
            move || {
                let mut cmd = std::process::Command::new("wsl.exe");
                if let Some(distro) = &distro {
                    cmd.arg("-d").arg(distro);
                }
                // `--exec true` 로 셸을 거치지 않는다 (spawn_spec 과 같은 이유 — 래퍼가
                // 셸 평가를 두 번 받지 않게 하는 규율을 여기서도 지킨다).
                cmd.arg("--exec")
                    .arg("true")
                    .creation_flags(CREATE_NO_WINDOW)
                    .status()
            },
            // 늦게 끝난 `true` 는 회수할 자원이 없다 — status() 가 이미 자식을 거뒀다.
            |_| {},
        );
        let elapsed = started.elapsed().as_millis();
        match status {
            Some(Ok(status)) => {
                winlog!("boot: warmed WSL {label} in {elapsed} ms ({status})")
            }
            Some(Err(err)) => {
                winlog!("boot: WSL warm-up failed for {label} after {elapsed} ms: {err}")
            }
            None => winlog!(
                "boot: WSL warm-up for {label} exceeded {} ms; respawning anyway",
                WARMUP_DEADLINE.as_millis()
            ),
        }
    }
}

/// unix 개발 실행에는 예열할 VM 이 없다 (`spawn_spec` 이 `$SHELL -l` 을 직접 띄운다).
#[cfg(not(windows))]
fn warm_wsl(_distros: &[Option<String>]) {}
