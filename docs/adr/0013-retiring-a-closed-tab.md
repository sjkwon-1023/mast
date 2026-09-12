# ADR-0013 — Retiring a closed tab

Status: accepted (2026-08-22) · Verification: WINDOWS-BUILD §10 v0.3.11 item 2

**Amended by [ADR-0018](0018-exited-tab-as-terminal-record.md)** (2026-09-12): the same release
path now also deletes the tab's record file, `records/tab-<id>.bin`.

## Context

Every mast terminal tab gets private state inside WSL. The spawn wrapper points `HISTFILE` at
`~/.mast/history/tab-<id>` (`host.rs::bash_argv`), and the agent hooks write a resume hint to
`~/.mast/resume/tab-<id>` — via `tab-<id>.tmp.<pid>` first, so a hook killed mid-write leaves
one of those behind too. Both paths are keyed by the tab's stable id, which is what makes them
work: the id survives restarts, so a revived tab finds its own history and its own `↑`.

Nothing ever deleted them. Tab ids come from a monotonic counter and are never reused, so a
closed tab's files can never be reached again by anything — they simply accumulate, one to three
files per tab ever opened, for as long as the distro lives.

The bookkeeping is small; the reason to fix it is that the directory is user-visible and its
contents stop meaning anything. A user reading `~/.mast/history/` cannot tell which files
belong to tabs that exist.

## Decisions

1. **Deletion is attached to closing a tab, not to a periodic sweep.** Closing is the moment the
   files provably become unreachable, and it needs no list of live tabs to compare against.

2. **`SessionExited` is deliberately not a trigger.** A tab whose shell died is revivable under
   the same id (ADR-0010) — Restart, or the next app launch, brings it back and `↑` must still
   reach what was typed before. Deleting on exit would silently break the feature ADR-0010 exists
   for. The trigger is `CloseTab` / `ClosePane` / `CloseWorkspace` only.

3. **The core reports, the host deletes.** `SessionHost::release_tabs(&[TabId], Option<&str>)`
   joins `spawn_shell` and `kill` as the third port. `mast-core` stays unaware that a tab has
   files at all — it knows only that some tabs are gone for good — and the WSL-shaped half lives
   in the glue, exactly like spawning. The trait method has a default no-op body so hosts without
   per-tab shell state (the test fake, the unix dev path) are unaffected.

4. **One round trip per removal, not per tab.** `release_tabs` takes a slice. Closing a workspace
   retires every tab in it, and firing one `wsl.exe` per tab would recreate the burst that made
   the boot respawn wave fail against a cold VM (ADR-0010 amendment). One `rm -f --` names every
   file of every retired tab.

5. **`$HOME` is expanded inside WSL.** The command runs as `wsl.exe [-d <distro>] --exec bash -c
   'rm -f -- "$HOME/.mast/…"'` rather than being assembled into a `\\wsl.localhost\…` path on
   the Windows side. The Linux home directory is not ours to guess, and guessing wrong deletes
   nothing while looking like it worked — the same reasoning that puts `mkdir -p` inside the
   spawn wrapper. `--exec` for the same reason `spawn_spec` uses it: no second shell evaluation.

6. **The call is detached.** `dispatch` holds the dispatcher lock across this call (`host.rs`
   module doc), so a WSL round trip on that thread would block every other command for its
   duration. The work goes to a thread and the call returns immediately; failures reach stderr
   and nothing else, because there is no user action to offer.

7. **Kill precedes delete.** A shell writes `HISTFILE` as it dies, so deleting first lets the
   dying shell recreate the file we just removed. In the chosen order the remaining race is the
   reverse — the delete landing before the kill signal reaches the shell — and that one cannot
   realistically happen: the delete is a WSL process launch, orders of magnitude slower than the
   shell's exit flush.

8. **Tab ids go into the script unescaped.** They are `u64` decimals, so they cannot carry shell
   metacharacters. Only the `.tmp.*` glob sits outside quotes; with no match it stays literal and
   `rm -f` ignores it, which is also how the two named files handle never having existed.

## Consequences

- Closing a tab now costs a `wsl.exe` launch. It is off the UI thread and off the lock, and the
  user is never waiting on it.
- Files are orphaned when the app is force-quit or crashes between the close and the `rm`. Nothing
  sweeps them; a boot-time sweep against the tab ids in `state.json` would, and stays on the
  backlog.
- Two ways a tab's files can outlive it remain by design: an `exited` tab keeps everything until
  it is actually closed, and quitting the app deletes nothing at all.

## Rejected

- **A boot-time sweep instead.** It catches the crash-orphan case this does not, but it needs the
  live tab id set, deletes long after the fact, and would have to be careful never to outrun a
  tab that is about to be restored. Complementary, not a substitute — and the user asked for
  deletion at the moment of closing.
- **Deleting from the Windows side over UNC.** Faster and with no process launch, but it requires
  resolving the Linux `$HOME` from Windows and would lose the ordering benefit in decision 7.
- **A `trap` in the shell.** The wrapper `exec`s the login shell, so any trap it installs is gone
  before the shell runs; installing one from `~/.bashrc` means editing a file that is not ours.
