// 탭 화면의 텍스트 렌더링에 딸린 순수 판정 — 버퍼 줄을 화면 텍스트로 접는 규칙과
// 글자 크기의 범위. I/O 도 DOM 도 없다.
//
// 폰은 PTY 의 열 수(데스크톱 크기)를 그대로 그리면 가로로 넘친다. xterm 을 화면
// **모델**로만 쓰고 그 버퍼의 줄들을 줄바꿈되는 텍스트로 그리면 세로 스크롤만
// 남는다 — 색과 상자 그리기 정렬을 잃는 대신 손가락으로 읽을 수 있는 화면이 된다.

/** 화면에 남기는 최대 줄 수 — 뷰포트 + 최근 스크롤백. 그 이상은 폰에서 읽지 않는다. */
export const MAX_SCREEN_LINES = 400;

export const MIN_FONT_PX = 10;
export const MAX_FONT_PX = 22;
export const DEFAULT_FONT_PX = 13;
export const FONT_STEP_PX = 1;

export function clampFontPx(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_FONT_PX;
  return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, Math.round(px)));
}

/** 버퍼에서 화면으로 옮길 줄의 구간 `[start, end)` — 마지막 `max` 줄. */
export function tailRange(total: number, max: number): [number, number] {
  const end = Math.max(0, total);
  return [Math.max(0, end - max), end];
}

/** TUI 뷰포트의 아랫부분은 대개 빈 줄이다 — 끝의 빈 줄을 잘라 화면을 짧게 만든다.
 *  줄 사이의 빈 줄은 내용이므로 남긴다. */
export function trimTrailingBlank(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(0, end);
}
