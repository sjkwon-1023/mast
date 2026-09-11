// flow control ack 배칭 (spike-plan.md 4.6) — term.write 완료 콜백에서 소비 바이트를
// 집계해, 64KB 도달 시 즉시 또는 첫 미배출 바이트로부터 50ms 경과 시 flush 콜백을
// 호출한다. 타이머를 주입할 수 있게 해 fake timer로 결정적 테스트가 가능하다.

/** 타이머 주입 지점 — 테스트에서 fake 구현으로 대체한다. */
export interface TimerHost {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TimerHost = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

export const DEFAULT_ACK_THRESHOLD_BYTES = 64 * 1024;
export const DEFAULT_ACK_MAX_DELAY_MS = 50;

export interface AckBatcherOptions {
  /** 이 바이트 수에 도달하면 즉시 flush. 기본 64KB. */
  thresholdBytes?: number;
  /** 첫 미배출 바이트로부터 이 시간이 지나면 flush. 기본 50ms. */
  maxDelayMs?: number;
  /** 타이머 구현. 기본은 전역 setTimeout/clearTimeout. */
  timers?: TimerHost;
}

export class AckBatcher {
  private readonly thresholdBytes: number;
  private readonly maxDelayMs: number;
  private readonly timers: TimerHost;
  private accumulated = 0;
  private timerHandle: unknown = null;
  private disposed = false;

  constructor(
    private readonly onFlush: (bytes: number) => void,
    options: AckBatcherOptions = {},
  ) {
    this.thresholdBytes = options.thresholdBytes ?? DEFAULT_ACK_THRESHOLD_BYTES;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_ACK_MAX_DELAY_MS;
    this.timers = options.timers ?? defaultTimers;
    if (this.thresholdBytes <= 0) throw new Error("thresholdBytes must be positive");
    if (this.maxDelayMs < 0) throw new Error("maxDelayMs must be non-negative");
  }

  /** 소비 완료 바이트를 집계한다. 0 이하는 무시(빈 write 콜백 대응).
   *  dispose 이후의 호출은 정의된 no-op — 세션 정리 뒤 늦게 도착한 write 콜백을 수용한다. */
  add(bytes: number): void {
    if (this.disposed || bytes <= 0) return;
    this.accumulated += bytes;
    if (this.accumulated >= this.thresholdBytes) {
      this.flush();
      return;
    }
    // 타이머는 첫 미배출 바이트에서 한 번만 걸고, 이후 add로 연장하지 않는다 —
    // ack 지연 상한을 maxDelayMs로 보장하기 위해서다.
    if (this.timerHandle === null) {
      this.timerHandle = this.timers.setTimeout(() => {
        this.timerHandle = null;
        this.flush();
      }, this.maxDelayMs);
    }
  }

  /** 집계분을 즉시 배출한다. 집계가 0이면 콜백을 호출하지 않는다. */
  flush(): void {
    this.cancelTimer();
    if (this.accumulated === 0) return;
    const n = this.accumulated;
    this.accumulated = 0;
    this.onFlush(n);
  }

  /** 남은 집계분을 배출하고 타이머를 정리한다. 이후 add는 no-op. */
  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
  }

  /** 테스트·디버깅용 — 아직 배출되지 않은 집계 바이트. */
  get pendingBytes(): number {
    return this.accumulated;
  }

  private cancelTimer(): void {
    if (this.timerHandle !== null) {
      this.timers.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }
}
