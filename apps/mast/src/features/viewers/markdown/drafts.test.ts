// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MarkdownDraftState } from "./drafts";

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
});

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

// 백엔드의 종료 판정은 마지막으로 받은 값만 본다 — 테스트도 "백엔드가 지금 쥔 값"으로 확인한다.
const draft = (text: string) => ({ path: "/tmp/note.md", distro: null, base: "# 원문\n", text });
let backend: MarkdownDraftState | null;
const send = async (state: MarkdownDraftState) => { backend = state; };

beforeEach(() => {
  backend = null;
  vi.resetModules();
});

it("부팅 seed 는 draft 가 없으면 clean 을, 리로드 전 draft 가 남아 있으면 dirty 를 알린다", async () => {
  const fresh = await import("./drafts");
  const stopFresh = fresh.reportMarkdownDraftState(send);
  expect(backend).toBe("clean");
  fresh.keepMarkdownDraft(1, draft("# 수정\n"));
  stopFresh();

  vi.resetModules();
  const reloaded = await import("./drafts");
  backend = null;
  const stop = reloaded.reportMarkdownDraftState(send);
  expect(backend).toBe("dirty");
  stop();
});

it("draft 가 생기면 dirty, 마지막 draft 가 사라져야 clean 을 알린다", async () => {
  const drafts = await import("./drafts");
  const stop = drafts.reportMarkdownDraftState(send);
  drafts.keepMarkdownDraft(1, draft("# 하나\n"));
  expect(backend).toBe("dirty");
  drafts.keepMarkdownDraft(2, draft("# 둘\n"));
  drafts.discardMarkdownDraft(1);
  expect(backend).toBe("dirty");
  drafts.discardMarkdownDraft(2);
  expect(backend).toBe("clean");
  stop();
});

it("저장 성공으로 draft 가 정리되면 clean 을 알린다", async () => {
  const drafts = await import("./drafts");
  const stop = drafts.reportMarkdownDraftState(send);
  drafts.keepMarkdownDraft(1, draft("# 수정\n"));
  expect(backend).toBe("dirty");
  drafts.markdownSaved(1, "# 수정\n", "# 수정\n");
  expect(backend).toBe("clean");
  stop();
});

it("페이지가 내려가면(WebView 리로드 시작) unknown 으로 되돌린다", async () => {
  const drafts = await import("./drafts");
  const stop = drafts.reportMarkdownDraftState(send);
  expect(backend).toBe("clean");
  window.dispatchEvent(new Event("pagehide"));
  expect(backend).toBe("unknown");
  stop();
});

it("첫 dirty 통지가 실패해도 추가 변화 없이 결국 backend 가 dirty 를 받는다", async () => {
  vi.useFakeTimers();
  const drafts = await import("./drafts");
  let failures = 0;
  const flaky = async (state: MarkdownDraftState) => {
    if (state === "dirty" && failures < 3) {
      failures += 1;
      throw new Error("ipc down");
    }
    backend = state;
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const stop = drafts.reportMarkdownDraftState(flaky);
  expect(backend).toBe("clean");
  drafts.keepMarkdownDraft(1, draft("# 수정\n"));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(backend).toBe("dirty");
  stop();
  error.mockRestore();
});

it("통지가 한동안 실패하면 재시도는 실패한 값이 아니라 그때의 현재 값을 보낸다", async () => {
  vi.useFakeTimers();
  const drafts = await import("./drafts");
  let down = false;
  const flaky = async (state: MarkdownDraftState) => {
    if (down) throw new Error("ipc down");
    backend = state;
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const stop = drafts.reportMarkdownDraftState(flaky);
  down = true;
  drafts.keepMarkdownDraft(1, draft("# 수정\n"));
  drafts.discardMarkdownDraft(1);
  drafts.keepMarkdownDraft(2, draft("# 둘\n"));
  await vi.advanceTimersByTimeAsync(1_000);
  down = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(backend).toBe("dirty");
  stop();
  error.mockRestore();
});

it("구독을 해제하면 대기 중인 재시도도 보내지 않는다", async () => {
  vi.useFakeTimers();
  const drafts = await import("./drafts");
  const sent: MarkdownDraftState[] = [];
  const failing = async (state: MarkdownDraftState) => {
    sent.push(state);
    throw new Error("ipc down");
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const stop = drafts.reportMarkdownDraftState(failing);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  const attempts = sent.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sent.length).toBe(attempts);
  error.mockRestore();
});

it("구독을 해제하면 더 이상 알리지 않는다", async () => {
  const drafts = await import("./drafts");
  const stop = drafts.reportMarkdownDraftState(send);
  stop();
  drafts.keepMarkdownDraft(1, draft("# 수정\n"));
  window.dispatchEvent(new Event("pagehide"));
  expect(backend).toBe("clean");
});
