// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fsListDir: vi.fn(async () => ({ entries: [{ name: "child", is_dir: true, size: null }], truncated: false })),
}));

vi.mock("../../infrastructure/backend", () => ({
  fsListDir: h.fsListDir,
  detachTerminal: vi.fn(async () => undefined),
  attachTerminal: vi.fn(async () => attachBody()),
  resizeTerminal: vi.fn(async () => undefined),
  ackOutput: vi.fn(async () => undefined),
  writeStdin: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
  logLine: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((chunk: ArrayBuffer | Uint8Array) => void) | undefined;
  },
}));

import { WorkspaceView } from "./workspace-view";
import { PaneView } from "./pane-view";
import { SwitchTracer } from "./switch-trace";
import { attachBody } from "../../test-helpers";
import type { Pane, SplitTree, StateSnapshot, Tab, TabKind, Workspace } from "../../shared/types";

const LEFT_PANE = 1;
const RIGHT_PANE = 2;
const SPLIT_ID = 10;

function tab(id: number, kind: TabKind): Tab {
  return {
    id,
    title: `tab ${id}`,
    kind,
    notification: "none",
    lastActivityMs: null,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
}

const TERMINAL_TAB = tab(2, { type: "terminal", ptySession: 7, status: { type: "running" }, cwd: "/tmp" });
const FOLDER_TAB = tab(3, { type: "folderBrowser", path: "/tmp" });

const ONE_PANE: { layout: SplitTree; panes: Record<string, Pane>; activePane: number } = {
  layout: { type: "leaf", pane: LEFT_PANE },
  panes: { "1": { id: LEFT_PANE, activeTab: 2, tabs: [TERMINAL_TAB] } },
  activePane: LEFT_PANE,
};

// 백엔드 발행 split 은 새 pane 을 activePane 으로 만든다 (SplitPane 의 계약).
const SPLIT: typeof ONE_PANE = {
  layout: {
    type: "split",
    id: SPLIT_ID,
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "leaf", pane: LEFT_PANE },
    second: { type: "leaf", pane: RIGHT_PANE },
  },
  panes: {
    "1": { id: LEFT_PANE, activeTab: 2, tabs: [TERMINAL_TAB] },
    "2": { id: RIGHT_PANE, activeTab: 3, tabs: [FOLDER_TAB] },
  },
  activePane: RIGHT_PANE,
};

function snapshot(revision: number, shape: typeof ONE_PANE): StateSnapshot {
  const ws: Workspace = {
    id: 1,
    name: "ws",
    rootPath: "/tmp",
    distro: null,
    gitBranch: null,
    gitDirty: null,
    layout: shape.layout,
    panes: shape.panes,
    activePane: shape.activePane,
    viewerPane: null,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
  return { revision, state: { revision, nextId: 50, activeWorkspace: 1, workspaces: [ws] } };
}

let view: WorkspaceView | null = null;
let root: HTMLElement;

function setup(): void {
  root = document.createElement("div");
  document.body.append(root);
  view = new WorkspaceView(root, async () => null, new SwitchTracer(() => undefined));
}

afterEach(() => {
  if (view) {
    const empty = snapshot(999, ONE_PANE);
    empty.state.workspaces = [];
    empty.state.activeWorkspace = null;
    view.render(empty);
  }
  view = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function xtermInput(): HTMLTextAreaElement {
  const el = root.querySelector("textarea");
  if (el === null) throw new Error("terminal input textarea not mounted");
  return el;
}

describe("구조 변경 중 포커스 보존 (D02 불변식 6)", () => {
  it("다른 pane 의 터미널 입력은 백엔드 split 뒤에도 같은 요소에 포커스가 남는다", () => {
    setup();
    view!.render(snapshot(1, ONE_PANE));
    const input = xtermInput();
    input.focus();
    expect(document.activeElement).toBe(input);

    view!.render(snapshot(2, SPLIT));

    expect(root.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("pane 안의 편집 textarea(뷰어 편집 자리)도 split 뒤에 포커스가 남는다", () => {
    setup();
    view!.render(snapshot(1, ONE_PANE));
    // 뷰어 편집기 자리를 대신한다 — 같은 pane 콘텐츠에 붙은 textarea 가 pane DOM 과 함께 옮겨진다.
    const editor = document.createElement("textarea");
    root.querySelector(".pane-content")!.append(editor);
    editor.focus();

    view!.render(snapshot(2, SPLIT));

    expect(document.activeElement).toBe(editor);
  });

  it("사이드바 rename 입력은 구조 변경과 무관하게 포커스를 유지한다", () => {
    setup();
    view!.render(snapshot(1, ONE_PANE));
    const rename = document.createElement("input");
    rename.dataset.keepFocus = "";
    const sidebar = document.createElement("aside");
    sidebar.append(rename);
    document.body.append(sidebar);
    rename.focus();

    view!.render(snapshot(2, SPLIT));

    expect(document.activeElement).toBe(rename);
  });

  it("메모장 textarea(body 아래 대화상자)도 split 뒤에 포커스를 유지한다", () => {
    setup();
    view!.render(snapshot(1, ONE_PANE));
    const dialog = document.createElement("div");
    const notes = document.createElement("textarea");
    dialog.append(notes);
    document.body.append(dialog);
    notes.focus();

    view!.render(snapshot(2, SPLIT));

    expect(document.activeElement).toBe(notes);
  });

  it("사용자가 다른 요소로 포커스를 옮긴 뒤의 구조 변경은 이전 요소로 되돌리지 않는다", () => {
    setup();
    view!.render(snapshot(1, ONE_PANE));
    const input = xtermInput();
    input.focus();
    const sidebarRename = document.createElement("input");
    document.body.append(sidebarRename);
    sidebarRename.focus();

    view!.render(snapshot(2, SPLIT));

    expect(document.activeElement).toBe(sidebarRename);
  });

  it("재구축 도중 사용자가 다른 실제 요소로 포커스를 옮기면 그 요소를 유지한다", () => {
    setup();
    view!.render(snapshot(1, ONE_PANE));
    const input = xtermInput();
    input.focus();
    const other = document.createElement("input");
    document.body.append(other);
    // updatePanes 가 pane 을 갱신하는 도중(재구축 뒤, 복구 전) 포커스가 다른 요소로 간 상황이다.
    const update = PaneView.prototype.update;
    vi.spyOn(PaneView.prototype, "update").mockImplementation(function (this: PaneView, ...args) {
      update.apply(this, args);
      other.focus();
    });

    view!.render(snapshot(2, SPLIT));

    expect(document.activeElement).toBe(other);
  });

  it("UI dispatch 로 만든 split 의 새 탭은 기존처럼 새 탭에 포커스가 간다", async () => {
    setup();
    view!.render(snapshot(1, ONE_PANE));
    xtermInput().focus();

    view!.requestFocus({ kind: "tab", tab: FOLDER_TAB.id });
    view!.render(snapshot(2, SPLIT));

    await vi.waitFor(() => {
      const folder = root.querySelector(".folder-list");
      expect(folder).not.toBeNull();
      expect(document.activeElement).toBe(folder);
    });
  });
});
