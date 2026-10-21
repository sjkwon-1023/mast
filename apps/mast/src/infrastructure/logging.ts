// 프론트엔드 → 런타임 로그 파일. **꺼져 있는 것이 기본**이고, `settings.json` 의
// `"log": true` 로만 켜진다 (백엔드 계약은 `logfile.rs`).
//
// 이 층이 따로 있는 이유는 mast 의 문제 중 일부가 **WebView 안에서만** 벌어지기
// 때문이다. 한글 IME 조합이 풀리지 않을 때 `compositionend` 가 아예 안 온 것인지, 왔는데
// 상태가 안 풀린 것인지는 글루 로그로 가릴 수 없다. 여기서 남기는 두 줄이 그 갈림을 메운다.
//
// **꺼져 있을 때는 리스너를 설치조차 하지 않는다.** 설치해 두고 안에서 되돌아
// 나오게 만들면 타자 한 글자마다 핸들러가 도는 값을 치른다 — 켜지 않은 사용자가
// 그 값을 낼 이유가 없다.
//
// **내용은 남기지 않는다.** 조합 이벤트는 글자 수만 남기고 글자를 남기지 않으며,
// 단축키는 이름 있는 키(`ArrowLeft`·`Tab`)만 그대로 남기고 인쇄 가능한 한 글자는
// 가린다. 로그 파일이 사용자가 친 것의 사본이 되면 안 된다는 규율이 백엔드와 같다.
//
// 여기서 한 가지를 더 본다 (ADR-0020, 2026-10-20 진단): Windows 두벌식에서
// `compositionend.data` 와 실제로 보낸 문자열(onData)이 **같은지**. 2026-10-21 부터 확정은
// Windows 입력 어댑터(features/terminal/windows-ime.ts)가 보내므로 이 비교는 어댑터를 검증하고,
// 판정 줄의 `xtermWindow` 는 어댑터가 막은 xterm 6 경로였다면 보냈을 textarea 구간이 확정
// 글자와 같았는지를 따로 남긴다(어느 확정의 몫인지 가를 수 없으면 unknown). xterm 6 은 compositionend 직후의 zero-delay 태스크에서
// textarea 값을 읽어 보내므로(CompositionHelper._finalizeComposition), 한 번의 확정이 여러
// 전송으로 갈라지거나 여러 확정이 한 전송으로 합쳐질 수 있다. 그래서 end 하나와 onData
// 하나를 짝지어 비교하지 않고, 마지막 이벤트 뒤 두 번의 zero-delay 태스크 동안 조용해질
// 때까지를 한 묶음으로 모아 비교한다. 값은 여기서만 쓰고 버린다 — 원문·해시·문자 코드를
// 로그에 넣지 않고, 이벤트를 취소·재전송하거나 DOM 값을 쓰지 않는다.

import { IS_MAC } from "../shared/platform";
import { logLine } from "./backend";
import type { UiSettings } from "./backend";

let enabled = false;

export function isLogging(): boolean {
  return enabled;
}

/** 실패는 삼킨다: 로그를 남기려다 기능이 죽는 것이 로그가 없는 것보다 나쁘다. */
export function log(text: string): void {
  if (!enabled) return;
  void logLine(text).catch(() => undefined);
}

/** `ArrowLeft`·`Tab` 처럼 **이름이 두 글자 이상인** 키는 그대로 두고, 인쇄 가능한
 *  한 글자는 `(char)` 로 가린다 — 사용자가 친 글자를 파일에 남기지 않으면서 "어떤
 *  단축키가 삼켜졌나"는 그대로 읽히게 하는 선이다. */
export function describeKey(key: string): string {
  return key.length > 1 ? key : "(char)";
}

/** 수식키가 붙은 조합만 부른다 — 수식키 없는 키는 애초에 단축키가 아니라 입력이다. */
export function logSwallowedShortcut(ev: KeyboardEvent): void {
  if (!enabled) return;
  log(
    `ime: shortcut dropped while composing key=${describeKey(ev.key)} ` +
      `ctrl=${ev.ctrlKey} alt=${ev.altKey} shift=${ev.shiftKey}`,
  );
}

/** 이벤트가 속한 pane 의 `data-pane-id` — pane 밖이거나 ID 가 숫자가 아니면 `none`.
 *  좌표·title·입력값은 읽지 않는다. */
function paneLabel(node: EventTarget | null): string {
  const el = node instanceof Element ? node.closest<HTMLElement>(".pane[data-pane-id]") : null;
  const id = el?.dataset.paneId ?? "";
  return /^\d+$/.test(id) ? id : "none";
}

/** 부팅 배선 — capture 단계 window 리스너인 이유는 xterm 의 숨은 textarea 가 이벤트를
 *  소비해도 먼저 보기 위해서다. 조합의 시작·갱신·끝이 **각각 도착했는지**가 관찰
 *  대상이라, 중간에 누가 멈추면 관찰 자체가 무의미해진다.
 *
 *  같은 옵트인 설치 지점에서 실제 DOM 포커스 이동도 pane ID 로 남긴다. 명령 dispatch 나
 *  `focus()` 호출 의도가 아니라 **포커스를 받은 DOM 대상**을 보므로, 마우스·키보드·뷰어
 *  이동이 같은 규칙으로 잡힌다. 창 전체 focus 는 별도 표면이라 여기서 만들지 않는다. */
export function installFrontEndLogging(
  settings: UiSettings,
  target: EventTarget = window,
): void {
  if (settings.log !== true) return;
  enabled = true;
  log("ui: front end logging on");

  const types = ["compositionstart", "compositionupdate", "compositionend"] as const;
  for (const type of types) {
    target.addEventListener(
      type,
      (ev) => {
        const data = (ev as CompositionEvent).data ?? "";
        const tag = (ev.target as HTMLElement | null)?.tagName ?? "?";
        log(`ime: ${type} len=${data.length} target=${tag}`);
      },
      { capture: true },
    );
  }

  // 도착 이벤트 하나만 남긴다. pane A→B 는 focusout(A, relatedTarget=B) 뒤
  // focusin(B) 이므로 focusin 쪽만 쓰면 전환이 한 줄로 남고, 같은 pane 안의
  // textarea→헤더 이동은 from==to 로 걸러진다. 창 밖으로 나갈 때는 focusin 이
  // 오지 않으므로 relatedTarget 이 null 인 focusout 만 따로 남긴다.
  target.addEventListener(
    "focusin",
    (ev) => {
      const from = paneLabel((ev as FocusEvent).relatedTarget);
      const to = paneLabel(ev.target);
      if (from === to) return;
      log(`pane: focus from=${from} to=${to}`);
    },
    { capture: true },
  );
  target.addEventListener(
    "focusout",
    (ev) => {
      if ((ev as FocusEvent).relatedTarget !== null) return;
      const from = paneLabel(ev.target);
      if (from === "none") return;
      log(`pane: focus from=${from} to=none`);
    },
    { capture: true },
  );
}

const IME_MAX_CODE_UNITS = 4096;
const IME_MAX_ENDS = 32;
const IME_MAX_ON_DATA = 32;
const IME_MAX_OBSERVE_MS = 250;

/** xterm 6 CompositionHelper.keydown 이 조합을 끊지 않는 keyCode (CapsLock·229·Shift·Ctrl·Alt). */
const XTERM_NON_BREAKING_KEY_CODES = new Set([20, 229, 16, 17, 18]);

/** onData 를 만들지 않는 키 — 묶음과 겹쳐도 비교를 흐리지 않는다. */
const NON_INPUT_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "HangulMode",
  "HanjaMode",
  "Process",
  "Unidentified",
]);

/** 판정 불가 사유는 이 고정 목록만 쓴다 — 내용이나 예외 문자열을 reason 에 끼워 넣지 않는다. */
type UnknownReason =
  | "no-data"
  | "empty-end"
  | "before-end"
  | "event-order"
  | "mixed-input"
  | "interrupted"
  | "limit";

interface CommitBundle {
  expected: string;
  actual: string;
  /** xterm 6 CompositionHelper 가 보냈을 문자열의 합 — end 구간과 229 지연 diff. */
  xtermWindow: string;
  /** 구간 합이 상한을 넘었다 — 상한 안의 expected 와 같을 수 없다. */
  xtermWindowOverflow: boolean;
  /** 앞 묶음(닫힌 세대)의 end 지연 전송이 이 묶음 동안 도착했다 — 어느 확정의 몫인지 가를 수 없다. */
  xtermWindowUnknown: boolean;
  /** 열릴 때의 묶음 세대. 묶음이 닫힐 때마다 CommitWatch.epoch 가 오른다. */
  epoch: number;
  ends: number;
  onData: number;
  /** 첫 사유가 이긴다 — 뒤에 온 사유로 앞의 판정 불가를 덮지 않는다. */
  reason: UnknownReason | null;
  deadline: number;
}

/** 진단이 xterm 에서 요구하는 것만 — 로깅 층이 터미널 구현 전체에 묶이지 않게 한다. */
export interface ImeDiagnosticsTerminal {
  readonly element?: HTMLElement;
  readonly textarea?: HTMLTextAreaElement;
  onData(listener: (data: string) => void): { dispose(): void };
}

/** 뷰 수명에 붙는 진단 손잡이. 꺼져 있거나 macOS 면 설치되지 않는다. */
export interface ImeCommitDiagnostics {
  /** 프로그램 붙여넣기(`TerminalView.paste`)도 일반 입력과 겹친 것으로 본다. */
  notePaste(): void;
  /** blur·숨김처럼 확정 묶음을 이어 볼 수 없게 되는 순간. */
  interrupt(): void;
  dispose(): void;
}

/** xterm 6.0 `CompositionHelper`(src/browser/input/CompositionHelper.ts)의 전송 판단을 그대로 옮긴
 *  그림자. Windows 입력 어댑터가 실제 helper 에 이벤트를 주지 않으므로, helper 였다면 무엇을
 *  보냈을지만 계산해 `send` 로 넘긴다 (xtermWindow). 필드·분기·타이머 수는 원본과 같다 — 타이머는
 *  원본처럼 이벤트마다 zero-delay 하나씩이고 dispose 가 모두 지운다. `_dataAlreadySent` 는
 *  길이만 쓰이므로 길이만 둔다. tooling/ime-composition.test.ts 가 같은 이벤트 열을 원본 번들과
 *  이 그림자에 함께 넣어 전송이 같은지 대조한다. `kind` 는 전송이 어느 경로에서 나왔는지, `tag` 는
 *  end 지연 전송이 예약될 때 호출자가 준 값이다 — 묶음 귀속(CommitWatch.addXtermSend)이 쓴다. */
export type XtermSendKind = "end" | "early" | "diff";

export class XtermCompositionShadow {
  private isComposing = false;
  private isSendingComposition = false;
  private start = 0;
  private end = 0;
  private dataAlreadySentLength = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly textarea: HTMLTextAreaElement,
    private readonly send: (data: string, kind: XtermSendKind, tag: number) => void,
  ) {}

  compositionStart(): void {
    this.isComposing = true;
    this.start = this.textarea.value.length;
    this.dataAlreadySentLength = 0;
  }

  compositionUpdate(): void {
    this.later(() => {
      this.end = this.textarea.value.length;
    });
  }

  compositionEnd(tag = 0): void {
    this.finalize(true, tag);
  }

  keydown(keyCode: number): void {
    if (this.isComposing || this.isSendingComposition) {
      if (XTERM_NON_BREAKING_KEY_CODES.has(keyCode)) return;
      this.finalize(false);
    }
    if (keyCode === 229) this.handleAnyTextareaChanges();
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private finalize(waitForPropagation: boolean, tag = 0): void {
    this.isComposing = false;
    if (!waitForPropagation) {
      this.isSendingComposition = false;
      this.send(this.textarea.value.substring(this.start, this.end), "early", tag);
      return;
    }
    const from = this.start;
    this.isSendingComposition = true;
    this.later(() => {
      if (!this.isSendingComposition) return;
      this.isSendingComposition = false;
      const value = this.textarea.value;
      const at = from + this.dataAlreadySentLength;
      const data = this.isComposing ? value.substring(at, this.start) : value.substring(at);
      if (data.length > 0) this.send(data, "end", tag);
    });
  }

  private handleAnyTextareaChanges(): void {
    const before = this.textarea.value;
    this.later(() => {
      if (this.isComposing) return;
      const after = this.textarea.value;
      const diff = after.replace(before, "");
      this.dataAlreadySentLength = diff.length;
      if (after.length > before.length) this.send(diff, "diff", 0);
      else if (after.length < before.length) this.send("\x7f", "diff", 0);
      else if (after !== before) this.send(after, "diff", 0);
    });
  }

  private later(fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, 0);
    this.timers.add(timer);
  }
}

class CommitWatch implements ImeCommitDiagnostics {
  private composing = false;
  /** end 없이 새 start 가 왔다 — Microsoft IME 가 겹쳐 보낸 조합. */
  private overlap = false;
  /** 조합 중 end 전에 onData 가 나갔다 — 어느 확정의 전송인지 알 수 없다. */
  private dataBeforeEnd = false;
  /** 조합·묶음과 겹친 일반 키나 붙여넣기. */
  private mixed = false;
  /** 상한을 넘겼다 — 다음 start 까지 뒤따르는 onData 를 새 묶음으로 받지 않는다. */
  private limited = false;
  private bundle: CommitBundle | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private settleGeneration = 0;
  private readonly xterm: XtermCompositionShadow;
  private epoch = 0;
  // 묶음이 열리기 전(end 전)에 xterm 이 보냈을 문자열 — 그 end 가 여는 묶음에 얹는다.
  private xtermCarry = "";
  private xtermCarryOverflow = false;
  private closed = false;
  private readonly dataSub: { dispose(): void };
  private readonly listeners: Array<[string, (ev: Event) => void]>;

  constructor(
    private readonly terminal: ImeDiagnosticsTerminal,
    private readonly session: number,
    private readonly element: HTMLElement,
    private readonly textarea: HTMLTextAreaElement,
  ) {
    // xterm 은 공개 onData 로만 관찰한다 — private 훅이나 번들 패치 없이 replay gate
    // 뒤의 기존 전달 경로를 건드리지 않는다.
    this.dataSub = terminal.onData((data) => this.onData(data));
    this.xterm = new XtermCompositionShadow(textarea, (data, kind, tag) =>
      this.addXtermSend(data, kind, tag),
    );
    // Windows 입력 어댑터가 textarea 에 닿기 전에 조합 이벤트를 멈추므로 같은 element 의
    // capture 에서 어댑터보다 먼저 본다.
    this.listeners = [
      ["compositionstart", this.onCompositionStart],
      ["compositionupdate", this.onCompositionUpdate],
      ["compositionend", this.onCompositionEnd],
      ["keydown", this.onKeyDown],
      ["paste", this.onPaste],
      ["blur", this.onBlur],
    ];
    for (const [type, fn] of this.listeners) element.addEventListener(type, fn, true);
  }

  notePaste(): void {
    this.markMixed();
  }

  interrupt(): void {
    if (this.closed) return;
    if (this.bundle !== null) {
      this.bundle.reason ??= "interrupted";
      this.closeBundle();
    } else if (this.composing) {
      this.logUnknown("interrupted", 0, 0);
    }
    this.composing = false;
    this.overlap = false;
    this.dataBeforeEnd = false;
    this.mixed = false;
    this.xtermCarry = "";
    this.xtermCarryOverflow = false;
  }

  dispose(): void {
    if (this.closed) return;
    this.interrupt();
    this.closed = true;
    this.dataSub.dispose();
    for (const [type, fn] of this.listeners) this.element.removeEventListener(type, fn, true);
    this.xterm.dispose();
  }

  private readonly onCompositionStart = (ev: Event): void => {
    if (this.closed || ev.target !== this.textarea) return;
    this.xterm.compositionStart();
    if (this.limited) {
      // 상한에 걸린 조합의 꼬리는 버리고 다음 조합부터 새 묶음으로 본다.
      this.limited = false;
      this.xtermCarry = "";
      this.xtermCarryOverflow = false;
      this.overlap = false;
      this.dataBeforeEnd = false;
      this.mixed = false;
      this.composing = true;
      return;
    }
    if (this.composing) {
      this.overlap = true;
      if (this.bundle !== null) this.bundle.reason ??= "event-order";
    } else {
      this.overlap = false;
      this.dataBeforeEnd = false;
      this.mixed = false;
    }
    this.composing = true;
  };

  /** 조합 밖의 update — 2026-10-19 현장 로그처럼 닫힌 조합 뒤에 온다. 열린 묶음이
   *  있으면 그 구간의 순서가 깨진 것이므로 판정을 보류한다. */
  private readonly onCompositionUpdate = (ev: Event): void => {
    if (this.closed || ev.target !== this.textarea) return;
    this.xterm.compositionUpdate();
    if (this.limited || this.composing) return;
    if (this.bundle !== null) this.bundle.reason ??= "event-order";
  };

  private readonly onCompositionEnd = (ev: Event): void => {
    if (this.closed || ev.target !== this.textarea) return;
    // 이 end 가 열거나 합류할 묶음의 세대 — 그 사이 묶음이 닫히면 세대가 오른다.
    this.xterm.compositionEnd(this.epoch);
    if (this.limited) return;
    const data = (ev as CompositionEvent).data ?? "";
    if (!this.composing) {
      // 조합 밖에서 온 end — 어느 조합의 확정인지 귀속할 수 없다. 열린 묶음이 있으면
      // 그 묶음의 비교도 이 확정을 빼고 내린 셈이 되므로 함께 판정 불가로 만든다.
      if (this.bundle !== null) this.bundle.reason ??= "event-order";
      else this.logUnknown("event-order", 0, 0);
      return;
    }
    this.composing = false;

    const bundle = this.open();
    this.claimXtermCarry(bundle);
    if (this.overlap) bundle.reason ??= "event-order";
    if (this.dataBeforeEnd) bundle.reason ??= "before-end";
    if (this.mixed) bundle.reason ??= "mixed-input";
    this.overlap = false;
    this.dataBeforeEnd = false;
    this.mixed = false;

    // 250ms 상한은 이벤트가 묶음을 계속 늘리지 못하게 하는 선이다. 조용해지면
    // settle 이 먼저 닫으므로, 상한은 다음 이벤트가 왔을 때 확인하면 충분하다.
    if (Date.now() >= bundle.deadline) {
      this.hitLimit(bundle);
      return;
    }

    if (data.length === 0) bundle.reason ??= "empty-end";
    bundle.ends += 1;
    if (
      bundle.expected.length + data.length > IME_MAX_CODE_UNITS ||
      bundle.ends > IME_MAX_ENDS
    ) {
      this.hitLimit(bundle);
      return;
    }
    bundle.expected += data;
    this.armSettle();
  };

  private readonly onData = (data: string): void => {
    if (this.closed || this.limited) return;
    const bundle = this.bundle;
    if (bundle === null) {
      // 조합 중인데 end 가 아직 없다 — 이 전송을 다음 확정에 붙이지 않는다.
      if (this.composing) this.dataBeforeEnd = true;
      return;
    }
    if (Date.now() >= bundle.deadline) {
      this.hitLimit(bundle);
      return;
    }
    if (
      bundle.actual.length + data.length > IME_MAX_CODE_UNITS ||
      bundle.onData >= IME_MAX_ON_DATA
    ) {
      this.hitLimit(bundle);
      return;
    }
    bundle.actual += data;
    bundle.onData += 1;
    this.armSettle();
  };

  private readonly onKeyDown = (ev: Event): void => {
    if (this.closed || ev.target !== this.textarea) return;
    const key = ev as KeyboardEvent;
    this.xterm.keydown(key.keyCode);
    if (this.limited) return;
    // IME 가 삼킨 키(229)만 일반 입력이 아니다. `isComposing` 으로 거르지 않는 것은
    // xterm 이 keyCode 로만 가르기 때문이다 — 조합 중의 비-229 Enter 는 조합을 확정하고
    // CR 도 보낸다. Tab·Escape·방향키도 onData 로 시퀀스를 보내므로, 수식키·입력 모드
    // 전환 키가 아니면 다른 입력이 섞인 것으로 보고 보류한다.
    if (key.keyCode === 229 || NON_INPUT_KEYS.has(key.key)) return;
    this.markMixed();
  };

  private readonly onPaste = (): void => {
    this.markMixed();
  };

  private readonly onBlur = (ev: Event): void => {
    if (ev.target !== this.textarea) return;
    this.interrupt();
  };

  /** 전송을 출처로 귀속한다. end 의 지연 전송은 그 end 가 연 묶음 몫이다. 조기 종료·229 diff 는
   *  브라우저 조합이 열려 있으면 그 조합의 다음 end 몫이라 — 앞 묶음이 아직 정산 중이어도 —
   *  다음 묶음에 얹고, 아니면 열린 묶음 몫이다. 어느 묶음에도 속하지 않으면(키 없는 입력의 diff,
   *  상한·중단으로 닫힌 묶음) 버린다. */
  private addXtermSend(data: string, kind: XtermSendKind, tag: number): void {
    if (kind !== "end" && this.composing) {
      if (this.xtermCarry.length + data.length > IME_MAX_CODE_UNITS) this.xtermCarryOverflow = true;
      else this.xtermCarry += data;
      return;
    }
    const bundle = this.bundle;
    if (bundle === null) return;
    if (kind === "end" && tag !== bundle.epoch) {
      bundle.xtermWindowUnknown = true;
      return;
    }
    this.appendXtermWindow(bundle, data);
  }

  /** 조합이 열린 동안 이월한 조기 전송을 그 조합의 end 가 연(또는 합류한) 묶음으로 옮긴다. */
  private claimXtermCarry(bundle: CommitBundle): void {
    if (this.xtermCarryOverflow) bundle.xtermWindowOverflow = true;
    else this.appendXtermWindow(bundle, this.xtermCarry);
    this.xtermCarry = "";
    this.xtermCarryOverflow = false;
  }

  private appendXtermWindow(bundle: CommitBundle, data: string): void {
    if (bundle.xtermWindow.length + data.length > IME_MAX_CODE_UNITS) {
      bundle.xtermWindowOverflow = true;
    } else {
      bundle.xtermWindow += data;
    }
  }

  private markMixed(): void {
    if (this.closed || this.limited) return;
    // 앞 묶음이 아직 열린 채 다음 조합이 진행 중일 수 있다 — 둘 다에 남긴다.
    if (this.bundle !== null) this.bundle.reason ??= "mixed-input";
    if (this.composing) this.mixed = true;
  }

  private open(): CommitBundle {
    if (this.bundle !== null) return this.bundle;
    const bundle: CommitBundle = {
      expected: "",
      actual: "",
      xtermWindow: "",
      xtermWindowOverflow: false,
      xtermWindowUnknown: false,
      epoch: this.epoch,
      ends: 0,
      onData: 0,
      reason: null,
      deadline: Date.now() + IME_MAX_OBSERVE_MS,
    };
    this.bundle = bundle;
    return bundle;
  }

  private armSettle(): void {
    const generation = ++this.settleGeneration;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    // xterm 이 compositionend 뒤 zero-delay 태스크에서 보내므로 한 번 더 기다린다.
    // 그 사이 새 이벤트가 오면 generation 이 바뀌어 경계를 다시 잡는다.
    this.settleTimer = setTimeout(() => {
      if (generation !== this.settleGeneration) return;
      this.settleTimer = setTimeout(() => {
        if (generation !== this.settleGeneration) return;
        this.settleTimer = null;
        this.closeBundle();
      }, 0);
    }, 0);
  }

  private hitLimit(bundle: CommitBundle): void {
    bundle.reason ??= "limit";
    this.closeBundle();
    this.limited = true;
  }

  private closeBundle(): void {
    const bundle = this.bundle;
    if (bundle === null) return;
    this.bundle = null;
    this.epoch += 1;
    this.settleGeneration += 1;
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }

    const reason = bundle.reason ?? (bundle.onData === 0 ? "no-data" : null);
    if (reason !== null) {
      this.logUnknown(reason, bundle.ends, bundle.onData);
      return;
    }
    const xtermWindow = bundle.xtermWindowUnknown
      ? "unknown"
      : !bundle.xtermWindowOverflow && bundle.xtermWindow === bundle.expected
        ? "same"
        : "differs";
    log(
      `ime: commit match=${bundle.expected === bundle.actual} ${this.identifiers()} ` +
        `ends=${bundle.ends} onData=${bundle.onData} ` +
        `expectedLen=${bundle.expected.length} actualLen=${bundle.actual.length} ` +
        `xtermWindow=${xtermWindow}`,
    );
  }

  private logUnknown(reason: UnknownReason, ends: number, onData: number): void {
    log(
      `ime: commit match=unknown reason=${reason} ${this.identifiers()} ` +
        `ends=${ends} onData=${onData}`,
    );
  }

  private identifiers(): string {
    return `session=${this.session} pane=${paneLabel(this.terminal.element ?? null)}`;
  }
}

/** 터미널별 옵트인 비교 관찰자. 로그가 꺼져 있거나 macOS 면 `null` 이라
 *  onData 구독·리스너·타이머·문자열 보관이 하나도 생기지 않는다. */
export function installImeCommitDiagnostics(
  terminal: ImeDiagnosticsTerminal,
  session: number,
): ImeCommitDiagnostics | null {
  if (!enabled || IS_MAC) return null;
  const { element, textarea } = terminal;
  if (element === undefined || textarea === undefined) return null;
  return new CommitWatch(terminal, session, element, textarea);
}
