// @vitest-environment happy-dom
//
// 프론트 로그 배선 (logging.ts). 지키는 계약이 둘이다 — **꺼져 있으면 아무것도
// 설치하지 않는다**(켜지 않은 사용자가 타자마다 도는 핸들러 값을 내지 않는다)와
// **내용을 남기지 않는다**(글자 수·이름 있는 키만).
//
// 백엔드 IPC 는 vi.mock 으로 고정한다 — vi.mock 은 hoist 되므로 팩토리가 참조하는
// 것은 vi.hoisted 로 만든다 (text-view.test.ts 와 같은 관례).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { describeKey, installFrontEndLogging, isLogging, logSwallowedShortcut } from "./logging";
import type { UiSettings } from "./backend";

const sent = vi.hoisted(() => [] as string[]);

vi.mock("./backend", () => ({
  logLine: (text: string) => {
    sent.push(text);
    return Promise.resolve();
  },
}));

function settings(log: boolean | null): UiSettings {
  return { fontFamily: null, fontSize: null, highlightLanguages: null, log, remote: null };
}

/** 조합 이벤트 하나를 흘린다.
 *
 *  **happy-dom 에는 `CompositionEvent` 가 없다** — `window.CompositionEvent` 는 그냥
 *  `Event` 로 떨어지고 `data` init 은 조용히 버려진다 (확인함). 그래서 여기서 직접
 *  `data` 를 얹는다. 실제 코드가 읽는 것도 그 프로퍼티 하나뿐이라 계약은 같다. */
function composition(target: EventTarget, type: string, data: string): void {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, "data", { value: data });
  target.dispatchEvent(ev);
}

describe("logging", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("이름 있는 키만 그대로 남기고 인쇄 가능한 한 글자는 가린다", () => {
    expect(describeKey("ArrowLeft")).toBe("ArrowLeft");
    expect(describeKey("Tab")).toBe("Tab");
    // 사용자가 친 글자는 로그 파일에 남지 않는다 — 한글도 라틴 문자도 마찬가지.
    expect(describeKey("ㅁ")).toBe("(char)");
    expect(describeKey("a")).toBe("(char)");
  });

  it("꺼져 있으면 리스너를 설치하지 않는다", () => {
    const target = new EventTarget();
    const spy = vi.spyOn(target, "addEventListener");

    installFrontEndLogging(settings(null), target);
    installFrontEndLogging(settings(false), target);

    expect(spy).not.toHaveBeenCalled();
    expect(isLogging()).toBe(false);
    composition(target, "compositionstart", "ㅇ");
    expect(sent).toEqual([]);
  });

  it("켜면 조합의 세 단계를 글자 수만 담아 남긴다", () => {
    const target = document.createElement("div");
    document.body.append(target);

    installFrontEndLogging(settings(true), target);
    expect(isLogging()).toBe(true);

    composition(target, "compositionstart", "");
    composition(target, "compositionupdate", "이");
    composition(target, "compositionend", "이전");

    // 첫 줄은 켜졌다는 표시고, 그 뒤가 조합 세 단계다.
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
    // 켜진 상태는 앞 케이스가 만들어 둔다 (모듈 상태 — 끄는 경로는 없다).
    logSwallowedShortcut(
      new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }),
    );

    expect(sent.at(-1)).toBe(
      "ime: shortcut dropped while composing key=ArrowLeft ctrl=false alt=true shift=false",
    );
  });
});
