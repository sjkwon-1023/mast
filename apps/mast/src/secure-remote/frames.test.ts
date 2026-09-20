import { describe, expect, it } from "vitest";

import { base64urlDecode, base64urlEncode } from "./base64url";
import {
  FRAME_VERSION,
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
  MAX_INPUT_BYTES,
  encodeFrame,
  encodeRequestFrame,
  parseReply,
} from "./frames";

const decoder = new TextDecoder();

function bodyOf(frame: Uint8Array): Record<string, unknown> {
  const view = new DataView(frame.buffer, frame.byteOffset, 4);
  expect(view.getUint32(0, false)).toBe(frame.length - 4);
  return JSON.parse(decoder.decode(frame.subarray(4))) as Record<string, unknown>;
}

/** `FrameDecoder` 가 돌려주는 것과 같은 JSON 본문 (길이 프리픽스 없음). */
function jsonReply(body: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}

function jsonOf(payload: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
}

describe("encodeRequestFrame", () => {
  it("writes the auth frame with exactly the v1 fields", () => {
    expect(bodyOf(encodeRequestFrame(1, { type: "auth", token: "tok" }))).toEqual({
      v: 1,
      id: 1,
      type: "auth",
      token: "tok",
    });
  });

  it("omits since/session when there is no query and sends both otherwise", () => {
    expect(bodyOf(encodeRequestFrame(2, { type: "screen", tab: 7, query: null }))).toEqual({
      v: 1,
      id: 2,
      type: "screen",
      tab: 7,
    });
    expect(
      bodyOf(
        encodeRequestFrame(3, {
          type: "screen",
          tab: 7,
          query: { since: 42, session: "1:2" },
        }),
      ),
    ).toEqual({ v: 1, id: 3, type: "screen", tab: 7, since: 42, session: "1:2" });
  });

  it("base64url-encodes input as UTF-8 bytes", () => {
    const body = bodyOf(
      encodeRequestFrame(4, { type: "input", tab: 7, session: "1:2", data: "테스트\r" }),
    );
    expect(body).toMatchObject({ v: 1, id: 4, type: "input", tab: 7, session: "1:2" });
    const bytes = base64urlDecode(body.data as string);
    expect(bytes).not.toBeNull();
    expect(decoder.decode(bytes as Uint8Array)).toBe("테스트\r");
  });

  it("rejects input over 64 KiB before it reaches the wire", () => {
    expect(() =>
      encodeRequestFrame(5, {
        type: "input",
        tab: 7,
        session: "1:2",
        data: "x".repeat(MAX_INPUT_BYTES + 1),
      }),
    ).toThrow(FrameError);
    expect(() =>
      encodeRequestFrame(5, {
        type: "input",
        tab: 7,
        session: "1:2",
        data: "x".repeat(MAX_INPUT_BYTES),
      }),
    ).not.toThrow();
  });

  it("writes heartbeat and state with no extra fields", () => {
    expect(bodyOf(encodeRequestFrame(6, { type: "heartbeat" }))).toEqual({
      v: FRAME_VERSION,
      id: 6,
      type: "heartbeat",
    });
    expect(bodyOf(encodeRequestFrame(7, { type: "state" }))).toEqual({
      v: FRAME_VERSION,
      id: 7,
      type: "state",
    });
  });
});

describe("FrameDecoder", () => {
  it("reassembles a frame split across chunks", () => {
    const frame = encodeRequestFrame(1, { type: "state" });
    const decoderUnderTest = new FrameDecoder();
    expect(decoderUnderTest.push(frame.subarray(0, 3))).toEqual([]);
    const rest = frame.subarray(3);
    const frames = decoderUnderTest.push(rest);
    expect(frames.length).toBe(1);
    expect(jsonOf(frames[0])).toEqual({ v: 1, id: 1, type: "state" });
  });

  it("splits two frames that arrive in one chunk", () => {
    const decoderUnderTest = new FrameDecoder();
    const a = encodeRequestFrame(1, { type: "state" });
    const b = encodeRequestFrame(2, { type: "heartbeat" });
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a);
    merged.set(b, a.length);
    const frames = decoderUnderTest.push(merged);
    expect(frames.length).toBe(2);
    expect(jsonOf(frames[0])).toEqual({ v: 1, id: 1, type: "state" });
    expect(jsonOf(frames[1])).toEqual({ v: 1, id: 2, type: "heartbeat" });
  });

  it("throws on a zero or oversized declared length", () => {
    for (const declared of [0, 1_572_865]) {
      const decoderUnderTest = new FrameDecoder();
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setUint32(0, declared, false);
      expect(() => decoderUnderTest.push(prefix)).toThrow(FrameError);
    }
  });

  it("rejects an invalid length at the start of a large chunk", () => {
    // 계약은 조각 크기와 무관하게 같다. (내부 버퍼가 조각 전체를 붙들지 않는지는
    // 관측으로 구분되지 않는다 — 할당 상한은 코드 리뷰가 본다.) 조각은 상한보다
    // 훨씬 크게 둬서, 예전 구현이라면 통째로 복사됐을 입력을 흉내 낸다.
    for (const declared of [0, 1_572_865]) {
      const decoderUnderTest = new FrameDecoder();
      const chunk = new Uint8Array(4 + 4 * 1024 * 1024);
      new DataView(chunk.buffer).setUint32(0, declared, false);
      expect(() => decoderUnderTest.push(chunk)).toThrow(FrameError);
    }
  });

  it("decodes one chunk holding several valid frames above MAX_FRAME_BYTES in total", () => {
    const padLength = Math.floor(MAX_FRAME_BYTES / 4) + 1_000;
    const parts = [1, 2, 3, 4].map((id) =>
      encodeFrame({ v: 1, id, ok: true, pad: "z".repeat(padLength) }),
    );
    const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    expect(merged.length).toBeGreaterThan(MAX_FRAME_BYTES);

    const frames = new FrameDecoder().push(merged);
    expect(frames.length).toBe(parts.length);
    expect(frames.map((frame) => jsonOf(frame).id)).toEqual([1, 2, 3, 4]);
    // 본문은 내부 버퍼의 뷰가 아니라 복사본이어야 한다 — 내부 버퍼는 다음 프레임을
    // 위해 곧바로 재사용되므로, 뷰였다면 뒤 프레임을 붙이는 순간 내용이 깨진다.
    for (const frame of frames) {
      expect((jsonOf(frame).pad as string).length).toBe(padLength);
    }
  });

  it("reassembles frames across an awkward split with a partial tail", () => {
    const a = encodeRequestFrame(1, { type: "state" });
    const b = encodeRequestFrame(2, { type: "heartbeat" });
    const c = encodeRequestFrame(3, { type: "state" });
    const decoderUnderTest = new FrameDecoder();

    // A 완성 + B 의 첫 1바이트.
    const first = new Uint8Array(a.length + 1);
    first.set(a);
    first.set(b.subarray(0, 1), a.length);
    expect(decoderUnderTest.push(first).map(jsonOf)).toEqual([{ v: 1, id: 1, type: "state" }]);

    // B 나머지 + C 완성 + D 의 첫 3바이트.
    const d = encodeRequestFrame(4, { type: "heartbeat" });
    const second = new Uint8Array(b.length - 1 + c.length + 3);
    second.set(b.subarray(1));
    second.set(c, b.length - 1);
    second.set(d.subarray(0, 3), b.length - 1 + c.length);
    expect(decoderUnderTest.push(second).map(jsonOf)).toEqual([
      { v: 1, id: 2, type: "heartbeat" },
      { v: 1, id: 3, type: "state" },
    ]);

    // 남은 꼬리 3바이트가 다음 push 에서 완성된다.
    expect(decoderUnderTest.push(d.subarray(3)).map(jsonOf)).toEqual([
      { v: 1, id: 4, type: "heartbeat" },
    ]);
  });

  it("rejects a malformed length that is completed across a chunk boundary", () => {
    const decoderUnderTest = new FrameDecoder();
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, 1_572_865, false);
    expect(decoderUnderTest.push(prefix.subarray(0, 3))).toEqual([]);
    expect(() => decoderUnderTest.push(prefix.subarray(3))).toThrow(FrameError);
  });

  it("decodes a maximum-size frame delivered in many small chunks", () => {
    // 예전 구현은 push 마다 누적분 전체를 복사해, 이 크기를 16바이트 조각으로
    // 먹이면 이차 시간이 됐다 — 이 테스트가 그 회귀를 잡는다 (유닛 테스트 기본
    // 시간 상한 안에서 끝나야 한다).
    const padLength = MAX_FRAME_BYTES - 128;
    const frame = encodeFrame({ v: 1, id: 1, ok: true, pad: "x".repeat(padLength) });
    expect(frame.length).toBeGreaterThan(MAX_FRAME_BYTES - 1024);
    expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES + 4);

    const decoderUnderTest = new FrameDecoder();
    const frames: Uint8Array[] = [];
    const step = 16;
    for (let offset = 0; offset < frame.length; offset += step) {
      frames.push(...decoderUnderTest.push(frame.subarray(offset, offset + step)));
    }
    expect(frames.length).toBe(1);
    const body = jsonOf(frames[0]);
    expect(body).toMatchObject({ v: 1, id: 1, ok: true });
    expect((body.pad as string).length).toBe(padLength);
  });

  it("round-trips a pseudo-random stream through arbitrary chunk boundaries", () => {
    // 결정적 LCG — 프레임 경계와 무관한 조각 분할을 재현 가능하게 만든다.
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const parts = Array.from({ length: 200 }, (_, id) =>
      encodeFrame({ v: 1, id, ok: true, pad: "p".repeat(next() % 64) }),
    );
    const stream = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      stream.set(part, at);
      at += part.length;
    }

    const decoderUnderTest = new FrameDecoder();
    const decoded: Uint8Array[] = [];
    let offset = 0;
    while (offset < stream.length) {
      const size = 1 + (next() % 13);
      decoded.push(...decoderUnderTest.push(stream.subarray(offset, offset + size)));
      offset += size;
    }
    expect(decoded.length).toBe(parts.length);
    expect(decoded.map((frame) => jsonOf(frame).id)).toEqual(parts.map((_, index) => index));
  });

  it("keeps decoding after a full-size frame consumed the whole buffer", () => {
    const big = encodeFrame({ v: 1, id: 1, ok: true, pad: "y".repeat(MAX_FRAME_BYTES - 128) });
    const decoderUnderTest = new FrameDecoder();
    // 큰 프레임을 4 KiB 조각으로 — 버퍼가 커진 뒤에도 계약이 유지되는지 본다.
    const frames: Uint8Array[] = [];
    for (let offset = 0; offset + 4096 <= big.length; offset += 4096) {
      frames.push(...decoderUnderTest.push(big.subarray(offset, offset + 4096)));
    }
    frames.push(...decoderUnderTest.push(big.subarray(big.length - (big.length % 4096))));
    expect(frames.length).toBe(1);
    expect(jsonOf(frames[0]).id).toBe(1);

    // 큰 프레임 소비 뒤에도 작은 프레임이 정상으로 나온다.
    const small = encodeRequestFrame(2, { type: "state" });
    const again = decoderUnderTest.push(small);
    expect(again.length).toBe(1);
    expect(jsonOf(again[0])).toEqual({ v: 1, id: 2, type: "state" });
  });
});

describe("parseReply", () => {
  it("reads an ok reply", () => {
    const reply = parseReply(jsonReply({ v: 1, id: 9, ok: true, endOffset: 5 }));
    expect(reply).toMatchObject({ id: 9, ok: true });
    if (reply.ok) expect(reply.body.endOffset).toBe(5);
  });

  it("reads an error reply with its status and message", () => {
    expect(parseReply(jsonReply({ v: 1, id: 9, ok: false, status: 503, message: "input busy" })))
      .toEqual({ id: 9, ok: false, status: 503, message: "input busy" });
  });

  it("rejects non-JSON, non-object, wrong-version and id-less replies", () => {
    for (const raw of [
      new TextEncoder().encode("not json"),
      jsonReply([1, 2]),
      jsonReply({ v: 2, id: 1, ok: true }),
      jsonReply({ v: 1, ok: true }),
      jsonReply({ v: 1, id: 1 }),
      jsonReply({ v: 1, id: 1, ok: false, status: "500", message: "x" }),
    ]) {
      expect(() => parseReply(raw)).toThrow(FrameError);
    }
  });
});

describe("base64url", () => {
  it("round-trips bytes and rejects padded or non-canonical text", () => {
    const bytes = new Uint8Array([1, 2, 250, 255]);
    expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
    expect(base64urlDecode("")).toEqual(new Uint8Array(0));
    expect(base64urlDecode("AA==")).toBeNull();
    expect(base64urlDecode("A")).toBeNull();
    // `AB` 는 1바이트로 풀리지만 잉여 4비트가 0 이 아니다 — canonical 은 `AA` 다.
    expect(base64urlDecode("AB")).toBeNull();
  });
});
