# ADR-0018 — An exited tab is a terminal record, not a session

Status: accepted (2026-09-12) · Amends [ADR-0010](0010-restart-dead-terminal-tabs.md)'s restore
rule · Extends [ADR-0013](0013-retiring-a-closed-tab.md)'s delete-on-close to a second file ·
Verification: WINDOWS-BUILD §10 v0.3.25

## Context

Until this change a shell's death cost the app nothing and freed nothing. `waiter_loop` reaped
the child, the sink marked the tab `Exited`, and everything else stayed exactly where it was:
the `PtySession` with its 1 MiB replay buffer, its DEC-mode map and its `ChildKiller` remained
in `SessionManager`, the `TerminalSink` remained in `SinkRegistry`, and the model's tab kept
`pty_session: Some(id)`. That was not an oversight — it *was* the display mechanism. The front
end drew an exited tab by **attaching to the dead session** and writing its replay, so the
session had to survive for the last screen to exist.

Three known problems came out of that one shape.

- **Memory.** A tab nobody will ever write to again holds a live tab's replay budget (the
  backlog entry asked for 128–256 KiB as a compromise). Eight exited tabs are eight megabytes
  of screens that are, by definition, finished.
- **No orphan rule.** "A session no tab references" is the only cheap definition of a leak, and
  it was unusable while an exited tab legitimately referenced one. Drift between the model,
  `SessionManager` and `SinkRegistry` was therefore invisible, with nothing to log and nothing
  safe to clean.
- **Nothing to capture.** When a long session behaved badly there were no numbers to take:
  no process metrics, no session or replay accounting, no record of the last consistency check.
  CLAUDE.md's non-goal stands — a backend restart must never be the recovery mechanism, because
  it kills the live PTYs and the agents inside them — so the answer had to be diagnosis, not
  reaction.

They are one change because the first unblocks the second, and the third is only worth building
once there is something coherent to measure. The persistence saver's unbounded handoff channel
was fixed in the same PR for the same reason — it is the last unbounded queue in the backend,
and the diagnostics would otherwise report a number nothing bounds.

## Decisions

1. **The record is the raw bytes a re-attach would have sent (D1).** `PtySession::take_record`
   returns the same material `reattach()` builds — the DEC-mode preamble (ADR-0015) followed by
   the replay snapshot — and empties the replay buffer in the same lock section. There is no
   header, no grid renderer, no transcript format: the reader writes the bytes into an xterm and
   the finished screen stands up again, which is exactly what the old attach path did. The size
   bound is therefore the one that already existed, the replay cap of 1 MiB plus the preamble.

   `take_record` is `None` while the session is alive, and the predicate is `alive`, not
   `killed` — `kill()` raises `killed` while the child is still running, and taking the replay
   from a session that is about to be re-attached would blank a live pane.

   **Fidelity is "the same as before, or one tail chunk shorter."** The record can miss a chunk
   the old attach path would have shown, because the reader thread may still be inside
   `replay.push` while the waiter, having already lowered `alive`, runs `on_exit`. That is a
   *different* window from the tail loss `waiter_loop` has always accepted (the race between
   raising `killed` and the reader's outstanding read, which drops output the dying child left
   in the pipe); both are recorded below and neither is new behaviour made worse — the second
   one is new, bounded by one chunk, and paid for the memory the first decision buys.

   An empty snapshot yields an **empty** record rather than a preamble-only one. A preamble
   alone draws nothing; it is terminal configuration, and writing it would produce a file whose
   only effect is to make "no screen was recorded" indistinguishable from a read failure.

2. **The exit sequence is five ordered steps on the waiter thread (D2).** `TerminalSink::on_exit`
   runs, in this order:

   ① `take_record()` on the session handle — the only call this function makes on the session,
   and it never joins anything. The waiter thread is the one calling `on_exit`, so any wait on
   the session here is a wait on itself.

   ② write `records/tab-<id>.bin` (or delete the file when the record is empty), **outside the
   Dispatcher lock**. Before the model update, because the front end reacts to the state change
   by reading the file: publish first and the record view can mount against a file that is not
   there yet. Outside the lock, because this is disk I/O and the Dispatcher lock is the app's
   structural mutex. A failed write logs one line and does **not** abort the sequence — losing a
   screen and leaving a tab `Running` forever are not the same weight of failure.

   ③ take the Dispatcher lock, `apply_event(SessionExited { code, ended_at_ms })`,
   `publish_state`, then **explicitly** drop the guard.

   ④ outside the lock, `sinks.remove(id)` and `sessions.remove(id)`. After ③, never before: a
   front end that sees `Running` with a session id will try to attach, and if the registries are
   already empty it gets an unknown-session error instead of a screen. `remove`'s `kill` is
   idempotent, so a child that is already reaped costs nothing.

   ⑤ run the consistency audit (decision 5). After ④, so that the session this very exit
   released is not the thing the audit finds.

   The model update and the registry release are two steps with a window between them, and the
   marker in decision 5 is what keeps that window from looking like a leak.

3. **Records survive a relaunch; `Exited` is no longer reverted on restore (D3).**
   `persist::sanitize` still clears every `pty_session` and still turns `NotStarted` back into
   `Running`, but it now **keeps** `Exited`. The boot respawn wave enumerates `Running` tabs
   only, so a tab that was finished when the app closed comes back as a record with a Restart
   banner instead of a fresh shell.

   This partially reverses ADR-0010. That decision was made when an exited tab had no way back
   at all — no `respawn_tab` acceptance, no banner button — so "revive everything on restore"
   was the only escape from an absorbing state. The escape now exists in the UI, and a record
   that is silently replaced by a new shell on the next launch is a record the user cannot read.
   The `NotStarted` half of ADR-0010's rule keeps its original justification and is untouched:
   a tab that never started has no screen to preserve and its retry is exactly a respawn.

   **The accepted cost is per-tab Restart after a sleep or a `wsl --shutdown`.** When WSL goes
   down under a running app, every tab exits, and after the next launch each one is restarted by
   its own banner button. A bulk "restart every exited tab in this workspace" is the right
   answer to that and is deliberately a follow-up, not part of this change: it is a new command
   with its own pacing question (the ADR-0010 amendment's boot-wave failure is what a bulk
   restart would reproduce), and this PR is already a contract reversal plus hygiene.

4. **The file is derived from the tab id, and four rules own its lifetime (D4).** Records live
   in `%AppData%\app.mast.desktop\records\tab-<id>.bin`, next to `state.json`; the model stores
   no path. An absolute path persisted into `state.json` breaks the moment the app data
   directory moves, which the rename migration already made a real event. The content is plain
   terminal output, capped by the replay cap plus the preamble, and a read refuses anything over
   4 MiB — a file that large is not one we wrote.

   - **Exit overwrites**, and an empty screen deletes instead of writing, so a stale record
     never impersonates the shell that just finished.
   - **A successful respawn deletes.** Both callers — the banner's Restart and the boot wave —
     go through one glue helper, after releasing the Dispatcher lock. A *failed* respawn keeps
     the record: a retry that did not work must not also erase the last screen the user had.
   - **Close deletes.** `release_tabs` (reached from `CloseTab`, `ClosePane` and `CloseWorkspace`
     only — never from `SessionExited`, ADR-0013's rule, because an exited tab is revivable under
     the same id) now removes the record on its detached thread alongside the shell-side files.
   - **Boot sweeps.** Before any shell is spawned — ahead of the Fresh dogfood dispatch and the
     respawn wave — the store removes every `tab-<id>.bin` whose id is not a terminal tab in the
     state just loaded, plus any leftover `.tmp`. The keep set is *every* terminal tab, not only
     the exited ones, because a `Running` tab's stale record is deleted by its own respawn and
     misjudging a live tab's file is the more expensive mistake. It runs before the first spawn
     so the keep set cannot go stale under it. A boot that starts fresh — no `state.json`, or one
     kept aside as `state.json.corrupt-<epoch>` — therefore has an empty keep set and clears the
     whole directory; that is the wanted outcome rather than a gap in the rule, because a fresh
     boot restarts `next_id` and a surviving record would otherwise be handed to whichever new
     tab inherits its id. A `SweepReport` counts removed and failed
     separately and the sweep **keeps going past a file it cannot delete** — on Windows a sharing
     violation on one file is not a reason to leave the rest of the directory behind.

5. **The audit compares the model with both registries, and its lock order is Dispatcher first
   (D5).** The judgment is a pure core function, `audit_registries`, so it is testable on the
   Linux dev box where the glue cannot even compile:

   - **orphans** — a session (or sink) id the registry holds that no tab's `pty_session`
     references. These are released from both registries.
   - **dangling tabs** — a tab whose `pty_session` names a session neither registry has. There
     is nothing to kill, so the tab is only *repaired*: `SessionExited` with `code: None` (we did
     not observe this exit, and "unknown" is the honest answer) and the audit's own wall clock as
     `ended_at_ms`. The tab drops its session id and gets the Restart banner.

   The glue takes the **Dispatcher lock first** and snapshots `sessions.ids()` and `sinks.ids()`
   underneath it. The reverse order is destructive, which is why it is written down rather than
   left to taste: session creation inserts into the registry and records `pty_session` in the
   model inside **one** dispatch critical section, so a registry snapshot taken before the lock
   can contain a session whose model write has not happened yet — and that freshly created,
   perfectly healthy session is then classified as dangling and its live shell cut to `Exited`.
   Under the lock, absence is real absence. The direction matches dispatch's own (Dispatcher →
   registries), so no cycle is introduced. Orphan release, including `kill`, happens after the
   guard is dropped.

   **An exit in flight is not an orphan.** Between ③ and ④ of decision 2 a session is exactly
   "registered and referenced by no tab" — the definition of an orphan — so every normal exit
   would raise one. `AppState.exits_in_flight` is incremented before ③ and decremented after ④,
   and the audit reads it **under the Dispatcher lock, before taking the snapshot**; a non-zero
   value discards that round's orphan verdict (dangling repair is unaffected, since it does not
   depend on the window). Reading it after the snapshot would trust a snapshot taken before an
   exit that has since lowered the marker. Nothing would be destroyed — the session is dying
   anyway — but a check that cries "orphan" on every clean exit is a check nobody will read.

   It runs at four points and **there is no timer**: the tail of `on_exit`, after a successful
   `CloseTab`/`ClosePane`/`CloseWorkspace` (in `spawn_blocking`, because it waits on the
   Dispatcher lock and may call `kill`, neither of which belongs on an async worker), at the end
   of the boot respawn wave, and inside `get_diagnostics`. Background polling that scales with
   the number of workspaces is what the product principles rule out, and these four points are
   where drift is actually created. **No backend restart and no webview reload is attached to a
   finding** — the reactions are exactly the two above plus one log line.

6. **Diagnostics are collected on demand, never on a timer.** `get_diagnostics` returns process
   metrics (private bytes, working set, handle count, thread count — each `None` rather than 0
   when the platform or the query cannot answer), session counts (registered, alive, sinks, and
   the replay bytes they hold), tab counts by status, and the audit it just ran.
   `window.__mast.diagnostics()` is the dev-console door. One `diag:` line goes to `mast.log`
   at exactly three points: the end of the boot wave (a per-boot baseline, which is why the wave
   thread starts even when there is nothing to respawn), whenever the audit finds something, and
   when the reset supervisor's memory threshold fires. The thread count reuses the reset
   supervisor's Toolhelp helper, and a Toolhelp thread snapshot is **system-wide** — that cost is
   the reason this is a human-invoked command and three rare events, not a sampler.

7. **The remote surface is unchanged (D6).** A phone still gets 409 on an exited tab. It reaches
   the answer by a different route now — `live_session` rejected it on the `Exited` status
   before, and the tab has no session id to look up at all — but nothing in `mast-remote` grew a
   record path. Serving a finished screen to the phone is a separate feature with its own
   question about what leaves the PC.

8. **The saver's unbounded channel becomes a latest-state slot (D7).** `Saver::schedule` now
   replaces one pending `Box<AppState>` under a short slot lock instead of sending a clone down
   an unbounded `mpsc`, so a publish burst can never queue more than one snapshot. The two
   contracts that were on the channel are kept explicitly: the debounce deadline is fixed at the
   `None → Some` transition (a stream of changes is still written within one debounce window
   rather than being pushed ahead of itself), and the worker raises `flush_done` **only while
   `pending` is empty**, so `flush()` returning means every `schedule` made before it is on disk
   — which is what `main.rs`'s shutdown path (`router.flush_now()` then `saver.flush()`) relies
   on. A worker that dies is reported and no longer waited for.

9. **On the front end an exited tab leaves the terminal lifecycle for the viewer lifecycle.**
   `planViewSync` now disposes the `TerminalView` of **any** session-less terminal tab, including
   one in the active workspace — without that, `pane-view`'s visibility pass revives the old view
   on top of the record and two screens overlap. `planViewerSync` mounts a `RecordView` for a
   session-less exited tab, so the record is owned by the existing `viewerViews` registry: alive
   only while it is the pane's active tab, released when it is not. Re-reading a file on return
   is cheaper than keeping a dead xterm alive, which is the same rule ADR-0004 applies to
   inactive workspaces.

   `RecordView` reads `read_tab_record` once per mount and writes the bytes to a read-only xterm
   (`disableStdin`), with no channel, no ack and no resize command. It carries its **own**
   `ResizeObserver`, as every viewer does — the pane's observer fits the visible terminal view —
   and it registers with the **terminal** font registry rather than the viewer one, because a
   record is the continuation of a terminal screen and the same `Ctrl+=` / `Ctrl+-` / `Ctrl+0`
   step must move both; a live shell and its own last screen at two different sizes in one pane
   would be absurd. The copy-key judgment moved out of `TerminalView` into the shared
   `isCopySelectionKey` / `copyTerminalSelection` for the same reason it had to be shared at all:
   xterm cancels the `Ctrl+C` keydown itself regardless of `disableStdin`, so a surface that does
   not intercept the key gets no browser copy event and selection copying dies silently. The
   exited banner now names the code and the local exit time —
   `shell exited (code 0) at 14:32 — Restart opens a new shell here` — with either fragment
   omitted when it is unknown rather than filled in with "unknown", and the text is built by a
   DOM-free function so all four combinations are locked by tests.

## Consequences

- **An exited tab costs metadata.** Its replay buffer, DEC-mode map, `ChildKiller`, sink entry
  and channel slot are all gone at exit; what remains in memory is the tab itself, and on disk a
  file bounded by the same 1 MiB the buffer was. The backlog's "measure whether 128–256 KiB still
  preserves a useful last screen" question is moot — the answer is zero bytes of session memory
  at full fidelity.
- **`pty_session` means "there is a live session"** for the first time. Every consumer gets
  simpler: the remote surface's liveness check, the audit's orphan rule, the front end's
  attach decision. The `apply_osc` guard that skipped deltas for exited tabs is gone, because a
  session-less tab can no longer be found by session id at all — a late delta fails to locate and
  is harmless by construction rather than by a special case.
- **Diagnostics exist, and they are the reaction.** A drift now produces a loud line naming ids
  and kinds, plus a resource picture at the moment it was seen. Nothing restarts the backend.
- **The records directory is user data in plain text.** It holds whatever was on screen —
  command output, file contents, an agent's transcript tail. `docs/SETTINGS.md` says so, says
  where it is and says when files are deleted. `mast.log` still never contains terminal output;
  that separation is unchanged (ADR-0014).
- **After a sleep or `wsl --shutdown`, every tab needs its own Restart.** This is the one place
  the change is worse than what it replaces, and it is the price of decision 3. The bulk restart
  is recorded as a follow-up in the backlog.

## Accepted limits

- **Two distinct tail-loss windows.** The pre-existing one (`waiter_loop` prefers certain exit
  detection over draining the pipe, so output the child wrote just before dying may never be
  read) and the new one (the reader may be inside `replay.push` while `take_record` runs, so the
  record can be one chunk shorter than an attach would have been). Neither is repaired here;
  the second is the cost of freeing the buffer at exit rather than at attach.
- **The phone sees a blank frame, then 409.** Between ① and ③ the replay is empty while the tab
  still reads `Running` with a session id, so a `screen` poll gets a reset with only the
  preamble. The end state is the same 409 as before; only the intermediate frame is new.
- **An attach in flight when the exit lands shows one error frame.** `attach_terminal` can be on
  its way to a session that ④ has just released; the front end reports an unknown-session error
  for that frame and the next render draws the record.
- **Close and exit can interleave and re-create a deleted record.** If a tab is closed while its
  shell is dying, the release thread can delete the file between ① and ②, and the waiter then
  writes it again. The tab is gone from the model, so the next boot's sweep collects the file;
  until then it is an orphan on disk.
- **A shell that dies instantly after Restart can lose its own record.** The post-respawn delete
  runs after the spawn, so a new shell that exits before it — spawn, exit and record write all
  inside that window — leaves the tab exited with an empty record view. Deleting *before* the
  spawn was rejected: it would erase the last screen on every failed restart, which is the common
  case, not the rare one.
- **A record is bounded only by what the buffer was** — the 1 MiB replay cap plus the mode
  preamble — so a tab that flooded its screen writes close to a megabyte to disk. Whether a
  smaller cap still preserves a useful last screen is the backlog's own question and is
  deliberately not answered here.
- **After a sleep or a `wsl --shutdown`, every tab is restarted by hand.** Decision 3 leaves them
  exited on the next launch and there is no workspace-level Restart; the bulk revive is recorded
  as a backlog follow-up.
- **Records are plaintext on disk, unencrypted**, like `state.json` next to them. They are
  deleted by the four rules above, and a force-quit between a close and its delete leaves files
  that only the next boot's sweep collects.
- **The audit runs at four points, not continuously.** Drift created between them is invisible
  until one of them fires; `get_diagnostics` is the manual door for exactly that reason.
- **The glue half of all of this cannot be executed by any gate.** `apps/mast/src-tauri` does not
  build on Linux, so the exit sequence, the sweep, the release path and the audit wiring were
  reviewed against a written checklist (recorded in the chunk-2 and chunk-4 commit messages) and
  are verified in the field by WINDOWS-BUILD §10 v0.3.25.
