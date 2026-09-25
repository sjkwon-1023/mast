// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/platform")>()),
  IS_MAC: true,
}));

vi.mock("../../infrastructure/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infrastructure/backend")>();
  return {
    ...actual,
    detachTerminal: vi.fn(async () => undefined),
    gitDiff: vi.fn(),
    gitStatus: vi.fn(),
  };
});

import { gitDiff, gitStatus } from "../../infrastructure/backend";
import type { GitChange, GitDiff, GitStatus } from "../../infrastructure/backend";
import type { Command, Pane, StateSnapshot, Tab, Workspace } from "../../shared/types";
import { SwitchTracer } from "./switch-trace";
import { WorkspaceView } from "./workspace-view";

const SAVED_PATH = "/Users/세진/project:a\\b";
const REPO_ROOT = "/Users/세진/project:a\\b/repo";

function change(path: string): GitChange {
  return {
    path,
    originalPath: null,
    indexStatus: ".",
    worktreeStatus: "M",
    untracked: false,
    conflicted: false,
  };
}

function status(root: string, entries: GitChange[] = []): GitStatus {
  return { root, unborn: false, entries, truncated: false };
}

function changesTab(id: number, path: string): Tab {
  return {
    id,
    title: "Git changes",
    kind: { type: "changesViewer", path },
    notification: "none",
    lastActivityMs: null,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
}

function workspace(id: number, tab: Tab | null): Workspace {
  const pane: Pane = {
    id,
    tabs: tab === null ? [] : [tab],
    activeTab: tab?.id ?? null,
  };
  return {
    id,
    name: `workspace ${id}`,
    rootPath: null,
    distro: null,
    gitBranch: null,
    gitDirty: null,
    manager: false,
    layout: { type: "leaf", pane: id },
    panes: { [String(id)]: pane },
    activePane: id,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
}

function snapshot(activeWorkspace: number, revision: number, ...workspaces: Workspace[]): StateSnapshot {
  return {
    revision,
    state: {
      workspaces,
      activeWorkspace,
      nextId: 100,
      revision,
    },
  };
}

function mount(dispatch: (command: Command) => Promise<null> = async () => null): {
  root: HTMLDivElement;
  view: WorkspaceView;
} {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  return {
    root,
    view: new WorkspaceView(
      root,
      dispatch,
      new SwitchTracer(() => undefined),
      { setPrompt: () => undefined, flashError: () => undefined },
    ),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("macOS Changes viewer", () => {
  it("mac_header_creates_a_changes_tab_at_the_workspace_root", async () => {
    const dispatched: Command[] = [];
    vi.mocked(gitStatus).mockResolvedValue(status(REPO_ROOT));
    const { root, view } = mount(async (command) => {
      dispatched.push(command);
      return null;
    });
    view.render(snapshot(1, 1, workspace(1, changesTab(11, SAVED_PATH))));
    // 지연 로딩(dynamic import)과 비동기 조회는 부하에 따라 늦어진다 — 고정 시간 대신 결과를 기다린다.
    // 복원된 탭의 조회까지 끝난 뒤에 넘어가야 이 테스트의 늦은 호출이 다음 테스트의 호출 수에 섞이지 않는다.
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLElement>(".changes-root")?.textContent).toBe(REPO_ROOT),
    );

    const button = root.querySelector<HTMLButtonElement>(
      '.pane-header button[title="New changes viewer tab"]',
    );
    expect(button).not.toBeNull();
    button?.click();

    expect(dispatched).toEqual([
      { type: "createTab", pane: 1, tab: { type: "changesViewer", path: null } },
    ]);
  });

  it("restored_mac_changes_tab_loads_native_paths_and_diff", async () => {
    const filePath = 'src/quoted "file" with spaces\nand a second line.ts';
    vi.mocked(gitStatus).mockResolvedValue(status(REPO_ROOT, [change(filePath)]));
    vi.mocked(gitDiff).mockResolvedValue({
      text: "diff --git a/file.ts b/file.ts\n+native path preserved",
      truncated: false,
    });
    const { root, view } = mount();
    view.render(snapshot(1, 1, workspace(1, changesTab(11, SAVED_PATH))));
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLElement>(".changes-root")?.textContent).toBe(REPO_ROOT),
    );

    expect(root.querySelector(".pane-placeholder")?.textContent).not.toContain("deferred");
    expect(gitStatus).toHaveBeenCalledTimes(1);
    expect(gitStatus).toHaveBeenCalledWith(null, SAVED_PATH);
    expect(root.querySelector<HTMLElement>(".changes-root")?.textContent).toBe(REPO_ROOT);

    const row = root.querySelector<HTMLButtonElement>(".changes-file");
    expect(row?.textContent).toContain(filePath);
    row?.click();
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLElement>(".changes-diff")?.textContent).toContain(
        "native path preserved",
      ),
    );

    expect(gitDiff).toHaveBeenCalledWith(null, {
      root: REPO_ROOT,
      path: filePath,
      originalPath: null,
      scope: "all",
      untracked: false,
      unborn: false,
    });
    expect(root.querySelector<HTMLElement>(".changes-diff")?.textContent).toContain(
      "native path preserved",
    );
  });

  it("leaving_mac_changes_discards_late_results", async () => {
    const filePath = "src/late-result.ts";
    const lateDiff = deferred<GitDiff>();
    vi.mocked(gitStatus).mockResolvedValue(status(REPO_ROOT, [change(filePath)]));
    vi.mocked(gitDiff).mockReturnValueOnce(lateDiff.promise);
    const { root, view } = mount();
    const savedWorkspace = workspace(1, changesTab(11, SAVED_PATH));
    const otherWorkspace = workspace(2, null);
    view.render(snapshot(1, 1, savedWorkspace, otherWorkspace));
    await vi.waitFor(() => expect(root.querySelector(".changes-file")).not.toBeNull());

    root.querySelector<HTMLButtonElement>(".changes-file")?.click();
    expect(gitDiff).toHaveBeenCalledTimes(1);

    view.render(snapshot(2, 2, savedWorkspace, otherWorkspace));
    lateDiff.resolve({ text: "stale diff must not render", truncated: false });
    await sleep(20);
    expect(root.querySelector(".changes-diff")).toBeNull();

    view.render(snapshot(1, 3, savedWorkspace, otherWorkspace));
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(2));
    expect(gitStatus).toHaveBeenCalledTimes(2);
    expect(gitStatus).toHaveBeenNthCalledWith(2, null, SAVED_PATH);
  });
});
