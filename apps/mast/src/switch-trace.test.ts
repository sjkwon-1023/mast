// SwitchTracer 정착 판정·수명 규칙 검증 — 시각을 인자로 주입해 결정적으로
// 테스트한다 (performance.now 불사용, DOM-free).

import { describe, expect, it } from "vitest";

import { SwitchTracer } from "./switch-trace";
import type { SwitchReport } from "./switch-trace";

function setup(): { reports: SwitchReport[]; tracer: SwitchTracer } {
  const reports: SwitchReport[] = [];
  const tracer = new SwitchTracer((report) => reports.push(report));
  return { reports, tracer };
}

describe("SwitchTracer", () => {
  it("settles at settle() when no terminal attaches (empty workspace)", () => {
    const { reports, tracer } = setup();
    tracer.begin(7, 100);
    tracer.markSnapshot(7, 130);
    tracer.settle();
    expect(reports).toEqual([
      {
        workspace: 7,
        totalMs: 30,
        dispatchToSnapshotMs: 30,
        perTab: [],
        approximatePaint: true,
      },
    ]);
    expect(tracer.tracing).toBe(false);
  });

  it("waits for every attach-started tab before reporting", () => {
    const { reports, tracer } = setup();
    tracer.begin(1, 0);
    tracer.markSnapshot(1, 20);
    expect(tracer.markAttachStart(11, 25)).toBe(true);
    expect(tracer.markAttachStart(12, 26)).toBe(true);
    tracer.settle();
    expect(reports).toEqual([]); // 봉인만 — 탭 완주 대기
    tracer.markReplayDone(11, 4096, 60);
    expect(reports).toEqual([]);
    tracer.markReplayDone(12, 1024, 90);
    expect(reports).toEqual([
      {
        workspace: 1,
        totalMs: 90,
        dispatchToSnapshotMs: 20,
        perTab: [
          { tab: 11, attachMs: 35, replayBytes: 4096 },
          { tab: 12, attachMs: 64, replayBytes: 1024 },
        ],
        approximatePaint: true,
      },
    ]);
  });

  it("discards an incomplete trace when a new begin arrives", () => {
    const { reports, tracer } = setup();
    tracer.begin(1, 0);
    tracer.markSnapshot(1, 10);
    tracer.markAttachStart(11, 12);
    tracer.begin(2, 100); // 연타 전환 — 미완 trace 폐기
    tracer.markReplayDone(11, 5, 120); // 구 trace 의 늦은 완료 — 무시돼야 한다
    tracer.markSnapshot(2, 130);
    tracer.settle();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ workspace: 2, dispatchToSnapshotMs: 30, perTab: [] });
  });

  it("is a complete no-op while no trace is active", () => {
    const { reports, tracer } = setup();
    tracer.markSnapshot(1, 0);
    expect(tracer.markAttachStart(1, 0)).toBe(false);
    tracer.markReplayDone(1, 10, 0);
    tracer.settle();
    expect(reports).toEqual([]);
    expect(tracer.tracing).toBe(false);
  });

  it("ignores renders of a different workspace before the switch snapshot", () => {
    const { reports, tracer } = setup();
    tracer.begin(5, 0);
    tracer.markSnapshot(3, 10); // 무관 렌더 (이전 명령의 늦은 이벤트) — 무시
    tracer.settle(); // 스냅샷 미도착 — 봉인·정착 없음
    expect(reports).toEqual([]);
    tracer.markSnapshot(5, 40);
    tracer.settle();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ workspace: 5, dispatchToSnapshotMs: 40, totalMs: 40 });
  });

  it("rejects attach starts before the snapshot and after the seal", () => {
    const { reports, tracer } = setup();
    tracer.begin(9, 0);
    expect(tracer.markAttachStart(1, 5)).toBe(false); // 전환 스냅샷 도착 전
    tracer.markSnapshot(9, 10);
    expect(tracer.markAttachStart(1, 11)).toBe(true);
    expect(tracer.markAttachStart(1, 12)).toBe(false); // 중복 탭
    tracer.settle();
    expect(tracer.markAttachStart(2, 20)).toBe(false); // 봉인 후 늦은 lazy attach
    tracer.markReplayDone(1, 7, 30);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.perTab).toEqual([{ tab: 1, attachMs: 19, replayBytes: 7 }]);
  });


  it("a stale token cannot kill a newer trace for the same workspace", () => {
    const { tracer } = setup();
    const first = tracer.begin(4, 0);
    tracer.begin(4, 50); // 같은 워크스페이스 연타 — 새 trace 가 덮는다
    tracer.discard(first); // 앞 dispatch 실패의 늦은 폐기 — 뒤 trace 는 유지돼야 한다
    expect(tracer.tracing).toBe(true);
  });

  it("discard(token) drops only the matching trace", () => {
    const { reports, tracer } = setup();
    const token = tracer.begin(4, 0);
    tracer.discard(token + 1); // 다른 토큰 — 유지
    expect(tracer.tracing).toBe(true);
    tracer.discard(token); // dispatch 실패 경로 — 폐기
    expect(tracer.tracing).toBe(false);
    tracer.markSnapshot(4, 10);
    tracer.settle();
    expect(reports).toEqual([]);
  });
});
