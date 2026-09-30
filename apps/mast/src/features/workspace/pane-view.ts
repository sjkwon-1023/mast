import { IS_MAC } from "../../shared/platform";
// pane 1개의 뷰 — 헤더(탭바 + 탭 생성·분할 아이콘) + keep-alive 콘텐츠 영역.
//
// 콘텐츠는 keep-alive 다: 탭별 TerminalView 는 앱 수준 레지스트리
// (workspace-view 소유 Map<TabId, TerminalView>)가 소유하고, 여기서는 ViewRegistry
// 를 통해 얻어 setVisible(display 토글)로 전환만 한다 — 탭 전환에 dispose/재생성·
// replay 왕복이 없다. 어떤 탭이 보일지는 view-reconcile(planViewSync)의 visible
// 판정을 workspace-view 가 pane 별로 내려준다 (판정 로직 단일화). 뷰 생성(lazy
// attach)은 첫 가시화 때 ensure 로 일어난다.
//
// fit 은 pane 당 ResizeObserver 1개(콘텐츠 영역 관찰)가 표시 중인 뷰의
// scheduleFit 만 부른다. 뷰당 observer 는 없다 (terminal-view 참조).
//
// 클릭 포커스: 컨테이너 mousedown 을 capture 단계에서 받아 비활성
// pane 이면 FocusPane 을 dispatch 한다. preventDefault 는 하지 않는다 — xterm 의
// 포커스·선택 처리를 강탈하면 안 되기 때문이다. DOM 포커스는 그대로 흘러가고
// 모델의 active_pane 만 따라온다.
//
// 헤더 아이콘은 인라인 SVG 다 (폴더·분할 2종) — 유니코드 기호(▤/◫/⊟)는 폰트마다
// 모양이 갈리고 "무엇을 하는 버튼인지"가 자명하지 않아 그림으로 바꿨다. 마크업은
// 아래 상수 3개가 전량이고, 전부 이 파일에 박힌 신뢰 소스다 (파일·모델·네트워크
// 발 문자열이 innerHTML 로 들어오는 경로는 없다 — SVG_* 주석 참조).
//
// 탭바 렌더: tabStripPlan 판정대로 skip(DOM 무접촉) / patch(탭 버튼
// 노드를 유지한 채 제목·dot·클래스만 갱신) / rebuild(멤버십·순서 변화 → 재조립)
// 셋으로 갈린다 — renderTabStrip 주석 참조. 헤더에는 pane 층 집계 배지(●)가
// 붙는다.
//
// 뷰어 탭: 콘텐츠 영역에는 터미널 뷰(keep-alive)와 뷰어 뷰(활성 탭만
// 마운트)가 공존한다. 어느 쪽이 이번 렌더의 표시 대상인지는 workspace-view 가
// planViewSync(visible)·planViewerSync(mount) 판정으로 내려주고, 여기서는 그
// 둘 중 하나를 shown 으로 삼는다 — **shownTab = 표시 중인 탭**(터미널이든 뷰어든)
// 이고, placeholder 는 둘 다 없을 때만 뜬다 (동시 표시 금지).

import { respawnTab } from "../../infrastructure/backend";
import { paneTerminalCwd, shortcutBadge, shortcutLabel } from "../../shared/keys";
import type { ShortcutId } from "../../shared/keys";
import {
  paneNeedsInput,
  paneUnread,
  sameTabButton,
  tabDropBefore,
  tabMoveChangesOrder,
  tabStripModel,
  tabStripPlan,
} from "./tab-strip-model";
import { tabIdsVisible } from "./tab-id-settings";
import type { TabBox, TabButtonModel } from "./tab-strip-model";
import type { TerminalView } from "../terminal/view";
import type { ViewerView } from "../viewers/viewer-view";
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
} from "../../shared/types";

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

/** 뷰어 뷰 레지스트리 접근 계약 — 소유자는 workspace-view 다.
 *  터미널과 별도 레지스트리인 이유는 수명 시맨틱이 반대이기 때문이다
 *  (features/viewers/viewer-view.ts 참조). ensure 는 없으면 생성해 parent 에 마운트한다. 뷰어
 *  네 종류가 모두 착지한 지금 null 은 나오지 않지만, 반환 타입에는 남겨 pane 이
 *  placeholder 경로로 되돌아가는 안전망을 유지한다. */
export interface ViewerRegistry {
  get(tab: TabId): ViewerView | undefined;
  ensure(target: VisibleViewer, parent: HTMLElement): ViewerView | null;
}

/** 탭 버튼 1개의 DOM 노드 묶음 — in-place 패치 대상. model 은 이 버튼이 지금
 *  그리고 있는 모델로, 클릭 핸들러가 stale 클로저 대신 여기서 최신 값을 읽는다
 *  (패치로 active 가 바뀌므로 클로저에 굳으면 활성 탭이 ActivateTab 을 재발행한다). */
interface TabNodes {
  root: HTMLElement;
  title: HTMLSpanElement;
  needsInput: HTMLSpanElement;
  /** 안정 Tab.id 배지 (`#12`) — showTabIds 가 끄면 hidden. */
  id: HTMLSpanElement;
  dot: HTMLSpanElement;
  exited: HTMLSpanElement;
  notStarted: HTMLSpanElement;
  model: TabButtonModel;
}

/** 단축키가 있는 버튼 툴팁 — "<기능> (<단축키>)". 단축키 문자열은 keys.ts 의
 *  shortcutLabel 단일 소스에서만 받는다. 좌우 분할 버튼은 단축키 없이 남는다. */
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
/** 변경 목록 — 사각형 안에 추가·삭제를 뜻하는 두 선. */
const SVG_CHANGES = `<svg ${SVG_ATTRS}><path d="M4 3.25h8M4 6.5h5M4 9.75h8M4 13h5"/><path d="M2 3.25h.01M2 6.5h.01M2 9.75h.01M2 13h.01"/></svg>`;

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
    case "browser": return `browser: ${kind.url}`;
    case "terminal":
      // 세션 없는 terminal 탭 중 기록 뷰가 맡지 않는 것 — 세션 없는 exited 탭은
      // 기록 뷰가 마운트되므로(ADR-0018) 여기 오지 않는다. 남는 것은 복원 직후의
      // Running 탭(세션이 아직 없다 — 부팅 웨이브가 닿기 전)과 NotStarted 탭이다.
      return "(terminal tab without pty session)";
    case "folderBrowser":
      // 뷰어는 항상 마운트되므로 아래 문구들은 뷰 생성이 실패했을 때의 안전망이다.
      return `folderBrowser: ${kind.path} (no viewer mounted)`;
    case "textViewer":
      return `textViewer: ${kind.path} (no viewer mounted)`;
    case "markdownViewer":
      return `markdownViewer: ${kind.path} (no viewer mounted)`;
    case "changesViewer":
      return `changesViewer: ${kind.path} (no viewer mounted)`;
  }
}

/** 시작하지 못한 탭의 배너 문구 (영어 UI 텍스트) — exited 와 전혀 다른 상황이라
 *  안내가 갈린다: "아직 시작도 못 했다"(Windows 에서는 대개 WSL 이 느리다)와 "끝났다".
 *  macOS 에는 WSL 이 없으므로 셸 시작 자체를 가리키는 문구를 쓴다. */
const NOT_STARTED_NOTICE = IS_MAC
  ? "The shell has not started. Its startup files may be slow or waiting for input."
  : "The shell has not started. WSL may be slow or unresponsive.";

/** 끝난 탭의 배너 문구 — DOM-free 순수 함수라 테스트가 네 조합을 다 잠근다.
 *
 *  두 조각(code·시각)은 **각각** 빠질 수 있다: code 는 백엔드가 종료 코드를 얻지
 *  못한 경우(강등·audit 수리)이고, 시각은 이 필드를 모르는 구 state.json 에서
 *  복원된 탭이다. 없는 조각은 "unknown" 으로 적지 않고 통째로 뺀다 — 모르는 값을
 *  자리만 채워 보여 주면 읽는 쪽이 그것도 정보라고 믿는다.
 *
 *  Restart 를 문장에 넣는 이유는 옆 버튼이 "같은 화면을 되살린다"로 읽히기 때문
 *  이다 — 실제로는 새 셸이고, 기록은 그 순간 지워진다 (ADR-0018). */
export function exitedNoticeText(code: number | null, endedAtMs: number | null): string {
  const at = endedAtMs === null ? null : localHourMinute(endedAtMs);
  const exit = code === null ? "" : ` (code ${code})`;
  return `shell exited${exit}${at === null ? "" : ` at ${at}`} — Restart opens a new shell here`;
}

/** 로컬 시각 HH:MM, 읽을 수 없는 값이면 null — 날짜를 붙이지 않는 것은 배너가
 *  "방금 끝났다"를 말하는 자리라서다. 앱을 껐다 켠 뒤의 기록도 같은 문구를 쓰지만,
 *  그 경우 날짜까지 필요하면 탭이 아니라 기록 자체를 여는 길이 있어야 한다 (범위 밖).
 *
 *  null 을 돌려주는 길이 있는 이유: `ended_at_ms` 는 디스크에서 복원된 숫자라
 *  `Date` 가 Invalid Date 로 읽는 값(범위 밖·NaN)일 수 있고, 그러면 배너에
 *  `at NaN:NaN` 이 박힌다. 모르는 값은 조각째 빼는 것이 위 규율이다. */
function localHourMinute(ms: number): string | null {
  const at = new Date(ms);
  if (!Number.isFinite(at.getTime())) return null;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 포인터가 이만큼 움직여야 드래그로 친다 — 흔들린 클릭이 탭을 옮기면 안 된다
 *  (사이드바 카드 드래그와 같은 문턱). */
const TAB_DRAG_THRESHOLD_PX = 4;

/** 놓을 자리 — 대상 pane 과 그 안에서 앞에 놓일 탭 (`moveTab` 계약). */
interface TabDrop {
  pane: PaneId;
  before: TabId | null;
}

/** 진행 중인 탭 드래그. `moving` 이 false 인 동안은 아직 클릭으로 끝날 수 있는 눌림이다. */
interface TabDrag {
  tab: TabId;
  pointerId: number;
  startX: number;
  startY: number;
  moving: boolean;
  drop: TabDrop | null;
}

/** 포인터 아래의 pane 과 놓을 자리. pane 은 DOM 의 `data-pane-id` 로 찾으므로 다른
 *  PaneView 의 탭바·콘텐츠 위에서도 판정된다. 탭바 위면 가로 위치로 자리를 고르고,
 *  콘텐츠 위면 그 pane 의 맨 뒤다. */
function tabDropAt(x: number, y: number): TabDrop | null {
  const hit = document.elementFromPoint(x, y);
  const paneEl = hit?.closest<HTMLElement>(".pane[data-pane-id]") ?? null;
  if (paneEl === null) return null;
  const pane = Number(paneEl.dataset.paneId) as PaneId;
  const strip = hit?.closest(".pane-tabs") ?? null;
  if (strip === null) return { pane, before: null };
  const boxes: TabBox[] = [];
  for (const el of strip.querySelectorAll<HTMLElement>(".tab[data-tab-id]")) {
    const rect = el.getBoundingClientRect();
    boxes.push({ tab: Number(el.dataset.tabId) as TabId, left: rect.left, width: rect.width });
  }
  return { pane, before: tabDropBefore(boxes, x) };
}

function clearTabDropIndicator(): void {
  for (const el of document.querySelectorAll(".tab-drop-target, .tab.drop-before, .tab.drop-after")) {
    el.classList.remove("tab-drop-target", "drop-before", "drop-after");
  }
}

/** 놓을 자리 표시 — 대상 pane 전체에 윤곽을, 탭바의 자리에 accent 선을 둔다. 맨 뒤면
 *  마지막 탭의 오른쪽에 둔다 (탭이 없으면 pane 윤곽만). */
function showTabDropIndicator(drop: TabDrop): void {
  clearTabDropIndicator();
  const paneEl = document.querySelector(`.pane[data-pane-id="${drop.pane}"]`);
  if (paneEl === null) return;
  paneEl.classList.add("tab-drop-target");
  if (drop.before === null) {
    const tabs = paneEl.querySelectorAll(".tab[data-tab-id]");
    tabs[tabs.length - 1]?.classList.add("drop-after");
  } else {
    paneEl.querySelector(`.tab[data-tab-id="${drop.before}"]`)?.classList.add("drop-before");
  }
}

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
  private drag: TabDrag | null = null;
  /** 드래그로 끝난 제스처 뒤의 click 한 번을 삼킨다 — 옮기려고 끈 탭이 활성화까지 되면 안 된다. */
  private dragged = false;

  constructor(
    readonly paneId: PaneId,
    private readonly dispatch: DispatchFn,
    private readonly views: ViewRegistry,
    private readonly viewers: ViewerRegistry,
  ) {
    this.root = document.createElement("div");
    this.root.className = "pane";
    // 진단: DOM 상 어느 슬롯에 어느 pane 의 뷰가 앉았는지
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

    // pane 층 집계 배지 — 값에 따라 있다 없다 하지만 노드는 상주
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
   *  (파일 상단 shown 시맨틱). workspace-view 의 focus 보상이 조회한다. */
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
    const kind = tab !== null && tab.kind.type === "terminal" ? tab.kind : null;
    // 배너가 뜨는 상태만 남긴다 — status 가 non-null 인 것이 곧 "배너를 켠다" 다.
    const status = kind === null || kind.status.type === "running" ? null : kind.status;
    this.restartTab = status === null || tab === null ? null : tab.id;
    this.syncRetryDisabled();
    this.restartEl.hidden = status === null;
    this.restartEl.classList.toggle("exited", status?.type === "exited");
    if (status === null) return;
    if (status.type === "exited") {
      setText(this.restartTextEl, exitedNoticeText(status.code, status.endedAtMs));
      setText(this.restartButtonEl, "Restart");
    } else {
      setText(this.restartTextEl, NOT_STARTED_NOTICE);
      setText(this.restartButtonEl, "Retry");
    }
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
      }), shortcutBadge("newTerminalTab")),
      // 폴더 탐색 탭 — path null 이면 워크스페이스 rootPath, 그것도
      // 없으면 "/" 로 코어가 해석한다 (terminal 의 cwd 와 대칭).
      this.svgButton(SVG_FOLDER, withShortcut("New folder browser tab", "newFolderTab"), () => ({
        type: "createTab",
        pane: this.paneId,
        tab: { type: "folderBrowser", path: null },
      }), shortcutBadge("newFolderTab")),
      // Changes 는 pane 셸의 cwd 가 아니라 워크스페이스 루트에서 여는 전역
      // 작업 목록이다. path null 은 코어가 워크스페이스 rootPath 로 해석한다.
      this.svgButton(SVG_CHANGES, "New changes viewer tab", () => ({
        type: "createTab",
        pane: this.paneId,
        tab: { type: "changesViewer", path: null },
      })),
      this.iconButton("◎", "New browser tab", () => ({
        type: "createTab", pane: this.paneId, tab: {type: "browser", url: ""},
      })),

      // 분할은 원자 SplitPane — 새 pane 에 terminal 탭까지 한 번에 생성한다
      // (중간 스냅샷이 1프레임 렌더되지 않게).
      this.svgButton(
        SVG_SPLIT_LEFT_RIGHT,
        "Split left/right",
        () => ({
          type: "splitPane",
          pane: this.paneId,
          direction: "horizontal",
          tab: { type: "terminal", cwd: paneTerminalCwd(this.pane) },
        }),
      ),
      this.svgButton(
        SVG_SPLIT_TOP_BOTTOM,
        "Split top/bottom",
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

  /** 아이콘 SVG 버튼 — 라벨이 텍스트가 아니라 마크업이라는 점만 iconButton 과
   *  다르다. svg 인자는 이 모듈 상단의 SVG_* 상수만 받는다 (파일발 문자열이 아닌
   *  신뢰 소스 — 상단 주석). */
  private svgButton(svg: string, title: string, command: () => Command, altShortcut?: string): HTMLButtonElement {
    const btn = this.iconButton("", title, command, altShortcut);
    btn.innerHTML = svg;
    return btn;
  }

  private iconButton(label: string, title: string, command: () => Command, altShortcut?: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.title = title;
    if (altShortcut !== undefined) btn.dataset.altShortcut = altShortcut;
    btn.addEventListener("click", () => {
      void this.dispatch(command());
    });
    return btn;
  }

  /** 스냅샷 반영 — 활성 테두리·탭바 갱신 + keep-alive 뷰 가시성 전환.
   *  visible 은 planViewSync 가, visibleViewer 는 planViewerSync 가 이 pane 에
   *  대해 판정한 항목(없으면 null)이다. ADR-0018 이후로 terminal 탭도 뷰어가 될 수
   *  있지만 둘이 동시에 non-null 로 오지는 않는다 — 판별자가 `ptySession` 이라
   *  양쪽 통과 조건이 서로 배타적이다 (근거는 features/workspace/view-reconcile.ts 상단). */
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
      // 뷰어는 활성 탭일 때만 마운트된다 (features/viewers/viewer-view.ts) — 첫 마운트 때 생성,
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

  /** 탭바 갱신 — tabStripPlan 판정대로 skip/patch/rebuild.
   *
   *  클릭 진행 중(mousedown~click 사이)에 렌더가 눌린 탭 엘리먼트를 갈아치우면
   *  브라우저가 click 을 발화하지 않아 "비활성 pane 탭은 두 번 클릭해야 먹는"
   *  버그가 된다 (ADR-0003 결정 7). 제목(OSC 0/2)과 unread 는 알림마다 바뀌므로 값이
   *  변한 경우의 기본 경로는 노드를 유지하는 in-place 패치다. */
  private renderTabStrip(pane: Pane): void {
    const model = tabStripModel(pane);
    const prev = this.lastStrip;
    // 드래그 중에는 탭바를 다시 그리지 않는다 — 끌고 있는 노드가 갈리면 포인터 캡처가
    // 끊긴다. 밀린 렌더는 endTabDrag 가 만회한다.
    if (this.drag?.moving) return;
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
    // skip 이면 unread·needsInput 도 불변이라 여기까지 오지 않는다 — 배지도 무접촉.
    const needsInput = paneNeedsInput(model);
    this.unreadEl.hidden = !(paneUnread(model) || needsInput);
    this.unreadEl.classList.toggle("needs-input", needsInput);
    this.unreadEl.title = needsInput
      ? "Agent needs input in this pane"
      : "Unread notification in this pane";
  }

  private tabButton(model: TabButtonModel): TabNodes {
    // 컨테이너는 div — X 가 <button> 이라 버튼 중첩을 피한다.
    const el = document.createElement("div");
    el.className = "tab";
    el.dataset.tabId = String(model.tab);

    const title = document.createElement("span");
    title.className = "tab-title";

    // needsInput·dot·exited 배지는 값에 따라 있다 없다 하지만 노드는 항상 만들고
    // hidden 으로만 토글한다 — 자식이 들락날락하면 in-place 패치의 의미가 없어진다.
    const needsInput = document.createElement("span");
    needsInput.className = "tab-needs-input";
    needsInput.textContent = "!";
    needsInput.title = "Needs input";

    // 탭의 안정 ID — `mast ls` 의 TAB 열과 `mast send '#<id>'` 가 받는 그 주소다.
    // 모델이 이미 들고 있는 Tab.id(model.tab)를 그대로 옮기며, 여기서 새로 만들지
    // 않는다. 노드 수명 = 탭 id 라 클로저로 굳혀도 안전하다 (applyTab 주석 참조).
    const id = document.createElement("span");
    id.className = "tab-id";
    id.title = `Tab #${model.tab}`;

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
    notStarted.title = IS_MAC
      ? "The shell has not started yet — its startup files may be slow or waiting for input."
      : "The shell has not started yet — WSL may be slow or unresponsive.";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.textContent = "×";
    // 단축키는 "활성 pane 의 활성 탭"을 닫는다 — 이 × 는 자기 탭을 닫으므로
    // 활성 탭의 × 에서만 둘이 같은 대상이다. 툴팁은 그래도 모든 탭에 같은
    // 문구를 단다 (탭마다 다른 툴팁이 더 헷갈린다).
    close.title = withShortcut("Close tab", "closeTab");
    close.dataset.altShortcut = shortcutBadge("closeTab");
    close.addEventListener("click", (ev) => {
      ev.stopPropagation(); // 탭 활성화 클릭과 분리
      // tab id 는 이 노드의 키라 패치로도 변하지 않는다 — 클로저로 안전하다
      // (active 처럼 변하는 필드만 nodes.model 에서 다시 읽는다).
      void this.dispatch({ type: "closeTab", tab: model.tab });
    });

    el.append(title, id, needsInput, dot, exited, notStarted, close);

    const nodes: TabNodes = { root: el, title, id, needsInput, dot, exited, notStarted, model };
    this.applyTab(nodes, model);

    el.addEventListener("pointerdown", (ev) => this.onTabPointerDown(ev, nodes));
    el.addEventListener("pointermove", (ev) => this.onTabPointerMove(ev, el));
    el.addEventListener("pointerup", () => this.endTabDrag(true));
    el.addEventListener("pointercancel", () => this.endTabDrag(false));
    el.addEventListener("lostpointercapture", () => this.endTabDrag(false));
    el.addEventListener("click", () => {
      if (this.dragged) {
        this.dragged = false;
        return;
      }
      this.onTabClick(nodes.model);
    });
    return nodes;
  }

  /** 탭 눌림 — 문턱을 넘어야 드래그가 된다. × 위의 눌림은 닫기 버튼의 것이다. */
  private onTabPointerDown(ev: PointerEvent, nodes: TabNodes): void {
    // 드래그가 탭 밖에서 끝나면 click 이 오지 않으므로 삼킴 플래그는 여기서 만료된다.
    this.dragged = false;
    if (ev.button !== 0) return;
    if (ev.target instanceof HTMLElement && ev.target.closest("button") !== null) return;
    this.drag = {
      tab: nodes.model.tab,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      moving: false,
      drop: null,
    };
  }

  private onTabPointerMove(ev: PointerEvent, el: HTMLElement): void {
    const drag = this.drag;
    if (drag === null || ev.pointerId !== drag.pointerId) return;
    if (!drag.moving) {
      const dx = Math.abs(ev.clientX - drag.startX);
      const dy = Math.abs(ev.clientY - drag.startY);
      if (dx < TAB_DRAG_THRESHOLD_PX && dy < TAB_DRAG_THRESHOLD_PX) return;
      drag.moving = true;
      // 캡처는 문턱을 넘은 뒤에만 잡는다 — 먼저 잡으면 평범한 클릭까지 붙들린다.
      el.setPointerCapture(ev.pointerId);
      el.classList.add("dragging");
    }
    drag.drop = tabDropAt(ev.clientX, ev.clientY);
    if (drag.drop === null) clearTabDropIndicator();
    else showTabDropIndicator(drag.drop);
  }

  /** 드래그 종료. `commit` 이고 자리가 실제로 바뀌면 moveTab 을 보낸다. */
  private endTabDrag(commit: boolean): void {
    const drag = this.drag;
    if (drag === null) return;
    this.drag = null;
    if (!drag.moving) return;
    this.dragged = true;
    clearTabDropIndicator();
    this.tabNodes.get(drag.tab)?.root.classList.remove("dragging");

    const drop = drag.drop;
    if (commit && drop !== null && this.movesTab(drag.tab, drop)) {
      void this.dispatch({ type: "moveTab", tab: drag.tab, pane: drop.pane, before: drop.before });
    }
    if (this.pane !== undefined) this.renderTabStrip(this.pane);
  }

  private movesTab(tab: TabId, drop: TabDrop): boolean {
    if (drop.pane !== this.paneId) return true;
    const tabs = (this.lastStrip ?? []).map((m) => m.tab);
    return tabMoveChangesOrder(tabs, tab, drop.before);
  }

  /** 탭 모델을 기존 노드에 반영 — 조립 직후와 in-place 패치가 같은 경로를 탄다. */
  private applyTab(nodes: TabNodes, model: TabButtonModel): void {
    nodes.model = model;
    nodes.root.classList.toggle("active", model.active);
    nodes.root.classList.toggle("exited", model.exited);
    nodes.root.classList.toggle("not-started", model.notStarted);
    nodes.root.title = model.title; // 잘린 제목의 툴팁

    setText(nodes.title, model.title);
    nodes.needsInput.hidden = !model.needsInput;
    // ID 배지 — 부팅 때 한 번 정해진 설정이라 렌더 중 변하지 않는다. 꺼져 있으면
    // 텍스트도 비우고 hidden 으로 자리까지 걷는다 (노드는 상주 — 위 dot 규율).
    const idText = tabIdsVisible() ? `#${model.tab}` : "";
    setText(nodes.id, idText);
    nodes.id.hidden = idText === "";
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
      // requestFocus 로 처리한다.
      void this.dispatch({ type: "activateTab", tab: model.tab });
      return;
    }
    // 이미 active 탭: dispatch 없이(no-op 스킵) 뷰 focus 만. pane 이 비활성인
    // 경우는 mousedown 의 FocusPane 성공 보상이 focus 를 처리한다. 뷰어 탭도
    // focus() 를 갖는다.
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
   *  view-reconcile 의 dispose 목록으로 정리된다. */
  dispose(): void {
    this.resizeObserver.disconnect();
    this.root.remove();
  }
}
