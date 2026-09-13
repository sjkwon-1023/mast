import { describe, expect, it } from "vitest";

import {
  MAX_DIFF_LINES,
  presentDiff,
} from "./diff-presentation";
import type { DiffRun } from "./diff-presentation";

function runsOf(runs: readonly DiffRun[], tone: DiffRun["tone"]): string[] {
  return runs.filter((run) => run.tone === tone).map((run) => run.text);
}

function textOf(runs: readonly DiffRun[]): string {
  return runs.map((run) => run.text).join("");
}

const PATCH = [
  "diff --git a/file.ts b/file.ts",
  "index 1111111..2222222 100644",
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1,3 +1,4 @@ function f()",
  " context",
  "-old",
  "+new",
  "+extra",
  " tail",
].join("\n") + "\n";

describe("presentDiff", () => {
  it("presents a complete unified hunk as two sides and duplicates metadata", () => {
    const result = presentDiff(PATCH);

    expect(result.mode).toBe("comparison");
    expect(result.notice).toBeNull();
    expect(result.unified).toEqual([]);
    expect(runsOf(result.before, "meta").join("")).toBe(runsOf(result.after, "meta").join(""));
    expect(textOf(result.before)).toContain("diff --git a/file.ts b/file.ts\n");
    expect(runsOf(result.before, "meta").join("")).toContain("@@ -1,3 +1,4 @@ function f()\n");
    expect(runsOf(result.before, "removed").join("")).toBe("-old\n");
    expect(runsOf(result.after, "added").join("")).toBe("+new\n+extra\n");
    expect(runsOf(result.before, "context").join("")).toContain(" context\n tail\n");
    expect(runsOf(result.after, "context").join("")).toContain(" context\n tail\n");
  });

  it("pairs changed lines by ordinal and fills the shorter side with gap rows", () => {
    const result = presentDiff([
      "@@ -1,3 +1,2 @@",
      "-old one",
      "-old two",
      "+new one",
      " context",
    ].join("\n") + "\n");

    expect(result.mode).toBe("comparison");
    expect(runsOf(result.before, "removed").join("")).toBe("-old one\n-old two\n");
    expect(runsOf(result.after, "added").join("")).toBe("+new one\n");
    expect(textOf(result.before)).not.toContain("+new one");
    expect(runsOf(result.after, "gap")).toEqual(["\n"]);
    expect(textOf(result.after)).toContain("+new one\n\n context\n");
  });

  it("keeps an insertion aligned before following context", () => {
    const result = presentDiff("@@ -1,1 +1,3 @@\n context\n+one\n+two\n");

    expect(result.mode).toBe("comparison");
    expect(runsOf(result.before, "gap")).toEqual(["\n\n"]);
    expect(runsOf(result.after, "added")).toEqual(["+one\n+two\n"]);
    expect(textOf(result.before)).toBe("@@ -1,1 +1,3 @@\n context\n\n\n");
  });

  it("keeps runs bounded by coalescing consecutive same-tone lines", () => {
    const added = Array.from({ length: 200 }, (_, index) => `+line ${index}\n`).join("");
    const result = presentDiff(`@@ -0,0 +1,200 @@\n${added}`);

    expect(result.mode).toBe("comparison");
    expect(result.after.filter((run) => run.tone === "added")).toHaveLength(1);
    expect(result.before.filter((run) => run.tone === "gap")).toHaveLength(1);
    expect(result.after.length).toBeLessThan(10);
  });

  it("keeps metadata in place across multiple files and hunks", () => {
    const text = [
      "diff --git a/one b/one",
      "--- a/one",
      "+++ b/one",
      "@@ -1 +1 @@",
      "-one",
      "+ONE",
      "diff --git a/two b/two",
      "--- a/two",
      "+++ b/two",
      "@@ -2 +2 @@",
      "-two",
      "+TWO",
    ].join("\n") + "\n";
    const result = presentDiff(text);

    expect(result.mode).toBe("comparison");
    expect(runsOf(result.before, "meta").join("")).toBe(runsOf(result.after, "meta").join(""));
    expect(textOf(result.before)).not.toContain("+ONE");
    expect(runsOf(result.before, "removed").join("")).toBe("-one\n-two\n");
    expect(runsOf(result.after, "added").join("")).toBe("+ONE\n+TWO\n");
  });

  it.each([
    ["@@ -0,0 +1,1 @@\n+new\n", "\n", "+new\n"],
    ["@@ -1,1 +0,0 @@\n-old\n", "-old\n", "\n"],
  ])("accepts empty-file ranges", (text, before, after) => {
    const result = presentDiff(text);

    expect(result.mode).toBe("comparison");
    expect(textOf(result.before)).toContain(text.split("\n", 1)[0] + "\n");
    expect(runsOf(result.before, "gap").length + runsOf(result.before, "removed").length).toBeGreaterThan(0);
    expect(textOf(result.after)).toContain(after);
  });

  it("preserves CRLF and a final line without a newline", () => {
    const text = "--- old\r\n+++ new\r\n@@ -1 +1 @@\r\n-old\r\n+new";
    const result = presentDiff(text);

    expect(result.mode).toBe("comparison");
    expect(textOf(result.before)).toBe("--- old\r\n+++ new\r\n@@ -1 +1 @@\r\n-old\r\n");
    expect(textOf(result.after)).toBe("--- old\r\n+++ new\r\n@@ -1 +1 @@\r\n+new");
  });

  it("keeps no-newline markers neutral on the side they describe", () => {
    const result = presentDiff([
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n") + "\n");

    expect(result.mode).toBe("comparison");
    expect(textOf(result.before)).toContain("-old\n\\ No newline at end of file\n");
    expect(textOf(result.after)).toContain("+new\n\\ No newline at end of file\n");
    expect(runsOf(result.before, "context").join("")).toContain("\\ No newline");
    expect(runsOf(result.after, "context").join("")).toContain("\\ No newline");
  });

  it("adds an opposite gap for an unmatched marker before following context", () => {
    const result = presentDiff([
      "@@ -1,2 +1,2 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      " context",
    ].join("\n") + "\n");

    expect(result.mode).toBe("comparison");
    expect(textOf(result.before)).toContain("-old\n\\ No newline at end of file\n context\n");
    expect(textOf(result.after)).toContain("+new\n\n context\n");
    expect(runsOf(result.after, "gap")).toEqual(["\n"]);
  });

  it("falls back when a hunk count is incomplete and only colors its actual body", () => {
    const text = [
      "--- old",
      "+++ new",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "plain trailing text",
    ].join("\n") + "\n";
    const result = presentDiff(text);

    expect(result.mode).toBe("unified");
    expect(result.notice).toContain("incomplete");
    expect(textOf(result.unified)).toBe(text);
    expect(runsOf(result.unified, "removed").join("")).toBe("-old\n");
    expect(runsOf(result.unified, "added").join("")).toBe("+new\n");
    expect(runsOf(result.unified, "meta").join("")).toBe("--- old\n+++ new\n@@ -1,2 +1,2 @@\n");
    expect(runsOf(result.unified, "context").join("")).toContain("plain trailing text");
  });

  it("falls back for unknown diagnostic text after an otherwise complete hunk", () => {
    const text = "@@ -1 +1 @@\n-old\n+new\nDIAGNOSTIC: backend note\n";
    const result = presentDiff(text);

    expect(result.mode).toBe("unified");
    expect(result.notice).toContain("unsupported");
    expect(textOf(result.unified)).toBe(text);
    expect(runsOf(result.unified, "context").join("")).toContain("DIAGNOSTIC: backend note");
  });

  it("falls back for unknown text before a valid hunk", () => {
    const text = "unexpected preamble\n@@ -1 +1 @@\n-old\n+new\n";
    const result = presentDiff(text);

    expect(result.mode).toBe("unified");
    expect(result.notice).toContain("unsupported");
    expect(textOf(result.unified)).toBe(text);
    expect(runsOf(result.unified, "context").join("")).toContain("unexpected preamble");
  });

  it.each([
    "@@ -0,1 +1,1 @@\n+new\n",
    "@@ -1,999999999999999999999 +1,1 @@\n+new\n",
    "@@ -1,1 +1 @@@\n-old\n+new\n",
    "@@ -1,0 +1,0 @@\n",
  ])("rejects malformed or overflowing hunk ranges: %s", (text) => {
    const result = presentDiff(text);

    expect(result.mode).toBe("unified");
    expect(result.notice).toContain("malformed");
  });

  it("does not treat an overrun body as a second valid hunk", () => {
    const result = presentDiff("@@ -1 +1 @@\n-old\n+new\n+extra\n");

    expect(result.mode).toBe("unified");
    expect(result.notice).toContain("malformed");
  });

  it("keeps combined diffs unified and neutral", () => {
    const text = "diff --cc file\n@@@ -1,1 -1,1 +1,1 @@@\n++both\n--both\n  same\n";
    const result = presentDiff(text);

    expect(result.mode).toBe("unified");
    expect(result.notice).toContain("combined");
    expect(textOf(result.unified)).toBe(text);
    expect(runsOf(result.unified, "added")).toEqual([]);
    expect(runsOf(result.unified, "removed")).toEqual([]);
  });

  it("keeps binary and metadata-only diffs visible without fabricating sides", () => {
    const binary = presentDiff("diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n");
    expect(binary.mode).toBe("unified");
    expect(binary.notice).toContain("binary");
    expect(textOf(binary.unified)).toContain("Binary files");
    expect(runsOf(binary.unified, "added")).toEqual([]);

    const rename = presentDiff("diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n");
    expect(rename.mode).toBe("unified");
    expect(rename.notice).toBeNull();
    expect(runsOf(rename.unified, "meta").join("")).toContain("rename from old");
  });

  it("colors only one-prefix lines inside an ordinary fallback hunk", () => {
    const text = [
      "--- old",
      "+++ new",
      "@@ -1,2 +1,2 @@",
      "+++ code that starts with pluses",
      "--- code that starts with minuses",
    ].join("\n") + "\n";
    const result = presentDiff(text, true);

    expect(result.mode).toBe("unified");
    expect(runsOf(result.unified, "meta").join("")).toBe("--- old\n+++ new\n@@ -1,2 +1,2 @@\n");
    expect(runsOf(result.unified, "added").join("")).toBe("+++ code that starts with pluses\n");
    expect(runsOf(result.unified, "removed").join("")).toBe("--- code that starts with minuses\n");
  });

  it("keeps unknown plain fallback text byte-for-byte as context", () => {
    const text = "second diff";
    const result = presentDiff(text);

    expect(result.mode).toBe("unified");
    expect(textOf(result.unified)).toBe(text);
    expect(runsOf(result.unified, "context")).toEqual([text]);
  });

  it("reports backend truncation and never attempts comparison", () => {
    const result = presentDiff(PATCH, true);

    expect(result.mode).toBe("unified");
    expect(result.notice).toContain("truncated");
    expect(result.before).toEqual([]);
    expect(textOf(result.unified)).toBe(PATCH);
  });

  it("mentions both backend truncation and the line cap when both apply", () => {
    const text = Array.from({ length: MAX_DIFF_LINES + 1 }, () => "plain\n").join("");
    const result = presentDiff(text, true);

    expect(result.notice).toContain("truncated");
    expect(result.notice).toMatch(/5,?000/);
  });

  it("caps physical line extraction at 5,000 lines and bounds runs", () => {
    const text = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, index) => `plain ${index}\n`).join("");
    const result = presentDiff(text);

    expect(result.mode).toBe("unified");
    expect(result.notice).toMatch(/5,?000/);
    expect(textOf(result.unified)).toBe(
      Array.from({ length: MAX_DIFF_LINES }, (_, index) => `plain ${index}\n`).join(""),
    );
    expect(result.unified.length).toBe(1);
  });

  it("keeps adversarial-looking code as inert raw text", () => {
    const attack = "<img src=x onerror=alert(1)>";
    const result = presentDiff(`@@ -0,0 +1,1 @@\n+${attack}\n`);

    expect(result.mode).toBe("comparison");
    expect(textOf(result.after)).toContain(`+${attack}\n`);
    expect(textOf(result.before)).not.toContain("onerror=alert(1)");
  });
});
