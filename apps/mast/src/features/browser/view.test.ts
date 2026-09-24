// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const api = vi.hoisted(() => ({invoke: vi.fn(), listen: vi.fn()}));
vi.mock("@tauri-apps/api/core", () => ({invoke: api.invoke}));
vi.mock("@tauri-apps/api/event", () => ({listen: api.listen}));
import { BrowserView } from "./view";
import { applyBrowserSettings } from "./settings";

describe("disabled browser restoration", () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); });
  afterEach(() => applyBrowserSettings({browser: {enabled: true}}));
  it("preserves the URL without starting a webview, event subscription or observer", () => {
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    applyBrowserSettings({browser: {enabled: false}});
    const view = new BrowserView(document.body, 42, {type: "browser", url: "https://example.com/"});
    view.update({type: "browser", url: "https://example.com/"});
    expect(view.root.textContent).toContain("https://example.com/");
    expect(api.invoke).not.toHaveBeenCalled();
    expect(api.listen).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    view.dispose();
    expect(api.invoke).not.toHaveBeenCalled();
    observe.mockRestore();
  });
});

describe("browser surface lifetime", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
  it("hides a pending surface when a dialog opens before mounting finishes", async () => {
    vi.clearAllMocks();
    api.listen.mockResolvedValue(() => {});
    applyBrowserSettings({browser: {enabled: true}});
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({x: 0, y: 100, width: 800, height: 500} as DOMRect);
    let mounted!: (value: null) => void;
    api.invoke.mockImplementationOnce(() => new Promise(resolve => { mounted = resolve; })).mockResolvedValue(null);
    const view = new BrowserView(document.body, 42, {type: "browser", url: "http://localhost:3000"});
    try {
      frame!(0);
      await Promise.resolve();
      expect(api.invoke).toHaveBeenCalledTimes(1);
      const dialog = document.createElement("dialog");
      dialog.setAttribute("open", "");
      document.body.append(dialog);
      window.dispatchEvent(new Event("resize"));
      frame!(1);
      mounted(null);
      await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith("browser_surface", expect.objectContaining({tab: 42, bounds: null})));
    } finally { view.dispose(); }
  });
});
