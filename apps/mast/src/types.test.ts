// types.ts 수기 미러의 표류 방지 검증 (10단계 계획 0-7) — Rust 쪽 cargo test 와
// 같은 golden fixture(fixtures/stage10-*.json)를 소비해 타입 파싱·narrowing 을
// 잠근다. JSON import 는 리터럴 태그가 string 으로 넓혀져 컴파일 시점 대입 검증이
// 안 되므로, exhaustive switch(+ assertNever)로 (a) 컴파일 시점에는 union 전 variant
// 커버리지를, (b) 런타임에는 fixture 의 실제 태그가 미러 union 에 있는지를 검증한다.

import { describe, expect, it } from "vitest";

import commandsFixtureJson from "../../../fixtures/stage10-commands.json";
import outputsFixtureJson from "../../../fixtures/stage10-outputs.json";
import emptyFixtureJson from "../../../fixtures/stage10-snapshot-empty.json";
import snapshotFixtureJson from "../../../fixtures/stage10-snapshot.json";
import type {
  AgentStatus,
  Command,
  CommandError,
  CommandOutput,
  NewTab,
  SplitTree,
  StateSnapshot,
  TabKind,
  Workspace,
} from "./types";

const snapshotFixture = snapshotFixtureJson as unknown as StateSnapshot;
const emptyFixture = emptyFixtureJson as unknown as StateSnapshot;
const commandsFixture = commandsFixtureJson as unknown as Command[];

/** 미러에 없는 태그가 fixture 에 나타나면 여기로 떨어져 런타임에 잡힌다. */
function assertNever(x: never): never {
  throw new Error(`unexpected variant: ${JSON.stringify(x)}`);
}

function collectLeaves(tree: SplitTree): number[] {
  switch (tree.type) {
    case "leaf":
      return [tree.pane];
    case "split":
      return [...collectLeaves(tree.first), ...collectLeaves(tree.second)];
    default:
      return assertNever(tree);
  }
}

/** TabKind·TerminalStatus 전 variant 를 narrowing 으로 통과시키는 라벨러. */
function tabKindLabel(kind: TabKind): string {
  switch (kind.type) {
    case "terminal": {
      const status = kind.status;
      switch (status.type) {
        case "running":
          return `terminal:running:${String(kind.ptySession)}`;
        case "exited":
          return `terminal:exited:${String(status.code)}`;
        case "notStarted":
          return "terminal:notStarted";
        default:
          return assertNever(status);
      }
    }
    case "folderBrowser":
      return `folderBrowser:${kind.path}`;
    case "textViewer":
      return `textViewer:${kind.scrollTop}`;
    case "markdownViewer":
      return `markdownViewer:${kind.scrollTop}`;
    default:
      return assertNever(kind);
  }
}

/** NewTab 전 variant 를 narrowing 으로 통과시키며 태그를 돌려준다 (21단계 —
 *  청크 D 로 뷰어 3종이 모두 union 에 있다). */
function newTabTag(spec: NewTab): string {
  switch (spec.type) {
    case "terminal":
      expect(spec.cwd === null || typeof spec.cwd === "string").toBe(true);
      return spec.type;
    case "folderBrowser":
      // path 는 nullable — null 이면 워크스페이스 rootPath 상속.
      expect(spec.path === null || typeof spec.path === "string").toBe(true);
      return spec.type;
    case "textViewer":
      expect(typeof spec.path).toBe("string");
      return spec.type;
    case "markdownViewer":
      expect(typeof spec.path).toBe("string");
      return spec.type;
    default:
      return assertNever(spec);
  }
}

/** Command 전 variant 를 narrowing 으로 통과시키며 태그를 돌려준다. */
function commandTag(cmd: Command): string {
  switch (cmd.type) {
    case "createWorkspace":
      expect(typeof cmd.name).toBe("string");
      // tab 은 필드 누락(undefined)·null·NewTab 전부 허용 — 누락은 13단계
      // 이전 클라이언트 하위호환 (계획 13-D1).
      expect(cmd.tab === undefined || cmd.tab === null || newTabTag(cmd.tab) !== "").toBe(
        true,
      );
      return cmd.type;
    case "switchWorkspace":
      expect(typeof cmd.workspace).toBe("number");
      return cmd.type;
    case "closeWorkspace":
      expect(typeof cmd.workspace).toBe("number");
      return cmd.type;
    case "renameWorkspace":
      expect(typeof cmd.workspace).toBe("number");
      expect(cmd.name.trim().length).toBeGreaterThan(0);
      return cmd.type;
    case "focusPane":
      expect(typeof cmd.pane).toBe("number");
      return cmd.type;
    case "splitPane":
      expect(["horizontal", "vertical"]).toContain(cmd.direction);
      // tab 은 nullable — null(빈 pane) 또는 NewTab(원자 탭 동반 분할, D5).
      expect(cmd.tab === null || newTabTag(cmd.tab) !== "").toBe(true);
      return cmd.type;
    case "resizeSplit":
      expect(typeof cmd.split).toBe("number");
      expect(typeof cmd.ratio).toBe("number");
      return cmd.type;
    case "moveWorkspace":
      expect(typeof cmd.workspace).toBe("number");
      // before 는 nullable — null 이 "맨 뒤로" 라는 유효한 값이다 (코어 rustdoc).
      expect(cmd.before === null || typeof cmd.before === "number").toBe(true);
      return cmd.type;
    case "closePane":
      expect(typeof cmd.pane).toBe("number");
      return cmd.type;
    case "createTab":
      expect(newTabTag(cmd.tab)).not.toBe("");
      return cmd.type;
    case "activateTab":
      expect(typeof cmd.tab).toBe("number");
      return cmd.type;
    case "closeTab":
      expect(typeof cmd.tab).toBe("number");
      return cmd.type;
    case "navigateFolder":
      expect(typeof cmd.tab).toBe("number");
      expect(cmd.path.startsWith("/")).toBe(true);
      return cmd.type;
    case "setViewerScroll":
      expect(typeof cmd.tab).toBe("number");
      expect(typeof cmd.scrollTop).toBe("number");
      return cmd.type;
    default:
      return assertNever(cmd);
  }
}

/** CommandOutput 전 variant 라벨러 (outputs fixture 검증용) — error 태그가
 *  outputs 쪽에 섞이면 assertNever 로 떨어진다. */
function outputTag(entry: CommandOutput): string {
  switch (entry.type) {
    case "workspaceCreated":
      expect(typeof entry.workspace).toBe("number");
      expect(typeof entry.pane).toBe("number");
      // tab/session 은 nullable — createWorkspace.tab 이 null 이면 둘 다 null
      // (계획 13-D1).
      expect(entry.tab === null || typeof entry.tab === "number").toBe(true);
      expect(entry.session === null || typeof entry.session === "number").toBe(true);
      return entry.type;
    case "paneCreated":
      expect(typeof entry.pane).toBe("number");
      expect(typeof entry.split).toBe("number");
      // tab/session 은 nullable — splitPane.tab 이 null 이면 둘 다 null (D5).
      expect(entry.tab === null || typeof entry.tab === "number").toBe(true);
      expect(entry.session === null || typeof entry.session === "number").toBe(true);
      return entry.type;
    case "tabCreated":
      expect(typeof entry.tab).toBe("number");
      // session 은 nullable (뷰어 탭은 null — 21단계).
      expect(entry.session === null || typeof entry.session === "number").toBe(true);
      return entry.type;
    case "done":
      return entry.type;
    default:
      return assertNever(entry);
  }
}

/** CommandError 전 variant 라벨러. */
function errorTag(entry: CommandError): string {
  switch (entry.type) {
    case "unknownTarget":
      expect(typeof entry.target).toBe("string");
      return entry.type;
    case "lastPane":
      return entry.type;
    case "spawnFailed":
      expect(typeof entry.message).toBe("string");
      return entry.type;
    case "invalidRatio":
      expect(typeof entry.ratio).toBe("number");
      return entry.type;
    case "kindMismatch":
      expect(typeof entry.tab).toBe("number");
      return entry.type;
    case "invalidPath":
      expect(typeof entry.message).toBe("string");
      return entry.type;
    case "invalidScroll":
      expect(typeof entry.value).toBe("number");
      return entry.type;
    case "invalidName":
      expect(typeof entry.message).toBe("string");
      return entry.type;
    default:
      return assertNever(entry);
  }
}

const AGENT_STATUSES: AgentStatus[] = ["running", "needsInput", "idle"];
const NOTIFICATIONS = ["none", "unread"];

function checkWorkspaceShape(ws: Workspace): void {
  // panes 맵 키는 문자열 숫자 — 키와 pane.id 가 일치해야 한다.
  for (const [key, pane] of Object.entries(ws.panes)) {
    expect(key).toBe(String(pane.id));
    expect(typeof pane.id).toBe("number");
  }
  // layout leaf 집합 == panes 키 집합 (model.rs 불변식의 프론트 쪽 확인).
  const leaves = collectLeaves(ws.layout).map(String).sort();
  expect(leaves).toEqual(Object.keys(ws.panes).sort());
  expect(AGENT_STATUSES).toContain(ws.agentStatus);
  for (const pane of Object.values(ws.panes)) {
    for (const tab of pane.tabs) {
      expect(NOTIFICATIONS).toContain(tab.notification);
      expect(typeof tabKindLabel(tab.kind)).toBe("string");
    }
  }
}

describe("stage10-snapshot.json", () => {
  it("parses top-level snapshot shape", () => {
    expect(snapshotFixture.revision).toBe(6);
    expect(snapshotFixture.state.revision).toBe(6);
    expect(snapshotFixture.state.activeWorkspace).toBe(1);
    expect(snapshotFixture.state.nextId).toBe(15);
    expect(snapshotFixture.state.workspaces).toHaveLength(2);
  });

  it("keeps panes map keys as string numbers and consistent with layout", () => {
    for (const ws of snapshotFixture.state.workspaces) checkWorkspaceShape(ws);
    const ws1 = snapshotFixture.state.workspaces[0];
    expect(Object.keys(ws1.panes)).toEqual(["2", "3", "9"]);
    expect(collectLeaves(ws1.layout)).toEqual([2, 3, 9]);
    // 활성 pane 조회는 String() 경유 (main.ts resolveActive 와 같은 경로).
    expect(ws1.panes[String(ws1.activePane)].id).toBe(2);
  });

  it("carries stable split ids on split nodes (D1)", () => {
    const ws1 = snapshotFixture.state.workspaces[0];
    if (ws1.layout.type !== "split") throw new Error("root must be split");
    expect(ws1.layout.id).toBe(12);
    if (ws1.layout.second.type !== "split") throw new Error("second must be split");
    expect(ws1.layout.second.id).toBe(13);
    expect(ws1.layout.second.ratio).toBe(0.4);
  });

  it("narrows terminal tabs (running/exited) and nullable fields", () => {
    const ws1 = snapshotFixture.state.workspaces[0];
    const tab4 = ws1.panes["2"].tabs[0];
    expect(tabKindLabel(tab4.kind)).toBe("terminal:running:11");
    expect(tab4.lastActivityMs).toBe(1723100000000);
    if (tab4.kind.type !== "terminal") throw new Error("tab4 must be terminal");
    expect(tab4.kind.cwd).toBe("/home/dev/code/mast");

    // exited + code null + cwd null (nullable 계약).
    const tab6 = ws1.panes["3"].tabs[0];
    expect(tabKindLabel(tab6.kind)).toBe("terminal:exited:null");
    if (tab6.kind.type !== "terminal") throw new Error("tab6 must be terminal");
    expect(tab6.kind.ptySession).toBe(12);
    expect(tab6.kind.cwd).toBeNull();
    expect(tab6.lastActivityMs).toBeNull();
  });

  it("narrows viewer tabs (folderBrowser/textViewer/markdownViewer)", () => {
    const ws1 = snapshotFixture.state.workspaces[0];
    const labels = Object.values(ws1.panes)
      .flatMap((p) => p.tabs)
      .map((t) => tabKindLabel(t.kind));
    expect(labels).toContain("markdownViewer:120.5");
    expect(labels).toContain("folderBrowser:/home/dev/code/mast/src");
    expect(labels).toContain("textViewer:0");
    const tab5 = ws1.panes["2"].tabs[1];
    expect(tab5.notification).toBe("unread");

    // 뷰어 탭이 pane 의 activeTab 인 형태 (21단계 — 뷰어 마운트 대상 판정의
    // 입력) + 루트 경로 folderBrowser.
    const ws2 = snapshotFixture.state.workspaces[1];
    const pane11 = ws2.panes["11"];
    expect(pane11.activeTab).toBe(14);
    expect(tabKindLabel(pane11.tabs[0].kind)).toBe("folderBrowser:/");
  });

  it("parses workspace nullable/git fields and empty panes", () => {
    const [ws1, ws2] = snapshotFixture.state.workspaces;
    expect(ws1.gitBranch).toBeNull();
    expect(ws1.gitDirty).toBeNull();
    expect(ws1.distro).toBe("Ubuntu-24.04");
    expect(ws2.rootPath).toBeNull();
    expect(ws2.gitBranch).toBe("main");
    expect(ws2.gitDirty).toBe(true);
    expect(ws2.agentStatus).toBe("needsInput");
    expect(ws2.lastAgentMessage).not.toBeNull();
    // 빈 pane (탭 0개, activeTab null) — SplitPane{tab: null} 등으로 도달한다.
    expect(ws1.panes["9"].tabs).toEqual([]);
    expect(ws1.panes["9"].activeTab).toBeNull();
  });
});

describe("stage10-snapshot-empty.json", () => {
  it("parses the empty state (activeWorkspace null)", () => {
    expect(emptyFixture.revision).toBe(3);
    expect(emptyFixture.state.workspaces).toEqual([]);
    expect(emptyFixture.state.activeWorkspace).toBeNull();
    expect(emptyFixture.state.nextId).toBe(5);
  });
});

describe("stage10-commands.json", () => {
  it("covers every Command variant with internal tag narrowing", () => {
    const tags = commandsFixture.map(commandTag);
    // 뒤쪽 createTab 3개는 뷰어 NewTab 3종을 실은 형태(21단계)이고, 그 뒤
    // createWorkspace 는 tab 필드 누락 하위호환 형태다 (계획 13-D1). 새 variant
    // 는 **뒤에 덧붙인다** — 앞에 끼우면 아래 인덱스 단언이 전부 밀린다.
    expect(tags).toEqual([
      "createWorkspace",
      "switchWorkspace",
      "closeWorkspace",
      "focusPane",
      "splitPane",
      "resizeSplit",
      "closePane",
      "createTab",
      "activateTab",
      "closeTab",
      "navigateFolder",
      "setViewerScroll",
      "createTab",
      "createTab",
      "createTab",
      "createWorkspace",
      "renameWorkspace",
      "moveWorkspace",
      "moveWorkspace",
    ]);
  });

  it("narrows nested command payloads", () => {
    const create = commandsFixture[0];
    if (create.type !== "createWorkspace") throw new Error("first must be createWorkspace");
    expect(create.rootPath).toBe("/home/dev/code/mast");
    expect(create.distro).toBe("Ubuntu-24.04");
    // 원자 탭 동반 생성 형태 (계획 13-D1).
    expect(create.tab).toEqual({ type: "terminal", cwd: null });

    // 16번째 엔트리는 tab 필드 누락 하위호환 잠금 — 파싱 시 undefined.
    const legacy = commandsFixture[15];
    if (legacy.type !== "createWorkspace") throw new Error("16th must be createWorkspace");
    expect(legacy.tab).toBeUndefined();

    // 재배치의 두 형태 — 이웃 앞으로, 그리고 맨 뒤로(before = null). null 이
    // 누락(undefined)으로 새면 "맨 뒤"가 조용히 사라지므로 둘 다 잠근다.
    const before = commandsFixture[17];
    if (before.type !== "moveWorkspace") throw new Error("18th must be moveWorkspace");
    expect(before.before).toBe(2);
    const toEnd = commandsFixture[18];
    if (toEnd.type !== "moveWorkspace") throw new Error("19th must be moveWorkspace");
    expect(toEnd.before).toBeNull();

    // 이름 변경 (F2 사이드바 인라인 편집) — workspace + name 두 필드뿐이다.
    const rename = commandsFixture[16];
    if (rename.type !== "renameWorkspace") throw new Error("17th must be renameWorkspace");
    expect(rename.workspace).toBe(1);
    expect(rename.name).toBe("mast (renamed)");

    const split = commandsFixture[4];
    if (split.type !== "splitPane") throw new Error("fifth must be splitPane");
    expect(split.direction).toBe("vertical");
    // 원자 탭 동반 분할 형태 (D5).
    expect(split.tab).toEqual({ type: "terminal", cwd: null });

    const resize = commandsFixture[5];
    if (resize.type !== "resizeSplit") throw new Error("sixth must be resizeSplit");
    expect(resize.split).toBe(12);
    expect(resize.ratio).toBe(0.35);

    const createTab = commandsFixture[7];
    if (createTab.type !== "createTab") throw new Error("eighth must be createTab");
    expect(createTab.tab).toEqual({ type: "terminal", cwd: null });

    // 뷰어 명령·뷰어 NewTab 잠금 (21단계).
    const navigate = commandsFixture[10];
    if (navigate.type !== "navigateFolder") throw new Error("11th must be navigateFolder");
    expect(navigate.tab).toBe(7);
    expect(navigate.path).toBe("/home/dev/code/mast/src");

    const scroll = commandsFixture[11];
    if (scroll.type !== "setViewerScroll") throw new Error("12th must be setViewerScroll");
    expect(scroll.tab).toBe(8);
    expect(scroll.scrollTop).toBe(4096);

    const folderTab = commandsFixture[12];
    if (folderTab.type !== "createTab") throw new Error("13th must be createTab");
    // folderBrowser 의 path 는 nullable (null = 워크스페이스 rootPath 상속).
    expect(folderTab.tab).toEqual({ type: "folderBrowser", path: null });

    const textTab = commandsFixture[13];
    if (textTab.type !== "createTab") throw new Error("14th must be createTab");
    expect(textTab.tab).toEqual({
      type: "textViewer",
      path: "/home/dev/code/mast/notes.txt",
    });

    // markdownViewer NewTab (21단계 청크 D) — textViewer 와 같은 형태(path 필수).
    const markdownTab = commandsFixture[14];
    if (markdownTab.type !== "createTab") throw new Error("15th must be createTab");
    expect(markdownTab.tab).toEqual({
      type: "markdownViewer",
      path: "/home/dev/code/mast/README.md",
    });
  });
});

// stage10-outputs.json — 통합 완료로 fixture 가 착지했으므로 정적 import 로
// 무조건 검증한다 (병렬 작업 중 쓰던 존재-조건부 glob 은 fixture 소실을 조용히
// skip 으로 가릴 수 있어 제거 — cargo test 쪽 round-trip 과 대칭).
describe("stage10-outputs.json", () => {
  it("covers every CommandOutput and CommandError variant", () => {
    const fixture = outputsFixtureJson as unknown as {
      outputs: CommandOutput[];
      errors: CommandError[];
    };
    expect(Array.isArray(fixture.outputs)).toBe(true);
    expect(Array.isArray(fixture.errors)).toBe(true);
    // 각 union 의 전 variant 가 1회씩 — 태그 커버리지를 잠근다 (값 세부는
    // 글루 소유 fixture 라 태그·필드 타입 수준까지만 고정). 뒤쪽 생성 3종은
    // 뷰어 탭 형태(session null — 21단계)의 재등장이다.
    expect(fixture.outputs.map(outputTag)).toEqual([
      "workspaceCreated",
      "paneCreated",
      "tabCreated",
      "done",
      "workspaceCreated",
      "paneCreated",
      "tabCreated",
    ]);
    // 뷰어 탭 생성 결과는 tab 만 non-null 이고 session 은 null 이다.
    for (const entry of fixture.outputs.slice(4)) {
      if (entry.type === "done") throw new Error("viewer outputs must create ids");
      expect(entry.tab).not.toBeNull();
      expect(entry.session).toBeNull();
    }
    expect(fixture.errors.map(errorTag)).toEqual([
      "unknownTarget",
      "lastPane",
      "spawnFailed",
      "invalidRatio",
      "kindMismatch",
      "invalidPath",
      "invalidScroll",
      "invalidName",
    ]);
  });
});
