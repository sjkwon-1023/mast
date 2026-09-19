// ScrollMemory 검증 (ADR-0019 결정 3 + 2026-09-20 개정) — 기억·1회성 인출·프룬·
// 세션 일치·페이지 세션 저장소. 언제 기억할지(워크스페이스 이탈이냐 탭 닫힘이냐)의
// 판정은 호출자 몫이라 여기서 다루지 않는다 (view-reconcile 의 existingTabIds 테스트).
//
// 저장소를 끼우는 이유는 "리로드가 기억을 넘긴다"를 인스턴스 교체로 재현하기
// 위해서다 — 리로드 뒤 새 ScrollMemory 가 같은 저장소에서 읽는지가 이 개정의
// 계약이고, 그 경계(페이지 세션)는 sessionStorage 자체가 지킨다.

import { describe, expect, it, vi } from "vitest";

import { SCROLL_MEMORY_KEY, ScrollMemory } from "./scroll-memory";
import type { ScrollMemoryStorage } from "./scroll-memory";

class FakeStorage implements ScrollMemoryStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe("ScrollMemory", () => {
  it("기억한 위치를 그 탭으로 돌려준다", () => {
    const memory = new ScrollMemory(null);
    memory.remember(10, 100, 15);
    memory.remember(11, 100, 300);
    expect(memory.take(10, 100)).toBe(15);
    expect(memory.take(11, 100)).toBe(300);
  });

  it("기억이 없는 탭은 undefined — 평시 attach 가 이 경로다", () => {
    const memory = new ScrollMemory(null);
    expect(memory.take(10, 100)).toBeUndefined();
  });

  it("인출은 1회성이다 — 두 번째는 undefined", () => {
    // 복원이 취소되거나 attach 가 실패해도 낡은 위치가 다시 적용되지 않는다.
    const memory = new ScrollMemory(null);
    memory.remember(10, 100, 15);
    expect(memory.take(10, 100)).toBe(15);
    expect(memory.take(10, 100)).toBeUndefined();
  });

  it("같은 탭을 다시 기억하면 최근 값이 이긴다", () => {
    const memory = new ScrollMemory(null);
    memory.remember(10, 100, 15);
    memory.remember(10, 100, 40);
    expect(memory.take(10, 100)).toBe(40);
  });

  it("프룬은 스냅샷에 없는 탭의 기억만 걷는다", () => {
    // 비활성 워크스페이스에서 닫힌 탭은 dispose 루프를 타지 않아 여기서만 정리된다.
    const memory = new ScrollMemory(null);
    memory.remember(10, 100, 15);
    memory.remember(11, 100, 300);
    memory.prune(new Set([11]));
    expect(memory.take(10, 100)).toBeUndefined();
    expect(memory.take(11, 100)).toBe(300);
  });

  it("빈 스냅샷 프룬은 전부 걷는다", () => {
    const memory = new ScrollMemory(null);
    memory.remember(10, 100, 15);
    memory.prune(new Set());
    expect(memory.take(10, 100)).toBeUndefined();
  });

  it("세션이 바뀐 탭에는 옛 위치를 주지 않는다 — respawn·앱 재시작의 낡은 값", () => {
    const memory = new ScrollMemory(null);
    memory.remember(10, 100, 15);
    expect(memory.take(10, 200)).toBeUndefined();
    // 거절한 값은 다시 꺼내지지 않는다 (한 번의 기회).
    expect(memory.take(10, 100)).toBeUndefined();
  });
});

describe("ScrollMemory 저장소 (ADR-0019 개정 — 리로드 생존)", () => {
  it("리로드 뒤 새 인스턴스가 이전 페이지의 위치를 돌려준다", () => {
    // 이 개정의 사용자-visible 계약: 리셋 supervisor 의 자동 리로드·F5 를 넘어
    // 스크롤 위치가 살아남는다. 인스턴스 교체가 리로드(새 JS 컨텍스트)의 재현이다.
    const storage = new FakeStorage();
    const beforeReload = new ScrollMemory(storage);
    beforeReload.remember(7, 42, 20);

    const afterReload = new ScrollMemory(storage);
    expect(afterReload.take(7, 42)).toBe(20);
  });

  it("인출·프룬은 저장소에서도 걷는다 — 낡은 값이 다음 리로드로 새지 않게", () => {
    const storage = new FakeStorage();
    const memory = new ScrollMemory(storage);
    memory.remember(7, 42, 20);
    memory.remember(8, 42, 30);
    expect(memory.take(7, 42)).toBe(20);

    const reloaded = new ScrollMemory(storage);
    expect(reloaded.take(7, 42)).toBeUndefined();
    expect(reloaded.take(8, 42)).toBe(30);

    reloaded.prune(new Set());
    const reloadedAgain = new ScrollMemory(storage);
    expect(reloadedAgain.take(8, 42)).toBeUndefined();
  });

  it("세션이 다른 저장 값은 리로드 뒤에도 거절한다", () => {
    const storage = new FakeStorage();
    new ScrollMemory(storage).remember(7, 42, 20);
    expect(new ScrollMemory(storage).take(7, 99)).toBeUndefined();
    // 거절은 저장소에서도 지운다 — 다음 인스턴스가 다시 시도하지 않는다.
    expect(new ScrollMemory(storage).take(7, 42)).toBeUndefined();
  });

  it("손상된 저장 파일은 통째로 버리고 비운다", () => {
    const storage = new FakeStorage();
    storage.setItem(SCROLL_MEMORY_KEY, "{ not json");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const memory = new ScrollMemory(storage);
    expect(memory.take(7, 42)).toBeUndefined();
    expect(storage.getItem(SCROLL_MEMORY_KEY)).toBeNull();
    warned.mockRestore();
  });

  it("형식이 어긋난 항목은 버리고 나머지 값은 살린다", () => {
    const storage = new FakeStorage();
    storage.setItem(
      SCROLL_MEMORY_KEY,
      JSON.stringify({
        version: 1,
        entries: {
          "7": { session: 42, offset: 20 },
          "8": { session: "42", offset: 30 },
          "9": { session: 42, offset: -1 },
          bad: { session: 42, offset: 5 },
        },
      }),
    );
    const memory = new ScrollMemory(storage);
    expect(memory.take(7, 42)).toBe(20);
    expect(memory.take(8, 42)).toBeUndefined();
    expect(memory.take(9, 42)).toBeUndefined();
  });

  it("저장소가 던지는 환경은 메모리만으로 동작한다", () => {
    const broken: ScrollMemoryStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const memory = new ScrollMemory(broken);
    memory.remember(7, 42, 20);
    expect(memory.take(7, 42)).toBe(20);
    warned.mockRestore();
  });
});
