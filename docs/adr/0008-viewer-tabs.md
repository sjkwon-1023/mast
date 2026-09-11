# ADR-0008: Stage 21 — viewer tabs (folderBrowser / textViewer / markdownViewer)

- Status: accepted
- Date: 2026-08-10 (stage landed 2026-08-09)

## Context

Stage 21, the last MVP stage, makes a tab something other than a terminal. 계획 v2's
"탭 타입별 동작" chapter sets the constraints: Rust reaches the WSL filesystem over
`\\wsl.localhost\<distro>\…` (Windows→WSL, the direction a locked-down distro does not
gate — section 5); 9P has no watch, so markdown live reload is mtime polling on the active
tab only; the text viewer must chunk-load; these are **viewers, never editors**; and an
inactive viewer tab keeps its state but unmounts its DOM. The plan went through the
drafter/critic cycle (`docs/plans/mvp-stage21-plan.md`, distilled here) and landed in four
chunks, with markdown as the deliberately severable last one.

Everything about this stage crosses a boundary that does not exist on the Linux dev host,
so its verification is unusually load-bearing.

## Decisions

1. **Path validation and UNC mapping live in `mast-core::wslpath`, not in the glue.** The
   concrete reason is the shape of the gates: `cargo test -p mast-core` is the only test
   command that runs Rust tests, so logic placed in `src-tauri` is exercised by no gate at
   all. Rejection rules: non-absolute, NUL, backslash (UNC separator smuggling), `.`/`..`
   components, components containing `:` (Windows alternate data streams), and components
   with a trailing dot or space (Win32 truncation aliases). Distro names get the same
   component rules — a later fix, after review found the asymmetry that let
   `MAST_DISTRO=".."` assemble `\\wsl.localhost\..\`. Recorded limits: UNC paths beyond
   ~247 characters may fail (verbatim `\\?\UNC` not adopted for the MVP), and symlinks are
   resolved by 9P — read-only access to one's own machine is not a sandbox-escape threat
   model, and the rustdoc says so rather than implying a guarantee.
2. **Distro resolution tries three sources and only then fails loud**: the argument
   (workspace distro) → `MAST_DISTRO` → a lazy `wsl.exe -l -q` default-distro query
   (UTF-16LE decode, success-only process-lifetime cache, `CREATE_NO_WINDOW`). Terminal
   spawn already tolerates an unset distro, so viewers must too: the most common
   configuration — neither set — must not be the one where half the app dies. Total failure
   names the fix (`workspace distro or MAST_DISTRO`) in the message; it is never a
   silently empty listing.
3. **Navigation is a dispatcher command; reading file content is not.** `NavigateFolder`
   mutates the model, per 계획 v2 section 4's rule that every operation goes through the
   single dispatcher — and that is exactly what makes the browsed path part of the persisted
   state and restorable. Content reads (`fs_list_dir` / `fs_stat` / `fs_read_chunk`) are
   direct invokes on the content plane, the same shape as `attach_terminal`, which is not a
   section 4 violation. `SetViewerScroll` completes the model side.
4. **`MarkdownViewer` entered the type only in chunk D.** Adding the variant with the rest
   of the contract would have left an unimplemented arm on the dispatcher surface if the
   optional chunk were cut — `command.rs`'s rule is that an omitted variant *is* the
   absence of the feature, at type level.
5. **Viewer lifetime is the mirror image of terminal keep-alive, and gets its own planner.**
   `planViewSync` (terminals stay alive when hidden — ADR-0003 decision 4) is untouched;
   the new pure `planViewerSync` mounts only each pane's active viewer tab in the active
   workspace and disposes everything else, into a parallel `viewerViews` registry. Dispose
   entries carry a "does this tab still exist" flag: an unmount flushes the scroll position
   first, a vanished tab skips the flush so closing a tab cannot produce `UnknownTarget`
   noise. `focusTarget` widened to `TerminalView | ViewerView`, so stage 20's keyboard
   navigation and ADR-0003's focus compensation work on viewer tabs for free.
6. **The text viewer holds exactly one 512KiB window, and never grows it.** Explicit
   first/prev/next/last buttons move the window; scrolling to its edge never auto-continues,
   because "open a 400MB log" must cost the same as opening a small one. Leading/trailing
   partial lines and split UTF-8 are trimmed (with a 1-byte back-read so restoring a saved
   offset never eats the target line). A fixed line height plus a spacer plus a
   viewport±20-line slice gives a real scrollbar with pure, testable slice arithmetic; the
   view installs **its own** `ResizeObserver` (the pane's observer stays terminal-fit only).
7. **The scroll round-trip needs an echo guard.** Scrolling debounces 500ms, then
   dispatches `SetViewerScroll`; the snapshot's `scrollTop` is applied **once at mount** and
   never re-applied while mounted on the same path. Without that rule every dispatch's
   re-render fights the user's own scrolling. Locked by vitest.
8. **Markdown escapes all raw HTML and strips `href` from links entirely.** This WebView
   holds the `dispatch` and `fs_*` IPC, so file-borne HTML reaching the DOM is a real
   privilege escalation, not a theoretical one — the escaping is a security requirement, not
   a rendering preference. Removing `href` outright (rather than filtering schemes) means a
   `javascript:` URL cannot survive a lost click handler. Images render as placeholders with
   no network request. Files over 2MiB refuse to render and offer "open as text".
9. **Live reload is a 2s mtime poll chain whose lifetime is the view's lifetime** —
   injected timers, `setTimeout` chain per repo precedent, no gating needed because mount
   already implies "active tab". It pauses while hidden, and the definition of hidden
   required a field correction: **WebView2 delivers neither `visibilitychange` nor
   `document.hidden` on minimize**, so the glue detects tao's 0x0-Resized minimize signal
   and emits a deduplicated window-hidden event that feeds the poller alongside
   `document.hidden`. Unfocused-but-visible deliberately keeps polling — previewing a file
   while editing it in another window is the use case.
10. **A failed reload keeps the last good render and restarts the poller with an impossible
    baseline.** A 9P transient (stat succeeds, read fails) used to wipe the rendered body
    and stick, because the poller's baseline had already advanced past the mtime that would
    have retried. Resetting the baseline to `-1` makes the next successful stat always read
    as a change, which also recovers a tab whose *initial* load failed once the file
    appears — without a remount.

## Verification

Checkpoint 2 (`docs/WINDOWS-BUILD.md` §10, stage-21 items 1–12) passed on Windows
2026-08-09, and it is the only evidence any of this works: sorting and truncation, browsing
persisted through the model and restored with a fresh listing after restart, a **400MB log
opening instantly with under 20MB of private-working-set growth** and no growth across
window jumps, scroll position surviving unmount, remount and restart including inside a
non-first window, background viewer tabs holding no DOM at all, missing/deleted files
surfacing inline while the tab stays open, markdown live reload plus the 2MiB refusal, the
raw-HTML/script/`javascript:`/image inertness checks, a **locked-down distro** (`automount`
and `interop` off) still serving the viewers, no edit affordance anywhere, terminals staying
keep-alive across viewer switches with no replay flash, and automatic default-distro
resolution with nothing configured. Automated: core tests over the `wslpath` rejection
rules and viewer persist round-trips, plus frontend suites for the sort, slice arithmetic,
echo guard, `planViewerSync` flush verdict, markdown escaping and the poller state machine.

**Field defects, fixed 2026-08-09/10 and re-verified 2026-08-10.** Beside the minimize
signal (decision 9): the text viewer's window buttons were disabled by a
"does this move change anything" verdict, which on a leading-trimmed last window never
locked next/last — pressing them reloaded the same window and overwrote the saved scroll
position, the exact failure the guard existed to prevent. Replaced with coverage bounds
(`start <= 0` locks first/prev, `end >= size` locks next/last), which also fixed a
read-length bug that had made the file's genuine last line unreachable. The folder
browser's initial selection now skips the `..` row, so Enter-to-descend followed by Enter
no longer bounces straight back to the parent.

## Follow-ups

- Accepted without change at review time, recorded so they are not re-litigated: the
  no-LF window back-read fragment, Win32 device-name aliasing (a checkpoint observation),
  and the post-flush remount race — the same family as the persistence debounce trade-off,
  where the cost is at most the last half-second of scroll position.
