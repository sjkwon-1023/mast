# ADR-0007: Stage 20 — the keyboard model and the canonical interception list

- Status: accepted
- Date: 2026-08-10 (stage landed 2026-08-09)

## Context

계획 v2 asks for two things in its keyboard chapters: one movement key per tier of the
three-tier structure (workspace / pane / tab), and an **explicit maintained list** of the
keys the app takes away from the terminal. Stage 20 delivered both
(`docs/plans/mvp-stage20-plan.md`, distilled here); the keyboard-first UX batch that
followed checkpoint 2 extended the same machinery with global shortcuts, and the
re-verification round on 2026-08-10 closed the two unverified preconditions.

Every key the app intercepts is a key the terminal loses, so each entry below is a
trade — that is why the list is a contract and not an implementation detail.

## Decisions

1. **One movement key per tier**: `Ctrl+1`…`Ctrl+9` (workspace by sidebar ordinal, 1-based),
   `Ctrl+Shift+arrows` (pane focus by on-screen geometry — nearest centre in the direction's
   half-plane), `Ctrl+Tab` / `Ctrl+Shift+Tab` (tab cycle inside the active pane, wrapping).
   The plan's alternative `Ctrl+↑↓` was rejected: TUI apps use `Ctrl+arrow`, and
   `Ctrl+1`–`9` already covers the tier.
2. **`shared/keys.ts` is a pure decision module, and its module doc is the canonical interception
   list.** `keyAction` / `paneInDirection` / `workspaceAtOrdinal` / `nextTab` decide what a
   keydown *means* and what its target is; snapshot interpretation, dispatch and
   `preventDefault` stay in `app/main.ts`, and pane geometry is measured by `workspace-view`'s
   `paneRects()`. Keeping the table in the same file as the matcher is the whole point —
   the list and the code cannot drift apart. `shortcutLabel(id)` is the single source every
   tooltip reads, with a label→key round-trip test enforcing it.
3. **A matched combo is intercepted even when it resolves to a no-op** (ordinal past the
   last workspace, no pane in that direction, 0–1 tabs). A key that leaks into the shell
   only *sometimes* is worse than a key that is consistently dead: `Ctrl+9` must never type
   a `9` into a command line just because there are three workspaces.
4. **Global shortcuts are `Ctrl+Shift` only.** Plain `Ctrl` combos stay shell-owned —
   `Ctrl+W` is bash's word erase, `Ctrl+D` is EOF, `Ctrl+E` is end-of-line, and taking any
   of them breaks the terminal. `Ctrl+Shift+C`/`V` are copy/paste convention and are never
   assigned to anything else. The set: `W` close active tab, `T` new terminal tab, `B`
   folder browser tab, `D`/`E` splits, `N` new workspace, `[`/`]` workspace cycle.
5. **`F2` renames the active workspace — a knowingly-paid cost.** Bare `F2` is a key TUI
   apps actually use (`mc`'s Rename), and intercepting it means those apps never see it.
   Accepted because "rename is F2" is a desktop-wide convention with no equally
   discoverable substitute. This is the opposite conclusion from ADR-0003 decision 8, where
   F5 was left to the terminal precisely because `Ctrl+Shift+R` was an equally good reload
   key. Both live in the same table so the asymmetry is visible rather than accidental.
6. **IME composition passes through untouched** — a keydown while `isComposing` belongs to
   the composer, never to the app.
7. **Matching is `ev.key`-based and therefore layout-sensitive; the conservative rule is to
   match only what is listed.** Shift variants of other combos (`Ctrl+Shift+1`,
   `Alt+Shift+←`) are deliberately unmatched, because shift produces different characters on
   different layouts. `Ctrl+Shift+[` / `]` meet that problem head-on and so match **both**
   the printed characters and their shifted forms (`{` / `}`).
8. **Recorded shadowing**: `Ctrl+1`–`9` covers the xterm control characters `Ctrl+2`…`Ctrl+8`
   (notably `Ctrl+3` as an Escape substitute). That is the price of the tier key the plan
   assigns, and it is in the table rather than in someone's memory.

## Verification

Checkpoint 2 (`docs/WINDOWS-BUILD.md` §10, stage-20 items 1–5) passed on Windows
2026-08-09: all three tiers including their no-op boundaries, and the two-sided check that
intercepted keys leave nothing in the shell **while** un-intercepted ones still reach it
(bare `Tab` completes, bare arrows walk history, `Ctrl+C` still interrupts). The conditional
item held — **WebView2 does deliver `Ctrl+Tab` to the page**, so no replacement binding was
needed.

The re-verification round on 2026-08-10 closed the second precondition: the six
`Ctrl+Shift` globals are Chromium accelerator combos (incognito, reopen tab, bookmarks) and
**WebView2 does not consume them**, so `AreBrowserAcceleratorKeysEnabled(false)` was not
needed either. Automated: the `shared/keys.ts` suite covers the full mapping, the IME guard, the
boundaries and the label round-trip.

## Follow-up landed after re-verification: `Shift+Enter`

A terminal cannot distinguish `Enter` from `Shift+Enter` — both are CR — so agents that
want "newline without submitting" agree on an out-of-band sequence. Claude Code's is
`ESC CR`, which its `/terminal-setup` installs into VS Code and iTerm2 keymaps. The
terminal view now emits `\x1b\r` for the combo itself (preventDefault plus blocking xterm's
default CR), so the flow works in mast **without** running `/terminal-setup`. Plain
`Enter` is untouched, so shells and `vim` behave exactly as before, and effectively no
terminal program assigns `Shift+Enter` its own meaning. The interception happens in
`terminal-view`'s `customKeyEventHandler` (next to copy/paste, which is where xterm-level
rewrites belong) but is listed in the `shared/keys.ts` table like everything else — the table is
canonical regardless of which module enforces a row. Verification is item 1 of §10's
post-re-verification subsection.

## Follow-ups

### v0.3.30: return Alt+arrows to the terminal

The original pane binding intercepted Codex's `Alt+Up` queued-question shortcut, even
when no adjacent pane existed. Pane focus now uses `Ctrl+Shift+arrows`; `Alt+arrows`
and plain `Ctrl+arrows` pass through to the terminal. This applies regardless of the
running application or pane geometry. The cost is that terminal applications no longer
receive `Ctrl+Shift+arrows`. IME composition still bypasses interception. Automated
tests cover all four directions and modifier combinations; live WebView2 delivery and
Codex's question UI require field verification with v0.3.30.

- Splitter resize is mouse-drag only; there is no keyboard equivalent for the drag handle.
- The `ev.key` layout assumption (decision 7) is checked only on the layouts this developer
  runs; revisit if a non-US layout ever becomes a supported target.

### 2026-09-17: add Alt aliases and automatic splitting

Keep the existing Ctrl bindings except `Ctrl+Shift+E`, which is removed. Add `Alt+1`–`9`
for workspace ordinals, `Alt+Shift+[`/`]` for workspace cycling, and `Alt+Shift+T/B/W/N/Q`
for tab and workspace operations. `Ctrl+Shift+D` still splits top/bottom; `Alt+Shift+D`
chooses left/right when the active pane is at least as wide as it is tall, otherwise
top/bottom. The choice is made once at the key press and does not change on resize.
The left/right header button remains available without a shortcut. Pane focus, tab
cycling, copy/paste, zoom, and reload bindings are unchanged.

The new aliases intercept Alt combinations that previously reached the PTY. After Alt
has been held for 1.314 seconds, buttons show Shift plus their letter and sidebar cards show workspace
ordinals. A small guide names Alt commands without a matching button. Tooltips show only
Alt bindings; the retained Ctrl bindings are documented but hidden in the app. Releasing Alt,
losing window focus, or hiding the page clears the guide.
