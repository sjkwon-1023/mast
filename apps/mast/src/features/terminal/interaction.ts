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
export function shouldOpenLink(uri: string, mouseTrackingMode: string): boolean {
  if (mouseTrackingMode !== "none") return false;
  try {
    const scheme = new URL(uri).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

// Alt+방향키의 실제 시퀀스. xterm 5.5 의 `evaluateKeyboardEvent` 는 Alt+방향키를
// Ctrl+방향키(`ESC[1;5A` 등)로 바꿔 보내는 HACK 을 갖고 있어(셸 단어 이동 관례),
// 그대로 두면 TUI 앱은 Alt 대신 Ctrl 을 받는다. 터미널 뷰가 이 판정으로 직접 보낸다.
// Alt 단독일 때만 값이 있고 수식이 더 붙으면 null 이다 (Ctrl+Alt 는 xterm 이 1;7x 로
// 정확히 보내고, Alt+Shift 는 window capture 의 pane 이동이 먼저 소비한다).
// IME 조합 중의 keydown 은 조합기 소유라 건드리지 않는다 (ADR-0007 결정 6).
export function altArrowSequence(
  ev: Pick<
    KeyboardEvent,
    "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing"
  >,
): string | null {
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

// 선택 없는 Ctrl+C는 SIGINT로 통과시킨다. 기록 뷰도 이 판정을 공유한다.
export function isCopySelectionKey(ev: KeyboardEvent, hasSelection: boolean, mac = IS_MAC): boolean {
  if (ev.isComposing || !hasSelection || !primaryModifier(ev, mac)) return false;
  if (!mac && ev.key === "Insert") return !ev.shiftKey;
  return ev.key.toLowerCase() === "c";
}

export function isPasteKey(ev: KeyboardEvent, mac = IS_MAC): boolean {
  if (ev.isComposing) return false;
  if (primaryModifier(ev, mac) && ev.key.toLowerCase() === "v") return true;
  return !mac && ev.key === "Insert" && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
}

export async function copyTerminalSelection(term: Terminal): Promise<void> {
  const text = term.getSelection();
  if (text.length === 0) return;
  try {
    await navigator.clipboard.writeText(text);
    // 다음 Ctrl+C가 SIGINT로 전달되도록 복사 성공 후 선택을 해제한다.
    term.clearSelection();
  } catch (err) {
    console.error("clipboard write failed", err);
  }
}
