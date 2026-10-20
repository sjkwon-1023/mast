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
      await Promise.resolve();
      await Promise.resolve();
      expect((view as unknown as {attached: boolean}).attached).toBe(false);
    } finally { view.dispose(); }
  });

  it("hides the surface for an open notepad dialog and restores the same bounds after close", async () => {
    vi.clearAllMocks();
    api.listen.mockResolvedValue(() => {});
    applyBrowserSettings({browser: {enabled: true}});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const bounds = {x: 0, y: 100, width: 800, height: 500};
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({...bounds} as DOMRect);
    api.invoke.mockResolvedValue(null);
    const view = new BrowserView(document.body, 42, {type: "browser", url: "http://localhost:3000"});
    const runFrame = () => frames.shift()?.(0);
    const dialog = document.createElement("dialog");
    dialog.className = "notepad-drawer";
    try {
      runFrame();
      await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith("browser_surface", {tab: 42, owner: expect.any(String), bounds}));

      document.body.append(dialog);
      dialog.setAttribute("open", "");
      // open 속성 변화는 MutationObserver 가 관측해 숨김 동기화를 예약한다.
      await vi.waitFor(() => expect(frames.length).toBe(1));
      runFrame();
      await vi.waitFor(() => expect(api.invoke).toHaveBeenLastCalledWith("browser_surface", {tab: 42, owner: expect.any(String), bounds: null}));

      dialog.removeAttribute("open");
      dialog.remove();
      await vi.waitFor(() => expect(frames.length).toBe(1));
      runFrame();
      await vi.waitFor(() => expect(api.invoke).toHaveBeenLastCalledWith("browser_surface", {tab: 42, owner: expect.any(String), bounds}));
    } finally { view.dispose(); }
  });

  it("sends hide before a bounds update waiting behind an earlier surface call", async () => {
    vi.clearAllMocks();
    api.listen.mockResolvedValue(() => {});
    applyBrowserSettings({browser: {enabled: true}});
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    let width = 800;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({x: 0, y: 100, width, height: 500} as DOMRect));
    let mounted!: (value: null) => void;
    api.invoke.mockImplementationOnce(() => new Promise(resolve => { mounted = resolve; })).mockResolvedValue(null);
    const view = new BrowserView(document.body, 42, {type: "browser", url: "http://localhost:3000"});
    try {
      frame!(0);
      await Promise.resolve();
      width = 900;
      window.dispatchEvent(new Event("resize"));
      frame!(1);
      const dialog = document.createElement("dialog");
      dialog.setAttribute("open", "");
      document.body.append(dialog);
      window.dispatchEvent(new Event("resize"));
      frame!(2);
      expect(api.invoke).toHaveBeenCalledTimes(2);
      expect(api.invoke).toHaveBeenNthCalledWith(2, "browser_surface", expect.objectContaining({tab: 42, bounds: null}));
      mounted(null);
      await Promise.resolve();
      await Promise.resolve();
      expect(api.invoke).toHaveBeenCalledTimes(2);
    } finally { view.dispose(); }
  });

  it("retries a failed hide on the next surface sync", async () => {
    vi.clearAllMocks();
    api.listen.mockResolvedValue(() => {});
    applyBrowserSettings({browser: {enabled: true}});
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({x: 0, y: 100, width: 800, height: 500} as DOMRect);
    let hidden = false;
    vi.spyOn(document, "querySelector").mockImplementation(selector => selector === "dialog[open]" && hidden ? ({} as Element) : null);
    api.invoke.mockResolvedValue(null);
    const view = new BrowserView(document.body, 42, {type: "browser", url: "http://localhost:3000"});
    const sync = (view as unknown as {sync: () => void}).sync.bind(view);
    try {
      sync();
      await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect((view as unknown as {attached: boolean}).attached).toBe(true));
      api.invoke.mockRejectedValueOnce(new Error("hide failed"));
      hidden = true;
      sync();
      await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(view.root.querySelector(".browser-status")?.textContent).toBe("hide failed"));
      sync();
      await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(3));
    } finally { view.dispose(); }
  });

  it("shows again at the same bounds after a failed hide", async () => {
    vi.clearAllMocks();
    api.listen.mockResolvedValue(() => {});
    applyBrowserSettings({browser: {enabled: true}});
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({x: 0, y: 100, width: 800, height: 500} as DOMRect);
    let hidden = false;
    vi.spyOn(document, "querySelector").mockImplementation(selector => selector === "dialog[open]" && hidden ? ({} as Element) : null);
    api.invoke.mockResolvedValue(null);
    const view = new BrowserView(document.body, 42, {type: "browser", url: "http://localhost:3000"});
    const sync = (view as unknown as {sync: () => void}).sync.bind(view);
    const bounds = {x: 0, y: 100, width: 800, height: 500};
    try {
      sync();
      await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1));
      api.invoke.mockRejectedValueOnce(new Error("hide failed"));
      hidden = true;
      sync();
      await vi.waitFor(() => expect(view.root.querySelector(".browser-status")?.textContent).toBe("hide failed"));
      hidden = false;
      sync();
      await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(3));
      expect(api.invoke).toHaveBeenLastCalledWith("browser_surface", {tab: 42, owner: expect.any(String), bounds});
    } finally { view.dispose(); }
  });

  it("does not show an error when an obsolete surface revision fails", async () => {
    vi.clearAllMocks();
    api.listen.mockResolvedValue(() => {});
    applyBrowserSettings({browser: {enabled: true}});
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({x: 0, y: 100, width: 800, height: 500} as DOMRect);
    let hidden = false;
    vi.spyOn(document, "querySelector").mockImplementation(selector => selector === "dialog[open]" && hidden ? ({} as Element) : null);
    let rejectShow!: (reason: Error) => void;
    api.invoke.mockImplementationOnce(() => new Promise((_, reject) => { rejectShow = reject; })).mockResolvedValue(null);
    const view = new BrowserView(document.body, 42, {type: "browser", url: "http://localhost:3000"});
    const sync = (view as unknown as {sync: () => void}).sync.bind(view);
    try {
      sync();
      await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1));
      hidden = true;
      sync();
      await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2));
      rejectShow(new Error("obsolete show failed"));
      await Promise.resolve();
      await Promise.resolve();
      expect(view.root.querySelector<HTMLElement>(".browser-status")?.hidden).toBe(true);
    } finally { view.dispose(); }
  });
});
