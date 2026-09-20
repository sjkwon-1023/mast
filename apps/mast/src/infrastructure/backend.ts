// Tauri 백엔드 커맨드·이벤트 계약 래퍼 (10단계 계획 3-C).
// 커맨드 인자 키는 Tauri v2 기본 규칙(JS camelCase → Rust snake_case)을 따른다.
// write_stdin/send_raw/resize/ack_output/get_stats 는 spike 글루의 이식이라
// 인자 이름(id)·DTO(snake_case)를 그대로 유지하고, dispatch/get_state/
// attach_terminal 은 10단계 신규 계약이다.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import type { Command, CommandOutput, SessionId, StateSnapshot, TabId } from "../shared/types";

/** 터미널 출력 채널 메시지 — raw channel 은 ArrayBuffer 를 주지만, 구현 차이에
 *  대비해 Uint8Array 도 수용한다. 소비 측(features/terminal/frame.ts)에서 정규화한다. */
export type OutputChunk = ArrayBuffer | Uint8Array;

/** src-tauri SessionStats DTO (serde 기본 — Rust 필드명 snake_case 그대로). */
export interface SessionStats {
  id: number;
  bytes_out: number;
  pending: number;
  paused: boolean;
  osc_count: number;
  last_osc: string | null;
  alive: boolean;
}

/** 구조 변이 명령을 dispatch 한다. 성공 시 백엔드가 state-changed 를 emit 하므로
 *  호출자는 반환값(생성 id)만 쓰고 상태 갱신은 store 구독으로 받는다.
 *  실패는 CommandError 직렬화 payload 로 reject 된다. */
export function dispatch(cmd: Command): Promise<CommandOutput> {
  return invoke<CommandOutput>("dispatch", { cmd });
}

/** 부트스트랩용 전체 상태 스냅샷. */
export function getState(): Promise<StateSnapshot> {
  return invoke<StateSnapshot>("get_state");
}

/** 기존 PTY 세션에 attach 한다. **호출 전에 onOutput 채널의 onmessage 를 먼저
 *  걸어야 한다** (채널 먼저·reattach 나중 — 코어 session.rs reattach 계약).
 *  응답은 raw body `[u64 LE end_offset][u8 first_attach][replay bytes]` —
 *  features/terminal/frame.ts 의 parseAttachBody(ATTACH_HEADER_BYTES=9)가 정본이다. */
export function attachTerminal(
  session: SessionId,
  onOutput: Channel<OutputChunk>,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("attach_terminal", { session, onOutput });
}

/** 출력 채널 분리 — 뷰 dispose(탭 전환 등) 시. 세션은 계속 돌고 출력은 Dropped
 *  (detach 모드)로 replay 에만 쌓인다 — 채널을 남겨두면 Delivered-무ack 로 pending
 *  이 쌓여 백그라운드 세션이 paused 에 고착된다. */
export function detachTerminal(session: SessionId): Promise<void> {
  return invoke<void>("detach_terminal", { session });
}

/** 셸이 끝난 탭의 마지막 화면 기록을 읽는다 (ADR-0018). 응답은 attachTerminal ·
 *  fsReadChunk 와 같은 raw body — 기록 파일의 바이트 그대로이고, 파일이 없으면
 *  **빈 버퍼**다 (에러가 아니다: 기록이 지워졌거나 아무 것도 출력하지 않은 셸의
 *  정상 경로다). */
export function readTabRecord(tab: TabId): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_tab_record", { tab });
}

/** 시작 표식이 오지 않은 탭에 셸을 다시 띄운다 (pane 배너의 Retry). 실패는
 *  CommandError 로 reject 되며, 그 경우에도 백엔드가 상태를 강등해 publish 한다. */
export function respawnTab(tab: TabId): Promise<SessionId> {
  return invoke<SessionId>("respawn_tab", { tab });
}

/** 사용자 입력(문자열)을 PTY stdin 으로 보낸다. */
export function writeStdin(id: SessionId, data: string): Promise<void> {
  return invoke<void>("write_stdin", { id, data });
}

/** 임의 바이트열을 PTY stdin 으로 보낸다 (제어 시퀀스 테스트용). */
export function sendRaw(id: SessionId, bytes: number[]): Promise<void> {
  return invoke<void>("send_raw", { id, bytes });
}

/** PTY 창 크기 변경 (자식에게 SIGWINCH 전달). */
export function resizeTerminal(id: SessionId, cols: number, rows: number): Promise<void> {
  return invoke<void>("resize", { id, cols, rows });
}

/** flow control ack — 프론트가 소비 완료한 바이트 수를 백엔드에 알린다. */
export function ackOutput(id: SessionId, n: number): Promise<void> {
  return invoke<void>("ack_output", { id, n });
}

/** 전체 세션 stats 조회 (진단용). */
export function getStats(): Promise<SessionStats[]> {
  return invoke<SessionStats[]>("get_stats");
}

/** src-tauri `Diagnostics` DTO (ADR-0018) — 필드명은 camelCase (serde rename_all).
 *  `process` 는 Windows 가 아니면 null 이고, Windows 에서도 개별 조회가 거부되면 그
 *  필드만 null 이다 — 못 잰 값을 0 으로 채우지 않는 백엔드 계약의 미러다. */
export interface Diagnostics {
  process: {
    privateBytes: number | null;
    workingSetBytes: number | null;
    handleCount: number | null;
    threadCount: number | null;
  } | null;
  sessions: { registered: number; alive: number; sinks: number; replayBytes: number };
  tabs: { running: number; exited: number; notStarted: number };
  audit: {
    orphanSessions: number[];
    orphanSinks: number[];
    /** `[탭 id, 세션 id]` — 탭이 참조하는 세션이 레지스트리에 없었다는 뜻이고,
     *  백엔드가 그 탭을 이미 exited 로 수리한 뒤의 보고다. */
    danglingTabs: [number, number][];
  };
}

/** 백엔드 자원 진단 (dev 훅 window.__mast.diagnostics 전용 — UI 표면 없음).
 *  호출 때마다 모델 ↔ 레지스트리 정합성 검사가 한 번 돌고, 그 결과 반영 뒤의
 *  수치가 온다. 주기 폴링으로 쓰지 않는다 — Toolhelp 스레드 스냅샷은 전 시스템
 *  분량이라 싸지 않다. */
export function getDiagnostics(): Promise<Diagnostics> {
  return invoke<Diagnostics>("get_diagnostics");
}

/** 활동 핑 (16단계 C-3) — throttled 사용자 입력 신호. `visible` 은
 *  visibilitychange 보조 신호(즉시), 순수 활동 핑은 null. 백엔드 자동 리셋
 *  정책의 idle·hidden 타이머를 재무장한다. */
export function userActivity(visible: boolean | null): Promise<void> {
  return invoke<void>("user_activity", { visible });
}

/** 수동 WebView 리셋 — dev 훅(window.__mast.resetUi) 전용, UI 버튼 금지
 *  (계획 v2 12장). 백엔드가 WebView 를 reload 한다 — location.reload() 와 달리
 *  자동 리셋과 같은 경로(perform_reset)를 검증할 수 있다. */
export function resetUi(): Promise<void> {
  return invoke<void>("reset_ui");
}

/** needsInput OS 토스트 — 제목·본문 그대로 Windows 알림 하나를 띄운다.
 *  **언제 부를지의 판정은 호출측(app/main.ts notifyNeedsInput) 계약이다**: 탭 단위
 *  needsInput 상승 전이 중 지금 화면에 보이지 않는 워크스페이스의 것(비포커스 전체 +
 *  포커스 중 비활성 워크스페이스)마다 부른다. 실패는 사유 문자열로 reject 되고
 *  호출측은 console 로만 남긴다 — 알림 하나가 UI 동작을 막지 않는다. 백엔드도 같은
 *  시도를 `%APPDATA%\app.mast.desktop\toast.log` 에 제목 대신 `logLabel` 로 한 줄
 *  남기므로, 실패가 조용히 사라지지는 않는다 (commands.rs notify_toast). */
export function notifyToast(title: string, body: string, logLabel: string): Promise<void> {
  return invoke<void>("notify_toast", { title, body, logLabel });
}

// --- UI 설정 (settings.json) --------------------------------------------------

/** 백엔드 `UiSettings` 의 프론트 미러 — 필드명은 camelCase 계약(Rust 쪽
 *  `serde(rename_all = "camelCase")`)이고, 사용자가 손으로 쓰는 settings.json 의
 *  키와 같은 이름이다. **null = 미설정**이라 그 항목은 기본값을 그대로 쓴다. */
export interface UiSettings {
  /** xterm fontFamily — CSS font-family 문자열. */
  fontFamily: string | null;
  /** xterm fontSize (px). 백엔드가 6~72 범위를 강제한다 (밖이면 reject). */
  fontSize: number | null;
  /** 텍스트 뷰어에서 구문 하이라이팅을 켤 언어 이름 목록. 지원 목록 밖의 이름은
   *  백엔드가 reject 한다 (fontFamily·fontSize 와 같은 loud-fail). **빈 배열은
   *  "하이라이팅 끄기"** 라는 유효한 설정이고, null 은 미설정이라 프론트의 기본
   *  목록(features/viewers/text/settings.ts DEFAULT_HIGHLIGHT_LANGUAGES)을 쓴다. */
  highlightLanguages: string[] | null;
  /** 런타임 로그 파일을 켤지. null·false 는 꺼진 것이고, 그때 프론트는 로그를
   *  **부르지 않을 뿐 아니라 진단 리스너를 설치조차 하지 않는다** (infrastructure/logging.ts). */
  log: boolean | null;
  /** 탭 제목 옆에 그 탭의 안정 `Tab.id`(`#12` — `mast ls`/`mast send '#<id>'` 의
   *  주소)를 보여 줄지. **null(키 없음)은 표시가 기본값**이라 프론트가 true 로
   *  해석하고, `false` 만 숨긴다 — 기본값이 "켜짐"인 이유는 이 배지가 그 주소를
   *  화면에서 읽을 수 있는 유일한 표면이라서다. 부팅 때 한 번만 반영된다. */
  showTabIds: boolean | null;
  /** LAN 원격 표면. **키가 있으면 켜진 것**이고 port 는 필수다 — 백엔드가
   *  1024~65535 밖을 fontSize 와 같은 자리에서 reject 한다. null 은 미설정이고
   *  그때는 리스너·스레드·토큰 파일이 아예 생기지 않는다. */
  remote: RemoteSettings | null;
}

export interface RemoteSettings {
  port: number;
}

/** 앱 설정 디렉터리의 settings.json 을 읽는다. **파일이 없으면 전부 null 인
 *  기본값**이고(에러 아님), 파싱 실패·범위 밖 폰트 크기는 사유 문자열로 reject
 *  된다 — 호출자는 그 사유를 표면화하고 기본값으로 진행한다 (가라 기본값으로
 *  가리지 않는다). */
export function getUiSettings(): Promise<UiSettings> {
  return invoke<UiSettings>("get_ui_settings");
}

/** 런타임 로그 파일에 한 줄 남긴다 — 로그가 꺼져 있으면 백엔드가 no-op 이지만,
 *  프론트도 꺼져 있으면 애초에 부르지 않는다 (infrastructure/logging.ts 의 설치 규율). 실패는
 *  던지지 않는다: 로그를 남기려다 기능이 죽으면 본말전도다. */
export function logLine(text: string): Promise<void> {
  return invoke<void>("log_line", { text });
}

// --- LAN 원격 표면 (ADR-0016 결정 9) -----------------------------------------------

/** 서버의 현재 상태. `off` 는 설정에 `remote` 키가 없다는 뜻이고, `failed` 는
 *  켜기를 시도했으나 바인드·토큰에서 실패했다는 뜻이라 `reason` 이 온다.
 *  **토큰은 절대 실리지 않는다** — 페어링 URL 은 별도 커맨드로만 나온다. */
export interface RemoteStatus {
  state: "off" | "on" | "failed";
  port: number | null;
  reason: string | null;
}

/** 페어링 URL — `http://<lan-ip>:<port>/#t=<token>`. fragment 라 요청에 실리지
 *  않는다 (폰 페이지가 받아 localStorage 로 옮기고 주소창에서 지운다). */
export interface Pairing {
  url: string;
}

/** 원격 표면 상태 조회. **설정과 무관하게 부팅 시 한 번 부른다** — settings.json
 *  은 webview 초기화마다 다시 읽히지만 서버는 앱 부팅 때 한 번 정해지므로,
 *  설정으로 게이트하면 "설정은 켜져 있는데 서버는 실패로 안 뜬 상태"를 놓친다.
 *  실패하지 않는다 (Result 가 아니다). */
export function remoteStatus(): Promise<RemoteStatus> {
  return invoke<RemoteStatus>("remote_status");
}

/** 페어링 URL 조회 — **다이얼로그를 열 때만** 부른다 (토큰이 렌더러로 건너오는
 *  유일한 경로다). 꺼져 있으면 null, 켜기에 실패했으면 사유로 reject 된다. */
export function remotePairing(): Promise<Pairing | null> {
  return invoke<Pairing | null>("remote_pairing");
}

/** Windows 방화벽에서 이 앱의 상태 (ADR-0016 amendment — 페어링 다이얼로그가
 *  감지해 보여 준다). COM 조회는 비관리자 권한으로 끝나므로 UAC 없이 즉시 온다. */
export interface FirewallStatus {
  state:
    | "allowed"
    | "blocked"
    | "stalePath"
    | "profileMismatch"
    | "missing"
    | "firewallOff"
    | "unknown";
  /** state 별 부가 정보 — stalePath: 옛 exe 경로, blocked: 차단 규칙 이름,
   *  profileMismatch: 현재 활성 프로필 이름들, unknown: 오류 문장. 그 외 null. */
  detail: string | null;
  exe: string;
  port: number;
  /** 현재 활성 프로필 — "Domain" | "Private" | "Public" 의 부분집합. */
  currentProfiles: string[];
}

/** remote_firewall_allow 시도 결과. */
export interface AllowOutcome {
  outcome: "applied" | "declined" | "failed";
  /** failed 일 때의 사유. 그 외 null. */
  detail: string | null;
  /** 시도 뒤 재감지한 상태 — outcome 과 무관하게 항상 온다. */
  status: FirewallStatus;
}

/** Windows 방화벽 상태 조회 (비관리자, COM `INetFwPolicy2`). 원격 표면이
 *  off/failed 면 사유 문자열로 reject 된다. */
export function remoteFirewallStatus(): Promise<FirewallStatus> {
  return invoke<FirewallStatus>("remote_firewall_status");
}

/** Windows 방화벽에 allow 규칙을 적용 시도한다 — UAC 프롬프트가 뜨고, 사용자가
 *  답할 때까지 resolve 되지 않는다(상한 없음). 원격 표면이 off/failed 면 사유
 *  문자열로 reject 된다. */
export function remoteFirewallAllow(): Promise<AllowOutcome> {
  return invoke<AllowOutcome>("remote_firewall_allow");
}

// --- Secure Remote (WebTransport) ----------------------------------------------
// src-tauri `secure_remote.rs` 의 계약 미러. Local HTTP 와 달리 이 표면은 설정과
// 무관하게 **시작할 때만** UDP 리스너·TLS 자원을 연다. token·cert hash·개인키는
// 어떤 응답에도 싣지 않는다 (QR URL 은 성공한 start 응답에만 있다).

/** 서버 상태 — Rust `SecureRemoteStatus.state` 그대로. `idle` 은 서버 없음,
 *  `waiting` 은 폰 접속 대기, `connected` 는 인증된 폰이 붙어 있는 상태다. */
export type SecureRemoteState =
  | "idle"
  | "starting"
  | "waiting"
  | "connected"
  | "remembered"
  | "stopping"
  | "failed";

/** `secure_remote_status` / `secure_remote_cancel` 의 응답. `pairingId` 는 그
 *  상태가 가리키는 페어링(없으면 null), `reason` 은 `failed` 의 사유다. */
export interface SecureRemoteStatus {
  state: SecureRemoteState;
  pairingId: string | null;
  reason: string | null;
}

/** 성공한 `secure_remote_start` 의 응답 — QR URL 은 이 응답에만 실린다. */
export interface SecureRemoteStart {
  state: "waiting";
  pairingId: string;
  url: string;
}

/** Secure Remote 커맨드 거절 코드. `busy` 는 다른 페어링 진행 중, `connected` 는
 *  이미 폰이 붙어 있음, `stopping` 은 이전 종료 미완, `cancelled` 는 이 ID 가
 *  취소됨, `failed` 는 생성 실패(message 에 사유)다. */
export type SecureRemoteRejectCode = "busy" | "connected" | "stopping" | "cancelled" | "failed";

/** 커맨드 reject payload — Rust `SecureRemoteCommandError` 의 직렬화 형태다. */
export interface SecureRemoteCommandError {
  code: SecureRemoteRejectCode;
  message: string;
}

/** reject payload 를 방어적으로 좁힌다. IPC 레벨 실패 등 계약 밖 값이 올 수
 *  있으므로 호출자는 이 가드가 false 면 공통 포맷터로 보낸다. */
export function isSecureRemoteCommandError(error: unknown): error is SecureRemoteCommandError {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    typeof message === "string" &&
    (code === "busy" ||
      code === "connected" ||
      code === "stopping" ||
      code === "cancelled" ||
      code === "failed")
  );
}

/** Secure Remote 수명 상태 조회 — 비밀은 실리지 않으므로 언제든 부를 수 있다. */
export function secureRemoteStatus(): Promise<SecureRemoteStatus> {
  return invoke<SecureRemoteStatus>("secure_remote_status");
}

/** QR 페어링 시작. `pairingId` 는 UI 가 만든 UUID 다 — 같은 ID 로 두 번 시작할
 *  수 없다(취소된 ID 는 tombstone 으로 거절된다). 바인드가 끝난 뒤에만 URL 이 온다. */
export function secureRemoteStart(pairingId: string): Promise<SecureRemoteStart> {
  return invoke<SecureRemoteStart>("secure_remote_start", { pairingId });
}

/** 페어링 취소 — 적용 뒤의 상태를 그대로 돌려준다. 인증이 먼저 승인된 연결은
 *  `connected` 로 돌아오고 서버는 그 연결의 수명에 맡겨진다. */
export function secureRemoteCancel(pairingId: string): Promise<SecureRemoteStatus> {
  return invoke<SecureRemoteStatus>("secure_remote_cancel", { pairingId });
}

/** Secure Remote UDP 7331 전용 방화벽 판정 — TCP 커맨드와 완전히 별개다. */
export function secureRemoteFirewallStatus(): Promise<FirewallStatus> {
  return invoke<FirewallStatus>("secure_remote_firewall_status");
}

/** Secure Remote UDP 규칙 생성 — **사용자가 버튼을 누를 때만** 부른다 (UAC 는
 *  사용자가 답할 때까지 resolve 되지 않는다). */
export function secureRemoteFirewallAllow(): Promise<AllowOutcome> {
  return invoke<AllowOutcome>("secure_remote_firewall_allow");
}

// --- 뷰어 파일 접근 (21단계) --------------------------------------------------
// folderBrowser·textViewer 가 쓰는 읽기 전용 커맨드 3종. 백엔드가 Windows 에서
// \\wsl.localhost UNC 로 접근하므로 프론트는 항상 **리눅스 경로**를 넘긴다.
// distro 는 워크스페이스 설정값(없으면 null) — 백엔드가 null 이면 MAST_DISTRO,
// 그것도 없으면 WSL 기본 배포판으로 해석한다 (commands.rs resolve_distro).
// DTO 필드명은 글루 DTO 관례(SessionStats 와 동일)대로 snake_case 그대로다.

/** fs_list_dir 의 디렉터리 항목. size 는 디렉터리이거나 조회 실패면 null. */
export interface DirEntry {
  name: string;
  is_dir: boolean;
  size: number | null;
}

/** fs_list_dir 응답. entries 는 **정렬되지 않은** fs 순서 — dirs-first·name asc
 *  정렬은 프론트 순수 함수 몫이다. truncated 면 5,000 항목 상한에서 잘렸다. */
export interface DirListing {
  entries: DirEntry[];
  truncated: boolean;
}

/** fs_stat 응답 — 링크를 따라간 최종 대상 기준. */
export interface FileStat {
  size: number;
  mtime_ms: number;
  is_dir: boolean;
}

/** 디렉터리 목록 (folderBrowser). 존재하지 않는 경로·권한 실패는 reject 된다 —
 *  호출자는 인라인 에러로 표시하고 탭은 유지한다. */
export function fsListDir(distro: string | null, path: string): Promise<DirListing> {
  return invoke<DirListing>("fs_list_dir", { distro, path });
}

/** 파일 크기·수정시각 조회 (윈도우 계산·mtime 폴링). */
export function fsStat(distro: string | null, path: string): Promise<FileStat> {
  return invoke<FileStat>("fs_stat", { distro, path });
}

/** 파일의 바이트 윈도우 읽기 (textViewer). 응답은 attachTerminal 과 같은 raw
 *  body — ArrayBuffer 로 온다 (JSON·base64 왕복 없음). len 은 4MiB 상한이고
 *  넘기면 거부된다. EOF 를 넘는 offset 은 빈 버퍼(에러 아님)다. */
export function fsReadChunk(
  distro: string | null,
  path: string,
  offset: number,
  len: number,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("fs_read_chunk", { distro, path, offset, len });
}

// Changes 뷰어의 읽기 전용 Git 명령이다. 저장소 탐색·상태 파싱·프로세스 제한·diff
// 생성은 백엔드가 소유하고, 뷰어는 여기서 받은 제한된 DTO만 그린다.
export interface GitChange {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  root: string;
  unborn: boolean;
  entries: GitChange[];
  truncated: boolean;
}

export type GitDiffScope = "working" | "staged" | "all";

export interface GitDiffRequest {
  root: string;
  path: string;
  originalPath: string | null;
  scope: GitDiffScope;
  untracked: boolean;
  unborn: boolean;
}

export interface GitDiff {
  text: string;
  truncated: boolean;
}

/** Changes 뷰어에 보여 줄 저장소 상태 스냅샷을 읽는다. */
export function gitStatus(distro: string | null, path: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { distro, path });
}

/** 상태 항목 하나의 제한된 unified diff를 읽는다. */
export function gitDiff(
  distro: string | null,
  request: GitDiffRequest,
): Promise<GitDiff> {
  return invoke<GitDiff>("git_diff", { distro, request });
}

// --- 워크스페이스 폴더 선택 --------------------------------------------------

/** pick_workspace_folder 응답 — DTO 필드명은 글루 관례(snake_case) 그대로다. */
export interface PickedFolder {
  /** 워크스페이스 rootPath 로 그대로 쓰는 리눅스 절대 경로. */
  linux_path: string;
  /** \\wsl.localhost UNC 를 골랐을 때의 배포판. 드라이브 경로(/mnt/c/...)면 null
   *  이고, 그때는 백엔드의 기존 기본 배포판 해석을 탄다. */
  distro: string | null;
  /** 이름 기본값 — 고른 폴더의 마지막 세그먼트. */
  name: string;
}

/** Windows 네이티브 폴더 선택 대화상자를 연다. **취소는 null** (에러가 아니다).
 *  리눅스 경로로 되돌릴 수 없는 선택(네트워크 UNC 등)과 Windows 아닌 dev 실행은
 *  reject 된다 — 호출자가 상태 라인에 표시한다. */
export function pickWorkspaceFolder(): Promise<PickedFolder | null> {
  return invoke<PickedFolder | null>("pick_workspace_folder");
}

/** URL 을 Windows 기본 브라우저로 넘긴다 (터미널 링크 클릭 — ADR-0012).
 *  http/https 만 허용하며, 판정은 프런트와 백엔드 양쪽에서 한다 — 이 커맨드는
 *  webview 안의 어떤 코드에서도 부를 수 있으므로 프런트의 검사만으로는 계약이
 *  아니다. 거부·실패는 reject 되며, 지금 유일한 호출자(terminal-view)는 콘솔에만
 *  남긴다 — 클릭 한 번의 실패를 화면 앞에 세울 만큼의 사건으로 보지 않는다
 *  (ADR-0012 consequence). */
export function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

/** 업데이트 확인 결과 — 네이티브 부팅 확인의 캐시를 읽는 프론트 계약이다.
 *  checked 가 false 여도 currentVersion 은 즉시 표시할 수 있다. */
export interface UpdateInfo {
  currentVersion: string;
  newerVersion: string | null;
  checked: boolean;
}

/** 네이티브가 한 번 확인해 둔 업데이트 결과를 읽는다. 네트워크를 시작하지 않는다. */
export function getUpdateInfo(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("get_update_info");
}

/** 업데이트 확인이 끝났을 때 네이티브가 보내는 이벤트를 구독한다. */
export function onUpdateChecked(handler: (info: UpdateInfo) => void): Promise<UnlistenFn> {
  return listen<UpdateInfo>("update-checked", (event) => handler(event.payload));
}

/** state-changed 구독 헬퍼 — 변이마다 전체 스냅샷(revision 포함)이 온다.
 *  stale 판정(revision 가드)은 store 몫이다. */
export function onStateChanged(
  handler: (snapshot: StateSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<StateSnapshot>("state-changed", (event) => handler(event.payload));
}

export function fsSaveMarkdown(distro: string | null, path: string, expected: string, content: string): Promise<void> {
  return invoke<void>("fs_save_markdown", { distro, path, expected, content });
}
