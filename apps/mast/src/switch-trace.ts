// 워크스페이스 전환 지연 tracer (14단계 청크 A-2) — 순수 모듈 (DOM-free, vitest).
//
// 계측 구간: switchWorkspace dispatch(t0) → 전환 스냅샷 렌더(markSnapshot) →
// 새로 attach 되는 각 터미널의 replay 완료(markReplayDone — 완료점은 replay
// write 콜백 + rAF 1회 보정) → 전체 정착 시 report 를 onReport 콜백으로 1회
// 전달한다. 완료점은 실제 페인트가 아니라 그 근사다 — report 의
// approximatePaint: true 필드가 이를 명시한다.
//
// 시각은 전부 인자로 주입받는다 (performance.now() 는 호출자 몫) — 이 모듈은
// 브라우저 API 에 의존하지 않고 테스트가 결정적이다.
//
// 수명 규칙 (계획 1장 A-2):
// - begin 은 진행 중 trace 를 조용히 폐기한다 — 연타 전환은 마지막 것만 계측.
// - 진행 중 trace 가 없으면 모든 메서드는 완전 no-op — 상시 오버헤드·폴링 없음.
// - markSnapshot 은 렌더의 활성 워크스페이스가 trace 대상과 일치할 때만 기록한다
//   — begin 과 전환 스냅샷 사이에 끼어드는 무관 렌더(이전 명령의 늦은 이벤트)가
//   trace 를 조기 정착시키지 않게 하는 가드다.
// - settle() 은 전환 스냅샷 렌더 말미(main.render)에 호출된다 — 그 렌더에서
//   markAttachStart 가 없었으면(터미널 0개 워크스페이스·전부 keep-alive 재사용)
//   즉시 정착하고, 있었으면 trace 를 봉인(seal)해 마지막 markReplayDone 이
//   정착시킨다. 봉인 후 markAttachStart 는 거부한다 (늦은 lazy attach 는 이
//   전환의 계측 대상이 아니다).
// - attach 실패 등으로 완주하지 못한 trace 는 다음 begin/discard 가 폐기한다.

import type { TabId, WorkspaceId } from "./types";

export interface SwitchTabReport {
  tab: TabId;
  /** markAttachStart → markReplayDone (write 콜백 + rAF 1회 보정 포함) 구간 ms. */
  attachMs: number;
  /** attach 응답으로 받은 replay 스냅샷의 바이트 수. */
  replayBytes: number;
}

export interface SwitchReport {
  workspace: WorkspaceId;
  /** t0(dispatch) → 마지막 완료점 (탭이 없으면 스냅샷 렌더) 구간 ms. */
  totalMs: number;
  /** t0(dispatch) → 전환 스냅샷 렌더 도착 구간 ms. */
  dispatchToSnapshotMs: number;
  perTab: SwitchTabReport[];
  /** 완료점이 replay write 콜백 + rAF 1회 보정이라 실제 페인트의 근사임을 표시. */
  approximatePaint: true;
}

interface TabTrace {
  attachAt: number;
  doneAt: number | null;
  bytes: number;
}

interface ActiveTrace {
  workspace: WorkspaceId;
  /** begin 발급 토큰 — discard 가 자기 trace 만 폐기하게 하는 식별자. */
  seq: number;
  t0: number;
  snapshotAt: number | null;
  /** 전환 스냅샷 렌더가 끝났다 — 이후 새 attach 는 받지 않고 완주만 기다린다. */
  sealed: boolean;
  tabs: Map<TabId, TabTrace>;
}

export class SwitchTracer {
  private trace: ActiveTrace | null = null;
  private seq = 0;

  constructor(private readonly onReport: (report: SwitchReport) => void) {}

  /** 진행 중 trace 존재 여부 — 호출측의 저비용 가드용. */
  get tracing(): boolean {
    return this.trace !== null;
  }

  /** 전환 계측 시작 — t0 은 switchWorkspace dispatch 시각. 미완 trace 는 폐기.
   *  반환 토큰을 discard 에 넘긴다 — 워크스페이스 id 기반 폐기는 같은 워크스페이스
   *  연타에서 뒤의 유효 trace 를 앞 dispatch 실패가 죽이는 구멍이 있었다
   *  (리뷰 finding). */
  begin(workspace: WorkspaceId, t0: number): number {
    this.seq += 1;
    this.trace = {
      workspace,
      seq: this.seq,
      t0,
      snapshotAt: null,
      sealed: false,
      tabs: new Map(),
    };
    return this.seq;
  }

  /** 토큰의 trace 폐기 — dispatch 실패 시 호출한다. 그새 다른 begin 이 덮어썼으면
   *  (토큰 불일치) 그쪽 trace 는 건드리지 않는다. */
  discard(token: number): void {
    if (this.trace !== null && this.trace.seq === token) this.trace = null;
  }

  /** 전환 스냅샷 렌더 도착 시각. 활성 워크스페이스가 trace 대상과 다른 렌더는
   *  무시한다 (무관 렌더 가드 — 파일 상단). 최초 1회만 기록한다. */
  markSnapshot(activeWorkspace: WorkspaceId | null, t: number): void {
    const trace = this.trace;
    if (trace === null || trace.snapshotAt !== null) return;
    if (activeWorkspace !== trace.workspace) return;
    trace.snapshotAt = t;
  }

  /** 새 attach 시작 — 수락하면 true. 호출측(workspace-view ensureView)은 수락된
   *  탭에만 markReplayDone 완료 훅을 단다. 전환 스냅샷 도착 전·봉인 후·중복
   *  탭은 거부한다. */
  markAttachStart(tab: TabId, t: number): boolean {
    const trace = this.trace;
    if (trace === null || trace.snapshotAt === null || trace.sealed) return false;
    if (trace.tabs.has(tab)) return false;
    trace.tabs.set(tab, { attachAt: t, doneAt: null, bytes: 0 });
    return true;
  }

  /** 탭의 replay 완료 (write 콜백 + rAF 보정 후 시각). 봉인된 trace 의 마지막
   *  완주라면 여기서 정착한다. */
  markReplayDone(tab: TabId, bytes: number, t: number): void {
    const trace = this.trace;
    if (trace === null) return;
    const entry = trace.tabs.get(tab);
    if (entry === undefined || entry.doneAt !== null) return;
    entry.doneAt = t;
    entry.bytes = bytes;
    this.maybeSettle();
  }

  /** 전환 스냅샷 렌더 말미 호출 — trace 봉인. 대기 탭이 없으면 즉시 정착한다.
   *  스냅샷 미도착 상태(무관 렌더)에서는 아무것도 하지 않는다. */
  settle(): void {
    const trace = this.trace;
    if (trace === null || trace.snapshotAt === null) return;
    trace.sealed = true;
    this.maybeSettle();
  }

  /** 정착 판정 — 봉인됐고 전 탭이 완주했으면 report 를 1회 전달하고 trace 를
   *  비운다 (onReport 재진입에도 안전하도록 비운 뒤 호출). */
  private maybeSettle(): void {
    const trace = this.trace;
    if (trace === null || !trace.sealed) return;
    const snapshotAt = trace.snapshotAt;
    if (snapshotAt === null) return;

    let end = snapshotAt;
    const perTab: SwitchTabReport[] = [];
    for (const [tab, entry] of trace.tabs) {
      if (entry.doneAt === null) return; // 아직 완주 전 — 정착 보류
      if (entry.doneAt > end) end = entry.doneAt;
      perTab.push({ tab, attachMs: entry.doneAt - entry.attachAt, replayBytes: entry.bytes });
    }

    this.trace = null;
    this.onReport({
      workspace: trace.workspace,
      totalMs: end - trace.t0,
      dispatchToSnapshotMs: snapshotAt - trace.t0,
      perTab,
      approximatePaint: true,
    });
  }
}
