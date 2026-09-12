// 기록 뷰 — 셸이 끝난 터미널 탭의 마지막 화면 (ADR-0018).
//
// 그리는 재료는 백엔드가 exit 시점에 디스크로 옮긴 raw 바이트다(DEC 모드
// preamble + replay 스냅샷). 그래서 여기에는 세션에 붙는 배선이 **하나도** 없다:
// 채널도, ack 도, resize 커맨드도, stdin 도 없다. 파일 한 번 읽고 xterm 에 쓰면
// 끝이고, `disableStdin` 으로 입력 경로 자체를 막는다.
//
// 수명은 뷰어의 것이다 (viewer-view.ts 의 TerminalRecordKind): 활성 탭일 때만
// 마운트되고 배경 탭이 되면 내려간다. 다시 보일 때 파일을 한 번 더 읽는 비용이
// 죽은 xterm 을 계속 들고 있는 비용보다 싸다.
//
// 글꼴·테마·줌은 **터미널 표면의 것을 그대로 쓴다** (terminal-view 의 모듈 상태와
// 줌 레지스트리) — 기록은 터미널 화면의 연장이라 같은 `Ctrl+=`/`Ctrl+-`/`Ctrl+0`
// 한 스텝에 같이 움직여야 한다. 뷰어 글꼴(viewer-font.ts) 쪽이 아닌 이유가 그것
// 이다: 같은 pane 에서 살아 있는 셸과 그 셸의 마지막 화면이 다른 크기로 보이면
// 안 된다.
//
// 리사이즈는 **자체 ResizeObserver** 로 받는다 (뷰어 관례 — text-view.ts 와 같다).
// pane 의 observer 는 표시 중인 터미널 뷰의 fit 만 부른다.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { readTabRecord } from "./backend";
import {
  copyTerminalSelection,
  isCopySelectionKey,
  registerTerminalFontTarget,
  terminalViewOptions,
  unregisterTerminalFontTarget,
} from "./terminal-view";
import type { TerminalFontTarget } from "./terminal-view";
import type { ViewerKind, ViewerView } from "./viewer-view";
import type { TabId } from "./types";

/** 기록이 없는 탭에 그리는 안내 (영어 UI 텍스트). 빈 화면만 남기면 "읽기에
 *  실패한 것"과 구분되지 않는다 — 기록이 비어 있는 것은 정상 경로다(셸이 아무
 *  것도 출력하지 않고 끝났거나, 파일이 이미 정리됐다). */
export const EMPTY_RECORD_NOTICE = "no screen was recorded for this tab\r\n";

/** 기록 바이트 → 터미널. 뷰에서 떼어낸 **순수 함수**이고 xterm 의 write 만
 *  요구한다 — v0.3.18 이 blind 로 나간 원인이 정확히 이 배선(라이브러리 인스턴스와
 *  콜백 사이)의 미검증이었으므로, 스텁과 실제 headless 인스턴스 양쪽으로 잠근다.
 *
 *  바이트는 **Uint8Array 로** 넘긴다: 기록은 UTF-8 로 디코드되지 않는 바이트를
 *  담을 수 있고(부분 시퀀스가 replay 창 경계에서 잘린다), 문자열로 바꾸면 그
 *  자리에 U+FFFD 가 박힌 채 xterm 에 들어간다. */
export function writeRecord(
  term: { write(data: Uint8Array | string): void },
  body: ArrayBuffer,
): void {
  if (body.byteLength === 0) {
    term.write(EMPTY_RECORD_NOTICE);
    return;
  }
  term.write(new Uint8Array(body));
}

export class RecordView implements ViewerView, TerminalFontTarget {
  readonly root: HTMLDivElement;
  private readonly term: Terminal;
  private readonly fitAddon: FitAddon;
  private readonly resizeObserver: ResizeObserver;
  private disposed = false;
  private fitScheduled = false;

  constructor(parent: HTMLElement, tab: TabId) {
    this.root = document.createElement("div");
    this.root.className = "term-host";
    parent.appendChild(this.root);

    const { fontSize, fontFamily, theme } = terminalViewOptions();
    this.term = new Terminal({
      // 스크롤백은 터미널 뷰와 같다. 1 MiB 기록은 5,000 행을 넘을 수 있어 그런
      // 기록은 **꼬리만** 되감긴다 — 앞부분은 xterm 이 버린다. 종전의 attach 경로도
      // 같은 replay 를 같은 스크롤백의 터미널에 흘려보냈으므로 보이는 범위는 그대로다.
      scrollback: 5000,
      // 입력 경로 없음 — 붙어 있는 PTY 가 없으므로 타이핑이 갈 곳이 없다.
      // 선택은 xterm 기본 동작 그대로이고, 복사는 아래에서 따로 배선한다.
      disableStdin: true,
      fontSize,
      fontFamily,
      theme,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.root);
    this.fit();

    // 복사 배선 — `disableStdin` 은 xterm 의 **전송**만 막고 keydown 처리는 막지
    // 않는다. `Ctrl+C` 는 여전히 xterm 안에서 cancel(preventDefault) 되므로,
    // 가로채지 않으면 브라우저 copy 이벤트가 발생하지 않아 아무 일도 일어나지
    // 않는다 — 죽은 에이전트의 마지막 화면을 읽고 퍼 가는 것이 이 표면의 용도라
    // 조용히 죽으면 안 된다. 판정·동작은 터미널 뷰와 공유한다 (keys.ts 정본 표).
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (!isCopySelectionKey(ev, this.term.hasSelection())) return true;
      ev.preventDefault();
      void copyTerminalSelection(this.term);
      return false;
    });

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.root);
    // 줌 대상 등록 — 해제는 dispose 가 짝으로 맡는다.
    registerTerminalFontTarget(this);

    // 마운트당 1회 읽기. 실패해도 탭은 유지한다 — 배너(pane-view)가 code·시각으로
    // "셸이 끝났다"는 사실을 이미 말하고 있고, 화면만 비게 된다.
    // text-view 의 loadToken 같은 세대 가드는 없다: 여기서 읽기를 시작하는 곳은
    // 생성자 하나뿐이고(`update()` 는 영구 no-op) 기록은 마운트된 동안 바뀌지
    // 않으므로 경합할 둘째 로드가 존재하지 않는다. disposed 하나면 충분하다.
    void readTabRecord(tab).then(
      (body) => {
        if (this.disposed) return;
        writeRecord(this.term, body);
      },
      // 거절 핸들러는 `.catch` 가 아니라 `then` 의 둘째 인자다 — `.catch` 로 두면
      // writeRecord 가 동기로 던진 렌더 실패까지 이 메시지로 찍혀 현장 진단이
      // 백엔드 읽기를 보게 된다.
      (err: unknown) => {
        console.error("read_tab_record failed", tab, err);
      },
    );
  }

  /** 줌 적용 (terminal-view 의 adjustFontSize/resetFontSize 가 부른다) — 셀 치수가
   *  바뀌므로 곧바로 refit 해 격자를 다시 잡는다. PTY 가 없어 resize 가 나갈 곳은
   *  없다. */
  setFontSize(size: number): void {
    if (this.disposed) return;
    this.term.options.fontSize = size;
    this.scheduleFit();
  }

  /** 기록은 마운트된 동안 바뀌지 않는다 — 재시작이 성공하면 탭이 terminal 수명으로
   *  돌아가 이 뷰가 통째로 내려가고, 실패하면 기록이 그대로 남는다. 배너의 exit
   *  code·시각은 pane-view 가 스냅샷에서 직접 그린다. */
  update(_kind: ViewerKind): void {}

  /** 모델에 남길 스크롤 위치가 없다 (folderBrowser 와 같은 이유 — setViewerScroll
   *  을 보내면 kindMismatch 다). */
  flushScroll(): void {}

  focus(): void {
    this.term.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    unregisterTerminalFontTarget(this);
    this.resizeObserver.disconnect();
    this.term.dispose();
    this.root.remove();
  }

  /** fit 요청 — rAF 로 프레임당 1회 코얼레싱 (TerminalView.scheduleFit 과 같은 규약). */
  private scheduleFit(): void {
    if (this.fitScheduled) return;
    this.fitScheduled = true;
    requestAnimationFrame(() => {
      this.fitScheduled = false;
      if (!this.disposed) this.fit();
    });
  }

  private fit(): void {
    // 크기 0인 상태의 fit 은 잘못된 dims 를 잡는다 (TerminalView 와 같은 가드).
    if (this.root.clientWidth === 0 || this.root.clientHeight === 0) return;
    this.fitAddon.fit();
  }
}
