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

3. **The memory lives in `WorkspaceView` for the lifetime of the WebView, keyed by tab.** It is
   written in the `render()` dispose loop and only when the tab is still present in the snapshot
   — a tab that vanished (`CloseTab`, `ClosePane`, `CloseWorkspace`) has nowhere to come back
   to. Every render prunes ids that are no longer in the snapshot, which covers a tab closed
   while its workspace was inactive and whose view was therefore disposed long before. Reading
   it is one-shot: `ensureView` takes the value and deletes it when it constructs a
   `TerminalView`.

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
   does nothing more. Those two numbers are a heuristic and the weakest part of this change; they
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
- **After F5 or the idle webview reload the position is gone** (decision 3). The user-visible
  rule is "a workspace round-trip keeps your place; a reload does not".
- **~192 KB of replay per round-trip remains unaddressed.** Decision 6 keeps the two-step nudge,
  so a Codex tab spends about 19% of its 1 MiB replay window on each resize reprint and five or
  six round-trips fill it with them. The cheaper half of the fix — one resize instead of two —
  is a separate change and is in the backlog, not here.
- **Nothing in the core, the model or the IPC surface changed.** The whole change is
  `apps/mast/src`: two pure functions and a settle state machine in `terminal-view.ts`, the
  `ScrollMemory` policy in its own module, and one shared helper (`existingTabIds`) lifted out of
  `planViewerSync` so the terminal reconcile can ask the same question the viewer reconcile
  already asked. `planViewSync`'s shape is untouched.
- **ADR-0016's reading of Codex's terminal behaviour is in doubt** (Context, fact 1). Until a
  field check says otherwise, the phone's rule for showing its ▲/▼ scroll buttons — "the active
  buffer is the alternate one *or* mouse tracking is on" — may be firing for Claude Code tabs
  and not for Codex ones. Nothing here changes that code; the WINDOWS-BUILD item asks for the
  observation that decides it.
