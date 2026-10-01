# ADR-0033: Unsigned macOS release installed with curl

- Status: accepted
- Date: 2026-10-01

## Context

The macOS port shipped as a source build only: a user needed Xcode Command Line Tools, Rust
and Node and a several-minute build before the first launch. A downloadable app normally
needs a Developer ID signature and notarization, which costs an Apple Developer Program
membership and secrets in CI. Without them, a browser download is quarantined and current
macOS blocks the app with no right-click override, only a trip to System Settings.

Gatekeeper only assesses files that carry `com.apple.quarantine`. That attribute is added by
quarantine-aware apps (browsers, Mail, AirDrop); `curl` does not add it. On Apple Silicon a
binary must still carry a signature to run, and the Rust linker already ad-hoc signs it.

## Decision

1. A `macos-artifacts` CI job, on the same triggers as `windows-artifacts` (`workflow_dispatch`
   and `v*` tags), builds `mast.app` for `aarch64-apple-darwin` on a macOS runner and attaches
   `mast-macos-arm64.zip` to the release. The repository config keeps bundling off; the job
   enables the `.app` bundle on the command line.
2. The supported install path is `scripts/macos/install.sh`, fetched and run with `curl … |
   bash`. It downloads the latest zip with `curl`, unpacks it to a temporary folder and
   replaces `/Applications/mast.app` only after the download contains `mast.app`. A running
   Mast is replaced too: the new bundle is copied next to the old one, the old one is removed
   and the new one renamed into place, so the running process keeps the unlinked old files
   and the new version applies on the next launch. The script never overwrites a file in
   place — macOS can kill a running process whose executable is rewritten under it. The same line updates: it reads the latest tag
   from where `/releases/latest` redirects (no API call, no JSON parser) and downloads nothing
   when the installed `CFBundleShortVersionString` matches. `MAST_DOWNLOAD_URL` (a pinned zip,
   no version check), `MAST_REPO_URL` and `MAST_APP_DIR` override the source and destination.
3. The app does not update itself; the release notice keeps only linking to the release page
   (ADR-0024).
4. No Developer ID signing or notarization for now.

## Consequences

- A zip downloaded with a browser is blocked; the docs point to the script instead.
- Each build has a different ad-hoc identity, so macOS may ask again for permissions
  (notifications, automation) after an update, and the macOS Firewall allowance for Local
  HTTP and Secure Remote may need to be granted again.
- Notifications keep using the `osascript` transport (docs/MACOS.md); a signed identity would
  change that path and must be verified when signing is added.
- Signing and notarization are the next step once external users make the permission
  prompts or the browser-download block a real cost.
