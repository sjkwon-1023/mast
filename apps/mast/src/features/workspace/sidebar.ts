// 워크스페이스 사이드바 — 카드 리스트 + 하단 버튼
// ("+ New workspace", 그리고 원격 표면이 떠 있을 때만 보이는 "Pair phone").
//
// 렌더 전략 (카드 id 키잉 reconcile): reconcilePlan 의 판정대로
// skip(무변경, DOM 무접촉) / patch(카드 노드 유지 + 텍스트·클래스만 갱신) /
// rebuild(멤버십·순서 변화 → 재조립) 셋으로 갈린다.
//
// 왜 전체 재조립이면 안 되나: 클릭 진행 중(mousedown~click 사이) 렌더가 눌린 카드
// 엘리먼트를 갈아치우면 브라우저가 click 을 발화하지 않아 클릭이 유실된다
// (ADR-0003 결정 7 의 탭바 스왈로와 같은 결함). 13단계의 "모델 직렬화 키가 같으면
// 스킵" 가드는 agentStatus 가 idle 고정·message 가 null 이던 시절에만 성립했고,
// 18단계에서 status·message·집계 unread 가 OSC 마다 변하는 동적 필드가 되면서
// 무관 알림 하나로도 뚫린다 — 그래서 스킵 가드는 skip 판정으로만 남기고, 값이
// 변한 경우의 기본 경로를 in-place 패치로 바꾼다.
//
// 상호작용:
// - 카드 클릭 = SwitchWorkspace (이미 활성이면 no-op 스킵 — 무변경 revision 잡음 방지).
// - × = CloseWorkspace. 실행 중인 터미널 세션이 1개라도 있으면 confirm() 을
//   거친다 — 그 세션들을 죽이는 파괴적 동작이다. 판정은 렌더 캐시가 아니라 클릭
//   시점의 최신 스냅샷으로 한다 (카드 DOM 이 스킵으로 오래됐을 수 있다).
//   같은 흐름이 Ctrl+Shift+Q 로도 들어온다 (closeActive — app/main.ts 글루가 부른다):
//   confirm 조건·문구가 두 벌로 갈라지지 않게 키 경로도 이 onClose 를 그대로 탄다.
// - "+ New workspace" = 현재 터미널 경로로 즉시 생성 (onNewWorkspace 콜백 — 해석·dispatch
//   호출과 CreateWorkspace dispatch 는 app/main.ts 글루가 한다. 같은 흐름이
//   Ctrl+Shift+N 으로도 들어오므로 구현을 한곳에 둔다). 이름·경로·배포판을 손으로
//   치던 인라인 폼은 없앴다 — 경로는 대화상자가, 이름은 폴더명이 정한다.
// - "Pair phone" = 페어링 다이얼로그 (onPairing 콜백 — app/main.ts 글루 소유).
//   원격 표면이 실제로 떠 있을 때만 보인다 (setRemoteEnabled).
// - F2 = 활성 카드 이름 인라인 편집 (beginRename — app/main.ts 글루가 부른다).
//   Enter 확정 = RenameWorkspace dispatch, Esc·blur = 취소.
//
// **편집 상태 가드**: 편집 중인 카드는 patch 판정에서 건너뛴다 — 패치가 이름
// 텍스트를 덮어써도 입력값과 어긋나고, 무엇보다 입력 중 DOM 을 흔들면 IME
// 조합·커서 위치가 깨진다. 그동안 밀린 갱신은 편집 종료 시 한 번에 만회한다
// (stopEditing). 멤버십·순서가 바뀌는 rebuild 는 카드 노드 자체가 사라지므로
// 편집을 취소한다.
//
// 편집 입력은 표준 DOM <input> 이다 — 키 가로채기를 하지 않는다. 입력에 포커스가
// 있는 동안 키 입력은 xterm 포커스 밖이라 터미널로 새지 않는다. 전역 캡처
// (shared/keys.ts 가로채기 목록 + app/main.ts 의 Ctrl+Shift+R 리로드)는 편집 중에도 그대로
// 동작하지만 F2 를 뺀 나머지가 전부 modifier 조합이라 이름 타이핑과 충돌하지
// 않는다 (편집 중 F2 는 편집을 다시 시작할 뿐이다).

import { shortcutLabel } from "../../shared/keys";
import {
  dropBefore,
  hasRunningTerminals,
  reconcilePlan,
  sameCard,
  sidebarModel,
} from "./sidebar-model";
import type { CardBox, WorkspaceCardModel } from "./sidebar-model";
import type { UpdateInfo } from "../../infrastructure/backend";
import type { Command, CommandOutput, StateSnapshot, WorkspaceId } from "../../shared/types";

/** UI 발 dispatch — main.ts dispatchUI 래퍼 (실패는 null, reject 없음). */
type DispatchFn = (cmd: Command) => Promise<CommandOutput | null>;

/** 포인터가 이만큼 세로로 움직여야 드래그로 친다. 카드 클릭이 워크스페이스
 *  전환이라, 손이 조금 흔들린 클릭이 순서를 바꿔 버리면 안 된다 (splitter 의
 *  드래그 판정과 같은 규율). */
const DRAG_THRESHOLD_PX = 4;

/** 업데이트 버튼은 네이티브가 내려준 URL을 사용하지 않고 이 릴리스 페이지로만 간다. */
export const LATEST_RELEASE_URL = "https://github.com/sjkwon-1023/mast/releases/latest";

function displayVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/** 진행 중인 드래그. `moving` 이 false 인 동안은 아직 문턱을 못 넘은 눌림이라
 *  클릭으로 끝날 수 있고, 그때는 DOM 도 커맨드도 건드리지 않는다. */
interface DragState {
  workspace: WorkspaceId;
  pointerId: number;
  startY: number;
  moving: boolean;
  /** 지금 포인터 위치가 가리키는 놓을 자리 (`moveWorkspace` 의 before 계약). */
  before: WorkspaceId | null;
}

/** 카드 1개의 DOM 노드 묶음 — in-place 패치 대상. model 은 이 카드가 지금 그리고
 *  있는 모델로, 클릭 핸들러가 stale 클로저 대신 여기서 최신 값을 읽는다.
 *  3줄 구성: head(이름 | 이름 편집 입력 + unread dot + ×) / status(상태 텍스트 +
 *  메시지) / path. */
interface CardNodes {
  root: HTMLElement;
  name: HTMLSpanElement;
  /** 이름 인라인 편집 입력 — 평시 hidden, F2 편집 중에만 name 과 자리를 바꾼다. */
  rename: HTMLInputElement;
  dot: HTMLSpanElement;
  status: HTMLDivElement;
  path: HTMLDivElement;
  model: WorkspaceCardModel;
}

/** textContent 재대입은 값이 같아도 자식 텍스트 노드를 갈아치우므로, 무변경
 *  렌더가 DOM 을 흔들지 않게 값이 같으면 쓰지 않는다. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** 메시지에 별도 줄을 주지 않는 이유는 카드를 3줄로 유지하기 위해서다 — 긴
 *  메시지는 어차피 한 줄로 잘린다 (말줄임은 CSS). */
function statusText(model: WorkspaceCardModel): string {
  if (model.message === null) return model.statusLabel;
  return `${model.statusLabel} — ${model.message}`;
}

export class Sidebar {
  private readonly cardsEl: HTMLDivElement;
  private readonly pairBtn: HTMLButtonElement;
  private readonly versionEl: HTMLSpanElement;
  private readonly updateBtn: HTMLButtonElement;
  private lastSnapshot: StateSnapshot | null = null;
  /** 직전 렌더의 카드 모델 (첫 렌더 전 null) — reconcilePlan 의 좌변 (파일 상단). */
  private lastCards: WorkspaceCardModel[] | null = null;
  /** 현재 화면에 붙어 있는 카드 노드 — workspace id 키잉, patch 판정의 대상. */
  private readonly cardNodes = new Map<WorkspaceId, CardNodes>();
  private editing: WorkspaceId | null = null;
  /** 진행 중인 드래그 재배치 (없으면 null). 이게 켜져 있는 동안 render 는 DOM 을
   *  건드리지 않는다 — 끌고 있는 카드가 재조립으로 사라지면 드래그가 끊긴다. */
  private drag: DragState | null = null;
  /** 방금 드래그로 끝난 상호작용인가 — 뒤따르는 click 하나를 삼킨다 (아래
   *  onCardPointerDown 주석). */
  private dragged = false;

  constructor(
    rootEl: HTMLElement,
    private readonly dispatch: DispatchFn,
    /** "+ New workspace" 버튼 — 폴더 선택 대화상자 흐름 (main.ts 글루 소유,
     *  Ctrl+Shift+N 과 같은 구현을 탄다). */
    private readonly onNewWorkspace: () => void,
    /** "Pair phone" 버튼 — 페어링 다이얼로그를 여는 것은 main.ts 글루다.
     *  버튼은 **원격 표면이 실제로 떠 있을 때만** 보인다 (setRemoteEnabled). */
    private readonly onPairing: () => void,
    /** 업데이트 릴리스 페이지를 여는 main.ts 글루. */
    private readonly onOpenUpdate: (url: string) => void,
  ) {
    this.cardsEl = document.createElement("div");
    this.cardsEl.className = "sidebar-cards";

    const footer = document.createElement("div");
    footer.className = "sidebar-footer";

    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "sidebar-new";
    newBtn.textContent = "+ New workspace";
    // 단축키 표기는 shared/keys.ts 의 shortcutLabel 단일 소스에서 받는다 (표류 방지).
    newBtn.title = `New workspace from the current directory (${shortcutLabel("newWorkspace")})`;
    newBtn.addEventListener("click", () => this.onNewWorkspace());

    this.pairBtn = document.createElement("button");
    this.pairBtn.type = "button";
    this.pairBtn.className = "sidebar-pair";
    this.pairBtn.textContent = "Pair phone";
    this.pairBtn.title = "Show a QR code that opens this mast on a phone on the same network";
    this.pairBtn.hidden = true;
    this.pairBtn.addEventListener("click", () => this.onPairing());

    this.versionEl = document.createElement("span");
    this.versionEl.className = "sidebar-version";
    this.versionEl.hidden = true;

    this.updateBtn = document.createElement("button");
    this.updateBtn.type = "button";
    this.updateBtn.className = "sidebar-update";
    this.updateBtn.textContent = "Update available";
    this.updateBtn.hidden = true;
    this.updateBtn.addEventListener("click", () => this.onOpenUpdate(LATEST_RELEASE_URL));

    footer.append(newBtn, this.pairBtn, this.versionEl, this.updateBtn);
    rootEl.append(this.cardsEl, footer);
  }

  /** 캐시 조회·update-checked 이벤트의 결과를 정적 푸터에 반영한다. */
  setUpdateInfo(info: UpdateInfo): void {
    this.versionEl.textContent = displayVersion(info.currentVersion);
    this.versionEl.title = `Installed version ${this.versionEl.textContent}`;
    this.versionEl.hidden = false;

    if (info.newerVersion === null) {
      this.updateBtn.hidden = true;
      this.updateBtn.title = "";
      return;
    }
    this.updateBtn.hidden = false;
    this.updateBtn.title = `Update available: ${displayVersion(info.newerVersion)}`;
  }

  /** 원격 표면이 떠 있나 — main.ts 가 부팅 시 remote_status 로 판정해 넘긴다.
   *  꺼져 있거나 실패했으면 버튼을 아예 감춘다: 누를 수 없는 버튼을 남겨 두면
   *  그 자체가 기능이 있다는 잘못된 신호다. */
  setRemoteEnabled(on: boolean): void {
    this.pairBtn.hidden = !on;
  }

  /** 스냅샷 반영 진입점 — store 구독에서 revision 순으로 호출된다. */
  render(snapshot: StateSnapshot): void {
    this.lastSnapshot = snapshot;
    // 드래그 중에는 DOM 을 건드리지 않는다. 상태 변화는 OSC 마다 오므로 끄는 도중
    // 재조립이 끼어들기 쉬운데, 그러면 끌고 있던 엘리먼트가 갈아치워져 포인터
    // 캡처가 끊긴다 — 편집 중 카드를 건너뛰는 것과 같은 규율이고, 밀린 갱신도
    // 같은 방식으로 종료 시(endDrag) 한 번에 만회한다.
    if (this.drag !== null) return;
    const model = sidebarModel(snapshot.state.workspaces, snapshot.state.activeWorkspace);
    const prev = this.lastCards;
    const plan = reconcilePlan(prev, model);
    if (plan === "skip") return;
    if (plan === "rebuild") {
      // 카드 노드가 통째로 갈리므로 편집 중이던 입력도 사라진다 — 상태만 정리해
      // 편집 가드가 사라진 노드를 가리키지 않게 한다 (파일 상단 편집 상태 가드).
      this.editing = null;
      this.cardNodes.clear();
      const nodes = model.map((m) => this.card(m));
      for (const n of nodes) this.cardNodes.set(n.model.workspace, n);
      this.cardsEl.replaceChildren(...nodes.map((n) => n.root));
    } else {
      // 멤버십·순서가 같음이 판정으로 보장된다 — 변한 카드만 in-place 갱신.
      model.forEach((next, i) => {
        const before = prev?.[i];
        if (before !== undefined && sameCard(before, next)) return;
        // 편집 중인 카드는 건드리지 않는다 — 밀린 갱신은 stopEditing 이 만회한다.
        if (this.editing === next.workspace) return;
        const nodes = this.cardNodes.get(next.workspace);
        if (nodes !== undefined) this.applyCard(nodes, next);
      });
    }
    this.lastCards = model;
  }

  /** 활성 워크스페이스 카드의 이름을 인라인 편집으로 바꾼다 (F2 — main.ts 글루가
   *  부른다). 활성 워크스페이스가 없거나(빈 상태) 그 카드가 아직 없으면 조용한
   *  no-op 이다. 이미 편집 중이면 값을 다시 채워 재시작한다. */
  beginRename(): void {
    const workspace = this.lastSnapshot?.state.activeWorkspace ?? null;
    if (workspace === null) return;
    const nodes = this.cardNodes.get(workspace);
    if (nodes === undefined) return;
    this.stopEditing(); // 다른 카드를 편집 중이었을 수 있다 (편집 중 워크스페이스 전환)
    this.editing = workspace;
    nodes.rename.value = nodes.model.name;
    nodes.name.hidden = true;
    nodes.rename.hidden = false;
    nodes.rename.focus();
    nodes.rename.select();
  }

  /** 편집 확정 (Enter) — 다듬은 이름을 RenameWorkspace 로 보낸다. 빈/공백뿐인
   *  값은 코어가 거부하는 값이라 IPC 왕복 대신 편집을 유지하고, 무변경 이름은
   *  보내지 않는다 (카드 클릭의 "이미 활성이면 no-op" 과 같은 규칙). */
  private commitRename(nodes: CardNodes): void {
    const name = nodes.rename.value.trim();
    if (name.length === 0) {
      nodes.rename.focus();
      return;
    }
    const { workspace, name: current } = nodes.model;
    this.stopEditing();
    if (name === current) return;
    void this.dispatch({ type: "renameWorkspace", workspace, name });
  }

  /** 편집 중이 아니면 no-op 이라 확정·취소·blur 가 어떤 순서로 겹쳐도 안전하다. */
  private stopEditing(): void {
    const workspace = this.editing;
    if (workspace === null) return;
    // 먼저 상태를 내린다 — 아래 hidden 대입이 blur 를 유발해 여기로 재진입할 수
    // 있고, 그때 두 번째 호출은 no-op 이어야 한다.
    this.editing = null;
    const nodes = this.cardNodes.get(workspace);
    if (nodes === undefined) return;
    nodes.rename.hidden = true;
    nodes.name.hidden = false;
    // 편집 중 스킵된 패치를 여기서 만회한다 — 그 스냅샷의 sameCard 판정은 이미
    // 지나갔으므로 다음 렌더가 저절로 고쳐 주지 않는다.
    const latest = this.lastCards?.find((c) => c.workspace === workspace);
    if (latest !== undefined) this.applyCard(nodes, latest);
  }

  private renameInput(): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ws-card-rename";
    input.hidden = true;
    // WebView 자동완성·자동교정이 이름 입력을 방해하지 않게 끈다.
    input.autocomplete = "off";
    input.spellcheck = false;
    return input;
  }

  /** 카드 DOM 조립 — 값에 따라 있다 없다 하는 행(경로·집계 dot)도 노드는
   *  항상 만들고 hidden 으로만 토글한다. 노드 존재 자체가 변하면 그 카드의
   *  자식이 갈아치워져 in-place 패치의 의미가 없어지기 때문이다. */
  private card(model: WorkspaceCardModel): CardNodes {
    const el = document.createElement("div");
    el.className = "ws-card";

    const head = document.createElement("div");
    head.className = "ws-card-head";

    const name = document.createElement("span");
    name.className = "ws-card-name";

    const rename = this.renameInput();
    rename.addEventListener("keydown", (ev) => {
      // 편집 중의 키는 이 입력 소유다 — 위로 새어 카드 클릭·전역 판정에 닿지
      // 않게 막는다 (전역 캡처 리스너는 이보다 먼저 도는 별개 경로다).
      if (ev.key === "Enter") {
        ev.stopPropagation();
        this.commitRename(nodes);
      } else if (ev.key === "Escape") {
        ev.stopPropagation();
        this.stopEditing();
      }
    });
    // 포커스를 잃으면 취소한다 — 확정은 Enter 뿐이다. 취소로 두는 이유: 다른 곳을
    // 클릭한 사용자가 이름 변경을 의도했다고 볼 수 없고, 편집 상태가 남으면 그
    // 카드의 패치가 영영 스킵된다.
    rename.addEventListener("blur", () => this.stopEditing());

    // 집계 unread dot — 워크스페이스 안 어느 탭이든 미확인 알림이 있으면 표시.
    const dot = document.createElement("span");
    dot.className = "ws-card-dot";
    dot.textContent = "●";
    dot.title = "Unread notification";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ws-card-close";
    close.textContent = "×";
    // 단축키 표기는 "+ New workspace" 버튼과 같은 관례 — shared/keys.ts 단일 소스.
    close.title = `Close workspace (${shortcutLabel("closeWorkspace")})`;
    close.addEventListener("click", (ev) => {
      ev.stopPropagation(); // 카드 클릭(전환)과 분리
      this.onClose(model.workspace);
    });

    head.append(name, rename, dot, close);

    // 상태는 항상 있으므로 이 줄은 감추지 않는다 (경로 줄과 달리 hidden 토글이
    // 없다).
    const status = document.createElement("div");
    status.className = "ws-card-status";

    const path = document.createElement("div");
    path.className = "ws-card-path";

    el.append(head, status, path);

    const nodes: CardNodes = { root: el, name, rename, dot, status, path, model };
    this.applyCard(nodes, model);

    el.addEventListener("pointerdown", (ev) => this.onCardPointerDown(ev, nodes));
    el.addEventListener("pointermove", (ev) => this.onCardPointerMove(ev));
    el.addEventListener("pointerup", () => this.endDrag(true));
    el.addEventListener("pointercancel", () => this.endDrag(false));

    el.addEventListener("click", () => {
      // 드래그로 끝난 상호작용의 click 은 삼킨다 — 순서를 바꾸려고 끌었을 뿐인데
      // 워크스페이스까지 전환되면 안 된다.
      if (this.dragged) {
        this.dragged = false;
        return;
      }
      // 편집 중 카드 안의 클릭은 입력 조작이다 — 전환을 보내지 않는다.
      if (this.editing === nodes.model.workspace) return;
      // in-place 패치로 카드가 살아남는 동안 모델은 바뀌므로 클로저가 아니라
      // nodes.model 에서 최신 값을 읽는다.
      if (!nodes.model.active) {
        void this.dispatch({ type: "switchWorkspace", workspace: nodes.model.workspace });
      }
    });
    return nodes;
  }

  /** 카드 눌림 — 아직 드래그가 아니다. 문턱(DRAG_THRESHOLD_PX)을 넘어야 시작한다.
   *
   *  ×·이름 입력 위의 눌림은 그 컨트롤의 것이라 제외한다. 편집 중인 카드도
   *  제외한다 — 텍스트 선택 드래그가 카드 재배치가 되면 안 된다. */
  private onCardPointerDown(ev: PointerEvent, nodes: CardNodes): void {
    // 이전 드래그가 남긴 클릭 삼킴은 여기서 만료된다. 드래그가 카드 밖에서 끝나면
    // click 이 아예 안 오므로, 플래그를 클릭에서만 지우면 다음 클릭이 억울하게
    // 삼켜진다.
    this.dragged = false;
    if (ev.button !== 0) return;
    if (this.editing === nodes.model.workspace) return;
    const target = ev.target;
    if (target instanceof HTMLElement && target.closest("button, input") !== null) return;

    this.drag = {
      workspace: nodes.model.workspace,
      pointerId: ev.pointerId,
      startY: ev.clientY,
      moving: false,
      before: null,
    };
  }

  private onCardPointerMove(ev: PointerEvent): void {
    const drag = this.drag;
    if (drag === null || ev.pointerId !== drag.pointerId) return;
    if (!drag.moving) {
      if (Math.abs(ev.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.moving = true;
      // 캡처는 문턱을 넘은 뒤에만 잡는다 — 먼저 잡으면 평범한 클릭까지 이 카드가
      // 붙들어 다른 요소의 hover·click 이 어긋난다.
      if (ev.target instanceof Element) ev.target.setPointerCapture(ev.pointerId);
      this.cardNodes.get(drag.workspace)?.root.classList.add("dragging");
    }
    drag.before = dropBefore(this.dropBoxes(), ev.clientY);
    this.showDropIndicator(drag);
  }

  /** 드래그 종료. `commit` 이 참이고 자리가 실제로 바뀌면 커맨드를 보낸다.
   *
   *  드래그 중 밀어 둔 렌더는 여기서 만회한다 — 그 사이 스냅샷들의 sameCard 판정은
   *  이미 지나갔으므로 다음 렌더가 저절로 고쳐 주지 않는다 (stopEditing 과 동형). */
  private endDrag(commit: boolean): void {
    const drag = this.drag;
    if (drag === null) return;
    this.drag = null;
    if (!drag.moving) return;

    this.dragged = true;
    this.clearDropIndicator();
    this.cardNodes.get(drag.workspace)?.root.classList.remove("dragging");

    if (commit && this.movesAnything(drag)) {
      void this.dispatch({
        type: "moveWorkspace",
        workspace: drag.workspace,
        before: drag.before,
      });
    }
    if (this.lastSnapshot !== null) this.render(this.lastSnapshot);
  }

  /** 이 드래그가 순서를 실제로 바꾸는가 — 제자리에 놓았으면 커맨드를 보내지
   *  않는다. 코어가 no-op 으로 받아 주긴 하지만 revision 은 올라가고, 그러면
   *  카드를 집었다 놓기만 해도 저장이 예약된다 (카드 클릭의 "이미 활성이면
   *  no-op 스킵" 과 같은 규칙). */
  private movesAnything(drag: DragState): boolean {
    if (drag.before === drag.workspace) return false;
    const cards = this.lastCards ?? [];
    const from = cards.findIndex((c) => c.workspace === drag.workspace);
    if (from < 0) return false;
    const to =
      drag.before === null
        ? cards.length
        : cards.findIndex((c) => c.workspace === drag.before);
    // 자기 바로 뒤 카드 앞 = 제자리.
    return !(to === from || to === from + 1);
  }

  /** 화면에 보이는 순서 그대로의 카드 세로 위치 — dropBefore 의 입력.
   *
   *  매 이동마다 다시 잰다. 드래그 중에는 렌더가 멈춰 있어 목록 자체는 안 변하지만
   *  사이드바는 스크롤되므로, 한 번 재서 캐시하면 스크롤 뒤에 엉뚱한 자리를
   *  가리킨다. 카드는 한 자릿수라 매번 재도 싸다. */
  private dropBoxes(): CardBox[] {
    const boxes: CardBox[] = [];
    for (const card of this.lastCards ?? []) {
      const nodes = this.cardNodes.get(card.workspace);
      if (nodes === undefined) continue;
      const rect = nodes.root.getBoundingClientRect();
      boxes.push({ workspace: card.workspace, top: rect.top, height: rect.height });
    }
    return boxes;
  }

  /** 놓을 자리 표시 — 카드 **하나**만 표시를 갖는다. 맨 뒤로 가는 경우에는 마지막
   *  카드의 아래쪽에 붙인다 (컨테이너에 따로 표시를 두면 카드가 없을 때의 빈
   *  컨테이너까지 신경 써야 한다). */
  private showDropIndicator(drag: DragState): void {
    this.clearDropIndicator();
    if (drag.before === null) {
      const last = this.lastCards?.at(-1);
      if (last === undefined) return;
      this.cardNodes.get(last.workspace)?.root.classList.add("drop-after");
      return;
    }
    this.cardNodes.get(drag.before)?.root.classList.add("drop-before");
  }

  private clearDropIndicator(): void {
    for (const nodes of this.cardNodes.values()) {
      nodes.root.classList.remove("drop-before", "drop-after");
    }
  }

  /** 카드 모델을 기존 노드에 반영 — 조립 직후와 in-place 패치가 같은 경로를 탄다. */
  private applyCard(nodes: CardNodes, model: WorkspaceCardModel): void {
    nodes.model = model;
    nodes.root.classList.toggle("active", model.active);

    setText(nodes.name, model.name);
    nodes.name.title = model.name; // 잘린 이름의 툴팁

    nodes.dot.hidden = !model.unread;

    const status = statusText(model);
    setText(nodes.status, status);
    nodes.status.title = status;
    // 3상태 중 needsInput 만 강조한다 — 사용자의 개입을 기다리는 유일한 상태다.
    nodes.status.classList.toggle("needs-input", model.status === "needsInput");

    setText(nodes.path, model.path ?? "");
    nodes.path.title = model.path ?? "";
    nodes.path.hidden = model.path === null;
  }

  /** `Ctrl+Shift+Q` — 활성 워크스페이스 닫기 (main.ts 글루가 부른다). × 버튼과
   *  완전히 같은 경로를 타므로 confirm 조건·문구가 갈라지지 않는다. 활성
   *  워크스페이스가 없으면(빈 상태·스냅샷 미도착) 조용한 no-op 이다. */
  closeActive(): void {
    const workspace = this.lastSnapshot?.state.activeWorkspace ?? null;
    if (workspace === null) return;
    this.onClose(workspace);
  }

  private onClose(workspace: WorkspaceId): void {
    const ws =
      this.lastSnapshot?.state.workspaces.find((w) => w.id === workspace) ?? null;
    if (ws === null) return; // 이미 닫힌 카드의 늦은 클릭 — 보낼 것이 없다
    if (hasRunningTerminals(ws)) {
      const ok = confirm(
        `Close workspace "${ws.name}"? All terminal sessions in it will be killed.`,
      );
      if (!ok) return;
    }
    void this.dispatch({ type: "closeWorkspace", workspace });
  }
}
