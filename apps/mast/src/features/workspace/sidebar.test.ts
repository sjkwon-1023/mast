// @vitest-environment happy-dom
//
// 사이드바 DOM identity 검증 — 순수 판정(reconcilePlan) 테스트가 못
// 잡는 부분을 잠근다: 판정이 patch 여도 렌더가 실제로 노드를 갈아치우면 클릭이
// mousedown~click 사이에 유실된다 (ADR-0003 결정 7 의 스왈로). 그래서 "같은 노드
// 객체(===)에 텍스트만 갱신됐는가"를 실제 DOM 으로 단언한다.
//
// happy-dom 은 이 파일 전용 환경이다 (상단 @vitest-environment) — 나머지 프론트
// 테스트는 계속 DOM 없는 node 환경에서 돈다.

import { afterEach, describe, expect, it, vi } from "vitest";

import { shortcutBadge, shortcutLabel } from "../../shared/keys";
import { LATEST_RELEASE_URL, Sidebar } from "./sidebar";
import type {
  AgentStatus,
  Command,
  NotificationState,
  StateSnapshot,
  Tab,
  Workspace,
  WorkspaceId,
} from "../../shared/types";

function terminalTab(id: number, notification: NotificationState): Tab {
  return {
    id,
    title: `tab ${id}`,
    kind: { type: "terminal", ptySession: id * 100, status: { type: "running" }, cwd: null },
    notification,
    lastActivityMs: null,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
}

function ws(
  id: number,
  opts: {
    name?: string;
    rootPath?: string | null;
    agentStatus?: AgentStatus;
    lastAgentMessage?: string | null;
    notification?: NotificationState;
  } = {},
): Workspace {
  const tab = terminalTab(id * 10, opts.notification ?? "none");
  return {
    id,
    name: opts.name ?? `ws ${id}`,
    rootPath: opts.rootPath ?? null,
    distro: null,
    gitBranch: null,
    gitDirty: null,
    layout: { type: "leaf", pane: id },
    panes: { [String(id)]: { id, tabs: [tab], activeTab: tab.id } },
    activePane: id,
    agentStatus: opts.agentStatus ?? "idle",
    lastAgentMessage: opts.lastAgentMessage ?? null,
  };
}

function snapshot(
  revision: number,
  workspaces: Workspace[],
  activeWorkspace: WorkspaceId | null,
): StateSnapshot {
  return { revision, state: { workspaces, activeWorkspace, nextId: 100, revision } };
}

/** 없으면 던진다 — 테스트에서 null 분기를 없애기 위함. */
function child(card: Element, selector: string): HTMLElement {
  const found = card.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

function renameInput(card: Element): HTMLInputElement {
  const found = card.querySelector<HTMLInputElement>(".ws-card-rename");
  if (found === null) throw new Error("missing .ws-card-rename");
  return found;
}

/** 실제 리스너(keydown)와 같은 경로로 보낸다. */
function press(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function mount(): {
  sidebar: Sidebar;
  cards: () => HTMLElement[];
  dispatched: Command[];
  /** 폴더 선택 흐름은 main.ts 소유라 사이드바는 콜백만 부른다. */
  newWorkspaceCalls: () => number;
  /** "Connect mobile" 버튼 — 설정·원격 표면 상태와 무관하게 항상 보인다. */
  pairBtn: () => HTMLButtonElement;
  pairingCalls: () => number;
  version: () => HTMLSpanElement;
  updateBtn: () => HTMLButtonElement;
  openedUrls: string[];
  /** 사용자에게 보일 오류 — main.ts 글루가 상태줄에 띄운다. */
  errors: unknown[];
} {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const dispatched: Command[] = [];
  let newWorkspaceCalls = 0;
  let pairingCalls = 0;
  const openedUrls: string[] = [];
  const errors: unknown[] = [];
  const sidebar = new Sidebar(
    root,
    async (cmd) => {
      dispatched.push(cmd);
      return null;
    },
    () => {
      newWorkspaceCalls += 1;
    },
    () => {
      pairingCalls += 1;
    },
    (url) => {
      openedUrls.push(url);
    },
    (err) => {
      errors.push(err);
    },
  );
  const cardsEl = root.querySelector<HTMLElement>(".sidebar-cards");
  if (cardsEl === null) throw new Error("sidebar-cards not mounted");
  const pairEl = root.querySelector<HTMLButtonElement>(".sidebar-pair");
  if (pairEl === null) throw new Error("sidebar-pair not mounted");
  const versionEl = root.querySelector<HTMLSpanElement>(".sidebar-version");
  if (versionEl === null) throw new Error("sidebar-version not mounted");
  const updateEl = root.querySelector<HTMLButtonElement>(".sidebar-update");
  if (updateEl === null) throw new Error("sidebar-update not mounted");
  return {
    sidebar,
    cards: () => Array.from(cardsEl.querySelectorAll<HTMLElement>(".ws-card")),
    dispatched,
    newWorkspaceCalls: () => newWorkspaceCalls,
    pairBtn: () => pairEl,
    pairingCalls: () => pairingCalls,
    version: () => versionEl,
    updateBtn: () => updateEl,
    openedUrls,
    errors,
  };
}

const THREE = [ws(1), ws(2), ws(3)];

describe("Sidebar rendering", () => {
  it("patches dynamic fields in place, keeping the same card nodes", () => {
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    const before = cards();
    expect(before).toHaveLength(3);
    // 안 바뀌는 이름의 텍스트 노드 — setText 가드가 이 노드를 살려두는지 본다.
    const nameNode = child(before[1], ".ws-card-name").firstChild;
    expect(child(before[1], ".ws-card-dot").hidden).toBe(true);
    expect(child(before[1], ".ws-card-status").textContent).toBe("idle");

    sidebar.render(
      snapshot(
        2,
        [
          ws(1),
          ws(2, {
            agentStatus: "needsInput",
            lastAgentMessage: "continue?\n두 번째 줄",
            notification: "unread",
          }),
          ws(3),
        ],
        1,
      ),
    );

    const after = cards();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    // 상태 줄은 상태 텍스트 + 메시지 첫 줄 한 줄이다 (별도 메시지 줄 없음).
    expect(child(after[1], ".ws-card-status").textContent).toBe("needs input — continue?");
    expect(child(after[1], ".ws-card-status").title).toBe("needs input — continue?");
    expect(child(after[1], ".ws-card-status").classList.contains("needs-input")).toBe(true);
    expect(child(after[1], ".ws-card-dot").hidden).toBe(false);
    expect(child(after[1], ".ws-card-name").firstChild).toBe(nameNode);
  });

  it("toggles the path row in place, keeping it out of the layout while null", () => {
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    const before = cards();
    expect(child(before[0], ".ws-card-path").hidden).toBe(true);

    sidebar.render(snapshot(2, [ws(1, { rootPath: "/home/u/code/mast" }), ws(2), ws(3)], 1));

    const after = cards();
    expect(after[0]).toBe(before[0]);
    expect(child(after[0], ".ws-card-path").hidden).toBe(false);
    expect(child(after[0], ".ws-card-path").textContent).toBe("~/code/mast");
  });

  it("touches nothing when the card model is unchanged", () => {
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    const before = cards();
    const statusNode = child(before[0], ".ws-card-status").firstChild;

    // revision 만 다른 무관 스냅샷 — skip 판정이라 DOM 을 건드리지 않는다.
    sidebar.render(snapshot(2, THREE, 1));

    const after = cards();
    expect(after[0]).toBe(before[0]);
    expect(child(after[0], ".ws-card-status").firstChild).toBe(statusNode);
  });

  it("moves the active class without rebuilding the cards", () => {
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    const before = cards();
    expect(before.map((c) => c.classList.contains("active"))).toEqual([true, false, false]);

    sidebar.render(snapshot(2, THREE, 2));

    const after = cards();
    expect(after[1]).toBe(before[1]);
    expect(after.map((c) => c.classList.contains("active"))).toEqual([false, true, false]);
  });

  it("rebuilds when workspace membership changes", () => {
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    const before = cards();

    sidebar.render(snapshot(2, [ws(1), ws(2), ws(3), ws(4)], 1));

    const after = cards();
    expect(after).toHaveLength(4);
    expect(after[0]).not.toBe(before[0]);
  });

  it("rebuilds when the cards are reordered", () => {
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    const before = cards();

    sidebar.render(snapshot(2, [ws(2), ws(1), ws(3)], 1));

    const after = cards();
    expect(after.map((c) => child(c, ".ws-card-name").textContent)).toEqual([
      "ws 2",
      "ws 1",
      "ws 3",
    ]);
    expect(after[0]).not.toBe(before[0]);
  });

  // Alt 를 누른 동안 뜨는 배지 (shortcutBadge) — 문자 명령은 실제 판정이 Alt+Shift 라
  // 배지에도 Shift 표시가 붙어야 안내와 키 동작이 어긋나지 않는다. ordinal 은
  // `Alt+1`~`9` 그대로라 Shift 가 없다.
  it("badges character shortcuts with Shift and leaves ordinals as bare digits", () => {
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 1));

    const newBtn = document.querySelector<HTMLElement>(".sidebar-new");
    if (newBtn === null) throw new Error("missing .sidebar-new");
    expect(newBtn.dataset.altShortcut).toBe(shortcutBadge("newWorkspace"));

    const after = cards();
    expect(after.map((c) => c.dataset.altShortcut)).toEqual(["1", "2", "3"]);
    // × 배지는 활성 카드에만 — 닫기는 문자 명령이라 Shift 표시가 붙는다.
    expect(child(after[0], ".ws-card-close").dataset.altShortcut).toBe(
      shortcutBadge("closeWorkspace"),
    );
    expect(child(after[1], ".ws-card-close").dataset.altShortcut).toBeUndefined();
  });
});

describe("Sidebar inline rename (F2)", () => {
  it("commits with Enter, dispatching renameWorkspace for the active card", () => {
    const { sidebar, cards, dispatched } = mount();
    // ws 2 가 활성 — F2 는 활성 카드만 편집한다.
    sidebar.render(snapshot(1, THREE, 2));
    const card = cards()[1];
    const name = child(card, ".ws-card-name");
    const input = renameInput(card);
    expect(input.hidden).toBe(true);

    sidebar.beginRename();
    expect(input.hidden).toBe(false);
    expect(name.hidden).toBe(true);
    expect(input.value).toBe("ws 2");

    // 앞뒤 공백은 UI 가 다듬어 보낸다 (코어는 받은 값을 그대로 저장한다).
    input.value = "  renamed  ";
    press(input, "Enter");

    expect(dispatched).toEqual([{ type: "renameWorkspace", workspace: 2, name: "renamed" }]);
    expect(input.hidden).toBe(true);
    expect(name.hidden).toBe(false);
  });

  it("cancels with Escape and drops blank names without dispatching", () => {
    const { sidebar, cards, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 2));
    const card = cards()[1];
    const input = renameInput(card);

    sidebar.beginRename();
    input.value = "typed but abandoned";
    press(input, "Escape");
    expect(input.hidden).toBe(true);
    expect(child(card, ".ws-card-name").textContent).toBe("ws 2");
    expect(dispatched).toEqual([]);

    // 공백뿐인 이름은 코어가 거부하는 값 — 보내지 않고 편집을 유지한다.
    sidebar.beginRename();
    input.value = "   ";
    press(input, "Enter");
    expect(dispatched).toEqual([]);
    expect(input.hidden).toBe(false);

    // 이름이 그대로면 무변경 dispatch 도 보내지 않는다 (카드 클릭 규칙과 동일).
    input.value = "ws 2";
    press(input, "Enter");
    expect(dispatched).toEqual([]);
    expect(input.hidden).toBe(true);
  });

  it("double-clicking a card's name edits that card, even when it is not the active one", () => {
    const { sidebar, cards, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 2));
    const card = cards()[2];
    const input = renameInput(card);

    child(card, ".ws-card-name").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(input.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("ws 3");

    input.value = "third";
    press(input, "Enter");
    expect(dispatched).toEqual([{ type: "renameWorkspace", workspace: 3, name: "third" }]);
  });

  it("skips patching the card being edited and catches up when editing ends", () => {
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 2));
    const card = cards()[1];
    const input = renameInput(card);
    sidebar.beginRename();
    input.value = "half typed";

    // 편집 중 도착한 스냅샷 — 이 카드는 건드리지 않는다 (입력값·IME 보호).
    sidebar.render(snapshot(2, [ws(1), ws(2, { agentStatus: "running" }), ws(3)], 2));
    expect(input.value).toBe("half typed");
    expect(child(card, ".ws-card-status").textContent).toBe("idle");

    // 편집이 끝나면 밀린 갱신을 한 번에 만회한다 (다음 스냅샷을 기다리지 않는다).
    press(input, "Escape");
    expect(child(card, ".ws-card-status").textContent).toBe("running");
  });
});

describe("Sidebar interaction across patches", () => {
  it("delegates the new-workspace button to the picker callback", () => {
    const { sidebar, newWorkspaceCalls } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    const button = document.querySelector<HTMLElement>(".sidebar-new");
    if (button === null) throw new Error("missing .sidebar-new");

    button.click();

    // 대화상자 호출·CreateWorkspace dispatch 는 app/main.ts 소유다 (인라인 폼 없음).
    expect(newWorkspaceCalls()).toBe(1);
    expect(document.querySelector(".sidebar-form")).toBeNull();
  });

  it("keeps the switch wiring on patched cards", () => {
    const { sidebar, cards, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    sidebar.render(
      snapshot(2, [ws(1), ws(2, { agentStatus: "running", notification: "unread" }), ws(3)], 1),
    );

    cards()[1].click();

    expect(dispatched).toEqual([{ type: "switchWorkspace", workspace: 2 }]);
  });

  it("re-reads active from the patched model instead of a stale closure", () => {
    const { sidebar, cards, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    // ws 2 가 활성이 된 뒤의 클릭은 no-op 이어야 한다 (계획 D4).
    sidebar.render(snapshot(2, THREE, 2));

    cards()[1].click();
    expect(dispatched).toEqual([]);

    cards()[0].click();
    expect(dispatched).toEqual([{ type: "switchWorkspace", workspace: 1 }]);
  });
});

describe("Sidebar close (× 버튼 · Ctrl+Shift+Q)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 호출 인자까지 보기 위해 spy 를 돌려준다. */
  function stubConfirm(answer: boolean): ReturnType<typeof vi.fn> {
    const spy = vi.fn(() => answer);
    vi.stubGlobal("confirm", spy);
    return spy;
  }

  it("키 경로가 × 버튼과 같은 confirm·명령을 탄다 — 대상은 활성 워크스페이스", async () => {
    const confirmSpy = stubConfirm(true);
    const { sidebar, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 2));

    await sidebar.closeActive();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toBe(
      'Close workspace "ws 2"? All terminal sessions in it will be killed.',
    );
    expect(dispatched).toEqual([{ type: "closeWorkspace", workspace: 2 }]);
  });

  it("confirm 취소는 아무것도 보내지 않는다 — × 클릭과 키가 같은 판정", async () => {
    const confirmSpy = stubConfirm(false);
    const { sidebar, cards, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 2));

    await sidebar.closeActive();
    child(cards()[0], ".ws-card-close").click();
    await Promise.resolve();

    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual([]);
  });

  it("확인 대화상자가 실패하면 닫지 않고 사유를 사용자에게 보인다", async () => {
    const failure = new Error("cannot open the confirmation dialog");
    vi.stubGlobal(
      "confirm",
      vi.fn(() => {
        throw failure;
      }),
    );
    const { sidebar, dispatched, errors } = mount();
    sidebar.render(snapshot(1, THREE, 2));

    await sidebar.closeActive();

    expect(dispatched).toEqual([]);
    expect(errors).toEqual([failure]);
  });

  it("활성 워크스페이스가 없으면 조용한 no-op — confirm 도 뜨지 않는다", async () => {
    const confirmSpy = stubConfirm(true);
    const { sidebar, dispatched } = mount();
    // 워크스페이스 0개(빈 상태) — 그리고 스냅샷이 아직 없는 부트 직후도 같은 경로.
    sidebar.render(snapshot(1, [], null));

    await sidebar.closeActive();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
  });

  it("× 버튼 툴팁이 단축키를 표기한다 — keys.ts 단일 소스", () => {
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 1));

    expect(child(cards()[0], ".ws-card-close").title).toBe(
      `Close workspace (${shortcutLabel("closeWorkspace")})`,
    );
    expect(shortcutLabel("closeWorkspace")).toBe("Alt+Shift+Q");
  });
});


describe("Sidebar drag reordering", () => {
  // happy-dom 의 getBoundingClientRect 는 전부 0 을 준다 — 히트 테스트가 좌표를
  // 읽는 유일한 창구라 여기서 직접 심는다. 카드 높이 100, 중앙은 50/150/250.
  function layout(cards: HTMLElement[]): void {
    cards.forEach((card, i) => {
      const top = i * 100;
      card.getBoundingClientRect = () =>
        ({ top, height: 100, bottom: top + 100 }) as DOMRect;
    });
  }

  function pointer(el: HTMLElement, type: string, clientY: number): void {
    el.dispatchEvent(
      new window.PointerEvent(type, { bubbles: true, clientY, pointerId: 1, button: 0 }),
    );
  }

  /** 실제 리스너와 같은 이벤트 순서로 끌고 놓는다. */
  function drag(card: HTMLElement, fromY: number, toY: number): void {
    pointer(card, "pointerdown", fromY);
    pointer(card, "pointermove", toY);
    pointer(card, "pointerup", toY);
    // 브라우저는 pointerup 뒤 click 을 발화한다 — 삼켜지는지까지 봐야 계약이다.
    card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  }

  it("카드를 위로 끌면 그 자리 앞으로 옮기고, 전환은 보내지 않는다", () => {
    const { sidebar, cards, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    layout(cards());

    drag(cards()[2], 250, 10);

    // 활성 워크스페이스는 안 바뀐다 (사용자 결정) — switchWorkspace 가 없어야 한다.
    expect(dispatched).toEqual([{ type: "moveWorkspace", workspace: 3, before: 1 }]);
  });

  it("맨 아래로 끌면 before 가 null 이다", () => {
    const { sidebar, cards, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    layout(cards());

    drag(cards()[0], 10, 290);

    expect(dispatched).toEqual([{ type: "moveWorkspace", workspace: 1, before: null }]);
  });

  it("문턱을 못 넘은 움직임은 드래그가 아니라 클릭이다", () => {
    const { sidebar, cards, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    layout(cards());

    // 3px — 손 떨림 수준. 카드 클릭의 본래 동작(전환)이 그대로 나가야 한다.
    drag(cards()[2], 250, 253);

    expect(dispatched).toEqual([{ type: "switchWorkspace", workspace: 3 }]);
  });

  it("제자리에 놓으면 아무것도 보내지 않는다", () => {
    const { sidebar, cards, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    layout(cards());

    // 2번 카드를 집어 자기 바로 뒤(3번 앞)에 놓는다 = 제자리.
    drag(cards()[1], 150, 210);

    expect(dispatched).toEqual([]);
  });

  it("놓기 전에는 놓일 자리가 한 카드에만 표시된다", () => {
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    layout(cards());

    pointer(cards()[2], "pointerdown", 250);
    pointer(cards()[2], "pointermove", 120);

    const marked = cards().map((c) => [c.classList.contains("drop-before"), c.classList.contains("drop-after")]);
    expect(marked).toEqual([
      [false, false],
      [true, false],
      [false, false],
    ]);
    expect(cards()[2].classList.contains("dragging")).toBe(true);

    pointer(cards()[2], "pointerup", 120);
    expect(cards().some((c) => c.className.includes("drop-"))).toBe(false);
  });

  it("드래그 중 도착한 스냅샷은 카드를 갈아치우지 않는다", () => {
    // 끌고 있는 엘리먼트가 재조립으로 사라지면 포인터 캡처가 끊긴다 — 상태 변화는
    // OSC 마다 오므로 이 가드가 없으면 드래그가 수시로 끊긴다.
    const { sidebar, cards } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    layout(cards());
    const dragged = cards()[2];

    pointer(dragged, "pointerdown", 250);
    pointer(dragged, "pointermove", 10);
    // 워크스페이스 하나가 사라진 스냅샷 — 평소라면 rebuild 판정이다.
    sidebar.render(snapshot(2, [ws(1), ws(2)], 1));

    expect(cards()[2]).toBe(dragged);
    expect(cards()).toHaveLength(3);

    // 드래그가 끝나면 밀린 갱신을 만회한다.
    pointer(dragged, "pointerup", 10);
    expect(cards()).toHaveLength(2);
  });

  it("× 버튼 위에서 시작한 눌림은 드래그가 아니다", () => {
    // 눌림이 버블링으로 카드까지 올라오지만 그 컨트롤의 것이다 — 닫으려다 손이
    // 흔들렸다고 순서가 바뀌면 안 된다.
    const { sidebar, cards, dispatched } = mount();
    sidebar.render(snapshot(1, THREE, 1));
    layout(cards());

    const close = child(cards()[2], ".ws-card-close");
    pointer(close, "pointerdown", 250);
    pointer(close, "pointermove", 10);
    pointer(close, "pointerup", 10);

    expect(cards()[2].classList.contains("dragging")).toBe(false);
    expect(dispatched).toEqual([]);
  });
});

describe("Sidebar pairing button", () => {
  it("is always visible, regardless of the remote surface state", () => {
    const { pairBtn, pairingCalls } = mount();

    // Local HTTP 가 꺼져 있어도(설정 없음·부팅 실패) 버튼은 보인다 — 다이얼로그가
    // 설정 안내와 Secure Remote 를 제공하므로 감추면 기능이 없다는 신호가 된다.
    expect(pairBtn().hidden).toBe(false);
    expect(pairBtn().textContent).toBe("Connect mobile");

    pairBtn().click();
    expect(pairingCalls()).toBe(1);
  });
});

describe("Sidebar update notice", () => {
  it("shows the installed version from cached update info", () => {
    const { sidebar, version, updateBtn } = mount();

    sidebar.setUpdateInfo({ currentVersion: "0.3.31", newerVersion: null, checked: false });

    expect(version().hidden).toBe(false);
    expect(version().textContent).toBe("v0.3.31");
    expect(updateBtn().hidden).toBe(true);
  });

  it("shows a newer-version button and opens the fixed release page", () => {
    const { sidebar, version, updateBtn, openedUrls } = mount();

    sidebar.setUpdateInfo({ currentVersion: "0.3.31", newerVersion: "0.3.32", checked: true });

    expect(version().textContent).toBe("v0.3.31");
    expect(updateBtn().hidden).toBe(false);
    expect(updateBtn().textContent).toBe("Update available");
    expect(updateBtn().title).toContain("0.3.32");
    updateBtn().click();
    expect(openedUrls).toEqual([LATEST_RELEASE_URL]);
  });

  it("keeps the static footer while cards render", () => {
    const { sidebar, version, updateBtn } = mount();
    sidebar.setUpdateInfo({ currentVersion: "0.3.31", newerVersion: "0.3.32", checked: true });
    const footer = document.querySelector(".sidebar-footer");
    if (footer === null) throw new Error("missing sidebar footer");

    sidebar.render(snapshot(1, THREE, 1));
    sidebar.render(snapshot(2, [ws(1), ws(2)], 1));

    expect(document.querySelector(".sidebar-footer")).toBe(footer);
    expect(version().textContent).toBe("v0.3.31");
    expect(updateBtn().hidden).toBe(false);
  });
});
