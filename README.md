# mast

[![CI](https://github.com/sjkwon-1023/mast/actions/workflows/ci.yml/badge.svg)](https://github.com/sjkwon-1023/mast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Run several coding agents on Windows + WSL2 and see which one is waiting for you — from your
desk or from your phone.**

![Demo of sending a command from the phone remote to a desktop terminal](docs/image/mast-mobile-command-demo.gif)

Check terminal output and send input from your phone on the same trusted local network as your PC.

## What it's for

You are running Claude Code, Codex and a couple of shells at once, and each stops to ask you
something at a moment you cannot predict. A plain terminal hides that — the agent waiting for an
answer looks exactly like the one still working, and you find out by cycling through windows.

mast keeps a status card per workspace (running, needs input, done) with the agent's last message,
notifies you when one starts waiting, and lets you answer from your phone even while lying in bed.

## Why mast

- **A lightweight agent terminal** — run several coding agents in one Windows + WSL2 workspace
  and see who needs you at a glance, without an IDE runtime.
- **Stay in one tool** — split panes and tabs, plus folder, text and Markdown viewers, without
  opening an IDE.
- **Control your terminals from bed** — pair a phone on the same local network as your PC,
  read output and send input to agent CLIs or ordinary Bash shells.
- **Let agents talk to each other** — agents can use `mast ls` and `mast send` inside their
  terminals to hand work to another pane in the same workspace.
- **Resume with Up** — after restarting mast, press `Up` in a restored Bash pane to recall
  its saved Claude Code or Codex resume command, then `Enter` to continue the conversation.
  This resumes the agent's saved session; the old process does not stay running after exit.
- **Portable** — a single executable. No installer, no setup wizard.
- **Reload any time** — `Ctrl+Shift+R` rebuilds the window; the shells and agents keep running.

Most agent multiplexers are built for macOS and Linux terminals. mast is the one built for Windows
and WSL2.

## Features

- **Split panes** — split either way, drag to resize, `Ctrl+Shift`+arrows to move focus. A new pane or tab
  opens in the directory the pane's shell is in.
- **Tabs inside panes** — every pane has its own tab strip; background tabs stay alive.
- **Agent status and notifications** — Claude Code and Codex report running / needs input / idle
  for each tab, and Antigravity CLI reports running / idle. The sidebar card shows the most urgent
  tab, the waiting tab gets its own badge, and a Windows toast names the tab that starts waiting.
- **Agent-to-agent communication** — `mast ls` discovers tabs and `mast send '#<id>' 'text'`
  sends input to another agent or shell in the same workspace (`-l` pre-fills without submitting).
- **Viewer tabs** — folder browser, text viewer and Markdown viewer for files inside WSL.
  The pane-header Changes button opens changed files and a selected unified diff, with
  Working / Staged / All scopes. It is read-only, refreshes when reopened or with Refresh,
  and limits each diff to 512 KiB. Git and GNU `timeout` must be installed in that WSL distro.
- **Phone terminal control (opt-in)** — pair by QR, then read output, scroll a full-screen TUI,
  or send input to an agent CLI or a regular Bash shell. It is not limited to agent prompts.
  **Local-network use only:** your PC and phone must be on the same trusted LAN, typically
  the same home router. The PC can use Ethernet while the phone uses Wi-Fi. Mobile data
  (4G/5G) or an unrelated Wi-Fi network does not connect through mast; there is no cloud relay.
  Guest Wi-Fi or client isolation can block access even on the same router.
  Off by default; plain HTTP, not for public internet exposure or port forwarding — see
  [`docs/SETTINGS.md`](./docs/SETTINGS.md). If
  the phone cannot connect, the pairing dialog says whether Windows Firewall allows the app and
  writes the rule for you behind one UAC prompt.
- **Layout persistence** — workspaces, splits and tabs come back, each shell respawned where it was,
  and a tab that was running an agent returns with its resume command one `Up` away.

## Install

**Requirements:** Windows 11 (x64 or ARM64), WSL2 with a Linux distribution such as Ubuntu,
and WebView2 (normally included with Windows 11).

1. **Prepare WSL2.** If needed, run `wsl --install` in administrator PowerShell, restart Windows,
   then open Ubuntu and create your Linux user account.
   [WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install).
2. **Prepare your agents.** Install Claude Code, Codex or Antigravity CLI inside WSL before first
   launching mast. On Ubuntu, install the integration helpers with
   `sudo apt install python3 jq coreutils`; Claude Code approval tracking and every Codex hook
   need Python 3.8 or later.
   Agents are optional if you only want Bash terminals.
3. **Download and run.** Get `mast-x64.exe` or `mast-arm64.exe` from the
   [latest release](https://github.com/sjkwon-1023/mast/releases/latest) and run it — no installer.
   If SmartScreen warns, verify the download came from this repository, then choose
   **More info** → **Run anyway**.

mast opens your default WSL distribution and automatically sets up agent integration on first
launch. Anything it could not set up, and what to do about it, is written to `~/.mast/setup.log`.

- **Claude Code** needs nothing more. With Python 3.8+ and Claude Code 2.1.118 or later, a tab
  that asked for approval shows running again as soon as the approved tool finishes.
- **Codex** needs one step from you. mast installs its hooks in `~/.codex/hooks.json` (always
  `~/.codex`; a custom `CODEX_HOME` is not followed), and Codex runs none of them until you trust
  them in the **Hooks need review** prompt at its next launch. Until you do, that prompt returns
  on every Codex launch. To decline for good, create `~/.mast/no-codex-hooks` and delete mast's
  entries from that file. With a Python older than 3.8 mast installs no Codex hooks, and a Codex
  tab reports only idle, at the end of each turn; without python3 at all, setup stops before
  wiring any agent and prints a notice.
- **Antigravity CLI** reports running and idle only: it has no hook for a pending approval.

[Integration details and manual setup](./scripts/wsl/claude-hook-example.md).

The sidebar shows your installed version. Once per app launch, mast checks GitHub for a newer
stable release in the background. **Update available** opens the release page; downloading,
replacing the executable and restarting are up to you. Failed checks stay quiet.

## Settings

Run these commands in a mast Bash pane:

```sh
mast config
mast config set fontSize 15
mast config set remote                  # enable phone access on port 7331
mast config set remote --port 7441      # enable it on a different port
mast config set remote false            # disable phone access
mast config reset fontSize              # restore the built-in font sizes
```

Changes are saved to `%AppData%\app.mast.desktop\settings.json` and require a **full mast restart**;
`Ctrl+Shift+R` is not enough. Finish or save your work first: restarting ends running terminal
processes. No command restarts the app automatically. The CLI needs Python 3, WSL Windows interop,
PowerShell and access to the Windows drive. You can still edit the JSON file manually.

Phone access stays off until you enable it. Every key is optional, invalid settings are rejected,
and unknown existing keys are preserved. Full reference: [`docs/SETTINGS.md`](./docs/SETTINGS.md).

## Keyboard shortcuts

Global shortcuts are all `Ctrl+Shift`, so plain `Ctrl` combinations stay with your shell. Anything
not listed goes straight to the PTY.

| Key | Action |
|---|---|
| `Ctrl+1` … `Ctrl+9` | Switch workspace by sidebar position |
| `Ctrl+Shift+↑ ↓ ← →` | Move focus to the adjacent pane |
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
viewer-local keys, is in [`apps/mast/src/shared/keys.ts`](./apps/mast/src/shared/keys.ts).

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
