// 좌표는 하단 기준 줄 수다. 복원 중에는 불완전한 현재 버퍼보다 보류값을 우선한다 (ADR-0019).
export function scrollOffsetToRemember(
  pending: number | null,
  bufferType: "normal" | "alternate",
  baseY: number,
  viewportY: number,
): number | null {
  if (pending !== null) return pending;
  if (bufferType !== "normal") return null;
  const offset = baseY - viewportY;
  return offset > 0 ? offset : null;
}

// 없는 위치를 0으로 접으면 xterm의 스크롤 래치가 전사 맨 위에 고착된다.
export function restoreTargetLine(baseY: number, offset: number): number | null {
  if (offset > baseY) return null;
  return baseY - offset;
}

// 재생 중·복원 중·래치 해제 대기 중의 ED 3는 사용자가 고른 위치가 아니다.
export function scrollbackWipeRestoreOffset(
  pending: number | null,
  latchReleasePending: boolean,
  replayDone: boolean,
  bufferType: "normal" | "alternate",
  baseY: number,
  viewportY: number,
): number | null {
  if (pending !== null) return null;
  if (latchReleasePending) return null;
  if (!replayDone) return null;
  if (bufferType !== "normal") return null;
  const offset = baseY - viewportY;
  return offset > 0 ? offset : null;
}

export const SETTLE_QUIET_MS = 250;

export const SETTLE_CAP_MS = 2_000;

export type SettlePoll =
  | { kind: "wait"; nextCheckAt: number }
  | { kind: "restore" }
  | { kind: "abandon" };

// 마지막 파싱 후 250ms, nudge 후 최대 2초에 종료한다. 출력이 없으면 추가 복원을 포기한다.
export class OutputSettle {
  private startedAt: number | null = null;
  private lastChunkAt: number | null = null;
  private finished = false;

  start(now: number): void {
    this.startedAt = now;
  }

  noteChunk(now: number): void {
    if (this.finished || this.startedAt === null) return;
    this.lastChunkAt = now;
  }

  cancel(): void {
    this.finished = true;
  }

  poll(now: number): SettlePoll {
    if (this.finished || this.startedAt === null) return { kind: "abandon" };
    const cap = this.startedAt + SETTLE_CAP_MS;
    const due =
      this.lastChunkAt === null ? cap : Math.min(this.lastChunkAt + SETTLE_QUIET_MS, cap);
    if (now < due) return { kind: "wait", nextCheckAt: due };
    this.finished = true;
    return this.lastChunkAt === null ? { kind: "abandon" } : { kind: "restore" };
  }
}
