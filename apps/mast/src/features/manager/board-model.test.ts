// board-model 순수 검증 — fixture board/작업 문서로 파싱·카드·정렬·이동 대상·
// 헤더를 잠근다. DOM 없이 돌아야 하므로 뷰는 이 파일에 등장하지 않는다.
// fixture 는 types.test.ts 와 같은 레포 루트 fixtures/ 에서 정적 import 한다.

import { describe, expect, it } from "vitest";

import protocolFixtureJson from "../../../../../fixtures/manager-protocol.json";
import taskFixtureJson from "../../../../../fixtures/manager-task.json";
import type { AgentStatus, AppState, Pane, Tab, Workspace } from "../../shared/types";
import {
  buildCards,
  formatUpdatedAgo,
  goToTarget,
  headerModel,
  parseBoard,
} from "./board-model";
import type {
  BoardCard,
  BoardEntry,
  BoardTask,
  GlueStatus,
  ParsedBoard,
  ParsedEntry,
} from "./board-model";

const NOW = Date.parse("2026-09-25T04:30:00Z");

function isoBefore(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
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
  opts: {
    name?: string;
    rootPath?: string | null;
    agentStatus?: AgentStatus;
    manager?: boolean;
    panes?: Record<string, Pane>;
  } = {},
): Workspace {
  return {
    id,
    name: opts.name ?? `ws ${id}`,
    rootPath: opts.rootPath ?? null,
    distro: null,
    gitBranch: null,
    gitDirty: null,
    manager: opts.manager ?? false,
    layout: { type: "leaf", pane: 1 },
    panes: opts.panes ?? { "1": pane(1, [terminalTab(10)]) },
    activePane: 1,
    agentStatus: opts.agentStatus ?? "idle",
    lastAgentMessage: null,
  };
}

function appState(workspaces: Workspace[]): AppState {
  return {
    workspaces,
    activeWorkspace: workspaces[0]?.id ?? null,
    nextId: 100,
    revision: 1,
  };
}

function glueStatus(overrides: Partial<GlueStatus> = {}): GlueStatus {
  return { state: "ok", message: null, lastCollectedAt: null, logPath: null, ...overrides };
}

/** 작업 JSON 생성기 — 테스트마다 필요한 보드-read 필드만 덮어쓴다. */
function task(
  opts: { updatedAt?: string; lastError?: string | null; question?: boolean } = {},
): BoardTask {
  return {
    title: "task",
    headline: "headline",
    meta: {
      updated_at: opts.updatedAt ?? "2026-09-25T00:00:00Z",
      last_error: opts.lastError ?? null,
      limits: [],
    },
    progress: { text: "", reported_done: false, verified_done: false },
    open_questions: opts.question
      ? [{ id: "q1", text: "question", quote: null, status: "active", anchor: null }]
      : [],
    decisions: [],
    next: [],
    plans: [],
  };
}

function fixtureTask(): BoardTask {
  return JSON.parse(JSON.stringify(taskFixtureJson.valid[0])) as BoardTask;
}

function boardEntry(workspaceId: number, overrides: Partial<BoardEntry> = {}): BoardEntry {
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

function parsedEntry(entry: BoardEntry): ParsedEntry {
  return { kind: "entry", ...entry };
}

function boardOf(...entries: ParsedEntry[]): ParsedBoard {
  return { entries, error: null };
}

/** 파싱 전 원시 board — parseBoard 테스트용. */
function rawBoard(entries: unknown[]): unknown {
  return { generatedAt: "2026-09-25T04:20:00Z", entries };
}

function rawEntry(workspaceId: unknown, overrides: Record<string, unknown> = {}): unknown {
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

function fixtureBoardMessage(): unknown {
  const messages = protocolFixtureJson.harnessToApp as unknown as Array<Record<string, unknown>>;
  const board = messages.find((message) => message["type"] === "board");
  if (board === undefined) throw new Error("manager-protocol.json has no board message");
  return board;
}

function onlyCard(state: AppState, board: ParsedBoard, status: GlueStatus = glueStatus()): BoardCard {
  const cards = buildCards(state, board, status, NOW);
  const card = cards[0];
  if (card === undefined) throw new Error("expected at least one card");
  return card;
}

describe("parseBoard", () => {
  it("parses the fixture board message and keeps the entry states", () => {
    const parsed = parseBoard(fixtureBoardMessage());
    expect(parsed.error).toBeNull();
    expect(
      parsed.entries.map((entry) => (entry.kind === "entry" ? entry.state : `invalid`)),
    ).toEqual(["none", "unsupported", "choice"]);

    const noRoot = parsed.entries[0];
    if (noRoot === undefined || noRoot.kind !== "entry") throw new Error("first must be valid");
    expect(noRoot.workspaceId).toBe(4);
    expect(noRoot.reason).toBe("no_root");
    expect(noRoot.task).toBeNull();
    expect(noRoot.archive).toBeNull();

    const unsupported = parsed.entries[1];
    if (unsupported === undefined || unsupported.kind !== "entry") {
      throw new Error("second must be valid");
    }
    expect(unsupported.reason).toBe("other_distro");

    const choice = parsed.entries[2];
    if (choice === undefined || choice.kind !== "entry") throw new Error("third must be valid");
    expect(choice.state).toBe("choice");
    expect(choice.key).toBe("k1a2b3c4d5e6f7081920a");
  });

  it("ignores task fields the board does not read", () => {
    const rawTask = fixtureTask() as unknown as Record<string, unknown>;
    rawTask["future_field"] = { anything: true };
    const parsed = parseBoard(rawBoard([rawEntry(1, { task: rawTask })]));
    expect(parsed.error).toBeNull();
    expect(parsed.entries[0]).toMatchObject({ kind: "entry", workspaceId: 1, state: "active" });
  });

  it("rejects a task whose board-read field is malformed", () => {
    const rawTask = fixtureTask() as unknown as Record<string, unknown>;
    const decisions = rawTask["decisions"] as Array<Record<string, unknown>>;
    decisions[0]!["by"] = "robot";
    const parsed = parseBoard(rawBoard([rawEntry(7, { task: rawTask })]));
    const first = parsed.entries[0];
    expect(first).toMatchObject({ kind: "invalid", workspaceId: 7 });
    if (first === undefined || first.kind !== "invalid") throw new Error("must be invalid");
    expect(first.error).toContain("by");
  });

  it("reports a top-level error and yields no entries when the shape is broken", () => {
    expect(parseBoard(null)).toEqual({ entries: [], error: "board must be an object" });
    const parsed = parseBoard({ generatedAt: "x", entries: "nope" });
    expect(parsed.entries).toEqual([]);
    expect(parsed.error).not.toBeNull();
  });

  it("keeps the workspaceId of a malformed entry so it becomes an error card", () => {
    const rawEntries = (fixtureBoardMessage() as { entries: unknown[] }).entries.slice();
    rawEntries.push(rawEntry(2, { state: "paused" }));
    const parsed = parseBoard(rawBoard(rawEntries));
    const invalid = parsed.entries.find((entry) => entry.kind === "invalid");
    expect(invalid).toMatchObject({ workspaceId: 2 });
    if (invalid === undefined || invalid.kind !== "invalid") throw new Error("must be invalid");
    expect(invalid.error).toContain("state");
  });
});

describe("buildCards", () => {
  it("builds the card model from the realistic task fixture", () => {
    const fixture = fixtureTask();
    fixture.decisions.push(
      {
        id: "d2",
        text: "AI 는 verified_done 을 쓰지 않는다",
        quote: "harness patch 는 verified_done 을 금지합니다",
        status: "active",
        by: "ai",
      },
      {
        id: "d3",
        text: "옛 방식",
        quote: "옛 방식 인용",
        status: "superseded",
        by: "user",
      },
    );
    const card = onlyCard(
      appState([
        ws(1, { name: "mast", rootPath: "/home/u/projects/mast", agentStatus: "idle" }),
      ]),
      boardOf(
        parsedEntry(
          boardEntry(1, {
            key: "k1",
            state: "active",
            task: fixture,
            archive: { count: 1, latestClosedAt: "2026-09-20T00:00:00Z" },
          }),
        ),
      ),
    );

    expect(card.title).toBe("관리자 워크스페이스 preview");
    expect(card.workspaceName).toBe("mast");
    expect(card.headline).toContain("CH7");
    expect(card.progress).toEqual({
      text: "스키마 검증과 flock 저장을 구현했다",
      reportedDone: false,
      verifiedDone: false,
    });
    expect(card.openQuestions).toEqual([
      {
        id: "q1",
        text: "fixture transcript 원본을 어떻게 확보하나?",
        quote: "fixture transcript 원본은 어떻게 확보하지?",
        anchorTab: 4,
      },
    ]);
    expect(card.decisions.user.map((decision) => decision.id)).toEqual(["d1"]);
    expect(card.decisions.ai.map((decision) => decision.id)).toEqual(["d2"]);
    expect(card.decisions.supersededCount).toBe(1);
    expect(card.decisions.user[0]?.quote).toBe("작업 기억은 워크스페이스별 JSON 파일로 두자");
    expect(card.next).toEqual([{ id: "n1", text: "CH8 transcript 추출기를 구현한다" }]);
    expect(card.plans).toEqual([
      {
        path: "docs/plans/example-plan.md",
        goal: "관리자 워크스페이스 preview 구현",
        steps: [
          { text: "CH7 저장소와 patch 검증기", done: true },
          { text: "CH8 transcript 추출", done: false },
        ],
        status: "active",
        linkPath: "/home/u/projects/mast/docs/plans/example-plan.md",
      },
    ]);
    expect(card.liveStatus).toBe("idle");
    expect(card.state).toBe("active");
    expect(card.hasEntry).toBe(true);
    expect(card.archive).toEqual({ count: 1, latestClosedAt: "2026-09-20T00:00:00Z" });
    expect(card.updatedAt).toBe("2026-09-25T02:30:00Z");
    expect(card.updatedAgo).toBe("2h ago");
    expect(card.limits).toEqual(["input_truncated"]);
    expect(card.stale).toBe(false);
  });

  it("shows only active items and falls back to the workspace name for a blank title", () => {
    const fixture = fixtureTask();
    fixture.title = "   ";
    fixture.open_questions[0]!.status = "resolved";
    fixture.next[0]!.status = "superseded";
    fixture.decisions[0]!.status = "superseded";
    const card = onlyCard(
      appState([ws(1, { name: "fallback" })]),
      boardOf(parsedEntry(boardEntry(1, { task: fixture }))),
    );
    expect(card.title).toBe("fallback");
    expect(card.openQuestions).toEqual([]);
    expect(card.next).toEqual([]);
    expect(card.decisions).toEqual({ user: [], ai: [], supersededCount: 1 });
  });

  it("builds an error card for a malformed entry instead of hiding it", () => {
    const rawEntries = (fixtureBoardMessage() as { entries: unknown[] }).entries.slice();
    rawEntries.push(rawEntry(2, { state: "paused" }));
    const parsed = parseBoard(rawBoard(rawEntries));
    const cards = buildCards(
      appState([
        ws(4, { name: "alpha" }),
        ws(3, { name: "bravo" }),
        ws(5, { name: "charlie" }),
        ws(2, { name: "delta" }),
      ]),
      parsed,
      glueStatus(),
      NOW,
    );
    const byId = new Map(cards.map((card) => [card.workspaceId, card]));
    expect(byId.get(2)).toMatchObject({ state: "error", hasEntry: true });
    expect(byId.get(2)?.error).toContain("state");
    expect(byId.get(4)?.state).toBe("none");
    expect(byId.get(3)?.state).toBe("unsupported");
    expect(byId.get(5)?.state).toBe("choice");
    expect([byId.get(4)?.state, byId.get(3)?.state, byId.get(5)?.state]).not.toContain("error");
  });

  it("excludes the manager workspace", () => {
    const cards = buildCards(
      appState([ws(1, { name: "a" }), ws(2, { name: "manager", manager: true })]),
      null,
      glueStatus(),
      NOW,
    );
    expect(cards.map((card) => card.workspaceId)).toEqual([1]);
  });

  it("marks a workspace without a board entry as a no record card", () => {
    const card = onlyCard(appState([ws(9, { name: "quiet" })]), boardOf());
    expect(card).toMatchObject({
      workspaceId: 9,
      title: "quiet",
      headline: "",
      state: "none",
      hasEntry: false,
      reason: null,
      archive: null,
      stale: false,
      updatedAt: null,
      updatedAgo: null,
      limits: [],
    });
    expect(card.progress).toEqual({ text: "", reportedDone: false, verifiedDone: false });
    expect(card.openQuestions).toEqual([]);
    expect(card.decisions).toEqual({ user: [], ai: [], supersededCount: 0 });
  });

  it("disables the plan link when removed or the workspace has no rootPath", () => {
    const fixture = fixtureTask();
    fixture.plans.push({
      path: "docs/plans/gone.md",
      goal: "gone",
      steps: [],
      status: "removed",
    });
    const withRoot = onlyCard(
      appState([ws(1, { rootPath: "/repo" })]),
      boardOf(parsedEntry(boardEntry(1, { task: fixture }))),
    );
    expect(withRoot.plans.map((plan) => plan.linkPath)).toEqual([
      "/repo/docs/plans/example-plan.md",
      null,
    ]);
    const withoutRoot = onlyCard(
      appState([ws(1, { rootPath: null })]),
      boardOf(parsedEntry(boardEntry(1, { task: fixture }))),
    );
    expect(withoutRoot.plans.every((plan) => plan.linkPath === null)).toBe(true);
  });

  it("marks stale from task.last_error or the glue state", () => {
    const cases: Array<[GlueStatus["state"], string | null, boolean]> = [
      ["ok", null, false],
      ["busy", null, false],
      ["starting", null, false],
      ["disabled", null, false],
      ["failed", null, true],
      ["restarting", null, true],
      ["unsupported", null, true],
      ["ok", "summary failed", true],
    ];
    for (const [state, lastError, expected] of cases) {
      const card = onlyCard(
        appState([ws(1)]),
        boardOf(parsedEntry(boardEntry(1, { task: task({ lastError }) }))),
        glueStatus({ state }),
      );
      expect(card.stale, `${state}/${String(lastError)}`).toBe(expected);
    }
  });
});

describe("buildCards sorting (R2)", () => {
  it("puts needsInput-without-questions and idle-with-questions in group 0", () => {
    const cards = buildCards(
      appState([
        ws(1, { name: "waiting", agentStatus: "needsInput" }),
        ws(2, { name: "asking", agentStatus: "idle" }),
        ws(3, { name: "working", agentStatus: "running" }),
        ws(4, { name: "busy", agentStatus: "idle" }),
        ws(5, { name: "quiet", agentStatus: "idle" }),
      ]),
      boardOf(
        parsedEntry(
          boardEntry(2, { task: task({ question: true, updatedAt: "2026-09-25T03:00:00Z" }) }),
        ),
        parsedEntry(
          boardEntry(3, { task: task({ updatedAt: "2026-09-25T04:00:00Z" }) }),
        ),
        parsedEntry(
          boardEntry(4, { task: task({ updatedAt: "2026-09-25T02:00:00Z" }) }),
        ),
      ),
      glueStatus(),
      NOW,
    );
    expect(cards.map((card) => card.workspaceId)).toEqual([2, 1, 3, 4, 5]);
  });

  it("orders by updated_at desc and then by workspace name", () => {
    const cards = buildCards(
      appState([
        ws(1, { name: "zeta" }),
        ws(2, { name: "alpha" }),
        ws(3, { name: "beta" }),
        ws(4, { name: "gamma" }),
      ]),
      boardOf(
        parsedEntry(
          boardEntry(1, { task: task({ updatedAt: "2026-09-25T02:00:00Z" }) }),
        ),
        parsedEntry(
          boardEntry(2, { task: task({ updatedAt: "2026-09-25T04:00:00Z" }) }),
        ),
        parsedEntry(
          boardEntry(3, { task: task({ updatedAt: "2026-09-25T02:00:00Z" }) }),
        ),
        parsedEntry(
          boardEntry(4, { task: task({ updatedAt: "2026-09-25T03:00:00Z" }) }),
        ),
      ),
      glueStatus(),
      NOW,
    );
    expect(cards.map((card) => card.workspaceName)).toEqual(["alpha", "gamma", "beta", "zeta"]);
  });
});

describe("goToTarget", () => {
  it("goes to the smallest needsInput tab first", () => {
    const state = appState([
      ws(1, {
        panes: {
          "1": pane(1, [terminalTab(7, "needsInput"), terminalTab(4, "needsInput"), terminalTab(9)]),
        },
      }),
    ]);
    const card = onlyCard(
      state,
      boardOf(parsedEntry(boardEntry(1, { task: fixtureTask() }))),
    );
    expect(goToTarget(card, state)).toEqual({ workspace: 1, tab: 4 });
  });

  it("falls back to the newest open question anchor tab", () => {
    const state = appState([
      ws(1, { panes: { "1": pane(1, [terminalTab(4), terminalTab(6)]) } }),
    ]);
    const fixture = fixtureTask();
    fixture.open_questions.push({
      id: "q2",
      text: "더 최근 질문",
      quote: null,
      status: "active",
      anchor: { tab: 6 },
    });
    const card = onlyCard(state, boardOf(parsedEntry(boardEntry(1, { task: fixture }))));
    expect(goToTarget(card, state)).toEqual({ workspace: 1, tab: 6 });
  });

  it("returns the workspace only when the anchor tab is not in the snapshot", () => {
    const state = appState([ws(1, { panes: { "1": pane(1, [terminalTab(4)]) } })]);
    const fixture = fixtureTask();
    fixture.open_questions[0]!.anchor = { tab: 99 };
    const card = onlyCard(state, boardOf(parsedEntry(boardEntry(1, { task: fixture }))));
    expect(goToTarget(card, state)).toEqual({ workspace: 1, tab: null });
  });

  it("returns the workspace only when there is no needsInput tab or question", () => {
    const state = appState([ws(1)]);
    const card = onlyCard(state, boardOf(parsedEntry(boardEntry(1, { task: task() }))));
    expect(goToTarget(card, state)).toEqual({ workspace: 1, tab: null });
  });
});

describe("formatUpdatedAgo", () => {
  it("formats seconds, minutes, hours and days at the boundaries", () => {
    expect(formatUpdatedAgo(null, NOW)).toBeNull();
    expect(formatUpdatedAgo("not a date", NOW)).toBeNull();
    expect(formatUpdatedAgo(isoBefore(0), NOW)).toBe("0s ago");
    expect(formatUpdatedAgo(isoBefore(59), NOW)).toBe("59s ago");
    expect(formatUpdatedAgo(isoBefore(60), NOW)).toBe("1m ago");
    expect(formatUpdatedAgo(isoBefore(59 * 60 + 59), NOW)).toBe("59m ago");
    expect(formatUpdatedAgo(isoBefore(60 * 60), NOW)).toBe("1h ago");
    expect(formatUpdatedAgo(isoBefore(23 * 3600 + 3599), NOW)).toBe("23h ago");
    expect(formatUpdatedAgo(isoBefore(24 * 3600), NOW)).toBe("1d ago");
    expect(formatUpdatedAgo(isoBefore(3 * 24 * 3600 + 100), NOW)).toBe("3d ago");
  });
});

describe("headerModel", () => {
  it("labels every glue state", () => {
    const states: GlueStatus["state"][] = [
      "disabled",
      "starting",
      "ok",
      "busy",
      "failed",
      "unsupported",
      "restarting",
    ];
    expect(states.map((state) => headerModel(glueStatus({ state }), NOW).label)).toEqual([
      "Disabled",
      "Starting",
      "Watching",
      "Collecting",
      "Failed",
      "Unsupported",
      "Restarting",
    ]);
  });

  it("formats the last collected time and the log path", () => {
    const watching = headerModel(
      glueStatus({ state: "ok", lastCollectedAt: isoBefore(180), logPath: "/logs/harness.log" }),
      NOW,
    );
    expect(watching).toMatchObject({
      state: "ok",
      label: "Watching",
      lastCollected: "Last collected 3m ago",
      lastCollectedAt: isoBefore(180),
      logPath: "/logs/harness.log",
      canOpenLog: true,
    });
    const never = headerModel(
      glueStatus({ state: "failed", lastCollectedAt: null, logPath: null }),
      NOW,
    );
    expect(never).toMatchObject({
      label: "Failed",
      lastCollected: "Never collected",
      canOpenLog: false,
    });
    const blankLog = headerModel(glueStatus({ logPath: "" }), NOW);
    expect(blankLog.canOpenLog).toBe(false);
  });
});
