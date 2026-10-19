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

/** 렌더 치수(CSS px). 6.0 Viewport 의 스크롤 단위라, 측정 경계가 실제 값을 냈는지 보는 데 쓴다. */
export function cssDimensionsOf(term: Terminal): {
  cell: { height: number };
  canvas: { height: number };
} {
  const core = (term as unknown as { _core: { _renderService: { dimensions: { css: unknown } } } })
    ._core;
  return core._renderService.dimensions.css as {
    cell: { height: number };
    canvas: { height: number };
  };
}

const CHAR_MEASURE_CELL_WIDTH = 9;
const CHAR_MEASURE_CELL_HEIGHT = 17;
// xterm DOM 측정 전략은 측정 span의 offsetWidth를 이 값으로 나눠 글자 폭을 얻는다.
const CHAR_MEASURE_REPEAT = 32;

/**
 * happy-dom 에는 레이아웃이 없어 xterm 글자 측정(`.xterm-char-measure-element`의
 * offsetWidth·offsetHeight)이 0이 된다. 그러면 셀·캔버스 높이도 0이라 Viewport 의 스크롤이
 * 0 좌표에 묶인다. 이 함수는 측정 경계의 두 값만 고정 치수로 채우고, Viewport·scroll·buffer
 * 코드는 그대로 실행한다.
 */
export function installCharMeasureGeometry(): void {
  const proto = HTMLElement.prototype;
  const originalWidth = Object.getOwnPropertyDescriptor(proto, "offsetWidth")?.get;
  const originalHeight = Object.getOwnPropertyDescriptor(proto, "offsetHeight")?.get;
  const isCharMeasure = (el: HTMLElement): boolean =>
    el.classList.contains("xterm-char-measure-element");
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (isCharMeasure(this)) return CHAR_MEASURE_CELL_WIDTH * CHAR_MEASURE_REPEAT;
      return originalWidth?.call(this) ?? 0;
    },
  });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (isCharMeasure(this)) return CHAR_MEASURE_CELL_HEIGHT;
      return originalHeight?.call(this) ?? 0;
    },
  });
}

/** attach 응답 본문 — 8바이트 LE 오프셋(0), first_attach 1바이트, replay 순이다. */
export function attachBody(replay = "", firstAttach = true): ArrayBuffer {
  const bytes = new TextEncoder().encode(replay);
  const out = new Uint8Array(9 + bytes.byteLength);
  out[8] = firstAttach ? 1 : 0;
  out.set(bytes, 9);
  return out.buffer;
}
