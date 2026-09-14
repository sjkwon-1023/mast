// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { renderDiff } from "./diff-presentation-view";
import { MAX_DIFF_LINES } from "./diff-presentation";
import type { GitDiffScope } from "../../infrastructure/backend";

const PATCH = [
  "diff --git a/file.ts b/file.ts",
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1,2 +1,3 @@",
  "-old value",
  "+new value",
  "+extra value",
  " unchanged",
  "",
].join("\n");

function render(text = PATCH, options: Partial<Parameters<typeof renderDiff>[2]> = {}) {
  const root = document.createElement("div");
  root.className = "changes-diff";
  document.body.append(root);
  const result = renderDiff(root, text, {
    scope: "all", untracked: false, unborn: false, truncated: false, ...options,
  });
  return { root, result };
}

afterEach(() => document.body.replaceChildren());

describe("diff presentation DOM", () => {
  it("renders labeled before/after sections with distinct addition and deletion runs", () => {
    const { root, result } = render();
    expect(result.mode).toBe("comparison");
    const sides = root.querySelectorAll(".diff-side");
    expect(sides).toHaveLength(2);
    expect(sides[0].getAttribute("aria-label")).toBe("Before · HEAD");
    expect(sides[1].getAttribute("aria-label")).toBe("After · Working tree");
    expect(sides[0].querySelector(".diff-removed")?.textContent).toContain("-old value");
    expect(sides[0].querySelector(".diff-added")).toBeNull();
    expect(sides[1].querySelector(".diff-added")?.textContent).toContain("+new value");
    expect(sides[1].querySelector(".diff-removed")).toBeNull();
    expect(sides[0].querySelector(".diff-gap")?.getAttribute("aria-hidden")).toBe("true");
  });

  it.each([
    ["working", false, false, "Index", "Working tree"],
    ["staged", false, false, "HEAD", "Index"],
    ["all", false, false, "HEAD", "Working tree"],
    ["all", false, true, "Empty", "Working tree"],
    ["staged", false, true, "Empty", "Index"],
    ["working", false, true, "Index", "Working tree"],
    ["all", true, false, "Empty", "Untracked file"],
  ] as const)("labels %s, untracked=%s, unborn=%s truthfully", (scope, untracked, unborn, before, after) => {
    const { root } = render(PATCH, { scope: scope as GitDiffScope, untracked, unborn });
    expect(Array.from(root.querySelectorAll(".diff-side-heading"), (el) => el.textContent))
      .toEqual([`Before · ${before}`, `After · ${after}`]);
  });

  it("treats HTML-looking code as text in both comparison and unified modes", () => {
    const attack = "<img src=x onerror=alert(1)>";
    const { root } = render(PATCH.replace("new value", attack));
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain(attack);
    renderDiff(root, attack, { scope: "all", untracked: false, unborn: false, truncated: false });
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toBe(attack);
    expect(root.querySelector(".diff-comparison")).toBeNull();
  });

  it("preserves binary and combined output without inventing two comparison sides", () => {
    for (const text of [
      "diff --git a/pic b/pic\nBinary files a/pic and b/pic differ\n",
      "diff --cc conflict\n@@@ -1,1 -1,1 +1,1 @@@\n++merged\n",
    ]) {
      const { root, result } = render(text);
      expect(result.mode).toBe("unified");
      expect(root.textContent).toBe(text);
      expect(root.querySelector(".diff-side")).toBeNull();
    }
  });

  it("labels byte-truncated output and bounds the DOM of many short lines", () => {
    const clipped = render(PATCH, { truncated: true });
    expect(clipped.result.mode).toBe("unified");
    const { root, result } = render("+x\n-y\n".repeat(MAX_DIFF_LINES));
    expect(result.notice).not.toBeNull();
    expect(root.querySelectorAll("span").length).toBeLessThanOrEqual(MAX_DIFF_LINES);
    expect(root.textContent?.length).toBeLessThanOrEqual(MAX_DIFF_LINES * 3);
  });

  it("uses the pane container, not a viewport media query, for the layout breakpoint", () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../app/styles.css"), "utf8");
    expect(css).toMatch(/\.changes-view\s*\{[^}]*container:\s*changes\s*\/\s*inline-size/s);
    expect(css).toMatch(/\.changes-list-panel\s*\{[^}]*flex:\s*0 0 min\(24%, 240px\)/s);
    expect(css).toMatch(/\.diff-comparison\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
    expect(css).toMatch(/@container changes \(min-width: 960px\)\s*\{\s*\.diff-comparison\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(css).toMatch(/\.diff-added\s*\{[^}]*color:\s*#a8ddb5/s);
    expect(css).toMatch(/\.diff-removed\s*\{[^}]*color:\s*#f2b0ad/s);
  });
});
