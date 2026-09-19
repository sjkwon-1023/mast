// @vitest-environment node

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testsDir = dirname(fileURLToPath(import.meta.url));
const wslScripts = join(testsDir, "../../../scripts/wsl");
const DISPATCHER = join(wslScripts, "mast-agent-hook.py");
const ENTRIES = {
  claude: join(wslScripts, "mast-claude-hook.sh"),
  codex: join(wslScripts, "mast-codex-hook.sh"),
} as const;
const HARNESS = join(testsDir, "agent-hooks-harness.py");

const onLinux = process.platform === "linux";

// 러너가 mast 탭 안의 Claude Code·Codex 에서 돌면 이 값들이 이미 있고, 디스패처 게이트와 bash 기동을
// 바꾼다. 테스트가 일부러 넣는 경우만 남긴다.
const AGENT_ENV = ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_HOME", "MAST", "MAST_TAB", "BASH_ENV"];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of AGENT_ENV) delete env[key];
  return env;
}

function findPython(): string | null {
  if (process.platform === "win32") return null;
  try {
    return execFileSync("bash", ["--noprofile", "--norc", "-c", "command -v python3"], {
      encoding: "utf8",
      env: scrubbedEnv(),
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

const PYTHON = findPython();
// Linux 에서는 python3 가 없으면 건너뛰지 않고 실패한다. skip 을 pass 로 세지 않기 위해서다.
if (onLinux && !PYTHON) throw new Error("agent hook tests require python3 on Linux");
const withPython = PYTHON ? describe : describe.skip;
// pty·/proc·bash 가 필요한 실제 프로세스 테스트. CI 는 이 파일을 Linux 러너에서 돌린다.
const linux = onLinux ? describe : describe.skip;

const SLOW = 40_000;
const TAB = "6";

type Json = Record<string, unknown>;
type Mode = "claude" | "codex";
type TtyMode = "ctty" | "background" | "ancestor";

interface Spawned {
  id: number;
  pid: number;
}

interface Finished {
  timeout: boolean;
  code: number;
  stdout: string;
  stderr: string;
  elapsed: number;
  epipe: boolean;
}

interface SpawnOptions {
  via?: "entry" | "direct";
  env?: Record<string, string | null>;
  tty?: TtyMode;
}

class HarnessClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queued: string[] = [];
  private readonly waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private chain: Promise<unknown> = Promise.resolve();
  private stderr = "";
  private exited = false;

  constructor() {
    // detached 는 setsid 다. 제어기가 tty 없는 세션 리더여야 pty 를 controlling tty 로 잡는다.
    this.child = spawn(PYTHON!, ["-B", HARNESS], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: scrubbedEnv(),
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.queued.push(line);
    });
    this.child.on("exit", () => {
      this.exited = true;
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error(`harness exited: ${this.stderr}`));
      }
    });
  }

  private nextLine(): Promise<string> {
    const line = this.queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.exited) return Promise.reject(new Error(`harness exited: ${this.stderr}`));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async ready(): Promise<void> {
    const hello = JSON.parse(await this.nextLine()) as Json;
    if (hello.ready !== true) throw new Error(`harness did not start: ${this.stderr}`);
  }

  request<T>(op: string, args: Json = {}): Promise<T> {
    const send = async (): Promise<T> => {
      this.child.stdin.write(`${JSON.stringify({ op, ...args })}\n`);
      const reply = JSON.parse(await this.nextLine()) as Json;
      if (reply.ok !== true) throw new Error(`harness ${op} failed: ${String(reply.error)}`);
      return reply as T;
    };
    const result = this.chain.then(send, send);
    this.chain = result.catch(() => undefined);
    return result;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

class HookBox {
  readonly root = mkdtempSync(join(tmpdir(), "mast agent hooks-"));
  readonly home = join(this.root, "home dir");
  readonly bin = join(this.home, ".mast", "bin");
  readonly hooksDir = join(this.home, ".mast", "agent-hooks");
  private readonly harness = new HarnessClient();

  static async open(): Promise<HookBox> {
    const box = new HookBox();
    mkdirSync(box.bin, { recursive: true });
    copyFileSync(DISPATCHER, join(box.bin, "mast-agent-hook.py"));
    for (const [mode, source] of Object.entries(ENTRIES)) {
      const target = join(box.bin, `mast-${mode}-hook.sh`);
      copyFileSync(source, target);
      chmodSync(target, 0o755);
    }
    writeFileSync(join(box.bin, "mast-python"), `${PYTHON}\n`);
    await box.harness.ready();
    return box;
  }

  dispose(): void {
    this.harness.close();
    rmSync(this.root, { recursive: true, force: true });
  }

  env(overrides: Record<string, string | null> = {}): Record<string, string> {
    // 러너 환경을 물려받지 않는다. Claude Code 안에서 테스트를 돌리면 CLAUDECODE 가 이미 있다.
    const env: Record<string, string | null> = {
      HOME: this.home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      MAST_TAB: TAB,
      ...overrides,
    };
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== null) clean[key] = value;
    return clean;
  }

  argv(mode: Mode, via: "entry" | "direct"): string[] {
    if (via === "entry") return ["bash", join(this.bin, `mast-${mode}-hook.sh`)];
    return [PYTHON!, "-I", join(this.bin, "mast-agent-hook.py"), mode];
  }

  spawn(mode: Mode, payload: unknown, options: SpawnOptions = {}): Promise<Spawned> {
    return this.harness.request<Spawned>("spawn", {
      argv: this.argv(mode, options.via ?? "entry"),
      env: this.env(options.env),
      stdin: typeof payload === "string" ? payload : JSON.stringify(payload),
      tty: options.tty ?? "ctty",
    });
  }

  spawnNotify(ownership: string, payload: string, env: Record<string, string | null> = {}): Promise<Spawned> {
    return this.harness.request<Spawned>("spawn", {
      argv: [PYTHON!, "-I", join(this.bin, "mast-agent-hook.py"), "codex-notify", ownership, payload],
      env: this.env(env),
      stdin: "",
      tty: "ctty",
    });
  }

  async wait(spawned: Spawned, timeoutSeconds = 15): Promise<Finished> {
    const finished = await this.harness.request<Finished>("wait", { id: spawned.id, timeout: timeoutSeconds });
    if (finished.timeout) throw new Error(`hook process ${spawned.pid} did not exit`);
    return finished;
  }

  async finish(spawned: Spawned): Promise<Finished> {
    const finished = await this.wait(spawned);
    if (finished.code !== 0 || finished.stdout !== "") {
      throw new Error(`hook broke the exit/stdout contract: ${JSON.stringify(finished)}`);
    }
    return finished;
  }

  async run(mode: Mode, payload: unknown, options: SpawnOptions = {}): Promise<Finished> {
    return this.finish(await this.spawn(mode, payload, options));
  }

  async notify(ownership: string, payload: string, env: Record<string, string | null> = {}): Promise<Finished> {
    return this.finish(await this.spawnNotify(ownership, payload, env));
  }

  request<T>(op: string, args: Json = {}): Promise<T> {
    return this.harness.request<T>(op, args);
  }

  async tokens(): Promise<string[]> {
    const { tokens, unterminated } = await this.harness.request<{ tokens: string[][]; unterminated: boolean }>(
      "tokens",
    );
    if (unterminated) throw new Error("an OSC sequence was left unterminated on the pty");
    return tokens.map(([token, body]) => (body ? `${token} ${body}` : token));
  }

  statePath(): string {
    return join(this.hooksDir, `tab-${TAB}.json`);
  }

  state(): any {
    return existsSync(this.statePath()) ? JSON.parse(readFileSync(this.statePath(), "utf8")) : undefined;
  }

  diag(): string {
    const path = join(this.hooksDir, `tab-${TAB}.diag`);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  touchMarker(name: string): void {
    writeFileSync(join(this.home, ".mast", name), "");
  }

  async until(label: string, predicate: (state: any) => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let state: unknown;
      try {
        state = this.state();
      } catch {
        state = undefined;
      }
      if (state !== undefined && predicate(state)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(state)}`);
      await pause(5);
    }
  }

  async wchan(pid: number): Promise<string | null> {
    return (await this.harness.request<{ wchan: string | null }>("wchan", { pid })).wchan;
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withBox(test: (box: HookBox) => Promise<void>): Promise<void> {
  const box = await HookBox.open();
  try {
    await test(box);
  } finally {
    box.dispose();
  }
}

function record(state: any, id: string): any {
  return state?.codex?.records.find((item: any) => item.id === id);
}

const CODEX_SESSION = "019b7a3e-0000-7000-8000-00000000c0de";
const CODEX_TRANSCRIPT = "/home/user/.codex/sessions/2026/09/14/rollout-root.jsonl";

interface CodexScope {
  agent?: string;
  session?: string;
  transcript?: string | null;
}

interface CodexCall extends CodexScope {
  turn: string;
  id?: string;
  tool?: string;
  input?: unknown;
  response?: unknown;
}

// 필드 순서는 Codex 직렬화 순서다(codex-rs/hooks/src/schema.rs:278-392, 564-638). 잘린 payload
// 테스트가 이 순서에 기댄다.
function codexCommon(event: string, turn: string, scope: CodexScope = {}): Json {
  return {
    session_id: scope.session ?? CODEX_SESSION,
    turn_id: turn,
    ...(scope.agent ? { agent_id: scope.agent, agent_type: "default" } : {}),
    transcript_path: scope.transcript === undefined ? CODEX_TRANSCRIPT : scope.transcript,
    cwd: "/work",
    hook_event_name: event,
    model: "gpt-5.5",
    permission_mode: "default",
  };
}

const codex = {
  prompt: (turn: string, scope: CodexScope = {}): Json => ({
    ...codexCommon("UserPromptSubmit", turn, scope),
    prompt: "go on",
  }),
  pre: (call: CodexCall): Json => ({
    ...codexCommon("PreToolUse", call.turn, call),
    tool_name: call.tool ?? "Bash",
    tool_input: call.input ?? { command: "true" },
    tool_use_id: call.id,
  }),
  permission: (call: CodexCall): Json => ({
    ...codexCommon("PermissionRequest", call.turn, call),
    tool_name: call.tool ?? "Bash",
    tool_input: call.input ?? { command: "true" },
  }),
  post: (call: CodexCall): Json => ({
    ...codexCommon("PostToolUse", call.turn, call),
    tool_name: call.tool ?? "Bash",
    tool_input: call.input ?? { command: "true" },
    tool_response: call.response ?? "ok",
    tool_use_id: call.id,
  }),
  // SubagentStopCommandInput(codex-rs/hooks/src/schema.rs:606-622): agent_id 가 hook_event_name 뒤에
  // 오고, transcript_path 는 부모 rollout 경로거나 null 이다.
  subagentStop: (agent: string, turn: string, transcript: string | null = CODEX_TRANSCRIPT): Json => ({
    session_id: CODEX_SESSION,
    turn_id: turn,
    transcript_path: transcript,
    agent_transcript_path: "/home/user/.codex/sessions/2026/09/14/rollout-agent.jsonl",
    cwd: "/work",
    hook_event_name: "SubagentStop",
    model: "gpt-5.5",
    permission_mode: "default",
    stop_hook_active: false,
    agent_id: agent,
    agent_type: "default",
    last_assistant_message: "subagent finished",
  }),
  stop: (turn: string, message: string | null, scope: CodexScope = {}): Json => ({
    ...codexCommon("Stop", turn, { ...scope, agent: undefined }),
    stop_hook_active: false,
    last_assistant_message: message,
  }),
  interrupt: (turn: string, scope: CodexScope = {}): Json => codexCommon("Interrupt", turn, { ...scope, agent: undefined }),
};

function bash(command: string): { command: string } {
  return { command };
}

function notifyPayload(thread: string, turn: string, message: string | null = "turn done"): string {
  return JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": thread,
    "turn-id": turn,
    cwd: "/work",
    "input-messages": ["go on"],
    "last-assistant-message": message,
  });
}

const CLAUDE_SESSION = "7d1c2a4e-1111-4222-8333-444455556666";

interface ClaudeCall {
  tool?: string;
  input?: unknown;
  id?: string;
  agent?: string;
  session?: string;
}

// 공통 필드 뒤에 이벤트 필드가 오는 순서는 Claude Code 2.1.270 번들의 훅 입력 생성 코드와 같다.
function claudeCommon(event: string, call: ClaudeCall = {}): Json {
  return {
    session_id: call.session ?? CLAUDE_SESSION,
    transcript_path: "/home/user/.claude/projects/work/session.jsonl",
    cwd: "/work",
    permission_mode: "default",
    ...(call.agent ? { agent_id: call.agent, agent_type: "Explore" } : {}),
    hook_event_name: event,
  };
}

// 백그라운드 작업 완료가 큐에서 드레인될 때의 prompt 모양(2.1.270 번들의 `Ni()` 봉투).
const TASK_NOTIFICATION =
  "<task-notification>\n<task-id>a1b2c3</task-id>\n<status>completed</status>\n" +
  '<summary>Agent "explore" completed</summary>\n</task-notification>';

const claude = {
  // 2.1.270 번들 `uIn` 은 공통 필드 뒤에 source·agent_type·model·session_title 을 싣는다. null 은 source 누락.
  sessionStart: (source: string | null, call: ClaudeCall = {}): Json => ({
    ...claudeCommon("SessionStart", call),
    ...(source === null ? {} : { source }),
    agent_type: "general-purpose",
    model: "claude-opus-5",
  }),
  prompt: (call: ClaudeCall & { text?: string } = {}): Json => ({
    ...claudeCommon("UserPromptSubmit", call),
    prompt: call.text ?? "go on",
  }),
  permission: (call: ClaudeCall): Json => ({
    ...claudeCommon("PermissionRequest", call),
    tool_name: call.tool ?? "Bash",
    tool_input: call.input ?? { command: "true", description: "noop" },
    permission_suggestions: [],
  }),
  post: (call: ClaudeCall, response: unknown = { stdout: "", stderr: "", interrupted: false, isImage: false }): Json => ({
    ...claudeCommon("PostToolUse", call),
    tool_name: call.tool ?? "Bash",
    tool_input: call.input ?? { command: "true", description: "noop" },
    tool_response: response,
    tool_use_id: call.id ?? "toolu_01",
    duration_ms: 4,
  }),
  failure: (call: ClaudeCall & { interrupt?: boolean }): Json => ({
    ...claudeCommon("PostToolUseFailure", call),
    tool_name: call.tool ?? "Bash",
    tool_input: call.input ?? { command: "true", description: "noop" },
    tool_use_id: call.id ?? "toolu_01",
    error: "Exit code 1",
    is_interrupt: call.interrupt ?? false,
    duration_ms: 4,
  }),
  batch: (call: ClaudeCall = {}): Json => ({ ...claudeCommon("PostToolBatch", call), tool_calls: [] }),
  subagentStop: (agent: string, call: ClaudeCall = {}): Json => ({
    ...claudeCommon("SubagentStop", { ...call, agent }),
    stop_hook_active: false,
    agent_transcript_path: "/home/user/.claude/projects/work/subagents/agent.jsonl",
    last_assistant_message: "found it",
    background_tasks: [],
    session_crons: [],
  }),
  stop: (call: ClaudeCall = {}): Json => ({
    ...claudeCommon("Stop", call),
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: [],
    session_crons: [],
  }),
};

// 방출 dedup TTL(1.5s)에 걸린 running 은 토큰이 새로 나오지 않으므로, "running 이 탭의 마지막
// 상태" 는 상태 파일의 마지막 방출로 확인한다.
function lastEmit(box: HookBox): any {
  return box.state()?.emit;
}

function pythonEval<T>(code: string): T {
  const script = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('mast_agent_hook', sys.argv[1])",
    "hook = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(hook)",
    code,
  ].join("\n");
  const output = execFileSync(PYTHON!, ["-B", "-I", "-c", script, DISPATCHER], {
    encoding: "utf8",
    env: scrubbedEnv(),
    timeout: 20_000,
  });
  return JSON.parse(output) as T;
}

withPython("agent hook dispatcher — pure functions", () => {
  it("parses with the Python 3.8 grammar", () => {
    const output = execFileSync(
      PYTHON!,
      ["-B", "-c", "import ast, sys; ast.parse(open(sys.argv[1]).read(), feature_version=(3, 8)); print('ok')", DISPATCHER],
      { encoding: "utf8", env: scrubbedEnv(), timeout: 20_000 },
    );
    expect(output.trim()).toBe("ok");
  });

  it("normalizes apply_patch text the way Codex parse_patch does", () => {
    const { raw, result } = pythonEval<{ raw: string; result: Record<string, string> }>(`
raw = "*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n*** End Patch"
crlf = raw.replace("\\n", "\\r\\n")
cases = {
    "plain": raw,
    "trailing": raw + "\\n\\n",
    "crlf": crlf + "\\r\\n",
    "heredoc": "<<EOF\\n" + raw + "\\nEOF\\n",
    "single": "<<'EOF'\\r\\n" + crlf + "\\r\\nEOF",
    "double": '<<"EOF"\\n' + raw + "\\nEOF",
    "indented": "  \\t" + raw + " \\n",
    "unicode_space": "\\u00a0" + raw + "\\u3000",
    "separator": "\\x1c" + raw,
    "inner_cr": "*** Begin Patch\\n+a\\rb\\n*** End Patch",
}
print(json.dumps({"raw": raw, "result": {k: hook.normalize_patch(v) for k, v in cases.items()}}))
`);
    for (const name of ["plain", "trailing", "crlf", "heredoc", "single", "double", "indented", "unicode_space"]) {
      expect(result[name], name).toBe(raw);
    }
    // Rust trim 은 U+001C 를 공백으로 보지 않는다. Python strip() 이었다면 지워졌을 것이다.
    expect(result.separator).toBe(`\x1c${raw}`);
    expect(result.inner_cr).toBe("*** Begin Patch\n+a\rb\n*** End Patch");
  });

  it("fingerprints Bash without description, network approvals and MCP arguments", () => {
    const out = pythonEval<Record<string, string>>(`
fp = lambda p: hook.codex_fingerprint(hook.Event(p, False))
summary = lambda p: hook.codex_summary(hook.Event(p, False))
raw = "*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n*** End Patch"
network = {"tool_name": "Bash", "tool_input": {"command": "curl example.com", "description": "network-access example.com:443"}}
print(json.dumps({
    "bash_pre": fp({"tool_name": "Bash", "tool_input": {"command": "curl example.com"}}),
    "bash_permission": fp({"tool_name": "Bash", "tool_input": {"command": "curl example.com", "description": "fetch"}}),
    "network": fp(network),
    "other": fp({"tool_name": "Bash", "tool_input": {"command": "curl example.org"}}),
    "patch_pre": fp({"tool_name": "apply_patch", "tool_input": {"command": "<<'EOF'\\r\\n" + raw.replace("\\n", "\\r\\n") + "\\r\\nEOF\\r\\n"}}),
    "patch_permission": fp({"tool_name": "apply_patch", "tool_input": {"command": raw}}),
    "mcp_empty": fp({"tool_name": "mcp__docs__search", "tool_input": {}}),
    "mcp_null": fp({"tool_name": "mcp__docs__search", "tool_input": None}),
    "mcp_a": fp({"tool_name": "mcp__docs__search", "tool_input": {"q": "x", "n": 1}}),
    "mcp_b": fp({"tool_name": "mcp__docs__search", "tool_input": {"n": 1, "q": "x"}}),
    "mcp_other_tool": fp({"tool_name": "mcp__docs__fetch", "tool_input": {}}),
    "summary_network": summary(network),
    "summary_bash": summary({"tool_name": "Bash", "tool_input": {"command": "make test;\\x07 now\\nsecond line"}}),
    "summary_mcp": summary({"tool_name": "mcp__docs__search", "tool_input": {}}),
}))
`);
    expect(out.bash_permission).toBe(out.bash_pre);
    expect(out.network).toBe(out.bash_pre);
    expect(out.other).not.toBe(out.bash_pre);
    expect(out.patch_permission).toBe(out.patch_pre);
    expect(out.mcp_null).toBe(out.mcp_empty);
    expect(out.mcp_b).toBe(out.mcp_a);
    expect(out.mcp_other_tool).not.toBe(out.mcp_empty);
    expect(out.summary_network).toBe("network access to example.com:443");
    expect(out.summary_bash).toBe("make test,  now");
    expect(out.summary_mcp).toBe("mcp__docs__search");
  });

  it("recovers identifying fields from an oversized payload prefix and tail", () => {
    const out = pythonEval<Record<string, Json>>(`
def split(payload):
    data = json.dumps(payload).encode()
    return data[:hook.PREFIX_BYTES], data[hook.PREFIX_BYTES:][-hook.TAIL_BYTES:]
big = "x" * (hook.PREFIX_BYTES + 9000)
post = {"session_id": "s", "turn_id": "t", "agent_id": "a", "hook_event_name": "PostToolUse",
        "tool_name": "Bash", "tool_input": {"command": "ls"},
        "tool_response": 'say "tool_use_id":"fake" ' + big, "tool_use_id": "call_9"}
huge_input = {"session_id": "s", "hook_event_name": "PostToolUse", "tool_name": "Write",
              "tool_input": {"content": big}, "tool_response": {}, "tool_use_id": "toolu_2"}
fields, truncated = hook.parse_payload(*split(post), True)
fields2, _ = hook.parse_payload(*split(huge_input), True)
print(json.dumps({"post": {k: v for k, v in fields.items()}, "truncated": truncated,
                  "huge": sorted(fields2.keys()), "huge_id": fields2.get("tool_use_id")}))
`);
    expect(out.truncated).toBe(true);
    expect(out.post).toEqual({
      session_id: "s",
      turn_id: "t",
      agent_id: "a",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "call_9",
    });
    expect(out.huge).toEqual(["hook_event_name", "session_id", "tool_name", "tool_use_id"]);
    expect(out.huge_id).toBe("toolu_2");
  });

  it("strips C0/C1 controls and semicolons from bodies and caps them at 500 characters", () => {
    const body = pythonEval<string>(`print(json.dumps(hook.clean_text("a;b\\x1b]0;x\\x07\\u009cc" + "y" * 900, hook.BODY_CHARS)))`);
    expect(body).toHaveLength(500);
    expect(body.startsWith("a,b ]0,x  c")).toBe(true);
    expect(/[\u0000-\u001f\u007f-\u009f;]/.test(body)).toBe(false);
  });
});

linux("agent hook dispatcher — common contract", () => {
  it(
    "entry scripts exit 0 with empty stdout without an interpreter, with a broken one, and outside mast",
    async () => {
      await withBox(async (box) => {
        const big = JSON.stringify({ hook_event_name: "PostToolUse", filler: "z".repeat(2 * 1024 * 1024) });
        for (const mode of ["claude", "codex"] as const) {
          rmSync(join(box.bin, "mast-python"), { force: true });
          const missing = await box.run(mode, big);
          expect(missing.epipe, `${mode} must drain stdin`).toBe(false);
          expect(box.diag()).toContain(`${mode}-entry: no usable interpreter`);

          writeFileSync(join(box.bin, "mast-python"), `${join(box.root, "not-python")}\n`);
          await box.run(mode, big);
          expect(box.diag()).toContain("no usable interpreter");

          writeFileSync(join(box.bin, "mast-python"), `${PYTHON}\n`);
          writeFileSync(join(box.bin, "mast-agent-hook.py"), "def broken(:\n");
          const crashed = await box.run(mode, codex.prompt("t1"));
          expect(crashed.stderr).toBe("");
          expect(box.diag()).toMatch(new RegExp(`${mode}-entry: dispatcher exited with status 1: [\\s\\S]*SyntaxError`));
          copyFileSync(DISPATCHER, join(box.bin, "mast-agent-hook.py"));

          rmSync(box.hooksDir, { recursive: true, force: true });
          const outside = await box.run(mode, big, { env: { MAST_TAB: null } });
          expect(outside.epipe).toBe(false);
          expect(existsSync(box.hooksDir)).toBe(false);
        }
        expect(await box.tokens()).toEqual([]);
      });
    },
    SLOW,
  );

  it(
    "gates on MAST_TAB, CLAUDECODE, a null transcript and a nested CODEX_THREAD_ID",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.prompt("t1"), { env: { MAST_TAB: null }, via: "direct" });
        await box.run("codex", codex.prompt("t1"), { env: { MAST_TAB: "6x" }, via: "direct" });
        expect(existsSync(box.hooksDir)).toBe(false);
        await box.run("codex", codex.prompt("t1"), { env: { CLAUDECODE: "1" } });
        await box.run("codex", codex.prompt("t1", { transcript: null }));
        await box.run("codex", codex.prompt("t1", { transcript: "" }));
        await box.run("codex", codex.prompt("t1"), { env: { CODEX_THREAD_ID: "outer-thread" } });
        expect(await box.tokens()).toEqual([]);
        expect(box.state()).toBeUndefined();

        await box.run("codex", codex.prompt("t1"), { env: { CODEX_THREAD_ID: CODEX_SESSION } });
        expect(await box.tokens()).toEqual(["mast:running"]);
        // CLAUDECODE 게이트는 codex 모드에만 걸린다(같은 탭 Claude 가 띄운 codex exec).
        await box.run("claude", claude.permission({ input: bash("make") }), { env: { CLAUDECODE: "1" } });
        expect(box.state().claude.awaiting).toHaveLength(1);
      });
    },
    SLOW,
  );

  it(
    "never touches resume hint files",
    async () => {
      await withBox(async (box) => {
        const resumeDir = join(box.home, ".mast", "resume");
        mkdirSync(resumeDir, { recursive: true });
        const hint = join(resumeDir, `tab-${TAB}`);
        writeFileSync(hint, "codex resume keep-me\n123\n");
        const before = statSync(hint);
        await box.run("claude", claude.prompt());
        await box.run("claude", claude.permission({ input: bash("rm -rf build") }));
        await box.run("claude", claude.post({ input: bash("rm -rf build") }));
        await box.run("claude", claude.stop());
        await box.run("codex", codex.prompt("t1"));
        await box.run("codex", codex.pre({ turn: "t1", id: "c1" }));
        await box.run("codex", codex.post({ turn: "t1", id: "c1" }));
        await box.run("codex", codex.stop("t1", "done"));
        await box.notify("confirmed", notifyPayload(CODEX_SESSION, "t1"));
        const after = statSync(hint);
        expect(readFileSync(hint, "utf8")).toBe("codex resume keep-me\n123\n");
        expect(after.mtimeMs).toBe(before.mtimeMs);
      });
    },
    SLOW,
  );

  it(
    "releases waits from oversized stdin through the prefix and tail",
    async () => {
      await withBox(async (box) => {
        const huge = "r".repeat(1536 * 1024);
        await box.run("codex", codex.pre({ turn: "t1", id: "call-big", input: bash("cat big.log") }));
        const sleeper = await box.spawn("codex", codex.permission({ turn: "t1", input: bash("cat big.log") }));
        await box.until("candidate", (s) => record(s, "call-big")?.state === "candidate");
        await box.run("codex", codex.post({ turn: "t1", id: "call-big", input: bash("cat big.log"), response: huge }));
        expect(record(box.state(), "call-big")).toBeUndefined();
        await box.finish(sleeper);
        expect(await box.tokens()).toEqual(["mast:running"]);

        await box.run("claude", claude.permission({ input: bash("cat big.log") }));
        await box.run("claude", claude.post({ input: bash("cat big.log") }, huge));
        expect(box.state().claude.awaiting).toEqual([]);
        await box.run("claude", claude.permission({ tool: "Write", input: { file_path: "/w/a", content: "small" } }));
        await box.run("claude", claude.post({ tool: "Write", input: { file_path: "/w/a", content: huge } }));
        expect(box.state().claude.awaiting).toEqual([]);
        expect(box.diag()).toContain("tool_input unreadable; released the oldest waiting call of that tool");
      });
    },
    SLOW,
  );

  it(
    "reinitializes a truncated state file",
    async () => {
      await withBox(async (box) => {
        mkdirSync(box.hooksDir, { recursive: true });
        writeFileSync(box.statePath(), '{"version":1,"seq":4,"claude":{"awai');
        await box.run("codex", codex.prompt("t1"));
        expect(box.diag()).toContain("state file unreadable; reinitialized");
        expect(box.state().codex.root.ups_turn).toBe("t1");
        expect(await box.tokens()).toEqual(["mast:running"]);
      });
    },
    SLOW,
  );

  it(
    "caps records at 64 by evicting open ones, keeps emitted ones, and still raises needsInput",
    async () => {
      await withBox(async (box) => {
        const records = [
          { scope: "agent-a", turn: "ta", id: "sub-call", fp: "f", seq: 1, state: "emitted", summary: "sub approval" },
          ...Array.from({ length: 63 }, (_, index) => ({
            scope: "root",
            turn: "t1",
            id: `old-${index}`,
            fp: `fp-${index}`,
            seq: index + 2,
            state: "open",
            summary: null,
          })),
        ];
        mkdirSync(box.hooksDir, { recursive: true });
        writeFileSync(
          box.statePath(),
          JSON.stringify({
            version: 1,
            seq: 64,
            emit: null,
            claude: { awaiting: [], sessions: [] },
            codex: {
              root: { session: CODEX_SESSION, ups_seq: 0, ups_turn: "t1", end_seq: 0, end_turn: null, end_body: "x", ended: [] },
              records,
            },
          }),
        );
        await box.run("codex", codex.pre({ turn: "t1", id: "call-new", input: bash("make deploy") }));
        expect(box.diag()).toContain("record limit reached; evicted the oldest open record");
        const state = box.state();
        expect(state.codex.records).toHaveLength(64);
        expect(record(state, "sub-call")?.state).toBe("emitted");
        expect(record(state, "old-0")).toBeUndefined();
        await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: bash("make deploy") })));
        expect(await box.tokens()).toEqual(["mast:needsInput make deploy"]);
      });
    },
    SLOW,
  );

  it(
    "gives up on a held lock within each event's budget without emitting",
    async () => {
      await withBox(async (box) => {
        mkdirSync(box.hooksDir, { recursive: true });
        await box.request("lock", { path: join(box.hooksDir, `tab-${TAB}.lock`) });
        // 5s timeout 동기 훅은 3.0s, 3s timeout 인 Interrupt 는 1.5s 까지 기다린다.
        const prompt = await box.finish(await box.spawn("codex", codex.prompt("t1"), { via: "direct" }));
        expect(box.diag()).toContain("state lock not acquired within 3.0s");
        const interrupt = await box.finish(await box.spawn("codex", codex.interrupt("t1"), { via: "direct" }));
        expect(box.diag()).toContain("state lock not acquired within 1.5s");
        await box.request("unlock");
        expect(prompt.elapsed).toBeGreaterThanOrEqual(2.9);
        expect(prompt.elapsed).toBeLessThan(4.5);
        expect(interrupt.elapsed).toBeGreaterThanOrEqual(1.4);
        expect(interrupt.elapsed).toBeLessThan(2.8);
        expect(await box.tokens()).toEqual([]);
        expect(box.state()).toBeUndefined();
      });
    },
    SLOW,
  );

  it(
    "recreates no state, lock or diag file when a sleeper wakes after the tab's files were removed",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: bash("make deploy") }));
        const sleeper = await box.spawn("codex", codex.permission({ turn: "t1", input: bash("make deploy") }));
        await box.until("candidate", (s) => record(s, "c1")?.state === "candidate");
        // 탭 닫힘 뒤 host 의 release rm 흉내.
        for (const suffix of ["json", "lock", "diag"]) rmSync(join(box.hooksDir, `tab-${TAB}.${suffix}`), { force: true });
        await box.finish(sleeper);
        for (const suffix of ["json", "lock", "diag"]) {
          expect(existsSync(join(box.hooksDir, `tab-${TAB}.${suffix}`)), suffix).toBe(false);
        }
        expect(await box.tokens()).toEqual([]);
      });
    },
    SLOW,
  );

  it(
    "writes no state file for late events that have nothing to record",
    async () => {
      await withBox(async (box) => {
        await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: bash("make deploy") })));
        expect(box.diag()).toContain("PermissionRequest matched no pending tool call");
        await box.run("codex", codex.subagentStop("agent-a", "ta"));
        await box.run("claude", claude.stop());
        await box.run("claude", claude.subagentStop("agent-1"));
        await box.run("claude", claude.sessionStart("startup"));
        expect(box.state()).toBeUndefined();
        expect(await box.tokens()).toEqual([]);
      });
    },
    SLOW,
  );

  it(
    "leaves no unterminated OSC on a pty whose buffer stays full, and notify retries the unhandled idle",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.prompt("t1"));
        expect(await box.tokens()).toEqual(["mast:running"]);
        await box.request("jam");
        const stop = await box.finish(await box.spawn("codex", codex.stop("t1", "all done"), { via: "direct" }));
        expect(stop.elapsed).toBeLessThan(3);
        await box.request("unjam");
        expect(await box.tokens()).toEqual(["mast:running"]);
        const state = box.state();
        expect(state.emit).toMatchObject({ token: "mast:idle", ok: false });
        expect(state.codex.root.ended).toEqual([{ turn: "t1", handled: false }]);

        await box.notify("unknown", notifyPayload(CODEX_SESSION, "t1", "all done"));
        expect(await box.tokens()).toEqual(["mast:running", "mast:idle all done"]);
      });
    },
    SLOW,
  );

  it(
    "completes a blocked terminal write once the pty drains within the deadline",
    async () => {
      await withBox(async (box) => {
        await box.request("jam");
        const stop = await box.spawn("codex", codex.stop("t1", "finished"), { via: "direct" });
        await waitForWchan(box, stop.pid, /wait_woken|n_tty_write|tty_write/, "a blocked tty write");
        await box.request("unjam");
        await box.finish(stop);
        expect(await box.tokens()).toEqual(["mast:idle finished"]);
        expect(box.state().emit).toMatchObject({ token: "mast:idle", ok: true });
      });
    },
    SLOW,
  );

  it(
    "writes from a background process group with TOSTOP set",
    async () => {
      await withBox(async (box) => {
        // 대조군: SIGTTOU 를 무시하지 않는 쓰기는 이 배치에서 멈춰야 테스트가 의미가 있다.
        const control = await box.request<Spawned>("spawn", {
          argv: [PYTHON!, "-c", "import os; os.write(os.open('/dev/tty', os.O_WRONLY), b'control')"],
          env: box.env(),
          stdin: "",
          tty: "background",
        });
        const stuck = await box.request<{ timeout: boolean }>("wait", { id: control.id, timeout: 1 });
        expect(stuck.timeout).toBe(true);
        await box.request("kill", { id: control.id });

        await box.run("codex", codex.prompt("t1"), { tty: "background" });
        expect(await box.tokens()).toEqual(["mast:running"]);
      });
    },
    SLOW,
  );

  it(
    "falls back to an ancestor's pts without a controlling tty",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.post({}), { tty: "ancestor" });
        expect(await box.tokens()).toEqual(["mast:running"]);
      });
    },
    SLOW,
  );

  it(
    "suppresses a repeated running within 1.5s and emits it again after the TTL",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.post({}));
        const first = Date.now();
        await box.run("claude", claude.post({}));
        expect(await box.tokens()).toEqual(["mast:running"]);
        await pause(Math.max(0, 1_700 - (Date.now() - first)));
        await box.run("claude", claude.post({}));
        expect(await box.tokens()).toEqual(["mast:running", "mast:running"]);
      });
    },
    SLOW,
  );

  it(
    "starts over when the Codex session_id changes",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.prompt("t1"));
        await box.run("codex", codex.pre({ turn: "t1", id: "c1" }));
        await box.run("codex", codex.prompt("n1", { session: "other-session" }));
        const state = box.state();
        expect(state.codex.root).toMatchObject({ session: "other-session", ups_turn: "n1" });
        expect(state.codex.records).toEqual([]);
      });
    },
    SLOW,
  );
});

async function waitForWchan(box: HookBox, pid: number, pattern: RegExp, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const wchan = await box.wchan(pid);
    if (wchan !== null && pattern.test(wchan)) return;
    if (Date.now() > deadline) throw new Error(`pid ${pid} never reached ${label} (wchan ${wchan})`);
    await pause(2);
  }
}

linux("agent hook dispatcher — Claude input pairing", () => {
  it(
    "keeps a root permission wait through a subagent Post",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.prompt());
        await box.run("claude", claude.permission({ input: bash("git push") }));
        await box.run("claude", claude.post({ agent: "agent-1", tool: "Read", input: { file_path: "/w/a" } }));
        expect(await box.tokens()).toEqual([]);
        expect(box.state().claude.awaiting).toHaveLength(1);
      });
    },
    SLOW,
  );

  it(
    "releases only the wait whose input matches, not a parallel sibling's",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.permission({ tool: "WebFetch", input: { url: "https://a.example", prompt: "p" } }));
        await box.run("claude", claude.post({ tool: "WebFetch", input: { url: "https://b.example", prompt: "p" } }));
        expect(await box.tokens()).toEqual([]);
        await box.run("claude", claude.post({ tool: "WebFetch", input: { prompt: "p", url: "https://a.example" } }));
        expect(await box.tokens()).toEqual(["mast:running"]);
        expect(box.state().claude.awaiting).toEqual([]);
      });
    },
    SLOW,
  );

  it(
    "sweeps a feedback denial at PostToolBatch, including ExitPlanMode keep-planning then approval",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.permission({ input: bash("rm -rf dist") }));
        await box.run("claude", claude.batch());
        expect(await box.tokens()).toEqual(["mast:running"]);

        const plan = (text: string) => ({ plan: text, planFilePath: "/home/user/.claude/plans/p.md" });
        await box.run("claude", claude.permission({ tool: "ExitPlanMode", input: plan("v1") }));
        await box.run("claude", claude.batch());
        await box.run("claude", claude.permission({ tool: "ExitPlanMode", input: plan("v2") }));
        expect(box.state().claude.awaiting).toHaveLength(1);
        // 승인 뒤 `DK()` 가 plan·planFilePath 를 지운 입력이 PostToolUse 에 실린다.
        await box.run("claude", claude.post({ tool: "ExitPlanMode", input: {} }));
        expect(box.state().claude.awaiting).toEqual([]);
        expect(lastEmit(box)).toMatchObject({ token: "mast:running", ok: true });
      });
    },
    SLOW,
  );

  it(
    "releases a PermissionRequest that arrived after its Post at the end of the batch",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.post({ input: bash("npm test") }));
        await box.run("claude", claude.permission({ input: bash("npm test") }));
        expect(box.state().claude.awaiting).toHaveLength(1);
        await box.run("claude", claude.batch());
        expect(box.state().claude.awaiting).toEqual([]);
        expect(lastEmit(box)).toMatchObject({ token: "mast:running" });
      });
    },
    SLOW,
  );

  it(
    "keeps subagent waits through root Stop and clears them at SubagentStop",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.prompt());
        await box.run("claude", claude.permission({ agent: "agent-1", input: bash("docker build .") }));
        await box.run("claude", claude.stop());
        expect(box.state().claude.awaiting).toMatchObject([{ scope: "agent-1" }]);
        await box.run("claude", claude.subagentStop("agent-1"));
        expect(box.state().claude.awaiting).toEqual([]);
        expect(await box.tokens()).toEqual(["mast:idle done"]);

        await box.run("claude", claude.prompt());
        await box.run("claude", claude.permission({ agent: "agent-2", input: bash("docker push") }));
        await box.run("claude", claude.subagentStop("agent-2"));
        expect(await box.tokens()).toEqual(["mast:idle done", "mast:running"]);
        await box.run("claude", claude.subagentStop("agent-3"));
        expect(await box.tokens()).toEqual(["mast:idle done", "mast:running"]);
      });
    },
    SLOW,
  );

  it(
    "treats a root is_interrupt failure like any other failure",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.permission({ tool: "WebFetch", input: { url: "https://a.example", prompt: "p" } }));
        await box.run("claude", claude.permission({ agent: "agent-1", input: bash("ls") }));
        await box.run("claude", claude.failure({ input: bash("sleep 100"), interrupt: true }));
        expect(await box.tokens()).toEqual([]);
        expect(box.state().claude.awaiting).toHaveLength(2);
        await box.run("claude", claude.failure({ tool: "WebFetch", input: { url: "https://a.example", prompt: "p" }, interrupt: true }));
        expect(box.state().claude.awaiting).toMatchObject([{ scope: "agent-1" }]);
        expect(await box.tokens()).toEqual([]);
        await box.run("claude", claude.failure({ agent: "agent-1", input: bash("ls"), interrupt: true }));
        expect(await box.tokens()).toEqual(["mast:running"]);
      });
    },
    SLOW,
  );

  it(
    "a task-notification prompt keeps a subagent wait and marks the woken root working",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.prompt());
        await box.run("claude", claude.stop());
        await box.run("claude", claude.permission({ agent: "agent-b", input: bash("docker push x") }));
        await box.run("claude", claude.prompt({ text: TASK_NOTIFICATION }));
        const state = box.state();
        expect(state.claude.awaiting).toMatchObject([{ scope: "agent-b" }]);
        expect(state.claude.sessions).toMatchObject([{ session: CLAUDE_SESSION, active: true }]);
        // root 가 알림을 처리하는 동안 B 가 멈춰도 탭은 idle 이 아니다.
        await box.run("claude", claude.subagentStop("agent-b"));
        expect(await box.tokens()).toEqual(["mast:running"]);
      });
    },
    SLOW,
  );

  it(
    "a prompt folded in mid-fan-out keeps a subagent's open approval, even from a truncated payload",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.prompt({ text: "fan out" }));
        await box.run("claude", claude.permission({ agent: "agent-b", input: bash("docker push x") }));
        await box.run("claude", claude.post({ input: bash("ls") }));
        await box.run("claude", claude.batch());
        await box.run("claude", claude.prompt({ text: "also check the README" }));
        await box.run("claude", claude.prompt({ text: `also read this log\n${"f".repeat(1536 * 1024)}` }));
        expect(box.state().claude.awaiting).toMatchObject([{ scope: "agent-b" }]);
        await box.run("claude", claude.post({ tool: "Read", input: { file_path: "/w/README.md" } }));
        expect(await box.tokens()).toEqual([]);
      });
    },
    SLOW,
  );

  it(
    "a root prompt of any kind clears its own session's root waits and every wait of other sessions",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.permission({ input: bash("rm -rf dist") }));
        await box.run("claude", claude.permission({ agent: "agent-b", input: bash("docker push x") }));
        await box.run("claude", claude.permission({ session: "ended-session", input: bash("make") }));
        await box.run("claude", claude.permission({ session: "ended-session", agent: "agent-z", input: bash("make") }));
        await box.run("claude", claude.prompt({ text: TASK_NOTIFICATION }));
        expect(box.state().claude.awaiting).toMatchObject([{ session: CLAUDE_SESSION, scope: "agent-b" }]);
      });
    },
    SLOW,
  );

  it.each(["resume", "startup"])(
    "a %s SessionStart drops that session's leftover waits and marks it inactive",
    async (source) => {
      await withBox(async (box) => {
        await box.run("claude", claude.prompt());
        await box.run("claude", claude.permission({ agent: "agent-b", input: bash("docker push x") }));
        await box.run("claude", claude.permission({ session: "nested-claude-p", agent: "agent-z", input: bash("make") }));
        // 여기서 Claude 가 SubagentStop 없이 죽는다(WSL 절전, kill). 같은 탭에서 같은 id 로 다시 뜬다.
        await box.run("claude", claude.sessionStart(source));
        const state = box.state();
        expect(state.claude.awaiting).toMatchObject([{ session: "nested-claude-p", scope: "agent-z" }]);
        expect(state.claude.awaiting).toHaveLength(1);
        expect(state.claude.sessions).toMatchObject([{ session: CLAUDE_SESSION, active: false }]);
        expect(await box.tokens()).toEqual([]);

        await box.run("claude", claude.prompt());
        await box.run("claude", claude.permission({ input: bash("rm -rf dist") }));
        await box.run("claude", claude.post({ input: bash("rm -rf dist") }));
        expect(await box.tokens()).toEqual(["mast:running"]);
      });
    },
    SLOW,
  );

  it.each([["clear"], ["compact"], ["fork"], ["reload"], [null]])(
    "a SessionStart with source %s keeps an open subagent wait",
    async (source) => {
      await withBox(async (box) => {
        await box.run("claude", claude.prompt());
        await box.run("claude", claude.permission({ agent: "agent-b", input: bash("docker push x") }));
        await box.run("claude", claude.sessionStart(source));
        const state = box.state();
        expect(state.claude.awaiting).toMatchObject([{ session: CLAUDE_SESSION, scope: "agent-b" }]);
        expect(state.claude.sessions).toMatchObject([{ session: CLAUDE_SESSION, active: true }]);
        await box.run("claude", claude.post({ input: bash("ls") }));
        expect(await box.tokens()).toEqual([]);
        await box.run("claude", claude.subagentStop("agent-b"));
        expect(await box.tokens()).toEqual(["mast:running"]);
      });
    },
    SLOW,
  );

  it.each([
    ["PermissionRequest", claude.permission({ input: bash("make") })],
    ["PostToolUse", claude.post({ input: bash("make") })],
    ["PostToolUseFailure", claude.failure({ input: bash("make") })],
    ["PostToolBatch", claude.batch()],
  ])("a root %s after Stop marks the session working again", async (_name, event) => {
    await withBox(async (box) => {
      await box.run("claude", claude.prompt());
      await box.run("claude", claude.stop());
      await box.run("claude", event);
      expect(box.state().claude.sessions).toMatchObject([{ session: CLAUDE_SESSION, active: true }]);
      // Stop-block 이어짐 중 서브에이전트 대기가 SubagentStop 으로 끝나면 root 는 아직 일하는 중이다.
      await box.run("claude", claude.permission({ agent: "agent-1", input: bash("docker build .") }));
      await box.run("claude", claude.subagentStop("agent-1"));
      expect((await box.tokens()).filter((token) => token.startsWith("mast:idle"))).toEqual([]);
    });
  }, SLOW);

  it(
    "releases an AskUserQuestion or edited Edit wait by tool name when the permission UI rewrote the input",
    async () => {
      await withBox(async (box) => {
        const questions = [{ question: "Which DB?", header: "DB", options: [{ label: "pg" }, { label: "sqlite" }] }];
        await box.run("claude", claude.permission({ tool: "AskUserQuestion", input: { questions } }));
        await box.run("claude", claude.post({ tool: "AskUserQuestion", input: { questions, answers: { "Which DB?": "pg" } } }));
        expect(box.state().claude.awaiting).toEqual([]);
        expect(await box.tokens()).toEqual(["mast:running"]);

        const edit = { file_path: "/w/a.ts", old_string: "a", new_string: "b" };
        await box.run("claude", claude.permission({ tool: "Edit", input: edit }));
        await box.run("claude", claude.post({ tool: "Edit", input: { ...edit, new_string: "b // edited in the IDE" } }));
        expect(box.state().claude.awaiting).toEqual([]);

        // 이름 fallback 은 목록의 도구에만 쓴다. 병렬 WebFetch 형제는 여전히 입력이 같아야 해제된다.
        await box.run("claude", claude.permission({ tool: "WebFetch", input: { url: "https://a.example", prompt: "p" } }));
        await box.run("claude", claude.post({ tool: "WebFetch", input: { url: "https://b.example", prompt: "p" } }));
        expect(box.state().claude.awaiting).toHaveLength(1);
      });
    },
    SLOW,
  );

  it(
    "does not let another session's Stop clear a wait, while a new root prompt clears stale sessions",
    async () => {
      await withBox(async (box) => {
        await box.run("claude", claude.permission({ input: bash("make") }));
        await box.run("claude", claude.stop({ session: "nested-claude-p" }));
        expect(box.state().claude.awaiting).toHaveLength(1);
        await box.run("claude", claude.prompt({ session: "next-session" }));
        expect(box.state().claude.awaiting).toEqual([]);
        await box.run("claude", claude.post({ input: bash("make"), session: "next-session" }));
        expect(await box.tokens()).toEqual(["mast:running"]);
      });
    },
    SLOW,
  );

  it(
    "emits running from every Post without pairing when pairing is off",
    async () => {
      await withBox(async (box) => {
        box.touchMarker("claude-pairing-off");
        await box.run("claude", claude.permission({ input: bash("git push") }));
        await box.run("claude", claude.post({ agent: "agent-1", tool: "Read", input: { file_path: "/w/a" } }));
        expect(await box.tokens()).toEqual(["mast:running"]);
        await box.run("claude", claude.failure({ interrupt: true }));
        await box.run("claude", claude.batch());
        expect(await box.tokens()).toEqual(["mast:running"]);
        expect(lastEmit(box)).toMatchObject({ token: "mast:running" });
        expect(box.state().claude.awaiting).toEqual([]);
      });
    },
    SLOW,
  );
});

linux.concurrent("agent hook dispatcher — Codex races", () => {
  const cmd = bash("cargo publish");

  it("Pre → Permission → fast Post raises no needsInput", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      const sleeper = await box.spawn("codex", codex.permission({ turn: "t1", input: { ...cmd, description: "why" } }));
      await box.until("candidate", (s) => record(s, "c1")?.state === "candidate");
      await box.run("codex", codex.post({ turn: "t1", id: "c1", input: cmd }));
      await box.finish(sleeper);
      expect(await box.tokens()).toEqual(["mast:running"]);
    });
  }, SLOW);

  it("Post → late-starting Permission raises no needsInput", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      await box.run("codex", codex.post({ turn: "t1", id: "c1", input: cmd }));
      const late = await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      expect(late.elapsed).toBeLessThan(1.5);
      expect(box.diag()).toContain("PermissionRequest matched no pending tool call");
      expect(await box.tokens()).toEqual(["mast:running"]);
    });
  }, SLOW);

  it("a Permission that outlives the 2s hold-off raises needsInput, then Post restores running", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      const sleeper = await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      expect(sleeper.elapsed).toBeGreaterThanOrEqual(2);
      expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput cargo publish"]);
      await box.run("codex", codex.post({ turn: "t1", id: "c1", input: cmd }));
      expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput cargo publish", "mast:running"]);
    });
  }, SLOW);

  it.each([
    ["Stop", codex.stop("t1", "stopped"), "mast:idle stopped"],
    ["Interrupt", codex.interrupt("t1"), "mast:idle interrupted"],
    ["a new root prompt", codex.prompt("t2"), "mast:running"],
  ])("%s silences an old sleeper", async (_name, ending, token) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      const sleeper = await box.spawn("codex", codex.permission({ turn: "t1", input: cmd }));
      await box.until("candidate", (s) => record(s, "c1")?.state === "candidate");
      await box.run("codex", ending);
      await box.finish(sleeper);
      expect(await box.tokens()).toEqual([token]);
    });
  }, SLOW);

  it("a parallel sibling's Pre after emission keeps needsInput", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      await box.run("codex", codex.pre({ turn: "t1", id: "c2", input: bash("ls") }));
      expect(await box.tokens()).toEqual(["mast:needsInput cargo publish"]);
      expect(record(box.state(), "c1")?.state).toBe("emitted");
    });
  }, SLOW);

  it("a Stop-block continuation resumes root with running and pairs its approvals", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.stop("t1", "first pass"));
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      const root = box.state().codex.root;
      expect(root.ups_seq).toBeGreaterThan(root.end_seq);
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      await box.run("codex", codex.post({ turn: "t1", id: "c1", input: cmd }));
      expect(await box.tokens()).toEqual([
        "mast:running",
        "mast:idle first pass",
        "mast:running",
        "mast:needsInput cargo publish",
        "mast:running",
      ]);
    });
  }, SLOW);

  it("ignores a root prompt that carries an ended turn id", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.stop("t1", "done"));
      const before = box.state();
      await box.run("codex", codex.prompt("t1"));
      expect(box.state()).toEqual(before);
      expect(await box.tokens()).toEqual(["mast:running", "mast:idle done"]);
    });
  }, SLOW);

  it("after root Interrupt a subagent approval raises needsInput and its Post restores idle", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.interrupt("t1"));
      await box.run("codex", codex.pre({ turn: "ta", id: "s1", agent: "agent-a", input: cmd }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "ta", agent: "agent-a", input: cmd })));
      await box.run("codex", codex.post({ turn: "ta", id: "s1", agent: "agent-a", input: cmd }));
      expect(await box.tokens()).toEqual([
        "mast:running",
        "mast:idle interrupted",
        "mast:needsInput cargo publish",
        "mast:idle interrupted",
      ]);
    });
  }, SLOW);

  it("a queued-input or steer root prompt re-asserts a pending subagent approval", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.pre({ turn: "ta", id: "s1", agent: "agent-a", input: cmd }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "ta", agent: "agent-a", input: cmd })));
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.prompt("t2"));
      expect(await box.tokens()).toEqual([
        "mast:running",
        "mast:needsInput cargo publish",
        "mast:needsInput cargo publish",
        "mast:needsInput cargo publish",
      ]);
      expect(record(box.state(), "s1")?.state).toBe("emitted");
    });
  }, SLOW);

  it("root Stop keeps needsInput while a subagent approval is pending", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.pre({ turn: "ta", id: "s1", agent: "agent-a", input: cmd }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "ta", agent: "agent-a", input: cmd })));
      await box.run("codex", codex.stop("t1", "root done"));
      expect(await box.tokens()).toEqual([
        "mast:running",
        "mast:needsInput cargo publish",
        "mast:needsInput cargo publish",
      ]);
      expect(box.state().codex.root.ended).toEqual([{ turn: "t1", handled: true }]);
    });
  }, SLOW);

  it("a SubagentStop closes a subagent approval that never got a Post and restores the ended root's idle", async ({ expect }) => {
    await withBox(async (box) => {
      const mcp = { tool: "mcp__deploy__release", input: { env: "prod" } };
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.pre({ turn: "ta", id: "s1", agent: "agent-a", ...mcp }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "ta", agent: "agent-a", ...mcp })));
      // 승인 뒤 isError 라 PostToolUse 가 없다. root Stop 은 needsInput 을 재주장한다.
      await box.run("codex", codex.stop("t1", "root done"));
      // 부모 transcript 를 읽지 못한 SubagentStop 도 정리한다.
      await box.run("codex", codex.subagentStop("agent-a", "ta", null));
      await box.run("codex", codex.prompt("t2"));
      expect(await box.tokens()).toEqual([
        "mast:running",
        "mast:needsInput mcp__deploy__release",
        "mast:needsInput mcp__deploy__release",
        "mast:idle root done",
        "mast:running",
      ]);
      expect(box.state().codex.records).toEqual([]);
    });
  }, SLOW);

  it("a SubagentStop while root works restores running", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.pre({ turn: "ta", id: "s1", agent: "agent-a", input: cmd }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "ta", agent: "agent-a", input: cmd })));
      await box.run("codex", codex.subagentStop("agent-a", "ta"));
      expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput cargo publish", "mast:running"]);
    });
  }, SLOW);

  it("a SubagentStop never emits idle by itself and touches only its own scope", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.stop("t1", "done"));
      await box.run("codex", codex.pre({ turn: "tb", id: "s2", agent: "agent-b", input: bash("ls") }));
      await box.run("codex", codex.pre({ turn: "t2", id: "r1", input: bash("pwd") }));
      await box.run("codex", codex.subagentStop("agent-z", "tz"));
      await box.run("codex", { ...codex.subagentStop("agent-b", "tb"), session_id: "other-session" });
      const noAgent: Json = codex.subagentStop("agent-b", "tb");
      delete noAgent.agent_id;
      await box.run("codex", noAgent);
      expect(box.state().codex.root.session).toBe(CODEX_SESSION);
      expect(record(box.state(), "s2")?.state).toBe("open");
      expect(record(box.state(), "r1")?.state).toBe("open");
      await box.run("codex", codex.subagentStop("agent-b", "tb"));
      expect(record(box.state(), "s2")).toBeUndefined();
      expect(await box.tokens()).toEqual(["mast:running", "mast:idle done"]);
    });
  }, SLOW);

  it("the confirm step waits out a lock holder that keeps the lock past 0.5s", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      const sleeper = await box.spawn("codex", codex.permission({ turn: "t1", input: cmd }), { via: "direct" });
      await box.until("candidate", (s) => record(s, "c1")?.state === "candidate");
      await box.request("lock", { path: join(box.hooksDir, `tab-${TAB}.lock`) });
      await waitForWchan(box, sleeper.pid, /lock_inode_wait|flock/, "the confirm step's lock wait", 6_000);
      await pause(1_200);
      await box.request("unlock");
      await box.finish(sleeper);
      expect(await box.tokens()).toEqual(["mast:needsInput cargo publish"]);
    });
  }, SLOW);

  it("a PermissionRequest re-arms a candidate whose sleeper is gone, but not a live one", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      const first = await box.spawn("codex", codex.permission({ turn: "t1", input: cmd }), { via: "direct" });
      await box.until("candidate", (s) => record(s, "c1")?.state === "candidate");
      await box.request("kill", { id: first.id });
      // 살아 있는 것처럼 보이는(최근에 무장된) candidate 에는 새 sleeper 를 만들지 않는다.
      const retry = await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      expect(retry.elapsed).toBeLessThan(1.5);
      const state = box.state();
      record(state, "c1").armed_at = 0;
      writeFileSync(box.statePath(), JSON.stringify(state));
      const rearmed = await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      expect(rearmed.elapsed).toBeGreaterThanOrEqual(2);
      expect(await box.tokens()).toEqual(["mast:needsInput cargo publish"]);
    });
  }, SLOW);

  it("a subagent prompt leaves root records alone", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      await box.run("codex", codex.prompt("ta", { agent: "agent-a" }));
      expect(record(box.state(), "c1")?.state).toBe("emitted");
      expect(await box.tokens()).toEqual(["mast:needsInput cargo publish"]);
    });
  }, SLOW);

  it("tells the same command in root and a subagent apart by scope", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      await box.run("codex", codex.pre({ turn: "ta", id: "s1", agent: "agent-a", input: cmd }));
      const sleeper = await box.spawn("codex", codex.permission({ turn: "t1", input: cmd }));
      await box.until("root candidate", (s) => record(s, "c1")?.state === "candidate");
      expect(record(box.state(), "s1")?.state).toBe("open");
      await box.run("codex", codex.post({ turn: "ta", id: "s1", agent: "agent-a", input: cmd }));
      await box.finish(sleeper);
      expect(await box.tokens()).toEqual(["mast:needsInput cargo publish"]);
    });
  }, SLOW);

  it("a late Permission from another turn raises nothing", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      await box.run("codex", codex.prompt("t2"));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      expect(await box.tokens()).toEqual(["mast:running"]);
    });
  }, SLOW);

  it("closes the previous turn's open records on the next turn's Pre", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      await box.run("codex", codex.pre({ turn: "t2", id: "c2", input: cmd }));
      const ids = box.state().codex.records.map((item: { id: string }) => item.id);
      expect(ids).toEqual(["c2"]);
    });
  }, SLOW);

  it("marks the newest record of a same-turn retry as the candidate", async ({ expect }) => {
    await withBox(async (box) => {
      const mcp = { tool: "mcp__docs__search", input: { query: "hooks" } };
      await box.run("codex", codex.pre({ turn: "t1", id: "m1", ...mcp }));
      await box.run("codex", codex.pre({ turn: "t1", id: "m2", ...mcp }));
      const sleeper = await box.spawn("codex", codex.permission({ turn: "t1", ...mcp }));
      await box.until("retry candidate", (s) => record(s, "m2")?.state === "candidate");
      expect(record(box.state(), "m1")?.state).toBe("open");
      await box.run("codex", codex.post({ turn: "t1", id: "m2", ...mcp }));
      await box.finish(sleeper);
      expect(await box.tokens()).toEqual(["mast:running"]);
    });
  }, SLOW);

  it("pairs a described Bash approval and a network approval with their exec", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: bash("curl https://example.com") }));
      await box.finish(
        await box.spawn(
          "codex",
          codex.permission({
            turn: "t1",
            input: { command: "curl https://example.com", description: "network-access example.com:443" },
          }),
        ),
      );
      await box.run("codex", codex.pre({ turn: "t1", id: "c2", input: bash("npm install") }));
      await box.finish(
        await box.spawn("codex", codex.permission({ turn: "t1", input: { command: "npm install", description: "deps" } })),
      );
      expect(await box.tokens()).toEqual(["mast:needsInput network access to example.com:443", "mast:needsInput npm install"]);
    });
  }, SLOW);

  it("pairs apply_patch across trailing newlines, CRLF and a heredoc wrapper", async ({ expect }) => {
    await withBox(async (box) => {
      const patch = "*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch";
      const raw = `<<'EOF'\r\n${patch.replaceAll("\n", "\r\n")}\r\nEOF\r\n\n`;
      await box.run("codex", codex.pre({ turn: "t1", id: "p1", tool: "apply_patch", input: { command: raw } }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", tool: "apply_patch", input: { command: patch } })));
      expect(await box.tokens()).toEqual(["mast:needsInput apply_patch"]);
    });
  }, SLOW);

  it("treats write_stdin and Execve approvals as gaps", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: bash("python3 -i") }));
      const stdin = await box.finish(
        await box.spawn("codex", codex.permission({ turn: "t1", tool: "write_stdin", input: { session_id: 3, chars: "x" } })),
      );
      expect(stdin.elapsed).toBeLessThan(1.5);
      expect(box.diag()).toContain("write_stdin approvals cannot be paired");
      // zsh-fork Execve 는 shlex_join 한 argv 를 command 로 싣는다(approvals.rs:196-200).
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: bash("python3 '-i'") })));
      expect(box.diag()).toContain("matched no pending tool call");
      expect(await box.tokens()).toEqual([]);
    });
  }, SLOW);

  it("disables needsInput when config.toml sets approvals_reviewer to auto_review", async ({ expect }) => {
    await withBox(async (box) => {
      mkdirSync(join(box.home, ".codex"), { recursive: true });
      writeFileSync(join(box.home, ".codex", "config.toml"), 'model = "gpt-5.5"\napprovals_reviewer = "auto_review"\n');
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      const quick = await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      expect(quick.elapsed).toBeLessThan(1.5);
      expect(box.diag()).toContain("approvals_reviewer is auto_review");

      writeFileSync(
        join(box.home, ".codex", "config.toml"),
        'model = "gpt-5.5"\n[profiles.review]\napprovals_reviewer = "auto_review"\n',
      );
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      expect(await box.tokens()).toEqual(["mast:needsInput cargo publish"]);
    });
  }, SLOW);

  it("only records request_user_input", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "q1", tool: "request_user_input", input: { questions: [] } }));
      expect(record(box.state(), "q1")?.state).toBe("open");
      expect(await box.tokens()).toEqual([]);
    });
  }, SLOW);

  it("pairs an MCP call with empty arguments", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.pre({ turn: "t1", id: "m1", tool: "mcp__linear__list_issues", input: {} }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", tool: "mcp__linear__list_issues", input: {} })));
      expect(await box.tokens()).toEqual(["mast:needsInput mcp__linear__list_issues"]);
    });
  }, SLOW);

  it("uses the first line of last_assistant_message as the Stop body, or the default for null", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.stop("t1", "Shipped it; tests pass.\nDetails follow"));
      await box.run("codex", codex.stop("t2", null));
      await box.run("codex", codex.stop("t3", "   \nsecond line"));
      expect(await box.tokens()).toEqual([
        "mast:idle Shipped it, tests pass.",
        "mast:idle codex turn complete",
        "mast:idle codex turn complete",
      ]);
    });
  }, SLOW);

  it("never raises needsInput when Codex needsInput is off", async ({ expect }) => {
    await withBox(async (box) => {
      box.touchMarker("codex-needs-input-off");
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: cmd }));
      const quick = await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: cmd })));
      expect(quick.elapsed).toBeLessThan(1.5);
      await box.run("codex", codex.post({ turn: "t1", id: "c1", input: cmd }));
      expect(await box.tokens()).toEqual(["mast:running"]);
    });
  }, SLOW);
});

linux.concurrent("agent hook dispatcher — accepted Codex false positives stay as documented", () => {
  it("an auto-approved command running past 2s shows needsInput until its Post", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: bash("cargo build") }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: bash("cargo build") })));
      await box.run("codex", codex.post({ turn: "t1", id: "c1", input: bash("cargo build") }));
      expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput cargo build", "mast:running"]);
    });
  }, SLOW);

  it("a denial inside 2s leaves needsInput until the turn's Stop", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: bash("rm -rf /tmp/x") }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: bash("rm -rf /tmp/x") })));
      await box.run("codex", codex.pre({ turn: "t1", id: "c2", input: bash("ls") }));
      await box.run("codex", codex.post({ turn: "t1", id: "c2", input: bash("ls") }));
      expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput rm -rf /tmp/x"]);
      await box.run("codex", codex.stop("t1", "gave up"));
      expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput rm -rf /tmp/x", "mast:idle gave up"]);
    });
  }, SLOW);

  it("a short-yield command polled by write_stdin shows needsInput until the poll sees it exit", async ({ expect }) => {
    await withBox(async (box) => {
      await box.run("codex", codex.prompt("t1"));
      await box.run("codex", codex.pre({ turn: "t1", id: "exec-1", input: bash("npm run dev") }));
      await box.finish(await box.spawn("codex", codex.permission({ turn: "t1", input: bash("npm run dev") })));
      expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput npm run dev"]);
      // write_stdin 은 Pre 를 내지 않고, 종료를 본 poll 이 원래 exec 의 call id 로 Post 를 낸다.
      await box.run("codex", codex.post({ turn: "t1", id: "exec-1", input: bash("npm run dev"), response: "exit 0" }));
      expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput npm run dev", "mast:running"]);
    });
  }, SLOW);
});

linux("agent hook dispatcher — sleeper emission races", () => {
  // sleeper 가 lock 을 쥔 채 막힌 tty 에 needsInput 을 쓰는 순간에 두 번째 훅이 lock 을 기다리게
  // 만든다. sleeper 의 쓰기 deadline(0.5s) 안에 barrier 를 못 세우면 부하 탓이므로 다시 시도한다.
  async function raceDuringEmission(ending: (box: HookBox) => Promise<Spawned>): Promise<HookBox> {
    for (let attempt = 1; ; attempt += 1) {
      const box = await HookBox.open();
      try {
        const command = bash("terraform apply");
        await box.run("codex", codex.prompt("t1"));
        await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: command }));
        const sleeper = await box.spawn("codex", codex.permission({ turn: "t1", input: command }), { via: "direct" });
        await box.until("candidate", (s) => record(s, "c1")?.state === "candidate");
        await box.request("jam");
        await waitForWchan(box, sleeper.pid, /wait_woken|n_tty_write|tty_write/, "the sleeper's tty write");
        const writeSeen = Date.now();
        const second = await ending(box);
        let reached = true;
        try {
          await waitForWchan(box, second.pid, /lock_inode_wait|flock/, "the state lock", 250);
        } catch {
          reached = false;
        }
        const sleeperStillWriting = /wait_woken|n_tty_write|tty_write/.test((await box.wchan(sleeper.pid)) ?? "");
        // 쓰기 deadline 0.5s 까지 여유를 남겨야 unjam 전에 sleeper 가 포기하지 않는다.
        const inTime = Date.now() - writeSeen < 300;
        await box.request("unjam");
        await box.finish(sleeper);
        await box.finish(second);
        if (reached && sleeperStillWriting && inTime) return box;
        if (attempt >= 3) throw new Error("could not hold the second hook on the lock during the sleeper's write");
      } catch (error) {
        box.dispose();
        throw error;
      }
      box.dispose();
    }
  }

  it(
    "a Post arriving while the sleeper writes needsInput loses nothing",
    async () => {
      const box = await raceDuringEmission((b) =>
        b.spawn("codex", codex.post({ turn: "t1", id: "c1", input: bash("terraform apply") }), { via: "direct" }),
      );
      try {
        expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput terraform apply", "mast:running"]);
        const state = box.state();
        expect(state.codex.records).toEqual([]);
        expect(state.emit).toMatchObject({ token: "mast:running", ok: true });
      } finally {
        box.dispose();
      }
    },
    60_000,
  );

  it(
    "re-sends a needsInput whose write failed on the next sibling event",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.prompt("t1"));
        await box.run("codex", codex.pre({ turn: "t1", id: "c1", input: bash("terraform apply") }));
        await box.run("codex", codex.pre({ turn: "t1", id: "c2", input: bash("ls") }));
        expect(await box.tokens()).toEqual(["mast:running"]);
        const sleeper = await box.spawn("codex", codex.permission({ turn: "t1", input: bash("terraform apply") }), {
          via: "direct",
        });
        await box.until("candidate", (s) => record(s, "c1")?.state === "candidate");
        await box.request("jam");
        await box.until(
          "a failed needsInput write",
          (s) => record(s, "c1")?.state === "emitted" && s.emit?.token === "mast:needsInput" && s.emit.ok === false,
          8_000,
        );
        await box.finish(sleeper);
        await box.request("unjam");
        expect(await box.tokens()).toEqual(["mast:running"]);
        await box.run("codex", codex.post({ turn: "t1", id: "c2", input: bash("ls") }));
        expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput terraform apply"]);
        expect(lastEmit(box)).toMatchObject({ token: "mast:needsInput", ok: true });
      });
    },
    60_000,
  );

  it(
    "an Interrupt arriving while the sleeper writes needsInput loses nothing",
    async () => {
      const box = await raceDuringEmission((b) => b.spawn("codex", codex.interrupt("t1"), { via: "direct" }));
      try {
        expect(await box.tokens()).toEqual(["mast:running", "mast:needsInput terraform apply", "mast:idle interrupted"]);
        const state = box.state();
        expect(state.codex.records).toEqual([]);
        expect(state.codex.root.ended).toEqual([{ turn: "t1", handled: true }]);
      } finally {
        box.dispose();
      }
    },
    60_000,
  );
});

linux("agent hook dispatcher — codex-notify", () => {
  it(
    "stays silent for a turn the hooks handled and for a late arrival after a new prompt",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.prompt("t1"));
        await box.run("codex", codex.stop("t1", "done"));
        await box.notify("confirmed", notifyPayload(CODEX_SESSION, "t1"));
        expect(await box.tokens()).toEqual(["mast:running", "mast:idle done"]);

        await box.run("codex", codex.prompt("t2"));
        await box.notify("unknown", notifyPayload(CODEX_SESSION, "t0"));
        expect(await box.tokens()).toEqual(["mast:running", "mast:idle done", "mast:running"]);
      });
    },
    SLOW,
  );

  it(
    "judges a new thread by ownership when the state belongs to an earlier session",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.prompt("t1"));
        await box.notify("rejected", notifyPayload("subagent-thread", "s1"));
        await box.notify("unknown", notifyPayload("maybe-subagent", "s2"));
        expect(await box.tokens()).toEqual(["mast:running"]);
        await box.notify("confirmed", notifyPayload("fresh-root-thread", "r1", "fresh answer"));
        expect(await box.tokens()).toEqual(["mast:running", "mast:idle fresh answer"]);
      });
    },
    SLOW,
  );

  it(
    "stays silent for the previous session's handled turn after the session changed",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.prompt("t1"));
        await box.run("codex", codex.stop("t1", "s1 done"));
        await box.run("codex", codex.prompt("u1", { session: "019b7a3e-0000-7000-8000-0000000000b2" }));
        await box.notify("confirmed", notifyPayload(CODEX_SESSION, "t1", "s1 done"));
        expect(await box.tokens()).toEqual(["mast:running", "mast:idle s1 done", "mast:running"]);
        // 훅이 없는 새 root thread 는 여전히 idle 이다.
        await box.notify("confirmed", notifyPayload("fresh-root-thread", "r1", "fresh answer"));
        expect(await box.tokens()).toEqual([
          "mast:running",
          "mast:idle s1 done",
          "mast:running",
          "mast:idle fresh answer",
        ]);
      });
    },
    SLOW,
  );

  it(
    "stays silent for the previous session's turn whose Stop could not write its idle",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.prompt("t1"));
        await box.request("jam");
        await box.finish(await box.spawn("codex", codex.stop("t1", "s1 done"), { via: "direct" }));
        await box.request("unjam");
        expect(box.state().codex.root.ended).toEqual([{ turn: "t1", handled: false }]);
        await box.run("codex", codex.prompt("u1", { session: "019b7a3e-0000-7000-8000-0000000000b2" }));
        await box.notify("confirmed", notifyPayload(CODEX_SESSION, "t1", "s1 done"));
        expect(await box.tokens()).toEqual(["mast:running", "mast:running"]);
      });
    },
    SLOW,
  );

  it(
    "emits nothing for a nested codex exec whose CODEX_THREAD_ID names the outer thread",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.prompt("t1"));
        await box.notify("confirmed", notifyPayload("inner-exec-thread", "i1"), { CODEX_THREAD_ID: CODEX_SESSION });
        expect(await box.tokens()).toEqual(["mast:running"]);
        await box.notify("confirmed", notifyPayload(CODEX_SESSION, "t1", "outer done"), { CODEX_THREAD_ID: CODEX_SESSION });
        expect(await box.tokens()).toEqual(["mast:running", "mast:idle outer done"]);
      });
    },
    SLOW,
  );

  it(
    "without the lock stays silent for rejected ownership and fails open to idle otherwise",
    async () => {
      await withBox(async (box) => {
        mkdirSync(box.hooksDir, { recursive: true });
        await box.request("lock", { path: join(box.hooksDir, `tab-${TAB}.lock`) });
        const rejected = await box.notify("rejected", notifyPayload("subagent-thread", "s1", "sub done"));
        expect(rejected.elapsed).toBeGreaterThanOrEqual(2.9);
        expect(await box.tokens()).toEqual([]);
        await box.notify("unknown", notifyPayload("maybe-root", "r1", "maybe done"));
        await box.request("unlock");
        expect(await box.tokens()).toEqual(["mast:idle maybe done"]);
      });
    },
    SLOW,
  );

  it(
    "keeps a pending subagent approval over an unconfirmed idle",
    async () => {
      await withBox(async (box) => {
        await box.run("codex", codex.prompt("t1"));
        await box.run("codex", codex.pre({ turn: "ta", id: "s1", agent: "agent-a", input: bash("make") }));
        await box.finish(await box.spawn("codex", codex.permission({ turn: "ta", agent: "agent-a", input: bash("make") })));
        await box.run("codex", codex.stop("t1", "root done"));
        await box.notify("unknown", notifyPayload("agent-a-thread", "ta"));
        expect(await box.tokens()).toEqual([
          "mast:running",
          "mast:needsInput make",
          "mast:needsInput make",
        ]);
      });
    },
    SLOW,
  );

  it(
    "fails open to idle for unparseable payloads and missing ids",
    async () => {
      await withBox(async (box) => {
        await box.notify("unknown", "{not json");
        await box.notify("confirmed", JSON.stringify({ "last-assistant-message": "no ids here" }));
        await box.notify("confirmed", "");
        expect(await box.tokens()).toEqual([
          "mast:idle codex turn complete",
          "mast:idle no ids here",
          "mast:idle codex turn complete",
        ]);
      });
    },
    SLOW,
  );

  it(
    "emits idle without state under the opt-out marker and nothing under CLAUDECODE",
    async () => {
      await withBox(async (box) => {
        await box.notify("unknown", notifyPayload(CODEX_SESSION, "t9"), { CLAUDECODE: "1" });
        expect(await box.tokens()).toEqual([]);
        box.touchMarker("no-codex-hooks");
        await box.run("codex", codex.prompt("t1"));
        await box.notify("rejected", notifyPayload(CODEX_SESSION, "t9", "opted out"));
        expect(await box.tokens()).toEqual(["mast:idle opted out"]);
        expect(box.state()).toBeUndefined();
      });
    },
    SLOW,
  );
});
