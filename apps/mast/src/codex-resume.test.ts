// @vitest-environment node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const onLinux = process.platform === "linux";
const integration = onLinux ? describe : describe.skip;

function requireCommand(command: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BASH_ENV;
  try {
    execFileSync("bash", ["--noprofile", "--norc", "-c", `command -v ${command}`], {
      env,
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch {
    throw new Error(`codex resume integration tests require ${command}`);
  }
}

if (onLinux) {
  for (const command of ["bash", "jq", "timeout"]) requireCommand(command);
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

type RunOptions = { tab?: string | null; codexHome?: string };

class Harness {
  readonly root = mkdtempSync(join(tmpdir(), "mast codex resume-"));
  readonly home = join(this.root, "home with spaces");
  readonly defaultCodexHome = join(this.home, ".codex");
  readonly hookPath = join(this.root, "mast-codex-notify.sh");
  readonly notifyArgsPath = join(this.home, ".mast", "notify-argv");

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

  run(payload: string, options: RunOptions = {}): void {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.home };
    delete env.BASH_ENV;
    const tab = options.tab === undefined ? "6" : options.tab;
    if (tab === null) delete env.MAST_TAB;
    else env.MAST_TAB = tab;
    if (options.codexHome === undefined) delete env.CODEX_HOME;
    else env.CODEX_HOME = options.codexHome;
    execFileSync("bash", [this.hookPath, payload], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
  }

  runFreshWrapper(): string {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.home };
    delete env.BASH_ENV;
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

  notifyArgs(): string[] {
    const fields = readFileSync(this.notifyArgsPath, "utf8").split("\0");
    const count = Number(fields.shift());
    return fields.slice(0, count);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function metadata(threadId: string, source: unknown): string {
  return JSON.stringify({ type: "session_meta", payload: { id: threadId, source } });
}

function payload(threadId: unknown, message = "turn complete"): string {
  return JSON.stringify({ "thread-id": threadId, "last-assistant-message": message });
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

  it("rejects unsupported metadata sources, oversized records, and truncated records", () => {
    withHarness((harness) => {
      const original = harness.seedResume("codex resume original");
      const unsupported = "object-source";
      harness.transcript(codex(harness), unsupported, metadata(unsupported, "other"));
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

  it("still forwards the idle preview when the resume id is rejected", () => {
    withHarness((harness) => {
      const original = harness.seedResume("codex resume original");
      harness.run(payload("rejected/id", "preview; line\nignored"));
      expect(harness.resume()).toBe(original);
      expect(harness.notifyArgs()).toEqual(["mast:idle", "preview; line"]);
    });
  });
});
