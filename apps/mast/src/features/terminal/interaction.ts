import { IS_MAC, primaryModifier } from "../../shared/platform";
import type { Terminal } from "@xterm/xterm";

// 이미지가 확인된 경우에만 Ctrl+V를 PTY로 보낸다. 빈 값·조회 실패는 quoted-insert를 유발하지 않는다.
export async function clipboardHasImage(): Promise<boolean> {
  try {
    const items = await navigator.clipboard.read();
    return items.some((item) => item.types.some((type) => type.startsWith("image/")));
  } catch (err) {
    console.error("clipboard inspect failed", err);
    return false;
  }
}

// TUI 마우스 모드의 클릭은 앱에 맡기고, 외부 실행은 HTTP(S)만 허용한다.
// macOS 는 Terminal.app·iTerm2 처럼 ⌘클릭일 때만 연다 — 그냥 클릭은 선택·커서 이동 몫이다.
// Windows 는 그대로 클릭 하나로 연다.
export function shouldOpenLink(
  uri: string,
  mouseTrackingMode: string,
  event: Pick<MouseEvent, "metaKey"> = { metaKey: false },
  mac = IS_MAC,
): boolean {
  if (mouseTrackingMode !== "none") return false;
  if (mac && !event.metaKey) return false;
  try {
    const scheme = new URL(uri).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

// Alt+방향키의 실제 시퀀스. xterm 5.5 의 `evaluateKeyboardEvent` 는 non-Mac 에서 Alt+방향키를
// Ctrl+방향키(`ESC[1;5A` 등)로 바꿔 보내는 HACK 을 갖고 있어(셸 단어 이동 관례),
// 그대로 두면 TUI 앱은 Alt 대신 Ctrl 을 받는다. 터미널 뷰가 이 판정으로 직접 보낸다.
// Alt 단독일 때만 값이 있고 수식이 더 붙으면 null 이다 (Ctrl+Alt 는 xterm 이 1;7x 로
// 정확히 보내고, Alt+Shift 는 window capture 의 pane 이동이 먼저 소비한다).
// IME 조합 중의 keydown 은 조합기 소유다 (ADR-0007 결정 6).
//
// macOS 에서는 null 이다 — xterm 의 Mac 기본이 Terminal.app 과 같다: Option+←/→ 는
// `ESC b`/`ESC f`(셸 단어 이동), Option+↑/↓ 는 `ESC[1;3A/B` 그대로다. 여기서 덮으면
// Mac 사용자가 기대하는 단어 이동이 깨진다.
export function altArrowSequence(
  ev: Pick<
    KeyboardEvent,
    "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing"
  >,
  mac = IS_MAC,
): string | null {
  if (mac) return null;
  if (ev.isComposing || !ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return null;
  switch (ev.key) {
    case "ArrowUp":
      return "\x1b[1;3A";
    case "ArrowDown":
      return "\x1b[1;3B";
    case "ArrowRight":
      return "\x1b[1;3C";
    case "ArrowLeft":
      return "\x1b[1;3D";
    default:
      return null;
  }
}

/** macOS 터미널 키가 읽는 화면 상태 — 일반 버퍼인지, 앱이 마우스를 추적 중인지. */
export interface TerminalScreenMode {
  normalBuffer: boolean;
  mouseTracking: boolean;
}

/** macOS 터미널 전용 키의 뜻. `send` 는 PTY 로 보낼 바이트, `clear` 는 화면과 스크롤백
 *  지우기, `scroll` 은 PTY 에 아무것도 보내지 않는 스크롤백 이동이다. */
export type MacTerminalKey =
  | { type: "send"; data: string }
  | { type: "clear" }
  | { type: "scroll"; to: "pageUp" | "pageDown" | "top" | "bottom" };

const MAC_SCROLL_KEYS: Record<string, "pageUp" | "pageDown" | "top" | "bottom" | undefined> = {
  PageUp: "pageUp",
  PageDown: "pageDown",
  Home: "top",
  End: "bottom",
};

// ⌘ 줄 편집은 readline·zle 의 emacs 키로 보낸다 — Terminal.app·iTerm2 의 "Natural text
// editing" 관례와 같은 바이트다. ⌘⌥방향키(pane 이동)는 alt 가 붙어 여기 닿지 않는다.
const MAC_COMMAND_EDIT_KEYS: Record<string, string | undefined> = {
  ArrowLeft: "\x01",
  ArrowRight: "\x05",
  Backspace: "\x15",
};

/** macOS 터미널의 ⌘ 줄 편집·⌘K·Fn 스크롤 키 판정 (Windows 는 항상 null — 기존 동작 그대로).
 *
 *  Fn+↑/↓/←/→ 는 PageUp/PageDown/Home/End 로 온다. Terminal.app 처럼 수식키 없이 누르면
 *  스크롤백을 움직이는데, 스크롤백이 없는 alt 버퍼(vim·less)나 마우스를 추적하는 TUI 에서는
 *  그 키가 앱의 것이므로 null 을 돌려 xterm 이 PTY 로 보내게 둔다.
 *
 *  Shift 를 붙이면 Terminal.app 관례대로 스크롤 대신 키를 앱에 보낸다. xterm 기본은 반대로
 *  Shift+PageUp/PageDown 을 스크롤에 쓰므로(Keyboard.ts 의 PAGE_UP 결과) 그 둘은 여기서
 *  수식 없는 시퀀스(`ESC[5~`/`ESC[6~`, Terminal.app 이 보내는 바이트)로 직접 보낸다.
 *  Shift+Home/End 는 xterm 기본이 이미 PTY 로 보내므로(`ESC[1;2H`/`ESC[1;2F`) 손대지 않는다.
 *
 *  IME 조합 중의 키는 조합기 몫이다. WebKit 한글 경로는 조합 이벤트 없이 오지만 그 어댑터가
 *  비-229 keydown 에서 남은 조합을 먼저 확정하므로(webkit-ime.ts) 여기서 보낸 바이트가 조합
 *  글자를 앞지르지 않는다. */
export function macTerminalKeyAction(
  ev: Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing">,
  screen: TerminalScreenMode,
  mac = IS_MAC,
): MacTerminalKey | null {
  if (!mac || ev.isComposing || ev.altKey || ev.ctrlKey) return null;
  if (ev.metaKey) {
    if (ev.shiftKey) return null;
    // 한글 입력 소스에서는 ⌘K 의 key 가 자모로 올 수 있어 물리 키(code)도 본다 (리로드 키와 같은 판단).
    // alt 버퍼는 스크롤백이 없고 화면은 TUI 소유라, 지우면 앱이 다시 그릴 때까지 화면만
    // 깨진다 — 그때는 가로채지 않는다.
    if (ev.key.toLowerCase() === "k" || ev.code === "KeyK") {
      return screen.normalBuffer ? { type: "clear" } : null;
    }
    const data = MAC_COMMAND_EDIT_KEYS[ev.key];
    return data === undefined ? null : { type: "send", data };
  }
  const to = MAC_SCROLL_KEYS[ev.key];
  if (to === undefined) return null;
  if (ev.shiftKey) {
    if (to === "pageUp") return { type: "send", data: "\x1b[5~" };
    if (to === "pageDown") return { type: "send", data: "\x1b[6~" };
    return null;
  }
  if (!screen.normalBuffer || screen.mouseTracking) return null;
  return { type: "scroll", to };
}

// 선택 없는 Ctrl+C는 SIGINT로 통과시킨다. 기록 뷰도 이 판정을 공유한다.
export function isCopySelectionKey(ev: KeyboardEvent, hasSelection: boolean, mac = IS_MAC): boolean {
  if (ev.isComposing || !hasSelection || !primaryModifier(ev, mac)) return false;
  if (!mac && ev.key === "Insert") return !ev.shiftKey;
  return ev.key.toLowerCase() === "c";
}

// 키를 가로채 클립보드를 직접 읽어 붙여넣을지. macOS 에서는 가로채지 않는다 — WebKit 은
// 스크립트의 클립보드 읽기(`navigator.clipboard.readText`)마다 "Paste" 확인 버튼을 띄운다.
// 대신 Cmd+V 가 Edit 메뉴의 네이티브 붙여넣기로 가서 xterm 입력창에 `paste` 이벤트로
// 도착하고, xterm 이 bracketed paste 로 처리한다(이미지만 있는 경우는 isImageOnlyPaste).
export function isPasteKey(ev: KeyboardEvent, mac = IS_MAC): boolean {
  if (mac || ev.isComposing) return false;
  if (primaryModifier(ev, mac) && ev.key.toLowerCase() === "v") return true;
  return ev.key === "Insert" && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
}

// 붙여넣기 데이터에 텍스트가 없고 이미지만 있는지. 그때는 Ctrl+V(\x16)를 PTY 로 보내
// 에이전트가 클립보드 이미지를 직접 읽게 한다 — Windows 경로의 clipboardHasImage 와 같은 규칙.
export function isImageOnlyPaste(data: Pick<DataTransfer, "types" | "getData">): boolean {
  if (data.getData("text/plain").length > 0) return false;
  return Array.from(data.types).some((type) => type.startsWith("image/") || type === "Files");
}

export async function copyTerminalSelection(term: Terminal, mac = IS_MAC): Promise<void> {
  const text = term.getSelection();
  if (text.length === 0) return;
  try {
    await navigator.clipboard.writeText(text);
    // Windows 는 다음 Ctrl+C 가 SIGINT 로 전달되도록 복사 성공 후 선택을 해제한다. macOS 는
    // 복사(⌘C)와 인터럽트(Ctrl+C)가 다른 키라 선택을 남긴다 — Terminal.app 과 같다.
    if (!mac) term.clearSelection();
  } catch (err) {
    console.error("clipboard write failed", err);
  }
}
