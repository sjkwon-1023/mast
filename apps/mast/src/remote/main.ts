// 토큰은 페어링 URL 의 **fragment**(`#t=…`)로 들어온다. fragment 는 요청에
// 실리지 않으므로 서버 로그·프록시에 남지 않고, 우리는 그것을 localStorage 로
// 옮긴 뒤 `history.replaceState` 로 주소창에서 지운다 — 지우지 않으면 화면 공유나
// 스크린샷 한 장으로 토큰이 새고, 새로고침·뒤로가기마다 다시 붙는다.

import "./remote.css";

import { fetchState, HttpError, loadToken, saveToken } from "./api";
import { ListView } from "./list-view";
import { PollSchedule } from "./poller";
import { TabView } from "./tab-view";
import type { TabId } from "../shared/types";

const STATE_POLL_INTERVAL_MS = 2000;

function claimTokenFromFragment(): void {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) return;
  const token = new URLSearchParams(hash.slice(1)).get("t");
  if (token === null || token === "") return;
  saveToken(token);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

class RemoteApp {
  private readonly listView: ListView;
  private readonly listSchedule: PollSchedule;
  private tabView: TabView | null = null;

  constructor(private readonly root: HTMLElement) {
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
    document.addEventListener("visibilitychange", () => this.applyVisibility());
  }

  start(): void {
    this.showList();
    this.listSchedule.start();
    this.applyVisibility();
  }

  private async pollState(): Promise<void> {
    try {
      this.listView.render(await fetchState());
      this.listView.setNotice(null);
    } catch (error) {
      if (error instanceof HttpError) {
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
    this.root.replaceChildren(this.listView.root);
    this.applyVisibility();
  }

  private openTab(tab: TabId, title: string): void {
    this.tabView?.dispose();
    const view = new TabView({ tab, title, onBack: () => this.showList() });
    this.tabView = view;
    this.root.replaceChildren(view.root);
    view.start();
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const shown = !document.hidden;
    this.listSchedule.setVisible(shown && this.tabView === null);
    this.tabView?.setVisible(shown);
  }
}

function showPairingHint(root: HTMLElement): void {
  const hint = document.createElement("div");
  hint.className = "hint";
  const line = document.createElement("p");
  line.textContent = "Scan the pairing QR in mast";
  const detail = document.createElement("p");
  detail.className = "hint-detail";
  detail.textContent = "Open the sidebar and press “Pair phone” on the desktop app.";
  hint.append(line, detail);
  root.replaceChildren(hint);
}

/** 폰 브라우저는 키보드가 올라와도 문서의 레이아웃 높이를 줄이지 않고(iOS Safari 가
 *  특히 그렇다) "보이는 창"만 줄인다. 그러면 화면 아래에 붙은 입력칸이 키보드 밑으로
 *  들어가고, 위아래로 스크롤하면 사라졌다 나타났다 한다. `visualViewport` 가 그 보이는
 *  창의 높이와 위치를 주므로, 앱 상자를 그 크기로 잡고 스크롤은 상자 안(출력 영역)에서만
 *  일어나게 하면 입력칸이 늘 키보드 위에 붙어 있다. `interactive-widget=resizes-content`
 *  를 아는 브라우저(Android Chrome)는 레이아웃 자체를 줄여 주지만, 그때도 이 계산은
 *  같은 값을 내므로 해롭지 않다. */
function fitToVisualViewport(root: HTMLElement): void {
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

const root = document.getElementById("app");
if (root !== null) {
  fitToVisualViewport(root);
  claimTokenFromFragment();
  if (loadToken() === null) showPairingHint(root);
  else new RemoteApp(root).start();
}
