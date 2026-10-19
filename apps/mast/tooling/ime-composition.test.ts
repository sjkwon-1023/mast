// @vitest-environment happy-dom
//
// 회귀 잠금 — 실제 `@xterm/xterm` 6.0 배포 번들 두 벌(CJS `lib/xterm.js`, ESM `lib/xterm.mjs`)에
// 같은 IME 이벤트 열을 넣고 `onData` 로 나가는 문자열을 본다 (ADR-0020). 순수 판정으로는 잡을 수
// 없는 결함이다: 고장은 xterm 내부의 zero-delay 타이머와 브라우저가 키 이벤트를 넣는 순서 사이에
// 있다. 이 잠금은 지연 조합 전송 경로만 본다. 6.0에 남은 업스트림 IME 문제(#6089 등)를 해결했다는
// 증거가 아니다.
//
// 이벤트 열은 두벌식으로 "테스트 문장"을 치는 것이다. `테` 뒤에 `ㅅ` 이 받침으로
// 붙었다가(`텟`) `ㅡ` 가 오면 다음 글자로 넘어가므로 compositionend 와 다음
// compositionstart 가 **한 태스크 안에** 붙어 온다 — 필드 로그가 보여 준 같은
// 밀리초의 쌍이 이것이다. `flushEvery` 는 zero-delay 타이머가 한 번 돌기 전에
// 브라우저가 처리하는 키 수: 1 이면 한가한 메인 스레드, 그 이상은 출력이 쏟아지는
// pane 옆에서 치는 상황의 모델이다.

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

type TerminalCtor = new (options: { cols: number; rows: number }) => XtermTerminal;

// 패키지 이름으로 import 하면 테스트 러너가 CJS 를 고르므로 두 파일을 경로로 직접 연다.
const XTERM_LIB = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/@xterm/xterm/lib");
const require = createRequire(import.meta.url);
const Cjs = (require(resolve(XTERM_LIB, "xterm.js")) as { Terminal: TerminalCtor }).Terminal;
const Esm = ((await import(pathToFileURL(resolve(XTERM_LIB, "xterm.mjs")).href)) as {
  Terminal: TerminalCtor;
}).Terminal;

type Op =
  | { t: "compose"; text: string }
  | { t: "commit"; text: string }
  | { t: "plain"; text: string };

/** 키 한 번에 브라우저가 내는 이벤트 묶음. commit 뒤의 compose 는 받침이 넘어가며
 *  같은 키에서 새 조합이 시작되는 경우다. */
const SENTENCE: Op[][] = [
  [{ t: "compose", text: "ㅌ" }],
  [{ t: "compose", text: "테" }],
  [{ t: "compose", text: "텟" }],
  [{ t: "commit", text: "테" }, { t: "compose", text: "스" }],
  [{ t: "compose", text: "슽" }],
  [{ t: "commit", text: "스" }, { t: "compose", text: "트" }],
  [{ t: "commit", text: "트" }, { t: "plain", text: " " }],
  [{ t: "compose", text: "ㅁ" }],
  [{ t: "compose", text: "무" }],
  [{ t: "compose", text: "문" }],
  [{ t: "compose", text: "묺" }],
  [{ t: "commit", text: "문" }, { t: "compose", text: "자" }],
  [{ t: "compose", text: "장" }],
  [{ t: "commit", text: "장" }],
];

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function typeSentence(Terminal: TerminalCtor, flushEvery: number): Promise<string> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new Terminal({ cols: 80, rows: 24 });
  term.open(host);
  const textarea = host.querySelector("textarea");
  if (textarea === null) throw new Error("xterm did not create its textarea");
  const sent: string[] = [];
  term.onData((data) => sent.push(data));

  let committed = "";
  let composing: string | null = null;
  const sync = () => {
    textarea.value = committed + (composing ?? "");
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  };
  const composition = (type: string, data: string) =>
    textarea.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));

  let pressed = 0;
  for (const ops of SENTENCE) {
    // IME 가 삼키는 키는 keyCode 229 / key "Process" 로 온다.
    const keydown = new KeyboardEvent("keydown", { key: "Process", bubbles: true, cancelable: true });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    Object.defineProperty(keydown, "isComposing", { value: composing !== null });
    textarea.dispatchEvent(keydown);
    for (const op of ops) {
      if (op.t === "compose") {
        if (composing === null) {
          composition("compositionstart", "");
          composing = "";
        }
        composition("compositionupdate", op.text);
        composing = op.text;
      } else if (op.t === "commit") {
        composition("compositionend", op.text);
        committed += op.text;
        composing = null;
      } else {
        committed += op.text;
      }
      sync();
    }
    pressed += 1;
    if (pressed % flushEvery === 0) {
      await tick();
      await tick();
    }
  }
  await tick();
  await tick();
  await tick();
  term.dispose();
  host.remove();
  return sent.join("");
}

const BUNDLES: [string, TerminalCtor][] = [
  ["lib/xterm.js (CJS)", Cjs],
  ["lib/xterm.mjs (ESM)", Esm],
];
const FLUSH_EVERY = [1, 2, 3, 4, SENTENCE.length];

describe.each(BUNDLES)("@xterm/xterm 6.0 %s", (_bundle, Terminal) => {
  it("flush 간격과 무관하게 친 그대로 보낸다", async () => {
    for (const flushEvery of FLUSH_EVERY) {
      expect(await typeSentence(Terminal, flushEvery), `flushEvery=${flushEvery}`).toBe(
        "테스트 문장",
      );
    }
  });
});
