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
   (ADR-0024).
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
