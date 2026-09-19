// 탭 ID 배지 — settings.json 의 `showTabIds` (키가 없으면 표시가 기본값).
//
// 배지의 숫자는 모델·백엔드가 새로 만드는 값이 아니라 각 탭의 안정 `Tab.id` 그대로다.
// `mast ls` 의 TAB 열과 `mast send '#<id>'` 가 받는 주소이므로, 화면에서 "이 탭을
// 무엇으로 부르는가"를 읽을 수 있어야 한다.
//
// 다른 설정과 같은 규율로 부팅 때 한 번 적용되고 그 뒤로는 바뀌지 않는다
// (settings.json 은 재시작 후에만 반영된다 — docs/SETTINGS.md). 그래서 렌더 중
// 설정을 다시 읽는 경로 없이 모듈 상태 하나로 끝난다.

import type { UiSettings } from "../../infrastructure/backend";

/** 키가 없거나(미설정) true 면 표시 — 숨김은 명시적 `false` 뿐이다. */
let showTabIds = true;

/** 부팅 1회 적용 — 첫 스냅샷 렌더보다 먼저 불린다 (app/main.ts 의 다른 apply* 옆). */
export function applyTabIdSettings(settings: UiSettings): void {
  showTabIds = settings.showTabIds ?? true;
}

/** 탭 버튼이 지금 ID 배지를 그리는가 — 렌더 판정용 조회. */
export function tabIdsVisible(): boolean {
  return showTabIds;
}
