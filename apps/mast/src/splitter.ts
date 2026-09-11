// split 컨테이너 사이 4px 드래그 핸들 (11단계 청크 B — 계획 D2).
//
// 드래그 중에는 dispatch 없이 양쪽 자식의 flex-grow 만 로컬 갱신(프리뷰)하고,
// 드래그 활성 가드(guard.begin)를 등록해 그 사이 도착하는 스냅샷(SessionExited
// 등도 revision 을 올린다)이 이 split 의 프리뷰 ratio 를 밟지 않게 한다
// (workspace-view 의 in-place 갱신이 활성 SplitId 집합을 건너뛴다). pointerup 에
// 가드를 풀고 ResizeSplit 을 정확히 1회 dispatch 한다 — 실패(스테일 id 등)하면
// 최신 스냅샷 기준 복원 콜백(restore)으로 프리뷰를 되돌린다.

import { flexPair, ratioFromPointer } from "./split-layout";
import type { Command, CommandOutput, SplitDirection, SplitId } from "./types";

/** 드래그 클램프의 pane 최소 픽셀 — 이보다 작게는 줄일 수 없다 (D2 픽셀 클램프). */
export const MIN_PANE_PX = 80;

/** 드래그 시작값과 이 폭 미만 차이면 dispatch 를 생략한다 — 제자리 드래그가
 *  무변경 revision 을 만드는 잡음 방지 (리뷰 메모). */
export const RATIO_NOOP_EPS = 0.001;

/** 드래그 활성 SplitId 집합의 등록/해제 — workspace-view 가 소유한다. */
export interface DragGuard {
  begin(id: SplitId): void;
  end(id: SplitId): void;
}

export interface SplitterOptions {
  /** rect 측정용 split 컨테이너 (핸들의 부모). */
  container: HTMLElement;
  splitId: SplitId;
  direction: SplitDirection;
  /** flex-grow 프리뷰 대상 — split 컨테이너의 첫/둘째 자식 엘리먼트. */
  first: HTMLElement;
  second: HTMLElement;
  guard: DragGuard;
  /** main.ts dispatchUI — 실패는 상태 라인에 표면화되고 null 로 돌아온다. */
  dispatch: (cmd: Command) => Promise<CommandOutput | null>;
  /** 최신 스냅샷의 ratio 재적용 (dispatch 실패·pointercancel 시 복원). */
  restore: () => void;
}

export class Splitter {
  readonly handle: HTMLDivElement;
  private dragging = false;
  private lastRatio: number | null = null;
  /** 드래그 시작 시점의 ratio — pointerup 의 no-op 판정 기준. 모델 값을 직접
   *  받지 않으므로 현재 flex-grow 쌍(applyRatio 가 설정)에서 역산한다. */
  private startRatio: number | null = null;
  private disposed = false;

  constructor(private readonly opts: SplitterOptions) {
    this.handle = document.createElement("div");
    this.handle.className = "splitter";

    this.handle.addEventListener("pointerdown", (ev) => this.onPointerDown(ev));
    this.handle.addEventListener("pointermove", (ev) => this.onPointerMove(ev));
    this.handle.addEventListener("pointerup", () => this.onPointerUp());
    this.handle.addEventListener("pointercancel", () => this.onPointerCancel());
  }

  private onPointerDown(ev: PointerEvent): void {
    if (this.disposed || ev.button !== 0) return;
    // 텍스트 선택·네이티브 드래그 방지 — 핸들에는 강탈할 포커스 대상이 없다.
    ev.preventDefault();
    this.handle.setPointerCapture(ev.pointerId);
    this.dragging = true;
    this.lastRatio = null;
    const g1 = Number.parseFloat(this.opts.first.style.flexGrow);
    const g2 = Number.parseFloat(this.opts.second.style.flexGrow);
    this.startRatio =
      Number.isFinite(g1) && Number.isFinite(g2) && g1 + g2 > 0 ? g1 / (g1 + g2) : null;
    this.opts.guard.begin(this.opts.splitId);
  }

  private onPointerMove(ev: PointerEvent): void {
    if (!this.dragging) return;
    const ratio = ratioFromPointer(
      this.opts.container.getBoundingClientRect(),
      { x: ev.clientX, y: ev.clientY },
      this.opts.direction,
      MIN_PANE_PX,
    );
    this.lastRatio = ratio;
    // 로컬 프리뷰 — dispatch 없음. flex-grow 만 갱신하고 basis 는 컨테이너
    // 구축 시 설정된 0 그대로 둔다 (workspace-view.applyRatio 와 합의된 구조).
    const pair = flexPair(ratio);
    this.opts.first.style.flexGrow = String(pair.first);
    this.opts.second.style.flexGrow = String(pair.second);
  }

  private onPointerUp(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.opts.guard.end(this.opts.splitId);
    const ratio = this.lastRatio;
    const startRatio = this.startRatio;
    this.lastRatio = null;
    this.startRatio = null;
    if (ratio === null) return; // 이동 없는 클릭 — 프리뷰도 dispatch 도 없었다
    if (startRatio !== null && Math.abs(ratio - startRatio) < RATIO_NOOP_EPS) {
      // 제자리 드래그 — dispatch 생략(무변경 revision 잡음 방지)하고 서브-eps
      // 프리뷰 잔재만 모델 값으로 되돌린다.
      this.opts.restore();
      return;
    }
    void this.opts
      .dispatch({ type: "resizeSplit", split: this.opts.splitId, ratio })
      .then((out) => {
        // 실패(스테일 id 등)는 dispatchUI 가 상태 라인에 표면화했다 — 여기서는
        // 프리뷰가 모델과 어긋난 상태만 최신 스냅샷으로 복원한다.
        if (out === null) this.opts.restore();
      });
  }

  private onPointerCancel(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.lastRatio = null;
    this.startRatio = null;
    this.opts.guard.end(this.opts.splitId);
    this.opts.restore(); // 적용된 프리뷰 잔재를 모델 값으로 되돌린다
  }

  /** 재구축 시 호출 — 진행 중 드래그가 있으면 가드만 정리한다. 핸들 DOM 은
   *  컨테이너 교체로 함께 버려지고, 이후 캡처 이벤트는 dragging=false 로 무시된다. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.dragging) {
      this.dragging = false;
      this.opts.guard.end(this.opts.splitId);
    }
  }
}
