import { describe, expect, it } from "vitest";

import type { WslStatus } from "../../infrastructure/backend";
import { WSL_INSTALL_URL, wslNotice } from "./notice";

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

describe("WSL notice model", () => {
  it("hides the banner when the diagnosis is ready and every workspace distro is installed", () => {
    expect(wslNotice(status({ state: "ready", distros: ["Ubuntu"] }))).toBeNull();
  });

  it("hides the banner on hosts without WSL (unix dev runs)", () => {
    expect(wslNotice(status({ state: "notApplicable" }))).toBeNull();
  });

  it("offers install guidance when WSL itself is missing", () => {
    const notice = wslNotice(
      status({ state: "notInstalled", code: 0x8007019e, detail: "not enabled" }),
    );
    expect(notice?.title).toBe("WSL is not installed");
    expect(notice?.installCommand).toBe("wsl --install");
    expect(notice?.actions).toEqual(["copy", "guide", "recheck", "settings"]);
  });

  it("distinguishes a missing distribution from a missing WSL", () => {
    const notice = wslNotice(status({ state: "noDistro", code: 0xffffffff }));
    expect(notice?.title).toBe("No WSL distribution is installed");
    expect(notice?.installCommand).toBe("wsl --install -d Ubuntu");
  });

  it("names the workspace distribution that is not installed", () => {
    const notice = wslNotice(
      status({
        state: "ready",
        distros: ["Ubuntu", "Debian"],
        missingDistros: ["Fedora"],
      }),
    );
    expect(notice?.title).toContain('"Fedora"');
    expect(notice?.body).toContain("Ubuntu, Debian");
    expect(notice?.installCommand).toBe("wsl --install -d 'Fedora'");
  });

  it("keeps the failure code out of the title but shows it to the user", () => {
    const notice = wslNotice(status({ state: "failed", code: 0x800701bc }));
    expect(notice?.title).toBe("WSL could not be queried");
    expect(notice?.body).toContain("0x800701BC");
    // 실패 상태에는 설치 명령을 지어내지 않는다.
    expect(notice?.installCommand).toBeNull();
    expect(notice?.actions).not.toContain("copy");
  });

  it("keeps the timeout distinct and offers only explicit retry", () => {
    const notice = wslNotice(status({ state: "timeout" }));
    expect(notice?.title).toBe("WSL did not respond");
    expect(notice?.installCommand).toBeNull();
    expect(notice?.actions).toEqual(["recheck", "settings"]);
  });

  it("shows only a recheck while the first diagnosis is still running", () => {
    const notice = wslNotice(status({ state: "probing" }));
    expect(notice?.title).toBe("Checking WSL…");
    expect(notice?.actions).toEqual(["recheck"]);
  });

  it("points the install guide at Microsoft's WSL page", () => {
    expect(WSL_INSTALL_URL).toBe("https://learn.microsoft.com/windows/wsl/install");
  });
});
