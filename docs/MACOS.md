# Mast on macOS — Apple Silicon source builds

One Mast codebase, the same workspace/pane/tab model, and the same terminal,
replay, OSC, agent-state and viewer pipelines. The macOS desktop target is
**Apple Silicon only** (`aarch64-apple-darwin`). Windows continues to use WSL2.

## Scope

The native source build includes zsh/bash terminals, workspace/pane/split/tab
navigation, state/layout restoration, terminal records, Claude Code / Codex /
OpenCode integration, agent state and notifications, on-demand session resume,
`mast ls`, `mast send`, folder/text/Markdown viewers, the Git Changes viewer,
startup release notices, optional Local HTTP, on-demand Secure Remote, Antigravity
CLI running/idle hooks, Mac keyboard bindings and the embedded browser tab with
`mast browser` (WKWebView; see [BROWSER.md](BROWSER.md) for the macOS differences and
[ADR-0031](adr/0031-wsl-readiness-and-embedded-browser.md) for the decisions and the 2026-09-25
field run).

This is a development/source-build target, not a signed distributable product.
The release notice only links to a release page; it does not download or install
an update. Packages, permanent Mac release workflows, signing/notarization and
expanded OS integrations remain separate work.

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

Agent setup (the Python 3.11+ probe and `mast-setup.py`) runs on a background
thread and never delays startup or workspace creation; until it finishes, `mast`
may report that Python is required. The setup helper runs in its own process
group with time-limited commands and finishes on its own if Mast quits first;
that run's `~/.mast/setup.log` may then be missing or stale, and the next launch
retries based on the setup marker files.

## Git changes and startup release notices

Open a workspace's Changes viewer from the pane toolbar. macOS runs Git directly
through `/usr/bin/env`; install Git and make it available to Mast's environment.
The viewer is read-only and uses the same repository resolution and limits as the
Windows viewer: repository discovery and status share a 10-second capture budget,
each diff has its own 10-second budget, at most four content queries run at once,
and one displayed diff is capped at 512 KiB. Bare containers use the worktree for
the bare repository's current branch; when that worktree is unavailable, open an
explicit worktree instead of relying on an unrelated checkout. See
[ADR-0022](adr/0022-read-only-git-changes-viewer.md).

At startup, Mast makes one background request to the fixed GitHub latest-release
endpoint. A strictly newer stable version adds a link to the repository's fixed
release page. If runtime logging is enabled, a failed or offline check is logged;
it does not claim that Mast is up to date. The native request uses `/usr/bin/curl`,
a direct connection without environment proxy settings, a 3-second connect
timeout, a low-speed timeout of 3 seconds below 1 byte per second, an 11-second
curl total timeout and a 12-second process-capture deadline. Headers and the
response body are capped at
16 KiB and 64 KiB. There is no popup, polling, download, installer or automatic
restart. See [ADR-0024](adr/0024-startup-update-notice.md).

## Phone access and the macOS firewall

Local HTTP is off unless `remote` is present in settings. Configure it with
`mast config set remote` (port 7331 by default), then fully quit and relaunch Mast.
It serves plain HTTP on the configured port for a phone on a trusted local
network. When disabled, Mast starts no Local HTTP listener or thread and creates
no Local HTTP token file. When enabled, the token is stored as `remote-token` in
Mast's application data directory, normally
`~/Library/Application Support/app.mast.desktop/remote-token`; the phone keeps
the pairing token in browser local storage. Do not expose this service to an
untrusted network or forward its port. See [the settings reference](SETTINGS.md)
and [ADR-0016](adr/0016-remote-surface-over-lan.md).

Secure Remote is a separate mode available from *Pair phone* and does not depend
on the `remote` setting. It opens UDP 7331 only after you start pairing. The first
phone must authenticate within 120 seconds; one phone can be connected at a time.
The host keeps its certificate, private key and token in memory. After pairing,
the browser remembers the authentication in local storage under
`mast.secure-remote.pairing.v1` and can reconnect until the certificate expires
(at most 14 days) or Mast exits. See [ADR-0028](adr/0028-secure-remote-webtransport.md).

macOS Firewall is app-based. Its rule can cover incoming connections for Mast,
including both Local HTTP (TCP) and Secure Remote (UDP); it is not limited to one
port or one transport. The pairing dialog only requests administrator approval
after you click **Allow in macOS Firewall**. macOS's own incoming-connection
prompt is a separate system prompt. Mast does not change the global firewall or
the block-all setting. When macOS block-all is enabled, an app allow rule cannot
override it; review Firewall settings in System Settings. Mast reports the app as
allowed only when it appears in the firewall's app list with incoming connections
allowed; an app that is not in that list is reported as not yet allowed, even
though `socketfilterfw --getappblocked` answers "permitted" for unlisted paths.
The application-wide
rule is keyed to the current executable and is broader than either phone mode by
itself, so a moved copy may need its own approval; add it only on networks you
trust.

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

`mast config set shell` rejects a path that does not exist or that the current
user cannot execute (symlinks are followed). A saved shell that was later
removed does not block `mast config reset shell` or setting a valid one.

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

## Startup errors

Startup configuration errors stop Mast with a native error dialog instead of
falling back to defaults. If `settings.json` cannot be read or parsed (any key,
for example `fontSize` or `remote`), the dialog names the file's absolute path
and the cause; fix the file or move it aside to start with default settings. If
the selected shell is unusable — not an absolute path to `zsh` or `bash`,
missing, not a regular file, or not executable by the current user — the dialog
says where the shell came from and how to fix it: a `shell` entry in
`settings.json` (fix or remove it), `MAST_SHELL` (fix or unset it), or the
account login shell or `$SHELL` (add `"shell": "/bin/zsh"` to `settings.json`).
Mast exits after the dialog is dismissed. If Mast cannot install its quit
confirmation (for example after an incompatible windowing-library update), it
also shows an error dialog and does not start.

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
fresh merge. If a Mast skill file cannot be installed (for example,
`~/.claude/skills/mast` is a symlink), agent hook wiring still runs; the failure
is recorded in `~/.mast/setup.log` and `mast skill-load` reports it too.
Unavailable agents are retried at a subsequent launch. The existing
`no-codex-hooks` opt-out marker remains supported; native setup also respects
`no-claude-hooks` and `no-opencode-hooks`.

If `~/.gemini/antigravity-cli` is present, native setup merges Mast's Bash hook
into `~/.gemini/config/hooks.json`. `~/.mast/no-agy-hooks` opts out. Setup records
the result in `~/.mast/.setup-macos-v<version>-agy`; a detected agy version below
1.1.10 prints a warning and setup continues. If the shared merger refuses the
existing hook contents, it leaves them unchanged and records that refusal. Repair
the file, remove the marker, and relaunch Mast to retry; setup failures without a
marker are retried on a later launch. The hook reports running and idle only; it
does not report needs-input or save a resume hint.

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
| Rename workspace | F2 (Fn+F2 on a Mac keyboard), or double-click the workspace name |
| Zoom in/out/reset | Cmd+plus / minus / 0 |
| Copy / paste | Cmd+C / Cmd+V |
| Save Markdown edits | Cmd+S |
| Reload the WebView, not the backend | Cmd+Shift+R |
| Enter/exit full screen | Ctrl+Cmd+F (View menu) |
| Quit (through the unsaved-Markdown guard) | Cmd+Q |

Inside a terminal:

| Action | macOS binding |
| --- | --- |
| Move by word | Option+Left / Option+Right (`ESC b` / `ESC f`) |
| Start / end of line | Cmd+Left / Cmd+Right (`Ctrl+A` / `Ctrl+E`) |
| Delete to start of line | Cmd+Backspace (`Ctrl+U`) |
| Clear screen and scrollback | Cmd+K |
| Scroll back a page / forward a page | Fn+Up / Fn+Down (PageUp / PageDown) |
| Scroll to top / bottom | Fn+Left / Fn+Right (Home / End) |
| Send PageUp / PageDown to the program | Shift+Fn+Up / Shift+Fn+Down |
| Select text inside a program that uses the mouse | Option+drag |
| Open a link | Cmd+click |
| Paste file paths | Drag files from Finder onto the terminal |

The Fn scroll keys act on the scrollback only in an ordinary shell screen. In a
full-screen program (vim, less, an agent on the alternate screen) or while a
program tracks the mouse they go to that program, exactly as typed. Cmd+K clears
only an ordinary shell screen; in a full-screen program it does nothing.
Cmd+C leaves the selection in place after copying. Shift+Fn+Left/Right go to the
program as xterm sends them.

Option types macOS special characters by default (Option+2 is `™`). To make
Option act as Meta (Option+B sends `ESC b`, as with Terminal.app's "Use Option
as Meta key"), set `macOptionIsMeta` and restart Mast:

```sh
mast config set macOptionIsMeta true
mast config reset macOptionIsMeta
```

Dropping files from Finder onto a terminal pane pastes their paths at the
cursor, each wrapped in single quotes (a `'` inside a name becomes `'\''`) and
separated by spaces, so names with spaces, quotes or `$` stay intact. Nothing is
run; press Return yourself. Programs that enable bracketed paste receive the
paths as one paste. A drop anywhere else (a viewer, the sidebar, a tab header)
is ignored. If any dropped name contains a control character (for example a
newline or an escape character), nothing from that drop is pasted and the
status line says why: quoting protects the name from the shell, but not from the
line editor that reads those characters as keys first.

Ctrl+C always reaches the terminal on Mac, even when text is selected. Ctrl+D,
Ctrl+W and other shell-editing keys are not app commands. IME composition is not
intercepted, and a Korean syllable still being composed is committed before any
of the keys above act. Hold Command to show button shortcut hints. Windows keeps
its existing Ctrl/Alt bindings and terminal copy/paste behavior.

## Confirmation dialogs

Closing a workspace with running terminals, discarding unsaved Markdown edits,
quitting and reloading with unsaved Markdown drafts all ask for confirmation in
a native sheet attached to the Mast window (OK / Cancel). The WebView's own
`window.confirm()` cannot be used on macOS: the windowing library's WebKit
delegate does not implement the JavaScript confirm panel, so WebKit answers
"cancel" without showing anything. If the sheet itself cannot be opened, the
action is not performed and the error appears in the status line (or the
Markdown banner).

## Quit and unsaved Markdown

Dock Quit, logout, restart and AppleScript `quit` go through the same
unsaved-Markdown confirmation as Cmd+Q. With no Markdown drafts Mast quits
immediately and never delays a logout. With unsaved drafts Mast cancels the
quit, which cancels a logout or restart the way other macOS apps do, and shows
the quit confirmation; save or discard, then quit or log out again. Mast does not
defer termination (`NSTerminateLater`). If reporting the draft state to the app
fails, the window keeps retrying until it succeeds.

Two short windows are not protected. Right after the window loads or reloads,
until it has installed its close confirmation and reported its draft state, a
quit is still turned into a window close, but nothing is there yet to confirm
it, so Mast can quit without asking. And a quit that arrives within
milliseconds of the first edit, before the window has reported it, can quit
without the confirmation.

## Shutdown contract

Closing a tab sends SIGHUP to the tab's shell (the PTY session leader) and
returns immediately; an interactive zsh or bash then hangs up its own jobs, as in
Terminal.app and on the Linux path. If the shell itself ignores HUP, Mast sends
SIGKILL to that shell only, after a 500 ms grace period, from a background
thread. Mast never signals other members of the session by PID, so jobs that
ignore HUP (`nohup`, `trap '' HUP`, `disown`) keep running after the tab closes.
When a shell exits on its own, Mast sends no signal; job cleanup follows the
shell's own rules (zsh's `HUP` option, bash's `huponexit` — which applies only to
login shells, so a Mast bash tab leaves background jobs running after `exit`).

App quit, including closing the last window, sends SIGHUP to every shell it owns,
including shells of tabs that were just closed and whose shell has not exited
yet, waits one shared grace period and sends SIGKILL to any shell still running,
before the process exits. A shell whose spawn was still in progress when quit
began gets the same SIGHUP, grace and SIGKILL once the spawn finishes, and quit
waits for that — up to 6 seconds, after which it exits without it. The shell's PID is kept unreaped until Mast has
finished signalling it, so a reused PID is never signalled. A HUP-ignoring job
that keeps the terminal open and prints nothing holds that tab's output reader
thread until it writes or exits. No daemon, tmux server or always-on process
watcher is introduced.

Final app shutdown rejects late/restored-tab spawns and suppresses exit callbacks
that would otherwise mark saved Running tabs as Exited. Thus reopening the app
restores shells/layout, but does not restart agents automatically. `Workspace.distro`
remains in the shared model; new Mac workspaces use `None`, and native execution
and filesystem access ignore the field even in imported states.

Force Quit / `kill -9` bypasses application cleanup, and processes that
intentionally daemonize into an independent POSIX session are outside this
normal-shutdown guarantee. Mast itself does not create such persistent sessions.

## Verification

Automated native tests cover PTY lifetime with real interactive shells: closing
a tab ends ordinary jobs and spares HUP-ignoring ones, a HUP-ignoring shell is
killed after the grace period without blocking the close, natural exit leaves
job handling to the shell, and app quit ends every owned shell (including
just-closed tabs) after one shared grace period. They also cover
shutdown/restoration callback suppression, zsh startup ordering/custom
ZDOTDIR, bash profile/history isolation, missing-directory fallback, resume hint
validation, native CLI protocol/quoting and failed-send handling, safe config
merging, and Mac key maps.

```sh
cargo test -p mast-core --locked
cargo test -p mast-remote --locked
cargo test -p mast-app --locked
python3 -m unittest discover -s scripts/macos/tests -v
cd apps/mast && npm run build && npm test
```

### Feature-parity field checks (pending)

These checks have not been recorded as passed. Run them on the target Mac before
treating these features as field-verified:

- Open the Changes viewer in a normal repository and a bare-container workspace.
- Confirm the startup notice appears only for a newer stable release and behaves
  quietly when offline.
- Verify Local HTTP is absent with `remote` unset, then pair over HTTP after
  enabling it and fully restarting Mast.
- Start Secure Remote, authenticate, reconnect from the same phone, test the
  one-connection limit, and confirm app exit ends the host session.
- Inspect the current macOS Firewall state; where the host state permits, test
  allow and decline. Confirm block-all is reported if already enabled; do not
  change global firewall settings for this check.
- Install agy, observe running/idle, check the below-1.1.10 warning path, test
  `no-agy-hooks`, and verify repair plus marker removal retries a refused merge.
- Run the manager workspace preview checks (M1–M9): enabling needs the codex CLI; the pinned
  workspace and its order, the board header and log, transcript collection from two workspaces,
  core-only needsInput toasts, `mast manager start` with the digest fallback and `mast manager
  patch` board refresh, a killed harness recovering, archive → Resume/Start fresh, plan cards,
  and preview-off removal with `~/.mast/manager` kept.

Do not record any of these manual checks as complete until they have actually
been run.

Before treating a source build as daily-driver-ready, also run this device checklist:
create several workspaces and split panes; run each installed agent; observe
running/needs-input/idle transitions and notification permissions; exchange
literal/submitted `mast send` messages and inspect `mast ls`; quit/reopen and
resume each agent; verify shells and ordinary dev-server jobs end at tab close and
at quit, while a `nohup`/`trap '' HUP` job survives both; edit a Markdown tab
without saving and choose Quit from the Dock menu — Mast stays open and shows the
quit confirmation, cancelling keeps it running and confirming quits, and with no
unsaved edits Dock Quit quits immediately and tabs restore on relaunch; with an
unsaved Markdown edit, log out — the logout is cancelled and Mast shows the quit
confirmation, and with no drafts logout proceeds without Mast stopping it;
open/edit/save Unicode-path files; check Korean IME, clipboard/image paste,
resizing, scrolling and Cmd shortcuts. For the terminal keys: Option+Left/Right
move by word at a zsh and a bash prompt; Cmd+Left/Right/Backspace edit the line,
including right after typing a Korean syllable; Cmd+K clears a long scrollback
but leaves vim untouched; Fn+arrows scroll a long `seq 1 1000` output but reach
`less`/vim; Shift+Fn+Up reaches `less`; Option+drag selects inside a program with
mouse tracking; a link opens on Cmd+click only; `macOptionIsMeta` changes
Option+B from `∫` to a word move after a restart. Close a workspace with a
running shell and cancel/confirm the sheet; discard Markdown edits; Cmd+Q and
Dock Quit with a draft, also with the window minimized (it comes forward with
the sheet); Cmd+Shift+R with a draft. Double-click a workspace name
(also on a non-active card) and rename it. Drag one and several Finder files
(names with spaces and a `'`) onto a pane, onto a split pane's other half on a
Retina display, and onto a viewer; drop a file whose name contains a newline —
nothing is pasted and the status line explains why. Insert an emoji from the
Character Viewer and pick a Hanja candidate with the mouse while a Korean
syllable is being composed — both reach the shell at once; Finder Cmd+C on a
file then Cmd+V in a pane does not send Ctrl+V. Use View › Toggle Full Screen (Ctrl+Cmd+F). Compile/unit-test success is not a claim
that authenticated agent sessions or native GUI behavior were exercised on a
physical device.
