// @vitest-environment node
//
// ~/.mast/bin/codex 래퍼가 공유 daemon 을 피하도록 `--no-daemon` 을 넣는 자리를 실제 bash 로 확인한다.
// 가짜 codex 는 받은 인자를 그대로 출력한다.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const project = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const root = mkdtempSync(join(tmpdir(), "mast-codex-wrapper-"));
const home = join(root, "home");
const bin = join(home, ".mast", "bin");
const realDir = join(root, "real");
mkdirSync(bin, { recursive: true });
mkdirSync(realDir);
copyFileSync(join(project, "scripts/wsl/mast-codex.sh"), join(bin, "codex"));
chmodSync(join(bin, "codex"), 0o755);
writeFileSync(join(realDir, "codex"), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
chmodSync(join(realDir, "codex"), 0o755);

afterAll(() => rmSync(root, { recursive: true, force: true }));

// 현장 PATH 처럼 ~/.mast/bin 이 앞에 두 번(끝 슬래시 포함) 들어 있어도 자기 자신을 실행하지 않아야 한다.
function codex(args: string[], path = `${bin}:${bin}/:${realDir}:/usr/bin:/bin`) {
  const result = spawnSync(join(bin, "codex"), args, { env: { HOME: home, PATH: path }, encoding: "utf8", timeout: 5000 });
  if (result.error) throw result.error;
  return { status: result.status, argv: result.stdout.split("\n").slice(0, -1), stderr: result.stderr };
}

describe("codex wrapper", () => {
  it.each([
    [[], ["--no-daemon"]],
    [["fix the bug"], ["--no-daemon", "fix the bug"]],
    [["--model", "gpt", "--cd", "/w", "review this"], ["--no-daemon", "--model", "gpt", "--cd", "/w", "review this"]],
    [["--version"], ["--no-daemon", "--version"]],
  ])("대화형 실행 %j 은 맨 앞에 --no-daemon 을 붙인다", (args, argv) => {
    expect(codex(args)).toEqual({ status: 0, argv, stderr: "" });
  });

  it.each([
    [["resume", "019a-id"], ["resume", "--no-daemon", "019a-id"]],
    [["-m", "gpt", "resume", "--last"], ["-m", "gpt", "resume", "--no-daemon", "--last"]],
    [["fork", "019a-id"], ["fork", "--no-daemon", "019a-id"]],
  ])("resume·fork %j 는 서브커맨드 뒤에 붙인다", (args, argv) => {
    expect(codex(args)).toEqual({ status: 0, argv, stderr: "" });
  });

  it.each([
    [["exec", "do x"]],
    [["-m", "gpt", "exec", "do x"]],
    [["agents"]],
    [["login", "status"]],
    [["--no-daemon", "hi"]],
    [["--remote", "ws://127.0.0.1:1"]],
    [["--remote=ws://127.0.0.1:1"]],
  ])("다른 서브커맨드나 이미 정한 연결 %j 는 그대로 넘긴다", (args) => {
    expect(codex(args)).toEqual({ status: 0, argv: args, stderr: "" });
  });

  it("다른 codex 가 PATH 에 없으면 127 로 실패한다", () => {
    const result = codex(["hi"], `${bin}:/usr/bin:/bin`);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("found no other codex on PATH");
  });
});
