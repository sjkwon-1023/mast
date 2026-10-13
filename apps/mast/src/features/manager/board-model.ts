// 관리자 작업 보드 카드 모델 — DOM 없이 보드 JSON 검증·카드 계산·정렬·이동
// 대상·헤더 문자열만 담당한다. 뷰는 이 모델을 그리기만 한다.
//
// board 메시지는 신뢰할 수 없는 JSON 이므로 parseBoard 가 항목 단위로 검증하고,
// 형식이 깨진 항목은 버리지 않고 `kind: "invalid"` 로 남겨 오류 카드로 표시한다
// (숨기면 보드가 "기록 없음"과 "깨진 기록"을 구분하지 못한다). 최상위 형식이
// 깨졌을 때만 entries 를 비우고 error 를 채운다 — 헤더 오류 표시용이다.
//
// 계약: 하네스 board/status 메시지와 board entry 스키마(ADR-0032). 최신 요약은
// progress/needs_input/next 세 문자열이고, 이 모듈은 표시에 필요한 타입·enum만
// 검증한다(길이·상태 조합 검사는 하지 않는다).

import type { AgentStatus, AppState, TabId, Workspace, WorkspaceId } from "../../shared/types";

// ---- 하네스 → 앱 메시지 ----

export type BoardEntryState = "active" | "none" | "unsupported" | "error";
export type BoardEntryReason = "no_root" | "other_distro" | "no_transcript";

/** 최신 요약 세 필드 — 하네스가 bounded 로 저장한 표시 문자열. */
export interface BoardSummary {
  progress: string;
  needs_input: string;
  next: string;
}

/** 보드 entry 의 repo — 하네스가 git 공통 디렉터리에서 판별한 레포. */
export interface BoardRepo {
  name: string;
  path: string;
  remote: string | null;
}

export interface BoardEntry {
  workspaceId: WorkspaceId;
  key: string | null;
  state: BoardEntryState;
  reason: BoardEntryReason | null;
  summary: BoardSummary | null;
  updatedAt: string | null;
  lastError: string | null;
  inputTruncated: boolean;
  error: string | null;
  repo: BoardRepo | null;
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
  "error",
];
const ENTRY_REASONS: readonly BoardEntryReason[] = ["no_root", "other_distro", "no_transcript"];

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

/** repo 는 카드 표시에만 쓰므로 형식이 틀려도 entry 를 버리지 않고 null 로 둔다. */
function parseRepo(value: unknown): BoardRepo | null {
  if (!isRecord(value)) return null;
  const name = value.name;
  const path = value.path;
  const remote = value.remote;
  if (typeof name !== "string" || name === "") return null;
  if (typeof path !== "string" || path === "") return null;
  if (remote !== null && remote !== undefined && typeof remote !== "string") return null;
  return { name, path, remote: typeof remote === "string" && remote !== "" ? remote : null };
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

/** 요약은 표시에 필요한 세 문자열 타입만 검사한다 (길이 검사 없음). */
function parseSummary(value: unknown, path: string): Parsed<BoardSummary> {
  if (!isRecord(value)) return fail(`${path} must be an object`);
  for (const field of ["progress", "needs_input", "next"] as const) {
    if (typeof value[field] !== "string") return fail(`${path}.${field} must be a string`);
  }
  return {
    ok: true,
    value: {
      progress: value.progress as string,
      needs_input: value.needs_input as string,
      next: value.next as string,
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
  const updatedAt = parseNullableString(raw.updatedAt, `${path}.updatedAt`);
  if (!updatedAt.ok) return updatedAt;
  const lastError = parseNullableString(raw.lastError, `${path}.lastError`);
  if (!lastError.ok) return lastError;
  if (typeof raw.inputTruncated !== "boolean") {
    return fail(`${path}.inputTruncated must be a boolean`);
  }
  let summary: BoardSummary | null = null;
  if (raw.summary !== null) {
    const parsedSummary = parseSummary(raw.summary, `${path}.summary`);
    if (!parsedSummary.ok) return parsedSummary;
    summary = parsedSummary.value;
  }
  return {
    ok: true,
    value: {
      workspaceId: raw.workspaceId as WorkspaceId,
      key: key.value,
      state: state.value,
      reason,
      summary,
      updatedAt: updatedAt.value,
      lastError: lastError.value,
      inputTruncated: raw.inputTruncated,
      error: error.value,
      repo: parseRepo(raw.repo),
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

export interface CardSummary {
  progress: string;
  needsInput: string;
  next: string;
}

export interface BoardCard {
  workspaceId: WorkspaceId;
  workspaceName: string;
  /** 하네스가 판별한 레포. 없으면 null 이며 그룹에서는 "Other" 로 묶인다. */
  repo: BoardRepo | null;
  summary: CardSummary;
  liveStatus: AgentStatus;
  state: BoardEntryState;
  /** entry 가 아예 없는 워크스페이스("no record yet")는 false. */
  hasEntry: boolean;
  reason: BoardEntryReason | null;
  /** state "error" 의 사유 또는 파싱 오류 메시지. */
  error: string | null;
  /** entry.lastError 가 있거나 글루가 failed/restarting/unsupported 일 때. */
  stale: boolean;
  /** 마지막 성공 수집이 입력을 생략했다. */
  inputTruncated: boolean;
  updatedAt: string | null;
  updatedAgo: string | null;
}

const STALE_GLUE_STATES: readonly GlueState[] = ["failed", "restarting", "unsupported"];
const EMPTY_SUMMARY: CardSummary = { progress: "", needsInput: "", next: "" };

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

function buildCard(
  ws: Workspace,
  entry: ParsedEntry | null,
  status: GlueStatus,
  now: number,
): BoardCard {
  const validEntry = entry !== null && entry.kind === "entry" ? entry : null;
  const summary = validEntry?.summary ?? null;
  const updatedAt = validEntry?.updatedAt ?? null;
  return {
    workspaceId: ws.id,
    workspaceName: ws.name,
    repo: validEntry?.repo ?? null,
    summary:
      summary === null
        ? EMPTY_SUMMARY
        : {
            progress: summary.progress,
            needsInput: summary.needs_input,
            next: summary.next,
          },
    liveStatus: ws.agentStatus,
    state: entry === null ? "none" : entry.kind === "invalid" ? "error" : entry.state,
    hasEntry: entry !== null,
    reason: validEntry?.reason ?? null,
    error: entry?.error ?? null,
    stale: (validEntry?.lastError ?? null) !== null || STALE_GLUE_STATES.includes(status.state),
    inputTruncated: validEntry?.inputTruncated ?? false,
    updatedAt,
    updatedAgo: formatUpdatedAgo(updatedAt, now),
  };
}

/** 입력 대기 — 라이브 needsInput 이거나 요약이 답을 기다린다. */
export function isWaitingInput(card: BoardCard): boolean {
  return card.liveStatus === "needsInput" || card.summary.needsInput.trim() !== "";
}

/** 정렬 그룹(R2): needsInput 또는 needs_input → 0, running → 1, 그 외 → 2. */
function sortGroup(card: BoardCard): number {
  if (isWaitingInput(card)) return 0;
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

// ---- 레포 그룹 ----

/** 레포가 없는 카드가 모이는 그룹의 키. */
export const OTHER_GROUP_KEY = "other";
const OTHER_GROUP_LABEL = "Other";

export interface BoardGroup {
  /** 레포 path, 레포가 없으면 "other". */
  key: string;
  /** 표시 라벨 — 레포 이름, 없으면 "Other". 같은 이름이 갈리면 구분자를 덧붙인다. */
  label: string;
  /** 입력 순서를 지킨 카드 — buildCards 결과를 그대로 받으면 그룹 안 정렬도 유지된다. */
  cards: BoardCard[];
}

/** 원격 URL을 "owner/repo" 꼴의 짧은 구분자로 바꾼다. 빈 값이면 null. */
function shortRemote(remote: string): string | null {
  let text = remote.trim();
  if (text === "") return null;
  const scheme = text.indexOf("://");
  if (scheme >= 0) {
    const rest = text.slice(scheme + 3);
    const slash = rest.indexOf("/");
    text = slash >= 0 ? rest.slice(slash + 1) : rest;
  } else {
    const colon = text.indexOf(":");
    if (colon >= 0) text = text.slice(colon + 1);
  }
  if (text.endsWith(".git")) text = text.slice(0, -4);
  const segments = text.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return null;
  return segments.slice(-2).join("/");
}

/** 이름이 같은 레포 그룹의 라벨 뒤에 원격(또는 경로) 구분자를 붙인다. */
function labelGroups(groups: BoardGroup[], repos: Map<string, BoardRepo | null>): void {
  const byName = new Map<string, BoardGroup[]>();
  for (const group of groups) {
    const seen = byName.get(group.label);
    if (seen === undefined) byName.set(group.label, [group]);
    else seen.push(group);
  }
  for (const [name, colliding] of byName) {
    if (colliding.length < 2) continue;
    const remotes = colliding.map((group) => {
      const remote = repos.get(group.key)?.remote ?? null;
      return remote === null ? null : shortRemote(remote);
    });
    const remoteUsable =
      remotes.every((remote): remote is string => remote !== null) &&
      new Set(remotes).size === remotes.length;
    for (const [index, group] of colliding.entries()) {
      const repo = repos.get(group.key) ?? null;
      const suffix = (remoteUsable ? remotes[index] : null) ?? repo?.path ?? group.key;
      group.label = `${name} (${suffix})`;
    }
  }
}

/** 그룹 순서 — 가장 우선인 카드의 R2 그룹과 갱신 시각. "Other" 는 동률이면 마지막. */
function compareGroups(a: BoardGroup, b: BoardGroup): number {
  const aBest = a.cards[0];
  const bBest = b.cards[0];
  if (aBest === undefined || bBest === undefined) return 0;
  const group = sortGroup(aBest) - sortGroup(bBest);
  if (group !== 0) return group;
  if (aBest.updatedAt !== bBest.updatedAt) {
    if (aBest.updatedAt === null) return 1;
    if (bBest.updatedAt === null) return -1;
    return aBest.updatedAt < bBest.updatedAt ? 1 : -1;
  }
  const aOther = a.key === OTHER_GROUP_KEY ? 1 : 0;
  const bOther = b.key === OTHER_GROUP_KEY ? 1 : 0;
  return aOther - bOther;
}

/** 카드를 레포 path 로 묶는다. 그룹은 첫 등장 순서로 모은 뒤 R2 우선순위로 정렬한다. */
export function groupCards(cards: BoardCard[]): BoardGroup[] {
  const groups: BoardGroup[] = [];
  const byKey = new Map<string, BoardGroup>();
  const repos = new Map<string, BoardRepo | null>();
  for (const card of cards) {
    const key = card.repo?.path ?? OTHER_GROUP_KEY;
    let group = byKey.get(key);
    if (group === undefined) {
      group = { key, label: card.repo?.name ?? OTHER_GROUP_LABEL, cards: [] };
      byKey.set(key, group);
      repos.set(key, card.repo);
      groups.push(group);
    }
    group.cards.push(card);
  }
  labelGroups(groups, repos);
  return groups.sort(compareGroups);
}

export interface GoToTarget {
  workspace: WorkspaceId;
  tab: TabId | null;
}

/** 카드에서 이동할 원래 탭 (R2).
 *
 *  1. 그 워크스페이스에서 agentStatus 가 needsInput 인 탭 (여럿이면 가장 작은 id)
 *  2. 없으면 워크스페이스 전환만 (tab null). */
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
