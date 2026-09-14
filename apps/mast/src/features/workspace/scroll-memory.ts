// 워크스페이스를 떠난 터미널 탭의 스크롤 위치 기억 (ADR-0019 결정 3) — DOM·IPC
// 무의존이라 vitest 가 정책을 잠근다. 소유자는 workspace-view 의 리컨실이고,
// 값은 TerminalView 가 dispose 직전에 읽어 준 "하단으로부터의 줄 수"다.
//
// 수명은 WebView 한정이다 — F5·자동 리로드는 이 객체째로 사라지고, 그것이
// "같은 WebView 수명"의 경계다 (ADR-0019).

import type { TabId } from "../../shared/types";

export class ScrollMemory {
  private readonly offsets = new Map<TabId, number>();

  /** 워크스페이스 이탈로 dispose 되는 탭의 위치를 남긴다. 닫힌 탭은 돌아올
   *  자리가 없으므로 호출자가 걸러서 부른다 (실존 판정은 스냅샷의 몫). */
  remember(tab: TabId, offset: number): void {
    this.offsets.set(tab, offset);
  }

  /** 1회성 인출 — 꺼내는 즉시 지운다. 복원이 취소되거나 attach 가 실패해도 낡은
   *  위치가 다음 attach 에 다시 적용되지 않게 하는 것이 이 일회성의 이유다. */
  take(tab: TabId): number | undefined {
    const offset = this.offsets.get(tab);
    this.offsets.delete(tab);
    return offset;
  }

  /** 스냅샷에 없는 탭의 기억을 걷는다. 비활성 워크스페이스에서 닫힌 탭은 dispose
   *  루프를 타지 않아 여기서만 정리된다 — 그 경로가 없으면 기억이 샌다. */
  prune(existing: Set<TabId>): void {
    for (const tab of this.offsets.keys()) {
      if (!existing.has(tab)) this.offsets.delete(tab);
    }
  }
}
