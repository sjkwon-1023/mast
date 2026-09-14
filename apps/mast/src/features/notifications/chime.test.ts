// WebAudio 는 node 환경에 없으므로 가짜 컨텍스트를 주입해 스케줄된 음의 개수·주파수·
// 길이를 그대로 관찰한다.
//
// 차임 재생 경로는 v0.3.7 에서 배선이 빠진 휴면 코드의 테스트다 — 지우지 않고 남겨 되살릴 때
// 검증을 다시 짜지 않게 한다 (features/notifications/chime.ts 모듈 머리 주석의 dormant 계약).

import { describe, expect, it, vi } from "vitest";

import {
  Chime,
  detectNeedsInputOnset,
  installChimeUnlock,
  needsInputToasts,
  needsInputToastTargets,
} from "./chime";
import type { OnsetTab, OnsetWorkspace, TabOnset } from "./chime";
import snapshotFixtureJson from "../../../../../fixtures/stage10-snapshot.json";
import type { AgentStatus, StateSnapshot, TabId, WorkspaceId } from "../../shared/types";

function statuses(entries: [TabId, AgentStatus][]): Map<TabId, AgentStatus> {
  return new Map(entries);
}

function tab(
  id: TabId,
  agentStatus: AgentStatus,
  lastAgentMessage: string | null = null,
): OnsetTab {
  return { id, title: `tab ${id}`, agentStatus, lastAgentMessage };
}

function ws(id: WorkspaceId, ...panes: OnsetTab[][]): OnsetWorkspace {
  const record: Record<string, { tabs: OnsetTab[] }> = {};
  panes.forEach((tabs, i) => {
    record[String(id * 10 + i)] = { tabs };
  });
  return { id, name: `ws ${id}`, panes: record };
}

function onset(workspaceId: WorkspaceId, tabId: TabId): TabOnset {
  return { workspaceId, tabId };
}

describe("detectNeedsInputOnset", () => {
  it("부팅 첫 스냅샷(prev=null)은 기준선으로만 쓰고 알리지 않는다", () => {
    // WebView 리로드 직후처럼 살아 있는 needsInput 이 첫 스냅샷에 실려 와도 조용하다.
    const out = detectNeedsInputOnset(null, [
      ws(1, [tab(11, "needsInput"), tab(12, "running")]),
      ws(2, [tab(21, "idle")]),
    ]);
    expect(out.onsets).toEqual([]);
    expect(out.next).toEqual(statuses([[11, "needsInput"], [12, "running"], [21, "idle"]]));
  });

  it("리로드 기준선 뒤에도 이미 기다리던 탭은 조용하고, 새로 기다리기 시작한 탭만 알린다", () => {
    const baseline = detectNeedsInputOnset(null, [
      ws(1, [tab(11, "needsInput"), tab(12, "running")]),
    ]);
    const same = detectNeedsInputOnset(baseline.next, [
      ws(1, [tab(11, "needsInput"), tab(12, "running")]),
    ]);
    expect(same.onsets).toEqual([]);
    const second = detectNeedsInputOnset(same.next, [
      ws(1, [tab(11, "needsInput"), tab(12, "needsInput")]),
    ]);
    expect(second.onsets).toEqual([onset(1, 12)]);
  });

  it("idle·running → needsInput 은 onset 이다", () => {
    const fromIdle = detectNeedsInputOnset(statuses([[11, "idle"]]), [
      ws(1, [tab(11, "needsInput")]),
    ]);
    expect(fromIdle.onsets).toEqual([onset(1, 11)]);
    const fromRunning = detectNeedsInputOnset(statuses([[11, "running"]]), [
      ws(1, [tab(11, "needsInput")]),
    ]);
    expect(fromRunning.onsets).toEqual([onset(1, 11)]);
  });

  it("같은 needsInput 이 유지되는 재렌더는 onset 이 아니다", () => {
    const out = detectNeedsInputOnset(statuses([[11, "needsInput"]]), [
      ws(1, [tab(11, "needsInput")]),
    ]);
    expect(out.onsets).toEqual([]);
  });

  it("needsInput 이 아닌 쪽으로 가는 전환은 전부 onset 이 아니다", () => {
    const toIdle = detectNeedsInputOnset(statuses([[11, "needsInput"]]), [ws(1, [tab(11, "idle")])]);
    const toRunning = detectNeedsInputOnset(statuses([[11, "idle"]]), [ws(1, [tab(11, "running")])]);
    expect(toIdle.onsets).toEqual([]);
    expect(toRunning.onsets).toEqual([]);
  });

  // 워크스페이스 파생 상태는 이미 needsInput 이라 변하지 않는다 — 탭 단위로 봐야 보이는 전이다.
  it("이미 needsInput 인 워크스페이스의 두 번째 탭이 기다리기 시작하면 그 탭이 onset 이다", () => {
    const prev = statuses([[11, "needsInput"], [12, "running"]]);
    const out = detectNeedsInputOnset(prev, [
      ws(1, [tab(11, "needsInput")], [tab(12, "needsInput")]),
    ]);
    expect(out.onsets).toEqual([onset(1, 12)]);
  });

  it("같은 워크스페이스의 두 탭이 함께 전이하면 둘 다 담긴다", () => {
    const prev = statuses([[11, "running"], [12, "idle"]]);
    const out = detectNeedsInputOnset(prev, [ws(1, [tab(11, "needsInput"), tab(12, "needsInput")])]);
    expect(out.onsets).toEqual([onset(1, 11), onset(1, 12)]);
  });

  it("여러 워크스페이스가 함께 전이하면 워크스페이스·pane·탭 순서대로 담긴다", () => {
    const prev = statuses([[11, "running"], [12, "idle"], [21, "idle"], [31, "idle"]]);
    const out = detectNeedsInputOnset(prev, [
      ws(2, [tab(21, "needsInput")]),
      ws(1, [tab(11, "needsInput")], [tab(12, "needsInput")]),
      ws(3, [tab(31, "running")]),
    ]);
    expect(out.onsets).toEqual([onset(2, 21), onset(1, 11), onset(1, 12)]);
  });

  it("신규 탭의 첫 상태가 needsInput 이면 onset 이다 (다른 첫 상태는 아니다)", () => {
    const prev = statuses([[11, "idle"]]);
    const added = detectNeedsInputOnset(prev, [ws(1, [tab(11, "idle"), tab(12, "needsInput")])]);
    expect(added.onsets).toEqual([onset(1, 12)]);
    const addedRunning = detectNeedsInputOnset(prev, [ws(1, [tab(11, "idle"), tab(12, "running")])]);
    expect(addedRunning.onsets).toEqual([]);
  });

  it("사라진 탭은 기준선에서 빠지고, 같은 id 가 다시 나타나면 신규로 취급된다", () => {
    const closed = detectNeedsInputOnset(statuses([[11, "needsInput"], [12, "idle"]]), [
      ws(1, [tab(12, "idle")]),
    ]);
    expect(closed.onsets).toEqual([]);
    expect(closed.next).toEqual(statuses([[12, "idle"]]));
    const reappeared = detectNeedsInputOnset(closed.next, [
      ws(1, [tab(11, "needsInput"), tab(12, "idle")]),
    ]);
    expect(reappeared.onsets).toEqual([onset(1, 11)]);
  });

  it("needsInput 에서 벗어났다가 다시 들어오면 다시 onset 이다", () => {
    const left = detectNeedsInputOnset(statuses([[11, "needsInput"]]), [
      ws(1, [tab(11, "running")]),
    ]);
    expect(left.onsets).toEqual([]);
    const reentered = detectNeedsInputOnset(left.next, [ws(1, [tab(11, "needsInput")])]);
    expect(reentered.onsets).toEqual([onset(1, 11)]);
  });

  it("워크스페이스가 하나도 없으면 onset 이 없고 기준선은 빈 맵이다", () => {
    const out = detectNeedsInputOnset(statuses([[11, "needsInput"]]), []);
    expect(out.onsets).toEqual([]);
    expect(out.next.size).toBe(0);
  });

  it("결과에는 onsets·next 만 있다 (v0.3.7 계약 변경 — chime 파생 필드 제거)", () => {
    const out = detectNeedsInputOnset(statuses([[11, "idle"]]), [ws(1, [tab(11, "needsInput")])]);
    expect(Object.keys(out).sort()).toEqual(["next", "onsets"]);
  });

  it("실제 스냅샷 fixture 의 모든 pane·탭을 훑는다", () => {
    const snapshot = snapshotFixtureJson as unknown as StateSnapshot;
    const allIdle = new Map<TabId, AgentStatus>();
    for (const w of snapshot.state.workspaces) {
      for (const p of Object.values(w.panes)) for (const t of p.tabs) allIdle.set(t.id, "idle");
    }
    const out = detectNeedsInputOnset(allIdle, snapshot.state.workspaces);
    expect(out.onsets).toEqual([onset(10, 15)]);
    const byId = (a: TabId, b: TabId): number => a - b;
    expect([...out.next.keys()].sort(byId)).toEqual([...allIdle.keys()].sort(byId));
  });
});

describe("needsInputToastTargets", () => {
  it("포커스 중인 창의 활성 워크스페이스는 어느 탭이든 조용하다", () => {
    // 사용자가 지금 그 화면을 보고 있다 — 가려진 탭은 탭·pane 배지가 말한다.
    expect(needsInputToastTargets([onset(7, 71), onset(7, 72)], 7, true)).toEqual([]);
  });

  it("포커스 중이라도 비활성 워크스페이스는 알린다", () => {
    // v0.3.6 까지 놓치던 경우: 창은 보고 있지만 그 워크스페이스는 화면에 없다.
    expect(needsInputToastTargets([onset(8, 81)], 7, true)).toEqual([onset(8, 81)]);
  });

  it("비포커스면 활성 워크스페이스라도 알린다", () => {
    expect(needsInputToastTargets([onset(7, 71)], 7, false)).toEqual([onset(7, 71)]);
    expect(needsInputToastTargets([onset(8, 81)], 7, false)).toEqual([onset(8, 81)]);
  });

  it("여러 전이 중 활성 워크스페이스의 것만 빠지고 순서는 유지된다", () => {
    const onsets = [onset(5, 51), onset(7, 71), onset(9, 91), onset(7, 72)];
    expect(needsInputToastTargets(onsets, 7, true)).toEqual([onset(5, 51), onset(9, 91)]);
    expect(needsInputToastTargets(onsets, 7, false)).toEqual(onsets);
  });

  it("활성 워크스페이스가 없으면(null) 포커스와 무관하게 억제 조건이 성립하지 않는다", () => {
    expect(needsInputToastTargets([onset(5, 51)], null, true)).toEqual([onset(5, 51)]);
    expect(needsInputToastTargets([onset(5, 51)], null, false)).toEqual([onset(5, 51)]);
  });

  it("전이가 없으면 대상도 없다", () => {
    expect(needsInputToastTargets([], 7, true)).toEqual([]);
    expect(needsInputToastTargets([], 7, false)).toEqual([]);
  });
});

describe("needsInputToasts", () => {
  it("같은 워크스페이스 두 탭의 동시 전이는 토스트 2개이고 본문은 각 탭의 메시지다", () => {
    const workspaces = [
      ws(1, [
        tab(11, "needsInput", "approve rm -rf build?"),
        tab(12, "needsInput", "pick a branch"),
      ]),
    ];
    const prev = statuses([[11, "running"], [12, "running"]]);
    const { onsets } = detectNeedsInputOnset(prev, workspaces);
    const targets = needsInputToastTargets(onsets, 2, true);

    expect(needsInputToasts(targets, workspaces)).toEqual([
      { title: "mast — ws 1 · tab 11", body: "approve rm -rf build?", logLabel: "ws 1 #11" },
      { title: "mast — ws 1 · tab 12", body: "pick a branch", logLabel: "ws 1 #12" },
    ]);
  });

  it("본문은 메시지 첫 줄이고, 없거나 비면 기본 문구다 — 워크스페이스 메시지로 대신하지 않는다", () => {
    const withWorkspaceMessage = {
      ...ws(1, [
        tab(11, "needsInput", "  first line  \nsecond"),
        tab(12, "needsInput"),
        tab(13, "needsInput", " \n"),
      ]),
      lastAgentMessage: "a question from another tab",
    };
    const toasts = needsInputToasts(
      [onset(1, 11), onset(1, 12), onset(1, 13)],
      [withWorkspaceMessage],
    );
    expect(toasts.map((t) => t.body)).toEqual([
      "first line",
      "agent needs your input",
      "agent needs your input",
    ]);
  });

  it("로그 라벨에는 탭 제목이 실리지 않는다", () => {
    const titled = { ...tab(31, "needsInput"), title: "fix /secret/path" };
    const workspaces = [{ id: 3, name: "backend", panes: { "30": { tabs: [titled] } } }];
    const [toast] = needsInputToasts([onset(3, 31)], workspaces);
    expect(toast.title).toBe("mast — backend · fix /secret/path");
    expect(toast.logLabel).toBe("backend #31");
  });

  it("스냅샷에서 찾을 수 없는 대상은 건너뛴다", () => {
    const workspaces = [ws(1, [tab(11, "needsInput")])];
    expect(needsInputToasts([onset(1, 99), onset(9, 11)], workspaces)).toEqual([]);
  });
});

function fakeContext(state: AudioContextState = "running") {
  const tones: { freq: number; start: number; stop: number; peak: number }[] = [];
  const resume = vi.fn(() => Promise.resolve());
  const ctx = {
    currentTime: 10,
    state,
    resume,
    destination: {},
    createOscillator: () => {
      const tone = { freq: 0, start: 0, stop: 0, peak: 0 };
      tones.push(tone);
      return {
        type: "",
        frequency: {
          setValueAtTime: (v: number) => {
            tone.freq = v;
          },
        },
        connect: () => undefined,
        start: (t: number) => {
          tone.start = t;
        },
        stop: (t: number) => {
          tone.stop = t;
        },
      };
    },
    createGain: () => ({
      gain: {
        setValueAtTime: () => undefined,
        exponentialRampToValueAtTime: (v: number) => {
          const tone = tones[tones.length - 1];
          if (tone !== undefined && v > tone.peak) tone.peak = v;
        },
      },
      connect: () => undefined,
    }),
  };
  return { ctx: ctx as unknown as AudioContext, tones, resume };
}

// 아래 두 describe 는 **휴면** 코드의 테스트다 (파일 머리 주석 참조) — 지금 이
// 경로를 부르는 배선은 없지만, 되살릴 때를 위해 계약을 계속 잠가 둔다.
describe("Chime (휴면)", () => {
  it("play 는 컨텍스트를 lazy 하게 1회만 만들고 2음을 스케줄한다 (총 ~0.3s)", () => {
    const fake = fakeContext();
    const factory = vi.fn(() => fake.ctx);
    const chime = new Chime(factory);
    expect(factory).not.toHaveBeenCalled();

    chime.play();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.tones).toHaveLength(2);
    expect(fake.tones.map((t) => t.freq)).toEqual([880, 1320]);
    expect(fake.tones[0].start).toBeCloseTo(10);
    expect(fake.tones[1].stop - fake.tones[0].start).toBeCloseTo(0.3);
    expect(Math.max(...fake.tones.map((t) => t.peak))).toBeCloseTo(0.1);

    chime.play();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.tones).toHaveLength(4);
  });

  it("running 이면 resume 하지 않고, suspended 면 resume 을 시도한다", () => {
    const running = fakeContext("running");
    new Chime(() => running.ctx).play();
    expect(running.resume).not.toHaveBeenCalled();

    const suspended = fakeContext("suspended");
    new Chime(() => suspended.ctx).play();
    expect(suspended.resume).toHaveBeenCalledTimes(1);
    // resume 완료를 기다리지 않고 그대로 스케줄한다 (풀리면 그때 소리가 난다).
    expect(suspended.tones).toHaveLength(2);
  });

  it("컨텍스트 생성 실패는 조용히 무시하고 재시도하지 않는다", () => {
    const factory = vi.fn(() => {
      throw new Error("no WebAudio");
    });
    const chime = new Chime(factory);
    expect(() => chime.play()).not.toThrow();
    expect(() => chime.unlock()).not.toThrow();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("resume 거부(autoplay 정책)는 재생 경로를 깨지 않는다", async () => {
    const fake = fakeContext("suspended");
    (fake.resume as unknown as { mockImplementation: (f: () => Promise<void>) => void })
      .mockImplementation(() => Promise.reject(new Error("blocked")));
    const chime = new Chime(() => fake.ctx);
    expect(() => chime.play()).not.toThrow();
    // unhandled rejection 이 남지 않는지 — 마이크로태스크를 한 바퀴 돌린다.
    await Promise.resolve();
    expect(fake.tones).toHaveLength(2);
  });

  it("unlock 은 컨텍스트를 만들고 resume 한다 (소리는 내지 않는다)", () => {
    const fake = fakeContext("suspended");
    const chime = new Chime(() => fake.ctx);
    chime.unlock();
    expect(fake.resume).toHaveBeenCalledTimes(1);
    expect(fake.tones).toHaveLength(0);
  });
});

describe("installChimeUnlock (휴면)", () => {
  it("첫 keydown 에서 1회 unlock 하고 리스너를 뗀다", () => {
    const fake = fakeContext("suspended");
    const chime = new Chime(() => fake.ctx);
    const target = new EventTarget();
    installChimeUnlock(chime, target);

    target.dispatchEvent(new Event("keydown"));
    expect(fake.resume).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event("keydown"));
    target.dispatchEvent(new Event("mousedown"));
    expect(fake.resume).toHaveBeenCalledTimes(1);
  });

  it("mousedown 도 unlock 진입점이다 (키보드 없이 시작하는 경우)", () => {
    const fake = fakeContext("suspended");
    const chime = new Chime(() => fake.ctx);
    const target = new EventTarget();
    installChimeUnlock(chime, target);

    target.dispatchEvent(new Event("mousedown"));
    expect(fake.resume).toHaveBeenCalledTimes(1);
  });
});
