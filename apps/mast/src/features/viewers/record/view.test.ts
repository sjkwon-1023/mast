// @vitest-environment happy-dom
//
// 기록 바이트 → 터미널 배선 검증 (ADR-0018). 두 층으로 잠근다.
//
// 1. 스텁 — 무엇을 쓰는가: 바이트는 Uint8Array 로, 빈 기록은 안내 문자열로.
//    문자열 변환이 끼면 UTF-8 로 디코드되지 않는 replay 바이트가 U+FFFD 로 바뀐다.
// 2. 실제 `@xterm/headless` 인스턴스 — 그 바이트가 정말 파서를 지나 화면이 되는가.
//    v0.3.18 이 blind 로 나간 이유가 이 층의 부재였다 (라이브러리 예외가 write
//    루프 안에서 삼켜져 검은 화면만 남았다): 순수 판정만으로는 잡히지 않는다.
//
// happy-dom 환경인 이유는 record-view 를 import 하면 @xterm/addon-fit 의 UMD
// 래퍼가 로드 시점에 `self` 를 읽기 때문이다 (features/terminal/terminal.test.ts 와 같다).

import { Terminal } from "@xterm/headless";
import type { Terminal as BrowserTerminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";

import type { TabId } from "../../../shared/types";
import { EMPTY_RECORD_NOTICE, RecordView, writeRecord } from "./view";

const h = vi.hoisted(() => ({
  readTabRecord: vi.fn(async (_tab: TabId) => new ArrayBuffer(0)),
}));

vi.mock("../../../infrastructure/backend", () => ({
  readTabRecord: h.readTabRecord,
}));

function bodyOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** headless 인스턴스에 기록을 써 넣고 파서가 소화할 때까지 기다린다 — write 는
 *  비동기 큐라 빈 write 의 콜백이 앞선 write 의 완료 지점이 된다. */
async function render(body: ArrayBuffer): Promise<Terminal> {
  // `allowProposedApi` 없이는 `buffer` 접근이 throw 한다 (@xterm/headless 6.0.0 —
  // `@xterm/xterm` 브라우저 빌드와 다른 지점, v0.3.19 의 회귀).
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 6 });
  writeRecord(term, body);
  await new Promise<void>((resolve) => term.write("", resolve));
  return term;
}

function lineAt(term: Terminal, row: number): string {
  return term.buffer.active.getLine(row)?.translateToString(true) ?? "";
}

describe("writeRecord", () => {
  it("hands raw bytes to the terminal without a string round-trip", () => {
    const written: (Uint8Array | string)[] = [];
    const bytes = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff, 0x68, 0x69]);
    writeRecord({ write: (data) => written.push(data) }, bytes.buffer);
    expect(written).toHaveLength(1);
    expect(written[0]).toBeInstanceOf(Uint8Array);
    expect([...(written[0] as Uint8Array)]).toEqual([...bytes]);
  });

  it("writes the empty-record notice instead of leaving a blank screen", () => {
    const written: (Uint8Array | string)[] = [];
    writeRecord({ write: (data) => written.push(data) }, new ArrayBuffer(0));
    expect(written).toEqual([EMPTY_RECORD_NOTICE]);
  });

  it("replays a recorded screen through a real headless terminal", async () => {
    // 기록의 실제 모양: 모드 preamble(DECSET) + 커서 이동·SGR 이 섞인 출력.
    const term = await render(
      bodyOf("\x1b[?2004h\x1b[2J\x1b[HkwON\x1b[3;1H\x1b[32mbuild ok\x1b[0m"),
    );
    expect(lineAt(term, 0)).toBe("kwON");
    expect(lineAt(term, 2)).toBe("build ok");
    // preamble 의 모드도 파서를 지났다는 증거 — 기록이 재료 그대로라는 계약.
    expect(term.modes.bracketedPasteMode).toBe(true);
    term.dispose();
  });

  it("renders the notice for a tab whose record is empty", async () => {
    const term = await render(new ArrayBuffer(0));
    expect(lineAt(term, 0)).toBe(EMPTY_RECORD_NOTICE.trim());
    term.dispose();
  });
});

function keyDown(key: string, keyCode: number, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(ev, "keyCode", { get: () => keyCode });
  return ev;
}

// 기록 화면의 배선 — RecordView 가 띄운 실제 브라우저 xterm 을 쓴다. PTY 가 없어 입력이 나갈
// 곳이 없으므로 `onData` 로 막힘을 보고, 선택 복사는 클립보드 쓰기로 본다.
describe("RecordView 입력과 복사", () => {
  it("키 입력은 전송되지 않고, 선택한 텍스트는 Ctrl+C 로 복사된다", async () => {
    h.readTabRecord.mockResolvedValueOnce(bodyOf("copy me"));
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new RecordView(host, 7 as unknown as TabId);
    // RecordView 는 xterm 을 공개하지 않으므로 배선을 보려고 private 필드를 꺼내 본다.
    const term = (view as unknown as { term: BrowserTerminal }).term;
    try {
      // 기록 읽기는 생성 뒤 microtask 에서 돈다 — 그 write 가 끝난 뒤에 본다.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => term.write("", resolve));
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("copy me");

      const onData = vi.fn();
      term.onData(onData);
      term.textarea!.dispatchEvent(keyDown("Enter", 13));
      expect(onData).not.toHaveBeenCalled();

      term.select(0, 0, 4);
      term.textarea!.dispatchEvent(keyDown("c", 67, { ctrlKey: true }));
      expect(writeText).toHaveBeenCalledWith("copy");
    } finally {
      view.dispose();
      host.remove();
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});
