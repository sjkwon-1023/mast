// @vitest-environment happy-dom
//
// 리로드 뒤 스크롤 복원의 회귀 테스트 (ADR-0019 개정 2026-09-20).
//
// 실패 모양: 리셋 supervisor 의 자동 리로드(hidden 600s·워치독)나 Ctrl+Shift+R 는 JS 컨텍스트를
// 통째로 버리는데, 스크롤 기억이 그 안에만 살아 있어(ScrollMemory 인메모리) 돌아온
// 화면이 사용자가 보던 자리가 아니라 하단(혹은 재인쇄가 어긋나면 맨 위)에서 시작했다.
// 그래서 여기서는 **기억이 리로드를 넘어온 뒤의 뷰**를 실제 xterm 으로 세워, 재생과
// 재인쇄(ED 3 wipe 포함)를 지나도 그 자리에 남는지 본다.
//
// 브라우저 빌드(@xterm/xterm)를 happy-dom 에서 직접 돌린다 — 뷰포트·래치 동작은
// headless 빌드와 다르고(ADR-0019 결정 2 의 교훈), 이 파일이 잠그는 것이 바로 그
// 동작이다. 백엔드 IPC 는 mock 이라 attach 본문과 채널 프레임만 주입한다.

import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const h = vi.hoisted(() => ({
  channel: null as unknown as { onmessage?: (chunk: ArrayBuffer | Uint8Array) => void },
  attach: (() => Promise.resolve(new ArrayBuffer(0))) as () => Promise<ArrayBuffer>,
}));

vi.mock("../../infrastructure/backend", () => ({
  writeStdin: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
  attachTerminal: vi.fn(async (_session: number, channel: unknown) => {
    h.channel = channel as typeof h.channel;
    return h.attach();
  }),
  // 리로드 attach 도 nudge(resize 2회)를 지난다 — 이 테스트의 재인쇄는 그 결과다.
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
import {
  attachBody,
  cssDimensionsOf,
  installCharMeasureGeometry,
  termOf,
} from "../../test-helpers";

installCharMeasureGeometry();

/** 채널 프레임 `[u64 LE offset][bytes]`. */
function frame(offset: number, text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + bytes.byteLength);
  new DataView(out.buffer).setBigUint64(0, BigInt(offset), true);
  out.set(bytes, 8);
  return out.buffer;
}

function lines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}\r\n`).join("");
}

/** Codex 재인쇄 모양 — 스크롤백 wipe(ED 3) 뒤에 전사를 다시 쌓는다. */
function reprint(count: number): string {
  return `\x1b[3J\x1b[2J${lines("history", count)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 라이브 채널에 쓰는 함수 — 게이트가 받아들이도록 오프셋을 누적한다. */
function liveEmitter(): (text: string) => void {
  let offset = 0;
  return (text) => {
    h.channel.onmessage?.(frame(offset, text));
    offset += new TextEncoder().encode(text).byteLength;
  };
}

function writeRaw(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** 실제 마우스 누름의 primary pointerdown. xterm 막대는 이것을 취소하므로 호환 mousedown 이 없다. */
function primaryPointerDown(target: Element): PointerEvent {
  const press = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    isPrimary: true,
  });
  target.dispatchEvent(press);
  return press;
}

// happy-dom 에는 레이아웃이 없어서 글자 측정이 0이 되고, 6.0 Viewport 는 그러면 스크롤을
// 0 좌표에 묶는다. installCharMeasureGeometry 가 측정 경계의 두 값만 채우므로 여기서의
// termOf(view).scrollLines 는 실제 Viewport → 스크롤 이벤트 → 래치 경로를 탄다. 휠·스크롤바
// 취소 신호는 실제 DOM 이벤트로 보낸다. 판정 전에는 셀·캔버스 치수가 양수인지 본다.

function viewportOf(view: TerminalView): { baseY: number; viewportY: number } {
  const term = termOf(view);
  const { cell, canvas } = cssDimensionsOf(term);
  expect(cell.height).toBeGreaterThan(0);
  expect(canvas.height).toBeGreaterThan(0);
  const buffer = term.buffer.active;
  expect(buffer.baseY).toBeGreaterThan(0);
  return { baseY: buffer.baseY, viewportY: buffer.viewportY };
}

/** 리로드 뒤 새 뷰 — 재생 200줄, 리로드 attach(first_attach=false), offset 은
 *  ScrollMemory.take 가 건넨 값이다. */
async function reloadedView(restoreOffset?: number): Promise<TerminalView> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  h.attach = () => Promise.resolve(attachBody(lines("replay", 200), false));
  const view = new TerminalView(host, 7, undefined, restoreOffset);
  await view.attach();
  await sleep(30);
  // 스크롤하기 전에 측정 경계가 양수 치수와 scrollback 을 냈는지 먼저 본다.
  viewportOf(view);
  return view;
}

/** 스크롤백이 없는 새 뷰 — 재생 없이 붙는다. */
async function freshView(): Promise<TerminalView> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  h.attach = () => Promise.resolve(attachBody("", true));
  const view = new TerminalView(host, 7);
  await view.attach();
  await sleep(30);
  return view;
}

describe("리로드 스크롤 복원", () => {
  it("기억한 위치가 재인쇄를 지나도 유지된다 — 맨 위로 튀지 않는다", async () => {
    const view = await reloadedView(20);
    const { baseY } = viewportOf(view);
    // 재생만 끝난 시점에 이미 복원이 적용된다.
    expect(viewportOf(view).viewportY).toBe(baseY - 20);

    h.channel.onmessage?.(frame(0, reprint(300)));
    await sleep(400);

    const after = viewportOf(view);
    // 재인쇄가 전사를 갈아치웠어도 같은 "하단에서 20줄" 자리다. 맨 위(0)나
    // 하단(baseY)이면 실패다 — 둘 다 사용자가 보던 자리가 아니다.
    expect(after.viewportY).toBe(after.baseY - 20);
    expect(view.rememberedScrollOffset()).toBe(20);
    view.dispose();
  });

  it("기억이 없으면 하단이다 — 이 개정이 메우는 실패 모양", async () => {
    const view = await reloadedView();
    h.channel.onmessage?.(frame(0, reprint(300)));
    await sleep(400);

    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY);
    expect(view.rememberedScrollOffset()).toBeNull();
    view.dispose();
  });

  it("resume 재인쇄 중 뷰포트가 맨 위에 걸려도 초기 하단을 유지한다", async () => {
    const view = await reloadedView();
    h.channel.onmessage?.(frame(0, reprint(300)));
    await sleep(30);
    // ED 3 직후 지연된 뷰포트 동기화가 스크롤 래치를 남기는 상태를 재현한다.
    // 실제 사용자 입력은 없으므로 재인쇄가 안정되면 하단이어야 한다.
    termOf(view).scrollLines(-viewportOf(view).baseY);
    expect(viewportOf(view).viewportY).toBe(0);
    await sleep(350);
    expect(viewportOf(view).viewportY).toBe(viewportOf(view).baseY);
    expect(view.rememberedScrollOffset()).toBeNull();
    view.dispose();
  });

  it("resume 중 사용자가 스크롤하면 하단 추적을 취소한다", async () => {
    const view = await reloadedView();
    h.channel.onmessage?.(frame(0, reprint(300)));
    await sleep(30);
    view.root.dispatchEvent(new Event("wheel"));
    termOf(view).scrollLines(-20);
    await sleep(350);
    expect(viewportOf(view).viewportY).toBe(viewportOf(view).baseY - 20);
    view.dispose();
  });

  it("스크롤백 wipe 는 사용자가 올려 둔 자리를 지킨다", async () => {
    // ADR-0019 v0.3.26 개정의 경로를 실제 브라우저 빌드로 잠근다: 사용자 래치가
    // 걸린 채 ED 3 가 오면, 훅이 지워지기 전 위치를 읽어 복원하지 않는 한 pane 은
    // 전사 맨 위에 고착된다.
    const view = await reloadedView();
    termOf(view).scrollLines(-20);
    expect(view.rememberedScrollOffset()).toBe(20);

    h.channel.onmessage?.(frame(0, reprint(300)));
    await sleep(400);

    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY - 20);
    expect(view.rememberedScrollOffset()).toBe(20);
    view.dispose();
  });

  it("휠 취소 뒤 wipe 가 와도 하단으로 끌어내리지 않는다", async () => {
    const view = await reloadedView(20);
    h.channel.onmessage?.(frame(0, reprint(300)));
    view.root.dispatchEvent(new Event("wheel"));
    await sleep(400);

    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY - 20);
    view.dispose();
  });

  it("없는 위치는 맨 위로 접지 않고 하단으로 떨어지며, 이어지는 출력을 따라간다", async () => {
    // 재인쇄가 기억보다 짧은 경우 (ADR-0019 결정 2) — 0 으로 접으면 xterm 래치가
    // 전사 맨 위에 고착된다.
    const view = await reloadedView(20);
    const emit = liveEmitter();
    emit(reprint(5));
    await sleep(400);

    // 재인쇄는 5줄뿐이라 기억한 20줄 위가 없다.
    const refused = viewportOf(view);
    expect(refused.baseY).toBeLessThan(20);
    expect(refused.viewportY).toBe(refused.baseY);
    expect(view.rememberedScrollOffset()).toBeNull();

    emit(lines("tail", 300));
    await sleep(50);
    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY);
    view.dispose();
  });
});

// 측정 매트릭스 1–5 (계획 C3). 관찰값은 6.0 브라우저 빌드 + 측정 경계 고정 치수(셀 9×17px)에서 얻었다.
describe("xterm 6 브라우저 빌드의 래치·스크롤바 관찰", () => {
  it("일반 버퍼: 하단 20줄 위에서 출력해도 절대 위치는 그대로이고 offset 만 늘어난다", async () => {
    const view = await reloadedView();
    const term = termOf(view);
    term.scrollToLine(viewportOf(view).baseY - 20);
    const pinned = viewportOf(view).viewportY;
    expect(view.rememberedScrollOffset()).toBe(20);

    liveEmitter()(lines("out", 50));
    await sleep(50);

    const after = viewportOf(view);
    expect(after.viewportY).toBe(pinned);
    expect(view.rememberedScrollOffset()).toBe(70);
    view.dispose();
  });

  it("scrollToBottom 뒤 2,000줄은 하단을 따라가고, scrollLines 와 scrollToLine 은 같은 자리에 닿는다", async () => {
    const view = await reloadedView();
    const term = termOf(view);
    const bottom = viewportOf(view).baseY;

    term.scrollToLine(bottom - 20);
    term.scrollLines(20);
    const byLines = viewportOf(view).viewportY;
    term.scrollToLine(bottom - 20);
    term.scrollToLine(bottom);
    const byLine = viewportOf(view).viewportY;
    expect(byLines).toBe(bottom);
    expect(byLine).toBe(byLines);

    term.scrollToBottom();
    liveEmitter()(lines("bulk", 2000));
    await sleep(50);
    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY);
    view.dispose();
  });

  it("ED 3 로 baseY 가 0 이 되면 scrollToBottom 은 래치를 풀지 못하고, 다음 출력 뒤에도 맨 위에 머문다", async () => {
    // 이 관찰이 ADR-0019 의 지연 해제(releaseLatchOnNextChunk)를 아직 필요하게 만든다.
    const view = await reloadedView();
    const term = termOf(view);
    term.scrollToLine(viewportOf(view).baseY - 20);

    await writeRaw(term, "\x1b[3J");
    expect(term.buffer.active.baseY).toBe(0);
    term.scrollToBottom();
    await writeRaw(term, lines("after", 30));
    expect(term.buffer.active.baseY).toBe(30);
    expect(term.buffer.active.viewportY).toBe(0);
    view.dispose();
  });

  it("ED 3 뒤 키 취소는 다음 chunk 에서 래치를 풀고, 이어지는 2,000줄을 하단에서 따라간다", async () => {
    const view = await reloadedView();
    termOf(view).scrollToLine(viewportOf(view).baseY - 20);
    const emit = liveEmitter();
    emit("\x1b[3J");
    await sleep(50);
    expect(termOf(view).buffer.active.baseY).toBe(0);

    view.root.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    emit(lines("after", 30));
    await sleep(50);
    emit(lines("after2", 2000));
    await sleep(50);

    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY);
    view.dispose();
  });

  it("복원 대기 중 키 취소는 복원이 건 래치를 바로 풀고, 이어지는 2,000줄을 하단에서 따라간다", async () => {
    const view = await reloadedView(20);
    view.root.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    liveEmitter()(lines("after", 2000));
    await sleep(50);

    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY);
    view.dispose();
  });

  it("스크롤바 슬라이더 pointerdown 은 mousedown 없이 복원을 취소한다", async () => {
    const view = await reloadedView(20);
    const slider = view.root.querySelector(".xterm-scrollable-element > .scrollbar.vertical > .slider");
    expect(slider).not.toBeNull();
    const press = primaryPointerDown(slider as Element);
    // xterm 이 누름을 취소했다. 실제 브라우저는 이때 호환 mousedown 을 만들지 않는다.
    expect(press.defaultPrevented).toBe(true);
    termOf(view).scrollLines(-30);
    liveEmitter()(reprint(300));
    await sleep(400);

    // 사용자가 올린 자리(50줄 위)가 복원 목표를 이긴다.
    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY - 50);
    view.dispose();
  });

  it("스크롤바 트랙 pointerdown 도 mousedown 없이 복원을 취소한다", async () => {
    const view = await reloadedView(20);
    const track = view.root.querySelector(".xterm-scrollable-element > .scrollbar.vertical");
    expect(track).not.toBeNull();
    const press = primaryPointerDown(track as Element);
    expect(press.defaultPrevented).toBe(true);
    // happy-dom 은 누른 좌표를 계산하지 않아 트랙이 옮긴 자리가 정해지지 않는다. 사용자가 고른 자리를 여기서 둔다.
    termOf(view).scrollToLine(viewportOf(view).baseY - 50);
    liveEmitter()(reprint(300));
    await sleep(400);

    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY - 50);
    view.dispose();
  });

  it("텍스트 클릭(.xterm-screen)은 복원을 취소하지 않는다", async () => {
    const view = await reloadedView(20);
    const screen = view.root.querySelector(".xterm-screen");
    expect(screen).not.toBeNull();
    primaryPointerDown(screen as Element);
    screen?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    termOf(view).scrollLines(-30);
    liveEmitter()(reprint(300));
    await sleep(400);

    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY - 20);
    view.dispose();
  });

  it("다른 pane 의 스크롤바 조작은 이 pane 의 복원을 취소하지 않는다", async () => {
    const other = await reloadedView();
    const view = await reloadedView(20);
    const otherSlider = other.root.querySelector(
      ".xterm-scrollable-element > .scrollbar.vertical > .slider",
    );
    expect(otherSlider).not.toBeNull();
    primaryPointerDown(otherSlider as Element);
    termOf(view).scrollLines(-30);
    liveEmitter()(reprint(300));
    await sleep(400);

    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY - 20);
    view.dispose();
    other.dispose();
  });

  it("offset 이 baseY 와 같으면 실제 line 0 으로 복원하고 그 자리를 기억한다", async () => {
    const probe = await reloadedView();
    const base = viewportOf(probe).baseY;
    probe.dispose();

    // 재생 직후 적용된 line 0 을 본다. 출력이 들어가면 같은 하단 기준 offset 이 한 줄 아래로 밀리므로 정착을 기다리지 않는다.
    const view = await reloadedView(base);
    expect(viewportOf(view).viewportY).toBe(0);
    expect(view.rememberedScrollOffset()).toBe(base);
    view.dispose();
  });

  it("재인쇄 도중 떠나면 기억 위치는 버퍼가 아니라 보류값을 준다", async () => {
    const view = await reloadedView(20);
    liveEmitter()(reprint(300));
    expect(view.rememberedScrollOffset()).toBe(20);
    view.dispose();
  });

  it("대체 버퍼에서는 위치를 기억하지 않는다", async () => {
    const view = await reloadedView();
    termOf(view).scrollLines(-20);
    expect(view.rememberedScrollOffset()).toBe(20);

    liveEmitter()("\x1b[?1049h");
    await sleep(50);
    expect(termOf(view).buffer.active.type).toBe("alternate");
    expect(view.rememberedScrollOffset()).toBeNull();
    view.dispose();
  });

  it("복원이 끝난 뒤 도착한 출력은 기억 위치를 다시 적용하지 않는다", async () => {
    // 출력이 없으면 settle 창은 2초 상한까지 열려 있으므로, 출력 한 줄 뒤 정적 구간으로 끝낸다.
    const view = await reloadedView(20);
    liveEmitter()(lines("quiet", 1));
    await sleep(400);
    termOf(view).scrollLines(-30);
    const before = viewportOf(view).viewportY;

    liveEmitter()(lines("late", 5));
    await sleep(50);
    expect(viewportOf(view).viewportY).toBe(before);
    view.dispose();
  });
});

// 세로 막대 표식(`data-scrollback`)은 스크롤백이 있는 normal buffer 에서만 켜진다 (styles.css).
describe("세로 막대 표식", () => {
  it("스크롤백이 생기면 켜지고, ED 3 로 baseY 가 0 이 되면 꺼진다", async () => {
    const view = await freshView();
    const term = termOf(view);
    expect(term.buffer.active.baseY).toBe(0);
    expect(view.root.hasAttribute("data-scrollback")).toBe(false);

    const emit = liveEmitter();
    emit(lines("live", 100));
    await sleep(50);
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
    expect(view.root.hasAttribute("data-scrollback")).toBe(true);

    emit("\x1b[3J");
    await sleep(50);
    expect(term.buffer.active.baseY).toBe(0);
    expect(view.root.hasAttribute("data-scrollback")).toBe(false);
    view.dispose();
  });

  it("normal → alternate 전환에서 꺼지고, 돌아오면 다시 켜진다", async () => {
    const view = await reloadedView();
    expect(view.root.hasAttribute("data-scrollback")).toBe(true);

    const emit = liveEmitter();
    emit("\x1b[?1049h");
    await sleep(50);
    expect(termOf(view).buffer.active.type).toBe("alternate");
    expect(view.root.hasAttribute("data-scrollback")).toBe(false);

    emit("\x1b[?1049l");
    await sleep(50);
    expect(termOf(view).buffer.active.type).toBe("normal");
    expect(view.root.hasAttribute("data-scrollback")).toBe(true);
    view.dispose();
  });

  it("resize 의 reflow 로 생긴 스크롤백도 켠다", async () => {
    const view = await freshView();
    const term = termOf(view);
    // 커서를 맨 아래 줄에 둔 채 행을 줄이면 윗줄이 스크롤백으로 밀린다. onScroll 은 나지 않는다.
    liveEmitter()("\r\n".repeat(term.rows - 1));
    await sleep(20);
    expect(term.buffer.active.baseY).toBe(0);
    expect(view.root.hasAttribute("data-scrollback")).toBe(false);

    term.resize(term.cols, term.rows - 5);
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
    expect(view.root.hasAttribute("data-scrollback")).toBe(true);
    view.dispose();
  });
});
