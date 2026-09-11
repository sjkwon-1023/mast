# ADR-0012 — Opening links from a terminal tab

Status: accepted (2026-08-20) · Verification: WINDOWS-BUILD §10 v0.3.10 item 3

## Context

A user reported that clicking a URL in a mast tab did nothing, and that OAuth logins never
reached the browser either. They assumed it was a WSL problem. It was not — or rather, it was
two problems, only one of which is on the WSL side.

Nothing in the stack could open a link:

- **xterm had no link machinery.** The terminal was constructed with no `linkHandler` and no
  web-links addon, so a printed URL was never a link to begin with — there was nothing to click.
- **There was nowhere to send one.** No Tauri command opened a URL, and neither
  `tauri-plugin-opener` nor `tauri-plugin-shell` was a dependency.
- **The webview's own escape hatches are blocked or harmful.** `window.open()` returns null
  because wry marks every `NewWindowRequested` as handled when no handler is registered, while
  top-level navigation *is* allowed — a plain `<a href>` would replace the entire app UI with the
  website. CSP is not the blocker here; `csp` is `null`.
- **WSL had no opener at all.** `xdg-open`, `wslview` and `x-www-browser` are all absent on a
  stock distro and `$BROWSER` is unset, so Claude Code — which execFiles `$BROWSER ?? xdg-open` —
  gets `ENOENT` and degrades to "copy this URL manually". Its headless escape hatch never fires
  under WSL, so it always believes a browser is openable.

Everything *outside* the app was healthy: interop is enabled, Chrome is the registered default
handler, and invoking it from WSL hands the URL to the already-running Chrome session rather than
starting a second one (measured).

So the two symptoms have two different causes: an agent printing a URL is the front-end gap, and
an OAuth CLI opening a browser itself is the WSL gap. Fixing either alone leaves the user with
half a feature.

## Decisions

1. **Clicking is fixed in the front end plus one Rust command.** `@xterm/addon-web-links` does the
   detection, underlining and wrapped-line stitching; our handler decides whether to act; a new
   `open_url` command hands the URL to `ShellExecuteW`.

   Not `tauri-plugin-opener`: that would re-introduce the JS plugin surface this project
   deliberately removed in v0.3.7, and the first non-core permission in the capability file. The
   Rust side already has the pattern to copy — `pick_workspace_folder` is a `#[cfg(windows)]`
   command that does its blocking work in `spawn_blocking` and fails loudly on unix.

2. **`ShellExecuteW`, not a command line.** `cmd /c start <url>` needs quoting for `&`, which is
   ordinary in OAuth callback URLs, and the cost of getting that wrong is arbitrary command
   execution. `ShellExecuteW` takes the URL as an argument, so there is no command line to quote.

3. **http/https only, enforced on both sides, plus a mouse-mode gate.** The front end refuses
   anything else and the Rust command refuses it again, because the command is callable by any
   code in the webview — the front-end check is UX, not a contract. `ShellExecute` will launch any
   registered protocol handler (`file:`, `ms-settings:`, third-party schemes), and anything that
   can print text into a terminal could otherwise aim at that surface. The gate on
   `mouseTrackingMode` keeps clicks inside a TUI (vim, tmux, an agent's own UI) belonging to that
   TUI.

4. **The WSL side gets a provisioned opener installed as `xdg-open`, not a `$BROWSER` export.**
   `~/.mast/bin` is already first on `PATH` for mast shells, and `xdg-open` is the name
   callers already try, so the shim is picked up with no further wiring — and only inside a mast
   tab. Exporting `BROWSER` was rejected because Codex handles WSL well on its own path and a
   `BROWSER` value would take it off that path.

5. **The URL never travels on a Windows command line there either.** `mast-open` puts the value
   in an environment variable, adds it to `WSLENV`, and PowerShell reads it back as
   `$env:MAST_OPEN_TARGET`. It also refuses anything that is neither an http(s) URL nor an
   existing path (paths go through `wslpath -w`, since callers use `xdg-open` for files too), and
   it checks that interop is actually enabled before trying — failing loudly, because a silent
   no-op looks exactly like "the browser did not open". Only the **first line** of
   `/proc/sys/fs/binfmt_misc/WSLInterop` is the state; the file continues with the interpreter,
   flags, offset and magic. Comparing the whole file silently disabled the opener until a test
   caught it.

## Consequences

- Inside a mast tab, `~/.mast/bin/xdg-open` shadows a system `xdg-open` the user might install
  later (wslu, for instance). Outside a mast tab nothing changes. This is the cost of the name
  that makes it work without configuration.
- `SETUP_VERSION` goes to 8, so every existing user re-runs provisioning once. It is idempotent,
  but it does rewrite the notify scripts and re-touch `~/.claude/settings.json`.
- Clicking is a two-hop path: the front end asks the Rust side, which asks Windows. A failure at
  either hop reaches the console rather than the user's face — acceptable for a click, and the
  same "no runtime log file" backlog item applies.
- The link surface only exists where xterm renders text. Viewer tabs (markdown, text) have their
  own link handling and are untouched by this ADR.
