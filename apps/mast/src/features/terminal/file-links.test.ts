// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";

const h = vi.hoisted(() => ({
  presentTerminalPath: vi.fn(async (_session: number, _path: string) => ({
    workspace: 1,
    pane: 1,
    tab: 3,
    kind: "textViewer",
    path: _path,
    active: false,
  })),
  writeStdin: vi.fn(async (_session: number, _data: string) => undefined),
}));

vi.mock("../../infrastructure/backend", () => ({
  presentTerminalPath: h.presentTerminalPath,
  writeStdin: h.writeStdin,
  openUrl: vi.fn(async () => undefined),
  attachTerminal: vi.fn(async () => attachBody()),
  resizeTerminal: vi.fn(async () => undefined),
  detachTerminal: vi.fn(async () => undefined),
  ackOutput: vi.fn(async () => undefined),
  logLine: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((chunk: ArrayBuffer | Uint8Array) => void) | undefined;
  },
}));

import { createFileLinkProvider, findPathCandidates } from "./file-links";
import { TerminalView } from "./view";
import { attachBody, termOf } from "../../test-helpers";
import { IS_MAC } from "../../shared/platform";

const SESSION = 7;

async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, resolve));
}

// 테스트마다 새 터미널을 쓴다. DOM 없이 버퍼만 쓰는 xterm 이라 셀 좌표는 실제 엔진의 값이다.
function terminal(cols = 80): Terminal {
  return new Terminal({ cols, rows: 24 });
}

function linksAt(term: Terminal, y: number, mac = false, onError = vi.fn()): Promise<ILink[]> {
  const provider = createFileLinkProvider(term, SESSION, onError, mac);
  return new Promise((resolve) => provider.provideLinks(y, (links) => resolve(links ?? [])));
}

function paths(line: string): string[] {
  return findPathCandidates(line).map((c) => c.path);
}

describe("파일 경로 인식 (순수 문자열)", () => {
  it.each([
    ["/abs/dir/file.ts", "/abs/dir/file.ts"],
    ["./rel/a.ts", "./rel/a.ts"],
    ["../up/b.md", "../up/b.md"],
    ["src/a.ts", "src/a.ts"],
    ["README.md", "README.md"],
    ["src/a.ts:12", "src/a.ts"],
    ["src/a.ts:12:5", "src/a.ts"],
    ["(src/a.ts)", "src/a.ts"],
  ])("인용 없는 %s 는 경로 %s 로 인식한다", (input, expected) => {
    expect(paths(input)).toEqual([expected]);
  });

  it.each([
    ['"my file.md"', "my file.md"],
    ["'src/my file.md':12", "src/my file.md"],
    ["`src/a b.md`", "src/a b.md"],
    ['"a:b.txt"', "a:b.txt"],
    ['("src/a.ts")', "src/a.ts"],
    ['"my file.md": see below', "my file.md"],
  ])("인용 경로 %s 는 인용 안쪽을 경로로 쓴다", (input, expected) => {
    expect(paths(input)).toEqual([expected]);
  });

  it.each([".", ",", ";", ":", ")", "]", "}", ">", "'", '"'])(
    "인용 없는 경로 끝의 구두점 %s 는 떼어 낸다",
    (punct) => {
      expect(paths(`src/a.ts${punct}`)).toEqual(["src/a.ts"]);
    },
  );

  it("README.md. 와 src/a.ts:12) 처럼 구두점이 겹쳐도 경로만 남긴다", () => {
    expect(paths("README.md.")).toEqual(["README.md"]);
    expect(paths("src/a.ts:12)")).toEqual(["src/a.ts"]);
  });

  it("인용 없이 공백이 든 문자열은 그 전체를 경로로 만들지 않는다", () => {
    expect(paths("my file name.txt")).not.toContain("my file name.txt");
  });

  it.each([
    ["~/notes.md"],
    ["$HOME/notes.md"],
    ["C:\\Users\\a.md"],
    ["\\\\server\\share\\a.md"],
    ["https://example.com/docs/a.md"],
    ["see file:///tmp/a.md now"],
    ["hello"],
    ["src/a.ts:0"],
    ["src/a.ts:-1"],
    ["src/a.ts:a"],
    ['"src/a.ts":-1'],
    ['"src/a.ts":0'],
  ])("지원하지 않는 %s 는 링크를 만들지 않는다", (input) => {
    expect(paths(input)).toEqual([]);
  });

  it("후보가 64개를 넘으면 빈 결과다 (64개까지는 허용)", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.txt`).join(" ");
    expect(findPathCandidates(names(64))).toHaveLength(64);
    expect(findPathCandidates(names(65))).toEqual([]);
  });

  it.each([
    ['"LICENSE"', "LICENSE"],
    ["'Dockerfile'", "Dockerfile"],
    ["`Makefile`", "Makefile"],
    ['"My Folder"', "My Folder"],
    ['"src"', "src"],
    ['"docs/release notes"', "docs/release notes"],
  ])("확장자·슬래시가 없는 인용 %s 는 %s 로 인식한다", (input, expected) => {
    expect(paths(input)).toEqual([expected]);
  });

  it.each([
    ['key="a b.md"', "a b.md"],
    ['--file="docs/release notes.md"', "docs/release notes.md"],
    ['path="src/my file.md"', "src/my file.md"],
  ])("토큰 안의 = 뒤에서 여는 인용 %s 는 %s 로 인식한다", (input, expected) => {
    expect(paths(input)).toEqual([expected]);
  });

  it("인용 내부의 토큰은 독립 후보로 새지 않는다", () => {
    expect(paths('"my file.md backup"')).toEqual(["my file.md backup"]);
  });

  it.each([
    ['"~/a b.md"'],
    ['"$HOME/a b.md"'],
    ['"C:\\Users\\a b.md"'],
    ['"\\\\server\\share\\a b.md"'],
    ['"https://example.com/a b"'],
    ['""'],
    ['" "'],
    ['"a\nb.md"'],
  ])("금지 형태의 인용 %s 은 구간 전체를 버려 안쪽 단어를 링크로 만들지 않는다", (input) => {
    expect(paths(input)).toEqual([]);
  });

  it("짝이 맞지 않는 여는 따옴표 뒤의 줄에서는 부분 경로를 만들지 않는다", () => {
    expect(paths('"my file.md backup')).toEqual([]);
    expect(paths('"src/my file.md')).toEqual([]);
    expect(paths('src/a.ts "my file.md')).toEqual(["src/a.ts"]);
  });

  it.each([
    ['"docs"/notes.md', []],
    ['"src/"a.ts', []],
    ['"my dir"/file.ts', []],
    ['cp "a b"/c.txt dest/', ["dest/"]],
    ['"docs"/notes.md src/a.ts', ["src/a.ts"]],
  ])("닫는 따옴표 뒤가 경계가 아닌 거부된 인용 %s 의 꼬리는 독립 후보가 되지 않는다", (input, expected) => {
    expect(paths(input)).toEqual(expected);
  });

  it.each([
    ['key="a b"="c d.md"'],
    ['{"":"c d.md"}'],
    ['"src"/"my file.ts"'],
  ])("거부된 인용의 꼬리 안에서 열린 인용 %s 은 안쪽 단어를 링크로 만들지 않는다", (input) => {
    expect(paths(input)).toEqual([]);
  });

  it("거부된 인용의 꼬리에서 짝 없는 여는 따옴표는 그 줄의 나머지 링크를 끊는다", () => {
    expect(paths('"src"/"my file.md src/a.ts')).toEqual([]);
  });

  it("거부된 인용의 꼬리 인용 뒤 공백 다음의 정상 경로는 남는다", () => {
    expect(paths('key="a b"="c d.md" src/a.ts')).toEqual(["src/a.ts"]);
  });

  it("공백 없는 긴 거부 꼬리의 문자 검사는 입력 길이에 선형이다", () => {
    // 인용 짝마다 단어 끝을 처음부터 다시 찾으면 검사 횟수가 입력 길이의 제곱에 가까워진다. 검사는 charAt 호출로 센다.
    const line = `"src"${'/"x"'.repeat(4000)}`;
    const charAt = String.prototype.charAt;
    let checks = 0;
    String.prototype.charAt = function (this: string, index: number) {
      checks += 1;
      return charAt.call(this, index);
    };
    try {
      expect(findPathCandidates(line)).toEqual([]);
    } finally {
      String.prototype.charAt = charAt;
    }
    expect(checks).toBeLessThan(10 * line.length);
  });

  it("단어 가운데의 apostrophe 는 여는 따옴표가 아니다", () => {
    expect(paths("it's src/a.ts")).toEqual(["src/a.ts"]);
    expect(paths("don't open README.md")).toEqual(["README.md"]);
  });
});

describe("터미널 버퍼의 링크 범위 (셀 좌표)", () => {
  it("한글 앞의 경로는 넓은 글자의 두 칸을 모두 세어 범위를 잡는다", async () => {
    const term = terminal();
    await write(term, "한글 문서/노트.md");
    const links = await linksAt(term, 1);
    expect(links.map((l) => l.text)).toEqual(["문서/노트.md"]);
    expect(links[0].range).toEqual({ start: { x: 6, y: 1 }, end: { x: 17, y: 1 } });
  });

  it("soft-wrap 된 경로는 시작 행과 끝 행을 모두 덮고, 두 행 어디에서 요청해도 같은 링크다", async () => {
    const term = terminal(20);
    await write(term, "./abcdefghijklmnopqrstuvwxyz.md");
    const first = await linksAt(term, 1);
    expect(first).toHaveLength(1);
    expect(first[0].text).toBe("./abcdefghijklmnopqrstuvwxyz.md");
    expect(first[0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 11, y: 2 } });
    expect(await linksAt(term, 2)).toHaveLength(1);
    expect(await linksAt(term, 3)).toEqual([]);
  });

  it("한 논리 줄이 16 KiB 를 넘으면 부분 경로 없이 링크를 만들지 않는다", async () => {
    const term = terminal();
    await write(term, `${"a".repeat(200)}/x.md`);
    expect(await linksAt(term, 1)).toHaveLength(1);

    const long = terminal();
    await write(long, `${"a".repeat(16 * 1024)}/x.md`);
    expect(await linksAt(long, 1)).toEqual([]);
  });

  it("scrollback 에서 앞이 잘린 soft-wrap 경로에는 링크를 만들지 않는다", async () => {
    const term = new Terminal({ cols: 20, rows: 3, scrollback: 0 });
    await write(term, "./abcdefghijklmnopqrstuvwxyz.md");
    expect(await linksAt(term, 1)).toHaveLength(1);

    // 줄을 밀어 wrap 된 경로의 첫 행을 버퍼 밖으로 내보낸다.
    await write(term, "\r\nnext\r\nlast");
    expect(term.buffer.active.getLine(0)?.isWrapped).toBe(true);
    expect(await linksAt(term, 1)).toEqual([]);
  });

  it("출력과 hover 로 링크를 인식할 때는 IPC 를 부르지 않는다", async () => {
    const term = terminal();
    await write(term, "src/a.ts");
    await linksAt(term, 1);
    await linksAt(term, 1);
    expect(h.presentTerminalPath).not.toHaveBeenCalled();
  });
});

describe("클릭 활성화", () => {
  beforeEach(() => h.presentTerminalPath.mockClear());

  it("수정 키 없는 클릭은 IPC 를 부르지 않는다", async () => {
    const term = terminal();
    await write(term, "src/a.ts:12");
    const [link] = await linksAt(term, 1);
    link.activate(new MouseEvent("click"), link.text);
    expect(h.presentTerminalPath).not.toHaveBeenCalled();
  });

  it("TUI 마우스 모드 중의 수정 키 클릭은 IPC 를 부르지 않는다", async () => {
    const term = terminal();
    await write(term, "\x1b[?1000hsrc/a.ts:12");
    const [link] = await linksAt(term, 1);
    link.activate(new MouseEvent("click", { ctrlKey: true, metaKey: true }), link.text);
    expect(h.presentTerminalPath).not.toHaveBeenCalled();
  });

  it("Windows 는 Ctrl+클릭 1회에 경로 원문 1회 요청을 보낸다", async () => {
    const term = terminal();
    await write(term, "see src/a.ts:12 now");
    const [link] = await linksAt(term, 1, false);
    link.activate(new MouseEvent("click", { ctrlKey: true }), link.text);
    expect(h.presentTerminalPath).toHaveBeenCalledExactlyOnceWith(SESSION, "src/a.ts");
  });

  it("macOS 는 ⌘+클릭만 요청하고 Ctrl+클릭은 무시한다", async () => {
    const term = terminal();
    await write(term, "src/a.ts");
    const [link] = await linksAt(term, 1, true);
    link.activate(new MouseEvent("click", { ctrlKey: true }), link.text);
    expect(h.presentTerminalPath).not.toHaveBeenCalled();
    link.activate(new MouseEvent("click", { metaKey: true }), link.text);
    expect(h.presentTerminalPath).toHaveBeenCalledExactlyOnceWith(SESSION, "src/a.ts");
  });

  it("IPC reject 는 서버 message 를 오류 콜백으로 보낸다", async () => {
    h.presentTerminalPath.mockRejectedValueOnce({ code: "unknown_target", message: "gone" });
    const onError = vi.fn();
    const term = terminal();
    await write(term, "src/a.ts");
    const [link] = await linksAt(term, 1, false, onError);
    link.activate(new MouseEvent("click", { ctrlKey: true }), link.text);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith("gone"));
  });

  it("TerminalView 에 붙은 제공자가 실제 수정 키 클릭을 IPC 로 보낸다", async () => {
    const onError = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new TerminalView(host, SESSION, undefined, undefined, onError);
    try {
      await view.attach();
      const term = termOf(view);
      await write(term, "src/b.md");
      const core = (term as unknown as {
        _core: { _linkProviderService: { linkProviders: ILinkProvider[] } };
      })._core;
      // 파일 제공자는 TerminalView 생성자에서 마지막으로 등록된다.
      const providers = core._linkProviderService.linkProviders;
      const links = await new Promise<ILink[]>((resolve) =>
        providers[providers.length - 1].provideLinks(1, (found) => resolve(found ?? [])),
      );
      expect(links.map((l) => l.text)).toEqual(["src/b.md"]);
      const gesture = IS_MAC ? { metaKey: true } : { ctrlKey: true };
      links[0].activate(new MouseEvent("click", gesture), links[0].text);
      expect(h.presentTerminalPath).toHaveBeenCalledExactlyOnceWith(SESSION, "src/b.md");
      expect(onError).not.toHaveBeenCalled();
    } finally {
      view.dispose();
      host.remove();
    }
  });
});
