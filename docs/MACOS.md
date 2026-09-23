# Mast on macOS — initial native port

One Mast codebase, the same workspace/pane/tab model, and the same terminal,
replay, OSC, agent-state and viewer pipelines. The macOS desktop target is
**Apple Silicon only** (`aarch64-apple-darwin`). Windows continues to use WSL2.

## Scope

The initial port includes native zsh/bash terminals, workspace/pane/split/tab
navigation, state/layout restoration, terminal records, Claude Code / Codex /
OpenCode integration, agent state and notifications, on-demand session resume,
`mast ls`, `mast send`, folder/text/Markdown viewers and Mac keyboard bindings.

This is a development/source-build target, not a signed distributable product.
Git changes/diff, mobile Local HTTP and Secure Remote are **not supported on Mac
in this phase**. Their Windows paths remain intact. A restored changes-viewer
tab is retained but shows a deferred-feature message. Mac startup never opens a
remote listener, even when an imported settings file enables remote control.
There is no Mac auto-update check. Packages, permanent Mac release workflows,
signing/notarization and expanded OS integrations remain separate work.

## Build and run

Requirements: an Apple Silicon Mac, Xcode Command Line Tools, a current stable
Rust toolchain, Node.js (the repository CI uses Node 24), and **Python 3.11+** for
Mast's CLI and agent integrations. Install the desired agent CLIs separately.
Nothing downloads an agent, a runtime, or a shell on your behalf.

```sh
xcode-select --install
rustup target add aarch64-apple-darwin
cd apps/mast
npm ci
npm run tauri dev -- --target aarch64-apple-darwin
```

Python is discovered at `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`,
then `/usr/bin/python3`, with an executable/version check. Apple's older CLT
Python is not sufficient. Homebrew Python is a suitable installation. Missing
Python does not stop terminals or viewers; agent integration and `mast` CLI
commands report that it is missing. Inspect `~/.mast/setup.log`, install Python
3.11+, and restart Mast. No Python process is kept running between hook events.

The initial native notification transport uses `osascript` so unbundled source
builds can show macOS notification banners without a signed app identity. Grant
notification permission when macOS requests it; Focus/Do Not Disturb can suppress
banners. Notifications may be attributed to the script host in system settings.
Signed-app notification identity and notification-click activation are later OS
integration work, not claimed by this port.

## Shell selection and startup

Selection order: saved `shell` setting, `MAST_SHELL`, the macOS account login
shell, `$SHELL`, then `/bin/zsh`. Only absolute executable paths whose basename
is `zsh` or `bash` are supported. Terminal.app's separate custom profile command
is not read; select the same shell explicitly when necessary.

```sh
mast config set shell /bin/zsh
mast config set shell /bin/bash
mast config set shell /opt/homebrew/bin/bash
mast config reset shell
```

Restart Mast after changing the shell. The same `settings.json` conventions as
Windows are used; on macOS its usual location is
`~/Library/Application Support/app.mast.desktop/settings.json`. The exact path
is exported as `MAST_CONFIG_PATH` inside each Mast shell.

zsh runs as an interactive login shell. A Mast-owned `ZDOTDIR` wrapper chains
the user's `.zshenv`, `.zprofile`, `.zshrc` and `.zlogin` once, respecting an
inherited/custom `ZDOTDIR` and changes to it in startup files. The original user
`ZDOTDIR` is restored before the prompt and nested shells. User startup files
are never rewritten. Disabling zsh's `RCS`/`GLOBAL_RCS` can intentionally disable
startup-file integration, just as it can disable other terminal integrations.

bash runs interactively with a Mast-owned rc file. It sources `/etc/profile`,
then the first available `.bash_profile` / `.bash_login` / `.profile` (or
`.bashrc` when none exists), and adds Mast integration afterwards. This avoids
sourcing a `.bashrc` twice when the user's profile already sources it. The bash
process itself is not flagged as a login shell; configs that explicitly test
`shopt login_shell` must account for that distinction.

Both shells inherit normal user initialization, prepend `~/.mast/bin`, announce
UTF-8/color/terminal capabilities, emit the same startup and working-directory
OSC events as Windows, and keep history in `~/.mast/history/<shell>-tab-<id>`.
A removed saved directory falls back to `$HOME` with a visible notice. Paths are
passed as separate process arguments, including spaces, quotes and Unicode.

## Agent integration and resume

The host atomically installs the native adapters and the existing shared agent
hook dispatcher under `~/.mast`. It uses the same conservative Claude/Codex hook
merger as Windows, preserving unrelated user configuration and making backups
where the existing merger does so. Claude approval tracking requires Claude
Code 2.1.118+; unknown/older detected installations get status-only hooks. Codex
may prompt you to trust the configured hooks; follow that agent's prompt.

Existing Codex `notify` settings are kept, not replaced. To combine a personal
notification command with Mast's legacy turn-completion/resume callback, have
the existing callback also invoke `~/.mast/bin/mast-codex-notify.sh` with the
original JSON argument. The structured Codex hooks still provide state updates.
Mast does not silently take ownership of another tool's notification handler.

OpenCode uses the shared Mast plugin in
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/mast.js`. An existing
user-owned or modified `mast.js` is not overwritten. Setup failures are recorded
in `~/.mast/setup.log`; successful integrations have per-agent
`~/.mast/.setup-macos-v1-<agent>` markers. Remove the relevant marker to request a
fresh merge. Unavailable agents are retried at a subsequent launch. The existing
`no-codex-hooks` opt-out marker remains supported; native setup also respects
`no-claude-hooks` and `no-opencode-hooks`.

Detached agent hooks use the inherited `MAST_TTY` instead of Linux `/proc`.
The fallback accepts only a non-symlink, same-user `/dev/ttysNNN` character device;
it does not open arbitrary paths supplied by an agent.

Resume is **a hint, never automatic execution**. Eligible root agent events save
`claude --resume <id>`, `codex resume <id>` or `opencode --session <id>` for that
tab. The next shell displays the command and adds it to that tab's history: use
Up/Enter when you are ready. IDs are strictly validated before saving or loading
hints. Closing a tab deletes its owned history/resume files; quitting the app
keeps them for restoration.

`mast send` reports a nonzero exit status when it cannot write to the terminal.
A failed payload is never followed by Enter or automatically retried: delivery
may be partial, so inspect the receiving tab before retrying. Successful TTY
writes are not a receiver acknowledgement. `mast ls` reports a failed query
write immediately and removes its private reply directory.

## Keyboard

| Action | macOS binding |
| --- | --- |
| Workspace 1–9 | Cmd+1–9 |
| Previous/next workspace | Cmd+Shift+[ / ] |
| Move focus to adjacent pane | Cmd+Option+arrow |
| Next/previous tab within pane | Ctrl+Tab / Ctrl+Shift+Tab |
| New terminal / folder tab | Cmd+T / Cmd+Shift+B |
| Auto split / vertical split | Cmd+D / Cmd+Shift+D |
| New workspace at current directory | Cmd+N |
| Close active tab / workspace | Cmd+W / Cmd+Shift+W |
| Rename workspace | F2 |
| Zoom in/out/reset | Cmd+plus / minus / 0 |
| Copy / paste | Cmd+C / Cmd+V |
| Save Markdown edits | Cmd+S |
| Reload the WebView, not the backend | Cmd+Shift+R |
| Quit (through the unsaved-Markdown guard) | Cmd+Q |

Ctrl+C always reaches the terminal on Mac, even when text is selected. Ctrl+D,
Ctrl+W and other shell-editing keys are not app commands. IME composition is not
intercepted. Hold Command to show button shortcut hints. Windows keeps its
existing Ctrl/Alt bindings and terminal copy/paste behavior.

## Shutdown contract

A tab close, normal app quit, or last-window close terminates the private POSIX
session created for each PTY, including ordinary background jobs and separate
foreground job groups. HUP is followed by KILL after a short grace period. The
root child's PID is kept unreaped until cleanup finishes to avoid confusing a
reused PID with an owned session. Natural shell exit also cleans its remaining
session jobs. No daemon, tmux server or always-on process watcher is introduced.

Final app shutdown rejects late/restored-tab spawns and suppresses exit callbacks
that would otherwise mark saved Running tabs as Exited. Thus reopening the app
restores shells/layout, but does not restart agents automatically. `Workspace.distro`
remains in the shared model; new Mac workspaces use `None`, and native execution
and filesystem access ignore the field even in imported states.

Force Quit / `kill -9` bypasses application cleanup, and processes that
intentionally daemonize into an independent POSIX session are outside this
normal-shutdown guarantee. Mast itself does not create such persistent sessions.

## Verification

Automated native tests cover PTY child cleanup (including HUP-ignoring background
jobs), shutdown/restoration callback suppression, zsh startup ordering/custom
ZDOTDIR, bash profile/history isolation, missing-directory fallback, resume hint
validation, native CLI protocol/quoting and failed-send handling, safe config
merging, and Mac key maps.

```sh
cargo test -p mast-core --locked
cargo test -p mast-app --locked
python3 -m unittest discover -s scripts/macos/tests -v
cd apps/mast && npm run build && npm test
```

Before treating a source build as daily-driver-ready, run this device checklist:
create several workspaces and split panes; run each installed agent; observe
running/needs-input/idle transitions and notification permissions; exchange
literal/submitted `mast send` messages and inspect `mast ls`; quit/reopen and
resume each agent; verify all shells/dev-server jobs end at quit; open/edit/save
Unicode-path files; check Korean IME, clipboard/image paste, resizing, scrolling
and Cmd shortcuts. Compile/unit-test success is not a claim that authenticated
agent sessions or native GUI behavior were exercised on a physical device.
