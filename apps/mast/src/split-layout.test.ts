// split-layout 순수 함수 검증 — structureKey 구조 동일성, ratioFromPointer
// 클램프 경계(양끝·minPanePx > rect 절반·퇴화 rect), flexPair.

import { describe, expect, it } from "vitest";

import { flexPair, ratioFromPointer, structureKey } from "./split-layout";
import type { LayoutRect } from "./split-layout";
import type { SplitTree } from "./types";

function leaf(pane: number): SplitTree {
  return { type: "leaf", pane };
}

function split(
  id: number,
  direction: "horizontal" | "vertical",
  ratio: number,
  first: SplitTree,
  second: SplitTree,
): SplitTree {
  return { type: "split", id, direction, ratio, first, second };
}

describe("structureKey", () => {
  it("serializes leaves and splits deterministically", () => {
    expect(structureKey(leaf(2))).toBe("L2");
    expect(structureKey(split(10, "horizontal", 0.5, leaf(1), leaf(2)))).toBe("S10h(L1,L2)");
  });

  it("ignores ratio changes (in-place update path)", () => {
    const a = split(10, "horizontal", 0.5, leaf(1), leaf(2));
    const b = split(10, "horizontal", 0.31, leaf(1), leaf(2));
    expect(structureKey(a)).toBe(structureKey(b));
  });

  it("distinguishes split id, direction, leaf panes, and nesting shape", () => {
    const base = split(10, "horizontal", 0.5, leaf(1), leaf(2));
    expect(structureKey(split(11, "horizontal", 0.5, leaf(1), leaf(2)))).not.toBe(
      structureKey(base),
    );
    expect(structureKey(split(10, "vertical", 0.5, leaf(1), leaf(2)))).not.toBe(
      structureKey(base),
    );
    expect(structureKey(split(10, "horizontal", 0.5, leaf(1), leaf(3)))).not.toBe(
      structureKey(base),
    );
    // 중첩 위치가 다르면 (first 쪽 vs second 쪽) 키도 달라야 한다.
    const inner = split(11, "vertical", 0.5, leaf(2), leaf(3));
    expect(structureKey(split(10, "horizontal", 0.5, inner, leaf(1)))).not.toBe(
      structureKey(split(10, "horizontal", 0.5, leaf(1), inner)),
    );
  });

  it("keys deeply nested trees", () => {
    const tree = split(
      10,
      "horizontal",
      0.4,
      split(11, "vertical", 0.6, leaf(1), leaf(2)),
      leaf(3),
    );
    expect(structureKey(tree)).toBe("S10h(S11v(L1,L2),L3)");
  });
});

describe("ratioFromPointer", () => {
  const rect: LayoutRect = { left: 100, top: 50, width: 800, height: 600 };
  const MIN = 80;

  it("maps the pointer linearly along the direction axis", () => {
    expect(ratioFromPointer(rect, { x: 500, y: 0 }, "horizontal", MIN)).toBe(0.5);
    expect(ratioFromPointer(rect, { x: 300, y: 0 }, "horizontal", MIN)).toBe(0.25);
    // vertical 은 y·top·height 축을 쓴다 — x 는 무시된다.
    expect(ratioFromPointer(rect, { x: 0, y: 200 }, "vertical", MIN)).toBe(0.25);
    expect(ratioFromPointer(rect, { x: 0, y: 350 }, "vertical", MIN)).toBe(0.5);
  });

  it("clamps both ends to the minPanePx bound", () => {
    // raw 0 (rect 시작) → lo = 80/800 = 0.1
    expect(ratioFromPointer(rect, { x: 100, y: 0 }, "horizontal", MIN)).toBe(0.1);
    // rect 밖 (음수 raw)도 같은 하한으로.
    expect(ratioFromPointer(rect, { x: -50, y: 0 }, "horizontal", MIN)).toBe(0.1);
    // raw > 1 → hi = 1 - 0.1 = 0.9
    expect(ratioFromPointer(rect, { x: 2000, y: 0 }, "horizontal", MIN)).toBe(0.9);
  });

  it("guarantees the open interval even with minPanePx 0", () => {
    const atStart = ratioFromPointer(rect, { x: 100, y: 0 }, "horizontal", 0);
    const atEnd = ratioFromPointer(rect, { x: 900, y: 0 }, "horizontal", 0);
    expect(atStart).toBeGreaterThan(0);
    expect(atEnd).toBeLessThan(1);
  });

  it("falls back to 0.5 when minPanePx exceeds half the span", () => {
    // span 800 의 절반(400) 초과 — 양쪽 최소를 동시에 만족 불가.
    expect(ratioFromPointer(rect, { x: 150, y: 0 }, "horizontal", 401)).toBe(0.5);
    expect(ratioFromPointer(rect, { x: 850, y: 0 }, "horizontal", 401)).toBe(0.5);
    // 정확히 절반이면 유일해(0.5)로 수렴한다.
    expect(ratioFromPointer(rect, { x: 150, y: 0 }, "horizontal", 400)).toBe(0.5);
  });

  it("falls back to 0.5 on degenerate rects and non-finite input", () => {
    const zero: LayoutRect = { left: 0, top: 0, width: 0, height: 0 };
    expect(ratioFromPointer(zero, { x: 10, y: 10 }, "horizontal", MIN)).toBe(0.5);
    expect(ratioFromPointer(zero, { x: 10, y: 10 }, "vertical", MIN)).toBe(0.5);
    expect(ratioFromPointer(rect, { x: Number.NaN, y: 0 }, "horizontal", MIN)).toBe(0.5);
  });
});

describe("flexPair", () => {
  it("splits grow weights as ratio : 1 - ratio", () => {
    expect(flexPair(0.25)).toEqual({ first: 0.25, second: 0.75 });
    expect(flexPair(0.5)).toEqual({ first: 0.5, second: 0.5 });
  });
});
