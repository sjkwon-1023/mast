// folderBrowser 뷰의 순수 계산 검증 (21단계 청크 C1) — dirs-first 정렬, `..` 행
// 유무와 부모 경로 계산, 자식 절대 경로 조립, 크기 표기, 파일 클릭의 확장자
// 라우팅(청크 D), 키보드 탐색의 선택 이동·키 판정(체크포인트 2). DOM·IPC 는 이
// 파일의 대상이 아니다 (뷰는 이 결과를 그대로 그리는 얇은 층이다).

import { describe, expect, it } from "vitest";

import {
  PAGE_ROWS,
  folderKeyAction,
  folderRows,
  formatSize,
  joinPath,
  moveSelection,
  parentPath,
  sortEntries,
  viewerTabForPath,
} from "./folder-view";
import type { DirEntry } from "./backend";
import type { KeySpec } from "./keys";

function entry(name: string, is_dir: boolean, size: number | null = null): DirEntry {
  return { name, is_dir, size };
}

describe("sortEntries", () => {
  it("puts directories first and sorts each group by name", () => {
    const sorted = sortEntries([
      entry("readme.md", false, 10),
      entry("src", true),
      entry("Cargo.toml", false, 20),
      entry("docs", true),
    ]);
    expect(sorted.map((e) => e.name)).toEqual(["docs", "src", "Cargo.toml", "readme.md"]);
  });

  it("compares case-insensitively with a deterministic code-point tiebreak", () => {
    const sorted = sortEntries([
      entry("b.txt", false),
      entry("A.txt", false),
      entry("a.txt", false),
    ]);
    // 대소문자 무시가 1차 — "A.txt"/"a.txt" 는 같은 키라 코드포인트로 갈린다.
    expect(sorted.map((e) => e.name)).toEqual(["A.txt", "a.txt", "b.txt"]);
  });

  it("does not mutate the input", () => {
    const input = [entry("b", false), entry("a", true)];
    sortEntries(input);
    expect(input.map((e) => e.name)).toEqual(["b", "a"]);
  });
});

describe("parentPath", () => {
  it("drops the last component", () => {
    expect(parentPath("/home/u/project")).toBe("/home/u");
    expect(parentPath("/home")).toBe("/");
  });

  it("returns null at the root", () => {
    expect(parentPath("/")).toBeNull();
    // 빈 세그먼트만 있는 표기도 루트다 (코어 wslpath 의 정규화 규칙과 동일 취급).
    expect(parentPath("//")).toBeNull();
  });

  it("ignores empty segments so the result never contains '..'", () => {
    expect(parentPath("/home/u/")).toBe("/home");
    expect(parentPath("/home//u")).toBe("/home");
  });
});

describe("joinPath", () => {
  it("joins without doubling the separator", () => {
    expect(joinPath("/home/u", "src")).toBe("/home/u/src");
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/home/u/", "src")).toBe("/home/u/src");
  });
});

describe("folderRows", () => {
  it("prepends a '..' row outside the root and resolves absolute child paths", () => {
    const rows = folderRows("/home/u", [entry("notes.txt", false, 1024), entry("src", true)]);
    expect(rows).toEqual([
      { label: "..", path: "/home", isDir: true, size: null, parent: true },
      { label: "src/", path: "/home/u/src", isDir: true, size: null, parent: false },
      {
        label: "notes.txt",
        path: "/home/u/notes.txt",
        isDir: false,
        size: 1024,
        parent: false,
      },
    ]);
  });

  it("omits the '..' row at the root", () => {
    const rows = folderRows("/", [entry("etc", true)]);
    expect(rows.map((r) => r.label)).toEqual(["etc/"]);
    expect(rows[0].path).toBe("/etc");
  });

  it("keeps only the '..' row for an empty listing outside the root", () => {
    expect(folderRows("/home/u", []).map((r) => r.path)).toEqual(["/home"]);
    expect(folderRows("/", [])).toEqual([]);
  });
});

describe("viewerTabForPath", () => {
  it("routes markdown extensions to the markdown viewer", () => {
    expect(viewerTabForPath("/home/u/README.md")).toEqual({
      type: "markdownViewer",
      path: "/home/u/README.md",
    });
    expect(viewerTabForPath("/home/u/notes.markdown").type).toBe("markdownViewer");
    // 확장자 비교는 대소문자를 가리지 않는다.
    expect(viewerTabForPath("/home/u/READ.MD").type).toBe("markdownViewer");
  });

  it("routes everything else to the text viewer", () => {
    expect(viewerTabForPath("/var/log/syslog")).toEqual({
      type: "textViewer",
      path: "/var/log/syslog",
    });
    expect(viewerTabForPath("/home/u/main.rs").type).toBe("textViewer");
    // `.md` 를 담은 이름이지 확장자가 아닌 경우.
    expect(viewerTabForPath("/home/u/notes.md.bak").type).toBe("textViewer");
    expect(viewerTabForPath("/home/u/mdfile").type).toBe("textViewer");
  });

  it("treats a leading dot as a dotfile marker, not an extension", () => {
    // 이름이 통째로 ".md" 인 파일 — 확장자가 없는 dotfile 이므로 텍스트로 연다.
    expect(viewerTabForPath("/home/u/.md").type).toBe("textViewer");
    expect(viewerTabForPath("/home/u/.bashrc").type).toBe("textViewer");
    // 반대로 dotfile 에 확장자가 붙으면 그 확장자가 이긴다.
    expect(viewerTabForPath("/home/u/.hidden.md").type).toBe("markdownViewer");
  });

  it("does not read the extension from a parent directory name", () => {
    expect(viewerTabForPath("/home/u/docs.md/plain").type).toBe("textViewer");
  });
});

describe("moveSelection", () => {
  it("moves one row at a time and stops at both ends (no wraparound)", () => {
    expect(moveSelection(0, 5, "down")).toBe(1);
    expect(moveSelection(4, 5, "down")).toBe(4);
    expect(moveSelection(1, 5, "up")).toBe(0);
    expect(moveSelection(0, 5, "up")).toBe(0);
  });

  it("jumps to the first and last row", () => {
    expect(moveSelection(3, 5, "home")).toBe(0);
    expect(moveSelection(3, 5, "end")).toBe(4);
    expect(moveSelection(0, 1, "end")).toBe(0);
  });

  it("pages by PAGE_ROWS and clamps at the ends", () => {
    expect(moveSelection(0, 100, "pageDown")).toBe(PAGE_ROWS);
    expect(moveSelection(PAGE_ROWS, 100, "pageUp")).toBe(0);
    // 남은 행이 한 페이지보다 적으면 끝 행까지만 간다.
    expect(moveSelection(95, 100, "pageDown")).toBe(99);
    expect(moveSelection(4, 100, "pageUp")).toBe(0);
    // 목록이 한 페이지보다 짧아도 범위를 벗어나지 않는다.
    expect(moveSelection(0, 3, "pageDown")).toBe(2);
    expect(moveSelection(2, 3, "pageUp")).toBe(0);
  });

  it("has no selection in an empty list", () => {
    for (const move of ["up", "down", "home", "end", "pageUp", "pageDown"] as const) {
      expect(moveSelection(-1, 0, move)).toBe(-1);
      // 선택 인덱스가 남아 있어도(목록이 방금 비었어도) 결과는 선택 없음이다.
      expect(moveSelection(3, 0, move)).toBe(-1);
    }
  });

  it("selects the first row from 'no selection' (End picks the last)", () => {
    expect(moveSelection(-1, 5, "down")).toBe(0);
    expect(moveSelection(-1, 5, "up")).toBe(0);
    expect(moveSelection(-1, 5, "pageDown")).toBe(0);
    expect(moveSelection(-1, 5, "end")).toBe(4);
  });

  it("clamps an out-of-range index back into the list", () => {
    expect(moveSelection(9, 5, "down")).toBe(4);
    expect(moveSelection(9, 5, "up")).toBe(3);
  });
});

describe("folderKeyAction", () => {
  function key(k: string, mods: Partial<KeySpec> = {}): KeySpec {
    return { key: k, ctrl: false, alt: false, shift: false, isComposing: false, ...mods };
  }

  it("maps the navigation keys to selection moves", () => {
    expect(folderKeyAction(key("ArrowDown"))).toEqual({ type: "move", move: "down" });
    expect(folderKeyAction(key("ArrowUp"))).toEqual({ type: "move", move: "up" });
    expect(folderKeyAction(key("Home"))).toEqual({ type: "move", move: "home" });
    expect(folderKeyAction(key("End"))).toEqual({ type: "move", move: "end" });
    expect(folderKeyAction(key("PageUp"))).toEqual({ type: "move", move: "pageUp" });
    expect(folderKeyAction(key("PageDown"))).toEqual({ type: "move", move: "pageDown" });
  });

  it("maps Enter to open and Backspace to the parent directory", () => {
    expect(folderKeyAction(key("Enter"))).toEqual({ type: "open" });
    expect(folderKeyAction(key("Backspace"))).toEqual({ type: "parent" });
  });

  it("ignores every modified combination", () => {
    // Alt+방향키는 전역 pane 이동(keys.ts) 소유다 — 뷰가 가로채면 뷰어 탭에서만
    // 이동이 죽는다.
    expect(folderKeyAction(key("ArrowDown", { alt: true }))).toBeNull();
    expect(folderKeyAction(key("ArrowUp", { alt: true }))).toBeNull();
    expect(folderKeyAction(key("Enter", { ctrl: true }))).toBeNull();
    expect(folderKeyAction(key("ArrowDown", { shift: true }))).toBeNull();
    expect(folderKeyAction(key("Home", { ctrl: true }))).toBeNull();
  });

  it("ignores keys while an IME composition is in progress", () => {
    expect(folderKeyAction(key("Enter", { isComposing: true }))).toBeNull();
    expect(folderKeyAction(key("ArrowDown", { isComposing: true }))).toBeNull();
  });

  it("returns null for keys it does not own", () => {
    expect(folderKeyAction(key("ArrowLeft"))).toBeNull();
    expect(folderKeyAction(key("ArrowRight"))).toBeNull();
    expect(folderKeyAction(key("a"))).toBeNull();
    expect(folderKeyAction(key("Tab"))).toBeNull();
    expect(folderKeyAction(key("Escape"))).toBeNull();
  });
});

describe("formatSize", () => {
  it("formats bytes with 1024-based units", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(999)).toBe("999B");
    expect(formatSize(1024)).toBe("1.0K");
    expect(formatSize(1536)).toBe("1.5K");
    expect(formatSize(20 * 1024)).toBe("20K");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0M");
  });

  it("renders nothing for directories (null size)", () => {
    expect(formatSize(null)).toBe("");
  });
});
