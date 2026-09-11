// 탭바 버튼 모델 계산 (DOM-free — vitest 대상, 12단계 청크 C).
//
// Pane 의 tabs 를 렌더 가능한 버튼 모델 배열로 사영한다. DOM 조립(pane-view)과
// 판정 로직을 분리해 active·exited·notification 조합을 순수 테스트로 잠근다.
//
// 18단계 B-7 부터 렌더 판정(tabStripPlan)과 pane 층 배지 판정(paneUnread)도 여기
// 산다: 스트립을 재조립할지 말지는 버튼 모델의 id 멤버십·필드 동일성만으로
// 결정되는 순수 판정이라, DOM 없는 vitest 로 잠글 수 있어야 한다 (sidebar-model
// 의 reconcilePlan 과 같은 구도).

import type { Pane, TabId } from "./types";

/** 탭 버튼 1개의 렌더 모델. */
export interface TabButtonModel {
  tab: TabId;
  title: string;
  /** pane 의 activeTab 인지 — 강조 + 클릭 no-op 판정에 쓰인다. */
  active: boolean;
  /** terminal 탭이고 프로세스가 종료됐는지 (Exited 배지 — 계획 1-C). */
  exited: boolean;
  /** 프로세스는 살아 있는데 시작 표식이 마감 안에 오지 않았는지. exited 와 나누는
   *  이유는 사용자에게 다른 상황이기 때문이다 — 끝난 게 아니라 시작을 못 한 것이고,
   *  늦게라도 표식이 오면 저절로 걷힌다. */
  notStarted: boolean;
  /** 미확인 알림 dot 표시 여부 (NotificationState "unread"). */
  notification: boolean;
}

/** Pane → 탭 버튼 모델 배열 (탭 순서 유지). 탭 0개면 빈 배열. */
export function tabStripModel(pane: Pane): TabButtonModel[] {
  return pane.tabs.map((tab) => ({
    tab: tab.id,
    title: tab.title,
    active: tab.id === pane.activeTab,
    exited: tab.kind.type === "terminal" && tab.kind.status.type === "exited",
    notStarted: tab.kind.type === "terminal" && tab.kind.status.type === "notStarted",
    notification: tab.notification === "unread",
  }));
}

/** 탭 스트립 렌더 판정 (18단계 B-7).
 *  - `skip`: 모델이 완전히 동일 — DOM 을 건드리지 않는다.
 *  - `patch`: 탭 id 배열의 멤버십·순서가 같고 필드만 변함 — 기존 탭 버튼 노드를
 *    유지한 채 제목·dot·클래스만 갱신한다.
 *  - `rebuild`: 탭이 추가·삭제·재정렬됨(또는 첫 렌더) — 스트립을 재조립한다. */
export type TabStripReconcile = "skip" | "patch" | "rebuild";

/** 탭 버튼 모델 1개의 전 필드 동일성 — 이 탭의 DOM 을 건드릴지 판정한다. */
export function sameTabButton(a: TabButtonModel, b: TabButtonModel): boolean {
  return (
    a.tab === b.tab &&
    a.title === b.title &&
    a.active === b.active &&
    a.exited === b.exited &&
    a.notStarted === b.notStarted &&
    a.notification === b.notification
  );
}

/** 직전 렌더 모델(첫 렌더면 null) × 이번 모델 → 렌더 판정. 순수 함수 —
 *  실행(재조립·패치)은 pane-view 몫이다.
 *
 *  12단계의 "모델 전체 직렬화 키가 같을 때만 스킵"하던 가드는 제목이 정적이고
 *  notification 이 항상 none 이던 시절에만 성립했다. 18단계부터 OSC 0/2 제목과
 *  unread 가 매 알림마다 변하는 동적 필드가 되어 그 가드가 상시로 뚫리는데,
 *  그때 스트립을 통째로 재조립하면 눌린 탭 엘리먼트가 mousedown~click 사이에
 *  갈아치워져 클릭이 유실된다 (ADR-0003 결정 7 의 스왈로). */
export function tabStripPlan(
  prev: TabButtonModel[] | null,
  next: TabButtonModel[],
): TabStripReconcile {
  if (prev === null || prev.length !== next.length) return "rebuild";
  for (let i = 0; i < next.length; i += 1) {
    const before = prev[i];
    const after = next[i];
    if (before === undefined || after === undefined) return "rebuild";
    if (before.tab !== after.tab) return "rebuild";
  }
  const changed = next.some((after, i) => {
    const before = prev[i];
    return before === undefined || !sameTabButton(before, after);
  });
  return changed ? "patch" : "skip";
}

/** pane 헤더 집계 배지 판정 (18단계 B-7) — 이 pane 의 어느 탭이든 미확인 알림이
 *  있으면 true. 탭 dot 과 따로 두는 이유: 탭바는 폭이 모자라면 넘치는 탭을 잘라
 *  감추므로(styles.css `.pane-tabs` overflow) 숨은 탭의 dot 은 화면에 없다.
 *  배지가 그 알림을 pane 층에서 대신 표면화한다 (계획 v2 9장 3층 중 pane 층). */
export function paneUnread(models: TabButtonModel[]): boolean {
  return models.some((m) => m.notification);
}
