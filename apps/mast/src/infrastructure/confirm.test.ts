// @vitest-environment happy-dom
//
// 확인 대화상자의 플랫폼 경로 — macOS 는 WKWebView 의 window.confirm 이 대화상자 없이 false 라
// 네이티브 대화상자의 답을 쓰고, Windows 는 window.confirm 그대로다.

import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import { confirmAction } from "./confirm";

afterEach(() => {
  vi.unstubAllGlobals();
  h.invoke.mockReset();
});

describe("confirmAction", () => {
  it("on macOS answers with the native dialog's choice and never uses window.confirm", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    h.invoke.mockResolvedValueOnce(true);
    expect(await confirmAction("Discard?", true)).toBe(true);
    h.invoke.mockResolvedValueOnce(false);
    expect(await confirmAction("Discard?", true)).toBe(false);
    expect(h.invoke).toHaveBeenCalledWith("confirm_dialog", { message: "Discard?" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("on macOS a dialog that cannot be shown is an error, not a silent answer", async () => {
    h.invoke.mockRejectedValueOnce("cannot open the confirmation dialog");
    await expect(confirmAction("Discard?", true)).rejects.toBe("cannot open the confirmation dialog");
  });

  it("elsewhere keeps the WebView's window.confirm", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    expect(await confirmAction("Discard?", false)).toBe(true);
    expect(confirm).toHaveBeenCalledWith("Discard?");
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
