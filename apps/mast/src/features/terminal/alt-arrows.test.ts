// @vitest-environment happy-dom
//
// Alt+방향키가 PTY 까지 **진짜 Alt 수식**으로 가는지 잠그는 회귀 테스트.
//
// 실패 모양: mast 는 plain Alt+방향키를 가로채지 않는데도(xterm custom handler 통과)
// Codex 질문 UI 의 Alt+Up 이 동작하지 않았다. 원인은 xterm 5.5 의
// `evaluateKeyboardEvent` 가 Alt+방향키를 Ctrl+방향키(`ESC[1;5A`)로 바꿔 보내는
// HACK 이다 — PTY 에는 Alt 가 아니라 Ctrl 이 도착한다. 터미널 뷰가 그 HACK 을
// 우회해 실제 시퀀스(`ESC[1;3A`)를 직접 보내는 것을 여기서 실제 브라우저 빌드로
// 확인한다 (headless 빌드는 키보드 경로를 갖지 않아 이 파일의 대상이 아니다).
//
// 백엔드 IPC 는 mock 이라 writeStdin 으로 나가는 바이트가 곧 PTY 도착 바이트다.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import snapshotJson from "../../../../../fixtures/stage10-snapshot.json";
import { installNavKeys } from "../../app/navigation/actions";
import type { StateSnapshot } from "../../shared/types";

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

/** attach 응답 `[u64 LE end_offset][u8 first_attach][replay bytes]` — 빈 재생. */
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
};

/** WebView2 가 주는 모양 그대로 — keyCode 를 명시한다 (xterm 판정이 keyCode 기반). */
function arrowEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(ev, "keyCode", { get: () => KEY_CODES[key] });
  return ev;
}

function termOf(view: TerminalView): Terminal {
  return (view as unknown as { term: Terminal }).term;
}

async function attachedView(): Promise<TerminalView> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new TerminalView(host, 7);
  await view.attach();
  return view;
}

describe("Alt+방향키 전달", () => {
  beforeEach(() => h.writeStdin.mockClear());

  it("네 방향 모두 실제 Alt 시퀀스(ESC[1;3X)로 PTY 에 도착한다", async () => {
    const view = await attachedView();
    const term = termOf(view);
    try {
      const expected: Array<[string, string]> = [
        ["ArrowUp", "\x1b[1;3A"],
        ["ArrowDown", "\x1b[1;3B"],
        ["ArrowRight", "\x1b[1;3C"],
        ["ArrowLeft", "\x1b[1;3D"],
      ];
      for (const [key, bytes] of expected) {
        term.textarea!.dispatchEvent(arrowEvent(key, { altKey: true }));
        await vi.waitFor(() => {
          expect(h.writeStdin).toHaveBeenLastCalledWith(7, bytes);
        });
      }
      // Ctrl 로 강등된 시퀀스가 한 번도 나가지 않았다 — 이것이 필드 실패의 모양이다.
      const sent = h.writeStdin.mock.calls.map(([, data]) => data);
      expect(sent).toEqual(expected.map(([, bytes]) => bytes));
      for (const data of sent) expect(data).not.toMatch(/\x1b\[1;5[ABCD]/);
    } finally {
      view.dispose();
    }
  });

  it("실제 배선: window capture 는 Alt+Shift 만 pane 이동으로 소비하고 Shift 없는 Alt+방향키는 터미널에 넘긴다", async () => {
    const view = await attachedView();
    const term = termOf(view);
    const add = vi.spyOn(window, "addEventListener");
    const snapshot = structuredClone(snapshotJson) as unknown as StateSnapshot;
    const dispatchUI = vi.fn(async () => null);
    installNavKeys({
      getSnapshot: () => snapshot,
      paneRects: () => [
        { pane: 2, x: 0, y: 0, w: 600, h: 400 },
        { pane: 3, x: 600, y: 0, w: 600, h: 400 },
      ],
      dispatchUI,
      createWorkspaceHere: vi.fn(),
      renameWorkspace: vi.fn(),
      closeWorkspace: vi.fn(),
    });
    const call = add.mock.calls.find(([type]) => type === "keydown")!;
    const listener = call[1] as EventListener;
    try {
      // Alt+Shift+오른쪽: nav 가 capture 에서 소비하고 인접 pane 으로 포커스를 옮긴다.
      term.textarea!.dispatchEvent(arrowEvent("ArrowRight", { altKey: true, shiftKey: true }));
      expect(dispatchUI).toHaveBeenCalledWith({ type: "focusPane", pane: 3 });
      expect(h.writeStdin).not.toHaveBeenCalled();

      // Shift 없는 Alt+위쪽: capture 가 손대지 않아 터미널이 진짜 Alt 시퀀스를 보낸다.
      term.textarea!.dispatchEvent(arrowEvent("ArrowUp", { altKey: true }));
      await vi.waitFor(() => {
        expect(h.writeStdin).toHaveBeenCalledWith(7, "\x1b[1;3A");
      });
    } finally {
      window.removeEventListener("keydown", listener, { capture: true });
      add.mockRestore();
      view.dispose();
    }
  });

  it("라이브러리 전제: xterm 5.5 기본은 Alt+방향키를 Ctrl+방향키로 바꾼다", async () => {
    // 이 전제가 깨지면(업스트림이 고치면) view 의 우회로가 중복이 된다 — 그때는
    // 우회로를 걷어낼지 판단해야 하므로 여기서 소리내어 잠근다. 우회 판정 자체는
    // interaction.ts::altArrowSequence 가 갖고, 이 테스트는 stock 동작만 본다.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24 });
    const data: string[] = [];
    term.onData((d) => data.push(d));
    term.open(host);
    try {
      term.textarea!.dispatchEvent(arrowEvent("ArrowUp", { altKey: true }));
      await vi.waitFor(() => {
        expect(data).toEqual(["\x1b[1;5A"]);
      });
    } finally {
      term.dispose();
      host.remove();
    }
  });
});
