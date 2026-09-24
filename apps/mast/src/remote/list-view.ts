// **모델 문자열은 전부 `textContent` 로만 들어간다.** 이 페이지의 토큰이
// localStorage 에 있으므로 여기서의 XSS 는 곧 토큰 유출이고, 탭 제목·에이전트
// 마지막 메시지는 터미널이 뱉은 임의 문자열이다. 그래서 `src/remote/` 어디에도
// HTML 문자열로 DOM 을 만드는 자리가 없고, 그 부재 자체가 검증 항목이다
// (ADR-0016 의 한계 절).

import type {
  AgentStatus,
  Pane,
  SplitTree,
  StateSnapshot,
  TabId,
  TabKind,
  Workspace,
} from "../shared/types";

const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  running: "running",
  needsInput: "needs input",
  idle: "idle",
};

export interface ListViewOptions {
  /** 뷰어 탭은 화면 API 가 없어 열 수 없다. */
  onOpenTab: (tab: TabId, title: string) => void;
}

export class ListView {
  readonly root: HTMLElement;
  private readonly listEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  /** 직전 렌더의 서명 — 같으면 DOM 을 건드리지 않는다. 2초마다 통째로
   *  갈아치우면 스크롤 위치와 눌림 상태가 매번 날아간다. */
  private signature: string | null = null;

  constructor(private readonly options: ListViewOptions) {
    this.root = document.createElement("div");
    this.root.className = "screen list-screen";

    const header = document.createElement("header");
    header.className = "bar";
    const title = document.createElement("span");
    title.className = "bar-title";
    title.textContent = "mast";
    header.append(title);

    this.noticeEl = document.createElement("div");
    this.noticeEl.className = "notice";
    this.noticeEl.hidden = true;

    this.listEl = document.createElement("div");
    this.listEl.className = "list";

    this.root.append(header, this.noticeEl, this.listEl);
  }

  setNotice(text: string | null): void {
    this.noticeEl.textContent = text ?? "";
    this.noticeEl.hidden = text === null;
  }

  render(snapshot: StateSnapshot): void {
    const next = signatureOf(snapshot);
    if (next === this.signature) return;
    this.signature = next;
    this.listEl.replaceChildren(
      ...snapshot.state.workspaces.map((ws) => this.workspaceEl(ws)),
    );
    if (snapshot.state.workspaces.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No workspaces";
      this.listEl.append(empty);
    }
  }

  private workspaceEl(ws: Workspace): HTMLElement {
    const card = document.createElement("section");
    card.className = "ws";

    const head = document.createElement("div");
    head.className = "ws-head";
    const name = document.createElement("span");
    name.className = "ws-name";
    name.textContent = ws.name;
    const badge = document.createElement("span");
    badge.className = `badge badge-${ws.agentStatus}`;
    badge.textContent = AGENT_STATUS_LABELS[ws.agentStatus];
    head.append(name, badge);
    card.append(head);

    if (ws.lastAgentMessage !== null) {
      const message = document.createElement("div");
      message.className = "ws-message";
      message.textContent = ws.lastAgentMessage;
      card.append(message);
    }

    for (const pane of panesInLayoutOrder(ws)) {
      card.append(this.paneEl(pane));
    }
    return card;
  }

  private paneEl(pane: Pane): HTMLElement {
    const block = document.createElement("div");
    block.className = "pane";
    for (const tab of pane.tabs) {
      const label = tabDetail(tab.kind);
      if (tab.kind.type !== "terminal") {
        const row = document.createElement("div");
        row.className = "tab tab-static";
        row.append(tabTitleEl(tab.title), tabDetailEl(label));
        block.append(row);
        continue;
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tab";
      // 점은 워크스페이스 파생 상태가 아니라 **탭 자신의 agentStatus** 로 판정한다 —
      // 한 워크스페이스에서 둘이 동시에 기다리면 두 행 모두 점을 갖고, 하나만
      // 풀려도 그 행에서만 사라진다. OSC 는 PTY 세션에서만 오므로 상태를 가진
      // 탭은 항상 터미널 탭이다 (뷰어 행에는 붙일 자리가 없다).
      if (tab.agentStatus === "needsInput") row.append(needsInputEl());
      row.append(tabTitleEl(tab.title), tabDetailEl(label));
      row.addEventListener("click", () => this.options.onOpenTab(tab.id, tab.title));
      block.append(row);
    }
    if (pane.tabs.length === 0) {
      const row = document.createElement("div");
      row.className = "tab tab-static";
      row.append(tabTitleEl("(empty pane)"), tabDetailEl(""));
      block.append(row);
    }
    return block;
  }
}

/** 응답 대기 점 — 데스크톱 탭 배지와 같은 클래스 이름·색 계열이라 두 표면이 같은
 *  뜻으로 읽힌다 (데스크톱은 같은 자리에 "!" 배지, 폰은 폭이 좁아 점). */
function needsInputEl(): HTMLElement {
  const el = document.createElement("span");
  el.className = "tab-needs-input";
  el.textContent = "●";
  el.title = "Needs input";
  return el;
}

function tabTitleEl(text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "tab-title";
  el.textContent = text;
  return el;
}

function tabDetailEl(text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "tab-detail";
  el.textContent = text;
  return el;
}

function tabDetail(kind: TabKind): string {
  switch (kind.type) {
    case "terminal":
      switch (kind.status.type) {
        case "running":
          return "running";
        case "notStarted":
          return "not started";
        default:
          return kind.status.code === null ? "exited" : `exited (${kind.status.code})`;
      }
    case "browser":
      return "browser · desktop only";
    case "folderBrowser":
      return "folder";
    case "textViewer":
      return "text";
    case "changesViewer":
      return "changes";
    default:
      return "markdown";
  }
}

/** `panes` 는 id 키 맵이라 순서가 없고, 순서를 아는 것은 레이아웃 트리뿐이다. */
function panesInLayoutOrder(ws: Workspace): Pane[] {
  const out: Pane[] = [];
  const walk = (node: SplitTree): void => {
    if (node.type === "leaf") {
      const pane = ws.panes[String(node.pane)];
      if (pane !== undefined) out.push(pane);
      return;
    }
    walk(node.first);
    walk(node.second);
  };
  walk(ws.layout);
  return out;
}

/** 화면에 나오는 것만 담는다. 탭별 agentStatus 를 포함하는 이유는 점이 그 값으로
 *  붙기 때문이다 — 빠지면 한 탭이 풀려도 서명이 그대로라 **옛 탭에 점이 남는다**
 *  (render 는 서명이 같으면 DOM 을 건드리지 않는다). */
function signatureOf(snapshot: StateSnapshot): string {
  return JSON.stringify(
    snapshot.state.workspaces.map((ws) => [
      ws.id,
      ws.name,
      ws.agentStatus,
      ws.lastAgentMessage,
      panesInLayoutOrder(ws).map((pane) =>
        pane.tabs.map((tab) => [tab.id, tab.title, tabDetail(tab.kind), tab.agentStatus]),
      ),
    ]),
  );
}
