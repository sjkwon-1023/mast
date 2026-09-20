// Secure Remote 의 WebTransport 클라이언트 — 인증된 연결 하나에서 v1 프레임 왕복을 제공한다.
//
// 규율 셋.
//
// - **한 번에 하나의 미완료 요청.** 서버가 요청을 순차 처리하므로(conn.rs) 클라이언트도
//   체인으로 직렬화한다. 입력 순서가 이 체인에 실려 보존된다.
// - **재연결 없음.** `closed`/EOF/읽기 오류/쓰기 실패는 전부 종료다 — 화면은 재스캔
//   안내만 띄우고 스스로 다시 연결하지 않는다.
// - **인증이 먼저.** 첫 프레임은 반드시 `auth` 이고 성공 응답을 받은 뒤에야 화면·입력이
//   가능하다. 서버 계약과 같은 순서를 클라이언트에서도 강제한다 (그 전에 UI 가 뜨지 않는다).
//
// heartbeat 는 화면 폴링과 별개 타이머다. 폴링은 화면이 숨겨지면 멈추지만(가시성 게이트),
// 서버의 유휴 30초는 그때도 흐르므로 heartbeat 가 그 벽을 넘긴다. 백그라운드 탭의 타이머
// 조이기/정지는 계획이 인정한 한계다 — 그때는 서버가 닫고, 페이지는 재스캔 안내를 낸다.
//
// 요청마다 마감이 있다. 서버의 프레임 읽기·쓰기와 입력 쓰기는 `frame_io` 15초로 묶여
// 있으므로(conn.rs) 그보다 조금 긴 값이면 서버가 먼저 명시적 실패를 돌려줄 시간을 준다 —
// 마감이 서버보다 짧으면 회복 가능한 503 을 연결 종료로 바꿔 버린다. 마감에 걸리면
// 연결을 닫고 대기·후속 요청을 전부 거부한다. 스트림 `write` 가 끝나지 않는 경우도
// 같은 마감이 덮는다 (막힌 PTY 쓰기 뒤에서 heartbeat 가 줄을 서는 상황).

import { RemoteError, TransportClosedError } from "../remote/transport";
import type { RemoteTransport, ScreenReply } from "../remote/transport";
import { parseSizeOwner } from "../remote/protocol";
import type { ScreenQuery } from "../remote/protocol";
import { FrameDecoder, FrameError, encodeRequestFrame, parseReply } from "./frames";
import type { RequestPayload } from "./frames";
import { base64urlDecode } from "./base64url";
import type { StateSnapshot, TabId } from "../shared/types";

/** 브라우저 전역 `WebTransport` 의 duck type — 테스트가 같은 모양의 가짜를 넣는다. */
export interface BidirectionalStreamLike {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface WebTransportLike {
  readonly closed: Promise<unknown>;
  readonly ready?: Promise<unknown>;
  createBidirectionalStream(): Promise<BidirectionalStreamLike>;
  close(info?: { closeCode?: number; reason?: string }): void;
}

export interface WebTransportHashLike {
  algorithm: "sha-256";
  value: Uint8Array;
}

/** WebTransport 생성자가 던진 경우. **생성 성공이 `serverCertificateHashes` 지원의
 *  증거는 아니다** — WebIDL 사전에서 모르는 멤버는 조용히 무시되므로, 그 옵션을
 *  무시하는 브라우저도 생성은 통과하고 TLS 단계에서야 실패한다. 그래서 이 오류는
 *  "옵션 자체가 거부됐다"는 뜻일 뿐이고, 지원 판정은 실제 연결 결과로만 한다. */
export class WebTransportUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebTransportUnsupportedError";
  }
}

export type WebTransportFactory = (
  url: string,
  options: { serverCertificateHashes: WebTransportHashLike[] },
) => WebTransportLike;

export interface WebTransportClientOptions {
  host: string;
  port: number;
  certHash: Uint8Array;
  token: string;
  /** 테스트 주입. 기본은 브라우저 `WebTransport` 다. */
  factory?: WebTransportFactory;
  /** 서버 유휴 상한(30초)보다 짧아야 한다. */
  heartbeatMs?: number;
  /** 요청 왕복 하나의 마감. 기본은 서버의 `frame_io` 15초보다 긴 값이다. */
  requestTimeoutMs?: number;
}

/** 모든 종료가 같은 문구로 수렴한다 — 사용자가 다음에 할 일은 언제나 같다. */
export const TRANSPORT_CLOSED_MESSAGE = "Connection closed — scan the pairing QR in mast again.";

/** 마감에 걸린 종료의 문구 — 서버가 답하지 못한 경우와 구분해 원인을 보여 준다. */
export const REQUEST_TIMEOUT_MESSAGE =
  "mast stopped answering — scan the pairing QR in mast again.";

/** 서버가 프레임 하나를 끝내는 상한(15초)에 여유를 더한 값. 이보다 짧으면 서버가
 *  돌려줄 503/오류를 기다리지 못하고 연결을 끊는다. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

interface Pending {
  id: number;
  resolve(body: Record<string, unknown>): void;
  reject(error: Error): void;
}

const DEFAULT_HEARTBEAT_MS = 10_000;

export class WebTransportClient implements RemoteTransport {
  private readonly options: WebTransportClientOptions;
  private transport: WebTransportLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly decoder = new FrameDecoder();
  private nextId = 1;
  private pending: Pending | null = null;
  /** 직렬화 체인 — 이전 요청이 정착해야 다음이 나간다. */
  private tail: Promise<void> = Promise.resolve();
  private closedReason: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closedHandlers: ((message: string) => void)[] = [];

  constructor(options: WebTransportClientOptions) {
    this.options = options;
  }

  /** 연결 + 스트림 + auth 왕복까지. 실패하면 transport 는 이미 닫힌 상태다. */
  async connect(): Promise<void> {
    const factory = this.options.factory ?? defaultFactory;
    const url = `https://${this.options.host}:${this.options.port}/wt`;
    let transport: WebTransportLike;
    try {
      transport = factory(url, {
        serverCertificateHashes: [{ algorithm: "sha-256", value: this.options.certHash }],
      });
    } catch (error) {
      throw new WebTransportUnsupportedError(describe(error));
    }
    this.transport = transport;
    // 종료는 어느 쪽에서 와도 같은 곳으로 모인다. `closed` 는 정상 종료에 이행하고
    // 연결 오류에 거부된다 — 둘 다 우리에게는 "끝났다"다.
    transport.closed.then(
      () => this.markClosed(TRANSPORT_CLOSED_MESSAGE),
      () => this.markClosed(TRANSPORT_CLOSED_MESSAGE),
    );

    try {
      if (transport.ready !== undefined) await transport.ready;
      const stream = await transport.createBidirectionalStream();
      this.writer = stream.writable.getWriter();
      this.reader = stream.readable.getReader();
      void this.readLoop();
      await this.request({ type: "auth", token: this.options.token });
      // auth 응답과 `closed` 가 경합했다면 살아 있는 연결처럼 완료하지 않는다 —
      // 여기서 끝내야 호출자가 "연결됨" 화면을 세우지 않는다.
      if (this.closedReason !== null) {
        throw new TransportClosedError(this.closedReason);
      }
    } catch (error) {
      this.markClosed(TRANSPORT_CLOSED_MESSAGE);
      throw error;
    }
    this.startHeartbeat();
  }

  async fetchState(): Promise<StateSnapshot> {
    const body = await this.request({ type: "state" });
    const state = body.state;
    if (typeof state !== "object" || state === null) throw malformedReply();
    return state as StateSnapshot;
  }

  async fetchScreen(tab: TabId, query: ScreenQuery | null): Promise<ScreenReply> {
    const body = await this.request({ type: "screen", tab, query });
    const { endOffset, reset, cols, rows, session, bytes } = body;
    if (!isCount(endOffset) || typeof reset !== "boolean") throw malformedReply();
    if (!isCount(cols) || !isCount(rows)) throw malformedReply();
    if (typeof session !== "string" || session === "") throw malformedReply();
    if (typeof bytes !== "string") throw malformedReply();
    const decoded = base64urlDecode(bytes);
    if (decoded === null) throw malformedReply();
    const sizeOwner = body.sizeOwner === undefined ? "desktop" : parseSizeOwner(String(body.sizeOwner));
    if (sizeOwner === null) throw malformedReply();
    return { meta: { endOffset, reset, cols, rows, session, sizeOwner }, bytes: decoded };
  }

  async postInput(tab: TabId, session: string, data: string): Promise<void> {
    await this.request({ type: "input", tab, session, data });
  }

  onClosed(handler: (message: string) => void): () => void {
    if (this.closedReason !== null) {
      const message = this.closedReason;
      queueMicrotask(() => handler(message));
      return () => undefined;
    }
    this.closedHandlers.push(handler);
    return () => {
      this.closedHandlers = this.closedHandlers.filter((candidate) => candidate !== handler);
    };
  }

  /** `pagehide` — 열린 연결을 우리 쪽에서 닫는다. 서버도 곧 페어링을 정리한다.
   *  이미 끝난 연결에서는 markClosed 가 no-op 이므로 여러 번 불러도 안전하다. */
  dispose(): void {
    this.markClosed(TRANSPORT_CLOSED_MESSAGE);
  }

  /** 요청 하나를 체인 끝에 붙인다. 반환값은 그 요청의 응답 본문 또는 오류다. */
  private request(payload: RequestPayload): Promise<Record<string, unknown>> {
    if (this.closedReason !== null) {
      return Promise.reject(new TransportClosedError(this.closedReason));
    }
    const run = (): Promise<Record<string, unknown>> => {
      if (this.closedReason !== null) {
        return Promise.reject(new TransportClosedError(this.closedReason));
      }
      // 요청 ID 는 여기서만 발급한다 — 서버가 단조 증가를 강제하므로 heartbeat 도
      // 같은 카운터를 지나야 한다.
      const id = this.nextId;
      this.nextId += 1;
      return this.roundTrip(id, payload);
    };
    const result = this.tail.then(run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async roundTrip(id: number, payload: RequestPayload): Promise<Record<string, unknown>> {
    const writer = this.writer;
    if (writer === null || this.closedReason !== null) {
      throw new TransportClosedError(this.closedReason ?? TRANSPORT_CLOSED_MESSAGE);
    }
    let frame: Uint8Array;
    try {
      frame = encodeRequestFrame(id, payload);
    } catch (error) {
      // 64 KiB 를 넘는 입력은 서버에 닿기 전에 여기서 막힌다. HTTP 표면의 413 과
      // 같은 의미로 돌려줘야 UI 가 "too long to send" 안내와 원문 복구를 그대로 쓴다.
      if (error instanceof FrameError && payload.type === "input") {
        throw new RemoteError(413, "input too large");
      }
      throw error;
    }
    const settled = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending = { id, resolve, reject };
    });
    // 쓰기와 응답을 한 마감 안에서 기다린다. 쓰기가 멈춰 있으면 그 자체로, 쓰기가
    // 끝났는데 응답이 없으면 대기로 마감에 걸린다 — 둘 다 연결 종료로 수렴한다.
    // `Promise.all` 이 두 약속에 **즉시** 핸들러를 달아 주므로, 쓰기가 아직 안 끝난
    // 채 마감이 `settled` 를 거부해도 unhandled rejection 으로 새지 않는다.
    const work = (async (): Promise<Record<string, unknown>> => {
      const [, body] = await Promise.all([
        writer.write(frame).catch(() => {
          this.markClosed(TRANSPORT_CLOSED_MESSAGE);
        }),
        settled,
      ]);
      return body;
    })();
    return this.withDeadline(work);
  }

  /** `work` 가 마감을 넘기면 연결을 닫고 거부한다. 타이머는 정착 시 항상 지운다 —
   *  살아 있는 요청의 마감이 다음 요청의 종료로 이어지면 안 된다. */
  private async withDeadline<T>(work: Promise<T>): Promise<T> {
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // markClosed 가 대기 중인 요청과 뒤에 줄 선 요청을 전부 거부한다.
        this.markClosed(REQUEST_TIMEOUT_MESSAGE);
        reject(new TransportClosedError(REQUEST_TIMEOUT_MESSAGE));
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private async readLoop(): Promise<void> {
    const reader = this.reader;
    if (reader === null) return;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        for (const payload of this.decoder.push(value)) this.deliver(payload);
      }
      this.markClosed(TRANSPORT_CLOSED_MESSAGE);
    } catch {
      this.markClosed(TRANSPORT_CLOSED_MESSAGE);
    }
  }

  private deliver(payload: Uint8Array): void {
    const reply = parseReply(payload);
    const pending = this.pending;
    if (pending === null || pending.id !== reply.id) {
      // 응답 순서가 어긋났다 — 이 스트림은 더 믿을 수 없다.
      this.markClosed("mast sent an unexpected reply — scan the pairing QR again.");
      return;
    }
    this.pending = null;
    if (reply.ok) pending.resolve(reply.body);
    else pending.reject(new RemoteError(reply.status, reply.message));
  }

  private startHeartbeat(): void {
    // 종료된 뒤에는 타이머를 만들지 않는다 — 인증 직후 `closed` 가 이긴 경합에서
    // heartbeat 가 닫힌 연결 위에 다시 설치되는 것을 막는다.
    if (this.closedReason !== null || this.heartbeat !== null) return;
    const every = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.heartbeat = setInterval(() => {
      void this.request({ type: "heartbeat" }).catch(() => undefined);
    }, every);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === null) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private markClosed(message: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = message;
    this.stopHeartbeat();
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new TransportClosedError(message));
    // 로컬에서 판정한 종료(EOF·프레임/응답 불일치·쓰기 실패)에서도 브라우저
    // 연결을 즉시 내린다 — 스트림만 끝나고 QUIC 자원이 남는 것을 막는다.
    // 서버가 보낸 `closed` 로 들어와도, 이미 끝난 연결에서도 무해하다(close 는
    // no-op 이거나 던져도 삼킨다).
    this.closeTransport();
    const handlers = this.closedHandlers;
    this.closedHandlers = [];
    for (const handler of handlers) {
      try {
        handler(message);
      } catch {
        // 화면 쪽 콜백이 던져도 종료 처리는 끝난 것으로 본다.
      }
    }
  }

  private closeTransport(): void {
    try {
      this.transport?.close({ closeCode: 0, reason: "closed" });
    } catch {
      // 이미 닫힌 연결이다.
    }
  }
}

function defaultFactory(
  url: string,
  options: { serverCertificateHashes: WebTransportHashLike[] },
): WebTransportLike {
  // TS 5.9 의 `Uint8Array<ArrayBufferLike>` 와 lib.dom 의 `BufferSource` 제네릭이
  // 맞지 않아 캐스팅한다 — 런타임 값은 그대로 32바이트 Uint8Array 다.
  return new WebTransport(url, options as WebTransportOptions);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function malformedReply(): RemoteError {
  return new RemoteError(500, "mast sent a malformed reply");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
