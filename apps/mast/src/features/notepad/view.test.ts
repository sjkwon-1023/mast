// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infrastructure/backend", () => ({
  fsListDir: vi.fn(async () => ({ entries: [], truncated: false })),
  detachTerminal: vi.fn(async () => undefined),
  notesRead: vi.fn(async () => ""),
  notesSave: vi.fn(async () => ({ type: "saved" })),
}));

import type {
  NoteScope,
  NotepadDraftBackup,
  SaveOutcome,
  StateSnapshot,
  Tab,
  Workspace,
} from "../../shared/types";
import { NOTEPAD_DRAFT_KEY } from "../../shared/types";
import { createNotepadState, NOTEPAD_SAVE_DELAY_MS, type NotepadIpc } from "./state";
import { createNotepadFeature } from "./view";
import type { NotepadFeature, NotepadHost } from "./view";
import { SwitchTracer } from "../workspace/switch-trace";
import { WorkspaceView } from "../workspace/workspace-view";
import { reportMarkdownDraftState } from "../viewers/markdown/drafts";
import type { MarkdownDraftState } from "../viewers/markdown/drafts";

const ws = (id: number): NoteScope => ({ type: "workspace", workspace: id });
const globalScope: NoteScope = { type: "global" };

const scopeKey = (scope: NoteScope): string =>
  scope.type === "global" ? "global" : `ws:${scope.workspace}`;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface SaveCall {
  scope: NoteScope;
  expected: string;
  content: string;
  result: Deferred<SaveOutcome>;
}

function makeBackend(files: Record<string, string> = {}) {
  const disk = new Map(Object.entries(files));
  const reads: NoteScope[] = [];
  const saves: SaveCall[] = [];
  const ipc: NotepadIpc = {
    read: vi.fn(async (scope: NoteScope) => {
      reads.push(scope);
      return disk.get(scopeKey(scope)) ?? "";
    }),
    save: vi.fn((scope: NoteScope, expected: string, content: string) => {
      const result = deferred<SaveOutcome>();
      saves.push({ scope, expected, content, result });
      return result.promise;
    }),
  };
  return { ipc, reads, saves, disk };
}

function workspace(id: number): Workspace {
  return {
    id,
    name: `ws${id}`,
    rootPath: "/tmp",
    distro: null,
    gitBranch: null,
    gitDirty: null,
    layout: { type: "leaf", pane: id },
    panes: { [String(id)]: { id, tabs: [], activeTab: null } },
    activePane: id,
    viewerPane: null,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
}

function snapshot(active: number | null, ids: number[]): StateSnapshot {
  return {
    revision: 1,
    state: { revision: 1, nextId: 20, activeWorkspace: active, workspaces: ids.map(workspace) },
  };
}

function folderSnapshot(revision = 1): StateSnapshot {
  const tab: Tab = {
    id: 10,
    title: "folder",
    kind: { type: "folderBrowser", path: "/tmp" },
    notification: "none",
    lastActivityMs: null,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
  return {
    revision,
    state: {
      revision,
      nextId: 20,
      activeWorkspace: 1,
      workspaces: [
        {
          ...workspace(1),
          panes: { "1": { id: 1, tabs: [tab], activeTab: 10 } },
        },
      ],
    },
  };
}

function makeHost(initial: StateSnapshot | null, extra: Partial<NotepadHost> = {}) {
  let current = initial;
  const host: NotepadHost = {
    getSnapshot: () => current,
    focusActivePane: vi.fn(),
    ...extra,
  };
  return { host, setSnapshot: (next: StateSnapshot | null) => { current = next; } };
}

function putBackup(backup: NotepadDraftBackup): void {
  sessionStorage.setItem(NOTEPAD_DRAFT_KEY, JSON.stringify(backup));
}

const dialog = (): HTMLDialogElement | null =>
  document.querySelector<HTMLDialogElement>("dialog.notepad-drawer");
const textarea = (): HTMLTextAreaElement | null =>
  dialog()?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
const button = (label: string): HTMLButtonElement | null =>
  Array.from(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (item) => item.textContent === label,
  ) ?? null;
const errorText = (): string => dialog()?.querySelector(".notepad-error")?.textContent ?? "";

function type(value: string): void {
  const area = textarea();
  if (area === null) throw new Error("notepad textarea is not open");
  area.value = value;
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

let feature: NotepadFeature | null = null;

function start(host: NotepadHost, ipc: NotepadIpc) {
  const state = createNotepadState({ ipc });
  feature = createNotepadFeature(host, state);
  return { state, feature };
}

beforeEach(() => {
  sessionStorage.clear();
  document.body.replaceChildren();
});

afterEach(async () => {
  await feature?.close().catch(() => undefined);
  feature = null;
  sessionStorage.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("열기와 범위", () => {
  it("현재 워크스페이스 메모를 읽어 textarea에 표시하고 포커스를 준다", async () => {
    const backend = makeBackend({ "ws:1": "hello" });
    const { host } = makeHost(snapshot(1, [1]));
    start(host, backend.ipc);

    await feature!.toggle();

    expect(backend.reads).toEqual([ws(1)]);
    expect(dialog()?.getAttribute("aria-label")).toBe("Notepad");
    expect(textarea()?.value).toBe("hello");
    expect(textarea()?.disabled).toBe(false);
    expect(textarea()?.dataset.keepFocus).toBe("");
    expect(document.activeElement).toBe(textarea());
    expect(button("This workspace")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Global")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("다시 토글하면 flush 뒤 dialog와 textarea를 제거한다", async () => {
    const backend = makeBackend({ "ws:1": "hello" });
    const { host } = makeHost(snapshot(1, [1]));
    const { state } = start(host, backend.ipc);
    await feature!.toggle();

    await feature!.toggle();

    expect(dialog()).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
    expect(state.isActive()).toBe(false);
  });

  it("워크스페이스가 0개면 Global로 열고 This workspace를 비활성화한다", async () => {
    const backend = makeBackend({ global: "shared" });
    const { host } = makeHost(snapshot(null, []));
    start(host, backend.ipc);

    await feature!.toggle();

    expect(backend.reads).toEqual([globalScope]);
    expect(textarea()?.value).toBe("shared");
    expect(button("This workspace")?.disabled).toBe(true);
    expect(button("Global")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("snapshot이 아직 없으면 서랍을 만들지 않는다 — 범위 확정 전 편집 금지", async () => {
    const backend = makeBackend();
    const { host } = makeHost(null);
    start(host, backend.ipc);

    await feature!.toggle();

    expect(dialog()).toBeNull();
    expect(backend.reads).toEqual([]);
  });

  it("범위 전환이 성공하면 새 메모를 읽어 본문과 버튼을 바꾼다", async () => {
    const backend = makeBackend({ "ws:1": "mine", global: "shared" });
    const { host } = makeHost(snapshot(1, [1]));
    const { state } = start(host, backend.ipc);
    await feature!.toggle();

    button("Global")!.click();

    await vi.waitFor(() => expect(textarea()?.value).toBe("shared"));
    expect(backend.reads).toEqual([ws(1), globalScope]);
    expect(state.getSnapshot().scope).toEqual(globalScope);
    expect(button("Global")?.getAttribute("aria-pressed")).toBe("true");

    button("This workspace")!.click();
    await vi.waitFor(() => expect(textarea()?.value).toBe("mine"));
    expect(state.getSnapshot().scope).toEqual(ws(1));
  });

  it("범위 전환 실패는 기존 범위와 본문을 유지하고 오류를 보여 준다", async () => {
    const backend = makeBackend({ "ws:1": "mine" });
    const { host } = makeHost(snapshot(1, [1]));
    const { state } = start(host, backend.ipc);
    await feature!.toggle();
    vi.mocked(backend.ipc.read).mockImplementationOnce(async (scope) => {
      backend.reads.push(scope);
      throw new Error("permission denied");
    });

    button("Global")!.click();

    await vi.waitFor(() => expect(errorText()).toContain("The note could not be loaded."));
    expect(errorText()).toContain("permission denied");
    expect(textarea()?.value).toBe("mine");
    expect(state.getSnapshot().scope).toEqual(ws(1));
    expect(button("This workspace")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("로딩 실패는 서랍을 열어 둔 채 오류를 보여 주고 편집을 막는다", async () => {
    const backend = makeBackend();
    vi.mocked(backend.ipc.read).mockImplementationOnce(async (scope) => {
      backend.reads.push(scope);
      throw new Error("permission denied");
    });
    const { host } = makeHost(snapshot(1, [1]));
    const { state } = start(host, backend.ipc);

    await feature!.toggle();

    expect(dialog()).not.toBeNull();
    expect(errorText()).toContain("The note could not be loaded.");
    expect(textarea()?.disabled).toBe(true);
    expect(state.getSnapshot().scope).toBeNull();
  });

  it("첫 읽기가 정착하기 전에는 범위 버튼을 비활성화한다", async () => {
    const backend = makeBackend();
    const read = deferred<string>();
    vi.mocked(backend.ipc.read).mockImplementationOnce(async (scope) => {
      backend.reads.push(scope);
      return read.promise;
    });
    const { host } = makeHost(snapshot(1, [1]));
    start(host, backend.ipc);

    const opening = feature!.toggle();
    await vi.waitFor(() => expect(backend.reads).toHaveLength(1));
    expect(button("This workspace")?.disabled).toBe(true);
    expect(button("Global")?.disabled).toBe(true);

    read.resolve("base");
    await opening;

    expect(button("This workspace")?.disabled).toBe(false);
    expect(button("Global")?.disabled).toBe(false);
    expect(textarea()?.disabled).toBe(false);
  });

  it("로딩 중 닫으면 dialog·textarea를 즉시 제거하고 늦은 read 결과를 버린다", async () => {
    const backend = makeBackend();
    const read = deferred<string>();
    vi.mocked(backend.ipc.read).mockImplementationOnce(async (scope) => {
      backend.reads.push(scope);
      return read.promise;
    });
    const { host } = makeHost(snapshot(1, [1]));
    const { state } = start(host, backend.ipc);

    const opening = feature!.toggle();
    await vi.waitFor(() => expect(backend.reads).toHaveLength(1));
    button("Close")!.click();
    expect(dialog()).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();

    read.resolve("late");
    await opening;

    // 늦게 도착한 읽기가 세션·DOM을 되살리지 않는다.
    expect(dialog()).toBeNull();
    expect(state.isActive()).toBe(false);
    expect(textarea()).toBeNull();
  });
});

describe("닫기와 포커스", () => {
  it("Esc는 flush 뒤 닫고 IME 조합 중 Escape는 무시한다", async () => {
    const backend = makeBackend();
    const { host } = makeHost(snapshot(1, [1]));
    start(host, backend.ipc);
    await feature!.toggle();
    const area = textarea()!;

    const composing = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composing, "isComposing", { value: true });
    area.dispatchEvent(composing);
    expect(dialog()).not.toBeNull();

    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("flush 실패 시 서랍을 닫지 않고, 오류 해소 뒤 다시 닫을 수 있다", async () => {
    const backend = makeBackend();
    const { host } = makeHost(snapshot(1, [1]));
    const { state } = start(host, backend.ipc);
    await feature!.toggle();
    type("draft");
    vi.mocked(backend.ipc.save).mockRejectedValueOnce(new Error("disk full"));

    button("Close")!.click();

    await vi.waitFor(() => expect(errorText()).toContain("The note could not be saved."));
    expect(dialog()).not.toBeNull();
    expect(textarea()?.value).toBe("draft");
    expect(state.getSnapshot().dirty).toBe(true);

    vi.mocked(backend.ipc.save).mockResolvedValueOnce({ type: "saved" });
    await feature!.close();
    expect(dialog()).toBeNull();
  });

  it("닫으면 직전 포커스로 돌아간다", async () => {
    const backend = makeBackend();
    const { host } = makeHost(snapshot(1, [1]));
    start(host, backend.ipc);
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.append(outside);
    outside.focus();

    await feature!.toggle();
    expect(document.activeElement).toBe(textarea());
    await feature!.close();

    expect(document.activeElement).toBe(outside);
    expect(host.focusActivePane).not.toHaveBeenCalled();
  });

  it("직전 포커스가 사라졌거나 워크스페이스가 바뀌면 activePane 보상으로 돌아간다", async () => {
    const backend = makeBackend();
    const { host, setSnapshot } = makeHost(snapshot(1, [1]));
    start(host, backend.ipc);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await feature!.toggle();

    outside.remove();
    setSnapshot(snapshot(2, [1, 2]));
    await feature!.close();

    expect(host.focusActivePane).toHaveBeenCalledOnce();
  });

  it("로딩 중 Close 는 정상 닫기와 같이 직전 포커스로 돌아간다", async () => {
    const backend = makeBackend();
    const read = deferred<string>();
    vi.mocked(backend.ipc.read).mockImplementationOnce(async (scope) => {
      backend.reads.push(scope);
      return read.promise;
    });
    const { host } = makeHost(snapshot(1, [1]));
    const { state } = start(host, backend.ipc);
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.append(outside);
    outside.focus();

    const opening = feature!.toggle();
    await vi.waitFor(() => expect(backend.reads).toHaveLength(1));
    button("Close")!.click();

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(host.focusActivePane).not.toHaveBeenCalled();

    read.resolve("late");
    await opening;
    expect(state.isActive()).toBe(false);
  });

  it("snapshot 갱신 중에도 textarea 포커스를 유지한다", async () => {
    const backend = makeBackend();
    const { host } = makeHost(snapshot(1, [1]));
    start(host, backend.ipc);
    vi.useFakeTimers();
    await feature!.toggle();
    const area = textarea()!;
    expect(document.activeElement).toBe(area);

    type("abc");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    expect(backend.saves).toHaveLength(1);
    backend.saves[0].result.resolve({ type: "saved" });
    await vi.advanceTimersByTimeAsync(0);

    // state 알림으로 다시 그려도 포커스를 옮기지 않는다.
    expect(document.activeElement).toBe(area);
    expect(area.dataset.keepFocus).toBe("");
  });
});

describe("워크스페이스 전환 (M2)", () => {
  it("전환이 성공하면 같은 서랍에서 새 워크스페이스 메모를 보여 준다", async () => {
    const backend = makeBackend({ "ws:1": "one", "ws:2": "two" });
    const { host, setSnapshot } = makeHost(snapshot(1, [1, 2]));
    const { state } = start(host, backend.ipc);
    await feature!.toggle();
    expect(textarea()?.value).toBe("one");

    setSnapshot(snapshot(2, [1, 2]));
    feature!.sync(snapshot(2, [1, 2]));

    await vi.waitFor(() => expect(textarea()?.value).toBe("two"));
    expect(state.getSnapshot().scope).toEqual(ws(2));
    expect(backend.reads).toEqual([ws(1), ws(2)]);
    expect(button("This workspace")?.getAttribute("aria-pressed")).toBe("true");

    // "This workspace" 대상도 현재 active 로 갱신된다.
    button("Global")!.click();
    await vi.waitFor(() => expect(state.getSnapshot().scope).toEqual(globalScope));
    button("This workspace")!.click();
    await vi.waitFor(() => expect(backend.reads).toHaveLength(4));
    expect(backend.reads.at(-1)).toEqual(ws(2));
  });

  it("flush 실패는 이전 scope 를 유지하고 머리에 그 워크스페이스 이름을 표시한다", async () => {
    const backend = makeBackend({ "ws:1": "one", "ws:2": "two" });
    const { host, setSnapshot } = makeHost(snapshot(1, [1, 2]));
    const { state } = start(host, backend.ipc);
    await feature!.toggle();
    type("draft");
    vi.mocked(backend.ipc.save).mockRejectedValueOnce(new Error("disk full"));

    setSnapshot(snapshot(2, [1, 2]));
    feature!.sync(snapshot(2, [1, 2]));

    await vi.waitFor(() => expect(errorText()).toContain("could not be saved"));
    expect(state.getSnapshot().scope).toEqual(ws(1));
    expect(textarea()?.value).toBe("draft");
    expect(backend.reads).toEqual([ws(1)]);
    const label = dialog()?.querySelector<HTMLElement>(".notepad-workspace");
    expect(label?.hidden).toBe(false);
    expect(label?.textContent).toContain("ws1");

    // afterEach 의 close 가 재시도 flush 에서 멈추지 않게 저장을 성공시킨다.
    vi.mocked(backend.ipc.save).mockResolvedValue({ type: "saved" });
    await feature!.close();
  });

  it("첫 읽기 중 워크스페이스가 바뀌면 정착 뒤 최신 워크스페이스 메모로 맞춘다", async () => {
    const backend = makeBackend({ "ws:1": "one", "ws:2": "two" });
    const read = deferred<string>();
    vi.mocked(backend.ipc.read).mockImplementationOnce(async (scope) => {
      backend.reads.push(scope);
      return read.promise;
    });
    const { host, setSnapshot } = makeHost(snapshot(1, [1, 2]));
    const { state } = start(host, backend.ipc);

    const opening = feature!.toggle();
    await vi.waitFor(() => expect(backend.reads).toEqual([ws(1)]));

    setSnapshot(snapshot(2, [1, 2]));
    feature!.sync(snapshot(2, [1, 2]));
    await Promise.resolve();

    read.resolve("one");
    await opening;

    expect(backend.reads).toEqual([ws(1), ws(2)]);
    expect(state.getSnapshot().scope).toEqual(ws(2));
    expect(textarea()?.value).toBe("two");
  });

  it("첫 읽기 중 연속으로 바뀐 워크스페이스도 보정 읽기 뒤 끝까지 따라간다", async () => {
    const backend = makeBackend({ "ws:1": "one", "ws:2": "two", "ws:3": "three" });
    const reads = [deferred<string>(), deferred<string>()];
    let index = 0;
    vi.mocked(backend.ipc.read).mockImplementation(async (scope) => {
      backend.reads.push(scope);
      const pending = reads[index];
      index += 1;
      return pending === undefined ? backend.disk.get(scopeKey(scope)) ?? "" : pending.promise;
    });
    const { host, setSnapshot } = makeHost(snapshot(1, [1, 2, 3]));
    const { state } = start(host, backend.ipc);

    const opening = feature!.toggle();
    await vi.waitFor(() => expect(backend.reads).toEqual([ws(1)]));

    // A 읽기 중 B — 첫 정착 뒤 B 를 따라간다.
    setSnapshot(snapshot(2, [1, 2, 3]));
    feature!.sync(snapshot(2, [1, 2, 3]));
    await Promise.resolve();
    reads[0].resolve("one");
    await vi.waitFor(() => expect(backend.reads).toEqual([ws(1), ws(2)]));

    // B 보정 읽기 중 C — B 가 끝난 뒤 다시 C 를 따라가야 한다.
    setSnapshot(snapshot(3, [1, 2, 3]));
    feature!.sync(snapshot(3, [1, 2, 3]));
    await Promise.resolve();
    reads[1].resolve("two");
    await opening;

    expect(backend.reads).toEqual([ws(1), ws(2), ws(3)]);
    expect(state.getSnapshot().scope).toEqual(ws(3));
    expect(textarea()?.value).toBe("three");
  });

  it("첫 열기의 보정 읽기 중 토글로 취소하면 숨은 세션 없이 다시 열 수 있다", async () => {
    const backend = makeBackend({ "ws:1": "one", "ws:2": "two", "ws:3": "three" });
    const reads = [deferred<string>(), deferred<string>()];
    let index = 0;
    vi.mocked(backend.ipc.read).mockImplementation(async (scope) => {
      backend.reads.push(scope);
      const pending = reads[index];
      index += 1;
      return pending === undefined ? backend.disk.get(scopeKey(scope)) ?? "" : pending.promise;
    });
    const { host, setSnapshot } = makeHost(snapshot(1, [1, 2, 3]));
    const { state } = start(host, backend.ipc);

    const opening = feature!.toggle();
    await vi.waitFor(() => expect(backend.reads).toEqual([ws(1)]));

    // A 첫 읽기 중 B 로 전환 — A 정착 뒤 B 보정 읽기가 시작된다.
    setSnapshot(snapshot(2, [1, 2, 3]));
    feature!.sync(snapshot(2, [1, 2, 3]));
    await Promise.resolve();
    reads[0].resolve("one");
    await vi.waitFor(() => expect(backend.reads).toEqual([ws(1), ws(2)]));

    // B 보정 읽기 중 토글 — 취소는 DOM 만 거두고, 늦게 정착한 세션은 열기 task 가 정리한다.
    await feature!.toggle();
    expect(dialog()).toBeNull();

    reads[1].resolve("two");
    await opening;

    expect(dialog()).toBeNull();
    expect(state.getSnapshot()).toMatchObject({ scope: null, text: "" });
    expect(state.isActive()).toBe(false);

    // 숨은 세션이 없으므로 C 를 다시 열어 정상으로 읽는다.
    setSnapshot(snapshot(3, [1, 2, 3]));
    await feature!.toggle();
    await vi.waitFor(() => expect(textarea()?.value).toBe("three"));
    expect(state.getSnapshot().scope).toEqual(ws(3));
  });

  it("수동 범위 전환 읽기 중 active workspace 가 바뀌면 최신 워크스페이스로 맞춘다", async () => {
    const backend = makeBackend({ "ws:1": "one", "ws:2": "two", global: "shared" });
    const { host, setSnapshot } = makeHost(snapshot(1, [1, 2]));
    const { state } = start(host, backend.ipc);
    await feature!.toggle();
    button("Global")!.click();
    await vi.waitFor(() => expect(textarea()?.value).toBe("shared"));

    const read = deferred<string>();
    vi.mocked(backend.ipc.read).mockImplementationOnce(async (scope) => {
      backend.reads.push(scope);
      return read.promise;
    });

    button("This workspace")!.click();
    await vi.waitFor(() => expect(backend.reads.at(-1)).toEqual(ws(1)));

    setSnapshot(snapshot(2, [1, 2]));
    feature!.sync(snapshot(2, [1, 2]));

    read.resolve("one");
    await vi.waitFor(() => expect(textarea()?.value).toBe("two"));
    expect(state.getSnapshot().scope).toEqual(ws(2));
  });

  it("수동 범위 전환 보정에서도 연속 전환을 끝까지 따라간다", async () => {
    const backend = makeBackend({ "ws:1": "one", "ws:2": "two", "ws:3": "three", global: "shared" });
    const { host, setSnapshot } = makeHost(snapshot(1, [1, 2, 3]));
    const { state } = start(host, backend.ipc);
    await feature!.toggle();
    button("Global")!.click();
    await vi.waitFor(() => expect(textarea()?.value).toBe("shared"));

    const reads = [deferred<string>(), deferred<string>()];
    let index = 0;
    vi.mocked(backend.ipc.read).mockImplementation(async (scope) => {
      backend.reads.push(scope);
      const pending = reads[index];
      index += 1;
      return pending === undefined ? backend.disk.get(scopeKey(scope)) ?? "" : pending.promise;
    });

    // Global → This workspace 읽기 중 B.
    button("This workspace")!.click();
    await vi.waitFor(() => expect(backend.reads.at(-1)).toEqual(ws(1)));
    setSnapshot(snapshot(2, [1, 2, 3]));
    feature!.sync(snapshot(2, [1, 2, 3]));
    await Promise.resolve();
    reads[0].resolve("one");
    await vi.waitFor(() => expect(backend.reads.at(-1)).toEqual(ws(2)));

    // 보정 B 읽기 중 C.
    setSnapshot(snapshot(3, [1, 2, 3]));
    feature!.sync(snapshot(3, [1, 2, 3]));
    await Promise.resolve();
    reads[1].resolve("two");

    await vi.waitFor(() => expect(textarea()?.value).toBe("three"));
    expect(backend.reads).toEqual([ws(1), globalScope, ws(1), ws(2), ws(3)]);
    expect(state.getSnapshot().scope).toEqual(ws(3));
  });

  it("Global 을 보는 동안에는 워크스페이스 전환을 따라가지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "one", global: "shared" });
    const { host, setSnapshot } = makeHost(snapshot(1, [1, 2]));
    const { state } = start(host, backend.ipc);
    await feature!.toggle();
    button("Global")!.click();
    await vi.waitFor(() => expect(textarea()?.value).toBe("shared"));
    const reads = backend.reads.length;

    setSnapshot(snapshot(2, [1, 2]));
    feature!.sync(snapshot(2, [1, 2]));
    await Promise.resolve();

    expect(backend.reads).toHaveLength(reads);
    expect(state.getSnapshot().scope).toEqual(globalScope);
    expect(textarea()?.value).toBe("shared");
  });

  it("외부 snapshot 으로 열린 scope 가 사라지면 저장하지 않고 서랍을 닫는다", async () => {
    const backend = makeBackend({ "ws:1": "one" });
    const { host, setSnapshot } = makeHost(snapshot(1, [1, 2]));
    const { state } = start(host, backend.ipc);
    await feature!.toggle();

    setSnapshot(snapshot(2, [2]));
    feature!.sync(snapshot(2, [2]));

    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(document.querySelector("textarea")).toBeNull();
    expect(state.isActive()).toBe(false);
    expect(backend.saves).toHaveLength(0);
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });

  it("이전 scope 의 입력은 새 워크스페이스가 아니라 그 scope 로 저장된다", async () => {
    const backend = makeBackend({ "ws:1": "one", "ws:2": "two" });
    const { host, setSnapshot } = makeHost(snapshot(1, [1, 2]));
    start(host, backend.ipc);
    await feature!.toggle();
    type("old");

    setSnapshot(snapshot(2, [1, 2]));
    feature!.sync(snapshot(2, [1, 2]));
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    expect(backend.saves[0]).toMatchObject({ scope: ws(1), expected: "one", content: "old" });

    backend.saves[0].result.resolve({ type: "saved" });
    await vi.waitFor(() => expect(textarea()?.value).toBe("two"));

    type("new");
    await vi.waitFor(() => expect(backend.saves).toHaveLength(2));
    expect(backend.saves[1]).toMatchObject({ scope: ws(2), expected: "two", content: "new" });
    backend.saves[1].result.resolve({ type: "saved" });
    await vi.waitFor(() => expect(errorText()).toBe(""));
  });
});

describe("복구 실패 뒤의 서랍 (C5 §4)", () => {
  it("미완료 백업의 scope 로 열어 초안과 오류를 보여 준다", async () => {
    const backend = makeBackend({ "ws:1": "", "ws:2": "base" });
    putBackup({ scope: ws(2), base: "base", text: "draft" });
    const { host } = makeHost(snapshot(1, [1, 2]));
    const { state } = start(host, backend.ipc);

    void state.recover();
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.reject(new Error("disk full"));
    await vi.waitFor(() => expect(state.getSnapshot().error).toContain("could not be saved"));

    await feature!.toggle();

    expect(backend.reads).toEqual([ws(2)]);
    expect(state.getSnapshot().scope).toEqual(ws(2));
    expect(textarea()?.value).toBe("draft");
    expect(errorText()).toContain("could not be saved");
    const label = dialog()?.querySelector<HTMLElement>(".notepad-workspace");
    expect(label?.textContent).toContain("ws2");

    // afterEach 의 close 가 재시도 flush 에서 멈추지 않게 저장을 성공시킨다.
    vi.mocked(backend.ipc.save).mockResolvedValue({ type: "saved" });
    await feature!.close();
  });

  it("복구 읽기가 실패하면 백업 scope 로 열어 초안과 오류를 보여 준다", async () => {
    const backend = makeBackend({ "ws:1": "", "ws:2": "base" });
    putBackup({ scope: ws(2), base: "base", text: "draft" });
    vi.mocked(backend.ipc.read).mockImplementation(async (scope) => {
      backend.reads.push(scope);
      throw new Error("unknown workspace");
    });
    const { host } = makeHost(snapshot(1, [1, 2]));
    const { state } = start(host, backend.ipc);

    await state.recover();
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toContain("draft");

    await feature!.toggle();

    expect(backend.reads).toEqual([ws(2), ws(2)]);
    expect(state.getSnapshot().scope).toBeNull();
    expect(textarea()?.value).toBe("draft");
    expect(textarea()?.disabled).toBe(true);
    expect(errorText()).toContain("The note could not be loaded.");
    const label = dialog()?.querySelector<HTMLElement>(".notepad-workspace");
    expect(label?.textContent).toContain("ws2");
  });
});

describe("macOS dirty 보고 (M1)", () => {
  it("서랍 열기는 보고 전달이 끝난 뒤에야 편집을 연다", async () => {
    const backend = makeBackend({ "ws:1": "one" });
    const report = deferred<void>();
    const { host } = makeHost(snapshot(1, [1]), {
      awaitDirtyReport: () => report.promise,
      refreshDirtyReport: () => undefined,
    });
    start(host, backend.ipc);

    const opening = feature!.toggle();
    await vi.waitFor(() => expect(textarea()).not.toBeNull());
    expect(textarea()?.disabled).toBe(true);

    report.resolve(undefined);
    await opening;

    expect(textarea()?.disabled).toBe(false);
    expect(document.activeElement).toBe(textarea());
  });

  it("보고 전달이 실패하면 편집을 열지 않고 영어 오류를 보여 준다", async () => {
    const backend = makeBackend({ "ws:1": "one" });
    const { host } = makeHost(snapshot(1, [1]), {
      awaitDirtyReport: () => Promise.reject(new Error("ipc down")),
      refreshDirtyReport: () => undefined,
    });
    start(host, backend.ipc);

    await feature!.toggle();

    expect(textarea()?.disabled).toBe(true);
    expect(errorText()).toContain("could not report the unsaved note state");
  });

  it("보고가 회복되면 현재 범위 버튼 재시도로 차단과 오류를 해제한다", async () => {
    const backend = makeBackend({ "ws:1": "one" });
    let reportCalls = 0;
    const awaitDirtyReport = vi.fn(async () => {
      reportCalls += 1;
      if (reportCalls === 1) throw new Error("ipc down");
    });
    const { host } = makeHost(snapshot(1, [1]), {
      awaitDirtyReport,
      refreshDirtyReport: () => undefined,
    });
    const { state } = start(host, backend.ipc);

    await feature!.toggle();
    expect(textarea()?.disabled).toBe(true);
    expect(errorText()).toContain("could not report the unsaved note state");

    button("This workspace")!.click();

    await vi.waitFor(() => expect(textarea()?.disabled).toBe(false));
    expect(awaitDirtyReport).toHaveBeenCalledTimes(2);
    expect(errorText()).toBe("");
    expect(state.getSnapshot().scope).toEqual(ws(1));
  });

  it("첫 읽기 실패 뒤 범위 버튼 재시도도 보고 전달 뒤에 편집을 연다", async () => {
    const backend = makeBackend({ "ws:1": "one" });
    vi.mocked(backend.ipc.read).mockRejectedValueOnce(new Error("permission denied"));
    const report = deferred<void>();
    const { host } = makeHost(snapshot(1, [1]), {
      awaitDirtyReport: () => report.promise,
      refreshDirtyReport: () => undefined,
    });
    const { state } = start(host, backend.ipc);

    await feature!.toggle();
    expect(errorText()).toContain("The note could not be loaded.");
    expect(textarea()?.disabled).toBe(true);

    button("This workspace")!.click();
    await vi.waitFor(() => expect(state.getSnapshot().scope).toEqual(ws(1)));
    expect(textarea()?.disabled).toBe(true);

    report.resolve(undefined);
    await vi.waitFor(() => expect(textarea()?.disabled).toBe(false));
    expect(textarea()?.value).toBe("one");
  });

  it("서랍을 열면 dirty, 닫고 flush 하면 Clean 을 보고한다", async () => {
    const backend = makeBackend({ "ws:1": "one" });
    const sent: MarkdownDraftState[] = [];
    let stateRef: ReturnType<typeof createNotepadState> | null = null;
    const reporter = reportMarkdownDraftState(
      async (state) => {
        sent.push(state);
      },
      window,
      { isExtraDirty: () => stateRef?.isActive() === true },
    );
    const { host } = makeHost(snapshot(1, [1]), {
      awaitDirtyReport: () => reporter.waitForDelivery(),
      refreshDirtyReport: () => reporter.refresh(),
    });
    const started = start(host, backend.ipc);
    stateRef = started.state;

    await feature!.toggle();
    await vi.waitFor(() => expect(sent.at(-1)).toBe("dirty"));

    await feature!.close();
    await vi.waitFor(() => expect(sent.at(-1)).toBe("clean"));
    reporter.dispose();
  });
});

describe("기존 레이아웃 계약", () => {
  it("WorkspaceView 렌더가 data-keep-focus textarea의 포커스를 빼앗지 않는다", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const wsView = new WorkspaceView(root, async () => null, new SwitchTracer(() => undefined));
    const initial = folderSnapshot();
    wsView.render(initial);
    const backend = makeBackend({ "ws:1": "note" });
    const { host } = makeHost(initial);
    start(host, backend.ipc);
    await feature!.toggle();
    const area = textarea()!;
    expect(document.activeElement).toBe(area);

    wsView.requestFocus({ kind: "activePane" });
    wsView.render({ ...initial, revision: initial.revision + 1 });
    await Promise.resolve();

    expect(document.activeElement).toBe(area);
  });

  it("서랍은 #view 밖 body에 붙어 pane 컨테이너를 건드리지 않는다", async () => {
    const viewRoot = document.createElement("div");
    viewRoot.id = "view";
    document.body.append(viewRoot);
    const backend = makeBackend({ "ws:1": "note" });
    const { host } = makeHost(snapshot(1, [1]));
    start(host, backend.ipc);

    await feature!.toggle();

    expect(dialog()?.parentElement).toBe(document.body);
    expect(viewRoot.childElementCount).toBe(0);
    expect(viewRoot.getAttribute("style")).toBeNull();
  });
});
