// @vitest-environment happy-dom
//
// 회귀 잠금이다. v0.3.18 은 `@xterm/headless` 가 `buffer` 를 `allowProposedApi` 뒤에
// 두는 줄 몰랐고, 그 예외는 xterm 의 write 루프 안에서 터져 어디에도 보고되지
// 않았다 — 폰 화면은 검은 채, 입력은 비활성인 채로 남았다. 순수 판정 테스트는
// 이것을 잡을 수 없다: 실패 지점이 라이브러리 인스턴스와 그 콜백 사이에 있다.
//
// 스크롤 키도 같은 이유로 여기서 잠근다. 표시 조건과 인코딩 선택은 둘 다 실제
// 인스턴스가 스냅샷 바이트를 먹은 뒤의 버퍼·모드·파서 상태에서 나온다.

import { afterEach, describe, expect, it, vi } from "vitest";

import { TabView } from "./tab-view";
import type { TabId } from "../shared/types";

// 브래킷 붙여넣기를 켜는 시퀀스가 앞에 있어야 Send 가 텍스트를 감싼다.
const PROMPT = "kwon1@pc:~$ ls\r\napps  crates  docs\r\nkwon1@pc:~$ ";
const SCREEN = `\x1b[?2004h${PROMPT}`;
const TAB = 7 as unknown as TabId;

function screenResponse(url: string, screen: string): Response {
  const bytes = new TextEncoder().encode(screen);
  const reset = !url.includes("since=");
  const headers = new Headers({
    "X-Mast-End-Offset": String(bytes.length),
    "X-Mast-Reset": reset ? "1" : "0",
    "X-Mast-Cols": "120",
    "X-Mast-Rows": "30",
    "X-Mast-Session": "4242:7",
  });
  const body = reset ? bytes : new Uint8Array(0);
  return {
    ok: true,
    status: 200,
    headers,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("TabView first frame", () => {
  const posts: string[] = [];
  let view: TabView | null = null;

  afterEach(() => {
    view?.dispose();
    view?.root.remove();
    view = null;
    posts.length = 0;
    vi.unstubAllGlobals();
  });

  async function mount(screen: string): Promise<TabView> {
    window.localStorage.setItem("mast.remoteToken", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/screen")) return screenResponse(url, screen);
        if (url.includes("/input")) {
          posts.push(String(init?.body));
          return { ok: true, status: 204, headers: new Headers() } as unknown as Response;
        }
        throw new Error(`unexpected request ${url}`);
      }),
    );

    const mounted = new TabView({ tab: TAB, title: "t", onBack: () => undefined });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    mounted.start();
    await until(() => !textarea.disabled, "input to become enabled");
    return mounted;
  }

  function scrollKeys(mounted: TabView): { box: HTMLElement; up: HTMLButtonElement } {
    return {
      box: mounted.root.querySelector(".scroll-keys") as HTMLElement,
      up: mounted.root.querySelector("button.scroll-up") as HTMLButtonElement,
    };
  }

  it("renders the snapshot as text, enables input, and sends bracketed text then CR", async () => {
    const mounted = await mount(SCREEN);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    const pre = mounted.root.querySelector("pre.screen-pre") as HTMLPreElement;
    const notice = mounted.root.querySelector(".notice") as HTMLElement;

    expect(pre.textContent).toContain("apps  crates  docs");
    expect(notice.hidden).toBe(true);
    for (const button of mounted.root.querySelectorAll("button.composer-send, button.key")) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
    // 일반 버퍼에 마우스 추적도 없다 — 되감을 것이 이쪽에 이미 다 있다.
    expect(scrollKeys(mounted).box.hidden).toBe(true);

    textarea.value = "hello";
    (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
    await until(() => posts.length === 2, "text and Enter to be posted");
    expect(posts).toEqual(["\x1b[200~hello\x1b[201~", "\r"]);
    expect(textarea.value).toBe("");
  });

  it("an SGR-mouse alt screen scrolls with wheel reports", async () => {
    const mounted = await mount(`\x1b[?1049h\x1b[?1000h\x1b[?1006h${PROMPT}`);
    const keys = scrollKeys(mounted);
    expect(keys.box.hidden).toBe(false);

    keys.up.click();
    await until(() => posts.length === 1, "a wheel report to be posted");
    // 헤더가 준 120x30 의 한가운데.
    expect(posts).toEqual(["\x1b[<64;60;15M".repeat(5)]);

    posts.length = 0;
    (mounted.root.querySelector("button.scroll-down") as HTMLButtonElement).click();
    await until(() => posts.length === 1, "a downward wheel report to be posted");
    expect(posts).toEqual(["\x1b[<65;60;15M".repeat(5)]);
  });

  it("an alt screen without mouse tracking scrolls with PageUp", async () => {
    const mounted = await mount(`\x1b[?1049h${PROMPT}`);
    const keys = scrollKeys(mounted);
    expect(keys.box.hidden).toBe(false);

    keys.up.click();
    await until(() => posts.length === 1, "PageUp to be posted");
    expect(posts).toEqual(["\x1b[5~"]);
  });

  it("mouse tracking without SGR encoding falls back to PageUp", async () => {
    const mounted = await mount(`\x1b[?1000h${PROMPT}`);
    const keys = scrollKeys(mounted);
    expect(keys.box.hidden).toBe(false);

    keys.up.click();
    await until(() => posts.length === 1, "PageUp to be posted");
    // X10 리포트를 지어내지 않는다 — 받는 쪽이 읽지 못하면 원시 바이트가 입력으로 남는다.
    expect(posts).toEqual(["\x1b[5~"]);
  });

  it("↑ sends the plain arrow escape when DECCKM is off", async () => {
    const mounted = await mount(SCREEN);
    (mounted.root.querySelector("button.key-up") as HTMLButtonElement).click();
    await until(() => posts.length === 1, "an arrow escape to be posted");
    expect(posts).toEqual(["\x1b[A"]);
  });

  it("↑ sends the DECCKM arrow escape once the snapshot enables it", async () => {
    const mounted = await mount(`\x1b[?1h${PROMPT}`);
    (mounted.root.querySelector("button.key-up") as HTMLButtonElement).click();
    await until(() => posts.length === 1, "a DECCKM arrow escape to be posted");
    expect(posts).toEqual(["\x1bOA"]);
  });

  it("↻ re-requests a full snapshot and re-enables input, even while disabled", async () => {
    const mounted = await mount(SCREEN);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    const refresh = mounted.root.querySelector("button.bar-refresh") as HTMLButtonElement;
    const fetchMock = window.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    refresh.click();
    // resetToFull 이 인스턴스를 접는 동안 입력은 비활성이다 — 새로고침 버튼
    // 자체는 그 상태에서도 눌려야 한다 (controls 밖).
    expect(textarea.disabled).toBe(true);
    expect(refresh.disabled).toBe(false);

    await until(() => !textarea.disabled, "input to be re-enabled after resync");
    const screenUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/screen"));
    expect(screenUrls.length).toBeGreaterThan(0);
    for (const url of screenUrls) expect(url).not.toContain("since=");
  });
});
