import type { UpdateInfo } from "../infrastructure/backend";

type UpdateChecked = (handler: (info: UpdateInfo) => void) => Promise<unknown>;
type CachedUpdateInfo = () => Promise<UpdateInfo>;

/** 업데이트 이벤트를 먼저 구독하고 캐시를 읽는다. 이벤트가 먼저 도착한 경우
 *  뒤늦게 끝난 캐시 조회가 더 새로운 결과를 덮어쓰지 않게 한다. */
export function initUpdateNotice(
  subscribe: UpdateChecked,
  getCached: CachedUpdateInfo,
  apply: (info: UpdateInfo) => void,
): void {
  void (async () => {
    let eventSeen = false;
    try {
      await subscribe((info) => {
        eventSeen = true;
        apply(info);
      });
    } catch (err) {
      console.debug("[mast] update event listen failed", err);
    }

    try {
      const info = await getCached();
      if (!eventSeen) apply(info);
    } catch (err) {
      console.debug("[mast] update info failed", err);
    }
  })();
}
