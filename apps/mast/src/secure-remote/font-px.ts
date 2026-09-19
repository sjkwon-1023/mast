// Secure Remote 의 글자 크기 기억 — 메모리 전용.
//
// 이 표면은 토큰·인증서 hash 를 어디에도 저장하지 않는다는 계약 위에 있어서
// browser storage 를 쓰지 않는다(`local-store.ts` 는 Local HTTP 엔트리만 import).
// 값은 모듈 수명 동안만 살아남으므로 같은 페이지의 탭 전환에는 유지되고
// (RemoteApp 이 탭마다 새 TabView 를 만들고 그 생성자가 여기서 읽는다),
// 새로고침에는 새 모듈 인스턴스가 되어 기본값으로 돌아간다.

import type { FontPxStore } from "../remote/transport";

export function createMemoryFontPxStore(): FontPxStore {
  let value: number | null = null;
  return {
    load: () => value,
    save: (px: number) => {
      value = px;
    },
  };
}
