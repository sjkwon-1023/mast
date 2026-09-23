// 테스트 전용 — xterm 브라우저 빌드를 WKWebView(macOS)와 같은 Mac 모드로 불러오게 한다.
//
// xterm 은 Mac 판정을 모듈 로드 때 `navigator.platform` 으로 하되, `process.title` 이 있으면
// Node 로 보고 판정을 건너뛴다. 테스트 러너에는 process 가 있으므로 xterm 을 불러오기 전에
// 그 둘을 WKWebView 와 같게 맞춘다. 같은 이유로 shared/platform 의 IS_MAC 도 true 가 된다.
//
// 사용: 테스트 파일의 **첫 import** 로 둔다(xterm 과 xterm 을 불러오는 모듈보다 먼저 평가돼야
// 한다). xterm 을 불러온 뒤 `restoreProcessTitle()` 로 process.title 을 되돌린다.

const title = Object.getOwnPropertyDescriptor(process, "title");
delete (process as { title?: string }).title;
Object.defineProperty(navigator, "platform", { get: () => "MacIntel", configurable: true });

export function restoreProcessTitle(): void {
  if (title !== undefined) Object.defineProperty(process, "title", title);
}
