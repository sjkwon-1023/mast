// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { gitDiff, gitStatus } from "./backend";
import {
  ChangesView,
  changeMatchesScope,
  filterGitChanges,
  gitChangeKey,
  gitDiffSource,
} from "./changes-view";
import type { GitChange, GitDiff, GitStatus } from "./backend";
import { MAX_DIFF_LINES } from "./diff-presentation";

vi.mock("./backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backend")>();
  return { ...actual, gitDiff: vi.fn(), gitStatus: vi.fn() };
});

function change(
  path: string,
  opts: Partial<Omit<GitChange, "path">> = {},
): GitChange {
  return {
    path,
    originalPath: null,
    indexStatus: ".",
    worktreeStatus: ".",
    untracked: false,
    conflicted: false,
    ...opts,
  };
}

function status(entries: GitChange[], opts: Partial<GitStatus> = {}): GitStatus {
  return { root: "/repo", unborn: false, entries, truncated: false, ...opts };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function mount(path = "/repo", initial = status([])): { view: ChangesView; root: HTMLElement } {
  vi.mocked(gitStatus).mockResolvedValue(initial);
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const view = new ChangesView(root, 7, "Ubuntu-24.04", {
    type: "changesViewer",
    path,
  });
  return { view, root };
}

function button(root: HTMLElement, selector: string): HTMLButtonElement {
  const el = root.querySelector<HTMLButtonElement>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("Changes filters and identities", () => {
  const trackedWorking = change("working.ts", { worktreeStatus: "M" });
  const trackedStaged = change("staged.ts", { indexStatus: "M" });
  const trackedBoth = change("both.ts", { indexStatus: "M", worktreeStatus: "M" });
  const untracked = change("new.ts", { untracked: true, indexStatus: "?", worktreeStatus: "?" });

  it("uses the exact working, staged, and all predicates", () => {
    const entries = [trackedWorking, trackedStaged, trackedBoth, untracked];
    expect(filterGitChanges(entries, "working")).toEqual([
      trackedWorking,
      trackedBoth,
      untracked,
    ]);
    expect(filterGitChanges(entries, "staged")).toEqual([trackedStaged, trackedBoth]);
    expect(filterGitChanges(entries, "all")).toEqual(entries);
    expect(changeMatchesScope(untracked, "staged")).toBe(false);
  });

  it("keeps tracked and untracked records at the same path distinct", () => {
    const tracked = change("same.txt", { worktreeStatus: "D" });
    const untrackedAtSamePath = change("same.txt", {
      untracked: true,
      indexStatus: "?",
      worktreeStatus: "?",
    });
    expect(gitChangeKey(tracked)).not.toBe(gitChangeKey(untrackedAtSamePath));
  });

  it("includes the rename source only in the scope where that rename happened", () => {
    const working = change("new", { originalPath: "old", worktreeStatus: "R" });
    const staged = change("new", { originalPath: "old", indexStatus: "R", worktreeStatus: "M" });
    expect(gitDiffSource(working, "working")).toBe("old");
    expect(gitDiffSource(working, "staged")).toBeNull();
    expect(gitDiffSource(working, "all")).toBe("old");
    expect(gitDiffSource(staged, "working")).toBeNull();
    expect(gitDiffSource(staged, "staged")).toBe("old");
    expect(gitDiffSource(staged, "all")).toBe("old");
  });
});

describe("ChangesView", () => {
  it("shows a terminal state instead of loading forever when initial status fails", async () => {
    vi.mocked(gitStatus).mockRejectedValueOnce("git status timed out");
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    new ChangesView(root, 7, null, { type: "changesViewer", path: "/repo" });

    expect(button(root, ".changes-refresh").disabled).toBe(true);
    expect(button(root, '.changes-filter[data-scope="all"]').disabled).toBe(true);
    await settle();

    expect(root.querySelector<HTMLElement>(".changes-notice")?.textContent).toContain(
      "timed out",
    );
    expect(root.querySelector<HTMLElement>(".changes-list-empty")?.textContent).toBe(
      "changes unavailable",
    );
    expect(root.querySelector<HTMLElement>(".changes-list-empty")?.textContent).not.toContain(
      "loading",
    );
    expect(button(root, ".changes-refresh").disabled).toBe(false);
  });

  it("loads status once, shows the resolved root, and waits for an explicit selection", async () => {
    const entries = [
      change("src/main.ts", { worktreeStatus: "M" }),
      change("README.md", { indexStatus: "M" }),
    ];
    const { root } = mount("/repo/subdir", status(entries, { root: "/repo" }));
    await settle();

    expect(gitStatus).toHaveBeenCalledTimes(1);
    expect(gitStatus).toHaveBeenCalledWith("Ubuntu-24.04", "/repo/subdir");
    expect(root.querySelector<HTMLElement>(".changes-root")?.textContent).toBe("/repo");
    expect(root.querySelectorAll(".changes-file")).toHaveLength(2);
    expect(button(root, '.changes-filter[data-scope="all"]').classList.contains("active")).toBe(true);
    expect(gitDiff).not.toHaveBeenCalled();
  });

  it("keeps row focus and identity when keyboard selection changes", async () => {
    const { root } = mount("/repo", status([
      change("first.ts", { worktreeStatus: "M" }),
      change("second.ts", { worktreeStatus: "M" }),
    ]));
    vi.mocked(gitDiff).mockResolvedValue({ text: "patch", truncated: false });
    await settle();
    const rows = root.querySelectorAll<HTMLButtonElement>(".changes-file");
    rows[0].focus();
    rows[0].click();
    expect(document.activeElement).toBe(rows[0]);
    expect(rows[0].getAttribute("aria-pressed")).toBe("true");
    rows[1].focus();
    rows[1].click();
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[0].classList.contains("selected")).toBe(false);
    expect(rows[1].getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelectorAll(".changes-file")[1]).toBe(rows[1]);
  });

  it("sends the selected entry and scope to gitDiff, including rename metadata", async () => {
    const entry = change("new-name.ts", {
      originalPath: "old-name.ts",
      indexStatus: "R",
      worktreeStatus: ".",
    });
    const { root } = mount("/repo", status([entry], { root: "/repo", unborn: true }));
    await settle();
    vi.mocked(gitDiff).mockResolvedValue({ text: "diff --git a/old-name.ts b/new-name.ts", truncated: false });

    button(root, ".changes-file").click();
    await settle();

    expect(gitDiff).toHaveBeenCalledWith("Ubuntu-24.04", {
      root: "/repo",
      path: "new-name.ts",
      originalPath: "old-name.ts",
      scope: "all",
      untracked: false,
      unborn: true,
    });
    expect(root.querySelector<HTMLElement>(".changes-file-name")?.textContent).toBe(
      "old-name.ts → new-name.ts",
    );
    expect(root.querySelector<HTMLElement>(".changes-diff")?.textContent).toContain("diff --git");
  });

  it("refetches an existing selection when scope changes and clears selections filtered out", async () => {
    const staged = change("staged.ts", { indexStatus: "M" });
    const working = change("working.ts", { worktreeStatus: "M" });
    const { root } = mount("/repo", status([staged, working]));
    await settle();
    vi.mocked(gitDiff).mockResolvedValue({ text: "diff", truncated: false });

    const rows = root.querySelectorAll<HTMLButtonElement>(".changes-file");
    rows[0].click();
    await settle();
    expect(gitDiff).toHaveBeenCalledTimes(1);

    button(root, '.changes-filter[data-scope="staged"]').click();
    await settle();
    expect(gitDiff).toHaveBeenCalledTimes(2);
    expect(vi.mocked(gitDiff).mock.calls[1][1]).toMatchObject({ scope: "staged" });

    button(root, '.changes-filter[data-scope="working"]').click();
    expect(root.querySelectorAll(".changes-file")).toHaveLength(1);
    expect(root.querySelector(".changes-diff-header")?.textContent).toBe("Diff");
    expect(root.querySelector<HTMLElement>(".changes-diff-empty")?.textContent).toBe(
      "select a changed file to view its diff",
    );
    expect(gitDiff).toHaveBeenCalledTimes(2);
  });

  it("ignores a slower diff after selection changes", async () => {
    const first = change("first.ts", { worktreeStatus: "M" });
    const second = change("second.ts", { worktreeStatus: "M" });
    const firstDiff = deferred<GitDiff>();
    const secondDiff = deferred<GitDiff>();
    const { root } = mount("/repo", status([first, second]));
    await settle();
    vi.mocked(gitDiff)
      .mockImplementationOnce(() => firstDiff.promise)
      .mockImplementationOnce(() => secondDiff.promise);

    const rows = root.querySelectorAll<HTMLButtonElement>(".changes-file");
    rows[0].click();
    rows[1].click();
    secondDiff.resolve({ text: "second diff", truncated: false });
    await settle();
    firstDiff.resolve({ text: "stale first diff", truncated: false });
    await settle();

    expect(root.querySelector<HTMLElement>(".changes-diff")?.textContent).toBe("second diff");
  });

  it("ignores stale refresh results and dispose responses", async () => {
    const firstStatus = deferred<GitStatus>();
    const secondStatus = deferred<GitStatus>();
    vi.mocked(gitStatus)
      .mockImplementationOnce(() => firstStatus.promise)
      .mockImplementationOnce(() => secondStatus.promise);
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const view = new ChangesView(root, 7, null, { type: "changesViewer", path: "/repo" });

    expect(button(root, ".changes-refresh").disabled).toBe(true);
    view.update({ type: "changesViewer", path: "/repo/other" });
    expect(root.querySelector<HTMLElement>(".changes-root")?.textContent).toBe("/repo/other");
    expect(button(root, ".changes-refresh").disabled).toBe(true);
    firstStatus.resolve(status([change("stale.ts", { worktreeStatus: "M" })]));
    await settle();
    expect(root.querySelectorAll(".changes-file")).toHaveLength(0);

    secondStatus.resolve(status([change("fresh.ts", { worktreeStatus: "M" })]));
    await settle();
    expect(root.querySelector<HTMLElement>(".changes-file-name")?.textContent).toBe("fresh.ts");
    expect(button(root, ".changes-refresh").disabled).toBe(false);

    const disposedStatus = deferred<GitStatus>();
    vi.mocked(gitStatus).mockImplementationOnce(() => disposedStatus.promise);
    button(root, ".changes-refresh").click();
    view.dispose();
    disposedStatus.resolve(status([change("after-dispose.ts", { worktreeStatus: "M" })]));
    await settle();
    expect(root.querySelectorAll(".changes-file")).toHaveLength(0);
  });

  it("clears a pending diff when refresh fails", async () => {
    const entry = change("pending.ts", { worktreeStatus: "M" });
    const pendingDiff = deferred<GitDiff>();
    const { root } = mount("/repo", status([entry]));
    await settle();
    vi.mocked(gitDiff).mockReturnValueOnce(pendingDiff.promise);

    button(root, ".changes-file").click();
    expect(root.querySelector<HTMLElement>(".changes-diff-notice")?.textContent).toBe(
      "loading diff…",
    );

    vi.mocked(gitStatus).mockRejectedValueOnce("git status timed out");
    const refresh = button(root, ".changes-refresh");
    refresh.click();
    expect(refresh.disabled).toBe(true);
    expect(button(root, '.changes-filter[data-scope="all"]').disabled).toBe(true);
    expect(root.querySelectorAll(".changes-file")).toHaveLength(0);
    await settle();

    expect(root.querySelector<HTMLElement>(".changes-notice")?.textContent).toContain(
      "timed out",
    );
    expect(root.querySelector<HTMLElement>(".changes-list-empty")?.textContent).toBe(
      "changes unavailable",
    );
    expect(root.querySelector<HTMLElement>(".changes-diff-notice")?.textContent).not.toContain(
      "loading",
    );
    expect(refresh.disabled).toBe(false);

    pendingDiff.resolve({ text: "stale diff", truncated: false });
    await settle();
    expect(root.querySelector<HTMLDivElement>(".changes-diff")?.textContent).toBe("");
    expect(root.querySelector<HTMLDivElement>(".changes-diff")?.hidden).toBe(true);
  });

  it("refreshes the selected file from the new status and clears a vanished selection", async () => {
    const entry = change("selected.ts", { worktreeStatus: "M" });
    const { root } = mount("/repo", status([entry]));
    vi.mocked(gitDiff).mockResolvedValue({ text: "old patch", truncated: false });
    await settle();
    button(root, ".changes-file").click();
    await settle();
    vi.mocked(gitStatus).mockResolvedValueOnce(status([entry], { unborn: true }));
    vi.mocked(gitDiff).mockResolvedValueOnce({ text: "fresh patch", truncated: false });
    button(root, ".changes-refresh").click();
    expect(root.querySelector<HTMLElement>(".changes-diff")?.textContent).toBe("");
    await settle();
    expect(gitDiff).toHaveBeenLastCalledWith("Ubuntu-24.04", expect.objectContaining({
      path: "selected.ts", unborn: true,
    }));
    expect(root.querySelector<HTMLElement>(".changes-diff")?.textContent).toBe("fresh patch");
    expect(root.querySelectorAll(".changes-file.selected")).toHaveLength(1);
    vi.mocked(gitStatus).mockResolvedValueOnce(status([]));
    button(root, ".changes-refresh").click();
    await settle();
    expect(root.querySelector<HTMLElement>(".changes-diff")?.textContent).toBe("");
    expect(gitDiff).toHaveBeenCalledTimes(2);
  });

  it("surfaces status, diff, and truncation errors without interpreting HTML", async () => {
    const entry = change("<script>.txt", { worktreeStatus: "M" });
    const { root, view } = mount("/repo", status([entry], { truncated: true }));
    await settle();
    expect(root.querySelector<HTMLElement>(".changes-notice")?.textContent).toContain("truncated");
    expect(root.querySelector<HTMLElement>(".changes-file-name")?.textContent).toBe("<script>.txt");

    vi.mocked(gitDiff).mockRejectedValueOnce("git diff timed out");
    button(root, ".changes-file").click();
    await settle();
    expect(root.querySelector<HTMLElement>(".changes-diff-notice")?.textContent).toContain("timed out");

    vi.mocked(gitDiff).mockResolvedValueOnce({ text: "<b>plain</b>", truncated: true });
    button(root, '.changes-filter[data-scope="working"]').click();
    await settle();
    const diff = root.querySelector<HTMLDivElement>(".changes-diff");
    expect(diff?.textContent).toBe("<b>plain</b>");
    expect(diff?.querySelector("b")).toBeNull();
    expect(root.querySelector<HTMLElement>(".changes-diff-notice")?.textContent).toContain("truncated");

    view.flushScroll();
    expect(gitDiff).toHaveBeenCalledTimes(2);
  });

  it("does not refetch when update receives the same kind", async () => {
    const { view } = mount("/repo", status([]));
    await settle();
    view.update({ type: "changesViewer", path: "/repo" });
    await settle();
    expect(gitStatus).toHaveBeenCalledTimes(1);
  });

  it("shows colored before/after sections and updates their baselines with the scope", async () => {
    const { root } = mount("/repo", status([
      change("file.ts", { indexStatus: "M", worktreeStatus: "M" }),
    ]));
    vi.mocked(gitDiff).mockResolvedValue({
      text: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n",
      truncated: false,
    });
    await settle();
    button(root, ".changes-file").click();
    await settle();
    expect(root.querySelector(".changes-diff-header")?.textContent).toContain("changed sections");
    expect(root.querySelector(".diff-removed")?.textContent).toContain("-old");
    expect(root.querySelector(".diff-added")?.textContent).toContain("+new");
    expect(root.querySelector(".diff-side-heading")?.textContent).toBe("Before · HEAD");
    button(root, '.changes-filter[data-scope="working"]').click();
    expect(root.querySelector(".changes-diff-header")?.textContent).toBe("Diff");
    await settle();
    expect(root.querySelector(".diff-side-heading")?.textContent).toBe("Before · Index");
    expect(gitDiff).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(gitDiff).toHaveBeenCalledTimes(2);
    button(root, ".changes-refresh").click();
    expect(root.querySelector(".changes-diff-header")?.textContent).toBe("Diff");
    await settle();
  });

  it("makes the additional display-line limit visible instead of silently omitting lines", async () => {
    const { root } = mount("/repo", status([change("large.txt", { worktreeStatus: "M" })]));
    vi.mocked(gitDiff).mockResolvedValue({ text: "x\n".repeat(MAX_DIFF_LINES + 10), truncated: false });
    await settle();
    button(root, ".changes-file").click();
    await settle();
    expect(root.querySelector<HTMLElement>(".changes-diff-notice")?.hidden).toBe(false);
    expect(root.querySelector(".changes-diff-notice")?.textContent).toMatch(/5,?000/);
    expect(root.querySelector(".changes-diff")?.textContent?.length).toBeLessThanOrEqual(MAX_DIFF_LINES * 2);
  });
});
