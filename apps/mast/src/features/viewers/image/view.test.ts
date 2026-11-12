// @vitest-environment happy-dom
//
// imageViewer 뷰의 실제 동작을 잠근다. happy-dom 에는 레이아웃과 실제 이미지
// 디코딩이 없으므로 backend IPC(fsStat·fsReadChunk), URL.createObjectURL/
// revokeObjectURL, <img> 의 load·error 이벤트 시점만 대체한다. 그 위에서 확인하는
// 것은 이 청크의 완료 조건 그대로다: 상한·청크 읽기·MIME·loading·모드 전환·오류·
// 같은 path 무재읽기·dispose 뒤 늦은 결과 폐기·flushScroll no-op.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMAGE_CHUNK_BYTES, IMAGE_MAX_BYTES, ImageView } from "./view";
import type { ViewerKind } from "../viewer-view";

interface FileStat {
  size: number;
  mtime_ms: number;
  is_dir: boolean;
}

interface ReadCall {
  offset: number;
  len: number;
}

/** backend 대역 — 테스트마다 beforeEach 가 갈아 끼운다. */
const backend = vi.hoisted(() => ({
  stat: { size: 0, mtime_ms: 0, is_dir: false } as FileStat,
  statImpl: null as null | (() => Promise<FileStat>),
  readImpl: null as null | ((offset: number, len: number) => Promise<ArrayBuffer>),
  statCalls: 0,
  reads: [] as ReadCall[],
}));

vi.mock("../../../infrastructure/backend", () => ({
  fsStat: () => {
    backend.statCalls += 1;
    if (backend.statImpl !== null) return backend.statImpl();
    return Promise.resolve(backend.stat);
  },
  fsReadChunk: (_distro: string | null, _path: string, offset: number, len: number) => {
    backend.reads.push({ offset, len });
    if (backend.readImpl !== null) return backend.readImpl(offset, len);
    return Promise.resolve(new ArrayBuffer(0));
  },
}));

/** createObjectURL 이 만든 URL·Blob 과 revoke 된 URL. */
let created: { url: string; blob: Blob }[];
let revoked: string[];
let urlSeq = 0;

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  backend.stat = { size: 0, mtime_ms: 0, is_dir: false };
  backend.statImpl = null;
  backend.readImpl = null;
  backend.statCalls = 0;
  backend.reads = [];
  created = [];
  revoked = [];
  urlSeq = 0;

  // happy-dom 의 Blob 디코딩·object URL 구현에 기대지 않고 관찰 가능한 값만 잠근다.
  URL.createObjectURL = ((blob: Blob) => {
    urlSeq += 1;
    const url = `blob:mock/${urlSeq}`;
    created.push({ url, blob });
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  document.body.replaceChildren();
});

/** 즉시 resolve 되는 mock promise 체인을 끝까지 흘려보낸다. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(path = "/shots/a.png", distro: string | null = null): {
  view: ImageView;
  parent: HTMLDivElement;
} {
  const parent = document.createElement("div");
  document.body.append(parent);
  const kind: ViewerKind = { type: "imageViewer", path };
  return { view: new ImageView(parent, distro, kind), parent };
}

function button(view: ImageView): HTMLButtonElement {
  const el = view.root.querySelector<HTMLButtonElement>("button.image-toggle");
  if (el === null) throw new Error("toggle button missing");
  return el;
}

function imageEl(view: ImageView): HTMLImageElement {
  const el = view.root.querySelector<HTMLImageElement>("img.image-canvas");
  if (el === null) throw new Error("image missing");
  return el;
}

function status(constructed: ImageView): { text: string; hidden: boolean; error: boolean } {
  const el = constructed.root.querySelector<HTMLElement>(".image-status");
  if (el === null) throw new Error("status missing");
  return { text: el.textContent ?? "", hidden: el.hidden, error: el.classList.contains("error") };
}

function modeLabel(view: ImageView): string {
  return view.root.querySelector(".image-mode")?.textContent ?? "";
}

/** 작은 파일 하나를 읽고 load 까지 끝낸 뷰. */
async function loadedView(path = "/shots/a.png"): Promise<{ view: ImageView; parent: HTMLDivElement }> {
  backend.stat = { size: 4, mtime_ms: 0, is_dir: false };
  backend.readImpl = () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
  const mounted = mount(path);
  await settle();
  imageEl(mounted.view).dispatchEvent(new Event("load"));
  await settle();
  return mounted;
}

describe("상한과 읽기 진입", () => {
  it("디렉터리는 fsReadChunk 를 부르지 않고 오류를 보인다", async () => {
    backend.stat = { size: 1, mtime_ms: 0, is_dir: true };
    const { view } = mount();
    await settle();

    expect(backend.reads).toEqual([]);
    expect(created).toEqual([]);
    expect(status(view).text).toContain("it is a directory");
    expect(status(view).error).toBe(true);
  });

  it("stat 실패는 본문을 읽지 않고 원인 문구를 보인다", async () => {
    backend.statImpl = () => Promise.reject(new Error("permission denied"));
    const { view } = mount();
    await settle();

    expect(backend.reads).toEqual([]);
    expect(created).toEqual([]);
    expect(status(view).text).toContain("permission denied");
    expect(status(view).error).toBe(true);
  });

  it("64MiB 초과는 fsReadChunk 를 부르지 않고 상한 문구를 보인다", async () => {
    backend.stat = { size: IMAGE_MAX_BYTES + 1, mtime_ms: 0, is_dir: false };
    const { view } = mount();
    await settle();

    expect(backend.reads).toEqual([]);
    expect(created).toEqual([]);
    expect(status(view).text).toBe("Image file exceeds the 64 MiB limit");
  });

  it("정확히 64MiB 는 읽기로 넘어간다", async () => {
    backend.stat = { size: IMAGE_MAX_BYTES, mtime_ms: 0, is_dir: false };
    const { view } = mount();
    await settle();

    expect(backend.reads.length).toBeGreaterThan(0);
    expect(status(view).text).not.toBe("Image file exceeds the 64 MiB limit");
  });
});

describe("청크 읽기", () => {
  it("4MiB 보다 큰 파일은 요청마다 4MiB 이하로 offset 을 이어 간다", async () => {
    const bytes = new Uint8Array(IMAGE_CHUNK_BYTES + 1234);
    backend.stat = { size: bytes.length, mtime_ms: 0, is_dir: false };
    backend.readImpl = (offset, len) =>
      Promise.resolve(bytes.slice(offset, offset + len).buffer as ArrayBuffer);
    mount();
    await settle();

    expect(backend.reads).toEqual([
      { offset: 0, len: IMAGE_CHUNK_BYTES },
      { offset: IMAGE_CHUNK_BYTES, len: IMAGE_CHUNK_BYTES },
    ]);
    expect(created).toHaveLength(1);
  });

  it("빈 응답에서 읽기가 끝난다", async () => {
    backend.stat = { size: 10, mtime_ms: 0, is_dir: false };
    mount();
    await settle();

    expect(backend.reads).toEqual([{ offset: 0, len: IMAGE_CHUNK_BYTES }]);
    expect(created).toHaveLength(1);
  });

  it("누적이 64MiB 를 넘으면 초과 오류로 끝나고 Blob URL 을 만들지 않는다", async () => {
    backend.stat = { size: 0, mtime_ms: 0, is_dir: false };
    const fullChunk = new ArrayBuffer(IMAGE_CHUNK_BYTES);
    backend.readImpl = () => Promise.resolve(fullChunk);
    const { view } = mount();
    await settle();

    expect(backend.reads.length).toBe(Math.floor(IMAGE_MAX_BYTES / IMAGE_CHUNK_BYTES) + 1);
    expect(status(view).text).toBe("Image file exceeds the 64 MiB limit");
    expect(created).toEqual([]);
  });
});

describe("Blob MIME", () => {
  it.each([
    ["/shots/a.png", "image/png"],
    ["/shots/a.PNG", "image/png"],
    ["/shots/a.jpg", "image/jpeg"],
    ["/shots/a.JPEG", "image/jpeg"],
    ["/shots/a.Gif", "image/gif"],
    ["/shots/a.webp", "image/webp"],
    ["/shots/a.BMP", "image/bmp"],
    ["/shots/a.svg", ""],
    ["/shots/a.png.txt", ""],
    ["/shots/.png", ""],
  ])("%s → %s", async (path, expected) => {
    backend.stat = { size: 4, mtime_ms: 0, is_dir: false };
    backend.readImpl = () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
    mount(path);
    await settle();

    expect(created).toHaveLength(1);
    expect(created[0].blob.type).toBe(expected);
  });
});

describe("loading 과 맞춤/원본", () => {
  it("load 전에는 loading 이고 버튼이 꺼져 있으며 load 뒤 맞춤에서 전환된다", async () => {
    backend.stat = { size: 4, mtime_ms: 0, is_dir: false };
    backend.readImpl = () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
    const { view } = mount();
    await settle();

    const btn = button(view);
    expect(btn).toBeInstanceOf(HTMLButtonElement);
    expect(btn.disabled).toBe(true);
    expect(status(view).text).toBe("loading…");
    expect(status(view).hidden).toBe(false);
    expect(imageEl(view).getAttribute("src")).toBe(created[0].url);

    // 클릭은 load 전에 아무 것도 바꾸지 않는다.
    btn.click();
    expect(modeLabel(view)).toBe("Fit");

    imageEl(view).dispatchEvent(new Event("load"));

    expect(btn.disabled).toBe(false);
    expect(status(view).hidden).toBe(true);
    expect(modeLabel(view)).toBe("Fit");
    expect(view.root.classList.contains("original")).toBe(false);

    btn.click();
    expect(modeLabel(view)).toBe("Original");
    expect(view.root.classList.contains("original")).toBe(true);

    btn.click();
    expect(modeLabel(view)).toBe("Fit");
    expect(view.root.classList.contains("original")).toBe(false);
  });

  it("모드를 바꾸면 스크롤이 원점으로 돌아간다", async () => {
    const { view } = await loadedView();
    const scroll = view.root.querySelector<HTMLElement>(".image-scroll");
    if (scroll === null) throw new Error("scroll missing");

    scroll.scrollTop = 120;
    scroll.scrollLeft = 80;
    button(view).click();

    expect(scroll.scrollTop).toBe(0);
    expect(scroll.scrollLeft).toBe(0);
  });
});

describe("오류", () => {
  it("<img> error 는 Cannot decode image 로 끝나고 URL 을 revoke 한다", async () => {
    backend.stat = { size: 4, mtime_ms: 0, is_dir: false };
    backend.readImpl = () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
    const { view, parent } = mount();
    await settle();
    const url = created[0].url;
    expect(status(view).text).toBe("loading…");

    imageEl(view).dispatchEvent(new Event("error"));

    expect(status(view).text).toBe("Cannot decode image");
    expect(status(view).error).toBe(true);
    expect(revoked).toContain(url);
    expect(imageEl(view).hasAttribute("src")).toBe(false);
    expect(button(view).disabled).toBe(true);
    expect(parent.contains(view.root)).toBe(true);
  });

  it("fsReadChunk 거부는 원인 문구와 함께 보인다", async () => {
    backend.stat = { size: 4, mtime_ms: 0, is_dir: false };
    backend.readImpl = () => Promise.reject(new Error("EIO"));
    const { view } = mount();
    await settle();

    expect(status(view).text).toContain("EIO");
    expect(status(view).error).toBe(true);
    expect(created).toEqual([]);
  });
});

describe("path 수명", () => {
  it("같은 path 의 update 는 다시 읽지 않는다", async () => {
    const { view } = await loadedView();
    expect(backend.statCalls).toBe(1);
    expect(backend.reads).toHaveLength(1);
    expect(created).toHaveLength(1);

    view.update({ type: "imageViewer", path: "/shots/a.png" });
    await settle();

    expect(backend.statCalls).toBe(1);
    expect(backend.reads).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it("path 가 바뀌면 이전 URL 을 revoke 하고 맞춤으로 다시 읽는다", async () => {
    const { view } = await loadedView();
    const firstUrl = created[0].url;
    button(view).click();
    expect(modeLabel(view)).toBe("Original");

    view.update({ type: "imageViewer", path: "/shots/b.png" });
    await settle();

    expect(revoked).toContain(firstUrl);
    expect(modeLabel(view)).toBe("Fit");
    expect(button(view).disabled).toBe(true);
    expect(backend.statCalls).toBe(2);

    imageEl(view).dispatchEvent(new Event("load"));
    await settle();
    expect(created).toHaveLength(2);
    expect(imageEl(view).getAttribute("src")).toBe(created[1].url);
  });
});

describe("dispose 뒤 늦은 결과", () => {
  it("stat 대기 중 dispose 하면 청크 요청도 URL 생성도 없다", async () => {
    const stat = deferred<FileStat>();
    backend.statImpl = () => stat.promise;
    const { view, parent } = mount();
    await settle();

    view.dispose();
    stat.resolve({ size: 4, mtime_ms: 0, is_dir: false });
    await settle();

    expect(backend.reads).toEqual([]);
    expect(created).toEqual([]);
    expect(parent.contains(view.root)).toBe(false);
  });

  it("청크 사이에 dispose 하면 다음 청크 요청과 DOM 갱신이 없다", async () => {
    const second = deferred<ArrayBuffer>();
    let calls = 0;
    backend.stat = { size: IMAGE_CHUNK_BYTES * 2, mtime_ms: 0, is_dir: false };
    backend.readImpl = () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new ArrayBuffer(IMAGE_CHUNK_BYTES));
      return second.promise;
    };
    const { view } = mount();
    await settle();

    expect(backend.reads).toHaveLength(2);
    // 두 번째 요청이 아직 돌아오지 않았어도 이미 받은 청크는 dispose 가 바로 놓는다.
    const held = (): number => (view as unknown as { parts: unknown[] }).parts.length;
    expect(held()).toBe(1);
    view.dispose();
    expect(held()).toBe(0);
    second.resolve(new ArrayBuffer(IMAGE_CHUNK_BYTES));
    await settle();

    expect(backend.reads).toHaveLength(2);
    expect(created).toEqual([]);
    expect(held()).toBe(0);
  });

  it("load 대기 중 dispose 하면 URL 을 revoke 하고 늦은 load 를 무시한다", async () => {
    backend.stat = { size: 4, mtime_ms: 0, is_dir: false };
    backend.readImpl = () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
    const { view, parent } = mount();
    await settle();
    const url = created[0].url;

    view.dispose();
    expect(revoked).toContain(url);
    expect(parent.contains(view.root)).toBe(false);

    imageEl(view).dispatchEvent(new Event("load"));
    await settle();
    expect(created).toHaveLength(1);
    expect(status(view).text).toBe("loading…");
  });

  it("dispose 뒤 타이머가 남지 않는다", async () => {
    vi.useFakeTimers();
    try {
      backend.stat = { size: 4, mtime_ms: 0, is_dir: false };
      const { view } = mount();
      await settle();
      view.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("flushScroll", () => {
  it("dispatch 도 다시 읽기도 하지 않는다", async () => {
    const { view } = await loadedView();
    const statCalls = backend.statCalls;
    const reads = backend.reads.length;

    view.flushScroll();
    await settle();

    expect(backend.statCalls).toBe(statCalls);
    expect(backend.reads).toHaveLength(reads);
    expect(revoked).toEqual([]);
  });
});
