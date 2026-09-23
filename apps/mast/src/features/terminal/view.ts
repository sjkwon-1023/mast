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
import {
  shouldOpenLink,
  isCopySelectionKey,
  isPasteKey,
  isImageOnlyPaste,
  copyTerminalSelection,
  clipboardHasImage,
  altArrowSequence,
} from "./interaction";
import { Channel } from "@tauri-apps/api/core";
import type { OutputChunk } from "../../infrastructure/backend";
import { parseAttachBody, parseFrame } from "./frame";
import type { GateResult } from "./attach-gate";
import { log } from "../../infrastructure/logging";
import type { SettlePoll } from "./scroll";
import "@xterm/xterm/css/xterm.css";

const RESTORE_CANCEL_EVENTS = ["keydown", "wheel", "mousedown"] as const;

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

  private replayDone = false;

  private writeQueue: Promise<void> = Promise.resolve();

  private restoreOffset: number | null = null;

  private settle = new OutputSettle();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelListeners = false;

  private latchedByRestore = false;

  private releaseLatchOnNextChunk = false;

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
  ) {
    this.root = document.createElement("div");
    this.root.className = "term-host";
    parent.appendChild(this.root);

    const activateLink = (_event: MouseEvent, uri: string): void => {
      if (!shouldOpenLink(uri, this.term.modes.mouseTrackingMode)) return;
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

    // 내장 ED 3 처리 전의 위치를 읽고, false를 반환해 실제 화면 삭제는 xterm에 맡긴다.
    this.term.parser.registerCsiHandler({ final: "J" }, (params) => {
      if (params[0] === 3) this.onScrollbackWipe();
      return false;
    });

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
    this.root.style.display = v ? "" : "none";
    if (v) this.scheduleFit();
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

  getSelection(): string {
    return this.term.getSelection();
  }

  // bracketed paste 추적은 xterm이 맡는다. raw escape를 직접 조립하지 않는다.
  paste(text: string): void {
    if (!this.replayDone) {
      console.warn("[mast] paste before replay done — text dropped by onData gate", {
        session: this.session,
        length: text.length,
      });
    }
    this.term.paste(text);
  }

  submit(): void {
    this.enqueueWrite("\r");
  }

  canAcceptSend(): boolean {
    return this.opened && !this.disposed && this.replayDone;
  }

  bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
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
    // 있는 붙여넣기만 xterm 보다 먼저(capture) 가로채 Ctrl+V 로 바꾼다.
    if (IS_MAC) {
      this.term.element?.addEventListener(
        "paste",
        (ev) => {
          if (!ev.clipboardData || !isImageOnlyPaste(ev.clipboardData)) return;
          ev.preventDefault();
          ev.stopPropagation();
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
      // xterm 의 Alt+방향키→Ctrl+방향키 재작성을 우회해 진짜 Alt 시퀀스를 보낸다 —
      // Codex 질문 UI 등 Alt+방향키를 쓰는 TUI 가 Ctrl+방향키를 받던 원인이다
      // (interaction.ts::altArrowSequence 참조). IME 조합 중에는 조합기 소유다.
      const altArrow = altArrowSequence(ev);
      if (altArrow !== null) {
        ev.preventDefault();
        this.enqueueWrite(altArrow);
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

  // 브라우저 xterm 5.5는 이동량 0에서 래치를 풀지 않는다. baseY가 생긴 다음 chunk로 미룬다.
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
    // pane 포커스·텍스트 선택 클릭은 복원을 취소하지 않는다.
    if (ev.type === "mousedown") {
      const target = ev.target;
      if (!(target instanceof Element) || target.closest(".xterm-viewport") === null)
        return;
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

  private fit(): void {
    if (this.root.clientWidth === 0 || this.root.clientHeight === 0) return;
    this.fitAddon.fit();
  }
}
