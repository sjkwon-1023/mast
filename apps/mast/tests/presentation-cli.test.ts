// @vitest-environment node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assembleSetupScript } from "./setup-script";

const WSL_SCRIPTS = fileURLToPath(new URL("../../../scripts/wsl", import.meta.url));
const HELPER = join(WSL_SCRIPTS, "mast-presentation.py");
const ROOT = mkdtempSync(join(tmpdir(), "mast-presentation-cli-"));
const linuxSuite = process.platform === "linux" ? describe : describe.skip;

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// 가짜 Mast 는 전송 함수 자리(_write_terminal)에서 응답 파일을 쓴다. REPLY 가 None 이면 응답하지 않는다.
const PRELUDE = String.raw`
import base64, contextlib, importlib.util, io, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location("mast_presentation", sys.argv[1])
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
b = p.browser
REPLY = None
sent = []
paths = []
def answer(sequence):
    sent.append(sequence)
    body = sequence.rstrip(b"\x07").split(b";")
    reply_path = pathlib.Path(base64.b64decode(body[3]).decode())
    paths.append(str(reply_path))
    if REPLY is None:
        return
    partial = reply_path.with_name(reply_path.name + ".partial")
    partial.write_bytes(REPLY.encode())
    os.replace(partial, reply_path)
b._write_terminal = answer
def run_main(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            status = p.main(argv)
        except SystemExit as exit_:
            status = exit_.code
    return {
        "status": status,
        "stdout": out.getvalue(),
        "stderr": err.getvalue(),
        "sent": len(sent),
        "replyDirRemoved": all(not pathlib.Path(path).parent.exists() for path in paths),
    }
`;

// 실제 apps/mast 가 쓰는 pty 를 열고 CLI 를 제어 터미널 없이 띄운다. 그러면 helper 의 tty 해석은 /dev/tty 가
// 실패한 뒤 fd 0/1/2 가 가리키는 /dev/pts 로 내려간다. 셸이 Mast 탭 안에 있어도 그 탭으로 질의가 새지 않는다.
const PTY_DRIVER = String.raw`
import base64, json, os, pathlib, pty, select, subprocess, sys, time
spec = json.loads(sys.argv[1])
master, slave = pty.openpty()
proc = subprocess.Popen(spec["argv"], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        env=spec["env"], cwd=spec["cwd"], start_new_session=True)
os.close(slave)
queries, sends, pending = [], [], b""
def handle(chunk):
    fields = chunk[chunk.index(b"\x1b]") + 2:].split(b";")
    if fields[:2] == [b"777", b"mast-send"]:
        sends.append([fields[2].decode(), base64.b64decode(fields[3]).decode()])
    elif fields[:2] == [b"777", b"mast-query"]:
        kind, _, payload = fields[2].partition(b":")
        queries.append({"kind": kind.decode(), "request": json.loads(base64.b64decode(payload)) if payload else None})
        reply = spec["replies"].get(kind.decode())
        if reply is None:
            return
        path = pathlib.Path(base64.b64decode(fields[3]).decode())
        partial = path.with_name(path.name + ".partial")
        partial.write_text(reply)
        os.replace(partial, path)
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    if not select.select([master], [], [], 0.05)[0]:
        continue
    try:
        data = os.read(master, 65536)
    except OSError:
        break
    if not data:
        break
    pending += data
    while b"\x07" in pending:
        chunk, pending = pending.split(b"\x07", 1)
        if b"\x1b]" in chunk:
            handle(chunk)
else:
    proc.kill()
stdout, stderr = proc.communicate(timeout=10)
print(json.dumps({"status": proc.returncode, "stdout": stdout.decode(), "stderr": stderr.decode(), "queries": queries, "sends": sends}))
`;

const LAYOUT_RESULT = { workspace: 1, revision: 3, self: 7, focused: 7, viewerPane: null, tree: { type: "leaf", pane: 7 }, panes: [] };

type Outcome = { status: number; stdout: string; stderr: string; sent: number; replyDirRemoved: boolean };
type PtyOutcome = { status: number | null; stdout: string; stderr: string; queries: { kind: string; request: unknown }[]; sends: [string, string][] };

function python(body: string, env: Record<string, string> = {}) {
  return spawnSync("python3", ["-c", `${PRELUDE}\n${body}`, HELPER], {
    encoding: "utf8",
    timeout: 30_000,
    // MAST 를 상속하지 않는다. 개발 셸이 Mast 탭 안에 있어도 실제 앱으로 질의가 나가지 않게 한다.
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

// 본문 마지막 줄이 run_main 의 JSON 이어야 한다.
function inProcess<T = Outcome>(body: string, env: Record<string, string> = {}): T {
  const result = python(body, env);
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as T;
}

function assertions(body: string, env: Record<string, string> = {}) {
  const result = python(body, env);
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
}

function reply(text: string): string {
  return `REPLY = ${JSON.stringify(text)}\n`;
}

// 조립된 bash CLI 본문만 꺼낸다. provision-setup.test.ts 의 cliHeredoc 과 같은 추출 방식이다.
function assembledCli(): string {
  const script = assembleSetupScript();
  const opener = "<<'MAST_CLI_EOF'\n";
  const begin = script.indexOf(opener) + opener.length;
  const end = script.indexOf("\nMAST_CLI_EOF\n", begin);
  return script.slice(begin, end + 1);
}

// 설치 결과와 같은 배치: ~/.mast/bin 에 조립된 mast 와 그것이 부르는 helper 들을 둔다.
function installedHome(name: string): { home: string; cli: string } {
  const home = mkdtempSync(join(ROOT, `${name}-`));
  const bin = join(home, ".mast", "bin");
  mkdirSync(bin, { recursive: true });
  for (const file of ["mast-presentation.py", "mast-browser.py", "mast-agent-hook.py"]) {
    copyFileSync(join(WSL_SCRIPTS, file), join(bin, file));
  }
  const cli = join(bin, "mast");
  writeFileSync(cli, assembledCli(), { mode: 0o755 });
  return { home, cli };
}

function viaPty(argv: string[], home: string, options: { env?: Record<string, string>; replies?: Record<string, string> } = {}): PtyOutcome {
  const spec = {
    argv,
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, ...options.env },
    replies: options.replies ?? {},
  };
  const result = spawnSync("python3", ["-c", PTY_DRIVER, JSON.stringify(spec)], { encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("presentation CLI parsing and request shape", () => {
  it("parses the three commands, both placements, -- and dash-prefixed names", () => {
    assertions(`
import os
def req(argv): return p.make_request(p.parse_args(argv))
assert req(["layout"]) == {"action": "layout"}
assert req(["open", "--pane", "3", "/a/b"]) == {"action": "open", "path": "/a/b", "placement": {"pane": 3}}
assert req(["open", "--split", "3", "right", "/a/b"])["placement"] == {"split": {"pane": 3, "direction": "right"}}
assert req(["open", "--split", "3", "down", "/a/b"])["placement"] == {"split": {"pane": 3, "direction": "down"}}
assert req(["open", "--", "-file.md"])["path"] == os.path.realpath("-file.md")
assert req(["open", "--pane", "9007199254740991", "/a"])["placement"] == {"pane": 9007199254740991}
assert req(["diff", "--split", "4", "down"]) == {"action": "diff", "path": os.getcwd(), "placement": {"split": {"pane": 4, "direction": "down"}}}
assert req(["diff"]) == {"action": "diff", "path": os.getcwd()}
assert req(["diff", "--", "-x"])["path"] == os.path.realpath("-x")
`);
  });

  it("rejects malformed invocations with exit 2 before anything is sent", () => {
    assertions(`
import io
cases = [
    ["open", "--pane", "3", "--split", "3", "right", "/x"],
    ["open", "--pane", "0", "/x"],
    ["open", "--pane", "-1", "/x"],
    ["open", "--pane", "x", "/x"],
    ["open", "--pane", "#3", "/x"],
    ["open", "--pane", "9007199254740992", "/x"],
    ["open", "--split", "3", "up", "/x"],
    ["diff", "--split", "0", "right"],
    ["open", "/x", "extra"],
    ["open"],
    ["layout", "extra"],
    ["open", ""],
    ["diff", ""],
]
for argv in cases:
    before = len(sent)
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            p.main(argv)
        except SystemExit as exit_:
            assert exit_.code == 2, (argv, exit_.code)
        else:
            raise AssertionError(("accepted", argv))
    assert len(sent) == before, argv
`, { MAST: "1" });
  });

  it("keeps shell syntax and non-ASCII path text literal, normalizes .. against the caller cwd, and sends that path", () => {
    assertions(`
import os
name = 'a b/한글 $HOME \`id\`; x'
request = p.make_request(p.parse_args(["open", name]))
assert request["path"] == os.path.realpath(name)
assert "$HOME" in request["path"] and "\`id\`" in request["path"] and "한글" in request["path"]
normalized = p.make_request(p.parse_args(["open", "../x/./y"]))["path"]
assert normalized == os.path.realpath("../x/./y") and os.path.isabs(normalized)
assert ".." not in normalized.split("/")
`);
  });

  it("puts the normalized path on the wire as the open payload", () => {
    const outcome = inProcess(`
${reply(JSON.stringify({ result: LAYOUT_RESULT }))}
import os
name = 'a b/한글 $HOME \`id\`; x'
out = run_main(["open", name])
payload = json.loads(base64.b64decode(sent[-1].rstrip(b"\\x07").split(b";")[2].split(b":", 1)[1]))
assert sent[-1].split(b";")[2].startswith(b"presentation:")
assert payload == {"action": "open", "path": os.path.realpath(name)}, payload
print(json.dumps(out))
`, { MAST: "1" });
    expect(outcome.status).toBe(0);
  });

  it("sends the diff cwd when the path is omitted", () => {
    const outcome = inProcess(`
${reply(JSON.stringify({ result: LAYOUT_RESULT }))}
import os
out = run_main(["diff", "--split", "4", "down"])
payload = json.loads(base64.b64decode(sent[-1].rstrip(b"\\x07").split(b";")[2].split(b":", 1)[1]))
assert payload == {"action": "diff", "path": os.getcwd(), "placement": {"split": {"pane": 4, "direction": "down"}}}, payload
print(json.dumps(out))
`, { MAST: "1" });
    expect(outcome).toMatchObject({ status: 0, sent: 1, replyDirRemoved: true });
  });
});

describe("presentation CLI results and failures", () => {
  it("prints one result line on success and deletes the reply directory", () => {
    const outcome = inProcess(`
${reply(JSON.stringify({ result: LAYOUT_RESULT }))}
print(json.dumps(run_main(["layout"])))
`, { MAST: "1" });
    expect(outcome).toMatchObject({ status: 0, stderr: "", sent: 1, replyDirRemoved: true });
    expect(JSON.parse(outcome.stdout)).toEqual(LAYOUT_RESULT);
    expect(outcome.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("passes the server error envelope through unchanged with exit 1 and no retry", () => {
    const outcome = inProcess(`
${reply(JSON.stringify({ error: { code: "not_found", message: "no such file" } }))}
print(json.dumps(run_main(["open", "/missing"])))
`, { MAST: "1" });
    expect(outcome).toMatchObject({ status: 1, stdout: "", sent: 1, replyDirRemoved: true });
    expect(outcome.stderr).toBe('{"error": {"code": "not_found", "message": "no such file"}}\n');
  });

  it("times out with exit 1, names the three causes, and sends exactly once", () => {
    const outcome = inProcess(`
ticks = iter([0.0, 0.0] + [100.0] * 5)
b.time.monotonic = lambda: next(ticks)
print(json.dumps(run_main(["layout"])))
`, { MAST: "1" });
    expect(outcome).toMatchObject({ status: 1, stdout: "", sent: 1, replyDirRemoved: true });
    const error = JSON.parse(outcome.stderr).error;
    expect(error.code).toBe("timeout");
    for (const cause of ["not inside mast", "the app is an older version", "too many requests in flight"]) {
      expect(error.message).toContain(cause);
    }
    expect(error.message).toContain("mast layout");
  });

  it("accepts a reply exactly at 1 MiB and rejects one byte more", () => {
    // 1 MiB 본문을 -c 인자로 넘기면 Linux 의 인자 길이 한도를 넘으므로 Python 쪽에서 만든다.
    const accepted = inProcess(`
REPLY = '{"result":"' + "x" * (1024 * 1024 - len('{"result":""}')) + '"}'
assert len(REPLY.encode()) == 1024 * 1024
result = run_main(["layout"])
print(json.dumps({"status": result["status"], "stderr": result["stderr"], "sent": result["sent"], "replyDirRemoved": result["replyDirRemoved"]}))
`, { MAST: "1" });
    expect(accepted).toMatchObject({ status: 0, stderr: "", sent: 1, replyDirRemoved: true });

    const rejected = inProcess(`
REPLY = '{"result":"' + "x" * (1024 * 1024 - len('{"result":""}') + 1) + '"}'
assert len(REPLY.encode()) == 1024 * 1024 + 1
print(json.dumps(run_main(["layout"])))
`, { MAST: "1" });
    expect(rejected).toMatchObject({ status: 1, stdout: "", replyDirRemoved: true });
    expect(JSON.parse(rejected.stderr).error).toEqual({ code: "too_large", message: "presentation reply exceeds 1 MiB" });
  });

  it("reports a reply without result or error, or one that is not JSON, as io_error", () => {
    const outcome = inProcess<{ statuses: number[]; errors: { code: string; message: string }[] }>(`
results = []
for reply in ['{"other": 1}', '[1]', '5', 'not json']:
    REPLY = reply
    results.append(run_main(["layout"]))
print(json.dumps({"statuses": [r["status"] for r in results], "errors": [json.loads(r["stderr"])["error"] for r in results]}))
`, { MAST: "1" });
    expect(outcome.statuses).toEqual([1, 1, 1, 1]);
    expect(outcome.errors.map((error) => error.code)).toEqual(["io_error", "io_error", "io_error", "io_error"]);
    expect(outcome.errors[0].message).toBe("Mast returned a reply without result or error");
  });

  it("fails without MAST as io_error and never reaches the terminal", () => {
    const result = spawnSync("python3", [HELPER, "layout"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "io_error", message: "run inside a Mast terminal" } });
  });
});

linuxSuite("presentation CLI through a pseudo-terminal without a controlling tty", () => {
  it("reaches the app through the tty fallback and returns its result", () => {
    const { home } = installedHome("fallback");
    const outcome = viaPty(["python3", join(home, ".mast", "bin", "mast-presentation.py"), "layout"], home, {
      env: { MAST: "1", MAST_TAB: "7" },
      replies: { presentation: JSON.stringify({ result: LAYOUT_RESULT }) },
    });

    expect(outcome.status).toBe(0);
    expect(outcome.stderr).toBe("");
    expect(JSON.parse(outcome.stdout)).toEqual(LAYOUT_RESULT);
    expect(outcome.queries).toEqual([{ kind: "presentation", request: { action: "layout" } }]);
  });

  it("the assembled mast CLI routes layout, open and diff to the installed helper", () => {
    const { home, cli } = installedHome("assembled");
    const env = { MAST: "1", MAST_TAB: "7" };
    const replies = { presentation: JSON.stringify({ result: LAYOUT_RESULT }) };

    const layout = viaPty(["bash", cli, "layout"], home, { env, replies });
    expect(layout.status).toBe(0);
    expect(JSON.parse(layout.stdout)).toEqual(LAYOUT_RESULT);

    const open = viaPty(["bash", cli, "open", "--split", "3", "down", "--", "-notes.md"], home, { env, replies });
    expect(open.status).toBe(0);
    expect(open.queries[0]).toEqual({
      kind: "presentation",
      request: { action: "open", path: join(home, "-notes.md"), placement: { split: { pane: 3, direction: "down" } } },
    });

    const diff = viaPty(["bash", cli, "diff"], home, { env, replies });
    expect(diff.status).toBe(0);
    expect(diff.queries[0].request).toEqual({ action: "diff", path: home });
  });

  it("the assembled mast CLI rejects a missing path with exit 2 and sends nothing", () => {
    const { home, cli } = installedHome("usage");
    const outcome = viaPty(["bash", cli, "open"], home, { env: { MAST: "1", MAST_TAB: "7" } });

    expect(outcome.status).toBe(2);
    expect(outcome.stderr).toContain("usage: mast open [--pane ID | --split ID right|down] [--] <path>");
    expect(outcome.queries).toEqual([]);
  });

  it("keeps the ls and send contracts in the assembled CLI", () => {
    const { home, cli } = installedHome("regression");
    const env = { MAST: "1", MAST_TAB: "7" };
    const tabs = JSON.stringify({ self_tab: 7, tabs: [{ tab: 42, title: "shell", workspaceName: "work", status: "idle" }] });

    const ls = viaPty(["bash", cli, "ls"], home, { env, replies: { "list-tabs": tabs } });
    expect(ls.status).toBe(0);
    expect(ls.queries.map((query) => query.kind)).toEqual(["list-tabs"]);
    expect(ls.stdout).toContain("#42");
    expect(ls.stdout).toContain("shell");

    const send = viaPty(["bash", cli, "send", "#42", "hi"], home, { env });
    expect(send.status).toBe(0);
    expect(send.sends).toEqual([
      ["#42", "hi"],
      ["#42", "\r"],
    ]);
  });
});

describe("presentation CLI installed help and id", () => {
  it.skipIf(process.platform === "win32")("lists the presentation commands and says how mast open differs from mast-open", () => {
    const { home, cli } = installedHome("help");
    const help = spawnSync("bash", [cli, "--help"], { encoding: "utf8", env: { HOME: home, PATH: process.env.PATH ?? "" }, timeout: 10_000 });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("\n  mast layout");
    expect(help.stdout).toContain("\n  mast open [--pane ID | --split ID right|down] [--] <path>\n");
    expect(help.stdout).toContain("show a file in a Mast viewer pane (mast-open opens Windows apps instead)");
    expect(help.stdout).toContain("\n  mast ls ");
    expect(help.stdout).toContain("\n  mast id ");
  });

  it.skipIf(process.platform === "win32")("prints MAST_TAB from the assembled id command", () => {
    const { home, cli } = installedHome("id");
    const id = spawnSync("bash", [cli, "id"], { encoding: "utf8", env: { HOME: home, PATH: process.env.PATH ?? "", MAST_TAB: "7" }, timeout: 10_000 });

    expect(id.status).toBe(0);
    expect(id.stdout).toBe("7\n");
  });
});
