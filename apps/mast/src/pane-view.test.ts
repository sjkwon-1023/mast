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

import { describe, expect, it } from "vitest";

import { PaneView, exitedNoticeText } from "./pane-view";
import type { SendController, ViewRegistry, ViewerRegistry } from "./pane-view";
import type { VisibleViewer } from "./view-reconcile";
import type { ViewerKind, ViewerView } from "./viewer-view";
import type { Command, NotificationState, Pane, PaneId, Tab, TerminalStatus } from "./types";

function terminalTab(
  id: number,
  opts: {
    title?: string;
    status?: TerminalStatus;
    notification?: NotificationState;
    cwd?: string;
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
  };
}

function folderTab(id: number, path = "/home/u"): Tab {
  return {
    id,
    title: `folder ${id}`,
    kind: { type: "folderBrowser", path },
    notification: "none",
    lastActivityMs: null,
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
});

describe("PaneView header buttons", () => {
  /** 헤더 **직속** 버튼만 (탭 × 는 .pane-tabs 안이라 제외). */
  function headerButtons(view: PaneView): HTMLButtonElement[] {
    const header = child(view.root, ".pane-header");
    return Array.from(header.children).filter(
      (el): el is HTMLButtonElement => el.tagName === "BUTTON",
    );
  }

  it("has exactly the four working buttons — the send pair is retired", () => {
    const { view } = mount();
    view.update(pane(THREE, 10), true, null, null);

    const titles = headerButtons(view).map((b) => b.title);
    expect(titles).toHaveLength(4);
    expect(titles.filter((t) => t.toLowerCase().includes("send"))).toEqual([]);
    // 툴팁의 기능 설명 부분만 본다 — 뒤에 붙는 단축키 표기는 keys.ts 소유.
    expect(titles.map((t) => t.replace(/ \(.*\)$/, ""))).toEqual([
      "New terminal tab",
      "New folder browser tab",
      "Split left/right",
      "Split top/bottom",
    ]);
  });

  it("draws the folder and split icons as inline SVG on one shared 16px grid", () => {
    const { view } = mount();
    view.update(pane(THREE, 10), true, null, null);

    const [plus, ...icons] = headerButtons(view);
    // + 는 텍스트 라벨 그대로다 (판단: 기호가 이미 자명하다).
    expect(plus.textContent).toBe("+");
    expect(icons).toHaveLength(3);
    for (const btn of icons) {
      const svg = btn.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16");
      expect(svg?.getAttribute("stroke-width")).toBe("1.5");
      expect(svg?.getAttribute("stroke")).toBe("currentColor");
    }
    // 분할 페어는 같은 사각형에 이등분선 방향만 다르다 — 마크업이 실제로 갈리는지.
    const [, leftRight, topBottom] = icons;
    expect(leftRight.innerHTML).not.toBe(topBottom.innerHTML);
    expect(leftRight.querySelector("path")?.getAttribute("d")).toContain("v10.5");
    expect(topBottom.querySelector("path")?.getAttribute("d")).toContain("h10.5");
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
});
