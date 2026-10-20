// Windows(WebView2) 한글 입력 상태기계 — DOM 무의존 순수 모듈 (ADR-0020 amendment 2026-10-21).
//
// WebView2 는 Microsoft IME 의 조합을 composition 이벤트로 보낸다. xterm 6.0 의
// CompositionHelper 는 확정 글자를 `compositionend.data` 가 아니라 zero-delay 태스크 뒤의
// textarea 값 구간(`value.substring(start, 다음 조합 start)`)에서 읽는다. 2026-10-21 현장
// 로그에서 그 구간이 IME 가 보고한 확정 글자와 길이는 같고 내용이 다른 채로 연달아 나갔다
// (`match=false`, '조작해도' → '자작'). Windows TSF 가 textarea 내용을 바꿔 쓰는 업스트림
// #6049 계열로 본다. textarea 를 읽는 한 같은 결함을 그대로 받으므로, 여기서는 IME 가 보고한
// `compositionend.data` 를 그대로 보낸다. macOS `webkit-ime.ts` 와 달리 textarea 를 읽지 않는다.
//
// - 229 keydown: xterm 에 넘기지 않는다. xterm 은 조합 이벤트를 못 보므로 조합 밖으로 알고
//   229 마다 textarea 차이를 따로 보낸다(`_handleAnyTextareaChanges`).
// - 조합 중의 비-229 keydown(수식키·CapsLock 단독 제외): xterm 이 그 키를 보내기 전에 마지막
//   update 를 먼저 보낸다. 뒤따르는 그 조합의 end 는 다시 보내지 않는다(업스트림 #5778 의
//   이중 전송을 피한다). 제외 목록은 xterm CompositionHelper.keydown 과 같다.
// - blur·붙여넣기·탭 숨김·뷰 해제: 위와 같이 남은 조합을 먼저 보낸다.
// - 조합이 겹치거나(end 없이 새 start) 조합 밖에서 end 가 와도 end 의 data 는 IME 의 확정
//   보고이므로 보낸다 (2026-10-19 로그의 겹친 조합).

/** 판정이 읽는 keydown 필드. */
export interface ImeKey {
  readonly keyCode: number;
}

/** 이벤트를 xterm 에 넘길지(`pass`) 여기서 막을지(`block`). */
export type ImeRouting = "pass" | "block";

const IME_KEY_CODE = 229;

// Shift·Control·Alt·CapsLock 단독은 조합을 끊지 않는다.
const NON_BREAKING_KEY_CODES = new Set([16, 17, 18, 20]);

export class WindowsImeState {
  private composing = false;
  // 마지막 compositionupdate 의 data. 조합을 먼저 끊어 보낼 때만 쓴다.
  private pending = "";
  // 열린 조합을 이미 보냈다 — 그 조합의 end 는 다시 보내지 않는다.
  private sentEarly = false;

  constructor(private readonly send: (data: string) => void) {}

  /** 아직 확정되지 않은 조합 중 텍스트 (미리보기용). */
  pendingText(): string {
    return this.composing && !this.sentEarly ? this.pending : "";
  }

  keydown(key: ImeKey): ImeRouting {
    if (key.keyCode === IME_KEY_CODE) return "block";
    if (!NON_BREAKING_KEY_CODES.has(key.keyCode)) this.flush();
    return "pass";
  }

  compositionStart(): void {
    this.composing = true;
    this.pending = "";
    this.sentEarly = false;
  }

  compositionUpdate(data: string): void {
    if (this.composing) this.pending = data;
  }

  compositionEnd(data: string): void {
    if (!this.sentEarly && data.length > 0) this.send(data);
    this.composing = false;
    this.pending = "";
    this.sentEarly = false;
  }

  /** 열린 조합을 지금 보낸다 (비-229 keydown, blur·붙여넣기·숨김·해제). */
  flush(): void {
    if (!this.composing || this.sentEarly) return;
    if (this.pending.length > 0) this.send(this.pending);
    this.sentEarly = true;
  }
}
