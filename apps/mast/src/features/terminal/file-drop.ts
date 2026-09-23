// macOS Finder → 터미널 파일 드롭. Terminal.app 처럼 떨어뜨린 파일의 경로를 셸에 쓸 수 있는
// 글자로 바꿔 그 자리의 터미널 pane 에 붙여넣는다.
//
// 드롭은 Tauri 가 네이티브로 받는다(창 기본값 dragDropEnabled). 그래서 페이지의 HTML drop
// 이벤트에는 파일이 오지 않고, `onDragDropEvent` 의 drop 이 경로와 **물리 픽셀** 위치를 준다.
// 위치를 CSS px 로 바꿔 그 점의 터미널 뷰를 찾고, 없으면(뷰어·사이드바·헤더) 무시한다.
//
// 붙여넣기는 뷰의 paste 경로를 탄다 — 남은 한글 조합을 먼저 확정하고, bracketed paste 가
// 켜진 앱(셸·에이전트)에는 xterm 이 괄호를 씌워 보내므로 경로의 공백·개행이 입력을 끝내지
// 않는다. 실행하지는 않는다(Enter 를 붙이지 않는다).
//
// Windows 는 설치하지 않는다: 드롭 경로가 Windows 경로라 WSL 경로 변환이 먼저 필요하다.

/** 셸 인용 — 작은따옴표로 감싸고 안의 `'` 는 `'\''` 로 끊어 잇는다. POSIX 셸(zsh·bash)에서
 *  작은따옴표 안은 어떤 문자도 해석되지 않으므로 공백·`$`·`` ` ``·`\`·`!`·개행이 모두 그대로다. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** 드롭한 파일들의 붙여넣기 텍스트 — 인용한 경로를 공백 하나로 잇는다. 빈 목록은 null. */
export function dropPasteText(paths: readonly string[]): string | null {
  return paths.length === 0 ? null : paths.map(shellQuote).join(" ");
}

/** 드롭을 받을 수 있는 터미널 — TerminalView 의 paste 만 쓴다. */
export interface DropTarget {
  paste(text: string): void;
}

/** `onDragDropEvent` 페이로드 중 여기서 읽는 부분. */
export interface FileDropPayload {
  type: string;
  paths?: string[];
  position?: { x: number; y: number };
}

/** drop 하나를 처리한다. position 은 물리 픽셀이라 scale(devicePixelRatio)로 나눈다.
 *  대상이 터미널이 아니거나 경로가 없으면 아무것도 하지 않고 false 를 돌려준다. */
export function handleFileDrop(
  payload: FileDropPayload,
  targetAt: (x: number, y: number) => DropTarget | null,
  scale: number,
): boolean {
  if (payload.type !== "drop" || payload.position === undefined) return false;
  const text = dropPasteText(payload.paths ?? []);
  if (text === null) return false;
  const factor = scale > 0 ? scale : 1;
  const target = targetAt(payload.position.x / factor, payload.position.y / factor);
  if (target === null) return false;
  target.paste(text);
  return true;
}
