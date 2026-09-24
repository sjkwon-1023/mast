// @vitest-environment happy-dom
//
// 배너의 DOM 계약 — 상태별로 어떤 문구·버튼이 보이고, 복사·재검사 버튼이 핸들러를
// 어떻게 부르는지. 문구 자체의 판정은 notice.test.ts 가 잠그므로 여기서는
// "모델이 준 것을 그대로 그리는가"와 상호작용만 본다.

import { describe, expect, it, vi } from "vitest";

import type { WslStatus } from "../../infrastructure/backend";
import { WslBanner } from "./banner";
import type { WslBannerHandlers } from "./banner";

function status(
  partial: Partial<WslStatus> & { state: WslStatus["state"] },
): WslStatus {
  return {
    detail: null,
    code: null,
    distros: [],
    missingDistros: [],
    failures: [],
    ...partial,
  };
}

function makeBanner(overrides: Partial<WslBannerHandlers> = {}): {
  root: HTMLElement;
  banner: WslBanner;
  handlers: WslBannerHandlers;
} {
  const handlers: WslBannerHandlers = {
    copy: vi.fn(async () => true),
    guide: vi.fn(),
    recheck: vi.fn(async () => {}),
    settings: vi.fn(),
    notice: vi.fn(),
    ...overrides,
  };
  const root = document.createElement("div");
  root.hidden = true;
  document.body.append(root);
  return { root, banner: new WslBanner(root, handlers), handlers };
}

function button(root: HTMLElement, cls: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`.wsl-notice-${cls}`);
  if (found === null) throw new Error(`missing button ${cls}`);
  return found;
}

describe("WslBanner", () => {
  it("stays hidden when WSL is ready with no missing distribution", () => {
    const { root, banner } = makeBanner();
    banner.render(status({ state: "ready", distros: ["Ubuntu"] }));
    expect(root.hidden).toBe(true);
  });

  it("shows the install command and copies it on click", async () => {
    const { root, banner, handlers } = makeBanner();
    banner.render(status({ state: "notInstalled" }));
    expect(root.hidden).toBe(false);
    expect(root.querySelector(".wsl-notice-title")?.textContent).toBe(
      "WSL is not installed",
    );
    expect(root.querySelector(".wsl-notice-command")?.textContent).toBe("wsl --install");

    button(root, "copy").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(handlers.copy).toHaveBeenCalledWith("wsl --install");
    expect(handlers.notice).toHaveBeenCalledWith("Copied: wsl --install");
  });

  it("reports a failed copy instead of pretending it worked", async () => {
    const { root, banner, handlers } = makeBanner({ copy: vi.fn(async () => false) });
    banner.render(status({ state: "noDistro" }));
    button(root, "copy").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(handlers.notice).toHaveBeenCalledWith("Could not copy to the clipboard");
  });

  it("shows the raw detail from the diagnosis, whatever its language", () => {
    const { root, banner } = makeBanner();
    banner.render(
      status({ state: "failed", code: 0x800701bc, detail: "커널 파일을 찾을 수 없습니다" }),
    );
    const detail = root.querySelector<HTMLElement>(".wsl-notice-detail");
    expect(detail?.hidden).toBe(false);
    expect(detail?.textContent).toBe("커널 파일을 찾을 수 없습니다");
  });

  it("hides copy when no install command applies and keeps recheck available", () => {
    const { root, banner } = makeBanner();
    banner.render(status({ state: "timeout" }));
    expect(button(root, "copy").hidden).toBe(true);
    expect(button(root, "guide").hidden).toBe(true);
    expect(button(root, "recheck").hidden).toBe(false);
    expect(button(root, "settings").hidden).toBe(false);
  });

  it("runs a recheck once per click and re-enables the button", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { root, banner, handlers } = makeBanner({
      recheck: vi.fn(() => pending),
    });
    banner.render(status({ state: "noDistro" }));

    const recheck = button(root, "recheck");
    recheck.click();
    expect(recheck.disabled).toBe(true);
    expect(handlers.recheck).toHaveBeenCalledTimes(1);
    release();
    await pending;
    await Promise.resolve();
    expect(recheck.disabled).toBe(false);
  });

  it("opens the guide and the settings file through their handlers", () => {
    const { root, banner, handlers } = makeBanner();
    banner.render(status({ state: "notInstalled" }));
    button(root, "guide").click();
    button(root, "settings").click();
    expect(handlers.guide).toHaveBeenCalledTimes(1);
    expect(handlers.settings).toHaveBeenCalledTimes(1);
  });
});
