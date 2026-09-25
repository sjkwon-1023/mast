//! mast — Tauri v2 부팅부. 상태 배선(setup)과 커맨드 핸들러 등록만 하고,
//! 로직은 mast-core 와 commands/host/sink/state 모듈에 있다.
//!
//! 모듈 지도: `commands`는 IPC, `host`·`sink`·`router`는 세션과 출력·알림 연결,
//! `state`·`boot`·`reset_supervisor`는 상태 공유와 기동·리셋 수명을 맡는다.
//! `remote`는 HTTP 서버 조립, `firewall`·`git`·`update`·`app_identity`·`provision`은
//! OS와 외부 환경 연동, `audit`·`diagnostics`·`logfile`은 진단을 담당하고,
//! `wsl_health`는 WSL 준비 상태 진단과 그 프론트 계약을 맡는다.
//!
//! # 부팅 순서 (계획 15단계 B-2 · 0장 manage-first)
//!
//! load(state.json) → Restored 면 `Dispatcher::adopt`(스폰 없음) / Fresh 면 빈
//! dispatcher → 기록 sweep(ADR-0018 — **첫 스폰 전**이어야 keep 집합이 낡지 않는다)
//! → **manage** → Fresh dogfood dispatch → 초기 `saver.schedule` → 탭별
//! respawn(회당 lock·publish, `boot` 모듈이 **별도 스레드**에서 예열 뒤 간격을 두고
//! 돈다). **모든 스폰이 manage 뒤다** — 스폰이
//! 먼저면 그 창에서 즉사한 셸의 on_exit 이 관리 상태를 못 찾아 소실된다
//! (restore·Fresh 공통의 manage-first 불변식, 14~15 리뷰 finding). respawn 전 스냅샷의 pty_session
//! null 인 Running 탭은 무해하다 — view-reconcile 은 세션 없는 탭을 attach 하지
//! 않고, publish 도착마다 점진 attach 된다 (ADR-0016 결정 8).

// Windows 릴리스 빌드에서 콘솔 창을 띄우지 않는다 (디버그 빌드는 콘솔 유지).
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
compile_error!("Mast supports macOS on Apple Silicon only (aarch64-apple-darwin).");

// Windows 셸 앱 신원(AUMID) 등록 — 토스트 발신자 등록용이라 Windows 전용이다.
#[cfg(windows)]
mod app_identity;
mod audit;
mod boot;
mod browser;
mod commands;
mod diagnostics;
// Windows 방화벽 규칙 감지(COM)·적용(승격 netsh) — 원격 표면의 페어링 대화상자용.
mod firewall;
mod git;
mod host;
mod logfile;
mod manager;
mod provision;
mod platform;
mod remote;
mod reset_supervisor;
mod router;
// Secure Remote(WebTransport) 수명 관리와 UDP 7331 방화벽 글루 — Local HTTP(`remote`)와
// 별개 표면이며, 부팅에는 리스너를 열지 않고 managed state 만 만든다.
mod secure_remote;
mod sink;
mod state;
mod update;
mod wsl_health;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mast_core::command::{Dispatcher, RegistryAudit};
use mast_core::model::{AppState as CoreState, TabId, TabKind};
use mast_core::persist::{self, FreshReason, LoadOutcome, Saver};
use mast_core::record::RecordStore;
use mast_core::session::SessionManager;
use tauri::{Emitter, Manager};

/// Saver debounce 창 — 연속 변이를 1회 기록으로 합친다. 크래시 시 마지막 기록
/// 이후 ≤500ms 의 변이 유실은 MVP 수용 (계획 B-1).
const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);

/// 창 최소화 신호 이벤트 이름 — 프론트 `infrastructure/window-visibility.ts` 의
/// `WINDOW_HIDDEN_EVENT` 와 짝이다 (payload: bool, true = 최소화됨).
const WINDOW_HIDDEN_EVENT: &str = "window-hidden";

/// 창 포커스 신호 이벤트 이름 — 프론트 `app/main.ts` 의 `WINDOW_FOCUS_EVENT` 와 짝이다
/// (payload: bool, true = 포커스 획득). needsInput 토스트의 억제 판정 근거다:
/// WebView2 의 `document.hasFocus()` 는 창이 비포커스여도 true 로 남는 경우가 있어
/// (v0.3.6 필드 진단의 용의자 중 하나) 프론트가 자기 힘으로 포커스를 알 수 없다.
const WINDOW_FOCUS_EVENT: &str = "window-focus";

/// 기록 sweep 의 keep 집합 — 로드된 상태의 **모든 터미널 탭** id.
///
/// Exited 탭만이 아니라 전부인 이유: sweep 이 지우는 것은 "이제 어떤 탭도 주인이
/// 아닌" 고아 파일이고(강제 종료로 삭제 경로를 못 탄 흔적), 살아 있는 탭의 낡은
/// 기록은 그 탭이 재시작에 성공할 때 지워진다 (ADR-0018 수명 규칙).
fn terminal_tab_ids(state: &CoreState) -> HashSet<TabId> {
    state
        .workspaces
        .iter()
        .flat_map(|ws| ws.panes.values())
        .flat_map(|pane| &pane.tabs)
        .filter(|tab| matches!(tab.kind, TabKind::Terminal { .. }))
        .map(|tab| tab.id)
        .collect()
}

/// corrupt 백업 결과를 로그용 문자열로 — rename 실패도 가리지 않고 원인 그대로.
fn backup_label(backup: &Result<PathBuf, String>) -> String {
    match backup {
        Ok(path) => path.display().to_string(),
        Err(err) => format!("(backup failed: {err})"),
    }
}

fn restrict_browser_ipc(handler: impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static)
    -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    move |invoke| {
        if invoke.message.webview_ref().label() != "main" {
            invoke.resolver.reject("Mast commands are restricted to the application UI");
            true
        } else { handler(invoke) }
    }
}

fn main() {
    // **웹뷰 초기화보다 먼저다.** Windows 셸에 AUMID 를 선언하고 시작 메뉴 바로가기를
    // 맞춰야 needsInput 토스트가 mast 발신자로 뜬다 — 미등록 발신자의 토스트를
    // WinRT 가 조용히 버리는 게 v0.3.5 의 "토스트가 아예 안 뜬다" 원인이었다
    // (근거는 `app_identity` 모듈 doc). 등록 AUMID 는 `commands::notify_toast` 가
    // 발신에 쓰는 상수와 같은 하나다. 실패해도 부팅은 계속한다.
    #[cfg(windows)]
    app_identity::register();

    // 최소화 판정의 중복 emit 억제 플래그 (체크포인트 2 실기 결함 후속) — 전이
    // (false↔true)에서만 프론트에 알린다. Resized 는 드래그 리사이즈 중 연속으로
    // 오므로 매번 emit 하면 IPC 잡음이 된다. on_window_event 핸들러는
    // `Fn + Send + Sync + 'static` 이라 내부 가변성(AtomicBool)으로 든다.
    let window_hidden = AtomicBool::new(false);

    tauri::Builder::default()
        .on_page_load(|view, payload| {
            if view.label() == "main" && matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                browser::hide_all(view.app_handle());
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // 로그가 켜져 있다면 **제일 먼저** 연다 — 부팅 자체(상태 복원·재스폰
            // 파도)가 실기에서 가장 자주 실패하는 구간이라, 그 줄들을 놓치면
            // 로그를 켠 의미가 절반이다.
            logfile::init(&handle);
            #[cfg(target_os = "macos")]
            platform::macos::initialize(&handle)?;
            let ui = commands::read_ui_settings(&handle).map_err(std::io::Error::other)?;
            // 관리자 preview 판정 — 객체가 없거나 `enabled: false` 면 꺼진 것이다.
            // `resolved()` 는 하네스 hello 에 쓸 기본값까지 여기서 채운다.
            let manager = ui.manager.as_ref().map(commands::ManagerSettings::resolved);
            let manager_enabled = manager::enabled(manager.as_ref());
            app.manage(browser::BrowserState::new(ui.browser.is_none_or(|b| b.enabled)));
            let sessions = Arc::new(SessionManager::new());
            let sinks = Arc::new(state::SinkRegistry::default());
            // OSC 라우터는 sink 생성보다 먼저 — sink factory(TauriHost)가 핸들을
            // 물려 받아야 한다 (18단계 glue 계약).
            let router = Arc::new(router::OscRouter::spawn(handle.clone()));
            // 앱 데이터 디렉터리에 state.json 과 기록 디렉터리가 나란히 앉는다. 경로
            // 해석 실패는 부팅 불능이므로 setup 에러로 그대로 올린다 (가짜 진행 금지).
            let app_data_dir = app.path().app_data_dir()?;
            let state_path = app_data_dir.join("state.json");
            let records = Arc::new(RecordStore::new(app_data_dir.join("records")));

            // WSL 진단기 — host 보다 먼저 만들어야 host 의 스폰 게이트가 이 하나를
            // 공유한다. 첫 진단은 Dispatcher 가 생긴 직후(아래)에 시작한다.
            let wsl = wsl_health::create();

            let tauri_host = host::TauriHost::new(
                handle.clone(),
                Arc::clone(&sessions),
                Arc::clone(&sinks),
                Arc::clone(&router),
                Arc::clone(&records),
                Arc::clone(&wsl),
            );

            let (dispatcher, needs_dogfood) = match persist::load(&state_path) {
                LoadOutcome::Restored { state, repairs } => {
                    for repair in &repairs {
                        winlog!("boot: state repaired: {repair}");
                    }
                    // 스폰 없이 채택만 — 재스폰은 manage 후 아래 루프에서 (모듈
                    // doc 의 manage-first 근거 참조).
                    (Dispatcher::adopt(state, Box::new(tauri_host)), false)
                }
                LoadOutcome::Fresh(reason) => {
                    // Fresh 사유를 부팅 결정 로그로 남긴다 — 손상·버전 강등의
                    // 세부는 persist::load 가 이미 stderr 에 남겼다.
                    match &reason {
                        FreshReason::NoFile => winlog!(
                            "boot: no saved state at {} — starting fresh",
                            state_path.display()
                        ),
                        FreshReason::Corrupt { backup, error } => winlog!(
                            "boot: saved state corrupt: {error}; original kept at {} — starting fresh",
                            backup_label(backup)
                        ),
                        FreshReason::UnsupportedVersion { found, backup } => winlog!(
                            "boot: saved state version {found} unsupported; original kept at {} — starting fresh",
                            backup_label(backup)
                        ),
                    }
                    // dogfood dispatch(스폰 포함)는 manage **뒤**에서 — 아래 참조
                    // (14~15 리뷰 finding: 스폰이 manage 앞이면 즉사 셸의 on_exit
                    // 이 소실되는 창이 생긴다. restore 와 동일한 manage-first
                    // 불변식을 Fresh 경로에도 적용).
                    (Dispatcher::new(Box::new(tauri_host)), true)
                }
            };
            // 기록 sweep 은 **어떤 셸보다도 먼저** 돈다 (아래 dogfood dispatch 와
            // `boot::respawn_restored_tabs` 웨이브가 첫 스폰이다): keep 집합은 방금
            // 로드한 상태에서 뜬 것이라, 그 뒤에 만들어진 탭의 기록까지 판정 대상이
            // 되면 갓 생긴 탭의 기록을 고아로 오인해 지울 창이 생긴다.
            match records.sweep(&terminal_tab_ids(dispatcher.state())) {
                Ok(report) if report.removed != 0 || report.failed != 0 => winlog!(
                    "boot: swept {} orphan record file(s); {} could not be removed",
                    report.removed,
                    report.failed
                ),
                Ok(_) => {}
                // 청소를 못 했다고 부팅을 막지 않는다 — 남은 파일은 디스크만 차지한다.
                Err(err) => winlog!(
                    "boot: cannot sweep the record directory: {err}"
                ),
            }

            if needs_dogfood { wsl_health::include_target(host::resolve_distro(None)); }
            for workspace in &dispatcher.state().workspaces {
                if workspace.panes.values().flat_map(|p| &p.tabs).any(|t| matches!(t.kind, mast_core::model::TabKind::Terminal { .. })) {
                    wsl_health::include_target(host::resolve_distro(workspace.distro.clone()));
                }
            }
            let dispatcher = Arc::new(Mutex::new(dispatcher));
            // 첫 WSL 진단을 여기서 띄운다 — 상태 로드 직후라 초기 탭 생성·재스폰
            // 준비와 겹쳐 돌고, 모든 스폰 경로가 이 결과를 기다리거나 거부한다
            // (`host.rs` 게이트, `boot::BootWork`). 완료 이벤트 콜백은 Dispatcher
            // 핸들이 필요하므로 만들어진 직후에 단다.
            wsl_health::attach_emitter(&wsl, handle.clone(), Arc::clone(&dispatcher));
            if let Err(err) = wsl.start() {
                winlog!("wsl: {err}");
            }
            let saver = Arc::new(Saver::spawn(state_path, SAVE_DEBOUNCE));
            // 자동 UI 리셋 supervisor (계획 16단계 C-2) — env 설정 파싱 + worker
            // 스레드 기동. 활동·창 이벤트 신호는 commands / on_window_event 가
            // managed state 경유로 넣는다.
            let reset = reset_supervisor::ResetSupervisor::spawn(handle.clone());

            // 원격 표면은 `AppState` 와 같은 `SessionManager` 를 읽는다 — 아래 manage
            // 가 소유권을 가져가므로 그 전에 핸들을 하나 더 잡아 둔다.
            let sessions_for_remote = Arc::clone(&sessions);
            let sessions_for_secure_remote = Arc::clone(&sessions);

            // 부팅 시 WSL 이 필요한 작업(초기 탭 생성·재스폰·프로비저닝)의 조정자.
            // 관리자 preview 가 켜져 있으면 웨이브가 관리자 워크스페이스도 보장한다.
            let boot_work = Arc::new(boot::BootWork::new(needs_dogfood, manager_enabled));

            // manage 를 재스폰보다 먼저 (ADR-0016 결정 8) — 재스폰된 세션의 on_exit 은
            // try_state 로 관리 상태를 찾으므로, 스폰이 먼저면 그 사이 exit
            // 이벤트가 소실되는 창이 생긴다. 초기 생성·프로비저닝도 같은 이유로
            // manage 뒤에 돈다 (`BootWork` 는 이 manage 뒤에 시작한다).
            app.manage(state::AppState {
                dispatcher: Arc::clone(&dispatcher),
                sessions,
                sinks,
                saver: Arc::clone(&saver),
                reset,
                router,
                records: Arc::clone(&records),
                wsl: Arc::clone(&wsl),
                boot: Arc::clone(&boot_work),
                last_audit: Mutex::new(RegistryAudit::default()),
                exits_in_flight: Mutex::new(HashSet::new()),
            });

            // 관리자 preview — 꺼져 있으면 복원된 관리자 워크스페이스를
            // 걷어내고, 켜져 있으면 하네스 관리 상태(설정·status·board 캐시)를 만들고
            // 이벤트 기록을 켜고 관리자 배포판을 WSL 진단 대상에 넣는다. manage 뒤인
            // 이유는 초기 생성과 같다: 상태가 관리 상태에 실린 뒤의 변이만
            // publish·저장 경로가 확실하다.
            if manager_enabled {
                if let Some(settings) = manager {
                    app.manage(manager::ManagerRuntime::new(settings));
                }
                dispatcher.lock().unwrap().set_manager_events(true);
                // 초기 워크스페이스와 같은 방식 — 관리자 배포판도 진단 대상이다.
                wsl_health::include_target(host::resolve_distro(None));
            } else {
                manager::remove_workspace(&handle, &dispatcher);
            }

            // sanitize·수리 결과를 즉시 디스크에 반영한다 (ADR-0016 결정 8 초기 저장) —
            // 이 시점 상태가 다음 크래시 복원의 기준선이 된다. **Restored 부팅에만**
            // 한다: Fresh 부팅은 초기 워크스페이스가 실제로 만들어질 때 그 publish 가
            // 저장하고, WSL 이 준비되지 않아 초기 생성이 미뤄지는 동안 빈 상태를
            // 파일로 만들면 다음 부팅이 Fresh 가 아니게 되어 초기 탭 생성 기회를
            // 영영 잃는다 (파일 없음 = 다음 부팅도 Fresh = 재시도 가능).
            if !needs_dogfood {
                saver.schedule(dispatcher.lock().unwrap().state().clone());
            }

            // 초기 탭 생성·재스폰·프로비저닝은 **첫 WSL 진단 뒤**에 시작한다 —
            // 진단이 준비되지 않았으면 아무것도 실행하지 않고, 명시적 재검사가
            // 밀린 작업을 다시 적용한다 (`boot` 모듈 doc). 웨이브의 예열·간격은
            // 실기 사고 2026-08-20 의 페이싱 그대로다.
            boot_work.start(
                handle.clone(),
                Arc::clone(&dispatcher),
                Arc::clone(&records),
                Arc::clone(&wsl),
            );

            // 원격 표면(LAN 폴링)은 **부팅의 맨 끝**이다: 설정에 `remote` 가 없으면
            // 리스너도 스레드도 토큰 파일도 생기지 않고, 있으면 그때부터 이 프로세스
            // 밖에서 상태를 읽을 수 있게 된다 — 상태 복원·재스폰이 다 지나간 뒤에
            // 여는 것이 맞다. 결과는 꺼져 있어도 manage 한다 (`remote` 모듈 doc).
            app.manage(remote::init(
                &handle,
                Arc::clone(&dispatcher),
                sessions_for_remote,
            ));
            // Secure Remote 매니저는 **열지 않은 채로** manage 만 된다: 앱 수명 동안
            // `InputWriter` 하나를 소유하고, UDP 리스너·인증서는 페어링을 시작할 때만
            // 생긴다 (`secure_remote` 모듈 doc). Local HTTP 와 독립이라 꺼져 있어도
            // 커맨드는 항상 응답한다.
            app.manage(secure_remote::SecureRemoteManager::new(
                Arc::clone(&dispatcher),
                sessions_for_secure_remote,
            ));
            update::init(&handle);
            Ok(())
        })
        // 창 이벤트 두 갈래 — 포커스 전이는 리셋 정책 + 프론트 토스트 억제 신호,
        // 크기 전이는 프론트 폴링 게이팅 신호다 (아래 각 분기 참조. 서로 독립이고
        // 섞이지 않는다).
        //
        // 창 포커스 전이 → ① 리셋 정책의 hidden 판정 신호 (계획 C-2), ② 프론트의
        // needsInput 토스트 억제 판정 신호 (v0.3.7). 설정창은 setup 완료 후
        // 생성되므로 이 시점엔 항상 manage 되어 있다 — 아니라면 신호가 새고 있는
        // 프로그램 결함이라 숨기지 않는다 (publish_state 와 같은 규율).
        .on_window_event(move |window, event| match event {
            #[cfg(target_os = "macos")]
            tauri::WindowEvent::Destroyed if window.label() == "main" => {
                // 마지막 창 닫기는 명시적 종료이며, Dock 으로 숨기기가 아니다.
                // Destroyed 는 프론트엔드 close guard 가 수락한 **뒤에만** 온다.
                window.app_handle().exit(0);
            }
            tauri::WindowEvent::Focused(focused) => {
                match window.app_handle().try_state::<state::AppState>() {
                    Some(managed) => managed.reset.focus(*focused),
                    None => winlog!(
                        "focus event before managed state; reset signal dropped"
                    ),
                }
                // 프론트에도 같은 사실을 넘긴다 — 소비처가 달라(리셋 정책 vs 토스트)
                // 경로는 나누되 판정 근거는 이 OS 신호 하나다. Resized 와 달리
                // 중복 억제 플래그가 없는 이유는 tao 가 Focused 를 전이에서만
                // 보내기 때문이다(드래그 중 연속으로 오는 Resized 와 다르다).
                //
                // 바로 그 "전이에서만" 이라 emit 을 한 번 놓치면 프론트 플래그가
                // **다음 전이까지** 틀린 채로 남는다 (그 사이 토스트가 잘못 억제되거나
                // 잘못 뜬다). 그래서 실패를 가리지 않고 기록하고, 프론트는 부팅 때
                // 현재 포커스를 한 번 조회해 신호 유실에서 스스로 복구한다
                // (app/main.ts installWindowFocus).
                if let Err(err) = window.emit(WINDOW_FOCUS_EVENT, *focused) {
                    winlog!("window-focus emit failed (focused={focused}): {err}");
                }
            }
            // 최소화 → 프론트 폴링 정지 신호 (체크포인트 2 실기 결함: WebView2
            // 실환경에서 최소화·Alt+Tab 어느 쪽도 visibilitychange 도
            // document.hidden 도 주지 않아 마크다운 뷰어의 fs_stat 이 계속 나갔다).
            // Windows 에서 tao 는 최소화를 **클라이언트 영역 0x0 의 Resized** 로
            // 보고하므로 그것을 최소화 판정으로 쓴다. 비포커스-가시 상태는 숨김이
            // **아니다** — 다른 창에서 .md 를 편집하며 미리보기를 보는 것이 핵심
            // 사용례라, blur 로 폴링을 멈추면 그 사용례가 죽는다. 그래서 이 신호는
            // 리셋 정책(hidden = unfocused OR invisible)과 별개 경로다.
            //
            // **재검증 항목**: 0x0 Resized = 최소화 휴리스틱은 Linux 게이트로
            // 실검증할 수 없다 (src-tauri 는 Linux 호스트에서 컴파일되지 않는다).
            // Windows 실기에서 ① 최소화 시 hidden=true, ② 복원 시 hidden=false,
            // ③ 일반 리사이즈·다른 창 포커스에서 오탐 없음을 확인해야 한다.
            tauri::WindowEvent::Resized(size) => {
                let hidden = size.width == 0 || size.height == 0;
                if window_hidden.swap(hidden, Ordering::Relaxed) != hidden {
                    // emit 실패는 프론트가 폴링을 계속하는 것(=기존 동작)일 뿐이라
                    // 치명적이지 않다 — 가리지 않고 기록만 남긴다.
                    if let Err(err) = window.emit(WINDOW_HIDDEN_EVENT, hidden) {
                        winlog!("window-hidden emit failed (hidden={hidden}): {err}");
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(restrict_browser_ipc(tauri::generate_handler![
            browser::browser_request,
            browser::browser_surface,
            commands::dispatch,
            commands::get_state,
            commands::respawn_tab,
            commands::attach_terminal,
            commands::detach_terminal,
            commands::write_stdin,
            commands::send_raw,
            commands::resize,
            commands::ack_output,
            commands::get_stats,
            // 백엔드 자원 그림 + 방금 돈 정합성 검사 (ADR-0018) — 사람이 부를 때만 돈다.
            diagnostics::get_diagnostics,
            commands::get_reset_enabled,
            commands::user_activity,
            commands::reset_ui,
            // settings.json 의 UI 설정 (터미널 폰트) — 부팅당 1회, 설정 UI 는 없다.
            commands::get_ui_settings,
            // WSL 준비 상태 안내 (2026-09-22) — 조회는 부팅·이벤트마다, 재검사는
            // 사용자가 누를 때만, 설정 파일 열기는 버튼을 누를 때만.
            commands::get_wsl_status,
            commands::recheck_wsl,
            commands::open_settings_file,
            update::get_update_info,
            // 프론트엔드 → 런타임 로그 파일 (로그가 켜져 있을 때만).
            commands::log_line,
            // 워크스페이스 폴더 선택 (Windows 네이티브 대화상자).
            commands::pick_workspace_folder,
            // 터미널 링크 클릭 → Windows 기본 브라우저 (ADR-0012).
            commands::open_url,
            // needsInput OS 토스트 — 탭의 상승 전이 하나에 한 번, 그 탭의 워크스페이스가
            // 지금 화면에 보이지 않을 때만 프론트가 부른다 (판정은
            // features/notifications/chime.ts, 계약은 커맨드 rustdoc).
            commands::notify_toast,
            // 뷰어 파일 접근 (21단계) — 읽기 전용 콘텐츠 플레인.
            commands::fs_list_dir,
            commands::fs_stat,
            commands::fs_read_chunk,
            commands::fs_save_markdown,
            // Markdown draft 유무 — macOS Dock Quit·로그아웃 종료 판정의 근거다.
            #[cfg(target_os = "macos")]
            commands::set_markdown_draft_state,
            // 확인 대화상자 — WKWebView 의 window.confirm 이 대화상자 없이 false 라 대신 쓴다.
            #[cfg(target_os = "macos")]
            commands::confirm_dialog,
            git::git_status,
            git::git_diff,
            // 끝난 터미널 탭의 기록 바이트 (ADR-0018) — 기록 뷰가 마운트 때 1회.
            commands::read_tab_record,
            // 원격 표면의 부팅 결과와 페어링 URL (ADR-0016 결정 9). 상태는 부팅당 1회,
            // 페어링은 다이얼로그를 열 때만.
            remote::remote_status,
            remote::remote_pairing,
            // 페어링 대화상자의 방화벽 줄과 그 버튼 (ADR-0016 amendment). 감지는
            // 대화상자를 열 때, 적용은 사용자가 누를 때만 — 둘 다 자동으로 돌지 않는다.
            remote::remote_firewall_status,
            remote::remote_firewall_allow,
            // Secure Remote(WebTransport) 수명과 UDP 7331 방화벽 (계획 청크 2).
            secure_remote::secure_remote_start,
            secure_remote::secure_remote_cancel,
            secure_remote::secure_remote_status,
            secure_remote::secure_remote_firewall_status,
            secure_remote::secure_remote_firewall_allow,
            // 관리자 보드 — 초기 스냅샷과 이어보기/새로 시작 선택.
            manager::get_manager_board,
            manager::manager_action,
        ]))
        .build(tauri::generate_context!())
        .expect("error while building mast")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Secure Remote 서버가 살아 있으면 여기서 내린다 — UDP 리스너와 런타임
                // 스레드를 남기지 않는다. 정지 신호 뒤 `stop()` 은 거절 task 를 기다리지
                // 않고(런타임 drop 과 함께 취소) 정상 경로는 CONNECTION_CLOSE flush 250ms
                // 안에 끝나지만, current_thread 런타임이 동기 `Dispatcher` 호출 구간을
                // 끝내야 정지 신호를 보므로 그 lock 대기가 더해질 수 있다 — 250ms 는
                // 상한이 아니다. 페어링이 없으면 no-op 이라 아래 flush 순서에 영향이 없다.
                if let Some(managed) = app.try_state::<secure_remote::SecureRemoteManager>() {
                    managed.shutdown();
                }
                // 관리자 하네스 감독 정지 — 재시작을 멈추고 중지 API
                // (stdin EOF → 2초 → kill)로 하네스를 끝낸다. preview 가 꺼져 있거나
                // 감독이 없으면 no-op 이다.
                if let Some(managed) = app.try_state::<manager::ManagerRuntime>() {
                    managed.stop();
                }
                // 종료 직전 대기분 flush — debounce 창(≤500ms) 안의 마지막 변이가
                // 정상 종료에서 유실되지 않게 한다 (크래시 유실은 계획상 수용).
                match app.try_state::<state::AppState>() {
                    Some(managed) => {
                        // 순서가 계약이다: OSC 라우터를 **먼저** 비워 flush 창
                        // (기본 100ms) 안의 cwd·상태 변경이 상태에 반영되게 한 뒤,
                        // 그 결과까지 담아 Saver 를 flush 한다 (18단계 glue 계약).
                        managed.router.flush_now();
                        #[cfg(target_os = "macos")]
                        managed.sessions.shutdown();
                        managed.saver.flush();
                    }
                    // setup 실패로 manage 전에 종료되는 경로뿐 — flush 할 상태
                    // 자체가 없다.
                    None => winlog!("exit: managed state unavailable; nothing to flush"),
                }
            }
        });
}
