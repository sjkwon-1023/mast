// @vitest-environment happy-dom
//
// 뷰어 글꼴 적용의 세 반쪽을 잠근다.
//
// 1. **TS 쪽 (설정)** — 설정이 있으면 :root 에 커스텀 프로퍼티를 심고, 없으면
//    **심지 않는다**(지운다). "없으면 심지 않는다"가 곧 "미설정이면 화면이
//    종전과 똑같다"의 근거라, 프로퍼티의 유무 자체가 계약이다.
// 2. **TS 쪽 (줌, v0.3.8)** — 줌은 세션 한정이고, 클램프는 터미널과 같은 6~72
//    정수이며, 살아 있는 뷰 레지스트리에 밀리고, 리셋은 settings 기준값으로
//    돌아간다. 등록/해제가 짝을 이루지 않으면 dispose 된 뷰가 계속 얻어맞으므로
//    해제도 같이 잠근다.
// 3. **CSS 쪽** — 그 fallback 이 실제로 종전 하드코딩 값인지, 그리고 변수를 읽는
//    셀렉터가 계약된 목록 그대로인지. happy-dom 은 var() fallback 을 계산해 주지
//    않으므로 계산 결과 대신 **스타일시트 원문**을 단언한다 — fallback 이 12px
//    아닌 값으로 바뀌거나(미설정 화면이 달라진다), 사이드바·탭바 같은 UI 크롬이
//    이 변수를 읽기 시작하면(범위 확장) 여기서 깨진다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_VIEWER_FONT_SIZE,
  adjustViewerFontSize,
  applyViewerFontSettings,
  registerViewerFontTarget,
  resetViewerFontSize,
  unregisterViewerFontTarget,
  viewerFontSize,
} from "./viewer-font";
import type { ViewerFontTarget } from "./viewer-font";
import type { UiSettings } from "./backend";

const FAMILY_VAR = "--viewer-font-family";
const SIZE_VAR = "--viewer-font-size";

function settings(fontFamily: string | null, fontSize: number | null): UiSettings {
  return { fontFamily, fontSize, highlightLanguages: null, log: null, remote: null };
}

function rootValue(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

describe("applyViewerFontSettings", () => {
  beforeEach(() => {
    // 미설정 상태로 되돌린다 — 이 함수가 total 이라 이것만으로 충분하다.
    applyViewerFontSettings(settings(null, null));
  });

  it("미설정이면 :root 에 아무 것도 심지 않는다 (CSS fallback 이 산다)", () => {
    expect(rootValue(FAMILY_VAR)).toBe("");
    expect(rootValue(SIZE_VAR)).toBe("");
    expect(viewerFontSize()).toBe(DEFAULT_VIEWER_FONT_SIZE);
  });

  it("설정이 있으면 :root 에 심는다 — 크기는 px 단위로", () => {
    applyViewerFontSettings(settings("Cascadia Code, monospace", 15));
    expect(rootValue(FAMILY_VAR)).toBe("Cascadia Code, monospace");
    expect(rootValue(SIZE_VAR)).toBe("15px");
    expect(viewerFontSize()).toBe(15);
  });

  it("한쪽만 설정하면 다른 쪽은 심기지 않는다", () => {
    applyViewerFontSettings(settings(null, 20));
    expect(rootValue(FAMILY_VAR)).toBe("");
    expect(rootValue(SIZE_VAR)).toBe("20px");
    expect(viewerFontSize()).toBe(20);

    applyViewerFontSettings(settings("Consolas", null));
    expect(rootValue(FAMILY_VAR)).toBe("Consolas");
    expect(rootValue(SIZE_VAR)).toBe("");
    expect(viewerFontSize()).toBe(DEFAULT_VIEWER_FONT_SIZE);
  });

  it("설정을 지우면 프로퍼티도 지워진다 (빈 값으로 남지 않는다)", () => {
    applyViewerFontSettings(settings("Consolas", 18));
    applyViewerFontSettings(settings(null, null));
    // 빈 문자열로 "설정됨" 상태가 되면 var() 의 fallback 이 발동하지 않으므로,
    // 값이 비었는지가 아니라 **선언 자체가 빠졌는지**를 본다.
    const inline = document.documentElement.getAttribute("style") ?? "";
    expect(inline).not.toContain(FAMILY_VAR);
    expect(inline).not.toContain(SIZE_VAR);
  });
});

// 뷰어 줌 (v0.3.8) — 종전의 "부팅 뒤에 다시 부르지 말 것" 지뢰를 해체한 경로다.
// 여기서 잠그는 것은 모듈 상태의 규칙(클램프·기준값·라이브 밀어내기)이고, 그
// 결과로 행 격자가 실제로 다시 앉는지는 뷰가 필요하므로 text-view.test.ts 몫이다.
describe("뷰어 줌", () => {
  /** 밀려온 크기를 기록만 하는 가짜 뷰 — 레지스트리 계약만 보면 되므로 DOM 이
   *  필요 없다 (실제 격자 재계산은 text-view.test.ts 가 본다). */
  function target(): ViewerFontTarget & { sizes: number[] } {
    const sizes: number[] = [];
    return { sizes, setViewerFontSize: (size) => sizes.push(size) };
  }

  beforeEach(() => {
    applyViewerFontSettings(settings(null, null));
  });

  // 모듈 상태는 이 describe 를 벗어나서도 남는다 — 나갈 때 되돌려 파일 안 실행
  // 순서에 무관하게 만든다 (text-view.test.ts 의 같은 관례).
  afterEach(() => {
    applyViewerFontSettings(settings(null, null));
  });

  it("줌은 기본 크기에서 ±1px 씩 움직인다", () => {
    adjustViewerFontSize(1);
    expect(viewerFontSize()).toBe(DEFAULT_VIEWER_FONT_SIZE + 1);
    adjustViewerFontSize(-1);
    expect(viewerFontSize()).toBe(DEFAULT_VIEWER_FONT_SIZE);
  });

  it("줌은 settings 값에서 출발한다", () => {
    applyViewerFontSettings(settings(null, 20));
    adjustViewerFontSize(1);
    expect(viewerFontSize()).toBe(21);
  });

  it("클램프는 터미널과 같은 6~72 다", () => {
    applyViewerFontSettings(settings(null, 72));
    adjustViewerFontSize(1);
    expect(viewerFontSize()).toBe(72);

    applyViewerFontSettings(settings(null, 6));
    adjustViewerFontSize(-1);
    expect(viewerFontSize()).toBe(6);
  });

  it("줌은 :root 에 현재 크기를 심는다 (미설정이었어도)", () => {
    expect(rootValue(SIZE_VAR)).toBe("");
    adjustViewerFontSize(3);
    expect(rootValue(SIZE_VAR)).toBe("15px");
    // family 는 줌의 대상이 아니다 — 미설정이면 미설정으로 남는다.
    expect(rootValue(FAMILY_VAR)).toBe("");
  });

  it("리셋은 settings 기준값으로 돌아간다 (미설정이면 기본값)", () => {
    applyViewerFontSettings(settings(null, 16));
    adjustViewerFontSize(4);
    expect(viewerFontSize()).toBe(20);
    resetViewerFontSize();
    expect(viewerFontSize()).toBe(16);
    expect(rootValue(SIZE_VAR)).toBe("16px");

    applyViewerFontSettings(settings(null, null));
    adjustViewerFontSize(4);
    resetViewerFontSize();
    expect(viewerFontSize()).toBe(DEFAULT_VIEWER_FONT_SIZE);
  });

  it("등록된 뷰에 새 크기가 밀린다 — 무변경 호출은 밀지 않는다", () => {
    const view = target();
    registerViewerFontTarget(view);
    adjustViewerFontSize(1);
    adjustViewerFontSize(1);
    expect(view.sizes).toEqual([13, 14]);

    // 경계에 걸려 값이 그대로면 재적용도 없다 (무변경 재렌더 낭비 금지).
    applyViewerFontSettings(settings(null, 72));
    view.sizes.length = 0;
    adjustViewerFontSize(1);
    expect(view.sizes).toEqual([]);

    unregisterViewerFontTarget(view);
  });

  it("해제한 뷰에는 더 이상 밀지 않는다 (dispose 짝)", () => {
    const view = target();
    registerViewerFontTarget(view);
    adjustViewerFontSize(1);
    unregisterViewerFontTarget(view);
    adjustViewerFontSize(1);
    resetViewerFontSize();
    expect(view.sizes).toEqual([13]);
  });

  it("설정 재적용은 줌을 기준값으로 되감고 살아있는 뷰에 밀어 준다", () => {
    const view = target();
    registerViewerFontTarget(view);
    adjustViewerFontSize(5);
    view.sizes.length = 0;

    applyViewerFontSettings(settings(null, 14));
    expect(viewerFontSize()).toBe(14);
    expect(view.sizes).toEqual([14]);

    unregisterViewerFontTarget(view);
  });
});

describe("styles.css 의 뷰어 글꼴 계약", () => {
  /** 주석을 걷어낸 스타일시트 원문 — 주석 안의 변수 언급이 아래 판정에 섞이지
   *  않게 한다 (설명 주석이 변수 이름을 그대로 적고 있다).
   *
   *  파일을 직접 읽는 이유: vitest 는 CSS import 를 빈 모듈로 지워버려(`css:
   *  false` 기본값) `?raw` 로도 원문이 오지 않는다. 경로는 실행 cwd 가 아니라 이
   *  파일 자신에서 잡는다. */
  const css = readFileSync(
    fileURLToPath(import.meta.url).replace(/[^/\\]+$/, "styles.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /** `selector { body }` 쌍 (이 스타일시트는 @media 등 중첩 at-rule 이 없다). */
  function rules(): { selector: string; body: string }[] {
    const out: { selector: string; body: string }[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let match = re.exec(css);
    while (match !== null) {
      out.push({ selector: match[1].trim(), body: match[2] });
      match = re.exec(css);
    }
    return out;
  }

  it("스타일시트는 두 변수를 선언하지 않는다 — 선언하면 fallback 이 죽는다", () => {
    for (const rule of rules()) {
      expect(rule.body).not.toMatch(new RegExp(`${FAMILY_VAR}\\s*:`));
      expect(rule.body).not.toMatch(new RegExp(`${SIZE_VAR}\\s*:`));
    }
  });

  it("fallback 은 종전 하드코딩 값 그대로다 (미설정 화면이 달라지지 않는다)", () => {
    // 변수를 읽는 모든 자리에 fallback 이 있어야 한다 — 빠진 자리는 설정이
    // 없을 때 상속값으로 떨어져 화면이 달라진다.
    const familyUses = [...css.matchAll(new RegExp(`var\\(\\s*${FAMILY_VAR}[^)]*\\)`, "g"))];
    const sizeUses = [...css.matchAll(new RegExp(`var\\(\\s*${SIZE_VAR}[^)]*\\)`, "g"))];
    expect(familyUses.length).toBeGreaterThan(0);
    expect(sizeUses.length).toBeGreaterThan(0);
    for (const [use] of familyUses) expect(use).toBe(`var(${FAMILY_VAR}, monospace)`);
    for (const [use] of sizeUses) {
      expect(use).toBe(`var(${SIZE_VAR}, ${DEFAULT_VIEWER_FONT_SIZE}px)`);
    }
  });

  it("변수를 읽는 곳은 뷰어 콘텐츠 표면뿐이다 (UI 크롬 비대상)", () => {
    const readers = rules()
      .filter((rule) => rule.body.includes("var(--viewer-font-"))
      .map((rule) => rule.selector);
    expect(new Set(readers)).toEqual(
      new Set([
        ".text-lines",
        ".text-line",
        ".folder-row",
        ".folder-row-size",
        ".markdown-body",
        ".markdown-body code",
      ]),
    );
  });

  it("글꼴 family 는 마크다운 산문에 닿지 않는다 (크기만 따른다)", () => {
    // 줌은 콘텐츠 크기를 키우는 조작이라 산문도 커져야 하지만, 사용자가 고른
    // "코드 글꼴"이 산문까지 등폭으로 바꾸는 것은 v0.3.7 이 명시적으로 거부한
    // 범위다. 두 변수의 대상이 갈리는 유일한 자리라 따로 잠근다.
    const prose = rules().find((rule) => rule.selector === ".markdown-body");
    expect(prose?.body).toContain(`var(${SIZE_VAR}`);
    expect(prose?.body).not.toContain(FAMILY_VAR);
  });
});
