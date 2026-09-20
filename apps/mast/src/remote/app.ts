// 폰 UI 의 공통 뼈대 — 목록 ↔ 탭 전환과 가시성 게이트.
//
// 두 엔트리(Local HTTP `remote/main.ts`, Secure Remote `secure-remote/main.ts`)가 같은
// 것을 쓴다. 다른 것은 어느 [`RemoteTransport`] 를 넣는지와 글자 크기를 저장하는지뿐이다.

import { ListView } from "./list-view";
import { PollSchedule } from "./poller";
import { TabView } from "./tab-view";
import { RemoteError, TransportClosedError } from "./transport";
import type { FontPxStore, RemoteTransport } from "./transport";
import type { TabId } from "../shared/types";

const STATE_POLL_INTERVAL_MS = 2000;

export interface RemoteAppOptions {
  root: HTMLElement;
  transport: RemoteTransport;
  /** 글자 크기 기억 — 없으면 메모리 값만 (Secure Remote). */
  fontPx?: FontPxStore;
  /** 연결 대상 표시(`host:port`). 있으면 두 화면 위에 계속 붙어 있다 — 사용자가
   *  어느 호스트로 붙었는지 확인할 수 있는 유일한 단서다 (Secure Remote). */
  destination?: string;
}

export class RemoteApp {
  private readonly listView: ListView;
  private readonly listSchedule: PollSchedule;
  private readonly destinationEl: HTMLElement | null;
  private tabView: TabView | null = null;
  /** 연결이 끝난 뒤의 문구. null 이 아니면 이 앱은 영구 종료다 — 어떤 늦은
   *  응답도 이 값을 지우거나 새 폴링·탭 화면을 만들 수 없다. */
  private closedMessage: string | null = null;

  private readonly visibility = () => this.applyVisibility();
  private unsubscribeClosed: (() => void) | undefined;

  constructor(private readonly options: RemoteAppOptions) {
    this.destinationEl =
      options.destination === undefined ? null : destinationBar(options.destination);
    this.listView = new ListView({ onOpenTab: (tab, title) => this.openTab(tab, title) });
    this.listSchedule = new PollSchedule({
      intervalMs: STATE_POLL_INTERVAL_MS,
      poll: () => this.pollState(),
      onHalt: (reason) => {
        this.listView.setNotice(
          reason === "unauthorized"
            ? "Not authorized — scan the pairing QR in mast again."
            : "Too many requests — retrying in a minute.",
        );
      },
    });
    document.addEventListener("visibilitychange", this.visibility);
    // 연결 종료는 목록 화면에도 남긴다 — 탭에서 Back 으로 나온 사용자가 빈 화면을
    // 만나지 않게. 재연결은 하지 않는다.
    this.unsubscribeClosed = options.transport.onClosed?.((message) => this.handleClosed(message));
  }

  start(): void {
    this.showList();
    if (this.closedMessage !== null) {
      // 이미 끝난 transport 로는 폴링도 탭도 시작하지 않는다 — 종료 안내만 남는다.
      this.listView.setNotice(this.closedMessage);
      return;
    }
    this.listSchedule.start();
    this.applyVisibility();
  }

  dispose(): void {
    this.closedMessage = "Disconnected";
    this.listSchedule.stop();
    this.tabView?.dispose();
    this.tabView = null;
    this.unsubscribeClosed?.();
    document.removeEventListener("visibilitychange", this.visibility);
  }

  /** 종료는 한 방향뿐이다 — 늦게 도착하는 응답이 이 상태를 되돌리지 못한다. */
  private handleClosed(message: string): void {
    this.closedMessage = message;
    this.listSchedule.stop();
    this.listView.setNotice(message);
  }

  private async pollState(): Promise<void> {
    try {
      const snapshot = await this.options.transport.fetchState();
      // 응답이 종료 직전에 해결됐어도 continuation 이 종료 뒤에 돌 수 있다 —
      // 그때는 화면도 안내도 건드리지 않는다 (재스캔 안내가 정답이다).
      if (this.closedMessage !== null) return;
      this.listView.render(snapshot);
      this.listView.setNotice(null);
    } catch (error) {
      if (this.closedMessage !== null) return;
      if (error instanceof TransportClosedError) {
        this.handleClosed(error.message);
        return;
      }
      if (error instanceof RemoteError) {
        this.listSchedule.noteStatus(error.status);
        if (error.status !== 401 && error.status !== 429) {
          this.listView.setNotice(`mast replied ${error.status}.`);
        }
        return;
      }
      this.listView.setNotice("Could not reach mast — retrying.");
    }
  }

  private showList(): void {
    this.tabView?.dispose();
    this.tabView = null;
    this.mount(this.listView.root);
    this.applyVisibility();
  }

  private openTab(tab: TabId, title: string): void {
    // 끝난 연결에서는 탭 화면을 만들지 않는다 — 그 화면의 첫 폴·입력이 전부
    // 실패할 뿐이고, 종료 안내가 이미 목록에 떠 있다.
    if (this.closedMessage !== null) return;
    this.tabView?.dispose();
    const view = new TabView({
      tab,
      title,
      onBack: () => this.showList(),
      transport: this.options.transport,
      fontPx: this.options.fontPx,
    });
    this.tabView = view;
    this.mount(view.root);
    view.start();
    this.applyVisibility();
  }

  /** 화면 교체. 연결 대상 표시가 있으면 화면 위에 남긴다 — 목록·탭 어느 쪽에서도
   *  보여야 "어디에 붙었나"가 화면마다 사라지지 않는다. */
  private mount(screen: HTMLElement): void {
    this.options.root.replaceChildren(...(this.destinationEl === null ? [screen] : [this.destinationEl, screen]));
  }

  private applyVisibility(): void {
    const shown = !document.hidden;
    this.listSchedule.setVisible(shown && this.tabView === null);
    this.tabView?.setVisible(shown);
  }
}

/** 연결 대상 표시 — 모델 문자와 무관한 고정 문자열이지만 다른 화면 요소와 같은
 *  규율로 `textContent` 로만 넣는다. */
function destinationBar(text: string): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "destination";
  bar.textContent = text;
  return bar;
}

/** 폰 브라우저는 키보드가 올라와도 문서의 레이아웃 높이를 줄이지 않고(iOS Safari 가
 *  특히 그렇다) "보이는 창"만 줄인다. 그러면 화면 아래에 붙은 입력칸이 키보드 밑으로
 *  들어가고, 위아래로 스크롤하면 사라졌다 나타났다 한다. `visualViewport` 가 그 보이는
 *  창의 높이와 위치를 주므로, 앱 상자를 그 크기로 잡고 스크롤은 상자 안(출력 영역)에서만
 *  일어나게 하면 입력칸이 늘 키보드 위에 붙어 있다. `interactive-widget=resizes-content`
 *  를 아는 브라우저(Android Chrome)는 레이아웃 자체를 줄여 주지만, 그때도 이 계산은
 *  같은 값을 내므로 해롭지 않다. */
export function fitToVisualViewport(root: HTMLElement): void {
  const viewport = window.visualViewport;
  if (viewport === null || viewport === undefined) return;
  const apply = (): void => {
    root.style.height = `${viewport.height}px`;
    root.style.transform = `translateY(${viewport.offsetTop}px)`;
  };
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  apply();
}
