// 상태 소유자는 Rust dispatcher 이고 프론트는 뷰다: 여기서는 스냅샷을 보관·중계만
// 하며, stale 스냅샷은 revision 가드로 폐기한다 (10단계 계획 2장).

import { getState, onStateChanged } from "./backend";
import type { StateSnapshot } from "./types";

/** 같은 revision 재수신도 폐기한다 (내용 동일 — 렌더 중복 방지). (vitest 대상) */
export function shouldAdopt(current: number | null, incoming: number): boolean {
  return current === null || incoming > current;
}

export type StoreListener = (snapshot: StateSnapshot) => void;

export class Store {
  private current: StateSnapshot | null = null;
  private readonly listeners = new Set<StoreListener>();

  /** init 전에는 null. */
  get snapshot(): StateSnapshot | null {
    return this.current;
  }

  /** 등록 시점에 이미 스냅샷이 있으면 즉시 1회 통지해 늦은 구독자도
   *  현재 상태를 받게 한다. */
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

  /** 테스트에서 backend 없이 직접 주입할 수 있게 public. */
  offer(snapshot: StateSnapshot): void {
    if (!shouldAdopt(this.current?.revision ?? null, snapshot.revision)) return;
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
