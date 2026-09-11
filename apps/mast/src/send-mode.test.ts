// SendMode 상태 머신의 계약 테스트 (17단계 D4) — arm/resolve/cancel 전이와
// 프롬프트 문자열. DOM 무의존 (배선·전달 실행은 workspace-view 통합 코드 소관).

import { describe, expect, it } from "vitest";

import { SendMode, sendModePrompt } from "./send-mode";

describe("SendMode", () => {
  it("arm → 다른 pane resolve: 캡처된 텍스트·submit 으로 전달하고 idle 로 돌아간다", () => {
    const mode = new SendMode();
    expect(mode.active).toBe(false);
    mode.arm(1, "ls -la", false, 10);
    expect(mode.active).toBe(true);
    expect(mode.resolve(2)).toEqual({ deliver: true, text: "ls -la", submit: false });
    expect(mode.active).toBe(false);
    expect(mode.state).toEqual({ type: "idle" });
  });

  it("submit=true 로 arm 하면 resolve 결과에도 submit 이 실린다", () => {
    const mode = new SendMode();
    mode.arm(1, "npm test", true, 10);
    expect(mode.resolve(3)).toEqual({ deliver: true, text: "npm test", submit: true });
  });

  it("armed 상태는 소스 pane 과 arm 시점 워크스페이스를 보존한다 — 수명 가드 판정 재료", () => {
    const mode = new SendMode();
    mode.arm(4, "pwd", false, 12);
    expect(mode.state).toEqual({
      type: "armed",
      text: "pwd",
      submit: false,
      source: 4,
      workspace: 12,
    });
  });

  it("cancel 은 idle 로 되돌리고, 이후 resolve 는 전달하지 않는다", () => {
    const mode = new SendMode();
    mode.arm(1, "echo hi", false, 10);
    mode.cancel();
    expect(mode.active).toBe(false);
    expect(mode.resolve(2)).toEqual({ deliver: false, text: "", submit: false });
  });

  it("자기 자신(target === source) resolve 는 취소와 동일하다 — 전달 없음 + idle", () => {
    const mode = new SendMode();
    mode.arm(5, "secret", true, 10);
    expect(mode.resolve(5)).toEqual({ deliver: false, text: "", submit: false });
    expect(mode.active).toBe(false);
  });

  it("armed 중 재-arm 은 덮어쓴다 — 마지막 캡처만 남는다 (API 계약 — UI 에선 도달 불가)", () => {
    const mode = new SendMode();
    mode.arm(1, "first", false, 10);
    mode.arm(2, "second", true, 11);
    // 소스도 갱신됐다 — 이전 소스(1)는 이제 유효한 대상이다.
    expect(mode.resolve(1)).toEqual({ deliver: true, text: "second", submit: true });
  });

  it("resolve 는 1회성이다 — 같은 arm 으로 두 번 전달되지 않는다", () => {
    const mode = new SendMode();
    mode.arm(1, "once", false, 10);
    expect(mode.resolve(2).deliver).toBe(true);
    expect(mode.resolve(2)).toEqual({ deliver: false, text: "", submit: false });
  });

  it("idle 에서의 resolve 는 no-op 취소다", () => {
    const mode = new SendMode();
    expect(mode.resolve(1)).toEqual({ deliver: false, text: "", submit: false });
  });

  it("프롬프트: idle 은 null, armed 는 send/send & run 을 구분한 지속 문구다", () => {
    const mode = new SendMode();
    expect(sendModePrompt(mode.state)).toBeNull();
    mode.arm(1, "x", false, null);
    expect(sendModePrompt(mode.state)).toBe("send: click a pane to send to (Esc cancels)");
    mode.arm(1, "x", true, null);
    expect(sendModePrompt(mode.state)).toBe(
      "send & run: click a pane to send to (Esc cancels)",
    );
  });
});
