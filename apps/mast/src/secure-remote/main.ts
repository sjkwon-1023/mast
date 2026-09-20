// Secure Remote 정적 페이지의 엔트리 — 공개 HTTPS(GitHub Pages)에서 같은 LAN 의
// mast 로 WebTransport 를 연다.
//
// 이 페이지가 하는 일: QR fragment 를 엄격히 읽고 즉시 지운다, 브라우저 지원을
// 확인한다, 연결·인증이 끝나면 공유 UI(`remote/app.ts`)에 transport 를 넣어 준다,
// 그리고 연결의 수명을 관리한다 — 대상 host 를 화면에 드러내고, 같은 탭에서 새 QR
// 이 열리면 전체 reload 로 새로 시작하며, 페이지를 떠날 때 연결을 닫는다.
// 토큰·hash 는 메모리에만 있고(저장 없음), `/api` 나 평문 HTTP 로 가는 경로도 없다 —
// 네트워크는 전부 `WebTransportClient` 안에 있다.

import "../remote/remote.css";

import { fitToVisualViewport, RemoteApp } from "../remote/app";
import { RemoteError, TransportClosedError } from "../remote/transport";
import { createMemoryFontPxStore } from "./font-px";
import { reloadOnPairingHashChange, takePairingFragment } from "./pairing";
import { WebTransportClient, WebTransportUnsupportedError } from "./transport";

/** 탭 전환에도 살아남고 새로고침에는 초기화되는 글자 크기 (메모리 전용). */
const fontPx = createMemoryFontPxStore();

/** 연결 하나에 대응하는 클라이언트. pagehide 리스너가 이 하나만 보게 해, start 가
 *  다시 돌아도(새 QR 로 페이지가 다시 로드되기 전의 창) 핸들러가 겹치지 않는다. */
let client: WebTransportClient | null = null;

/** 새 QR 로 떠나는 중인가. 언로드 직후의 늦은 비동기 연속이 옛 문서의 DOM 을
 *  덮지 않게 한다 — 화면은 어차피 사라지지만, 마지막 프레임이 새 페이지의 첫
 *  인상을 흔들지 않도록 쓰기를 막는다. */
let leaving = false;

// 페이지를 떠나면 연결을 우리 쪽에서 닫는다 — 서버가 유휴 30초를 기다리지 않는다.
window.addEventListener("pagehide", () => client?.dispose());

// 같은 탭에서 새 QR 주소를 열면 문서가 다시 로드되지 않고 fragment 만 바뀐다
// (same-document 이동). 그대로 두면 새 토큰이 주소에 남고 연결도 시작되지 않으므로,
// fragment 를 지우지 않은 채 전체 reload 를 요청한다 — 새 문서의 start() 가 QR 을
// 처음부터 읽고, 언로드의 pagehide 가 이전 연결을 닫는다.
reloadOnPairingHashChange(window, () => {
  leaving = true;
  window.location.reload();
});

const root = document.getElementById("app");
if (root !== null) {
  fitToVisualViewport(root);
  void start(root);
}

async function start(root: HTMLElement): Promise<void> {
  const pairing = takePairingFragment(window.location, window.history);
  if (!pairing.ok) {
    showNotice(
      root,
      "Scan the pairing QR in mast",
      pairing.reason === "invalid"
        ? "That link was not a valid mast pairing code. Open the sidebar, press “Pair phone”, choose Secure Remote, and scan the fresh QR."
        : "Open the sidebar in mast on your PC, press “Pair phone”, choose Secure Remote, and scan the QR with this phone.",
    );
    return;
  }

  if (typeof WebTransport !== "function") {
    showNotice(
      root,
      "This browser has no WebTransport",
      "Secure Remote needs WebTransport with certificate pinning — use a recent Chrome or Edge on this phone, then scan the QR again.",
    );
    return;
  }

  client = new WebTransportClient({
    host: pairing.link.host,
    port: pairing.link.port,
    certHash: pairing.link.certHash,
    token: pairing.link.token,
  });

  showNotice(
    root,
    "Connecting to mast…",
    `Destination ${destinationText(pairing.link.host, pairing.link.port)}. If the browser asks for permission to access your local network, allow it for this page.`,
  );
  try {
    await client.connect();
  } catch (error) {
    if (leaving) return;
    showNotice(root, "Could not connect to mast", connectErrorText(error));
    return;
  }
  if (leaving) return;
  new RemoteApp({
    root,
    transport: client,
    fontPx,
    destination: destinationText(pairing.link.host, pairing.link.port),
  }).start();
}

/** 연결 대상 표시 — 사용자가 어느 호스트로 붙는지 항상 볼 수 있게 한다. */
export function destinationText(host: string, port: number): string {
  return `${host}:${port}`;
}

export function connectErrorText(error: unknown): string {
  if (error instanceof WebTransportUnsupportedError) {
    return "The browser refused the WebTransport options mast needs — use a recent Chrome or Edge on this phone, then scan the QR again.";
  }
  if (error instanceof TransportClosedError) {
    return "The connection closed before setup finished — scan the pairing QR again.";
  }
  if (error instanceof RemoteError) {
    switch (error.status) {
      case 401:
        return "Not authorized — scan the pairing QR in mast again.";
      case 409:
        return "Another phone is already connected. End that phone session (close the mast page there), then start a new pairing in mast and scan the new QR.";
      case 429:
        return "Too many attempts — wait a minute and scan the QR again.";
      case 503:
        return "This pairing was cancelled in mast — scan a new QR.";
      default:
        return `mast rejected the connection (${error.status}). Scan the QR again.`;
    }
  }
  return "Check that this phone is on the same Wi-Fi as your PC and allow local-network access if the browser asks. If it still fails, this browser may accept the options but ignore certificate pinning (serverCertificateHashes) — a recent Chrome or Edge is required. Then scan the QR again.";
}

function showNotice(root: HTMLElement, title: string, detail: string): void {
  if (leaving) return;
  const hint = document.createElement("div");
  hint.className = "hint";
  const line = document.createElement("p");
  line.textContent = title;
  const body = document.createElement("p");
  body.className = "hint-detail";
  body.textContent = detail;
  hint.append(line, body);
  root.replaceChildren(hint);
}
