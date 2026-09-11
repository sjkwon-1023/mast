# ADR-0001: Adopt Tauri v2 + single WebView2 + xterm.js terminal stack (candidate A)

- Status: accepted
- Date: 2026-08-08

## Context

`터미널-계획-v2.md` section 2 defines two candidate stacks: **A** — Tauri v2 + a single
WebView2 + xterm.js, with a Rust backend driving ConPTY → `wsl.exe` (default path), and
**B** — `alacritty_terminal` + a custom thin native renderer, to be entered only if A
sustainedly exceeds the 150MB private-working-set ceiling. The spike app (`apps/spike`)
was built to decide this. Verification ran on Windows 11 x64 on 2026-08-08, following the
checklist in `docs/plans/spike-plan.md` section 6, with `scripts/win/measure.ps1` as the
measurement tool (private working set, WebView2 process tree included).

## Decision

**Adopt candidate A.** Candidate B stays shelved unless a future regression pushes
sustained 4-pane usage above 150MB.

## Evidence

RAM (private working set, WebView2 tree included, release build):

| scenario                  | avg RAM  | range         |
|---------------------------|---------:|--------------:|
| app only                  |  81.93MB | 81.77–82.54   |
| 1 terminal                |  90.70MB | 90.40–90.97   |
| 4 terminals               | **113.33MB** | 113.17–114.04 |
| 8 terminals               | 124.31MB | 124.22–124.38 |
| 4 + Claude 1 + Codex 1    | 113.65MB | 112.95–118.80 |

4-pane average of 113.33MB lands in the plan's 100–150MB "adopt" band, and even 8 panes
stay comfortably under the 150MB ceiling. The mixed-agent scenario measures the Windows
app/WebView2 tree only; WSL-side agent memory lands in `vmmemWSL` and is excluded from
the app budget by definition (계획 v2 section 1).

Functional results:

- **OSC 7/9/777 passthrough — pass**, including the chunk-split case. The plan's single
  point of failure (ConPTY swallowing OSC) did not materialize; the file/socket fallback
  path is not needed.
- Input, Korean IME, resize, replay (raw `Response` path), Claude Code, Codex — pass.
- Flood on both DOM and WebGL renderers — backpressure engaged and recovered normally.
- Teardown: after app exit, all 27 tracked processes exited; 0 orphans.

## Known issues (recorded at adoption, do not block the decision)

- **Paste is broken in two ways**: `Ctrl+V` is a no-op, and context-menu paste leaks a
  literal `^[[200~` (bracketed-paste marker) into the input line. First MVP work item.
  Suspects: WebView2 accelerator/clipboard-permission handling for the former; bracketed
  paste mode tracking across the ConPTY input path for the latter. Root cause TBD.
  - **Resolved (2026-08-08, commits `9d48f5a`/`c27b95f`)**: the actual root cause of the
    no-op was xterm mapping Ctrl+V to `\x16`. Paste now goes through a single
    clipboard → `term.paste()` path, and copy follows the Windows Terminal convention
    (Ctrl+C copies when a selection exists, otherwise sends SIGINT). Verified on Windows.

## Follow-ups carried from the spike

- Redesign `mast-core::SessionManager` to pre-assign session ids (sink factory receives
  the id), then delete the duplicate glue-side `Registry` and the dead `PtySession::id`.
- OSC scanner: CAN/SUB abort is implemented; review remaining C0 handling against real
  terminal behavior.
- Replay buffer chunk eviction can cut an escape sequence mid-way — revisit before the
  MVP workspace teardown/rebuild feature relies on replay.

## Consequences

- MVP development proceeds on this stack (계획 v2 section 17, stages 10–21).
- The spike's memory guardrails remain mandatory in the MVP: flow control with PTY-read
  pause, single WebView, raw-binary output channel, scrollback cap, inactive-render
  suppression, workspace teardown + replay rebuild.
