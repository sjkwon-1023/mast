// 상태 스토어 — get_state 부트스트랩 + state-changed 구독 (10단계 계획 2장).
// 상태 소유자는 Rust dispatcher 이고 프론트는 뷰다: 여기서는 스냅샷을 보관·중계만
// 하며, stale 스냅샷은 revision 가드로 폐기한다.

import { getState, onStateChanged } from "./backend";
import type { StateSnapshot } from "./types";

/** revision 가드 순수 함수 (vitest 대상) — 스냅샷 채택 여부.
 *  current 가 null(첫 스냅샷)이면 무조건 채택, 이후는 revision 이 커질 때만.
 *  같은 revision 재수신도 폐기한다 (내용 동일 — 렌더 중복 방지). */
export function shouldAdopt(current: number | null, incoming: number): boolean {
  return current === null || incoming > current;
}

export type StoreListener = (snapshot: StateSnapshot) => void;

export class Store {
  private current: StateSnapshot | null = null;
  private readonly listeners = new Set<StoreListener>();

  /** 마지막으로 채택된 스냅샷. init 전에는 null. */
  get snapshot(): StateSnapshot | null {
    return this.current;
  }

  /** 구독 등록 — 해제 함수를 돌려준다. 등록 시점에 이미 스냅샷이 있으면
   *  즉시 1회 통지해 늦은 구독자도 현재 상태를 받게 한다. */
  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    if (this.current !== null) listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 부트스트랩: **구독 먼저 → get_state 나중** — 이 순서라야 구독 등록과
   *  get_state 사이의 변이가 유실되지 않는다. 이벤트가 get_state 응답보다
   *  먼저(또는 나중에 stale 로) 도착해도 revision 가드가 정리한다. */
  async init(): Promise<void> {
    await onStateChanged((snapshot) => this.offer(snapshot));
    this.offer(await getState());
  }

  /** 스냅샷 후보 반영 — revision 이 현재보다 낮거나 같으면 폐기.
   *  (테스트에서 backend 없이 직접 주입할 수 있게 public.) */
  offer(snapshot: StateSnapshot): void {
    if (!shouldAdopt(this.current?.revision ?? null, snapshot.revision)) return;
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
