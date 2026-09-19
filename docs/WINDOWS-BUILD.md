# Windows Build Guide

How to set up a Windows machine to build and run mast, and how to run the Windows-side
verification. Two apps share this guide:

- **`apps/mast`** — the MVP app, active development from 계획 v2 section 17 stage 10
  onward (section 3 below).
- **`apps/spike`** — the Tauri v2 + xterm.js spike. Its sign-off was completed on
  2026-08-08 (candidate A adopted — see
  [`docs/adr/0001`](adr/0001-adopt-tauri-webview2-xterm-stack.md)); it's now **frozen as
  a measurement harness** — no new features land there, only compiling is kept green —
  and its build steps (section 2) and checklist (section 5) remain the reference for
  re-running those checks as regression tests during MVP work.

## 1. Prerequisites

### rustup + MSVC target(s)

Install [rustup](https://rustup.rs/) (defaults to the `stable-x86_64-pc-windows-msvc` toolchain
on a 64-bit Windows install). Tauri on Windows requires the **MSVC** ABI, not GNU.

```powershell
winget install Rustlang.Rustup
```

After install, verify:

```powershell
rustup show
rustc --version
```

### Visual Studio Build Tools (C++)

Rust's MSVC toolchain needs the MSVC linker and Windows SDK, which come from Visual Studio
Build Tools — not the full Visual Studio IDE.

1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
2. In the installer, select the **"Desktop development with C++"** workload.
3. Under "Individual components", make sure the MSVC target architecture(s) you need are
   selected:
   - **x64**: `MSVC v143 - VS 2022 C++ x64/x86 build tools` (this dev machine's target)
   - **ARM64**: `MSVC v143 - VS 2022 C++ ARM64 build tools` (only needed if you'll build for
     ARM64 — see section 11)
4. Also confirm a **Windows 10/11 SDK** component is selected (the installer usually pulls one
   in automatically with the C++ workload).

Tauri also needs [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) — the
Evergreen runtime ships with Windows 11 and most updated Windows 10 installs already, so a
separate install step is usually unnecessary. If `npm run tauri dev` fails complaining about a
missing WebView2 runtime, install the "Evergreen Bootstrapper" from the link above.

### Node.js LTS

Install a current Node.js **LTS** release (from [nodejs.org](https://nodejs.org/) or
`winget install OpenJS.NodeJS.LTS`). `apps/spike` builds with npm scripts (`tsc` + `vite` +
`vitest`) that assume a recent Node LTS.

Verify:

```powershell
node --version
npm --version
```

## 2. Build and run `apps/spike`

From the repo root on Windows (adjust the path to wherever you cloned/checked out the repo):

```powershell
cd apps\spike
npm install
```

### Development (hot reload, dev console)

```powershell
npm run tauri dev
```

This starts the Vite dev server and launches the Tauri window pointed at it. Rust changes under
`src-tauri/` or `crates/mast-core` trigger a rebuild; frontend changes hot-reload.

### Distributable exe (no installer/bundle)

```powershell
npm run tauri build -- --no-bundle
```

`--no-bundle` skips MSI/NSIS installer packaging (not needed for Spike verification) and leaves
a plain `mast-spike.exe` under the **workspace root** `target\release\` — same reason as
section 3: the repo root is the cargo workspace, so `target/` lives there. This is the binary
[`scripts/win/measure.ps1`](../scripts/win/measure.ps1) expects by default (`-ProcessName
mast-spike`, matching `productName` in `src-tauri/tauri.conf.json`).

## 3. Build and run `apps/mast`

`apps/mast` is the MVP app (계획 v2 section 17, stage 10 onward) — same Tauri v2 +
Node/npm toolchain as `apps/spike` above, but its Rust glue drives the `mast-core`
`Dispatcher` over the single `Command` bus instead of spike's thin per-call commands.
Architecture: [`docs/adr/0002`](adr/0002-stage10-architecture.md) and
[`docs/adr/0003`](adr/0003-split-tab-ui-architecture.md).

From the repo root on Windows:

```powershell
cd apps\mast
npm install
```

### Development (hot reload, dev console)

```powershell
npm run tauri dev
```

Same rebuild behavior as spike: Rust changes under `src-tauri/` or `crates/mast-core`
trigger a rebuild, frontend changes hot-reload. On boot the app itself dispatches a
single atomic `CreateWorkspace{tab}` (from Tauri `setup`, before the frontend ever
attaches — stage 13 folded the earlier `CreateWorkspace` + `CreateTab` pair into one
command), so a terminal tab is already running when the window opens. Splits/tabs
(stages 11–12) and the workspace sidebar (stage 13) are mouse-driven; commands without
UI yet can still be driven from the WebView dev console via the dev hook
`window.__mast.dispatch(command)`. See section 6 below for the stage 10 manual
checklist that exercises this.

### Distributable exe (no installer/bundle)

```powershell
npm run tauri build -- --no-bundle
```

Leaves a plain `mast-app.exe` under the **workspace root** `target\release\` — not under
`apps\mast\src-tauri\`, because the repo root is the cargo workspace and that is where
cargo puts `target/`. The binary is named after the cargo package (`mast-app`), not after
`productName`; `--no-bundle` skips the bundling step that would apply the product name.

Cross-compiling adds the triple: `--target aarch64-pc-windows-msvc` writes to
`target\aarch64-pc-windows-msvc\release\mast-app.exe`. That is the path
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) uploads, verified by a real
`workflow_dispatch` run of the `windows-artifacts` job for both targets.

## 4. `MAST_DISTRO` environment variable

Both apps spawn the WSL shell as `wsl.exe [-d $MAST_DISTRO] -- bash -l` — spike's glue
reads it directly per spawn (see spike-plan.md section 4.5); mast threads it through
`mast-core`'s `Command::CreateWorkspace` → `ShellSpawnReq::distro` (see
`crates/mast-core/src/command.rs`), same underlying `wsl.exe` invocation either way.
`MAST_DISTRO` selects which WSL distribution to spawn into:

- **Unset**: `wsl.exe` uses your default distribution (`wsl -l -v` shows which one has `*`).
- **Set**: `wsl.exe -d <name>` targets that distribution explicitly — useful if you have more
  than one installed (e.g. a plain Ubuntu install alongside an isolated/sandboxed distro for
  agent work) and want the app to consistently target one of them regardless of which is
  marked default.

Set it for the current PowerShell session before launching the app:

```powershell
$env:MAST_DISTRO = "Ubuntu-24.04"
npm run tauri dev
```

or persist it for your user account (`setx MAST_DISTRO "Ubuntu-24.04"`, new shells only).

## 5. Spike verification checklist (regression reference)

The verification checklist — OSC passthrough, Claude Code/Codex behavior, IME, flow control,
renderer comparison, RAM measurement — is [`docs/plans/spike-plan.md`](plans/spike-plan.md)
section 6 ("Windows Spike 검증 체크리스트"). It was fully executed for the Spike sign-off
(results in ADR-0001) and, now that `apps/spike` is frozen as a measurement harness (section
2), doubles as the regression checklist for MVP-era changes. This runs against `apps/spike`;
`apps/mast`'s own stage 10 checklist is section 6 below.

Scripts referenced by that checklist:

- [`scripts/wsl/osc-test.sh`](../scripts/wsl/osc-test.sh) — run **inside the WSL terminal that
  the Spike app opened**, from a Windows-side terminal you do *not* need this for. Emits OSC
  0/7/9/777 with both BEL and ST terminators, plus a chunk-split case.
- [`scripts/wsl/flood.sh`](../scripts/wsl/flood.sh) — `yes`-speed output burst (and an optional
  `--random-lines` high-entropy burst) for the flow control / backpressure check.
- [`scripts/wsl/scrollback-test.sh`](../scripts/wsl/scrollback-test.sh) — emits 12,000 lines to
  confirm the 5,000-line scrollback cap actually evicts old lines.
- [`scripts/wsl/claude-hook-example.md`](../scripts/wsl/claude-hook-example.md) — the canonical
  OSC contract (`mast:` status tokens, title/cwd) plus the Claude Code hook and shell-prompt
  snippets that emit it, for the agent-notification half of the checklist.
- [`scripts/win/measure.ps1`](../scripts/win/measure.ps1) — run from a **Windows** PowerShell
  prompt (not inside WSL) while the Spike app is running, to record private working set (WebView2
  process tree included) over time and export it to CSV:

  ```powershell
  .\scripts\win\measure.ps1 -ProcessName mast-spike -IntervalSec 5 -Samples 12 -OutCsv .\ram-4pane.csv
  ```

  No administrator privileges are required.

## 6. Stage 10 manual verification checklist

This was stage 10's completion gate on top of the automated gates in `CLAUDE.md`; it
**passed on Windows** (decisions distilled into
[`docs/adr/0002`](adr/0002-stage10-architecture.md)) and remains here as a regression
checklist for later work on the attach protocol and dispatcher.

1. **Boot** — launching the app auto-creates a workspace and a terminal tab (the
   dispatcher issues `CreateWorkspace` + `CreateTab` from Tauri `setup`, dogfooding the
   same `Command` bus the UI will use later); the terminal accepts input immediately.
2. **Reload survives** — type something with a distinguishable marker (e.g. `echo
   RELOAD-MARK-1`), then reload the WebView with **Ctrl+Shift+R** (or `window.__mast.reload()` from the
   dev console). Plain F5 is *not* a reload key here — with the terminal focused, xterm
   correctly delivers F5 to the shell as `ESC[15~` (TUI apps like htop use it), which is
   why pressing it just prints a stray `~`.
   The session and its printed text must still be there afterward — that's the stage 10
   bar ("세션 생존 + 텍스트 보존"); pixel-perfect redraw of the TUI screen itself is out
   of scope until stage 14 (plan section 0-2).
3. **Dev-hook commands land** — from the WebView dev console, drive
   `window.__mast.dispatch(...)` with `CreateTab`, `CloseTab`, and `SplitPane` commands.
   Each should update the `state-changed` snapshot, and closing tabs/panes must not leave
   orphaned WSL/shell processes behind (check via Task Manager, or `ps` inside WSL).
4. **IDs are stable across reload** — note the `Pane`/`Tab` ids from `get_state` (or the
   dev hook's command output) before reloading, reload, and confirm they're unchanged
   afterward.
5. **Background tab stays free-running** — create a second terminal tab, start a long
   noisy command in it (e.g. `seq 1000000`), switch back to the first tab, wait a few
   seconds, then check `window.__mast` dev hook → `get_stats` (or `invoke("get_stats")`):
   the background session must show `paused: false` and keep making progress.
   *(Historical note: when this item was written, tab switching disposed the view and
   detached its channel. Since stage 12 landed keep-alive views, switching tabs keeps the
   hidden view attached and acking — the item still holds, it now verifies the keep-alive
   ack path instead of detach-on-dispose.)*
6. **`root_path` workspace spawns in the right directory** — dispatch
   `createWorkspace` with a `rootPath` (absolute **Linux** path, e.g. `/home/<user>`),
   create a terminal tab in it, and confirm `pwd` prints that path. This is the first
   real-world use of the `wsl.exe --cd <path>` mapping (spike only ever used
   `wsl.exe -- bash -l`); relative or Windows-style paths are not supported there.

## 7. Stage 11–12 manual verification checklist

This was stages 11–12's completion gate on top of the automated gates; it **passed on
Windows 2026-08-09** (decisions distilled into
[`docs/adr/0003`](adr/0003-split-tab-ui-architecture.md)) and remains here as a
regression checklist for split/tab UI work. All UI is mouse-driven; the dev hook is only
needed where noted.

1. **Splits render and nest** — use the pane-header icons to split left/right and
   top/bottom, then split one of the halves again. Layout must match the icon direction
   (horizontal = side by side, vertical = stacked), each new pane opens with a running
   terminal tab (atomic `SplitPane{tab}` — no empty-pane flash), and focus moves to the
   new pane.
2. **Splitter drag survives reload** — drag a splitter (live preview while dragging, no
   command spam), release, then reload (Ctrl+Shift+R). The adjusted ratio must persist (it lives in Rust
   state, not the DOM). Also observe: if a structural change arrives mid-drag (e.g. a
   session exits in another pane), the drag is deliberately abandoned — the preview snaps
   back and no resize command is sent (expected behavior, not a bug).
3. **Tabs: create/switch/close** — multiple terminal tabs per pane via the header icon;
   switching is instant with **no replay flash** (keep-alive views — the terminal content
   must not visibly re-render from scratch); closing a tab kills only that session.
   **A single click on an *inactive* pane's tab must land** (activate the tab, not just
   focus the pane) — regression guard for a mid-click re-render that used to require two
   clicks.
4. **Hidden tab keeps flowing** — run `bash ~/code/mast/scripts/wsl/flood.sh 10` in a
   tab, switch away, wait, switch back: the buffer shows the latest output and
   `get_stats` shows `paused: false` throughout (hidden views keep acking).
5. **Unvisited tab after reload keeps flowing** — create a second tab, start `seq
   1000000` in it, reload (Ctrl+Shift+R), and do **not** click that tab. Check `get_stats`: the session must
   show `paused: false` (the boot reconcile sweeps `detach_terminal` over unattached
   sessions — the post-reload freeze fix). Then click the tab: latest output appears via
   replay.
6. **Last tab closes the pane** — closing the last tab of a pane collapses the pane
   (sibling takes the space, focus falls back); closing the last tab of the *last* pane
   leaves an empty pane with the placeholder, and the header icons still work from there.
   After any tab close, keyboard input must land in the surviving tab **without an extra
   click** (focus compensation — a removed xterm otherwise drops focus to the body).
7. **2×2 reload** — build a 2×2 layout with running TUIs (e.g. `htop`), reload (Ctrl+Shift+R): all four
   panes re-attach with their sessions and text intact, and the TUIs redraw after the
   resize nudge. Pane/Tab/Split ids unchanged (`get_state`).
8. **Errors surface** — from the dev console, dispatch `resizeSplit` with a stale id
   (e.g. `{ type: "resizeSplit", split: 9999, ratio: 0.5 }`): the status line shows the
   error and the layout stays consistent.
9. **RAM reference** — with the 2×2 layout idle, run `scripts/win/measure.ps1
   -ProcessName mast` and note the total against the 계획 v2 section 16 budget
   (≤150MB); this is a reference point, not a hard gate for these stages.

## 8. Stage 13 manual verification checklist

This is stage 13's completion gate on top of the automated gates: the workspace sidebar
— create/switch/close workspaces from the UI (계획 v2 section 17 stage 13; design
decisions in [ADR-0004](adr/0004-lifecycle-persistence-reset.md)). All
interactions are mouse-driven in the sidebar; the dev hook is only needed where noted.

1. **Boot workspace card** — on launch the sidebar shows one card for the boot
   workspace with the active highlight, its name, and the status line (`idle` until an
   agent reports otherwise), matching the workspace rendered on the right. (The card
   carries no pane/tab counts and no git branch — see §10 item 11.)
2. **Create via the sidebar form** — click "+ New workspace", enter a name (rootPath
   optional — absolute **Linux** path, e.g. `/home/<user>`), submit. A new card
   appears, the app switches to the new workspace, and a terminal tab is already
   running with keyboard focus (atomic `CreateWorkspace{tab}` — no empty-workspace
   flash). If a `rootPath` was given, `pwd` prints it.
3. **Background workspace keeps flowing** — in the first workspace start a long noisy
   command (e.g. `seq 1000000` or `bash ~/code/mast/scripts/wsl/flood.sh 10`), switch
   to another workspace via its card, wait a few seconds, then check `get_stats` from
   the dev console: the background session must show `paused: false` and keep making
   progress (leaving a workspace disposes its views; the detach sweep frees the
   channels so nothing sticks at paused).
4. **Switch-back restores** — switch back to the first workspace: layout, tabs, and
   terminal output are restored via replay (lazy attach), and keyboard input lands in
   the active pane **without an extra click** (focus compensation). Pane/Tab ids
   unchanged (`get_state`).
5. **Close kills sessions** — click a card's ×: a confirm dialog appears when the
   workspace has **running** terminal sessions (exited-only workspaces close without
   one); **cancelling the dialog must change nothing** (workspace and sessions stay).
   After confirming, the card disappears and no orphaned WSL/shell processes remain
   (Task Manager, or `ps` inside WSL). Closing the *last* workspace leaves the empty
   state ("no workspace" on the right), and the sidebar form still creates a fresh
   workspace from there.
6. **Reload keeps the workspace list** — with 2+ workspaces, reload (Ctrl+Shift+R):
   the card list, active workspace, and all ids are unchanged (state lives in Rust,
   the WebView is just a view).

## 9. Stage 14–16 / Checkpoint 1 manual verification

This is **checkpoint 1** (roadmap decision in `CLAUDE.md`): the batched manual Windows
verification for stages 13–16 — workspace sidebar (section 8 doubles as its checklist),
replay trim + switch latency tracer (stage 14), persistence (stage 15), and the automatic
UI reset safety net (stage 16, 계획 v2 section 12). It **passed on Windows 2026-08-09**
(decisions and ConPTY field findings distilled into
[`docs/adr/0004`](adr/0004-lifecycle-persistence-reset.md)) and remains here as a
regression checklist.

### Auto-reset environment variables

The reset supervisor reads six environment variables at app start (set them in the
PowerShell session before `npm run tauri dev`, e.g. `$env:MAST_RESET_IDLE_SECS = "30"`).
`0` disables the trigger it belongs to; invalid values fall back to the default with a
loud stderr warning. The effective config is printed to stderr on boot
(`[mast] reset: config ...`).

| Variable | Default | Meaning |
|---|---|---|
| `MAST_RESET_IDLE_SECS` | `1800` | Idle reset: fire once this many seconds after the last real user input (`0` = off). Re-arms only on the next real input. |
| `MAST_RESET_HIDDEN_SECS` | `600` | Hidden reset: fire after the window stays unfocused **and** invisible for this long continuously (`0` = off). Once per hidden stretch. |
| `MAST_RESET_MEM_MB` | `1536` | Memory watchdog: when the WebView2 process tree's private memory exceeds this many MB, schedule a reset for the next safe moment (`0` = off). |
| `MAST_RESET_MEM_POLL_SECS` | `60` | Watchdog sampling period. `0` is rejected (would busy-loop) — default + warning. |
| `MAST_RESET_SAFE_IDLE_SECS` | `60` | Seconds since the last input for a pending watchdog reset to count as "safe" (`0` = immediately safe). |
| `MAST_RESET_COOLDOWN_SECS` | `300` | Suppression window after any reset fires (`0` = no cooldown). |

Reset activity is stderr-only by design (no UI): look for `[mast] reset: reloading
webview (trigger=...)` lines. A manual reset is available from the dev console as
`window.__mast.resetUi()` (dev hook / future MCP only — there is deliberately no UI
button, 계획 v2 section 12).

### Checklist

1. **Persistence round-trip** — build 2 workspaces with splits, tabs, and an adjusted
   splitter ratio → quit and restart the app → the full structure (workspaces, panes,
   tabs, ratios, active selections, ids) is restored, and every **`Running` or `NotStarted`**
   terminal tab runs a **fresh shell** (a live session's content is not persisted — only
   structure). An exited tab is the exception and comes back as its record, per item 2.
2. **An exited tab stays exited across a restart, and Restart brings it back**
   ([ADR-0018](adr/0018-exited-tab-as-terminal-record.md), which reverses the restore half of
   [ADR-0010](adr/0010-restart-dead-terminal-tabs.md); this item read "a restart revives an
   exited tab" from v0.3.9 to v0.3.23, and the opposite before v0.3.8) — exit a shell (`exit`)
   so the tab shows the exited badge and the Restart banner, restart the app → that tab comes
   back **exited**, showing its record with the Restart banner, and the app is otherwise fully
   functional; only `Running` and `NotStarted` tabs respawn at boot. Within a single run the
   badge likewise stays until the user presses Restart: mast does not resurrect a shell under
   the user. The full record behaviour is §10 v0.3.25.
3. **Corrupt state recovers loudly** — corrupt `state.json` (e.g. truncate it) in the app
   data dir, restart → the app starts fresh, keeps the original as
   `state.json.corrupt-<epoch>`, and logs the reason to stderr.
4. **Switch latency readout** — build a 4-pane workspace plus a second workspace, switch
   back and forth → read `window.__mast.lastSwitch` in the dev console: total should be
   in the ~100ms class, with per-tab replay timings populated.
5. **Replay trim keeps lines whole** — flood 1MB+ of colored output (e.g.
   `bash ~/code/mast/scripts/wsl/flood.sh`), switch away and back → the top of the
   restored buffer starts at a line boundary with no broken escape sequences /
   half-colored garbage.
6. **Idle reset fires once, invisibly** — set `MAST_RESET_IDLE_SECS=30` (and
   `MAST_RESET_COOLDOWN_SECS=0` for this item), leave the app alone for 30s → exactly one
   reset fires (stderr `trigger=idle`); sessions and terminal text survive and the reload
   is visually seamless. Keep waiting another 30s **without touching anything**: no
   second reset — the post-reset automatic attach/resize/ack must **not** re-arm the idle
   timer (only real input does). **Repeat the whole item with `vim` (or Claude Code)
   running in a tab**: TUI apps emit terminal queries (DA/DSR/color) that xterm
   auto-answers after the replay, and those synthetic writes must not re-arm idle either
   (review finding — stdin writes deliberately don't count as activity; only the
   frontend's real-gesture ping does).
7. **Hidden reset, and never while typing** — set `MAST_RESET_HIDDEN_SECS=30`, minimize
   or fully cover + unfocus the window for 30s → reset fires. Then keep the window
   focused and type continuously for well past 30s → **no** reset ever fires (guards
   against a spurious `Focused(false)` misdetection — real input re-arms the hidden
   countdown too).
8. **Mem watchdog waits for a safe moment** — set `MAST_RESET_MEM_MB=100` (trivially
   exceeded) → while typing/scrolling nothing fires; stop touching the app for
   `MAST_RESET_SAFE_IDLE_SECS` (or switch workspaces) → the pending reset fires
   (`trigger=memWatchdog` with the sampled bytes in stderr).
9. **Scrollback reading is activity** — with `MAST_RESET_IDLE_SECS=30`, read scrollback
   using **wheel only** (no keys) for over 30s → no reset fires (the throttled activity
   ping counts pure viewing as activity).
11. **Kill survives** — force-kill the app from Task Manager, restart → state is restored
    except at most the last ≤500ms of structural mutations (save debounce window).

## 10. Stage 17+ / Checkpoint 2 manual verification

This section collects the batched manual Windows verification for the stages after
checkpoint 1, to be run at **checkpoint 2** (after stage 21). Items are appended per
stage as each lands.

<!-- retired 2026-08-10 — see ADR (agent-facing channel is a v2 follow-up); the checklist below stays as a historical record of what was verified. -->

### Stage 17 — pane-to-pane text send (계획 v2 section 8)

The pane header gains two send icons: `⤷` (send selection) and `⤷⏎` (send & run).
Clicking one captures the current selection of that pane's shown terminal and enters
target-selection mode (status line prompt, crosshair cursor); the next primary-button
mousedown on a pane delivers.

1. **Send selection** — select text in one terminal, click that pane's `⤷` icon: the
   status line shows `send: click a pane to send to (Esc cancels)`; click another pane →
   the text appears on the target's input line **without executing** (no Enter is sent),
   and the prompt clears.
2. **Send & run is a separate gesture** — repeat with `⤷⏎`: the text is pasted *and*
   followed by exactly one CR in the target (a shell command runs once). The two icons
   stay visually and behaviorally distinct (mis-run guard).
3. **Bracketed paste safety (vim target)** — open `vim` in the target pane, enter insert
   mode, and send a multi-line selection with `⤷` (send only): the text lands as a paste —
   no autoindent staircase, no literal `ESC[200~`/`ESC[201~` fragments, and **nothing is
   executed** (send-only must never run anything in the target, TUI or shell).
4. **Multi-line to a non-bracketed target is refused** — with a target whose foreground
   program does *not* enable bracketed paste (e.g. plain `cat` waiting on stdin, or a
   bare shell with bracketed paste off), sending a **multi-line** selection with either
   icon is refused with a status-line error (`cannot send multi-line: target is not in
   bracketed paste mode`), and **nothing** is written to the target. Rationale: without
   bracketed paste the target cannot distinguish pasted newlines from Enter, so the
   intermediate lines would execute — refusing is the only safe behavior. A
   **single-line** send to the same target still works (and with `⤷` never executes).
5. **No selection surfaces an error** — with no selection in the source terminal (or with
   an empty pane / non-terminal placeholder shown), clicking either icon shows a one-shot
   status-line error (`no selection to send` / `cannot send: no terminal shown in this
   pane`) and does **not** enter target-selection mode.
6. **Esc and self-click cancel** — arm send mode, press Esc → the prompt clears, nothing
   is sent, and the next pane click focuses normally (the Esc must not leak into the
   terminal). Arm again and click the **source** pane itself → cancelled the same way
   (self-send is meaningless).
7. **Workspace switch auto-cancels** — arm send mode, then switch to another workspace
   (sidebar click): the prompt clears and the mode is cancelled — a pane click in the new
   workspace focuses normally instead of delivering (cross-workspace send is out of scope
   for v1).
8. **Exited target surfaces an error** — arm send mode and click a pane whose shown
   terminal has **exited** (run `exit` there first): a status-line error appears
   (`cannot send: target terminal has exited`) and nothing is silently dropped.
9. **Send & run ordering** — with `⤷⏎` and a multi-line selection into a bracketed-paste
   shell, the full pasted text always lands **before** the single CR (the command that
   runs is the complete pasted text, never a truncated prefix).

### Stage 18 — OSC notification routing + coalescing + keyed reconcile (계획 v2 section 9; contract in [ADR-0006](adr/0006-osc-notification-routing.md) and [`scripts/wsl/claude-hook-example.md`](../scripts/wsl/claude-hook-example.md))

OSC 777/9 agent notifications and OSC 0 (alias "2")/7 are now routed into the Rust model
through a 100ms-trailing-window coalescer (`OscRouter`), surfacing on three layers: the
tab's unread dot, the pane header's aggregate badge (`●`), and the workspace sidebar card
(status text, message preview, aggregate unread dot). The frontend applies snapshot
updates with keyed in-place reconcile (sidebar cards and tab-strip entries patch by id
instead of rebuilding the DOM) — this is what guards the ADR-0003 d7 mid-click swallow
regression once the model fields are dynamic.

1. **Synthetic OSC routing (`osc-test.sh`)** — with a background tab (not the pane's
   shown terminal, in a non-active workspace), run
   [`scripts/wsl/osc-test.sh`](../scripts/wsl/osc-test.sh)'s OSC 777 cases (7–9; 9 is the
   chunk-split case) and OSC 9 cases (5–6) against it: the tab gets an unread dot, the pane header's `●` badge lights,
   and the workspace's sidebar card shows the aggregate unread dot (OSC 9 / a
   token-mismatched 777 are status-neutral — `agentStatus` on the card must **not**
   change). Repeat while that tab is the pane's **shown** terminal: no dot appears at all
   (visible-tab suppression happens at apply time, not just on next activation).
2. **Real Claude Code + hook 3-tuple** — run Claude Code in a mast tab with the
   `UserPromptSubmit`/`Notification`/`Stop` hooks from `claude-hook-example.md` wired up:
   submitting a prompt shows `running` (no dot), a permission prompt shows `needsInput`
   with the sidebar preview populated from the hook's message (dot set), and finishing a
   turn shows `idle` (dot set, preview persists — an empty body never clears the previous
   message). Activating the tab clears its dot immediately. (Since setup v16 the `Notification`
   hook fires for prompt types only, and dispatcher hooks sit next to these three; §10 v0.3.32
   covers them.)
3. **needsInput priority across tabs** — with one tab's session at `needsInput`, trigger
   `mast:running` on a **different** tab (`osc-test.sh` case 10, or another hook run): the
   workspace's sidebar status stays `needsInput`. Each tab keeps its own status and the card
   shows the most urgent one, so only the waiting tab leaving `needsInput` — its own `running`
   or `idle`, or the tab closing or exiting — lowers the card, and only the waiting tab shows
   the `!` badge. (Before v0.3.32 the workspace held a single status slot that only the tab
   which set it could lower; that rule is gone.)
4. **Click during a live title update (d7 regression guard)** — with a tab emitting OSC
   0/2 titles on a fast loop (or repeated `osc-test.sh` case 1/2 runs) so the tab strip is
   patching in place, click that tab repeatedly: activation must land every time, never
   swallowed by a re-render replacing the clicked element underneath the pointer.
5. **[conditional] cwd restore across restart** — `cd` to a distinct directory in a tab
   (letting the `~/.bashrc` `PROMPT_COMMAND` snippet from `claude-hook-example.md` emit
   OSC 7), quit and restart the app → the respawned shell's `pwd` matches that directory.
   ConPTY's real-world OSC 7 emission is an **unverified precondition** (plan risk,
   [ADR-0006](adr/0006-osc-notification-routing.md); verified at checkpoint 2) — if this
   fails it is **not a stage blocker**: fall back to the reduced scope (title/cwd routing
   stays landed, only the restart-respawn behavior is unverified) and revisit the
   file/socket cwd-passing alternative from 계획 v2 section 2 separately; it is independent
   of the notification path covered by items 1–4 and 6–8.
6. **OSC flood** — run [`scripts/wsl/flood.sh`](../scripts/wsl/flood.sh) in a tab: the UI
   stays responsive throughout (coalescing keeps model updates at the 100ms flush cadence
   regardless of OSC volume — `MAST_OSC_FLUSH_MS`), the persistence Saver's debounce cadence
   is undisturbed, and RAM stays stable (no unbounded growth from the flood).
7. **Closing a needsInput tab drops it from the sidebar summary** — with one tab at
   `needsInput` and another at `running` in the same workspace, close the waiting tab via
   **CloseTab**, then repeat and close via **ClosePane** instead: in both cases the sidebar
   falls to `running` (the remaining tab's status), with no lingering dot or badge. With no
   other agent tab left it falls to `idle`. The preview is recomputed from the remaining tabs.
8. **Restart clears notifications and status (sanitize)** — with a tab left at
   `needsInput`/`idle` with an unread dot and a sidebar preview message, restart the app:
   every tab's `agentStatus` is `idle` with no `lastAgentMessage`, so every workspace derives
   `idle` with no preview, and every tab's `notification` is cleared — same guarantee as the
   existing `pty_session` reset, extended to the notification fields.

### Stage 20 — three-tier keyboard navigation (계획 v2 "키보드 모델"; the canonical interception list lives in the [`apps/mast/src/shared/keys.ts`](../apps/mast/src/shared/keys.ts) module doc)

One movement key per tier: `Ctrl+1`…`Ctrl+9` (workspace), `Ctrl+Shift+arrows` (pane focus, by
on-screen adjacency), `Ctrl+Tab` / `Ctrl+Shift+Tab` (tab cycle inside the active pane).
All three are window-level capture handlers, so they work with the terminal focused. When
a key has no target (ordinal past the last workspace, already-active workspace, no pane in
that direction, 0–1 tabs) the app does nothing — silently, with no status-line error.

1. **Workspace switch (`Ctrl+1`…`Ctrl+9`)** — with 2+ workspaces and a terminal focused,
   press `Ctrl+2`: the sidebar's **second** card becomes active (1-based, sidebar order)
   and focus lands in that workspace's active pane (typing goes to its terminal
   immediately). Pressing the ordinal of the **already active** workspace, or an ordinal
   past the last card (e.g. `Ctrl+9` with 3 workspaces), does nothing at all.
2. **Pane focus move (`Ctrl+Shift+arrows`, since v0.3.30)** — in a workspace split into 2x2 panes, `Ctrl+Shift+→` /
   `Ctrl+Shift+↓` / `Ctrl+Shift+←` / `Ctrl+Shift+↑` move the active-pane highlight to the geometrically
   adjacent pane each time, and the newly focused pane's terminal receives typing. At an
   edge (e.g. `Ctrl+Shift+→` from the rightmost pane) and in a single-pane workspace, nothing
   happens and no error appears. Verify that `Alt+Up` reaches Codex's queued-question UI
   both with and without an adjacent pane, and plain `Ctrl+arrows` still reach the terminal.
   These v0.3.30 bindings remain pending field verification.
3. **Tab cycle (`Ctrl+Tab` / `Ctrl+Shift+Tab`)** — in a pane with 3 tabs, `Ctrl+Tab`
   advances through them in tab-strip order and **wraps** from the last back to the first;
   `Ctrl+Shift+Tab` walks the same cycle backwards. The activated tab's terminal takes
   focus. In a pane with 0 or 1 tabs, nothing happens.
4. **Intercepted keys never reach the shell** — with a shell prompt focused, press each of
   the keys above (including the no-op cases from items 1–3, such as `Ctrl+9` with fewer
   workspaces): the command line stays empty — no stray digits, no `^I`/tab completion
   triggered, no escape-sequence garbage — and no line is ever submitted. Then confirm the
   keys **not** in the interception list still belong to the terminal: a bare `Tab`
   completes a path, bare arrow keys walk shell history/cursor, and `Ctrl+C` still
   interrupts a running command.
5. **[conditional] `Ctrl+Tab` reaches the page in WebView2** — item 3 depends on WebView2
   delivering `Ctrl+Tab` to the page instead of consuming it as a host-level shortcut,
   which is an **unverified precondition** (plan risk). If `Ctrl+Tab` produces no tab
   change *and* leaves nothing in the terminal, the interception itself is fine but the
   key never arrives: this is **not a stage blocker** — items 1, 2 and 4 stand on their
   own, and the follow-up is to pick a replacement binding (e.g. `Ctrl+PgUp`/`Ctrl+PgDn`)
   in `shared/keys.ts` and re-run item 3. Record which behavior you observed.

### Stage 21 — viewer tabs (folderBrowser / textViewer / markdownViewer; 계획 v2 "탭 타입별 동작"; contract in [ADR-0008](adr/0008-viewer-tabs.md))

Tabs are no longer terminals only. The pane header's `▤` icon opens a **folderBrowser**
tab, and clicking a file row there opens a viewer tab in the same pane — a
**markdownViewer** for `.md`/`.markdown`, a **textViewer** for everything else. All three
are viewers, never editors. The Rust side reads the WSL filesystem through
`\\wsl.localhost\<distro>\...` (`fs_list_dir` / `fs_stat` / `fs_read_chunk`), so these
items exercise a Windows→WSL path that has no equivalent on the Linux dev host — none of
it can be checked before this checkpoint. Two contracts drive most of the items:
navigation is a **dispatcher command** (`navigateFolder`), so the current path is part of
the persisted model; and a viewer tab is mounted **only while it is the active tab of its
pane**, so leaving and returning is a real unmount/remount.

1. **Folder browser opens on the workspace root** — click the pane header's `▤` icon: a
   new tab opens in that pane listing the workspace's `rootPath` (`/` when the workspace
   has none), with **directories first** and each group sorted by name (case-insensitive).
   Directory rows end with `/`, file rows show a size, and a directory with more than
   5,000 entries shows the truncation banner instead of hanging.
2. **Navigation goes through the model** — click into a subdirectory, then use the `..`
   row to come back: the listing and the **tab title** follow the path each time. Now
   restart the app: the tab reopens on the **last visited path**, and the listing is a
   fresh read — create a file in that directory from WSL before restarting and it is there
   without any refresh gesture.
3. **A huge file opens instantly and stays bounded** — from WSL, make a few-hundred-MB log
   (`yes "$(date)" | head -c 400M > /tmp/big.log`) and click it in the folder browser: the
   text tab appears **immediately** (no multi-second freeze), and the bar above the text
   reads `bytes 0–… of …`. With `scripts/win/measure.ps1 -ProcessName mast` taken before
   and after, the private working set grows by **less than 20MB**. Then walk with `next` /
   `prev` / `last` / `first`: each button loads exactly one 512KiB window, the byte range
   updates, and the working set does **not** grow with the number of jumps — only one
   window is resident, and scrolling to the end of a window never continues automatically.
4. **Scroll position survives unmount and restart** — scroll to the middle of a text tab,
   switch to another tab in that pane and back: the same lines are on screen (the position
   is recorded ~0.5s after scrolling settles, and immediately on leaving the tab). Restart
   the app: the same lines again. Repeat once in a window **other than the first** (jump
   with `next`, scroll, leave, return) — the recorded value is a byte offset, so the
   restored view must land in that window, not back at the top of the file.
5. **Background viewer tabs hold no DOM** — with a viewer tab in the background (another
   tab active in that pane), inspect that pane's `.pane-content` in devtools: there is no
   `.folder-view` / `.text-view` element for the background tab. Activating it again
   re-mounts and re-reads.
6. **Missing and deleted files surface inline** — with a text tab open, delete the file
   from WSL, then leave the tab and come back: the tab **stays open** and shows
   `cannot read <path>: …` where the content was. Same shape for a folder browser whose
   directory was removed (`cannot list <path>: …`), and its `..` row still navigates out.

7. **Markdown renders and reloads live** — click a `.md` file in the folder browser: it
   opens **rendered** (headings, lists, code blocks), not as source. With that tab active,
   append a line from WSL (`echo '## appended' >> notes.md`): the rendered view picks it up
   within **2–4 seconds** without any gesture, and the scroll position stays where it was.
   Now switch to another tab in that pane and, from WSL, append again: nothing polls while
   the viewer is unmounted, and coming back re-reads once and shows the new content.
   Minimize the window (or switch to another app so the WebView reports `document.hidden`)
   and confirm from devtools that no `fs_stat` traffic continues while hidden; restoring
   the window resumes the 2s cycle. Finally, open a `.md` file **larger than 2MiB**: it
   refuses to render, says so in the banner, and offers **open as text** — clicking that
   opens the same path in a textViewer tab.
8. **Raw HTML is inert and links do nothing** — put this in a `.md` file and open it:
   `<script>alert('x')</script>`, `<img src=x onerror=alert(1)>`, `[click](javascript:alert(1))`,
   `![alt](https://example.com/pic.png)`. No dialog ever appears; the script and img tags
   are displayed **as literal text**; the image is a `[image: alt]` placeholder with no
   network request (check devtools Network); and clicking the link does nothing — no
   navigation, no new window, and the anchor has no `href` in the inspector. This is the
   security contract of the markdown viewer: this WebView holds the `dispatch`/`fs_*` IPC,
   so file-borne HTML must never reach the DOM.
9. **Locked-down distro** — repeat items 1–4 in a workspace whose distro has `automount`
   and `interop` disabled in `/etc/wsl.conf` (then `wsl --shutdown`): the viewers still
   work. File access runs Windows→WSL over `\\wsl.localhost`, the direction those settings
   do not gate (계획 v2 section 5).
10. **No edit affordance anywhere** — no viewer offers any way to change the file: no
    editable field, no rename/delete/save control, typing into a focused text or markdown
    view does nothing, and the only file-scoped controls are the text viewer's window
    movement buttons and the markdown viewer's **open as text** button (both read-only).
12. **Terminals stay alive across viewer switches** — start a long-running command (e.g.
    `top`) in a terminal tab, switch to a viewer tab in the same pane and back: the
    terminal is exactly where it was and still running, with **no replay flash** and no
    re-attach. Mounting a viewer must not disturb the keep-alive terminal views.
13. **Unconfigured distro resolves automatically** — with **no** workspace distro and
    **no** `MAST_DISTRO` (section 4), open a folder browser and a text file: both work,
    because the glue falls back to the WSL default distro (`wsl.exe -l -q`, cached for the
    process lifetime). Then set `MAST_DISTRO` to a second installed distro, restart, and
    confirm the viewers read **that** distro's filesystem. If every resolution path fails
    (e.g. no distro installed), the inline banner must say so loudly and name the fix
    (workspace distro or `MAST_DISTRO`) — never a silently empty listing.

### Post-checkpoint-2 fixes and keyboard-first UX — re-verification

Checkpoint 2 (2026-08-09) passed except three field defects; the fixes below plus the
keyboard-first UX batch need one focused re-verification round. Pull, run
`npm install` (no new runtime deps, but the lockfile moved), delete
`scripts/wsl/*.sh` and `git checkout -- scripts` once so the new `.gitattributes`
(`*.sh text eol=lf`) re-materializes them with LF endings, then rebuild.

1. **Hook auto-provisioning + tty fallback** *(historical — this round ran against setup v2;
   setup v16 adds dispatcher hooks, narrows the `Notification` matcher and wires Codex and
   Antigravity CLI hooks, so on a current build run §10 v0.3.32 items 1–2 instead, which cover
   the fresh distro, the second distro on demand and the idempotent relaunch below)* — the hooks
   are no longer wired by hand: on
   launch the app streams a setup script into `wsl.exe [-d <distro>] -- bash -s` once per
   distro (contract and manual fallback:
   [`scripts/wsl/claude-hook-example.md`](../scripts/wsl/claude-hook-example.md)). Start
   the app on a distro that has never run it and check, inside WSL:
   `~/.mast/bin/mast-notify.sh` exists and is executable, `~/.mast/setup.log` lists
   what happened, `~/.mast/.setup-v2` exists, and `~/.claude/settings.json` now carries
   the `UserPromptSubmit`/`Notification`/`Stop` hooks **with every pre-existing setting
   intact**. Then run a real Claude Code session: running → needsInput → idle must route
   as before, with no `/dev/tty: No such device or address` in the hook's stderr (the
   canonical script tries `/dev/tty` first and then walks up to 8 ancestor processes for a
   `/dev/pts/*` fd — the approach you field-tested, formalized). Also confirm:
   - **idempotence** — restart the app: `setup.log` gains no new lines and
     `settings.json` is unchanged (the marker short-circuits the whole script).
   - **already-wired hooks are left alone** — with a hand-wired hook still in place, the
     provisioner adds nothing for that event (no double OSC per prompt). (This round ran
     against setup v2. Since **v3** — marker `~/.mast/.setup-v3` — a hook that runs a
     `mast-notify.sh` from another path is *migrated* onto `~/.mast/bin/` instead of
     merely being skipped; still never duplicated. See the provision v3 section below.)
   - **new distro on demand** — create a workspace pinned to a second distro (section 4):
     that distro gets provisioned right after the workspace is created, without a restart.
   - **[conditional] Codex** — on a distro with `~/.codex/config.toml`, a root-level
     `notify` appears (or, if the file already had one, it is untouched and `setup.log`
     says so); finishing a Codex turn then shows `idle` in the sidebar.
2. **Markdown polling stops while minimized** — open a markdownViewer tab, minimize the
   window: `fs_stat` polling must stop within one 2s cycle (verify by appending to the
   file while minimized — no re-render happens until restore). Restore: polling resumes
   and the change lands within ~2-4s. Also confirm **no false positives**: dragging the
   window edge to resize and focusing another window (mast still visible) must NOT stop
   polling — the live-preview-while-editing-elsewhere flow depends on it. (The minimize
   signal is a 0x0-Resized heuristic that cannot be checked on the Linux host.)
3. **Shell scripts run directly** — `bash scripts/wsl/osc-test.sh` works without the
   `sed 's/\r$//'` workaround after the re-checkout above.
4. **Global shortcuts** — `Ctrl+Shift+W` (close active tab, viewer tabs included; on the
   last empty pane it is a quiet no-op), `Ctrl+Shift+T` (new terminal tab),
   `Ctrl+Shift+D` (split top/bottom), `Ctrl+Shift+E` (split left/right),
   `Ctrl+Shift+B` (folder browser tab), `Ctrl+Shift+N` (focus the sidebar's new-workspace
   name input). Each must act **and** leave nothing in the terminal. These are Chromium
   accelerator combos (incognito/reopen-tab/bookmarks-bar/bookmark) — WebView2 usually
   lacks those features, but if any key does nothing at all, record it: the follow-up is
   `AreBrowserAcceleratorKeysEnabled(false)` or a rebinding.
5. **Tooltips show shortcuts** — hovering the pane-header buttons (`+`, `▤`, split pair),
   the tab `×`, and the sidebar's new-workspace button shows the function plus its
   shortcut (single source: `shared/keys.ts shortcutLabel`).
6. **Folder browser keyboard navigation** — with the folder list focused: arrows move the
   selection highlight, `Home`/`End` jump, `PgUp`/`PgDn` move by 10, `Enter` opens the
   selected row (directory navigates, file opens a viewer), `Backspace` goes to the
   parent. `Ctrl+Shift+arrows` must still move pane focus (the view only consumes unmodified
   keys). Verify a mouse click moves the selection too, and that keyboard navigation
   still works right after opening a directory by mouse.
7. **Text viewer windows by keyboard** — with the text view focused: `Ctrl+PgUp`/
   `Ctrl+PgDn` move one 512KiB window, `Ctrl+Home`/`Ctrl+End` jump to the first/last
   window, plain `PgUp`/`PgDn` page by whole lines (no half-cut top line). Window buttons
   disable at the ends (first/prev at offset 0, next/last on the last window) and their
   tooltips name the shortcuts. **Last-line fix**: `Ctrl+End` on a large file must show
   the file's actual last line (a read-length bug used to make it unreachable).
8. **Window restore keeps context** — scroll mid-file in a >512KiB file, restart: the
   same top line is visible **and** you can scroll upward within the window (the window
   is now centered on the saved offset instead of starting at it).
9. **Per-tab shell history** — run distinct commands in two terminal tabs, restart the
   app: each respawned tab's `history` (and up-arrow) shows only its own tab's commands
   (`~/.mast/history/tab-<id>` in the distro). Then close a tab normally and restart:
   report whether its history survived — bash writes `HISTFILE` on exit, and if the kill
   path skips it we need a `history -a` follow-up.
10. **Reload-while-minimized edge (known, accept)** — if the WebView reloads while the
    window is minimized (auto-reset), polling resumes until the next minimize/restore
    cycle. Accepted narrow window; no action needed unless it bites in practice.
11. **UI cleanup (display only — no feature was removed)** — the top status line is now
    ephemeral: at rest it is collapsed entirely (no `workspace: … · panes: … · rev …`
    log, and the terminal area starts right below the title bar). It appears only while
    send-mode is armed (the prompt) or for a dispatch error (red, gone after ~5s), and
    collapses again afterwards. Sidebar cards are three lines — name (+ unread dot, ×) /
    status text (`running` / `needs input` / `idle`, followed by ` — <last agent message>`
    when there is one, `needs input` being the only accented one) / abbreviated path;
    no more `⚡`/`🔔` icons, pane/tab counts, or branch field. Pane headers no longer show
    the `#<id>` label or the permanently disabled `◎` browser button — the unread `●`
    badge and the six working buttons (`+ ▤ ⤷ ⤷⏎ ◫ ⊟`) stay, with their tooltips intact.
12. **Rename migration (`wmux` → `winmux`)** — the project was renamed (the old name
    collided with an unrelated existing project). This is a one-time, single-developer
    migration handled by hand, not by migration code. On the Windows checkout:
    - **Remote** — GitHub redirects the old repository URL, but update it explicitly:
      `git remote set-url origin git@github.com:sjkwon-1023/winmux.git`. The local folder
      name is free (rename it to `winmux` or leave it — nothing reads it).
    - **App state (do this or you boot fresh)** — the Tauri identifier changed from
      `app.wmux.desktop` to `app.winmux.desktop`, so the state directory moved. Rename
      `%APPDATA%\app.wmux.desktop` to `%APPDATA%\app.winmux.desktop` and the existing
      workspaces/panes/tabs restore exactly as before. Skip it and the app boots with an
      empty state — nothing is lost, the data just sits in the old folder until you move
      it. (The spike's identifier moved `app.wmux.spike` → `app.winmux.spike` the same
      way, but it persists nothing.)
    - **Environment variables** — every `WMUX_*` knob is now `WINMUX_*`. If you had
      `WMUX_DISTRO` set (section 4), set `WINMUX_DISTRO` instead — the old name is no
      longer read, and a stale one silently does nothing. Same for any `WMUX_RESET_*` /
      `WMUX_OSC_FLUSH_MS` you set for the section 9 checks.
    - **Claude Code hooks** — the OSC status token is now `winmux:running` /
      `winmux:needsInput` / `winmux:idle`. Auto-provisioning (item 1) wires the new hooks
      for you, but it never edits an entry that is already there, so a leftover `wmux:*`
      hook has to be **deleted by hand** from `~/.claude/settings.json`; until it is, it
      keeps landing as a status-neutral notification (unread dot, no status change) on top
      of the new ones. The contract is
      [`scripts/wsl/claude-hook-example.md`](../scripts/wsl/claude-hook-example.md).
    - **Shell history in WSL** — `mv ~/.wmux ~/.winmux` in the distro keeps every tab's
      history (item 9). Without it each respawned tab starts with an empty history.

### Post re-verification polish — verification

The re-verification round above passed in full on 2026-08-10. The batch below landed
right after it: a `Shift+Enter` rewrite for agents, a sidebar reflow fix, a folder-first
new-workspace flow, and a surface cleanup (send buttons retired, icons redrawn). Rebuild
and check these; nothing here needs a fresh `npm install`.

1. **`Shift+Enter` inserts a newline in Claude Code** — in a terminal tab running Claude
   Code, type a word, press `Shift+Enter`: the prompt must grow a second line instead of
   submitting. Plain `Enter` still submits. The terminal now emits `ESC CR` for that
   combo itself, so this must work **without** running Claude Code's `/terminal-setup`.
   Then confirm it is harmless everywhere else: at a bash prompt `Shift+Enter` must
   behave like a normal `Enter` (runs the line / gives a fresh prompt — no stray escape
   character left on the line), and in `vim` insert mode it must still open a new line.
2. **Sidebar width never moves** — with a workspace whose card shows a long status line
   (run a Claude Code session so the status becomes `needs input — <a long agent
   message>`), watch the sidebar's right edge across `running` → `needs input` → `idle`
   transitions: it must stay pinned at 220px and the terminal area must not reflow. Long
   text is cut with an ellipsis on each of the card's three lines. Also drag the window
   narrower and confirm the sidebar still holds its width.
3. **Folder pick creates the workspace immediately** — the sidebar's new-workspace button
   opens the Windows folder dialog directly; there is no name field to fill in any more.
   Picking a folder creates the workspace **in one step** (name = folder name, root path =
   the converted Linux path) with a terminal tab already in it, and the new tab's shell
   starts in that directory (`pwd`). Cancelling the dialog does nothing at all (no error,
   no empty workspace). Verify both path shapes:
   - **WSL filesystem (UNC)** — pick something under `\\wsl.localhost\<distro>\home\...`:
     the workspace root must come out as the plain Linux path (`/home/...`) and the tab
     must run in **that distro** even when it is not the default one.
   - **Windows drive is refused** — pick e.g. `C:\Users\<you>\code`: the status line must
     show a clear error ("Windows drives cannot host a workspace ...") and **no** workspace
     may appear. Drives are data-only by decision (2026-08-11) — browse them with the folder
     viewer instead. The core enforces the same rule (`/mnt` roots are rejected even via the
     dev hook), so nothing can slip through another path.
   - **Rejected paths** — create one from inside WSL (`mkdir '/tmp/badname.'` — note the
     trailing dot), then pick it through the UNC view: the status line must show a loud
     path error and **no** workspace may appear. Trailing dot/space and `\` in names are
     refused on purpose — the same rule the viewer tabs use, so a bad name can never be
     assembled into a different Windows path than the one you clicked. (Do **not** test
     this with a `:` name: the 9P server shows `:` to Windows as a private-use character,
     so the picked path contains no literal `:` and passes validation — the name would
     fail later, at spawn/cwd time, which is acceptable but is not this item.)
4. **`Ctrl+Shift+N` creates a workspace from the current directory** — `cd` somewhere in a
   terminal (with the OSC 7 prompt snippet wired the live directory is used; without it, the
   spawn-time directory), press `Ctrl+Shift+N`: a workspace rooted there appears
   immediately, named after the folder, same distro — **no dialog**. In a directory under
   `/mnt` it must refuse with a status-line error instead (drives are data-only). With no
   workspace open at all it falls back to the folder picker. Nothing may leak into the
   terminal. The sidebar `+` button still opens the picker for arbitrary folders.
5. **`F2` renames the active workspace** — press `F2`: the active sidebar card's name
   turns into an inline text box, pre-filled and fully selected. `Enter` commits; `Esc`
   **and** clicking away both cancel and restore the old name. An all-whitespace name is
   refused — the box stays open and focused instead of sending anything. Committing an
   unchanged name sends nothing. While the box has focus, typing must land in the box and
   not in the terminal.
   Known trade-off: `F2` no longer reaches TUI apps (e.g. `mc`'s Rename) — confirm that
   is the only casualty and that `F1`/`F3`… still reach the terminal.
6. **`Ctrl+Shift+[` / `Ctrl+Shift+]` cycle workspaces** — with three or more workspaces,
   `]` moves to the next in sidebar order and wraps at the end, `[` moves back and wraps
   at the start; with a single workspace both are quiet no-ops. Check them on a keyboard
   layout where `[`/`]` need no modifier and, if you have one handy, on a layout where
   they do — both the bare characters and their shifted forms (`{`/`}`) are matched.
7. **Send buttons are gone** — the pane header now has exactly four buttons: new terminal
   tab, folder browser tab, and the two splits. The `⤷` / `⤷⏎` pair and its
   target-selection mode (crosshair cursor, status-line prompt, `Esc` to cancel) are
   **retired**, so `Esc` now always belongs to the terminal: press `Esc` in `vim` and it
   must leave insert mode on the first press. Clicking a pane always just focuses it.
   Selection + `Ctrl+Shift+C` copy is untouched. (Agent-facing text passing returns in v2
   as a designed channel, not as a manual button.)
8. **Redrawn icons** — the pane header's folder button is now a drawn folder outline, and
   the two split buttons are a matched pair: one rectangle split by a **vertical** line
   (left/right) and the same rectangle split by a **horizontal** line (top/bottom). At a
   glance it must be obvious which is which; click each and confirm the split direction
   matches its picture. The icons must inherit the header's text colour (including the
   hover background) and stay crisp at the OS display scaling you use. Tooltips still
   read `<function> (<shortcut>)`.
9. **App icon** — the exe, its taskbar button, the window's title-bar corner and
   `Alt+Tab` must all show the new icon: a blue `W` on a near-black square. Check it at
   small sizes too (taskbar, 16px file-explorer list view) — the `W` must stay readable,
   not a blue smudge. If Explorer still shows the old icon after a rebuild it is the
   Windows icon cache, not the build: `ie4uinit.exe -show` or a fresh folder view.

### Agent send channel — verification

The agent-facing pane-to-pane send channel (`OSC 777;mast-send`; contract in
[`scripts/wsl/claude-hook-example.md`](../scripts/wsl/claude-hook-example.md), agent-side
instructions in `scripts/wsl/skills/mast-send/SKILL.md`). Run the app from a console
(`npm run tauri dev`) so its stderr is visible — every failure of this channel is logged
there and **nowhere else**.

Open two terminal tabs. In the one that will receive text, set a title; in the other, send.

```bash
# receiver
printf '\033]0;build\007'
# sender
printf '\033]777;mast-send;build;'"$(printf '%s\n' 'echo delivered' | base64 -w0)"'\007' > /dev/tty
```

1. **Delivery** — `echo delivered` appears in the receiver **and runs** (the payload carries
   the trailing newline). The sender's own screen shows nothing at all: no echo of the
   sequence, no confirmation, no error.
2. **Off screen still arrives; another workspace does not** — first the reach: in the
   receiver's pane switch to a different tab so the receiver sits in the background, and send
   again. The text must still arrive (switch back to check) — this is the point of the
   channel, it does not go through the frontend. Then the boundary: move the receiver to a
   **second workspace** and send from the first. **Nothing may arrive**, addressed by title or
   by `#<id>` alike, and the app's stderr reports no match (workspace confinement, user
   decision 2026-08-11 — a workspace is the project isolation unit, so the channel stops at
   it).
3. **Ambiguity refuses to fire** — title a third tab `build-2` and send to `build` again:
   **neither** tab may receive anything, and the app's stderr says how many matched. Retitle
   it, confirm delivery resumes.
4. **No match** — send to `nosuchtab`: nothing arrives anywhere, stderr says so.
5. **Self-send is impossible** — title the sender itself `build` while the receiver keeps
   that title too: the send still lands in the receiver (the sender is excluded, so the
   match stays unique). With the receiver closed, sending to `build` from the sender must
   deliver nothing.
6. **Bad payloads are rejected** — send with a non-base64 body
   (`printf '\033]777;mast-send;build;not base64!\007' > /dev/tty`) and with a huge one
   (`head -c 200000 /dev/zero | base64 -w0`): nothing arrives, the sender is unaffected, and
   the oversize case is discarded without a log line — the decoder refuses anything over the
   32 KiB text contract, and OSC payloads over 64 KiB never even reach the parser.
7. **Notifications still work** — with the send channel exercised, run a Claude Code session
   in one of the tabs and confirm the section 10 item 1 statuses (`running` → `needsInput` →
   `idle`) still route as before: adding `mast-send` must not disturb the `notify` contract.
8. **Skill is installed** — inside WSL, `~/.claude/skills/mast-send/SKILL.md` exists after
   the app has provisioned the distro (it is installed by the same setup script, marker
   `~/.mast/.setup-v3`), and a Claude Code session in a mast tab can find it by name.

### Agent integration on real hardware (provision v3) — re-verification

Found on the machine after checkpoint 2: the hooks a user had wired by hand still pointed at
their own `~/.claude/hooks/mast-notify.sh`, so the newer provisioned script never ran; an
agent had no way to tell it was inside mast; and the send channel had to be re-derived from
the raw escape sequence every time. Setup version 3 (`~/.mast/.setup-v3`) addresses all
three, and the last two items below cover the front-end half of the same batch.

The v3 marker differs from v2, so **an already-provisioned distro re-provisions on the next
launch** — no manual cleanup. Run the app from a console so its stderr is visible.

1. **Hooks are migrated onto the provisioned script** *(on setup v16 and later the migration
   still applies, but the log reads `migrated <Event>` / `added <Event> role=status` /
   `wired <Event> role=status`, and `mast-claude-hook.sh` dispatcher hooks are added next to
   the three below)* — before launching, note what
   `~/.claude/settings.json` has (a hand-wired setup points at `~/.claude/hooks/…`). Launch
   the app once, then check:
   - all three of `UserPromptSubmit` / `Notification` / `Stop` now run
     `"$HOME/.mast/bin/mast-notify.sh"`, with the **arguments unchanged** (`mast:running`,
     `mast:needsInput 'needs input'`, `mast:idle done` — or your customised bodies),
   - **no event has two mast hooks**, and every hook that is not ours (other tools, other
     events such as `PreToolUse`) is byte-for-byte as it was,
   - `~/.mast/setup.log` names what happened per event — `migrated` / `added` /
     `already wired` — and `~/.mast/.setup-v3` exists,
   - launching again changes nothing (the marker short-circuits; deleting the marker and
     relaunching must log `already wired` and leave the file untouched).
   Then run a Claude Code session in a tab and confirm the section 10 item 1 statuses still
   route (`running` → `needs input` → `idle`): the migration is only worth anything if the
   migrated path actually fires. The old `~/.claude/hooks/mast-notify.sh` is left on disk
   on purpose — nothing references it any more; delete it by hand if you want it gone.
2. **`mast-send.sh` sends without hand-assembling the sequence** — title one tab
   (`printf '\033]0;build\007'`) and from another tab:
   ```bash
   ~/.mast/bin/mast-send.sh build 'echo delivered'      # arrives and runs
   ~/.mast/bin/mast-send.sh -l build 'echo prefilled'   # arrives, waits at the prompt
   ~/.mast/bin/mast-send.sh nosuchtab hi; echo "exit=$?" # nothing arrives, exit=0, silent
   ~/.mast/bin/mast-send.sh build; echo "exit=$?"        # usage error on stderr, exit=2
   ```
   The sending pane must show no echo of the sequence and no confirmation for the deliveries.
   Then have a **Claude Code session** in a tab call the helper (ask the agent to send
   something to `build` — the `mast-send` skill now points it here): it must arrive from
   the agent's tool context too, which is the case that has no controlling TTY.
3. **A tab knows it is mast** — in a fresh terminal tab, `echo "$MAST / $MAST_TAB"`
   prints `1 / <number>`. The number is that tab's id: it is stable across an app restart
   for the same tab, and two tabs never share one. It must survive into child processes
   (`bash -c 'echo $MAST_TAB'`, and a Claude Code session's Bash tool). Existing per-tab
   history keeps working — the same wrapper sets `HISTFILE` — so check that a restarted tab
   still recalls its own history with the up arrow.
4. **Codex's input box is legible** — run `codex` in a tab: its composer box border, the
   separator line above it and the dim placeholder text must all be clearly distinguishable
   from the terminal background (the failure this fixes was a TUI that dissolved into the
   background). Check the same for another TUI you have handy (`htop`, `mc`) so the palette
   is not merely tuned to one app, and confirm normal ANSI colours in `ls`/`git diff` still
   look right.
5. **The needs-input chime** *(historical — the chime was removed in v0.3.7; run §10 v0.3.7
   item 2 instead on any current build)* — with the app focused, click or press a key once (the audio
   context unlocks on the first gesture), then run a Claude Code session and let it ask a
   question: a short two-tone chime plays **once** as the workspace turns `needs input`.
   Then confirm the quiet cases: no sound on `running` or `idle`, no repeat while it stays
   at `needs input`, and none at all on app start when a restored workspace is already at
   `needs input`. With two workspaces going to `needs input` in the same snapshot it must
   still be a single chime. The sound is synthesised in the WebView, so nothing needs to be
   installed; if it does not play at all, check that the first-gesture unlock happened (the
   dev console logs a debug line when the audio context is unavailable).

### Query channel + mast CLI, workspace-scoped (provision v5) — verification

The agent channel gained a read half (`OSC 777;mast-query`, contract in
[`scripts/wsl/claude-hook-example.md`](../scripts/wsl/claude-hook-example.md)) and a single
CLI in front of both halves, and **both halves are confined to the requester's own workspace**
(user decision 2026-08-11). Setup version 5 (`~/.mast/.setup-v5`) installs
`~/.mast/bin/mast`, turns the v3 `mast-send.sh` into a wrapper around `mast send`, and
rewrites the `mast-send` skill around the CLI with the workspace-scoped rules. The v5 marker
differs from v4, so **an already-provisioned distro re-provisions on the next launch** — no
manual cleanup. Run the app from a console (`npm run tauri dev`) so its stderr is visible:
every failure of these channels is logged there and **nowhere else**.

1. **The CLI is installed and on `PATH`** — in a **new** terminal tab (an existing tab was
   spawned by the previous build and has the old environment):
   ```bash
   command -v mast      # /home/<you>/.mast/bin/mast — no path needed
   mast id              # this tab's id, the same number as $MAST_TAB
   mast --help          # three usage lines plus the addressing and COMMAND notes
   ```
   Confirm `~/.mast/.setup-v5` exists and `~/.mast/setup.log` names the CLI install, and
   that per-tab history still works (up arrow recalls this tab's own history — the same
   wrapper sets `PATH` and `HISTFILE`, so a mistake there breaks both).
2. **`mast ls` lists this workspace's tabs and no others** — open several tabs across
   **two workspaces**, give a couple of them titles (`printf '\033]0;build\007'`), open a
   viewer tab (a folder or a markdown file), and let one tab's terminal exit. Then from a tab
   in each workspace in turn:
   ```bash
   mast ls
   ```
   - every tab **of the workspace you ran it in** appears, grouped pane → tab, including tabs
     that are not the ones currently on screen,
   - **no tab of the other workspace appears** — run it from both sides and confirm the two
     tables are disjoint,
   - `STATUS` is `running` / `exited` / `viewer` and matches what the tabs actually are,
   - the row for the tab you ran it in carries `*` in the `TAB` column,
   - `WORKSPACE` shows your own workspace's name, the same on every row.
   The sending pane shows no escape sequence and no stray output — only the table.
3. **The `COMMAND` column** — in one tab start something long-running (`sleep 300`, `htop`,
   a Claude Code session) and leave another sitting at its prompt, then run `mast ls` from a
   third:
   - the busy tab names the command, the idle tab shows `-`,
   - a tab running in **another WSL distro** (make a workspace with a different distro) shows
     `?`, and so does a tab running a Windows shell — this is the documented limit of reading
     `/proc` from one distro, not a bug,
   - an `exited` tab and a viewer tab show `-` (nothing runs in them by definition).
4. **`#<id>` addressing beats titles** — give **two** tabs the same title (`build`), then:
   ```bash
   mast send build 'echo ambiguous'   # nothing arrives; stderr says how many matched
   mast send '#181' 'echo by id'      # arrives in tab 181 only, and runs
   mast send -l '#181' 'echo literal' # arrives, waits at the prompt
   mast send '#999999' hi             # nothing arrives anywhere, silent, exit 0
   ```
   Take the ids from `mast ls`. Quoting matters — an unquoted `#181` is a shell comment.
   Send to the id of the **viewer** tab and of the **exited** tab: both must deliver nothing.
   Send to your own id: nothing arrives (self-exclusion). Finally take an id from the **other
   workspace** (read it from a `mast ls` run over there, since your own listing no longer
   shows it) and send to it: nothing arrives either — a globally unique id is still not a key
   past the workspace boundary.
5. **The old helper still works** — `~/.mast/bin/mast-send.sh build 'echo compat'` and its
   `-l` form behave exactly as in the v3 round above; the file is now two lines.
6. **Timeout outside mast** — in a plain WSL terminal (Windows Terminal, not mast):
   ```bash
   ~/.mast/bin/mast ls; echo "exit=$?"
   ```
   After ~2s it must print `no reply from mast (not inside mast, or the app is an old
   version)` on stderr and exit 1, printing no table. Then confirm the same for the mismatched
   pair: run this **new** CLI while an **older mast build** (one without the query channel)
   is the app — same message, same 2s, and the older app's stderr shows nothing, because an
   unknown OSC kind is simply not parsed. Check `ls /tmp/mast-query-*` afterwards in both
   cases: **no leftover files**, and none with a `.partial` suffix.
7. **The reply file is cleaned up and never half-read** — run `mast ls` in a loop
   (`for i in $(seq 20); do mast ls > /dev/null || echo FAIL; done`) and confirm every run
   succeeds and `/tmp` has no `mast-query-*` left behind. Then run two `mast ls` at the
   same time from two tabs: both must get their own complete table (the query is not
   coalesced, and each names its own reply file).
8. **Nothing else regressed** — with the channels exercised, run a Claude Code session in a
   tab and confirm the section 10 item 1 statuses (`running` → `needsInput` → `idle`) still
   route, and that the agent finds the rewritten skill by name and uses `mast ls` →
   `mast send '#<id>'` on its own when asked to hand work to another pane.

### v0.3.1 + v0.3.2 — verification

Six items: the OSC 10/11 colour-query responder, the workspace confinement of the agent
channel, terminal font settings, the new-workspace button unification, the Codex AGENTS.md
guidance, and — added in v0.3.2 — the per-tab agent resume hint. Run the app from a console
(`npm run tauri dev`) — item 1 is decided by a line on the app's **stderr**, and nothing else
reports it. Setup version **6** (`~/.mast/.setup-v6`) carries the v0.3.2 notify script, and
the marker differs from v5, so **an already-provisioned distro re-provisions on the next
launch**; the wrapper half reaches only tabs opened after this build, so item 6 needs new tabs.

1. **Codex's input box** — **CLOSED 2026-08-12 as out-of-app.** The release-side probe
   returned an empty reply on the field machine: conhost consumes the OSC 11 query and
   answers no one (not even from its own table), so neither the in-app responder nor the
   THEME_SYNC set can reach Codex's background probe. Upstream tracking:
   openai/codex#19741 (composer pill lost when the color query is blocked). The
   responder and THEME_SYNC stay — they cost nothing and cover conhost versions that do
   forward or answer. Original item kept below for machines where the probe answers.

1. (original) **Codex's input box** — open a **new** tab (an existing tab predates this build) and start
   `codex`. The input prompt must be drawn as a filled pill that separates from the terminal
   background, not as bare text on the background.

   Whatever the screen shows, decide by one of two signals. **A release exe has no
   console, so its stderr is invisible** — there, run the probe inside a mast tab
   instead: `old=$(stty -g); stty raw -echo min 0 time 5; printf '\033]11;?\033\\';
   resp=$(dd bs=64 count=1 2>/dev/null); stty "$old"; printf '%s\n' "$resp" | cat -v` —
   an `^[]11;rgb:1e1e/...` reply means the query path works (responder or xterm
   answered); an empty reply means conhost consumed the query and the item closes as
   out-of-app. In a dev run (`npm run tauri dev`) the stderr line is the same signal:
   - `[mast] color query 11 answered (session=<n>)` present → the query reached us and we
     answered with the theme background (`#1e1e1e`). If the pill is *still* invisible after
     that, the remaining suspect is Codex's own colour choice, not the query path. Note that
     in this world xterm.js may answer the same query too (identical value, second reply is
     an unsolicited byte burst) — re-run the earlier probe one-liner and count how many
     `rgb:` replies come back if Codex misbehaves.
   - **no such line at all** → the query never left conhost: it intercepted the sequence and
     did not pass it through, so no responder inside the app can ever see it. **That closes
     this item as an out-of-app (conhost) problem** — do not add more app-side responders.
     The `THEME_SYNC` set on spawn (`host.rs`) stays as the only lever we have there.

   The responder's reply values live in `sink.rs` (`COLOR_REPLY_FOREGROUND` /
   `COLOR_REPLY_BACKGROUND`) and are one leg of a three-way contract with `host.rs`'s
   `THEME_SYNC` and `features/terminal/settings.ts`'s `TERMINAL_THEME` — if you retheme, all three move
   together.

2. **Workspace isolation of the agent channel** — with tabs open in **two** workspaces, run
   `mast ls` from a tab in each:
   - each listing shows only the tabs of the workspace it was run in, and the two tables are
     disjoint,
   - take a tab id from the *other* workspace's listing and `mast send '#<id>' 'echo x'`:
     nothing arrives there, silently (a globally unique id is still not a key past the
     workspace boundary).

   This repeats section 10's "Query channel" items 2 and 4 deliberately — it is the regression
   check that the confinement survived this batch.

3. **Terminal font from `settings.json`** — the file is written by hand; there is no settings
   UI. Create `%AppData%\app.mast.desktop\settings.json`:
   ```json
   {"fontFamily": "Cascadia Code, Consolas, monospace", "fontSize": 15}
   ```
   Restart the app (this is read once at boot, so a reload is not enough — quit and relaunch).
   - every terminal tab, including ones restored from the saved layout, renders in that font
     and size, and `fit` still gives a sane column count (no clipped or overlapping cells),
   - remove the file and restart → back to Consolas 13, no error,
   - break the JSON (drop the closing brace) and restart → the status line briefly shows a
     `cannot parse ...settings.json` error and **the app still boots** with the default font;
     the same holds for `{"fontSize": 200}`, which reports an out-of-range fontSize (6-72).

4. **The New workspace button matches Ctrl+Shift+N** (field bug 2026-08-11) — with a
   workspace open, click the sidebar's `+ New workspace` button: a workspace rooted at the
   active terminal's current directory appears immediately, **no folder dialog**. The dialog
   appears in exactly one situation: pressing either entry point when **no workspace exists
   at all** (first boot) — then there is no "current directory" to use.

5. **Codex sandbox guidance (`~/.codex/AGENTS.md`)** — after this build's provisioning runs
   (marker `.setup-v6`), `~/.codex/AGENTS.md` in the distro contains the managed
   `mast integration` block (only when `~/.codex` already existed). Ask Codex to run
   `mast ls`: it should request escalated/non-sandboxed execution per the guidance —
   sandboxed runs fail silently because the sandbox blocks the terminal device and mounts a
   private `/tmp`. Any text of yours outside the managed block must be untouched.

6. **Agent resume hint across a restart** (v0.3.2; contract in
   [`scripts/wsl/claude-hook-example.md`](../scripts/wsl/claude-hook-example.md), "Resume
   hint") — this needs the new provisioning *and* a new tab, so launch this build once to let
   it re-provision (confirm `~/.mast/.setup-v6` exists), then open a **fresh** terminal tab.
   ```bash
   echo "$MAST_TAB"        # the tab id the file below is named after
   claude                    # ask it anything, so the hooks fire at least once
   ```
   - while that session runs, `cat ~/.mast/resume/tab-$MAST_TAB` shows two lines: a
     `claude --resume <uuid>` command and an epoch timestamp. Ask a second question and check
     that the timestamp moves — it is rewritten on every hook call,
   - **quit mast and relaunch it.** The tab comes back as a fresh shell, and just above the
     first prompt sits one dimmed line: `[mast] resume previous agent: claude --resume <uuid>`,
   - press **↑ once** at that prompt: the same command is on the command line, unrun. Nothing
     was executed on your behalf — confirm the tab is at a plain prompt, not inside Claude.
     Press Enter and the session comes back with its history,
   - open a **different** new tab (one that never ran an agent) and confirm it prints **no**
     hint line at all, and that ↑ there recalls that tab's own history as before,
   - start a **second, different** Claude session in the first tab, restart again, and confirm
     the hint names the newer session — the most recent one wins.
   Note: recording starts with the **first hook event after this build's provisioning**
   (v6) — a session that ran before the update left no record, so the very first restart
   after updating shows no hint yet. Run one prompt through Claude first, then restart.

   The hint is shown whenever the file exists, no matter how old it is (freshness is your
   call, and line 2 is there to check by hand). Codex sessions were not recorded in this
   version; they are as of v0.3.5 (setup v7) — see that checklist below.

### v0.3.4 — verification

The v0.3.4 backlog batch. Items are independent — run them in any order on a build of this
batch, from a console (`npm run tauri dev`) unless an item says otherwise.

1. **Terminal zoom — `Ctrl+=` / `Ctrl++` / `Ctrl+-` / `Ctrl+0`** (session-only by decision;
   the interception rows and the trade-off note live in the
   [`apps/mast/src/shared/keys.ts`](../apps/mast/src/shared/keys.ts) module doc).
   - **All tabs move together** — with at least two panes and two tabs per pane, press
     `Ctrl+=` a few times: the visible terminals grow in step, and switching to the hidden
     tabs shows them at the same size (they refit on becoming visible, not before). A tab
     opened *after* zooming opens at the zoomed size — no per-tab font divergence anywhere
     in the window, including tabs restored in another workspace.
   - **The `+` key works as `+`** — on a US layout the zoom-in key is physically `Shift+=`;
     pressing `Ctrl` + the key labelled `+` must zoom in, not do nothing.
   - **Clamp** — hold `Ctrl+=` and let auto-repeat run past the top: the size stops at 72px
     and stays there (no error, no runaway growth, the app stays responsive). Same at the
     bottom with `Ctrl+-` → 6px. These bounds are the same range the backend enforces for
     `settings.json` (`FONT_SIZE_RANGE` 6-72 in `commands.rs`); a size reachable by zoom but
     rejected in the file would mean the two drifted apart.
   - **Reset goes to *your* default, not the app default** — write
     `%AppData%\app.mast.desktop\settings.json` with `{"fontSize": 15}` and relaunch; zoom
     away from it, then `Ctrl+0` → back to **15**, not 13. Remove the file, relaunch, and
     `Ctrl+0` lands on 13.
   - **Session-only** — after zooming, quit and relaunch: terminals come back at the
     `settings.json` size (or 13), and the file's contents/timestamp are untouched. The app
     never writes zoom back.
   - **Nothing leaks into the terminal** — at a shell prompt with an empty command line,
     press all four combinations: the font changes and the command line stays **empty** (no
     stray `=`, `-`, `0`, `+`). Repeat inside a TUI (`htop`, `vim`) — the keys zoom and the
     app underneath does not see them.
   - **The grid really refit** — after a zoom, `tput cols; tput lines` reports the new grid
     (the PTY got the resize, not just the renderer), and a full-screen TUI redraws filling
     the pane with no clipped or overlapping columns.
   - **The accepted trade-off: `C-_` is no longer the shell's** — in `bash`, `Ctrl+-` /
     `Ctrl+_` used to be undo on the command line. Type a few words, press `Ctrl+-`, and
     confirm the font shrinks **and the undo does not happen**. This is intended (same class
     as `Ctrl+1`-`Ctrl+9`); if it proves too costly in the field, the fix is to drop the row
     from the shared/keys.ts table, not to special-case it. `Ctrl+Shift+-` is *not* intercepted, so
     whatever that sends still reaches the shell.
   - **`Ctrl+0` is not a workspace switch** — with several workspaces open, `Ctrl+0` only
     resets the font (workspace ordinals stay `Ctrl+1`-`Ctrl+9`).

2. **needsInput toast — fires only while the window is unfocused.** *(Historical: v0.3.7
   replaced this rule and removed the chime — a focused window now still toasts for workspaces
   it is not showing, and nothing makes a sound. Run §10 v0.3.7 item 2 on any current build.)*
   The chime already covers
   the focused case; the toast exists for the moment mast is *not* the window you are
   looking at. It rides the same onset rule as the chime
   ([`apps/mast/src/features/notifications/chime.ts`](../apps/mast/src/features/notifications/chime.ts), `detectNeedsInputOnset`), so
   drive it the same way: let an agent (Claude Code) reach a state where it waits for you —
   a permission prompt is the easiest.
   - **Unfocused → toast** — click another window (an editor, Explorer) so mast loses
     focus, then let the agent hit needsInput. A Windows toast appears bottom-right with the
     title `mast — <workspace name>` (since v0.3.32 `mast — <workspace name> · <tab title>`)
     and, as the body, the **first line** of the agent's last message; with no message recorded
     the body reads `agent needs your input`. The workspace name is the point of the
     notification — it is how you know which project is waiting.
   - **Focused → no toast, chime only** — repeat with mast focused (click into a terminal
     first): the chime plays and the sidebar highlights, but **no toast appears**. A toast
     on top of the window you are already reading is noise, so this half is as much of a
     requirement as the first.
   - **One toast per workspace, one chime per batch** — with two workspaces entering
     needsInput in the same snapshot while unfocused, expect two toasts and a single chime.
     Staying in needsInput (later redraws, tab activity) produces neither — only the rising
     transition notifies.
   - **Sender identity for an unsigned standalone exe** *(field item — report what you see)*
     — the toast is issued under the bundle identifier `app.mast.desktop`, and Windows
     resolves the displayed sender from an installed app registration. A standalone,
     unsigned, never-installed `mast-app.exe` may therefore show a generic or missing
     sender, and may land in the Action Center under an odd name. Note the exact sender text
     and whether the toast reaches the Action Center at all; if it looks wrong, report it
     rather than working around it — the fix would be a registration/shortcut question, not
     an app-code one.
   - **Failure stays silent by design** — if notifications are turned off for the app
     (Settings → System → Notifications) or Focus Assist swallows them, nothing else may
     break: the chime still plays, the UI keeps working, and the only trace is a
     `console.debug` line (`needsInput toast failed`) in the dev console. Confirm that, and
     treat it as correct behavior rather than a defect — the toast is an auxiliary signal,
     same discipline as the chime.

### v0.3.5 — verification

**Codex gets the resume hint.** Setup version **7** (`~/.mast/.setup-v7`) installs
`~/.mast/bin/mast-codex-notify.sh` and points Codex's `notify` at it, so a Codex thread
is recorded per tab exactly as a Claude Code session already was
([`scripts/wsl/claude-hook-example.md`](../scripts/wsl/claude-hook-example.md), "Resume
hint"). Run these in a distro that has Codex installed, on a build of this version.

1. **Provisioning replaced mast's own `notify` line, and only that.** Launch the app once
   and confirm `~/.mast/.setup-v7` exists, then read `~/.codex/config.toml`: the `notify`
   value is now

   ```toml
   notify = ["bash", "-lc", 'exec "$HOME/.mast/bin/mast-codex-notify.sh" "$0"']
   ```

   and **everything else in the file is untouched** (model, `[tui]`, your own keys, the
   comment above the line). `~/.mast/setup.log` says `notify upgraded to
   mast-codex-notify.sh`. Launch again after deleting the marker and it says `already runs
   mast-codex-notify.sh; left untouched` — the second run must not rewrite anything.

2. **A hand-written `notify` is not migrated.** In a distro where you have edited that line
   yourself (or fake it: change the wording inside the quotes, or point it at your own
   script), delete the marker and relaunch. The line is **byte-for-byte as you left it**, and
   the log says `left untouched` — with the line to paste, if the value mentions a mast
   script. This is the rule the whole step rests on; a wrongly-rewritten user config is a
   failure of this checklist even if everything else passes.

3. **A turn records the hint.** Run `codex` in a mast tab, let one turn complete, and check
   `~/.mast/resume/tab-<id>` (the tab id is `mast id`): line 1 reads `codex resume
   <uuid>`, line 2 is the epoch. The uuid should match what Codex itself prints as its resume
   hint when you exit it.

4. **The idle notification previews Codex's last message.** As the turn completes, the pane
   badge/sidebar preview shows the **first line of Codex's closing message**, not a fixed
   string — that is the visible difference from v6, which always read `codex turn complete`.
   A turn that ends with no message still notifies, with `codex turn complete` as the body.

5. **Restart offers it back.** Quit and relaunch mast. The respawned tab prints one dimmed
   line, `[mast] resume previous agent: codex resume <uuid>`, and a single ↑ puts that
   command on the command line. Press Enter and confirm Codex actually reopens that thread —
   the point of the hint is that the command works, not that it is printed.

6. **Alternating agents: the last one wins.** In the same tab, run Claude Code through one
   prompt, then Codex through one turn, then restart: the hint is the **Codex** one. Reverse
   the order (Codex, then Claude Code) and restart: the hint is the **Claude** one. One tab
   has one hint, and it names whichever agent spoke last.

7. **A tab with no Codex and no Claude still looks untouched.** A tab that never ran an agent
   prints no hint line at all, and ↑ recalls that tab's own history as before.

Note, as with v0.3.3: recording starts with the **first turn after this build's provisioning**
(v7). A Codex thread that ran before the update left no record, so the first restart after
updating shows no Codex hint yet — run one turn through Codex first, then restart.

### v0.3.6 — verification

The v0.3.6 batch. Items are independent — run them in any order on a build of this batch.

1. **Close the active workspace — `Ctrl+Shift+Q`** (the interception row lives in the
   [`apps/mast/src/shared/keys.ts`](../apps/mast/src/shared/keys.ts) module doc; the key runs the
   sidebar `×` button's implementation, so the two can never disagree).
   - **Confirm appears while sessions are running** — in a workspace with at least one live
     terminal (a shell prompt counts), press `Ctrl+Shift+Q`: the same dialog the `×` button
     shows appears, naming the workspace — `Close workspace "<name>"? All terminal sessions
     in it will be killed.`
   - **Cancel changes nothing** — dismiss the dialog and confirm the workspace is still
     there, still active, with its panes, tabs and scrollback intact, and the shells still
     alive (`echo $$` gives the same pid as before).
   - **Accept closes it** — confirm the dialog and the workspace card disappears, the view
     switches to whatever workspace the core makes active, and keyboard focus lands in a
     terminal there (typing goes into the shell, not nowhere).
   - **A workspace with no running sessions closes immediately** — in a workspace whose
     terminals have all exited (`exit` in each) or that only has viewer tabs, press
     `Ctrl+Shift+Q`: it closes with **no dialog** (there is nothing to kill, so the warning
     would be a lie).
   - **The last workspace behaves exactly as the `×` button does** — close the only
     remaining workspace with the key and confirm you get the same result as clicking `×`
     on it (no special-casing was added for the keyboard path).
   - **Nothing leaks into the terminal** — at a shell prompt with an empty command line,
     press `Ctrl+Shift+Q` and cancel: the command line stays **empty**. Note the shell's own
     `Ctrl+Q` (XON) is untouched — only the `Shift` variant is intercepted.
   - **The `×` tooltip advertises the key** — hover the `×` on a workspace card: the tooltip
     reads `Close workspace (Ctrl+Shift+Q)`.
   - **WebView2 delivers it** — this combo was not in the set
     [ADR-0007](adr/0007-keyboard-model.md) cleared on 2026-08-10, and `Ctrl+Shift+Q` is a
     browser quit accelerator on some platforms. The first bullet already proves delivery
     (no dialog = the WebView ate the key); if it ever regresses, the fix is
     `AreBrowserAcceleratorKeysEnabled(false)`, not a different binding.

2. **Syntax highlighting in the text viewer** — highlighting is an overlay on the existing
   plain renderer, and every item below is about it staying an overlay. Use a folder tab to
   open the files (the highlighter is chosen by extension, not by content).

   - **Plain first, colour after** — open a real `.py` or `.rs` source file of a few hundred
     lines. The text must appear **immediately**, uncoloured, and the colours arrive a moment
     later on their own; scrolling and typing elsewhere stay responsive the whole time. A
     visible wait before the text appears is a failure, not a slow machine.
   - **The colours match the app** — token colours are VS Code's dark palette on the viewer's
     own background: the background does **not** change to a lighter block, the line grid does
     not shift, and the horizontal scroll of long lines still works.
   - **Unsupported extensions stay plain** — open a `.txt`, a `.log` and a file with no
     extension at all: they render exactly as before, in one colour, with no delay.
   - **`settings.json` picks the languages** — with the app closed, write
     `%AppData%\app.mast.desktop\settings.json` as `{"highlightLanguages": ["python"]}` and
     relaunch: a `.py` file is coloured and a `.rs` file is now plain. Change it to `[]` and
     relaunch → nothing is coloured anywhere. Remove the key (or the file) and relaunch → the
     default set is back and both files are coloured again.
   - **A bad language name reports itself** — `{"highlightLanguages": ["pyton"]}` and relaunch:
     the status line shows an `unsupported language "pyton"` error listing the supported names,
     and **the app still boots** with default fonts and default highlighting (same loud-fail
     rule as `fontSize`).
   - **Large files stay responsive** — open a source file bigger than ~256 KiB (or use the
     window buttons to page into one): the window renders immediately and stays plain — that
     is the intended cap, not a bug. Paging with the window buttons and `Ctrl+PageUp/PageDown`
     is as fast as before, and moving quickly between windows never leaves colours from the
     previous window behind.

3. **Shell app identity so toasts actually appear** — v0.3.5 showed no toast at all because an
   unpackaged exe has no AppUserModelID registered with the shell, and WinRT drops toasts from
   unregistered senders *silently*. The app now registers itself at start-up
   ([`app_identity.rs`](../apps/mast/src-tauri/src/app_identity.rs) module doc carries the
   AUMID-match argument). These items are the field proof that could not be run on the Linux
   dev box.

   **Which exe to test with matters.** The plugin only puts our AUMID on the toast when the
   exe's folder does *not* end in `\target\debug` or `\target\release`, and this module mirrors
   that exception exactly. So an x64 `npm run tauri build -- --no-bundle` run **in place** from
   `target\release\` exercises neither path — it keeps the old PowerShell-sender fallback and
   proves nothing. Test with either of the two real field shapes: the exe **copied to a normal
   folder**, or the ARM64 cross-build artifact, whose folder is
   `target\aarch64-pc-windows-msvc\release\` and therefore does *not* match the exception even
   when run in place. That second shape is the one the original bug report came from. The
   start-up log tells you which branch you are on: a skipped dev build prints `start menu
   shortcut not needed (dev build — ...)`, never `up to date`.

   - **First run creates the Start-menu entry** — copy `mast-app.exe` to a normal folder
     (e.g. `%LocalAppData%\mast\mast-app.exe`) and launch it once.
     `%AppData%\Microsoft\Windows\Start Menu\Programs\mast.lnk` must now exist, and typing
     `mast` in the Start menu must find it. Right-click → Properties: **Target** is the exe
     you just launched.
   - **mast appears in the notification list** — open Windows Settings › System ›
     Notifications: there must now be a **mast** entry (this is the thing whose absence was
     the confirmed root cause). It may take a moment or a relaunch for the shell to index the
     new shortcut — see the last item.
   - **An unfocused needs-input toast really shows, from mast** — start an agent turn that
     ends in a prompt, click away so the window is unfocused, and let it reach needs-input: a
     toast appears and the sender name on the card reads **mast**, not Windows PowerShell.
     Then check Action Center — the toast is listed under mast there too.
   - **Second launch is a no-op** — relaunch without moving anything. The console line reads
     `start menu shortcut up to date`, and the `.lnk` file's modified timestamp is
     **unchanged** (the shortcut must not be rewritten every boot).
   - **Moving the exe refreshes the target** — quit, move the exe to a different folder, launch
     it from there. The same `mast.lnk` must now point at the **new** path (Properties →
     Target), not a second shortcut, and toasts must still show as mast. This is the version
     swap case: the shortcut is refreshed, not created once and left stale.
   - **A failure is loud, not fatal** — no way to force this by hand, but if the registration
     ever fails the app must still boot normally and print a single
     `[mast] app-identity: FAILED ...` line. Note that release builds are
     `windows_subsystem = "windows"` and have no console, so this line is only visible in a
     debug build or when the exe is started from a terminal that supplies one.
   - **Observation only — the first run may need a relaunch, and clicking does nothing.** Two
     accepted unknowns: (a) the shell may not index a brand-new shortcut before the first toast
     is raised, so if the very first toast is missing but the second launch works, that is the
     known indexing lag, not a regression — record which one it was; (b) clicking the toast has
     no activation handler wired, so nothing happening on click is acceptable for now. If it
     *does* focus the window, note that too.

### v0.3.7 — verification

The v0.3.7 batch. Items are independent — run them in any order on a build of this batch.
Every `settings.json` edit needs the app closed and relaunched (there is no settings UI).

1. **`settings.json` fonts reach the viewers, not just the terminal** — `fontFamily`/`fontSize`
   used to be consumed by xterm alone, so a user who picked a bigger font saw the terminal grow
   while the text viewer, the folder listing and markdown code stayed on their hard-coded
   `monospace` 12px (field report). The boot path now also plants the pair as `:root` custom
   properties those surfaces read; the scope argument and the deliberate exclusions live in the
   [`apps/mast/src/features/viewers/viewer-font.ts`](../apps/mast/src/features/viewers/viewer-font.ts) module doc.

   - **All three viewer surfaces follow the setting** — write
     `%AppData%\app.mast.desktop\settings.json` as
     `{"fontFamily": "Cascadia Code, monospace", "fontSize": 20}` and relaunch. In one
     workspace open a folder tab (the listing), open a `.txt` or `.log` from it (the text
     viewer), and open a `.md` (the markdown viewer). The folder rows, the text viewer's lines
     and the markdown **code** spans and fenced blocks must all be Cascadia Code at 20px — the
     same face and size as the terminal in a neighbouring pane.
   - **The text viewer's row grid follows the size** — this is the item that can actually
     break, because the virtual scroller computes the grid in TypeScript while the glyphs are
     sized by CSS. In that 20px text viewer: lines must not be clipped or overlapping, each
     sitting in its own row with the same relative spacing as at the default size. Scroll into
     the middle of a long file and confirm the topmost visible line is a whole line, not one cut
     in half, and that `PageUp`/`PageDown` still stop on a line boundary. Close the tab and
     reopen the same file — it must come back at the same place. On a `.py` or `.rs` file the
     syntax colours must land on the same rows as the text (a grid mismatch shows up here first).
   - **Markdown prose is deliberately unchanged** *(partly superseded in v0.3.8: the prose now
     follows the **size** so that zoom moves the whole document — its face is still untouched.
     On a current build expect the body text to scale with `fontSize` and with zoom; run §10
     v0.3.8 item 1 instead.)* — in the markdown viewer the body text (paragraphs, headings,
     lists) keeps its previous look at any `fontSize`; only `code` takes the setting. The keys
     name the *code* font, not the document font.
   - **The chrome is not in scope** — the workspace sidebar, the pane tab bar, the tab/window
     buttons, the viewer banners and the top status line must look exactly as before at any
     `fontSize`. If the sidebar grew, the scope leaked.
   - **Unset must be indistinguishable from the old build** — quit, delete `settings.json` (or
     remove both font keys) and relaunch. The viewers must be back to the old rendering exactly:
     `monospace` at 12px, the folder size column one notch smaller than the name, and the text
     viewer on its original row grid. The CSS fallbacks exist for precisely this case, so a
     viewer that looks even slightly different from a pre-v0.3.7 build is a failure.
   - **Terminal zoom still does not touch the viewers** *(Historical — v0.3.8 extended zoom to
     the viewers on user request, so on any current build this item is expected to fail: the
     viewers move with the terminal. Zoom is still session-only. Run §10 v0.3.8 items 1-5
     instead.)* — with a size set (say 20) and a text viewer open beside a terminal, press
     `Ctrl+=`/`Ctrl+-` several times in the terminal, then `Ctrl+0`. The terminal font changes
     each time; the text viewer, the folder listing and markdown code must not move a pixel and
     their row grid must not shift. Zoom stays a terminal-only, session-only control (backlog
     2026-08-12) — the viewers are pinned to the file's value.
   - **The loud-fail rules are unchanged** — `{"fontSize": 200}` still reports the 6-72 range in
     the status line and boots with default fonts *everywhere*, viewers included; a blank
     `fontFamily` still reports itself. The viewers consume the same validated values the
     terminal does, so there is no second validation path to disagree.

2. **needs-input notification — toast only, and it now fires for workspaces you cannot see.**
   In v0.3.6 the chime rang but no toast ever appeared, and the two suspects could not be told
   apart from inside the app: WebView2's `document.hasFocus()` can stay `true` while the window
   is unfocused (so the front-end may have suppressed every toast), and
   `tauri-plugin-notification` throws the send into
   `tauri::async_runtime::spawn(async move { let _ = notification.show(); })` (2.3.3
   `desktop.rs:216`), swallowing any error. **Both layers are gone.** Focus is now decided by the
   OS window event the glue forwards (`main.rs` `window-focus` → `app/main.ts`), and the toast is
   raised directly through `tauri-winrt-notification` under the AUMID we register
   ([`app_identity.rs`](../apps/mast/src-tauri/src/app_identity.rs)), with the result written to
   a log file. The chime was removed with it (user decision 2026-08-13) — the sound could never
   say *which* project was waiting, which is the whole content of the notification.

   Drive it with two workspaces open, side by side in the sidebar. In a terminal of the
   workspace you are *not* looking at, run

   ```bash
   sleep 5; ~/.mast/bin/mast-notify.sh mast:needsInput "toast test"
   ```

   and use those five seconds to put the window into the state each case names. A real agent
   (Claude Code hitting a permission prompt) exercises the same path; the helper just makes the
   timing yours.

   - **Unfocused → toast** — click another window (an editor, Explorer) before the five seconds
     are up. A Windows toast appears bottom-right, titled `mast — <workspace name> · <tab title>`,
     with the first line of that tab's last message as the body (`toast test` here); with no
     message recorded it reads `agent needs your input`. The workspace name is the point — it is
     how you know which project is waiting — and since v0.3.32 the tab title says which agent in
     it. (Up to v0.3.31 the title was `mast — <workspace name>`.)
   - **Focused, but a workspace you are not viewing → toast** — this is the case v0.3.6 got
     wrong. Keep mast focused (click into a terminal of the *other* workspace) and let the
     five seconds run out: **the toast still appears**, because that workspace is not on screen.
     Previously any focus at all suppressed it, so a second project going quiet was invisible.
   - **Focused, and it is the workspace on screen → nothing** — run the same command in the
     workspace you are actually looking at, with mast focused. **No toast.** The sidebar card
     highlights and that is all — a toast on top of the window you are already reading is noise.
     Switching workspaces after the fact does not retro-fire it; only the rising transition
     notifies, so staying in `needs input` (later redraws, tab activity) produces nothing. Since
     v0.3.32 the transition is judged per tab: a second tab that starts waiting in a workspace
     already at `needs input` gets a toast of its own.
   - **No mast chime, ever** — the app's own two-tone chime is gone, including in the focused
     case that used to be sound-only: if you hear it, this build is not the one you think it is.
     (The synthesiser is kept dormant in [`features/notifications/chime.ts`](../apps/mast/src/features/notifications/chime.ts), unwired.)
     What you *may* still hear is **Windows' own notification sound** when a toast appears — we
     do not set an `<audio>` element, so the OS plays its default. That is Windows, not mast,
     and it is silenced in Windows' notification settings, not here.
   - **The auto-reset case — a toast must still arrive after the webview reloads.** This is the
     one that unit tests cannot reach and the one v0.3.7's design turns on. Launch with
     `MAST_RESET_HIDDEN_SECS=20` (§9), leave the window unfocused (or minimized) for half a
     minute so the reset fires — the console prints `reset: reloading webview` — and then, still
     without touching mast, trigger needs-input in the **active** workspace. The toast must
     appear. It relies on the front-end asking Windows for the current focus after each reload
     (`app/main.ts` `installWindowFocus`): the focus *event* only fires on a change, and that change
     happened long before the reload, so without the query the reloaded page would assume it is
     focused and swallow exactly the notification you are away from the machine to receive.
   - **When a toast does not show, read the log** — every attempt appends one line to
     `%AppData%\app.mast.desktop\toast.log` (same folder as `settings.json`), local time first:

     ```text
     2026-08-13 21:04:11 ok label="mast #7"
     2026-08-13 21:07:02 err label="mast #7": cannot show the toast: <reason>
     ```

     The label is `<workspace name> #<tab id>` (up to v0.3.31 the line carried
     `title="mast — <workspace name>"`). That splits the failure three ways without a dev
     console: **no line** means the front-end never called (focus/onset judgment — check which
     case you were in), `ok` means Windows accepted it and the toast was suppressed downstream
     (notifications turned off for the app, Focus Assist, or the shell not having indexed the
     Start-menu shortcut yet), and `err` names the WinRT refusal. The message body is
     deliberately not logged, and neither is the toast title: it now carries the tab title, which
     an agent or prompt sets through OSC 0/2 to task text and paths. The file is capped at 64 KiB
     and starts over past that, so it cannot grow without bound.
   - **Failure still may not break anything else** — with notifications turned off for the app,
     the UI must keep working normally; the only traces are the `err`/`ok` line above and a
     `console.debug` (`needsInput toast failed`) in the dev console.
   - **Dev builds now register too** *(field note)* — the Start-menu shortcut used to be skipped
     when the exe sat in `target\debug`/`target\release`, because the plugin fell back to the
     PowerShell sender there. We always send under our own AUMID now, so that exception would
     silently kill dev-build toasts and was removed. Expect `npm run tauri dev` to create/refresh
     `mast.lnk`, and expect alternating between a dev build and a release exe to rewrite its
     target each time (the log line `app-identity: ... shortcut updated` says so). The accepted
     cost: after a dev run, the Start-menu entry points at `target\debug\mast-app.exe`, and
     wiping `target/` leaves it dangling until the next launch of whichever exe you keep. Deleting
     the shortcut by hand is safe — the next launch recreates it.

### v0.3.8 — verification

Zoom (`Ctrl+=` / `Ctrl+-` / `Ctrl+0`) now moves the **viewers** as well as the terminal, on one
key and one step. Until v0.3.7 it was terminal-only because re-sizing a live text viewer means
re-laying its row grid, not just its glyphs — so that grid is what most of this section is
about. Zoom stays session-only: nothing is written back to `settings.json`.

1. **All three viewer surfaces zoom** — open one workspace with a folder tab, a `.txt`/`.log`
   text viewer and a `.md` markdown viewer (split panes so you can see two at once, and keep a
   terminal visible in a third). Press `Ctrl+=` five times, then `Ctrl+-` five times. The folder
   rows, the text viewer's lines, the markdown body **and** its `code` spans must grow and shrink
   on every press. The markdown body must keep the document face — only its *size* follows zoom,
   never the code font.

2. **The text viewer keeps its place and its grid** — this is the item that can actually break.
   Open a file long enough to scroll (a few thousand lines), scroll to somewhere in the middle,
   and note the top visible line's text. Now zoom in three steps and out three steps.

   - The line that was at the top stays at the top at every step (not pixel-identical, but the
     *same line*, sitting flush against the top edge — never cut in half).
   - No line is clipped, overlapping or oddly spaced at any step: every glyph sits inside its own
     row exactly as at the default size.
   - The scrollbar thumb resizes as the content height changes; the view never jumps to the top
     or the bottom.
   - `PageUp`/`PageDown` still stop on a line boundary *after* zooming, and `Ctrl+PageUp`/
     `Ctrl+PageDown`/`Ctrl+Home`/`Ctrl+End` still move windows normally.
   - On a `.py` or `.rs` file the syntax colours stay on the same rows as the text at every zoom
     step (a grid mismatch shows up here first).
   - Switch to another tab and back, then close the tab and reopen the same file: it must come
     back at the same place *and* at the current zoom size, not the `settings.json` size.
   - **At the end of the file**, press `End` and then zoom *out* three steps: the view must stay
     pinned to the bottom. Here the top line is allowed to move (the document got shorter than
     the viewport could hold at that offset, so the browser clamps) and the topmost row may be
     cut — that is the one place the row grid does not hold, and it is accepted. Zooming back in
     will *not* return you to the line you started on; that is expected too.

   These two run in a real browser only: the unit tests cannot reach scroll clamping or the
   scroll events an assignment fires, so this item is the whole net for both.

3. **The markdown viewer keeps your place** — open a `.md` long enough to scroll (this repo's
   `WINDOWS-BUILD.md` will do), scroll to a paragraph in the middle and note it. Zoom in five
   steps, then out five steps. That paragraph must stay on screen at every step — the prose
   reflows, so it will drift by a line or two, but it must not scroll away. Then scroll to the
   very bottom and zoom out: the view stays at the bottom. Finally close the tab, reopen the
   file and press `Ctrl+0`: it must come back where you left it, at the `settings.json` size —
   zoom must not have written a zoomed position into the saved one.

4. **Zoom is responsive on a big file** — open the largest log you have (tens of MB is fine; the
   viewer only holds one 512 KiB window) and hold `Ctrl+=` down so the key repeats. The window
   must keep up without visible stalling or flicker and must not walk off its scroll position.
   Then hold `Ctrl+-` back down to the minimum. At the 6px floor and the 72px ceiling further
   presses must do *nothing* — no flicker, no scroll jump.

5. **Terminal and viewers move together** — with a terminal and a text viewer side by side, press
   `Ctrl+=` a few times: both grow on the same presses. They are not the same number (the terminal
   starts at 13px, the viewers at 12px when nothing is configured), so do not expect identical
   glyph sizes — expect them to move on every press. Each surface stops at its own 6/72 boundary,
   so at the extremes one can stop while the other still moves; that is expected. The terminal
   must reflow (its `cols`/`rows` change, and a running TUI redraws to the new size).

6. **`Ctrl+0` resets both to the file's values** — set
   `%AppData%\app.mast.desktop\settings.json` to `{"fontFamily": "Cascadia Code, monospace",
   "fontSize": 20}` and relaunch. Zoom up and down a few steps in any pane, then press `Ctrl+0`:
   the terminal *and* all three viewer surfaces must land back on 20px Cascadia Code. Now delete
   the font keys (or the file), relaunch, zoom, and press `Ctrl+0` again: the viewers must return
   to exactly the pre-v0.3.7 look — `monospace` 12px, markdown body 13px, folder size column one
   notch smaller than the name.

7. **Relaunch discards zoom** — zoom several steps up, then close the app and relaunch. Every
   surface must come back at the `settings.json` size (or the defaults if unset). Nothing about
   the zoom may survive, and `settings.json` must be byte-identical to what you wrote — open it
   and confirm the app did not rewrite it.

8. **The chrome still does not scale** — at any zoom level the workspace sidebar, the pane tab
   bar, the tab/window buttons, the viewer banners, the text viewer's window-navigation bar and
   the top status line must look exactly as they did at the default. This is a content zoom, not
   a UI scale; if the sidebar grew, the scope leaked.

### v0.3.9 — verification

1. **Image paste reaches the agent** — `Ctrl+V` is no longer swallowed when the clipboard holds
   an image. The terminal never carries the image itself: the app inside it reads the OS
   clipboard on its own (Claude Code falls back xclip → wl-paste → `powershell.exe`'s
   `Clipboard::GetImage`, so it reaches the Windows clipboard from WSL), and all mast has to
   do is let the keypress through.

   - Take a screenshot (`Win+Shift+S`), focus a Claude Code prompt in a mast tab, press
     `Ctrl+V`: the image must attach (`[Image #1]` or that version's equivalent). Repeat with
     `Shift+Insert` — same path.
   - **Text paste is unchanged**: copy a line of text, press `Ctrl+V` at a plain shell prompt.
     The text arrives exactly once — twice would mean the native paste path fired as well — and
     a multi-line copy still arrives bracketed where the app supports it.
   - **An empty clipboard still does nothing**: with nothing copied, `Ctrl+V` at a bash prompt
     must leave the line untouched. If bash swallows your *next* keystroke instead, `\x16` leaked
     through as quoted-insert and the image check regressed.
   - With an image on the clipboard at a plain bash prompt that quoted-insert *is* what happens —
     bash has no use for the key. That is the accepted cost of forwarding it.

2. **A shell that never starts is called out, and is not killed** — the app now emits a
   startup marker (`OSC 777;mast-started`) as the very first thing the WSL wrapper does, and
   flags the tab if no marker arrives within 20s. The session is left running, so a slow start
   costs a warning and nothing else.

   Both knobs are read once per process, so set them in the shell that launches the exe:

   ```powershell
   $env:MAST_STARTUP_DEADLINE_MS = "1000"; .\target\release\mast-app.exe
   ```

   - **It fires on a genuinely slow start.** With the knob at `1000`, run `wsl --shutdown`,
     then open a new tab. The cold VM boot outlasts 1s, so the tab must show the `not started`
     badge and the pane banner naming WSL as the likely cause.
   - **It clears itself.** Keep watching that same tab: when the shell finally comes up the
     badge and banner must disappear on their own, and the prompt must work. This is the whole
     point of not killing the session — if the tab stays flagged after a working prompt
     appears, the recovery path regressed.
   - **No false positive at the default.** Unset the knob, `wsl --shutdown`, open a tab: the
     prompt must arrive with no badge at any point. Then restart the app with several running
     tabs *after* a `wsl --shutdown` — a cold VM plus N shells racing to initialise is the
     worst case for a false flag, and none may appear.
   - **Retry works and cleans up.** Force the flag again (knob at `1000`), press **Retry** in
     the banner: the same tab gets a working shell, and `↑` still recalls that tab's history
     (the tab id survived). Then check Task Manager and `ps` inside WSL — the session the tab
     had been holding must be gone. *If a `/init` relay with no children survives, note it: the
     field incident left two of those alive for hours, and whether killing `wsl.exe` reaches
     into WSL is exactly what this item measures.*

3. **A spawn cannot hold the whole app hostage** — spawning runs under the dispatcher lock, so
   it now carries a 5s deadline.

   ```powershell
   $env:MAST_SPAWN_DEADLINE_MS = "1"; .\target\release\mast-app.exe
   ```

   - Opening a tab must fail visibly (a `SpawnFailed` error surface) rather than hang, and
     **the rest of the app must stay responsive** — switch workspaces, close a tab, type in
     another terminal while the failures repeat.
   - Repeat a handful of times, then check Task Manager: no `wsl.exe` may be left over. Late
     spawns are cleaned up by the worker thread, and this is the only place that path is
     exercised on real hardware.
   - Unset the knob and confirm tabs open normally again.

   A genuinely blocked `CreateProcess` cannot be produced on demand, so this item covers the
   error surface and the cleanup path only; the timeout mechanism itself is covered by the
   `deadline.rs` unit tests, including a 40-step sweep across the completion/deadline boundary
   that asserts the value is never lost.

4. **A dead terminal tab can be brought back** ([ADR-0010](adr/0010-restart-dead-terminal-tabs.md)) —
   a shell that dies while the app is running no longer leaves a permanently dead tab. The pane
   banner's **Restart** does it on demand, keeping the tab id, so the tab's shell history and its
   agent resume hint come back with it.

   > **Superseded in part by [ADR-0018](adr/0018-exited-tab-as-terminal-record.md) (v0.3.25).**
   > A relaunch no longer revives an exited tab: it comes back exited, showing its record, with
   > the Restart banner. The bullets below are amended accordingly; the item's remaining halves
   > — Restart within one run, the history and resume hint, untouched live tabs — are unchanged.
   > The record behaviour itself is verified by §10 v0.3.25.

   - **Restart-revives (the field failure).** With a few tabs open — at least one running an
     agent that has finished a turn, so a resume hint exists — run `wsl --shutdown` from
     PowerShell. Every tab must go to the `exited` badge with the Restart banner. Now close
     mast and reopen it: every tab must come back **exited with its record and a Restart
     button** — and no `(terminal tab without pty session)` anywhere. Pressing Restart in a tab
     must give it a live shell in its own directory.
   - **The history and the resume hint survived.** In a revived agent tab, press `↑` once: the
     `claude --resume <id>` (or `codex resume <id>`) line must be there, and running it must
     reattach to that conversation. Press `↑` again for the tab's earlier commands.
   - **Restart without closing the app.** Type `exit` in a tab. The badge and banner appear
     with the last output still readable behind the banner; press **Restart**: the same tab
     gets a working shell, and `↑` still recalls that tab's history. Then confirm in Task
     Manager and `ps` inside WSL that the session the tab had been holding is gone.
   - **A running tab is never disturbed.** With one tab exited and others working, neither the
     restart nor a Restart press may touch the live tabs (no reset scrollback, no new prompt).
   - **A spawn failure is still recoverable.** With `$env:MAST_SPAWN_DEADLINE_MS = "1"`, open
     a tab and let it fail — it lands as `exited` with the Restart banner. Press **Restart**
     *in that same run*: it must fail again (the knob is still 1ms) and leave the badge and
     banner in place rather than a dead pane — i.e. the retry path stays available after a
     failed retry. Then quit, relaunch **without** the knob: since v0.3.25 the tab comes back
     exited, and its **Restart** must now succeed with a live shell. Before v0.3.9 that tab was
     dead for good on both counts.

### v0.3.10 — verification

1. **A revived spawn wave no longer outruns WSL** ([ADR-0010](adr/0010-restart-dead-terminal-tabs.md)
   amendment) — boot warms each distro once and paces the respawns, and a tab that still fails to
   start is retried automatically by the next restart rather than waiting for a click.

   ```powershell
   $env:MAST_RESPAWN_STAGGER_MS = "0"; .\target\release\mast-app.exe   # reproduce
   ```

   `0` turns off **both** halves — the warm-up and the spacing — which is what makes it an
   actual reproduction rather than a burst against an already-warm VM.

   - **Reproduce first, on a cold VM.** With eight or more tabs open, `wsl --shutdown`, quit, then
     launch with the knob at `0`. Some tabs should land on the `not started` badge — that is the
     v0.3.9 failure. Note how many.
   - **Then the default.** `wsl --shutdown` again, quit, relaunch with the knob unset: the tabs
     must come up, and the window itself must appear immediately (the warm-up runs behind it, so a
     cold VM shows tabs filling in one by one rather than a frozen window).
   - **A failed tab heals on restart.** If any tab still lands on `not started`, quit and relaunch:
     it must be retried automatically with no click. Confirm with `ps -ef | grep 'bash -l'` inside
     WSL that the live shell count matches the tab count — the badge alone is not proof.
   - **No leftovers.** After the round, `Get-Process wsl` on Windows and `ps -ef | grep /init`
     inside WSL: each live tab should own one `SessionLeader → Relay → bash` triple, with no
     childless relays and no `wsl.exe` beyond the live tabs.

2. **A tab reopens where its shell was** ([ADR-0011](adr/0011-tab-cwd-tracking.md)) — the
   wrapper now emits `OSC 7` from `PROMPT_COMMAND`, so the tab's stored `cwd` follows the shell.

   - **The basic round trip.** In a tab, `cd` somewhere a few levels deep, quit the app, relaunch:
     that tab must come back in that directory, not the workspace root. Do it for two tabs in
     different directories in the same workspace — both must land correctly, which is what proves
     the value is per tab rather than per workspace.
   - **The prompt is the trigger, and that is fine.** `cd /tmp`, let the prompt draw, then
     `sleep 30` and quit *during* the sleep: the tab comes back in `/tmp` (the prompt after the
     `cd` reported it; the sleep changes nothing). Note `cd /tmp && sleep 30` on one line would
     *not* do — the prompt only draws after the whole list. A directory change made by a
     still-running program is not tracked — that is the documented limit, not a bug.
   - **Odd paths survive.** `mkdir -p "/tmp/wm test/100%dir" && cd "/tmp/wm test/100%dir"`, restart:
     the tab must reopen in exactly that directory, spaces, `%` and all.
   - **A deleted directory degrades loudly, not fatally.** `mkdir /tmp/gone && cd /tmp/gone`,
     quit, `rmdir /tmp/gone` from another tab, relaunch: the tab must come up **in `$HOME`** with
     one dim `[mast] ... is gone` line — not a blank pane, not a `not started` badge.
   - **Titles are untouched.** With an agent running in a tab, `cd` around: the tab title must stay
     the agent's, never the directory name. If the title starts tracking directories, the OSC 0
     half of the snippet leaked in and the sidebar's purpose is gone.
   - **starship still owns the prompt.** The prompt must render exactly as before — same segments,
     same git status, and `$?`-dependent segments still correct after a failing command.

3. **Links reach the browser** ([ADR-0012](adr/0012-opening-links.md)) — clicking a URL in a tab
   opens it in the Windows default browser, and a program inside WSL that opens a browser itself
   (an OAuth login) now finds an opener.

   - **Click.** `echo https://example.com` in a tab, then click the URL (Ctrl is not required —
     xterm underlines it on hover). It must open in the **already-running** Chrome as a new tab,
     not a second browser instance. Repeat with a URL carrying query parameters
     (`https://example.com/?a=1&b=2`) and confirm the address bar shows both parameters — that is
     the case a command-line-based opener would mangle.
   - **Not inside a TUI.** Open an agent TUI (or `vim`) in a tab, put a URL on screen, click it:
     nothing must happen, and the click must reach the app as a click.
   - **Nothing but http(s).** `printf 'file:///etc/passwd\n'` and `printf 'ms-settings:privacy\n'`
     in a tab, then click: nothing may open. If Windows Settings appears, the scheme allowlist
     regressed.
   - **OAuth.** In a fresh tab run a login that opens a browser (`claude` logging in, or
     `gh auth login --web`). The browser must open on its own. If it prints "copy this URL
     manually", check `command -v xdg-open` inside that tab — it must resolve to
     `~/.mast/bin/xdg-open`. (This needs provisioning v8, which runs once on first launch of
     this build; `~/.mast/setup.log` records it.)
   - **The opener refuses what it should.** In a tab: `mast-open ms-settings:privacy` must exit
     non-zero with a refusal, and `mast-open ~/code` must open Explorer at that folder.

### v0.3.11 — verification

Both items need provisioning **v9**, which runs once on first launch of this build;
`~/.mast/setup.log` records it. Check that first — neither item can pass without it.

1. **`mast send` submits to an agent, not just a shell** — the CLI now ends the text with
   **CR** instead of LF, which is the byte a terminal sends for Enter.

   - **The case that was broken.** Open Codex (or Claude Code) in one tab and a shell in
     another. From the shell: `mast send '#<agent tab id>' 'say hello'`. The agent must
     **start working**, not sit with the text in its prompt. This is the whole point of the
     change — before v0.3.11 the text arrived and nothing ran.
   - **The shell case did not regress.** `mast send '#<shell tab id>' 'echo delivered'` must
     still run the line. A shell's `ICRNL` turns the CR back into a newline; if this one breaks,
     the terminal was opened in raw mode by something.
   - **`-l` still only pre-fills.** `mast send -l '#<agent tab id>' 'say hello'` must leave the
     text in the prompt unsubmitted, in the agent and in a shell alike.

2. **A closed tab takes its shell-side files with it** — closing a tab (not a shell *exiting*)
   deletes that tab's `HISTFILE` and resume hint inside WSL.

   - **The delete.** In a tab, note its id (`mast id`), run a command or two so its history
     file exists, and confirm from another tab:
     `ls ~/.mast/history/tab-<id> ~/.mast/resume/tab-<id>`. Close the tab, wait a second,
     and list again — both must be gone.
   - **One round trip, not N.** Open a workspace with several terminal tabs and close the whole
     **workspace**. All of their files must disappear, and `Get-Process wsl` during the close
     must not show a burst of `wsl.exe` processes — the cleanup is one call for all of them.
   - **An exited tab keeps its history.** In a tab, run a few commands, then type `exit`. The tab
     goes to the `exited` badge — its files must **still be there**, because Restart revives that
     tab under the same id and `↑` has to reach those commands. Restart it and confirm `↑` does.
   - **Quitting the app deletes nothing.** Close the app with tabs open, relaunch: every tab's
     history must survive, since quitting is not closing.

3. **Terminal panes have a visible scrollbar** — the app now draws its own instead of taking
   whatever WebView2's overlay mode gives it. Provisioning is irrelevant here; this one is pure
   front end.

   - **The bar is there before you touch it.** In a terminal tab, `seq 1 500`. A scrollbar must
     be visible on the right **without scrolling first**, its thumb sized to the scrollback, and
     dragging it must move the view.
   - **Confirm the cause while you are there.** Windows Settings › Accessibility › Visual
     effects › *Always show scrollbars*. Note whether it is on or off — the fix matters only
     when it is **off**, and knowing which state the field machine was in is what makes this
     result mean anything.
   - **It did not eat the terminal.** The bar takes ~10px, so `tput cols` should be one or two
     lower than before at the same window size, and no text may be clipped underneath it. Resize
     the window and confirm the terminal refits cleanly.
   - **Everything else that scrolls got one too.** Open a text viewer on a long file, a folder
     browser on a large directory, and a workspace list long enough to overflow the sidebar:
     each must show the same bar.
   - **An agent that scrolls itself is a different case.** With Claude Code running, check
     whether the pane shows a scrollbar. If it does not while a plain shell does, the agent is
     drawing on the alternate screen buffer, where there is no terminal scrollback to show — not
     a regression, and nothing app-side can change it.

### v0.3.12 — verification

The runtime log ([ADR-0014](adr/0014-opt-in-runtime-log.md)). Everything here is field-only: the
file is written by the Windows build, and the input events it exists to catch only happen in a
real WebView with a real IME.

1. **Off is genuinely off.** Launch with no `log` key in `settings.json` (or `"log": false`). No
   `mast.log` may appear next to `state.json` — not an empty one either. Open tabs, split
   panes, type, switch workspaces, then look again: still nothing.

2. **On takes a restart, and says so in the file.** Add `"log": true`, and **without restarting**
   confirm no file appears. Restart: `mast.log` must exist and its first line must be
   `log: enabled (v0.3.12)`. Wrong version there means the exe and the file are from different
   builds.

3. **The boot is in it.** After that restart the file must show the spawn lines for the restored
   tabs — `spawn: starting`, `spawn: session N up in <ms> ms` — with plausible durations. Compare
   the count against the tabs on screen; a tab with no spawn line is a finding.

4. **The IME case, which is why this exists.** With logging on, type Korean in a terminal tab.
   The file must show `ime: compositionstart`, `compositionupdate`, `compositionend` with
   `len=` counts — and **no Korean text anywhere in the file**. Grep it to be sure. Then, if the
   stuck-composition bug reproduces (previously typed syllable repeating, shortcuts dead): press
   Alt+Left a few times while stuck, click another pane to clear it, quit, and **keep the file** —
   it now carries the answer the code could not give. Look for whether a `compositionend` arrived
   before the `ime: shortcut dropped while composing` lines, and how long they continued.

5. **Terminal content never reaches it.** In a tab, `echo mast-log-canary-12345`, and open a
   file in the text viewer. Neither the canary nor any file content may appear in `mast.log`.

6. **It does not fill the disk or slow the terminal.** With logging on, `yes | head -c 20000000`
   in a tab (a heavy output burst): the terminal must stay responsive, and `mast.log` must not
   grow with that output. Then check that rotation works at all — the file caps at 4 MiB and
   rolls into `mast.log.1`.

7. **Turn it back off.** Set `"log": false`, restart, confirm nothing new is appended. The
   existing file stays — deleting the user's file is not ours to do.

### v0.3.13 — verification

Workspace drag reordering. The core half is covered by unit tests; what needs a real window is
the pointer behaviour and the fact that reordering survives a restart.

1. **The basic drag.** With three or more workspaces, drag the bottom card above the top one. It
   must land there, an accent line must show where it will land *before* you release, and the
   dragged card must dim while moving.

2. **It does not switch workspaces.** Note which workspace is active, then drag a *different*
   card somewhere. The active workspace — and the terminal on screen — must not change. This is
   the decision the feature was shaped around.

3. **A click is still a click.** Click a card normally: it must switch, not reorder. Then click
   with a tiny wobble (a few pixels while the button is down): still a switch. Then drag properly
   and release: reorder, and **no** switch.

4. **`Ctrl+1`–`Ctrl+9` follow.** After reordering, `Ctrl+1` must select whatever is now at the
   top. This is the point of the feature, per the user.

5. **It survives a restart.** Reorder, quit, relaunch: the order must be the one you left.

6. **Dragging while things are happening.** Start an agent so its workspace changes status
   (`running` → `needsInput`), then drag a card *while* those updates are arriving. The drag must
   not stutter or drop — a rebuild mid-drag would kill the pointer capture. Release, and the card
   must immediately show whatever status changed during the drag.

7. **The × button is not a drag handle.** Press the mouse down on a card's ×, move a little, and
   release: nothing may reorder. (Whether the close dialog appears is the existing behaviour, not
   part of this item.)

### v0.3.14 — verification

A new terminal opens where the pane's shell is. The resolution is front-end only and unit-tested
(`shared/keys.test.ts`, `features/workspace/pane-view.test.ts`); what needs a real window is that the OSC 7 value the pane
holds is the one the new shell actually lands in.

1. **Split follows the shell.** In a tab, `cd` a few levels below the workspace root, wait for
   the prompt, then split with the header icon and again with `Ctrl+Shift+E` / `Ctrl+Shift+D`.
   Every new pane must open in that directory, not the workspace root. `Ctrl+Shift+T` and the
   header `+` must do the same within the pane.

2. **Per pane, not per workspace.** Two panes in different directories: split each. Each new
   pane must follow *its own* source pane.

3. **A viewer falls back to the root.** With a folder-browser tab shown in a pane, split it: the
   new shell must open at the workspace root (there is no shell to follow). Switch that pane back
   to its terminal tab and split again: it follows the terminal.

4. **Prompt-time, not live.** `cd /tmp`, let the prompt draw, then `sleep 30` and split during
   the sleep: the new pane opens in `/tmp` (the prompt after the `cd` reported it). `cd /tmp &&
   sleep 30` on one line would open in the *previous* directory — no prompt draws until the list
   ends. Then start an agent and let it `cd` somewhere by itself: a split opens where the shell
   last drew a prompt, not where the agent went — the documented ADR-0011 limit.

5. **A gone directory degrades the way a restart does.** `mkdir /tmp/gone && cd /tmp/gone`, then
   `rmdir /tmp/gone` from another tab, draw one more prompt in the first, and split: the new pane
   must come up in `$HOME` with the dim `[mast] ... is gone` line, not blank.

6. **`Ctrl+Shift+N` is unchanged.** From a tab deep in a directory it must still create a
   workspace rooted there.

### v0.3.15 — verification

Terminal modes survive a re-attach. The core half (the CSI branch, the mode map, the preamble)
is unit- and integration-tested; what needs a real window is that a *rebuilt* xterm actually
comes up in the mode the program set, and that a reset still wins.

1. **The reported case.** In a tab where `claude` has been running long enough to have produced
   a lot of output (a full-file read, a long build — well past a megabyte), switch to another
   workspace, switch back, and paste two short lines (under 60 characters, so nothing wraps).
   Both lines must sit in the prompt box unsent. Before the fix the first line was submitted the
   moment it was pasted.

2. **The deterministic A/B.** No agent needed. In a bash tab:

   ```
   printf '\e[?2004h'; yes | head -c 2000000; cat -v
   ```

   Paste anything into the `cat -v`: it must show `^[[200~` before the text and `^[[201~` after.
   Now switch to another workspace and back, and paste again — the markers must still be there.
   Before the fix they were gone after the round-trip, which is the whole defect in five
   seconds. `Ctrl+C` to leave `cat`.

3. **Mouse tracking survives.** Run `htop` and leave it alone for three minutes — every refresh
   is a full-screen redraw, so at a normal window size a megabyte goes by well inside that, and
   `htop`'s `?1000h` from startup is out of the replay window. Switch workspaces and back, then
   click a process row: the selection must follow the click. Before the fix the click did
   nothing (or, in a shell afterwards, typed `[<0;…` junk). The alt screen is **not** part of
   this item — ADR-0015 decision 4 deliberately leaves it out, so if `htop`'s own `?1049h` was
   evicted too, the pane may come back on the normal buffer with the frames in scrollback; that
   is the pre-existing behaviour, not a regression.

4. **Negative control.** A freshly opened tab — no workspace round-trip — must behave exactly as
   before: bracketed paste in `cat -v`, `vim` on the alt screen, no stray `[?...h` text printed
   at the top of the pane. The preamble must never be visible as characters.

5. **A reset stays reset.** In a shell tab turn mouse tracking on by hand — `printf '\e[?1000h'`
   — and click somewhere: the shell line fills with `[<0;…` junk, which proves the mode is on
   (`vim`'s `:q` would turn it off itself, so it cannot serve as the setup here). Run
   `tput reset`, then switch workspaces and back, and click again: **no junk**. Same check with
   `printf '\ec'` (RIS) in place of `tput reset`.

### v0.3.16 — verification

Needs provisioning **v10**, which runs once on first launch of this build; `~/.mast/setup.log`
records it. Check that first.

1. **`mast send` submits a long line to an agent.** v0.3.11 fixed the byte (CR, not LF) but
   sent it in the same write as the text, and both agent TUIs treat a burst of bytes that lands
   in one read as a paste — a CR inside a paste is a newline, so the text arrived intact and the
   Enter was swallowed. The CLI now sends the CR as a second write 200 ms after the text.

   - **The case that was broken.** Open Codex (or Claude Code) in one tab and a shell in
     another. From the shell send a line longer than 64 characters:
     `mast send '#<agent tab id>' 'please summarize this sentence, which is deliberately long enough to cross the paste threshold of both agents'`.
     The agent must **start working**, not sit with the text in its prompt. Repeat with a short
     line (`say hello`) — it must submit too.
   - **The shell case did not regress.** `mast send '#<shell tab id>' 'echo delivered'` runs
     the line; the 200 ms gap is invisible there.
   - **`-l` still only pre-fills**, long or short, agent or shell.
   - **The peer-review round trip.** From a Claude Code tab run a `/peer-review` against a shell
     tab. The runner's `[REVIEW] … 읽고 취합해줘.` reply is well over 64 characters and must land
     as a **submitted** message in the Claude Code tab, not as text waiting in its prompt — that
     is the exact field failure this release fixes.

### v0.3.17 — verification

All of it is field-only: the server, the asset gate and the phone page only meet a real
WebView2 bundle, a real Windows firewall and a real phone here. Replace `<ip>` with the PC's
LAN address and `<port>` with the configured port; the token comes from the pairing dialog.

1. **Off means nothing exists.** With no `"remote"` key in `settings.json`:
   `netstat -ano | findstr <port>` prints nothing, `%AppData%\app.mast.desktop\remote-token`
   does not exist, and `scripts/win/measure.ps1` reads the same as before.

2. **On.** Add `"remote": { "port": 7331 }`, restart. Windows asks whether to allow mast on
   the network — allow **private networks only**. The sidebar footer now shows *Pair phone*;
   click it, scan the QR with the phone, and the phone shows the workspace list. The
   `remote-token` file now exists (43 characters). A port outside 1024–65535, or a `remote`
   object without `port`, must put the reason on the status line and leave the server down.

3. **The static gate — positive and negative.** From PowerShell:
   `curl.exe -si http://<ip>:<port>/` → 200 and the phone page; `/remote/index.html` → 200;
   `/remote/nope.js` → 404; `/index.html` → 404; `/assets/anything.js` → 404. The desktop
   page must never come back from a remote path — that is the fallback ADR-0016 decision 8
   exists to block.

4. **Screen and input.** Open a long-running Claude Code tab on the phone: the screen matches
   the desktop. Paste two short lines into the phone's text box and press Send: both lines
   stay in the agent's input box (bracketed paste), and the Enter that follows submits them.
   Ctrl+C interrupts. Watch the **desktop** shell line of a plain bash tab while the phone is
   open: no stray `R` or `;1R` may appear — the phone's terminal must not answer replayed
   queries.

5. **Authentication.** `curl.exe -si http://<ip>:<port>/api/state` → 401.
   `curl.exe -si "http://<ip>:<port>/api/state?token=<token>"` → 401 (query tokens are
   ignored). Eleven requests with a wrong bearer token → the eleventh is 429, and for the next
   minute even `/remote/index.html` is 429 from that machine. With the right token → 200 JSON.

6. **A restarted tab.** While the phone shows a tab, press *Restart* on that tab's pane banner
   (kill the shell first with `exit`). The phone must reset to the new shell within a poll or
   two, and text sent from the old screen before the reset must be refused (the phone shows
   "The shell restarted — input was not sent").

7. **The desktop is unaffected.** With the phone polling a busy tab: `yes | head -c 50000000`
   in that tab streams at the usual rate, scrolling and workspace switching feel the same, and
   a desktop paste into the same tab still lands whole.

8. **Blocked write (measures ADR-0016's accepted limit).** In a tab run `sleep 600` (a program
   that never reads stdin), send 60 KB of text from the phone, then close that tab from the
   desktop. Record whether the app stalls and for how long — that number belongs in the
   backlog item, and a stall here is the known limit, not a regression.

9. **RAM.** `scripts/win/measure.ps1` with the remote on and the phone connected, versus off.

### v0.3.18 — verification

Phone-page only; the server is unchanged.

1. **Vertical only.** Open a tab whose desktop terminal is wider than the phone. The screen
   wraps long lines and never scrolls sideways; new output appends at the bottom and the view
   follows it unless you had scrolled up to read.
2. **Font size.** `A−` / `A+` in the header change the text size; reload the page and the size
   is kept.
3. **Keyboard.** Tap the text box so the keyboard opens, then scroll the output up and down: the
   text box and the Send/Stop/Esc buttons stay visible above the keyboard the whole time
   (Safari and Chrome).
4. **Buttons.** Send with text submits it (Claude Code receives it as one message); Send with an
   empty box is a bare Enter; Stop interrupts; Esc escapes. Tapping a button does not close the
   keyboard.

### v0.3.19 — verification

Phone-page only; the server is unchanged. v0.3.18's tab screen came up black with the composer
disabled on every phone (`@xterm/headless` gates `buffer` behind `allowProposedApi`, and the
throw was swallowed inside xterm's write loop), so its list above was never exercised in the
field and is re-run here.

1. **First frame.** Open a tab: the screen text appears within one poll interval (2 s) and the
   text box, Send, Stop and Esc become enabled. No notice line is shown. If a notice starting
   with "Screen render failed:" ever appears, report its text — that is the new guard speaking.
2. **v0.3.18 items 1–4** in full.

### v0.3.20 — verification

Phone-page only; the server is unchanged.

1. **Alt-screen scroll.** Open a Claude Code or Codex tab: ▲/▼ float at the lower right of the
   output. ▲ moves the agent's transcript towards older content, ▼ back down, and each tap lands
   within about half a second. On a plain shell tab the buttons do not appear and dragging the
   text scrolls the history as before.
2. **Faster echo.** Send text: the submitted line shows up on the phone well under a second, not
   after the next 2 s poll.
3. **v0.3.19 item 1 and v0.3.18 items 1–4** still hold.

### v0.3.21 — verification

The rename release (ADR-0017). The migration itself is §12; this list covers only what is new in
the build.

1. **App icon.** The exe in Explorer, its taskbar button, the window's title-bar corner and
   `Alt+Tab` all show the new icon in place of the blue `W`: a sail on the same near-black
   square — a light mast with a blue mainsail to its right and a darker jib to its left. Check
   the 16px sizes too (title bar, Explorer list view): the mast must stay a distinct light line
   and the two sails two distinct blues, not one blue smudge. The Start-menu entry the first
   launch registers (`mast.lnk`) must carry the same icon, and so must a toast, whose sender
   identity is that shortcut. A stale icon after replacing an exe at the same path is the
   Windows icon cache (`ie4uinit.exe -show`), not the build. The glyph is generated by
   `scripts/icon/make-icon.py`; regenerate rather than edit the `.ico` by hand.
2. **§12 item 9** in full — the migration checklist is the rest of this release's verification.

### v0.3.22 — verification

Phone-page only; the server is unchanged.

1. **Long lines wrap once.** In a plain shell tab on the phone, print a line longer than the
   desktop's width — `echo $PATH`, or `printf '%0.s-' $(seq 1 300); echo` — and read it on the
   phone: one paragraph, wrapped at the phone's width, with no break at the desktop's column
   count. Resize the desktop window so the same line re-wraps there; the phone still shows one
   paragraph.
2. **TUIs are untouched.** A Claude Code or Codex tab renders exactly as in v0.3.21 — the boxes
   still fragment at the phone's width (that is the open "PTY follows the latest viewer" item,
   not this fix), and ▲/▼ scrolling and the first frame (v0.3.19 item 1, v0.3.20 item 1) hold.

### v0.3.23 — verification

All of it is field-only — Windows Firewall, an elevation prompt and a real network profile exist
only here. Boot with `"log": true` throughout; the release build has no console, so `mast.log`
is the only place the firewall lines land. Run the PowerShell commands as administrator.

1. **Allowed.** With the `mast remote (LAN)` rule in place, *Pair phone* shows one line saying
   Windows Firewall allows this app on the port, and no button. `mast.log` has
   `remote: firewall allowed for <exe>:<port>` from boot.
2. **Missing → apply.** `Remove-NetFirewallRule -DisplayName "mast remote (LAN)"`, reopen the
   dialog: the line says no rule allows the app and *Allow in Windows Firewall* appears. Click
   it, answer the UAC prompt with Yes: the line changes to allowed and the button disappears;
   `Get-NetFirewallRule -DisplayName "mast remote (LAN)"` returns **exactly one** rule, bound to
   the running exe's path; `%TEMP%` holds no `mast-firewall-*` file; the phone connects.
3. **Declined.** Remove the rule again, click the button, answer No: the line reads
   `Not applied — the permission prompt was declined.`, the button is back, and no rule exists.
4. **Stale path.** Copy the exe to another folder and run that copy: the line names the old
   path and offers the button; after Yes there is still exactly one rule, now with the new
   path.
5. **Public.** Set the network to Public in Windows settings and reopen the dialog: the line
   says to mark the network Private and there is no button. Set it back to Private.
6. **Blocked.** `New-NetFirewallRule -DisplayName "mast test block" -Direction Inbound -Action Block -Program "<exe>"`,
   reopen: the line names `mast test block` as the blocking rule and there is no button, even
   though the allow rule exists. `Remove-NetFirewallRule -DisplayName "mast test block"` and
   the line returns to allowed.
7. **Firewall off.** Turn Windows Firewall off for the Private profile, reopen: the line says
   the firewall is off and no rule is needed, no button. Turn it back on.
8. **When an apply does not change the line**, report the `remote: firewall apply exit=` line
   and the `remote: firewall apply <exe>:<port>` line from `mast.log` with the item that
   failed — `netsh -f`'s behaviour on a failing line and its exit code are undocumented, and
   this is the only place they get answered.

### v0.3.24 — verification

Front-end only ([ADR-0019](adr/0019-restore-terminal-scroll-across-workspace-round-trip.md)).
Field-only, because the behaviour needs a real agent tab and a real workspace round-trip. Use
two workspaces throughout and switch with `Ctrl+1`/`Ctrl+2`.

1. **A Codex tab keeps its place, and does not flash the top on the way.** In a Codex tab,
   scroll the terminal up so the transcript shows something identifiable well above the bottom.
   Switch to the other workspace, wait a second, switch back: the same lines are on screen, give
   or take a few (the pane redraws its history on the way back, so the position is restored to
   within a line or two, not exactly). **Watch the second it takes to settle** — the pane may
   show the bottom briefly while the history is redrawn, but it must never show the *top* of the
   transcript and then jump down; that was the defect this release fixes. Repeat two or three
   more times — it should hold every time, not only the first.
2. **A plain shell keeps its place too.** In a bash tab run something with a long scrollback
   (`seq 1 5000`), scroll up to a known number, round-trip the workspace: that number is still
   on screen.
3. **A bottom-pinned tab is untouched.** A tab left at the bottom comes back at the bottom, and
   an alternate-screen tab (Claude Code, or `vim`/`htop`) round-trips exactly as it did in
   v0.3.23 — nothing about its screen or scroll behaviour changes.
4. **Typing and the wheel cancel the restore.** Scroll a Codex tab up, switch away, switch back
   and press a key (or scroll the wheel) immediately on return: the pane stays where your gesture
   put it and does not jump back up a moment later. The key only counts while **that** pane has
   focus (ADR-0019 decision 5), so in a split, typing into the other pane must not disturb this
   one.
5. **A cancelled restore still follows new output.** This is the defect class that cost two
   review rounds, so run it twice. Scroll a Codex tab up, switch away, switch back and press
   **Ctrl alone** (a modifier, so nothing is typed) the instant it returns; then wait for the
   reprint to finish and let the agent print something new — the pane must scroll with it. A
   pane that sits still while output arrives below is the frozen state (ADR-0019 decision 2);
   report the timing of your key press if you see it.
6. **Leaving again mid-restore keeps the place.** Scroll a Codex tab up, switch away, switch
   back and — without waiting for the redraw to settle — switch away again immediately, then
   back a third time: the place is still restored. Losing it on the third visit is the
   carry-over defect (ADR-0019 decision 3).
7. **A scrollbar drag cancels it too.** Same setup, but on return grab the pane's scrollbar and
   drag it instead of using the wheel: the restore is abandoned and the pane stays where you
   dragged it. This is the one cancel signal whose DOM target is **unverified on WebView2** — the
   handler only counts a mouse-down inside `.xterm-viewport`, and whether Chromium's overlay-off
   scrollbar (v0.3.11) delivers the event with that element as the target has not been checked
   anywhere but by reading the code. If the drag does *not* cancel, say so: the fix is to widen
   the target test, not to abandon the narrowing (a plain click to focus a pane must keep not
   cancelling).
8. **Historical reload boundary, superseded 2026-09-20.** At the time, a WebView reload lost the
   place. Use Ctrl+Shift+R to reload mast; F5 is passed to the terminal.
9. **A closed tab leaves nothing behind.** Scroll a tab up, close it, open a new terminal tab in
   the same pane: the new tab starts at the bottom.
10. **Which screen does Codex actually use here?** (Answers the conflict in ADR-0019's Context.)
   In a live Codex tab, scroll the wheel: if the *terminal's* scrollback moves, Codex is drawing
   inline on the normal buffer, as it did on the Linux dev box. If the app scrolls its own
   transcript and the terminal scrollback does not move, Codex is on the alternate screen here
   and ADR-0016's record is right about this machine. Report which one it is with the build and
   `codex --version`; the phone's ▲/▼ button rule (ADR-0016) depends on the answer.

### v0.3.25 — verification

An exited tab is now a record file, not a live session (ADR-0018). The core half is unit-tested;
everything below needs the Windows build, because the exit path, the registries, the sweep and
the diagnostics only exist there. Boot with `"log": true` throughout — `mast.log` is where the
`diag:` and audit lines land — and keep an Explorer window on
`%AppData%\app.mast.desktop\records\`.

1. **Exit writes a record and releases the session.** In a tab, run something that leaves a
   recognisable screen (`ls -la`, a short `git log`), then type `exit`.
   - The pane must keep showing that screen — it is the record now, not an attach — with the
     banner reading `shell exited (code 0) at HH:MM — Restart opens a new shell here`. The time
     is the local clock; `exit 3` in a second tab must say `(code 3)`.
   - `records\tab-<id>.bin` appears for that tab.
   - In the dev console, `window.__mast.diagnostics()`: the tab is counted under `tabs.exited`,
     `sessions.registered` and `sessions.sinks` are one lower than before the exit, and
     `sessions.replayBytes` has dropped by roughly what that tab held (a tab that printed a
     megabyte is the clearest case). `audit` must be empty — no orphans, no dangling tabs.
   - Selecting text in the record and pressing `Ctrl+C` copies it (paste it somewhere to check);
     `Ctrl+=` / `Ctrl+-` / `Ctrl+0` resize the record view **and** every live terminal by the
     same step.
2. **Restart replaces the record.** Click **Restart** in that pane: a new shell comes up in the
   tab's stored cwd, the banner is gone, and `records\tab-<id>.bin` is deleted. `↑` still offers
   the tab's resume hint (the tab id is unchanged).
3. **A record survives a relaunch, and only `Running` tabs respawn.** With several tabs open,
   some live and one exited, run `wsl --shutdown` from Windows: every tab exits and each pane
   shows its record. Close mast and start it again.
   - Every tab comes back **exited**, with its record on screen and a Restart button — no tab
     respawns on its own, and `records\` still holds one file per tab. This is the behaviour
     change: every release before this one restarted all of them at boot.
   - Now restart one tab, close the app and relaunch: that tab (now `Running`) comes back with a
     fresh shell, the others stay records.
4. **Closing a tab deletes its record.** Close an exited tab (`Ctrl+W` or the tab's ×):
   `records\tab-<id>.bin` disappears within a second. Same for closing a pane and for closing a
   whole workspace — check a workspace whose tabs were all exited, all of their files must go.
5. **A force-quit is cleaned up at the next boot.** With at least one exited tab present, kill
   mast from Task Manager (End task), then delete nothing by hand and relaunch. If any record no
   longer belongs to a tab in `state.json` — easiest to stage by killing the app right after
   closing an exited tab — `mast.log` has one `boot: swept N orphan record file(s)` line and the
   file is gone. A record whose tab still exists must **not** be swept.
6. **The `diag:` lines.** `mast.log` has one `diag: boot …` line per launch, including a launch
   with nothing to respawn. Its `sessions=`/`replay_bytes=`/`tabs …` numbers must match what
   `window.__mast.diagnostics()` reports at that moment. A second `diag:` line appears only if
   an audit finds something or the memory watchdog fires — there must be no periodic stream of
   them while the app sits idle.
7. **Many exits at once log no false orphans.** Open six or more tabs in one workspace, then make
   them all exit within the same second (`wsl --shutdown`, or `mast send` an `exit` to each in a
   loop). `mast.log` must contain **no** `audit (exit): released … orphan session(s)` line — the
   `exits_in_flight` marker exists for exactly this window. Dangling-tab repairs are also not
   expected here. Any orphan line in this scenario is the defect, and the whole block of audit
   lines is what to report.
8. **The phone is unchanged.** With the remote surface on, open an exited tab from the phone: it
   still reports the tab as unavailable (HTTP 409), the same as before this release, and the
   desktop's record view is not disturbed by the request. A live tab in the same workspace keeps
   polling normally.

### v0.3.26 — verification

Front-end only, three changes: the scrollback-wipe scroll restore (ADR-0019 amendment, items
1–7), the xterm composition patch (ADR-0020, items 8–9) and the phone's arrow keys and refresh
button (items 10–14). Field-only throughout: the defects are a reprint this dev box has never
produced and an IME it does not have, the judgment lives in a browser xterm, and the phone items
need a phone. Boot with `"log": true` and keep `mast.log` open — item 5 is what tells a failed
restore apart from bytes that never arrived. Item 9 turns the log **off** again on purpose.

1. **A resize no longer throws a scrolled-up tab to the top.** In a Codex tab, scroll up so
   identifiable lines sit well above the bottom, then resize the mast window a little. The same
   lines must still be on screen, give or take a few (the transcript is rebuilt, so the position
   is restored to within a line or two). Before this release the pane jumped to the very top of
   the transcript and stayed there.
2. **The end of an answer does not throw it either.** Ask Codex something long enough to read
   while it prints, scroll up into the transcript while it is still working, and let the answer
   finish: the pane must stay where you were. This is the trigger the user reported and whose
   cause is unmeasured — if it still jumps, item 5's log lines decide where to look next.
3. **Typing goes to the bottom, and that is xterm, not us.** After either of the above, type a
   character: the pane jumps to the bottom. Expected, unchanged, and not a defect.
4. **A tab at the bottom keeps following output.** With a Codex tab left at the bottom, resize
   the window and let an answer finish: the pane must keep tracking new output with no pause and
   no jump. Same for a plain bash tab and for an alternate-screen tab (Claude Code, `vim`,
   `htop`) — nothing about those changes.
5. **Every reprint leaves one log line.** For each of items 1 and 2, `mast.log` gets a
   `scroll: scrollback wiped N line(s) above the bottom — restoring` line, followed by one
   `scroll: restore ended …` line. **A jump with no `scroll: scrollback wiped` line is the
   important report**: it means `ESC[3J` never reached xterm (the ConPTY pass-through this change
   assumes), and the fix would belong in another layer entirely. Quote the lines either way.
6. **`clear` in a scrolled-up pane ends at the bottom.** In a bash tab with a long scrollback,
   scroll up, then send `clear` to it from another pane (`mast send`). The pane ends at the
   bottom on a cleared screen within about a second. It may take that second to get there — the
   restore starts, finds nothing to restore to and refuses — but it must not sit at the top and
   it must follow output afterwards.
7. **A wheel during a reprint keeps the place you chose.** In a Codex tab, ask for something
   long, and while it is printing scroll up with the wheel and keep reading. The pane must stay
   where you put it as output continues — a jump to the bottom a second later is the defect this
   item exists for (`mast.log` will show `scroll: restore ended cancelled` at the moment of the
   wheel; the bottom jump would come after it). Repeat with a scrollbar drag.
8. **Korean arrives byte-for-byte, idle and busy.** The judge is what the PTY received, not what
   a TUI drew, so capture it with `cat`:

   ```bash
   cat > /tmp/ime.txt      # in a mast tab; type 테스트 문장, then Ctrl+D
   xxd /tmp/ime.txt        # expected: ed 85 8c ec 8a a4 ed 8a b8 20 eb ac b8 ec 9e a5
   ```

   First in an idle tab. Then with the main thread busy — a split next to it running
   `yes | head -c 50000000`, or a Claude Code tab mid-answer — type the sentence again into the
   `cat`. Before this release the busy run lost syllables or the space (`테트문장` is the
   measured shape); now both runs must match the expected bytes. A Claude Code tab is *not* the
   judge here, but as a final check type the same sentence into one during the busy run and read
   what it shows.
9. **The log's own cost.** Repeat item 8's busy run with `"log": false`. The bytes must still be
   right (they must be right either way); the point is to notice whether the composition log
   lines made the fault easier to hit before the fix, which decides how much to trust that log
   as a reproduction tool in future IME reports. Note the answer in the report.

**The phone's arrow keys and refresh button** (items 10–14).

10. Open a plain bash tab from the phone. `↑` brings the previous command into the prompt, `↓`
   returns to where you started, and `←`/`→` move the cursor within the line.
11. Open a Claude Code tab from the phone. `↑` recalls the previous prompt in the composer.
12. Drive the tab screen into the black/error-notice state (e.g. toggle Wi-Fi off and back on
   mid-poll, or force a screen render failure). Tap `↻`: the notice clears, the screen is rebuilt
   from a fresh snapshot, and the composer/key bar become usable again.
13. With the on-screen keyboard up, tap a key-bar button (`Stop`, `Esc`, or an arrow): the
   keyboard must stay up — focus must not leave the composer.
14. On an iPhone with a home indicator, confirm the bottom dock (composer + key bar) sits above
   it and is not obscured.

### Unreleased — Codex scroll after WebView reload (ADR-0019 amendment 2026-09-20)

This is pending Windows WebView2 field verification. Automated browser tests confirm the
`pagehide` capture and restore logic, but do not prove WebView2 emits `pagehide` for a Tauri
`window.reload()`.

1. In a Codex tab, scroll up to identifiable lines and press Ctrl+Shift+R. The same area should
   return after the replay and reprint settle. F5 must still reach Codex rather than reload mast.
2. Repeat with `MAST_RESET_HIDDEN_SECS=30`: scroll up, focus another window for more than 30
   seconds, then return. Check `mast.log` for `reset: reloading webview` and confirm the place is
   restored. Repeat after switching workspaces so an inactive tab's stored position is restored
   when that workspace becomes active again.
3. Scroll up in a tab, exit its shell and press Restart. The new PTY session must start at the
   bottom. Close a scrolled tab and create another; the closed tab's place must not reappear.
4. If a pane instead jumps to the top, record the `scroll: scrollback wiped` and `scroll: restore
   ended` lines around it. A jump without the wipe line is a different path from ADR-0019's ED3
   handler. Check whether `sessionStorage["mast:scroll-memory"]` existed across the reload;
   absence means the capture did not run. Record the installed mast and Codex versions.

### v0.3.29 — Codex resume ownership verification (setup v12)

This is pending Windows field verification. The Linux regression runs the production Bash
notify script and restart-history wrapper; it cannot exercise ConPTY or readline key delivery.

1. After installing the build, confirm `~/.mast/.setup-v12` exists. In the intended pane,
   complete a Codex turn and compare `~/.mast/resume/tab-<id>` with that conversation's id.
   An already-poisoned hint needs this new turn; upgrading does not guess a replacement id.
2. Let Codex produce a catch-up summary and finish a delegated subagent. Neither may change
   the resume file to an internal thread id. A different pane must retain its own hint.
3. Quit and relaunch mast. Press ↑ once: the command must be `codex resume <original-id>`.
   Press Enter and confirm that the original conversation, not a new thread, reopens.
4. In the same pane, start a different real Codex conversation and finish a turn. Restart
   again: ↑ must now offer that new conversation. Repeat Claude → Codex and Codex → Claude
   to verify that switching real agents still replaces the hint.

Local automated reproduction: `cd apps/mast && npx vitest run tests/codex-resume.test.ts`.
No real sessions or user history are modified by that test. Storage-format assumptions and
the bounded-check fallback are recorded in `scripts/wsl/claude-hook-example.md`.

### v0.3.32 — Agent state signals verification (setup v16)

**Not yet run — no item below has passed.** v0.3.32 keeps agent status per tab and derives the
workspace card from its tabs, and setup v16 adds the Claude Code dispatcher hooks, the Codex
hooks and the Antigravity CLI hooks. Rules, limits and notices are in
[`scripts/wsl/claude-hook-example.md`](../scripts/wsl/claude-hook-example.md). The Linux suites
(`apps/mast/tests/agent-hooks.test.ts`, `provision-hooks.test.ts`, `provision-setup.test.ts`,
`codex-resume.test.ts`) cannot reach ConPTY, the `wsl.exe` relay, a real agent's TUI or Codex's
trust prompt, which is what this list is for.

Boot with `"log": true`. For every item record the Windows build, the distro, the Claude Code,
Codex and `agy` versions, the Codex trust state, PASS / FAIL / not run, and the trace: the
relevant `~/.mast/setup.log` lines, `~/.mast/agent-hooks/tab-<id>.diag` (`mast id` prints the
id) and `toast.log` lines. Known limits are marked *record*: note what the tab shows — its tab
button's `!` badge and the sidebar card's status — rather than judging it.

**Synthetic tests reset first.** When you drive a status by hand, send `mast:idle` and then, at
least 100 ms later, `mast:needsInput` from the same tab. Use the leading `sleep` to click another
window or switch to another workspace: while mast has focus on this tab's workspace the toast is
suppressed by design and only the `!` badge appears.

```bash
sleep 5; ~/.mast/bin/mast-notify.sh mast:idle reset; sleep 0.2; ~/.mast/bin/mast-notify.sh mast:needsInput "toast test"
```

The onset fires only on a transition, and two tokens inside one 100 ms flush window collapse into
the last. A repeated status, a mistyped token or a focused window that produces no toast is a test
artifact, not an app defect — two earlier rounds were lost to exactly that.

**Rerunning a setup step on a distro that finished item 1.** Setup runs when mast starts and
skips every step whose marker exists. An agent step reruns once its sub-marker is gone:
`rm ~/.mast/.setup-v16-codex` (Codex) or `rm ~/.mast/.setup-v16-agy` (Antigravity CLI), then
restart mast; that run logs `setup v16 exists; running only the missing agent steps`. The rest —
the Claude Code merge and its version guard, the dispatcher Python, the Codex `notify` line and
the AGENTS.md block — runs only in a full run, which reruns both agent steps too:
`rm ~/.mast/.setup-v16`, then restart mast; that run logs `setup v16 starting`. A bullet that
edits a file names its backup; copy the backup back when the bullet is done.

**Which terminal a hook writes to** (items 12 and 15). A hook process that has a controlling
terminal writes to `/dev/tty`; one without it takes the ancestor-pts fallback. To see which, add
one line to the agent's installed entry point — `mast-claude-hook.sh`, `mast-codex-hook.sh` or
`mast-agy-hook.sh` — and run one turn:

```bash
f=~/.mast/bin/mast-agy-hook.sh; cp -p "$f" /tmp/mast-entry.orig
sed -i '1a echo "$(date +%T) $0 ctty=$(ps -o tty= -p $$)" >> /tmp/mast-hook-tty.txt 2>&1' "$f"
```

`ctty=pts/<n>` in `/tmp/mast-hook-tty.txt` means `/dev/tty`, `ctty=?` the ancestor pts. The
command in the agent's configuration does not change, so Codex asks for no new trust. Put the
original back with `cp -p /tmp/mast-entry.orig "$f"` before timing anything in item 15.

1. **Upgrade from setup v13, and a fresh distro.**
   - On a distro last provisioned by v0.3.31, launch once. `~/.mast/.setup-v16` exists, and so
     do `~/.mast/.setup-v16-codex` and `~/.mast/.setup-v16-agy` wherever `~/.codex` and
     `~/.gemini/antigravity-cli` exist.
   - `setup.log` shows `claude: added <Event> role=dispatcher` for `SessionStart`,
     `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`,
      `PostToolBatch`, `SubagentStop` and `Stop`, and `claude: narrowed Notification`. A machine
      that ran a v14 build (the OpenCode-only v0.3.32 release) or a v15 build of this branch
      reruns automatically, since its `.setup-v14*` / `.setup-v15*` markers do not match v16;
      where its `settings.json` already holds those rows, the expected lines are
      `claude: wired <Event> role=dispatcher` and `claude: already-narrowed Notification`.
   - Every hook and key of your own in `settings.json` is unchanged, and a symlinked
     `settings.json` is still a link.
   - `rm ~/.mast/.setup-v16` and relaunch: every row logs `wired` (the Notification group
     `already-narrowed`), every merged file logs `result=unchanged`, there is no `added` or
     `narrowed` line and no Codex trust notice (it is printed only when `hooks.json` is
     written), and every group in `~/.codex/hooks.json` keeps its position. Notices about a
     condition that still holds are printed again: an agent version limit, Python below 3.8,
     `features.hooks = false`, `approvals_reviewer`, inline hooks, a `respected` event, a
     `Notification` matcher that also matches `idle_prompt`, an agy `"mast"` hook that differs.
   - A fresh distro (no `~/.mast`) with `python3` 3.8 or later and either no Claude Code or
     2.1.118 or later: one launch logs `claude: added <Event> role=status` for
     `UserPromptSubmit`, `Notification` and `Stop`, `claude: added <Event> role=dispatcher` for
      the eight events above, no `narrowed` line, and `setup v16 complete`. Relaunch: `setup.log`
      gains no line.
   - A second distro on demand: create a workspace pinned to a distro that has never run mast
     (section 4). Its `~/.mast/.setup-v16` appears without restarting mast.
2. **Setup notices and reruns.**
   - Every notice is in `setup.log` — as `notice: …`, or as the `[mast] setup: …` text the merge
     helper printed — and in `mast.log` as a `provisioning notice`.
   - Relaunch with all markers present: `mast.log` has no
     `provisioning failed … cannot stream the setup script`, and `setup.log` gains no line.
   - `~/.mast/bin/mast-python` holds an absolute path to Python 3.8 or later.
   - **Claude Code version guard.** With no Claude Code session running,
     `mv ~/.claude/settings.json /tmp/mast-claude-settings.json`, and put a stub on a candidate
     path that holds no real install (use `~/.volta/bin` if `~/.bun/bin/claude` exists):
     `mkdir -p ~/.bun/bin && printf '#!/bin/sh\necho 2.1.117\n' > ~/.bun/bin/claude && chmod +x ~/.bun/bin/claude`.
     `rm ~/.mast/.setup-v16` and relaunch: `setup.log` shows
     `claude: /home/<you>/.bun/bin/claude --version reports 2.1.117`, a
     `notice: Claude Code 2.1.117 at /home/<you>/.bun/bin/claude has no PostToolBatch hook …`
     line and `claude: added <Event> role=status` for the three status events, with no
     `role=dispatcher` line; the new `settings.json` holds only the three `mast-notify.sh` groups.
     Repeat with a stub that fails — `printf '#!/bin/sh\nexit 1\n' > ~/.bun/bin/claude`, then
     `rm ~/.mast/.setup-v16` again and relaunch: `claude: … --version is unreadable`,
     `notice: cannot read the version of Claude Code at …`, and still no `role=dispatcher` line.
     Then delete the stub (and `~/.bun` if you created it) and
     `mv /tmp/mast-claude-settings.json ~/.claude/settings.json`; no rerun is needed.
   - **An agent installed after v16.** Install Codex or `agy` on a distro whose v16 run happened
     without it, or simulate one with `rm ~/.mast/.setup-v16-codex` (`-agy`), and relaunch.
     `setup.log` shows `setup v16 exists; running only the missing agent steps`,
     `codex: added <Event>` for the seven events (`codex: wired <Event>` when simulated) or
     `agy: added mast` (`agy: wired mast`), then `codex hooks: step done` or
     `agy hooks: step done`, and no `claude:`, `codex: notify` or `codex agents:` line. A Codex
     first installed this way has no `notify` line and no AGENTS.md block, so it shows no idle
     before its hooks are trusted and records no resume hint: before running items 3, 10 and 13 on
     it, `rm ~/.mast/.setup-v16` and relaunch, which adds both.
   - **Exit 3.** `cp -L ~/.codex/hooks.json /tmp/mast-codex-hooks.json`,
     `printf '{"$schema": "x"}\n' > ~/.codex/hooks.json`, `rm ~/.mast/.setup-v16-codex` and
     relaunch. `setup.log` shows `codex: result=failed` with `unknown top-level key` in its
     reason, `codex hooks: refused (exit 3)` and
     `notice: Codex hooks were not installed, and mast will not retry until you edit ~/.codex/hooks.json and run rm ~/.mast/.setup-v16-codex; …`;
     the file still reads `{"$schema": "x"}`, and `~/.mast/.setup-v16-codex` exists again.
     Relaunch: `setup.log` gains no line. `cp /tmp/mast-codex-hooks.json ~/.codex/hooks.json`,
     `rm ~/.mast/.setup-v16-codex` and relaunch: `codex: wired <Event>` for the seven events and
     `codex hooks: step done`. For Antigravity CLI the same with
     `cp -L ~/.gemini/config/hooks.json /tmp/mast-agy-hooks.json`, `{"other": 5}` and
     `.setup-v16-agy`: `agy: result=failed` naming the `other` hook, `agy hooks: refused (exit 3)`,
     and `agy: wired mast` after the restore.
   - **Opt-out markers.** `touch ~/.mast/no-codex-hooks`, `rm ~/.mast/.setup-v16-codex` and
     relaunch: `setup.log` shows `codex hooks: ~/.mast/no-codex-hooks exists; skipped`, and the
     sub-marker exists again. The same with `no-agy-hooks` and `.setup-v16-agy`:
     `agy hooks: ~/.mast/no-agy-hooks exists; skipped`. Delete the opt-out marker afterwards.
3. **Codex trust.**
   - The next Codex launch shows **Hooks need review**. Choose *Continue without trusting*: no
     hook runs (a prompt shows no `running`). Quit and start Codex twice more, and *record*
     whether the prompt returns each time.
   - *Trust all and continue*: the hooks keep running after restarting Codex and mast.
   - Before trusting, Codex's `notify` still reports idle at the end of a turn (a Codex first
     installed after v16 needs the full run first — item 2, *An agent installed after v16*).
   - **`features.hooks = false`** (needs Python 3.11 or later for `tomllib`; with an older
     `python3` no notice is expected). `cp -L ~/.codex/config.toml /tmp/mast-codex-config.toml`,
     set `hooks = false` under `[features]`, note `stat -L -c %Y ~/.codex/config.toml`,
     `rm ~/.mast/.setup-v16-codex` and relaunch: `setup.log` shows
     `codex: hooks-feature=disabled key=hooks` and
     `[mast] setup: hooks disabled in config; mast hooks will not run (… sets features.hooks = false)`,
     and `stat` prints the same value. Copy the backup back.
   - **Inline `[hooks]` tables.** `cp -L ~/.codex/config.toml /tmp/mast-codex-config.toml` and
     `mv ~/.codex/hooks.json /tmp/mast-codex-hooks.json` — with item 1's `hooks.json` in place,
     Codex warns about hooks in both places whatever mast does. Append

     ```toml
     [[hooks.Stop]]
     [[hooks.Stop.hooks]]
     type = "command"
     command = "true"
     ```

     to `config.toml`, `rm ~/.mast/.setup-v16-codex` and relaunch: `setup.log` shows
     `codex: inline-hooks events=Stop`, the `[mast] setup: Codex hooks are configured inline in …`
     notice and `codex: result=skipped-inline-hooks`; `~/.codex/hooks.json` does not exist, and
     the sub-marker exists again. Start Codex: it prints no warning about hooks in both places
     (choose *Continue without trusting* if it asks about the inline hook). Then
     `mv /tmp/mast-codex-hooks.json ~/.codex/hooks.json` and copy `config.toml` back; no rerun is
     needed.
   - `grep app-server-control-socket ~/.mast/setup.log`: *record* the value. If you use a shared
     app-server, submit a prompt in the attached Codex TUI and *record* which tab, if any, shows
     running.
4. **Two tabs, two panes.**
   - A `running`, B `idle`: the workspace card shows running.
   - A and B each at needs input, with the window unfocused or another workspace active: each
     tab shows its own `!` badge and gets its own toast, titled
     `mast — <workspace> · <tab title>`, with that tab's message as the body.
   - With mast focused and that workspace active: no toast for either.
   - `toast.log` has one `ok label="<workspace> #<tab id>"` line per toast and no tab title.
   - The sidebar preview is the newest message — the waiting tab's while the card shows
     needs input.
   - A tab reporting running, closing or exiting leaves the other tab's status and badge as
     they were.
5. **Claude Code: approve, deny, interrupt.**
   - Leave a permission prompt for about 6 s so the `Notification` fires, then approve: the tab
     returns to running when that tool finishes, before `Stop`. The same for an approved tool
     that fails.
   - An approved long command: *record* that needs input stays while it runs.
   - Deny with No or Esc after the `Notification` (*record*: needs input stays) and within 6 s
     (*record*: running stays).
   - Deny **with feedback** and let Claude use another tool: running at the end of that batch.
   - Esc while a tool runs, and Esc while Claude is streaming: *record* what the tab shows
     (expected running until the next prompt — no hook reports either).
6. **Claude Code: subagents and sessions.**
   - While the main agent waits for approval, a background subagent calling tools does not
     clear the badge.
   - Parallel `WebFetch` calls with a single prompt: the sibling finishing does not clear it.
   - *Record* the tab when the main agent stops while a subagent's prompt is open (expected
     idle, a known limit), and after a background subagent finishes following the main `Stop`.
   - Kill a Claude Code process from another tab (`kill -KILL <pid>`; `pgrep -af claude` lists
     it) while one of its subagents waits for approval. In the same tab run the resume command
     (`cat ~/.mast/resume/tab-$MAST_TAB` shows it), ask for a root tool call that needs approval,
     leave the prompt about 6 s until the tab shows needs input, and approve: the tab returns to
     running when that tool finishes, before `Stop`. Had the resume not dropped the killed
     subagent's wait, the tab would stay at needs input until `Stop`.
   - `/clear` with a subagent prompt open: *record* whether the badge survives.
   - With `~/.mast/claude-pairing-off`: tool results report running without pairing.
7. **Claude Code: side notifications.**
   - About a minute after a finished turn, `idle_prompt` causes no needs input and no toast.
   - An elicitation dialog, `agent_needs_input`, `quota_auto_resume_stale` or
     `worker_permission_prompt`, where you can reach one, still shows needs input.
8. **Codex transitions.**
   - Submit a prompt: running. A single approval dialog: needs input after about 2 s; approve:
     running when the command completes.
   - The turn ends: idle with the first line of the last answer (`codex turn complete` when
     there is none). Esc: idle with `interrupted`.
   - A turn continued by a blocking Stop hook: running resumes, and an approval inside it still
     shows needs input.
   - No needs input comes back after `Stop`, `Interrupt` or a new prompt from an approval that
     was already settled.
   - A response with parallel tool calls: needs input stays while the dialog is open.
9. **Codex automatic approvals, long commands, denials.**
   - Short commands repeated after "don't ask again": no toast.
   - For each of these, *record* when the `!` badge appears and the event it clears at (the
     command finishing, `Stop`, `Interrupt`, the next prompt): a repeated long command; a long
     command approved after its dialog was open for more than 2 s (expected: needs input until
     it completes); a long command approved within 2 s; a dialog **denied** within 2 s and one
     denied after more than 2 s, the turn going on (expected: needs input until `Stop`,
     `Interrupt` or the next prompt); `sleep 40`, a dev server, and a command the model runs with
     a short yield.
   - **`auto_review`.** `cp -L ~/.codex/config.toml /tmp/mast-codex-config.toml`, then put
     `approvals_reviewer = "auto_review"` in the root table — above the first `[table]` header;
     a line below any header, a profile's included, is seen by neither check. Runtime, with no
     rerun: restart Codex and let it request approvals; none raises needs input, and right after
     a request `tab-<id>.diag` reads
     `approvals_reviewer is auto_review in ~/.codex/config.toml; needsInput disabled`. Notice:
     `rm ~/.mast/.setup-v16-codex` and relaunch mast: `setup.log` shows
     `codex: approvals-reviewer=auto_review` and the
     `[mast] setup: approvals_reviewer is auto_review in …` notice. Copy the backup back.
   - `touch ~/.mast/codex-needs-input-off`: no needs input either, running and idle intact, and
     right after an approval request `tab-<id>.diag` reads
     `needsInput disabled by ~/.mast/codex-needs-input-off`. Delete the marker afterwards.
10. **Codex subagents, nesting, late notify.**
    - An unrelated `PostToolUse` does not clear an open approval.
    - Esc at the root, then a subagent approval: needs input, and idle again once approved.
    - Queued input or a steer submitted while a subagent dialog is open: needs input stays.
    - *Record* the tab after aborting a subagent's dialog (a known limit), and check that an
      approved subagent call which then fails is cleared when the subagent stops.
    - No status change from a nested `codex`, a temporary thread, or a `codex exec` started by
      Claude Code's Bash tool in the same tab.
    - For `request_user_input`, `/review` and a turn that ends in an error, *record* what the tab
      shows afterwards, `tab-<id>.diag`, and `jq .codex.records ~/.mast/agent-hooks/tab-<id>.json`
      — a record whose `state` is `emitted` is what holds needs input.
    - A catch-up summary's or a subagent's `notify`, followed at once by a queued prompt's
      turn: the late idle never replaces running.
    - A new session whose hooks are not trusted: its `notify` idle arrives normally.
11. **Versions.** The Codex and `agy` version notices in `setup.log` match the lowest installed
    versions and name their paths. If a Codex older than 0.148.0 is at hand, *record* the
    warning it prints at launch about skipped asynchronous hooks.
12. **Antigravity CLI.**
    - An `agy` conversation in a tab: running during model calls; idle with the first line of
      the final output when the turn ends.
    - *Record* the tab while `agy` waits for a tool confirmation (expected running) and after
      Esc cancels a turn.
    - `agy` outside mast emits nothing, and `agy` never reports a hook output error.
    - *Record* the `ctty=` value the tty probe (top of this section) logs for
      `mast-agy-hook.sh` during one turn.
    - With an `agy` older than 1.1.10 at hand: its notice appears.
13. **Resume hints.**
    - `~/.mast/resume/tab-<id>` stays exactly `codex resume <id>` or `claude --resume <id>` for
      the session you ran; an `agy` session leaves it unchanged. The Codex hint needs the
      `notify` line (item 2, *An agent installed after v16*).
    - A Codex temporary thread still leaves the previous hint in place (§10 v0.3.29).
14. **Lifecycle.**
    - Closing a needs-input tab, closing its pane, and a failed respawn each leave the other
      tabs' status intact.
    - The first snapshot after `Ctrl+Shift+R` raises no toast.
    - After an app restart every tab and card is idle.
    - A phone page opened before the update still shows the workspace badge.
    - After closing a tab, `~/.mast/agent-hooks/tab-<id>.*` is gone.
15. **Cost, tty, screen.**
    - *Record* the `ctty=` value the tty probe (top of this section) logs for
      `mast-claude-hook.sh` and `mast-codex-hook.sh`, one turn each.
    - **Hook timings.** Remove the tty probe line first, and type these into the shell of a
      spare tab with no agent in it — not through an agent's shell tool, whose `CLAUDECODE` or
      `CODEX_THREAD_ID` silences the dispatcher. The events replace that tab's Codex hook state
      with a made-up session and leave it running (`~/.mast/bin/mast-notify.sh mast:idle reset`
      afterwards).

      ```bash
      ev() { printf '{"hook_event_name":"%s","session_id":"probe","turn_id":"t1","transcript_path":"/tmp/probe","tool_name":"Bash","tool_use_id":"c%s","tool_input":{"command":"sleep %s"}}' "$1" "$2" "$2"; }
      hook() { ~/.mast/bin/mast-codex-hook.sh <<< "$1"; }
      TIMEFORMAT=%R; rm -f /tmp/mast-hook-s.txt
      for i in $(seq 40); do for e in PreToolUse PostToolUse; do p=$(ev $e $i); { time hook "$p"; } 2>> /tmp/mast-hook-s.txt; done; done
      sort -n /tmp/mast-hook-s.txt | sed -n 76p
      awk 'NR % 2 { p = $1; next } { print p + $1 }' /tmp/mast-hook-s.txt | sort -n | sed -n 38p
      ```

      The two numbers are the warm p95, in seconds, of one synchronous hook (target: under
      0.050) and of the `PreToolUse` + `PostToolUse` pair a Codex tool call pays (target: under
      0.100). *Record* both, and as the cold figure one pair timed right after
      `sync; echo 3 | sudo tee /proc/sys/vm/drop_caches`.
    - A large `tool_response`:
      `python3 -c 'import json; print(json.dumps({"hook_event_name": "PostToolUse", "session_id": "probe", "turn_id": "t1", "transcript_path": "/tmp/probe", "tool_name": "Bash", "tool_use_id": "big", "tool_input": {"command": "true"}, "tool_response": "x" * 4194304}))' > /tmp/mast-post-large.json`,
      then `time (cat /tmp/mast-post-large.json | ~/.mast/bin/mast-codex-hook.sh)`. *Record* it
      next to the warm single-hook p95.
    - Eight asynchronous approvals at once, with `ev` and `hook` from above:
      `rm -f ~/.mast/agent-hooks/tab-$MAST_TAB.diag; for i in $(seq 8); do hook "$(ev PreToolUse $i)"; done; for i in $(seq 8); do hook "$(ev PermissionRequest $i)" & done; wait`.
      The tab shows needs input about 2 s in, and `~/.mast/agent-hooks/tab-$MAST_TAB.diag` does
      not exist — a lock timeout or an unpaired request would have written it. Then
      `for i in $(seq 8); do hook "$(ev PostToolUse $i)"; done` returns the tab to running.
    - A tool-heavy turn in Claude Code and in Codex leaves no screen artifacts or cursor drift.
    - While idle, no extra resident process or wakeup exists, and hook stdout stays empty.

### Phone-controlled PTY size — verification

This is pending Windows field verification, and it is field-only by nature: the question is a
TUI's layout on a real phone against a real desktop pane. The server half is covered on the dev
host (`cargo test -p mast-remote` — including the SIGWINCH the shell sees — and the ownership
rules in `cargo test -p mast-core`); `apps/mast` covers the phone side (`npx vitest run
src/remote`). Contract: [ADR-0016](adr/0016-remote-surface-over-lan.md) amendment (2026-09-17).

1. **Mobile.** On the phone, open a Claude Code or Codex tab and press *Mobile*. The TUI
   redraws at the phone's width (box borders, tables and the input box no longer fragment), the
   *Mobile* chip is highlighted, and the desktop pane now shows that same narrow drawing. In a
   plain shell tab, `stty size` prints the phone's rows and columns.
2. **Keyboard.** With the mobile layout up, tap the composer (keyboard opens) and dismiss it:
   neither may change the layout or redraw the screen — the PTY size is fixed at the press.
   Rotating the phone is allowed to look unchanged for the same reason.
3. **Desktop.** Press *Desktop*: the TUI redraws at the desktop pane's current size and the
   chip flips back. Resize the desktop window (or the pane, via the splitter) *while* mobile
   mode is on, then press *Desktop*: the restored size must be the new one, not the size from
   before the resize.
4. **Desktop resize is suppressed.** In mobile mode, resize the desktop window and drag a
   splitter: the phone's layout stays narrow (the desktop pane keeps showing the narrow
   drawing — that is the accepted cost).
5. **Leaving the tab.** In mobile mode press *Back* on the phone and watch the desktop pane: it
   returns to its own size within a poll or two. Repeat by closing/swiping away the phone
   browser (`pagehide`), and by locking the phone or walking out of Wi-Fi (the 30 s lease):
   the desktop size returns without touching the phone. Then the tight timing: press *Mobile*
   and *Back* back to back, before the next poll lands — the desktop size must still return
   at once (the phone writes a successful claim into its own state, so leaving hands it
   back). Repeat with *Mobile* followed immediately by swiping the browser away.
6. **Concurrent phones.** With two phones on the same tab, press *Mobile* on one: both show the
   mobile layout and the *Mobile* chip. Press *Desktop* on the other: both flip back at their
   next poll. Last press wins.
7. **Tab restart while owned.** In mobile mode, restart the tab from the desktop banner: the
   phone flips to the *Desktop* chip after its next poll (or shows "The shell restarted"), and
   a *Mobile* press claims the new session.

### Phone needsInput dot — verification

Phone page only; the state JSON is unchanged. The dev host locks the judgment and the DOM
handling (`npx vitest run src/remote/list-view.test.ts`); what only the field can answer is
whether a real waiting agent shows up on the right row.

1. **Dot appears.** In a tab run `~/.mast/bin/mast-notify.sh mast:idle done` then
   `~/.mast/bin/mast-notify.sh mast:needsInput "approve?"` (reset first — the same transition
   rule as the toast checks). Open the phone's workspace list: that tab's row carries a warn
   `●` next to its title, and the workspace card still shows the `needs input` badge. A
   sibling tab in the same workspace has no dot.
2. **Two waiting tabs, one released.** Drive a *second* tab of the same workspace to needsInput:
   both rows carry a dot (the dot is the tab's own `agentStatus`, not a workspace-level
   approximation). Run `~/.mast/bin/mast-notify.sh mast:running` in the first tab: only its dot
   disappears at the next poll while the second tab keeps its own — and the workspace badge
   stays `needs input` because the second tab is still waiting. Reset both tabs afterwards.

## 11. ARM64 cross-build notes

The dev machine that produced this repo's crates is x86_64; the eventual target device policy
(터미널-계획-v2.md section 13) is ARM64. Cross-compiling *from* this x64 Windows machine *for*
ARM64 Windows:

1. Add the ARM64 MSVC build tools individually component in the Visual Studio Build Tools
   installer (see section 1 above) — the x64 build tools alone do not include the ARM64 linker.
2. Add the Rust target:

   ```powershell
   rustup target add aarch64-pc-windows-msvc
   ```

3. Build with `--target`:

   ```powershell
   cd apps\spike
   npm run tauri build -- --target aarch64-pc-windows-msvc --no-bundle
   ```

Cross-compiled ARM64 binaries can only be *built* here — running them and doing the actual
Spike verification (ConPTY OSC passthrough, IME, RAM) requires real ARM64 hardware (or an
ARM64 VM), since this machine cannot execute ARM64 Windows binaries. `crates/mast-core` itself
has no target-specific code (it's checked against `x86_64-pc-windows-msvc` in the WSL-side gate
per spike-plan.md section 5), so the ARM64-specific risk surface is `portable-pty`'s ConPTY
backend and Tauri/WebView2, not `mast-core`.

### CI artifacts (stage 22) and device testing (stage 23)

Since stage 22, `.github/workflows/ci.yml` runs the full gate set (including
`cargo clippy --workspace --all-targets --target aarch64-pc-windows-msvc` — check-family
commands never link, so this needs no MSVC libraries and also runs on the Linux dev host)
on every push, and builds **release artifacts for both targets** on a manual
`workflow_dispatch` (GitHub → Actions → CI → Run workflow) or a `v*` tag: download
`mast-aarch64-pc-windows-msvc` from the run's artifacts for the ARM64 device. A `v*` tag
additionally attaches `mast-x64.exe` / `mast-arm64.exe` to a GitHub Release — the
`workflow_dispatch` path stays workflow-artifacts-only.

Stage 23 (device verification) runs on the ARM64 machine, WSL2 + ARM64 Ubuntu installed:
1. The artifact runs natively (Task Manager shows no emulation; ARM64 process).
2. Spike-era regression spot: OSC routing (`osc-test.sh`), IME (한글), flood
   responsiveness, copy/paste — sections 5–6 spot checks.
3. Checkpoint-2 spot: one item each from the Stage 17/18/20/21 subsections of §10.
4. RAM: `scripts/win/measure.ps1 -ProcessName mast-app` with the 4-pane + viewer
   composition from checkpoint 2 — same 100–150MB acceptance band.
5. Claude Code inside ARM64 WSL (and Codex CLI if its Linux ARM64 binary exists — 계획
   v2 section 13 precheck) with the hook contract wired.

## 12. Rename migration (`winmux` → `mast`)

The project was renamed again in v0.3.21 — `winmux` collided with an active project in the
same category (`ZimengXiong/winmux`, "WinMux for macOS"), one of 28 same-name repositories.
Like the `wmux` → `winmux` round before it (§10 item 12, kept verbatim as the record of that
migration), this is a one-time, single-developer migration handled by hand, not by migration
code.

**Order matters.** Two of these steps must happen *before* the first launch of the new exe,
because provisioning treats an unrecognised entry as "the user's own" and leaves it alone —
while still writing its own completion marker. Do them late and the new integration never
wires up while the old entries keep firing — items 2 and 3 say what that looks like.

**Copy, do not move.** Every step below copies and leaves the old state in place. Delete the
originals only after item 7 passes; until then a failed migration is one `winmux.exe` launch
away from being undone.

1. **Remote** — GitHub redirects the old repository URL, but update it explicitly, in every
   checkout you keep (the WSL clone and the Windows checkout):
   `git remote set-url origin git@github.com:sjkwon-1023/mast.git`. The local folder name is
   free (rename it to `mast` or leave it — nothing reads it).

2. **Codex — before the first launch.** In `~/.codex/config.toml`, delete the
   `# winmux: notify on turn completion …` comment and the
   `notify = ["bash", "-lc", '…winmux-codex-notify.sh…']` line. Provisioning matches its own
   line by the strings `mast-notify.sh` / `mast-codex-notify.sh`; a `winmux-` line matches
   neither, so it takes the "notify already set; left untouched" branch, exits 0, and the
   run still records `.setup-v11`. Delete the line afterwards and nothing rewires it — you
   would have to `rm ~/.mast/.setup-v11` and relaunch. In `~/.codex/AGENTS.md`, delete the
   `<!-- >>> winmux integration … >>> -->` … `<!-- <<< winmux integration <<< -->` block by
   hand. Provisioning only ever rewrites a block whose markers already say `mast`, so an old
   block is not replaced — the new one is appended after it, and Codex is left with two blocks
   advertising two CLIs, of which the old one hangs (item 6). Deleting `.setup-v11` and
   relaunching does not clear it either; only the hand edit does.

3. **Claude Code hooks — before the first launch.** In `~/.claude/settings.json`, delete the
   `UserPromptSubmit` / `Notification` / `Stop` entries that call `winmux-notify.sh`. Keep any
   hook of your own. Provisioning identifies its entries by `mast-notify.sh`, so an old entry
   is not recognised and a second set is added next to it — the duplicate-hook symptom from
   the `wmux` round. It is not a quiet duplicate: the old set keeps firing, and a `winmux:*`
   title no longer parses as a status token, so the core files each one as a status-neutral
   notification (`notify.rs`) — an unread dot on every prompt and a sidebar preview reading
   `needs input` or `done` regardless of what the agent is doing. In the same file, rewrite the
   `permissions.allow` entries `Bash(winmux ls)` / `Bash(winmux id)` / `Bash(winmux send:*)`
   to their `mast` spellings — provisioning owns only `hooks` and never touches that key, and
   without it every CLI call from an agent prompts for permission. Also remove the old skill:
   `rm -rf ~/.claude/skills/winmux-send`. Anything of your own that calls the CLI — a script
   or skill that runs `winmux send`, reads `$WINMUX` or hard-codes `~/.winmux/bin/winmux` — is
   yours to rename; nothing here sees it.

4. **App state** — the Tauri identifier moved from `app.winmux.desktop` to `app.mast.desktop`,
   so the state directory moved with it. Copy
   `%APPDATA%\app.winmux.desktop` to `%APPDATA%\app.mast.desktop`; the existing workspaces,
   panes and tabs restore exactly as before. Skip it and the app boots with empty state —
   nothing is lost, the data just sits in the old folder. `winmux.log`/`winmux.log.1` can be
   left behind; the new app writes `mast.log`. (The spike's identifier moved
   `app.winmux.spike` → `app.mast.spike` the same way, but it persists nothing.)

5. **Start menu** — delete the old `winmux.lnk` from
   `%AppData%\Microsoft\Windows\Start Menu\Programs`. Leaving it is not cosmetic: launching it
   runs the old exe, which writes the old state and re-adds the old hooks. The first launch of
   the new exe registers `mast.lnk` itself.

6. **Shell state in WSL**, in each distribution you use — copy the two directories that hold
   anything you would miss, and let provisioning rebuild the rest:

   ```bash
   mkdir -p ~/.mast && cp -a ~/.winmux/history ~/.winmux/resume ~/.mast/
   ```

   Do **not** copy `bin/`, `setup.log` or `.setup-v*`. The helpers are reinstalled under their
   new names, and an old `~/.winmux/bin/winmux` left on `PATH` emits a `winmux-query` OSC that
   the new parser drops, so it hangs rather than failing.

7. **Environment variables** — every `WINMUX_*` knob is now `MAST_*`. If you had
   `WINMUX_DISTRO` set (section 4), `setx MAST_DISTRO "…"` instead; the old name is no longer
   read and a stale one silently does nothing. Same for any `WINMUX_RESET_*` /
   `WINMUX_OSC_FLUSH_MS` you set for the section 9 checks. `MAST` and `MAST_TAB` are set by the
   spawn wrapper — never set those yourself.

8. **Firewall** — the allow rule that lets the phone in is bound to the exe **path**, so the
   `winmux-x64.exe` rule does nothing for `mast-x64.exe`, and on a PC whose profiles have
   `NotifyOnListen` off Windows does not ask when the new exe starts listening. The only
   symptom is a phone page that never loads while `mast.log` shows a healthy
   `remote: listening …`. From v0.3.23 the *Pair phone* dialog says whether this exe and this
   port are allowed and offers to write the rule (one UAC prompt); nothing removes the old
   rule, so delete it by hand: `Remove-NetFirewallRule -DisplayName "winmux remote (LAN)"`.

9. **Verify, then delete.** Launch `mast`, then check:
   - `~/.mast/setup.log` ends with `setup v11 complete` (`setup v16 complete` from setup v16), and
     `~/.mast/bin` holds `mast`, `mast-notify.sh`, `mast-codex-notify.sh`, `mast-send.sh`,
     `mast-open`.
   - `~/.claude/settings.json` has exactly the **three** `mast-notify.sh` hooks mast writes and no
     `winmux-notify.sh` (from setup v16 it also has eight `mast-claude-hook.sh` dispatcher hooks,
     unless `setup.log` has a notice that approval tracking was not wired — a Claude Code version,
     or Python below 3.8 — which leaves none, or a `claude: respected <Event>` line, which leaves
     none for that event); `~/.codex/config.toml` has one
     `mast-codex-notify.sh` notify line; `~/.codex/AGENTS.md` has exactly one managed block.
   - In a tab: `printenv MAST MAST_TAB`, `command -v mast`, `mast ls`, and `mast send` to
     another tab with a short and a long line — both must submit, not just pre-fill.
   - Status and toast: drive `mast:running` → `mast:idle` → `mast:needsInput` (the onset only
     fires on a transition, so reset to idle first) and confirm the sidebar and a toast from
     the "mast" sender, with the window unfocused.
   - Phone: **hard-refresh the phone's browser** before pairing — a cached page reads
     `X-Winmux-*` response headers the new server no longer sends, so every screen poll rejects
     with `screen reply has malformed headers` while the Bearer token still authenticates: it
     is not a pairing failure. Then pair from a fresh QR (the token key in local storage
     changed too), and check the tab list, first frame, scrolling and Send.
   - Restart the app: workspaces, splits, tabs, each shell's directory, history and the resume
     hint one `Up` away.

   Only after all of that: delete `%APPDATA%\app.winmux.desktop` and `~/.winmux`.

## 13. PTY resource soak test

`crates/mast-core/tests/soak_windows.rs` creates, kills and respawns a `PtySession`
hundreds of times and checks that the test process's resources **come back to where they
started**. It answers the backlog item "No Windows PTY resource soak test": the handles,
threads and ConPTY helper processes a terminal session owns live on Windows, and nothing
in the repository exercised them at volume on the platform where they actually exist —
`crates/mast-core/tests/session_integration.rs` is `#![cfg(unix)]`.

> **First Windows run: 2026-09-12, both modes PASS** (Windows 11, `rustc` stable-msvc, run
> from a `%TEMP%` copy of `main` at 99247e0 plus the fix below). `cmd` mode, 1,000 cycles in
> 20 s: handles 74 → 74, threads 5 → 5, private bytes 1.34 → 1.65 MB, `conhost` 13 /
> `OpenConsole` 0 / `wsl` 6 / `wslhost` 5 / `wslrelay` 1 unchanged from baseline to final.
> `wsl` mode, 500 cycles in 24 s: handles 74 → 74, threads 5 → 5, private 1.34 → 1.74 MB,
> the same five process counts unchanged. Kernel pool moved by ±5 MB, which is machine noise.
> Those numbers are the regression reference this section now carries.
>
> The very first attempt hung at cycle 0 with "on_exit was not called within 60s" in **both**
> modes, and the cause is worth knowing beyond this test: `portable-pty` opens every
> pseudoconsole with `PSEUDOCONSOLE_INHERIT_CURSOR`, so conhost's first output is a cursor
> position query (`ESC[6n`) and it **holds the child process until a CPR reply arrives** —
> even `cmd.exe /c exit` never runs to completion, and `child.wait()` never returns. The app
> is unaffected because xterm answers the query (the checkpoint-1 "blank screen, bytes_out=4"
> incident in `features/terminal/view.ts` was this same handshake seen from the other side); the soak
> has no xterm, so its sink now answers `ESC[1;1R` itself. `ClosePseudoConsole` never blocked
> in any probe (≤1 ms with a reader mid-`read()` and with none), so the waiter's order in
> `session.rs` is not implicated. One side finding from the same probe: dropping the PTY
> **writer** while the child is alive makes conhost end the client with
> `0xC000013A` (`STATUS_CONTROL_C_EXIT`) — `session.rs` only drops it after the child is dead
> or being killed, so it is harmless today, but a premature drop would fabricate that code.

### Running it

```powershell
cd <repo>\scripts\win
.\soak-pty.ps1                                  # 500 WSL cycles, results under <repo>\soak-results
.\soak-pty.ps1 -Cycles 1000 -Mode cmd           # 1,000 ConPTY-only cycles (no WSL), much faster
.\soak-pty.ps1 -Cycles 1000 -OutDir C:\temp\soak
```

The script only moves its three parameters into environment variables, runs the test and
tees stdout to `soak-<mode>-<timestamp>.log` next to `soak-<mode>-<timestamp>.csv`. The
equivalent by hand:

```powershell
$env:MAST_SOAK_CYCLES = "500"
$env:MAST_SOAK_MODE = "wsl"
$env:MAST_SOAK_CSV = "C:\temp\soak.csv"
cargo test -p mast-core --release --test soak_windows -- --ignored --nocapture
```

Run it on an otherwise quiet machine, and expect it to take a while: a WSL cycle spawns a
real `wsl.exe`, so 500 cycles is minutes, not seconds. `-Mode cmd` trades WSL coverage for
speed and is the right mode when the question is about ConPTY itself.

### What it measures, and what it does not

The sink answers ConPTY's start-up cursor query (`ESC[6n` → `ESC[1;1R`) on every cycle,
because conhost holds the child until that reply arrives (see the callout above) — without
it no `NaturalExit` cycle can ever finish.

Each cycle is one `PtySession` through one of three patterns, rotating: **(A)** a program
that exits on its own (`wsl.exe --exec /bin/true` / `cmd.exe /c exit`) waited out to
`on_exit`; **(B)** a long-lived program (`wsl.exe --exec sleep 5` / `cmd.exe /k`) killed
after its first output or 200 ms, whichever comes first; **(C)** the same long-lived program
killed immediately after spawn — the rapid-respawn case. Every cycle waits for `on_exit`
with a 60 s cap and **fails** rather than hangs if it does not arrive.

The WSL program's 5 s lifetime is deliberately far shorter than the settle cap: a relay that
`kill()` failed to reap but that would have expired on its own has to be gone well before the
verdict, or the test cannot tell it apart from a real leak. `cmd.exe /k` needs no such bound —
it is the ConPTY's direct child, so killing it is the reap.

In scope: `PtySession` only — spawn, the reader and waiter threads, `kill()`, and the PTY
handles they own. Out of scope: the app's `SessionManager`, `SinkRegistry`, the Tauri glue
and the WebView. A green soak therefore does not clear the app of leaks; a red one says the
cause is in the core or in `portable-pty`/ConPTY, which is a much smaller place to look.

The measured counters, all read for the **test process itself** unless stated otherwise:

| Column | Source | Judged |
|---|---|---|
| `handles` | `GetProcessHandleCount` | yes |
| `threads` | Toolhelp `TH32CS_SNAPTHREAD`, filtered to this PID | yes |
| `private_bytes` | `K32GetProcessMemoryInfo` → `PROCESS_MEMORY_COUNTERS_EX.PrivateUsage` | yes |
| `working_set_bytes` | the same call's `WorkingSetSize` | no — reported |
| `conhost`, `openconsole`, `wsl`, `wslhost`, `wslrelay` | Toolhelp `TH32CS_SNAPPROCESS`, image name, case-insensitive, **system-wide** | yes |
| `kernel_paged_bytes`, `kernel_nonpaged_bytes` | `K32GetPerformanceInfo` `KernelPaged`/`KernelNonpaged` × `PageSize` | no — reported |

The process counts are system-wide because there is no reliable way to attribute a conhost
to one session after it has been orphaned — which is exactly the failure being hunted. That
also means another terminal opening during the run moves those columns, which is why the
rule compares against a baseline rather than expecting a fixed number.

In `wsl` mode the killed program is a Linux `sleep 5`, and killing `wsl.exe` on the Windows
side is not known to reap the Linux-side relay — that is the open question ADR-0009 left. The
`wslrelay`/`wslhost` columns are where it would show: those are Windows processes, so a relay
that survives its `wsl.exe` is counted, while a stranded Linux `sleep` is not (it expires on
its own after 5 s either way).

Kernel pool is machine-wide and cannot be attributed to this process at all, so it is
printed and never judged. It is there because a pool that climbs across the run alongside a
flat private-bytes column is the signature worth chasing by hand.

### Reading the table

Every run prints the full table to stdout — pass, fail, or an abort mid-run (a hung session,
a spawn failure, a Win32 sampling failure): the measuring phase runs under `catch_unwind`, so
the table and the CSV are written first and the original panic is re-raised afterwards. The
same rows go to CSV when `MAST_SOAK_CSV` is set. The `phase` column says what each row is:

- `warmup_settle` — polling after the warm-up cycles, waiting for the counters to stop moving.
- `baseline` — the last `warmup_settle` row, relabelled. **This is the reference.**
- `cycle` — one sample every `MAST_SOAK_SAMPLE_EVERY` measured cycles. These show the trend;
  they are never judged, because a cycle sample is taken mid-flight and is expected to bounce.
- `final_settle` — the same polling after the last cycle.
- `final` — the last `final_settle` row, relabelled. **This is what is compared.**

Settling polls every 500 ms. The warm-up settle stops as soon as two consecutive samples agree
on all judged counters. The final settle needs more than agreement: it stops early only when the
sample is *also* back inside the pass rule below, because a counter that is elevated and simply
not moving yet — a helper process that is still on its way out — satisfies "two samples agree"
just as well as a recovered one, and the process counts have no slack. Either way the poll ends
at `MAST_SOAK_SETTLE_SECS`, and the last sample is then judged as it stands; a real leak still
fails there, and a straggler has had the whole window to leave.

The baseline is settled too, not taken the instant warm-up ends. A baseline captured while the
last warm-up cycle's threads are still winding down is inflated, and an inflated baseline hides
the leak the test exists to find.

### Pass/fail

Comparing `final` against `baseline`:

- `handles` ≤ baseline + `MAST_SOAK_HANDLE_SLACK` (16)
- `threads` ≤ baseline + `MAST_SOAK_THREAD_SLACK` (4)
- `private_bytes` ≤ baseline + `MAST_SOAK_PRIVATE_SLACK_MB` (32) MB
- each of the five process counts ≤ baseline — **no slack**; a leftover conhost or WSL relay
  is the defect, not noise

Any violation panics with one sentence per counter naming the baseline, the final value and
how far it overshot. The point of the slack is that the runtime itself allocates lazily; the
point of it being small is that a leak of 500 cycles is not 16 handles.

### Tuning

| Variable | Default | Meaning |
|---|---|---|
| `MAST_SOAK_CYCLES` | 500 | measured cycles after warm-up |
| `MAST_SOAK_MODE` | `wsl` | `wsl` (real `wsl.exe` path) or `cmd` (ConPTY only) |
| `MAST_SOAK_WARMUP` | 10 | unmeasured cycles before the baseline is taken |
| `MAST_SOAK_SAMPLE_EVERY` | 25 | one `cycle` row every N cycles |
| `MAST_SOAK_SETTLE_SECS` | 30 | cap on each settle poll |
| `MAST_SOAK_CSV` | unset | CSV path; without it, stdout only |
| `MAST_SOAK_HANDLE_SLACK` | 16 | handle allowance |
| `MAST_SOAK_THREAD_SLACK` | 4 | thread allowance |
| `MAST_SOAK_PRIVATE_SLACK_MB` | 32 | private-bytes allowance, MB |

A malformed value fails the test immediately rather than falling back to the default — a soak
that quietly ran a different configuration cannot be read afterwards.

`wsl` mode uses the default distro (no `-d`), unlike the app, which honours `MAST_DISTRO`.
Nothing in the test depends on which distro answers.

This is also the instrument for the open "`portable-pty`/ConPTY shutdown path has never been
audited" item: run it, then check the handle and process columns against a Process Explorer
handle listing of the test process for the shutdown paths (normal exit, explicit kill, rapid
respawn) that the three cycle patterns cover.

## 14. Changes viewer verification (ADR-0021 / ADR-0022)

Status: **Windows + WSL field verification pending**. Automated Linux Git/process tests and
Windows target compilation are separate evidence; they do not mark this checklist complete.
Use a disposable repository and a copy of the state directory for downgrade checks.

1. Open the pane-header **New changes viewer tab** button in a normal workspace and in a
   bare worktree container. The toolbar must show the resolved worktree top level; the
   persisted tab path must still be the supplied workspace root. A bare default branch
   with no checkout must show an explicit error instead of choosing another branch.
2. Prepare staged and unstaged changes to the same file, a rename, a deletion, and an
   untracked file. Verify Working / Staged / All baselines and source/destination rename
   names. Verify a repository with no commits and a real unresolved merge conflict.
3. Include `-oops.txt`, `:(glob)*`, spaces, Korean, quotes and newline characters in file
   names. Each selection must read only its own patch. A binary file must show Git's
   binary summary. File contents that contain HTML must display as text.
4. Hold `.git/index.lock` in the adjacent pane and leave it intact. Refresh and file
   selection must still work. In the disposable repository, configure external diff,
   textconv and fsmonitor helpers with visible markers; none should run for the viewer.
5. Select a diff larger than 512 KiB and prepare more than 5,000 changes. Check the
   truncation messages. Trigger an inaccessible repository and a failed query; the pane
   must leave loading state and offer Refresh. Simulate an unresponsive Git command in a
   disposable test distro: within the query capture deadline the pane must show an error
   and dispatch must remain responsive. Check the Windows relay is reaped, then separately
   observe Linux cleanup through its TERM + KILL deadline (at most 10 seconds from the
   Linux supervisor's start). WSL startup is outside that inner timer; neither timeout nor
   output-cap responses promise that Linux cleanup has already finished.
6. Rapidly select different files, change scopes, refresh, switch tabs, close the viewer,
   and switch workspaces while queries run. Stale patches must not replace the current
   selection; inactive views must retain no DOM or polling. Returning to the tab must read
   a fresh list. Test font settings and viewer zoom, narrow panes, copy, and keyboard focus.
7. Save a state containing Changes and terminal tabs in multiple panes/workspaces. Load a
   copy with the **compatibility-only** build: only the unknown tabs disappear; workspaces,
   split layout and terminal cwd survive. Load the original copy with the Changes build:
   all tabs survive. Confirm per-tab removal diagnostics in the compatibility build.
8. The phone list must label the tab `changes` without opening it. Existing terminals,
   Markdown/text/folder viewers, shortcuts, and agent state notifications must still work.
9. Select a text patch with unequal replacement blocks and multiple hunks. Deleted code is
   red in Before; added code is green in After; following context aligns. Check Working,
   Staged, All, and an unborn/untracked file against the displayed baseline labels.
10. Keep the window wide and resize only this pane across 959/960 CSS px: Before/After must
    switch from stacked to side-by-side. Long lines scroll within each side, not the entire
    workspace. The changed-file list stays usable, viewer font/zoom still works, and no new
    Git query starts merely because the pane was resized.
11. Combined merge output and binary/rename-only changes retain their original metadata;
    they must not present a made-up two-sided merge result. A byte-truncated or more-than-
    5,000-line patch must show the relevant notice and remain bounded. HTML-looking code
    must never become HTML elements in either layout.

Release the ADR-0021 compatibility build before the Changes build. Releases without that
repair still discard a state containing a new tab kind; do not use live state to test them.

## 15. Startup update notice (v0.3.31 / ADR-0024)

The native WinHTTP GitHub probe passed on Windows on 2026-09-13. The following GUI
checks remain pending; compilation and automated tests do not replace field verification.

1. Start mast online. The sidebar footer must show the installed version without delaying
   terminal startup. A strictly newer stable release adds **Update available**; clicking
   it opens the GitHub release page in the default browser without downloading or restarting.
2. Start offline or with GitHub blocked. Terminals must remain usable, the installed version
   must stay visible, and no update popup or claim of being up to date may appear.
3. Switch workspaces and reload the WebView. The footer must survive card reconciliation
   and read the process cache without issuing another network check. A full app restart
   permits one new check.

## 16. OpenCode default TUI integration (setup v16 / ADR-0027)

These field checks are pending. Linux automated gates test the generated plugin and
shell wrapper, but do not verify a live Windows mast tab or a PC restart.

1. Launch mast after the setup v16 change in a distro with OpenCode 1.18.31. Confirm
   `~/.mast/.setup-v16`, exactly one global `mast.js` under the effective
   `$XDG_CONFIG_HOME/opencode/plugins/` (default `~/.config/opencode/plugins/`), and a
   new OpenCode process started after provisioning. Check `~/.mast/setup.log` for
   conflicts. A pre-existing `mast.js` must remain byte-for-byte unchanged.
2. In two mast tabs, start the default OpenCode TUI in one. Ask it to work, request a
   permission, use a question prompt, answer both, and let the root session finish.
   Confirm the owning tab moves through running, needs input with a toast, and idle;
   the other tab must not receive these statuses. Check for damaged TUI frames.
3. Start a fresh root session and, before its first turn finishes, confirm
   `~/.mast/resume/tab-$MAST_TAB` contains `opencode --session <root-id>` and an epoch
   line. Run a task subagent and confirm its child id never replaces the root id.
4. Restart mast while the root turn is still running, then repeat after a PC reboot.
   The restored tab must offer a dim resume line. One Up arrow must recall the exact
   `opencode --session <root-id>` command without running it; Enter must resume the
   session. A tab that never ran an agent must have no new hint.
5. Change the tab's cwd after the OpenCode session was created, restart, and try the
   same command. Record whether OpenCode finds the session across cwd boundaries;
   failure here is an unresolved R2 limitation and must not be called a pass.
6. Edit the managed plugin, rerun provisioning with a new setup marker, and confirm
   the edited bytes remain untouched with a conflict in the setup log. Restore a
   matching managed version and confirm a later setup update can replace it.
