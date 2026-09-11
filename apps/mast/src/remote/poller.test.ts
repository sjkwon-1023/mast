import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PollSchedule, RATE_LIMIT_PAUSE_MS } from "./poller";

const INTERVAL = 2000;

/** 각 폴의 resolve 를 테스트가 쥐고 있는 스케줄 — 인-플라이트 구간을 직접
 *  만들 수 있어야 겹침 금지를 단언할 수 있다. */
function harness() {
  const generations: number[] = [];
  const pending: (() => void)[] = [];
  const schedule = new PollSchedule({
    intervalMs: INTERVAL,
    poll: (generation) => {
      generations.push(generation);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
  });
  return {
    schedule,
    generations,
    get calls() {
      return generations.length;
    },
    /** 미결 폴을 전부 정착시키고 마이크로태스크를 흘린다. */
    async settle() {
      for (const resolve of pending.splice(0)) resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PollSchedule", () => {
  it("polls at the interval while visible", async () => {
    const h = harness();
    h.schedule.start();
    expect(h.calls).toBe(1);
    await h.settle();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(h.calls).toBe(2);
    await h.settle();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(h.calls).toBe(3);
  });

  it("stops while hidden", async () => {
    const h = harness();
    h.schedule.start();
    await h.settle();
    h.schedule.setVisible(false);
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(h.calls).toBe(1);
  });

  it("polls once immediately on return to visible", async () => {
    const h = harness();
    h.schedule.start();
    await h.settle();
    h.schedule.setVisible(false);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(h.calls).toBe(1);
    h.schedule.setVisible(true);
    expect(h.calls).toBe(2);
  });

  it("does not overlap an in-flight request", async () => {
    const h = harness();
    h.schedule.start();
    expect(h.calls).toBe(1);
    // 응답을 붙잡아 둔 채 시간을 흘린다 — 다음 폴은 나가지 않아야 한다.
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(h.calls).toBe(1);
    await h.settle();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(h.calls).toBe(2);
  });

  it("a stale generation reply is ignored", async () => {
    const h = harness();
    h.schedule.start();
    const sent = h.generations[0];
    expect(h.schedule.isCurrent(sent)).toBe(true);
    const fresh = h.schedule.bumpGeneration();
    expect(h.schedule.isCurrent(sent)).toBe(false);
    expect(h.schedule.isCurrent(fresh)).toBe(true);
    await h.settle();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(h.generations[1]).toBe(fresh);
  });

  it("pollNow fires at once when nothing is in flight", async () => {
    const h = harness();
    h.schedule.start();
    await h.settle();
    expect(h.calls).toBe(1);
    h.schedule.pollNow();
    expect(h.calls).toBe(2);
  });

  it("pollNow during a request runs once as soon as it settles", async () => {
    const h = harness();
    h.schedule.start();
    expect(h.calls).toBe(1);
    // 응답을 붙잡은 채로 요청한다 — 겹쳐 쏘지 않는다.
    h.schedule.pollNow();
    h.schedule.pollNow();
    expect(h.calls).toBe(1);
    await h.settle();
    // 간격을 기다리지 않고, 밀린 요청 하나만 나간다.
    expect(h.calls).toBe(2);
    await h.settle();
    expect(h.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(h.calls).toBe(3);
  });

  it("pollNow is ignored while hidden or stopped", async () => {
    const h = harness();
    h.schedule.start();
    await h.settle();
    h.schedule.setVisible(false);
    h.schedule.pollNow();
    expect(h.calls).toBe(1);
    h.schedule.setVisible(true);
    expect(h.calls).toBe(2);
    await h.settle();
    h.schedule.stop();
    h.schedule.pollNow();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(h.calls).toBe(2);
  });

  it("a 401 stops the schedule", async () => {
    const halts: string[] = [];
    const generations: number[] = [];
    const schedule = new PollSchedule({
      intervalMs: INTERVAL,
      poll: (generation) => {
        generations.push(generation);
        schedule.noteStatus(401);
        return Promise.resolve();
      },
      onHalt: (reason) => halts.push(reason),
    });
    schedule.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 10);
    expect(generations).toHaveLength(1);
    expect(halts).toEqual(["unauthorized"]);
    // 다시 켜려 해도 살아나지 않는다 — 토큰이 유효하지 않다는 판정은 영구다.
    schedule.start();
    schedule.setVisible(false);
    schedule.setVisible(true);
    await vi.advanceTimersByTimeAsync(INTERVAL * 10);
    expect(generations).toHaveLength(1);
  });

  it("a 429 pauses for sixty seconds", async () => {
    const halts: string[] = [];
    const generations: number[] = [];
    let limit = true;
    const schedule = new PollSchedule({
      intervalMs: INTERVAL,
      poll: (generation) => {
        generations.push(generation);
        if (limit) schedule.noteStatus(429);
        return Promise.resolve();
      },
      onHalt: (reason) => halts.push(reason),
    });
    schedule.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(generations).toHaveLength(1);
    expect(halts).toEqual(["rateLimited"]);
    limit = false;
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS - 1);
    expect(generations).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(generations).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(generations).toHaveLength(3);
  });
});
