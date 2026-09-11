// 활동 핑 throttle (16단계 C-3) — 자동 리셋의 "실제 사용자 활동" 신호를 백엔드
// user_activity 커맨드로 보내되, wheel/mousedown/keydown 마다 invoke 하지 않도록
// 침묵 창(기본 10초)당 1회로 묶는다. DOM 무의존 순수 로직 (vitest 대상) — DOM
// 리스너 배선은 main.ts 몫이다.
//
// 이 핑이 있어야 순수 열람(입력 없이 스크롤백 wheel 만)이 idle 로 오인되지
// 않는다 (계획 0장 — "활성 사용 중 절대 리셋 금지"). visibility 변화(보조 신호)
// 는 침묵 창과 무관하게 즉시 통과한다 — hidden 카운트다운의 시작/종료 전이는
// 지연 없이 정책에 도달해야 한다. visibility 전송은 백엔드에서 **활동으로 치지
// 않으므로**(체크포인트 1 버그 4·5 수정 — 최소화 보고가 hidden 을 재무장하거나
// 리로드 동기화가 idle 을 재무장하면 안 된다) 침묵 창을 건드리지 않는다.

/** 백엔드 전송 콜백 — `visible` 은 visibilitychange 보조 신호, 활동 핑은 null. */
export type ActivitySender = (visible: boolean | null) => void;

export class ActivityPing {
  /** 마지막 전송 시각(ms). 아직 한 번도 안 보냈으면 null (첫 신호는 즉시 통과). */
  private lastSentAt: number | null = null;

  constructor(
    private readonly send: ActivitySender,
    private readonly windowMs: number = 10_000,
  ) {}

  /** 사용자 입력 신호 (wheel/mousedown/keydown). 침묵 창 안이면 무시한다.
   *  `now` 는 단조 시계 ms (performance.now()). */
  activity(now: number): void {
    if (this.lastSentAt !== null && now - this.lastSentAt < this.windowMs) return;
    this.lastSentAt = now;
    this.send(null);
  }

  /** visibility 전이 — throttle 우회 즉시 전송 (visible 값 동봉). 침묵 창은
   *  건드리지 않는다 — visibility 는 활동이 아니므로, 직후의 실제 제스처 핑이
   *  억제되면 재무장이 최대 10초 늦는다. */
  visibility(visible: boolean, _now: number): void {
    this.send(visible);
  }
}
