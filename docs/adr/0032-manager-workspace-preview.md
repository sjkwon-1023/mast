# ADR-0032: A pinned manager workspace with summarized cross-workspace task memory (preview)

- Status: accepted (preview)
- Date: 2026-09-25
- Verification: automated gates on macOS only so far (`cargo test -p mast-core`, `cargo check` /
  `cargo test -p mast-app` against the recorded warning and failure baselines, the
  `scripts/wsl/tests` and `scripts/macos/tests` Python suites, frontend build and vitest against
  the known node-26 `localStorage` failures); CI (`gates`, `windows-gates`) is the first
  Windows/Linux compile and is checked on the merge request, not here. The manual field checks
  M1–M10 (lists in `docs/MACOS.md` and `docs/WINDOWS-BUILD.md`) are **not run** — nothing below is
  a field-verification claim, and Windows behavior is unverified.

## Context

Working in several workspaces at once costs a context switch on every visit: re-establishing the
goal, what is in progress, which decisions were made and which questions wait for an answer. Mast
already carries per-tab agent status (ADR-0026), but nothing remembers a workspace's work, and
nothing lists waiting work across workspaces.

The product principles bound the answer: idle cost near zero, bounded structures, no always-on
service whose cost scales with the number of workspaces, and no pane/screen reading without an
opt-in design (CLAUDE.md "Product principles", backlog). The preview is therefore opt-in
(`manager.enabled`), all LLM work is debounced per workspace, the event log is a bounded ring, and
the board reads summarized task JSON instead of panes.

## Decisions

### 1. The manager workspace is a pinned core object

- `Workspace.manager: bool` (`crates/mast-core/src/model.rs`) is `#[serde(default)]` and always
  serialized, so old state files read as `false` and every snapshot carries the flag. The TS mirror
  (`apps/mast/src/shared/types.ts`) makes `manager` a required boolean.
- `TabKind::ManagerBoard` is a fieldless tag (`{"type":"managerBoard"}`). It is excluded from
  `NewTab` (no `CreateTab`/`SplitPane` can make one), added to `persist::is_known_tab_kind`, and
  reported by `list_tabs` as kind `managerBoard`, status `viewer`.
- `Command::CreateManagerWorkspace { root_path, distro }` and `RemoveManagerWorkspace`
  (`crates/mast-core/src/command/mutations.rs`) create and tear down the one manager workspace.
  Creation appends `{name: "Manager", manager: true}` at the end, opens one pane with a terminal
  (cwd = root_path) and the board tab (active), and leaves `active_workspace` alone.
  `CommandError::ManagerExists` guards the single instance; `InvalidPath` reuses the
  `CreateWorkspace` path rules.
- The workspace is **pinned**: `CloseWorkspace` on it, `MoveWorkspace` with it as the target or as
  `before`, and `CloseTab`/`ClosePane` of the board are refused with
  `CommandError::ManagerPinned` ("the manager workspace and its board are pinned") while state and
  revision stay unchanged. Only `RemoveManagerWorkspace` removes it; renaming, creating tabs and
  splitting inside it stay allowed.
- The front end pins the card above the New workspace button regardless of vector position, keeps
  it out of drag/drop and `Ctrl+1–9` (`features/workspace/sidebar-model.ts`, `sidebar.ts`,
  `app/navigation/actions.ts`), and hides the board tab's close button (`pane-view.ts`).

### 2. Agent session metadata arrives on its own `mast-agent` OSC

- `scripts/wsl/mast-agent-hook.py` writes `ESC]777;mast-agent;<base64 JSON>BEL` next to the status
  token. JSON is `{"v":1,"agent":"claude"|"codex","session":"<id>","transcript":"<abs path>"}`.
- The core parses it in `crates/mast-core/src/osc.rs` (`parse_agent_session`) and rejects the whole
  payload unless it is ≤ 8 KiB decoded, `v == 1`, `agent` is known, `session` uses the allowed
  charset (1–128 chars), and `transcript` is an absolute Linux path ≤ 4096 bytes. Valid payloads
  are last-wins into `Tab.agent_session` (`#[serde(skip)]`, so snapshots and persistence do not
  change) and are cleared by `clear_tab_agent` when a shell exits or respawns.
- Claude emits at root-scope `SessionStart`/`UserPromptSubmit`/`Stop` **before** the
  `claude-pairing-off` gate; Codex emits at `UserPromptSubmit`/`Stop` only after its existing
  transcript and `CODEX_THREAD_ID` gates, and only when the payload has a `session_id` and a
  non-empty `transcript_path`. Without `MAST_TAB` nothing is written.
- Compatibility is deliberately one-sided: an old core drops the unknown 777 kind, and an old
  dispatcher simply leaves tabs without metadata (shown as `no_transcript`). `session.rs`'s OSC
  summary string is `"777-agent"` and carries neither path nor id.

### 3. The core keeps a bounded event ring and answers read-only manager queries

- `Dispatcher::set_manager_events(bool)` (`crates/mast-core/src/command.rs`) is off by default and
  the glue turns it on only while the preview is enabled — idle cost stays zero otherwise.
- The ring holds `MANAGER_EVENT_CAPACITY` = 1024 events in `crates/mast-core/src/manager.rs`;
  `seq` is a process-local counter and is not persisted. Events from the manager workspace are not
  recorded. Recorded kinds: `workspaceOpened`, `workspaceClosed`, `status` (only when a tab's
  `agent_status` actually changes), `session` (when `agent_session` changes), `tabGone`.
- A batch that changes only `agent_session` records a `session` event without a state change;
  `router.rs` compares `Dispatcher::manager_next_seq()` around the batch and wakes the harness
  writer when the ring advanced even though no snapshot was published, so metadata-only OSCs do
  not wait for the next state publication.
- `command/queries.rs::events_since` returns `{events, nextSeq, gap}`; `gap` is true when the
  requested `since` was evicted or is ahead of the ring (after a restart). `overview()` lists every
  workspace with per-tab kind/status strings shared with `list_tabs`, plus `agentSession`.
- `manager_query(requester_session, request)` accepts only `{"op":"workspaces"}` and
  `{"op":"events","since":N}` (≤ 4 KiB). It succeeds only when the requester's tab belongs to a
  `manager == true` workspace; anything else is `Forbidden` (unknown session, normal workspace, no
  manager workspace). Invalid input is `InvalidParams` and oversized replies `too_large`
  (≤ 4 MiB). The transport is the existing OSC query path with a private `/tmp` reply file
  (`apps/mast/src-tauri/src/sink.rs`), so no port is opened.
- The query is **read-only** and is not a security boundary: it exposes workspace metadata and
  events, never pane output or input. `list_tabs` and `resolve_send_target` keep the ADR-0005
  confinement unchanged, including for manager tabs.

### 4. The harness is an app-owned process on a stdio JSONL protocol

- The harness is not a PTY tab and cannot emit OSC (it has no terminal), so the same core query
  results reach it over pipes. `crates/mast-core/src/manager.rs` defines the messages:
  app → harness `hello`, `snapshot`, `events`, `action`; harness → app `status`, `board`,
  `notify`. One UTF-8 JSON object per line, ≤ 4 MiB, unknown `type`s are logged and ignored
  (`HARNESS_PROTOCOL` = 1).
- `apps/mast/src-tauri/src/manager/harness.rs` spawns it — Windows through
  `wsl.exe [-d] --cd ~ --exec /bin/sh -c '<launcher>'` (the launcher reads
  `~/.mast/bin/mast-python`, exit 4 when missing), macOS through `mast-python -I` on the installed
  script — and owns the stdin writer, the stdout parser, and the last 4 KiB of stderr.
- `apps/mast/src-tauri/src/manager/supervisor.rs` interprets exit codes: 0 is a clean stdin EOF,
  3 is `unsupported` (codex missing/protocol mismatch — no restart), 4 is unprovisioned, anything
  else restarts with 1→2→4…60 s backoff that resets after 300 s of healthy runtime. Shutdown
  closes stdin, waits 2 s, then kills the process group; the child is watched with a 200 ms poll
  (`EXIT_POLL`) instead of 20 ms, which lowers the idle waiter cost without changing the 2 s
  contract. `manager.rs::wake` is called from `state.rs::publish_state`, so events reach the
  writer without polling the core.
- Startup takes `PATH` and `CODEX_HOME` from `$SHELL -lc` marker lines (`__MAST_PATH__`,
  `__MAST_CODEX_HOME__`) written with syntax that both POSIX shells and fish accept (a
  space-joined fish `PATH` is normalized to colons), so profile stdout noise cannot corrupt
  them; the codex path is then resolved by `/bin/sh -c 'command -v codex'` under that `PATH`.
  Every probe child (`$SHELL -lc`, `/bin/sh`, `codex --version`, `git`) runs with
  `stdin=DEVNULL` so it cannot consume the app→harness protocol pipe. A non-empty `CODEX_HOME`
  from the login shell becomes the transcript-allowed root and is passed to the summary child
  environment.
- Sessions announced by events are remembered per workspace (≤ 32, oldest dropped, cleared on
  `workspaceClosed`, and dropped together with cursor entries that `prune_cursor` removes), so a
  pruned session is not re-read from its tail on every pass. The session of a tab reported by
  `tabGone` is moved into this set before the tab is cleared (the core sends `tabGone` for every
  terminal tab before `workspaceClosed`), so the final pass on close — and the immediate pass
  after a single tab exits or respawns — still collects a session that was known only from a
  snapshot; these entries share the same cap of 32.
- The harness keeps a mutable overview: `status`/`session` events add the tab when the snapshot
  did not know it, `workspaceOpened` adds or refreshes the workspace, and `tabGone` clears the
  tab's session and status but keeps the tab (respawn also emits `tabGone`). The workspace
  `agentStatus` is recomputed from its tabs on every such event (needsInput > running > idle)
  instead of being overwritten with the latest event's tab status, so notify suppression reads
  the live aggregate.
- Each unit of the main loop is isolated: stdin messages, collection, summary finishing, archive
  adjustment and board generation catch exceptions, log the type and message, report a failed
  status where relevant and keep the process alive; only stdin EOF ends it.
- The front end consumes `get_manager_board` / `manager_action` and the `manager-board` /
  `manager-notify` events; status states are `disabled`, `starting`, `ok`, `busy`, `failed`,
  `unsupported`, `restarting`.

### 5. Task memory is per-workspace JSON, written only by deterministic code

- `scripts/wsl/mast-manager-harness.py` collects utterances and calls `codex exec`; the resulting
  patch is validated and merged by `scripts/wsl/mast-manager.py`. Those two, plus the
  `mast manager patch` CLI path, are the only writers of `~/.mast/manager/tasks/<key>.json`, all
  under `.mast/store.lock` (`flock`) and an atomic `os.replace`. The LLM never edits a file.
- The key is `"k" + sha256(distro + "\0" + root_path)[:20]`; `root_path` is the workspace's
  identity, so two workspaces with the same path and distro intentionally share one task.
- Task memory is bounded: inactive items cap at 30 each in `open_questions` and `next`,
  `removed` plans at 10, `meta.cursor` sessions at 32 (the session that has gone longest without
  new bytes goes first; `updated` moves only when a pass reads new bytes), and archives at
  5 per key. Pruning appends `questions_pruned`, `next_pruned`, `plans_pruned` or
  `cursor_pruned` to `meta.limits`, and `validate_task` refuses a document already above a cap.
- The schema (v1) keeps `meta{schema_version, workspace_key{root_path, distro}, status,
  created_at, updated_at, last_collected_at, model, effort, cursor{session → {agent,
  transcript_path, offset, line, updated, tab, pending_plan_ids?, pending_questions?}}, next_id,
  last_error, limits, rejected_ops}` and
  the body `title, headline, progress{text, reported_done, verified_done}, open_questions[],
  decisions[], next[], plans[], git{branch}`. Items carry a required `anchor` (agent, session, tab,
  line range, message id), a `quote`, a `by` (`user`/`ai` for decisions) and a status
  (`active|resolved|superseded`), so a wrong entry can be corrected with evidence instead of
  overwritten. Reported done and verified done are separate flags.
- `meta.cursor` advances only after a merge succeeds; a failure sets `meta.last_error`, sends
  status `failed` and leaves the last good summary on the board, marked stale. A failure that
  keeps the cursor is any error or a response rejected as a whole (`verdict:"no_change"` with
  ops, or `notify:"report"` without a reason): cursor and `last_collected_at` stay unchanged and
  no notify is sent. A patch whose every op was rejected is reported as a failure but advances
  the cursor (see §7). `meta.model` and `meta.effort` record the summary call so
  quality problems can be traced.
- `plans[]` detects `docs/plans/*.md` files changed since the merge-base with the default branch
  plus untracked files, summarizes only when the hash changes, and marks a deleted file `removed`
  so the board disables its link; the original file can be opened in a Markdown viewer tab.

### 6. Extraction keeps decisions and questions, drops tool noise

- Kept: user and assistant text; Claude `AskUserQuestion` questions and `toolUseResult.answers`;
  `ExitPlanMode` proposal, approval and rejection; Codex `request_user_input` questions and
  answers. Dropped: shell and file tool inputs/outputs, subagent sidechains, and system/meta lines.
- A question and its answer often land in different deltas (needsInput triggers a pass before
  the user answers). The cursor therefore carries `pending_plan_ids` (open `ExitPlanMode` ids,
  ≤ 8) and `pending_questions` (open Codex `request_user_input` call ids → {question id → text},
  ≤ 8 questions in total), so
  the next pass still recognizes a plan approval/rejection and labels an answer with its question.
- Fixtures (`scripts/wsl/tests/fixtures/manager/claude-session.jsonl`,
  `claude-plan-approved.jsonl`, `claude-tool-rejected.jsonl`, `codex-request-input.jsonl`) pin the
  JSONL shapes; `scripts/wsl/tests/test_manager_extract.py` covers the keep/drop rules.
- A session seen for the first time starts at the last 64 KiB of its transcript on a line
  boundary; an incomplete trailing line waits for the next pass; an offset beyond the file size
  restarts at the tail and logs it. One delta pass reads at most 4 MiB (`MAX_DELTA_BYTES`): it
  stops at the last complete line in the window, advances the cursor there and re-schedules
  immediately while `more` is set — only after a successful pass, so a failing summary cannot
  loop. A single complete line longer than the window (an inlined image, a huge tool result) is
  skipped to its newline and logged by size, instead of stalling the cursor. The cursor's `line`
  (newline count before `offset`) lets the
  next pass number lines without rescanning the file from the start. Transcripts are accepted
  only when they are regular `.jsonl` files owned by the user under `~/.claude/projects/` or
  `${CODEX_HOME:-~/.codex}/sessions/`.
- Input caps: 24,000 characters total (newest kept, `input_truncated` recorded) and 2,000
  characters per utterance; questions, decisions and next items have their own caps
  (`questions_capped`, `decisions_capped`, `next_capped`). A delta with no user/assistant text is
  a `no_change` fast path with no LLM call at all.

### 7. The summary call and its bounds

- One call shape (`scripts/wsl/mast-manager-harness.py`):
  `codex exec --ephemeral --ignore-user-config --ignore-rules -s read-only
  --skip-git-repo-check -C <fresh tmp dir> -m <summaryModel> -c
  model_reasoning_effort="<summaryEffort>" --output-schema <schema.json> -o <out.json> -` with the
  prompt written to a temporary `prompt.txt` connected as the child's stdin (a file, not a pipe
  write from the harness loop). The prompt is English instructions + current open items +
  changed plans + numbered utterances (`u<N>`); the model may only reference those numbers, and
  the merger resolves them to real anchors and checks quotes against the utterances, so invented
  anchors cannot survive.
- `MAST`, `MAST_TAB`, `MAST_TTY` and `CODEX_THREAD_ID` are removed from the child environment, and
  the child cwd is a fresh temporary directory, so the manager folder's hooks (and recursive
  collection) cannot fire.
- One summary at a time (global), 180 s limit, process-group kill on expiry, and a single-instance
  `flock` on `<managerDir>/.mast/harness.lock` (failure exits 5 without a restart). Triggers are
  needsInput immediately, idle after `idleSeconds` (a `running` transition cancels), `tabGone`,
  and `workspaceClosed`; events for one workspace are coalesced into a single summary.
- The patch schema is strict (`additionalProperties:false`, every property required, nullable
  unions) and lists `add`, `resolve`, `supersede`, `set_progress`, `set_title`, `set_headline`,
  `set_plan`. `verdict:"no_change"` with ops and `notify:"report"` without a reason are schema
  errors and reject the whole response without advancing the cursor: `last_error` is set, status
  is `failed`, and no notify is sent. When every op is individually rejected the pass is also
  reported as `failed` with `last_error = "all ops rejected: …"`, but the cursor advances —
  such rejections are usually deterministic (a full question list, an already resolved item),
  and retrying the same span would never end. Invalid individual ops are dropped, counted in
  `meta.rejected_ops` and logged by reason while the rest apply.

### 8. The board is read-only; corrections go through `mast manager patch`

- `apps/mast/src/features/manager/board-model.ts` validates each board entry (a malformed entry
  becomes an error card instead of disappearing), sorts cards (live needsInput or an open question
  → running → idle), and produces the card model: title, headline, progress (reported vs
  verified), open questions with quotes, user/ai decisions, next, and plan links. Entries that
  cannot be collected say why: `no_root`, `other_distro`, `no_transcript`, or an error.
  `board-view.ts` renders it and dispatches Go to / Open plan / Open log / Resume / Start fresh;
  the board tab has no close button.
- No UI control touches another workspace. The manager agent records user decisions and
  corrections with `mast manager patch <workspace-id>`, which reuses the core `manager_query`
  authority and validates the same op table (the manager side may set `verified_done`; `set_plan`
  is refused there). Valid ops apply under the lock, and the harness picks the change up by
  watching `tasks/` mtime within about five seconds.
- `mast manager workspaces|events` print the read-only query result as JSON; `mast manager start`
  execs `codex` with the saved `{model, effort}` from `<managerDir>/.mast/launch.json` in the
  manager folder. On macOS the manager's sandbox gets
  `-c sandbox_workspace_write.writable_roots=["$MAST_TTY"]` so it can call `mast`; the WSL
  `/dev/tty`/landlock path is a field check.

### 9. The manager folder and the digest fallback

- `~/.mast/manager/` holds `AGENTS.md` (created only when absent; the user's file is never
  overwritten), app-managed `MANAGER-GUIDE.md` and `digest.md` (≤ 4,000 characters), `tasks/`,
  `archive/`, `logs/harness.log` (+ `.1`, 1 MiB rotation), `.mast/launch.json` and
  `.mast/store.lock`.
- The CH0 spike found the project `.codex/hooks.json` does not fire under `codex exec` even with
  hook trust bypassed, so v1 takes the fallback: `MANAGER-GUIDE.md` tells the manager to read
  `digest.md` before every answer, answer from the task JSON and digest with quotes and anchors,
  open a transcript or plan only when needed, record decisions and corrections with
  `mast manager patch`, and not touch other tabs or workspaces. There is no `hook` subcommand and
  no generated `.codex/hooks.json`; if a TUI project hook is later confirmed to work, the hook
  path can return.
- The digest contains one line per task (`[#id name] title — headline | open questions: N |
  updated … | file: tasks/<key>.json`), so the manager can open the JSON for detail.

### 10. Work memory survives close and reopen

- Closing a workspace's last tab archives its active task to
  `archive/<key>--<YYYYmmddTHHMMSSZ>.json`. Reopening the same key shows a `choice` card:
  **Resume** restores the newest archive as `active`; **Start fresh** keeps the archive and begins
  a new task. Collection for that key pauses until the choice is made, and nothing auto-merges on
  path equality.
- `meta.status` is only `active` or `archived`; closing is storage movement, not completion.
- Awaiting-choice entries are sent on the board with `state:"choice"` and the archive count/last
  close time.

### 11. Alerts never duplicate the core's notifications

- The core keeps its needsInput toast (ADR-0026). The harness's headline lives on the card, and the
  toast path fires only for a turn that ended with a plain question, a done, or a failure — and is
  suppressed when that workspace's live status is already needsInput.
- The harness never writes status tokens and never overwrites `last_agent_message`.
- `apps/mast/src/features/manager/notify.ts` suppresses the front-end toast while the window is
  focused on the target workspace and truncates titles/bodies otherwise.

### 12. Settings and installation

- `settings.json` gains the `manager` object: `enabled` (required bool), `model`, `effort`,
  `summaryModel`, `summaryEffort` (`gpt-6-luna` high / `gpt-6-luna` low by default), `idleSeconds`
  (45, 10–600). `UiSettings`/`parse_ui_settings` in `apps/mast/src-tauri/src/commands.rs` and
  `scripts/wsl/mast-config.py` validate it identically (ADR-0023); an unknown field or a bad value
  stops startup, as with every other setting. `mast config set manager.enabled true` runs
  `codex --version` (10 s limit) first and exits 1 without touching the file when codex is missing.
  Changes need a full restart.
- Provisioning (`apps/mast/src-tauri/src/provision.rs`) raises `SETUP_VERSION` to 20 and installs
  `mast-manager.py` and `mast-manager-harness.py` into `~/.mast/bin/`; the WSL `mast` dispatcher
  and macOS `scripts/macos/mast.py` route `manager …`.

## Alternatives rejected

- **A classifier for utterance decisions** (Jev) — the user is on its waitlist, and this work's
  decisions span turns and revisions, which a per-utterance classifier does not model. Task JSON
  with explicit patches was chosen instead.
- **Typing into the manager terminal automatically or through a project hook** — the spike showed
  project hooks do not fire under `codex exec`, and even in a TUI an injected prompt would fight
  the user's input and spend the manager's context on every turn. The guide + `digest.md` fallback
  keeps the injection deterministic and user-visible.
- **A Markdown task record as the source of truth** — the writer is a machine and the board must
  parse reliably; JSON with schema validation and an atomic writer is stable, while Markdown
  formatting drifts with the model.
- **Reading pane scrollback or rendering screens in v1** — that needs the opt-in design already
  recorded in the backlog, and it would send raw output outside the pane. v1 exposes metadata and
  transcript paths only; the manager reads the summaries.
- **Extending the existing status token instead of a separate `mast-agent` OSC** — the
  `777;notify;title;body` grammar has no room for fields, and stuffing them into the body would
  surface in the sidebar preview on older cores. A new 777 kind is dropped harmlessly by old cores.
- **An isolated `CODEX_HOME` for summary calls** — it would need a symlinked `auth.json`, and a
  token refresh could replace the file under the user's real codex login. The measured ~2.2k-token
  overhead of the global `~/.codex/AGENTS.md` (which loads even with `--ignore-user-config`) is
  accepted instead.

## Consequences and limits

- **Windows is unverified.** The glue's `#[cfg(windows)]` code (the `wsl.exe` home probe, the
  launcher and pipe, the argv builders) compiles only under CI `windows-gates`; there is no macOS
  way to run it. M10 covers it in the field.
- **Workspaces in another WSL distribution are not collected** — they show live status only and
  the board says `other_distro`. agy and OpenCode tabs are not collected either; their tabs report
  `no_transcript` (no hook metadata on the current wiring).
- **ExitPlanMode rejection detection is generic.** No ExitPlanMode-specific rejection sample could
  be produced, so a rejection is judged by the tool-rejection shape
  (`tool_result.is_error == true` with `toolUseResult == "User rejected tool use"`) on a known
  `ExitPlanMode` id or a plan-shaped `toolUseResult`. A differently rendered rejection is dropped
  as unknown (never read as an approval, which needs the "User has approved your plan" prefix plus
  a known id or plan result); the fixture `claude-tool-rejected.jsonl` pins the implemented rule.
- **The global `~/.codex/AGENTS.md` loads on every summary call** (~2.2k tokens in the spike), even
  with `--ignore-user-config`. Accepted for v1; the isolated-`CODEX_HOME` alternative was rejected
  above.
- **Summary quality is unmeasured.** `gpt-6-luna` low produced correct patches in the one manual
  codex run (add decision, set progress/title/headline), but there is no field measurement across
  real sessions. Both model and effort are settings, so the answer is configuration, not code.
- **`mast manager patch` is not a security boundary.** Its checks (manager-tab query authority,
  schema validation, quote verification) prevent mistakes; a manager workspace's agent can already
  write its own task files. The board never gains authority over other workspaces' panes.
- **Downgrade then upgrade can duplicate the manager workspace.** An older build ignores the
  unknown `manager` field and drops it when it saves; the next launch then creates a second
  manager workspace while a normal workspace remains at the same path. `ensure_workspace` logs one
  line when it sees that normal workspace, but does not repair it.
- **Two workspaces with the same `root_path` and distro share one task** — a consequence of
  treating the path as identity (and of the archive/resume key). The UI does not merge them; the
  board shows the same record for both.
- **Every terminal tab in the manager workspace carries manager authority**, not just the first
  one; the flag is the workspace's, not a tab's.
- **The manager workspace's authority is query-only in v1**: list workspaces/status, read events,
  read task records. Cross-workspace send, workspace creation/rename and pane input stay out.
- **The event ring is process-local and bounded** (1024). After a restart a manager query reports
  `gap` and the harness rebuilds its view from a snapshot; events older than the ring are gone.
- **The `mast-agent` OSC is written outside the hook lock** (`write_agent_meta` runs before
  `tab.transact` in `mast-agent-hook.py`). A very long transcript path can push the payload past
  the pty write unit, so in theory it can interleave with a status token written by a concurrent
  hook; normal path lengths (~300 B) do not reach this.
- **The board line is not guaranteed to fit the 4 MiB line cap.** Every task is bounded, but the
  board carries each whole task document for up to 64 workspaces; at the caps' worst case (long
  Korean text in every field) a board line can exceed 4 MiB, and the glue drops such a line with
  a log entry. Realistic tasks are far smaller (~100 KB); sending only card fields is the fix if
  this is ever reached.

## Related fix

`crates/mast-core/src/capture.rs` (included in this change): macOS returns `EPERM` instead of
`ESRCH` when killing a process group that is already exiting or has only zombies left. The capture
path treated that as a kill failure; it now waits up to one second for the leader
(`EXITING_GROUP_GRACE` / `wait_for_exit`) and treats the `EPERM` case as already finished. The
relaxation is macOS-only (`is_exited_group_error` is `cfg(target_os = "macos")`); on other unix
targets `EPERM` still fails the kill. The pre-existing
`update::macos::tests::body_and_headers_have_independent_limits` went from failing 2/6 on `main`
to passing 30/30.

The manager's summary child does not go through `capture.rs`: the harness starts `codex exec` in
its own session and process group (`start_new_session=True`) and kills that group with `os.killpg`
on timeout, stdin EOF and shutdown, while the app kills only the harness process (its process
group on macOS; the direct child on the other builds) — the summary child is outside that kill
either way. If the harness does not exit inside the app's 2-second stop window, the summary codex
child and its temporary directory can be left behind (accepted limit).

## Verification

- **Automated, macOS local** (per-chunk logs are in the harness run directories; CH21 re-ran the
  core test, app check, Python suites and frontend suite on the final tree): `cargo test -p
  mast-core --locked`; `cargo check -p mast-app --locked` against the same 8 pre-existing
  warnings; `cargo test -p mast-app --locked`; `python3 -m unittest discover -s scripts/wsl/tests`
  (manager store, extract, summarize, harness, folder, CLI);
  `python3 -m unittest discover -s scripts/macos/tests`; frontend `npm run build` + `npx vitest
  run` compared with the recorded node-26 `localStorage` failure baseline. Document tests
  (`hook-example`, provision, agent hooks, config CLI) pass.
- **Spike evidence** for the contract choices: `codex exec` accepted the output schema and
  `gpt-6-luna` low/high efforts (B5); Claude transcripts carry `AskUserQuestion` answers in
  `toolUseResult` (B2); project hooks did not fire under `codex exec` (B1, fallback chosen); the
  global AGENTS.md overhead was measured (B6); the real summary path produced valid patches once
  (~11 s, 0 rejected ops).
- **CI** (`gates` on Linux, `windows-gates` on Windows) runs on the merge request; it is the only
  Windows/Linux compile gate for this feature.
- **Not run**: the M1–M10 field checks. `docs/MACOS.md` and `docs/WINDOWS-BUILD.md` list them; no
  item there should be treated as verified until it is recorded with its environment and result.
