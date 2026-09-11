# mast Spike 실행 계획

> **집행 완료 (2026-08-08).** Windows 검증까지 끝났고 판정은 **후보 A 채택** — 결과·수치·후속
> 항목은 [`docs/adr/0001-adopt-tauri-webview2-xterm-stack.md`](../adr/0001-adopt-tauri-webview2-xterm-stack.md)
> 참조. 이 문서의 4장(모듈 계약)은 코드 주석들이 참조하는 계약 문서로 유지되며, MVP 리팩터링이
> 계약을 대체하는 시점에 문서 전체를 삭제한다.
> **4.3(flow)·4.4(session)은 10단계 청크 A에서 대체됨** — 현행 계약은 해당 모듈의 rustdoc
> (`crates/mast-core/src/{flow,session}.rs`)이 정본이다 (offset/Delivery sink·reattach·id 선발급).

`터미널-계획-v2.md`(이하 "계획 v2") 17장 개발 순서의 **1~9단계(기술 검증 Spike)** 를 코드로 만드는
세션 실행 계획이다. 계획 v2가 제품 계획이고, 이 문서는 그중 Spike 단계를 "무엇을 어떤 계약으로
어떻게 구현·검증하는지"로 구체화한다.

## 1. 사전 확인 결과 (계획 v2 17장 1단계)

- **Codex CLI Linux ARM64 바이너리: 존재 확인.** openai/codex 최신 릴리스(rust-v0.147.0)에
  `codex-aarch64-unknown-linux-musl.tar.gz`, `codex-npm-linux-arm64` 자산이 있다. ARM64 WSL에서
  Codex 실행 가능 — 게이트 통과.
- 개발 머신: **x86_64** (WSL2 Ubuntu-24.04, Windows 11 호스트). 계획 v2의 ARM64는 대상 기기
  기준이며, 이 머신에서는 x64로 개발·검증하고 ARM64는 CI/실기기 단계에서 다룬다.
- WSL에 Rust/Node 없음 → 이 세션에서 userspace 설치(`~/.cargo`, `~/.local/node`).
- Windows 쪽에 Rust/MSVC 툴체인 없음 → **Windows 실행 검증(ConPTY OSC passthrough·IME·RAM 측정)은
  이 세션에서 불가능.** 사용자가 `docs/WINDOWS-BUILD.md` 절차로 빌드해 수행한다.

## 2. 이 세션의 산출물 범위

| 산출물 | 검증 방식 |
|---|---|
| `crates/mast-core` — OSC 스캐너·replay buffer·flow control·PTY 세션 (순수 Rust, tauri 무관) | WSL에서 `cargo test`(unix PTY 통합 테스트 포함)·`clippy`·windows target `cargo check` |
| `apps/spike` — Tauri v2 + xterm.js Spike 앱 (창 1개, 터미널 N개 그리드, 상태 표시) | 프론트엔드는 `tsc`+`vite build`+`vitest`, src-tauri는 windows target `cargo check`(best-effort) |
| `scripts/wsl/*` — OSC 방출·flood·scrollback 테스트, Claude Code hook 예시 | shellcheck 수준 검토 (실행은 Spike 검증 시) |
| `scripts/win/measure.ps1` — private working set(WebView2 트리 포함) 측정 | Windows에서 사용자 실행 |
| `docs/WINDOWS-BUILD.md` — Windows 빌드·검증 절차 (영어, tracked reference) | 문서 |
| 이 문서 6장 — Spike 검증 체크리스트 (계획 v2 3장의 실행판) | Windows에서 사용자 수행 |

**Spike 판정(후보 A 채택/후보 B 진입)은 Windows 실행 결과가 나와야 내릴 수 있다.** 이 세션은
판정에 필요한 도구 일체를 만든다.

## 3. 저장소 구조

```
mast/
  터미널-계획-v2.md          제품 계획 (원본 유지)
  README.md                  영어 tracked reference
  docs/
    plans/spike-plan.md      이 문서
    WINDOWS-BUILD.md         Windows 빌드·검증 절차 (영어)
  crates/mast-core/          순수 Rust 코어 (tauri 의존 없음)
    src/{lib.rs, osc.rs, replay.rs, flow.rs, session.rs}
  apps/spike/
    package.json, vite.config.ts, tsconfig.json, index.html
    src/                     프론트엔드 TS (xterm.js)
    src-tauri/               Tauri v2 앱 (얇은 글루)
  scripts/
    wsl/{osc-test.sh, flood.sh, scrollback-test.sh, claude-hook-example.md}
    win/measure.ps1
```

Cargo workspace: 루트 `Cargo.toml`, members = `crates/mast-core`, `apps/spike/src-tauri`.

## 4. 모듈 계약 (구현 에이전트 브리프)

계획 v2의 원칙을 코드 경계로 옮긴 것. 식별자·시그니처는 영어, 주석은 한국어.

### 4.1 `mast-core::osc` — OSC 감지 (계획 v2 2·9장)

```rust
pub enum OscEvent {
    Osc0Title(String),
    Osc7Cwd(String),                     // file://host/path URI
    Osc9Notify(String),
    Osc777Notify { title: String, body: String },
}
pub struct OscScanner { /* 증분 상태 머신 */ }
impl OscScanner {
    pub fn new() -> Self;
    /// bytes를 소비하며 완성된 이벤트를 반환. 감지 전용 — 입력을 변형하지 않는다(passthrough).
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<OscEvent>;
}
```

- 종결자 BEL(`\x07`)과 ST(`ESC \`) 둘 다 지원.
- **청크 경계 분할 지원 필수** — 시퀀스가 두 번의 `feed`에 걸쳐 와도 인식.
- payload 상한 4096 bytes — 초과 시 해당 시퀀스 폐기(악성/폭주 입력 방어).
- OSC 777은 `notify;title;body` 형식(urxvt 계열) 파싱.
- Rust PTY 리더 단에서 실행된다(계획 v2: xterm.js가 아니라 Rust에서 감지).

### 4.2 `mast-core::replay` — replay buffer (계획 v2 12장)

```rust
pub struct ReplayBuffer { /* chunk VecDeque + 총량 계정 */ }
impl ReplayBuffer {
    pub fn new(cap_bytes: usize) -> Self;   // spike 기본 1MB
    pub fn push(&mut self, bytes: &[u8]);
    pub fn snapshot(&self) -> Vec<u8>;      // 보관 중인 최근 데이터를 순서대로 이어붙임
    pub fn len(&self) -> usize;
}
```

- cap 초과 시 오래된 chunk부터 통째로 evict. escape 시퀀스 중간 절단 가능성은 Spike에서는
  허용하고 한계로 문서화한다(MVP에서 개선 검토).

### 4.3 `mast-core::flow` — backpressure 상태 머신 (계획 v2 2·12장)

```rust
pub enum FlowAction { None, Pause, Resume }
pub struct FlowControl { /* high/low water, pending, paused */ }
impl FlowControl {
    pub fn new(high_water: usize, low_water: usize) -> Self;  // spike 기본 2MB / 512KB
    pub fn on_sent(&mut self, n: usize) -> FlowAction;   // 프론트로 n bytes 보냄
    pub fn on_acked(&mut self, n: usize) -> FlowAction;  // 프론트가 n bytes 소비 완료
    pub fn pending(&self) -> usize;
    pub fn is_paused(&self) -> bool;
}
```

- pending ≥ high → `Pause`, paused 상태에서 pending ≤ low → `Resume`. 나머지 `None`.

### 4.4 `mast-core::session` — PTY 세션 (계획 v2 2·5장)

`portable-pty` 크레이트 사용(Windows에서 ConPTY, Unix에서 표준 PTY — 개발 머신 WSL에서
실제 셸을 띄우는 통합 테스트가 가능해진다).

```rust
pub trait SessionSink: Send + 'static {
    fn on_output(&self, bytes: &[u8]);
    fn on_osc(&self, event: &OscEvent);
    fn on_exit(&self, code: Option<u32>);
}
pub struct SpawnSpec {
    pub program: String, pub args: Vec<String>,
    pub cwd: Option<String>, pub cols: u16, pub rows: u16,
}
pub struct SessionOptions { pub replay_cap: usize, pub high_water: usize, pub low_water: usize }
pub struct PtySession { /* … */ }
impl PtySession {
    pub fn spawn(spec: SpawnSpec, sink: Box<dyn SessionSink>, opts: SessionOptions) -> anyhow::Result<Self>;
    pub fn write(&self, bytes: &[u8]) -> anyhow::Result<()>;
    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()>;
    pub fn ack(&self, n: usize);
    pub fn replay(&self) -> Vec<u8>;
    pub fn stats(&self) -> SessionStats;
    pub fn kill(&self);
}
pub struct SessionManager { /* u32 id → PtySession */ }
pub struct SessionStats {
    pub id: u32, pub bytes_out: u64, pub pending: usize, pub paused: bool,
    pub osc_count: u64, pub last_osc: Option<String>, pub alive: bool,
}
```

- 리더 스레드: PTY read → `OscScanner::feed`(이벤트는 `sink.on_osc`) → `ReplayBuffer::push` →
  `FlowControl::on_sent` → `sink.on_output`. **`Pause`면 PTY read 자체를 중단**(condvar 대기) —
  전달만 멈추면 앱 메모리에 쌓이므로 반드시 읽기를 멈춰 OS 파이프에 backpressure를 넘긴다.
- `ack` → `on_acked` → `Resume`이면 리더 재개.
- `#[cfg(unix)]` 통합 테스트: 실제 `sh` spawn → echo 출력 수신, printf로 OSC 777/9/7 방출 →
  이벤트 수신, flood(무ack) → paused 전환, ack → 재개까지 검증.

### 4.5 `apps/spike/src-tauri` — Tauri 글루

- **터미널 출력은 Tauri v2 raw channel**(`tauri::ipc::Channel`, `InvokeResponseBody::Raw`)로
  ArrayBuffer 전달 — JSON 직렬화 금지(계획 v2 2·12장). OSC 이벤트·exit·stats는 저빈도이므로
  일반 Tauri event(JSON)로 emit.
- commands:
  `create_terminal(cols, rows, on_output: Channel) -> u32` /
  `write_stdin(id, data: String)` / `send_raw(id, bytes: Vec<u8>)` /
  `resize(id, cols, rows)` / `ack_output(id, n)` / `replay(id) -> Vec<u8>` /
  `close_terminal(id)` / `get_stats() -> Vec<SessionStats>`
- spawn 명령: Windows에서 `wsl.exe [-d $MAST_DISTRO] -- bash -l` (env `MAST_DISTRO` 없으면 기본
  배포판), Unix 개발 실행에서는 `$SHELL` 또는 `bash -l`.

### 4.6 `apps/spike/src` — 프론트엔드 (xterm.js)

- xterm 5.x + fit addon. **DOM/WebGL 렌더러 런타임 전환** 버튼(계획 v2 3장 렌더러 비교용).
- scrollback 5000 고정.
- flow control ack: `term.write(chunk, callback)` 완료 콜백에서 소비 바이트 집계,
  **64KB 또는 50ms 배칭**으로 `ack_output` 호출. 배칭 로직은 순수 함수/클래스로 분리해 vitest.
- UI: 툴바(새 터미널 / 렌더러 전환 / stats 토글) + 터미널 CSS grid(1·4·8개 부하 테스트용) +
  stats 패널(1초 폴링, `document.hidden`이면 중단 — idle CPU 0% 원칙) + OSC 이벤트 로그.
- React 등 프레임워크 없이 vanilla TS (Spike 규모에 충분, 메모리 최소).

## 5. 검증 게이트

WSL 자동 게이트 (red면 커밋 없음):

1. `cargo test -p mast-core` — 단위 + unix PTY 통합
2. `cargo clippy -p mast-core --all-targets -- -D warnings`
3. `cargo check -p mast-core --target x86_64-pc-windows-msvc` — 코어의 Windows 호환
4. `npm run build` (tsc + vite) + `npx vitest run` — 프론트엔드
5. `cargo check --workspace --target x86_64-pc-windows-msvc` (src-tauri 포함 전체) —
   tauri-build의 Windows 리소스 임베딩이 `llvm-rc`를 요구한다. sudo 없이 해결:
   `apt-get download llvm-18 libllvm18` + `dpkg -x <deb> ~/.local/llvm` 후
   `~/.local/llvm/usr/lib/llvm-18/bin`을 PATH에, `~/.local/llvm/usr/lib/x86_64-linux-gnu`를
   LD_LIBRARY_PATH에 추가. 이 세션에서 **check·clippy 모두 통과 확인** — src-tauri
   글루도 tauri 2.11.5에 대해 컴파일러 검증됨 (실 빌드·실행 검증은 여전히 Windows).

## 6. Windows Spike 검증 체크리스트 (사용자 수행)

`docs/WINDOWS-BUILD.md`로 빌드 후, 계획 v2 3장 순서대로:

1. **OSC passthrough (최우선)** — WSL 터미널에서 `scripts/wsl/osc-test.sh` 실행 → 앱 OSC 로그에
   777/9/7 각각 표시되는지. **777이 잘리면 계획 v2 2장의 파일/소켓 대안 경로로 전환 결정.**
2. Claude Code 실행·권한 화면, Codex 실행, 방향키/Ctrl+C/Ctrl+D, 복사/붙여넣기.
   툴바 "Replay Check" 버튼으로 `replay` 커맨드(raw Response 경로)가 바이트 수를
   돌려주는지도 확인 (OSC 로그 패널에 표시).
3. 한글 IME — 조합 중 표시 포함. 가로채기 단축키 목록 작성.
4. Flow control — `scripts/wsl/flood.sh` 실행, stats 패널에서 pending 상한·paused 전환 확인,
   RAM 폭주 없음.
5. 렌더러 비교 — DOM/WebGL 각각으로 flood 테스트, CPU·RAM 기록.
6. RAM 측정 — `scripts/win/measure.ps1`로 ①앱만 ②터미널 1개 ③4개 ④8개 ⑤4개+Claude Code 2개
   시나리오별 private working set 기록. 판정: 4패널 ≤100MB 매우 좋음 / 100~150MB 채택 /
   >150MB 최적화 / 최적화 후에도 >150MB → 후보 B 진입.
7. 정리 검증 — 터미널을 모두 닫은 뒤 작업 관리자/Process Explorer에서 mast-spike
   프로세스 트리에 잔존 자식 프로세스·스레드가 없는지 확인 (ConPTY는 kill 후 read가
   안 풀리는 이력이 있는 영역 — Windows에서만 확인 가능).

## 7. 구현 라우팅

사용자 지시에 따라 구현은 저비용 모델 서브 에이전트의 Workflow로 수행한다:

- Scaffold(Sonnet) → 모듈 병렬 구현: core 순수 모듈·core session·프론트엔드·tauri 글루(Opus),
  scripts·docs(Sonnet) → 통합·게이트 green화(Opus) → 게이트 재검증(Sonnet).
- 파일 소유권을 에이전트별로 분리해 충돌 방지. 모듈 간 계약은 이 문서 4장으로 고정.
- 마지막에 `change-critic`(Fable) 점검 → 메인이 findings 필터링·수정.

## 8. 리스크

- ~~**Tauri v2 raw channel API 세부**~~ — 해소: 리뷰에서 tauri 2.11.5 실소스 대조 +
  게이트 5(Windows 타깃 check·clippy)로 컴파일러 검증 완료.
- **ConPTY OSC passthrough** — 계획 v2가 지목한 단일 실패점. 이 세션에서는 검증 불가,
  Windows 체크리스트 1번이 최우선.
- portable-pty의 ConPTY 대 wsl.exe 조합 이슈(입력 인코딩 등)는 Windows 검증에서 드러난다.

## 9. MVP 전 정리 항목 (Spike 검증과 무관, 리뷰에서 식별)

- **core `SessionManager` id 선발급으로 재설계** — 현재 코어는 spawn 후 id를 발급하는
  구조라 sink가 이벤트에 실을 id를 spawn 전에 알 수 없고, 이 때문에 글루가 자체
  `Registry`(id 선발급)로 우회하면서 코어 `SessionManager`가 앱 실경로에서 쓰이지
  않는 중복이 생겼다. MVP에서 코어 API를 id 선발급(sink factory가 id를 받는 형태)으로
  바꾸고 글루 Registry를 제거한다. `PtySession::id`(AtomicU32)도 이때 정리.
- **OSC 스캐너 C0 처리 확장** — CAN/SUB abort는 반영됨. CR/LF 등 나머지 C0의 실터미널
  동작 대조는 MVP에서 검토.
