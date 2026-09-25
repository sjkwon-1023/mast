// @vitest-environment node

// CI(Linux) gates가 macOS·Linux 공용 Python 스위트를 돌리게 하는 래퍼다.
// python3가 없으면 skip하지 않고 실패한다.

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testsDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(testsDir, "../../..");
const WSL = join(REPO_ROOT, "scripts/wsl");

// 러너가 mast 탭 안의 Claude Code·Codex에서 돌면 이 값들이 이미 있고 python 호출을
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
if (!PYTHON) throw new Error("manager python tests require python3");

describe("manager python store", () => {
  // 스위트가 서브프로세스와 git을 돌려 5초 기본 제한에 걸린다. spawnSync의 제한과 맞춘다.
  it("passes the Python unittest suite", { timeout: 120_000 }, () => {
    const result = spawnSync(
      PYTHON!,
      ["-B", "-m", "unittest", "discover", "-s", "scripts/wsl/tests", "-p", "test_*.py"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: scrubbedEnv(),
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(result.error, String(result.error)).toBeUndefined();
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(result.status, output).toBe(0);
    expect(output).toContain("OK");
  });

  for (const file of ["mast-manager.py", "mast-manager-harness.py", "mast-config.py"]) {
    it(`parses ${file} with the Python 3.8 grammar`, () => {
      const output = execFileSync(
        PYTHON!,
        [
          "-B",
          "-c",
          "import ast, sys; ast.parse(open(sys.argv[1]).read(), feature_version=(3, 8)); print('ok')",
          join(WSL, file),
        ],
        { encoding: "utf8", env: scrubbedEnv(), timeout: 20_000 },
      );
      expect(output.trim()).toBe("ok");
    });
  }
});
