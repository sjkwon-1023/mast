// 순수 레이아웃 계산 모듈 (DOM-free — vitest 대상, 11단계 청크 B).
//
// 방향 규약: SplitDirection 은 pane 이 **나열되는 축**이다 —
// "horizontal" = 가로 나열(좌|우, CSS flex-direction: row),
// "vertical"   = 세로 나열(상/하, CSS flex-direction: column).
// 코어 model.rs SplitTree::split rustdoc 의 "first(좌/상), second(우/하)" 와
// 일치한다. workspace-view·splitter·styles.css 가 전부 이 규약을 따른다.

import type { SplitDirection, SplitTree } from "./types";

/** DOMRect 의 구조적 부분집합 — jsdom 없이 테스트하기 위한 최소 형태.
 *  실코드에서는 getBoundingClientRect() 결과를 그대로 넘기면 된다. */
export interface LayoutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 포인터 위치 (clientX/clientY). 축 선택은 direction 이 담당한다. */
export interface PointerPos {
  x: number;
  y: number;
}

/** ratio 개구간 (0, 1) 보장용 최소 여유. 모델이 0·1 을 loud-fail 하므로
 *  (CommandError::InvalidRatio — 계획 D2) UI 는 어떤 입력이 와도 이 폭만큼
 *  안쪽으로 클램프해 dispatch 가 절대 경계값을 보내지 않게 한다. */
export const OPEN_INTERVAL_EPS = 0.001;

/** split tree 의 **구조** 동일성 키 — leaf pane id·split id·direction 시퀀스를
 *  문자열로 직렬화한다. ratio 는 의도적으로 제외한다: ratio 만 바뀐 스냅샷은
 *  재구축 없이 in-place flex 갱신 대상이기 때문이다 (workspace-view 참조).
 *  형식 예: leaf → "L2", split → "S10h(L1,L2)" (h/v = direction). */
export function structureKey(tree: SplitTree): string {
  if (tree.type === "leaf") return `L${tree.pane}`;
  const dir = tree.direction === "horizontal" ? "h" : "v";
  return `S${tree.id}${dir}(${structureKey(tree.first)},${structureKey(tree.second)})`;
}

/** 포인터 위치 → split ratio (first 비율). 결과는 항상 finite 하고 개구간
 *  (0, 1) 안이다 — 모델 검증(InvalidRatio)을 UI 픽셀 클램프가 분담한다 (D2).
 *
 *  - direction 축의 rect 시작~크기로 비율을 내고,
 *  - 양쪽 pane 이 minPanePx 미만이 되지 않게 [min/span, 1 - min/span] 으로
 *    클램프하되, 그 범위가 개구간을 벗어나면 OPEN_INTERVAL_EPS 로 좁힌다.
 *  - minPanePx 가 rect 절반을 넘어 양쪽 최소를 동시에 만족할 수 없으면 0.5.
 *  - rect 크기가 0 이하이거나 입력이 비유한(NaN 등)이면 0.5 (안전 기본값).
 *
 *  주: 핸들 두께(4px)는 무시하는 근사다 — 프리뷰와 pointerup dispatch 가 같은
 *  값을 쓰므로 일관되고, 오차는 핸들 폭 이내다. */
export function ratioFromPointer(
  rect: LayoutRect,
  pointer: PointerPos,
  direction: SplitDirection,
  minPanePx: number,
): number {
  const horizontal = direction === "horizontal";
  const span = horizontal ? rect.width : rect.height;
  if (!Number.isFinite(span) || span <= 0) return 0.5;

  const pos = horizontal ? pointer.x - rect.left : pointer.y - rect.top;
  const raw = pos / span;
  if (!Number.isFinite(raw)) return 0.5;

  const lo = Math.max(minPanePx / span, OPEN_INTERVAL_EPS);
  const hi = Math.min(1 - minPanePx / span, 1 - OPEN_INTERVAL_EPS);
  if (lo > hi) return 0.5; // minPanePx > span/2 — 성립 불가, 중앙으로
  return Math.min(Math.max(raw, lo), hi);
}

/** ratio → 양쪽 자식의 flex-grow 쌍. flex-basis 0 과 조합하면 (핸들을 제외한)
 *  가용 공간이 first:second = ratio:(1-ratio) 로 나뉜다. */
export function flexPair(ratio: number): { first: number; second: number } {
  return { first: ratio, second: 1 - ratio };
}
