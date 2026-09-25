// 관리자 작업 보드 카드 모델 — DOM 없이 보드 JSON 검증·카드 계산·정렬·이동
// 대상·헤더 문자열만 담당한다. 뷰는 이 모델을 그리기만 한다.
//
// board 메시지는 신뢰할 수 없는 JSON 이므로 parseBoard 가 항목 단위로 검증하고,
// 형식이 깨진 항목은 버리지 않고 `kind: "invalid"` 로 남겨 오류 카드로 표시한다
// (숨기면 보드가 "기록 없음"과 "깨진 기록"을 구분하지 못한다). 최상위 형식이
// 깨졌을 때만 entries 를 비우고 error 를 채운다 — 헤더 오류 표시용이다.
//
// 계약: 하네스 board/status 메시지, 작업 JSON 스키마, 카드 정렬·내용·이동 대상·헤더
// (ADR-0032). 작업 JSON 은 snake_case, 이 모듈의 카드 모델은 camelCase.

import type { AgentStatus, AppState, TabId, Workspace, WorkspaceId } from "../../shared/types";

// ---- 하네스 → 앱 메시지 ----

export type BoardEntryState = "active" | "none" | "unsupported" | "choice" | "error";
export type BoardEntryReason = "no_root" | "other_distro" | "no_transcript";

export interface BoardArchive {
  count: number;
  latestClosedAt: string | null;
}

/** 작업 JSON 의 Item 공통부 중 보드가 읽는 필드 — 열거값·타입만 검증한다. */
export type BoardTaskItemStatus = "active" | "resolved" | "superseded";

export interface BoardTaskAnchor {
  tab: number | null;
}

/** open_questions 항목 — 카드와 이동 대상이 anchor.tab 을 읽는다. */
export interface BoardTaskQuestion {
  id: string;
  text: string;
  quote: string | null;
  status: BoardTaskItemStatus;
  anchor: BoardTaskAnchor | null;
}

/** decisions 항목 — by 로 user/ai 그룹을 가른다. */
export interface BoardTaskDecision {
  id: string;
  text: string;
  quote: string | null;
  status: BoardTaskItemStatus;
  by: "user" | "ai";
}

/** next 항목 — 카드는 활성 text 만 보여 준다. */
export interface BoardTaskNext {
  id: string;
  text: string;
  status: BoardTaskItemStatus;
}

export interface BoardTaskPlanStep {
  text: string;
  done: boolean;
}

export interface BoardTaskPlan {
  path: string;
  goal: string;
  steps: BoardTaskPlanStep[];
  status: "active" | "removed";
}

export interface BoardTaskProgress {
  text: string;
  reported_done: boolean;
  verified_done: boolean;
}

/** 작업 meta — 보드가 읽는 updated_at(정렬)·last_error(stale)·limits(배지)만. */
export interface BoardTaskMeta {
  updated_at: string;
  last_error: string | null;
  limits: string[];
}

/** 작업 JSON 미러 — 보드가 읽는 필드만 담는다. 모르는 필드는 파싱에서 무시. */
export interface BoardTask {
  title: string;
  headline: string;
  meta: BoardTaskMeta;
  progress: BoardTaskProgress;
  open_questions: BoardTaskQuestion[];
  decisions: BoardTaskDecision[];
  next: BoardTaskNext[];
  plans: BoardTaskPlan[];
}

export interface BoardEntry {
  workspaceId: WorkspaceId;
  key: string | null;
  state: BoardEntryState;
  reason: BoardEntryReason | null;
  task: BoardTask | null;
  error: string | null;
  archive: BoardArchive | null;
}

/** 유효 항목은 그대로, 형식 오류 항목은 오류 카드용 표식으로 남는다. */
export type ParsedEntry =
  | ({ kind: "entry" } & BoardEntry)
  | { kind: "invalid"; workspaceId: WorkspaceId | null; error: string };

export interface ParsedBoard {
  entries: ParsedEntry[];
  error: string | null;
}

export type GlueState =
  | "disabled"
  | "starting"
  | "ok"
  | "busy"
  | "failed"
  | "unsupported"
  | "restarting";

export interface GlueStatus {
  state: GlueState;
  message: string | null;
  lastCollectedAt: string | null;
  logPath: string | null;
}

// ---- 런타임 검증 ----

const ENTRY_STATES: readonly BoardEntryState[] = [
  "active",
  "none",
  "unsupported",
  "choice",
  "error",
];
const ENTRY_REASONS: readonly BoardEntryReason[] = ["no_root", "other_distro", "no_transcript"];
const ITEM_STATUSES: readonly BoardTaskItemStatus[] = ["active", "resolved", "superseded"];

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNullableString(value: unknown, path: string): Parsed<string | null> {
  if (value === null || typeof value === "string") return { ok: true, value };
  return fail(`${path} must be a string or null`);
}

function parseArchive(value: unknown, path: string): Parsed<BoardArchive | null> {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return fail(`${path} must be an object or null`);
  if (typeof value.count !== "number") return fail(`${path}.count must be a number`);
  const latest = parseNullableString(value.latestClosedAt, `${path}.latestClosedAt`);
  if (!latest.ok) return latest;
  return { ok: true, value: { count: value.count, latestClosedAt: latest.value } };
}

function parseAnchor(value: unknown, path: string): Parsed<BoardTaskAnchor | null> {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return fail(`${path} must be an object or null`);
  const tab = value.tab;
  if (tab !== null && typeof tab !== "number") {
    return fail(`${path}.tab must be a number or null`);
  }
  return { ok: true, value: { tab } };
}

/** 열거값 검사 — 문자열이 아니거나 목록 밖이면 오류. */
function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): Parsed<T> {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return fail(`${path} must be one of ${allowed.join(", ")}`);
}

function parseQuestionItem(value: unknown, path: string): Parsed<BoardTaskQuestion> {
  if (!isRecord(value)) return fail(`${path} must be an object`);
  const id = value.id;
  if (typeof id !== "string") return fail(`${path}.id must be a string`);
  const text = value.text;
  if (typeof text !== "string") return fail(`${path}.text must be a string`);
  const quote = parseNullableString(value.quote, `${path}.quote`);
  if (!quote.ok) return quote;
  const status = parseEnum(value.status, ITEM_STATUSES, `${path}.status`);
  if (!status.ok) return status;
  const anchor = parseAnchor(value.anchor, `${path}.anchor`);
  if (!anchor.ok) return anchor;
  return { ok: true, value: { id, text, quote: quote.value, status: status.value, anchor: anchor.value } };
}

function parseDecisionItem(value: unknown, path: string): Parsed<BoardTaskDecision> {
  if (!isRecord(value)) return fail(`${path} must be an object`);
  const id = value.id;
  if (typeof id !== "string") return fail(`${path}.id must be a string`);
  const text = value.text;
  if (typeof text !== "string") return fail(`${path}.text must be a string`);
  const quote = parseNullableString(value.quote, `${path}.quote`);
  if (!quote.ok) return quote;
  const status = parseEnum(value.status, ITEM_STATUSES, `${path}.status`);
  if (!status.ok) return status;
  const by = parseEnum(value.by, ["user", "ai"] as const, `${path}.by`);
  if (!by.ok) return by;
  return { ok: true, value: { id, text, quote: quote.value, status: status.value, by: by.value } };
}

function parseNextItem(value: unknown, path: string): Parsed<BoardTaskNext> {
  if (!isRecord(value)) return fail(`${path} must be an object`);
  const id = value.id;
  if (typeof id !== "string") return fail(`${path}.id must be a string`);
  const text = value.text;
  if (typeof text !== "string") return fail(`${path}.text must be a string`);
  const status = parseEnum(value.status, ITEM_STATUSES, `${path}.status`);
  if (!status.ok) return status;
  return { ok: true, value: { id, text, status: status.value } };
}

function parsePlan(value: unknown, path: string): Parsed<BoardTaskPlan> {
  if (!isRecord(value)) return fail(`${path} must be an object`);
  const planPath = value.path;
  if (typeof planPath !== "string") return fail(`${path}.path must be a string`);
  const goal = value.goal;
  if (typeof goal !== "string") return fail(`${path}.goal must be a string`);
  const status = parseEnum(value.status, ["active", "removed"] as const, `${path}.status`);
  if (!status.ok) return status;
  const rawSteps = value.steps;
  if (!Array.isArray(rawSteps)) return fail(`${path}.steps must be an array`);
  const steps: BoardTaskPlanStep[] = [];
  for (let i = 0; i < rawSteps.length; i += 1) {
    const raw = rawSteps[i];
    if (!isRecord(raw)) return fail(`${path}.steps[${i}] must be an object`);
    if (typeof raw.text !== "string") return fail(`${path}.steps[${i}].text must be a string`);
    if (typeof raw.done !== "boolean") return fail(`${path}.steps[${i}].done must be a boolean`);
    steps.push({ text: raw.text, done: raw.done });
  }
  return { ok: true, value: { path: planPath, goal, steps, status: status.value } };
}

function parseItems<T>(
  raw: unknown,
  path: string,
  parser: (item: unknown, itemPath: string) => Parsed<T>,
): Parsed<T[]> {
  if (!Array.isArray(raw)) return fail(`${path} must be an array`);
  const items: T[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = parser(raw[i], `${path}[${i}]`);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return { ok: true, value: items };
}

function parseTask(value: unknown, path: string): Parsed<BoardTask> {
  if (!isRecord(value)) return fail(`${path} must be an object`);
  const title = value.title;
  if (typeof title !== "string") return fail(`${path}.title must be a string`);
  const headline = value.headline;
  if (typeof headline !== "string") return fail(`${path}.headline must be a string`);

  const meta = value.meta;
  if (!isRecord(meta)) return fail(`${path}.meta must be an object`);
  if (typeof meta.updated_at !== "string") return fail(`${path}.meta.updated_at must be a string`);
  const lastError = parseNullableString(meta.last_error, `${path}.meta.last_error`);
  if (!lastError.ok) return lastError;
  const limits = parseItems(meta.limits, `${path}.meta.limits`, (item, itemPath) => {
    if (typeof item !== "string") return fail<string>(`${itemPath} must be a string`);
    return { ok: true, value: item };
  });
  if (!limits.ok) return limits;

  const progress = value.progress;
  if (!isRecord(progress)) return fail(`${path}.progress must be an object`);
  if (typeof progress.text !== "string") return fail(`${path}.progress.text must be a string`);
  if (typeof progress.reported_done !== "boolean") {
    return fail(`${path}.progress.reported_done must be a boolean`);
  }
  if (typeof progress.verified_done !== "boolean") {
    return fail(`${path}.progress.verified_done must be a boolean`);
  }

  const openQuestions = parseItems(value.open_questions, `${path}.open_questions`, parseQuestionItem);
  if (!openQuestions.ok) return openQuestions;
  const decisions = parseItems(value.decisions, `${path}.decisions`, parseDecisionItem);
  if (!decisions.ok) return decisions;
  const next = parseItems(value.next, `${path}.next`, parseNextItem);
  if (!next.ok) return next;
  const plans = parseItems(value.plans, `${path}.plans`, parsePlan);
  if (!plans.ok) return plans;

  return {
    ok: true,
    value: {
      title,
      headline,
      meta: {
        updated_at: meta.updated_at,
        last_error: lastError.value,
        limits: limits.value,
      },
      progress: {
        text: progress.text,
        reported_done: progress.reported_done,
        verified_done: progress.verified_done,
      },
      open_questions: openQuestions.value,
      decisions: decisions.value,
      next: next.value,
      plans: plans.value,
    },
  };
}

function parseEntry(raw: Record<string, unknown>, path: string): Parsed<BoardEntry> {
  const state = parseEnum(raw.state, ENTRY_STATES, `${path}.state`);
  if (!state.ok) return state;
  let reason: BoardEntryReason | null = null;
  if (raw.reason !== null) {
    const parsedReason = parseEnum(raw.reason, ENTRY_REASONS, `${path}.reason`);
    if (!parsedReason.ok) return parsedReason;
    reason = parsedReason.value;
  }
  const key = parseNullableString(raw.key, `${path}.key`);
  if (!key.ok) return key;
  const error = parseNullableString(raw.error, `${path}.error`);
  if (!error.ok) return error;
  const archive = parseArchive(raw.archive, `${path}.archive`);
  if (!archive.ok) return archive;
  let task: BoardTask | null = null;
  if (raw.task !== null) {
    const parsedTask = parseTask(raw.task, `${path}.task`);
    if (!parsedTask.ok) return parsedTask;
    task = parsedTask.value;
  }
  return {
    ok: true,
    value: {
      workspaceId: raw.workspaceId as WorkspaceId,
      key: key.value,
      state: state.value,
      reason,
      task,
      error: error.value,
      archive: archive.value,
    },
  };
}

/** 보드 메시지(불명 JSON)를 항목 단위로 검증한다. 최상위가 깨지면 entries 를
 *  비우고 error 만 채운다(헤더 오류 표시). */
export function parseBoard(value: unknown): ParsedBoard {
  if (!isRecord(value)) return { entries: [], error: "board must be an object" };
  if (!Array.isArray(value.entries)) return { entries: [], error: "board.entries must be an array" };
  const entries: ParsedEntry[] = [];
  for (let i = 0; i < value.entries.length; i += 1) {
    const raw: unknown = value.entries[i];
    const path = `board.entries[${i}]`;
    if (!isRecord(raw)) {
      entries.push({ kind: "invalid", workspaceId: null, error: `${path} must be an object` });
      continue;
    }
    if (typeof raw.workspaceId !== "number") {
      entries.push({
        kind: "invalid",
        workspaceId: null,
        error: `${path}.workspaceId must be a number`,
      });
      continue;
    }
    const parsed = parseEntry(raw, path);
    if (parsed.ok) entries.push({ kind: "entry", ...parsed.value });
    else {
      entries.push({ kind: "invalid", workspaceId: raw.workspaceId, error: parsed.error });
    }
  }
  return { entries, error: null };
}

// ---- 카드 모델 ----

export interface QuestionCard {
  id: string;
  text: string;
  quote: string | null;
  anchorTab: TabId | null;
}

export interface DecisionCard {
  id: string;
  text: string;
  quote: string | null;
}

export interface NextCard {
  id: string;
  text: string;
}

export interface PlanCard {
  path: string;
  goal: string;
  steps: BoardTaskPlanStep[];
  status: "active" | "removed";
  /** 원문 링크 — removed 거나 워크스페이스 rootPath 가 없으면 null(비활성). */
  linkPath: string | null;
}

export interface CardProgress {
  text: string;
  reportedDone: boolean;
  verifiedDone: boolean;
}

export interface CardDecisions {
  user: DecisionCard[];
  ai: DecisionCard[];
  /** superseded 상태로 남은 결정 수 — 카드에 "N superseded" 로 표시한다. */
  supersededCount: number;
}

export interface BoardCard {
  workspaceId: WorkspaceId;
  workspaceName: string;
  /** task.title 이 비었으면 워크스페이스 이름 (REQ-18·D10). */
  title: string;
  headline: string;
  progress: CardProgress;
  openQuestions: QuestionCard[];
  decisions: CardDecisions;
  next: NextCard[];
  plans: PlanCard[];
  liveStatus: AgentStatus;
  state: BoardEntryState;
  /** entry 가 아예 없는 워크스페이스("no record yet")는 false. */
  hasEntry: boolean;
  reason: BoardEntryReason | null;
  archive: BoardArchive | null;
  /** state "error" 의 사유 또는 파싱 오류 메시지. */
  error: string | null;
  /** task.meta.last_error 가 있거나 글루가 failed/restarting/unsupported 일 때. */
  stale: boolean;
  limits: string[];
  updatedAt: string | null;
  updatedAgo: string | null;
}

const STALE_GLUE_STATES: readonly GlueState[] = ["failed", "restarting", "unsupported"];

/** "3m ago" 같은 짧은 영어 상대 시각. null/파싱 불가는 null. */
export function formatUpdatedAgo(iso: string | null, now: number): string | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function findEntry(board: ParsedBoard | null, workspaceId: WorkspaceId): ParsedEntry | null {
  if (board === null) return null;
  return board.entries.find((entry) => entry.workspaceId === workspaceId) ?? null;
}

function cardPlans(task: BoardTask | null, rootPath: string | null): PlanCard[] {
  return (task?.plans ?? []).map((plan) => ({
    path: plan.path,
    goal: plan.goal,
    steps: plan.steps,
    status: plan.status,
    linkPath:
      plan.status === "removed" || rootPath === null ? null : `${rootPath}/${plan.path}`,
  }));
}

function buildCard(
  ws: Workspace,
  entry: ParsedEntry | null,
  status: GlueStatus,
  now: number,
): BoardCard {
  const task = entry !== null && entry.kind === "entry" ? entry.task : null;
  const validEntry = entry !== null && entry.kind === "entry" ? entry : null;
  const decisions = task?.decisions ?? [];
  const updatedAt = task?.meta.updated_at ?? null;
  return {
    workspaceId: ws.id,
    workspaceName: ws.name,
    title: task !== null && task.title.trim() !== "" ? task.title : ws.name,
    headline: task?.headline ?? "",
    progress:
      task === null
        ? { text: "", reportedDone: false, verifiedDone: false }
        : {
            text: task.progress.text,
            reportedDone: task.progress.reported_done,
            verifiedDone: task.progress.verified_done,
          },
    openQuestions: (task?.open_questions ?? [])
      .filter((item) => item.status === "active")
      .map((item) => ({
        id: item.id,
        text: item.text,
        quote: item.quote,
        anchorTab: item.anchor?.tab ?? null,
      })),
    decisions: {
      user: decisions
        .filter((item) => item.status === "active" && item.by === "user")
        .map((item) => ({ id: item.id, text: item.text, quote: item.quote })),
      ai: decisions
        .filter((item) => item.status === "active" && item.by === "ai")
        .map((item) => ({ id: item.id, text: item.text, quote: item.quote })),
      supersededCount: decisions.filter((item) => item.status === "superseded").length,
    },
    next: (task?.next ?? [])
      .filter((item) => item.status === "active")
      .map((item) => ({ id: item.id, text: item.text })),
    plans: cardPlans(task, ws.rootPath),
    liveStatus: ws.agentStatus,
    state: entry === null ? "none" : entry.kind === "invalid" ? "error" : entry.state,
    hasEntry: entry !== null,
    reason: validEntry?.reason ?? null,
    archive: validEntry?.archive ?? null,
    error: entry?.error ?? null,
    stale: (task?.meta.last_error ?? null) !== null || STALE_GLUE_STATES.includes(status.state),
    limits: task?.meta.limits ?? [],
    updatedAt,
    updatedAgo: formatUpdatedAgo(updatedAt, now),
  };
}

/** 정렬 그룹(R2): needsInput 또는 활성 question → 0, running → 1, 그 외 → 2. */
function sortGroup(card: BoardCard): number {
  if (card.liveStatus === "needsInput" || card.openQuestions.length > 0) return 0;
  if (card.liveStatus === "running") return 1;
  return 2;
}

function compareCards(a: BoardCard, b: BoardCard): number {
  const group = sortGroup(a) - sortGroup(b);
  if (group !== 0) return group;
  if (a.updatedAt !== b.updatedAt) {
    if (a.updatedAt === null) return 1;
    if (b.updatedAt === null) return -1;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  }
  if (a.workspaceName === b.workspaceName) return 0;
  return a.workspaceName < b.workspaceName ? -1 : 1;
}

/** 대상 워크스페이스(관리자 제외)마다 카드를 만들고 R2 순서로 정렬한다. */
export function buildCards(
  state: AppState,
  board: ParsedBoard | null,
  status: GlueStatus,
  now: number,
): BoardCard[] {
  const cards = state.workspaces
    .filter((ws) => !ws.manager)
    .map((ws) => buildCard(ws, findEntry(board, ws.id), status, now));
  return cards.sort(compareCards);
}

export interface GoToTarget {
  workspace: WorkspaceId;
  tab: TabId | null;
}

/** 카드에서 이동할 원래 탭 (R2).
 *
 *  1. 그 워크스페이스에서 agentStatus 가 needsInput 인 탭 (여럿이면 가장 작은 id)
 *  2. 가장 최근 활성 question 의 anchor.tab — 그 탭이 스냅샷에 있을 때만.
 *     open_questions 는 append 순서라 마지막 활성 항목이 가장 최근이다.
 *  3. 없으면 워크스페이스 전환만 (tab null). */
export function goToTarget(card: BoardCard, state: AppState): GoToTarget {
  const ws = state.workspaces.find((candidate) => candidate.id === card.workspaceId);
  if (ws === undefined) return { workspace: card.workspaceId, tab: null };
  const tabs = Object.values(ws.panes).flatMap((pane) => pane.tabs);
  const waiting = tabs
    .filter((tab) => tab.agentStatus === "needsInput")
    .map((tab) => tab.id)
    .sort((a, b) => a - b);
  const smallestWaiting = waiting[0];
  if (smallestWaiting !== undefined) return { workspace: ws.id, tab: smallestWaiting };
  const newest = card.openQuestions[card.openQuestions.length - 1];
  if (
    newest !== undefined &&
    newest.anchorTab !== null &&
    tabs.some((tab) => tab.id === newest.anchorTab)
  ) {
    return { workspace: ws.id, tab: newest.anchorTab };
  }
  return { workspace: ws.id, tab: null };
}

// ---- 헤더 ----

const GLUE_STATE_LABELS: Record<GlueState, string> = {
  disabled: "Disabled",
  starting: "Starting",
  ok: "Watching",
  busy: "Collecting",
  failed: "Failed",
  unsupported: "Unsupported",
  restarting: "Restarting",
};

export interface HeaderModel {
  state: GlueState;
  /** 상태 라벨 (영어). */
  label: string;
  /** "Last collected 3m ago" 또는 "Never collected". */
  lastCollected: string;
  lastCollectedAt: string | null;
  logPath: string | null;
  /** logPath 가 있으면 Open log 버튼 활성. */
  canOpenLog: boolean;
}

export function headerModel(status: GlueStatus, now: number): HeaderModel {
  const logPath = status.logPath === null || status.logPath === "" ? null : status.logPath;
  const ago = formatUpdatedAgo(status.lastCollectedAt, now);
  return {
    state: status.state,
    label: GLUE_STATE_LABELS[status.state],
    lastCollected: ago === null ? "Never collected" : `Last collected ${ago}`,
    lastCollectedAt: status.lastCollectedAt,
    logPath,
    canOpenLog: logPath !== null,
  };
}
