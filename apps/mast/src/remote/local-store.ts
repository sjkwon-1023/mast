// Local HTTP 표면 전용 localStorage 어댑터.
//
// 이 모듈은 `remote/main.ts`(Local HTTP 엔트리)만 import 한다. Secure Remote 엔트리는
// 같은 UI 를 쓰되 이 파일을 싣지 않으므로, 정적 페이지 번들에는 storage 접근이 하나도
// 남지 않는다 — token·cert hash 를 저장하지 않는다는 계약을 코드 배치로도 지킨다.

import { clampFontPx, DEFAULT_FONT_PX } from "./screen-text";
import type { FontPxStore } from "./transport";

const FONT_KEY = "mast.remoteFontPx";

export const localStorageFontPx: FontPxStore = {
  /** localStorage 는 프라이빗 모드·차단 설정에서 접근 자체가 던진다 — 기본 크기로
   *  진행하면 되고 페이지가 죽을 일은 아니다. */
  load(): number | null {
    try {
      const raw = window.localStorage.getItem(FONT_KEY);
      return raw === null ? DEFAULT_FONT_PX : Number(raw);
    } catch {
      return DEFAULT_FONT_PX;
    }
  },
  save(px: number): void {
    try {
      window.localStorage.setItem(FONT_KEY, String(clampFontPx(px)));
    } catch {
      // 저장이 안 되면 이번 세션에만 유효한 크기가 된다 — 조용히 진행한다.
    }
  },
};
