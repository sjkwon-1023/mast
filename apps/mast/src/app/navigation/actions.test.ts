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

  it("uses sidebar callbacks before a snapshot exists", () => {
    const host = context();
    runNavAction(host, { type: "newWorkspaceHere" });
    runNavAction(host, { type: "renameWorkspace" });
    runNavAction(host, { type: "closeWorkspace" });
    expect(host.createWorkspaceHere).toHaveBeenCalledOnce();
    expect(host.renameWorkspace).toHaveBeenCalledOnce();
    expect(host.closeWorkspace).toHaveBeenCalledOnce();
    expect(host.dispatchUI).not.toHaveBeenCalled();
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
