// 뷰어 탭 뷰의 공통 계약 (21단계 청크 C1) — folder-view.ts 가 구현하고,
// text-view.ts(C2)·markdown-view.ts(D)가 뒤따른다.
//
// TerminalView 와 수명 시맨틱이 정반대다: 터미널 뷰는 keep-alive(배경 탭도 살아
// 있음)지만, 뷰어 뷰는 **활성 탭일 때만 마운트**된다 (계획 v2 "탭 타입별 동작" —
// 비활성 뷰어 탭은 모델 상태만 남기고 DOM 을 내린다). 그래서 수명 판정도 별도
// 순수 함수(view-reconcile 의 planViewerSync)와 별도 레지스트리(workspace-view 의
// viewerViews)를 쓴다.

import type { TabKind } from "./types";

/** 뷰어 탭의 kind — TabKind 에서 terminal 을 뺀 나머지. 종류가 늘면(21단계 청크
 *  D 의 markdownViewer) 여기 자동으로 따라온다. */
export type ViewerKind = Exclude<TabKind, { type: "terminal" }>;

/** 뷰어 뷰 1개. 소유자는 workspace-view 의 viewerViews 레지스트리다. */
export interface ViewerView {
  /** pane 콘텐츠 영역에 붙는 루트 엘리먼트. 생성자가 직접 append 한다
   *  (TerminalView 와 같은 관례). */
  readonly root: HTMLElement;
  /** 스냅샷 반영 — 마운트된 동안 렌더마다 불린다. 무변경 호출(같은 kind)은
   *  no-op 이어야 한다: 매 revision 마다 파일·디렉터리를 다시 읽으면 안 된다. */
  update(kind: ViewerKind): void;
  /** unmount 직전 스크롤 위치를 모델에 기록한다 (dispose 앞에서 1회).
   *  스크롤 상태를 모델에 갖지 않는 종류(folderBrowser)는 no-op 이다 —
   *  setViewerScroll 을 보내면 kindMismatch 다. */
  flushScroll(): void;
  /** 명시적 focus (D7 보상 경로 — TerminalView.focus 와 같은 자리). */
  focus(): void;
  dispose(): void;
}
