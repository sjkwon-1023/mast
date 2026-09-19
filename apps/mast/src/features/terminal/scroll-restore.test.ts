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

function u64le(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

/** attach 응답 `[u64 LE end_offset][u8 first_attach][replay bytes]`. */
function attachBody(replay: string, firstAttach: boolean): ArrayBuffer {
  const bytes = new TextEncoder().encode(replay);
  const out = new Uint8Array(9 + bytes.byteLength);
  out.set(u64le(0), 0);
  out[8] = firstAttach ? 1 : 0;
  out.set(bytes, 9);
  return out.buffer;
}

/** 채널 프레임 `[u64 LE offset][bytes]`. */
function frame(offset: number, text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + bytes.byteLength);
  out.set(u64le(offset), 0);
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

/** 사용자 스크롤을 흉내내는 우회로 — xterm 의 휠·PageUp 경로는 happy-dom 에
 *  레이아웃이 없어 버퍼에 닿지 않는다 (viewport 의 offsetParent 부재로 스크롤
 *  이벤트가 버려진다). 취소 신호처럼 DOM 이벤트로 재현되는 것은 실제 이벤트로
 *  보내고(아래 wheel), 스크롤 자체만 여기서 만든다. */
function termOf(view: TerminalView): Terminal {
  return (view as unknown as { term: Terminal }).term;
}

function viewportOf(view: TerminalView): { baseY: number; viewportY: number } {
  const buffer = termOf(view).buffer.active;
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

  it("없는 위치는 맨 위로 접지 않고 하단으로 떨어진다", async () => {
    // 재인쇄가 기억보다 짧은 경우 (ADR-0019 결정 2) — 0 으로 접으면 xterm 래치가
    // 전사 맨 위에 고착된다.
    const view = await reloadedView(20);
    h.channel.onmessage?.(frame(0, reprint(5)));
    await sleep(400);

    const after = viewportOf(view);
    expect(after.viewportY).toBe(after.baseY);
    expect(view.rememberedScrollOffset()).toBeNull();
    view.dispose();
  });
});
