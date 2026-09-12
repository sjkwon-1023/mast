# ADR-0020 — Patching xterm's composition helper at build time

Status: accepted (2026-09-12) · Relates to [ADR-0014](0014-opt-in-runtime-log.md) (the log that
recorded the events) · Verification: WINDOWS-BUILD §10 v0.3.26

## Context

Typing Korean into a Claude Code pane occasionally produced the wrong text: the intended
`테스트 문장` came out as `테 테  테 ` — a previous syllable repeated, the new ones and the space
gone. It happened rarely, only with Korean, and clicking another pane and coming back cleared it
(user report 2026-09-12; the 2026-08-22 "stuck composition, every shortcut dead" report in the
backlog is the same family). The opt-in log (ADR-0014) showed `compositionend` and the next
`compositionstart` arriving in the **same millisecond**, which looked like the trigger. It is not:
that pairing is simply how 두벌식 works when a trailing consonant moves to the next syllable
(`테`+`ㅅ` → `텟`, then `ㅡ` turns the `ㅅ` into the start of `스`), and measured on its own it is
harmless.

The fault is in `@xterm/xterm` 5.5.0's `CompositionHelper._finalizeComposition`
(`src/browser/input/CompositionHelper.ts`, shipped in the package). On `compositionend` it
copies `{start, end}` of the composition, sets a single `_isSendingComposition` boolean and
defers the send with `setTimeout(0)`; in the timer, if a new composition has already started, it
sends `textarea.value.substring(start, end)`. Two things go wrong together once the main thread
is busy enough that **two or more keys are processed before that zero-delay timer runs**:

1. **Sends are coalesced.** Two commits queue two timers, but the first timer clears the one
   boolean and the second sends nothing — five commits measured as four sends. Upstream tracks
   this as xterm.js #6089, still open.
2. **The surviving send reads a stale window.** `end` was written by the *previous* task's
   `compositionupdate` timer, so it is already several syllables behind; `substring(0, 1)`
   applied to `"테스트"` sends `테` again. A space typed after a commit is lost for the same
   reason: with the next composition already open the code takes the `[start, end)` branch
   instead of the open-ended `substring(start)` that would have picked the space up.

Reproduced on the real 5.5.0 browser bundle under happy-dom (`ime-composition.test.ts`): with
the timer flushed after every key the output is correct; after every two keys the space is lost;
after every three `스` is lost; after every four `테`, `트` and the space are lost. The DOM
update order made no difference — the only variable is when the timer runs. That is why the
field sees it "sometimes": an idle pane flushes between keys, a pane next to one that is pouring
output does not. Claude Code is not involved at all — it receives committed UTF-8 bytes, so the
bytes it drew are the bytes xterm sent.

Upstream fixed exactly this expression **three days after 5.5.0 was published** (commit
`52e8a75e9f`, 2024-04-08, "Fix duplicate input for some IMEs", closes #5023): the window now ends
at the *newest* composition's `start` instead of the stale `end`, so a coalesced send carries
everything committed in between and nothing is lost. The next stable release carrying it is
**6.0.0** (5.6 only ever shipped betas), and 6.0 also rewrote the viewport — the very code
ADR-0019's latch-release analysis is written against — so `^5.5.0` cannot reach the fix and a
major upgrade is not a one-line change.

## Decision

1. **Patch the shipped bundle at build time.** `src/xterm-composition-patch.ts` exports a Vite
   plugin that replaces the one expression in `node_modules/@xterm/xterm/lib/xterm.js` with the
   upstream form, on both paths the app is built through: Rollup's `transform` for `vite build`
   (which does run over `node_modules`) and an esbuild `onLoad` for the dev server's dependency
   pre-bundle, which bypasses plugin transforms. Covering only one would give dev and release
   builds different Korean input.
2. **The patch fails loudly.** The expression must occur exactly once; anything else throws and
   stops the build. A dependency bump that changes the bundle therefore forces a decision — drop
   the patch (6.x has the fix) or re-target it — rather than silently bringing the fault back.
3. **The regression test runs the real bundle.** `ime-composition.test.ts` loads the stock and
   the patched bundle, drives both through the 두벌식 event sequence with different flush
   intervals, and asserts the stock bundle *fails* at three keys per flush (documenting why the
   patch exists) while the patched one is correct at every interval.
4. **Rejected**: upgrading to `@xterm/xterm` 6.0.0 now — right in principle and the eventual
   answer, but a major with a new viewport implementation, so it needs its own change that
   re-measures ADR-0019's `scrollToBottom()` no-op finding and the WebGL/fit addon pairings;
   `patch-package` — the same edit as a 300 KB single-line diff against a minified file plus an
   install-time step CI must run; bypassing xterm's composition path by sending `ev.data` from
   a capture listener — removes the race at the root but means owning the inline composition
   view's `active` state as well, a bigger surface than one expression.

## Consequences

- A dependency's shipped code is modified outside its package. The plugin's exact-count check
  and the bundle-level test are what make that acceptable; neither is optional.
- What stays broken upstream even at 6.0: the coalescing itself (#6089), a keydown that ends a
  composition sending twice (#5778 / #6140), and Windows TSF replacing the textarea value
  wholesale (#6049). With the wider window the coalescing is lossless for this symptom, which
  is the one reported.
- The literal repetition in the report (`테 테  테 `) was not reproduced; what reproduces is loss
  and misalignment from the same line. A syllable repeating verbatim needs `start` to stop
  advancing, which a mid-sentence blur (`_handleTextAreaBlur` empties the textarea) would cause
  — consistent with "clicking another pane fixed it", unverified.
- The composition lines in the opt-in log stay. One inference to keep in mind when reading
  them: `logging.ts` sends an IPC call per composition event, so **enabling the log makes the
  main thread busier and this fault more likely** — a diagnosis that is easier to reproduce with
  the log on than off is consistent with this cause, not evidence against it.
- Field verification is a byte-level test, not a TUI observation: `cat > /tmp/ime.txt`, type the
  sentence, `xxd` the file — idle pane first, then next to a pane flooding output
  (WINDOWS-BUILD §10 v0.3.26).
