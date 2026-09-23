// macOS WebKit 한글 입력 상태기계 — 이벤트 열을 넣고 PTY 로 나간 문자열을 본다.
//
// 이벤트 순서는 이 Mac 의 WebKit(Tauri WKWebView, Safari)에서 실측한 모양이다:
// IME 가 삼킨 키는 (a) 입력창 변경(beforeinput → 값 변경 → input) → (b) keydown 229 →
// (c) keyup. 조합 외 키(Space, Enter, Backspace 등)는 keydown 이 먼저 오고 xterm 이
// keydown 경로로 보낸다. composition 이벤트는 오지 않는다.
//
// 하네스는 xterm 을 흉내 낸다: 어댑터가 넘긴(`pass`) 비-229 keydown 은 xterm 이 그 키를
// 보내고 기본 동작을 막는다(Space 의 " " 가 입력창에 들어가지 않는다). Enter 는 xterm 처럼
// 입력창을 비운다. 실제 xterm 번들과의 결합은 webkit-ime-dom.test.ts 가 본다.

import { describe, expect, it } from "vitest";

import { WebKitImeState } from "./webkit-ime";

/** 입력창 한 번의 변경. `back` 은 교체할 글자의 뒤에서부터의 위치(1 = 마지막 글자). */
type Change =
  | { kind: "insert"; data: string }
  | { kind: "replace"; data: string; back?: number }
  | { kind: "delete" };

const ins = (data: string): Change => ({ kind: "insert", data });
const rep = (data: string, back = 1): Change => ({ kind: "replace", data, back });
const del = (): Change => ({ kind: "delete" });

/** 조합 외 키: xterm 이 keydown 에서 보내는 바이트. */
const PLAIN_KEYS: Record<string, { keyCode: number; sends: string }> = {
  " ": { keyCode: 32, sends: " " },
  Enter: { keyCode: 13, sends: "\r" },
  Backspace: { keyCode: 8, sends: "\x7f" },
};

class Harness {
  private value = "";
  /** PTY 로 나간 순서 그대로 (어댑터 + xterm). */
  readonly pty: string[] = [];
  /** 어댑터가 보낸 것만. */
  readonly fromAdapter: string[] = [];
  readonly ime = new WebKitImeState((data) => {
    this.fromAdapter.push(data);
    this.pty.push(data);
  });

  get field(): { value: string; selectionStart: number } {
    return { value: this.value, selectionStart: this.value.length };
  }

  get sent(): string {
    return this.pty.join("");
  }

  get preview(): string {
    return this.ime.pendingText(this.field);
  }

  /** IME 발 입력창 변경 한 건: beforeinput → 값 변경 → input. */
  change(c: Change): void {
    const routed = this.applyInput(c);
    // xterm 은 insertText 를 받으면 즉시 보낸다 — 어댑터가 막아야 한다.
    if (routed === "pass" && c.kind === "insert") {
      throw new Error(`IME input reached xterm: ${c.data}`);
    }
  }

  /** 입력창 변경 한 건을 적용하고 어댑터의 판정(xterm 에 넘길지)을 돌려준다. */
  applyInput(c: Change): "pass" | "block" {
    const inputType =
      c.kind === "insert"
        ? "insertText"
        : c.kind === "replace"
          ? "insertReplacementText"
          : "deleteContentBackward";
    const data = c.kind === "delete" ? null : c.data;
    this.ime.beforeInput(inputType, data, this.field);
    if (c.kind === "insert") {
      this.value += c.data;
    } else if (c.kind === "replace") {
      const at = this.value.length - (c.back ?? 1);
      this.value = this.value.slice(0, at) + c.data + this.value.slice(at + 1);
    } else {
      this.value = this.value.slice(0, -1);
    }
    return this.ime.input(inputType, data, this.field);
  }

  /** IME 가 삼킨 키 하나: 입력창 변경들 → keydown 229 → keyup. */
  imeKey(...changes: Change[]): void {
    for (const c of changes) this.change(c);
    const routed = this.ime.keydown({ keyCode: 229, key: "Process" }, this.field);
    expect(routed).toBe("block");
    this.ime.keyup();
  }

  /** 조합 외 키의 keydown. xterm 이 보내고 기본 동작을 막는다. */
  plainKeyDown(key: string): void {
    const spec = PLAIN_KEYS[key] ?? { keyCode: key.toUpperCase().charCodeAt(0), sends: key };
    const routed = this.ime.keydown({ keyCode: spec.keyCode, key }, this.field);
    expect(routed).toBe("pass");
    this.pty.push(spec.sends);
    if (key === "Enter") this.value = "";
  }

  plainKey(key: string): void {
    this.plainKeyDown(key);
    this.ime.keyup();
  }

  type(keys: Array<Change[] | string>): void {
    for (const k of keys) {
      if (typeof k === "string") this.plainKey(k);
      else this.imeKey(...k);
    }
  }

  blur(): void {
    this.ime.flush(this.field);
    // xterm 의 blur 처리가 입력창을 비운다.
    this.value = "";
  }
}

/** 받침 이동 한 키: 앞 음절의 교체와 새 음절의 삽입. 순서는 관측되지 않았다. */
type MoveOrder = "replace-first" | "insert-first";
function moveFinal(order: MoveOrder, previous: string, next: string): Change[] {
  return order === "replace-first"
    ? [rep(previous), ins(next)]
    : [ins(next), rep(previous, 2)];
}

/** 두벌식 "한글 입력 테스트" — 테스트 의 ㅅ·ㅌ 받침 이동 포함. */
function sentence(order: MoveOrder): Array<Change[] | string> {
  return [
    [ins("ㅎ")], [rep("하")], [rep("한")],
    [ins("ㄱ")], [rep("그")], [rep("글")],
    " ",
    [ins("ㅇ")], [rep("이")], [rep("입")],
    [ins("ㄹ")], [rep("려")], [rep("력")],
    " ",
    [ins("ㅌ")], [rep("테")], [rep("텟")],
    moveFinal(order, "테", "스"), [rep("슽")],
    moveFinal(order, "스", "트"),
  ];
}

describe("WebKitImeState — 두벌식 입력", () => {
  for (const order of ["replace-first", "insert-first"] as const) {
    it(`"한글 입력 테스트" 를 친 그대로 보낸다 (받침 이동 ${order})`, () => {
      const h = new Harness();
      h.type(sentence(order));
      h.blur();
      expect(h.sent).toBe("한글 입력 테스트");
    });
  }

  for (const order of ["replace-first", "insert-first"] as const) {
    it(`받침 이동 "하나" — 앞 음절은 다음 음절이 시작되는 키에서 확정된다 (${order})`, () => {
      const h = new Harness();
      h.type([[ins("ㅎ")], [rep("하")], [rep("한")]]);
      expect(h.sent).toBe("");
      h.imeKey(...moveFinal(order, "하", "나"));
      expect(h.sent).toBe("하");
      h.blur();
      expect(h.sent).toBe("하나");
    });
  }

  it("조합 중 Backspace 로 음절을 분해한 뒤 다른 자모를 치면 최종 음절만 간다", () => {
    const h = new Harness();
    h.type([[ins("ㅎ")], [rep("하")], [rep("한")]]);
    h.imeKey(rep("하")); // Backspace (keydown 229)
    h.imeKey(rep("학"));
    h.blur();
    expect(h.sent).toBe("학");
  });

  it("조합 중 Backspace 로 첫 자모까지 지우면 아무것도 가지 않는다", () => {
    const h = new Harness();
    h.imeKey(ins("ㅎ"));
    h.imeKey(del()); // 삭제는 deleteContentBackward 로 올 수 있다
    expect(h.preview).toBe("");
    h.type([[ins("ㄱ")], [rep("가")]]);
    h.blur();
    expect(h.sent).toBe("가");
  });

  it("조합 중 Backspace 가 빈 교체로 와도 지운 자모는 가지 않는다", () => {
    const h = new Harness();
    h.type([[ins("ㄱ")], [rep("가")], [ins("ㄴ")]]);
    h.imeKey(rep(""));
    h.imeKey(ins("ㄷ"));
    h.blur();
    expect(h.sent).toBe("가ㄷ");
  });

  it("조합 중 Enter 는 음절을 먼저 확정하고 그 뒤에 간다", () => {
    const h = new Harness();
    h.type([[ins("ㅎ")], [rep("하")], [rep("한")], "Enter"]);
    expect(h.pty).toEqual(["한", "\r"]);
    // xterm 이 Enter 에서 입력창을 비운 뒤에도 이어서 친 글자가 온전히 간다.
    h.type([[ins("ㄱ")], [rep("그")], [rep("글")], "Enter"]);
    expect(h.sent).toBe("한\r글\r");
  });

  it("조합 중 조합 외 Backspace 는 음절을 확정한 뒤 지운다", () => {
    const h = new Harness();
    h.type([[ins("ㅎ")], [rep("하")], "Backspace"]);
    expect(h.pty).toEqual(["하", "\x7f"]);
  });

  it("영문 입력에는 어댑터가 아무것도 보내지 않는다", () => {
    const h = new Harness();
    h.type(["l", "s", " ", "-", "l", "a", "Enter"]);
    h.blur();
    expect(h.fromAdapter).toEqual([]);
    expect(h.sent).toBe("ls -la\r");
  });

  it("blur 는 남은 조합을 확정하고, 다시 돌아와 친 글자도 온전히 간다", () => {
    const h = new Harness();
    h.type([[ins("ㅎ")], [rep("하")], [rep("한")]]);
    h.blur();
    expect(h.sent).toBe("한");
    h.type([[ins("ㄱ")], [rep("그")], [rep("글")]]);
    h.blur();
    expect(h.sent).toBe("한글");
  });

  it("Space 를 떼기 전에 다음 자모를 쳐도(키 겹침) 그 자모를 잃지 않는다", () => {
    const h = new Harness();
    h.type([[ins("ㅎ")], [rep("하")], [rep("한")]]);
    h.plainKeyDown(" ");
    h.imeKey(ins("ㄱ")); // Space keyup 전에 도착한 다음 키
    h.ime.keyup(); // 이제서야 Space keyup
    h.imeKey(rep("가"));
    h.blur();
    expect(h.sent).toBe("한 가");
  });

  it("Space 의 기본 동작이 입력창에 공백을 넣어도 공백은 한 번만 간다", () => {
    const h = new Harness();
    h.type([[ins("ㅎ")], [rep("하")], [rep("한")]]);
    h.plainKeyDown(" ");
    // xterm 이 이미 보낸 키의 input — 어댑터는 xterm 에 넘긴다(xterm 이 중복을 억제한다).
    expect(h.applyInput(ins(" "))).toBe("pass");
    h.ime.keyup();
    h.type([[ins("ㄱ")], [rep("가")]]);
    h.blur();
    expect(h.sent).toBe("한 가");
  });

  it("조합 중인 글자를 미리보기로 보여 주고 확정되면 지운다", () => {
    const h = new Harness();
    h.imeKey(ins("ㅎ"));
    expect(h.preview).toBe("ㅎ");
    h.imeKey(rep("하"));
    expect(h.preview).toBe("하");
    h.imeKey(ins("ㄱ"));
    expect(h.preview).toBe("ㄱ");
    h.plainKey("Enter");
    expect(h.preview).toBe("");
  });

  it("키 없이 온 이모지·한자·여러 글자는 남은 조합과 함께 바로 간다", () => {
    const h = new Harness();
    h.type([[ins("ㅎ")], [rep("하")]]);
    h.change(ins("😀"));
    expect(h.sent).toBe("하😀");
    h.change(ins("漢"));
    expect(h.sent).toBe("하😀漢");
    h.change(ins("안녕"));
    expect(h.sent).toBe("하😀漢안녕");
    // 조합 중인 음절을 한자로 바꾸는 교체도 같다.
    h.type([[ins("ㅎ")], [rep("하")], [rep("한")]]);
    h.change(rep("韓"));
    expect(h.sent).toBe("하😀漢안녕韓");
    h.blur();
    expect(h.sent).toBe("하😀漢안녕韓");
  });

  it("키 없이 온 한글 한 글자는 뒤따르는 keydown 을 기다리고, 오지 않았다고 알려 주면 간다", () => {
    const h = new Harness();
    h.change(ins("한"));
    expect(h.ime.awaitingKey).toBe(true);
    expect(h.sent).toBe("");
    // 정상 타이핑: 곧 keydown 229 가 와서 기다림이 풀리고 조합은 이어진다.
    h.ime.keydown({ keyCode: 229, key: "Process" }, h.field);
    expect(h.ime.awaitingKey).toBe(false);
    expect(h.sent).toBe("");
    // 키가 오지 않은 경우: 어댑터의 타이머가 flush 한다.
    h.change(ins("ㄱ"));
    expect(h.ime.awaitingKey).toBe(true);
    h.ime.flush(h.field);
    expect(h.ime.awaitingKey).toBe(false);
    expect(h.sent).toBe("한ㄱ");
  });

  it("composition 이벤트를 쓰는 IME 의 확정분은 xterm 몫이라 다시 보내지 않는다", () => {
    const h = new Harness();
    const field = { value: "", selectionStart: 0 };
    h.ime.compositionStart(field);
    expect(h.ime.input("insertCompositionText", "に", { value: "に", selectionStart: 1 })).toBe(
      "pass",
    );
    expect(h.ime.keydown({ keyCode: 229, key: "Process" }, { value: "に", selectionStart: 1 })).toBe(
      "pass",
    );
    h.ime.compositionEnd();
    // 확정 뒤의 다음 IME 키 — 입력창에 남은 "日" 는 이미 xterm 이 보냈다.
    h.ime.keydown({ keyCode: 229, key: "Process" }, { value: "日", selectionStart: 1 });
    h.ime.flush({ value: "日", selectionStart: 1 });
    expect(h.fromAdapter).toEqual([]);
  });
});
