import { describe, expect, it } from "vitest";
import { keyAction, shortcutBadge, shortcutLabel, type KeySpec } from "./keys";
import { isCopySelectionKey, isPasteKey } from "../features/terminal/interaction";

const key = (value: string, extra: Partial<KeySpec> = {}): KeySpec => ({
  key: value, ctrl: false, alt: false, shift: false, meta: false, isComposing: false, ...extra,
});
const event = (value: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent => ({
  key: value, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, ...extra,
} as KeyboardEvent);

describe("native Mac shortcuts", () => {
  it("keeps Ctrl and Option editing combinations in the PTY", () => {
    for (const value of ["c", "d", "w", "n", "t", "a", "e", "1", "0", "-"]) {
      expect(keyAction(key(value, { ctrl: true }), true)).toBeNull();
      expect(keyAction(key(value, { alt: true }), true)).toBeNull();
    }
    expect(keyAction(key("Tab", { ctrl: true }), true)).toEqual({ type: "cycleTab", delta: 1 });
    expect(keyAction(key("Tab", { ctrl: true, shift: true }), true)).toEqual({ type: "cycleTab", delta: -1 });
  });
  it("separates tab close, workspace close, and native quit", () => {
    expect(keyAction(key("w", { meta: true }), true)).toEqual({ type: "closeTab" });
    expect(keyAction(key("W", { meta: true, shift: true }), true)).toEqual({ type: "closeWorkspace" });
    expect(keyAction(key("q", { meta: true }), true)).toBeNull();
    expect(shortcutLabel("closeTab", true)).toBe("⌘W");
    expect(shortcutLabel("closeWorkspace", true)).toBe("⌘⇧W");
    expect(shortcutBadge("newTerminalTab", true)).toBe("T");
    expect(shortcutLabel("closeTab", false)).toBe("Alt+Shift+W");
  });
  it("maps the complete terminal/workspace/pane creation path", () => {
    for (const [value, extra, result] of [
      ["t", {}, { type: "newTab", kind: "terminal" }],
      ["B", { shift: true }, { type: "newTab", kind: "folderBrowser" }],
      ["n", {}, { type: "newWorkspaceHere" }],
      ["d", {}, { type: "splitPaneAuto" }],
      ["D", { shift: true }, { type: "splitPane", direction: "vertical" }],
      ["{", { shift: true }, { type: "cycleWorkspace", delta: -1 }],
      ["}", { shift: true }, { type: "cycleWorkspace", delta: 1 }],
      ["9", {}, { type: "switchWorkspace", ordinal: 9 }],
      ["ArrowLeft", { alt: true }, { type: "focusPane", dir: "left" }],
      ["+", { shift: true }, { type: "zoom", delta: 1 }],
      ["-", {}, { type: "zoom", delta: -1 }],
      ["0", {}, { type: "zoomReset" }],
    ] as const) {
      expect(keyAction(key(value, { meta: true, ...extra }), true)).toEqual(result);
      expect(keyAction(key(value, { meta: true, ...extra, isComposing: true }), true)).toBeNull();
    }
  });
  it("does not steal copy/paste, reload, or modified unknown keys globally", () => {
    for (const value of ["c", "v", "r", "s", "x", "z"]) {
      expect(keyAction(key(value, { meta: true }), true)).toBeNull();
    }
    expect(keyAction(key("t", { meta: true, ctrl: true }), true)).toBeNull();
    expect(keyAction(key("t", { meta: true }), false)).toBeNull();
    expect(keyAction(key("T", { ctrl: true, shift: true }), false)).toEqual({ type: "newTab", kind: "terminal" });
  });
  it("always sends Ctrl+C to the terminal on Mac, even with a selection", () => {
    expect(isCopySelectionKey(event("c", { ctrlKey: true }), true, true)).toBe(false);
    expect(isCopySelectionKey(event("c", { metaKey: true }), true, true)).toBe(true);
    expect(isCopySelectionKey(event("c", { metaKey: true }), false, true)).toBe(false);
    expect(isCopySelectionKey(event("c", { ctrlKey: true }), true, false)).toBe(true);
    expect(isCopySelectionKey(event("c", { metaKey: true, isComposing: true }), true, true)).toBe(false);
  });
  it("pastes with Cmd on Mac, retaining the existing Windows aliases", () => {
    expect(isPasteKey(event("v", { metaKey: true }), true)).toBe(true);
    expect(isPasteKey(event("v", { ctrlKey: true }), true)).toBe(false);
    expect(isPasteKey(event("v", { ctrlKey: true }), false)).toBe(true);
    expect(isPasteKey(event("Insert", { shiftKey: true }), false)).toBe(true);
    expect(isPasteKey(event("Insert", { shiftKey: true }), true)).toBe(false);
    expect(isPasteKey(event("v", { metaKey: true, isComposing: true }), true)).toBe(false);
  });
});
