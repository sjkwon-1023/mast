# ADR-0005: Stage 17 — inter-pane text passing (built; UI entry points removed)

- Status: accepted; the header buttons were removed 2026-08-10, the machinery stays
  dormant for the v2 agent channel (see "UI entry removal")
- Date: 2026-08-10 (stage landed and verified 2026-08-09)

## Context

Stage 17 of 계획 v2 section 17 implements section 8's "pass text from one pane to
another" (send / send-and-run). A small UI stage on settled architecture, so it was
planned by the main agent directly (`docs/plans/mvp-stage17-plan.md`, now distilled here)
with a change-critic pass after implementation. It landed 2026-08-09, passed checkpoint 2,
and its **UI entry points were removed the following day** (the machinery stays, unwired).
The design matters going forward: the delivery mechanism and its safety rules are what the
v2 agent-facing channel will be built from — by re-arming the same state machine
programmatically instead of from a header button.

## Decisions

1. **Delivery goes through the target view's `term.paste()` — never a raw `ESC[200~`
   write.** xterm owns bracketed-paste mode tracking; emitting the markers ourselves puts
   literal `ESC[200~` on the input line whenever the receiving program has the mode off
   (the ADR-0001 paste bug in a new dress). The resulting bytes flow out through the
   existing `onData` → `write_stdin` path. Submit is a *separate* single `\r` write, so
   "send" alone can never execute anything.
2. **No new backend command.** The plan's three APIs (sendText / sendTextAndSubmit /
   sendRaw) were realized as `TerminalView` methods on the frontend, deferring promotion to
   glue commands until the v2 MCP surface needs them — the core bus stays structural
   mutations only (ADR-0002 decision 2).
3. **Mouse-first UI with the two gestures visually separated.** Two pane-header icons
   (`⤷` send, `⤷⏎` send and run) captured the source pane's selection and armed a
   target-pick mode; the next primary mousedown on a pane delivered. Separate icons are
   section 8's mis-run guard. `Esc` was intercepted **only while armed** — a deliberate,
   documented extension of the interception list, not a permanent claim on the key.
4. **A pure `SendMode` state machine** (arm(text, submit, source) / cancel /
   resolve(target) + the prompt string), DOM-free and vitest-locked; DOM and dispatch
   wiring stayed in `workspace-view`.
5. **The delivery guards found by review are the lasting knowledge**:
   - **Multi-line send to a target not in bracketed-paste mode is refused outright.** The
     paste path prevents stray markers, not line execution: without the mode the target
     cannot tell pasted newlines from Enter, so every intermediate line runs as a command.
     Refusing (with a status-line error, writing nothing) is the only safe behavior;
     single-line sends to the same target still work.
   - **Target acceptance is pre-checked before either half fires.** With the replay gate
     still closed, `onData` swallowed the pasted text while the submit CR went through on
     its own — executing whatever happened to be on the target's line. `resolveSend` now
     checks the target (running terminal tab, replay gate open) and skips paste *and*
     submit together, surfacing an error.
   - **Armed mode auto-cancels when the active workspace changes or the source pane
     disappears**, closing the cross-workspace bypass — a background workspace's views are
     detached, so there is no paste path to deliver into.
   - **stdin writes serialize per view through a promise queue**, so pasted text always
     lands before the send-and-run CR (`spawn_blocking` made the ordering racy). The queue
     outlived the feature — it orders ordinary writes too.
   - **An exited target surfaces an error** instead of silently dropping the text.

## Verification

Checkpoint 2 (`docs/WINDOWS-BUILD.md` §10, stage-17 items 1–9) passed on Windows
2026-08-09: send vs. send-and-run separation, bracketed-paste safety into `vim` (no
autoindent staircase, no marker fragments, nothing executed), the multi-line refusal, the
no-selection error, Esc and self-click cancel, workspace-switch auto-cancel, the exited
target error, and paste-before-CR ordering. Automated: the pure `SendMode` suite plus the
existing gates.

## UI entry removal (2026-08-10)

**The two header buttons (`⤷`/`⤷⏎`) are gone; the machinery stays.** Manual pane-to-pane
sending turned out not to be a real workflow: text moves between an *agent* and a pane,
not between two panes a human is watching, and the gesture (select → click icon → click
target) costs more than an ordinary copy/paste. The permanent per-pane buttons were the
cost that did not pay.

Removed: only the two header icons — the arm entry points. With nothing arming the mode,
the `Esc` capture never installs, so in practice `Esc` always belongs to the terminal.

Kept deliberately (dormant, by explicit user decision): `send-mode.ts` and its tests, the
target-resolve/delivery path in `workspace-view` with all five delivery guards,
`TerminalView`'s delivery methods (`getSelection` / `paste` / `submit` / `canAcceptSend` /
`bracketedPaste`), and the status-line delegation contract (`SendStatus`). The v2
agent-facing channel re-arms this exact machinery programmatically; nothing needs to be
rebuilt, only re-entered.

## Follow-ups

- **Agent-facing pane-send channel (v2)** — the same delivery mechanism driven by the
  management agent rather than a mouse: promote sendText / sendTextAndSubmit to dispatcher
  (MCP) commands addressed by **tab id**, and carry decision 5's rules over as contract —
  the bracketed-paste refusal and the acceptance pre-check are what keep a delivered
  prompt from executing itself.
- Absorbed by the retirement: the "keyboard targeting for send mode" idea (never built)
  dies with the mouse UI.
- **Landed 2026-08-11 (addendum)**: the channel shipped as `OSC 777;mast-send` plus a
  `mast-query` read half behind the `mast` CLI — tab-id addressing as planned, but
  written to the target session's stdin in Rust rather than through this ADR's frontend
  paste path, so decision 5's bracketed-paste refusal and acceptance pre-check do not apply
  to it; the machinery kept dormant above is still unused. Contract:
  `scripts/wsl/claude-hook-example.md`.
- **Confined to the requester's workspace (2026-08-11, user decision)**: both halves of that
  channel — `mast send`'s target resolution and `mast ls`'s enumeration — stop at the
  workspace the requester's own tab is in, because a workspace is the project isolation unit
  and a channel crossing it gave a mis-aimed line a blast radius reaching unrelated projects.
  A globally unique `#id` is no exception: uniqueness is a property of the address, not a key
  past the boundary. This is the same instinct as decision 5's workspace-switch auto-cancel,
  now enforced in the core rather than by the frontend's detached views.
