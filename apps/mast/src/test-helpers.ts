// 여러 테스트 파일이 함께 쓰는 헬퍼. 앱 코드에서는 import 하지 않는다.

import type { Terminal } from "@xterm/xterm";
import type { TerminalView } from "./features/terminal/view";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function termOf(view: TerminalView): Terminal {
  return (view as unknown as { term: Terminal }).term;
}

/** attach 응답 본문 — 8바이트 LE 오프셋(0), first_attach 1바이트, replay 순이다. */
export function attachBody(replay = "", firstAttach = true): ArrayBuffer {
  const bytes = new TextEncoder().encode(replay);
  const out = new Uint8Array(9 + bytes.byteLength);
  out[8] = firstAttach ? 1 : 0;
  out.set(bytes, 9);
  return out.buffer;
}
