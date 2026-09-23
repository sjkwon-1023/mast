import { IS_MAC } from "../shared/platform";
/** Alt 를 오래 누를 때만 배지를 보인다. keyup 을 놓쳐도 창이 흐려지면 닫는다. */
export function installShortcutGuide(): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const hide = () => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
    document.body.classList.remove("shortcut-guide");
  };
  const onDown = (ev: KeyboardEvent) => {
    const held = IS_MAC ? ev.key === "Meta" && !ev.ctrlKey && !ev.altKey : ev.key === "Alt" && !ev.ctrlKey && !ev.metaKey;
    if (held && !ev.isComposing && !ev.repeat && pending === null) {
      pending = setTimeout(() => {
        pending = null;
        document.body.classList.add("shortcut-guide");
      }, 1314);
    } else if (ev.ctrlKey || (IS_MAC ? ev.altKey : ev.metaKey) || ev.key === "AltGraph") {
      hide();
    }
  };
  const onUp = (ev: KeyboardEvent) => {
    if (IS_MAC ? ev.key === "Meta" || !ev.metaKey : ev.key === "Alt" || !ev.altKey) hide();
  };
  const onVisibility = () => {
    if (document.visibilityState !== "visible") hide();
  };
  window.addEventListener("keydown", onDown, { capture: true });
  window.addEventListener("keyup", onUp, { capture: true });
  window.addEventListener("blur", hide);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    hide();
    window.removeEventListener("keydown", onDown, { capture: true });
    window.removeEventListener("keyup", onUp, { capture: true });
    window.removeEventListener("blur", hide);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
