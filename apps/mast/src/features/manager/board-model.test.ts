// board-model 순수 검증 — fixture board/요약 문서로 파싱·카드·정렬·이동 대상·
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
  groupCards,
  headerModel,
  parseBoard,
} from "./board-model";
import type {
  BoardCard,
  BoardEntry,
  BoardSummary,
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
    repoRoot: null,
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

/** 요약 생성기 — 테스트마다 필요한 보드-read 필드만 덮어쓴다. */
function summary(
  opts: {
    progress?: string;
    needsInput?: string;
    next?: string;
    updatedAt?: string;
    lastError?: string | null;
    inputTruncated?: boolean;
  } = {},
): BoardSummary {
  return {
    progress: opts.progress ?? "progress",
    needs_input: opts.needsInput ?? "",
    next: opts.next ?? "",
  };
}

function fixtureSummary(): BoardSummary {
  return JSON.parse(JSON.stringify(taskFixtureJson.valid[0].summary)) as BoardSummary;
}

function boardEntry(workspaceId: number, overrides: Partial<BoardEntry> = {}): BoardEntry {
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
    summary: null,
    updatedAt: null,
    lastError: null,
    inputTruncated: false,
    error: null,
    repo: null,
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
    ).toEqual(["unsupported", "unsupported", "none"]);

    const noRoot = parsed.entries[0];
    if (noRoot === undefined || noRoot.kind !== "entry") throw new Error("first must be valid");
    expect(noRoot.workspaceId).toBe(4);
    expect(noRoot.state).toBe("unsupported");
    expect(noRoot.reason).toBe("no_root");
    expect(noRoot.summary).toBeNull();
    expect(noRoot.repo).toBeNull();
    expect(noRoot.inputTruncated).toBe(false);

    const unsupported = parsed.entries[1];
    if (unsupported === undefined || unsupported.kind !== "entry") {
      throw new Error("second must be valid");
    }
    expect(unsupported.reason).toBe("other_distro");

    const third = parsed.entries[2];
    if (third === undefined || third.kind !== "entry") throw new Error("third must be valid");
    expect(third.state).toBe("none");
    expect(third.key).toBe("k1a2b3c4d5e6f7081920a");
    expect(third.repo).toEqual({
      name: "mast",
      path: "/home/u/p/mast",
      remote: "git@github.com:example/mast.git",
    });
  });

  it("treats a malformed repo as null and keeps the entry", () => {
    const cases: unknown[] = [
      "mast",
      { name: "mast" },
      { name: "", path: "/r/mast" },
      { name: "mast", path: 7 },
      { name: "mast", path: "/r/mast", remote: 5 },
      undefined,
    ];
    for (const repo of cases) {
      const parsed = parseBoard(rawBoard([rawEntry(1, { repo })]));
      const first = parsed.entries[0];
      if (first === undefined || first.kind !== "entry") {
        throw new Error(`entry must stay valid for ${JSON.stringify(repo)}`);
      }
      expect(first.repo, JSON.stringify(repo)).toBeNull();
      expect(first.state, JSON.stringify(repo)).toBe("active");
    }
  });

  it("normalizes an empty remote to null", () => {
    const parsed = parseBoard(rawBoard([rawEntry(1, { repo: { name: "m", path: "/r", remote: "" } })]));
    const first = parsed.entries[0];
    if (first === undefined || first.kind !== "entry") throw new Error("must be valid");
    expect(first.repo).toEqual({ name: "m", path: "/r", remote: null });
  });

  it("ignores summary fields the board does not read", () => {
    const rawSummary = fixtureSummary() as unknown as Record<string, unknown>;
    rawSummary["future_field"] = { anything: true };
    const parsed = parseBoard(rawBoard([rawEntry(1, { summary: rawSummary })]));
    expect(parsed.error).toBeNull();
    expect(parsed.entries[0]).toMatchObject({ kind: "entry", workspaceId: 1, state: "active" });
  });

  it("rejects an entry whose display field is malformed", () => {
    const rawSummary = fixtureSummary() as unknown as Record<string, unknown>;
    rawSummary["next"] = 7;
    const parsed = parseBoard(rawBoard([rawEntry(7, { summary: rawSummary })]));
    const first = parsed.entries[0];
    expect(first).toMatchObject({ kind: "invalid", workspaceId: 7 });
    if (first === undefined || first.kind !== "invalid") throw new Error("must be invalid");
    expect(first.error).toContain("next");
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
  it("builds the card model from the realistic summary fixture", () => {
    const fixture = fixtureSummary();
    const card = onlyCard(
      appState([
        ws(1, { name: "mast", rootPath: "/home/u/projects/mast", agentStatus: "idle" }),
      ]),
      boardOf(
        parsedEntry(
          boardEntry(1, {
            key: "k1",
            state: "active",
            summary: fixture,
            updatedAt: "2026-09-25T02:30:00Z",
            inputTruncated: true,
          }),
        ),
      ),
    );

    expect(card.workspaceName).toBe("mast");
    expect(card.summary).toEqual({
      progress: "관리자 최신 요약 저장소와 board 계약을 구현했다",
      needsInput: "fixture transcript 원본을 어떻게 확보하나?",
      next: "하네스 요약 루프를 v2 계약으로 연결한다",
    });
    expect(card.liveStatus).toBe("idle");
    expect(card.state).toBe("active");
    expect(card.hasEntry).toBe(true);
    expect(card.updatedAt).toBe("2026-09-25T02:30:00Z");
    expect(card.updatedAgo).toBe("2h ago");
    expect(card.inputTruncated).toBe(true);
    expect(card.stale).toBe(false);
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
    expect(byId.get(4)?.state).toBe("unsupported");
    expect(byId.get(3)?.state).toBe("unsupported");
    expect(byId.get(5)?.state).toBe("none");
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
      workspaceName: "quiet",
      summary: { progress: "", needsInput: "", next: "" },
      state: "none",
      hasEntry: false,
      reason: null,
      stale: false,
      inputTruncated: false,
      updatedAt: null,
      updatedAgo: null,
    });
  });

  it("marks stale from entry.lastError or the glue state", () => {
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
        boardOf(parsedEntry(boardEntry(1, { lastError }))),
        glueStatus({ state }),
      );
      expect(card.stale, `${state}/${String(lastError)}`).toBe(expected);
    }
  });
});

describe("buildCards sorting (R2)", () => {
  it("puts needsInput or needs_input first, then running, then the rest", () => {
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
          boardEntry(2, {
            summary: summary({ needsInput: "answer me" }),
            updatedAt: "2026-09-25T03:00:00Z",
          }),
        ),
        parsedEntry(
          boardEntry(3, { updatedAt: "2026-09-25T04:00:00Z" }),
        ),
        parsedEntry(
          boardEntry(4, { updatedAt: "2026-09-25T02:00:00Z" }),
        ),
      ),
      glueStatus(),
      NOW,
    );
    expect(cards.map((card) => card.workspaceId)).toEqual([2, 1, 3, 4, 5]);
  });

  it("orders by updatedAt desc and then by workspace name", () => {
    const cards = buildCards(
      appState([
        ws(1, { name: "zeta" }),
        ws(2, { name: "alpha" }),
        ws(3, { name: "beta" }),
        ws(4, { name: "gamma" }),
      ]),
      boardOf(
        parsedEntry(boardEntry(1, { updatedAt: "2026-09-25T02:00:00Z" })),
        parsedEntry(boardEntry(2, { updatedAt: "2026-09-25T04:00:00Z" })),
        parsedEntry(boardEntry(3, { updatedAt: "2026-09-25T02:00:00Z" })),
        parsedEntry(boardEntry(4, { updatedAt: "2026-09-25T03:00:00Z" })),
      ),
      glueStatus(),
      NOW,
    );
    expect(cards.map((card) => card.workspaceName)).toEqual(["alpha", "gamma", "beta", "zeta"]);
  });
});

describe("groupCards", () => {
  const mast = { name: "mast", path: "/repo/mast", remote: null };

  it("groups by repo path and labels the repo-less group Other", () => {
    const state = appState([ws(1, { name: "a" }), ws(2, { name: "b" }), ws(3, { name: "c" })]);
    const parsed = boardOf(
      parsedEntry(boardEntry(1, { repo: mast })),
      parsedEntry(boardEntry(2, { repo: { ...mast } })),
      parsedEntry(boardEntry(3, { repo: null })),
    );
    const groups = groupCards(buildCards(state, parsed, glueStatus(), NOW));
    expect(groups.map((group) => [group.key, group.label, group.cards.length])).toEqual([
      ["/repo/mast", "mast", 2],
      ["other", "Other", 1],
    ]);
    expect(groups[0]?.cards.map((card) => card.repo)).toEqual([mast, mast]);
  });

  it("disambiguates same-name repos by remote, falling back to the path", () => {
    const byRemote = groupCards(
      buildCards(
        appState([ws(1), ws(2)]),
        boardOf(
          parsedEntry(
            boardEntry(1, {
              repo: { name: "mast", path: "/work/mast", remote: "git@github.com:kwon/mast.git" },
            }),
          ),
          parsedEntry(
            boardEntry(2, {
              repo: { name: "mast", path: "/home/mast", remote: "https://github.com/other/mast" },
            }),
          ),
        ),
        glueStatus(),
        NOW,
      ),
    );
    expect(byRemote.map((group) => group.label).sort()).toEqual([
      "mast (kwon/mast)",
      "mast (other/mast)",
    ]);

    const byPath = groupCards(
      buildCards(
        appState([ws(1), ws(2)]),
        boardOf(
          parsedEntry(boardEntry(1, { repo: { name: "mast", path: "/a/mast", remote: null } })),
          parsedEntry(boardEntry(2, { repo: { name: "mast", path: "/b/mast", remote: null } })),
        ),
        glueStatus(),
        NOW,
      ),
    );
    expect(byPath.map((group) => group.label)).toEqual(["mast (/a/mast)", "mast (/b/mast)"]);
  });

  it("orders groups by their best card with Other last on ties", () => {
    const state = appState([
      ws(1, { name: "quiet" }),
      ws(2, { name: "busy", agentStatus: "running" }),
      ws(3, { name: "waiting", agentStatus: "needsInput" }),
      ws(4, { name: "sibling" }),
    ]);
    const parsed = boardOf(
      parsedEntry(boardEntry(2, { repo: { name: "busy", path: "/r/busy", remote: null } })),
      parsedEntry(boardEntry(3, { repo: { name: "mixed", path: "/r/mixed", remote: null } })),
      parsedEntry(boardEntry(4, { repo: { name: "mixed", path: "/r/mixed", remote: null } })),
    );
    const groups = groupCards(buildCards(state, parsed, glueStatus(), NOW));
    expect(groups.map((group) => group.key)).toEqual(["/r/mixed", "/r/busy", "other"]);
  });

  it("keeps Other after a repo group with the same rank and update time", () => {
    const updatedAt = "2026-09-25T00:00:00Z";
    const parsed = boardOf(
      parsedEntry(boardEntry(1, { updatedAt })),
      parsedEntry(boardEntry(2, { repo: mast, updatedAt })),
    );
    const groups = groupCards(buildCards(appState([ws(1), ws(2)]), parsed, glueStatus(), NOW));
    expect(groups.map((group) => group.key)).toEqual(["/repo/mast", "other"]);
  });

  it("keeps the card order inside a group", () => {
    const parsed = boardOf(
      parsedEntry(boardEntry(1, { repo: mast, updatedAt: "2026-09-25T01:00:00Z" })),
      parsedEntry(boardEntry(2, { repo: mast, updatedAt: "2026-09-25T02:00:00Z" })),
    );
    const cards = buildCards(
      appState([ws(1, { name: "older" }), ws(2, { name: "newer" })]),
      parsed,
      glueStatus(),
      NOW,
    );
    const groups = groupCards(cards);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.cards).toEqual(cards);
    expect(groups[0]?.cards.map((card) => card.workspaceName)).toEqual(["newer", "older"]);
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
    const card = onlyCard(state, boardOf(parsedEntry(boardEntry(1))));
    expect(goToTarget(card, state)).toEqual({ workspace: 1, tab: 4 });
  });

  it("returns the workspace only when there is no needsInput tab", () => {
    const state = appState([ws(1, { panes: { "1": pane(1, [terminalTab(4)]) } })]);
    const card = onlyCard(
      state,
      boardOf(parsedEntry(boardEntry(1, { summary: summary({ needsInput: "answer me" }) }))),
    );
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
