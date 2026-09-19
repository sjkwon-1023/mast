// @vitest-environment happy-dom
//
// 응답 대기 점의 계약을 DOM 으로 잠근다 — 어느 행에 붙는가(그 탭의 agentStatus),
// 언제 사라지는가(그 탭이 needsInput 을 벗어나면), 그리고 탭별 상태 변화가 실제
// 재렌더를 일으키는가. 마지막 항목이 이 파일의 핵심이다: render 는 서명이 같으면
// DOM 을 건드리지 않으므로, `signatureOf` 에 탭 상태가 빠지면 워크스페이스 파생
// 상태가 그대로인 전환(둘 중 하나만 풀림)에서 **옛 탭에 점이 남는다** — 화면은
// 그대로인데 가리키는 대상만 틀린, 순수 로직 테스트로는 안 잡히는 부류다.
//
// 표시할 수 없는 값(모델 문자열)은 전부 textContent 로만 들어간다는 보안 규율도
// 이 페이지의 계약이라(파일 상단), 점이 엘리먼트로 조립되는지 여기서 함께 본다.

import { describe, expect, it } from "vitest";

import { ListView } from "./list-view";
import type {
  AgentStatus,
  NotificationState,
  StateSnapshot,
  Tab,
  TabKind,
  Workspace,
} from "../shared/types";

function terminalTab(
  id: number,
  title: string,
  opts: { agentStatus?: AgentStatus; notification?: NotificationState } = {},
): Tab {
  return {
    id,
    title,
    kind: { type: "terminal", ptySession: null, status: { type: "running" }, cwd: null },
    notification: opts.notification ?? "none",
    lastActivityMs: null,
    agentStatus: opts.agentStatus ?? "idle",
    lastAgentMessage: null,
  };
}

function viewerTab(id: number, title: string, agentStatus: AgentStatus = "idle"): Tab {
  const kind: TabKind = { type: "folderBrowser", path: "/tmp" };
  return {
    id,
    title,
    kind,
    notification: "none",
    lastActivityMs: null,
    agentStatus,
    lastAgentMessage: null,
  };
}

function ws(
  id: number,
  opts: {
    tabs?: Tab[];
    agentStatus?: AgentStatus;
  } = {},
): Workspace {
  const tabs = opts.tabs ?? [terminalTab(id * 10, `tab ${id * 10}`)];
  const pane = { id, tabs, activeTab: tabs[0]?.id ?? null };
  return {
    id,
    name: `ws ${id}`,
    rootPath: null,
    distro: null,
    gitBranch: null,
    gitDirty: null,
    layout: { type: "leaf", pane: id },
    panes: { [String(id)]: pane },
    activePane: id,
    agentStatus: opts.agentStatus ?? "idle",
    lastAgentMessage: null,
  };
}

function snapshot(revision: number, workspaces: Workspace[]): StateSnapshot {
  return { revision, state: { workspaces, activeWorkspace: null, nextId: 100, revision } };
}

function mount(): { view: ListView; opened: { tab: number; title: string }[] } {
  const opened: { tab: number; title: string }[] = [];
  const view = new ListView({
    onOpenTab: (tab, title) => opened.push({ tab, title }),
  });
  return { view, opened };
}

/** 점이 붙은 행들의 제목 (없으면 빈 배열). */
function dottedTitles(view: ListView): (string | null)[] {
  const rows = [...view.root.querySelectorAll<HTMLElement>(".tab")];
  return rows
    .filter((row) => row.querySelector(".tab-needs-input") !== null)
    .map((row) => row.querySelector(".tab-title")?.textContent ?? null);
}

describe("ListView needsInput dot", () => {
  it("기다리는 탭 행에 점이 붙는다", () => {
    const { view } = mount();
    view.render(
      snapshot(1, [
        ws(1, {
          tabs: [terminalTab(10, "first"), terminalTab(11, "second", { agentStatus: "needsInput" })],
        }),
      ]),
    );
    expect(dottedTitles(view)).toEqual(["second"]);
  });

  it("한 워크스페이스에서 둘이 동시에 기다리면 두 행 모두에 점이 붙는다", () => {
    const { view } = mount();
    view.render(
      snapshot(1, [
        ws(1, {
          agentStatus: "needsInput",
          tabs: [
            terminalTab(10, "first", { agentStatus: "needsInput" }),
            terminalTab(11, "second", { agentStatus: "needsInput" }),
          ],
        }),
      ]),
    );
    expect(dottedTitles(view)).toEqual(["first", "second"]);
  });

  it("둘 중 하나만 풀리면 그 행에서만 점이 사라진다 (서명이 탭 상태를 포함한다)", () => {
    const { view } = mount();
    view.render(
      snapshot(1, [
        ws(1, {
          agentStatus: "needsInput",
          tabs: [
            terminalTab(10, "first", { agentStatus: "needsInput" }),
            terminalTab(11, "second", { agentStatus: "needsInput" }),
          ],
        }),
      ]),
    );
    expect(dottedTitles(view)).toEqual(["first", "second"]);

    // 워크스페이스 파생 상태는 second 때문에 여전히 needsInput 이다 — 탭 상태가
    // 서명에 없으면 여기서 재렌더가 일어나지 않아 first 의 점이 그대로 남는다.
    view.render(
      snapshot(2, [
        ws(1, {
          agentStatus: "needsInput",
          tabs: [
            terminalTab(10, "first", { agentStatus: "running" }),
            terminalTab(11, "second", { agentStatus: "needsInput" }),
          ],
        }),
      ]),
    );
    expect(dottedTitles(view)).toEqual(["second"]);
  });

  it("탭이 needsInput 을 벗어나면 점이 없다", () => {
    const { view } = mount();
    view.render(
      snapshot(1, [ws(1, { tabs: [terminalTab(10, "first", { agentStatus: "needsInput" })] })]),
    );
    expect(dottedTitles(view)).toEqual(["first"]);

    view.render(
      snapshot(2, [ws(1, { tabs: [terminalTab(10, "first", { agentStatus: "idle" })] })]),
    );
    expect(dottedTitles(view)).toEqual([]);
  });

  it("워크스페이스 상태가 needsInput 이어도 탭이 아니면 점이 붙지 않는다", () => {
    const { view } = mount();
    view.render(
      snapshot(1, [
        ws(1, {
          agentStatus: "needsInput",
          tabs: [terminalTab(10, "first", { agentStatus: "running" })],
        }),
      ]),
    );
    expect(dottedTitles(view)).toEqual([]);
  });

  it("워크스페이스마다 자기 탭에 점이 붙는다", () => {
    const { view } = mount();
    view.render(
      snapshot(1, [
        ws(1, { tabs: [terminalTab(10, "a", { agentStatus: "needsInput" })] }),
        ws(2, {
          tabs: [terminalTab(20, "x"), terminalTab(21, "b", { agentStatus: "needsInput" })],
        }),
        ws(3, { tabs: [terminalTab(30, "c", { agentStatus: "running" })] }),
      ]),
    );
    expect(dottedTitles(view)).toEqual(["a", "b"]);
  });

  it("뷰어 탭 행에는 점이 붙지 않는다", () => {
    const { view } = mount();
    view.render(
      snapshot(1, [
        ws(1, {
          agentStatus: "needsInput",
          // 코어에서는 나올 수 없는 조합(OSC 는 PTY 세션에서만 온다)이지만,
          // 모델이 흔들려도 점이 클릭 불가 행에 붙지 않는 것을 계약으로 남긴다.
          tabs: [viewerTab(10, "folder", "needsInput")],
        }),
      ]),
    );
    expect(dottedTitles(view)).toEqual([]);
  });

  it("같은 스냅샷 재렌더는 DOM 을 건드리지 않는다 (점 포함)", () => {
    const { view } = mount();
    const state = snapshot(1, [
      ws(1, { tabs: [terminalTab(10, "first", { agentStatus: "needsInput" })] }),
    ]);
    view.render(state);
    const list = view.root.querySelector(".list");
    const before = list?.firstElementChild;

    view.render(state);
    expect(list?.firstElementChild).toBe(before);
  });

  it("탭 행 클릭은 그대로 열기로 이어진다", () => {
    const { view, opened } = mount();
    view.render(
      snapshot(1, [ws(1, { tabs: [terminalTab(10, "first", { agentStatus: "needsInput" })] })]),
    );
    const row = view.root.querySelector<HTMLElement>(".tab");
    row?.click();
    expect(opened).toEqual([{ tab: 10, title: "first" }]);
  });
});

describe("ListView workspace badge", () => {
  it("needsInput 은 이미 워크스페이스 뱃지로도 보인다 (점과 별개 층)", () => {
    const { view } = mount();
    view.render(snapshot(1, [ws(1, { agentStatus: "needsInput" })]));
    const badge = view.root.querySelector(".badge");
    expect(badge?.textContent).toBe("needs input");
    expect(badge?.classList.contains("badge-needsInput")).toBe(true);
  });

  it("통지와 무관하게 뱃지 라벨은 상태를 따른다", () => {
    const { view } = mount();
    view.render(snapshot(1, [ws(1, { agentStatus: "idle" })]));
    expect(view.root.querySelector(".badge")?.textContent).toBe("idle");
  });
});
