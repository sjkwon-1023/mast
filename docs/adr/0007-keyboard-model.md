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
   `Ctrl+Shift+arrows` (pane focus by on-screen geometry — `Alt+Shift+arrows` only since the
   2026-09-23 amendment — nearest centre in the direction's
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


## 2026-09-20 개정: Alt pane 이동과 닫기 후 포커스

Alt+Shift+방향키를 Ctrl+Shift+방향키와 같은 pane 이동으로 처리한다.
기존 코드는 문자 단축키에만 Alt 별칭을 허용해 방향키가 터미널로 전달됐다.
파일 탐색기에서는 왼쪽 방향키가 상위 경로로, 오른쪽 방향키가 선택된 폴더로 이동한다.
오른쪽 방향키는 파일이나 `..` 항목을 열지 않는다. Enter와 Backspace는 기존 동작을 유지한다.

닫기 명령의 응답보다 상태 스냅샷이 먼저 도착하면 다음 렌더가 없어서 포커스 복원이
누락됐다. 포커스 요청에 닫기·전환 명령을 함께 넘기고, 해당 결과가 스냅샷에 반영됐으면
즉시 복원한다. 결과가 아직 없으면 이후 렌더에서 다시 시도한다. 두 도착 순서를
실제 WorkspaceView와 폴더 뷰를 사용한 테스트로 검증한다.

## 2026-09-20 개정 (이어서): Alt+방향키를 실제 Alt 시퀀스로 전달

v0.3.30 이 `Alt+방향키`를 터미널에 돌려줬지만, 필드에서 Codex 질문 UI 의 `Alt+Up` 은
여전히 동작하지 않았다. 판정(`shared/keys.ts`)은 `Alt+방향키`를 통과시키고 window capture 도
손대지 않는데, xterm 5.5 의 `evaluateKeyboardEvent` 가 non-Mac 에서 Alt+방향키를
**Ctrl+방향키**(`ESC[1;5A` 등)로 바꿔 보내는 HACK 을 갖고 있기 때문이다(셸 단어 이동 관례).
PTY 에는 Alt 가 아니라 Ctrl 이 도착한다 — 실패는 가로채기가 아니라 인코딩에 있었다.

터미널 뷰의 `customKeyEventHandler` 가 `Alt` 단독(`Ctrl`·`Shift`·`Meta` 없음, IME 조합 아님)
방향키를 실제 시퀀스 `ESC[1;3A/B/C/D` 로 직접 보낸다. 판정의 단일 소스는
`features/terminal/interaction.ts::altArrowSequence` 다. `Alt+Shift+방향키` pane 이동과
`Ctrl` 계열(`Ctrl+Alt` 포함)은 그대로다. 대가는 셸 쪽에 없음을 확인했다 — bash readline 의
기본 바인딩은 `\e[1;3C/D`(실제 Alt)와 `\e[1;5C/D`(Ctrl)를 모두 단어 이동에 묶고 있어
(`bind -p` 로 확인) 단어 이동이 유지된다.

검증: 브라우저 빌드(@xterm/xterm)를 happy-dom 에 띄운
`apps/mast/src/features/terminal/alt-arrows.test.ts` 가 네 방향 모두 `writeStdin` 에
`ESC[1;3X` 가 나가는 것과 stock xterm 이 `ESC[1;5X` 를 내는 전제(우회로가 필요해진 이유)를
함께 잠근다. window capture 는 `apps/mast/src/app/navigation/actions.test.ts` 가
`Alt+Shift` 소비·plain `Alt` 통과를 실제 DOM 이벤트로 본다. 라이브 WebView2 전달과
Codex 질문 UI 동작은 필드 확인 대상이다 (WINDOWS-BUILD §10).

## 2026-09-23 amendment: Windows pane focus is Alt+Shift only; macOS terminal keys

**Windows (user decision).** Pane focus moves with `Alt+Shift+arrows` only. `Ctrl+Shift+arrows`
is no longer intercepted, so it reaches whatever has focus again: word-wise selection in the
Markdown editor, and `ESC[1;6A/B/C/D` in the terminal. This reverses the v0.3.30 binding and
the "terminal applications no longer receive `Ctrl+Shift+arrows`" cost recorded above. All
other `Ctrl+Shift` letter shortcuts and their `Alt+Shift` aliases are unchanged. Workspace
cards also enter the inline rename on a double-click of the name, on both platforms; `F2`
still works.

**macOS terminal keys (usability audit).** The terminal view claims the following, all inside
`features/terminal/view.ts`'s key handler and decided by `interaction.ts::macTerminalKeyAction`;
Windows never reaches that function.

1. `Cmd+Left` / `Cmd+Right` / `Cmd+Backspace` send `\x01` / `\x05` / `\x15` (start of line,
   end of line, kill line) — the Terminal.app and iTerm2 convention. `Cmd+Option+arrows` stay
   pane focus.
2. `Cmd+K` clears the screen and scrollback with xterm's `clear()` and sends nothing to the
   PTY. It is not claimed on the alternate buffer: that screen belongs to the full-screen
   program and has no scrollback, and clearing it would only corrupt it until the next redraw.
3. `PageUp` / `PageDown` / `Home` / `End` (`Fn+arrows` on a Mac keyboard) scroll the scrollback
   by a page or to the top/bottom, as in Terminal.app, **only** on the normal buffer with mouse
   tracking off. On the alternate buffer or while a program tracks the mouse the key goes to
   the program unchanged.
4. `Shift+PageUp` / `Shift+PageDown` send `ESC[5~` / `ESC[6~` to the program instead of
   scrolling. xterm's own default is the opposite (Shift+PageUp scrolls), so the pair is
   rerouted to match Terminal.app, where Shift is the way to hand those keys to the program.
   `Shift+Home` / `Shift+End` already reach the program through xterm (`ESC[1;2H` / `ESC[1;2F`).
5. `Option+arrows` are **not** rewritten on macOS. The Windows `ESC[1;3X` rewrite (the
   2026-09-20 amendment) exists to undo xterm's non-Mac Alt→Ctrl hack; on macOS xterm already
   sends Terminal.app's bytes — `ESC b` / `ESC f` for `Option+Left/Right` (shell word motion)
   and `ESC[1;3A/B` for `Option+Up/Down` — and the rewrite had been overriding that.
6. `Cmd+C` keeps the selection after copying: copy and interrupt are different keys on macOS,
   so the Windows reason for clearing it (the next `Ctrl+C` must reach the shell as SIGINT)
   does not apply.

The WebKit Korean IME adapter runs before this handler and commits any pending syllable on
every non-229 keydown, so a line-editing byte never overtakes the syllable being composed.
Outside the terminal, the text viewer takes `Cmd+Up` / `Cmd+Down` for its first/last window
and the folder browser takes `Cmd+Up` for the parent folder and `Cmd+Down` to open the
selection (Finder); other `Cmd` combinations are not read as their unmodified keys there.

Links in the terminal open on `Cmd+click` on macOS, not on a plain click, which is left to
selection and cursor placement. `settings.json`'s `macOptionIsMeta` (default `false`) turns
Option into Meta for the terminal, and `Option+drag` forces a text selection inside programs
that track the mouse (`macOptionClickForcesSelection`).

Verification: `apps/mast/src/features/terminal/mac-terminal-keys.test.ts` drives the real
xterm browser build in Mac mode and checks the bytes each key sends (or the buffer it
scrolls or clears), including a pending Korean syllable arriving before `Cmd+Left`'s byte;
the viewer and `keys.ts` suites cover the rest. Live WKWebView delivery of the `Cmd` and `Fn`
keys and the Windows `Ctrl+Shift+arrows` pass-through are field checks (`docs/MACOS.md`,
`docs/WINDOWS-BUILD.md`).
