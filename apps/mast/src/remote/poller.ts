// 폴링 스케줄 — 이 표면에는 스트리밍이 없으므로 "언제 다시 물어보나"가 전부다.
// 타이머 말고는 I/O 가 없다: 실제 요청은 주입된 `poll` 이 한다.
//
// 규율이 네 가지다.
//
// - **가시성 게이트**: 화면이 가려져 있으면 아예 쏘지 않는다. 폰 브라우저는 탭을
//   백그라운드로 두면 타이머를 조이거나 멈추므로, 게이트가 없으면 복귀 순간에
//   밀린 타이머가 한꺼번에 터진다.
// - **중복 발사 금지**: 앞 요청이 정착하기 전에는 다음을 쏘지 않는다. 응답 순서가
//   보장되지 않는 별개 커넥션이라, 겹쳐 쏘면 늦게 온 옛 응답이 새 offset 을
//   덮어쓴다.
// - **세대(generation)**: 탭 전환·인스턴스 재생성이 일어나면 그 전에 나간 요청의
//   응답은 지금 화면과 무관하다. 취소할 방법이 없으므로 세대를 올려 두고 도착한
//   쪽이 스스로 폐기한다.
// - **실패의 두 종류**: 401 은 토큰이 더는 유효하지 않다는 뜻이라 계속 두드려도
//   달라지지 않는다 — 영구 정지다. 429 는 rate limit 창이라 60초 뒤에 다시
//   해 볼 수 있다.

/** 서버 rate limit 창과 같은 길이 (ADR-0016 결정 4). */
export const RATE_LIMIT_PAUSE_MS = 60_000;

/** 폴링이 멈춘 이유 — 화면에 안내를 띄우는 쪽이 쓴다. */
export type HaltReason = "unauthorized" | "rateLimited";

export interface PollScheduleOptions {
  intervalMs: number;
  /** 한 번의 폴. 정착(성공·실패 무관)해야 다음이 예약된다. 인자는 이 요청이
   *  나간 시점의 세대로, 호출자가 응답을 적용하기 전에 `isCurrent` 로 확인한다. */
  poll: (generation: number) => Promise<void>;
  /** 정지·일시정지 알림. 같은 사유로 반복 호출될 수 있다. */
  onHalt?: (reason: HaltReason) => void;
}

export class PollSchedule {
  private readonly intervalMs: number;
  private readonly pollFn: (generation: number) => Promise<void>;
  private readonly onHalt: ((reason: HaltReason) => void) | undefined;

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 429 해제 타이머 — 폴 타이머와 따로 둔다. 같은 자리에 두면 폴 쪽의
   *  재무장이 해제 예약을 지워 영영 깨어나지 못한다. */
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  /** `pollNow` 가 인-플라이트 구간에 걸렸다 — 정착하는 대로 대기 없이 한 번 더. */
  private pollAgain = false;
  private visible = true;
  private running = false;
  private dead = false;
  private paused = false;
  private generationValue = 0;

  constructor(options: PollScheduleOptions) {
    this.intervalMs = options.intervalMs;
    this.pollFn = options.poll;
    this.onHalt = options.onHalt;
  }

  /** 지금 유효한 세대. 요청을 쏘기 직전에 캡처한다. */
  get generation(): number {
    return this.generationValue;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generationValue;
  }

  /** 화면이 갈렸다 — 이전 세대의 응답과 콜백은 전부 무효다. */
  bumpGeneration(): number {
    this.generationValue += 1;
    return this.generationValue;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fire();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.clearPauseTimer();
  }

  /** 간격을 기다리지 말고 지금 한 번 — 입력을 보낸 직후처럼 화면이 방금 바뀐 것이
   *  확실할 때 쓴다. 겹침 금지는 그대로라, 폴이 나가 있는 중이면 그 응답이 정착한
   *  뒤로 미룬다. 세대는 건드리지 않는다 — 보고 있는 화면은 그대로다. */
  pollNow(): void {
    if (!this.canRun()) return;
    if (this.inFlight) {
      this.pollAgain = true;
      return;
    }
    this.fire();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.fire();
    else this.clearTimer();
  }

  /** 응답 하나의 HTTP 상태. 401·429 만 스케줄을 바꾼다. */
  noteStatus(status: number): void {
    if (status === 401) {
      this.dead = true;
      this.stop();
      this.onHalt?.("unauthorized");
      return;
    }
    if (status === 429) {
      this.paused = true;
      this.clearTimer();
      this.clearPauseTimer();
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = null;
        this.paused = false;
        this.fire();
      }, RATE_LIMIT_PAUSE_MS);
      this.onHalt?.("rateLimited");
    }
  }

  private canRun(): boolean {
    return this.running && this.visible && !this.dead && !this.paused;
  }

  private fire(): void {
    if (!this.canRun() || this.inFlight) return;
    this.clearTimer();
    this.inFlight = true;
    const generation = this.generationValue;
    void this.pollFn(generation)
      // 네트워크 오류는 다음 틱에 다시 해 본다 — 스케줄을 죽이지 않는다.
      .catch(() => undefined)
      .then(() => {
        this.inFlight = false;
        const immediate = this.pollAgain;
        this.pollAgain = false;
        if (immediate) this.fire();
        else this.arm();
      });
  }

  private arm(): void {
    this.clearTimer();
    if (!this.canRun()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire();
    }, this.intervalMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer === null) return;
    clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }
}
