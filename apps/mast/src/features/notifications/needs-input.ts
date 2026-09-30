// needsInput 알림 판정 (순수). detectNeedsInputOnset 이 "언제 알릴지"(탭 단위
// needsInput 상승 전이)를, needsInputToastTargets 가 "어느 전이를 알릴지"(지금 화면에
// 보이지 않는 것만)를, needsInputToasts 가 토스트 문구를 정한다. DOM·IPC 배선은
// app/main.ts 몫이다.

import type { AgentStatus, Tab, TabId, WorkspaceId } from "../../shared/types";

/** 판정이 읽는 스냅샷 필드만 요구한다 (Workspace 전체를 요구하지 않아 테스트가 가볍다). */
export type OnsetTab = Pick<Tab, "id" | "title" | "agentStatus" | "lastAgentMessage">;

export interface OnsetWorkspace {
  id: WorkspaceId;
  name: string;
  panes: Readonly<Record<string, { readonly tabs: readonly OnsetTab[] }>>;
}

export interface TabOnset {
  workspaceId: WorkspaceId;
  tabId: TabId;
}

export interface NeedsInputOnset {
  /** needsInput 으로 **새로 전이한** 탭들 — 워크스페이스 입력 순서, 그 안에서는
   *  pane·탭 순서다. 알림은 탭마다 하나다: 같은 워크스페이스의 두 탭이 함께
   *  기다리기 시작해도 어느 에이전트가 무엇을 묻는지가 토스트의 내용이라 합치지 않는다. */
  onsets: TabOnset[];
  /** 다음 판정의 기준선 — 사라진 탭은 빠지므로 맵 크기가 탭 수를 넘지 않고, 같은
   *  id 가 다시 나타나면 신규로 취급된다. */
  next: Map<TabId, AgentStatus>;
}

function tabsOf(ws: OnsetWorkspace): readonly OnsetTab[] {
  return Object.values(ws.panes).flatMap((pane) => pane.tabs);
}

/** needsInput **상승 전이** 판정 (순수) — 직전에 needsInput 이 아니었다가
 *  needsInput 이 된 탭만 `onsets` 에 담긴다.
 *
 *  워크스페이스가 아니라 탭 단위로 보는 이유: 워크스페이스 상태는 탭들의 파생값이라,
 *  이미 needsInput 인 워크스페이스에서 다른 탭이 기다리기 시작해도 그 값은 변하지
 *  않는다 — 워크스페이스로 판정하면 두 번째 탭의 알림이 사라진다.
 *
 *  - 같은 상태 반복(needsInput → needsInput)은 무알림. 스냅샷은 무관한 변경
 *    (탭 활동·git 등)으로도 자주 오므로, 반복까지 알리면 소음이 된다.
 *  - running·idle 로의 전환은 전부 무알림 — 사용자의 개입을 기다리는 상태는
 *    needsInput 하나뿐이다 (sidebar 의 강조 규칙과 같은 판단).
 *  - 신규 탭의 첫 상태가 needsInput 이면 알린다 (prev 에 없는 id 는
 *    "needsInput 이 아니었다" 로 친다).
 *  - `prev === null` 은 **부팅 첫 스냅샷**이다: 알림 없이 기준선만 채운다. 재시작
 *    복원은 코어 sanitize 가 탭의 agent_status 를 Idle 로 초기화하므로 자연히 조용하지만,
 *    WebView 리로드·자동 리셋에서는 살아 있는 세션의 needsInput 이 그대로 첫
 *    스냅샷에 실려 온다 — 그때 알리면 "전이"가 아닌 것에 알리는 셈이라 명시적으로
 *    기준선 취급한다. */
export function detectNeedsInputOnset(
  prev: ReadonlyMap<TabId, AgentStatus> | null,
  workspaces: readonly OnsetWorkspace[],
): NeedsInputOnset {
  const next = new Map<TabId, AgentStatus>();
  const onsets: TabOnset[] = [];
  for (const ws of workspaces) {
    for (const tab of tabsOf(ws)) {
      next.set(tab.id, tab.agentStatus);
      if (prev === null) continue;
      if (tab.agentStatus !== "needsInput") continue;
      if (prev.get(tab.id) === "needsInput") continue;
      onsets.push({ workspaceId: ws.id, tabId: tab.id });
    }
  }
  return { onsets, next };
}

/** 토스트를 실제로 띄울 전이 선별 (순수) — 상승 전이 중 **지금 화면에 보이지
 *  않는** 워크스페이스의 것만 남긴다.
 *
 *  규칙은 하나다: **창이 포커스 상태이고 그 워크스페이스가 활성**이면 띄우지
 *  않는다 (사용자가 이미 그 화면을 보고 있고, 사이드바 강조가 같은 사실을 말한다).
 *  나머지는 전부 띄운다 — 창이 비포커스면 물론이고, **포커스 중이라도 지금 안 보이는
 *  다른 워크스페이스**는 알려야 한다. v0.3.6 까지는 포커스면 전부 억제해서, 옆
 *  워크스페이스가 기다리기 시작한 것을 놓쳤다 (v0.3.7 재설계).
 *
 *  기준이 탭 가시성이 아니라 워크스페이스인 것은 의도다: 활성 워크스페이스의 가려진
 *  탭(배경 탭·넘쳐 잘린 탭)은 탭·pane 배지가 같은 사실을 말하므로, 토스트까지 띄우면
 *  같은 알림이 두 번 온다.
 *
 *  `windowFocused` 는 **OS 창 이벤트**(main.rs 의 `window-focus`)에서 온 값이어야
 *  한다. `document.hasFocus()` 는 WebView2 에서 창이 비포커스인데도 true 로 남는
 *  quirk 가 있어(v0.3.6 "토스트가 아예 안 뜬다"의 용의자 중 하나) 판정 근거로 쓸 수
 *  없다.
 *
 *  `activeWorkspace` 가 null(워크스페이스가 하나도 없음)이면 억제 조건이 성립하지
 *  않으므로 전부 대상이다 — 그 상태에서 전이가 오는 경우는 사실상 없지만, 규칙을
 *  분기 없이 그대로 쓴다. */
export function needsInputToastTargets(
  onsets: readonly TabOnset[],
  activeWorkspace: WorkspaceId | null,
  windowFocused: boolean,
): TabOnset[] {
  return onsets.filter((o) => !(windowFocused && o.workspaceId === activeWorkspace));
}

export interface NeedsInputToast {
  title: string;
  body: string;
  /** `toast.log` 에 제목 대신 남는다. 탭 제목은 OSC 0/2 로 들어온 작업 주제·경로라,
   *  본문을 남기지 않는다는 그 로그의 설계를 지키려면 제목도 빠져야 한다. */
  logLabel: string;
}

const TOAST_FALLBACK_BODY = "agent needs your input";

function toastBody(lastAgentMessage: string | null): string {
  const firstLine = (lastAgentMessage ?? "").split("\n", 1)[0].trim();
  return firstLine === "" ? TOAST_FALLBACK_BODY : firstLine;
}

/** 대상 하나당 토스트 하나 (순수). 본문은 **그 탭의** 메시지뿐이고 워크스페이스
 *  메시지로 대신하지 않는다 — 워크스페이스 메시지는 탭들에서 고른 파생값이라 다른
 *  탭의 질문일 수 있다. */
export function needsInputToasts(
  targets: readonly TabOnset[],
  workspaces: readonly OnsetWorkspace[],
): NeedsInputToast[] {
  const toasts: NeedsInputToast[] = [];
  for (const { workspaceId, tabId } of targets) {
    const ws = workspaces.find((w) => w.id === workspaceId);
    const tab = ws === undefined ? undefined : tabsOf(ws).find((t) => t.id === tabId);
    if (ws === undefined || tab === undefined) continue;
    toasts.push({
      title: `mast — ${ws.name} · ${tab.title}`,
      body: toastBody(tab.lastAgentMessage),
      logLabel: `${ws.name} #${tab.id}`,
    });
  }
  return toasts;
}
