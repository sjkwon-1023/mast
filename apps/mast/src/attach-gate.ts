// attach 프로토콜의 dedup/ack 결정 로직 — I/O 없는 순수 클래스 (vitest 로 잠근다).
// 계약은 코어 session.rs `PtySession::reattach` rustdoc:
// - 채널 먼저 장착 → reattach 나중이므로, 스냅샷(end_offset) 확정 전에 도착한
//   chunk 는 큐잉했다가 확정 시점에 일괄 판정한다.
// - 스냅샷 구간(끝은 end_offset — 길이로 시작을 역산하지 않는다, reattach 가 앞에 모드
//   preamble 을 붙인다)과 겹치는 chunk(offset < end_offset)
//   는 폐기(dedup)하되, **폐기분 포함 받은 전량을 ack** 해야 flow 계정이 맞는다 —
//   ack 누락분이 pending 에 남으면 paused 고착으로 세션이 굳는다.
// 리더 루프 계약상 chunk 는 end_offset 경계에 걸치지 않는다 (reattach 이전
// chunk 는 전체가 스냅샷에 포함, 이후 chunk 는 offset >= end_offset).

import type { Frame } from "./frame";

export interface GateResult {
  /** term.write 로 전달할 바이트열들 — ack 은 write 완료 콜백에서 집계한다. */
  deliver: Uint8Array[];
  /** 폐기됐지만 수신은 했으므로 즉시 ack 집계해야 하는 바이트 수. */
  discardedBytes: number;
}

const EMPTY: GateResult = { deliver: [], discardedBytes: 0 };

export class AttachGate {
  private endOffset: number | null = null;
  private queued: Frame[] = [];

  /** 채널 chunk 수신. 스냅샷 확정 전이면 큐잉만 하고 빈 결과를 돌려준다. */
  push(frame: Frame): GateResult {
    if (this.endOffset === null) {
      this.queued.push(frame);
      return EMPTY;
    }
    return this.judge(frame);
  }

  /** attach 응답 도착 — 스냅샷 끝 오프셋을 확정하고 큐잉분을 일괄 판정한다.
   *  두 번 호출은 프로토콜 위반이므로 명확히 throw 한다. */
  onSnapshot(endOffset: number): GateResult {
    if (this.endOffset !== null) {
      throw new Error("AttachGate: snapshot end offset already set");
    }
    this.endOffset = endOffset;
    const result: GateResult = { deliver: [], discardedBytes: 0 };
    for (const frame of this.queued) {
      const judged = this.judge(frame);
      result.deliver.push(...judged.deliver);
      result.discardedBytes += judged.discardedBytes;
    }
    this.queued = [];
    return result;
  }

  private judge(frame: Frame): GateResult {
    // onSnapshot 이후에만 호출된다 — endOffset 은 확정 상태.
    if (frame.offset < (this.endOffset as number)) {
      return { deliver: [], discardedBytes: frame.bytes.byteLength };
    }
    return { deliver: [frame.bytes], discardedBytes: 0 };
  }
}
