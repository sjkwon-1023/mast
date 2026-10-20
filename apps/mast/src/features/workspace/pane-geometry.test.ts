// pane 크기 보고의 순수 규칙 — DOM 없이 돈다. 실제 ResizeObserver 발화와 canvas 측정은
// pane-view.test.ts 가 PaneView 를 통해 잠근다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CellCache, PaneGeometryReporter, REPORT_DEBOUNCE_MS, fitGrid, measureCell } from "./pane-geometry";
import type { Cell, Grid } from "./pane-geometry";
import type { TerminalFont } from "../terminal/settings";

const CONSOLAS_13: TerminalFont = { family: "Consolas", size: 13, lineHeight: 1 };

describe("fitGrid", () => {
  it("floors the content size into whole cells", () => {
    expect(fitGrid(805, 610, { width: 8, height: 13 })).toEqual({ cols: 100, rows: 46 });
  });

  it("keeps FitAddon's minimum of 2 columns and 1 row for a box smaller than one cell", () => {
    expect(fitGrid(10, 10, { width: 8, height: 13 })).toEqual({ cols: 2, rows: 1 });
  });
});

describe("CellCache", () => {
  it("takes the height from the measurement, not the font size, and measures again only when the font or dpr changes", () => {
    // 높이를 글꼴 크기와 다르게 흉내 낸다 — 글꼴 크기를 그대로 쓰면 이 테스트가 깨진다.
    const measure = vi.fn((font: TerminalFont): Cell => ({ width: font.size / 2, height: font.size + 2 }));
    const cache = new CellCache(measure);
    expect(cache.get(CONSOLAS_13, 1)).toEqual({ width: 6.5, height: 15 });
    expect(cache.get(CONSOLAS_13, 1)).toEqual({ width: 6.5, height: 15 });
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith(CONSOLAS_13, 1);
    expect(cache.get({ ...CONSOLAS_13, size: 14 }, 1)).toEqual({ width: 7, height: 16 });
    expect(cache.get({ ...CONSOLAS_13, family: "Cascadia Mono", size: 14 }, 1)?.width).toBe(7);
    expect(cache.get({ ...CONSOLAS_13, family: "Cascadia Mono", size: 14 }, 1.25)?.width).toBe(7);
    expect(measure).toHaveBeenCalledTimes(4);
  });

  it("measures again after a measurement came back empty", () => {
    const measure = vi
      .fn<(font: TerminalFont, dpr: number) => Cell | null>()
      .mockReturnValueOnce(null)
      .mockReturnValue({ width: 6.5, height: 15 });
    const cache = new CellCache(measure);
    expect(cache.get(CONSOLAS_13, 1)).toBeNull();
    expect(cache.get(CONSOLAS_13, 1)).toEqual({ width: 6.5, height: 15 });
    expect(measure).toHaveBeenCalledTimes(2);
  });
});

describe("measureCell", () => {
  // 글자 지표를 canvas 가 준 값 그대로 흉내 낸다 (ascent + descent 가 글자 높이다).
  function stubCanvasMetrics(width: number, ascent: number, descent: number): void {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return {
            font: "",
            measureText: () => ({
              width,
              fontBoundingBoxAscent: ascent,
              fontBoundingBoxDescent: descent,
            }),
          };
        }
      },
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rounds the glyph height up to device pixels and applies the line height as the DOM renderer does", () => {
    stubCanvasMetrics(6.5, 10.2, 3.1);
    // 높이 13.3 → 배율 1 에서 14
    expect(measureCell(CONSOLAS_13, 1)).toEqual({ width: 6.5, height: 14 });
    // 배율 1.25 에서는 장치 픽셀 17 이고, 다시 CSS 픽셀로 13.6
    expect(measureCell(CONSOLAS_13, 1.25)).toEqual({ width: 6.5, height: 13.6 });
    // 줄 높이 1.2 는 14 × 1.2 = 16.8 을 내려 16
    expect(measureCell({ ...CONSOLAS_13, lineHeight: 1.2 }, 1)).toEqual({ width: 6.5, height: 16 });
  });

  it("returns null when the glyph has no size, so nothing is reported for it", () => {
    stubCanvasMetrics(0, 0, 0);
    expect(measureCell(CONSOLAS_13, 1)).toBeNull();
  });
});

describe("PaneGeometryReporter", () => {
  let current: Grid | null;
  let measure: () => Grid | null;

  beforeEach(() => {
    vi.useFakeTimers();
    current = { cols: 80, rows: 24 };
    measure = () => current;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 보내기마다 결과를 테스트가 고른다. `settle(ok)` 는 가장 오래된 전송을 성공 또는 실패로 끝낸다. */
  function manualSend() {
    const pending: Array<(ok: boolean) => void> = [];
    const send = vi.fn(
      (_grid: Grid) =>
        new Promise<void>((resolve, reject) => pending.push((ok) => (ok ? resolve() : reject(new Error("ipc down"))))),
    );
    const settle = async (ok: boolean) => {
      pending.shift()?.(ok);
      await vi.advanceTimersByTimeAsync(0);
    };
    return { send, settle };
  }

  it("starts without any timer", () => {
    const send = vi.fn(async () => undefined);
    new PaneGeometryReporter(measure, send);
    expect(vi.getTimerCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends once after a burst of notifications settles", async () => {
    const send = vi.fn(async () => undefined);
    const reporter = new PaneGeometryReporter(measure, send);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(100);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(100);
    reporter.schedule();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  it("sends nothing for a grid it already sent, and sends again when it changes", async () => {
    const send = vi.fn(async () => undefined);
    const reporter = new PaneGeometryReporter(measure, send);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);

    current = { cols: 100, rows: 24 };
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ cols: 100, rows: 24 });
  });

  it("keeps the last sent grid while the content cannot be measured", async () => {
    const send = vi.fn(async () => undefined);
    const reporter = new PaneGeometryReporter(measure, send);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);

    current = null;
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);

    // 측정이 비었던 동안 마지막 값은 지워지지 않았으므로, 같은 값이 돌아와도 다시 보내지 않는다.
    current = { cols: 80, rows: 24 };
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("logs a failed send and retries the same grid on the next measurement", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi
      .fn<(grid: Grid) => Promise<void>>()
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValue(undefined);
    const reporter = new PaneGeometryReporter(measure, send);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(error).toHaveBeenCalledWith("report_pane_geometry failed", expect.any(Error));

    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);

    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("waits for an in-flight report, then sends the grid measured after it lands", async () => {
    const gridA: Grid = { cols: 80, rows: 24 };
    const gridB: Grid = { cols: 100, rows: 24 };
    const landings: Array<() => void> = [];
    const send = vi.fn((_grid: Grid) => new Promise<void>((resolve) => landings.push(() => resolve())));
    const reporter = new PaneGeometryReporter(measure, send);
    const land = async () => {
      landings.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    };

    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenLastCalledWith(gridA);
    await land();

    // 1. A 가 끝났다. 2. B 를 보내고 응답을 기다린다.
    current = gridB;
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);

    // 3. B 가 끝나기 전에 크기가 C 를 거쳐 A 로 돌아온다. 보내는 중이므로 전송은 늘지 않는다.
    current = { cols: 120, rows: 24 };
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    current = gridA;
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);

    // 4. B 가 끝나면 서버에는 B 가 남았으므로 현재 측정값 A 를 다시 보낸다.
    await land();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(gridA);

    await land();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resends a size that changed while a report was in flight when that report fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { send, settle } = manualSend();
    const reporter = new PaneGeometryReporter(measure, send);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    await settle(true);

    // B 를 보내고 응답을 기다린다.
    current = { cols: 100, rows: 24 };
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);

    // B 가 끝나기 전에 C 로 바뀌고 debounce 가 끝난다. 보내는 중이므로 전송은 늘지 않는다.
    current = { cols: 120, rows: 24 };
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);

    // B 가 실패하면 새 크기 이벤트 없이 C 를 한 번 다시 예약해 보낸다.
    await settle(false);
    expect(error).toHaveBeenCalledWith("report_pane_geometry failed", expect.any(Error));
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith({ cols: 120, rows: 24 });

    await settle(true);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resend after a failed report when nothing changed while it was in flight", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { send, settle } = manualSend();
    const reporter = new PaneGeometryReporter(measure, send);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    await settle(true);

    current = { cols: 100, rows: 24 };
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    await settle(false);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS * 5);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not resend after a failed report when the size came back to the sent value", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { send, settle } = manualSend();
    const reporter = new PaneGeometryReporter(measure, send);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    await settle(true);

    current = { cols: 100, rows: 24 };
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    current = { cols: 120, rows: 24 };
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    current = { cols: 80, rows: 24 };
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);

    await settle(false);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("keeps no timer when an in-flight report settles after dispose (ok: %s)", async (ok) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { send, settle } = manualSend();
    const reporter = new PaneGeometryReporter(measure, send);
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);

    current = { cols: 100, rows: 24 };
    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);

    reporter.dispose();
    await settle(ok);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending report on dispose and ignores later notifications", async () => {
    const send = vi.fn(async () => undefined);
    const reporter = new PaneGeometryReporter(measure, send);
    reporter.schedule();
    expect(vi.getTimerCount()).toBe(1);
    reporter.dispose();
    expect(vi.getTimerCount()).toBe(0);

    reporter.schedule();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
