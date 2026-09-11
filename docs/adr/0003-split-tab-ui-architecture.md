# ADR-0003: Stage 11–12 — split addressing, keep-alive tabs, self-healing detach

- Status: accepted
- Date: 2026-08-09

## Context

Stages 11 (pane splits + splitter resize) and 12 (in-pane tabs) of 계획 v2 section 17,
built on the ADR-0002 architecture. The execution plan went through the same
draft/adversarial-critique cycle as stage 10; implementation landed in four chunks with
per-chunk review. ADR-0002 forecast stages 11–13 as "pure UI wiring" — that was a
deliberate under-forecast: the stage needed real core-contract growth (recorded here).

## Decisions

1. **Split nodes carry stable ids.** `SplitTree::Split { id: SplitId(u64), .. }`, issued
   from the same single `AppState` counter as the other stable ids. Path indexing was
   rejected because a path re-resolves to a *different* node after tree mutations —
   silent misdirection that can't fail loudly. `ResizeSplit { split, ratio }` validates
   ratio on the open interval (finite, 0 < r < 1 → `InvalidRatio`); pixel clamping is
   the UI's job.
2. **Split creation is atomic.** `SplitPane { pane, direction, tab: Option<NewTab> }`
   spawns first, then mutates the tree — a failed spawn leaves everything (tree, panes,
   next_id, revision) untouched, and no intermediate empty-pane snapshot is ever
   rendered. `PaneCreated { pane, split, tab, session }` returns every created id
   (dev-hook/MCP contract). A two-dispatch composition was rejected for violating the
   codebase's own atomicity discipline.
3. **CloseTab auto-collapses an emptied pane** (shared collapse helper with `ClosePane`,
   including active-pane fixup), except for the workspace's last pane, which stays as an
   empty-pane placeholder. This is the only mouse path for closing a pane — the pane
   header deliberately has no close button (계획 v2 section 6). Empty panes can still be
   created via `SplitPane { tab: None }` (dev-hook/MCP-only path).
4. **Inactive terminal tabs are keep-alive.** Tab switching toggles `display` on
   registry-owned views; hidden views keep their channel and keep acking. Verified
   against xterm sources during review: the write/ack pipeline is a setTimeout parse
   loop independent of visibility, and rendering alone is paused via
   IntersectionObserver with a full refresh on re-show — "stop rendering only"
   (계획 v2 section 12) comes for free. Memory grows per *tab* (scrollback 5000 each);
   accepted explicitly, backstopped by the WebView reset safety net.
5. **Detach is self-healing.** `detach_terminal` = clear the channel slot **and**
   `PtySession::reset_flow()` — a detached session can never stay parked in `paused`
   (an already-paused reader never reaches the Dropped-rollback path, so the flow reset
   must happen at detach time). The frontend sweeps `detach_terminal` over every
   unattached session on the attached→unattached transition and at boot — this closed
   the post-reload unvisited-tab freeze found in review.
6. **Snapshot-driven rendering with guards.** Same `structureKey` → in-place ratio
   updates (skipping drag-active splits so snapshots can't stomp the local preview);
   structural changes rebuild containers keyed by `SplitId` while reparenting pane
   elements (keep-alive views move with them). A drag interrupted by a structural change
   is deliberately abandoned (preview snaps back, no command).
7. **Focus is compensated, never implicit.** attach() no longer auto-focuses (N
   concurrent attaches after reload raced for focus). A single pending FocusRequest
   (`tab` / `pane` / `activePane`) with a renders-left budget survives the
   invoke-response-vs-snapshot race, and close commands request `activePane` focus so
   keyboard input never drops to the body. Tab-strip DOM rebuilds are skipped when the
   tab model is unchanged — a mid-click rebuild used to swallow the click on an inactive
   pane's tab.
8. **WebView reload is Ctrl+Shift+R** (+ `window.__mast.reload()`), never F5 — with the
   terminal focused, xterm correctly delivers F5 to the shell as `ESC[15~` (TUI apps
   use it). This is also the manual verification path for the reset safety net until the
   automatic triggers land (계획 v2 section 12, stage 16).

## Verification

- Automated gates green throughout: core 94 tests (incl. new resize/atomic-split/
  collapse/reset_flow coverage), mast frontend 73 vitest tests, spike 24 (regression),
  workspace clippy/check for the Windows target.
- **Windows manual checklists passed 2026-08-09** (WINDOWS-BUILD.md sections 6 and 7):
  splits/nesting, ratio reload survival, keep-alive tab switching without replay flash,
  hidden and unvisited-tab free running (`paused: false`), last-tab collapse and
  placeholder, 2×2 reload with TUI redraw, error surfacing, id stability. One finding
  during verification — F5 typed `~` instead of reloading — led to decision 8.

## Follow-ups

- Snapshot coalescing/throttling before stage 18 (carried from ADR-0002).
- Replay escape-cut fix before stage 14 relies on replay for workspace teardown/rebuild
  (carried from ADR-0001).
- Workspace switching already tears down/rebuilds views via the reconcile rule ("alive
  views ⊆ active workspace's tabs") — stage 14's remaining work is switch-latency
  measurement and the automatic reset triggers, stage 13 adds the sidebar UI that makes
  multi-workspace reachable by mouse.
