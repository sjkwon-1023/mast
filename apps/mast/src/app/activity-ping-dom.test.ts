// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installActivityPing } from "./activity-ping";

afterEach(() => vi.restoreAllMocks());

describe("활동 보고 설치", () => {
  it("자동 리셋이 꺼져 있으면 리스너와 활동 보고를 만들지 않는다", () => {
    const windowListener = vi.spyOn(window, "addEventListener");
    const documentListener = vi.spyOn(document, "addEventListener");
    const send = vi.fn();
    installActivityPing(false, send);
    expect(windowListener).not.toHaveBeenCalled();
    expect(documentListener).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("켜져 있으면 활동은 묶고 visibility 전이는 즉시 보낸다", () => {
    const windowListeners = new Map<string, EventListener>();
    const documentListeners = new Map<string, EventListener>();
    vi.spyOn(window, "addEventListener").mockImplementation((name, listener) => {
      windowListeners.set(name, listener as EventListener);
    });
    vi.spyOn(document, "addEventListener").mockImplementation((name, listener) => {
      documentListeners.set(name, listener as EventListener);
    });
    const send = vi.fn();
    installActivityPing(true, send);
    expect([...windowListeners.keys()]).toEqual(["wheel", "mousedown", "keydown"]);
    for (const [name, listener] of windowListeners) listener(new Event(name));
    expect(send.mock.calls).toEqual([[null]]);
    documentListeners.get("visibilitychange")!(new Event("visibilitychange"));
    expect(send.mock.calls).toEqual([[null], [document.visibilityState === "visible"]]);
  });
});
