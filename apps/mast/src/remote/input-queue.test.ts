import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENTER_DELAY_MS, InputQueue } from "./input-queue";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 각 send 의 정착을 테스트가 쥔다 — 한 번에 하나만 나가는지 보려면 앞 요청을
 *  붙잡아 둘 수 있어야 한다. */
function harness() {
  const sent: string[] = [];
  const settle: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const errors: { error: unknown; data: string }[] = [];
  let idle = 0;
  const queue = new InputQueue({
    send: (data) => {
      sent.push(data);
      return new Promise<void>((resolve, reject) => settle.push({ resolve, reject }));
    },
    onError: (error, item) => errors.push({ error, data: item.data }),
    onIdle: () => {
      idle += 1;
    },
  });
  return {
    queue,
    sent,
    errors,
    get idle() {
      return idle;
    },
    async resolveNext() {
      const next = settle.shift();
      next?.resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
    async rejectNext(error: unknown) {
      const next = settle.shift();
      next?.reject(error);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

describe("InputQueue", () => {
  it("sends actions in order one at a time", async () => {
    const h = harness();
    h.queue.push({ data: "a" }, { data: "b" }, { data: "c" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toEqual(["a"]);
    await h.resolveNext();
    expect(h.sent).toEqual(["a", "b"]);
    await h.resolveNext();
    expect(h.sent).toEqual(["a", "b", "c"]);
    await h.resolveNext();
    expect(h.queue.pending).toBe(0);
    expect(h.idle).toBe(1);
  });

  it("a failed paste cancels its enter", async () => {
    const h = harness();
    const failure = new Error("413");
    h.queue.push({ data: "ls" }, { data: "\r", delayBeforeMs: ENTER_DELAY_MS });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toEqual(["ls"]);
    await h.rejectNext(failure);
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS * 10);
    expect(h.sent).toEqual(["ls"]);
    expect(h.queue.pending).toBe(0);
    expect(h.errors).toEqual([{ error: failure, data: "ls" }]);
    expect(h.idle).toBe(0);
  });

  it("enter follows paste after the delay", async () => {
    const h = harness();
    h.queue.push({ data: "ls" }, { data: "\r", delayBeforeMs: ENTER_DELAY_MS });
    await vi.advanceTimersByTimeAsync(0);
    await h.resolveNext();
    // 앞 요청의 응답만으로는 나가지 않는다 — 지연이 남아 있다.
    expect(h.sent).toEqual(["ls"]);
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS - 1);
    expect(h.sent).toEqual(["ls"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent).toEqual(["ls", "\r"]);
  });
});
