// pane 1개의 뷰 — 헤더(탭바 + 탭 생성·분할 아이콘) + keep-alive 콘텐츠 영역
// (12단계 청크 C).
//
// 콘텐츠는 keep-alive 다 (계획 D3): 탭별 TerminalView 는 앱 수준 레지스트리
// (workspace-view 소유 Map<TabId, TerminalView>)가 소유하고, 여기서는 ViewRegistry
// 를 통해 얻어 setVisible(display 토글)로 전환만 한다 — 탭 전환에 dispose/재생성·
// replay 왕복이 없다. 어떤 탭이 보일지는 view-reconcile(planViewSync)의 visible
// 판정을 workspace-view 가 pane 별로 내려준다 (판정 로직 단일화). 뷰 생성(lazy
// attach)은 첫 가시화 때 ensure 로 일어난다.
//
// fit 은 pane 당 ResizeObserver 1개(콘텐츠 영역 관찰 — 계획 D7)가 표시 중인 뷰의
// scheduleFit 만 부른다. 뷰당 observer 는 없다 (terminal-view 참조).
//
// 클릭 포커스(계획 1-B): 컨테이너 mousedown 을 capture 단계에서 받아 비활성
// pane 이면 FocusPane 을 dispatch 한다. preventDefault 는 하지 않는다 — xterm 의
// 포커스·선택 처리를 강탈하면 안 되기 때문이다. DOM 포커스는 그대로 흘러가고
// 모델의 active_pane 만 따라온다.
//
// send-mode(17단계): 같은 mousedown capture 가 전달 대상 선택 모드 활성 중에는
// FocusPane 대신 대상 확정(resolve) 경로로 분기한다 — 이때만 예외적으로
// preventDefault + stopPropagation 한다 (제스처가 순수한 대상 지정이므로 xterm
// 포커스·선택 개입을 막는다). 소스 캡처는 armSend 가 담당한다.
//
// **send-mode 는 현재 휴면이다**: 소스 캡처를 걸던 헤더의 ⤷/⤷⏎ 버튼 2개를 뺐고
// 다른 arm 진입점을 아직 두지 않아, isActive() 가 언제나 false 라 위 분기도
// armSend 도 실제로는 타지 않는다. 상태 머신(send-mode.ts)·전달 실행
// (workspace-view.resolveSend)·터미널 표면(terminal-view)까지 경로 전체를 그대로
// 남겨 둔 것은 의도다 — 차기 agent-facing 채널이 이 경로에 재배선될 예정이라
// 지우고 다시 짜지 않는다. 그때 붙일 것은 arm 진입점 하나뿐이다.
//
// 헤더 아이콘은 인라인 SVG 다 (폴더·분할 2종) — 유니코드 기호(▤/◫/⊟)는 폰트마다
// 모양이 갈리고 "무엇을 하는 버튼인지"가 자명하지 않아 그림으로 바꿨다. 마크업은
// 아래 상수 3개가 전량이고, 전부 이 파일에 박힌 신뢰 소스다 (파일·모델·네트워크
// 발 문자열이 innerHTML 로 들어오는 경로는 없다 — SVG_* 주석 참조).
//
// 탭바 렌더(18단계 B-7): tabStripPlan 판정대로 skip(DOM 무접촉) / patch(탭 버튼
// 노드를 유지한 채 제목·dot·클래스만 갱신) / rebuild(멤버십·순서 변화 → 재조립)
// 셋으로 갈린다 — renderTabStrip 주석 참조. 헤더에는 pane 층 집계 배지(●)가
// 붙는다 (계획 v2 9장: 탭 → pane → 워크스페이스 3층).
//
// 뷰어 탭(21단계): 콘텐츠 영역에는 터미널 뷰(keep-alive)와 뷰어 뷰(활성 탭만
// 마운트)가 공존한다. 어느 쪽이 이번 렌더의 표시 대상인지는 workspace-view 가
// planViewSync(visible)·planViewerSync(mount) 판정으로 내려주고, 여기서는 그
// 둘 중 하나를 shown 으로 삼는다 — **shownTab = 표시 중인 탭**(터미널이든 뷰어든)
// 이고, placeholder 는 둘 다 없을 때만 뜬다 (동시 표시 금지).

import { respawnTab } from "./backend";
import { paneTerminalCwd, shortcutLabel } from "./keys";
import type { ShortcutId } from "./keys";
import { paneUnread, sameTabButton, tabStripModel, tabStripPlan } from "./tab-strip-model";
import type { TabButtonModel } from "./tab-strip-model";
import type { TerminalView } from "./terminal-view";
import type { ViewerView } from "./viewer-view";
import type { VisibleView, VisibleViewer } from "./view-reconcile";
import type {
  Command,
  CommandOutput,
  Pane,
  PaneId,
  SessionId,
  Tab,
  TabId,
  TabKind,
} from "./types";

/** UI 발 dispatch — main.ts dispatchUI 래퍼. 실패는 상태 라인에 표면화되고
 *  null 로 돌아온다 (reject 하지 않는다). */
type DispatchFn = (cmd: Command) => Promise<CommandOutput | null>;

/** keep-alive 뷰 레지스트리 접근 계약 — 소유자는 workspace-view 다.
 *  ensure 는 없으면 생성 + attach 시작(lazy)하고, attach 실패 시 뷰를 정리한 뒤
 *  onAttachError 로 알린다 (호출한 pane 이 placeholder 에 에러를 노출한다). */
export interface ViewRegistry {
  get(tab: TabId): TerminalView | undefined;
  ensure(
    tab: TabId,
    session: SessionId,
    parent: HTMLElement,
    onAttachError: (message: string) => void,
  ): TerminalView;
}

/** 뷰어 뷰 레지스트리 접근 계약 (21단계) — 소유자는 workspace-view 다.
 *  터미널과 별도 레지스트리인 이유는 수명 시맨틱이 반대이기 때문이다
 *  (viewer-view.ts 참조). ensure 는 없으면 생성해 parent 에 마운트한다. 뷰어
 *  3종이 모두 착지한 지금 null 은 나오지 않지만, 반환 타입에는 남겨 pane 이
 *  placeholder 경로로 되돌아가는 안전망을 유지한다. */
export interface ViewerRegistry {
  get(tab: TabId): ViewerView | undefined;
  ensure(target: VisibleViewer, parent: HTMLElement): ViewerView | null;
}

/** send-mode 접근 계약 (17단계) — 소유자는 workspace-view 다. pane-view 는
 *  소스 캡처(arm)·대상 확정(resolve)·활성 판정(isActive)·캡처 실패 표면화
 *  (flashError)만 부른다. 상태 머신 자체는 send-mode.ts (순수).
 *
 *  arm 진입점이 UI 에서 빠져 계약 전체가 휴면이다 (파일 상단 주석) — 구현은
 *  살아 있고 부르는 쪽만 없다. */
export interface SendController {
  /** 대상 선택 모드 활성 여부 — mousedown 분기 판정. */
  isActive(): boolean;
  /** 소스 캡처 성공 후 모드 진입 — 프롬프트·Esc 배선은 소유자가 처리한다. */
  arm(source: PaneId, text: string, submit: boolean): void;
  /** 대상 확정 (자기 자신 = 취소 판정 포함) — 전달 실행도 소유자 몫이다. */
  resolve(target: PaneId): void;
  /** 캡처 실패(무선택·터미널 없음) one-shot 에러 — 조용한 no-op 금지. */
  flashError(message: string): void;
}

/** 탭 버튼 1개의 DOM 노드 묶음 — in-place 패치 대상. model 은 이 버튼이 지금
 *  그리고 있는 모델로, 클릭 핸들러가 stale 클로저 대신 여기서 최신 값을 읽는다
 *  (패치로 active 가 바뀌므로 클로저에 굳으면 활성 탭이 ActivateTab 을 재발행한다). */
interface TabNodes {
  root: HTMLElement;
  title: HTMLSpanElement;
  dot: HTMLSpanElement;
  exited: HTMLSpanElement;
  notStarted: HTMLSpanElement;
  model: TabButtonModel;
}

/** 버튼 툴팁 — "<기능> (<단축키>)". 단축키 문자열은 keys.ts 의 shortcutLabel
 *  단일 소스에서만 받는다 (키를 바꾸면 툴팁이 따라오도록 — 표류 방지). 헤더
 *  버튼은 현재 전부 단축키를 가지므로 예외 없이 이 헬퍼를 쓴다. */
function withShortcut(label: string, id: ShortcutId): string {
  return `${label} (${shortcutLabel(id)})`;
}

// ── 헤더 아이콘 SVG (신뢰 소스 상수) ─────────────────────────────────────
// 이 3개 문자열은 이 모듈에 하드코딩된 리터럴이다 — **파일·모델·백엔드에서 온
// 데이터가 아니다**. innerHTML 대입 지점(svgButton)이 받는 값은 오직 여기뿐이라
// 주입 표면이 없다. 셋 다 같은 규약을 공유한다: viewBox 16×16, stroke 1.5,
// currentColor(호버·비활성 색을 CSS 가 그대로 지배), fill 없음.
// 분할 2종은 "사각형을 세로선/가로선으로 이등분" 한 쌍이라 어느 쪽이 좌우/상하
// 인지 그림만으로 갈린다 (기존 ◫/⊟ 는 폰트에 따라 구분이 안 됐다).
const SVG_ATTRS =
  'viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
/** 폴더 — 탭(라벨) 달린 몸통 윤곽선. */
const SVG_FOLDER = `<svg ${SVG_ATTRS}><path d="M2 12.5V3.5h4l1.5 2H14v7z"/></svg>`;
/** 좌우 분할 — 사각형 + 세로 이등분선. */
const SVG_SPLIT_LEFT_RIGHT = `<svg ${SVG_ATTRS}><rect x="2" y="2.75" width="12" height="10.5" rx="1"/><path d="M8 2.75v10.5"/></svg>`;
/** 상하 분할 — 사각형 + 가로 이등분선 (위와 같은 규약의 페어). */
const SVG_SPLIT_TOP_BOTTOM = `<svg ${SVG_ATTRS}><rect x="2" y="2.75" width="12" height="10.5" rx="1"/><path d="M2.75 8h10.5"/></svg>`;

/** 값이 같으면 쓰지 않는 텍스트 대입 — textContent 재대입은 값이 같아도 자식
 *  텍스트 노드를 갈아치우므로, 무변경 갱신이 DOM 을 흔들지 않게 한다. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** 콘텐츠 placeholder 텍스트 (터미널 뷰도 뷰어 뷰도 없는 경우 — 영어 UI 텍스트). */
function placeholderText(tab: Tab | null): string {
  if (tab === null) return "no tabs — press + to open a new terminal tab";
  const kind: TabKind = tab.kind;
  switch (kind.type) {
    case "terminal":
      // ptySession 없는 terminal 탭 — visible 판정에서 제외된 경우.
      return "(terminal tab without pty session)";
    case "folderBrowser":
      // 21단계 C1 이후로 folderBrowser 는 항상 마운트된다 — 이 문구는 뷰
      // 생성이 없었던 경우에만 남는 안전망이다.
      return `folderBrowser: ${kind.path} (no viewer mounted)`;
    case "textViewer":
      // 21단계 C2 이후로 textViewer 도 항상 마운트된다 (위와 같은 안전망).
      return `textViewer: ${kind.path} (no viewer mounted)`;
    case "markdownViewer":
      // 21단계 D 이후로 markdownViewer 도 항상 마운트된다 (위와 같은 안전망).
      return `markdownViewer: ${kind.path} (no viewer mounted)`;
  }
}

/** 재시작 배너 문구 (영어 UI 텍스트) — 두 상태는 사용자에게 전혀 다른 상황이라
 *  안내가 갈린다: "아직 시작도 못 했다"(대개 WSL 이 느리다)와 "끝났다". */
const RESTART_NOTICE = {
  notStarted: "The shell has not started. WSL may be slow or unresponsive.",
  exited: "The shell has exited.",
} as const;

export class PaneView {
  readonly root: HTMLDivElement;
  private readonly contentEl: HTMLDivElement;
  private readonly tabStripEl: HTMLDivElement;
  private readonly unreadEl: HTMLSpanElement;
  private readonly placeholderEl: HTMLDivElement;
  private readonly restartEl: HTMLDivElement;
  /** 배너 내부 노드 — buildRestartBanner 가 채운다 (선언 순서상 definite assignment). */
  private restartTextEl!: HTMLSpanElement;
  private restartButtonEl!: HTMLButtonElement;
  /** 배너 Retry 의 대상 — update 마다 갱신한다. 클로저에 굳히면 탭이 바뀐 뒤에도
   *  옛 탭을 재시도한다. */
  private restartTab: TabId | null = null;
  /** 재스폰 요청이 떠 있는 탭들 — pane 이 아니라 **탭** 단위다. 한 pane 에 죽은 탭이
   *  여럿인 것이 WSL 이 통째로 내려간 경우의 정상 모양이라(ADR-0010), A 의 요청이
   *  스폰 데드라인(5s) 동안 B 의 버튼까지 잠그면 안 된다. */
  private readonly retryInFlight = new Set<TabId>();
  private readonly resizeObserver: ResizeObserver;
  private isActive = false;
  private shown: TabId | null = null;
  /** 마지막 update 의 pane 스냅샷 — 헤더 버튼이 클릭 시점의 표시 탭 cwd 를 읽는다. */
  private pane: Pane | undefined = undefined;

  constructor(
    readonly paneId: PaneId,
    private readonly dispatch: DispatchFn,
    private readonly views: ViewRegistry,
    private readonly viewers: ViewerRegistry,
    /** send-mode 접근 계약 — 현재 arm 진입점이 없어 휴면이다 (파일 상단 주석).
     *  계약은 유지한다: 차기 agent-facing 채널이 여기에 재배선된다. */
    private readonly send: SendController,
  ) {
    this.root = document.createElement("div");
    this.root.className = "pane";
    // 진단 (체크포인트 1 버그 3): DOM 상 어느 슬롯에 어느 pane 의 뷰가 앉았는지
    // devtools·rebuild 로그에서 즉시 판별할 수 있게 id 를 데이터 속성으로 남긴다.
    this.root.dataset.paneId = String(paneId);

    this.contentEl = document.createElement("div");
    this.contentEl.className = "pane-content";
    this.placeholderEl = document.createElement("div");
    this.placeholderEl.className = "pane-placeholder";
    this.restartEl = this.buildRestartBanner();
    this.contentEl.append(this.placeholderEl, this.restartEl);

    this.tabStripEl = document.createElement("div");
    this.tabStripEl.className = "pane-tabs";

    // pane 층 집계 배지 (18단계 B-7) — 값에 따라 있다 없다 하지만 노드는 상주
    // 시키고 hidden 만 토글한다 (헤더 자식이 들락날락하지 않게).
    this.unreadEl = document.createElement("span");
    this.unreadEl.className = "pane-dot";
    this.unreadEl.textContent = "●";
    this.unreadEl.title = "Unread notification in this pane";
    this.unreadEl.hidden = true;

    this.root.append(this.buildHeader(), this.contentEl);

    this.root.addEventListener(
      "mousedown",
      (ev) => {
        // 비활성 pane 클릭 → 모델 포커스 이동. preventDefault 금지 (파일 상단).
        // 탭 클릭도 이 경로가 FocusPane 을 담당한다 (onTabClick 주석 참조).
        // 주 버튼만 — 우/중클릭은 컨텍스트 메뉴·붙여넣기 등 다른 의미를 갖는다.
        if (ev.button !== 0) return;
        // send-mode 대상 확정 (17단계 D2) — FocusPane 대신 resolve 경로. 이
        // 제스처는 순수한 대상 지정이므로 예외적으로 기본 동작·전파를 끊는다
        // (파일 상단 주석). 자기 자신 클릭 = 취소 판정은 send-mode 상태 머신 몫.
        // 현재는 arm 진입점이 없어 isActive() 가 항상 false 라 이 분기는 죽어
        // 있다 — 재배선 시 그대로 살아난다 (파일 상단 휴면 주석).
        if (this.send.isActive()) {
          ev.preventDefault();
          ev.stopPropagation();
          this.send.resolve(this.paneId);
          return;
        }
        if (!this.isActive) void this.dispatch({ type: "focusPane", pane: this.paneId });
      },
      { capture: true },
    );

    // pane 당 observer 1개 (D7) — 표시 중인 뷰에만 fit 을 전달한다.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.shown !== null) this.views.get(this.shown)?.scheduleFit();
    });
    this.resizeObserver.observe(this.contentEl);
  }

  /** 현재 표시 중인 탭 — 터미널 뷰든 뷰어 뷰든 지금 콘텐츠 영역을 차지한 탭이다
   *  (파일 상단 shown 시맨틱). workspace-view 의 focus 보상·send-mode 대상 판정이
   *  조회한다 — 뷰어 탭이 shown 이면 TerminalView 레지스트리에서 미스가 나
   *  "대상에 터미널이 없다" 에러로 떨어진다 (resolveSend). */
  get shownTab(): TabId | null {
    return this.shown;
  }

  /** 셸이 없는 탭에 붙는 배너 — **시작하지 못한 탭(notStarted)과 죽은 탭(exited)이
   *  공유한다.** 문구와 테두리 색만 다르고 동작은 하나다: 같은 탭 id 로 다시 스폰한다
   *  (그래야 HISTFILE·resume 힌트가 그대로 다시 붙는다 — ADR-0010).
   *
   *  탭 배지만으로는 부족해서 둔다 — 실기 사고에서 가장 곤란했던 것은 빈 화면 앞에서
   *  "앱 문제인지 WSL 문제인지 모르겠다"였고, 화면 한가운데의 이 문장이 그 답이다.
   *  notStarted 는 세션을 죽이지 않으므로 늦게 표식이 오면 상태가 running 으로 돌아오고
   *  배너도 저절로 걷힌다. */
  private buildRestartBanner(): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "pane-restart";
    el.hidden = true;

    // 문구·라벨은 syncRestartBanner 가 상태에 맞춰 채운다. notStarted 쪽에 "세션은
    // 아직 살아 있다"는 문구를 넣지 않는 이유: 재시작 복원 뒤에는 persist 가
    // pty_session 을 비운 notStarted 탭이 남아 그 말이 거짓이 된다.
    this.restartTextEl = document.createElement("span");

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "pane-restart-retry";
    retry.addEventListener("click", () => {
      const tab = this.restartTab;
      if (tab === null || this.retryInFlight.has(tab)) return;
      this.retryInFlight.add(tab);
      this.syncRetryDisabled();
      void respawnTab(tab)
        .catch((err: unknown) => {
          // 실패해도 백엔드가 탭을 강등해 publish 하므로 화면은 갱신된다.
          console.error("respawn_tab failed", err);
        })
        .finally(() => {
          this.retryInFlight.delete(tab);
          this.syncRetryDisabled();
        });
    });
    this.restartButtonEl = retry;

    el.append(this.restartTextEl, retry);
    return el;
  }

  /** 활성 탭 상태에 따라 배너를 켜고 문구·Restart 대상을 갱신한다. */
  private syncRestartBanner(pane: Pane): void {
    const tab = pane.tabs.find((t) => t.id === pane.activeTab) ?? null;
    const status = tab !== null && tab.kind.type === "terminal" ? tab.kind.status.type : null;
    const kind = status === "notStarted" || status === "exited" ? status : null;
    this.restartTab = kind === null || tab === null ? null : tab.id;
    this.syncRetryDisabled();
    this.restartEl.hidden = kind === null;
    this.restartEl.classList.toggle("exited", kind === "exited");
    if (kind === null) return;
    setText(this.restartTextEl, RESTART_NOTICE[kind]);
    setText(this.restartButtonEl, kind === "exited" ? "Restart" : "Retry");
  }

  /** 지금 배너가 가리키는 탭의 요청이 떠 있을 때만 버튼을 잠근다. */
  private syncRetryDisabled(): void {
    this.restartButtonEl.disabled =
      this.restartTab !== null && this.retryInFlight.has(this.restartTab);
  }

  private buildHeader(): HTMLElement {
    const header = document.createElement("div");
    header.className = "pane-header";

    header.append(
      this.unreadEl,
      this.tabStripEl,
      // 터미널 cwd 는 클릭 시점의 스냅샷(this.pane)을 thunk 안에서 읽는다 — 클로저에
      // 굳히면 탭이 바뀐 뒤에도 옛 경로로 연다 (restartTab 필드 주석과 같은 이유).
      this.iconButton("+", withShortcut("New terminal tab", "newTerminalTab"), () => ({
        type: "createTab",
        pane: this.paneId,
        tab: { type: "terminal", cwd: paneTerminalCwd(this.pane) },
      })),
      // 폴더 탐색 탭 (21단계) — path null 이면 워크스페이스 rootPath, 그것도
      // 없으면 "/" 로 코어가 해석한다 (terminal 의 cwd 와 대칭).
      this.svgButton(SVG_FOLDER, withShortcut("New folder browser tab", "newFolderTab"), () => ({
        type: "createTab",
        pane: this.paneId,
        tab: { type: "folderBrowser", path: null },
      })),
      // 브라우저 탭 버튼(◎)은 여기 있었다 — 영구 disabled 라 자리만 차지해
      // 뺐다. v2 에서 기능과 함께 돌아온다.

      // 전달 아이콘 2개(⤷ = 전달, ⤷⏎ = 전달 후 실행)도 여기 있었다 — 수동
      // 마우스 제스처가 실사용 워크플로가 아니라 **버튼만** 뺐다. 뒤에 있던
      // send-mode 경로(armSend → SendController → workspace-view.resolveSend)는
      // 전부 그대로다 (파일 상단 휴면 주석) — 차기 agent-facing 채널이 arm 을
      // 다시 부를 때 버튼 없이 살아난다.

      // 분할은 원자 SplitPane — 새 pane 에 terminal 탭까지 한 번에 생성한다
      // (계획 D5: 컴포지션 금지, 중간 스냅샷 1프레임 렌더 방지).
      this.svgButton(
        SVG_SPLIT_LEFT_RIGHT,
        withShortcut("Split left/right", "splitLeftRight"),
        () => ({
          type: "splitPane",
          pane: this.paneId,
          direction: "horizontal",
          tab: { type: "terminal", cwd: paneTerminalCwd(this.pane) },
        }),
      ),
      this.svgButton(
        SVG_SPLIT_TOP_BOTTOM,
        withShortcut("Split top/bottom", "splitTopBottom"),
        () => ({
          type: "splitPane",
          pane: this.paneId,
          direction: "vertical",
          tab: { type: "terminal", cwd: paneTerminalCwd(this.pane) },
        }),
      ),
    );
    return header;
  }

  /** 전달 소스 캡처 (17단계 D2) — 이 pane 의 표시 중 터미널에서 선택 텍스트를
   *  캡처해 대상 선택 모드로 arm 한다. 캡처 불가(빈 pane·뷰어 탭·무선택)는 상태
   *  라인 one-shot 에러로 표면화한다 — 조용한 no-op 금지.
   *
   *  **호출자가 없다 (휴면)**: 이걸 부르던 헤더의 ⤷/⤷⏎ 버튼을 뺐고 다른 진입점을
   *  아직 두지 않았다. 차기 agent-facing 채널이 붙일 지점이 정확히 여기라 구현을
   *  남겨 둔다 (파일 상단 주석). 재배선은 이 메서드를 부르는 것으로 끝난다 —
   *  아래 계층(SendController → send-mode.ts → workspace-view.resolveSend →
   *  terminal-view.paste/submit)은 전부 온전하다. */
  private armSend(submit: boolean): void {
    const view = this.shown === null ? undefined : this.views.get(this.shown);
    if (view === undefined) {
      this.send.flashError("cannot send: no terminal shown in this pane");
      return;
    }
    const text = view.getSelection();
    if (text.length === 0) {
      this.send.flashError("no selection to send");
      return;
    }
    this.send.arm(this.paneId, text, submit);
  }

  /** 아이콘 SVG 버튼 — 라벨이 텍스트가 아니라 마크업이라는 점만 iconButton 과
   *  다르다. svg 인자는 이 모듈 상단의 SVG_* 상수만 받는다 (파일발 문자열이 아닌
   *  신뢰 소스 — 상단 주석). */
  private svgButton(svg: string, title: string, command: () => Command): HTMLButtonElement {
    const btn = this.iconButton("", title, command);
    btn.innerHTML = svg;
    return btn;
  }

  private iconButton(label: string, title: string, command: () => Command): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("click", () => {
      void this.dispatch(command());
    });
    return btn;
  }

  /** 스냅샷 반영 — 활성 테두리·탭바 갱신 + keep-alive 뷰 가시성 전환.
   *  visible 은 planViewSync 가, visibleViewer 는 planViewerSync 가 이 pane 에
   *  대해 판정한 항목(없으면 null)이다. 탭 하나는 terminal 이거나 뷰어이지 둘
   *  다일 수 없으므로 둘이 동시에 non-null 로 오지 않는다. */
  update(
    pane: Pane,
    active: boolean,
    visible: VisibleView | null,
    visibleViewer: VisibleViewer | null,
  ): void {
    this.isActive = active;
    this.pane = pane;
    this.root.classList.toggle("active", active);
    this.renderTabStrip(pane);

    if (visible !== null) {
      // 첫 가시화 때 lazy attach — 이미 있으면 레지스트리의 기존 뷰 그대로.
      this.views.ensure(visible.tab, visible.session, this.contentEl, (message) =>
        this.showAttachError(visible.tab, message),
      );
      this.shown = visible.tab;
    } else if (visibleViewer !== null) {
      // 뷰어는 활성 탭일 때만 마운트된다 (viewer-view.ts) — 첫 마운트 때 생성,
      // 이후 렌더는 update 로 kind 만 밀어 넣는다(무변경이면 뷰가 no-op).
      const view = this.viewers.ensure(visibleViewer, this.contentEl);
      view?.update(visibleViewer.kind);
      // 아직 구현이 없는 뷰어 종류면 view 가 null 이고, 표시 중인 것이 없으므로
      // placeholder 경로로 되돌아간다.
      this.shown = view === null ? null : visibleViewer.tab;
    } else {
      this.shown = null;
    }

    // 이 pane 탭들의 keep-alive 뷰 가시성 동기화 — 표시 1개, 나머지 숨김.
    for (const tab of pane.tabs) {
      this.views.get(tab.id)?.setVisible(tab.id === this.shown);
    }

    this.syncRestartBanner(pane);

    if (this.shown === null) {
      const tab = pane.tabs.find((t) => t.id === pane.activeTab) ?? null;
      this.placeholderEl.textContent = placeholderText(tab);
      this.placeholderEl.style.display = ""; // 스타일시트의 flex 복원
    } else {
      this.placeholderEl.style.display = "none";
    }
  }

  /** 직전 렌더의 탭 버튼 모델 (첫 렌더 전 null) — tabStripPlan 의 좌변. */
  private lastStrip: TabButtonModel[] | null = null;
  /** 현재 스트립에 붙어 있는 탭 버튼 노드 — tab id 키잉, patch 판정의 대상. */
  private readonly tabNodes = new Map<TabId, TabNodes>();

  /** 탭바 갱신 (18단계 B-7) — tabStripPlan 판정대로 skip/patch/rebuild.
   *
   *  클릭 진행 중(mousedown~click 사이)에 렌더가 눌린 탭 엘리먼트를 갈아치우면
   *  브라우저가 click 을 발화하지 않아 "비활성 pane 탭은 두 번 클릭해야 먹는"
   *  버그가 된다 (ADR-0003 결정 7). 12단계의 "모델 직렬화 키가 같으면 스킵" 가드로
   *  그 창을 닫아 뒀지만, 18단계에서 제목(OSC 0/2)과 unread 가 동적 필드가 되면서
   *  무관한 알림 하나로도 키가 달라져 가드가 상시로 뚫린다 — 그래서 스킵은 skip
   *  판정으로만 남기고, 값이 변한 경우의 기본 경로를 in-place 패치로 바꾼다. */
  private renderTabStrip(pane: Pane): void {
    const model = tabStripModel(pane);
    const prev = this.lastStrip;
    const plan = tabStripPlan(prev, model);
    if (plan === "skip") return;
    if (plan === "rebuild") {
      this.tabNodes.clear();
      const nodes = model.map((m) => this.tabButton(m));
      for (const n of nodes) this.tabNodes.set(n.model.tab, n);
      this.tabStripEl.replaceChildren(...nodes.map((n) => n.root));
    } else {
      // 멤버십·순서가 같음이 판정으로 보장된다 — 변한 탭만 in-place 갱신.
      model.forEach((next, i) => {
        const before = prev?.[i];
        if (before !== undefined && sameTabButton(before, next)) return;
        const nodes = this.tabNodes.get(next.tab);
        if (nodes !== undefined) this.applyTab(nodes, next);
      });
    }
    this.lastStrip = model;
    // skip 이면 unread 도 불변이라 여기까지 오지 않는다 — 배지도 무접촉.
    this.unreadEl.hidden = !paneUnread(model);
  }

  private tabButton(model: TabButtonModel): TabNodes {
    // 컨테이너는 div — X 가 <button> 이라 버튼 중첩을 피한다.
    const el = document.createElement("div");
    el.className = "tab";

    const title = document.createElement("span");
    title.className = "tab-title";

    // dot·exited 배지는 값에 따라 있다 없다 하지만 노드는 항상 만들고 hidden
    // 으로만 토글한다 — 자식이 들락날락하면 in-place 패치의 의미가 없어진다.
    const dot = document.createElement("span");
    dot.className = "tab-dot";
    dot.textContent = "●";
    dot.title = "Unread notification";

    const exited = document.createElement("span");
    exited.className = "tab-exited";
    exited.textContent = "exited";

    // 별개 배지인 이유: "끝났다"와 "시작을 못 했다"는 사용자에게 다른 상황이고,
    // 후자는 WSL 쪽 문제를 가리키는 신호라 안내가 달라야 한다.
    const notStarted = document.createElement("span");
    notStarted.className = "tab-not-started";
    notStarted.textContent = "not started";
    notStarted.title = "The shell has not started yet — WSL may be slow or unresponsive.";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.textContent = "×";
    // 단축키는 "활성 pane 의 활성 탭"을 닫는다 — 이 × 는 자기 탭을 닫으므로
    // 활성 탭의 × 에서만 둘이 같은 대상이다. 툴팁은 그래도 모든 탭에 같은
    // 문구를 단다 (탭마다 다른 툴팁이 더 헷갈린다).
    close.title = withShortcut("Close tab", "closeTab");
    close.addEventListener("click", (ev) => {
      ev.stopPropagation(); // 탭 활성화 클릭과 분리
      // tab id 는 이 노드의 키라 패치로도 변하지 않는다 — 클로저로 안전하다
      // (active 처럼 변하는 필드만 nodes.model 에서 다시 읽는다).
      void this.dispatch({ type: "closeTab", tab: model.tab });
    });

    el.append(title, dot, exited, notStarted, close);

    const nodes: TabNodes = { root: el, title, dot, exited, notStarted, model };
    this.applyTab(nodes, model);

    el.addEventListener("click", () => this.onTabClick(nodes.model));
    return nodes;
  }

  /** 탭 모델을 기존 노드에 반영 — 조립 직후와 in-place 패치가 같은 경로를 탄다. */
  private applyTab(nodes: TabNodes, model: TabButtonModel): void {
    nodes.model = model;
    nodes.root.classList.toggle("active", model.active);
    nodes.root.classList.toggle("exited", model.exited);
    nodes.root.classList.toggle("not-started", model.notStarted);
    nodes.root.title = model.title; // 잘린 제목의 툴팁

    setText(nodes.title, model.title);
    nodes.dot.hidden = !model.notification;
    nodes.exited.hidden = !model.exited;
    nodes.notStarted.hidden = !model.notStarted;
  }

  /** 탭 클릭 처리. 비활성 pane 의 FocusPane 은 root 의 mousedown capture 가
   *  같은 제스처(mousedown → click 순서)에서 이미 dispatch 했다 — 여기서 또
   *  보내면 무변경 revision 잡음이 된다. */
  private onTabClick(model: TabButtonModel): void {
    if (!model.active) {
      // ActivateTab 성공 시의 뷰 focus 는 main.dispatchUI 의 보상 경로가
      // requestFocus 로 처리한다 (계획 D7).
      void this.dispatch({ type: "activateTab", tab: model.tab });
      return;
    }
    // 이미 active 탭: dispatch 없이(no-op 스킵) 뷰 focus 만. pane 이 비활성인
    // 경우는 mousedown 의 FocusPane 성공 보상이 focus 를 처리한다. 뷰어 탭도
    // focus() 를 갖는다 (21단계 — 두 레지스트리는 키가 겹치지 않는다).
    if (this.isActive) (this.views.get(model.tab) ?? this.viewers.get(model.tab))?.focus();
  }

  /** attach 실패 노출 — 레지스트리(ensure)가 뷰를 정리한 뒤 부른다. 실패한 탭이
   *  아직 표시 대상이면 placeholder 에 에러를 띄운다 (다음 스냅샷 렌더가 재시도). */
  private showAttachError(tab: TabId, message: string): void {
    if (this.shown !== tab) return;
    this.shown = null;
    this.placeholderEl.textContent = message;
    this.placeholderEl.style.display = "";
  }

  /** pane 뷰 해제 — observer·DOM 만 정리한다. 터미널 뷰는 레지스트리 소유라
   *  여기서 dispose 하지 않는다 — pane 이 닫히면 그 탭들이 스냅샷에서 사라져
   *  view-reconcile 의 dispose 목록으로 정리된다 (계획 D3). */
  dispose(): void {
    this.resizeObserver.disconnect();
    this.root.remove();
  }
}
