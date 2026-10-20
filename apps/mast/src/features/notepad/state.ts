// 메모장의 DOM 없는 편집·저장 상태 기계.
//
// 뷰(C4)와 앱 수명 배선(C5)은 파일 저장·타이머·백업을 직접 다루지 않고 이 모듈만 쓴다.
// 저장은 CAS(notes_save expected)이므로 리로드 경계에 늦게 실행된 과거 요청이 새 내용을
// 덮어쓸 수 없다. 다만 내용 비교 CAS라서 A→B→A로 돌아온 동안 이미 보낸 B 저장과 리로드가
// 겹치면 그 B 요청이 늦게 착지할 수 있다 (ADR-0034 Accepted limits). sessionStorage 백업은
// 영구 저장소가 아니라 WebView 리로드 안전망이며, 백업에 성공한 입력만 받아들인다.

import { notesRead, notesSave } from "../../infrastructure/backend";
import {
  NOTEPAD_DRAFT_KEY,
  type NoteScope,
  type NotepadDraftBackup,
  type SaveOutcome,
  type WorkspaceId,
} from "../../shared/types";

/** core `MAX_DOCUMENT_BYTES`와 같은 UTF-8 바이트 상한. 문자 수로 대신하지 않는다. */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
/** 입력이 멈춘 뒤 저장까지의 지연. */
export const NOTEPAD_SAVE_DELAY_MS = 500;

const SIZE_LIMIT_ERROR = "The note is too large. The limit is 2 MiB of UTF-8 text.";
const BACKUP_ERROR = "The note could not be backed up, so the change was not applied.";
const BACKUP_INVALID_ERROR = "The saved note draft could not be read.";
const LOAD_ERROR = "The note could not be loaded.";
const SAVE_ERROR = "The note could not be saved. Your draft is kept.";
const CONFLICT_ERROR = "The note changed on disk. Your draft was preserved and was not overwritten.";
const OTHER_DRAFT_ERROR = "Another note draft is still unsaved. Finish it before opening a different note.";
const ALREADY_OPEN_ERROR = "Another note is already open.";
const NOT_OPEN_ERROR = "No note is open.";
const CLOSED_ERROR = "That workspace is closed.";

/** 테스트가 순서를 제어할 수 있게 분리한 IPC 경계. 기본값은 실제 backend 함수다. */
export interface NotepadIpc {
  read(scope: NoteScope): Promise<string>;
  save(scope: NoteScope, expected: string, content: string): Promise<SaveOutcome>;
}

export type NotepadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface NotepadDeps {
  ipc?: NotepadIpc;
  storage?: NotepadStorage;
}

export interface NotepadSnapshot {
  scope: NoteScope | null;
  text: string;
  /** 사용자에게 보여 줄 영어 오류. 없으면 null. */
  error: string | null;
  /** debounce 대기 또는 요청 진행 중. */
  saving: boolean;
  /** 디스크 기준과 다르거나 저장 실패·충돌로 보존된 입력이 있다. */
  dirty: boolean;
  /** 종료·리로드 flush 전에 입력을 동결했다. */
  frozen: boolean;
}

export interface NotepadState {
  /** 편집 세션을 연다. 같은 scope의 미완료 백업은 디스크와 대조해 수렴시킨다. */
  open(scope: NoteScope): Promise<void>;
  /** 부팅 복구 — 미완료 백업이 있으면 그 scope를 열고 저장을 시작한다. */
  recover(): Promise<boolean>;
  /** 입력 수락. 동결 중이 아니고, 바이트 상한과 동기 백업에 성공해야 true다. */
  acceptText(text: string): boolean;
  /** 이전 scope를 flush한 뒤 새 scope를 한 번 읽는다. 실패는 reject. */
  setScope(scope: NoteScope): Promise<void>;
  /** 열린 세션이 workspace scope일 때만 새 activeWorkspace를 따라간다. */
  followWorkspace(workspace: WorkspaceId | null): Promise<boolean>;
  /** 진행 중 요청과 그 뒤에 수락된 최신 입력까지 저장한다. 실패는 reject. */
  flush(): Promise<void>;
  /** 권위 있는 워크스페이스 닫기 성공 뒤 초안을 버린다. 저장 요청을 보내지 않는다. */
  discardClosedWorkspace(workspace: WorkspaceId): void;
  /** 열린 세션을 닫는다. clean이면 타이머·본문·백업을 모두 지운다. */
  dispose(): void;
  /** 종료·리로드 flush 전에 입력을 동결한다 — thaw 전까지 acceptText는 거부한다. */
  freeze(): void;
  /** 취소된 종료에서 입력을 다시 연다. */
  thaw(): void;
  isActive(): boolean;
  getSnapshot(): NotepadSnapshot;
  /** 상태 변화 구독. 해제 함수를 돌려준다. */
  subscribe(listener: () => void): () => void;
}

export function hasNotepadDraftBackup(storage: NotepadStorage = sessionStorage): boolean {
  return storage.getItem(NOTEPAD_DRAFT_KEY) !== null;
}

/** 미완료 백업의 scope 와 최신 text. 서랍은 현재 워크스페이스가 아니라 이 scope 로 열어
 *  사용자가 초안과 오류를 확인할 수 있게 한다 (C5 §4). 손상된 백업은 null 이다. */
export function pendingDraft(
  storage: NotepadStorage = sessionStorage,
): NotepadDraftBackup | null {
  const rawValue = storage.getItem(NOTEPAD_DRAFT_KEY);
  if (rawValue === null) return null;
  try {
    const value: unknown = JSON.parse(rawValue);
    return isBackup(value) ? value : null;
  } catch {
    return null;
  }
}

const closedReadsOf = new WeakMap<NotepadState, () => readonly WorkspaceId[]>();

/** 테스트 전용 — 아직 정착하지 않은 닫힌 읽기 표시를 읽는다. */
export function pendingClosedReads(state: NotepadState): readonly WorkspaceId[] {
  return closedReadsOf.get(state)?.() ?? [];
}

export function createNotepadState(deps: NotepadDeps = {}): NotepadState {
  const ipc: NotepadIpc = deps.ipc ?? {
    read: (scope) => notesRead(scope),
    save: (scope, expected, content) => notesSave(scope, expected, content),
  };
  const storage: NotepadStorage = deps.storage ?? sessionStorage;

  let scope: NoteScope | null = null;
  let open = false;
  let text = "";
  let base = "";
  let error: string | null = null;
  let inFlight: { content: string; expected: string; generation: number } | null = null;
  /** 실패한 요청의 content. 착지했을 수도 있어 reload 수렴에 쓴다. */
  let unresolved: string | null = null;
  let failed = false;
  /** 실패 뒤 새 입력이 들어왔을 때만 자동 저장을 다시 시도한다. */
  let retry = true;
  /** 디스크를 알 수 없는 원문이 덮어써서 자동 저장을 멈춘 상태. */
  let blocked = false;
  /** 종료·리로드가 끝날 때까지 새 입력을 받지 않는다. */
  let frozen = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 이 인스턴스가 마지막으로 쓴 백업 원문. 다른 컨텍스트가 갱신했는지 판별한다. */
  let ownedRaw: string | null = null;
  let running: Promise<void> | null = null;
  let loopSeq = 0;
  /** 읽기 시작 토큰 — 늦게 끝난 읽기가 최신 세션을 덮지 않게 한다. */
  let readSeq = 0;
  /** 진행 중인 읽기 토큰과 대상 scope. */
  const reading = new Map<number, NoteScope>();
  /** 리로드 뒤 디스크가 이미 가진 것으로 확인된, 저장 응답을 잃은 요청들. */
  const knownInFlight = new Set<string>();
  /** 대기 중인 읽기가 닫힌 워크스페이스를 늦게 열지 않게 하는 표시 — 그 읽기가 끝나면 지운다. */
  const closedReads = new Set<WorkspaceId>();
  const listeners = new Set<() => void>();

  const sameScope = (a: NoteScope, b: NoteScope): boolean =>
    a.type === "global"
      ? b.type === "global"
      : b.type === "workspace" && a.workspace === b.workspace;

  /** 닫힌 워크스페이스의 늦은 읽기 표시를 한 번만 꺼낸다. */
  function takeClosedRead(next: NoteScope): boolean {
    return next.type === "workspace" && closedReads.delete(next.workspace);
  }

  const isClean = (): boolean =>
    open && text === base && inFlight === null && unresolved === null && !failed && !blocked;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function fail(message: string): void {
    error = message;
    notify();
  }

  function describe(message: string, cause: unknown): string {
    if (cause instanceof Error && cause.message) return `${message} ${cause.message}`;
    if (typeof cause === "string" && cause) return `${message} ${cause}`;
    return message;
  }

  function raw(): string | null {
    return storage.getItem(NOTEPAD_DRAFT_KEY);
  }

  function readBackup(): NotepadDraftBackup | null {
    const rawValue = raw();
    if (rawValue === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      throw new Error(BACKUP_INVALID_ERROR);
    }
    if (!isBackup(value)) throw new Error(BACKUP_INVALID_ERROR);
    return value;
  }

  function buildBackup(): NotepadDraftBackup {
    const backup: NotepadDraftBackup = { scope: scope!, base, text };
    const pending = inFlight?.content ?? unresolved;
    if (pending !== null) backup.inFlight = pending;
    return backup;
  }

  function writeBackup(): string {
    const rawValue = JSON.stringify(buildBackup());
    storage.setItem(NOTEPAD_DRAFT_KEY, rawValue);
    return rawValue;
  }

  function writeOwnedBackup(): void {
    try {
      ownedRaw = writeBackup();
    } catch {
      // 저장 자체는 계속한다. 백업 갱신 실패는 다음 입력 수락에서 다시 드러난다.
      error = BACKUP_ERROR;
    }
  }

  /** 같은 인스턴스가 마지막으로 쓴 슬롯일 때만 갱신한다 — 늦은 응답이 새 백업을 덮지 않게. */
  function refreshOwnedBackup(): void {
    if (ownedRaw === null || raw() !== ownedRaw) return;
    try {
      ownedRaw = writeBackup();
    } catch {
      error = BACKUP_ERROR;
    }
  }

  function removeBackupDirect(): void {
    storage.removeItem(NOTEPAD_DRAFT_KEY);
    ownedRaw = null;
  }

  /** 커밋하는 scope의 백업일 때만 슬롯을 소유한다 — 다른 scope의 백업을 지우지 않는다. */
  function claimBackupSlot(next: NoteScope): void {
    const rawValue = raw();
    if (rawValue === null) {
      ownedRaw = null;
      return;
    }
    try {
      const value: unknown = JSON.parse(rawValue);
      ownedRaw = isBackup(value) && sameScope(value.scope, next) ? rawValue : null;
    } catch {
      ownedRaw = null;
    }
  }

  function removeOwnedBackup(): void {
    if (ownedRaw === null || raw() !== ownedRaw) return;
    removeBackupDirect();
  }

  function rememberInFlight(content: string): void {
    knownInFlight.add(content);
    if (knownInFlight.size > 4) {
      const first = knownInFlight.values().next().value;
      if (first !== undefined) knownInFlight.delete(first);
    }
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function scheduleSave(): void {
    if (!open) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!open) return;
      void startLoop();
    }, NOTEPAD_SAVE_DELAY_MS);
  }

  async function saveOnce(gen: number): Promise<boolean> {
    if (!open || gen !== generation || scope === null || blocked) return false;
    // 원문으로 되돌린 뒤에도 실패한 요청의 착지 여부를 확인해야 한다 (unresolved).
    if (text === base && unresolved === null) return false;
    const request = { content: text, expected: base, generation: gen };
    inFlight = request;
    unresolved = null;
    failed = false;
    retry = true;
    rememberInFlight(request.content);
    if (ownedRaw !== null && raw() === ownedRaw) writeOwnedBackup();
    notify();

    let outcome: SaveOutcome;
    try {
      outcome = await ipc.save(scope, request.expected, request.content);
    } catch (cause) {
      if (gen !== generation || inFlight !== request) return false;
      inFlight = null;
      unresolved = request.content;
      failed = true;
      retry = false;
      error = describe(SAVE_ERROR, cause);
      refreshOwnedBackup();
      notify();
      return false;
    }
    if (gen !== generation || inFlight !== request) return false;
    inFlight = null;

    if (outcome.type === "saved" || outcome.current === request.content) {
      base = request.content;
      knownInFlight.delete(request.content);
      unresolved = null;
      failed = false;
      retry = true;
      blocked = false;
      error = null;
      if (text === request.content) removeOwnedBackup();
      else refreshOwnedBackup();
      notify();
      return true;
    }

    if (knownInFlight.has(outcome.current)) {
      // 리로드 전 요청이 이미 착지한 원문이다. 기준만 옮기고 최신 text를 이어 저장한다.
      base = outcome.current;
      knownInFlight.delete(outcome.current);
      unresolved = null;
      failed = false;
      retry = true;
      blocked = false;
      error = null;
      refreshOwnedBackup();
      notify();
      return true;
    }

    // 알 수 없는 원문은 덮어쓰지 않는다. 다음 입력 수락 때까지 자동 저장을 멈춘다.
    knownInFlight.delete(request.content);
    unresolved = null;
    failed = true;
    retry = false;
    blocked = true;
    error = CONFLICT_ERROR;
    refreshOwnedBackup();
    notify();
    return false;
  }

  function startLoop(): Promise<void> {
    if (running) return running;
    if (!open || blocked || (failed && !retry)) return Promise.resolve();
    if (text === base && unresolved === null) return Promise.resolve();
    const gen = generation;
    const seq = ++loopSeq;
    const loop = (async () => {
      try {
        while (open && gen === generation && !blocked && (text !== base || unresolved !== null)) {
          const again = await saveOnce(gen);
          if (!again) break;
        }
      } finally {
        if (gen === generation) inFlight = null;
        if (loopSeq === seq) running = null;
        notify();
      }
    })();
    running = loop;
    return loop;
  }

  async function commitRead(next: NoteScope, disk: string, backup: NotepadDraftBackup | null): Promise<void> {
    generation += 1;
    scope = next;
    open = true;
    blocked = false;
    failed = false;
    retry = true;
    unresolved = null;
    inFlight = null;
    knownInFlight.clear();

    if (backup === null) {
      base = disk;
      text = disk;
      error = null;
      claimBackupSlot(next);
      notify();
      return;
    }

    if (disk === backup.text) {
      base = disk;
      text = disk;
      error = null;
      claimBackupSlot(next);
      removeOwnedBackup();
      notify();
      return;
    }

    if (disk === backup.base || (backup.inFlight !== undefined && disk === backup.inFlight)) {
      base = disk;
      text = backup.text;
      error = null;
      if (backup.inFlight !== undefined) knownInFlight.add(backup.inFlight);
      claimBackupSlot(next);
      if (text === base) removeOwnedBackup();
      else if (ownedRaw !== null) writeOwnedBackup();
      notify();
      if (text !== base) void startLoop();
      return;
    }

    // 디스크가 base도 알려진 inFlight도 최신 text도 아니다 — 초안을 보존하고 멈춘다.
    base = backup.base;
    text = backup.text;
    blocked = true;
    failed = true;
    retry = false;
    error = CONFLICT_ERROR;
    if (backup.inFlight !== undefined) knownInFlight.add(backup.inFlight);
    claimBackupSlot(next);
    notify();
  }

  function acceptOnlyOpenScope(target: NoteScope): void {
    if (target.type === "workspace" && closedReads.has(target.workspace)) {
      fail(CLOSED_ERROR);
      throw new Error(CLOSED_ERROR);
    }
  }

  /** 읽기 토큰을 잡고 디스크를 읽는다. 더 새 요청이 있으면 null 로 결과를 버린다. */
  async function readDisk(next: NoteScope): Promise<string | null> {
    const token = ++readSeq;
    reading.set(token, next);
    let disk: string;
    try {
      disk = await ipc.read(next);
    } catch (cause) {
      const closed = takeClosedRead(next);
      if (token !== readSeq) {
        if (!closed) return null;
        fail(CLOSED_ERROR);
        throw new Error(CLOSED_ERROR);
      }
      const message = describe(LOAD_ERROR, cause);
      fail(message);
      throw new Error(message);
    } finally {
      reading.delete(token);
    }
    if (takeClosedRead(next)) {
      fail(CLOSED_ERROR);
      throw new Error(CLOSED_ERROR);
    }
    return token === readSeq ? disk : null;
  }

  async function openScope(next: NoteScope): Promise<void> {
    if (open) {
      if (scope !== null && sameScope(scope, next)) return;
      fail(ALREADY_OPEN_ERROR);
      throw new Error(ALREADY_OPEN_ERROR);
    }
    acceptOnlyOpenScope(next);

    let backup: NotepadDraftBackup | null;
    try {
      backup = readBackup();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : BACKUP_INVALID_ERROR;
      fail(message);
      throw new Error(message);
    }
    if (backup !== null && !sameScope(backup.scope, next)) {
      fail(OTHER_DRAFT_ERROR);
      throw new Error(OTHER_DRAFT_ERROR);
    }

    const disk = await readDisk(next);
    if (disk === null) return;

    await commitRead(next, disk, backup);
  }

  async function switchScope(next: NoteScope): Promise<void> {
    if (!open) {
      await openScope(next);
      return;
    }
    if (scope !== null && sameScope(scope, next)) return;

    acceptOnlyOpenScope(next);
    await flush();
    // flush 중 권위 있는 닫기로 세션이 폐기됐으면 닫힌 scope를 다시 열지 않는다.
    if (!open) return;
    acceptOnlyOpenScope(next);

    const disk = await readDisk(next);
    if (disk === null) return;

    await commitRead(next, disk, null);
  }

  async function flush(): Promise<void> {
    clearTimer();
    if (!open) return;

    if (blocked) throw new Error(error ?? CONFLICT_ERROR);
    // 명시적 flush 호출 자체를 재시도 기회로 본다. debounce 타이머는 새 입력이 있을 때만
    // 다시 시도하고, 알 수 없는 원문 충돌(blocked)은 여기서도 덮어쓰지 않는다.
    if (failed) retry = true;

    await startLoop();
    if (text !== base || failed || unresolved !== null) {
      throw new Error(error ?? SAVE_ERROR);
    }
    if (isClean()) removeOwnedBackup();
  }

  const api: NotepadState = {
    async open(next) {
      await openScope(next);
    },

    async recover() {
      let backup: NotepadDraftBackup | null;
      try {
        backup = readBackup();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : BACKUP_INVALID_ERROR;
        fail(message);
        return true;
      }
      if (backup === null) return false;
      try {
        await openScope(backup.scope);
      } catch {
        // 오류는 snapshot에 남는다 — 복구 대상이 있었다는 사실은 true로 알린다.
      }
      return true;
    },

    acceptText(next) {
      if (!open) {
        fail(NOT_OPEN_ERROR);
        return false;
      }
      if (frozen) return false;
      if (next === text) return true;
      if (new TextEncoder().encode(next).byteLength > MAX_NOTE_BYTES) {
        fail(SIZE_LIMIT_ERROR);
        return false;
      }

      const before = text;
      text = next;
      blocked = false;
      retry = true;
      if (error === SIZE_LIMIT_ERROR || error === BACKUP_ERROR) error = null;
      try {
        ownedRaw = writeBackup();
      } catch {
        text = before;
        fail(BACKUP_ERROR);
        return false;
      }

      if (text === base && !failed && inFlight === null && unresolved === null) {
        removeOwnedBackup();
        notify();
        return true;
      }
      scheduleSave();
      notify();
      return true;
    },

    async setScope(next) {
      await switchScope(next);
    },

    async followWorkspace(workspace) {
      if (!open || scope === null || scope.type !== "workspace") return false;
      if (workspace === null || workspace === scope.workspace) return false;
      try {
        await switchScope({ type: "workspace", workspace });
        return true;
      } catch {
        return false;
      }
    },

    async flush() {
      await flush();
    },

    discardClosedWorkspace(workspace) {
      const sessionMatches = scope !== null && scope.type === "workspace" && scope.workspace === workspace;
      let backupMatches = false;
      try {
        const backup = readBackup();
        backupMatches = backup !== null && backup.scope.type === "workspace" && backup.scope.workspace === workspace;
      } catch {
        // 손상된 백업이면 어느 scope인지 알 수 없다 — 현재 세션이 대상일 때만 함께 버린다.
      }
      const readMatches = [...reading.values()].some(
        (target) => target.type === "workspace" && target.workspace === workspace,
      );
      // 진행 중인 읽기만 표시로 막는다 — 읽기가 끝나면 지워지므로 무관한 닫기가 쌓이지 않는다.
      if (readMatches) closedReads.add(workspace);
      if (!sessionMatches && !backupMatches) return;

      // 진행 중 요청의 응답이 늦게 와도 폐기된 scope를 되살리지 않게 세대를 올린다.
      generation += 1;
      // 진행 중인 읽기는 폐기 뒤에 정착해도 세션을 다시 열지 않는다.
      readSeq += 1;
      clearTimer();
      inFlight = null;
      unresolved = null;
      failed = false;
      retry = true;
      blocked = false;
      running = null;
      open = false;
      scope = null;
      text = "";
      base = "";
      error = null;
      knownInFlight.clear();
      removeBackupDirect();
      notify();
    },

    dispose() {
      const clean = isClean();
      generation += 1;
      // dispose 도 늦은 읽기가 세션을 되살리지 못하게 모든 읽기 토큰을 무효화한다.
      readSeq += 1;
      clearTimer();
      if (clean) removeOwnedBackup();
      inFlight = null;
      unresolved = null;
      failed = false;
      retry = true;
      blocked = false;
      running = null;
      open = false;
      scope = null;
      text = "";
      base = "";
      error = null;
      knownInFlight.clear();
      notify();
    },

    freeze() {
      if (frozen) return;
      frozen = true;
      notify();
    },

    thaw() {
      if (!frozen) return;
      frozen = false;
      notify();
    },

    isActive() {
      return open || inFlight !== null || raw() !== null;
    },

    getSnapshot() {
      return {
        scope,
        text,
        error,
        saving: timer !== null || inFlight !== null,
        dirty: open ? !isClean() : raw() !== null,
        frozen,
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  closedReadsOf.set(api, () => [...closedReads]);
  return api;
}

function isScope(value: unknown): value is NoteScope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; workspace?: unknown };
  if (candidate.type === "global") return true;
  return candidate.type === "workspace" && typeof candidate.workspace === "number";
}

function isBackup(value: unknown): value is NotepadDraftBackup {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NotepadDraftBackup>;
  if (!isScope(candidate.scope)) return false;
  if (typeof candidate.base !== "string" || typeof candidate.text !== "string") return false;
  return candidate.inFlight === undefined || typeof candidate.inFlight === "string";
}

/** 앱 전체가 공유하는 인스턴스. 모듈 import만으로는 IPC·타이머가 생기지 않는다. */
export const notepadState: NotepadState = createNotepadState();
