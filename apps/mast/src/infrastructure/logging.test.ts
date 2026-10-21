// @vitest-environment happy-dom
//
// 프론트 로그 배선 (infrastructure/logging.ts). 지키는 계약이 셋이다 — **꺼져 있으면
// 아무것도 설치하지 않는다**(켜지 않은 사용자가 타자마다 도는 핸들러 값을 내지 않는다),
// **내용을 남기지 않는다**(글자 수·이름 있는 키·일치 여부만), 그리고 **진단이 입력을
// 바꾸지 않는다**(취소·재전송·DOM 값 쓰기 없음).
//
// 모듈 상태(`enabled`)가 테스트 사이에 남지 않도록 케이스마다 모듈 레지스트리를 비우고
// 다시 import 한다 — 케이스 순서에 의존하지 않게 하려는 것이다.
//
// 백엔드 IPC 는 vi.mock 으로 고정한다 — vi.mock 은 hoist 되므로 팩토리가 참조하는
// 것은 vi.hoisted 로 만든다 (features/viewers/text/view.test.ts 와 같은 관례).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UiSettings } from "./backend";
import type { ImeCommitDiagnostics } from "./logging";

const sent = vi.hoisted(() => [] as string[]);

vi.mock("./backend", () => ({
  logLine: (text: string) => {
    sent.push(text);
    return Promise.resolve();
  },
}));

type Logging = typeof import("./logging");

let logging: Logging;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  sent.length = 0;
  document.body.innerHTML = "";
  logging = await import("./logging");
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function settings(log: boolean | null): UiSettings {
  return { fontFamily: null, fontSize: null, highlightLanguages: null, log, remote: null, showTabIds: null, macOptionIsMeta: null };
}

/** **happy-dom 에는 `CompositionEvent` 가 없다** — `window.CompositionEvent` 는 그냥
 *  `Event` 로 떨어지고 `data` init 은 조용히 버려진다 (확인함). 그래서 여기서 직접
 *  `data` 를 얹는다. 실제 코드가 읽는 것도 그 프로퍼티 하나뿐이라 계약은 같다. */
function composition(target: EventTarget, type: string, data: string): void {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, "data", { value: data });
  target.dispatchEvent(ev);
}

/** 브라우저가 아니라 xterm 을 대신하는 최소 터미널 — onData 구독과 textarea 만 있다. */
interface FakeTerminal {
  readonly element: HTMLDivElement;
  readonly textarea: HTMLTextAreaElement;
  emit(data: string): void;
  subscribers(): number;
  onData(listener: (data: string) => void): { dispose(): void };
}

function fakeTerminal(paneId: number | null): FakeTerminal {
  const pane = document.createElement("div");
  pane.className = "pane";
  if (paneId !== null) pane.dataset.paneId = String(paneId);
  const element = document.createElement("div");
  const textarea = document.createElement("textarea");
  element.append(textarea);
  pane.append(element);
  document.body.append(pane);

  const listeners = new Set<(data: string) => void>();
  return {
    element,
    textarea,
    emit(data: string): void {
      for (const listener of [...listeners]) listener(data);
    },
    subscribers: () => listeners.size,
    onData(listener: (data: string) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

function enable(target: EventTarget = new EventTarget()): void {
  logging.installFrontEndLogging(settings(true), target);
}

function watch(term: FakeTerminal, session = 7): ImeCommitDiagnostics {
  const diagnostics = logging.installImeCommitDiagnostics(term, session);
  if (diagnostics === null) throw new Error("diagnostics were not installed");
  return diagnostics;
}

/** 두 번의 zero-delay task 가 지나야 묶음이 닫힌다. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(1);
}

/** 판정 줄. xterm 구간 판정(`xtermWindow`)은 그것만 보는 케이스가 따로 있어 여기서는 뗀다. */
function commits(): string[] {
  return rawCommits().map((line) => line.replace(/ xtermWindow=\S+$/, ""));
}

function rawCommits(): string[] {
  return sent.filter((line) => line.startsWith("ime: commit"));
}

describe("logging", () => {
  it("이름 있는 키만 그대로 남기고 인쇄 가능한 한 글자는 가린다", () => {
    expect(logging.describeKey("ArrowLeft")).toBe("ArrowLeft");
    expect(logging.describeKey("Tab")).toBe("Tab");
    // 사용자가 친 글자는 로그 파일에 남지 않는다 — 한글도 라틴 문자도 마찬가지.
    expect(logging.describeKey("ㅁ")).toBe("(char)");
    expect(logging.describeKey("a")).toBe("(char)");
  });

  it("꺼져 있으면 리스너를 설치하지 않는다", () => {
    const target = new EventTarget();
    const spy = vi.spyOn(target, "addEventListener");

    logging.installFrontEndLogging(settings(null), target);
    logging.installFrontEndLogging(settings(false), target);

    expect(spy).not.toHaveBeenCalled();
    expect(logging.isLogging()).toBe(false);
    composition(target, "compositionstart", "ㅇ");
    expect(sent).toEqual([]);
  });

  it("켜면 조합의 세 단계를 글자 수만 담아 남긴다", () => {
    const target = document.createElement("div");
    document.body.append(target);

    logging.installFrontEndLogging(settings(true), target);
    expect(logging.isLogging()).toBe(true);

    composition(target, "compositionstart", "");
    composition(target, "compositionupdate", "이");
    composition(target, "compositionend", "이전");

    expect(sent[0]).toBe("ui: front end logging on");
    expect(sent.slice(1)).toEqual([
      "ime: compositionstart len=0 target=DIV",
      "ime: compositionupdate len=1 target=DIV",
      "ime: compositionend len=2 target=DIV",
    ]);
    // 조합 중이던 글자 자체는 어느 줄에도 없어야 한다.
    expect(sent.join("\n")).not.toContain("이");
  });

  it("조합 중 삼켜진 단축키는 어떤 키였는지까지 남는다", () => {
    enable();
    logging.logSwallowedShortcut(
      new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }),
    );

    expect(sent.at(-1)).toBe(
      "ime: shortcut dropped while composing key=ArrowLeft ctrl=false alt=true shift=false",
    );
  });
});

describe("IME 확정 비교", () => {
  it("로그가 꺼져 있으면 비교 관찰자를 만들지 않는다", () => {
    const term = fakeTerminal(3);
    const addSpy = vi.spyOn(term.textarea, "addEventListener");

    expect(logging.installImeCommitDiagnostics(term, 7)).toBeNull();
    expect(term.subscribers()).toBe(0);
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("macOS 에서는 비교 관찰자를 만들지 않는다", async () => {
    vi.resetModules();
    vi.doMock("../shared/platform", () => ({ IS_MAC: true }));
    try {
      const macLogging: Logging = await import("./logging");
      const target = new EventTarget();
      macLogging.installFrontEndLogging(settings(true), target);
      const term = fakeTerminal(3);
      expect(macLogging.installImeCommitDiagnostics(term, 7)).toBeNull();
      expect(term.subscribers()).toBe(0);
    } finally {
      vi.doUnmock("../shared/platform");
    }
  });

  it("한 번의 확정과 한 번의 전송을 비교한다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionupdate", "테");
    composition(term.textarea, "compositionend", "테");
    term.emit("테");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=1 onData=1 expectedLen=1 actualLen=1",
    ]);
  });

  it("여러 확정이 한 번의 전송으로 합쳐져도 비교한다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "스");
    term.emit("테스");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=2 onData=1 expectedLen=2 actualLen=2",
    ]);
  });

  it("한 번의 확정이 여러 전송으로 갈라져도 비교한다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테스트");
    term.emit("테");
    term.emit("스트");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=1 onData=2 expectedLen=3 actualLen=3",
    ]);
  });

  it("길이가 같아도 다른 문자열이면 false 다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테스");
    term.emit("트스");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=false session=7 pane=3 ends=1 onData=1 expectedLen=2 actualLen=2",
    ]);
  });

  it("길이는 UTF-16 code unit 이다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "😀");
    term.emit("😀");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=1 onData=1 expectedLen=2 actualLen=2",
    ]);
  });

  it("확정은 왔는데 전송이 없으면 no-data 다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=no-data session=7 pane=3 ends=1 onData=0",
    ]);
  });

  it("빈 확정은 취소인지 확정인지 알 수 없어 empty-end 다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=empty-end session=7 pane=3 ends=1 onData=0",
    ]);
  });

  it("확정 전에 전송이 나가면 before-end 다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionupdate", "테");
    term.emit("테");
    composition(term.textarea, "compositionend", "테");
    term.emit("테");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=before-end session=7 pane=3 ends=1 onData=1",
    ]);
  });

  it("조합이 끝나기 전에 새 조합이 시작되면 event-order 다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    term.emit("테");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=event-order session=7 pane=3 ends=1 onData=1",
    ]);
  });

  it("조합 밖에서 온 end 는 event-order 로만 남는다", () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionend", "테");

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=event-order session=7 pane=3 ends=0 onData=0",
    ]);
  });

  it("조합과 겹친 일반 키 입력은 mixed-input 이다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    term.textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    term.emit("테a");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=mixed-input session=7 pane=3 ends=1 onData=1",
    ]);
  });

  it("Tab·Escape·방향키처럼 시퀀스를 보내는 키도 mixed-input 이다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    for (const [key, seq] of [
      ["Tab", "\t"],
      ["Escape", "\x1b"],
      ["ArrowLeft", "\x1b[D"],
    ]) {
      composition(term.textarea, "compositionstart", "");
      composition(term.textarea, "compositionend", "테");
      term.emit("테");
      term.textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      term.emit(seq);
      await settle();
    }

    expect(commits()).toEqual(
      Array(3).fill(
        "ime: commit match=unknown reason=mixed-input session=7 pane=3 ends=1 onData=2",
      ),
    );
  });

  it("조합 중(isComposing)이어도 IME 가 삼키지 않은 키는 mixed-input 이다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    term.textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    composition(term.textarea, "compositionend", "테");
    term.emit("테\r");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=mixed-input session=7 pane=3 ends=1 onData=1",
    ]);
  });

  it("앞 묶음이 열린 채 다음 조합에 끼어든 붙여넣기는 다음 조합까지 보류한다", async () => {
    const pastes: ((term: FakeTerminal, d: ImeCommitDiagnostics) => void)[] = [
      (_term, d) => d.notePaste(),
      (term) => term.textarea.dispatchEvent(new Event("paste", { bubbles: true })),
    ];
    for (const paste of pastes) {
      sent.length = 0;
      enable();
      const term = fakeTerminal(3);
      const diagnostics = watch(term);

      composition(term.textarea, "compositionstart", "");
      composition(term.textarea, "compositionend", "가");
      term.emit("가");
      composition(term.textarea, "compositionstart", "");
      paste(term, diagnostics);
      term.emit("P");
      await settle();
      composition(term.textarea, "compositionend", "나");
      term.emit("나");
      await settle();

      expect(commits()).toEqual([
        "ime: commit match=unknown reason=mixed-input session=7 pane=3 ends=1 onData=2",
        "ime: commit match=unknown reason=mixed-input session=7 pane=3 ends=1 onData=1",
      ]);
      diagnostics.dispose();
    }
  });

  it("수식키·한/영 전환 키는 비교를 보류하지 않는다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    for (const key of ["Shift", "HangulMode"]) {
      term.textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }
    term.emit("테");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=1 onData=1 expectedLen=1 actualLen=1",
    ]);
  });

  it("열린 묶음 뒤의 고립 update 는 그 묶음을 event-order 로 만든다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "가");
    term.emit("가");
    composition(term.textarea, "compositionupdate", "나");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=event-order session=7 pane=3 ends=1 onData=1",
    ]);
  });

  it("열린 묶음 뒤의 고립 end 는 그 묶음까지 event-order 로 만든다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "가");
    composition(term.textarea, "compositionend", "나");
    term.emit("가나");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=event-order session=7 pane=3 ends=1 onData=1",
    ]);
  });

  it("프로그램 붙여넣기가 겹쳐도 mixed-input 이다", async () => {
    enable();
    const term = fakeTerminal(3);
    const diagnostics = watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    diagnostics.notePaste();
    term.emit("테");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=mixed-input session=7 pane=3 ends=1 onData=1",
    ]);
  });

  it("textarea 의 paste 이벤트가 겹쳐도 mixed-input 이다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    term.textarea.dispatchEvent(new Event("paste", { bubbles: true }));
    term.emit("테");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=mixed-input session=7 pane=3 ends=1 onData=1",
    ]);
  });

  it("blur 는 남은 묶음을 interrupted 로 닫는다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    term.emit("테");
    term.textarea.dispatchEvent(new Event("blur"));
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=interrupted session=7 pane=3 ends=1 onData=1",
    ]);
  });

  it("관찰 시간 상한 250ms 를 넘기면 limit 이다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    // 조용해지면 settle 이 정상 정산하므로, 다음 이벤트가 상한을 넘겼는지를 본다.
    vi.setSystemTime(Date.now() + 250);
    term.emit("테");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=limit session=7 pane=3 ends=1 onData=0",
    ]);
  });

  it("보유 문자열·횟수 상한을 넘기면 limit 이고 다음 조합은 다시 정상이다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "가".repeat(4097));
    await settle();
    expect(commits()).toEqual([
      "ime: commit match=unknown reason=limit session=7 pane=3 ends=1 onData=0",
    ]);

    sent.length = 0;
    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    term.emit("테");
    await settle();
    expect(commits()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=1 onData=1 expectedLen=1 actualLen=1",
    ]);
  });

  it("onData 32회를 넘기면 limit 이다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    for (let i = 0; i < 33; i += 1) term.emit("테");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=limit session=7 pane=3 ends=1 onData=32",
    ]);
  });

  it("빈 onData 도 32회 상한에 센다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    term.emit("테");
    for (let i = 0; i < 32; i += 1) term.emit("");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=unknown reason=limit session=7 pane=3 ends=1 onData=32",
    ]);
  });

  it("두 terminal 의 교차 조합이 서로 섞이지 않는다", async () => {
    enable();
    const a = fakeTerminal(3);
    const b = fakeTerminal(5);
    watch(a, 7);
    watch(b, 8);

    composition(a.textarea, "compositionstart", "");
    composition(b.textarea, "compositionstart", "");
    composition(a.textarea, "compositionend", "테");
    composition(b.textarea, "compositionend", "스");
    b.emit("스");
    a.emit("테");
    await settle();

    expect(commits().sort()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=1 onData=1 expectedLen=1 actualLen=1",
      "ime: commit match=true session=8 pane=5 ends=1 onData=1 expectedLen=1 actualLen=1",
    ]);
  });

  it("pane 이 옮겨지면 정산 시점의 pane ID 로 남는다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);
    const moved = document.createElement("div");
    moved.className = "pane";
    moved.dataset.paneId = "9";
    document.body.append(moved);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    moved.append(term.element);
    term.emit("테");
    await settle();

    expect(commits()).toEqual([
      "ime: commit match=true session=7 pane=9 ends=1 onData=1 expectedLen=1 actualLen=1",
    ]);
  });

  it("dispose 뒤에는 이벤트도 타이머도 로그를 만들지 않는다", async () => {
    enable();
    const term = fakeTerminal(3);
    const diagnostics = watch(term);

    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    diagnostics.dispose();

    expect(term.subscribers()).toBe(0);
    expect(commits()).toEqual([
      "ime: commit match=unknown reason=interrupted session=7 pane=3 ends=1 onData=0",
    ]);

    sent.length = 0;
    term.emit("테");
    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "테");
    await vi.advanceTimersByTimeAsync(1000);
    expect(commits()).toEqual([]);
  });

  it("xterm 이 읽었을 textarea 구간이 확정과 같으면 xtermWindow=same 이다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    term.textarea.value = "테";
    composition(term.textarea, "compositionupdate", "테");
    composition(term.textarea, "compositionend", "테");
    term.emit("테");
    await settle();

    expect(rawCommits()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=1 onData=1 expectedLen=1 actualLen=1 xtermWindow=same",
    ]);
  });

  it("다음 조합이 textarea 의 앞 음절을 바꿔 쓰면 xtermWindow=differs 다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    term.textarea.value = "조";
    composition(term.textarea, "compositionupdate", "조");
    composition(term.textarea, "compositionend", "조");
    composition(term.textarea, "compositionstart", "");
    term.textarea.value = "자";
    composition(term.textarea, "compositionupdate", "자");
    term.emit("조");
    await settle();

    expect(rawCommits()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=1 onData=1 expectedLen=1 actualLen=1 xtermWindow=differs",
    ]);
  });

  it("한 태스크의 여러 end 는 첫 타이머가 최신 조합 시작까지 읽는다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    composition(term.textarea, "compositionstart", "");
    term.textarea.value = "테";
    composition(term.textarea, "compositionend", "테");
    composition(term.textarea, "compositionstart", "");
    term.textarea.value = "테스";
    composition(term.textarea, "compositionend", "스");
    composition(term.textarea, "compositionstart", "");
    term.textarea.value = "테스ㅌ";
    composition(term.textarea, "compositionupdate", "ㅌ");
    term.emit("테스");
    await settle();

    expect(rawCommits()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=2 onData=1 expectedLen=2 actualLen=2 xtermWindow=same",
    ]);
  });

  it("전송 로그에 입력 원문·해시·문자 코드가 남지 않는다", async () => {
    enable();
    const term = fakeTerminal(3);
    watch(term);

    // 길이가 같은 두 비밀 문자열 — 로그에 남는 것은 일치 여부와 길이뿐이어야 한다.
    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "비밀");
    term.emit("비밀");
    await settle();
    composition(term.textarea, "compositionstart", "");
    composition(term.textarea, "compositionend", "비밀");
    term.emit("암호");
    await settle();

    const joined = sent.join("\n");
    expect(joined).not.toContain("비밀");
    expect(joined).not.toContain("암호");
    expect(joined).not.toContain("48708");
    expect(joined).not.toContain("48152");
    expect(commits()).toEqual([
      "ime: commit match=true session=7 pane=3 ends=1 onData=1 expectedLen=2 actualLen=2",
      "ime: commit match=false session=7 pane=3 ends=1 onData=1 expectedLen=2 actualLen=2",
    ]);
  });
});

describe("pane 포커스", () => {
  /** 리스너는 target 에 남으므로 케이스마다 새 컨테이너에 설치한다 — body 재사용은 중복 로그다. */
  function host(): HTMLDivElement {
    const el = document.createElement("div");
    document.body.append(el);
    return el;
  }

  function paneWith(
    container: HTMLElement,
    id: string | null,
  ): { pane: HTMLDivElement; input: HTMLInputElement } {
    const pane = document.createElement("div");
    pane.className = "pane";
    if (id !== null) pane.dataset.paneId = id;
    const input = document.createElement("input");
    pane.append(input);
    container.append(pane);
    return { pane, input };
  }

  function focusTo(target: HTMLElement, related: HTMLElement | null): void {
    target.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: related }));
  }

  it("pane A→B 와 B→A 는 도착 이벤트 한 줄씩으로 남는다", () => {
    const container = host();
    enable(container);
    const a = paneWith(container, "3");
    const b = paneWith(container, "5");

    focusTo(b.input, a.input);
    focusTo(a.input, b.input);

    expect(sent).toEqual([
      "ui: front end logging on",
      "pane: focus from=3 to=5",
      "pane: focus from=5 to=3",
    ]);
  });

  it("같은 pane 안의 textarea→헤더 이동은 전환이 아니다", () => {
    const container = host();
    enable(container);
    const a = paneWith(container, "3");
    const header = document.createElement("div");
    a.pane.append(header);

    focusTo(header, a.input);

    expect(sent).toEqual(["ui: front end logging on"]);
  });

  it("pane 밖으로 나가면 to=none 이다", () => {
    const container = host();
    enable(container);
    const a = paneWith(container, "3");

    a.input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));

    expect(sent).toEqual(["ui: front end logging on", "pane: focus from=3 to=none"]);
  });

  it("pane 밖에서 들어오면 from=none 이다", () => {
    const container = host();
    enable(container);
    const a = paneWith(container, "3");

    focusTo(a.input, null);

    expect(sent).toEqual(["ui: front end logging on", "pane: focus from=none to=3"]);
  });

  it("같은 창 안의 pane 밖 이동은 focusout 을 중복으로 남기지 않는다", () => {
    const container = host();
    enable(container);
    const a = paneWith(container, "3");
    const sidebar = document.createElement("button");
    container.append(sidebar);

    a.input.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: sidebar }),
    );
    focusTo(sidebar, a.input);

    expect(sent).toEqual(["ui: front end logging on", "pane: focus from=3 to=none"]);
  });

  it("숫자가 아닌 pane ID 는 none 이다", () => {
    const container = host();
    enable(container);
    const a = paneWith(container, "3");
    const odd = paneWith(container, "x");

    focusTo(odd.input, a.input);

    expect(sent).toEqual(["ui: front end logging on", "pane: focus from=3 to=none"]);
  });

  it("키보드로 일어난 같은 전환도 실제 DOM 포커스로 잡힌다", () => {
    const container = host();
    enable(container);
    const a = paneWith(container, "1");
    const b = paneWith(container, "2");

    // 이동 명령을 흉내 내지 않고 브라우저가 내는 focusin 을 그대로 쓴다.
    a.input.focus();
    sent.length = 0;
    b.input.focus();

    expect(sent).toEqual(["pane: focus from=1 to=2"]);
  });

  it("로그가 꺼져 있으면 포커스 리스너도 없다", () => {
    const target = document.createElement("div");
    document.body.append(target);
    const spy = vi.spyOn(target, "addEventListener");

    logging.installFrontEndLogging(settings(false), target);
    focusTo(document.body, null);

    expect(spy).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
