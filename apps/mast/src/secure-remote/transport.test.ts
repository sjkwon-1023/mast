// WebTransport 클라이언트의 계약 잠금 — 실제 Chrome 없이 프레임 왕복만 본다.
//
// 가짜 서버는 서버(`wt/conn.rs`)와 같은 순서 규율을 흉내 낸다: 첫 프레임은 auth,
// 요청 ID 는 단조 증가, 응답은 하나씩. 실기기(Chrome + 실제 QUIC + LAN 권한) 검증은
// 이 테스트로 대신할 수 없다 — 그 사실은 결과 보고에 적혀 있다.

import { describe, expect, it, vi } from "vitest";

import { RemoteError, TransportClosedError } from "../remote/transport";
import { FrameDecoder } from "./frames";
import { base64urlDecode, base64urlEncode } from "./base64url";
import {
  ConnectTimeoutError,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  TRANSPORT_CLOSED_MESSAGE,
  WebTransportClient,
} from "./transport";
import type { BidirectionalStreamLike, WebTransportLike } from "./transport";

type Json = Record<string, unknown>;

class FakeTransport implements WebTransportLike {
  readonly requests: Json[] = [];
  /** true 면 `ready` 가 거부된다 — TLS 단계 실패. */
  failReady = false;
  readonly closed: Promise<unknown>;
  /** 거부 약속은 한 번만 만들어 캐시한다 — `connect` 는 ready 를 두 번 읽고,
   *  매번 새로 거부하면 첫 약속이 처리자 없이 버려져 unhandled rejection 이 된다. */
  private readyRejection: Promise<void> | null = null;
  closedByClient = false;
  closeCalls = 0;
  /** true 면 스트림 쓰기가 실패한다 — QUIC 쓰기 오류 경로. */
  failWrites = false;
  /** true 면 스트림 쓰기가 끝나지 않는다 — 막힌 PTY 쓰기 뒤의 클라이언트. */
  holdWrites = false;
  /** 서버처럼 즉시 성공 응답을 보낼지. false 면 테스트가 respond() 로 직접 답한다. */
  auto = true;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly resolveClosed: (value?: unknown) => void;
  private readonly rejectClosed: (reason?: unknown) => void;

  constructor() {
    let resolveClosed!: (value?: unknown) => void;
    let rejectClosed!: (reason?: unknown) => void;
    this.closed = new Promise((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    this.resolveClosed = resolveClosed;
    this.rejectClosed = rejectClosed;
  }

  get ready(): Promise<void> {
    if (!this.failReady) return Promise.resolve();
    this.readyRejection ??= Promise.reject(new Error("TLS handshake failed"));
    return this.readyRejection;
  }

  createBidirectionalStream(): Promise<BidirectionalStreamLike> {
    const decoder = new FrameDecoder();
    const text = new TextDecoder();
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.failWrites) throw new Error("write failed");
        for (const payload of decoder.push(chunk)) {
          const body = JSON.parse(text.decode(payload)) as Json;
          this.requests.push(body);
          if (this.auto) this.respond({ v: 1, id: body.id, ok: true });
        }
        // 프레임은 이미 기록했다 — 기록 자체가 "보냈지만 끝나지 않았다"를 만든다.
        if (this.holdWrites) return new Promise<void>(() => undefined);
      },
    });
    return Promise.resolve({ readable, writable });
  }

  /** 서버가 보내는 것과 같은 모양의 프레임 하나. */
  respond(body: unknown): void {
    this.controller?.enqueue(frameOf(body));
  }

  /** 프레임 하나를 지정한 조각 크기들로 나눠 보낸다 — 실제 QUIC 스트림 경계는
   *  프레임 경계와 무관하다. 조각 크기 합이 모자라면 나머지는 한 덩어리로 간다. */
  respondSplit(body: unknown, sizes: number[]): void {
    const frame = frameOf(body);
    let offset = 0;
    for (const size of sizes) {
      if (offset >= frame.length) break;
      this.controller?.enqueue(frame.subarray(offset, offset + size));
      offset += size;
    }
    if (offset < frame.length) this.controller?.enqueue(frame.subarray(offset));
  }

  /** 스트림 EOF — 연결이 정상 종료된 것처럼. */
  endStream(): void {
    this.controller?.close();
  }

  /** 연결 실패 — `closed` 가 거부되고 읽기도 끊긴다. */
  dropConnection(): void {
    this.rejectClosed(new Error("connection failed"));
    this.controller?.error(new Error("connection failed"));
  }

  close(_info?: { closeCode?: number; reason?: string }): void {
    this.closeCalls += 1;
    this.closedByClient = true;
    this.resolveClosed();
  }
}

function frameOf(body: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const frame = new Uint8Array(4 + json.length);
  new DataView(frame.buffer).setUint32(0, json.length, false);
  frame.set(json, 4);
  return frame;
}

function clientOf(
  server: FakeTransport,
  extra: { heartbeatMs?: number; requestTimeoutMs?: number; connectTimeoutMs?: number } = {},
) {
  return new WebTransportClient({
    host: "192.168.0.20",
    port: 7331,
    certHash: new Uint8Array(32).fill(3),
    token: "tok",
    factory: () => server,
    heartbeatMs: 60_000,
    ...extra,
  });
}

async function until(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("WebTransportClient", () => {
  it("sends auth first and only then allows state/screen/input", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server);
    let connected = false;
    const connecting = client.connect().then(() => {
      connected = true;
    });
    await until(() => server.requests.length === 1, "the auth frame");
    expect(server.requests[0]).toEqual({
      v: 1,
      id: 1,
      type: "auth",
      token: "tok",
    });
    expect(connected).toBe(false);
    // 인증 응답 전에는 다른 요청도 나가지 않는다 — UI 가 먼저 뜰 수 없다는 계약이다.
    const early = client.fetchScreen(7, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.requests.length).toBe(1);
    server.respond({ v: 1, id: 1, ok: true });
    await connecting;
    expect(connected).toBe(true);
    await until(() => server.requests.length === 2, "the screen request after auth");
    expect(server.requests[1]).toMatchObject({ v: 1, id: 2, type: "screen", tab: 7 });
    server.respond({
      v: 1,
      id: 2,
      ok: true,
      endOffset: 0,
      reset: true,
      cols: 80,
      rows: 24,
      session: "1:2",
      bytes: "",
    });
    await expect(early).resolves.toMatchObject({ meta: { session: "1:2" } });
  });

  it("round-trips state, screen and input with the v1 field shapes", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server);
    const connecting = client.connect();
    await until(() => server.requests.length === 1, "the auth frame");
    server.respond({ v: 1, id: 1, ok: true });
    await connecting;

    const state = client.fetchState();
    await until(() => server.requests.length === 2, "the state request");
    server.respond({ v: 1, id: 2, ok: true, state: { revision: 7, state: {} } });
    await expect(state).resolves.toEqual({ revision: 7, state: {} });
    expect(server.requests[1]).toEqual({ v: 1, id: 2, type: "state" });

    let screenReply = client.fetchScreen(7, null);
    await until(() => server.requests.length === 3, "the reset screen request");
    expect(server.requests[2]).toEqual({ v: 1, id: 3, type: "screen", tab: 7 });
    server.respond({
      v: 1,
      id: 3,
      ok: true,
      endOffset: 12,
      reset: true,
      cols: 120,
      rows: 30,
      session: "1:2",
      bytes: base64urlEncode(new TextEncoder().encode("hi")),
    });
    await expect(screenReply).resolves.toMatchObject({
      meta: { endOffset: 12, reset: true, cols: 120, rows: 30, session: "1:2" },
    });
    await expect(screenReply).resolves.toMatchObject({ bytes: new TextEncoder().encode("hi") });

    screenReply = client.fetchScreen(7, { since: 12, session: "1:2" });
    await until(() => server.requests.length === 4, "the delta screen request");
    expect(server.requests[3]).toEqual({
      v: 1,
      id: 4,
      type: "screen",
      tab: 7,
      since: 12,
      session: "1:2",
    });
    server.respond({
      v: 1,
      id: 4,
      ok: true,
      endOffset: 12,
      reset: false,
      cols: 120,
      rows: 30,
      session: "1:2",
      bytes: "",
    });
    await expect(screenReply).resolves.toMatchObject({ bytes: new Uint8Array(0) });

    const input = client.postInput(7, "1:2", "테스트\r");
    await until(() => server.requests.length === 5, "the input request");
    const body = server.requests[4];
    expect(body).toMatchObject({ v: 1, id: 5, type: "input", tab: 7, session: "1:2" });
    const raw = base64urlDecode(body.data as string);
    expect(new TextDecoder().decode(raw as Uint8Array)).toBe("테스트\r");
    server.respond({ v: 1, id: 5, ok: true });
    await expect(input).resolves.toBeUndefined();
  });

  it("keeps one outstanding request and monotonic ids", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server);
    const connecting = client.connect();
    await until(() => server.requests.length === 1, "the auth frame");
    server.respond({ v: 1, id: 1, ok: true });
    await connecting;

    const first = client.fetchState();
    const second = client.fetchState();
    await until(() => server.requests.length === 2, "the first state request");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 첫 응답이 정착하기 전에는 두 번째가 나가지 않는다.
    expect(server.requests.length).toBe(2);
    expect(server.requests[1].id).toBe(2);

    server.respond({ v: 1, id: 2, ok: true, state: {} });
    await first;
    await until(() => server.requests.length === 3, "the second state request");
    expect(server.requests[2].id).toBe(3);
    server.respond({ v: 1, id: 3, ok: true, state: {} });
    await second;
  });

  it("surfaces a 503 input busy as a RemoteError", async () => {
    const server = new FakeTransport();
    const client = clientOf(server);
    await client.connect();
    server.auto = false;
    const input = client.postInput(7, "1:2", "x");
    await until(() => server.requests.length === 2, "the input request");
    server.respond({ v: 1, id: 2, ok: false, status: 503, message: "input busy" });
    const error = await input.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).status).toBe(503);
  });

  it("rejects input over 64 KiB locally with the HTTP-shaped 413", async () => {
    const server = new FakeTransport();
    const client = clientOf(server);
    await client.connect();
    const before = server.requests.length;
    const error = await client
      .postInput(7, "1:2", "x".repeat(65_537))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).status).toBe(413);
    // 프레임은 나가지 않는다 — 서버가 거부할 것을 보내고 연결을 잃지 않는다.
    expect(server.requests.length).toBe(before);
  });

  it("rejects a wrong token at connect time with the server status", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server);
    const connecting = client.connect();
    await until(() => server.requests.length === 1, "the auth frame");
    server.respond({ v: 1, id: 1, ok: false, status: 401, message: "unauthorized" });
    const error = await connecting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).status).toBe(401);
    // 연결은 이미 끝난 것으로 취급된다 — 이후 요청은 나가지 않는다.
    await expect(client.fetchState()).rejects.toBeInstanceOf(TransportClosedError);
    expect(server.requests.length).toBe(1);
  });

  it("fails connect when the transport's ready rejects", async () => {
    const server = new FakeTransport();
    server.failReady = true;
    const client = clientOf(server);
    await expect(client.connect()).rejects.toThrow("TLS handshake failed");
    // 실패한 연결은 닫힌 것으로 취급된다 — 이후 요청도 나가지 않는다.
    await expect(client.fetchState()).rejects.toBeInstanceOf(TransportClosedError);
    expect(server.requests.length).toBe(0);
    expect(server.closedByClient).toBe(true);
  });

  it("reassembles a reply that arrives in multiple stream chunks", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server);
    const connecting = client.connect();
    await until(() => server.requests.length === 1, "the auth frame");
    server.respond({ v: 1, id: 1, ok: true });
    await connecting;

    const state = client.fetchState();
    await until(() => server.requests.length === 2, "the state request");
    // 1·2·3바이트 조각 + 나머지 — 길이 프리픽스도 본문도 경계에 걸친다.
    server.respondSplit({ v: 1, id: 2, ok: true, state: { revision: 9, state: {} } }, [1, 2, 3]);
    await expect(state).resolves.toEqual({ revision: 9, state: {} });
  });

  it("stops everything when the connection drops, without reconnecting", async () => {
    const server = new FakeTransport();
    const client = clientOf(server);
    await client.connect();
    const messages: string[] = [];
    client.onClosed((message) => messages.push(message));

    server.auto = false;
    const pending = client.fetchState();
    await until(() => server.requests.length === 2, "the state request");
    server.dropConnection();

    await expect(pending).rejects.toBeInstanceOf(TransportClosedError);
    await until(() => messages.length === 1, "one close notification");
    expect(messages[0]).toContain("scan the pairing QR");
    // 재연결도, 추가 요청도 없다.
    await expect(client.fetchState()).rejects.toBeInstanceOf(TransportClosedError);
    expect(server.requests.length).toBe(2);
  });

  it("handles EOF on the stream as a close too", async () => {
    const server = new FakeTransport();
    const client = clientOf(server);
    await client.connect();
    const messages: string[] = [];
    client.onClosed((message) => messages.push(message));
    server.endStream();
    await until(() => messages.length === 1, "the close notification");
    expect(messages[0]).toBe(TRANSPORT_CLOSED_MESSAGE);
    // 로컬 판정 종료도 브라우저 연결을 즉시 내려야 한다.
    expect(server.closedByClient).toBe(true);
    expect(server.closeCalls).toBe(1);
  });

  it("closes on a reply that answers a different request", async () => {
    const server = new FakeTransport();
    const client = clientOf(server);
    await client.connect();
    const messages: string[] = [];
    client.onClosed((message) => messages.push(message));
    server.auto = false;
    const pending = client.fetchState();
    await until(() => server.requests.length === 2, "the state request");
    server.respond({ v: 1, id: 99, ok: true, state: {} });
    await expect(pending).rejects.toBeInstanceOf(TransportClosedError);
    await until(() => messages.length === 1, "the close notification");
    expect(messages[0]).toContain("unexpected reply");
    expect(server.closedByClient).toBe(true);
  });

  it("closes the browser transport when a write fails", async () => {
    const server = new FakeTransport();
    const client = clientOf(server);
    await client.connect();
    const messages: string[] = [];
    client.onClosed((message) => messages.push(message));
    server.failWrites = true;
    const pending = client.postInput(7, "1:2", "x");
    await expect(pending).rejects.toBeInstanceOf(TransportClosedError);
    await until(() => messages.length === 1, "the close notification");
    expect(server.closedByClient).toBe(true);
    // 쓰기 실패 뒤에는 어떤 요청도 나가지 않는다.
    const count = server.requests.length;
    await expect(client.fetchState()).rejects.toBeInstanceOf(TransportClosedError);
    expect(server.requests.length).toBe(count);
  });

  it("keeps the default request deadline above the server's 15s frame deadline", () => {
    // 서버는 프레임 읽기·쓰기와 입력 쓰기를 `frame_io` 15초로 묶는다 (conn.rs).
    // 클라이언트 마감이 그보다 짧으면 서버가 돌려줄 503/오류를 연결 종료로 바꿔 버린다.
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(15_000);
  });

  it("times out a stalled write and refuses the queued request", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server, { requestTimeoutMs: 30 });
    const connecting = client.connect();
    await until(() => server.requests.length === 1, "the auth frame");
    server.respond({ v: 1, id: 1, ok: true });
    await connecting;

    const messages: string[] = [];
    client.onClosed((message) => messages.push(message));
    server.holdWrites = true;
    const pending = client.fetchState();
    await until(() => server.requests.length === 2, "the stalled state write");
    const queued = client.fetchScreen(7, null);

    // 거부는 첫 요청 정착 직후 줄 선 요청까지 한꺼번에 온다 — 핸들러를 먼저 붙여
    // unhandled rejection 창을 만들지 않는다.
    const pendingFails = expect(pending).rejects.toBeInstanceOf(TransportClosedError);
    const queuedFails = expect(queued).rejects.toBeInstanceOf(TransportClosedError);
    await pendingFails;
    await queuedFails;
    await until(() => messages.length === 1, "the close notification");
    expect(messages[0]).toContain("scan the pairing QR");
    expect(server.closedByClient).toBe(true);
    // 줄을 선 요청은 프레임으로 나가지 않았다.
    expect(server.requests.length).toBe(2);
    await expect(client.fetchState()).rejects.toBeInstanceOf(TransportClosedError);
  });

  it("times out a missing reply and keeps the deadline off later requests", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server, { requestTimeoutMs: 30 });
    const connecting = client.connect();
    await until(() => server.requests.length === 1, "the auth frame");
    server.respond({ v: 1, id: 1, ok: true });
    await connecting;

    const messages: string[] = [];
    client.onClosed((message) => messages.push(message));
    const pending = client.fetchState();
    await until(() => server.requests.length === 2, "the state write");
    const queued = client.fetchScreen(7, null);

    const pendingFails = expect(pending).rejects.toBeInstanceOf(TransportClosedError);
    const queuedFails = expect(queued).rejects.toBeInstanceOf(TransportClosedError);
    await pendingFails;
    await queuedFails;
    await until(() => messages.length === 1, "the close notification");
    expect(messages[0]).toContain("stopped answering");
    expect(server.closedByClient).toBe(true);
    await expect(client.fetchState()).rejects.toBeInstanceOf(TransportClosedError);
    expect(server.requests.length).toBe(2);
  });

  it("does not close a connection whose reply lands inside the deadline", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server, { requestTimeoutMs: 500 });
    const connecting = client.connect();
    await until(() => server.requests.length === 1, "the auth frame");
    server.respond({ v: 1, id: 1, ok: true });
    await connecting;

    const pending = client.fetchState();
    await until(() => server.requests.length === 2, "the state write");
    server.respond({ v: 1, id: 2, ok: true, state: {} });
    await expect(pending).resolves.toEqual({});
    // 마감 타이머가 정착 뒤에도 남아 연결을 닫으면 안 된다.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.closedByClient).toBe(false);
    expect(server.closeCalls).toBe(0);
  });

  it("does not finish connect as alive when close wins the auth race", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server, { heartbeatMs: 25 });
    const connecting = client.connect();
    await until(() => server.requests.length === 1, "the auth frame");
    server.respond({ v: 1, id: 1, ok: true });
    server.endStream();
    await expect(connecting).rejects.toBeInstanceOf(TransportClosedError);
    expect(server.closedByClient).toBe(true);
    // heartbeat 타이머가 닫힌 연결 위에 다시 설치되지 않는다.
    const count = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.requests.length).toBe(count);
  });

  it("heartbeats on its own timer and closes on dispose", async () => {
    const server = new FakeTransport();
    const client = clientOf(server, { heartbeatMs: 25 });
    await client.connect();
    await until(() => server.requests.length === 2, "a heartbeat frame");
    expect(server.requests[1]).toMatchObject({ type: "heartbeat", id: 2 });
    client.dispose();
    expect(server.closedByClient).toBe(true);
    expect(server.closeCalls).toBe(1);
    const count = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.requests.length).toBe(count);
  });

  it("keeps dispose idempotent after the server already closed", async () => {
    const server = new FakeTransport();
    const client = clientOf(server);
    await client.connect();
    const messages: string[] = [];
    client.onClosed((message) => messages.push(message));
    server.endStream();
    await until(() => messages.length === 1, "the close notification");
    const closeCalls = server.closeCalls;
    client.dispose();
    client.dispose();
    expect(server.closeCalls).toBe(closeCalls);
    expect(messages.length).toBe(1);
  });
});


describe("초기 연결 중단", () => {
  for (const stage of ["connection", "stream"] as const) {
    for (const stop of ["timeout", "closed", "dispose"] as const) {
      it(`${stage} 대기 중 ${stop}이면 종료하고 늦은 완료로 인증하지 않는다`, async () => {
        vi.useFakeTimers();
        const server = new FakeTransport();
        let resume!: () => void;
        const held = new Promise<void>((resolve) => { resume = resolve; });
        if (stage === "connection") {
          Object.defineProperty(server, "ready", { value: held });
        } else {
          const createStream = server.createBidirectionalStream.bind(server);
          server.createBidirectionalStream = async () => {
            await held;
            return createStream();
          };
        }
        const client = clientOf(server);
        try {
          const connecting = client.connect();
          const failure = expect(connecting).rejects.toBeInstanceOf(
            stop === "timeout" ? ConnectTimeoutError : TransportClosedError,
          );
          await vi.advanceTimersByTimeAsync(0);
          if (stop === "timeout") await vi.advanceTimersByTimeAsync(DEFAULT_CONNECT_TIMEOUT_MS);
          else if (stop === "closed") server.dropConnection();
          else client.dispose();
          await failure;
          if (stop === "timeout") await expect(connecting).rejects.toMatchObject({ stage });
          expect(server.closedByClient).toBe(true);
          resume();
          await vi.advanceTimersByTimeAsync(DEFAULT_CONNECT_TIMEOUT_MS);
          expect(server.requests).toEqual([]);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          client.dispose();
          vi.useRealTimers();
        }
      });
    }
  }

  it("스트림 생성으로 넘어가도 초기 마감을 새로 시작하지 않는다", async () => {
    vi.useFakeTimers();
    const server = new FakeTransport();
    let ready!: () => void;
    Object.defineProperty(server, "ready", {
      value: new Promise<void>((resolve) => { ready = resolve; }),
    });
    server.createBidirectionalStream = () => new Promise(() => {});
    const client = clientOf(server);
    try {
      const connecting = client.connect();
      const failure = expect(connecting).rejects.toMatchObject({
        name: "ConnectTimeoutError", stage: "stream",
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_CONNECT_TIMEOUT_MS - 1);
      ready();
      await vi.advanceTimersByTimeAsync(1);
      await failure;
      expect(server.requests).toEqual([]);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it("연결 성공 뒤에는 초기 연결 마감이 남지 않는다", async () => {
    vi.useFakeTimers();
    const server = new FakeTransport();
    const client = clientOf(server, { heartbeatMs: 60_000 });
    try {
      await client.connect();
      await vi.advanceTimersByTimeAsync(DEFAULT_CONNECT_TIMEOUT_MS);
      expect(server.closedByClient).toBe(false);
      expect(server.requests).toHaveLength(1);
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });
});


describe("인증 응답의 고정 만료", () => {
  it("서버가 보낸 만료를 재연결 저장용으로 전달한다", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server);
    const connecting = client.connect();
    await until(() => server.requests.length === 1, "auth");
    const expiresAt = Date.now() + 60_000;
    server.respond({v: 1, id: 1, ok: true, expiresAt});
    await connecting;
    expect(client.expiresAt).toBe(expiresAt);
    client.dispose();
  });

  it("이미 만료된 인증 응답은 연결 성공으로 표시하지 않는다", async () => {
    const server = new FakeTransport();
    server.auto = false;
    const client = clientOf(server);
    const connecting = client.connect();
    const rejected = expect(connecting).rejects.toThrow("invalid pairing expiry");
    await until(() => server.requests.length === 1, "auth");
    server.respond({v: 1, id: 1, ok: true, expiresAt: Date.now() - 1});
    await rejected;
    expect(server.closedByClient).toBe(true);
  });
});
