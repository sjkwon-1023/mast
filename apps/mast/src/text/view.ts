import { highlightLanguages } from "./settings";
import type { Command, CommandOutput, TabId } from "../types";
import type { TimerHost } from "../ack-batcher";
import type { ViewerView, ViewerKind } from "../viewer-view";
import type { ViewerFontTarget } from "../viewer-font";
import type { WindowAction, TextWindow } from "./window";
import {
  ScrollSettle,
  SCROLL_SETTLE_MS,
  defaultTimers,
  shouldAdoptScroll,
} from "../viewer-scroll";
import {
  lineHeightForFontSize,
  WINDOW_ACTIONS,
  scrollTopForLineHeight,
  textKeyAction,
  pageScrollTop,
  topLineIndex,
  windowButtonsDisabled,
  nextWindowStart,
  windowStartForRestore,
  WINDOW_BYTES,
  decodeWindow,
  formatByteRange,
  lineIndexForOffset,
  visibleSlice,
} from "./window";
import {
  viewerFontSize,
  registerViewerFontTarget,
  unregisterViewerFontTarget,
} from "../viewer-font";
import {
  languageForPath,
  HIGHLIGHT_MAX_BYTES,
  loadHighlighter,
  highlightLines,
} from "./highlight";
import { fsStat, fsReadChunk } from "../backend";

type DispatchFn = (cmd: Command) => Promise<CommandOutput | null>;

function describeError(err: unknown): string {
  return typeof err === "string" ? err : String(err);
}

export interface TextViewOptions {
  timers?: TimerHost;
  settleMs?: number;
}

// 창 하나만 읽고 가상 스크롤로 표시한다. 비동기 응답은 loadToken으로 현재 창인지 확인한다.
export class TextView implements ViewerView, ViewerFontTarget {
  readonly root: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly barEl: HTMLDivElement;
  private readonly rangeEl: HTMLSpanElement;
  private readonly buttons: { action: WindowAction; el: HTMLButtonElement }[] = [];
  private readonly scrollEl: HTMLDivElement;
  private readonly spacerEl: HTMLDivElement;
  private readonly linesEl: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly settle: ScrollSettle;

  private lineHeight = lineHeightForFontSize(viewerFontSize());

  private path: string;
  private size = 0;
  private win: TextWindow = { start: 0, end: 0, lines: [], lineStarts: [] };
  private disposed = false;

  private loadToken = 0;

  private slice: { first: number; last: number } | null = null;

  private adopted: { path: string } | null = null;

  private pendingOffset: number | null = null;

  private language: string | null;

  private highlighted: string[] | null = null;

  constructor(
    parent: HTMLElement,
    private readonly tab: TabId,

    private readonly distro: string | null,
    kind: ViewerKind,
    dispatch: DispatchFn,
    options: TextViewOptions = {},
  ) {
    this.path = kind.type === "textViewer" ? kind.path : "";
    this.adopted = { path: this.path };
    this.pendingOffset = kind.type === "textViewer" ? kind.scrollTop : 0;
    this.language = languageForPath(this.path, highlightLanguages);

    this.settle = new ScrollSettle(
      (offset) => {
        void dispatch({ type: "setViewerScroll", tab: this.tab, scrollTop: offset });
      },
      options.settleMs ?? SCROLL_SETTLE_MS,
      options.timers ?? defaultTimers,
    );

    this.root = document.createElement("div");
    this.root.className = "text-view";

    this.root.style.setProperty("--text-line-height", `${this.lineHeight}px`);

    this.bannerEl = document.createElement("div");
    this.bannerEl.className = "text-banner";
    this.bannerEl.hidden = true;

    this.rangeEl = document.createElement("span");
    this.rangeEl.className = "text-range";

    this.barEl = document.createElement("div");
    this.barEl.className = "text-bar";
    this.barEl.hidden = true;
    this.barEl.append(this.rangeEl);

    const titles: Record<WindowAction, string> = {
      first: "First window (Ctrl+Home)",
      prev: "Previous window (Ctrl+PageUp)",
      next: "Next window (Ctrl+PageDown)",
      last: "Last window (Ctrl+End)",
    };
    for (const action of WINDOW_ACTIONS) {
      const title = titles[action];
      const el = document.createElement("button");
      el.type = "button";
      el.className = "text-window-button";
      el.textContent = action;
      el.title = title;
      el.addEventListener("click", () => this.moveWindow(action));
      this.buttons.push({ action, el });
      this.barEl.append(el);
    }

    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "text-scroll";

    // 프로그램적 포커스와 네이티브 방향키 스크롤을 허용하되 Tab 순서에는 넣지 않는다.
    this.scrollEl.tabIndex = -1;
    this.scrollEl.addEventListener("scroll", this.onScroll);

    this.spacerEl = document.createElement("div");
    this.spacerEl.className = "text-spacer";
    this.linesEl = document.createElement("div");
    this.linesEl.className = "text-lines";
    this.spacerEl.append(this.linesEl);
    this.scrollEl.append(this.spacerEl);

    this.root.append(this.bannerEl, this.barEl, this.scrollEl);

    // 창 이동 키는 상단 버튼에 포커스가 있을 때도 처리한다.
    this.root.addEventListener("keydown", this.onKeyDown);
    parent.appendChild(this.root);

    this.resizeObserver = new ResizeObserver(() => this.renderSlice());
    this.resizeObserver.observe(this.root);

    registerViewerFontTarget(this);

    this.load(this.pendingOffset ?? 0, true);
  }

  setViewerFontSize(size: number): void {
    if (this.disposed) return;
    const next = lineHeightForFontSize(size);

    if (next === this.lineHeight) return;
    const scrollTop = scrollTopForLineHeight(
      this.scrollEl.scrollTop,
      this.lineHeight,
      next,
      this.win.lines.length,
    );
    this.lineHeight = next;
    this.root.style.setProperty("--text-line-height", `${next}px`);
    // spacer를 먼저 늘려야 이어지는 scrollTop 대입이 이전 높이로 clamp되지 않는다.
    this.spacerEl.style.height = `${this.win.lines.length * next}px`;

    this.slice = null;

    // 로드 중에는 이전 창의 offset을 새 경로에 기록하지 않는다.
    if (this.pendingOffset === null) this.scrollEl.scrollTop = scrollTop;
    this.renderSlice();
  }

  update(kind: ViewerKind): void {
    if (kind.type !== "textViewer") {
      console.error("[mast] text view received a non-textViewer kind", kind);
      return;
    }
    // 자신의 스크롤 dispatch가 돌아올 때 현재 위치를 덮어쓰지 않는다.
    if (!shouldAdoptScroll(this.adopted, kind.path)) return;
    this.adopted = { path: kind.path };
    this.path = kind.path;
    this.language = languageForPath(this.path, highlightLanguages);
    this.pendingOffset = kind.scrollTop;
    this.settle.markSynced(null);
    this.load(kind.scrollTop, true);
  }

  flushScroll(): void {
    this.settle.flush();
  }

  focus(): void {
    this.scrollEl.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.settle.dispose();
    unregisterViewerFontTarget(this);
    this.resizeObserver.disconnect();
    this.scrollEl.removeEventListener("scroll", this.onScroll);
    this.root.removeEventListener("keydown", this.onKeyDown);
    this.root.remove();
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    const action = textKeyAction({
      key: ev.key,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      shift: ev.shiftKey,
      isComposing: ev.isComposing,
    });
    if (action === null) return;
    ev.preventDefault();
    if (action.type === "window") this.moveWindow(action.action);
    else this.pageScroll(action.delta);
  };

  private pageScroll(delta: 1 | -1): void {
    const max = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
    this.scrollEl.scrollTop = pageScrollTop(
      this.scrollEl.scrollTop,
      this.scrollEl.clientHeight,
      max,
      delta,
      this.lineHeight,
    );
  }

  private readonly onScroll = (): void => {
    this.renderSlice();
    const offset = this.topLineOffset();
    if (offset !== null) this.settle.observe(offset);
  };

  private topLineOffset(): number | null {
    const starts = this.win.lineStarts;
    if (starts.length === 0) return null;
    return starts[topLineIndex(this.scrollEl.scrollTop, this.lineHeight, starts.length)];
  }

  private moveWindow(action: WindowAction): void {
    if (windowButtonsDisabled(this.win, this.size)[action]) return;

    this.settle.flush();
    this.load(nextWindowStart(action, this.win, this.size), false);
  }

  private load(target: number, restore: boolean): void {
    const token = ++this.loadToken;
    this.setBanner("loading…", false);
    this.loadWindow(target, restore, token).catch((err: unknown) => {
      if (this.disposed || token !== this.loadToken) return;
      this.renderError(describeError(err));
    });
  }

  private async loadWindow(target: number, restore: boolean, token: number): Promise<void> {
    const stat = await fsStat(this.distro, this.path);
    if (this.disposed || token !== this.loadToken) return;
    if (stat.is_dir) {
      this.renderError("it is a directory");
      return;
    }

    let start = restore
      ? windowStartForRestore(target, stat.size)
      : Math.max(0, Math.min(target, stat.size));

    if (start >= stat.size) start = Math.max(0, stat.size - WINDOW_BYTES);

    // 목표 행의 앞 개행 1바이트를 포함하고 길이도 늘려, 선두 행과 EOF를 모두 보존한다.
    const readOffset = start > 0 ? start - 1 : 0;
    const readLen = WINDOW_BYTES + (start - readOffset);

    const buffer = await fsReadChunk(this.distro, this.path, readOffset, readLen);
    if (this.disposed || token !== this.loadToken) return;
    const bytes = new Uint8Array(buffer);
    const atEof = bytes.length < readLen || readOffset + bytes.length >= stat.size;

    this.setBanner(null, false);
    this.showWindow(decodeWindow(bytes, readOffset, atEof), stat.size);

    // 플레인 렌더를 먼저 끝낸 후 색을 덧입힌다.
    this.startHighlight(token);
  }

  private startHighlight(token: number): void {
    const language = this.language;
    if (language === null || this.win.lines.length === 0) return;
    if (this.win.end - this.win.start > HIGHLIGHT_MAX_BYTES) return;
    loadHighlighter(language)
      .then((hljs) => {
        if (this.disposed || token !== this.loadToken) return;
        const highlighted = highlightLines(this.win.lines, language, hljs);
        if (highlighted === null) return;
        this.highlighted = highlighted;

        this.slice = null;
        this.renderSlice();
      })
      .catch((err: unknown) => {
        console.error("[mast] syntax highlighting failed", err);
      });
  }

  private showWindow(win: TextWindow, size: number): void {
    this.win = win;
    this.size = size;
    this.spacerEl.style.height = `${win.lines.length * this.lineHeight}px`;
    this.slice = null;

    this.highlighted = null;

    const paged = win.start > 0 || win.end < size;
    this.barEl.hidden = !paged;
    if (paged) this.rangeEl.textContent = formatByteRange(win.start, win.end, size);

    const disabled = windowButtonsDisabled(win, size);
    for (const { action, el } of this.buttons) el.disabled = disabled[action];

    const restore = this.pendingOffset;
    this.pendingOffset = null;
    const index = restore === null ? 0 : lineIndexForOffset(win.lineStarts, restore);
    const top = win.lineStarts[index] ?? null;

    this.settle.markSynced(restore === null ? null : top);
    this.scrollEl.scrollTop = index * this.lineHeight;
    this.renderSlice();
    if (restore === null && top !== null) this.settle.observe(top);
  }

  private renderError(message: string): void {
    this.setBanner(`cannot read ${this.path}: ${message}`, true);
    this.showWindow({ start: 0, end: 0, lines: [], lineStarts: [] }, 0);
  }

  private renderSlice(): void {
    const range = visibleSlice(
      this.scrollEl.scrollTop,
      this.scrollEl.clientHeight,
      this.win.lines.length,
      this.lineHeight,
    );
    if (
      this.slice !== null &&
      this.slice.first === range.first &&
      this.slice.last === range.last
    ) {
      return;
    }
    this.slice = { first: range.first, last: range.last };
    this.linesEl.style.top = `${range.top}px`;
    const nodes: HTMLDivElement[] = [];
    for (let i = range.first; i < range.last; i += 1) {
      const el = document.createElement("div");
      el.className = "text-line";

      const html = this.highlighted?.[i];
      if (html === undefined) el.textContent = this.win.lines[i];
      else el.innerHTML = html;
      nodes.push(el);
    }
    this.linesEl.replaceChildren(...nodes);
  }

  private setBanner(text: string | null, error: boolean): void {
    this.bannerEl.textContent = text ?? "";
    this.bannerEl.hidden = text === null;
    this.bannerEl.classList.toggle("error", error);
  }
}
