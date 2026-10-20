// 한글 입력 어댑터가 쓰는 조합 미리보기. 두 어댑터(webkit-ime-input.ts, windows-ime-input.ts)가
// xterm 의 composition 경로를 막으므로 xterm 자신의 조합 뷰는 켜지지 않는다 — 아직 확정되지
// 않은 글자를 커서 위치에 대신 보여 준다. xterm 의 조합 뷰 스타일을 그대로 쓴다.

import type { IDisposable, Terminal } from "@xterm/xterm";

export class CompositionPreview {
  private readonly view: HTMLDivElement;
  private readonly renderSub: IDisposable;

  constructor(
    private readonly term: Terminal,
    textarea: HTMLTextAreaElement,
    private readonly screen: HTMLElement,
  ) {
    this.view = document.createElement("div");
    this.view.className = "composition-view";
    (textarea.parentElement ?? screen).appendChild(this.view);

    // 출력으로 커서가 움직이면 미리보기도 따라간다.
    this.renderSub = term.onRender(() => {
      if (this.view.textContent !== "") this.place();
    });
  }

  /** 빈 문자열이면 숨긴다. */
  show(text: string): void {
    if (text === "") {
      this.view.textContent = "";
      this.view.classList.remove("active");
      return;
    }
    this.view.textContent = text;
    this.place();
  }

  dispose(): void {
    this.renderSub.dispose();
    this.view.remove();
  }

  // 공개 API 만으로 커서 셀을 계산한다: 버퍼의 커서 좌표와, 렌더러가 cols×셀 크기로 맞춰
  // 두는 화면 요소의 크기.
  private place(): void {
    const buffer = this.term.buffer.active;
    const row = buffer.cursorY + buffer.baseY - buffer.viewportY;
    if (row < 0 || row >= this.term.rows) {
      this.view.classList.remove("active");
      return;
    }
    const cellWidth = this.screen.clientWidth / this.term.cols;
    const cellHeight = this.screen.clientHeight / this.term.rows;
    const column = Math.min(buffer.cursorX, this.term.cols - 1);
    const style = this.view.style;
    style.left = `${column * cellWidth}px`;
    style.top = `${row * cellHeight}px`;
    style.height = `${cellHeight}px`;
    style.lineHeight = `${cellHeight}px`;
    style.fontFamily = `${this.term.options.fontFamily}`;
    style.fontSize = `${this.term.options.fontSize}px`;
    this.view.classList.add("active");
  }
}
