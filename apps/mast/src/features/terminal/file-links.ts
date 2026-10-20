// 터미널 출력의 파일 경로를 xterm 링크로 인식하고, Ctrl(Windows)·⌘(macOS)+클릭으로 뷰어를 연다 (D04).
// 인식은 순수 문자열 처리만 한다 — hover 와 출력 경로에서는 FS·IPC·Git 을 부르지 않는다.
import type { IBuffer, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { presentTerminalPath } from "../../infrastructure/backend";
import { IS_MAC } from "../../shared/platform";
import type { SessionId } from "../../shared/types";

// 한 논리 줄(soft-wrap 포함)과 후보 수의 상한이다. 넘으면 부분 경로를 잘라 만들지 않고 줄 전체에 링크를 만들지 않는다.
const MAX_LINE_BYTES = 16 * 1024;
const MAX_CANDIDATES = 64;

// 인용되지 않은 경로 끝에서 떼어 낸다 (F10). 인용 안쪽의 문자는 파일명의 일부다.
const TRAILING_PUNCTUATION = ".,;:)]}>'\"";
// 인용 앞에 붙는 여는 괄호 — `("a b.txt")` 처럼 감싼 인용을 경계로 본다.
const LEADING_OPENERS = "([{<";
// 여는 따옴표 바로 앞에 올 수 있는 글자 — 여는 괄호, 그리고 토큰 안의 `=`·`:` (`key="a b.md"`).
const QUOTE_PREFIXES = `${LEADING_OPENERS}=:`;
// 거부된 인용의 꼬리에서는 `/` 뒤의 따옴표도 연다 — `"src"/"my file.ts"` 의 두 번째 인용이 안쪽 단어를 새지 않게 한다.
const TAIL_QUOTE_PREFIXES = `${QUOTE_PREFIXES}/`;
const QUOTES = "'\"`";
// `scheme://` 로 시작하는 URI 범위 안의 경로는 파일이 아니다.
const URI_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g;
// 인용 뒤의 `:line[:col]` 과 인용 없는 경로 끝의 suffix. 값은 양의 정수여야 한다.
const SUFFIX_AT_START = /^:(\d+)(?::(\d+))?/;
const SUFFIX_AT_END = /:(\d+)(?::(\d+))?$/;

/** 경로 후보. `path` 는 suffix 를 뗀 원문이고, `start`·`end` 는 논리 줄 문자열의 [start, end) 구간이다. */
export interface PathCandidate {
  path: string;
  start: number;
  end: number;
}

/** 논리 줄 문자열에서 파일 경로 후보를 찾는다. 후보가 상한을 넘으면 빈 배열이다. */
export function findPathCandidates(line: string): PathCandidate[] {
  const uris = [...line.matchAll(URI_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const found: PathCandidate[] = [];
  let i = 0;
  while (i < line.length) {
    if (isSpace(line.charAt(i))) {
      i += 1;
      continue;
    }
    const wordEnd = findWordEnd(line, i);
    const open = findQuoteOpen(line, i, wordEnd);
    if (open === null) {
      const bare = scanBare(line, i, wordEnd);
      if (bare !== null) found.push(bare);
      i = wordEnd;
      continue;
    }
    const quoted = scanQuoted(line, open);
    // 짝이 없는 따옴표 뒤에서는 경로가 어디서 끝나는지 알 수 없다. 줄의 나머지에는 링크를 만들지 않는다.
    if (quoted === null) break;
    if (quoted.candidate !== null) found.push(quoted.candidate);
    i = quoted.end;
  }
  const kept = found.filter((c) => !uris.some((u) => c.start < u.end && u.start < c.end));
  return kept.length > MAX_CANDIDATES ? [] : kept;
}

interface QuotedScan {
  /** 인용이 받아들여졌을 때만 후보다. */
  candidate: PathCandidate | null;
  /** 다음 스캔의 시작 위치. 받아들여졌든 거부됐든 인용 구간은 건너뛴다. */
  end: number;
}

/**
 * 여는 따옴표 `open` 부터 짝이 맞는 닫는 따옴표까지 읽는다. 짝이 없으면 null 이다.
 * 거부된 인용의 꼬리(`"docs"/notes.md` 의 `/notes.md`)를 독립 후보로 보지 않도록 꼬리를 건너뛴다.
 */
function scanQuoted(line: string, open: number): QuotedScan | null {
  const close = line.indexOf(line.charAt(open), open + 1);
  if (close < 0) return null;
  const path = line.slice(open + 1, close);
  const end = quotedEnd(line, close + 1);
  if (end === null || !isQuotedPath(path)) return { candidate: null, end: rejectedTailEnd(line, close + 1) };
  return { candidate: { path, start: open, end }, end };
}

/**
 * 거부된 인용의 꼬리가 끝나는 위치다. `afterClose` 는 닫는 따옴표 뒤다. 꼬리 안에서 여는 인용은 그 짝까지 넓히고
 * 다시 단어 끝까지 읽는다. 짝이 없으면 그 줄의 나머지 스캔을 끝내도록 줄 끝을 돌려준다.
 */
function rejectedTailEnd(line: string, afterClose: number): number {
  let from = afterClose;
  let wordEnd = findWordEnd(line, from);
  for (;;) {
    const open = findQuoteOpen(line, from, wordEnd, TAIL_QUOTE_PREFIXES);
    if (open === null) return wordEnd;
    const pair = line.indexOf(line.charAt(open), open + 1);
    if (pair < 0) return line.length;
    from = pair + 1;
    // 짝이 단어 끝 안에 머무는 동안 단어 끝은 그대로다. 넘은 뒤에만 다시 구해 꼬리 길이에 선형으로 둔다.
    if (from > wordEnd) wordEnd = findWordEnd(line, from);
  }
}

/** 닫는 따옴표 뒤의 `:line[:col]` 까지 읽은 끝 위치. suffix 가 잘못됐거나 경계가 아니면 null 이다. */
function quotedEnd(line: string, afterClose: number): number | null {
  let end = afterClose;
  if (line.charAt(end) === ":") {
    const suffix = SUFFIX_AT_START.exec(line.slice(end));
    if (suffix !== null) {
      if (!isPositiveSuffix(suffix)) return null;
      end += suffix[0].length;
    } else if (!isBoundary(line.charAt(end + 1))) {
      // `:` 뒤에 숫자 없이 글자가 붙으면 잘못된 suffix 다. `:` 뒤가 문장 경계면 문장부호다.
      return null;
    }
  }
  return isBoundary(line.charAt(end)) ? end : null;
}

/** 단어 [from, wordEnd) 안에서 여는 따옴표의 위치. 앞이 경계일 때만 연다 — `it's` 의 apostrophe 는 열지 않는다. */
function findQuoteOpen(line: string, from: number, wordEnd: number, prefixes = QUOTE_PREFIXES): number | null {
  for (let k = from; k < wordEnd; k += 1) {
    if (!QUOTES.includes(line.charAt(k))) continue;
    if (k === 0 || isSpace(line.charAt(k - 1)) || prefixes.includes(line.charAt(k - 1))) return k;
  }
  return null;
}

function isBoundary(ch: string): boolean {
  return ch === "" || isSpace(ch) || TRAILING_PUNCTUATION.includes(ch);
}

function scanBare(line: string, start: number, wordEnd: number): PathCandidate | null {
  let s = start;
  while (s < wordEnd && LEADING_OPENERS.includes(line.charAt(s))) s += 1;
  let e = wordEnd;
  while (e > s && TRAILING_PUNCTUATION.includes(line.charAt(e - 1))) e -= 1;

  const token = line.slice(s, e);
  const suffix = SUFFIX_AT_END.exec(token);
  if (suffix !== null && !isPositiveSuffix(suffix)) return null;
  const body = suffix === null ? token : token.slice(0, suffix.index);
  // 인용 없는 경로에는 콜론과 따옴표가 들어갈 수 없다. 남은 콜론은 잘못된 suffix 다.
  if (body.includes(":") || /["'`]/.test(body) || !isPathShape(body)) return null;
  return { path: body, start: s, end: e };
}

function findWordEnd(line: string, from: number): number {
  let j = from;
  while (j < line.length && !isSpace(line.charAt(j))) j += 1;
  return j;
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

function isPositiveSuffix(match: RegExpExecArray): boolean {
  return Number(match[1]) >= 1 && (match[2] === undefined || Number(match[2]) >= 1);
}

// 인용 안은 이름 형태를 요구하지 않는다 (`"LICENSE"`, `"My Folder"`). 빈 값·앞뒤 공백·금지 형태만 거른다.
function isQuotedPath(path: string): boolean {
  return path.length > 0 && path.trim() === path && !/[\r\n]/.test(path) && !hasForbiddenForm(path);
}

// 지원하는 형태만 통과시킨다. Windows 경로·UNC(백슬래시)·`~`·`$` 확장은 평가하지 않으므로 여기서 거른다.
function isPathShape(path: string): boolean {
  if (hasForbiddenForm(path)) return false;
  if (path.startsWith("/")) return /[^/]/.test(path);
  if (path.startsWith("./") || path.startsWith("../")) {
    return /[^/]/.test(path.replace(/^(\.\.?\/)+/, ""));
  }
  return path.includes("/") || hasFileExtension(path);
}

function hasForbiddenForm(path: string): boolean {
  return path.includes("\\") || path.startsWith("~") || path.includes("$");
}

function hasFileExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /[^.]\.[A-Za-z][A-Za-z0-9]*$/.test(name);
}

interface LineCell {
  /** 1-based 버퍼 행 번호. */
  row: number;
  /** 0-based 열. */
  x: number;
  width: number;
}

interface LogicalLine {
  text: string;
  /** text 의 UTF-16 단위마다, 그 글자가 놓인 셀의 인덱스. */
  cellOf: number[];
  cells: LineCell[];
}

/** `y`(1-based 버퍼 행)가 속한 논리 줄을 셀 좌표와 함께 읽는다. 상한을 넘으면 null 이다. */
function readLogicalLine(buffer: IBuffer, y: number): LogicalLine | null {
  let first = y - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped === true) first -= 1;
  // 첫 행이 아직 wrap 표식이면 줄 앞부분이 scrollback 에서 밀려난 것이다. xterm 은 가득 찬 버퍼의 첫 행을
  // 재활용해도 표식을 지우지 않으므로, 앞이 잘린 논리 줄에서는 링크를 만들지 않는다.
  if (buffer.getLine(first)?.isWrapped === true) return null;

  const scratch = buffer.getNullCell();
  const cells: LineCell[] = [];
  const cellOf: number[] = [];
  let text = "";
  for (let r = first; ; r += 1) {
    const line = buffer.getLine(r);
    if (line === undefined) break;
    const continues = buffer.getLine(r + 1)?.isWrapped === true;
    for (let x = 0; x < line.length; x += 1) {
      line.getCell(x, scratch);
      const width = scratch.getWidth();
      // 넓은 글자의 뒤 칸은 앞 칸의 일부다.
      if (width === 0) continue;
      let chars = scratch.getChars();
      if (chars === "") {
        // 넓은 글자가 행 끝에 못 들어가 다음 행으로 넘어가면 이 칸은 글자가 없는 자리다. 공백으로 세면 경로가 끊긴다.
        if (continues && x === line.length - 1) continue;
        chars = " ";
      }
      const index = cells.length;
      cells.push({ row: r + 1, x, width });
      text += chars;
      for (let k = 0; k < chars.length; k += 1) cellOf.push(index);
    }
    // 셀 수는 UTF-8 바이트 수의 하한이라 이 값이 넘으면 바이트 상한도 넘는다.
    if (cells.length > MAX_LINE_BYTES) return null;
    if (!continues) break;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_LINE_BYTES) return null;
  return { text, cellOf, cells };
}

/** 파일 링크의 활성화 조건 — 앱이 마우스를 추적하지 않을 때, 플랫폼 수정 키와 함께 한 클릭만이다. */
export function shouldOpenFile(
  mouseTrackingMode: string,
  event: Pick<MouseEvent, "ctrlKey" | "metaKey">,
  mac = IS_MAC,
): boolean {
  if (mouseTrackingMode !== "none") return false;
  return mac ? event.metaKey : event.ctrlKey;
}

/** 백엔드 실패는 `{code, message}` 로 reject 된다. message 는 사용자에게 보일 영어 문장이다. */
function describeOpenError(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return `Command failed: ${String(err)}`;
}

/** 터미널 한 개의 파일 경로 링크 제공자. 활성화 1회는 `presentTerminalPath` 1회다. */
export function createFileLinkProvider(
  term: Terminal,
  session: SessionId,
  onError: (message: string) => void,
  mac = IS_MAC,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const logical = readLogicalLine(term.buffer.active, y);
      if (logical === null) {
        callback(undefined);
        return;
      }
      const links: ILink[] = [];
      for (const candidate of findPathCandidates(logical.text)) {
        const first = logical.cells[logical.cellOf[candidate.start]];
        const last = logical.cells[logical.cellOf[candidate.end - 1]];
        // 이 행에 걸친 링크만 돌려준다. 여러 행에 걸친 링크는 각 행에서 같은 범위로 나온다.
        if (first.row > y || last.row < y) continue;
        const path = candidate.path;
        links.push({
          // 범위의 끝은 1-based 로 포함한다. 넓은 글자는 두 칸을 모두 덮는다.
          range: {
            start: { x: first.x + 1, y: first.row },
            end: { x: last.x + last.width, y: last.row },
          },
          text: logical.text.slice(candidate.start, candidate.end),
          activate: (event: MouseEvent) => {
            if (!shouldOpenFile(term.modes.mouseTrackingMode, event, mac)) return;
            void presentTerminalPath(session, path).catch((err: unknown) => onError(describeOpenError(err)));
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}
