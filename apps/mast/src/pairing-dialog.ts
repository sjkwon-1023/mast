// 페어링 다이얼로그 — 폰이 열 URL 을 QR 과 텍스트로 보여 준다.
//
// 이 다이얼로그를 여는 것이 **토큰이 렌더러로 건너오는 유일한 경로**다
// (remote_status 는 토큰을 싣지 않는다). 그래서 URL 은 열 때 한 번만 받아 오고
// 어디에도 캐시하지 않는다.
//
// QR 인코더(`uqr`)는 **dynamic import 로만** 들여온다 — 정적으로 import 하면
// 앱을 켤 때마다 아무도 안 쓰는 인코더 바이트를 엔트리 청크로 지고 부팅한다.
// 빌드 산출물에서 별도 청크로 갈라졌는지가 D 청크의 검증 항목이다.
//
// 네이티브 `<dialog>` 를 쓰는 이유는 모달 처리(포커스 트랩·Esc 닫기·백드롭)를
// 브라우저가 이미 하기 때문이다.

import { remotePairing } from "./backend";
import { formatCommandError } from "./command-error";

/** 다이얼로그가 보여 줄 세 가지 결말. */
export type PairingResult =
  | { state: "on"; url: string }
  | { state: "off" }
  | { state: "failed"; reason: string };

/** 설정에 `remote` 키가 없을 때의 안내 (사용자 노출 문자열이라 영어). */
export const REMOTE_OFF_MESSAGE = 'Remote access is off — set "remote" in settings.json';

/** 결말 → 다이얼로그 본문 한 줄. 켜져 있으면 URL 자체가 본문이다. */
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

/** 커맨드 호출 → 결말. reject 는 백엔드가 만든 사유 문자열이라 그대로 쓰고,
 *  문자열이 아닌 것만 공통 포맷터에 넘긴다. */
export async function resolvePairing(): Promise<PairingResult> {
  try {
    const pairing = await remotePairing();
    return pairing === null ? { state: "off" } : { state: "on", url: pairing.url };
  } catch (error) {
    const reason = typeof error === "string" && error !== "" ? error : formatCommandError(error);
    return { state: "failed", reason };
  }
}

/** 열려 있는 다이얼로그 — 버튼 연타로 두 장이 겹치지 않게 한다. */
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

/** 모듈 하나의 변 길이가 이보다 작아지지 않게 한다 (카메라가 못 읽는다). */
const MIN_MODULE_PX = 3;
/** QR 을 그릴 목표 크기 (CSS px). */
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
