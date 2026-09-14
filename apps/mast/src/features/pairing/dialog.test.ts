import { describe, expect, it } from "vitest";

import type { AllowOutcome, FirewallStatus } from "../../infrastructure/backend";
import {
  allowOutcomeMessage,
  firewallActionable,
  firewallMessage,
  pairingMessage,
  REMOTE_OFF_MESSAGE,
} from "./dialog";

describe("pairingMessage", () => {
  it("shows the URL when the surface is on", () => {
    expect(pairingMessage({ state: "on", url: "http://192.168.0.5:7331/#t=abc" })).toBe(
      "http://192.168.0.5:7331/#t=abc",
    );
  });

  it("points at settings.json when the surface is off", () => {
    expect(pairingMessage({ state: "off" })).toBe(REMOTE_OFF_MESSAGE);
    expect(REMOTE_OFF_MESSAGE).toContain("settings.json");
  });

  it("carries the reason when the surface failed to start", () => {
    expect(pairingMessage({ state: "failed", reason: "bind 0.0.0.0:7331: in use" })).toBe(
      "bind 0.0.0.0:7331: in use",
    );
  });
});

function status(partial: Partial<FirewallStatus>): FirewallStatus {
  return {
    state: "allowed",
    detail: null,
    exe: "C:\\mast\\mast.exe",
    port: 7331,
    currentProfiles: ["Private"],
    ...partial,
  };
}

describe("firewallMessage", () => {
  it("allowed — names the port", () => {
    expect(firewallMessage(status({ state: "allowed", port: 7331 }))).toBe(
      "Windows Firewall allows this app on port 7331.",
    );
  });

  it("blocked — names the blocking rule and how to remove it", () => {
    expect(firewallMessage(status({ state: "blocked", detail: "mast test block" }))).toBe(
      'A Windows Firewall rule blocks this app: "mast test block". Adding an allow rule will not help — remove that rule (Windows Security › Firewall, or Remove-NetFirewallRule -DisplayName "mast test block").',
    );
  });

  it("stalePath — names the old exe path", () => {
    expect(firewallMessage(status({ state: "stalePath", detail: "C:\\old\\mast.exe" }))).toBe(
      'The "mast remote (LAN)" rule points at another copy of the app (C:\\old\\mast.exe), so the phone cannot connect.',
    );
  });

  it("profileMismatch — names the current profiles", () => {
    expect(
      firewallMessage(
        status({ state: "profileMismatch", detail: "Private", currentProfiles: ["Private"] }),
      ),
    ).toBe("An allow rule exists, but not for the current network profile (Private).");
  });

  it("missing — names the port", () => {
    expect(firewallMessage(status({ state: "missing", port: 9000 }))).toBe(
      "Windows Firewall has no rule allowing this app on port 9000, so the phone cannot connect.",
    );
  });

  it("firewallOff", () => {
    expect(firewallMessage(status({ state: "firewallOff" }))).toBe(
      "Windows Firewall is off for the current network — no rule is needed.",
    );
  });

  it("unknown — carries the error detail", () => {
    expect(firewallMessage(status({ state: "unknown", detail: "COM error 0x80070005" }))).toBe(
      "Could not check Windows Firewall: COM error 0x80070005",
    );
  });

  it("overrides with a no-profile message when currentProfiles is empty", () => {
    expect(firewallMessage(status({ state: "missing", currentProfiles: [] }))).toBe(
      "No active network profile — connect to a network first.",
    );
  });

  it("overrides with a public-network message when only Public is active", () => {
    expect(firewallMessage(status({ state: "stalePath", currentProfiles: ["Public"] }))).toBe(
      "This network is set to Public. Mark it Private in Windows settings; mast never opens a port on public networks.",
    );
  });

  it("keeps the blocking rule's name even on a public-only network", () => {
    expect(
      firewallMessage(status({ state: "blocked", detail: "vendor block", currentProfiles: ["Public"] })),
    ).toContain('"vendor block"');
  });

  it("never overrides allowed or firewallOff, even with no active profile", () => {
    expect(firewallMessage(status({ state: "allowed", currentProfiles: [] }))).toBe(
      "Windows Firewall allows this app on port 7331.",
    );
    expect(firewallMessage(status({ state: "firewallOff", currentProfiles: [] }))).toBe(
      "Windows Firewall is off for the current network — no rule is needed.",
    );
  });
});

describe("firewallActionable", () => {
  it("unknown is always actionable, even with no active profile", () => {
    expect(firewallActionable(status({ state: "unknown", currentProfiles: [] }))).toBe(true);
  });

  it("allowed/blocked/firewallOff never show the button", () => {
    expect(firewallActionable(status({ state: "allowed" }))).toBe(false);
    expect(firewallActionable(status({ state: "blocked" }))).toBe(false);
    expect(firewallActionable(status({ state: "firewallOff" }))).toBe(false);
  });

  it("missing/stalePath/profileMismatch need Domain or Private active", () => {
    expect(firewallActionable(status({ state: "missing", currentProfiles: ["Private"] }))).toBe(
      true,
    );
    expect(firewallActionable(status({ state: "stalePath", currentProfiles: ["Domain"] }))).toBe(
      true,
    );
    expect(
      firewallActionable(status({ state: "profileMismatch", currentProfiles: ["Public"] })),
    ).toBe(false);
  });

  it("is false when no profile is active", () => {
    expect(firewallActionable(status({ state: "missing", currentProfiles: [] }))).toBe(false);
  });

  it("is true when Private is active alongside Public", () => {
    expect(
      firewallActionable(status({ state: "missing", currentProfiles: ["Public", "Private"] })),
    ).toBe(true);
  });
});

function outcome(partial: Partial<AllowOutcome>): AllowOutcome {
  return {
    outcome: "applied",
    detail: null,
    status: status({ state: "allowed" }),
    ...partial,
  };
}

describe("allowOutcomeMessage", () => {
  it("declined", () => {
    expect(allowOutcomeMessage(outcome({ outcome: "declined" }))).toBe(
      "Not applied — the permission prompt was declined.",
    );
  });

  it("failed — carries the reason", () => {
    expect(
      allowOutcomeMessage(
        outcome({ outcome: "failed", detail: "ShellExecuteEx: elevation required" }),
      ),
    ).toBe("Could not apply: ShellExecuteEx: elevation required");
  });

  it("applied and re-detected as allowed — shows the plain allowed message", () => {
    expect(
      allowOutcomeMessage(
        outcome({ outcome: "applied", status: status({ state: "allowed", port: 7331 }) }),
      ),
    ).toBe("Windows Firewall allows this app on port 7331.");
  });

  it("applied but not yet visible — points at mast.log", () => {
    expect(
      allowOutcomeMessage(
        outcome({ outcome: "applied", status: status({ state: "missing", port: 7331 }) }),
      ),
    ).toBe(
      "Windows ran the command, but the rule is not visible yet: Windows Firewall has no rule allowing this app on port 7331, so the phone cannot connect. (see mast.log for the netsh exit code).",
    );
  });
});
