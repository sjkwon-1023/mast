import { describe, expect, it } from "vitest";

import {
  clampFontPx,
  DEFAULT_FONT_PX,
  joinWrappedRows,
  MAX_FONT_PX,
  MIN_FONT_PX,
  tailRange,
  trimTrailingBlank,
} from "./screen-text";

describe("screen text", () => {
  it("trims trailing blank lines but keeps blank lines in the middle", () => {
    expect(trimTrailingBlank(["a", "", "b", "   ", ""])).toEqual(["a", "", "b"]);
    expect(trimTrailingBlank(["", ""])).toEqual([]);
    expect(trimTrailingBlank([])).toEqual([]);
  });

  it("takes the last max lines of the buffer", () => {
    expect(tailRange(10, 4)).toEqual([6, 10]);
    expect(tailRange(3, 4)).toEqual([0, 3]);
    expect(tailRange(0, 4)).toEqual([0, 0]);
  });

  it("joins rows the terminal wrapped and keeps the others apart", () => {
    // 4열 터미널이 "abcdefgh ij" 를 세 행으로 접은 모양.
    const rows = [
      { text: "abcd", wrapped: false },
      { text: "efgh", wrapped: true },
      { text: " ij ", wrapped: true },
      { text: "k   ", wrapped: false },
    ];
    expect(joinWrappedRows(rows)).toEqual(["abcdefgh ij", "k"]);
  });

  it("keeps the spaces at a wrap point and trims only the end of a logical line", () => {
    const rows = [
      { text: "ab  ", wrapped: false },
      { text: "  cd", wrapped: true },
    ];
    expect(joinWrappedRows(rows)).toEqual(["ab    cd"]);
  });

  it("starts a new line when the window opens on a wrapped row", () => {
    const rows = [
      { text: "tail", wrapped: true },
      { text: "next", wrapped: false },
    ];
    expect(joinWrappedRows(rows)).toEqual(["tail", "next"]);
    expect(joinWrappedRows([])).toEqual([]);
  });

  it("clamps the font size and falls back to the default for garbage", () => {
    expect(clampFontPx(MIN_FONT_PX - 5)).toBe(MIN_FONT_PX);
    expect(clampFontPx(MAX_FONT_PX + 5)).toBe(MAX_FONT_PX);
    expect(clampFontPx(14.6)).toBe(15);
    expect(clampFontPx(Number.NaN)).toBe(DEFAULT_FONT_PX);
  });
});
