import { describe, expect, it, vi } from "vitest";

import { base64urlEncode } from "./base64url";
import { parsePairingFragment, reloadOnPairingHashChange, takePairingFragment } from "./pairing";
import type { HashChangeSource } from "./pairing";

// 32바이트 값들의 canonical 43자 인코딩. `A`*43 은 전부 0x00 이라 canonical 이다.
const CERT = base64urlEncode(new Uint8Array(32).fill(0xab));
const TOKEN = base64urlEncode(new Uint8Array(32).fill(0x5c));
const VALID = `#v=1&host=192.168.0.20&port=7331&cert=${CERT}&token=${TOKEN}`;

function link(hash: string) {
  const parsed = parsePairingFragment(hash);
  if (!parsed.ok) throw new Error(`expected a valid link: ${JSON.stringify(parsed)}`);
  return parsed.link;
}

describe("parsePairingFragment", () => {
  it("accepts the v1 fragment and decodes the certificate hash", () => {
    const parsed = link(VALID);
    expect(parsed.host).toBe("192.168.0.20");
    expect(parsed.port).toBe(7331);
    expect(parsed.certHash.length).toBe(32);
    expect([...parsed.certHash]).toEqual([...new Uint8Array(32).fill(0xab)]);
    expect(parsed.token).toBe(TOKEN);
  });

  it("accepts any field order", () => {
    const parsed = link(`#token=${TOKEN}&cert=${CERT}&port=7331&host=10.0.0.7&v=1`);
    expect(parsed.host).toBe("10.0.0.7");
  });

  it("accepts a public IPv4 host — external paths stay possible (VPN, port forwarding)", () => {
    // 사설 대역 제한은 사용자가 만드는 외부 경로를 막는다 — 파싱은 IPv4 문법만 본다.
    // 대신 host 는 연결 중과 연결된 화면에 항상 표시된다 (`destinationText`).
    expect(link(VALID.replace("host=192.168.0.20", "host=203.0.113.7")).host).toBe("203.0.113.7");
  });

  it("treats a missing or empty fragment as no pairing", () => {
    for (const hash of ["", "#"]) {
      expect(parsePairingFragment(hash)).toEqual({ ok: false, reason: "missing" });
    }
  });

  it("rejects a wrong version", () => {
    expect(parsePairingFragment(VALID.replace("v=1", "v=2"))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects malformed IPv4 hosts", () => {
    for (const host of [
      "192.168.0",
      "192.168.0.256",
      "192.168.0.1.2",
      "192.168.000.1",
      "localhost",
      "192.168.0.1:7331",
      "",
    ]) {
      const hash = VALID.replace("host=192.168.0.20", `host=${host}`);
      expect(parsePairingFragment(hash), host).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects malformed ports", () => {
    for (const port of ["0", "65536", "73314", "-1", "7331.0", "07331", "abc", ""]) {
      const hash = VALID.replace("port=7331", `port=${port}`);
      expect(parsePairingFragment(hash), port).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects a certificate hash that is not 32 base64url bytes", () => {
    for (const cert of [
      base64urlEncode(new Uint8Array(31)),
      base64urlEncode(new Uint8Array(33)),
      "A".repeat(43) + "=",
      "A".repeat(42) + "+",
      "not-base64!",
      "",
    ]) {
      const hash = VALID.replace(`cert=${CERT}`, `cert=${cert}`);
      expect(parsePairingFragment(hash), cert).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects a non-canonical 43-char value even though it decodes", () => {
    // `B`*43 은 32바이트로 풀리지만 같은 바이트의 canonical 인코딩이 아니다 —
    // 잉여 비트가 0 이 아닌 값은 거부한다. token 에도 같은 규칙이 걸리는지 본다.
    const nonCanonical = "B".repeat(43);
    expect(parsePairingFragment(VALID.replace(`cert=${CERT}`, `cert=${nonCanonical}`))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parsePairingFragment(VALID.replace(`token=${TOKEN}`, `token=${nonCanonical}`))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a token that is not 43 base64url chars", () => {
    for (const token of ["A".repeat(42), "A".repeat(44), "A".repeat(43) + "=", "a b", ""]) {
      const hash = VALID.replace(`token=${TOKEN}`, `token=${token}`);
      expect(parsePairingFragment(hash), token).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects duplicate or unknown fields", () => {
    expect(parsePairingFragment(`${VALID}&host=10.0.0.1`)).toEqual({ ok: false, reason: "invalid" });
    expect(parsePairingFragment(`${VALID}&extra=1`)).toEqual({ ok: false, reason: "invalid" });
    expect(parsePairingFragment("#v=1&host=192.168.0.20&port=7331&cert=x")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("takePairingFragment", () => {
  function location(hash: string) {
    return { hash, pathname: "/mast/", search: "?a=1" };
  }

  it("clears the fragment on success", () => {
    const replaceState = vi.fn();
    const parsed = takePairingFragment(location(VALID), { replaceState });
    expect(parsed.ok).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/mast/?a=1");
  });

  it("clears the fragment even when the link is invalid", () => {
    const replaceState = vi.fn();
    const parsed = takePairingFragment(location("#v=1&host=nope"), { replaceState });
    expect(parsed).toEqual({ ok: false, reason: "invalid" });
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("clears the fragment with a token even when another field is wrong", () => {
    const replaceState = vi.fn();
    const parsed = takePairingFragment(
      location(`#v=1&host=nope&port=7331&cert=${CERT}&token=${TOKEN}`),
      { replaceState },
    );
    expect(parsed.ok).toBe(false);
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("does not touch the URL when there was no fragment", () => {
    const replaceState = vi.fn();
    expect(takePairingFragment(location(""), { replaceState })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("reloadOnPairingHashChange", () => {
  /** 실제 window 대신 이벤트 등록만 기록한다 — 이 테스트는 node 환경에서 돈다. */
  function sourceOf(): { source: HashChangeSource; fire: () => void } {
    const handlers: (() => void)[] = [];
    return {
      source: {
        addEventListener: (_type, handler) => {
          handlers.push(handler);
        },
      },
      fire: () => {
        for (const handler of handlers) handler();
      },
    };
  }

  it("reloads once on a hashchange and ignores a duplicate before unload", () => {
    const { source, fire } = sourceOf();
    const reload = vi.fn();

    reloadOnPairingHashChange(source, reload);
    expect(reload).not.toHaveBeenCalled();

    // 같은 탭에 새 QR URL 을 열면 fragment 만 바뀐다 — 이때 전체 reload 로 새 문서가
    // QR 을 처음부터 읽게 한다.
    fire();
    expect(reload).toHaveBeenCalledTimes(1);

    // 언로드가 끝나기 전에 한 번 더 들어와도 두 번째 reload 는 요청하지 않는다.
    fire();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
