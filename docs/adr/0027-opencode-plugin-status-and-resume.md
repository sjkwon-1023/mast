# ADR-0027: OpenCode plugin status and per-tab resume hints

- Status: accepted
- Date: 2026-09-16

## Context

mast already routes `OSC 777;notify;mast:*` by the receiving PTY and restores a
tab's last agent command through `~/.mast/resume/tab-<id>`. OpenCode has no command
hook comparable to Claude Code's hooks or Codex's notify setting. OpenCode 1.18.31
loads JavaScript plugins in its default TUI server Worker, inside the process attached
to the tab's PTY. The previous backlog described a detached server; that does not
describe this default TUI mode.

## Decision

Provision one global OpenCode plugin, using the existing `mast-notify.sh` for OSC
delivery. The plugin maps busy, permission, question, and idle events onto the three
existing mast statuses. It closes the notifier's stdin and suppresses Bun shell echo.
Repeated states are coalesced; child idle never makes the tab idle.

The plugin writes `opencode --session <id>` to the existing per-tab resume file when
the root session is created or first observed. `parentID` distinguishes children;
an unknown session must be read through OpenCode's session API before its id is
recorded. The host's shell wrapper accepts this exact command form and places it in
history without running it. The global plugin is owned only while its bytes match
mast's recorded digest; a pre-existing or edited file is preserved.

## Consequences

The core OSC parser and frontend remain agent-neutral. No service runs when OpenCode
is absent. A setup-version bump installs the plugin on the next mast launch, while an
already running OpenCode process needs a restart to load it. This integration covers
the default TUI observed in 1.18.31. `--pure`, `serve`, `web`, `attach`, and the beta
`opencode2` have no verified tab PTY attribution and are outside scope. Real Windows
mast notification and restart behavior remain manual field checks in
`docs/WINDOWS-BUILD.md`.
