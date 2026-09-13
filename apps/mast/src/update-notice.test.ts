import { describe, expect, it, vi } from "vitest";

import type { UpdateInfo } from "./backend";
import { initUpdateNotice } from "./update-notice";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const cachedInfo: UpdateInfo = {
  currentVersion: "0.3.31",
  newerVersion: null,
  checked: false,
};

async function flushNotice(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("update notice initialization", () => {
  it("subscribes before reading the cache and keeps an event ahead of a stale getter", async () => {
    let onEvent: ((info: UpdateInfo) => void) | undefined;
    const order: string[] = [];
    const cached = deferred<UpdateInfo>();
    const apply = vi.fn();

    initUpdateNotice(
      async (handler) => {
        order.push("subscribe");
        onEvent = handler;
      },
      vi.fn(() => {
        order.push("get");
        return cached.promise;
      }),
      apply,
    );

    await Promise.resolve();
    expect(order).toEqual(["subscribe", "get"]);
    expect(onEvent).toBeDefined();

    const checkedInfo: UpdateInfo = {
      currentVersion: "0.3.31",
      newerVersion: "0.3.32",
      checked: true,
    };
    onEvent?.(checkedInfo);
    cached.resolve(cachedInfo);
    await cached.promise;
    await Promise.resolve();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(checkedInfo);
  });

  it("applies a completed cached result when the event was missed", async () => {
    const completed: UpdateInfo = {
      currentVersion: "0.3.31",
      newerVersion: "0.3.32",
      checked: true,
    };
    const apply = vi.fn();

    initUpdateNotice(async () => {}, async () => completed, apply);
    await flushNotice();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(completed);
  });

  it("still reads the cache when event listening fails", async () => {
    const apply = vi.fn();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    initUpdateNotice(
      async () => {
        throw new Error("listen failed");
      },
      async () => cachedInfo,
      apply,
    );
    await flushNotice();

    expect(apply).toHaveBeenCalledWith(cachedInfo);
    expect(debug).toHaveBeenCalledWith("[mast] update event listen failed", expect.any(Error));
    debug.mockRestore();
  });

  it("keeps getter failures quiet", async () => {
    const apply = vi.fn();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    initUpdateNotice(async () => {}, async () => {
      throw new Error("getter failed");
    }, apply);
    await flushNotice();

    expect(apply).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith("[mast] update info failed", expect.any(Error));
    debug.mockRestore();
  });
});
