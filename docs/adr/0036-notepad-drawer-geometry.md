# ADR-0036: Notepad drawer geometry and font

- Status: accepted
- Date: 2026-10-21
- Verification: the automated Linux gates listed under Verification. The Windows field checks in
  `docs/WINDOWS-BUILD.md` §10 "Unreleased — notepad field verification" remain pending.

## Context

ADR-0034 decision 1 fixed the notepad drawer to the right edge: its width is
`min(420px, viewport - 16px)` and its height is capped by `calc(100vh - 16px)`. A long note
therefore always covers the same part of the pane, and a pane the user is reading stays under the
drawer. The user asked to move the drawer with the mouse and to resize it, as cheaply as possible,
and for the note text to follow the configured font. The note text had stayed at 13 px browser
monospace, so a user who chose a code font for terminals and viewers still saw the note in the
browser default.

The user decided on 2026-10-21 to keep the notepad free of new native storage and of viewport
constraints, and to revise the fixed width and height sentence of ADR-0034 decision 1 with this
ADR. The cost rule (ADR-0034 decision 8) and the invariant that the drawer does not change the
terminal layout (ADR-0034 decision 1) still hold.

## Decisions

### 1. Left/top placement with the existing default

An open drawer is positioned by `left`/`top` plus `width`/`height`, and `right`/`bottom` are set to
`auto` as inline styles. The native resize grip sits at the bottom-right corner, so a right- or
bottom-anchored box would move its own grip while the pointer drags it.

With nothing stored, the drawer keeps the footprint of ADR-0034 decision 1: top 8 px, right 8 px,
width `min(420px, viewport width - 16px)` and height `viewport height - 16px`. The default is
computed from `window.innerWidth`/`window.innerHeight`; no layout read (`getBoundingClientRect`) is
needed for it.

### 2. The header is the drag handle

Only a primary-button pointer press on a non-button part of `.notepad-header` (background, title,
workspace name) starts a move. The Close button and its children do not start a drag, so a press
there is an ordinary click. The scope buttons are outside the header and are unaffected.

The press calls `preventDefault()` and `setPointerCapture`. `preventDefault` is meant to keep the
text selection and the focus where they were, so the note textarea keeps focus. Whether an active
IME composition survives the press is not checked; no composition listener or flag exists. Presses with any modifier drag the same
way. The new position is the rectangle at pointerdown plus the pointer delta; there is no clamp.
Only the pointer id that started the drag moves the drawer. The drag ends on pointerup,
pointercancel or lostpointercapture, and a later pointermove changes nothing. pointercancel keeps
the last applied position and does not save. The header shows `cursor: move` and disables text
selection; buttons keep their own cursor.

### 3. Native resize with a minimum and no maximum

The dialog uses `resize: both` and keeps `overflow: auto`, which is required for the native grip
and leaves content wider or taller than the minimum reachable by scrolling. The minimum outer size
is 280×320 px through `min-width`/`min-height`. No size cap is declared: the UA stylesheet's
`max-width`/`max-height` on `dialog` is reset to `none` because it would clip a native resize, and
the former `max-height: calc(100vh - 16px)` cap is gone. The textarea keeps `resize: none` and
`min-height: 160px`, and follows the dialog box as it grows and shrinks.

The default position is attached to the right edge, so widening the drawer requires moving it left
first. This is accepted rather than worked around.

### 4. One remembered rectangle in localStorage

The rectangle lives in one WebView `localStorage` slot, `mast.notepadGeometry`, as
`{"left":n,"top":n,"width":n,"height":n}` in CSS pixels. It is not mixed with the sessionStorage
draft slot `mast.notepadDraft`. Nothing is added to `state.json`, `AppState`, the snapshot or the
remote surfaces.

The slot is read once, when the drawer opens; boot and module load never touch it. It is ignored
when the value is not JSON, when any of the four values is not a finite number, when width or
height is not positive, or when reading `localStorage` throws. In every such case the default
footprint above is used.

A stored rectangle is also ignored when its header is not on screen at all. The test is
`0 ≤ top ≤ viewport height - 24`, `left < viewport width - 48` and `left + width > 48`; a rectangle
that passes is applied unchanged. There is no other clamp, at open or while the drawer is open.

The rectangle is written when a header drag ends with pointerup and at the start of teardown.
Normal close, a cancelled load and a removed workspace all pass through the same teardown. The
value is the dialog's `getBoundingClientRect()` at that moment. Nothing is written when that rectangle equals the baseline (within 0.5 px), so the default
position keeps following the window while the user has not moved the drawer. The baseline is the
dialog's outer rectangle measured once right after it opens, because the CSS minimum can make it
larger than the requested size in a small window; a successful write replaces it, and a failed
write leaves it so the next save tries again. A rectangle with zero width or height — for
example while the window is minimized — is not written, because it would erase the remembered
geometry. A failed write is logged through `infrastructure/logging` and does not show a UI error or
block closing.

### 5. The note follows the viewer font settings

`.notepad-text` uses
`font: calc(var(--viewer-font-size, 12px) + 1px)/1.45 var(--viewer-font-family, monospace)`. The
family follows settings `fontFamily`; the size follows settings `fontSize` and the existing global
viewer zoom (`Ctrl+=`, `Ctrl+-`, `Ctrl+0`), which is session-only and shared with terminals and
viewers. When neither setting nor zoom is present, the CSS fallbacks keep the previous appearance:
13 px browser `monospace`. There is no notepad-specific font or zoom control.

### 6. Cost and terminal layout are unchanged

The listeners live on the drawer DOM and disappear with it. No window or document listener,
ResizeObserver, timer, rAF loop or worker is added, and there is no window resize handler. No new
module, abstraction or shared drag utility exists, and the `NotepadHost`/`NotepadFeature` API and
the dynamic import boundary are unchanged. The dialog stays a fixed, non-modal `<dialog open>` on
`body`. Moving or resizing it does not read or save a note, dispatch state, change pane DOM or
style, or call `resizeTerminal`; the teardown order "remove `open`, then remove the element" is
kept.

## Alternatives rejected

- **A geometry file in the notes directory behind a new IPC command.** It would add a Rust
  command, a capability entry, a write path and a lock order for one rectangle that is not user
  content. The user chose one localStorage slot, which already survives restarts in the
  WebView2 profile.
- **Clamping to the viewport and a window resize listener.** It would need a listener for as long
  as the drawer is open and would fight the native grip on every window resize. The user chose no
  constraint on moving or resizing. The only exception is the open-time default when the
  stored header is entirely off screen.
- **A separate JavaScript resize handle.** It reimplements the native grip with pointer listeners,
  hit areas and cursors. The user chose the browser's own resize handle, which needs only
  `resize: both` and a non-visible overflow.
- **Refusing a drag while an IME composition is active.** It needs composition listeners and a
  flag; keeping the textarea focused was judged enough. The user chose focus
  retention only.
- **A notepad-specific zoom.** The viewer font size is already the session zoom for code surfaces;
  a second zoom would let two surfaces in the same window disagree, and it would add a keymap and
  state. The existing global viewer zoom is reused.

## Accepted limits

- A drawer can be dragged completely off screen and stays there. The shortcut and Esc still close
  it, because focus stays inside the drawer.
- If the app quits while the drawer is open, a size change made after the last header drag may be
  lost: the native grip does not run the drawer's save path and quit does not run teardown. A moved
  position is saved at its pointerup.
- Deleting or resetting the WebView2 profile, or clearing `localStorage`, resets the position and
  size to the default.
- Chromium's behavior for `preventDefault()` on pointerdown keeping focus in the textarea, and the
  native resize grip on a fixed `<dialog>`, is not verified on a device. The Windows field list
  covers both.

## Verification

Automated coverage:

- `apps/mast/src/features/notepad/view.test.ts` — the default footprint; a stored rectangle; broken
  JSON, non-finite values, non-positive sizes, an unreadable store and an off-screen header falling
  back to the default; geometry unchanged across scope switches and workspace following; the drag
  delta, no clamp, button and non-primary-button exclusion, another pointer id, defaultPrevented
  with textarea focus retained, moves after the end ignored, save on pointerup and no save on
  pointercancel; save on close after a move and after a resize, no save without user action, and
  closing despite a failing write; the save slot being separate from the draft slot; and the
  `styles.css` contract (`resize: both`, `overflow` not visible, minimum 280×320 px, no size cap,
  textarea `resize: none`).
- `apps/mast/src/features/notepad/view-resize.test.ts` — terminal `resizeTerminal` call count, pane
  shape and pane rectangles unchanged across open, header drag, dialog resize and close, plus the
  existing positive control.
- `apps/mast/src/features/viewers/viewer-font.test.ts` — the CSS selector list that must read the
  viewer font variables includes `.notepad-text`.

Not verified by these gates:

- The native grip, the pointer focus behavior and the actual drag feel on WebView2 are pending.
- The macOS pointer and native resize behavior is not verified on a device.
- Windows field checks 10–15 in `docs/WINDOWS-BUILD.md` §10 are not recorded as passed.
