// store 검증 — revision 가드(순수 함수)와 Store.offer 의 stale 폐기·구독 통지.

import { describe, expect, it } from "vitest";

import { Store, shouldAdopt } from "./store";
import type { StateSnapshot } from "./types";

/** 최소 스냅샷 픽스처 — 가드는 revision 만 본다. */
function snap(revision: number): StateSnapshot {
  return {
    revision,
    state: { workspaces: [], activeWorkspace: null, nextId: 1, revision },
  };
}

describe("shouldAdopt", () => {
  it("adopts the first snapshot regardless of revision", () => {
    expect(shouldAdopt(null, 0)).toBe(true);
    expect(shouldAdopt(null, 7)).toBe(true);
  });

  it("adopts only strictly newer revisions", () => {
    expect(shouldAdopt(5, 6)).toBe(true);
    expect(shouldAdopt(5, 5)).toBe(false); // 동일 revision 재수신 → 폐기
    expect(shouldAdopt(5, 4)).toBe(false); // 늦게 도착한 stale → 폐기
    expect(shouldAdopt(0, 0)).toBe(false);
  });
});

describe("Store.offer", () => {
  it("adopts the first snapshot and notifies subscribers", () => {
    const store = new Store();
    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.revision));
    store.offer(snap(3));
    expect(seen).toEqual([3]);
    expect(store.snapshot?.revision).toBe(3);
  });

  it("drops stale and equal revisions without notifying", () => {
    const store = new Store();
    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.revision));
    store.offer(snap(5));
    store.offer(snap(4)); // stale — get_state 응답이 이벤트보다 늦은 경우
    store.offer(snap(5)); // 동일 revision 재수신
    expect(seen).toEqual([5]);
    expect(store.snapshot?.revision).toBe(5);
  });

  it("adopts newer revisions in order", () => {
    const store = new Store();
    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.revision));
    store.offer(snap(1));
    store.offer(snap(2));
    store.offer(snap(9));
    expect(seen).toEqual([1, 2, 9]);
  });

  it("replays the current snapshot to a late subscriber", () => {
    const store = new Store();
    store.offer(snap(2));
    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.revision));
    expect(seen).toEqual([2]);
  });

  it("stops notifying after unsubscribe", () => {
    const store = new Store();
    const seen: number[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s.revision));
    store.offer(snap(1));
    unsubscribe();
    store.offer(snap(2));
    expect(seen).toEqual([1]);
    expect(store.snapshot?.revision).toBe(2); // 스냅샷 자체는 계속 갱신된다
  });
});
