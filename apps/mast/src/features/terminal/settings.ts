import { IS_MAC } from "../../shared/platform";
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

const DEFAULT_FONT_FAMILY = IS_MAC ? "Menlo, 'SFMono-Regular', monospace" : "Consolas, 'Cascadia Mono', monospace";

const DEFAULT_FONT_SIZE = 13;

// 줌은 세션 한정이다. baseFontSize는 설정에서 읽은 리셋 기준값을 유지한다.
let fontFamily = DEFAULT_FONT_FAMILY;

let fontSize = DEFAULT_FONT_SIZE;

let baseFontSize = DEFAULT_FONT_SIZE;

// macOS 에서 Option 을 Meta(ESC 접두)로 쓸지 — settings.json `macOptionIsMeta`, 기본 false.
// false 면 Option 은 macOS 문자 입력(예: Option+2 = ™)이다. Windows 는 읽지 않는다.
let macOptionIsMeta = false;

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

export function terminalViewOptions(mac = IS_MAC): {
  fontSize: number;
  fontFamily: string;
  theme: ITheme;
  macOptionIsMeta?: boolean;
  macOptionClickForcesSelection?: boolean;
} {
  const base = { fontSize, fontFamily, theme: { ...TERMINAL_THEME } };
  if (!mac) return base;
  // 마우스를 추적하는 TUI 안에서도 Option+드래그로 텍스트를 선택할 수 있게 한다
  // (Terminal.app·iTerm2 관례). Windows 는 Shift+드래그가 같은 일을 하고 여기서 바꾸지 않는다.
  return { ...base, macOptionIsMeta, macOptionClickForcesSelection: true };
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
  if (settings.macOptionIsMeta !== null) macOptionIsMeta = settings.macOptionIsMeta;
  if (settings.fontSize !== null) {
    fontSize = settings.fontSize;

    baseFontSize = settings.fontSize;
  }
}
