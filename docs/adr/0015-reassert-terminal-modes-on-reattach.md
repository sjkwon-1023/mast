# ADR-0015 — Re-asserting terminal modes on re-attach

Status: accepted (2026-09-05) · Extends [ADR-0004](0004-lifecycle-persistence-reset.md)'s
replay/attach design · Verification: WINDOWS-BUILD §10 v0.3.15

## Context

A user reported that a long paste into a Claude Code pane submitted its top part and left the
rest in the prompt box. The pane had been running for a long time in one of eight workspaces.
The probe that identified the bug was two short lines pasted into that same pane: the first one
was submitted the moment it landed, which means bracketed paste was **off** on that pane even
though the agent had enabled it — and the only thing in this app that turns a mode off behind a
program's back is a re-attach.

The modes a program sets with DECSET/DECRST (`CSI ? Pm h` / `CSI ? Pm l`) live in exactly one
place in this app: the front end's `xterm.js` instance. Nothing on the Rust side knew they
existed. A re-attach throws that instance away and builds a new one:
`features/workspace/view-reconcile.ts` disposes the views of a workspace being left (ADR-0004 decision 1),
`features/terminal/view.ts` constructs a brand-new `Terminal` on return, and the only thing that
ever tells that terminal what state it is in is the replay it writes
(`features/terminal/view.ts` ← `PtySession::reattach` ← `ReplayBuffer::snapshot`). The webview
reload from the idle reset policy (ADR-0004 decision 4) and a plain F5 take the same path.

The replay is a 1 MiB window with whole-chunk eviction and a head trim. A long-running TUI
enables bracketed paste **once**, at startup. After the pane has produced more than a megabyte
of output, that `ESC[?2004h` is no longer in the window — so the rebuilt terminal comes up with
`bracketedPasteMode = false`, `term.paste()` sends the text raw with its newlines turned into
CRs, and the agent reads the first CR as "submit". The user's report is the exact expected
symptom.

The same loss can be staged without an agent, and that recipe is the verification item for this
release (WINDOWS-BUILD §10 v0.3.15 item 2 — it needs the Windows build, so it has not been run
on the Linux dev box). In a bash tab:

```
printf '\e[?2004h'; yes | head -c 2000000; cat -v
```

Pasting into the `cat -v` shows `^[[200~` around the text. Two megabytes of `yes` is more than
the replay holds, so after a switch to another workspace and back the `ESC[?2004h` printed
before it has been evicted, the rebuilt terminal never sees it, and the marker is gone — until
this change.

Why bash never showed this on its own: **readline re-enables bracketed paste at every prompt**
(and disables it while a command runs), so the sequence is always within the last few hundred
bytes the replay holds. The loss only appears for a program that sets a mode once and then
keeps producing output — which is precisely what an agent TUI is, and why the bug waited for
one.

Bracketed paste is the loud case, not the only one. The same window carries mouse tracking
(1000/1002/1003/1005/1006/1015), focus reporting (1004), cursor visibility (25), DECCKM (1) and
autowrap (7) — and the alt-screen switch (1049/47/1047), which turns out to need different
handling (decision 4). Those degrade a pane after a round-trip — no mouse in `vim`, arrow keys
sending the wrong prefix — while bracketed paste changes what a keystroke *does*, which is how
it got reported first.

## Decisions

1. **The modes are tracked in the core, on the byte stream, not in the front end.** The
   `OscScanner` gains a CSI branch and the `PtySession` keeps a `BTreeMap<u16, bool>` of every
   private mode the program has touched.

   The front end is the thing that loses the state, so it cannot be the thing that holds it: a
   JS-side mode cache dies with the page on the idle webview reload, and the views are disposed
   on purpose when a workspace is left. The session outlives all three events; it is already
   the component whose whole job is "what a re-attaching front end needs to know". Reading the
   modes back out of `xterm` before disposing a view was rejected for covering only the switch
   case — F5 and the reload have no dispose hook to read from.

   A **larger replay cap** was rejected for the same reason it was rejected as a perf fix: it
   moves the cliff instead of removing it (2 MiB of output beats a 2 MiB buffer), and the
   replay is what makes a workspace switch cost ~236 ms with visible flicker (ADR-0004
   follow-ups). Paying more switch latency to make a correctness bug rarer is the wrong trade
   twice over.

2. **The CSI recognition lives in the existing scanner, not a second one.** It is the same byte
   stream, entered through the same `ESC` state, and it needs the same two things the OSC path
   already has and got right: sequences split across `feed()` calls, and CAN/SUB aborting back
   to ground. A second scanner would duplicate all three and add another pass over the hot
   path. The module header says so, because the module is no longer OSC-only and its name no
   longer tells the whole truth.

   The scanner stays **detection-only and classification-only**: it reports
   `DecPrivateMode { modes, set }` and `TerminalReset`, and knows nothing about which modes
   matter. Everything below is session policy, deliberately kept out of it.

3. **`reattach()` prepends a preamble; the replay bytes themselves are untouched.** For each
   tracked mode in ascending order it emits `ESC [ ? <mode> h` or `ESC [ ? <mode> l`, built by a
   pure function that is unit-tested on its own.

   The preamble goes **first** so that any DECSET/DECRST still surviving inside the replay wins
   over it — the same order those bytes had in the live stream. Writing the synthetic bytes
   into the `ReplayBuffer` instead was rejected: they would be evicted like any other bytes (so
   the fix would expire exactly when it is needed) and they would corrupt the buffer's byte
   accounting. Assembling the preamble in the glue or the front end was rejected because the
   map is session state and every attach path would have to remember to ask for it —
   `reattach()` is the one door.

4. **Side-effecting transitions are never re-asserted: 2026, and the alt-screen modes 47, 1047,
   1048 and 1049.** A private mode is only safe to re-assert when setting it again is idempotent
   and leaves the screen alone. Mode 2026 (synchronized output) fails the first test: it is a
   begin/end pair, and a `begin` in front of the replay tells the terminal to hold everything
   until an `end` that is either in the evicted past or in a frame the program will never send
   again — the pane would come back blank. The alt-screen modes fail the second: in xterm.js
   `?1049h` saves the cursor and activates the alt buffer, and `activateAltBuffer` returns early
   when the alt buffer is already active. A `?1049h` in front of the replay therefore makes the
   replay's *own* `?1049h` a no-op, so the shell scrollback that precedes the transition is drawn
   into the scrollback-less alt buffer and the normal buffer comes back empty — the review
   reproduced it against the shipped xterm build: 60 shell lines in the normal buffer without
   the preamble, none with it. `?1049l` is no better: it calls `restoreCursor`, which yanks a live
   prompt's cursor to a saved (or zero) position. The first draft re-asserted them and the
   verification recipe caught it. **The cost is that the evicted-alt-screen case stays as it
   was**: a TUI whose `?1049h` has fallen out of the window still comes back on the normal
   buffer after a round-trip. The candidate fix — re-assert a mode only when its last change is
   older than the replay window, tracked by stream offset — is recorded in the backlog, not
   built: it needs per-mode offsets and a rule for the head trim, for a degradation that redraws
   itself on the next `:q`.

5. **At most 64 distinct modes are tracked.** Past the cap new modes are ignored while the ones
   already in the map keep updating. The map is fed by whatever the program writes, and a
   hostile or broken stream can name tens of thousands of private modes; 64 is far above the
   dozen that real programs touch. Evicting the oldest entry instead was rejected — a program
   cycling through modes would then push out the one it actually set, turning a memory bound
   into a correctness bug.

6. **RIS (`ESC c`) clears the map; DECSTR (`CSI ! p`) removes only what a soft reset resets.**
   Keeping stale values across a reset would re-assert them on the next attach: `tput reset`
   (whose `rs1` is RIS on the xterm terminfo) in a pane that had mouse tracking on would come
   back with mouse tracking on, i.e. the app would undo a reset the user explicitly asked for.
   The two resets are not the same, though, and the first draft treated them as one. xterm.js's
   `softReset` resets DECCKM (1), DECOM (6), autowrap (7), cursor visibility (25), reverse
   wraparound (45), the keypad mode (66), focus reporting (1004) and bracketed paste (2004) —
   and **not** the mouse modes or the buffer switch. Clearing everything on DECSTR would have
   put a pane that sent `?1000h` and then `!p` back without a mouse after a round-trip, which is
   exactly the degradation this ADR removes. So DECSTR removes that fixed set and nothing else.
   Clearing to *defaults* rather than removing was rejected as redundant — a fresh `Terminal`
   already starts at the library defaults, and an absent key says exactly that.

7. **The session consumes these events; they are never forwarded as OSC.** They carry no
   notification payload and no model delta, so they are not counted in `osc_count`/`last_osc`,
   never reach `sink.on_osc`, and never enter the coalescing batch or cross the IPC boundary —
   at terminal-output rates that would be pure cost. They are applied inside the same lock
   section that pushes the chunk into the replay buffer, so the mode map and the buffer are
   consistent at chunk granularity: a re-attach can never see a preamble that describes a chunk
   the snapshot does not contain, or vice versa. The matches that are exhaustive today — `OscBatch::merge` and the
   spike's sink — got an explicit ignore arm rather than a wildcard, so a future event type
   cannot slip silently into a path that does not expect it; the mast sink's existing wildcard
   would forward them to the router, which is one more reason the session consumes them first.

## Consequences

- **The `reattach()` offset contract is worded differently.** The returned bytes are no longer
  "the stream interval `[end_offset - len, end_offset)`" — the preamble sits in front of them
  and belongs to no offset at all. The dedup rule callers actually run, `offset < end_offset`,
  is unaffected. A grep over `apps/mast/src` confirmed that rule is the *only* offset
  arithmetic on the front end (`features/terminal/attach-gate.ts`); nothing derives a start offset from the
  snapshot length. The comments that stated the old interval were corrected where they appear.
- **Other TUIs recover most of a round-trip.** A `vim` or `htop` pane comes back with mouse
  reporting alive, arrow keys in application mode, and the cursor hidden if it was hidden.
  Before this, leaving and returning to a busy workspace quietly downgraded every such pane.
  The alt-screen switch itself is the documented exception (decision 4).
- **Non-private state is still not restored.** Scroll region (DECSTBM), SGR attributes, charset
  selection, insert mode (SM 4), tab stops and the alt-screen *contents* are re-derived from the
  replay when it happens to contain them and otherwise left to the attach-time SIGWINCH nudge
  (ADR-0004 decision 2), which makes the TUI redraw itself. That split is deliberate: the two
  modes whose absence changes what a keystroke *does* are private modes and are now covered;
  the rest are cosmetic until the next redraw, and tracking them means tracking values rather
  than booleans — a larger contract for a smaller problem.
- **The cost is one `BTreeMap<u16, bool>` per session**, 64 entries at most, plus a branch in a
  scanner that already visits every output byte. The CSI branch borrows its parameter buffer
  and clears it in place, so a CSI sequence that is not a private-mode set allocates nothing —
  the first draft took the buffer by value and paid a malloc/free per SGR, which the review
  caught.
- **A paste that arrives while the replay gate is closed is still dropped.** The front end's
  `pasteFromClipboard` went straight to `term.paste`, bypassing the wrapper whose whole purpose
  is to refuse silence; it is routed through the wrapper now, so the drop is logged. Buffering
  the text until the gate opens would be the real fix and is not done — the window is the few
  hundred milliseconds of replay parsing on a view that has just become visible.
