# winmux

[![CI](https://github.com/sjkwon-1023/winmux/actions/workflows/ci.yml/badge.svg)](https://github.com/sjkwon-1023/winmux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A lightweight multi-agent coding workspace for Windows + WSL2.**

Run Claude Code, Codex, shells, and other terminal agents side by side; see which workspace is
running, waiting for input, or finished; inspect files and Markdown without opening an IDE; and
check or control a tab from your phone on the same LAN.

winmux was built after moving from cmux on macOS to Windows. The goal is deliberately narrow:
keep the agent workflow useful while keeping inactive UI cheap. The app uses Tauri v2 and a
single WebView2 over a Rust/ConPTY session core, with a 100MB target, 150MB ceiling, and roughly
129MB measured app-side in the current release line.

## Why winmux

- **Manage several coding agents at a glance** — workspace cards show agent state and the last
  message, so a waiting agent does not disappear behind another terminal.
- **Stay in one lightweight tool** — split panes and tabs plus folder, text, and Markdown viewers
  cover the common read/inspect loop without embedding a full editor runtime.
- **Keep working away from the desk** — pair a phone on the same Wi-Fi to read a terminal, scroll
  Claude Code/Codex TUIs, and send input.
- **Designed for long-running agent sessions** — PTYs and durable state live behind a disposable
  WebView, so the UI can reload to reclaim memory without killing the shell or agent.
- **Windows + WSL2 on purpose** — no compatibility layer for PowerShell/CMD profiles and no attempt
  to be a general-purpose cross-platform terminal.

The next reliability and product work is tracked in [`ROADMAP.md`](./ROADMAP.md).

## Requirements

winmux is **WSL2 only**, by design rather than omission. Opening a terminal always means
ConPTY → `wsl.exe` → a login shell. There is no PowerShell or CMD profile.

- Windows 11 (x64 or ARM64)
- WSL2 with at least one distribution installed
- WebView2 runtime — ships with Windows 11

## Features

- **Split panes** — split in either direction, drag to resize, `Alt`+arrows to move focus. A
  new pane or tab opens in the directory the pane's shell is in.
- **Tabs inside panes** — every pane has its own tab strip; background tabs stay alive.
- **Workspace sidebar** — one status card per workspace: agent state and its last message.
- **Agent status and notifications** — Claude Code/Codex helpers emit OSC status into the terminal,
  so winmux can show running / needs-input / idle state and notify without a separate agent daemon.
- **Pane-to-pane text passing** — send text to another pane, where it runs on arrival unless
  you ask to pre-fill the prompt instead.
- **Viewer tabs** — folder browser, text viewer, and Markdown viewer reading over
  `\\wsl.localhost`. Large files page in 512KiB windows.
- **Remote surface (opt-in)** — set `"remote": { "port": 7331 }` in `settings.json`, pair a phone
  on the same Wi-Fi from the sidebar's *Pair phone* QR, then read a tab, scroll an alternate-screen
  TUI, or send input from the phone's browser. Off by default; plain HTTP on your LAN — the limits
  are in ADR-0016.
- **Layout persistence** — workspaces, splits, and tabs come back, each shell respawned in the
  directory it was last in, and a tab that was running an agent comes back with its resume
  command one `Up` away. The agent process is gone after a full app restart; the conversation
  can still be resumed.
- **Automatic UI reset** — durable state lives in Rust, so the WebView can reload to reclaim
  renderer/JS memory without losing a live PTY session.
- **x64 and ARM64** — both gated in CI.

## Installing

winmux ships as a single portable executable for x64 and ARM64 — no installer, no setup wizard.
Download `winmux-x64.exe` or `winmux-arm64.exe` from the
[latest release](https://github.com/sjkwon-1023/winmux/releases/latest), matching your CPU
(WSL2 with a distribution installed is still required, see [Requirements](#requirements)).
It's unsigned, so Windows SmartScreen will warn on first launch — "More info" → "Run
anyway".

To build from source, the toolchain setup — rustup on the MSVC ABI, Visual Studio Build Tools
with the C++ workload, Node.js LTS — is in
[`docs/WINDOWS-BUILD.md`](./docs/WINDOWS-BUILD.md).

```powershell
git clone https://github.com/sjkwon-1023/winmux.git
cd winmux\apps\winmux
npm install
npm run tauri build -- --no-bundle
```

That leaves `winmux-app.exe` in the repo's `target\release\`. Use `npm run tauri dev` instead
to run it with hot reload.

Settings are edited by hand — there is no settings screen. Write
`%AppData%\app.winmux.desktop\settings.json` and restart; any key may be left out, and a broken
file reports itself in the status line instead of being silently ignored.

```json
{
  "fontFamily": "Cascadia Code, monospace",
  "fontSize": 15,
  "highlightLanguages": ["python", "javascript", "typescript", "rust", "json", "toml", "css", "html"],
  "log": false
}
```

`fontFamily`/`fontSize` set the font for the terminal **and** for the viewers' monospace
content — the text viewer's lines, the folder listing, and Markdown code spans and blocks.
Markdown prose keeps its own face but follows the *size*, so a larger `fontSize` scales the
whole document. The rest of the UI (sidebar, tab bars, status line) is never affected.
`Ctrl+=`/`Ctrl+-`/`Ctrl+0` zoom moves the terminal and all three viewer surfaces together. Zoom
is session-only: a relaunch comes back at the size set here, and `Ctrl+0` returns to it.

`highlightLanguages` picks which languages the text viewer syntax-highlights; the list above is
also what you get when the key is absent, and those eight names are the entire supported set —
an unknown name is reported rather than ignored. The language comes from the file extension
(`.jsx` highlights as `javascript`, `.tsx` as `typescript`), and anything outside the set stays
plain text. `[]` turns highlighting off. The highlighter is loaded on demand, so a session that
never opens a matching file never pays for it.

Workspace cards can be dragged to reorder them, and `Ctrl+1`–`Ctrl+9` follow that order — drag
the one you switch to most to the top and it becomes `Ctrl+1`. Dragging never changes which
workspace is on screen.

`log` writes a diagnostic log to `winmux.log` next to `state.json`, for reporting a bug that is
hard to reproduce. It is **off unless you turn it on**, and turning it on takes a restart. While
off nothing is opened, written or listened for; while on, the app records what it does — startup,
shell spawns and how long they took, session exits, failures — plus the browser-level input
events that are otherwise invisible from outside the window. **Terminal output and the text you
type are never written**: input events record how many characters were involved, not which ones.
The file is capped and rolls over into `winmux.log.1`, so leaving it on will not fill a disk.

## Setup

### Choosing a distribution

winmux spawns into the WSL default distribution. To point it elsewhere:

```powershell
$env:WINMUX_DISTRO = "Ubuntu-24.04"      # current shell
setx WINMUX_DISTRO "Ubuntu-24.04"        # persist for your user account
```

This matters if you keep a locked-down distribution for agent work. winmux never filters
commands — it just never hands you a Windows shell, and leaves the real boundary to that
distribution's own `/etc/wsl.conf`. Viewer tabs keep working there, because they read in the
other direction, from Windows into WSL.

### Agent status

On Windows, winmux automatically provisions its Claude Code/Codex notification helpers in each
WSL distribution it uses. Provisioning is idempotent and failure is logged rather than silently
changing terminal behavior. [`scripts/wsl/claude-hook-example.md`](./scripts/wsl/claude-hook-example.md)
documents the OSC contract and the manual/fallback setup path.

## Keyboard shortcuts

Global shortcuts are all `Ctrl+Shift`, so plain `Ctrl` combinations stay with your shell.
Anything not listed goes straight to the PTY.

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
| `Ctrl+Shift+R` | Reload the WebView |
| `Ctrl+V` / `Ctrl+Shift+V` / `Shift+Insert` | Paste |
| `Ctrl+C` / `Ctrl+Shift+C` | Copy when there is a selection — a bare `Ctrl+C` with no selection still sends SIGINT |

The full list, including viewer-local keys, is in
[`apps/winmux/src/keys.ts`](./apps/winmux/src/keys.ts).

## Troubleshooting

**A tab opens but stays empty, or running sessions stop responding.** This is usually WSL under
memory pressure rather than winmux. When the VM cannot find contiguous memory it fails to open
the channel a new terminal needs, and processes already running start thrashing. A tab whose
shell never came up says so and offers Retry; sessions that were already running have to be
started again.

WSL2 defaults to half the host RAM with a swap file a quarter that size, which a container build
or a large compile can exhaust. Raising swap in `%UserProfile%\.wslconfig` usually settles it:

```ini
[wsl2]
swap=8GB
autoMemoryReclaim=gradual
```

`wsl --shutdown` applies it — that ends every WSL session, so do it between tasks.

## Status

Early, one maintainer, but used daily. The current focus is preserving the lightweight session
architecture while improving terminal reattach fidelity, Windows resource soak coverage, Git
status/diff inspection, and first-run/public documentation. See [`ROADMAP.md`](./ROADMAP.md).

- **Tested on an x64 Windows 11 desktop only.** ARM64 is type-checked and linted on every
  push, but has never run on real hardware — device testing waits on an ARM64 laptop.

## License

MIT — see [LICENSE](./LICENSE).
