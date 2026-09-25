// @vitest-environment happy-dom
//
// 보드 뷰 검증 — 파싱·카드·정렬 판정은 board-model 이 이미 잠갔으므로
// 여기서는 그리기와 dispatch 배선만 본다: 헤더 라벨, 카드 순서가 buildCards
// 그대로인지, 버튼이 내보내는 명령 형태, manager-board 이벤트 재렌더, dispose
// 뒤 무시, 그리고 quote 펼침이 재렌더에도 남는지.
//
// backend 는 모의한다 — 실 Tauri IPC 없이 getManagerBoard/onManagerBoard/
// managerAction 만 갈아 끼우고 나머지 DTO 는 실제 모듈을 그대로 쓴다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getManagerBoard, managerAction, onManagerBoard } from "../../infrastructure/backend";
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
    managerAction: vi.fn(),
    onManagerBoard: vi.fn(),
  };
});

const NOW = Date.parse("2026-09-25T04:30:00Z");
const KEY = "k0123456789abcdef0123";

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
    task: null,
    error: null,
    archive: null,
    ...overrides,
  };
}

interface RawTaskOptions {
  title?: string;
  headline?: string;
  updatedAt?: string;
  lastError?: string | null;
  limits?: string[];
  reported?: boolean;
  verified?: boolean;
  questions?: { id: string; text: string; quote: string | null }[];
  decisions?: {
    id: string;
    text: string;
    quote: string | null;
    by: "user" | "ai";
    status?: "active" | "superseded";
  }[];
  next?: { id: string; text: string }[];
  plans?: { path: string; goal: string; status?: "active" | "removed" }[];
}

function rawTask(options: RawTaskOptions = {}): Record<string, unknown> {
  return {
    title: options.title ?? "task",
    headline: options.headline ?? "headline",
    meta: {
      updated_at: options.updatedAt ?? "2026-09-25T00:00:00Z",
      last_error: options.lastError ?? null,
      limits: options.limits ?? [],
    },
    progress: {
      text: "progress",
      reported_done: options.reported ?? false,
      verified_done: options.verified ?? false,
    },
    open_questions: (options.questions ?? []).map((question) => ({
      ...question,
      status: "active",
      anchor: null,
    })),
    decisions: (options.decisions ?? []).map((decision) => ({
      ...decision,
      status: decision.status ?? "active",
    })),
    next: (options.next ?? []).map((item) => ({ ...item, status: "active" })),
    plans: (options.plans ?? []).map((plan) => ({
      path: plan.path,
      goal: plan.goal,
      status: plan.status ?? "active",
      steps: [],
    })),
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

beforeEach(() => {
  vi.mocked(managerAction).mockResolvedValue(undefined);
});

describe("BoardView header", () => {
  it("renders every glue state label with the last-collected string", async () => {
    const cases: [GlueStatus["state"], string][] = [
      ["disabled", "Disabled"],
      ["starting", "Starting"],
      ["ok", "Watching"],
      ["busy", "Collecting"],
      ["failed", "Failed"],
      ["unsupported", "Unsupported"],
      ["restarting", "Restarting"],
    ];
    for (const [state, label] of cases) {
      const h = await mount({
        payload: {
          status: status({
            state,
            lastCollectedAt: new Date(NOW - 180_000).toISOString(),
            logPath: "/logs/harness.log",
          }),
          board: null,
        },
        snapshot: () => null,
      });
      expect(h.view.root.querySelector(".board-state")?.textContent).toBe(label);
      expect(h.view.root.querySelector(".board-collected")?.textContent).toBe(
        "Last collected 3m ago",
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
    const board = payload([rawEntry(1, { task: rawTask() })]);
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

  it("renders the card body: headline, progress flags, decisions, next and plans", async () => {
    const state = appState([ws(1, { rootPath: "/repo" })]);
    const entry = rawEntry(1, {
      task: rawTask({
        headline: "working on CH19",
        reported: true,
        questions: [{ id: "q1", text: "ask?", quote: "quoted answer" }],
        decisions: [
          { id: "d1", text: "user choice", quote: "u quote", by: "user" },
          { id: "d2", text: "ai choice", quote: null, by: "ai" },
          { id: "d3", text: "old choice", quote: null, by: "user", status: "superseded" },
        ],
        next: [{ id: "n1", text: "do next" }],
        plans: [{ path: "docs/plans/x.md", goal: "goal x" }],
      }),
    });
    const h = await mount({ payload: payload([entry]), snapshot: () => snapshot(state) });

    expect(h.view.root.querySelector(".board-headline")?.textContent).toBe("working on CH19");
    expect(h.view.root.querySelector(".board-progress-text")?.textContent).toBe("progress");
    expect(h.view.root.querySelector(".board-reported")?.classList.contains("done")).toBe(true);
    expect(h.view.root.querySelector(".board-verified")?.classList.contains("done")).toBe(false);
    expect(h.view.root.querySelector(".board-superseded")?.textContent).toBe("1 superseded");
    expect(h.view.root.querySelectorAll(".board-group")).toHaveLength(2);
    expect(h.view.root.querySelector(".board-next-item")?.textContent).toBe("do next");
    expect(h.view.root.querySelector(".board-plan-goal")?.textContent).toBe("goal x");
    h.view.dispose();
  });

  it("shows no-record, error, reason, stale and limits markers", async () => {
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
        rawEntry(4, {
          task: rawTask({ lastError: "summary failed", limits: ["input_truncated"] }),
        }),
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
    expect(byId.get("4")?.querySelector(".board-limit")?.textContent).toBe("input_truncated");
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
      payload: payload([rawEntry(1, { task: rawTask() })]),
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

  it("Open plan creates a markdownViewer tab in the target workspace then switches", async () => {
    const state = appState([ws(1, { rootPath: "/repo" })]);
    const entry = rawEntry(1, {
      task: rawTask({
        plans: [
          { path: "docs/plans/a.md", goal: "active plan" },
          { path: "docs/plans/gone.md", goal: "removed plan", status: "removed" },
        ],
      }),
    });
    const h = await mount({ payload: payload([entry]), snapshot: () => snapshot(state) });

    const buttons = [...h.view.root.querySelectorAll<HTMLButtonElement>(".board-open-plan")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(true); // removed 는 linkPath null → 비활성

    buttons[0]?.click();
    await flush();

    expect(h.emitted).toEqual([
      {
        type: "createTab",
        pane: 1,
        tab: { type: "markdownViewer", path: "/repo/docs/plans/a.md" },
      },
      { type: "switchWorkspace", workspace: 1 },
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

  it("Resume and Start fresh send managerAction with the entry key", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    const h = await mount({
      payload: payload([rawEntry(1, { state: "choice", key: KEY })]),
      snapshot: () => snapshot(state),
    });

    expect(h.view.root.querySelector(".board-choice-text")?.textContent).toBe(
      "Previous record found —",
    );
    click(h, ".board-resume");
    await flush();
    expect(managerAction).toHaveBeenCalledWith("resume", KEY);

    click(h, ".board-fresh");
    await flush();
    expect(managerAction).toHaveBeenLastCalledWith("fresh", KEY);
    expect(h.view.root.querySelector(".board-card-error")).toBeNull();
    h.view.dispose();
  });

  it("shows a managerAction failure on the card", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    const h = await mount({
      payload: payload([rawEntry(1, { state: "choice", key: KEY })]),
      snapshot: () => snapshot(state),
    });
    vi.mocked(managerAction).mockRejectedValue("manager harness is not running");

    click(h, ".board-resume");
    await flush();

    expect(h.view.root.querySelector(".board-card-error")?.textContent).toBe(
      "manager harness is not running",
    );
    h.view.dispose();
  });
});

describe("BoardView live updates", () => {
  it("re-renders when a manager-board event arrives", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    const h = await mount({ payload: payload([]), snapshot: () => snapshot(state) });
    expect(h.view.root.querySelectorAll(".board-card")).toHaveLength(1);

    h.emit(payload([rawEntry(1, { task: rawTask({ title: "from event" }) })]));

    expect(h.view.root.querySelector(".board-card-title")?.textContent).toBe("from event");
    h.view.dispose();
  });

  it("re-renders on update() so live status sorting follows the snapshot", async () => {
    const quiet = appState([ws(1, { name: "alpha" })]);
    const waiting = appState([ws(1, { name: "alpha", agentStatus: "needsInput" })]);
    let current = quiet;
    const h = await mount({
      payload: payload([rawEntry(1, { task: rawTask() })]),
      snapshot: () => snapshot(current),
    });
    expect(h.view.root.querySelector(".board-live")?.textContent).toBe("idle");

    current = waiting;
    h.view.update({ type: "managerBoard" });

    expect(h.view.root.querySelector(".board-live")?.textContent).toBe("needs input");
    h.view.dispose();
  });

  it("ignores late events after dispose and unsubscribes", async () => {
    const state = appState([ws(1, { name: "alpha" })]);
    const h = await mount({ payload: payload([]), snapshot: () => snapshot(state) });
    const before = h.view.root.querySelector(".board-card-title")?.textContent;

    h.view.dispose();
    expect(h.unlisten).toHaveBeenCalledTimes(1);

    h.emit(payload([rawEntry(1, { task: rawTask({ title: "late" }) })]));
    expect(h.view.root.querySelector(".board-card-title")?.textContent).toBe(before);
    expect(h.view.root.querySelector(".board-card-title")?.textContent).not.toBe("late");
  });
});

describe("BoardView quote expansion", () => {
  it("keeps the expanded quote across re-renders", async () => {
    const state = appState([ws(1)]);
    const question = { id: "q1", text: "why?", quote: "because" };
    const h = await mount({
      payload: payload([rawEntry(1, { task: rawTask({ questions: [question] }) })]),
      snapshot: () => snapshot(state),
    });
    expect(h.view.root.querySelector(".board-quote")).toBeNull();

    click(h, ".board-toggle");
    expect(h.view.root.querySelector(".board-quote")?.textContent).toBe("because");

    // 실제 재렌더를 강제한다 (headline 변경 → 서명 변화 + 카드 재조립).
    h.emit(
      payload([
        rawEntry(1, { task: rawTask({ headline: "changed", questions: [question] }) }),
      ]),
    );

    expect(h.view.root.querySelector(".board-headline")?.textContent).toBe("changed");
    expect(h.view.root.querySelector(".board-quote")?.textContent).toBe("because");
    h.view.dispose();
  });
});

// headerModel 을 통한 헤더 라벨 계약이 뷰 DOM 과 어긋나지 않는지 마지막으로
// 확인한다 — 뷰가 모델을 우회해 자체 라벨을 만들면 여기서 갈라진다.
describe("BoardView uses headerModel", () => {
  it("matches headerModel for a failed status", async () => {
    const h = await mount({
      payload: { status: status({ state: "failed", logPath: "/logs/x.log" }), board: null },
      snapshot: () => null,
    });
    const expected = headerModel(status({ state: "failed", logPath: "/logs/x.log" }), NOW);
    expect(h.view.root.querySelector(".board-state")?.textContent).toBe(expected.label);
    expect(h.view.root.querySelector(".board-collected")?.textContent).toBe(expected.lastCollected);
    h.view.dispose();
  });
});
