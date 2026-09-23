// @vitest-environment happy-dom
//
// macOS WebKit 한글 입력 — 실제 xterm 5.5 브라우저 빌드와 TerminalView 배선으로 확인한다.
//
// 이 Mac 의 WebKit 은 한글 두벌식에서 composition 이벤트를 보내지 않고, 키마다
// 입력창 변경(insertText / insertReplacementText) → keydown 229 → keyup 순으로 온다.
// 여기서는 그 순서대로 xterm 의 textarea 에 DOM 이벤트를 디스패치하고, 백엔드 mock 의
// writeStdin 으로 나간 바이트(= PTY 도착 바이트)를 본다. 조합 외 키는 브라우저처럼
// keydown 이 먼저 오고, 기본 동작이 막히지 않았을 때만 입력창에 들어간다.
//
// xterm 은 WKWebView 와 같은 Mac 모드로 불러온다(xterm-mac-mode.test-support.ts) — 어댑터와
// xterm 의 Mac 분기(키 처리)가 함께 도는 조합을 본다. 같은 이유로 IS_MAC 도 true 다.

import { restoreProcessTitle } from "./xterm-mac-mode.test-support";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

const h = vi.hoisted(() => ({
  writeStdin: vi.fn(async (_session: number, _data: string) => undefined),
}));

vi.mock("../../infrastructure/backend", () => ({
  writeStdin: h.writeStdin,
  openUrl: vi.fn(async () => undefined),
  attachTerminal: vi.fn(async () => attachBody()),
  resizeTerminal: vi.fn(async () => undefined),
  detachTerminal: vi.fn(async () => undefined),
  ackOutput: vi.fn(async () => undefined),
  logLine: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((chunk: ArrayBuffer | Uint8Array) => void) | undefined;
  },
}));

import { TerminalView } from "./view";

restoreProcessTitle();

/** attach 응답 `[u64 LE end_offset][u8 first_attach][replay bytes]` — 빈 재생. */
function attachBody(): ArrayBuffer {
  const out = new Uint8Array(9);
  out[8] = 1;
  return out.buffer;
}

type Change =
  | { kind: "insert"; data: string }
  | { kind: "replace"; data: string; back?: number };
const ins = (data: string): Change => ({ kind: "insert", data });
const rep = (data: string, back = 1): Change => ({ kind: "replace", data, back });

const KEY_CODES: Record<string, number> = { " ": 32, Enter: 13, "-": 189 };

function keyEvent(
  type: "keydown" | "keypress" | "keyup",
  key: string,
  keyCode: number,
): KeyboardEvent {
  const ev = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(ev, "keyCode", { get: () => keyCode });
  if (type === "keypress") Object.defineProperty(ev, "charCode", { get: () => keyCode });
  return ev;
}

function setValue(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.selectionStart = textarea.selectionEnd = value.length;
}

/** WebKit 이 IME 입력 한 건에 내는 beforeinput → 값 변경 → input. */
function imeChange(textarea: HTMLTextAreaElement, c: Change): void {
  const inputType = c.kind === "insert" ? "insertText" : "insertReplacementText";
  const init = { inputType, data: c.data, bubbles: true, composed: true };
  textarea.dispatchEvent(new InputEvent("beforeinput", { ...init, cancelable: true }));
  const value = textarea.value;
  if (c.kind === "insert") {
    setValue(textarea, value + c.data);
  } else {
    const at = value.length - (c.back ?? 1);
    setValue(textarea, value.slice(0, at) + c.data + value.slice(at + 1));
  }
  textarea.dispatchEvent(new InputEvent("input", init));
}

/** IME 가 삼킨 키: 입력창 변경들 → keydown 229 → keyup. */
function imeKey(textarea: HTMLTextAreaElement, ...changes: Change[]): void {
  for (const c of changes) imeChange(textarea, c);
  textarea.dispatchEvent(keyEvent("keydown", "Process", 229));
  textarea.dispatchEvent(keyEvent("keyup", "Process", 65));
}

/** 조합 외 키: keydown 이 먼저, 막히지 않았으면 keypress, 그것도 막히지 않았으면 기본
 *  동작으로 입력창에 들어간다 (xterm 은 Space 를 keypress 에서 보낸다). */
function plainKey(textarea: HTMLTextAreaElement, key: string): void {
  const keyCode = KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0);
  const down = keyEvent("keydown", key, keyCode);
  textarea.dispatchEvent(down);
  if (!down.defaultPrevented && key.length === 1) {
    const press = keyEvent("keypress", key, key.charCodeAt(0));
    textarea.dispatchEvent(press);
    if (!press.defaultPrevented) imeChange(textarea, ins(key));
  }
  textarea.dispatchEvent(keyEvent("keyup", key, keyCode));
}

function type(textarea: HTMLTextAreaElement, keys: Array<Change[] | string>): void {
  for (const k of keys) {
    if (typeof k === "string") plainKey(textarea, k);
    else imeKey(textarea, ...k);
  }
}

const SENTENCE: Array<Change[] | string> = [
  [ins("ㅎ")], [rep("하")], [rep("한")],
  [ins("ㄱ")], [rep("그")], [rep("글")],
  " ",
  [ins("ㅇ")], [rep("이")], [rep("입")],
  [ins("ㄹ")], [rep("려")], [rep("력")],
  " ",
  [ins("ㅌ")], [rep("테")], [rep("텟")],
  [rep("테"), ins("스")], [rep("슽")],
  [ins("트"), rep("스", 2)],
];

function termOf(view: TerminalView): Terminal {
  return (view as unknown as { term: Terminal }).term;
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
  return h.writeStdin.mock.calls.map(([, data]) => data).join("");
}

describe("macOS WebKit 한글 입력 (실제 xterm + TerminalView)", () => {
  beforeEach(() => h.writeStdin.mockClear());

  it("라이브러리 전제: 어댑터 없는 xterm 5.5 는 음절마다 첫 자모만 보낸다", async () => {
    // 이 전제가 깨지면(업스트림이 insertReplacementText 를 처리하면) 어댑터가 중복이 된다.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24 });
    const data: string[] = [];
    term.onData((d) => data.push(d));
    term.open(host);
    const keys = [[ins("ㅎ")], [rep("하")], [rep("한")], [ins("ㄱ")], [rep("그")], [rep("글")]];
    try {
      // 한가한 메인 스레드: 키 사이마다 xterm 의 지연 타이머가 돈다. 이것이 필드 증상이다.
      for (const key of keys) {
        type(term.textarea!, [key]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(data.join("")).toBe("ㅎㄱ");

      // 바쁜 메인 스레드: 229 keydown 의 지연 diff 까지 새어 나와 음절이 겹쳐 간다 — 어댑터가
      // IME 발 229 keydown 도 xterm 에 넘기지 않는 이유다. 아래 TerminalView 테스트들은 키
      // 사이에 타이머를 돌리지 않는 이 조건에서 돈다.
      data.length = 0;
      term.textarea!.value = "";
      type(term.textarea!, keys);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(data.join("")).toMatch(/^ㅎㄱ.+/u);
    } finally {
      term.dispose();
      host.remove();
    }
  });

  it('"한글 입력 테스트" 뒤 Enter 가 친 그대로 PTY 에 도착한다', async () => {
    const { view, textarea } = await attachedView();
    try {
      type(textarea, [...SENTENCE, "Enter"]);
      expect(await ptyBytes()).toBe("한글 입력 테스트\r");
      // Enter 뒤(xterm 이 입력창을 비운 뒤) 이어서 친 글자도 온전히 간다.
      type(textarea, [[ins("ㄱ")], [rep("가")], "Enter"]);
      expect(await ptyBytes()).toBe("한글 입력 테스트\r가\r");
    } finally {
      view.dispose();
    }
  });

  it("조합 중인 음절은 커서 위치에 보이고, 확정되면 사라진다", async () => {
    const { view, textarea } = await attachedView();
    const element = termOf(view).element!;
    const shown = (): string =>
      [...element.querySelectorAll(".composition-view.active")].map((e) => e.textContent).join("");
    try {
      type(textarea, [[ins("ㅎ")], [rep("하")], [rep("한")]]);
      expect(shown()).toBe("한");
      expect(await ptyBytes()).toBe("");
      type(textarea, ["Enter"]);
      expect(shown()).toBe("");
    } finally {
      view.dispose();
    }
  });

  it("blur 는 남은 조합을 확정한다", async () => {
    const { view, textarea } = await attachedView();
    try {
      type(textarea, [[ins("ㅎ")], [rep("하")], [rep("한")]]);
      textarea.dispatchEvent(new FocusEvent("blur"));
      expect(await ptyBytes()).toBe("한");
      // xterm 의 blur 가 입력창을 비운 뒤에도 이어서 친 글자가 온전히 간다.
      type(textarea, [[ins("ㄱ")], [rep("그")], [rep("글")]]);
      textarea.dispatchEvent(new FocusEvent("blur"));
      expect(await ptyBytes()).toBe("한글");
    } finally {
      view.dispose();
    }
  });

  it("탭을 숨기거나 뷰를 해제해도 남은 조합이 PTY 에 간다", async () => {
    const hidden = await attachedView();
    try {
      type(hidden.textarea, [[ins("ㅎ")], [rep("하")]]);
      hidden.view.setVisible(false);
      expect(await ptyBytes()).toBe("하");
    } finally {
      hidden.view.dispose();
    }
    h.writeStdin.mockClear();
    const disposed = await attachedView();
    type(disposed.textarea, [[ins("ㄱ")], [rep("가")]]);
    disposed.view.dispose();
    expect(await ptyBytes()).toBe("가");
  });

  it("이미지만 있는 붙여넣기(Ctrl+V 전달)는 조합 중인 한글을 먼저 보낸다", async () => {
    const { view, textarea } = await attachedView();
    try {
      type(textarea, [[ins("ㅎ")], [rep("하")]]);
      // 네이티브 Edit › Paste 처럼 앞선 keydown 없이 paste 이벤트만 온다.
      const paste = new Event("paste", { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { types: ["image/png"], getData: () => "" },
      });
      textarea.dispatchEvent(paste);
      expect(await ptyBytes()).toBe("하\x16");
    } finally {
      view.dispose();
    }
  });

  it("키 없이 온 이모지(문자 뷰어)는 남은 조합과 함께 바로 간다", async () => {
    const { view, textarea } = await attachedView();
    try {
      type(textarea, [[ins("ㅎ")], [rep("하")]]);
      imeChange(textarea, ins("😀"));
      expect(await ptyBytes()).toBe("하😀");
    } finally {
      view.dispose();
    }
  });

  it("키 없이 온 한자(후보 마우스 선택)는 바로 간다", async () => {
    const { view, textarea } = await attachedView();
    try {
      imeChange(textarea, ins("漢"));
      expect(await ptyBytes()).toBe("漢");
      // 조합 중인 음절을 한자로 바꾸는 교체도 같다.
      type(textarea, [[ins("ㅎ")], [rep("하")], [rep("한")]]);
      imeChange(textarea, rep("韓"));
      expect(await ptyBytes()).toBe("漢韓");
    } finally {
      view.dispose();
    }
  });

  it("키 없이 온 한글 한 글자(받아쓰기 등)는 뒤따르는 키가 없으면 잠시 뒤 간다", async () => {
    const { view, textarea } = await attachedView();
    try {
      imeChange(textarea, ins("한"));
      // 정상 타이핑이면 곧 keydown 229 가 온다 — 그 전에 확정하지 않는다.
      expect(await ptyBytes()).toBe("");
      await vi.waitFor(async () => expect(await ptyBytes()).toBe("한"), { timeout: 1000, interval: 20 });
      // 이어서 친 글자도 온전히 간다.
      type(textarea, [[ins("ㄱ")], [rep("가")], "Enter"]);
      expect(await ptyBytes()).toBe("한가\r");
    } finally {
      view.dispose();
    }
  });

  it("정상 타이핑의 조합은 키 사이가 길어도 확정되지 않는다", async () => {
    const { view, textarea } = await attachedView();
    try {
      type(textarea, [[ins("ㅎ")], [rep("하")]]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await ptyBytes()).toBe("");
      type(textarea, [[rep("한")], "Enter"]);
      expect(await ptyBytes()).toBe("한\r");
    } finally {
      view.dispose();
    }
  });

  it("영문 입력은 xterm 의 keydown 경로 그대로다", async () => {
    const { view, textarea } = await attachedView();
    try {
      type(textarea, ["l", "s", " ", "-", "l", "a", "Enter"]);
      expect(await ptyBytes()).toBe("ls -la\r");
    } finally {
      view.dispose();
    }
  });
});
