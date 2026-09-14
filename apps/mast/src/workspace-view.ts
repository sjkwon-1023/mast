// 활성 워크스페이스의 split tree 렌더 진입점 (11단계 청크 B → 12단계 청크 C).
//
// 렌더 전략 (계획 1-B):
// - structureKey 가 직전과 같으면 각 split 컨테이너 자식의 flex 만 in-place
//   갱신한다. 단 드래그 활성 split(activeDrags — splitter 가 등록)은 건너뛴다:
//   드래그 중 도착하는 스냅샷이 프리뷰 ratio 를 밟지 않게 하는 D2 가드다.
// - 다르면 DOM 을 재구축하되 pane 콘텐츠 엘리먼트(PaneView.root)는 레지스트리
//   에서 재사용(reparent)해 xterm 재attach·replay 왕복을 피한다 — 현 렌더러가
//   DOM 이라 reparent 리스크가 낮다 (WebGL 활성화 시 재평가).
// - split 컨테이너는 SplitId 로 키잉한다 (경로 인덱스 금지 — 계획 D1).
//
// keep-alive 뷰 수명 (12단계 — 계획 D3·D4-b): 탭별 TerminalView 레지스트리
// (Map<TabId, TerminalView>)를 여기서 소유하고, 스냅샷마다 planViewSync 로
// dispose(탭 사라짐·워크스페이스 밖) / detachSessions(attach 안 하는 세션 전부 —
// fire-and-forget 스윕, 부트 첫 스냅샷 포함) / visible(pane 별 표시 탭)을 집행한다.
//
// 터미널 스크롤 기억 (ADR-0019): 워크스페이스를 떠나 dispose 되는 터미널 뷰의
// 스크롤 위치(하단 기준 줄 수)를 탭별로 들고 있다가, 돌아와 뷰를 새로 만들 때
// 1회성으로 넘긴다. WebView 수명 한정이다 — F5·자동 리로드 뒤에는 기억이 없고,
// 그것이 "같은 WebView 수명"의 자연스러운 경계다.
//
// 뷰어 뷰 수명 (21단계): 시맨틱이 반대라(활성 탭만 마운트 — viewer-view.ts)
// 병렬 레지스트리 viewerViews 를 두고 planViewerSync 로 집행한다. 두 레지스트리의
// 키는 겹치지 않는다 — 셸이 끝난 터미널 탭도 뷰어로 마운트되지만(기록 뷰,
// ADR-0018) 그 전이에서 planViewSync 가 터미널 뷰를 먼저 dispose 한다.
// dispose 시 탭이 아직 스냅샷에 남아 있으면(단순 unmount) flushScroll 로 스크롤을
// 모델에 남기고, 탭 자체가 사라졌으면 flush 없이 바로 내린다 — 없는 탭에 setViewerScroll 을
// 보내면 unknownTarget 잡음이 되기 때문이다.
//
// focus 보상 경로 (계획 D7 — attach 자동 focus 제거의 대가): pendingFocus 1칸을
// 두고 ① 부트/리로드 첫 리컨실 후 활성 pane 의 뷰, ② main.dispatchUI 가
// requestFocus 로 넘긴 대상(TabCreated/PaneCreated 의 새 탭, ActivateTab 탭,
// FocusPane 의 pane)을 렌더 후 해소한다. 요청 즉시도 1회 시도한다 — state-changed
// 이벤트가 invoke 응답보다 먼저 처리돼 렌더가 이미 끝난 경우가 있기 때문이다.
//
// split 컨테이너 자식 구조 불변식: [first, splitter.handle, second] — syncRatios
// 의 children 0/2 접근과 buildNode 의 append 순서가 이 불변식을 공유한다.
//
// send-mode (17단계): 패널 간 텍스트 전달의 대상 선택 모드를 여기서 소유한다 —
// pane·뷰 레지스트리 접근을 모두 가진 곳이라 소스 arm(pane-view 아이콘 경유)
// → 대상 resolve(pane mousedown 경유) → 대상 pane 표시 뷰로 paste/submit 실행
// 까지 응집된다. 상태 머신은 send-mode.ts (순수), 상태 라인 프롬프트·에러는
// main 의 SendStatus 계약으로 위임한다. Esc 취소는 모드 활성 중에만 window
// keydown capture 를 걸었다 뗀다 (상시 리스너 금지 — 평시 Esc 는 PTY 소유).

import { activeWorkspace } from "./keys";
import { detachTerminal } from "./backend";
import { ChangesView } from "./changes-view";
import { FolderView } from "./folder-view";
import type { PaneRect } from "./keys";
import { MarkdownView } from "./markdown-view";
import { PaneView } from "./pane-view";
import { RecordView } from "./record-view";
import type { SendController, ViewRegistry, ViewerRegistry } from "./pane-view";
import { ScrollMemory } from "./scroll-memory";
import { SendMode, sendModePrompt } from "./send-mode";
import { Splitter } from "./splitter";
import type { DragGuard } from "./splitter";
import { flexPair, structureKey } from "./split-layout";
import type { SwitchTracer } from "./switch-trace";
import { TerminalView } from "./terminal/view";
import { TextView } from "./text/view";
import type { ViewerView } from "./viewer-view";
import { existingTabIds, planViewSync, planViewerSync } from "./view-reconcile";
import type { VisibleView, VisibleViewer } from "./view-reconcile";
import type {
  Command,
  CommandOutput,
  PaneId,
  SessionId,
  SplitId,
  SplitTree,
  StateSnapshot,
  TabId,
  Workspace,
} from "./types";

type DispatchFn = (cmd: Command) => Promise<CommandOutput | null>;

/** focus 보상 대상 (계획 D7). "pane" 은 그 pane 의 표시 중 뷰를 뜻한다 —
 *  FocusPane 은 cmd 에 pane 이 있어 activePane 스냅샷 도착을 기다릴 필요가 없다. */
export type FocusRequest =
  | { kind: "tab"; tab: TabId }
  | { kind: "pane"; pane: PaneId }
  /** 렌더 시점의 활성 워크스페이스 activePane — CloseTab/ClosePane 처럼 "닫힌 뒤
   *  어디가 남는지"를 스냅샷이 알려줘야 하는 보상에 쓴다. */
  | { kind: "activePane" };

/** 상태 라인 접근 계약 (17단계) — 구현·소유자는 main.App 이다. 지속 프롬프트
 *  (setPrompt)는 one-shot 에러(flashError)와 별개 슬롯이다: send-mode 활성 동안
 *  유지되고, 해제 시 null 로 기본 표시가 복원된다. */
export interface SendStatus {
  setPrompt(text: string | null): void;
  flashError(text: string): void;
}

function collectLeaves(tree: SplitTree, out: Set<PaneId>): void {
  if (tree.type === "leaf") {
    out.add(tree.pane);
    return;
  }
  collectLeaves(tree.first, out);
  collectLeaves(tree.second, out);
}

export class WorkspaceView {
  private readonly paneViews = new Map<PaneId, PaneView>();
  private readonly splitContainers = new Map<SplitId, HTMLElement>();
  private splitters: Splitter[] = [];
  private readonly activeDrags = new Set<SplitId>();
  private lastKey: string | null = null;
  private lastSnapshot: StateSnapshot | null = null;

  /** 탭별 keep-alive 터미널 뷰 — 앱 수준 레지스트리 (계획 D3). */
  private readonly views = new Map<TabId, TerminalView>();
  /** 탭별 뷰어 뷰 — 활성 탭만 들어 있는 병렬 레지스트리 (21단계, 파일 상단). */
  private readonly viewerViews = new Map<TabId, ViewerView>();
  /** 워크스페이스를 떠난 터미널 탭의 스크롤 위치 (ADR-0019 — 파일 상단).
   *  수명 규칙(1회성 인출·프룬)은 순수 클래스가 들고 테스트가 잠근다. */
  private readonly scrollMemory = new ScrollMemory();
  /** 보상 focus 보류 1칸. rendersLeft: 미해소 렌더가 이만큼 지나면 stale 로
   *  폐기한다 — invoke 응답이 앞선 무관 이벤트 렌더보다 먼저 처리되는 race 에서
   *  구 revision 렌더가 보상을 조기 폐기하지 않게 하면서(리뷰 finding), 닫힌 탭
   *  대상 요청이 영구 보류로도 남지 않게 한다. */
  private pendingFocus: { req: FocusRequest; rendersLeft: number } | null = null;
  /** detach 스윕 전이 추적 — 직전 렌더에서 이미 미부착이던 세션은 재스윕하지
   *  않는다 (멱등이지만 매 revision 반복 invoke 는 잡음 — 리뷰 finding). */
  private sweptSessions = new Set<SessionId>();
  /** 부트 보상 focus 를 첫 리컨실(워크스페이스 존재) 1회로 제한하는 래치. */
  private booted = false;

  private readonly guard: DragGuard = {
    begin: (id) => this.activeDrags.add(id),
    end: (id) => this.activeDrags.delete(id),
  };

  /** PaneView 에 내려주는 레지스트리 접근 계약 — 생성(lazy attach)·조회만 노출,
   *  dispose 는 리컨실(render)이 독점한다. */
  private readonly registry: ViewRegistry = {
    get: (tab) => this.views.get(tab),
    ensure: (tab, session, parent, onAttachError) => this.ensureView(tab, session, parent, onAttachError),
  };

  /** 뷰어 뷰 레지스트리 접근 계약 (21단계) — 터미널과 같은 규약이다: 생성·조회만
   *  노출하고 dispose 는 리컨실(render)이 독점한다. */
  private readonly viewerRegistry: ViewerRegistry = {
    get: (tab) => this.viewerViews.get(tab),
    ensure: (target, parent) => this.ensureViewerView(target, parent),
  };

  /** splitter 의 dispatch 실패·pointercancel 복원 콜백 — 최신 채택 스냅샷의
   *  ratio 를 재적용한다 (프리뷰 잔재 제거). 구조가 그새 바뀌었어도 syncRatios
   *  는 현존 컨테이너만 만지므로 안전하다. */
  private readonly restoreRatios = (): void => {
    const snapshot = this.lastSnapshot;
    if (snapshot === null) return;
    const ws = activeWorkspace(snapshot);
    if (ws !== null) this.syncRatios(ws.layout);
  };

  /** 패널 간 텍스트 전달 상태 머신 (17단계 — 순수, send-mode.ts). */
  private readonly sendMode = new SendMode();
  /** send-mode Esc capture 설치 여부 — 모드 활성 중에만 리스너를 유지한다. */
  private sendEscInstalled = false;

  /** PaneView 에 내려주는 send-mode 접근 계약 — arm/resolve 후의 UI 동기화
   *  (프롬프트·Esc·커서 클래스)는 전부 여기(소유자)로 모인다. */
  private readonly sendCtl: SendController = {
    isActive: () => this.sendMode.active,
    arm: (source, text, submit) => {
      this.sendMode.arm(
        source,
        text,
        submit,
        this.lastSnapshot?.state.activeWorkspace ?? null,
      );
      this.syncSendUi();
    },
    resolve: (target) => this.resolveSend(target),
    flashError: (message) => this.sendStatus.flashError(message),
  };

  /** send-mode Esc 취소 (17단계 D2) — 모드 활성 중에만 window capture 로 설치
   *  된다 (syncSendUi). xterm 포커스보다 먼저 잡아 PTY 로 새지 않게 한다. */
  private readonly onSendEsc = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    this.sendMode.cancel();
    this.syncSendUi();
  };

  constructor(
    private readonly rootEl: HTMLElement,
    private readonly dispatch: DispatchFn,
    /** 전환 지연 tracer (14단계) — ensureView 의 새 attach 를 계측 대상으로
     *  등록한다. trace 미진행 시 markAttachStart 가 즉시 false 라 오버헤드 없음. */
    private readonly tracer: SwitchTracer,
    /** 상태 라인 위임 (17단계) — send-mode 프롬프트·에러 표면화. */
    private readonly sendStatus: SendStatus,
  ) {}

  /** send-mode 상태 → UI 동기화: rootEl 클래스(커서·하이라이트), 상태 라인
   *  프롬프트(활성 동안 유지·해제 시 복원), Esc capture 설치/해제. */
  private syncSendUi(): void {
    const active = this.sendMode.active;
    this.rootEl.classList.toggle("send-mode", active);
    this.sendStatus.setPrompt(sendModePrompt(this.sendMode.state));
    if (active !== this.sendEscInstalled) {
      if (active) {
        window.addEventListener("keydown", this.onSendEsc, { capture: true });
      } else {
        window.removeEventListener("keydown", this.onSendEsc, { capture: true });
      }
      this.sendEscInstalled = active;
    }
  }

  /** 대상 확정 → 전달 실행 (17단계 D1·D3). deliver=false(자기 자신 등)는 취소.
   *  대상 pane 의 표시 뷰가 터미널이 아니면(빈 pane·뷰어 탭) 상태 라인 에러 —
   *  shownTab 이 있으면 레지스트리에 attach 된 TerminalView 가 반드시 있다
   *  (planViewSync 의 visible 판정이 terminal+session 탭만 내려준다). */
  private resolveSend(target: PaneId): void {
    const result = this.sendMode.resolve(target);
    this.syncSendUi();
    // 대상 확정 mousedown 의 후속 click 1회를 삼킨다 — 같은 제스처의 click 이
    // 대상 pane 의 탭 활성화·전달 아이콘 등 다른 핸들러로 흘러들지 않게.
    this.swallowGestureClick();
    if (!result.deliver) return;
    const shown = this.paneViews.get(target)?.shownTab ?? null;
    const view = shown === null ? undefined : this.views.get(shown);
    if (shown === null || view === undefined) {
      this.sendStatus.flashError("cannot send: target pane has no terminal");
      return;
    }
    // exited 대상은 write 가 백엔드에서 실패해 조용히 증발한다 (리뷰 finding) —
    // 스냅샷의 탭 status 로 사전 판정해 표면화한다.
    if (!this.isRunningTerminalTab(target, shown)) {
      this.sendStatus.flashError("cannot send: target terminal has exited");
      return;
    }
    // replay 게이트가 닫혀 있으면 paste 는 유실되고 submit CR 만 통과하는 비대칭이
    // 생긴다 (리뷰 finding) — 둘 다 스킵하고 에러로 드러낸다.
    if (!view.canAcceptSend()) {
      this.sendStatus.flashError("cannot send: target terminal is still attaching");
      return;
    }
    // 여러 줄 + 비-bracketed 대상이면 중간 라인들이 그대로 실행된다 (리뷰
    // finding — paste 경로가 막는 건 stray ESC[200~ 이지 라인 실행이 아니다).
    // 대상 xterm 이 모드를 추적하므로 여기서 검출해 거부한다.
    if (/[\r\n]/.test(result.text) && !view.bracketedPaste()) {
      this.sendStatus.flashError(
        "cannot send multi-line: target is not in bracketed paste mode (lines would run)",
      );
      return;
    }
    view.paste(result.text);
    if (result.submit) view.submit();
  }

  /** 대상 pane 의 표시 탭이 실행 중 터미널인지 — 최신 채택 스냅샷 기준. */
  private isRunningTerminalTab(pane: PaneId, tab: TabId): boolean {
    const snapshot = this.lastSnapshot;
    if (snapshot === null) return false;
    const ws = activeWorkspace(snapshot);
    const found = ws?.panes[String(pane)]?.tabs.find((t) => t.id === tab);
    return found !== undefined
      ? found.kind.type === "terminal" && found.kind.status.type === "running"
      : false;
  }

  /** 진행 중 제스처(mousedown 은 이미 pane capture 에서 소비)의 click 1회를
   *  window capture 에서 삼킨다. click 이 끝내 오지 않는 경우(창 밖 mouseup)를
   *  대비해 다음 mousedown(새 제스처)에서도 해제한다 — 리스너 잔류 금지. */
  private swallowGestureClick(): void {
    const cleanup = (): void => {
      window.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("mousedown", onNextGesture, { capture: true });
      window.removeEventListener("keydown", onNextGesture, { capture: true });
    };
    const onClick = (ev: MouseEvent): void => {
      ev.preventDefault();
      ev.stopPropagation();
      cleanup();
    };
    const onNextGesture = (): void => cleanup();
    // 현재 이벤트는 이미 window capture 단계를 지났으므로 지금 걸어도 현재
    // mousedown 에는 발화하지 않는다 — 다음 이벤트부터 유효하다. keydown 도
    // 클린업 신호다 (리뷰 finding): mouseup 이 창 밖에서 일어나 click 이 안 온
    // 채로 키보드 유발 click(포커스된 버튼의 Enter/Space)이 오면 오흡수된다.
    window.addEventListener("click", onClick, { capture: true });
    window.addEventListener("mousedown", onNextGesture, { capture: true });
    window.addEventListener("keydown", onNextGesture, { capture: true });
  }

  /** 스냅샷 반영 진입점 — store 구독에서 revision 순으로 호출된다. */
  render(snapshot: StateSnapshot): void {
    this.lastSnapshot = snapshot;

    // keep-alive 리컨실 — 구조 렌더보다 먼저: dispose 로 뷰가 정리된 뒤에
    // updatePanes 가 가시성·lazy attach 를 만진다 (계획 D3·D4-b).
    const plan = planViewSync(this.views.keys(), snapshot);
    const existing = existingTabIds(snapshot);
    for (const tab of plan.dispose) {
      const view = this.views.get(tab);
      this.views.delete(tab);
      if (view === undefined) continue;
      // 기억 실패가 dispose 를 건너뛰게 두지 않는다 — 해제되지 않은 뷰는 채널을
      // 물고 남아 세션이 paused 에 고착된다 (TerminalView.dispose 주석).
      try {
        // 탭이 스냅샷에 아직 있으면 워크스페이스 이탈이라 돌아올 자리가 있다 —
        // 스크롤 위치를 기억한다 (ADR-0019). 사라진 탭(닫힘)은 기억하지 않는다.
        if (existing.has(tab)) {
          const offset = view.rememberedScrollOffset();
          if (offset !== null) this.scrollMemory.remember(tab, offset);
        }
      } catch (err) {
        console.error("scroll offset capture failed", tab, err);
      }
      // 한 뷰의 dispose 이상이 나머지 정리·렌더 전체를 중단시키지 않게 격리.
      try {
        view.dispose();
      } catch (err) {
        console.error("view dispose failed", tab, err);
      }
    }
    // 사라진 탭의 기억은 매 렌더 걷는다 — 비활성 워크스페이스에서 닫힌 탭은
    // dispose 루프를 타지 않아 여기서만 정리된다.
    this.scrollMemory.prune(existing);
    const unattached = new Set(plan.detachSessions);
    for (const session of plan.detachSessions) {
      // fire-and-forget 스윕 (멱등) — 부트 첫 스냅샷 포함. F5 후 미방문 탭
      // 세션의 죽은 채널이 paused 에 고착되는 것을 여기서 치운다 (D4-b).
      // 직전 렌더에서 이미 미부착이던 세션은 건너뛴다 — 전이 시점 1회면 충분
      // (매 revision 반복 invoke 잡음 방지, 리뷰 finding).
      if (this.sweptSessions.has(session)) continue;
      void detachTerminal(session).catch((err) =>
        console.error("detach sweep failed", session, err),
      );
    }
    this.sweptSessions = unattached;

    // 뷰어 리컨실 (21단계) — 터미널과 같은 자리에서, 같은 이유로 구조 렌더보다
    // 먼저 돈다. 마운트는 updatePanes 가 pane 별로 수행한다.
    const viewerPlan = planViewerSync(this.viewerViews.keys(), snapshot);
    for (const item of viewerPlan.dispose) {
      const view = this.viewerViews.get(item.tab);
      this.viewerViews.delete(item.tab);
      if (view === undefined) continue;
      // 한 뷰의 정리 이상이 나머지 정리·렌더 전체를 중단시키지 않게 격리.
      try {
        // 탭이 아직 있으면 단순 unmount — 스크롤을 모델에 남긴다. 탭이 사라진
        // 경우의 flush 는 unknownTarget 잡음이라 건너뛴다 (파일 상단).
        if (item.tabExists) view.flushScroll();
        view.dispose();
      } catch (err) {
        console.error("viewer dispose failed", item.tab, err);
      }
    }

    const ws = activeWorkspace(snapshot);

    // send-mode 수명 가드 (17단계 리뷰 finding): armed 워크스페이스를 떠났거나
    // 소스 pane 이 사라졌으면 자동 취소한다 — 방치하면 v1 이 제외한 워크스페이스
    // 간 전달이 우회로로 열리고, 전환 직후의 재-attach 경합 창과 겹친다.
    const sm = this.sendMode.state;
    if (sm.type === "armed") {
      const sourceAlive =
        ws !== null && Object.prototype.hasOwnProperty.call(ws.panes, String(sm.source));
      if (snapshot.state.activeWorkspace !== sm.workspace || !sourceAlive) {
        this.sendMode.cancel();
        this.syncSendUi();
      }
    }

    if (ws === null) {
      this.clear();
      this.rootEl.textContent = "(no workspace)";
      return;
    }

    const key = structureKey(ws.layout);
    if (key !== this.lastKey) {
      this.rebuild(ws.layout);
      this.lastKey = key;
    } else {
      this.syncRatios(ws.layout);
    }
    this.updatePanes(ws, plan.visible, viewerPlan.mount);

    // 부트/리로드 보상 focus (D7) — 첫 리컨실 후 활성 pane 의 뷰 1곳.
    if (!this.booted) {
      this.booted = true;
      if (this.pendingFocus === null) {
        this.pendingFocus = { req: { kind: "pane", pane: ws.activePane }, rendersLeft: 1 };
      }
    }
    this.tryResolveFocus(true);
  }

  /** focus 보상 요청 (main.dispatchUI 성공 경로 — 계획 D7). 즉시 1회 시도하고,
   *  대상이 아직 없으면(스냅샷 미도착) 다음 render 가 해소한다. */
  requestFocus(req: FocusRequest): void {
    // rendersLeft 3: 명령 결과 스냅샷보다 앞선 무관 이벤트 렌더가 1~2개 끼어도
    // 보상이 살아남고, 정말 stale 한 요청(대상 탭이 닫힘)은 몇 렌더 안에 폐기된다.
    this.pendingFocus = { req, rendersLeft: 3 };
    // activePane 류는 즉시 해소하지 않는다 (리뷰 finding) — invoke 응답이 명령의
    // 스냅샷보다 먼저 처리되는 순서에서는 lastSnapshot 이 아직 명령 이전 상태라,
    // 전환 전 워크스페이스의 activePane 을 focus 하고 보상을 소진해 버린다.
    // 대상이 명시된 tab/pane 류만 즉시 시도한다 (그 대상은 stale 스냅샷에서도
    // 동일 객체다).
    if (req.kind !== "activePane") this.tryResolveFocus(false);
  }

  /** 현재 렌더된 pane 들의 화면 기하 (20단계) — 키보드 pane 이동(Ctrl+Shift+방향키)의
   *  방향 판정 재료다. 레이아웃 트리를 걷지 않고 pane DOM 의 실측 rect 를 쓴다:
   *  중첩 split 의 시각 배치를 트리 순회로 재구성하는 것보다 정확하고, 판정
   *  (keys.paneInDirection)이 순수 함수로 남는다. paneViews 는 활성 워크스페이스
   *  의 레이아웃에 있는 pane 만 담는다 (rebuild 가 이탈 pane 을 지운다). */
  paneRects(): PaneRect[] {
    const out: PaneRect[] = [];
    for (const [pane, view] of this.paneViews) {
      const rect = view.root.getBoundingClientRect();
      out.push({ pane, x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    }
    return out;
  }

  /** pendingFocus 해소 시도. atRender 면 미해소마다 rendersLeft 를 줄이고 0 이
   *  되면 폐기한다 (stale 요청이 보류로 영구히 남지 않게). */
  private tryResolveFocus(atRender: boolean): void {
    const pending = this.pendingFocus;
    if (pending === null) return;
    const view = this.focusTarget(pending.req);
    if (view !== null) {
      view.focus();
      this.pendingFocus = null;
      return;
    }
    if (atRender && --pending.rendersLeft <= 0) this.pendingFocus = null;
  }

  /** 요청 → focus 할 뷰. 숨은 뷰는 대상이 아니다 (display:none 은 focus 불가) —
   *  표시 여부는 pane 의 shownTab 으로 판정한다. 뷰어 뷰도 대상이다 (21단계):
   *  둘 다 focus() 를 가지므로 20단계 키보드 내비·D7 보상이 뷰어 탭에서도
   *  그대로 성립한다 — 기록 뷰(ADR-0018)까지 포함해서다. 두 레지스트리는 키가
   *  겹치지 않아 순서 의존이 없다: 한 탭이 터미널 뷰와 기록 뷰를 동시에 갖는
   *  중간 상태는 planViewSync 의 dispose 가 닫는다 (view-reconcile 상단). */
  private focusTarget(req: FocusRequest): TerminalView | ViewerView | null {
    if (req.kind === "activePane") {
      const ws = this.lastSnapshot === null ? null : activeWorkspace(this.lastSnapshot);
      if (ws === null) return null;
      return this.focusTarget({ kind: "pane", pane: ws.activePane });
    }
    if (req.kind === "pane") {
      const paneView = this.paneViews.get(req.pane);
      const shown = paneView?.shownTab ?? null;
      if (shown === null) return null;
      return this.views.get(shown) ?? this.viewerViews.get(shown) ?? null;
    }
    const view = this.views.get(req.tab) ?? this.viewerViews.get(req.tab);
    if (view === undefined) return null;
    for (const paneView of this.paneViews.values()) {
      if (paneView.shownTab === req.tab) return view;
    }
    return null;
  }

  /** 레지스트리 ensure 구현 — 없으면 생성 + lazy attach. attach 실패는 가리지
   *  않는다: 뷰를 정리하고 onAttachError 로 pane 에 노출한다 (다음 스냅샷 렌더가
   *  자연 재시도한다 — revision 변화 때만이라 폭주하지 않는다). */
  private ensureView(
    tab: TabId,
    session: SessionId,
    parent: HTMLElement,
    onAttachError: (message: string) => void,
  ): TerminalView {
    const existing = this.views.get(tab);
    if (existing !== undefined) {
      // 같은 탭이라도 세션이 바뀌었으면(Retry 로 재스폰) 옛 뷰는 이미 죽은 세션에
      // 붙어 있다. 그대로 재사용하면 상태는 running 으로 돌아가 배너만 걷히고 화면과
      // 입력은 계속 죽은 채로 남는다 — 빈 탭에서 Retry 를 누르는 핵심 경로가 성공한
      // 것처럼 보이면서 아무것도 고쳐지지 않는다.
      if (existing.session === session) return existing;
      existing.dispose();
      this.views.delete(tab);
    }
    // 전환 계측 (14단계): 진행 중 trace 가 이 탭의 새 attach 를 수락한 경우에만
    // replay 완료 훅을 단다 — keep-alive 재사용(위 early return)은 replay 왕복이
    // 없어 계측 대상이 아니다. attach 가 실패하면 trace 는 완주하지 못하고 다음
    // begin 이 폐기한다 (실패 자체는 아래 catch 가 별도로 노출한다).
    let onTraceReplayDone: ((bytes: number) => void) | undefined;
    if (this.tracer.markAttachStart(tab, performance.now())) {
      onTraceReplayDone = (bytes) => this.tracer.markReplayDone(tab, bytes, performance.now());
    }
    // 스크롤 기억은 1회성이다 (ADR-0019 — take 가 꺼내면서 지운다).
    const created = new TerminalView(
      parent,
      session,
      onTraceReplayDone,
      this.scrollMemory.take(tab),
    );
    this.views.set(tab, created);
    created.attach().catch((err) => {
      console.error("attach_terminal failed", err);
      if (this.views.get(tab) !== created) return; // 이미 리컨실로 정리됨
      created.dispose();
      this.views.delete(tab);
      onAttachError(`attach failed (session ${session}): ${String(err)}`);
    });
    return created;
  }

  /** 뷰어 레지스트리 ensure 구현 (21단계) — 없으면 생성해 parent 에 마운트한다.
   *  distro 는 최신 채택 스냅샷의 활성 워크스페이스 값이다 (없으면 null — 글루가
   *  MAST_DISTRO·기본 배포판 순으로 해석한다). Changes 뷰어까지 네 종류가 모두
   *  착지해
   *  실제로 null 을 돌리는 경로는 없다 — 반환 타입의 null 은 pane 의 placeholder
   *  안전망(계약)으로 남긴다. */
  private ensureViewerView(target: VisibleViewer, parent: HTMLElement): ViewerView | null {
    const existing = this.viewerViews.get(target.tab);
    if (existing !== undefined) return existing;
    const ws = this.lastSnapshot === null ? null : activeWorkspace(this.lastSnapshot);
    const distro = ws?.distro ?? null;
    let created: ViewerView;
    switch (target.kind.type) {
      case "terminal":
        // 셸이 끝난 탭 — 기록 파일이 화면 재료이고 distro·dispatch 가 필요 없다
        // (ADR-0018). 뷰어 레지스트리에 사는 이유는 viewer-view.ts 참조.
        created = new RecordView(parent, target.tab);
        break;
      case "folderBrowser":
        created = new FolderView(
          parent,
          target.tab,
          target.pane,
          distro,
          target.kind,
          this.dispatch,
        );
        break;
      case "textViewer":
        created = new TextView(parent, target.tab, distro, target.kind, this.dispatch);
        break;
      case "markdownViewer":
        created = new MarkdownView(
          parent,
          target.tab,
          // 2MiB 초과 시의 "open as text" 탭이 이 pane 에 들어간다.
          target.pane,
          distro,
          target.kind,
          this.dispatch,
        );
        break;
      case "changesViewer":
        created = new ChangesView(parent, target.tab, distro, target.kind);
        break;
    }
    this.viewerViews.set(target.tab, created);
    return created;
  }

  /** 구조 재구축 — pane 뷰는 레지스트리 재사용, 이탈 pane 은 dispose.
   *  (터미널 뷰 수명은 planViewSync 소유 — pane dispose 는 DOM·observer 만.) */
  private rebuild(tree: SplitTree): void {
    const keep = new Set<PaneId>();
    collectLeaves(tree, keep);
    for (const [id, view] of this.paneViews) {
      if (!keep.has(id)) {
        view.dispose();
        this.paneViews.delete(id);
      }
    }
    for (const s of this.splitters) s.dispose();
    this.splitters = [];
    this.splitContainers.clear();

    const built = this.buildNode(tree);
    // 루트는 #view(flex)를 꽉 채운다 — 중첩에서 승격된 엘리먼트의 stale
    // inline flex 를 확정값으로 덮는다.
    built.style.flex = "1 1 0px";
    this.rootEl.replaceChildren(built);
  }

  private buildNode(tree: SplitTree): HTMLElement {
    if (tree.type === "leaf") {
      let view = this.paneViews.get(tree.pane);
      if (view === undefined) {
        view = new PaneView(
          tree.pane,
          this.dispatch,
          this.registry,
          this.viewerRegistry,
          this.sendCtl,
        );
        this.paneViews.set(tree.pane, view);
      }
      return view.root; // 기존 뷰는 append 시 자동 reparent 된다
    }

    const container = document.createElement("div");
    container.className = `split split-${tree.direction}`;
    const first = this.buildNode(tree.first);
    const second = this.buildNode(tree.second);
    const splitter = new Splitter({
      container,
      splitId: tree.id,
      direction: tree.direction,
      first,
      second,
      guard: this.guard,
      dispatch: this.dispatch,
      restore: this.restoreRatios,
    });
    this.applyRatio(first, second, tree.ratio);
    container.append(first, splitter.handle, second); // 자식 구조 불변식 (파일 상단)
    this.splitContainers.set(tree.id, container);
    this.splitters.push(splitter);
    return container;
  }

  /** ratio in-place 갱신 — 드래그 활성 split 은 건너뛴다 (D2 가드). */
  private syncRatios(tree: SplitTree): void {
    if (tree.type === "leaf") return;
    if (!this.activeDrags.has(tree.id)) {
      const container = this.splitContainers.get(tree.id);
      if (container !== undefined) {
        const first = container.children.item(0);
        const second = container.children.item(2);
        if (first instanceof HTMLElement && second instanceof HTMLElement) {
          this.applyRatio(first, second, tree.ratio);
        }
      }
    }
    this.syncRatios(tree.first);
    this.syncRatios(tree.second);
  }

  private applyRatio(first: HTMLElement, second: HTMLElement, ratio: number): void {
    const pair = flexPair(ratio);
    // basis 0 고정 — 핸들(4px)을 제외한 공간이 grow 비율로만 나뉜다.
    first.style.flex = `${pair.first} 1 0px`;
    second.style.flex = `${pair.second} 1 0px`;
  }

  private updatePanes(
    ws: Workspace,
    visible: VisibleView[],
    mountViewers: VisibleViewer[],
  ): void {
    const visibleByPane = new Map<PaneId, VisibleView>();
    for (const entry of visible) visibleByPane.set(entry.pane, entry);
    const viewerByPane = new Map<PaneId, VisibleViewer>();
    for (const entry of mountViewers) viewerByPane.set(entry.pane, entry);
    for (const [id, view] of this.paneViews) {
      // panes 맵 키는 문자열 숫자 (JSON object 키 제약 — types.ts 참조).
      const pane = ws.panes[String(id)];
      if (pane === undefined) {
        // 코어 불변식(트리 leaf ⊆ panes 키)상 도달 불가 — 가리지 않고 노출.
        console.error("pane in layout but missing from panes map", id);
        continue;
      }
      view.update(
        pane,
        id === ws.activePane,
        visibleByPane.get(id) ?? null,
        viewerByPane.get(id) ?? null,
      );
    }
  }

  /** 전체 해제 — 워크스페이스 부재(no workspace) 상태 전환용. 터미널·뷰어 뷰
   *  레지스트리는 여기 오기 전에 이미 비어 있다 — render 의 리컨실이 먼저 돌고,
   *  활성 워크스페이스가 없으면 alive 탭 전부가 dispose 목록에 떨어지기 때문. */
  private clear(): void {
    for (const view of this.paneViews.values()) view.dispose();
    this.paneViews.clear();
    for (const s of this.splitters) s.dispose();
    this.splitters = [];
    this.splitContainers.clear();
    this.activeDrags.clear();
    // pendingFocus 는 유지한다 (리뷰 finding) — 명령 응답과 그 스냅샷 사이에
    // ws-null 렌더가 끼는 경로(마지막 워크스페이스 닫기 직후 재생성 등)에서
    // 보상이 살아남아야 한다. stale 요청은 rendersLeft 가 정리한다.
    this.lastKey = null;
    this.rootEl.replaceChildren();
  }
}
