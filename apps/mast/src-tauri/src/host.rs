//! `SessionHost` 구현 — Dispatcher 의 PTY 부수효과 포트를 `SessionManager` 위에
//! 실현한다. `dispatch` 가 Dispatcher lock 아래에서 호출하므로(스폰 포함) 여기서 Dispatcher lock 을 다시 잡는 코드는 금지다.

use std::cell::Cell;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::anyhow;
use tauri::AppHandle;
use mast_core::command::{SessionHost, ShellSpawnReq};
use mast_core::deadline::call_with_deadline;
use mast_core::model::TabId;
use mast_core::record::RecordStore;
use mast_core::session::{SessionId, SessionManager, SessionOptions, SpawnSpec};
use mast_core::wsl::WslHealth;

use crate::router::OscRouter;
use crate::sink::{SinkHandle, TerminalSink};
use crate::state::SinkRegistry;
use crate::{winlog, wintrace};

/// Tauri 앱의 `SessionHost`. Dispatcher 가 소유하며(`Box<dyn SessionHost>`),
/// 세션·sink 레지스트리는 관리 상태(`AppState`)와 `Arc` 로 공유한다.
pub struct TauriHost {
    app: AppHandle,
    sessions: Arc<SessionManager>,
    sinks: Arc<SinkRegistry>,
    /// 새로 만드는 sink 에 물려 줄 OSC 라우터 핸들.
    router: Arc<OscRouter>,
    /// 닫힌 탭의 기록 파일을 지우는 데 쓰는 저장소 핸들 — 관리 상태와 같은 `Arc` 다
    /// ([`SessionHost::release_tabs`], ADR-0018 수명 규칙).
    records: Arc<RecordStore>,
    /// WSL 준비 상태 진단기 — **모든 셸 스폰의 마지막 게이트**다. 진단이 끝나기
    /// 전(`Probing`)이나 준비되지 않은 상태에서는 스폰을 거부한다.
    wsl: Arc<WslHealth>,
    /// 부팅 때 읽은 탭 셸 실행 방식. 모든 셸 spawn(부팅·새 탭·Restart)이 같은 값을 쓰도록
    /// 여기서 한 번만 보관하며, 바꾸려면 앱을 다시 시작해야 한다.
    launch: TabLaunch,
}

/// 탭 셸을 띄우는 방식. 둘 다 부팅 때 `settings.json` 에서 한 번 읽는다.
#[derive(Debug, Clone, Copy, Default)]
pub struct TabLaunch {
    /// `autoResume` — WSL 래퍼의 자동 재실행 opt-in ([`spawn_spec`]).
    pub auto_resume: bool,
    /// Windows PowerShell 모드 ([`crate::commands::UiSettings::powershell_mode`]). 참이면
    /// 탭 셸은 WSL 래퍼 대신 PowerShell 로 뜬다 ([`TauriHost::tab_spawn_spec`]).
    pub powershell: bool,
}

/// 부팅 때 정한 PowerShell 모드의 프로세스 전역 사본. `main.rs` 가 `TabLaunch` 와 같은 값으로 한 번 세운다.
/// 상태를 들고 있지 않은 자유 함수(뷰어 경로 해석, Git 조회, 예열·프로비저닝·파일 정리)가 이 값을 본다.
static POWERSHELL_MODE: OnceLock<bool> = OnceLock::new();

pub(crate) fn set_powershell_mode(on: bool) {
    POWERSHELL_MODE
        .set(on)
        .expect("the shell mode is set once at boot");
}

pub(crate) fn powershell_mode() -> bool {
    POWERSHELL_MODE.get().copied().unwrap_or(false)
}

/// WSL 을 쓰는 기능을 PowerShell 모드에서 거부한다. 거부 문구는 영어다 (CLAUDE.md 사용자 문자열 규칙).
pub(crate) fn require_wsl(feature: &str) -> Result<(), String> {
    check_wsl(powershell_mode(), feature)
}

fn check_wsl(powershell: bool, feature: &str) -> Result<(), String> {
    if powershell {
        Err(format!("PowerShell mode does not support {feature}"))
    } else {
        Ok(())
    }
}

impl TauriHost {
    pub fn new(
        app: AppHandle,
        sessions: Arc<SessionManager>,
        sinks: Arc<SinkRegistry>,
        router: Arc<OscRouter>,
        records: Arc<RecordStore>,
        wsl: Arc<WslHealth>,
        launch: TabLaunch,
    ) -> Self {
        Self {
            app,
            sessions,
            sinks,
            router,
            records,
            wsl,
            launch,
        }
    }
}

/// env `MAST_DISTRO` — `resolve_distro` 의 중간 단계 (빈 문자열은 미설정).
/// 코어의 재스폰 계획처럼 env 를 직접 못 읽는 곳에 이 값을 넘겨, 스폰 해석과
/// 같은 순서를 지키게 한다.
pub(crate) fn env_distro() -> Option<String> {
    std::env::var("MAST_DISTRO").ok().filter(|d| !d.is_empty())
}

/// distro 선택 우선순위: 요청값 → env `MAST_DISTRO` → `None`(WSL 기본 배포판).
/// 빈 문자열은 미설정으로 취급한다.
///
/// 스폰([`spawn_spec`])과 부팅 예열([`crate::boot`])이 **같은 값을 골라야** 한다 —
/// 예열이 다른 distro 를 세우면 정작 스폰이 콜드 VM 을 만난다. WSL 스폰 게이트도
/// 같은 해석을 써야 한다 — 요청값이 없는데 `MAST_DISTRO` 가 목록에 없으면 기본
/// 배포판으로 통과시키고 스폰이 실패하는 어긋남을 만들지 않기 위해서다.
#[cfg(not(target_os = "macos"))]
pub(crate) fn resolve_distro(requested: Option<String>) -> Option<String> {
    requested.filter(|d| !d.is_empty()).or_else(env_distro)
}

#[cfg(target_os = "macos")]
pub(crate) fn resolve_distro(_requested: Option<String>) -> Option<String> { None }

/// `ShellSpawnReq` → 플랫폼별 `SpawnSpec` 매핑.
///
/// **주의: `req.cwd` 는 Linux(WSL) 경로다.** Windows 에서 `SpawnSpec.cwd`(Windows
/// 프로세스의 cwd)에 넣으면 안 되고 `wsl.exe --cd` 인자로 넘겨 WSL 안에서
/// 해석되게 한다. unix(개발 실행)에서는 프로세스 cwd 그대로가 맞다.
fn spawn_spec(req: &ShellSpawnReq, auto_resume: bool) -> SpawnSpec {
    #[cfg(windows)]
    {
        let mut args: Vec<String> = Vec::new();
        // **`--cd` 는 언제나 `~`** 이고 목적지 cwd 는 래퍼가 `cd` 한다. `--cd <경로>` 로
        // 넘기면 그 경로가 사라졌을 때 relay 가 `chdir(...) failed` 만 남기고 **명령을
        // 아예 실행하지 않는다** (실기 확인: 그때 wsl.exe 종료코드는 0이라 스폰은
        // 성공으로 보이고 탭은 시작 표식 없이 NotStarted 로 남는다). 탭 cwd 가 살아 있는
        // 셸을 따라가기 시작하면(ADR-0011) 지워진 디렉터리는 흔한 일이 되므로, 되돌릴 수
        // 있는 자리인 래퍼로 cd 를 옮긴다.
        args.push("--cd".to_string());
        args.push("~".to_string());
        if let Some(distro) = resolve_distro(req.distro.clone()) {
            args.push("-d".to_string());
            args.push(distro);
        }
        // `--` 가 아니라 `--exec` 인 이유: `--` 는 명령을 WSL
        // **기본 셸을 한 번 거쳐** 실행해 래퍼 스크립트가 셸 평가를 두 번 받는다.
        // $HOME/$PATH 같은 환경 변수는 바깥 평가에서도 같은 값이라 티가 안 났지만,
        // 스크립트 안에서 정의하는 변수($RESUME/$cmd)는 바깥 평가가 빈 값으로
        // 선확장해 resume 블록이 통째로 스킵됐다. --exec 는 argv 를 셸 경유 없이
        // 그대로 실행한다 (평가 1회) — 기본 셸이 zsh/fish 인 배포판에서 스크립트가
        // 다른 문법으로 파싱되는 잠재 버그 계열도 함께 제거된다.
        args.push("--exec".to_string());
        args.extend(bash_argv(req.history_tab, req.cwd.as_deref(), auto_resume));
        SpawnSpec {
            program: "wsl.exe".to_string(),
            args,
            cwd: None,
            cols: req.cols,
            rows: req.rows,
        }
    }
    #[cfg(target_os = "macos")]
    { crate::platform::macos::spawn_spec(req, auto_resume) }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        // 직접 실행하는 `$SHELL -l` 에는 자동 실행 인자를 넘길 자리가 없다.
        let _ = auto_resume;
        // unix(개발): $SHELL -l ($SHELL 없으면 bash -l), cwd 는 직접 사용.
        // 탭별 HISTFILE 은 여기서 적용하지 않는다 — $SHELL 이 bash 라는 보장이
        // 없어(zsh·fish 는 HISTFILE 시맨틱이 다르다) 셸 기본 history 를 그대로
        // 쓴다. 탭별 history 는 WSL(bash·zsh) 경로와 macOS 경로의 기능이다.
        let program = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "bash".to_string());
        SpawnSpec {
            program,
            args: vec!["-l".to_string()],
            cwd: req.cwd.clone(),
            cols: req.cols,
            rows: req.rows,
        }
    }
}

/// `wsl.exe ... --exec` 뒤에 붙는 WSL 안 셸 argv (셸 경유 없는 직접 실행 — spawn_spec 주석).
///
/// 본문은 `scripts/wsl/launch.sh` 를 `include_str!` 로 넣은 것이고, 셸이 하는 일과 각 줄의
/// 이유는 그 파일의 주석이 정본이다. 여기에는 전달 계약만 둔다: `bash -c <본문> mast-wsl
/// <탭 id> <cwd>` 순서이며 `$0` 은 고정 이름, `$1`·`$2` 가 위치 인자다. `None` 은 빈
/// 문자열이다. 본문이 bash 문법이므로 전송 셸도 bash 를 명시한다.
///
/// `$3` 은 자동 실행 opt-in 이다 — 켜졌을 때만 `1` 이고 나머지는 빈 값이다. 셸은 정확한
/// `1` 만 켜짐으로 읽으며, 이 값은 데이터 인자로만 넘어간다.
///
/// 본문의 OSC 10/11 값은 3자 색 동기화 계약의 한 자리다. 같은 값이 `sink.rs` 의
/// `COLOR_REPLY_*` 와 `TERMINAL_THEME` 에도 있으므로 셋을 함께 바꾼다.
#[cfg(windows)]
fn bash_argv(history_tab: Option<u64>, cwd: Option<&str>, auto_resume: bool) -> Vec<String> {
    vec![
        "bash".to_string(),
        "-c".to_string(),
        include_str!("../../../../scripts/wsl/launch.sh").to_string(),
        "mast-wsl".to_string(),
        history_tab.map(|tab| tab.to_string()).unwrap_or_default(),
        cwd.unwrap_or_default().to_string(),
        if auto_resume { "1" } else { "" }.to_string(),
    ]
}

/// PowerShell 탭 래퍼 본문. 정본은 `scripts/win/powershell-integration.ps1` 이고, 앞에 붙는 세 값
/// (탭 id·bin 폴더·작업 폴더)은 [`powershell_spawn_spec`] 가 리터럴로 함께 인코딩한다.
#[cfg(windows)]
const POWERSHELL_INTEGRATION: &str = include_str!("../../../../scripts/win/powershell-integration.ps1");

/// Windows 명령줄 한도(NUL 포함 32,767 wide 문자)를 넘지 않는 상한. 넘으면 스폰이 조용히 실패하지 않도록 미리 거부한다.
#[cfg(windows)]
const WINDOWS_COMMAND_LINE_LIMIT: usize = 32_767;

/// PowerShell 탭의 실행 사양 (ADR-0037 결정 3). 실행 파일은 Windows PowerShell 5.1 이고 작업 디렉터리는
/// 항상 사용자 프로필이다. 복원할 작업 폴더는 드라이브 경로일 때만 스크립트에 넘긴다 — 그 밖의
/// 값(WSL 경로 등)은 버리고 홈에서 시작한다. 폴더 존재 확인은 스크립트가 하므로 앱은 디스크에 접근하지 않는다.
#[cfg(windows)]
fn powershell_spawn_spec(
    req: &ShellSpawnReq,
    bin_dir: &str,
    user_profile: &str,
) -> anyhow::Result<SpawnSpec> {
    let tab = req.history_tab.map(|tab| tab.to_string()).unwrap_or_default();
    let cwd = req.cwd.as_deref().filter(|cwd| is_drive_path(cwd)).unwrap_or_default();
    let script = format!(
        "$MastTab = {}\n$MastBin = {}\n$MastCwd = {}\n{POWERSHELL_INTEGRATION}",
        ps_literal(&tab),
        ps_literal(bin_dir),
        ps_literal(cwd),
    );
    let args = vec![
        "-NoLogo".to_string(),
        "-NoExit".to_string(),
        "-EncodedCommand".to_string(),
        encode_powershell_command(&script),
    ];
    let line_len = "powershell.exe".len() + args.iter().map(|arg| arg.len() + 1).sum::<usize>();
    if line_len >= WINDOWS_COMMAND_LINE_LIMIT {
        return Err(anyhow!(
            "PowerShell tab command line is {line_len} characters (limit {WINDOWS_COMMAND_LINE_LIMIT}); the working folder path is too long"
        ));
    }
    Ok(SpawnSpec {
        program: "powershell.exe".to_string(),
        args,
        cwd: Some(user_profile.to_string()),
        cols: req.cols,
        rows: req.rows,
    })
}

/// 드라이브 경로(`^[A-Za-z]:\\`). 작업 폴더로 넘길 수 있는 유일한 형태다. 폴더 선택([`crate::commands`])도 같은 판정을 쓴다.
#[cfg(windows)]
pub(crate) fn is_drive_path(path: &str) -> bool {
    matches!(path.as_bytes(), [letter, b':', b'\\', ..] if letter.is_ascii_alphabetic())
}

/// PowerShell 작은따옴표 리터럴. PowerShell 은 U+2018·U+2019·U+201A·U+201B 도 작은따옴표로 읽으므로
/// 그 글자들도 두 번 적어야 한 글자가 된다. 작은따옴표 안의 나머지 글자는 확장되지 않는다.
#[cfg(windows)]
fn ps_literal(value: &str) -> String {
    let mut literal = String::with_capacity(value.len() + 2);
    literal.push('\'');
    for ch in value.chars() {
        if matches!(ch, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            literal.push(ch);
        }
        literal.push(ch);
    }
    literal.push('\'');
    literal
}

/// `-EncodedCommand` 인자: 스크립트를 UTF-16LE 로 바꾼 뒤 base64 로 감싼다. 결과에 따옴표·공백이 없어
/// 명령줄 이스케이프가 필요 없다.
#[cfg(windows)]
fn encode_powershell_command(script: &str) -> String {
    use base64::Engine as _;
    let utf16le: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16le)
}

/// `<mast.exe 폴더>\bin` — 셸 PATH 앞에 붙는 디렉터리. exe 위치를 따르므로 `MAST_APP_DIR` 로 다른 곳에
/// 설치돼도 맞는다.
#[cfg(windows)]
fn mast_bin_dir() -> anyhow::Result<String> {
    let exe = std::env::current_exe().map_err(|err| anyhow!("cannot locate mast.exe: {err}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| anyhow!("mast.exe has no parent folder: {}", exe.display()))?;
    let bin = dir.join("bin");
    bin.to_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("the mast bin folder is not valid Unicode: {}", bin.display()))
}

/// 사용자 프로필 — PowerShell 탭의 시작 디렉터리다.
#[cfg(windows)]
fn user_profile() -> anyhow::Result<String> {
    std::env::var("USERPROFILE").map_err(|err| anyhow!("cannot read USERPROFILE: {err}"))
}

/// 시작 표식을 기다리는 기본 마감. 웜 스타트 실측이 163~194ms 라 크게 여유롭지만,
/// 값을 고르는 부담 자체가 작다 — 마감을 넘겨도 세션을 죽이지 않고 탭에 표시만 하므로
/// 틀렸을 때의 대가가 경고 한 번뿐이다. 죽이는 설계였다면 WSL 콜드 스타트가 수 초에서
/// 수 분까지 걸린 보고들 때문에 어떤 값도 정당화할 수 없었다.
const STARTUP_DEADLINE: Duration = Duration::from_secs(20);

/// 표식을 낼 래퍼가 있는 경로에서만 기본 활성이다. unix 개발 실행은 `$SHELL -l` 을
/// 직접 띄워(`spawn_spec`) 표식을 낼 자리가 없으므로, 마감을 걸면 느린 rc 가 곧바로
/// 오탐이 된다.
#[cfg(any(windows, target_os = "macos"))]
fn platform_startup_deadline() -> Option<Duration> {
    Some(STARTUP_DEADLINE)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_startup_deadline() -> Option<Duration> {
    None
}

/// 스폰 자체의 마감 — 이 값이 곧 **탭 하나 때문에 앱 전체가 멈춰 있을 수 있는 최대
/// 시간**이다. `dispatch` 가 Dispatcher lock 을 쥔 채 스폰하므로(그 함수 주석) 상한이
/// 없으면 무한이 된다. 프로세스 생성은 웜에서 수십 ms 라 5초는 100배 여유다.
const SPAWN_DEADLINE: Duration = Duration::from_secs(5);

/// `0` 은 "끄기". 파싱 실패는 부팅을 막지 않고 loud 하게만 알린다 — 오타 하나로
/// 터미널을 못 쓰게 만드는 것이 잘못된 마감보다 나쁘다.
fn env_deadline(var: &str, fallback: Option<Duration>) -> Option<Duration> {
    let Ok(raw) = std::env::var(var) else {
        return fallback;
    };
    match raw.trim().parse::<u64>() {
        Ok(0) => None,
        Ok(ms) => Some(Duration::from_millis(ms)),
        Err(err) => {
            winlog!("{var}={raw:?} is not a number ({err}); using the default");
            fallback
        }
    }
}

/// `MAST_STARTUP_DEADLINE_MS` override. 실기 검증이 마감을 줄여 감지 경로를 재현하는
/// 데 쓰고, 오탐이 잦은 환경에는 탈출구가 된다.
fn startup_deadline() -> Option<Duration> {
    static CACHED: OnceLock<Option<Duration>> = OnceLock::new();
    *CACHED.get_or_init(|| {
        env_deadline("MAST_STARTUP_DEADLINE_MS", platform_startup_deadline())
    })
}

/// `MAST_SPAWN_DEADLINE_MS` override.
fn spawn_deadline() -> Option<Duration> {
    static CACHED: OnceLock<Option<Duration>> = OnceLock::new();
    *CACHED.get_or_init(|| env_deadline("MAST_SPAWN_DEADLINE_MS", Some(SPAWN_DEADLINE)))
}

/// 세션 생성 + sink 등록의 원자 단위. `spawn_shell` 이 직접 부르거나 마감을 씌워
/// 부르므로, 두 경로가 같은 롤백 규율을 쓰도록 함수로 뺐다.
fn create_session(
    sessions: &SessionManager,
    sinks: &SinkRegistry,
    app: &AppHandle,
    router: &Arc<OscRouter>,
    tab: Option<TabId>,
    spec: SpawnSpec,
    opts: SessionOptions,
) -> anyhow::Result<SessionId> {
    // sink factory 가 TerminalSink 를 만들어 레지스트리에 등록한다 (id 선발급 계약).
    // 등록 후 스폰이 실패하면 레지스트리 엔트리를 되감아 고아 sink 를 남기지 않는다 —
    // factory 밖으로 id 를 꺼내는 Cell.
    let registered: Cell<Option<SessionId>> = Cell::new(None);
    let result = sessions.create(spec, opts, |id| {
        let sink = Arc::new(TerminalSink::new(id, tab, app.clone(), Arc::clone(router)));
        sinks.insert(id, Arc::clone(&sink));
        registered.set(Some(id));
        Box::new(SinkHandle(sink))
    });
    if result.is_err() {
        if let Some(id) = registered.take() {
            sinks.remove(id);
        }
    }
    result
}

impl SessionHost for TauriHost {
    fn browser_enabled(&self) -> bool { crate::browser::enabled(&self.app) }
    fn powershell_mode(&self) -> bool { self.launch.powershell }
    fn spawn_shell(&self, req: ShellSpawnReq) -> anyhow::Result<SessionId> {
        // 스폰은 Dispatcher lock 아래의 유일한 블로킹 구간이라(모듈 doc), 여기서
        // 얼마나 걸렸는지가 "앱 전체가 멈춘 것처럼 보였다"류 신고의 첫 단서다.
        let started = std::time::Instant::now();
        wintrace!("spawn: starting (tab={:?})", req.history_tab);
        let result = self.spawn_shell_inner(req);
        match &result {
            Ok(session) => wintrace!(
                "spawn: session {session} up in {} ms",
                started.elapsed().as_millis()
            ),
            Err(err) => wintrace!(
                "spawn: failed after {} ms: {err:#}",
                started.elapsed().as_millis()
            ),
        }
        result
    }

    fn kill(&self, id: SessionId) {
        // 멱등 계약 (SessionHost rustdoc): 미지·이미 종료된 id 도 무해 —
        // 양쪽 레지스트리 remove 모두 no-op 으로 끝난다. `SessionManager::remove`
        // 는 레지스트리 lock 을 놓은 뒤 kill 신호를 보낸다 (코어 계약).
        self.sinks.remove(id);
        let _ = self.sessions.remove(id);
    }

    fn release_tabs(&self, tabs: &[TabId], distro: Option<&str>) {
        wintrace!("release: {} closed tab(s)", tabs.len());
        release_records(Arc::clone(&self.records), tabs);
        release_tab_files(tabs, distro);
    }
}

impl TauriHost {
    /// 탭 셸의 실행 사양. PowerShell 모드는 WSL 래퍼 대신 PowerShell 을 띄운다. 이 분기가
    /// 모드에 따른 유일한 갈림이며, WSL 쪽 [`spawn_spec`] 과 그 테스트는 그대로 둔다.
    fn tab_spawn_spec(&self, req: &ShellSpawnReq) -> anyhow::Result<SpawnSpec> {
        #[cfg(windows)]
        {
            if self.launch.powershell {
                return powershell_spawn_spec(req, &mast_bin_dir()?, &user_profile()?);
            }
        }
        Ok(spawn_spec(req, self.launch.auto_resume))
    }

    fn spawn_shell_inner(&self, req: ShellSpawnReq) -> anyhow::Result<SessionId> {
        // **모든 셸 스폰의 단일 게이트** — 진단이 끝나기 전에는 어떤 경로도
        // `wsl.exe` 를 띄우지 못한다. 부팅 경로는 `boot::BootWork` 가 진단을 기다린
        // 뒤에 부르므로 여기서 걸리지 않고, UI 발 명령은 진단이 준비되지 않았으면
        // 이 사유가 그대로 `CommandError::SpawnFailed` 로 표면화된다.
        #[cfg(windows)]
        {
            let status = self.wsl.status();
            let requested = resolve_distro(req.distro.clone());
            if let Some(reason) = mast_core::wsl::spawn_block_reason(&status, requested.as_deref())
            {
                wintrace!("spawn: refused before the WSL diagnosis is ready: {reason}");
                return Err(anyhow!("{reason}"));
            }
        }
        // sink 가 들고 갈 탭 id — exit 이 기록 파일 이름을 여기서만 얻는다
        // (`history_tab` 은 이 세션이 실릴 탭의 안정 ID 다, 코어 rustdoc).
        let tab = req.history_tab.map(TabId);
        let spec = self.tab_spawn_spec(&req)?;
        let opts = SessionOptions {
            startup_deadline: startup_deadline(),
            ..SessionOptions::default()
        };
        let Some(deadline) = spawn_deadline() else {
            return create_session(
                &self.sessions,
                &self.sinks,
                &self.app,
                &self.router,
                tab,
                spec,
                opts,
            );
        };

        let sessions = Arc::clone(&self.sessions);
        let sinks = Arc::clone(&self.sinks);
        let app = self.app.clone();
        let router = Arc::clone(&self.router);
        let late_sessions = Arc::clone(&self.sessions);
        let late_sinks = Arc::clone(&self.sinks);
        call_with_deadline(
            "mast-pty-spawn",
            deadline,
            move || create_session(&sessions, &sinks, &app, &router, tab, spec, opts),
            move |late| {
                // 마감 뒤에 끝난 스폰은 모델 어디에도 실리지 않는다 — 스폰은 이미
                // Err 로 돌아갔다 — 그대로 두면 실기 사고에서 몇 시간을 살아남은 그
                // 좀비가 된다. sink 는 이 경로에서도 탭 id 를 들고 있으므로, 기록을
                // 남기지 않는 근거는 **여기서 먼저 레지스트리를 비운다**는 순서다:
                // 뒤늦게 도는 `on_exit` 은 세션을 못 찾아 아무것도 쓰지 않는다.
                if let Ok(id) = late {
                    late_sinks.remove(id);
                    late_sessions.remove(id);
                }
            },
        )
        .unwrap_or_else(|| {
            Err(anyhow!(
                "shell spawn did not finish within {deadline:?}; it will be cleaned up if it \
                 ever completes"
            ))
        })
    }
}

/// 닫힌 탭들의 **기록 파일** 삭제 (ADR-0018 수명 규칙) — 셸측 자원
/// ([`release_tab_files`])과 달리 로컬 디스크라 `wsl.exe` 왕복과 무관하지만, 호출이
/// Dispatcher lock 아래라(이 파일 모듈 doc) 여기서 동기로 지우지 않고 스레드로 넘긴다.
/// unix 개발 실행에도 기록은 쌓이므로 cfg 로 가르지 않는다.
///
/// 실패는 로그로만 쓴다 — 남은 파일은 다음 부팅의 sweep([`mast_core::record::RecordStore::sweep`])
/// 이 keep 집합 밖으로 보고 걷어 간다. **같은 sweep 이 덮는 창이 하나 더 있다**: 탭을
/// 닫는 순간 그 탭의 세션이 막 끝나 있으면, waiter 스레드가 `take_record` 와 파일 쓰기
/// 사이에 있을 수 있어 여기서 지운 파일이 그 뒤에 다시 쓰인다. 닫힌 탭은 keep 집합에
/// 없으므로 다음 부팅의 sweep 이 걷어 간다 (ADR-0018 accepted limits).
fn release_records(records: Arc<RecordStore>, tabs: &[TabId]) {
    let tabs: Vec<TabId> = tabs.to_vec();
    let spawned = std::thread::Builder::new()
        .name("mast-release-records".to_string())
        .spawn(move || {
            for tab in tabs {
                if let Err(err) = records.remove(tab) {
                    winlog!("could not remove the record of closed tab {}: {err}", tab.0);
                }
            }
        });
    if let Err(err) = spawned {
        winlog!("could not start the record release thread: {err}");
    }
}

/// 닫힌 탭들의 셸측 자원 삭제 — 탭별 `HISTFILE` 과 resume 힌트, 그리고 훅이
/// 쓰다 만 힌트 임시 파일(`tab-<id>.tmp.<pid>`)까지.
///
/// **Windows 에서 경로를 조립하지 않고 WSL 안에서 `$HOME` 을 펼친다.** 이 디렉터리를
/// 만드는 쪽(`scripts/wsl/launch.sh` 의 `mkdir -p`)이 같은 이유로 같은 규율을 따른다 — 리눅스
/// 홈 위치는 배포판·사용자마다 다르고, UNC 로 추측하면 틀렸을 때 조용히 아무것도
/// 지우지 않는다.
///
/// **탭 목록 전체가 한 번의 wsl.exe 왕복이다.** 워크스페이스 하나를 닫으면 탭이
/// 열몇 개씩 사라지는데, 그때 wsl.exe 를 그만큼 동시에 띄우는 것이 부팅 재스폰
/// 사고의 모양이었다 (ADR-0010 개정).
///
/// **호출은 Dispatcher lock 아래다** (이 파일 모듈 doc) — 그래서 왕복을 분리 스레드로
/// 넘기고 즉시 돌아온다. 결과는 로그로만 쓴다 — 실패해도 사용자가 할 수 있는 일이
/// 없다. 앱이 이 직후 종료하면 삭제가 통째로 유실되는 창도 남는데, 둘 다 부팅 시
/// sweep 이 덮을 자리다 (백로그, ADR-0013 "Consequences").
#[cfg(windows)]
fn release_tab_files(tabs: &[TabId], distro: Option<&str>) {
    use std::os::windows::process::CommandExt;

    // PowerShell 탭은 WSL 쪽 셸 파일을 만들지 않으므로 지울 것이 없다 — wsl.exe 를 띄우지 않는다 (ADR-0037 결정 6).
    if powershell_mode() {
        return;
    }
    // 콘솔 창 억제 — boot.rs·commands.rs 의 wsl.exe 호출과 같은 플래그다.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let script = release_script(tabs);
    let distro = resolve_distro(distro.map(str::to_string));
    let count = tabs.len();
    let spawned = std::thread::Builder::new()
        .name("mast-release-tabs".to_string())
        .spawn(move || {
            let mut cmd = std::process::Command::new("wsl.exe");
            if let Some(distro) = &distro {
                cmd.arg("-d").arg(distro);
            }
            // `--exec` 인 이유는 spawn_spec 과 같다 — 명령이 배포판 기본 셸을 한 번
            // 더 거치면 스크립트가 다른 문법으로 평가된다.
            let status = cmd
                .arg("--exec")
                .arg("bash")
                .arg("-c")
                .arg(&script)
                .creation_flags(CREATE_NO_WINDOW)
                .status();
            match status {
                Ok(status) if status.success() => {}
                Ok(status) => {
                    winlog!("releasing {count} closed tab(s) exited with {status}")
                }
                Err(err) => winlog!("could not release {count} closed tab(s): {err}"),
            }
        });
    if let Err(err) = spawned {
        winlog!("could not start the release thread for {count} closed tab(s): {err}");
    }
}

/// 삭제 스크립트 본문. 탭 하나가 남기는 파일은 탭별 `HISTFILE`(`tab-<id>`, `zsh-tab-<id>`), 셸 프롬프트 세대(`prompt/tab-<id>`), resume 힌트, 에이전트 훅
/// 디스패처의 상태·lock·진단 파일(`~/.mast/agent-hooks/`), 그리고 쓰다 죽은 프로세스가 남긴
/// 임시 파일(`<파일>.tmp.<pid>`)이다.
///
/// 탭 id 는 10진수 `u64` 라 셸 메타문자가 될 수 없다 — 그대로 박아도 안전하다.
/// `.tmp.*` 만 따옴표 밖에 두어 glob 이 살아 있고, 매치가 없으면 그 리터럴이 그대로
/// 남는데 `rm -f` 는 없는 파일에 침묵한다 (그래서 없는 파일도 조용히 지나간다).
#[cfg(windows)]
fn release_script(tabs: &[TabId]) -> String {
    let mut script = String::from("rm -f --");
    for tab in tabs {
        let id = tab.0;
        script.push_str(&format!(
            r#" "$HOME/.mast/history/tab-{id}" "$HOME/.mast/history/zsh-tab-{id}" "$HOME/.mast/prompt/tab-{id}" "$HOME/.mast/resume/tab-{id}" "$HOME/.mast/resume/tab-{id}".tmp.*"#
        ));
        script.push_str(&format!(
            r#" "$HOME/.mast/agent-hooks/tab-{id}.json" "$HOME/.mast/agent-hooks/tab-{id}.lock" "$HOME/.mast/agent-hooks/tab-{id}.diag" "$HOME/.mast/agent-hooks/tab-{id}.json".tmp.* "$HOME/.mast/agent-hooks/tab-{id}.diag".tmp.*"#
        ));
    }
    script
}

/// unix 개발 실행에는 지울 것이 없다 — `spawn_spec` 이 탭별 `HISTFILE` 을 물리지
/// 않으므로(그 함수 주석) 탭 전용 파일 자체가 만들어지지 않는다.
#[cfg(not(any(windows, target_os = "macos")))]
fn release_tab_files(_tabs: &[TabId], _distro: Option<&str>) {}

#[cfg(target_os = "macos")]
fn release_tab_files(tabs: &[TabId], _distro: Option<&str>) {
    crate::platform::macos::release_tab_files(tabs);
}

/// 스폰 명령 구성 테스트 — Windows 대상에서만 성립하는 argv 계약이라 그 타깃에서만
/// 컴파일·실행된다 (unix 개발 경로는 `$SHELL -l` 무변경).
///
/// 단언이 통짜 문자열 비교가 아니라 조각별 계약인 이유: 종전의 통짜 비교는 **CI 가 이
/// 크레이트의 테스트를 돌리지 않아** 시작 표식(d21d9a8)이 들어온 뒤로 조용히 낡아 있었다.
/// 못 도는 정밀한 단언보다 무엇이 왜 필요한지 말하는 단언이 낫고, 실제로 돌리는 일은
/// `ci.yml` 의 Windows 테스트 스텝이 맡는다.
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// 탭 id 와 cwd 가 있으면 본문은 `-c` 다음 한 칸이고, 위치 인자는 `mast-wsl`, 탭 id, cwd 순서다.
    #[test]
    fn spawn_passes_the_launch_script_and_tab_and_cwd_as_positional_args() {
        let req = ShellSpawnReq {
            cwd: Some("/home/me/proj".to_string()),
            distro: Some("Ubuntu".to_string()),
            history_tab: Some(7),
            ..ShellSpawnReq::default()
        };
        let spec = spawn_spec(&req, false);
        assert_eq!(spec.program, "wsl.exe");
        // distro 는 `-d`, cwd 는 **`--cd ~`** 로 가고 목적지는 본문이 옮긴다 (spawn_spec 주석).
        assert_eq!(
            &spec.args[..6],
            &[
                "--cd".to_string(),
                "~".to_string(),
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--exec".to_string(),
                "bash".to_string(),
            ]
        );
        assert_eq!(spec.args[6], "-c");
        assert_eq!(spec.args[7], include_str!("../../../../scripts/wsl/launch.sh"));
        assert_eq!(
            &spec.args[8..],
            &[
                "mast-wsl".to_string(),
                "7".to_string(),
                "/home/me/proj".to_string(),
                String::new(),
            ]
        );
    }

    /// `$3` 은 자동 실행 opt-in 이다 — 켜졌을 때만 `1` 이고 꺼짐은 빈 값이다. 위치 인자 `$1`·`$2`
    /// 의 자리는 바뀌지 않는다.
    #[test]
    fn auto_resume_is_the_third_positional_arg_and_only_enabled_passes_one() {
        let req = ShellSpawnReq {
            cwd: Some("/home/me/proj".to_string()),
            history_tab: Some(7),
            ..ShellSpawnReq::default()
        };
        for (enabled, flag) in [(true, "1"), (false, "")] {
            let spec = spawn_spec(&req, enabled);
            assert_eq!(
                &spec.args[spec.args.len() - 4..],
                &[
                    "mast-wsl".to_string(),
                    "7".to_string(),
                    "/home/me/proj".to_string(),
                    flag.to_string(),
                ],
                "autoResume={enabled}"
            );
        }
    }

    /// `None` 은 빈 위치 인자 두 칸이다 — 본문이 빈 값을 보고 탭 전용 경로와 cd 를 건너뛴다.
    #[test]
    fn missing_tab_and_cwd_are_empty_positional_args() {
        let spec = spawn_spec(&ShellSpawnReq::default(), false);
        assert_eq!(
            &spec.args[spec.args.len() - 4..],
            &[
                "mast-wsl".to_string(),
                String::new(),
                String::new(),
                String::new(),
            ]
        );
    }

    /// 탭 cwd 는 셸이 OSC 7 로 보고한 값이라 무엇이든 들어올 수 있다. 본문에 끼워 넣지 않고
    /// 인자 한 칸 그대로 넘겨야 명령 주입이 생기지 않는다 (인자 경계의 실행 검증은 TS 테스트가 본다).
    #[test]
    fn tab_cwd_is_passed_raw_and_never_spliced_into_the_script() {
        let cwd = "/home/me/it's here; $(rm -rf /)";
        let req = ShellSpawnReq {
            cwd: Some(cwd.to_string()),
            history_tab: Some(3),
            ..ShellSpawnReq::default()
        };
        let spec = spawn_spec(&req, false);
        assert_eq!(spec.args[spec.args.len() - 2], cwd);
        assert!(!spec.args[spec.args.len() - 5].contains(cwd));
    }

    /// 닫힌 탭 정리 스크립트 — 탭마다 history·resume·에이전트 훅 파일과 그 임시 파일을 지우고,
    /// 여러 탭이 한 번의 `rm` 으로 들어간다 (SessionHost::release_tabs 의 배치 계약).
    /// 닫힌 탭 정리 스크립트는 통짜로 비교한다 — 짧고 거의 변하지 않는 데다, 여기서
    /// 틀리면 남의 파일을 지우거나 아무것도 못 지운다. `$HOME` 이 따옴표 안에서
    /// **셸이 펼칠** 형태로 남아 있는지, glob 이 임시 파일 자리에만 있는지(탭 id 를
    /// 접두사로 쓸어 담으면 탭 1 을 지울 때 탭 12·13 이 함께 사라진다), 탭 둘이 `rm`
    /// 하나로 묶이는지가 한 번에 걸린다.
    #[test]
    fn release_script_removes_every_per_tab_file_in_one_rm() {
        assert_eq!(
            release_script(&[TabId(7), TabId(12)]),
            concat!(
                r#"rm -f --"#,
                r#" "$HOME/.mast/history/tab-7" "$HOME/.mast/history/zsh-tab-7" "$HOME/.mast/prompt/tab-7" "$HOME/.mast/resume/tab-7" "$HOME/.mast/resume/tab-7".tmp.*"#,
                r#" "$HOME/.mast/agent-hooks/tab-7.json" "$HOME/.mast/agent-hooks/tab-7.lock" "$HOME/.mast/agent-hooks/tab-7.diag""#,
                r#" "$HOME/.mast/agent-hooks/tab-7.json".tmp.* "$HOME/.mast/agent-hooks/tab-7.diag".tmp.*"#,
                r#" "$HOME/.mast/history/tab-12" "$HOME/.mast/history/zsh-tab-12" "$HOME/.mast/prompt/tab-12" "$HOME/.mast/resume/tab-12" "$HOME/.mast/resume/tab-12".tmp.*"#,
                r#" "$HOME/.mast/agent-hooks/tab-12.json" "$HOME/.mast/agent-hooks/tab-12.lock" "$HOME/.mast/agent-hooks/tab-12.diag""#,
                r#" "$HOME/.mast/agent-hooks/tab-12.json".tmp.* "$HOME/.mast/agent-hooks/tab-12.diag".tmp.*"#,
            )
        );
    }

    /// PowerShell 탭 명령을 테스트가 다시 풀어 본다: base64 → UTF-16LE → 스크립트 본문.
    fn decode_powershell_command(args: &[String]) -> String {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&args[3])
            .expect("EncodedCommand is base64");
        let (pairs, rest) = bytes.as_chunks::<2>();
        assert!(rest.is_empty(), "EncodedCommand is UTF-16LE");
        let units: Vec<u16> = pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
        String::from_utf16(&units).expect("EncodedCommand is UTF-16LE")
    }

    fn command_line_len(spec: &SpawnSpec) -> usize {
        spec.program.len() + spec.args.iter().map(|arg| arg.len() + 1).sum::<usize>()
    }

    fn powershell_req(cwd: Option<&str>, tab: Option<u64>) -> ShellSpawnReq {
        ShellSpawnReq {
            cwd: cwd.map(str::to_string),
            history_tab: tab,
            ..ShellSpawnReq::default()
        }
    }

    /// 프로그램·인자 순서·작업 디렉터리 계약: 항상 `powershell.exe -NoLogo -NoExit -EncodedCommand`,
    /// 시작 디렉터리는 사용자 프로필이다 (복원 폴더는 스크립트가 옮긴다).
    #[test]
    fn powershell_tab_runs_the_encoded_script_from_the_user_profile() {
        let spec = powershell_spawn_spec(
            &powershell_req(Some(r"C:\proj"), Some(7)),
            r"C:\Apps\mast\bin",
            r"C:\Users\me",
        )
        .unwrap();
        assert_eq!(spec.program, "powershell.exe");
        assert_eq!(&spec.args[..3], ["-NoLogo", "-NoExit", "-EncodedCommand"]);
        assert_eq!(spec.cwd.as_deref(), Some(r"C:\Users\me"));
    }

    /// 탭 id·bin 폴더·드라이브 작업 폴더가 스크립트 앞의 리터럴로 들어가고, 뒤에 통합 스크립트 본문이 온다.
    #[test]
    fn powershell_tab_passes_tab_bin_and_drive_folder_into_the_decoded_script() {
        let spec = powershell_spawn_spec(
            &powershell_req(Some(r"C:\proj"), Some(7)),
            r"C:\Apps\mast\bin",
            r"C:\Users\me",
        )
        .unwrap();
        let script = decode_powershell_command(&spec.args);
        let expected_head = "$MastTab = '7'\n$MastBin = 'C:\\Apps\\mast\\bin'\n$MastCwd = 'C:\\proj'\n";
        assert!(script.starts_with(expected_head), "{script}");
        assert!(script.ends_with(include_str!("../../../../scripts/win/powershell-integration.ps1")));
    }

    /// 드라이브 경로가 아닌 작업 폴더(WSL 경로·모드 전환 잔여물)는 넘기지 않고, 탭 id 가 없으면 빈 값이다.
    #[test]
    fn powershell_tab_drops_non_drive_folders_and_missing_tab_ids() {
        for cwd in [Some("/home/me/proj"), Some(r"\\server\share"), Some("C:proj"), None] {
            let spec =
                powershell_spawn_spec(&powershell_req(cwd, None), r"C:\bin", r"C:\Users\me").unwrap();
            let script = decode_powershell_command(&spec.args);
            assert!(script.starts_with("$MastTab = ''\n$MastBin = 'C:\\bin'\n$MastCwd = ''\n"), "{cwd:?}");
        }
    }

    /// 경로의 작은따옴표 계열 글자는 리터럴에서 두 번 적혀 값이 그대로 전달된다 (명령 주입 방지).
    #[test]
    fn powershell_tab_quotes_apostrophes_in_paths_without_expanding_them() {
        let spec = powershell_spawn_spec(
            &powershell_req(Some("C:\\it\u{2019}s $(calc)"), Some(3)),
            r"C:\Users\O'Brien\bin",
            r"C:\Users\O'Brien",
        )
        .unwrap();
        let script = decode_powershell_command(&spec.args);
        assert!(
            script.starts_with(
                "$MastTab = '3'\n$MastBin = 'C:\\Users\\O''Brien\\bin'\n$MastCwd = 'C:\\it\u{2019}\u{2019}s $(calc)'\n"
            ),
            "{script}"
        );
    }

    /// 긴 드라이브 폴더도 한도 안이면 통과하고, 한도를 넘는 경로는 스폰 전에 명확한 오류로 거부한다.
    #[test]
    fn powershell_tab_command_line_stays_under_the_windows_limit() {
        let long_folder = format!("C:\\{}", "a".repeat(2_000));
        let spec = powershell_spawn_spec(
            &powershell_req(Some(&long_folder), Some(1)),
            r"C:\bin",
            r"C:\Users\me",
        )
        .unwrap();
        assert!(command_line_len(&spec) < WINDOWS_COMMAND_LINE_LIMIT);

        let too_long = format!("C:\\{}", "a".repeat(30_000));
        let err = powershell_spawn_spec(&powershell_req(Some(&too_long), Some(1)), r"C:\bin", r"C:\Users\me")
            .unwrap_err();
        assert!(err.to_string().contains("command line"), "{err}");
    }

    /// `is_drive_path` 는 `^[A-Za-z]:\\` 와 같다.
    #[test]
    fn drive_path_check_matches_the_documented_shape() {
        assert!(is_drive_path(r"C:\x"));
        assert!(is_drive_path(r"z:\"));
        for path in ["/C:/x", "C:x", "C:/x", "1:\\x", r"\\server\share", ""] {
            assert!(!is_drive_path(path), "{path:?}");
        }
    }

    /// WSL 기능은 PowerShell 모드에서만 거부되고, 거부 문구는 영어로 기능 이름을 그대로 말한다.
    #[test]
    fn wsl_features_are_refused_only_in_powershell_mode() {
        assert!(check_wsl(false, "WSL file paths").is_ok());
        assert_eq!(
            check_wsl(true, "WSL file paths").unwrap_err(),
            "PowerShell mode does not support WSL file paths"
        );
    }
}
