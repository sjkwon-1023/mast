// @vitest-environment node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const onLinux = process.platform === "linux";
const integration = onLinux ? describe : describe.skip;

// 러너가 mast 탭 안의 Claude Code·Codex 에서 돌면 이 값들이 이미 있다. CODEX_THREAD_ID 가 새면
// 중첩 codex exec 게이트에 걸려 모든 notify 가 조용히 끝난다.
const AGENT_ENV = ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_HOME", "MAST", "MAST_TAB", "BASH_ENV"];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of AGENT_ENV) delete env[key];
  return env;
}

function commandPath(command: string): string {
  try {
    return execFileSync("bash", ["--noprofile", "--norc", "-c", `command -v ${command}`], {
      env: scrubbedEnv(),
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    throw new Error(`codex resume integration tests require ${command}`);
  }
}

const tools: Record<string, string> = {};
if (onLinux) {
  for (const command of ["bash", "jq", "timeout", "mkdir", "date", "mv", "rm", "readlink", "script", "python3"]) {
    tools[command] = commandPath(command);
  }
}

const sourceDir = dirname(fileURLToPath(import.meta.url));
const provisionSource = readFileSync(join(sourceDir, "../src-tauri/src/provision.rs"), "utf8");
const hostSource = readFileSync(join(sourceDir, "../src-tauri/src/host.rs"), "utf8");

function extractCodexHook(source: string): string {
  const start = "cat > \"$CODEX_NOTIFY.tmp\" <<'MAST_CODEX_NOTIFY_EOF'\n";
  const end = "\nMAST_CODEX_NOTIFY_EOF";
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  if (begin < 0 || finish < 0) throw new Error("mast-codex-notify.sh heredoc disappeared");
  return source.slice(begin + start.length, finish);
}

function extractHostTabScript(source: string): string {
  const prefix = "Some(tab) => format!(";
  const begin = source.indexOf(prefix);
  if (begin < 0) throw new Error("host.rs bash_argv Some(tab) format disappeared");
  const quoted = source.slice(begin + prefix.length).match(/^\s*"((?:\\[\s\S]|[^"\\])*)"\s*\n\s*\),/);
  if (!quoted) throw new Error("host.rs bash_argv format string disappeared");
  const collapsed = quoted[1].replace(/\\\r?\n[ \t]*/g, "");
  return JSON.parse(`"${collapsed}"`) as string;
}

const codexHook = extractCodexHook(provisionSource);

function freshWrapperScript(): string {
  let script = extractHostTabScript(hostSource);
  for (const [placeholder, value] of [
    ["{STARTED}", ":"],
    ["{THEME_SYNC}", ":"],
    ["{cd_clause}", ""],
    ["{PATH_PREFIX}", ""],
    ["{OSC7}", ""],
    ["{tab}", "6"],
  ] as const) {
    script = script.replaceAll(placeholder, value);
  }
  const productionExec = "exec bash -l";
  if (!script.includes(productionExec)) throw new Error("host wrapper no longer execs bash -l");
  return script.replace(productionExec, "exec bash --noprofile --norc -c 'history -r; history 1'");
}

type RunOptions = { tab?: string | null; codexHome?: string; env?: NodeJS.ProcessEnv };

class Harness {
  readonly root = mkdtempSync(join(tmpdir(), "mast codex resume-"));
  readonly home = join(this.root, "home with spaces");
  readonly defaultCodexHome = join(this.home, ".codex");
  readonly hookPath = join(this.root, "mast-codex-notify.sh");
  readonly notifyArgsPath = join(this.home, ".mast", "notify-argv");
  readonly dispatcherArgsPath = join(this.home, ".mast", "dispatcher-argv");

  constructor() {
    mkdirSync(join(this.home, ".mast", "bin"), { recursive: true });
    const stub = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\0' \"$#\" \"$@\" > ${shellQuote(this.notifyArgsPath)}`,
      "",
    ].join("\n");
    writeFileSync(join(this.home, ".mast", "bin", "mast-notify.sh"), stub, { mode: 0o700 });
    writeFileSync(this.hookPath, codexHook, { mode: 0o700 });
    chmodSync(this.hookPath, 0o700);
  }

  env(options: RunOptions = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...scrubbedEnv(), HOME: this.home };
    const tab = options.tab === undefined ? "6" : options.tab;
    if (tab !== null) env.MAST_TAB = tab;
    if (options.codexHome !== undefined) env.CODEX_HOME = options.codexHome;
    return { ...env, ...options.env };
  }

  run(payload: string, options: RunOptions = {}): void {
    const env = this.env(options);
    execFileSync(tools.bash, [this.hookPath, payload], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
  }

  runFreshWrapper(): string {
    const env: NodeJS.ProcessEnv = { ...scrubbedEnv(), HOME: this.home };
    return execFileSync("bash", ["-c", freshWrapperScript()], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
  }

  resume(tab = "6"): string | undefined {
    const path = join(this.home, ".mast", "resume", `tab-${tab}`);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  seedResume(command: string, tab = "6"): string {
    const path = join(this.home, ".mast", "resume", `tab-${tab}`);
    mkdirSync(dirname(path), { recursive: true });
    const value = `${command}\n123\n`;
    writeFileSync(path, value);
    return value;
  }

  transcript(codexHome: string, threadId: string, firstRecord: string, rest = ""): void {
    const dir = join(codexHome, "sessions", "2026", "09", "13");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-root-${threadId}.jsonl`), `${firstRecord}\n${rest}`);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  notifyArgs(): string[] | undefined {
    return readArgv(this.notifyArgsPath);
  }

  // mast-python 이 가리키는 인터프리터 자리에 argv 를 기록하고 정해진 코드로 끝나는 stub 을 둔다.
  // 경로에 공백을 넣어 notify 스크립트의 인용을 함께 확인한다.
  useDispatcherStub(status = 0): string {
    const stub = join(this.root, "stub python", "python3");
    mkdirSync(dirname(stub), { recursive: true });
    writeFileSync(
      stub,
      [
        `#!${tools.bash}`,
        `printf '%s\\0' "$#" "$@" > ${shellQuote(this.dispatcherArgsPath)}`,
        `exit ${status}`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    this.recordInterpreter(stub);
    return stub;
  }

  recordInterpreter(path: string): void {
    writeFileSync(join(this.home, ".mast", "bin", "mast-python"), `${path}\n`);
  }

  dispatcherArgs(): string[] | undefined {
    return readArgv(this.dispatcherArgsPath);
  }
}

function readArgv(path: string): string[] | undefined {
  if (!existsSync(path)) return undefined;
  const fields = readFileSync(path, "utf8").split("\0");
  const count = Number(fields.shift());
  return fields.slice(0, count);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function metadata(threadId: string, source: unknown): string {
  return JSON.stringify({ type: "session_meta", payload: { id: threadId, source } });
}

function payload(threadId: unknown, message: unknown = "turn complete"): string {
  return JSON.stringify({ "thread-id": threadId, "turn-id": "turn-1", "last-assistant-message": message });
}

function withHarness(test: (harness: Harness) => void): void {
  const harness = new Harness();
  try {
    test(harness);
  } finally {
    harness.dispose();
  }
}

function lastHistoryEntry(output: string): string {
  const line = output.trimEnd().split(/\r?\n/).at(-1);
  const match = line?.match(/^\s*\d+\s+(.*)$/);
  if (!match) throw new Error(`fresh wrapper did not print history: ${JSON.stringify(output)}`);
  return match[1];
}

const codex = (harness: Harness) => harness.defaultCodexHome;

integration("Codex resume notify integration", () => {
  it("keeps the real root hint through ephemeral and persisted subagents after restart", () => {
    withHarness((harness) => {
      const root = "root-real";
      harness.transcript(codex(harness), root, metadata(root, "cli"));
      harness.run(payload(root, "root answer"));
      const original = harness.resume();
      expect(original).toMatch(/^codex resume root-real\n/);

      harness.run(payload("scout-ephemeral", "missing scout"));
      expect(harness.resume()).toBe(original);

      const ephemeral = "scout-thread-spawn";
      harness.transcript(
        codex(harness),
        ephemeral,
        metadata(ephemeral, {
          subagent: { thread_spawn: { parent_thread_id: root, depth: 1 } },
        }),
      );
      harness.run(payload(ephemeral, "scout answer"));
      expect(harness.resume()).toBe(original);

      const guardian = "scout-guardian";
      harness.transcript(
        codex(harness),
        guardian,
        metadata(guardian, { subagent: { other: "guardian" } }),
      );
      harness.run(payload(guardian, "guardian answer"));
      expect(harness.resume()).toBe(original);
      expect(lastHistoryEntry(harness.runFreshWrapper())).toBe("codex resume root-real");
    });
  });

  it("replaces a real root hint with the next real root session", () => {
    withHarness((harness) => {
      harness.transcript(codex(harness), "root-old", metadata("root-old", "cli"));
      harness.run(payload("root-old"));
      harness.transcript(codex(harness), "root-new", metadata("root-new", "exec"));
      harness.run(payload("root-new"));
      expect(harness.resume()).toMatch(/^codex resume root-new\n/);
      expect(lastHistoryEntry(harness.runFreshWrapper())).toBe("codex resume root-new");
    });
  });

  it("preserves a Claude hint for a subagent and replaces it for a real Codex root", () => {
    withHarness((harness) => {
      const claudeHint = harness.seedResume("claude --resume claude-root");
      const scout = "claude-tab-scout";
      harness.transcript(
        codex(harness),
        scout,
        metadata(scout, { subagent: { thread_spawn: { parent_thread_id: "claude-root", depth: 1 } } }),
      );
      harness.run(payload(scout));
      expect(harness.resume()).toBe(claudeHint);

      const root = "codex-root";
      harness.transcript(codex(harness), root, metadata(root, "cli"));
      harness.run(payload(root));
      expect(harness.resume()).toMatch(/^codex resume codex-root\n/);
    });
  });

  it("keeps other MAST_TAB files isolated", () => {
    withHarness((harness) => {
      const other = harness.seedResume("claude --resume other-tab", "7");
      const root = "tab-six-root";
      harness.transcript(codex(harness), root, metadata(root, "cli"));
      harness.run(payload(root), { tab: "6" });
      expect(harness.resume("7")).toBe(other);
      expect(harness.resume("6")).toMatch(/^codex resume tab-six-root\n/);
    });
  });

  it("uses CODEX_HOME even when its path contains spaces", () => {
    withHarness((harness) => {
      const customHome = join(harness.root, "custom Codex home");
      const root = "custom-root";
      harness.transcript(customHome, root, metadata(root, "cli"));
      harness.run(payload(root), { codexHome: customHome });
      expect(harness.resume()).toMatch(/^codex resume custom-root\n/);
    });
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["malformed ID", payload("bad/id")],
    ["non-string ID", payload({ id: "nested" })],
  ])("rejects %s without changing the prior hint", (_name, value) => {
    withHarness((harness) => {
      const original = harness.seedResume("codex resume original");
      harness.run(value);
      expect(harness.resume()).toBe(original);
    });
  });

  it("rejects metadata whose id does not match the payload", () => {
    withHarness((harness) => {
      const original = harness.seedResume("codex resume original");
      harness.transcript(codex(harness), "requested", metadata("different", "cli"));
      harness.run(payload("requested"));
      expect(harness.resume()).toBe(original);
    });
  });

  it("keeps the prior hint for a source mast cannot resume, an oversized record, and a truncated record", () => {
    withHarness((harness) => {
      const original = harness.seedResume("codex resume original");
      const unsupported = "vscode-source";
      harness.transcript(codex(harness), unsupported, metadata(unsupported, "vscode"));
      harness.run(payload(unsupported));
      expect(harness.resume()).toBe(original);

      const oversized = "oversized";
      harness.transcript(
        codex(harness),
        oversized,
        `${metadata(oversized, "cli").slice(0, -1)},\"padding\":\"${"x".repeat(1_048_576)}\"}`,
      );
      harness.run(payload(oversized));
      expect(harness.resume()).toBe(original);

      const truncated = "truncated";
      harness.transcript(
        codex(harness),
        truncated,
        '{"type":"session_meta","payload":{"id":"truncated","source":"cli"',
      );
      harness.run(payload(truncated));
      expect(harness.resume()).toBe(original);
    });
  });

  it("reads only the first metadata record of a large transcript", () => {
    withHarness((harness) => {
      const root = "large-transcript";
      harness.transcript(codex(harness), root, metadata(root, "cli"), "x".repeat(2 * 1024 * 1024));
      harness.run(payload(root));
      expect(harness.resume()).toMatch(/^codex resume large-transcript\n/);
    });
  });

  it("does not write a hint without MAST_TAB", () => {
    withHarness((harness) => {
      const root = "without-tab";
      harness.transcript(codex(harness), root, metadata(root, "cli"));
      harness.run(payload(root), { tab: null });
      expect(harness.resume()).toBeUndefined();
      expect(existsSync(join(harness.home, ".mast", "resume"))).toBe(false);
    });
  });

  it("still forwards the idle preview when the resume id is malformed", () => {
    withHarness((harness) => {
      const original = harness.seedResume("codex resume original");
      harness.run(payload("rejected/id", "preview; line\nignored"));
      expect(harness.resume()).toBe(original);
      expect(harness.notifyArgs()).toEqual(["mast:idle", "preview; line"]);
    });
  });
});

const DISPATCHER = join(sourceDir, "../../../scripts/wsl/mast-agent-hook.py");

// notify 스크립트가 쓰는 도구만 둔 PATH. jq 를 빼거나 느린 jq 로 바꿔 소유권 확인이 끝나지 못하는
// 경우를 만든다.
function toolDir(harness: Harness, jq: "real" | "absent" | "hangs-on-metadata"): string {
  const bin = join(harness.root, `tools-${jq}`);
  mkdirSync(bin, { recursive: true });
  for (const tool of ["bash", "timeout", "mkdir", "date", "mv", "rm"]) symlinkSync(tools[tool], join(bin, tool));
  if (jq === "real") symlinkSync(tools.jq, join(bin, "jq"));
  if (jq === "hangs-on-metadata") {
    // 소유권 확인만 `--arg` 를 쓴다. thread id 추출은 진짜 jq 로 통과시킨다.
    writeFileSync(
      join(bin, "jq"),
      [`#!${tools.bash}`, 'for arg; do [ "$arg" = --arg ] && exec sleep 30; done', `exec ${shellQuote(tools.jq)} "$@"`, ""].join("\n"),
      { mode: 0o755 },
    );
  }
  return bin;
}

function dispatcherCall(harness: Harness, ownership: string, raw: string): string[] {
  return ["-I", join(harness.home, ".mast", "bin", "mast-agent-hook.py"), "codex-notify", ownership, raw];
}

integration("Codex notify hands the idle decision to the dispatcher", () => {
  it("passes confirmed ownership and the raw payload, writes the hint, and does not fall back", () => {
    withHarness((harness) => {
      const root = "root-confirmed";
      harness.transcript(codex(harness), root, metadata(root, "cli"));
      harness.useDispatcherStub(0);
      const raw = payload(root, "done");
      harness.run(raw);
      expect(harness.dispatcherArgs()).toEqual(dispatcherCall(harness, "confirmed", raw));
      expect(harness.notifyArgs()).toBeUndefined();
      expect(harness.resume()).toMatch(/^codex resume root-confirmed\n/);
    });
  });

  // Codex 0.154 SessionSource 의 serde 표현: 최상위가 아닌 세션은 SubAgent·Internal 두 변형뿐이다.
  it.each([
    ["a spawned subagent", { subagent: { thread_spawn: { parent_thread_id: "root", depth: 1 } } }],
    ["a review subagent", { subagent: "review" }],
    ["an internal guardian session", { internal: "guardian" }],
  ])("reports rejected for %s", (_name, source) => {
    withHarness((harness) => {
      const original = harness.seedResume("codex resume original");
      const scout = "scout-rejected";
      harness.transcript(codex(harness), scout, metadata(scout, source));
      harness.useDispatcherStub(0);
      const raw = payload(scout);
      harness.run(raw);
      expect(harness.dispatcherArgs()).toEqual(dispatcherCall(harness, "rejected", raw));
      expect(harness.resume()).toBe(original);
    });
  });

  const OTHER_ROOT_SOURCES = [
    { name: "a VS Code session", record: (id: string) => metadata(id, "vscode") },
    { name: "a custom source", record: (id: string) => metadata(id, { custom: "atlas" }) },
    { name: "an old rollout without a source", record: (id: string) => JSON.stringify({ type: "session_meta", payload: { id } }) },
  ];

  it.each(OTHER_ROOT_SOURCES)("confirms $name for the dispatcher without writing a hint", ({ record }) => {
    withHarness((harness) => {
      const original = harness.seedResume("claude --resume earlier");
      const id = "other-root";
      harness.transcript(codex(harness), id, record(id));
      harness.useDispatcherStub(0);
      const raw = payload(id);
      harness.run(raw);
      expect(harness.dispatcherArgs()).toEqual(dispatcherCall(harness, "confirmed", raw));
      expect(harness.notifyArgs()).toBeUndefined();
      expect(harness.resume()).toBe(original);
    });
  });

  it.each(OTHER_ROOT_SOURCES)("still falls back to an idle for $name when the dispatcher cannot run", ({ record }) => {
    withHarness((harness) => {
      const id = "other-root-fallback";
      harness.transcript(codex(harness), id, record(id));
      harness.run(payload(id, "resumed elsewhere"));
      expect(harness.notifyArgs()).toEqual(["mast:idle", "resumed elsewhere"]);
      expect(harness.resume()).toBeUndefined();
    });
  });

  it.each([
    { name: "no transcript", jq: "real", prepare: (_harness: Harness, _id: string) => {} },
    {
      name: "metadata for another id",
      jq: "real",
      prepare: (harness: Harness, id: string) => harness.transcript(codex(harness), id, metadata("different", "exec")),
    },
    {
      name: "truncated metadata",
      jq: "real",
      prepare: (harness: Harness, id: string) =>
        harness.transcript(codex(harness), id, `{"type":"session_meta","payload":{"id":"${id}","source":"other"`),
    },
    {
      name: "a metadata check that times out",
      jq: "hangs-on-metadata",
      prepare: (harness: Harness, id: string) => harness.transcript(codex(harness), id, metadata(id, "cli")),
    },
  ] as const)("reports unknown ownership for $name and leaves the hint alone", ({ jq, prepare }) => {
    withHarness((harness) => {
      const original = harness.seedResume("codex resume original");
      const id = "thread-unknown";
      prepare(harness, id);
      harness.useDispatcherStub(0);
      const raw = payload(id);
      harness.run(raw, { env: { PATH: toolDir(harness, jq) } });
      expect(harness.dispatcherArgs()).toEqual(dispatcherCall(harness, "unknown", raw));
      expect(harness.resume()).toBe(original);
    });
  }, 20_000);

  it("reports unknown ownership without jq and falls back to the generic body", () => {
    withHarness((harness) => {
      const root = "root-without-jq";
      harness.transcript(codex(harness), root, metadata(root, "cli"));
      const raw = payload(root, "would be the body");
      harness.useDispatcherStub(1);
      harness.run(raw, { env: { PATH: toolDir(harness, "absent") } });
      expect(harness.dispatcherArgs()).toEqual(dispatcherCall(harness, "unknown", raw));
      expect(harness.notifyArgs()).toEqual(["mast:idle", "codex turn complete"]);
      expect(harness.resume()).toBeUndefined();
    });
  });

  it.each([
    { name: "no interpreter is recorded", prepare: (_harness: Harness) => {} },
    {
      name: "the recorded interpreter does not exist",
      prepare: (harness: Harness) => harness.recordInterpreter(join(harness.root, "gone", "python3")),
    },
    {
      name: "the recorded interpreter is not executable",
      prepare: (harness: Harness) => {
        const path = join(harness.root, "python3-not-executable");
        writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
        harness.recordInterpreter(path);
      },
    },
    { name: "the dispatcher exits non-zero", prepare: (harness: Harness) => void harness.useDispatcherStub(1) },
  ])("falls back to mast-notify.sh when $name", ({ prepare }) => {
    withHarness((harness) => {
      const root = "root-fallback";
      harness.transcript(codex(harness), root, metadata(root, "cli"));
      prepare(harness);
      harness.run(payload(root, "fallback body"));
      expect(harness.notifyArgs()).toEqual(["mast:idle", "fallback body"]);
      expect(harness.resume()).toMatch(/^codex resume root-fallback\n/);
    });
  });

  it.each([
    { name: "no interpreter is recorded", prepare: (_harness: Harness) => {} },
    { name: "the dispatcher exits non-zero", prepare: (harness: Harness) => void harness.useDispatcherStub(1) },
  ])("never falls back for rejected ownership when $name", ({ prepare }) => {
    withHarness((harness) => {
      const scout = "scout-no-fallback";
      harness.transcript(codex(harness), scout, metadata(scout, { subagent: { other: "guardian" } }));
      prepare(harness);
      harness.run(payload(scout));
      expect(harness.notifyArgs()).toBeUndefined();
    });
  });

  it("skips the hint and every emission for a codex exec nested in another Codex thread", () => {
    withHarness((harness) => {
      const original = harness.seedResume("codex resume outer-thread");
      const inner = "inner-exec";
      harness.transcript(codex(harness), inner, metadata(inner, "exec"));
      harness.useDispatcherStub(1);
      harness.run(payload(inner), { env: { CODEX_THREAD_ID: "outer-thread" } });
      expect(harness.dispatcherArgs()).toBeUndefined();
      expect(harness.notifyArgs()).toBeUndefined();
      expect(harness.resume()).toBe(original);

      const raw = payload(inner);
      harness.useDispatcherStub(0);
      harness.run(raw, { env: { CODEX_THREAD_ID: inner } });
      expect(harness.dispatcherArgs()).toEqual(dispatcherCall(harness, "confirmed", raw));
      expect(harness.resume()).toMatch(/^codex resume inner-exec\n/);
    });
  });

  // Claude Code 의 Bash 도구가 띄운 codex exec 는 CLAUDECODE 와 MAST_TAB 을 물려받는다. 그 탭의 에이전트는 Claude 다.
  it.each([
    ["=1", "1"],
    ["set but empty", ""],
  ])("skips the hint and every emission inside Claude Code (CLAUDECODE %s)", (_name, value) => {
    withHarness((harness) => {
      const original = harness.seedResume("claude --resume claude-root");
      const inner = "exec-under-claude";
      harness.transcript(codex(harness), inner, metadata(inner, "exec"));
      harness.useDispatcherStub(1);
      harness.run(payload(inner), { env: { CLAUDECODE: value } });
      expect(harness.dispatcherArgs()).toBeUndefined();
      expect(harness.notifyArgs()).toBeUndefined();
      expect(harness.resume()).toBe(original);
    });
  });

  it("sanitizes the fallback body by code point under LC_ALL=C", () => {
    withHarness((harness) => {
      const cLocale = { env: { LC_ALL: "C", LANG: "C" } };
      harness.run(payload("malformed/id", "a;b\u009c c\u001b]x\u0007 d\u0085e \u009b2J\nsecond"), cLocale);
      expect(harness.notifyArgs()).toEqual(["mast:idle", "a;b  c ]x  d e  2J"]);
      harness.run(payload("malformed/id", "가".repeat(600)), cLocale);
      expect(harness.notifyArgs()).toEqual(["mast:idle", "가".repeat(500)]);
      harness.run(payload("malformed/id", `${"a".repeat(499)}가나`), cLocale);
      expect(harness.notifyArgs()).toEqual(["mast:idle", `${"a".repeat(499)}가`]);
      for (const message of [" \t\u009c \nsecond line", "", null, 42]) {
        harness.run(payload("malformed/id", message), cLocale);
        expect(harness.notifyArgs()).toEqual(["mast:idle", "codex turn complete"]);
      }
    });
  });

  // script 가 새 pty 를 controlling tty 로 만들어 준다. 디스패처가 /dev/tty 로 쓴 OSC 가 그 출력으로
  // 잡히고, 테스트를 돌리는 터미널에는 아무것도 새지 않는다.
  function runInPty(harness: Harness, raw: string): string {
    return execFileSync(
      tools.script,
      ["-qec", `${shellQuote(tools.bash)} ${shellQuote(harness.hookPath)} ${shellQuote(raw)}`, "/dev/null"],
      {
        env: { ...harness.env(), SHELL: tools.bash },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      },
    );
  }

  it("emits idle through the real dispatcher for a confirmed root and nothing for a rejected thread", () => {
    withHarness((harness) => {
      copyFileSync(DISPATCHER, join(harness.home, ".mast", "bin", "mast-agent-hook.py"));
      harness.recordInterpreter(tools.python3);

      const root = "pty-root";
      harness.transcript(codex(harness), root, metadata(root, "cli"));
      expect(runInPty(harness, payload(root, "All tests pass; shipped\nmore"))).toBe(
        "\u001b]777;notify;mast:idle;All tests pass, shipped\u0007",
      );
      expect(harness.notifyArgs()).toBeUndefined();

      const scout = "pty-scout";
      harness.transcript(codex(harness), scout, metadata(scout, { subagent: { other: "guardian" } }));
      expect(runInPty(harness, payload(scout, "scout answer"))).toBe("");
      expect(harness.notifyArgs()).toBeUndefined();
      expect(harness.resume()).toMatch(/^codex resume pty-root\n/);

      const vscode = "pty-vscode";
      harness.transcript(codex(harness), vscode, metadata(vscode, "vscode"));
      expect(runInPty(harness, payload(vscode, "picked up from VS Code"))).toBe(
        "\u001b]777;notify;mast:idle;picked up from VS Code\u0007",
      );
      expect(harness.resume()).toMatch(/^codex resume pty-root\n/);
    });
  }, 20_000);
});
