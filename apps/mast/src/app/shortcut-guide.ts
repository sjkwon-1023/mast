/** Alt 를 오래 누를 때만 배지를 보인다. keyup 을 놓쳐도 창이 흐려지면 닫는다. */
export function installShortcutGuide(): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const hide = () => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
    document.body.classList.remove("shortcut-guide");
  };
  const onDown = (ev: KeyboardEvent) => {
    if (ev.key === "Alt" && !ev.ctrlKey && !ev.metaKey && !ev.isComposing && pending === null) {
      pending = setTimeout(() => {
        pending = null;
        document.body.classList.add("shortcut-guide");
      }, 1314);
    } else if (ev.ctrlKey || ev.metaKey || ev.key === "AltGraph") {
      hide();
    }
  };
  const onUp = (ev: KeyboardEvent) => {
    if (ev.key === "Alt" || !ev.altKey) hide();
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
