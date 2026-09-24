import type { UiSettings } from "../../infrastructure/backend";

let enabled = true;
export function applyBrowserSettings(settings: Pick<UiSettings, "browser">): void {
  enabled = settings.browser?.enabled ?? true;
  document.body.classList.toggle("browser-disabled", !enabled);
}
export function browserEnabled(): boolean { return enabled; }
