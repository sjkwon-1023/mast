# ADR-0019 — Restoring a terminal's scroll position across a workspace round-trip

Status: accepted (2026-09-12) · Extends [ADR-0004](0004-lifecycle-persistence-reset.md)'s
dispose-on-leave memory model and [ADR-0015](0015-reassert-terminal-modes-on-reattach.md)'s
re-attach preamble · Verification: WINDOWS-BUILD §10 v0.3.24

## Context

Scrolling up in a Codex tab, switching to another workspace and coming back put the pane back at
the bottom. The backlog carried this as "investigate the reattach path first — the replay
followed by the forced `SIGWINCH` resize nudge", with the nudge as the prime suspect. A probe
run against the user's own `codex-cli 0.153.4` binary and `~/.codex` on the Linux dev box
(120×40, `TERM=xterm-256color`, a resumed 4.9 MB rollout, replayed through `@xterm/headless`
5.5.0) settled three things, and the suspect was not one of them.

**1. Codex's default UI does not use the alternate screen.** In four captures it never sent
`?1049h` and never enabled mouse tracking (`?1000/1002/1003/1006` were absent throughout); the
modes it does set are `?25h/l`, `?1004h`, `?2004h`, `?2026h/l`. `--no-alt-screen` changed
nothing, i.e. 0.153.4 is already inline by default. Answering its startup queries the way mast's
xterm does (CPR, DA1, DA2, DECRQM, OSC 10/11) changed nothing either, so "Codex downgraded
because a query went unanswered" is excluded. A wheel event sent to that UI produced **zero
bytes** of application output: the transcript is printed into the terminal's *normal-buffer
scrollback*, and scrolling it is the terminal's business, not the app's. `?1049h` appears only
in the Ctrl+T transcript overlay.

That is the whole bug. Scroll position in the normal buffer is xterm-side state (`viewportY`
against `baseY`) and appears nowhere in the byte stream. Leaving a workspace disposes the pane's
xterm on purpose (ADR-0004 decision 1 — the memory model, not an oversight), and returning feeds
a **new** instance the replay, which cannot carry a value it never contained. Confirmed
directly: a live terminal at `viewportY=993 / baseY=1008` replayed byte-for-byte into a fresh
instance came up at `viewportY = baseY = 1008`, i.e. the bottom. Removing the nudge did not
change that.

**2. The nudge is not the cause, and in the alternate-screen case it is provably innocent.** In
the Ctrl+T overlay — where the scroll offset *is* application state — the app held its position
across a rows-1 → rows nudge (one 3,980-byte redraw, same top three rows, PageUp still working
afterwards). There was nothing for the nudge to reset in the normal-buffer case, because the
application holds no offset there at all.

**3. The nudge is what rebuilds a Codex tab's scrollback.** On every resize Codex reprints its
entire history: 96,187 bytes, 1,038 lines, preceded by `ESC[3J` + `ESC[2J`. Truncating the
replay and measuring the resulting scrollback shows what that is worth — replay alone gives
lines in proportion to the window (127 KB → 976 lines, 60 KiB → 562, 8 KiB → 33), while **with
the nudge every one of those cases reconstructs to the same 972 lines**. So the backlog's other
item, "attach-time redraw fires even for a session already attached in this WebView lifetime",
proposes to remove exactly the thing that gives a Codex tab its history back. The cost is real
and stays open: the two-step nudge pushes ~192 KB per round-trip into a 1 MiB replay buffer.

All of the above is Linux-pty measurement. The Windows ConPTY + `wsl.exe` relay path was not
measured; frame sizes and timing may differ there, though the mode set is chosen by the
application and should not. One observation is also **in conflict with what this repo already
records**: ADR-0016 and CLAUDE.md state that Codex 0.153.x runs on the alternate screen with SGR
mouse tracking, read off a live tab. That did not reproduce here on the same binary and the same
`~/.codex`. The likely explanations are that the earlier bytes came from a Claude Code tab or
from a different build; field confirmation is requested as part of the verification below.

## Decisions

1. **The front end remembers the position; nothing is added to the byte stream or the model.**
   The value is `baseY - viewportY`, the number of lines above the bottom, captured from the
   xterm instance just before it is disposed and applied to its replacement. There is no other
   place it could come from: the core never sees it (unlike the terminal modes of ADR-0015,
   which *are* in the stream), and putting it in `AppState` would mean a command per scroll on a
   value that is meaningless across a relaunch.

   Keeping the inactive workspace's renderer alive instead — the obvious alternative — is ruled
   out by the product non-goals ("Keeping every workspace's xterm/renderer alive just to
   preserve visual state") and by ADR-0004's memory model.

2. **The coordinate is measured from the bottom, and a position that no longer exists is
   refused rather than clamped.** The nudge makes Codex reprint its whole history, which replaces
   the scrollback wholesale; a line number means nothing afterwards, while "fifteen lines above
   the bottom" points at the same place in the reprinted history.

   When the scrollback is shorter than the offset, `restoreTargetLine` returns null and the view
   calls `scrollToBottom()` instead of scrolling to line 0. Clamping was the first draft and it
   is a trap: `scrollToLine` latches xterm's `isUserScrolling`, so a pane parked at line 0 stops
   following its own output — measured on `@xterm/headless` 5.5.0, a clamped restore left
   `viewportY` at 0 while 2,000 further lines arrived, i.e. a frozen pane instead of a mildly
   wrong one. `scrollToBottom()` is the only call that releases that latch, and the bottom is
   exactly where the tab would have landed before this change, so a tab whose position cannot be
   restored behaves precisely as it used to. `baseY === offset` is a real line 0 and is still
   honoured. The paths that reach the refusal are a truncated replay that never reprints (a plain
   shell tab) and `ensureView`'s respawn branch, which can hand a fresh shell an offset
   remembered from the session it replaced.

   **Releasing the latch is harder than setting it, and the browser build differs from the
   headless one.** `Terminal.scrollToBottom()` is `scrollLines(ybase - ydisp)` at source USER,
   and in the browser build that call is routed to `Viewport.scrollLines(e)`, which returns
   immediately when `e === 0` — so it never reaches `BufferService.scrollLines`, the only place
   that clears `isUserScrolling` (on `e + ydisp >= ybase`). At the `ESC[3J` moment of a reprint
   `ybase === ydisp === 0`, so the release we ask for there is a no-op and a latch set a moment
   earlier survives it; a cancel landing in that window left the pane frozen at the top through
   2,000 further lines. The headless build has no viewport, takes the buffer-service path, and
   clears the latch — which is why the first round's probes did not see this and a peer review
   against the real browser build did. The view therefore tracks whether it may have latched
   (`scrollToLine` to a target below `baseY`) and, when a release is asked for while `baseY` is
   0, **defers it to the next parsed chunk** — the moment `ybase` leaves 0 is the first moment a
   release actually works. That deferred release runs independently of whether a restore is
   still pending, because the latch is ours to undo whether or not we still want the position.

3. **The memory lives in `WorkspaceView` for the lifetime of the WebView, keyed by tab.** It is
   written in the `render()` dispose loop and only when the tab is still present in the snapshot
   — a tab that vanished (`CloseTab`, `ClosePane`, `CloseWorkspace`) has nowhere to come back
   to. Every render prunes ids that are no longer in the snapshot, which covers a tab closed
   while its workspace was inactive and whose view was therefore disposed long before. Reading
   it is one-shot: `ensureView` takes the value and deletes it when it constructs a
   `TerminalView`.

   A view asked for its offset **while a restore is still pending answers with the pending
   value, not with its buffer**: before the replay and the reprint have landed, the buffer does
   not yet hold the place the user was at, so reading it would round-trip a tab that was left
   again within the first second straight to the bottom and lose the memory for good (the
   one-shot `take` has already cleared it). The judgment is in the same pure function, as a
   leading `pending` argument.

   The WebView lifetime is the deliberate boundary. F5 and the idle webview reload (ADR-0004
   decision 4) come back with no memory and therefore at the bottom, exactly as before this
   change. Persisting across those would mean writing scroll positions to `state.json`, which
   is a different contract (and a wrong one — the replay a reloaded app attaches to has moved on).

4. **The position is applied after the replay, again on every parsed chunk while the restore is
   pending, and once more when the output the nudge provokes goes quiet.** The post-replay
   application is not enough on its own — the reprint described in fact 3 above replaces the
   scrollback a few hundred milliseconds later and would leave the pane at the bottom again.

   Re-applying per chunk is what makes the intermediate states safe. The reprint begins with
   `ESC[3J`, so for a moment the scrollback is empty and the remembered line does not exist; the
   refusal of decision 2 then pins the view to the bottom, and it walks back up as the history
   refills. Without that, the pane sat at the top of a half-drawn transcript for the length of
   the reprint (0.3–0.8 s measured) and stayed there permanently if the restore was cancelled in
   that window. The hook is the `term.write` completion callback, so `baseY` is current at every
   correction, and it runs both before and after the settle is armed — chunks arriving between
   the nudge's two resize calls are reprint chunks too.

   The settle decides only when to **stop** correcting: 250 ms of silence after the last parsed
   chunk, capped at 2,000 ms after the nudge is armed. If no chunk arrives at all once it is
   armed there was no reprint, so the applications that already happened stand and the settle
   does nothing more. The quiet half of that rule only works if the **driver re-polls**: a chunk
   moves the machine's next check earlier, so the pending timer has to be cleared and re-armed
   from the new answer. The first draft armed one timer at the cap and never re-polled, so every
   restore waited the full 2,000 ms and kept correcting into output the user was already reading
   (peer review 2026-09-12). The re-arm is guarded on a timer actually being pending — polling a
   settle that is not yet armed answers `abandon` and would kill the restore before the nudge. Those two numbers are a heuristic and the weakest part of this change; they
   are isolated in a pure state machine (`OutputSettle`) that takes its time as an argument, so
   the rule is testable without a clock and adjustable without touching the view.

5. **A user gesture during the wait cancels the restore, and the signal is DOM events rather
   than `xterm`'s `onData`.** A key, a wheel notch, or a mouse-down on the scrollbar
   (`.xterm-viewport`) abandons the pending restore; the intent the user expresses now beats the
   position the app is trying to put back. A mouse-down on the text itself does not count — the
   common gesture on returning is a click to focus the pane, which is not a scroll intent, and it
   lands inside the 2,000 ms window almost every time. `onData` would have been the smaller hook,
   but it carries xterm's own automatic DA/CPR replies to the live queries a nudge can provoke,
   so it cannot tell the user from the terminal — and a false cancel there would defeat the
   feature precisely on the tab it exists for.

   The listeners live on the **view's own root element**, which sets the reach of each signal: a
   key press cancels only while that pane has focus, so a returning user typing into a different
   pane does not disturb this one — and equally, the keyboard is not a global escape hatch. The
   wheel and the scrollbar drag reach the pane under the pointer whether or not it has focus.

   The three signals differ in one more way: **a key cancel also releases the latch, the other
   two do not.** Someone who starts typing is not saying "keep me here", and leaving our latch
   behind would stop the pane following the reprint that is still on its way — the frozen-pane
   failure of decision 2, reached through the cancel path instead. Someone who turned the wheel
   or dragged the scrollbar owns that scroll position themselves, and releasing it would undo
   the gesture that cancelled us. If the key cancel lands at `baseY === 0` the release is
   deferred like any other.

6. **The nudge stays exactly as it is.** It is not the cause, and removing or narrowing it —
   the "attach-time redraw fires even for a session already attached in this WebView lifetime"
   backlog item — would shorten a Codex tab's scrollback to whatever the replay window happens
   to hold. That item is closed by this ADR; the replay cost it was worried about is recorded
   as an open consequence instead.

7. **The alternate buffer is never remembered.** There the scroll offset belongs to the
   application (the Ctrl+T overlay handles PageUp itself), the replay was measured to carry that
   screen across intact, and scrolling a terminal that a full-screen program is drawing into
   would fight it. A remembered offset of 0 is not stored either — the bottom is where a
   re-attach already lands.

## Consequences

- **The settle window decides when to stop correcting, not where to land.** Because the position
  is re-applied on every parsed chunk (decision 4), the pane tracks the reprint instead of showing
  its top, and a cancel at any instant leaves a sane view. What the 250 ms / 2,000 ms rule buys is
  an end: a reprint that pauses longer than the quiet window, or one still running at the cap,
  ends with the last correction applied — on a real line the pane stays there (xterm reads it as
  a user scroll, which is the point) and on a refused one it sits at the bottom and follows
  output. Neither outcome is a pane frozen at the top, which is what the first draft produced.
- **The app now owns a piece of xterm state it did not before.** `isUserScrolling` used to be
  set only by the user and cleared only by the user reaching the bottom; the restore sets it and
  is responsible for undoing it on every exit path — refusal, cancel by key, and the deferred
  case at `baseY === 0`. The flags that track that (`latchedByRestore`,
  `releaseLatchOnNextChunk`) are the cost of the feature, and they are cleared on dispose with
  everything else. The transferable lesson is narrower and worth more: **`@xterm/headless` is
  not a stand-in for the browser build when the behaviour under test involves the viewport.**
  Three of this change's defects were invisible to a headless probe and visible to one against
  `@xterm/xterm`.
- **After F5 or the idle webview reload the position is gone** (decision 3). The user-visible
  rule is "a workspace round-trip keeps your place; a reload does not".
- **~192 KB of replay per round-trip remains unaddressed.** Decision 6 keeps the two-step nudge,
  so a Codex tab spends about 19% of its 1 MiB replay window on each resize reprint and five or
  six round-trips fill it with them. The cheaper half of the fix — one resize instead of two —
  is a separate change and is in the backlog, not here.
- **Nothing in the core, the model or the IPC surface changed.** The whole change is
  `apps/mast/src`: pure scroll helpers and a settle state machine in `features/terminal/scroll.ts`, the
  `ScrollMemory` policy in its own module, and one shared helper (`existingTabIds`) lifted out of
  `planViewerSync` so the terminal reconcile can ask the same question the viewer reconcile
  already asked. `planViewSync`'s shape is untouched.
- **ADR-0016's reading of Codex's terminal behaviour is in doubt** (Context, fact 1). Until a
  field check says otherwise, the phone's rule for showing its ▲/▼ scroll buttons — "the active
  buffer is the alternate one *or* mouse tracking is on" — may be firing for Claude Code tabs
  and not for Codex ones. Nothing here changes that code; the WINDOWS-BUILD item asks for the
  observation that decides it.

## Amendment (v0.3.26) — the wipe itself starts the same restore

Decision 4 treats the reprint as something that happens *inside* a round-trip restore. The user's
own measurements on Windows say it also happens on its own, and the same class of defect then
appears with no workspace switch involved:

- Scroll a Codex tab up, resize the window: the pane jumps to the **top** of the transcript.
- Scroll up while an answer is still printing: at the end of the answer the pane jumps to the top
  as well. What provokes a reprint at that moment was not measured — a resize is the only trigger
  this repo has measured, and it is not obviously involved here.
- Typing anything afterwards puts the pane back at the bottom.

**Mechanism.** All three follow from one library fact. xterm 5.5's ED 3 (`ESC[3J`) trims the
scrollback and sets `ybase = ydisp = 0`, and it does **not** clear `isUserScrolling`. A user who
scrolled up holds that latch (so does a restore of decision 2, which is why the round-trip case
was the first one seen), so when the reprint wipes the scrollback the viewport stays at line 0
while the reprinted history stacks up underneath it — the top of the transcript. Typing then ends
it because xterm's own `scrollOnUserInput` jumps to the bottom, which is exactly the third
observation. A pane already at the bottom holds no latch, follows the reprint down and never
jumps; that is why the defect only ever shows on a pane the user had scrolled up.

1. **The trigger is a parser hook on ED 3, not a heuristic about resizes.** `TerminalView`
   registers `registerCsiHandler({ final: "J" })` and returns `false`, so xterm's own ED handling
   runs after ours — the discipline the phone's `trackSgrMouse` already follows (ADR-0016). The
   ordering is what makes the hook useful: a custom CSI handler runs **before** the built-in one,
   so the `baseY`/`viewportY` read inside it are the values from just *before* the wipe, which is
   the position the user was looking at and the only moment it still exists. That premise is a
   library behaviour rather than ours, so it is locked by a test that drives a real
   `@xterm/headless` instance through the same sequence.

2. **What the hook does is start the restore machinery already here.** `beginScrollRestore` is
   now the shared entry point of both paths: it sets the pending offset, swaps in a fresh
   `OutputSettle` (the state machine is single-use — once it has answered, every later poll is
   `abandon`) and installs the cancel listeners. The wipe path then arms the settle immediately,
   where the round-trip path still arms it after the nudge. Everything downstream is unchanged
   and unduplicated: the write-completion callback of the very chunk that carried the `ESC[3J`
   runs `noteChunk → applyScrollRestore → rescheduleSettle` as it does for a round-trip, so the
   pane follows the reprint up as the history refills, a position the shorter reprint no longer
   has is refused rather than clamped (decision 2), and a key, wheel or scrollbar gesture
   cancels (decision 5) with the same latch rules.

3. **A wipe while a restore is pending is ignored.** The judgment is the pure
   `scrollbackWipeRestoreOffset(pending, replayDone, bufferType, baseY, viewportY)`: a non-null
   `pending` answers null, because the value already in flight is where the *user* was, while
   what is on screen mid-restore is an intermediate state the machinery has not corrected yet.
   That covers both the round-trip nudge's reprint and the second `ESC[3J` inside one reprint
   (Codex sends `ESC[2J` + `ESC[3J`). A wipe while a deferred latch release is pending is
   ignored as well: the view is then frozen at line 0 by a refused restore, not parked there by
   the user, and because the release runs in the write callback while the hook runs during
   parsing, the hook would otherwise read that artefact as "the whole transcript above the
   bottom" and pin the pane at the top — the very symptom. A wipe arriving before a re-attach's
   replay has finished parsing is ignored too — it is a past reprint preserved in the replay
   window, not something the user saw (the first attach sets `replayDone` before its replay
   because its queries are live, ADR-0009; a fresh terminal has offset 0, so the same wipes
   fall out on that rule). The alternate buffer and an offset of 0 are excluded for the reasons
   decision 7 gives.

4. **`ESC[3J` is assumed to reach xterm on Windows; the log line is what proves it.** conhost
   is understood to forward a client's ED 3 to the attached terminal in ConPTY mode — older
   builds special-cased a scrollback erase in `AdaptDispatch::EraseInDisplay` so the state
   machine would pass it on, and the current console emits `ESC[3J` on its own VT output path for
   API-level clears (`WriteClearScreen`) — and the Linux-pty capture behind this ADR's fact 3
   shows Codex sending it, but this repo has not observed a client's own `ESC[3J` arriving on
   the Windows path. So the hook logs one opt-in line per detection
   (`scroll: scrollback wiped N line(s) above the bottom — restoring`) and one at the end of each
   restore. A field report of a jump **without** that line says the bytes never arrive and the
   fix is in the wrong layer; a jump *with* it says the restore ran and lost. No screen content
   is logged, per ADR-0014.

5. **A wheel or scrollbar cancel hands the latch to the user, deferred release included.**
   Decision 5 of this ADR says a non-keyboard cancel leaves the position alone, and with a
   reprint in play that now has to be enforced rather than merely not-done: the refusal path
   arms a *deferred* release whenever it runs at `baseY === 0`, which is every reprint's first
   chunk, so a wheel arriving in that window used to leave the release armed and the next chunk
   scrolled the user to the bottom (peer review 2026-09-12). The cancel therefore drops both
   latch flags — we stop tracking a latch that is now the user's, and xterm clears it by itself
   when they scroll back to the bottom. A key cancel still releases, as decision 5 says.

**Accepted limits.** The Windows answer-end reprint has no measured trigger, so the fix is aimed
at the wipe rather than at whatever causes it — if a jump ever happens without an `ESC[3J` this
change cannot see it. The settle window stays the heuristic decision 4 admits, now also deciding
when a reprint that nobody asked for is over. A `clear` typed into a pane the user has scrolled
up is an `ESC[3J` as well: the restore starts, the (now empty) scrollback refuses the position
and the pane ends at the bottom after the settle window — correct, but it spends a second getting
there. And the intermediate states of a reprint are visible as before: the pane tracks the
rebuild from the bottom up rather than sitting still. One window widened rather than opened:
decision 3 of this ADR prefers a pending offset over the buffer when a tab is disposed mid-restore,
and a restore is now pending for up to two seconds after *every* reprint, so leaving a workspace
in that window remembers the pre-wipe offset even if the restore had been refused and the pane
was in fact at the bottom — the same priority as before, reached more often.
