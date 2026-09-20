import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

import {
  OutputSettle,
  SETTLE_CAP_MS,
  SETTLE_QUIET_MS,
  restoreTargetLine,
  scrollOffsetToRemember,
  scrollbackWipeRestoreOffset,
} from "./scroll";
import { clampFontSize } from "../../shared/font-size";
import { altArrowSequence, isCopySelectionKey, shouldOpenLink } from "./interaction";

describe("clampFontSize", () => {
  it("범위 안의 값은 그대로 통과한다", () => {
    expect(clampFontSize(13)).toBe(13);
    expect(clampFontSize(6)).toBe(6);
    expect(clampFontSize(72)).toBe(72);
  });

  it("범위를 벗어난 요청은 에러가 아니라 경계에 멈춘다", () => {
    expect(clampFontSize(5)).toBe(6);
    expect(clampFontSize(-100)).toBe(6);
    expect(clampFontSize(73)).toBe(72);
    expect(clampFontSize(1000)).toBe(72);
  });

  it("백엔드 FONT_SIZE_RANGE(6..=72)와 같은 경계다 — 동기화 계약", () => {
    // 경계 바깥 한 칸씩: 6·72 는 유효, 5·73 은 접힌다.
    expect(clampFontSize(6)).toBe(6);
    expect(clampFontSize(5)).not.toBe(5);
    expect(clampFontSize(72)).toBe(72);
    expect(clampFontSize(73)).not.toBe(73);
  });

  it("정수 px 로 접는다 (셀 폭 반올림이 fit 계산과 어긋나지 않게)", () => {
    expect(clampFontSize(13.4)).toBe(13);
    expect(clampFontSize(13.5)).toBe(14);
  });
});

// 링크 클릭 정책 (ADR-0012) — 클릭 한 번이 Windows ShellExecute 로 가는 경로라
// 판정 자체가 보안 표면이다. 백엔드도 같은 스킴 검사를 하지만(이중), 여기서 막는 것이
// 사용자에게 보이는 계약이다.
describe("shouldOpenLink", () => {
  it("마우스 추적이 꺼져 있는 http/https 만 연다", () => {
    expect(shouldOpenLink("https://example.com/a?b=1&c=2", "none")).toBe(true);
    expect(shouldOpenLink("http://localhost:5173/", "none")).toBe(true);
  });

  it("TUI 가 마우스를 쓰는 중이면 클릭은 그 앱의 것이다", () => {
    // vim·tmux·에이전트 TUI 안에서 클릭이 브라우저를 여는 것은 명백한 오작동이다.
    for (const mode of ["x10", "vt200", "drag", "any"]) {
      expect(shouldOpenLink("https://example.com", mode)).toBe(false);
    }
  });

  it("http/https 가 아닌 것은 전부 거부한다", () => {
    // 터미널에 텍스트를 찍을 수 있는 쪽이면 누구나 겨눌 수 있는 표면이라,
    // 등록된 프로토콜 핸들러로 가는 길을 열어 두지 않는다.
    expect(shouldOpenLink("file:///etc/passwd", "none")).toBe(false);
    expect(shouldOpenLink("ms-settings:privacy", "none")).toBe(false);
    expect(shouldOpenLink("javascript:alert(1)", "none")).toBe(false);
    expect(shouldOpenLink("not a url", "none")).toBe(false);
    expect(shouldOpenLink("", "none")).toBe(false);
  });
});

describe("isCopySelectionKey", () => {
  // 판정이 터미널 뷰와 기록 뷰에 공유되므로(shared/keys.ts 정본 표) 여기서 잠근다 —
  // 갈라지면 한쪽 표면의 복사가 조용히 죽는다.
  const key = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      key: "c",
      ...init,
    }) as KeyboardEvent;

  it("복사는 선택이 있을 때만이다 — 선택 없는 Ctrl+C 는 SIGINT 로 통과한다", () => {
    expect(isCopySelectionKey(key({ ctrlKey: true }), true)).toBe(true);
    expect(isCopySelectionKey(key({ ctrlKey: true }), false)).toBe(false);
  });

  it("Ctrl+Shift+C 와 Ctrl+Insert 도 같은 복사 키다", () => {
    expect(isCopySelectionKey(key({ ctrlKey: true, shiftKey: true }), true)).toBe(true);
    expect(isCopySelectionKey(key({ ctrlKey: true, key: "Insert" }), true)).toBe(true);
  });

  it("Shift+Insert 는 붙여넣기라 복사로 잡지 않는다", () => {
    expect(isCopySelectionKey(key({ shiftKey: true, key: "Insert" }), true)).toBe(false);
    expect(
      isCopySelectionKey(key({ ctrlKey: true, shiftKey: true, key: "Insert" }), true),
    ).toBe(false);
  });

  it("Alt 가 끼거나 Ctrl 이 없으면 터미널의 것이다", () => {
    expect(isCopySelectionKey(key({ ctrlKey: true, altKey: true }), true)).toBe(false);
    expect(isCopySelectionKey(key({}), true)).toBe(false);
    expect(isCopySelectionKey(key({ ctrlKey: true, key: "v" }), true)).toBe(false);
  });
});

describe("altArrowSequence", () => {
  // xterm 의 Alt→Ctrl 재작성 우회 판정 — 여기가 틀리면 TUI 는 Alt 대신 Ctrl 을 받는다.
  const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({
      key: "ArrowUp",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      ...init,
    }) as KeyboardEvent;

  it("Alt 단독 + 방향키 4종은 실제 Alt 시퀀스를 돌려준다", () => {
    expect(altArrowSequence(ev({ key: "ArrowUp", altKey: true }))).toBe("\x1b[1;3A");
    expect(altArrowSequence(ev({ key: "ArrowDown", altKey: true }))).toBe("\x1b[1;3B");
    expect(altArrowSequence(ev({ key: "ArrowRight", altKey: true }))).toBe("\x1b[1;3C");
    expect(altArrowSequence(ev({ key: "ArrowLeft", altKey: true }))).toBe("\x1b[1;3D");
  });

  it("수식이 더 붙거나 Alt 가 없으면 null — xterm·pane 이동 소유다", () => {
    for (const init of [
      { key: "ArrowUp" },
      { key: "ArrowUp", shiftKey: true },
      { key: "ArrowUp", altKey: true, shiftKey: true }, // pane 이동
      { key: "ArrowUp", altKey: true, ctrlKey: true },
      { key: "ArrowUp", altKey: true, metaKey: true },
      { key: "a", altKey: true },
    ]) {
      expect(altArrowSequence(ev(init))).toBeNull();
    }
  });

  it("IME 조합 중에는 조합기 소유라 가로채지 않는다", () => {
    expect(altArrowSequence(ev({ key: "ArrowUp", altKey: true, isComposing: true }))).toBeNull();
  });
});

// 스크롤 위치 복원 (ADR-0019) — 좌표 판정과 settle 상태기계. 실제 xterm 적용·타이머
// 배선은 DOM 경로라 여기서 다루지 않는다 (WINDOWS-BUILD §10 v0.3.24).
describe("scrollOffsetToRemember", () => {
  it("일반 버퍼에서는 하단으로부터의 줄 수를 돌려준다", () => {
    expect(scrollOffsetToRemember(null, "normal", 1008, 993)).toBe(15);
    expect(scrollOffsetToRemember(null, "normal", 1008, 0)).toBe(1008);
  });

  it("맨 아래면 기억하지 않는다 — 복원할 것이 없다", () => {
    expect(scrollOffsetToRemember(null, "normal", 1008, 1008)).toBeNull();
    expect(scrollOffsetToRemember(null, "normal", 0, 0)).toBeNull();
  });

  it("대체 버퍼는 기억하지 않는다 — 그 스크롤은 앱 상태다", () => {
    expect(scrollOffsetToRemember(null, "alternate", 1008, 993)).toBeNull();
    expect(scrollOffsetToRemember(null, "alternate", 40, 0)).toBeNull();
  });

  it("복원이 진행 중이면 버퍼가 아니라 그 pending 값이 답이다", () => {
    // 돌아오자마자 다시 떠나는 경로: replay·재인쇄 전의 버퍼는 아직 사용자가
    // 보던 자리가 아니라, 그대로 읽으면 기억이 증발한다.
    expect(scrollOffsetToRemember(15, "normal", 0, 0)).toBe(15);
    expect(scrollOffsetToRemember(15, "normal", 1008, 1008)).toBe(15);
    expect(scrollOffsetToRemember(15, "alternate", 40, 40)).toBe(15);
  });
});

describe("restoreTargetLine", () => {
  it("하단 기준 오프셋을 지금 버퍼의 줄 번호로 되돌린다", () => {
    expect(restoreTargetLine(1008, 15)).toBe(993);
    expect(restoreTargetLine(972, 15)).toBe(957);
  });

  it("baseY 와 같은 오프셋은 유효한 0 이다 — 진짜 맨 위", () => {
    expect(restoreTargetLine(211, 211)).toBe(0);
    expect(restoreTargetLine(0, 0)).toBe(0);
  });

  it("스크롤백이 그때보다 짧으면 0 으로 접지 않고 거절한다", () => {
    // 0 으로 접으면 xterm 의 isUserScrolling 이 전사 맨 위에서 걸려 pane 이
    // 이후 출력을 영영 따라가지 않는다 (실측) — 호출자는 null 을 받으면
    // scrollToBottom 으로 래치를 푼다.
    expect(restoreTargetLine(10, 15)).toBeNull();
    expect(restoreTargetLine(0, 1)).toBeNull();
  });
});

describe("OutputSettle", () => {
  it("start 전에는 어떤 poll 도 복원하지 않는다", () => {
    const settle = new OutputSettle();
    expect(settle.poll(0)).toEqual({ kind: "abandon" });
  });

  it("nudge 뒤 chunk 가 하나도 없으면 상한에서 복원 없이 끝난다", () => {
    // 재인쇄가 없었다는 뜻이라 1차 복원의 결과가 그대로 남아 있다.
    const settle = new OutputSettle();
    settle.start(1000);
    expect(settle.poll(1000)).toEqual({ kind: "wait", nextCheckAt: 1000 + SETTLE_CAP_MS });
    expect(settle.poll(1000 + SETTLE_CAP_MS)).toEqual({ kind: "abandon" });
  });

  it("마지막 chunk 후 quiet 창이 지나면 복원한다", () => {
    const settle = new OutputSettle();
    settle.start(1000);
    settle.noteChunk(1100);
    expect(settle.poll(1100)).toEqual({
      kind: "wait",
      nextCheckAt: 1100 + SETTLE_QUIET_MS,
    });
    expect(settle.poll(1100 + SETTLE_QUIET_MS - 1)).toEqual({
      kind: "wait",
      nextCheckAt: 1100 + SETTLE_QUIET_MS,
    });
    expect(settle.poll(1100 + SETTLE_QUIET_MS)).toEqual({ kind: "restore" });
  });

  it("chunk 가 계속 오면 quiet 창이 그만큼 밀린다", () => {
    const settle = new OutputSettle();
    settle.start(0);
    settle.noteChunk(100);
    settle.noteChunk(300);
    expect(settle.poll(350)).toEqual({ kind: "wait", nextCheckAt: 300 + SETTLE_QUIET_MS });
    expect(settle.poll(300 + SETTLE_QUIET_MS)).toEqual({ kind: "restore" });
  });

  it("출력이 끊이지 않아도 상한에서 복원한다", () => {
    const settle = new OutputSettle();
    settle.start(0);
    settle.noteChunk(SETTLE_CAP_MS - 10);
    // quiet 창(=1990+250)이 아니라 상한이 이긴다.
    expect(settle.poll(SETTLE_CAP_MS - 10)).toEqual({
      kind: "wait",
      nextCheckAt: SETTLE_CAP_MS,
    });
    expect(settle.poll(SETTLE_CAP_MS)).toEqual({ kind: "restore" });
  });

  it("chunk 은 다음 확인 시각을 앞당긴다 — 드라이버가 타이머를 다시 잡아야 하는 이유", () => {
    // 처음 예약된 상한 시각만 기다리면 quiet 규칙이 영영 발화하지 않는다
    // (실제로 그랬다 — peer review 2026-09-12). 그래서 write 완료 콜백이
    // noteChunk 뒤에 타이머를 걷고 이 poll 의 답으로 다시 예약한다.
    const settle = new OutputSettle();
    settle.start(1000);
    const first = settle.poll(1000);
    expect(first).toEqual({ kind: "wait", nextCheckAt: 1000 + SETTLE_CAP_MS });
    settle.noteChunk(1100);
    const second = settle.poll(1100);
    expect(second).toEqual({ kind: "wait", nextCheckAt: 1100 + SETTLE_QUIET_MS });
    expect(second).not.toEqual(first);
  });

  it("취소 뒤에는 chunk 가 더 와도 복원하지 않는다", () => {
    const settle = new OutputSettle();
    settle.start(0);
    settle.noteChunk(100);
    settle.cancel();
    settle.noteChunk(200);
    expect(settle.poll(10_000)).toEqual({ kind: "abandon" });
  });

  it("판정이 끝나면 다시 복원하지 않는다 — 늦게 도는 타이머 1회성", () => {
    const settle = new OutputSettle();
    settle.start(0);
    settle.noteChunk(100);
    expect(settle.poll(400)).toEqual({ kind: "restore" });
    expect(settle.poll(500)).toEqual({ kind: "abandon" });
  });

  it("start 전 chunk 는 세지 않는다 — replay·dedup 구간은 재인쇄가 아니다", () => {
    const settle = new OutputSettle();
    settle.noteChunk(10);
    settle.start(1000);
    expect(settle.poll(1000 + SETTLE_CAP_MS)).toEqual({ kind: "abandon" });
  });
});

// ESC[3J 재인쇄 경로의 판정 (ADR-0019 amendment, v0.3.26) — 위로 올려 둔 pane 의
// 스크롤백이 지워질 때만 자리를 붙잡는다.
describe("scrollbackWipeRestoreOffset", () => {
  it("위로 올려 둔 일반 버퍼면 하단 기준 오프셋을 돌려준다", () => {
    expect(scrollbackWipeRestoreOffset(null, false, true, "normal", 1008, 993)).toBe(15);
    expect(scrollbackWipeRestoreOffset(null, false, true, "normal", 96, 0)).toBe(96);
  });

  it("복원이 이미 진행 중이면 무시한다 — 진행 중인 값이 사용자의 원래 자리다", () => {
    // 왕복 복원의 nudge 가 부르는 재인쇄, 그리고 한 재인쇄 안의 두 번째 ED 3.
    // 여기서 지금 화면을 새로 잡으면 복원 중간 상태(맨 아래)를 목표로 삼는다.
    expect(scrollbackWipeRestoreOffset(15, false, true, "normal", 1008, 900)).toBeNull();
    expect(scrollbackWipeRestoreOffset(15, false, true, "normal", 0, 0)).toBeNull();
  });

  it("미뤄 둔 래치 해제가 남아 있으면 무시한다 — line 0 의 뷰는 사용자 자리가 아니다", () => {
    expect(scrollbackWipeRestoreOffset(null, true, true, "normal", 1008, 0)).toBeNull();
  });

  it("replay 재생 중의 ED 3 은 무시한다 — 창에 보존된 과거의 재인쇄다", () => {
    expect(scrollbackWipeRestoreOffset(null, false, false, "normal", 1008, 993)).toBeNull();
  });

  it("대체 버퍼는 무시한다 — 그 스크롤은 앱 상태다", () => {
    expect(
      scrollbackWipeRestoreOffset(null, false, true, "alternate", 1008, 993),
    ).toBeNull();
  });

  it("맨 아래도 재인쇄 동안 하단을 유지하도록 0을 반환한다", () => {
    expect(scrollbackWipeRestoreOffset(null, false, true, "normal", 1008, 1008)).toBe(0);
    expect(scrollbackWipeRestoreOffset(null, false, true, "normal", 0, 0)).toBe(0);
  });
});

// **라이브러리 전제 잠금.** "커스텀 CSI 핸들러가 xterm 내장 ED 처리보다 먼저 돈다"
// 는 위 판정이 서 있는 바닥이다 — 순서가 뒤집히면 훅은 이미 지워진 버퍼(baseY 0)를
// 읽어 offset 0 → null 이 되고, 기능은 에러 없이 조용히 죽는다. 브라우저 빌드는
// vitest 에서 띄울 수 없어 같은 5.5.0 의 headless 로 본다 (파서·버퍼는 공유 코어다).
describe("ESC[3J 파서 훅", () => {
  it("훅이 읽는 baseY/viewportY 는 스크롤백이 지워지기 전 값이다", async () => {
    const term = new HeadlessTerminal({
      cols: 20,
      rows: 5,
      scrollback: 1000,
      // headless 5.5.0 은 buffer 를 이 옵션 뒤에 둔다 (v0.3.19 의 폰 검은 화면).
      allowProposedApi: true,
    });
    const write = async (data: string): Promise<void> =>
      new Promise<void>((resolve) => {
        term.write(data, resolve);
      });

    await write(Array.from({ length: 100 }, (_, i) => `line ${i}\r\n`).join(""));
    term.scrollLines(-20);

    let captured: { baseY: number; viewportY: number } | null = null;
    term.parser.registerCsiHandler({ final: "J" }, (params) => {
      if (params[0] === 3) {
        captured = {
          baseY: term.buffer.active.baseY,
          viewportY: term.buffer.active.viewportY,
        };
      }
      return false; // 내장 ED 처리로 넘긴다
    });

    const before = {
      baseY: term.buffer.active.baseY,
      viewportY: term.buffer.active.viewportY,
    };
    expect(before.baseY).toBeGreaterThan(0);
    expect(before.viewportY).toBeLessThan(before.baseY);

    await write("\x1b[3J");
    expect(captured).toEqual(before);
    // false 를 돌려줬으므로 내장 처리가 이어져 스크롤백이 실제로 지워진다.
    expect(term.buffer.active.baseY).toBe(0);
    term.dispose();
  });
});
