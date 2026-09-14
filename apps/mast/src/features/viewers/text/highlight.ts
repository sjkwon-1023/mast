import type { LanguageFn } from "highlight.js";
import { DEFAULT_HIGHLIGHT_LANGUAGES } from "./settings";

export interface HighlightApi {
  highlight(
    code: string,
    options: { language: string; ignoreIllegals?: boolean },
  ): { value: string };
}

// 지원 언어 이름은 백엔드 commands.rs HIGHLIGHT_LANGUAGES와 함께 변경한다.
const LANGUAGE_LOADERS: Record<
  string,
  (() => Promise<{ default: LanguageFn }>) | undefined
> = {
  css: () => import("highlight.js/lib/languages/css"),
  html: () => import("highlight.js/lib/languages/xml"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  toml: () => import("highlight.js/lib/languages/ini"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
};

const EXTENSION_LANGUAGES: Record<string, string | undefined> = {
  cjs: "javascript",
  css: "css",
  cts: "typescript",
  htm: "html",
  html: "html",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  mjs: "javascript",
  mts: "typescript",
  py: "python",
  pyi: "python",
  pyw: "python",
  rs: "rust",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
};

// 동기 토큰화가 메인 스레드를 오래 점유하지 않도록 창보다 작은 상한을 둔다.
export const HIGHLIGHT_MAX_BYTES = 256 * 1024;

export function languageForPath(
  path: string,
  active: readonly string[] = DEFAULT_HIGHLIGHT_LANGUAGES,
): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const language = EXTENSION_LANGUAGES[base.slice(dot + 1).toLowerCase()];
  if (language === undefined) return null;
  return active.includes(language) ? language : null;
}

// 여러 행에 걸친 span을 행 끝에서 닫고 다음 행에서 다시 열어 독립된 HTML로 만든다.
export function splitHighlightedLines(html: string): string[] {
  const token = /<span [^>]*>|<\/span>|\n/g;
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  let last = 0;
  for (let match = token.exec(html); match !== null; match = token.exec(html)) {
    line += html.slice(last, match.index);
    last = token.lastIndex;
    const tag = match[0];
    if (tag === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (tag === "</span>") {
      open.pop();
      line += tag;
    } else {
      open.push(tag);
      line += tag;
    }
  }
  lines.push(line + html.slice(last));
  return lines;
}

// 여러 행에 걸친 문법을 보존하도록 창 전체를 한 번에 토큰화한다.
export function highlightLines(
  lines: readonly string[],
  language: string,
  hljs: HighlightApi,
): string[] | null {
  const html = hljs.highlight(lines.join("\n"), { language, ignoreIllegals: true }).value;
  const split = splitHighlightedLines(html);
  return split.length === lines.length ? split : null;
}

const highlighters = new Map<string, Promise<HighlightApi>>();

// 코어·언어·CSS는 사용 시에만 로드한다. 시작 번들에 정적으로 포함하지 않는다.
export async function loadHighlighter(language: string): Promise<HighlightApi> {
  const cached = highlighters.get(language);
  if (cached !== undefined) return cached;
  const load = LANGUAGE_LOADERS[language];
  if (load === undefined) {
    return Promise.reject(new Error(`no highlight module for language ${language}`));
  }
  const pending = (async (): Promise<HighlightApi> => {
    const [core, definition] = await Promise.all([
      import("highlight.js/lib/core"),
      load(),
      import("highlight.js/styles/vs2015.css"),
    ]);
    const hljs = core.default;
    hljs.registerLanguage(language, definition.default);
    return hljs;
  })();
  highlighters.set(language, pending);

  // 실패한 로드는 캐시에서 빼 다음 파일 열기에서 재시도한다.
  pending.catch(() => highlighters.delete(language));
  return pending;
}
