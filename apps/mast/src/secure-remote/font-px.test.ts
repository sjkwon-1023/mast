// Secure Remote 글자 크기 store 의 계약 — 페이지 안(모듈 수명)에서는 유지되고
// 새로고침(새 store)에는 돌아간다. browser storage 접근이 없다는 사실은 산출물
// 검사가 잠그고, 여기서는 값의 수명만 본다.

import { describe, expect, it } from "vitest";

import { createMemoryFontPxStore } from "./font-px";

describe("createMemoryFontPxStore", () => {
  it("starts empty so a first TabView falls back to the default size", () => {
    expect(createMemoryFontPxStore().load()).toBeNull();
  });

  it("keeps the saved size for the next TabView in the same page", () => {
    const store = createMemoryFontPxStore();
    store.save(18);
    expect(store.load()).toBe(18);
  });

  it("starts empty again for a fresh page (new store)", () => {
    const previous = createMemoryFontPxStore();
    previous.save(20);
    expect(createMemoryFontPxStore().load()).toBeNull();
  });
});
