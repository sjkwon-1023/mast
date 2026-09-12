# ADR-0010 — Restarting a dead terminal tab

Status: accepted (2026-08-20) · Amends [ADR-0004](0004-lifecycle-persistence-reset.md)
decision 3 (state-faithful restore of `Exited` tabs) · Verification: WINDOWS-BUILD §10 v0.3.9
item 4

**Amended by [ADR-0018](0018-exited-tab-as-terminal-record.md)** (2026-09-12): restore keeps
`Exited` and reverts only `NotStarted`; the forensics below are left as they were observed.

## Context

A user reported that every terminal tab came back dead after closing and reopening the app on
v0.3.8: a red `exited` badge on the tab and `(terminal tab without pty session)` in the pane.
The field state file settled it — `%AppData%\app.winmux.desktop\state.json` held ten terminal
tabs as `{"ptySession": null, "status": {"type": "exited", "code": 1073807364}}`.

`1073807364` is `0x40010004` (`DBG_TERMINATE_PROCESS`), the code Windows reports for a console
process torn down with its console — not a shell that returned. Three independent traces put
the deaths at one moment: all seven `~/.winmux/history/tab-*` files flushed at 2026-08-20
07:28 (bash writing `HISTFILE` on `SIGHUP`), the Windows event log records sleep entry at
07:28:17, and the WSL VM stayed down until 21:34 that evening. `toast.log` shows the app still
alive at 01:00. So the machine slept, WSL went down with it, winmux was running to observe ten
`SessionExited` events, and it wrote every one of them to disk.

From there the state was absorbing:

- `sink.rs::on_exit` → `apply_event(SessionExited)` sets `Exited { code }` and calls
  `publish_state`, which schedules a save. The death is on disk within the debounce window.
- `persist::sanitize` clears `pty_session` on load but left `status` untouched, so `Exited`
  survived the restart verbatim.
- `Dispatcher::running_terminal_tabs` — the only automatic respawn, run once at boot —
  enumerates `Running` tabs with no session. An `Exited` tab was excluded by design.
- Nothing else could revive one. `respawn_tab` rejected `Exited`, and in v0.3.8 the front end
  had no respawn binding at all (the Retry banner from ADR-0009 arrived later, gated on
  `NotStarted`). A webview reload is `location.reload()` — it never re-enters Rust `setup()`.

What made this permanent rather than merely unfortunate is that `sanitize` also strips the
`pty_session` that an `Exited` tab keeps *for replay*. The restored tab therefore showed
neither its last output nor a way back — strictly worse than the exited tab before the
restart, and worse than the "empty content + exited badge" the original decision described.

A normal app quit does not produce this. Nothing in the glue kills PTY sessions at exit, and
Tauri leaves via `std::process::exit` after our `RunEvent::Exit` flush, so shells killed by our
own teardown are never observed or recorded. The trigger is specifically a shell dying **while
the app is up**: sleep/shutdown with winmux open, `wsl --shutdown`, WSL OOM, or the user typing
`exit`.

## Decisions

1. **Restore normalizes `Exited` to `Running`.** `persist::sanitize` now flips the status the
   same way and for the same reason it clears `pty_session`: at restore time no shell from the
   previous run is alive, so a persisted process state is a statement about a run that is over.
   Boot then picks the tab up in the existing respawn enumeration and spawns it in its stored
   `cwd`.

   *[Amended by [ADR-0018](0018-exited-tab-as-terminal-record.md): `sanitize` now **keeps**
   `Exited` across a relaunch, because the exited tab's last screen survives as a record file
   and a shell spawned over it would be a record the user never gets to read. The `NotStarted`
   half of this rule is unchanged, and so is the rest of this decision's reasoning — what
   removed the justification for the `Exited` half is the banner Restart this ADR itself added,
   which is the way back that did not exist when the decision was made.]*

   This reverses ADR-0004 decision 3 for the `Exited` case. The fidelity that decision bought
   was never delivered — see above; keeping the status preserved nothing a user could see or
   act on.

2. **`respawn_tab` accepts an `Exited` tab** as a third eligible shape (after
   "`Running` with no session" and `NotStarted`). A tab that died at runtime still holds its
   session id for replay, so the stale session is killed and deregistered before the new spawn,
   exactly as the `NotStarted` retry path does. `SessionHost::kill` is idempotent, so a session
   that is already gone costs nothing.

3. **The boot enumeration stays `Running`-only — runtime deaths are not auto-respawned.** A
   shell the user ended on purpose must stay ended while the app is running; resurrecting it
   under the user would be its own defect. The distinction that carries the policy is *time*,
   not intent: a restart is a new run and brings the workspace back, whereas within one run the
   user is present and asks for it.

4. **The pane banner covers `exited` as well as `notStarted`**, with its own wording and the
   error colour, and its button reads `Restart`. This is the "asks for it" surface from
   decision 3, and it reuses the machinery ADR-0009 built rather than adding a second one. The
   banner stays an overlay so an exited tab's last output remains readable behind it.

5. **Revival keeps the tab id, which is the point.** Spawning with the same id re-attaches
   `HISTFILE=~/.winmux/history/tab-<id>` and the per-tab resume hint
   (`~/.winmux/resume/tab-<id>`), so a revived tab has its shell history and one `↑` away a
   `claude --resume <thread>` / `codex resume <thread>` line. The agent process is gone; the
   conversation is not.

## Alternatives considered

- **Normalize only non-zero exit codes**, so a shell the user ended with `exit` (code 0) stays
  exited across a restart while a crash comes back. Rejected as a distinction the exit code
  cannot actually carry — `exit 1` from a mistyped command and a killed shell are
  indistinguishable — for a case where the cost of being wrong is a tab that opens a shell the
  user did not want, which costs one keystroke to close.
- **Widen the boot enumeration instead of normalizing at load.** Same effect at boot, but it
  would also make every runtime `Exited` tab a respawn candidate for any future caller of that
  enumeration, which is precisely what decision 3 rules out.

## Consequences

- After an app restart, a tab whose shell the user deliberately exited comes back with a fresh
  shell. Accepted: tabs are workspace furniture, and the alternative — a dead tab with no
  content and no way back — is what this ADR exists to remove.
- An exit code no longer survives a restart. Nothing displayed it after a restart anyway.
- ~~`NotStarted` is deliberately **not** normalized~~ — **superseded the same day; see the
  amendment below.** The asymmetry (a tab whose shell *ended* gets revived at boot, a tab whose
  shell *never started* does not) was accepted here on the argument that recovery costs one
  click either way. The field disagreed within hours.
- ~~Boot now pays for the revival, on the setup thread~~ — **the second half is superseded by
  the amendment below; the cost is real but no longer blocks startup.** Reviving N tabs is N
  serial spawns under the dispatcher lock, each bounded by the 5s deadline (ADR-0009), so ten
  dead tabs against a wedged WSL is up to ~50s of attempts. Every failure demotes to
  `Exited { code: None }` with the banner, so each tab stays one click from another try. The
  path is not new — a clean quit already left N `Running` tabs to respawn at the next boot;
  what changed is that dead tabs now join them.
- The `no runtime log file` backlog item stayed decisive during diagnosis: the app recorded
  nothing about ten sessions dying, and the timeline had to be rebuilt from `state.json`,
  `HISTFILE` mtimes and the Windows event log.

## Amendment — 2026-08-20, same day (field evidence)

v0.3.9 shipped the decisions above, and the first boot that used them got two things wrong.

**Eleven tabs revived at once and six of their shells never started.** Process forensics on the
reporter's machine: live `bash -l` processes matched the five tabs marked `Running` exactly, the
six `NotStarted` tabs had no shell at all, and — unlike the 2026-08-15 incident — there were no
childless `/init` relays, just five healthy `SessionLeader → Relay → bash` triples. On the
Windows side thirteen `wsl.exe` processes carried start times inside the same one-second window.
WSL lost a race with its own cold VM boot; nothing killed anything, and `NotStarted` reported it
correctly.

So the boot cost the consequences above accepted is not only latency — at that density it is a
failure mode. `boot::respawn_restored_tabs` now warms each distro once (`wsl.exe --exec true`,
bounded by a 30s deadline) and paces the respawns (`WINMUX_RESPAWN_STAGGER_MS`, default 250ms).
Both run off the setup thread, so the window still opens immediately and tabs fill in behind it;
setting the knob to `0` restores the old burst, which is how the failure is reproduced.

**`NotStarted` is normalized on restore as well**, reversing the third consequence above. The
asymmetry was argued as costing one click; the field turned it into six, in exactly the scenario
this ADR creates. The reasoning that justified keeping it was also its weaker half — after a
restore a `NotStarted` tab has no session, so no late marker can ever arrive to clear it. Restore
now maps every shell-less terminal status to `Running`, which makes a restart the automatic retry
for a spawn wave that partly failed, while the banner stays the manual one within a run.

Verification: WINDOWS-BUILD §10 v0.3.10 item 1.
