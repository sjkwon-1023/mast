// ScrollMemory 검증 (ADR-0019 결정 3) — 기억·1회성 인출·프룬. 언제 기억할지
// (워크스페이스 이탈이냐 탭 닫힘이냐)의 판정은 호출자 몫이라 여기서 다루지 않는다
// (view-reconcile 의 existingTabIds 테스트).

import { describe, expect, it } from "vitest";

import { ScrollMemory } from "./scroll-memory";

describe("ScrollMemory", () => {
  it("기억한 위치를 그 탭으로 돌려준다", () => {
    const memory = new ScrollMemory();
    memory.remember(10, 15);
    memory.remember(11, 300);
    expect(memory.take(10)).toBe(15);
    expect(memory.take(11)).toBe(300);
  });

  it("기억이 없는 탭은 undefined — 평시 attach 가 이 경로다", () => {
    const memory = new ScrollMemory();
    expect(memory.take(10)).toBeUndefined();
  });

  it("인출은 1회성이다 — 두 번째는 undefined", () => {
    // 복원이 취소되거나 attach 가 실패해도 낡은 위치가 다시 적용되지 않는다.
    const memory = new ScrollMemory();
    memory.remember(10, 15);
    expect(memory.take(10)).toBe(15);
    expect(memory.take(10)).toBeUndefined();
  });

  it("같은 탭을 다시 기억하면 최근 값이 이긴다", () => {
    const memory = new ScrollMemory();
    memory.remember(10, 15);
    memory.remember(10, 40);
    expect(memory.take(10)).toBe(40);
  });

  it("프룬은 스냅샷에 없는 탭의 기억만 걷는다", () => {
    // 비활성 워크스페이스에서 닫힌 탭은 dispose 루프를 타지 않아 여기서만 정리된다.
    const memory = new ScrollMemory();
    memory.remember(10, 15);
    memory.remember(11, 300);
    memory.prune(new Set([11]));
    expect(memory.take(10)).toBeUndefined();
    expect(memory.take(11)).toBe(300);
  });

  it("빈 스냅샷 프룬은 전부 걷는다", () => {
    const memory = new ScrollMemory();
    memory.remember(10, 15);
    memory.prune(new Set());
    expect(memory.take(10)).toBeUndefined();
  });
});
