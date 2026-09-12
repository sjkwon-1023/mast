// keep-alive 뷰 수명 리컨실 계획 계산 (DOM-free — vitest 대상, 12단계 청크 C).
//
// 스냅샷마다 workspace-view 가 호출해 "지금 살아 있는 뷰 집합(alive)"을 스냅샷과
// 대조하고 세 가지를 판정한다 (계획 D3·D4-b):
//
// - visible: 활성 워크스페이스 각 pane 의 active 탭 중 terminal + pty_session 이
//   있는 것 — 이번 렌더에서 화면에 배치(없으면 lazy attach)할 뷰.
// - dispose: alive 인데 뷰를 유지할 근거가 없는 것 — 스냅샷에서 사라진 탭(닫힘),
//   활성 워크스페이스 밖 탭(워크스페이스 이탈), 그리고 세션을 놓은 terminal 탭
//   (exit — 마지막 화면은 기록 뷰가 그린다, ADR-0018) 이 여기 떨어진다.
//   수명 규칙 "alive 뷰 ⊆ 활성 워크스페이스에서 세션을 든 탭"의 집행 지점이다.
//   dispose 는 TerminalView.dispose() 로 이어져 채널 detach 까지 처리한다.
// - detachSessions: 스냅샷 **전체**에서 pty_session 이 있는 terminal 탭 중 이번에
//   attach(= alive 또는 visible)되지 않는 모든 세션 — detach_terminal fire-and-
//   forget 스윕 대상. 부트(alive 비어 있음)에서 이 목록이 "미방문 탭 세션 전부"가
//   되는 것이 D4-b 의 핵심이다: F5 리로드는 dispose 를 타지 않아 죽은 채널이
//   Delivered-무ack 로 paused 에 고착되는데, 이 스윕이 매 스냅샷 멱등하게 치운다.
//   (alive 인데 dispose 로 떨어진 탭의 세션은 여기 넣지 않는다 — dispose 쪽이
//   detach 를 수행하므로 중복이고, detach 는 어차피 멱등이다.)

// 뷰어 탭(21단계)의 수명은 정반대 시맨틱이라 같은 함수에 얹지 않고 별도 순수
// 함수 planViewerSync 로 둔다 — 파일 하단 참조. planViewSync 는 무변경이다.

import type { TerminalRecordKind, ViewerKind } from "./viewer-view";
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

  // visible + 뷰를 계속 들고 있어도 되는 탭 집합 (dispose 판정용).
  const visible: VisibleView[] = [];
  const visibleTabs = new Set<TabId>();
  const keepAliveTabs = new Set<TabId>();
  if (ws !== null) {
    for (const pane of Object.values(ws.panes)) {
      for (const tab of pane.tabs) {
        // 세션을 놓은 terminal 탭은 **활성 워크스페이스 안이라도** 뷰를 내린다
        // (ADR-0018): 남겨 두면 pane-view 의 setVisible 루프가 기록 뷰 위에 낡은
        // TerminalView 를 다시 띄워 두 화면이 겹친다. 뷰어 탭은 이 레지스트리에
        // 들어오지 않으므로 여기 있어도 무해하다.
        if (tab.kind.type !== "terminal" || tab.kind.ptySession !== null) {
          keepAliveTabs.add(tab.id);
        }
        if (
          tab.id === pane.activeTab &&
          tab.kind.type === "terminal" &&
          tab.kind.ptySession !== null
        ) {
          // 정상 경로의 exited 탭은 세션을 이미 놓았으므로(ADR-0018) 여기서
          // 걸러진다 — 마지막 화면을 그리는 것은 attach 가 아니라 기록이다.
          // 세션을 아직 문 채 온 exited 탭(낡은 스냅샷·정합성 수리 전)은 여기
          // 남아 attach 를 시도하고, audit 의 수리가 그 상태를 정리한다.
          visible.push({ pane: pane.id, tab: tab.id, session: tab.kind.ptySession });
          visibleTabs.add(tab.id);
        }
      }
    }
  }

  const dispose = [...alive].filter((tab) => !keepAliveTabs.has(tab));

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

/** 스냅샷 **전체**(비활성 워크스페이스 포함)의 탭 id 집합.
 *
 *  "이 탭이 아직 존재하는가"는 dispose 의 두 원인을 가르는 판정이다 — 워크스페이스
 *  이탈(탭은 남아 있다)과 탭 닫힘(사라졌다). 뷰어는 스크롤 flush 를 보낼지에,
 *  터미널은 스크롤 위치를 기억할지에 같은 답을 쓴다 (ADR-0019). */
export function existingTabIds(snapshot: StateSnapshot): Set<TabId> {
  const existing = new Set<TabId>();
  for (const w of snapshot.state.workspaces) {
    for (const pane of Object.values(w.panes)) {
      for (const tab of pane.tabs) existing.add(tab.id);
    }
  }
  return existing;
}

// ── 뷰어 탭 수명 (21단계 청크 C1) ────────────────────────────────────────
//
// 터미널의 keep-alive 와 반대다 (계획 v2 "탭 타입별 동작"): 뷰어 뷰는 활성
// 워크스페이스 각 pane 의 **active 탭일 때만** 살아 있고, 배경 탭이 되는 순간
// DOM 을 내린다. 그래서 planViewSync 를 확장하지 않고 반대 판정의 순수 함수를
// 하나 더 둔다 — 두 레지스트리(views / viewerViews)는 서로 겹치지 않는다.
// exited 터미널 탭이 뷰어로 오면서 "종류"만으로는 그것이 보장되지 않게 됐지만,
// 같은 탭이 양쪽 판정을 동시에 통과할 수는 없다: 여기의 통과 조건이
// `ptySession === null` 이고 planViewSync 의 visible 조건이 그 반대이며,
// 세션을 놓는 순간 planViewSync 의 dispose 가 터미널 뷰를 먼저 내린다.

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

/** 세션을 놓은 exited 터미널 탭 — 뷰어 수명으로 마운트되는 기록 뷰의 대상이다
 *  (ADR-0018). 재스폰 실패로 `Exited` 로 강등된 탭도 **일부러** 여기 들어온다:
 *  글루는 재시작에 성공했을 때만 기록을 지우므로(commands.rs 의
 *  `forget_record_after_respawn`) 실패한 재시도는 사용자가 보던 마지막 화면을
 *  그대로 유지해야 한다. 기록이 애초에 없던 탭(NotStarted 의 Retry 실패)은 뷰가
 *  안내 한 줄을 그린다 — 빈 화면과 읽기 실패를 구분하는 정상 경로다.
 *  세션만 없고 exited 가 아닌 탭(부팅 복원 직후의 Running, NotStarted)은 대상이
 *  아니다: 끝난 셸이 없으니 그릴 마지막 화면도 없다. */
function isTerminalRecord(kind: TabKind): kind is TerminalRecordKind {
  return kind.type === "terminal" && kind.ptySession === null && kind.status.type === "exited";
}

/** kind 가 뷰어면 그대로, 기록 뷰 대상인 terminal 이면 그대로, 아니면 null. */
function viewerKind(kind: TabKind): ViewerKind | null {
  if (kind.type !== "terminal") return kind;
  return isTerminalRecord(kind) ? kind : null;
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
  const existing = existingTabIds(snapshot);

  const dispose: ViewerDispose[] = [];
  for (const tab of alive) {
    if (mounted.has(tab)) continue;
    dispose.push({ tab, tabExists: existing.has(tab) });
  }

  return { mount, dispose };
}
