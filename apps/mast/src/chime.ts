// needsInput 알림 판정 (+ 휴면 상태의 알림 차임).
//
// **살아 있는 부분은 순수 판정 둘이다**: detectNeedsInputOnset 이 "언제 알릴지"
// (needsInput 상승 전이)를, needsInputToastTargets 가 "어느 워크스페이스를 알릴지"
// (지금 화면에 보이지 않는 것만)를 정한다. DOM·IPC 배선은 main.ts 몫이다.
//
// **차임 재생은 v0.3.7 에서 배선에서 빠졌다 — 휴면이다** (사용자 결정 2026-08-13:
// 알림 신호를 OS 토스트로 일원화). 배경: v0.3.6 필드에서 차임은 울리는데 토스트가
// 전혀 안 뜨는 상태였고, 그 진단에서 "차임이 있으니 포커스 중에는 토스트를 억제한다"
// 라는 설계 자체가 알림을 반쪽으로 만들고 있었다. 차임은 어느 워크스페이스가
// 기다리는지를 말해 주지 못한다.
//
// Chime 클래스와 installChimeUnlock 은 **지우지 않고 남긴다** — send-mode 와 같은
// 취급이다(진입점만 UI 에서 빠진 검증된 코드). 소리를 되살리기로 하면 main.ts 에서
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

import type { AgentStatus, WorkspaceId } from "./types";

/** AudioContext 생성기 — 테스트가 가짜 컨텍스트를 주입하는 이음매다
 *  (WebAudio 는 node 환경에 없고, happy-dom 에도 없다). */
export type AudioContextFactory = () => AudioContext;

const defaultFactory: AudioContextFactory = () => new AudioContext();

/** 피크 게인 — 일부러 낮게(0.1) 잡는다. 알림은 존재를 알리는 정도면 충분하고,
 *  작업 중 놀랄 만큼 크면 사용자가 소리를 아예 꺼 버린다. */
const PEAK_GAIN = 0.1;

/** 엔벨로프의 사실상 무음 값 — exponentialRamp 는 0 을 목표로 잡을 수 없어
 *  (0 이면 예외) 이 값으로 대신한다. */
const SILENT_GAIN = 0.0001;

/** 상승 attack 시간(초) — 0 에서 즉시 켜면 클릭 잡음이 난다. */
const ATTACK_S = 0.02;

/** 2음 스케줄(초) — 총 길이 0.3s. A5 → E6 의 상승 5도라 "질문/대기" 로 읽힌다
 *  (하강 음정은 완료·실패로 읽혀 의미가 반대다). */
const TONES: readonly { freq: number; at: number; dur: number }[] = [
  { freq: 880, at: 0, dur: 0.16 },
  { freq: 1320, at: 0.14, dur: 0.16 },
];

/** **휴면** (모듈 머리 주석 참조) — 지금 이 클래스를 부르는 배선은 없다. */
export class Chime {
  private ctx: AudioContext | null = null;
  /** 컨텍스트 생성이 실패한 환경 표시 — 재시도하지 않는다 (WebAudio 자체가 없는
   *  환경이면 렌더마다 예외를 다시 만들 이유가 없다). */
  private unavailable = false;

  constructor(private readonly createContext: AudioContextFactory = defaultFactory) {}

  /** 사용자 제스처 훅 — 컨텍스트를 만들고 resume 한다 (autoplay 정책 unlock).
   *  installChimeUnlock 이 첫 keydown/mousedown 에서 부른다. */
  unlock(): void {
    const ctx = this.context();
    if (ctx === null) return;
    this.resume(ctx);
  }

  /** 차임 1회 재생 — 2음을 현재 시각 기준으로 스케줄한다. 컨텍스트가 안 돌고
   *  있으면 resume 을 시도하되 **기다리지 않는다**: 제스처 이력이 있으면 대개
   *  즉시 풀려 스케줄된 소리가 그대로 나고, 아니면 이번 소리는 조용히 사라진다. */
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

  /** 오실레이터 1음 — sine + 짧은 attack/decay 엔벨로프. 노드는 stop 뒤 자동
   *  해제되므로 별도 정리가 없다. */
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

  /** resume 시도 — 거부(autoplay 정책)는 삼킨다. 다음 제스처·다음 재생에서 다시
   *  시도되므로 여기서 상태를 기억할 필요가 없다. */
  private resume(ctx: AudioContext): void {
    try {
      void ctx.resume().catch(() => undefined);
    } catch (err) {
      console.debug("[mast] chime resume failed", err);
    }
  }
}

/** 사용자 제스처 unlock 배선 (**휴면** — 모듈 머리 주석 참조) — 첫 keydown/mousedown
 *  에서 1회 resume 한다.
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

/** 전이 판정 입력 — 스냅샷 워크스페이스에서 쓰는 두 필드만 요구한다
 *  (Workspace 전체를 요구하지 않아 테스트가 가볍다). */
export interface AgentStatusEntry {
  id: WorkspaceId;
  agentStatus: AgentStatus;
}

export interface NeedsInputOnset {
  /** needsInput 으로 **새로 전이한** 워크스페이스들 (입력 순서 그대로). 알림은
   *  워크스페이스마다 하나다 — "어느 프로젝트가 기다리는가"가 토스트의 내용
   *  자체라, 합치면 알림의 의미가 사라진다.
   *
   *  **계약 변경 (v0.3.7)**: 예전에는 `chime: boolean`(= `onsets.length > 0`)이
   *  같이 실렸다. 차임 배선이 빠져 그 파생값을 쓸 곳이 없어졌으므로 제거했다 —
   *  같은 사실을 두 모양으로 들고 다니면 어긋날 수 있다. */
  onsets: WorkspaceId[];
  /** 다음 판정의 기준선이 될 상태 맵 — 사라진 워크스페이스는 빠지므로 맵이 무한히
   *  자라지 않고, 같은 id 가 다시 나타나면 신규로 취급된다. */
  next: Map<WorkspaceId, AgentStatus>;
}

/** needsInput **상승 전이** 판정 (순수) — 어느 워크스페이스든 직전에 needsInput 이
 *  아니었다가 needsInput 이 된 경우에만 그 워크스페이스가 `onsets` 에 담긴다.
 *
 *  - 같은 상태 반복(needsInput → needsInput)은 무알림. 스냅샷은 무관한 변경
 *    (탭 활동·git 등)으로도 자주 오므로, 반복까지 알리면 소음이 된다.
 *  - running·idle 로의 전환은 전부 무알림 — 사용자의 개입을 기다리는 상태는
 *    needsInput 하나뿐이다 (sidebar 의 강조 규칙과 같은 판단).
 *  - 신규 워크스페이스의 첫 상태가 needsInput 이면 알린다 (prev 에 없는 id 는
 *    "needsInput 이 아니었다" 로 친다).
 *  - `prev === null` 은 **부팅 첫 스냅샷**이다: 알림 없이 기준선만 채운다. 재시작
 *    복원은 코어 sanitize 가 agent_status 를 Idle 로 초기화하므로 자연히 조용하지만,
 *    WebView 리로드·자동 리셋에서는 살아 있는 세션의 needsInput 이 그대로 첫
 *    스냅샷에 실려 온다 — 그때 알리면 "전이"가 아닌 것에 알리는 셈이라 명시적으로
 *    기준선 취급한다. */
export function detectNeedsInputOnset(
  prev: ReadonlyMap<WorkspaceId, AgentStatus> | null,
  workspaces: readonly AgentStatusEntry[],
): NeedsInputOnset {
  const next = new Map<WorkspaceId, AgentStatus>();
  const onsets: WorkspaceId[] = [];
  for (const ws of workspaces) {
    next.set(ws.id, ws.agentStatus);
    if (prev === null) continue;
    if (ws.agentStatus !== "needsInput") continue;
    if (prev.get(ws.id) === "needsInput") continue;
    onsets.push(ws.id);
  }
  return { onsets, next };
}

/** 토스트를 실제로 띄울 워크스페이스 선별 (순수) — 상승 전이 중 **지금 화면에
 *  보이지 않는** 것만 남긴다.
 *
 *  규칙은 하나다: **창이 포커스 상태이고 그 워크스페이스가 활성**이면 띄우지
 *  않는다 (사용자가 이미 그 화면을 보고 있고, 사이드바 강조가 같은 사실을 말한다).
 *  나머지는 전부 띄운다 — 창이 비포커스면 물론이고, **포커스 중이라도 지금 안 보이는
 *  다른 워크스페이스**는 알려야 한다. v0.3.6 까지는 포커스면 전부 억제해서, 옆
 *  워크스페이스가 기다리기 시작한 것을 놓쳤다 (v0.3.7 재설계).
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
  onsets: readonly WorkspaceId[],
  activeWorkspace: WorkspaceId | null,
  windowFocused: boolean,
): WorkspaceId[] {
  return onsets.filter((id) => !(windowFocused && id === activeWorkspace));
}
