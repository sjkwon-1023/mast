// @vitest-environment happy-dom
//
// 메모장 토글이 터미널 레이아웃을 건드리지 않는다는 회귀 테스트 (ADR-0034 결정 1).
// 실제 WorkspaceView 로 터미널을 attach 하고, pane ResizeObserver → scheduleFit →
// fit → resizeTerminal 경로가 살아 있는지 먼저 확인한 뒤 메모장을 열고 닫는다.
// happy-dom 에는 레이아웃이 없으므로 터미널 부모의 computed width/height 만 고정하고,
// 관찰 대상은 resize 요청 수와 pane DOM·style·bounds 다. 실제 기하는 WINDOWS-BUILD.md
// 의 실기 항목이 맡는다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  attach: (() => Promise.resolve(new ArrayBuffer(0))) as () => Promise<ArrayBuffer>,
}));

vi.mock("../../infrastructure/backend", () => ({
  writeStdin: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
  attachTerminal: vi.fn(async () => h.attach()),
  resizeTerminal: vi.fn(async () => undefined),
  detachTerminal: vi.fn(async () => undefined),
  ackOutput: vi.fn(async () => undefined),
  logLine: vi.fn(async () => undefined),
  notesRead: vi.fn(async () => ""),
  notesSave: vi.fn(async () => ({ type: "saved" })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((chunk: ArrayBuffer | Uint8Array) => void) | undefined;
  },
}));

import type { Pane, StateSnapshot, Tab, Workspace } from "../../shared/types";
import { attachBody, installCharMeasureGeometry } from "../../test-helpers";
import { SwitchTracer } from "../workspace/switch-trace";
import { WorkspaceView } from "../workspace/workspace-view";
import { resizeTerminal } from "../../infrastructure/backend";
import { createNotepadState } from "./state";
import { createNotepadFeature } from "./view";
import type { NotepadFeature, NotepadHost } from "./view";

installCharMeasureGeometry();

const TAB = 7;
const SESSION = 42;

function snapshot(): StateSnapshot {
  const tab: Tab = {
    id: TAB,
    title: "shell",
    kind: { type: "terminal", ptySession: SESSION, status: { type: "running" }, cwd: null },
    notification: "none",
    lastActivityMs: null,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
  const pane: Pane = { id: 1, tabs: [tab], activeTab: TAB };
  const workspace: Workspace = {
    id: 1,
    name: "ws",
    rootPath: "/tmp",
    distro: null,
    gitBranch: null,
    gitDirty: null,
    layout: { type: "leaf", pane: 1 },
    panes: { "1": pane },
    activePane: 1,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
  return {
    revision: 1,
    state: { revision: 1, nextId: 20, activeWorkspace: 1, workspaces: [workspace] },
  };
}

function hostFor(initial: StateSnapshot): NotepadHost {
  return { getSnapshot: () => initial, focusActivePane: vi.fn() };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

interface PaneShape {
  paneChildren: string[];
  paneStyle: string | null;
  contentChildren: number;
  termStyle: string | null;
  bounds: DOMRect;
}

function paneShape(root: HTMLElement): PaneShape {
  const pane = root.querySelector<HTMLElement>(".pane");
  const content = root.querySelector<HTMLElement>(".pane-content");
  const term = root.querySelector<HTMLElement>(".term-host");
  if (pane === null || content === null || term === null) {
    throw new Error("pane is not rendered");
  }
  return {
    paneChildren: Array.from(pane.children).map((el) => `${el.tagName}.${el.className}`),
    paneStyle: pane.getAttribute("style"),
    contentChildren: content.childElementCount,
    termStyle: term.getAttribute("style"),
    bounds: pane.getBoundingClientRect(),
  };
}

let feature: NotepadFeature | null = null;

beforeEach(() => {
  sessionStorage.clear();
  document.body.replaceChildren();
});

afterEach(async () => {
  await feature?.close().catch(() => undefined);
  feature = null;
  sessionStorage.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("메모장 토글과 터미널 레이아웃", () => {
  it("열고 닫아도 resize 요청과 pane DOM·style·bounds 가 그대로다", async () => {
    h.attach = () => Promise.resolve(attachBody(""));

    const dims = { width: 800, height: 600 };
    // happy-dom 은 레이아웃이 없어 clientWidth/Height 가 0 이다 — TerminalView.fit 의
    // 조기 반환을 피하려고 터미널 부모에만 관찰 가능한 치수를 준다.
    const widthGetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")?.get;
    const heightGetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")?.get;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList?.contains("term-host")) return dims.width;
      return widthGetter?.call(this) ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList?.contains("term-host")) return dims.height;
      return heightGetter?.call(this) ?? 0;
    });
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = originalGetComputedStyle(element, pseudo);
      const inTerminal =
        element instanceof HTMLElement &&
        (element.classList.contains("term-host") || element.classList.contains("xterm"));
      if (!inTerminal) return style;
      return new Proxy(style, {
        get(target, key) {
          if (key === "getPropertyValue") {
            return (name: string): string => {
              if (name === "width") return `${dims.width}px`;
              if (name === "height") return `${dims.height}px`;
              if (name.startsWith("padding")) return "0px";
              return target.getPropertyValue(name);
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as CSSStyleDeclaration;
    });

    // pane 의 ResizeObserver 콜백을 직접 발화해 fit 경로가 실제 resize 로 이어지는지 본다.
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(() => callback([], this as unknown as ResizeObserver));
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );

    const viewRoot = document.createElement("div");
    viewRoot.id = "view";
    document.body.append(viewRoot);
    const view = new WorkspaceView(viewRoot, async () => null, new SwitchTracer(() => undefined));
    const initial = snapshot();
    view.render(initial);

    const resize = vi.mocked(resizeTerminal);
    await vi.waitFor(() => expect(resize.mock.calls.length).toBeGreaterThanOrEqual(2));
    await nextFrame();

    dims.width = 640;
    dims.height = 480;
    for (const fire of observers) fire();
    await vi.waitFor(() => expect(resize.mock.calls.length).toBeGreaterThan(2));

    dims.width = 800;
    dims.height = 600;
    for (const fire of observers) fire();
    await nextFrame();
    const before = resize.mock.calls.length;
    const shapeBefore = paneShape(viewRoot);
    const rectsBefore = view.paneRects();

    const state = createNotepadState();
    feature = createNotepadFeature(hostFor(initial), state);
    await feature.toggle();
    expect(document.querySelector("dialog.notepad-drawer")).not.toBeNull();
    await nextFrame();
    await feature.close();
    await nextFrame();

    expect(resize.mock.calls.length).toBe(before);
    expect(paneShape(viewRoot)).toEqual(shapeBefore);
    expect(view.paneRects()).toEqual(rectsBefore);
  });
});
