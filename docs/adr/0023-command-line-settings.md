# ADR-0023: Command-line settings without a settings-write terminal channel

Status: accepted (2026-09-13)

## Context

Users needed to enable phone access and change fonts without finding a Windows JSON file.
They chose a command-line interface and restart-only application over a settings window or
live reconfiguration. The existing `mast` CLI sends OSC sequences through terminal output;
extending that channel to global configuration would let displayed output request settings
changes, including opening a LAN listener.

## Decision

`mast config` invokes a provisioned Python standard-library helper. It resolves the Windows
Application Data directory through a fixed PowerShell command, converts the path with `wslpath`,
and reads or updates `app.mast.desktop/settings.json` directly. No OSC command, app IPC handler,
daemon, timer or new tab kind is introduced. The script is embedded from its source file into
setup v13 rather than maintaining a second copy.

`set remote [true] [--port N]` is an explicit enable action. Omitting the port writes 7331;
`set remote false` and `reset remote` remove the key. An existing custom port is not implicitly
retained by a port-less enable command. The stored schema stays `{"remote":{"port":7331}}`:
the app still requires an explicit port in JSON, and an untouched installation stays off.
This preserves ADR-0016's opt-in listener and compatibility with earlier builds.

The helper validates known settings before and after a mutation, preserves unknown keys,
and refuses corrupt or oversized input. Writes use a same-directory temporary file followed
by replacement. An atomic directory lock prevents cooperating CLI writers, including different
distributions targeting the same Windows file, from losing one another's changes. A busy lock
fails immediately. A lock left by a killed writer requires manual removal after confirming the
writer is no longer running; external editors do not observe this protocol.

Output identifies saved overrides separately from built-in defaults, never as a live-state
query. All changes request a full app restart and warn that it ends running terminal processes.
No automatic restart or firewall change is performed.

## Consequences and verification

Configuration now depends on Python 3, Windows interop, PowerShell, `wslpath` and Windows drive
access when invoked. A locked-down distribution can still use mast's terminals and manually
edit the JSON from Windows. A local process with the user's filesystem authority can edit the
file; the helper is not a sandbox for same-user programs. Printed terminal text alone gains no
new authority.

Python validation mirrors the existing Rust settings reader rather than adding a native CLI
binary or another dependency. Changes to accepted fields, ranges or highlight languages must
update both validators and the CLI contract tests. The settings-file reader remains unchanged.

Tests execute the real helper against temporary files, check input rejection and original-file
preservation, lock handling, remote defaults/overrides/disable, and provisioned command routing.
The Windows field check uses a disposable file on the Windows drive, not the running app's
settings. A full quit/relaunch with a changed setting remains a release field check: it must
not be automated while users have active agent sessions.
