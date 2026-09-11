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
