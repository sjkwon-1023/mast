// 페어링 다이얼로그 — 폰이 열 URL 을 QR 과 텍스트로 보여 준다.
//
// 이 다이얼로그를 여는 것이 **토큰이 렌더러로 건너오는 유일한 경로**다
// (remote_status 는 토큰을 싣지 않는다). 그래서 URL 은 열 때 한 번만 받아 오고
// 어디에도 캐시하지 않는다.
//
// QR 인코더(`uqr`)는 **dynamic import 로만** 들여온다 — 정적으로 import 하면
// 앱을 켤 때마다 아무도 안 쓰는 인코더 바이트를 엔트리 청크로 지고 부팅한다.
//
// 네이티브 `<dialog>` 를 쓰는 이유는 모달 처리(포커스 트랩·Esc 닫기·백드롭)를
// 브라우저가 이미 하기 때문이다.

import { remoteFirewallAllow, remoteFirewallStatus, remotePairing } from "./backend";
import type { AllowOutcome, FirewallStatus } from "./backend";
import { formatCommandError } from "./command-error";

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
 *  공통 포맷터에 넘긴다. */
export async function resolvePairing(): Promise<PairingResult> {
  try {
    const pairing = await remotePairing();
    return pairing === null ? { state: "off" } : { state: "on", url: pairing.url };
  } catch (error) {
    const reason = typeof error === "string" && error !== "" ? error : formatCommandError(error);
    return { state: "failed", reason };
  }
}

/** currentProfiles 덮어쓰기는 allowed/firewallOff/blocked 에는 적용하지 않는다 —
 *  앞의 둘은 프로필과 무관하고, blocked 는 차단 규칙 이름이 이 상태가 존재하는
 *  이유라 Public 안내에 묻히면 안 된다. */
export function firewallMessage(status: FirewallStatus): string {
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
      return `The "mast remote (LAN)" rule points at another copy of the app (${detail}), so the phone cannot connect.`;
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

export function allowOutcomeMessage(outcome: AllowOutcome): string {
  switch (outcome.outcome) {
    case "declined":
      return "Not applied — the permission prompt was declined.";
    case "failed":
      return `Could not apply: ${outcome.detail}`;
    case "applied":
      if (outcome.status.state === "allowed") return firewallMessage(outcome.status);
      return `Windows ran the command, but the rule is not visible yet: ${firewallMessage(outcome.status)} (see mast.log for the netsh exit code).`;
  }
}

/** 버튼 연타로 다이얼로그가 두 장 겹치지 않게 한다. */
let openDialog: HTMLDialogElement | null = null;

export function openPairingDialog(): void {
  if (openDialog !== null) return;

  const dialog = document.createElement("dialog");
  dialog.className = "pairing-dialog";
  openDialog = dialog;

  const heading = document.createElement("h2");
  heading.textContent = "Pair phone";

  const canvas = document.createElement("canvas");
  canvas.className = "pairing-qr";
  canvas.hidden = true;

  const url = document.createElement("code");
  url.className = "pairing-url";
  url.textContent = "…";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "pairing-close";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());

  dialog.append(heading, canvas, url, close);
  dialog.addEventListener("close", () => {
    dialog.remove();
    openDialog = null;
  });
  document.body.append(dialog);
  dialog.showModal();

  void (async () => {
    const result = await resolvePairing();
    url.textContent = pairingMessage(result);
    if (result.state !== "on") return;
    installFirewallSection(dialog, close);
    try {
      await drawQr(canvas, result.url);
      canvas.hidden = false;
    } catch (error) {
      // QR 이 없어도 URL 은 화면에 있다 — 손으로 칠 수 있으므로 다이얼로그를
      // 실패로 만들지 않는다.
      console.error("QR render failed", error);
    }
  })();
}

/** resolvePairing 과 같은 규칙 — 문자열이면 그대로, 아니면 공통 포맷터로. */
function firewallErrorMessage(error: unknown): string {
  return typeof error === "string" && error !== "" ? error : formatCommandError(error);
}

/** 페어링이 켜져 있을 때만 호출된다. close 버튼은 이미 append 돼 있으므로
 *  그 앞에 끼워 URL·QR 아래·Close 위 순서를 만든다. */
function installFirewallSection(dialog: HTMLDialogElement, close: HTMLButtonElement): void {
  const line = document.createElement("p");
  line.className = "pairing-firewall";
  line.textContent = "Checking Windows Firewall…";

  const allow = document.createElement("button");
  allow.type = "button";
  allow.className = "pairing-allow";
  allow.textContent = "Allow in Windows Firewall";
  allow.hidden = true;

  dialog.insertBefore(line, close);
  dialog.insertBefore(allow, close);

  allow.addEventListener("click", () => {
    allow.disabled = true;
    line.textContent = "Waiting for Windows…";
    void (async () => {
      try {
        const outcome = await remoteFirewallAllow();
        // UAC 프롬프트는 사용자가 답할 때까지 열려 있다 — 그동안 다이얼로그를
        // 닫았으면(Close/Esc/백드롭) 이미 없는 엘리먼트에 쓰지 않는다.
        if (!dialog.isConnected) return;
        line.textContent = allowOutcomeMessage(outcome);
        allow.hidden = !firewallActionable(outcome.status);
      } catch (error) {
        if (!dialog.isConnected) return;
        line.textContent = firewallErrorMessage(error);
      } finally {
        if (dialog.isConnected) allow.disabled = false;
      }
    })();
  });

  void (async () => {
    try {
      const status = await remoteFirewallStatus();
      if (!dialog.isConnected) return;
      line.textContent = firewallMessage(status);
      allow.hidden = !firewallActionable(status);
    } catch (error) {
      if (!dialog.isConnected) return;
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
