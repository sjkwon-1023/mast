// @vitest-environment happy-dom
//
// textViewer 뷰의 순수 계산 검증 (21단계 청크 C2 + 체크포인트 2 UX) — 윈도우
// 절삭(부분행·UTF-8 파단 바이트), 가상 스크롤 슬라이스, byte offset ↔ 행 매핑,
// 창 이동 계산·버튼 상태·키 판정·페이지 스크롤, 복원 창 시작, 스크롤 에코 가드,
// settle 디바운스. 창 읽기·스크롤 왕복의 DOM·IPC 경로는 여기 대상이 아니다
// (뷰는 위 결과를 그대로 그리는 얇은 층이라 Windows 수동 검증이 맡는다).
//
// 예외가 **구문 하이라이팅**(v0.3.6)이다: "즉시 플레인 → 나중에 덧입힘"이라는
// 순서 자체가 계약이고 그 판정이 뷰 안에 있으므로, 뷰를 실제로 띄워 mount 한 뒤
// 비동기 완료를 기다려 확인한다. 그래서 이 파일만 happy-dom 환경이다 (상단
// @vitest-environment — pane-view.test.ts 와 같은 관례). 백엔드 IPC 와
// highlight.js 의 dynamic import 는 vi.mock 으로 고정해 결정적으로 돌린다.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HIGHLIGHT_LANGUAGES,
  HIGHLIGHT_MAX_BYTES,
  LINE_HEIGHT_PX,
  ScrollSettle,
  TextView,
  applyHighlightSettings,
  decodeWindow,
  formatByteRange,
  highlightLines,
  languageForPath,
  lineHeightForFontSize,
  lineIndexForOffset,
  nextWindowStart,
  pageScrollTop,
  scrollTopForLineHeight,
  shouldAdoptScroll,
  splitHighlightedLines,
  textKeyAction,
  topLineIndex,
  visibleSlice,
  windowButtonsDisabled,
  windowStartForRestore,
} from "./text-view";
import type { HighlightApi } from "./text-view";
import {
  DEFAULT_VIEWER_FONT_SIZE,
  adjustViewerFontSize,
  applyViewerFontSettings,
  resetViewerFontSize,
} from "./viewer-font";
import type { TimerHost } from "./ack-batcher";
import type { KeySpec } from "./keys";
import type { UiSettings } from "./backend";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

// --- 하이라이트 경로의 mock 배선 --------------------------------------------
// vi.mock 은 hoist 되므로 팩토리가 참조하는 것은 전부 vi.hoisted 로 만든다.
//
// 언어 모듈 팩토리는 **처음 import 될 때 딱 한 번** 돈다 — 그래서 loads 카운터가
// "이 모듈이 로드된 적이 있는가"의 정본이고, "로드하지 않는다"를 주장하는
// 테스트는 자기 실행 전후의 합계 변화(0)로 잠근다 (파일 안 실행 순서에 무관).
// python·json 은 gate 로 완료 시점을 잡아 "플레인 먼저, 색은 나중" 순서와
// dispose 후 stale 콜백을 결정적으로 만든다.

/** 백엔드가 돌려줄 파일 1개 — mount 헬퍼가 갈아 끼운다. */
const file = vi.hoisted(() => ({ bytes: new Uint8Array(0) }));

/** 언어 모듈이 실제로 import 된 횟수. */
const loads = vi.hoisted(() => ({ python: 0, rust: 0, css: 0, json: 0 }));

/** 수동으로 여는 관문 — 열기 전에는 그 언어 모듈의 import 가 끝나지 않는다. */
const gates = vi.hoisted(() => {
  function make(): { opened: Promise<void>; open: () => void } {
    let open = (): void => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open: () => open() };
  }
  return { python: make(), json: make() };
});

/** hljs 대역 — 문법은 관심사가 아니라 `def` 낱말 하나만 토큰으로 감싼다.
 *  실제 hljs 의 이스케이프는 아래 highlightLines 테스트가 진짜 모듈로 잠근다. */
const fakeHljs = vi.hoisted(() => ({
  registerLanguage(_name: string, _language: unknown): void {},
  highlight(code: string): { value: string } {
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return { value: escaped.replace(/\bdef\b/g, '<span class="hljs-keyword">def</span>') };
  },
}));

vi.mock("./backend", () => ({
  fsStat: () => Promise.resolve({ size: file.bytes.length, mtime_ms: 0, is_dir: false }),
  fsReadChunk: (_distro: string | null, _path: string, offset: number, len: number) =>
    Promise.resolve(file.bytes.slice(offset, offset + len).buffer),
}));

vi.mock("highlight.js/lib/core", () => ({ default: fakeHljs }));
vi.mock("highlight.js/styles/vs2015.css", () => ({ default: "" }));
vi.mock("highlight.js/lib/languages/python", async () => {
  loads.python += 1;
  await gates.python.opened;
  return { default: () => ({}) };
});
vi.mock("highlight.js/lib/languages/json", async () => {
  loads.json += 1;
  await gates.json.opened;
  return { default: () => ({}) };
});
vi.mock("highlight.js/lib/languages/rust", () => {
  loads.rust += 1;
  return { default: () => ({}) };
});
vi.mock("highlight.js/lib/languages/css", () => {
  loads.css += 1;
  return { default: () => ({}) };
});

/** 수식키 없는 keydown 1개 — 붙일 수식키만 덮어쓴다. */
function key(name: string, mods: Partial<KeySpec> = {}): KeySpec {
  return { key: name, ctrl: false, alt: false, shift: false, isComposing: false, ...mods };
}

/** 수동 진행 가짜 타이머 — 등록된 콜백을 tick 으로 직접 발화시킨다. */
class FakeTimers implements TimerHost {
  private next = 1;
  private readonly pending = new Map<number, { fn: () => void; ms: number }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.next++;
    this.pending.set(handle, { fn, ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get armed(): number {
    return this.pending.size;
  }

  /** 등록된 마지막 타이머의 지연(ms) — 디바운스 창 확인용. */
  get lastDelay(): number | null {
    let delay: number | null = null;
    for (const entry of this.pending.values()) delay = entry.ms;
    return delay;
  }

  /** 보류 중인 콜백 전부 발화. */
  fire(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.fn();
  }
}

describe("decodeWindow", () => {
  it("keeps every line when the window is the whole file", () => {
    const win = decodeWindow(bytes("alpha\nbeta\ngamma\n"), 0, true);
    expect(win.lines).toEqual(["alpha", "beta", "gamma"]);
    expect(win.lineStarts).toEqual([0, 6, 11]);
    expect(win.start).toBe(0);
    expect(win.end).toBe(17);
  });

  it("keeps a trailing line without a final newline at EOF", () => {
    const win = decodeWindow(bytes("alpha\nbeta"), 0, true);
    expect(win.lines).toEqual(["alpha", "beta"]);
    expect(win.lineStarts).toEqual([0, 6]);
  });

  it("drops the leading partial line when the window starts mid-file", () => {
    // 창이 "pha\nbeta\ngamma\n" 에서 시작 — 첫 조각 "pha" 는 이전 창의 꼬리다.
    const win = decodeWindow(bytes("pha\nbeta\ngamma\n"), 100, true);
    expect(win.lines).toEqual(["beta", "gamma"]);
    // 전역 offset: 창 시작 100 + "pha\n" 4바이트.
    expect(win.lineStarts).toEqual([104, 109]);
    expect(win.start).toBe(104);
  });

  it("drops the trailing partial line when the window stops before EOF", () => {
    const win = decodeWindow(bytes("alpha\nbeta\ngam"), 0, false);
    expect(win.lines).toEqual(["alpha", "beta"]);
    expect(win.end).toBe(11);
  });

  it("trims both ends for a middle window", () => {
    const win = decodeWindow(bytes("pha\nbeta\ngam"), 100, false);
    expect(win.lines).toEqual(["beta"]);
    expect(win.start).toBe(104);
    expect(win.end).toBe(109);
  });

  it("strips a carriage return from display without shifting offsets", () => {
    const win = decodeWindow(bytes("alpha\r\nbeta\r\n"), 0, true);
    expect(win.lines).toEqual(["alpha", "beta"]);
    expect(win.lineStarts).toEqual([0, 7]);
  });

  it("shows the fragment when the window holds no newline at all", () => {
    // 창보다 긴 행 — 전부 잘라내 빈 화면을 만드는 대신 조각을 보여준다.
    const win = decodeWindow(bytes("no-newline-here"), 100, false);
    expect(win.lines).toEqual(["no-newline-here"]);
    expect(win.start).toBe(100);
  });

  it("drops a split multi-byte sequence at the leading edge", () => {
    // "가나" = 3바이트 x 2. 창이 첫 글자 중간(1바이트 뒤)에서 시작한다.
    const full = bytes("가나");
    const win = decodeWindow(full.subarray(1), 100, true);
    // 잘린 continuation 2바이트는 U+FFFD 가 아니라 아예 사라진다.
    expect(win.lines).toEqual(["나"]);
    expect(win.start).toBe(102);
  });

  it("drops a split multi-byte sequence at the trailing edge", () => {
    const full = bytes("가나"); // 6바이트
    const win = decodeWindow(full.subarray(0, 4), 0, false);
    expect(win.lines).toEqual(["가"]);
    expect(win.end).toBe(3);
  });

  it("keeps whole multi-byte characters inside a line-trimmed window", () => {
    const win = decodeWindow(bytes("가\n나다\n라"), 0, false);
    expect(win.lines).toEqual(["가", "나다"]);
    // "가\n" = 4바이트, "나다\n" = 7바이트.
    expect(win.lineStarts).toEqual([0, 4]);
    expect(win.end).toBe(11);
  });

  it("yields nothing when the window is empty", () => {
    const win = decodeWindow(new Uint8Array(0), 512, true);
    expect(win.lines).toEqual([]);
    expect(win.lineStarts).toEqual([]);
    expect(win.start).toBe(512);
    expect(win.end).toBe(512);
  });
});

describe("visibleSlice", () => {
  it("renders the viewport plus overscan on both sides", () => {
    // scrollTop 1600px = 100번째 행, viewport 320px = 20행(+1 걸침).
    const slice = visibleSlice(1600, 320, 1000, LINE_HEIGHT_PX, 20);
    expect(slice.first).toBe(80);
    expect(slice.last).toBe(141);
    expect(slice.top).toBe(80 * LINE_HEIGHT_PX);
  });

  it("clamps at the top and the bottom of the document", () => {
    const top = visibleSlice(0, 320, 1000, LINE_HEIGHT_PX, 20);
    expect(top.first).toBe(0);
    expect(top.top).toBe(0);

    const bottom = visibleSlice(1000 * LINE_HEIGHT_PX, 320, 1000, LINE_HEIGHT_PX, 20);
    expect(bottom.last).toBe(1000);
    expect(bottom.first).toBe(979);
  });

  it("returns an empty range for an empty document", () => {
    expect(visibleSlice(0, 320, 0)).toEqual({ first: 0, last: 0, top: 0 });
  });

  it("survives a zero-height viewport (pane not laid out yet)", () => {
    const slice = visibleSlice(0, 0, 100, LINE_HEIGHT_PX, 20);
    expect(slice.first).toBe(0);
    expect(slice.last).toBe(21);
  });
});

describe("topLineIndex", () => {
  it("스크롤 위치를 행 격자로 내림한다", () => {
    expect(topLineIndex(0, 16, 100)).toBe(0);
    expect(topLineIndex(15, 16, 100)).toBe(0);
    expect(topLineIndex(16, 16, 100)).toBe(1);
    expect(topLineIndex(170, 16, 100)).toBe(10);
  });

  it("마지막 행을 넘지 않고 음수는 0 이다", () => {
    expect(topLineIndex(99999, 16, 5)).toBe(4);
    expect(topLineIndex(-40, 16, 5)).toBe(0);
  });

  it("빈 창·무의미한 격자는 0 이다 (호출자가 분기하지 않아도 되게)", () => {
    expect(topLineIndex(500, 16, 0)).toBe(0);
    expect(topLineIndex(500, 0, 10)).toBe(0);
  });
});

// 줌으로 행높이가 바뀔 때 화면이 어디에 멈추는가 — 뷰어 줌(v0.3.8)의 핵심
// 불변식이다. 지키는 것은 **최상단 가시 행**이고, px 비율이 아니다.
describe("scrollTopForLineHeight", () => {
  it("최상단 가시 행이 유지된다 (확대·축소 양쪽)", () => {
    // 16px 격자에서 10번째 행이 맨 위 → 19px 격자에서도 10번째 행이 맨 위.
    expect(scrollTopForLineHeight(160, 16, 19, 100)).toBe(190);
    expect(scrollTopForLineHeight(190, 19, 16, 100)).toBe(160);
  });

  it("격자에서 벗어나 있던 위치는 그 행의 머리로 스냅한다", () => {
    // 드래그·End 로 격자 밖에 멈춘 상태라도 결과는 항상 행 배수다 — 소수를
    // 허용하면 최상단 행이 반쯤 잘린 채 멈춘다.
    expect(scrollTopForLineHeight(171, 16, 16, 100)).toBe(160);
    expect(scrollTopForLineHeight(171, 16, 24, 100)).toBe(240);
  });

  it("행높이가 그대로면 위치도 그대로다 (행 머리 기준)", () => {
    expect(scrollTopForLineHeight(320, 16, 16, 100)).toBe(320);
  });

  it("빈 창은 맨 위다", () => {
    expect(scrollTopForLineHeight(320, 16, 24, 0)).toBe(0);
  });
});

describe("lineIndexForOffset", () => {
  const starts = [0, 10, 20, 30];

  it("finds the line containing the offset", () => {
    expect(lineIndexForOffset(starts, 0)).toBe(0);
    expect(lineIndexForOffset(starts, 9)).toBe(0);
    expect(lineIndexForOffset(starts, 10)).toBe(1);
    expect(lineIndexForOffset(starts, 25)).toBe(2);
    expect(lineIndexForOffset(starts, 30)).toBe(3);
  });

  it("clamps offsets outside the window", () => {
    expect(lineIndexForOffset(starts, -5)).toBe(0);
    expect(lineIndexForOffset(starts, 9999)).toBe(3);
    expect(lineIndexForOffset([], 42)).toBe(0);
  });

  it("handles a window that does not start at the file start", () => {
    expect(lineIndexForOffset([1000, 1010], 1005)).toBe(0);
    expect(lineIndexForOffset([1000, 1010], 500)).toBe(0);
  });
});

describe("shouldAdoptScroll", () => {
  it("adopts once at mount", () => {
    expect(shouldAdoptScroll(null, "/var/log/syslog")).toBe(true);
  });

  it("never re-adopts for the same file (echo guard)", () => {
    // 우리가 보낸 setViewerScroll 이 스냅샷으로 되돌아오는 매 렌더가 이 경로다.
    expect(shouldAdoptScroll({ path: "/var/log/syslog" }, "/var/log/syslog")).toBe(false);
  });

  it("adopts again when the tab points at another file", () => {
    expect(shouldAdoptScroll({ path: "/var/log/syslog" }, "/etc/hosts")).toBe(true);
  });
});

describe("nextWindowStart", () => {
  const size = 10_000;
  const win = { start: 2_000, end: 3_000 };

  it("jumps to the file ends", () => {
    expect(nextWindowStart("first", win, size, 1_000)).toBe(0);
    expect(nextWindowStart("last", win, size, 1_000)).toBe(9_000);
  });

  it("steps back by one window and forward from the retained end", () => {
    expect(nextWindowStart("prev", win, size, 1_000)).toBe(1_000);
    // next 는 유지 구간 끝에서 이어 붙는다 — 바이트가 빠지지 않는다.
    expect(nextWindowStart("next", win, size, 1_000)).toBe(3_000);
  });

  it("clamps at both ends", () => {
    expect(nextWindowStart("prev", { start: 500, end: 1_500 }, size, 1_000)).toBe(0);
    expect(nextWindowStart("next", { start: 9_500, end: 10_000 }, size, 1_000)).toBe(9_000);
  });

  it("keeps the only window at 0 for a file smaller than the window", () => {
    const small = { start: 0, end: 100 };
    expect(nextWindowStart("last", small, 100, 1_000)).toBe(0);
    expect(nextWindowStart("next", small, 100, 1_000)).toBe(0);
  });
});

describe("windowStartForRestore", () => {
  const size = 10_000;
  const windowBytes = 1_000;

  it("starts at the file head when there is nothing to restore", () => {
    expect(windowStartForRestore(0, size, windowBytes)).toBe(0);
    expect(windowStartForRestore(-5, size, windowBytes)).toBe(0);
  });

  it("keeps the head window when the position is inside the first half window", () => {
    // 300 - 500 < 0 — 앞으로 더 갈 곳이 없으면 그냥 파일 시작이다.
    expect(windowStartForRestore(300, size, windowBytes)).toBe(0);
    expect(windowStartForRestore(500, size, windowBytes)).toBe(0);
  });

  it("centers the restored position inside the window", () => {
    // 501 부터는 앞쪽 문맥이 창 안에 들어온다.
    expect(windowStartForRestore(501, size, windowBytes)).toBe(1);
    expect(windowStartForRestore(5_000, size, windowBytes)).toBe(4_500);
  });

  it("never starts past the last window near EOF", () => {
    // 9_800 - 500 = 9_300 > lastStart(9_000) — 뒤가 비는 대신 앞을 더 가져온다.
    expect(windowStartForRestore(9_800, size, windowBytes)).toBe(9_000);
    expect(windowStartForRestore(9_999, size, windowBytes)).toBe(9_000);
    // 파일이 그새 줄어 위치가 EOF 밖이어도 마지막 창을 넘지 않는다.
    expect(windowStartForRestore(50_000, size, windowBytes)).toBe(9_000);
  });

  it("keeps the only window at 0 for a file smaller than the window", () => {
    expect(windowStartForRestore(400, 600, windowBytes)).toBe(0);
  });

  it("puts the restored line at the viewport top with context above it", () => {
    // 8바이트 행 100개("line000\n"…) — 복원 위치 400 은 line050 의 시작이다.
    const file = bytes(
      Array.from({ length: 100 }, (_, i) => `line${String(i).padStart(3, "0")}\n`).join(""),
    );
    const target = 400;
    const start = windowStartForRestore(target, file.length, 200);
    expect(start).toBe(300);

    // 뷰와 같은 읽기: 창 시작 직전 1바이트부터 windowBytes 만큼.
    const readOffset = start - 1;
    const win = decodeWindow(file.subarray(readOffset, readOffset + 200), readOffset, false);
    const index = lineIndexForOffset(win.lineStarts, target);
    // 최상단 가시 행은 저장된 위치의 행 그대로다.
    expect(win.lineStarts[index]).toBe(target);
    // 그 위로 스크롤할 문맥이 창 안에 남는다 (이전에는 index 가 0 이었다).
    expect(index).toBeGreaterThan(0);
    expect(win.lines[index]).toBe("line050");
  });
});

describe("windowButtonsDisabled", () => {
  const size = 10_000;
  const windowBytes = 1_000;

  it("locks the head buttons on the first window", () => {
    expect(windowButtonsDisabled({ start: 0, end: 1_000 }, size, windowBytes)).toEqual({
      first: true,
      prev: true,
      next: false,
      last: false,
    });
  });

  it("unlocks everything in the middle of the file", () => {
    expect(windowButtonsDisabled({ start: 2_000, end: 3_000 }, size, windowBytes)).toEqual({
      first: false,
      prev: false,
      next: false,
      last: false,
    });
  });

  it("locks the tail buttons on the last window", () => {
    expect(windowButtonsDisabled({ start: 9_000, end: 10_000 }, size, windowBytes)).toEqual({
      first: false,
      prev: false,
      next: true,
      last: true,
    });
  });

  it("locks the tail buttons on a leading-trimmed last window (start past size−W)", () => {
    // 실제 마지막 창은 요청 시작(size−W)이 행 경계가 아니라 선두 절삭으로
    // win.start 가 size−W 보다 커진다. "창이 움직이는가" 판정은 이 창에서
    // next/last 를 영영 못 잠갔다 (리뷰 finding — 누르면 같은 창 재로드 +
    // 스크롤 덮어쓰기). 커버 범위 판정(end >= size)은 정확히 잠근다.
    expect(windowButtonsDisabled({ start: 9_003, end: 10_000 }, size, windowBytes)).toEqual({
      first: false,
      prev: false,
      next: true,
      last: true,
    });
  });

  it("locks all four when the file fits in one window", () => {
    expect(windowButtonsDisabled({ start: 0, end: 500 }, 500, windowBytes)).toEqual({
      first: true,
      prev: true,
      next: true,
      last: true,
    });
    // 로드 실패의 빈 창도 같다 (누를 곳이 없다).
    expect(windowButtonsDisabled({ start: 0, end: 0 }, 0, windowBytes)).toEqual({
      first: true,
      prev: true,
      next: true,
      last: true,
    });
  });
});

describe("textKeyAction", () => {
  it("moves the window with the Ctrl combinations", () => {
    expect(textKeyAction(key("PageUp", { ctrl: true }))).toEqual({ type: "window", action: "prev" });
    expect(textKeyAction(key("PageDown", { ctrl: true }))).toEqual({
      type: "window",
      action: "next",
    });
    expect(textKeyAction(key("Home", { ctrl: true }))).toEqual({ type: "window", action: "first" });
    expect(textKeyAction(key("End", { ctrl: true }))).toEqual({ type: "window", action: "last" });
  });

  it("pages the viewport with bare PageUp/PageDown", () => {
    expect(textKeyAction(key("PageUp"))).toEqual({ type: "page", delta: -1 });
    expect(textKeyAction(key("PageDown"))).toEqual({ type: "page", delta: 1 });
  });

  it("leaves the remaining scroll keys to the browser", () => {
    for (const name of ["Home", "End", "ArrowUp", "ArrowDown", "Enter", " "]) {
      expect(textKeyAction(key(name))).toBeNull();
    }
  });

  it("ignores the globally owned combinations", () => {
    // Ctrl+Tab·Ctrl+1~9 는 window capture(keys.ts) 소유라 여기까지 오지 않지만,
    // 와도 소비하지 않는다. Alt 계열은 전역 pane 이동이다.
    expect(textKeyAction(key("Tab", { ctrl: true }))).toBeNull();
    expect(textKeyAction(key("1", { ctrl: true }))).toBeNull();
    expect(textKeyAction(key("PageDown", { alt: true }))).toBeNull();
    expect(textKeyAction(key("ArrowUp", { alt: true }))).toBeNull();
  });

  it("does not take shift variants or IME composition", () => {
    expect(textKeyAction(key("PageUp", { ctrl: true, shift: true }))).toBeNull();
    expect(textKeyAction(key("PageDown", { shift: true }))).toBeNull();
    expect(textKeyAction(key("PageDown", { isComposing: true }))).toBeNull();
    expect(textKeyAction(key("PageDown", { ctrl: true, isComposing: true }))).toBeNull();
  });
});

describe("pageScrollTop", () => {
  // viewport 320px = 20행 — 한 행을 겹쳐 남기므로 한 페이지는 19행이다.
  const viewport = 320;
  const step = 19 * LINE_HEIGHT_PX;

  it("moves a whole page minus one overlapping line", () => {
    expect(pageScrollTop(0, viewport, 10_000, 1)).toBe(step);
    expect(pageScrollTop(step, viewport, 10_000, -1)).toBe(0);
  });

  it("lands on a line boundary from a misaligned start", () => {
    // 100px = 6.25행 → 가장 가까운 6행으로 스냅한 뒤 한 페이지.
    expect(pageScrollTop(100, viewport, 10_000, 1)).toBe((6 + 19) * LINE_HEIGHT_PX);
    expect(pageScrollTop(100, viewport, 10_000, 1) % LINE_HEIGHT_PX).toBe(0);
  });

  it("clamps at both ends of the document", () => {
    expect(pageScrollTop(100, viewport, 10_000, -1)).toBe(0);
    expect(pageScrollTop(960, viewport, 1_000, 1)).toBe(1_000);
    // 문서가 viewport 보다 짧으면 움직일 곳이 없다.
    expect(pageScrollTop(0, viewport, 0, 1)).toBe(0);
  });

  it("still moves one line when the pane is not laid out yet", () => {
    expect(pageScrollTop(0, 0, 10_000, 1)).toBe(LINE_HEIGHT_PX);
  });
});

describe("formatByteRange", () => {
  it("groups digits without depending on the ICU locale", () => {
    expect(formatByteRange(0, 524_288, 12_345_678)).toBe("bytes 0–524,288 of 12,345,678");
  });
});

describe("ScrollSettle", () => {
  function make(): { settle: ScrollSettle; timers: FakeTimers; sent: number[] } {
    const timers = new FakeTimers();
    const sent: number[] = [];
    const settle = new ScrollSettle((offset) => sent.push(offset), 500, timers);
    return { settle, timers, sent };
  }

  it("sends only the last position after the settle window", () => {
    const { settle, timers, sent } = make();
    settle.observe(100);
    settle.observe(200);
    settle.observe(300);
    // 디바운스 — 스크롤이 멎기 전에는 아무것도 나가지 않는다.
    expect(sent).toEqual([]);
    expect(timers.armed).toBe(1);
    expect(timers.lastDelay).toBe(500);
    timers.fire();
    expect(sent).toEqual([300]);
  });

  it("restarts the settle window on every scroll event", () => {
    const { settle, timers, sent } = make();
    settle.observe(100);
    const first = timers.armed;
    settle.observe(200);
    // 이전 타이머는 취소되고 새 것 하나만 남는다 (throttle 이 아니라 debounce).
    expect(first).toBe(1);
    expect(timers.armed).toBe(1);
    timers.fire();
    expect(sent).toEqual([200]);
  });

  it("flushes the pending position immediately (unmount path)", () => {
    const { settle, timers, sent } = make();
    settle.observe(700);
    settle.flush();
    expect(sent).toEqual([700]);
    // 타이머는 취소돼 이중 전송이 없다.
    expect(timers.armed).toBe(0);
    timers.fire();
    expect(sent).toEqual([700]);
  });

  it("is a no-op when there is nothing pending", () => {
    const { settle, sent } = make();
    settle.flush();
    expect(sent).toEqual([]);
  });

  it("never re-sends the position the model already holds (echo guard)", () => {
    const { settle, timers, sent } = make();
    // 마운트 복원 — scrollTop 대입이 발화시킨 scroll 이벤트가 되돌아오는 경로.
    settle.markSynced(4_096);
    settle.observe(4_096);
    expect(timers.armed).toBe(0);
    timers.fire();
    expect(sent).toEqual([]);

    // 실제로 움직이면 나간다. 그 뒤 원래 위치로 돌아오면 다시 조용해진다.
    settle.observe(8_192);
    timers.fire();
    expect(sent).toEqual([8_192]);
    settle.observe(8_192);
    expect(timers.armed).toBe(0);
  });

  it("drops the pending position when the model position is re-fixed", () => {
    const { settle, timers, sent } = make();
    settle.observe(100);
    // 창 이동·경로 변경으로 좌표계가 갈린 경우 — 옛 보류분은 버린다.
    settle.markSynced(null);
    expect(timers.armed).toBe(0);
    timers.fire();
    expect(sent).toEqual([]);
  });

  it("stops the timer on dispose without sending", () => {
    const { settle, timers, sent } = make();
    settle.observe(100);
    settle.dispose();
    expect(timers.armed).toBe(0);
    timers.fire();
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 구문 하이라이팅 (v0.3.6)
// ---------------------------------------------------------------------------

describe("languageForPath", () => {
  const active = DEFAULT_HIGHLIGHT_LANGUAGES;

  it("주력 스택의 확장자를 언어로 옮긴다", () => {
    // 기본 목록 8개가 전부 확장자에서 도달 가능해야 한다 — 도달하지 못하는
    // 기본값은 죽은 설정이다. (같은 이름 목록이 백엔드 commands.rs 의
    // HIGHLIGHT_LANGUAGES 에도 있다 — 둘은 같이 움직인다.)
    const table: Record<string, string> = {
      "/w/app.py": "python",
      "/w/api.pyi": "python",
      "/w/next.config.js": "javascript",
      "/w/page.jsx": "javascript",
      "/w/util.mjs": "javascript",
      "/w/store.ts": "typescript",
      "/w/page.tsx": "typescript",
      "/w/main.rs": "rust",
      "/w/package.json": "json",
      "/w/Cargo.toml": "toml",
      "/w/globals.css": "css",
      "/w/index.html": "html",
    };
    for (const [path, language] of Object.entries(table)) {
      expect(languageForPath(path, active)).toBe(language);
    }
    // 기본 목록에 도달 못 하는 이름이 남아 있지 않다.
    expect(new Set(Object.values(table))).toEqual(new Set(active));
  });

  it("확장자는 대소문자를 가리지 않는다", () => {
    expect(languageForPath("/w/APP.PY", active)).toBe("python");
  });

  it("맵에 없는 확장자·확장자 없는 파일·dotfile 은 대상이 아니다", () => {
    expect(languageForPath("/w/notes.txt", active)).toBeNull();
    expect(languageForPath("/var/log/syslog", active)).toBeNull();
    expect(languageForPath("/home/u/.bashrc", active)).toBeNull();
    // 디렉터리 이름의 점은 파일 확장자가 아니다.
    expect(languageForPath("/w/site.com/README", active)).toBeNull();
  });

  it("활성 목록 밖의 언어는 대상이 아니다 (빈 목록 = 하이라이팅 끄기)", () => {
    expect(languageForPath("/w/main.rs", ["python"])).toBeNull();
    expect(languageForPath("/w/app.py", ["python"])).toBe("python");
    expect(languageForPath("/w/app.py", [])).toBeNull();
  });
});

describe("splitHighlightedLines", () => {
  it("태그가 없으면 그냥 개행으로 나눈다", () => {
    expect(splitHighlightedLines("alpha\nbeta")).toEqual(["alpha", "beta"]);
    expect(splitHighlightedLines("alpha")).toEqual(["alpha"]);
    expect(splitHighlightedLines("")).toEqual([""]);
    // 개행 수 + 1 — 빈 꼬리 행도 하나로 센다 (창의 행 배열과 길이를 맞춘다).
    expect(splitHighlightedLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("한 행 안에서 닫히는 span 은 그대로 둔다", () => {
    const html = '<span class="hljs-keyword">def</span> f():\nx';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="hljs-keyword">def</span> f():',
      "x",
    ]);
  });

  it("여러 행에 걸친 span 을 행마다 닫고 다시 연다", () => {
    // 파이썬 삼중따옴표·블록 주석이 이 모양이다 — 그냥 자르면 각 행이 불균형
    // HTML 이 되어 브라우저가 제멋대로 닫는다.
    const html = '<span class="hljs-string">"""doc\nmore"""</span>;';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="hljs-string">"""doc</span>',
      '<span class="hljs-string">more"""</span>;',
    ]);
  });

  it("중첩 span 도 안쪽부터 닫고 같은 순서로 다시 연다", () => {
    const html = '<span class="a"><span class="b">x\ny</span>z\n</span>w';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="a"><span class="b">x</span></span>',
      '<span class="a"><span class="b">y</span>z</span>',
      '<span class="a"></span>w',
    ]);
  });

  it("이스케이프된 꺾쇠는 태그로 보지 않는다", () => {
    expect(splitHighlightedLines("&lt;span&gt;\n&lt;/span&gt;")).toEqual([
      "&lt;span&gt;",
      "&lt;/span&gt;",
    ]);
  });
});

describe("highlightLines", () => {
  /** 진짜 highlight.js — 이스케이프 보증은 대역이 아니라 실제 모듈로 잠근다.
   *  (이 파일의 vi.mock 은 importActual 에 걸리지 않는다.) */
  async function realHljs(): Promise<HighlightApi> {
    const core = await vi.importActual<{ default: HighlightApi & Record<string, unknown> }>(
      "highlight.js/lib/core",
    );
    const language = await vi.importActual<{ default: unknown }>(
      "highlight.js/lib/languages/javascript",
    );
    const register = core.default.registerLanguage as (name: string, fn: unknown) => void;
    register("javascript", language.default);
    return core.default;
  }

  it("악성 내용은 마크업이 되지 못한다 (innerHTML 경로의 근거)", async () => {
    const hljs = await realHljs();
    const source = [
      'const a = "<script>alert(1)</script>";',
      "// <img src=x onerror=alert(1)>",
      'const esc = "]0;pwned";',
      "const amp = a && b;",
    ];
    const out = highlightLines(source, "javascript", hljs);
    expect(out).not.toBeNull();
    const html = (out ?? []).join("\n");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;&amp;");

    // 실제로 DOM 에 넣어도 남는 엘리먼트는 hljs 의 span 뿐이다.
    const el = document.createElement("div");
    el.innerHTML = html;
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    expect([...el.querySelectorAll("*")].every((node) => node.tagName === "SPAN")).toBe(true);
    // ESC·BEL 은 HTML 특수문자가 아니라 문자 그대로 남는다 (터미널이 아니므로
    // 해석되지 않는다) — 사라지지 않는다는 사실만 확인한다.
    expect(el.textContent).toContain("]0;pwned");
  });

  it("행마다 따로 그려도 원문이 한 글자도 상하지 않는다", async () => {
    const hljs = await realHljs();
    // 템플릿 리터럴이 세 행에 걸친다 — 뷰가 행별 div 로 그리므로, 걸친 span 이
    // 행마다 균형 잡혀 있지 않으면 여기서 텍스트가 어긋난다.
    const source = ["const t = `가나다", "  <b>&</b>", "\tend`;", "", "if (x < 1) return;"];
    const out = highlightLines(source, "javascript", hljs) ?? [];
    expect(out).toHaveLength(source.length);
    for (const [index, line] of source.entries()) {
      const el = document.createElement("div");
      el.innerHTML = out[index];
      expect(el.textContent).toBe(line);
      expect(el.querySelector("b")).toBeNull();
    }
  });

  it("행 수가 어긋나면 null 을 돌려 플레인으로 남는다", () => {
    // 행과 색이 밀린 채 그리느니 색을 포기한다.
    const broken: HighlightApi = { highlight: () => ({ value: "one" }) };
    expect(highlightLines(["one", "two"], "python", broken)).toBeNull();
  });
});

describe("TextView 하이라이트 적용", () => {
  function totalLoads(): number {
    return loads.python + loads.rust + loads.css + loads.json;
  }

  function mount(path: string, text: string): TextView {
    file.bytes = encoder.encode(text);
    const parent = document.createElement("div");
    document.body.append(parent);
    return new TextView(
      parent,
      1,
      null,
      { type: "textViewer", path, scrollTop: 0 },
      () => Promise.resolve(null),
    );
  }

  function textLines(view: TextView): HTMLElement[] {
    return [...view.root.querySelectorAll<HTMLElement>(".text-line")];
  }

  /** 보류 중인 마이크로태스크·타이머를 흘려보낸다 — "덧입혀지지 않았다"를
   *  주장하기 전에 붙을 기회를 충분히 준다. */
  async function settleAll(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    // 기본 목록으로 되돌린다 (null 은 "미설정"이라 덮지 않는다).
    applyHighlightSettings(settings([...DEFAULT_HIGHLIGHT_LANGUAGES]));
    document.body.replaceChildren();
  });

  function settings(highlightLanguages: string[] | null): UiSettings {
    return { fontFamily: null, fontSize: null, highlightLanguages, log: null, remote: null };
  }

  it("플레인으로 먼저 뜨고, 모듈이 도착한 뒤에 색이 덧입혀진다", async () => {
    const view = mount("/w/app.py", "def one():\n    return 1\n");
    await vi.waitFor(() => {
      expect(textLines(view)).toHaveLength(2);
    });
    // 여기까지 모듈은 관문에 막혀 있다 — 열기는 그걸 기다리지 않았다.
    expect(loads.python).toBe(1);
    expect(view.root.querySelector(".hljs-keyword")).toBeNull();
    expect(textLines(view)[0].textContent).toBe("def one():");

    gates.python.open();
    await vi.waitFor(() => {
      expect(view.root.querySelector(".hljs-keyword")).not.toBeNull();
    });
    // 텍스트는 그대로이고 토큰만 감싸였다.
    expect(textLines(view)[0].textContent).toBe("def one():");
    expect(textLines(view)[1].textContent).toBe("    return 1");
    view.dispose();
  });

  it("맵에 없는 확장자는 모듈을 로드하지 않는다", async () => {
    const before = totalLoads();
    const view = mount("/w/notes.txt", "def one():\nplain\n");
    await vi.waitFor(() => {
      expect(textLines(view)).toHaveLength(2);
    });
    await settleAll();
    expect(view.root.querySelector(".text-line span")).toBeNull();
    expect(totalLoads()).toBe(before);
    view.dispose();
  });

  it("활성 목록 밖의 언어는 모듈을 로드하지 않는다", async () => {
    applyHighlightSettings(settings(["python"]));
    const before = totalLoads();
    const view = mount("/w/main.rs", "fn main() { def; }\n");
    await vi.waitFor(() => {
      expect(textLines(view)).toHaveLength(1);
    });
    await settleAll();
    expect(view.root.querySelector(".text-line span")).toBeNull();
    expect(totalLoads()).toBe(before);
    expect(loads.rust).toBe(0);
    view.dispose();
  });

  it("빈 highlightLanguages 는 하이라이팅을 끈다", async () => {
    applyHighlightSettings(settings([]));
    const before = totalLoads();
    const view = mount("/w/app.py", "def one():\n");
    await vi.waitFor(() => {
      expect(textLines(view)).toHaveLength(1);
    });
    await settleAll();
    expect(view.root.querySelector(".text-line span")).toBeNull();
    expect(totalLoads()).toBe(before);
    view.dispose();
  });

  it("문턱을 넘는 창은 플레인으로 남는다 (모듈 로드 없음)", async () => {
    const line = `.a${"x".repeat(60)} { color: red }\n`;
    const count = Math.ceil((HIGHLIGHT_MAX_BYTES + 1024) / line.length);
    const before = totalLoads();
    const view = mount("/w/big.css", line.repeat(count));
    await vi.waitFor(() => {
      expect(textLines(view).length).toBeGreaterThan(0);
    });
    await settleAll();
    expect(view.root.querySelector(".text-line span")).toBeNull();
    expect(totalLoads()).toBe(before);
    expect(loads.css).toBe(0);
    view.dispose();
  });

  it("빈 파일은 로드도 렌더도 하지 않는다", async () => {
    const before = totalLoads();
    const view = mount("/w/empty.py", "");
    await settleAll();
    expect(textLines(view)).toHaveLength(0);
    expect(totalLoads()).toBe(before);
    view.dispose();
  });

  it("dispose 뒤에 도착한 모듈은 아무 것도 건드리지 않는다", async () => {
    const view = mount("/w/package.json", '{\n  "a": 1\n}\n');
    await vi.waitFor(() => {
      expect(textLines(view)).toHaveLength(3);
    });
    expect(loads.json).toBe(1);
    view.dispose();

    // 관문을 여기서 연다 — 콜백은 이미 사라진 뷰에 도착한다.
    gates.json.open();
    await settleAll();
    expect(view.root.querySelector(".text-line span")).toBeNull();
    expect(view.root.isConnected).toBe(false);
  });
});

// 설정 글꼴이 커지면 **행 격자도 같이** 커져야 한다 — 격자(spacer 높이·슬라이스
// 위치·scrollTop)는 CSS 가 아니라 TS 가 계산하므로, 글자만 키우면 큰 글자가 16px
// 행 안에서 잘린다. 그 연결이 이 파일의 다른 계약(가상 스크롤)과 붙어 있어 뷰를
// 실제로 띄워 확인한다.
//
// v0.3.8 부터는 **떠 있는 뷰**에도 같은 일이 일어난다 (줌) — 그래서 이 describe
// 는 부팅 경로뿐 아니라 라이브 재적용과 레지스트리 수명까지 본다.
describe("TextView 행 격자와 설정 글꼴", () => {
  function mount(text: string): TextView {
    file.bytes = encoder.encode(text);
    const parent = document.createElement("div");
    document.body.append(parent);
    return new TextView(
      parent,
      1,
      null,
      { type: "textViewer", path: "/w/notes.txt", scrollTop: 0 },
      () => Promise.resolve(null),
    );
  }

  async function mounted(text: string, lines: number): Promise<TextView> {
    const view = mount(text);
    await vi.waitFor(() => {
      expect(view.root.querySelectorAll(".text-line")).toHaveLength(lines);
    });
    return view;
  }

  function spacerHeight(view: TextView): string {
    return view.root.querySelector<HTMLElement>(".text-spacer")?.style.height ?? "";
  }

  beforeEach(() => {
    applyViewerFontSettings({
      fontFamily: null,
      fontSize: null,
      highlightLanguages: null,
      log: null,
      remote: null,
    });
    document.body.replaceChildren();
  });

  // 글꼴은 **모듈 수준** 상태라 이 describe 를 벗어나서도 남는다 — 뒤에 TextView
  // 를 띄우는 describe 가 추가되면 여기서 키운 격자를 물려받아 영문 모를 실패를
  // 본다. 나갈 때 되돌려 파일 안 실행 순서에 무관하게 만든다.
  afterAll(() => {
    applyViewerFontSettings({
      fontFamily: null,
      fontSize: null,
      highlightLanguages: null,
      log: null,
      remote: null,
    });
  });

  it("기본 크기의 행높이는 종전 상수 그대로다", () => {
    expect(lineHeightForFontSize(DEFAULT_VIEWER_FONT_SIZE)).toBe(LINE_HEIGHT_PX);
  });

  it("행높이는 글자 크기에 비례하고 정수 px 로 떨어진다", () => {
    // 백엔드가 허용하는 범위(6~72)의 양 끝과 그 사이 — 비율 16/12 를 유지한다.
    expect(lineHeightForFontSize(6)).toBe(8);
    expect(lineHeightForFontSize(15)).toBe(20);
    expect(lineHeightForFontSize(20)).toBe(27); // 26.67 → 반올림, 소수 금지
    expect(lineHeightForFontSize(72)).toBe(96);
  });

  it("미설정이면 격자가 종전과 같다", async () => {
    const view = await mounted("one\ntwo\n", 2);
    expect(view.root.style.getPropertyValue("--text-line-height")).toBe(`${LINE_HEIGHT_PX}px`);
    expect(spacerHeight(view)).toBe(`${2 * LINE_HEIGHT_PX}px`);
    view.dispose();
  });

  it("설정 크기를 키우면 행높이·spacer 가 같이 커진다", async () => {
    applyViewerFontSettings({
      fontFamily: null,
      fontSize: 24,
      highlightLanguages: null,
      log: null,
      remote: null,
    });
    const view = await mounted("one\ntwo\nthree\n", 3);
    const lineHeight = lineHeightForFontSize(24);
    expect(lineHeight).toBe(32);
    expect(view.root.style.getPropertyValue("--text-line-height")).toBe(`${lineHeight}px`);
    expect(spacerHeight(view)).toBe(`${3 * lineHeight}px`);
    view.dispose();
  });

  /** 뷰의 실스크롤 컨테이너 — 줌 전후 scrollTop 을 직접 본다. */
  function scrollEl(view: TextView): HTMLElement {
    const el = view.root.querySelector<HTMLElement>(".text-scroll");
    if (el === null) throw new Error("text-scroll not found");
    return el;
  }

  /** 한 창에 다 들어가는 여러 행. 행 수는 overscan(20) 안에 두어 happy-dom 의
   *  clientHeight 0 에서도 전 행이 실제로 그려지게 한다 — 그래야 `mounted` 의
   *  대기 조건이 성립한다. */
  const ZOOM_LINES = 20;
  function manyLines(count: number): string {
    return `${Array.from({ length: count }, (_, i) => `line ${i}`).join("\n")}\n`;
  }

  it("줌이 떠 있는 뷰의 행 격자를 다시 앉힌다 — 최상단 가시 행은 그대로", async () => {
    const view = await mounted(manyLines(ZOOM_LINES), ZOOM_LINES);
    scrollEl(view).scrollTop = 10 * LINE_HEIGHT_PX; // 10번째 행이 맨 위

    adjustViewerFontSize(2); // 12 → 14px
    const lineHeight = lineHeightForFontSize(14);
    expect(lineHeight).toBe(19);
    expect(view.root.style.getPropertyValue("--text-line-height")).toBe(`${lineHeight}px`);
    expect(spacerHeight(view)).toBe(`${ZOOM_LINES * lineHeight}px`);
    // 픽셀이 아니라 **행**이 보존된다.
    expect(scrollEl(view).scrollTop).toBe(10 * lineHeight);

    resetViewerFontSize();
    expect(view.root.style.getPropertyValue("--text-line-height")).toBe(`${LINE_HEIGHT_PX}px`);
    expect(spacerHeight(view)).toBe(`${ZOOM_LINES * LINE_HEIGHT_PX}px`);
    expect(scrollEl(view).scrollTop).toBe(10 * LINE_HEIGHT_PX);
    view.dispose();
  });

  it("줌 뒤에 열리는 뷰는 현재 줌 크기로 열린다", async () => {
    adjustViewerFontSize(6); // 12 → 18px
    const view = await mounted("one\ntwo\n", 2);
    const lineHeight = lineHeightForFontSize(18);
    expect(lineHeight).toBe(24);
    expect(view.root.style.getPropertyValue("--text-line-height")).toBe(`${lineHeight}px`);
    expect(spacerHeight(view)).toBe(`${2 * lineHeight}px`);
    view.dispose();
  });

  it("dispose 된 뷰는 줌을 더 받지 않는다 (등록/해제 짝)", async () => {
    const view = await mounted("one\ntwo\n", 2);
    view.dispose();
    adjustViewerFontSize(6);
    // 레지스트리에서 빠졌으므로 격자는 dispose 시점 그대로다.
    expect(view.root.style.getPropertyValue("--text-line-height")).toBe(`${LINE_HEIGHT_PX}px`);
    expect(spacerHeight(view)).toBe(`${2 * LINE_HEIGHT_PX}px`);
  });
});
