// @vitest-environment happy-dom
//
// 탭이 다른 pane 으로 옮겨졌을 때 살아 있는 터미널 뷰가 새 pane 으로 따라가는지 — 실제
// WorkspaceView 로 "옮기기 전"과 "옮긴 뒤" 스냅샷을 차례로 렌더한다. 뷰를 재사용하는
// 경로라 attach 는 한 번뿐이어야 하고, 뷰의 DOM 은 새 pane 의 콘텐츠 영역에 있어야 한다.

import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ attaches: 0 }));

vi.mock("../../infrastructure/backend", () => ({
  writeStdin: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
  attachTerminal: vi.fn(async () => {
    h.attaches += 1;
    const body = new Uint8Array(9);
    body[8] = 1;
    return body.buffer;
  }),
  resizeTerminal: vi.fn(async () => undefined),
  detachTerminal: vi.fn(async () => undefined),
  ackOutput: vi.fn(async () => undefined),
  logLine: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((chunk: ArrayBuffer | Uint8Array) => void) | undefined;
  },
}));

import { SwitchTracer } from "./switch-trace";
import { WorkspaceView } from "./workspace-view";
import type { TerminalView } from "../terminal/view";
import type { Pane, StateSnapshot, Tab, TabId, Workspace } from "../../shared/types";

function terminal(id: TabId): Tab {
  return {
    id,
    title: `tab ${id}`,
    kind: { type: "terminal", ptySession: id * 10, status: { type: "running" }, cwd: null },
    notification: "none",
    lastActivityMs: null,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
}

function snapshot(revision: number, left: Pane, right: Pane): StateSnapshot {
  const workspace: Workspace = {
    id: 1,
    name: "ws",
    rootPath: null,
    distro: null,
    gitBranch: null,
    gitDirty: null,
    layout: {
      type: "split",
      id: 3,
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", pane: left.id },
      second: { type: "leaf", pane: right.id },
    },
    panes: { [String(left.id)]: left, [String(right.id)]: right },
    activePane: right.id,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
  return { revision, state: { workspaces: [workspace], activeWorkspace: 1, nextId: 100, revision } };
}

function liveView(view: WorkspaceView, tab: TabId): TerminalView {
  const views = (view as unknown as { views: Map<TabId, TerminalView> }).views;
  const found = views.get(tab);
  if (found === undefined) throw new Error(`no live view for tab ${tab}`);
  return found;
}

function paneContent(root: HTMLElement, pane: number): HTMLElement {
  const found = root.querySelector<HTMLElement>(`.pane[data-pane-id="${pane}"] .pane-content`);
  if (found === null) throw new Error(`missing pane ${pane}`);
  return found;
}

describe("탭을 다른 pane 으로 옮기기", () => {
  it("살아 있는 터미널 뷰가 다시 attach 하지 않고 새 pane 으로 따라간다", async () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const view = new WorkspaceView(root, async () => null, new SwitchTracer(() => undefined));

    view.render(
      snapshot(1, { id: 1, tabs: [terminal(10), terminal(11)], activeTab: 11 }, { id: 2, tabs: [terminal(20)], activeTab: 20 }),
    );
    await Promise.resolve();
    const moved = liveView(view, 11);
    expect(paneContent(root, 1).contains(moved.root)).toBe(true);
    const attachesBefore = h.attaches;

    view.render(
      snapshot(2, { id: 1, tabs: [terminal(10)], activeTab: 10 }, { id: 2, tabs: [terminal(20), terminal(11)], activeTab: 11 }),
    );

    expect(liveView(view, 11)).toBe(moved);
    expect(paneContent(root, 2).contains(moved.root)).toBe(true);
    expect(paneContent(root, 1).contains(moved.root)).toBe(false);
    // 옮겨 간 탭은 재사용이다. 새로 attach 한 것은 원래 pane 에 승격된 탭 10 뿐이다.
    expect(h.attaches - attachesBefore).toBe(1);
  });
});
