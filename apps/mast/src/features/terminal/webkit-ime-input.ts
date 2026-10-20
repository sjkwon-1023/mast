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
// Windows(WebView2)는 composition 이벤트를 보내므로 windows-ime-input.ts 가 맡는다 (view.ts).

import type { Terminal } from "@xterm/xterm";
import { CompositionPreview } from "./composition-preview";
import { WebKitImeState } from "./webkit-ime";

type Listener = (ev: Event) => void;

// keydown 없이 온 한글 한 글자를 확정하기까지 기다리는 시간. 정상 타이핑의 keydown 229 는 같은
// 네이티브 키 처리에서 입력창 변경 바로 뒤에 온다. 0(다음 task)으로 두지 않는 이유: 입력창
// 변경과 keydown 이 같은 task 안에서 온다는 보장을 확인하지 못했다 — 둘 사이에 타이머가 끼면
// 조합 중인 자모를 확정해 음절이 깨지므로 여유를 둔다. 받아쓰기·문자 뷰어의 한 글자가 이만큼
// 늦는 것은 눈에 띄지 않는다.
const KEYLESS_COMMIT_MS = 50;

export class WebKitImeInput {
  private readonly state: WebKitImeState;
  private readonly element: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly preview: CompositionPreview;
  private readonly listeners: Array<[string, Listener]>;
  private keylessTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.state = new WebKitImeState((data) => term.input(data, true));
    this.preview = new CompositionPreview(term, textarea, screen);

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
    this.cancelKeylessCommit();
    this.disposed = true;
    for (const [type, fn] of this.listeners) {
      this.element.removeEventListener(type, fn, { capture: true });
    }
    this.preview.dispose();
  }

  private readonly onKeyDown: Listener = (ev) => {
    if (ev.target !== this.textarea) return;
    this.cancelKeylessCommit();
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
    if (this.state.awaitingKey) this.scheduleKeylessCommit();
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

  // 키 없이 온 한글 한 글자(webkit-ime.ts 머리 주석): 뒤이은 keydown 이 오지 않으면 확정한다.
  private scheduleKeylessCommit(): void {
    this.cancelKeylessCommit();
    this.keylessTimer = setTimeout(() => {
      this.keylessTimer = null;
      if (this.state.awaitingKey) this.flush();
    }, KEYLESS_COMMIT_MS);
  }

  private cancelKeylessCommit(): void {
    if (this.keylessTimer === null) return;
    clearTimeout(this.keylessTimer);
    this.keylessTimer = null;
  }

  private updatePreview(): void {
    this.preview.show(this.state.pendingText(this.textarea));
  }
}
