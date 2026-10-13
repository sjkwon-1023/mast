// @vitest-environment happy-dom
//
// 보드 뷰 검증 — 파싱·카드·정렬 판정은 board-model 이 이미 잠갔으므로
// 여기서는 그리기와 dispatch 배선만 본다: 헤더 라벨, 카드 순서가 buildCards
// 그대로인지, 버튼이 내보내는 명령 형태, manager-board 이벤트 재렌더, dispose
// 뒤 무시, 그리고 최신 요약 세 필드 표시.
//
// backend 는 모의한다 — 실 Tauri IPC 없이 getManagerBoard/onManagerBoard 등만
// 갈아 끼우고 나머지 DTO 는 실제 모듈을 그대로 쓴다.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getManagerBoard,
  onManagerBoard,
  pickWorkspaceFolder,
} from "../../infrastructure/backend";
import { buildCards, headerModel, parseBoard } from "./board-model";
import { BoardView } from "./board-view";
import type { GlueStatus } from "./board-model";
import type { ManagerBoardPayload } from "../../infrastructure/backend";
import type {
  AgentStatus,
  AppState,
  Command,
  CommandOutput,
  Pane,
  StateSnapshot,
  Tab,
  Workspace,
} from "../../shared/types";

vi.mock("../../infrastructure/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infrastructure/backend")>();
  return {
    ...actual,
    getManagerBoard: vi.fn(),
    onManagerBoard: vi.fn(),
    pickWorkspaceFolder: vi.fn(),
  };
});

const NOW = Date.parse("2026-09-25T04:30:00Z");

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function status(overrides: Partial<GlueStatus> = {}): GlueStatus {
  return { state: "ok", message: null, lastCollectedAt: null, logPath: null, ...overrides };
}

/** board payload — entries 는 파싱 전 원시 JSON 이다 (하네스 원문 계약). */
function payload(entries: unknown[], overrides: Partial<GlueStatus> = {}): ManagerBoardPayload {
  return {
    status: status(overrides),
    board: { type: "board", generatedAt: "2026-09-25T04:20:00Z", entries },
  };
}

function rawEntry(workspaceId: number, overrides: Record<string, unknown> = {}): unknown {
  return {
    workspaceId,
    key: null,
    state: "active",
    reason: null,
    summary: null,
    updatedAt: null,
    lastError: null,
    inputTruncated: false,
    error: null,
    repo: null,
    ...overrides,
  };
}

interface RawSummaryOptions {
  progress?: string;
  needsInput?: string;
  next?: string;
  updatedAt?: string;
  lastError?: string | null;
  inputTruncated?: boolean;
}

function rawSummary(options: RawSummaryOptions = {}): Record<string, unknown> {
  return {
    summary: {
      progress: options.progress ?? "progress",
      needs_input: options.needsInput ?? "",
      next: options.next ?? "",
    },
    updatedAt: options.updatedAt ?? "2026-09-25T00:00:00Z",
    lastError: options.lastError ?? null,
    inputTruncated: options.inputTruncated ?? false,
  };
}

function terminalTab(id: number, agentStatus: AgentStatus = "idle"): Tab {
  return {
    id,
    title: `tab ${id}`,
    kind: { type: "terminal", ptySession: id * 100, status: { type: "running" }, cwd: null },
    notification: "none",
    lastActivityMs: null,
    agentStatus,
    lastAgentMessage: null,
  };
}

function pane(id: number, tabs: Tab[]): Pane {
  return { id, tabs, activeTab: tabs[0]?.id ?? null };
}

function ws(
  id: number,
  options: {
    name?: string;
    rootPath?: string | null;
    agentStatus?: AgentStatus;
    manager?: boolean;
    panes?: Record<string, Pane>;
  } = {},
): Workspace {
  const tabs = [terminalTab(id * 10)];
  return {
    id,
    name: options.name ?? `ws ${id}`,
    rootPath: options.rootPath ?? null,
    distro: null,
    repoRoot: null,
    gitBranch: null,
    gitDirty: null,
    manager: options.manager ?? false,
    layout: { type: "leaf", pane: id },
    panes: options.panes ?? { [String(id)]: pane(id, tabs) },
    activePane: id,
    agentStatus: options.agentStatus ?? "idle",
    lastAgentMessage: null,
  };
}

function appState(workspaces: Workspace[]): AppState {
  return { workspaces, activeWorkspace: workspaces[0]?.id ?? null, nextId: 100, revision: 1 };
}

function snapshot(state: AppState): StateSnapshot {
  return { revision: state.revision, state };
}

interface Harness {
  view: BoardView;
  emitted: Command[];
  emit: (next: ManagerBoardPayload) => void;
  unlisten: ReturnType<typeof vi.fn>;
}

async function mount(options: {
  payload: ManagerBoardPayload;
  snapshot: () => StateSnapshot | null;
  dispatch?: (cmd: Command) => Promise<CommandOutput | null>;
}): Promise<Harness> {
  let handler: ((next: ManagerBoardPayload) => void) | null = null;
  const unlisten = vi.fn();
  vi.mocked(onManagerBoard).mockImplementation(async (cb) => {
    handler = cb;
    return unlisten;
  });
  vi.mocked(getManagerBoard).mockResolvedValue(options.payload);

  const emitted: Command[] = [];
  const parent = document.createElement("div");
  document.body.replaceChildren(parent);
  const view = new BoardView(parent, {
    dispatch: async (cmd) => {
      emitted.push(cmd);
      return options.dispatch !== undefined ? options.dispatch(cmd) : { type: "done" };
    },
    snapshot: options.snapshot,
    now: () => NOW,
  });
  await flush();
  return {
    view,
    emitted,
    emit: (next) => {
      if (handler === null) throw new Error("manager-board subscription was not installed");
      handler(next);
    },
    unlisten,
  };
}

/** 뷰 루트 안의 버튼을 찾아 누른다 (없으면 테스트 실패). */
function click(h: Harness, selector: string): void {
  const el = h.view.root.querySelector<HTMLButtonElement>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  el.click();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("BoardView header", () => {
  it("renders every glue state through headerModel", async () => {
    const states: GlueStatus["state"][] = [
      "disabled",
      "starting",
      "ok",
      "busy",
      "failed",
      "unsupported",
      "restarting",
    ];
    for (const state of states) {
      const glue = status({
        state,
        lastCollectedAt: new Date(NOW - 180_000).toISOString(),
        logPath: "/logs/harness.log",
      });
      const expected = headerModel(glue, NOW);
      const h = await mount({
        payload: { status: glue, board: null },
        snapshot: () => null,
      });
      expect(h.view.root.querySelector(".board-state")?.textContent).toBe(expected.label);
      expect(h.view.root.querySelector(".board-collected")?.textContent).toBe(
        expected.lastCollected,
      );
      expect(h.view.root.querySelector<HTMLButtonElement>(".board-open-log")?.hidden).toBe(false);
      h.view.dispose();
    }
  });

  it("hides Open log without a log path and shows Never collected without a timestamp", async () => {
    const h = await mount({ payload: payload([], { lastCollectedAt: null, logPath: null }), snapshot: () => null });
    expect(h.view.root.querySelector(".board-collected")?.textContent).toBe("Never collected");
    expect(h.view.root.querySelector<HTMLButtonElement>(".board-open-log")?.hidden).toBe(true);
    h.view.dispose();
  });
});

describe("BoardView cards", () => {
  it("renders one card per non-manager workspace in board-model order", async () => {
    const state = appState([
      ws(1, { name: "zeta" }),
      ws(2, { name: "alpha", agentStatus: "needsInput" }),
      ws(3, { name: "manager", manager: true }),
    ]);
    const board = payload([rawEntry(1, rawSummary())]);
    const h = await mount({ payload: board, snapshot: () => snapshot(state) });

    const expected = buildCards(
      state,
      parseBoard(board.board),
      board.status,
      NOW,
    ).map((card) => card.workspaceId);
    const rendered = [...h.view.root.querySelectorAll<HTMLElement>(".board-card")].map((el) =>
      Number(el.dataset.workspaceId),
    );
    expect(rendered).toEqual(expected);
    expect(rendered).not.toContain(3);
    h.view.dispose();
  });

  it("renders the summary: progress, needs input and next", async () => {
    const state = appState([ws(1, { rootPath: "/repo" })]);
    const entry = rawEntry(1, rawSummary({
      progress: "working on CH19",
      needsInput: "which color?",
      next: "do next",
    }));
    const h = await mount({ payload: payload([entry]), snapshot: () => snapshot(state) });

    expect(h.view.root.querySelector(".board-card-title")?.textContent).toBe("ws 1");
    expect(h.view.root.querySelector(".board-progress-text")?.textContent).toBe("working on CH19");
    expect(h.view.root.querySelector(".board-needs-input")?.textContent).toBe("which color?");
    expect(h.view.root.querySelector(".board-next-item")?.textContent).toBe("do next");
    h.view.dispose();
  });

  it("omits empty summary fields", async () => {
    const state = appState([ws(1)]);
    const h = await mount({
      payload: payload([rawEntry(1, rawSummary({ progress: "", needsInput: "", next: "" }))]),
      snapshot: () => snapshot(state),
    });

    expect(h.view.root.querySelector(".board-progress")).toBeNull();
    expect(h.view.root.querySelector(".board-needs-input")).toBeNull();
    expect(h.view.root.querySelector(".board-next-item")).toBeNull();
    h.view.dispose();
  });

  it("shows no-record, error, reason, stale and truncation markers", async () => {
    const state = appState([
      ws(1, { name: "alpha" }),
      ws(2, { name: "bravo" }),
      ws(3, { name: "charlie" }),
      ws(4, { name: "delta" }),
    ]);
    const h = await mount({
      payload: payload([
        // entry 자체가 없는 워크스페이스("No record yet") — ws1.
        rawEntry(2, { state: "error", error: "board.entries[1].state must be one of …" }),
        rawEntry(3, { state: "unsupported", reason: "other_distro" }),
        rawEntry(4, rawSummary({ lastError: "summary failed", inputTruncated: true })),
      ]),
      snapshot: () => snapshot(state),
    });

    const byId = new Map(
      [...h.view.root.querySelectorAll<HTMLElement>(".board-card")].map((el) => [
        el.dataset.workspaceId,
        el,
      ]),
    );
    expect(byId.get("1")?.querySelector(".board-empty")?.textContent).toBe("No record yet");
    expect(byId.get("2")?.querySelector(".board-error")?.textContent).toContain("state");
    expect(byId.get("3")?.querySelector(".board-reason")?.textContent).toBe("other_distro");
    expect(byId.get("4")?.querySelector(".board-stale")).not.toBeNull();
    expect(byId.get("4")?.querySelector(".board-limit")?.textContent).toBe("input truncated");
    h.view.dispose();
  });
});

describe("BoardView repo groups", () => {
  const mast = { name: "mast", path: "/repo/mast", remote: null };

  it("renders the repo header label, card count and waiting count above its cards", async () => {
    const state = appState([
      ws(1, { name: "alpha" }),
      ws(2, { name: "beta" }),
      ws(3, { name: "gamma" }),
    ]);
    const h = await mount({
      payload: payload([
        rawEntry(1, { repo: mast, ...rawSummary() }),
        rawEntry(2, { repo: mast, ...rawSummary({ needsInput: "answer" }) }),
        rawEntry(3, rawSummary()),
      ]),
      snapshot: () => snapshot(state),
    });

    const headers = [...h.view.root.querySelectorAll<HTMLElement>(".board-repo-head")];
    expect(headers.map((head) => head.querySelector(".board-repo-label")?.textContent)).toEqual([
      "mast",
      "Other",
    ]);
    expect(headers.map((head) => head.querySelector(".board-repo-count")?.textContent)).toEqual([
      "2 cards",
      "1 card",
    ]);
    expect(headers.map((head) => head.querySelector(".board-repo-waiting")?.textContent)).toEqual([
      "1 waiting",
      "0 waiting",
    ]);
    expect(
      [...h.view.root.querySelectorAll<HTMLElement>(".board-repo-group")].map(
        (group) => group.querySelectorAll(".board-card").length,
      ),
    ).toEqual([2, 1]);
    h.view.dispose();
  });

  it("keeps a collapsed repo group collapsed across re-renders", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    const h = await mount({
      payload: payload([rawEntry(1, { repo: mast, ...rawSummary() })]),
      snapshot: () => snapshot(state),
    });
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(1);

    click(h, ".board-repo-head");
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(0);
    expect(h.view.root.querySelector(".board-repo-head")?.getAttribute("aria-expanded")).toBe(
      "false",
    );

    h.emit(payload([rawEntry(1, { repo: mast, ...rawSummary({ progress: "changed" }) })]));
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(0);
    expect(h.view.root.querySelector(".board-repo-head")?.getAttribute("aria-expanded")).toBe(
      "false",
    );

    click(h, ".board-repo-head");
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(1);
    expect(h.view.root.querySelector(".board-repo-head")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    h.view.dispose();
  });

  it("forgets a collapsed Other group when it becomes the only group", async () => {
    const state = appState([ws(1, { name: "alpha" }), ws(2, { name: "beta" })]);
    const h = await mount({
      payload: payload([
        rawEntry(1, { repo: mast, ...rawSummary() }),
        rawEntry(2, rawSummary()),
      ]),
      snapshot: () => snapshot(state),
    });
    const otherHead = (): HTMLButtonElement | null =>
      [...h.view.root.querySelectorAll<HTMLButtonElement>(".board-repo-head")].find(
        (head) => head.querySelector(".board-repo-label")?.textContent === "Other",
      ) ?? null;

    click(h, '.board-repo-group[data-repo-key="other"] .board-repo-head');
    expect(otherHead()?.getAttribute("aria-expanded")).toBe("false");
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(1);

    // 레포 그룹이 모두 사라져 헤더 없는 단일 Other 모드가 된다.
    h.emit(payload([rawEntry(2, rawSummary())]));
    expect(h.view.root.querySelectorAll(".board-repo-head")).toHaveLength(0);
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(2);

    // 레포 그룹이 다시 생기면 Other는 접힘이 아니라 펼침으로 나타난다.
    h.emit(
      payload([
        rawEntry(1, { repo: mast, ...rawSummary() }),
        rawEntry(2, rawSummary()),
      ]),
    );
    expect(otherHead()?.getAttribute("aria-expanded")).toBe("true");
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(2);
    h.view.dispose();
  });

  it("returns focus to the same repo header after collapsing and expanding", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    const h = await mount({
      payload: payload([rawEntry(1, { repo: mast, ...rawSummary() })]),
      snapshot: () => snapshot(state),
    });
    const head = (): HTMLButtonElement => {
      const el = h.view.root.querySelector<HTMLButtonElement>(
        '.board-repo-group[data-repo-key="/repo/mast"] .board-repo-head',
      );
      if (el === null) throw new Error("missing repo header");
      return el;
    };

    head().focus();
    head().click();
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(0);
    expect(document.activeElement).toBe(head());

    head().click();
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(1);
    expect(document.activeElement).toBe(head());
    h.view.dispose();
  });

  it("draws cards without a header when every card is in the Other group", async () => {
    const state = appState([ws(1, { name: "alpha" }), ws(2, { name: "beta" })]);
    const h = await mount({
      payload: payload([
        rawEntry(1, rawSummary()),
        rawEntry(2, rawSummary()),
      ]),
      snapshot: () => snapshot(state),
    });

    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(2);
    expect(h.view.root.querySelectorAll(".board-repo-head")).toHaveLength(0);

    h.emit(
      payload([
        rawEntry(1, { repo: mast, ...rawSummary() }),
        rawEntry(2, rawSummary()),
      ]),
    );
    expect(h.view.root.querySelectorAll(".board-repo-head")).toHaveLength(2);
    h.view.dispose();
  });

  it("renders a repo label as text, never as markup", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    const h = await mount({
      payload: payload([
        rawEntry(1, { repo: { name: "<img src=x onerror=alert(1)>", path: "/repo/x", remote: null } }),
      ]),
      snapshot: () => snapshot(state),
    });

    expect(h.view.root.querySelector("img")).toBeNull();
    expect(h.view.root.querySelector(".board-repo-label")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
    h.view.dispose();
  });
});

describe("BoardView buttons", () => {
  it("Go to dispatches switchWorkspace then activateTab from goToTarget", async () => {
    const state = appState([
      ws(1, {
        panes: { "1": pane(1, [terminalTab(8), terminalTab(7, "needsInput")]) },
      }),
    ]);
    const h = await mount({
      payload: payload([rawEntry(1, rawSummary())]),
      snapshot: () => snapshot(state),
    });

    click(h, ".board-goto");
    await flush();

    expect(h.emitted).toEqual([
      { type: "switchWorkspace", workspace: 1 },
      { type: "activateTab", tab: 7 },
    ]);
    h.view.dispose();
  });

  it("Open log creates a textViewer tab in the manager workspace's active pane", async () => {
    const state = appState([ws(9, { name: "Manager", manager: true })]);
    const h = await mount({
      payload: payload([], { logPath: "/logs/harness.log" }),
      snapshot: () => snapshot(state),
    });

    click(h, ".board-open-log");
    await flush();

    expect(h.emitted).toEqual([
      { type: "createTab", pane: 9, tab: { type: "textViewer", path: "/logs/harness.log" } },
    ]);
    h.view.dispose();
  });
});

describe("BoardView workspace paths", () => {
  function text(h: Harness, selector: string): string | null | undefined {
    return h.view.root.querySelector(selector)?.textContent;
  }

  it("shows the root and an automatic repo, and offers Auto only for a set repo root", async () => {
    const state = appState([
      ws(1, { rootPath: "/repo/main" }),
      { ...ws(2, { rootPath: "/other" }), repoRoot: "/repo" },
    ]);
    const h = await mount({
      payload: payload([rawEntry(1), rawEntry(2)]),
      snapshot: () => snapshot(state),
    });

    const cards = [...h.view.root.querySelectorAll<HTMLElement>(".board-card")];
    const byId = (id: number) => cards.find((card) => card.dataset.workspaceId === String(id));
    expect(byId(1)?.querySelector(".board-root-path")?.textContent).toBe("/repo/main");
    expect(byId(1)?.querySelector(".board-repo-root")?.textContent).toBe("auto (from git)");
    expect(byId(1)?.querySelector(".board-auto-repo")).toBeNull();
    expect(byId(2)?.querySelector(".board-repo-root")?.textContent).toBe("/repo");
    expect(byId(2)?.querySelector(".board-auto-repo")).not.toBeNull();
    h.view.dispose();
  });

  it("sends the picked folder as the new root or repo root, and Auto clears the repo root", async () => {
    const state = appState([{ ...ws(1, { rootPath: "/repo/main" }), repoRoot: "/repo" }]);
    const h = await mount({ payload: payload([rawEntry(1)]), snapshot: () => snapshot(state) });
    vi.mocked(pickWorkspaceFolder).mockResolvedValue({
      linux_path: "/repo/next",
      distro: null,
      name: "next",
    });

    click(h, ".board-change-root");
    await flush();
    click(h, ".board-set-repo");
    await flush();
    click(h, ".board-auto-repo");
    await flush();

    expect(h.emitted).toEqual([
      { type: "setWorkspaceRoot", workspace: 1, rootPath: "/repo/next" },
      { type: "setWorkspaceRepoRoot", workspace: 1, repoRoot: "/repo/next" },
      { type: "setWorkspaceRepoRoot", workspace: 1, repoRoot: null },
    ]);
    h.view.dispose();
  });

  it("ignores a cancelled picker and shows picker failures and a distro mismatch on the card", async () => {
    const state = appState([{ ...ws(1, { rootPath: "/repo" }), distro: "Ubuntu" }]);
    const h = await mount({ payload: payload([rawEntry(1)]), snapshot: () => snapshot(state) });

    vi.mocked(pickWorkspaceFolder).mockResolvedValue(null);
    click(h, ".board-change-root");
    await flush();
    expect(h.emitted).toEqual([]);
    expect(h.view.root.querySelector(".board-card-error")).toBeNull();

    vi.mocked(pickWorkspaceFolder).mockRejectedValue("selected path is not valid UTF-8");
    click(h, ".board-change-root");
    await flush();
    expect(text(h, ".board-card-error")).toBe("selected path is not valid UTF-8");

    vi.mocked(pickWorkspaceFolder).mockResolvedValue({
      linux_path: "/home/u/x",
      distro: "Debian",
      name: "x",
    });
    click(h, ".board-set-repo");
    await flush();
    expect(h.emitted).toEqual([]);
    expect(text(h, ".board-card-error")).toBe(
      "the folder is in WSL distribution Debian, but this workspace uses Ubuntu",
    );
    h.view.dispose();
  });
});

describe("BoardView live updates", () => {
  it("re-renders when a manager-board event arrives", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    const h = await mount({ payload: payload([]), snapshot: () => snapshot(state) });
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(1);

    h.emit(payload([rawEntry(1, rawSummary({ progress: "from event" }))]));

    expect(h.view.root.querySelector(".board-progress-text")?.textContent).toBe("from event");
    h.view.dispose();
  });

  it("re-renders on update() so live status sorting follows the snapshot", async () => {
    const quiet = appState([ws(1, { name: "alpha" })]);
    const waiting = appState([ws(1, { name: "alpha", agentStatus: "needsInput" })]);
    let current = quiet;
    const h = await mount({
      payload: payload([rawEntry(1, rawSummary())]),
      snapshot: () => snapshot(current),
    });
    expect(h.view.root.querySelector(".board-live")?.textContent).toBe("idle");

    current = waiting;
    h.view.update({ type: "managerBoard" });

    expect(h.view.root.querySelector(".board-live")?.textContent).toBe("needs input");
    h.view.dispose();
  });

  it("shows every consecutive payload from the same second", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    const h = await mount({
      payload: payload([rawEntry(1, rawSummary({ progress: "first" }))]),
      snapshot: () => snapshot(state),
    });
    expect(h.view.root.querySelector(".board-progress-text")?.textContent).toBe("first");

    // generatedAt(초 단위)이 같아도 각 payload 는 다시 그린다.
    h.emit(payload([rawEntry(1, rawSummary({ progress: "second" }))]));
    expect(h.view.root.querySelector(".board-progress-text")?.textContent).toBe("second");
    h.view.dispose();
  });

  it("parses a payload once and never re-parses on snapshot updates", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    let reads = 0;
    const rawBoard = new Proxy(
      { type: "board", generatedAt: "2026-09-25T04:20:00Z", entries: [rawEntry(1, rawSummary())] },
      {
        get(target, key, receiver) {
          reads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const h = await mount({
      payload: { status: status(), board: rawBoard },
      snapshot: () => snapshot(state),
    });
    expect(reads).toBeGreaterThan(0);
    const afterLoad = reads;

    h.view.update({ type: "managerBoard" });
    expect(reads).toBe(afterLoad);
    h.view.dispose();
  });

  it("ignores late events after dispose and unsubscribes", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    const h = await mount({ payload: payload([]), snapshot: () => snapshot(state) });
    const before = h.view.root.querySelector(".board-card-title")?.textContent;

    h.view.dispose();
    expect(h.unlisten).toHaveBeenCalledTimes(1);

    h.emit(payload([rawEntry(1, rawSummary({ progress: "late" }))]));
    expect(h.view.root.querySelector(".board-card-title")?.textContent).toBe(before);
  });
});
