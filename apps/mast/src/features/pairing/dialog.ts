// 페어링 다이얼로그 — 폰이 열 URL 을 QR 과 텍스트로 보여 준다.
//
// 이 다이얼로그를 여는 것이 **토큰이 렌더러로 건너오는 유일한 경로**다
// (remote_status / secure_remote_status 는 토큰을 싣지 않는다). 그래서 URL 은
// 페어링을 시작할 때 한 번만 받아 오고 어디에도 캐시하지 않는다 — storage 는
// 물론 로그에도 남기지 않는다.
//
// 첫 화면은 Local HTTP / Secure Remote / Tailscale(추후 제공) 세 갈래다.
// - Local HTTP 는 기존 QR·TCP 방화벽 흐름 그대로다 (`remoteFirewall*`).
// - Secure Remote 는 UI 가 만든 pairingId 로 서버를 시작하고, 미접속 상태로
//   화면을 떠날 때(닫기·Back) 즉시 취소한다 — `start` 가 아직 응답하지 않았어도
//   cancel 을 먼저 보내는 것이 Rust 의 취소 tombstone 을 작동시키는 조건이다
//   (`secure_remote.rs`). 인증이 먼저 승인된 연결은 취소가 거절되고 서버가 그
//   연결의 수명에 맡겨지므로, `cancel` 의 `connected` 응답은 "취소됨"이 아니라
//   "연결이 살아 있음"으로 표시한다. UDP 방화벽 커맨드도 TCP 와 분리된
//   `secureRemoteFirewall*` 를 쓴다.
//
// 늦은 응답 규율: 화면을 그릴 때마다 **세대 번호**가 오르고, 비동기 연속은
// `dialog.isConnected && generation === state.generation && mode === state.mode`
// 일 때만 DOM 을 쓴다. 다이얼로그가 닫혔거나 모드가 바뀐 뒤 도착한 start/cancel/
// QR/방화벽 응답은 전부 버려진다 — UAC 처럼 오래 열려 있는 결과가 새 화면을
// 덮지 않게 하는 유일한 가드다.
//
// "연결된 폰이 있다" 안내는 `cancel` 의 `connected` 응답을 계기로 **최신
// `secure_remote_status`(토큰 없는 상태)** 를 다시 조회해 띄운다 — 취소 응답은
// 관측 시점의 스냅샷이라 그 사이 연결이 끝났을 수 있어서다. 그 조회는 시작한 화면
// 세대와 조회 순번에 묶여, 옛 선택 화면의 늦은 결과나 경쟁 조회가 새 화면에 안내를
// 다시 띄우지 못한다. 취소 응답이 안내 자격을 얻는 화면은 취소를 보낸 화면의 바로
// 다음 선택 화면뿐이다 (그 사이 Local HTTP·새 Secure Remote 화면이나 새 페어링이
// 끼면 폐기).
//
// start 가 성공한 Secure 화면은 그때부터 상태를 주기적으로 다시 본다. QR 은 한 번
// 보여 준 120초짜리 비밀이고, 만료·폰 연결·연결 종료는 화면이 아니라 서버가 정하는
// 사건이라 — 다시 보지 않으면 죽은 QR 을 살아 있는 것처럼 계속 띄우게 된다. 감시는
// 화면 세대에 묶여 Back·닫기에서 타이머가 지워진다.
//
// WebView 리로드(F5·유휴 자동 reload)는 `close` 를 거치지 않으므로 `pagehide` 에서
// 대기 중 페어링을 **최선 노력**으로 취소한다. IPC 가 끝나지 않아도 서버의 120초
// 만료가 회수하므로 결과를 기다리지 않는다.
//
// QR 인코더(`uqr`)는 **dynamic import 로만** 들여온다 — 정적으로 import 하면
// 앱을 켤 때마다 아무도 안 쓰는 인코더 바이트를 엔트리 청크로 지고 부팅한다.
//
// 네이티브 `<dialog>` 를 쓰는 이유는 모달 처리(포커스 트랩·Esc 닫기·백드롭)를
// 브라우저가 이미 하기 때문이다.

import {
  isSecureRemoteCommandError,
  remoteFirewallAllow,
  remoteFirewallStatus,
  remotePairing,
  secureRemoteCancel,
  secureRemoteFirewallAllow,
  secureRemoteFirewallStatus,
  secureRemoteStart,
  secureRemoteStatus,
} from "../../infrastructure/backend";
import type {
  AllowOutcome,
  FirewallStatus,
  Pairing,
  SecureRemoteStart,
  SecureRemoteStatus,
} from "../../infrastructure/backend";
import { formatCommandError } from "../../shared/command-error";
import { IS_MAC } from "../../shared/platform";

export type PairingResult =
  | { state: "on"; url: string }
  | { state: "off" }
  | { state: "failed"; reason: string };

/** 설정에 `remote` 키가 없을 때의 안내 (사용자 노출 문자열이라 영어). */
export const REMOTE_OFF_MESSAGE = 'Remote access is off — set "remote" in settings.json';

export function pairingMessage(result: PairingResult): string {
  switch (result.state) {
    case "on":
      return result.url;
    case "off":
      return REMOTE_OFF_MESSAGE;
    default:
      return result.reason;
  }
}

/** reject 는 백엔드가 만든 사유 문자열이라 그대로 쓰고, 문자열이 아닌 것만
 *  공통 포맷터에 넘긴다. 다이얼로그는 주입된 백엔드의 조회 함수를 넘겨 실제 IPC
 *  를 타지 않게 한다 — 기본값은 프로덕션 경로다. */
export async function resolvePairing(
  fetchPairing: () => Promise<Pairing | null> = remotePairing,
): Promise<PairingResult> {
  try {
    const pairing = await fetchPairing();
    return pairing === null ? { state: "off" } : { state: "on", url: pairing.url };
  } catch (error) {
    const reason = typeof error === "string" && error !== "" ? error : formatCommandError(error);
    return { state: "failed", reason };
  }
}

/** Local HTTP(TCP) 방화벽 규칙 이름 — Rust `mast_core::firewall::RULE_NAME` 미러. */
export const LOCAL_HTTP_RULE_NAME = "mast remote (LAN)";

/** Secure Remote(UDP 7331) 규칙 이름 — Rust `SECURE_RULE_NAME` 미러. 두 표면은
 *  같은 포트를 써도 규칙·판정·삭제가 완전히 별개다. */
export const SECURE_REMOTE_RULE_NAME = "mast secure remote (LAN)";
const MACOS_BLOCK_ALL_DETAIL = "Block all incoming connections";

function macFirewallMessage(status: FirewallStatus): string {
  if (status.state === "blocked" && status.detail === MACOS_BLOCK_ALL_DETAIL) {
    return "Block all incoming connections is enabled in macOS Firewall. Allowing this app cannot override it; review Firewall settings in System Settings.";
  }

  switch (status.state) {
    case "allowed":
      return "macOS Firewall allows incoming connections to this app.";
    case "blocked":
      return "macOS Firewall blocks this app from accepting incoming connections.";
    case "missing":
      return "macOS Firewall has no explicit entry for this app. You can add one for incoming connections.";
    case "firewallOff":
      return "macOS Firewall is off; an app rule is not needed.";
    case "unknown":
      return `Could not check macOS Firewall: ${status.detail ?? "unknown error"}`;
    case "stalePath":
    case "profileMismatch":
      return `Could not determine macOS Firewall status (unexpected state: ${status.state}).`;
  }
}

/** currentProfiles 덮어쓰기는 allowed/firewallOff/blocked 에는 적용하지 않는다 —
 *  앞의 둘은 프로필과 무관하고, blocked 는 차단 규칙 이름이 이 상태가 존재하는
 *  이유라 Public 안내에 묻히면 안 된다. ruleName 은 stalePath 안내가 어느 표면의
 *  규칙을 가리키는지 가르는 값이다 (TCP·UDP 규칙 이름이 다르다). */
export function firewallMessage(
  status: FirewallStatus,
  ruleName: string = LOCAL_HTTP_RULE_NAME,
): string {
  if (IS_MAC) return macFirewallMessage(status);

  const { state, port, currentProfiles } = status;
  const detail = status.detail ?? "?";

  if (
    state !== "unknown" &&
    state !== "allowed" &&
    state !== "firewallOff" &&
    state !== "blocked"
  ) {
    if (currentProfiles.length === 0) {
      return "No active network profile — connect to a network first.";
    }
    if (!currentProfiles.includes("Domain") && !currentProfiles.includes("Private")) {
      return "This network is set to Public. Mark it Private in Windows settings; mast never opens a port on public networks.";
    }
  }

  switch (state) {
    case "allowed":
      return `Windows Firewall allows this app on port ${port}.`;
    case "blocked":
      return `A Windows Firewall rule blocks this app: "${detail}". Adding an allow rule will not help — remove that rule (Windows Security › Firewall, or Remove-NetFirewallRule -DisplayName "${detail}").`;
    case "stalePath":
      return `The "${ruleName}" rule points at another copy of the app (${detail}), so the phone cannot connect.`;
    case "profileMismatch":
      return `An allow rule exists, but not for the current network profile (${detail}).`;
    case "missing":
      return `Windows Firewall has no rule allowing this app on port ${port}, so the phone cannot connect.`;
    case "firewallOff":
      return "Windows Firewall is off for the current network — no rule is needed.";
    case "unknown":
      return `Could not check Windows Firewall: ${detail}`;
  }
}

/** unknown 은 프로필 검사 없이 항상 보여준다 — 판정 자체가 실패했으니 시도해
 *  보게 둔다(적용 스크립트는 domain,private 로 고정돼 있어 Public 가드 없이도
 *  안전하다). */
export function firewallActionable(status: FirewallStatus): boolean {
  if (IS_MAC) {
    if (status.state === "allowed" || status.state === "firewallOff") return false;
    if (status.state === "blocked") return status.detail !== MACOS_BLOCK_ALL_DETAIL;
    return true;
  }

  switch (status.state) {
    case "unknown":
      return true;
    case "allowed":
    case "blocked":
    case "firewallOff":
      return false;
    case "missing":
    case "stalePath":
    case "profileMismatch":
      return status.currentProfiles.includes("Domain") || status.currentProfiles.includes("Private");
  }
}

/** allow 결과의 안내. `ruleName` 은 재감지 안내가 어느 표면의 규칙을 가리키는지
 *  가른다 — Secure Remote 의 UDP allow 는 TCP 기본 이름을 말하면 거짓이 된다
 *  (`firewallMessage` 와 같은 이유). */
export function allowOutcomeMessage(
  outcome: AllowOutcome,
  ruleName: string = LOCAL_HTTP_RULE_NAME,
): string {
  if (IS_MAC) {
    const detectedMessage = firewallMessage(outcome.status, ruleName);
    switch (outcome.outcome) {
      case "declined":
        return `Administrator approval was declined. ${detectedMessage}`;
      case "failed":
        return `Could not apply the macOS Firewall change: ${outcome.detail ?? "unknown error"}. ${detectedMessage}`;
      case "applied":
        if (outcome.status.state === "allowed" || outcome.status.state === "firewallOff") {
          return detectedMessage;
        }
        return `macOS Firewall did not confirm the app is allowed. ${detectedMessage}`;
    }
  }

  switch (outcome.outcome) {
    case "declined":
      return "Not applied — the permission prompt was declined.";
    case "failed":
      return `Could not apply: ${outcome.detail}`;
    case "applied":
      if (outcome.status.state === "allowed") return firewallMessage(outcome.status, ruleName);
      return `Windows ran the command, but the rule is not visible yet: ${firewallMessage(outcome.status, ruleName)} (see mast.log for the netsh exit code).`;
  }
}

/** Secure Remote 패널의 설명 — 폰은 QR 의 LAN 주소로 이 PC 에 직접 TLS
 *  (WebTransport) 연결하고, 그 네트워크 밖에서의 도달은 사용자가 만든 별도 경로
 *  (VPN·Tailscale·포트포워딩)가 있을 때만 가능하다. "인터넷에 아무것도 열리지
 *  않는다" 같은 절대 표현은 쓰지 않는다 — 서버는 모든 인터페이스에 바인드하고
 *  (0.0.0.0), 외부 도달 여부는 그 경로와 방화벽이 정한다. QR 의 1회용 토큰과
 *  연결별 인증서 SHA-256, 전체 신뢰 저장소가 아님은 실제 동작이다 (계획 계약). */
export const SECURE_REMOTE_NOTE =
  "The phone connects directly to this PC over TLS (WebTransport) at the LAN address in " +
  "the QR. Reaching it from outside that network needs a separate path you set up — VPN, " +
  "Tailscale or port forwarding. The QR carries a pairing token and the SHA-256 fingerprint " +
  "of a certificate issued for this pairing; the browser trusts that fingerprint for this " +
  "connection only, not the whole trust store.";

/** `cancel` 이 `connected` 를 돌려줬을 때의 안내 — 인증이 먼저 승인된 연결은
 *  취소로 끊기지 않고 그 연결의 수명에 맡겨진다 (서버는 계속 살아 있다). */
export const SECURE_CONNECTED_NOTICE =
  "A phone is connected to Secure Remote. It can reconnect until the certificate expires (up to 14 days) or mast exits.";
export const SECURE_REMEMBERED_NOTICE =
  "No phone is connected right now.";

/** 폰이 QR 을 스캔하기를 기다리는 중 (Secure 화면의 상태 줄). */
export const SECURE_WAITING_TEXT = "Waiting for your phone to scan this QR.";

/** 서버가 페어링을 내리는 중 — 이 창의 QR 은 이미 새 연결을 받지 않는다. */
export const SECURE_STOPPING_TEXT = "The pairing is shutting down…";

/** 만료·연결 종료 뒤의 안내. QR·URL 은 지워진 뒤이고, 새로 시작해야 한다. */
export const SECURE_PAIRING_ENDED_TEXT = "This pairing is closed — go Back and start a new one.";

/** start 성공 뒤 상태 재조회 주기. 120초 창에서 몇 초 안에 만료를 반영하면 된다. */
export const SECURE_STATUS_POLL_MS = 2000;

/** Secure Remote 거절의 사용자 안내문. `{ code, message }` 계약 밖의 값은 공통
 *  포맷터로 보낸다 (가리지 않고 그대로 노출). */
export function secureRemoteErrorText(error: unknown): string {
  if (isSecureRemoteCommandError(error)) {
    switch (error.code) {
      case "busy":
        return "Another pairing is already in progress. Close that dialog if it is still open, or wait up to two minutes for it to expire — then start a new one.";
      case "connected":
        return "This PC already remembers a mobile pairing. Reopen the mast page on that phone, or restart mast to clear the pairing and scan a new QR.";
      case "stopping":
        return "The previous secure pairing is still shutting down. Try again in a moment.";
      case "cancelled":
        return "This pairing was cancelled before it finished starting.";
      case "failed":
        return error.message;
    }
  }
  return formatCommandError(error);
}

/** 다이얼로그가 쓰는 백엔드 커맨드 묶음 — 테스트가 가짜 구현을 주입하는 이음매다
 *  (feature 모듈이 Tauri invoke 를 직접 부르지 않게 한다). */
export interface PairingBackend {
  remotePairing(): Promise<Pairing | null>;
  remoteFirewallStatus(): Promise<FirewallStatus>;
  remoteFirewallAllow(): Promise<AllowOutcome>;
  secureRemoteStatus(): Promise<SecureRemoteStatus>;
  secureRemoteStart(pairingId: string): Promise<SecureRemoteStart>;
  secureRemoteCancel(pairingId: string): Promise<SecureRemoteStatus>;
  secureRemoteFirewallStatus(): Promise<FirewallStatus>;
  secureRemoteFirewallAllow(): Promise<AllowOutcome>;
}

const DEFAULT_BACKEND: PairingBackend = {
  remotePairing,
  remoteFirewallStatus,
  remoteFirewallAllow,
  secureRemoteStatus,
  secureRemoteStart,
  secureRemoteCancel,
  secureRemoteFirewallStatus,
  secureRemoteFirewallAllow,
};

export interface PairingDialogOptions {
  backend?: PairingBackend;
  /** 테스트가 고정 UUID 를 주입하는 결정성 이음매 (실패 주입이 아니다). */
  randomUUID?: () => string;
}

/** 버튼 연타로 다이얼로그가 두 장 겹치지 않게 한다. */
let openDialog: HTMLDialogElement | null = null;

/** 페어링 다이얼로그를 연다. 이미 열려 있으면 null 이다 (main.ts 는 반환값을 쓰지
 *  않는다 — 테스트가 열린 다이얼로그를 잡는 통로일 뿐이다). */
export function openPairingDialog(options: PairingDialogOptions = {}): HTMLDialogElement | null {
  if (openDialog !== null) return null;
  const backend = options.backend ?? DEFAULT_BACKEND;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());

  const dialog = document.createElement("dialog");
  dialog.className = "pairing-dialog";
  openDialog = dialog;

  const heading = document.createElement("h2");
  heading.textContent = "Connect mobile";

  const notice = document.createElement("p");
  notice.className = "pairing-notice";
  notice.hidden = true;

  const body = document.createElement("div");
  body.className = "pairing-body";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "pairing-close";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());

  dialog.append(heading, notice, body, close);

  const state: {
    mode: "choose" | "local" | "secure";
    /** 화면이 바뀔 때마다 오르는 세대 — 늦은 비동기 결과의 폐기 판정. */
    generation: number;
    /** 시작했거나 시작 중인 Secure Remote 페어링 (없으면 null). */
    secure: { pairingId: string; released: boolean } | null;
    /** 마지막으로 시작한 `secure_remote_status` 조회 번호 — 더 새로운 조회가
     *  시작된 뒤 도착한 옛 결과는 안내를 다시 띄우지 못한다. */
    statusQuery: number;
  } = { mode: "choose", generation: 0, secure: null, statusQuery: 0 };

  function isCurrent(generation: number, mode: "choose" | "local" | "secure"): boolean {
    return dialog.isConnected && state.generation === generation && state.mode === mode;
  }

  function setNotice(text: string | null): void {
    if (!dialog.isConnected) return;
    notice.textContent = text ?? "";
    notice.hidden = text === null;
  }

  /** 취소 응답이 안내로 이어질 수 있는 유일한 화면인가 — 취소를 보낸 화면의
   *  **바로 다음** 선택 화면. `showChoice` 는 세대를 정확히 하나 올리므로 세대
   *  비교로 판정한다. 그 사이에 Local HTTP·새 Secure Remote 화면이나 새 페어링이
   *  끼면 늦은 응답은 현재 화면의 사실이 아니므로 폐기된다. */
  function isCancelNoticeScreen(cancelledGeneration: number): boolean {
    return state.mode === "choose" && state.generation === cancelledGeneration + 1;
  }

  /** 아직 살아 있는 미접속 페어링을 취소한다. `start` 가 응답하지 않았어도 즉시
   *  보낸다 — 그래야 Rust 의 tombstone 이 늦은 바인드를 거절한다. 취소 응답이
   *  `connected` 면 인증이 먼저 승인된 연결이라 서버는 그대로 살아 있다. 이때
   *  응답의 스냅샷을 그대로 안내로 쓰지 않고(관측 시점과 표시 시점 사이에 연결이
   *  끝났을 수 있다) 최신 `secure_remote_status` 확인을 거친다. */
  function cancelPendingSecure(): void {
    const secure = state.secure;
    if (secure === null || secure.released) return;
    secure.released = true;
    const pairingId = secure.pairingId;
    const cancelledGeneration = state.generation;
    void backend
      .secureRemoteCancel(pairingId)
      .then((status) => {
        // 포함: `close` 뒤에는 dialog.isConnected 가 거짓이라 결과가 항상 폐기된다.
        if (!dialog.isConnected) return;
        if (status.state !== "connected" && status.state !== "remembered") return;
        // 응답은 특정 페어링의 관측이라, 방금 취소한 그 ID 의 연결일 때만 자격이 있다.
        if (status.pairingId !== pairingId) return;
        if (!isCancelNoticeScreen(cancelledGeneration)) return;
        refreshSecureStatus();
      })
      .catch((error: unknown) => {
        console.debug("[mast] secure remote cancel failed", error);
      });
  }

  dialog.addEventListener("close", () => {
    stopSecureWatch();
    cancelPendingSecure();
    window.removeEventListener("pagehide", onPageHide);
    dialog.remove();
    openDialog = null;
  });

  // WebView 리로드(F5·유휴 자동 reload)는 `close` 를 거치지 않는다 — 그때 대기 중인
  // 페어링을 최선 노력으로 취소한다. 결과를 기다리지 않는다: IPC 가 끝나지 않아도
  // 서버의 120초 만료가 회수한다. 닫힘 경로에서 이미 취소했으면 다시 보내지 않는다.
  function onPageHide(): void {
    const secure = state.secure;
    if (secure === null || secure.released) return;
    secure.released = true;
    void backend.secureRemoteCancel(secure.pairingId).catch(() => undefined);
  }
  window.addEventListener("pagehide", onPageHide);

  /** 화면 전환·닫기에서 지우는 상태 감시 타이머. 조회 자체는 `isCurrent` 가 막는다. */
  let secureWatch: ReturnType<typeof setTimeout> | null = null;

  function stopSecureWatch(): void {
    if (secureWatch === null) return;
    clearTimeout(secureWatch);
    secureWatch = null;
  }

  /** 성공한 start 뒤, 그 화면 세대에 묶인 상태 감시. 조회는 언제나 하나만 나가고
   *  (이전 조회가 정착해야 다음 타이머를 건다) 세대가 바뀌면 스스로 멈춘다. */
  function startSecureWatch(
    generation: number,
    apply: (status: SecureRemoteStatus) => void,
  ): void {
    stopSecureWatch();
    const tick = async (): Promise<void> => {
      secureWatch = null;
      if (!isCurrent(generation, "secure")) return;
      let status: SecureRemoteStatus | null = null;
      try {
        status = await backend.secureRemoteStatus();
      } catch (error) {
        console.debug("[mast] secure_remote_status failed", error);
      }
      if (!isCurrent(generation, "secure")) return;
      if (status !== null) apply(status);
      if (!isCurrent(generation, "secure")) return;
      secureWatch = setTimeout(() => void tick(), SECURE_STATUS_POLL_MS);
    };
    void tick();
  }

  function startScreen(className: string): HTMLDivElement {
    body.replaceChildren();
    const screen = document.createElement("div");
    screen.className = className;
    body.append(screen);
    return screen;
  }

  function qrCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.className = "pairing-qr";
    canvas.hidden = true;
    return canvas;
  }

  function urlText(initial: string): HTMLElement {
    const url = document.createElement("code");
    url.className = "pairing-url";
    url.textContent = initial;
    return url;
  }

  function backButton(onClick: () => void): HTMLButtonElement {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "pairing-back";
    back.textContent = "Back";
    back.addEventListener("click", onClick);
    return back;
  }

  function modeButton(
    mode: string,
    name: string,
    description: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pairing-mode";
    button.dataset.mode = mode;
    const nameEl = document.createElement("span");
    nameEl.className = "pairing-mode-name";
    nameEl.textContent = name;
    const descEl = document.createElement("span");
    descEl.className = "pairing-mode-desc";
    descEl.textContent = description;
    button.append(nameEl, descEl);
    button.addEventListener("click", onClick);
    return button;
  }

  /** 이전 다이얼로그가 접속된 폰을 남기고 닫혔을 수 있다 — 선택 화면에 그 사실을
   *  띄운다. 조회는 **시작 시점의 화면 세대**에 묶고, 마지막으로 시작한 조회만
   *  결과를 쓴다: 옛 선택 화면의 늦은 `connected` 가 새 화면에 안내를 띄우거나,
   *  경쟁 조회가 나중에 안내를 다시 띄우지 못하게 하는 이중 가드다. 이 응답에는
   *  토큰·인증서가 없다(Rust 계약). */
  function refreshSecureStatus(): void {
    const generation = state.generation;
    const query = ++state.statusQuery;
    void backend
      .secureRemoteStatus()
      .then((status) => {
        if (query !== state.statusQuery) return;
        if (!isCurrent(generation, "choose")) return;
        if (status.state === "connected") setNotice(SECURE_CONNECTED_NOTICE);
        if (status.state === "remembered") setNotice(SECURE_REMEMBERED_NOTICE);
      })
      .catch((error: unknown) => {
        console.debug("[mast] secure_remote_status failed", error);
      });
  }

  function showChoice(): void {
    stopSecureWatch();
    state.mode = "choose";
    state.generation += 1;
    const screen = startScreen("pairing-modes");
    // 화면 교체는 포커스가 있던 버튼을 지운다 — 그대로 두면 포커스가 body 로
    // 떨어져 키보드 사용자가 모달 안에서 길을 잃는다. 첫 갈래 버튼으로 되돌린다.
    const local = modeButton(
      "local",
      "Local HTTP",
      "Connect over HTTP. Use on trusted networks only.",
      () => showLocal(),
    );
    screen.append(
      local,
      modeButton(
        "secure",
        "Secure Remote",
        "Encrypted WebTransport to this PC's LAN address.",
        () => showSecure(),
      ),
    );
    const tailscale = modeButton("tailscale", "Tailscale", "Planned. Connect from outside your local network.", () => {});
    tailscale.disabled = true;
    screen.append(tailscale);
    local.focus();
    void refreshSecureStatus();
  }

  function showLocal(): void {
    if (state.mode !== "choose") return;
    stopSecureWatch();
    state.mode = "local";
    // 선택 화면에서 보던 연결 안내는 여기서 지운다 — 다시 필요하면 시작 거절이나
    // 선택 화면 복귀 시의 상태 조회가 새로 알려 준다 (오래된 안내를 남기지 않는다).
    setNotice(null);
    const generation = ++state.generation;
    const screen = startScreen("pairing-local");
    const canvas = qrCanvas();
    const url = urlText("Checking…");
    const back = backButton(() => showChoice());
    screen.append(canvas, url, back);
    // 이 화면의 유일한 동기 컨트롤이다 — allow 버튼은 조회 결과에 따라 나중에 뜬다.
    back.focus();

    void resolvePairing(() => backend.remotePairing()).then((result) => {
      if (!isCurrent(generation, "local")) return;
      url.textContent = pairingMessage(result);
      if (result.state !== "on") return;
      installFirewallSection(screen, {
        status: () => backend.remoteFirewallStatus(),
        allow: () => backend.remoteFirewallAllow(),
        ruleName: LOCAL_HTTP_RULE_NAME,
        isCurrent: () => isCurrent(generation, "local"),
      });
      void drawQr(canvas, result.url)
        .then(() => {
          if (isCurrent(generation, "local")) canvas.hidden = false;
        })
        .catch((error) => {
          // QR 이 없어도 URL 은 화면에 있다 — 손으로 칠 수 있으므로 다이얼로그를
          // 실패로 만들지 않는다.
          console.error("QR render failed", error);
        });
    });
  }

  function showSecure(): void {
    if (state.mode !== "choose") return;
    stopSecureWatch();
    state.mode = "secure";
    setNotice(null);
    const generation = ++state.generation;
    const pairingId = randomUUID();
    state.secure = { pairingId, released: false };

    const screen = startScreen("pairing-secure");
    const canvas = qrCanvas();
    const url = urlText("Starting…");
    const statusLine = document.createElement("p");
    statusLine.className = "pairing-secure-status";
    statusLine.hidden = true;
    const note = document.createElement("p");
    note.className = "pairing-secure-note";
    note.textContent = SECURE_REMOTE_NOTE;
    const errorLine = document.createElement("p");
    errorLine.className = "pairing-error";
    errorLine.hidden = true;
    const back = backButton(() => {
      cancelPendingSecure();
      showChoice();
    });
    screen.append(canvas, url, statusLine, note, errorLine, back);
    // QR·URL 은 정보이고, 이 화면의 동기 컨트롤은 Back 이다 (allow 는 조회 뒤에 뜬다).
    back.focus();

    /** QR·URL 제거는 한 방향이다 — 만료·연결 뒤에 도착한 `waiting`(재생·경합)이
     *  죽은 QR 을 되살리지 못한다. URL 은 1회용 토큰을 품고 있으므로 함께 지운다. */
    let qrRemoved = false;
    function removeQr(): void {
      if (qrRemoved) return;
      qrRemoved = true;
      canvas.hidden = true;
      canvas.width = 0;
      canvas.height = 0;
      url.textContent = "";
    }
    function setStatus(text: string): void {
      statusLine.textContent = text;
      statusLine.hidden = false;
    }
    /** 서버가 정하는 사건을 화면에 반영한다 — 이 화면의 페어링 ID 와 다르거나 이미
     *  끝난 상태면 이 창의 QR 은 더 이상 새 연결을 받지 못한다. */
    function applyStatus(status: SecureRemoteStatus): void {
      if (status.pairingId === pairingId && (status.state === "connected" || status.state === "remembered")) {
        removeQr();
        setStatus(status.state === "connected" ? SECURE_CONNECTED_NOTICE : SECURE_REMEMBERED_NOTICE);
        return;
      }
      if (status.pairingId === pairingId && !qrRemoved) {
        switch (status.state) {
          case "starting":
          case "waiting":
            setStatus(SECURE_WAITING_TEXT);
            return;
          case "connected":
            removeQr();
            setStatus(SECURE_CONNECTED_NOTICE);
            return;
          default:
            break;
        }
      }
      removeQr();
      switch (status.state) {
        case "stopping":
          setStatus(SECURE_STOPPING_TEXT);
          return;
        case "failed":
          setStatus(
            status.reason === null ? "The pairing failed." : `The pairing failed: ${status.reason}`,
          );
          return;
        default:
          // idle(만료·폰 연결 종료), 그리고 이 창의 것이 아닌 페어링 상태.
          setStatus(SECURE_PAIRING_ENDED_TEXT);
      }
    }

    // start 는 선택당 정확히 한 번이다. 재시도는 Back 뒤 새 선택(= 새 UUID)으로
    // 가는 것이고, 같은 ID 재시작은 Rust 가 cancelled 로 거절한다.
    void backend.secureRemoteStart(pairingId).then(
      (started) => {
        if (!isCurrent(generation, "secure")) return;
        url.textContent = started.url;
        installFirewallSection(screen, {
          status: () => backend.secureRemoteFirewallStatus(),
          allow: () => backend.secureRemoteFirewallAllow(),
          ruleName: SECURE_REMOTE_RULE_NAME,
          isCurrent: () => isCurrent(generation, "secure"),
        });
        void drawQr(canvas, started.url)
          .then(() => {
            // 감시가 먼저 만료를 봤다면 QR 을 되살리지 않는다 (그리기는 비동기다).
            if (isCurrent(generation, "secure") && !qrRemoved) canvas.hidden = false;
          })
          .catch((error) => {
            console.error("QR render failed", error);
          });
        startSecureWatch(generation, applyStatus);
      },
      (error: unknown) => {
        if (!isCurrent(generation, "secure")) return;
        url.textContent = "Not started.";
        errorLine.textContent = secureRemoteErrorText(error);
        errorLine.hidden = false;
      },
    );
  }

  document.body.append(dialog);
  dialog.showModal();
  showChoice();
  return dialog;
}

/** resolvePairing·secureRemoteErrorText 와 같은 규칙 — 문자열이면 그대로, 아니면
 *  공통 포맷터로. */
function firewallErrorMessage(error: unknown): string {
  return typeof error === "string" && error !== "" ? error : formatCommandError(error);
}

interface FirewallSectionOptions {
  status: () => Promise<FirewallStatus>;
  allow: () => Promise<AllowOutcome>;
  ruleName: string;
  isCurrent: () => boolean;
}

/** 페어링이 시작된 화면에 방화벽 안내와 allow 버튼을 끼운다. `isCurrent` 가
 *  거짓이 된 뒤의 응답(늦은 조회·사용자가 답할 때까지 열려 있던 UAC 결과)은 DOM 에
 *  쓰지 않는다 — 모드 전환·닫힘 뒤 옛 화면을 덮지 않게 하는 가드다. allow 는
 *  **버튼 클릭에서만** 불린다 (시작 경로는 UAC 를 띄우지 않는다). */
function installFirewallSection(screen: HTMLElement, options: FirewallSectionOptions): void {
  const line = document.createElement("p");
  line.className = "pairing-firewall";
  line.textContent = IS_MAC ? "Checking macOS Firewall…" : "Checking Windows Firewall…";

  const allow = document.createElement("button");
  allow.type = "button";
  allow.className = "pairing-allow";
  allow.textContent = IS_MAC ? "Allow in macOS Firewall" : "Allow in Windows Firewall";
  allow.hidden = true;

  screen.append(line, allow);
  if (IS_MAC) {
    const note = document.createElement("p");
    note.className = "pairing-firewall-note";
    note.textContent =
      "This app rule covers both Local HTTP (TCP) and Secure Remote (UDP). Only add it on networks you trust.";
    screen.append(note);
  }

  allow.addEventListener("click", () => {
    allow.disabled = true;
    line.textContent = IS_MAC ? "Waiting for administrator approval…" : "Waiting for Windows…";
    void (async () => {
      try {
        const outcome = await options.allow();
        if (!options.isCurrent()) return;
        line.textContent = allowOutcomeMessage(outcome, options.ruleName);
        allow.hidden = !firewallActionable(outcome.status);
      } catch (error) {
        if (!options.isCurrent()) return;
        line.textContent = firewallErrorMessage(error);
      } finally {
        if (options.isCurrent()) allow.disabled = false;
      }
    })();
  });

  void (async () => {
    try {
      const status = await options.status();
      if (!options.isCurrent()) return;
      line.textContent = firewallMessage(status, options.ruleName);
      allow.hidden = !firewallActionable(status);
    } catch (error) {
      if (!options.isCurrent()) return;
      line.textContent = firewallErrorMessage(error);
    }
  })();
}

/** 모듈 하나의 변이 이보다 작으면 카메라가 못 읽는다. */
const MIN_MODULE_PX = 3;
/** 단위는 CSS px. */
const TARGET_PX = 260;

async function drawQr(canvas: HTMLCanvasElement, text: string): Promise<void> {
  const { encode } = await import("uqr");
  // border 는 quiet zone 이다. uqr 기본값은 1 모듈인데 QR 규격은 4를 요구하고,
  // 좁으면 카메라가 코드 경계를 못 찾는다.
  const qr = encode(text, { border: 4 });
  const scale = Math.max(MIN_MODULE_PX, Math.floor(TARGET_PX / qr.size));
  const side = qr.size * scale;
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no 2d context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = "#000000";
  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      if (qr.data[row][col]) ctx.fillRect(col * scale, row * scale, scale, scale);
    }
  }
}
