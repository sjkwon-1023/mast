// @vitest-environment happy-dom
//
// 정상 종료·수동 리로드 경계 — 실제 등록 콜백(onCloseRequested 대역)과 실제 keydown
// 이벤트로 flush 순서·재진입·실패 보존을 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTEPAD_DRAFT_KEY,
  type NoteScope,
  type NotepadDraftBackup,
  type SaveOutcome,
  type StateSnapshot,
  type Workspace,
  type WorkspaceId,
} from "../shared/types";
import { createNotepadState, type NotepadIpc } from "../features/notepad/state";
import { createNotepadFeature } from "../features/notepad/view";
import type { NotepadHost } from "../features/notepad/view";
import {
  createNotepadLifecycle,
  NOTE_QUIT_CONFIRM,
  QUIT_CONFIRM,
  type CloseEventLike,
  type NotepadLifecycleDeps,
} from "./lifecycle";

const ws = (id: WorkspaceId): NoteScope => ({ type: "workspace", workspace: id });

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

function putBackup(backup: NotepadDraftBackup): void {
  sessionStorage.setItem(NOTEPAD_DRAFT_KEY, JSON.stringify(backup));
}

function event(): CloseEventLike & { preventDefault: () => void } {
  return { preventDefault: vi.fn(() => undefined) };
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
    agentStatus: "idle",
    lastAgentMessage: null,
  };
}

function notepadSnapshot(active: number, ids: number[]): StateSnapshot {
  return {
    revision: 1,
    state: { revision: 1, nextId: 20, activeWorkspace: active, workspaces: ids.map(workspace) },
  };
}

interface Harness {
  lifecycle: ReturnType<typeof createNotepadLifecycle>;
  deps: {
    confirm: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    markdown: { value: boolean };
    loads: { count: number };
  };
  state: ReturnType<typeof createNotepadState>;
}

function makeHarness(backend: ReturnType<typeof makeBackend>, options: {
  attach?: boolean;
} = {}): Harness {
  const state = createNotepadState({ ipc: backend.ipc });
  const deps = {
    confirm: vi.fn(async (_message: string) => true),
    showError: vi.fn((_error: unknown) => {}),
    reload: vi.fn(() => {}),
    markdown: { value: false },
    loads: { count: 0 },
  };
  const lifecycleDeps: NotepadLifecycleDeps = {
    confirm: (message) => deps.confirm(message),
    hasMarkdownDrafts: () => deps.markdown.value,
    showError: (err) => deps.showError(err),
    reload: () => deps.reload(),
    loadState: async () => {
      deps.loads.count += 1;
      return state;
    },
  };
  const lifecycle = createNotepadLifecycle(lifecycleDeps);
  if (options.attach !== false) lifecycle.attachState(state);
  return { lifecycle, deps, state };
}

beforeEach(() => {
  sessionStorage.clear();
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
  document.body.replaceChildren();
});

describe("정상 종료 (onCloseRequested)", () => {
  it("진행 중 flush 가 끝날 때까지 close 를 보류하고 성공하면 확인 없이 닫는다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");
    const closeEvent = event();

    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();

    backend.saves[0].result.resolve({ type: "saved" });
    await closing;

    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });

  it("연속 close 는 진행 중인 flush 와 겹치지 않고 두 번째를 막는다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");

    const first = event();
    const second = event();
    const closing = lifecycle.handleClose(first);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    await lifecycle.handleClose(second);

    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(backend.saves).toHaveLength(1);

    backend.saves[0].result.resolve({ type: "saved" });
    await closing;
    expect(first.preventDefault).not.toHaveBeenCalled();
  });

  it("flush 실패를 확인하면 초안을 버리는 확인 한 번 뒤 닫는다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");

    const closeEvent = event();
    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.reject(new Error("disk full"));
    await closing;

    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.confirm.mock.calls[0][0]).toContain(NOTE_QUIT_CONFIRM);
    expect(deps.confirm.mock.calls[0][0]).toContain("disk full");
    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it("flush 를 시작하기 전에 메모 입력을 동결하고 종료가 진행되면 유지한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, state } = makeHarness(backend);
    const host: NotepadHost = {
      getSnapshot: () => notepadSnapshot(1, [1]),
      focusActivePane: () => {},
    };
    const feature = createNotepadFeature(host, state);
    await feature.toggle();
    const area = document.querySelector<HTMLTextAreaElement>("textarea.notepad-text")!;
    area.value = "draft";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    expect(area.disabled).toBe(false);

    const closeEvent = event();
    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    expect(area.disabled).toBe(true);

    // 동결 중 입력은 거부되고 textarea 는 마지막 수락 본문으로 돌아간다.
    area.value = "late";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.getSnapshot().text).toBe("draft");
    expect(area.value).toBe("draft");
    expect(state.acceptText("later")).toBe(false);

    backend.saves[0].result.resolve({ type: "saved" });
    await closing;

    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    expect(state.getSnapshot().frozen).toBe(true);
    expect(area.disabled).toBe(true);

    await feature.close().catch(() => undefined);
  });

  it("flush 실패로 종료를 취소하면 동결을 풀고 다시 입력할 수 있다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    const host: NotepadHost = {
      getSnapshot: () => notepadSnapshot(1, [1]),
      focusActivePane: () => {},
    };
    const feature = createNotepadFeature(host, state);
    await feature.toggle();
    const area = document.querySelector<HTMLTextAreaElement>("textarea.notepad-text")!;
    area.value = "draft";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    deps.confirm.mockResolvedValueOnce(false);

    const closeEvent = event();
    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    expect(area.disabled).toBe(true);

    backend.saves[0].result.reject(new Error("disk full"));
    await closing;

    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(state.getSnapshot().frozen).toBe(false);
    expect(area.disabled).toBe(false);

    area.value = "after";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.getSnapshot().text).toBe("after");

    vi.mocked(backend.ipc.save).mockResolvedValue({ type: "saved" });
    await feature.close();
  });

  it("state 가 연결되기 전에 종료를 시작해도 늦게 연결된 state 가 동결되고 취소 뒤 해제된다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    putBackup({ scope: ws(1), base: "base", text: "draft" });
    const state = createNotepadState({ ipc: backend.ipc });
    const load = deferred<ReturnType<typeof createNotepadState>>();
    const confirm = vi.fn(async (_message: string) => false);
    const lifecycle = createNotepadLifecycle({
      confirm,
      hasMarkdownDrafts: () => false,
      showError: () => {},
      reload: () => {},
      loadState: async () => load.promise,
    });

    const closeEvent = event();
    const closing = lifecycle.handleClose(closeEvent);
    // state 가 없는 채로 동결이 먼저 걸리고, flush 는 모듈 로드를 기다린다.
    lifecycle.attachState(state);
    expect(state.getSnapshot().frozen).toBe(true);

    load.resolve(state);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    expect(state.getSnapshot().frozen).toBe(true);
    expect(state.acceptText("late")).toBe(false);

    backend.saves[0].result.reject(new Error("disk full"));
    await closing;

    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(state.getSnapshot().frozen).toBe(false);
    expect(state.acceptText("after")).toBe(true);
    state.dispose();
  });

  it("flush 실패를 취소하면 종료를 막고 오류·초안을 보존한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");
    deps.confirm.mockResolvedValueOnce(false);

    const closeEvent = event();
    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.reject(new Error("disk full"));
    await closing;

    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.showError).toHaveBeenCalledTimes(1);
    expect(state.getSnapshot().text).toBe("draft");
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toContain("draft");
  });

  it("flush 실패 뒤 확인 창을 띄우지 못하면 종료를 막고 초안을 보존한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");
    deps.confirm.mockRejectedValueOnce(new Error("dialog unavailable"));

    const closeEvent = event();
    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.reject(new Error("disk full"));
    await closing;

    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.showError).toHaveBeenCalledTimes(1);
    expect(state.getSnapshot().text).toBe("draft");
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toContain("draft");
  });

  it("flush 실패와 Markdown draft 가 있으면 메모 확인 뒤 Markdown 확인을 거친다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");
    deps.markdown.value = true;

    const closeEvent = event();
    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.reject(new Error("disk full"));
    await closing;

    const messages = deps.confirm.mock.calls.map(([message]) => message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(NOTE_QUIT_CONFIRM);
    expect(messages[0]).toContain("disk full");
    expect(messages[1]).toBe(QUIT_CONFIRM);
    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("메모 flush 뒤 Markdown 확인을 취소하면 닫지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");
    deps.markdown.value = true;
    deps.confirm.mockResolvedValueOnce(false);
    const closeEvent = event();

    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.resolve({ type: "saved" });
    await closing;

    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("Markdown 이 없으면 메모만으로 확인 창을 띄우지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("note only");
    const closeEvent = event();

    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.resolve({ type: "saved" });
    await closing;

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("모듈이 로드되지 않았고 백업도 없으면 state 모듈을 읽지 않는다", async () => {
    const backend = makeBackend();
    const { lifecycle, deps } = makeHarness(backend, { attach: false });
    const closeEvent = event();

    await lifecycle.handleClose(closeEvent);

    expect(deps.loads.count).toBe(0);
    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("백업만 있는 부팅 직후 close 도 복구·flush 를 마친 뒤 닫는다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    putBackup({ scope: ws(1), base: "base", text: "draft" });
    const state = createNotepadState({ ipc: backend.ipc });
    let loads = 0;
    const lifecycle = createNotepadLifecycle({
      confirm: async () => true,
      hasMarkdownDrafts: () => false,
      showError: () => {},
      reload: () => {},
      loadState: async () => {
        loads += 1;
        return state;
      },
    });

    const closeEvent = event();
    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.resolve({ type: "saved" });
    await closing;

    expect(loads).toBe(1);
    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });
});

describe("수동 리로드", () => {
  function reloadTarget(): {
    target: Pick<Window, "addEventListener">;
    dispatch: (init: KeyboardEventInit) => boolean;
  } {
    const events = new EventTarget();
    return {
      target: events as unknown as Pick<Window, "addEventListener">,
      dispatch: (init) =>
        events.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })),
    };
  }

  it("리로드 키는 flush 가 끝난 뒤에만 reload 한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");
    const { target, dispatch } = reloadTarget();
    lifecycle.installReloadKey(target);

    dispatch({ ctrlKey: true, shiftKey: true, code: "KeyR" });
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    expect(deps.reload).not.toHaveBeenCalled();

    backend.saves[0].result.resolve({ type: "saved" });
    await vi.waitFor(() => expect(deps.reload).toHaveBeenCalledTimes(1));
  });

  it("리로드 키도 flush 전에 메모 입력을 동결한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");
    const { target, dispatch } = reloadTarget();
    lifecycle.installReloadKey(target);

    dispatch({ ctrlKey: true, shiftKey: true, code: "KeyR" });
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));

    expect(state.getSnapshot().frozen).toBe(true);
    expect(state.acceptText("late")).toBe(false);

    backend.saves[0].result.resolve({ type: "saved" });
    await vi.waitFor(() => expect(deps.reload).toHaveBeenCalledTimes(1));
    expect(state.getSnapshot().frozen).toBe(true);
  });

  it("리로드 flush 실패에도 reload 하고 백업을 보존한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { target, dispatch } = reloadTarget();
    lifecycle.installReloadKey(target);

    dispatch({ ctrlKey: true, shiftKey: true, code: "KeyR" });
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.reject(new Error("disk full"));
    await vi.waitFor(() => expect(deps.reload).toHaveBeenCalledTimes(1));

    expect(deps.showError).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(state.getSnapshot().text).toBe("draft");
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toContain("draft");
  });

  it("window.__mast.reload 경로도 같은 flush 를 수행한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");

    const reloading = lifecycle.reload();
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    expect(deps.reload).not.toHaveBeenCalled();
    backend.saves[0].result.resolve({ type: "saved" });
    await reloading;
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it("window.__mast.reload 경로도 flush 실패 시 reload 한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const reloading = lifecycle.reload();
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.reject(new Error("disk full"));
    await reloading;

    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(deps.showError).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toContain("draft");
  });

  it("Markdown 확인을 거부하면 flush 이후에도 리로드하지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, deps, state } = makeHarness(backend);
    await state.open(ws(1));
    deps.markdown.value = true;
    deps.confirm.mockResolvedValueOnce(false);
    const { target, dispatch } = reloadTarget();
    lifecycle.installReloadKey(target);

    dispatch({ ctrlKey: true, shiftKey: true, code: "KeyR" });
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(deps.reload).not.toHaveBeenCalled();
  });
});

describe("부팅 복구", () => {
  it("첫 snapshot 전 백업을 복구·저장하고 세션을 정리한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    putBackup({ scope: ws(1), base: "base", text: "draft" });
    const state = createNotepadState({ ipc: backend.ipc });
    let loads = 0;
    const lifecycle = createNotepadLifecycle({
      confirm: async () => true,
      hasMarkdownDrafts: () => false,
      showError: () => {},
      reload: () => {},
      loadState: async () => {
        loads += 1;
        return state;
      },
    });

    const recovering = lifecycle.recover();
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.resolve({ type: "saved" });
    await recovering;

    expect(loads).toBe(1);
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
    expect(state.isActive()).toBe(false);
  });

  it("복구 저장 실패는 백업과 열린 세션(오류)을 보존한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    putBackup({ scope: ws(1), base: "base", text: "draft" });
    const state = createNotepadState({ ipc: backend.ipc });
    const lifecycle = createNotepadLifecycle({
      confirm: async () => true,
      hasMarkdownDrafts: () => false,
      showError: () => {},
      reload: () => {},
      loadState: async () => state,
    });

    const recovering = lifecycle.recover();
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.reject(new Error("disk full"));
    await expect(recovering).rejects.toThrow();

    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toContain("draft");
    expect(state.getSnapshot().text).toBe("draft");
    expect(state.getSnapshot().error).toMatch(/could not be saved/);
  });

  it("복구 실패 뒤 오류가 해소되면 종료는 복구를 다시 기다리지 않고 저장을 재시도한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    putBackup({ scope: ws(1), base: "base", text: "draft" });
    const { lifecycle, deps, state } = makeHarness(backend);

    const recovering = lifecycle.recover();
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));
    backend.saves[0].result.reject(new Error("disk full"));
    await expect(recovering).rejects.toThrow(/could not be saved/);

    // 오류가 해소된 뒤 새로 입력한 내용도 종료 flush 로 저장된다.
    state.acceptText("later");
    const closeEvent = event();
    const closing = lifecycle.handleClose(closeEvent);
    await vi.waitFor(() => expect(backend.saves).toHaveLength(2));
    expect(backend.saves[1]).toMatchObject({ scope: ws(1), expected: "base", content: "later" });
    backend.saves[1].result.resolve({ type: "saved" });
    await closing;

    expect(deps.confirm).not.toHaveBeenCalled();
    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });

  it("복구 저장 중 연 서랍은 복구가 끝난 뒤 저장된 본문으로 편집한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    putBackup({ scope: ws(1), base: "base", text: "draft" });
    const { lifecycle, state } = makeHarness(backend);
    const host: NotepadHost = {
      getSnapshot: () => notepadSnapshot(1, [1]),
      focusActivePane: () => {},
      awaitBootRecovery: () => lifecycle.awaitRecovery(),
    };
    const feature = createNotepadFeature(host, state);

    const recovering = lifecycle.recover();
    await vi.waitFor(() => expect(backend.saves).toHaveLength(1));

    const opening = feature.toggle();
    await vi.waitFor(() => expect(document.querySelector("textarea.notepad-text")).not.toBeNull());
    const pendingArea = document.querySelector<HTMLTextAreaElement>("textarea.notepad-text")!;
    expect(pendingArea.disabled).toBe(true);
    expect(state.getSnapshot().scope).toEqual(ws(1));

    // 복구 저장이 실제로 디스크에 착지한 뒤 복구가 세션을 정리한다.
    backend.disk.set("ws:1", "draft");
    backend.saves[0].result.resolve({ type: "saved" });
    await recovering;
    await opening;

    const area = document.querySelector<HTMLTextAreaElement>("textarea.notepad-text")!;
    expect(area.value).toBe("draft");
    expect(area.disabled).toBe(false);
    expect(state.getSnapshot()).toMatchObject({ scope: ws(1), text: "draft" });

    // 이후 입력은 새로 읽은 세션의 저장으로 이어진다.
    area.value = "more";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    const closing = feature.close();
    await vi.waitFor(() => expect(backend.saves).toHaveLength(2));
    expect(backend.saves[1]).toMatchObject({ scope: ws(1), expected: "draft", content: "more" });
    backend.saves[1].result.resolve({ type: "saved" });
    await closing;

    expect(document.querySelector("dialog.notepad-drawer")).toBeNull();
  });

  it("복구 대상이 없으면 state 모듈을 읽지 않는다", async () => {
    const lifecycle = createNotepadLifecycle({
      confirm: async () => true,
      hasMarkdownDrafts: () => false,
      showError: () => {},
      reload: () => {},
      loadState: async () => {
        throw new Error("must not load");
      },
    });

    await lifecycle.recover();
  });
});

describe("메모장 active 와 닫힌 워크스페이스 정리", () => {
  it("모듈 미로드에서는 백업 슬롯 존재로 active 를 판단한다", () => {
    const backend = makeBackend();
    const { lifecycle } = makeHarness(backend, { attach: false });
    expect(lifecycle.isNotepadActive()).toBe(false);

    putBackup({ scope: ws(1), base: "", text: "draft" });
    expect(lifecycle.isNotepadActive()).toBe(true);
  });

  it("열린 서랍 세션은 active 이고 clean 정리 뒤에는 아니다", async () => {
    const backend = makeBackend({ "ws:1": "" });
    const { lifecycle, state } = makeHarness(backend);
    await state.open(ws(1));
    expect(lifecycle.isNotepadActive()).toBe(true);

    state.dispose();
    expect(lifecycle.isNotepadActive()).toBe(false);
  });

  it("메모리 초안과 백업의 비어 있지 않은 text 를 워크스페이스별로 판정한다", async () => {
    const backend = makeBackend({ "ws:1": "", "ws:2": "" });
    const { lifecycle, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");

    expect(lifecycle.notepadHasLocalContent(1)).toBe(true);
    expect(lifecycle.notepadHasLocalContent(2)).toBe(false);

    state.dispose();
    expect(lifecycle.notepadHasLocalContent(1)).toBe(true);
  });

  it("닫힌 워크스페이스의 백업을 버리고 다른 백업은 건드리지 않는다", async () => {
    const backend = makeBackend();
    putBackup({ scope: ws(1), base: "", text: "draft" });
    const { lifecycle, deps } = makeHarness(backend, { attach: false });

    await lifecycle.discardClosedWorkspace(1);
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
    expect(deps.loads.count).toBe(1);

    putBackup({ scope: ws(2), base: "", text: "other" });
    await lifecycle.discardClosedWorkspace(1);
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toContain("other");
  });

  it("snapshot 에서 사라진 워크스페이스의 백업 초안을 버린다", async () => {
    const backend = makeBackend();
    putBackup({ scope: ws(1), base: "", text: "draft" });
    const { lifecycle } = makeHarness(backend, { attach: false });

    await lifecycle.discardClosedDrafts([2]);

    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });

  it("snapshot 에 남아 있는 워크스페이스의 초안은 건드리지 않는다", async () => {
    const backend = makeBackend();
    putBackup({ scope: ws(1), base: "", text: "draft" });
    const { lifecycle, deps } = makeHarness(backend, { attach: false });

    await lifecycle.discardClosedDrafts([1]);

    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toContain("draft");
    expect(deps.loads.count).toBe(0);
  });

  it("첫 snapshot 전에는 백업을 판단하지 않는다", async () => {
    const backend = makeBackend();
    putBackup({ scope: ws(1), base: "", text: "draft" });
    const { lifecycle, deps } = makeHarness(backend, { attach: false });

    await Promise.resolve();

    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toContain("draft");
    expect(deps.loads.count).toBe(0);

    await lifecycle.discardClosedDrafts([2]);
  });

  it("모듈 미로드·백업 없음이면 snapshot 확인에서 모듈을 읽지 않는다", async () => {
    const backend = makeBackend();
    const { lifecycle, deps } = makeHarness(backend, { attach: false });

    await lifecycle.discardClosedDrafts([1]);

    expect(deps.loads.count).toBe(0);
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });

  it("로드된 세션의 워크스페이스가 snapshot 에서 사라지면 저장 없이 버린다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const { lifecycle, state } = makeHarness(backend);
    await state.open(ws(1));
    state.acceptText("draft");

    await lifecycle.discardClosedDrafts([2]);

    expect(state.getSnapshot().scope).toBeNull();
    expect(state.getSnapshot().text).toBe("");
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
    expect(backend.saves).toHaveLength(0);
  });
});
