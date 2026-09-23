// 확인 대화상자 — 파괴적 동작(워크스페이스 닫기, 저장 안 된 Markdown 버리기·종료·리로드) 앞의
// 예/아니오.
//
// macOS 는 `window.confirm()` 을 쓸 수 없다: wry 0.55 의 WKUIDelegate 가
// `runJavaScriptConfirmPanelWithMessage` 를 구현하지 않아, WKWebView 가 대화상자 없이 곧바로
// false 를 돌려준다(사용자는 아무것도 보지 못하고 동작만 취소된다). 그래서 macOS 는 네이티브
// 커맨드(`confirm_dialog` — main 창에 붙는 sheet)로 묻는다. 그 밖의 플랫폼은 WebView2 의
// `window.confirm` 이 정상이라 그대로 쓴다(Windows 동작 불변).
//
// 커맨드가 실패하면 거부로 삼키지 않고 그대로 reject 한다 — 호출자가 사유를 표면화하고, 동작은
// 확인되지 않았으므로 진행하지 않는다.

import { invoke } from "@tauri-apps/api/core";
import { IS_MAC } from "../shared/platform";

export async function confirmAction(message: string, mac = IS_MAC): Promise<boolean> {
  if (!mac) return window.confirm(message);
  return invoke<boolean>("confirm_dialog", { message });
}
