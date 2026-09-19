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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { assembleSetupScript, setupVersion } from "./setup-script";

const ROOT = mkdtempSync(join(tmpdir(), "mast-config-cli-test-"));
const HELPER = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/wsl/mast-config.py");
const PYTHON = "python3";

// Python은 테스트용 경로를 명시적으로 주입한 import harness에서만 호출한다. 실제 CLI
// 경로 해석(PowerShell/wslpath)은 이 파일이 건드리지 않으며 --help만 별도로 검증한다.
const HARNESS = String.raw`
import importlib.util
import json
import pathlib
import sys

helper, encoded_args, settings_path, operation = sys.argv[1:]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("mast_config_test", helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if operation == "help":
    print(module.HELP)
    raise SystemExit(0)
try:
    result = module.execute(json.loads(encoded_args), pathlib.Path(settings_path))
except Exception as exc:
    print("EXC:" + type(exc).__name__ + ":" + str(exc))
    raise SystemExit(0)
print("OK:" + repr(result))
`;

type Invocation = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function fixture(): string {
  return join(mkdtempSync(join(ROOT, "case-")), "settings.json");
}

function invoke(args: string[], path: string): Invocation {
  const result = spawnSync(
    PYTHON,
    ["-c", HARNESS, HELPER, JSON.stringify(args), path, "execute"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function help(): Invocation {
  const result = spawnSync(PYTHON, [HELPER, "--help"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function moduleHelp(): Invocation {
  const result = spawnSync(
    PYTHON,
    ["-c", HARNESS, HELPER, "[]", fixture(), "help"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeSettings(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function expectFailure(result: Invocation): void {
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("EXC:");
  expect(result.stdout).not.toContain("OK:");
}

function expectSuccess(result: Invocation): void {
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("OK:");
  expect(result.stdout).not.toContain("EXC:");
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe.skipIf(process.platform !== "linux")("mast config helper", () => {
  it("exposes help without resolving a Windows path", () => {
    const result = help();
    const exported = moduleHelp();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("mast config set remote");
    expect(result.stdout).toContain("reset <key>");
    expect(result.stdout).not.toMatch(/\x1b/);
    expect(exported.status).toBe(0);
    expect(exported.stdout).toContain("mast config set remote");
  });

  it("shows saved values, defaults, path, and help for no arguments", () => {
    const path = fixture();
    writeSettings(path, { future: { enabled: true }, fontSize: 15 });
    const result = invoke([], path);
    expectSuccess(result);
    expect(result.stdout).toContain("Saved overrides");
    expect(result.stdout).toContain("fontSize");
    expect(result.stdout).toContain("15");
    expect(result.stdout).toContain("future");
    expect(result.stdout).toContain(path);
    expect(result.stdout).toContain("Built-in defaults");
    expect(result.stdout).toContain("usage:");
    expect(result.stdout).toContain("not running state");
  });

  it("sets scalar values, accepts quoted argv strings, and preserves unknown fields", () => {
    const path = fixture();
    writeSettings(path, {
      future: { keep: [1, "two"] },
      fontSize: null,
      log: null,
      remote: { port: 7331, futurePortSetting: { keep: true } },
    });
    expectSuccess(invoke(["set", "fontFamily", "Consolas, 'Cascadia Mono', monospace"], path));
    expectSuccess(invoke(["set", "fontSize", "24"], path));
    expectSuccess(invoke(["set", "log", "true"], path));
    expectSuccess(invoke(["set", "highlightLanguages", '["python","rust"]'], path));
    const saved = readSettings(path);
    expect(saved.fontFamily).toBe("Consolas, 'Cascadia Mono', monospace");
    expect(saved.fontSize).toBe(24);
    expect(saved.log).toBe(true);
    expect(saved.highlightLanguages).toEqual(["python", "rust"]);
    expect(saved.future).toEqual({ keep: [1, "two"] });
    expect(saved.remote).toEqual({ port: 7331, futurePortSetting: { keep: true } });
  });

  it("uses explicit remote default, custom ports, remote.port, and false removal", () => {
    const path = fixture();
    writeSettings(path, {
      future: "keep",
      remote: { port: 9444, future: "preserve" },
    });
    expectSuccess(invoke(["set", "remote"], path));
    expect(readSettings(path).remote).toEqual({ port: 7331, future: "preserve" });
    const custom = invoke(["set", "remote", "true", "--port", "9555"], path);
    expectSuccess(custom);
    expect(custom.stdout).toContain("Plain HTTP");
    expect(readSettings(path).remote).toEqual({ port: 9555, future: "preserve" });
    expectSuccess(invoke(["set", "remote.port", "9666"], path));
    expect(readSettings(path).remote).toEqual({ port: 9666, future: "preserve" });
    expectSuccess(invoke(["set", "remote", "false"], path));
    expect(readSettings(path)).toEqual({ future: "keep" });
  });

  it("rejects false plus a port, unknown mutations, and reset remote.port", () => {
    const path = fixture();
    writeSettings(path, { remote: { port: 7331, future: true }, keep: 1 });
    const before = readFileSync(path);
    for (const args of [
      ["set", "remote", "false", "--port", "7331"],
      ["set", "future", "2"],
      ["reset", "future"],
      ["reset", "remote.port"],
    ]) {
      expectFailure(invoke(args, path));
      expect(readFileSync(path)).toEqual(before);
    }
    expect(existsSync(path + ".lock")).toBe(false);
  });

  it("rejects invalid original files without replacing them, including reset", () => {
    const invalid = [
      "[1,2,3]",
      '{"fontSize": 200}',
      '{"remote": {"future": true}}',
      '{"highlightLanguages": ["pyton"]}',
      '{"fontFamily": "   "}',
      '{"future": NaN}',
      '{"future": 1e999}',
      '{"remote": {"port": 7331, "port": 7444}}',
      '{"future": "\\ud800"}',
    ];
    for (const text of invalid) {
      const path = fixture();
      writeFileSync(path, text);
      const before = readFileSync(path);
      expectFailure(invoke(["get"], path));
      expectFailure(invoke(["reset", "fontSize"], path));
      expect(readFileSync(path)).toEqual(before);
      expect(existsSync(path + ".lock")).toBe(false);
    }
  });

  it("accepts nullable known fields and rejects invalid command values without creating a file", () => {
    const path = fixture();
    writeSettings(path, {
      fontFamily: null,
      fontSize: null,
      highlightLanguages: null,
      log: null,
      remote: null,
      future: "keep",
    });
    expectFailure(invoke(["set", "fontSize", "5"], path));
    expectFailure(invoke(["set", "log", "yes"], path));
    expectFailure(invoke(["set", "highlightLanguages", '["go"]'], path));
    expect(readSettings(path).future).toBe("keep");

    const pristine = fixture();
    for (const args of [
      ["set", "fontSize", "73"],
      ["set", "remote", "false", "--port", "1024"],
      ["set", "unknown", "value"],
      ["reset", "unknown"],
    ]) {
      expectFailure(invoke(args, pristine));
      expect(existsSync(pristine)).toBe(false);
      expect(existsSync(pristine + ".lock")).toBe(false);
    }
  });

  it("escapes terminal control bytes in get output and preserves the source", () => {
    const path = fixture();
    writeSettings(path, { future: "\u001b[31mred", fontSize: 13 });
    const result = invoke(["get"], path);
    expectSuccess(result);
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).toContain("\\u001b");
    expect(readSettings(path).future).toBe("\u001b[31mred");
  });

  it("fails immediately for a busy lock and releases its lock after a write failure", () => {
    const path = fixture();
    writeSettings(path, { fontSize: 13 });
    mkdirSync(path + ".lock");
    const before = readFileSync(path);
    expectFailure(invoke(["set", "fontSize", "14"], path));
    expect(readFileSync(path)).toEqual(before);
    expect(lstatSync(path + ".lock").isDirectory()).toBe(true);
    rmSync(path + ".lock", { recursive: true, force: true });

    writeFileSync(path, '{"fontSize": 200}');
    expectFailure(invoke(["reset", "fontSize"], path));
    expect(existsSync(path + ".lock")).toBe(false);
  });

  it("rejects symlink, directory, and oversized targets before reading or replacing", () => {
    const symlinkPath = fixture();
    const target = symlinkPath + ".target";
    writeFileSync(target, '{"fontSize": 13}\n');
    symlinkSync(target, symlinkPath);
    expectFailure(invoke(["set", "fontSize", "14"], symlinkPath));
    expect(readFileSync(target, "utf8")).toBe('{"fontSize": 13}\n');

    const directoryPath = fixture();
    mkdirSync(directoryPath);
    expectFailure(invoke(["set", "fontSize", "14"], directoryPath));

    const oversizedPath = fixture();
    writeFileSync(oversizedPath, "x".repeat(1024 * 1024 + 1));
    const before = readFileSync(oversizedPath);
    expectFailure(invoke(["reset", "fontSize"], oversizedPath));
    expect(readFileSync(oversizedPath).equals(before)).toBe(true);
  });

  it("preserves the original mode through atomic replacement", () => {
    const path = fixture();
    writeSettings(path, { fontSize: 13 });
    chmodSync(path, 0o640);
    expectSuccess(invoke(["set", "fontSize", "14"], path));
    expect(lstatSync(path).mode & 0o777).toBe(0o640);
  });

  it("resets overrides and accepts both port boundaries without enabling remote implicitly", () => {
    const path = fixture();
    expectSuccess(invoke([], path));
    expect(existsSync(path)).toBe(false);
    for (const port of ["1024", "65535"]) {
      expectSuccess(invoke(["set", "remote", "--port", port], path));
      expect(readSettings(path).remote).toEqual({ port: Number(port) });
    }
    expectSuccess(invoke(["set", "fontSize", "15"], path));
    expectSuccess(invoke(["reset", "fontSize"], path));
    expect(readSettings(path).fontSize).toBeUndefined();
    expectSuccess(invoke(["reset", "remote"], path));
    expect(readSettings(path)).toEqual({});
  });

  it("preserves the original and removes its temporary file when replacement fails", () => {
    const path = fixture();
    writeSettings(path, { fontSize: 13 });
    const before = readFileSync(path);
    const failingHarness = HARNESS.replace(
      "try:\n    result = module.execute",
      'def fail_replace(*args):\n    raise OSError("injected replace failure")\nmodule.os.replace = fail_replace\ntry:\n    result = module.execute',
    );
    const result = spawnSync(PYTHON, ["-c", failingHarness, HELPER, '["set","fontSize","14"]', path, "execute"], {
      encoding: "utf8", timeout: 5_000,
    });
    if (result.error) throw result.error;
    expectFailure(result);
    expect(result.stdout).toContain("injected replace failure");
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dirname(path))).toEqual(["settings.json"]);
  });

  it("installs the embedded helper and routes config argv without terminal control sequences", () => {
    const expanded = assembleSetupScript();
    expect(expanded).toContain(`.setup-v${setupVersion()}`);
    // 임베드 파일로 커진 스크립트는 인자 하나의 커널 한도(128 KiB)를 넘으므로 stdin 으로 넘긴다.
    expect(spawnSync("bash", ["-n"], { input: expanded, encoding: "utf8", timeout: 5_000 }).status).toBe(0);
    const install = expanded.slice(expanded.indexOf('cat > "$CLI.tmp"'), expanded.indexOf("# --- 3. mast-send.sh"));
    const home = dirname(fixture());
    const bin = join(home, ".mast", "bin");
    mkdirSync(bin, { recursive: true });
    const cli = join(bin, "mast");
    const helper = join(bin, "mast-config.py");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLI: cli, CONFIG: helper };
    delete env.BASH_ENV;
    const installed = spawnSync("bash", ["--noprofile", "--norc", "-s"], {
      input: "log() { :; }\n" + install, env, encoding: "utf8", timeout: 5_000,
    });
    expect(installed.status, installed.stderr).toBe(0);
    expect(readFileSync(helper, "utf8")).toBe(readFileSync(HELPER, "utf8"));
    const helpResult = spawnSync("bash", [cli, "config", "--help"], { env, encoding: "utf8", timeout: 5_000 });
    expect(helpResult.status, helpResult.stderr).toBe(0);
    expect(helpResult.stdout).toContain("mast config set remote");
    expect(helpResult.stdout).not.toContain("\x1b");
    writeFileSync(helper, "import json, sys\nprint(json.dumps(sys.argv[1:]))\n");
    const args = ["set", "fontFamily", "Consolas, 'Cascadia Mono'; $(not-a-command)"];
    const routed = spawnSync("bash", [cli, "config", ...args], { env, encoding: "utf8", timeout: 5_000 });
    expect(routed.status, routed.stderr).toBe(0);
    expect(JSON.parse(routed.stdout)).toEqual(args);
  });
});
