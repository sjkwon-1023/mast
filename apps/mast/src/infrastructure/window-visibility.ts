// 창 숨김(최소화) 상태 — Tauri 창 이벤트 기반 fallback (체크포인트 2 실기 결함).
//
// 왜 이게 필요한가: WebView2 실환경에서 창을 최소화하거나 Alt+Tab 으로 넘어가도
// `visibilitychange` 가 오지 않고 `document.hidden` 도 계속 false 다. 그래서
// markdownViewer 의 mtime 폴링이 보이지 않는 창에서도 2초마다 fs_stat(9P 왕복)을
// 계속 내보냈다. 글루(main.rs)가 창 이벤트로 최소화를 판정해 `window-hidden`
// 이벤트를 보내고, 이 모듈이 그것을 프론트의 조회 가능한 상태로 만든다.
//
// **최소화만 숨김으로 친다.** 비포커스-가시(다른 창을 보고 있지만 mast 도 화면에
// 보이는) 상태는 숨김이 아니다 — 다른 창에서 .md 를 편집하며 mast 미리보기가
// 갱신되는 것을 보는 게 핵심 사용례라, blur 로 폴링을 멈추면 그 사용례가 죽는다.
// (자동 리셋 정책의 hidden = unfocused OR invisible 판정과는 별개 개념·별개
// 경로다 — 이 신호는 리셋 정책에 들어가지 않는다.)
//
// 구독 설치는 앱 수명 전체(1회)라 해제 경로를 두지 않는다 (app/store.ts 의
// state-changed 구독과 같은 규율). 상태기계는 DOM·IPC 무의존 클래스로 분리해
// listen 을 주입한 채 vitest 로 잠근다.

import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** main.rs 의 `WINDOW_HIDDEN_EVENT` 와 짝이다. */
export const WINDOW_HIDDEN_EVENT = "window-hidden";

/** 이벤트 구독 설치 함수 (테스트 주입). */
export type HiddenListen = (handler: (hidden: boolean) => void) => Promise<UnlistenFn>;

export type HiddenListener = (hidden: boolean) => void;

/** 글루도 전이에서만 emit 하지만 통지 판정을 여기서도 한 번 더 한다: 중복·재전송
 *  emit 이 와도 구독자(폴링 뷰)가 같은 상태로 두 번 깨어나지 않게 한다. */
export class WindowVisibility {
  private hidden = false;
  private installed = false;
  private readonly listeners = new Set<HiddenListener>();

  constructor(private readonly listen: HiddenListen) {}

  /** 이벤트 구독을 **1회만** 설치한다. 뷰 리셋(WebView reload)은 모듈 상태째 새로
   *  시작하므로 중복 설치 경로가 없다. */
  async init(): Promise<void> {
    if (this.installed) return;
    // await 앞에서 표시한다 — init 이 두 번 겹쳐 불려도 구독이 둘 생기지 않는다.
    this.installed = true;
    await this.listen((hidden) => this.set(hidden));
  }

  /** 신호가 오기 전(부팅 직후)에는 false 다. */
  get isHidden(): boolean {
    return this.hidden;
  }

  /** 구독자 수명 = 뷰 수명, 누수 금지. */
  subscribe(listener: HiddenListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 테스트에서 글루 없이 직접 주입할 수 있게 public — store.offer 전례. */
  set(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    for (const listener of this.listeners) listener(hidden);
  }
}

/** 창은 하나이고 신호도 하나다. 생성 시점에는 listen 을 부르지 않는다 (import
 *  만으로 IPC 를 건드리지 않게). */
const windowVisibility = new WindowVisibility((handler) =>
  listen<boolean>(WINDOW_HIDDEN_EVENT, (event) => handler(event.payload)),
);

/** 부트스트랩에서 1회 호출 (main.ts). */
export function initWindowVisibility(): Promise<void> {
  return windowVisibility.init();
}

/** 폴링 게이팅용 조회. */
export function isWindowHidden(): boolean {
  return windowVisibility.isHidden;
}

export function onWindowHiddenChange(listener: HiddenListener): () => void {
  return windowVisibility.subscribe(listener);
}
