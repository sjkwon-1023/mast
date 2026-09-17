// 탭 화면 — 한 터미널 탭의 현재 화면과 그 탭으로 보내는 입력.
//
// 화면은 **텍스트**로 그린다. 서버가 주는 바이트는 데스크톱과 같은 replay/델타이고
// PTY 의 열 수도 데스크톱 것이라, xterm 으로 그대로 그리면 폰 화면보다 넓어 가로로
// 넘친다. 대신 headless xterm 을 화면 **모델**로만 두고(`@xterm/headless` — DOM 도
// 렌더러도 없다) 그 버퍼의 줄들을 줄바꿈되는 `<pre>` 로 옮긴다. 세로 스크롤만 남고
// 글자 크기는 CSS 라 폰에서 조절할 수 있다 (screen-text.ts).
//
// headless 인스턴스는 입력 경로가 없다 — 데스크톱이 replay 구간에서 막아 두는 단말
// 질의 자동 응답(`ESC[..R`)이 여기서 PTY 로 샐 일도 없다. 입력은 전부 우리 인코더
// (`protocol.ts`)가 만들고, 붙여넣기 감싸기에 필요한 모드는 write 가 끝난 뒤의
// `term.modes` 에서 읽는다 — 그 전까지 입력 컨트롤을 비활성으로 두는 이유다.

import { Terminal } from "@xterm/headless";

import { fetchScreen, HttpError, postInput, postResize } from "./api";
import type { ScreenReply } from "./api";
import { ENTER_DELAY_MS, InputQueue } from "./input-queue";
import type { InputItem } from "./input-queue";
import { measureMobileSize } from "./mobile-size";
import { DEFAULT_MODES } from "./modes";
import type { TerminalModes } from "./modes";
import { PollSchedule } from "./poller";
import {
  encodeInput,
  INITIAL_VIEW_STATE,
  needsRecreate,
  nextRequest,
  screenQuery,
} from "./protocol";
import type { InputAction, SizeOwner } from "./protocol";
import {
  clampFontPx,
  DEFAULT_FONT_PX,
  FONT_STEP_PX,
  joinWrappedRows,
  MAX_SCREEN_LINES,
  tailRange,
  trimTrailingBlank,
} from "./screen-text";
import type { ScreenRow } from "./screen-text";
import type { TabId } from "../shared/types";

const POLL_INTERVAL_MS = 2000;
const FONT_KEY = "mast.remoteFontPx";
/** 이 거리 안이면 "맨 아래를 보고 있다" — 새 출력이 오면 따라 내려간다. */
const STICK_TO_BOTTOM_PX = 24;
/** ▲/▼ 한 번이 보내는 휠 노치 수. TUI 는 대개 노치당 몇 줄씩 움직이므로 다섯이면
 *  반 화면쯤이다 — 한 노치씩 보내면 폴 왕복마다 몇 줄이라 되감기가 쓸 수 없다. */
const WHEEL_NOTCHES_PER_TAP = 5;

export interface TabViewOptions {
  tab: TabId;
  title: string;
  onBack: () => void;
}

export class TabView {
  readonly root: HTMLElement;
  private readonly outputEl: HTMLDivElement;
  private readonly preEl: HTMLPreElement;
  private readonly scrollKeysEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly textEl: HTMLTextAreaElement;
  private readonly mobileBtn: HTMLButtonElement;
  private readonly desktopBtn: HTMLButtonElement;
  private readonly controls: HTMLButtonElement[] = [];
  private readonly schedule: PollSchedule;
  private readonly queue: InputQueue;
  /** 크기 변경 요청이 날아가 있는 동안 true — 버튼 연타가 resize 요청을 겹쳐
   *  보내지 않게 한다 (서버는 멱등이지만 왕복마다 화면이 다시 만들어질 수 있다). */
  private sizeBusy = false;
  /** 페이지가 사라지는 중(`pagehide`) — dispose 를 타지 않는 종료라 따로 듣는다.
   *  브라우저가 탭을 닫거나 앱을 스와이프해 없애는 경로가 여기로 온다. */
  private readonly onPageHide = (): void => {
    if (this.state.sizeOwner === "mobile") this.releaseSizeOnLeave();
  };

  private term: Terminal | null = null;
  private state = { ...INITIAL_VIEW_STATE };
  /** `term.write` 콜백이 돌았나 — 입력 컨트롤의 활성 조건이다. 프로토콜
   *  단계(`state.phase`)와 다르다: 단계는 응답이 오는 즉시 넘어가야 다음
   *  요청이 델타로 나가지만, `term.modes` 는 write 가 끝나야 값이 맞는다. */
  private inputReady = false;
  /** 전송 중인 Send 의 텍스트 항목과 그 원문 — 실패하면 원문을 입력칸에
   *  되돌린다. 폰에서 손으로 친 것이라 실패 한 번에 사라지면 다시 칠 수밖에
   *  없다. 인코딩된 `data` 를 되돌릴 수는 없다 (브래킷 시퀀스가 딸려 온다). */
  private pendingPaste: { item: InputItem; text: string } | null = null;
  /** 이 인스턴스가 `ESC[?1006h` 를 봤나. `term.modes` 는 추적 **모드**만 알려 주고
   *  리포트 **인코딩**은 알려 주지 않아서, 파서를 직접 들여다보는 수밖에 없다. */
  private sgrMouse = false;
  private fontPx = loadFontPx();

  constructor(private readonly options: TabViewOptions) {
    this.root = document.createElement("div");
    this.root.className = "screen tab-screen";

    const header = document.createElement("header");
    header.className = "bar";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "bar-btn";
    back.textContent = "‹ Back";
    back.addEventListener("click", () => this.options.onBack());
    const title = document.createElement("span");
    title.className = "bar-title";
    title.textContent = options.title;
    const refresh = this.headerButton("↻", "bar-btn bar-refresh", () => this.refresh());
    refresh.setAttribute("aria-label", "Refresh screen");
    const zoomOut = this.headerButton("A−", "bar-btn", () => this.adjustFont(-FONT_STEP_PX));
    const zoomIn = this.headerButton("A+", "bar-btn", () => this.adjustFont(FONT_STEP_PX));
    header.append(back, title, refresh, zoomOut, zoomIn);

    this.noticeEl = document.createElement("div");
    this.noticeEl.className = "notice";
    this.noticeEl.hidden = true;

    this.outputEl = document.createElement("div");
    this.outputEl.className = "screen-text";
    this.preEl = document.createElement("pre");
    this.preEl.className = "screen-pre";
    this.outputEl.append(this.preEl);
    this.applyFont();

    this.scrollKeysEl = document.createElement("div");
    this.scrollKeysEl.className = "scroll-keys";
    this.scrollKeysEl.hidden = true;
    this.scrollKeysEl.append(
      this.actionButton("\u25b2", "scroll-key scroll-up", () => this.scrollTui("up")),
      this.actionButton("\u25bc", "scroll-key scroll-down", () => this.scrollTui("down")),
    );
    const screenArea = document.createElement("div");
    screenArea.className = "screen-area";
    screenArea.append(this.outputEl, this.scrollKeysEl);

    const composer = document.createElement("div");
    composer.className = "composer";
    this.textEl = document.createElement("textarea");
    this.textEl.className = "composer-text";
    this.textEl.rows = 2;
    this.textEl.placeholder = "Text to send (empty = Enter)";
    this.textEl.autocapitalize = "off";
    this.textEl.spellcheck = false;
    const send = this.actionButton("Send", "composer-send", () => this.send());
    composer.append(this.textEl, send);

    // 크기 모드 — 여기 두는 이유는 헤더가 이미 Back·제목·↻·A−·A+ 로 좁은 폰 폭에
    // 꽉 차서다. dock 의 첫 줄이라 엄지로 닿고, 키보드가 올라와도 가려지지 않는다.
    const modeRow = document.createElement("div");
    modeRow.className = "mode-row";
    this.mobileBtn = this.modeButton("Mobile", "mode-mobile", () => this.claimMobileSize());
    this.desktopBtn = this.modeButton("Desktop", "mode-desktop", () => this.releaseMobileSize());
    modeRow.append(this.mobileBtn, this.desktopBtn);

    const keys = document.createElement("div");
    keys.className = "keys";
    keys.append(
      this.actionButton("Stop", "key key-stop", () =>
        this.enqueue([{ type: "key", key: "ctrlC" }]),
      ),
      this.actionButton("Esc", "key", () => this.enqueue([{ type: "key", key: "escape" }])),
      this.actionButton("↑", "key key-arrow key-up", () =>
        this.enqueue([{ type: "key", key: "up" }]),
      ),
      this.actionButton("↓", "key key-arrow key-down", () =>
        this.enqueue([{ type: "key", key: "down" }]),
      ),
      this.actionButton("←", "key key-arrow key-left", () =>
        this.enqueue([{ type: "key", key: "left" }]),
      ),
      this.actionButton("→", "key key-arrow key-right", () =>
        this.enqueue([{ type: "key", key: "right" }]),
      ),
    );

    const dock = document.createElement("div");
    dock.className = "dock";
    dock.append(modeRow, composer, keys);

    this.root.append(header, this.noticeEl, screenArea, dock);
    this.setInputEnabled(false);
    this.paintSizeMode(this.state.sizeOwner);
    window.addEventListener("pagehide", this.onPageHide);

    this.schedule = new PollSchedule({
      intervalMs: POLL_INTERVAL_MS,
      poll: (generation) => this.poll(generation),
      onHalt: (reason) => {
        this.setNotice(
          reason === "unauthorized"
            ? "Not authorized — scan the pairing QR in mast again."
            : "Too many requests — retrying in a minute.",
        );
      },
    });
    this.queue = new InputQueue({
      send: (data) => this.sendOne(data),
      onError: (error, item) => this.reportInputError(error, item),
      onIdle: () => {
        this.pendingPaste = null;
        // 방금 보낸 것이 화면에 나타나기까지 폴 간격(2초)을 기다릴 이유가 없다 —
        // 스크롤 버튼은 누른 만큼 화면이 움직여야 다음을 누를지 판단할 수 있다.
        this.schedule.pollNow();
      },
    });
  }

  start(): void {
    this.schedule.start();
  }

  setVisible(visible: boolean): void {
    this.schedule.setVisible(visible);
  }

  dispose(): void {
    // 탭을 떠나면 폰이 소유한 크기를 즉시 돌려준다 — 리스 만료(30초)를 기다리는
    // 동안 데스크톱이 좁은 화면에 갇혀 있을 이유가 없다. keepalive 라 페이지가
    // 사라지는 중에도 요청이 나가고, 실패해도 리스가 결국 정리한다.
    if (this.state.sizeOwner === "mobile") this.releaseSizeOnLeave();
    window.removeEventListener("pagehide", this.onPageHide);
    this.schedule.stop();
    this.queue.clear();
    this.destroyTerminal();
  }

  /** 버튼을 눌러도 입력칸의 포커스를 뺏지 않는다 — 폰에서는 포커스가 옮겨 가는 순간
   *  키보드가 내려가서, 보낼 때마다 다시 띄워야 한다. */
  private actionButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", onClick);
    this.controls.push(button);
    return button;
  }

  /** 크기 모드 버튼 — 포커스를 뺏지 않고, `controls`(입력 준비 게이트)에도 넣지
   *  않는다: 화면이 검거나 오류 안내 상태여도 크기는 되돌릴 수 있어야 한다. */
  private modeButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mode-btn ${className}`;
    button.textContent = label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", onClick);
    return button;
  }

  /** 헤더 버튼 — 포커스를 뺏지 않는 것은 actionButton 과 같지만 `controls`(입력
   *  준비 게이트)에는 넣지 않는다: 글자 크기·새로고침은 입력이 비활성인 상태에서도
   *  눌려야 한다. */
  private headerButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", onClick);
    return button;
  }

  private adjustFont(delta: number): void {
    this.fontPx = clampFontPx(this.fontPx + delta);
    saveFontPx(this.fontPx);
    this.applyFont();
  }

  private applyFont(): void {
    this.preEl.style.fontSize = `${this.fontPx}px`;
  }

  private setNotice(text: string | null): void {
    this.noticeEl.textContent = text ?? "";
    this.noticeEl.hidden = text === null;
  }

  private setInputEnabled(enabled: boolean): void {
    this.inputReady = enabled;
    this.textEl.disabled = !enabled;
    for (const control of this.controls) control.disabled = !enabled;
  }

  /** Mobile — 지금 보이는 출력 영역을 글자 격자로 재서 PTY 를 폰 크기로 줄인다.
   *  측정은 이 순간 한 번뿐이다: 키보드가 열리고 닫혀도 다시 재지 않는다 (모듈
   *  주석 — 흔들리는 크기가 TUI 를 계속 다시 그리게 한다). */
  private claimMobileSize(): void {
    const session = this.state.session;
    if (session === null) {
      this.setNotice("Screen is not ready yet — try again in a moment.");
      return;
    }
    const size = measureMobileSize(this.outputEl, this.preEl);
    if (size === null) {
      // 격자를 못 재는 상태(숨김·폰트 미로딩)에서 크기를 지어내지 않는다.
      this.setNotice("Could not measure the screen — try again.");
      return;
    }
    void this.sendSize("mobile", session, size);
  }

  /** Desktop — 서버가 기억한 **현재 데스크톱 pane 크기**로 복원한다. 폰은 그 값을
   *  보내지 않는다 (모르기 때문이다 — 창 크기는 데스크톱만 안다). */
  private releaseMobileSize(): void {
    const session = this.state.session;
    if (session === null) {
      this.setNotice("Screen is not ready yet — try again in a moment.");
      return;
    }
    void this.sendSize("desktop", session);
  }

  private async sendSize(
    mode: SizeOwner,
    session: string,
    size?: { cols: number; rows: number },
  ): Promise<void> {
    if (this.sizeBusy) return;
    this.sizeBusy = true;
    try {
      const reply = await postResize(this.options.tab, session, mode, size);
      // 서버가 적용했다고 말한 소유자로 곧바로 칠한다 — 다음 폴(2초)까지 버튼이
      // 눌린 채로 있지 않게. 실제 크기·소유자는 다음 meta 가 다시 확인해 준다.
      this.paintSizeMode(reply.owner);
      this.setNotice(null);
      this.schedule.pollNow();
    } catch (error) {
      this.handleSizeError(error);
    } finally {
      this.sizeBusy = false;
    }
  }

  /** 탭을 떠나며 보내는 해제 — 실패해도 조용하다 (리스가 최종 안전망이고, 그
   *  사이 사용자가 보는 화면이 없다). */
  private releaseSizeOnLeave(): void {
    const session = this.state.session;
    if (session === null) return;
    void postResize(this.options.tab, session, "desktop", undefined, { keepalive: true }).catch(
      () => undefined,
    );
  }

  private paintSizeMode(owner: SizeOwner): void {
    this.mobileBtn.setAttribute("aria-pressed", String(owner === "mobile"));
    this.desktopBtn.setAttribute("aria-pressed", String(owner === "desktop"));
  }

  private async poll(generation: number): Promise<void> {
    try {
      const reply = await fetchScreen(this.options.tab, screenQuery(this.state));
      // 늦게 도착한 이전 세대의 응답은 지금 화면과 무관하다.
      if (!this.schedule.isCurrent(generation)) return;
      this.apply(reply);
      this.setNotice(null);
    } catch (error) {
      if (!this.schedule.isCurrent(generation)) return;
      this.handleScreenError(error);
    }
  }

  private apply(reply: ScreenReply): void {
    const { meta, bytes } = reply;
    if (this.state.phase === "full") {
      // 서버 계약상 `since` 없는 요청의 응답은 항상 reset 이다. 아니면 화면을
      // 세울 수 없으므로 상태를 그대로 두고 다음 폴에서 다시 요청한다.
      if (meta.reset) {
        this.createTerminal(meta.cols, meta.rows, bytes);
      }
    } else if (needsRecreate(this.state, meta)) {
      // 이어 붙일 수 없는 응답이다 — 받은 바이트를 버리고 인스턴스를 접는다.
      // 다음 폴이 `since` 없이 나가 새 스냅샷으로 다시 세운다.
      this.destroyTerminal();
    } else if (bytes.length > 0) {
      this.write(bytes);
    }
    this.state = nextRequest(this.state, meta);
    this.paintSizeMode(this.state.sizeOwner);
  }

  private createTerminal(cols: number, rows: number, bytes: Uint8Array): void {
    this.destroyTerminal();
    // 크기는 서버(PTY)의 것 — 그래야 replay 가 데스크톱과 같은 줄로 접힌다. 화면에
    // 보이는 줄바꿈은 그 위에 CSS 가 한 번 더 접는 것이다.
    // `allowProposedApi` 는 headless 쪽의 차이다: `@xterm/headless` 5.5.0 은 `buffer`
    // getter 를 proposed API 로 게이트해 두어 이 옵션 없이는 접근 자체가 던진다 —
    // 같은 5.5.0 의 `@xterm/xterm` 은 게이트하지 않아 데스크톱에서는 드러나지 않았다
    // (v0.3.18 필드: 검은 화면에 입력 비활성). `modes` 는 게이트되지 않는다.
    const term = new Terminal({
      cols,
      rows,
      scrollback: MAX_SCREEN_LINES,
      allowProposedApi: true,
    });
    // 스냅샷 앞에는 서버가 붙인 DEC private mode 재선언이 온다 (ADR-0015) — 켜져
    // 있던 인코딩은 이 인스턴스에도 곧 다시 알려지므로 꺼진 채로 시작하면 된다.
    this.sgrMouse = false;
    const trackSgrMouse = (on: boolean) => (params: (number | number[])[]) => {
      // 서브파라미터가 있으면 그 자리가 배열로 오므로 숫자만 본다.
      if (params.some((param) => param === 1006)) this.sgrMouse = on;
      // false 를 돌려줘야 xterm 의 기본 처리로 넘어간다 — 여기서 true 를 돌려주면
      // 이 시퀀스가 우리 것으로 소비돼 `term.modes` 가 영영 갱신되지 않는다.
      return false;
    };
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, trackSgrMouse(true));
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, trackSgrMouse(false));
    this.term = term;
    this.write(bytes, () => this.setInputEnabled(true));
  }

  private write(bytes: Uint8Array, then?: () => void): void {
    const term = this.term;
    if (term === null) return;
    const generation = this.schedule.generation;
    term.write(bytes, () => {
      if (!this.schedule.isCurrent(generation) || this.term !== term) return;
      // 이 콜백은 xterm 의 write 루프 안에서 돈다. 여기서 던지면 루프가 그 항목을
      // 넘기지 못한 채 멈추고 이후의 write 는 영영 처리되지 않는다 — 안내문도 없이
      // 검은 화면만 남는다. 실패는 안내문으로 드러내고 루프는 살려 둔다.
      try {
        this.render(term);
        then?.();
      } catch (error) {
        console.error("screen render failed", error);
        this.setNotice(`Screen render failed: ${describeError(error)}`);
      }
    });
  }

  /** 맨 아래를 보고 있었으면 따라 내려간다 — 위로 올려 읽는 중이면 자리를 지킨다. */
  private render(term: Terminal): void {
    const buffer = term.buffer.active;
    const [start, end] = tailRange(buffer.length, MAX_SCREEN_LINES);
    const rows: ScreenRow[] = [];
    for (let y = start; y < end; y += 1) {
      const line = buffer.getLine(y);
      // trimRight 없이 — 이어 붙일 행의 끝 공백을 살린다. 잘라 내는 것은 joinWrappedRows.
      rows.push({ text: line?.translateToString(false) ?? "", wrapped: line?.isWrapped ?? false });
    }
    const lines = joinWrappedRows(rows);
    const out = this.outputEl;
    const atBottom =
      out.scrollHeight - out.scrollTop - out.clientHeight <= STICK_TO_BOTTOM_PX;
    this.preEl.textContent = trimTrailingBlank(lines).join("\n");
    if (atBottom) out.scrollTop = out.scrollHeight;
    // 대체 화면에는 스크롤백이 없어 우리가 가진 것은 뷰포트 한 장뿐이고, 이전
    // 내역은 TUI 만 되감을 수 있다. 마우스 추적도 같이 보는 것은 1049 가 재선언
    // 대상이 아니어서다 (ADR-0015) — 오래 돈 탭은 `?1049h` 가 replay 창 밖으로
    // 밀려 여기서는 일반 버퍼로 보이지만, 그 안의 TUI 는 여전히 휠을 기다린다.
    const alt = buffer.type === "alternate";
    const mouse = term.modes.mouseTrackingMode !== "none";
    this.scrollKeysEl.hidden = !(alt || mouse);
  }

  /** ▲/▼ — 대체 화면 안에서 도는 프로그램에게 "되감아라"라고 말하는 두 방법.
   *
   *  Claude Code·Codex 는 SGR 마우스 추적을 켜고 휠 리포트로 스크롤한다. less·vim
   *  처럼 마우스를 켜지 않는 프로그램은 PageUp/PageDown 을 받는다.
   *
   *  추적이 켜졌는데 SGR 이 아니면 키로 폴백한다 — 옛 X10 인코딩(`ESC[M` 뒤에
   *  좌표를 실은 원시 바이트)은 절대 보내지 않는다. 좌표가 223 열에서 끊기고,
   *  받는 쪽이 그 형식을 읽지 않으면 그 바이트들이 그대로 입력으로 남는다. */
  private scrollTui(direction: "up" | "down"): void {
    const term = this.term;
    if (term !== null && term.modes.mouseTrackingMode !== "none" && this.sgrMouse) {
      this.enqueue([
        {
          type: "wheel",
          direction,
          // 화면 한가운데를 가리킨다 — TUI 는 휠 리포트의 좌표로 어느 영역을
          // 스크롤할지 고르고, 가장자리는 입력창이나 상태줄일 수 있다.
          col: Math.max(1, Math.floor(this.state.cols / 2)),
          row: Math.max(1, Math.floor(this.state.rows / 2)),
          notches: WHEEL_NOTCHES_PER_TAP,
        },
      ]);
      return;
    }
    this.enqueue([{ type: "key", key: direction === "up" ? "pageUp" : "pageDown" }]);
  }

  private destroyTerminal(): void {
    // 세대를 올려 이 인스턴스로 향하던 응답·write 콜백을 전부 무효화한다.
    this.schedule.bumpGeneration();
    this.setInputEnabled(false);
    this.term?.dispose();
    this.term = null;
  }

  private modes(): TerminalModes {
    const modes = this.term?.modes;
    if (modes === undefined) return DEFAULT_MODES;
    return {
      bracketedPasteMode: modes.bracketedPasteMode,
      applicationCursorKeysMode: modes.applicationCursorKeysMode,
    };
  }

  /** Send = 텍스트 한 번, 그 응답 뒤 CR 한 번 (ADR-0016 결정 7). 두 요청으로 나누고
   *  사이를 벌리는 이유는 `input-queue.ts` 모듈 주석에 있다. 빈 입력칸의 Send 는
   *  Enter 하나다 — 확인 프롬프트에 답할 때 쓴다. */
  private send(): void {
    const text = this.textEl.value;
    if (text === "") {
      this.enqueue([{ type: "key", key: "enter" }]);
      return;
    }
    const items = this.enqueue([
      { type: "paste", text },
      { type: "key", key: "enter" },
    ]);
    if (items.length === 0) return;
    this.pendingPaste = { item: items[0], text };
    this.textEl.value = "";
  }

  /** 입력 컨트롤이 아직 비활성이면 빈 배열. 두 번째 이후 항목의 지연이 CR 을
   *  텍스트에서 떼어 놓는 간격이다. */
  private enqueue(actions: InputAction[]): InputItem[] {
    if (!this.inputReady) return [];
    const modes = this.modes();
    const items = actions.map((action, index) => ({
      data: encodeInput(action, modes),
      delayBeforeMs: index === 0 ? undefined : ENTER_DELAY_MS,
    }));
    this.queue.push(...items);
    return items;
  }

  private async sendOne(data: string): Promise<void> {
    const session = this.state.session;
    if (session === null) throw new Error("no session for this tab");
    await postInput(this.options.tab, session, data);
  }

  /** 이미 아무것도 없으면 건드리지 않는다 — 실패가 2초마다 반복되는 동안
   *  세대만 계속 올리게 된다. */
  private resetToFull(): void {
    if (this.term === null) return;
    this.destroyTerminal();
    this.state = { ...INITIAL_VIEW_STATE };
  }

  /** 데스크톱 Ctrl+Shift+R(WebView 리로드) 에 대응하는 폰 쪽 동작 — 페이지는
   *  그대로 두고 클라이언트만 다시 동기화한다. `controls` 밖에 있어 화면이
   *  검거나 오류 notice 상태(입력 비활성)에서도 눌린다. */
  private refresh(): void {
    this.setNotice(null);
    this.resetToFull();
    this.schedule.pollNow();
  }

  private reportInputError(error: unknown, item: InputItem): void {
    // 실패한 것이 Send 의 텍스트였다면 원문을 입력칸에 되돌린다 — 그 사이
    // 사용자가 다른 것을 치고 있으면 덮어쓰지 않는다.
    const pending = this.pendingPaste;
    this.pendingPaste = null;
    if (pending !== null && pending.item === item && this.textEl.value === "") {
      this.textEl.value = pending.text;
    }
    if (error instanceof HttpError) {
      this.schedule.noteStatus(error.status);
      // 409 는 이 탭의 셸이 갈렸다는 뜻이다 — 보고 있던 화면이 더는 그 셸이
      // 아니므로 인스턴스를 접고 다음 폴이 새 스냅샷을 받게 한다.
      if (error.status === 409) this.resetToFull();
      this.setNotice(inputErrorText(error.status));
      return;
    }
    this.setNotice("Could not reach mast — check the connection.");
  }

  private handleSizeError(error: unknown): void {
    if (error instanceof HttpError) {
      this.schedule.noteStatus(error.status);
      // 409 는 이 탭의 셸이 갈렸다는 뜻이다 — 화면도 그 셸의 것이 아니므로
      // 입력 실패와 같은 정리(인스턴스 폐기)를 한다.
      if (error.status === 409) this.resetToFull();
      this.setNotice(sizeErrorText(error.status));
      return;
    }
    this.setNotice("Could not resize — check the connection.");
  }

  private handleScreenError(error: unknown): void {
    if (error instanceof HttpError) {
      this.schedule.noteStatus(error.status);
      // 탭이 사라졌거나 셸이 없다 — 들고 있던 화면은 더는 유효하지 않다.
      if (error.status === 409 || error.status === 404) this.resetToFull();
      if (error.status !== 401 && error.status !== 429) {
        this.setNotice(screenErrorText(error.status));
      }
      return;
    }
    this.setNotice("Could not reach mast — retrying.");
  }
}

/** localStorage 는 프라이빗 모드·차단 설정에서 접근 자체가 던진다 — 기본 크기로
 *  진행하면 되고 페이지가 죽을 일은 아니다. */
function loadFontPx(): number {
  try {
    const raw = window.localStorage.getItem(FONT_KEY);
    return raw === null ? DEFAULT_FONT_PX : clampFontPx(Number(raw));
  } catch {
    return DEFAULT_FONT_PX;
  }
}

function saveFontPx(px: number): void {
  try {
    window.localStorage.setItem(FONT_KEY, String(px));
  } catch {
    // 저장이 안 되면 이번 세션에만 유효한 크기가 된다 — 조용히 진행한다.
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function screenErrorText(status: number): string {
  switch (status) {
    case 404:
      return "This tab is gone.";
    case 409:
      return "This tab has no running shell.";
    default:
      return `mast replied ${status}.`;
  }
}

function inputErrorText(status: number): string {
  switch (status) {
    case 401:
      return "Not authorized — scan the pairing QR in mast again.";
    case 409:
      return "The shell restarted — input was not sent.";
    case 413:
      return "That text is too long to send.";
    case 429:
      return "Too many requests — try again in a minute.";
    default:
      return `Input failed (${status}).`;
  }
}

function sizeErrorText(status: number): string {
  switch (status) {
    case 401:
      return "Not authorized — scan the pairing QR in mast again.";
    case 404:
      return "This tab is gone.";
    case 409:
      return "The shell restarted — the screen size was not changed.";
    case 429:
      return "Too many requests — try again in a minute.";
    default:
      return `Resize failed (${status}).`;
  }
}
