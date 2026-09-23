// macOS Finder → 터미널 파일 드롭. Terminal.app 처럼 떨어뜨린 파일의 경로를 셸에 쓸 수 있는
// 글자로 바꿔 그 자리의 터미널 pane 에 붙여넣는다.
//
// 드롭은 Tauri 가 네이티브로 받는다(창 기본값 dragDropEnabled). 그래서 페이지의 HTML drop
// 이벤트에는 파일이 오지 않고, `onDragDropEvent` 의 drop 이 경로와 위치를 준다. 그 점의
// 터미널 뷰를 찾고, 없으면(뷰어·사이드바·헤더) 무시한다.
//
// 위치는 타입이 `PhysicalPosition` 이지만 macOS 에서는 값이 이미 CSS px(AppKit 논리 좌표)다:
// wry 0.55.1 `src/wkwebview/drag_drop.rs` 의 `perform_drag_operation` 이
// `draggingLocation()`/`frame()` 의 논리 좌표를 배율 없이 넘기고, tauri-runtime-wry 2.11.4
// `lib.rs` 의 DragDropEvent 변환이 그 값을 그대로 `PhysicalPosition` 으로 감쌀 뿐이다. 그래서
// `devicePixelRatio` 로 나누지 않는다 — 나누면 Retina(배율 2)에서 절반 위치를 hit test 해
// 다른 pane·사이드바에 떨어진다. Windows 로 넓힐 때는 WebView2 쪽이 실제 물리 px 를 주므로
// 그때는 배율 변환이 필요하다(지금은 macOS 에만 설치하므로 분기가 없다).
//
// 경로에 제어문자(C0·DEL·C1)가 하나라도 있으면 드롭 전체를 붙여넣지 않고 알린다. 작은따옴표
// 인용은 셸 파서만 막는다 — 그 앞의 줄 편집기(readline·zle)는 ESC·Ctrl+U·CR 같은 문자를 키로
// 먼저 처리하므로, 이름에 든 `ESC[201~` 가 bracketed paste 를 조기 종료하고 뒤의 글자를
// 명령으로 실행할 수 있다. 이런 문자를 키로 읽히지 않게 바꾸는 인코딩은 셸마다 달라 거부한다.
//
// 붙여넣기는 뷰의 paste 경로를 탄다 — 남은 한글 조합을 먼저 확정하고, bracketed paste 가
// 켜진 앱(셸·에이전트)에는 xterm 이 괄호를 씌워 보내므로 여러 경로가 한 번의 붙여넣기로
// 간다. 실행하지는 않는다(Enter 를 붙이지 않는다).
//
// Windows 는 설치하지 않는다: 드롭 경로가 Windows 경로라 WSL 경로 변환이 먼저 필요하다.

/** 셸 인용 — 작은따옴표로 감싸고 안의 `'` 는 `'\''` 로 끊어 잇는다. POSIX 셸(zsh·bash)에서
 *  작은따옴표 안은 어떤 문자도 해석되지 않으므로 공백·`$`·`` ` ``·`\`·`!` 가 모두 그대로다.
 *  줄 편집기가 먼저 읽는 제어문자는 막지 못한다 — handleFileDrop 이 그런 경로를 거부한다. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

// C0(0x00–0x1F), DEL(0x7F), C1(0x80–0x9F).
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** 터미널에 붙여넣으면 줄 편집기가 키로 해석할 수 있는 문자가 들어 있는가. */
function hasControlCharacter(path: string): boolean {
  return CONTROL_CHARACTER.test(path);
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

/** drop 하나를 처리한다. position 은 macOS 에서 이미 CSS px 다(파일 머리 주석).
 *  대상이 터미널이 아니거나 경로가 없으면 아무것도 하지 않고 false 를 돌려준다. 제어문자가
 *  든 경로가 있으면 드롭 전체를 붙여넣지 않고 onError 로 사용자에게 보일 사유를 넘긴다. */
export function handleFileDrop(
  payload: FileDropPayload,
  targetAt: (x: number, y: number) => DropTarget | null,
  onError: (message: string) => void,
): boolean {
  if (payload.type !== "drop" || payload.position === undefined) return false;
  const paths = payload.paths ?? [];
  const text = dropPasteText(paths);
  if (text === null) return false;
  const target = targetAt(payload.position.x, payload.position.y);
  if (target === null) return false;
  if (paths.some(hasControlCharacter)) {
    onError("dropped file not pasted: its name contains control characters");
    return false;
  }
  target.paste(text);
  return true;
}
