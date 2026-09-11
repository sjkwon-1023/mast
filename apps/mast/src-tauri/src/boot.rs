//! 부팅 재스폰 페이싱 — 복원된 탭의 셸을 다시 띄우는 일을 setup 스레드에서 떼어내고,
//! WSL 이 감당할 속도로 흘려보낸다.
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
//! # 왜 별도 스레드인가
//!
//! 예열은 콜드 VM 에서 수 초가 걸리고 간격은 탭 수에 비례한다 — setup 스레드에서 하면
//! 창이 그만큼 늦게 뜬다. manage 는 이미 끝난 뒤에 부르므로 manage-first 불변식
//! (`main.rs` 모듈 doc)은 그대로다. 재스폰 전 스냅샷에 세션 없는 `Running` 탭이 보이는
//! 것도 종전과 같다 — 프론트는 세션 없는 탭을 attach 하지 않고 publish 마다 점진
//! attach 한다.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::AppHandle;
use mast_core::command::{CommandError, Dispatcher};

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

/// 복원된 `Running`·세션 없음 탭들을 예열 뒤 간격을 두고 재스폰한다. 즉시 반환하고
/// 실제 작업은 새 스레드에서 돈다 (모듈 doc).
pub fn respawn_restored_tabs(handle: AppHandle, dispatcher: Arc<Mutex<Dispatcher>>) {
    let (targets, distros) = {
        let d = dispatcher.lock().unwrap();
        (d.running_terminal_tabs(), distinct_distros(&d))
    };
    if targets.is_empty() {
        return;
    }
    let stagger = stagger_from_env();
    winlog!(
        "boot: respawning {} tab(s), stagger {} ms",
        targets.len(),
        stagger.as_millis()
    );
    // 스레드 생성 실패는 부팅 자체를 막지 않는다 — 탭이 안 살아날 뿐이고, 사용자는
    // 배너의 Restart 로 되살릴 수 있다. 그래도 조용히 넘기지는 않는다.
    if let Err(err) = std::thread::Builder::new()
        .name("mast-boot-respawn".to_string())
        .spawn(move || {
            // knob 0 은 **페이싱 전체를 끈다**는 뜻이다 — 예열까지 건너뛰어야 v0.3.9 의
            // 버스트가 그대로 재현되고, 그 재현이 이 수정의 검증 절차다
            // (WINDOWS-BUILD §10 v0.3.10 item 1). 예열만 남기면 웜 VM 을 때리게 되어
            // 재현이 실패하고, 그러면 수정이 듣는지도 확인할 수 없다.
            if !stagger.is_zero() {
                warm_wsl(&distros);
            }
            for (i, tab) in targets.iter().enumerate() {
                if i > 0 && !stagger.is_zero() {
                    std::thread::sleep(stagger);
                }
                let d_guard = &mut *dispatcher.lock().unwrap();
                match d_guard.respawn_tab(*tab) {
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
                state::publish_state(&handle, d_guard);
            }
        })
    {
        winlog!("boot: respawn thread failed to start: {err}");
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
