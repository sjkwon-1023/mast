// Local HTTP 폰 페이지의 엔트리 — mast 앱이 쏘아 주는 `http://<ip>:<port>/remote/`.
//
// 토큰은 페어링 URL 의 **fragment**(`#t=…`)로 들어온다. fragment 는 요청에
// 실리지 않으므로 서버 로그·프록시에 남지 않고, 우리는 그것을 localStorage 로
// 옮긴 뒤 `history.replaceState` 로 주소창에서 지운다 — 지우지 않으면 화면 공유나
// 스크린샷 한 장으로 토큰이 새고, 새로고침·뒤로가기마다 다시 붙는다.
//
// 화면·폴링·입력은 Secure Remote 와 공유한다 (`app.ts` + `transport.ts`).

import "./remote.css";

import { httpTransport, loadToken, saveToken } from "./api";
import { fitToVisualViewport, RemoteApp } from "./app";
import { localStorageFontPx } from "./local-store";

function claimTokenFromFragment(): void {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) return;
  const token = new URLSearchParams(hash.slice(1)).get("t");
  if (token === null || token === "") return;
  saveToken(token);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

function showPairingHint(root: HTMLElement): void {
  const hint = document.createElement("div");
  hint.className = "hint";
  const line = document.createElement("p");
  line.textContent = "Scan the pairing QR in mast";
  const detail = document.createElement("p");
  detail.className = "hint-detail";
  detail.textContent = "Open the sidebar and press “Pair phone” on the desktop app.";
  hint.append(line, detail);
  root.replaceChildren(hint);
}

const root = document.getElementById("app");
if (root !== null) {
  fitToVisualViewport(root);
  claimTokenFromFragment();
  if (loadToken() === null) showPairingHint(root);
  else new RemoteApp({ root, transport: httpTransport, fontPx: localStorageFontPx }).start();
}
