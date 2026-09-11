// @vitest-environment happy-dom
//
// 터미널 줌의 순수 판정 검증 — 글꼴 크기 클램프(백엔드 FONT_SIZE_RANGE 6..=72 와
// 같은 범위)만 대상이다. xterm 인스턴스 적용·refit·레지스트리 수명은 DOM/IPC 경로라
// 여기서 다루지 않는다 (Windows 수동 검증 WINDOWS-BUILD §10 v0.3.4).
//
// 판정 자체는 DOM 무의존인데도 happy-dom 환경인 이유: 이 모듈을 import 하면
// @xterm/addon-fit 의 UMD 래퍼가 로드 시점에 `self` 를 읽어 node 환경에서는
// import 가 곧바로 터진다 (pane-view.test.ts 와 같은 파일 전용 환경 지정).

import { describe, expect, it } from "vitest";

import { clampFontSize, shouldOpenLink } from "./terminal-view";

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
