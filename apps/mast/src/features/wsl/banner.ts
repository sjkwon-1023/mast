// WSL 안내 배너 — `#wsl-notice` 컨테이너에 상태 문구·원문 세부 정보·동작 버튼을
// 그린다. 문구·동작 목록은 순수 모델(`notice.ts`)이 정하고 여기는 DOM 만 만진다.
//
// 버튼 다섯 가지가 모두 상태에 따라 숨겨지므로 노드를 한 번 만들고 `hidden` 만
// 토글한다 (재조립 없음 — 배너는 상태 이벤트마다 다시 렌더된다).

import type { WslStatus } from "../../infrastructure/backend";
import { wslNotice } from "./notice";
import type { WslAction } from "./notice";

export interface WslBannerHandlers {
  /** 설치 명령 복사 — 성공 여부를 돌려주면 배너가 상태 라인 안내를 띄운다. */
  copy: (text: string) => Promise<boolean>;
  /** Microsoft WSL 설치 안내 열기. */
  guide: () => void;
  /** 명시적 재검사 — 백엔드가 밀린 부팅 작업까지 다시 적용한다. */
  recheck: () => Promise<void>;
  /** 앱 설정 파일 열기. */
  settings: () => void;
  /** 짧은 결과 안내 (복사 성공/실패 등) — 상태 라인 글루. */
  notice: (text: string) => void;
}

const ACTION_LABELS: Record<WslAction, string> = {
  copy: "Copy install command",
  guide: "Open install guide",
  recheck: "Recheck",
  settings: "Open settings.json",
};

export class WslBanner {
  private readonly rootEl: HTMLElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly bodyEl: HTMLSpanElement;
  private readonly detailEl: HTMLElement;
  private readonly commandEl: HTMLElement;
  private readonly buttons = new Map<WslAction, HTMLButtonElement>();
  /** 지금 배너가 안내하는 설치 명령 — 복사 버튼이 읽는다. */
  private command: string | null = null;

  constructor(rootEl: HTMLElement, private readonly handlers: WslBannerHandlers) {
    this.rootEl = rootEl;
    this.rootEl.classList.add("wsl-notice");

    const text = document.createElement("div");
    text.className = "wsl-notice-text";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "wsl-notice-title";
    this.bodyEl = document.createElement("span");
    this.bodyEl.className = "wsl-notice-body";
    this.detailEl = document.createElement("code");
    this.detailEl.className = "wsl-notice-detail";
    this.detailEl.hidden = true;
    this.commandEl = document.createElement("code");
    this.commandEl.className = "wsl-notice-command";
    this.commandEl.hidden = true;
    text.append(this.titleEl, this.bodyEl, this.detailEl, this.commandEl);

    const actions = document.createElement("div");
    actions.className = "wsl-notice-actions";
    for (const action of Object.keys(ACTION_LABELS) as WslAction[]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `wsl-notice-${action}`;
      button.textContent = ACTION_LABELS[action];
      button.hidden = true;
      this.wire(action, button);
      this.buttons.set(action, button);
      actions.append(button);
    }

    this.rootEl.append(text, actions);
  }

  private wire(action: WslAction, button: HTMLButtonElement): void {
    switch (action) {
      case "copy":
        button.addEventListener("click", () => {
          const command = this.command;
          if (command === null) return;
          void (async () => {
            const copied = await this.handlers.copy(command);
            this.handlers.notice(
              copied ? `Copied: ${command}` : "Could not copy to the clipboard",
            );
          })();
        });
        return;
      case "guide":
        button.addEventListener("click", () => this.handlers.guide());
        return;
      case "recheck":
        button.addEventListener("click", () => {
          button.disabled = true;
          void (async () => {
            try {
              await this.handlers.recheck();
            } finally {
              // 재검사 실패는 main.ts 글루가 상태 라인에 표시한다 — 여기서는
              // 버튼만 되돌려 다음 시도를 막지 않는다.
              button.disabled = false;
            }
          })();
        });
        return;
      case "settings":
        button.addEventListener("click", () => this.handlers.settings());
        return;
    }
  }

  /** 상태 반영 — 안내가 없으면(준비 완료·WSL 무관 호스트) 배너를 숨긴다. */
  render(status: WslStatus): void {
    const notice = wslNotice(status);
    if (notice === null) {
      this.rootEl.hidden = true;
      return;
    }
    this.titleEl.textContent = notice.title;
    this.bodyEl.textContent = notice.body;
    const detail = status.detail?.trim() ?? "";
    this.detailEl.textContent = detail;
    this.detailEl.hidden = detail === "";
    this.command = notice.installCommand;
    this.commandEl.textContent = notice.installCommand ?? "";
    this.commandEl.hidden = notice.installCommand === null;
    for (const [action, button] of this.buttons) {
      const shown = notice.actions.includes(action);
      button.hidden = !shown || (action === "copy" && notice.installCommand === null);
    }
    this.rootEl.hidden = false;
  }
}
