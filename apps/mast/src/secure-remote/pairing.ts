// Secure Remote QR 의 fragment 파싱과 즉시 제거.
//
// QR 은 `https://sjkwon-1023.github.io/mast/#v=1&host=<IPv4>&port=7331&cert=<base64url>&token=<base64url>`.
// 데스크톱은 자기 LAN IPv4 를 넣지만, 여기서는 사설 대역으로 좁히지 않는다 —
// VPN·포트포워딩·공인 IP 경로도 사용자가 만들 수 있다 (호스트는 화면에 표시된다).
// fragment 는 정적 서버에 전송되지 않지만 주소창·방문 기록·스크린샷에는 남는다.
// 그래서 **유효·무효와 무관하게** 읽는 즉시 `history.replaceState` 로 지우고,
// 토큰·hash 는 어디에도 저장하지 않는다 — 이 페이지에는 storage 접근 자체가 없다.
//
// 검증은 엄격하다. 미지 필드·중복 필드·형식 오류를 받아들이면 "보냈는데 안 된다"가
// 되고, host 와 hash 는 그대로 연결 대상이 되므로 모호한 입력이 곧 보안 경계다.
// 파싱 결과의 사유는 `missing`(QR 없이 방문)과 `invalid`(있는데 틀림)뿐이다 —
// 어느 쪽인지에 따라 안내 문구만 갈리고, 화면에 fragment 값을 되비추지 않는다.

import { base64urlDecode } from "./base64url";

export interface PairingLink {
  /** IPv4 리터럴. LAN 주소가 기본이지만 VPN·포트포워딩·공인 IP 로 들어오는 경로도
   *  사용자가 만들 수 있으므로 사설 대역으로 좁히지 않는다 — 인증서 SAN 과 서버
   *  바인드가 IPv4 라는 것만이 계약이다. */
  host: string;
  port: number;
  /** SHA-256(DER) 32바이트. 이 페어링의 재연결에도 같은 핀을 사용한다. */
  certHash: Uint8Array;
  /** 43자 base64url (CSPRNG 32바이트). */
  token: string;
}

export type PairingParse =
  | { ok: true; link: PairingLink }
  | { ok: false; reason: "missing" | "invalid" };

/** v1 fragment 의 정확한 필드 집합 — 순서는 상관없고 개수·이름은 고정이다. */
const REQUIRED_FIELDS: readonly string[] = ["v", "host", "port", "cert", "token"];

/** 각 옥텟은 0–255 이고 앞자리 0 을 허용하지 않는다 — 브라우저가 `010` 을 8진수로
 *  읽는 구현이 있어, 우리가 통과시킨 문자열과 브라우저가 읽는 주소가 달라질 수 있다. */
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

const PORT = /^(?:0|[1-9][0-9]{0,4})$/;
const TOKEN_CHARS = 43;

export function parsePairingFragment(hash: string): PairingParse {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return { ok: false, reason: "missing" };

  const seen = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(raw)) {
    if (seen.has(key)) return { ok: false, reason: "invalid" };
    seen.set(key, value);
  }
  for (const key of seen.keys()) {
    if (!REQUIRED_FIELDS.includes(key)) return { ok: false, reason: "invalid" };
  }
  for (const key of REQUIRED_FIELDS) {
    if (!seen.has(key)) return { ok: false, reason: "invalid" };
  }

  if (seen.get("v") !== "1") return { ok: false, reason: "invalid" };

  const host = seen.get("host") as string;
  if (!IPV4.test(host)) return { ok: false, reason: "invalid" };

  const portRaw = seen.get("port") as string;
  if (!PORT.test(portRaw)) return { ok: false, reason: "invalid" };
  const port = Number(portRaw);
  if (port < 1 || port > 65535) return { ok: false, reason: "invalid" };

  const certHash = base64urlDecode(seen.get("cert") as string);
  if (certHash === null || certHash.length !== 32) return { ok: false, reason: "invalid" };

  const token = seen.get("token") as string;
  if (token.length !== TOKEN_CHARS) return { ok: false, reason: "invalid" };
  const tokenBytes = base64urlDecode(token);
  if (tokenBytes === null || tokenBytes.length !== 32) return { ok: false, reason: "invalid" };

  return { ok: true, link: { host, port, certHash, token } };
}

/** 테스트가 fake 로 넣을 수 있게 최소만 요구한다 (`window.location`/`window.history` 가 그대로 맞는다). */
export interface FragmentLocation {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

export interface FragmentHistory {
  replaceState(data: unknown, title: string, url?: string | null): void;
}

/** fragment 를 읽고 주소창에서 지운다. **유효·무효를 가리지 않는다** — 틀린 링크라도
 *  token 이 실려 있을 수 있고, 주소창에 남겨 둘 이유가 없다. */
export function takePairingFragment(
  location: FragmentLocation,
  history: FragmentHistory,
): PairingParse {
  const parsed = parsePairingFragment(location.hash);
  if (location.hash !== "") {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      // 같은 문서의 URL 치환이라 실제로는 실패하지 않는다. 실패해도 페이지를 죽이지 않는다.
    }
  }
  return parsed;
}

/** `window` 없이 시험할 수 있게 이벤트 구독만 요구한다 (`window` 가 그대로 맞는다). */
export interface HashChangeSource {
  addEventListener(type: "hashchange", handler: () => void): void;
}

/** 새 QR 을 **같은 탭**에 열면 fragment 만 바뀌는 same-document 이동이라 문서가
 *  다시 시작되지 않는다. 그래서 fragment 를 지우지 않은 채 전체 reload 를 요청한다:
 *  새 문서의 `start()` 가 새 QR 을 처음부터 읽고(그 전에 fragment 는 지워진다),
 *  언로드의 `pagehide` 가 이전 연결을 닫는다. 문서를 떠나는 중에 들어온 중복
 *  hashchange 는 버린다 — reload 두 번은 옛 연결 정리와 새 파싱을 경합시킨다. */
export function reloadOnPairingHashChange(source: HashChangeSource, reload: () => void): void {
  let reloading = false;
  source.addEventListener("hashchange", () => {
    if (reloading) return;
    reloading = true;
    reload();
  });
}
