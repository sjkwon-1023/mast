// @vitest-environment happy-dom
//
// 폰 엔트리의 순수 매핑 잠금. 실제 WebTransport 연결·hashchange reload·실기기
// 동작은 여기서 검증할 수 없다 — 그 사실은 result.md 에 적혀 있다.

import { describe, expect, it } from "vitest";

import { RemoteError, TransportClosedError } from "../remote/transport";
import { connectErrorText, destinationText } from "./main";
import { WebTransportUnsupportedError } from "./transport";

describe("connectErrorText", () => {
  it("maps 409 to ending the phone session and making a fresh pairing", () => {
    const text = connectErrorText(new RemoteError(409, "a phone is already connected"));
    expect(text).toContain("End that phone session");
    expect(text).toContain("new pairing");
    // 존재하지 않는 데스크톱 disconnect 조작을 지시하지 않는다.
    expect(text).not.toContain("Close it in mast");
    // 첫 세션이 끝나면 이전 QR 은 유효하지 않다 — 같은 QR 재스캔을 지시하지 않는다.
    expect(text).not.toContain("scan this QR again");
  });

  it("keeps the other server statuses actionable", () => {
    expect(connectErrorText(new RemoteError(401, "unauthorized"))).toContain("Not authorized");
    expect(connectErrorText(new RemoteError(429, "too many"))).toContain("wait a minute");
    expect(connectErrorText(new RemoteError(503, "cancelled"))).toContain("scan a new QR");
  });

  it("does not promise certificate pinning just because the constructor accepted options", () => {
    // 사전에서 모르는 멤버는 조용히 무시된다 — 생성 성공만으로 지원을 단정하지 않는다.
    const fallback = connectErrorText(new Error("handshake failed"));
    expect(fallback).toContain("serverCertificateHashes");
    expect(fallback).toContain("Chrome or Edge");
    expect(connectErrorText(new TransportClosedError("closed"))).toContain("scan the pairing QR");
    expect(connectErrorText(new WebTransportUnsupportedError("threw"))).toContain("refused");
  });
});

describe("destinationText", () => {
  it("names the host and port the phone is connecting to", () => {
    expect(destinationText("192.168.0.20", 7331)).toBe("192.168.0.20:7331");
    // 공인 IP·VPN 경로도 표현할 수 있어야 한다 (사설 대역 제한 없음).
    expect(destinationText("203.0.113.7", 7331)).toBe("203.0.113.7:7331");
  });
});
