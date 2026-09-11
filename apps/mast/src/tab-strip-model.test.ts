// tab-strip-model 검증 — active·exited·notification 조합과 탭 순서 보존,
// 그리고 18단계 B-7 의 렌더 판정(tabStripPlan)·pane 배지 판정(paneUnread).

import { describe, expect, it } from "vitest";

import { paneUnread, sameTabButton, tabStripModel, tabStripPlan } from "./tab-strip-model";
import type { TabButtonModel } from "./tab-strip-model";
import type { NotificationState, Pane, Tab, TerminalStatus } from "./types";

function terminalTab(
  id: number,
  opts: {
    title?: string;
    status?: TerminalStatus;
    notification?: NotificationState;
    session?: number | null;
  } = {},
): Tab {
  return {
    id,
    title: opts.title ?? `tab ${id}`,
    kind: {
      type: "terminal",
      ptySession: opts.session === undefined ? id * 100 : opts.session,
      status: opts.status ?? { type: "running" },
      cwd: null,
    },
    notification: opts.notification ?? "none",
    lastActivityMs: null,
  };
}

function viewerTab(id: number): Tab {
  return {
    id,
    title: `viewer ${id}`,
    kind: { type: "textViewer", path: "C:/tmp/a.txt", scrollTop: 0 },
    notification: "none",
    lastActivityMs: null,
  };
}

function pane(id: number, tabs: Tab[], activeTab: number | null): Pane {
  return { id, tabs, activeTab };
}

describe("tabStripModel", () => {
  it("returns an empty array for an empty pane", () => {
    expect(tabStripModel(pane(1, [], null))).toEqual([]);
  });

  it("marks only the activeTab as active, preserving tab order", () => {
    const p = pane(1, [terminalTab(10), terminalTab(11), terminalTab(12)], 11);
    const models = tabStripModel(p);
    expect(models.map((m) => m.tab)).toEqual([10, 11, 12]);
    expect(models.map((m) => m.active)).toEqual([false, true, false]);
    expect(models[0]?.title).toBe("tab 10");
  });

  it("flags exited only for terminal tabs whose status is exited", () => {
    const p = pane(
      1,
      [
        terminalTab(10, { status: { type: "running" } }),
        terminalTab(11, { status: { type: "exited", code: 0 } }),
        terminalTab(12, { status: { type: "exited", code: null } }),
        viewerTab(13), // terminal 이 아니므로 exited 판정 대상이 아니다
      ],
      10,
    );
    expect(tabStripModel(p).map((m) => m.exited)).toEqual([false, true, true, false]);
  });

  it("maps notification unread to true and none to false", () => {
    const p = pane(
      1,
      [terminalTab(10, { notification: "unread" }), terminalTab(11, { notification: "none" })],
      10,
    );
    expect(tabStripModel(p).map((m) => m.notification)).toEqual([true, false]);
  });

  it("combines flags independently (active+exited+notification on one tab)", () => {
    const p = pane(
      1,
      [terminalTab(10, { status: { type: "exited", code: 1 }, notification: "unread" })],
      10,
    );
    expect(tabStripModel(p)).toEqual([
      {
        tab: 10,
        title: "tab 10",
        active: true,
        exited: true,
        notStarted: false,
        notification: true,
      },
    ]);
  });
  it("notStarted 는 exited 와 별개 배지다 — 끝난 것과 시작을 못 한 것은 다르다", () => {
    const p = pane(
      1,
      [terminalTab(10, { status: { type: "notStarted" } })],
      10,
    );
    expect(tabStripModel(p)).toEqual([
      {
        tab: 10,
        title: "tab 10",
        active: true,
        exited: false,
        notStarted: true,
        notification: false,
      },
    ]);
  });
});

/** 판정 테스트용 버튼 모델 — 기본은 평범한 비활성 탭. */
function button(tab: number, over: Partial<TabButtonModel> = {}): TabButtonModel {
  return {
    tab,
    title: `tab ${tab}`,
    active: false,
    exited: false,
    notStarted: false,
    notification: false,
    ...over,
  };
}

describe("tabStripPlan", () => {
  it("rebuilds on the first render (no previous model)", () => {
    expect(tabStripPlan(null, [button(10)])).toBe("rebuild");
  });

  it("skips when every field is identical", () => {
    const prev = [button(10, { active: true }), button(11)];
    const next = [button(10, { active: true }), button(11)];
    expect(tabStripPlan(prev, next)).toBe("skip");
  });

  it("patches when only a title changes (OSC 0/2 제목 갱신)", () => {
    const prev = [button(10), button(11)];
    const next = [button(10), button(11, { title: "claude — mast" })];
    expect(tabStripPlan(prev, next)).toBe("patch");
  });

  it("patches when unread or active flips", () => {
    const prev = [button(10, { active: true }), button(11)];
    expect(tabStripPlan(prev, [button(10, { active: true }), button(11, { notification: true })])).toBe(
      "patch",
    );
    expect(tabStripPlan(prev, [button(10), button(11, { active: true })])).toBe("patch");
    expect(tabStripPlan(prev, [button(10, { active: true, exited: true }), button(11)])).toBe(
      "patch",
    );
  });

  it("rebuilds when a tab is added or removed", () => {
    const prev = [button(10), button(11)];
    expect(tabStripPlan(prev, [button(10), button(11), button(12)])).toBe("rebuild");
    expect(tabStripPlan(prev, [button(10)])).toBe("rebuild");
  });

  it("rebuilds when the same tabs are reordered", () => {
    expect(tabStripPlan([button(10), button(11)], [button(11), button(10)])).toBe("rebuild");
  });

  it("rebuilds when a tab id is swapped in at the same index", () => {
    // 길이는 같지만 id 가 다르다 — 키잉 대상이 바뀌었으므로 패치 불가.
    expect(tabStripPlan([button(10), button(11)], [button(10), button(12)])).toBe("rebuild");
  });
});

describe("sameTabButton", () => {
  it("is true only when every rendered field matches", () => {
    expect(sameTabButton(button(10), button(10))).toBe(true);
    expect(sameTabButton(button(10), button(10, { title: "x" }))).toBe(false);
    expect(sameTabButton(button(10), button(10, { active: true }))).toBe(false);
    expect(sameTabButton(button(10), button(10, { exited: true }))).toBe(false);
    expect(sameTabButton(button(10), button(10, { notification: true }))).toBe(false);
  });
});

describe("paneUnread", () => {
  it("is false for an empty pane and for all-read tabs", () => {
    expect(paneUnread([])).toBe(false);
    expect(paneUnread([button(10, { active: true }), button(11)])).toBe(false);
  });

  it("is true when any tab is unread, including a hidden one", () => {
    expect(paneUnread([button(10, { active: true }), button(11, { notification: true })])).toBe(
      true,
    );
    expect(paneUnread([button(10, { active: true, notification: true })])).toBe(true);
  });
});
