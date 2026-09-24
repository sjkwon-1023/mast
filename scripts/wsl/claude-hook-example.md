# mast OSC contract — agent hooks / shell prompt

This is the **contract document** that implements the path described in 계획 v2 section 9
("에이전트 상태 및 알림"). It defines the meaning of the OSC sequences mast interprets (fixed
in stage 18, kept per tab since v0.3.32) and documents the halves that emit them: the Claude
Code, Codex and Antigravity CLI hooks, Codex's `notify` program, and the shell prompt.

```
agent hook (Claude Code / Codex / Antigravity CLI), or Codex's notify program
  → writes OSC 777 to the resolved TTY (/dev/tty, or an ancestor process's pts)
  → the Rust PTY reader (mast-core::osc::OscScanner) detects it
  → batched over a 100ms flush window (glue OscRouter)
  → updates the emitting tab's agent status, needs-input badge and unread dot
  → the workspace sidebar card's status and preview are recomputed from its tabs
```

v1 uses the PTY output itself (OSC sequences) as the delivery path, with no IPC server,
named pipe, or Windows helper CLI. The core and the front end know three status tokens and
nothing about any agent: which hook event means which token, and pairing an approval prompt
with the tool call it guards, happen entirely in the WSL-side scripts this document describes.

| Agent | `running` | `needsInput` | `idle` | Wired in |
|---|---|---|---|---|
| Claude Code | `UserPromptSubmit`; a tool result or batch end once no approval is pending | `Notification`, prompt types only | `Stop` | `~/.claude/settings.json` |
| Codex | `UserPromptSubmit`, `PostToolUse` | an approval still unfinished 2 s after `PermissionRequest` | `Stop`, `Interrupt`; `notify` as a gated fallback | `~/.codex/hooks.json`, `notify` in `~/.codex/config.toml` |
| Antigravity CLI | `PreInvocation` (every model call) | — (no hook event for it) | `Stop` | `~/.gemini/config/hooks.json` |

## Automatic provisioning

**mast auto-provisions this on first run per distro (`~/.mast/.setup-v19`); this
document remains the contract and the manual path.**

On launch the app streams a setup script into `wsl.exe [-d <distro>] -- bash -s` for every
distro it knows about (each workspace's, plus the WSL default) — stdin, so no Windows-side
guess at the WSL home path and no dependency on a distro's `interop`/`automount` settings.
A run with nothing to do stops after its first few lines and closes the pipe while the app is
still streaming the rest of the script; the app ignores that broken pipe and judges the run by
its exit code alone.

### What a run installs

A full run, in order:

1. `~/.mast/bin/mast-notify.sh` (executable) — the [Example hook script](#example-hook-script)
   below, byte for byte. It carries the status tokens for Claude Code and Antigravity CLI and
   the fallback idle for Codex.
2. `~/.mast/bin/mast-codex-notify.sh` (executable) — Codex's `notify` program, described under
   [The Codex half](#the-codex-half--mast-codex-notifysh). It exists separately because Codex
   hands its payload over as a final **argv** argument rather than on stdin.
3. The **`mast` CLI** at `~/.mast/bin/mast` (executable) — the command-line half of the send
   and query channels below (`mast ls` / `mast send` / `mast id`), so nothing has to assemble
   an escape sequence or repeat the tty resolution by hand. Every mast terminal has
   `~/.mast/bin` prepended to `PATH` (`apps/mast/src-tauri/src/host.rs::bash_argv`), so inside
   a tab it is just `mast`.
4. `~/.mast/bin/mast-config.py`, the standard-library Python helper for `mast config`.
   Unlike send/query, config does **not** emit OSC: it resolves and edits the Windows settings
   file directly, requiring Windows interop and drive access when invoked (not when installed).
   Commands, validation and restart semantics are in [`docs/SETTINGS.md`](../../docs/SETTINGS.md).
5. A two-line `~/.mast/bin/mast-send.sh` that execs `mast send "$@"` (it replaces the setup v3
   script, so anything still pointing at that path keeps working), and `~/.mast/bin/mast-open`,
   also installed as `xdg-open` ([ADR-0012](../../docs/adr/0012-opening-links.md)).
6. The agent hook files, copied from `scripts/wsl/` byte for byte and overwritten on every
   version: `mast-hooks-merge.py` (the config merge, Python 3.6+), `mast-agent-hook.py` (the
   Claude Code and Codex [dispatcher](#the-hook-dispatcher--mast-agent-hookpy), Python 3.8+),
   and the entry points `mast-claude-hook.sh`, `mast-codex-hook.sh` and `mast-agy-hook.sh`. The
   commands written into agent config files name only these paths, so replacing the files
   never changes a Codex trust hash.
7. 에이전트 스킬. `mast-send`는 `~/.claude/skills/mast-send/SKILL.md`에 설치한다(아래의
   에이전트 send·query 채널; 원본: `scripts/wsl/skills/mast-send/SKILL.md`). `mast` 사용법
   스킬은 `~/.claude/skills/mast/SKILL.md`에 설치한다 — CLI, send 채널, 상태 토큰을 담아
   에이전트가 안내 없이도 mast가 무엇을 제공하는지 알게 한다(원본:
   `scripts/wsl/skills/mast/SKILL.md`). `~/.codex/`가 있으면 같은 `mast` 스킬을
   `~/.codex/skills/mast/SKILL.md`에도, `~/.gemini/antigravity-cli/`가 있으면
   `~/.gemini/config/skills/mast/SKILL.md`에도 쓴다. OpenCode는 `~/.claude/skills`를 직접
   읽으므로 자체 사본이 필요 없다. **기본 스킬은 앱 시작과 `mast skill-load` 실행 때
   개인 수정 여부와 무관하게 덮어쓴다.** 커스터마이징은 다른 이름의 스킬로 만든다.
   스킬 경로의 심볼릭 링크는 링크 자체를 교체하며 대상 파일에는 쓰지 않는다.
   에이전트는 세션이 시작될 때 스킬을 읽으므로, 이미 돌고 있던 탭은 새 스킬을
   보려면 에이전트를 다시 시작해야 한다.
8. **The `python3` gate.** Every step from here on runs Python — merging into a user's JSON or
   TOML has to preserve every existing value, which rules out text munging. Without `python3`
   the run prints a notice and exits 0 **without writing a marker**, so the next launch retries.
9. **The dispatcher interpreter.** When `python3` is 3.8 or later, its absolute path goes into
   `~/.mast/bin/mast-python`. The entry points and `mast-codex-notify.sh` start the dispatcher
   with that interpreter, because the `PATH` an agent hands its hooks can differ from the setup
   shell's. Below 3.8 the record is removed and a notice printed: Claude Code gets its status
   rows only and the Codex hooks step is skipped, but the run goes on and writes its marker, so
   the notice does not repeat on every launch.
10. **Claude Code hooks** — `mast-hooks-merge.py claude` merges the rows under
    [Claude Code hooks](#claude-code-hooks--claudesettingsjson) into `~/.claude/settings.json`,
    keeping every existing value. A failed merge exits 1 with no marker.
11. **Codex `notify`** — a `notify` key is added to `~/.codex/config.toml` if that file exists
    and has no `notify` of its own ([below](#codex-notify--codexconfigtoml); a missing file
    means Codex is not installed there and nothing is created). When `~/.codex/` exists, a
    managed `mast integration` block in `~/.codex/AGENTS.md` teaches Codex the CLI and to run
    it outside the sandbox (delete the block to opt out). A failure in either exits 1 with no
    marker.
12. **Codex hooks** — when `~/.codex/` exists, `mast-hooks-merge.py codex` appends mast's
    groups to `~/.codex/hooks.json` ([Codex hooks](#codex-hooks--codexhooksjson)).
13. **Antigravity CLI hooks** — when `~/.gemini/antigravity-cli/` exists,
    `mast-hooks-merge.py agy` adds a named hook to `~/.gemini/config/hooks.json`
    ([Antigravity CLI hooks](#antigravity-cli-hooks--geminiconfighooksjson)).
14. Records what it did in `~/.mast/setup.log`, then writes the marker.

### Markers and retries

| Marker | Written when | To run it again |
|---|---|---|
| `~/.mast/.setup-v19` | Steps 1–11 succeeded (steps 12 and 13 may have failed) | `rm ~/.mast/.setup-v19` reruns **everything** — which also re-adds a Codex `notify` line, an AGENTS.md block or a Claude Code hook row you deleted by hand |
| `~/.mast/.setup-v19-codex` | The Codex hooks step finished: merged, nothing to do, skipped because `hooks.json` is not writable or is a dangling link, skipped because `config.toml` holds inline hooks, refused because of the file's content (exit 3), opted out, or skipped for want of Python 3.8 | `rm ~/.mast/.setup-v19-codex` reruns that step alone |
| `~/.mast/.setup-v19-agy` | The Antigravity CLI hooks step finished the same way (it has no inline-hooks or Python 3.8 case) | `rm ~/.mast/.setup-v19-agy` reruns that step alone |

With the main marker in place, a launch still runs an agent step whose directory exists and
whose sub-marker does not — which is how a Codex or Antigravity CLI installed after setup v16
gets its hooks without waiting for the next version. That run uses the files already in
`~/.mast/bin` (if one is missing it falls back to a full run), checks for `python3` again and,
for Codex, resolves the dispatcher interpreter again; it adds no `notify` line, no AGENTS.md
block and no Claude Code rows. A missing agent directory writes no sub-marker, so installing
the agent later is noticed.

When a run fails:

- A failure in steps 1–11 — installing a file, the Claude Code merge, the Codex `notify` line,
  the AGENTS.md block — leaves **no marker**, and the next launch repeats the whole run. So does
  a missing `python3`.
- An agent hooks step (12 or 13) that fails on I/O — a read or write error other than a file
  that is not writable, the file changing while it was being merged, `python3` gone on a rerun —
  leaves only its own sub-marker unwritten. The main marker is still written, and the next launch
  retries that step alone.
- A file that is not writable or is a dangling symlink, and for Codex a `config.toml` with inline
  hooks, is **skipped** with a notice and counts as finished: the sub-marker is written — for
  Claude Code, whose merge is part of steps 1–11, the main marker — so no launch retries it. Once
  the cause is fixed, `rm ~/.mast/.setup-v19-codex` (or `-agy`; for Claude Code
  `rm ~/.mast/.setup-v19`) wires the hooks, or add the notice's snippet by hand.
- A Codex or Antigravity CLI hooks file whose **content** the merge cannot handle is refused
  with exit 3: the file is left untouched and the sub-marker **is** written, because a rerun
  would refuse it the same way. The notice names the problem and says to edit the file and
  remove the sub-marker, or to opt out.
- Claude Code has no such refusal. A `settings.json` that does not parse, or is not a JSON
  object, fails with exit 1 and is retried on every launch: Claude Code cannot read that file
  either, so it gets fixed, and the next launch wires it with nothing else to do.

Marker files mast reads for their existence alone (the contents are never read):

| File | Effect |
|---|---|
| `~/.mast/no-codex-hooks` | Setup skips the Codex hooks step; Codex hooks already installed do nothing; `mast-codex-notify.sh` emits its idle without consulting hook state. To stop the "Hooks need review" prompt too, also delete mast's groups from `~/.codex/hooks.json`. |
| `~/.mast/no-agy-hooks` | Setup skips the Antigravity CLI hooks step. |
| `~/.mast/codex-needs-input-off` | Codex approvals never raise needs input; running and idle are unchanged. The hook definitions stay the same, so switching it needs no re-trust. |
| `~/.mast/claude-pairing-off` | Claude Code tool results report running without [pairing](#claude-code-approval-tracking--the-dispatcher-rows). |

### Notices and `~/.mast/setup.log`

Anything that needs your attention is printed to stderr as a `[mast] setup: …` line. The app
keeps it as a `provisioning notice` in `mast.log`, but that log exists only with `"log": true`
([ADR-0014](../../docs/adr/0014-opt-in-runtime-log.md)), so every notice is also appended to
`~/.mast/setup.log` — look there first. The setup script's own notices appear there as
`notice: …`, the merge helper's as the `[mast] setup: …` text it printed. The same file records
each step and the merge helper's report for every row (`claude: added PostToolUse
role=dispatcher`, `codex: wired Stop`, `agy: result=unchanged path=…`). Only the lines saying
that setup could not write somewhere — `cannot install …`, `cannot create …`, `cannot write` or
`cannot refresh` the AGENTS.md block — reach stderr alone; a failed merge's stderr line points at
`setup.log`, which holds its reason.

| When | The notice says |
|---|---|
| No `python3` | Install it, or wire the hooks by hand from this document |
| `python3` older than 3.8 | Install Python 3.8+ and `rm ~/.mast/.setup-v19` (`rm ~/.mast/.setup-v19-codex` when only the Codex step ran) |
| A Claude Code install older than 2.1.101 or 2.1.118, or one whose version cannot be read | Its path; that only the status hooks were wired; update or remove that copy, then `rm ~/.mast/.setup-v19` |
| A Codex install older than a hook feature mast relies on | Its path, and each missing feature ([version limits](#codex-version-limits)) |
| Codex hooks were written | How to trust them — the wording follows the Codex version |
| `config.toml` has inline `[hooks]` tables, `features.hooks = false`, `approvals_reviewer = "auto_review"`, or a stale `[hooks.state]` entry | What mast did not do, and why |
| An Antigravity CLI install older than 1.1.10 | Its path; that `Stop` hooks never run there |
| The file to merge is not writable (a read-only dotfiles link) or is a dangling symlink | The snippet to add by hand |
| A hook of yours that mast leaves alone but that costs something — a `Notification` mapping that also matches `idle_prompt`, a `PostToolUse` already running `mast-notify.sh`, an agy `"mast"` hook that differs from mast's | What it costs, and what to change |
| A merge refused a file (exit 3) | The reason; edit the file and remove the sub-marker, or create the opt-out marker |
| A merge failed (exit 1) | The reason; retried on the next launch |

### Which agent version is checked

Version limits come from the installs a tab could run, found **without** running your shell rc
files — an interactive login shell can hang past a timeout, hold the output pipe open, or read
the setup script's own stdin. The candidates are `command -v <name>` in the setup shell,
`~/.local/bin`, `~/.claude/local` (Claude Code only), `~/.volta/bin`, `~/.bun/bin`,
`~/.npm-global/bin` and every `~/.nvm/versions/node/*/bin`, deduplicated by resolved path;
`/mnt/*` is skipped, because a Windows install reads none of this distro's configuration. Each
runs `<path> --version` under a 10 s timeout with its own directory first on `PATH`, so an npm
shim finds its node. Any of them might be what a tab runs, so the **lowest** readable version
decides, and the notice names its path. An install anywhere else (pnpm, mise or asdf shims, a
custom npm prefix) is not seen and imposes no limit. A limit only ever withholds rows: rows
already in a file stay when an older install turns up later.

A version that cannot be read means different things per agent: Claude Code fails closed
(status rows only), while Codex and Antigravity CLI are treated as current.

### Claude Code hooks — `~/.claude/settings.json`

| Event | Matcher | Command | Role |
|---|---|---|---|
| `SessionStart` | `""` | `"$HOME/.mast/bin/mast-claude-hook.sh"` | dispatcher: forget a restarted or resumed session's approvals |
| `UserPromptSubmit` | `""` | `"$HOME/.mast/bin/mast-notify.sh" mast:running` | status: `running` |
| `UserPromptSubmit` | `""` | `"$HOME/.mast/bin/mast-claude-hook.sh"` | dispatcher: session active, clear stale approvals |
| `PermissionRequest` | `""` | `"$HOME/.mast/bin/mast-claude-hook.sh"` | dispatcher: record an approval |
| `PostToolUse` | `""` | `"$HOME/.mast/bin/mast-claude-hook.sh"` | dispatcher: release the call's approval; `running` when none is left |
| `PostToolUseFailure` | `""` | `"$HOME/.mast/bin/mast-claude-hook.sh"` | the same as `PostToolUse` |
| `PostToolBatch` | `""` | `"$HOME/.mast/bin/mast-claude-hook.sh"` | dispatcher: clear the batch's leftover approvals; `running` when none is left |
| `SubagentStop` | `""` | `"$HOME/.mast/bin/mast-claude-hook.sh"` | dispatcher: clear the subagent's approvals |
| `Notification` | `permission_prompt\|elicitation_dialog\|elicitation_url_dialog\|agent_needs_input\|quota_auto_resume_stale\|worker_permission_prompt` | `"$HOME/.mast/bin/mast-notify.sh" mast:needsInput 'needs input'` | status: `needsInput` |
| `Stop` | `""` | `"$HOME/.mast/bin/mast-notify.sh" mast:idle done` | status: `idle` |
| `Stop` | `""` | `"$HOME/.mast/bin/mast-claude-hook.sh"` | dispatcher: session inactive, clear its root approvals |

The three status rows are what mast has wired since stage 18. The eight dispatcher rows arrived
with setup v16 and are left out (`--no-dispatcher`) without Python 3.8+, or when a Claude Code
install is older than 2.1.118 or reports no readable version. The literal file is under
[Example settings.json](#example-settingsjson), and what the dispatcher rows do under
[Claude Code approval tracking](#claude-code-approval-tracking--the-dispatcher-rows).

Each row is judged on its own, by role, and a hook that is not one of ours is never touched:

- A status row is **wired** when its event already has a hook whose command contains
  `mast-notify.sh`; a dispatcher row, when its event has one containing `mast-claude-hook.sh`.
  A missing row is appended as a group of its own, with no extra keys such as `timeout`.
- A `PostToolUse` or `PostToolUseFailure` that already runs `mast-notify.sh` (a `running`
  mapping of your own) is respected: mast adds no dispatcher there, and the notice says that
  approvals then go unpaired on that event.
- Nothing is duplicated: an event that already has a hook in a role never gets a second one.

Status hooks from an older copy of this contract are migrated first:

| Existing status hook for the event | Result | Logged as |
|---|---|---|
| Runs `~/.mast/bin/mast-notify.sh` (however it is spelled — `$HOME`, `~`, absolute) | Left exactly as it is, custom arguments included | `wired <Event> role=status` |
| Runs a `mast-notify.sh` from **another** path (a hand-wired `~/.claude/hooks/…`, an older install) | The **path** is rewritten to `"$HOME/.mast/bin/mast-notify.sh"`; the arguments after it stay byte-for-byte | `migrated <Event>` |
| Mentions `mast-notify.sh` somewhere other than the leading word (`bash ~/…/mast-notify.sh …`) | Left alone — rewriting that shape would be guesswork, and it already covers the event | `untouched <Event> reason=not-leading-word` |
| None | A new group is appended | `added <Event> role=status` |

Migration exists because a hand-wired hook points at an older copy of *this* contract, which
goes stale as the script below changes (the tty fallback, the stdin JSON body).

**The `Notification` matcher is narrowed once.** Up to setup v13 mast wired `Notification`
with matcher `""`, which also matches `idle_prompt` — sent about a minute after every finished
turn — so every finished Claude Code tab turned `needs input` a minute later. After the path
migration, a group that is **exactly** what mast wrote (key order aside):

```json
{"matcher": "", "hooks": [{"type": "command", "command": "\"$HOME/.mast/bin/mast-notify.sh\" mast:needsInput 'needs input'"}]}
```

gets the six-type matcher above and is logged `narrowed Notification`; a group that already has
it is `already-narrowed Notification`. Any other `mast-notify.sh` group is yours and is kept
(`kept Notification matcher=…`). When it sends `mast:needsInput` with a matcher that also matches
`idle_prompt` (`""`, `"*"`, none, or one naming `idle_prompt`), a notice suggests the six-type
matcher.

**How a file is written** (all three merge modes):

- A symlinked file (stow and other dotfiles managers) is updated at its target, so the link
  survives. A dangling link is not followed into a new directory tree; like a file that is not
  writable (a read-only home-manager link), it is left alone with a notice carrying the snippet
  to add by hand, and the run goes on (`result=skipped-dangling-link` / `skipped-read-only`).
- The merged text is written to `<file>.mast-tmp.<pid>` beside the target with the original
  mode, and replaces the target only if its bytes are unchanged since they were read; otherwise
  the merge fails and is retried. A run with nothing to add writes nothing.
- The file is rewritten as 2-space-indented JSON with non-ASCII kept as written. A missing or
  blank file is created. JSON `null` at the top level, `NaN`/`Infinity`, invalid UTF-8, and a
  number too large to write back faithfully are refused.

### Codex `notify` — `~/.codex/config.toml`

Codex's single `notify` key is read the same way — the only line mast will ever replace is
the one mast itself wrote:

| Existing `notify` in `~/.codex/config.toml` | Result | Logged as |
|---|---|---|
| None | The line below is inserted into the **root table** (before the first `[table]` header), preceded by the opt-out comment | `notify added` |
| Byte-for-byte the line setup **v6** wrote (`… mast-notify.sh mast:idle "codex turn complete" < /dev/null`) | Replaced in place with the line below, indentation kept, nothing else in the file moved | `notify upgraded to mast-codex-notify.sh` |
| Already the line below | Left exactly as it is | `already runs mast-codex-notify.sh` |
| Anything else, **including** a hand-edited line that runs one of our scripts with different wording | Left exactly as it is; the log names the line to paste if you want the Codex resume hint | `left untouched` |
| More than one `notify =` line, or a file that does not parse as TOML | Left exactly as it is — which key is the root-table one cannot be told apart by a line scan | `left untouched` |

```toml
notify = ["bash", "-lc", 'exec "$HOME/.mast/bin/mast-codex-notify.sh" "$0"']
```

Codex appends the payload JSON as the **final argv element**, so `bash -lc <script> <json>`
puts it in `"$0"` and the script receives it as `$1`. The legacy line (written unchanged by
setups v2 through v6) predates the resume hint and named no argument at all, which is why it
threw the payload away — and why upgrading it is the one exception to "never rewrite an
existing `notify`". When `tomllib` is available (Python 3.11+), the merged result is re-parsed
and the value compared against what was intended before anything is written; if either check
fails the file is left untouched. Without `tomllib` (e.g. Ubuntu 22.04's Python 3.10), fresh
*insertion* is refused entirely, but the legacy-line *replacement* still proceeds unverified —
it swaps one known line in place, no position guessing involved.

The installer lives in `apps/mast/src-tauri/src/provision.rs`. The copies it embeds are
**byte-identical** to their sources — the "Example hook script" below,
`scripts/wsl/skills/mast-send/SKILL.md`, and the `scripts/wsl/` files of steps 4 and 6: change
both halves together. `apps/mast/tests/hook-example.test.ts` checks the first two, and that this
document names the current setup marker.

## OSC meaning contract

mast interprets these sequences. A status and a message belong to the **tab** whose session
emitted them; the workspace card shows a summary derived from its tabs.

| Sequence | Meaning | Tab status (`agentStatus`) | Unread dot |
|---|---|---|---|
| `OSC 777;notify;mast:running;<body>` | Agent work started or resumed | `running` | no |
| `OSC 777;notify;mast:needsInput;<body>` | Waiting for user input | `needsInput` | yes |
| `OSC 777;notify;mast:idle;<body>` | Work finished | `idle` | yes |
| `OSC 777;mast-send;<target>;<base64>` | Text delivered to another pane's stdin (next section) | unchanged | no |
| `OSC 777;mast-query;<kind>;<base64>` | Metadata answered into a file the sender names (section after that) | unchanged | no |
| Any other `OSC 777` / every `OSC 9` | Status-neutral notification | **unchanged** | yes |
| `OSC 0` (and the alias `OSC 2`) | Tab title | unchanged | no |
| `OSC 7` `file://host/path` | Tab cwd (respawn location on restart) | unchanged | no |

Detailed rules:

- **A status token must match the entire title field exactly** (`mast:running` /
  `mast:needsInput` / `mast:idle`). Any deviation falls through to a status-neutral
  notification — this is the boundary that keeps 777s emitted by other tools, or an
  OSC 9 such as ConEmu's progress report, from claiming agent status.
- If `body` is non-empty it becomes that tab's message (`lastAgentMessage`), for status tokens
  and status-neutral notifications alike. **An empty body does not clear a previously received
  message** — firing `running` with no body leaves the tab's preceding needsInput text in place.
  Messages are truncated at 500 characters.
- `running` is a progress signal, so it does not raise a dot. Only `needsInput`, `idle`,
  and status-neutral notifications set unread.
- **A tab that is on screen does not set unread** (active workspace + that pane's active
  tab), because its content is already in front of the user.
- **The workspace summary is recomputed from its tabs** after every change:
  - status (`agentStatus`) — the most urgent tab status: `needsInput` over `running` over `idle`;
  - message (`lastAgentMessage`) while the workspace is at `needsInput` — the newest message
    among the tabs at `needsInput`, or none when none of them has one: a waiting card never
    borrows another tab's `done`;
  - message otherwise — the newest message across all tabs. It is not narrowed to running tabs,
    because a running hook carries no body, so a running tab's message is whatever it said
    last and would hide a newer notice from another tab.
  - "Newest" is arrival order. The core numbers every OSC batch it applies, and a message takes
    its batch's number even when its text repeats the tab's previous message; a tie inside one
    batch goes to the lower tab id. The wall clock is not used — it can move backwards across
    sleep or a time sync.
- So another tab's `running` or `idle` never hides a waiting tab, and a waiting tab stops
  counting as soon as it reports something else, is closed, or its session ends. A tab whose
  session exits, or whose shell is respawned (successfully or not), is reset to `idle` with no
  message; closing a tab (CloseTab, ClosePane) takes it out of the summary.
- **Badges and toasts follow the tab.** A tab at `needsInput` shows a `!` badge separate from
  its unread dot, and the pane header badge takes a needs-input style while any of its tabs
  waits. A toast fires once for every tab that newly enters `needsInput`
  (`apps/mast/src/features/notifications/chime.ts`), so a second tab starting to wait in an
  already-waiting workspace still announces itself. It is suppressed only while the window has
  OS focus **and** that tab's workspace is the active one. The title is
  `mast — <workspace> · <tab title>`, the body the first line of that tab's own message
  (`agent needs your input` when it has none). `toast.log` records `<workspace> #<tab id>`
  instead of the title, because a tab title set by OSC 0/2 carries task text the log is designed
  to leave out. The first snapshot after a WebView reload is a baseline and never toasts — and
  a synthetic test has to reset first (`mast:idle`, then `mast:needsInput` at least 100 ms
  later), because only a transition fires and two statuses inside one 100 ms flush window
  collapse into the last one.
- The semicolon (`;`) is the field separator. If one appears inside title/body the parser
  mis-splits the fields, so the emitting side substitutes it.
- A restart resets all notifications and statuses: every tab comes back `idle` with no
  message, so every workspace derives `idle` with no preview (a dead session's needsInput does
  not survive a restart — 계획 v2 section 11).
- `mast-send` and `mast-query` are the two `OSC 777`s that are **not** notifications:
  they change no state at all, raise no dot, and are not coalesced into the 100ms flush
  window. They are actions, and each has its own section below.

## Agent send channel — `OSC 777;mast-send`

The agent-facing way to put text into **another pane's terminal**. This is the designed
successor to the retired manual send mode ([ADR-0005](../../docs/adr/0005-inter-pane-text-passing.md)):
it is addressed by tab id or title, it works while the target is off screen (a background tab,
or a whole background workspace), and it never goes through the frontend — the Rust side writes
the bytes to the target session's stdin directly.

**The channel is confined to the sender's workspace.** A workspace is the project isolation
unit, so a channel that crossed it would give a mis-aimed line a blast radius reaching shells
that have nothing to do with the work in hand (user decision 2026-08-11). The confinement
applies to **both** addressing modes and to the query channel below: a tab in another
workspace matches neither its title nor its globally unique `#id`, and does not appear in
`mast ls`. Ids stay globally unique — uniqueness is a property of the address, not a key
past the boundary. If the sender's session cannot be mapped back to a tab at all (it always
can — it is a live session that just emitted the OSC), there is no boundary to draw and
nothing is sent.

The skill that teaches an agent to use it is `scripts/wsl/skills/mast-send/SKILL.md`
(auto-provisioned to `~/.claude/skills/mast-send/SKILL.md`), and the command it tells the
agent to call is `mast send`:

```bash
mast send '#181' 'cargo test'     # runs the line in tab 181
mast send -l '#181' 'cargo test'  # literal: only pre-fills the prompt, submits nothing
mast send build 'cargo test'      # by title substring instead of id
```

The CLI encodes the text, then (unless `-l`) sends a **CR** as a second OSC 200 ms later,
and resolves the terminal device with the same two-step discipline as `mast-notify.sh` — so it
works from a hook too. Delivery stays silent (exit 0 either way); only a usage error is reported.

The sequence it emits:

```
ESC ] 777 ; mast-send ; <target> ; <base64> BEL
```

| Field | Contract |
|---|---|
| `mast-send` | Literal kind marker. Everything else after `777;` keeps its old meaning. |
| `<target>` | `#<decimal>` addresses a **tab id** exactly. Anything else is matched **case-insensitively as a substring** of a tab's title (the title the target set with `OSC 0`). Either way the candidates are the running terminal tabs of the **sender's own workspace**. |
| `<base64>` | Standard base64 (`A-Za-z0-9+/`, optional `=` padding) of the raw bytes. No URL-safe alphabet, no embedded whitespace or newline. |

| Situation | Result |
|---|---|
| Exactly one running terminal tab **in the sender's workspace** matches | Its stdin receives the decoded bytes verbatim |
| No match | Nothing is sent |
| Two or more matches | Nothing is sent — the first match is **never** picked |
| The sender's own tab matches | It is excluded before counting |
| The only match is in another workspace | Nothing is sent — it was never a candidate |
| Decoded size > 32 KiB | Rejected |
| Malformed base64 / missing text field | Rejected |

**Id addressing.** `#<target>` is an id only when everything after `#` is decimal digits that
parse as a `u64`; `#build`, `#`, `#1.2` and an out-of-range number all fall back to title
matching, so a tab whose title starts with `#` stays reachable by title. An id resolves to
one tab or to none — `Ambiguous` cannot happen, because ids are unique across the app; an id
belonging to another workspace resolves to none, exactly like an id that does not exist. The
tab's own id is in its `MAST_TAB` (below), and `mast ls` lists the rest of its workspace;
a title is the weaker address because a prompt hook may rewrite it on every prompt.

- **Nothing is written back to the sender**, on success or failure — a diagnostic in someone
  else's terminal (and in its replay buffer) is worse pollution than a missed send. Failures
  go to the app's stderr only, so sending is silent fire-and-forget.
- The bytes reach the target exactly as sent: no bracketed paste, no quoting, no trailing
  byte added. **Include a CR (`\r`)** if the target should run the line — that is the byte a
  real terminal sends for Enter, so it submits in a raw-mode TUI (Codex, Claude Code) as well
  as in a shell, whose `ICRNL` turns it back into a newline. A bare LF only submits in a
  shell; a TUI takes it into its prompt and sits there. Send the CR as its **own**
  `mast-send` a beat (≥150 ms) after the text, never appended to it: both TUIs treat bytes
  that land in one read as a paste, and a CR inside a paste is a newline. The app writes each
  send to the PTY as it arrives, so two sends spaced apart are two writes.
- The effective size limit is far below 32 KiB: the OSC scanner discards any payload over
  64 KiB before parsing — sized so the full 32 KiB text contract survives base64
  expansion. Pass a path, not
  a file.
- No state changes, so no snapshot is published and nothing is persisted.

**Environment.** Every mast terminal exports `MAST=1` and prepends `~/.mast/bin` to
`PATH`; a tab with per-tab history also exports `MAST_TAB=<tab id>` (its own stable tab id).
That is how an agent knows it is inside mast at all — the skill's description keys off
`MAST` — and the id is the tab's self-reference for a reply address. The wrapper that sets
them is `apps/mast/src-tauri/src/host.rs::bash_argv`, so they reach the login shell and
every child of it. The `PATH` entry survives the login shell because the Debian/Ubuntu rc
convention *prepends* to `PATH` (`PATH="$HOME/bin:$PATH"`) rather than reassigning it.

**Security.** Any terminal program on the machine that can write to a pane's PTY can inject
input into another pane this way. That is intended — mast assumes your own machine and
cooperating agents — and this channel is a convenience, **not** a privilege boundary. The
size cap, the unique-match requirement, the self-exclusion and the workspace confinement are
misfire guards, not security controls: they bound the blast radius of a *mistake*, and none
of them stops a program that is already free to write to the target's PTY itself.

## Agent query channel — `OSC 777;mast-query`

The read half of the agent channel: it answers "what tabs are open?" so an agent can pick a
target id instead of guessing at a title. It shares the send channel's **workspace
confinement** — it enumerates the requester's own workspace and nothing else, because a list
that reached further would offer targets the send half refuses. Unlike the notify and send
channels this one has a **reply**, and because the OSC stream is one-way (into the app) the
reply is a **file the sender names in the request**.

```
ESC ] 777 ; mast-query ; <kind> ; <base64 reply path> BEL
```

| Field | Contract |
|---|---|
| `mast-query` | Literal kind marker. |
| `<kind>` | The question. `list-tabs` is the only one the app answers; any other value is ignored (so a newer CLI against an older app simply gets no reply, and vice versa). |
| `<base64 reply path>` | Standard base64 of an absolute Linux path that **must start with `/tmp/`**. Both fields are required — `777;mast-query;list-tabs` with no path is not a query at all, since there is nowhere to answer. |

**`/tmp/` is enforced at the string level — a misfire guard, not a privilege boundary.** The
reply is a file *write performed by the mast app*. The content is only metadata the app
already owns, but leaving the path free would make this channel a way for anything that can
write to a PTY to overwrite `~/.bashrc` or `~/.claude/settings.json`. Path validation
(`crate::send::decode_reply_path`) rejects `..`, backslashes and NUL *before* the prefix
check, so `/tmp/../home/u/.bashrc` does not get through. What it does **not** block is a
pre-planted symlink (`/tmp/x → $HOME`): the write follows it server-side. Like the send
channel, this channel assumes cooperating processes on your own machine; a
canonicalize-at-write recheck is a recorded backlog item pending real-hardware 9P semantics.

The reply for `list-tabs`:

```json
{"tabs": [{"tab": 181, "title": "build", "workspaceId": 1, "workspaceName": "mast",
           "pane": 3, "active": true, "kind": "terminal", "status": "running"}],
 "self_tab": 176}
```

| Field | Meaning |
|---|---|
| `tabs` | Every open tab **of the requester's workspace**, in pane → tab order. Viewer tabs are included: this answers "what is open", not "what can I send to". |
| `workspaceId` / `workspaceName` | The requester's own workspace — the same value on every row, kept because it names the context the list is scoped to (the reply schema did not change with the confinement). |
| `kind` | `terminal` \| `folderBrowser` \| `textViewer` \| `markdownViewer` |
| `status` | `running` \| `exited` \| `not-started` (terminals) \| `viewer` (a tab with no process). Only `running` terminals are send targets — `not-started` means the shell has not come up yet, so the pane exists but nothing is listening. |
| `self_tab` | The requester's own tab id, or `null` when the app cannot map the session back to a tab. That case also empties `tabs`: with no workspace to scope to, there is nothing to enumerate. |

- **The file appears only when it is complete.** The app writes `<path>.partial` and renames
  it into place, so a reader that waits for the path to exist never sees half-written JSON —
  which matters because a write that crosses the 9P boundary from Windows into WSL does not
  land in one piece. The rename stays inside the same directory, so it never crosses a
  filesystem boundary.
- **Failure is silent, exactly like send.** A bad path, an unknown kind, a serialization or
  write failure — all of it goes to the app's stderr and **nothing** is written back to the
  requester's terminal. The reply file never appearing is the only signal the requester gets,
  which is why `mast ls` times out (2s) rather than waiting forever.
- No state changes: no snapshot is published, nothing is persisted, and the query is not
  coalesced into the 100ms notification flush window (two queries in one window must both be
  answered).
- Queries share one in-flight cap with sends (8 concurrent) — they contend for the same
  blocking thread pool, so one counter guards both.

`mast ls` is the CLI half. It `mktemp`s a name under `/tmp`, removes the placeholder, emits
the query, polls for the path to appear (0.05s, giving up at 2s), renders the JSON as a table,
and deletes the file. **The `COMMAND` column is not part of the reply** — the app has no idea
what runs inside a tab. The CLI fills it from `/proc` on its own side by finding the process
whose environment has `MAST_TAB=<id>` and reading its terminal's foreground process group,
which is why a tab whose shell lives in another WSL distro or in a Windows shell shows `?`.

## tty resolution discipline — direct `/dev/tty` → ancestor pts fallback

**The agent consumes a hook's stdout.** Claude Code and Codex process it as the hook's result
(used for UI/logs, a decision, or discarded), and Antigravity CLI requires it to be a JSON
object; none of them lets the bytes flow through to the terminal screen. If a hook script
simply writes the OSC sequence to standard output with `echo` or `printf`, those bytes never
reach the real PTY stream and the Rust PTY reader detects nothing.

A hook script must therefore write the OSC sequence **directly to the terminal device, not
to standard output**. The problem is finding that device: a single `> /dev/tty` is not
enough.

**Measured (Claude Code 2.1.226, checkpoint 2):** the hook process **has no controlling
TTY**, so `> /dev/tty` fails with `No such device or address` (ENXIO). Meanwhile **the main
Claude Code process is still attached to the `/dev/pts/N` that mast opened** — the device
is alive, only the hook side lacks a handle to it. That is why `mast_emit` in the example
below resolves the tty in two steps.

1. **Direct `/dev/tty`** — if a controlling TTY exists (running it by hand, launching the
   hook through another path, a future version where this premise changes), this is the
   right answer and it is done in one shot.
2. **Ancestor pts fallback** — if step 1 fails, walk up from the process itself through the
   PPID in `/proc/<pid>/stat`, up to 8 hops, and if the `readlink` of fd 0/1/2 of any of
   those processes points at `/dev/pts/*`, write there. **The nearest ancestor wins** — even
   with nested terminals it picks its own pane's pts rather than the outer terminal's.

If both fail (no pts in the ancestor chain — e.g. the hook runs after being reparented to
init), it **gives up silently and exits 0.** A failed notification delivery breaking the
agent session is worse than missing one notification. The depth limit of 8 and the
`/dev/pts/*` whitelist are the boundaries that keep this search from dragging on or leaking
OSC bytes into the wrong target (a log file, a pipe).

**Codex hooks usually take step 1.** Codex starts each hook command through `$SHELL -lc`
(`/bin/sh -lc` without `SHELL`) in a **new process group** of its own — not a new session —
so the hook keeps Codex's controlling terminal and `/dev/tty` opens. A process group that is
not the terminal's foreground group receives `SIGTTOU` when it writes while the terminal has
`TOSTOP` set, and by default that stops the process until Codex kills it at the hook timeout;
the Python emitter ignores `SIGTTOU` for exactly this reason. Two side effects of how Codex
starts hooks: a login profile that prints to stdout puts that text where Codex reads the hook's
output, and the hook sees the environment the Codex process started with, not the tab's
current one.

**The dispatcher's emitter** (`mast-agent-hook.py`) follows the same two steps and adds what
a process racing an agent's own screen output needs:

- `/dev/tty` is opened with `O_NOCTTY`; the pts fallback walks at most 8 ancestors, as above.
- The write is **blocking**, never `O_NONBLOCK`, bounded by a 0.5 s `SIGALRM` deadline. A
  non-blocking write can stop after `ESC ] 777`, and the agent output that follows would then
  be swallowed as OSC payload.
- When the deadline cuts a write short, a lone BEL is written under a 0.2 s deadline, so a
  partial sequence is always terminated.
- `SIGTTOU` is ignored (above), and the dispatcher's own stdout and stderr point at
  `/dev/null` before anything else runs.
- In the body, C0, DEL and C1 characters (U+0080–U+009F — xterm reads U+009C as ST even inside
  an OSC) become spaces, `;` becomes `,`, and the text is cut at 500 characters.
- A `mast:running` is not written again within 1.5 s of the same token having been written
  successfully in that tab: a tool-heavy turn would otherwise interleave an OSC with the
  agent's screen updates on every call. It is a time window, not a memory — a token written by
  another path is corrected by the first event after the window.
- Whether each write succeeded is kept in the tab's hook state. That is what lets a lost
  Codex `needsInput` be written again, and a Codex `Stop` whose write failed be recovered by
  `notify`.

(The shell prompt snippet below is unaffected by this problem — a shell has its own tty and
its stdout *is* the PTY, so neither a redirect nor a fallback is needed.)

## Example hook script

`~/.mast/bin/mast-notify.sh` (must be made executable: `chmod +x`) — the path
auto-provisioning installs this same text at. A hand install belongs there too: the settings
below name that path, and a hook still pointing at an older manual copy such as
`~/.claude/hooks/mast-notify.sh` is migrated onto it (see the migration table above). The block
below is the canonical source for the copy embedded in `apps/mast/src-tauri/src/provision.rs`
(**keep the two byte-identical**):

```bash
#!/usr/bin/env bash
# Called from a Claude Code hook to emit a mast status token as OSC 777 to the real
# terminal device.
# Arguments: $1 = status token (mast:running | mast:needsInput | mast:idle)
#            $2 = body (optional). The Notification event prefers .message from the stdin JSON.
set -euo pipefail

STATUS="${1:?usage: mast-notify.sh <mast:running|mast:needsInput|mast:idle> [body]}"
BODY="${2:-}"

# Write the OSC bytes to the real terminal device. This implements the two steps of the
# "tty resolution discipline" above.
#   1) /dev/tty — if a controlling TTY exists, this is the right answer.
#   2) /proc ancestor chain — the hook process of Claude Code 2.1.226 has no controlling
#      TTY, so 1) fails with ENXIO ("No such device or address"). In that case, walk up
#      from itself through its parents and write to the /dev/pts/* that fd 0/1/2 of each
#      process points at. The main Claude Code process is attached to mast's pts, so it
#      is found a few hops up.
# If neither works, give up silently — a failed notification must not break the Claude session.
mast_emit() {
  local payload="$1"

  if { printf '%s' "$payload" > /dev/tty; } 2>/dev/null; then
    return 0
  fi

  local pid=$$ depth=0 fd target stat ppid
  while [[ "$pid" -gt 1 && "$depth" -lt 8 ]]; do
    for fd in 0 1 2; do
      target="$(readlink "/proc/$pid/fd/$fd" 2>/dev/null || true)"
      [[ "$target" == /dev/pts/* ]] || continue
      if { printf '%s' "$payload" > "$target"; } 2>/dev/null; then
        return 0
      fi
    done
    # /proc/<pid>/stat has the form "<pid> (<comm>) <state> <ppid> ...". comm can contain
    # spaces and parentheses, so cut from after the last ')' and read the ppid that
    # follows state.
    stat="$(cat "/proc/$pid/stat" 2>/dev/null || true)"
    [[ -n "$stat" ]] || break
    stat="${stat##*) }"
    ppid="${stat#* }"
    ppid="${ppid%% *}"
    [[ "$ppid" =~ ^[0-9]+$ ]] || break
    pid="$ppid"
    depth=$((depth + 1))
  done

  return 1
}

# Claude Code passes the event information as JSON on stdin when it runs a hook.
# For the Notification event, the .message field holds the human-readable notification text,
# and .session_id names the session this hook belongs to (used for the resume hint below).
# stdin can only be read once, so both fields are taken from the same captured text.
# Without jq, fall back to the default body received as an argument (the hook keeps working).
SESSION_ID=""
if [[ ! -t 0 ]]; then
  INPUT_JSON="$(cat)"
  if command -v jq > /dev/null 2>&1; then
    FROM_JSON="$(printf '%s' "$INPUT_JSON" | jq -r '.message // empty' 2>/dev/null || true)"
    if [[ -n "$FROM_JSON" ]]; then
      BODY="$FROM_JSON"
    fi
    SESSION_ID="$(printf '%s' "$INPUT_JSON" | jq -r '.session_id // empty' 2>/dev/null || true)"
  fi
fi

# Resume hint. mast respawns a tab's shell on restart, so the agent session that ran in it
# is gone from the screen; recording how to re-enter it lets the fresh shell offer the command
# (apps/mast/src-tauri/src/host.rs::bash_argv reads this file and never runs it). Rewritten
# on every hook call, so the tab's most recent session wins. Line 1 is the command, line 2 the
# epoch seconds it was recorded at. tmp+mv makes the replacement atomic for a concurrent
# reader, and every failure here is swallowed: a notification must not break on it.
# The id is required to be a plain token: the spawn wrapper echoes line 1 into the terminal
# and into shell history and checks nothing itself, so this is where that is guarded. A
# session id is a uuid, so the check rejects nothing real.
if [[ -n "${MAST_TAB:-}" && "$SESSION_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  RESUME_FILE="$HOME/.mast/resume/tab-$MAST_TAB"
  if mkdir -p "$HOME/.mast/resume" 2>/dev/null; then
    if printf 'claude --resume %s\n%s\n' "$SESSION_ID" "$(date +%s 2>/dev/null || echo 0)" \
         > "$RESUME_FILE.tmp.$$" 2>/dev/null; then
      mv -f "$RESUME_FILE.tmp.$$" "$RESUME_FILE" 2>/dev/null || true
    fi
    rm -f "$RESUME_FILE.tmp.$$" 2>/dev/null || true
  fi
fi

# A semicolon (;) left inside the body makes the parser mis-split the fields, so substitute it.
BODY="${BODY//;/,}"

# OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
mast_emit "$(printf '\033]777;notify;%s;%s\007' "$STATUS" "$BODY")" || true

# Even if the emission fails, the hook exits successfully (miss a notification rather than
# break the session).
exit 0
```

## Example settings.json

What setup v16 writes into a `~/.claude/settings.json` that had no hooks. A hand install uses
the same paths: the dispatcher entry point looks for the dispatcher and for
`~/.mast/bin/mast-python` under `~/.mast/bin`.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-claude-hook.sh\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-notify.sh\" mast:running"
          }
        ]
      },
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-claude-hook.sh\""
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-claude-hook.sh\""
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-claude-hook.sh\""
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-claude-hook.sh\""
          }
        ]
      }
    ],
    "PostToolBatch": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-claude-hook.sh\""
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-claude-hook.sh\""
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|quota_auto_resume_stale|worker_permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-notify.sh\" mast:needsInput 'needs input'"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-notify.sh\" mast:idle done"
          }
        ]
      },
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-claude-hook.sh\""
          }
        ]
      }
    ]
  }
}
```

The status rows (`mast-notify.sh`) carry the three tokens:

- `UserPromptSubmit`: right after the user submits a prompt — "work started" (`running`).
  It passes no body, so the preceding preview text stays as it is.
- `Notification`: only for the notification types that wait on the user — `permission_prompt`,
  `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`, `quota_auto_resume_stale`
  and `worker_permission_prompt` (the last is the agent-teams permission request, absent from
  Claude Code's public list). `idle_prompt`, sent about a minute after every finished turn, is
  left out on purpose: nothing is being asked. The stdin JSON's `.message` carries the actual
  text (e.g. "Claude needs your permission to use Bash").
- `Stop`: when Claude Code finishes its response and returns to waiting — "work done"
  (`idle`).

The dispatcher rows (`mast-claude-hook.sh`) send a token only when releasing approvals leaves
none pending — `running`, or `idle` after a subagent's cleanup once the turn is over
([Claude Code approval tracking](#claude-code-approval-tracking--the-dispatcher-rows)).
Without Python 3.8+, or with a Claude Code older than 2.1.118, only the status rows are written.

### (Optional) Carrying the last response text on Stop

`Stop`'s stdin JSON contains `.transcript_path` (JSONL), so the last assistant message can
be extracted and used as the preview. It is not in the base example because it deepens the
jq dependency — if you want it, append it to the `BODY` resolution part of the script above:

```bash
TRANSCRIPT="$(printf '%s' "$INPUT_JSON" | jq -r '.transcript_path // empty')"
if [[ -n "$TRANSCRIPT" && -r "$TRANSCRIPT" ]]; then
  LAST="$(jq -rs '[.[] | select(.type == "assistant")] | last
                  | .message.content[]? | select(.type == "text") | .text' \
          "$TRANSCRIPT" 2>/dev/null | tail -n 1 || true)"
  if [[ -n "$LAST" ]]; then
    BODY="$LAST"
  fi
fi
```

## The hook dispatcher — `mast-agent-hook.py`

One Python 3.8 standard-library script serves both Claude Code and Codex.
`mast-claude-hook.sh` and `mast-codex-hook.sh` run it in `claude` and `codex` mode for every hook
event — the event comes from the payload's `hook_event_name`, so one fixed command covers all of
them — and `mast-codex-notify.sh` runs it in `codex-notify` mode. Its source is
`scripts/wsl/mast-agent-hook.py`.

- **Never a decision.** In `claude` and `codex` mode it writes nothing to stdout and exits 0 on
  every path, and the entry points do the same without `exec`-ing the interpreter: both agents
  read exit 2 as block/deny and stdout as a hook decision. A failure before the dispatcher gets
  going (a missing interpreter, a syntax error) leaves one line in the tab's `.diag` file
  instead. Only `codex-notify` exits 1, and only when it died before trying to write, so that
  the notify script falls back to its own idle.
- **No tab, no work.** The hooks are global and also run in terminals outside mast. Without a
  decimal `MAST_TAB` the entry points drain stdin and exit without starting Python. Without a
  usable interpreter in `~/.mast/bin/mast-python` they drain stdin and record a diagnostic.
- **Bounded input.** stdin is read for at most 0.5 s. The first 1 MiB is kept for parsing and
  the rest drained, keeping only its last 4 KiB. A payload cut off that way is still used: both
  agents serialize the identifying fields ahead of the large `tool_response`, so those come from
  the prefix, and `tool_use_id` comes from the tail.
- **Per-tab state.** `~/.mast/agent-hooks/tab-<MAST_TAB>.json` (directory mode 0700) is read and
  rewritten under an exclusive `flock` on `tab-<id>.lock` and replaced atomically. It is capped
  at 32 KiB, oldest entries evicted first, and a file that does not parse is started afresh.
  `tab-<id>.diag` keeps only the latest diagnostic (at most 1 KiB, never a payload or command
  text). Closing the tab deletes all of them, stray temporary files included
  ([ADR-0013](../../docs/adr/0013-retiring-a-closed-tab.md)). A late hook for a closed tab does not
  recreate the state file unless it has something to record, and a Codex approval's hold-off
  sleeper recreates nothing at all.
- **Time budgets.** A hook that cannot take the lock loses its event, so it waits as long as
  its timeout allows: 3.0 s for synchronous events, 1.5 s for Codex's `Interrupt`, and 2.5 s for
  each of the two lock takes of Codex's asynchronous `PermissionRequest`. With start-up (~0.1 s),
  stdin (≤0.5 s) and the write (≤0.7 s) that is 4.3 s inside a 5 s timeout, 2.8 s inside 3 s,
  and 8.3 s — the 2 s hold-off included — inside 10 s. Claude Code's hook timeout defaults to
  600 s, but a hook holds up the tool result until it returns, so Claude Code mode uses the same
  3 s budget.
- **Direct emission.** The OSC is written from Python inside the locked section, not by
  spawning `mast-notify.sh`: a bash, a jq and a tty search there would make events arriving
  together miss the lock. The write rules are in the
  [tty section](#tty-resolution-discipline--direct-devtty--ancestor-pts-fallback).
- **The resume hint is never touched** ([Resume hint](#resume-hint--mastresumetab-id)).
- **Cost.** No daemon, no polling, nothing alive between hooks. Each dispatcher event starts one
  bash and one Python: for Claude Code that is mostly one per tool result, batch end and approval
  request, plus one per prompt, stop and session start; for Codex two per tool call
  (`PreToolUse`, `PostToolUse`) and one asynchronous per approval request.

## Claude Code approval tracking — the dispatcher rows

Before setup v16, a Claude Code tab that asked for approval stayed at `needs input` until the
turn's `Stop`, however quickly you approved: no status hook fires in between. Reporting
`running` on every tool result would be wrong the other way. Claude Code runs subagents in the
background by default, and their tool results would clear a prompt that the main agent — or
another subagent — is still showing. The dispatcher therefore pairs each approval with the tool
call it guards, and reports `running` only once **no** approval is pending in the tab. The
`needs input` itself still comes from the `Notification` status row.

Each approval is recorded as a **wait**: the session id, the scope (the subagent's `agent_id`,
or root), the tool name, and a fingerprint of the canonical `tool_input`. Event by event:

| Event | What happens | Token |
|---|---|---|
| `PermissionRequest` | A wait is recorded (at most 64 per tab; the oldest goes first). | none |
| `PostToolUse`, `PostToolUseFailure` | One wait of the same session, scope and tool is released: the one with the **same input**; failing that, one recorded without a readable input; failing that — only for `AskUserQuestion`, `ExitPlanMode`, `Edit`, `Write` and `NotebookEdit`, whose input the permission dialog rewrites before the tool runs — the oldest of that tool. A result whose own `tool_input` cannot be read (cut off by the 1 MiB bound) releases the oldest wait of that tool, whatever the tool. A failure with `is_interrupt: true` counts like any other failure. | `running` when the tab has no wait left |
| `PostToolBatch` | Every remaining wait of that session and scope is dropped: calls that ended without a result — denied with feedback, decided by another hook, run with changed input — and approval requests that arrived after their result. | `running` when the tab has no wait left |
| `SubagentStop` | The subagent's waits are dropped. It fires for an interrupted subagent too. | If that emptied the tab: `running` while the root session is active, `idle` (`done`) when it is not |
| `UserPromptSubmit` (root) | This session's root waits and **every other session's** waits are dropped; this session's subagent waits stay. The session is marked active. The same for every prompt source — typed, a queued prompt folded in mid-turn, `/loop` and scheduled wakeups, task notifications. | none (the status row sends `running`) |
| `Stop` (root) | This session's root waits are dropped and the session is marked inactive. | none (the status row sends `idle`) |
| `SessionStart` with `source` `startup` or `resume` | Every wait of that session id is dropped and the session is marked inactive. `clear`, `compact`, `fork` and any other source are ignored. | none |

A root `PermissionRequest`, tool result or batch end also marks its session active again: a turn
that a blocking Stop hook continues has no `UserPromptSubmit`.

Why the rules have these shapes:

- **The exact input, not the tool name.** Tools that are safe to run concurrently (`WebFetch`,
  `Read`) ask for permission in parallel; releasing by name would let a sibling's result clear
  the prompt still on screen. The five rewriting tools are the exception because an exact match
  can never happen for them: `Edit`, `Write` and `NotebookEdit` run one at a time, so an older
  wait of the same name belongs to a dialog that is already closed, and `AskUserQuestion` and
  `ExitPlanMode` always ask in an interactive session, so every result of that name has a wait
  of its own and the count stays right.
- **A root prompt keeps subagent waits.** A prompt can be submitted, or folded into the turn,
  while a subagent's approval dialog is open; dropping its wait would report `running` over that
  dialog. Other sessions' waits go, so a session ended with Ctrl+C cannot hold back `running` in
  the next session forever.
- **`SessionStart` for `startup` and `resume` only.** `claude --resume <id>` and `--continue`
  keep the session id, and a process that died (WSL sleep, a kill) before its `SubagentStop`
  would leave subagent waits that root prompts deliberately keep — blocking `running` for the
  whole resumed session. A freshly started process has no subagents. `clear` issues a new id, so
  there is nothing to drop, and its hook can run late, after the next prompt has already marked
  the session active. `compact` happens mid-session, possibly with a subagent dialog open. `fork`
  gets a new id, and the next root prompt drops the old session's waits as another session's.
- **`is_interrupt`.** Pressing Esc while a tool runs fires no hook at all, so `is_interrupt: true`
  only reaches the dispatcher from tool errors after which the turn goes on.

**Known limits.**

| Situation | What the tab shows |
|---|---|
| Esc while Claude Code is streaming, or while a tool runs | No hook reports it: `running` stays until the next prompt. |
| A prompt denied without feedback (No / Esc) | The turn ends with neither `Stop` nor `PostToolBatch`. `needs input` stays if the `Notification` already fired (after about 6 s without input); otherwise `running` stays. Either lasts until the next prompt. |
| An approved command that runs for a long time | `needs input` until the tool finishes. |
| The main agent's `Stop` while a subagent's approval dialog is open | The `Stop` status row's `idle` replaces `needs input`, and no second `Notification` follows. |
| Any root prompt while a subagent's approval dialog is open | The `UserPromptSubmit` status row's `running` replaces `needs input`; the dispatcher keeps the wait but does not send `needs input` again. |
| A background subagent still working after the main agent's `Stop` | Its tool results send `running`, and a `SubagentStop` that drops no wait sends nothing, so `running` stays until the main agent's next `Stop`. |
| `claude -p` run from the same tab's Bash tool | Its prompt counts as another session's and drops the outer session's waits. |
| A sandboxed network permission prompt | It fires no `PermissionRequest` to pair, so the next unrelated tool result's `running` replaces the `Notification`'s `needs input`. |
| An `AskUserQuestion` or `ExitPlanMode` call a `PreToolUse` hook allowed with `updatedInput` | It has no wait, so its result can release a parallel sibling's wait by name. |
| A subagent wait that neither `SubagentStop` nor `PostToolBatch` reached (a hook killed, a lock timeout) | It holds back `running` in that tab until that `SubagentStop`, or another session's root prompt. |
| A status-row token written right after a dispatcher `running` | The dispatcher never sees status-row tokens, so its 1.5 s repeat suppression can hold back a `running` that would have corrected one. |

**Turning pairing off.** With `~/.mast/claude-pairing-off`, `PostToolUse` and
`PostToolUseFailure` send `running` unconditionally and every other dispatcher event is ignored.
Approvals still clear before `Stop`, but a background subagent's tool result can clear a prompt
that is still open.

**Claude Code versions.** Setup adds the dispatcher rows only when every Claude Code install it
finds reports 2.1.118 or later ([Which agent version is checked](#which-agent-version-is-checked)):

- Before **2.1.101**, a hook event name Claude Code does not recognize makes it ignore **the whole**
  `settings.json`, permissions included — one new event name would cost every setting.
- Before **2.1.118** there is no `PostToolBatch`, so an approval whose call never produced a
  result could not be cleared before the turn ends.
- An install whose version cannot be read could be either, so it gets the status rows only, and
  the notice names its path.

The other dispatcher events (`SessionStart` with its `source`, `PermissionRequest`,
`PostToolUse`, `PostToolUseFailure`, `SubagentStop`) already exist in 2.1.101.

## Resume hint — `~/.mast/resume/tab-<id>`

A restart respawns every terminal tab as a **fresh login shell**: the layout comes back, but
the agent session that was running in the tab does not, and its id is nowhere on screen. Each
agent hands mast a confirmed id when it reports — Claude Code's hook stdin JSON carries
`.session_id`, Codex's notify payload carries `thread-id`, and the OpenCode plugin sees session
events. The writers are `mast-notify.sh` (on every Claude Code status hook),
`mast-codex-notify.sh` and the OpenCode plugin; each records it per tab and the next shell in
that tab offers it back. **The hook dispatcher never writes or reads a hint**, and Antigravity
CLI records none — the reader below has no form for it.

**This is a hint, never an action.** The recorded command is put in front of the user in two
places and run by neither of them.

| Field | Contract |
|---|---|
| Path | `~/.mast/resume/tab-<id>`, where `<id>` is the writer's `MAST_TAB` — the tab's stable id, which survives a restart, so the file and the tab that gets the hint are the same tab. |
| Line 1 | The resume command: `claude --resume <id>`, `codex resume <id>`, or `opencode --session <id>`. The reader takes **only this line**. |
| Line 2 | Epoch seconds at the time of writing. Recorded for diagnosis; **nothing reads it** — see freshness below. |
| Written when | An invocation has both a non-empty `MAST_TAB` and an id matching `^[A-Za-z0-9_-]+$` — Claude Code's `.session_id`, Codex's `thread-id` (`thread_id` is accepted too), or OpenCode's confirmed root session id. Codex additionally requires its saved session metadata to show a resumable top-level session (`resumable` below). OpenCode records a root at creation or its first observed activity, before idle. |
| Not written when | The tab has no `MAST_TAB` (a tab without per-tab history), the payload does not parse or carries no id, or the id is not a plain token. Claude Code additionally needs parsable hook JSON and `jq`, and writes nothing when stdin is a TTY (the script run by hand, so no JSON is read at all). For Codex, also for every ownership other than `resumable` — a top-level session from another source, a temporary thread, a subagent or internal session, metadata that cannot be read — and for a `codex exec` nested in another agent's turn. For OpenCode, sessions with `parentID` are rejected, and the prior hint is preserved when the session lookup fails. |
| Atomicity | Written to `<path>.tmp.<pid>` and `mv`d into place, so a concurrent reader sees either the old file or the new one, never a half-written line. The pid suffix keeps two writers firing at once in the same tab from sharing a temp name. |
| Failure | Swallowed. Every step is guarded and the writer still exits 0 — a resume hint must never cost a notification, let alone the session. |

**Both agents write the same file, and the last eligible session to report in that tab wins.**
That is the intended behavior, not a collision to be designed away: a tab where you switched from
Claude Code to Codex should offer the Codex thread back, and the same in reverse. There is one
hint per tab; Codex's internal temporary turns and subagents must not replace it.

The reader is `apps/mast/src-tauri/src/host.rs::bash_argv`, the same wrapper that sets
`MAST_TAB` and `HISTFILE`. Before it execs the login shell it reads line 1 and, if it is
non-empty:

1. **appends it to the tab's `HISTFILE`**, so a single press of ↑ at the fresh prompt puts the
   command on the command line, and
2. prints one dimmed line, `[mast] resume previous agent: <cmd>`.

If the file does not exist the wrapper prints nothing at all — a tab that never ran an agent
looks exactly as it did before. The block is written so that it does not fail the `&&` chain
that ends in `exec bash -l` — a broken hint must not cost you the shell. (The one status it
cannot swallow is the hint `printf` failing to write to the pane's own tty, which is not a
state a usable tab is in.)

**Both sides check the shape.** The writer guards the id's charset, and the reader accepts
only three exact forms — `claude --resume <token>`, `codex resume <token>`, and
`opencode --session <token>`, where `<token>`
is `[A-Za-z0-9_-]+` — dropping the hint silently otherwise, so a substituted file cannot
become a surface for luring an ↑+Enter into running something else. That reader list is a
**whitelist**: wiring a third agent means adding its form there as well, or its hint is
recorded and then quietly thrown away. Anything running as you could edit `~/.bashrc`
directly, so this is a misfire guard rather than a privilege boundary — the same stance as the
send channel.

**A restart with no new session in between re-appends the same line.** The hint is not
consumed by being shown, so N restarts of a tab whose recorded session has not changed leave
N copies of it at the end of that tab's `HISTFILE`. They are adjacent, so ↑ still lands on it
once; the file simply grows.

**Freshness is the user's call.** The hint is shown whenever the file exists, however old it
is. An age cutoff would have to guess at a threshold, and being wrong in the strict direction
hides the one thing the user was looking for; the timestamp is on line 2 for anyone who wants
to check by hand. Nothing prunes these files by age; closing the tab deletes its file, as it
deletes the tab's history ([ADR-0013](../../docs/adr/0013-retiring-a-closed-tab.md)).

### The Codex half — `mast-codex-notify.sh`

Codex's `notify` program is run once per completed turn (`agent-turn-complete`) and receives
the payload as a single JSON object appended as the **final argv element** — not on stdin.
Since setup v16 it is no longer Codex's only signal: the [hooks](#codex-hooks--codexhooksjson)
report running, needs input and idle as they happen. `notify` stays for what the hooks cannot
do — the resume hint — and as a gated fallback idle. `~/.mast/bin/mast-codex-notify.sh` is that
program; its source is the `provision.rs` heredoc, and this section is its contract. Given `$1`:

1. **Reads two fields with jq, defensively.** `thread-id` and `last-assistant-message`, falling
   back to `thread_id` / `last_assistant_message` (the payload has been serialized both kebab-
   and snake-cased across releases; `codex-cli 0.147` is kebab). Neither is required. The body is
   the first line of the message with C0, DEL and C1 characters replaced by spaces and cut at
   500 characters — by code point, inside jq, because bash's `[[:cntrl:]]` and `${var:0:n}`
   follow the locale, and in the C locale they miss UTF-8 encoded C1 characters and cut
   multibyte characters in half. With no message it reads `codex turn complete`.
2. **Stands down inside another agent's turn.** With `CLAUDECODE` set (a `codex exec` started by
   Claude Code's Bash tool), or `CODEX_THREAD_ID` set to a thread other than the payload's (a
   `codex exec` started by an outer Codex turn), it exits 0 with no hint and no idle: the tab's
   own agent is still working, and the hint should stay its session's.
3. **Classifies the thread** from its saved metadata (below) as `resumable`, `confirmed`,
   `rejected` or `unknown`, and records the resume hint only for `resumable`.
4. **Hands the idle decision to the dispatcher**: `mast-agent-hook.py codex-notify <ownership>
   <payload>`, run with the interpreter recorded in `~/.mast/bin/mast-python` (`resumable` is
   passed as `confirmed`). If there is no usable interpreter, or the dispatcher exits non-zero
   (it does only when it died before trying to write), the script falls back to
   `mast-notify.sh mast:idle "<body>"` with stdin closed — unless the thread was `rejected`,
   which is a confirmed fact that this idle would be wrong.

The program exits 0 whatever happens — Codex should never report a failing `notify`.

**Ownership.** Codex 0.154.0 also invokes `notify` for temporary catch-up summaries, whose ids
cannot be resumed, and the notification's documented fields do not tell these threads apart. The
script therefore reads the first record of
`${CODEX_HOME:-$HOME/.codex}/sessions/*/*/*/rollout-*-<id>.jsonl`:

| Outcome | First record | Resume hint | Passed to the dispatcher |
|---|---|---|---|
| `resumable` | `type: "session_meta"` with this exact `payload.id`, and `payload.source` `"cli"` or `"exec"` | written | `confirmed` |
| `confirmed` | the same, with any other top-level source — `vscode`, a custom one, an older rollout without `source` | not written | `confirmed` |
| `rejected` | the same, with a `source` object that has a `subagent` or `internal` key | not written | `rejected` |
| `unknown` | no match: no transcript, a different first record, more than 1 MiB, the deadline passed, no `jq` or `timeout`, no `MAST_TAB`, or an id that is not a plain token | not written; the existing hint stays | `unknown` |

`rejected` is kept narrow on purpose — the same test as Codex's own non-root-agent check —
because the dispatcher drops the idle on it. Only the first record is read, capped at 1 MiB; the
whole check has a two-second deadline with a one-second forced-kill grace period (`timeout` from
Ubuntu's coreutils).

This is a compatibility check against observed local transcripts, **not a stable Codex API**.
It never guesses another thread from cwd, queries a private SQLite schema, or starts Codex to
resolve an id. A custom `CODEX_HOME` is used to locate metadata; the offered command retains the
existing contract and assumes the same Codex environment at restart. See
[OpenAI's notify contract](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)
and [its transcript-format caveat](https://learn.chatgpt.com/docs/hooks#common-input-fields).

The check prevents future overwrites; it does not repair a hint already poisoned before setup
v12 installed it. Complete one turn in the intended session, then restart. The Linux regression
`apps/mast/tests/codex-resume.test.ts` executes the installed-script heredoc and the actual
spawn-wrapper history path with isolated fixture homes.

**The idle decision** (`codex-notify`). `notify` is spawned after Codex's `Stop` hook without
being awaited and goes through `bash -lc` and jq, so when a queued prompt opens the next turn at
once, the previous turn's `notify` can arrive after the next turn's `running`; and a subagent's
or a catch-up summary's `notify` fires in the same tab. The first rule that matches decides:

1. `MAST_TAB` missing or not decimal → nothing.
2. `~/.mast/no-codex-hooks` exists → `idle` straight away, without reading hook state (the
   behavior before setup v16).
3. `CLAUDECODE` set, or `CODEX_THREAD_ID` set to another thread → nothing.
4. Under the tab's hook-state lock (3 s):
   - the payload does not parse, or lacks `thread-id` or `turn-id` → `idle` (fail open);
   - the thread is the tab's current Codex session → nothing when the hooks already reported
     that turn's end successfully, when a later turn has started, when the ownership is
     `rejected`, or while an approval is still shown as needs input; otherwise `idle`, which is
     how a `Stop` whose write failed gets recovered;
   - the thread is the session the tab had just before → nothing: whatever switched sessions is
     newer than this turn;
   - `rejected` → nothing;
   - `unknown` while the current session is mid-turn or has an approval shown → nothing;
   - otherwise → `idle`.
5. The lock not acquired in time → `idle`, unless the ownership is `rejected` with both ids
   present.

The body is the first line of `last-assistant-message` (control characters replaced, `;` as
`,`, at most 500 characters), or `codex turn complete`. Only the current session and the one
before it are remembered, so after two quick session switches a `notify` from two sessions back
can still send an idle.

The control-character scrub is load-bearing, not hygiene: unlike Claude Code's `.message`,
which is a canned string, `last-assistant-message` is **model output**, and it is on its way
into an escape sequence written to a terminal. An embedded BEL would end the OSC early and hand
whatever followed to the terminal as input, and xterm treats U+009C as the end of the sequence
too.

### The OpenCode half — global `mast.js` plugin

Setup v16 installs one global plugin at `$XDG_CONFIG_HOME/opencode/plugins/mast.js` (or
`~/.config/opencode/plugins/mast.js` when `XDG_CONFIG_HOME` is unset). It detects the
standard curl installation at `~/.opencode/bin/opencode` even when the non-interactive
setup shell cannot see the installer's interactive PATH export. It does not install a
second copy in a project or `~/.opencode`. The canonical plugin source is
`scripts/wsl/mast-opencode-plugin.js`; provisioning embeds that source. A pre-existing
`mast.js` without mast's matching ownership digest is left untouched. An edited managed
file is likewise preserved. Setup logs the conflict in `~/.mast/setup.log`.

For the default OpenCode 1.18.31 TUI, `session.status` busy/retry maps to
`mast:running`, `permission.asked` and `question.asked` map to `mast:needsInput`,
replies map back to `mast:running`, and root `session.idle` maps to `mast:idle`.
Repeated busy events are coalesced. Child idle does not idle the tab or replace the
resume hint. The plugin delegates OSC emission to the existing `mast-notify.sh` with
stdin closed and Bun shell echo disabled, so it neither waits for TUI input nor prints
shell output into the TUI. The plugin event callback does not throw into OpenCode's bus.

The hint is written at the first confirmed root event, so a restart during the first
turn can offer `opencode --session <id>`. The plugin checks `parentID` on session
metadata; when it first sees an existing session through a status event, it queries
that session through OpenCode's client before writing. The reader's whitelist accepts
only the exact `opencode --session <token>` form. Reopening an OpenCode session from a
different cwd and notification delivery through a real Windows mast tab remain field
checks in `docs/WINDOWS-BUILD.md`. `--pure`, server modes (`serve`, `web`, `attach`),
`opencode2`, and CLI guidance for OpenCode agents are outside this integration.

## Codex hooks — `~/.codex/hooks.json`

Setup v16 gives Codex live status: `running` when a prompt is submitted or a tool call finishes,
`needs input` while an approval dialog is open, `idle` when a turn stops or is interrupted.
The `notify` line above stays wired alongside.

**What is installed.** One group per event, appended to the end of that event's array (the file
is created if missing). Every handler runs the same fixed command with no arguments, and no group
has a `matcher`, so `PreToolUse`, `PostToolUse` and `PermissionRequest` see every tool:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-codex-hook.sh\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.mast/bin/mast-codex-hook.sh\"",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ]
  }
}
```

— and the same for the other events, with the timeouts below. The dispatcher tells the events
apart by `hook_event_name`.

| Event | Mode | Timeout | What the dispatcher does | Token |
|---|---|---|---|---|
| `UserPromptSubmit` | sync | 5 s | Root: starts the turn and closes root records; a prompt carrying a turn id that already ended (a steer consumed late) is ignored. Subagent: closes that subagent's records from other turns. | root: `running`, or `needsInput` again while a subagent approval is still open |
| `PreToolUse` | sync | 5 s | Records the call as open (scope, turn, `tool_use_id`, fingerprint) and closes the same scope's records from other turns. A root call in a turn that had stopped resumes it — a blocking Stop hook continues a turn without a prompt. | only when that changed what the tab should show |
| `PermissionRequest` | **async** | 10 s | The hold-off below. | `needsInput <summary>` if the call is still unfinished after 2 s |
| `PostToolUse` | sync | 5 s | Releases the call's record — by `tool_use_id`, or by fingerprint within the turn when the id cannot be read. | `running`; `needsInput` stays while another approval is open. After the root turn has stopped, a subagent's result sends nothing — or `idle` again when it released the last open approval |
| `SubagentStop` | sync | 5 s | Cleanup only: closes every record of that subagent — approved calls that then failed or were denied by a hook, which never get a `PostToolUse`. | only when that changed what the tab should show |
| `Stop` | sync | 5 s | The root turn ended: closes root records. | `idle <first line of last_assistant_message>` (`codex turn complete` when empty), or `needsInput` while a subagent approval is open |
| `Interrupt` | sync | 3 s | The same as `Stop` for the root turn; subagents are left alone, since Esc aborts only the root task. | `idle interrupted`, or `needsInput` as for `Stop` |

Codex caps `Interrupt` hook timeouts at 3 s. A summary is the command's first line for `Bash`,
`network access to <target>` for a network approval, and the tool name otherwise.

**Installed is not running: trust.** From Codex 0.129.0 a hook does not run until you trust it.
Trust is recorded as a hash of the event, the matcher and the handler (command, timeout,
`async`), under a key `<hooks.json path>:<event>:<group index>:<handler index>`. From 0.131.0
Codex asks at launch — **Hooks need review**, offering *Review hooks*, *Trust all and continue*
and *Continue without trusting (hooks won't run)*. Continuing without trusting records nothing,
so the prompt comes back on **every** launch until you trust the hooks or remove them. On
0.129.x–0.130.x there is no launch prompt: trust them from `/hooks`. Before 0.129.0 hooks run
without a review. The notice setup prints matches the lowest installed Codex version, and a
version it cannot read counts as current. mast never writes `trusted_hash`, never edits
`[features]`, and never uses or suggests `--dangerously-bypass-hook-trust`: trusting a hook is
your decision.

**Why the definition never changes.** Every field of a group feeds the hash, so the command is
fixed and takes no arguments, and the groups carry no matcher: a script update, or a later change
in which tools matter, needs no re-trust. For the same reason mast only **appends** — a group of
yours is never edited or moved, so the group indexes in existing trust keys stay valid. Deleting
or reordering a group that sits before mast's changes mast's index and asks for trust again. A
leftover `[hooks.state."<key>"]` with `enabled = false` from a group you deleted at the same
position keeps mast's hook disabled even after you trust it; setup names such an entry.

**Opting out.** Create `~/.mast/no-codex-hooks` — setup stops installing, installed hooks do
nothing, and `notify` goes back to a plain idle — **and** delete mast's groups from
`~/.codex/hooks.json`; otherwise the untrusted groups keep the launch prompt coming. To keep
running and idle but drop the approval false positives below, create
`~/.mast/codex-needs-input-off` instead: the hook definitions do not change, so nothing needs
re-trusting.

**What setup checks first**, reading `~/.codex/config.toml` and never writing it:

- **Inline hooks.** If `config.toml` already has a non-empty `hooks.<Event>` array,
  `hooks.json` is neither created nor changed, because Codex warns on every launch when both
  hold hooks. Add mast's groups to your inline tables by hand, after your own
  `[[hooks.<Event>]]` tables (an event written as an inline array, `Stop = [ … ]`, has to be
  extended inside that array instead):

  ```toml
  [[hooks.UserPromptSubmit]]
  [[hooks.UserPromptSubmit.hooks]]
  type = "command"
  command = '"$HOME/.mast/bin/mast-codex-hook.sh"'
  timeout = 5

  [[hooks.PreToolUse]]
  [[hooks.PreToolUse.hooks]]
  type = "command"
  command = '"$HOME/.mast/bin/mast-codex-hook.sh"'
  timeout = 5

  [[hooks.PermissionRequest]]
  [[hooks.PermissionRequest.hooks]]
  type = "command"
  command = '"$HOME/.mast/bin/mast-codex-hook.sh"'
  timeout = 10
  async = true

  [[hooks.PostToolUse]]
  [[hooks.PostToolUse.hooks]]
  type = "command"
  command = '"$HOME/.mast/bin/mast-codex-hook.sh"'
  timeout = 5

  [[hooks.SubagentStop]]
  [[hooks.SubagentStop.hooks]]
  type = "command"
  command = '"$HOME/.mast/bin/mast-codex-hook.sh"'
  timeout = 5

  [[hooks.Stop]]
  [[hooks.Stop.hooks]]
  type = "command"
  command = '"$HOME/.mast/bin/mast-codex-hook.sh"'
  timeout = 5

  [[hooks.Interrupt]]
  [[hooks.Interrupt.hooks]]
  type = "command"
  command = '"$HOME/.mast/bin/mast-codex-hook.sh"'
  timeout = 3
  ```

  Without `tomllib` (Python before 3.11) the tables are found by a header pattern, which cannot
  tell a header-shaped line inside a multi-line string apart. A `[hooks.state]` table on its own
  is trust bookkeeping and does not count.
- `features.hooks = false` (or the older `features.codex_hooks`) → a notice that mast's hooks
  will not run. This needs `tomllib`.
- `approvals_reviewer = "auto_review"` (or its old name `guardian_subagent`) in the **root
  table** — a line above the first `[table]` header → a notice. The dispatcher reads the same
  lines at runtime and raises no needs input while the key is there, because the automatic review
  usually outlasts the hold-off and every reviewed request would look like a prompt. The key
  inside a table (a `[profiles.<name>]` profile) or a `-c` override is seen by neither check.
- Whether an app-server control socket exists under `~/.codex/app-server-control/` is logged
  (see the limits below).
- **The shape of `hooks.json`.** It has to be a file Codex accepts: top-level keys only
  `description` and `hooks`, arrays of group objects per event, handlers of type `command`,
  `mcp_tool`, `prompt` or `agent` with correctly typed fields and no known field twice. Codex
  discards a file that fails this entirely, so reporting mast's hooks as installed into it would
  be false: the merge is refused with exit 3 and a notice. Duplicate keys that Codex tolerates
  are logged (`duplicate-key-kept-last`), and the rewrite keeps only the last value.
- mast writes to `~/.codex` only; a custom `CODEX_HOME` is not followed for hooks.

**Approvals: the hold-off and the pairing.** A Codex `PermissionRequest` carries no call id and
does not say whether a dialog actually appeared — a call approved by the session's "don't ask
again" cache, an automatic review or a pre-approved patch fires it too — and, being
asynchronous, it can start after its call has finished. The dispatcher therefore:

1. records every call at its synchronous `PreToolUse`, which Codex awaits before running the
   tool, so the record exists before the approval request is handled;
2. on `PermissionRequest`, picks the **newest** open record in the same scope and turn with the
   same fingerprint (a call retried with the same input is common) and marks it a candidate —
   no match means the call already finished, and nothing happens;
3. sleeps 2 s without holding the lock, and if the record is still a candidate, marks it
   emitted and writes `needsInput` inside the same locked section.

Fingerprints: `Bash` — the tool name and `command` (the approval request's `description` is left
out, since only the approval carries it; a network-access approval carries the command of the
exec that owns it); `apply_patch` — the patch text normalized the way Codex's own parser does
(trimmed, CRLF line ends, a `<<EOF` heredoc wrapper removed), since the approval carries the
parsed form and the tool events the model's text; MCP tools — the tool name and the canonical
arguments (`{}` when there are none). `write_stdin` and `request_permissions` approvals cannot be
paired — their approval input has a different shape, and `write_stdin` has no `PreToolUse` — so
they never raise needs input.

Rules that keep an open dialog on screen:

- The next `PreToolUse` is **not** taken as the approval: parallel sibling calls announce
  themselves while the dialog is still up.
- A root prompt, `Stop` or `Interrupt` closes only root records, and if a subagent's approval is
  still open it writes `needsInput` again: queued input and steering submit root prompts while a
  subagent dialog is open.
- If the `needsInput` write itself failed (a blocked pty), the next event that decides writes it
  again.
- When the root turn has already stopped and a subagent's result releases the last open
  approval, the tab returns to `idle` with the turn's closing line rather than `running`.
- A sleeper that died (killed, or it could not take the lock) leaves its record a candidate; only
  another approval request for the same call arms it again.

**Gates.** No token at all when `MAST_TAB` is missing; when `CLAUDECODE` is set (Codex started
from Claude Code's Bash tool); when `transcript_path` is empty — a temporary thread (`SubagentStop`
is exempt: its path is the parent's and may be null); when `CODEX_THREAD_ID` is set and differs
from the payload's `session_id` — a `codex` started inside a Codex shell, since the root Codex
process has no `CODEX_THREAD_ID`; when `session_id` or `turn_id` is missing; or when
`~/.mast/no-codex-hooks` exists. A `session_id` different from the one on record starts the tab's
Codex state afresh, remembering only the previous session for late `notify` calls.

**Accepted false positives and residue.**

| Case | What the tab shows |
|---|---|
| An automatically approved call that runs longer than 2 s | `needs input` after 2 s, with a toast; `running` when it finishes |
| A real dialog you approve | `needs input` until the command finishes (its `PostToolUse`), so a long command shows it while it runs. Approved within 2 s, it appears only if the command is still running 2 s after the request — after you approved |
| A real dialog you **deny** and the turn goes on | No `PostToolUse`: `needs input` until the turn's `Stop` or `Interrupt`, or the next root prompt — for a subagent's call, until that subagent's `SubagentStop`. Denied within 2 s, it appears after you denied |
| A command that outlives the model's `yield_time_ms` (250 ms–30 s, 10 s by default) and continues in the background | Its `PostToolUse` arrives only when a `write_stdin` poll sees it exit; until then, or until `Stop`/`Interrupt`, `needs input` stays. A short yield makes an ordinary automatically approved command a false positive too. |
| An approved root call that then fails (an MCP `isError`, a handler error) | No `PostToolUse`: `needs input` until `Stop`, `Interrupt` or the next root prompt. The same in a subagent is cleared at its `SubagentStop`. |
| A subagent approval aborted (Esc, "No, tell Codex …") | The aborted turn fires neither `SubagentStop` nor `Interrupt`: `needs input` until that subagent's next turn — in practice the end of the session |
| Another `PreToolUse` hook rewrites the input (`updatedInput`) | The approval no longer matches its record: no `needs input` for that call |
| Esc at the root while a subagent keeps working | Subagent results with nothing to release send nothing: the tab shows `idle` while it works |
| A prompt carrying an already-ended turn id during a Stop-hook continuation | Ignored until the continued turn's first `PreToolUse` |
| `approvals_reviewer = "auto_review"` in the root table | `needs input` is off for Codex approvals (a profile or `-c` override is not detected) |
| A zsh-fork `Execve` interception (off by default), or a heredoc `apply_patch` intercepted by `exec_command` | Its approval cannot be paired: no `needs input` |

### Codex version limits

Setup names each limit that applies to the lowest installed Codex, with its path:

| Before | Consequence |
|---|---|
| 0.124.0 | Hooks are off by default: none of mast's run. |
| 0.129.0 | Hooks run without a trust review. |
| 0.131.0 | No "Hooks need review" prompt at launch: trust the hooks from `/hooks`. |
| 0.133.0 | No `SubagentStop`: an approval a subagent never finished can keep the tab at needs input. |
| 0.148.0 | Asynchronous hooks are skipped with a warning: Codex approvals never show as needs input. |
| 0.150.0 | No `Interrupt`: after Esc the tab can stay running or at needs input until the next prompt. |

Other limits:

- **A shared app-server daemon.** When the Codex TUI attaches to a shared app-server, hooks run
  in the daemon's environment and on its terminal: they emit nothing, or emit into the tab that
  started the daemon. Setup logs whether the control socket exists
  (`codex: app-server-control-socket=present`).
- **The login shell.** Hooks run through `$SHELL -lc`, so a profile that prints to stdout puts
  that text where Codex reads the hook's output.

## Antigravity CLI hooks — `~/.gemini/config/hooks.json`

Antigravity CLI (`agy`) reports `running` and `idle`. When `~/.gemini/antigravity-cli/` exists,
setup adds one named hook, `"mast"`, to its global hooks file:

```json
{
  "mast": {
    "PreInvocation": [
      {
        "type": "command",
        "command": "\"$HOME/.mast/bin/mast-agy-hook.sh\" running",
        "timeout": 5
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "\"$HOME/.mast/bin/mast-agy-hook.sh\" idle",
        "timeout": 5
      }
    ]
  }
}
```

- **The file.** Top-level keys are hook names; each holds an optional `enabled` and handlers per
  event. `PreInvocation` and `Stop` take a flat handler array (`PreToolUse` and `PostToolUse` take
  matcher groups). A handler runs through `sh -c`, and `timeout` is in seconds. Global hooks have
  no trust step.
- **One script, the event as an argument.** agy's stdin payload is camelCase JSON with no
  event-name field, so the argument says which event ran. `running` comes from `PreInvocation`,
  which fires before every model call — several times per turn, which changes no status after
  the first. `idle` comes from `Stop`, with the first line of `finalModelOutput` as the body
  (control characters replaced, at most 500 characters, via jq), or `done` without jq or output.
  Both go out through `mast-notify.sh` with stdin closed.
- **stdout is exactly `{}`.** agy parses a handler's stdout as a JSON object: empty output is a
  parse failure, and stray fields could change the next model call or the stop decision.
  `mast-agy-hook.sh` sends everything its commands print to `/dev/null`, writes `{}` and a
  newline, exits 0, ignores `SIGPIPE`, and closes the real stdout for its children so a lingering
  descendant cannot hold it open. It keeps the first 1 MiB of stdin and drains the rest, so agy's
  write never blocks.
- **Gates.** Nothing is emitted outside a mast tab (`MAST_TAB` not decimal) — the file is global
  — or when `CLAUDECODE` or `CODEX_THREAD_ID` is set, which means another agent in the tab started
  this `agy` and owns the tab's status.
- **No needs input.** agy has no hook event that fires on a permission prompt or a question, so
  a tab waiting for a tool confirmation stays `running`. `PreToolUse` is no substitute: it must
  return a `decision`, and a failing hook denies the tool. The one candidate is the
  `tool_confirmation_pending` state agy passes to a `statusLine`/`title` script — not
  implemented, because it would take over a single setting that belongs to you, and when agy
  runs that script again is unverified.
- **No resume hint.** The spawn wrapper's whitelist has no form for agy, so nothing is recorded.

The merge (`mast-hooks-merge.py agy`):

| Existing file | Result | Logged as |
|---|---|---|
| Missing, or without a `"mast"` key and without any hook running `mast-agy-hook.sh` | `"mast"` is added; every other key stays untouched | `added mast` |
| A `"mast"` equal to the definition above | Left as it is | `wired mast` |
| That same definition with `"enabled": false` | Left as it is — an opt-out, not a difference | `disabled mast` |
| A `"mast"` that differs | Left as it is; the notice carries mast's definition | `differs mast` |
| Another named hook that already runs `mast-agy-hook.sh` | Nothing added | `wired mast via=<name>` |
| Not a JSON object, `"mast"` defined twice, or **any** named hook that agy would reject | Refused with exit 3 — agy skips the whole file when one hook fails validation, so none of your hooks run either | `result=failed` |

Opt out with `~/.mast/no-agy-hooks` (setup skips the step) or `"enabled": false` on the `"mast"`
hook. The step needs `python3` for the merge, but not Python 3.8: no dispatcher is involved.

**Versions and limits.**

- Before **1.1.10**, hooks.json `Stop` hooks never run (they sat behind agy's built-in stop
  checks), so a tab stays `running` after every turn; setup names the lowest install below that.
  The file format above was read from agy 1.1.13 and 1.2.2.
- Unverified until a field run records them: whether Esc cancelling a turn fires `Stop`, and with
  which `terminationReason`; a `Stop` while background work goes on (`fullyIdle: false`), which
  still reports `idle`; hooks under `--dangerously-skip-permissions` and on the remote-control or
  daemon paths; whether an edited hooks.json is picked up without restarting agy; and which path
  the hook's write takes (`/dev/tty` or an ancestor pts).

## Emitting title and cwd from the shell prompt (OSC 0 / OSC 7)

The tab title and cwd are emitted by the shell on every prompt, not by a hook. In the WSL
side's `~/.bashrc`:

```bash
# On every prompt, emit the current directory (OSC 7) and the tab title (OSC 0).
# The shell's stdout is the PTY itself, so no /dev/tty redirect is needed.
__mast_osc() {
  # OSC 7: file://<host>/<path> — mast ignores host and uses only the path (ST terminator).
  printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-wsl}" "$PWD"
  # OSC 0: tab title — here, the directory name (BEL terminator).
  printf '\033]0;%s\007' "${PWD##*/}"
}
PROMPT_COMMAND="__mast_osc${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
```

- mast percent-decodes the OSC 7 path. If the path contains `%`, it must be encoded as
  `%25` per the convention to be accurate (if what follows `%` is not two hex digits, it is
  left as a literal).
- This cwd is used as the **respawn location after a restart** — the shell reopens in the
  directory it was last in.
- To change the title to something else, such as an agent name, just swap the OSC 0 string.
  Even if ConPTY re-encodes OSC 0 as OSC 2 in transit, mast receives it with the same
  meaning.

## Verification

1. Use `scripts/wsl/osc-test.sh` first to confirm "does an OSC written to /dev/tty reach the
   mast app" (OSC 777 is cases 7, 8, and 9). This script runs directly from the shell and
   therefore has a tty, so it only takes step 1 — its purpose is to see whether the delivery
   path itself is alive.
2. Read `~/.mast/setup.log`: each merged row (`added`, `wired`, `migrated`, `narrowed`) and
   every notice is there, and the markers `~/.mast/.setup-v19`, `.setup-v19-codex` and
   `.setup-v19-agy` show which steps finished.
3. Then run each agent inside a mast terminal and confirm that its hooks update the tab's badge
   and dot, the pane badge, and the sidebar status and preview. The field checklist is
   `docs/WINDOWS-BUILD.md` §10, "v0.3.32 — Agent state signals verification (setup v16)". A
   synthetic check has to reset first and give the second token its own flush window —
   `sleep 5; mast-notify.sh mast:idle x; sleep 0.2; mast-notify.sh mast:needsInput y` — because
   the needs-input onset fires only on a transition, and two tokens within 100 ms collapse into
   the last one. The toast is suppressed while mast has focus on that tab's workspace, so use the
   leading five seconds to switch workspace or window if you want to see it.
4. A silent dispatcher leaves its reason in `~/.mast/agent-hooks/tab-<id>.diag` (`mast id`
   prints the tab id): no usable interpreter, a lock not acquired, an approval that matched no
   call, a failed terminal write.
5. If a hook is silent and there is no diagnostic, start by looking at where the fallback broke.
   Inside a mast terminal, reproduce a tty-less context with
   `setsid -w bash -c 'printf "" > /dev/tty' ; echo $?`, and check whether the main Claude
   process is attached to `/dev/pts/*` with
   `for p in $(pgrep -f 'claude'); do readlink /proc/$p/fd/1; done`. Check as well that the
   ancestor chain is within 8 hops.
6. The Linux regressions: `apps/mast/tests/agent-hooks.test.ts` drives the dispatcher through a
   real pty, `provision-hooks.test.ts` the merge helper and `mast-agy-hook.sh`,
   `provision-setup.test.ts` the assembled setup script, `codex-resume.test.ts` the notify
   ownership and the restart hint, and `hook-example.test.ts` this document's byte-identical
   blocks.

## Notes

- BEL (`\007`) is not relied on as the only completion signal (계획 v2 section 9) — mast's
  `OscScanner` recognizes both BEL and ST (`ESC \`) as terminators.
- "The hook has no controlling TTY" is a **fact measured on Claude Code 2.1.226**, not a
  guaranteed contract. That is exactly why the example script keeps step 1 — if a later
  version hands the hook a tty, it works as is without taking the fallback, as Codex hooks
  already do. Conversely, if an agent comes to run somewhere that is not a pts (a pipe-only
  daemon, say — the shared Codex app-server is one), step 2 will not find a target either, and
  at that point we have to move to the file/socket watching alternative.
- If ConPTY turns out to swallow OSC 777 (spike-plan.md section 6, checklist item 1), this
  hook path has to be replaced with the file/socket watching alternative (see 계획 v2
  section 2, "단일 실패점"). The examples in this document rest on the premise that OSC
  passthrough is alive. Real-world passthrough of OSC 0/7 is still unverified, and its
  failure would be independent of the notification path (777/9).

## 스킬 갱신

스킬 원본은 `scripts/wsl/skills/`에 있으며 앱에 직접 포함됩니다. 앱을 시작할 때
설치 마커와 무관하게 기본 스킬을 번들 원본으로 덮어씁니다. 개인 수정도 덮어쓰므로
커스터마이징은 다른 이름의 새 스킬로 만드세요.

`mast skill-load`는 마지막으로 앱이 배포한 원본으로 기본 스킬을 재설치합니다.
네트워크나 실행 중인 mast 터미널은 필요하지 않습니다. 에이전트가 변경된 스킬을
발견하려면 에이전트 세션을 다시 시작해야 합니다.
