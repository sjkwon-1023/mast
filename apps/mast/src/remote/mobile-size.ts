// 폰 화면에 맞는 PTY 크기 계산 — **버튼을 누른 순간의 측정값으로 고정**된다.
//
// 키보드가 열리고 닫힐 때마다 크기를 다시 계산해 보내면 PTY 가 그때마다 resize 되고
// TUI 가 매번 처음부터 다시 그려진다 (입력칸이 화면 밖으로 밀리거나 커서가 튄다).
// 그래서 이 모듈은 visualViewport 의 변화를 **입력으로 받지 않는다** — 호출자는
// 버튼 클릭 핸들러뿐이고, 그 뒤의 키보드 전환은 아무것도 건드리지 않는다.

/** 하한·상한은 서버(`mast-remote::handlers`)의 클램프와 같은 값이다. 서버가 최종
 *  결정자이고 여기 값은 같은 결과를 미리 내기 위한 사본이다 — 어긋나도 화면은
 *  서버가 돌려준 크기로 그려진다 (meta 의 cols/rows). */
export const MIN_MOBILE_COLS = 20;
export const MAX_MOBILE_COLS = 400;
export const MIN_MOBILE_ROWS = 5;
export const MAX_MOBILE_ROWS = 150;

/** 오차 1열이면 TUI 가 정확히 `cols` 열로 그린 줄이 폰에서 한 번 더 접힌다 —
 *  구분선·표가 깨지는 바로 그 증상이라 한 열을 비워 둔다. */
const WIDTH_SLACK_COLS = 1;

/** 문자 폭 측정에 쓰는 표본 길이. 길수록 반올림 오차가 줄지만 그만큼 접힐 위험이
 *  커진다 — 폰 폭(수백 px)에서 32자는 안전하고 오차는 충분히 작다. */
const PROBE_CHARS = 32;

export interface MobileSize {
  cols: number;
  rows: number;
}

/** 측정값 → PTY 크기. 순수 함수다 (DOM 은 [`measureMobileSize`] 담당).
 *
 *  폰 폭·높이를 글자 격자로 나눈 값이고, 격자가 성립하지 않으면 null 이다 —
 *  호출자는 그때 크기를 지어내지 말고 안내를 띄운다. */
export function mobileSizeFor(
  widthPx: number,
  heightPx: number,
  charWidthPx: number,
  lineHeightPx: number,
): MobileSize | null {
  if (!(widthPx > 0) || !(heightPx > 0) || !(charWidthPx > 0) || !(lineHeightPx > 0)) {
    return null;
  }
  return {
    cols: clamp(Math.floor(widthPx / charWidthPx) - WIDTH_SLACK_COLS, MIN_MOBILE_COLS, MAX_MOBILE_COLS),
    rows: clamp(Math.floor(heightPx / lineHeightPx), MIN_MOBILE_ROWS, MAX_MOBILE_ROWS),
  };
}

/** 출력 영역(`output`)과 그 안의 `<pre>` 에서 지금 보이는 글자 격자를 잰다.
 *
 *  문자 폭은 `<pre>` 안에 숨은 표본을 잠깐 넣어 잰다 — 글꼴·크기가 `<pre>` 에서
 *  상속되므로 A−/A+ 로 글자 크기를 바꾼 뒤에도 같은 격자가 나온다.
 *  줄 높이는 계산된 스타일에서 읽는다 (`line-height: normal` 이면 null). */
export function measureMobileSize(output: HTMLElement, pre: HTMLElement): MobileSize | null {
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(PROBE_CHARS);
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  pre.append(probe);
  const probeWidth = probe.getBoundingClientRect().width / PROBE_CHARS;
  probe.remove();

  const lineHeight = Number.parseFloat(window.getComputedStyle(pre).lineHeight);
  // 폭은 `pre` 의 실제 폭(스크롤바가 있으면 그만큼 좁다)을, 높이는 보이는 출력
  // 영역의 높이를 쓴다 — 사용자가 실제로 볼 수 있는 격자라야 CSS 가 한 번 더
  // 접지 않는다.
  return mobileSizeFor(
    pre.getBoundingClientRect().width,
    output.getBoundingClientRect().height,
    probeWidth,
    lineHeight,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
