// @vitest-environment happy-dom
//
// 페어링 다이얼로그의 순수 메시지 매핑과 DOM 흐름을 함께 검증한다. DOM 쪽의
// 핵심은 **늦은 응답이 현재 화면을 덮지 않는가**다 — start/cancel/방화벽 조회와
// 사용자가 답할 때까지 열려 있는 UAC 결과가 닫힘·모드 전환 뒤 도착하는 경우를
// 실제 엘리먼트로 단언한다. 백엔드는 이음매(`PairingBackend`)로 주입한다.

import { afterEach, describe, expect, it, vi } from "vitest";

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
  pairingMessage,
  REMOTE_OFF_MESSAGE,
  SECURE_CONNECTED_NOTICE,
  SECURE_PAIRING_ENDED_TEXT,
  SECURE_REMOTE_NOTE,
  SECURE_REMOTE_RULE_NAME,
  SECURE_STATUS_POLL_MS,
  SECURE_STOPPING_TEXT,
  SECURE_WAITING_TEXT,
  secureRemoteErrorText,
} from "./dialog";
import type { PairingBackend } from "./dialog";

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

  it("stalePath — names the old exe path and the Local HTTP rule by default", () => {
    expect(firewallMessage(status({ state: "stalePath", detail: "C:\\old\\mast.exe" }))).toBe(
      'The "mast remote (LAN)" rule points at another copy of the app (C:\\old\\mast.exe), so the phone cannot connect.',
    );
  });

  it("stalePath — names the rule the caller passes (UDP rule differs from TCP)", () => {
    expect(
      firewallMessage(status({ state: "stalePath", detail: "C:\\old\\mast.exe" }), "mast secure remote (LAN)"),
    ).toBe(
      'The "mast secure remote (LAN)" rule points at another copy of the app (C:\\old\\mast.exe), so the phone cannot connect.',
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

  it("names the UDP rule when the caller passes it (Secure Remote allow)", () => {
    expect(
      allowOutcomeMessage(
        outcome({
          outcome: "applied",
          status: status({ state: "stalePath", detail: "C:\\old\\mast.exe" }),
        }),
        SECURE_REMOTE_RULE_NAME,
      ),
    ).toBe(
      'Windows ran the command, but the rule is not visible yet: The "mast secure remote (LAN)" rule points at another copy of the app (C:\\old\\mast.exe), so the phone cannot connect. (see mast.log for the netsh exit code).',
    );
  });

  it("keeps the Local HTTP rule name as the default", () => {
    expect(
      allowOutcomeMessage(
        outcome({
          outcome: "applied",
          status: status({ state: "stalePath", detail: "C:\\old\\mast.exe" }),
        }),
      ),
    ).toContain('"mast remote (LAN)"');
  });
});

describe("secureRemoteErrorText", () => {
  it("maps every reject code to a user-readable sentence", () => {
    expect(secureRemoteErrorText({ code: "busy", message: "" })).toContain("already in progress");
    expect(secureRemoteErrorText({ code: "connected", message: "" })).toContain(
      "already remembers",
    );
    expect(secureRemoteErrorText({ code: "stopping", message: "" })).toContain(
      "still shutting down",
    );
    expect(secureRemoteErrorText({ code: "cancelled", message: "" })).toContain("cancelled");
    expect(secureRemoteErrorText({ code: "failed", message: "udp 7331 bind failed" })).toBe(
      "udp 7331 bind failed",
    );
  });

  it("busy does not tell the user to close a dialog that may no longer exist", () => {
    // WebView 리로드로 다이얼로그가 사라져도 서버 페어링은 만료까지 남는다 — 그때
    // "닫아라"만 말하면 닫을 대상이 없다. 만료 대기라는 실제 선택지를 함께 준다.
    const text = secureRemoteErrorText({ code: "busy", message: "" });
    expect(text).toContain("already in progress");
    expect(text).toContain("if it is still open");
    expect(text).toContain("two minutes");
  });

  it("never swallows values outside the contract", () => {
    expect(secureRemoteErrorText("ipc gone")).toContain("ipc gone");
    expect(secureRemoteErrorText(undefined)).toContain("Command failed");
  });
});

// --- DOM 흐름 ------------------------------------------------------------------

const SECURE_ID = "pairing-uuid-1";
const LOCAL_URL = "http://192.168.0.5:7331/#t=local-token";

function secureUrl(pairingId: string): string {
  return `https://sjkwon-1023.github.io/mast/#v=1&host=192.168.0.5&port=7331&cert=CERT&token=${pairingId}`;
}

function idleStatus(): SecureRemoteStatus {
  return { state: "idle", pairingId: null, reason: null };
}

function waitingStatus(pairingId: string): SecureRemoteStatus {
  return { state: "waiting", pairingId, reason: null };
}

function fakeBackend(overrides: Partial<PairingBackend> = {}): PairingBackend {
  return {
    remotePairing: async () => null,
    remoteFirewallStatus: async () => status({ state: "allowed" }),
    remoteFirewallAllow: async () => outcome({}),
    secureRemoteStatus: async () => idleStatus(),
    secureRemoteStart: async (pairingId: string) => ({
      state: "waiting",
      pairingId,
      url: secureUrl(pairingId),
    }),
    secureRemoteCancel: async () => idleStatus(),
    secureRemoteFirewallStatus: async () => status({ state: "allowed" }),
    secureRemoteFirewallAllow: async () => outcome({}),
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 타이머 0 + 마이크로태스크를 전부 비운다 — 이벤트 루프 한 바퀴. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function open(backend: PairingBackend, randomUUID: () => string = () => SECURE_ID): HTMLDialogElement {
  const dialog = openPairingDialog({ backend, randomUUID });
  if (dialog === null) throw new Error("dialog did not open");
  return dialog;
}

function modeButton(dialog: HTMLDialogElement, mode: string): HTMLButtonElement {
  const button = dialog.querySelector<HTMLButtonElement>(`.pairing-mode[data-mode="${mode}"]`);
  if (button === null) throw new Error(`missing .pairing-mode[data-mode="${mode}"]`);
  return button;
}

function backButton(dialog: HTMLDialogElement): HTMLButtonElement {
  const button = dialog.querySelector<HTMLButtonElement>(".pairing-back");
  if (button === null) throw new Error("missing .pairing-back");
  return button;
}

function required<T extends Element>(dialog: HTMLDialogElement, selector: string): T {
  const el = dialog.querySelector<T>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dialog of Array.from(document.querySelectorAll("dialog"))) {
    if (dialog.open) dialog.close();
    else dialog.remove();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("pairing dialog — mode choice", () => {
  it("shows Local HTTP, Secure Remote and a disabled Tailscale marked Coming later", () => {
    const dialog = open(fakeBackend());

    const modes = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".pairing-mode"));
    expect(modes.map((button) => button.dataset.mode)).toEqual(["local", "secure", "tailscale"]);
    expect(modes[0].disabled).toBe(false);
    expect(modes[1].disabled).toBe(false);
    expect(modes[2].disabled).toBe(true);
    expect(modes[2].textContent).toContain("Coming later");
    expect(modes[2].textContent).toContain("Tailscale");
  });

  it("describes Local HTTP as accepting phone input, not read-only", () => {
    const dialog = open(fakeBackend());

    // 폰 페이지는 remote/api.ts::postInput 으로 입력을 보낸다 — read-only 가 아니다.
    const local = modeButton(dialog, "local").textContent ?? "";
    expect(local).toContain("input");
    expect(local.toLowerCase()).not.toContain("read-only");
  });

  it("describes Secure Remote by its LAN address, not as an absolute internet boundary", () => {
    const dialog = open(fakeBackend());

    const secure = modeButton(dialog, "secure").textContent ?? "";
    expect(secure).toContain("LAN address");
    expect(secure).not.toContain("internet");
    // "이 네트워크에서만"류의 절대 표현은 쓰지 않는다 — 외부 도달은 별도 경로가 정한다.
    expect(secure).not.toContain("only");
  });

  it("opens only one dialog at a time", () => {
    const first = open(fakeBackend());
    expect(openPairingDialog({ backend: fakeBackend() })).toBeNull();

    first.close();
    expect(openPairingDialog({ backend: fakeBackend() })).not.toBeNull();
  });

  it("shows the Secure Remote connection notice when a phone is already connected", async () => {
    const dialog = open(
      fakeBackend({
        secureRemoteStatus: async () => ({
          state: "connected",
          pairingId: SECURE_ID,
          reason: null,
        }),
      }),
    );
    await flush();

    const notice = required<HTMLElement>(dialog, ".pairing-notice");
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe(SECURE_CONNECTED_NOTICE);
  });
});

describe("pairing dialog — modal focus", () => {
  it("focuses the first mode button on the choice screen", () => {
    const dialog = open(fakeBackend());

    // 화면 교체 뒤 포커스가 body 로 떨어지면 키보드 사용자가 모달 안에서 길을 잃는다.
    expect(document.activeElement).toBe(modeButton(dialog, "local"));
  });

  it("moves focus into Local and returns it to the choice on Back", async () => {
    const dialog = open(fakeBackend({ remotePairing: async () => ({ url: LOCAL_URL }) }));

    modeButton(dialog, "local").click();
    await flush();
    expect(document.activeElement).toBe(backButton(dialog));

    backButton(dialog).click();
    await flush();
    expect(document.activeElement).toBe(modeButton(dialog, "local"));
  });

  it("moves focus into Secure and returns it to the choice on Back", async () => {
    const dialog = open(fakeBackend());

    modeButton(dialog, "secure").click();
    await flush();
    expect(document.activeElement).toBe(backButton(dialog));

    backButton(dialog).click();
    await flush();
    expect(document.activeElement).toBe(modeButton(dialog, "local"));
  });
});

describe("pairing dialog — Local HTTP", () => {
  it("off — points at settings.json and does not touch the firewall", async () => {
    const remoteFirewallStatus = vi.fn(async () => status({ state: "allowed" }));
    const dialog = open(fakeBackend({ remotePairing: async () => null, remoteFirewallStatus }));

    modeButton(dialog, "local").click();
    await flush();

    expect(required<HTMLElement>(dialog, ".pairing-url").textContent).toBe(REMOTE_OFF_MESSAGE);
    expect(remoteFirewallStatus).not.toHaveBeenCalled();
    expect(dialog.querySelector(".pairing-allow")).toBeNull();
  });

  it("failed — shows the backend reason", async () => {
    const dialog = open(
      fakeBackend({
        remotePairing: async () => {
          throw "cannot bind 127.0.0.1:7331";
        },
      }),
    );

    modeButton(dialog, "local").click();
    await flush();

    expect(required<HTMLElement>(dialog, ".pairing-url").textContent).toBe(
      "cannot bind 127.0.0.1:7331",
    );
  });

  it("on — shows the pairing URL and the TCP firewall section", async () => {
    const remoteFirewallStatus = vi.fn(async () => status({ state: "missing" }));
    const dialog = open(
      fakeBackend({
        remotePairing: async () => ({ url: LOCAL_URL }),
        remoteFirewallStatus,
      }),
    );

    modeButton(dialog, "local").click();
    await flush();

    expect(required<HTMLElement>(dialog, ".pairing-url").textContent).toBe(LOCAL_URL);
    // 기존 흐름 그대로 TCP 커맨드를 쓴다 (UDP 커맨드가 아니다).
    expect(remoteFirewallStatus).toHaveBeenCalledTimes(1);
    expect(required<HTMLElement>(dialog, ".pairing-firewall").textContent).toContain(
      "no rule allowing",
    );
    expect(required<HTMLButtonElement>(dialog, ".pairing-allow").hidden).toBe(false);
  });

  it("drops a late pairing result after the dialog closed", async () => {
    const pairing = deferred<Pairing | null>();
    const dialog = open(fakeBackend({ remotePairing: () => pairing.promise }));

    modeButton(dialog, "local").click();
    await flush();
    dialog.close();

    pairing.resolve({ url: LOCAL_URL });
    await flush();

    expect(dialog.isConnected).toBe(false);
    // 닫힌 화면의 노드는 남아 있지만 늦은 응답은 버려졌다 — 초기 문구 그대로다.
    expect(required<HTMLElement>(dialog, ".pairing-url").textContent).toBe("Checking…");
  });

  it("drops late firewall results after switching back to the choice screen", async () => {
    const firewall = deferred<FirewallStatus>();
    const dialog = open(
      fakeBackend({
        remotePairing: async () => ({ url: LOCAL_URL }),
        remoteFirewallStatus: () => firewall.promise,
      }),
    );

    modeButton(dialog, "local").click();
    await flush();

    // 늦은 응답이 도착할 옛 노드를 붙잡아 둔다 — 화면 교체 뒤에도 참조는 살아 있다.
    const line = required<HTMLElement>(dialog, ".pairing-firewall");
    const allow = required<HTMLButtonElement>(dialog, ".pairing-allow");
    expect(line.textContent).toBe("Checking Windows Firewall…");
    expect(allow.hidden).toBe(true);

    backButton(dialog).click();
    await flush();

    firewall.resolve(status({ state: "missing" }));
    await flush();

    // isCurrent 가드가 없으면 늦은 응답이 옛 노드의 문구·버튼 상태를 바꾼다.
    expect(line.textContent).toBe("Checking Windows Firewall…");
    expect(allow.hidden).toBe(true);
    // 현재 화면은 선택 화면 그대로다.
    expect(dialog.querySelectorAll(".pairing-mode")).toHaveLength(3);
    expect(dialog.querySelector(".pairing-firewall")).toBeNull();
    expect(dialog.querySelector(".pairing-allow")).toBeNull();
  });
});

describe("pairing dialog — Secure Remote", () => {
  it("generates one pairing id, starts once even on a double click, and shows the QR URL", async () => {
    const start = vi.fn(async (pairingId: string) => ({
      state: "waiting" as const,
      pairingId,
      url: secureUrl(pairingId),
    }));
    const randomUUID = vi.fn(() => SECURE_ID);
    const dialog = open(
      fakeBackend({
        secureRemoteStart: start,
        // start 성공 뒤의 상태 감시도 이 페어링을 살아 있다고 본다.
        secureRemoteStatus: async () => waitingStatus(SECURE_ID),
      }),
      randomUUID,
    );

    const button = modeButton(dialog, "secure");
    button.click();
    button.click(); // 같은 엘리먼트의 중복 클릭 — 첫 클릭이 화면을 바꿨으므로 무시된다
    await flush();

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(SECURE_ID);
    expect(required<HTMLElement>(dialog, ".pairing-url").textContent).toBe(secureUrl(SECURE_ID));
  });

  it("explains the LAN boundary, certificate hash and encryption without overclaiming", async () => {
    const dialog = open(fakeBackend());
    modeButton(dialog, "secure").click();
    await flush();

    const note = required<HTMLElement>(dialog, ".pairing-secure-note").textContent ?? "";
    expect(note).toBe(SECURE_REMOTE_NOTE);
    // QR 은 이 PC 의 LAN 주소를 가리킨다.
    expect(note).toContain("LAN address in the QR");
    // 외부 도달은 사용자가 만든 별도 네트워크 경로가 있을 때만 가능하다.
    expect(note).toContain("VPN");
    expect(note).toContain("port forwarding");
    expect(note).toContain("SHA-256");
    expect(note).toContain("WebTransport");
    expect(note).toContain("not the whole trust store");
    // 절대 표현 금지 — 서버는 모든 인터페이스에 바인드한다.
    expect(note).not.toContain("nothing is opened");
    expect(note).not.toContain("internet");
  });

  it("shows a user-readable error for a busy rejection", async () => {
    const dialog = open(
      fakeBackend({
        secureRemoteStart: async () => {
          throw { code: "busy", message: "a pairing is already starting" };
        },
      }),
    );

    modeButton(dialog, "secure").click();
    await flush();

    const error = required<HTMLElement>(dialog, ".pairing-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("already in progress");
  });

  it("cancels immediately when closed while start is still pending", async () => {
    const start = deferred<SecureRemoteStart>();
    const cancel = vi.fn(async () => idleStatus());
    const dialog = open(
      fakeBackend({ secureRemoteStart: () => start.promise, secureRemoteCancel: cancel }),
    );

    modeButton(dialog, "secure").click();
    await flush();
    expect(cancel).not.toHaveBeenCalled();

    // start 응답 전에 닫아도 cancel 이 먼저 나가야 Rust 의 tombstone 이 늦은
    // 바인드를 거절한다.
    dialog.close();
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(SECURE_ID);

    // 늦게 도착한 start 성공은 닫힌 화면을 되살리지 않는다.
    start.resolve({ state: "waiting", pairingId: SECURE_ID, url: secureUrl(SECURE_ID) });
    await flush();
    expect(dialog.isConnected).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a waiting pairing when the dialog closes after start succeeded", async () => {
    const cancel = vi.fn(async () => idleStatus());
    const dialog = open(fakeBackend({ secureRemoteCancel: cancel }));

    modeButton(dialog, "secure").click();
    await flush();
    dialog.close();
    await flush();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(SECURE_ID);
  });

  it("switching modes cancels the pending pairing and drops the late start", async () => {
    const start = deferred<SecureRemoteStart>();
    const cancel = vi.fn(async () => idleStatus());
    const remotePairing = vi.fn(async () => ({ url: LOCAL_URL }));
    const dialog = open(
      fakeBackend({
        secureRemoteStart: () => start.promise,
        secureRemoteCancel: cancel,
        remotePairing,
      }),
    );

    modeButton(dialog, "secure").click();
    await flush();
    backButton(dialog).click();
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(SECURE_ID);

    modeButton(dialog, "local").click();
    await flush();
    expect(required<HTMLElement>(dialog, ".pairing-url").textContent).toBe(LOCAL_URL);

    // 늦은 start 성공이 지금 화면(Local HTTP)의 URL 을 덮지 않는다.
    start.resolve({ state: "waiting", pairingId: SECURE_ID, url: secureUrl(SECURE_ID) });
    await flush();
    expect(required<HTMLElement>(dialog, ".pairing-url").textContent).toBe(LOCAL_URL);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("a cancel that returns connected marks the live connection once a fresh status confirms it", async () => {
    const cancel = deferred<SecureRemoteStatus>();
    let connected = false;
    const dialog = open(
      fakeBackend({
        secureRemoteCancel: () => cancel.promise,
        secureRemoteStatus: async () =>
          connected ? { state: "connected", pairingId: SECURE_ID, reason: null } : idleStatus(),
      }),
    );

    modeButton(dialog, "secure").click();
    await flush();
    backButton(dialog).click();
    await flush();

    // 취소 응답 전에는 안내가 없다 — 선택 화면의 조회는 idle 이었다.
    expect(required<HTMLElement>(dialog, ".pairing-notice").hidden).toBe(true);

    connected = true;
    cancel.resolve({ state: "connected", pairingId: SECURE_ID, reason: null });
    await flush();

    const notice = required<HTMLElement>(dialog, ".pairing-notice");
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe(SECURE_CONNECTED_NOTICE);
  });

  it("keeps the notice hidden when the connected cancel is already stale", async () => {
    const cancel = deferred<SecureRemoteStatus>();
    const dialog = open(
      fakeBackend({
        secureRemoteCancel: () => cancel.promise,
        // 취소 응답과 표시 시점 사이에 연결이 끝난 경우 — 최신 조회는 계속 idle 이다.
        secureRemoteStatus: async () => idleStatus(),
      }),
    );

    modeButton(dialog, "secure").click();
    await flush();
    backButton(dialog).click();
    await flush();

    cancel.resolve({ state: "connected", pairingId: SECURE_ID, reason: null });
    await flush();

    // 취소 응답의 스냅샷을 그대로 믿지 않는다.
    expect(required<HTMLElement>(dialog, ".pairing-notice").hidden).toBe(true);
  });

  it("drops a late connected cancel once another mode is on screen", async () => {
    const cancel = deferred<SecureRemoteStatus>();
    const dialog = open(
      fakeBackend({
        secureRemoteCancel: () => cancel.promise,
        remotePairing: async () => ({ url: LOCAL_URL }),
        secureRemoteStatus: async () => idleStatus(),
      }),
    );

    modeButton(dialog, "secure").click();
    await flush();
    backButton(dialog).click();
    await flush();
    modeButton(dialog, "local").click();
    await flush();

    cancel.resolve({ state: "connected", pairingId: SECURE_ID, reason: null });
    await flush();

    // 새 Local HTTP 화면을 이전 페어링의 안내가 덮지 않는다.
    expect(required<HTMLElement>(dialog, ".pairing-notice").hidden).toBe(true);
    expect(required<HTMLElement>(dialog, ".pairing-url").textContent).toBe(LOCAL_URL);
  });

  it("drops a late connected cancel from an earlier pairing on a later choice screen", async () => {
    const ids = ["pairing-a", "pairing-b"];
    const firstCancel = deferred<SecureRemoteStatus>();
    const secureRemoteStatus = vi.fn(async () => idleStatus());
    const dialog = open(
      fakeBackend({
        secureRemoteCancel: (pairingId: string) =>
          pairingId === "pairing-a" ? firstCancel.promise : Promise.resolve(idleStatus()),
        secureRemoteStatus,
      }),
      () => ids.shift() ?? "pairing-c",
    );

    modeButton(dialog, "secure").click(); // 페어링 A
    await flush();
    backButton(dialog).click(); // A 취소(지연) → 선택 화면
    await flush();
    modeButton(dialog, "secure").click(); // 페어링 B
    await flush();
    backButton(dialog).click(); // B 취소 → 새 선택 화면
    await flush();

    const callsBefore = secureRemoteStatus.mock.calls.length;
    firstCancel.resolve({ state: "connected", pairingId: "pairing-a", reason: null });
    await flush();

    // A 의 취소 사실은 새 페어링 뒤의 선택 화면의 것이 아니다 — 안내도 재조회도 없다.
    expect(required<HTMLElement>(dialog, ".pairing-notice").hidden).toBe(true);
    expect(secureRemoteStatus).toHaveBeenCalledTimes(callsBefore);
  });

  it("discards a connected cancel result after the dialog closed", async () => {
    const cancel = deferred<SecureRemoteStatus>();
    const dialog = open(fakeBackend({ secureRemoteCancel: () => cancel.promise }));

    modeButton(dialog, "secure").click();
    await flush();
    dialog.close();
    await flush();

    cancel.resolve({ state: "connected", pairingId: SECURE_ID, reason: null });
    await flush();

    expect(dialog.isConnected).toBe(false);
    expect(required<HTMLElement>(dialog, ".pairing-notice").hidden).toBe(true);
  });

  it("ignores a status query started by a previous choice screen", async () => {
    const firstStatus = deferred<SecureRemoteStatus>();
    let calls = 0;
    const dialog = open(
      fakeBackend({
        secureRemoteStatus: () => {
          calls += 1;
          return calls === 1 ? firstStatus.promise : Promise.resolve(idleStatus());
        },
        secureRemoteCancel: async () => idleStatus(),
      }),
    );

    // 첫 선택 화면의 조회가 아직 안 끝난 채 Secure → Back 으로 새 선택 화면에 온다.
    modeButton(dialog, "secure").click();
    await flush();
    backButton(dialog).click();
    await flush();

    firstStatus.resolve({ state: "connected", pairingId: SECURE_ID, reason: null });
    await flush();

    // 옛 선택 화면에서 시작한 조회는 세대도 조회 순번도 지났다 — 낡은 안내는 없다.
    expect(required<HTMLElement>(dialog, ".pairing-notice").hidden).toBe(true);
  });

  it("never writes the secret URL to browser storage", async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const dialog = open(
      fakeBackend({
        // 상태 감시가 만료로 보면 URL 을 지운다 — 여기서는 살아 있는 페어링이다.
        secureRemoteStatus: async () => waitingStatus(SECURE_ID),
      }),
    );

    modeButton(dialog, "secure").click();
    await flush();
    expect(required<HTMLElement>(dialog, ".pairing-url").textContent).toBe(secureUrl(SECURE_ID));

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("pairing dialog — Secure Remote lifetime", () => {
  it("cancels a waiting pairing on pagehide — a WebView reload never fires close", async () => {
    const cancel = vi.fn(async () => idleStatus());
    const dialog = open(fakeBackend({ secureRemoteCancel: cancel }));
    modeButton(dialog, "secure").click();
    await flush();

    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(SECURE_ID);

    // 닫힘 경로가 같은 취소를 두 번 보내지 않는다.
    dialog.close();
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("hides the QR and URL once the phone connects", async () => {
    vi.useFakeTimers();
    let status: SecureRemoteStatus = waitingStatus(SECURE_ID);
    const dialog = open(fakeBackend({ secureRemoteStatus: async () => status }));
    modeButton(dialog, "secure").click();
    await vi.advanceTimersByTimeAsync(0);

    const url = required<HTMLElement>(dialog, ".pairing-url");
    expect(url.textContent).toBe(secureUrl(SECURE_ID));
    expect(required<HTMLElement>(dialog, ".pairing-secure-status").textContent).toBe(
      SECURE_WAITING_TEXT,
    );

    status = { state: "connected", pairingId: SECURE_ID, reason: null };
    await vi.advanceTimersByTimeAsync(SECURE_STATUS_POLL_MS);

    // 죽은 QR·1회용 토큰 URL 을 살아 있는 것처럼 남기지 않는다.
    expect(url.textContent).toBe("");
    expect(required<HTMLCanvasElement>(dialog, ".pairing-qr").hidden).toBe(true);
    expect(required<HTMLElement>(dialog, ".pairing-secure-status").textContent).toBe(
      SECURE_CONNECTED_NOTICE,
    );
  });

  it("clears the QR on expiry and does not revive it with a late waiting status", async () => {
    vi.useFakeTimers();
    let status: SecureRemoteStatus = waitingStatus(SECURE_ID);
    const dialog = open(fakeBackend({ secureRemoteStatus: async () => status }));
    modeButton(dialog, "secure").click();
    await vi.advanceTimersByTimeAsync(0);

    status = idleStatus();
    await vi.advanceTimersByTimeAsync(SECURE_STATUS_POLL_MS);
    const url = required<HTMLElement>(dialog, ".pairing-url");
    expect(url.textContent).toBe("");
    expect(required<HTMLElement>(dialog, ".pairing-secure-status").textContent).toBe(
      SECURE_PAIRING_ENDED_TEXT,
    );

    status = waitingStatus(SECURE_ID);
    await vi.advanceTimersByTimeAsync(SECURE_STATUS_POLL_MS);
    expect(url.textContent).toBe("");
    expect(required<HTMLElement>(dialog, ".pairing-secure-status").textContent).toBe(
      SECURE_PAIRING_ENDED_TEXT,
    );
  });

  it("shows stopping and failed states truthfully", async () => {
    vi.useFakeTimers();
    let status: SecureRemoteStatus = waitingStatus(SECURE_ID);
    const dialog = open(fakeBackend({ secureRemoteStatus: async () => status }));
    modeButton(dialog, "secure").click();
    await vi.advanceTimersByTimeAsync(0);

    status = { state: "stopping", pairingId: SECURE_ID, reason: null };
    await vi.advanceTimersByTimeAsync(SECURE_STATUS_POLL_MS);
    const statusLine = required<HTMLElement>(dialog, ".pairing-secure-status");
    expect(statusLine.textContent).toBe(SECURE_STOPPING_TEXT);
    expect(required<HTMLElement>(dialog, ".pairing-url").textContent).toBe("");

    status = { state: "failed", pairingId: SECURE_ID, reason: "TLS setup failed" };
    await vi.advanceTimersByTimeAsync(SECURE_STATUS_POLL_MS);
    expect(statusLine.textContent).toContain("TLS setup failed");
  });

  it("stops the status watch on Back and keeps it stopped after close", async () => {
    vi.useFakeTimers();
    const statusCalls = vi.fn(async () => waitingStatus(SECURE_ID));
    const dialog = open(
      fakeBackend({
        secureRemoteStatus: statusCalls,
        secureRemoteCancel: async () => idleStatus(),
      }),
    );
    modeButton(dialog, "secure").click();
    await vi.advanceTimersByTimeAsync(0);
    // 첫 조회는 선택 화면의 일회 조회, 두 번째가 감시의 첫 조회다.
    const beforePoll = statusCalls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SECURE_STATUS_POLL_MS);
    expect(statusCalls.mock.calls.length).toBe(beforePoll + 1);

    // Back 은 취소와 함께 선택 화면으로 돌아간다 — 선택 화면의 일회 조회까지 끝낸 뒤
    // 감시 타이머가 더 이상 돌지 않는지 본다.
    backButton(dialog).click();
    await vi.advanceTimersByTimeAsync(0);
    const afterBack = statusCalls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SECURE_STATUS_POLL_MS * 3);
    expect(statusCalls).toHaveBeenCalledTimes(afterBack);

    dialog.close();
    await vi.advanceTimersByTimeAsync(SECURE_STATUS_POLL_MS * 3);
    expect(statusCalls).toHaveBeenCalledTimes(afterBack);
  });
});

describe("기억한 모바일 페어링", () => {
  it("끊긴 연결을 현재 연결된 것으로 표시하지 않는다", async () => {
    const dialog = open(fakeBackend({
      secureRemoteStatus: async () => ({state: "remembered", pairingId: SECURE_ID, reason: null}),
    }));
    await flush();
    expect(required<HTMLElement>(dialog, ".pairing-notice").textContent).toContain("No phone is connected right now");
  });
});

describe("pairing dialog — UDP firewall for Secure Remote", () => {
  it("uses the UDP-only commands and never calls allow without a user click", async () => {
    const remoteFirewallStatus = vi.fn(async () => status({ state: "missing" }));
    const remoteFirewallAllow = vi.fn(async () => outcome({}));
    const secureRemoteFirewallStatus = vi.fn(async () => status({ state: "missing" }));
    const secureRemoteFirewallAllow = vi.fn(async () => outcome({}));
    const dialog = open(
      fakeBackend({
        remoteFirewallStatus,
        remoteFirewallAllow,
        secureRemoteFirewallStatus,
        secureRemoteFirewallAllow,
      }),
    );

    modeButton(dialog, "secure").click();
    await flush();

    // 시작 경로는 UDP 상태만 조회한다 — TCP 커맨드도, UAC(allow)도 없다.
    expect(secureRemoteFirewallStatus).toHaveBeenCalledTimes(1);
    expect(remoteFirewallStatus).not.toHaveBeenCalled();
    expect(secureRemoteFirewallAllow).not.toHaveBeenCalled();
    expect(remoteFirewallAllow).not.toHaveBeenCalled();

    const allow = required<HTMLButtonElement>(dialog, ".pairing-allow");
    expect(allow.hidden).toBe(false);
    allow.click();
    await flush();

    expect(secureRemoteFirewallAllow).toHaveBeenCalledTimes(1);
    expect(remoteFirewallAllow).not.toHaveBeenCalled();
  });

  it("names the UDP rule, not the TCP rule, in firewall guidance", async () => {
    const dialog = open(
      fakeBackend({
        secureRemoteFirewallStatus: async () =>
          status({ state: "stalePath", detail: "C:\\old\\mast.exe" }),
      }),
    );

    modeButton(dialog, "secure").click();
    await flush();

    expect(required<HTMLElement>(dialog, ".pairing-firewall").textContent).toContain(
      '"mast secure remote (LAN)"',
    );
  });

  it("names the UDP rule when an allow is re-detected as stalePath", async () => {
    const dialog = open(
      fakeBackend({
        secureRemoteFirewallStatus: async () => status({ state: "missing" }),
        secureRemoteFirewallAllow: async () =>
          outcome({
            outcome: "applied",
            status: status({ state: "stalePath", detail: "C:\\old\\mast.exe" }),
          }),
      }),
    );

    modeButton(dialog, "secure").click();
    await flush();
    required<HTMLButtonElement>(dialog, ".pairing-allow").click();
    await flush();

    // UDP allow 의 재감지 안내가 TCP 규칙 이름을 말하면 거짓이다.
    const text = required<HTMLElement>(dialog, ".pairing-firewall").textContent ?? "";
    expect(text).toContain('"mast secure remote (LAN)"');
    expect(text).not.toContain('"mast remote (LAN)"');
  });

  it("a late UAC result does not reappear after switching back to the choice screen", async () => {
    const allow = deferred<AllowOutcome>();
    const dialog = open(
      fakeBackend({
        // 규칙이 없어야 allow 버튼이 실제로 보이고 눌린다 — UAC 가 열려 있는 동안
        // 사용자가 Back 을 누르는 현실적인 순서를 만든다.
        secureRemoteFirewallStatus: async () => status({ state: "missing" }),
        secureRemoteFirewallAllow: () => allow.promise,
      }),
    );

    modeButton(dialog, "secure").click();
    await flush();

    const line = required<HTMLElement>(dialog, ".pairing-firewall");
    const allowButton = required<HTMLButtonElement>(dialog, ".pairing-allow");
    expect(allowButton.hidden).toBe(false);
    allowButton.click();
    await flush();
    expect(line.textContent).toBe("Waiting for Windows…");
    expect(allowButton.disabled).toBe(true);

    backButton(dialog).click();
    await flush();

    allow.resolve(outcome({ outcome: "applied", status: status({ state: "allowed" }) }));
    await flush();

    // 새 화면은 선택 화면 그대로다 — 방화벽 블록도 UAC 안내도 되살아나지 않는다.
    expect(dialog.querySelectorAll(".pairing-mode")).toHaveLength(3);
    expect(dialog.querySelector(".pairing-firewall")).toBeNull();
    expect(dialog.querySelector(".pairing-allow")).toBeNull();
    // 늦은 결과가 옛 노드를 갱신하지 않았다 — isCurrent 가드가 없으면 문구가
    // allowed 안내로 바뀌고 버튼 표시·비활성이 되돌아간다.
    expect(line.textContent).toBe("Waiting for Windows…");
    expect(allowButton.hidden).toBe(false);
    expect(allowButton.disabled).toBe(true);
  });
});
