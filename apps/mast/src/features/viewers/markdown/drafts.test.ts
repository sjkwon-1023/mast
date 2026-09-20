// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { sessionStorage.clear(); });

it("새 JS 컨텍스트에서 sessionStorage의 원문과 편집 내용을 복원한다", async () => {
  const first = await import("./drafts");
  const draft = { path: "/tmp/note.md", distro: "Ubuntu", base: "# 원문\r\n", text: "# 수정\n" };
  first.keepMarkdownDraft(99, draft);
  vi.resetModules();
  const reloaded = await import("./drafts");
  expect(reloaded.hasMarkdownDrafts()).toBe(true);
  expect(reloaded.markdownDraft(99)).toEqual(draft);
  reloaded.discardMarkdownDraft(99);
  expect(reloaded.hasMarkdownDrafts()).toBe(false);
});
