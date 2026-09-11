# ADR-0002: Stage-10 architecture — Rust-owned state, snapshot sync, attach protocol

- Status: accepted
- Date: 2026-08-08

## Context

Stage 10 of the product plan (터미널-계획-v2.md section 17: data model + command
dispatcher + stable IDs) is the architecture-defining step of the MVP. The execution
plan (`docs/plans/mvp-stage10-plan.md`) went through an adversarial draft/critique
round before implementation; chunks A–C landed with per-chunk review. This ADR distills
the decisions that outlive the plan file.

## Decisions

1. **All persistent state lives in Rust.** `mast-core::model::AppState` (workspaces,
   split trees, panes, tabs) is owned by `mast-core::command::Dispatcher`; the WebView
   is a disposable view (the premise of 계획 v2 section 12's WebView reset safety net).
   Frontend sync is deliberately simple: every successful mutation emits a
   `state-changed` event carrying the **full snapshot** with a monotonically increasing
   `revision`; the frontend bootstraps via `get_state` and discards stale revisions.
   *Known cliff*: once high-frequency fields start mutating (stage 18 wires
   `agent_status`/`last_activity` from OSC), snapshot-per-mutation becomes
   snapshot-per-output-burst — coalescing/throttling (or field deltas) must be designed
   **before** stage 18 lands.

2. **A single serializable Command bus.** All structural mutations go through
   `Command` (`#[serde(tag = "type", rename_all = "camelCase")]`) →
   `Dispatcher::dispatch`. PTY side effects are isolated behind the `SessionHost` port,
   which keeps the dispatcher fully testable without PTY/Tauri and gives the v2
   management agent (MCP) its exposure surface for free. The response surface
   (`CommandOutput`/`CommandError`) is part of the contract and locked by fixtures.

3. **Stable IDs.** `WorkspaceId`/`PaneId`/`TabId` are u64 newtypes issued from a single
   `AppState` counter — globally unique, persistence-ready (stage 15), and
   type-distinct from the volatile PTY `SessionId` (u32). A terminal tab holds
   `pty_session: Option<SessionId>` precisely because the two lifetimes differ.

4. **Attach/detach protocol** (the stage-10 embodiment of "the WebView can reload
   without losing sessions"):
   - Output channel frames are `[u64 LE offset][bytes]`; `offset` is the cumulative
     stream offset maintained by the core reader.
   - `attach_terminal` mounts the channel into the sink slot **first**, then calls
     `PtySession::reattach()` (atomic flow reset + replay snapshot + end offset) and
     returns `[u64 LE end_offset][replay]`. The frontend queues chunks until the
     snapshot applies, discards `offset < end_offset` (dedup), and **acks everything it
     received, discarded or not** — flow accounting stays exact.
   - View dispose calls `detach_terminal` to clear the channel slot: subsequent output
     takes the Dropped path (compensating flow rollback), so background sessions run
     free with replay-only recording instead of freezing at the high-water mark.
   - After attach the frontend always sends a two-step resize nudge (rows−1 → rows) to
     force SIGWINCH — on reload the measured size equals the PTY's current size, so a
     same-size resize would be a silent no-op.
   - Stage-10 acceptance for reload is *session survival + text preservation*;
     TUI-faithful redraw is the stage-14 bar (replay escape-cut fix carried from
     ADR-0001 is due there).

5. **`apps/mast` is a new app; `apps/spike` is frozen** as the ADR-0001 measurement
   harness (feature-frozen, kept compiling). Reused from spike: the glue discipline
   (spawn_blocking, lock scoping), the ack batcher, and the Windows-verified copy/paste
   key handling.

6. Smaller contract decisions: serde joined `mast-core` (pinned ≥ 1.0.186);
   `git_branch`/`git_dirty` fields are pre-declared on `Workspace` (filled at stage 19)
   for type-space stability; empty panes are allowed until stage 12 introduces collapse
   rules; `SplitPane`/`ClosePane`/`CloseWorkspace` are implemented at the model level so
   stages 11–13 are pure UI wiring; `ShellSpawnReq.cwd` is a Linux path mapped to
   `wsl.exe --cd` (never the Windows process cwd).

## Verification

- Automated gates (all green in-session): core tests (84 incl. unix PTY integration and
  golden-fixture round-trips), workspace clippy/check for `x86_64-pc-windows-msvc`
  (glue compile gate via userspace `llvm-rc`), both frontends' `tsc`+`vite`+`vitest`
  (43 mast + 24 spike). Shared golden fixtures under `fixtures/` lock the JSON contract
  on both the Rust and TS sides.
- **Windows manual checklist pending**: `docs/WINDOWS-BUILD.md` section 6 (6 items:
  boot dogfood, reload survival, dev-hook commands, id stability, background-tab
  free-running after detach, `--cd` first real use). Stage 10 closes when it passes.

## Follow-ups

- Snapshot coalescing/throttling design before stage 18 (decision 1).
- Replay escape-cut fix before stage 14 relies on replay for teardown/rebuild
  (carried from ADR-0001).
- `CommandError` currently reaches the frontend as a serialized object only through the
  dev hook; surfacing errors in real UI is part of stages 11–13.
