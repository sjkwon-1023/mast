# ADR-0009 — Startup marker and spawn deadline

Status: accepted (2026-08-15) · Supersedes nothing · Verification: WINDOWS-BUILD §10 v0.3.9

## Context

A field incident on 2026-08-15 left tabs that looked healthy and were not. WSL had run out of
the physically contiguous memory a Hyper-V vsock ring buffer needs (`dmesg`: eleven
`warn_alloc` failures through `vmbus_alloc_ring` → `hvs_probe`, with swap down to 16kB), so
`wsl.exe` started but no shell was ever created inside it. Process forensics pinned it: a
healthy WSL terminal is `SessionLeader → Relay(<bash pid>) → bash`, but two `/init` relays sat
with **no children at all**, still retrying `UtilAcceptVsock` hours later.

mast noticed none of it. The spawn returned `Ok`, no error surfaced, and a session that
spawns cleanly and then stays silent forever is indistinguishable from an idle one here — the
child has not exited so the waiter thread never wakes, and the reader gets no EOF and no
`EIO`. The user was left staring at a blank pane with no way to tell an app bug from a WSL
one. Separately, the same class of failure can hold the whole app hostage: `dispatch` spawns
**under the dispatcher lock**, on the recorded assumption that process creation costs "tens of
milliseconds".

## Decisions

1. **Detection keys on an explicit startup marker, never on output volume.** The WSL wrapper
   emits `OSC 777;mast-started` as its very first act, and that arrival is the signal.

   "Any output means the shell is alive" was proposed and **rejected on evidence already in
   this repo**: ConPTY injects cursor probes (`ESC[6n`) into the output stream (ADR-0004), and
   a past incident recorded a hung session whose entire output was those four bytes. The
   wrapper's own first line cannot stand in either — its theme sequence is an OSC 10/11 *set*,
   which conhost consumes as handled and never forwards to us (`host.rs::bash_argv` rustdoc).
   OSC 777 is a sequence conhost does not know, so it passes through, and that passage is
   already field-verified by the notification pipeline (ADR-0006).

2. **The marker proves the wrapper ran, and nothing more.** It sits before the wrapper's file
   I/O and its final `exec bash -l`, so a failure *after* the marker is out of scope here. That
   matches the incident, where the Linux-side bash was never created at all. Proving
   "prompt-ready" would need shell integration and is not worth its cost for this failure.

3. **Passing the deadline never kills the session — it only marks the tab.** This is the
   decision the rest hangs on. Killing would force us to justify the deadline against WSL cold
   starts that are reported at 8–10 seconds and occasionally minutes; marking costs a warning
   when we are wrong, and the warning clears itself when a late marker arrives
   (`Dispatcher::apply_delta`). It also removes a PID-reuse race on unix, where
   `clone_killer()` stores only a numeric pid.

4. **`TerminalStatus::NotStarted` is a distinct state, not a flavour of `Exited`.** "It ended"
   and "it never began" call for different guidance — the latter points at WSL — and collapsing
   them is precisely why the incident was unreadable. It is not terminal: a late marker
   transitions it back to `Running`.

5. **Cleanup is attached to user action, not to detection.** Retry (`respawn_tab`) kills the
   session the tab still holds before starting a new one, and closing the tab takes the
   existing path. Automatic kill was dropped with decision 3, and the observed cost is low —
   the surviving relays measured 0.0% CPU and ~350KB RSS, and other tabs kept working with
   them alive.

6. **Spawning carries a 5s deadline so one tab cannot stall the app.** Process creation is
   tens of milliseconds warm, so it is ~100× headroom. The bound is on the *wait*, not on the
   whole call: the worker thread has to be created before the timer starts, so under the memory
   pressure this work is about, lock hold time is 5s plus however long `thread::Builder::spawn`
   itself takes. Tightening that would mean a pre-spawned worker pool, which is not worth it for
   a window that is normally microseconds. Moving the spawn out from under the lock would
   be the deeper fix but would rewrite the atomicity contract (failure leaves state untouched)
   and its id-issuing order, which is not worth the regression risk for a failure mode that
   did not occur in this incident.

7. **The deadline helper uses a rendezvous channel (`sync_channel(0)`).** A buffered channel
   leaves a window where the receiver times out, the sender still succeeds into the buffer, and
   the value is dropped with the receiver — the cleanup hook then never runs, leaking exactly
   the zombie this work exists to prevent. A prototype reproduced that leak. With capacity 0
   there is nowhere for a value to rest: it is either received or returned to the worker as
   `SendError`. Cleanup runs on the worker thread, never under the caller's lock, since the
   cleanup itself (killing a session) can block.

8. **Enabled only where a wrapper can emit the marker.** The unix development path launches
   `$SHELL -l` directly, so it has no marker contract and defaults to off; a slow rc would
   otherwise be a false positive. `MAST_STARTUP_DEADLINE_MS` and `MAST_SPAWN_DEADLINE_MS`
   override both values (`0` disables), which is also how the field checklist reproduces the
   detection path.

## Rejected

- **Suppressing repeated failures.** With cleanup on retry and a visible cause, repeatedly
  opening tabs is an informed action; a latch would add cross-session state and could lock out
  tab creation on a healthy machine.
- **Detecting input that never reaches the shell.** This is what the incident's *other* symptom
  was — running agents going unresponsive — and a blocked `write_stdin` would be a sound
  signal for it. Left out deliberately: it needs another state, another surface, and its own
  false-positive rules. It stays in the backlog with that reasoning.
- **A detach layer (dtach/tmux) so sessions survive a severed relay.** Strictly more valuable
  and strictly larger; memory cost would be negligible (~50KB installed, <1MB per server) but
  socket lifetime, attach/new arbitration and lost output while detached are real complexity.
  Sessions dying with the app is intended behaviour, and memory pressure is addressed by WSL
  configuration instead.

## Consequences

A tab that never gets a shell now says so and offers Retry, and the message points at WSL
rather than leaving the user to guess. A late shell recovers on its own, and that recovery is
kept independent of arrival order — the dispatcher remembers which sessions produced a marker,
because the marker and the deadline report reach it by different paths. A spawn that hangs costs
bounded app-wide latency instead of an unbounded stall, and its late result is cleaned up rather
than abandoned.

What remains uncovered: failures after the marker, sessions that fall silent after having
worked, and the underlying memory pressure itself — which is WSL configuration, not something
the app can fix.
