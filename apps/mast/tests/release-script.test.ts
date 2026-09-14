// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// host.rs 의 release_script 는 Windows 에서만 컴파일되고 그 단위 테스트도 Windows 러너에서만 돈다. 문자열을
// 비교하는 그 테스트와 달리 여기서는 만든 rm 을 bash 로 실제로 돌려, 따옴표 밖의 glob 이 임시 파일만 지우고
// 이웃 탭(7 과 71)을 건드리지 않는지 본다.
const onLinux = process.platform === "linux";
const linuxSuite = onLinux ? describe : describe.skip;

const hostSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/host.rs"), "utf8");

function releaseScript(tabs: number[]): string {
  const body = hostSource.match(/fn release_script\(tabs: &\[TabId\]\) -> String \{\n([\s\S]*?)\n\}\n/)?.[1];
  if (!body) throw new Error("host.rs release_script disappeared");
  const start = body.match(/String::from\("([^"]*)"\)/)?.[1];
  const formats = [...body.matchAll(/format!\(\s*r#"([\s\S]*?)"#\s*\)/g)].map((match) => match[1]);
  if (start === undefined || formats.length === 0) throw new Error("host.rs release_script no longer builds its rm from raw format strings");
  return start + tabs.map((id) => formats.map((format) => format.replaceAll("{id}", String(id))).join("")).join("");
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

const PER_TAB = (id: number) => [
  `history/tab-${id}`,
  `resume/tab-${id}`,
  `resume/tab-${id}.tmp.4242`,
  `agent-hooks/tab-${id}.json`,
  `agent-hooks/tab-${id}.lock`,
  `agent-hooks/tab-${id}.diag`,
  `agent-hooks/tab-${id}.json.tmp.123`,
  `agent-hooks/tab-${id}.diag.tmp.456`,
];

linuxSuite("closed-tab release script (host.rs release_script)", () => {
  it("removes every per-tab file of the closed tabs in one rm and leaves their numeric neighbours", () => {
    const root = mkdtempSync(join(tmpdir(), "mast release-"));
    try {
      const home = join(root, "home with spaces");
      const mast = join(home, ".mast");
      for (const file of [...PER_TAB(7), ...PER_TAB(12), ...PER_TAB(71), ...PER_TAB(1)]) {
        mkdirSync(dirname(join(mast, file)), { recursive: true });
        writeFileSync(join(mast, file), "x");
      }

      const script = releaseScript([7, 12]);
      expect(script.match(/\brm\b/g)).toHaveLength(1);
      const run = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
        env: { HOME: home, PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 10_000,
      });

      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(filesUnder(mast)).toEqual([...PER_TAB(71), ...PER_TAB(1)].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
