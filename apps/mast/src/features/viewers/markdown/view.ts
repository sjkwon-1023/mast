import { markdownDraft, keepMarkdownDraft, discardMarkdownDraft, markdownSaved, onMarkdownSaved } from "./drafts";
// markdownViewer 탭의 뷰 — 마크다운 파일을 렌더해 보여주고, 활성인 동안
// 2초 주기 mtime 폴링으로 라이브 리로드한다.
//
// 이 파일의 세 계약이 나머지를 지배한다.
//
// 1. **raw HTML 은 전부 escape 한다** (보안 필수 — 옵션이 아니다). 이 WebView 는
//    dispatch·fs_* IPC 를 쥐고 있어서, 파일 내용에서 온 HTML 이 DOM 에 그대로
//    들어가면 마크다운 파일 하나가 앱 전체 권한을 갖는다. 그래서 marked 의
//    renderer 를 덮어 ① html 토큰(블록·인라인 둘 다)을 텍스트로 강등하고,
//    ② 링크는 `href` 자체를 만들지 않으며(대상은 title 로만 보여준다),
//    ③ 이미지는 placeholder 텍스트로 바꾼다 — 렌더 결과에 원격 로드도 실행
//    가능한 URL 도 남지 않는다. 판정은 순수 함수 renderMarkdown 이라 vitest 로
//    잠근다.
// 2. UTF-8 마크다운에 한해 원문 편집·저장을 제공한다. 2MiB 를 넘는 파일은
//    렌더·편집을 거부하고 "open as text" 안내만 준다.
//    마크다운 렌더는 파일 전체를 문자열로 올려야 해서 textViewer 의 윈도우 전략
//    (메모리 상주 = 창 1개)이 성립하지 않기 때문이다.
// 3. **폴링 수명 = 뷰 수명** (계획 21단계). 뷰어 뷰는 활성 탭일 때만 마운트되므로
//    (features/viewers/viewer-view.ts) 폴링 자체가 활성 탭 한정이고, 별도 게이팅이 필요 없다.
//    대신 dispose 에서 타이머·리스너·구독을 반드시 정리해야 하며(누수 금지),
//    창이 숨은 동안은 아예 무장하지 않는다 (숨은 창의 9P 왕복 0). 숨김 판정은
//    `document.hidden` **또는** 창 최소화(infrastructure/window-visibility.ts)다 — 체크포인트 2
//    실기에서 WebView2 가 최소화·Alt+Tab 에 visibilitychange 도 document.hidden 도
//    주지 않아 fs_stat 이 계속 나갔기 때문이다. 최소화만 숨김으로 치고 비포커스-
//    가시 상태는 폴링을 유지한다 (다른 창에서 .md 를 편집하며 미리보기를 보는 것이
//    핵심 사용례 — 근거는 infrastructure/window-visibility.ts). 상태기계는 DOM 무의존 클래스
//    MtimePoller 로 분리해 주입 타이머로 테스트한다 (ack-batcher 전례 — 이 레포에
//    setInterval 은 없다).
//
// 스크롤 왕복은 textViewer 의 인프라(ScrollSettle·shouldAdoptScroll)를 그대로
// 재사용한다. 단위만 다르다: textViewer 는 전역 byte offset, markdownViewer 는
// 렌더 컨테이너의 **px** 다 (모델 TabKind rustdoc 이 정본).
//
// 그 px 좌표가 **줌**(v0.3.8)과 정면으로 부딪힌다: 글자 크기가 바뀌면 산문이
// 리플로우돼 문서 전체 높이가 달라지므로 같은 px 가 다른 자리를 가리킨다. 그래서
// 이 뷰는 viewer-font 의 레지스트리에 등록해 크기가 바뀔 때 상대 위치 앵커로
// 화면을 되돌린다 (beforeViewerFontSize / setViewerFontSize).

import { Marked } from "marked";

import type { TimerHost } from "../../terminal/ack-batcher";
import { fsReadChunk, fsStat, fsSaveMarkdown } from "../../../infrastructure/backend";
import { ScrollSettle, SCROLL_SETTLE_MS, shouldAdoptScroll } from "../viewer-scroll";
import { registerViewerFontTarget, unregisterViewerFontTarget } from "../viewer-font";
import type { ViewerFontTarget } from "../viewer-font";
import { isWindowHidden, onWindowHiddenChange } from "../../../infrastructure/window-visibility";
import type { ViewerKind, ViewerView } from "../viewer-view";
import type { Command, CommandOutput, PaneId, TabId } from "../../../shared/types";

/** UI 발 dispatch — main.ts dispatchUI 래퍼 (실패는 상태 라인에 표면화되고 null). */
type DispatchFn = (cmd: Command) => Promise<CommandOutput | null>;

/** 렌더를 거부하는 크기 상한. 마크다운은 파일 전체를 문자열로 올려야 해서
 *  textViewer 의 윈도우 전략이 통하지 않는다 — 큰 파일은 텍스트로 열게 한다. */
export const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;

/** 라이브 리로드 폴링 주기. 9P 왕복 1회(fs_stat)라 2초면 체감 즉시에 가깝다. */
export const RELOAD_POLL_MS = 2000;

/** 로드 실패 후의 폴링 baseline — 실제 mtime 이 될 수 없는 값이라, 다음 성공
 *  stat 이 무조건 "변화"로 관측돼 자동 재로드를 건다 (실패 자가 회복 경로). */
export const RETRY_BASELINE_MS = -1;

const defaultTimers: TimerHost = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

/** 파일에서 온 문자열이 마크업으로 해석되지 않게 한다. 작은따옴표까지 덮는
 *  이유는 속성값(title)에도 쓰이기 때문이다. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** raw HTML·링크·이미지를 무해화한 marked 인스턴스 (파일 상단 계약 1).
 *  전역 `marked` 를 설정하지 않고 인스턴스를 따로 둔다 — 전역 설정은 다른
 *  모듈이 marked 를 쓰기 시작하는 순간 조용히 서로를 덮는다. */
const renderer = new Marked({
  renderer: {
    // 블록 html 토큰과 인라인 tag 토큰이 모두 여기로 온다 — 원문을 그대로
    // 텍스트로 보여준다 (<script> 는 화면에 `<script>` 라고 찍힌다).
    html({ text }) {
      return escapeHtml(text);
    },
    // href 를 아예 만들지 않는다: 클릭 무동작 계약이기도 하고, marked 는
    // `javascript:` 같은 스킴을 걸러주지 않으므로 href 를 두면 그 자체가 표면이
    // 된다. 대상은 title(툴팁)로만 보여준다.
    link({ href, tokens }) {
      return `<a class="md-link" title="${escapeHtml(href)}">${this.parser.parseInline(tokens)}</a>`;
    },
    // 이미지는 원격·로컬 로드를 하지 않고 placeholder 텍스트로 대체한다.
    image({ href, text }) {
      return `<span class="md-image">[image: ${escapeHtml(text.length > 0 ? text : href)}]</span>`;
    },
  },
});

/** 마크다운 원문 → 렌더된 HTML 문자열 (순수). 결과에는 raw HTML 도, href 를 가진
 *  앵커도, 외부 리소스 참조도 없다 — 그 사실을 features/viewers/markdown/view.test.ts 가 잠근다. */
export function renderMarkdown(source: string): string {
  return renderer.parse(source, { async: false });
}

export interface MtimePollerOptions {
  intervalMs?: number;
  /** 테스트 주입용 — 기본은 전역 setTimeout/clearTimeout. */
  timers?: TimerHost;
  /** true 인 동안 폴링을 멈춘다. 기본은 document.hidden. */
  isHidden?: () => boolean;
}

/** mtime 폴링 상태기계 (DOM·IPC 무의존 — vitest 대상).
 *
 *  setInterval 이 아니라 **주입형 setTimeout 체인**이다 (레포 전례): 응답이 늦은
 *  9P stat 이 겹쳐 쌓이지 않게 한 주기의 stat 이 끝난 뒤에야 다음 타이머를 건다.
 *  기준 mtime 과 다른 값이 관측되면 onChanged 를 부르고, 기준을 그 값으로 옮겨
 *  같은 변화로 두 번 발화하지 않는다. */
export class MtimePoller {
  private readonly intervalMs: number;
  private readonly timers: TimerHost;
  private readonly isHidden: () => boolean;
  private handle: unknown = null;
  private running = false;
  private disposed = false;
  private baseline: number | null = null;

  constructor(
    /** 한 주기의 mtime 조회 (epoch ms). */
    private readonly stat: () => Promise<number>,
    /** 기준과 다른 mtime 이 관측됐다 — 재렌더 트리거. */
    private readonly onChanged: (mtimeMs: number) => void,
    options: MtimePollerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? RELOAD_POLL_MS;
    this.timers = options.timers ?? defaultTimers;
    this.isHidden = options.isHidden ?? (() => document.hidden);
  }

  /** 로드가 끝날 때마다 불려 기준이 실제로 화면에 그려진 내용을 가리키게 한다. */
  start(baselineMs: number): void {
    if (this.disposed) return;
    this.baseline = baselineMs;
    this.running = true;
    this.arm();
  }

  /** visibilitychange 훅. start 전이면 아무 일도 하지 않는다 (아직 볼 문서가 없다). */
  sync(): void {
    if (this.disposed || !this.running) return;
    if (this.isHidden()) this.disarm();
    else this.arm();
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.disarm();
  }

  /** 테스트·진단용. */
  get armed(): boolean {
    return this.handle !== null;
  }

  private arm(): void {
    if (this.disposed || !this.running || this.handle !== null) return;
    // 재개는 sync() 가 한다.
    if (this.isHidden()) return;
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      void this.tick();
    }, this.intervalMs);
  }

  private disarm(): void {
    if (this.handle === null) return;
    this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  private async tick(): Promise<void> {
    if (this.disposed || !this.running) return;
    try {
      const mtimeMs = await this.stat();
      if (this.disposed || !this.running) return;
      if (this.baseline !== null && mtimeMs !== this.baseline) {
        this.baseline = mtimeMs;
        this.onChanged(mtimeMs);
      }
    } catch {
      // stat 실패는 폴링을 죽이지 않는다 — 에디터의 원자적 저장(rename)처럼
      // 파일이 잠깐 사라지는 경우가 흔하고, 다음 주기에 돌아오면 그때 재렌더
      // 된다. 실패 자체를 배너로 올리는 것은 로드 경로(load)의 몫이다.
    }
    this.arm();
  }
}

/** 로드 실패 payload 의 표시 문자열 — 글루는 `Result<_, String>` 이라 문자열이
 *  오지만, IPC 레벨 실패 등 계약 밖 값도 삼키지 않는다. */
function describeError(err: unknown): string {
  return typeof err === "string" ? err : String(err);
}

/** 순수 — 로케일에 기대지 않는다. */
function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export interface MarkdownViewOptions {
  /** 테스트 주입용 — 기본은 전역 setTimeout/clearTimeout. */
  timers?: TimerHost;
  settleMs?: number;
  pollMs?: number;
}

/** 지금 보고 있는 자리 → 문서 안 **상대 위치**(0~1) (순수).
 *
 *  줌 앞뒤를 잇는 유일한 좌표다 — px 는 리플로우로 무의미해지고, 이 뷰에는
 *  textViewer 의 행 인덱스 같은 안정 좌표가 없다. 스크롤 여지가 없으면(문서가
 *  뷰포트보다 짧다) 0 이다: 그때는 어차피 되돌릴 것이 없다. */
export function scrollAnchorRatio(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const max = scrollHeight - clientHeight;
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, scrollTop / max));
}

/** 상대 위치 → 리플로우 뒤의 scrollTop (순수, scrollAnchorRatio 의 역). 정수 px
 *  로 떨어뜨린다 — 소수 scrollTop 은 브라우저가 어차피 반올림해 되읽으므로
 *  기록·비교(ScrollSettle.markSynced)에서 어긋나지 않게 여기서 맞춘다. */
export function scrollTopForAnchor(
  ratio: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.round(Math.min(1, Math.max(0, ratio)) * max);
}

export class MarkdownView implements ViewerView, ViewerFontTarget {
  readonly root: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly scrollEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly settle: ScrollSettle;
  private readonly poller: MtimePoller;
  /** 창 숨김 전이 구독 해제 — dispose 에서 반드시 부른다 (구독자 수명 = 뷰 수명). */
  private readonly unsubscribeWindow: () => void;

  private readonly unsubscribeSaved: () => void;
  private readonly editButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly editor: HTMLTextAreaElement;
  private source: string | null = null;
  private editing = false;
  private saving = false;
  private path: string;
  private disposed = false;
  /** in-flight 로드 토큰 — 늦게 도착한 이전 로드가 현재 화면을 덮지 않게 한다. */
  private loadToken = 0;
  /** 에코 가드 상태 — shouldAdoptScroll 의 좌변. */
  private adopted: { path: string } | null = null;
  /** 렌더가 끝나면 적용할 px (마운트·경로 변경 시 1회). */
  private pendingScroll: number | null = null;
  /** 줌 직전에 붙든 화면 위치 — 스크롤 가능 범위 안의 **상대 위치**(0~1)다.
   *  setViewerFontSize 가 리플로우 뒤에 이 비율로 되돌리고 비운다. */
  private zoomAnchor: number | null = null;

  constructor(
    parent: HTMLElement,
    private readonly tab: TabId,
    /** "open as text" 로 만드는 textViewer 탭이 들어갈 pane — 같은 pane 이다
     *  (CreateTab 시맨틱상 새 탭이 곧바로 active 가 된다). */
    private readonly pane: PaneId,
    /** 워크스페이스 distro (없으면 null — 글루가 MAST_DISTRO·기본 배포판 순으로
     *  해석한다). 워크스페이스 생성 후 바뀌지 않는 값이라 생성 시 고정한다. */
    private readonly distro: string | null,
    kind: ViewerKind,
    private readonly dispatch: DispatchFn,
    options: MarkdownViewOptions = {},
  ) {
    this.path = kind.type === "markdownViewer" ? kind.path : "";
    this.adopted = { path: this.path };
    this.pendingScroll = kind.type === "markdownViewer" ? kind.scrollTop : 0;

    const timers = options.timers ?? defaultTimers;
    this.settle = new ScrollSettle(
      (px) => {
        void dispatch({ type: "setViewerScroll", tab: this.tab, scrollTop: px });
      },
      options.settleMs ?? SCROLL_SETTLE_MS,
      timers,
    );

    this.root = document.createElement("div");
    this.root.className = "markdown-view";

    this.bannerEl = document.createElement("div");
    this.bannerEl.className = "markdown-banner";
    this.bannerEl.hidden = true;

    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "markdown-scroll";
    // 스크롤 컨테이너 자체를 focus 대상으로 둔다 — 방향키·PgUp/PgDn 스크롤이
    // 미리보기에서는 브라우저 기본 동작으로 붙는다.
    // Tab 순서에는 넣지 않는다 (프로그램적 focus 전용).
    this.scrollEl.tabIndex = -1;
    this.scrollEl.addEventListener("scroll", this.onScroll);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "markdown-body";
    // 링크는 href 가 없어 이미 무동작이지만, 클릭 자체도 기본 동작을 끊는다
    // (계획 21단계 — 뷰어에서 문서 밖으로 나가는 경로를 만들지 않는다).
    this.bodyEl.addEventListener("click", this.onBodyClick);
    this.scrollEl.append(this.bodyEl);

    const toolbar = document.createElement("div");
    toolbar.className = "markdown-toolbar";
    const button = (label: string, className: string, action: () => void): HTMLButtonElement => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = className;
      element.textContent = label;
      element.addEventListener("click", action);
      toolbar.append(element);
      return element;
    };
    this.editButton = button("Edit", "markdown-edit", () => this.beginEdit());
    this.editButton.disabled = true;
    this.saveButton = button("Save", "markdown-save", () => void this.save());
    this.cancelButton = button("Cancel", "markdown-cancel", () => this.cancelEdit());
    this.saveButton.hidden = this.cancelButton.hidden = true;
    this.editor = document.createElement("textarea");
    this.editor.className = "markdown-editor";
    this.editor.setAttribute("aria-label", "Markdown source");
    this.editor.spellcheck = false;
    this.editor.hidden = true;
    this.editor.addEventListener("input", () => this.rememberDraft());
    this.editor.addEventListener("keydown", (event) => {
      if (!event.isComposing && event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void this.save();
      }
    });
    this.root.append(toolbar, this.bannerEl, this.scrollEl, this.editor);
    parent.appendChild(this.root);

    this.poller = new MtimePoller(
      async () => (await fsStat(this.distro, this.path)).mtime_ms,
      () => this.load(true),
      {
        intervalMs: options.pollMs ?? RELOAD_POLL_MS,
        timers,
        // 두 신호의 OR — WebView2 는 최소화에 visibilitychange 를 주지 않고,
        // 창 신호는 탭 숨김 같은 문서 레벨 사건을 모른다 (파일 상단 계약 3).
        isHidden: () => this.editing || document.hidden || isWindowHidden(),
      },
    );
    // 두 신호 모두 재개 트리거다 — sync() 가 현재 isHidden 을 다시 읽어 무장/
    // 해제를 정한다. 창 구독 해제 함수는 dispose 까지 들고 있는다 (누수 금지).
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.unsubscribeWindow = onWindowHiddenChange(this.onWindowHidden);
    // 해제는 dispose 가 짝으로 맡는다.
    registerViewerFontTarget(this);

    this.unsubscribeSaved = onMarkdownSaved((tab, content) => {
      if (tab === this.tab) this.source = content;
    });
    try {
      const draft = markdownDraft(this.tab);
      if (draft && draft.path === this.path && draft.distro === this.distro) {
        this.source = draft.base;
        this.beginEdit(draft.text, false);
      } else this.load(false);
    } catch (error) {
      this.setBanner(`Cannot restore draft: ${describeError(error)}`, true);
    }
  }

  private beginEdit(text?: string, focus = true): void {
    if (this.source === null || this.saving) return;
    this.editing = true;
    ++this.loadToken;
    this.poller.sync();
    this.editor.value = text ?? this.source;
    this.editor.hidden = false;
    this.scrollEl.hidden = true;
    this.editButton.hidden = true;
    this.saveButton.hidden = this.cancelButton.hidden = false;
    this.setBanner("Editing — Ctrl+S to save. Unsaved edits survive tab switches and WebView reloads.", false);
    if (focus) this.editor.focus();
  }

  private rememberDraft(): void {
    if (this.source === null) return;
    const previous = markdownDraft(this.tab);
    try {
      const base = previous?.base ?? this.source;
      if (this.editor.value === base.replace(/\r\n/g, "\n")) discardMarkdownDraft(this.tab);
      else keepMarkdownDraft(this.tab, { path: this.path, distro: this.distro, base, text: this.editor.value });
    } catch (error) {
      this.editor.value = previous?.text ?? this.source;
      this.setBanner(`This change was not accepted because draft backup failed. Save existing edits before continuing: ${describeError(error)}`, true);
    }
  }

  private async save(): Promise<void> {
    if (!this.editing || this.saving || this.source === null) return;
    const draft = markdownDraft(this.tab);
    const base = draft?.base ?? this.source;
    const text = this.editor.value;
    const content = base.includes("\r\n") && !base.replace(/\r\n/g, "").includes("\n")
      ? text.replace(/\r?\n/g, "\r\n") : text;
    this.saving = true;
    let written = false;
    this.editor.disabled = this.saveButton.disabled = this.cancelButton.disabled = true;
    try {
      await fsSaveMarkdown(this.distro, this.path, base, content);
      written = true;
      this.source = content;
      markdownSaved(this.tab, text, content);
      if (this.disposed) return;
      this.endEdit();
      this.load(true);
    } catch (error) {
      if (!this.disposed) this.setBanner(`${written ? "File saved, but draft cleanup failed" : "Could not save"}: ${describeError(error)}`, true);
    } finally {
      this.saving = false;
      this.editor.disabled = this.saveButton.disabled = this.cancelButton.disabled = false;
    }
  }

  private cancelEdit(): void {
    if (this.saving) return;
    if (markdownDraft(this.tab) && !window.confirm("Discard unsaved Markdown edits?")) return;
    discardMarkdownDraft(this.tab);
    this.endEdit();
    this.load(false);
  }

  private endEdit(): void {
    const hadFocus = this.root.contains(document.activeElement);
    this.editing = false;
    this.editor.hidden = true;
    this.scrollEl.hidden = false;
    this.editButton.hidden = false;
    this.saveButton.hidden = this.cancelButton.hidden = true;
    if (hadFocus) this.scrollEl.focus();
    this.poller.sync();
  }

  /** 줌 직전 — 지금 보고 있는 자리를 문서 안 **상대 위치**로 붙든다 (파일 상단
   *  주석의 px 좌표 문제). CSS 변수가 아직 옛 크기인 이 순간이 리플로우 전
   *  scrollHeight 를 읽을 수 있는 유일한 지점이다.
   *
   *  비율 앵커를 쓰는 이유: 줌은 문서를 통째로 균일하게 확대하므로 상대 위치가
   *  거의 그대로 보존된다. 뷰포트 최상단 요소를 찾아 그 offsetTop 을 맞추는 쪽이
   *  더 정확하지만, 이 뷰는 편집기가 아니라 읽기 표면이고 그 정확도 차이는 몇 줄
   *  수준이라 DOM 순회를 들이지 않는다.
   *
   *  붙들기 전에 flush 하는 이유는 창 이동 전 flush 와 같다 — 리플로우로 좌표가
   *  달라지기 전에 **줌 전 위치**를 모델에 확정해 둔다. 그 값이 재시작 때(설정
   *  크기로 그린 문서에서) 올바른 자리다. */
  beforeViewerFontSize(): void {
    if (this.disposed) return;
    this.settle.flush();
    this.zoomAnchor = scrollAnchorRatio(
      this.scrollEl.scrollTop,
      this.scrollEl.scrollHeight,
      this.scrollEl.clientHeight,
    );
  }

  /** 줌 적용 — 리플로우가 끝난 새 높이에 앵커를 되앉힌다. 크기 인자는 쓰지 않는다
   *  (글리프는 CSS 가 이미 그렸고, 이 뷰가 계산하는 격자는 없다).
   *
   *  **새 px 를 모델에 되쓰지 않는다**: 줌은 세션 한정이라 재시작하면 설정 크기로
   *  돌아가는데, 그때의 문서에 줌 크기 좌표를 얹으면 엉뚱한 자리가 열린다. 모델은
   *  beforeViewerFontSize 가 확정해 둔 줌 전 px 를 그대로 들고 있어야 하므로,
   *  scrollTop 대입이 발화시킬 scroll 이벤트를 markSynced 로 삼킨다. */
  setViewerFontSize(): void {
    if (this.disposed) return;
    const ratio = this.zoomAnchor;
    this.zoomAnchor = null;
    if (ratio === null) return;
    const top = scrollTopForAnchor(
      ratio,
      this.scrollEl.scrollHeight,
      this.scrollEl.clientHeight,
    );
    this.settle.markSynced(top);
    this.scrollEl.scrollTop = top;
  }

  /** 스냅샷 반영. 같은 파일이면 **아무것도 하지 않는다** — 스크롤 dispatch 가
   *  되돌아오는 매 렌더마다 위치를 재적용하면 사용자 스크롤과 싸운다 (에코 가드,
   *  shouldAdoptScroll). 파일 내용의 변화는 스냅샷이 아니라 mtime 폴링이 잡는다. */
  update(kind: ViewerKind): void {
    if (kind.type !== "markdownViewer") {
      // 탭의 kind 종류는 생성 후 바뀌지 않는다 — 오면 레지스트리 배선 결함이다.
      console.error("[mast] markdown view received a non-markdownViewer kind", kind);
      return;
    }
    if (!shouldAdoptScroll(this.adopted, kind.path)) return;
    this.adopted = { path: kind.path };
    this.path = kind.path;
    this.pendingScroll = kind.scrollTop;
    this.settle.markSynced(null);
    this.load(false);
  }

  /** unmount 직전 보류분 배출 (탭이 스냅샷에 남아 있을 때만 불린다 —
   *  workspace-view 의 리컨실 계약). */
  flushScroll(): void {
    this.settle.flush();
  }

  focus(): void {
    if (this.editing) this.editor.focus();
    else this.scrollEl.focus();
  }

  dispose(): void {
    this.disposed = true;
    // 폴링 수명 = 뷰 수명 (파일 상단 계약 3).
    this.poller.dispose();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.unsubscribeWindow();
    this.unsubscribeSaved();
    unregisterViewerFontTarget(this);
    this.settle.dispose();
    this.scrollEl.removeEventListener("scroll", this.onScroll);
    this.bodyEl.removeEventListener("click", this.onBodyClick);
    this.root.remove();
  }

  private readonly onScroll = (): void => {
    this.settle.observe(this.scrollEl.scrollTop);
  };

  /** 문서 안 링크 클릭은 무동작이다 (href 자체가 없지만 기본 동작도 끊는다). */
  private readonly onBodyClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (target instanceof Element && target.closest("a") !== null) ev.preventDefault();
  };

  private readonly onVisibilityChange = (): void => {
    this.poller.sync();
  };

  /** 창 최소화/복원 전이 — visibilitychange 와 같은 처리다 (sync 가 두 신호의
   *  OR 를 다시 읽는다). 최소화 중에 파일이 바뀌었다면 복원 직후 첫 주기에서
   *  잡힌다. */
  private readonly onWindowHidden = (): void => {
    this.poller.sync();
  };

  /** 파일을 읽어 렌더한다. `live` 는 폴링이 부른 재로드다 — 2초마다 "loading…"
   *  이 깜빡이지 않게 배너를 건드리지 않는다 (스크롤 보존 판정은 showHtml 몫). */
  private load(live: boolean): void {
    if (this.editing) return;
    const token = ++this.loadToken;
    if (!live) this.setBanner("loading…", false);
    this.loadDocument(token).catch((err: unknown) => {
      if (this.disposed || token !== this.loadToken) return;
      this.renderError(describeError(err));
      // 실패는 폴링을 재시도 모드로 돌린다: baseline 을 실존 불가능한 값으로
      // 고정하면 다음 성공 stat 의 mtime 이 반드시 달라 자동 재로드가 걸린다 —
      // 9P 과도 실패는 다음 주기에 스스로 낫고, 첫 로드부터 실패한 탭(없는
      // 파일)도 파일이 생기면 재마운트 없이 복구된다.
      this.poller.start(RETRY_BASELINE_MS);
    });
  }

  private async loadDocument(token: number): Promise<void> {
    const stat = await fsStat(this.distro, this.path);
    if (this.disposed || token !== this.loadToken) return;
    if (stat.is_dir) {
      this.renderError("it is a directory");
      return;
    }
    // 크기와 무관하게 폴링 기준은 갱신한다 — 파일이 상한 아래로 줄면 그때
    // 렌더로 복귀한다.
    this.poller.start(stat.mtime_ms);

    if (stat.size > MARKDOWN_MAX_BYTES) {
      this.renderTooLarge(stat.size);
      return;
    }

    const buffer = await fsReadChunk(this.distro, this.path, 0, stat.size);
    if (this.disposed || token !== this.loadToken) return;
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    this.source = source;
    this.editButton.disabled = false;

    this.setBanner(null, false);
    this.showHtml(renderMarkdown(source));
  }

  /** 렌더 결과를 앉히고 스크롤 위치를 정한다.
   *
   *  보류된 복원 위치(pendingScroll)가 있으면 이 문서의 **첫 렌더**다 — 모델에서
   *  온 값이라 그대로 되돌려 보낼 것이 없으므로 markSynced 로 합의 위치를 먼저
   *  고정한 뒤 적용한다. 없으면 라이브 리로드라 보던 위치(px)를 유지하고 settle
   *  상태는 건드리지 않는다: 같은 값이면 ScrollSettle 이 알아서 조용하고, 문서가
   *  짧아져 브라우저가 clamp 하면 그 새 위치가 정상적으로 기록된다. */
  private showHtml(html: string): void {
    const previous = this.scrollEl.scrollTop;
    const restore = this.pendingScroll;
    this.pendingScroll = null;
    // 여기 들어가는 문자열은 renderMarkdown 이 무해화한 결과다 (파일 상단 계약 1).
    this.bodyEl.innerHTML = html;
    if (restore !== null) this.settle.markSynced(restore);
    this.scrollEl.scrollTop = restore ?? previous;
  }

  /** 2MiB 초과 — 렌더를 거부하고 textViewer 로 여는 길만 준다 (파일 상단 계약 2). */
  private renderTooLarge(size: number): void {
    this.source = null;
    this.editButton.disabled = true;
    this.setBanner(
      `not rendered: ${formatMiB(size)} exceeds the ${formatMiB(MARKDOWN_MAX_BYTES)} markdown limit`,
      true,
    );

    const notice = document.createElement("div");
    notice.className = "markdown-notice";
    const text = document.createElement("p");
    text.textContent =
      "Rendering a file this large would hold the whole document in memory. The text viewer reads it one window at a time.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "markdown-open-text";
    button.textContent = "open as text";
    button.addEventListener("click", () => {
      void this.dispatch({
        type: "createTab",
        pane: this.pane,
        tab: { type: "textViewer", path: this.path },
      });
    });
    notice.append(text, button);
    this.bodyEl.replaceChildren(notice);
  }

  /** 로드 실패 — 인라인 에러로 표면화하고 탭은 유지한다 (없는·삭제된 파일도
   *  모델에 남아 재시도가 가능해야 한다). 보류된 복원 위치는 소비하지 않는다:
   *  파일이 돌아오면 그때 원래 지점으로 복원된다. **본문은 지우지 않는다**
   *  — 라이브 리로드의 일시 실패(9P 과도 상태)에서 마지막으로 성공한 렌더를
   *  배너 아래에 그대로 유지한다. 첫 로드 실패면 본문이 원래 비어 있어 배너만
   *  남는 기존 표시와 같다. */
  private renderError(message: string): void {
    this.setBanner(`cannot read ${this.path}: ${message}`, true);
  }

  private setBanner(text: string | null, error: boolean): void {
    this.bannerEl.textContent = text ?? "";
    this.bannerEl.hidden = text === null;
    this.bannerEl.classList.toggle("error", error);
  }
}
