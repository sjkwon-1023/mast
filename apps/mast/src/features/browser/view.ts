import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "../../infrastructure/backend";
import type { ViewerKind, ViewerView } from "../viewers/viewer-view";
import { isWindowHidden, onWindowHiddenChange } from "../../infrastructure/window-visibility";
import { browserEnabled } from "./settings";

interface Page { tab: number; url: string; title: string; loading: boolean; error: string | null }
let nextOwner = 0;
export class BrowserView implements ViewerView {
  readonly root = document.createElement("div");
  private readonly content = document.createElement("div");
  private readonly address = document.createElement("input");
  private readonly status = document.createElement("span");
  private readonly owner = `${Date.now()}-${++nextOwner}`;
  private disposed = false;
  private frame = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private observer: ResizeObserver | null = null;
  private dialogs: MutationObserver | null = null;
  private unlisten: (() => void) | null = null;
  private unlistenFocus: (() => void) | null = null;
  private attached = false;
  private lastBounds: string | null = null;
  private unwatchWindow: (() => void) | null = null;

  constructor(parent: HTMLElement, private readonly tab: number, kind: ViewerKind) {
    const url = kind.type === "browser" ? kind.url : "";
    this.root.className = "browser-view";
    parent.append(this.root);
    if (!browserEnabled()) {
      this.root.textContent = `Browser is disabled in settings. Saved URL: ${url || "(empty tab)"}`;
      return;
    }
    const toolbar = document.createElement("form");
    toolbar.className = "browser-toolbar";
    this.address.type = "url";
    this.address.placeholder = "http://localhost:3000";
    this.address.setAttribute("aria-label", "Browser address");
    this.address.value = url;
    for (const [label, action] of [["←", "back"], ["→", "forward"], ["↻", "reload"], ["✕", "stop"]]) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = label; button.title = action;
      button.addEventListener("click", () => this.request(action));
      toolbar.append(button);
    }
    toolbar.append(this.address);
    const go = document.createElement("button"); go.textContent = "Go"; toolbar.append(go);
    const external = document.createElement("button"); external.type = "button"; external.textContent = "↗"; external.title = "Open in external browser";
    external.addEventListener("click", () => { void openUrl(this.address.value).catch(e => this.showError(e)); });
    toolbar.append(external);
    toolbar.addEventListener("submit", e => { e.preventDefault(); this.request("navigate", this.address.value); });
    this.content.className = "browser-content";
    this.status.className = "browser-status";
    this.status.setAttribute("role", "status");
    this.root.append(toolbar, this.status, this.content);
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(this.content);
    this.dialogs = new MutationObserver(() => this.schedule());
    this.dialogs.observe(document.body, {subtree: true, attributes: true, attributeFilter: ["open"]});
    document.addEventListener("visibilitychange", this.schedule);
    window.addEventListener("resize", this.schedule);
    void listen<Page>("browser-changed", ({payload}) => {
      if (payload.tab !== tab || this.disposed) return;
      if (document.activeElement !== this.address) this.address.value = payload.url;
      this.status.textContent = payload.error ?? (payload.loading ? "Loading…" : payload.title);
    }).then(unlisten => { if (this.disposed) unlisten(); else this.unlisten = unlisten; }).catch(e => this.showError(e));
    void listen<number>("browser-address-focus", ({payload}) => { if (payload === tab) { this.address.focus(); this.address.select(); } })
      .then(stop => { if (this.disposed) stop(); else this.unlistenFocus = stop; }).catch(e => this.showError(e));
    this.unwatchWindow = onWindowHiddenChange(this.schedule);
    this.schedule();
  }
  private showError(error: unknown): void {
    if (!this.disposed) this.status.textContent = typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
  }
  private request(action: string, url?: string): void {
    void this.chain.then(() => invoke("browser_request", {request: {action, tab: this.tab, url}})).catch(e => this.showError(e));
  }
  private schedule = (): void => {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.sync(); });
  };
  private sync(): void {
    const rect = this.content.getBoundingClientRect();
    const visible = !isWindowHidden() && !document.hidden && !document.querySelector("dialog[open]") && rect.width >= 1 && rect.height >= 1;
    if (!visible && !this.attached && this.lastBounds === null) return;
    const bounds = visible ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null;
    const signature = JSON.stringify(bounds);
    if (signature === this.lastBounds) return;
    this.lastBounds = signature;
    this.chain = this.chain.then(async () => {
      if (this.disposed) return;
      const page = await invoke<Page | null>("browser_surface", {tab: this.tab, owner: this.owner, bounds});
      this.attached = visible;
      if (page && !this.disposed) {
        if (document.activeElement !== this.address) this.address.value = page.url;
        this.status.textContent = page.error ?? (page.loading ? "Loading…" : page.title);
      }
    }).catch(e => { this.lastBounds = null; this.showError(e); });
  }
  update(kind: ViewerKind): void {
    if (kind.type === "browser" && document.activeElement !== this.address) this.address.value = kind.url;
    if (browserEnabled()) this.schedule();
  }
  flushScroll(): void {}
  focus(): void { this.address.focus(); }
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect(); this.dialogs?.disconnect(); this.unlisten?.(); this.unlistenFocus?.(); this.unwatchWindow?.();
    document.removeEventListener("visibilitychange", this.schedule);
    window.removeEventListener("resize", this.schedule);
    if (browserEnabled()) void this.chain.then(() => invoke("browser_surface", {tab: this.tab, owner: this.owner, bounds: null})).catch(e => console.error("browser hide failed", e));
    this.root.remove();
  }
}
