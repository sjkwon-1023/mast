// textViewer 탭의 뷰 — 파일을 512KiB **바이트 윈도우** 1개만
// 메모리에 두고, 그 안에서 고정 행높이 가상 스크롤로 그린다.
//
// 이 파일의 두 계약이 나머지를 지배한다.
//
// 1. **메모리 상주 = 윈도우 1개 고정** (계획 v2 "탭 타입별 동작"): 수백 MB 로그를
//    열어도 상주량이 창 하나를 넘지 않아야 하므로 스크롤 끝에서 자동으로 이어
//    읽지 않는다. 파일이 창보다 크면 상단 바의 first/prev/next/last 버튼으로
//    **명시적으로** 창을 옮긴다. 창 경계는 행 중간을 가르므로 선두(창 시작이
//    파일 중간일 때)·말미(EOF 가 아닐 때) 부분행과 UTF-8 파단 바이트를 잘라낸다.
// 2. **스크롤 왕복의 에코 가드** (계획 21단계 high 리스크): 스크롤이 멈추면
//    500ms 디바운스로 setViewerScroll(최상단 가시 행의 전역 byte offset)을
//    dispatch 하는데, 그 dispatch 가 다시 스냅샷 → update() 로 돌아온다. 스냅샷의
//    scrollTop 을 매번 적용하면 재렌더가 사용자 스크롤과 싸우므로 **마운트 시
//    1회(또는 경로 변경 시)만** 적용한다 — 판정은 순수 함수 shouldAdoptScroll.
//
// 창 이동은 상단 바 버튼과 **뷰 내부 keydown** 둘 다로 한다 (체크포인트 2 UX):
// Ctrl+PageUp/PageDown 이 이전/다음 창, Ctrl+Home/End 가 처음/마지막 창이다.
// 이 keydown 은 전역 가로채기(keys.ts 의 window capture)와 층이 다르고, 전역
// 목록에 없는 조합만 소비하므로 Ctrl+Tab·Ctrl+1~9·Ctrl+Shift+방향키와 겹치지 않는다.
// 수식키 없는 PageUp/PageDown 은 창을 옮기지 않고 **행높이 배수로 정렬된 페이지
// 스크롤**이다 — 브라우저 기본 페이지 스텝(Blink 는 viewport-40px 류)은 행
// 격자와 어긋나 최상단 행이 반쯤 잘린 채 멈춘다. Home/End·방향키·휠은 손대지
// 않고 네이티브 스크롤 그대로 둔다.
//
// 재시작 복원은 저장된 offset T 를 창 **시작**이 아니라 창 **중앙 부근**에
// 앉힌다 (windowStartForRestore): 보이는 최상단 행은 T 의 행 그대로면서 위쪽으로
// 스크롤할 문맥이 창 안에 들어온다.
//
// 윈도우 절삭(decodeWindow)·슬라이스 계산(visibleSlice)·복원 창 시작
// (windowStartForRestore)·버튼 상태(windowButtonsDisabled)·키 판정
// (textKeyAction)·페이지 스크롤(pageScrollTop)·에코 가드·디바운스(ScrollSettle)는
// DOM·IPC 무의존으로 분리해 vitest 로 잠근다. 클래스는 그 결과를 DOM 에 옮기는
// 얇은 층이다.
//
// 리사이즈는 **자체 ResizeObserver** 로 받는다 (계획 프론트 계약): pane 의
// observer 는 터미널 fit 전용이라 뷰어까지 겸하게 만들지 않는다.
//
// 글꼴은 settings.json 값을 따르고 런타임 줌(Ctrl+= / Ctrl+- / Ctrl+0)도 따른다 —
// :root 커스텀 프로퍼티는 viewer-font.ts 가 심고, 행높이는 그 글자 크기에서
// 파생한다(lineHeightForFontSize). 즉 **행 격자는 뷰 수명 동안 고정이 아니다**
// (v0.3.8): 뷰는 생성 시 viewer-font 의 레지스트리에 자신을 등록하고, 크기가
// 바뀌면 setViewerFontSize 로 행높이·spacer·scrollTop 을 다시 앉힌다. 위 두
// 계약은 그대로다 — 재적용은 창을 다시 읽지 않고(계약 1), 모델 좌표가 byte
// offset 이라 **최상단 가시 행**만 붙들면 위치가 보존되므로 평소에는 스크롤을
// 되돌려 보낼 일이 없다(계약 2). 예외는 문서 말미에서 줌아웃할 때다: 목표
// scrollTop 이 줄어든 문서 높이를 넘어 브라우저가 클램프하면 최상단 행이 실제로
// 바뀌므로 그 새 위치가 정상적으로 기록된다 (markdown-view 의 라이브 리로드와
// 같은 판단).
//
// 구문 하이라이팅(v0.3.6)은 위 두 계약 **위에 덧입히는** 층이라 셋째 계약이 아니다:
// 파일 열기는 언제나 플레인 렌더로 즉시 끝나고, highlight.js 는 **dynamic import
// 로만** 들어와(앱 시작 경로·비대상 파일 경로에는 바이트가 하나도 실리지 않는다)
// 로드가 끝난 뒤에 창 1개를 통째로 토큰화해 행별 HTML 을 캐시한다. 자세한 계약은
// 아래 "구문 하이라이팅" 절에 있다.

// highlight.js 는 **타입만** 정적으로 참조한다 (`import type` 은 컴파일에서
// 지워져 런타임 코드가 남지 않는다) — 값은 전부 아래 dynamic import 로만 들어온다.
import type { LanguageFn } from "highlight.js";

import type { TimerHost } from "./ack-batcher";
import { fsReadChunk, fsStat } from "./backend";
import type { UiSettings } from "./backend";
import type { KeySpec } from "./keys";
import {
  DEFAULT_VIEWER_FONT_SIZE,
  registerViewerFontTarget,
  unregisterViewerFontTarget,
  viewerFontSize,
} from "./viewer-font";
import type { ViewerFontTarget } from "./viewer-font";
import type { ViewerKind, ViewerView } from "./viewer-view";
import type { Command, CommandOutput, TabId } from "./types";

/** UI 발 dispatch — main.ts dispatchUI 래퍼 (실패는 상태 라인에 표면화되고 null). */
type DispatchFn = (cmd: Command) => Promise<CommandOutput | null>;

/** 한 번에 읽어 상주시키는 바이트 수. 글루 상한(4MiB)보다 한참 아래다. */
export const WINDOW_BYTES = 512 * 1024;
/** **기본 글자 크기**(viewer-font.ts DEFAULT_VIEWER_FONT_SIZE)에서의 고정
 *  행높이(px). 가상 스크롤의 spacer 높이·슬라이스 계산이 전부 행높이 기준이라 CSS
 *  가 아니라 여기가 정본이다 (뷰가 `--text-line-height` 로 내려준다).
 *
 *  settings.json 으로 글자를 키우면 행도 같이 커져야 하므로 실제로 쓰는 값은
 *  lineHeightForFontSize 가 여기서 파생한다 — 이 상수를 그대로 쓰면 큰 글자가
 *  16px 행 안에서 잘린다. */
export const LINE_HEIGHT_PX = 16;

/** 글자 크기(px) → 행높이(px) (순수). 기본 크기에서의 비율(16/12)을 유지하고
 *  **정수 px** 로 떨어뜨린다: spacer 높이·슬라이스 top·복원 scrollTop 이 전부 이
 *  값의 배수라, 소수를 허용하면 누적 오차로 최상단 행이 반쯤 잘린 채 멈춘다. */
export function lineHeightForFontSize(size: number): number {
  return Math.max(1, Math.round((size * LINE_HEIGHT_PX) / DEFAULT_VIEWER_FONT_SIZE));
}

/** viewport 위아래로 더 그리는 행 수 — 스크롤 중 빈 줄이 스치지 않게. */
export const OVERSCAN_LINES = 20;
/** 스크롤이 멎었다고 보는 시간 — 이 시간 뒤에 위치 1개만 dispatch 한다. */
export const SCROLL_SETTLE_MS = 500;

const LF = 0x0a;
const CR = 0x0d;

const defaultTimers: TimerHost = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

/** 절삭까지 끝난 윈도우 1개. offset 은 전부 **파일 전역** byte offset 이다 —
 *  모델의 scrollTop 시맨틱(최상단 가시 행의 전역 byte offset)과 같은 좌표계라야
 *  창을 옮겨도 위치가 보존된다. */
export interface TextWindow {
  /** 유지 구간 첫 바이트의 전역 offset. */
  start: number;
  /** 유지 구간 마지막 바이트 **다음**의 전역 offset. */
  end: number;
  /** 표시용 행 (행말 CR 제거, 개행 미포함). */
  lines: string[];
  /** lines[i] 의 시작 전역 byte offset — lines 와 길이가 같다. */
  lineStarts: number[];
}

/** UTF-8 continuation 바이트(0b10xxxxxx)인가. */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** lead 바이트가 예고하는 시퀀스 길이. continuation·불량 바이트는 0. */
function sequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
}

/** 행 1개 디코드 — 행말 CR 은 표시에서 뺀다 (CRLF 파일이 매 행 끝에 제어문자를
 *  달고 나오지 않게). byte offset 계산에는 영향이 없다. */
function decodeLine(decoder: TextDecoder, bytes: Uint8Array, from: number, to: number): string {
  const end = to > from && bytes[to - 1] === CR ? to - 1 : to;
  return decoder.decode(bytes.subarray(from, end));
}

/** 읽어 온 바이트 창 → 완결된 행들 (순수).
 *
 *  - `readOffset > 0` 이면 선두는 이전 창에 걸친 **부분행**이므로 첫 개행 다음
 *    까지 버린다.
 *  - `atEof` 가 아니면 말미도 다음 창으로 이어지는 부분행이므로 마지막 개행
 *    까지만 남긴다.
 *  - 남은 구간의 양 끝에서 잘린 멀티바이트 시퀀스를 제거한다 — 개행 경계로
 *    잘린 경우엔 애초에 생기지 않지만, **창보다 긴 행**(창 안에 개행이 하나도
 *    없는 경우)에서는 부분행 절삭을 포기하므로 여기서만 걸린다.
 *
 *  창 안에 개행이 없으면 절삭 대신 조각을 그대로 보여준다 — 빈 화면(모든 바이트
 *  절삭)보다 "이 창은 한 행의 일부"가 낫다. */
export function decodeWindow(bytes: Uint8Array, readOffset: number, atEof: boolean): TextWindow {
  let from = 0;
  let to = bytes.length;

  if (readOffset > 0) {
    const nl = bytes.indexOf(LF);
    if (nl >= 0) from = nl + 1;
  }
  if (!atEof) {
    const nl = bytes.lastIndexOf(LF);
    if (nl >= from) to = nl + 1;
  }

  // 선두: 파일의 진짜 시작이 아니면 앞에 남은 continuation 바이트를 버린다.
  if (readOffset + from > 0) {
    while (from < to && isContinuation(bytes[from])) from += 1;
  }
  // 말미: 마지막 lead 바이트의 시퀀스가 창을 넘어가면 그 lead 부터 버린다
  // (시퀀스 최대 4바이트라 뒤에서 4칸만 본다).
  if (!atEof) {
    for (let i = to - 1; i >= from && i >= to - 4; i -= 1) {
      const length = sequenceLength(bytes[i]);
      if (length === 0) continue; // continuation — 더 앞의 lead 를 찾는다
      if (i + length > to) to = i;
      break;
    }
  }

  const decoder = new TextDecoder();
  const lines: string[] = [];
  const lineStarts: number[] = [];
  let lineFrom = from;
  for (let i = from; i < to; i += 1) {
    if (bytes[i] !== LF) continue;
    lineStarts.push(readOffset + lineFrom);
    lines.push(decodeLine(decoder, bytes, lineFrom, i));
    lineFrom = i + 1;
  }
  // 개행으로 끝나면 그 뒤에 행이 하나 더 있는 것이 아니다 (빈 꼬리 행 금지).
  if (lineFrom < to) {
    lineStarts.push(readOffset + lineFrom);
    lines.push(decodeLine(decoder, bytes, lineFrom, to));
  }

  return { start: readOffset + from, end: readOffset + to, lines, lineStarts };
}

/** 이번에 실제로 그릴 행 구간 + 그 블록의 top offset(px). */
export interface SliceRange {
  first: number;
  /** exclusive. */
  last: number;
  top: number;
}

/** 스크롤 위치 → 렌더할 행 구간 (순수). viewport 에 걸리는 행 앞뒤로 overscan
 *  만큼 더 그린다. 전체 높이는 spacer 가 잡으므로 여기서는 구간만 정한다. */
export function visibleSlice(
  scrollTop: number,
  viewportHeight: number,
  totalLines: number,
  lineHeight: number = LINE_HEIGHT_PX,
  overscan: number = OVERSCAN_LINES,
): SliceRange {
  if (totalLines <= 0 || lineHeight <= 0) return { first: 0, last: 0, top: 0 };
  const top = Math.max(0, scrollTop);
  const firstVisible = Math.min(totalLines - 1, Math.floor(top / lineHeight));
  // +1: 위아래로 반 줄씩 걸치는 경우를 덮는다.
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / lineHeight) + 1;
  const first = Math.max(0, firstVisible - overscan);
  const last = Math.min(totalLines, firstVisible + visibleCount + overscan);
  return { first, last, top: first * lineHeight };
}

/** 최상단 가시 행의 인덱스 (순수) — 스크롤 위치를 행 격자로 되읽는 유일한 규칙
 *  이다. 모델의 scrollTop 시맨틱(최상단 가시 행의 byte offset)과 줌의 스크롤
 *  유지가 둘 다 이 값 위에 선다. 창이 비었거나 격자가 무의미하면 0 이다. */
export function topLineIndex(scrollTop: number, lineHeight: number, totalLines: number): number {
  if (totalLines <= 0 || lineHeight <= 0) return 0;
  return Math.min(totalLines - 1, Math.max(0, Math.floor(Math.max(0, scrollTop) / lineHeight)));
}

/** 행높이가 바뀔 때의 새 scrollTop (순수) — **최상단 가시 행을 유지**한다.
 *
 *  줌은 창을 다시 읽지 않으므로 행 배열도 lineStarts 도 그대로이고, 바뀌는 것은
 *  격자 간격뿐이다. 그래서 보존해야 할 것은 픽셀이 아니라 **행 인덱스**다:
 *  px 비율(scrollTop × new/old)로 옮기면 반올림 오차가 격자에서 벗어나 최상단
 *  행이 반쯤 잘린 채 멈춘다(pageScrollTop 과 같은 이유). 행 인덱스를 붙들면
 *  그 행의 byte offset 도 그대로라 모델에 되돌려 보낼 위치 변화가 없다. */
export function scrollTopForLineHeight(
  scrollTop: number,
  fromLineHeight: number,
  toLineHeight: number,
  totalLines: number,
): number {
  if (toLineHeight <= 0) return Math.max(0, scrollTop);
  return topLineIndex(scrollTop, fromLineHeight, totalLines) * toLineHeight;
}

/** 전역 byte offset → 그 offset 을 담는 행 인덱스 (순수, 이분 탐색).
 *  창 앞이면 0, 창 뒤면 마지막 행 — 저장된 위치가 창 밖이어도 클램프한다. */
export function lineIndexForOffset(lineStarts: readonly number[], offset: number): number {
  if (lineStarts.length === 0) return 0;
  if (offset <= lineStarts[0]) return 0;
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 스냅샷의 scrollTop 을 지금 화면에 적용해야 하는가 (에코 가드 — 파일 상단 2).
 *
 *  `current` 는 이미 적용한 문서(null 이면 아직 마운트 전)다. 같은 파일에 대한
 *  갱신은 **전부 거절**한다: 우리가 보낸 setViewerScroll 이 스냅샷으로 되돌아와
 *  사용자가 그새 옮긴 스크롤을 덮는 것을 막는 것이 이 함수의 존재 이유다. 경로가
 *  바뀌면 다른 문서이므로 그 문서의 저장 위치를 1회 적용한다 (탭별 뷰라 실제로
 *  발생하지 않지만, update 계약상 방어한다). */
export function shouldAdoptScroll(current: { path: string } | null, nextPath: string): boolean {
  return current === null || current.path !== nextPath;
}

/** 윈도우 이동 버튼 (자동 이어읽기 없음 — 파일 상단 1). */
export type WindowAction = "first" | "prev" | "next" | "last";

/** 버튼 → 다음 창의 목표 시작 offset (순수).
 *
 *  `next` 는 현재 창의 **유지 구간 끝**(행 경계)에서 이어 붙어 바이트가 빠지지
 *  않는다. 마지막 창보다 뒤로는 가지 않는다. */
export function nextWindowStart(
  action: WindowAction,
  current: { start: number; end: number },
  size: number,
  windowBytes: number = WINDOW_BYTES,
): number {
  const lastStart = Math.max(0, size - windowBytes);
  switch (action) {
    case "first":
      return 0;
    case "prev":
      return Math.max(0, current.start - windowBytes);
    case "next":
      return Math.min(lastStart, current.end);
    case "last":
      return lastStart;
  }
}

/** 상단 바에 그리는 순서이자 버튼 상태 계산의 대상 목록. */
const WINDOW_ACTIONS: readonly WindowAction[] = ["first", "prev", "next", "last"];

/** 저장된 위치 `target` 을 복원할 때 읽을 창의 시작 offset (순수).
 *
 *  창 시작을 target 에 맞추면 그 행이 화면 맨 위에 붙어 **위쪽 문맥이 창 밖**이
 *  된다 (체크포인트 2 사용자 관찰). 그래서 창의 절반만큼 앞에서 시작해 target 을
 *  창 가운데쯤에 두고, 스크롤은 target 의 행이 뷰포트 최상단에 오도록 뒤에서
 *  따로 앉힌다 (showWindow) — 보이는 최상단 행은 그대로면서 위로도 스크롤된다.
 *
 *  마지막 창보다 뒤로는 시작하지 않는다: EOF 근처에서 뒤쪽이 비는 대신 앞쪽
 *  문맥을 더 가져오는 편이 창을 꽉 채운다. 창 시작은 행 경계가 아니어도 되고,
 *  선두 부분행은 기존 규칙(back-read 1바이트 + decodeWindow 절삭)이 잘라낸다. */
export function windowStartForRestore(
  target: number,
  size: number,
  windowBytes: number = WINDOW_BYTES,
): number {
  if (target <= 0) return 0;
  const lastStart = Math.max(0, size - windowBytes);
  const centered = target - Math.floor(windowBytes / 2);
  return Math.max(0, Math.min(centered, lastStart));
}

/** 창 이동 버튼 4개의 disabled 상태 (순수).
 *
 *  경계 판정은 창의 **커버 범위**로 한다: `start <= 0` 이면 first/prev,
 *  `end >= size` 면 next/last 가 잠긴다. "목표 시작이 지금과 같은가" 류의 이동
 *  판정은 쓰지 않는다 — 실제 마지막 창은 선두 부분행 절삭 때문에 `win.start` 가
 *  요청 시작(size−W)보다 커서, 이동 판정으로는 next/last 가 영영 잠기지 않고
 *  누를 때마다 같은 창을 재로드하며 스크롤 위치를 덮는다. 파일이 창보다
 *  작으면(start 0 + end=size) 넷 다 잠긴다. 키보드 단축키(moveWindow 가드)도
 *  같은 판정을 쓰므로 버튼과 키가 어긋나지 않는다. */
export function windowButtonsDisabled(
  current: { start: number; end: number },
  size: number,
  // 커버 범위 판정에는 창 폭이 불필요하다 — 시그니처 호환용으로만 남긴다.
  _windowBytes: number = WINDOW_BYTES,
): Record<WindowAction, boolean> {
  const atStart = current.start <= 0;
  const atEnd = current.end >= size;
  return { first: atStart, prev: atStart, next: atEnd, last: atEnd };
}

/** 텍스트 뷰 안에서 소비하는 keydown 의 뜻. `window` 는 상단 바 버튼과 같고,
 *  `page` 는 행 격자에 맞춘 페이지 스크롤이다. */
export type TextKeyAction =
  | { type: "window"; action: WindowAction }
  | { type: "page"; delta: 1 | -1 };

const CTRL_WINDOW_KEYS: Record<string, WindowAction | undefined> = {
  PageUp: "prev",
  PageDown: "next",
  Home: "first",
  End: "last",
};

/** keydown → 텍스트 뷰 액션 (순수). 목록 밖 조합은 전부 null 이고, 그때 뷰는
 *  이벤트에 손대지 않는다 (Home/End·방향키·휠은 네이티브 스크롤 그대로).
 *
 *  Alt 계열은 전역 pane 이동(keys.ts)이라 받지 않고, shift 붙은 변형도 받지
 *  않는다 (keys.ts 의 shift 규약 — 명시된 조합만 가로챈다). Ctrl+PageUp/PageDown·
 *  Ctrl+Home/End 는 전역 가로채기 목록에 없는 조합이라 여기서만 소비된다. */
export function textKeyAction(spec: KeySpec): TextKeyAction | null {
  if (spec.isComposing || spec.alt || spec.shift) return null;
  if (spec.ctrl) {
    const action = CTRL_WINDOW_KEYS[spec.key];
    return action === undefined ? null : { type: "window", action };
  }
  if (spec.key === "PageUp") return { type: "page", delta: -1 };
  if (spec.key === "PageDown") return { type: "page", delta: 1 };
  return null;
}

/** PageUp/PageDown 의 목표 scrollTop (순수) — **행높이의 배수**로 떨어진다.
 *
 *  한 행은 겹쳐 남긴다(문맥 유지). viewport 가 아직 0 이어도(레이아웃 전) 최소
 *  한 행은 움직인다. 시작 위치가 격자에서 벗어나 있으면(드래그·End 로 바닥에
 *  붙은 뒤 등) 가장 가까운 행으로 먼저 스냅한다. 마지막 페이지는 문서 끝에
 *  붙어야 하므로 maxScrollTop 으로 클램프한다 — 그 값만은 행 배수가 아닐 수
 *  있다. */
export function pageScrollTop(
  scrollTop: number,
  viewportHeight: number,
  maxScrollTop: number,
  delta: 1 | -1,
  lineHeight: number = LINE_HEIGHT_PX,
): number {
  if (lineHeight <= 0) return Math.max(0, Math.min(scrollTop, Math.max(0, maxScrollTop)));
  const step = Math.max(1, Math.floor(Math.max(0, viewportHeight) / lineHeight) - 1);
  const line = Math.round(Math.max(0, scrollTop) / lineHeight) + delta * step;
  const target = Math.max(0, line) * lineHeight;
  return Math.max(0, Math.min(target, Math.max(0, maxScrollTop)));
}

/** 세 자리 구분 (순수 — 로케일에 기대지 않는다: WebView ICU 에 따라 결과가
 *  달라지면 테스트로 고정할 수 없다). */
function groupDigits(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 상단 바의 byte 범위 표시 — 파일이 창보다 클 때만 뜬다. */
export function formatByteRange(start: number, end: number, size: number): string {
  return `bytes ${groupDigits(start)}–${groupDigits(end)} of ${groupDigits(size)}`;
}

/** 스크롤 settle 디바운스 (파일 상단 2의 절반) — 스크롤 이벤트마다 dispatch 하지
 *  않고, 마지막 이벤트로부터 settleMs 동안 조용하면 그때 위치 1개만 내보낸다.
 *  타이머를 주입할 수 있어 fake timer 로 결정적 테스트가 가능하다 (AckBatcher
 *  전례). DOM 무의존이라 뷰와 별개로 vitest 대상이다. */
export class ScrollSettle {
  /** 아직 보내지 않은 위치 (없으면 null). */
  private pending: number | null = null;
  private handle: unknown = null;
  /** 모델이 이미 갖고 있다고 믿는 위치 — 같은 값은 보내지 않는다. */
  private synced: number | null = null;

  constructor(
    private readonly send: (offset: number) => void,
    private readonly settleMs: number = SCROLL_SETTLE_MS,
    private readonly timers: TimerHost = defaultTimers,
  ) {}

  /** 모델과 합의된 위치를 새로 고정한다 (마운트 복원·창 이동 직후). 보류분은
   *  버린다 — 복원 때문에 발화한 scroll 이벤트를 되돌려 보내지 않기 위해서다. */
  markSynced(offset: number | null): void {
    this.clearTimer();
    this.pending = null;
    this.synced = offset;
  }

  /** 스크롤 이벤트 1회. 마지막 호출 기준으로 settleMs 뒤 send 된다. */
  observe(offset: number): void {
    this.clearTimer();
    if (offset === this.synced) {
      // 이미 모델에 있는 위치로 되돌아왔다 — 보낼 것이 없다.
      this.pending = null;
      return;
    }
    this.pending = offset;
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      this.flush();
    }, this.settleMs);
  }

  /** 보류분 즉시 배출 (unmount 직전 flushScroll). 보류가 없으면 no-op. */
  flush(): void {
    this.clearTimer();
    const offset = this.pending;
    this.pending = null;
    if (offset === null || offset === this.synced) return;
    this.synced = offset;
    this.send(offset);
  }

  /** 타이머만 정리한다 — dispose 는 배출하지 않는다 (배출은 flush 의 몫). */
  dispose(): void {
    this.clearTimer();
    this.pending = null;
  }

  private clearTimer(): void {
    if (this.handle === null) return;
    this.timers.clearTimeout(this.handle);
    this.handle = null;
  }
}

/** 로드 실패 payload 의 표시 문자열 — 글루는 `Result<_, String>` 이라 문자열이
 *  오지만, IPC 레벨 실패 등 계약 밖 값도 삼키지 않는다. */
function describeError(err: unknown): string {
  return typeof err === "string" ? err : String(err);
}

// 구문 하이라이팅 (v0.3.6)
//
// 네 가지가 이 절의 설계를 지배한다.
//
// 1. **하이라이트를 쓰지 않는 경로의 런타임 비용은 0 이다.** highlight.js 는
//    정적 import 가 **금지**다 — 정적으로 붙으면 앱 시작 번들에 실려 터미널만
//    쓰는 사용자도 그 바이트를 파싱한다. 코어·언어 모듈·테마 CSS 는 전부 아래
//    LANGUAGE_LOADERS 의 dynamic import 로만 들어오고, Vite 가 언어당 청크
//    하나로 떼어 낸다. 설치 파일이 그만큼 커지는 것은 받아들인 트레이드오프다
//    (사용자 요구).
// 2. **열기는 절대 기다리지 않는다.** 로드는 창을 플레인으로 그린 **뒤에**
//    시작하고, 끝나면 그 위에 덧입힌다. 도착 시점에 뷰가 dispose 됐거나 창이 이미
//    바뀌었으면(loadToken 불일치) 조용히 버린다.
// 3. **창 1개를 한 번에** 토큰화하고 행별로 쪼개 캐시한다 (백로그 설계 노트).
//    행마다 따로 하이라이트하면 여러 행에 걸치는 구문(파이썬 삼중따옴표, 블록
//    주석, 템플릿 리터럴)이 가상 스크롤 이음매마다 깨진다.
// 4. **대상 판정은 확장자 명시 맵**이다 — highlightAuto 는 쓰지 않는다 (전 언어
//    시도라 비싸고, 짧은 파일에서 자주 틀린다). 맵에 없거나 settings.json 의
//    highlightLanguages 밖이면 **모듈 로드 자체를 하지 않는다**.

/** hljs 에서 우리가 쓰는 표면 — 테스트가 가짜를 넣을 수 있게 구조적으로 좁혔다. */
export interface HighlightApi {
  highlight(
    code: string,
    options: { language: string; ignoreIllegals?: boolean },
  ): { value: string };
}

/** 언어 이름 → hljs 언어 모듈 로더. **키 목록이 곧 지원 언어의 정본**이고,
 *  백엔드(`commands.rs` 의 `HIGHLIGHT_LANGUAGES`)가 settings.json 의 이름을 이
 *  목록으로 검사한다 — 두 목록은 같이 움직여야 한다 (한쪽에만 있으면, 통과한
 *  이름에 로드할 모듈이 없거나 로드할 수 있는 언어를 설정할 수 없다).
 *
 *  import 경로가 언어 이름과 다른 둘: HTML 은 hljs 의 `xml` 모듈이 처리하고,
 *  TOML 은 `ini` 모듈이 처리한다 (등록은 우리 이름으로 하므로 highlight() 에
 *  넘기는 언어 인자는 이 키 그대로다). */
const LANGUAGE_LOADERS: Record<string, (() => Promise<{ default: LanguageFn }>) | undefined> = {
  css: () => import("highlight.js/lib/languages/css"),
  html: () => import("highlight.js/lib/languages/xml"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  toml: () => import("highlight.js/lib/languages/ini"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
};

/** settings.json 의 `highlightLanguages` 가 없을 때 켜는 언어.
 *  주력 스택(python · Next.js/React · rust)과 그 인접 실무 파일이다. */
export const DEFAULT_HIGHLIGHT_LANGUAGES: readonly string[] = [
  "python",
  "javascript",
  "typescript",
  "rust",
  "json",
  "toml",
  "css",
  "html",
];

/** 확장자(점 없는 소문자) → 언어 이름. jsx/tsx 는 각각 javascript/typescript
 *  문법으로 처리한다 (hljs 에서 그 둘의 별칭이다). */
const EXTENSION_LANGUAGES: Record<string, string | undefined> = {
  cjs: "javascript",
  css: "css",
  cts: "typescript",
  htm: "html",
  html: "html",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  mjs: "javascript",
  mts: "typescript",
  py: "python",
  pyi: "python",
  pyw: "python",
  rs: "rust",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
};

/** 하이라이트할 창의 최대 바이트 수.
 *
 *  창 하나를 **한 번의 동기 호출**로 토큰화하므로(계약 3) 이 값이 곧 그 호출이
 *  메인 스레드를 붙잡는 시간의 상한이다. 밀도 높은 TS 소스로 잰 hljs 11 처리량은
 *  약 2MB/s (64KiB 63ms · 256KiB 144ms · 512KiB 248ms) — 창 상한인 WINDOW_BYTES
 *  (512KiB)를 그대로 쓰면 열고 나서 4분의 1초를 멎는다. 절반에서 끊어 ~150ms 로
 *  묶고, 넘는 창은 플레인으로 남긴다 (색은 편의이고 응답성은 1급 요구사항이다).
 *
 *  판정 대상이 **창** 바이트인 이유: 렌더 경로는 fsReadChunk 를 창당 1회
 *  (WINDOW_BYTES) 부르고 청크를 이어 붙이지 않는다 — 글루의 4MiB 상한
 *  (commands.rs MAX_READ_LEN)은 이 경로에 닿지 않는다. */
export const HIGHLIGHT_MAX_BYTES = 256 * 1024;

/** 지금 켜져 있는 언어 목록 — 부팅 시 applyHighlightSettings 가 덮는다. */
let highlightLanguages: readonly string[] = DEFAULT_HIGHLIGHT_LANGUAGES;

/** settings.json 의 하이라이트 설정을 적용한다 (main.ts 부트가 **뷰 생성 전에**
 *  1회 호출 — applyTerminalSettings 와 같은 자리·같은 순서 계약).
 *
 *  null 은 미설정이라 기본 목록을 유지하고, **빈 배열은 "하이라이팅 끄기"** 라는
 *  유효한 설정이다. 이름 검증은 백엔드(get_ui_settings)가 이미 했다 — 여기서 다시
 *  판정하면 두 곳의 규칙이 갈라진다 (applyTerminalSettings 와 같은 규율). */
export function applyHighlightSettings(settings: UiSettings): void {
  if (settings.highlightLanguages !== null) highlightLanguages = settings.highlightLanguages;
}

/** 파일 경로 → 하이라이트에 쓸 언어 이름, 대상이 아니면 null (순수).
 *
 *  뷰어 경로는 항상 리눅스 경로다 (backend.ts 계약). 확장자가 없거나 dotfile
 *  (`.bashrc`)이면 대상이 아니다 — 이름 전체가 확장자로 보이는 것을 막는다. */
export function languageForPath(
  path: string,
  active: readonly string[] = highlightLanguages,
): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const language = EXTENSION_LANGUAGES[base.slice(dot + 1).toLowerCase()];
  if (language === undefined) return null;
  return active.includes(language) ? language : null;
}

/** hljs 마크업 1덩이 → 행별 HTML (순수).
 *
 *  hljs 출력은 열림/닫힘이 맞는 `<span class="…">` 뿐이고 원문의 `<`·`&` 는 전부
 *  엔티티라, 남아 있는 `<` 는 hljs 자신의 태그가 유일하다. 개행에서 그냥 자르면
 *  여러 행에 걸친 span 이 행 경계에서 끊겨 각 행이 불균형 HTML 이 되므로(브라우저
 *  가 제멋대로 닫는다), 열려 있는 span 을 **행 끝에서 닫고 다음 행 머리에서 같은
 *  순서로 다시 연다**. 결과 배열 길이는 항상 `개행 수 + 1` 이다. */
export function splitHighlightedLines(html: string): string[] {
  const token = /<span [^>]*>|<\/span>|\n/g;
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  let last = 0;
  for (let match = token.exec(html); match !== null; match = token.exec(html)) {
    line += html.slice(last, match.index);
    last = token.lastIndex;
    const tag = match[0];
    if (tag === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (tag === "</span>") {
      open.pop();
      line += tag;
    } else {
      open.push(tag);
      line += tag;
    }
  }
  lines.push(line + html.slice(last));
  return lines;
}

/** 창의 행들 → 행별 하이라이트 HTML (순수 — hljs 는 주입).
 *
 *  창을 통째로 한 번 토큰화한다 (계약 3). 행 수가 어긋나면 행과 색이 밀린 채로
 *  그려지므로 null 을 돌려 **플레인으로 남는 쪽**을 택한다.
 *
 *  `ignoreIllegals` 는 켠다: 편집 중이라 문법이 깨진 파일도 뷰어에서는 색이
 *  보이는 편이 낫다. 이스케이프는 hljs 가 하지만 그 사실 자체를 신뢰하지 않고
 *  악성 픽스처로 직접 잠근다 (text-view.test.ts). */
export function highlightLines(
  lines: readonly string[],
  language: string,
  hljs: HighlightApi,
): string[] | null {
  const html = hljs.highlight(lines.join("\n"), { language, ignoreIllegals: true }).value;
  const split = splitHighlightedLines(html);
  return split.length === lines.length ? split : null;
}

/** 언어별 로더 캐시 — 같은 언어의 두 번째 파일은 왕복 없이 같은 promise 를 받고,
 *  registerLanguage 도 한 번만 돈다. */
const highlighters = new Map<string, Promise<HighlightApi>>();

/** hljs 코어 + 언어 모듈 + 테마 CSS 를 **이 경로에서만** 로드한다 (계약 1).
 *
 *  테마는 vs2015 — VS Code 다크 그대로라 배경(#1E1E1E)이 이 앱의 터미널 배경
 *  (terminal-view.ts TERMINAL_THEME)과 같은 값이다. 게다가 우리는 행 엘리먼트에
 *  `.hljs` 클래스를 **붙이지 않으므로** 테마의 배경·padding 규칙(`.hljs`,
 *  `pre code.hljs`)은 아예 매칭되지 않고 토큰 색(`.hljs-*`)만 먹는다 — 뷰어의
 *  기존 배경·글꼴이 그대로 유지된다. CSS 를 styles.css 에 정적으로 넣지 않는
 *  이유도 같다: 그러면 하이라이트를 한 번도 안 쓰는 세션에도 실린다. */
async function loadHighlighter(language: string): Promise<HighlightApi> {
  const cached = highlighters.get(language);
  if (cached !== undefined) return cached;
  const load = LANGUAGE_LOADERS[language];
  if (load === undefined) {
    // languageForPath 를 통과한 이름은 반드시 로더가 있다 — 오면 배선 결함이다.
    return Promise.reject(new Error(`no highlight module for language ${language}`));
  }
  const pending = (async (): Promise<HighlightApi> => {
    const [core, definition] = await Promise.all([
      import("highlight.js/lib/core"),
      load(),
      import("highlight.js/styles/vs2015.css"),
    ]);
    const hljs = core.default;
    hljs.registerLanguage(language, definition.default);
    return hljs;
  })();
  highlighters.set(language, pending);
  // 실패는 캐시에서 비운다 — 남겨두면 일시 실패(파일 잠금 등) 하나로 그 언어가
  // 앱 재시작까지 플레인으로 굳는다. 다음 파일 열기가 로드를 다시 시도한다.
  pending.catch(() => highlighters.delete(language));
  return pending;
}

export interface TextViewOptions {
  /** 타이머 구현 (테스트 주입). 기본은 전역 setTimeout/clearTimeout. */
  timers?: TimerHost;
  settleMs?: number;
}

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
  /** 이 뷰의 행높이(px) — 지금 뷰어 글자 크기에서 파생한다. spacer 높이·슬라이스
   *  위치·scrollTop 이 전부 이 값의 배수다.
   *
   *  **고정이 아니다** — 줌(Ctrl+= / Ctrl+-)이 걸리면 setViewerFontSize 가 여기를
   *  갈고 격자를 다시 앉힌다. 반대로 생성 시점의 초기값이 모듈 상태에서 오므로
   *  줌 뒤에 열리는 뷰도 현재 크기로 열린다. */
  private lineHeight = lineHeightForFontSize(viewerFontSize());

  private path: string;
  private size = 0;
  private win: TextWindow = { start: 0, end: 0, lines: [], lineStarts: [] };
  private disposed = false;
  /** in-flight 로드 토큰 — 늦게 도착한 이전 창의 응답이 현재 창을 덮지 않게 한다
   *  (창 이동 버튼을 연타하면 순서가 뒤집힐 수 있다). */
  private loadToken = 0;
  /** 지금 DOM 에 그려져 있는 슬라이스 (같으면 다시 만들지 않는다). */
  private slice: { first: number; last: number } | null = null;
  /** 에코 가드 상태 — shouldAdoptScroll 의 좌변. */
  private adopted: { path: string } | null = null;
  /** 로드가 끝나면 적용할 전역 byte offset (마운트·경로 변경 시 1회). */
  private pendingOffset: number | null = null;
  /** 이 파일에 쓸 하이라이트 언어 (대상이 아니면 null — 그러면 highlight.js 를
   *  아예 로드하지 않는다). 경로가 바뀔 때만 다시 판정한다. */
  private language: string | null;
  /** 현재 창의 행별 하이라이트 HTML — 아직·영영 없으면 null 이고 그때는 플레인
   *  textContent 로 그린다. 창이 바뀌면 무효다 (showWindow 가 비운다). */
  private highlighted: string[] | null = null;

  constructor(
    parent: HTMLElement,
    private readonly tab: TabId,
    /** 워크스페이스 distro (없으면 null — 글루가 MAST_DISTRO·기본 배포판 순으로
     *  해석한다). 워크스페이스 생성 후 바뀌지 않는 값이라 생성 시 고정한다. */
    private readonly distro: string | null,
    kind: ViewerKind,
    dispatch: DispatchFn,
    options: TextViewOptions = {},
  ) {
    this.path = kind.type === "textViewer" ? kind.path : "";
    this.adopted = { path: this.path };
    this.pendingOffset = kind.type === "textViewer" ? kind.scrollTop : 0;
    this.language = languageForPath(this.path);

    this.settle = new ScrollSettle(
      (offset) => {
        void dispatch({ type: "setViewerScroll", tab: this.tab, scrollTop: offset });
      },
      options.settleMs ?? SCROLL_SETTLE_MS,
      options.timers ?? defaultTimers,
    );

    this.root = document.createElement("div");
    this.root.className = "text-view";
    // 행높이의 정본은 TS 다 (lineHeightForFontSize) — CSS 가 다른 값을 쓰면
    // spacer 높이와 슬라이스 위치가 어긋나므로 커스텀 속성으로 내려준다.
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
    // title 에 단축키를 같이 적는다 — 버튼이 단축키의 유일한 발견 경로다.
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
    // 실스크롤 컨테이너 자체를 focus 대상으로 둔다 — 방향키·Home/End 스크롤이
    // 브라우저 기본 동작으로 붙는다. Tab 순서에는 넣지 않는다 (프로그램적 focus
    // 전용이지만, tabindex 가 있으므로 본문 클릭으로도 focus 가 온다).
    this.scrollEl.tabIndex = -1;
    this.scrollEl.addEventListener("scroll", this.onScroll);

    this.spacerEl = document.createElement("div");
    this.spacerEl.className = "text-spacer";
    this.linesEl = document.createElement("div");
    this.linesEl.className = "text-lines";
    this.spacerEl.append(this.linesEl);
    this.scrollEl.append(this.spacerEl);

    this.root.append(this.bannerEl, this.barEl, this.scrollEl);
    // 창 이동 키는 뷰 전체에서 받는다 — 본문뿐 아니라 바 버튼이 focus 를 쥔
    // 상태(클릭 직후)에서도 같은 키가 같은 뜻이라야 한다.
    this.root.addEventListener("keydown", this.onKeyDown);
    parent.appendChild(this.root);

    // 자체 ResizeObserver (계획 프론트 계약) — pane 의 observer 는 터미널 fit
    // 전용이다. 크기가 바뀌면 viewport 에 들어오는 행 수가 달라진다.
    this.resizeObserver = new ResizeObserver(() => this.renderSlice());
    this.resizeObserver.observe(this.root);
    // 해제는 dispose 가 짝으로 맡는다 (터미널 줌의 liveViews 와 같은 관례).
    registerViewerFontTarget(this);

    this.load(this.pendingOffset ?? 0, true);
  }

  /** 뷰어 글자 크기 라이브 재적용 (줌 경로 전용 — viewer-font 의
   *  adjustViewerFontSize/resetViewerFontSize 가 부른다).
   *
   *  글리프 크기는 CSS 변수가 이미 바꿔 놨다. 여기서 할 일은 **TS 가 계산하는 행
   *  격자**를 그 크기에 다시 맞추는 것이다 — 행높이(뷰가 CSS 로 내려주는
   *  `--text-line-height` 포함) · spacer 전체 높이 · scrollTop · 슬라이스.
   *
   *  스크롤은 **최상단 가시 행을 유지**한다 (scrollTopForLineHeight). 창을 다시
   *  읽지 않으므로 그 행의 byte offset 도 그대로이고, 따라서 **보통은** 모델에
   *  새로 보낼 위치가 없다 — scrollTop 대입이 발화시키는 scroll 이벤트는 기존
   *  경로를 타서 같은 offset 을 보고, ScrollSettle 이 "이미 합의된 위치"로
   *  걸러낸다. 그래서 markSynced 로 따로 잠재우지 않는다 (창 이동과 달리 위치가
   *  안 바뀐다). 예외는 문서 말미의 줌아웃이다: 목표가 줄어든 문서 높이를 넘어
   *  브라우저가 클램프하면 최상단 행이 정말 바뀌므로 그 위치가 나가는 것이 맞다.
   *
   *  순서가 계약이다: spacer 높이를 **먼저** 키워야 스크롤 가능 범위가 새 격자
   *  기준이 되고, 그 뒤의 scrollTop 대입이 브라우저 클램프에 먹히지 않는다. */
  setViewerFontSize(size: number): void {
    if (this.disposed) return;
    const next = lineHeightForFontSize(size);
    // 크기가 달라도 행높이가 같으면 화면이 달라질 것이 없다. 실제로는 걸리지
    // 않는다 — 파생 비율이 4/3 > 1 이라 인접한 두 크기의 행높이는 반드시 다르다.
    if (next === this.lineHeight) return;
    const scrollTop = scrollTopForLineHeight(
      this.scrollEl.scrollTop,
      this.lineHeight,
      next,
      this.win.lines.length,
    );
    this.lineHeight = next;
    this.root.style.setProperty("--text-line-height", `${next}px`);
    this.spacerEl.style.height = `${this.win.lines.length * next}px`;
    // 구간이 그대로여도 격자가 바뀌었으므로 renderSlice 의 no-op 을 푼다
    // (블록 top offset 이 행높이 배수라 다시 앉혀야 한다).
    this.slice = null;
    // 로드가 진행 중이면(마운트·경로 변경) scrollTop 은 건드리지 않는다: 지금
    // 화면에 있는 것은 **이전 창**이고, 여기서 옮기면 그 scroll 이벤트가 이전
    // 파일의 byte offset 을 새 경로의 위치로 기록할 수 있다 (settle 은 아직
    // markSynced(null) 상태라 걸러 주지 못한다). 어차피 곧 showWindow 가 복원
    // 위치를 새 격자로 앉힌다.
    if (this.pendingOffset === null) this.scrollEl.scrollTop = scrollTop;
    this.renderSlice();
  }

  /** 스냅샷 반영. 같은 파일이면 **아무것도 하지 않는다** — 스크롤 dispatch 가
   *  되돌아오는 매 렌더마다 위치를 재적용하면 사용자 스크롤과 싸운다 (에코 가드,
   *  shouldAdoptScroll). */
  update(kind: ViewerKind): void {
    if (kind.type !== "textViewer") {
      // 탭의 kind 종류는 생성 후 바뀌지 않는다 — 오면 레지스트리 배선 결함이다.
      console.error("[mast] text view received a non-textViewer kind", kind);
      return;
    }
    if (!shouldAdoptScroll(this.adopted, kind.path)) return;
    this.adopted = { path: kind.path };
    this.path = kind.path;
    this.language = languageForPath(this.path);
    this.pendingOffset = kind.scrollTop;
    this.settle.markSynced(null);
    this.load(kind.scrollTop, true);
  }

  /** unmount 직전 보류분 배출 (탭이 스냅샷에 남아 있을 때만 불린다 —
   *  workspace-view 의 리컨실 계약). */
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

  /** 뷰 내부 keydown (파일 상단 계약) — 전역 가로채기와 층이 다르고, 판정은
   *  textKeyAction 이 전부 한다.
   *
   *  판정된 키는 창을 옮기지 못하는 상황(이미 첫 창에서 Ctrl+Home 등)에도
   *  preventDefault 한다: 같은 키가 어떤 때는 컨테이너 기본 스크롤로 새어 다르게
   *  동작하는 비일관을 만들지 않기 위해서다 (main.ts installNavKeys 와 같은
   *  규약). */
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

  /** 행 격자에 맞춘 페이지 스크롤 — 슬라이스 갱신·모델 기록은 scroll 이벤트가
   *  기존 경로 그대로 처리한다. */
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

  /** 스크롤 이벤트 — 슬라이스는 즉시, 모델 기록은 settle 후. */
  private readonly onScroll = (): void => {
    this.renderSlice();
    const offset = this.topLineOffset();
    if (offset !== null) this.settle.observe(offset);
  };

  /** 최상단 가시 행의 전역 byte offset (모델 scrollTop 의 시맨틱). */
  private topLineOffset(): number | null {
    const starts = this.win.lineStarts;
    if (starts.length === 0) return null;
    return starts[topLineIndex(this.scrollEl.scrollTop, this.lineHeight, starts.length)];
  }

  /** 버튼·단축키 공통 경로. 창이 실제로 움직이지 않는 액션(첫 창에서 prev 등)은
   *  조용히 무시한다 — 같은 창을 다시 읽으면 스크롤만 맨 위로 튄다. */
  private moveWindow(action: WindowAction): void {
    if (windowButtonsDisabled(this.win, this.size)[action]) return;
    // 창을 옮기기 전에 지금 위치를 확정해 둔다 — 이동 후의 scroll 이벤트가
    // 이전 위치를 덮어쓰기 전에 모델에 남긴다.
    this.settle.flush();
    this.load(nextWindowStart(action, this.win, this.size), false);
  }

  /** 창을 읽어 온다. `restore` 면 target 은 **복원할 위치**이고 창 시작은
   *  windowStartForRestore 가 정한다 (target 이 창 가운데쯤 오게); 아니면 target
   *  자체가 창 시작이다 (창 이동 버튼·단축키). 실패는 인라인 에러로 표면화하고
   *  탭은 유지한다 (없는·삭제된 파일도 모델에 남아 재시도가 가능해야 한다). */
  private load(target: number, restore: boolean): void {
    const token = ++this.loadToken;
    this.setBanner("loading…", false);
    this.loadWindow(target, restore, token).catch((err: unknown) => {
      if (this.disposed || token !== this.loadToken) return;
      this.renderError(describeError(err));
    });
  }

  private async loadWindow(target: number, restore: boolean, token: number): Promise<void> {
    // 크기를 먼저 안다: EOF 판정(말미 부분행을 자를지)·범위 표시·창 이동 버튼이
    // 전부 전체 크기 위에 선다.
    const stat = await fsStat(this.distro, this.path);
    if (this.disposed || token !== this.loadToken) return;
    if (stat.is_dir) {
      this.renderError("it is a directory");
      return;
    }

    // 전체 크기를 알아야 하는 계산이라 stat 뒤에 온다.
    let start = restore
      ? windowStartForRestore(target, stat.size)
      : Math.max(0, Math.min(target, stat.size));
    // 파일이 그새 줄어 목표가 EOF 밖이면 마지막 창으로 되감는다.
    if (start >= stat.size) start = Math.max(0, stat.size - WINDOW_BYTES);
    // 목표가 행 시작이면 그 직전 바이트(개행)까지 읽어 둔다 — 선두 부분행 절삭이
    // 목표 행 자체를 먹어치우지 않게 하는 1바이트다. 그 1바이트는 요청 길이에
    // **더해서** 읽는다: 안 더하면 창 커버가 [start-1, start-1+W) 로 밀려
    // 마지막 창이 파일 끝 바이트에 닿지 못하고, 말미 절삭 탓에 파일의 마지막
    // 행이 영영 화면에 뜨지 않는다.
    const readOffset = start > 0 ? start - 1 : 0;
    const readLen = WINDOW_BYTES + (start - readOffset);

    const buffer = await fsReadChunk(this.distro, this.path, readOffset, readLen);
    if (this.disposed || token !== this.loadToken) return;
    const bytes = new Uint8Array(buffer);
    const atEof = bytes.length < readLen || readOffset + bytes.length >= stat.size;

    this.setBanner(null, false);
    this.showWindow(decodeWindow(bytes, readOffset, atEof), stat.size);
    // 창은 이미 플레인으로 화면에 있다 — 색은 그 뒤에 덧입힌다 (계약 2).
    this.startHighlight(token);
  }

  /** 하이라이트 덧입히기 (구문 하이라이팅 계약 2·3). 대상이 아니거나 창이
   *  문턱을 넘으면 **아무 것도 로드하지 않고** 플레인으로 남는다.
   *
   *  로드가 끝난 시점에 뷰가 dispose 됐거나 그새 다른 창을 읽었으면(창 이동
   *  연타·경로 변경) 버린다 — 판정은 로드 응답과 같은 loadToken 이다. 로드
   *  실패는 콘솔에만 남긴다: 플레인 렌더는 이미 정상이라 UI 를 막을 이유가
   *  없다 (활동 핑·창 가시성과 같은 규율). */
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
        // 구간이 그대로여도 내용이 바뀌었으므로 renderSlice 의 no-op 을 푼다.
        this.slice = null;
        this.renderSlice();
      })
      .catch((err: unknown) => {
        console.error("[mast] syntax highlighting failed", err);
      });
  }

  /** 새 창을 화면에 앉힌다 — 전체 높이·범위 표시·버튼 상태를 갱신하고, 보류된
   *  복원 위치가 있으면 **그 위치의 행이 뷰포트 최상단**에 오게, 없으면 창 맨
   *  위로 보낸다. 복원 창은 그 위치보다 앞에서 시작하므로(windowStartForRestore)
   *  여기서 앉히는 scrollTop 이 0 이 아니고, 그만큼 위쪽 문맥이 남는다. */
  private showWindow(win: TextWindow, size: number): void {
    this.win = win;
    this.size = size;
    this.spacerEl.style.height = `${win.lines.length * this.lineHeight}px`;
    this.slice = null;
    // 행별 하이라이트는 창에 붙어 있다 — 새 창은 다시 계산되기 전까지 플레인이다.
    this.highlighted = null;

    const paged = win.start > 0 || win.end < size;
    this.barEl.hidden = !paged;
    if (paged) this.rangeEl.textContent = formatByteRange(win.start, win.end, size);
    // 바가 숨겨져 있어도 상태는 계산해 둔다 — 단축키는 바 없이도 오고, 그때는
    // 넷 다 잠긴 상태(창이 하나뿐)가 맞다.
    const disabled = windowButtonsDisabled(win, size);
    for (const { action, el } of this.buttons) el.disabled = disabled[action];

    const restore = this.pendingOffset;
    this.pendingOffset = null;
    const index = restore === null ? 0 : lineIndexForOffset(win.lineStarts, restore);
    const top = win.lineStarts[index] ?? null;
    // 복원(마운트)은 모델에서 온 값이라 그대로 되돌려 보낼 것이 없다 — scrollTop
    // 대입이 발화시키는 scroll 이벤트를 markSynced 로 잠재운다. 반대로 창 이동은
    // 새 위치를 모델에 남겨야 재마운트가 그 창으로 돌아온다.
    this.settle.markSynced(restore === null ? null : top);
    this.scrollEl.scrollTop = index * this.lineHeight;
    this.renderSlice();
    if (restore === null && top !== null) this.settle.observe(top);
  }

  /** 로드 실패 — 인라인 에러로 표면화하고 탭·모델 위치는 건드리지 않는다
   *  (빈 창이라 topLineOffset 이 null 이고, 저장된 scrollTop 을 0 으로 덮지
   *  않는다: 파일이 돌아오면 원래 지점으로 복원된다). */
  private renderError(message: string): void {
    this.setBanner(`cannot read ${this.path}: ${message}`, true);
    this.showWindow({ start: 0, end: 0, lines: [], lineStarts: [] }, 0);
  }

  /** viewport ± overscan 만큼만 실제 노드를 만든다. 구간이 그대로면 no-op. */
  private renderSlice(): void {
    const range = visibleSlice(
      this.scrollEl.scrollTop,
      this.scrollEl.clientHeight,
      this.win.lines.length,
      this.lineHeight,
    );
    if (this.slice !== null && this.slice.first === range.first && this.slice.last === range.last) {
      return;
    }
    this.slice = { first: range.first, last: range.last };
    this.linesEl.style.top = `${range.top}px`;
    const nodes: HTMLDivElement[] = [];
    for (let i = range.first; i < range.last; i += 1) {
      const el = document.createElement("div");
      el.className = "text-line";
      // innerHTML 에 넣는 문자열의 출처는 hljs 뿐이고 파일 내용은 그 안에서
      // 이스케이프돼 있다 (highlightLines 주석 — 픽스처 테스트가 잠근다).
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
