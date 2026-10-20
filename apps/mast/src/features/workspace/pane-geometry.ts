// pane 크기 보고 — `mast layout` 이 돌려줄 표시 칸 수를 백엔드에 알린다.
// 칸 수를 정하는 일은 PaneView 가 맡는다 (터미널은 xterm 칸 수, 뷰어·빈 pane 은 셀 환산).
// 여기에는 셀 측정, debounce, 중복 억제, dispose 정리만 있다. 타이머는 발화가 있을 때만 생긴다.

import type { TerminalFont } from "../terminal/settings";

/** 마지막 크기 변화 뒤 이 시간이 지나야 잰다. fit 은 rAF 한 프레임 뒤에 돌므로 그보다 늦어야 xterm 칸 수가 맞다. */
export const REPORT_DEBOUNCE_MS = 200;

/** DOM 폴백이 글자 폭을 재는 길이 — xterm 의 DomMeasureStrategy 와 같다. */
const DOM_MEASURE_REPEAT = 32;

export interface Grid {
  cols: number;
  rows: number;
}

/** 글꼴 한 칸의 CSS 픽셀 크기. */
export interface Cell {
  width: number;
  height: number;
}

interface Glyph {
  width: number;
  height: number;
}

/**
 * 글꼴 한 칸을 xterm 과 같은 식으로 잰다. xterm 은 canvas 글자 지표를 먼저 쓰고 없을 때만 DOM 을 쓰므로
 * 같은 순서를 따른다. 크기가 나오지 않으면(글꼴 없음 등) null 이다.
 */
export function measureCell(font: TerminalFont, dpr: number): Cell | null {
  const glyph = measureGlyphOnCanvas(font) ?? measureGlyphInDom(font);
  if (glyph.width <= 0 || glyph.height <= 0) return null;
  // DomRenderer 와 같다: 글자 높이를 장치 픽셀로 올리고, 줄 높이를 곱한 뒤 내린다.
  return {
    width: glyph.width,
    height: Math.floor(Math.ceil(glyph.height * dpr) * font.lineHeight) / dpr,
  };
}

/** xterm 의 TextMetricsMeasureStrategy 와 같다. 이 지표를 지원하지 않는 환경이면 null 이다. */
function measureGlyphOnCanvas(font: TerminalFont): Glyph | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const context = new OffscreenCanvas(100, 100).getContext("2d");
  if (context === null) return null;
  context.font = `${font.size}px ${font.family}`;
  const metrics = context.measureText("W");
  if (typeof metrics.fontBoundingBoxAscent !== "number" || typeof metrics.fontBoundingBoxDescent !== "number") {
    return null;
  }
  return { width: metrics.width, height: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent };
}

/** canvas 지표가 없을 때의 폴백 — xterm 의 DomMeasureStrategy 와 같은 span 을 잠깐 붙여 잰 뒤 바로 뗀다. */
function measureGlyphInDom(font: TerminalFont): Glyph {
  const probe = document.createElement("span");
  probe.textContent = "W".repeat(DOM_MEASURE_REPEAT);
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;top:0;left:-9999em;visibility:hidden;line-height:normal;white-space:pre;font-kerning:none";
  probe.style.fontFamily = font.family;
  probe.style.fontSize = `${font.size}px`;
  document.body.append(probe);
  try {
    return { width: probe.offsetWidth / DOM_MEASURE_REPEAT, height: probe.offsetHeight };
  } finally {
    probe.remove();
  }
}

/** 글꼴·줄 높이·배율이 바뀔 때만 셀을 다시 잰다. 측정이 실패하면 값을 남기지 않아 다음 호출에 다시 잰다. */
export class CellCache {
  private key: string | null = null;
  private cell: Cell | null = null;

  constructor(private readonly measure: (font: TerminalFont, dpr: number) => Cell | null = measureCell) {}

  get(font: TerminalFont, dpr: number): Cell | null {
    const key = `${font.size}px ${font.family} lh${font.lineHeight} dpr${dpr}`;
    if (this.cell === null || key !== this.key) {
      this.key = key;
      this.cell = this.measure(font, dpr);
    }
    return this.cell;
  }
}

/** xterm FitAddon 이 scrollback 이 있는 터미널의 폭에서 빼는 스크롤바 폭이다 (xterm 의 DEFAULT_SCROLL_BAR_WIDTH 14px 와 같다). */
export const TERMINAL_SCROLLBAR_WIDTH = 14;

// xterm FitAddon 의 MINIMUM_COLS·MINIMUM_ROWS 와 같다 — 뷰어·빈 pane 도 터미널과 같은 하한을 쓴다.
const MIN_COLS = 2;
const MIN_ROWS = 1;

/** 콘텐츠 영역을 셀로 나눠 내림한 칸 수이고 FitAddon 의 하한을 적용한다. 0×0 인지 가리는 것은 호출자 몫이다. */
export function fitGrid(width: number, height: number, cell: Cell): Grid {
  return {
    cols: Math.max(MIN_COLS, Math.floor(width / cell.width)),
    rows: Math.max(MIN_ROWS, Math.floor(height / cell.height)),
  };
}

function sameGrid(a: Grid, b: Grid | null): boolean {
  return b !== null && a.cols === b.cols && a.rows === b.rows;
}

/** pane 하나의 보고 상태. 대기 중인 timer, 보내는 중인지, 보내는 중에 들어온 보고가 있는지, 마지막으로 성공한 값만 든다. */
export class PaneGeometryReporter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sent: Grid | null = null;
  private sending = false;
  private pendingChange = false;
  private disposed = false;

  constructor(
    private readonly measure: () => Grid | null,
    private readonly send: (grid: Grid) => Promise<void>,
  ) {}

  /** ResizeObserver 발화마다 부른다. 마지막 호출 뒤 REPORT_DEBOUNCE_MS 가 지나야 잰다. */
  schedule(): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.report();
    }, REPORT_DEBOUNCE_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * 성공한 값만 기억한다 — 실패한 보고는 같은 칸 수라도 다음 측정에서 다시 보낸다.
   * 보내는 중에 또 보내면 늦게 도착한 옛 값이 서버에 남으므로, 보내는 중의 보고는 표시만 남기고 끝난 뒤에 처리한다.
   * 성공하면 현재 측정값과 비교해 다르면 다시 예약하고, 실패하면 표시가 있을 때만 한 번 다시 예약한다.
   */
  private report(): void {
    if (this.sending) {
      this.pendingChange = true;
      return;
    }
    const grid = this.measure();
    if (grid === null || sameGrid(grid, this.sent)) return;
    this.sending = true;
    this.send(grid).then(
      () => {
        this.sent = grid;
        this.sending = false;
        this.pendingChange = false;
        const current = this.measure();
        if (current !== null && !sameGrid(current, grid)) this.schedule();
      },
      (err: unknown) => {
        this.sending = false;
        console.error("report_pane_geometry failed", err);
        if (this.pendingChange) {
          this.pendingChange = false;
          this.schedule();
        }
      },
    );
  }
}
