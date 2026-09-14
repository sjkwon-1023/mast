import type { ITheme } from "@xterm/xterm";
import { clampFontSize } from "../../shared/font-size";
import type { UiSettings } from "../../infrastructure/backend";

// foreground/background 변경 시 host.rs THEME_SYNC와 sink.rs COLOR_REPLY_*도 함께 맞춘다.
const TERMINAL_THEME: ITheme = {
  foreground: "#cccccc",
  background: "#1e1e1e",
  cursor: "#cccccc",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

const DEFAULT_FONT_FAMILY = "Consolas, 'Cascadia Mono', monospace";

const DEFAULT_FONT_SIZE = 13;

// 줌은 세션 한정이다. baseFontSize는 설정에서 읽은 리셋 기준값을 유지한다.
let fontFamily = DEFAULT_FONT_FAMILY;

let fontSize = DEFAULT_FONT_SIZE;

let baseFontSize = DEFAULT_FONT_SIZE;

export interface TerminalFontTarget {
  setFontSize(size: number): void;
}

// 살아 있는 터미널·기록 뷰만 등록하며 생성자와 dispose에서 등록/해제를 짝지운다.
const liveViews = new Set<TerminalFontTarget>();

export function registerTerminalFontTarget(view: TerminalFontTarget): void {
  liveViews.add(view);
}

export function unregisterTerminalFontTarget(view: TerminalFontTarget): void {
  liveViews.delete(view);
}

export function terminalViewOptions(): {
  fontSize: number;
  fontFamily: string;
  theme: ITheme;
} {
  return { fontSize, fontFamily, theme: { ...TERMINAL_THEME } };
}

export function adjustFontSize(delta: number): void {
  applyFontSize(clampFontSize(fontSize + delta));
}

export function resetFontSize(): void {
  applyFontSize(baseFontSize);
}

function applyFontSize(size: number): void {
  if (size === fontSize) return;
  fontSize = size;
  for (const view of liveViews) view.setFontSize(size);
}

// 백엔드가 검증한 설정을 첫 뷰 생성 전에 한 번 적용한다.
export function applyTerminalSettings(settings: UiSettings): void {
  if (settings.fontFamily !== null) fontFamily = settings.fontFamily;
  if (settings.fontSize !== null) {
    fontSize = settings.fontSize;

    baseFontSize = settings.fontSize;
  }
}
