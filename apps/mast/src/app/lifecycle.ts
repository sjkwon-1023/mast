// 앱 수명 경계 — 정상 종료와 수동 리로드에서 메모의 최신 수락 입력을 먼저 flush 한다.
//
// 이 모듈은 state 모듈을 정적으로 import 하지 않는다. 한 번도 메모를 쓰지 않았고
// 백업도 없는 앱의 종료·리로드 경로에서 dynamic import 비용조차 내지 않기 위해서다.
// 자동 리로드(resetUi·supervisor)는 여기를 거치지 않는다 — sessionStorage 백업과
// 부팅 복구(recover)가 그 경계를 맡는다.

import { NOTEPAD_DRAFT_KEY } from "../shared/types";
import type { NotepadDraftBackup, WorkspaceId } from "../shared/types";
import { primaryModifier } from "../shared/platform";
import type { NotepadState } from "../features/notepad/state";
import type { MarkdownDraftReporter } from "../features/viewers/markdown/drafts";

export const QUIT_CONFIRM = "Quit mast and discard unsaved Markdown edits?";
export const RELOAD_CONFIRM =
  "Reload with unsaved Markdown edits? Drafts will be restored from this session.";
export const NOTE_QUIT_CONFIRM =
  "The note could not be saved. Quit anyway and lose the unsaved note draft?";

/** flush 했는데도 백업이 남아 있다는 것은 복구·저장을 끝내지 못했다는 뜻이다. */
const FLUSH_ERROR = "The note could not be saved. Your draft is kept.";

export interface CloseEventLike {
  preventDefault(): void;
}

export interface NotepadLifecycleDeps {
  confirm(message: string): Promise<boolean>;
  hasMarkdownDrafts(): boolean;
  showError(error: unknown): void;
  /** WebView 리로드 — flush 를 시도한 뒤 부른다. 실패해도 sessionStorage 백업이 리로드 뒤에 남는다. */
  reload(): void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** 테스트 경계 — 배포에서는 state 모듈의 singleton 을 dynamic import 한다. */
  loadState?(): Promise<NotepadState>;
}

export interface NotepadLifecycle {
  /** 창 close 가드에 그대로 등록하는 핸들러. 재진입은 닫기로 막는다. */
  handleClose(event: CloseEventLike): Promise<void>;
  /** Ctrl/Cmd+Shift+R — 수동 리로드도 같은 flush 정책을 쓴다. */
  installReloadKey(target?: Pick<Window, "addEventListener">): void;
  /** `window.__mast.reload` 가 쓰는 경로. */
  reload(): Promise<void>;
  /** 부팅 복구 — 백업이 있을 때만 state 모듈을 읽는다. */
  recover(): Promise<void>;
  /** 진행 중인 부팅 복구가 정착할 때까지 기다린다. 실패는 던지지 않는다. */
  awaitRecovery(): Promise<void>;
  attachState(state: NotepadState): void;
  attachReporter(reporter: MarkdownDraftReporter): void;
  awaitDirtyReport(): Promise<void>;
  /** macOS 종료 판정에 합성할 메모장 active 값. 모듈 미로드면 백업 슬롯으로 판단한다. */
  isNotepadActive(): boolean;
  /** 사이드바 닫기 경고용 — 이 워크스페이스 scope 의 비어 있지 않은 초안이 있는가. */
  notepadHasLocalContent(workspace: WorkspaceId): boolean;
  /** 사이드바 닫기 경고용 — 조회 도중 수락된 로컬 초안까지 확인 시점에 다시 본다. */
  notepadHasContent(
    workspace: WorkspaceId,
    lookup: (workspace: WorkspaceId) => Promise<boolean>,
  ): Promise<boolean>;
  /** 권위 있는 워크스페이스 닫기 성공 뒤 초안을 버린다. 대상이 없으면 로드하지 않는다. */
  discardClosedWorkspace(workspace: WorkspaceId): Promise<void>;
  /** snapshot 반영 — 이미 사라진 워크스페이스 scope 의 초안을 버린다. */
  discardClosedDrafts(alive: readonly WorkspaceId[]): Promise<void>;
}

export function createNotepadLifecycle(deps: NotepadLifecycleDeps): NotepadLifecycle {
  const storage = deps.storage ?? sessionStorage;

  let state: NotepadState | null = null;
  let loading: Promise<NotepadState> | null = null;
  let recovery: Promise<void> | null = null;
  /** 부팅 복구를 이미 시도했는가 — 정착한 실패를 flushNotepad 가 다시 기다리지 않는다. */
  let recoverySettled = false;
  let reporter: MarkdownDraftReporter | null = null;
  let closing = false;
  let reloading = false;
  /** 종료·리로드가 입력을 동결했는가 — 동결 뒤에 연결되는 state 에도 적용한다. */
  let freezeRequested = false;

  function backupSlotExists(): boolean {
    try {
      return storage.getItem(NOTEPAD_DRAFT_KEY) !== null;
    } catch {
      return false;
    }
  }

  function quitConfirmMessage(cause: unknown): string {
    const reason = cause instanceof Error ? cause.message : "";
    return reason ? `${NOTE_QUIT_CONFIRM} ${reason}` : NOTE_QUIT_CONFIRM;
  }

  function readBackup(): NotepadDraftBackup | null {
    let raw: string | null;
    try {
      raw = storage.getItem(NOTEPAD_DRAFT_KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null) return null;
      const candidate = value as Partial<NotepadDraftBackup>;
      if (typeof candidate.base !== "string" || typeof candidate.text !== "string") return null;
      const scope = candidate.scope;
      if (scope?.type === "global") return candidate as NotepadDraftBackup;
      if (scope?.type === "workspace" && typeof scope.workspace === "number") {
        return candidate as NotepadDraftBackup;
      }
      return null;
    } catch {
      return null;
    }
  }

  function hasLocalContent(workspace: WorkspaceId): boolean {
    if (state !== null) {
      const snapshot = state.getSnapshot();
      if (
        snapshot.scope !== null &&
        snapshot.scope.type === "workspace" &&
        snapshot.scope.workspace === workspace &&
        snapshot.text.length > 0
      ) {
        return true;
      }
    }
    const backup = readBackup();
    return (
      backup !== null &&
      backup.text.length > 0 &&
      backup.scope.type === "workspace" &&
      backup.scope.workspace === workspace
    );
  }

  function loadState(): Promise<NotepadState> {
    if (state !== null) return Promise.resolve(state);
    loading ??= (deps.loadState !== undefined
      ? deps.loadState()
      : import("../features/notepad/state").then((module) => module.notepadState)
    )
      .then((loaded) => {
        state = loaded;
        // 동결 중에 로드가 끝난 state 도 입력을 받지 않는다 (최초 지연 로딩 경로).
        if (freezeRequested) loaded.freeze();
        return loaded;
      })
      .catch((err: unknown) => {
        // 모듈 로드 실패는 다음 시도에서 다시 시도한다.
        loading = null;
        throw err;
      });
    return loading;
  }

  function recover(): Promise<void> {
    if (recovery !== null) return recovery;
    const attempt = (async () => {
      // 모듈이 없고 백업도 없으면 이 경로에서 아무 비용도 내지 않는다.
      if (state === null && !backupSlotExists()) return;
      const target = await loadState();
      try {
        if (!(await target.recover())) return;
        // 열지 못했다(읽기 실패·다른 scope 등) — 오류와 백업을 그대로 두고
        // 서랍이 이 scope 로 열릴 때 사용자가 확인한다.
        if (target.getSnapshot().scope === null) return;
        await target.flush();
        target.dispose();
      } finally {
        reporter?.refresh();
      }
    })();
    recovery = attempt;
    // 정착한 복구는 다시 기다리지 않는다 — 오류가 해소된 뒤의 flush 는 state.flush 가
    // 디스크 상태를 다시 확인하고 재시도한다.
    const settled = (): void => {
      recoverySettled = true;
      if (recovery === attempt) recovery = null;
    };
    void attempt.then(settled, settled);
    return attempt;
  }

  /** 종료·리로드가 flush 를 시작하기 전에 메모 입력을 동결한다. */
  function freezeNotepad(): void {
    freezeRequested = true;
    state?.freeze();
  }

  /** 취소된 종료에서만 입력을 다시 연다 — 종료가 진행되면 동결을 유지한다. */
  function thawNotepad(): void {
    freezeRequested = false;
    state?.thaw();
  }

  async function flushNotepad(): Promise<void> {
    // 아직 시도하지 않았으면 복구부터 한다. 이미 정착한 복구는 다시 기다리지 않고
    // state.flush 가 디스크 상태를 다시 확인해 저장을 재시도한다. 진행 중인 복구는 기다리며,
    // 이 호출에서 처음 드러난 복구 실패는 그대로 올린다.
    if (recovery !== null) {
      await recovery;
    } else if (!recoverySettled) {
      await recover();
    }
    if (state !== null) await state.flush();
    // flush 뒤에도 백업이 남아 있으면 복구·저장이 끝나지 않은 것이다 — 종료·리로드를
    // 완료하지 않는다. 다음 입력이나 재시도에서 다시 시도할 수 있다.
    if (backupSlotExists()) throw new Error(FLUSH_ERROR);
  }

  async function reload(): Promise<void> {
    if (reloading) return;
    reloading = true;
    freezeNotepad();
    try {
      try {
        await flushNotepad();
      } catch (err) {
        // sessionStorage 백업은 리로드 뒤 부팅 복구가 다시 시도한다 — 리로드는 막지 않는다.
        console.error("notepad flush before reload failed", err);
      }
      deps.reload();
    } finally {
      reloading = false;
    }
  }

  async function discardClosedWorkspace(workspace: WorkspaceId): Promise<void> {
    if (state !== null) {
      state.discardClosedWorkspace(workspace);
      return;
    }
    if (!backupSlotExists()) return;
    const backup = readBackup();
    if (
      backup === null ||
      backup.scope.type !== "workspace" ||
      backup.scope.workspace !== workspace
    ) {
      return;
    }
    const target = await loadState();
    target.discardClosedWorkspace(workspace);
  }

  /** snapshot 에 없는 워크스페이스의 초안만 버린다. 모듈·백업이 없으면 조회 한 번이다. */
  async function discardClosedDrafts(alive: readonly WorkspaceId[]): Promise<void> {
    const aliveIds = new Set(alive);
    const targets = new Set<WorkspaceId>();
    if (state !== null) {
      const scope = state.getSnapshot().scope;
      if (scope?.type === "workspace" && !aliveIds.has(scope.workspace)) {
        targets.add(scope.workspace);
      }
    }
    if (backupSlotExists()) {
      const backup = readBackup();
      if (backup?.scope.type === "workspace" && !aliveIds.has(backup.scope.workspace)) {
        targets.add(backup.scope.workspace);
      }
    }
    if (targets.size === 0) return;
    for (const workspace of targets) await discardClosedWorkspace(workspace);
    reporter?.refresh();
  }

  return {
    async handleClose(event) {
      if (closing) {
        // flush·확인 중에 다시 온 close(단축키 연타, Dock Quit)는 겹쳐 처리하지 않는다.
        event.preventDefault();
        return;
      }
      closing = true;
      // flush 가 시작되면 서랍이 입력을 받지 않는다 — 창이 파괴되기 전까지의 새 입력이
      // 마지막 flush 뒤에 남지 않게 한다.
      freezeNotepad();
      let cancelled = false;
      const cancel = (): void => {
        cancelled = true;
        event.preventDefault();
      };
      try {
        let flushError: unknown = null;
        try {
          await flushNotepad();
        } catch (err) {
          flushError = err;
        }
        // 해결할 수 없는 초안(사라진 워크스페이스·알 수 없는 디스크 원문)이 종료를
        // 영구히 막지 않도록, 한 번 확인하고 사용자의 선택을 따른다.
        if (flushError !== null) {
          let confirmed: boolean;
          try {
            confirmed = await deps.confirm(quitConfirmMessage(flushError));
          } catch (err) {
            // 확인을 못 했으면 초안을 보존한 채 닫지 않는다.
            cancel();
            deps.showError(err);
            return;
          }
          if (!confirmed) {
            cancel();
            deps.showError(flushError);
            return;
          }
        }
        // 메모만 있으면 확인 없이 닫는다 — Markdown draft 가 있을 때만 기존 흐름을 탄다.
        if (!deps.hasMarkdownDrafts()) return;
        try {
          if (!(await deps.confirm(QUIT_CONFIRM))) cancel();
        } catch (err) {
          // 확인을 못 했으면 닫지 않는다 — draft 를 묻지 않고 버리는 쪽으로 넘어가지 않는다.
          cancel();
          deps.showError(err);
        }
      } finally {
        if (cancelled) thawNotepad();
        closing = false;
      }
    },

    installReloadKey(target = window) {
      target.addEventListener(
        "keydown",
        (ev) => {
          if (!ev.isComposing && primaryModifier(ev) && ev.shiftKey && ev.code === "KeyR") {
            ev.preventDefault();
            if (!deps.hasMarkdownDrafts()) {
              void reload();
              return;
            }
            deps.confirm(RELOAD_CONFIRM).then(
              (ok) => {
                if (ok) void reload();
              },
              (err: unknown) => deps.showError(err),
            );
          }
        },
        { capture: true },
      );
    },

    reload,

    recover,

    async awaitRecovery() {
      if (recovery === null) return;
      try {
        await recovery;
      } catch {
        // 복구 실패는 snapshot 의 오류로 남는다 — 서랍은 디스크를 직접 읽는다.
      }
    },

    attachState(next) {
      state = next;
      // dynamic import 가 종료·리로드 도중 끝난 경우에도 동결을 이어받는다.
      if (freezeRequested) state.freeze();
    },

    attachReporter(next) {
      reporter = next;
    },

    async awaitDirtyReport() {
      await reporter?.waitForDelivery();
    },

    isNotepadActive() {
      return state !== null ? state.isActive() : backupSlotExists();
    },

    notepadHasLocalContent(workspace) {
      return hasLocalContent(workspace);
    },

    async notepadHasContent(workspace, lookup) {
      if (hasLocalContent(workspace)) return true;
      if (await lookup(workspace)) return true;
      // 조회를 기다리는 동안 서랍이 수락한 입력은 로컬 초안에만 있다 — 정하는 시점에 다시 본다.
      return hasLocalContent(workspace);
    },

    async discardClosedWorkspace(workspace) {
      await discardClosedWorkspace(workspace);
    },

    async discardClosedDrafts(alive) {
      await discardClosedDrafts(alive);
    },
  };
}
