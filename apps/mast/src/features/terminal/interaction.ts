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

// 선택 없는 Ctrl+C는 SIGINT로 통과시킨다. 기록 뷰도 이 판정을 공유한다.
export function isCopySelectionKey(ev: KeyboardEvent, hasSelection: boolean): boolean {
  if (!ev.ctrlKey || ev.altKey || !hasSelection) return false;
  if (ev.key === "Insert") return !ev.shiftKey;
  return ev.key.toLowerCase() === "c";
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
