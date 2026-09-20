// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyViewerView } from "./lazy-view";
import type { ViewerKind, ViewerView } from "./viewer-view";

const initial: ViewerKind = { type: "folderBrowser", path: "/first" };

function setup() {
  const parent = document.createElement("div");
  document.body.append(parent);
  const root = document.createElement("div");
  const child: ViewerView = {
    root,
    update: vi.fn(),
    flushScroll: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(() => root.remove()),
  };
  const create = vi.fn((host: HTMLElement, _kind: ViewerKind): ViewerView => {
    host.append(root);
    return child;
  });
  let resolve!: (factory: typeof create) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<typeof create>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const view = new LazyViewerView(parent, initial, () => pending);
  return { parent, child, create, resolve, reject, view };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("LazyViewerView", () => {
  it("로딩 중 변경된 경로로 생성하고 이후 갱신과 정리를 전달한다", async () => {
    const h = setup();
    const latest: ViewerKind = { type: "folderBrowser", path: "/latest" };
    h.view.update(latest);
    h.view.flushScroll();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.child.flushScroll).not.toHaveBeenCalled();
    h.resolve(h.create);
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledWith(h.parent, latest);
    expect([...h.parent.children]).toEqual([h.child.root]);
    expect(h.view.root).toBe(h.child.root);
    h.view.update(initial);
    h.view.flushScroll();
    h.view.dispose();
    h.view.dispose();
    expect(h.child.update).toHaveBeenCalledWith(initial);
    expect(h.child.flushScroll).toHaveBeenCalledOnce();
    expect(h.child.dispose).toHaveBeenCalledOnce();
    expect(h.parent.children).toHaveLength(0);
  });

  it("로딩 중 닫힌 탭에서는 뷰어를 생성하지 않는다", async () => {
    const h = setup();
    h.view.dispose();
    h.resolve(h.create);
    await Promise.resolve();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.parent.children).toHaveLength(0);
  });

  it("로딩 화면이 포커스를 유지하면 완성된 뷰어로 넘긴다", async () => {
    const h = setup();
    h.view.focus();
    expect(document.activeElement).toBe(h.view.root);
    h.resolve(h.create);
    await Promise.resolve();
    expect(h.child.focus).toHaveBeenCalledOnce();
  });

  it("사용자가 다른 곳으로 이동하면 포커스를 빼앗지 않는다", async () => {
    const h = setup();
    h.view.focus();
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    h.resolve(h.create);
    await Promise.resolve();
    expect(h.child.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
  });

  it("로딩 실패를 표시하고 다시 열린 탭은 새 로드를 시작한다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = setup();
    h.reject(new Error("unavailable"));
    await Promise.resolve();
    expect(h.view.root.textContent).toContain("cannot load viewer: Error: unavailable");
    h.view.dispose();
    const reopened = new LazyViewerView(h.parent, initial, async () => h.create);
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledOnce();
    reopened.dispose();
  });

  it("닫힌 탭의 로딩 실패는 화면에 남기지 않는다", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = setup();
    h.view.dispose();
    h.reject(new Error("unavailable"));
    await Promise.resolve();
    expect(error).not.toHaveBeenCalled();
    expect(h.parent.children).toHaveLength(0);
  });
});
