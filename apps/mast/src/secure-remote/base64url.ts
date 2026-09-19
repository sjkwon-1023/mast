// 패딩 없는 base64url — QR 의 cert/token 과 프레임의 `bytes`·`data` 가 모두 이 인코딩이다.
// 서버(Rust `base64::URL_SAFE_NO_PAD`)와 같은 알파벳만 쓴다.

const BASE64URL_CHARS = /^[A-Za-z0-9_-]*$/;

/** `String.fromCharCode(...)` 는 인자 수 상한이 있어 덩어리로 나눠 잇는다 — 화면
 *  프레임은 1.4 MiB 까지 커진다. */
const CHUNK = 0x8000;

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 엄격 디코딩. 실패는 null 이다.
 *
 *  - `+`·`/`·`=`·공백은 거부한다 — 서버는 패딩 없이 보내고, QR 에 손으로 넣을 수 있는
 *    값이 아니다.
 *  - `length % 4 === 1` 은 어떤 바이트열도 만들지 못하는 길이다.
 *  - 마지막에 **다시 인코딩해 비교**한다. 43자짜리 값의 마지막 글자에는 잉여 2비트가
 *    있어서, 서로 다른 문자열이 같은 32바이트로 풀릴 수 있다 — 그런 값은 서버의
 *    상수 시간 비교가 보는 바이트가 같아도 우리가 받아들일 이유가 없다. */
export function base64urlDecode(text: string): Uint8Array | null {
  if (!BASE64URL_CHARS.test(text) || text.length % 4 === 1) return null;
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return base64urlEncode(bytes) === text ? bytes : null;
}
