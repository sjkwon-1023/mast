// @vitest-environment happy-dom
//
// macOS 터미널 키 — 실제 xterm 5.5 브라우저 빌드와 TerminalView 배선으로, 키 하나가 PTY 에
// 어떤 바이트를 보내는지(백엔드 mock 의 writeStdin) 또는 화면·스크롤백이 어떻게 바뀌는지를 본다.
//
// xterm 은 Mac 판정을 모듈 로드 때 `navigator.platform` 으로 하되, `process.title` 이 있으면
// Node 로 보고 판정을 건너뛴다. 테스트 러너에는 process 가 있으므로 xterm 을 불러오기 전에
// 그 둘을 WKWebView 와 같게 맞춰 xterm 의 Mac 동작(Option 키 처리 등)을 그대로 돌린다.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const h = vi.hoisted(() => {
  const title = Object.getOwnPropertyDescriptor(process, "title");
  delete (process as { title?: string }).title;
  Object.defineProperty(navigator, "platform", { get: () => "MacIntel", configurable: true });
  return {
    restoreTitle: () => {
      if (title !== undefined) Object.defineProperty(process, "title", title);
    },
    writeStdin: vi.fn(async (_session: number, _data: string) => undefined),
    openUrl: vi.fn(async (_url: string) => undefined),
  };
});

vi.mock("../../infrastructure/backend", () => ({
  writeStdin: h.writeStdin,
  openUrl: h.openUrl,
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
import { applyTerminalSettings } from "./settings";
import { shouldOpenLink } from "./interaction";

h.restoreTitle();

function attachBody(): ArrayBuffer {
  const out = new Uint8Array(9);
  out[8] = 1; // firstAttach — replayDone 이 즉시 선다.
  return out.buffer;
}

const KEY_CODES: Record<string, number> = {
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Backspace: 8,
  PageUp: 33,
  PageDown: 34,
  Home: 36,
  End: 35,
  k: 75,
  c: 67,
  "∫": 66,
};

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(ev, "keyCode", { get: () => KEY_CODES[key] ?? 0 });
  return ev;
}

function keydownWithCode(key: string, keyCode: number): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "keyCode", { get: () => keyCode });
  return ev;
}

/** WebKit 이 IME 입력 한 건에 내는 beforeinput → 값 변경 → input. */
function imeInput(textarea: HTMLTextAreaElement, inputType: string, data: string, value: string): void {
  const init = { inputType, data, bubbles: true, composed: true };
  textarea.dispatchEvent(new InputEvent("beforeinput", { ...init, cancelable: true }));
  textarea.value = value;
  textarea.selectionStart = textarea.selectionEnd = value.length;
  textarea.dispatchEvent(new InputEvent("input", init));
}

function termOf(view: TerminalView): Terminal {
  return (view as unknown as { term: Terminal }).term;
}

const views: TerminalView[] = [];

async function attachedView(): Promise<TerminalView> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new TerminalView(host, 7);
  await view.attach();
  views.push(view);
  return view;
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function press(view: TerminalView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = keydown(key, init);
  termOf(view).textarea!.dispatchEvent(ev);
  return ev;
}

/** 스크롤백이 생길 만큼 줄을 찍는다 (기본 24행). */
async function fillScrollback(term: Terminal): Promise<void> {
  await write(term, Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n"));
}

async function sent(): Promise<string[]> {
  // writeStdin 은 쓰기 큐 뒤에서 비동기로 불린다.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return h.writeStdin.mock.calls.map(([, data]) => data);
}

afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  document.body.replaceChildren();
  h.writeStdin.mockClear();
  h.openUrl.mockClear();
  applyTerminalSettings({
    fontFamily: null,
    fontSize: null,
    highlightLanguages: null,
    log: null,
    remote: null,
    showTabIds: null,
    macOptionIsMeta: false,
  });
});

describe("macOS 줄 편집 키", () => {
  it("Option+←/→ 는 Terminal.app 처럼 ESC b / ESC f(셸 단어 이동)를 보낸다", async () => {
    const view = await attachedView();
    press(view, "ArrowLeft", { altKey: true });
    press(view, "ArrowRight", { altKey: true });
    expect(await sent()).toEqual(["\x1bb", "\x1bf"]);
  });

  it("⌘← / ⌘→ / ⌘⌫ 는 줄 처음·줄 끝·줄 지우기(Ctrl+A / Ctrl+E / Ctrl+U)를 보낸다", async () => {
    const view = await attachedView();
    press(view, "ArrowLeft", { metaKey: true });
    press(view, "ArrowRight", { metaKey: true });
    press(view, "Backspace", { metaKey: true });
    expect(await sent()).toEqual(["\x01", "\x05", "\x15"]);
  });

  it("조합 중인 한글은 ⌘← 보다 먼저 확정돼 PTY 에 도착한다", async () => {
    const view = await attachedView();
    const textarea = termOf(view).textarea!;
    // WebKit 두벌식: 입력창 변경(insertText → insertReplacementText) 뒤에 keydown 229 가 온다.
    imeInput(textarea, "insertText", "ㅎ", "ㅎ");
    textarea.dispatchEvent(keydownWithCode("Process", 229));
    imeInput(textarea, "insertReplacementText", "하", "하");
    textarea.dispatchEvent(keydownWithCode("Process", 229));
    expect(await sent()).toEqual([]);

    press(view, "ArrowLeft", { metaKey: true });
    expect((await sent()).join("")).toBe("하\x01");
  });

  it("⌘⌥방향키는 줄 편집으로 읽히지 않는다 (pane 이동 몫)", async () => {
    const view = await attachedView();
    press(view, "ArrowLeft", { metaKey: true, altKey: true });
    expect(await sent()).not.toContain("\x01");
  });
});

describe("macOS Option = Meta 설정", () => {
  it("켜면 Option+문자가 ESC 접두로 가고, 끄면(기본) Option 은 문자 입력이라 keydown 에서 보내지 않는다", async () => {
    const plain = await attachedView();
    press(plain, "∫", { altKey: true, code: "KeyB" });
    expect(await sent()).toEqual([]);

    applyTerminalSettings({
      fontFamily: null,
      fontSize: null,
      highlightLanguages: null,
      log: null,
      remote: null,
      showTabIds: null,
      macOptionIsMeta: true,
    });
    const meta = await attachedView();
    press(meta, "∫", { altKey: true, code: "KeyB" });
    expect(await sent()).toEqual(["\x1bb"]);
  });
});

describe("macOS ⌘K", () => {
  it("화면과 스크롤백을 지우고 PTY 에는 아무것도 보내지 않는다", async () => {
    const view = await attachedView();
    const term = termOf(view);
    await fillScrollback(term);
    expect(term.buffer.active.baseY).toBeGreaterThan(0);

    const ev = press(view, "k", { metaKey: true });
    expect(ev.defaultPrevented).toBe(true);
    await write(term, "");
    expect(term.buffer.active.baseY).toBe(0);
    expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("");
    expect(await sent()).toEqual([]);
  });

  it("alt 버퍼(vim 등)의 화면은 지우지 않는다", async () => {
    const view = await attachedView();
    const term = termOf(view);
    await write(term, "\x1b[?1049h\x1b[Hfull screen app");
    press(view, "k", { metaKey: true });
    await write(term, "");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("full screen app");
  });
});

describe("macOS Fn+↑/↓/←/→ (PageUp/PageDown/Home/End)", () => {
  it("일반 버퍼에서는 PTY 에 보내지 않고 스크롤백을 움직인다", async () => {
    const view = await attachedView();
    const term = termOf(view);
    await fillScrollback(term);
    const bottom = term.buffer.active.baseY;

    press(view, "PageUp");
    expect(term.buffer.active.viewportY).toBe(bottom - (term.rows - 1));
    press(view, "Home");
    expect(term.buffer.active.viewportY).toBe(0);
    press(view, "PageDown");
    expect(term.buffer.active.viewportY).toBe(term.rows - 1);
    press(view, "End");
    expect(term.buffer.active.viewportY).toBe(bottom);
    expect(await sent()).toEqual([]);
  });

  it("alt 버퍼나 마우스 추적 중에는 키를 앱(PTY)에 보낸다", async () => {
    const alt = await attachedView();
    await write(termOf(alt), "\x1b[?1049h");
    press(alt, "PageUp");
    expect(await sent()).toEqual(["\x1b[5~"]);
    h.writeStdin.mockClear();

    const mouse = await attachedView();
    const term = termOf(mouse);
    await fillScrollback(term);
    await write(term, "\x1b[?1000h");
    const bottom = term.buffer.active.viewportY;
    press(mouse, "PageUp");
    expect(await sent()).toEqual(["\x1b[5~"]);
    expect(term.buffer.active.viewportY).toBe(bottom);
  });

  it("Shift+PageUp/PageDown 은 Terminal.app 처럼 스크롤하지 않고 앱에 보낸다", async () => {
    const view = await attachedView();
    const term = termOf(view);
    await fillScrollback(term);
    const bottom = term.buffer.active.viewportY;
    press(view, "PageUp", { shiftKey: true });
    press(view, "PageDown", { shiftKey: true });
    expect(await sent()).toEqual(["\x1b[5~", "\x1b[6~"]);
    expect(term.buffer.active.viewportY).toBe(bottom);
  });
});

describe("macOS ⌘C", () => {
  it("복사한 뒤에도 선택을 남긴다", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const view = await attachedView();
    const term = termOf(view);
    await write(term, "copy me");
    term.selectAll();
    press(view, "c", { metaKey: true });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(term.hasSelection()).toBe(true);
    expect(await sent()).toEqual([]);
  });
});

describe("macOS 링크 열기", () => {
  it("⌘클릭일 때만 연다 — 그냥 클릭은 선택·커서 몫이다 (Windows 는 클릭 하나로 연다)", () => {
    const url = "https://example.com";
    expect(shouldOpenLink(url, "none", { metaKey: false }, true)).toBe(false);
    expect(shouldOpenLink(url, "none", { metaKey: true }, true)).toBe(true);
    expect(shouldOpenLink(url, "none", { metaKey: false }, false)).toBe(true);
    // 마우스를 추적하는 TUI 안의 클릭은 ⌘ 여부와 무관하게 앱 몫이다.
    expect(shouldOpenLink(url, "any", { metaKey: true }, true)).toBe(false);
  });
});
