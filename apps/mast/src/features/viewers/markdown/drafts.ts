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
}

export function discardMarkdownDraft(tab: TabId): void {
  sessionStorage.removeItem(PREFIX + tab);
  drafts.delete(tab);
}

export function hasMarkdownDrafts(): boolean {
  return drafts.size > 0 || Object.keys(sessionStorage).some((key) => key.startsWith(PREFIX));
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
