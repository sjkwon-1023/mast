import { presentDiff } from "./diff-presentation";
import type { DiffRun, DiffPresentation } from "./diff-presentation";
import type { GitDiffScope } from "./backend";

interface DiffViewOptions {
  scope: GitDiffScope;
  untracked: boolean;
  unborn: boolean;
  truncated: boolean;
}

function codeBlock(runs: readonly DiffRun[]): HTMLPreElement {
  const pre = document.createElement("pre");
  pre.className = "diff-code";
  for (const run of runs) {
    const span = document.createElement("span");
    span.className = `diff-run diff-${run.tone}`;
    span.textContent = run.text;
    if (run.tone === "gap") span.setAttribute("aria-hidden", "true");
    pre.append(span);
  }
  return pre;
}

function side(label: string, runs: readonly DiffRun[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "diff-side";
  section.setAttribute("aria-label", label);
  const heading = document.createElement("div");
  heading.className = "diff-side-heading";
  heading.textContent = label;
  section.append(heading, codeBlock(runs));
  return section;
}

export function renderDiff(
  parent: HTMLElement,
  text: string,
  options: DiffViewOptions,
): Pick<DiffPresentation, "mode" | "notice"> {
  const presentation = presentDiff(text, options.truncated);
  parent.dataset.presentation = presentation.mode;
  if (presentation.mode === "comparison") {
    const before = options.untracked || (options.unborn && options.scope !== "working")
      ? "Empty"
      : options.scope === "working" ? "Index" : "HEAD";
    const after = options.scope === "staged"
      ? "Index"
      : options.untracked ? "Untracked file" : "Working tree";
    const comparison = document.createElement("div");
    comparison.className = "diff-comparison";
    comparison.append(
      side(`Before · ${before}`, presentation.before),
      side(`After · ${after}`, presentation.after),
    );
    parent.replaceChildren(comparison);
  } else {
    parent.replaceChildren(codeBlock(presentation.unified));
  }
  return { mode: presentation.mode, notice: presentation.notice };
}
