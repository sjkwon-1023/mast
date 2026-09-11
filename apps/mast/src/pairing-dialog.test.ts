import { describe, expect, it } from "vitest";

import { pairingMessage, REMOTE_OFF_MESSAGE } from "./pairing-dialog";

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
