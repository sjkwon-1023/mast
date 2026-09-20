// Secure Remote 정적 페이지의 엔트리 — 공개 HTTPS(GitHub Pages)에서 같은 LAN 의
// mast 로 WebTransport 를 연다.
//
// 이 페이지가 하는 일: QR fragment 를 엄격히 읽고 즉시 지운다, 브라우저 지원을
// 확인한다, 연결·인증이 끝나면 공유 UI(`remote/app.ts`)에 transport 를 넣어 준다,
// 그리고 연결의 수명을 관리한다 — 대상 host 를 화면에 드러내고, 같은 탭에서 새 QR
// 이 열리면 전체 reload 로 새로 시작하며, 페이지를 떠날 때 연결을 닫는다.
// 인증된 페어링은 브라우저에 만료 시각과 함께 저장한다. 평문 HTTP 경로는 없다 —
// 네트워크는 전부 `WebTransportClient` 안에 있다.

import "../remote/remote.css";
import { RememberedSession } from "./session";
import { forgetPairing, readRememberedPairing, PairingStorageError } from "./remembered";

import { fitToVisualViewport, RemoteApp } from "../remote/app";
import { RemoteError, TransportClosedError } from "../remote/transport";
import { createMemoryFontPxStore } from "./font-px";
import { reloadOnPairingHashChange, takePairingFragment } from "./pairing";
import { ConnectTimeoutError, WebTransportUnsupportedError } from "./transport";

const fontPx = createMemoryFontPxStore();
let session: RememberedSession | null = null;
let app: RemoteApp | null = null;
let leaving = false;

function disposeApp(): void {
  app?.dispose();
  app = null;
}

window.addEventListener("pagehide", () => {
  leaving = true;
  disposeApp();
  session?.setVisible(false);
});
window.addEventListener("pageshow", () => {
  leaving = false;
  session?.setVisible(!document.hidden);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) disposeApp();
  session?.setVisible(!document.hidden && !leaving);
});
reloadOnPairingHashChange(window, () => {
  leaving = true;
  session?.dispose();
  window.location.reload();
});

const root = document.getElementById("app");
if (root !== null) {
  fitToVisualViewport(root);
  start(root);
}

function start(root: HTMLElement): void {
  const scanned = takePairingFragment(window.location, window.history);
  let storage: Storage;
  let saved;
  try {
    storage = window.localStorage;
    if (scanned.ok || scanned.reason === "invalid") forgetPairing(storage);
    saved = readRememberedPairing(storage);
  } catch {
    showNotice(root, "Could not remember this phone", "Allow storage for this site, then scan the pairing QR again.");
    return;
  }
  const link = scanned.ok ? scanned.link : saved?.link;
  if (link === undefined) {
    showNotice(root, "Scan the pairing QR in mast",
      "Open the sidebar in mast on your PC, press “Connect mobile”, choose Secure Remote, and scan the QR with this phone.");
    return;
  }
  if (typeof WebTransport !== "function") {
    showNotice(root, "This browser has no WebTransport", "Use a browser with WebTransport and certificate pinning support, then scan the QR again.");
    return;
  }
  session = new RememberedSession({
    link,
    expiresAt: scanned.ok ? null : saved!.expiresAt,
    storage,
    onConnecting: () => {
      disposeApp();
      showNotice(root, "Connecting to mast…", `Destination ${destinationText(link.host, link.port)}. Allow local-network access if the browser asks.`);
    },
    onConnected: (client) => {
      if (leaving) return;
      app = new RemoteApp({ root, transport: client, fontPx, destination: destinationText(link.host, link.port) });
      app.start();
    },
    onDisconnected: (error, retrying) => {
      disposeApp();
      showNotice(root, retrying ? "Reconnecting to mast…" : "Could not connect to mast",
        retrying ? "The connection was interrupted. Reconnecting without resending input…"
          : `${connectErrorText(error)} If mast was restarted, scan a new QR; otherwise refresh to retry.`);
    },
    onExpired: () => {
      disposeApp();
      showNotice(root, "Pairing expired", "The certificate expired or mast ended this pairing. Scan a new QR in Connect mobile.");
    },
  });
  session.setVisible(!document.hidden);
}

/** 연결 대상 표시 — 사용자가 어느 호스트로 붙는지 항상 볼 수 있게 한다. */
export function destinationText(host: string, port: number): string {
  return `${host}:${port}`;
}

export function connectErrorText(error: unknown): string {
  if (error instanceof PairingStorageError) return error.message;
  if (error instanceof ConnectTimeoutError) {
    return error.stage === "connection"
      ? "Connecting to mast timed out. Check that your phone and PC are on the same Wi-Fi, allow local-network access, and check the UDP firewall permission in mast’s Secure Remote screen. Then scan a new QR."
      : "mast’s connection opened, but the browser did not finish opening a data stream. Scan a new QR to retry. If this repeats, the browser’s WebTransport implementation may be incompatible.";
  }
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
        return "Another phone or tab is already connected. Close that mast page, then refresh this page to reconnect. Restart mast and scan a new QR to replace the pairing.";
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
