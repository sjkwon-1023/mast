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
import { describe, expect, it, vi } from "vitest";

import {
  XtermCompositionShadow,
  installFrontEndLogging,
  installImeCommitDiagnostics,
} from "../src/infrastructure/logging";
import type { UiSettings } from "../src/infrastructure/backend";

const logLines = vi.hoisted(() => [] as string[]);

vi.mock("../src/infrastructure/backend", () => ({
  logLine: (text: string) => {
    logLines.push(text);
    return Promise.resolve();
  },
}));

function loggingOn(): void {
  const settings: UiSettings = {
    fontFamily: null,
    fontSize: null,
    highlightLanguages: null,
    log: true,
    remote: null,
    showTabIds: null,
    macOptionIsMeta: null,
  };
  installFrontEndLogging(settings, new EventTarget());
}

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
  | { t: "plain"; text: string }
  | { t: "key" };

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

/** 순수 확정만 있는 열 — 일반 키·공백 없이 이어 치는 두벌식. 받침이 넘어가는 키에서
 *  commit 과 다음 compose 가 같은 태스크에 온다. 진단이 이 묶음을 match=true 로
 *  정산하는지 보는 입력이다. */
const COMMITS: Op[][] = [
  [{ t: "compose", text: "ㅌ" }],
  [{ t: "compose", text: "테" }],
  [{ t: "compose", text: "텟" }],
  [{ t: "commit", text: "테" }, { t: "compose", text: "스" }],
  [{ t: "compose", text: "슽" }],
  [{ t: "commit", text: "스" }, { t: "compose", text: "트" }],
  [{ t: "compose", text: "트" }],
  [{ t: "commit", text: "트" }],
];

/** 확정 직후에 IME 를 거치지 않는 일반 키를 끼워 넣은 열 — 비교를 보류해야 한다. */
const MIXED: Op[][] = [
  [{ t: "compose", text: "ㅌ" }],
  [{ t: "compose", text: "테" }],
  [{ t: "commit", text: "테" }],
  [{ t: "key" }],
  [{ t: "compose", text: "스" }],
  [{ t: "commit", text: "스" }],
];

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function typeOps(
  Terminal: TerminalCtor,
  flushEvery: number,
  script: Op[][],
  watchCommits: boolean,
): Promise<{ text: string; commits: string[] }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new Terminal({ cols: 80, rows: 24 });
  term.open(host);
  const textarea = host.querySelector("textarea");
  if (textarea === null) throw new Error("xterm did not create its textarea");
  logLines.length = 0;
  const diagnostics = watchCommits ? installImeCommitDiagnostics(term, 7) : null;
  const sent: string[] = [];
  term.onData((data) => sent.push(data));

  let committed = "";
  let composing: string | null = null;
  const sync = () => {
    textarea.value = committed + (composing ?? "");
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  };
  // happy-dom 의 CompositionEvent 는 data init 을 버리므로 직접 얹는다 — xterm 과
  // 진단이 읽는 것은 이 프로퍼티 하나뿐이다 (src/infrastructure/logging.test.ts 와 같은 이유).
  const composition = (type: string, data: string) => {
    const ev = new Event(type, { bubbles: true });
    Object.defineProperty(ev, "data", { value: data });
    return textarea.dispatchEvent(ev);
  };

  let pressed = 0;
  for (const ops of script) {
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
      } else if (op.t === "key") {
        // IME 를 거치지 않는 일반 키 — 확정 묶음과 겹치면 비교를 보류해야 한다.
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
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
  await tick();
  diagnostics?.dispose();
  term.dispose();
  host.remove();
  return {
    text: sent.join(""),
    commits: logLines.filter((line) => line.startsWith("ime: commit")),
  };
}

async function typeSentence(Terminal: TerminalCtor, flushEvery: number): Promise<string> {
  return (await typeOps(Terminal, flushEvery, SENTENCE, false)).text;
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

  it("순수 확정 묶음은 실제 전송과 일치한다", async () => {
    loggingOn();
    for (const flushEvery of [1, COMMITS.length]) {
      const { text, commits } = await typeOps(Terminal, flushEvery, COMMITS, true);
      expect(text, `flushEvery=${flushEvery}`).toBe("테스트");
      // 확정과 전송이 실제로 관찰됐고, 어느 묶음도 unknown 으로 새지 않았다.
      expect(commits.length, `flushEvery=${flushEvery}`).toBeGreaterThan(0);
      // 어댑터 없이 xterm 이 직접 보낸 것이므로 진단이 따라간 xterm 구간도 확정과 같아야 한다.
      for (const line of commits) expect(line).toMatch(/match=true .* xtermWindow=same$/);
    }
  });

  it("조합이 229 지연 diff 보다 먼저 끝나면 진단도 xterm 이 실제로 보낸 diff 를 따른다", async () => {
    // xterm 은 조합 밖의 229 keydown 마다 textarea diff 를 예약하고, 그 타이머가 조합이 끝난 뒤
    // 돌면 diff 를 보내고 end 구간을 `_dataAlreadySent` 만큼 민다. 이미 확정된 '가' 뒤에서
    // 입력창이 '다나' 로 바뀐 채 end('나') 가 타이머보다 먼저 오면 xterm 은 '다나' 를 보낸다.
    loggingOn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24 });
    term.open(host);
    const textarea = host.querySelector("textarea");
    if (textarea === null) throw new Error("xterm did not create its textarea");
    logLines.length = 0;
    const diagnostics = installImeCommitDiagnostics(term, 7);
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    const composition = (type: string, data: string) => {
      const ev = new Event(type, { bubbles: true });
      Object.defineProperty(ev, "data", { value: data });
      textarea.dispatchEvent(ev);
    };
    try {
      textarea.value = "가";
      const keydown = new KeyboardEvent("keydown", { key: "Process", bubbles: true, cancelable: true });
      Object.defineProperty(keydown, "keyCode", { value: 229 });
      textarea.dispatchEvent(keydown);
      composition("compositionstart", "");
      textarea.value = "다나";
      composition("compositionupdate", "나");
      composition("compositionend", "나");
      for (let i = 0; i < 4; i += 1) await tick();

      expect(sent.join("")).toBe("다나");
      const commits = logLines.filter((line) => line.startsWith("ime: commit"));
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatch(/match=false .* xtermWindow=differs$/);
    } finally {
      diagnostics?.dispose();
      term.dispose();
      host.remove();
    }
  });

  it("라이브러리 전제: 조합 중 한자 키는 xterm 이 음절을 먼저 보내고 조합을 끝낸 것으로 본다", async () => {
    // Windows 어댑터는 한자 키에서 조합을 끊지 않는다(windows-ime.ts). 진단의 xtermWindow 는 이
    // xterm 동작을 따라가야 한다 — 어댑터 쪽 판정은 windows-ime-dom.test.ts 가 본다.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24 });
    term.open(host);
    const textarea = host.querySelector("textarea");
    if (textarea === null) throw new Error("xterm did not create its textarea");
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    const composition = (type: string, data: string) => {
      const ev = new Event(type, { bubbles: true });
      Object.defineProperty(ev, "data", { value: data });
      textarea.dispatchEvent(ev);
    };
    const keydown = (key: string, keyCode: number) => {
      const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      Object.defineProperty(ev, "keyCode", { value: keyCode });
      textarea.dispatchEvent(ev);
    };
    try {
      textarea.value = "가";
      composition("compositionstart", "");
      textarea.value = "가한";
      composition("compositionupdate", "한");
      await tick();
      keydown("HanjaMode", 25);
      keydown("Process", 229);
      textarea.value = "가韓";
      composition("compositionupdate", "韓");
      composition("compositionend", "韓");
      for (let i = 0; i < 4; i += 1) await tick();

      expect(sent).toEqual(["한", "가韓"]);
    } finally {
      term.dispose();
      host.remove();
    }
  });

  it("확정 묶음과 겹친 일반 키는 unknown 이다", async () => {
    loggingOn();
    const { commits } = await typeOps(Terminal, COMMITS.length, MIXED, true);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.join("\n")).toContain("match=unknown reason=mixed-input");
  });
});

/** 원본 번들과 진단의 그림자(XtermCompositionShadow)에 같은 DOM 이벤트를 넣는 장치. 그림자는
 *  element capture 에서 xterm 보다 먼저 같은 이벤트를 받으므로 타이머 순서도 이벤트마다 같다. */
function twin(Terminal: TerminalCtor) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new Terminal({ cols: 80, rows: 24 });
  term.open(host);
  const textarea = host.querySelector("textarea");
  if (textarea === null || term.element === undefined) throw new Error("xterm did not open");
  const stock: string[] = [];
  const traced: string[] = [];
  term.onData((data) => stock.push(data));
  const shadow = new XtermCompositionShadow(textarea, (data) => traced.push(data));
  const element = term.element;
  element.addEventListener("compositionstart", () => shadow.compositionStart(), true);
  element.addEventListener("compositionupdate", () => shadow.compositionUpdate(), true);
  element.addEventListener("compositionend", () => shadow.compositionEnd(), true);
  element.addEventListener("keydown", (ev) => shadow.keydown((ev as KeyboardEvent).keyCode), true);

  const composition = (type: string, data: string, value?: string) => {
    if (value !== undefined) textarea.value = value;
    const ev = new Event(type, { bubbles: true });
    Object.defineProperty(ev, "data", { value: data });
    textarea.dispatchEvent(ev);
  };
  const keydown = (key: string, keyCode: number) => {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { value: keyCode });
    textarea.dispatchEvent(ev);
  };
  return {
    textarea,
    composition,
    keydown,
    async settle(): Promise<{ stock: string[]; traced: string[] }> {
      for (let i = 0; i < 4; i += 1) await tick();
      shadow.dispose();
      term.dispose();
      host.remove();
      return { stock, traced };
    },
  };
}

describe.each(BUNDLES)("XtermCompositionShadow 대 @xterm/xterm 6.0 %s", (_bundle, Terminal) => {
  it("두벌식 문장을 flush 간격과 무관하게 같이 보낸다", async () => {
    for (const flushEvery of FLUSH_EVERY) {
      const t = twin(Terminal);
      let committed = "";
      let composing: string | null = null;
      let pressed = 0;
      for (const ops of SENTENCE) {
        t.keydown("Process", 229);
        for (const op of ops) {
          if (op.t === "compose") {
            if (composing === null) {
              t.composition("compositionstart", "");
              composing = "";
            }
            composing = op.text;
            t.composition("compositionupdate", op.text, committed + composing);
          } else if (op.t === "commit") {
            committed += op.text;
            composing = null;
            t.composition("compositionend", op.text, committed);
          } else if (op.t === "plain") {
            committed += op.text;
            t.textarea.value = committed;
          }
        }
        pressed += 1;
        if (pressed % flushEvery === 0) {
          await tick();
          await tick();
        }
      }
      const { stock, traced } = await t.settle();
      expect(traced, `flushEvery=${flushEvery}`).toEqual(stock);
    }
  });

  it("앞 확정 뒤 입력창이 바뀐 채 end 가 diff 보다 먼저 와도 같이 보낸다", async () => {
    const t = twin(Terminal);
    t.textarea.value = "가";
    t.keydown("Process", 229);
    t.composition("compositionstart", "");
    t.composition("compositionupdate", "나", "다나");
    t.composition("compositionend", "나");
    const { stock, traced } = await t.settle();
    expect(stock).toEqual(["다나"]);
    expect(traced).toEqual(stock);
  });

  it("한자 키 뒤 후보 update 와 end 가 한 태스크에 와도 같이 보낸다", async () => {
    const t = twin(Terminal);
    t.textarea.value = "가";
    t.composition("compositionstart", "");
    t.composition("compositionupdate", "한", "가한");
    await tick();
    t.keydown("HanjaMode", 25);
    t.keydown("Process", 229);
    t.composition("compositionupdate", "韓", "가韓");
    t.composition("compositionend", "韓");
    const { stock, traced } = await t.settle();
    expect(stock).toEqual(["한", "가韓"]);
    expect(traced).toEqual(stock);
  });

  it("한자 키 뒤 229 diff 가 end 보다 먼저 돌아도 같이 보낸다", async () => {
    const t = twin(Terminal);
    t.composition("compositionstart", "");
    t.composition("compositionupdate", "한", "한");
    t.keydown("HanjaMode", 25);
    t.keydown("Process", 229);
    t.composition("compositionupdate", "韓", "韓");
    await tick();
    t.composition("compositionend", "韓");
    const { stock, traced } = await t.settle();
    // windows-ime-dom.test.ts 의 같은 열이 이 합을 전제로 xtermWindow=same 을 기대한다.
    expect(stock.join("")).toBe("韓");
    expect(traced).toEqual(stock);
  });

  it("앞 확정이 정산되기 전 다음 조합의 한자 키도 같이 보낸다", async () => {
    // windows-ime-dom.test.ts 의 묶음 귀속 테스트와 같은 열 — xterm 의 전송 순서를 고정한다.
    const t = twin(Terminal);
    t.composition("compositionstart", "");
    t.composition("compositionupdate", "가", "가");
    t.composition("compositionend", "가");
    t.composition("compositionstart", "");
    t.composition("compositionupdate", "한", "가한");
    setTimeout(() => t.keydown("HanjaMode", 25), 0);
    await tick();
    await tick();
    t.composition("compositionupdate", "韓", "가韓");
    t.composition("compositionend", "韓");
    const { stock, traced } = await t.settle();
    expect(stock).toEqual(["가", "한", "韓"]);
    expect(traced).toEqual(stock);
  });

  it("첫 end 타이머 뒤 새 조합이 끼어들어 오래된 타이머가 다시 보내도 같이 보낸다", async () => {
    const t = twin(Terminal);
    t.composition("compositionstart", "");
    t.composition("compositionend", "가", "가");
    // 첫 end 의 타이머 뒤, 둘째 end 의 타이머 앞에 새 조합 하나를 끼운다.
    setTimeout(() => {
      t.composition("compositionstart", "");
      t.composition("compositionend", "다", "가나다");
    }, 0);
    t.composition("compositionstart", "");
    t.composition("compositionend", "나", "가나");
    const { stock, traced } = await t.settle();
    expect(stock).toEqual(["가나", "나다"]);
    expect(traced).toEqual(stock);
  });
});
