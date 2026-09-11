# ADR-0006: Stage 18 — OSC notification routing, snapshot coalescing, keyed reconcile

- Status: accepted
- Date: 2026-08-10 (stage landed 2026-08-09)

## Context

Stage 18 of 계획 v2 section 17 turns section 9's three-tier notification surface (tab
unread dot → pane badge → workspace sidebar) on with real data, and pays the debt ADR-0002
decision 1 recorded: snapshot-per-mutation had to become snapshot-per-*burst* **before**
high-frequency OSC fields started mutating. The plan went through the drafter/critic cycle
(`docs/plans/mvp-stage18-plan.md`, distilled here) and landed in three commits. Windows
toast notifications were left out (dependency and ARM64 verification are a stage of their
own); the flush point is the natural hook when they come.

## Decisions

1. **Coalescing is a per-session merge cell, not a queue.** `mast-core::notify`'s
   `OscBatch`/`OscDelta` keep last-wins title/cwd/status, last-non-empty message (500-char
   cap) and sticky unread per session, so memory is bounded by the *session count*
   regardless of OSC volume — a flood cannot grow the batch. Within a window, cross-session
   application order is session-id order; that is acceptable because the needsInput
   priority rule (decision 4) makes the load-bearing case order-independent.
2. **The hot path never takes the dispatcher lock.** `OscRouter::push` (glue) does
   merge + notify under the pending lock only. Its worker runs a predicate condvar loop,
   waits out a **100ms trailing window** (`MAST_OSC_FLUSH_MS`, following the
   `MAST_RESET_*` knob convention) so a burst coalesces, takes the batch *after*
   releasing the pending lock, then takes the dispatcher lock and applies. The two locks
   are never held together, which makes deadlock impossible by construction rather than by
   review. `Drop` mirrors the Saver's close-notify-join discipline, and `flush_now()` runs
   on `RunEvent::Exit` **before** the Saver flush so the last cwd/status is persisted.
3. **`mast:<status>` is the token contract; everything else is status-neutral.** OSC 777
   `notify;title;body` whose title is `mast:running` | `mast:needsInput` |
   `mast:idle` sets `Workspace.agent_status`; a token mismatch or an OSC 9 sets **unread
   and message only** and never asserts a status — OSC 9 is ConEmu progress reporting in
   other tools, and a foreign tool must not be able to claim an agent state. `running`
   raises no unread (it is progress, not a call for attention). OSC 0 — with `"2"` accepted
   as an alias against ConPTY re-encoding — sets the tab title; OSC 7 `file://host/path`
   sets the tab's cwd (percent-decoded), which is what respawn reads. The canonical
   emitter-side contract is `scripts/wsl/claude-hook-example.md`.
4. **needsInput has priority, and only its source can demote it.** `Workspace` gained
   `agent_status_source: Option<TabId>` (`skip_serializing_if` — golden fixtures unchanged)
   recording which tab raised the status. While a workspace sits at `needsInput`, another
   tab's `running` cannot overwrite it. Section 9's promise is that a glance at the sidebar
   shows something is waiting for input; a busy sibling tab must not hide it. Demotion
   happens naturally when the same tab's next `UserPromptSubmit` fires `running`. A shared
   reset helper clears status and source from all three exit routes (`CloseTab`,
   `ClosePane`, `SessionExited`) — the critic's finding was that any one of them left alone
   strands the sidebar.
5. **A batch is skipped wholesale for an exited tab.** A session can exit inside the 100ms
   window; `SessionExited` is processed immediately and resets to Idle, so a delayed batch
   would re-stamp `needsInput` on a dead tab.
6. **Visibility equals read, and suppression is half of it.** Unread is suppressed at apply
   time for the visible tab (active workspace, that pane's active tab) and cleared on
   `ActivateTab`, on `SwitchWorkspace`, and on the promotion that follows closing a pane's
   active tab. Suppression and clearing are a mandatory pair — an already-active tab never
   fires another activation event, so without apply-time suppression its dot would be
   unclearable. Deliberately **not** coupled to window focus (v1): the active tab's content
   is on screen regardless, and an away user still has the sidebar's `agent_status`.
7. **Restart clears notification state.** `persist` sanitize unconditionally resets
   `agent_status`, `agent_status_source`, `last_agent_message`, every tab's `notification`
   and `last_activity_ms` on load — the same class of guarantee as clearing `pty_session`:
   a dead session's "needs input" must not survive a restart (계획 v2 section 11).
8. **The frontend reconciles by key, in place.** ADR-0003 decision 7's `JSON.stringify`
   skip-guard dies the instant status and message become dynamic, and its failure mode is
   the mid-click swallow. Sidebar cards and tab-strip entries now patch by id (text and
   class only) and rebuild only on membership or order change, with the verdict split out
   as pure functions (`reconcilePlan`, `tabStripPlan`). Preview and dot nodes always exist
   and toggle via `hidden`, so patching never reshapes a card's children; click handlers
   read the live patched model instead of stale closures.
9. **Node-identity tests, because verdict tests cannot see the bug.** A pure verdict test
   cannot catch "the element under the pointer was replaced" — the actual d7 failure. A
   `happy-dom` devDependency lets the suites assert that the *same* DOM object survives a
   patch and that a membership change really does rebuild.
10. **The core commit shipped a known-broken window on purpose.** Between chunk A (routing)
    and chunk B (keyed reconcile) the dynamic fields defeat the old stringify guard, so the
    d7 regression is live. The two were committed separately for reviewability, with manual
    verification explicitly parked until B landed.

## Verification

Checkpoint 2 (`docs/WINDOWS-BUILD.md` §10, stage-18 items 1–8) passed on Windows
2026-08-09: synthetic OSC 777/9 routing across all three tiers including visible-tab
suppression, the real Claude Code hook triple (running / needsInput with preview / idle),
needsInput priority across tabs, clicking a tab while its title updates on a fast loop (the
d7 guard), an OSC flood leaving the UI responsive and the Saver cadence and RAM undisturbed,
`needsInput` tab closure through both `CloseTab` and `ClosePane`, and restart sanitize.
**The conditional item held**: ConPTY does pass OSC 7 through, so cwd restore across
restart works and the section 2 file/socket fallback stays unnecessary. Automated: core
tests over the merge cell, `apply_osc` rules and sanitize, plus the pure verdict and
identity suites on the frontend.

**Field defect (fixed 2026-08-09, re-verified 2026-08-10).** Claude Code 2.1.226 runs hooks
without a controlling TTY — `/dev/tty` returned ENXIO and notifications never reached the
terminal. The canonical hook now resolves its tty in two steps: `/dev/tty` first, then a
depth-8 walk up the ancestor process chain for a `/dev/pts/*` fd. Delivery failure exits 0
so a lost notification never kills the hook, while a missing status argument still fails
loud.

## Follow-ups

- Windows toast notifications hang off the flush point (excluded here on scope).
- Accepted without change at review time, recorded so they are not re-litigated: the
  exit-time flush ordering race (a microsecond window with 100ms of OSC at stake), the
  `Drop` join being unreachable behind the managed-state `Arc` cycle (same nature as the
  Saver), and `apply_osc`'s "nothing changed" path being narrow because activity stamping
  usually changes something.
