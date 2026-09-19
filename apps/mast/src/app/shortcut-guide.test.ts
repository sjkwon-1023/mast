// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installShortcutGuide } from "./shortcut-guide";

afterEach(() => {
  vi.useRealTimers();
  document.body.classList.remove("shortcut-guide");
});

describe("shortcut guide", () => {
  it("shows after a held Alt and hides on release", () => {
    vi.useFakeTimers();
    const dispose = installShortcutGuide();
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", altKey: true, shiftKey: true }));
      vi.advanceTimersByTime(1313);
      expect(document.body.classList.contains("shortcut-guide")).toBe(false);
      vi.advanceTimersByTime(1);
      expect(document.body.classList.contains("shortcut-guide")).toBe(true);
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
      expect(document.body.classList.contains("shortcut-guide")).toBe(false);
    } finally {
      dispose();
    }
  });

  it("cancels pending display when the window loses focus", () => {
    vi.useFakeTimers();
    const dispose = installShortcutGuide();
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }));
      window.dispatchEvent(new Event("blur"));
      vi.advanceTimersByTime(1400);
      expect(document.body.classList.contains("shortcut-guide")).toBe(false);
    } finally {
      dispose();
    }
  });
});
