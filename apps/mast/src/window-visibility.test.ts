// 창 숨김 신호 상태기계 검증 (체크포인트 2 실기 결함 후속).
//
// 실기 결함의 핵심은 "신호가 아예 오지 않는 것"이라 글루 쪽 판정(0x0 Resized =
// 최소화)은 Windows 실기 확인 항목이다. 여기서 잠그는 것은 그 신호가 도착한
// **뒤**의 프론트 계약이다: ① 구독을 한 번만 설치하는가, ② 플래그가 신호대로
// 움직이는가, ③ 전이일 때만 통지하는가(중복 emit 에 뷰가 두 번 깨지 않는다),
// ④ 해제 함수가 실제로 구독을 끊는가(뷰 dispose 후 누수 금지).
//
// listen 을 주입해 Tauri IPC 없이 순수하게 돌린다 (DOM 도 쓰지 않는다).

import { describe, expect, it } from "vitest";

import { WindowVisibility } from "./window-visibility";

/** 주입 listen — 설치 횟수를 세고, 등록된 handler 를 emit 으로 직접 발화시킨다. */
class FakeListen {
  installs = 0;
  unlistens = 0;
  private handler: ((hidden: boolean) => void) | null = null;

  readonly listen = (handler: (hidden: boolean) => void): Promise<() => void> => {
    this.installs += 1;
    this.handler = handler;
    return Promise.resolve(() => {
      this.unlistens += 1;
    });
  };

  /** 글루 emit 1회. 설치 전이면 결함이므로 조용히 넘기지 않는다. */
  emit(hidden: boolean): void {
    if (this.handler === null) throw new Error("emit before listen was installed");
    this.handler(hidden);
  }
}

interface Harness {
  vis: WindowVisibility;
  fake: FakeListen;
}

function make(): Harness {
  const fake = new FakeListen();
  return { vis: new WindowVisibility(fake.listen), fake };
}

describe("WindowVisibility", () => {
  it("starts visible before any signal arrives", () => {
    const { vis } = make();
    expect(vis.isHidden).toBe(false);
  });

  it("installs the event subscription exactly once across repeated init", async () => {
    const { vis, fake } = make();
    await vis.init();
    await vis.init();
    await vis.init();
    expect(fake.installs).toBe(1);
  });

  it("installs once even when two init calls overlap", async () => {
    const { vis, fake } = make();
    await Promise.all([vis.init(), vis.init()]);
    expect(fake.installs).toBe(1);
  });

  it("tracks the flag from backend signals", async () => {
    const { vis, fake } = make();
    await vis.init();

    fake.emit(true);
    expect(vis.isHidden).toBe(true);

    fake.emit(false);
    expect(vis.isHidden).toBe(false);
  });

  it("notifies subscribers only on transitions", async () => {
    const { vis, fake } = make();
    await vis.init();
    const seen: boolean[] = [];
    vis.subscribe((hidden) => seen.push(hidden));

    fake.emit(true);
    fake.emit(true); // 중복 emit 은 통지하지 않는다 (뷰가 두 번 깨지 않게)
    fake.emit(false);
    fake.emit(false);
    expect(seen).toEqual([true, false]);
  });

  it("notifies every subscriber", async () => {
    const { vis, fake } = make();
    await vis.init();
    const a: boolean[] = [];
    const b: boolean[] = [];
    vis.subscribe((hidden) => a.push(hidden));
    vis.subscribe((hidden) => b.push(hidden));

    fake.emit(true);
    expect(a).toEqual([true]);
    expect(b).toEqual([true]);
  });

  it("stops notifying after unsubscribe (no leak past a view's dispose)", async () => {
    const { vis, fake } = make();
    await vis.init();
    const seen: boolean[] = [];
    const unsubscribe = vis.subscribe((hidden) => seen.push(hidden));

    fake.emit(true);
    unsubscribe();
    fake.emit(false);
    fake.emit(true);
    expect(seen).toEqual([true]);
    // 해제 뒤에도 플래그 자체는 계속 갱신된다 — 다음 뷰가 조회하면 현재 상태다.
    expect(vis.isHidden).toBe(true);
  });

  it("ignores a repeated unsubscribe (dispose is idempotent at the caller)", async () => {
    const { vis, fake } = make();
    await vis.init();
    const seen: boolean[] = [];
    const unsubscribe = vis.subscribe((hidden) => seen.push(hidden));
    unsubscribe();
    unsubscribe();

    fake.emit(true);
    expect(seen).toEqual([]);
  });

  it("gives a late subscriber the following transitions, not a replay", async () => {
    const { vis, fake } = make();
    await vis.init();
    fake.emit(true);

    const seen: boolean[] = [];
    vis.subscribe((hidden) => seen.push(hidden));
    expect(seen).toEqual([]); // 현재 상태는 isHidden 으로 읽는다
    expect(vis.isHidden).toBe(true);

    fake.emit(false);
    expect(seen).toEqual([false]);
  });
});
