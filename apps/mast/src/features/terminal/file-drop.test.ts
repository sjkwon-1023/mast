// @vitest-environment happy-dom
//
// Finder → 터미널 파일 드롭: 경로가 셸에 그대로 쓸 수 있는 글자로 바뀌어, 떨어뜨린 자리의
// 터미널 pane 에 붙여넣기로 도착하는지 본다. 실제 TerminalView 의 paste 경로를 태워
// writeStdin(= PTY 도착 바이트)으로 확인한다.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const h = vi.hoisted(() => ({
  writeStdin: vi.fn(async (_session: number, _data: string) => undefined),
}));

vi.mock("../../infrastructure/backend", () => ({
  writeStdin: h.writeStdin,
  openUrl: vi.fn(async () => undefined),
  attachTerminal: vi.fn(async () => {
    const out = new Uint8Array(9);
    out[8] = 1;
    return out.buffer;
  }),
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
import { dropPasteText, handleFileDrop } from "./file-drop";

const AWKWARD = [
  "/Users/me/My Documents/report final.pdf",
  "/tmp/it's here",
  "/tmp/$HOME `whoami` \\ ! * ? [x] ; & | > <",
  "/tmp/line\nbreak",
  "/Users/me/한글 파일.txt",
];

const views: TerminalView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  document.body.replaceChildren();
  h.writeStdin.mockClear();
});

async function attachedView(): Promise<TerminalView> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new TerminalView(host, 7);
  await view.attach();
  views.push(view);
  return view;
}

async function sent(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return h.writeStdin.mock.calls.map(([, data]) => data).join("");
}

describe("드롭 경로의 셸 인용", () => {
  // zsh 가 없는 CI 호스트에서는 있는 셸만 돈다.
  it.each(["/bin/sh", "/bin/bash", "/bin/zsh"].filter((shell) => existsSync(shell)))("%s 가 인용된 텍스트를 원래 경로 목록으로 읽는다", (shell) => {
    const text = dropPasteText(AWKWARD)!;
    // 셸이 단어로 나눈 결과를 NUL 로 구분해 돌려받는다 — 공백·따옴표·특수문자가 모두 원래대로여야 한다.
    const out = execFileSync(shell, ["-c", `eval "set -- $1"; printf '%s\\0' "$@"`, "sh", text], {
      encoding: "utf8",
    });
    expect(out.split("\0").slice(0, -1)).toEqual(AWKWARD);
  });

  it("빈 드롭은 붙여넣을 것이 없다", () => {
    expect(dropPasteText([])).toBeNull();
  });
});

describe("드롭 위치의 터미널에 붙여넣기", () => {
  it("물리 픽셀 위치를 CSS px 로 바꿔 그 자리의 터미널에 붙여넣고, 실행(Enter)은 하지 않는다", async () => {
    const view = await attachedView();
    const targetAt = vi.fn((_x: number, _y: number) => view);
    const handled = handleFileDrop(
      { type: "drop", paths: ["/tmp/a b"], position: { x: 300, y: 200 } },
      targetAt,
      2,
    );
    expect(handled).toBe(true);
    expect(targetAt).toHaveBeenCalledWith(150, 100);
    expect(await sent()).toBe("'/tmp/a b'");
  });

  it("bracketed paste 를 켠 앱에는 괄호를 씌워 보내 경로 안의 개행이 입력을 끝내지 않는다", async () => {
    const view = await attachedView();
    const term = (view as unknown as { term: Terminal }).term;
    await new Promise<void>((resolve) => term.write("\x1b[?2004h", resolve));
    handleFileDrop({ type: "drop", paths: ["/tmp/line\nbreak"], position: { x: 1, y: 1 } }, () => view, 1);
    const bytes = await sent();
    expect(bytes.startsWith("\x1b[200~")).toBe(true);
    expect(bytes.endsWith("\x1b[201~")).toBe(true);
  });

  it("터미널이 아닌 곳이나 경로 없는 이벤트는 무시한다", async () => {
    const view = await attachedView();
    const paste = vi.spyOn(view, "paste");
    expect(handleFileDrop({ type: "drop", paths: ["/tmp/x"], position: { x: 1, y: 1 } }, () => null, 1)).toBe(false);
    expect(handleFileDrop({ type: "over", position: { x: 1, y: 1 } }, () => view, 1)).toBe(false);
    expect(handleFileDrop({ type: "drop", paths: [], position: { x: 1, y: 1 } }, () => view, 1)).toBe(false);
    expect(paste).not.toHaveBeenCalled();
    expect(await sent()).toBe("");
  });
});
