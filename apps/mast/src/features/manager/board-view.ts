// 관리자 작업 보드 탭 뷰 (ADR-0032).
//
// 판정은 전부 board-model.ts 가 소유하고(ADR-0025) 여기는 그리기·dispatch 배선만
// 한다: 카드 계산·정렬은 buildCards, 헤더 문자열은 headerModel, 이동 대상은
// goToTarget. 이 파일이 스스로 판단하는 것은 "무엇을 어떤 버튼에 연결하는가"뿐이다.
//
// 데이터 수명
// - 마운트 때 getManagerBoard()로 초기 payload를 받고 manager-board 이벤트를
//   구독한다. 이벤트가 get 보다 먼저 오면 get 결과는 버린다(eventSeen) — 오래된
//   초기값이 새 이벤트를 되돌리지 않게.
// - 라이브 상태(정렬 그룹·배지)는 스냅샷이 필요하므로 workspace-view 가 생성자에
//   snapshot getter 를 넘기고, 뷰어 update() 마다 재렌더한다. IPC 재호출은 없다.
// - 접힘·펼침(quote)과 카드별 action 오류는 이 뷰의 로컬 상태라 재렌더에도 남는다.
//
// dispose 뒤 갱신은 전부 무시한다(이벤트 콜백·get 콜백·action 콜백의 disposed 가드).

import {
  getManagerBoard,
  managerAction,
  onManagerBoard,
} from "../../infrastructure/backend";
import type { ManagerBoardPayload } from "../../infrastructure/backend";
import { buildCards, goToTarget, headerModel, parseBoard } from "./board-model";
import type { BoardCard, GlueStatus, ParsedBoard } from "./board-model";
import type { ViewerKind, ViewerView } from "../viewers/viewer-view";
import type {
  AgentStatus,
  AppState,
  Command,
  CommandOutput,
  StateSnapshot,
  WorkspaceId,
} from "../../shared/types";

type DispatchFn = (cmd: Command) => Promise<CommandOutput | null>;

/** 생성자 의존 — dispatch 는 기존 뷰어 경로(workspace-view 의 것)를 그대로 쓰고,
 *  snapshot 은 라이브 상태(정렬·배지)와 이동 대상 해석의 재료다. now 는 신선도
 *  문자열("3m ago")의 기준 시각으로, 테스트가 고정값을 주입한다. */
export interface BoardViewDeps {
  dispatch: DispatchFn;
  snapshot: () => StateSnapshot | null;
  now?: () => number;
}

const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  running: "running",
  needsInput: "needs input",
  idle: "idle",
};

/** 마운트 직후 상태 — getManagerBoard 응답 전의 헤더 표시 (라벨 "Starting"). */
const INITIAL_STATUS: GlueStatus = {
  state: "starting",
  message: null,
  lastCollectedAt: null,
  logPath: null,
};

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export class BoardView implements ViewerView {
  readonly root: HTMLDivElement;
  private readonly stateEl: HTMLSpanElement;
  private readonly collectedEl: HTMLSpanElement;
  private readonly openLogEl: HTMLButtonElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly cardsEl: HTMLDivElement;

  private status: GlueStatus = INITIAL_STATUS;
  private board: ParsedBoard | null = null;
  /** 초기 get 실패 문구 — payload 가 도착하면(get 또는 이벤트) 더 이상 유효하지 않다. */
  private loadError: string | null = null;
  /** 구독 실패 문구 — 이벤트가 영영 오지 않는다는 뜻이라 payload 로 지우지 않는다. */
  private subscribeError: string | null = null;
  /** 카드별 managerAction 실패 문구 — 카드에 남고 다음 성공에 지운다. */
  private readonly cardErrors = new Map<WorkspaceId, string>();
  /** 펼친 quote 의 키 (`<workspaceId>:q:<id>` / `<workspaceId>:d:<id>`). */
  private readonly expanded = new Set<string>();
  private disposed = false;
  private eventSeen = false;
  private unsubscribe: (() => void) | null = null;
  /** 마지막 렌더의 입력 서명 — 무관한 revision 마다 DOM·스크롤을 흔들지 않는다. */
  private signature: string | null = null;

  constructor(parent: HTMLElement, private readonly deps: BoardViewDeps) {
    this.root = document.createElement("div");
    this.root.className = "board-view";
    this.root.tabIndex = -1;

    const header = document.createElement("div");
    header.className = "board-header";
    this.stateEl = document.createElement("span");
    this.stateEl.className = "board-state";
    this.collectedEl = document.createElement("span");
    this.collectedEl.className = "board-collected";
    this.openLogEl = document.createElement("button");
    this.openLogEl.type = "button";
    this.openLogEl.className = "board-open-log";
    this.openLogEl.textContent = "Open log";
    this.openLogEl.addEventListener("click", () => this.openLog());
    header.append(this.stateEl, this.collectedEl, this.openLogEl);

    this.noticeEl = document.createElement("div");
    this.noticeEl.className = "board-notice";
    this.noticeEl.hidden = true;

    this.cardsEl = document.createElement("div");
    this.cardsEl.className = "board-cards";

    this.root.append(header, this.noticeEl, this.cardsEl);
    parent.append(this.root);

    this.render();
    void this.load();
  }

  /** 초기 payload + 이벤트 구독. 구독을 먼저 걸고 get 을 부른다 — 그 사이에 온
   *  이벤트를 놓치지 않고, 이벤트가 먼저 왔으면 get 결과를 버린다. */
  private async load(): Promise<void> {
    try {
      const unsubscribe = await onManagerBoard((payload) => {
        if (this.disposed) return;
        this.eventSeen = true;
        this.applyPayload(payload);
      });
      // 구독이 도착하기 전에 dispose 됐으면 리스너를 즉시 해제한다 (누수 금지).
      if (this.disposed) {
        unsubscribe();
        return;
      }
      this.unsubscribe = unsubscribe;
    } catch (err) {
      if (!this.disposed) {
        this.subscribeError = `manager-board subscription failed: ${String(err)}`;
        this.render();
      }
    }
    try {
      const initial = await getManagerBoard();
      if (this.disposed || this.eventSeen) return;
      this.applyPayload(initial);
    } catch (err) {
      if (!this.disposed) {
        this.loadError = `cannot load the manager board: ${String(err)}`;
        this.render();
      }
    }
  }

  private applyPayload(payload: ManagerBoardPayload): void {
    this.status = payload.status;
    this.board = payload.board === null ? null : parseBoard(payload.board);
    this.loadError = null;
    this.render();
  }

  /** 스냅샷 재렌더 — pane-view 의 update 경로마다 불린다. 입력이 같으면 no-op. */
  update(kind: ViewerKind): void {
    if (kind.type !== "managerBoard") return;
    this.render();
  }

  /** 보드는 모델에 남길 스크롤 위치가 없다 (setViewerScroll 대상이 아니다). */
  flushScroll(): void {}

  focus(): void {
    this.root.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.root.remove();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private render(): void {
    if (this.disposed) return;
    const state = this.deps.snapshot()?.state ?? null;
    const signature = this.renderSignature(state);
    if (signature === this.signature) return;
    this.signature = signature;

    const now = this.now();
    const header = headerModel(this.status, now);
    setText(this.stateEl, header.label);
    this.stateEl.className = `board-state board-state-${header.state}`;
    setText(this.collectedEl, header.lastCollected);
    this.openLogEl.hidden = !header.canOpenLog;

    const notice = this.loadError ?? this.subscribeError ?? this.board?.error ?? null;
    this.noticeEl.hidden = notice === null;
    setText(this.noticeEl, notice ?? "");

    const cards = state === null ? [] : buildCards(state, this.board, this.status, now);
    this.cardsEl.replaceChildren(...cards.map((card) => this.card(card)));
  }

  /** 표시에 영향을 주는 입력만 모은다 — 스냅샷 전체(tabs 등)는 이동 버튼이
   *  클릭 시점에 직접 읽으므로 서명에 넣지 않는다. */
  private renderSignature(state: AppState | null): string {
    return JSON.stringify([
      this.status,
      this.board,
      this.loadError,
      this.subscribeError,
      [...this.cardErrors],
      [...this.expanded].sort(),
      state === null
        ? null
        : state.workspaces.map((ws) => [ws.id, ws.name, ws.agentStatus, ws.activePane]),
    ]);
  }

  // ── 카드 ─────────────────────────────────────────────────────────────

  private card(card: BoardCard): HTMLElement {
    const el = document.createElement("article");
    el.className = "board-card";
    el.dataset.workspaceId = String(card.workspaceId);

    const head = document.createElement("div");
    head.className = "board-card-head";
    head.append(this.textSpan("board-card-title", card.title));
    if (card.title !== card.workspaceName) {
      head.append(this.textSpan("board-card-ws", card.workspaceName));
    }
    head.append(
      this.badge(`board-badge board-live board-live-${card.liveStatus}`, AGENT_STATUS_LABELS[card.liveStatus]),
    );
    if (card.updatedAgo !== null) {
      head.append(this.textSpan("board-updated", card.updatedAgo));
    }
    el.append(head);

    const badges = this.cardBadges(card);
    if (badges !== null) el.append(badges);

    if (!card.hasEntry || card.state === "none") {
      // entry 자체가 없거나 reason 만 있는 상태 — "기록 없음"을 깨진 기록과
      // 구분한다 (board-model 의 hasEntry/error 규율).
      el.append(this.textDiv("board-empty", "No record yet"));
    } else if (card.state === "error") {
      el.append(this.textDiv("board-error", card.error ?? "invalid board entry"));
    } else {
      if (card.headline !== "") el.append(this.textDiv("board-headline", card.headline));
      this.appendProgress(el, card);
      this.appendQuestions(el, card);
      this.appendDecisions(el, card);
      this.appendNext(el, card);
      this.appendPlans(el, card);
    }

    el.append(this.actions(card));

    const error = this.cardErrors.get(card.workspaceId);
    if (error !== undefined) el.append(this.textDiv("board-card-error", error));
    return el;
  }

  private cardBadges(card: BoardCard): HTMLElement | null {
    const badges: HTMLElement[] = [];
    if (card.stale) badges.push(this.badge("board-badge board-stale", "stale"));
    for (const limit of card.limits) badges.push(this.badge("board-badge board-limit", limit));
    if (card.reason !== null) badges.push(this.badge("board-badge board-reason", card.reason));
    if (badges.length === 0) return null;
    const row = document.createElement("div");
    row.className = "board-badges";
    row.append(...badges);
    return row;
  }

  private appendProgress(el: HTMLElement, card: BoardCard): void {
    const { progress } = card;
    if (progress.text === "" && !progress.reportedDone && !progress.verifiedDone) return;
    const row = document.createElement("div");
    row.className = "board-progress";
    if (progress.text !== "") {
      row.append(this.textSpan("board-progress-text", progress.text));
    }
    row.append(
      this.badge(
        progress.reportedDone ? "board-badge board-reported done" : "board-badge board-reported",
        "reported",
      ),
      this.badge(
        progress.verifiedDone ? "board-badge board-verified done" : "board-badge board-verified",
        "verified",
      ),
    );
    el.append(row);
  }

  private appendQuestions(el: HTMLElement, card: BoardCard): void {
    if (card.openQuestions.length === 0) return;
    const section = this.section(el, "Open questions");
    for (const question of card.openQuestions) {
      const item = document.createElement("div");
      item.className = "board-item";
      item.append(this.textSpan("board-item-text", question.text));
      this.appendQuote(item, card.workspaceId, `q:${question.id}`, question.quote);
      section.append(item);
    }
  }

  private appendDecisions(el: HTMLElement, card: BoardCard): void {
    const { user, ai, supersededCount } = card.decisions;
    if (user.length === 0 && ai.length === 0 && supersededCount === 0) return;
    const section = this.section(el, "Decisions");
    if (supersededCount > 0) {
      section.append(this.badge("board-badge board-superseded", `${supersededCount} superseded`));
    }
    for (const [group, decisions] of [
      ["user", user],
      ["ai", ai],
    ] as const) {
      if (decisions.length === 0) continue;
      const block = document.createElement("div");
      block.className = "board-group";
      block.append(this.badge(`board-badge board-group-${group}`, group));
      for (const decision of decisions) {
        const item = document.createElement("div");
        item.className = "board-item";
        item.append(this.textSpan("board-item-text", decision.text));
        this.appendQuote(item, card.workspaceId, `d:${decision.id}`, decision.quote);
        block.append(item);
      }
      section.append(block);
    }
  }

  private appendNext(el: HTMLElement, card: BoardCard): void {
    if (card.next.length === 0) return;
    const section = this.section(el, "Next");
    for (const item of card.next) section.append(this.textDiv("board-next-item", item.text));
  }

  private appendPlans(el: HTMLElement, card: BoardCard): void {
    if (card.plans.length === 0) return;
    const section = this.section(el, "Plans");
    for (const plan of card.plans) {
      const row = document.createElement("div");
      row.className = "board-plan";
      row.append(this.textSpan("board-plan-goal", plan.goal));
      const done = plan.steps.filter((step) => step.done).length;
      row.append(this.badge("board-badge board-plan-steps", `${done}/${plan.steps.length}`));
      const open = document.createElement("button");
      open.type = "button";
      open.className = "board-open-plan";
      open.textContent = "Open plan";
      const linkPath = plan.linkPath;
      open.disabled = linkPath === null;
      if (linkPath !== null) open.addEventListener("click", () => this.openPlan(card, linkPath));
      row.append(open);
      section.append(row);
    }
  }

  private actions(card: BoardCard): HTMLElement {
    const actions = document.createElement("div");
    actions.className = "board-card-actions";

    const goto = document.createElement("button");
    goto.type = "button";
    goto.className = "board-goto";
    goto.textContent = "Go to";
    goto.addEventListener("click", () => this.goTo(card));
    actions.append(goto);

    if (card.state === "choice") {
      const choice = document.createElement("div");
      choice.className = "board-choice";
      choice.append(this.textSpan("board-choice-text", "Previous record found —"));
      // key 는 카드 모델이 아니라 파싱된 entry 가 갖는다 (board-model 은 표시
      // 판정만 소유 — 카드 모델의 몫을 침범하지 않는다).
      const key = this.entryKey(card.workspaceId);
      for (const [action, label] of [
        ["resume", "Resume"],
        ["fresh", "Start fresh"],
      ] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `board-${action}`;
        button.textContent = label;
        button.disabled = key === null;
        if (key !== null) button.addEventListener("click", () => this.choose(card, action, key));
        choice.append(button);
      }
      actions.append(choice);
    }
    return actions;
  }

  private entryKey(workspaceId: WorkspaceId): string | null {
    for (const entry of this.board?.entries ?? []) {
      if (entry.kind === "entry" && entry.workspaceId === workspaceId) return entry.key;
    }
    return null;
  }

  // ── 버튼 동작 ────────────────────────────────────────────────────────

  private goTo(card: BoardCard): void {
    const snapshot = this.deps.snapshot();
    if (snapshot === null) return;
    const target = goToTarget(card, snapshot.state);
    void (async () => {
      const out = await this.deps.dispatch({
        type: "switchWorkspace",
        workspace: target.workspace,
      });
      // 전환 뒤에 탭 활성화 — activateTab 은 워크스페이스와 무관하게 탭 id 로
      // 주소를 잡지만, 화면이 먼저 그 워크스페이스로 가야 보상 focus 가 맞는다.
      if (out === null || target.tab === null) return;
      await this.deps.dispatch({ type: "activateTab", tab: target.tab });
    })();
  }

  private openPlan(card: BoardCard, linkPath: string): void {
    const snapshot = this.deps.snapshot();
    const ws = snapshot?.state.workspaces.find((candidate) => candidate.id === card.workspaceId);
    if (ws === undefined) return;
    void (async () => {
      const out = await this.deps.dispatch({
        type: "createTab",
        pane: ws.activePane,
        tab: { type: "markdownViewer", path: linkPath },
      });
      // 탭 생성이 실패하면 전환하지 않는다 — 갈 곳에 볼 것이 없다.
      if (out === null) return;
      await this.deps.dispatch({ type: "switchWorkspace", workspace: card.workspaceId });
    })();
  }

  private openLog(): void {
    const logPath = headerModel(this.status, this.now()).logPath;
    if (logPath === null) return;
    const state = this.deps.snapshot()?.state ?? null;
    if (state === null || state.activeWorkspace === null) return;
    const ws = state.workspaces.find((candidate) => candidate.id === state.activeWorkspace);
    if (ws === undefined) return;
    // 보드 탭은 관리자 워크스페이스의 활성 pane 에 있으므로 그 pane 에 연다.
    void this.deps.dispatch({
      type: "createTab",
      pane: ws.activePane,
      tab: { type: "textViewer", path: logPath },
    });
  }

  private choose(card: BoardCard, action: "resume" | "fresh", key: string): void {
    void managerAction(action, key).then(
      () => {
        if (this.disposed) return;
        this.cardErrors.delete(card.workspaceId);
        this.render();
      },
      (err: unknown) => {
        if (this.disposed) return;
        // 실패는 카드에 남긴다 — 상태 라인은 다른 명령과 공유라 카드 문맥이 사라진다.
        this.cardErrors.set(card.workspaceId, String(err));
        this.render();
      },
    );
  }

  // ── DOM 헬퍼 ────────────────────────────────────────────────────────

  private appendQuote(
    parent: HTMLElement,
    workspaceId: WorkspaceId,
    id: string,
    quote: string | null,
  ): void {
    if (quote === null) return;
    const key = `${workspaceId}:${id}`;
    const open = this.expanded.has(key);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "board-toggle";
    toggle.textContent = open ? "hide quote" : "quote";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.addEventListener("click", () => {
      if (this.expanded.has(key)) this.expanded.delete(key);
      else this.expanded.add(key);
      this.render();
    });
    parent.append(toggle);
    if (open) {
      const block = document.createElement("blockquote");
      block.className = "board-quote";
      block.textContent = quote;
      parent.append(block);
    }
  }

  /** 섹션 껍데기 — 제목을 붙여 부모에 append 하고, 내용을 넣을 노드를 돌려준다. */
  private section(parent: HTMLElement, title: string): HTMLElement {
    const section = document.createElement("div");
    section.className = "board-section";
    section.append(this.textDiv("board-section-title", title));
    parent.append(section);
    return section;
  }

  private textDiv(className: string, text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    return el;
  }

  private textSpan(className: string, text: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    return el;
  }

  private badge(className: string, text: string): HTMLSpanElement {
    return this.textSpan(className, text);
  }
}
