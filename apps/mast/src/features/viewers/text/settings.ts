import type { UiSettings } from "../../../infrastructure/backend";

export const DEFAULT_HIGHLIGHT_LANGUAGES: readonly string[] = [
  "python",
  "javascript",
  "typescript",
  "rust",
  "json",
  "toml",
  "css",
  "html",
];

export let highlightLanguages: readonly string[] = DEFAULT_HIGHLIGHT_LANGUAGES;

// 첫 뷰 생성 전에 적용한다. null은 기본값 유지, 빈 배열은 하이라이팅 끄기다.
export function applyHighlightSettings(settings: UiSettings): void {
  if (settings.highlightLanguages !== null)
    highlightLanguages = settings.highlightLanguages;
}
