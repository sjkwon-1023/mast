// AttachGate 검증 — 스냅샷 전 큐잉, 경계 offset dedup, 폐기분 포함 전량 ack
// (코어 session.rs reattach rustdoc 의 호출자 계약을 프론트 쪽에서 잠근다).

import { describe, expect, it } from "vitest";

import { AttachGate } from "./attach-gate";
import type { Frame } from "./frame";

function frame(offset: number, len: number): Frame {
  return { offset, bytes: new Uint8Array(len).fill(0xab) };
}

describe("AttachGate", () => {
  it("queues chunks before the snapshot and emits nothing", () => {
    const gate = new AttachGate();
    const r1 = gate.push(frame(0, 10));
    const r2 = gate.push(frame(10, 5));
    expect(r1.deliver).toEqual([]);
    expect(r1.discardedBytes).toBe(0);
    expect(r2.deliver).toEqual([]);
    expect(r2.discardedBytes).toBe(0);
  });

  it("judges queued chunks at snapshot time: overlap discarded, rest delivered", () => {
    const gate = new AttachGate();
    gate.push(frame(0, 10)); // 스냅샷 구간과 전체 겹침 → 폐기
    const tail = frame(20, 7); // 스냅샷 이후 출력 → 전달
    gate.push(tail);
    const result = gate.onSnapshot(20);
    expect(result.deliver).toEqual([tail.bytes]);
    expect(result.discardedBytes).toBe(10);
  });

  it("treats offset == endOffset as fresh output (boundary)", () => {
    // 폐기 규칙은 offset < end_offset — 경계 offset 은 스냅샷 직후 첫 chunk 다.
    const gate = new AttachGate();
    const boundary = frame(100, 4);
    const stale = frame(99, 4);
    gate.push(boundary);
    gate.push(stale);
    const result = gate.onSnapshot(100);
    expect(result.deliver).toEqual([boundary.bytes]);
    expect(result.discardedBytes).toBe(4);
  });

  it("sums discarded bytes across multiple stale queued chunks", () => {
    // 폐기분 포함 전량 ack 계약 — 폐기가 여러 chunk 면 전부 합산돼야
    // flow 계정이 맞는다 (누락 시 pending 잔류 → paused 고착).
    const gate = new AttachGate();
    gate.push(frame(0, 16));
    gate.push(frame(16, 16));
    gate.push(frame(32, 8));
    const result = gate.onSnapshot(40);
    expect(result.deliver).toEqual([]);
    expect(result.discardedBytes).toBe(40);
  });

  it("dedups chunks pushed after the snapshot directly", () => {
    const gate = new AttachGate();
    gate.onSnapshot(50);
    const stale = gate.push(frame(30, 20));
    expect(stale.deliver).toEqual([]);
    expect(stale.discardedBytes).toBe(20);
    const fresh = frame(50, 6);
    const delivered = gate.push(fresh);
    expect(delivered.deliver).toEqual([fresh.bytes]);
    expect(delivered.discardedBytes).toBe(0);
  });

  it("drains the queue exactly once", () => {
    // onSnapshot 이 배출한 큐잉분이 이후 push 결과에 다시 섞이면 이중 전달이다.
    const gate = new AttachGate();
    gate.push(frame(0, 10));
    const first = gate.onSnapshot(0);
    expect(first.deliver.length).toBe(1);
    const later = gate.push(frame(10, 3));
    expect(later.deliver.length).toBe(1);
    expect(later.discardedBytes).toBe(0);
  });

  it("delivers everything for a fresh session (endOffset 0)", () => {
    const gate = new AttachGate();
    const f = frame(0, 12);
    gate.push(f);
    const result = gate.onSnapshot(0);
    expect(result.deliver).toEqual([f.bytes]);
    expect(result.discardedBytes).toBe(0);
  });

  it("rejects a second snapshot (protocol violation)", () => {
    const gate = new AttachGate();
    gate.onSnapshot(10);
    expect(() => gate.onSnapshot(20)).toThrow(/already set/);
  });
});
