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
   bash`. It downloads the latest zip with `curl`, refuses to replace an app that is running
   from the target folder, unpacks to a temporary folder and replaces `/Applications/mast.app`
   only after the download contains `mast.app`. The same line updates: it reads the latest tag
   from where `/releases/latest` redirects (no API call, no JSON parser) and downloads nothing
   when the installed `CFBundleShortVersionString` matches. `MAST_DOWNLOAD_URL` (a pinned zip,
   no version check), `MAST_REPO_URL` and `MAST_APP_DIR` override the source and destination.
3. The app does not update itself; the release notice keeps only linking to the release page
   (ADR-0024).
4. No Developer ID signing or notarization for now.

## Consequences

- A zip downloaded with a browser is blocked; the docs point to the script instead.
- Each build has a different ad-hoc identity, so macOS may ask again for permissions
  (notifications, automation) after an update.
- Notifications keep using the `osascript` transport (docs/MACOS.md); a signed identity would
  change that path and must be verified when signing is added.
- Signing and notarization are the next step once external users make the permission
  prompts or the browser-download block a real cost.
