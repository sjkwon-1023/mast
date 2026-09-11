// keep-alive 뷰 수명 리컨실 계획 계산 (DOM-free — vitest 대상, 12단계 청크 C).
//
// 스냅샷마다 workspace-view 가 호출해 "지금 살아 있는 뷰 집합(alive)"을 스냅샷과
// 대조하고 세 가지를 판정한다 (계획 D3·D4-b):
//
// - visible: 활성 워크스페이스 각 pane 의 active 탭 중 terminal + pty_session 이
//   있는 것 — 이번 렌더에서 화면에 배치(없으면 lazy attach)할 뷰.
// - dispose: alive 인데 활성 워크스페이스의 탭이 아닌 것 — 스냅샷에서 사라진
//   탭(닫힘)과 활성 워크스페이스 밖 탭(워크스페이스 이탈) 둘 다 여기 떨어진다.
//   수명 규칙 "alive 뷰 ⊆ 활성 워크스페이스의 탭"의 집행 지점이다. dispose 는
//   TerminalView.dispose() 로 이어져 채널 detach 까지 처리한다.
// - detachSessions: 스냅샷 **전체**에서 pty_session 이 있는 terminal 탭 중 이번에
//   attach(= alive 또는 visible)되지 않는 모든 세션 — detach_terminal fire-and-
//   forget 스윕 대상. 부트(alive 비어 있음)에서 이 목록이 "미방문 탭 세션 전부"가
//   되는 것이 D4-b 의 핵심이다: F5 리로드는 dispose 를 타지 않아 죽은 채널이
//   Delivered-무ack 로 paused 에 고착되는데, 이 스윕이 매 스냅샷 멱등하게 치운다.
//   (alive 인데 dispose 로 떨어진 탭의 세션은 여기 넣지 않는다 — dispose 쪽이
//   detach 를 수행하므로 중복이고, detach 는 어차피 멱등이다.)

// 뷰어 탭(21단계)의 수명은 정반대 시맨틱이라 같은 함수에 얹지 않고 별도 순수
// 함수 planViewerSync 로 둔다 — 파일 하단 참조. planViewSync 는 무변경이다.

import type { ViewerKind } from "./viewer-view";
import type { PaneId, SessionId, StateSnapshot, TabId, TabKind } from "./types";

/** 화면에 배치할 뷰 1개 — pane 의 active terminal 탭과 그 세션. */
export interface VisibleView {
  pane: PaneId;
  tab: TabId;
  session: SessionId;
}

export interface ViewSyncPlan {
  dispose: TabId[];
  detachSessions: SessionId[];
  visible: VisibleView[];
}

/** alive 뷰 집합 × 스냅샷 → 리컨실 계획. 순수 함수 — 실행(dispose·detach·배치)은
 *  workspace-view 몫이다. */
export function planViewSync(
  aliveTabIds: Iterable<TabId>,
  snapshot: StateSnapshot,
): ViewSyncPlan {
  const alive = new Set<TabId>(aliveTabIds);
  const state = snapshot.state;
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspace) ?? null;

  // visible + 활성 워크스페이스 탭 집합 (dispose 판정용).
  const visible: VisibleView[] = [];
  const visibleTabs = new Set<TabId>();
  const activeWsTabs = new Set<TabId>();
  if (ws !== null) {
    for (const pane of Object.values(ws.panes)) {
      for (const tab of pane.tabs) {
        activeWsTabs.add(tab.id);
        if (
          tab.id === pane.activeTab &&
          tab.kind.type === "terminal" &&
          tab.kind.ptySession !== null
        ) {
          // exited 세션도 attach 한다 — replay 표시가 Exited 탭의 존재 이유다.
          visible.push({ pane: pane.id, tab: tab.id, session: tab.kind.ptySession });
          visibleTabs.add(tab.id);
        }
      }
    }
  }

  const dispose = [...alive].filter((tab) => !activeWsTabs.has(tab));

  // 스냅샷 전체 스캔 — attach 되지 않는 terminal 세션 전부 (파일 상단 규칙).
  const detachSessions: SessionId[] = [];
  for (const w of state.workspaces) {
    for (const pane of Object.values(w.panes)) {
      for (const tab of pane.tabs) {
        if (tab.kind.type !== "terminal" || tab.kind.ptySession === null) continue;
        if (alive.has(tab.id) || visibleTabs.has(tab.id)) continue;
        detachSessions.push(tab.kind.ptySession);
      }
    }
  }

  return { dispose, detachSessions, visible };
}

// ── 뷰어 탭 수명 (21단계 청크 C1) ────────────────────────────────────────
//
// 터미널의 keep-alive 와 반대다 (계획 v2 "탭 타입별 동작"): 뷰어 뷰는 활성
// 워크스페이스 각 pane 의 **active 탭일 때만** 살아 있고, 배경 탭이 되는 순간
// DOM 을 내린다. 그래서 planViewSync 를 확장하지 않고 반대 판정의 순수 함수를
// 하나 더 둔다 — 두 레지스트리(views / viewerViews)는 서로 겹치지 않는다
// (탭 하나는 terminal 이거나 뷰어이지 둘 다일 수 없다).

/** 이번 렌더에 마운트할 뷰어 1개 — pane 의 active 뷰어 탭과 그 kind. */
export interface VisibleViewer {
  pane: PaneId;
  tab: TabId;
  kind: ViewerKind;
}

/** 내릴 뷰어 1개. tabExists 는 그 탭이 **스냅샷 어딘가에** 아직 남아 있는지다:
 *  남아 있으면 단순 unmount(배경 탭 전환·워크스페이스 이탈)라 dispose 전에
 *  스크롤을 flush 해야 하고, 사라졌으면(CloseTab·ClosePane 등) flush 를 보내면
 *  없는 탭 대상 setViewerScroll 이 되어 unknownTarget 잡음이 된다. */
export interface ViewerDispose {
  tab: TabId;
  tabExists: boolean;
}

export interface ViewerSyncPlan {
  mount: VisibleViewer[];
  dispose: ViewerDispose[];
}

/** kind 가 뷰어면 그대로, terminal 이면 null. */
function viewerKind(kind: TabKind): ViewerKind | null {
  return kind.type === "terminal" ? null : kind;
}

/** 살아 있는 뷰어 뷰 집합 × 스냅샷 → 마운트/해제 계획. 순수 함수 — 실제 생성·
 *  flush·dispose 는 workspace-view 몫이다. */
export function planViewerSync(
  aliveViewerTabs: Iterable<TabId>,
  snapshot: StateSnapshot,
): ViewerSyncPlan {
  const alive = new Set<TabId>(aliveViewerTabs);
  const state = snapshot.state;
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspace) ?? null;

  const mount: VisibleViewer[] = [];
  const mounted = new Set<TabId>();
  if (ws !== null) {
    for (const pane of Object.values(ws.panes)) {
      for (const tab of pane.tabs) {
        if (tab.id !== pane.activeTab) continue;
        const kind = viewerKind(tab.kind);
        if (kind === null) continue;
        mount.push({ pane: pane.id, tab: tab.id, kind });
        mounted.add(tab.id);
      }
    }
  }

  // 탭 실존 판정은 스냅샷 **전체** 스캔이다 — 비활성 워크스페이스로 옮겨간
  // 탭도 "남아 있는" 탭이라 flush 대상이다.
  const existing = new Set<TabId>();
  for (const w of state.workspaces) {
    for (const pane of Object.values(w.panes)) {
      for (const tab of pane.tabs) existing.add(tab.id);
    }
  }

  const dispose: ViewerDispose[] = [];
  for (const tab of alive) {
    if (mounted.has(tab)) continue;
    dispose.push({ tab, tabExists: existing.has(tab) });
  }

  return { mount, dispose };
}
