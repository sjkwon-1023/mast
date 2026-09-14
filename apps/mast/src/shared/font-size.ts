// 백엔드 commands.rs FONT_SIZE_RANGE와 범위를 맞춘다. 터미널·뷰어가 함께 쓴다.
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 72;

export function clampFontSize(size: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}
