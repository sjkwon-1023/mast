// AckBatcher 배칭 경계·타이머 동작 검증 — 주입한 fake timer로 결정적으로 테스트한다.

import { describe, expect, it } from "vitest";

import { AckBatcher, DEFAULT_ACK_THRESHOLD_BYTES } from "./ack-batcher";
import type { TimerHost } from "./ack-batcher";

/** 수동 진행식 fake timer — advance(ms)로 만기 콜백을 순서대로 실행한다. */
class FakeTimers implements TimerHost {
  now = 0;
  private scheduled: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.scheduled.push({ id, at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled = this.scheduled.filter((t) => t.id !== handle);
  }

  advance(ms: number): void {
    this.now += ms;
    const due = this.scheduled
      .filter((t) => t.at <= this.now)
      .sort((a, b) => a.at - b.at);
    this.scheduled = this.scheduled.filter((t) => t.at > this.now);
    for (const t of due) t.fn();
  }

  get pendingCount(): number {
    return this.scheduled.length;
  }
}

function setup(options: { thresholdBytes?: number; maxDelayMs?: number } = {}): {
  timers: FakeTimers;
  flushes: number[];
  batcher: AckBatcher;
} {
  const timers = new FakeTimers();
  const flushes: number[] = [];
  const batcher = new AckBatcher((n) => flushes.push(n), { ...options, timers });
  return { timers, flushes, batcher };
}

describe("AckBatcher", () => {
  it("does not flush below the threshold before the delay elapses", () => {
    const { timers, flushes, batcher } = setup();
    batcher.add(1000);
    timers.advance(49);
    expect(flushes).toEqual([]);
    expect(batcher.pendingBytes).toBe(1000);
  });

  it("flushes accumulated bytes when 50ms elapse", () => {
    const { timers, flushes, batcher } = setup();
    batcher.add(1000);
    batcher.add(500);
    timers.advance(50);
    expect(flushes).toEqual([1500]);
    expect(batcher.pendingBytes).toBe(0);
  });

  it("flushes immediately at exactly 64KB and cancels the timer", () => {
    const { timers, flushes, batcher } = setup();
    batcher.add(DEFAULT_ACK_THRESHOLD_BYTES);
    expect(flushes).toEqual([DEFAULT_ACK_THRESHOLD_BYTES]);
    // 즉시 flush 후 남은 타이머가 없어야 하고, 시간이 지나도 재flush가 없어야 한다
    expect(timers.pendingCount).toBe(0);
    timers.advance(50);
    expect(flushes).toEqual([DEFAULT_ACK_THRESHOLD_BYTES]);
  });

  it("flushes the running total when multiple adds cross the threshold", () => {
    const { flushes, batcher } = setup({ thresholdBytes: 100 });
    batcher.add(60);
    batcher.add(60);
    expect(flushes).toEqual([120]);
  });

  it("keeps the delay anchored to the first unflushed byte", () => {
    const { timers, flushes, batcher } = setup();
    batcher.add(100);
    timers.advance(30);
    batcher.add(200);
    // 두 번째 add가 타이머를 연장하지 않으므로 첫 add로부터 50ms에 flush된다
    timers.advance(20);
    expect(flushes).toEqual([300]);
  });

  it("starts a new delay window after a flush", () => {
    const { timers, flushes, batcher } = setup();
    batcher.add(100);
    timers.advance(50);
    expect(flushes).toEqual([100]);
    batcher.add(200);
    timers.advance(49);
    expect(flushes).toEqual([100]);
    timers.advance(1);
    expect(flushes).toEqual([100, 200]);
  });

  it("ignores zero and negative byte counts", () => {
    const { timers, flushes, batcher } = setup();
    batcher.add(0);
    batcher.add(-5);
    expect(batcher.pendingBytes).toBe(0);
    expect(timers.pendingCount).toBe(0);
    timers.advance(100);
    expect(flushes).toEqual([]);
  });

  it("manual flush emits the pending total and cancels the timer", () => {
    const { timers, flushes, batcher } = setup();
    batcher.add(700);
    batcher.flush();
    expect(flushes).toEqual([700]);
    expect(timers.pendingCount).toBe(0);
    timers.advance(50);
    expect(flushes).toEqual([700]);
  });

  it("manual flush with nothing pending does not call the callback", () => {
    const { flushes, batcher } = setup();
    batcher.flush();
    expect(flushes).toEqual([]);
  });

  it("dispose flushes the remainder and makes further adds no-ops", () => {
    const { timers, flushes, batcher } = setup();
    batcher.add(300);
    batcher.dispose();
    expect(flushes).toEqual([300]);
    batcher.add(999);
    timers.advance(100);
    expect(flushes).toEqual([300]);
    expect(batcher.pendingBytes).toBe(0);
  });

  it("rejects a non-positive threshold", () => {
    expect(() => new AckBatcher(() => undefined, { thresholdBytes: 0 })).toThrow();
  });
});
