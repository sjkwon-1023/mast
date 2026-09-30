// provision-setup.test.ts(설치 스크립트 전체)와 provision-hooks.test.ts(merge 헬퍼)가 함께 쓰는
// 훅 정의와 파일 검사 함수.

import { readFileSync, statSync } from "node:fs";

export const NOTIFY_CMD = '"$HOME/.mast/bin/mast-notify.sh"';
export const CLAUDE_HOOK_CMD = '"$HOME/.mast/bin/mast-claude-hook.sh"';
export const CODEX_HOOK_CMD = '"$HOME/.mast/bin/mast-codex-hook.sh"';
export const AGY_HOOK_CMD = '"$HOME/.mast/bin/mast-agy-hook.sh"';
export const NEEDS_INPUT_MATCHER = [
  "permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
  "quota_auto_resume_stale",
  "worker_permission_prompt",
].join("|");

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const command = (text: string, extra: Record<string, Json> = {}) => ({ type: "command", command: text, ...extra });
export const claudeGroup = (text: string, matcher = "") => ({ matcher, hooks: [command(text)] });
export const running = claudeGroup(`${NOTIFY_CMD} mast:running`);
export const needsInput = claudeGroup(`${NOTIFY_CMD} mast:needsInput 'needs input'`, NEEDS_INPUT_MATCHER);
export const idle = claudeGroup(`${NOTIFY_CMD} mast:idle done`);
export const dispatcher = claudeGroup(CLAUDE_HOOK_CMD);

export const FRESH_CLAUDE = {
  hooks: {
    SessionStart: [dispatcher],
    UserPromptSubmit: [running, dispatcher],
    PermissionRequest: [dispatcher],
    PostToolUse: [dispatcher],
    PostToolUseFailure: [dispatcher],
    PostToolBatch: [dispatcher],
    SubagentStop: [dispatcher],
    Notification: [needsInput],
    Stop: [idle, dispatcher],
  },
};

export const codexGroup = (timeout: number, async = false) => ({
  hooks: [command(CODEX_HOOK_CMD, async ? { timeout, async: true } : { timeout })],
});

export const FRESH_CODEX = {
  hooks: {
    UserPromptSubmit: [codexGroup(5)],
    PreToolUse: [codexGroup(5)],
    PermissionRequest: [codexGroup(10, true)],
    PostToolUse: [codexGroup(5)],
    SubagentStop: [codexGroup(5)],
    Stop: [codexGroup(5)],
    Interrupt: [codexGroup(3)],
  },
};

export const AGY_MAST = {
  PreInvocation: [command(`${AGY_HOOK_CMD} running`, { timeout: 5 })],
  Stop: [command(`${AGY_HOOK_CMD} idle`, { timeout: 5 })],
};

export function fileText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// eslint 없이도 테스트가 필드를 바로 읽을 수 있게 any 로 돌려준다.
export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function fingerprint(path: string): { text: string; ino: number; mtimeMs: number } {
  const stats = statSync(path);
  return { text: readFileSync(path, "utf8"), ino: stats.ino, mtimeMs: stats.mtimeMs };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
