// needsInput 알림 판정 (+ 휴면 상태의 알림 차임).
//
// **살아 있는 부분은 순수 판정이다**: detectNeedsInputOnset 이 "언제 알릴지"
// (탭 단위 needsInput 상승 전이)를, needsInputToastTargets 가 "어느 전이를 알릴지"
// (지금 화면에 보이지 않는 것만)를, needsInputToasts 가 토스트 문구를 정한다.
// DOM·IPC 배선은 app/main.ts 몫이다.
//
// **차임 재생은 v0.3.7 에서 배선에서 빠졌다 — 휴면이다** (사용자 결정 2026-08-13:
// 알림 신호를 OS 토스트로 일원화). 배경: v0.3.6 필드에서 차임은 울리는데 토스트가
// 전혀 안 뜨는 상태였고, 그 진단에서 "차임이 있으니 포커스 중에는 토스트를 억제한다"
// 라는 설계 자체가 알림을 반쪽으로 만들고 있었다. 차임은 어느 워크스페이스가
// 기다리는지를 말해 주지 못한다.
//
// Chime 클래스와 installChimeUnlock 은 **지우지 않고 남긴다** — send-mode 와 같은
// 취급이다(진입점만 UI 에서 빠진 검증된 코드). 소리를 되살리기로 하면 app/main.ts 에서
// installChimeUnlock + play() 두 줄을 다시 잇는 것이 전부이고, 그동안 아래 테스트가
// 이 코드를 계속 컴파일·검증한다. 휴면 코드는 번들에 남지만 tree-shaking 대상이고
// (import 가 없다) AudioContext 는 어차피 lazy 라 런타임 비용이 없다.
//
// --- 아래는 휴면 차임의 설계 근거 (되살릴 때 필요한 맥락) -------------------------
//
// 외부 오디오 에셋을 쓰지 않고 오실레이터로 합성하는 이유: 앱은 오프라인·CSP
// 아래서 도는 WebView 라 번들 밖 리소스를 가져올 수 없고, 0.3초짜리 알림음 하나에
// 에셋 파이프라인을 붙일 이유도 없다.
//
// AudioContext 는 **lazy** 다 — 부팅 시 만들면 사용자 제스처 전이라 어차피
// suspended 로 시작해 자원만 잡는다. 브라우저 autoplay 정책상 제스처 없이 만든
// 컨텍스트에 스케줄한 소리는 나지 않으므로, 첫 keydown/mousedown 에서 resume 하는
// unlock 패턴을 installChimeUnlock 이 배선한다. 그럼에도 재생 시점에 컨텍스트가
// 안 돌고 있으면 resume 을 한 번 더 시도하고, 실패는 조용히 넘긴다 — 알림음은
// 보조 신호라서 실패가 UI 동작을 막으면 안 된다 (원인은 console.debug 로만 남긴다).

import type { AgentStatus, Tab, TabId, WorkspaceId } from "../../shared/types";

/** 테스트가 가짜 컨텍스트를 주입하는 이음매다
 *  (WebAudio 는 node 환경에 없고, happy-dom 에도 없다). */
export type AudioContextFactory = () => AudioContext;

const defaultFactory: AudioContextFactory = () => new AudioContext();

/** 일부러 낮게(0.1) 잡는다. 알림은 존재를 알리는 정도면 충분하고,
 *  작업 중 놀랄 만큼 크면 사용자가 소리를 아예 꺼 버린다. */
const PEAK_GAIN = 0.1;

/** exponentialRamp 는 0 을 목표로 잡을 수 없어 (0 이면 예외) 이 값으로 대신한다. */
const SILENT_GAIN = 0.0001;

/** 0 에서 즉시 켜면 클릭 잡음이 난다. */
const ATTACK_S = 0.02;

/** 총 길이 0.3s. A5 → E6 의 상승 5도라 "질문/대기" 로 읽힌다
 *  (하강 음정은 완료·실패로 읽혀 의미가 반대다). */
const TONES: readonly { freq: number; at: number; dur: number }[] = [
  { freq: 880, at: 0, dur: 0.16 },
  { freq: 1320, at: 0.14, dur: 0.16 },
];

/** **휴면** (모듈 머리 주석 참조) — 지금 이 클래스를 부르는 배선은 없다. */
export class Chime {
  private ctx: AudioContext | null = null;
  /** 재시도하지 않는다 — WebAudio 자체가 없는 환경이면 렌더마다 예외를 다시
   *  만들 이유가 없다. */
  private unavailable = false;

  constructor(private readonly createContext: AudioContextFactory = defaultFactory) {}

  /** autoplay 정책 unlock — installChimeUnlock 이 첫 keydown/mousedown 에서 부른다. */
  unlock(): void {
    const ctx = this.context();
    if (ctx === null) return;
    this.resume(ctx);
  }

  /** 컨텍스트가 안 돌고 있으면 resume 을 시도하되 **기다리지 않는다**: 제스처
   *  이력이 있으면 대개 즉시 풀려 스케줄된 소리가 그대로 나고, 아니면 이번
   *  소리는 조용히 사라진다. */
  play(): void {
    const ctx = this.context();
    if (ctx === null) return;
    if (ctx.state !== "running") this.resume(ctx);
    try {
      const now = ctx.currentTime;
      for (const tone of TONES) this.schedule(ctx, tone.freq, now + tone.at, tone.dur);
    } catch (err) {
      console.debug("[mast] chime scheduling failed", err);
    }
  }

  /** 노드는 stop 뒤 자동 해제되므로 별도 정리가 없다. */
  private schedule(ctx: AudioContext, freq: number, startAt: number, duration: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, startAt);
    gain.gain.setValueAtTime(SILENT_GAIN, startAt);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startAt + ATTACK_S);
    gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, startAt + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + duration);
  }

  /** lazy 컨텍스트 — 생성 실패는 이 기능만 끄고 호출측에는 알리지 않는다. */
  private context(): AudioContext | null {
    if (this.ctx !== null) return this.ctx;
    if (this.unavailable) return null;
    try {
      this.ctx = this.createContext();
    } catch (err) {
      this.unavailable = true;
      console.debug("[mast] AudioContext unavailable — chime disabled", err);
      return null;
    }
    return this.ctx;
  }

  /** 거부(autoplay 정책)는 삼킨다. 다음 제스처·다음 재생에서 다시 시도되므로
   *  여기서 상태를 기억할 필요가 없다. */
  private resume(ctx: AudioContext): void {
    try {
      void ctx.resume().catch(() => undefined);
    } catch (err) {
      console.debug("[mast] chime resume failed", err);
    }
  }
}

/** **휴면** — 모듈 머리 주석 참조.
 *  capture 단계로 다는 이유는 활동 핑과 같다: xterm 이 포커스를 쥐고 있어도 window
 *  까지 도달한다. 1회 뒤 리스너를 떼는 것은 이후 재생 경로가 알아서 resume 을
 *  재시도하기 때문이다 — 상시 리스너를 남길 이유가 없다. */
export function installChimeUnlock(chime: Chime, target: EventTarget = window): void {
  // capture 는 객체 형태로 넘긴다 — 브라우저는 boolean 도 받지만 node 의 EventTarget
  // 은 removeEventListener 에서 boolean 형태의 capture 를 무시해(옵션 객체만 읽는다)
  // 리스너가 떨어지지 않는다. 등록/해제 옵션이 어긋나면 해제가 조용히 실패한다.
  const opts = { capture: true } as const;
  const unlock = (): void => {
    target.removeEventListener("keydown", unlock, opts);
    target.removeEventListener("mousedown", unlock, opts);
    chime.unlock();
  };
  target.addEventListener("keydown", unlock, opts);
  target.addEventListener("mousedown", unlock, opts);
}

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
   *  기다리기 시작해도 어느 에이전트가 무엇을 묻는지가 토스트의 내용이라 합치지 않는다.
   *
   *  **계약 변경 (v0.3.7)**: 예전에는 `chime: boolean`(= `onsets.length > 0`)이
   *  같이 실렸다. 차임 배선이 빠져 그 파생값을 쓸 곳이 없어졌으므로 제거했다 —
   *  같은 사실을 두 모양으로 들고 다니면 어긋날 수 있다. */
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
