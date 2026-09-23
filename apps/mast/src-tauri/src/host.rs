//! `SessionHost` 구현 — Dispatcher 의 PTY 부수효과 포트를 `SessionManager` 위에
//! 실현한다. `dispatch` 가 Dispatcher lock 아래에서 호출하므로(스폰 포함 — 계획
//! 0-3 수용) 여기서 Dispatcher lock 을 다시 잡는 코드는 금지다.

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
    /// 새로 만드는 sink 에 물려 줄 OSC 라우터 핸들 (18단계 glue 계약).
    router: Arc<OscRouter>,
    /// 닫힌 탭의 기록 파일을 지우는 데 쓰는 저장소 핸들 — 관리 상태와 같은 `Arc` 다
    /// ([`SessionHost::release_tabs`], ADR-0018 수명 규칙).
    records: Arc<RecordStore>,
}

impl TauriHost {
    pub fn new(
        app: AppHandle,
        sessions: Arc<SessionManager>,
        sinks: Arc<SinkRegistry>,
        router: Arc<OscRouter>,
        records: Arc<RecordStore>,
    ) -> Self {
        Self {
            app,
            sessions,
            sinks,
            router,
            records,
        }
    }
}

/// distro 선택 우선순위: 요청값 → env `MAST_DISTRO` → `None`(WSL 기본 배포판).
/// 빈 문자열은 미설정으로 취급한다.
///
/// 스폰([`spawn_spec`])과 부팅 예열([`crate::boot`])이 **같은 값을 골라야** 한다 —
/// 예열이 다른 distro 를 세우면 정작 스폰이 콜드 VM 을 만난다.
pub(crate) fn resolve_distro(requested: Option<String>) -> Option<String> {
    requested
        .filter(|d| !d.is_empty())
        .or_else(|| std::env::var("MAST_DISTRO").ok().filter(|d| !d.is_empty()))
}

#[cfg(target_os = "macos")]
static MACOS_SHELL: OnceLock<Option<String>> = OnceLock::new();

#[cfg(target_os = "macos")]
pub(crate) fn configure_macos_shell(shell: Option<String>) {
    let shell = shell
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let _ = MACOS_SHELL.set(shell);
}

#[cfg(target_os = "macos")]
fn macos_shell() -> String {
    MACOS_SHELL
        .get()
        .and_then(|value| value.clone())
        .or_else(|| std::env::var("SHELL").ok().filter(|value| !value.trim().is_empty()))
        .unwrap_or_else(|| "/bin/zsh".to_owned())
}

/// `ShellSpawnReq` → 플랫폼별 `SpawnSpec` 매핑.
///
/// **주의: `req.cwd` 는 Linux(WSL) 경로다.** Windows 에서 `SpawnSpec.cwd`(Windows
/// 프로세스의 cwd)에 넣으면 안 되고 `wsl.exe --cd` 인자로 넘겨 WSL 안에서
/// 해석되게 한다. unix(개발 실행)에서는 프로세스 cwd 그대로가 맞다.
fn spawn_spec(req: &ShellSpawnReq) -> SpawnSpec {
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
        // `--` 가 아니라 `--exec` 인 이유 (실기 버그 2026-08-12): `--` 는 명령을 WSL
        // **기본 셸을 한 번 거쳐** 실행해 래퍼 스크립트가 셸 평가를 두 번 받는다.
        // $HOME/$PATH 같은 환경 변수는 바깥 평가에서도 같은 값이라 티가 안 났지만,
        // 스크립트 안에서 정의하는 변수($RESUME/$cmd)는 바깥 평가가 빈 값으로
        // 선확장해 resume 블록이 통째로 스킵됐다. --exec 는 argv 를 셸 경유 없이
        // 그대로 실행한다 (평가 1회) — 기본 셸이 zsh/fish 인 배포판에서 스크립트가
        // 다른 문법으로 파싱되는 잠재 버그 계열도 함께 제거된다.
        args.push("--exec".to_string());
        args.extend(bash_argv(req.history_tab, req.cwd.as_deref()));
        SpawnSpec {
            program: "wsl.exe".to_string(),
            args,
            cwd: None,
            cols: req.cols,
            rows: req.rows,
        }
    }
    #[cfg(target_os = "macos")]
    {
        SpawnSpec {
            program: "/bin/bash".to_owned(),
            args: macos_shell_argv(req.history_tab, req.cwd.as_deref()),
            cwd: None,
            cols: req.cols,
            rows: req.rows,
        }
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        // 지원 대상이 아닌 unix 개발 실행은 기존 경로를 그대로 둔다.
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

/// `wsl.exe ... --exec` 뒤에 붙는 **WSL 안 셸 argv** (셸 경유 없는 직접 실행 — spawn_spec 주석).
///
/// 모든 경로가 `MAST=1` 을 물고 로그인 셸을 exec 한다 — 탭 안에서 도는 에이전트·
/// 스크립트가 "여기가 mast 다"를 스스로 알아야 send 채널·알림 계약을 쓸지 판단할
/// 수 있기 때문이다 (`mast-send` 스킬의 자가 인지 조건). `history_tab` 이 Some
/// 이면 `MAST_TAB` 으로 자기 탭 id 까지 알려 주고, 그 탭 전용 HISTFILE 을 물린다
/// — 탭의 안정 ID 는 재시작을 넘어 유지되므로 재시작 후에도 같은 탭의 history 만
/// 복원된다 (체크포인트 2 UX 요청). 셸 안에서 `mkdir -p` 로 디렉터리를 만드는 이유
/// 는 Windows 쪽에서 WSL 파일시스템 경로를 추측하지 않기 위해서이고, `$HOME` 은
/// 공백이 섞여도 안전하도록 따옴표로 감싼다. `VAR=... exec bash -l` 의 할당은
/// exec 되는 프로세스의 환경으로 전달되며(= 그 셸의 자식들에게도 상속된다),
/// **Ubuntu 기본 `.bashrc`/`.profile` 은 HISTSIZE 류만 손대고 HISTFILE 은 덮지
/// 않으므로** 이 env 상속만으로 충분하다. mkdir 이 실패하면 `&&` 가 끊겨 셸이
/// 그대로 종료된다 — 탭이 exited 로 표시돼 실패가 드러난다 (조용한 fallback 없음).
///
/// **에이전트 세션 resume 힌트**: 재시작 후 respawn 되는 셸은 새 셸이라 그 탭에서 돌던
/// 에이전트 세션이 화면에서 사라진다. Claude Code hook 과 Codex notify 프로그램이 매
/// 호출마다 `~/.mast/resume/tab-<id>` 에 1행 = resume 명령, 2행 = 기록 시각(epoch)을
/// 남기므로 (`provision.rs` 의 `mast-notify.sh`·`mast-codex-notify.sh` — 계약은
/// `scripts/wsl/claude-hook-example.md`; 두 에이전트가 같은 파일을 쓰므로 그 탭에서
/// **마지막으로 턴을 끝낸 사용자 세션**이 이긴다. Codex 내부 임시 턴과 서브에이전트는
/// 쓰는 쪽에서 제외한다),
/// exec 직전에 그 1행을 읽어 ① 탭의 HISTFILE 끝에 덧붙이고(↑ 한 번에 나온다)
/// ② 흐린 안내 한 줄을 찍는다. **자동 실행은 하지 않는다** — 재개할지는 사용자가 정한다.
/// 파일이 없으면 아무 출력도 없다. 기록 시각으로 신선도를 판단하지 않는 것은 의도된
/// 단순화다 (오래된 힌트인지는 사용자가 안다). 이 블록은 `&&` 사슬 안에 있지만 파일
/// 부재·읽기 실패·append 실패 어느 쪽으로도 0 으로 끝난다(조건 거짓인 `if` 는 0,
/// `read` 실패는 `|| true` 가 흡수, append 실패는 뒤따르는 printf 가 가린다) — 힌트가
/// 셸 자체를 못 띄우게 만드는 일은 없어야 한다. 유일하게 새는 status 는 **안내 printf
/// 자체가 이 pane 의 tty 에 못 쓰는** 경우인데, 그건 애초에 쓸 수 있는 탭이 아니다.
/// `RESUME`·`cmd` 는 여기서 처음 대입되는 평범한 셸 변수라 exec 로 프로세스 이미지가
/// 갈릴 때 사라진다 (로그인 셸 환경 무오염). 엄밀히는 같은 이름이 **export 된 채로
/// 상속돼 들어오면** bash 가 export 속성을 유지하지만, spawn 환경은 mast 가 이
/// 함수에서 통째로 정하므로 그런 값은 오지 않는다.
///
/// 힌트 1행은 **읽는 쪽에서도 형태를 검증한다** (리뷰 finding): 기록 형식과 대칭인
/// `claude --resume <영숫자·-·_ 토큰>` 과 `codex resume <영숫자·-·_ 토큰>` 정확 일치만
/// 통과시키고, 그 외(escape 시퀀스·셸 메타문자·다른 명령)는 조용히 무시한다 — 같은
/// uid 가 파일을 바꿔치기해도 "↑+Enter 를 유도하는 임의 명령 표면"이 되지 않는다.
/// **화이트리스트라 새 에이전트를 붙이려면 여기에 형태를 추가해야 한다** (쓰는 쪽만
/// 고치면 힌트가 조용히 버려진다). 같은 uid 는 어차피
/// `~/.bashrc` 를 고칠 수 있으니 권한 경계가 아니라 오발 방지이며, 쓰는 쪽
/// (`mast-notify.sh`·`mast-codex-notify.sh`)의 id charset 가드와 짝이다. 또 힌트는 표시로
/// 소비되지 않으므로, 세션이 바뀌지 않은 채 재시작을 N 번 하면 같은 줄이
/// HISTFILE 에 N 개 쌓인다 (인접하므로 ↑ 한 번은 그대로).
///
/// `PATH` 프리펜드는 프로비저닝이 까는 `mast` CLI(`~/.mast/bin/mast`)를 탭 안에서
/// 경로 없이 부르기 위한 것이다 (`provision.rs` 2절). 로그인 셸이 이 값을 덮지 않는
/// 이유는 Debian/Ubuntu 계열의 `/etc/profile`·`~/.profile` 관례가 PATH 를 **재대입이
/// 아니라 `PATH="...:$PATH"` 로 프리펜드**하기 때문이다 — 우리 항목은 앞에서 밀릴 뿐
/// 사라지지 않는다. 디렉터리가 아직 없어도 무해하다 (PATH 의 없는 항목은 그냥 건너뛴다).
///
/// **ConPTY 색 테이블 동기화 (OSC 10/11 set)**: exec 전에 우리 테마의 fg/bg 를 tty 로
/// 한 번 내보낸다. WT 1.22+ 의 conhost 는 TUI 앱의 OSC 10/11 **질의**를 자기가 가로채
/// 자기 색 테이블(기본 ≈검정)로 대신 응답하므로(ms/terminal#17729), Codex 처럼 배경색을
/// 질의해 입력창 배경을 만드는 앱이 검정 기준으로 색을 골라 우리 배경(#1e1e1e)과 겹친다
/// — 실기 스크린샷의 "입력칸 구분 없음"의 실원인. set 은 conhost 가 handled 로 소비해
/// 자기 테이블을 갱신하므로 이후 질의가 올바른 값으로 답한다 (xterm 까지는 오지 않아
/// 프론트 무영향). **값의 정본은 `apps/mast/src/features/terminal/settings.ts` 의 `TERMINAL_THEME`
/// foreground/background 다 — 테마를 바꾸면 여기도 같이 바꾼다** (갈라지면 재발).
/// `COLORTERM=truecolor` 는 그 짝: Codex 의 색 선택이 truecolor 분기를 타게 한다.
///
/// **3자 동기화 계약**: 같은 값을 쓰는 세 번째 자리가 `sink.rs` 의
/// `COLOR_REPLY_FOREGROUND`/`COLOR_REPLY_BACKGROUND` 다 — OSC 10/11 **질의**에 앱이
/// 직접 답하는 응답기로, 위 "conhost 가 대신 응답한다"는 전제가 실기 probe 에서
/// 뒤집힌(아무도 응답하지 않았다) 뒤 2026-08-11 에 추가됐다. 셋 중 하나를 바꾸면
/// 나머지 둘도 같이 바꾼다.
#[cfg(windows)]
fn bash_argv(history_tab: Option<u64>, cwd: Option<&str>) -> Vec<String> {
    // 이 파일이 없으면 `mast` 를 못 찾을 뿐이고, 프로비저닝이 다음 부팅에서 다시
    // 시도한다 — 스폰 핫패스에서 존재를 확인하지 않는다 (wsl.exe 왕복 금지).
    const PATH_PREFIX: &str = "PATH=\"$HOME/.mast/bin:$PATH\"";
    // TERMINAL_THEME 동기화 계약 (rustdoc 참조): fg #cccccc, bg #1e1e1e.
    const THEME_SYNC: &str = r"printf '\033]10;#cccccc\033\\\033]11;#1e1e1e\033\\'";
    // 시작 표식 — 이 래퍼가 WSL 안에서 실제로 실행됐다는 유일한 증거다. 반드시 맨
    // 앞이어야 하고(뒤따르는 파일 I/O 가 막혀도 도달 자체는 증명해야 한다), 바로 뒤의
    // THEME_SYNC 로는 대신할 수 없다 — OSC 10/11 set 은 conhost 가 소비해 우리
    // 리더까지 오지 않는다(이 함수 rustdoc). 왜 OSC 777 인지는
    // `mast_core::osc::OscEvent::Osc777Started` rustdoc.
    const STARTED: &str = r"printf '\033]777;mast-started\007'";
    // OSC 7 emitter (ADR-0011). 이것이 없으면 탭 cwd 는 생성 시점 값에 얼어붙고 재시작이
    // 그 값으로 셸을 띄운다 — 파서·라우터·저장은 이미 다 있고 내는 쪽만 없었다.
    //
    // 왜 사용자 `~/.bashrc` 가 아니라 여기인가: 남의 파일을 고치지 않고, 재프로비저닝
    // 왕복 없이 다음 실행부터 먹으며, 로그인 셸이 우리 값을 덮지 않기 때문이다. starship
    // 은 상속받은 PROMPT_COMMAND 를 `STARSHIP_PROMPT_COMMAND` 로 보존해 자기 precmd 뒤에
    // 실행하므로 공존한다 (실기 측정).
    //
    // `%` 만 미리 인코딩하는 이유: 수신측(`notify::parse_file_uri`)이 `%XX` 만 디코드하고
    // 나머지는 그대로 두므로, 경로에 든 리터럴 `%` 만 되살려 주면 왕복이 무손실이다.
    // 공백·비ASCII 는 인코딩하지 않아도 같은 문자열로 돌아온다. 매 프롬프트마다 도는
    // 코드라 서브셸 없는 파라미터 확장으로 끝낸다.
    //
    // **OSC 0(제목)은 절대 같이 내지 않는다** — 에이전트가 세운 탭 제목을 매 프롬프트마다
    // 디렉터리 이름으로 덮어써 사이드바의 실제 용도를 지운다.
    const OSC7: &str = r#"PROMPT_COMMAND='printf "\033]7;file://%s\007" "${PWD//%/%25}"'"#;
    // 목적지 cwd 로의 이동. `--cd ~` 로 이미 홈에 있으므로 실패해도 셸은 홈에서 뜨고,
    // 그 사실만 흐리게 알린다 (조용한 fallback 금지 — 사용자가 왜 딴 데 있는지 알아야
    // 한다). 경로는 셸 문법을 깨지 못하게 작은따옴표로 인용한다.
    let cd_clause = match cwd {
        None => String::new(),
        Some(path) => {
            let quoted = single_quote(path);
            format!(
                "{{ cd -- {quoted} 2>/dev/null \
                 || printf '\\033[2m[mast] %s is gone; starting in $HOME\\033[0m\\n' {quoted}; }}; "
            )
        }
    };
    let script = match history_tab {
        Some(tab) => format!(
            "{STARTED}; {THEME_SYNC}; {cd_clause}mkdir -p \"$HOME/.mast/history\" \
             && RESUME=\"$HOME/.mast/resume/tab-{tab}\" && cmd= \
             && if [ -s \"$RESUME\" ]; then IFS= read -r cmd < \"$RESUME\" || true; fi \
             && case \"$cmd\" in 'claude --resume '*) \
             expr \"x$cmd\" : 'xclaude --resume [A-Za-z0-9_-][A-Za-z0-9_-]*$' >/dev/null || cmd= ;; \
             'codex resume '*) \
             expr \"x$cmd\" : 'xcodex resume [A-Za-z0-9_-][A-Za-z0-9_-]*$' >/dev/null || cmd= ;; \
             'opencode --session '*) \
             expr \"x$cmd\" : 'xopencode --session [A-Za-z0-9_-][A-Za-z0-9_-]*$' >/dev/null || cmd= ;; \
             *) cmd= ;; esac \
             && if [ -n \"$cmd\" ]; then \
             printf '%s\\n' \"$cmd\" >> \"$HOME/.mast/history/tab-{tab}\"; \
             printf '\\033[2m[mast] resume previous agent: %s\\033[0m\\n' \"$cmd\"; fi \
             && {PATH_PREFIX} COLORTERM=truecolor MAST=1 MAST_TAB={tab} {OSC7} \
             HISTFILE=\"$HOME/.mast/history/tab-{tab}\" exec bash -l"
        ),
        // 탭 id 를 모르는 경로(히스토리 미할당)에서는 MAST 만 — 없는 id 를 지어내지 않는다.
        None => format!(
            "{STARTED}; {THEME_SYNC}; {cd_clause}{PATH_PREFIX} COLORTERM=truecolor MAST=1 {OSC7} exec bash -l"
        ),
    };
    vec!["bash".to_string(), "-c".to_string(), script]
}

/// macOS bootstrap. Windows WSL wrapper 와 같은 started/resume/MAST_TAB 계약만
/// 공유하고, WSL·ConPTY 전용 테마 동기화는 가져오지 않는다.
/// `MAST_TTY` 는 macOS에 /proc 이 없어서 에이전트 훅이 controlling tty 를 잃은 뒤에도
/// 원래 pane 으로 OSC 상태를 돌려보낼 수 있게 하는 힌트다.
#[cfg(target_os = "macos")]
fn macos_shell_argv(history_tab: Option<u64>, cwd: Option<&str>) -> Vec<String> {
    const STARTED: &str = r"printf '\033]777;mast-started\007'";

    let shell = single_quote(&macos_shell());
    let cd_clause = match cwd {
        None => String::new(),
        Some(path) => {
            let quoted = single_quote(path);
            format!(
                r#"{{ cd -- {quoted} 2>/dev/null || {{ printf '\033[2m[mast] %s is gone; starting in $HOME\033[0m\n' {quoted}; cd -- "$HOME"; }}; }}; "#
            )
        }
    };

    let common = format!(
        r#"{STARTED}; {cd_clause}mkdir -p "$HOME/.mast/history" "$HOME/.mast/resume" "$HOME/.mast/agent-hooks" && MAST_TTY="$(tty 2>/dev/null || true)" && export PATH="$HOME/.mast/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" COLORTERM=truecolor MAST=1 && if [ -n "$MAST_TTY" ] && [ "$MAST_TTY" != 'not a tty' ]; then export MAST_TTY; else unset MAST_TTY; fi"#
    );

    let script = match history_tab {
        Some(tab) => format!(
            r#"{common} && RESUME="$HOME/.mast/resume/tab-{tab}" && cmd= && if [ -s "$RESUME" ]; then IFS= read -r cmd < "$RESUME" || true; fi && case "$cmd" in 'claude --resume '*) expr "x$cmd" : 'xclaude --resume [A-Za-z0-9_-][A-Za-z0-9_-]*
/// 스크립트의 문법을 깨거나 명령을 주입하지 못하게 하는 유일한 방어선이다 (탭 cwd 는
/// 셸이 OSC 7 로 보고한 값이라 이론상 무엇이든 들어올 수 있다).
#[cfg(any(windows, target_os = "macos"))]
fn single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
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

#[cfg(all(not(windows), not(target_os = "macos")))]
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
    fn spawn_shell_inner(&self, req: ShellSpawnReq) -> anyhow::Result<SessionId> {
        // sink 가 들고 갈 탭 id — exit 이 기록 파일 이름을 여기서만 얻는다
        // (`history_tab` 은 이 세션이 실릴 탭의 안정 ID 다, 코어 rustdoc).
        let tab = req.history_tab.map(TabId);
        let spec = spawn_spec(&req);
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
/// 만드는 쪽(`bash_argv` 의 `mkdir -p`)이 같은 이유로 같은 규율을 따른다 — 리눅스
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

/// 삭제 스크립트 본문. 탭 하나가 남기는 파일은 탭별 `HISTFILE`, resume 힌트, 에이전트 훅
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
            r#" "$HOME/.mast/history/tab-{id}" "$HOME/.mast/resume/tab-{id}" "$HOME/.mast/resume/tab-{id}".tmp.*"#
        ));
        script.push_str(&format!(
            r#" "$HOME/.mast/agent-hooks/tab-{id}.json" "$HOME/.mast/agent-hooks/tab-{id}.lock" "$HOME/.mast/agent-hooks/tab-{id}.diag" "$HOME/.mast/agent-hooks/tab-{id}.json".tmp.* "$HOME/.mast/agent-hooks/tab-{id}.diag".tmp.*"#
        ));
    }
    script
}

/// macOS는 WSL 왕복 없이 사용자 홈의 Mast 전용 파일만 비동기로 정리한다.
#[cfg(target_os = "macos")]
fn release_tab_files(tabs: &[TabId], _distro: Option<&str>) {
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
        winlog!("release: HOME is not set; macOS tab files were not removed");
        return;
    };
    let tabs = tabs.to_vec();
    let spawned = std::thread::Builder::new()
        .name("mast-release-tabs".to_owned())
        .spawn(move || {
            for tab in tabs {
                let id = tab.0;
                let mast = home.join(".mast");
                for path in [
                    mast.join("history").join(format!("tab-{id}")),
                    mast.join("resume").join(format!("tab-{id}")),
                    mast.join("agent-hooks").join(format!("tab-{id}.json")),
                    mast.join("agent-hooks").join(format!("tab-{id}.lock")),
                    mast.join("agent-hooks").join(format!("tab-{id}.diag")),
                ] {
                    match std::fs::remove_file(&path) {
                        Ok(()) => {}
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                        Err(err) => winlog!("could not remove {}: {err}", path.display()),
                    }
                }
            }
        });
    if let Err(err) = spawned {
        winlog!("could not start the macOS tab-file release thread: {err}");
    }
}

/// 지원 대상이 아닌 unix 개발 실행에는 탭 전용 파일이 없다.
#[cfg(all(not(windows), not(target_os = "macos")))]
fn release_tab_files(_tabs: &[TabId], _distro: Option<&str>) {}

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

    #[test]
    fn history_tab_wraps_bash_with_mast_env_and_per_tab_histfile() {
        let req = ShellSpawnReq {
            cwd: Some("/home/me/proj".to_string()),
            distro: Some("Ubuntu".to_string()),
            history_tab: Some(7),
            ..ShellSpawnReq::default()
        };
        let spec = spawn_spec(&req);
        assert_eq!(spec.program, "wsl.exe");
        // distro 는 `-d`, cwd 는 **`--cd ~` + 래퍼의 cd** 로 간다 (spawn_spec 주석).
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
        let script = spec.args.last().expect("script argv");

        // 시작 표식은 반드시 맨 앞 — 뒤따르는 어떤 실패보다 먼저 도달을 증명해야 한다.
        assert!(
            script.starts_with(r"printf '\033]777;mast-started\007'; "),
            "{script}"
        );
        // 목적지 cwd 는 인용된 채로 래퍼 안에서 cd 되고, 실패해도 셸은 뜬다.
        assert!(script.contains(r"{ cd -- '/home/me/proj' 2>/dev/null"), "{script}");
        assert!(script.contains("is gone; starting in $HOME"), "{script}");
        // OSC 7 emitter (ADR-0011) — 이게 빠지면 탭 cwd 가 다시 얼어붙는다.
        assert!(
            script.contains(r#"PROMPT_COMMAND='printf "\033]7;file://%s\007" "${PWD//%/%25}"'"#),
            "{script}"
        );
        // 제목(OSC 0)은 절대 같이 내지 않는다 — 에이전트가 세운 탭 제목을 덮는다.
        assert!(!script.contains(r"\033]0;"), "{script}");
        // 탭별 HISTFILE·resume 힌트·PATH 는 종전 계약 그대로.
        assert!(
            script.contains(r#"HISTFILE="$HOME/.mast/history/tab-7" exec bash -l"#),
            "{script}"
        );
        assert!(
            script.contains(r#"RESUME="$HOME/.mast/resume/tab-7""#),
            "{script}"
        );
        assert!(script.contains("'opencode --session '*"), "{script}");
        assert!(script.contains("xopencode --session [A-Za-z0-9_-]"), "{script}");
        assert!(script.contains(r#"PATH="$HOME/.mast/bin:$PATH""#), "{script}");
        assert!(script.contains("MAST_TAB=7"), "{script}");
    }

    /// 셸 인용 — 경로가 래퍼 문법을 깨거나 명령을 주입하지 못한다. 탭 cwd 는 셸이
    /// OSC 7 로 보고한 값이라 이론상 무엇이든 들어올 수 있다.
    #[test]
    fn tab_cwd_is_single_quoted_into_the_wrapper() {
        let req = ShellSpawnReq {
            cwd: Some("/home/me/it's here; rm -rf /".to_string()),
            ..ShellSpawnReq::default()
        };
        let spec = spawn_spec(&req);
        let script = spec.args.last().expect("script argv");
        assert!(
            script.contains(r"cd -- '/home/me/it'\''s here; rm -rf /' 2>/dev/null"),
            "{script}"
        );
    }

    /// cwd 가 없으면 cd 절 자체가 없다 — `--cd ~` 가 이미 홈에 세워 둔다.
    #[test]
    fn without_cwd_there_is_no_cd_clause() {
        let spec = spawn_spec(&ShellSpawnReq::default());
        let script = spec.args.last().expect("script argv");
        assert!(!script.contains("cd --"), "{script}");
    }

    #[test]
    fn without_history_tab_the_shell_still_gets_mast_but_no_tab_id() {
        let spec = spawn_spec(&ShellSpawnReq::default());
        // 탭 id 가 없으면 MAST 만 물린 로그인 셸 (셸 기본 history 그대로).
        // PATH 프리펜드는 두 경로에 다 걸린다 — mast CLI 는 탭 id 와 무관하다.
        // resume 힌트도 없다 — 힌트 파일은 탭 id 로 주소가 정해지므로 id 가 없으면
        // 읽을 파일 자체가 없다 (없는 id 를 지어내지 않는 규율의 연장).
        let script = spec.args.last().expect("script argv");
        assert!(script.contains("COLORTERM=truecolor MAST=1 "), "{script}");
        assert!(!script.contains("MAST_TAB"), "{script}");
        assert!(!script.contains("HISTFILE"), "{script}");
        assert!(!script.contains("RESUME"), "{script}");
        // OSC 7 은 탭 id 와 무관하게 두 경로 다 낸다 — cwd 추적은 history 와 별개다.
        assert!(
            script.contains(r#"PROMPT_COMMAND='printf "\033]7;file://%s\007" "${PWD//%/%25}"'"#),
            "{script}"
        );
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
                r#" "$HOME/.mast/history/tab-7" "$HOME/.mast/resume/tab-7" "$HOME/.mast/resume/tab-7".tmp.*"#,
                r#" "$HOME/.mast/agent-hooks/tab-7.json" "$HOME/.mast/agent-hooks/tab-7.lock" "$HOME/.mast/agent-hooks/tab-7.diag""#,
                r#" "$HOME/.mast/agent-hooks/tab-7.json".tmp.* "$HOME/.mast/agent-hooks/tab-7.diag".tmp.*"#,
                r#" "$HOME/.mast/history/tab-12" "$HOME/.mast/resume/tab-12" "$HOME/.mast/resume/tab-12".tmp.*"#,
                r#" "$HOME/.mast/agent-hooks/tab-12.json" "$HOME/.mast/agent-hooks/tab-12.lock" "$HOME/.mast/agent-hooks/tab-12.diag""#,
                r#" "$HOME/.mast/agent-hooks/tab-12.json".tmp.* "$HOME/.mast/agent-hooks/tab-12.diag".tmp.*"#,
            )
        );
    }
}
 >/dev/null || cmd= ;; 'codex resume '*) expr "x$cmd" : 'xcodex resume [A-Za-z0-9_-][A-Za-z0-9_-]*
/// 스크립트의 문법을 깨거나 명령을 주입하지 못하게 하는 유일한 방어선이다 (탭 cwd 는
/// 셸이 OSC 7 로 보고한 값이라 이론상 무엇이든 들어올 수 있다).
#[cfg(windows)]
fn single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// 시작 표식을 기다리는 기본 마감. 웜 스타트 실측이 163~194ms 라 크게 여유롭지만,
/// 값을 고르는 부담 자체가 작다 — 마감을 넘겨도 세션을 죽이지 않고 탭에 표시만 하므로
/// 틀렸을 때의 대가가 경고 한 번뿐이다. 죽이는 설계였다면 WSL 콜드 스타트가 수 초에서
/// 수 분까지 걸린 보고들 때문에 어떤 값도 정당화할 수 없었다.
const STARTUP_DEADLINE: Duration = Duration::from_secs(20);

/// 표식을 낼 래퍼가 있는 경로에서만 기본 활성이다. unix 개발 실행은 `$SHELL -l` 을
/// 직접 띄워(`spawn_spec`) 표식을 낼 자리가 없으므로, 마감을 걸면 느린 rc 가 곧바로
/// 오탐이 된다.
#[cfg(windows)]
fn platform_startup_deadline() -> Option<Duration> {
    Some(STARTUP_DEADLINE)
}

#[cfg(not(windows))]
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
    fn spawn_shell_inner(&self, req: ShellSpawnReq) -> anyhow::Result<SessionId> {
        // sink 가 들고 갈 탭 id — exit 이 기록 파일 이름을 여기서만 얻는다
        // (`history_tab` 은 이 세션이 실릴 탭의 안정 ID 다, 코어 rustdoc).
        let tab = req.history_tab.map(TabId);
        let spec = spawn_spec(&req);
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
/// 만드는 쪽(`bash_argv` 의 `mkdir -p`)이 같은 이유로 같은 규율을 따른다 — 리눅스
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

/// 삭제 스크립트 본문. 탭 하나가 남기는 파일은 탭별 `HISTFILE`, resume 힌트, 에이전트 훅
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
            r#" "$HOME/.mast/history/tab-{id}" "$HOME/.mast/resume/tab-{id}" "$HOME/.mast/resume/tab-{id}".tmp.*"#
        ));
        script.push_str(&format!(
            r#" "$HOME/.mast/agent-hooks/tab-{id}.json" "$HOME/.mast/agent-hooks/tab-{id}.lock" "$HOME/.mast/agent-hooks/tab-{id}.diag" "$HOME/.mast/agent-hooks/tab-{id}.json".tmp.* "$HOME/.mast/agent-hooks/tab-{id}.diag".tmp.*"#
        ));
    }
    script
}

/// unix 개발 실행에는 지울 것이 없다 — `spawn_spec` 이 탭별 `HISTFILE` 을 물리지
/// 않으므로(그 함수 주석) 탭 전용 파일 자체가 만들어지지 않는다.
#[cfg(not(windows))]
fn release_tab_files(_tabs: &[TabId], _distro: Option<&str>) {}

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

    #[test]
    fn history_tab_wraps_bash_with_mast_env_and_per_tab_histfile() {
        let req = ShellSpawnReq {
            cwd: Some("/home/me/proj".to_string()),
            distro: Some("Ubuntu".to_string()),
            history_tab: Some(7),
            ..ShellSpawnReq::default()
        };
        let spec = spawn_spec(&req);
        assert_eq!(spec.program, "wsl.exe");
        // distro 는 `-d`, cwd 는 **`--cd ~` + 래퍼의 cd** 로 간다 (spawn_spec 주석).
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
        let script = spec.args.last().expect("script argv");

        // 시작 표식은 반드시 맨 앞 — 뒤따르는 어떤 실패보다 먼저 도달을 증명해야 한다.
        assert!(
            script.starts_with(r"printf '\033]777;mast-started\007'; "),
            "{script}"
        );
        // 목적지 cwd 는 인용된 채로 래퍼 안에서 cd 되고, 실패해도 셸은 뜬다.
        assert!(script.contains(r"{ cd -- '/home/me/proj' 2>/dev/null"), "{script}");
        assert!(script.contains("is gone; starting in $HOME"), "{script}");
        // OSC 7 emitter (ADR-0011) — 이게 빠지면 탭 cwd 가 다시 얼어붙는다.
        assert!(
            script.contains(r#"PROMPT_COMMAND='printf "\033]7;file://%s\007" "${PWD//%/%25}"'"#),
            "{script}"
        );
        // 제목(OSC 0)은 절대 같이 내지 않는다 — 에이전트가 세운 탭 제목을 덮는다.
        assert!(!script.contains(r"\033]0;"), "{script}");
        // 탭별 HISTFILE·resume 힌트·PATH 는 종전 계약 그대로.
        assert!(
            script.contains(r#"HISTFILE="$HOME/.mast/history/tab-7" exec bash -l"#),
            "{script}"
        );
        assert!(
            script.contains(r#"RESUME="$HOME/.mast/resume/tab-7""#),
            "{script}"
        );
        assert!(script.contains("'opencode --session '*"), "{script}");
        assert!(script.contains("xopencode --session [A-Za-z0-9_-]"), "{script}");
        assert!(script.contains(r#"PATH="$HOME/.mast/bin:$PATH""#), "{script}");
        assert!(script.contains("MAST_TAB=7"), "{script}");
    }

    /// 셸 인용 — 경로가 래퍼 문법을 깨거나 명령을 주입하지 못한다. 탭 cwd 는 셸이
    /// OSC 7 로 보고한 값이라 이론상 무엇이든 들어올 수 있다.
    #[test]
    fn tab_cwd_is_single_quoted_into_the_wrapper() {
        let req = ShellSpawnReq {
            cwd: Some("/home/me/it's here; rm -rf /".to_string()),
            ..ShellSpawnReq::default()
        };
        let spec = spawn_spec(&req);
        let script = spec.args.last().expect("script argv");
        assert!(
            script.contains(r"cd -- '/home/me/it'\''s here; rm -rf /' 2>/dev/null"),
            "{script}"
        );
    }

    /// cwd 가 없으면 cd 절 자체가 없다 — `--cd ~` 가 이미 홈에 세워 둔다.
    #[test]
    fn without_cwd_there_is_no_cd_clause() {
        let spec = spawn_spec(&ShellSpawnReq::default());
        let script = spec.args.last().expect("script argv");
        assert!(!script.contains("cd --"), "{script}");
    }

    #[test]
    fn without_history_tab_the_shell_still_gets_mast_but_no_tab_id() {
        let spec = spawn_spec(&ShellSpawnReq::default());
        // 탭 id 가 없으면 MAST 만 물린 로그인 셸 (셸 기본 history 그대로).
        // PATH 프리펜드는 두 경로에 다 걸린다 — mast CLI 는 탭 id 와 무관하다.
        // resume 힌트도 없다 — 힌트 파일은 탭 id 로 주소가 정해지므로 id 가 없으면
        // 읽을 파일 자체가 없다 (없는 id 를 지어내지 않는 규율의 연장).
        let script = spec.args.last().expect("script argv");
        assert!(script.contains("COLORTERM=truecolor MAST=1 "), "{script}");
        assert!(!script.contains("MAST_TAB"), "{script}");
        assert!(!script.contains("HISTFILE"), "{script}");
        assert!(!script.contains("RESUME"), "{script}");
        // OSC 7 은 탭 id 와 무관하게 두 경로 다 낸다 — cwd 추적은 history 와 별개다.
        assert!(
            script.contains(r#"PROMPT_COMMAND='printf "\033]7;file://%s\007" "${PWD//%/%25}"'"#),
            "{script}"
        );
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
                r#" "$HOME/.mast/history/tab-7" "$HOME/.mast/resume/tab-7" "$HOME/.mast/resume/tab-7".tmp.*"#,
                r#" "$HOME/.mast/agent-hooks/tab-7.json" "$HOME/.mast/agent-hooks/tab-7.lock" "$HOME/.mast/agent-hooks/tab-7.diag""#,
                r#" "$HOME/.mast/agent-hooks/tab-7.json".tmp.* "$HOME/.mast/agent-hooks/tab-7.diag".tmp.*"#,
                r#" "$HOME/.mast/history/tab-12" "$HOME/.mast/resume/tab-12" "$HOME/.mast/resume/tab-12".tmp.*"#,
                r#" "$HOME/.mast/agent-hooks/tab-12.json" "$HOME/.mast/agent-hooks/tab-12.lock" "$HOME/.mast/agent-hooks/tab-12.diag""#,
                r#" "$HOME/.mast/agent-hooks/tab-12.json".tmp.* "$HOME/.mast/agent-hooks/tab-12.diag".tmp.*"#,
            )
        );
    }
}
 >/dev/null || cmd= ;; 'opencode --session '*) expr "x$cmd" : 'xopencode --session [A-Za-z0-9_-][A-Za-z0-9_-]*
/// 스크립트의 문법을 깨거나 명령을 주입하지 못하게 하는 유일한 방어선이다 (탭 cwd 는
/// 셸이 OSC 7 로 보고한 값이라 이론상 무엇이든 들어올 수 있다).
#[cfg(windows)]
fn single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// 시작 표식을 기다리는 기본 마감. 웜 스타트 실측이 163~194ms 라 크게 여유롭지만,
/// 값을 고르는 부담 자체가 작다 — 마감을 넘겨도 세션을 죽이지 않고 탭에 표시만 하므로
/// 틀렸을 때의 대가가 경고 한 번뿐이다. 죽이는 설계였다면 WSL 콜드 스타트가 수 초에서
/// 수 분까지 걸린 보고들 때문에 어떤 값도 정당화할 수 없었다.
const STARTUP_DEADLINE: Duration = Duration::from_secs(20);

/// 표식을 낼 래퍼가 있는 경로에서만 기본 활성이다. unix 개발 실행은 `$SHELL -l` 을
/// 직접 띄워(`spawn_spec`) 표식을 낼 자리가 없으므로, 마감을 걸면 느린 rc 가 곧바로
/// 오탐이 된다.
#[cfg(windows)]
fn platform_startup_deadline() -> Option<Duration> {
    Some(STARTUP_DEADLINE)
}

#[cfg(not(windows))]
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
    fn spawn_shell_inner(&self, req: ShellSpawnReq) -> anyhow::Result<SessionId> {
        // sink 가 들고 갈 탭 id — exit 이 기록 파일 이름을 여기서만 얻는다
        // (`history_tab` 은 이 세션이 실릴 탭의 안정 ID 다, 코어 rustdoc).
        let tab = req.history_tab.map(TabId);
        let spec = spawn_spec(&req);
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
/// 만드는 쪽(`bash_argv` 의 `mkdir -p`)이 같은 이유로 같은 규율을 따른다 — 리눅스
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

/// 삭제 스크립트 본문. 탭 하나가 남기는 파일은 탭별 `HISTFILE`, resume 힌트, 에이전트 훅
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
            r#" "$HOME/.mast/history/tab-{id}" "$HOME/.mast/resume/tab-{id}" "$HOME/.mast/resume/tab-{id}".tmp.*"#
        ));
        script.push_str(&format!(
            r#" "$HOME/.mast/agent-hooks/tab-{id}.json" "$HOME/.mast/agent-hooks/tab-{id}.lock" "$HOME/.mast/agent-hooks/tab-{id}.diag" "$HOME/.mast/agent-hooks/tab-{id}.json".tmp.* "$HOME/.mast/agent-hooks/tab-{id}.diag".tmp.*"#
        ));
    }
    script
}

/// unix 개발 실행에는 지울 것이 없다 — `spawn_spec` 이 탭별 `HISTFILE` 을 물리지
/// 않으므로(그 함수 주석) 탭 전용 파일 자체가 만들어지지 않는다.
#[cfg(not(windows))]
fn release_tab_files(_tabs: &[TabId], _distro: Option<&str>) {}

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

    #[test]
    fn history_tab_wraps_bash_with_mast_env_and_per_tab_histfile() {
        let req = ShellSpawnReq {
            cwd: Some("/home/me/proj".to_string()),
            distro: Some("Ubuntu".to_string()),
            history_tab: Some(7),
            ..ShellSpawnReq::default()
        };
        let spec = spawn_spec(&req);
        assert_eq!(spec.program, "wsl.exe");
        // distro 는 `-d`, cwd 는 **`--cd ~` + 래퍼의 cd** 로 간다 (spawn_spec 주석).
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
        let script = spec.args.last().expect("script argv");

        // 시작 표식은 반드시 맨 앞 — 뒤따르는 어떤 실패보다 먼저 도달을 증명해야 한다.
        assert!(
            script.starts_with(r"printf '\033]777;mast-started\007'; "),
            "{script}"
        );
        // 목적지 cwd 는 인용된 채로 래퍼 안에서 cd 되고, 실패해도 셸은 뜬다.
        assert!(script.contains(r"{ cd -- '/home/me/proj' 2>/dev/null"), "{script}");
        assert!(script.contains("is gone; starting in $HOME"), "{script}");
        // OSC 7 emitter (ADR-0011) — 이게 빠지면 탭 cwd 가 다시 얼어붙는다.
        assert!(
            script.contains(r#"PROMPT_COMMAND='printf "\033]7;file://%s\007" "${PWD//%/%25}"'"#),
            "{script}"
        );
        // 제목(OSC 0)은 절대 같이 내지 않는다 — 에이전트가 세운 탭 제목을 덮는다.
        assert!(!script.contains(r"\033]0;"), "{script}");
        // 탭별 HISTFILE·resume 힌트·PATH 는 종전 계약 그대로.
        assert!(
            script.contains(r#"HISTFILE="$HOME/.mast/history/tab-7" exec bash -l"#),
            "{script}"
        );
        assert!(
            script.contains(r#"RESUME="$HOME/.mast/resume/tab-7""#),
            "{script}"
        );
        assert!(script.contains("'opencode --session '*"), "{script}");
        assert!(script.contains("xopencode --session [A-Za-z0-9_-]"), "{script}");
        assert!(script.contains(r#"PATH="$HOME/.mast/bin:$PATH""#), "{script}");
        assert!(script.contains("MAST_TAB=7"), "{script}");
    }

    /// 셸 인용 — 경로가 래퍼 문법을 깨거나 명령을 주입하지 못한다. 탭 cwd 는 셸이
    /// OSC 7 로 보고한 값이라 이론상 무엇이든 들어올 수 있다.
    #[test]
    fn tab_cwd_is_single_quoted_into_the_wrapper() {
        let req = ShellSpawnReq {
            cwd: Some("/home/me/it's here; rm -rf /".to_string()),
            ..ShellSpawnReq::default()
        };
        let spec = spawn_spec(&req);
        let script = spec.args.last().expect("script argv");
        assert!(
            script.contains(r"cd -- '/home/me/it'\''s here; rm -rf /' 2>/dev/null"),
            "{script}"
        );
    }

    /// cwd 가 없으면 cd 절 자체가 없다 — `--cd ~` 가 이미 홈에 세워 둔다.
    #[test]
    fn without_cwd_there_is_no_cd_clause() {
        let spec = spawn_spec(&ShellSpawnReq::default());
        let script = spec.args.last().expect("script argv");
        assert!(!script.contains("cd --"), "{script}");
    }

    #[test]
    fn without_history_tab_the_shell_still_gets_mast_but_no_tab_id() {
        let spec = spawn_spec(&ShellSpawnReq::default());
        // 탭 id 가 없으면 MAST 만 물린 로그인 셸 (셸 기본 history 그대로).
        // PATH 프리펜드는 두 경로에 다 걸린다 — mast CLI 는 탭 id 와 무관하다.
        // resume 힌트도 없다 — 힌트 파일은 탭 id 로 주소가 정해지므로 id 가 없으면
        // 읽을 파일 자체가 없다 (없는 id 를 지어내지 않는 규율의 연장).
        let script = spec.args.last().expect("script argv");
        assert!(script.contains("COLORTERM=truecolor MAST=1 "), "{script}");
        assert!(!script.contains("MAST_TAB"), "{script}");
        assert!(!script.contains("HISTFILE"), "{script}");
        assert!(!script.contains("RESUME"), "{script}");
        // OSC 7 은 탭 id 와 무관하게 두 경로 다 낸다 — cwd 추적은 history 와 별개다.
        assert!(
            script.contains(r#"PROMPT_COMMAND='printf "\033]7;file://%s\007" "${PWD//%/%25}"'"#),
            "{script}"
        );
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
                r#" "$HOME/.mast/history/tab-7" "$HOME/.mast/resume/tab-7" "$HOME/.mast/resume/tab-7".tmp.*"#,
                r#" "$HOME/.mast/agent-hooks/tab-7.json" "$HOME/.mast/agent-hooks/tab-7.lock" "$HOME/.mast/agent-hooks/tab-7.diag""#,
                r#" "$HOME/.mast/agent-hooks/tab-7.json".tmp.* "$HOME/.mast/agent-hooks/tab-7.diag".tmp.*"#,
                r#" "$HOME/.mast/history/tab-12" "$HOME/.mast/resume/tab-12" "$HOME/.mast/resume/tab-12".tmp.*"#,
                r#" "$HOME/.mast/agent-hooks/tab-12.json" "$HOME/.mast/agent-hooks/tab-12.lock" "$HOME/.mast/agent-hooks/tab-12.diag""#,
                r#" "$HOME/.mast/agent-hooks/tab-12.json".tmp.* "$HOME/.mast/agent-hooks/tab-12.diag".tmp.*"#,
            )
        );
    }
}
 >/dev/null || cmd= ;; *) cmd= ;; esac && if [ -n "$cmd" ]; then printf '%s\n' "$cmd" >> "$HOME/.mast/history/tab-{tab}"; printf '\033[2m[mast] resume previous agent: %s\033[0m\n' "$cmd"; fi && export MAST_TAB={tab} HISTFILE="$HOME/.mast/history/tab-{tab}" && exec {shell} -l"#
        ),
        None => format!(r#"{common} && exec {shell} -l"#),
    };

    vec!["-c".to_owned(), script]
}

/// 셸 작은따옴표 인용 — 값 안의 `'` 를 `'\''` 로 끊어 붙인다. 경로가 우리 래퍼
/// 스크립트의 문법을 깨거나 명령을 주입하지 못하게 하는 유일한 방어선이다 (탭 cwd 는
/// 셸이 OSC 7 로 보고한 값이라 이론상 무엇이든 들어올 수 있다).
#[cfg(windows)]
fn single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// 시작 표식을 기다리는 기본 마감. 웜 스타트 실측이 163~194ms 라 크게 여유롭지만,
/// 값을 고르는 부담 자체가 작다 — 마감을 넘겨도 세션을 죽이지 않고 탭에 표시만 하므로
/// 틀렸을 때의 대가가 경고 한 번뿐이다. 죽이는 설계였다면 WSL 콜드 스타트가 수 초에서
/// 수 분까지 걸린 보고들 때문에 어떤 값도 정당화할 수 없었다.
const STARTUP_DEADLINE: Duration = Duration::from_secs(20);

/// 표식을 낼 래퍼가 있는 경로에서만 기본 활성이다. unix 개발 실행은 `$SHELL -l` 을
/// 직접 띄워(`spawn_spec`) 표식을 낼 자리가 없으므로, 마감을 걸면 느린 rc 가 곧바로
/// 오탐이 된다.
#[cfg(windows)]
fn platform_startup_deadline() -> Option<Duration> {
    Some(STARTUP_DEADLINE)
}

#[cfg(not(windows))]
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
    fn spawn_shell_inner(&self, req: ShellSpawnReq) -> anyhow::Result<SessionId> {
        // sink 가 들고 갈 탭 id — exit 이 기록 파일 이름을 여기서만 얻는다
        // (`history_tab` 은 이 세션이 실릴 탭의 안정 ID 다, 코어 rustdoc).
        let tab = req.history_tab.map(TabId);
        let spec = spawn_spec(&req);
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
/// 만드는 쪽(`bash_argv` 의 `mkdir -p`)이 같은 이유로 같은 규율을 따른다 — 리눅스
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

/// 삭제 스크립트 본문. 탭 하나가 남기는 파일은 탭별 `HISTFILE`, resume 힌트, 에이전트 훅
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
            r#" "$HOME/.mast/history/tab-{id}" "$HOME/.mast/resume/tab-{id}" "$HOME/.mast/resume/tab-{id}".tmp.*"#
        ));
        script.push_str(&format!(
            r#" "$HOME/.mast/agent-hooks/tab-{id}.json" "$HOME/.mast/agent-hooks/tab-{id}.lock" "$HOME/.mast/agent-hooks/tab-{id}.diag" "$HOME/.mast/agent-hooks/tab-{id}.json".tmp.* "$HOME/.mast/agent-hooks/tab-{id}.diag".tmp.*"#
        ));
    }
    script
}

/// unix 개발 실행에는 지울 것이 없다 — `spawn_spec` 이 탭별 `HISTFILE` 을 물리지
/// 않으므로(그 함수 주석) 탭 전용 파일 자체가 만들어지지 않는다.
#[cfg(not(windows))]
fn release_tab_files(_tabs: &[TabId], _distro: Option<&str>) {}

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

    #[test]
    fn history_tab_wraps_bash_with_mast_env_and_per_tab_histfile() {
        let req = ShellSpawnReq {
            cwd: Some("/home/me/proj".to_string()),
            distro: Some("Ubuntu".to_string()),
            history_tab: Some(7),
            ..ShellSpawnReq::default()
        };
        let spec = spawn_spec(&req);
        assert_eq!(spec.program, "wsl.exe");
        // distro 는 `-d`, cwd 는 **`--cd ~` + 래퍼의 cd** 로 간다 (spawn_spec 주석).
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
        let script = spec.args.last().expect("script argv");

        // 시작 표식은 반드시 맨 앞 — 뒤따르는 어떤 실패보다 먼저 도달을 증명해야 한다.
        assert!(
            script.starts_with(r"printf '\033]777;mast-started\007'; "),
            "{script}"
        );
        // 목적지 cwd 는 인용된 채로 래퍼 안에서 cd 되고, 실패해도 셸은 뜬다.
        assert!(script.contains(r"{ cd -- '/home/me/proj' 2>/dev/null"), "{script}");
        assert!(script.contains("is gone; starting in $HOME"), "{script}");
        // OSC 7 emitter (ADR-0011) — 이게 빠지면 탭 cwd 가 다시 얼어붙는다.
        assert!(
            script.contains(r#"PROMPT_COMMAND='printf "\033]7;file://%s\007" "${PWD//%/%25}"'"#),
            "{script}"
        );
        // 제목(OSC 0)은 절대 같이 내지 않는다 — 에이전트가 세운 탭 제목을 덮는다.
        assert!(!script.contains(r"\033]0;"), "{script}");
        // 탭별 HISTFILE·resume 힌트·PATH 는 종전 계약 그대로.
        assert!(
            script.contains(r#"HISTFILE="$HOME/.mast/history/tab-7" exec bash -l"#),
            "{script}"
        );
        assert!(
            script.contains(r#"RESUME="$HOME/.mast/resume/tab-7""#),
            "{script}"
        );
        assert!(script.contains("'opencode --session '*"), "{script}");
        assert!(script.contains("xopencode --session [A-Za-z0-9_-]"), "{script}");
        assert!(script.contains(r#"PATH="$HOME/.mast/bin:$PATH""#), "{script}");
        assert!(script.contains("MAST_TAB=7"), "{script}");
    }

    /// 셸 인용 — 경로가 래퍼 문법을 깨거나 명령을 주입하지 못한다. 탭 cwd 는 셸이
    /// OSC 7 로 보고한 값이라 이론상 무엇이든 들어올 수 있다.
    #[test]
    fn tab_cwd_is_single_quoted_into_the_wrapper() {
        let req = ShellSpawnReq {
            cwd: Some("/home/me/it's here; rm -rf /".to_string()),
            ..ShellSpawnReq::default()
        };
        let spec = spawn_spec(&req);
        let script = spec.args.last().expect("script argv");
        assert!(
            script.contains(r"cd -- '/home/me/it'\''s here; rm -rf /' 2>/dev/null"),
            "{script}"
        );
    }

    /// cwd 가 없으면 cd 절 자체가 없다 — `--cd ~` 가 이미 홈에 세워 둔다.
    #[test]
    fn without_cwd_there_is_no_cd_clause() {
        let spec = spawn_spec(&ShellSpawnReq::default());
        let script = spec.args.last().expect("script argv");
        assert!(!script.contains("cd --"), "{script}");
    }

    #[test]
    fn without_history_tab_the_shell_still_gets_mast_but_no_tab_id() {
        let spec = spawn_spec(&ShellSpawnReq::default());
        // 탭 id 가 없으면 MAST 만 물린 로그인 셸 (셸 기본 history 그대로).
        // PATH 프리펜드는 두 경로에 다 걸린다 — mast CLI 는 탭 id 와 무관하다.
        // resume 힌트도 없다 — 힌트 파일은 탭 id 로 주소가 정해지므로 id 가 없으면
        // 읽을 파일 자체가 없다 (없는 id 를 지어내지 않는 규율의 연장).
        let script = spec.args.last().expect("script argv");
        assert!(script.contains("COLORTERM=truecolor MAST=1 "), "{script}");
        assert!(!script.contains("MAST_TAB"), "{script}");
        assert!(!script.contains("HISTFILE"), "{script}");
        assert!(!script.contains("RESUME"), "{script}");
        // OSC 7 은 탭 id 와 무관하게 두 경로 다 낸다 — cwd 추적은 history 와 별개다.
        assert!(
            script.contains(r#"PROMPT_COMMAND='printf "\033]7;file://%s\007" "${PWD//%/%25}"'"#),
            "{script}"
        );
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
                r#" "$HOME/.mast/history/tab-7" "$HOME/.mast/resume/tab-7" "$HOME/.mast/resume/tab-7".tmp.*"#,
                r#" "$HOME/.mast/agent-hooks/tab-7.json" "$HOME/.mast/agent-hooks/tab-7.lock" "$HOME/.mast/agent-hooks/tab-7.diag""#,
                r#" "$HOME/.mast/agent-hooks/tab-7.json".tmp.* "$HOME/.mast/agent-hooks/tab-7.diag".tmp.*"#,
                r#" "$HOME/.mast/history/tab-12" "$HOME/.mast/resume/tab-12" "$HOME/.mast/resume/tab-12".tmp.*"#,
                r#" "$HOME/.mast/agent-hooks/tab-12.json" "$HOME/.mast/agent-hooks/tab-12.lock" "$HOME/.mast/agent-hooks/tab-12.diag""#,
                r#" "$HOME/.mast/agent-hooks/tab-12.json".tmp.* "$HOME/.mast/agent-hooks/tab-12.diag".tmp.*"#,
            )
        );
    }
}
