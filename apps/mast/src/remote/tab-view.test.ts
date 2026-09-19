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

import { httpTransport } from "./api";
import { ENTER_DELAY_MS } from "./input-queue";
import { TabView } from "./tab-view";
import { RemoteError, TransportClosedError } from "./transport";
import type { RemoteTransport, ScreenReply } from "./transport";
import type { TabId } from "../shared/types";

// 브래킷 붙여넣기를 켜는 시퀀스가 앞에 있어야 Send 가 텍스트를 감싼다.
const PROMPT = "kwon1@pc:~$ ls\r\napps  crates  docs\r\nkwon1@pc:~$ ";
const SCREEN = `\x1b[?2004h${PROMPT}`;
const TAB = 7 as unknown as TabId;
const CLOSED_TEXT = "Connection closed — scan the pairing QR in mast again.";
/** TabView 의 실제 화면 폴 간격(2초)을 확실히 넘기는 값 — 비공개 상수라 여기서 정한다. */
const POLL_INTERVAL_GUARD_MS = 2200;
const FULL_REPLY: ScreenReply = {
  meta: { sizeOwner: "desktop", endOffset: 12, reset: true, cols: 120, rows: 30, session: "4242:7" },
  bytes: new TextEncoder().encode(SCREEN),
};

/** 화면 응답과 입력 응답을 테스트가 직접 정착시키는 가짜 — 종료 경합의 순서를
 *  결정적으로 만들기 위한 것이다. */
function deferredTransport(): {
  transport: RemoteTransport;
  close: (message?: string) => void;
  resolveScreen: (reply: ScreenReply) => void;
  resolveInput: () => void;
  rejectInput: (error: unknown) => void;
  screenCalls: () => number;
  inputTexts: string[];
} {
  const screenWaits: ((reply: ScreenReply) => void)[] = [];
  const inputWaits: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  let closedHandler: ((message: string) => void) | null = null;
  let screenCount = 0;
  const inputTexts: string[] = [];
  const transport: RemoteTransport = {
    fetchState: async () => {
      throw new Error("not used by TabView");
    },
    fetchScreen: () => {
      screenCount += 1;
      return new Promise<ScreenReply>((resolve) => screenWaits.push(resolve));
    },
    postInput: (_tab, _session, data) => {
      inputTexts.push(data);
      return new Promise<void>((resolve, reject) => inputWaits.push({ resolve, reject }));
    },
    onClosed: (handler) => {
      closedHandler = handler;
      return () => {
        closedHandler = null;
      };
    },
  };
  return {
    transport,
    close: (message = CLOSED_TEXT) => closedHandler?.(message),
    resolveScreen: (reply) => screenWaits.shift()?.(reply),
    resolveInput: () => inputWaits.shift()?.resolve(),
    rejectInput: (error) => inputWaits.shift()?.reject(error),
    screenCalls: () => screenCount,
    inputTexts,
  };
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new Event("input"));
}

/** 읽기 전용 복구 상자들 — 화면에 남은 순서 그대로. */
function recoveryBoxes(mounted: TabView): HTMLTextAreaElement[] {
  return [...mounted.root.querySelectorAll("textarea.recovery-text")] as HTMLTextAreaElement[];
}

/** 화면에서 눈에 보이는 초안 전부 — 입력칸과 복구 영역을 순서대로. 종료 뒤 원문이
 *  어느 필드에 남았는지가 아니라 **사용자에게 보이는지**를 확인하기 위한 것이다. */
function visibleDrafts(mounted: TabView): string[] {
  const composer = mounted.root.querySelector("textarea.composer-text") as HTMLTextAreaElement;
  return [composer.value, ...recoveryBoxes(mounted).map((box) => box.value)].filter(
    (text) => text !== "",
  );
}

function flushMacrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 큐가 CR 을 보내기 전에 기다리는 지연(150ms)을 실제로 넘긴다 — "실패 뒤 CR 이
 *  나가지 않는다"는 그 지연이 지나야 판정할 수 있다. */
function pastEnterDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ENTER_DELAY_MS + 50));
}

function screenResponse(
  url: string,
  screen: string,
  owner = "desktop",
  session = "4242:7",
): Response {
  const bytes = new TextEncoder().encode(screen);
  const reset = !url.includes("since=");
  const headers = new Headers({
    "X-Mast-End-Offset": String(bytes.length),
    "X-Mast-Reset": reset ? "1" : "0",
    "X-Mast-Cols": "120",
    "X-Mast-Rows": "30",
    "X-Mast-Size-Owner": owner,
    "X-Mast-Session": session,
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
  const mounted = new TabView({ tab: TAB, title: "t", onBack: () => undefined, transport: httpTransport });
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

  async function mount(screen: string, owner: string | number = "desktop"): Promise<TabView> {
    // 서버처럼 소유자를 기억한다 — resize 가 소유자를 바꾸면 다음 폴의 화면 응답도
    // 바뀐 소유자를 싣는다 (그래야 낙관적 페인트를 폴이 되돌리지 않는다).
    const inputStatus = typeof owner === "number" ? owner : 204;
    let ownerNow = typeof owner === "string" ? owner : "desktop";
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
        return { ok: inputStatus < 400, status: inputStatus, headers: new Headers() } as unknown as Response;
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

  it("a 503 input busy restores the typed text without collapsing the screen", async () => {
    const mounted = await mount(SCREEN, 503);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "hello busy";
    (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
    await until(
      () => !(mounted.root.querySelector(".notice") as HTMLElement).hidden,
      "the busy notice",
    );
    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.textContent).toContain("busy");
    // 409 처럼 세션이 갈린 것이 아니므로 화면은 그대로 — 원문은 입력칸에 돌아온다.
    expect(textarea.value).toBe("hello busy");
    expect(textarea.disabled).toBe(false);
    expect((mounted.root.querySelector("pre.screen-pre") as HTMLPreElement).textContent).toContain(
      "apps  crates  docs",
    );
  });

  it("stops polling and disables input when the transport closes", async () => {
    const closed: { handler: ((message: string) => void) | null } = { handler: null };
    const reply: ScreenReply = {
      meta: { sizeOwner: "desktop", endOffset: 12, reset: true, cols: 120, rows: 30, session: "4242:7" },
      bytes: new TextEncoder().encode(SCREEN),
    };
    const transport: RemoteTransport = {
      fetchState: async () => {
        throw new Error("not used by TabView");
      },
      fetchScreen: async () => reply,
      postInput: async () => undefined,
      onClosed: (handler) => {
        closed.handler = handler;
        return () => {
          closed.handler = null;
        };
      },
    };
    const mounted = new TabView({ tab: TAB, title: "t", onBack: () => undefined, transport });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    mounted.start();
    await until(() => !textarea.disabled, "input to become enabled");

    closed.handler?.("Connection closed — scan the pairing QR in mast again.");
    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("scan the pairing QR");
    expect(textarea.disabled).toBe(true);
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

  it("a delayed release reply does not clear a newer claim's release coordinate", async () => {
    // pagehide 해제가 날아간 사이 bfcache 복원 뒤 같은 세션으로 다시 주장한다. 해제
    // 응답이 늦게 도착하며 새 주장의 좌표를 지우면, 서버는 mobile 인데 이쪽은 해제
    // 좌표를 잃어 다음 이탈(Back)에서 데스크톱으로 되돌릴 수 없다.
    const release = deferred<Response>();
    const mounted = await mountWith(async (input, init) => {
      const url = String(input);
      if (url.includes("/screen")) return screenResponse(url, SCREEN, "mobile");
      if (url.includes("/resize")) {
        const mode = new URL(url, "http://mast").searchParams.get("mode");
        resizes.push({ url, keepalive: init?.keepalive === true });
        if (mode === "mobile") return resizeResponse("mobile");
        // 서버는 이미 데스크톱으로 처리했다 — HTTP 응답만 늦는다.
        return release.promise;
      }
      throw new Error(`unexpected request ${url}`);
    });
    view = mounted;
    mounted.setVisible(false); // 폴이 좌표를 다시 세우지 않게 멈춘다

    window.dispatchEvent(new Event("pagehide"));
    await until(() => resizes.length === 1, "the release on pagehide");

    window.dispatchEvent(new Event("pageshow"));
    stubPhoneMetrics();
    modeButtons(mounted).mobile.click();
    await until(() => resizes.length === 2, "the re-claim after restore");

    // 늦은 해제 응답 — 새 주장의 좌표를 지우면 안 된다.
    release.resolve(resizeResponse("desktop"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    mounted.dispose();
    await until(() => resizes.length === 3, "the release on the later departure");
    expect(resizes[2].url).toBe("/api/tabs/7/resize?session=4242:7&mode=desktop");
    expect(resizes[2].keepalive).toBe(true);
    view = null;
  });

  it("a refresh then Back still releases the size the server says is Mobile", async () => {
    // ↻ 는 화면 상태를 초기화하지만 서버의 소유권은 그대로다 — 해제 좌표를 화면
    // 상태와 함께 버리면 이탈 해제가 나가지 않아 데스크톱이 리스 만료까지 좁다.
    const nextScreen = deferred<Response>();
    let screens = 0;
    const mounted = await mountWith(async (input, init) => {
      const url = String(input);
      if (url.includes("/screen")) {
        screens += 1;
        if (screens === 1) return screenResponse(url, SCREEN, "mobile");
        return nextScreen.promise; // ↻ 뒤 스냅샷은 오지 않는다
      }
      if (url.includes("/resize")) {
        resizes.push({ url, keepalive: init?.keepalive === true });
        return resizeResponse("desktop");
      }
      throw new Error(`unexpected request ${url}`);
    });
    view = mounted;

    (mounted.root.querySelector("button.bar-refresh") as HTMLButtonElement).click();
    mounted.dispose();
    await until(() => resizes.length === 1, "the release on dispose after refresh");
    expect(resizes[0].url).toBe("/api/tabs/7/resize?session=4242:7&mode=desktop");
    expect(resizes[0].keepalive).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resizes.length).toBe(1); // 중복 해제는 없다
    view = null;
  });

  it("a refresh then pagehide still releases the size the server says is Mobile", async () => {
    const nextScreen = deferred<Response>();
    let screens = 0;
    const mounted = await mountWith(async (input, init) => {
      const url = String(input);
      if (url.includes("/screen")) {
        screens += 1;
        if (screens === 1) return screenResponse(url, SCREEN, "mobile");
        return nextScreen.promise;
      }
      if (url.includes("/resize")) {
        resizes.push({ url, keepalive: init?.keepalive === true });
        return resizeResponse("desktop");
      }
      throw new Error(`unexpected request ${url}`);
    });
    view = mounted;

    (mounted.root.querySelector("button.bar-refresh") as HTMLButtonElement).click();
    window.dispatchEvent(new Event("pagehide"));
    await until(() => resizes.length === 1, "the release on pagehide after refresh");
    expect(resizes[0].url).toBe("/api/tabs/7/resize?session=4242:7&mode=desktop");
    expect(resizes[0].keepalive).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resizes.length).toBe(1); // 중복 해제는 없다
  });

  it("a claim that lands after a refresh and Back is released with its own session", async () => {
    // 주장이 날아가 있는 사이 ↻ 로 화면 상태가 비고 그 다음 Back — 보상 해제는
    // state.session(이제 null)이 아니라 요청 시점의 세션으로 나가야 한다.
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
    mounted.setVisible(false); // 폴이 state 를 되돌리지 않게 멈춘다
    stubPhoneMetrics();
    modeButtons(mounted).mobile.click();
    await until(() => resizes.length === 1, "the claim to be sent");

    (mounted.root.querySelector("button.bar-refresh") as HTMLButtonElement).click();
    mounted.dispose();
    expect(resizes.length).toBe(1); // 아직 해제는 없다 — 주장이 성공해야 나간다

    claim.resolve(resizeResponse("mobile"));
    await until(() => resizes.length === 2, "the release after the late claim");
    expect(resizes[1].url).toBe("/api/tabs/7/resize?session=4242:7&mode=desktop");
    expect(resizes[1].keepalive).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resizes.length).toBe(2); // 보상 해제 하나뿐 — 중복은 없다
    view = null;
  });

  it("a claim for a replaced shell does not repaint or release the new shell", async () => {
    // 주장이 나간 뒤 탭이 Restart 되면(새 세션) 그 응답은 옛 셸의 것이다 —
    // 새 화면의 소유자도 해제 좌표도 덮지 않는다.
    const claim = deferred<Response>();
    let screens = 0;
    const mounted = await mountWith(async (input, init) => {
      const url = String(input);
      if (url.includes("/screen")) {
        screens += 1;
        return screens === 1
          ? screenResponse(url, SCREEN, "desktop")
          : screenResponse(url, SCREEN, "desktop", "5000:9");
      }
      if (url.includes("/resize")) {
        const mode = new URL(url, "http://mast").searchParams.get("mode");
        resizes.push({ url, keepalive: init?.keepalive === true });
        if (mode === "mobile") return claim.promise;
        return resizeResponse("desktop");
      }
      throw new Error(`unexpected request ${url}`);
    });
    view = mounted;
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    stubPhoneMetrics();
    modeButtons(mounted).mobile.click();
    await until(() => resizes.length === 1, "the claim to be sent");

    // 다음 폴이 새 셸의 스냅샷을 받는다 — 옛 화면 인스턴스가 접힌다.
    mounted.setVisible(false);
    mounted.setVisible(true);
    await until(() => textarea.disabled, "the old shell's screen to be dropped");
    mounted.setVisible(false); // 옛 주장의 늦은 페인트를 폴이 덮지 않게 멈춘다

    claim.resolve(resizeResponse("mobile"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(modeButtons(mounted).mobile.getAttribute("aria-pressed")).toBe("false");
    expect(resizes.length).toBe(1); // 해제도 나가지 않는다

    mounted.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resizes.length).toBe(1);
    view = null;
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

  it("a screen response settling after close cannot clear the notice or enable input", async () => {
    const fake = deferredTransport();
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    mounted.start();
    await until(() => fake.screenCalls() === 1, "the first screen request");

    fake.close();
    fake.resolveScreen(FULL_REPLY);
    await flushMacrotasks();

    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("scan the pairing QR");
    expect(textarea.disabled).toBe(true);
    // 응답이 적용되지 않았으니 화면도 세워지지 않는다 — 종료 뒤의 폴은 전부 무효다.
    expect((mounted.root.querySelector("pre.screen-pre") as HTMLPreElement).textContent).toBe("");
  });

  it("a late xterm write callback cannot re-enable input after close", async () => {
    const fake = deferredTransport();
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    mounted.start();
    await until(() => fake.screenCalls() === 1, "the first screen request");

    fake.resolveScreen(FULL_REPLY);
    // poll continuation 이 apply → createTerminal → term.write 까지 간 직후,
    // xterm 의 write 콜백(별도 macrotask)이 돌기 전에 종료를 끼워 넣는다.
    await Promise.resolve();
    fake.close();
    await flushMacrotasks();

    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.textContent).toContain("scan the pairing QR");
    expect(textarea.disabled).toBe(true);
    // write 콜백이 끝났다면 렌더가 돌아 화면이 채워졌을 것이다 — 그 전에 막혀야 한다.
    expect((mounted.root.querySelector("pre.screen-pre") as HTMLPreElement).textContent).toBe("");
  });

  it("a late input failure cannot overwrite the closed notice", async () => {
    const fake = deferredTransport();
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    mounted.start();
    await until(() => fake.screenCalls() === 1, "the first screen request");
    fake.resolveScreen(FULL_REPLY);
    await until(() => !textarea.disabled, "input to become enabled");

    textarea.value = "hello busy";
    (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
    await until(() => fake.inputTexts.length === 1, "the input request");

    fake.close();
    fake.rejectInput(new RemoteError(503, "input busy"));
    await flushMacrotasks();

    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("scan the pairing QR");
    expect(notice.textContent).not.toContain("busy");
    expect(textarea.disabled).toBe(true);
    // 원문도 남는다 — 종료 뒤 입력칸은 비활성이라 보관만 해 두면 보이지 않는다.
    expect(visibleDrafts(mounted)).toEqual(["hello busy"]);
  });

  it("a late input success cannot restart polling after close", async () => {
    // 시작부터 가짜 타이머를 쓴다 — 스케줄이 무장하는 폴 타이머 자체를 우리가
    // 돌려야 "종료가 그것을 지웠나"를 실제 간격으로 판정할 수 있다. 실제 타이머로
    // 시작한 뒤 가짜로 바꾸면 그 타이머가 가짜 시계 밖에 남아 검증이 무력해진다.
    vi.useFakeTimers();
    const fake = deferredTransport();
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    mounted.start();
    // `start` 는 폴을 동기로 쏜다.
    expect(fake.screenCalls()).toBe(1);
    fake.resolveScreen(FULL_REPLY);
    // 폴 continuation → apply → xterm write 콜백(0ms 타이머일 수 있다).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(textarea.disabled).toBe(false);

    textarea.value = "hello";
    (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
    expect(fake.inputTexts.length).toBe(1); // pump 는 첫 await 전까지 동기다.

    // 종료가 실제 폴 간격(2초)을 넘겨도 새 폴이 나가지 않아야 한다. 큐의 CR 까지
    // 정착시켜 "늦은 입력 성공"이 pollNow 를 부르는 경로도 함께 지나간다.
    fake.close();
    fake.resolveInput();
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS + 50);
    expect(fake.inputTexts.length).toBe(2);
    fake.resolveInput();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_GUARD_MS);
    vi.useRealTimers();

    expect(fake.screenCalls()).toBe(1);
    expect(textarea.disabled).toBe(true);
    expect((mounted.root.querySelector(".notice") as HTMLElement).textContent).toContain(
      "scan the pairing QR",
    );
  });

  it("keeps a failed Send's text without overwriting a newer draft", async () => {
    const fake = deferredTransport();
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    mounted.start();
    await until(() => fake.screenCalls() === 1, "the first screen request");
    fake.resolveScreen(FULL_REPLY);
    await until(() => !textarea.disabled, "input to become enabled");

    textarea.value = "first try";
    (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
    await until(() => fake.inputTexts.length === 1, "the input request");

    // 전송 중에 사용자가 새 초안을 친다 — 실패가 돌아와도 덮어쓰면 안 된다.
    typeInto(textarea, "second draft");
    fake.rejectInput(new RemoteError(503, "input busy"));
    await until(
      () => !(mounted.root.querySelector(".notice") as HTMLElement).hidden,
      "the busy notice",
    );
    expect(textarea.value).toBe("second draft");

    // 새 초안을 지우면 실패한 원문이 돌아온다 — 어느 쪽도 사라지지 않는다.
    typeInto(textarea, "");
    expect(textarea.value).toBe("first try");
  });

  it("sending a newer draft restores the older failed text to the composer", async () => {
    const fake = deferredTransport();
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    mounted.start();
    await until(() => fake.screenCalls() === 1, "the first screen request");
    fake.resolveScreen(FULL_REPLY);
    await until(() => !textarea.disabled, "input to become enabled");

    textarea.value = "first try";
    (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
    await until(() => fake.inputTexts.length === 1, "the first input request");

    // 전송 중에 새 초안을 쳐 둔 상태에서 첫 Send 가 503 으로 거절된다 — 원문은
    // 새 초안을 덮지 않으려고 보관만 된다 (기존 테스트가 잠근 경로).
    typeInto(textarea, "second draft");
    fake.rejectInput(new RemoteError(503, "input busy"));
    await until(
      () => !(mounted.root.querySelector(".notice") as HTMLElement).hidden,
      "the busy notice",
    );
    expect(textarea.value).toBe("second draft");

    // 새 초안을 Send 하면 프로그램이 입력칸을 비운다 — DOM input 이벤트가 없어도
    // 보관해 둔 원문이 여기서 나타나야 한다. 아니면 성공한 뒤에도 영영 숨는다.
    (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
    await until(() => fake.inputTexts.length === 2, "the second input request");
    expect(textarea.value).toBe("first try");
  });

  it("a second failed Send keeps both drafts recoverable", async () => {
    const fake = deferredTransport();
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    mounted.start();
    await until(() => fake.screenCalls() === 1, "the first screen request");
    fake.resolveScreen(FULL_REPLY);
    await until(() => !textarea.disabled, "input to become enabled");

    textarea.value = "first try";
    (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
    await until(() => fake.inputTexts.length === 1, "the first input request");

    typeInto(textarea, "second draft");
    fake.rejectInput(new RemoteError(503, "input busy"));
    await flushMacrotasks();
    expect(textarea.value).toBe("second draft");

    // 새 초안 Send → 첫 원문이 입력칸으로 돌아온다 (위 테스트와 같은 순서).
    (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
    await until(() => fake.inputTexts.length === 2, "the second input request");
    expect(textarea.value).toBe("first try");

    // 새 초안도 거절되면 입력칸의 원문은 그대로 두고 새 초안을 보관한다.
    fake.rejectInput(new RemoteError(503, "input busy"));
    await flushMacrotasks();
    expect(textarea.value).toBe("first try");
    expect(fake.inputTexts.length).toBe(2);

    // 입력칸을 비우면 보관해 둔 새 초안이 돌아온다 — 어느 쪽도 사라지지 않는다.
    typeInto(textarea, "");
    expect(textarea.value).toBe("second draft");
  });

  it("a Send while another Send is in flight keeps the new draft in the composer", async () => {
    const fake = deferredTransport();
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    const send = mounted.root.querySelector("button.composer-send") as HTMLButtonElement;
    mounted.start();
    await until(() => fake.screenCalls() === 1, "the first screen request");
    fake.resolveScreen(FULL_REPLY);
    await until(() => !textarea.disabled, "input to become enabled");

    textarea.value = "first try";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the first input request");

    // 첫 요청이 아직 정착하지 않았다 — 두 번째 Send 는 큐에 들어가지 않고 초안을
    // 입력칸에 남긴 채 기다리라는 안내를 보여야 한다.
    typeInto(textarea, "second draft");
    send.click();
    expect(fake.inputTexts.length).toBe(1);
    expect(textarea.value).toBe("second draft");
    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("wait");
  });

  it("a 503 on the in-flight Send leaves both drafts recoverable", async () => {
    const fake = deferredTransport();
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    const send = mounted.root.querySelector("button.composer-send") as HTMLButtonElement;
    mounted.start();
    await until(() => fake.screenCalls() === 1, "the first screen request");
    fake.resolveScreen(FULL_REPLY);
    await until(() => !textarea.disabled, "input to become enabled");

    textarea.value = "first try";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the first input request");

    typeInto(textarea, "second draft");
    send.click(); // in-flight 라 큐에 들어가지 않는다.
    expect(fake.inputTexts.length).toBe(1);
    expect(textarea.value).toBe("second draft");

    // 앞 요청이 503 으로 정착하면 새 초안은 입력칸에 그대로 남고 첫 원문은 보관된다.
    // (차단 안내가 이미 떠 있으므로 notice 존재가 아니라 정착 자체를 기다린다.)
    fake.rejectInput(new RemoteError(503, "input busy"));
    await flushMacrotasks();
    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.textContent).toContain("busy");
    expect(textarea.value).toBe("second draft");

    // 큐가 비었으니 이제 새 초안을 보낼 수 있고, 보관된 첫 원문이 그 자리에 나타난다.
    send.click();
    await until(() => fake.inputTexts.length === 2, "the second input request");
    expect(fake.inputTexts[1]).toContain("second draft");
    expect(textarea.value).toBe("first try");
  });

  it("after the in-flight Send succeeds, the newer draft can be sent", async () => {
    const fake = deferredTransport();
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    const send = mounted.root.querySelector("button.composer-send") as HTMLButtonElement;
    mounted.start();
    await until(() => fake.screenCalls() === 1, "the first screen request");
    fake.resolveScreen(FULL_REPLY);
    await until(() => !textarea.disabled, "input to become enabled");

    textarea.value = "first try";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the first input request");

    typeInto(textarea, "second draft");
    send.click(); // in-flight 라 큐에 들어가지 않는다.
    expect(textarea.value).toBe("second draft");
    expect(fake.inputTexts.length).toBe(1);

    // 첫 Send 가 텍스트와 CR 두 요청으로 정착한다.
    fake.resolveInput();
    await until(() => fake.inputTexts.length === 2, "the CR request");
    fake.resolveInput();
    await flushMacrotasks();

    // 큐가 비었으니 같은 초안을 다시 Send 할 수 있다 — 이번에는 정상 전송된다.
    send.click();
    await until(() => fake.inputTexts.length === 3, "the second draft to be posted");
    expect(fake.inputTexts[2]).toContain("second draft");
    expect(textarea.value).toBe("");
  });

  it("a 409 input keeps the original text and collapses the screen", async () => {
    const mounted = await mount(SCREEN, 409);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "hello reset";
    (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
    await until(
      () => !(mounted.root.querySelector(".notice") as HTMLElement).hidden,
      "the reset notice",
    );
    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.textContent).toContain("restarted");
    expect(textarea.value).toBe("hello reset");
    // resetToFull 이 인스턴스를 접었다 — 다음 폴이 새 스냅샷을 받을 때까지 비활성.
    expect(textarea.disabled).toBe(true);
  });

  /** `fake` 로 화면 한 장을 세우고 입력이 활성화된 TabView 를 준비한다 — 아래
   *  종료·타임아웃 경합 테스트들이 같은 앞단을 반복해서 쓴다. */
  async function mountDeferred(
    fake: ReturnType<typeof deferredTransport>,
  ): Promise<{ mounted: TabView; textarea: HTMLTextAreaElement; send: HTMLButtonElement }> {
    const mounted = new TabView({
      tab: TAB,
      title: "t",
      onBack: () => undefined,
      transport: fake.transport,
    });
    view = mounted;
    document.body.append(mounted.root);
    const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
    mounted.start();
    await until(() => fake.screenCalls() === 1, "the first screen request");
    fake.resolveScreen(FULL_REPLY);
    await until(() => !textarea.disabled, "input to become enabled");
    return {
      mounted,
      textarea,
      send: mounted.root.querySelector("button.composer-send") as HTMLButtonElement,
    };
  }

  it("a 503 input write timed out warns that delivery is uncertain", async () => {
    const fake = deferredTransport();
    const { mounted, textarea, send } = await mountDeferred(fake);

    textarea.value = "uncertain text";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the input request");

    fake.rejectInput(new RemoteError(503, "input write timed out"));
    await until(
      () => !(mounted.root.querySelector(".notice") as HTMLElement).hidden,
      "the uncertain warning",
    );

    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    // 서버는 이 쓰기를 취소하지 않는다 — "보내지 않았다"로 안내하면 재전송이
    // 같은 입력을 두 번 넣는다.
    expect(notice.textContent).toContain("uncertain");
    expect(notice.textContent).not.toContain("not sent");
    expect(notice.textContent).not.toContain("Try again");
    // 노란 경고 톤 — "보내지 않았다"(빨강)와 눈으로도 갈린다.
    expect(notice.classList.contains("notice-warn")).toBe(true);
    // 원문은 입력칸에 그대로 남아 사용자가 확인 뒤 직접 판단할 수 있다.
    expect(textarea.value).toBe("uncertain text");
    expect(textarea.disabled).toBe(false);
    // 화면은 접히지 않았고, 자동 재전송도 뒤따르는 CR 도 없다.
    await pastEnterDelay();
    expect(fake.inputTexts).toEqual(["\x1b[200~uncertain text\x1b[201~"]);
    expect((mounted.root.querySelector("pre.screen-pre") as HTMLPreElement).textContent).toContain(
      "apps  crates  docs",
    );
  });

  it("a 503 with a different message keeps the not-sent wording", async () => {
    const fake = deferredTransport();
    const { mounted, textarea, send } = await mountDeferred(fake);

    textarea.value = "hello busy";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the input request");

    // 서버가 문구로 세 가지 503 을 가르므로 판정은 정확한 문구에만 걸려야 한다.
    fake.rejectInput(new RemoteError(503, "input busy"));
    await until(
      () => !(mounted.root.querySelector(".notice") as HTMLElement).hidden,
      "the busy notice",
    );

    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.textContent).toContain("not sent");
    expect(notice.textContent).not.toContain("uncertain");
    // 같은 503 이라도 이쪽은 경고 톤이 아니다.
    expect(notice.classList.contains("notice-warn")).toBe(false);
  });

  it("the uncertain-delivery warning survives a later successful screen poll", async () => {
    // 실제 폴 간격(2초)을 가짜 타이머로 넘겨 "다음 폴 성공"을 결정적으로 만든다.
    // 실제 타이머로 시작한 뒤 가짜로 바꾸면 폴 타이머가 가짜 시계 밖에 남는다.
    vi.useFakeTimers();
    try {
      const fake = deferredTransport();
      const mounted = new TabView({
        tab: TAB,
        title: "t",
        onBack: () => undefined,
        transport: fake.transport,
      });
      view = mounted;
      document.body.append(mounted.root);
      const textarea = mounted.root.querySelector("textarea") as HTMLTextAreaElement;
      mounted.start();
      expect(fake.screenCalls()).toBe(1);
      fake.resolveScreen(FULL_REPLY);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(textarea.disabled).toBe(false);

      textarea.value = "uncertain text";
      (mounted.root.querySelector("button.composer-send") as HTMLButtonElement).click();
      expect(fake.inputTexts.length).toBe(1);
      fake.rejectInput(new RemoteError(503, "input write timed out"));
      await vi.advanceTimersByTimeAsync(0);

      const notice = mounted.root.querySelector(".notice") as HTMLElement;
      expect(notice.textContent).toContain("uncertain");
      expect(notice.classList.contains("notice-warn")).toBe(true);

      // 2초 뒤 성공한 폴이 정착해도 경고는 남아야 한다 — 화면 폴은 2초마다
      // 오므로, 그때마다 지워지면 사용자가 읽을 틈이 없다.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_GUARD_MS);
      expect(fake.screenCalls()).toBe(2);
      fake.resolveScreen({
        meta: { sizeOwner: "desktop", endOffset: 12, reset: false, cols: 120, rows: 30, session: "4242:7" },
        bytes: new Uint8Array(0),
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(notice.hidden).toBe(false);
      expect(notice.textContent).toContain("uncertain");
      expect(notice.classList.contains("notice-warn")).toBe(true);

      // 더 강한 오류(연결 종료)는 이 경고를 덮는다.
      fake.close();
      expect(notice.textContent).toContain("scan the pairing QR");
      expect(notice.classList.contains("notice-warn")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a new Send dismisses the uncertain-delivery warning", async () => {
    const fake = deferredTransport();
    const { mounted, textarea, send } = await mountDeferred(fake);

    textarea.value = "uncertain text";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the input request");
    fake.rejectInput(new RemoteError(503, "input write timed out"));
    await until(
      () => !(mounted.root.querySelector(".notice") as HTMLElement).hidden,
      "the uncertain warning",
    );
    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.classList.contains("notice-warn")).toBe(true);

    // 원문이 입력칸에 돌아와 있다 — 다시 보내는 것은 사용자의 판단이므로
    // 그 순간 경고는 사라진다.
    expect(textarea.value).toBe("uncertain text");
    send.click();
    expect(notice.hidden).toBe(true);
    await until(() => fake.inputTexts.length === 2, "the retried input request");
  });

  it("the refresh button dismisses the uncertain-delivery warning", async () => {
    const fake = deferredTransport();
    const { mounted, textarea, send } = await mountDeferred(fake);

    textarea.value = "uncertain text";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the input request");
    fake.rejectInput(new RemoteError(503, "input write timed out"));
    await until(
      () => !(mounted.root.querySelector(".notice") as HTMLElement).hidden,
      "the uncertain warning",
    );
    const notice = mounted.root.querySelector(".notice") as HTMLElement;

    const refresh = mounted.root.querySelector("button.bar-refresh") as HTMLButtonElement;
    refresh.click();
    expect(notice.hidden).toBe(true);

    // 새 스냅샷이 정착해도 경고는 돌아오지 않는다.
    await until(() => fake.screenCalls() === 2, "the full resync request");
    fake.resolveScreen(FULL_REPLY);
    await until(() => !textarea.disabled, "input to be re-enabled after resync");
    expect(notice.hidden).toBe(true);
  });

  it("a close while a Send is in flight keeps the draft visible", async () => {
    const fake = deferredTransport();
    const { mounted, textarea, send } = await mountDeferred(fake);

    textarea.value = "hello after close";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the input request");

    // onClosed 가 입력 promise 의 거절보다 먼저 온다 — 예전에는 이 순서에서
    // reportInputError 의 closed 가드가 원문을 그냥 버렸다.
    fake.close();
    fake.rejectInput(new TransportClosedError(CLOSED_TEXT));
    await pastEnterDelay();

    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.textContent).toContain("scan the pairing QR");
    expect(textarea.disabled).toBe(true);
    expect(visibleDrafts(mounted)).toEqual(["hello after close"]);

    // 실패한 텍스트 뒤의 CR 은 큐가 이미 버렸고, Send 는 비활성이라 재전송도 없다.
    expect(fake.inputTexts.length).toBe(1);
    send.click();
    expect(fake.inputTexts.length).toBe(1);
  });

  it("a transport-close rejection keeps the draft before the close event arrives", async () => {
    const fake = deferredTransport();
    const { mounted, send, textarea } = await mountDeferred(fake);

    textarea.value = "hello closed transport";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the input request");

    // 거절이 먼저 온다 — reportInputError 가 스스로 종료 처리로 들어간다.
    fake.rejectInput(new TransportClosedError(CLOSED_TEXT));
    await pastEnterDelay();

    const notice = mounted.root.querySelector(".notice") as HTMLElement;
    expect(notice.textContent).toContain("scan the pairing QR");
    expect(visibleDrafts(mounted)).toEqual(["hello closed transport"]);
    expect(fake.inputTexts.length).toBe(1);
  });

  it("a close keeps the newer draft and the pending text separately", async () => {
    const fake = deferredTransport();
    const { mounted, textarea, send } = await mountDeferred(fake);

    textarea.value = "first try";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the first input request");

    // 전송 중에 새 초안을 쳐 둔 채 연결이 끊긴다: 입력칸의 새 초안은 덮으면 안
    // 되고, 앞 요청의 원문도 버리면 안 된다 — 둘 다 화면에 남아야 한다.
    typeInto(textarea, "second draft");
    fake.close();
    fake.rejectInput(new TransportClosedError(CLOSED_TEXT));
    await flushMacrotasks();

    // 입력칸의 새 초안도 읽기 전용 복구 상자로 옮겨졌다 — 비활성 입력칸에는
    // 남기지 않는다 (폰에서 선택·복사가 되지 않는다).
    expect(textarea.value).toBe("");
    expect(visibleDrafts(mounted)).toEqual(["second draft", "first try"]);
    for (const box of recoveryBoxes(mounted)) {
      expect(box.readOnly).toBe(true);
      expect(box.disabled).toBe(false);
    }
  });

  it("a close flushes a stored draft the composer could not take", async () => {
    const fake = deferredTransport();
    const { mounted, textarea, send } = await mountDeferred(fake);

    textarea.value = "first try";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the first input request");

    // 입력칸이 새 초안으로 차 있어 첫 원문은 보관만 된다 (기존 계약).
    typeInto(textarea, "second draft");
    fake.rejectInput(new RemoteError(503, "input busy"));
    await until(
      () => !(mounted.root.querySelector(".notice") as HTMLElement).hidden,
      "the busy notice",
    );
    expect(textarea.value).toBe("second draft");

    // 종료 뒤에는 입력칸이 비기를 기다릴 수 없다 (input 이벤트가 없다) —
    // 보관된 원문도, 입력칸에 남아 있던 새 초안도 복구 영역에 나타나야 한다.
    fake.close();
    expect(textarea.value).toBe("");
    expect(visibleDrafts(mounted)).toEqual(["second draft", "first try"]);
    for (const box of recoveryBoxes(mounted)) {
      expect(box.readOnly).toBe(true);
      expect(box.disabled).toBe(false);
    }
  });

  it("a close moves the composer draft into a read-only recovery box before the rejection", async () => {
    const fake = deferredTransport();
    const { mounted, textarea, send } = await mountDeferred(fake);

    textarea.value = "first try";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the first input request");

    // 입력칸에 새 초안을 남긴 채 종료가 먼저 온다 — 그 초안도 그 자리에서
    // 복구 상자로 옮겨지고 입력칸은 빈다.
    typeInto(textarea, "second draft");
    fake.close();
    expect(textarea.value).toBe("");

    // 비행 중이던 첫 Send 의 거절이 늦게 도착해 더 오래된 원문을 그 뒤에 덧붙인다.
    fake.rejectInput(new TransportClosedError(CLOSED_TEXT));
    await flushMacrotasks();

    const boxes = recoveryBoxes(mounted);
    expect(boxes.map((box) => box.value)).toEqual(["second draft", "first try"]);
    for (const box of boxes) {
      expect(box.readOnly).toBe(true);
      expect(box.disabled).toBe(false);
    }
    expect(textarea.disabled).toBe(true);
  });

  it("a close after a transport-close rejection keeps both drafts without duplicating", async () => {
    const fake = deferredTransport();
    const { mounted, textarea, send } = await mountDeferred(fake);

    textarea.value = "first try";
    send.click();
    await until(() => fake.inputTexts.length === 1, "the first input request");

    typeInto(textarea, "second draft");
    // 거절이 먼저 온다 — reportInputError 가 스스로 종료 처리로 들어가 첫 원문을
    // 복구 상자에 남기고, 이어서 입력칸의 새 초안이 옮겨진다.
    fake.rejectInput(new TransportClosedError(CLOSED_TEXT));
    await flushMacrotasks();
    // 같은 종료 알림이 반복돼도 초안이 복제되면 안 된다.
    fake.close();
    fake.close();
    await flushMacrotasks();

    const boxes = recoveryBoxes(mounted);
    expect(boxes.map((box) => box.value)).toEqual(["first try", "second draft"]);
    for (const box of boxes) {
      expect(box.readOnly).toBe(true);
      expect(box.disabled).toBe(false);
    }
    expect(textarea.value).toBe("");
    expect(textarea.disabled).toBe(true);
  });
});
