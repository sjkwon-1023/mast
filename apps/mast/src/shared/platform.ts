/** 데스크톱 호스트 판별. 단위 테스트·DOM 없는 사전 렌더링에서도 안전하다. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** 네이티브 편집·확대 modifier. Mac 에서 Ctrl+C/D/W 를 앱 단축키로 만들지 않는다. */
export function primaryModifier(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey">,
  mac = IS_MAC,
): boolean {
  return !event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}
