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

  it("Ctrl+1~9 순번은 관리자를 건너뛴다 — 관리자가 벡터 첫째여도", () => {
    const state = structuredClone(snapshotJson) as unknown as StateSnapshot;
    const [n1, n2] = state.state.workspaces;
    const manager = structuredClone(n2);
    manager.id = 99;
    manager.name = "Manager";
    manager.manager = true;
    // 벡터 순서와 사이드바 순서(일반 카드 다음 고정 슬롯)를 일부러 어긋나게 둔다.
    state.state.workspaces = [manager, n1, n2];
    state.state.activeWorkspace = manager.id;
    const host = context(state);

    runNavAction(host, { type: "switchWorkspace", ordinal: 1 });
    expect(host.dispatchUI).toHaveBeenLastCalledWith({
      type: "switchWorkspace",
      workspace: n1.id,
    });
    runNavAction(host, { type: "switchWorkspace", ordinal: 2 });
    expect(host.dispatchUI).toHaveBeenLastCalledWith({
      type: "switchWorkspace",
      workspace: n2.id,
    });
    // 일반 워크스페이스가 둘뿐이라 3번은 없다 (조용한 no-op).
    runNavAction(host, { type: "switchWorkspace", ordinal: 3 });
    expect(host.dispatchUI).toHaveBeenCalledTimes(2);
  });

  it("cycle 은 관리자를 포함하고 사이드바 순서(일반 다음 관리자)를 따른다", () => {
    const state = structuredClone(snapshotJson) as unknown as StateSnapshot;
    const [n1, n2] = state.state.workspaces;
    const manager = structuredClone(n2);
    manager.id = 99;
    manager.name = "Manager";
    manager.manager = true;
    // 벡터 중간에 관리자 — 벡터 순서 그대로면 n1 다음이 관리자다.
    state.state.workspaces = [n1, manager, n2];
    const host = context(state);

    runNavAction(host, { type: "cycleWorkspace", delta: 1 });
    expect(host.dispatchUI).toHaveBeenLastCalledWith({
      type: "switchWorkspace",
      workspace: n2.id,
    });

    state.state.activeWorkspace = n2.id;
    runNavAction(host, { type: "cycleWorkspace", delta: 1 });
    expect(host.dispatchUI).toHaveBeenLastCalledWith({
      type: "switchWorkspace",
      workspace: manager.id,
    });

    state.state.activeWorkspace = manager.id;
    runNavAction(host, { type: "cycleWorkspace", delta: 1 });
    expect(host.dispatchUI).toHaveBeenLastCalledWith({
      type: "switchWorkspace",
      workspace: n1.id,
    });
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
