// 폰 표면의 화면 프로토콜 — 순수 판정만 있고 I/O 는 없다 (ADR-0016 결정 5).
//
// 서버는 `GET /api/tabs/{id}/screen` 의 본문으로 바이트를, 메타는 `X-Mast-*`
// 헤더로 준다. 요청이 `since` 를 달고 나가면 델타, 없으면 reset 스냅샷이다.
// 여기서 잠그는 것은 그 왕복의 상태 전이다: 언제 xterm 인스턴스를 버리고 다시
// 만들어야 하는가, 다음 요청에 실을 offset 은 무엇인가.
//
// 상태 전이를 순수 함수로 떼어 둔 이유는 이것이 조용히 틀리는 종류의 로직이기
// 때문이다 — offset 을 한 번 잘못 이어 붙이면 화면은 계속 그려지지만 내용이
// 어긋나고, 그 상태가 화면만 보고는 델타 손실인지 렌더 버그인지 구분되지 않는다.

import type { TerminalModes } from "./modes";

/** `session` 은 서버가 만든 `<epoch>:<id>` 지만 이쪽은 불투명 문자열로만
 *  다룬다 — 같은지 다른지만 본다. */
export interface ScreenMeta {
  endOffset: number;
  reset: boolean;
  cols: number;
  rows: number;
  session: string;
}

/** 프로토콜 단계. `full` 은 "아직 화면이 없다 — `since` 없이 스냅샷을 받아야
 *  한다", `ready` 는 "인스턴스가 있고 델타를 잇는 중"이다.
 *
 *  **입력 컨트롤의 활성 조건은 이 단계가 아니다.** 단계는 응답이 도착한 순간
 *  넘어가지만 `term.modes` 는 `term.write` 의 콜백이 돌아야 반영되므로, 입력
 *  게이트는 그 콜백을 따로 기다린다 (tab-view.ts). */
export type ScreenPhase = "full" | "ready";

export interface ViewState {
  phase: ScreenPhase;
  /** 다음 델타 요청에 실을 offset. `full` 단계에서는 의미가 없다. */
  since: number;
  session: string | null;
  cols: number;
  rows: number;
}

export const INITIAL_VIEW_STATE: ViewState = {
  phase: "full",
  since: 0,
  session: null,
  cols: 0,
  rows: 0,
};

/** 다음 요청의 쿼리. null 이면 `since` 없이 (= reset 스냅샷을) 요청한다. */
export interface ScreenQuery {
  since: number;
  session: string;
}

export function screenQuery(state: ViewState): ScreenQuery | null {
  if (state.phase !== "ready" || state.session === null) return null;
  return { since: state.since, session: state.session };
}

const HEADER_END_OFFSET = "X-Mast-End-Offset";
const HEADER_RESET = "X-Mast-Reset";
const HEADER_COLS = "X-Mast-Cols";
const HEADER_ROWS = "X-Mast-Rows";
const HEADER_SESSION = "X-Mast-Session";

/** 하나라도 없거나 모양이 틀리면 null 이다 — 부분적으로 읽어 두면 offset 이나
 *  크기가 기본값으로 조용히 채워져 화면이 어긋난다. */
export function parseScreenMeta(headerGet: (name: string) => string | null): ScreenMeta | null {
  const endOffset = parseCount(headerGet(HEADER_END_OFFSET));
  const cols = parseCount(headerGet(HEADER_COLS));
  const rows = parseCount(headerGet(HEADER_ROWS));
  const resetRaw = headerGet(HEADER_RESET);
  const session = headerGet(HEADER_SESSION);
  if (endOffset === null || cols === null || rows === null) return null;
  if (resetRaw !== "0" && resetRaw !== "1") return null;
  if (session === null || session === "") return null;
  return { endOffset, reset: resetRaw === "1", cols, rows, session };
}

/** 10진 비음수 정수만 받는다. `Number()` 는 ""·공백·"0x10"·"1e3" 을 전부 받아
 *  주므로 쓰지 않는다. */
function parseCount(raw: string | null): number | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** `ready` 단계에서만 의미가 있다. reset 은 서버가 "네 offset 은 이미 replay
 *  창 밖이다" 라고 말한 것이고, 크기·세션 변화는 우리가 보고 있던 화면이 더는
 *  같은 화면이 아니라는 뜻이다 (탭 Restart 는 새 PtySession 이다). */
export function needsRecreate(prev: ViewState, got: ScreenMeta): boolean {
  return (
    got.reset || got.cols !== prev.cols || got.rows !== prev.rows || got.session !== prev.session
  );
}

/** 응답 하나를 반영한 다음 상태 — 곧 다음 요청의 모양이기도 하다.
 *
 *  `full` 단계의 응답은 reset=1 이어야 하고(서버 계약: `since` 없음 → reset),
 *  그 응답만이 인스턴스를 세운다. `ready` 단계에서 이어 붙일 수 없는 응답이
 *  오면 `full` 로 돌아가되 아무것도 물려주지 않는다 — 인스턴스를 버리므로
 *  offset·크기·세션 어느 것도 다음 스냅샷에 쓸 수 없다. */
export function nextRequest(state: ViewState, got: ScreenMeta): ViewState {
  if (state.phase === "full") {
    // reset 이 아닌 응답으로는 화면을 세울 수 없다 (델타만 왔다) — 다시 요청한다.
    if (!got.reset) return state;
    return {
      phase: "ready",
      since: got.endOffset,
      session: got.session,
      cols: got.cols,
      rows: got.rows,
    };
  }
  if (needsRecreate(state, got)) return { ...INITIAL_VIEW_STATE };
  return { ...state, since: got.endOffset };
}

/** 폰이 보낼 수 있는 입력. 텍스트는 붙여넣기 한 덩어리이고, 나머지는 버튼 하나에
 *  키 하나다 — xterm 이 `disableStdin` 이라 인코딩은 전부 여기서 한다.
 *
 *  `wheel` 은 폰에 없는 마우스 휠을 대신한다. 대체 화면(`ESC[?1049h`)에는
 *  스크롤백이 없어 이전 내역은 그 안에서 도는 TUI 만 되감을 수 있고, 데스크톱에서
 *  그 일을 하는 것이 휠이다. */
export type InputAction =
  | { type: "paste"; text: string }
  | { type: "key"; key: InputKey }
  | { type: "wheel"; direction: "up" | "down"; col: number; row: number; notches: number };

export type InputKey =
  | "escape"
  | "tab"
  | "ctrlC"
  | "backspace"
  | "enter"
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageUp"
  | "pageDown";

const ARROW_FINAL: Record<"up" | "down" | "left" | "right", string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

/** SGR 마우스 리포트(`ESC[?1006h`)의 휠 버튼 번호. 휠은 버튼 코드 64 에 방향이
 *  더해지고, 눌림만 있고 뗌이 없어 최종 바이트는 항상 `M` 이다. */
const WHEEL_BUTTON: Record<"up" | "down", number> = {
  up: 64,
  down: 65,
};

/** 액션 → PTY 로 그대로 흘려보낼 문자열.
 *
 *  붙여넣기를 `ESC[200~ … ESC[201~` 로 감싸는 것은 **수신 프로그램이 그 모드를
 *  켜 놨을 때만**이다. 모드가 꺼진 셸에 브래킷을 보내면 프로그램이 그 시퀀스를
 *  글자로 받아 명령줄에 `[200~` 이 남는다.
 *
 *  화살표가 두 벌인 것은 DECCKM(application cursor keys) 때문이다 — 이 모드를
 *  켠 TUI(vim·readline 의 일부 모드)는 `ESC O A` 를 기대하고 `ESC [ A` 를 다른
 *  뜻으로 읽는다. 두 모드 값 모두 write 가 끝난 뒤의 `term.modes` 에서 온다.
 *
 *  휠은 모드를 보지 않는다 — 좌표와 방향만으로 결정되고, 이 인코딩을 읽을 수 있는
 *  프로그램인지는 호출자가 이미 판정한 뒤다 (tab-view.ts). 여러 노치를 한 문자열로
 *  잇는 것은 그것이 한 번의 write 로 나가야 하기 때문이다: 요청을 쪼개면 TUI 가
 *  리포트 사이에 다른 입력을 끼워 읽을 수 있고, 왕복 지연만큼 스크롤이 끊긴다. */
export function encodeInput(action: InputAction, modes: TerminalModes): string {
  if (action.type === "paste") {
    if (!modes.bracketedPasteMode) return action.text;
    return `\x1b[200~${action.text}\x1b[201~`;
  }
  if (action.type === "wheel") {
    const report = `\x1b[<${WHEEL_BUTTON[action.direction]};${action.col};${action.row}M`;
    return report.repeat(action.notches);
  }
  switch (action.key) {
    case "escape":
      return "\x1b";
    case "tab":
      return "\t";
    case "ctrlC":
      return "\x03";
    case "backspace":
      return "\x7f";
    case "enter":
      return "\r";
    case "pageUp":
      return "\x1b[5~";
    case "pageDown":
      return "\x1b[6~";
    default: {
      const final = ARROW_FINAL[action.key];
      return modes.applicationCursorKeysMode ? `\x1bO${final}` : `\x1b[${final}`;
    }
  }
}
