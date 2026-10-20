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

Reproduced on the real 5.5.0 browser bundle under happy-dom (`tooling/ime-composition.test.ts`): with
the timer flushed after every key the output is correct; after every two keys the space is lost;
after every three `스` and the space are lost (`테트문장`, the shape the test locks); after every four `테`, `트` and the space are lost. The DOM
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

1. **Patch the shipped bundle at build time.** `tooling/xterm-composition-patch.ts` exports a Vite
   plugin that replaces the one expression in `node_modules/@xterm/xterm/lib/xterm.js` with the
   upstream form, on both paths the desktop bundle is built through (`vite.config.ts`): Rollup's
   `transform` for `vite build` (which does run over `node_modules`) and an esbuild `onLoad` for
   the dev server's dependency pre-bundle, which bypasses plugin transforms. Covering only one
   would give dev and release builds different Korean input. The phone bundle
   (`vite.remote.config.ts`) is untouched — `@xterm/headless` has no composition helper.
2. **The patch fails loudly.** The expression must occur exactly once; anything else throws and
   stops the build. A dependency bump that changes the bundle therefore forces a decision — drop
   the patch (6.x has the fix) or re-target it — rather than silently bringing the fault back.
3. **The regression test runs the real bundle.** `tooling/ime-composition.test.ts` loads the stock and
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
  them: `infrastructure/logging.ts` sends an IPC call per composition event, so **enabling the log makes the
  main thread busier and this fault more likely** — a diagnosis that is easier to reproduce with
  the log on than off is consistent with this cause, not evidence against it.
- Field verification is a byte-level test, not a TUI observation: `cat > /tmp/ime.txt`, type the
  sentence, `xxd` the file — idle pane first, then next to a pane flooding output
  (WINDOWS-BUILD §10 v0.3.26).

## Amendment (2026-10-18) — 6.0.0 ships the upstream fix; the build-time patch is removed

The fix this ADR patched into 5.5.0 is in the published `@xterm/xterm` 6.0.0 bundles. Checked on the
installed package: the stale expression `this._textarea.value.substring(e.start,e.end)` occurs 0 times
in both `lib/xterm.js` (CJS) and `lib/xterm.mjs` (ESM), and the upstream form
`this._textarea.value.substring(e.start,this._compositionPosition.start)` occurs once in each.

This amendment supersedes Decisions 1–3 and the 6.0 rejection in Decision 4. The text above stays as
the record of the 5.5.0 fault and of why the patch existed.

1. **The patch is gone.** `tooling/xterm-composition-patch.ts` is deleted and `vite.config.ts` no longer
   loads it. The exact-count check went with it. A future bundle change that alters the expression is
   caught by the regression test below, not by a build error.
2. **The regression lock runs the stock bundles.** `tooling/ime-composition.test.ts` loads the shipped
   6.0.0 `lib/xterm.js` and `lib/xterm.mjs` by path and feeds the 두벌식 event sequence for `테스트 문장`
   at flush intervals 1, 2, 3, 4 and the full length. Each bundle must produce the typed text from
   `onData` every time (`flush 간격과 무관하게 친 그대로 보낸다`). Negative control: the same test against
   the 5.5.0 CJS bundle fails at `flushEvery=2`, producing `테스트문장`.
3. **Chosen versions.** `@xterm/xterm` `^6.0.0` (locked 6.0.0), `@xterm/headless` `6.0.0` (exact),
   `@xterm/addon-fit` `^0.11.0` (locked 0.11.0), `@xterm/addon-web-links` `^0.12.0` (locked 0.12.0).
   `@xterm/addon-webgl` is removed because mast never enabled it.
4. **WebGL and fit obligation narrowed.** Decision 4's WebGL/fit re-measurement is limited to the
   deployed combination, the DOM renderer with fit. WebGL was not measured on 6.0. Introducing it needs
   its own verification.
5. **`apps/spike` stays on 5.5.0.** It is the frozen ADR-0001 measurement harness and keeps its own lock.
6. **Why the headless alias.** `@xterm/headless` 6.0.0 declares `"module": "lib/xterm.mjs"`, a file the
   package does not ship; its ESM build is `lib-headless/xterm-headless.mjs`. The remote and
   secure-remote Vite builds fail to resolve it. Both configs alias `@xterm/headless` to the CJS
   `lib-headless/xterm-headless.js`. The ESM build is not used: its license header contains
   `http://bellard.org/jslinux/`, which the Secure Remote plaintext audit reads as an HTTP marker.
7. **What stays open upstream at 6.0.0.** The coalescing itself (#6089), a keydown that ends a
   composition and sends twice (#5778 / #6140), and Windows TSF replacing the textarea value wholesale
   (#6049). The 2026-10-18 Windows report (`수준이야` typed, `주주ㅇ야` shown) has no confirmed cause, and
   this upgrade is not recorded as fixing it. The byte check in WINDOWS-BUILD §10 (F1) decides that.

Verification: Linux only, on the 6.0.0 build (vitest, `npm run build`, both Secure Remote audits). The
Windows and macOS checks are not run; they are listed as pending in WINDOWS-BUILD §10.

## Amendment (2026-10-20) — composition-vs-onData diagnostics only

The IME fault is **not fixed** by this change. The opt-in log now also records, per terminal, whether
the text Microsoft IME reports as committed equals the text xterm actually sent. It observes only:
it cancels nothing, replays nothing, writes no DOM value, and does not touch the existing `onData` →
replay gate → `enqueueWrite` path or the `shared/keys.ts` `isComposing` guard.

1. **Where it lives.** `installFrontEndLogging(settings)` already installs capture listeners only when
   `log` is true (ADR-0014). Each `TerminalView` on Windows attaches the observer in `attach()` and
   disposes it in `dispose()`; hiding the tab interrupts an open bundle, and the paste path marks it
   as mixed input. With `log` off, or on macOS, `installImeCommitDiagnostics` returns `null` — no
   listener, `onData` subscription, timer or held string exists. The observer uses the public
   `Terminal.textarea` and `Terminal.onData`; no private xterm hook or bundle patch is added.

2. **Comparison unit is one settled bundle, not one end/one send.** From the first `compositionend`
   until the bundle closes, all `compositionend.data` values are concatenated in arrival order
   (expected) and all `onData` strings are concatenated in arrival order (actual). The comparison is
   exact JavaScript string equality: no Unicode normalization, trim, substring search or re-encoding.
   Lengths are UTF-16 code units, like the composition log. Several ends may become one send, and one
   end may become several sends. `match=true` means exactly that those two observed sums are equal.

3. **The bundle closes on two zero-delay task boundaries.** xterm's composition helper sends from a
   zero-delay task after `compositionend`, so one task boundary is not enough — the observer re-arms
   after every end or send and closes only when two consecutive zero-delay boundaries pass with no
   new event. A fixed millisecond delay or "close on the first send" is not used. A send that arrives
   while a composition is open but before any end is not attached to the next commit.

4. **Bounds.** Expected and actual each hold at most 4096 code units, at most 32 ends and at most 32
   sends, and a bundle accepts ends and sends for at most 250 ms after its first end. An end or send
   past any bound emits `match=unknown reason=limit`, drops the bundle, and ignores the rest of that
   composition's tail until the next `compositionstart`; the tail is never mistaken for the next
   normal bundle. The 250 ms bound is checked on arrival, not on settle: a settle that a busy main
   thread delays past 250 ms adds nothing to the bundle, so it still closes with a verdict — marking
   it `limit` would discard exactly the comparisons taken next to a flooding pane. A timer exists
   only while a bundle is open.

5. **Unknown reasons are a fixed list**: `no-data` (no send at all), `empty-end` (a commit with empty
   data, including a cancelled composition, which the DOM cannot distinguish), `before-end` (a send
   before the first end of the composition, so attribution is unknown), `event-order` (overlapping
   or orphaned composition events — including the `compositionstart` before the open composition's
   end that the 2026-10-19 log showed; an orphaned `update` or `end` while a bundle is open marks
   that bundle too),
   `mixed-input` (any key outside the IME's own `229` keydowns — Tab, Escape and arrows included,
   since xterm sends sequences for them; only modifier and input-mode keys are exempt — or a paste
   overlapped the bundle, including `TerminalView.paste()`'s program paste), `interrupted` (blur,
   hide or dispose),
   and `limit`. No content, exception object or character code is ever interpolated into a reason.
   An unknown line keeps the identifiers and counts:
   `ime: commit match=unknown reason=no-data session=7 pane=3 ends=1 onData=0`. A normal close writes
   `ime: commit match=true session=7 pane=3 ends=2 onData=1 expectedLen=2 actualLen=2`.

6. **Identifiers and content.** A line carries the numeric session id and the ancestor
   `.pane[data-pane-id]` of the terminal at close (`none` when there is none), plus the end/send
   counts and lengths. It never carries the typed text, a hash, character codes, the textarea value,
   a pane title, a cwd or a URL. The held strings live only in memory and are dropped when the bundle
   closes or is interrupted. The same opt-in install also writes `pane: focus from=<id|none>
   to=<id|none>` from capture-phase `focusin`/`focusout`, so a commit bundle can be placed on the
   pane timeline without recording anything about the focused element.

7. **What this cannot show.** `onData` is xterm's generated data *before* the replay gate, so these
   lines do not prove the PTY received the bytes. `match=true` does not prove the IME reported what
   the user intended — if `compositionend.data` was already wrong, the two paths agree and the
   comparison is still `true`. A `no-data` line alone does not prove xterm dropped a character.
   `match=false` must be read together with whether generic input was excluded (`mixed-input`). The
   byte capture in WINDOWS-BUILD §10 F1, from another pane's ordinary shell while the bad state
   persists, is what decides whether the PTY saw the wrong bytes.

Field evidence this amendment was written against, neither reproduced nor recorded as a confirmed
cause: the user remembers that in the bad state typing in a neighbouring pane's ordinary shell also
produced the wrong characters (not only an agent's input box), and `mast.log` at 2026-10-19 22:15:31
held the only out-of-order sequence among 809 composition events in that window — a
`compositionstart` before the open composition ended, then an `update` and a second `end` after it
closed. The next reproduction is what the lines are waiting for.
