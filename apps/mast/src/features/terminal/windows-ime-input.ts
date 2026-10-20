// Windows 한글 입력 배선 — windows-ime.ts 상태기계를 xterm 터미널에 붙인다.
//
// 리스너는 webkit-ime-input.ts 와 같이 `term.element` 에 capture 로 단다. xterm 의 키·조합
// 리스너는 textarea 자신에 달려 있으므로 조상의 capture 리스너가 먼저 돌고, 여기서
// `stopPropagation` 하면 xterm 의 CompositionHelper 에 닿지 않는다. 입력창 값은 네이티브로
// 바뀌게 둔다(`preventDefault` 금지): TSF 가 입력창 내용 기준으로 조합 범위를 계산한다.
//
// 옵트인 확정 비교 진단(logging.ts `installImeCommitDiagnostics`)도 같은 element 의 capture
// 리스너라 이 배선보다 먼저 등록돼야 이벤트를 본다 (view.ts 의 설치 순서).
//
// 확정 전송은 `term.input(data, true)` 로 한다. onData 경로를 그대로 타므로 뷰의 replay
// 게이트·쓰기 큐·scrollOnUserInput 이 xterm 자신의 입력과 똑같이 적용된다.

import type { Terminal } from "@xterm/xterm";
import { CompositionPreview } from "./composition-preview";
import { WindowsImeState } from "./windows-ime";

type Listener = (ev: Event) => void;

export class WindowsImeInput {
  private readonly state: WindowsImeState;
  private readonly element: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly preview: CompositionPreview;
  private readonly listeners: Array<[string, Listener]>;
  private disposed = false;

  constructor(private readonly term: Terminal) {
    const element = term.element;
    const textarea = term.textarea;
    const screen = element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
    if (!element || !textarea || !screen) {
      throw new Error("WindowsImeInput requires an opened xterm terminal");
    }
    this.element = element;
    this.textarea = textarea;
    this.state = new WindowsImeState((data) => term.input(data, true));
    this.preview = new CompositionPreview(term, textarea, screen);

    this.listeners = [
      ["keydown", this.onKeyDown],
      ["compositionstart", this.onCompositionStart],
      ["compositionupdate", this.onCompositionUpdate],
      ["compositionend", this.onCompositionEnd],
      ["blur", this.onFlushEvent],
      ["paste", this.onFlushEvent],
    ];
    for (const [type, fn] of this.listeners) {
      element.addEventListener(type, fn, { capture: true });
    }
  }

  /** 남은 조합을 보낸다 — 탭 숨김·붙여넣기처럼 입력창 밖에서 오는 경계. */
  flush(): void {
    if (this.disposed) return;
    this.state.flush();
    this.updatePreview();
  }

  /** 남은 조합을 보내고 떼어 낸다. 뷰의 onData 구독을 끊기 전에 불러야 전송된다. */
  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    for (const [type, fn] of this.listeners) {
      this.element.removeEventListener(type, fn, { capture: true });
    }
    this.preview.dispose();
  }

  private readonly onKeyDown: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    if (this.state.keydown(ev as KeyboardEvent) === "block") {
      ev.stopPropagation();
      // xterm 이 229 keydown 에서 하던 입력 시 하단 스크롤을 대신한다.
      const buffer = this.term.buffer.active;
      if (this.term.options.scrollOnUserInput !== false && buffer.viewportY !== buffer.baseY) {
        this.term.scrollToBottom();
      }
    }
    this.updatePreview();
  };

  private readonly onCompositionStart: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    ev.stopPropagation();
    this.state.compositionStart();
    this.updatePreview();
  };

  private readonly onCompositionUpdate: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    ev.stopPropagation();
    this.state.compositionUpdate((ev as CompositionEvent).data ?? "");
    this.updatePreview();
  };

  private readonly onCompositionEnd: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    ev.stopPropagation();
    this.state.compositionEnd((ev as CompositionEvent).data ?? "");
    this.updatePreview();
  };

  // blur 는 xterm 이 입력창을 비우기 전에, paste 는 xterm 이 붙여넣은 텍스트를 보내기 전에 돈다.
  private readonly onFlushEvent: Listener = () => {
    this.flush();
  };

  private updatePreview(): void {
    this.preview.show(this.state.pendingText());
  }
}
