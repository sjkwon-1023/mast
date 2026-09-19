# ADR-0026 — Per-tab agent state and hook-driven agent signals

- Status: accepted
- Date: 2026-09-15
- Supersedes in part [ADR-0006](0006-osc-notification-routing.md): decision 4 in full, the
  workspace target of decision 3, and the rationale decision 1 gave for its application order;
  extends decision 7 to the tab fields. Extends [ADR-0013](0013-retiring-a-closed-tab.md)'s
  delete-on-close to the hook dispatcher's per-tab files.
- Verification: WINDOWS-BUILD §10 v0.3.32 (field checklist not yet run)

## Context

Running several Claude Code and Codex agents across workspaces and tabs, the three states mast
shows — **running**, **idle**, **needs input** — were wrong in ways a user noticed daily. There
were three defects.

1. **Codex only knew idle.** Its single signal was the legacy `notify` program, fired on turn
   completion and mapped to `mast:idle`. A Codex tab never showed running and never asked for
   input.
2. **One workspace slot masked tabs.** ADR-0006 decision 4 stored the status on the workspace
   with an `agent_status_source` tab. Another tab's idle overwrote a running agent; a moved
   source blocked demotion by other tabs; the reset on closing the source tab also cleared tabs
   that were still alive; and a second tab starting to wait in a workspace that was already at
   needs input produced no toast and no indication of which tab was waiting.
3. **Claude Code stayed at needs input after an approval, and raised it when nothing waited.**
   After the user approved a tool, the next hook that emitted a token was the turn-ending
   `Stop`, so a long agentic turn showed needs input to the end. The `Notification` hook's
   matcher was `""`, so `idle_prompt` — sent about a minute after every finished turn — was
   reported as needs input too.

Constraints the fix had to keep:

- **The OSC token contract is unchanged**: `mast:running`, `mast:needsInput`, `mast:idle`, with
  OSC 9 and non-matching 777 titles staying status-neutral (ADR-0006 decision 3). The core and
  the front end stay agent-agnostic; everything agent-specific belongs to the WSL-side hook
  scripts that provisioning installs.
- **Idle cost stays near zero**: no polling, no timer, no resident process.
- **No screen, title or process detection.** State comes from the agents' own hooks.
- **The user's agent configuration is theirs**: no `[features]` edits in Codex's `config.toml`,
  no `trusted_hash` writes, no use or advice of Codex's hook-trust bypass flag.
- **`PERSIST_VERSION` stays 1.** An existing `state.json` must load unchanged.

## Decisions

### 1. Agent state lives on the tab; the workspace fields are derived

- `Tab` gains `agent_status: AgentStatus` (default `Idle`) and `last_agent_message:
  Option<String>`, both `#[serde(default)]` and always serialized, plus a
  `#[serde(skip)] last_agent_message_seq: Option<u64>`. A token writes the emitting tab's status;
  a message writes that tab's message. The 500-character cap and the last-non-empty merge of
  ADR-0006 decision 1 are unchanged.
- `Workspace.agent_status_source` is gone. `Workspace.agent_status` and
  `Workspace.last_agent_message` stay as **stored derived values**, so the sidebar and the phone's
  `/api/state` read the same fields as before. `command/events.rs::recompute_agent_summary`
  recomputes them after every change that can move them:
  - **Status** is the highest `AgentStatus::urgency()` across the workspace's tabs (idle 0,
    running 1, needs input 2). It is an explicit function because the declaration order
    (running, needs input, idle) would make a derived `Ord` wrong.
  - **Message while the workspace needs input** is the newest message among the tabs that need
    input, or `None` when none of them has one. A waiting card never borrows another tab's text
    (the old slot let a sibling's "done" replace the question).
  - **Message while running or idle** is the newest message across all tabs. Running hooks carry
    no body, and an empty body does not clear a tab's earlier message, so restricting this case
    to running tabs would let a running tab's stale question hide a newer notification.
  - **Newest** means the highest OSC batch sequence. `Dispatcher` increments `osc_batch_seq` once
    per `apply_osc` call, and a message stamps it even when the text repeats. Ties inside one
    batch go to the smallest `TabId`. The wall clock is not used because a sleep resume or a
    time sync can move it backwards; `last_activity_ms` is not used because title and cwd deltas
    also move it.
- `clear_tab_agent` resets one tab (idle, no message, no sequence) and recomputes. It runs on
  `SessionExited` and on **every** respawn outcome — a respawn that fails and falls back to
  `Exited` used to skip the reset, and a successful one must not inherit the previous shell's
  agent. `CloseTab` and `ClosePane` recompute once per workspace after removing tabs.
  `SessionStartupTimeout` leaves agent state alone, since that session is still alive.
- `Workspace::validate` gains no derived-consistency check. `validate_app` runs before `sanitize`
  at load, so such a check would mark older state files corrupt and start fresh. The consistency
  is asserted by a core test that recomputes every workspace of the golden fixture
  (`snapshot_fixture_workspace_agent_fields_match_their_tabs`); the fixture's second workspace now
  carries the needs-input terminal tab its workspace status implies.
- Persistence: old files without the tab fields load through serde defaults, and the removed
  `agentStatusSource` key is ignored. `sanitize` resets every tab's status, message and sequence
  along with the workspace fields (ADR-0006 decision 7, extended).
- ADR-0006 decision 5 stands, in the form ADR-0018 left it: a late delta for a session-less tab
  fails to locate and changes nothing.

### 2. Needs-input onset is per tab, with one toast per tab

- `features/notifications/chime.ts::detectNeedsInputOnset(prev, workspaces)` takes a
  `Map<TabId, AgentStatus>` and returns `{ onsets: TabOnset[]; next }` with
  `TabOnset = { workspaceId, tabId }`. The rules carry over unchanged, now per tab: `prev === null`
  (the first snapshot of a WebView lifetime) only sets the baseline, a repeated needs input is
  silent, a tab first seen at needs input counts, and vanished tabs drop out, so the map is
  bounded by the tab count. A second tab starting to wait in an already-waiting workspace now
  produces an onset, because the check no longer looks at the workspace value, which does not
  change.
- Suppression is unchanged: `needsInputToastTargets` drops an onset only when the OS window is
  focused **and** its workspace is the active one. A hidden tab in the active workspace gets its
  badge rather than a toast, so the same fact is not reported twice.
- `needsInputToasts` builds **one toast per target**, never merged by workspace. The title is
  `mast — <workspace name> · <tab title>` and the body is the first line of **that tab's own**
  `lastAgentMessage`, falling back to `agent needs your input` — never the workspace message,
  which may be another tab's question.
- `notify_toast` takes a `log_label`. `toast.log` records `ok label="<workspace> #<tab id>"` (or
  `err label="…": <error>`) instead of the toast title: tab titles arrive over OSC 0/2 and carry
  task text and paths, and the log already excludes the body for the same reason.
- Badges: every tab button has a `!` badge (`tab-needs-input`, tooltip "Needs input"), distinct
  from the unread dot — unread clears when the tab is viewed, needs input clears when the agent
  sends its next token. The node always exists and toggles through `hidden`, and `sameTabButton`
  compares `needsInput`, so a status-only change patches in place (ADR-0006 decision 8). The pane
  dot shows for unread **or** needs input and takes a `needs-input` class and the tooltip "Agent
  needs input in this pane". The sidebar and the phone are unchanged; they read the derived
  workspace fields.

### 3. The hook layer owns agent-specific pairing

- A single dispatcher, `~/.mast/bin/mast-agent-hook.py`, turns hook events into tokens. It has
  three modes: `claude`, `codex`, and `codex-notify <ownership> <payload>`. It uses the Python 3.8
  standard library only.
- **Entry points** `mast-claude-hook.sh` and `mast-codex-hook.sh` are one argument-less command
  for every event; the event comes from `hook_event_name` on stdin. Each drains stdin and returns
  before starting Python when `MAST_TAB` is unset or not numeric — global hooks also run outside
  mast. It reads the interpreter path from `~/.mast/bin/mast-python`, requires it to be an
  executable file, runs the dispatcher with `-I` and **without `exec`**, discards its stdout and
  always exits 0: both agents read exit 2 as block/deny, and an interpreter crash must not become
  one. A missing interpreter or a non-zero exit writes a diagnostic of at most 1 KiB.
- **Output contract**: `claude` and `codex` modes write 0 bytes to stdout and exit 0 on every
  path. `codex-notify` exits 1 only when it died before attempting an emission, so its bash
  caller can fall back.
- **Input bounds**: stdin is read for at most 0.5 s. The first 1 MiB is kept for parsing and the
  last 4 KiB in a ring. An oversized payload is parsed by scanning the complete top-level fields
  of the prefix — both agents serialize the identifying fields before `tool_response` — and
  `tool_use_id` is taken from the tail.
- **State**: `~/.mast/agent-hooks/tab-<MAST_TAB>.json` (directory 0700, files 0600, ASCII JSON,
  at most 32 KiB), locked through `tab-<id>.lock` with `fcntl.flock` under an alarm deadline and
  replaced atomically (`.tmp.<pid>` then `os.replace`) inside the lock. `tab-<id>.diag` holds the
  latest diagnostic only, at most 1 KiB, and never a payload or command text on the normal path.
  A file that does not parse or has the wrong shape is reset with one diagnostic. Over the size
  cap, entries are evicted oldest first in this order: open Codex records, Claude waits, Claude
  sessions, other Codex records, the previous-session slot, ended Codex turns. Other bounds: 64
  Claude waits and 64 Codex records, 8 Claude sessions, 8 ended Codex turns, ids over 96
  characters stored as a SHA-256 prefix, summaries of 160 characters. A late event on a tab with
  no state file writes nothing when it has nothing to record, and the async confirmation opens the
  lock without `O_CREAT`, so a closed tab's files are not recreated by a sleeper.
- **Lock budgets** are derived from the hook timeouts, counting startup at about 0.1 s, stdin at
  up to 0.5 s and an emission at up to 0.7 s. Synchronous events wait up to 3.0 s for the lock
  (4.3 s against Codex's 5 s timeout), `Interrupt` 1.5 s (2.8 s against 3 s), and the async
  `PermissionRequest` 2.5 s for each of its two acquisitions around the 2.0 s hold-off (8.3 s
  against 10 s). Claude events and `codex-notify` use the synchronous budget as well: Claude's
  600 s default timeout would otherwise let a hook hold a tool result for minutes.
- **Emitter discipline**: the terminal is resolved the way `mast-notify.sh` resolves it —
  `/dev/tty`, then fd 0/1/2 of up to eight ancestors pointing at `/dev/pts/*`. The OSC 777 goes out
  in a **blocking** write under a 0.5 s deadline; if the deadline cuts it, a lone BEL is written
  under a 0.2 s deadline so an unterminated `ESC]777` cannot swallow the agent's following output.
  `SIGTTOU` is ignored, because Codex runs hooks in their own process group and a `TOSTOP`
  terminal would stop the write. Bodies have C0, DEL and C1 (U+0080–U+009F; xterm treats U+009C as
  ST) replaced by spaces and `;` replaced by `,`. Whether the emission succeeded is recorded in the
  state. A `mast:running` that changes nothing is not re-sent within 1.5 s of an identical
  successful emission — a TTL, not a permanent memory, so a token from another path is corrected
  by the next event after it. The dispatcher never writes resume-hint files.
- **Opt-out markers** under `~/.mast/`, checked on every call by existence only:
  `codex-needs-input-off` (Codex approvals never raise needs input; the installed hooks stay
  identical, so switching needs no re-trust), `claude-pairing-off` (Claude `PostToolUse` and
  `PostToolUseFailure` emit running without pairing; the other dispatcher events do nothing) and
  `no-codex-hooks` (the Codex hooks do nothing and `codex-notify` emits idle without reading
  state). Provisioning creates none of them.

### 4. Claude Code: approvals are paired with their tool calls

Provisioning keeps the three status rows running through the unchanged `mast-notify.sh` and adds
dispatcher rows (`"$HOME/.mast/bin/mast-claude-hook.sh"`). Every group's matcher is `""` except
Notification's.

| Event | Rows | Effect |
|---|---|---|
| `SessionStart` | dispatcher | clears a resumed session's leftover waits |
| `UserPromptSubmit` | status `mast:running`, dispatcher | running; activates the session, clears waits |
| `PermissionRequest` | dispatcher | records a wait (no token) |
| `PostToolUse`, `PostToolUseFailure` | dispatcher | releases its wait; running when none remain |
| `PostToolBatch` | dispatcher | clears the batch scope's waits; running when none remain |
| `SubagentStop` | dispatcher | clears the subagent's waits |
| `Notification` | status `mast:needsInput 'needs input'` | needs input (narrowed matcher, decision 6) |
| `Stop` | status `mast:idle done`, dispatcher | idle; deactivates the session |

Needs input still comes only from `Notification`. The dispatcher adds the release: it emits
`mast:running` when the last wait goes away, and `mast:idle done` in the one case below.

- **State**: waits `{session, scope, tool, fingerprint}`, where scope is `agent_id` or root and the
  fingerprint hashes the tool name with canonical `tool_input`; sessions `{session, active}`.
- **`PermissionRequest`** records a wait. An unreadable `tool_input` records one without a
  fingerprint.
- **`PostToolUse` / `PostToolUseFailure`** release one wait of the same session, scope and tool:
  the exact fingerprint first, then a wait recorded without one, then — only for
  `AskUserQuestion`, `ExitPlanMode`, `Edit`, `Write` and `NotebookEdit`, whose permission UI
  rewrites the input before `PostToolUse` — the oldest wait of that tool. Other tools release by
  exact input only, because concurrency-safe tools such as `WebFetch` ask for permission in
  parallel and a sibling's completion must not release a wait still on screen. The exception is a
  `PostToolUse` whose own `tool_input` is unreadable (for example cut off by the 1 MiB bound): it
  releases the oldest wait of that tool, whatever the tool. Running is emitted
  only when no wait remains anywhere in the tab. `is_interrupt: true` is an ordinary failure:
  cancelling a running tool fires no hook at all, and the flag arrives only on abort-class tool
  errors where the turn continues.
- **`PostToolBatch`** fires once after a batch that was not aborted and before the next model
  call. It clears every wait of its session and scope — denials with feedback, decisions by other
  hooks, rewritten inputs, a `PermissionRequest` that arrived after its `PostToolUse` — and emits
  running when none remain.
- **`SubagentStop`**, which also fires for an interrupted subagent, clears that subagent's waits.
  If it removed any and none remain, it emits running when the session is active and
  `mast:idle done` when it is not.
- **Root `UserPromptSubmit`** follows one rule whatever triggered it — a typed prompt, a queued
  prompt folded in mid-turn, a cron, `/loop` or `ScheduleWakeup` wakeup, or a background
  task-notification, which the payload cannot tell apart. It clears its own session's root-scope
  waits and **every** other session's waits, keeps its own session's subagent waits, and marks the
  session active. A mid-turn fold happens only at a batch boundary after `PostToolBatch` and an
  idle drain only while the root is idle, so no root permission dialog can be open, but a
  subagent's can. Clearing other sessions keeps a wait left by a session ended with Ctrl+C from
  blocking the next session's running forever.
- **Root tool events** (`PermissionRequest`, `PostToolUse`, `PostToolUseFailure`,
  `PostToolBatch`) re-activate an inactive session: a turn continued by a blocking `Stop` hook has
  no `UserPromptSubmit`.
- **Root `Stop`** clears the session's root-scope waits and marks it inactive; subagent waits are
  left to `PostToolBatch` and `SubagentStop`.
- **`SessionStart`** with source `startup` or `resume` clears that session's waits and marks it
  inactive, without emitting: `claude --resume` and `--continue` keep the session id, and a process
  that died without `SubagentStop` (a WSL sleep, a kill) would otherwise leave subagent waits that
  root prompts deliberately keep. `clear`, `compact`, `fork` and unknown sources are ignored — a
  `/clear` gets a new id with nothing to clear and its hook is deferred, so it can land after the
  next prompt's `UserPromptSubmit` and undo that activation; `compact` happens while a subagent
  dialog may be open; `fork` gets a new id.

### 5. Codex: hooks plus a hold-off, and a judged legacy notify

**Hooks** are appended to `~/.codex/hooks.json`. Every handler is the same fixed, argument-less
command `"$HOME/.mast/bin/mast-codex-hook.sh"` with no `matcher` key (which matches everything),
so the script can change without re-trust. Matcher, timeout, `async` and command are all inputs
to Codex's trust hash, so this table is frozen from setup v16 on.

| Event | Mode | Timeout |
|---|---|---|
| `UserPromptSubmit` | sync | 5 s |
| `PreToolUse` | sync | 5 s |
| `PermissionRequest` | async | 10 s |
| `PostToolUse` | sync | 5 s |
| `SubagentStop` | sync | 5 s |
| `Stop` | sync | 5 s |
| `Interrupt` | sync | 3 s |

- **Gates** (no emission): `MAST_TAB` missing or not numeric; `CLAUDECODE` set (a Claude tab's Bash
  tool ran Codex); an empty or null `transcript_path` (a temporary thread), except on
  `SubagentStop`, whose path is the parent's and may be null; `CODEX_THREAD_ID` set and different
  from `session_id` (a Codex run from inside a Codex shell — the root process has no
  `CODEX_THREAD_ID`); a missing session or turn id (diagnostic); the `no-codex-hooks` marker.
- **State**: a root `{session, prompt seq and turn, end seq and turn, end body, last 8 ended turns
  with a handled flag}`, call records `{scope, turn, tool_use_id, fingerprint, seq, state
  open|candidate|emitted, summary, armed_at}` and the previous session id. The root is active while
  its prompt sequence exceeds its end sequence. An event with a different `session_id` starts
  fresh and keeps the old id as the previous session.
- **Fingerprints**: Bash is the tool name plus `command` — `PermissionRequest`'s `description` is
  excluded, since `PreToolUse` and `PostToolUse` have none — and a network approval pairs through
  the owning exec's command, its description feeding only the summary. `apply_patch` is
  normalized on both sides with Rust `trim` and `lines` semantics and Codex's lenient heredoc
  unwrapping, because `PermissionRequest` carries the parsed patch while `PreToolUse` and
  `PostToolUse` carry the model's text. MCP tools use the tool name plus canonical arguments, `{}`
  when empty. `write_stdin` and `request_permissions` approvals cannot be paired and only write a
  diagnostic.
- **Decision rule**, run after each change inside the same critical section: while any emitted
  record exists, re-emit `mast:needsInput` with the newest summary when the event changes the
  screen (a root prompt) or the last recorded emission is not a successful needs input, otherwise
  stay silent. With none, emit running when the root is active or the event is root-scoped; for a
  subagent event while the root has ended, emit `mast:idle <end body>` only when this event
  released an emitted record.
- **Sync `PreToolUse`** closes that scope's records from other turns — a thread runs one turn at a
  time — and adds an open record. A root call on the ended turn id resumes the root: a blocking
  `Stop` hook continued the turn without a prompt. The next `PreToolUse` is **never** taken as an
  approval release, because parallel sibling calls' `PreToolUse` arrives while a dialog is still
  open. Codex awaits a sync `PreToolUse` before the handler runs, so the record always precedes the
  same call's `PermissionRequest`.
- **Async `PermissionRequest`** carries neither `tool_use_id` nor whether a dialog was actually
  shown, and also fires for calls approved from the session cache, by automatic review or by
  pre-allowed patches. It does nothing under the `codex-needs-input-off` marker or when
  `approvals_reviewer = "auto_review"` (or its old alias `guardian_subagent`) appears at the top
  level of `~/.codex/config.toml`, since the review usually outlasts the hold-off. Otherwise, under
  the lock, it takes the newest record matching scope, turn and fingerprint in any state, and exits
  when there is none (the `PostToolUse` already happened), when it is emitted, or when it is a
  candidate whose sleeper is still alive (armed less than 6.2 s ago). It marks the record a
  candidate with `armed_at`, releases the lock, sleeps **2 s once**, and re-acquires the lock
  without creating files. If the record is still that candidate, it becomes emitted and
  `mast:needsInput <summary>` goes out in the same critical section — the Bash command's first
  line, `network access to <target>`, or the tool name. A candidate whose sleeper died is re-armed
  by the next request for the same call.
- **`PostToolUse`** releases its record by `tool_use_id` (a `write_stdin` poll reports under the
  original call id), or by fingerprint within the turn when the id is unreadable, then decides.
- **`SubagentStop`** is cleanup only. It fires when a subagent turn completes normally and closes
  that subagent's records — approved calls that then failed and never got `PostToolUse`, denials
  by hooks or review. It decides only when it closed something, so it can emit running or restore
  idle but never produces idle on its own.
- **Root `UserPromptSubmit`** is ignored when its turn id has already ended (a steer consumed
  late). Otherwise it activates the root, closes **root-scope records only** — queued-input
  auto-submit and steers fire it while a subagent's dialog is open — and decides, which re-asserts
  needs input or emits running. A subagent's `UserPromptSubmit` closes that subagent's other-turn
  records and decides if one was emitted.
- **`Stop`** ends the root with the first line of `last_assistant_message` as the body (`codex turn
  complete` when absent or blank), closes root-scope records, emits needs input if subagent
  records are still emitted and `mast:idle <body>` otherwise, and records the turn as handled when
  that emission succeeded. **`Interrupt`** does the same with the body `interrupted` and leaves
  subagents alone.

**Legacy `notify`** keeps its `config.toml` line and its resume-hint logic. `mast-codex-notify.sh`
now judges ownership from the saved transcript's first `session_meta`: `resumable` (source `cli`
or `exec`; writes the hint), `confirmed` (any other top-level source), `rejected` (a source object
with `subagent` or `internal`), or `unknown`. It exits before the hint and the emission when
`CLAUDECODE` is set or when `CODEX_THREAD_ID` is set and differs from the payload's thread id. It
hands the raw payload to `codex-notify` (passing `resumable` as `confirmed`) and falls back to
`mast-notify.sh mast:idle` only when the recorded interpreter is unusable or the dispatcher exits
non-zero — never for `rejected`. The dispatcher's judgement, first match wins: no `MAST_TAB` →
nothing; `no-codex-hooks` → idle without state; `CLAUDECODE` → nothing; `CODEX_THREAD_ID` differs
from the thread → nothing; then, under the lock, missing thread or turn ids → idle (fail-open).
When the thread is the current root session it is silent if the turn ended and was handled, if
the root is active on a different turn (a late arrival), if ownership is `rejected`, or while an
emitted record is pending, and emits idle otherwise. A thread that is the previous session is
silent — the event that switched sessions either started work or emitted its own idle. A
`rejected` thread is silent, an `unknown` one is silent while the root is active or a record is
emitted, and anything else emits idle. If the lock cannot be taken, it emits idle unless ownership
is `rejected` with both ids present. The body is the first line of `last-assistant-message`
(snake-case fallback).

### 6. Claude's Notification matcher is narrowed by self-migration

- The target matcher is `permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|quota_auto_resume_stale|worker_permission_prompt`.
  `idle_prompt` is out. `worker_permission_prompt` is not in Claude Code's documented list; it is
  the agent-teams permission request in the 2.1.270 bundle. Fixing the list in setup v16 avoids a
  second migration of the same user-owned value later.
- **Path migration runs first**: a `UserPromptSubmit`, `Notification` or `Stop` handler whose
  leading word is another copy of `mast-notify.sh` (the manual install path the contract document
  describes) is rewritten to the installed command, arguments kept. Wrapped or piped commands are
  left alone.
- **Narrowing** replaces the matcher only on a group that is dict-identical, after path migration,
  to what earlier setups wrote: `{"matcher": "", "hooks": [{"type": "command", "command":
  "\"$HOME/.mast/bin/mast-notify.sh\" mast:needsInput 'needs input'"}]}` — the quoted literal,
  not a resolved path, which would never match.
- A group already carrying the target matcher is reported and stays silent. Every other
  `mast-notify.sh` Notification group is kept; a notice asks for a manual edit only when its
  matcher matches everything (`""`, `"*"`, absent, or containing `idle_prompt`) **and** it sends
  `mast:needsInput`.
- A `PostToolUse` or `PostToolUseFailure` that already runs the user's own `mast-notify.sh` is
  respected: no dispatcher row is added there, and a notice says approvals are then unpaired.

### 7. Provisioning owns existence, the user owns content (setup v16)

- **Embedded files.** `mast-hooks-merge.py`, `mast-agent-hook.py`, `mast-claude-hook.sh`,
  `mast-codex-hook.sh` and `mast-agy-hook.sh` are tracked under `scripts/wsl/`, embedded with
  `include_str!`, and installed byte for byte on every setup version (`mast-config.py` moved into
  the same table). Compile-time checks require each placeholder to appear exactly once as a whole
  heredoc body, each file to end with a newline and contain neither its delimiter nor any
  placeholder, and no stray `@TOKEN@` to remain. CRLF is normalized after substitution, because
  `include_str!` does not normalize a Windows checkout.
- **Merge helper.** `mast-hooks-merge.py` has `claude`, `codex` and `agy` modes with separate
  ownership rules; only JSON reading and atomic writing are shared. It is Python 3.6 grammar and
  standard library, since it runs under whatever `python3` is on PATH. Provisioning runs it with
  stdin from `/dev/null` (the setup script's stdin is the script itself), appends its stdout — a
  machine-readable report ending in `result=…` — to `~/.mast/setup.log`, and forwards its stderr,
  which holds only actions for the user, both to the app (logged as "provisioning notice", visible
  only with the opt-in log) and to `setup.log`.
- **Writing rules.** A symlinked config file is resolved and its target updated, so dotfile links
  survive. A dangling link anywhere on the path → nothing created, a notice with the snippet to
  add by hand, exit 0. An unwritable target or directory (`EACCES`, `EPERM`, `EROFS`, `EBUSY`) →
  the same snippet notice, exit 0. Otherwise the result goes to `<name>.mast-tmp.<pid>` with the
  original mode and an fsync, the original bytes are re-read just before `os.replace` and the
  write is refused if they changed, and a run with nothing to do writes nothing. Empty or
  whitespace-only files count as absent; a JSON `null`, `NaN`/`Infinity`, or a number a JSON
  writer cannot reproduce is refused.
- **Exit codes.** 0 merged, nothing to do, or skipped; 1 could not merge, retried next launch; 2
  usage; 3 (`codex`, `agy`) the file's content makes a merge impossible. Exit 3 is deterministic, so
  the step is recorded as done and a notice names the file to edit, how to retry, and the opt-out
  marker. Claude content refusals stay exit 1 with no marker: Claude Code cannot read a broken
  `settings.json` either, so the user fixes it soon and the next launch wires it.
- **Codex.** `hooks.json`'s existence is mast's and its content the user's. A missing file is
  created as `{"hooks": {}}`. The file is validated against Codex's own serde definitions (top-level
  keys, event arrays of group objects, handler types `command`/`mcp_tool`/`prompt`/`agent`, field
  types, duplicated known fields): a file Codex would discard wholesale, or an array shape Codex
  reads positionally that mast cannot merge by event name, is left untouched with exit 3, except
  that an empty `hooks` array is normalized to an object. mast groups are **appended** at the end
  of each event array, so the existing `<source>:<event>:<group>:<handler>` trust keys do not move;
  user groups are never edited, and an event already running `mast-codex-hook.sh` is wired.
  `config.toml` is never written. Inline `[hooks]` event tables → `hooks.json` is not created and a
  notice points to the manual snippet (Codex warns every session when both hold hooks);
  `features.hooks` or `codex_hooks = false` (`hooks` wins when both exist) → notice; automatic
  review in the root table, the same lines the dispatcher reads → notice; an `enabled = false` `[hooks.state]` entry left at the index being appended —
  which trusting would not re-enable — → notice to remove it; the app-server control socket's
  presence is logged. The trust notice follows the installed version: the launch-time "Hooks need
  review" prompt (0.131.0 or later, or an unreadable version), `/hooks` (0.129.x–0.130.x), or none
  (before 0.129.0). `CODEX_HOME` is not honored; the step uses `~/.codex`, like the notify line.
  The step is skipped without a marker when `~/.codex` is absent or `python3` is missing, and with
  its sub-marker under `~/.mast/no-codex-hooks` or when the dispatcher's Python is older than 3.8.
- **Antigravity CLI.** The helper adds one named hook `"mast"` to `~/.gemini/config/hooks.json`
  (decision 8), creating the file when absent. `"mast"` identical to mast's definition → wired;
  identical plus `enabled: false` → the user's opt-out, silent; different → untouched, with a
  notice carrying the replacement; another named hook already running `mast-agy-hook.sh` → wired
  through that name. A duplicated `"mast"` key, or any named hook agy would reject — its parser
  drops the whole file when one hook fails validation — → exit 3. Validation follows agy 1.2.2's
  decoder: case-insensitive field names, last value wins, `null` counts as absent, `command` or
  `prompt` types, 32-bit timeouts. The step is skipped when `~/.gemini/antigravity-cli` is absent
  (no marker) or `~/.mast/no-agy-hooks` exists (sub-marker), and needs only the helper's Python.
- **Markers.** `.setup-v16` is the main marker; `.setup-v16-codex` and `.setup-v16-agy` record the
  agent steps. A launch exits at once only when the main marker exists and every present agent
  directory has its sub-marker. With the main marker present and the files the agent steps and
  their hooks run installed (`mast-hooks-merge.py`, `mast-agent-hook.py`, `mast-codex-hook.sh`,
  `mast-agy-hook.sh`, `mast-notify.sh`), a launch runs only the pending agent steps — so an agent installed after v16 gets its hooks without
  the full install re-adding a Codex notify line, `AGENTS.md` block or Claude rows the user removed.
  A missing hook file sends the launch through the full install. An agent step that fails on I/O
  no longer withholds the main marker; only its sub-marker is missing, so the next launch reruns
  that step alone. The exit-3 and agent-only Python notices therefore name the sub-marker
  (`rm ~/.mast/.setup-v16-codex`); removing the main marker reruns the full install.
- **Version gates.** No login or interactive shell is started: an interactive bash ignores
  `SIGTERM` past its timeout, stops on `SIGTTIN` when the caller has a terminal, and rc files can
  read stdin, start children that hold the output pipe, or have side effects. Instead a fixed
  candidate list is checked — the install shell's `command -v`, `~/.local/bin`, `~/.claude/local`
  (Claude only), `~/.volta/bin`, `~/.bun/bin`, `~/.npm-global/bin` and
  `~/.nvm/versions/node/*/bin` — deduplicated by resolved path, with `/mnt/*` logged and skipped
  (Windows installs do not read this distro's config). Each runs `--version` under
  `timeout -k 1 10 env PATH=<its directory>:$PATH`, output into a file, and the first `x.y.z`
  counts. The **lowest** version decides, since a tab may run any copy, and every notice names the
  copy's path. Claude Code: an unreadable candidate, a version before 2.1.101 (an unknown hook event
  name makes Claude Code ignore all of `settings.json`), or before 2.1.118 (no `PostToolBatch`)
  → status rows only, with a notice; no installation found → no limit. Guards only add rows and
  never remove dispatcher rows already present. Codex notices: before 0.124.0 hooks are off by
  default, before 0.129.0 there is no trust review, before 0.133.0 no `SubagentStop`, before
  0.148.0 async hooks are skipped (so no needs input), before 0.150.0 no `Interrupt`. Antigravity
  CLI before 1.1.10 never runs `Stop` hooks.
- **Python.** The existing `python3` gate is unchanged: on a full install a missing `python3` stops
  before the marker, and on an agent-only launch the step logs and retries, with one notice per
  launch — written to `setup.log` like every other notice — and no `python3` needed for an
  opted-out agent. `~/.mast/bin/mast-python` records the
  absolute, not link-resolved, path of `python3` when it is 3.8 or later; the entry points and
  `mast-codex-notify.sh` read it, so the hook environment's PATH does not matter. Older than 3.8 on
  a full install: the record is removed, Claude gets status rows only, Codex hooks are skipped, a
  notice asks for Python 3.8+, and the marker is still written. An agent-only Codex step re-resolves
  the interpreter and, if it is still too old, leaves an existing record in place for the Claude
  rows that use it.
- **Streaming.** The embedded files grew the script from about 60 KB to about 173 KB. With a
  marker present bash stops reading after a few lines, and the rest no longer fits the pipe buffer,
  so `run()` tolerates `BrokenPipe` while writing into `wsl.exe` and lets the exit status decide.
- **Tab close.** `host.rs::release_script` removes `agent-hooks/tab-<id>.json`, `.lock`, `.diag`
  and the `.json.tmp.*` / `.diag.tmp.*` leftovers in the same batched `rm` as the history and
  resume files (ADR-0013).

### 8. Antigravity CLI: running and idle, no needs input

- The named hook runs `"$HOME/.mast/bin/mast-agy-hook.sh"` with a 5 s timeout: `PreInvocation` with
  `running` (`mast:running` on every model call) and `Stop` with `idle` (`mast:idle` with the first
  line of `finalModelOutput`, control characters replaced and cut to 500 code points inside `jq`,
  or `done`). agy payloads have no event-name field, hence the argument.
- The script keeps the real stdout on fd 3 for exactly `{}\n` — agy parses handler stdout as a JSON
  object, and empty output is a parse failure — sends everything else to `/dev/null`, closes fd 3
  for children so a leftover descendant cannot stall agy, and ignores `SIGPIPE`. It keeps 1 MiB of
  stdin and drains the rest, returns without emitting when `MAST_TAB` is not a decimal number (the
  global hooks file also runs outside mast) or when `CLAUDECODE` or `CODEX_THREAD_ID` is set (agy
  started by another agent in the same tab), emits through `mast-notify.sh` with stdin from
  `/dev/null`, and always exits 0. It writes no resume hint.
- **No needs input.** agy's hook events have no `Notification` or `PermissionRequest` equivalent,
  so a tab waiting for a tool approval shows running. The one candidate signal,
  `tool_confirmation_pending` in the `statusLine` script input, is not used: `statusLine` is a
  single user-owned setting, and when it is re-invoked is unverified. `PreToolUse` is not used
  either: it must return a decision, and a failing hook denies the tool.

## Rejected alternatives

- **Workspace last-wins status and message** — another tab's `done` replaces a waiting card.
- **Preview from the smallest `TabId`** — the preview pins to an old message.
- **Wall-clock message recency, or `last_activity_ms` as the tie-break** — clocks move backwards
  on resume; activity moves on title and cwd changes.
- **A derived-consistency check in `validate()`** — older `state.json` files would load as corrupt.
- **Bumping `PERSIST_VERSION`** — serde defaults already load old files; a bump discards them.
- **Pairing ids in the core** — breaks the agent-agnostic core and token contract.
- **Suppressing toasts by tab visibility** — reports the same fact twice and changes an unrelated
  policy.
- **Ignoring Claude subagent `PostToolUse` entirely** — needs input sticks after a subagent
  approval.
- **Releasing needs input only at `Stop` or the next prompt** — reproduces defect 3.
- **Tool-name-only release for every tool** — a parallel sibling's completion releases a wait still
  on screen.
- **Treating `is_interrupt` as idle** — Esc during a running tool fires no hook, and a true flag
  arrives only where the turn continues.
- **A special case for task-notification prompts** — the payload cannot distinguish prompt
  sources; one rule based on when the hook fires covers them all.
- **Clearing on `SessionStart` with source `clear`** — the deferred hook can undo the activation of
  the prompt submitted right after it, and the new id has nothing to clear.
- **Taking the next `PreToolUse` as the approval release** — parallel siblings' `PreToolUse`
  arrives while the dialog is open.
- **Root events clearing every scope** — a queued prompt or steer would erase an open subagent
  dialog.
- **Sleeping inside a sync hook** — delays the dialog itself.
- **Emitting needs input immediately on `PermissionRequest`** — every auto-approved call toasts.
- **A 1 s hold-off** — more auto-approved calls outlast it and raise a false needs input.
- **A permanent cache of approved fingerprints** — misses a re-approval.
- **Async `PermissionRequest` without a sync `PreToolUse` record** — a request that starts after
  its call finished would resurrect needs input.
- **A detached child or daemon as the sleeper** — an always-on cost, and a process outliving its
  hook.
- **`O_NONBLOCK` emission** — `EAGAIN` or a partial write leaves an unterminated OSC that swallows
  agent output.
- **Emitting through a `mast-notify.sh` subprocess under the lock** — bash, jq and the tty walk can
  exceed 100 ms, and concurrent hooks then miss the lock and lose their transitions.
- **Codex `request_user_input` as needs input** — its `PreToolUse` fires before the mode check and
  has no `PostToolUse`, so the state would stick.
- **Codex `SubagentStop` as idle** — the root may still be working.
- **A script-side filter for `idle_prompt`** — unfiltered without jq, and a process per idle prompt.
- **Comparing the legacy Notification group against a resolved path** — never matches what earlier
  setups wrote.
- **Gating the Codex step on jq, or failing without `tomllib`** — neither is guaranteed (Ubuntu
  22.04's Python 3.10 has no `tomllib`), so those users would never get hooks.
- **Failing closed when `codex-notify` cannot judge** — a hookless Codex session would never show
  idle.
- **Probing agent versions through a login shell** — interactive bash stalls past its timeout and
  runs user rc files with side effects.
- **`statusLine` or `PreToolUse` for Antigravity needs input** — a user-owned single setting with
  unverified timing, and a fail-closed decision hook.

## Consequences

- Tabs no longer mask each other. A sibling's idle cannot hide a running agent, closing or exiting
  one tab leaves the others' state intact, and every tab that starts waiting gets its own badge and
  toast.
- A Claude approval returns the tab to running when the approved tool finishes rather than at the
  end of the turn, and `idle_prompt` no longer raises needs input. Codex tabs show all three states
  once the user trusts the hooks, and Antigravity CLI tabs show running and idle.
- **Cost.** Nothing polls and nothing stays resident. Claude pays one extra bash+Python start per
  tool call (`PostToolUse` or `PostToolUseFailure`), per batch, per permission request, per prompt
  and `Stop`, and per session start, resume, clear or compact. Codex pays a sync bash+Python
  start for `PreToolUse` and `PostToolUse` on every tool call and an async sleeper per approval
  request. Every token that reaches the core publishes a snapshot, even when the status is
  unchanged, because `last_activity_ms` moves; the 1.5 s running dedup limits that. Latency
  targets (sync handler p95 under 50 ms on WSL2, under 100 ms added per tool call) are field
  measurements, not yet taken.
- **User files.** The first v16 run re-serializes every Claude user's `settings.json` through
  `json.dump(indent=2)`, which can reformat it; the meaning changes only in appended groups,
  migrated paths and a dict-identical Notification group. The re-read before replace is not a full
  compare-and-swap against Claude Code's own writes.
- **Trust.** Installed Codex hooks do nothing until trusted; an untrusted install shows the review
  prompt on every Codex launch, and deleting or reordering groups ahead of mast's requires trusting
  again. The opt-out is `~/.mast/no-codex-hooks` plus removing mast's groups.

## Accepted limits

**Codex**

- An auto-approved call (session cache, pre-allowed patch) that runs longer than 2 s raises needs
  input, with a toast, until its `PostToolUse`.
- An approved real dialog keeps needs input until the call's `PostToolUse`, so a long command shows
  needs input while it runs. Approved within 2 s, a command still running at the end of the
  hold-off shows needs input **after** the approval.
- A denial that lets the turn go on fires no `PostToolUse`: needs input stays until `Stop`,
  `Interrupt` or the next root prompt, and for a subagent's call until that subagent's
  `SubagentStop`. Denied within 2 s, the needs input first appears after the denial.
- A command that outlives the model-chosen `yield_time_ms` gets its `PostToolUse` only when a
  `write_stdin` poll observes its exit; until then, or until the turn ends, the tab shows needs
  input.
- With automatic review configured, Codex approvals never raise needs input. Setup's notice and the
  dispatcher both detect only an `approvals_reviewer` line above the first table header;
  profiles and `-c` overrides are not seen.
- An approved call that then fails (an MCP `isError`, a handler error) gets no `PostToolUse`: a
  root call keeps needs input until `Stop`, `Interrupt` or the next root prompt, a subagent call
  until that subagent's `SubagentStop`.
- A `PreToolUse` hook from another integration that rewrites the input with `updatedInput` breaks
  the fingerprint, so that call never raises needs input.
- An aborted subagent approval (Esc, or "No, tell Codex …") ends the subagent turn without
  `SubagentStop` or `Interrupt`; its needs input remains until that subagent's next turn, in
  practice the end of the session.
- After a root Esc, a subagent that keeps running emits nothing on unpaired calls, so the tab
  reads idle while it works.
- During a `Stop`-hook continuation, a prompt carrying the ended turn id is ignored until the first
  `PreToolUse`.
- A needs-input write that fails is re-sent at the next sibling event; a lone approval with no
  sibling event has no recovery. A candidate stranded by a lock timeout is re-armed only if the
  same call's `PermissionRequest` comes again.
- Only one previous session is remembered: a late notify from two sessions back can still emit
  idle. If the event that switched sessions also failed to write, the display stays wrong.
- Unpairable approvals — `write_stdin`, `request_permissions`, the zsh-fork `Execve` path, an
  `apply_patch` heredoc intercepted by `exec_command` — never raise needs input.
- A turn error or `/review` can leave running behind.
- A Codex TUI attached to a shared app-server daemon runs hooks with the daemon's environment and
  terminal, so signals are missing or land on the tab that started the daemon.
- The trust notice follows the lowest installed version: with 0.128 and 0.154 both present no
  notice is printed, although 0.154 prompts on launch by itself. A Codex installed after v16 gets
  only `hooks.json`; its notify line and `AGENTS.md` block wait for the next setup version or
  `rm ~/.mast/.setup-v16`.

**Claude Code**

- A denial without feedback (No or Esc on the dialog) ends the turn as aborted: no `Stop` and no
  `PostToolBatch`. If `Notification` had already fired (about 6 s without input), needs input
  remains; a denial inside those 6 s leaves running. Either lasts until the next prompt.
- Esc while the model is streaming rather than running a tool fires no `Stop`, so running remains.
- An approved long-running tool shows needs input until it completes.
- If the main agent's `Stop` fires while a subagent's dialog is open, the status row's idle
  replaces needs input, and `Notification` does not fire again.
- Every root prompt — typed, folded mid-turn, a wakeup or a task-notification — also runs the
  status row's `mast:running`, which replaces a subagent dialog's needs input. The dispatcher keeps
  the wait but does not re-emit needs input.
- A `claude -p` run from the same tab's Bash tool is another session: its prompt clears the outer
  session's root and subagent waits.
- A `PreToolUse` hook that answers `allow` with `updatedInput` for `AskUserQuestion` or
  `ExitPlanMode` gives a call without a wait whose `PostToolUse` can release a parallel sibling's
  wait by name.
- A `PostToolUse` whose `tool_input` was cut off by the 1 MiB input bound releases the oldest wait
  of its tool by name, so for a concurrency-safe tool such as `WebFetch` it can release a parallel
  sibling's wait.
- Sandboxed network prompts fire no `PermissionRequest`, so nothing pairs with them: the next
  unrelated `PostToolUse` replaces their needs input. The dispatcher does not see the status rows'
  tokens, so its 1.5 s dedup can also hold back a running that would have corrected a status-row
  idle.
- A subagent wait missed by both `SubagentStop` and `PostToolBatch` (a lock timeout, a killed hook)
  is not cleared by root prompts; it blocks running until that subagent stops, another session's
  prompt arrives, or the session restarts or resumes.
- Turns that end without `Stop` (a blocked prompt, `StopFailure`) leave the session active. A
  background subagent that finishes after the main `Stop` without having waited leaves running
  until the next `Stop`.
- The in-session `/resume` picker also sends source `resume`; resuming the session that is running,
  while one of its subagent dialogs is open, would clear that wait (unverified).
- Claude Code before 2.1.118, or any copy whose version cannot be read, gets status rows only until
  it is updated and `rm ~/.mast/.setup-v16` is run.

**Antigravity CLI**

- No needs input; a tab waiting for approval shows running.
- Unverified: whether Esc cancellation fires `Stop` and with which `terminationReason`, what a
  `Stop` with `fullyIdle: false` during background work means, hook and terminal behaviour under
  `--dangerously-skip-permissions` and the remote-control or daemon paths, and hot reload of
  `hooks.json`. The helper's handler validation is inferred from the 1.2.2 binary.
- A differently named hook that runs `mast-agy-hook.sh` counts as wired even when disabled or
  covering only one event.

**Provisioning and lifecycle**

- Installs outside the candidate list (pnpm, mise or asdf shims, a custom npm prefix, Linuxbrew off
  the install shell's PATH) are not seen, so no version guard applies to them. A copy whose
  `node` lives elsewhere (a `~/.claude/local` wrapper or an `~/.npm-global` shim using an nvm-only
  node) reads as unversioned, which leaves Claude with status rows only.
- Without `python3` a full install stops at step 5 before the marker, so every launch reruns it and
  repeats the notice. Persistent failures in the Codex notify step (6) or the `AGENTS.md` step (6b),
  such as a `config.toml` that is not UTF-8, exit before the marker too, which reruns the full
  install every launch and never reaches the agent-hook steps. Both loops predate v16. A `python3`
  removed after v16 completes makes pending agent steps retry, with their notice, every launch.
- In rare permission states — an unwritable `setup.log`, a blocked `mast-python.tmp` — bash's own
  error lines reach the notices ahead of mast's message.
- A synchronous hook that lands after the tab-close `rm` can recreate the tab's lock (and state or
  diagnostic) files; nothing sweeps those orphans.
- A needs-input followed by idle inside the same 100 ms coalescing window loses its onset
  (ADR-0006 decision 1).
- `setup_script()`'s Rust assembly is tested only on the Windows CI job; Linux tests run the same
  substitution through the TypeScript copy in `apps/mast/tests/setup-script.ts`.

## Verification

Automated, on the Linux gates:

- `cargo test -p mast-core`: per-tab derivation, message recency and ties, every clearing path,
  one revision per batch, the legacy-file load (`legacy_state_without_tab_agent_fields_loads`),
  sanitize, and the fixture consistency check.
- `apps/mast` vitest: per-tab onset, one toast per tab with the tab's own body and label, and badge
  patching with node identity (`chime.test.ts`, `tab-strip-model.test.ts`, `pane-view.test.ts`);
  `tests/agent-hooks.test.ts`, which runs the real dispatcher through a real pty in a temporary
  HOME with race order forced by lock holds and a full terminal buffer;
  `tests/provision-hooks.test.ts` for the merge helper in all three modes and `mast-agy-hook.sh`; Linux-only
  `tests/provision-setup.test.ts`, which runs the assembled setup script in a temporary HOME with
  stub agents; `tests/codex-resume.test.ts` (Linux-only) for ownership and fallback;
  `tests/hook-example.test.ts`; and Linux-only `tests/release-script.test.ts` for the tab-close
  `rm`.
- Python floors: the dispatcher is checked with `ast.parse(feature_version=(3, 8))`, and a Python
  3.8.20 smoke run through a pty and real merges in all three modes passed on the dev box. No Python
  3.6 interpreter was run; the helper's 3.6 floor is checked only by
  `ast.parse(feature_version=(3, 6))`, which Python 3.13 and later narrow to 3.7.
- Not run on these gates: the Windows-only unit tests (`host.rs` release script, `provision.rs`
  `setup_script()` assembly), and everything through a real `wsl.exe` relay.

Field: WINDOWS-BUILD §10 v0.3.32 — upgrade from v13, Codex trust, two tabs and two panes, Claude
approvals, denials and background subagents, Codex transitions, auto-approval and denial timings,
Antigravity CLI turns, lifecycle cleanup, and cost and terminal-artifact measurements. **Not yet
run**; no item is recorded as passed.
