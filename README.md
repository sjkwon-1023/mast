# mast

[![CI](https://github.com/sjkwon-1023/mast/actions/workflows/ci.yml/badge.svg)](https://github.com/sjkwon-1023/mast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Run several coding agents on Windows + WSL2 and see which one is waiting for you — from your
desk or from your phone.**

<!-- TODO: screenshot — docs/images/overview.png: the sidebar with three workspaces
     (running / needs input / idle), a split pane with a Markdown viewer open, the Pair-phone QR. -->

## What it's for

You are running Claude Code, Codex and a couple of shells at once, and each stops to ask you
something at a moment you cannot predict. A plain terminal hides that — the agent waiting for an
answer looks exactly like the one still working, and you find out by cycling through windows.

mast keeps a status card per workspace (running, needs input, done) with the agent's last message,
notifies you when one starts waiting, and lets you answer from your phone if you have walked away.

## Why mast

- **See who needs you at a glance** — a waiting agent does not disappear behind another terminal.
- **Stay in one tool** — split panes and tabs, plus folder, text and Markdown viewers, without
  opening an IDE.
- **Answer from the couch** — pair a phone over your Wi-Fi, read a tab, scroll a full-screen TUI,
  send input.
- **Portable** — a single executable. No installer, no setup wizard.
- **Reload any time** — `Ctrl+Shift+R` rebuilds the window; the shells and agents keep running.

Most agent multiplexers are built for macOS and Linux terminals. mast is the one built for Windows
and WSL2.

## Requirements

Windows 11 (x64 or ARM64), WSL2 with at least one distribution, and the WebView2 runtime that ships
with Windows 11. mast opens WSL2 shells only — there is no PowerShell or CMD profile.

## Features

- **Split panes** — split either way, drag to resize, `Alt`+arrows to move focus. A new pane or tab
  opens in the directory the pane's shell is in.
- **Tabs inside panes** — every pane has its own tab strip; background tabs stay alive.
- **Agent status and notifications** — Claude Code and Codex report running / needs input / idle to
  the sidebar, and a Windows toast fires when one starts waiting.
- **Pane-to-pane text passing** — send text to another pane, where it runs on arrival unless you ask
  to pre-fill the prompt instead.
- **Viewer tabs** — folder browser, text viewer and Markdown viewer for files inside WSL.
  The pane-header Changes button opens changed files and a selected unified diff, with
  Working / Staged / All scopes. It is read-only, refreshes when reopened or with Refresh,
  and limits each diff to 512 KiB. Git and GNU `timeout` must be installed in that WSL distro.
- **Phone remote (opt-in)** — pair by QR, then read a tab, scroll a full-screen TUI, or send input.
  Off by default; plain HTTP on your own LAN — see [`docs/SETTINGS.md`](./docs/SETTINGS.md). If
  the phone cannot connect, the pairing dialog says whether Windows Firewall allows the app and
  writes the rule for you behind one UAC prompt.
- **Layout persistence** — workspaces, splits and tabs come back, each shell respawned where it was,
  and a tab that was running an agent returns with its resume command one `Up` away.

## Installing

Download the build for your CPU from the
[latest release](https://github.com/sjkwon-1023/mast/releases/latest) and run it. Releases up to
and including v0.3.20 predate the rename and are named `winmux-x64.exe` / `winmux-arm64.exe`; from
the next one on they are `mast-x64.exe` / `mast-arm64.exe`. It is unsigned either way, so
SmartScreen warns on first launch: **More info** → **Run anyway**.

To build from source, see [`docs/WINDOWS-BUILD.md`](./docs/WINDOWS-BUILD.md).

## Setup

mast spawns into the WSL default distribution. To point it elsewhere — useful if you keep a
locked-down distribution for agent work:

```powershell
$env:MAST_DISTRO = "Ubuntu-24.04"      # current shell
setx MAST_DISTRO "Ubuntu-24.04"        # persist for your user account
```

Agent status wiring is automatic: mast provisions its Claude Code and Codex notification helpers in
each distribution it uses, and a failure is logged rather than silently changing your shell. The
contract and the manual fallback are in
[`scripts/wsl/claude-hook-example.md`](./scripts/wsl/claude-hook-example.md).

## Settings

There is no settings screen. Write `%AppData%\app.mast.desktop\settings.json` and restart:

```json
{
  "fontFamily": "Cascadia Code, monospace",
  "fontSize": 15,
  "log": false,
  "remote": { "port": 7331 }
}
```

Every key is optional, and a bad file reports itself in the status line instead of being silently
ignored. Full reference: [`docs/SETTINGS.md`](./docs/SETTINGS.md).

## Keyboard shortcuts

Global shortcuts are all `Ctrl+Shift`, so plain `Ctrl` combinations stay with your shell. Anything
not listed goes straight to the PTY.

| Key | Action |
|---|---|
| `Ctrl+1` … `Ctrl+9` | Switch workspace by sidebar position |
| `Alt+↑ ↓ ← →` | Move focus to the adjacent pane |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs in the active pane |
| `Ctrl+Shift+T` | New terminal tab |
| `Ctrl+Shift+B` | New folder browser tab |
| `Ctrl+Shift+W` | Close the active tab |
| `Ctrl+Shift+D` | Split the pane top/bottom |
| `Ctrl+Shift+E` | Split the pane left/right |
| `Ctrl+Shift+N` | New workspace |
| `Ctrl+Shift+R` | Reload the window |
| `Ctrl+V` / `Ctrl+Shift+V` / `Shift+Insert` | Paste |
| `Ctrl+C` / `Ctrl+Shift+C` | Copy when there is a selection — a bare `Ctrl+C` with no selection still sends SIGINT |

Drag workspace cards to reorder them; `Ctrl+1`–`Ctrl+9` follow that order. The full list, including
viewer-local keys, is in [`apps/mast/src/keys.ts`](./apps/mast/src/keys.ts).

## Troubleshooting

**A tab opens but stays empty, or running sessions stop responding.** This is usually WSL under
memory pressure rather than mast: the VM cannot find contiguous memory for the channel a new
terminal needs, and processes already running start thrashing. A tab whose shell never came up says
so and offers Retry; sessions that were already running have to be started again.

WSL2 defaults to half the host RAM with a swap file a quarter that size, which a container build or
a large compile can exhaust. Raising swap in `%UserProfile%\.wslconfig` usually settles it:

```ini
[wsl2]
swap=8GB
autoMemoryReclaim=gradual
```

`wsl --shutdown` applies it — that ends every WSL session, so do it between tasks.

## Status

One maintainer, used daily. Tested on an x64 Windows 11 desktop; ARM64 is built and linted on every
release but has never run on real hardware.

## License

MIT — see [LICENSE](./LICENSE).
