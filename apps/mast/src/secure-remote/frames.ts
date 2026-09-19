// Secure Remote v1 프레임 코덱 — 서버 `crates/mast-remote/src/wt/protocol.rs` 의 계약을 옮긴 것.
//
// 프레임 하나 = `u32` big endian 길이 + UTF-8 JSON. 상한(프레임 1.5 MiB, 입력 원문
// 64 KiB)은 서버 상수와 같아야 한다 — 서버가 거부할 것을 만들어 보내면 연결이 끊긴다.
//
// 요청은 필드 집합이 타입으로 고정돼 있다. 서버는 v1 에 없는 필드를 오류로 처리하므로,
// 여기서 만들어 내는 JSON 이 계약 그 자체다.

import { base64urlEncode } from "./base64url";
import type { ScreenQuery } from "../remote/protocol";

export const FRAME_VERSION = 1;
/** 직렬화된 JSON 프레임 하나의 상한 (서버 `MAX_FRAME_BYTES`). */
export const MAX_FRAME_BYTES = 1_572_864;
/** `input` 원문 바이트 상한 (서버 `MAX_INPUT_BYTES`). */
export const MAX_INPUT_BYTES = 65_536;

/** 이 코덱이 만든 값은 `FrameDecoder`/`parseReply` 가 소비한다. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export type RequestPayload =
  | { type: "auth"; token: string }
  | { type: "state" }
  | { type: "screen"; tab: number; query: ScreenQuery | null }
  | { type: "input"; tab: number; session: string; data: string }
  | { type: "heartbeat" };

const encoder = new TextEncoder();

export function encodeRequestFrame(id: number, payload: RequestPayload): Uint8Array {
  switch (payload.type) {
    case "auth":
      return encodeFrame({ v: FRAME_VERSION, id, type: "auth", token: payload.token });
    case "state":
      return encodeFrame({ v: FRAME_VERSION, id, type: "state" });
    case "screen": {
      // `since` 와 `session` 은 함께 있을 때만 의미가 있다 — 서버는 둘 중 하나만
      // 오면 그 오프셋을 다른 세션의 좌표로 보고 reset 으로 되돌린다 (handlers.rs).
      const body: Record<string, unknown> = {
        v: FRAME_VERSION,
        id,
        type: "screen",
        tab: payload.tab,
      };
      if (payload.query !== null) {
        body.since = payload.query.since;
        body.session = payload.query.session;
      }
      return encodeFrame(body);
    }
    case "input": {
      const raw = encoder.encode(payload.data);
      if (raw.length > MAX_INPUT_BYTES) throw new FrameError("input over 64 KiB");
      return encodeFrame({
        v: FRAME_VERSION,
        id,
        type: "input",
        tab: payload.tab,
        session: payload.session,
        data: base64urlEncode(raw),
      });
    }
    case "heartbeat":
      return encodeFrame({ v: FRAME_VERSION, id, type: "heartbeat" });
  }
}

/** 길이 프리픽스 + 본문. 한 번의 `write` 로 나가도록 한 덩어리로 만든다. */
export function encodeFrame(body: unknown): Uint8Array {
  const json = encoder.encode(JSON.stringify(body));
  if (json.length > MAX_FRAME_BYTES) throw new FrameError(`frame over ${MAX_FRAME_BYTES} bytes`);
  const frame = new Uint8Array(4 + json.length);
  new DataView(frame.buffer).setUint32(0, json.length, false);
  frame.set(json, 4);
  return frame;
}

/** 스트림 조각을 프레임 경계로 모은다. 조각 경계는 프레임 경계와 무관하다.
 *
 *  버퍼는 **슬라이딩 버퍼**다 — `[head, tail)` 이 아직 프레임으로 잘리지 않은
 *  구간이고, 새 조각은 `tail` 뒤에 붙는다. 소비한 앞부분은 복사하지 않고 `head` 만
 *  밀며, 자리가 모자랄 때만 소비 구간을 앞으로 당기거나 두 배로 늘린다. 조각마다
 *  누적분 전체를 새로 복사하던 예전 구현은 1.4 MiB 화면이 작은 조각으로 오면
 *  이차였다.
 *
 *  `push` 는 조각을 한 번에 붙이지 않는다 — 프리픽스를 완성하는 데 필요한 바이트만,
 *  그다음 현재 프레임을 끝내는 데 필요한 바이트만 붙이고 즉시 소비한다. 그래서
 *  `[head, tail)` 이 살아 있는 바이트는 프레임 하나(`4 + MAX_FRAME_BYTES` 이하)로
 *  묶인다. 조각 하나에 작은 프레임이 수백 개 들었거나 맨 앞 프리픽스가 거대한 길이를
 *  선언해도 그 조각 전체가 버퍼로 복사되지 않는다. **할당 용량**은 이 상한과 다르다:
 *  성장이 2의 거듭제곱이라 최대 프레임 하나를 받으면 2 MiB 까지 잡고 그 뒤로는 줄이지
 *  않는다 (살아 있는 바이트는 그때도 상한 이하다). (돌려주는 프레임 본문들은 그 수만큼
 *  당연히 할당된다.) */
export class FrameDecoder {
  private buffer = new Uint8Array(0);
  private head = 0;
  private tail = 0;

  /** 완성된 프레임 본문들. 길이 프리픽스가 상한 밖이면 `FrameError` 다 — 그 연결은
   *  더 읽을 가치가 없다(서버도 같은 상한으로 보낸다). 검증은 프리픽스 4바이트가
   *  모이는 즉시 하므로, 거대한 조각도 통째로 붙들지 않는다. */
  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let offset = 0;

    while (offset < chunk.length) {
      // 1. 길이 프리픽스 4바이트부터 완성한다 — 모자란 만큼만 붙인다.
      if (this.tail - this.head < 4) {
        const take = Math.min(4 - (this.tail - this.head), chunk.length - offset);
        this.append(chunk.subarray(offset, offset + take));
        offset += take;
      }
      // 조각이 바닥났고 프리픽스도 아직 불완전하다 — 다음 조각을 기다린다.
      if (this.tail - this.head < 4) break;

      // 2. 4바이트가 모인 즉시 길이를 검증한다. 본문까지 기다렸다가 검증하면 조각
      //    하나가 통째로 버퍼에 복사된 뒤에야 오류를 낸다.
      const length = this.peekLength();
      if (length === 0 || length > MAX_FRAME_BYTES) {
        throw new FrameError(`bad frame length ${length}`);
      }

      // 3. 이 프레임을 끝내는 데 필요한 만큼만 붙인다 — 조각에 다음 프레임이 더
      //    있어도 이 프레임을 내보낸 뒤에 이어서 처리한다.
      if (this.tail - this.head < 4 + length) {
        const take = Math.min(4 + length - (this.tail - this.head), chunk.length - offset);
        if (take > 0) {
          this.append(chunk.subarray(offset, offset + take));
          offset += take;
        }
      }
      // 본문이 아직 불완전하다 — 다음 조각을 기다린다.
      if (this.tail - this.head < 4 + length) break;

      // 4. 소비자에게는 프레임 본문 한 벌만 복사해 준다 — 내부 버퍼는 계속 재사용한다.
      frames.push(this.buffer.slice(this.head + 4, this.head + 4 + length));
      this.head += 4 + length;
      if (this.head === this.tail) {
        // 전부 소비했다 — 다음 프레임은 버퍼 맨 앞에서 시작한다.
        this.head = 0;
        this.tail = 0;
      }
    }
    return frames;
  }

  /** 버퍼 맨 앞 `[head, head+4)` 의 길이. 호출자는 4바이트가 모여 있음을 보장한다. */
  private peekLength(): number {
    return new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset + this.head,
      4,
    ).getUint32(0, false);
  }

  /** 조각을 버퍼 끝에 붙인다. 소비된 앞 구간은 `copyWithin` 으로 당겨 쓰고,
   *  그래도 모자랄 때만 두 배로 늘린다 — 총 복사량이 수신 바이트에 선형이다. */
  private append(chunk: Uint8Array): void {
    if (this.tail + chunk.length > this.buffer.length) {
      if (this.head > 0) {
        this.buffer.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
      }
      const needed = this.tail + chunk.length;
      if (needed > this.buffer.length) {
        let size = Math.max(this.buffer.length * 2, 64);
        while (size < needed) size *= 2;
        const grown = new Uint8Array(size);
        grown.set(this.buffer.subarray(0, this.tail));
        this.buffer = grown;
      }
    }
    this.buffer.set(chunk, this.tail);
    this.tail += chunk.length;
  }
}

export type Reply =
  | { id: number; ok: true; body: Record<string, unknown> }
  | { id: number; ok: false; status: number; message: string };

const decoder = new TextDecoder();

/** 서버 응답 하나. 모양이 어긋나면 `FrameError` 다 — 조용히 넘기면 어느 요청의
 *  응답인지 어긋난 채로 화면이 계속 그려진다. */
export function parseReply(payload: Uint8Array): Reply {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(payload));
  } catch {
    throw new FrameError("reply is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FrameError("reply is not an object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.v !== FRAME_VERSION) throw new FrameError(`unsupported reply version`);
  if (typeof obj.id !== "number" || !Number.isSafeInteger(obj.id) || obj.id < 0) {
    throw new FrameError("reply has no usable id");
  }
  if (obj.ok === true) return { id: obj.id, ok: true, body: obj };
  if (obj.ok === false) {
    if (typeof obj.status !== "number" || typeof obj.message !== "string") {
      throw new FrameError("error reply is malformed");
    }
    return { id: obj.id, ok: false, status: obj.status, message: obj.message };
  }
  throw new FrameError("reply has no ok flag");
}
