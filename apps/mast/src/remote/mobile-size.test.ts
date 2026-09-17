import { describe, expect, it } from "vitest";

import {
  MAX_MOBILE_COLS,
  MAX_MOBILE_ROWS,
  MIN_MOBILE_COLS,
  MIN_MOBILE_ROWS,
  mobileSizeFor,
} from "./mobile-size";

describe("mobileSizeFor", () => {
  it("fits the phone grid with one column of slack", () => {
    // 390px 폭에 8px 문자 → 48.75 → 48열이지만, 정확히 48열로 그린 TUI 줄이 CSS 에서
    // 한 번 더 접히지 않도록 한 열을 비운다. 높이는 600 / 17 = 35행.
    expect(mobileSizeFor(390, 600, 8, 17)).toEqual({ cols: 47, rows: 35 });
  });

  it("clamps to the server's bounds", () => {
    expect(mobileSizeFor(120, 40, 8, 17)).toEqual({
      cols: MIN_MOBILE_COLS,
      rows: MIN_MOBILE_ROWS,
    });
    expect(mobileSizeFor(8000, 12000, 8, 17)).toEqual({
      cols: MAX_MOBILE_COLS,
      rows: MAX_MOBILE_ROWS,
    });
  });

  it("refuses a grid it cannot measure", () => {
    for (const [w, h, cw, lh] of [
      [0, 600, 8, 17],
      [390, 0, 8, 17],
      [390, 600, 0, 17],
      [390, 600, 8, 0],
      [Number.NaN, 600, 8, 17],
      [390, 600, Number.NaN, 17],
    ]) {
      expect(mobileSizeFor(w, h, cw, lh)).toBeNull();
    }
  });
});
