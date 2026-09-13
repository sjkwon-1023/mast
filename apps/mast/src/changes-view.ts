// Changes 탭의 읽기 전용 뷰. 상태 목록은 한 번 읽고, 사용자가 고른 항목의
// 통합 diff만 별도로 읽는다. 선택·필터·스크롤은 이 마운트의 휘발 상태다.

import { gitDiff, gitStatus } from "./backend";
import { renderDiff } from "./diff-presentation-view";
import type { GitChange, GitDiffScope, GitStatus } from "./backend";
import type { ViewerKind, ViewerView } from "./viewer-view";
import type { TabId } from "./types";

export type ChangesScope = GitDiffScope;

export const CHANGES_SCOPES: readonly ChangesScope[] = ["working", "staged", "all"];

export function changeMatchesScope(change: GitChange, scope: ChangesScope): boolean {
  switch (scope) {
    case "working":
      return change.untracked || change.worktreeStatus !== ".";
    case "staged":
      return !change.untracked && change.indexStatus !== ".";
    case "all":
      return true;
  }
}

export function filterGitChanges(
  entries: readonly GitChange[],
  scope: ChangesScope,
): GitChange[] {
  return entries.filter((entry) => changeMatchesScope(entry, scope));
}

/** 같은 경로에 tracked·untracked 레코드가 함께 올 수 있어 path만으로는 부족하다. */
export function gitChangeKey(change: GitChange): string {
  return JSON.stringify([change.path, change.untracked]);
}

export function gitDiffSource(change: GitChange, scope: ChangesScope): string | null {
  const status = scope === "working" ? change.worktreeStatus : change.indexStatus;
  return scope === "all" || status === "R" || status === "C" ? change.originalPath : null;
}

export function gitChangeLabel(change: GitChange): string {
  if (change.originalPath !== null && change.originalPath !== change.path) {
    return `${change.originalPath} → ${change.path}`;
  }
  return change.path;
}

function describeError(error: unknown): string {
  return typeof error === "string" ? error : String(error);
}

export class ChangesView implements ViewerView {
  readonly root: HTMLDivElement;
  private readonly rootPathEl: HTMLSpanElement;
  private readonly statusNoticeEl: HTMLDivElement;
  private readonly listCountEl: HTMLSpanElement;
  private readonly listEl: HTMLDivElement;
  private readonly diffNoticeEl: HTMLDivElement;
  private readonly diffEmptyEl: HTMLDivElement;
  private readonly diffEl: HTMLDivElement;
  private readonly diffHeaderEl: HTMLDivElement;
  private readonly filterButtons = new Map<ChangesScope, HTMLButtonElement>();
  private readonly refreshButton: HTMLButtonElement;

  private path: string;
  private scope: ChangesScope = "all";
  private status: GitStatus | null = null;
  private statusError: string | null = null;
  private statusLoading = false;
  private selectedKey: string | null = null;
  private selectedChange: GitChange | null = null;
  private statusRequest = 0;
  private diffRequest = 0;
  private disposed = false;

  constructor(
    parent: HTMLElement,
    private readonly tab: TabId,
    private readonly distro: string | null,
    kind: ViewerKind,
  ) {
    this.path = kind.type === "changesViewer" ? kind.path : "";

    this.root = document.createElement("div");
    this.root.className = "changes-view";

    const toolbar = document.createElement("div");
    toolbar.className = "changes-toolbar";

    const title = document.createElement("span");
    title.className = "changes-title";
    title.textContent = "Changes";

    this.rootPathEl = document.createElement("span");
    this.rootPathEl.className = "changes-root";
    this.rootPathEl.textContent = this.path;
    this.rootPathEl.title = this.path;

    const filters = document.createElement("div");
    filters.className = "changes-filters";
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Change scope");
    for (const scope of CHANGES_SCOPES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "changes-filter";
      button.dataset.scope = scope;
      button.textContent = scope[0].toUpperCase() + scope.slice(1);
      button.setAttribute("aria-pressed", String(scope === this.scope));
      button.addEventListener("click", () => this.setScope(scope));
      this.filterButtons.set(scope, button);
      filters.append(button);
    }

    this.refreshButton = document.createElement("button");
    this.refreshButton.type = "button";
    this.refreshButton.className = "changes-refresh";
    this.refreshButton.textContent = "Refresh";
    this.refreshButton.title = "Refresh changes";
    this.refreshButton.addEventListener("click", () => this.refresh());

    toolbar.append(title, this.rootPathEl, filters, this.refreshButton);

    this.statusNoticeEl = document.createElement("div");
    this.statusNoticeEl.className = "changes-notice";
    this.statusNoticeEl.hidden = true;

    const body = document.createElement("div");
    body.className = "changes-body";

    const listPanel = document.createElement("section");
    listPanel.className = "changes-list-panel";
    const listHeader = document.createElement("div");
    listHeader.className = "changes-list-header";
    const listTitle = document.createElement("span");
    listTitle.textContent = "Changed files";
    this.listCountEl = document.createElement("span");
    this.listCountEl.className = "changes-list-count";
    listHeader.append(listTitle, this.listCountEl);

    this.listEl = document.createElement("div");
    this.listEl.className = "changes-list";
    this.listEl.tabIndex = -1;
    this.listEl.setAttribute("aria-label", "Changed files");
    listPanel.append(listHeader, this.listEl);

    const diffPanel = document.createElement("section");
    diffPanel.className = "changes-diff-panel";
    this.diffHeaderEl = document.createElement("div");
    this.diffHeaderEl.className = "changes-diff-header";
    this.diffHeaderEl.textContent = "Diff";

    const diffScroll = document.createElement("div");
    diffScroll.className = "changes-diff-scroll";
    diffScroll.tabIndex = -1;
    this.diffNoticeEl = document.createElement("div");
    this.diffNoticeEl.className = "changes-diff-notice";
    this.diffNoticeEl.hidden = true;
    this.diffEmptyEl = document.createElement("div");
    this.diffEmptyEl.className = "changes-diff-empty";
    this.diffEmptyEl.textContent = "select a changed file to view its diff";
    this.diffEl = document.createElement("div");
    this.diffEl.className = "changes-diff";
    this.diffEl.hidden = true;
    diffScroll.append(this.diffNoticeEl, this.diffEmptyEl, this.diffEl);
    diffPanel.append(this.diffHeaderEl, diffScroll);

    body.append(listPanel, diffPanel);
    this.root.append(toolbar, this.statusNoticeEl, body);
    parent.appendChild(this.root);

    this.updateFilterButtons();
    this.renderList();
    this.loadStatus();
  }

  update(kind: ViewerKind): void {
    if (kind.type !== "changesViewer") {
      console.error("[mast] changes view received a non-changesViewer kind", kind);
      return;
    }
    if (kind.path === this.path) return;
    this.path = kind.path;
    this.rootPathEl.textContent = this.path;
    this.rootPathEl.title = this.path;
    this.scope = "all";
    this.statusError = null;
    this.updateFilterButtons();
    this.status = null;
    this.clearSelection();
    this.renderList();
    this.loadStatus();
  }

  flushScroll(): void {}

  focus(): void {
    this.listEl.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.statusRequest += 1;
    this.diffRequest += 1;
    this.root.remove();
  }

  private refresh(): void {
    if (this.disposed || this.statusLoading) return;
    this.loadStatus();
  }

  private loadStatus(): void {
    const request = ++this.statusRequest;
    this.diffRequest += 1;
    this.statusLoading = true;
    this.status = null;
    this.statusError = null;
    this.rootPathEl.textContent = this.path;
    this.rootPathEl.title = this.path;
    this.setStatusNotice("loading…", false);
    this.clearDiffForStatusRefresh();
    this.updateControls();
    this.renderList();
    void gitStatus(this.distro, this.path).then(
      (status) => {
        if (this.disposed || request !== this.statusRequest) return;
        this.statusLoading = false;
        this.status = status;
        this.statusError = null;
        this.rootPathEl.textContent = status.root;
        this.rootPathEl.title = status.root;
        this.reconcileSelection();
        this.renderList();
        this.updateControls();
        if (status.truncated) {
          this.setStatusNotice("status truncated — some changed files are not shown", false);
        } else {
          this.setStatusNotice(null, false);
        }
      },
      (error: unknown) => {
        if (this.disposed || request !== this.statusRequest) return;
        this.statusLoading = false;
        this.status = null;
        this.statusError = describeError(error);
        this.clearSelection();
        this.setStatusNotice(`cannot read git status: ${describeError(error)}`, true);
        this.updateControls();
        this.renderList();
      },
    );
  }

  private updateControls(): void {
    this.refreshButton.disabled = this.statusLoading;
    for (const button of this.filterButtons.values()) {
      button.disabled = this.statusLoading || this.status === null;
    }
  }

  private clearDiffForStatusRefresh(): void {
    this.diffHeaderEl.textContent = "Diff";
    this.diffNoticeEl.hidden = this.selectedKey === null;
    this.diffNoticeEl.classList.remove("error");
    this.diffNoticeEl.textContent = this.selectedKey === null ? "" : "refreshing changes…";
    this.diffEmptyEl.hidden = this.selectedKey !== null;
    this.diffEmptyEl.textContent = "select a changed file to view its diff";
    this.diffEl.hidden = true;
    this.diffEl.textContent = "";
  }

  private reconcileSelection(): void {
    const selected = this.findVisibleChange(this.selectedKey);
    if (selected === null) {
      this.clearSelection();
      return;
    }
    this.selectedChange = selected;
    this.loadDiff(selected);
  }

  private findVisibleChange(key: string | null): GitChange | null {
    if (key === null || this.status === null) return null;
    return (
      filterGitChanges(this.status.entries, this.scope).find(
        (entry) => gitChangeKey(entry) === key,
      ) ?? null
    );
  }

  private setScope(scope: ChangesScope): void {
    if (this.disposed || this.statusLoading || this.status === null || scope === this.scope) return;
    this.scope = scope;
    this.updateFilterButtons();
    const selected = this.findVisibleChange(this.selectedKey);
    if (selected === null) {
      this.clearSelection();
    } else {
      this.selectedChange = selected;
      this.loadDiff(selected);
    }
    this.renderList();
  }

  private updateFilterButtons(): void {
    for (const [scope, button] of this.filterButtons) {
      button.setAttribute("aria-pressed", String(scope === this.scope));
      button.classList.toggle("active", scope === this.scope);
    }
  }

  private selectChange(change: GitChange): void {
    if (this.disposed || this.statusLoading || this.status === null) return;
    const key = gitChangeKey(change);
    if (key === this.selectedKey && this.selectedChange === change) return;
    this.selectedKey = key;
    this.selectedChange = change;
    for (const row of this.listEl.querySelectorAll<HTMLButtonElement>(".changes-file")) {
      const selected = row.dataset.changeKey === key;
      row.classList.toggle("selected", selected);
      row.setAttribute("aria-pressed", String(selected));
    }
    this.loadDiff(change);
  }

  private clearSelection(): void {
    this.diffHeaderEl.textContent = "Diff";
    this.selectedKey = null;
    this.selectedChange = null;
    this.diffRequest += 1;
    this.diffNoticeEl.hidden = true;
    this.diffNoticeEl.textContent = "";
    this.diffEmptyEl.hidden = false;
    this.diffEmptyEl.textContent = "select a changed file to view its diff";
    this.diffEl.hidden = true;
    this.diffEl.textContent = "";
  }

  private loadDiff(change: GitChange): void {
    const status = this.status;
    if (status === null) return;
    const request = ++this.diffRequest;
    this.diffHeaderEl.textContent = "Diff";
    this.diffNoticeEl.hidden = false;
    this.diffNoticeEl.classList.remove("error");
    this.diffNoticeEl.textContent = "loading diff…";
    this.diffEmptyEl.hidden = true;
    this.diffEl.hidden = true;
    this.diffEl.textContent = "";
    void gitDiff(this.distro, {
      root: status.root,
      path: change.path,
      originalPath: gitDiffSource(change, this.scope),
      scope: this.scope,
      untracked: change.untracked,
      unborn: status.unborn,
    }).then(
      (diff) => {
        if (
          this.disposed ||
          request !== this.diffRequest ||
          this.selectedKey !== gitChangeKey(change)
        ) {
          return;
        }
        const presentation = renderDiff(this.diffEl, diff.text, {
          scope: this.scope,
          untracked: change.untracked,
          unborn: status.unborn,
          truncated: diff.truncated,
        });
        this.diffHeaderEl.textContent = presentation.mode === "comparison"
          ? "Before / After · changed sections"
          : "Unified diff";
        this.diffEl.hidden = diff.text.length === 0;
        if (diff.text.length === 0) {
          this.diffEmptyEl.hidden = false;
          this.diffEmptyEl.textContent = "no diff for this file in this scope";
        } else {
          this.diffEmptyEl.hidden = true;
        }
        const notices = [
          diff.truncated ? "diff truncated — showing the first 512 KiB" : null,
          presentation.notice,
        ].filter((notice): notice is string => notice !== null);
        if (notices.length > 0) {
          this.diffNoticeEl.hidden = false;
          this.diffNoticeEl.classList.remove("error");
          this.diffNoticeEl.textContent = notices.join(" · ");
        } else {
          this.diffNoticeEl.hidden = true;
          this.diffNoticeEl.textContent = "";
        }
      },
      (error: unknown) => {
        if (
          this.disposed ||
          request !== this.diffRequest ||
          this.selectedKey !== gitChangeKey(change)
        ) {
          return;
        }
        this.diffEl.hidden = true;
        this.diffEl.textContent = "";
        this.diffEmptyEl.hidden = true;
        this.diffNoticeEl.hidden = false;
        this.diffNoticeEl.classList.add("error");
        this.diffNoticeEl.textContent = `cannot read diff: ${describeError(error)}`;
      },
    );
  }

  private renderList(): void {
    const entries = this.status === null ? [] : filterGitChanges(this.status.entries, this.scope);
    this.listCountEl.textContent = `${entries.length} ${entries.length === 1 ? "file" : "files"}`;
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "changes-list-empty";
      empty.textContent =
        this.status === null
          ? this.statusLoading
            ? "loading changes…"
            : this.statusError === null
              ? "no changes"
              : "changes unavailable"
          : "no changes";
      this.listEl.replaceChildren(empty);
      return;
    }

    const rows = entries.map((entry) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "changes-file";
      row.dataset.changeKey = gitChangeKey(entry);
      row.classList.toggle("selected", gitChangeKey(entry) === this.selectedKey);
      row.setAttribute("aria-pressed", String(gitChangeKey(entry) === this.selectedKey));
      row.title = gitChangeLabel(entry);

      const status = document.createElement("span");
      status.className = "changes-file-status";
      status.textContent = `${entry.indexStatus}${entry.worktreeStatus}`;

      const name = document.createElement("span");
      name.className = "changes-file-name";
      name.textContent = gitChangeLabel(entry);

      row.append(status, name);
      row.addEventListener("click", () => this.selectChange(entry));
      return row;
    });
    this.listEl.replaceChildren(...rows);
  }

  private setStatusNotice(text: string | null, error: boolean): void {
    this.statusNoticeEl.textContent = text ?? "";
    this.statusNoticeEl.hidden = text === null;
    this.statusNoticeEl.classList.toggle("error", error);
  }
}
