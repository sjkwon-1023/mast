// frame.ts 파서 검증 — [u64 LE offset][bytes] 프레이밍, MAX_SAFE_INTEGER 가드.

import { describe, expect, it } from "vitest";

import { FRAME_HEADER_BYTES, parseAttachBody, parseFrame } from "./frame";

/** offset 헤더 + body 로 프레임 바이트열을 만든다. */
function buildFrame(offset: bigint, body: number[]): Uint8Array {
  const buf = new Uint8Array(FRAME_HEADER_BYTES + body.length);
  new DataView(buf.buffer).setBigUint64(0, offset, true);
  buf.set(body, FRAME_HEADER_BYTES);
  return buf;
}

describe("parseFrame", () => {
  it("parses offset and body", () => {
    const frame = parseFrame(buildFrame(5n, [1, 2, 3]));
    expect(frame.offset).toBe(5);
    expect(Array.from(frame.bytes)).toEqual([1, 2, 3]);
  });

  it("reads the offset as little-endian", () => {
    // 첫 바이트가 최하위 — [1,0,...,0] 은 offset 1 이어야 한다.
    const buf = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0xaa]);
    const frame = parseFrame(buf);
    expect(frame.offset).toBe(1);
    expect(Array.from(frame.bytes)).toEqual([0xaa]);
  });

  it("accepts an ArrayBuffer (raw channel payload)", () => {
    const src = buildFrame(7n, [9, 8]);
    // 정확한 크기의 독립 ArrayBuffer 로 복사해 전달한다.
    const ab = src.slice().buffer;
    const frame = parseFrame(ab);
    expect(frame.offset).toBe(7);
    expect(Array.from(frame.bytes)).toEqual([9, 8]);
  });

  it("respects a Uint8Array view with a nonzero byteOffset", () => {
    // 큰 버퍼 중간에 프레임을 심고 부분 뷰로 파싱한다 — DataView 가
    // byteOffset 을 무시하면 앞의 패딩을 offset 으로 잘못 읽는다.
    const inner = buildFrame(3n, [4, 5]);
    const outer = new Uint8Array(4 + inner.byteLength);
    outer.fill(0xff, 0, 4);
    outer.set(inner, 4);
    const view = outer.subarray(4);
    const frame = parseFrame(view);
    expect(frame.offset).toBe(3);
    expect(Array.from(frame.bytes)).toEqual([4, 5]);
  });

  it("parses a header-only frame as an empty body", () => {
    const frame = parseFrame(buildFrame(42n, []));
    expect(frame.offset).toBe(42);
    expect(frame.bytes.byteLength).toBe(0);
  });

  it("rejects a frame shorter than the header", () => {
    expect(() => parseFrame(new Uint8Array(FRAME_HEADER_BYTES - 1))).toThrow(/too short/);
    expect(() => parseFrame(new Uint8Array(0))).toThrow(/too short/);
  });

  it("accepts offsets up to Number.MAX_SAFE_INTEGER", () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const frame = parseFrame(buildFrame(max, [1]));
    expect(frame.offset).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects offsets beyond Number.MAX_SAFE_INTEGER", () => {
    const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => parseFrame(buildFrame(beyond, [1]))).toThrow(/MAX_SAFE_INTEGER/);
  });
});

describe("parseAttachBody", () => {
  function body(endOffset: number, first: boolean, replay: number[]): Uint8Array {
    const out = new Uint8Array(9 + replay.length);
    new DataView(out.buffer).setBigUint64(0, BigInt(endOffset), true);
    out[8] = first ? 1 : 0;
    out.set(replay, 9);
    return out;
  }

  it("parses end offset, first-attach flag and replay bytes", () => {
    const parsed = parseAttachBody(body(1234, true, [27, 91, 54, 110]));
    expect(parsed.endOffset).toBe(1234);
    expect(parsed.firstAttach).toBe(true);
    expect(Array.from(parsed.replay)).toEqual([27, 91, 54, 110]);
    expect(parseAttachBody(body(0, false, [])).firstAttach).toBe(false);
  });

  it("rejects short bodies", () => {
    expect(() => parseAttachBody(new Uint8Array(8))).toThrow(/too short/);
  });
});
