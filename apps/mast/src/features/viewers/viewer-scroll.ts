import type { TimerHost } from "../terminal/ack-batcher";

export const SCROLL_SETTLE_MS = 500;

export const defaultTimers: TimerHost = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

// 최초 마운트·경로 변경에서만 복원해 스냅샷 왕복의 스크롤 에코를 막는다.
export function shouldAdoptScroll(
  current: { path: string } | null,
  nextPath: string,
): boolean {
  return current === null || current.path !== nextPath;
}

// 위치 단위는 호출자가 정한다: text는 byte offset, markdown은 px.
export class ScrollSettle {
  private pending: number | null = null;
  private handle: unknown = null;

  private synced: number | null = null;

  constructor(
    private readonly send: (offset: number) => void,
    private readonly settleMs: number = SCROLL_SETTLE_MS,
    private readonly timers: TimerHost = defaultTimers,
  ) {}

  markSynced(offset: number | null): void {
    this.clearTimer();
    this.pending = null;
    this.synced = offset;
  }

  observe(offset: number): void {
    this.clearTimer();
    if (offset === this.synced) {
      this.pending = null;
      return;
    }
    this.pending = offset;
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      this.flush();
    }, this.settleMs);
  }

  flush(): void {
    this.clearTimer();
    const offset = this.pending;
    this.pending = null;
    if (offset === null || offset === this.synced) return;
    this.synced = offset;
    this.send(offset);
  }

  // dispose는 배출하지 않는다. 모델에 탭이 남아 있을 때 호출자가 먼저 flush한다.
  dispose(): void {
    this.clearTimer();
    this.pending = null;
  }

  private clearTimer(): void {
    if (this.handle === null) return;
    this.timers.clearTimeout(this.handle);
    this.handle = null;
  }
}
