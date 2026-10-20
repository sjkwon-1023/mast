// Windows 한글 입력 상태기계 (windows-ime.ts) — DOM 없이 이벤트 순서만으로 확인한다.

import { describe, expect, it } from "vitest";
import { WindowsImeState } from "./windows-ime";

function state(): { ime: WindowsImeState; sent: string[] } {
  const sent: string[] = [];
  return { ime: new WindowsImeState((data) => sent.push(data)), sent };
}

const IME = { keyCode: 229 };

describe("WindowsImeState", () => {
  it("compositionend 의 data 를 그대로 보낸다", () => {
    const { ime, sent } = state();
    expect(ime.keydown(IME)).toBe("block");
    ime.compositionStart();
    ime.compositionUpdate("ㅈ");
    ime.compositionUpdate("조");
    ime.compositionUpdate("좆");
    ime.compositionEnd("조");
    ime.compositionStart();
    ime.compositionUpdate("자");
    ime.compositionEnd("자");
    expect(sent).toEqual(["조", "자"]);
  });

  it("빈 end(조합 취소)는 아무것도 보내지 않는다", () => {
    const { ime, sent } = state();
    ime.compositionStart();
    ime.compositionUpdate("ㄱ");
    ime.compositionUpdate("");
    ime.compositionEnd("");
    expect(sent).toEqual([]);
  });

  it("조합 중 비-229 키는 마지막 update 를 먼저 보내고 그 조합의 end 는 다시 보내지 않는다", () => {
    const { ime, sent } = state();
    ime.compositionStart();
    ime.compositionUpdate("도");
    expect(ime.keydown({ keyCode: 13 })).toBe("pass");
    expect(sent).toEqual(["도"]);
    expect(ime.pendingText()).toBe("");
    ime.compositionEnd("도");
    expect(sent).toEqual(["도"]);
    // 다음 조합은 다시 정상이다.
    ime.compositionStart();
    ime.compositionUpdate("가");
    ime.compositionEnd("가");
    expect(sent).toEqual(["도", "가"]);
  });

  it("Shift·Control·Alt·CapsLock 단독은 조합을 끊지 않는다", () => {
    const { ime, sent } = state();
    ime.compositionStart();
    ime.compositionUpdate("ㄲ");
    for (const keyCode of [16, 17, 18, 20]) expect(ime.keydown({ keyCode })).toBe("pass");
    expect(sent).toEqual([]);
    expect(ime.pendingText()).toBe("ㄲ");
  });

  it("조합 밖의 비-229 키와 flush 는 아무것도 보내지 않는다", () => {
    const { ime, sent } = state();
    expect(ime.keydown({ keyCode: 65 })).toBe("pass");
    ime.flush();
    expect(sent).toEqual([]);
  });

  it("flush 는 한 조합에 한 번만 보낸다", () => {
    const { ime, sent } = state();
    ime.compositionStart();
    ime.compositionUpdate("한");
    ime.flush();
    ime.flush();
    ime.keydown({ keyCode: 13 });
    expect(sent).toEqual(["한"]);
  });

  it("겹친 조합과 조합 밖의 end 도 IME 가 보고한 확정을 보낸다", () => {
    // 2026-10-19 현장 로그: end 전에 새 start, 닫힌 뒤에 update 와 두 번째 end.
    const { ime, sent } = state();
    ime.compositionStart();
    ime.compositionUpdate("가");
    ime.compositionStart();
    ime.compositionUpdate("나");
    ime.compositionEnd("가");
    ime.compositionUpdate("나");
    ime.compositionEnd("나");
    expect(sent).toEqual(["가", "나"]);
  });

  it("미리보기는 열린 조합의 update 만 보여 준다", () => {
    const { ime } = state();
    expect(ime.pendingText()).toBe("");
    ime.compositionStart();
    ime.compositionUpdate("하");
    expect(ime.pendingText()).toBe("하");
    ime.compositionEnd("하");
    expect(ime.pendingText()).toBe("");
  });
});
