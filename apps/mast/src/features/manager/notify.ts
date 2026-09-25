// 관리자 하네스 notify → OS 토스트 판정 (순수).
//
// 글루가 `manager-notify` 이벤트로 내보내는 notify 메시지를 런타임
// 검증하고, 지금 화면에 보이지 않는 워크스페이스의 것만 토스트 모델로 바꾼다.
// 배선은 app/main.ts 몫이고 이 모듈은 DOM·IPC 를 부르지 않는다.
//
// 게이트 규칙은 needsInput 토스트와 같다 (features/notifications/chime.ts 의
// needsInputToastTargets): 창이 포커스 상태이고 대상 워크스페이스가 활성이면
// 생략한다 — 사용자가 이미 그 화면을 보고 있다. 코어 needsInput 토스트와의
// 중복은 하네스가 R8 로 걸러 내므로 여기서 다시 보지 않는다.
//
// 로그(logLabel)에는 제목·본문을 남기지 않는다: 토스트 제목·본문은 사용자 대화
// 내용이라 toast.log 규약(chime.ts 의 logLabel 주석)대로 사유만 남긴다.

import type { WorkspaceId } from "../../shared/types";

export type ManagerNotifyReason = "question" | "done" | "failed";

/** `manager-notify` payload 중 판정이 쓰는 필드 — 하네스 notify 메시지 계약. */
export interface ManagerNotify {
  workspaceId: WorkspaceId;
  reason: ManagerNotifyReason;
  title: string;
  body: string;
}

/** 판정이 읽는 스냅샷 필드만 요구한다 (Workspace 전체를 요구하지 않아 테스트가 가볍다). */
export interface NotifyWorkspace {
  id: WorkspaceId;
  name: string;
}

export interface ManagerToast {
  title: string;
  body: string;
  /** `toast.log` 에 제목 대신 남는다 — 제목·본문을 로그에 쓰지 않는다. */
  logLabel: string;
}

const REASONS: readonly ManagerNotifyReason[] = ["question", "done", "failed"];

const DEFAULT_TITLES: Record<ManagerNotifyReason, string> = {
  question: "Question waiting",
  done: "Work finished",
  failed: "Work failed",
};

/** 하네스 상한(≤80·≤200)에 맞춘 절단 — 접두가 붙은 제목은 여기서 다시 잘린다. */
const TITLE_MAX = 80;
const BODY_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 불명 JSON 을 notify 로 검증한다. 하나라도 어긋나면 null — 모르는 메시지는
 *  무시한다는 계약(전방 호환)대로 호출측은 조용히 버린다. */
export function parseManagerNotify(value: unknown): ManagerNotify | null {
  if (!isRecord(value)) return null;
  if (value.type !== "notify") return null;
  const workspaceId = value.workspaceId;
  if (typeof workspaceId !== "number" || !Number.isInteger(workspaceId)) return null;
  const reason = value.reason;
  if (typeof reason !== "string" || !(REASONS as readonly string[]).includes(reason)) return null;
  const title = value.title;
  if (typeof title !== "string") return null;
  const body = value.body;
  if (typeof body !== "string") return null;
  return { workspaceId, reason: reason as ManagerNotifyReason, title, body };
}

/** 표시할 토스트 하나 (순수) — 대상이 화면에 보이면 null.
 *
 *  - 대상 워크스페이스가 스냅샷에 없으면 null (닫힌 워크스페이스의 늦은 notify).
 *  - 빈 제목은 사유별 기본 제목으로 대체한다.
 *  - 제목은 워크스페이스 이름 접두를 포함해 80자, 본문은 200자에서 자른다. */
export function managerToast(
  notify: ManagerNotify,
  activeWorkspace: WorkspaceId | null,
  windowFocused: boolean,
  workspaces: readonly NotifyWorkspace[],
): ManagerToast | null {
  const ws = workspaces.find((candidate) => candidate.id === notify.workspaceId);
  if (ws === undefined) return null;
  if (windowFocused && activeWorkspace === notify.workspaceId) return null;
  const label = notify.title.trim() === "" ? DEFAULT_TITLES[notify.reason] : notify.title;
  return {
    title: `mast — ${ws.name} · ${label}`.slice(0, TITLE_MAX),
    body: notify.body.slice(0, BODY_MAX),
    logLabel: `manager:${notify.reason}`,
  };
}
