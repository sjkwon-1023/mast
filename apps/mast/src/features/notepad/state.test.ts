// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTEPAD_DRAFT_KEY,
  type NoteScope,
  type NotepadDraftBackup,
  type SaveOutcome,
} from "../../shared/types";
import {
  createNotepadState,
  hasNotepadDraftBackup,
  MAX_NOTE_BYTES,
  NOTEPAD_SAVE_DELAY_MS,
  pendingClosedReads,
  type NotepadIpc,
} from "./state";

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

/** 이후 save 호출을 즉시 성공시킨다. 이미 만들어진 요청의 deferred는 그대로 둔다. */
function succeedNextSaves(backend: ReturnType<typeof makeBackend>): void {
  vi.mocked(backend.ipc.save).mockImplementation((scope, expected, content) => {
    const result = deferred<SaveOutcome>();
    backend.saves.push({ scope, expected, content, result });
    result.resolve({ type: "saved" });
    return result.promise;
  });
}

function storedBackup(): NotepadDraftBackup | null {
  const raw = sessionStorage.getItem(NOTEPAD_DRAFT_KEY);
  return raw === null ? null : (JSON.parse(raw) as NotepadDraftBackup);
}

function putBackup(backup: NotepadDraftBackup): void {
  sessionStorage.setItem(NOTEPAD_DRAFT_KEY, JSON.stringify(backup));
}

/** 저장 응답 처리·다음 요청 시작까지의 마이크로태스크를 흘려보낸다. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("입력 수락과 debounce", () => {
  it("연속 타이핑이 500ms 뒤 한 저장으로 합쳐진다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    expect(backend.reads).toEqual([ws(1)]);

    state.acceptText("a");
    await vi.advanceTimersByTimeAsync(200);
    state.acceptText("ab");
    await vi.advanceTimersByTimeAsync(200);
    state.acceptText("abc");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS - 1);
    expect(backend.saves).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(backend.saves).toHaveLength(1);
    expect(backend.saves[0]).toMatchObject({ expected: "base", content: "abc" });

    backend.saves[0].result.resolve({ type: "saved" });
    await settle();
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
    expect(state.getSnapshot()).toMatchObject({ text: "abc", dirty: false, error: null });
  });

  it("저장 중 추가 입력은 이어서 저장하고, 먼저 끝난 응답이 최신 백업을 지우지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));

    state.acceptText("one");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    expect(backend.saves).toHaveLength(1);

    state.acceptText("two");
    backend.saves[0].result.resolve({ type: "saved" });
    await settle();

    expect(backend.saves).toHaveLength(2);
    expect(backend.saves[1]).toMatchObject({ expected: "one", content: "two" });
    expect(storedBackup()).toMatchObject({
      scope: ws(1),
      base: "one",
      text: "two",
      inFlight: "two",
    });

    backend.saves[1].result.resolve({ type: "saved" });
    await settle();
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
    expect(state.getSnapshot().text).toBe("two");
  });

  it("flush는 진행 중 요청과 그 뒤에 수락된 최신 입력까지 기다린다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));

    state.acceptText("one");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    state.acceptText("two");

    let flushed = false;
    const pending = state.flush().then(() => {
      flushed = true;
    });
    await settle();
    expect(flushed).toBe(false);
    expect(backend.saves).toHaveLength(1);

    backend.saves[0].result.resolve({ type: "saved" });
    await settle();
    expect(backend.saves).toHaveLength(2);
    expect(flushed).toBe(false);

    backend.saves[1].result.resolve({ type: "saved" });
    await pending;
    expect(flushed).toBe(true);
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });

  it("실패 뒤에도 최신 text와 백업을 유지하고, 다음 입력으로 다시 저장한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));

    state.acceptText("draft");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    backend.saves[0].result.reject(new Error("disk full"));
    await settle();

    expect(state.getSnapshot()).toMatchObject({ text: "draft" });
    expect(state.getSnapshot().error).toMatch(/could not be saved/);
    expect(storedBackup()).toMatchObject({ base: "base", text: "draft", inFlight: "draft" });

    state.acceptText("later");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    expect(backend.saves).toHaveLength(2);
    expect(backend.saves[1]).toMatchObject({ expected: "base", content: "later" });

    backend.saves[1].result.resolve({ type: "saved" });
    await settle();
    await state.flush();
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
    expect(state.getSnapshot()).toMatchObject({ text: "later", dirty: false, error: null });
  });
});

describe("저장 실패 뒤 flush 재시도", () => {
  it("원문으로 되돌린 뒤 저장이 실패해도 flush가 디스크를 확인해 수렴한다", async () => {
    const backend = makeBackend({ "ws:1": "A" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));

    state.acceptText("B");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    expect(backend.saves).toHaveLength(1);
    state.acceptText("A");
    backend.saves[0].result.reject(new Error("disk full"));
    await settle();
    expect(state.getSnapshot()).toMatchObject({ text: "A", dirty: true });

    const flushing = state.flush();
    await settle();
    expect(backend.saves).toHaveLength(2);
    expect(backend.saves[1]).toMatchObject({ expected: "A", content: "A" });
    backend.saves[1].result.resolve({ type: "saved" });
    await flushing;

    expect(state.getSnapshot()).toMatchObject({ text: "A", dirty: false, error: null });
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });

  it("실패한 저장이 디스크에 착지했으면 그 원문을 기준으로 다시 저장한다", async () => {
    const backend = makeBackend({ "ws:1": "A" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));

    state.acceptText("B");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    expect(backend.saves).toHaveLength(1);
    state.acceptText("A");
    backend.saves[0].result.reject(new Error("disk full"));
    await settle();

    const flushing = state.flush();
    await settle();
    expect(backend.saves).toHaveLength(2);
    expect(backend.saves[1]).toMatchObject({ expected: "A", content: "A" });
    backend.saves[1].result.resolve({ type: "conflict", current: "B" });
    await settle();

    expect(backend.saves).toHaveLength(3);
    expect(backend.saves[2]).toMatchObject({ expected: "B", content: "A" });
    backend.saves[2].result.resolve({ type: "saved" });
    await flushing;

    expect(state.getSnapshot()).toMatchObject({ text: "A", dirty: false, error: null });
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });

  it("flush는 실패한 저장을 새 입력 없이 다시 시도하고, 성공하면 백업을 정리한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));

    state.acceptText("draft");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    backend.saves[0].result.reject(new Error("disk full"));
    await settle();

    const first = state.flush();
    await settle();
    expect(backend.saves).toHaveLength(2);
    expect(backend.saves[1]).toMatchObject({ expected: "base", content: "draft" });
    backend.saves[1].result.reject(new Error("disk full"));
    await expect(first).rejects.toThrow(/could not be saved/);
    expect(storedBackup()).toMatchObject({ base: "base", text: "draft", inFlight: "draft" });

    succeedNextSaves(backend);
    await state.flush();

    expect(backend.saves).toHaveLength(3);
    expect(backend.saves[2]).toMatchObject({ expected: "base", content: "draft" });
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
    expect(state.getSnapshot()).toMatchObject({ text: "draft", dirty: false, error: null });
  });

  it("flush 재시도도 실패하면 reject하고 text와 백업을 유지한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));

    state.acceptText("draft");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    backend.saves[0].result.reject(new Error("disk full"));
    await settle();

    const first = state.flush();
    await settle();
    backend.saves[1].result.reject(new Error("disk full"));
    await expect(first).rejects.toThrow(/could not be saved/);

    const second = state.flush();
    await settle();
    expect(backend.saves).toHaveLength(3);
    backend.saves[2].result.reject(new Error("disk full"));
    await expect(second).rejects.toThrow(/could not be saved/);

    expect(backend.saves).toHaveLength(3);
    expect(state.getSnapshot()).toMatchObject({ text: "draft" });
    expect(state.getSnapshot().error).toMatch(/could not be saved/);
    expect(storedBackup()).toMatchObject({ base: "base", text: "draft", inFlight: "draft" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scope 전환도 실패한 flush를 다시 시도해 새 scope를 읽는다", async () => {
    const backend = makeBackend({ "ws:1": "one", global: "global" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    state.acceptText("one!");

    const first = state.setScope(globalScope);
    backend.saves[0].result.reject(new Error("denied"));
    await expect(first).rejects.toThrow(/could not be saved/);
    expect(backend.reads).toHaveLength(1);

    succeedNextSaves(backend);
    await state.setScope(globalScope);

    expect(backend.saves).toHaveLength(2);
    expect(backend.saves[1]).toMatchObject({ expected: "one", content: "one!" });
    expect(backend.reads).toHaveLength(2);
    expect(backend.reads[1]).toEqual(globalScope);
    expect(state.getSnapshot()).toMatchObject({ scope: globalScope, text: "global" });
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });
});

describe("크기 상한과 백업", () => {
  it("UTF-8 바이트 MAX는 받아들이고 MAX+1은 거부한다", async () => {
    const backend = makeBackend({ "ws:1": "" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));

    const max = "a".repeat(MAX_NOTE_BYTES);
    expect(state.acceptText(max)).toBe(true);
    expect(state.getSnapshot().text).toBe(max);

    expect(state.acceptText(`${max}a`)).toBe(false);
    expect(state.getSnapshot().text).toBe(max);
    expect(state.getSnapshot().error).toMatch(/too large/);
    expect(backend.saves).toHaveLength(0);
  });

  it("문자 수가 아니라 UTF-8 다중 바이트 길이로 상한을 판정한다", async () => {
    const backend = makeBackend({ "ws:1": "" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));

    const multibyte = "가".repeat(Math.floor(MAX_NOTE_BYTES / 3));
    expect(new TextEncoder().encode(multibyte).byteLength).toBeLessThanOrEqual(MAX_NOTE_BYTES);
    expect(state.acceptText(multibyte)).toBe(true);

    const over = `${multibyte}가`;
    expect(new TextEncoder().encode(over).byteLength).toBeGreaterThan(MAX_NOTE_BYTES);
    expect(state.acceptText(over)).toBe(false);
    expect(state.getSnapshot().text).toBe(multibyte);
  });

  it("sessionStorage quota 실패(setItem throw)면 입력을 거부하고 이전 text를 유지한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));

    const setItem = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(state.acceptText("draft")).toBe(false);
    setItem.mockRestore();

    expect(state.getSnapshot().text).toBe("base");
    expect(state.getSnapshot().error).toMatch(/could not be backed up/);
    expect(storedBackup()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    expect(state.acceptText("draft")).toBe(true);
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    expect(backend.saves[0]).toMatchObject({ expected: "base", content: "draft" });
  });

  it("백업 파싱 실패를 조용히 비우지 않고 오류로 드러낸다", async () => {
    const backend = makeBackend({ "ws:1": "" });
    sessionStorage.setItem(NOTEPAD_DRAFT_KEY, "{broken");
    const state = createNotepadState({ ipc: backend.ipc });

    expect(await state.recover()).toBe(true);
    expect(state.getSnapshot().error).toMatch(/could not be read/);
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBe("{broken");
    expect(backend.reads).toHaveLength(0);

    await expect(state.open(ws(1))).rejects.toThrow(/could not be read/);
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBe("{broken");
  });

  it("다른 scope의 미완료 초안이 있으면 새 scope 편집을 시작하지 않는다", async () => {
    const backend = makeBackend({ "ws:2": "" });
    putBackup({ scope: ws(1), base: "", text: "draft" });
    const state = createNotepadState({ ipc: backend.ipc });

    await expect(state.open(ws(2))).rejects.toThrow(/Another note draft/);
    expect(backend.reads).toHaveLength(0);
    expect(storedBackup()).toMatchObject({ scope: ws(1), text: "draft" });
  });
});

describe("리로드 복원과 CAS 수렴", () => {
  it("디스크가 base면 백업의 최신 text 저장을 이어간다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const first = await import("./state");
    const before = first.createNotepadState({ ipc: backend.ipc });
    await before.open(ws(1));
    before.acceptText("draft");
    expect(storedBackup()).toMatchObject({ base: "base", text: "draft" });
    before.dispose();

    vi.resetModules();
    const reloaded = await import("./state");
    const after = reloaded.createNotepadState({ ipc: backend.ipc });
    expect(await after.recover()).toBe(true);
    expect(backend.reads).toHaveLength(2);
    expect(backend.saves).toHaveLength(1);
    expect(backend.saves[0]).toMatchObject({ expected: "base", content: "draft" });

    backend.saves[0].result.resolve({ type: "saved" });
    await settle();
    expect(storedBackup()).toBeNull();
    expect(after.getSnapshot().text).toBe("draft");
  });

  it("디스크가 알려진 inFlight면 그 원문을 기준으로 최신 text를 저장한다", async () => {
    const backend = makeBackend({ "ws:1": "mid" });
    putBackup({ scope: ws(1), base: "base", text: "draft", inFlight: "mid" });
    const state = createNotepadState({ ipc: backend.ipc });

    expect(await state.recover()).toBe(true);
    expect(backend.reads).toHaveLength(1);
    expect(backend.saves).toHaveLength(1);
    expect(backend.saves[0]).toMatchObject({ expected: "mid", content: "draft" });

    backend.saves[0].result.resolve({ type: "saved" });
    await settle();
    expect(storedBackup()).toBeNull();
  });

  it("디스크가 이미 최신 text면 완료로 보고 백업을 제거한다", async () => {
    const backend = makeBackend({ "ws:1": "draft" });
    putBackup({ scope: ws(1), base: "base", text: "draft" });
    const state = createNotepadState({ ipc: backend.ipc });

    expect(await state.recover()).toBe(true);
    expect(backend.reads).toHaveLength(1);
    expect(backend.saves).toHaveLength(0);
    expect(storedBackup()).toBeNull();
    expect(state.getSnapshot()).toMatchObject({ text: "draft", dirty: false });
  });

  it("디스크가 알 수 없는 원문이면 덮어쓰지 않고 초안을 보존한다", async () => {
    const backend = makeBackend({ "ws:1": "other" });
    putBackup({ scope: ws(1), base: "base", text: "draft" });
    const state = createNotepadState({ ipc: backend.ipc });

    expect(await state.recover()).toBe(true);
    expect(backend.saves).toHaveLength(0);
    expect(backend.disk.get("ws:1")).toBe("other");
    expect(storedBackup()).toMatchObject({ base: "base", text: "draft" });
    expect(state.getSnapshot().text).toBe("draft");
    expect(state.getSnapshot().error).toMatch(/changed on disk/);
    await expect(state.flush()).rejects.toThrow(/changed on disk/);
    expect(backend.saves).toHaveLength(0);
  });

  it("오래된 save 응답이 복원 save보다 늦게 도착해도 새 백업을 건드리지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const first = createNotepadState({ ipc: backend.ipc });
    await first.open(ws(1));
    first.acceptText("old");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    expect(backend.saves).toHaveLength(1);

    // 리로드 직전 사용자가 더 입력한 상태를 백업에만 반영한다.
    putBackup({ scope: ws(1), base: "base", text: "new", inFlight: "old" });

    const second = createNotepadState({ ipc: backend.ipc });
    expect(await second.recover()).toBe(true);
    expect(backend.saves).toHaveLength(2);
    expect(backend.saves[1]).toMatchObject({ expected: "base", content: "new" });

    // 과거 save가 먼저 도착해도 새 컨텍스트의 백업을 지우지 않는다.
    backend.saves[0].result.resolve({ type: "saved" });
    await settle();
    expect(storedBackup()).toMatchObject({ base: "base", text: "new", inFlight: "new" });
    expect(second.getSnapshot().text).toBe("new");

    backend.saves[1].result.resolve({ type: "saved" });
    await settle();
    expect(storedBackup()).toBeNull();
    expect(second.getSnapshot().text).toBe("new");
  });
});

describe("충돌", () => {
  it("알 수 없는 conflict 원문은 덮어쓰지 않고 오류·초안을 유지한다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    state.acceptText("draft");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);

    backend.saves[0].result.resolve({ type: "conflict", current: "other" });
    await settle();

    expect(backend.saves).toHaveLength(1);
    expect(backend.disk.get("ws:1")).toBe("base");
    expect(storedBackup()).toMatchObject({ base: "base", text: "draft" });
    expect(state.getSnapshot()).toMatchObject({ text: "draft" });
    expect(state.getSnapshot().error).toMatch(/changed on disk/);
    await expect(state.flush()).rejects.toThrow(/changed on disk/);
    expect(backend.saves).toHaveLength(1);
  });

  it("conflict의 current가 알려진 inFlight면 기준만 갱신하고 저장을 이어간다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    putBackup({ scope: ws(1), base: "base", text: "draft", inFlight: "mid" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.recover();

    expect(backend.saves).toHaveLength(1);
    backend.saves[0].result.resolve({ type: "conflict", current: "mid" });
    await settle();

    expect(backend.saves).toHaveLength(2);
    expect(backend.saves[1]).toMatchObject({ expected: "mid", content: "draft" });

    backend.saves[1].result.resolve({ type: "saved" });
    await settle();
    expect(storedBackup()).toBeNull();
    expect(state.getSnapshot().error).toBeNull();
  });
});

describe("scope·워크스페이스 전환", () => {
  it("scope 전환은 이전 scope flush가 끝난 뒤에만 새 scope를 읽는다", async () => {
    const backend = makeBackend({ "ws:1": "one", global: "global" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    state.acceptText("one!");

    const switching = state.setScope(globalScope);
    expect(backend.saves).toHaveLength(1);
    expect(backend.reads).toHaveLength(1);

    backend.saves[0].result.resolve({ type: "saved" });
    await switching;

    expect(backend.reads).toHaveLength(2);
    expect(backend.reads[1]).toEqual(globalScope);
    expect(state.getSnapshot()).toMatchObject({ scope: globalScope, text: "global" });
  });

  it("scope 전환 flush가 실패하면 기존 scope와 text를 유지하고 reject한다", async () => {
    const backend = makeBackend({ "ws:1": "one", global: "global" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    state.acceptText("one!");

    const switching = state.setScope(globalScope);
    backend.saves[0].result.reject(new Error("denied"));
    await expect(switching).rejects.toThrow(/could not be saved/);

    expect(backend.reads).toHaveLength(1);
    expect(state.getSnapshot()).toMatchObject({ scope: ws(1), text: "one!" });
    expect(storedBackup()).toMatchObject({ scope: ws(1), text: "one!" });
  });

  it("워크스페이스 따라가기는 flush 성공 뒤 새 workspace를 읽는다", async () => {
    const backend = makeBackend({ "ws:1": "one", "ws:2": "two" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    state.acceptText("one!");

    const following = state.followWorkspace(2);
    expect(backend.saves).toHaveLength(1);
    backend.saves[0].result.resolve({ type: "saved" });

    await expect(following).resolves.toBe(true);
    expect(backend.reads).toEqual([ws(1), ws(2)]);
    expect(state.getSnapshot()).toMatchObject({ scope: ws(2), text: "two" });
  });

  it("워크스페이스 따라가기 flush가 실패하면 이전 workspace에 머물고 오류를 노출한다", async () => {
    const backend = makeBackend({ "ws:1": "one", "ws:2": "two" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    state.acceptText("one!");

    const following = state.followWorkspace(2);
    backend.saves[0].result.reject(new Error("denied"));

    await expect(following).resolves.toBe(false);
    expect(backend.reads).toHaveLength(1);
    expect(state.getSnapshot()).toMatchObject({ scope: ws(1), text: "one!" });
    expect(state.getSnapshot().error).toMatch(/could not be saved/);
  });

  it("Global scope는 active workspace를 따라가지 않는다", async () => {
    const backend = makeBackend({ global: "global" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(globalScope);

    await expect(state.followWorkspace(2)).resolves.toBe(false);
    expect(backend.reads).toHaveLength(1);
    expect(backend.saves).toHaveLength(0);
    expect(state.getSnapshot().scope).toEqual(globalScope);
  });
});

describe("첫 읽기와 범위 전환의 경합", () => {
  it("늦게 끝난 이전 읽기가 새 scope·본문·백업을 덮지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "workspace", global: "global" });
    const workspaceRead = deferred<string>();
    vi.mocked(backend.ipc.read).mockImplementationOnce(async (scope) => {
      backend.reads.push(scope);
      return workspaceRead.promise;
    });
    const state = createNotepadState({ ipc: backend.ipc });

    const opening = state.open(ws(1));
    await settle();
    expect(backend.reads).toEqual([ws(1)]);

    const switching = state.setScope(globalScope);
    await settle();
    expect(backend.reads).toEqual([ws(1), globalScope]);
    expect(state.getSnapshot().scope).toEqual(globalScope);

    state.acceptText("edited");
    expect(storedBackup()).toMatchObject({ scope: globalScope, base: "global", text: "edited" });

    workspaceRead.resolve("workspace");
    await opening;
    await switching;

    expect(state.getSnapshot()).toMatchObject({ scope: globalScope, text: "edited" });
    expect(storedBackup()).toMatchObject({ scope: globalScope, base: "global", text: "edited" });

    // 닫기 flush는 사라진 Workspace가 아니라 남아 있는 Global을 저장한다.
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    expect(backend.saves).toHaveLength(1);
    expect(backend.saves[0]).toMatchObject({
      scope: globalScope,
      expected: "global",
      content: "edited",
    });
    backend.saves[0].result.resolve({ type: "saved" });
    await settle();
    await state.flush();
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
  });

  it("두 읽기가 모두 진행 중이면 완료 순서와 무관하게 마지막 요청만 반영된다", async () => {
    const backend = makeBackend();
    const workspaceRead = deferred<string>();
    const globalRead = deferred<string>();
    vi.mocked(backend.ipc.read).mockImplementation(async (scope) => {
      backend.reads.push(scope);
      return scope.type === "global" ? globalRead.promise : workspaceRead.promise;
    });
    const state = createNotepadState({ ipc: backend.ipc });

    const opening = state.open(ws(1));
    await settle();
    const switching = state.setScope(globalScope);
    await settle();
    expect(backend.reads).toEqual([ws(1), globalScope]);

    // 먼저 시작한 Workspace 읽기가 먼저 끝나도 마지막 요청의 토큰이 아니면 버린다.
    workspaceRead.resolve("workspace");
    await opening;
    expect(state.getSnapshot().scope).toBeNull();

    globalRead.resolve("global");
    await switching;
    expect(state.getSnapshot()).toMatchObject({ scope: globalScope, text: "global" });
  });
});

describe("폐기와 수명", () => {
  it("닫힌 워크스페이스 폐기는 저장 요청 없이 백업을 지운다", async () => {
    const backend = makeBackend({ "ws:1": "one" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    state.acceptText("draft");
    expect(vi.getTimerCount()).toBe(1);

    state.discardClosedWorkspace(1);
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS * 2);

    expect(backend.saves).toHaveLength(0);
    expect(storedBackup()).toBeNull();
    expect(state.isActive()).toBe(false);
    expect(state.getSnapshot()).toMatchObject({ scope: null, text: "" });
  });

  it("메모와 무관한 워크스페이스 닫기 100회는 이후 열기를 막지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });

    for (let id = 100; id < 200; id += 1) state.discardClosedWorkspace(id);

    await state.open(ws(1));
    expect(backend.reads).toEqual([ws(1)]);
    expect(state.getSnapshot()).toMatchObject({ scope: ws(1), text: "base" });
    expect(state.getSnapshot().error).toBeNull();
  });

  it("닫힌 읽기 표시는 진행 중 읽기와 일치하는 닫기에만 남고 정착하면 사라진다", async () => {
    const read = deferred<string>();
    const ipc: NotepadIpc = {
      read: vi.fn(() => read.promise),
      save: vi.fn(async () => ({ type: "saved" }) as SaveOutcome),
    };
    const state = createNotepadState({ ipc });
    expect(pendingClosedReads(state)).toEqual([]);

    const opening = state.open(ws(1));
    await settle();
    expect(pendingClosedReads(state)).toEqual([]);

    // 무관한 닫기는 표시를 남기지 않는다.
    for (let id = 100; id < 200; id += 1) state.discardClosedWorkspace(id);
    expect(pendingClosedReads(state)).toEqual([]);

    // 진행 중인 읽기와 일치하는 닫기만 표시된다.
    state.discardClosedWorkspace(1);
    expect(pendingClosedReads(state)).toEqual([1]);

    read.resolve("late");
    await expect(opening).rejects.toThrow(/closed/);

    // 그 읽기가 정착하면 표시가 사라진다.
    expect(pendingClosedReads(state)).toEqual([]);
    expect(state.getSnapshot()).toMatchObject({ scope: null, text: "" });
    expect(state.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("폐기 뒤 늦게 끝난 범위 읽기가 세션을 다시 열지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "one", global: "global", "ws:2": "two" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    const globalRead = deferred<string>();
    vi.mocked(backend.ipc.read).mockImplementationOnce(async (scope) => {
      backend.reads.push(scope);
      return globalRead.promise;
    });

    const switching = state.setScope(globalScope);
    await settle();
    expect(backend.reads).toEqual([ws(1), globalScope]);

    state.discardClosedWorkspace(1);
    globalRead.resolve("global");
    await switching;

    expect(state.getSnapshot()).toMatchObject({ scope: null, text: "", dirty: false });
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
    expect(state.isActive()).toBe(false);

    await state.open(ws(2));
    expect(backend.reads).toEqual([ws(1), globalScope, ws(2)]);
    expect(state.getSnapshot()).toMatchObject({ scope: ws(2), text: "two" });
  });

  it("dispose 뒤 늦게 끝난 범위 읽기가 세션을 다시 열지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "one", global: "global", "ws:2": "two" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    const globalRead = deferred<string>();
    vi.mocked(backend.ipc.read).mockImplementationOnce(async (scope) => {
      backend.reads.push(scope);
      return globalRead.promise;
    });

    const switching = state.setScope(globalScope);
    await settle();
    expect(backend.reads).toEqual([ws(1), globalScope]);

    state.dispose();
    globalRead.resolve("global");
    await switching;

    expect(state.getSnapshot()).toMatchObject({ scope: null, text: "", dirty: false });
    expect(state.isActive()).toBe(false);

    await state.open(ws(2));
    expect(state.getSnapshot()).toMatchObject({ scope: ws(2), text: "two" });
  });

  it("진행 중 저장이 있어도 폐기 뒤 늦은 응답이 상태를 되살리지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "one" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    state.acceptText("draft");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    expect(backend.saves).toHaveLength(1);

    state.discardClosedWorkspace(1);
    backend.saves[0].result.resolve({ type: "saved" });
    await settle();

    expect(backend.saves).toHaveLength(1);
    expect(storedBackup()).toBeNull();
    expect(state.getSnapshot()).toMatchObject({ scope: null, text: "" });
  });

  it("clean 닫기 뒤 timer·본문 참조·백업이 남지 않는다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });
    await state.open(ws(1));
    state.acceptText("draft");
    await vi.advanceTimersByTimeAsync(NOTEPAD_SAVE_DELAY_MS);
    backend.saves[0].result.resolve({ type: "saved" });
    await settle();
    await state.flush();

    state.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(sessionStorage.getItem(NOTEPAD_DRAFT_KEY)).toBeNull();
    expect(state.getSnapshot()).toMatchObject({ scope: null, text: "", dirty: false });
    expect(state.isActive()).toBe(false);
  });

  it("한 번도 열지 않았으면 read IPC와 timer가 없다", () => {
    const backend = makeBackend({ "ws:1": "base" });
    const state = createNotepadState({ ipc: backend.ipc });

    expect(state.isActive()).toBe(false);
    expect(hasNotepadDraftBackup()).toBe(false);
    expect(backend.reads).toHaveLength(0);
    expect(backend.saves).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isActive는 열림·미완료 백업·진행 중 저장을 반영하고 구독자에게 알린다", async () => {
    const backend = makeBackend({ "ws:1": "base" });
    putBackup({ scope: ws(1), base: "base", text: "draft" });
    const state = createNotepadState({ ipc: backend.ipc });
    expect(state.isActive()).toBe(true);

    const seen: boolean[] = [];
    const stop = state.subscribe(() => seen.push(state.isActive()));
    await state.recover();
    expect(seen.length).toBeGreaterThan(0);

    backend.saves[0].result.resolve({ type: "saved" });
    await settle();
    await state.flush();
    expect(state.isActive()).toBe(true);

    state.dispose();
    expect(state.isActive()).toBe(false);
    expect(seen.at(-1)).toBe(false);
    stop();
  });
});
