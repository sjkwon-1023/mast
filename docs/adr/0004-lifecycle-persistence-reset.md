# ADR-0004: Stages 13–16 — sidebar, lifecycle, persistence, automatic reset

- Status: accepted
- Date: 2026-08-09

## Context

Stages 13 (workspace sidebar), 14 (teardown polish + switch latency), 15 (persistence)
and 16 (automatic UI reset) of 계획 v2 section 17, verified on Windows as **checkpoint 1**
(all items passing 2026-08-09 after two field-fix rounds). Several decisions here were
*corrected by field evidence* — recorded below because the corrections are the lasting
knowledge.

## Decisions

1. **Sidebar & workspace lifecycle (13).** Status cards + switch/close/create;
   `CreateWorkspace` grew `tab: Option<NewTab>` (atomic spawn-first, same discipline as
   `SplitPane{tab}`), making boot a single dispatch. Workspace switching reuses the
   stage-12 reconcile rule — leaving disposes views (detach → replay-only), returning
   lazy-attaches. Measured switch latency: 70ms for a 4-pane workspace (target: 100ms
   class); ~236ms with a 1MiB replay buffer (known perf item, visible flicker).
2. **Replay snapshots trim to a line boundary after eviction (14)** (4KB scan cap; TUI
   frames without newlines stay untrimmed and rely on the SIGWINCH nudge). A pure
   `SwitchTracer` reports switch timing to `window.__mast.lastSwitch`.
3. **Persistence (15).** `state.json` (`%APPDATA%/app.mast.desktop/`) holds a
   versioned camelCase envelope of `AppState`. Load validates structure (including
   global stable-id uniqueness and split-ratio ranges — disk is a trust boundary),
   sanitizes (`pty_session` always cleared; `next_id` repaired incl. split ids), backs
   up corrupt files loudly, and sweeps stale tmp files. Saves are debounced (500ms
   coalesce), written atomically (same-dir tmp + rename), flushed on exit. **Boot is
   manage-first**: adopt the restored state without spawning, manage, then respawn
   Running terminal tabs one-by-one through the dispatcher — no window where a dying
   shell's exit event can be lost. Scroll positions and live shell cwd are deliberately
   not restored (viewers don't exist yet; OSC 7 tracking is stage 18).
4. **Automatic reset (16).** Pure `ResetPolicy` (u64 ticks) + glue supervisor with
   `MAST_RESET_*` env knobs. Reset is a **glue command** (`reset_ui`, dev-hook/MCP
   only) — a deliberate deviation from 계획 v2 section 12's "command dispatcher 내부
   커맨드" wording: the core bus is structural mutations only (ADR-0002) and reset
   mutates nothing, while the reload itself needs Tauri. The idle trigger fires once
   then disarms; the mem watchdog only schedules and fires at safe moments; a shared
   cooldown suppresses loudly.
5. **Activity is real gestures only.** Field-corrected twice: (a) stdin writes are NOT
   activity — xterm auto-answers terminal queries preserved in replays, which re-armed
   idle in a reset→replay→answer loop under TUI workloads; (b) visibility sync reports
   are NOT activity — the reload's visible=true sync re-armed idle (repeating ~30s
   resets) and minimize's visible=false sync re-armed hidden's own countdown (never
   firing). Real typing/scrolling reaches the policy via the throttled frontend gesture
   ping (wheel/mousedown/keydown).
6. **Hidden trigger is the plan's original OR** (unfocused OR invisible), after field
   evidence eliminated the alternatives: on minimize the WebView2 visibility signal
   never arrives (wry appears not to update `IsVisible`), so AND and visibility-only
   both never fired. Either signal counts; full show (focused && visible) or real input
   ends the stretch.

## ConPTY field findings (the checkpoint's hard-won knowledge)

- **ConPTY never EOFs the output pipe when the child exits** — conhost holds it until
  `ClosePseudoConsole`. Exit detection therefore needs a dedicated waiter thread
  (`child.wait()` → mark dead → drop writer/master to unblock the reader → single
  `on_exit`). This also fixed the latent "paused session never reports exit" case.
- **ConPTY injects cursor probes (`ESC[6n`) into the output stream**, which land in
  replay buffers. xterm auto-answers them (CPR `ESC[..R`): answering a *replayed* probe
  leaks a stray `R` into the shell's input line (once per re-attach), while *not*
  answering a fresh probe stalls conhost — a restored session's replay is exactly the
  4-byte probe and the shell hangs until a CPR arrives. Resolution: attach responses
  carry a **first-attach flag** (`[u64 end_offset][u8 first_attach][replay]`); the
  first attach answers replay queries live, re-attaches suppress `onData` until the
  replay finishes parsing.

## Verification

Checkpoint 1 (WINDOWS-BUILD.md sections 8–9) fully passed on Windows: restore across
restart and force-kill, corrupt-state isolation, switch latency, idle/hidden/watchdog
firing semantics (single fire, gesture re-arm, safe-moment watchdog), replay boundary
cleanliness, plus the earlier stage-13 sidebar items. One reported failure was operator
error: each pane header splits **its own** pane (by design, confirmed by click logs).

## Follow-ups

- UX: per-pane split buttons confused a first-time user who expected "split the
  selected pane" — revisit affordance (e.g. icons only on the active/hovered pane)
  during UI polish; the `#id` pane-header label added for diagnostics turned out to be
  useful and stays for now.
- Perf: 1MiB-replay workspace switch is ~236ms with visible flicker (xterm parse cost)
  — candidate fixes: smaller replay cap, progressive replay, or hide-until-parsed.
- Diagnostics left in place (activity-source/focus/visible stderr logs, rebuild-order
  console log) — cheap, and field debugging has paid for them twice; revisit noise
  before any public release.
- Snapshot coalescing before stage 18 (carried from ADR-0002/0003).
