/** Desktop platform helpers kept DOM-only so the Rust core stays platform-neutral. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toLowerCase().startsWith("mac");
}

/** The desktop UI modifier: Command on macOS, Control elsewhere. */
export function primaryModifier(
  ev: Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
): boolean {
  return isMacPlatform() ? ev.metaKey : ev.ctrlKey;
}
