// 폰 표면 두 가지(Local HTTP / Secure Remote)가 공유하는 네트워크 계약.
//
// 목록·탭 렌더링, 2초 폴링, 입력 FIFO, 스크롤은 전부 이 인터페이스 위에서만 돈다 —
// 화면 코드가 `fetch` 나 `WebTransport` 를 직접 알면 Secure Remote 번들에 HTTP API
// 코드가 딸려 들어가고, Local HTTP 경로가 조용히 달라진다. 구현은 각각
// `api.ts`(HTTP)와 `src/secure-remote/transport.ts`(WebTransport)에 있다.
//
// 오류의 두 종류가 곧 UI 의 두 반응이다:
// - [`RemoteError`] 는 요청 하나의 거절이다 (상태 코드 의미는 기존 HTTP 와 같다).
// - [`TransportClosedError`] 는 연결 자체의 끝이다 — 재연결하지 않고 재스캔 안내만 낸다.

import type { ScreenMeta, ScreenQuery, SizeOwner } from "./protocol";
import type { StateSnapshot, TabId } from "../shared/types";

/** 폰 화면에 필요한 화면 응답 한 벌 — HTTP 헤더든 WT 프레임이든 같은 모양으로 온다. */
export interface ScreenReply {
  meta: ScreenMeta;
  bytes: Uint8Array;
}

/** 요청 하나가 거절됐다. 상태 코드 의미는 기존 HTTP 계약(401/404/409/429/503)을 따른다. */
export class RemoteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

/** 연결이 끝났다 — 같은 transport 로 더 요청할 수 없다. 페이지는 재스캔을 안내한다. */
export class TransportClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportClosedError";
  }
}

/** 서버가 "쓰기는 시작했지만 15초 안에 끝나지 않았다"를 알리는 정확한 문구
 *  (`crates/mast-remote/src/wt/conn.rs` 의 `503 input write timed out`).
 *
 *  이 503 은 `input busy`·`server stopping` 과 의미가 다르다: 요청이 제출되지
 *  않은 것이 아니라 **이미 시작된 쓰기가 취소되지 않고** 나중에 PTY 에 전달될
 *  수 있다. 그래서 화면은 이 경우만 "보냈는지 모른다"로 갈라 안내해야 하며,
 *  문자열이 계약이다 — 서버가 문구를 바꾸면 이 판정도 함께 바꿔야 한다. */
export const INPUT_WRITE_TIMED_OUT_MESSAGE = "input write timed out";

export function isInputWriteTimedOut(error: unknown): boolean {
  return (
    error instanceof RemoteError &&
    error.status === 503 &&
    error.message === INPUT_WRITE_TIMED_OUT_MESSAGE
  );
}

export interface RemoteTransport {
  fetchState(): Promise<StateSnapshot>;
  fetchScreen(tab: TabId, query: ScreenQuery | null): Promise<ScreenReply>;
  postResize?(tab: TabId, session: string, mode: SizeOwner, size?: { cols: number; rows: number }, options?: { keepalive?: boolean }): Promise<{ owner: SizeOwner }>;
  postInput(tab: TabId, session: string, data: string): Promise<void>;
  /** 연결 종료 알림 — 구독 해제 함수를 돌려준다. 이미 끝난 transport 는 즉시(마이크로태스크) 부른다. */
  onClosed?(handler: (message: string) => void): () => void;
  /** 페이지를 떠날 때의 정리 (Secure Remote 의 `transport.close()`). */
  dispose?(): void;
}

/** 글자 크기 기억. Local HTTP 만 저장하고 Secure Remote 는 메모리 값만 쓴다 —
 *  저장 구현(`local-store.ts`)이 Secure Remote 번들에 들어가지 않게 하는 이음매다. */
export interface FontPxStore {
  load(): number | null;
  save(px: number): void;
}
