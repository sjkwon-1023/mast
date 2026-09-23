/** Desktop host detection; also safe in unit tests / pre-rendering without DOM. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** Native editing/zoom modifier. Never turn Ctrl+C/D/W into app shortcuts on Mac. */
export function primaryModifier(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey">,
  mac = IS_MAC,
): boolean {
  return !event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}
