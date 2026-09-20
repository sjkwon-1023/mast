// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assembleSetupScript, provisionSource, setupVersion } from "./setup-script";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Windows 체크아웃(core.autocrlf)에서는 문서와 소스가 CRLF 로 올 수 있다. 앱은 스크립트를 LF 로 바꿔
// 흘리므로 비교도 LF 기준이다.
function lf(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

const source = lf(provisionSource());
const assembled = lf(assembleSetupScript());
const doc = lf(readFileSync(resolve(REPO, "scripts/wsl/claude-hook-example.md"), "utf8"));

function heredocBody(delimiter: string): string {
  const opener = `<<'${delimiter}'\n`;
  const begin = assembled.indexOf(opener);
  const end = assembled.indexOf(`\n${delimiter}\n`, begin + opener.length);
  if (begin < 0 || end < 0) throw new Error(`${delimiter} heredoc disappeared from provision.rs`);
  if (assembled.indexOf(opener, begin + 1) >= 0) throw new Error(`${delimiter} heredoc appears twice in provision.rs`);
  return `${assembled.slice(begin + opener.length, end)}\n`;
}

function firstFenceAfter(heading: string, language: string): string {
  const at = doc.indexOf(`\n${heading}\n`);
  if (at < 0) throw new Error(`"${heading}" disappeared from claude-hook-example.md`);
  const fence = `\n\`\`\`${language}\n`;
  const open = doc.indexOf(fence, at);
  const close = doc.indexOf("\n```\n", open + fence.length);
  if (open < 0 || close < 0) throw new Error(`no ${language} block after "${heading}"`);
  return doc.slice(open + fence.length, close + 1);
}

describe("claude-hook-example.md and the provisioned copies", () => {
  it("names the marker of the current SETUP_VERSION wherever it names one", () => {
    const markers = [...doc.matchAll(/\.setup-v(\d+)/g)].map((match) => Number(match[1]));
    expect(markers.length).toBeGreaterThan(0);
    expect(new Set(markers)).toEqual(new Set([setupVersion(source)]));
  });

  it("carries the Example hook script byte for byte as the installed mast-notify.sh", () => {
    expect(firstFenceAfter("## Example hook script", "bash")).toBe(heredocBody("MAST_NOTIFY_EOF"));
  });

  it("keeps scripts/wsl/skills/mast-send/SKILL.md byte for byte as the installed skill", () => {
    const skill = lf(readFileSync(resolve(REPO, "scripts/wsl/skills/mast-send/SKILL.md"), "utf8"));
    expect(skill).toBe(heredocBody("MAST_SKILL_EOF"));
  });

  it("keeps scripts/wsl/skills/mast/SKILL.md byte for byte as the installed skill", () => {
    const skill = lf(readFileSync(resolve(REPO, "scripts/wsl/skills/mast/SKILL.md"), "utf8"));
    expect(skill).toBe(heredocBody("MAST_USAGE_SKILL_EOF"));
  });
});
