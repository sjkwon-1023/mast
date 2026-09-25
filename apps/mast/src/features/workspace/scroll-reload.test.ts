// @vitest-environment happy-dom
//
// 리로드를 넘는 스크롤 기억의 회귀 테스트 (ADR-0019 개정 2026-09-20) — 실제
// WorkspaceView 두 개로 "리로드 전 페이지"와 "리로드 후 페이지"를 세운다.
//
// 확인하는 것 셋:
// 1) pagehide 에서 살아 있는 뷰의 스크롤 위치가 sessionStorage 에 쟁여진다 —
//    이 훅이 없으면 자동 리로드가 활성 탭의 위치를 그대로 버린다.
// 2) 리로드 뒤 새 페이지의 WorkspaceView 가 같은 저장소에서 그 값을 꺼내 새 뷰에
//    넘긴다 (1회성 인출).
// 3) 기억이 없으면 종전대로 하단이다 — 새 저장소로 시작하는 앱 재시작 경로.

import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

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
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((chunk: ArrayBuffer | Uint8Array) => void) | undefined;
  },
}));

import { SCROLL_MEMORY_KEY } from "./scroll-memory";
import { SwitchTracer } from "./switch-trace";
import { WorkspaceView } from "./workspace-view";
import type { TerminalView } from "../terminal/view";
import type { Pane, StateSnapshot, Tab, TabId, Workspace } from "../../shared/types";

const TAB = 7;
const SESSION = 42;

function u64le(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

function attachBody(replay: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(replay);
  const out = new Uint8Array(9 + bytes.byteLength);
  out.set(u64le(0), 0);
  out[8] = 0; // first_attach=false — 리로드 attach 의 모양
  out.set(bytes, 9);
  return out.buffer;
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `replay ${i}\r\n`).join("");
}

function snapshot(): StateSnapshot {
  const tab: Tab = {
    id: TAB,
    title: "codex",
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
    rootPath: null,
    distro: null,
    gitBranch: null,
    gitDirty: null,
    manager: false,
    layout: { type: "leaf", pane: 1 },
    panes: { "1": pane },
    activePane: 1,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
  return { revision: 1, state: { workspaces: [workspace], activeWorkspace: 1, nextId: 100, revision: 1 } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** WorkspaceView 는 뷰 레지스트리를 사설로 들고 있다 — 이 테스트는 "사용자가
 *  스크롤해 둔 상태"를 만들기 위해 그 뷰 하나만 꺼내 쓴다 (읽기 전용). */
function liveView(view: WorkspaceView, tab: TabId): TerminalView {
  const views = (view as unknown as { views: Map<TabId, TerminalView> }).views;
  const found = views.get(tab);
  if (found === undefined) throw new Error(`no live view for tab ${tab}`);
  return found;
}

function termOf(view: TerminalView): Terminal {
  return (view as unknown as { term: Terminal }).term;
}

function newWorkspaceView(): WorkspaceView {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return new WorkspaceView(
    root,
    async () => null,
    new SwitchTracer(() => undefined),
    { setPrompt: () => undefined, flashError: () => undefined },
  );
}

describe("리로드를 넘는 스크롤 기억", () => {
  it("pagehide 가 활성 뷰의 위치를 저장하고, 리로드 뒤 뷰가 그 자리로 돌아온다", async () => {
    window.sessionStorage.clear();
    h.attach = () => Promise.resolve(attachBody(lines(200)));

    // 리로드 전 페이지 — 사용자가 20줄 위로 올려 둔 상태.
    const before = newWorkspaceView();
    before.render(snapshot());
    await sleep(50);
    termOf(liveView(before, TAB)).scrollLines(-20);

    window.dispatchEvent(new Event("pagehide"));
    const stored = window.sessionStorage.getItem(SCROLL_MEMORY_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "null")).toEqual({
      version: 1,
      entries: { [String(TAB)]: { session: SESSION, offset: 20 } },
    });

    // 리로드 후 페이지 — 새 WorkspaceView·새 인스턴스가 같은 저장소를 읽는다.
    const after = newWorkspaceView();
    after.render(snapshot());
    await sleep(50);
    expect(liveView(after, TAB).rememberedScrollOffset()).toBe(20);
    // 1회성 — 두 번째 페이지가 같은 값을 다시 받지 않는다.
    expect(window.sessionStorage.getItem(SCROLL_MEMORY_KEY)).toBeNull();
  });

  it("기억이 없으면 뷰는 하단에서 시작한다", async () => {
    window.sessionStorage.clear();
    h.attach = () => Promise.resolve(attachBody(lines(200)));

    const view = newWorkspaceView();
    view.render(snapshot());
    await sleep(50);
    expect(liveView(view, TAB).rememberedScrollOffset()).toBeNull();
  });
});
