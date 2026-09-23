import type { Command, StateSnapshot, TabId } from "../../../shared/types";

export interface MarkdownDraft {
  path: string;
  distro: string | null;
  base: string;
  text: string;
}
const PREFIX = "mast.markdownDraft.";
const drafts = new Map<TabId, MarkdownDraft>();
const saveListeners = new Set<(tab: TabId, content: string) => void>();
const changeListeners = new Set<() => void>();

/** 백엔드가 종료 판정에 쓰는 draft 상태. "unknown" 은 아직 모르는 상태(부팅 전·리로드 중)이며,
 *  백엔드는 이를 dirty 와 같이 안전한 쪽으로 다룬다. 통지 실패는 백엔드를 unknown 으로 되돌리지
 *  않는다 — 마지막으로 받은 값이 남으므로 보고 쪽이 성공할 때까지 다시 보낸다. */
export type MarkdownDraftState = "unknown" | "clean" | "dirty";

export function onMarkdownSaved(listener: (tab: TabId, content: string) => void): () => void {
  saveListeners.add(listener);
  return () => { saveListeners.delete(listener); };
}

export function markdownSaved(tab: TabId, text: string, content: string): void {
  const current = markdownDraft(tab);
  if (!current || current.text === text) discardMarkdownDraft(tab);
  else keepMarkdownDraft(tab, { ...current, base: content });
  // 저장 중 탭이 재마운트됐어도 새 뷰가 다음 저장에 최신 원문을 사용한다.
  for (const listener of saveListeners) listener(tab, content);
}

export function markdownDraft(tab: TabId): MarkdownDraft | null {
  const live = drafts.get(tab);
  if (live) return live;
  const raw = sessionStorage.getItem(PREFIX + tab);
  if (raw === null) return null;
  const value = JSON.parse(raw) as MarkdownDraft;
  if (typeof value.path !== "string" || typeof value.base !== "string" || typeof value.text !== "string" || (value.distro !== null && typeof value.distro !== "string")) {
    throw new Error("invalid Markdown draft backup");
  }
  drafts.set(tab, value);
  return value;
}

export function keepMarkdownDraft(tab: TabId, draft: MarkdownDraft): void {
  // 백업에 성공한 변경만 받아들여 자동 WebView 리로드에도 같은 원문을 복원한다.
  sessionStorage.setItem(PREFIX + tab, JSON.stringify(draft));
  drafts.set(tab, draft);
  notifyDraftsChanged();
}

export function discardMarkdownDraft(tab: TabId): void {
  sessionStorage.removeItem(PREFIX + tab);
  drafts.delete(tab);
  notifyDraftsChanged();
}

// draft 집합을 바꾸는 곳은 위 두 함수뿐이다(저장 성공·취소·닫기 뒤 삭제도 이 둘을 거친다).
// lazy 복원(markdownDraft)은 sessionStorage 에 이미 있던 것을 메모리로 올릴 뿐이라
// hasMarkdownDrafts() 값을 바꾸지 않는다.
function notifyDraftsChanged(): void {
  for (const listener of changeListeners) listener();
}

export function hasMarkdownDrafts(): boolean {
  return drafts.size > 0 || Object.keys(sessionStorage).some((key) => key.startsWith(PREFIX));
}

/** draft 집합이 바뀔 때마다 부른다. 구독 해제 함수를 돌려준다. */
export function onMarkdownDraftsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

/** 통지 재시도의 첫 지연과 상한. 실패할 때마다 두 배로 늘린다. */
const RETRY_FIRST_MS = 100;
const RETRY_MAX_MS = 2_000;

/**
 * draft 상태를 백엔드로 계속 보고한다 — 부팅 때 현재 값으로 한 번 seed 하고, draft 집합이
 * 바뀔 때마다 다시 보내며, 페이지가 내려갈 때(WebView 리로드 시작) "unknown" 으로 되돌린다.
 * 리로드된 페이지는 sessionStorage 에서 복원된 draft 를 다시 seed 한다.
 *
 * 같은 값은 거듭 보내지 않는다(편집 중 키 입력마다 IPC 가 나가지 않게). 전송이 실패하면
 * 성공할 때까지 지수 백오프(상한 RETRY_MAX_MS)로 다시 보낸다 — 백엔드는 마지막으로 받은
 * 값으로 종료를 판정하므로, 다음 변화를 기다리면 dirty 인데도 이전 clean 이 무기한 남아
 * 확인 없이 종료될 수 있다. 재시도는 실패한 값이 아니라 그 시점의 현재 값을 보낸다.
 * 반환된 해제 함수는 구독과 함께 대기 중인 재시도도 거둔다.
 */
export function reportMarkdownDraftState(
  send: (state: MarkdownDraftState) => Promise<unknown>,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let delivered: MarkdownDraftState | null = null;
  // 마지막으로 보고하려 한 값. 페이지가 내려간 뒤("unknown")에는 재시도도 그 값을 지킨다.
  let wanted: MarkdownDraftState = "unknown";
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_FIRST_MS;
  let stopped = false;
  const draftState = (): MarkdownDraftState => (hasMarkdownDrafts() ? "dirty" : "clean");
  const report = (state: MarkdownDraftState): void => {
    wanted = state;
    if (state === delivered) return;
    delivered = state;
    send(state).then(
      () => {
        if (delivered === state) retryDelay = RETRY_FIRST_MS;
      },
      (err: unknown) => {
        console.error("[mast] Markdown draft state report failed", state, err);
        // 그 사이 다른 값을 보냈다면 그 전송이 전달을 책임진다.
        if (stopped || delivered !== state) return;
        delivered = null;
        scheduleRetry();
      },
    );
  };
  const scheduleRetry = (): void => {
    if (retryTimer !== null) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      report(wanted === "unknown" ? "unknown" : draftState());
    }, delay);
  };
  const reportCurrent = (): void => report(draftState());
  const onPageHide = (): void => report("unknown");
  const unsubscribe = onMarkdownDraftsChanged(reportCurrent);
  target.addEventListener("pagehide", onPageHide);
  reportCurrent();
  return () => {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    unsubscribe();
    target.removeEventListener("pagehide", onPageHide);
  };
}

export function closingMarkdownDrafts(command: Command, snapshot: StateSnapshot | null): TabId[] {
  if (!snapshot) return [];
  const ids: TabId[] = [];
  for (const ws of snapshot.state.workspaces) {
    for (const pane of Object.values(ws.panes)) {
      for (const tab of pane.tabs) {
        const closing = (command.type === "closeTab" && command.tab === tab.id)
          || (command.type === "closePane" && command.pane === pane.id)
          || (command.type === "closeWorkspace" && command.workspace === ws.id);
        if (closing && tab.kind.type === "markdownViewer" && markdownDraft(tab.id)) ids.push(tab.id);
      }
    }
  }
  return ids;
}
