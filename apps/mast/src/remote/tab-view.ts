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
import { isInputWriteTimedOut, RemoteError, TransportClosedError } from "./transport";
import type { FontPxStore, RemoteTransport, ScreenReply } from "./transport";
import type { TabId } from "../shared/types";

const POLL_INTERVAL_MS = 2000;
/** 이 거리 안이면 "맨 아래를 보고 있다" — 새 출력이 오면 따라 내려간다. */
const STICK_TO_BOTTOM_PX = 24;
/** ▲/▼ 한 번이 보내는 휠 노치 수. TUI 는 대개 노치당 몇 줄씩 움직이므로 다섯이면
 *  반 화면쯤이다 — 한 노치씩 보내면 폴 왕복마다 몇 줄이라 되감기가 쓸 수 없다. */
const WHEEL_NOTCHES_PER_TAP = 5;

export interface TabViewOptions {
  tab: TabId;
  title: string;
  onBack: () => void;
  /** 화면·입력 네트워크 — Local HTTP 와 Secure Remote 가 각자의 구현을 넣는다. */
  transport: RemoteTransport;
  /** 글자 크기 기억. 없으면 이 화면이 살아 있는 동안만 기억한다 (Secure Remote). */
  fontPx?: FontPxStore;
}

export class TabView {
  readonly root: HTMLElement;
  private readonly outputEl: HTMLDivElement;
  private readonly preEl: HTMLPreElement;
  private readonly scrollKeysEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  /** 입력칸에 넣지 못한 원문을 보이는 자리 — 연결이 끊긴 뒤에는 입력칸이
   *  비활성이라 `input` 이벤트가 다시 오지 않으므로, 여기 없으면 원문은
   *  사용자에게서 사라진다. */
  private readonly recoveryEl: HTMLDivElement;
  private readonly textEl: HTMLTextAreaElement;
  private readonly mobileBtn: HTMLButtonElement;
  private readonly desktopBtn: HTMLButtonElement;
  private readonly controls: HTMLButtonElement[] = [];
  private readonly schedule: PollSchedule;
  private readonly queue: InputQueue;
  /** 크기 변경 요청이 날아가 있는 동안 true — 버튼 연타가 resize 요청을 겹쳐
   *  보내지 않게 한다 (서버는 멱등이지만 왕복마다 화면이 다시 만들어질 수 있다). */
  private sizeBusy = false;
  /** 페이지가 사라지는 중(`dispose` 또는 `pagehide`) — 그 뒤에 도착한 크기 요청의
   *  성공을 여기서 되돌려야 하는지 가른다 (성공 직후 이탈·진행 중 이탈 모두). */
  private left = false;
  /** 성공한 크기 요청이 소유자를 바꾼 횟수. 그보다 먼저 나간 화면 폴의 응답은
   *  이미 옛 소유자를 싣고 있다 — 그 값으로 현재 소유자를 되돌리지 않는다
   *  (`poll` 의 요청 시점 캡처). */
  private ownerEpoch = 0;
  /** 서버가 마지막으로 말한 셸의 세션 토큰 — 화면 동기화의 `state.session` 과
   *  분리한다. `nextRequest` 는 재생성이 필요하면 `state.session` 을 비워 다음
   *  폴이 `since` 없이 나가게 하는데, 그 순간에도 진행 중인 크기 요청이 옛 셸의
   *  것인지 판정할 좌표가 필요하다 (`sendSize` 의 stale 판정). */
  private knownSession: string | null = null;
  /** 이탈 때 desktop 복원을 보낼 세션 — 서버가 mobile 소유라고 확인해 준 셸이다.
   *  ↻(`resetToFull`)는 화면 상태만 버리므로 이 값은 남긴다: 새 화면 응답이 오기
   *  전에 떠나도 서버의 소유권은 그대로라 해제가 나가야 한다. */
  private releaseSession: string | null = null;
  /** 해제 좌표를 대입한 횟수 — 해제 요청은 보낼 때의 값을 캡처하고 응답 시점에
   *  그대로일 때만 좌표를 지운다. 같은 세션 재주장도 새 대입이라, 늦은 응답이
   *  새 주장의 좌표를 지우지 않는다. */
  private releaseEpoch = 0;
  /** 페이지가 사라지는 중(`pagehide`) — dispose 를 타지 않는 종료라 따로 듣는다.
   *  브라우저가 탭을 닫거나 앱을 스와이프해 없애는 경로가 여기로 온다. */
  private readonly onPageHide = (): void => {
    this.left = true;
    this.releaseSizeOnLeave();
  };
  /** bfcache 복원(`pageshow`) — 떠남 표시를 내린다. 표시가 남으면 되살아난 페이지의
   *  새 주장이 성공하는 즉시 되돌려져 폰이 소유를 가질 수 없다 (이 리스너는 로드
   *  뒤에 붙으므로 정상 로드의 pageshow 는 듣지 않는다). */
  private readonly onPageShow = (): void => {
    this.left = false;
  };

  private term: Terminal | null = null;
  /** 연결 종료·dispose 뒤에는 true. `PollSchedule.stop()` 은 세대를 올리지 않으므로
   *  이것이 없으면 이미 나간 screen 응답과 그 write 콜백이 종료 안내를 지우거나
   *  입력을 다시 켤 수 있다 — 종료는 한 방향이어야 한다. */
  private closed = false;
  /** `dispose()` 로 화면 자체가 사라졌나. `closed` 는 transport 종료에도 서는데,
   *  그때와 달리 사용자가 떠난 뒤에는 남겨 둘 화면이 없다. */
  private disposed = false;
  private state = { ...INITIAL_VIEW_STATE };
  /** `term.write` 콜백이 돌았나 — 입력 컨트롤의 활성 조건이다. 프로토콜
   *  단계(`state.phase`)와 다르다: 단계는 응답이 오는 즉시 넘어가야 다음
   *  요청이 델타로 나가지만, `term.modes` 는 write 가 끝나야 값이 맞는다. */
  private inputReady = false;
  /** 전송 중인 Send 의 텍스트 항목과 그 원문 — 실패하면 원문을 입력칸에
   *  되돌린다. 폰에서 손으로 친 것이라 실패 한 번에 사라지면 다시 칠 수밖에
   *  없다. 인코딩된 `data` 를 되돌릴 수는 없다 (브래킷 시퀀스가 딸려 온다). */
  private pendingPaste: { item: InputItem; text: string } | null = null;
  /** 전송에 실패했지만 입력칸이 비어 있지 않아 곧바로 되돌리지 못한 원문.
   *  사용자가 새로 치는 중인 텍스트를 덮어쓰지 않으면서도 실패 원문을 잃지
   *  않으려고, 입력칸이 비는 순간 되돌린다. */
  private failedPasteText: string | null = null;
  /** 배달 불확실 경고가 떠 있나 — 성공한 화면 폴은 2초마다 오므로, 그때마다
   *  이 경고를 지우면 사용자가 읽고 판단할 시간이 없다. 사용자가 직접 다시
   *  보내거나 새로고침할 때, 또는 더 강한 오류가 덮을 때만 사라진다. */
  private stickyNotice = false;
  /** 이 인스턴스가 `ESC[?1006h` 를 봤나. `term.modes` 는 추적 **모드**만 알려 주고
   *  리포트 **인코딩**은 알려 주지 않아서, 파서를 직접 들여다보는 수밖에 없다. */
  private sgrMouse = false;
  private fontPx: number;
  private readonly unsubscribeClosed: (() => void) | null;

  constructor(private readonly options: TabViewOptions) {
    this.fontPx = clampFontPx(options.fontPx?.load() ?? DEFAULT_FONT_PX);
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

    this.recoveryEl = document.createElement("div");
    this.recoveryEl.className = "recovery";
    this.recoveryEl.hidden = true;
    const recoveryLabel = document.createElement("div");
    recoveryLabel.className = "recovery-label";
    // "보내지 않았다"라고 단정하지 않는다 — 연결 종료로 실패한 입력도 서버에는
    // 이미 닿았을 수 있다 (입력칸에서 밀려난 원문을 보여 주는 자리일 뿐이다).
    recoveryLabel.textContent = "Unsaved draft — copy it before leaving:";
    this.recoveryEl.append(recoveryLabel);

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
    this.textEl.addEventListener("input", () => this.restoreFailedTextIfEmpty());
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
    if (this.options.transport.postResize) dock.append(modeRow);
    dock.append(composer, keys);

    this.root.append(header, this.noticeEl, this.recoveryEl, screenArea, dock);
    this.setInputEnabled(false);
    this.paintSizeMode(this.state.sizeOwner);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);

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
        // 늦은 성공도 종료를 되돌리지 못한다.
        if (this.closed) return;
        // 방금 보낸 것이 화면에 나타나기까지 폴 간격(2초)을 기다릴 이유가 없다 —
        // 스크롤 버튼은 누른 만큼 화면이 움직여야 다음을 누를지 판단할 수 있다.
        this.schedule.pollNow();
      },
    });
    this.unsubscribeClosed =
      options.transport.onClosed?.((message) => this.handleTransportClosed(message)) ?? null;
  }

  start(): void {
    this.schedule.start();
  }

  setVisible(visible: boolean): void {
    this.schedule.setVisible(visible);
  }

  dispose(): void {
    // 떠남을 먼저 표시한다 — 해제 판정은 지금 상태만 보므로, 날아가 있는 주장이
    // 이 뒤에 성공하면 sendSize 의 이탈 분기가 그 주장을 되돌린다.
    this.left = true;
    // 탭을 떠나면 폰이 소유한 크기를 즉시 돌려준다 — 리스 만료(30초)를 기다리는
    // 동안 데스크톱이 좁은 화면에 갇혀 있을 이유가 없다. keepalive 라 페이지가
    // 사라지는 중에도 요청이 나가고, 실패해도 리스가 결국 정리한다. 판정·좌표는
    // `releaseSession` 이다 — ↻ 로 화면 상태가 초기화돼도 남아 있다.
    this.releaseSizeOnLeave();
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    this.disposed = true;
    this.closed = true;
    this.unsubscribeClosed?.();
    this.schedule.stop();
    this.queue.clear();
    this.destroyTerminal();
  }

  /** transport 가 끝났다 — 폴링·입력을 멈추고 안내만 남긴다 (자동 재연결 없음).
   *  `closed` 를 세우므로 뒤늦게 정착하는 어떤 콜백도 이 상태를 되돌리지 못한다. */
  private handleTransportClosed(message: string): void {
    this.closed = true;
    this.schedule.stop();
    this.setInputEnabled(false);
    // 비활성 입력칸의 글자는 폰에서 선택·복사가 되지 않는다 — 입력칸을 비우고
    // 남아 있는 초안을 전부 읽기 전용 복구 상자로 옮긴다. 대상은 둘: 입력칸에
    // 남은 새 초안과, 입력칸이 비기를 기다리던 실패 원문(더 오래된 것). 아직
    // 비행 중인 Send 의 원문은 나중에 도착하는 거절이 그 뒤에 덧붙인다
    // (`reportInputError` 의 closed 경로). 두 번째 종료 알림은 옮길 것이 없어
    // 아무것도 복제하지 않는다 — 입력칸은 이미 비었고 보관분도 비었다.
    const newer = this.textEl.value;
    const waiting = this.failedPasteText;
    this.failedPasteText = null;
    this.textEl.value = "";
    if (newer !== "") this.keepDraft(newer);
    if (waiting !== null) this.keepDraft(waiting);
    this.setNotice(message);
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
    this.options.fontPx?.save(this.fontPx);
    this.applyFont();
  }

  private applyFont(): void {
    this.preEl.style.fontSize = `${this.fontPx}px`;
  }

  /** `tone: "warn"` 은 배달 불확실 경고다 — 화면 폴 성공의 `setNotice(null)` 이
   *  이 경고만은 지우지 못한다. 다른 안내는 예전처럼 다음 성공 폴이 지운다. */
  private setNotice(text: string | null, tone: "error" | "warn" = "error"): void {
    if (text === null && this.stickyNotice) return;
    this.noticeEl.textContent = text ?? "";
    this.noticeEl.hidden = text === null;
    this.noticeEl.classList.toggle("notice-warn", text !== null && tone === "warn");
    this.stickyNotice = text !== null && tone === "warn";
  }

  /** 사용자가 직접 움직였다(새 Send·↻) — 남아 있는 안내를 지운다. */
  private dismissNotice(): void {
    this.stickyNotice = false;
    this.setNotice(null);
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
    if (this.closed || this.sizeBusy || !this.options.transport.postResize) return;
    this.sizeBusy = true;
    try {
      const reply = await this.options.transport.postResize!(this.options.tab, session, mode, size);
      // 응답이 오는 사이 화면이 다른 셸로 갈렸다면(탭 Restart) 이 응답은 옛 셸의
      // 것이다 — 새 화면의 소유자도 해제 좌표도 이 응답으로 정하지 않는다.
      const stale = this.knownSession !== null && this.knownSession !== session;
      if (!stale) {
        // 서버가 적용했다고 답한 소유자를 버튼 페인트에만 쓰지 않고 **수명 상태에도**
        // 반영한다 — 그러지 않으면 다음 폴(2초) 전에 Back/pagehide 로 떠날 때 이미
        // 폰 소유인데도 해제 요청이 나가지 않아 데스크톱이 리스 만료까지 좁은 채로
        // 남는다. 화면 인스턴스의 cols/rows 는 건드리지 않는다: 실제 격자는 다음
        // 폴의 meta 가 정한다 (먼저 바꾸면 needsRecreate 판정이 어긋난다).
        this.state = { ...this.state, sizeOwner: reply.owner };
        this.ownerEpoch += 1;
        // 해제 좌표는 **요청 시점의 세션**으로 잡는다 — 응답이 오는 사이 ↻ 가
        // 화면 상태를 비웠을 수 있다 (그래도 서버에는 이 세션의 소유권이 있다).
        this.setReleaseSession(reply.owner === "mobile" ? session : null);
      }
      if (this.left) {
        // 요청이 날아가 있는 사이 페이지를 떠났다 — 방금 성공한 주장을 여기서
        // 되돌린다. 해제 요청이 실패해도 성공으로 속이지 않는다: 소유자 상태는
        // 서버 응답으로만 바뀌고, 최종 안전망은 리스 만료다.
        if (reply.owner === "mobile" && !stale) this.releaseSizeOnLeave();
        return;
      }
      if (stale) return;
      // 다음 폴(2초)까지 버튼이 눌린 채로 있지 않게. 실제 크기·소유자는 다음
      // meta 가 다시 확인해 준다.
      this.paintSizeMode(reply.owner);
      this.setNotice(null);
      this.schedule.pollNow();
    } catch (error) {
      // 페이지가 이미 떠났으면 안내를 띄울 표면이 없다 — 실패를 화면에 남기지
      // 않고 리스 만료에 맡긴다.
      if (!this.left) this.handleSizeError(error);
    } finally {
      this.sizeBusy = false;
    }
  }

  /** 해제 좌표를 바꾸고 세대를 올린다 — 올리는 이유는 `releaseSizeOnLeave`. */
  private setReleaseSession(session: string | null): void {
    this.releaseSession = session;
    this.releaseEpoch += 1;
  }

  /** 탭을 떠나며 보내는 해제 — 실패해도 조용하다 (리스가 최종 안전망이고, 그
   *  사이 사용자가 보는 화면이 없다). 서버가 데스크톱이라고 **확인해 준** 경우에만
   *  좌표를 지우므로, 실패한 해제는 다음 이탈·다음 폴에서 다시 시도된다. */
  private releaseSizeOnLeave(): void {
    const session = this.releaseSession;
    if (session === null || !this.options.transport.postResize) return;
    // 보낼 때의 세대를 캡처한다 — 응답이 도착했을 때 세대가 그대로이고 좌표도
    // 같은 세션이어야 이 해제가 지금 좌표를 지울 자격이 있다. bfcache 복원 뒤
    // 같은 세션으로 다시 주장했다면 세대가 달라, 늦은 해제 응답이 새 주장의
    // 좌표를 지우지 않는다 (지우면 다음 이탈이 데스크톱으로 못 되돌린다).
    const epoch = this.releaseEpoch;
    void this.options.transport.postResize!(this.options.tab, session, "desktop", undefined, { keepalive: true })
      .then((reply) => {
        if (
          reply.owner === "desktop" &&
          this.releaseEpoch === epoch &&
          this.releaseSession === session
        ) {
          this.setReleaseSession(null);
        }
      })
      .catch(() => undefined);
  }

  private paintSizeMode(owner: SizeOwner): void {
    this.mobileBtn.setAttribute("aria-pressed", String(owner === "mobile"));
    this.desktopBtn.setAttribute("aria-pressed", String(owner === "desktop"));
  }

  private async poll(generation: number): Promise<void> {
    // 이 요청이 나가기 전에 성공한 크기 변경이 있는지는 요청 시점으로 판정한다 —
    // 응답이 그 뒤에 도착해도 그 응답의 소유자는 이미 옛 값이다 (apply).
    const ownerEpoch = this.ownerEpoch;
    try {
      const reply = await this.options.transport.fetchScreen(
        this.options.tab,
        screenQuery(this.state),
      );
      // 늦게 도착한 이전 세대의 응답은 지금 화면과 무관하다. 종료 뒤에 정착한
      // 응답도 마찬가지다 — `stop()` 은 세대를 올리지 않는다.
      if (this.closed || !this.schedule.isCurrent(generation)) return;
      this.apply(reply, ownerEpoch);
      this.setNotice(null);
    } catch (error) {
      if (this.closed || !this.schedule.isCurrent(generation)) return;
      this.handleScreenError(error);
    }
  }

  private apply(reply: ScreenReply, ownerEpoch: number): void {
    const { bytes } = reply;
    // 이 응답이 나간 뒤에 성공한 크기 변경이 있으면 소유자만 로컬 값을 지킨다 —
    // 서버도 그 변경으로 소유자가 바뀌었는데, 그 전에 만들어진 이 응답으로
    // 되돌리면 폰이 이미 소유 중인데 버튼·이탈 해제가 데스크톱으로 판단한다.
    // 크기·세션은 그대로 응답을 따르고, 소유자는 다음 폴이 다시 확인해 준다.
    const trusted = ownerEpoch === this.ownerEpoch;
    const meta = trusted ? reply.meta : { ...reply.meta, sizeOwner: this.state.sizeOwner };
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
    this.knownSession = meta.session;
    this.state = nextRequest(this.state, meta);
    if (trusted) {
      // 서버가 확인해 준 소유자·세션이 해제 좌표다 — 리스 만료나 다른 폰의 조작은
      // 서버에서 일어나므로 폴의 응답만이 그것을 알려 준다.
      this.setReleaseSession(meta.sizeOwner === "mobile" ? meta.session : null);
    }
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
      // 이 콜백은 macrotask 로 미뤄질 수 있다(WriteBuffer) — 그 사이 종료가 왔다면
      // render 도, 입력 활성화도 종료 상태를 되돌리지 못하게 한다.
      if (this.closed || !this.schedule.isCurrent(generation) || this.term !== term) return;
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
      if (this.enqueue([{ type: "key", key: "enter" }]).length === 0) return;
      // 빈 입력칸의 Send(Enter)도 사용자의 결정이다 — 경고를 치운다.
      this.dismissNotice();
      return;
    }
    // 앞선 Send 가 아직 in-flight 인데 새 초안을 큐에 넣으면 `pendingPaste` 가 이
    // 초안으로 덮어써지고, 앞 요청이 실패하는 순간 큐가 뒤 항목을 버려서 두 원문
    // 중 어느 것도 `reportInputError` 의 item 비교에 걸리지 않는다 — 둘 다 사라진다.
    // 입력칸을 비우지 않고 기다리라고 알린다: 앞 요청이 정착하면 같은 Send 가 그대로
    // 동작한다 (성공이면 방금 그 초안이, 실패면 원문 복구 뒤 초안이 남는다).
    if (this.queue.busy) {
      this.setNotice("Still sending the previous input — wait a moment, then press Send again.");
      return;
    }
    const items = this.enqueue([
      { type: "paste", text },
      { type: "key", key: "enter" },
    ]);
    if (items.length === 0) return;
    // 다시 보내는 것은 사용자의 결정이다 — 배달 불확실 경고는 여기서 사라진다.
    // 이 Send 가 곧바로 같은 타임아웃으로 실패하면 경고는 다시 뜬다.
    this.dismissNotice();
    this.pendingPaste = { item: items[0], text };
    this.textEl.value = "";
    // 프로그램이 값을 비우면 DOM `input` 이벤트가 오지 않는다 — 보관해 둔 실패
    // 원문이 있다면 여기서 직접 되돌려야 한다. 아니면 이 Send 가 성공했을 때
    // 그 원문은 입력칸이 다시 빌 때까지 영영 보이지 않는다.
    this.restoreFailedTextIfEmpty();
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
    await this.options.transport.postInput(this.options.tab, session, data);
  }

  /** 이미 아무것도 없으면 건드리지 않는다 — 실패가 2초마다 반복되는 동안
   *  세대만 계속 올리게 된다. `keepOwnership` 은 ↻(화면만 다시 맞춤)용이다:
   *  셸이 갈린 409·404 에서는 서버의 소유권도 사라졌으므로 좌표를 버린다. */
  private resetToFull(keepOwnership = false): void {
    if (!keepOwnership) {
      this.knownSession = null;
      this.setReleaseSession(null);
    }
    if (this.term === null) return;
    this.destroyTerminal();
    this.state = { ...INITIAL_VIEW_STATE };
  }

  /** 데스크톱 Ctrl+Shift+R(WebView 리로드) 에 대응하는 폰 쪽 동작 — 페이지는
   *  그대로 두고 클라이언트만 다시 동기화한다. `controls` 밖에 있어 화면이
   *  검거나 오류 notice 상태(입력 비활성)에서도 눌린다. 종료 뒤에는 누를 것이
   *  없다 — 종료 안내를 지우지 않도록 아무 일도 하지 않는다. */
  private refresh(): void {
    if (this.closed) return;
    // 사용자가 직접 다시 동기화를 골랐다 — 배달 불확실 경고도 여기서 치운다.
    this.dismissNotice();
    this.resetToFull(true);
    this.schedule.pollNow();
  }

  /** 실패한 Send 원문을 잃지 않게 되돌린다. 입력칸이 비어 있으면 그 자리에,
   *  사용자가 새로 치는 중이면(덮어쓰면 안 된다) 보관해 두었다가 입력칸이 비는
   *  순간 되돌린다 — 어느 쪽이든 사용자가 친 텍스트는 그대로 남는다. */
  private restoreFailedTextIfEmpty(): void {
    if (this.failedPasteText === null || this.textEl.value !== "") return;
    this.textEl.value = this.failedPasteText;
    this.failedPasteText = null;
  }

  private reportInputError(error: unknown, item: InputItem): void {
    // 실패한 것이 Send 의 텍스트였다면 원문을 잃지 않게 한다 — 새 입력은
    // 아래 규칙대로 건드리지 않는다.
    const pending = this.pendingPaste;
    this.pendingPaste = null;
    const failedText = pending !== null && pending.item === item ? pending.text : null;

    // 종료 뒤 늦게 도착한 실패는 종료 안내를 덮지 않는다. 원문은 복구 영역에
    // 남긴다 — 입력칸은 이미 비활성이고 `input` 이벤트도 다시 오지 않아,
    // 보관만 해 두면 사용자에게서 사라진다.
    if (this.closed) {
      if (failedText !== null) this.keepDraft(failedText);
      return;
    }
    if (error instanceof TransportClosedError) {
      // 곧 비활성이 될 입력칸 대신 복구 영역으로 보낸다 — 비활성 입력칸의
      // 글자는 폰에서 선택·복사가 되지 않는다.
      if (failedText !== null) this.keepDraft(failedText);
      this.handleTransportClosed(error.message);
      return;
    }
    if (failedText !== null) {
      if (this.textEl.value === "") {
        this.textEl.value = failedText;
      } else {
        this.failedPasteText = failedText;
      }
    }
    if (error instanceof RemoteError) {
      this.schedule.noteStatus(error.status);
      // 409 는 이 탭의 셸이 갈렸다는 뜻이다 — 보고 있던 화면이 더는 그 셸이
      // 아니므로 인스턴스를 접고 다음 폴이 새 스냅샷을 받게 한다. 503(입력 거절)은
      // 일시적 거절이라 화면을 접지 않는다 — 원문은 위에서 이미 입력칸에 돌아갔다.
      if (error.status === 409) this.resetToFull();
      // 배달 불확실 경고만 노란 톤으로 — 같은 503 이라도 `input busy`·
      // `server stopping` 은 "보내지 않았다"이므로 빨간 톤 그대로다.
      this.setNotice(inputErrorNotice(error), isInputWriteTimedOut(error) ? "warn" : "error");
      return;
    }
    this.setNotice("Could not reach mast — check the connection.");
  }

  private handleSizeError(error: unknown): void {
    if (error instanceof RemoteError) {
      this.schedule.noteStatus(error.status);
      // 409 는 이 탭의 셸이 갈렸다는 뜻이다 — 화면도 그 셸의 것이 아니므로
      // 입력 실패와 같은 정리(인스턴스 폐기)를 한다.
      if (error.status === 409) this.resetToFull();
      this.setNotice(sizeErrorText(error.status));
      return;
    }
    this.setNotice("Could not resize — check the connection.");
  }

  /** 입력칸에 넣을 수 없는 원문을 화면에 남긴다. 사용자가 화면을 떠난 뒤(dispose)
   *  에는 남길 곳이 없으므로 아무것도 하지 않는다. */
  private keepDraft(text: string): void {
    if (this.disposed) return;
    this.showRecoveredDraft(text);
  }

  /** 읽기 전용 textarea 로 남긴다 — 비활성 입력칸과 달리 포커스와 선택이 되어
   *  폰에서 복사할 수 있다. 어디에도 저장하지 않는다: 입력에는 비밀이 섞일 수
   *  있고, 이 화면은 떠나는 순간 사라지는 것이 계약이다. */
  private showRecoveredDraft(text: string): void {
    const draft = document.createElement("textarea");
    draft.className = "recovery-text";
    draft.readOnly = true;
    draft.rows = 2;
    draft.value = text;
    this.recoveryEl.append(draft);
    this.recoveryEl.hidden = false;
  }

  private handleScreenError(error: unknown): void {
    if (error instanceof TransportClosedError) {
      this.handleTransportClosed(error.message);
      return;
    }
    if (error instanceof RemoteError) {
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

/** 입력 실패 문구. `503 input write timed out` 만 "보냈는지 모른다"로 갈라진다 —
 *  서버는 그 쓰기를 취소하지 않고 나중에 PTY 에 전달할 수 있는데, 다른 503 처럼
 *  "보내지지 않았다"고 안내하면 사용자가 곧바로 다시 보내 같은 입력이 두 번 들어간다.
 *  자동 재전송은 어느 경우에도 없다 — 원문은 입력칸(또는 복구 영역)에 남을 뿐이다. */
function inputErrorNotice(error: RemoteError): string {
  if (isInputWriteTimedOut(error)) {
    return "Delivery is uncertain — the input may still arrive. Check the terminal before sending again.";
  }
  return inputErrorText(error.status);
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
    // 서버의 `input busy`·`server stopping` — 세션 교체(409)와 달리 이번 요청만
    // 거절된 것이다. 같은 페어링에서 다시 보낼 수 있고, 원문은 입력칸에 돌아와 있다.
    case 503:
      return "Input was not sent — mast is still busy. Try again in a moment.";
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
