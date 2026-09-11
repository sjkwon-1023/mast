// ActivityPing throttle 의 계약 테스트 (계획 C-3) — 10초 창당 1회 + visibility
// 즉시 통과. DOM 무의존 (시각은 인자로 주입).

import { describe, expect, it, vi } from "vitest";

import { ActivityPing } from "./activity-ping";

describe("ActivityPing", () => {
  it("첫 활동은 즉시 전송하고, 침묵 창(10초) 안의 반복은 1회로 묶인다", () => {
    const send = vi.fn();
    const ping = new ActivityPing(send);
    ping.activity(0);
    ping.activity(1);
    ping.activity(9_999);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(null);
    // 경계값: 창 길이 도달 시점부터 다시 통과.
    ping.activity(10_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("연속 사용 중에는 창마다 정확히 1회 나간다 (핑 자체가 스팸이 되지 않는다)", () => {
    const send = vi.fn();
    const ping = new ActivityPing(send);
    // 30초 동안 1초 간격 스크롤 → 0s/10s/20s/30s 의 4회만.
    for (let t = 0; t <= 30_000; t += 1_000) ping.activity(t);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("visibility 전이는 침묵 창 안에서도 즉시 통과하고 visible 값을 실어 보낸다", () => {
    const send = vi.fn();
    const ping = new ActivityPing(send);
    ping.activity(0);
    ping.visibility(false, 100);
    ping.visibility(true, 200);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls).toEqual([[null], [false], [true]]);
  });

  it("visibility 전송은 침묵 창을 건드리지 않는다 (활동이 아님 — 버그 4·5 수정)", () => {
    const send = vi.fn();
    const ping = new ActivityPing(send);
    ping.visibility(true, 5_000);
    // visibility 는 백엔드에서 활동으로 치지 않으므로, 직후의 실제 활동 핑은
    // 억제되면 안 된다 (재무장이 늦으면 안 됨).
    ping.activity(5_100);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, true);
    expect(send).toHaveBeenNthCalledWith(2, null);
  });

  it("windowMs 를 좁히면 그 주기로 통과한다", () => {
    const send = vi.fn();
    const ping = new ActivityPing(send, 1_000);
    ping.activity(0);
    ping.activity(999);
    ping.activity(1_000);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
