// 탭 ID 배지 설정 (showTabIds) 의 프론트 쪽 계약 — 키가 없으면 표시가 기본값이고
// `false` 만 숨긴다. 모듈 상태 하나가 부팅 때 한 번 정해지므로(재시작 후 적용),
// 테스트도 파일 밖으로 상태가 새지 않게 매번 되돌린다.

import { afterEach, describe, expect, it } from "vitest";

import { applyTabIdSettings, tabIdsVisible } from "./tab-id-settings";
import type { UiSettings } from "../../infrastructure/backend";

function settings(showTabIds: boolean | null): UiSettings {
  return {
    fontFamily: null,
    fontSize: null,
    highlightLanguages: null,
    log: null,
    remote: null,
    showTabIds,
  };
}

afterEach(() => applyTabIdSettings(settings(null)));

describe("applyTabIdSettings", () => {
  it("키가 없으면(null) 표시가 기본값이다 — 기본값 해석은 프론트 한 곳", () => {
    applyTabIdSettings(settings(false));
    expect(tabIdsVisible()).toBe(false);

    applyTabIdSettings(settings(null));
    expect(tabIdsVisible()).toBe(true);
  });

  it("true 는 표시, false 는 숨김 — 둘 다 명시적으로 읽는다", () => {
    applyTabIdSettings(settings(true));
    expect(tabIdsVisible()).toBe(true);

    applyTabIdSettings(settings(false));
    expect(tabIdsVisible()).toBe(false);
  });
});
