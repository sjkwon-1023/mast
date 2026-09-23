// macOS WebKit 한글 입력 상태기계 — DOM 무의존 순수 모듈.
//
// 이 Mac 의 WebKit(Tauri WKWebView, Safari 모두)은 한글 두벌식 입력에서 composition
// 이벤트를 보내지 않는다. 대신 키 하나마다 (a) 입력창이 먼저 바뀌고 — 새 음절의 첫 자모는
// `insertText`, 같은 음절의 갱신은 마지막 글자를 바꾸는 `insertReplacementText` — 그 뒤
// (b) keyCode 229 keydown, (c) 실제 keyCode 의 keyup 이 온다. xterm 5.5 는 `insertText` 를
// 받자마자 보내고 교체는 무시하므로 PTY 에는 음절마다 첫 자모만 갔다("한글" → "ㅎㄱ").
// ADR-0020 의 패치는 composition 이벤트 경로의 결함이라 이 경로와 무관하다.
//
// 그래서 확정을 입력창 내용 기준으로 다시 한다. `committed` 는 입력창에서 이미 처리된
// (우리가 보냈거나 xterm 이 처리한) 앞부분의 길이이고, 그 뒤가 아직 바뀔 수 있는 조합
// 중인 부분이다.
//
// - 229 keydown: 그 키의 입력창 변경이 이미 반영된 시점이다. 조합 중인 부분에서 마지막
//   한 글자만 남기고 나머지를 확정한다. 받침 이동("한"+ㅏ → "하"+"나")에서 교체와 삽입이
//   어느 순서로 오든 두 변경이 모두 끝난 뒤이므로 순서와 무관하다.
// - 수식키 단독이 아닌 비-229 keydown: xterm 이 그 키를 처리하기 전에 남은 전부를 확정한다
//   (조합 중 Enter 가 음절보다 먼저 가지 않게).
// - blur·붙여넣기·우클릭·탭 숨김·뷰 해제: 남은 전부를 확정한다.
//
// xterm 이나 브라우저가 입력창을 따로 건드리는 지점(Enter·Ctrl+C·blur·붙여넣기에서 비움,
// 우클릭에서 선택 텍스트로 교체, composition 경로)에서는 `committed` 를 믿을 수 없으므로
// stale 로 표시하고, 다음 IME 입력의 beforeinput 에서 커서 위치로 다시 맞춘다. 그 시점의
// 커서 앞은 전부 이미 처리된 내용이다.
//
// 키 없이 오는 입력 — 문자 뷰어의 이모지·기호, 받아쓰기, 한자 후보의 마우스 선택은 keydown
// 없이 insertText(또는 조합 중 음절의 교체)만 온다. 이것을 조합 중으로 잡아 두면 다음 키나
// blur 까지 PTY 에 가지 않는다(xterm 원래 동작은 즉시 전송). 그래서:
// - 데이터가 한글 자모·음절 한 글자가 아니면(이모지, 한자, 기호, 여러 글자) 두벌식 조합의
//   일부일 수 없으므로 남은 조합과 함께 즉시 확정한다.
// - 한글 한 글자면 정상 타이핑(입력창 변경 → keydown 229)과 구별할 수 없으므로 `awaitingKey`
//   로 표시만 한다. 뒤이은 keydown 이 짧은 시간 안에 오지 않으면 어댑터의 타이머가 flush 한다.
//
// 비-229 keydown 뒤에 그 키가 만든 입력(예: Space 의 " ")은 xterm 몫이다 — xterm 은
// keydown 에서 이미 보냈고 이어지는 input 은 스스로 중복 억제한다. 키 이벤트를 겹쳐
// 누르는 경우(Space 를 떼기 전에 다음 자모)에도 가르기 위해, 그 키의 `key` 와 데이터가
// 같은 `insertText` 한 건만 xterm 몫으로 본다.

/** 판정이 읽는 입력창 상태. DOM 의 textarea 가 그대로 맞는다. */
export interface ImeField {
  readonly value: string;
  readonly selectionStart: number;
}

/** 판정이 읽는 keydown/keyup 필드. */
export interface ImeKey {
  readonly keyCode: number;
  readonly key: string;
}

/** 이벤트를 xterm 에 넘길지(`pass`) 여기서 막을지(`block`). */
export type ImeRouting = "pass" | "block";

// IME 가 삼킨 키는 keyCode 229 로 온다.
const IME_KEY_CODE = 229;

// 단독으로 눌린 수식키는 조합을 끊지 않는다 (xterm CompositionHelper 와 같은 판단).
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS"]);
const MODIFIER_KEY_CODES = new Set([16, 17, 18, 91, 92, 93, 224]);

function isModifierOnly(key: ImeKey): boolean {
  return MODIFIER_KEYS.has(key.key) || MODIFIER_KEY_CODES.has(key.keyCode);
}

// 두벌식 조합이 입력창에 쓰는 한 글자: 한글 자모(U+1100–11FF), 호환 자모(U+3130–318F),
// 자모 확장 A(U+A960–A97F), 음절·자모 확장 B(U+AC00–D7FF).
const HANGUL_CHAR = /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff]$/;

/** 두벌식 조합의 일부일 수 있는 입력인가. 빈 교체(조합 중 Backspace)도 조합의 일부다. */
function isHangulComposition(data: string | null): boolean {
  return data === null || data === "" || HANGUL_CHAR.test(data);
}

/** 마지막 코드 포인트의 시작 위치. 서로게이트 쌍을 가르지 않는다. */
function lastCharStart(text: string): number {
  const last = text.length - 1;
  if (last <= 0) return 0;
  const low = text.charCodeAt(last);
  const high = text.charCodeAt(last - 1);
  const isPair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return isPair ? last - 1 : last;
}

export class WebKitImeState {
  // 입력창에서 이미 처리된 앞부분의 길이.
  private committed = 0;
  // committed 를 믿을 수 없다. 처음에는 입력창 내용을 모르므로 stale 로 시작한다.
  private stale = true;
  // composition 이벤트를 쓰는 IME(일본어·중국어, dead key)는 xterm 의 기존 경로 몫이다.
  private composing = false;
  // 직전 비-229 keydown 의 key. 그 키가 만든 입력 한 건을 xterm 몫으로 가른다.
  private ownedKey: string | null = null;
  // 마지막 IME 입력 뒤로 keydown 이 아직 오지 않았다 (키 없이 온 입력일 수 있다).
  private keyless = false;

  constructor(private readonly send: (data: string) => void) {}

  /** 조합 중인 한글 한 글자가 keydown 없이 들어온 뒤 아직 키가 오지 않았다. 어댑터는 짧은
   *  시간 뒤에도 그대로면 flush 한다 (파일 머리 주석). */
  get awaitingKey(): boolean {
    return this.keyless;
  }

  /** 아직 확정되지 않은 조합 중 텍스트 (미리보기용). */
  pendingText(field: ImeField): string {
    if (this.composing || this.stale) return "";
    return field.value.slice(Math.min(this.committed, field.value.length));
  }

  /** xterm 보다 먼저 keydown 을 본다. `block` 이면 xterm 에 넘기지 않는다. */
  keydown(key: ImeKey, field: ImeField): ImeRouting {
    this.keyless = false;
    if (this.composing) return "pass";

    if (key.keyCode === IME_KEY_CODE) {
      this.ownedKey = null;
      // stale 이 풀리지 않았다면 이 키 이전에 IME 입력이 없었다 — 조합 중인 것이 없다.
      if (this.stale) this.resyncTo(field.value.length);
      this.clampTo(field.value.length);
      const composingPart = field.value.slice(this.committed);
      const keep = lastCharStart(composingPart);
      if (keep > 0) this.commit(composingPart.slice(0, keep));
      // xterm 의 229 처리(_handleAnyTextareaChanges)는 지연 타이머로 입력창 diff 를 다시
      // 보내므로, 메인 스레드가 바쁘면 여기서 보낸 음절이 두 번 간다. IME 가 삼킨 키는 이
      // 어댑터가 전부 맡는다.
      return "block";
    }

    if (isModifierOnly(key)) return "pass";

    this.flush(field);
    this.ownedKey = key.key;
    return "pass";
  }

  keyup(): void {
    this.ownedKey = null;
  }

  /** 입력창이 바뀌기 직전. stale 이면 지금 커서 앞을 처리된 것으로 맞춘다. */
  beforeInput(inputType: string, data: string | null, field: ImeField): void {
    if (this.composing || this.isOwned(inputType, data)) return;
    if (this.stale) this.resyncTo(field.selectionStart);
  }

  /** 입력창이 바뀐 직후. `block` 이면 xterm 의 input 처리에 닿지 않게 막는다. */
  input(inputType: string, data: string | null, field: ImeField): ImeRouting {
    if (this.composing || inputType.startsWith("insertComposition")) return "pass";

    if (this.isOwned(inputType, data)) {
      this.ownedKey = null;
      this.resyncTo(field.value.length);
      return "pass";
    }

    const isInsert = inputType === "insertText" || inputType === "insertReplacementText";
    if (!isInsert && !inputType.startsWith("delete")) {
      // 줄바꿈·드롭·되돌리기 등 IME 가 아닌 변경. xterm 도 다루지 않는다.
      this.stale = true;
      return "pass";
    }

    const length = field.value.length;
    if (this.stale) {
      // beforeinput 을 못 봤다. 새로 들어온 글자만 조합 중으로 본다 — 교체·삭제는 stale
      // 이전에 이미 보낸 글자를 고친 것이므로 다시 보내지 않는다.
      const inserted = inputType === "insertText" && data !== null ? data.length : 0;
      this.resyncTo(Math.max(0, length - inserted));
    }
    this.clampTo(length);
    if (!isInsert) return "pass";
    if (isHangulComposition(data)) {
      this.keyless = true;
    } else {
      // 두벌식 조합일 수 없는 입력 — 남은 조합과 함께 지금 확정한다. 입력창 상태는 알고
      // 있으므로 stale 로 만들지 않는다.
      const rest = field.value.slice(this.committed);
      if (rest.length > 0) this.commit(rest);
      this.keyless = false;
    }
    return "block";
  }

  compositionStart(field: ImeField): void {
    this.flush(field);
    this.composing = true;
  }

  compositionEnd(): void {
    // xterm 의 CompositionHelper 가 입력창 내용을 보냈다. 다음 IME 입력에서 다시 맞춘다.
    this.composing = false;
    this.stale = true;
  }

  /** 남은 조합을 전부 확정한다 (blur·붙여넣기·우클릭·숨김·해제, 비-229 keydown). */
  flush(field: ImeField): void {
    this.ownedKey = null;
    this.keyless = false;
    if (this.composing) return;
    if (!this.stale) {
      this.clampTo(field.value.length);
      const rest = field.value.slice(this.committed);
      if (rest.length > 0) this.commit(rest);
    }
    // 호출한 쪽(xterm 의 Enter·blur·붙여넣기 처리)이 곧 입력창을 비울 수 있다.
    this.committed = field.value.length;
    this.stale = true;
  }

  private isOwned(inputType: string, data: string | null): boolean {
    return this.ownedKey !== null && inputType === "insertText" && data === this.ownedKey;
  }

  private commit(text: string): void {
    this.committed += text.length;
    this.send(text);
  }

  private resyncTo(offset: number): void {
    this.committed = offset;
    this.stale = false;
  }

  // 입력창이 committed 보다 짧아졌다면(IME 가 지웠다) 남은 길이에 맞춘다.
  private clampTo(length: number): void {
    if (this.committed > length) this.committed = length;
  }
}
