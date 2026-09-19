// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

// merge 헬퍼와 agy 훅은 WSL 쪽 python3·bash 로 돈다. Windows 러너에는 그 환경이 없어 건너뛰고,
// 그 밖의 OS 에서 도구가 없으면 skip 이 아니라 실패로 드러낸다.
const onWindows = process.platform === "win32";
const onLinux = process.platform === "linux";
const pythonSuite = onWindows ? describe.skip : describe;
const linuxSuite = onLinux ? describe : describe.skip;
// root 에게는 os.access 가 권한 비트와 무관하게 쓰기 가능을 돌려주므로 읽기 전용 대상을 만들 수 없다.
const runsAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

function commandPath(command: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BASH_ENV;
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `command -v ${command}`], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  const path = result.stdout?.trim();
  if (result.status !== 0 || !path) {
    throw new Error(`provision hook tests require ${command}`);
  }
  return path;
}

const tools: Record<string, string> = {};
if (!onWindows) tools.python3 = commandPath("python3");
if (onLinux) {
  for (const command of ["bash", "sh", "jq", "head", "cat", "readlink", "script"]) tools[command] = commandPath(command);
}

const testDir = dirname(fileURLToPath(import.meta.url));
const HELPER = resolve(testDir, "../../../scripts/wsl/mast-hooks-merge.py");
const AGY_HOOK = resolve(testDir, "../../../scripts/wsl/mast-agy-hook.sh");
const provisionSource = readFileSync(resolve(testDir, "../src-tauri/src/provision.rs"), "utf8");

const ROOT = mkdtempSync(join(tmpdir(), "mast provision hooks-"));
const readOnlyDirs: string[] = [];

afterAll(() => {
  for (const dir of readOnlyDirs) chmodSync(dir, 0o755);
  rmSync(ROOT, { recursive: true, force: true });
});

// 훅 게이트와 탭 id 는 이 테스트를 돌리는 셸(mast 안의 Claude Code 등)에서 새어 들어오면 안 된다.
const SCRUBBED_ENV = ["CLAUDECODE", "CODEX_THREAD_ID", "MAST", "MAST_TAB", "CODEX_HOME", "BASH_ENV"];

const NOTIFY_CMD = '"$HOME/.mast/bin/mast-notify.sh"';
const CLAUDE_HOOK_CMD = '"$HOME/.mast/bin/mast-claude-hook.sh"';
const CODEX_HOOK_CMD = '"$HOME/.mast/bin/mast-codex-hook.sh"';
const AGY_HOOK_CMD = '"$HOME/.mast/bin/mast-agy-hook.sh"';
const CONTRACT_DOC = "scripts/wsl/claude-hook-example.md";
const NEEDS_INPUT_MATCHER = [
  "permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
  "quota_auto_resume_stale",
  "worker_permission_prompt",
].join("|");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const command = (text: string, extra: Record<string, Json> = {}) => ({ type: "command", command: text, ...extra });
const claudeGroup = (text: string, matcher = "") => ({ matcher, hooks: [command(text)] });
const running = claudeGroup(`${NOTIFY_CMD} mast:running`);
const needsInput = claudeGroup(`${NOTIFY_CMD} mast:needsInput 'needs input'`, NEEDS_INPUT_MATCHER);
const idle = claudeGroup(`${NOTIFY_CMD} mast:idle done`);
const dispatcher = claudeGroup(CLAUDE_HOOK_CMD);

const FRESH_CLAUDE = {
  hooks: {
    SessionStart: [dispatcher],
    UserPromptSubmit: [running, dispatcher],
    PermissionRequest: [dispatcher],
    PostToolUse: [dispatcher],
    PostToolUseFailure: [dispatcher],
    PostToolBatch: [dispatcher],
    SubagentStop: [dispatcher],
    Notification: [needsInput],
    Stop: [idle, dispatcher],
  },
};

const codexGroup = (timeout: number, async = false) => ({
  hooks: [command(CODEX_HOOK_CMD, async ? { timeout, async: true } : { timeout })],
});

const FRESH_CODEX = {
  hooks: {
    UserPromptSubmit: [codexGroup(5)],
    PreToolUse: [codexGroup(5)],
    PermissionRequest: [codexGroup(10, true)],
    PostToolUse: [codexGroup(5)],
    SubagentStop: [codexGroup(5)],
    Stop: [codexGroup(5)],
    Interrupt: [codexGroup(3)],
  },
};

const AGY_MAST = {
  PreInvocation: [command(`${AGY_HOOK_CMD} running`, { timeout: 5 })],
  Stop: [command(`${AGY_HOOK_CMD} idle`, { timeout: 5 })],
};

type ModeCase = {
  mode: string;
  file: (home: Home) => string;
  args: (path: string) => string[];
  fresh: unknown;
  consequence: string;
  // 파일 내용 때문에 병합을 거부할 때의 종료 코드와 알림 끝부분. Claude 만 매 실행 다시 시도한다.
  refused: { status: number; notice: string };
};

const CLAUDE_MODE: ModeCase = {
  mode: "claude",
  file: (home) => home.path(".claude", "settings.json"),
  args: (path) => ["claude", path, NOTIFY_CMD, CLAUDE_HOOK_CMD],
  fresh: FRESH_CLAUDE,
  consequence: "Claude Code hooks are not wired",
  refused: { status: 1, notice: "left untouched. Claude Code hooks are not wired; mast retries on its next launch.\n" },
};
const CODEX_MODE: ModeCase = {
  mode: "codex",
  file: (home) => home.path(".codex", "hooks.json"),
  args: (path) => ["codex", path],
  fresh: FRESH_CODEX,
  consequence: "Codex hooks are not installed",
  refused: { status: 3, notice: "left untouched. Codex hooks are not installed.\n" },
};
const AGY_MODE: ModeCase = {
  mode: "agy",
  file: (home) => home.path(".gemini", "config", "hooks.json"),
  args: (path) => ["agy", path],
  fresh: { mast: AGY_MAST },
  consequence: "Antigravity CLI hooks are not installed",
  refused: { status: 3, notice: "left untouched. Antigravity CLI hooks are not installed.\n" },
};
const MODES = [CLAUDE_MODE, CODEX_MODE, AGY_MODE];

// setup v13 이 실제로 쓴 settings.json 이다. 88714ad 의 provision.rs 에서 MAST_CLAUDE_EOF 히어독을
// 꺼내 `python3 merge.py <settings.json> '"$HOME/.mast/bin/mast-notify.sh"'` 로 (1) 파일이 없을 때,
// (2) 사용자 Stop 훅 하나가 있는 파일에 돌린 출력 그대로다. v14 배선이 그 히어독을 이 헬퍼 호출로
// 바꾸므로 소스에서 매번 추출하지 않고 여기 고정한다.
const V13_FRESH = String.raw`{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-notify.sh\" mast:running"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-notify.sh\" mast:needsInput 'needs input'"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-notify.sh\" mast:idle done"
          }
        ]
      }
    ]
  }
}
`;

const V13_WITH_USER_STOP = String.raw`{
  "model": "opus",
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "paplay done.oga"
          }
        ]
      },
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-notify.sh\" mast:idle done"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-notify.sh\" mast:running"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-notify.sh\" mast:needsInput 'needs input'"
          }
        ]
      }
    ]
  }
}
`;

const userStop = claudeGroup("paplay done.oga");
const DISPATCHER_ONLY_EVENTS = {
  SessionStart: [dispatcher],
  PermissionRequest: [dispatcher],
  PostToolUse: [dispatcher],
  PostToolUseFailure: [dispatcher],
  PostToolBatch: [dispatcher],
  SubagentStop: [dispatcher],
};

const V13_UPGRADES = [
  {
    name: "a fresh v13 install",
    v13: V13_FRESH,
    v14: {
      hooks: {
        UserPromptSubmit: [running, dispatcher],
        Notification: [needsInput],
        Stop: [idle, dispatcher],
        ...DISPATCHER_ONLY_EVENTS,
      },
    },
  },
  {
    name: "a v13 install next to a user Stop hook",
    v13: V13_WITH_USER_STOP,
    v14: {
      model: "opus",
      hooks: {
        Stop: [userStop, idle, dispatcher],
        UserPromptSubmit: [running, dispatcher],
        Notification: [needsInput],
        ...DISPATCHER_ONLY_EVENTS,
      },
    },
  },
];

// tomllib 이 없는 python(3.11 미만)을 흉내 낸다. sys.modules 의 None 항목은 import 를 ImportError 로 만든다.
const WITHOUT_TOMLLIB = String.raw`
import runpy
import sys
sys.modules["tomllib"] = None
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;

// 부모 umask 가 077 이면 권한 보존이 빠져도 새 파일이 0600 으로 나와 회귀를 못 잡으므로 022 로 고정한다.
const WITH_UMASK_022 = String.raw`
import os
import runpy
import sys
os.umask(0o022)
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;

// 병합 결과를 임시 파일에 쓴 직후, 원본을 다시 확인하기 직전에 다른 쓰기가 끼어든 상황을 만든다.
const RACING_WRITE = String.raw`
import importlib.util
import sys
helper, intruder = sys.argv[1], sys.argv[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("mast_hooks_merge", helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
write_temp = module.write_temp
def racing(*args, **kwargs):
    write_temp(*args, **kwargs)
    with open(intruder, "a") as handle:
        handle.write("\n")
module.write_temp = racing
sys.exit(module.main(sys.argv[3:]))
`;

// 3.13 부터 ast 의 feature_version 하한은 (3, 7) 이라 그 이상의 python 에서는 (3, 6) 을 줘도 3.7 문법까지만
// 걸러진다. CI(ubuntu-24.04)의 3.12 가 (3, 6) 을 실제로 검사하고, 표준 라이브러리 API 는 python:3.6 컨테이너
// 스모크로 따로 확인한다.
const PARSE_AS_36 = String.raw`
import ast
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    ast.parse(handle.read(), filename=sys.argv[1], feature_version=(3, 6))
`;

type Run = { status: number | null; stdout: string; stderr: string; lines: string[] };

class Home {
  readonly root = mkdtempSync(join(ROOT, "case-"));
  readonly home = join(this.root, "home");

  constructor() {
    mkdirSync(this.home, { recursive: true });
  }

  path(...parts: string[]): string {
    return join(this.home, ...parts);
  }

  write(path: string, content: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.home };
    for (const key of SCRUBBED_ENV) delete env[key];
    return { ...env, ...extra };
  }

  python(argv: string[]): Run {
    const result = spawnSync(tools.python3, argv, {
      env: this.env(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      lines: result.stdout.split("\n").filter(Boolean),
    };
  }

  merge(...args: string[]): Run {
    return this.python([HELPER, ...args]);
  }

  claude(settings: string, ...extra: string[]): Run {
    return this.merge("claude", settings, NOTIFY_CMD, CLAUDE_HOOK_CMD, ...extra);
  }
}

function fileText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fingerprint(path: string): { text: string; ino: number; mtimeMs: number } {
  const stats = statSync(path);
  return { text: readFileSync(path, "utf8"), ino: stats.ino, mtimeMs: stats.mtimeMs };
}

function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".mast-tmp."));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function snippetOf(stderr: string): unknown {
  const begin = stderr.indexOf("\n{");
  const end = stderr.lastIndexOf("\n}");
  if (begin < 0 || end < 0) throw new Error(`no JSON snippet in: ${stderr}`);
  return JSON.parse(stderr.slice(begin + 1, end + 2));
}

function makeReadOnly(dir: string): void {
  chmodSync(dir, 0o555);
  readOnlyDirs.push(dir);
}

const UNICODE_COMMAND = "echo 한국어 🚀";
const NON_ASCII_CASES = [
  {
    ...CLAUDE_MODE,
    before: { statusLine: command(UNICODE_COMMAND), env: { GREETING: "안녕 👋" } },
    after: { statusLine: command(UNICODE_COMMAND), env: { GREETING: "안녕 👋" }, ...FRESH_CLAUDE },
  },
  {
    ...CODEX_MODE,
    before: { description: "팀 훅 🚀", hooks: { SessionStart: [{ hooks: [command(UNICODE_COMMAND)] }] } },
    after: {
      description: "팀 훅 🚀",
      hooks: { SessionStart: [{ hooks: [command(UNICODE_COMMAND)] }], ...FRESH_CODEX.hooks },
    },
  },
  {
    ...AGY_MODE,
    before: { greeter: { Stop: [command(UNICODE_COMMAND)] } },
    after: { greeter: { Stop: [command(UNICODE_COMMAND)] }, mast: AGY_MAST },
  },
];

// 리터럴은 모두 에이전트가 따지지 않는 자리에 둔다. 형태 검사가 아니라 JSON 읽기가 거부해야 한다.
const NON_JSON_LITERAL_CASES = [
  { ...CLAUDE_MODE, content: '{"env": {"X": NaN}}\n' },
  {
    ...CODEX_MODE,
    content: '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "paplay done.oga", "note": Infinity}]}]}}\n',
  },
  { ...AGY_MODE, content: '{"greeter": {"Stop": [{"command": "echo"}], "note": -Infinity}}\n' },
];

// JSON.parse 는 읽지만 Python 은 inf 로 읽어 Infinity 로 다시 쓰게 되는 수다. 역시 형태 검사가 보지 않는 자리에 둔다.
const OVERFLOW_CASES = [
  { ...CLAUDE_MODE, content: '{"threshold": 1e400}\n' },
  {
    ...CODEX_MODE,
    content: '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "paplay done.oga", "note": -1e400}]}]}}\n',
  },
  { ...AGY_MODE, content: '{"greeter": {"Stop": [{"command": "echo"}], "note": 1e999}}\n' },
];

pythonSuite("mast-hooks-merge.py", () => {
  it("parses as Python 3.6 syntax", () => {
    const run = new Home().python(["-c", PARSE_AS_36, HELPER]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("rejects an unknown mode or missing arguments with exit 2", () => {
    const home = new Home();
    expect(home.merge().status).toBe(2);
    expect(home.merge("gemini", home.path("x.json")).status).toBe(2);
    expect(home.merge("claude", home.path("settings.json")).status).toBe(2);
  });

  it("runs every mode the same way when tomllib cannot be imported", () => {
    const home = new Home();
    const settings = home.path(".claude", "settings.json");
    const codexHooks = home.path(".codex", "hooks.json");
    const agyHooks = home.path(".gemini", "config", "hooks.json");
    const withoutTomllib = (...args: string[]) => home.python(["-c", WITHOUT_TOMLLIB, HELPER, ...args]);

    expect(withoutTomllib("claude", settings, NOTIFY_CMD, CLAUDE_HOOK_CMD).status).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(fileText(FRESH_CLAUDE));

    home.write(home.path(".codex", "config.toml"), 'notify = ["bash", "-lc", "true"]\n');
    const codex = withoutTomllib("codex", codexHooks, "--config", home.path(".codex", "config.toml"));
    expect(codex.status).toBe(0);
    expect(codex.lines).toContain(`codex: config=read parser=patterns path=${home.path(".codex", "config.toml")}`);
    expect(readFileSync(codexHooks, "utf8")).toBe(fileText(FRESH_CODEX));

    expect(withoutTomllib("agy", agyHooks).status).toBe(0);
    expect(readFileSync(agyHooks, "utf8")).toBe(fileText({ mast: AGY_MAST }));
  });

  it.each(MODES)("treats a whitespace-only $mode file as absent", ({ file, args, fresh }) => {
    const home = new Home();
    const path = home.write(file(home), " \n\t\n");
    const run = home.merge(...args(path));

    expect(run.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(fileText(fresh));
  });

  it.each(MODES)("refuses a $mode file whose top level is null", ({ mode, file, args, refused }) => {
    const home = new Home();
    const path = home.write(file(home), "null\n");
    const run = home.merge(...args(path));

    expect(run.status).toBe(refused.status);
    expect(readFileSync(path, "utf8")).toBe("null\n");
    expect(run.lines.at(-1)).toMatch(new RegExp(`^${mode}: result=failed reason=`));
    expect(run.stderr).toContain(refused.notice);
  });

  it.each(NON_JSON_LITERAL_CASES)("refuses a $mode file with a NaN or Infinity literal", ({ mode, file, args, refused, content }) => {
    const home = new Home();
    const path = home.write(file(home), content);
    const run = home.merge(...args(path));

    expect(run.status).toBe(refused.status);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(run.lines.at(-1)).toMatch(new RegExp(`^${mode}: result=failed reason=`));
    expect(run.stderr).toContain("does not parse as JSON (NaN/Infinity is not JSON)");
    expect(run.stderr).toContain(refused.notice);
  });

  it.each(OVERFLOW_CASES)("refuses to rewrite a $mode file holding a number a double cannot hold", ({ mode, file, args, refused, content }) => {
    const home = new Home();
    const path = home.write(file(home), content);
    const run = home.merge(...args(path));

    expect(run.status).toBe(refused.status);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(run.lines.at(-1)).toMatch(new RegExp(`^${mode}: result=failed reason=`));
    expect(run.stderr).toContain(`${path} contains a number outside the range JSON writers can reproduce; ${refused.notice}`);
    expect(run.stderr).not.toContain("unexpected");
    expect(leftovers(dirname(path))).toEqual([]);
  });

  it.each(MODES)("refuses a $mode file that is not UTF-8", ({ mode, file, args, refused }) => {
    const home = new Home();
    const path = file(home);
    const content = Buffer.from('{"note": "caf\xe9"}\n', "latin1");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    const run = home.merge(...args(path));

    expect(run.status).toBe(refused.status);
    expect(readFileSync(path)).toEqual(content);
    expect(run.lines.at(-1)).toMatch(new RegExp(`^${mode}: result=failed reason=`));
    expect(run.stderr).toContain(`${path} is not valid UTF-8; ${refused.notice}`);
  });

  // JSON 의 \ud800 이스케이프는 파싱되지만 짝 없는 surrogate 라 병합 결과를 UTF-8 로 쓸 수 없다. 형태 검사가 보지
  // 않는 자리에 둔다.
  it.each([
    { ...CLAUDE_MODE, content: '{"env": {"X": "\\ud800"}}\n' },
    { ...CODEX_MODE, content: '{"description": "\\ud800"}\n' },
    { ...AGY_MODE, content: '{"greeter": {"Stop": [{"command": "echo \\ud800"}]}}\n' },
  ])("refuses to rewrite a $mode file whose merged text cannot be encoded as UTF-8", ({ mode, file, args, refused, content }) => {
    const home = new Home();
    const path = home.write(file(home), content);
    const run = home.merge(...args(path));

    expect(run.status).toBe(refused.status);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(run.lines.at(-1)).toMatch(new RegExp(`^${mode}: result=failed reason=`));
    expect(run.stderr).toContain(`the merged ${path} cannot be encoded as UTF-8 (`);
    expect(run.stderr).toContain(refused.notice);
    expect(leftovers(dirname(path))).toEqual([]);
  });

  // 읽기·쓰기 실패는 다음 실행에서 풀릴 수 있으므로 모든 모드가 exit 1 로 다시 시도하게 한다.
  it.each(MODES)("fails with exit 1 and a retry when the $mode file cannot be read", ({ mode, file, args, consequence }) => {
    const home = new Home();
    const path = file(home);
    mkdirSync(path, { recursive: true });
    const run = home.merge(...args(path));

    expect(run.status).toBe(1);
    expect(run.lines.at(-1)).toMatch(new RegExp(`^${mode}: result=failed reason=`));
    expect(run.stderr).toContain(`cannot read ${path} (`);
    expect(run.stderr).toContain(`left untouched. ${consequence}; mast retries on its next launch.`);
  });

  it.each(MODES)("does not create the missing target of a dangling $mode symlink", ({ mode, file, args, fresh }) => {
    const home = new Home();
    const link = file(home);
    const missing = join(home.root, "not-cloned", "dotfiles", "hooks.json");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(missing, link);
    const run = home.merge(...args(link));

    expect(run.status).toBe(0);
    expect(existsSync(join(home.root, "not-cloned"))).toBe(false);
    expect(readlinkSync(link)).toBe(missing);
    expect(run.lines.at(-1)).toBe(`${mode}: result=skipped-dangling-link path=${link}`);
    const resolved = join(realpathSync(home.root), "not-cloned", "dotfiles", "hooks.json");
    expect(run.stderr).toContain(`${link} resolves to ${resolved}, which does not exist (a dangling symlink)`);
    expect(snippetOf(run.stderr)).toEqual(fresh);
    expect(leftovers(dirname(link))).toEqual([]);
  });

  it("does not create the missing directory behind a dangling config-directory link", () => {
    const home = new Home();
    const missingDir = join(home.root, "moved-dotfiles", "claude");
    symlinkSync(missingDir, home.path(".claude"));
    const settings = home.path(".claude", "settings.json");
    const run = home.claude(settings);

    expect(run.status).toBe(0);
    expect(existsSync(join(home.root, "moved-dotfiles"))).toBe(false);
    expect(run.lines.at(-1)).toBe(`claude: result=skipped-dangling-link path=${settings}`);
  });

  for (const linked of [false, true]) {
    it.each(NON_ASCII_CASES)(
      `keeps a 0600 $mode file${linked ? " behind a symlink" : ""} at 0600 with its non-ASCII values byte for byte`,
      ({ file, args, before, after }) => {
        const home = new Home();
        const real = home.write(linked ? join(home.root, "dotfiles", "config.json") : file(home), fileText(before));
        chmodSync(real, 0o600);
        const path = linked ? file(home) : real;
        if (linked) {
          mkdirSync(dirname(path), { recursive: true });
          symlinkSync(real, path);
        }
        const run = home.python(["-c", WITH_UMASK_022, HELPER, ...args(path)]);

        expect(run.status).toBe(0);
        if (linked) expect(lstatSync(path).isSymbolicLink()).toBe(true);
        expect(statSync(real).mode & 0o777).toBe(0o600);
        expect(readFileSync(real, "utf8")).toBe(fileText(after));
        expect(readFileSync(real).includes(Buffer.from(JSON.stringify(UNICODE_COMMAND), "utf8"))).toBe(true);
      },
    );
  }

  describe("claude", () => {
    it("pins NOTIFY_CMD to the literal provision.rs writes", () => {
      expect(provisionSource).toContain(`NOTIFY_CMD='${NOTIFY_CMD}'`);
    });

    it("creates settings.json with every row when none exists", () => {
      const home = new Home();
      const settings = home.path(".claude", "settings.json");
      const run = home.claude(settings);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(readFileSync(settings, "utf8")).toBe(fileText(FRESH_CLAUDE));
      expect(run.lines).toEqual([
        "claude: added SessionStart role=dispatcher",
        "claude: added UserPromptSubmit role=status",
        "claude: added UserPromptSubmit role=dispatcher",
        "claude: added PermissionRequest role=dispatcher",
        "claude: added PostToolUse role=dispatcher",
        "claude: added PostToolUseFailure role=dispatcher",
        "claude: added PostToolBatch role=dispatcher",
        "claude: added SubagentStop role=dispatcher",
        "claude: added Notification role=status",
        "claude: added Stop role=status",
        "claude: added Stop role=dispatcher",
        `claude: result=written path=${settings}`,
      ]);
      expect(leftovers(dirname(settings))).toEqual([]);
    });

    it.each(V13_UPGRADES)("upgrades the real v13 output of $name: dispatcher rows added, Notification narrowed", ({ v13, v14 }) => {
      expect(fileText(JSON.parse(v13))).toBe(v13);
      const home = new Home();
      const settings = home.write(home.path(".claude", "settings.json"), v13);
      const run = home.claude(settings);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(readFileSync(settings, "utf8")).toBe(fileText(v14));
      expect(run.lines).toEqual(expect.arrayContaining([
        "claude: narrowed Notification",
        "claude: added SessionStart role=dispatcher",
        "claude: wired UserPromptSubmit role=status",
        "claude: added UserPromptSubmit role=dispatcher",
        "claude: added PostToolUse role=dispatcher",
        "claude: added PostToolUseFailure role=dispatcher",
        "claude: added Stop role=dispatcher",
        `claude: result=written path=${settings}`,
      ]));
      expect(run.lines.some((line) => line.includes("migrated"))).toBe(false);
    });

    it("narrows the v13 group when only its key order differs", () => {
      const home = new Home();
      const reordered = { hooks: [{ command: `${NOTIFY_CMD} mast:needsInput 'needs input'`, type: "command" }], matcher: "" };
      const settings = home.write(home.path(".claude", "settings.json"), fileText({ hooks: { Notification: [reordered] } }));
      const run = home.claude(settings);

      expect(run.status).toBe(0);
      expect(run.lines).toContain("claude: narrowed Notification");
      const notification = readJson(settings).hooks.Notification;
      expect(notification).toEqual([{ ...reordered, matcher: NEEDS_INPUT_MATCHER }]);
      expect(Object.keys(notification[0])).toEqual(["hooks", "matcher"]);
      expect(Object.keys(notification[0].hooks[0])).toEqual(["command", "type"]);
    });

    it("migrates the documented manual path first and then narrows it", () => {
      const home = new Home();
      const settings = home.write(home.path(".claude", "settings.json"), fileText({
        hooks: {
          Notification: [claudeGroup("~/.claude/hooks/mast-notify.sh mast:needsInput 'needs input'")],
          Stop: [claudeGroup('"$HOME/.claude/hooks/mast-notify.sh" mast:idle done')],
        },
      }));
      const run = home.claude(settings);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.lines).toEqual(expect.arrayContaining([
        "claude: migrated Notification",
        "claude: migrated Stop",
        "claude: narrowed Notification",
      ]));
      const hooks = readJson(settings).hooks;
      expect(hooks.Notification).toEqual([needsInput]);
      expect(hooks.Stop).toEqual([idle, dispatcher]);
    });

    it("writes nothing and says nothing when run again after the upgrade", () => {
      const home = new Home();
      const settings = home.write(home.path(".claude", "settings.json"), V13_WITH_USER_STOP);
      expect(home.claude(settings).status).toBe(0);
      const before = fingerprint(settings);

      const again = home.claude(settings);
      expect(again.status).toBe(0);
      expect(again.stderr).toBe("");
      expect(again.lines).toContain("claude: already-narrowed Notification");
      expect(again.lines).toContain("claude: wired SessionStart role=dispatcher");
      expect(again.lines).toContain(`claude: result=unchanged path=${settings}`);
      expect(again.lines.some((line) => /: (added|migrated|narrowed) /.test(line))).toBe(false);
      expect(fingerprint(settings)).toEqual(before);
    });

    const legacyHandler = command(`${NOTIFY_CMD} mast:needsInput 'needs input'`);
    it.each([
      ["changed arguments", { matcher: "", hooks: [command(`${NOTIFY_CMD} mast:needsInput 'look here'`)] }, true],
      ["an added timeout", { matcher: "", hooks: [{ ...legacyHandler, timeout: 30 }] }, true],
      ["a second handler", { matcher: "", hooks: [legacyHandler, command("notify-send waiting")] }, true],
      ["a star matcher", { matcher: "*", hooks: [legacyHandler] }, true],
      ["no matcher key", { hooks: [legacyHandler] }, true],
      ["idle_prompt in the matcher", { matcher: "permission_prompt|idle_prompt", hooks: [legacyHandler] }, true],
      ["a matcher narrowed by hand", { matcher: "permission_prompt", hooks: [legacyHandler] }, false],
      ["an idle mapping on idle_prompt", { matcher: "idle_prompt", hooks: [command(`${NOTIFY_CMD} mast:idle 'waiting for you'`)] }, false],
      ["a running mapping with an empty matcher", { matcher: "", hooks: [command(`${NOTIFY_CMD} mast:running`)] }, false],
    ])("keeps a mast Notification hook with %s and warns only when a needsInput hook still matches idle_prompt", (_name, group, warns) => {
      const home = new Home();
      const settings = home.write(home.path(".claude", "settings.json"), fileText({ hooks: { Notification: [group] } }));
      const run = home.claude(settings);

      expect(run.status).toBe(0);
      expect(readJson(settings).hooks.Notification).toEqual([group]);
      const matcher = "matcher" in group ? group.matcher : null;
      expect(run.lines).toContain(`claude: kept Notification matcher=${JSON.stringify(matcher)}`);
      expect(run.lines).toContain("claude: wired Notification role=status");
      if (warns) {
        expect(run.stderr).toContain(`set its matcher to "${NEEDS_INPUT_MATCHER}" by hand`);
      } else {
        expect(run.stderr).toBe("");
      }
    });

    it("respects a user's mast-notify.sh on PostToolUse and warns that pairing is lost", () => {
      const home = new Home();
      const userPost = claudeGroup(`${NOTIFY_CMD} mast:running`);
      const settings = home.write(home.path(".claude", "settings.json"), fileText({ hooks: { PostToolUse: [userPost] } }));
      const run = home.claude(settings);

      expect(run.status).toBe(0);
      const hooks = readJson(settings).hooks;
      expect(hooks.PostToolUse).toEqual([userPost]);
      expect(hooks.PostToolUseFailure).toEqual([dispatcher]);
      expect(run.lines).toContain("claude: respected PostToolUse reason=user-mast-notify");
      expect(run.lines).toContain("claude: added PostToolUseFailure role=dispatcher");
      expect(run.stderr).toContain("PostToolUse in");
      expect(run.stderr).toContain("already runs mast-notify.sh");
      expect(run.stderr).not.toContain("PostToolUseFailure in");
    });

    it("migrates only status events: a manual-path mast-notify.sh on PostToolUse stays byte for byte", () => {
      const home = new Home();
      const manual = "~/.claude/hooks/mast-notify.sh mast:running";
      const settings = home.write(home.path(".claude", "settings.json"), fileText({ hooks: { PostToolUse: [claudeGroup(manual)] } }));
      const run = home.claude(settings);

      expect(run.status).toBe(0);
      expect(readJson(settings).hooks.PostToolUse).toEqual([claudeGroup(manual)]);
      expect(readFileSync(settings, "utf8")).toContain(`"command": ${JSON.stringify(manual)}`);
      expect(run.lines.some((line) => line.startsWith("claude: migrated"))).toBe(false);
      expect(run.lines).toContain("claude: respected PostToolUse reason=user-mast-notify");
      expect(run.stderr).toContain("PostToolUse in");
      expect(run.stderr).toContain("already runs mast-notify.sh");
    });

    it("leaves a hook whose leading word is not mast-notify.sh exactly as it is", () => {
      const home = new Home();
      const wrapped = claudeGroup(`bash -c '${NOTIFY_CMD} mast:idle done'`);
      const settings = home.write(home.path(".claude", "settings.json"), fileText({ hooks: { Stop: [wrapped] } }));
      const run = home.claude(settings);

      expect(run.status).toBe(0);
      expect(readJson(settings).hooks.Stop).toEqual([wrapped, dispatcher]);
      expect(run.lines).toContain("claude: untouched Stop reason=not-leading-word");
      expect(run.lines).toContain("claude: wired Stop role=status");
    });

    it("adds the SessionStart dispatcher after a user's group and treats any group running it as wired", () => {
      const home = new Home();
      const userStart = claudeGroup("load-env.sh", "startup");
      const settings = home.write(home.path(".claude", "settings.json"), fileText({ hooks: { SessionStart: [userStart] } }));
      const run = home.claude(settings);

      expect(run.status).toBe(0);
      expect(readJson(settings).hooks.SessionStart).toEqual([userStart, dispatcher]);
      expect(run.lines).toContain("claude: added SessionStart role=dispatcher");

      const narrowed = { hooks: { ...FRESH_CLAUDE.hooks, SessionStart: [claudeGroup(CLAUDE_HOOK_CMD, "resume")] } };
      const wired = home.write(join(home.root, "wired", "settings.json"), fileText(narrowed));
      const again = home.claude(wired);
      expect(again.status).toBe(0);
      expect(again.lines).toContain("claude: wired SessionStart role=dispatcher");
      expect(again.lines.at(-1)).toBe(`claude: result=unchanged path=${wired}`);
    });

    it("writes only the status rows with --no-dispatcher", () => {
      const home = new Home();
      const fresh = home.path(".claude", "settings.json");
      const run = home.claude(fresh, "--no-dispatcher");
      expect(run.status).toBe(0);
      expect(readFileSync(fresh, "utf8")).toBe(fileText({
        hooks: { UserPromptSubmit: [running], Notification: [needsInput], Stop: [idle] },
      }));
      expect(run.lines.some((line) => line.includes("SessionStart"))).toBe(false);

      const upgraded = home.write(join(home.root, "v13", "settings.json"), V13_FRESH);
      const upgrade = home.claude(upgraded, "--no-dispatcher");
      expect(upgrade.status).toBe(0);
      expect(upgrade.lines).toContain("claude: narrowed Notification");
      expect(readFileSync(upgraded, "utf8")).toBe(fileText({
        hooks: { UserPromptSubmit: [running], Notification: [needsInput], Stop: [idle] },
      }));
      expect(readFileSync(upgraded, "utf8")).not.toContain("mast-claude-hook.sh");

      // 연결하지 않는 디스패처 이벤트의 형태는 따지지 않는다.
      const odd = home.write(join(home.root, "odd", "settings.json"), '{"hooks": {"PostToolBatch": "x"}}\n');
      expect(home.claude(odd, "--no-dispatcher").status).toBe(0);
    });

    it.each([
      ["invalid JSON", "{ nope"],
      ["a top-level array", "[]\n"],
      ["hooks that is not an object", '{"hooks": []}\n'],
      ["a status event that is not an array", '{"hooks": {"Stop": {}}}\n'],
      ["a dispatcher event that is not an array", '{"hooks": {"PostToolBatch": "x"}}\n'],
    ])("fails without touching a settings.json with %s", (_name, content) => {
      const home = new Home();
      const settings = home.write(home.path(".claude", "settings.json"), content);
      const run = home.claude(settings);

      expect(run.status).toBe(1);
      expect(readFileSync(settings, "utf8")).toBe(content);
      expect(run.lines.at(-1)).toMatch(/^claude: result=failed reason=/);
      expect(run.stderr).toContain("left untouched. Claude Code hooks are not wired; mast retries on its next launch.");
      expect(leftovers(dirname(settings))).toEqual([]);
    });

    it("refuses to replace settings.json that changed while it was being merged", () => {
      const home = new Home();
      const settings = home.write(home.path(".claude", "settings.json"), V13_FRESH);
      const run = home.python([
        "-c", RACING_WRITE, HELPER, settings, "claude", settings, NOTIFY_CMD, CLAUDE_HOOK_CMD,
      ]);

      expect(run.status).toBe(1);
      expect(readFileSync(settings, "utf8")).toBe(`${V13_FRESH}\n`);
      expect(run.stderr).toContain("changed while mast was merging it");
      expect(leftovers(dirname(settings))).toEqual([]);
    });

    it("updates the target of a symlinked settings.json and keeps the link", () => {
      const home = new Home();
      const real = home.write(join(home.root, "dotfiles", "claude", "settings.json"), V13_FRESH);
      const link = home.path(".claude", "settings.json");
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync("../../dotfiles/claude/settings.json", link);
      const run = home.claude(link);

      expect(run.status).toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe("../../dotfiles/claude/settings.json");
      expect(readJson(real).hooks.Notification).toEqual([needsInput]);
      expect(leftovers(dirname(link))).toEqual([]);
      expect(leftovers(dirname(real))).toEqual([]);
    });

    it.skipIf(runsAsRoot)("leaves a read-only link target untouched, prints the snippet, and exits 0", () => {
      const home = new Home();
      const store = join(home.root, "store");
      const real = home.write(join(store, "settings.json"), V13_FRESH);
      chmodSync(real, 0o444);
      makeReadOnly(store);
      const link = home.path(".claude", "settings.json");
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(real, link);
      const run = home.claude(link);

      expect(run.status).toBe(0);
      expect(readFileSync(real, "utf8")).toBe(V13_FRESH);
      expect(run.lines.at(-1)).toBe(`claude: result=skipped-read-only path=${link}`);
      expect(run.stderr).toContain(`${link} (resolves to ${realpathSync(real)}) is not writable`);
      expect(snippetOf(run.stderr)).toEqual({
        hooks: { UserPromptSubmit: [dispatcher], ...DISPATCHER_ONLY_EVENTS, Stop: [dispatcher] },
      });
      expect(run.stderr).toContain(`\n}\nand in hooks.Notification, set the matcher of the mast-notify.sh group to "${NEEDS_INPUT_MATCHER}"`);
    });

    it.skipIf(runsAsRoot)("starts the manual steps without 'and' when there is no JSON to add", () => {
      const home = new Home();
      const store = join(home.root, "store");
      const real = home.write(join(store, "settings.json"), V13_FRESH);
      chmodSync(real, 0o444);
      makeReadOnly(store);
      const run = home.claude(real, "--no-dispatcher");

      expect(run.status).toBe(0);
      expect(run.lines.at(-1)).toBe(`claude: result=skipped-read-only path=${real}`);
      expect(run.stderr).toContain(
        `Add this by hand:\nin hooks.Notification, set the matcher of the mast-notify.sh group to "${NEEDS_INPUT_MATCHER}"`,
      );
      expect(run.stderr).not.toContain("\nand ");
    });
  });

  describe("codex", () => {
    const configOf = (home: Home) => home.path(".codex", "config.toml");
    const hooksOf = (home: Home) => home.path(".codex", "hooks.json");
    const TRUST_NOTICE = (path: string) =>
      `Codex hooks are installed in ${path} but will not run until you trust them in "Hooks need review" on the next Codex launch.`;

    it("creates hooks.json with the fixed hook definitions", () => {
      const home = new Home();
      const hooks = hooksOf(home);
      const run = home.merge("codex", hooks, "--config", configOf(home));

      expect(run.status).toBe(0);
      expect(readFileSync(hooks, "utf8")).toBe(fileText(FRESH_CODEX));
      expect(run.stderr).toBe(`[mast] setup: ${TRUST_NOTICE(hooks)}\n`);
      expect(run.lines).toEqual([
        "codex: app-server-control-socket=absent",
        `codex: config=absent path=${configOf(home)}`,
        "codex: added UserPromptSubmit",
        "codex: added PreToolUse",
        "codex: added PermissionRequest",
        "codex: added PostToolUse",
        "codex: added SubagentStop",
        "codex: added Stop",
        "codex: added Interrupt",
        `codex: result=written path=${hooks}`,
      ]);
    });

    it.each([
      ["launch", (path: string) => `[mast] setup: ${TRUST_NOTICE(path)}\n`],
      [
        "slash",
        (path: string) =>
          `[mast] setup: Codex hooks are installed in ${path} but will not run until you trust them from /hooks in Codex; ` +
          'this Codex has no "Hooks need review" prompt at launch.\n',
      ],
      ["none", (_path: string) => ""],
    ])("prints the --trust-notice %s sentence only when it writes hooks.json", (kind, expected) => {
      const home = new Home();
      const hooks = hooksOf(home);
      const run = home.merge("codex", hooks, "--trust-notice", kind);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe(expected(hooks));
      const again = home.merge("codex", hooks, "--trust-notice", kind);
      expect(again.stderr).toBe("");
    });

    it("rejects an unknown --trust-notice with exit 2", () => {
      const home = new Home();
      const run = home.merge("codex", hooksOf(home), "--trust-notice", "later");

      expect(run.status).toBe(2);
      expect(run.stderr).toContain("--trust-notice takes launch, slash or none");
      expect(existsSync(hooksOf(home))).toBe(false);
    });

    it("appends after user groups so their indices and trust keys stay put", () => {
      const home = new Home();
      const userPre = [
        { matcher: "Bash", hooks: [command("./audit.sh", { timeout: 30, statusMessage: "auditing" })] },
        { hooks: [{ type: "mcp_tool", server: "guard", tool: "check", input: { strict: true } }] },
      ];
      const userStop = [{ hooks: [command("paplay done.oga")] }];
      const userStart = [{ matcher: "startup", hooks: [command("echo hi")] }];
      const original = { description: "team hooks", hooks: { PreToolUse: userPre, Stop: userStop, SessionStart: userStart } };
      const hooks = home.write(hooksOf(home), fileText(original));
      const run = home.merge("codex", hooks);

      expect(run.status).toBe(0);
      const merged = readJson(hooks);
      expect(Object.keys(merged)).toEqual(["description", "hooks"]);
      expect(merged.description).toBe("team hooks");
      expect(merged.hooks.PreToolUse).toEqual([...userPre, codexGroup(5)]);
      expect(merged.hooks.Stop).toEqual([...userStop, codexGroup(5)]);
      expect(merged.hooks.SessionStart).toEqual(userStart);
      expect(Object.keys(merged.hooks)).toEqual([
        "PreToolUse", "Stop", "SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "SubagentStop",
        "Interrupt",
      ]);
    });

    it("treats an event that already runs mast-codex-hook.sh as wired and never rewrites it", () => {
      const home = new Home();
      const edited = { hooks: [command(CODEX_HOOK_CMD, { timeout: 30 })] };
      const hooks = home.write(hooksOf(home), fileText({ hooks: { Stop: [edited] } }));
      const first = home.merge("codex", hooks);
      expect(first.status).toBe(0);
      expect(first.lines).toContain("codex: wired Stop");
      expect(readJson(hooks).hooks.Stop).toEqual([edited]);
      const before = fingerprint(hooks);

      const again = home.merge("codex", hooks);
      expect(again.status).toBe(0);
      expect(again.stderr).toBe("");
      expect(again.lines.at(-1)).toBe(`codex: result=unchanged path=${hooks}`);
      expect(fingerprint(hooks)).toEqual(before);
    });

    const INLINE_CONFIGS: [name: string, toml: string, event: string][] = [
      [
        "an array-of-tables event",
        '[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "echo pre"\n',
        "PreToolUse",
      ],
      [
        "an event key under [hooks]",
        '[hooks]\nStop = [{ hooks = [{ type = "command", command = "echo stop" }] }]\n',
        "Stop",
      ],
    ];

    for (const tomllib of [true, false]) {
      it.each(INLINE_CONFIGS)(`does not create hooks.json next to %s (tomllib ${tomllib ? "present" : "absent"})`, (_name, toml, event) => {
        const home = new Home();
        const config = home.write(configOf(home), toml);
        const hooks = hooksOf(home);
        const args = ["codex", hooks, "--config", config];
        const run = tomllib ? home.merge(...args) : home.python(["-c", WITHOUT_TOMLLIB, HELPER, ...args]);

        expect(run.status).toBe(0);
        expect(existsSync(hooks)).toBe(false);
        expect(readFileSync(config, "utf8")).toBe(toml);
        expect(run.lines).toContain(`codex: inline-hooks events=${event}`);
        expect(run.lines.at(-1)).toBe(`codex: result=skipped-inline-hooks path=${hooks}`);
        expect(run.stderr).toContain("Codex hooks are configured inline");
        expect(run.stderr).toContain(CONTRACT_DOC);
      });
    }

    it("leaves an existing hooks.json untouched while inline hook tables exist", () => {
      const home = new Home();
      const config = home.write(configOf(home), INLINE_CONFIGS[0][1]);
      const content = fileText({ hooks: { Stop: [{ hooks: [command("paplay done.oga")] }] } });
      const hooks = home.write(hooksOf(home), content);
      const run = home.merge("codex", hooks, "--config", config);

      expect(run.status).toBe(0);
      expect(readFileSync(hooks, "utf8")).toBe(content);
    });

    for (const tomllib of [true, false]) {
      it(`installs with only hooks.state trust records and never writes config.toml (tomllib ${tomllib ? "present" : "absent"})`, () => {
        const home = new Home();
        const toml = [
          'model = "gpt-5.5"',
          "# mast: notify on turn completion (added automatically; delete these two lines to opt out)",
          `notify = ["bash", "-lc", 'exec "$HOME/.mast/bin/mast-codex-notify.sh" "$0"']`,
          "",
          "[features]",
          "hooks = true",
          "",
          `[hooks.state."/home/someone/.codex/hooks.json:pre_tool_use:0:0"]`,
          'trusted_hash = "sha256:0123456789abcdef"',
          "",
        ].join("\n");
        const config = home.write(configOf(home), toml);
        const hooks = hooksOf(home);
        const args = ["codex", hooks, "--config", config];
        const run = tomllib ? home.merge(...args) : home.python(["-c", WITHOUT_TOMLLIB, HELPER, ...args]);

        expect(run.status).toBe(0);
        expect(readFileSync(hooks, "utf8")).toBe(fileText(FRESH_CODEX));
        expect(readFileSync(config, "utf8")).toBe(toml);
        expect(run.lines.some((line) => line.includes("inline-hooks"))).toBe(false);
        expect(run.stderr).toBe(`[mast] setup: ${TRUST_NOTICE(hooks)}\n`);
      });
    }

    it.each([
      ["features.hooks = false", "[features]\nhooks = false\n", "hooks"],
      ["the legacy codex_hooks = false", "[features]\ncodex_hooks = false\n", "codex_hooks"],
      ["hooks = false next to codex_hooks = true", "[features]\ncodex_hooks = true\nhooks = false\n", "hooks"],
      ["codex_hooks = false overridden by hooks = true", "[features]\ncodex_hooks = false\nhooks = true\n", null],
    ])("judges %s the way Codex applies [features], and installs either way", (_name, toml, key) => {
      const home = new Home();
      const config = home.write(configOf(home), toml);
      const run = home.merge("codex", hooksOf(home), "--config", config);

      expect(run.status).toBe(0);
      expect(readFileSync(hooksOf(home), "utf8")).toBe(fileText(FRESH_CODEX));
      expect(readFileSync(config, "utf8")).toBe(toml);
      if (key) {
        expect(run.lines).toContain(`codex: hooks-feature=disabled key=${key}`);
        expect(run.stderr).toContain(
          `hooks disabled in config; mast hooks will not run (${config} sets features.${key} = false)`,
        );
      } else {
        expect(run.lines.some((line) => line.includes("hooks-feature"))).toBe(false);
        expect(run.stderr).toBe(`[mast] setup: ${TRUST_NOTICE(hooksOf(home))}\n`);
      }
    });

    for (const tomllib of [true, false]) {
      it.each([
        ["auto_review", 'approvals_reviewer = "auto_review"\n'],
        ["its legacy name guardian_subagent", "approvals_reviewer = 'guardian_subagent'\n"],
      ])(`warns about approvals_reviewer %s without blocking the install (tomllib ${tomllib ? "present" : "absent"})`, (_name, toml) => {
        const home = new Home();
        const config = home.write(configOf(home), toml);
        const args = ["codex", hooksOf(home), "--config", config];
        const run = tomllib ? home.merge(...args) : home.python(["-c", WITHOUT_TOMLLIB, HELPER, ...args]);

        expect(run.status).toBe(0);
        expect(run.lines).toContain("codex: approvals-reviewer=auto_review");
        expect(run.stderr).toContain("approvals_reviewer is auto_review");
        expect(existsSync(hooksOf(home))).toBe(true);
      });

      it(`says nothing about approvals_reviewer set only inside a profile table (tomllib ${tomllib ? "present" : "absent"})`, () => {
        const home = new Home();
        const config = home.write(configOf(home), 'model = "gpt-5"\n\n[profiles.review]\napprovals_reviewer = "auto_review"\n');
        const hooks = hooksOf(home);
        const args = ["codex", hooks, "--config", config];
        const run = tomllib ? home.merge(...args) : home.python(["-c", WITHOUT_TOMLLIB, HELPER, ...args]);

        expect(run.status).toBe(0);
        expect(run.lines.some((line) => line.includes("approvals-reviewer"))).toBe(false);
        expect(run.stderr).toBe(`[mast] setup: ${TRUST_NOTICE(hooks)}\n`);
        expect(readFileSync(hooks, "utf8")).toBe(fileText(FRESH_CODEX));
      });
    }

    describe("a leftover disabled hooks.state entry", () => {
      const stateToml = (key: string, enabled = "false") =>
        `[hooks.state."${key}"]\ntrusted_hash = "sha256:bbbb"\nenabled = ${enabled}\n`;
      const userStopHooks = fileText({ hooks: { Stop: [{ hooks: [command("paplay done.oga")] }] } });

      it.each([
        ["Stop", "stop", 1],
        ["SubagentStop", "subagent_stop", 0],
      ])("warns when one sits where mast appends %s, and leaves config.toml alone", (event, label, index) => {
        const home = new Home();
        const hooks = home.write(hooksOf(home), userStopHooks);
        const key = `${hooks}:${label}:${index}:0`;
        const toml = stateToml(key);
        const config = home.write(configOf(home), toml);
        const run = home.merge("codex", hooks, "--config", config);

        expect(run.status).toBe(0);
        expect(run.lines).toContain(`codex: stale-hook-state event=${event} key=${key}`);
        expect(run.stderr).toContain(`${config} still has [hooks.state."${key}"] with enabled = false`);
        expect(run.stderr).toContain(`so the mast ${event} hook there stays disabled even after you trust it`);
        expect(readFileSync(config, "utf8")).toBe(toml);
        expect(readJson(hooks).hooks.Stop).toHaveLength(2);
      });

      it("matches the canonical path when ~/.codex is a symlink", () => {
        const home = new Home();
        const realDir = join(home.root, "dotfiles", "codex");
        mkdirSync(realDir, { recursive: true });
        symlinkSync(realDir, home.path(".codex"));
        const key = `${join(realpathSync(realDir), "hooks.json")}:stop:0:0`;
        const config = home.write(configOf(home), stateToml(key));
        const run = home.merge("codex", hooksOf(home), "--config", config);

        expect(run.status).toBe(0);
        expect(run.lines).toContain(`codex: stale-hook-state event=Stop key=${key}`);
      });

      it("ignores entries that are enabled, belong to a user group, or name another hooks.json", () => {
        const home = new Home();
        const hooks = home.write(hooksOf(home), userStopHooks);
        const toml = [
          stateToml(`${hooks}:stop:0:0`),
          stateToml(`/elsewhere/project/.codex/hooks.json:stop:1:0`),
          stateToml(`${hooks}:stop:1:0`, "true"),
        ].join("\n");
        const config = home.write(configOf(home), toml);
        const run = home.merge("codex", hooks, "--config", config);

        expect(run.status).toBe(0);
        expect(run.lines.some((line) => line.includes("stale-hook-state"))).toBe(false);
        expect(run.stderr).toBe(`[mast] setup: ${TRUST_NOTICE(hooks)}\n`);
      });
    });

    it.each([
      ["a top-level null", "null\n", "the top level is not a JSON object", true],
      ["a $schema key", '{"$schema": "https://example.invalid/hooks.schema.json", "hooks": {}}\n', 'unknown top-level key "$schema"', true],
      ["hooks that is null", '{"hooks": null}\n', '"hooks" is not an object', true],
      ["an event that is not an array", '{"hooks": {"Stop": {}}}\n', "hooks.Stop is not an array", true],
      ["a group that is not an object", '{"hooks": {"Stop": ["echo"]}}\n', "hooks.Stop[0] is not an object", true],
      ["a handler that is a string", '{"hooks": {"Stop": [{"hooks": ["echo"]}]}}\n', "hooks.Stop[0].hooks[0] is not an object", true],
      ["an unsupported handler type", '{"hooks": {"Stop": [{"hooks": [{"type": "http", "url": "x"}]}]}}\n', 'has type "http"; Codex accepts only command, mcp_tool, prompt and agent', true],
      ["a handler without a type", '{"hooks": {"Stop": [{"hooks": [{"command": "echo"}]}]}}\n', "has type null; Codex accepts only command, mcp_tool, prompt and agent", true],
      ["a string timeout", '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo", "timeout": "5"}]}]}}\n', '"timeout" is not a non-negative integer', true],
      ["a duplicate top-level hooks key", '{"hooks": {}, "hooks": {}}\n', 'the top level has a duplicate "hooks" key', true],
      ["a duplicate event key", '{"hooks": {"Stop": [], "Stop": []}}\n', '"hooks" has a duplicate "Stop" key', true],
      ["a duplicate group matcher", '{"hooks": {"PreToolUse": [{"matcher": "a", "matcher": "b", "hooks": []}]}}\n', 'hooks.PreToolUse[0] has a duplicate "matcher" key', true],
      ["a duplicate handler type", '{"hooks": {"Stop": [{"hooks": [{"type": "command", "type": "command", "command": "x"}]}]}}\n', 'hooks.Stop[0].hooks[0] has a duplicate "type" key', true],
      ["a duplicate command", '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x", "command": "y"}]}]}}\n', 'has a duplicate "command" key', true],
      ["commandWindows next to its alias", '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x", "commandWindows": "a", "command_windows": "b"}]}]}}\n', 'has both "commandWindows" and its alias "command_windows"', true],
      ["a duplicate mcp_tool server", '{"hooks": {"Stop": [{"hooks": [{"type": "mcp_tool", "server": "a", "server": "b", "tool": "t"}]}]}}\n', 'has a duplicate "server" key', true],
      ["a duplicate prompt handler type", '{"hooks": {"Stop": [{"hooks": [{"type": "prompt", "type": "prompt"}]}]}}\n', 'has a duplicate "type" key', true],
      ["invalid JSON", "{\n", "does not parse as JSON", false],
    ])("refuses a hooks.json with %s and leaves it untouched", (_name, content, reason, codexRejects) => {
      const home = new Home();
      const hooks = home.write(hooksOf(home), content);
      const run = home.merge("codex", hooks);

      expect(run.status).toBe(3);
      expect(readFileSync(hooks, "utf8")).toBe(content);
      expect(run.stderr).toContain(reason);
      if (codexRejects) {
        expect(run.stderr).toContain(`${hooks} is not a hooks file Codex accepts (`);
        expect(run.stderr).toContain(`${reason}); Codex ignores the whole file; left untouched.`);
      }
      expect(run.stderr).toContain(CODEX_MODE.refused.notice);
      expect(leftovers(dirname(hooks))).toEqual([]);
    });

    // serde 는 구조체와 내부 태그 enum 을 JSON 배열에서도 위치 순서로 읽는다. 아래 입력은 codex-rs 0.154.0
    // config/src/hook_config.rs 의 serde 정의 사본으로 역직렬화해 통과를 확인했다.
    it.each([
      ["a top-level array", "[]\n", "the top level is not a JSON object"],
      ["hooks that is a non-empty array", '{"hooks": [[]]}\n', '"hooks" is not an object'],
      ["a group written as an array", '{"hooks": {"Stop": [["x"]]}}\n', "hooks.Stop[0] is not an object"],
      ["a handler written as an array", '{"hooks": {"Stop": [{"hooks": [["prompt"]]}]}}\n', "hooks.Stop[0].hooks[0] is not an object"],
    ])("refuses to merge %s without claiming Codex ignores the file", (_name, content, detail) => {
      const home = new Home();
      const hooks = home.write(hooksOf(home), content);
      const run = home.merge("codex", hooks);

      expect(run.status).toBe(3);
      expect(readFileSync(hooks, "utf8")).toBe(content);
      expect(run.stderr).toContain(`${hooks} is not a hooks file shape mast can merge (${detail}); left untouched.`);
      expect(run.stderr).not.toContain("Codex ignores");
      expect(run.stderr).not.toContain("Codex accepts");
      expect(run.lines.at(-1)).toMatch(/^codex: result=failed reason=/);
      expect(leftovers(dirname(hooks))).toEqual([]);
    });

    // 각 입력은 codex-rs config/src/hook_config.rs 의 serde 정의로 역직렬화해 통과를 확인한 것이다.
    it.each([
      ["a repeated comment key in a group", '{"hooks": {"Stop": [{"//": "a", "//": "b", "hooks": []}]}}\n', "//", "hooks.Stop[0]"],
      ["a repeated key inside mcp_tool input", '{"hooks": {"Stop": [{"hooks": [{"type": "mcp_tool", "server": "a", "tool": "t", "input": {"a": 1, "a": 2}}]}]}}\n', "a", "hooks.Stop[0].hooks[0].input"],
      ["a repeated key under an unknown event", '{"hooks": {"Notification": [{"x": 1, "x": 2}]}}\n', "x", "hooks.Notification[0]"],
      ["a repeated unknown handler field", '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x", "futureKey": 1, "futureKey": 2}]}]}}\n', "futureKey", "hooks.Stop[0].hooks[0]"],
      ["a repeated prompt body key", '{"hooks": {"Stop": [{"hooks": [{"type": "prompt", "prompt": "a", "prompt": "b"}]}]}}\n', "prompt", "hooks.Stop[0].hooks[0]"],
      ["a repeated agent body key", '{"hooks": {"Stop": [{"hooks": [{"type": "agent", "model": "a", "model": "b"}]}]}}\n', "model", "hooks.Stop[0].hooks[0]"],
    ])("installs next to %s, which Codex reads with the last value", (_name, content, key, where) => {
      const home = new Home();
      const hooks = home.write(hooksOf(home), content);
      const run = home.merge("codex", hooks);

      expect(run.status).toBe(0);
      expect(run.lines).toContain(`codex: duplicate-key-kept-last key=${JSON.stringify(key)} in=${where}`);
      expect(run.lines.at(-1)).toBe(`codex: result=written path=${hooks}`);
    });

    it("installs into hooks written as an empty array, which Codex reads as no hooks", () => {
      const home = new Home();
      const hooks = home.write(hooksOf(home), '{"description": "team", "hooks": []}\n');
      const run = home.merge("codex", hooks);

      expect(run.status).toBe(0);
      expect(readFileSync(hooks, "utf8")).toBe(fileText({ description: "team", ...FRESH_CODEX }));
      expect(run.lines.at(-1)).toBe(`codex: result=written path=${hooks}`);
      expect(run.stderr).toBe(`[mast] setup: ${TRUST_NOTICE(hooks)}\n`);
    });

    it("accepts fields Codex ignores: unknown events and extra handler keys", () => {
      const home = new Home();
      const hooks = home.write(hooksOf(home), fileText({
        hooks: { FutureEvent: [1], Stop: [{ hooks: [command("echo", { futureKey: true })] }] },
      }));
      const run = home.merge("codex", hooks);

      expect(run.status).toBe(0);
      expect(readJson(hooks).hooks.FutureEvent).toEqual([1]);
    });

    it("logs whether the app-server control socket exists", () => {
      const home = new Home();
      home.write(home.path(".codex", "app-server-control", "app-server-control.sock"), "");
      const run = home.merge("codex", hooksOf(home));
      expect(run.lines[0]).toBe("codex: app-server-control-socket=present");
    });
  });

  describe("agy", () => {
    const hooksOf = (home: Home) => home.path(".gemini", "config", "hooks.json");

    it("creates hooks.json with the mast hook when none exists", () => {
      const home = new Home();
      const hooks = hooksOf(home);
      const run = home.merge("agy", hooks);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(readFileSync(hooks, "utf8")).toBe(fileText({ mast: AGY_MAST }));
      expect(run.lines).toEqual(["agy: added mast", `agy: result=written path=${hooks}`]);
    });

    it("leaves an identical mast hook alone without writing", () => {
      const home = new Home();
      const hooks = hooksOf(home);
      expect(home.merge("agy", hooks).status).toBe(0);
      const before = fingerprint(hooks);

      const again = home.merge("agy", hooks);
      expect(again.status).toBe(0);
      expect(again.stderr).toBe("");
      expect(again.lines).toEqual(["agy: wired mast", `agy: result=unchanged path=${hooks}`]);
      expect(fingerprint(hooks)).toEqual(before);
    });

    it("keeps a different mast definition and shows the one to use instead", () => {
      const home = new Home();
      const content = fileText({ mast: { Stop: [command("my-own-script.sh", { timeout: 30 })] } });
      const hooks = home.write(hooksOf(home), content);
      const run = home.merge("agy", hooks);

      expect(run.status).toBe(0);
      expect(readFileSync(hooks, "utf8")).toBe(content);
      expect(run.lines).toContain("agy: differs mast");
      expect(snippetOf(run.stderr)).toEqual({ mast: AGY_MAST });
    });

    it("does not warn when the user disabled mast's own definition", () => {
      const home = new Home();
      const content = fileText({ mast: { enabled: false, ...AGY_MAST } });
      const hooks = home.write(hooksOf(home), content);
      const run = home.merge("agy", hooks);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.lines).toContain("agy: disabled mast");
      expect(readFileSync(hooks, "utf8")).toBe(content);
    });

    it("adds mast after the other named hooks without touching them", () => {
      const home = new Home();
      const others = {
        "lint-checker": { PostToolUse: [{ matcher: "run_command", hooks: [command("./lint.sh", { timeout: 10 })] }] },
        reminder: { enabled: false, PreInvocation: [{ command: "./reminder.sh" }] },
      };
      const hooks = home.write(hooksOf(home), fileText(others));
      const run = home.merge("agy", hooks);

      expect(run.status).toBe(0);
      expect(readFileSync(hooks, "utf8")).toBe(fileText({ ...others, mast: AGY_MAST }));
    });

    it.each([
      ["a prompt hook on Stop", { judge: { Stop: [{ type: "prompt", prompt: "Is the task done?" }] } }],
      ["event and field names in another case", { lower: { stop: [{ Command: "./done.sh" }] } }],
      ["a null hook", { placeholder: null }],
      [
        "a command hook with an empty type, an empty prompt, a null model and an int32 timeout",
        { done: { Stop: [{ type: "", command: "./done.sh", prompt: "", model: null, timeout: 2147483647 }] } },
      ],
      [
        "a prompt hook with a model, an empty command and a negative timeout",
        { judge: { PreInvocation: [{ type: "prompt", prompt: "Is the plan sound?", model: "flash", command: "", timeout: -2147483648 }] } },
      ],
      ["a command hook with a null type and a null timeout", { done: { Stop: [{ type: null, command: "./done.sh", timeout: null }] } }],
    ])("adds mast next to %s, which agy accepts", (_name, others) => {
      const home = new Home();
      const hooks = home.write(hooksOf(home), fileText(others));
      const run = home.merge("agy", hooks);

      expect(run.status).toBe(0);
      expect(readFileSync(hooks, "utf8")).toBe(fileText({ ...others, mast: AGY_MAST }));
    });

    it.each([
      ["a hook that is not an object", { good: { Stop: [] }, broken: "x" }, "broken", "is not an object"],
      ["a non-boolean enabled", { broken: { enabled: "false", Stop: [] } }, "broken", '"enabled" is not true or false'],
      [
        "a Claude-style group in a flat event",
        { notify: { Stop: [{ matcher: "", hooks: [{ command: "notify-send done" }] }] } },
        "notify",
        'Stop[0] has no "command" string',
      ],
      // agy 1.2.2 는 빈 type 을 채워진 필드와 무관하게 command 로 읽는다.
      ["a prompt without a type", { summary: { Stop: [{ prompt: "summarize" }] } }, "summary", 'Stop[0] sets "prompt" on a command hook'],
      ["a prompt with an empty type", { summary: { Stop: [{ type: "", prompt: "p" }] } }, "summary", 'Stop[0] sets "prompt" on a command hook'],
      ["a prompt with a null type", { summary: { Stop: [{ type: null, prompt: "p" }] } }, "summary", 'Stop[0] sets "prompt" on a command hook'],
      ["a command hook with a prompt", { broken: { Stop: [{ type: "command", command: "echo", prompt: "p" }] } }, "broken", 'Stop[0] sets "prompt" on a command hook'],
      ["a command hook with a model", { broken: { Stop: [{ type: "command", command: "echo", model: "flash" }] } }, "broken", 'Stop[0] sets "model" on a command hook'],
      ["a prompt hook with a command", { broken: { Stop: [{ type: "prompt", prompt: "p", command: "echo" }] } }, "broken", 'Stop[0] sets "command" on a prompt hook'],
      ["a prompt hook without a prompt", { broken: { Stop: [{ type: "prompt" }] } }, "broken", 'Stop[0] has no "prompt" string'],
      ["a type in another case", { broken: { Stop: [{ type: "Command", command: "echo" }] } }, "broken", 'Stop[0] has type "Command"'],
      ["a non-string type", { broken: { Stop: [{ type: 1, command: "echo" }] } }, "broken", 'Stop[0] "type" is not a string'],
      ["a non-string command", { broken: { Stop: [{ type: "command", command: 5 }] } }, "broken", 'Stop[0] "command" is not a string'],
      ["a falsy non-string command on a prompt hook", { broken: { Stop: [{ type: "prompt", prompt: "p", command: [] }] } }, "broken", 'Stop[0] "command" is not a string'],
      ["a falsy non-string prompt on a command hook", { broken: { Stop: [{ command: "echo", prompt: false }] } }, "broken", 'Stop[0] "prompt" is not a string'],
      ["a non-string model on a prompt hook", { broken: { Stop: [{ type: "prompt", prompt: "p", model: 5 }] } }, "broken", 'Stop[0] "model" is not a string'],
      ["a string timeout", { broken: { Stop: [{ command: "echo", timeout: "5" }] } }, "broken", 'Stop[0] "timeout" is not a 32-bit integer'],
      ["a fractional timeout", { broken: { Stop: [{ command: "echo", timeout: 1.5 }] } }, "broken", 'Stop[0] "timeout" is not a 32-bit integer'],
      ["a boolean timeout", { broken: { Stop: [{ command: "echo", timeout: true }] } }, "broken", 'Stop[0] "timeout" is not a 32-bit integer'],
      ["a timeout past int32", { broken: { Stop: [{ command: "echo", timeout: 2147483648 }] } }, "broken", 'Stop[0] "timeout" is not a 32-bit integer'],
      ["a timeout below int32", { broken: { Stop: [{ command: "echo", timeout: -2147483649 }] } }, "broken", 'Stop[0] "timeout" is not a 32-bit integer'],
      ["a flat event that is not an array", { broken: { PreInvocation: { command: "x" } } }, "broken", "PreInvocation is not an array"],
      ["an unsupported handler type", { broken: { Stop: [{ type: "http", url: "x" }] } }, "broken", 'Stop[0] has type "http"'],
      ["a command handler without a command", { broken: { SessionStart: [{ type: "command" }] } }, "broken", 'SessionStart[0] has no "command" string'],
      ["a grouped event entry that is not an object", { broken: { PreToolUse: ["x"] } }, "broken", "PreToolUse[0] is not a matcher group object"],
      ["group hooks that are not an array", { broken: { PostToolUse: [{ matcher: "", hooks: {} }] } }, "broken", "PostToolUse[0].hooks is not an array"],
      [
        "a prompt hook on PostToolUse",
        { broken: { PostToolUse: [{ matcher: "", hooks: [{ type: "prompt", prompt: "check" }] }] } },
        "broken",
        "PostToolUse[0].hooks[0] is a prompt hook",
      ],
      ["an invalid hook that is disabled", { old: { enabled: false, Stop: [{ type: "command" }] } }, "old", 'Stop[0] has no "command" string'],
    ])("refuses a hooks.json with %s, since agy then skips the whole file", (_name, others, key, reason) => {
      const home = new Home();
      const content = fileText(others);
      const hooks = home.write(hooksOf(home), content);
      const run = home.merge("agy", hooks);

      expect(run.status).toBe(3);
      expect(readFileSync(hooks, "utf8")).toBe(content);
      expect(run.stderr).toContain(`the "${key}" hook is not one agy accepts (`);
      expect(run.stderr).toContain(reason);
      expect(run.stderr).toContain("agy skips the whole file");
      expect(run.stderr).toContain(AGY_MODE.refused.notice);
    });

    it("refuses a hooks.json that defines mast more than once", () => {
      const home = new Home();
      const content = `{"mast": {"Stop": []}, "mast": ${JSON.stringify(AGY_MAST)}}\n`;
      const hooks = home.write(hooksOf(home), content);
      const run = home.merge("agy", hooks);

      expect(run.status).toBe(3);
      expect(readFileSync(hooks, "utf8")).toBe(content);
      expect(run.stderr).toContain('defines the "mast" hook more than once');
    });

    it("treats mast-agy-hook.sh under another hook name as wired and adds no second copy", () => {
      const home = new Home();
      const hooks = home.write(hooksOf(home), fileText({ status: AGY_MAST }));
      const before = fingerprint(hooks);
      const run = home.merge("agy", hooks);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.lines).toEqual(['agy: wired mast via="status"', `agy: result=unchanged path=${hooks}`]);
      expect(fingerprint(hooks)).toEqual(before);
    });

    it.each([
      ["a top-level null", "null\n"],
      ["a top-level array", "[]\n"],
      ["a top-level string", '"hooks"\n'],
      ["invalid JSON", "{\n"],
    ])("refuses %s and leaves the file untouched", (_name, content) => {
      const home = new Home();
      const hooks = home.write(hooksOf(home), content);
      const run = home.merge("agy", hooks);

      expect(run.status).toBe(3);
      expect(readFileSync(hooks, "utf8")).toBe(content);
      expect(run.stderr).toContain(AGY_MODE.refused.notice);
    });

    it("updates the target of a symlinked hooks.json and keeps the link", () => {
      const home = new Home();
      const real = home.write(join(home.root, "dotfiles", "agy-hooks.json"), fileText({ reminder: { Stop: [] } }));
      const link = hooksOf(home);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(real, link);
      const run = home.merge("agy", link);

      expect(run.status).toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(real);
      expect(readJson(real)).toEqual({ reminder: { Stop: [] }, mast: AGY_MAST });
    });
  });
});

function extractNotifyScript(source: string): string {
  const start = "cat > \"$NOTIFY.tmp\" <<'MAST_NOTIFY_EOF'\n";
  const end = "\nMAST_NOTIFY_EOF\n";
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  if (begin < 0 || finish < 0) throw new Error("mast-notify.sh heredoc disappeared from provision.rs");
  return `${source.slice(begin + start.length, finish)}\n`;
}

type HookRun = { status: number | null; stdout: string; stderr: string };

const IN_TAB = { MAST_TAB: "7" };

class AgyHookHome extends Home {
  readonly argvFile = this.path(".mast", "notify-argv");
  readonly stdinFile = this.path(".mast", "notify-stdin-target");

  installStub(): void {
    // 받은 인자와 stdin 이 가리키는 곳을 기록하고 stdout·stderr 에 일부러 잡음을 낸다. 훅이 stdin 을
    // 이미 EOF 까지 비운 뒤라 내용으로는 /dev/null 연결 여부를 구분할 수 없어 fd 0 의 대상을 본다.
    this.write(this.path(".mast", "bin", "mast-notify.sh"), [
      `#!${tools.bash}`,
      `printf '%s\\0' "$#" "$@" > ${shellQuote(this.argvFile)}`,
      `readlink "/proc/$$/fd/0" > ${shellQuote(this.stdinFile)}`,
      "echo 'stub stdout noise'",
      "echo 'stub stderr noise' >&2",
      "",
    ].join("\n"));
    chmodSync(this.path(".mast", "bin", "mast-notify.sh"), 0o755);
  }

  hook(args: string[], input: string | Buffer, env: NodeJS.ProcessEnv): HookRun {
    const result = spawnSync(tools.bash, [AGY_HOOK, ...args], {
      env: this.env(env),
      input,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  notifyArgs(): string[] | undefined {
    if (!existsSync(this.argvFile)) return undefined;
    const fields = readFileSync(this.argvFile, "utf8").split("\0");
    const count = Number(fields.shift());
    return fields.slice(0, count);
  }
}

const stopPayload = (finalModelOutput: unknown) =>
  JSON.stringify({
    conversationId: "ec33ebf9-0cba-4100-8142-c61503f6c587",
    executionNum: 1,
    terminationReason: "model_stop",
    fullyIdle: true,
    finalModelOutput,
  });

linuxSuite("mast-agy-hook.sh", () => {
  function withStub(test: (home: AgyHookHome) => void): void {
    const home = new AgyHookHome();
    home.installStub();
    test(home);
  }

  it("answers exactly {} and reports running through mast-notify.sh with stdin closed", () => {
    withStub((home) => {
      const run = home.hook(["running"], JSON.stringify({ invocationNum: 3, initialNumSteps: 10 }), IN_TAB);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("{}\n");
      expect(run.stderr).toBe("");
      expect(home.notifyArgs()).toEqual(["mast:running"]);
      expect(readFileSync(home.stdinFile, "utf8")).toBe("/dev/null\n");
    });
  });

  it("sends the first line of finalModelOutput as the idle body", () => {
    withStub((home) => {
      const run = home.hook(["idle"], stopPayload("Fixed the bug; tests pass\n\nDetails follow"), IN_TAB);
      expect(run.stdout).toBe("{}\n");
      expect(home.notifyArgs()).toEqual(["mast:idle", "Fixed the bug; tests pass"]);
      expect(readFileSync(home.stdinFile, "utf8")).toBe("/dev/null\n");
    });
  });

  it("turns control characters into spaces and caps the body at 500 characters", () => {
    withStub((home) => {
      home.hook(["idle"], stopPayload("tab\there\u0007bell\u001b[31mred\r"), IN_TAB);
      expect(home.notifyArgs()).toEqual(["mast:idle", "tab here bell [31mred "]);
      home.hook(["idle"], stopPayload("x".repeat(600)), IN_TAB);
      expect(home.notifyArgs()).toEqual(["mast:idle", "x".repeat(500)]);
    });
  });

  it("sanitizes C1 controls and cuts at 500 code points under LC_ALL=C", () => {
    withStub((home) => {
      const cLocale = { ...IN_TAB, LC_ALL: "C" };
      home.hook(["idle"], stopPayload("a;b\u009c c\u001b]x\u0007 d\u0085e \u009b2J"), cLocale);
      expect(home.notifyArgs()).toEqual(["mast:idle", "a;b  c ]x  d e  2J"]);
      home.hook(["idle"], stopPayload("가".repeat(600)), cLocale);
      expect(home.notifyArgs()).toEqual(["mast:idle", "가".repeat(500)]);
      home.hook(["idle"], stopPayload(`${"a".repeat(499)}가나`), cLocale);
      expect(home.notifyArgs()).toEqual(["mast:idle", `${"a".repeat(499)}가`]);
    });
  });

  it.each([
    ["no finalModelOutput", JSON.stringify({ terminationReason: "error" })],
    ["an empty finalModelOutput", stopPayload("")],
    ["a blank first line", stopPayload("\nsecond line")],
    ["a first line of only controls and spaces", stopPayload(" \t\u009c \nsecond line")],
    ["a non-string finalModelOutput", stopPayload(42)],
    ["a payload that is not JSON", "not json"],
    ["an empty stdin", ""],
  ])("falls back to done for %s", (_name, payload) => {
    withStub((home) => {
      const run = home.hook(["idle"], payload, IN_TAB);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("{}\n");
      expect(home.notifyArgs()).toEqual(["mast:idle", "done"]);
    });
  });

  it("falls back to done when jq is not on PATH", () => {
    withStub((home) => {
      const bin = join(home.root, "tools-without-jq");
      mkdirSync(bin, { recursive: true });
      for (const tool of ["head", "cat", "readlink"]) symlinkSync(tools[tool], join(bin, tool));
      const run = home.hook(["idle"], stopPayload("would be the body"), { ...IN_TAB, PATH: bin });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("{}\n");
      expect(home.notifyArgs()).toEqual(["mast:idle", "done"]);
    });
  });

  it.each([
    ["MAST_TAB unset", {}],
    ["an empty MAST_TAB", { MAST_TAB: "" }],
    ["a MAST_TAB that is not a number", { MAST_TAB: "abc" }],
    ["a MAST_TAB with a suffix", { MAST_TAB: "7a" }],
    ["a negative MAST_TAB", { MAST_TAB: "-7" }],
    ["CLAUDECODE=1", { ...IN_TAB, CLAUDECODE: "1" }],
    ["an empty CLAUDECODE", { ...IN_TAB, CLAUDECODE: "" }],
    ["CODEX_THREAD_ID", { ...IN_TAB, CODEX_THREAD_ID: "019a0000-0000-7000-8000-000000000000" }],
  ])("emits nothing but still answers {} with %s", (_name, env) => {
    withStub((home) => {
      for (const token of ["running", "idle"]) {
        const run = home.hook([token], stopPayload("hidden"), env);
        expect(run.status).toBe(0);
        expect(run.stdout).toBe("{}\n");
      }
      expect(home.notifyArgs()).toBeUndefined();
    });
  });

  it.each([[[]], [["waiting"]]])("ignores the arguments %j", (args) => {
    withStub((home) => {
      const run = home.hook(args, "{}", IN_TAB);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("{}\n");
      expect(home.notifyArgs()).toBeUndefined();
    });
  });

  it("drains a payload larger than the 1 MiB it keeps", () => {
    withStub((home) => {
      const huge = stopPayload(`first line\n${"y".repeat(3 * 1024 * 1024)}`);
      const run = home.hook(["idle"], huge, IN_TAB);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("{}\n");
      // 잘린 JSON 은 파싱되지 않으므로 본문은 기본값이다.
      expect(home.notifyArgs()).toEqual(["mast:idle", "done"]);
    });
  });

  it("still answers {} when mast-notify.sh is missing", () => {
    const home = new AgyHookHome();
    const run = home.hook(["running"], "{}", IN_TAB);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("{}\n");
  });

  it("runs every command of the merged hooks.json through sh -c the way agy does", () => {
    withStub((home) => {
      const installed = home.path(".mast", "bin", "mast-agy-hook.sh");
      copyFileSync(AGY_HOOK, installed);
      chmodSync(installed, 0o755);
      const hooks = home.path(".gemini", "config", "hooks.json");
      expect(home.merge("agy", hooks).status).toBe(0);
      const definition = readJson(hooks).mast;

      const expectations: [event: string, payload: string, argv: string[]][] = [
        ["PreInvocation", JSON.stringify({ invocationNum: 1 }), ["mast:running"]],
        ["Stop", stopPayload("Merged and ran\nmore"), ["mast:idle", "Merged and ran"]],
      ];
      expect(Object.keys(definition)).toEqual(expectations.map(([event]) => event));
      for (const [event, payload, argv] of expectations) {
        expect(definition[event]).toHaveLength(1);
        rmSync(home.argvFile, { force: true });
        // agy 는 handler.command 를 `sh -c` 로, hooks.json 이 있는 디렉터리에서 실행한다.
        const result = spawnSync(tools.sh, ["-c", definition[event][0].command], {
          cwd: dirname(hooks),
          env: home.env(IN_TAB),
          input: payload,
          encoding: "utf8",
          timeout: 10_000,
        });
        if (result.error) throw result.error;
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("{}\n");
        expect(home.notifyArgs()).toEqual(argv);
      }
    });
  });

  it("reaches the terminal through the real mast-notify.sh without writing a resume hint", () => {
    const home = new AgyHookHome();
    const notify = home.write(home.path(".mast", "bin", "mast-notify.sh"), extractNotifyScript(provisionSource));
    chmodSync(notify, 0o755);
    const payload = home.write(join(home.root, "payload.json"), stopPayload("All tests pass; shipped\nmore"));
    // script 가 새 pty 를 만들어 준다. /dev/tty 로 가는 OSC 와 훅의 stdout 이 그 pty 출력으로 함께 잡히고,
    // 테스트를 돌리는 터미널에는 아무것도 새지 않는다.
    const result = spawnSync(
      tools.script,
      ["-qec", `${shellQuote(tools.bash)} ${shellQuote(AGY_HOOK)} idle < ${shellQuote(payload)}`, "/dev/null"],
      {
        env: home.env({ SHELL: tools.bash, MAST_TAB: "6" }),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      },
    );
    if (result.error) throw result.error;

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("\u001b]777;notify;mast:idle;All tests pass, shipped\u0007{}\r\n");
    expect(existsSync(home.path(".mast", "resume"))).toBe(false);
  });
});
