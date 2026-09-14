# mast OSC contract — Claude Code hook / shell prompt

This is the **contract document** that implements the path described in 계획 v2 section 9
("에이전트 상태 및 알림"). It defines the meaning of the OSC sequences mast interprets
(fixed in stage 18) and shows, as examples, the Claude Code hook and shell prompt halves.

```
Claude Code hook (UserPromptSubmit / Notification / Stop)
  → writes OSC 777 to the resolved TTY (/dev/tty, or an ancestor process's pts)
  → the Rust PTY reader (mast-core::osc::OscScanner) detects it
  → batched over a 100ms flush window (glue OscRouter)
  → updates the tab unread dot / pane badge / workspace sidebar status
```

v1 uses the PTY output itself (OSC sequences) as the delivery path, with no IPC server,
named pipe, or Windows helper CLI.

## Automatic provisioning

**mast auto-provisions this on first run per distro (`~/.mast/.setup-v13`); this
document remains the contract and the manual path.**

On launch the app streams a setup script into `wsl.exe [-d <distro>] -- bash -s` for every
distro it knows about (each workspace's, plus the WSL default) — stdin, so no Windows-side
guess at the WSL home path and no dependency on a distro's `interop`/`automount` settings.
Once per distro it:

- installs the script below at `~/.mast/bin/mast-notify.sh` (executable),
- installs `~/.mast/bin/mast-codex-notify.sh` (executable) — the Codex half, described
  under [Resume hint](#resume-hint--mastresumetab-id) below. It exists separately because
  Codex hands its payload over as a final **argv** argument rather than on stdin, and it
  delegates the OSC write back to `mast-notify.sh` rather than repeating it,
- installs the **`mast` CLI** at `~/.mast/bin/mast` (executable) — the command-line
  half of the send and query channels below (`mast ls` / `mast send` / `mast id`), so
  nothing has to assemble an escape sequence or repeat the tty resolution by hand. Every
  mast terminal has `~/.mast/bin` prepended to `PATH`
  (`apps/mast/src-tauri/src/host.rs::bash_argv`), so inside a tab it is just `mast`,
- installs `~/.mast/bin/mast-config.py`, the standard-library Python helper for `mast config`.
  Unlike send/query, config does **not** emit OSC: it resolves and edits the Windows settings
  file directly, requiring Windows interop and drive access when invoked (not when installed).
  Commands, validation and restart semantics are in [`docs/SETTINGS.md`](../../docs/SETTINGS.md),
- replaces the old `~/.mast/bin/mast-send.sh` (setup v3) with a two-line wrapper that
  execs `mast send "$@"`, so anything still pointing at that path keeps working,
- installs the `mast-send` skill at `~/.claude/skills/mast-send/SKILL.md` (the agent
  send and query channels below; source: `scripts/wsl/skills/mast-send/SKILL.md`),
- merges the three hooks into `~/.claude/settings.json`, keeping every existing value (see
  the migration rules below),
- adds a `notify` key to `~/.codex/config.toml` if that file exists and has no `notify` of
  its own (Codex runs it once per completed turn, which maps to `mast:idle`); a missing
  file means Codex is not installed there and nothing is created, and when `~/.codex/`
  exists, a managed `mast integration` block in `~/.codex/AGENTS.md` teaches Codex the CLI
  and to run it outside the sandbox (delete the block to opt out). An **existing** `notify`
  is the user's own integration and stays — with the one exception in the table below,
- records what it did in `~/.mast/setup.log`, then writes the marker.

The hook merge treats each of the three events on its own, and never touches a hook that is
not one of ours:

| Existing hook for the event | Result | Logged as |
|---|---|---|
| Runs `~/.mast/bin/mast-notify.sh` (however it is spelled — `$HOME`, `~`, absolute) | Left exactly as it is, custom arguments included | `already wired` |
| Runs a `mast-notify.sh` from **another** path (a hand-wired `~/.claude/hooks/…`, an older install) | The **path** is rewritten to `"$HOME/.mast/bin/mast-notify.sh"`; the arguments after it stay byte-for-byte | `migrated` |
| Mentions `mast-notify.sh` somewhere other than the leading word (`bash ~/…/mast-notify.sh …`) | Left alone — rewriting that shape would be guesswork, and it already covers the event | `left untouched` |
| None | A new entry is appended | `added` |

Migration exists because a hand-wired hook points at an older copy of *this* contract, which
goes stale as the script below changes (the tty fallback, the stdin JSON body). Nothing is
ever duplicated: an event that has any `mast-notify.sh` hook never gets a second one.

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

Any failure leaves the marker unwritten, so the next launch retries. A distro without
`python3` gets the notify script but no hook merge (the merge has to preserve an existing
`settings.json`, which rules out text munging) — install `python3` or wire it by hand.

The installer lives in `apps/mast/src-tauri/src/provision.rs`, and the copies it embeds
are **byte-identical** to their sources — the "Example hook script" below and
`scripts/wsl/skills/mast-send/SKILL.md`: change both halves together.

## OSC meaning contract

mast interprets four kinds of sequences.

| Sequence | Meaning | Status (`agentStatus`) | Unread dot |
|---|---|---|---|
| `OSC 777;notify;mast:running;<body>` | Agent work started | `running` | no |
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
- If `body` is non-empty it is kept as the sidebar preview (`lastAgentMessage`). **An empty
  body does not clear a previously received message** — firing `running` with no body
  leaves the preceding needsInput text in place. Messages are truncated at 500 characters.
- `running` is a progress signal, so it does not raise a dot. Only `needsInput`, `idle`,
  and status-neutral notifications set unread.
- **A tab that is on screen does not set unread** (active workspace + that pane's active
  tab), because its content is already in front of the user.
- Waiting for input wins: while some tab is at `needsInput`, `running`/`idle` from a
  **different** tab cannot override the workspace status. Only the tab that raised it can
  demote it (once the user responds, that tab's `UserPromptSubmit` → `running` demotes it
  naturally).
- The semicolon (`;`) is the field separator. If one appears inside title/body the parser
  mis-splits the fields, so the emitting side substitutes it.
- A restart resets all notifications and statuses (a dead session's needsInput does not
  survive a restart — 계획 v2 section 11).
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

**Claude Code itself consumes a hook's stdout** (it is processed as the hook's result and
used for UI/logs or discarded; the bytes do not flow through to the terminal screen). If a
hook script simply writes the OSC sequence to standard output with `echo` or `printf`,
those bytes never reach the real PTY stream and the Rust PTY reader detects nothing.

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
Claude session is worse than missing one notification. The depth limit of 8 and the
`/dev/pts/*` whitelist are the boundaries that keep this search from dragging on or leaking
OSC bytes into the wrong target (a log file, a pipe).

(The shell prompt snippet below is unaffected by this problem — a shell has its own tty and
its stdout *is* the PTY, so neither a redirect nor a fallback is needed.)

## Example hook script

`~/.claude/hooks/mast-notify.sh` (must be made executable: `chmod +x`) — auto-provisioning
installs this same text at `~/.mast/bin/mast-notify.sh` instead, and migrates a hook
still pointing at the manual path onto that copy (see the table above), so the block below is
the canonical source for the copy embedded in `apps/mast/src-tauri/src/provision.rs`
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

Maps the three events to the three status tokens:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/mast-notify.sh mast:running"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/mast-notify.sh mast:needsInput 'needs input'"
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
            "command": "~/.claude/hooks/mast-notify.sh mast:idle done"
          }
        ]
      }
    ]
  }
}
```

- `UserPromptSubmit`: right after the user submits a prompt — "work started" (`running`).
  It passes no body, so the preceding preview text stays as it is.
- `Notification`: when user input is needed, e.g. a permission confirmation — the stdin
  JSON's `.message` carries the actual text (e.g. "Claude needs your permission to use Bash").
- `Stop`: when Claude Code finishes its response and returns to waiting — "work done"
  (`idle`).

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

## Resume hint — `~/.mast/resume/tab-<id>`

A restart respawns every terminal tab as a **fresh login shell**: the layout comes back, but
the agent session that was running in the tab does not, and its id is nowhere on screen. Both
agents hand mast an id when they report a turn — Claude Code's hook stdin JSON carries
`.session_id`, Codex's notify payload carries `thread-id` — so each records it per tab and the
next shell in that tab offers it back.

**This is a hint, never an action.** The recorded command is put in front of the user in two
places and run by neither of them.

| Field | Contract |
|---|---|
| Path | `~/.mast/resume/tab-<id>`, where `<id>` is the writer's `MAST_TAB` — the tab's stable id, which survives a restart, so the file and the tab that gets the hint are the same tab. |
| Line 1 | The resume command: `claude --resume 11111111-2222-3333-4444-555555555555` or `codex resume 019ff5e6-d08e-7013-9cec-105030994d8d`. The reader takes **only this line**. |
| Line 2 | Epoch seconds at the time of writing. Recorded for diagnosis; **nothing reads it** — see freshness below. |
| Written when | An invocation has both a non-empty `MAST_TAB` and an id matching `^[A-Za-z0-9_-]+$` — Claude Code's `.session_id`, Codex's `thread-id` (`thread_id` is accepted too). Codex additionally requires matching saved top-level session metadata, as described below. |
| Not written when | The tab has no `MAST_TAB` (a tab without per-tab history), `jq` is missing, the payload does not parse or carries no id, or the id is not a plain token. For Codex, also when saved top-level metadata cannot be confirmed, including temporary threads and subagents. For Claude Code, also when stdin is a TTY (the script run by hand, so no JSON is read at all). |
| Atomicity | Written to `<path>.tmp.<pid>` and `mv`d into place, so a concurrent reader sees either the old file or the new one, never a half-written line. The pid suffix keeps two writers firing at once in the same tab from sharing a temp name. |
| Failure | Swallowed. Every step is guarded and the writer still exits 0 — a resume hint must never cost a notification, let alone the session. |

**Both agents write the same file, and the last eligible session to finish a turn in that tab wins.** That
is the intended behavior, not a collision to be designed away: a tab where you switched from
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
only two exact forms — `claude --resume <token>` and `codex resume <token>`, where `<token>`
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
to check by hand. Nothing prunes these files, exactly as nothing prunes `~/.mast/history`.

### The Codex half — `mast-codex-notify.sh`

Codex's `notify` program is run once per completed turn (`agent-turn-complete`, the only
event there is) and receives the payload as a single JSON object appended as the **final argv
element** — not on stdin. `~/.mast/bin/mast-codex-notify.sh` is that program; its source
is the `provision.rs` heredoc, and this section is its contract. Given `$1`:

1. **Reads two fields, defensively.** `thread-id` and `last-assistant-message`, falling back
   to `thread_id` / `last_assistant_message` (the payload has been serialized both kebab- and
   snake-cased across releases; `codex-cli 0.147` is kebab). Neither is required.
2. **Records the resume hint** — `codex resume <thread-id>` in the file described above, when
   `MAST_TAB` is set, the id is a plain token, and saved metadata confirms a top-level session.
   `codex resume <id>` is the same form Codex prints as its own post-exit hint.
3. **Emits `mast:idle`** by running `mast-notify.sh` as a child with stdin closed, so the
   tty resolution and the `;` substitution have exactly one implementation. The body is the
   **first line** of the agent's closing message, control characters replaced with spaces and
   capped at 500 characters; with no message it reads `codex turn complete`.

Steps 1 and 2 are best-effort and step 3 is not: a missing `jq`, an unparseable payload, or a
payload with neither field still produces the notification, just a generic one and no hint.
The program exits 0 whatever happens — Codex should never report a failing `notify`.

**Saved-session check (setup v12).** Codex 0.154.0 also invokes legacy `notify` for temporary
catch-up summaries, whose ids cannot be resumed. The notification's documented fields do not
distinguish these threads. The writer therefore checks
`${CODEX_HOME:-$HOME/.codex}/sessions/*/*/*/rollout-*-<id>.jsonl`: its first record must have
`type: "session_meta"`, the exact `payload.id`, and `payload.source: "cli"` or `"exec"`.
Object-valued subagent sources, including guardian and `thread_spawn`, are not eligible.
Only the first record is read, capped at 1 MiB; the entire check has a two-second deadline
with a one-second forced-kill grace period (`timeout` from Ubuntu's coreutils).

This is a compatibility check against observed local transcripts, **not a stable Codex API**.
Missing, malformed, oversized, unreadable, archived, or differently stored metadata leaves
the existing hint untouched, as does a missing `timeout`. It never guesses another thread
from cwd, queries a private SQLite schema, or starts Codex to resolve an id. The idle
notification still goes out. Custom `CODEX_HOME` is used to locate metadata; the offered
command retains the existing contract and assumes the same Codex environment at restart.
See [OpenAI's notify contract](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)
and [its transcript-format caveat](https://learn.chatgpt.com/docs/hooks#common-input-fields).

The change prevents future overwrites; it does not repair a hint already poisoned before
installation. Complete one turn in the intended session after setup v12, then restart.
The Linux regression `apps/mast/tests/codex-resume.test.ts` executes the installed-script
heredoc and the actual spawn-wrapper history path with isolated fixture homes.

The control-character scrub in step 3 is load-bearing, not hygiene: unlike Claude Code's
`.message`, which is a canned string, `last-assistant-message` is **model output**, and it is
on its way into an escape sequence written to a terminal. An embedded BEL would end the OSC
early and hand whatever followed to the terminal as input.

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
2. Then run Claude Code inside a mast terminal and confirm that the three hooks actually
   update the tab dot, pane badge, and sidebar status/preview
   (`docs/WINDOWS-BUILD.md` section 10, checkpoint 2).
3. If the hook is silent, start by looking at where the fallback broke. Inside a mast
   terminal, reproduce a tty-less context with
   `setsid -w bash -c 'printf "" > /dev/tty' ; echo $?`, and check whether the main Claude
   process is attached to `/dev/pts/*` with
   `for p in $(pgrep -f 'claude'); do readlink /proc/$p/fd/1; done`. Check as well that the
   ancestor chain is within 8 hops.

## Notes

- BEL (`\007`) is not relied on as the only completion signal (계획 v2 section 9) — mast's
  `OscScanner` recognizes both BEL and ST (`ESC \`) as terminators.
- "The hook has no controlling TTY" is a **fact measured on Claude Code 2.1.226**, not a
  guaranteed contract. That is exactly why the example script keeps step 1 — if a later
  version hands the hook a tty, it works as is without taking the fallback. Conversely, if
  Claude Code comes to run somewhere that is not a pts (a pipe-only daemon, say), step 2
  will not find a target either, and at that point we have to move to the file/socket
  watching alternative.
- If ConPTY turns out to swallow OSC 777 (spike-plan.md section 6, checklist item 1), this
  hook path has to be replaced with the file/socket watching alternative (see 계획 v2
  section 2, "단일 실패점"). The examples in this document rest on the premise that OSC
  passthrough is alive. Real-world passthrough of OSC 0/7 is still unverified, and its
  failure would be independent of the notification path (777/9).
