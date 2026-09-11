// view-reconcile 검증 — planViewSync(부트 스윕(D4-b)·탭 닫힘·워크스페이스 밖
// dispose·keep-alive 유지·세션 없는 active 탭)와 planViewerSync(21단계: 활성
// 탭만 마운트·나머지 전부 dispose·탭 실존 플래그).

import { describe, expect, it } from "vitest";

import { planViewSync, planViewerSync } from "./view-reconcile";
import type { Pane, StateSnapshot, Tab, Workspace } from "./types";

function terminalTab(id: number, session: number | null, exited = false): Tab {
  return {
    id,
    title: `tab ${id}`,
    kind: {
      type: "terminal",
      ptySession: session,
      status: exited ? { type: "exited", code: 0 } : { type: "running" },
      cwd: null,
    },
    notification: "none",
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

function textTab(id: number, path = "/home/u/log.txt", scrollTop = 0): Tab {
  return {
    id,
    title: `text ${id}`,
    kind: { type: "textViewer", path, scrollTop },
    notification: "none",
    lastActivityMs: null,
  };
}

function pane(id: number, tabs: Tab[], activeTab: number | null): Pane {
  return { id, tabs, activeTab };
}

function workspace(id: number, panes: Pane[], activePane: number): Workspace {
  const record: Record<string, Pane> = {};
  for (const p of panes) record[String(p.id)] = p;
  return {
    id,
    name: `ws ${id}`,
    rootPath: null,
    distro: null,
    gitBranch: null,
    gitDirty: null,
    // planViewSync 는 layout 을 보지 않는다 — 형태만 유효한 leaf 로 채운다.
    layout: { type: "leaf", pane: panes[0]?.id ?? 0 },
    panes: record,
    activePane,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
}

function snapshot(workspaces: Workspace[], activeWorkspace: number | null): StateSnapshot {
  return {
    revision: 1,
    state: { workspaces, activeWorkspace, nextId: 100, revision: 1 },
  };
}

describe("planViewSync", () => {
  it("boot: attaches only visible tabs and sweeps every other session (D4-b)", () => {
    // 활성 ws: pane 1(active 탭 10=세션 100, 배경 탭 11=세션 101),
    //          pane 2(active 탭 12=세션 102). 비활성 ws: 탭 13=세션 103.
    const snap = snapshot(
      [
        workspace(
          1,
          [
            pane(1, [terminalTab(10, 100), terminalTab(11, 101)], 10),
            pane(2, [terminalTab(12, 102)], 12),
          ],
          1,
        ),
        workspace(2, [pane(3, [terminalTab(13, 103)], 13)], 3),
      ],
      1,
    );
    const plan = planViewSync([], snap);
    expect(plan.visible).toEqual([
      { pane: 1, tab: 10, session: 100 },
      { pane: 2, tab: 12, session: 102 },
    ]);
    expect(plan.dispose).toEqual([]);
    // 부트 스윕: 미방문(배경) 탭 101 + 비활성 ws 의 103 전부 detach.
    expect([...plan.detachSessions].sort((a, b) => a - b)).toEqual([101, 103]);
  });

  it("keeps alive background tabs of the active workspace (no dispose, no detach)", () => {
    const snap = snapshot(
      [workspace(1, [pane(1, [terminalTab(10, 100), terminalTab(11, 101)], 10)], 1)],
      1,
    );
    // 탭 11 은 배경이지만 alive(keep-alive) — dispose 도 detach 도 안 된다.
    const plan = planViewSync([10, 11], snap);
    expect(plan.dispose).toEqual([]);
    expect(plan.detachSessions).toEqual([]);
    expect(plan.visible).toEqual([{ pane: 1, tab: 10, session: 100 }]);
  });

  it("disposes an alive tab that vanished from the snapshot (tab closed)", () => {
    const snap = snapshot(
      [workspace(1, [pane(1, [terminalTab(10, 100)], 10)], 1)],
      1,
    );
    // 탭 11 은 닫혀 스냅샷에 없다 — dispose 로 떨어지고, 세션은 스냅샷에 없으므로
    // detach 스윕 대상도 아니다 (dispose 쪽 detach 가 처리).
    const plan = planViewSync([10, 11], snap);
    expect(plan.dispose).toEqual([11]);
    expect(plan.detachSessions).toEqual([]);
  });

  it("disposes alive tabs outside the active workspace without double-detaching", () => {
    const snap = snapshot(
      [
        workspace(1, [pane(1, [terminalTab(10, 100)], 10)], 1),
        workspace(2, [pane(2, [terminalTab(20, 200)], 20)], 2),
      ],
      1,
    );
    // 워크스페이스 전환 직후: ws 2 의 탭 20 이 아직 alive — dispose 대상.
    // 세션 200 은 alive 라 detach 목록에 넣지 않는다 (dispose 가 detach — 멱등 중복 회피).
    const plan = planViewSync([10, 20], snap);
    expect(plan.dispose).toEqual([20]);
    expect(plan.detachSessions).toEqual([]);
  });

  it("skips active tabs without a pty session and still sweeps their pane's others", () => {
    const snap = snapshot(
      [
        workspace(
          1,
          [pane(1, [terminalTab(10, null), terminalTab(11, 101)], 10)],
          1,
        ),
      ],
      1,
    );
    const plan = planViewSync([], snap);
    // active 탭 10 은 세션이 없어 visible 이 아니고, 배경 탭 11 은 스윕된다.
    expect(plan.visible).toEqual([]);
    expect(plan.detachSessions).toEqual([101]);
  });

  it("keeps exited sessions visible (replay display)", () => {
    const snap = snapshot(
      [workspace(1, [pane(1, [terminalTab(10, 100, true)], 10)], 1)],
      1,
    );
    const plan = planViewSync([], snap);
    expect(plan.visible).toEqual([{ pane: 1, tab: 10, session: 100 }]);
    expect(plan.detachSessions).toEqual([]);
  });

  it("disposes everything when there is no active workspace", () => {
    const snap = snapshot([workspace(1, [pane(1, [terminalTab(10, 100)], 10)], 1)], null);
    const plan = planViewSync([10], snap);
    expect(plan.visible).toEqual([]);
    expect(plan.dispose).toEqual([10]);
    expect(plan.detachSessions).toEqual([]);
  });

  it("ignores viewer tabs entirely (they belong to planViewerSync)", () => {
    const snap = snapshot(
      [workspace(1, [pane(1, [folderTab(10), terminalTab(11, 101)], 10)], 1)],
      1,
    );
    const plan = planViewSync([], snap);
    // active 탭이 뷰어라 visible 은 비고, 배경 터미널은 스윕된다.
    expect(plan.visible).toEqual([]);
    expect(plan.detachSessions).toEqual([101]);
  });
});

describe("planViewerSync", () => {
  it("mounts only the active viewer tab of each pane in the active workspace", () => {
    const snap = snapshot(
      [
        workspace(
          1,
          [
            // pane 1: active 뷰어 + 배경 뷰어, pane 2: active 뷰어.
            pane(1, [folderTab(10, "/home/u"), textTab(11)], 10),
            pane(2, [textTab(12, "/var/log/syslog", 42)], 12),
          ],
          1,
        ),
        // 비활성 워크스페이스의 active 뷰어는 마운트 대상이 아니다.
        workspace(2, [pane(3, [folderTab(13, "/etc")], 13)], 3),
      ],
      1,
    );
    const plan = planViewerSync([], snap);
    expect(plan.mount).toEqual([
      { pane: 1, tab: 10, kind: { type: "folderBrowser", path: "/home/u" } },
      { pane: 2, tab: 12, kind: { type: "textViewer", path: "/var/log/syslog", scrollTop: 42 } },
    ]);
    expect(plan.dispose).toEqual([]);
  });

  it("never mounts a terminal tab", () => {
    const snap = snapshot(
      [workspace(1, [pane(1, [terminalTab(10, 100), folderTab(11)], 10)], 1)],
      1,
    );
    expect(planViewerSync([], snap).mount).toEqual([]);
  });

  it("disposes a viewer that became a background tab, flagging the tab as alive", () => {
    // 같은 pane 안에서 뷰어 10 → 터미널 11 로 active 가 옮겨간 직후.
    const snap = snapshot(
      [workspace(1, [pane(1, [folderTab(10), terminalTab(11, 101)], 11)], 1)],
      1,
    );
    const plan = planViewerSync([10], snap);
    expect(plan.mount).toEqual([]);
    // 탭은 살아 있다 — unmount 전에 flushScroll 을 보내야 하는 경우.
    expect(plan.dispose).toEqual([{ tab: 10, tabExists: true }]);
  });

  it("flags a vanished tab so the caller skips the scroll flush", () => {
    const snap = snapshot([workspace(1, [pane(1, [terminalTab(11, 101)], 11)], 1)], 1);
    // 뷰어 탭 10 이 닫혔다 — flush 를 보내면 unknownTarget 잡음이 된다.
    expect(planViewerSync([10], snap).dispose).toEqual([{ tab: 10, tabExists: false }]);
  });

  it("keeps tabExists true for a viewer left behind in another workspace", () => {
    const snap = snapshot(
      [
        workspace(1, [pane(1, [terminalTab(10, 100)], 10)], 1),
        workspace(2, [pane(2, [folderTab(20)], 20)], 2),
      ],
      1,
    );
    // 워크스페이스 전환 직후: ws 2 의 뷰어 20 은 unmount 대상이지만 탭은 남아 있다.
    const plan = planViewerSync([20], snap);
    expect(plan.mount).toEqual([]);
    expect(plan.dispose).toEqual([{ tab: 20, tabExists: true }]);
  });

  it("keeps a mounted viewer mounted across snapshots (no churn)", () => {
    const snap = snapshot([workspace(1, [pane(1, [folderTab(10)], 10)], 1)], 1);
    const plan = planViewerSync([10], snap);
    expect(plan.dispose).toEqual([]);
    expect(plan.mount).toEqual([
      { pane: 1, tab: 10, kind: { type: "folderBrowser", path: "/home/u" } },
    ]);
  });

  it("disposes every viewer when there is no active workspace", () => {
    const snap = snapshot([workspace(1, [pane(1, [folderTab(10)], 10)], 1)], null);
    const plan = planViewerSync([10], snap);
    expect(plan.mount).toEqual([]);
    // 스냅샷에는 남아 있는 탭이므로 flush 대상이다.
    expect(plan.dispose).toEqual([{ tab: 10, tabExists: true }]);
  });
});
