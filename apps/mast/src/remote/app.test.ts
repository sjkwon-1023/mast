// @vitest-environment happy-dom
//
// 공유 셸(RemoteApp) 잠금 — transport 주입만으로 목록 → 탭 → 입력이 도는지 본다.
// Secure Remote 는 이 셸에 `WebTransportClient` 를, Local HTTP 는 `httpTransport` 를
// 넣는다. 여기서는 가짜 transport 로 두 경로가 공유하는 배선만 검증한다.

import { afterEach, describe, expect, it } from "vitest";

import { createMemoryFontPxStore } from "../secure-remote/font-px";
import { RemoteApp } from "./app";
import type { RemoteTransport, ScreenReply } from "./transport";
import type { StateSnapshot } from "../shared/types";

const PROMPT = "kwon1@pc:~$ ls\r\napps\r\nkwon1@pc:~$ ";

const SCREEN_REPLY: ScreenReply = {
  meta: { sizeOwner: "desktop", endOffset: 40, reset: true, cols: 120, rows: 30, session: "1:2" },
  bytes: new TextEncoder().encode(PROMPT),
};

const SNAPSHOT: StateSnapshot = {
  revision: 1,
  state: {
    workspaces: [
      {
        id: 1,
        name: "mast",
        rootPath: "/tmp/mast",
        distro: null,
        gitBranch: null,
        gitDirty: null,
        layout: { type: "leaf", pane: 1 },
        panes: {
          "1": {
            id: 1,
            activeTab: 7,
            tabs: [
              {
                id: 7,
                title: "shell",
                kind: {
                  type: "terminal",
                  ptySession: 1,
                  status: { type: "running" },
                  cwd: null,
                },
                notification: "none",
                agentStatus: "idle",
                lastAgentMessage: null,
                lastActivityMs: null,
              },
            ],
          },
        },
        activePane: 1,
        agentStatus: "idle",
        lastAgentMessage: null,
      },
    ],
    activeWorkspace: 1,
    nextId: 8,
    revision: 1,
  },
};

async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const CLOSED_MESSAGE = "Connection closed — scan the pairing QR in mast again.";

/** 종료를 테스트가 직접 발화하고, fetchState 를 정지시켜 두는 가짜. */
function controllableTransport(): {
  transport: RemoteTransport;
  close: (message?: string) => void;
  settleState: (snapshot: StateSnapshot) => void;
  stateCalls: () => number;
  screenCalls: () => number;
} {
  let resolveState: ((snapshot: StateSnapshot) => void) | null = null;
  // 실제 transport 는 RemoteApp 과 TabView 가 **동시에** 구독한다 — 슬롯 하나짜리
  // 가짜는 뒤에 구독한 쪽이 앞쪽을 밀어내 실제 계약과 달라진다.
  const closedHandlers = new Set<(message: string) => void>();
  let stateCalls = 0;
  let screenCalls = 0;
  const transport: RemoteTransport = {
    fetchState: () =>
      new Promise<StateSnapshot>((resolve) => {
        stateCalls += 1;
        resolveState = resolve;
      }),
    fetchScreen: async () => {
      screenCalls += 1;
      return SCREEN_REPLY;
    },
    postInput: async () => undefined,
    onClosed: (handler) => {
      closedHandlers.add(handler);
      return () => {
        closedHandlers.delete(handler);
      };
    },
  };
  return {
    transport,
    close: (message = CLOSED_MESSAGE) => {
      for (const handler of [...closedHandlers]) handler(message);
    },
    settleState: (snapshot) => resolveState?.(snapshot),
    stateCalls: () => stateCalls,
    screenCalls: () => screenCalls,
  };
}

function fakeTransport(): { transport: RemoteTransport; posts: string[]; close: () => void } {
  const posts: string[] = [];
  const closedHandlers = new Set<(message: string) => void>();
  const transport: RemoteTransport = {
    fetchState: async () => SNAPSHOT,
    fetchScreen: async () => SCREEN_REPLY,
    postInput: async (_tab, _session, data) => {
      posts.push(data);
    },
    onClosed: (handler) => {
      closedHandlers.add(handler);
      return () => {
        closedHandlers.delete(handler);
      };
    },
  };
  return {
    transport,
    posts,
    close: () => {
      for (const handler of [...closedHandlers]) {
        handler("Connection closed — scan the pairing QR in mast again.");
      }
    },
  };
}

describe("RemoteApp over an injected transport", () => {
  let root: HTMLElement | null = null;

  afterEach(() => {
    root?.remove();
    root = null;
  });

  it("renders the list, opens a tab and sends input through the transport", async () => {
    const { transport, posts } = fakeTransport();
    root = document.createElement("div");
    document.body.append(root);
    new RemoteApp({ root, transport }).start();

    await until(() => root?.querySelector(".tab-title")?.textContent === "shell", "the list");
    (root.querySelector("button.tab") as HTMLButtonElement).click();

    const textarea = await (async () => {
      await until(
        () => root?.querySelector("textarea") !== null && !root?.querySelector("textarea")?.disabled,
        "the tab screen",
      );
      return root.querySelector("textarea") as HTMLTextAreaElement;
    })();
    expect(root.querySelector("pre.screen-pre")?.textContent).toContain("apps");

    textarea.value = "hello";
    (root.querySelector("button.composer-send") as HTMLButtonElement).click();
    await until(() => posts.length === 2, "text and CR");
    expect(posts[1]).toBe("\r");
  });

  it("keeps the connection destination visible on both the list and a tab", async () => {
    const { transport } = fakeTransport();
    root = document.createElement("div");
    document.body.append(root);
    new RemoteApp({ root, transport, destination: "192.168.0.20:7331" }).start();

    await until(() => root?.querySelector(".tab-title") !== null, "the list");
    const onList = root.querySelector(".destination") as HTMLElement;
    expect(onList.textContent).toBe("192.168.0.20:7331");

    (root.querySelector("button.tab") as HTMLButtonElement).click();
    await until(() => root?.querySelector("textarea") !== null, "the tab screen");
    // 화면을 바꿔도 대상 표시는 사라지지 않는다.
    expect((root.querySelector(".destination") as HTMLElement).textContent).toBe(
      "192.168.0.20:7331",
    );
  });

  it("shows no destination bar when the entry does not set one", async () => {
    const { transport } = fakeTransport();
    root = document.createElement("div");
    document.body.append(root);
    new RemoteApp({ root, transport }).start();

    await until(() => root?.querySelector(".tab-title") !== null, "the list");
    expect(root.querySelector(".destination")).toBeNull();
  });

  it("stops the list poll and shows the notice when the transport closes", async () => {
    const { transport, close } = fakeTransport();
    root = document.createElement("div");
    document.body.append(root);
    new RemoteApp({ root, transport }).start();
    await until(() => root?.querySelector(".tab-title") !== null, "the list");

    close();
    const notice = root.querySelector(".notice") as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("scan the pairing QR");
  });

  it("a close while a tab is open reaches the tab and the list behind it", async () => {
    // 실제 transport 는 RemoteApp(목록)과 TabView(탭)가 동시에 onClosed 를 구독한다.
    // 가짜가 슬롯을 하나만 두면 뒤에 구독한 TabView 가 앞의 핸들러를 밀어내, Back 으로
    // 나온 목록이 종료를 모른 채 빈 화면처럼 남는다.
    const { transport, close } = fakeTransport();
    root = document.createElement("div");
    document.body.append(root);
    new RemoteApp({ root, transport }).start();
    await until(() => root?.querySelector(".tab-title") !== null, "the list");

    (root.querySelector("button.tab") as HTMLButtonElement).click();
    await until(
      () => root?.querySelector("textarea")?.disabled === false,
      "the tab screen",
    );
    const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

    close();

    // 탭 화면은 즉시 안내를 띄우고 입력을 내린다.
    const tabNotice = root.querySelector(".notice") as HTMLElement;
    expect(tabNotice.hidden).toBe(false);
    expect(tabNotice.textContent).toContain("scan the pairing QR");
    expect(textarea.disabled).toBe(true);

    // Back — 목록에도 같은 종료가 남아 있어야 한다.
    (root.querySelector("button.bar-btn") as HTMLButtonElement).click();
    await until(() => root?.querySelector("button.tab") !== null, "the list again");
    const listNotice = root.querySelector(".notice") as HTMLElement;
    expect(listNotice.hidden).toBe(false);
    expect(listNotice.textContent).toContain("scan the pairing QR");
  });

  it("a state reply that had already settled cannot clear the notice after close", async () => {
    // 응답은 종료 직전에 해결됐지만 그 continuation 이 종료 뒤에 도는 순서다 —
    // 예전 코드는 여기서 setNotice(null) 로 재스캔 안내를 지웠다.
    const { transport, close, settleState, stateCalls } = controllableTransport();
    root = document.createElement("div");
    document.body.append(root);
    new RemoteApp({ root, transport }).start();
    await until(() => stateCalls() === 1, "the first state request");

    settleState(SNAPSHOT);
    close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const notice = root.querySelector(".notice") as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("scan the pairing QR");
    // 정지된 스케줄은 응답이 정착해도 다음 폴을 예약하지 않는다.
    expect(stateCalls()).toBe(1);
  });

  it("keeps the font size across tab switches through the injected store", async () => {
    // Secure Remote 는 이 store 를 메모리 구현으로 넣는다 — 탭마다 TabView 가
    // 새로 만들어지므로, store 가 없으면 A± 가 탭 전환마다 초기화된다.
    const fontPx = createMemoryFontPxStore();
    const { transport } = fakeTransport();
    root = document.createElement("div");
    const appRoot = root;
    document.body.append(appRoot);
    new RemoteApp({ root: appRoot, transport, fontPx }).start();
    await until(() => appRoot.querySelector(".tab-title") !== null, "the list");

    const openTab = async (): Promise<HTMLPreElement> => {
      (appRoot.querySelector("button.tab") as HTMLButtonElement).click();
      await until(() => appRoot.querySelector("pre.screen-pre") !== null, "the tab screen");
      return appRoot.querySelector("pre.screen-pre") as HTMLPreElement;
    };

    const first = await openTab();
    const initialSize = first.style.fontSize;
    const zoomIn = Array.from(appRoot.querySelectorAll("button")).find(
      (button) => button.textContent === "A+",
    ) as HTMLButtonElement;
    zoomIn.click();
    expect(first.style.fontSize).not.toBe(initialSize);
    const zoomedSize = first.style.fontSize;
    expect(fontPx.load()).not.toBeNull();

    (appRoot.querySelector("button.bar-btn") as HTMLButtonElement).click(); // ‹ Back
    await until(() => appRoot.querySelector("button.tab") !== null, "the list again");
    const second = await openTab();
    expect(second.style.fontSize).toBe(zoomedSize);
  });

  it("start and opening a tab after close create neither polling nor input", async () => {
    // 1) 종료가 start 보다 먼저 알려진 경우 — 폴 자체가 나가지 않는다.
    const first = controllableTransport();
    const app = new RemoteApp({ root: document.createElement("div"), transport: first.transport });
    first.close();
    app.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.stateCalls()).toBe(0);

    // 2) 목록이 이미 떠 있는 상태에서 종료된 뒤의 탭 열기 — 화면 폴도 입력도 없다.
    const live = controllableTransport();
    root = document.createElement("div");
    document.body.append(root);
    new RemoteApp({ root, transport: live.transport }).start();
    await until(() => live.stateCalls() === 1, "the first state request");
    live.settleState(SNAPSHOT);
    await until(() => root?.querySelector(".tab-title") !== null, "the list");

    live.close();
    (root.querySelector("button.tab") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(live.screenCalls()).toBe(0);
    expect(root.querySelector("textarea")).toBeNull();
    const notice = root.querySelector(".notice") as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("scan the pairing QR");
  });
});
