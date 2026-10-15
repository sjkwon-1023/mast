# ADR-0033: Unsigned releases installed by a script

- Status: accepted
- Date: 2026-10-01

## Context

The macOS port shipped as a source build only: a user needed Xcode Command Line Tools, Rust
and Node and a several-minute build before the first launch. Windows releases attach a bare
exe that users download with a browser. A downloadable app normally needs a Developer ID
signature and notarization (macOS) or an Authenticode signature (Windows), which costs a
yearly certificate and secrets in CI.

Without a signature, a browser download is marked as coming from the internet and the OS
checks it: macOS Gatekeeper blocks a quarantined app with no right-click override, and
SmartScreen warns about an unsigned exe. Both checks key on that mark —
`com.apple.quarantine` on macOS, the Mark of the Web on Windows — and quarantine-aware apps
(browsers, Mail, AirDrop) add it while `curl`/`curl.exe` do not. On Apple Silicon a binary
must still carry a signature to run, and the Rust linker already ad-hoc signs it.

## Decision

1. A `macos-artifacts` CI job, on the same triggers as `windows-artifacts` (`workflow_dispatch`
   and `v*` tags), builds `mast.app` for `aarch64-apple-darwin` on a macOS runner and attaches
   `mast-macos-arm64.zip` to the release. The repository config keeps bundling off; the job
   enables the `.app` bundle on the command line.
2. The supported install paths are scripts run straight from the repository:
   `scripts/macos/install.sh` (`curl … | bash`) and `scripts/win/install.ps1` (`irm … | iex`,
   Windows PowerShell 5.1 or later). Both download the release asset with `curl`, check it
   (a `mast.app` in the zip; an `MZ` executable) and only then replace the installed copy in
   `/Applications/mast.app` or `%LOCALAPPDATA%\Programs\mast\mast.exe`.
3. The same line updates. It reads the latest tag from where `/releases/latest` redirects (no
   API call, no JSON parser) and downloads nothing when the installed version matches
   (`CFBundleShortVersionString`; the exe's numeric file version). `MAST_DOWNLOAD_URL` (a
   pinned asset, no version check), `MAST_REPO_URL` and `MAST_APP_DIR` override the source and
   destination.
4. A running Mast is replaced without quitting it; the new version applies on the next launch.
   Neither script overwrites a file in place — macOS can kill a process whose executable is
   rewritten under it, and Windows refuses to write or delete a running exe.
   - macOS: the new bundle is copied next to the old one, the old one is removed and the new
     one renamed into place; the running process keeps the unlinked old files.
   - Windows: a running exe can still be renamed within its folder, so the old exe moves to
     `mast.exe.old-<ticks>`, the new one takes its name, and the next install removes old
     copies that are no longer running.
5. The app does not update itself; the release notice keeps only linking to the release page
   (ADR-0024). A user can start the same installer from a terminal with `mast update`; that is a
   user-invoked CLI action and does not change this decision (see the 2026-10-15 amendment).
6. No code signing or notarization for now.

## Consequences

- A browser download is blocked (macOS) or warned about (Windows); the docs point to the
  scripts. Windows Smart App Control blocks the unsigned exe regardless of how it was
  downloaded.
- macOS: each build has a different ad-hoc identity, so macOS may ask again for permissions
  (notifications, automation) after an update, and the macOS Firewall allowance for Local
  HTTP and Secure Remote may need to be granted again.
- Windows: the firewall rule and the Start-menu shortcut that carries the toast identity are
  bound to the exe path, so updating in place keeps them. A user who ran the exe from another
  folder grants them again once for the new path.
- Notifications on macOS keep using the `osascript` transport (docs/MACOS.md); a signed
  identity would change that path and must be verified when signing is added.
- Signing is the next step once external users make the browser-download path or the
  permission prompts a real cost.

## Amendment (2026-10-15) — `mast update` runs the installer

This amendment adds a user-started path next to Decisions 2–4 and clarifies Decision 5. The app
still does not update itself: the startup notice (ADR-0024) only opens the release page, and
nothing runs `mast update` on launch, from that notice, or on an agent's own initiative.

`mast update` is a subcommand of the CLI: the WSL `mast` on Windows and the native `mast` on
macOS. Both start the installer script that the one-line install uses, from the `main` branch of
`sjkwon-1023/mast`:

- The command takes no arguments. Any argument prints `usage: mast update` to stderr and exits 2
  before any check, process start or network request.
- The URL is fixed (`scripts/win/install.ps1` or `scripts/macos/install.sh`). It is not built from
  arguments or environment variables and is not pinned to a commit, so it carries the same trust
  in the repository's scripts as the one-line install.
- stdin, stdout and stderr stay attached to the terminal, and the installer's exit status is
  returned unchanged. The CLI adds no success message. It does not compare versions, replace
  files, or quit or restart Mast. The installer's version check and replacement rules (Decisions 3
  and 4) apply unchanged, and its "quit and reopen" message is the only guidance on applying the
  update.

Windows (`cmd_update` in the WSL CLI, `apps/mast/src-tauri/src/provision.rs`):

- It requires WSL interop. It reads the first line of `/proc/sys/fs/binfmt_misc/WSLInterop` and
  `WSLInterop-late`, the same check `mast-open` makes, and exits 1 unless one of them reads
  `enabled`.
- It runs the `powershell.exe` found on PATH; otherwise it uses
  `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`. As in `mast-open`, the PATH
  lookup (`command -v`) skips entries that are not executable, so such an entry leads to the
  fallback. A `powershell.exe` that is found but fails to start is not retried through the
  fallback; the shell's exec failure status is returned. When neither path is executable, the
  command exits 1. Other drive mounts are not searched, so with Windows mounted elsewhere and no
  `powershell.exe` on PATH, the command fails.
- It `exec`s `powershell.exe -NoLogo -NoProfile -NonInteractive -Command` with
  `$ErrorActionPreference = 'Stop'; irm <install.ps1> | iex`. Setting the preference before `irm`
  makes a failed download stop the command, so `iex` cannot succeed on empty input.
- The command does not change `WSLENV`. WSL passes variables to Windows only through the user's
  `WSLENV`, so an override such as `MAST_APP_DIR` must be set on the Windows side or listed there.
  The CLI does not convert paths; the `/p` flag in the user's `WSLENV` is the only translation.

macOS (`update` in `scripts/macos/mast.py`):

- It runs `set -o pipefail; curl -fsSL <install.sh> | /bin/bash` under `/bin/bash -c`, through
  `os.execv`. The outer Bash needs `pipefail`: without it, a curl failure such as exit 22 would be
  hidden by the inner Bash, which exits 0 on empty input. With it, the pipeline reports curl's
  status.
- The environment is inherited unchanged, so `MAST_DOWNLOAD_URL`, `MAST_REPO_URL` and
  `MAST_APP_DIR` apply exactly as they do to the one-line install.

Distribution:

- Windows `SETUP_VERSION` moves from 22 to 23. A distro that has only the v22 marker reruns the
  full setup once, which can reapply the managed agent blocks and hooks, and then installs the new
  CLI. The v23 marker is written at the end of setup, so a setup that stops earlier leaves it
  absent and the next launch retries.
- macOS has no setup version. Mast replaces the bundled `bin/mast.py` at startup when its content
  differs (`platform/macos.rs`, `initialize`).
- The first install of a version with `mast update` is the existing one-line install. The command
  appears once Mast has started with that version.

Verification status (2026-10-15):

- Automated, offline, passed: `npx vitest run tests/hook-example.test.ts tests/provision-setup.test.ts`
  in `apps/mast`; `python3 scripts/macos/tests/test_native.py` (its five macOS-only shell-setting
  cases are skipped on Linux) and `python3 scripts/macos/tests/test_transport.py`. The WSL tests
  replace PowerShell with a test double and the macOS tests replace curl with a test double; no
  installer runs.
- Not run on a device, so not verified: real Windows PowerShell execution from WSL, a WSL distro
  with `appendWindowsPath=false`, and `mast update` on an Apple Silicon Mac through the installer.
