import { DEFAULT_VIEWER_FONT_SIZE } from "../viewer-font";
import type { KeySpec } from "../../../shared/keys";

// 파일 전체 크기와 무관하게 512KiB 창 하나만 상주시킨다.
export const WINDOW_BYTES = 512 * 1024;

export const LINE_HEIGHT_PX = 16;

// 정수 행높이를 유지해 가상 스크롤 격자의 누적 오차를 막는다.
export function lineHeightForFontSize(size: number): number {
  return Math.max(1, Math.round((size * LINE_HEIGHT_PX) / DEFAULT_VIEWER_FONT_SIZE));
}

export const OVERSCAN_LINES = 20;

const LF = 0x0a;

const CR = 0x0d;

// start/end/lineStarts는 파일 전역 byte offset이며 end는 제외 경계다.
export interface TextWindow {
  start: number;

  end: number;

  lines: string[];

  lineStarts: number[];
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function sequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
}

function decodeLine(
  decoder: TextDecoder,
  bytes: Uint8Array,
  from: number,
  to: number,
): string {
  const end = to > from && bytes[to - 1] === CR ? to - 1 : to;
  return decoder.decode(bytes.subarray(from, end));
}

// 양 끝의 부분행·UTF-8 파단을 자른다. 개행이 없는 긴 행은 빈 화면 대신 조각을 표시한다.
export function decodeWindow(
  bytes: Uint8Array,
  readOffset: number,
  atEof: boolean,
): TextWindow {
  let from = 0;
  let to = bytes.length;

  if (readOffset > 0) {
    const nl = bytes.indexOf(LF);
    if (nl >= 0) from = nl + 1;
  }
  if (!atEof) {
    const nl = bytes.lastIndexOf(LF);
    if (nl >= from) to = nl + 1;
  }

  if (readOffset + from > 0) {
    while (from < to && isContinuation(bytes[from])) from += 1;
  }

  if (!atEof) {
    for (let i = to - 1; i >= from && i >= to - 4; i -= 1) {
      const length = sequenceLength(bytes[i]);
      if (length === 0) continue;
      if (i + length > to) to = i;
      break;
    }
  }

  const decoder = new TextDecoder();
  const lines: string[] = [];
  const lineStarts: number[] = [];
  let lineFrom = from;
  for (let i = from; i < to; i += 1) {
    if (bytes[i] !== LF) continue;
    lineStarts.push(readOffset + lineFrom);
    lines.push(decodeLine(decoder, bytes, lineFrom, i));
    lineFrom = i + 1;
  }

  if (lineFrom < to) {
    lineStarts.push(readOffset + lineFrom);
    lines.push(decodeLine(decoder, bytes, lineFrom, to));
  }

  return { start: readOffset + from, end: readOffset + to, lines, lineStarts };
}

export interface SliceRange {
  first: number;

  last: number;
  top: number;
}

export function visibleSlice(
  scrollTop: number,
  viewportHeight: number,
  totalLines: number,
  lineHeight: number = LINE_HEIGHT_PX,
  overscan: number = OVERSCAN_LINES,
): SliceRange {
  if (totalLines <= 0 || lineHeight <= 0) return { first: 0, last: 0, top: 0 };
  const top = Math.max(0, scrollTop);
  const firstVisible = Math.min(totalLines - 1, Math.floor(top / lineHeight));

  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / lineHeight) + 1;
  const first = Math.max(0, firstVisible - overscan);
  const last = Math.min(totalLines, firstVisible + visibleCount + overscan);
  return { first, last, top: first * lineHeight };
}

export function topLineIndex(
  scrollTop: number,
  lineHeight: number,
  totalLines: number,
): number {
  if (totalLines <= 0 || lineHeight <= 0) return 0;
  return Math.min(
    totalLines - 1,
    Math.max(0, Math.floor(Math.max(0, scrollTop) / lineHeight)),
  );
}

export function scrollTopForLineHeight(
  scrollTop: number,
  fromLineHeight: number,
  toLineHeight: number,
  totalLines: number,
): number {
  if (toLineHeight <= 0) return Math.max(0, scrollTop);
  return topLineIndex(scrollTop, fromLineHeight, totalLines) * toLineHeight;
}

export function lineIndexForOffset(lineStarts: readonly number[], offset: number): number {
  if (lineStarts.length === 0) return 0;
  if (offset <= lineStarts[0]) return 0;
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export type WindowAction = "first" | "prev" | "next" | "last";

export function nextWindowStart(
  action: WindowAction,
  current: { start: number; end: number },
  size: number,
  windowBytes: number = WINDOW_BYTES,
): number {
  const lastStart = Math.max(0, size - windowBytes);
  switch (action) {
    case "first":
      return 0;
    case "prev":
      return Math.max(0, current.start - windowBytes);
    case "next":
      return Math.min(lastStart, current.end);
    case "last":
      return lastStart;
  }
}

export const WINDOW_ACTIONS: readonly WindowAction[] = ["first", "prev", "next", "last"];

// 복원할 최상단 행 위쪽에도 스크롤 문맥이 남도록 창 가운데에 배치한다.
export function windowStartForRestore(
  target: number,
  size: number,
  windowBytes: number = WINDOW_BYTES,
): number {
  if (target <= 0) return 0;
  const lastStart = Math.max(0, size - windowBytes);
  const centered = target - Math.floor(windowBytes / 2);
  return Math.max(0, Math.min(centered, lastStart));
}

export function windowButtonsDisabled(
  current: { start: number; end: number },
  size: number,

  _windowBytes: number = WINDOW_BYTES,
): Record<WindowAction, boolean> {
  const atStart = current.start <= 0;
  const atEnd = current.end >= size;
  return { first: atStart, prev: atStart, next: atEnd, last: atEnd };
}

export type TextKeyAction =
  | { type: "window"; action: WindowAction }
  | { type: "page"; delta: 1 | -1 };

const CTRL_WINDOW_KEYS: Record<string, WindowAction | undefined> = {
  PageUp: "prev",
  PageDown: "next",
  Home: "first",
  End: "last",
};

export function textKeyAction(spec: KeySpec): TextKeyAction | null {
  if (spec.isComposing || spec.alt || spec.shift) return null;
  if (spec.ctrl) {
    const action = CTRL_WINDOW_KEYS[spec.key];
    return action === undefined ? null : { type: "window", action };
  }
  if (spec.key === "PageUp") return { type: "page", delta: -1 };
  if (spec.key === "PageDown") return { type: "page", delta: 1 };
  return null;
}

export function pageScrollTop(
  scrollTop: number,
  viewportHeight: number,
  maxScrollTop: number,
  delta: 1 | -1,
  lineHeight: number = LINE_HEIGHT_PX,
): number {
  if (lineHeight <= 0) return Math.max(0, Math.min(scrollTop, Math.max(0, maxScrollTop)));
  const step = Math.max(1, Math.floor(Math.max(0, viewportHeight) / lineHeight) - 1);
  const line = Math.round(Math.max(0, scrollTop) / lineHeight) + delta * step;
  const target = Math.max(0, line) * lineHeight;
  return Math.max(0, Math.min(target, Math.max(0, maxScrollTop)));
}

function groupDigits(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatByteRange(start: number, end: number, size: number): string {
  return `bytes ${groupDigits(start)}–${groupDigits(end)} of ${groupDigits(size)}`;
}
