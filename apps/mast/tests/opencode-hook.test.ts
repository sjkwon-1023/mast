// @vitest-environment node

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const project = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const pluginPath = join(project, "scripts/wsl/mast-opencode-plugin.js");
const provision = readFileSync(join(project, "apps/mast/src-tauri/src/provision.rs"), "utf8");
const host = readFileSync(join(project, "apps/mast/src-tauri/src/host.rs"), "utf8");
const originalHome = process.env.HOME;
const setup = provision.split('const SETUP_SCRIPT: &str = r###"')[1]?.split('"###;')[0]
  ?.replaceAll("@SETUP_VERSION@", "14")
  .replaceAll("@CONFIG_HELPER@", "")
  .replaceAll("@OPENCODE_PLUGIN@", () => readFileSync(pluginPath, "utf8").trimEnd());
if (!setup) throw new Error("SETUP_SCRIPT missing");

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mast-opencode-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.MAST;
  delete process.env.MAST_TAB;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function runSetup(root: string, source = setup) {
  const home = join(root, "home");
  mkdirSync(join(home, ".mast", "bin"), { recursive: true });
  const binary = join(home, ".opencode", "bin", "opencode");
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o700);
  const start = source.indexOf("# OpenCode 설치기의 PATH 줄이");
  if (start < 0) throw new Error("OpenCode setup block missing");
  const env = { ...process.env, HOME: home, MAST_HOME: join(home, ".mast"), LOG: join(home, ".mast", "setup.log"), MARKER: join(home, ".mast", ".setup-v14") };
  const result = spawnSync("bash", ["--noprofile", "--norc", "-s"], {
    input: `set -u\nlog() { printf '%s\\n' \"$*\" >> \"$LOG\"; }\n${source.slice(start)}`, env, encoding: "utf8", timeout: 5000,
  });
  if (result.error) throw result.error;
  return { ...result, home };
}

function event(type: string, sessionID: string, extra = {}) {
  return { event: { type, properties: { sessionID, ...extra } } };
}

function hostHistory(home: string, command: string): string {
  const resume = join(home, ".mast/resume/tab-41");
  mkdirSync(dirname(resume), { recursive: true });
  writeFileSync(resume, `${command}\n123\n`);
  rmSync(join(home, ".mast/history/tab-41"), { force: true });
  const match = host.split("Some(tab) => format!(")[1]
    ?.match(/^\s*"((?:\\[\s\S]|[^"\\])*)"\s*\n\s*\),/);
  if (!match) throw new Error("host bash wrapper missing");
  let script = JSON.parse(`"${match[1].replace(/\\\r?\n[ \t]*/g, "")}"`) as string;
  for (const [key, value] of Object.entries({
    "{STARTED}": ":", "{THEME_SYNC}": ":", "{cd_clause}": "", "{PATH_PREFIX}": "",
    "{OSC7}": "", "{tab}": "41",
  })) script = script.replaceAll(key, value);
  script = script.replace("exec bash -l", "exec bash --noprofile --norc -c 'history -r; history 1'");
  const result = spawnSync("bash", ["-c", script], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function fakeShell(calls: Array<{ text: string; args: unknown[]; quiet: boolean; nothrow: boolean }>) {
  return (strings: TemplateStringsArray, ...args: unknown[]) => {
    const call = { text: strings.join("<>"), args, quiet: false, nothrow: false };
    calls.push(call);
    const promise = Promise.resolve({ exitCode: 0 });
    return {
      quiet() { call.quiet = true; return this; },
      nothrow() { call.nothrow = true; return this; },
      then: promise.then.bind(promise),
    };
  };
}

async function createHook(home: string, sessions: Record<string, { parentID?: string }>) {
  process.env.HOME = home;
  process.env.MAST = "1";
  process.env.MAST_TAB = "41";
  const calls: Array<{ text: string; args: unknown[]; quiet: boolean; nothrow: boolean }> = [];
  const module = await import(`${pathToFileURL(pluginPath).href}?test=${Math.random()}`);
  const hook = await module.Mast({
    directory: "/project",
    client: { session: { get: async ({ path }: { path: { id: string } }) => {
      const info = sessions[path.id];
      return info ? { data: { id: path.id, ...info } } : { error: new Error("missing") };
    } } },
    $: fakeShell(calls),
  });
  const flush = () => new Promise((done) => setTimeout(done, 15));
  return { hook, calls, flush };
}

describe("OpenCode plugin and setup", () => {
  it("installs once from the curl path and preserves user edits", () => {
    const root = fixture();
    expect(spawnSync("bash", ["-n", "-c", setup]).status).toBe(0);
    const first = runSetup(root);
    expect(first.status, first.stderr).toBe(0);
    const target = join(first.home, ".config/opencode/plugins/mast.js");
    expect(readFileSync(target, "utf8")).toBe(readFileSync(pluginPath, "utf8"));
    expect(existsSync(join(first.home, ".mast/.setup-v14"))).toBe(true);
    writeFileSync(target, "// user version\n");
    const second = runSetup(root);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("// user version\n");
  });

  it("leaves an existing plugin without an ownership record untouched", () => {
    const root = fixture();
    const target = join(root, "home/.config/opencode/plugins/mast.js");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "export const User = 1;\n");
    const result = runSetup(root);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("export const User = 1;\n");
    expect(readFileSync(join(result.home, ".mast/setup.log"), "utf8")).toContain("left untouched");
  });

  it("upgrades matching mast-owned bytes and respects XDG_CONFIG_HOME", () => {
    const root = fixture();
    const xdg = join(root, "custom config");
    const prior = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const first = runSetup(root);
      expect(first.status, first.stderr).toBe(0);
      const target = join(xdg, "opencode/plugins/mast.js");
      const upgraded = setup.replace("opencode idle", "opencode complete");
      const second = runSetup(root, upgraded);
      expect(second.status, second.stderr).toBe(0);
      expect(readFileSync(target, "utf8")).toContain("opencode complete");
      writeFileSync(target, "// user's edited plugin\n");
      const third = runSetup(root);
      expect(third.status, third.stderr).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("// user's edited plugin\n");
    } finally {
      if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prior;
    }
  });

  it("leaves the setup marker absent when plugin installation fails", () => {
    const root = fixture();
    const blocked = join(root, "not a directory");
    writeFileSync(blocked, "occupied");
    const prior = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = blocked;
    try {
      const result = runSetup(root);
      expect(result.status).toBe(1);
      expect(existsSync(join(result.home, ".mast/.setup-v14"))).toBe(false);
      expect(result.stderr).toContain("OpenCode plugin installation failed");
    } finally {
      if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prior;
    }
  });

  it("records a root before idle and ignores child and unknown sessions", async () => {
    const root = fixture();
    const home = join(root, "home");
    const { hook, calls } = await createHook(home, {
      ses_root: {}, ses_child: { parentID: "ses_root" },
    });
    hook.event(event("session.status", "ses_root", { status: { type: "busy" } }));
    const hint = join(home, ".mast/resume/tab-41");
    await vi.waitFor(() => expect(existsSync(hint)).toBe(true));
    expect(readFileSync(hint, "utf8")).toMatch(/^opencode --session ses_root\n\d+\n$/);
    writeFileSync(hint, "claude --resume another-root\n123\n");
    hook.event(event("session.status", "ses_root", { status: { type: "busy" } }));
    hook.event(event("session.idle", "ses_child"));
    hook.event(event("permission.asked", "ses_child", { id: "req1" }));
    hook.event(event("permission.replied", "ses_child", { requestID: "req1" }));
    hook.event(event("session.idle", "ses_root"));
    hook.event(event("session.status", "unknown", { status: { type: "busy" } }));
    await vi.waitFor(() => expect(calls.length).toBe(4));
    expect(calls.map((call) => call.args[1])).toEqual([
      "mast:running", "mast:needsInput", "mast:running", "mast:idle",
    ]);
    expect(calls.every((call) => call.quiet && call.nothrow && call.text.includes("/dev/null"))).toBe(true);
    expect(readFileSync(hint, "utf8")).toMatch(/^opencode --session ses_root\n/);
  });

  it("writes a new root and the host accepts only its exact resume command", async () => {
    const root = fixture();
    const home = join(root, "home");
    const { hook } = await createHook(home, {});
    hook.event(event("session.created", "ses_new", { info: { id: "ses_new" } }));
    const hint = join(home, ".mast/resume/tab-41");
    await vi.waitFor(() => expect(existsSync(hint)).toBe(true));
    expect(readFileSync(hint, "utf8")).toMatch(/^opencode --session ses_new\n/);
    expect(hostHistory(home, "opencode --session ses_new")).toMatch(/\bopencode --session ses_new\s*$/);
    expect(hostHistory(home, "opencode --session ses_new;echo-pwned")).not.toContain("echo-pwned");
    expect(hostHistory(home, "opencode --session ")).not.toContain("opencode --session");
  });

  it("does not write an invalid session id or tab id", async () => {
    const root = fixture();
    const home = join(root, "home");
    const { hook, flush } = await createHook(home, {});
    hook.event(event("session.created", "bad/id", { info: { id: "bad/id" } }));
    await flush();
    expect(existsSync(join(home, ".mast/resume/tab-41"))).toBe(false);
    process.env.MAST_TAB = "41;bad";
    const module = await import(`${pathToFileURL(pluginPath).href}?invalid=${Math.random()}`);
    const disabled = await module.Mast({ client: {}, directory: "/project", $: fakeShell([]) });
    expect(disabled).toEqual({});
  });

  it("still notifies when the resume directory cannot be created", async () => {
    const root = fixture();
    const home = join(root, "home");
    mkdirSync(join(home, ".mast"), { recursive: true });
    writeFileSync(join(home, ".mast/resume"), "occupied");
    const { hook, calls } = await createHook(home, { ses_root: {} });
    hook.event(event("permission.asked", "ses_root", { id: "req1" }));
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls.map((call) => call.args[1])).toEqual(["mast:needsInput"]);
    expect(readFileSync(join(home, ".mast/resume"), "utf8")).toBe("occupied");
  });

  it("still reports input requests when the session lookup rejects", async () => {
    const root = fixture();
    process.env.HOME = join(root, "home");
    process.env.MAST = "1";
    process.env.MAST_TAB = "41";
    const calls: Array<{ text: string; args: unknown[]; quiet: boolean; nothrow: boolean }> = [];
    const module = await import(`${pathToFileURL(pluginPath).href}?lookup=${Math.random()}`);
    const hook = await module.Mast({
      directory: "/project",
      client: { session: { get: async () => { throw new Error("offline"); } } },
      $: fakeShell(calls),
    });
    hook.event(event("permission.asked", "ses_unknown", { id: "req1" }));
    hook.event(event("question.asked", "ses_unknown", { id: "req2" }));
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls.map((call) => call.args[1])).toEqual(["mast:needsInput"]);
  });
});
