// macOS WebKit 한글 입력 배선 — webkit-ime.ts 상태기계를 xterm 터미널에 붙인다.
//
// 리스너는 전부 `term.element` 에 capture 로 단다. xterm 의 키·입력 리스너는 textarea
// 자신에 달려 있으므로 조상의 capture 리스너가 항상 먼저 돈다 — 그래서 여기서
// `stopPropagation` 하면 xterm 의 input 처리(insertText 즉시 전송)와 229 keydown 처리에
// 닿지 않는다. 입력창 값 자체는 네이티브로 바뀌게 둔다(`preventDefault` 금지): IME 가 다음
// 교체 범위를 입력창 내용 기준으로 계산한다.
//
// 확정 전송은 `term.input(data, true)` 로 한다. onData 경로를 그대로 타므로 뷰의 replay
// 게이트·쓰기 큐·scrollOnUserInput 이 xterm 자신의 입력과 똑같이 적용된다.
//
// Windows(WebView2)는 composition 이벤트를 보내므로 이 배선을 설치하지 않는다 (view.ts).

import type { IDisposable, Terminal } from "@xterm/xterm";
import { WebKitImeState } from "./webkit-ime";

type Listener = (ev: Event) => void;

export class WebKitImeInput {
  private readonly state: WebKitImeState;
  private readonly element: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly screen: HTMLElement;
  // 아직 확정되지 않은 글자를 커서 위치에 보여 준다. xterm 의 조합 뷰 스타일을 그대로 쓴다.
  private readonly preview: HTMLDivElement;
  private readonly listeners: Array<[string, Listener]>;
  private readonly renderSub: IDisposable;
  private disposed = false;

  constructor(private readonly term: Terminal) {
    const element = term.element;
    const textarea = term.textarea;
    const screen = element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
    if (!element || !textarea || !screen) {
      throw new Error("WebKitImeInput requires an opened xterm terminal");
    }
    this.element = element;
    this.textarea = textarea;
    this.screen = screen;
    this.state = new WebKitImeState((data) => term.input(data, true));

    this.preview = document.createElement("div");
    this.preview.className = "composition-view";
    (textarea.parentElement ?? screen).appendChild(this.preview);

    this.listeners = [
      ["keydown", this.onKeyDown],
      ["keyup", this.onKeyUp],
      ["beforeinput", this.onBeforeInput],
      ["input", this.onInput],
      ["compositionstart", this.onCompositionStart],
      ["compositionend", this.onCompositionEnd],
      ["blur", this.onBlur],
      // 붙여넣기와 우클릭은 xterm 이 입력창을 비우거나 선택 텍스트로 바꾼다.
      ["paste", this.onFlushEvent],
      ["contextmenu", this.onFlushEvent],
    ];
    for (const [type, fn] of this.listeners) {
      element.addEventListener(type, fn, { capture: true });
    }

    // 출력으로 커서가 움직이면 미리보기도 따라간다.
    this.renderSub = term.onRender(() => {
      if (this.preview.textContent !== "") this.placePreview();
    });
  }

  /** 남은 조합을 전부 확정한다 — 탭 숨김·붙여넣기·submit 처럼 입력창 밖에서 오는 경계. */
  flush(): void {
    if (this.disposed) return;
    this.state.flush(this.textarea);
    this.updatePreview();
  }

  /** 남은 조합을 확정하고 떼어 낸다. 뷰의 onData 구독을 끊기 전에 불러야 전송된다. */
  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    for (const [type, fn] of this.listeners) {
      this.element.removeEventListener(type, fn, { capture: true });
    }
    this.renderSub.dispose();
    this.preview.remove();
  }

  private readonly onKeyDown: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    const key = ev as KeyboardEvent;
    if (this.state.keydown(key, this.textarea) === "block") {
      ev.stopPropagation();
      // xterm 이 229 keydown 에서 하던 입력 시 하단 스크롤을 대신한다.
      const buffer = this.term.buffer.active;
      if (this.term.options.scrollOnUserInput !== false && buffer.viewportY !== buffer.baseY) {
        this.term.scrollToBottom();
      }
    }
    this.updatePreview();
  };

  private readonly onKeyUp: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    this.state.keyup();
  };

  private readonly onBeforeInput: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    const input = ev as InputEvent;
    this.state.beforeInput(input.inputType, input.data, this.textarea);
  };

  private readonly onInput: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    const input = ev as InputEvent;
    if (this.state.input(input.inputType, input.data, this.textarea) === "block") {
      ev.stopPropagation();
    }
    this.updatePreview();
  };

  private readonly onCompositionStart: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    this.state.compositionStart(this.textarea);
    this.updatePreview();
  };

  private readonly onCompositionEnd: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    this.state.compositionEnd();
  };

  // xterm 의 blur 처리가 입력창을 비우기 전에 돈다 (조상 capture).
  private readonly onBlur: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    this.flush();
  };

  private readonly onFlushEvent: Listener = () => {
    this.flush();
  };

  private updatePreview(): void {
    const text = this.state.pendingText(this.textarea);
    if (text === "") {
      this.preview.textContent = "";
      this.preview.classList.remove("active");
      return;
    }
    this.preview.textContent = text;
    this.placePreview();
  }

  // 공개 API 만으로 커서 셀을 계산한다: 버퍼의 커서 좌표와, 렌더러가 cols×셀 크기로 맞춰
  // 두는 화면 요소의 크기.
  private placePreview(): void {
    const buffer = this.term.buffer.active;
    const row = buffer.cursorY + buffer.baseY - buffer.viewportY;
    if (row < 0 || row >= this.term.rows) {
      this.preview.classList.remove("active");
      return;
    }
    const cellWidth = this.screen.clientWidth / this.term.cols;
    const cellHeight = this.screen.clientHeight / this.term.rows;
    const column = Math.min(buffer.cursorX, this.term.cols - 1);
    const style = this.preview.style;
    style.left = `${column * cellWidth}px`;
    style.top = `${row * cellHeight}px`;
    style.height = `${cellHeight}px`;
    style.lineHeight = `${cellHeight}px`;
    style.fontFamily = `${this.term.options.fontFamily}`;
    style.fontSize = `${this.term.options.fontSize}px`;
    this.preview.classList.add("active");
  }
}
