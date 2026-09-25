// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { assembleSetupScript, embeddedFiles, setupVersion } from "./setup-script";

// 설치 스크립트 전체를 WSL 에서처럼 bash -s 로 흘려 넣는다. Windows 러너에는 bash·/proc 가 없어
// 건너뛰고, Linux 에서 도구가 없으면 skip 이 아니라 실패로 드러낸다.
const onLinux = process.platform === "linux";
const linuxSuite = onLinux ? describe : describe.skip;

// 설치 스크립트와 merge 헬퍼가 쓰는 도구만 PATH 에 둔다. 개발기에 설치된 진짜 claude·codex·agy 가
// 버전 확인에 잡히면 결과가 기기마다 달라진다.
const TOOL_NAMES = ["bash", "python3", "date", "mkdir", "cat", "chmod", "mv", "rm", "grep", "awk", "head", "timeout", "env", "readlink", "mktemp"];

function commandPath(command: string): string {
  const result = spawnSync("/usr/bin/env", ["-i", "PATH=/usr/local/bin:/usr/bin:/bin", "bash", "--noprofile", "--norc", "-c", `command -v ${command}`], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const path = result.stdout?.trim();
  if (result.status !== 0 || !path?.startsWith("/")) throw new Error(`provisioning tests require ${command}`);
  return path;
}

const tools: Record<string, string> = {};
if (onLinux) for (const name of [...TOOL_NAMES, "sleep"]) tools[name] = commandPath(name);

const VERSION = setupVersion();
const SCRIPT = assembleSetupScript();
const ROOT = mkdtempSync(join(tmpdir(), "mast provision setup-"));
const WSL_SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/wsl");
// 개발기에 uv 로 받아 둔 실제 3.8 이 있으면 경계 버전을 진짜 인터프리터로도 확인한다.
const PYTHON38 = join(homedir(), ".local/share/uv/python/cpython-3.8-linux-x86_64-gnu/bin/python3.8");
// Windows 쪽 설치본을 흉내 내려면 /mnt 아래에 실행 파일을 둬야 한다. WSL 개발기의 /mnt/wsl 은 누구나 쓸 수 있고, CI
// 러너에서는 쓸 수 있는 곳이 없으면 그 케이스를 건너뛴다.
const MNT_ROOT = (() => {
  if (!onLinux) return null;
  for (const base of ["/mnt/wsl", "/mnt"]) {
    try {
      return mkdtempSync(join(base, "mast-provision-"));
    } catch {
      // 다음 후보
    }
  }
  return null;
})();

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  if (MNT_ROOT) rmSync(MNT_ROOT, { recursive: true, force: true });
});

// 표에서 뽑지 않고 적어 둔다. 표에서 항목이 빠지면 heredoc 의 자리표시자 줄이 그대로 설치되는데, 표에서 뽑은
// 목록은 그 파일을 보지 않는다.
const INSTALLED_FROM_REPO: [name: string, executable: boolean][] = [
  ["mast-config.py", false],
  ["mast-browser.py", false],
  ["mast-manager.py", false],
  ["mast-manager-harness.py", false],
  ["mast-hooks-merge.py", false],
  ["mast-agent-hook.py", false],
  ["mast-claude-hook.sh", true],
  ["mast-codex-hook.sh", true],
  ["mast-agy-hook.sh", true],
  ["mast-opencode-plugin.js", false],
];

const NOTIFY_CMD = '"$HOME/.mast/bin/mast-notify.sh"';
const CLAUDE_HOOK_CMD = '"$HOME/.mast/bin/mast-claude-hook.sh"';
const CODEX_HOOK_CMD = '"$HOME/.mast/bin/mast-codex-hook.sh"';
const AGY_HOOK_CMD = '"$HOME/.mast/bin/mast-agy-hook.sh"';
const NEEDS_INPUT_MATCHER = [
  "permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
  "quota_auto_resume_stale",
  "worker_permission_prompt",
].join("|");

const claudeGroup = (command: string, matcher = "") => ({ matcher, hooks: [{ type: "command", command }] });
const running = claudeGroup(`${NOTIFY_CMD} mast:running`);
const needsInput = claudeGroup(`${NOTIFY_CMD} mast:needsInput 'needs input'`, NEEDS_INPUT_MATCHER);
const idle = claudeGroup(`${NOTIFY_CMD} mast:idle done`);
const dispatcher = claudeGroup(CLAUDE_HOOK_CMD);

const CLAUDE_STATUS_ONLY = { hooks: { UserPromptSubmit: [running], Notification: [needsInput], Stop: [idle] } };
const CLAUDE_WITH_DISPATCHER = {
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
  hooks: [{ type: "command", command: CODEX_HOOK_CMD, timeout, ...(async ? { async: true } : {}) }],
});
const CODEX_HOOKS = {
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

const AGY_HOOKS = {
  mast: {
    PreInvocation: [{ type: "command", command: `${AGY_HOOK_CMD} running`, timeout: 5 }],
    Stop: [{ type: "command", command: `${AGY_HOOK_CMD} idle`, timeout: 5 }],
  },
};

// setup v13 이 실제로 쓴 settings.json 은 이 객체의 JSON.stringify(…, null, 2) + "\n" 과 바이트까지 같다
// (provision-hooks.test.ts 가 88714ad 의 출력 원문을 고정해 둔 V13_FRESH 와 대조).
const V13_SETTINGS = {
  hooks: {
    UserPromptSubmit: [running],
    Notification: [claudeGroup(`${NOTIFY_CMD} mast:needsInput 'needs input'`)],
    Stop: [idle],
  },
};
// 88714ad 의 설치 스크립트를 `model = "gpt-5"` 한 줄짜리 config.toml 에 돌린 결과다.
const V13_CODEX_CONFIG = [
  'model = "gpt-5"',
  "",
  "# mast: notify on turn completion (added automatically; delete these two lines to opt out)",
  `notify = ["bash", "-lc", 'exec "$HOME/.mast/bin/mast-codex-notify.sh" "$0"']`,
  "",
].join("\n");

const EXECUTABLES = ["mast-notify.sh", "mast-codex-notify.sh", "mast", "mast-send.sh", "mast-open", "xdg-open"];

type Agent = "claude" | "codex" | "agy";
type Run = { status: number | null; stdout: string; stderr: string[] };
type Python =
  | { interpreter: string }
  // 설치 스크립트의 버전 검사 코드를 그대로 돌리되 sys.version_info 만 이 값으로 바꾼다.
  | { reports: [number, number, number] };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fileText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fingerprint(path: string): { text: string; ino: number; mtimeMs: number } {
  const stats = statSync(path);
  return { text: readFileSync(path, "utf8"), ino: stats.ino, mtimeMs: stats.mtimeMs };
}

class Distro {
  readonly root = mkdtempSync(join(ROOT, "case-"));
  readonly home = join(this.root, "home with spaces");
  readonly tools = join(this.root, "tools");
  readonly stubs = join(this.root, "stubs");
  readonly callsFile = join(this.root, "agent-calls");
  // 설치 스크립트 PATH 의 stubs 앞에 들어간다.
  readonly pathDirs: string[] = [];

  constructor(options: { python?: Python } = {}) {
    for (const dir of [this.home, this.tools, this.stubs]) mkdirSync(dir, { recursive: true });
    for (const name of TOOL_NAMES) {
      if (name === "python3" && options.python) continue;
      symlinkSync(tools[name], join(this.tools, name));
    }
    if (options.python) this.python(options.python);
  }

  python(python: Python, path = join(this.tools, "python3")): void {
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
    if ("interpreter" in python) {
      symlinkSync(python.interpreter, path);
      return;
    }
    // 기준 버전을 바꾼 회귀가 드러나도록 비교식은 실제로 실행한다. merge 헬퍼처럼 -c 가 아닌 호출은 진짜
    // python 에 넘긴다. 헬퍼는 3.6 호환이라 실제 구버전에서도 같은 결과다.
    const prelude =
      "import sys; code = sys.argv.pop(1); " +
      `sys.version_info = (${python.reports.join(", ")}, "final", 0); exec(compile(code, "<string>", "exec"))`;
    this.executable(
      path,
      [
        `#!${tools.bash}`,
        `if [ "\${1:-}" = -c ]; then code="$2"; shift 2; exec ${shellQuote(tools.python3)} -c ${shellQuote(prelude)} "$code" "$@"; fi`,
        `exec ${shellQuote(tools.python3)} "$@"`,
        "",
      ].join("\n"),
    );
  }

  path(...parts: string[]): string {
    return join(this.home, ...parts);
  }

  write(path: string, content: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  executable(path: string, content: string): void {
    this.write(path, content);
    chmodSync(path, 0o755);
  }

  // 버전 출력만 흉내 낸다. 설치 스크립트가 에이전트를 버전 확인 말고 다른 방식으로 부르거나 stdin 을
  // 열어 둔 채 부르면 기록에 드러난다. afterVersion 은 버전을 찍은 뒤 끝나기 전에 도는 줄이다.
  agent(name: Agent, versionOutput: string, dir = this.stubs, shebang = `#!${tools.bash}`, afterVersion: string[] = []): string {
    const path = join(dir, name);
    this.executable(
      path,
      [
        shebang,
        `printf '%s\\t%s\\t%s\\n' "$0" "$*" "$(readlink /proc/$$/fd/0)" >> ${shellQuote(this.callsFile)}`,
        `if [ "\${1:-}" = --version ]; then`,
        `  printf '%s\\n' ${shellQuote(versionOutput)}`,
        ...afterVersion,
        "  exit 0",
        "fi",
        "exit 64",
        "",
      ].join("\n"),
    );
    return path;
  }

  // npm 이 설치한 shim 의 모양: `#!/usr/bin/env mast-test-node` 인 에이전트가 같은 bin 의 인터프리터로 돈다. 그
  // 인터프리터는 설치 스크립트의 PATH 에 없다.
  npmAgent(name: Agent, versionOutput: string, dir: string): string {
    this.executable(join(dir, "mast-test-node"), `#!${tools.bash}\nexec ${shellQuote(tools.bash)} "$@"\n`);
    return this.agent(name, versionOutput, dir, "#!/usr/bin/env mast-test-node");
  }

  // 인터프리터를 찾지 못해 --version 이 아무것도 내지 못하는 설치본.
  brokenAgent(name: Agent, dir: string): string {
    return this.agent(name, "0.0.0", dir, "#!/usr/bin/env mast-test-missing-node");
  }

  withCodex(version = "codex-cli 0.154.0"): this {
    this.write(this.path(".codex", "config.toml"), 'model = "gpt-5"\n');
    this.agent("codex", version);
    return this;
  }

  withAgy(version = "1.1.13"): this {
    mkdirSync(this.path(".gemini", "antigravity-cli"), { recursive: true });
    this.agent("agy", version);
    return this;
  }

  // curl 설치본의 자리. OpenCode 플러그인 단계는 이 실행 파일의 존재만 보고 설치한다 (버전 확인 없음).
  withOpencode(): this {
    this.executable(this.path(".opencode", "bin", "opencode"), "#!/bin/sh\nexit 0\n");
    return this;
  }

  // Codex·Antigravity CLI·OpenCode 가 설치된 distro 의 모양. 설치 스크립트는 이 디렉터리로 설치 여부를 판단한다.
  withAgents(versions: Partial<Record<Agent, string>> = {}): this {
    this.agent("claude", versions.claude ?? "2.1.270 (Claude Code)");
    return this.withOpencode().withCodex(versions.codex).withAgy(versions.agy);
  }

  run(script = SCRIPT): Run {
    const result = spawnSync(tools.bash, ["-s"], {
      input: script,
      cwd: this.home,
      env: { HOME: this.home, PATH: [...this.pathDirs, this.stubs, this.tools].join(":") },
      encoding: "utf8",
      timeout: 60_000,
    });
    // 마커가 있으면 bash 가 앞부분만 읽고 끝나 나머지 쓰기가 EPIPE 가 된다. 앱(provision.rs run)도
    // 그 경우를 종료 코드로 판정한다.
    if (result.error && (result.error as NodeJS.ErrnoException).code !== "EPIPE") throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr.split("\n").filter(Boolean) };
  }

  log(): string {
    const path = this.path(".mast", "setup.log");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  marker(): boolean {
    return existsSync(this.path(".mast", `.setup-v${VERSION}`));
  }

  agentMarker(agent: "codex" | "agy"): boolean {
    return existsSync(this.path(".mast", `.setup-v${VERSION}-${agent}`));
  }

  // "<프로그램 이름> <인자> <stdin>" 줄들.
  calls(): string[] {
    return this.rawCalls().map(([program, args, stdin]) => `${basename(program)} ${args} ${stdin}`);
  }

  callers(): string[] {
    return this.rawCalls().map(([program]) => program);
  }

  private rawCalls(): string[][] {
    if (!existsSync(this.callsFile)) return [];
    return readFileSync(this.callsFile, "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"));
  }

  claudeSettings(): string {
    return this.path(".claude", "settings.json");
  }

  codexHooks(): string {
    return this.path(".codex", "hooks.json");
  }

  agyHooks(): string {
    return this.path(".gemini", "config", "hooks.json");
  }

  trustNotice(kind: "launch" | "slash" = "launch"): string {
    return kind === "launch"
      ? `[mast] setup: Codex hooks are installed in ${this.codexHooks()} but will not run until you trust them ` +
          'in "Hooks need review" on the next Codex launch.'
      : `[mast] setup: Codex hooks are installed in ${this.codexHooks()} but will not run until you trust them ` +
          'from /hooks in Codex; this Codex has no "Hooks need review" prompt at launch.';
  }
}

const PYTHON_NOTICE =
  "[mast] setup: Python 3.8+ is needed for mast's Claude/Codex approval tracking; install it and run " +
  `rm ~/.mast/.setup-v${VERSION} to retry`;
const CODEX_PYTHON_NOTICE =
  `[mast] setup: Python 3.8+ is needed for mast's Codex hooks; install it and run rm ~/.mast/.setup-v${VERSION}-codex to retry`;
const PYTHON3_MISSING_NOTICE =
  "[mast] setup: python3 not found in this distro; install it to let mast wire the agent hooks " +
  "(or wire them by hand: scripts/wsl/claude-hook-example.md)";

const CLAUDE_NOTICES = {
  unreadable: (path: string) =>
    `[mast] setup: cannot read the version of Claude Code at ${path}, and mast's approval tracking needs Claude Code ` +
    `2.1.118 or later, so mast wired only its status hooks; once '${path} --version' works or that copy is removed, ` +
    `run rm ~/.mast/.setup-v${VERSION} to add approval tracking`,
  ignoresSettings: (version: string, path: string) =>
    `[mast] setup: Claude Code ${version} at ${path} ignores all of ~/.claude/settings.json when it names a hook ` +
    "event it does not know (fixed in 2.1.101), so mast wired only its status hooks; update that copy to 2.1.118 or " +
    `later or remove it, and run rm ~/.mast/.setup-v${VERSION} to add approval tracking`,
  noPostToolBatch: (version: string, path: string) =>
    `[mast] setup: Claude Code ${version} at ${path} has no PostToolBatch hook (added in 2.1.118), which mast's ` +
    "approval tracking needs to clear an approval whose tool call never ran, so mast wired only its status hooks; " +
    `update or remove that copy and run rm ~/.mast/.setup-v${VERSION} to add approval tracking`,
};

const CODEX_LIMITS = {
  off: "hooks are off by default before 0.124.0, so none of them run",
  untrusted: "hooks run without a trust review before 0.129.0",
  subagentStop: "SubagentStop arrived in 0.133.0, so an approval a subagent never finished can keep the tab at needs input",
  async: "async hooks are skipped with a warning before 0.148.0, so Codex approvals never show as needs input",
  interrupt: "Interrupt arrived in 0.150.0, so after Esc the tab can stay running or needs input until the next prompt",
};

const codexNotice = (version: string, path: string, limits: readonly (keyof typeof CODEX_LIMITS)[]) =>
  `[mast] setup: Codex ${version} at ${path} predates parts of mast's Codex hooks: ` +
  `${limits.map((limit) => CODEX_LIMITS[limit]).join("; ")}. Update or remove that copy to lift these.`;

const agyNotice = (version: string, path: string) =>
  `[mast] setup: Antigravity CLI ${version} at ${path} never runs hooks.json Stop hooks (fixed in 1.1.10), so a tab ` +
  "stays running after agy finishes a turn; update or remove that copy";

const REFUSED_NOTICES = {
  codex:
    "[mast] setup: Codex hooks were not installed, and mast will not retry until you edit ~/.codex/hooks.json and " +
    `run rm ~/.mast/.setup-v${VERSION}-codex; to stop mast from installing them, create ~/.mast/no-codex-hooks`,
  agy:
    "[mast] setup: Antigravity CLI hooks were not installed, and mast will not retry until you edit " +
    `~/.gemini/config/hooks.json and run rm ~/.mast/.setup-v${VERSION}-agy; to stop mast from installing them, ` +
    "create ~/.mast/no-agy-hooks",
};

const AGENT_ONLY_LOG = `setup v${VERSION} exists; running only the missing agent steps`;
const FULL_RUN_LOG = `setup v${VERSION} starting`;

linuxSuite("provisioning script (setup_script() as streamed into bash -s)", { timeout: 120_000 }, () => {
  it("passes bash -n with every placeholder replaced by its tracked file", () => {
    const check = spawnSync(tools.bash, ["-n"], { input: SCRIPT, encoding: "utf8", timeout: 10_000 });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    expect(SCRIPT).not.toMatch(/@[A-Z_]+@/);
    expect(embeddedFiles().map((file) => file.installedName).sort()).toEqual([...INSTALLED_FROM_REPO.map(([name]) => name), "SKILL.md", "SKILL.md"].sort());
    for (const file of embeddedFiles()) {
      expect(SCRIPT).toContain(`<<'${file.delimiter}'\n${readFileSync(file.path, "utf8")}${file.delimiter}\n`);
    }
  });

  it("installs the scripts, the interpreter path, every hook file and the markers on a fresh distro", () => {
    const distro = new Distro().withAgents();
    const run = distro.run();

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toEqual([distro.trustNotice()]);
    expect(distro.marker()).toBe(true);
    expect(distro.agentMarker("codex")).toBe(true);
    expect(distro.agentMarker("agy")).toBe(true);

    for (const [name, executable] of INSTALLED_FROM_REPO) {
      const installed = distro.path(".mast", "bin", name);
      expect(readFileSync(installed, "utf8")).toBe(readFileSync(join(WSL_SCRIPTS, name), "utf8"));
      if (executable) expect(statSync(installed).mode & 0o111).not.toBe(0);
    }
    for (const name of EXECUTABLES) expect(statSync(distro.path(".mast", "bin", name)).mode & 0o111).not.toBe(0);
    expect(readFileSync(distro.path(".mast", "bin", "mast-python"), "utf8")).toBe(`${join(distro.tools, "python3")}\n`);

    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_WITH_DISPATCHER);
    expect(readJson(distro.codexHooks())).toEqual(CODEX_HOOKS);
    expect(readJson(distro.agyHooks())).toEqual(AGY_HOOKS);
    expect(readFileSync(distro.path(".codex", "config.toml"), "utf8")).toContain("mast-codex-notify.sh");

    expect(distro.calls().sort()).toEqual(["agy --version /dev/null", "claude --version /dev/null", "codex --version /dev/null"]);
    expect(readdirSync(distro.path(".mast")).filter((name) => name.startsWith(".setup-notices"))).toEqual([]);
    const log = distro.log();
    for (const line of [
      `dispatcher python: ${join(distro.tools, "python3")} (`,
      `claude: ${join(distro.stubs, "claude")} --version reports 2.1.270`,
      "claude: added PostToolBatch role=dispatcher",
      "codex: added PermissionRequest",
      "codex: app-server-control-socket=absent",
      "agy: added mast",
      distro.trustNotice(),
      `setup v${VERSION} complete`,
    ]) {
      expect(log).toContain(line);
    }
  });

  it("installs the mast usage skill where Claude Code, Codex and Antigravity CLI discover it", () => {
    const distro = new Distro().withAgents();

    const run = distro.run();

    expect(run.status).toBe(0);
    expect(run.stderr).toEqual([distro.trustNotice()]);
    const skill = readFileSync(join(WSL_SCRIPTS, "skills", "mast", "SKILL.md"), "utf8");
    for (const installed of [
      distro.path(".claude", "skills", "mast", "SKILL.md"),
      distro.path(".codex", "skills", "mast", "SKILL.md"),
      distro.path(".gemini", "config", "skills", "mast", "SKILL.md"),
    ]) {
      expect(readFileSync(installed, "utf8")).toBe(skill);
    }
    // mast-send 는 같은 가드로 설치된다 — 내용도 레포 사본 그대로다.
    expect(readFileSync(distro.path(".claude", "skills", "mast-send", "SKILL.md"), "utf8")).toBe(
      readFileSync(join(WSL_SCRIPTS, "skills", "mast-send", "SKILL.md"), "utf8"),
    );
  });

  it("overwrites edited skills and replaces directory links without modifying their targets", () => {
    const distro = new Distro().withAgents();
    mkdirSync(distro.path(".codex", "skills"), { recursive: true });
    const personal = distro.write(distro.path("personal", "mast", "SKILL.md"), "# my own mast skill\n");
    symlinkSync(dirname(personal), distro.path(".codex", "skills", "mast"), "dir");
    // 기본 스킬의 개인 수정도 원본으로 교체한다.
    const edited = distro.write(distro.path(".claude", "skills", "mast", "SKILL.md"), "# edited after install\n");
    distro.write(distro.path(".claude", "skills", "mast", ".mast-installed"), "# originally installed\n");

    const run = distro.run();

    expect(run.status).toBe(0);
    expect(readFileSync(edited, "utf8")).toBe(readFileSync(join(WSL_SCRIPTS, "skills", "mast", "SKILL.md"), "utf8"));
    expect(readFileSync(personal, "utf8")).toBe("# my own mast skill\n");
    expect(lstatSync(distro.path(".codex", "skills", "mast")).isSymbolicLink()).toBe(false);
    expect(readFileSync(distro.path(".codex", "skills", "mast", "SKILL.md"), "utf8")).toBe(readFileSync(edited, "utf8"));
  });

  // 예전 설치기는 `$dest.tmp`라는 고정 이름에 썼다. 그 자리에 개인 파일로 가는 심볼릭 링크가
  // 있으면 리다이렉션이 링크를 따라가 개인 파일을 덮어쓰고 SKILL.md 자체도 심볼릭 링크가 됐다
  // (exit 0 으로). 이제는 mktemp로 이 실행만의 이름을 만들므로 심어 둔 이름은 건드리지 않는다.
  it("never writes through a planted SKILL.md.tmp or .mast-installed.tmp symlink", () => {
    const distro = new Distro().withAgents();
    const skillDir = distro.path(".claude", "skills", "mast");
    mkdirSync(skillDir, { recursive: true });
    const plantedSkill = distro.write(distro.path("personal", "planted-skill.md"), "# personal skill\n");
    const plantedSidecar = distro.write(distro.path("personal", "planted-sidecar.md"), "# personal sidecar\n");
    symlinkSync(plantedSkill, join(skillDir, "SKILL.md"));
    symlinkSync(plantedSkill, join(skillDir, "SKILL.md.tmp"));
    symlinkSync(plantedSidecar, join(skillDir, ".mast-installed.tmp"));

    const run = distro.run();

    expect(run.status).toBe(0);
    expect(readFileSync(plantedSkill, "utf8")).toBe("# personal skill\n");
    expect(readFileSync(plantedSidecar, "utf8")).toBe("# personal sidecar\n");
    const installed = readFileSync(join(WSL_SCRIPTS, "skills", "mast", "SKILL.md"), "utf8");
    expect(lstatSync(join(skillDir, "SKILL.md")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(skillDir, ".mast-installed"))).toBe(false);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(installed);
    expect(statSync(join(skillDir, "SKILL.md")).mode & 0o777).toBe(0o644);
    // 심어 둔 이름 자체는 마스트 소유가 아니므로 지우지 않는다.
    expect(lstatSync(join(skillDir, "SKILL.md.tmp")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(skillDir, ".mast-installed.tmp")).isSymbolicLink()).toBe(true);
    // 이 실행이 만든 전용 임시 파일은 mv 로 사라지고 남지 않는다.
    expect(readdirSync(skillDir).filter((name) => name.startsWith(".mast-install."))).toEqual([]);
  });

  // mktemp 실패가 미초기화 변수 오류에 가려지지 않도록 확인한다.
  it("reports the failure and exits 1 when mktemp itself fails", () => {
    const distro = new Distro();
    const installer = SCRIPT.match(/^install_agent_skill\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
    if (!installer) throw new Error("install_agent_skill disappeared from the setup script");
    const stubDir = join(distro.root, "failing-tools");
    distro.executable(join(stubDir, "mktemp"), `#!${tools.bash}\nexit 1\n`);
    const skillDir = distro.path(".claude", "skills", "mast");
    const harness = distro.write(
      distro.path("mktemp-failure.sh"),
      ["set -u", "log() { :; }", "notice() { printf '[mast] setup: %s\\n' \"$*\" >&2; }", installer, `install_agent_skill ${shellQuote(skillDir)} body`, ""].join("\n"),
    );
    // 실제 도구는 경로에 두고 mktemp 만 이 스텁이 먼저 잡히게 한다.
    const path = [...new Set([stubDir, ...Object.values(tools).map((tool) => dirname(tool))])].join(":");

    const run = spawnSync(tools.bash, [harness], { encoding: "utf8", timeout: 10_000, env: { PATH: path } });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`[mast] setup: cannot install ${join(skillDir, "SKILL.md")}`);
    expect(run.stderr).not.toContain("unbound variable");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    expect(readdirSync(skillDir).filter((name) => name.startsWith(".mast-install."))).toEqual([]);
  });

  it("replaces outdated and edited bundled copies on each run", () => {
    const distro = new Distro().withAgents();
    const skillPath = distro.path(".claude", "skills", "mast", "SKILL.md");
    distro.write(skillPath, "# older mast copy\n");
    distro.write(distro.path(".claude", "skills", "mast", ".mast-installed"), "# older mast copy\n");

    expect(distro.run().status).toBe(0);
    const skill = readFileSync(join(WSL_SCRIPTS, "skills", "mast", "SKILL.md"), "utf8");
    expect(readFileSync(skillPath, "utf8")).toBe(skill);

    // 마커가 남아 있어도 수정된 기본 스킬은 원본으로 돌아온다.
    writeFileSync(skillPath, "# my edit\n");
    const second = distro.run();
    expect(second.status).toBe(0);
    expect(readFileSync(skillPath, "utf8")).toBe(skill);
    expect(second.stderr).toEqual([]);
  });

  it("마커가 있어도 수정된 스킬을 새 원본으로 덮어쓰고 훅 opt-out은 보존한다", () => {
    const distro = new Distro().withAgents();
    expect(distro.run().status).toBe(0);
    const skillPath = distro.path(".claude", "skills", "mast", "SKILL.md");
    const personal = distro.path(".codex", "skills", "mast", "SKILL.md");
    const custom = distro.write(distro.path(".codex", "skills", "my-mast", "SKILL.md"), "custom instructions\n");
    const personalText = readFileSync(personal, "utf8") + "\n";
    writeFileSync(personal, personalText);
    writeFileSync(distro.claudeSettings(), "{}\n");
    const hooks = fingerprint(distro.claudeSettings());
    const original = readFileSync(join(WSL_SCRIPTS, "skills", "mast", "SKILL.md"), "utf8");
    const updated = original + "\nUpdated bundled instructions.\n";
    const result = distro.run(SCRIPT.replace(original, updated));
    expect(result.status).toBe(0);
    expect(readFileSync(skillPath, "utf8")).toBe(updated);
    expect(readFileSync(personal, "utf8")).toBe(updated);
    expect(readFileSync(custom, "utf8")).toBe("custom instructions\n");
    expect(fingerprint(distro.claudeSettings())).toEqual(hooks);
    expect(distro.calls()).toHaveLength(3);
  });

  it("skill-load는 앱 없이 누락된 사본을 복구하며 인자를 거부한다", () => {
    const distro = new Distro().withAgents();
    expect(distro.run().status).toBe(0);
    const skillPath = distro.path(".codex", "skills", "mast", "SKILL.md");
    rmSync(skillPath);
    const cli = distro.path(".mast", "bin", "mast");
    const options = { env: { HOME: distro.home, PATH: distro.tools }, encoding: "utf8" as const, timeout: 10_000 };
    const result = spawnSync(tools.bash, [cli, "skill-load"], options);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(skillPath, "utf8")).toBe(readFileSync(join(WSL_SCRIPTS, "skills", "mast", "SKILL.md"), "utf8"));
    const before = fingerprint(skillPath);
    expect(spawnSync(tools.bash, [cli, "skill-load"], options).status).toBe(0);
    expect(readFileSync(skillPath, "utf8")).toBe(before.text);
    expect(spawnSync(tools.bash, [cli, "skill-load", "--force"], options).status).toBe(2);
  });

  it("refreshes skills behind the marker without rerunning hooks", () => {
    const distro = new Distro().withAgents();
    expect(distro.run().status).toBe(0);
    const files = [distro.claudeSettings(), distro.codexHooks(), distro.agyHooks()];
    const before = files.map(fingerprint);
    const log = distro.log();

    const skipped = distro.run();
    expect(skipped).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.log().slice(log.length)).not.toContain(FULL_RUN_LOG);
    expect(distro.calls()).toHaveLength(3);

    rmSync(distro.path(".mast", `.setup-v${VERSION}`));
    const again = distro.run();
    expect(again).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(files.map(fingerprint)).toEqual(before);
    const rerunLog = distro.log().slice(log.length);
    for (const line of ["claude: result=unchanged", "codex: result=unchanged", "agy: result=unchanged", `setup v${VERSION} complete`]) {
      expect(rerunLog).toContain(line);
    }
    expect(distro.marker()).toBe(true);
  });

  it("upgrades a v13 install: Notification narrowed, dispatcher rows added, Codex and agy hooks installed", () => {
    const distro = new Distro().withAgents();
    distro.write(distro.path(".mast", ".setup-v13"), "");
    distro.write(distro.path(".mast", "bin", "mast-codex-notify.sh"), "#!/usr/bin/env bash\n# v13 copy\n");
    distro.write(distro.claudeSettings(), fileText(V13_SETTINGS));
    distro.write(distro.path(".codex", "config.toml"), V13_CODEX_CONFIG);

    const run = distro.run();

    expect(run.status).toBe(0);
    expect(run.stderr).toEqual([distro.trustNotice()]);
    expect(distro.marker()).toBe(true);
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_WITH_DISPATCHER);
    expect(readJson(distro.codexHooks())).toEqual(CODEX_HOOKS);
    expect(readJson(distro.agyHooks())).toEqual(AGY_HOOKS);
    expect(readFileSync(distro.path(".codex", "config.toml"), "utf8")).toBe(V13_CODEX_CONFIG);
    expect(readFileSync(distro.path(".mast", "bin", "mast-codex-notify.sh"), "utf8")).toContain("codex-notify");
    const log = distro.log();
    for (const line of [
      "claude: narrowed Notification",
      "claude: wired UserPromptSubmit role=status",
      "claude: added SessionStart role=dispatcher",
      "claude: added Stop role=dispatcher",
      "codex: notify already runs mast-codex-notify.sh",
      "codex: added Interrupt",
    ]) {
      expect(log).toContain(line);
    }
  });

  // v0.3.32 로 나간 main 의 setup v14 는 OpenCode 플러그인만 더한 버전이라 Claude 사용자에게는 상태 훅만
  // 깔린 채 끝났다. 이 브랜치의 훅이 main 과 같은 14 를 쓰면 그 마커에 막혀 영영 재실행되지 않으므로,
  // 옛 v14 마커가 새 실행을 막지 않고 디스패처 행이 깔리는지 고정한다.
  it("upgrades a v14 install that had Claude only: the dispatcher rows are added and the new marker written", () => {
    const distro = new Distro();
    distro.agent("claude", "2.1.270 (Claude Code)");
    distro.write(distro.path(".mast", ".setup-v14"), "");
    distro.write(distro.claudeSettings(), fileText(V13_SETTINGS));

    const run = distro.run();

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toEqual([]);
    expect(existsSync(distro.path(".mast", ".setup-v14"))).toBe(true);
    expect(distro.marker()).toBe(true);
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_WITH_DISPATCHER);
    expect(existsSync(distro.codexHooks())).toBe(false);
    expect(existsSync(distro.agyHooks())).toBe(false);
    const log = distro.log();
    expect(log).toContain(FULL_RUN_LOG);
    for (const line of ["claude: narrowed Notification", "claude: added SessionStart role=dispatcher", "claude: added Stop role=dispatcher"]) {
      expect(log).toContain(line);
    }
  });

  // 이 브랜치의 에이전트 상태 빌드(#37)가 남긴 v15 마커도 16 보다 낮다. 16 으로 올린 이유가 그
  // 마커에 막히지 않고 새 config helper(showTabIds)를 다시 깔기 위해서이므로, v15 마커가 전체
  // 실행을 막지 않고 옛 helper 사본을 현재 사본으로 갈아 놓는지 고정한다.
  it("upgrades a v15 install from this branch's agent-state builds: the full run redelivers the config helper", () => {
    const distro = new Distro();
    distro.agent("claude", "2.1.270 (Claude Code)");
    distro.write(distro.path(".mast", ".setup-v15"), "");
    distro.write(distro.path(".mast", "bin", "mast-config.py"), "# v15 copy without showTabIds\n");

    const run = distro.run();

    expect(run.status).toBe(0);
    expect(distro.marker()).toBe(true);
    // 옛 마커는 지우지 않는다 — 마커 정리는 사용자 몫이다.
    expect(existsSync(distro.path(".mast", ".setup-v15"))).toBe(true);
    expect(readFileSync(distro.path(".mast", "bin", "mast-config.py"), "utf8")).toBe(
      readFileSync(join(WSL_SCRIPTS, "mast-config.py"), "utf8"),
    );
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_WITH_DISPATCHER);
    const log = distro.log();
    expect(log).toContain(FULL_RUN_LOG);
    expect(log).not.toContain(AGENT_ONLY_LOG);
  });

  it("skips the Codex and Antigravity CLI hooks behind their opt-out markers and records both steps as done", () => {
    const distro = new Distro().withAgents();
    distro.write(distro.path(".mast", "no-codex-hooks"), "");
    distro.write(distro.path(".mast", "no-agy-hooks"), "");

    const run = distro.run();

    expect(run).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.marker()).toBe(true);
    expect(distro.agentMarker("codex")).toBe(true);
    expect(distro.agentMarker("agy")).toBe(true);
    expect(existsSync(distro.codexHooks())).toBe(false);
    expect(existsSync(distro.agyHooks())).toBe(false);
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_WITH_DISPATCHER);
    expect(distro.calls()).toEqual(["claude --version /dev/null"]);
    expect(distro.log()).toContain("codex hooks: ~/.mast/no-codex-hooks exists; skipped");
    expect(distro.log()).toContain("agy hooks: ~/.mast/no-agy-hooks exists; skipped");

    const log = distro.log();
    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.log().slice(log.length)).not.toContain(FULL_RUN_LOG);
  });

  it("creates nothing for agents that are not installed and does not guard a distro without Claude Code", () => {
    const distro = new Distro();

    const run = distro.run();

    expect(run).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.marker()).toBe(true);
    expect(distro.agentMarker("codex")).toBe(false);
    expect(distro.agentMarker("agy")).toBe(false);
    expect(existsSync(distro.path(".codex"))).toBe(false);
    expect(existsSync(distro.path(".gemini"))).toBe(false);
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_WITH_DISPATCHER);
    const log = distro.log();
    expect(log).toContain("claude: no installation found; hook events not limited by version");
    expect(log).toContain("codex hooks: no ~/.codex; skipped (Codex not installed here)");
    expect(log).toContain("agy hooks: no ~/.gemini/antigravity-cli; skipped (Antigravity CLI not installed here)");
  });

  it.each([
    { name: "Codex", install: (distro: Distro) => distro.withCodex(), file: (distro: Distro) => distro.codexHooks(), hooks: CODEX_HOOKS, agent: "codex" as const },
    { name: "Antigravity CLI", install: (distro: Distro) => distro.withAgy(), file: (distro: Distro) => distro.agyHooks(), hooks: AGY_HOOKS, agent: "agy" as const },
  ])("wires $name installed after this setup version on the next launch with only its own step, once", ({ install, file, hooks, agent }) => {
    const distro = new Distro();
    distro.agent("claude", "2.1.270 (Claude Code)");
    if (agent === "codex") distro.withAgy();
    expect(distro.run().status).toBe(0);
    expect(distro.marker()).toBe(true);
    // 스킬을 갱신해도 이미 설치된 훅 설정은 다시 쓰지 않는다.
    const untouched = [distro.claudeSettings()];
    // 이미 끝난 Antigravity CLI 단계가 다시 돌면 사용자가 지운 mast 훅이 되살아난다.
    if (agent === "codex") {
      untouched.push(distro.write(distro.agyHooks(), "{}\n"));
    }
    const kept = untouched.map(fingerprint);
    const before = distro.log();

    install(distro);
    const rerun = distro.run();

    expect(rerun.status).toBe(0);
    expect(rerun.stderr).toEqual(agent === "codex" ? [distro.trustNotice()] : []);
    expect(readJson(file(distro))).toEqual(hooks);
    expect(distro.agentMarker(agent)).toBe(true);
    expect(untouched.map(fingerprint)).toEqual(kept);
    const rerunLog = distro.log().slice(before.length);
    expect(rerunLog).toContain(AGENT_ONLY_LOG);
    expect(rerunLog).toContain(`${agent} hooks: step done`);
    expect(rerunLog).not.toContain(FULL_RUN_LOG);

    // 훅만 도는 실행도 뒤늦게 설치된 에이전트의 mast 스킬은 전체 설치와 같은 바이트로 채운다.
    const skillDir = agent === "codex" ? distro.path(".codex", "skills", "mast") : distro.path(".gemini", "config", "skills", "mast");
    const skillPath = join(skillDir, "SKILL.md");
    expect(readFileSync(skillPath, "utf8")).toBe(readFileSync(join(WSL_SCRIPTS, "skills", "mast", "SKILL.md"), "utf8"));
    expect(rerunLog).toContain(`skill installed: ${skillPath}`);
    const installedSkill = fingerprint(skillPath);

    // Codex 의 notify 줄과 AGENTS.md 블록은 전체 설치에서만 쓴다.
    if (agent === "codex") {
      expect(readFileSync(distro.path(".codex", "config.toml"), "utf8")).toBe('model = "gpt-5"\n');
      expect(existsSync(distro.path(".codex", "AGENTS.md"))).toBe(false);
    }
    expect(distro.calls().filter((call) => call.startsWith("claude "))).toHaveLength(1);

    const log = distro.log();
    const calls = distro.calls().length;
    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.log().slice(log.length)).not.toContain(FULL_RUN_LOG);
    expect(distro.calls()).toHaveLength(calls);
    // 마커 이후에도 스킬은 같은 원본으로 덮어쓴다.
    expect(readFileSync(skillPath, "utf8")).toBe(installedSkill.text);
  });

  it.each(["codex", "agy"] as const)("나중에 설치한 %s의 스킬 설치 실패는 완료 마커를 남기지 않아 재시도한다", (agent) => {
    const distro = new Distro();
    distro.agent("claude", "2.1.270 (Claude Code)");
    expect(distro.run().status).toBe(0);
    if (agent === "codex") distro.withCodex();
    else distro.withAgy();
    const failingTool = join(distro.stubs, "mktemp");
    distro.executable(failingTool, `#!${tools.bash}\nexit 1\n`);
    const failed = distro.run();
    expect(failed.status).toBe(1);
    expect(failed.stderr.join("\n")).toContain("cannot install");
    expect(distro.agentMarker(agent)).toBe(false);
    rmSync(failingTool);
    expect(distro.run().status).toBe(0);
    expect(distro.agentMarker(agent)).toBe(true);
    const skillPath = agent === "codex"
      ? distro.path(".codex", "skills", "mast", "SKILL.md")
      : distro.path(".gemini", "config", "skills", "mast", "SKILL.md");
    expect(readFileSync(skillPath, "utf8")).toBe(readFileSync(join(WSL_SCRIPTS, "skills", "mast", "SKILL.md"), "utf8"));
  });

  it("after Antigravity CLI arrives, keeps every opt-out the user made since setup and repeats no earlier notice", () => {
    const distro = new Distro().withCodex();
    const claude = distro.agent("claude", "2.1.50 (Claude Code)");
    const first = distro.run();
    expect(first.stderr).toEqual([CLAUDE_NOTICES.ignoresSettings("2.1.50", claude), distro.trustNotice()]);
    const config = distro.path(".codex", "config.toml");
    const agentsFile = distro.path(".codex", "AGENTS.md");
    expect(readFileSync(config, "utf8")).toContain("mast-codex-notify.sh");
    expect(readFileSync(agentsFile, "utf8")).toContain("mast integration");

    distro.write(config, 'model = "gpt-5"\n');
    distro.write(agentsFile, "# my own notes\n");
    distro.write(distro.claudeSettings(), fileText({ hooks: { Stop: [idle] } }));
    const { Stop: _removed, ...codexWithoutStop } = CODEX_HOOKS.hooks;
    distro.write(distro.codexHooks(), fileText({ hooks: codexWithoutStop }));
    const optedOut = [config, agentsFile, distro.claudeSettings(), distro.codexHooks()];
    const kept = optedOut.map(fingerprint);
    const before = distro.log();
    distro.withAgy();

    const rerun = distro.run();

    expect(rerun).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(readJson(distro.agyHooks())).toEqual(AGY_HOOKS);
    expect(distro.agentMarker("agy")).toBe(true);
    expect(optedOut.map(fingerprint)).toEqual(kept);
    const rerunLog = distro.log().slice(before.length);
    expect(rerunLog).toContain(AGENT_ONLY_LOG);
    expect(rerunLog).not.toContain(FULL_RUN_LOG);
    expect(distro.calls().filter((call) => call.startsWith("claude "))).toHaveLength(1);

    const log = distro.log();
    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.log().slice(log.length)).not.toContain(FULL_RUN_LOG);
  });

  it.each([
    { name: "found no Python 3.8+", before: { reports: [3, 7, 17] } as Python, notices: [PYTHON_NOTICE] },
    { name: "recorded an interpreter that is no longer 3.8+", before: { reports: [3, 8, 0] } as Python, notices: [] },
  ])("when Codex arrives after a setup that $name, records its step without hooks and says why once", ({ before, notices }) => {
    const distro = new Distro({ python: before });
    expect(distro.run().stderr).toEqual(notices);
    const mastPython = distro.path(".mast", "bin", "mast-python");
    const recorded = existsSync(mastPython) ? readFileSync(mastPython, "utf8") : null;
    distro.python({ reports: [3, 7, 17] });
    distro.withCodex();
    const log = distro.log();

    const rerun = distro.run();

    expect(rerun).toEqual({ status: 0, stdout: "", stderr: [CODEX_PYTHON_NOTICE] });
    expect(distro.agentMarker("codex")).toBe(true);
    expect(existsSync(distro.codexHooks())).toBe(false);
    expect(readFileSync(distro.path(".codex", "config.toml"), "utf8")).toBe('model = "gpt-5"\n');
    // 전체 설치가 깔아 둔 Claude 디스패처 행이 이 기록을 쓴다.
    expect(existsSync(mastPython) ? readFileSync(mastPython, "utf8") : null).toBe(recorded);
    const rerunLog = distro.log().slice(log.length);
    expect(rerunLog).toContain(AGENT_ONLY_LOG);
    expect(rerunLog).toContain(`codex hooks: dispatcher python ${join(distro.tools, "python3")} is 3.7.17, not 3.8+`);
    expect(rerunLog).toContain("codex hooks: no Python 3.8+ for the dispatcher; skipped");
    expect(rerunLog).toContain(`notice: ${CODEX_PYTHON_NOTICE.slice("[mast] setup: ".length)}`);
    expect(distro.calls()).toEqual([]);

    const done = distro.log();
    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.log().slice(done.length)).not.toContain("hooks:");
  });

  it("when Codex arrives after Python went from 3.7 to 3.8, records the interpreter and installs the Codex hooks", () => {
    const distro = new Distro({ python: { reports: [3, 7, 17] } });
    distro.agent("claude", "2.1.270 (Claude Code)");
    expect(distro.run().stderr).toEqual([PYTHON_NOTICE]);
    const mastPython = distro.path(".mast", "bin", "mast-python");
    expect(existsSync(mastPython)).toBe(false);
    distro.python({ reports: [3, 8, 0] });
    distro.withCodex();
    const log = distro.log();

    const rerun = distro.run();

    expect(rerun).toEqual({ status: 0, stdout: "", stderr: [distro.trustNotice()] });
    expect(readFileSync(mastPython, "utf8")).toBe(`${join(distro.tools, "python3")}\n`);
    expect(readJson(distro.codexHooks())).toEqual(CODEX_HOOKS);
    expect(distro.agentMarker("codex")).toBe(true);
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_STATUS_ONLY);
    expect(readFileSync(distro.path(".codex", "config.toml"), "utf8")).toBe('model = "gpt-5"\n');
    const rerunLog = distro.log().slice(log.length);
    expect(rerunLog).toContain(AGENT_ONLY_LOG);
    expect(rerunLog).toContain(`dispatcher python: ${join(distro.tools, "python3")} (3.8.0)`);

    const done = distro.log();
    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.log().slice(done.length)).not.toContain("hooks:");
  });

  it.each([
    { name: "3.7 recorded, 3.8 on PATH", recorded: [3, 7, 17] as const, onPath: [3, 8, 0] as const, installs: true },
    { name: "3.8 recorded, 3.7 on PATH", recorded: [3, 8, 0] as const, onPath: [3, 7, 17] as const, installs: false },
  ])("judges a later Codex by the python3 PATH resolves now, made absolute, not by the recorded one ($name)", ({ recorded, onPath, installs }) => {
    const distro = new Distro();
    expect(distro.run().status).toBe(0);
    const recordedPython = join(distro.root, "recorded python", "python3");
    distro.python({ reports: [...recorded] }, recordedPython);
    const mastPython = distro.write(distro.path(".mast", "bin", "mast-python"), `${recordedPython}\n`);
    // 5a 처럼 상대 PATH 항목으로 찾은 인터프리터는 작업 디렉터리를 붙여 절대경로로 적어야 한다.
    const pathPython = join(distro.home, "py bin", "python3");
    distro.python({ reports: [...onPath] }, pathPython);
    distro.pathDirs.push("py bin");
    distro.withCodex();

    const rerun = distro.run();

    expect(rerun).toEqual({ status: 0, stdout: "", stderr: installs ? [distro.trustNotice()] : [CODEX_PYTHON_NOTICE] });
    expect(readFileSync(mastPython, "utf8")).toBe(`${installs ? pathPython : recordedPython}\n`);
    expect(existsSync(distro.codexHooks())).toBe(installs);
    expect(distro.agentMarker("codex")).toBe(true);
  });

  it("when a later Codex run cannot write mast-python, leaves its step unrecorded and finishes it once the write works", () => {
    const distro = new Distro();
    expect(distro.run().status).toBe(0);
    const mastPython = distro.write(distro.path(".mast", "bin", "mast-python"), "/usr/bin/python3.6\n");
    // 권한으로 막으면 root 로 도는 러너에서는 쓰기가 성공한다. 디렉터리는 root 도 파일로 덮어쓰지 못한다.
    const blocker = `${mastPython}.tmp`;
    mkdirSync(blocker);
    distro.withCodex();

    for (let attempt = 0; attempt < 2; attempt++) {
      const before = distro.log();
      const run = distro.run();
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
      expect(run.stderr.filter((line) => line.startsWith("[mast] setup: "))).toEqual([`[mast] setup: cannot install ${mastPython}`]);
      // 나머지 줄은 막힌 임시 파일에 대한 bash·rm 의 오류뿐이어야 한다.
      for (const line of run.stderr.filter((line) => !line.startsWith("[mast] setup: "))) expect(line).toContain(blocker);
      expect(distro.agentMarker("codex")).toBe(false);
      expect(existsSync(distro.codexHooks())).toBe(false);
      expect(readFileSync(mastPython, "utf8")).toBe("/usr/bin/python3.6\n");
      const rerunLog = distro.log().slice(before.length);
      expect(rerunLog).toContain(AGENT_ONLY_LOG);
      expect(rerunLog).not.toContain(FULL_RUN_LOG);
      expect(rerunLog).toContain("codex hooks: cannot record the dispatcher python; retried on the next launch");
    }
    expect(distro.calls()).toEqual([]);

    rmSync(blocker, { recursive: true });
    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [distro.trustNotice()] });
    expect(readFileSync(mastPython, "utf8")).toBe(`${join(distro.tools, "python3")}\n`);
    expect(readJson(distro.codexHooks())).toEqual(CODEX_HOOKS);
    expect(distro.agentMarker("codex")).toBe(true);
    expect(readFileSync(distro.path(".codex", "config.toml"), "utf8")).toBe('model = "gpt-5"\n');

    const log = distro.log();
    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.log().slice(log.length)).not.toContain(FULL_RUN_LOG);
  });

  it.each(["mast-hooks-merge.py", "mast-agent-hook.py", "mast-codex-hook.sh", "mast-agy-hook.sh", "mast-notify.sh"])(
    "runs every step again, once, when %s is missing from ~/.mast/bin",
    (name) => {
      const distro = new Distro();
      expect(distro.run().status).toBe(0);
      const file = distro.path(".mast", "bin", name);
      const content = readFileSync(file, "utf8");
      rmSync(file);
      const before = distro.log();
      distro.withAgy();

      const rerun = distro.run();

      expect(rerun).toEqual({ status: 0, stdout: "", stderr: [] });
      expect(readFileSync(file, "utf8")).toBe(content);
      expect(readJson(distro.agyHooks())).toEqual(AGY_HOOKS);
      const rerunLog = distro.log().slice(before.length);
      expect(rerunLog).toContain(`setup v${VERSION} exists but ${file} is missing; running every step`);
      expect(rerunLog).toContain(FULL_RUN_LOG);
      expect(rerunLog).toContain(`setup v${VERSION} complete`);
      expect(distro.agentMarker("agy")).toBe(true);

      const log = distro.log();
      expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });
      expect(distro.log().slice(log.length)).not.toContain(FULL_RUN_LOG);
    },
  );

  const LATER_AGENTS = {
    codex: { install: (distro: Distro) => distro.withCodex(), file: (distro: Distro) => distro.codexHooks(), hooks: CODEX_HOOKS },
    agy: { install: (distro: Distro) => distro.withAgy(), file: (distro: Distro) => distro.agyHooks(), hooks: AGY_HOOKS },
  };
  const LATER_AGENT_SETS: { agents: (keyof typeof LATER_AGENTS)[] }[] = [{ agents: ["codex"] }, { agents: ["agy"] }, { agents: ["codex", "agy"] }];

  it.each(LATER_AGENT_SETS)("without python3, gives the full install's notice once when $agents arrive later and retries only those steps", ({ agents }) => {
    const distro = new Distro();
    const python3 = join(distro.tools, "python3");
    rmSync(python3);
    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [PYTHON3_MISSING_NOTICE] });
    expect(distro.marker()).toBe(false);
    symlinkSync(tools.python3, python3);
    expect(distro.run().status).toBe(0);
    expect(distro.marker()).toBe(true);

    for (const agent of agents) LATER_AGENTS[agent].install(distro);
    rmSync(python3);
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = distro.log();
      expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [PYTHON3_MISSING_NOTICE] });
      const rerunLog = distro.log().slice(before.length);
      expect(rerunLog).toContain(AGENT_ONLY_LOG);
      expect(rerunLog).not.toContain(FULL_RUN_LOG);
      for (const agent of agents) {
        expect(rerunLog).toContain(`${agent} hooks: no python3; retried on the next launch`);
        expect(distro.agentMarker(agent)).toBe(false);
        expect(existsSync(LATER_AGENTS[agent].file(distro))).toBe(false);
      }
    }
    expect(distro.calls()).toEqual([]);

    symlinkSync(tools.python3, python3);
    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: agents.includes("codex") ? [distro.trustNotice()] : [] });
    for (const agent of agents) {
      expect(readJson(LATER_AGENTS[agent].file(distro))).toEqual(LATER_AGENTS[agent].hooks);
      expect(distro.agentMarker(agent)).toBe(true);
    }
  });

  it("without python3, appends the same notice to setup.log once per run, on the full install and an agent-only run", () => {
    const distro = new Distro();
    const python3 = join(distro.tools, "python3");
    const logged = `notice: ${PYTHON3_MISSING_NOTICE.slice("[mast] setup: ".length)}`;
    const occurrences = (log: string) => log.split(logged).length - 1;
    rmSync(python3);
    expect(distro.run().stderr).toEqual([PYTHON3_MISSING_NOTICE]);
    expect(occurrences(distro.log())).toBe(1);

    symlinkSync(tools.python3, python3);
    expect(distro.run().status).toBe(0);
    distro.withCodex().withAgy();
    rmSync(python3);
    const before = distro.log();
    expect(distro.run().stderr).toEqual([PYTHON3_MISSING_NOTICE]);
    const rerunLog = distro.log().slice(before.length);
    expect(rerunLog).toContain(AGENT_ONLY_LOG);
    expect(occurrences(rerunLog)).toBe(1);
  });

  it("without python3, records opted-out Codex and Antigravity CLI steps as done and says nothing about python3", () => {
    // 전체 설치는 python3 가 없으면 5단계에서 끝나 에이전트 단계에 닿지 않는다. 그래서 설치를 마친 뒤 에이전트
    // 단계만 도는 실행에서 본다.
    const distro = new Distro();
    expect(distro.run().status).toBe(0);
    expect(distro.marker()).toBe(true);
    distro.write(distro.path(".mast", "no-codex-hooks"), "");
    distro.write(distro.path(".mast", "no-agy-hooks"), "");
    distro.withCodex().withAgy();
    rmSync(join(distro.tools, "python3"));
    const before = distro.log();

    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });

    expect(distro.agentMarker("codex")).toBe(true);
    expect(distro.agentMarker("agy")).toBe(true);
    expect(existsSync(distro.codexHooks())).toBe(false);
    expect(existsSync(distro.agyHooks())).toBe(false);
    const rerunLog = distro.log().slice(before.length);
    expect(rerunLog).toContain(AGENT_ONLY_LOG);
    expect(rerunLog).toContain("codex hooks: ~/.mast/no-codex-hooks exists; skipped");
    expect(rerunLog).toContain("agy hooks: ~/.mast/no-agy-hooks exists; skipped");
    expect(rerunLog).not.toContain("python3");
    expect(distro.calls()).toEqual([]);

    const log = distro.log();
    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.log().slice(log.length)).not.toContain(FULL_RUN_LOG);
  });

  it("below Python 3.8 wires only the status hooks, records the Codex step as done, says why and writes the marker", () => {
    const distro = new Distro({ python: { reports: [3, 7, 17] } }).withAgents();
    distro.write(distro.path(".mast", "bin", "mast-python"), "/usr/bin/python3.6\n");

    const run = distro.run();

    expect(run.status).toBe(0);
    expect(run.stderr).toEqual([PYTHON_NOTICE]);
    expect(distro.marker()).toBe(true);
    expect(distro.agentMarker("codex")).toBe(true);
    expect(existsSync(distro.path(".mast", "bin", "mast-python"))).toBe(false);
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_STATUS_ONLY);
    expect(existsSync(distro.codexHooks())).toBe(false);
    expect(readJson(distro.agyHooks())).toEqual(AGY_HOOKS);
    expect(distro.calls().some((call) => call.startsWith("codex "))).toBe(false);
    expect(distro.log()).toContain("is 3.7.17, not 3.8+");
    expect(distro.log()).toContain("codex hooks: no Python 3.8+ for the dispatcher; skipped");
    expect(distro.log()).toContain(`notice: ${PYTHON_NOTICE.slice("[mast] setup: ".length)}`);
  });

  const PYTHON_38_CASES: { name: string; python: Python; version: RegExp }[] = [
    { name: "reporting 3.8.0", python: { reports: [3, 8, 0] }, version: /\(3\.8\.0\)/ },
  ];
  if (existsSync(PYTHON38)) PYTHON_38_CASES.push({ name: "a real 3.8", python: { interpreter: PYTHON38 }, version: /\(3\.8\.\d+\)/ });

  it.each(PYTHON_38_CASES)("with Python $name wires the dispatcher and the Codex hooks", ({ python, version }) => {
    const distro = new Distro({ python }).withAgents();

    const run = distro.run();

    expect(run.status).toBe(0);
    expect(run.stderr).toEqual([distro.trustNotice()]);
    expect(readFileSync(distro.path(".mast", "bin", "mast-python"), "utf8")).toBe(`${join(distro.tools, "python3")}\n`);
    expect(distro.log()).toMatch(version);
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_WITH_DISPATCHER);
    expect(readJson(distro.codexHooks())).toEqual(CODEX_HOOKS);
    expect(distro.marker()).toBe(true);
  });

  it.each([
    { version: "2.1.100", notice: "ignoresSettings" as const },
    { version: "2.1.101", notice: "noPostToolBatch" as const },
    { version: "2.1.117", notice: "noPostToolBatch" as const },
    { version: "2.1.118", notice: null },
  ])("judges Claude Code $version installed only as an nvm npm shim, reading it with that bin's node ahead of PATH's", ({ version, notice }) => {
    const distro = new Distro();
    const claude = distro.npmAgent("claude", `${version} (Claude Code)`, distro.path(".nvm", "versions", "node", "v20.11.0", "bin"));
    // 설치 셸 PATH 의 다른 node(예: /usr/bin 의 오래된 node)가 먼저 잡히면 그 node 로 shim 이 돈다.
    distro.executable(join(distro.stubs, "mast-test-node"), `#!${tools.bash}\nprintf '9.9.9\\n'\n`);

    const run = distro.run();

    expect(run.status).toBe(0);
    expect(run.stderr).toEqual(notice ? [CLAUDE_NOTICES[notice](version, claude)] : []);
    expect(readJson(distro.claudeSettings())).toEqual(notice ? CLAUDE_STATUS_ONLY : CLAUDE_WITH_DISPATCHER);
    expect(distro.log()).toContain(`claude: ${claude} --version reports ${version}`);
    expect(distro.calls()).toEqual(["claude --version /dev/null"]);
    expect(distro.marker()).toBe(true);
  });

  it.each([
    [".local", "bin"],
    [".claude", "local"],
    [".volta", "bin"],
    [".bun", "bin"],
    [".npm-global", "bin"],
    [".nvm", "versions", "node", "v22.3.0", "bin"],
  ])("finds Claude Code in ~/%s/%s… without it being on PATH", (...dir) => {
    const distro = new Distro();
    const claude = distro.agent("claude", "2.1.117 (Claude Code)", distro.path(...dir));

    const run = distro.run();

    expect(run.stderr).toEqual([CLAUDE_NOTICES.noPostToolBatch("2.1.117", claude)]);
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_STATUS_ONLY);
  });

  it("lets the lowest of several Claude Code copies decide and names that copy", () => {
    const distro = new Distro();
    distro.agent("claude", "2.1.270 (Claude Code)");
    const lowest = distro.agent("claude", "2.1.50 (Claude Code)", distro.path(".volta", "bin"));
    distro.agent("claude", "2.1.200 (Claude Code)", distro.path(".nvm", "versions", "node", "v20.11.0", "bin"));

    const run = distro.run();

    expect(run).toEqual({ status: 0, stdout: "", stderr: [CLAUDE_NOTICES.ignoresSettings("2.1.50", lowest)] });
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_STATUS_ONLY);
    expect(distro.calls()).toHaveLength(3);
  });

  it.each([
    { output: "2.1.117 (Claude Code; node 22.3.0)", notice: true },
    { output: "2.1.270 (Claude Code; node 2.1.0)", notice: false },
  ])("reads only the first x.y.z of a --version output that has two ($output)", ({ output, notice }) => {
    const distro = new Distro();
    const claude = distro.agent("claude", output);

    const run = distro.run();

    expect(run).toEqual({ status: 0, stdout: "", stderr: notice ? [CLAUDE_NOTICES.noPostToolBatch("2.1.117", claude)] : [] });
  });

  it("ignores a Claude Code file that is not executable instead of treating its version as unreadable", () => {
    const distro = new Distro();
    distro.agent("claude", "2.1.270 (Claude Code)");
    chmodSync(distro.agent("claude", "2.1.50 (Claude Code)", distro.path(".local", "bin")), 0o644);

    const run = distro.run();

    expect(run).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_WITH_DISPATCHER);
    expect(distro.callers()).toEqual([join(distro.stubs, "claude")]);
  });

  it("checks a copy once when PATH reaches it through a link", () => {
    const distro = new Distro();
    const real = distro.agent("claude", "2.1.270 (Claude Code)", distro.path(".local", "bin"));
    symlinkSync(real, join(distro.stubs, "claude"));

    const run = distro.run();

    expect(run).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(distro.callers()).toEqual([join(distro.stubs, "claude")]);
  });

  it("wires only the status hooks when any Claude Code copy has a version that cannot be read, and names it", () => {
    const distro = new Distro();
    distro.agent("claude", "2.1.270 (Claude Code)");
    const broken = distro.brokenAgent("claude", distro.path(".bun", "bin"));
    distro.agent("claude", "2.1.50 (Claude Code)", distro.path(".npm-global", "bin"));

    const run = distro.run();

    expect(run).toEqual({ status: 0, stdout: "", stderr: [CLAUDE_NOTICES.unreadable(broken)] });
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_STATUS_ONLY);
    expect(distro.log()).toContain(`claude: ${broken} --version is unreadable`);
    expect(distro.marker()).toBe(true);
  });

  (MNT_ROOT ? it : it.skip)("does not judge a Windows install that PATH finds under /mnt", () => {
    const distro = new Distro();
    const windowsBin = mkdtempSync(join(MNT_ROOT ?? "", "npm-"));
    const windows = distro.agent("claude", "2.1.50 (Claude Code)", windowsBin);
    distro.pathDirs.push(windowsBin);
    distro.agent("claude", "2.1.270 (Claude Code)", distro.path(".local", "bin"));

    const run = distro.run();

    expect(run).toEqual({ status: 0, stdout: "", stderr: [] });
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_WITH_DISPATCHER);
    expect(distro.log()).toContain(`claude: ${windows} is a Windows install; not checked`);
    expect(distro.callers()).toEqual([distro.path(".local", "bin", "claude")]);
  });

  it("never runs the user's shell profile or rc files", () => {
    const distro = new Distro().withAgents();
    const sentinel = join(distro.root, "profile ran");
    for (const name of [".profile", ".bash_profile", ".bash_login", ".bashrc"]) {
      distro.write(distro.path(name), `: > ${shellQuote(sentinel)}\n`);
    }

    expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [distro.trustNotice()] });
    expect(existsSync(sentinel)).toBe(false);
  });

  it("bounds a --version that never exits and does not wait for a child it leaves behind", () => {
    const distro = new Distro();
    distro.write(distro.path(".codex", "config.toml"), 'model = "gpt-5"\n');
    // TERM 을 무시하므로 KILL 로만 끝난다.
    distro.agent("claude", "2.1.270 (Claude Code)", distro.stubs, `#!${tools.bash}`, [
      "  trap '' TERM",
      `  ${shellQuote(tools.sleep)} 30`,
    ]);
    // 끝나면서 버전 출력을 물고 있는 자식을 남긴다. 그 자식은 30초 뒤 스스로 끝난다.
    const codex = distro.agent("codex", "codex-cli 0.149.9", distro.stubs, `#!${tools.bash}`, [
      `  ${shellQuote(tools.sleep)} 30 &`,
    ]);

    const started = Date.now();
    const run = distro.run();
    const elapsed = Date.now() - started;

    // timeout 10 초 + KILL 1 초. 어느 한쪽이라도 30 초짜리 sleep 을 기다리면 넘는다.
    expect(elapsed).toBeLessThan(25_000);
    expect(run).toEqual({ status: 0, stdout: "", stderr: [codexNotice("0.149.9", codex, ["interrupt"]), distro.trustNotice()] });
    expect(readJson(distro.claudeSettings())).toEqual(CLAUDE_WITH_DISPATCHER);
    expect(readdirSync(distro.path(".mast")).filter((name) => name.startsWith(".agent-version"))).toEqual([]);
  });

  it("judges Codex and Antigravity CLI found only outside PATH by their lowest readable copy", () => {
    const distro = new Distro();
    distro.write(distro.path(".codex", "config.toml"), 'model = "gpt-5"\n');
    mkdirSync(distro.path(".gemini", "antigravity-cli"), { recursive: true });
    distro.brokenAgent("codex", distro.path(".local", "bin"));
    // ~/.claude/local 은 Claude Code 의 옛 설치 위치일 뿐이다.
    distro.agent("codex", "codex-cli 0.100.0", distro.path(".claude", "local"));
    const codex = distro.npmAgent("codex", "codex-cli 0.128.9", distro.path(".nvm", "versions", "node", "v20.11.0", "bin"));
    distro.agent("agy", "1.1.13", distro.path(".volta", "bin"));
    const agy = distro.npmAgent("agy", "1.1.9", distro.path(".bun", "bin"));
    distro.brokenAgent("agy", distro.path(".npm-global", "bin"));

    const run = distro.run();

    expect(run).toEqual({
      status: 0,
      stdout: "",
      stderr: [codexNotice("0.128.9", codex, ["untrusted", "subagentStop", "async", "interrupt"]), agyNotice("1.1.9", agy)],
    });
    expect(readJson(distro.codexHooks())).toEqual(CODEX_HOOKS);
    expect(readJson(distro.agyHooks())).toEqual(AGY_HOOKS);
    expect(distro.callers()).not.toContain(distro.path(".claude", "local", "codex"));
    expect(distro.log()).toContain(`codex: ${distro.path(".local", "bin", "codex")} --version is unreadable`);
  });

  it("stops before the marker when the Claude Code merge fails", () => {
    const distro = new Distro().withAgents();
    distro.write(distro.claudeSettings(), "{not json\n");

    const run = distro.run();

    expect(run.status).toBe(1);
    expect(run.stderr.at(-1)).toBe("[mast] setup: Claude Code hook wiring failed; see ~/.mast/setup.log");
    expect(run.stderr.some((line) => line.includes("Claude Code hooks are not wired; mast retries on its next launch."))).toBe(true);
    expect(readFileSync(distro.claudeSettings(), "utf8")).toBe("{not json\n");
    expect(distro.marker()).toBe(false);
    expect(existsSync(distro.codexHooks())).toBe(false);
  });

  const AGENT_FILES = [
    {
      agent: "codex" as const,
      name: "Codex",
      file: (distro: Distro) => distro.codexHooks(),
      refusedContent: '{"$schema": "https://example.invalid/hooks.json"}\n',
      refusal: (distro: Distro) =>
        `[mast] setup: ${distro.codexHooks()} is not a hooks file Codex accepts (unknown top-level key "$schema"); ` +
        "Codex ignores the whole file; left untouched. Codex hooks are not installed.",
      other: (distro: Distro) => expect(readJson(distro.agyHooks())).toEqual(AGY_HOOKS),
    },
    {
      agent: "agy" as const,
      name: "Antigravity CLI",
      file: (distro: Distro) => distro.agyHooks(),
      refusedContent: "[1]\n",
      refusal: (distro: Distro) =>
        `[mast] setup: ${distro.agyHooks()} is not a JSON object; left untouched. Antigravity CLI hooks are not installed.`,
      other: (distro: Distro) => expect(readJson(distro.codexHooks())).toEqual(CODEX_HOOKS),
    },
  ];

  it.each(AGENT_FILES)(
    "records the $name step as done when its hooks file cannot be merged, and retries that step once its marker is removed",
    ({ agent, file, refusedContent, refusal, other }) => {
      const distro = new Distro().withAgents();
      distro.write(file(distro), refusedContent);

      const run = distro.run();

      expect(run.status).toBe(0);
      const notices = [refusal(distro), REFUSED_NOTICES[agent]];
      expect(run.stderr).toEqual(agent === "codex" ? notices : [distro.trustNotice(), ...notices]);
      for (const notice of notices) expect(distro.log()).toContain(notice.slice("[mast] setup: ".length));
      expect(readFileSync(file(distro), "utf8")).toBe(refusedContent);
      other(distro);
      expect(distro.marker()).toBe(true);
      expect(distro.agentMarker(agent)).toBe(true);

      const log = distro.log();
      expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });
      expect(distro.log().slice(log.length)).not.toContain(FULL_RUN_LOG);

      rmSync(file(distro));
      rmSync(distro.path(".mast", `.setup-v${VERSION}-${agent}`));
      expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: agent === "codex" ? [distro.trustNotice()] : [] });
      expect(existsSync(file(distro))).toBe(true);
      expect(distro.agentMarker(agent)).toBe(true);
      expect(distro.log().slice(log.length)).not.toContain(FULL_RUN_LOG);
    },
  );

  it.each([
    { ...AGENT_FILES[0], python: undefined, pythonNotices: [], other: "agy" as const, installed: (distro: Distro) => [distro.trustNotice()] },
    // Antigravity CLI 단계는 디스패처가 필요 없어 Python 3.7 에서도 돈다. 그래서 Python 안내가 반복되지 않는지도 본다.
    { ...AGENT_FILES[1], python: { reports: [3, 7, 17] } as Python, pythonNotices: [PYTHON_NOTICE], other: "codex" as const, installed: () => [] },
  ])(
    "writes the marker when the $name hooks file cannot be read, then retries only that step, keeping opt-outs, until it can",
    ({ agent, name, file, python, pythonNotices, other, installed }) => {
      const distro = new Distro({ python }).withCodex().withAgy();
      const claude = distro.agent("claude", "2.1.50 (Claude Code)");
      mkdirSync(file(distro), { recursive: true });

      const first = distro.run();

      const failure = [
        `[mast] setup: cannot read ${file(distro)} (Is a directory); left untouched. ${name} hooks are not installed; ` +
          "mast retries on its next launch.",
        `[mast] setup: ${name} hooks were not installed; see ~/.mast/setup.log (retried on the next launch)`,
      ];
      expect(first).toEqual({ status: 0, stdout: "", stderr: [...pythonNotices, CLAUDE_NOTICES.ignoresSettings("2.1.50", claude), ...failure] });
      expect(distro.marker()).toBe(true);
      expect(distro.agentMarker(agent)).toBe(false);
      expect(distro.agentMarker(other)).toBe(true);

      // 전체 설치가 다시 돌면 되살아나는 것들을 사용자가 거둔다.
      const config = distro.path(".codex", "config.toml");
      const agentsFile = distro.path(".codex", "AGENTS.md");
      expect(readFileSync(config, "utf8")).toContain("mast-codex-notify.sh");
      expect(readFileSync(agentsFile, "utf8")).toContain("mast integration");
      distro.write(config, 'model = "gpt-5"\n');
      distro.write(agentsFile, "# my own notes\n");
      distro.write(distro.claudeSettings(), fileText({ hooks: { Stop: [idle] } }));
      const optedOut = [config, agentsFile, distro.claudeSettings()];
      if (other === "agy") optedOut.push(distro.write(distro.agyHooks(), "{}\n"));
      const kept = optedOut.map(fingerprint);
      const untouchedCalls = distro.calls().filter((call) => !call.startsWith(`${agent} `));

      for (let attempt = 0; attempt < 2; attempt++) {
        const before = distro.log();
        expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: failure });
        const rerunLog = distro.log().slice(before.length);
        expect(rerunLog).toContain(AGENT_ONLY_LOG);
        expect(rerunLog).not.toContain(FULL_RUN_LOG);
        expect(distro.agentMarker(agent)).toBe(false);
      }
      expect(optedOut.map(fingerprint)).toEqual(kept);
      expect(distro.calls().filter((call) => !call.startsWith(`${agent} `))).toEqual(untouchedCalls);

      rmSync(file(distro), { recursive: true });
      expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: installed(distro) });
      expect(readJson(file(distro))).toEqual(agent === "codex" ? CODEX_HOOKS : AGY_HOOKS);
      expect(distro.agentMarker(agent)).toBe(true);
      expect(optedOut.map(fingerprint)).toEqual(kept);

      const log = distro.log();
      expect(distro.run()).toEqual({ status: 0, stdout: "", stderr: [] });
      expect(distro.log().slice(log.length)).not.toContain(FULL_RUN_LOG);
    },
  );

  it("forwards the Antigravity CLI notice about a different mast hook to stderr and setup.log, and completes", () => {
    const distro = new Distro().withAgents();
    const content = fileText({ mast: { Stop: [{ type: "command", command: "my-own-script.sh", timeout: 30 }] } });
    distro.write(distro.agyHooks(), content);

    const run = distro.run();

    expect(run.status).toBe(0);
    const differs =
      `[mast] setup: ${distro.agyHooks()} already has a "mast" hook that differs from the one mast installs, so mast ` +
      `left it untouched. To use mast's definition, replace it with:\n${JSON.stringify(AGY_HOOKS, null, 2)}`;
    expect(run.stderr.join("\n")).toBe(`${distro.trustNotice()}\n${differs}`);
    expect(distro.log()).toContain(differs.slice("[mast] setup: ".length));
    expect(readFileSync(distro.agyHooks(), "utf8")).toBe(content);
    expect(distro.marker()).toBe(true);
    expect(distro.agentMarker("agy")).toBe(true);
  });

  it("passes config.toml to the Codex merge: inline hooks keep hooks.json out and auto_review is reported", () => {
    const distro = new Distro().withAgents();
    const config = distro.path(".codex", "config.toml");
    distro.write(
      config,
      ['model = "gpt-5"', 'approvals_reviewer = "auto_review"', "", "[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"', 'command = "echo stop"', ""].join("\n"),
    );

    const run = distro.run();

    expect(run.status).toBe(0);
    expect(existsSync(distro.codexHooks())).toBe(false);
    const autoReview = `[mast] setup: approvals_reviewer is auto_review in ${config};`;
    const inline = `[mast] setup: Codex hooks are configured inline in ${config} (hooks.Stop), so mast did not create or change ${distro.codexHooks()}`;
    expect(run.stderr.some((line) => line.startsWith(autoReview))).toBe(true);
    expect(run.stderr.some((line) => line.startsWith(inline))).toBe(true);
    const log = distro.log();
    // 파서는 호스트 python 에 tomllib 이 있는지(3.11+)에 따라 다르고, 두 경로 모두 inline 훅을 찾는다.
    expect(log.split("\n").some((line) => /codex: config=read parser=\S+ path=/.test(line) && line.endsWith(`path=${config}`))).toBe(true);
    expect(log).toContain(`codex: result=skipped-inline-hooks path=${distro.codexHooks()}`);
    expect(log).toContain(autoReview.slice("[mast] setup: ".length));
    expect(distro.marker()).toBe(true);
    expect(distro.agentMarker("codex")).toBe(true);
  });

  it.each([
    { version: "0.123.9", limits: ["off", "untrusted", "subagentStop", "async", "interrupt"] as const, trust: null },
    { version: "0.124.0", limits: ["untrusted", "subagentStop", "async", "interrupt"] as const, trust: null },
    { version: "0.128.9", limits: ["untrusted", "subagentStop", "async", "interrupt"] as const, trust: null },
    { version: "0.129.0", limits: ["subagentStop", "async", "interrupt"] as const, trust: "slash" as const },
    { version: "0.130.5", limits: ["subagentStop", "async", "interrupt"] as const, trust: "slash" as const },
    { version: "0.131.0", limits: ["subagentStop", "async", "interrupt"] as const, trust: "launch" as const },
    { version: "0.132.9", limits: ["subagentStop", "async", "interrupt"] as const, trust: "launch" as const },
    { version: "0.133.0", limits: ["async", "interrupt"] as const, trust: "launch" as const },
    { version: "0.147.9", limits: ["async", "interrupt"] as const, trust: "launch" as const },
    { version: "0.148.0", limits: ["interrupt"] as const, trust: "launch" as const },
    { version: "0.149.9", limits: ["interrupt"] as const, trust: "launch" as const },
    { version: "0.150.0", limits: [] as const, trust: "launch" as const },
  ])("names what Codex $version lacks and how to trust its hooks", ({ version, limits, trust }) => {
    const distro = new Distro().withAgents({ codex: `codex-cli ${version}` });

    const run = distro.run();

    expect(run.status).toBe(0);
    const codex = join(distro.stubs, "codex");
    expect(run.stderr).toEqual([
      ...(limits.length ? [codexNotice(version, codex, limits)] : []),
      ...(trust ? [distro.trustNotice(trust)] : []),
    ]);
    expect(readJson(distro.codexHooks())).toEqual(CODEX_HOOKS);
    expect(distro.marker()).toBe(true);
  });

  it("treats an unreadable Codex version as current: no version notice, trust at launch", () => {
    const distro = new Distro().withAgents({ codex: "codex-cli" });

    const run = distro.run();

    expect(run.stderr).toEqual([distro.trustNotice()]);
    expect(distro.log()).toContain("codex hooks: no readable Codex version; no version notices");
  });

  it.each([
    { version: "1.1.9", notice: true },
    { version: "1.1.10", notice: false },
  ])("warns about Antigravity CLI $version only below 1.1.10", ({ version, notice }) => {
    const distro = new Distro().withAgents({ agy: version });

    const run = distro.run();

    expect(run.status).toBe(0);
    const agy = join(distro.stubs, "agy");
    expect(run.stderr).toEqual(notice ? [distro.trustNotice(), agyNotice(version, agy)] : [distro.trustNotice()]);
    expect(readJson(distro.agyHooks())).toEqual(AGY_HOOKS);
    expect(distro.marker()).toBe(true);
  });
});
