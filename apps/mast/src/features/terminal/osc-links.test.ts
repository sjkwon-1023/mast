// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";

const h = vi.hoisted(() => ({
  openUrl: vi.fn(async (_url: string) => undefined),
  writeStdin: vi.fn(async (_session: number, _data: string) => undefined),
}));

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

/** attach 응답 `[u64 LE end_offset][u8 first_attach][replay bytes]` — 빈 재생. */
function attachBody(): ArrayBuffer {
  const out = new Uint8Array(9);
  out[8] = 1; // firstAttach — replayDone 이 즉시 선다.
  return out.buffer;
}

function termOf(view: TerminalView): Terminal {
  return (view as unknown as { term: Terminal }).term;
}

async function linksOf(term: Terminal, providerIndex: number): Promise<ILink[]> {
  // 실제 브라우저 번들의 OSC 8 제공자와 일반 URL 제공자를 각각 실행한다.
  const core = (term as unknown as {
    _core: { _linkProviderService: { linkProviders: ILinkProvider[] } };
  })._core;
  return new Promise((resolve) => {
    core._linkProviderService.linkProviders[providerIndex].provideLinks(1, (links) => resolve(links ?? []));
  });
}

const URL = "https://github.com/sjkwon-1023/mast/releases/tag/v0.3.36";

async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, resolve));
}

describe("터미널 링크를 기본 브라우저로 열기", () => {
  beforeEach(() => h.openUrl.mockClear());

  for (const kind of ["osc", "plain"] as const) {
    it(`${kind} 링크는 경고창이나 window.open 없이 openUrl로 전달한다`, async () => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new TerminalView(host, 7);
      const confirm = vi.fn();
      vi.stubGlobal("confirm", confirm);
      const popup = vi.spyOn(window, "open");
      try {
        await view.attach();
        const term = termOf(view);
        await write(term, kind === "osc" ? `\x1b]8;;${URL}\x07릴리즈\x1b]8;;\x07` : URL);
        const links = await linksOf(term, kind === "osc" ? 0 : 1);
        expect(links).toHaveLength(1);
        links[0].activate(new MouseEvent("click"), links[0].text);
        expect(h.openUrl).toHaveBeenCalledExactlyOnceWith(URL);
        expect(confirm).not.toHaveBeenCalled();
        expect(popup).not.toHaveBeenCalled();
      } finally {
        view.dispose();
        host.remove();
        vi.unstubAllGlobals();
        popup.mockRestore();
      }
    });
  }

  it("OSC 8도 HTTP(S) 제한과 TUI 마우스 모드 검사를 따른다", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new TerminalView(host, 7);
    try {
      await view.attach();
      const term = termOf(view);
      await write(term, "\x1b]8;;file:///C:/test.txt\x07파일\x1b]8;;\x07");
      expect(await linksOf(term, 0)).toEqual([]);
      await write(term, `\r\x1b[2K\x1b]8;;${URL}\x07릴리즈\x1b]8;;\x07\x1b[?1000h`);
      const links = await linksOf(term, 0);
      expect(links).toHaveLength(1);
      links[0].activate(new MouseEvent("click"), links[0].text);
      expect(h.openUrl).not.toHaveBeenCalled();
    } finally {
      view.dispose();
      host.remove();
    }
  });
});
