//! 파일 표시 요청의 glue 처리. OSC `presentation:` 과 클릭 IPC 가 같은 흐름을 쓴다.
//!
//! 요청 한 건은 네 단계로 흐른다. (1) Dispatcher lock 아래에서 원천 터미널 탭의 세션·워크스페이스·distro·cwd 를
//! 스냅샷으로 읽고 놓는다. (2) lock 밖에서 경로 정규화·stat·Git root 를 한다. (3) 요청을 받은 뒤 기한을
//! 넘었는지 본다. (4) lock 아래에서 원천이 같은 세션·워크스페이스에 그대로인지 확인하고 `PresentViewer` 를 한 번 dispatch 한다.
//! 경로 규칙과 종류 판정은 mast-core 의 `presentation` 모듈에 있고, 여기는 I/O 와 상태 배선만 둔다.

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use mast_core::command::{
    Command, CommandError, CommandOutput, Dispatcher, LayoutPane, Placement, ViewerSpec,
};
use mast_core::git::{locate_repository_root_within, RepositoryRootError};
use mast_core::model::{AppState as CoreState, PaneId, SplitTree, TabId, TabKind, WorkspaceId};
use mast_core::presentation::{
    diff_lookup_dir, encode_error, encode_result, open_viewer, parse_request, resolve_path,
    ErrorCode, Kind, PathRules, PresentationError, Request,
};
use mast_core::send::decode_send_text;
use mast_core::session::SessionId;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::host_path;
use crate::git::GitSlot;
use crate::router::now_ms;
use crate::state::{publish_state, AppState};

/// 요청을 받은 뒤 이 시간이 지나면 변이하지 않고 `timeout` 으로 답한다.
const DEADLINE: Duration = Duration::from_secs(15);
/// 회신 본문 상한. 넘으면 잘라내지 않고 `too_large` 로 바꾼다.
const MAX_REPLY_BYTES: usize = 1024 * 1024;
/// 보고할 수 있는 격자 칸 수의 상한. 넘는 보고는 잘못된 클라이언트의 것이므로 거부한다.
const MAX_GRID: u32 = 10_000;

/// OSC 질의 kind 의 접두사. 뒤에 base64 JSON 이 붙는다 ([`crate::sink`] 가 라우팅한다).
pub const KIND_PREFIX: &str = "presentation:";

/// 요청 원천 터미널 탭의 스냅샷. Dispatcher lock 아래에서만 만든다.
/// `session` 은 캡처 시점의 세션이다. 탭이 종료·재시작되면 세션이 달라지므로 commit 이 이를 원천 변경으로 본다.
#[derive(Debug)]
struct Source {
    tab: TabId,
    session: SessionId,
    workspace: WorkspaceId,
    distro: Option<String>,
    cwd: Option<String>,
}

/// 조건에 맞는 살아 있는 터미널 탭을 찾는다. 뷰어·브라우저 탭과 세션이 없는 탭은 원천이 될 수 없다.
fn terminal_source(
    state: &CoreState,
    is_source: impl Fn(TabId, SessionId) -> bool,
) -> Option<Source> {
    for ws in &state.workspaces {
        for pane in ws.panes.values() {
            for tab in &pane.tabs {
                let TabKind::Terminal {
                    pty_session: Some(session),
                    cwd,
                    ..
                } = &tab.kind
                else {
                    continue;
                };
                if is_source(tab.id, *session) {
                    return Some(Source {
                        tab: tab.id,
                        session: *session,
                        workspace: ws.id,
                        distro: ws.distro.clone(),
                        cwd: cwd.clone(),
                    });
                }
            }
        }
    }
    None
}

fn source_of_session(state: &CoreState, session: SessionId) -> Option<Source> {
    terminal_source(state, |_, pty| pty == session)
}

fn source_of_tab(state: &CoreState, tab: TabId) -> Option<Source> {
    terminal_source(state, |id, _| id == tab)
}

/// 파일시스템과 Git 조회. 프로덕션은 [`HostProbe`] 가 실제로 하고, 테스트는 임시 디렉터리로 바꿔 끼운다.
trait Probe {
    fn kind(&self, distro: Option<&str>, path: &str) -> Result<Kind, PresentationError>;
    /// `budget` 은 요청 기한이 남긴 시간이다. Git 조회는 이보다 오래 돌지 않는다.
    fn repository_root(
        &self,
        distro: Option<&str>,
        dir: &str,
        budget: Duration,
    ) -> Result<String, PresentationError>;
}

struct HostProbe;

impl Probe for HostProbe {
    fn kind(&self, distro: Option<&str>, path: &str) -> Result<Kind, PresentationError> {
        let target = host_path(distro.map(str::to_owned), path)
            .map_err(|message| PresentationError::new(ErrorCode::IoError, message))?;
        kind_of(path, std::fs::metadata(&target))
    }

    /// Git 슬롯을 얻지 못하면 Git 을 돌리지 않고 `busy` 로 답한다. 동시 상한은 git.rs 의 슬롯을 쓴다.
    fn repository_root(
        &self,
        distro: Option<&str>,
        dir: &str,
        budget: Duration,
    ) -> Result<String, PresentationError> {
        let _slot = GitSlot::acquire().map_err(|_| {
            PresentationError::new(
                ErrorCode::Busy,
                "Git is busy; retry when other queries finish",
            )
        })?;
        let distro = crate::git::distro(distro.map(str::to_owned));
        locate_repository_root_within(distro.as_deref(), dir, budget)
            .map_err(|error| repository_error(dir, error))
    }
}

/// `fs::metadata` 가 링크를 따라가므로 종류는 최종 대상의 것이다.
fn kind_of(path: &str, metadata: io::Result<std::fs::Metadata>) -> Result<Kind, PresentationError> {
    let metadata = metadata.map_err(|err| match err.kind() {
        io::ErrorKind::NotFound => {
            PresentationError::new(ErrorCode::NotFound, format!("{path} does not exist"))
        }
        _ => PresentationError::new(ErrorCode::IoError, format!("cannot stat {path}: {err}")),
    })?;
    Ok(if metadata.is_dir() {
        Kind::Directory
    } else if metadata.is_file() {
        Kind::File
    } else {
        Kind::Other
    })
}

fn repository_error(dir: &str, error: RepositoryRootError) -> PresentationError {
    match error {
        RepositoryRootError::NotRepository => PresentationError::new(
            ErrorCode::NotRepository,
            format!("{dir} is not inside a Git repository"),
        ),
        RepositoryRootError::Failed(message) => PresentationError::new(ErrorCode::IoError, message),
    }
}

#[derive(Clone, Copy)]
enum Action {
    Open,
    Diff,
}

/// 정규화된 절대 경로를 뷰어 명세로 바꾼다. 종류와 Git root 는 `probe` 가 얻는다. lock 밖에서 돈다.
/// Git 은 기한이 남긴 시간만큼만 돈다. 1초 이하가 남았거나 기한이 지났으면 시작하지 않고,
/// 실패하더라도 기한을 넘겼다면 `timeout` 이다.
fn viewer_for(
    probe: &dyn Probe,
    distro: Option<&str>,
    path: &str,
    action: Action,
    received: Instant,
    now: impl Fn() -> Instant,
) -> Result<ViewerSpec, PresentationError> {
    let kind = probe.kind(distro, path)?;
    match action {
        Action::Open => open_viewer(path, kind),
        Action::Diff => {
            let dir = diff_lookup_dir(path, kind)?;
            let deadline = received + DEADLINE;
            let budget = deadline.saturating_duration_since(now());
            if budget.is_zero() {
                return Err(past_deadline());
            }
            // 코어 GitReader::run 은 감독 여유 1초를 뺀 뒤에야 Git 을 띄운다. 1초 이하면 띄우지 않고 기한 안에서 답한다.
            if budget <= Duration::from_secs(1) {
                return Err(PresentationError::new(
                    ErrorCode::Timeout,
                    "less than a second of the request budget was left for Git; nothing was opened",
                ));
            }
            let root = probe
                .repository_root(distro, &dir, budget)
                .map_err(|error| {
                    if now() >= deadline {
                        past_deadline()
                    } else {
                        error
                    }
                })?;
            Ok(ViewerSpec::ChangesViewer { path: root })
        }
    }
}

/// 기한을 넘긴 요청의 `timeout`. 변이 전에 멈췄으므로 아무것도 열리지 않았다.
fn past_deadline() -> PresentationError {
    PresentationError::new(
        ErrorCode::Timeout,
        "the request ran past 15 seconds; nothing was opened",
    )
}

/// 원천과 대상을 lock 아래에서 다시 확인하고 `PresentViewer` 를 한 번 dispatch 한다.
///
/// 실패하면 상태와 revision 은 그대로다. 호출자는 `Ok` 일 때만 publish 한다.
/// 기한은 I/O 가 끝난 뒤에만 검사한다. 진행 중인 std::fs I/O 는 강제로 끊지 못한다.
fn commit(
    dispatcher: &mut Dispatcher,
    source: &Source,
    viewer: ViewerSpec,
    placement: Placement,
    received: Instant,
    now: Instant,
) -> Result<Shown, PresentationError> {
    if now.duration_since(received) > DEADLINE {
        return Err(past_deadline());
    }
    // 세션이 바뀌었으면 캡처한 원천은 이미 죽었거나 다른 셸이다. 같은 탭 id 라도 새 셸로 쓰지 않는다.
    let same_source = source_of_tab(dispatcher.state(), source.tab).is_some_and(|current| {
        current.workspace == source.workspace && current.session == source.session
    });
    if !same_source {
        return Err(PresentationError::new(
            ErrorCode::UnknownTarget,
            "the requesting terminal is gone, restarted or moved to another workspace; nothing was opened",
        ));
    }
    let kind = viewer_kind(&viewer);
    let path = viewer_path(&viewer).to_owned();
    let output = dispatcher
        .dispatch(Command::PresentViewer {
            source: source.tab,
            viewer,
            placement,
        })
        .map_err(command_error)?;
    let CommandOutput::ViewerPresented {
        workspace,
        pane,
        tab,
        active,
    } = output
    else {
        unreachable!("PresentViewer 는 ViewerPresented 만 돌려준다");
    };
    Ok(Shown {
        workspace: workspace.0,
        pane: pane.0,
        tab: tab.0,
        kind,
        path,
        active,
    })
}

/// `PresentViewer` 의 실패만 외부 코드로 바꾼다. 원천 탭이 터미널이 아니게 된 경우도 대상이 없어진 것이다.
/// 이 명령이 만들지 않는 실패는 io_error 로 드러낸다.
fn command_error(error: CommandError) -> PresentationError {
    let code = match &error {
        CommandError::UnknownTarget { .. } | CommandError::KindMismatch { .. } => {
            ErrorCode::UnknownTarget
        }
        CommandError::InvalidPath { .. } => ErrorCode::InvalidPath,
        _ => ErrorCode::IoError,
    };
    PresentationError::new(code, error.to_string())
}

fn viewer_kind(viewer: &ViewerSpec) -> &'static str {
    match viewer {
        ViewerSpec::FolderBrowser { .. } => "folderBrowser",
        ViewerSpec::ChangesViewer { .. } => "changesViewer",
        ViewerSpec::TextViewer { .. } => "textViewer",
        ViewerSpec::MarkdownViewer { .. } => "markdownViewer",
    }
}

fn viewer_path(viewer: &ViewerSpec) -> &str {
    match viewer {
        ViewerSpec::FolderBrowser { path }
        | ViewerSpec::ChangesViewer { path }
        | ViewerSpec::TextViewer { path }
        | ViewerSpec::MarkdownViewer { path } => path.as_str(),
    }
}

/// 표시 성공 결과 `{workspace, pane, tab, kind, path, active}`. OSC 회신과 클릭 IPC 가 함께 쓴다.
#[derive(Debug, Serialize)]
pub struct Shown {
    workspace: u64,
    pane: u64,
    tab: u64,
    kind: &'static str,
    path: String,
    active: bool,
}

/// 보고된 pane 크기. `reported_at` 은 보고 시각(ms)이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    pub cols: u32,
    pub rows: u32,
    pub reported_at: u64,
}

/// pane 크기 보고의 메모리 저장소. 항목은 pane 수를 넘지 않게 정리하고 디스크에는 쓰지 않는다.
/// 잠금 순서는 Dispatcher → 이 저장소다. 배치를 읽으며 정리하기 때문이다.
#[derive(Default)]
pub struct PaneGeometry {
    reports: Mutex<HashMap<PaneId, Geometry>>,
}

impl PaneGeometry {
    pub fn get(&self, pane: PaneId) -> Option<Geometry> {
        self.reports.lock().unwrap().get(&pane).copied()
    }

    /// `live` 에 없는 pane 의 보고를 지운다.
    pub fn prune(&self, live: &HashSet<PaneId>) {
        let stale: Vec<PaneId> = self
            .reports
            .lock()
            .unwrap()
            .keys()
            .filter(|pane| !live.contains(*pane))
            .copied()
            .collect();
        for pane in stale {
            self.remove(pane);
        }
    }

    pub fn remove(&self, pane: PaneId) {
        self.reports.lock().unwrap().remove(&pane);
    }

    /// 살아 있는 pane 의 보고만 저장한다. 없는 pane 은 무시하고, 저장할 때 `live` 에 없는 항목을 함께 지운다.
    pub fn report(&self, live: &HashSet<PaneId>, pane: PaneId, geometry: Geometry) {
        if !live.contains(&pane) {
            return;
        }
        self.prune(live);
        self.reports.lock().unwrap().insert(pane, geometry);
    }
}

/// `layout` 응답. 코어 배치와 같은 필드에 pane 별 크기를 붙인다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutReply {
    workspace: WorkspaceId,
    revision: u64,
    #[serde(rename = "self")]
    self_pane: PaneId,
    focused: Option<PaneId>,
    viewer_pane: Option<PaneId>,
    tree: SplitTree,
    panes: Vec<SizedPane>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SizedPane {
    #[serde(flatten)]
    pane: LayoutPane,
    #[serde(flatten)]
    size: PaneSize,
}

/// 보고가 없으면 `unknown` 이고 값은 null 이다. 추정치는 여기서 만들지 않는다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneSize {
    cols: Option<u32>,
    rows: Option<u32>,
    size_source: &'static str,
    reported_at: Option<u64>,
}

impl PaneSize {
    fn from_report(report: Option<Geometry>) -> Self {
        match report {
            Some(geometry) => Self {
                cols: Some(geometry.cols),
                rows: Some(geometry.rows),
                size_source: "measured",
                reported_at: Some(geometry.reported_at),
            },
            None => Self {
                cols: None,
                rows: None,
                size_source: "unknown",
                reported_at: None,
            },
        }
    }
}

/// 요청자 워크스페이스의 배치에 보고된 크기를 합친다. 상태에서 사라진 pane 의 보고는 여기서 지운다.
fn layout_reply(
    dispatcher: &Dispatcher,
    geometry: &PaneGeometry,
    requester: SessionId,
) -> Result<LayoutReply, PresentationError> {
    let info = dispatcher
        .layout_for_session(requester)
        .ok_or_else(unknown_terminal)?;
    geometry.prune(&live_panes(dispatcher.state()));
    let panes = info
        .panes
        .into_iter()
        .map(|pane| {
            let size = PaneSize::from_report(geometry.get(pane.id));
            SizedPane { pane, size }
        })
        .collect();
    Ok(LayoutReply {
        workspace: info.workspace,
        revision: info.revision,
        self_pane: info.self_pane,
        focused: info.focused,
        viewer_pane: info.viewer_pane,
        tree: info.tree,
        panes,
    })
}

fn live_panes(state: &CoreState) -> HashSet<PaneId> {
    state
        .workspaces
        .iter()
        .flat_map(|ws| ws.panes.keys().copied())
        .collect()
}

/// 프론트가 잰 pane 칸 수를 저장한다. 범위를 넘는 값은 오류이고 저장된 값은 그대로다.
/// 없는 pane 의 보고는 늦게 도착한 정상 신호이므로 오류 없이 버린다.
fn store_report(
    dispatcher: &Dispatcher,
    geometry: &PaneGeometry,
    pane: PaneId,
    cols: u32,
    rows: u32,
    reported_at: u64,
) -> Result<(), PresentationError> {
    if cols > MAX_GRID || rows > MAX_GRID {
        return Err(PresentationError::new(
            ErrorCode::InvalidParams,
            format!("cols and rows must be at most {MAX_GRID}"),
        ));
    }
    geometry.report(
        &live_panes(dispatcher.state()),
        pane,
        Geometry {
            cols,
            rows,
            reported_at,
        },
    );
    Ok(())
}

/// 프론트가 잰 pane 칸 수를 저장한다 (main 웹뷰 전용 — restrict_browser_ipc). 디스크에 쓰지 않는다.
/// 칸 수는 권고용이라 프론트는 실패를 콘솔에만 남긴다.
#[tauri::command]
pub fn report_pane_geometry(
    state: State<'_, AppState>,
    pane: PaneId,
    cols: u32,
    rows: u32,
) -> Result<(), IpcError> {
    let dispatcher = state.dispatcher.lock().unwrap();
    store_report(&dispatcher, &state.pane_geometry, pane, cols, rows, now_ms())?;
    Ok(())
}

/// OSC `presentation:` 요청 한 건을 처리한다. 회신 본문과, 회신을 쓸 배포판을 돌려준다.
///
/// 회신은 요청 셸이 있는 배포판의 `/tmp` 에 있어야 읽힌다. 요청자 탭을 못 찾으면 배포판은 None 이고
/// 기본 배포판으로 간다 (목록 질의와 같은 규칙).
pub fn answer_osc(
    app: &AppHandle,
    requester: SessionId,
    payload: &str,
    received: Instant,
) -> (Option<String>, String) {
    let state = match state_of(app) {
        Ok(state) => state,
        Err(err) => return (None, encode_error(&err)),
    };
    let source = source_of_session(state.dispatcher.lock().unwrap().state(), requester);
    let distro = source.as_ref().and_then(|source| source.distro.clone());
    let reply = match source {
        Some(source) => osc_reply(app, &state, &source, requester, payload, received),
        None => Err(unknown_terminal()),
    };
    (distro, reply_body(reply))
}

fn osc_reply(
    app: &AppHandle,
    state: &AppState,
    source: &Source,
    requester: SessionId,
    payload: &str,
    received: Instant,
) -> Result<String, PresentationError> {
    let bytes = decode_send_text(payload).map_err(|err| {
        PresentationError::new(
            ErrorCode::InvalidParams,
            format!("malformed presentation payload: {err}"),
        )
    })?;
    let (action, path, placement) = match parse_request(&bytes)? {
        Request::Layout => {
            let reply = layout_reply(
                &state.dispatcher.lock().unwrap(),
                &state.pane_geometry,
                requester,
            )?;
            return Ok(encode_result(&reply));
        }
        Request::Open { path, placement } => (Action::Open, path, placement),
        Request::Diff { path, placement } => (Action::Diff, path, placement),
    };
    // OSC 경로는 절대 경로이므로 cwd 없이 접는다.
    let path = resolve_path(&path, None, PathRules::host())?;
    let shown = show(app, &HostProbe, source, action, &path, placement, received)?;
    Ok(encode_result(&shown))
}

/// 회신 본문을 만든다. 1 MiB 를 넘는 본문은 잘라내지 않고 `too_large` 로 바꾼다.
///
/// 표시 결과는 이미 변이된 뒤에 검사하므로 `too_large` 여도 뷰어 탭은 열려 있다.
fn reply_body(reply: Result<String, PresentationError>) -> String {
    match reply {
        Ok(body) if body.len() <= MAX_REPLY_BYTES => body,
        Ok(_) => encode_error(&PresentationError::new(
            ErrorCode::TooLarge,
            "the reply exceeds 1 MiB",
        )),
        Err(error) => encode_error(&error),
    }
}

/// 클릭한 경로를 표시한다. 상대 경로는 원천 탭의 cwd 기준이고, 나머지 판정은 `open` 과 같다.
/// 마우스로 연 파일은 항상 Default 자리에 놓는다.
#[tauri::command]
pub async fn present_terminal_path(
    app: AppHandle,
    session: SessionId,
    path: String,
) -> Result<Shown, IpcError> {
    let received = Instant::now();
    let joined =
        tauri::async_runtime::spawn_blocking(move || click(&app, session, &path, received)).await;
    let shown = match joined {
        Ok(result) => result,
        Err(err) => Err(PresentationError::new(
            ErrorCode::IoError,
            format!("present task join failed: {err}"),
        )),
    };
    shown.map_err(IpcError::from)
}

fn click(
    app: &AppHandle,
    session: SessionId,
    raw: &str,
    received: Instant,
) -> Result<Shown, PresentationError> {
    let state = state_of(app)?;
    let (source, path) = click_target(state.dispatcher.lock().unwrap().state(), session, raw)?;
    show(
        app,
        &HostProbe,
        &source,
        Action::Open,
        &path,
        Placement::Default,
        received,
    )
}

/// 클릭의 원천과 절대 경로. 세션이 살아 있는 터미널 탭이 아니면 `unknown_target` 이다.
fn click_target(
    state: &CoreState,
    session: SessionId,
    raw: &str,
) -> Result<(Source, String), PresentationError> {
    let source = source_of_session(state, session).ok_or_else(unknown_terminal)?;
    let path = resolve_path(raw, source.cwd.as_deref(), PathRules::host())?;
    Ok((source, path))
}

/// 종류와 Git root 를 얻고(lock 밖), 원천을 다시 확인해 한 번 commit 한 뒤 publish 한다.
fn show(
    app: &AppHandle,
    probe: &dyn Probe,
    source: &Source,
    action: Action,
    path: &str,
    placement: Placement,
    received: Instant,
) -> Result<Shown, PresentationError> {
    let state = state_of(app)?;
    let viewer = viewer_for(
        probe,
        source.distro.as_deref(),
        path,
        action,
        received,
        Instant::now,
    )?;
    let mut dispatcher = state.dispatcher.lock().unwrap();
    let shown = commit(
        &mut dispatcher,
        source,
        viewer,
        placement,
        received,
        Instant::now(),
    )?;
    publish_state(app, &dispatcher);
    Ok(shown)
}

fn state_of(app: &AppHandle) -> Result<State<'_, AppState>, PresentationError> {
    app.try_state::<AppState>().ok_or_else(|| {
        PresentationError::new(ErrorCode::IoError, "application state is unavailable")
    })
}

fn unknown_terminal() -> PresentationError {
    PresentationError::new(
        ErrorCode::UnknownTarget,
        "no live terminal tab owns this session",
    )
}

/// 클릭 IPC 의 실패 `{code, message}`. 코드는 OSC 회신과 같은 외부 문자열이다.
#[derive(Debug, Serialize)]
pub struct IpcError {
    code: &'static str,
    message: String,
}

impl From<PresentationError> for IpcError {
    fn from(error: PresentationError) -> Self {
        Self {
            code: error.code.as_str(),
            message: error.message,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    use mast_core::command::{NewTab, SessionEvent, SessionHost, ShellSpawnReq};
    use mast_core::model::SplitDirection;
    use serde_json::json;

    use super::*;

    /// 실제 Dispatcher 를 돌리기 위한 호스트. 스폰은 증가하는 세션 id 만 돌려준다.
    #[derive(Default)]
    struct FakeHost {
        next: AtomicU32,
    }

    impl SessionHost for FakeHost {
        fn spawn_shell(&self, _req: ShellSpawnReq) -> anyhow::Result<SessionId> {
            Ok(self.next.fetch_add(1, Ordering::Relaxed) + 1)
        }

        fn kill(&self, _id: SessionId) {}
    }

    struct Fixture {
        dispatcher: Dispatcher,
        session: SessionId,
        tab: TabId,
        workspace: WorkspaceId,
        pane: PaneId,
        other_pane: PaneId,
    }

    /// 워크스페이스 두 개를 만든다. 첫 워크스페이스의 터미널 탭이 원천이고, 두 번째의 pane 은 다른 워크스페이스다.
    fn fixture(cwd: Option<&str>) -> Fixture {
        let mut dispatcher = Dispatcher::new(Box::new(FakeHost::default()));
        let created = dispatcher
            .dispatch(Command::CreateWorkspace {
                name: "main".into(),
                root_path: None,
                distro: Some("Ubuntu".into()),
                tab: Some(NewTab::Terminal {
                    cwd: cwd.map(str::to_owned),
                }),
            })
            .unwrap();
        let CommandOutput::WorkspaceCreated {
            workspace,
            pane,
            tab: Some(tab),
            session: Some(session),
        } = created
        else {
            panic!("the first workspace must open a terminal tab");
        };
        let other = dispatcher
            .dispatch(Command::CreateWorkspace {
                name: "other".into(),
                root_path: None,
                distro: None,
                tab: None,
            })
            .unwrap();
        let CommandOutput::WorkspaceCreated {
            pane: other_pane, ..
        } = other
        else {
            panic!("the second workspace must be created");
        };
        Fixture {
            dispatcher,
            session,
            tab,
            workspace,
            pane,
            other_pane,
        }
    }

    fn source(fx: &Fixture) -> Source {
        source_of_session(fx.dispatcher.state(), fx.session).unwrap()
    }

    fn text(path: &str) -> ViewerSpec {
        ViewerSpec::TextViewer { path: path.into() }
    }

    fn pane_entry(layout: &serde_json::Value, pane: u64) -> &serde_json::Value {
        layout["panes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == pane)
            .unwrap()
    }

    #[test]
    fn default_placement_splits_once_and_reuses_the_viewer_slot() {
        let mut fx = fixture(Some("/work"));
        let src = source(&fx);
        let now = Instant::now();
        let first = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/a.txt"),
            Placement::Default,
            now,
            now,
        )
        .unwrap();
        let second = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/b.txt"),
            Placement::Default,
            now,
            now,
        )
        .unwrap();
        assert_ne!(first.pane, fx.pane.0);
        assert_eq!(second.pane, first.pane);
        assert_ne!(second.tab, first.tab);
        let ws = fx
            .dispatcher
            .state()
            .workspaces
            .iter()
            .find(|ws| ws.id == fx.workspace)
            .unwrap();
        assert_eq!(ws.panes.len(), 2);
    }

    #[test]
    fn explicit_pane_and_split_placements_go_where_they_say() {
        let mut fx = fixture(Some("/work"));
        let src = source(&fx);
        let now = Instant::now();
        let same = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/a.txt"),
            Placement::Pane { pane: fx.pane },
            now,
            now,
        )
        .unwrap();
        assert_eq!(same.pane, fx.pane.0);
        let split = commit(
            &mut fx.dispatcher,
            &src,
            ViewerSpec::MarkdownViewer {
                path: "/work/b.md".into(),
            },
            Placement::Split {
                pane: fx.pane,
                direction: SplitDirection::Vertical,
            },
            now,
            now,
        )
        .unwrap();
        assert_ne!(split.pane, fx.pane.0);
        assert_eq!(
            (split.kind, split.path.as_str()),
            ("markdownViewer", "/work/b.md")
        );
    }

    #[test]
    fn a_pane_of_another_workspace_is_unknown_target_and_mutates_nothing() {
        let mut fx = fixture(Some("/work"));
        let src = source(&fx);
        let before = fx.dispatcher.state().clone();
        let now = Instant::now();
        let err = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/a.txt"),
            Placement::Pane {
                pane: fx.other_pane,
            },
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::UnknownTarget);
        assert_eq!(*fx.dispatcher.state(), before);
    }

    #[test]
    fn a_request_past_the_deadline_mutates_nothing() {
        let mut fx = fixture(Some("/work"));
        let src = source(&fx);
        let before = fx.dispatcher.state().clone();
        let received = Instant::now();
        let late = received + DEADLINE + Duration::from_millis(1);
        let err = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/a.txt"),
            Placement::Default,
            received,
            late,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Timeout);
        assert_eq!(*fx.dispatcher.state(), before);
    }

    #[test]
    fn a_source_closed_before_commit_mutates_nothing() {
        let mut fx = fixture(Some("/work"));
        let src = source(&fx);
        fx.dispatcher
            .dispatch(Command::CloseTab { tab: fx.tab })
            .unwrap();
        let before = fx.dispatcher.state().clone();
        let now = Instant::now();
        let err = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/a.txt"),
            Placement::Default,
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::UnknownTarget);
        assert_eq!(*fx.dispatcher.state(), before);
    }

    #[test]
    fn a_pane_closed_before_commit_mutates_nothing() {
        let mut fx = fixture(Some("/work"));
        let src = source(&fx);
        let now = Instant::now();
        let split = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/a.txt"),
            Placement::Split {
                pane: fx.pane,
                direction: SplitDirection::Horizontal,
            },
            now,
            now,
        )
        .unwrap();
        let gone = PaneId(split.pane);
        fx.dispatcher
            .dispatch(Command::ClosePane { pane: gone })
            .unwrap();
        let before = fx.dispatcher.state().clone();
        let err = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/b.txt"),
            Placement::Pane { pane: gone },
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::UnknownTarget);
        assert_eq!(*fx.dispatcher.state(), before);
    }

    #[test]
    fn a_source_whose_session_exited_before_commit_mutates_nothing() {
        let mut fx = fixture(Some("/work"));
        let src = source(&fx);
        fx.dispatcher.apply_event(SessionEvent::SessionExited {
            session: fx.session,
            code: Some(0),
            ended_at_ms: 1,
        });
        let before = fx.dispatcher.state().clone();
        let now = Instant::now();
        let err = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/a.txt"),
            Placement::Default,
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::UnknownTarget);
        assert_eq!(*fx.dispatcher.state(), before);
    }

    #[test]
    fn a_source_respawned_after_exit_is_not_the_captured_source() {
        let mut fx = fixture(Some("/work"));
        let src = source(&fx);
        fx.dispatcher.apply_event(SessionEvent::SessionExited {
            session: fx.session,
            code: Some(0),
            ended_at_ms: 1,
        });
        let respawned = fx.dispatcher.respawn_tab(fx.tab).unwrap();
        assert_ne!(respawned, fx.session);
        let before = fx.dispatcher.state().clone();
        let now = Instant::now();
        let err = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/a.txt"),
            Placement::Default,
            now,
            now,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::UnknownTarget);
        assert_eq!(*fx.dispatcher.state(), before);
    }

    /// 임시 디렉터리에 `work/`(일반 파일·디렉터리), `repo/`(`.git` 있음), `plain/`(저장소 아님)을 만든다.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("mast-presentation-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            for dir in ["work/docs", "repo/.git", "repo/src", "plain"] {
                std::fs::create_dir_all(root.join(dir)).unwrap();
            }
            std::fs::write(root.join("work/docs/a.md"), "# a").unwrap();
            std::fs::write(root.join("work/docs/b.txt"), "b").unwrap();
            std::fs::write(root.join("repo/src/main.ts"), "export {};").unwrap();
            std::fs::write(root.join("plain/x.txt"), "x").unwrap();
            Self(root)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 리눅스 경로를 임시 디렉터리 아래로 옮겨 실제 파일로 stat 한다. Git 은 상위의 `.git` 을 찾는 것으로 흉내 낸다.
    struct TempProbe<'a>(&'a Path);

    impl TempProbe<'_> {
        fn host(&self, path: &str) -> PathBuf {
            self.0.join(path.trim_start_matches('/'))
        }
    }

    impl Probe for TempProbe<'_> {
        fn kind(&self, _distro: Option<&str>, path: &str) -> Result<Kind, PresentationError> {
            kind_of(path, std::fs::metadata(self.host(path)))
        }

        fn repository_root(
            &self,
            _distro: Option<&str>,
            dir: &str,
            _budget: Duration,
        ) -> Result<String, PresentationError> {
            let host = self.host(dir);
            let found = host
                .ancestors()
                .take_while(|ancestor| ancestor.starts_with(self.0))
                .find(|ancestor| ancestor.join(".git").exists());
            match found {
                Some(root) => {
                    let relative = root.strip_prefix(self.0).unwrap();
                    Ok(format!(
                        "/{}",
                        relative.to_string_lossy().replace('\\', "/")
                    ))
                }
                None => Err(repository_error(dir, RepositoryRootError::NotRepository)),
            }
        }
    }

    #[test]
    fn open_picks_the_viewer_from_the_real_file_kind() {
        let tree = TempTree::new("open");
        let probe = TempProbe(&tree.0);
        let opened = |path: &str| {
            viewer_for(
                &probe,
                None,
                path,
                Action::Open,
                Instant::now(),
                Instant::now,
            )
        };
        assert_eq!(
            opened("/work/docs"),
            Ok(ViewerSpec::FolderBrowser {
                path: "/work/docs".into()
            })
        );
        assert_eq!(
            opened("/work/docs/a.md"),
            Ok(ViewerSpec::MarkdownViewer {
                path: "/work/docs/a.md".into()
            })
        );
        assert_eq!(
            opened("/work/docs/b.txt"),
            Ok(ViewerSpec::TextViewer {
                path: "/work/docs/b.txt".into()
            })
        );
        assert_eq!(
            opened("/work/missing.txt").unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn diff_resolves_the_repository_root_for_files_and_directories() {
        let tree = TempTree::new("diff");
        let probe = TempProbe(&tree.0);
        let diffed = |path: &str| {
            viewer_for(
                &probe,
                None,
                path,
                Action::Diff,
                Instant::now(),
                Instant::now,
            )
        };
        let changes = ViewerSpec::ChangesViewer {
            path: "/repo".into(),
        };
        assert_eq!(diffed("/repo/src/main.ts"), Ok(changes.clone()));
        assert_eq!(diffed("/repo/src"), Ok(changes.clone()));
        assert_eq!(diffed("/repo"), Ok(changes));
        assert_eq!(
            diffed("/plain/x.txt").unwrap_err().code,
            ErrorCode::NotRepository
        );
        assert_eq!(diffed("/plain").unwrap_err().code, ErrorCode::NotRepository);
    }

    /// stat 이 특수 파일을 돌려주는 경우다. 실제 장치 파일은 Windows 테스트에서 만들 수 없다.
    struct SpecialProbe;

    impl Probe for SpecialProbe {
        fn kind(&self, _distro: Option<&str>, _path: &str) -> Result<Kind, PresentationError> {
            Ok(Kind::Other)
        }

        fn repository_root(
            &self,
            _distro: Option<&str>,
            _dir: &str,
            _budget: Duration,
        ) -> Result<String, PresentationError> {
            unreachable!("a special file never reaches the Git lookup")
        }
    }

    #[test]
    fn special_files_are_invalid_path_for_both_actions() {
        for action in [Action::Open, Action::Diff] {
            let err = viewer_for(
                &SpecialProbe,
                None,
                "/dev/tty",
                action,
                Instant::now(),
                Instant::now,
            )
            .unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidPath);
        }
    }

    /// 파일로 답하고, Git 조회 횟수와 받은 예산을 기록하는 probe. 기한 검사만 보려고 쓴다.
    struct RecordingProbe {
        answer: Result<String, PresentationError>,
        calls: Cell<u32>,
        budget: Cell<Option<Duration>>,
    }

    impl RecordingProbe {
        fn answering(answer: Result<String, PresentationError>) -> Self {
            Self {
                answer,
                calls: Cell::new(0),
                budget: Cell::new(None),
            }
        }
    }

    impl Probe for RecordingProbe {
        fn kind(&self, _distro: Option<&str>, _path: &str) -> Result<Kind, PresentationError> {
            Ok(Kind::File)
        }

        fn repository_root(
            &self,
            _distro: Option<&str>,
            _dir: &str,
            budget: Duration,
        ) -> Result<String, PresentationError> {
            self.calls.set(self.calls.get() + 1);
            self.budget.set(Some(budget));
            self.answer.clone()
        }
    }

    #[test]
    fn diff_skips_git_when_the_deadline_passed_during_the_stat() {
        let received = Instant::now();
        let probe = RecordingProbe::answering(Ok("/repo".into()));
        let late = received + DEADLINE + Duration::from_millis(1);
        let err =
            viewer_for(&probe, None, "/repo/a.ts", Action::Diff, received, || late).unwrap_err();
        assert_eq!(err.code, ErrorCode::Timeout);
        assert_eq!(probe.calls.get(), 0);
    }

    #[test]
    fn git_gets_only_the_time_left_before_the_deadline() {
        let received = Instant::now();
        let probe = RecordingProbe::answering(Ok("/repo".into()));
        let later = received + Duration::from_secs(12);
        let spec =
            viewer_for(&probe, None, "/repo/a.ts", Action::Diff, received, || later).unwrap();
        assert_eq!(
            spec,
            ViewerSpec::ChangesViewer {
                path: "/repo".into()
            }
        );
        assert_eq!(probe.budget.get(), Some(Duration::from_secs(3)));
    }

    #[test]
    fn git_does_not_start_when_half_a_second_is_left() {
        let received = Instant::now();
        let probe = RecordingProbe::answering(Ok("/repo".into()));
        let late = received + DEADLINE - Duration::from_millis(500);
        let err =
            viewer_for(&probe, None, "/repo/a.ts", Action::Diff, received, || late).unwrap_err();
        assert_eq!(err.code, ErrorCode::Timeout);
        assert_eq!(probe.calls.get(), 0);
    }

    #[test]
    fn a_git_failure_after_the_deadline_is_reported_as_timeout() {
        let received = Instant::now();
        let deadline = received + DEADLINE;
        let probe = RecordingProbe::answering(Err(repository_error(
            "/repo",
            RepositoryRootError::Failed("git exploded".into()),
        )));
        // 첫 시각은 Git 을 띄울 때 남은 시간을 재고, 둘째는 Git 이 실패한 뒤의 시각이다.
        let readings = Cell::new(0);
        let now = || {
            readings.set(readings.get() + 1);
            if readings.get() == 1 {
                received
            } else {
                deadline + Duration::from_millis(1)
            }
        };
        let err = viewer_for(&probe, None, "/repo/a.ts", Action::Diff, received, now).unwrap_err();
        assert_eq!(probe.calls.get(), 1);
        assert_eq!(err.code, ErrorCode::Timeout);
    }

    #[test]
    fn stat_failures_map_to_not_found_and_io_error() {
        let missing = kind_of("/x", Err(io::Error::from(io::ErrorKind::NotFound))).unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);
        let denied =
            kind_of("/x", Err(io::Error::from(io::ErrorKind::PermissionDenied))).unwrap_err();
        assert_eq!(denied.code, ErrorCode::IoError);
    }

    #[test]
    fn repository_failures_keep_their_meaning() {
        let missing = repository_error("/x", RepositoryRootError::NotRepository);
        assert_eq!(missing.code, ErrorCode::NotRepository);
        let failed = repository_error("/x", RepositoryRootError::Failed("git exploded".into()));
        assert_eq!(
            (failed.code, failed.message.as_str()),
            (ErrorCode::IoError, "git exploded")
        );
    }

    #[test]
    fn diff_reports_busy_when_every_git_slot_is_taken() {
        let mut held = Vec::new();
        while let Ok(slot) = GitSlot::acquire() {
            held.push(slot);
        }
        let err = HostProbe
            .repository_root(None, "/repo", DEADLINE)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Busy);
        drop(held);
    }

    #[test]
    fn layout_reports_unknown_sizes_until_a_measurement_is_stored() {
        let mut fx = fixture(Some("/work"));
        let src = source(&fx);
        let now = Instant::now();
        let split = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/a.txt"),
            Placement::Split {
                pane: fx.pane,
                direction: SplitDirection::Horizontal,
            },
            now,
            now,
        )
        .unwrap();
        let geometry = PaneGeometry::default();
        let layout = |geometry: &PaneGeometry| {
            serde_json::to_value(layout_reply(&fx.dispatcher, geometry, fx.session).unwrap())
                .unwrap()
        };

        let before = layout(&geometry);
        assert_eq!(before["panes"].as_array().unwrap().len(), 2);
        for entry in before["panes"].as_array().unwrap() {
            assert_eq!(entry["sizeSource"], "unknown");
            assert!(entry["cols"].is_null());
            assert!(entry["rows"].is_null());
            assert!(entry["reportedAt"].is_null());
        }

        store_report(&fx.dispatcher, &geometry, fx.pane, 120, 40, 1_700).unwrap();
        let after = layout(&geometry);
        let measured = pane_entry(&after, fx.pane.0);
        assert_eq!(measured["sizeSource"], "measured");
        assert_eq!(measured["cols"], 120);
        assert_eq!(measured["rows"], 40);
        assert_eq!(measured["reportedAt"], 1_700);
        assert_eq!(pane_entry(&after, split.pane)["sizeSource"], "unknown");
    }

    #[test]
    fn a_report_for_an_unknown_pane_is_ignored() {
        let fx = fixture(Some("/work"));
        let geometry = PaneGeometry::default();
        store_report(&fx.dispatcher, &geometry, PaneId(9_999), 80, 24, 1).unwrap();
        assert_eq!(geometry.get(PaneId(9_999)), None);
        let layout =
            serde_json::to_value(layout_reply(&fx.dispatcher, &geometry, fx.session).unwrap())
                .unwrap();
        assert!(layout["panes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["id"] != 9_999));
    }

    #[test]
    fn saving_a_report_prunes_the_entry_of_a_closed_pane() {
        let mut fx = fixture(Some("/work"));
        let src = source(&fx);
        let now = Instant::now();
        let split = commit(
            &mut fx.dispatcher,
            &src,
            text("/work/a.txt"),
            Placement::Split {
                pane: fx.pane,
                direction: SplitDirection::Horizontal,
            },
            now,
            now,
        )
        .unwrap();
        let gone = PaneId(split.pane);
        let geometry = PaneGeometry::default();
        store_report(&fx.dispatcher, &geometry, gone, 80, 24, 1).unwrap();
        fx.dispatcher
            .dispatch(Command::ClosePane { pane: gone })
            .unwrap();
        store_report(&fx.dispatcher, &geometry, fx.pane, 100, 30, 2).unwrap();
        assert_eq!(geometry.get(gone), None);
        assert_eq!(
            geometry.get(fx.pane),
            Some(Geometry {
                cols: 100,
                rows: 30,
                reported_at: 2,
            })
        );
        assert_eq!(geometry.reports.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_out_of_range_grid_is_an_error_and_keeps_the_stored_value() {
        let fx = fixture(Some("/work"));
        let geometry = PaneGeometry::default();
        store_report(&fx.dispatcher, &geometry, fx.pane, 120, 40, 1).unwrap();
        for (cols, rows) in [(MAX_GRID + 1, 40), (120, MAX_GRID + 1)] {
            let err = store_report(&fx.dispatcher, &geometry, fx.pane, cols, rows, 2).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidParams);
        }
        assert_eq!(
            geometry.get(fx.pane),
            Some(Geometry {
                cols: 120,
                rows: 40,
                reported_at: 1,
            })
        );
        store_report(&fx.dispatcher, &geometry, fx.pane, MAX_GRID, 0, 3).unwrap();
        assert_eq!(
            geometry.get(fx.pane).map(|g| (g.cols, g.rows)),
            Some((MAX_GRID, 0))
        );
    }

    #[test]
    fn layout_for_a_session_without_a_terminal_is_unknown_target() {
        let fx = fixture(Some("/work"));
        let err = layout_reply(&fx.dispatcher, &PaneGeometry::default(), 9_999).unwrap_err();
        assert_eq!(err.code, ErrorCode::UnknownTarget);
    }

    #[test]
    fn a_click_resolves_relative_paths_against_the_terminal_cwd() {
        let fx = fixture(Some("/work"));
        let (source, path) = click_target(fx.dispatcher.state(), fx.session, "docs/a.md").unwrap();
        assert_eq!(path, "/work/docs/a.md");
        assert_eq!(source.tab, fx.tab);
        let (_, absolute) = click_target(fx.dispatcher.state(), fx.session, "/etc/hosts").unwrap();
        assert_eq!(absolute, "/etc/hosts");
    }

    #[test]
    fn a_relative_click_without_a_tab_cwd_is_invalid_path() {
        let fx = fixture(None);
        let err = click_target(fx.dispatcher.state(), fx.session, "docs/a.md").unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidPath);
    }

    #[test]
    fn a_click_on_a_tab_that_is_no_longer_a_terminal_is_unknown_target() {
        let mut fx = fixture(Some("/work"));
        fx.dispatcher
            .dispatch(Command::CloseTab { tab: fx.tab })
            .unwrap();
        let err = click_target(fx.dispatcher.state(), fx.session, "a.md").unwrap_err();
        assert_eq!(err.code, ErrorCode::UnknownTarget);
    }

    #[test]
    fn a_reply_over_one_mebibyte_becomes_too_large() {
        let body = reply_body(Ok("x".repeat(MAX_REPLY_BYTES + 1)));
        let envelope: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(envelope["error"]["code"], "too_large");
        assert_eq!(
            reply_body(Ok(json!({"result": 1}).to_string())),
            r#"{"result":1}"#
        );
    }

    #[test]
    fn errors_keep_the_external_envelope() {
        let body = reply_body(Err(PresentationError::new(
            ErrorCode::UnknownTarget,
            "gone",
        )));
        let envelope: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            envelope,
            json!({"error": {"code": "unknown_target", "message": "gone"}})
        );
    }

    #[test]
    fn a_shown_result_carries_the_documented_fields() {
        let shown = Shown {
            workspace: 1,
            pane: 2,
            tab: 3,
            kind: "textViewer",
            path: "/work/a.txt".into(),
            active: true,
        };
        assert_eq!(
            serde_json::to_value(&shown).unwrap(),
            json!({
                "workspace": 1,
                "pane": 2,
                "tab": 3,
                "kind": "textViewer",
                "path": "/work/a.txt",
                "active": true
            })
        );
    }

    #[test]
    fn dispatcher_failures_map_to_the_external_codes() {
        let code = |error| command_error(error).code;
        assert_eq!(
            code(CommandError::UnknownTarget {
                target: "pane 1".into()
            }),
            ErrorCode::UnknownTarget
        );
        assert_eq!(
            code(CommandError::KindMismatch { tab: TabId(1) }),
            ErrorCode::UnknownTarget
        );
        assert_eq!(
            code(CommandError::InvalidPath {
                message: "bad".into()
            }),
            ErrorCode::InvalidPath
        );
        assert_eq!(code(CommandError::LastPane), ErrorCode::IoError);
    }
}
