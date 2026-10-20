// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import snapshotJson from "../../../../../fixtures/stage10-snapshot.json";
import type { StateSnapshot } from "../../shared/types";
import { installNavKeys, runNavAction } from "./actions";
import type { NavigationContext } from "./actions";
import {
  registerTerminalFontTarget,
  terminalViewOptions,
  unregisterTerminalFontTarget,
} from "../../features/terminal/settings";
import { viewerFontSize } from "../../features/viewers/viewer-font";

function context(snapshot: StateSnapshot | null = null): NavigationContext {
  return {
    getSnapshot: () => snapshot,
    paneRects: () => [],
    dispatchUI: vi.fn(async () => null),
    createWorkspaceHere: vi.fn(),
    renameWorkspace: vi.fn(),
    closeWorkspace: vi.fn(),
    toggleNotepad: vi.fn(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("navigation wiring", () => {
  it("reads the latest snapshot for each key and uses the UI dispatch path", () => {
    const initial = structuredClone(snapshotJson) as unknown as StateSnapshot;
    let latest: StateSnapshot | null = initial;
    const host = context();
    host.getSnapshot = () => latest;
    runNavAction(host, { type: "closeTab" });
    expect(host.dispatchUI).toHaveBeenLastCalledWith({ type: "closeTab", tab: 4 });
    latest = structuredClone(initial);
    latest.state.activeWorkspace = latest.state.workspaces[1].id;
    runNavAction(host, { type: "closeTab" });
    expect(host.dispatchUI).toHaveBeenLastCalledWith({ type: "closeTab", tab: 14 });
    latest = null;
    runNavAction(host, { type: "closeTab" });
    expect(host.dispatchUI).toHaveBeenCalledTimes(2);
  });

  it("preserves terminal cwd for tab creation and splitting", () => {
    const host = context(structuredClone(snapshotJson) as unknown as StateSnapshot);
    runNavAction(host, { type: "newTab", kind: "terminal" });
    expect(host.dispatchUI).toHaveBeenLastCalledWith({
      type: "createTab",
      pane: 2,
      tab: { type: "terminal", cwd: "/home/dev/code/mast" },
    });
    runNavAction(host, { type: "splitPane", direction: "horizontal" });
    expect(host.dispatchUI).toHaveBeenLastCalledWith({
      type: "splitPane",
      pane: 2,
      direction: "horizontal",
      tab: { type: "terminal", cwd: "/home/dev/code/mast" },
    });
  });

  it("auto split follows the active pane's longer side", () => {
    const host = context(structuredClone(snapshotJson) as unknown as StateSnapshot);
    host.paneRects = () => [{ pane: 2, x: 0, y: 0, w: 1200, h: 700 }];
    runNavAction(host, { type: "splitPaneAuto" });
    expect(host.dispatchUI).toHaveBeenLastCalledWith(expect.objectContaining({ direction: "horizontal" }));
    host.paneRects = () => [{ pane: 2, x: 0, y: 0, w: 600, h: 900 }];
    runNavAction(host, { type: "splitPaneAuto" });
    expect(host.dispatchUI).toHaveBeenLastCalledWith(expect.objectContaining({ direction: "vertical" }));
  });

  it("uses sidebar callbacks before a snapshot exists", () => {
    const host = context();
    runNavAction(host, { type: "newWorkspaceHere" });
    runNavAction(host, { type: "renameWorkspace" });
    runNavAction(host, { type: "closeWorkspace" });
    runNavAction(host, { type: "toggleNotepad" });
    expect(host.createWorkspaceHere).toHaveBeenCalledOnce();
    expect(host.renameWorkspace).toHaveBeenCalledOnce();
    expect(host.closeWorkspace).toHaveBeenCalledOnce();
    // 메모장 토글은 snapshot 이 없어도 키를 소비하고 뷰에 넘긴다.
    expect(host.toggleNotepad).toHaveBeenCalledOnce();
    expect(host.dispatchUI).not.toHaveBeenCalled();
  });

  it("turns Ctrl+Shift+M and Cmd+Shift+M into a notepad toggle before a snapshot exists", () => {
    const platforms = [
      { mac: false, modifiers: [{ ctrlKey: true }, { altKey: true }] },
      { mac: true, modifiers: [{ metaKey: true }] },
    ];
    for (const { mac, modifiers } of platforms) {
      const add = vi.spyOn(window, "addEventListener");
      const host = context();
      installNavKeys(host, mac);
      const call = add.mock.calls.find(([type]) => type === "keydown")!;
      add.mockRestore();
      const listener = call[1] as EventListener;
      const terminal = document.createElement("div");
      const received = vi.fn();
      terminal.addEventListener("keydown", received);
      document.body.append(terminal);
      try {
        for (const extra of modifiers) {
          const toggle = new KeyboardEvent("keydown", {
            key: "M",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
            ...extra,
          });
          terminal.dispatchEvent(toggle);
          expect(toggle.defaultPrevented).toBe(true);
        }
        expect(host.toggleNotepad).toHaveBeenCalledTimes(modifiers.length);
        expect(received).not.toHaveBeenCalled();

        // 예약 키(Ctrl+Shift+C/V)는 그대로 통과한다.
        const copy = new KeyboardEvent("keydown", {
          key: "C",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        terminal.dispatchEvent(copy);
        expect(copy.defaultPrevented).toBe(false);
        expect(received).toHaveBeenCalledOnce();
      } finally {
        window.removeEventListener("keydown", listener, { capture: true });
        terminal.remove();
      }
    }
  });

  it("consumes repeated notepad toggles without running the toggle", () => {
    const platforms = [
      { mac: false, key: "M", extra: { ctrlKey: true } },
      { mac: true, key: "m", extra: { metaKey: true } },
    ];
    for (const { mac, key, extra } of platforms) {
      const add = vi.spyOn(window, "addEventListener");
      const host = context();
      installNavKeys(host, mac);
      const call = add.mock.calls.find(([type]) => type === "keydown")!;
      add.mockRestore();
      const listener = call[1] as EventListener;
      const terminal = document.createElement("div");
      const received = vi.fn();
      terminal.addEventListener("keydown", received);
      document.body.append(terminal);
      try {
        const repeat = new KeyboardEvent("keydown", {
          key,
          shiftKey: true,
          repeat: true,
          bubbles: true,
          cancelable: true,
          ...extra,
        });
        terminal.dispatchEvent(repeat);
        expect(repeat.defaultPrevented).toBe(true);
        expect(host.toggleNotepad).not.toHaveBeenCalled();
        expect(received).not.toHaveBeenCalled();

        const first = new KeyboardEvent("keydown", {
          key,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
          ...extra,
        });
        terminal.dispatchEvent(first);
        expect(first.defaultPrevented).toBe(true);
        expect(host.toggleNotepad).toHaveBeenCalledOnce();
      } finally {
        window.removeEventListener("keydown", listener, { capture: true });
        terminal.remove();
      }
    }
  });

  it("keeps repeating other navigation shortcuts", () => {
    const add = vi.spyOn(window, "addEventListener");
    const host = context(structuredClone(snapshotJson) as unknown as StateSnapshot);
    installNavKeys(host);
    const call = add.mock.calls.find(([type]) => type === "keydown")!;
    add.mockRestore();
    const listener = call[1] as EventListener;
    const terminal = document.createElement("div");
    const received = vi.fn();
    terminal.addEventListener("keydown", received);
    document.body.append(terminal);
    try {
      for (let count = 0; count < 2; count += 1) {
        const repeat = new KeyboardEvent("keydown", {
          key: "W",
          ctrlKey: true,
          shiftKey: true,
          repeat: true,
          bubbles: true,
          cancelable: true,
        });
        terminal.dispatchEvent(repeat);
        expect(repeat.defaultPrevented).toBe(true);
      }
      expect(host.dispatchUI).toHaveBeenCalledTimes(2);
      expect(host.dispatchUI).toHaveBeenLastCalledWith({ type: "closeTab", tab: 4 });
      expect(received).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", listener, { capture: true });
      terminal.remove();
    }
  });

  it("zooms both surfaces without a snapshot and notifies registered terminal surfaces", () => {
    const host = context();
    const surface = { setFontSize: vi.fn() };
    const terminalSize = terminalViewOptions().fontSize;
    const viewerSize = viewerFontSize();
    registerTerminalFontTarget(surface);
    try {
      runNavAction(host, { type: "zoom", delta: 1 });
      expect(terminalViewOptions().fontSize).toBe(terminalSize + 1);
      expect(viewerFontSize()).toBe(viewerSize + 1);
      expect(surface.setFontSize).toHaveBeenLastCalledWith(terminalSize + 1);
      runNavAction(host, { type: "zoomReset" });
      expect(terminalViewOptions().fontSize).toBe(terminalSize);
      expect(viewerFontSize()).toBe(viewerSize);
      expect(host.dispatchUI).not.toHaveBeenCalled();
    } finally {
      runNavAction(host, { type: "zoomReset" });
      unregisterTerminalFontTarget(surface);
    }
  });

  it("Shift 없는 Alt+방향키는 터미널로 흘려보내고 Alt+Shift+방향키는 pane 이동으로 소비한다", () => {
    // Alt+방향키 전달 회귀 — nav capture 가 plain Alt+방향키를 소비하면 Codex 등
    // TUI 의 Alt+Up 이 여기서 죽는다 (판정은 shared/keys.ts::keyAction).
    const add = vi.spyOn(window, "addEventListener");
    const host = context();
    installNavKeys(host);
    const call = add.mock.calls.find(([type]) => type === "keydown")!;
    const listener = call[1] as EventListener;
    const terminal = document.createElement("div");
    const received = vi.fn();
    terminal.addEventListener("keydown", received);
    document.body.append(terminal);
    try {
      const plain = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      terminal.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(received).toHaveBeenCalledOnce();

      const move = new KeyboardEvent("keydown", {
        key: "ArrowUp",
        altKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      terminal.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);
      expect(received).toHaveBeenCalledOnce(); // capture 에서 멈춰 터미널에 닿지 않는다
      expect(host.dispatchUI).not.toHaveBeenCalled(); // 스냅샷 없음 — 조용한 no-op
    } finally {
      window.removeEventListener("keydown", listener, { capture: true });
      terminal.remove();
    }
  });

  it("consumes recognized keys before the terminal even when the target does not exist", () => {
    const add = vi.spyOn(window, "addEventListener");
    const host = context();
    installNavKeys(host);
    const call = add.mock.calls.find(([type]) => type === "keydown")!;
    const listener = call[1] as EventListener;
    const terminal = document.createElement("div");
    const received = vi.fn();
    terminal.addEventListener("keydown", received);
    document.body.append(terminal);
    try {
      expect(call[2]).toEqual({ capture: true });
      const recognized = new KeyboardEvent("keydown", {
        key: "9",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      terminal.dispatchEvent(recognized);
      expect(recognized.defaultPrevented).toBe(true);
      expect(received).not.toHaveBeenCalled();
      const ordinary = new KeyboardEvent("keydown", {
        key: "x",
        bubbles: true,
        cancelable: true,
      });
      terminal.dispatchEvent(ordinary);
      expect(ordinary.defaultPrevented).toBe(false);
      expect(received).toHaveBeenCalledOnce();
      expect(host.dispatchUI).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", listener, { capture: true });
      terminal.remove();
    }
  });
});
