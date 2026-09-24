// @vitest-environment happy-dom
//
// 탭바 DOM identity 검증 (18단계 B-7) — 순수 판정(tabStripPlan) 테스트가 못 잡는
// 부분을 잠근다: 판정이 patch 여도 렌더가 실제로 탭 버튼을 갈아치우면 클릭이
// mousedown~click 사이에 유실된다 (ADR-0003 결정 7 의 스왈로). 그래서 "같은 노드
// 객체(===)에 제목·dot 만 갱신됐는가"를 실제 DOM 으로 단언한다. pane 층 배지의
// on/off 와, mousedown(FocusPane·send-mode) → click(ActivateTab) 순서도 함께 건다.
//
// 21단계에서 뷰어 seam 이 붙는다: placeholder 는 터미널도 뷰어도 없을 때만 뜬다는
// 상호 배타 규칙과, 헤더 폴더 버튼의 CreateTab 명세를 여기서 잠근다.
//
// happy-dom 은 이 파일 전용 환경이다 (상단 @vitest-environment) — 나머지 프론트
// 테스트는 계속 DOM 없는 node 환경에서 돈다.

import { afterEach, describe, expect, it } from "vitest";

import { PaneView, exitedNoticeText } from "./pane-view";
import type { SendController, ViewRegistry, ViewerRegistry } from "./pane-view";
import { applyTabIdSettings } from "./tab-id-settings";
import type { VisibleViewer } from "./view-reconcile";
import type { ViewerKind, ViewerView } from "../viewers/viewer-view";
import { shortcutBadge } from "../../shared/keys";
import type { UiSettings } from "../../infrastructure/backend";
import type {
  AgentStatus,
  Command,
  NotificationState,
  Pane,
  PaneId,
  Tab,
  TerminalStatus,
} from "../../shared/types";

/** 설정 이펙트가 파일 밖으로 새지 않게 하는 최소 UiSettings — ID 표시 기본값은 true. */
function idSettings(showTabIds: boolean | null): UiSettings {
  return {
    fontFamily: null,
    fontSize: null,
    highlightLanguages: null,
    log: null,
    remote: null,
    showTabIds,
    macOptionIsMeta: null,
  };
}

function terminalTab(
  id: number,
  opts: {
    title?: string;
    status?: TerminalStatus;
    notification?: NotificationState;
    cwd?: string;
    agentStatus?: AgentStatus;
  } = {},
): Tab {
  return {
    id,
    title: opts.title ?? `tab ${id}`,
    kind: {
      type: "terminal",
      ptySession: id * 100,
      status: opts.status ?? { type: "running" },
      cwd: opts.cwd ?? null,
    },
    notification: opts.notification ?? "none",
    lastActivityMs: null,
    agentStatus: opts.agentStatus ?? "idle",
    lastAgentMessage: null,
  };
}

function folderTab(id: number, path = "/home/u"): Tab {
  return {
    id,
    title: `folder ${id}`,
    kind: { type: "folderBrowser", path },
    notification: "none",
    lastActivityMs: null,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
}

function pane(tabs: Tab[], activeTab: number | null): Pane {
  return { id: 1, tabs, activeTab };
}

/** 최소 ViewerView 스텁 — 마운트 사실과 update 로 흘러온 kind 만 기록한다. */
class FakeViewerView implements ViewerView {
  readonly root: HTMLDivElement;
  readonly kinds: ViewerKind[] = [];
  disposed = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "fake-viewer";
    parent.appendChild(this.root);
  }

  update(kind: ViewerKind): void {
    this.kinds.push(kind);
  }
  flushScroll(): void {}
  focus(): void {}
  dispose(): void {
    this.disposed = true;
    this.root.remove();
  }
}

/** 탭 안의 자식 조회 — 없으면 던진다 (테스트에서 null 분기를 없애기 위함). */
function child(el: Element, selector: string): HTMLElement {
  const found = el.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

interface Harness {
  view: PaneView;
  tabs: () => HTMLElement[];
  badge: () => HTMLElement;
  placeholder: () => HTMLElement;
  headerButton: (title: string) => HTMLButtonElement;
  dispatched: Command[];
  send: { active: boolean; resolved: PaneId[] };
  viewers: Map<number, FakeViewerView>;
  /** ensure 가 null 을 주는 탭 — 아직 구현이 없는 뷰어 종류를 흉내낸다. */
  unmountable: Set<number>;
}

function mount(paneId = 1): Harness {
  const dispatched: Command[] = [];
  const send = { active: false, resolved: [] as PaneId[] };
  const viewers = new Map<number, FakeViewerView>();
  const unmountable = new Set<number>();
  // 터미널 뷰 레지스트리는 쓰지 않는다 — 이 테스트들은 visible=null 로만
  // 렌더하므로 ensure 가 불리면 그 자체가 결함이다.
  const views: ViewRegistry = {
    get: () => undefined,
    ensure: () => {
      throw new Error("ensure should not be called");
    },
  };
  const viewerRegistry: ViewerRegistry = {
    get: (tab) => viewers.get(tab),
    ensure: (target: VisibleViewer, parent) => {
      if (unmountable.has(target.tab)) return null;
      const existing = viewers.get(target.tab);
      if (existing !== undefined) return existing;
      const created = new FakeViewerView(parent);
      viewers.set(target.tab, created);
      return created;
    },
  };
  // send-mode 스텁 — arm 진입점은 UI 에서 빠졌지만(⤷/⤷⏎ 버튼 제거) resolve
  // 분기는 살아 있어 프로그램적으로 활성화해 잠근다 (pane-view 상단 휴면 주석).
  const controller: SendController = {
    isActive: () => send.active,
    arm: () => {},
    resolve: (target) => send.resolved.push(target),
    flashError: () => {},
  };
  const view = new PaneView(
    paneId,
    async (cmd) => {
      dispatched.push(cmd);
      return null;
    },
    views,
    viewerRegistry,
    controller,
  );
  document.body.replaceChildren(view.root);
  return {
    view,
    tabs: () => Array.from(view.root.querySelectorAll<HTMLElement>(".pane-tabs .tab")),
    badge: () => child(view.root, ".pane-dot"),
    placeholder: () => child(view.root, ".pane-placeholder"),
    headerButton: (title) => {
      // 접두사 매칭 — 툴팁 뒤에 단축키 표기 "(Ctrl+Shift+…)"가 붙으므로 기능
      // 설명 부분으로만 찾는다 (테스트가 단축키 문자열을 하드코딩하지 않게).
      const found = view.root.querySelector<HTMLButtonElement>(
        `.pane-header button[title^="${title}"]`,
      );
      if (found === null) throw new Error(`missing header button ${title}`);
      return found;
    },
    dispatched,
    send,
    viewers,
    unmountable,
  };
}

/** planViewerSync 가 내려주는 마운트 항목 형태. */
function viewerMount(tab: number, path = "/home/u"): VisibleViewer {
  return { pane: 1, tab, kind: { type: "folderBrowser", path } };
}

const THREE = [terminalTab(10), terminalTab(11), terminalTab(12)];

describe("PaneView tab strip rendering", () => {
  it("patches a changed title in place, keeping the same tab nodes", () => {
    const { view, tabs } = mount();
    view.update(pane(THREE, 10), true, null, null);
    const before = tabs();
    expect(before).toHaveLength(3);
    // 안 바뀌는 탭의 제목 텍스트 노드 — setText 가드가 이 노드를 살려두는지 본다.
    const untouched = child(before[0], ".tab-title").firstChild;

    view.update(
      pane([terminalTab(10), terminalTab(11, { title: "claude — mast" }), terminalTab(12)], 10),
      true,
      null,
      null,
    );

    const after = tabs();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(child(after[1], ".tab-title").textContent).toBe("claude — mast");
    expect(after[1].title).toBe("claude — mast");
    expect(child(after[0], ".tab-title").firstChild).toBe(untouched);
  });

  it("toggles the unread dot and the exited badge without rebuilding", () => {
    const { view, tabs } = mount();
    view.update(pane(THREE, 10), true, null, null);
    const before = tabs();
    expect(child(before[1], ".tab-dot").hidden).toBe(true);
    expect(child(before[1], ".tab-exited").hidden).toBe(true);

    view.update(
      pane(
        [
          terminalTab(10),
          terminalTab(11, { notification: "unread", status: { type: "exited", code: 1, endedAtMs: 1723100500000 } }),
          terminalTab(12),
        ],
        10,
      ),
      true,
      null,
      null,
    );

    const after = tabs();
    expect(after[1]).toBe(before[1]);
    expect(child(after[1], ".tab-dot").hidden).toBe(false);
    expect(child(after[1], ".tab-exited").hidden).toBe(false);
    expect(after[1].classList.contains("exited")).toBe(true);
  });

  it("toggles the needsInput badge in place, independently of the unread dot", () => {
    const { view, tabs, dispatched } = mount();
    view.update(pane(THREE, 10), true, null, null);
    const before = tabs();
    const badge = child(before[1], ".tab-needs-input");
    expect(badge.hidden).toBe(true);
    expect(badge.textContent).toBe("!");
    expect(badge.title).toBe("Needs input");

    view.update(
      pane([terminalTab(10), terminalTab(11, { agentStatus: "needsInput" }), terminalTab(12)], 10),
      true,
      null,
      null,
    );
    const needing = tabs();
    expect(needing[1]).toBe(before[1]);
    expect(child(needing[1], ".tab-needs-input")).toBe(badge);
    expect(badge.hidden).toBe(false);
    expect(child(needing[1], ".tab-dot").hidden).toBe(true);

    // 두 배지는 한 탭에 함께 뜰 수 있고 서로를 끄지 않는다.
    view.update(
      pane(
        [
          terminalTab(10),
          terminalTab(11, { agentStatus: "needsInput", notification: "unread" }),
          terminalTab(12),
        ],
        10,
      ),
      true,
      null,
      null,
    );
    expect(badge.hidden).toBe(false);
    expect(child(tabs()[1], ".tab-dot").hidden).toBe(false);

    view.update(
      pane([terminalTab(10), terminalTab(11, { notification: "unread" }), terminalTab(12)], 10),
      true,
      null,
      null,
    );
    expect(tabs()[1]).toBe(before[1]);
    expect(badge.hidden).toBe(true);
    expect(child(tabs()[1], ".tab-dot").hidden).toBe(false);

    // 패치된 노드의 클릭 배선이 그대로다.
    tabs()[1].click();
    expect(dispatched).toEqual([{ type: "activateTab", tab: 11 }]);
  });

  it("moves the active class without rebuilding the tabs", () => {
    const { view, tabs } = mount();
    view.update(pane(THREE, 10), true, null, null);
    const before = tabs();
    expect(before.map((t) => t.classList.contains("active"))).toEqual([true, false, false]);

    view.update(pane(THREE, 11), true, null, null);

    const after = tabs();
    expect(after[1]).toBe(before[1]);
    expect(after.map((t) => t.classList.contains("active"))).toEqual([false, true, false]);
  });

  it("touches nothing when the tab model is unchanged", () => {
    const { view, tabs } = mount();
    view.update(pane(THREE, 10), true, null, null);
    const before = tabs();
    const titleNode = child(before[0], ".tab-title").firstChild;

    // 무관 스냅샷(예: 다른 pane 의 FocusPane) — skip 판정이라 DOM 무접촉.
    view.update(pane(THREE, 10), false, null, null);

    const after = tabs();
    expect(after[0]).toBe(before[0]);
    expect(child(after[0], ".tab-title").firstChild).toBe(titleNode);
  });

  it("rebuilds when a tab is added or removed", () => {
    const { view, tabs } = mount();
    view.update(pane(THREE, 10), true, null, null);
    const before = tabs();

    view.update(pane([...THREE, terminalTab(13)], 10), true, null, null);
    const grown = tabs();
    expect(grown).toHaveLength(4);
    expect(grown[0]).not.toBe(before[0]);

    view.update(pane([terminalTab(10), terminalTab(12)], 10), true, null, null);
    const shrunk = tabs();
    expect(shrunk).toHaveLength(2);
    expect(shrunk.map((t) => child(t, ".tab-title").textContent)).toEqual(["tab 10", "tab 12"]);
    expect(shrunk[0]).not.toBe(grown[0]);
  });
});

// 탭 ID 배지 — 각 탭의 안정 Tab.id 를 제목 옆에 보여 준다 (`mast ls` 의 TAB 열과
// `mast send '#<id>'` 가 받는 주소). 설정이 끄면 통째로 걷히고, 제목 패치·재조립·
// 재정렬을 지나도 ID 는 자기 탭에 붙어 있어야 한다 (노드 키가 곧 ID 라 어긋나면
// 곧바로 드러난다).
describe("PaneView tab id badges", () => {
  // 모듈 상태는 파일 밖으로도 남는다 — 각 테스트 뒤 기본값(표시)으로 되돌린다.
  afterEach(() => applyTabIdSettings(idSettings(null)));

  it("shows the stable id on every tab, active or not", () => {
    applyTabIdSettings(idSettings(true));
    const { view, tabs } = mount();
    view.update(pane(THREE, 11), true, null, null);

    const after = tabs();
    expect(after.map((t) => child(t, ".tab-id").textContent)).toEqual(["#10", "#11", "#12"]);
    for (const tab of after) expect(child(tab, ".tab-id").hidden).toBe(false);
    expect(child(after[1], ".tab-id").title).toBe("Tab #11");
  });

  it("keeps each id on its own tab across a title patch and strip rebuilds", () => {
    const { view, tabs } = mount();
    view.update(pane(THREE, 10), true, null, null);
    const before = tabs();
    const idNode = child(before[1], ".tab-id").firstChild;

    // 제목 패치 — 노드는 그대로, ID 도 그대로 (제목 변경이 ID 를 흔들지 않는다).
    view.update(
      pane([terminalTab(10), terminalTab(11, { title: "claude — mast" }), terminalTab(12)], 10),
      true,
      null,
      null,
    );
    expect(tabs()[1]).toBe(before[1]);
    expect(child(tabs()[1], ".tab-id").firstChild).toBe(idNode);
    expect(child(tabs()[1], ".tab-id").textContent).toBe("#11");

    // 탭 제거(재조립) — 남은 탭이 각자의 ID 를 단다 (새 노드가 옛 ID 를 물려받지 않는다).
    view.update(pane([terminalTab(10), terminalTab(12)], 10), true, null, null);
    expect(tabs().map((t) => child(t, ".tab-id").textContent)).toEqual(["#10", "#12"]);

    // 재정렬(rebuild 경로) — ID 는 위치가 아니라 탭을 따라간다.
    view.update(pane([terminalTab(12), terminalTab(10)], 12), true, null, null);
    expect(tabs().map((t) => child(t, ".tab-id").textContent)).toEqual(["#12", "#10"]);
  });

  // 병합 접점 고정: needsInput 배지(#37)와 탭 ID 배지(#40)는 같은 탭 버튼 안에서 각자
  // 노드를 갖고, 한쪽 상태 변화가 in-place 패치와 재조립을 지나도 다른 쪽을 잃지 않는다.
  it("keeps the needsInput badge and the id badge together through a patch and a rebuild", () => {
    const { view, tabs } = mount();
    view.update(pane([terminalTab(10), terminalTab(11)], 10), true, null, null);
    const before = tabs();
    const idNode = child(before[1], ".tab-id");
    const needsInputNode = child(before[1], ".tab-needs-input");

    // 상태 패치 — 두 노드가 그대로 남고 각자만 갱신된다.
    view.update(
      pane([terminalTab(10), terminalTab(11, { agentStatus: "needsInput" })], 10),
      true,
      null,
      null,
    );
    const patched = tabs();
    expect(patched[1]).toBe(before[1]);
    expect(child(patched[1], ".tab-id")).toBe(idNode);
    expect(child(patched[1], ".tab-needs-input")).toBe(needsInputNode);
    expect(idNode.textContent).toBe("#11");
    expect(needsInputNode.hidden).toBe(false);

    // 동일 모델(skip) — DOM 무접촉이라 두 배지 노드가 그대로 남는다.
    view.update(
      pane([terminalTab(10), terminalTab(11, { agentStatus: "needsInput" })], 10),
      true,
      null,
      null,
    );
    expect(tabs()[1]).toBe(before[1]);
    expect(child(tabs()[1], ".tab-id")).toBe(idNode);
    expect(child(tabs()[1], ".tab-needs-input")).toBe(needsInputNode);

    // 재정렬(rebuild) — 새 노드에도 두 배지가 함께 실린다.
    view.update(
      pane([terminalTab(11, { agentStatus: "needsInput" }), terminalTab(10)], 11),
      true,
      null,
      null,
    );
    const rebuilt = tabs();
    expect(rebuilt.map((t) => child(t, ".tab-id").textContent)).toEqual(["#11", "#10"]);
    expect(child(rebuilt[0], ".tab-needs-input").hidden).toBe(false);
    expect(child(rebuilt[1], ".tab-needs-input").hidden).toBe(true);
  });

  it("hides the ids in place when showTabIds is false", () => {
    applyTabIdSettings(idSettings(false));
    const { view, tabs } = mount();
    view.update(pane(THREE, 10), true, null, null);

    // 자리를 차지하지 않도록 hidden 으로 걷는다 (자식이 들락날락하지는 않는다).
    expect(tabs()).toHaveLength(3);
    for (const tab of tabs()) {
      expect(child(tab, ".tab-id").hidden).toBe(true);
      expect(child(tab, ".tab-id").textContent).toBe("");
    }
  });
});

describe("PaneView unread badge", () => {
  it("stays hidden while no tab has an unread notification", () => {
    const { view, badge } = mount();
    view.update(pane(THREE, 10), true, null, null);
    expect(badge().hidden).toBe(true);
  });

  it("shows for an unread hidden tab and clears when the tab is read", () => {
    const { view, tabs, badge } = mount();
    view.update(pane(THREE, 10), true, null, null);
    const before = tabs();

    // 표시 중이 아닌 탭(12)의 알림 — pane 층 배지가 이걸 표면화한다.
    view.update(
      pane([terminalTab(10), terminalTab(11), terminalTab(12, { notification: "unread" })], 10),
      true,
      null,
      null,
    );
    expect(badge().hidden).toBe(false);
    // 배지 갱신이 탭 노드를 갈아치우지 않는다.
    expect(tabs()[0]).toBe(before[0]);

    view.update(pane(THREE, 10), true, null, null);
    expect(badge().hidden).toBe(true);
  });

  it("shows with the needs-input class for a tab that needs input, even without unread", () => {
    const { view, tabs, badge } = mount();
    view.update(pane(THREE, 10), true, null, null);
    const before = tabs();

    view.update(
      pane([terminalTab(10), terminalTab(11), terminalTab(12, { agentStatus: "needsInput" })], 10),
      true,
      null,
      null,
    );
    expect(badge().hidden).toBe(false);
    expect(badge().classList.contains("needs-input")).toBe(true);
    expect(tabs()[0]).toBe(before[0]);

    view.update(
      pane([terminalTab(10), terminalTab(11), terminalTab(12, { notification: "unread" })], 10),
      true,
      null,
      null,
    );
    expect(badge().hidden).toBe(false);
    expect(badge().classList.contains("needs-input")).toBe(false);

    view.update(pane(THREE, 10), true, null, null);
    expect(badge().hidden).toBe(true);
    expect(badge().classList.contains("needs-input")).toBe(false);
  });

  it("survives a strip rebuild", () => {
    const { view, badge } = mount();
    view.update(pane(THREE, 10), true, null, null);
    view.update(
      pane([...THREE, terminalTab(13, { notification: "unread" })], 10),
      true,
      null,
      null,
    );
    expect(badge().hidden).toBe(false);
  });
});

describe("PaneView tab interaction across patches", () => {
  it("keeps the activate and close wiring on patched tabs", () => {
    const { view, tabs, dispatched } = mount();
    view.update(pane(THREE, 10), true, null, null);
    view.update(
      pane([terminalTab(10), terminalTab(11, { title: "renamed" }), terminalTab(12)], 10),
      true,
      null,
      null,
    );

    tabs()[1].click();
    expect(dispatched).toEqual([{ type: "activateTab", tab: 11 }]);

    child(tabs()[2], ".tab-close").click();
    expect(dispatched).toEqual([
      { type: "activateTab", tab: 11 },
      { type: "closeTab", tab: 12 },
    ]);
  });

  it("re-reads active from the patched model instead of a stale closure", () => {
    const { view, tabs, dispatched } = mount();
    view.update(pane(THREE, 10), true, null, null);
    // 탭 11 이 활성이 된 뒤의 클릭은 no-op 이어야 한다 (무변경 revision 잡음 방지).
    view.update(pane(THREE, 11), true, null, null);

    tabs()[1].click();
    expect(dispatched).toEqual([]);

    // 반대로 비활성이 된 탭 10 은 다시 활성화를 보낸다.
    tabs()[0].click();
    expect(dispatched).toEqual([{ type: "activateTab", tab: 10 }]);
  });

  it("keeps the mousedown FocusPane ahead of the tab click", () => {
    const { view, tabs, dispatched } = mount(3);
    view.update(pane(THREE, 10), false, null, null); // 비활성 pane

    const tab = tabs()[1];
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    tab.click();

    expect(dispatched).toEqual([
      { type: "focusPane", pane: 3 },
      { type: "activateTab", tab: 11 },
    ]);
  });

  // send-mode 는 arm 진입점(⤷/⤷⏎ 버튼)이 UI 에서 빠져 휴면이지만, 경로 자체는
  // 그대로 살아 있다 — 버튼에 의존하지 않고 컨트롤러를 프로그램적으로 활성화해
  // mousedown 분기를 잠근다 (재배선 시 이 계약이 그대로 쓰인다).
  it("resolves the send target instead of focusing while send-mode is armed", () => {
    const { view, tabs, dispatched, send } = mount(3);
    view.update(pane(THREE, 10), false, null, null);
    send.active = true;

    tabs()[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));

    expect(send.resolved).toEqual([3]);
    expect(dispatched).toEqual([]);
  });
});

describe("PaneView viewer seam (21단계)", () => {
  it("mounts the viewer and hides the placeholder (no simultaneous display)", () => {
    const { view, placeholder, viewers } = mount();
    view.update(pane([folderTab(10)], 10), true, null, viewerMount(10));

    expect(viewers.get(10)?.root.isConnected).toBe(true);
    expect(placeholder().style.display).toBe("none");
    expect(view.shownTab).toBe(10);
  });

  it("pushes the current kind on every render so navigation reaches the view", () => {
    const { view, viewers } = mount();
    view.update(pane([folderTab(10)], 10), true, null, viewerMount(10));
    view.update(pane([folderTab(10, "/etc")], 10), true, null, viewerMount(10, "/etc"));

    expect(viewers.get(10)?.kinds).toEqual([
      { type: "folderBrowser", path: "/home/u" },
      { type: "folderBrowser", path: "/etc" },
    ]);
  });

  it("falls back to the placeholder when no viewer could be mounted", () => {
    const { view, placeholder, unmountable } = mount();
    // 아직 구현이 없는 뷰어 종류(청크 C2·D) — ensure 가 null 을 준다.
    unmountable.add(10);
    view.update(pane([folderTab(10)], 10), true, null, viewerMount(10));

    expect(view.shownTab).toBeNull();
    expect(placeholder().style.display).not.toBe("none");
    expect(placeholder().textContent).toContain("/home/u");
  });

  it("shows the placeholder only when there is neither a terminal nor a viewer", () => {
    const { view, placeholder } = mount();
    view.update(pane([terminalTab(10)], 10), true, null, null);
    expect(placeholder().style.display).not.toBe("none");
    expect(view.shownTab).toBeNull();
  });

  it("dispatches CreateTab{folderBrowser, path: null} from the header SVG folder button", () => {
    const { view, headerButton, dispatched } = mount(4);
    view.update(pane(THREE, 10), true, null, null);

    headerButton("New folder browser tab").click();

    expect(dispatched).toEqual([
      { type: "createTab", pane: 4, tab: { type: "folderBrowser", path: null } },
    ]);
  });

  it("opens the Changes viewer at the workspace root, not the pane shell cwd", () => {
    const { view, headerButton, dispatched } = mount(4);
    view.update(
      pane([terminalTab(10, { cwd: "/home/u/nested" })], 10),
      true,
      null,
      null,
    );

    headerButton("New changes viewer tab").click();

    expect(dispatched).toEqual([
      { type: "createTab", pane: 4, tab: { type: "changesViewer", path: null } },
    ]);
  });
});

describe("PaneView header buttons", () => {
  /** 헤더 **직속** 버튼만 (탭 × 는 .pane-tabs 안이라 제외). */
  function headerButtons(view: PaneView): HTMLButtonElement[] {
    const header = child(view.root, ".pane-header");
    return Array.from(header.children).filter(
      (el): el is HTMLButtonElement => el.tagName === "BUTTON",
    );
  }

  it("has the six working buttons — the send pair is retired", () => {
    const { view } = mount();
    view.update(pane(THREE, 10), true, null, null);

    const titles = headerButtons(view).map((b) => b.title);
    expect(titles).toHaveLength(6);
    expect(titles.filter((t) => t.toLowerCase().includes("send"))).toEqual([]);
    // 툴팁의 기능 설명 부분만 본다 — 뒤에 붙는 단축키 표기는 shared/keys.ts 소유.
    expect(titles.map((t) => t.replace(/ \(.*\)$/, ""))).toEqual([
      "New terminal tab",
      "New folder browser tab",
      "New changes viewer tab",
      "New browser tab",
      "Split left/right",
      "Split top/bottom",
    ]);
  });

  it("draws the folder and split icons as inline SVG on one shared 16px grid", () => {
    const { view } = mount();
    view.update(pane(THREE, 10), true, null, null);

    const [plus, ...icons] = headerButtons(view).filter(b => b.title !== "New browser tab");
    // + 는 텍스트 라벨 그대로다 (판단: 기호가 이미 자명하다).
    expect(plus.textContent).toBe("+");
    expect(icons).toHaveLength(4);
    for (const btn of icons) {
      const svg = btn.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16");
      expect(svg?.getAttribute("stroke-width")).toBe("1.5");
      expect(svg?.getAttribute("stroke")).toBe("currentColor");
    }
    // 분할 페어는 같은 사각형에 이등분선 방향만 다르다 — 마크업이 실제로 갈리는지.
    const [, , leftRight, topBottom] = icons;
    expect(leftRight.innerHTML).not.toBe(topBottom.innerHTML);
    expect(leftRight.querySelector("path")?.getAttribute("d")).toContain("v10.5");
    expect(topBottom.querySelector("path")?.getAttribute("d")).toContain("h10.5");
  });

  // Alt 배지 — 문자 명령은 실제 판정이 Alt+Shift 라 배지에도 Shift 표시가 붙어야
  // 안내와 키 동작이 어긋나지 않는다 (shortcutBadge). 단축키가 없는 분할 버튼은
  // 배지도 없다 (제거된 Ctrl+Shift+E 를 되살리지 않는다).
  it("badges letter shortcuts with the Shift marker and leaves the split buttons bare", () => {
    const { view, tabs, headerButton } = mount();
    view.update(pane(THREE, 10), true, null, null);

    expect(headerButton("New terminal tab").dataset.altShortcut).toBe(
      shortcutBadge("newTerminalTab"),
    );
    expect(headerButton("New folder browser tab").dataset.altShortcut).toBe(
      shortcutBadge("newFolderTab"),
    );
    expect(child(tabs()[0], ".tab-close").dataset.altShortcut).toBe(shortcutBadge("closeTab"));
    expect(headerButton("Split left/right").dataset.altShortcut).toBeUndefined();
    expect(headerButton("Split top/bottom").dataset.altShortcut).toBeUndefined();
  });

  // 새 셸은 이 pane 의 셸이 있는 곳에서 — 세 버튼 모두 표시 탭의 cwd 를 넘긴다.
  it("opens a new terminal tab and both splits where the shown terminal's shell is", () => {
    const { view, headerButton, dispatched } = mount(4);
    view.update(pane([terminalTab(10, { cwd: "/home/u/proj" })], 10), true, null, null);

    headerButton("New terminal tab").click();
    headerButton("Split left/right").click();
    headerButton("Split top/bottom").click();

    const tab = { type: "terminal", cwd: "/home/u/proj" } as const;
    expect(dispatched).toEqual([
      { type: "createTab", pane: 4, tab },
      { type: "splitPane", pane: 4, direction: "horizontal", tab },
      { type: "splitPane", pane: 4, direction: "vertical", tab },
    ]);
  });

  // 브라우저 탭을 보고 있어도 분할은 키보드 분할과 같이 새 터미널을 연다.
  it("splits a pane showing a browser tab into a new terminal, not another browser", () => {
    const { view, headerButton, dispatched } = mount(4);
    const browser: Tab = {
      id: 20,
      title: "Browser",
      kind: { type: "browser", url: "http://localhost:3000" },
      notification: "none",
      lastActivityMs: null,
      agentStatus: "idle",
      lastAgentMessage: null,
    };
    view.update(pane([browser], 20), true, null, null);

    headerButton("Split left/right").click();
    headerButton("Split top/bottom").click();

    const tab = { type: "terminal", cwd: null } as const;
    expect(dispatched).toEqual([
      { type: "splitPane", pane: 4, direction: "horizontal", tab },
      { type: "splitPane", pane: 4, direction: "vertical", tab },
    ]);
  });

  it("reads the cwd at click time, and sends null when a viewer is shown or the tab has no cwd recorded", () => {
    const { view, headerButton, dispatched } = mount(4);
    const tabs = [folderTab(10), terminalTab(11), terminalTab(12, { cwd: "/home/u/proj" })];
    view.update(pane(tabs, 10), true, null, null);
    headerButton("Split left/right").click();
    view.update(pane(tabs, 11), true, null, null);
    headerButton("Split left/right").click();
    view.update(pane(tabs, 12), true, null, null);
    headerButton("Split left/right").click();

    expect(dispatched.map((c) => (c.type === "splitPane" ? c.tab : c))).toEqual([
      { type: "terminal", cwd: null },
      { type: "terminal", cwd: null },
      { type: "terminal", cwd: "/home/u/proj" },
    ]);
  });
});

// 셸 없는 탭의 재시작 배너 (ADR-0010) — notStarted 와 exited 가 같은 배너를 쓰되
// 문구·라벨·색이 갈린다. 죽은 탭에 되살릴 길이 없던 것이 이 배너가 넓어진 이유다.
describe("PaneView restart banner", () => {
  function banner(view: PaneView): HTMLElement {
    return child(view.root, ".pane-restart");
  }

  it("stays hidden while the shell is running", () => {
    const { view } = mount();
    view.update(pane([terminalTab(10)], 10), true, null, null);
    expect(banner(view).hidden).toBe(true);
  });

  it("offers Retry on notStarted and the exit notice on exited, in place", () => {
    const { view } = mount();
    view.update(pane([terminalTab(10, { status: { type: "notStarted" } })], 10), true, null, null);
    const el = banner(view);
    expect(el.hidden).toBe(false);
    expect(el.classList.contains("exited")).toBe(false);
    expect(child(el, "span").textContent).toContain("has not started");
    expect(child(el, ".pane-restart-retry").textContent).toBe("Retry");

    view.update(
      pane([terminalTab(10, { status: { type: "exited", code: 1, endedAtMs: 1723100500000 } })], 10),
      true,
      null,
      null,
    );
    // 같은 노드에 문구만 갈린다 (배너를 새로 만들면 Restart 클릭이 유실될 수 있다).
    expect(banner(view)).toBe(el);
    expect(el.hidden).toBe(false);
    expect(el.classList.contains("exited")).toBe(true);
    // 배너는 code·시각을 그대로 말한다 (문구 자체는 exitedNoticeText 가 잠근다).
    expect(child(el, "span").textContent).toBe(exitedNoticeText(1, 1723100500000));
    expect(child(el, "span").textContent).toContain("(code 1)");
    expect(child(el, ".pane-restart-retry").textContent).toBe("Restart");

    view.update(pane([terminalTab(10)], 10), true, null, null);
    expect(el.hidden).toBe(true);
  });

  it("stays hidden for a viewer tab regardless of other tabs", () => {
    const { view } = mount();
    view.update(
      pane([folderTab(11), terminalTab(10, { status: { type: "exited", code: 0, endedAtMs: 1723100500000 } })], 11),
      true,
      null,
      viewerMount(11),
    );
    expect(banner(view).hidden).toBe(true);
  });
});

// 끝난 셸의 배너 문구 (ADR-0018) — code 와 시각은 각각 없을 수 있고, 없는 조각은
// 통째로 빠진다. 시각은 로컬 시간대라 기대값도 로컬 Date 로 만든다.
describe("exitedNoticeText", () => {
  const ENDED = new Date(2026, 8, 12, 14, 32).getTime();

  it("names the exit code and the local time", () => {
    expect(exitedNoticeText(0, ENDED)).toBe(
      "shell exited (code 0) at 14:32 — Restart opens a new shell here",
    );
  });

  it("drops the code when the backend never learned it", () => {
    expect(exitedNoticeText(null, ENDED)).toBe(
      "shell exited at 14:32 — Restart opens a new shell here",
    );
  });

  it("drops the time for a tab restored from a state.json without it", () => {
    expect(exitedNoticeText(137, null)).toBe(
      "shell exited (code 137) — Restart opens a new shell here",
    );
  });

  it("still says what happened and what Restart does with neither", () => {
    expect(exitedNoticeText(null, null)).toBe("shell exited — Restart opens a new shell here");
  });

  it("pads a single-digit hour and minute", () => {
    expect(exitedNoticeText(0, new Date(2026, 8, 12, 9, 5).getTime())).toContain(" at 09:05 ");
  });

  // 디스크에서 복원된 숫자가 Date 로 읽히지 않을 수 있다 — 그때는 "at NaN:NaN" 대신
  // 시각 조각을 통째로 뺀다 (없는 조각은 빼는 위 규율 그대로).
  it("drops the time when it is not a readable date", () => {
    expect(exitedNoticeText(0, Number.NaN)).toBe(
      "shell exited (code 0) — Restart opens a new shell here",
    );
    expect(exitedNoticeText(0, 8.64e15 + 1)).toBe(
      "shell exited (code 0) — Restart opens a new shell here",
    );
  });
});
