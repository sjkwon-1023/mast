# ADR-0011 — Tracking a tab's working directory

Status: accepted (2026-08-20) · Completes [ADR-0006](0006-osc-notification-routing.md)'s OSC 7
leg · Verification: WINDOWS-BUILD §10 v0.3.10 item 2

## Context

A user reported that after a restart every tab reopened at the workspace root instead of where
its shell had been. The restore path was not at fault. `Tab.cwd` is resolved exactly once, at
spawn time, to `tab cwd ?? workspace.root_path` (`command.rs`), every front-end create path
passes `cwd: null`, and nothing ever advanced the value afterwards.

Everything downstream of the emitter was already built and tested: the scanner recognises
`OSC 7` (`osc.rs`), `OscBatch::merge` fills `OscDelta.cwd` through `parse_file_uri` with
percent-decoding, `Dispatcher::apply_delta` writes it onto the tab, and it persists and restores
like any other tab field. What was missing was a shell that ever emits the sequence:
`bash_argv` sent only the startup marker and the OSC 10/11 theme sync, and `provision.rs` has no
rc-file step at all — the `PROMPT_COMMAND` snippet in `scripts/wsl/claude-hook-example.md` was
manual-install advice.

The field state made the consequence unambiguous, and also proved the rest of the pipeline
healthy: every terminal tab carried a `cwd` identical to its workspace `rootPath`, while tab
*titles* in the same file were live values that had arrived over the same delta path from OSC 0.
One signal worked; the other was never sent.

README's "Shells respawn in the directory they were last in" was therefore false as shipped.

## Decisions

1. **The emitter is injected by the spawn wrapper, not installed into the user's rc file.**
   `bash_argv` adds `PROMPT_COMMAND` to the environment assignment list it already builds for
   `PATH`/`HISTFILE`/`MAST_TAB`, so every mast shell reports its directory and no shell
   outside mast is affected.

   The backlog had predicted "a provisioning line and a `SETUP_VERSION` bump, not a code
   change". Measurement reversed that: writing into `~/.bashrc` needs a re-provisioning round
   trip before it takes effect (the marker file short-circuits setup), it edits a file the
   project has never written to, and — measured on the reporter's box — the placement it needs
   lands wrong against `starship`. Environment injection has none of those problems: it applies
   on the next app launch, touches nothing the user owns, and starship *preserves* an inherited
   `PROMPT_COMMAND` (it moves it to `STARSHIP_PROMPT_COMMAND` and runs it after its own precmd),
   verified end to end in a pty.

2. **OSC 7 only — never OSC 0 from the same hook.** The snippet this borrows from also sets the
   title to the directory name. Sending that would overwrite the agent-set tab titles every
   prompt, which is what makes the workspace sidebar useful in the first place.

3. **Only `%` is percent-encoded**, via `${PWD//%/%25}`. The receiving decoder only transforms
   `%XX` and leaves everything else alone, so spaces and non-ASCII survive a literal round trip;
   pre-encoding the one character that would otherwise be *mis*-decoded makes the trip lossless.
   The alternative — full percent-encoding in bash — costs a loop or a subshell on every prompt
   for no gain here. `notify.rs::wrapper_emitter_shape_round_trips` locks the pairing.

4. **The destination `cd` moves out of `wsl.exe --cd` and into the wrapper**, with `--cd ~` as
   the base. When `--cd <path>` names a directory that no longer exists, the relay logs
   `chdir(...) failed` and **never runs the command at all** — and `wsl.exe` still exits 0, so
   the spawn looks successful while the tab sits there with no shell and no startup marker
   (verified on real hardware). That was survivable while `cwd` was always the workspace root;
   once it follows a live shell, deleted directories become ordinary. In the wrapper the failure
   is recoverable: the shell is already in `$HOME`, so it starts anyway and prints one dim line
   saying which directory is gone. The path is single-quoted into the script — a tab's `cwd`
   arrives from the shell over OSC 7, so it is untrusted input.

## Consequences

- A tab's `cwd` now advances **at each prompt**, not continuously: a shell that `cd`s and then
  runs a ten-minute build reports the new directory immediately (the prompt that follows the
  `cd`), but a directory change made *by* a running program is invisible until it returns. This
  matches what the value is for — where to reopen the shell.
- The assignment sits in front of `exec bash -l`, so `PROMPT_COMMAND` is **exported**: nested
  shells inside the tab inherit it and report over the same session. For a plain nested `bash`
  that is what you want. Under `tmux` it means the tab's `cwd` follows whichever pane drew a
  prompt last, which is noise rather than a defect — the value is still a directory that tab was
  really in, and the alternative (unexporting it) would lose tracking for the nested case that
  actually matters.
- A live `cwd` reaches the `/mnt` guard on workspace creation, which rejects a Windows-mounted
  root. A shell sitting in `/mnt/c` and a "new workspace here" action will now be refused where
  it previously silently used the workspace root. The guard is deliberate and loud, so this is
  reported rather than hidden.
- A tab whose directory was deleted starts in `$HOME` with a one-line notice instead of dying.
  That is a fallback, which this project normally distrusts — it is accepted here only because
  the notice makes it visible and the alternative (decision 4's evidence) is a tab that cannot
  start at all.
- The wrapper script grows one clause and one assignment. It is already the single place that
  defines what a mast shell is, and it is covered by the argv contract tests — which now
  actually run, on the Windows CI leg (they had rotted unnoticed because the Linux gate never
  compiled them).

## Amendment (2026-09-30): the sidebar card path follows the tracked cwd

The third line of a sidebar workspace card used to show the workspace `rootPath`, which is fixed
when the workspace is created, so the card kept naming that folder however far the shell moved.
The card now shows the active pane's terminal `cwd` — the value this ADR keeps current — and falls
back to `rootPath` when the shown tab is not a terminal (`sidebar-model.ts` reuses
`activeTerminalCwd`, the `Ctrl+Shift+N` resolver). `abbreviatePath` also folds macOS's
`/Users/<user>` into `~`, next to `/home/<user>`. `rootPath` itself is unchanged: it is still the
default cwd for new tabs, and nothing in the UI edits it. The value is still the last
prompt-time cwd, so a card does not move while an agent `cd`s on its own.

## Amendment (2026-10-14): WSL login shells can be zsh

**Problem.** A WSL user whose `~/.profile` replaces bash with `exec zsh -l` got a bash wrapper
whose `PROMPT_COMMAND` never ran. The tab's cwd stayed at `~`, and every restart reopened there.
The wrapper body now lives in `scripts/wsl/launch.sh`; the `PROMPT_COMMAND` export moved there
from the argv that `host.rs::bash_argv` built. Decisions 1–4 still describe the bash path.

**Decisions.**

- **Shell selection.** The wrapper uses `$SHELL` inside WSL, or the passwd shell when `$SHELL` is
  empty. A value that is not an absolute, executable regular file with basename `bash` or `zsh`
  falls back to `/bin/bash` with one dim line. Control characters are replaced before printing.
- **zsh path.** The six macOS integration files are reused unchanged: `integration.sh`,
  `zsh-integration.zsh`, `zshenv`, `zprofile`, `zshrc` and `zlogin`. The setup script embeds them
  from `scripts/macos/` with `include_str!`, so the repo has no WSL copy. Setup v22 installs them
  under `~/.mast/shell/`. The wrapper starts `zsh -il` with `ZDOTDIR=~/.mast/shell/zsh`, and the
  user's `ZDOTDIR` and startup files are preserved as on macOS. cwd is reported by `_mast_cwd`
  at every prompt; `PROMPT_COMMAND` is not set on this path.
- **Missing assets.** If any of the six files is not a readable regular file, the tab prints
  `[mast] zsh integration is not installed yet; this tab starts without it. Once setup finishes, exit it and press Restart`
  and starts the bash path. It does not fail. The user's login files can switch that path to
  another shell; such a tab has no mast integration, so its cwd is not reported until Restart
  (a known limit). After an upgrade, `respawn` runs before provisioning
  (`boot.rs`), so a failing check would leave restored zsh tabs exited, and there is no bulk
  Restart to recover them. Recovery: once setup finishes, exit the shell in that tab and press
  Restart on the exited tab, or relaunch mast. A restored tab is respawned on the next boot, and
  the launcher checks the assets at every spawn, so it sees the installed files. The Restart
  banner appears only for an exited or not-started tab, so a running shell cannot be restarted
  in place.
- **History.** A zsh tab uses `~/.mast/history/zsh-tab-<id>`, set by `zsh-integration.zsh`. A bash
  tab keeps `tab-<id>`. For any tab id, both shells create `~/.mast/history` before `exec`, and the
  wrapper exits nonzero if it cannot. Closing the tab removes both names
  ([ADR-0013](0013-retiring-a-closed-tab.md)).
- **Resume hint.** A zsh tab reads the hint at its first prompt through `_mast_resume` in
  `integration.sh` and adds the command to the shell history with `print -s`. The same function
  reads line 2 only to tell a changed hint from one already offered in that shell. Freshness is not
  judged, as on bash.
- **PATH.** A zsh started directly does not read `~/.profile`. The `PATH` of a mast zsh tab is
  therefore judged against a normal `wsl.exe` zsh login, not against the bash tab's `PATH`. That
  comparison is a field check.

**Trust prompt.** Two things are kept apart.

- *Field evidence, before this change:* Claude Code 2.1.296 scopes trust for the home directory to
  the session. Every tab restarted in `~`, so Claude asked "trust this folder?" on each restart.
- *Expected result, not yet verified:* restoring the tab's cwd should stop the repeated question
  for a project that is already trusted. No user setting is changed, and no trust is approved
  automatically.

**Verification status.** Automated: the Linux PTY tests in `scripts/macos/tests/test_shells.py`
run the `scripts/wsl/launch.sh` body with real bash and zsh on the CI Linux gate. They cover shell
selection, the missing-asset fallback, the cwd argument and the cwd report. The zsh history and
resume-hint cases of the shared zsh files run only on macOS, in the `macos-artifacts` job. The
Windows-target `host::tests` and `provision::tests` run on the CI `windows-gates` job. Not run:
Windows/WSL field verification (WINDOWS-BUILD §10, "Unreleased — WSL zsh login shell field
verification"), a macOS run of the shared files for this change, and the trust check. Items not run
are not counted as passed.
