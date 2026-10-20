// 메모장 오른쪽 서랍의 DOM 어댑터.
//
// 저장·타이머·초안은 state.ts 만 소유한다 (ADR-0025). 이 모듈은 textarea 입력을
// state 에 넘기고 snapshot 을 DOM 에 반영할 뿐이다. 모듈은 첫 토글에서 dynamic
// import 되므로, 한 번도 열지 않은 앱에는 DOM·구독·timer 가 생기지 않는다.
//
// C5 는 워크스페이스 전환을 따라가는 sync 와, macOS dirty 보고가 끝난 뒤에만
// 편집을 여는 준비 단계를 더한다. 후자는 host 의 선택 콜백이라 Windows 경로에는 없다.

import type { NoteScope, StateSnapshot, WorkspaceId } from "../../shared/types";
import { notepadState, pendingDraft } from "./state";
import type { NotepadState } from "./state";

export interface NotepadHost {
  getSnapshot(): StateSnapshot | null;
  /** 서랍을 닫은 뒤 active pane 으로 포커스를 돌리는 기존 보상 경로. */
  focusActivePane(): void;
  /** macOS 전용 — 합성 dirty 보고가 백엔드에 전달된 뒤에야 편집을 시작한다. */
  awaitDirtyReport?: () => Promise<void>;
  /** 부팅 복구가 진행 중이면 정착할 때까지 기다린다 — 복구가 연 세션을 덮지 않는다. */
  awaitBootRecovery?: () => Promise<void>;
  /** macOS 전용 — 메모 active 변화를 보고 값에 반영한다. */
  refreshDirtyReport?: () => void;
}

export interface NotepadFeature {
  /** 열려 있으면 flush 후 닫고, 닫혀 있으면 연다. */
  toggle(): Promise<void>;
  /** flush 성공 뒤에만 닫는다. 실패하면 서랍을 열어 둔다. */
  close(): Promise<void>;
  isOpen(): boolean;
  /** snapshot 변경 반영 — 서랍이 닫혀 있으면 아무것도 하지 않는다. */
  sync(snapshot: StateSnapshot): void;
  /** 권위 있는 워크스페이스 닫기 성공 뒤: 그 scope 로 열린 서랍을 flush 없이 닫는다. */
  abandon(workspace: WorkspaceId): void;
}

interface Drawer {
  dialog: HTMLDialogElement;
  textarea: HTMLTextAreaElement;
  workspaceButton: HTMLButtonElement;
  globalButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  status: HTMLElement;
  error: HTMLElement;
  workspaceLabel: HTMLElement;
  focusBefore: HTMLElement | null;
  /** 열 때의 active — 포커스 복원 기준 (전환 성공 시 현재 값으로 갱신). */
  focusWorkspace: WorkspaceId | null;
  /** 최신 snapshot 의 active — "This workspace" 버튼 대상. */
  activeWorkspace: WorkspaceId | null;
  hasWorkspaces: boolean;
  /** 마지막으로 시도한 범위 — 읽기 실패로 snapshot.scope 가 null 일 때 표시용. */
  attemptedScope: NoteScope;
  /** macOS dirty 보고 전달을 기다리는 동안 편집을 막는다. */
  preparing: boolean;
  /** 첫 읽기가 정착할 때까지 범위 버튼을 막는다. */
  opening: boolean;
  /** 보고 실패로 이 서랍의 편집을 시작하지 않았다. */
  blocked: boolean;
  /** 읽기 실패 시 백업 내용을 보여 주기만 한다 (state 세션은 열리지 않았다). */
  fallbackText: string | null;
  localError: string | null;
  unsubscribe: (() => void) | null;
}

const REPORT_ERROR =
  "Editing is disabled because Mast could not report the unsaved note state.";

const sameScope = (a: NoteScope, b: NoteScope): boolean =>
  a.type === "global" ? b.type === "global" : b.type === "workspace" && a.workspace === b.workspace;

function createButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = "notepad-scope";
  button.setAttribute("aria-pressed", "false");
  return button;
}

function buildDrawer(
  hasWorkspaces: boolean,
  scope: NoteScope,
  focusBefore: HTMLElement | null,
  active: WorkspaceId | null,
): Drawer {
  const dialog = document.createElement("dialog");
  // showModal 을 쓰지 않는다 — pane 입력을 막지 않는 비모달 서랍이다.
  // open 속성만 세우면 backdrop 이 생기지 않고, 브라우저 뷰의 dialog[open] 감지도 동작한다.
  dialog.className = "notepad-drawer";
  dialog.setAttribute("aria-label", "Notepad");

  const header = document.createElement("div");
  header.className = "notepad-header";
  const title = document.createElement("h2");
  title.className = "notepad-title";
  title.textContent = "Notepad";
  // 현재 워크스페이스와 다른 scope 를 보고 있을 때만 이름을 보여 준다.
  const workspaceLabel = document.createElement("span");
  workspaceLabel.className = "notepad-workspace";
  workspaceLabel.hidden = true;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "notepad-close";
  closeButton.textContent = "Close";
  closeButton.setAttribute("aria-label", "Close notepad");

  const scopes = document.createElement("div");
  scopes.className = "notepad-scopes";
  scopes.setAttribute("role", "group");
  scopes.setAttribute("aria-label", "Note scope");
  const workspaceButton = createButton("This workspace");
  const globalButton = createButton("Global");
  scopes.append(workspaceButton, globalButton);

  const label = document.createElement("label");
  label.className = "notepad-note";
  label.textContent = "Note";
  const textarea = document.createElement("textarea");
  textarea.className = "notepad-text";
  textarea.disabled = true;
  textarea.spellcheck = false;
  // WorkspaceView::tryResolveFocus 가 snapshot 렌더에서 이 입력의 포커스를 빼앗지 않는다.
  textarea.dataset.keepFocus = "";
  label.append(textarea);

  const status = document.createElement("div");
  status.className = "notepad-status";
  status.setAttribute("role", "status");
  const error = document.createElement("div");
  error.className = "notepad-error";
  error.setAttribute("role", "alert");
  error.hidden = true;

  header.append(title, workspaceLabel, closeButton);
  dialog.append(header, scopes, label, status, error);

  return {
    dialog,
    textarea,
    workspaceButton,
    globalButton,
    closeButton,
    status,
    error,
    workspaceLabel,
    focusBefore,
    focusWorkspace: active,
    activeWorkspace: active,
    hasWorkspaces,
    attemptedScope: scope,
    preparing: false,
    opening: false,
    blocked: false,
    fallbackText: null,
    localError: null,
    unsubscribe: null,
  };
}

export function createNotepadFeature(
  host: NotepadHost,
  state: NotepadState = notepadState,
): NotepadFeature {
  let drawer: Drawer | null = null;
  /** 진행 중인 열기. 로딩 중 토글은 이 작업의 정착을 기다리지 않고 DOM 만 거둔다. */
  let openTask: Promise<void> | null = null;
  /** 오래된 읽기 완료가 DOM·본문을 되살리지 않게 하는 세대. */
  let generation = 0;
  let closing = false;
  let switching = false;
  /** snapshot sync 는 한 번에 하나만 돌고, 그 사이 것은 최신 하나만 남긴다. */
  let pendingSync: StateSnapshot | null = null;
  let syncRunning = false;

  function render(): void {
    const current = drawer;
    if (current === null) return;
    const snapshot = state.getSnapshot();
    const shownScope = snapshot.scope ?? current.attemptedScope;

    const shownText = snapshot.scope === null && current.fallbackText !== null
      ? current.fallbackText
      : snapshot.text;
    if (document.activeElement !== current.textarea && current.textarea.value !== shownText) {
      current.textarea.value = shownText;
    }
    // 읽기 실패(snapshot.scope === null), 보고 대기, macOS 보고 실패, 범위 전환·첫 읽기 중에는
    // 편집과 범위 변경을 시작하지 않는다. 닫기는 로딩 취소 경로라 계속 열어 둔다.
    const busy = switching || current.opening;
    current.textarea.disabled =
      busy || current.preparing || current.blocked || snapshot.scope === null || snapshot.frozen;
    current.workspaceButton.disabled = busy || !current.hasWorkspaces;
    current.globalButton.disabled = busy;
    current.closeButton.disabled = switching;
    current.workspaceButton.setAttribute(
      "aria-pressed",
      String(shownScope.type === "workspace"),
    );
    current.globalButton.setAttribute("aria-pressed", String(shownScope.type === "global"));
    current.status.textContent = snapshot.saving ? "Saving…" : "";
    const shownError = snapshot.error ?? current.localError;
    current.error.textContent = shownError ?? "";
    current.error.hidden = shownError === null;

    const latest = host.getSnapshot();
    const shownWorkspace = shownScope.type === "workspace" ? shownScope.workspace : null;
    const shownName =
      shownWorkspace === null
        ? null
        : latest?.state.workspaces.find((w) => w.id === shownWorkspace)?.name ?? null;
    const differentWorkspace =
      shownWorkspace !== null && latest !== null && latest.state.activeWorkspace !== shownWorkspace;
    current.workspaceLabel.textContent =
      differentWorkspace && shownName !== null ? `In "${shownName}"` : "";
    current.workspaceLabel.hidden = !(differentWorkspace && shownName !== null);
    host.refreshDirtyReport?.();
  }

  function teardown(current: Drawer): void {
    current.unsubscribe?.();
    current.unsubscribe = null;
    // dialog 를 먼저 닫아야 browser 뷰의 dialog[open] MutationObserver 가 숨김/복원을 예약한다.
    current.dialog.removeAttribute("open");
    current.dialog.remove();
  }

  function restoreFocus(current: Drawer): void {
    const active = host.getSnapshot()?.state.activeWorkspace ?? null;
    const target = current.focusBefore;
    if (
      target !== null &&
      target !== document.body &&
      target.isConnected &&
      active === current.focusWorkspace
    ) {
      target.focus();
      return;
    }
    host.focusActivePane();
  }

  function discardSession(): void {
    state.dispose();
    host.refreshDirtyReport?.();
  }

  function cancelOpening(): void {
    const current = drawer;
    generation += 1;
    drawer = null;
    // state.open 은 취소 API 가 없다 — 정착하면 openTask 가 dispose 로 세션을 거둔다.
    if (current !== null) {
      teardown(current);
      restoreFocus(current);
    }
  }

  /** 편집을 열기 전에 macOS dirty 보고 전달을 기다린다. 실패하면 편집을 열지 않는다. */
  async function prepareEditing(current: Drawer): Promise<boolean> {
    const awaitReport = host.awaitDirtyReport;
    if (awaitReport === undefined) return true;
    current.preparing = true;
    render();
    try {
      await awaitReport();
    } catch {
      if (drawer === current) {
        current.preparing = false;
        current.blocked = true;
        current.localError = REPORT_ERROR;
        render();
      }
      return false;
    }
    if (drawer !== current) return false;
    current.preparing = false;
    // 이전 보고 실패로 세운 차단은 성공한 보고가 해제한다.
    current.blocked = false;
    if (current.localError === REPORT_ERROR) current.localError = null;
    render();
    return true;
  }

  /** 워크스페이스 scope 일 때 active workspace 로 따라가고, 보고 전달 뒤에 편집을 연다. */
  async function followActive(current: Drawer, workspace: WorkspaceId): Promise<boolean> {
    switching = true;
    render();
    try {
      const followed = await state.followWorkspace(workspace);
      if (drawer !== current || !followed) return false;
      current.attemptedScope = { type: "workspace", workspace };
      current.focusWorkspace = workspace;
      current.textarea.value = state.getSnapshot().text;
      return await prepareEditing(current);
    } finally {
      switching = false;
      if (drawer === current) render();
    }
  }

  /** 첫 열기·수동 전환·sync 따라가기가 정착한 뒤 최신 active workspace 와 계속 맞춘다.
   *  따라가는 동안 들어온 sync 는 switching 때문에 생략되므로, 각 읽기가 끝난 뒤
   *  최신 snapshot 을 다시 확인해야 건너뛴 전환이 남지 않는다. */
  async function reconcileActiveWorkspace(current: Drawer): Promise<void> {
    // 진행 중인 따라가기가 있으면 그 루프가 정착 뒤 최신 값을 다시 확인한다.
    if (drawer !== current || switching) return;
    let lastAttempted: WorkspaceId | null = null;
    while (drawer === current) {
      const latest = host.getSnapshot();
      const active = latest?.state.activeWorkspace ?? null;
      if (latest !== null) {
        current.activeWorkspace = active;
        current.hasWorkspaces = latest.state.workspaces.length > 0 && active !== null;
      }
      const shown = state.getSnapshot().scope;
      if (shown?.type !== "workspace" || active === null || active === shown.workspace) {
        render();
        return;
      }
      // 따라가기가 실패하면 이전 scope 에 머문다. 같은 active 를 연속으로 다시 시도하지 않는다.
      if (active === lastAttempted) {
        render();
        return;
      }
      lastAttempted = active;
      if (!(await followActive(current, active))) return;
    }
  }

  async function openDrawer(): Promise<void> {
    const snapshot = host.getSnapshot();
    // 첫 snapshot 전에는 쓸 범위가 없다 — 키만 소비하고 편집을 시작하지 않는다.
    if (snapshot === null) return;

    const active = snapshot.state.activeWorkspace;
    const hasWorkspaces = snapshot.state.workspaces.length > 0 && active !== null;
    // 미완료 백업은 그 scope 로만 열 수 있다. 다른 scope 로 열면 OTHER_DRAFT_ERROR 로
    // 막혀 사용자가 초안과 오류를 볼 수 없다.
    const pending = pendingDraft();
    const scope: NoteScope =
      pending?.scope ??
      (hasWorkspaces && active !== null
        ? { type: "workspace", workspace: active }
        : { type: "global" });
    // 미완료 백업은 그 scope 로 열어 보여 준다 — active workspace 로 곧바로 되돌리지 않는다.
    const fromDraft = pending !== null && sameScope(pending.scope, scope);
    const focusBefore =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const token = ++generation;

    const current = buildDrawer(hasWorkspaces, scope, focusBefore, active);
    drawer = current;
    document.body.append(current.dialog);
    current.dialog.setAttribute("open", "");
    current.unsubscribe = state.subscribe(render);
    current.closeButton.addEventListener("click", () => void close());
    current.textarea.addEventListener("input", () => {
      if (drawer !== current) return;
      if (!state.acceptText(current.textarea.value)) {
        // 거부된 입력(바이트 상한·백업 실패)은 마지막으로 수락한 본문으로 되돌린다.
        current.textarea.value = state.getSnapshot().text;
      }
    });
    current.dialog.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || ev.isComposing || ev.repeat) return;
      ev.preventDefault();
      ev.stopPropagation();
      void close();
    });
    current.workspaceButton.addEventListener("click", () => {
      const target = current.activeWorkspace ?? active;
      if (target === null) return;
      void switchScope({ type: "workspace", workspace: target });
    });
    current.globalButton.addEventListener("click", () => void switchScope({ type: "global" }));
    // macOS 는 보고 전달 전까지 편집을 열지 않는다. state.open 의 notify 가 render 를
    // 부르는 순간에도 textarea 가 열리지 않도록 open 전에 세운다.
    const awaitReport = host.awaitDirtyReport;
    const awaitRecovery = host.awaitBootRecovery;
    if (awaitReport !== undefined) current.preparing = true;
    // 첫 읽기가 정착하기 전에는 범위 버튼을 누를 수 없다 — 두 읽기가 경합하지 않는다.
    current.opening = true;
    render();

    const task = (async () => {
      if (awaitRecovery !== undefined) {
        try {
          await awaitRecovery();
        } catch {
          // 복구 대기 실패는 무시하고 디스크를 직접 읽는다 — 오류는 state snapshot 에 남는다.
        }
        // 복구가 연 세션은 복구 쪽 소유다 — 취소된 열기는 손대지 않고 돌아간다.
        if (token !== generation || drawer !== current) return;
      }
      try {
        await state.open(scope);
      } catch {
        current.preparing = false;
        if (token !== generation || drawer !== current) {
          discardSession();
          return;
        }
        // 읽기 자체가 실패해도 매칭되는 백업이 있으면 내용을 보여 준다.
        // state 세션이 열리지 않았으므로 편집은 비활성이다.
        if (
          pending !== null &&
          sameScope(pending.scope, scope) &&
          state.getSnapshot().scope === null
        ) {
          current.fallbackText = pending.text;
        }
        render();
        return;
      }
      if (token !== generation || drawer !== current) {
        discardSession();
        return;
      }
      // macOS: dirty 보고가 백엔드에 닿기 전에 입력을 받으면 첫 입력의 비동기 보고
      // 경합이 생긴다. 전달을 기다린 뒤에만 textarea 를 연다.
      if (!(await prepareEditing(current))) {
        if (token !== generation || drawer !== current) discardSession();
        return;
      }
      if (token !== generation || drawer !== current) {
        discardSession();
        return;
      }
      current.opening = false;
      render();
      current.textarea.value = state.getSnapshot().text;
      // 비동기 읽기 중 사용자가 포커스를 옮겼으면 빼앗지 않는다.
      if (document.activeElement === focusBefore) current.textarea.focus();
      // 읽는 동안 워크스페이스가 바뀌었으면 건너뛴 sync 대신 최신 값으로 한 번 맞춘다.
      if (!fromDraft) await reconcileActiveWorkspace(current);
      // 보정 읽기 중 취소됐으면 그 읽기가 연 세션을 첫 읽기 취소와 같은 방식으로 거둔다.
      // drawer 가 남아 있으면 새 열기의 소유이므로 건드리지 않는다.
      if (drawer === null && token !== generation) discardSession();
    })();

    openTask = task;
    try {
      await task;
    } finally {
      if (openTask === task) openTask = null;
      if (drawer === current) {
        current.opening = false;
        render();
      }
    }
  }

  async function switchScope(target: NoteScope): Promise<void> {
    const current = drawer;
    if (current === null || switching || closing || current.opening) return;
    if (target.type === "workspace" && !current.hasWorkspaces) return;
    const before = state.getSnapshot().scope;
    if (before !== null && sameScope(before, target)) {
      // 보고 실패로 잠긴 편집은 같은 범위 버튼으로 보고를 다시 시도해 연다.
      if (!current.blocked) {
        render();
        return;
      }
      switching = true;
      render();
      try {
        if (!(await prepareEditing(current))) return;
      } finally {
        switching = false;
        if (drawer === current) render();
      }
      await reconcileActiveWorkspace(current);
      return;
    }

    switching = true;
    render();
    let settled = false;
    try {
      await state.setScope(target);
      if (drawer !== current) return;
      current.attemptedScope = target;
      current.textarea.value = state.getSnapshot().text;
      // 첫 읽기 실패 뒤의 재시도도 편집을 열기 전에 dirty 보고 전달을 기다린다.
      if (!(await prepareEditing(current))) return;
      settled = true;
    } catch {
      // state 가 기존 범위와 오류를 snapshot 에 남긴다 — 버튼은 그 값으로 되돌린다.
    } finally {
      switching = false;
      if (drawer === current) render();
    }
    if (settled) await reconcileActiveWorkspace(current);
  }

  function closeClosedScope(current: Drawer, workspace: WorkspaceId): void {
    if (current.attemptedScope.type !== "workspace") return;
    if (current.attemptedScope.workspace !== workspace) return;
    if (drawer !== current) return;
    drawer = null;
    teardown(current);
    // 백엔드가 이미 메모를 지웠다 — 저장을 시도하지 않고 세션만 정리한다.
    discardSession();
    restoreFocus(current);
  }

  async function syncStep(snapshot: StateSnapshot): Promise<void> {
    const current = drawer;
    if (current === null) return;

    const active = snapshot.state.activeWorkspace;
    const hasWorkspaces = snapshot.state.workspaces.length > 0 && active !== null;
    current.activeWorkspace = active;
    current.hasWorkspaces = hasWorkspaces;

    const shown = state.getSnapshot().scope ?? current.attemptedScope;
    // 외부 snapshot(__mast.dispatch 등)으로 열린 scope 의 워크스페이스가 사라졌다.
    // 새 ID 로 바꿔 저장하지 않고 초안을 버린 뒤 서랍을 닫는다.
    if (
      shown.type === "workspace" &&
      !snapshot.state.workspaces.some((w) => w.id === shown.workspace)
    ) {
      state.discardClosedWorkspace(shown.workspace);
      closeClosedScope(current, shown.workspace);
      return;
    }

    // Global 은 워크스페이스 전환을 따라가지 않는다 — 보던 메모를 그대로 둔다.
    if (
      shown.type === "workspace" &&
      active !== null &&
      active !== shown.workspace &&
      !switching &&
      !closing
    ) {
      // 실패하면 state 가 이전 scope·text·오류를 유지한다. render 가 머리에 그
      // scope 의 워크스페이스 이름을 표시한다.
      await reconcileActiveWorkspace(current);
      return;
    }

    render();
  }

  function sync(snapshot: StateSnapshot): void {
    pendingSync = snapshot;
    if (syncRunning) return;
    syncRunning = true;
    void (async () => {
      try {
        while (pendingSync !== null) {
          const next = pendingSync;
          pendingSync = null;
          await syncStep(next);
        }
      } finally {
        syncRunning = false;
      }
    })();
  }

  async function close(): Promise<void> {
    const current = drawer;
    // 범위 전환의 flush·read 와 닫기의 flush 가 겹치지 않게 한다.
    if (current === null || closing || switching) return;
    if (openTask !== null) {
      // 아직 state.open 이 정착하지 않았다 — flush 대상이 없으므로 읽기 결과를 폐기한다.
      cancelOpening();
      return;
    }
    closing = true;
    try {
      await state.flush();
    } catch {
      // flush 실패 — 초안과 서랍을 유지하고 snapshot 의 오류를 보여 준다.
      closing = false;
      render();
      return;
    }
    if (drawer !== current) {
      closing = false;
      return;
    }
    drawer = null;
    teardown(current);
    state.dispose();
    closing = false;
    // 메모가 inactive 가 됐다 — Markdown 이 clean 이면 백엔드에 Clean 을 보고한다.
    host.refreshDirtyReport?.();
    restoreFocus(current);
  }

  return {
    async toggle() {
      if (openTask !== null) {
        // 로딩 중 토글은 닫기다. 이미 취소된 로딩이면 정착 전까지 새로 열지 않는다.
        if (drawer !== null) cancelOpening();
        return;
      }
      if (drawer !== null) {
        await close();
        return;
      }
      await openDrawer();
    },

    close,

    isOpen() {
      return drawer !== null;
    },

    sync,

    abandon(workspace) {
      const current = drawer;
      if (current === null) return;
      closeClosedScope(current, workspace);
    },
  };
}

let feature: NotepadFeature | null = null;

/** main.ts 의 첫 토글 진입점 — 모듈은 dynamic import 로 한 번만 읽힌다. */
export function toggleNotepad(host: NotepadHost): Promise<void> {
  feature ??= createNotepadFeature(host);
  return feature.toggle();
}

/** snapshot 변경을 열린 서랍에 반영한다 — 모듈이 로드되지 않았으면 no-op. */
export function syncNotepad(snapshot: StateSnapshot): void {
  feature?.sync(snapshot);
}

/** 권위 있는 닫기 성공 뒤 그 scope 의 서랍을 닫는다 — 로드되지 않았으면 no-op. */
export function closeNotepadAt(workspace: WorkspaceId): void {
  feature?.abandon(workspace);
}
