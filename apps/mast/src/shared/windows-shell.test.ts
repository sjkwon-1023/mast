import { afterEach, describe, expect, it } from "vitest";

import { applyWindowsShellSettings, isPowerShellMode } from "./windows-shell";

afterEach(() => applyWindowsShellSettings({ windowsShell: null }));

describe("windowsShell 설정", () => {
  it("키가 없거나 null 이면 WSL 모드다", () => {
    applyWindowsShellSettings({});
    expect(isPowerShellMode()).toBe(false);
    applyWindowsShellSettings({ windowsShell: null });
    expect(isPowerShellMode()).toBe(false);
  });

  it("정확히 \"powershell\" 일 때만 PowerShell 모드다", () => {
    applyWindowsShellSettings({ windowsShell: "powershell" });
    expect(isPowerShellMode()).toBe(true);
    applyWindowsShellSettings({ windowsShell: "wsl" });
    expect(isPowerShellMode()).toBe(false);
  });
});
