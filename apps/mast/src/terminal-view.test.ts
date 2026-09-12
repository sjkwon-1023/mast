// @vitest-environment happy-dom
//
// 터미널 줌의 순수 판정 검증 — 글꼴 크기 클램프(백엔드 FONT_SIZE_RANGE 6..=72 와
// 같은 범위)와 스크롤 위치 복원의 판정(ADR-0019)만 대상이다. xterm 인스턴스 적용·
// refit·레지스트리 수명은 DOM/IPC 경로라 여기서 다루지 않는다 (Windows 수동 검증
// WINDOWS-BUILD §10 v0.3.4·v0.3.24).
//
// 판정 자체는 DOM 무의존인데도 happy-dom 환경인 이유: 이 모듈을 import 하면
// @xterm/addon-fit 의 UMD 래퍼가 로드 시점에 `self` 를 읽어 node 환경에서는
// import 가 곧바로 터진다 (pane-view.test.ts 와 같은 파일 전용 환경 지정).

import { describe, expect, it } from "vitest";

import {
  OutputSettle,
  SETTLE_CAP_MS,
  SETTLE_QUIET_MS,
  clampFontSize,
  restoreTargetLine,
  scrollOffsetToRemember,
  shouldOpenLink,
} from "./terminal-view";

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

// 스크롤 위치 복원 (ADR-0019) — 좌표 판정과 settle 상태기계. 실제 xterm 적용·타이머
// 배선은 DOM 경로라 여기서 다루지 않는다 (WINDOWS-BUILD §10 v0.3.24).
describe("scrollOffsetToRemember", () => {
  it("일반 버퍼에서는 하단으로부터의 줄 수를 돌려준다", () => {
    expect(scrollOffsetToRemember("normal", 1008, 993)).toBe(15);
    expect(scrollOffsetToRemember("normal", 1008, 0)).toBe(1008);
  });

  it("맨 아래면 기억하지 않는다 — 복원할 것이 없다", () => {
    expect(scrollOffsetToRemember("normal", 1008, 1008)).toBeNull();
    expect(scrollOffsetToRemember("normal", 0, 0)).toBeNull();
  });

  it("대체 버퍼는 기억하지 않는다 — 그 스크롤은 앱 상태다", () => {
    expect(scrollOffsetToRemember("alternate", 1008, 993)).toBeNull();
    expect(scrollOffsetToRemember("alternate", 40, 0)).toBeNull();
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
    expect(settle.poll(1100)).toEqual({ kind: "wait", nextCheckAt: 1100 + SETTLE_QUIET_MS });
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
    expect(settle.poll(SETTLE_CAP_MS - 10)).toEqual({ kind: "wait", nextCheckAt: SETTLE_CAP_MS });
    expect(settle.poll(SETTLE_CAP_MS)).toEqual({ kind: "restore" });
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
