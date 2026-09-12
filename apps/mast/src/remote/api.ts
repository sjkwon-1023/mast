// 서버 호출 래퍼 — 이 파일이 폰 페이지에서 유일하게 네트워크를 만지는 자리다.
//
// 토큰은 페어링 URL 의 fragment 로 한 번 들어와 localStorage 에 남는다. 그
// 저장소는 origin(`http://<ip>:<port>`) 에 묶여 있고 그 origin 은 나중에 같은
// IP 를 받은 다른 기기가 사칭할 수 있다 — 평문 LAN 표면이 받아들인 한계이며
// (ADR-0016 의 한계 절). 그래서 이 페이지는 모델 문자열을 HTML 로 해석되는 자리에 절대
// 넣지 않는다 — 전부 `textContent` 다 (list-view.ts).

import { parseScreenMeta } from "./protocol";
import type { ScreenMeta, ScreenQuery } from "./protocol";
import type { StateSnapshot, TabId } from "../types";

const TOKEN_KEY = "mast.remoteToken";

/** localStorage 는 프라이빗 모드·차단 설정에서 접근 자체가 던진다 — 토큰을
 *  못 읽는 것은 "페어링 안 됨"으로 다루면 되고 페이지가 죽을 일은 아니다. */
export function loadToken(): string | null {
  try {
    const raw = window.localStorage.getItem(TOKEN_KEY);
    return raw === null || raw === "" ? null : raw;
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 저장이 안 되면 이번 세션에만 유효한 상태가 된다 — 조용히 진행한다.
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 위와 같다.
  }
}

/** 폴링 스케줄이 401·429 를 이 값으로 읽는다. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface ScreenReply {
  meta: ScreenMeta;
  bytes: Uint8Array;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = loadToken();
  if (token === null) throw new HttpError(401, "not paired");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  // 401 은 이 토큰이 더는 유효하지 않다는 뜻이다(재발급·다른 PC). 남겨 두면 다음 방문도
  // 같은 401 로 끝나므로 지운다 — 그러면 다음 방문은 페어링 안내부터 시작한다.
  if (response.status === 401) clearToken();
  if (!response.ok) throw new HttpError(response.status, `${init.method ?? "GET"} ${path}`);
  return response;
}

export async function fetchState(): Promise<StateSnapshot> {
  const response = await request("/api/state");
  return (await response.json()) as StateSnapshot;
}

/** `query` 가 null 이면 `since` 없이 = reset 스냅샷을 요청한다.
 *
 *  세션 토큰을 인코딩하지 않는 것은 계약이다 — 서버의 쿼리 파서는 퍼센트
 *  디코딩을 하지 않고(`routes.rs`), 토큰은 숫자와 `:` 뿐이라 인코딩이 필요
 *  없다. `encodeURIComponent` 를 씌우면 `%3A` 가 그대로 비교돼 항상 불일치한다. */
export async function fetchScreen(tab: TabId, query: ScreenQuery | null): Promise<ScreenReply> {
  const suffix = query === null ? "" : `?since=${query.since}&session=${query.session}`;
  const response = await request(`/api/tabs/${tab}/screen${suffix}`);
  const meta = parseScreenMeta((name) => response.headers.get(name));
  if (meta === null) throw new Error("screen reply has malformed headers");
  const body = await response.arrayBuffer();
  return { meta, bytes: new Uint8Array(body) };
}

export async function postInput(tab: TabId, session: string, data: string): Promise<void> {
  await request(`/api/tabs/${tab}/input?session=${session}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: data,
  });
}
