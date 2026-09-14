export type DiffTone = "context" | "added" | "removed" | "meta" | "gap";

export interface DiffRun {
  tone: DiffTone;
  text: string;
}

export interface DiffPresentation {
  mode: "comparison" | "unified";
  before: DiffRun[];
  after: DiffRun[];
  unified: DiffRun[];
  notice: string | null;
}

export const MAX_DIFF_LINES = 5000;

type SourceLine = {
  raw: string;
  body: string;
};

type BodyKind = "context" | "added" | "removed" | "marker";

type BodyEntry = {
  kind: Exclude<BodyKind, "marker">;
  raw: string;
  markers: string[];
};

type Hunk = {
  header: string;
  oldCount: number;
  newCount: number;
  oldSeen: number;
  newSeen: number;
  entries: BodyEntry[];
};

type Event =
  | { kind: "meta"; raw: string }
  | { kind: "hunk"; header: string; entries: BodyEntry[] };

type ParsedPatch = {
  events: Event[];
  sawHunk: boolean;
  malformed: boolean;
  combined: boolean;
  unknownOutsideHunk: boolean;
};

type HunkRange = {
  oldCount: number;
  newCount: number;
};

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function sourceLines(text: string): { lines: SourceLine[]; capped: boolean } {
  const raws: string[] = [];
  let start = 0;

  while (start < text.length && raws.length < MAX_DIFF_LINES) {
    const end = text.indexOf("\n", start);
    if (end < 0) {
      raws.push(text.slice(start));
      start = text.length;
      break;
    }
    raws.push(text.slice(start, end + 1));
    start = end + 1;
  }

  const lines = raws.map((raw) => {
    let body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (body.endsWith("\r")) body = body.slice(0, -1);
    return { raw, body };
  });
  return { lines, capped: start < text.length };
}

function appendRun(runs: DiffRun[], tone: DiffTone, text: string): void {
  if (text.length === 0) return;
  const previous = runs[runs.length - 1];
  if (previous?.tone === tone) {
    previous.text += text;
  } else {
    runs.push({ tone, text });
  }
}

function unsignedDecimal(value: string): number | null {
  if (value.length === 0 || value.length > 16) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseHunkHeader(body: string): HunkRange | null {
  const match = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: (.*))?$/.exec(body);
  if (match === null) return null;

  const oldStart = unsignedDecimal(match[1]);
  const newStart = unsignedDecimal(match[3]);
  const oldCount = unsignedDecimal(match[2] ?? "1");
  const newCount = unsignedDecimal(match[4] ?? "1");
  if (oldStart === null || newStart === null || oldCount === null || newCount === null) {
    return null;
  }
  if ((oldStart === 0 && oldCount !== 0) || (newStart === 0 && newCount !== 0)) {
    return null;
  }
  if (oldCount === 0 && newCount === 0) return null;
  return { oldCount, newCount };
}

function isCombinedHeader(body: string): boolean {
  return isCombinedDiffHeader(body) || isCombinedHunkHeader(body);
}

function isCombinedDiffHeader(body: string): boolean {
  return /^diff --(?:cc|combined)(?:\s|$)/.test(body);
}

function isCombinedHunkHeader(body: string): boolean {
  return /^@@@(?:\s|$)/.test(body);
}

function bodyKind(body: string): BodyKind | null {
  if (body === NO_NEWLINE_MARKER) return "marker";
  switch (body[0]) {
    case " ":
      return "context";
    case "+":
      return "added";
    case "-":
      return "removed";
    default:
      return null;
  }
}

function isFileHeader(body: string): boolean {
  return body === "---" || body.startsWith("--- ") || body === "+++" || body.startsWith("+++ ");
}

function isMetadataLine(body: string): boolean {
  return (
    body.startsWith("diff --git ") ||
    body.startsWith("diff --no-index ") ||
    isCombinedHeader(body) ||
    body.startsWith("index ") ||
    isFileHeader(body) ||
    body.startsWith("new file mode ") ||
    body.startsWith("deleted file mode ") ||
    body.startsWith("old mode ") ||
    body.startsWith("new mode ") ||
    body.startsWith("similarity index ") ||
    body.startsWith("dissimilarity index ") ||
    body.startsWith("rename from ") ||
    body.startsWith("rename to ") ||
    body.startsWith("copy from ") ||
    body.startsWith("copy to ") ||
    body.startsWith("Binary files ") ||
    body === "GIT binary patch" ||
    body.startsWith("literal ") ||
    body.startsWith("delta ") ||
    body.startsWith("Submodule ") ||
    body.startsWith("Only in ") ||
    body.startsWith("Files ")
  );
}

function isBinaryMetadata(body: string): boolean {
  return (
    body.startsWith("Binary files ") ||
    body === "GIT binary patch" ||
    body.startsWith("literal ") ||
    body.startsWith("delta ")
  );
}

function parsePatch(lines: SourceLine[]): ParsedPatch {
  const events: Event[] = [];
  let hunk: Hunk | null = null;
  let sawHunk = false;
  let malformed = false;
  let completedHunk = false;
  let unknownOutsideHunk = false;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];

    if (hunk !== null) {
      const complete = hunk.oldSeen === hunk.oldCount && hunk.newSeen === hunk.newCount;
      if (complete) {
        const kind = bodyKind(line.body);
        if (kind === "marker") {
          const previous = hunk.entries[hunk.entries.length - 1];
          if (previous === undefined || previous.markers.length > 0) {
            malformed = true;
            break;
          }
          previous.markers.push(line.raw);
          index += 1;
          continue;
        }
        events.push({ kind: "hunk", header: hunk.header, entries: hunk.entries });
        hunk = null;
        completedHunk = true;
        continue;
      }

      const kind = bodyKind(line.body);
      if (kind === "marker") {
        const previous = hunk.entries[hunk.entries.length - 1];
        if (previous === undefined || previous.markers.length > 0) {
          malformed = true;
          break;
        }
        previous.markers.push(line.raw);
        index += 1;
        continue;
      }
      if (kind === null) {
        malformed = true;
        break;
      }

      const oldIncrement = kind === "context" || kind === "removed" ? 1 : 0;
      const newIncrement = kind === "context" || kind === "added" ? 1 : 0;
      if (
        hunk.oldSeen + oldIncrement > hunk.oldCount ||
        hunk.newSeen + newIncrement > hunk.newCount
      ) {
        malformed = true;
        break;
      }
      hunk.entries.push({ kind, raw: line.raw, markers: [] });
      hunk.oldSeen += oldIncrement;
      hunk.newSeen += newIncrement;
      index += 1;
      continue;
    }

    if (isCombinedHeader(line.body)) {
      return {
        events: [],
        sawHunk,
        malformed: false,
        combined: true,
        unknownOutsideHunk,
      };
    }
    const range = parseHunkHeader(line.body);
    if (range !== null) {
      hunk = {
        header: line.raw,
        oldCount: range.oldCount,
        newCount: range.newCount,
        oldSeen: 0,
        newSeen: 0,
        entries: [],
      };
      sawHunk = true;
      completedHunk = false;
      index += 1;
      continue;
    }
    if (line.body.startsWith("@@")) {
      malformed = true;
      break;
    }

    if (completedHunk && bodyKind(line.body) !== null && !isFileHeader(line.body)) {
      malformed = true;
      break;
    }
    if (line.body.length > 0 && !isMetadataLine(line.body)) {
      unknownOutsideHunk = true;
    }
    completedHunk = false;
    events.push({ kind: "meta", raw: line.raw });
    index += 1;
  }

  if (hunk !== null) {
    if (hunk.oldSeen !== hunk.oldCount || hunk.newSeen !== hunk.newCount) {
      malformed = true;
    } else {
      events.push({ kind: "hunk", header: hunk.header, entries: hunk.entries });
    }
  }
  return { events, sawHunk, malformed, combined: false, unknownOutsideHunk };
}

function renderChangeBlock(entries: BodyEntry[], before: DiffRun[], after: DiffRun[]): void {
  const removed = entries.filter((entry) => entry.kind === "removed");
  const added = entries.filter((entry) => entry.kind === "added");
  const rows = Math.max(removed.length, added.length);

  for (let index = 0; index < rows; index += 1) {
    const oldEntry = removed[index];
    const newEntry = added[index];
    if (oldEntry === undefined) {
      appendRun(before, "gap", "\n");
    } else {
      appendRun(before, "removed", oldEntry.raw);
      for (const marker of oldEntry.markers) appendRun(before, "context", marker);
    }
    if (newEntry === undefined) {
      appendRun(after, "gap", "\n");
    } else {
      appendRun(after, "added", newEntry.raw);
      for (const marker of newEntry.markers) appendRun(after, "context", marker);
    }
    const oldMarkers = oldEntry?.markers.length ?? 0;
    const newMarkers = newEntry?.markers.length ?? 0;
    if (oldMarkers > newMarkers) {
      appendRun(after, "gap", "\n".repeat(oldMarkers - newMarkers));
    } else if (newMarkers > oldMarkers) {
      appendRun(before, "gap", "\n".repeat(newMarkers - oldMarkers));
    }
  }
}

function renderComparison(events: Event[]): Pick<DiffPresentation, "before" | "after"> {
  const before: DiffRun[] = [];
  const after: DiffRun[] = [];
  for (const event of events) {
    if (event.kind === "meta") {
      appendRun(before, "meta", event.raw);
      appendRun(after, "meta", event.raw);
      continue;
    }

    appendRun(before, "meta", event.header);
    appendRun(after, "meta", event.header);
    const changes: BodyEntry[] = [];
    for (const entry of event.entries) {
      if (entry.kind === "context") {
        renderChangeBlock(changes, before, after);
        changes.length = 0;
        appendRun(before, "context", entry.raw);
        appendRun(after, "context", entry.raw);
        for (const marker of entry.markers) {
          appendRun(before, "context", marker);
          appendRun(after, "context", marker);
        }
      } else {
        changes.push(entry);
      }
    }
    renderChangeBlock(changes, before, after);
  }
  return { before, after };
}

function fallbackTone(
  line: SourceLine,
  inHunk: boolean,
  combined: boolean,
): DiffTone {
  if (!inHunk) return isMetadataLine(line.body) ? "meta" : "context";
  if (isCombinedHeader(line.body)) return "meta";
  if (combined || line.body === NO_NEWLINE_MARKER) return "context";
  switch (line.body[0]) {
    case "+":
      return "added";
    case "-":
      return "removed";
    default:
      return "context";
  }
}

function renderUnified(lines: SourceLine[], combined: boolean): DiffRun[] {
  const runs: DiffRun[] = [];
  let inHunk = false;
  let oldSeen = 0;
  let newSeen = 0;
  let oldCount = 0;
  let newCount = 0;

  for (const line of lines) {
    const range = parseHunkHeader(line.body);
    if (range !== null) {
      appendRun(runs, "meta", line.raw);
      inHunk = true;
      oldSeen = 0;
      newSeen = 0;
      oldCount = range.oldCount;
      newCount = range.newCount;
      continue;
    }
    if (isCombinedHunkHeader(line.body)) {
      appendRun(runs, "meta", line.raw);
      inHunk = true;
      oldSeen = 0;
      newSeen = 0;
      oldCount = Number.POSITIVE_INFINITY;
      newCount = Number.POSITIVE_INFINITY;
      continue;
    }
    if (isCombinedDiffHeader(line.body)) {
      inHunk = false;
      appendRun(runs, "meta", line.raw);
      continue;
    }

    if (!inHunk && isMetadataLine(line.body)) {
      appendRun(runs, "meta", line.raw);
      continue;
    }
    if (inHunk && line.body.startsWith("diff --")) {
      inHunk = false;
      appendRun(runs, "meta", line.raw);
      continue;
    }

    const tone = fallbackTone(line, inHunk, combined);
    appendRun(runs, tone, line.raw);

    if (!inHunk || combined) continue;
    const kind = bodyKind(line.body);
    if (kind === "context") {
      oldSeen += 1;
      newSeen += 1;
    } else if (kind === "removed") {
      oldSeen += 1;
    } else if (kind === "added") {
      newSeen += 1;
    }
    if (oldSeen >= oldCount && newSeen >= newCount) inHunk = false;
  }
  return runs;
}

function hasBinaryMetadata(lines: SourceLine[]): boolean {
  return lines.some((line) => isBinaryMetadata(line.body));
}

function hasPlainUnknown(lines: SourceLine[]): boolean {
  return lines.some((line) => line.body.length > 0 && !isMetadataLine(line.body));
}

function fallbackNotice(
  lines: SourceLine[],
  parsed: ParsedPatch,
  truncated: boolean,
  capped: boolean,
): string | null {
  if (truncated && capped) {
    return "diff is truncated and exceeds the 5,000-line display limit — showing unified text";
  }
  if (truncated) return "diff is truncated — showing unified text";
  if (capped) return "diff exceeds the 5,000-line display limit — showing unified text";
  if (parsed.combined) return "combined diff cannot be compared — showing unified text";
  if (parsed.malformed) return "diff is incomplete or malformed — showing unified text";
  if (parsed.unknownOutsideHunk) {
    return "diff contains unsupported text outside hunks — showing unified text";
  }
  if (hasBinaryMetadata(lines)) return "binary diff cannot be compared — showing unified text";
  if (!parsed.sawHunk && hasPlainUnknown(lines)) {
    return "diff has no textual hunks — showing unified text";
  }
  return null;
}

export function presentDiff(text: string, truncated = false): DiffPresentation {
  const extracted = sourceLines(text);
  const parsed = parsePatch(extracted.lines);
  const mustUseUnified =
    truncated ||
    extracted.capped ||
    parsed.combined ||
    parsed.malformed ||
    parsed.unknownOutsideHunk ||
    !parsed.sawHunk ||
    hasBinaryMetadata(extracted.lines);

  if (mustUseUnified) {
    return {
      mode: "unified",
      before: [],
      after: [],
      unified: renderUnified(extracted.lines, parsed.combined),
      notice: fallbackNotice(extracted.lines, parsed, truncated, extracted.capped),
    };
  }

  const comparison = renderComparison(parsed.events);
  return {
    mode: "comparison",
    before: comparison.before,
    after: comparison.after,
    unified: [],
    notice: null,
  };
}
