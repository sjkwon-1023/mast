import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AttachGate } from "./attach-gate";
import { AckBatcher } from "./ack-batcher";
import type { IDisposable } from "@xterm/xterm";
import {
  OutputSettle,
  scrollOffsetToRemember,
  scrollbackWipeRestoreOffset,
  restoreTargetLine,
} from "./scroll";
import {
  writeStdin,
  openUrl,
  attachTerminal,
  resizeTerminal,
  detachTerminal,
  ackOutput,
} from "../../infrastructure/backend";
import type { SessionId } from "../../shared/types";
import {
  terminalViewOptions,
  registerTerminalFontTarget,
  unregisterTerminalFontTarget,
} from "./settings";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { IS_MAC } from "../../shared/platform";
import { createFileLinkProvider } from "./file-links";
import {
  shouldOpenLink,
  isCopySelectionKey,
  isPasteKey,
  isImageOnlyPaste,
  copyTerminalSelection,
  clipboardHasImage,
  macTerminalKeyAction,
} from "./interaction";
import type { MacTerminalKey } from "./interaction";
import { Channel } from "@tauri-apps/api/core";
import type { OutputChunk } from "../../infrastructure/backend";
import { parseAttachBody, parseFrame } from "./frame";
import { WebKitImeInput } from "./webkit-ime-input";
import { WindowsImeInput } from "./windows-ime-input";
import type { GateResult } from "./attach-gate";
import { installImeCommitDiagnostics, log } from "../../infrastructure/logging";
import type { ImeCommitDiagnostics } from "../../infrastructure/logging";
import type { SettlePoll } from "./scroll";
import "@xterm/xterm/css/xterm.css";

// 막대의 트랙·슬라이더는 pointerdown 을 preventDefault 하므로 호환 mousedown 이 오지 않는다.
const RESTORE_CANCEL_EVENTS = ["keydown", "wheel", "pointerdown"] as const;

// xterm 6 의 스크롤바는 .xterm-viewport 밖의 SmoothScrollableElement 막대다.
const XTERM_SCROLLBAR = ".xterm-scrollable-element > .scrollbar";

// 뷰만 소유한다. PTY 세션 수명은 Dispatcher가 관리한다 (ADR-0004, ADR-0019).
export class TerminalView {
  readonly root: HTMLDivElement;
  private readonly term: Terminal;
  private readonly fitAddon: FitAddon;
  private readonly gate = new AttachGate();
  private readonly batcher: AckBatcher;
  private onDataSub: IDisposable | null = null;
  private onResizeSub: IDisposable | null = null;
  private disposed = false;
  private fitScheduled = false;
  private visible = true;
  private opened = false;

  private focusPending = false;

  // 한글 입력 어댑터 — macOS 는 webkit-ime.ts, Windows 는 windows-ime.ts.
  private ime: WebKitImeInput | WindowsImeInput | null = null;

  // Windows IME 확정 ↔ xterm 전송 비교 진단. 로그 옵트인 + 비 macOS 에서만 생긴다.
  private imeDiag: ImeCommitDiagnostics | null = null;

  private replayDone = false;

  private writeQueue: Promise<void> = Promise.resolve();

  private restoreOffset: number | null = null;

  private settle = new OutputSettle();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelListeners = false;

  private latchedByRestore = false;

  private releaseLatchOnNextChunk = false;

  private hasScrollback = false;

  private enqueueWrite(data: string): void {
    this.writeQueue = this.writeQueue
      .then(() => writeStdin(this.session, data))
      .catch((err) => console.error("write_stdin failed", err));
  }

  constructor(
    parent: HTMLElement,

    readonly session: SessionId,

    private readonly onTraceReplayDone?: (bytes: number) => void,

    restoreScrollOffset?: number,

    private readonly onFileOpenError: (message: string) => void = (message) =>
      console.error("open file failed", message),
  ) {
    this.root = document.createElement("div");
    this.root.className = "term-host";
    parent.appendChild(this.root);

    const activateLink = (event: MouseEvent, uri: string): void => {
      if (!shouldOpenLink(uri, this.term.modes.mouseTrackingMode, event)) return;
      void openUrl(uri).catch((err: unknown) => console.error("open_url failed", err));
    };

    this.term = new Terminal({
      scrollback: 5000,

      ...terminalViewOptions(),
      linkHandler: { activate: activateLink },
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    this.term.loadAddon(new WebLinksAddon(activateLink));
    // 파일 경로는 HTTP·OSC 8 과 별도 제공자가 맡는다 — 두 링크 경로의 판정은 그대로 둔다.
    this.term.registerLinkProvider(createFileLinkProvider(this.term, session, this.onFileOpenError));

    // 내장 ED 3 처리 전의 위치를 읽고, false를 반환해 실제 화면 삭제는 xterm에 맡긴다.
    this.term.parser.registerCsiHandler({ final: "J" }, (params) => {
      if (params[0] === 3) this.onScrollbackWipe();
      return false;
    });

    // ED 3 은 xterm 내부 onScroll 만 내고 공개 onScroll 로 넘어오지 않아 파싱 완료 시점에 맞춘다.
    // clear() 같은 write 밖의 변경은 onScroll 이, resize 의 reflow 는 onResize 가 맡는다.
    this.term.onWriteParsed(() => this.syncScrollbackMarker());
    this.term.onScroll(() => this.syncScrollbackMarker());

    this.batcher = new AckBatcher((n) => {
      this.sendAck(n);
    });

    registerTerminalFontTarget(this);

    if (restoreScrollOffset !== undefined) this.beginScrollRestore(restoreScrollOffset);
  }

  setFontSize(size: number): void {
    if (this.disposed) return;
    this.term.options.fontSize = size;
    this.scheduleFit();
  }

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    // 숨겨지는 탭의 조합 중 글자는 blur 를 기다리지 않고 확정한다.
    if (!v) {
      this.ime?.flush();
      // 숨김 뒤에는 확정 묶음을 이어 볼 수 없다 — 남은 관찰을 중단으로 정산한다.
      this.imeDiag?.interrupt();
    }
    this.root.style.display = v ? "" : "none";
    if (v) this.scheduleFit();
  }

  /** xterm 의 현재 칸 수. fit 이 끝난 뒤의 값이라 pane 크기 보고가 이것을 그대로 보낸다. */
  get grid(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  /** xterm 격자(cols·rows)가 바뀔 때마다 부른다. fit 과 글꼴 변경이 모두 여기로 오며, pane 크기 보고가 듣는다. */
  onGridChange(listener: () => void): IDisposable {
    return this.term.onResize(listener);
  }

  scheduleFit(): void {
    if (this.fitScheduled) return;
    this.fitScheduled = true;
    requestAnimationFrame(() => {
      this.fitScheduled = false;
      if (!this.disposed) this.fit();
    });
  }

  focus(): void {
    if (!this.opened) {
      this.focusPending = true;
      return;
    }
    this.term.focus();
  }

  // bracketed paste 추적은 xterm이 맡는다. raw escape를 직접 조립하지 않는다.
  paste(text: string): void {
    if (!this.replayDone) {
      console.warn("[mast] paste before replay done — text dropped by onData gate", {
        session: this.session,
        length: text.length,
      });
    }
    // 조합 중 글자가 붙여넣은 텍스트보다 먼저 가야 한다. xterm 의 paste 는 입력창도 비운다.
    this.ime?.flush();
    this.imeDiag?.notePaste();
    this.term.paste(text);
  }

  rememberedScrollOffset(): number | null {
    if (this.disposed) return null;
    if (!this.opened) return this.restoreOffset;
    const buffer = this.term.buffer.active;
    return scrollOffsetToRemember(
      this.restoreOffset,
      buffer.type,
      buffer.baseY,
      buffer.viewportY,
    );
  }

  async attach(): Promise<void> {
    this.term.open(this.root);
    this.opened = true;

    this.fit();
    this.installCopyPasteKeys();
    if (IS_MAC) {
      this.ime = new WebKitImeInput(this.term);
    } else {
      // 진단의 capture 리스너가 어댑터의 stopPropagation 보다 먼저 돌도록 먼저 설치한다.
      this.imeDiag = installImeCommitDiagnostics(this.term, this.session);
      this.ime = new WindowsImeInput(this.term);
    }

    // attach 응답 전에 들어오는 출력을 놓치지 않도록 채널을 먼저 만든다.
    const channel = new Channel<OutputChunk>();
    channel.onmessage = (chunk): void => {
      this.onChunk(chunk);
    };

    // 재생 중의 낡은 질의 응답이 셸 입력으로 새지 않도록 onData를 차단한다.
    this.onDataSub = this.term.onData((data) => {
      if (!this.replayDone) {
        console.debug("[mast] dropped stale terminal auto-response", data.length);
        return;
      }
      this.enqueueWrite(data);
    });

    const body = await attachTerminal(this.session, channel);
    if (this.disposed) return;
    const { endOffset, firstAttach, replay } = parseAttachBody(body);

    // 최초 attach의 질의는 라이브다. CPR을 막으면 conhost가 입력을 기다리며 멈춘다.
    if (firstAttach) this.replayDone = true;
    const traceDone = this.onTraceReplayDone;
    if (replay.byteLength > 0) {
      const bytes = replay.byteLength;
      this.term.write(replay, () => {
        this.replayDone = true;

        this.applyScrollRestore();

        if (traceDone !== undefined) requestAnimationFrame(() => traceDone(bytes));
      });
    } else {
      this.replayDone = true;

      if (traceDone !== undefined) requestAnimationFrame(() => traceDone(0));
    }

    // replay는 ack 대상이 아니다. 채널 출력은 dedup으로 버린 바이트까지 전부 ack한다.
    this.applyGateResult(this.gate.onSnapshot(endOffset));
    this.onResizeSub = this.term.onResize(({ cols, rows }) => {
      this.syncScrollbackMarker();
      resizeTerminal(this.session, cols, rows).catch((err) =>
        console.error("resize failed", err),
      );
    });

    try {
      const { cols, rows } = this.term;
      // 같은 크기의 resize는 no-op이므로 두 단계로 SIGWINCH와 전사 재인쇄를 강제한다.
      await resizeTerminal(this.session, cols, Math.max(1, rows - 1));
      await resizeTerminal(this.session, cols, rows);
    } catch (err) {
      console.error("resize nudge failed", err);
    }

    this.armScrollRestore();

    if (this.focusPending) {
      this.focusPending = false;
      if (this.visible) this.term.focus();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    unregisterTerminalFontTarget(this);
    // 남은 조합은 onData 구독을 끊기 전에 확정해야 PTY 에 닿는다.
    this.ime?.dispose();
    this.ime = null;
    this.imeDiag?.dispose();
    this.imeDiag = null;
    this.endScrollRestore("disposed");

    this.latchedByRestore = false;
    this.releaseLatchOnNextChunk = false;

    // 채널을 분리하지 않으면 뷰 해제 뒤 ack 없는 pending이 쌓여 PTY가 멈춘다.
    void detachTerminal(this.session).catch((err) =>
      console.error("detach_terminal failed", err),
    );
    this.onDataSub?.dispose();
    this.onDataSub = null;
    this.onResizeSub?.dispose();
    this.onResizeSub = null;

    this.batcher.dispose();
    this.term.dispose();
    this.root.remove();
  }

  private onChunk(chunk: OutputChunk): void {
    if (this.disposed) return;
    const frame = parseFrame(chunk);
    this.applyGateResult(this.gate.push(frame));
  }

  private applyGateResult(result: GateResult): void {
    for (const bytes of result.deliver) {
      if (bytes.byteLength === 0) continue;

      // 파싱 완료 시점에 ack와 복원 판정을 갱신한다.
      this.term.write(bytes, () => {
        this.batcher.add(bytes.byteLength);

        if (this.releaseLatchOnNextChunk && this.term.buffer.active.baseY > 0) {
          this.releaseScrollLatchNow();
        }

        if (this.restoreOffset !== null) {
          const now = performance.now();
          this.settle.noteChunk(now);
          this.applyScrollRestore();
          this.rescheduleSettle(now);
        }
      });
    }

    this.batcher.add(result.discardedBytes);
  }

  private sendAck(n: number): void {
    ackOutput(this.session, n).catch((err) => console.error("ack_output failed", err));
  }

  private installCopyPasteKeys(): void {
    // macOS 는 네이티브 붙여넣기(paste 이벤트)를 xterm 이 처리한다(isPasteKey 참조). 이미지만
    // 있는 붙여넣기만 xterm 보다 먼저(capture) 가로채 Ctrl+V 로 바꾼다. 이 리스너가 IME
    // 어댑터의 paste 리스너보다 먼저 등록돼 먼저 돌므로, 남은 한글 조합을 여기서 먼저 확정해야
    // Ctrl+V 보다 앞서 간다(앞선 keydown 이 없는 Edit › Paste 경로).
    if (IS_MAC) {
      this.term.element?.addEventListener(
        "paste",
        (ev) => {
          if (!ev.clipboardData || !isImageOnlyPaste(ev.clipboardData)) return;
          ev.preventDefault();
          ev.stopPropagation();
          this.ime?.flush();
          this.enqueueWrite("\x16");
        },
        { capture: true },
      );
    }
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || ev.isComposing) return true;

      // Shift+Enter는 Claude Code의 줄바꿈 시퀀스 ESC CR로 보낸다.
      if (ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        this.enqueueWrite("\x1b\r");
        return false;
      }
      // macOS 의 ⌘ 줄 편집·⌘K·Fn 스크롤 (interaction.ts::macTerminalKeyAction). Windows 는 null.
      const macKey = macTerminalKeyAction(ev, {
        normalBuffer: this.term.buffer.active.type === "normal",
        mouseTracking: this.term.modes.mouseTrackingMode !== "none",
      });
      if (macKey !== null) {
        ev.preventDefault();
        this.runMacTerminalKey(macKey);
        return false;
      }
      if (isCopySelectionKey(ev, this.term.hasSelection())) {
        ev.preventDefault();
        void copyTerminalSelection(this.term);
        return false;
      }
      if (isPasteKey(ev)) {
        ev.preventDefault();
        void this.pasteFromClipboard();
        return false;
      }
      return true;
    });
  }

  private runMacTerminalKey(key: MacTerminalKey): void {
    switch (key.type) {
      case "send":
        // 사용자 입력 경로(onData)를 그대로 태워 replay 게이트와 입력 시 하단 스크롤을 받는다.
        this.term.input(key.data, true);
        return;
      case "clear":
        this.term.clear();
        return;
      case "scroll":
        if (key.to === "pageUp") this.term.scrollPages(-1);
        else if (key.to === "pageDown") this.term.scrollPages(1);
        else if (key.to === "top") this.term.scrollToTop();
        else this.term.scrollToBottom();
        return;
    }
  }

  // preventDefault 후 이 경로로만 붙여넣어 네이티브 paste와 중복되지 않게 한다.
  private async pasteFromClipboard(): Promise<void> {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      console.error("clipboard read failed", err);
    }
    if (text.length > 0) {
      this.paste(text);
      return;
    }
    if (await clipboardHasImage()) this.enqueueWrite("\x16");
  }

  private beginScrollRestore(offset: number): void {
    this.restoreOffset = offset;
    this.settle = new OutputSettle();
    this.installRestoreCancel();
  }

  private onScrollbackWipe(): void {
    if (this.disposed) return;
    const buffer = this.term.buffer.active;
    const offset = scrollbackWipeRestoreOffset(
      this.restoreOffset,
      this.releaseLatchOnNextChunk,
      this.replayDone,
      buffer.type,
      buffer.baseY,
      buffer.viewportY,
    );
    if (offset === null) return;
    log(`scroll: scrollback wiped — restoring bottom-relative offset ${offset}`);
    this.beginScrollRestore(offset);
    this.armScrollRestore();
  }

  // attach 완료 전에 ED 3가 먼저 무장했을 수 있어 기존 타이머를 교체한다.
  private armScrollRestore(): void {
    if (this.restoreOffset === null || this.disposed) return;

    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    const now = performance.now();
    this.settle.start(now);
    this.scheduleSettleCheck(this.settle.poll(now));
  }

  private scheduleSettleCheck(result: SettlePoll): void {
    switch (result.kind) {
      case "wait":
        this.settleTimer = setTimeout(
          () => {
            this.settleTimer = null;
            if (this.disposed) return;
            this.scheduleSettleCheck(this.settle.poll(performance.now()));
          },
          Math.max(0, result.nextCheckAt - performance.now()),
        );
        return;
      case "restore":
        this.applyScrollRestore();
        this.endScrollRestore(this.latchedByRestore ? "kept" : "bottom");
        return;
      case "abandon":
        this.endScrollRestore(this.latchedByRestore ? "kept" : "bottom");
        return;
    }
  }

  // 무장 전 poll은 abandon이므로 대기 중인 타이머가 있을 때만 quiet 기한을 미룬다.
  private rescheduleSettle(now: number): void {
    if (this.settleTimer === null) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.scheduleSettleCheck(this.settle.poll(now));
  }

  private applyScrollRestore(): void {
    if (this.restoreOffset === null) return;
    // ED 3 이전 하단도 복원 대상이다. 재인쇄 중 남은 xterm 뷰포트 래치를 해제한다.
    if (this.restoreOffset === 0) {
      this.releaseScrollLatch();
      return;
    }
    const baseY = this.term.buffer.active.baseY;
    const line = restoreTargetLine(baseY, this.restoreOffset);
    if (line === null) {
      this.releaseScrollLatch();
      return;
    }
    this.term.scrollToLine(line);

    if (line < baseY) this.latchedByRestore = true;
  }

  // 브라우저 xterm 6.0은 이동량 0인 scrollToBottom()으로 래치를 풀지 못한다. baseY가 생긴 다음 chunk로 미룬다.
  private releaseScrollLatch(): void {
    if (this.term.buffer.active.baseY === 0) {
      this.releaseLatchOnNextChunk = true;
      return;
    }
    this.releaseScrollLatchNow();
  }

  private releaseScrollLatchNow(): void {
    this.term.scrollToBottom();
    this.latchedByRestore = false;
    this.releaseLatchOnNextChunk = false;
  }

  private endScrollRestore(end: "kept" | "bottom" | "cancelled" | "disposed"): void {
    if (this.restoreOffset !== null) log(`scroll: restore ended ${end}`);
    this.restoreOffset = null;

    if (this.latchedByRestore && this.term.buffer.active.baseY === 0) {
      this.releaseLatchOnNextChunk = true;
    }
    this.settle.cancel();
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (!this.cancelListeners) return;
    this.cancelListeners = false;
    for (const type of RESTORE_CANCEL_EVENTS) {
      this.root.removeEventListener(type, this.onUserInterrupt, { capture: true });
    }
  }

  private readonly onUserInterrupt = (ev: Event): void => {
    // pane 포커스·텍스트 선택 클릭은 복원을 취소하지 않는다. 막대의 트랙·슬라이더만 조작이다.
    if (ev.type === "pointerdown") {
      const target = ev.target;
      if (!(target instanceof Element) || target.closest(XTERM_SCROLLBAR) === null) return;
    }

    // 키 입력은 래치를 해제한다. 휠·스크롤바는 사용자가 고른 위치이므로 지연 해제도 버린다.
    if (ev.type === "keydown") {
      this.releaseScrollLatch();
    } else {
      this.latchedByRestore = false;
      this.releaseLatchOnNextChunk = false;
    }
    this.endScrollRestore("cancelled");
  };

  private installRestoreCancel(): void {
    if (this.restoreOffset === null || this.cancelListeners) return;
    this.cancelListeners = true;
    for (const type of RESTORE_CANCEL_EVENTS) {
      this.root.addEventListener(type, this.onUserInterrupt, {
        capture: true,
        passive: true,
      });
    }
  }

  // styles.css 가 세로 막대를 드러내는 기준이다. 스크롤백이 있는 normal buffer 에서만 표식을 단다.
  private syncScrollbackMarker(): void {
    const buffer = this.term.buffer.active;
    const hasScrollback = buffer.type === "normal" && buffer.baseY > 0;
    if (hasScrollback === this.hasScrollback) return;
    this.hasScrollback = hasScrollback;
    if (hasScrollback) this.root.dataset.scrollback = "";
    else delete this.root.dataset.scrollback;
  }

  private fit(): void {
    if (this.root.clientWidth === 0 || this.root.clientHeight === 0) return;
    this.fitAddon.fit();
  }
}
