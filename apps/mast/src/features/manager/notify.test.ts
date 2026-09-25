// 관리자 notify 토스트 판정 검증 — 런타임 검증(parseManagerNotify)과
// 게이트·제목·본문·로그 라벨(managerToast)을 잠근다. 순수 모듈이라 DOM·Tauri 는
// 등장하지 않는다.

import { describe, expect, it } from "vitest";

import { managerToast, parseManagerNotify } from "./notify";
import type { ManagerNotify, ManagerNotifyReason, NotifyWorkspace } from "./notify";

const WORKSPACES: readonly NotifyWorkspace[] = [
  { id: 1, name: "feature-x" },
  { id: 3, name: "release" },
];

const TITLE = "Approve the plan?";
const BODY = "The agent finished its turn with a plain question.";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "notify",
    workspaceId: 1,
    reason: "question",
    title: TITLE,
    body: BODY,
    ...overrides,
  };
}

function notify(overrides: Partial<ManagerNotify> = {}): ManagerNotify {
  return { workspaceId: 1, reason: "question", title: TITLE, body: BODY, ...overrides };
}

describe("parseManagerNotify", () => {
  it("계약대로 온 payload 를 그대로 읽는다", () => {
    expect(parseManagerNotify(payload())).toEqual({
      workspaceId: 1,
      reason: "question",
      title: TITLE,
      body: BODY,
    });
  });

  it("빈 제목·본문도 유효하다 (기본 제목은 판정이 채운다)", () => {
    expect(parseManagerNotify(payload({ title: "", body: "" }))).toEqual({
      workspaceId: 1,
      reason: "question",
      title: "",
      body: "",
    });
  });

  it("객체가 아니면 null", () => {
    for (const value of [null, undefined, "notify", 3, [], true]) {
      expect(parseManagerNotify(value)).toBeNull();
    }
  });

  it("type 이 notify 가 아니면 null", () => {
    expect(parseManagerNotify(payload({ type: "board" }))).toBeNull();
    expect(parseManagerNotify(payload({ type: undefined }))).toBeNull();
  });

  it("workspaceId 가 정수가 아니면 null", () => {
    expect(parseManagerNotify(payload({ workspaceId: "1" }))).toBeNull();
    expect(parseManagerNotify(payload({ workspaceId: 1.5 }))).toBeNull();
    expect(parseManagerNotify(payload({ workspaceId: Number.NaN }))).toBeNull();
    expect(parseManagerNotify(payload({ workspaceId: null }))).toBeNull();
  });

  it("모르는 reason 은 null", () => {
    expect(parseManagerNotify(payload({ reason: "other" }))).toBeNull();
    expect(parseManagerNotify(payload({ reason: null }))).toBeNull();
  });

  it("title·body 가 문자열이 아니면 null", () => {
    expect(parseManagerNotify(payload({ title: null }))).toBeNull();
    expect(parseManagerNotify(payload({ body: 3 }))).toBeNull();
  });
});

describe("managerToast 게이트", () => {
  it("포커스 + 대상이 활성이면 생략한다", () => {
    expect(managerToast(notify(), 1, true, WORKSPACES)).toBeNull();
  });

  it("포커스 중이라도 대상이 비활성이면 토스트한다", () => {
    const toast = managerToast(notify({ workspaceId: 3 }), 1, true, WORKSPACES);
    expect(toast).not.toBeNull();
    expect(toast?.title).toContain("release");
  });

  it("비포커스면 활성 대상도 토스트한다", () => {
    expect(managerToast(notify(), 1, false, WORKSPACES)).not.toBeNull();
  });

  it("활성 워크스페이스가 null 이면 포커스 중에도 토스트한다", () => {
    expect(managerToast(notify(), null, true, WORKSPACES)).not.toBeNull();
  });

  it("대상 워크스페이스가 스냅샷에 없으면 null", () => {
    expect(managerToast(notify({ workspaceId: 9 }), 1, false, WORKSPACES)).toBeNull();
    expect(managerToast(notify({ workspaceId: 9 }), 9, true, WORKSPACES)).toBeNull();
    expect(managerToast(notify(), null, false, [])).toBeNull();
  });
});

describe("managerToast 내용", () => {
  it("제목에 워크스페이스 이름 접두와 notify 제목을 잇는다", () => {
    const toast = managerToast(notify(), 1, false, WORKSPACES);
    expect(toast?.title).toBe(`mast — feature-x · ${TITLE}`);
  });

  it("빈 제목은 사유별 기본 제목으로 대체한다", () => {
    const cases: readonly [ManagerNotifyReason, string][] = [
      ["question", "Question waiting"],
      ["done", "Work finished"],
      ["failed", "Work failed"],
    ];
    for (const [reason, label] of cases) {
      const toast = managerToast(notify({ reason, title: "" }), 1, false, WORKSPACES);
      expect(toast?.title).toBe(`mast — feature-x · ${label}`);
    }
  });

  it("공백뿐인 제목도 기본 제목으로 본다", () => {
    const toast = managerToast(notify({ title: "   " }), 1, false, WORKSPACES);
    expect(toast?.title).toBe("mast — feature-x · Question waiting");
  });

  it("제목이 80자를 넘으면 80자에서 자른다", () => {
    const long = "x".repeat(300);
    const toast = managerToast(notify({ title: long }), 1, false, WORKSPACES);
    expect(toast?.title).toHaveLength(80);
    expect(toast?.title).toBe(`mast — feature-x · ${long}`.slice(0, 80));
    expect(toast?.title.startsWith("mast — feature-x · ")).toBe(true);
  });

  it("본문이 200자를 넘으면 200자에서 자른다", () => {
    const long = "y".repeat(500);
    const toast = managerToast(notify({ body: long }), 1, false, WORKSPACES);
    expect(toast?.body).toHaveLength(200);
    expect(toast?.body).toBe(long.slice(0, 200));
  });

  it("짧은 본문은 그대로 쓴다", () => {
    expect(managerToast(notify(), 1, false, WORKSPACES)?.body).toBe(BODY);
  });

  it("logLabel 은 사유만 담고 제목·본문 문자열은 들어가지 않는다", () => {
    const toast = managerToast(
      notify({ title: "SECRET-TITLE", body: "SECRET-BODY" }),
      1,
      false,
      WORKSPACES,
    );
    expect(toast?.logLabel).toBe("manager:question");
    expect(toast?.logLabel).not.toContain("SECRET-TITLE");
    expect(toast?.logLabel).not.toContain("SECRET-BODY");
  });

  it("사유마다 logLabel 이 다르다", () => {
    for (const reason of ["question", "done", "failed"] as const) {
      expect(managerToast(notify({ reason }), 1, false, WORKSPACES)?.logLabel).toBe(
        `manager:${reason}`,
      );
    }
  });
});
