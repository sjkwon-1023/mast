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

function screenResponse(url: string, screen: string, owner = "desktop"): Response {
  const bytes = new TextEncoder().encode(screen);
  const reset = !url.includes("since=");
  const headers = new Headers({
    "X-Mast-End-Offset": String(bytes.length),
    "X-Mast-Reset": reset ? "1" : "0",
    "X-Mast-Cols": "120",
    "X-Mast-Rows": "30",
    "X-Mast-Size-Owner": owner,
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

function resizeResponse(owner: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "X-Mast-Size-Owner": owner }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 직접 만든 fetch 구현으로 뷰를 띄운다 — 지연 응답·이탈 사례가 기본 스텁의
 *  즉시 응답으로는 재현되지 않아서다. */
async function mountWith(impl: FetchImpl): Promise<TabView> {
  window.localStorage.setItem("mast.remoteToken", "test-token");
  vi.stubGlobal("fetch", vi.fn(impl));
  const mounted = new TabView({ tab: TAB, title: "t", onBack: () => undefined });
  document.body.append(mounted.root);
  const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.disabled).toBe(true);
  mounted.start();
  await until(() => !textarea.disabled, "input to become enabled");
  return mounted;
}

/** resolve/reject 를 밖에서 쥐는 promise — "요청 진행 중 이탈" 을 만들 때 쓴다. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TabView first frame", () => {
  const posts: string[] = [];
  const resizes: { url: string; keepalive: boolean }[] = [];
  let view: TabView | null = null;

  afterEach(() => {
    view?.dispose();
    view?.root.remove();
    view = null;
    posts.length = 0;
    resizes.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount(screen: string, owner = "desktop"): Promise<TabView> {
    // 서버처럼 소유자를 기억한다 — resize 가 소유자를 바꾸면 다음 폴의 화면 응답도
    // 바뀐 소유자를 싣는다 (그래야 낙관적 페인트를 폴이 되돌리지 않는다).
    let ownerNow = owner;
    const mounted = await mountWith(async (input, init) => {
      const url = String(input);
      if (url.includes("/screen")) return screenResponse(url, screen, ownerNow);
      if (url.includes("/resize")) {
        const mode = new URL(url, "http://mast").searchParams.get("mode");
        ownerNow = mode === "mobile" ? "mobile" : "desktop";
        resizes.push({ url, keepalive: init?.keepalive === true });
        return resizeResponse(ownerNow);
      }
      if (url.includes("/input")) {
        posts.push(String(init?.body));
        return { ok: true, status: 204, headers: new Headers() } as unknown as Response;
      }
      throw new Error(`unexpected request ${url}`);
    });
    view = mounted;
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

  // --- PTY 크기 모드 (ADR-0016 개정) ---

  /** 출력 영역과 글자 격자를 흉내 낸다 — happy-dom 은 레이아웃이 없어 실제 측정이
   *  항상 0 이다. `pre` 폭 400px, 문자 폭 10px(표본 32자 = 320px), 줄 높이 17px,
   *  보이는 높이 640px → 400/10 - 1 = 39열, 640/17 = 37행. */
  function stubPhoneMetrics(): void {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement): DOMRect {
        const width = this.tagName === "SPAN" ? 320 : 400;
        const height = this.classList.contains("screen-text") ? 640 : 17;
        return {
          width,
          height,
          top: 0,
          left: 0,
          right: width,
          bottom: height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      lineHeight: "17px",
    } as unknown as CSSStyleDeclaration);
  }
  function modeButtons(mounted: TabView): {
    mobile: HTMLButtonElement;
    desktop: HTMLButtonElement;
  } {
    return {
      mobile: mounted.root.querySelector("button.mode-mobile") as HTMLButtonElement,
      desktop: mounted.root.querySelector("button.mode-desktop") as HTMLButtonElement,
    };
  }

  it("Mobile posts the measured phone size, Desktop releases it", async () => {
    stubPhoneMetrics();
    const mounted = await mount(SCREEN);
    const buttons = modeButtons(mounted);
    expect(buttons.mobile.getAttribute("aria-pressed")).toBe("false");
    expect(buttons.desktop.getAttribute("aria-pressed")).toBe("true");

    buttons.mobile.click();
    // 서버가 적용했다고 답한 소유자로 곧바로 칠한다 (다음 폴까지 기다리지 않는다).
    await until(
      () => buttons.mobile.getAttribute("aria-pressed") === "true",
      "the Mobile button to be painted",
    );
    expect(resizes[0].url).toBe("/api/tabs/7/resize?session=4242:7&mode=mobile&cols=39&rows=37");
    expect(buttons.desktop.getAttribute("aria-pressed")).toBe("false");

    buttons.desktop.click();
    await until(
      () => buttons.desktop.getAttribute("aria-pressed") === "true",
      "the Desktop button to be painted",
    );
    expect(resizes[1].url).toBe("/api/tabs/7/resize?session=4242:7&mode=desktop");
  });

  it("mode buttons follow the server's owner, not the last tap", async () => {
    // 폰이 소유한 세션을 열었다 — 서버가 mobile 이라고 말하면 Mobile 이 눌린 상태다.
    const mounted = await mount(SCREEN, "mobile");
    const buttons = modeButtons(mounted);
    expect(buttons.mobile.getAttribute("aria-pressed")).toBe("true");
    expect(buttons.desktop.getAttribute("aria-pressed")).toBe("false");
  });

  it("measuring alone never posts — a viewport change is not a resize", async () => {
    stubPhoneMetrics();
    const mounted = await mount(SCREEN);
    // 키보드가 열리고 닫히면 visualViewport/window 가 resize 된다. 그 사건이 PTY
    // 크기를 건드리면 TUI 가 매번 다시 그려진다 — 요청이 나가면 안 된다.
    window.dispatchEvent(new Event("resize"));
    window.visualViewport?.dispatchEvent(new Event("resize"));
    window.visualViewport?.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resizes).toEqual([]);
    expect(modeButtons(mounted).desktop.getAttribute("aria-pressed")).toBe("true");
  });

  it("leaving a tab while mobile-owned releases the size immediately", async () => {
    const mounted = await mount(SCREEN, "mobile");
    const fetchMock = window.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    mounted.dispose();
    await until(() => resizes.length === 1, "a release to be posted on dispose");
    expect(resizes[0].url).toBe("/api/tabs/7/resize?session=4242:7&mode=desktop");
    // 페이지가 사라지는 중에도 나가야 한다 — 리스 만료를 기다리지 않는 이유.
    expect(resizes[0].keepalive).toBe(true);
    view = null;
  });

  it("leaving a tab without mobile ownership posts nothing", async () => {
    const mounted = await mount(SCREEN);
    mounted.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resizes).toEqual([]);
    view = null;
  });

  it("a pagehide while mobile-owned releases with keepalive too", async () => {
    await mount(SCREEN, "mobile");
    window.dispatchEvent(new Event("pagehide"));
    await until(() => resizes.length === 1, "a release to be posted on pagehide");
    expect(resizes[0].url).toBe("/api/tabs/7/resize?session=4242:7&mode=desktop");
    expect(resizes[0].keepalive).toBe(true);
  });

  it("a claim that succeeds right before Back is handed back at once", async () => {
    // 폴을 멈춰 소유자를 되돌리지 못하게 한다 — 주장 성공이 수명 상태에 반영되지
    // 않으면 dispose 가 해제를 보내지 않는다 (예전에는 다음 폴까지 기다렸다).
    const mounted = await mount(SCREEN);
    mounted.setVisible(false);
    stubPhoneMetrics();
    const buttons = modeButtons(mounted);
    buttons.mobile.click();
    await until(
      () => buttons.mobile.getAttribute("aria-pressed") === "true",
      "the claim to be applied",
    );

    mounted.dispose();
    await until(() => resizes.length === 2, "the release on dispose");
    expect(resizes[1].url).toBe("/api/tabs/7/resize?session=4242:7&mode=desktop");
    expect(resizes[1].keepalive).toBe(true);
    view = null;
  });

  it("leaving while a claim is in flight releases it once the claim succeeds", async () => {
    const claim = deferred<Response>();
    const mounted = await mountWith(async (input, init) => {
      const url = String(input);
      if (url.includes("/screen")) return screenResponse(url, SCREEN, "desktop");
      if (url.includes("/resize")) {
        const mode = new URL(url, "http://mast").searchParams.get("mode");
        resizes.push({ url, keepalive: init?.keepalive === true });
        if (mode === "mobile") return claim.promise;
        return resizeResponse("desktop");
      }
      throw new Error(`unexpected request ${url}`);
    });
    view = mounted;
    mounted.setVisible(false);
    stubPhoneMetrics();
    modeButtons(mounted).mobile.click();
    await until(() => resizes.length === 1, "the claim to be sent");

    // 요청이 진행 중인 상태로 떠난다 — 응답이 성공하면 그 자리에서 되돌려야 한다.
    mounted.dispose();
    expect(resizes.length).toBe(1);
    claim.resolve(resizeResponse("mobile"));
    await until(() => resizes.length === 2, "the release after the late claim");
    expect(resizes[1].url).toBe("/api/tabs/7/resize?session=4242:7&mode=desktop");
    expect(resizes[1].keepalive).toBe(true);
    view = null;
  });

  it("a failed keepalive release is not treated as success", async () => {
    // 해제 요청이 네트워크 오류로 실패한다 — 성공으로 속이면(소유권을 데스크톱으로
    // 바꾸면) 다음 이탈에서 아무 요청도 나가지 않는다.
    let releaseFailures = 0;
    const mounted = await mountWith(async (input, init) => {
      const url = String(input);
      if (url.includes("/screen")) return screenResponse(url, SCREEN, "desktop");
      if (url.includes("/resize")) {
        const mode = new URL(url, "http://mast").searchParams.get("mode");
        resizes.push({ url, keepalive: init?.keepalive === true });
        if (mode === "mobile") return resizeResponse("mobile");
        releaseFailures += 1;
        throw new TypeError("network down");
      }
      throw new Error(`unexpected request ${url}`);
    });
    view = mounted;
    mounted.setVisible(false);
    stubPhoneMetrics();
    const buttons = modeButtons(mounted);
    buttons.mobile.click();
    await until(
      () => buttons.mobile.getAttribute("aria-pressed") === "true",
      "the claim to be applied",
    );

    window.dispatchEvent(new Event("pagehide"));
    await until(() => resizes.length === 2, "the release on pagehide");
    // 실패한 해제는 소유권을 바꾸지 않는다 — 다시 이탈하면 재시도된다.
    mounted.dispose();
    await until(() => resizes.length === 3, "the retried release on dispose");
    expect(resizes[2].keepalive).toBe(true);
    expect(releaseFailures).toBe(2);
    view = null;
  });

  it("a page restored from the back-forward cache can claim the size again", async () => {
    // pagehide 뒤 bfcache 에서 되살아난 페이지 — 이탈 표시가 남아 있으면 새 주장이
    // 성공하는 즉시 되돌려져(keepalive 해제) 폰이 소유를 가질 수 없다.
    const mounted = await mount(SCREEN, "mobile");
    window.dispatchEvent(new Event("pagehide"));
    await until(() => resizes.length === 1, "the release on pagehide");

    window.dispatchEvent(new Event("pageshow"));
    stubPhoneMetrics();
    const buttons = modeButtons(mounted);
    buttons.mobile.click();
    await until(() => resizes.length === 2, "the re-claim after restore");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(buttons.mobile.getAttribute("aria-pressed")).toBe("true");
    expect(resizes.length).toBe(2);
  });

  it("a screen reply requested before a successful claim does not undo its owner", async () => {
    // 폴 하나가 날아가 있는 동안 Mobile 이 성공한다 — 그 폴의 응답(옛 소유자)이
    // 늦게 도착해도 폰 소유를 데스크톱으로 되돌리면, 버튼도 이탈 해제도 틀린다.
    const stalePoll = deferred<Response>();
    let screenCalls = 0;
    const mounted = await mountWith(async (input) => {
      const url = String(input);
      if (url.includes("/screen")) {
        screenCalls += 1;
        if (screenCalls === 1) return screenResponse(url, SCREEN, "desktop");
        if (screenCalls === 2) return stalePoll.promise;
        return new Promise<Response>(() => undefined); // 이후 폴은 영영 오지 않는다
      }
      if (url.includes("/resize")) {
        resizes.push({ url, keepalive: false });
        return resizeResponse("mobile");
      }
      throw new Error(`unexpected request ${url}`);
    });
    view = mounted;
    stubPhoneMetrics();

    // 폴 하나를 띄운다 — 숨겼다 보이면 즉시 발사된다.
    mounted.setVisible(false);
    mounted.setVisible(true);
    await until(() => screenCalls === 2, "the poll to be in flight");

    const buttons = modeButtons(mounted);
    buttons.mobile.click();
    await until(
      () => buttons.mobile.getAttribute("aria-pressed") === "true",
      "the claim to be applied",
    );

    stalePoll.resolve(screenResponse("/screen?since=1&session=4242:7", SCREEN, "desktop"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(buttons.mobile.getAttribute("aria-pressed")).toBe("true");
    expect(buttons.desktop.getAttribute("aria-pressed")).toBe("false");
  });
});
