// @vitest-environment happy-dom
//
// Windows 한글 입력 — 실제 xterm 6.0 브라우저 빌드와 TerminalView 배선으로 확인한다.
//
// WebView2 는 키마다 keydown 229 → composition 이벤트(받침이 넘어가는 키에서는 end 와 다음
// start 가 한 태스크에) 순으로 보낸다. 여기서는 그 순서대로 xterm 의 textarea 에 DOM 이벤트를
// 디스패치하고, 백엔드 mock 의 writeStdin 으로 나간 바이트(= PTY 도착 바이트)를 본다. 키
// 사이에 타이머를 돌리지 않는다 — 메인 스레드가 바쁜 쪽이 xterm 경로에 불리한 조건이다.
//
// `overwrite` 는 TSF 가 다음 음절의 조합으로 textarea 의 앞 음절을 바꿔 쓴 상태를 흉내 낸다.
// 2026-10-21 현장 `match=false`(길이 1:1, 내용 다름)와 맞는 한 가지 모형일 뿐 원인으로 확인된
// 것은 아니다. 어댑터가 textarea 를 읽지 않는다는 것을 보이는 데 쓴다.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

const h = vi.hoisted(() => ({
  writeStdin: vi.fn(async (_session: number, _data: string) => undefined),
  logLines: [] as string[],
}));

vi.mock("../../infrastructure/backend", () => ({
  writeStdin: h.writeStdin,
  openUrl: vi.fn(async () => undefined),
  attachTerminal: vi.fn(async () => attachBody()),
  resizeTerminal: vi.fn(async () => undefined),
  detachTerminal: vi.fn(async () => undefined),
  ackOutput: vi.fn(async () => undefined),
  logLine: vi.fn(async (text: string) => {
    h.logLines.push(text);
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((chunk: ArrayBuffer | Uint8Array) => void) | undefined;
  },
}));

import { TerminalView } from "./view";
import { installFrontEndLogging } from "../../infrastructure/logging";
import { attachBody, termOf } from "../../test-helpers";

type Op =
  | { t: "compose"; text: string; overwrite?: boolean }
  | { t: "commit"; text: string };
const compose = (text: string, overwrite = false): Op => ({ t: "compose", text, overwrite });
const commit = (text: string): Op => ({ t: "commit", text });

/** 두벌식 '조작' — ㅏ 에서 받침 ㅈ 이 넘어가며 end('조')와 start 가 한 키에 온다. */
const JOJAK: Op[][] = [
  [compose("ㅈ")],
  [compose("조")],
  [compose("좆")],
  [commit("조"), compose("자")],
  [compose("작")],
  [commit("작")],
];

/** 같은 열에서 '자' 조합이 textarea 의 '조' 를 바꿔 쓴다. */
const JOJAK_OVERWRITTEN: Op[][] = JOJAK.map((ops) =>
  ops.map((op) => (op.t === "compose" && op.text === "자" ? compose("자", true) : op)),
);

function keyEvent(type: "keydown" | "keypress" | "keyup", key: string, keyCode: number): KeyboardEvent {
  const ev = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(ev, "keyCode", { get: () => keyCode });
  if (type === "keypress") Object.defineProperty(ev, "charCode", { get: () => keyCode });
  return ev;
}

/** happy-dom 의 CompositionEvent 는 data init 을 버리므로 직접 얹는다 (logging.test.ts 와 같은 이유). */
function composition(textarea: HTMLTextAreaElement, type: string, data: string): void {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, "data", { value: data });
  textarea.dispatchEvent(ev);
}

/** textarea 와 열린 조합을 브라우저처럼 따라가며 키를 친다. */
class Typist {
  private field = "";
  private composing: string | null = null;

  constructor(private readonly textarea: HTMLTextAreaElement) {}

  ime(ops: Op[]): void {
    this.textarea.dispatchEvent(keyEvent("keydown", "Process", 229));
    for (const op of ops) {
      if (op.t === "compose") {
        if (this.composing === null) {
          composition(this.textarea, "compositionstart", "");
          this.composing = "";
        }
        if (op.overwrite === true) this.field = this.field.slice(0, -1);
        this.composing = op.text;
        this.sync();
        composition(this.textarea, "compositionupdate", op.text);
      } else {
        this.field += op.text;
        this.composing = null;
        this.sync();
        composition(this.textarea, "compositionend", op.text);
      }
    }
    this.textarea.dispatchEvent(keyEvent("keyup", "Process", 229));
  }

  word(keys: Op[][]): void {
    for (const ops of keys) this.ime(ops);
  }

  /** 조합 외 키: keydown, 막히지 않았으면 keypress, 그것도 막히지 않았으면 입력창에 들어간다. */
  plain(key: string, keyCode: number): void {
    const down = keyEvent("keydown", key, keyCode);
    this.textarea.dispatchEvent(down);
    if (!down.defaultPrevented && key.length === 1) {
      const press = keyEvent("keypress", key, key.charCodeAt(0));
      this.textarea.dispatchEvent(press);
      if (!press.defaultPrevented) {
        this.field += key;
        this.sync();
      }
    }
    this.textarea.dispatchEvent(keyEvent("keyup", key, keyCode));
    // xterm 은 Enter 에서 입력창을 비운다.
    if (this.textarea.value === "") this.field = "";
  }

  /** 앞선 키가 끊은 조합을 IME 가 뒤늦게 닫는다. */
  end(data: string): void {
    this.field += data;
    this.composing = null;
    this.sync();
    composition(this.textarea, "compositionend", data);
  }

  private sync(): void {
    const value = this.field + (this.composing ?? "");
    this.textarea.value = value;
    this.textarea.selectionStart = this.textarea.selectionEnd = value.length;
  }
}

async function attachedView(): Promise<{ view: TerminalView; textarea: HTMLTextAreaElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new TerminalView(host, 7);
  await view.attach();
  const textarea = termOf(view).textarea;
  if (!textarea) throw new Error("xterm did not create its textarea");
  return { view, textarea };
}

/** 쓰기 큐가 비워질 때까지 기다린 뒤 PTY 로 나간 바이트 전체. */
async function ptyBytes(): Promise<string> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return h.writeStdin.mock.calls.map(([, data]) => data).join("");
}

function activePreview(textarea: HTMLTextAreaElement): string | null {
  const view = textarea.parentElement?.querySelector(".composition-view.active");
  return view?.textContent ?? null;
}

describe("Windows 한글 입력 (실제 xterm + TerminalView)", () => {
  beforeEach(() => h.writeStdin.mockClear());

  it("대조군: 어댑터 없는 xterm 6.0 은 확정 글자 대신 textarea 구간을 보낸다", async () => {
    // 이 전제가 깨지면(업스트림이 compositionend.data 를 쓰면) 어댑터의 근거가 바뀐다.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24 });
    const data: string[] = [];
    term.onData((d) => data.push(d));
    term.open(host);
    try {
      // 한가한 메인 스레드: 키마다 xterm 의 지연 전송이 돈다. 길이는 같고 내용이 다르다.
      const typist = new Typist(term.textarea!);
      for (const ops of JOJAK_OVERWRITTEN) {
        typist.ime(ops);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(data[0]).toBe("자");
    } finally {
      term.dispose();
      host.remove();
    }
  });

  it("'조작' 뒤 Enter 가 친 그대로 PTY 에 도착한다", async () => {
    const { view, textarea } = await attachedView();
    try {
      const typist = new Typist(textarea);
      typist.word(JOJAK);
      typist.plain("Enter", 13);
      expect(await ptyBytes()).toBe("조작\r");
    } finally {
      view.dispose();
    }
  });

  it("TSF 가 textarea 의 앞 음절을 바꿔 써도 IME 가 확정한 글자를 보낸다", async () => {
    const { view, textarea } = await attachedView();
    try {
      const typist = new Typist(textarea);
      typist.word(JOJAK_OVERWRITTEN);
      typist.plain("Enter", 13);
      expect(await ptyBytes()).toBe("조작\r");
    } finally {
      view.dispose();
    }
  });

  it("조합 중 Space 는 음절 뒤에 한 번씩만 간다", async () => {
    const { view, textarea } = await attachedView();
    try {
      const typist = new Typist(textarea);
      typist.word([[compose("ㄷ")], [compose("도")]]);
      typist.plain(" ", 32);
      typist.end("도");
      typist.word([[compose("ㄱ")], [compose("가")], [commit("가")]]);
      expect(await ptyBytes()).toBe("도 가");
    } finally {
      view.dispose();
    }
  });

  it("조합 중 Enter 는 음절을 먼저 보낸다", async () => {
    const { view, textarea } = await attachedView();
    try {
      const typist = new Typist(textarea);
      typist.word([[compose("ㄱ")], [compose("가")]]);
      typist.plain("Enter", 13);
      typist.end("가");
      expect(await ptyBytes()).toBe("가\r");
    } finally {
      view.dispose();
    }
  });

  it("Backspace 로 지운 조합(빈 end)은 아무것도 보내지 않는다", async () => {
    const { view, textarea } = await attachedView();
    try {
      new Typist(textarea).word([[compose("ㄱ")], [compose("")], [commit("")]]);
      expect(await ptyBytes()).toBe("");
    } finally {
      view.dispose();
    }
  });

  it("탭이 숨겨지면 열린 조합을 보내고 뒤늦은 end 는 다시 보내지 않는다", async () => {
    const { view, textarea } = await attachedView();
    try {
      const typist = new Typist(textarea);
      typist.word([[compose("ㅎ")], [compose("하")]]);
      view.setVisible(false);
      typist.end("하");
      expect(await ptyBytes()).toBe("하");
    } finally {
      view.dispose();
    }
  });

  it("조합 중 글자를 커서 위치에 미리 보여 주고 확정되면 숨긴다", async () => {
    const { view, textarea } = await attachedView();
    try {
      const typist = new Typist(textarea);
      typist.word([[compose("ㅎ")], [compose("하")]]);
      expect(activePreview(textarea)).toBe("하");
      typist.ime([commit("하")]);
      expect(activePreview(textarea)).toBeNull();
    } finally {
      view.dispose();
    }
  });

  it("로그를 켜면 확정 비교와 xterm 구간 판정이 함께 남는다", async () => {
    installFrontEndLogging(
      {
        fontFamily: null,
        fontSize: null,
        highlightLanguages: null,
        log: true,
        remote: null,
        showTabIds: null,
        macOptionIsMeta: null,
      },
      new EventTarget(),
    );
    const { view, textarea } = await attachedView();
    try {
      h.logLines.length = 0;
      new Typist(textarea).word(JOJAK_OVERWRITTEN);
      await ptyBytes();
      expect(h.logLines.filter((line) => line.startsWith("ime: commit"))).toEqual([
        "ime: commit match=true session=7 pane=none ends=2 onData=2 expectedLen=2 actualLen=2 xtermWindow=differs",
      ]);
    } finally {
      view.dispose();
    }
  });
});
