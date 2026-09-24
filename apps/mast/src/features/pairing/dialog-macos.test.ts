// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/platform")>()),
  IS_MAC: true,
}));

import type {
  AllowOutcome,
  FirewallStatus,
  Pairing,
  SecureRemoteStart,
  SecureRemoteStatus,
} from "../../infrastructure/backend";
import {
  allowOutcomeMessage,
  firewallActionable,
  firewallMessage,
  openPairingDialog,
} from "./dialog";
import type { PairingBackend } from "./dialog";

const PAIRING_ID = "pairing-macos-test";
const LOCAL_URL = "http://192.168.0.5:7331/#t=local-token";
const BLOCK_ALL_DETAIL = "Block all incoming connections";

function status(partial: Partial<FirewallStatus>): FirewallStatus {
  return {
    state: "allowed",
    detail: null,
    exe: "/Applications/Mast.app/Contents/MacOS/mast",
    port: 7331,
    currentProfiles: [],
    ...partial,
  };
}

function outcome(partial: Partial<AllowOutcome>): AllowOutcome {
  return {
    outcome: "applied",
    detail: null,
    status: status({ state: "allowed" }),
    ...partial,
  };
}

function idleStatus(): SecureRemoteStatus {
  return { state: "idle", pairingId: null, reason: null };
}

function fakeBackend(overrides: Partial<PairingBackend> = {}): PairingBackend {
  return {
    remotePairing: async (): Promise<Pairing | null> => ({ url: LOCAL_URL }),
    remoteFirewallStatus: async () => status({ state: "allowed" }),
    remoteFirewallAllow: async () => outcome({}),
    secureRemoteStatus: async () => idleStatus(),
    secureRemoteStart: async (pairingId: string): Promise<SecureRemoteStart> => ({
      state: "waiting",
      pairingId,
      url: "https://example.test/#pairing",
    }),
    secureRemoteCancel: async () => idleStatus(),
    secureRemoteFirewallStatus: async () => status({ state: "allowed" }),
    secureRemoteFirewallAllow: async () => outcome({}),
    ...overrides,
  };
}

function open(backend: PairingBackend): HTMLDialogElement {
  const dialog = openPairingDialog({ backend, randomUUID: () => PAIRING_ID });
  if (dialog === null) throw new Error("dialog did not open");
  return dialog;
}

function required<T extends Element>(dialog: HTMLDialogElement, selector: string): T {
  const element = dialog.querySelector<T>(selector);
  if (element === null) throw new Error(`missing ${selector}`);
  return element;
}

function modeButton(dialog: HTMLDialogElement, mode: "local" | "secure"): HTMLButtonElement {
  return required(dialog, `.pairing-mode[data-mode="${mode}"]`);
}

function backButton(dialog: HTMLDialogElement): HTMLButtonElement {
  return required(dialog, ".pairing-back");
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const dialog of Array.from(document.querySelectorAll("dialog"))) {
    if (dialog.open) dialog.close();
    else dialog.remove();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("macOS Firewall guidance", () => {
  it("uses app-wide guidance without Windows profile language", () => {
    const appBlocked = firewallMessage(
      status({ state: "blocked", detail: "This app is blocked by macOS Firewall" }),
    );
    expect(appBlocked).toContain("macOS Firewall blocks this app");
    expect(appBlocked).not.toMatch(/Windows|Private|Public|UAC|netsh/i);

    const missing = firewallMessage(status({ state: "missing" }));
    expect(missing).toContain("explicit entry for this app");
    expect(missing).not.toContain("port 7331");

    const blockAll = firewallMessage(status({ state: "blocked", detail: BLOCK_ALL_DETAIL }));
    expect(blockAll).toContain("System Settings");
    expect(blockAll).toContain("cannot override it");
    expect(firewallActionable(status({ state: "blocked", detail: BLOCK_ALL_DETAIL }))).toBe(false);
    expect(firewallActionable(status({ state: "blocked", detail: "app blocked" }))).toBe(true);
    expect(firewallActionable(status({ state: "missing" }))).toBe(true);
    expect(firewallActionable(status({ state: "unknown" }))).toBe(true);
    expect(firewallActionable(status({ state: "allowed" }))).toBe(false);
    expect(firewallActionable(status({ state: "firewallOff" }))).toBe(false);

    const unexpected = firewallMessage(status({ state: "profileMismatch", detail: "Public" }));
    expect(unexpected).toContain("Could not determine macOS Firewall status");
    expect(unexpected).not.toContain("Public");
    expect(firewallActionable(status({ state: "profileMismatch" }))).toBe(true);
  });

  it("shows the re-detected state instead of claiming an unconfirmed allow succeeded", () => {
    const message = allowOutcomeMessage(
      outcome({
        outcome: "applied",
        status: status({ state: "blocked", detail: "This app is blocked by macOS Firewall" }),
      }),
    );
    expect(message).toContain("did not confirm the app is allowed");
    expect(message).toContain("macOS Firewall blocks this app");
    expect(message).not.toContain("macOS Firewall allows");
    expect(message).not.toMatch(/Windows|UAC|netsh/i);
  });
});

describe("macOS pairing Firewall sections", () => {
  it.each(["local", "secure"] as const)(
    "%s only checks at screen open and calls allow after the button click",
    async (mode) => {
      const localStatus = vi.fn(async () => status({ state: "missing" }));
      const localAllow = vi.fn(async () =>
        outcome({
          status: status({
            state: "blocked",
            detail: "This app is blocked by macOS Firewall",
          }),
        }),
      );
      const secureStatus = vi.fn(async () => status({ state: "missing" }));
      const secureAllow = vi.fn(async () =>
        outcome({
          status: status({
            state: "blocked",
            detail: "This app is blocked by macOS Firewall",
          }),
        }),
      );
      const dialog = open(
        fakeBackend({
          remoteFirewallStatus: localStatus,
          remoteFirewallAllow: localAllow,
          secureRemoteFirewallStatus: secureStatus,
          secureRemoteFirewallAllow: secureAllow,
        }),
      );

      modeButton(dialog, mode).click();
      await flush();

      const check = mode === "local" ? localStatus : secureStatus;
      const allow = mode === "local" ? localAllow : secureAllow;
      const otherCheck = mode === "local" ? secureStatus : localStatus;
      const otherAllow = mode === "local" ? secureAllow : localAllow;
      expect(check).toHaveBeenCalledTimes(1);
      expect(otherCheck).not.toHaveBeenCalled();
      expect(allow).not.toHaveBeenCalled();
      expect(otherAllow).not.toHaveBeenCalled();

      const line = required<HTMLElement>(dialog, ".pairing-firewall");
      expect(line.textContent).toContain("macOS Firewall has no explicit entry");
      expect(required<HTMLButtonElement>(dialog, ".pairing-allow").textContent).toBe(
        "Allow in macOS Firewall",
      );
      expect(required<HTMLElement>(dialog, ".pairing-firewall-note").textContent).toContain(
        "Local HTTP (TCP) and Secure Remote (UDP)",
      );
      expect(required<HTMLElement>(dialog, ".pairing-firewall-note").textContent).toContain(
        "networks you trust",
      );

      required<HTMLButtonElement>(dialog, ".pairing-allow").click();
      await flush();
      expect(allow).toHaveBeenCalledTimes(1);
      expect(otherAllow).not.toHaveBeenCalled();
      expect(line.textContent).toContain("did not confirm the app is allowed");
      expect(line.textContent).toContain("macOS Firewall blocks this app");
    },
  );

  it("shows macOS checking and administrator approval states", async () => {
    const firewallStatus = deferred<FirewallStatus>();
    const firewallAllow = deferred<AllowOutcome>();
    const remoteFirewallStatus = vi.fn(() => firewallStatus.promise);
    const remoteFirewallAllow = vi.fn(() => firewallAllow.promise);
    const dialog = open(
      fakeBackend({ remoteFirewallStatus, remoteFirewallAllow }),
    );
    modeButton(dialog, "local").click();
    await flush();

    const line = required<HTMLElement>(dialog, ".pairing-firewall");
    expect(line.textContent).toBe("Checking macOS Firewall…");
    const allow = required<HTMLButtonElement>(dialog, ".pairing-allow");
    expect(allow.textContent).toBe("Allow in macOS Firewall");
    expect(allow.disabled).toBe(false);

    firewallStatus.resolve(status({ state: "missing" }));
    await flush();
    expect(allow.hidden).toBe(false);
    allow.click();
    expect(remoteFirewallAllow).toHaveBeenCalledTimes(1);
    expect(line.textContent).toBe("Waiting for administrator approval…");
    expect(allow.disabled).toBe(true);

    firewallAllow.resolve(
      outcome({
        status: status({ state: "blocked", detail: "This app is blocked by macOS Firewall" }),
      }),
    );
    await flush();
    expect(line.textContent).toContain("macOS Firewall did not confirm the app is allowed");
    expect(allow.disabled).toBe(false);
  });

  it("ignores a delayed allow result after the screen is replaced", async () => {
    const delayedAllow = deferred<AllowOutcome>();
    const localAllow = vi.fn(() => delayedAllow.promise);
    const dialog = open(
      fakeBackend({
        remoteFirewallStatus: async () => status({ state: "missing" }),
        remoteFirewallAllow: localAllow,
        secureRemoteFirewallStatus: async () => status({ state: "allowed" }),
      }),
    );

    modeButton(dialog, "local").click();
    await flush();
    const oldLine = required<HTMLElement>(dialog, ".pairing-firewall");
    const allowButton = required<HTMLButtonElement>(dialog, ".pairing-allow");
    allowButton.click();
    allowButton.click();
    expect(localAllow).toHaveBeenCalledTimes(1);
    expect(oldLine.textContent).toBe("Waiting for administrator approval…");
    expect(allowButton.disabled).toBe(true);

    backButton(dialog).click();
    modeButton(dialog, "secure").click();
    await flush();
    delayedAllow.resolve(
      outcome({
        status: status({ state: "blocked", detail: "This app is blocked by macOS Firewall" }),
      }),
    );
    await flush();

    expect(oldLine.textContent).toBe("Waiting for administrator approval…");
    expect(required<HTMLElement>(dialog, ".pairing-firewall").textContent).toContain(
      "macOS Firewall allows incoming connections",
    );
  });

  it("drops a delayed allow result after the dialog closes", async () => {
    const delayedAllow = deferred<AllowOutcome>();
    const dialog = open(
      fakeBackend({
        remoteFirewallStatus: async () => status({ state: "missing" }),
        remoteFirewallAllow: () => delayedAllow.promise,
      }),
    );
    modeButton(dialog, "local").click();
    await flush();
    const line = required<HTMLElement>(dialog, ".pairing-firewall");
    required<HTMLButtonElement>(dialog, ".pairing-allow").click();
    dialog.close();

    delayedAllow.resolve(outcome({ status: status({ state: "allowed" }) }));
    await flush();
    expect(line.textContent).toBe("Waiting for administrator approval…");
  });
});
