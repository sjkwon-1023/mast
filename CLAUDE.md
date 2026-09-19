# CLAUDE.md

mast — a lightweight cmux-style terminal for Windows, centered on WSL2 and coding agents
(Claude Code / Codex). Decisions: `docs/adr/`.

The product plan `터미널-계획-v2.md` (Korean) is **no longer in the tree** — it was removed
when the repo went public. Roughly 120 "계획 v2 <n>장 / section <n>" citations across the
source comments, ADRs, and the remaining plan docs still point at it; read it out of git
history when one of them matters (`git show HEAD~1:터미널-계획-v2.md`, or any commit before
its removal).

## Current state

**MVP stages 10–22 are complete and Windows-verified**: checkpoint 2 passed 2026-08-09
(three field defects fixed the same day) and its re-verification round passed in full
2026-08-10. The manual checklists in `docs/WINDOWS-BUILD.md` sections 6–10 stay as
regression references. Stage 22 (CI) is live — the gates run on every push, x64 + ARM64
artifacts build on `workflow_dispatch`. **Remaining: stage 23**, ARM64 device testing
(`docs/WINDOWS-BUILD.md` §11), which awaits hardware.

Every decision behind those stages lives in `docs/adr/`: stack adoption (0001),
stage-10 architecture (0002), split/tab UI (0003), lifecycle + persistence + reset with
the hard-won ConPTY findings (0004), inter-pane text passing and its UI retirement
(0005), OSC notification routing (0006; agent state per tab since 0026), the keyboard
model and the canonical interception list (0007), viewer tabs (0008). Stage 19 (git branch display) is deferred
to v2 with `git_branch`/`git_dirty` reserved on the model.

Every release through **v0.3.8 is field-verified** (2026-08-13 round): the toast pipeline
end to end (AUMID registration, OS-signal focus gate, direct WinRT delivery, the widened
focused-but-other-workspace case), viewer fonts and viewer zoom, Codex resume hints, and
the earlier post-re-verification batch (Shift+Enter as ESC CR, sidebar reflow, workspace
creation, icons). The WINDOWS-BUILD §10 subsections per release stay as regression
checklists. One field lesson worth keeping: synthetic needs-input tests must reset state
first (`mast:idle` then `mast:needsInput`) — the onset only fires on a transition, and
two rounds were burned on stale-state and wrong-token test artifacts that looked like app
defects.

### Product principles

mast is a **lightweight multi-agent coding workspace for Windows + WSL2**. The goal is not to
grow into an IDE; it is to make several terminal coding agents easy to run, inspect, switch
between and control while the cost of the parts you are not looking at stays near zero. The
constraints that follow from that, and which every entry in the backlog below is weighed against:

- Keep the Rust/session side durable and the WebView side disposable.
- Do not keep inactive workspace renderers alive just to preserve UI state.
- Bound queues, replay buffers, caches, and every other long-lived structure.
- Prefer lazy, read-only viewer surfaces over embedding an editor or IDE runtime.
- Preserve agent sessions across UI resets; a backend restart is never a routine
  memory-recovery mechanism.
- Add a feature only when its idle cost stays small for a user with many workspaces and agents.

### Non-goals

Not "not yet" — these are the shapes the product declines, so a proposal that needs one of them
needs to argue against this list first.

- Keeping every workspace's xterm/renderer alive just to preserve visual state.
- Becoming a full code editor or IDE.
- Supporting PowerShell/CMD profiles; WSL2 remains the terminal execution model.
- Restarting the Rust backend as a memory watchdog action.
- Adding always-on services whose idle cost scales with the number of workspaces, unless the
  feature clearly requires it.

### Backlog

Grouped by the surface an item belongs to. Inside a group the open work comes first and the
landed records follow — a record is kept only for the decisions and the rejected alternatives
it carries, so read it before reopening the same question. Nothing here blocks the MVP.

#### Terminal panes, tabs and splits

- **No way to split *around* an existing split** (user request 2026-08-15, not started) —
  with a pane already split top/bottom, nothing adds a pane spanning the full left or right
  side; only one of the two halves can be split again. The tree already **represents** the
  wanted shape (`Split{horizontal, first: Split{vertical, A, B}, second: Leaf{C}}`) and
  renders, resizes and persists it — what is missing is a command that reaches it.
  `SplitTree::split` matches a `Leaf` by `PaneId` and replaces it in place
  (`model.rs:250-274`), and `SplitPane` is the only split command, so every surface (the two
  header buttons, `Ctrl+Shift+D` / `Ctrl+Shift+E`) can only ever target one leaf; `ResizeSplit`
  is the sole command addressing a `SplitId` and it only moves a ratio. ADR-0003 neither
  decided nor deferred this — it was never raised. The smallest useful shape is a **root
  wrap** (`SplitRoot { direction, tab }`: the whole workspace tree becomes one side of a new
  `Split`, the new pane the other), because "the entire left/right side" is a root-level
  request in practice and the target is then unambiguous in the UI — which a general
  `SplitNode { node: SplitId, … }` is not, since nothing lets a user point at a subtree three
  levels down. One contract question rides along: `split` always puts the new pane in
  `second` (right/bottom), so a root wrap either takes the insertion side as a parameter or
  is right/bottom-only.

- **Codex transcript and scroll position did not survive a workspace round-trip — landed
  2026-09-12** (v0.3.24). The suspected culprit was innocent: measurement on the user's own
  `codex-cli 0.153.4` showed its default UI never touches the alternate screen and never enables
  mouse tracking, so the transcript is plain normal-buffer scrollback and the scroll position is
  xterm-side state (`viewportY` vs `baseY`) that the replay cannot carry — the nudge is
  irrelevant to it, and in fact *rebuilds* a Codex tab's scrollback (a resize makes Codex reprint
  its whole history, ~96 KB / 1,038 lines, which reconstructs 972 lines even from an 8 KiB
  replay). Fixed front-end only: `WorkspaceView` remembers the bottom-relative offset of a tab it
  disposes on workspace leave and `TerminalView` re-applies it after the replay, on every parsed
  chunk while the reprint runs, and once when that output goes quiet — cancelled by a key while
  that pane has focus, a wheel notch, or a scrollbar drag (a click to focus the pane does not).
  A position the rebuilt scrollback no longer has is **refused**, not clamped to line 0:
  `scrollToLine` latches xterm's `isUserScrolling`, so a clamped restore froze the pane at the
  top of the transcript for good. Releasing that latch is the subtle half — in the *browser*
  build `scrollToBottom()` goes through `Viewport.scrollLines`, which returns at a zero delta and
  never reaches the buffer service that clears the flag, so a release asked for at the reprint's
  `ESC[3J` (`ybase = ydisp = 0`) is a no-op and is deferred to the next chunk; a key cancel
  releases too, a wheel or scrollbar cancel does not (that scroll is the user's). `@xterm/headless`
  clears it there, which is why a headless probe passed and a peer review against the real
  browser build did not. Decisions
  and the accepted limits (WebView-lifetime memory, heuristic settle window, ~192 KB of replay
  per round-trip still unaddressed): [ADR-0019](docs/adr/0019-restore-terminal-scroll-across-workspace-round-trip.md).
  Verification: WINDOWS-BUILD §10 v0.3.24. **Follow-up 2026-09-12** (v0.3.26): the same jump
  happens with no round-trip at all — a scrolled-up Codex tab goes to the top of its transcript
  on a window resize, and on Windows also when an answer ends (that trigger is unmeasured).
  Cause: xterm's ED 3 (`ESC[3J`) empties the scrollback without clearing `isUserScrolling`, so a
  pane the user scrolled up stays pinned at line 0 while the reprinted history stacks below it.
  The front end now hooks ED 3 in the parser — a custom CSI handler runs before xterm's, so it
  still sees the pre-wipe offset — and hands that offset to the v0.3.24 restore machinery
  unchanged; a pane at the bottom is left alone, and a position the reprint no longer has is
  refused to the bottom as before. ADR-0019 amendment (v0.3.26); verification: WINDOWS-BUILD §10
  v0.3.26.

- **1MiB-replay workspace switch is ~236ms with visible flicker** (ADR-0004) — candidates:
  smaller replay cap, progressive replay, hide-until-parsed. Since v0.3.15 the replay
  window is no longer the only carrier of terminal modes (ADR-0015 re-asserts them from
  the session instead), so shrinking the cap no longer trades bracketed paste, the alt
  screen or mouse tracking away — only redraw fidelity. Sequenced behind the *Codex transcript
  and scroll position* item: if a reattach still feels slow once that lands, shrinking the cap
  or replaying progressively is the next lever.

- **Attach-time redraw fires even for a session already attached in this WebView lifetime —
  closed 2026-09-12** (ADR-0019 decision 6). Narrowing it would drop the resize reprint that
  rebuilds a Codex tab's scrollback from whatever the replay window happens to hold, which is
  worth more than the redraw it saves. The remaining open cost is the ~192 KB of replay each
  round-trip spends on that reprint; the cheaper lever is one resize instead of the current
  two-step nudge, not skipping it.

- **Korean typed into a busy pane lost syllables and spaces — fixed 2026-09-12** (user
  reports 2026-08-22 and 2026-09-12, v0.3.26). `테스트 문장` came out as `테 테  테 `; rare,
  Korean only, and clicking another pane cleared it. Not Claude Code — it only ever receives
  committed UTF-8 — and not the same-millisecond `compositionend`/`compositionstart` pairs the
  opt-in log showed, which are simply 두벌식 moving a trailing consonant to the next syllable.
  The fault is `@xterm/xterm` 5.5.0's `CompositionHelper`: it defers each send with
  `setTimeout(0)`, coalesces queued sends through one boolean, and reads a stale one-character
  `[start, end)` window whenever two or more keys are processed before that timer runs — a busy
  main thread (a pane pouring output next door; the diagnostic log's own IPC per composition
  event makes it *more* likely, not less). Reproduced on the real bundle: flushing the timer
  every three keys turns the sentence into `테트문장`. Upstream fixed the expression three days
  after 5.5.0 shipped (`52e8a75e9f`, xterm.js #5023) but only 6.0.0 carries it, and 6.0 rewrote
  the viewport that ADR-0019's latch analysis depends on. Fixed by patching that one expression in
  the shipped bundle at build time (`tooling/xterm-composition-patch.ts`, on both the Rollup and the
  esbuild pre-bundle path), throwing unless it occurs exactly once, with `tooling/ime-composition.test.ts`
  driving the stock and the patched bundle through the event sequence. **Still open**: whether
  the 2026-08-22 "stuck composition, every shortcut dead" report was this fault plus a blur (a
  syllable repeating verbatim needs `start` to stop advancing) — the `shared/keys.ts:216` `isComposing`
  guard and the composition log lines stay until a reproduction says. The eventual answer is the
  xterm 6 upgrade as its own change.
  [ADR-0020](docs/adr/0020-patch-xterm-composition-at-build-time.md). Verification:
  WINDOWS-BUILD §10 v0.3.26 items 7–8.

- **Splitter resize is mouse-drag only** — no keyboard equivalent for the drag handle. The
  smallest of the accessibility gaps rather than the only one.

- **Per-pane split-button affordance** (ADR-0004) — a first-time user read the header
  buttons as "split the *selected* pane".

- **The `◎` browser tab button** was removed from the pane header (permanently disabled,
  taking up space); it returns in v2 with the feature behind it, and only if an unused
  browser tab can be isolated well enough to cost nothing at idle.

- **A workspace round-trip cost a long-running pane its terminal modes — fixed 2026-09-05**
  (user report, v0.3.15). Two short lines pasted into a busy Claude Code pane submitted the first
  one: DECSET/DECRST modes lived only in the front end's xterm instance, and a re-attach
  (workspace switch, F5, the idle webview reload) builds a **new** `Terminal` that re-derives
  everything from the 1 MiB replay — a TUI that enables bracketed paste once at startup loses it
  once a megabyte of output has evicted that sequence. bash never showed it because readline
  re-enables the mode at every prompt. Fixed in the core: the scanner gained a CSI branch, the
  session keeps each private mode's current value, and `reattach()` prepends `ESC[?<n>h/l` for
  them ahead of the replay — mouse tracking, DECCKM and cursor visibility come back with paste.
  Decisions: [ADR-0015](docs/adr/0015-reassert-terminal-modes-on-reattach.md). Verification:
  WINDOWS-BUILD §10 v0.3.15. **Still open**: the alt screen is deliberately *not* re-asserted (a
  pre-replay `?1049h` swallows the pre-vim scrollback), so a TUI whose `?1049h` was evicted still
  returns on the normal buffer — the candidate is re-asserting only modes whose last change is
  older than the replay window; and a paste during the replay gate is logged, not buffered.

- **A split or a new tab opened at the workspace root, not where the pane's shell was —
  fixed 2026-09-05** (user report, v0.3.14). Not a regression: every terminal-creating surface
  had passed `cwd: null` since the split UI existed, and the core resolves that to the
  workspace `root_path` — ADR-0011 made a tab's `cwd` *track* its shell, but nothing ever read
  the value back when creating the next shell. The "follows the pane" behaviour the report
  remembered is `Ctrl+Shift+N`, which reuses the cwd as a **new workspace's** root. Fixed in
  the front end (user choice, the lighter of the two): `shared/keys.ts::paneTerminalCwd` reads the
  source pane's shown tab, and the five creating sites — header `+`, both split icons,
  `Ctrl+Shift+T`, `Ctrl+Shift+D`/`E` — pass it as the tab `cwd`; a shown viewer tab yields
  `null`, i.e. the old root behaviour. A shell that never reports (a `.bashrc` that execs
  another shell) keeps its spawn-time cwd — the root for a first tab, the inherited path for a
  tab this change created — since the core fills `cwd` at spawn. The core contract
  (`NewTab::Terminal { cwd: None }` → `root_path`) and its tests are untouched; the rejected
  alternative, resolving inheritance inside `SplitPane`/`CreateTab`, would have covered every
  future surface at once at the cost of rewriting that contract and four core tests. The value
  is the last **prompt-time** cwd (ADR-0011's limit), so a pane whose agent `cd`'d on its own
  still splits where the shell last drew a prompt. `Ctrl+Shift+N` behaves as before and now
  shares the helper. Verification: WINDOWS-BUILD §10 v0.3.14.

- **A tab's cwd never advances, so a restart reopens every shell at the workspace root** (user
  report 2026-08-15). The restore path itself is fine: `respawn_tab` (`command.rs:803`) reads the
  tab's stored `cwd` and spawns there, which is exactly the point of the feature. What is missing
  is anything that ever *updates* that value. The contract already says `OSC 7 file://host/path`
  carries "Tab cwd (respawn location on restart)", the scanner parses it and `notify.rs:71`
  applies it — but **provisioning never wires a shell to emit it**: `provision.rs` installs the
  OSC 777 channels only, and the OSC 0/7 prompt snippet in `scripts/wsl/claude-hook-example.md`
  is manual-install advice. Field state confirms the consequence — every terminal tab in
  `state.json` carries the same `cwd` as its workspace `rootPath` regardless of where the shell
  actually went. **Fixed 2026-08-20** (v0.3.10) — but *not* the way this entry predicted. A
  provisioning line into `~/.bashrc` needs a re-provisioning round trip to take effect, edits a
  file we have never written to, and lands wrong against `starship` at the placement it needs
  (measured). The emitter is injected from the spawn wrapper's env assignment list instead
  (`host.rs`), so it applies on the next launch and touches nothing the user owns; starship
  preserves an inherited `PROMPT_COMMAND` and runs it after its own precmd (verified in a pty).
  OSC 7 only — never the title half of that snippet, which would overwrite agent tab titles.
  The destination `cd` also moved out of `wsl.exe --cd` into the wrapper: `--cd <deleted path>`
  makes the relay skip the command entirely while still exiting 0, which after this change would
  turn a deleted directory into a tab that cannot start. See
  [ADR-0011](docs/adr/0011-tab-cwd-tracking.md).

- **A tab whose shell died stayed dead forever — fixed 2026-08-20** (user report, v0.3.9).
  Field diagnosis: the machine slept at 07:28 with mast running, WSL went down with it, and
  the app recorded all ten `SessionExited` events (`code: 1073807364` = `0x40010004`,
  `DBG_TERMINATE_PROCESS`) into `state.json`. `Exited` was an **absorbing, persisted** state —
  `sanitize` kept the status while clearing `pty_session`, the boot respawn enumerates
  `Running` tabs only, `respawn_tab` rejected `Exited`, and v0.3.8 had no front-end respawn
  binding at all — so every relaunch produced an empty pane with an `exited` badge and no way
  back. A normal app quit never caused it (nothing kills the PTYs before the exit flush, and
  Tauri leaves via `std::process::exit`); the trigger is a shell dying *while the app is up*:
  sleep/shutdown, `wsl --shutdown`, WSL OOM, or typing `exit`. Landed: `respawn_tab`
  accepts `Exited` (killing the stale replay session first), the ADR-0009 pane banner now
  covers `exited` with a **Restart** button, and restore normalized `Exited` → `Running` so a
  restart revived every tab in its stored `cwd` — that last half was reversed by ADR-0018, which
  keeps `Exited` across a restart so the record is still there to read (the `NotStarted`
  normalization below stands). Revival keeps the tab id, so `HISTFILE` and the
  per-tab resume hint come back with it — `↑` gives `claude --resume <id>`. Decisions and the
  rejected alternatives: [ADR-0010](docs/adr/0010-restart-dead-terminal-tabs.md). Verification:
  WINDOWS-BUILD §10 v0.3.9 item 4. **Follow-up the same day** (v0.3.10): the first boot that used
  it revived 11 tabs at once and 6 shells never started — 13 `wsl.exe` inside one second lost the
  race with a cold VM (no zombie relays; live `bash -l` matched the 5 `running` tabs exactly). Boot
  now warms each distro once and paces respawns (`boot.rs`, `MAST_RESPAWN_STAGGER_MS`), off the
  setup thread, and `NotStarted` is normalized on restore too so a restart retries a partly failed
  wave. See the ADR-0010 amendment. **Still open alongside it**: the tab `cwd` gap (*A tab's
  cwd never advances*) means a revived tab reopens at the workspace root rather than where the
  shell had moved to.

- **Links in a terminal tab went nowhere — fixed 2026-08-20** (user report, v0.3.10). Two
  different causes wearing one symptom. Clicking: xterm had no link machinery at all (no addon,
  no `linkHandler`), and there was nowhere to send a URL anyway — no opener command, no plugin;
  `window.open()` is swallowed by wry and a plain `<a href>` would navigate the app UI away.
  OAuth auto-open: a stock WSL distro has no `xdg-open`/`wslview` and no `$BROWSER`, so Claude
  Code's `$BROWSER ?? xdg-open` hits ENOENT and degrades to "copy this URL manually" (its
  headless escape hatch never fires under WSL). Interop and the default-browser registration were
  healthy the whole time. Landed: web-links addon + an `open_url` command on `ShellExecuteW`
  (http/https only, checked on both sides, suppressed while a TUI holds mouse tracking), and a
  provisioned `~/.mast/bin/mast-open` installed under the name `xdg-open` — not a `$BROWSER`
  export, which would take Codex off the WSL path its own crate already handles. The URL never
  touches a Windows command line on either side. See
  [ADR-0012](docs/adr/0012-opening-links.md). Verification: WINDOWS-BUILD §10 v0.3.10 item 3.

- **No scrollbar in a terminal pane — fixed 2026-08-22** (user report, v0.3.11). Scrolling
  worked; there was simply no bar to see position or drag. Nothing in the app hid it and
  xterm's own `.xterm-viewport` is `overflow-y: scroll`, so the cause is outside the app:
  WebView2 follows the Windows *Always show scrollbars* setting, and with it off (the Windows 11
  default) Chromium renders **overlay** scrollbars that fade out when idle. On a terminal
  scrollback, where "where am I" is the information, a bar that is only visible while you are
  already scrolling is the same as no bar. Fixed app-side and app-wide with an explicit
  `::-webkit-scrollbar` rule set (10px, themed thumb): giving the pseudo-element a width makes
  Chromium fall back to the classic space-occupying bar regardless of the OS setting, and one
  rule covers the viewers and sidebar too rather than leaving the terminal the only surface with
  a bar. Verification: WINDOWS-BUILD §10 v0.3.11 item 3 — field-only, since the whole cause is
  a rendering mode this dev box does not have.

- **Ctrl+= / Ctrl+- terminal zoom — landed 2026-08-12** as **session-only** (no write-back:
  relaunch returns to the `settings.json` size, Ctrl+0 resets to it), window-wide across all
  tabs, clamped to the backend's 6-72 range; Ctrl+- shadows the terminal's C-_ (emacs undo)
  as an accepted trade-off, same class as Ctrl+1-9. Verification: WINDOWS-BUILD §10 v0.3.4.
  - **Extended to the viewers — landed 2026-08-13** (user request, v0.3.8), reversing the
    v0.3.7 decision to keep zoom terminal-only. One key moves **both** surfaces by the same
    step — no per-surface zoom, because the moment you have to remember which surface grew,
    Ctrl+0 stops having one meaning. The two surfaces keep separate effective sizes and
    separate baselines (terminal 13px, viewers 12px) and clamp independently, so at 6/72 one
    can stop while the other still moves. What made this more than a CSS-variable write is that
    two viewers hold coordinates the resize invalidates, so `features/viewers/viewer-font.ts` now owns a live-view
    registry (the counterpart of `features/terminal/settings.ts`'s `liveViews`) driven in **two phases** —
    every view anchors its position *before* the variable changes, then re-seats itself after.
    `TextView` re-lays row height, spacer height and `scrollTop` around the **topmost visible
    line** (model coordinates are byte offsets, so holding the line holds the position and
    nothing goes back to the model). `MarkdownView` holds a **relative** anchor instead — its
    scroll coordinate is px and the prose reflows — and deliberately does not write the post-zoom
    px back, since a relaunch renders at the `settings.json` size where that px means a different
    place. The folder listing needs neither. The "never call this again after boot" warning on
    `features/viewers/viewer-font.ts` is gone with the hazard. Markdown prose now follows the **size** too (its
    face is still not the code font) — otherwise zooming a document left the prose behind, which
    partly supersedes a v0.3.7 decision. Verification: WINDOWS-BUILD §10 v0.3.8.

#### Workspaces and the sidebar

- **`git_branch`/`git_dirty` are reserved on the model and never populated** (2026-09-11, not
  started). Stage 19 deferred the display and the sidebar hides both fields while they are
  empty. Wiring them to the workspace root is the small half; bounding the refresh cost for a
  user with many workspaces is the half that decides the design.

- **Workspace order was fixed at creation order — draggable since 2026-08-22** (user request,
  v0.3.13). The sidebar list *is* `AppState.workspaces` order, so reordering needed no new
  storage and no persistence change; what was missing was a command that reaches it. The new
  `MoveWorkspace { workspace, before }` names the **neighbour to land in front of** rather than
  an index: an index carries the perennial "before or after removal?" ambiguity, and a stale
  front-end snapshot would silently drop the card somewhere else, where a missing neighbour
  fails cleanly as `UnknownTarget`. `before: None` means the end, and `before == workspace` is
  an in-place drop — allowed and a no-op. **`Ctrl+1`–`Ctrl+9` follow the new order**, which the
  user named as the point of the feature; `active_workspace` deliberately does not change, so
  tidying the list never yanks the screen (user decision). Front-end mechanics: pointer events
  (not HTML5 DnD — the splitter already sets that precedent and drag images / `dragleave`
  flicker are avoidable), a 4px threshold so a shaky click stays a click, one swallowed `click`
  after a drag, and the drop target computed from card **mid-heights** so every position in the
  list resolves to exactly one slot. The real hazard was the same one `reconcilePlan` exists
  for: agent status changes arrive on every OSC, so a rebuild mid-drag would swap out the
  element being dragged and break the pointer capture. `render` therefore does nothing while a
  drag is live and `endDrag` replays the skipped update — the same shape as the inline-rename
  guard. No ADR: every decision above is defended at its point of use (the `MoveWorkspace`
  rustdoc and the drag code), so one would only restate them. **Not done**: autoscroll when
  dragging past the visible list, which is why the drop boxes are re-measured on every move
  rather than cached — a short list makes both moot for now.

#### Viewers

- **Changes viewer — implemented 2026-09-13; Windows field verification pending.** The pane
  header opens a read-only file list and selected patch at the workspace root. Working /
  Staged / All and selection stay frontend-local; inactive views dispose immediately and mount
  refreshes the list. Git queries have byte/time/concurrency bounds. Bare containers resolve
  their default branch's worktree. [ADR-0022](docs/adr/0022-read-only-git-changes-viewer.md).
  **Release ordering:** ship the independent unknown-tab persistence repair (ADR-0021) before
  shipping this new persisted kind. Sending selected lines to agents, git writes, sidebar
  indicators and phone diffs remain outside the feature. **Responsive comparison (2026-09-13):**
  ordinary complete patches show colored Before/After changed sections, side-by-side at a
  pane width of 960 CSS px and stacked below it. CSS handles resizing; no extra Git query or
  editor dependency is added. Combined/non-textual/incomplete output stays unified, and a
  5,000-input-line display cap bounds DOM work. Details and limits: ADR-0022 amendment.

- **Reload while minimized** resumes markdown polling until the next minimize/restore
  cycle — accepted narrow window.

- **Syntax highlighting in the text viewer — landed 2026-08-12** (user request 2026-08-11)
  with highlight.js 11 behind **dynamic import only**: the entry bundle carries zero
  highlighter bytes (verified on the build output — core, one chunk per language and the
  vs2015 theme CSS are separate assets), so start-up and non-code files pay nothing.
  Opening a file always renders plain first and the colours are overlaid when the module
  lands (stale callbacks dropped on dispose / window change). The window is tokenized once
  and cached per line as the design note required, capped at 256 KiB per window
  (measured ~2 MB/s, so a full 512 KiB window would block the main thread for ~250 ms);
  over the cap the window stays plain. Language comes from an explicit extension map — no
  `highlightAuto` — filtered by `settings.json`'s `highlightLanguages` (default python,
  javascript, typescript, rust, json, toml, css, html; `[]` disables; unknown names are
  rejected loudly like `fontSize`). Supported names are exactly the shipped loader set,
  mirrored in `commands.rs::HIGHLIGHT_LANGUAGES` — widening it means adding a loader on
  both sides. Verification: WINDOWS-BUILD §10 v0.3.6 item 2.

#### Agent integration — hooks, notify, resume, the `mast` CLI

- **Agent coverage beyond Claude Code and Codex — Antigravity CLI and OpenCode landed; the
  branch merged both** (user request 2026-08-15). All four agents reuse the
  `mast:running` / `mast:needsInput` / `mast:idle` tokens **unchanged**: nothing in
  `mast-core` (`osc.rs`, `notify.rs`) or the front-end (`features/notifications/chime.ts`, `app/main.ts`) is
  agent-specific. The work is provisioning — a step in `provision.rs`'s `SETUP_SCRIPT`, a mode in
  `scripts/wsl/mast-hooks-merge.py` (where the merge rules live) and a hook script or plugin under
  `scripts/wsl/` embedded through `EMBEDDED_FILES` — plus a `SETUP_VERSION` bump, a
  resume-command entry in `host.rs::bash_argv`'s whitelist when the agent has one (today
  `claude --resume`, `codex resume` and `opencode --session`), and a matching section in
  `scripts/wsl/claude-hook-example.md`.
  - **Antigravity CLI — landed** (v0.3.32, setup v15, [ADR-0026](docs/adr/0026-tab-agent-state-and-hook-signals.md)
    decision 8; field verification pending). Only the **CLI** is in scope: the IDE's agents do
    not run in a mast tab, so there is no pts to emit into and no tab to attribute a toast to.
    `mast-hooks-merge.py agy` adds one named hook `"mast"` to the global
    `~/.gemini/config/hooks.json` (top-level keys are hook names, `PreInvocation`/`Stop` take
    flat handler arrays, and there is no Codex-style trust step): `PreInvocation` runs
    `mast-agy-hook.sh running` → `mast:running`, `Stop` runs `… idle` → `mast:idle` with the
    first line of `finalModelOutput` (else `done`). agy payloads carry no event name, hence the
    argument; handler stdout must parse as a JSON object, so the script prints exactly `{}`; it
    emits nothing outside a mast tab or when Claude Code or Codex started agy in the same tab.
    An identical `"mast"` is wired, an identical one with `enabled: false` is the user's opt-out,
    a different one is left alone with a notice, and any hook agy would reject is exit 3 — agy
    drops the whole file when one hook fails. Skipped without `~/.gemini/antigravity-cli` or
    with `~/.mast/no-agy-hooks`; before 1.1.10 `Stop` hooks never run (notice). **Still open**:
    **needs input** — the hook events have no `Notification`/`PermissionRequest` equivalent, so
    a tab waiting for an approval shows running. The candidate is `tool_confirmation_pending` in
    the `statusLine` script input, not taken because `statusLine` is a single user-owned setting
    whose re-invocation timing is unverified (`PreToolUse` must return a decision and a failure
    denies the tool). **No resume hint** — no `host.rs` whitelist entry. Unverified until the
    field round: Esc cancellation and its `terminationReason`, a `Stop` with `fullyIdle: false`,
    the skip-permissions and remote-control paths, hooks.json hot reload. Hook delivery has been
    in flux across versions, so a field check must name the CLI version it passed on.
  - **OpenCode default TUI status and resume hints — landed 2026-09-16** (setup v14;
    [ADR-0027](docs/adr/0027-opencode-plugin-status-and-resume.md)). OpenCode 1.18.31
    runs its default TUI server and plugin as a Worker in the tab process, with the tab's
    pts and `MAST_TAB` inherited. A single global plugin emits the existing three mast
    statuses through `mast-notify.sh` and records confirmed root session IDs for the
    restart shell's `opencode --session <id>` hint. The installer owns only plugin bytes
    matching its recorded digest; an existing user file is left untouched. The Windows
    TUI, toast, and restart checks remain pending in `docs/WINDOWS-BUILD.md`. `--pure`,
    server modes, the beta `opencode2` binary, and an agent-facing mast CLI guide remain
    outside this integration.

- **Agent-facing pane-send channel** — **landed 2026-08-11 as a shell CLI**, not MCP (user
  decision: MCP is heavy, and it is a v2 browser-surface question instead). `mast send`
  addresses a target by stable tab id (`'#181'`) as well as by title, and `mast ls`
  enumerates the tabs over a query channel (`OSC 777;mast-query`, reply written to a
  `/tmp` file the caller names). Contract in `scripts/wsl/claude-hook-example.md`, agent
  surface in `scripts/wsl/skills/mast-send/SKILL.md`, verification in WINDOWS-BUILD §10.
  Still open: **reading a pane's scrollback** (enumeration is metadata only — an opt-in
  design is needed before any output leaves a pane), and `mast ls`'s **`COMMAND` column
  showing `?` for a tab whose shell is in another distro or a Windows shell** (it is read
  from this distro's `/proc`). Keyboard targeting for the old manual send mode stays absorbed
  by the stage-17 retirement — it is not coming back.

- **Cross-workspace send/`ls` would need an explicit opt-in** — both halves of the agent
  channel stop at the requester's own workspace (2026-08-11 decision, ADR-0005 addendum); if
  reaching another project's pane ever becomes a real need it arrives as a named opt-in, never
  as the default radius.

- **Query-reply `/tmp` confinement is string-level only** — a pre-planted symlink
  (`/tmp/x → $HOME`) routes the reply write outside; blocking it needs a
  canonicalize-at-write recheck whose 9P semantics are unverified on real hardware
  (review finding 2026-08-11; docs state the honest contract).

- **Resume-hint ↑ integration is bash-only** — a `.bashrc` that execs zsh/fish would
  read its own history (hint line still shows, ↑ would not). Informational: the
  2026-08-12 field failure was NOT this — it was the `wsl.exe --` double evaluation,
  fixed by `--exec` in v0.3.3 and field-confirmed.

- **Agent state is per tab and driven by the agents' hooks — landed 2026-09-15** (v0.3.32,
  setup v15; Windows field verification pending). Three defects at once: Codex only ever reported
  idle (legacy `notify` was its one signal); a single workspace status slot with an
  `agent_status_source` let a sibling's idle hide a running tab, a closed tab reset live ones and a
  second waiting tab go unannounced; and Claude Code sat at needs input from an approval until
  `Stop`, while the `""` Notification matcher turned `idle_prompt` into needs input a minute after
  every turn. The token contract and the agent-agnostic core are unchanged; no screen, title or
  process detection. **Core**: `Tab` carries `agent_status`/`last_agent_message`, and the
  workspace fields are a stored derivation — the most urgent tab; the preview is the newest
  message among waiting tabs while the workspace waits, the newest overall otherwise; recency is a
  per-OSC-batch sequence, not the clock, ties to the smaller tab id. `validate()` is untouched and
  `PERSIST_VERSION` stays 1. **Dispatcher**: `~/.mast/bin/mast-agent-hook.py` (Python 3.8, run
  from argument-less entry points through the interpreter recorded in `~/.mast/bin/mast-python`)
  keeps a flock'd, bounded `~/.mast/agent-hooks/tab-<id>.json` (deleted on tab close, ADR-0013)
  and writes OSC 777 itself — a blocking write with a deadline and a BEL so no unterminated OSC
  eats agent output, stdout always empty, exit 0 (only `codex-notify` exits 1, when it died before
  trying to write, so the notify script can fall back to its own idle). *Claude*: `PermissionRequest` records a
  wait keyed by session, scope and canonical input; `PostToolUse`/`PostToolUseFailure` release it
  and emit running once none remain; `PostToolBatch`, `SubagentStop`, root prompts, `Stop` and
  `SessionStart` (startup/resume only) clear waits by rule; the Notification matcher is narrowed to
  six needs-input types by a dict-identical self-migration. *Codex*: seven hooks appended to
  `~/.codex/hooks.json` with one fixed command so trust keys and hashes stay stable (never
  `config.toml`, no `trusted_hash` writes); they do nothing until the user trusts them in Codex.
  Sync `PreToolUse` records the call, async `PermissionRequest` raises needs input only if that
  call is still unfinished after a 2 s hold-off, `PostToolUse` releases, `Stop` goes idle with the
  last answer as the body and `Interrupt` with `interrupted` (both needs input instead while a
  subagent's approval is still shown), `SubagentStop` cleans up. `mast-codex-notify.sh` keeps its
  line and resume hint but hands the idle to the dispatcher's `codex-notify` judgement
  (resumable/confirmed/rejected/unknown ownership; handled, late, nested and previous-session
  notifies are dropped, a rejected one never falls back). *Antigravity CLI*: running/idle, see the
  coverage entry above. **Provisioning** (`mast-hooks-merge.py`, Python 3.6): symlink-preserving
  atomic writes with a re-read before replace, snippet notices for read-only or dangling targets,
  exit 3 for deterministic content refusals with `~/.mast/no-codex-hooks` / `no-agy-hooks`
  opt-outs, sub-markers `.setup-v15-codex` / `.setup-v15-agy` so an agent installed later runs only
  its own step, and version gates over fixed install locations where the lowest copy decides —
  Claude Code below 2.1.118 or unreadable gets status rows only, Codex notices at
  0.124/0.129/0.131/0.133/0.148/0.150, agy below 1.1.10. A 173 KB script made `run()` tolerate
  `BrokenPipe` when a marker lets bash stop reading early. Decisions, rejected alternatives and the
  full limits list: [ADR-0026](docs/adr/0026-tab-agent-state-and-hook-signals.md). Verification:
  WINDOWS-BUILD §10 v0.3.32 — **not yet run**. **Open, most consequential first**: Codex needs
  input is a timing heuristic — an auto-approved call running past 2 s toasts, an approved long
  command shows needs input while it runs, any denial or an approved call that then fails holds
  needs input until the turn ends (a subagent's until it stops), and an aborted subagent approval
  sticks for the session; Claude's feedbackless denial leaves needs input or
  running until the next prompt, and every root prompt's status-row running (task-notification
  wakeups included) replaces a subagent dialog's needs input; Antigravity has no needs input; the
  per-tool-call hook latency targets (p95 under 100 ms added) are unmeasured; and no Python 3.6
  interpreter, `wsl.exe` relay or Windows-only glue test has run against this change.

- **`mast send` submitted to shells but not to TUI agents — fixed 2026-08-22** (found in
  the field 2026-08-15, v0.3.11). `cmd_send` appended **LF** (`printf '%s\n' "$text"`, the CLI
  heredoc in `provision.rs`). A shell ran the line because its line discipline takes LF as
  end-of-line, but a raw-mode TUI did not — the terminal sends **CR** for Enter, so Codex and
  Claude Code took the text into their prompt and then sat there, never submitting. Confirmed
  both ways: a send to a Codex tab pre-filled but never ran, and a bare CR to that same tab
  started it immediately. The contract carried the assumption in its own wording — "Include the
  newline if the target **shell** should run the line" — while the channel exists precisely to
  hand work to *agents*, which is what the skill advertises. Now it appends `\r`: a shell's
  `ICRNL` turns CR back into NL, so the shell case is unchanged, and the same byte submits in a
  TUI. `SETUP_VERSION` 9 reinstalls the CLI for existing users; the contract doc and both copies
  of `SKILL.md` (tracked, and the one embedded in `provision.rs`) say CR now. Verification:
  WINDOWS-BUILD §10 v0.3.11 item 1 — field-only, since the failure is inside an agent's TUI.
  **Follow-up 2026-09-05** (v0.3.16): a *long* line still did not submit — the byte was right but
  it shared a write with the text, and both TUIs treat a burst that lands in one read as a paste
  (Codex's `paste_burst.rs`, Claude Code's chunk-length rule), where a CR is a newline. Seen in
  the field on a `/peer-review` reply of ~120 bytes. The CLI (setup v10) now sends the CR as a
  **second OSC 200 ms after the text**; the app writes each send as it arrives (`Osc777Send` is
  an action, never batched by the router), so the gap survives to the PTY. Any raw sender of
  the OSC contract has to do the same. Verification: WINDOWS-BUILD §10 v0.3.16.

- **The resume hint covers Codex too — landed 2026-08-12** (setup v7). A new
  `~/.mast/bin/mast-codex-notify.sh` reads Codex's notify payload from `$1` (it arrives as
  the final **argv** element, not on stdin), records `codex resume <thread-id>` in the same
  per-tab file the Claude hook writes, and delegates the `mast:idle` emission to
  `mast-notify.sh` — whose body is now Codex's last message rather than a fixed string.
  Both agents write one file, so **the last agent to finish a turn in a tab wins**, and the
  spawn wrapper's read guard is a whitelist that now takes `codex resume <token>` as well.
  The exclusion that blocked this was the "never rewrite an existing `notify`" rule; it is
  resolved by a **self-migration** narrow enough to keep the rule: the *only* value ever
  replaced is one byte-for-byte identical to the line mast itself wrote (unchanged from
  setup v2 through v6; re-parsed with `tomllib` and value-checked before the write when
  `tomllib` exists — without it the in-place swap proceeds unverified). Every other `notify`, hand-edited variants of
  our own line included, is left untouched with a log line naming the replacement. Payload
  keys are kebab-case (`thread-id`, `last-assistant-message`) as of `codex-cli 0.147`, with
  the snake-cased spellings accepted as a fallback; no version probe — a payload we cannot
  read notifies without a hint. Contract: `scripts/wsl/claude-hook-example.md`. Verification:
  WINDOWS-BUILD §10 v0.3.5. **Follow-up 2026-09-13 (v0.3.29, setup v12):** Codex 0.154.0's temporary
  catch-up summary also fires `notify` with the pane's `MAST_TAB`, overwriting the hint with
  an unsaved thread id. The writer now requires matching saved top-level `session_meta`
  (`source: cli/exec`), rejecting temporary threads and persisted subagents. The bounded
  transcript check preserves the old hint if it cannot confirm a session; this is an
  observed-format compatibility check, not a stable Codex API. The contract above records
  the storage assumptions and upgrade limits. `tests/codex-resume.test.ts` runs the real Bash
  writer and restart history path on Linux; Windows verification remains in §10.

- **Codex composer pill: closed as out-of-app (2026-08-12)** — the field probe showed
  conhost consuming OSC 11 queries without answering anyone, so no app-side lever
  exists; upstream is openai/codex#19741. Responder + THEME_SYNC stay as no-cost
  coverage for other conhost versions.

#### Notifications

- **Windows toast notifications on needsInput — landed 2026-08-12** via the official
  `tauri-plugin-notification` (+ the `notify_toast` glue command), fired **only while the
  window is unfocused** (`document.hasFocus()` false) on the chime's own onset rule — one
  toast per transitioning workspace, chime alone when focused. Still a field check: toast
  sender identity for an unsigned standalone exe (WINDOWS-BUILD §10 v0.3.4).
  **Superseded by the v0.3.7 entry "Toasts still did not appear once the identity was
  registered"** — the plugin, that focus source and the chime are all gone.

- **Toasts do not appear at all in the field — landed 2026-08-12** (user report 2026-08-12,
  v0.3.5): the card-style Windows notification never showed, focused or not. Root cause
  **confirmed 2026-08-12**: Windows Settings › Notifications had no mast entry at all
  (screenshot checked), i.e. the shell had never seen an app identity to attribute toasts to —
  an unpackaged, unsigned exe registers no AppUserModelID / Start-menu shortcut, and WinRT
  drops toasts from unregistered senders silently. Fixed by `src-tauri/src/app_identity.rs`,
  called at the very top of `main()` (before the webview and plugin init): it calls
  `SetCurrentProcessExplicitAppUserModelID` and creates/refreshes
  `%AppData%\...\Start Menu\Programs\mast.lnk` with `PKEY_AppUserModel_ID`, idempotently —
  same target + AUMID means no write, a moved exe rewrites the target (the version-swap case).
  The AUMID is **`app.mast.desktop`**, i.e. `tauri.conf.json`'s `identifier`, because that is
  what the plugin puts on the toast (`tauri-plugin-notification` 2.3.3 `desktop.rs:27` takes
  `app.config().identifier`, `desktop.rs:195-206` sets it as the app_id unless the exe sits in
  `target\{debug,release}`); a `const` assert against `tauri.conf.json` breaks the build if the
  two ever drift, since a mismatch would fail silently. The dev-directory exception is mirrored
  in `plugin_uses_our_aumid` so dev builds do not litter the Start menu — they keep the
  plugin's PowerShell-sender fallback. Failure logs one loud line and never blocks boot.
  Verification: WINDOWS-BUILD §10 v0.3.6 item 3 (all of it is field-only — none of it could be
  exercised on the Linux dev box). The AUMID-derivation and dev-exception halves of this entry
  were rewritten in the v0.3.7 entry that follows this one in this group; the registration
  mechanism itself is unchanged.

- **Toasts still did not appear once the identity was registered — redesigned 2026-08-13**
  (field diagnosis, v0.3.6). The identity work above was *correct*: `Get-StartApps` lists
  `mast app.mast.desktop`, and a hand-run
  `CreateToastNotifier("app.mast.desktop").Show(...)` in PowerShell puts a card on screen, so
  the OS pipeline is proven. Inside the app the onset fired (the chime rang) and no toast
  followed, leaving **two suspects that could not be told apart from inside the app**: (a)
  WebView2's `document.hasFocus()` staying `true` while the window is unfocused, which would
  make the front-end suppress every toast, and (b) `tauri-plugin-notification` swallowing send
  errors — 2.3.3 `desktop.rs:216` is literally
  `tauri::async_runtime::spawn(async move { let _ = notification.show(); })`. Rather than guess,
  **both layers were removed**:
  - Focus comes from the OS: `main.rs` already had `WindowEvent::Focused` for the reset policy
    and now also emits `window-focus` (bool) to the front-end, which keeps a `windowFocused`
    flag. `document.hasFocus()` is no longer used anywhere. The flag is **subscribed and then
    seeded**: window events only fire on a *change*, but this front-end also restarts on the
    automatic webview reload — whose main trigger is "hidden/unfocused for N minutes", i.e. the
    reloaded page comes up unfocused with the transition long past. Assuming focus there would
    suppress exactly the toast the user stepped away to receive, so `installWindowFocus`
    subscribes first, then asks `getCurrentWindow().isFocused()` once and applies the answer only
    if no event beat it (review finding 2026-08-13; the query is inside `core:default`, so the
    capability did not change).
  - Sending is direct: `notify_toast` calls `tauri-winrt-notification`'s
    `Toast::new(app_identity::APP_USER_MODEL_ID)` itself — **sender AUMID = registered AUMID =
    one constant** — and returns the `show()` error instead of dropping it. The plugin, its
    `notification:default` capability and its lock entries are gone; the crate that used to sit
    at the end of that chain is now a direct dependency, so the graph shrank. Because we now
    always send under our own AUMID, `plugin_uses_our_aumid`'s dev-build exception lost its
    basis and was deleted — dev builds register the Start-menu shortcut like any other, or their
    toasts would die silently.
  - Diagnosis has a field-visible window: every attempt appends one timestamped `ok`/`err` line
    to `%AppData%\app.mast.desktop\toast.log` (best-effort, body not logged, truncated past
    64 KiB), so the next round can separate "never called" from "sent but not shown" from
    "WinRT refused" without a dev console.
  - The rule also widened, since the old one leaned on the chime: a toast is suppressed **only**
    when the window is focused *and* the workspace is the active one (it is already on screen).
    Unfocused, or focused-but-another-workspace, both toast. The judgment is the pure
    `features/notifications/chime.ts::needsInputToastTargets`, locked by vitest.
  Verification: WINDOWS-BUILD §10 v0.3.7 item 2 (field-only, as before).

- **needs-input chime removed — decided 2026-08-13** (user decision): the signal is the toast
  alone. The chime could not say *which* workspace was waiting, and its existence was the
  argument for suppressing toasts whenever the window had focus — the rule that hid a second
  project going quiet. `Chime`/`installChimeUnlock` and their tests stay in `features/notifications/chime.ts` as
  **dormant** code (the send-mode precedent: entry point unwired, contract still tested, reason
  recorded in the module header); only the wiring in `app/main.ts` was cut. `detectNeedsInputOnset`
  stays as the onset engine, minus its now-meaningless `chime` derived field — a **contract
  change**: `NeedsInputOnset` is `{ onsets, next }`.

- **needsInput onset, toasts and badges are per tab — landed 2026-09-15** (v0.3.32; Windows
  field verification pending). Agent state moved onto the tab (ADR-0026; see *Agent state is per
  tab* under Agent integration), and the onset followed: `detectNeedsInputOnset(prev, workspaces)`
  now keys `prev`/`next` by `TabId` and returns `onsets: TabOnset[]` with
  `TabOnset = { workspaceId, tabId }` — a **contract change** from workspace ids. The rules are the
  same (the first snapshot of a WebView lifetime is the baseline, a repeat is silent, vanished tabs
  drop out), but a second tab starting to wait in an already-waiting workspace now fires, where the
  workspace-level check saw no change. Suppression is unchanged — focused window **and** active
  workspace — and a hidden tab in the active workspace relies on its badge. `needsInputToasts`
  sends **one toast per tab**, never merged per workspace: title `mast — <workspace> · <tab
  title>`, body the first line of **that tab's** `lastAgentMessage` (fallback `agent needs your
  input`), never the derived workspace message, which may be another tab's question.
  `notify_toast` gained `log_label`, and `toast.log` records `ok label="<workspace> #<tab id>"`
  instead of the title: tab titles arrive over OSC 0/2 carrying task text and paths, which the log
  already keeps out by never recording the body. Tab buttons get a `!` needs-input badge distinct
  from the unread dot (unread clears when the tab is viewed, needs input on the agent's next
  token); the node always exists and toggles `hidden`, and `sameTabButton` compares the flag so a
  status-only change patches in place. The pane dot lights for either and takes a `needs-input`
  class. The sidebar and the phone read the derived workspace fields and did not change.
  Verification: WINDOWS-BUILD §10 v0.3.32.

#### Phone remote surface

- **PTY follows the latest viewer — backlog (2026-09-12, not started)**. The only way a TUI
  lays itself out for the phone is to be told the phone's size: when a phone opens a tab, resize
  the PTY to the phone's columns/rows (the TUI redraws on SIGWINCH), and restore the desktop's
  size when the phone's polling lease lapses or the desktop is used again — tmux's
  `window-size latest`. Costs: the desktop pane shows the narrow layout while the phone looks,
  a lease with a timeout has to exist, and ADR-0016 decision 5 ("the phone never resizes")
  needs an amendment. Sequenced behind real phone use of Claude Code tabs; a faithful
  fixed-grid mode with horizontal scroll/pinch zoom is the cheaper alternative if reading is
  not the main use.

- **Image attach from the phone — backlog (user decision 2026-09-08)**. The phone composer is a
  plain textarea, so a pasted image goes nowhere, and no channel exists to hand one to the agent in
  a tab. Both agents take an image *file path* in the prompt (Claude Code's drag-and-drop path
  handling, Codex's `attach_image path`), so the shape that fits is: an attach button / paste
  handler on the phone → a new authenticated upload endpoint (image types only, ~10 MiB cap,
  server-named files) → the app writes into a WSL-visible `~/.mast/uploads/` → the path is sent
  as text with the separate CR, exactly like Send. Two decisions ride along: it is a new capability
  class ("the phone can write files on the PC") and needs an ADR-0016 amendment, and the uploaded
  files need a lifetime — delete-on-close next to the tab's history files (ADR-0013) is the
  natural rule. Not started.

- **Arrow keys and a refresh button on the phone — landed 2026-09-12** (v0.3.26). The key bar
  gained ↑/↓/←/→ next to Stop/Esc — `protocol.ts::encodeInput` already encoded both arrow forms
  (plain and DECCKM) for the desktop, so this only wires up the missing buttons. The new ↻
  header button is not a page reload: it clears the notice, drops the headless terminal instance
  and polls immediately without `since` so the reply is a fresh snapshot — the phone's
  counterpart to the desktop's Ctrl+Shift+R. It stays outside `controls` on purpose, since its
  whole point is recovering from the black-screen/error state where input is disabled.

- **Remote surface over the LAN — landed 2026-09-05** (user request, v0.3.17). `settings.json`'s
  `"remote": { "port": N }` starts an HTTP server inside the app (off by default — nothing exists
  while off) that a phone on the same Wi-Fi reaches after scanning the sidebar's *Pair phone* QR:
  `/api/state` is the desktop's snapshot JSON, `/api/tabs/{id}/screen` an offset-based, read-only
  delta of the replay (`PtySession::screen_since` — never `reattach()`, which would reset the
  desktop's flow control), `/api/tabs/{id}/input` raw bytes written verbatim. Everything
  network-facing is the new Tauri-free crate `crates/mast-remote` — its own `httparse` loop,
  since `tiny_http` has no head cap and drains a rejected body — tested on Linux against a real
  listener; the glue only reads settings, keeps the token file, gates static assets by the
  embedded key set (Tauri's release lookup falls back to `index.html` for unknown paths) and
  serves the second Vite bundle under `/remote/`. The phone renders a headless xterm buffer as
  wrapped text (v0.3.18: vertical scroll only, A−/A+ font size, Send/Stop/Esc, the app box sized
  to the visual viewport so the composer stays above the keyboard) and encodes input itself,
  sending Enter as a separate request after a paste for the v0.3.16 reason. **v0.3.18 shipped
  blind** (user report 2026-09-06, fixed in v0.3.19): every phone showed a black tab screen with
  the composer disabled, because `@xterm/headless` 5.5.0 gates `buffer` behind
  `allowProposedApi` — the browser build of the same version does not — and the throw landed
  inside xterm's write loop, where nothing reports it and the queue stays wedged. Fixed with the
  option, a guard that turns a render failure into a visible notice, and `tab-view.test.ts`,
  which drives a real headless instance through the first frame under happy-dom. It was
  reproduced on the dev box by running the built phone code in Windows Chrome headless against a
  mock server; the field-only checklist had no browser step, which is what let it ship.
  **The phone could not scroll back — v0.3.20** (user report 2026-09-06): Claude Code 2.1.x and
  Codex 0.153.x both run on the **alternate screen** by default (read off a live tab's bytes:
  `?1049h` plus SGR mouse tracking `?1000/1002/1003/1006h`), and that buffer has no scrollback —
  the phone's headless instance held exactly the viewport, so there was nothing above to scroll
  to; a plain shell's history scrolled fine (checked in Chrome against the real CSS). The desktop
  has history there only because the wheel goes to the TUI, which scrolls its own transcript. The
  phone now floats ▲/▼ over the output whenever the active buffer is the alternate one *or* mouse
  tracking is on (the snapshot preamble re-asserts mouse modes but not 1049, ADR-0015, so an old
  tab can look normal-buffered), and a tap sends five SGR wheel notches at the screen centre — or
  PageUp/PageDown when the program takes no SGR mouse, tracked with a CSI hook on the headless
  parser; X10 encoding is never sent. The input queue also triggers an immediate poll when it
  drains, so a tap or a Send shows its effect in a few hundred ms rather than up to 2 s.
  Decisions and the accepted limits (plain HTTP, slowloris, the shared `writer` mutex,
  first-frame fidelity): [ADR-0016](docs/adr/0016-remote-surface-over-lan.md).
  Verification: WINDOWS-BUILD §10 v0.3.17 — all field-only. **Open**: `PtySession::kill` waits
  on the `writer` mutex under the Dispatcher lock, so a remote write into a shell that stopped
  reading stdin can stall a `CloseTab` (same root as the "input stops reaching a shell" item; the
  candidate fix drops the master before the writer); an authenticated client can hammer
  `since`-less requests (the limiter counts auth failures only); the phone bundle carries its
  own copy of xterm (the ~150 KB headless build); `lan_ip()` takes the default-route interface, which on a
  multi-homed PC may not be the phone's link.

- **The phone broke every long line twice — fixed 2026-09-12** (user report, v0.3.22). The
  headless terminal has the PTY's width, so a long line arrives as several soft-wrapped buffer
  rows, and the phone's CSS wrapped each row again at its own width — the breaks "followed the
  computer". `joinWrappedRows` (`screen-text.ts`) stitches the rows xterm marked `isWrapped`
  back into one logical line, trimming the right only at the logical end, so the CSS wraps once.
  TUI rows are drawn with cursor moves and are never marked, so Claude Code/Codex screens are
  unchanged — including the part that still looks wrong: a full-width TUI layout fragments at
  the phone's width. ADR-0016 decision 7 amendment records why re-interpreting the stream at
  the phone's width cannot fix that. Verification: WINDOWS-BUILD §10 v0.3.22.

- **The firewall rule is bound to the exe path, and nothing said so — landed 2026-09-12**
  (v0.3.23). The rename changed the exe's file name, the `winmux-x64.exe` allow rule silently
  stopped applying, and this PC's profiles have `NotifyOnListen` off, so Windows never asked;
  the only symptom was a phone page that never loaded while `mast.log` showed
  `remote: listening …`. The *Pair phone* dialog now judges, over unprivileged COM
  (`firewall.rs`), whether an enabled inbound Allow reaches this exe on this port for the
  current profile — `Protocol=Any` rules are exempt from the port check because that is what
  Windows's own prompt writes — and offers *Allow in Windows Firewall*, which runs a
  Microsoft-signed `netsh -f <script>` elevated once; the script is built from `current_exe()`
  and the port only, the rule covers `domain,private` only, and success is judged by
  re-detection rather than netsh's undocumented exit code. A program-bound Block rule for this
  exe wins over Allow, as in Windows, and hides the button since another allow rule would
  change nothing. Boot logs one `remote: firewall <state>` line. Decisions and limits (third-party
  firewalls invisible, rule scope only partly modelled, tests run only on the Windows CI job):
  ADR-0016 amendment (v0.3.23). Verification: WINDOWS-BUILD §10 v0.3.23, field-only.

#### Settings and first-run setup

- **CLI settings — implemented 2026-09-13.** `mast config` reads saved Windows settings;
  `set`/`reset` validate and atomically replace the file, then ask for a full restart. Setup
  v13 ships a standard-library Python helper, invoked directly rather than through an OSC
  mutation channel. Windows interop and drive access are required only when using config.
  `set remote [true] [--port N]` enables on 7331 when omitted; `set remote false` removes the
  key. This is an explicit-command default, **not** first-run enablement: the JSON schema and
  off-by-default listener contract remain unchanged. CLI writers share a directory lock;
  external editors do not participate. Reference: `docs/SETTINGS.md`, ADR-0023.

- **A first-run `settings.json`, with the remote surface on and `log` off by default —
  requested 2026-09-12, not started.** The file was lost with the rename that day:
  `%APPDATA%\app.winmux.desktop` was deleted once the migration looked done, it held the only
  copy of `settings.json`, and nothing in WINDOWS-BUILD §12 named that file — item 4 says to
  copy the state directory and item 9's checklist never asks whether *Pair phone* is still
  there. The app then came up with every setting at its default, and the failure was silent by
  design: a missing file is `Ok(default)` (`commands.rs::read_ui_settings`) and a missing
  `remote` key is `RemoteState::Off` (`remote.rs`), so the button was simply absent with no
  error on any surface. The ask is that the app **write** the file with its defaults when it is
  absent — settings become an artifact the user can see and edit rather than one they have to
  know to create — and that those defaults be the remote surface **on** (a default port) with
  `"log": false`.

  Two contracts it reverses and therefore has to answer. ADR-0016 decision 1 makes the remote
  surface opt-in: while off there is no listener, no thread and no token file, and that is the
  reason its idle cost is zero. And `RemoteSettings::port` is deliberately not an `Option` so
  that a file without a port fails loudly instead of binding one the user never chose. A
  default that opens a LAN listener on every network the PC joins is the opposite of both, so
  whatever lands has to say why that is now the right default (the phone is a headline feature;
  the pairing token and the firewall prompt are the gates that actually protect it) and where
  the user is told it happened — at minimum a `winlog!` line and the pairing dialog. It also
  moves the file's ownership: today the user owns both its existence and its content (there is
  no settings UI), and afterwards the app owns the existence while the user still owns the
  content — the discipline provisioning already follows for `~/.claude/settings.json`, where a
  value the user set is never rewritten and only a missing one is added.

- **First-run setup is file-based and its failures are quiet** (2026-09-11, not started).
  Automatic agent-hook provisioning needs to be obvious in the docs and its failures visible at
  the surface. A settings UI or setup assistant earns its cost only once a real user is blocked
  by `settings.json`.

#### Logging and diagnostics

- **Backend resource diagnostics — landed 2026-09-12** (v0.3.25). `get_diagnostics` and
  `window.__mast.diagnostics()` report process private bytes, working set, handle and thread
  counts, registered/alive sessions, sinks, retained replay bytes, tab counts by status and the
  last consistency check; one `diag:` line reaches `mast.log` at the end of the boot wave, on an
  audit finding and when the memory watchdog fires. No timer, and **no automatic backend restart**
  hangs off any of it. [ADR-0018](docs/adr/0018-exited-tab-as-terminal-record.md) #6.

- **Opt-in runtime log — landed 2026-08-22** (user request, v0.3.12). Until now everything the
  app said at runtime went to `eprintln!` and the release build is
  `windows_subsystem = "windows"`, so there was no console for it to land in: two field
  incidents were reconstructed from `dmesg` and process trees that happened to still be alive.
  Now `settings.json`'s `"log": true` (default off, read once at boot — enabling it takes a
  restart) opens `mast.log` next to `state.json`. Two macros split by purpose: `winlog!` goes
  to stderr **and** the file and replaced all 66 `eprintln!("[mast] …")` sites verbatim, so
  dev behaviour is unchanged and what the app already said now lands somewhere; `wintrace!` is
  file-only and is where the per-event traces removed from the console the same day came back
  (see *Diagnostic stderr/console logging* below — noise in a console is the content of a
  diagnostic log). **While off
  nothing exists**: no file, no writer thread, no front-end listeners, and `wintrace!` checks an
  `AtomicBool` before formatting so a disabled trace does not even allocate. The front end
  writes through a `log_line` command, which is what makes the IME class of bug visible at all —
  it was the trigger for the feature. **Terminal output and typed text are never written**:
  composition events record data *length*, and a swallowed shortcut records named keys as
  themselves and any printable character as `(char)`. A bounded queue drops rather than blocks
  (and says how many it dropped), and two 4 MiB files cap the disk cost.
  [ADR-0014](docs/adr/0014-opt-in-runtime-log.md). Verification: WINDOWS-BUILD §10 v0.3.12.
  **Open**: a bare `eprintln!` in the glue now silently keeps its line out of the file — nothing
  enforces `winlog!`.

- **Diagnostic stderr/console logging — cleaned up 2026-08-22** (ADR-0004 deferred it until
  "before any public release"; v0.3.11). The rule applied: **per-event tracing of normal
  operation whose question has been answered goes; failure reports and once-per-boot facts
  stay.** Removed — `reset_supervisor`'s three signal traces (activity source, `focused=`,
  `visible=`), which fired on every click, ping, alt-tab and minimize to answer a checkpoint-1
  question about which signals actually arrive, plus the front end's rebuild-order dump (every
  layout rebuild) and pane-icon click log (every header button), both from the same concluded
  "wrong pane split" investigation. The `source` tag `user_input` took existed only for its log
  line and went with it. Kept — every `console.debug` that reports a *failure* (toast send,
  stale auto-response, the chime's three), and the boot/reset/spawn lines that report a rare
  significant event. The switch tracer keeps measuring but no longer prints: the report still
  lands on `window.__mast.lastSwitch`, so the open ~236ms item keeps its instrument. Note the
  backend half was already invisible in release (`windows_subsystem = "windows"` leaves
  `eprintln!` nowhere to land), so this bought code clarity, not runtime quiet — the actual gap
  is the *Opt-in runtime log* entry.

#### Session and resource reliability

- **A shell that never starts is flagged now, but input that stops reaching one is not** —
  the 2026-08-15 field incident, partly landed in v0.3.9. WSL could not allocate the vsock ring
  buffer new interop channels need, so `wsl.exe` started while no shell was ever created inside
  it; separately, the same memory pressure left already-running agents unresponsive. Full
  analysis and the decisions are in [ADR-0009](docs/adr/0009-startup-marker-and-spawn-deadline.md).

  **Landed**: a startup marker (`OSC 777;mast-started`) emitted first thing by the wrapper, a
  20s watchdog that marks the tab `NotStarted` **without killing the session** (a late marker
  clears it), a pane banner naming WSL as the likely cause with a Retry that cleans up the
  session the tab still held, and a 5s spawn deadline so one tab cannot hold the dispatcher
  lock indefinitely.

  **Still open**: the symptom that actually hurt most — **an agent that was working and stops
  accepting input**. Silence alone cannot decide it (an idle shell is silent), but a
  `write_stdin` that does not return within seconds is a sound signal, and the front end
  serialises writes per session so one stuck write kills that tab's input entirely. Left out of
  v0.3.9 as too heavy for its value at the time: it needs another status, another surface and
  its own false-positive rules. Note it shares a fix with the unbounded blocking write recorded
  under *Remote surface over the LAN* (`PtySession::kill` waiting on the `writer` mutex).
  Also open: failures *after* the marker (the wrapper's file I/O, the final `exec bash -l`), and
  whether killing `wsl.exe` actually reaps the Linux-side relay — the incident's zombies were
  `/init` relays that survived with `PPID=1`, and WINDOWS-BUILD §10 v0.3.9 item 2 measures it.

- **The records directory has no total-size cap** (2026-09-12, not started). ADR-0018 bounds one
  record (~1 MiB) but not their sum, and a record survives relaunches, so a shutdown that exits
  twenty tabs can leave tens of megabytes sitting until each tab is restarted, closed or swept.
  A total cap or an age-based sweep belongs in the boot sweep that already runs.

- **No bulk Restart of exited tabs after a sleep or `wsl --shutdown`** (2026-09-12, not started).
  ADR-0018 keeps `Exited` across a relaunch, so a night's sleep leaves every tab waiting for its
  own banner click; a workspace-level "restart all exited tabs" needs the boot wave's pacing
  (ADR-0010 amendment) to avoid the cold-VM race it would otherwise reproduce.

- **Windows PTY resource soak — landed 2026-09-12, first Windows run PASS the same day**.
  `crates/mast-core/tests/soak_windows.rs` (`#[ignore]`, Windows-only) rotates 500–1,000 create /
  kill / rapid-respawn cycles through `PtySession` and judges that handles, threads, private
  bytes and the `conhost`/`OpenConsole`/`wsl`/`wslhost`/`wslrelay` counts come back to a settled
  post-warm-up baseline — process counts with no slack, since a leftover relay is the defect
  itself. First run: `cmd` 1,000 cycles and `wsl` 500 cycles both returned every counter to
  baseline (handles 74 → 74, threads 5 → 5, private +0.4 MB, process counts unchanged) —
  numbers in `docs/WINDOWS-BUILD.md` §13. The first attempt hung at cycle 0 in both modes and
  taught something general: conhost holds a ConPTY child until the terminal answers its
  start-up cursor query (`ESC[6n`), which xterm does for the app and the soak's sink now does
  itself; `ClosePseudoConsole` was never the blocker. `scripts/win/soak-pty.ps1` runs it.

- **The `portable-pty`/ConPTY shutdown path has never been audited on a supported Windows 11
  build** (2026-09-11, not started). Verify that pseudoconsole, pipe, process and thread handles
  are released on normal exit, explicit kill, failed spawn and rapid respawn. Verification work
  unless the soak test above turns up a leak. The soak test is the instrument for it — its three
  cycle patterns are exactly normal exit, explicit kill and rapid respawn, so the audit is
  reading its handle and process columns rather than building a second harness (failed spawn
  stays uncovered). Its first run (1,500 cycles, 2026-09-12) returned handles, threads and
  process counts exactly to baseline, which answers the three covered paths for that build;
  the probe that diagnosed the run also showed that dropping the PTY writer while the child is
  alive makes conhost end it with `0xC000013A` (`STATUS_CONTROL_C_EXIT`) — harmless in
  `session.rs` today, a fabricated exit code if the drop order ever changes.

- **≤100MB RAM** — ~129MB at checkpoint 2 sits inside the 100–150MB adoption band
  (ADR-0001); getting under 100MB is a v2 optimization.

- **The persistence handoff channel is unbounded — landed 2026-09-12** (v0.3.25). `Saver` keeps
  one pending `Box<AppState>` in a slot each `schedule` replaces, so a publish burst queues at
  most one snapshot. The debounce deadline is still fixed at the first schedule of a pending run,
  and a flush is acknowledged only once the slot is empty — `flush()` returning still means every
  earlier schedule is on disk, which the shutdown order in `main.rs` depends on. ADR-0018 #8.

- **Nothing cross-checked the model's session ids against the registries — landed 2026-09-12**
  (v0.3.25). `audit_registries` (core, pure) names orphan sessions, orphan sinks and dangling
  tabs; the glue runs it after an exit, after a successful Close*, at the end of the boot wave and
  inside `get_diagnostics` — no timer. It takes the **Dispatcher lock first** and snapshots the
  registries under it, or a session created between two snapshots is misjudged as dangling and its
  live shell cut; an exit mid-release is excluded by the `exits_in_flight` marker. Orphans are
  released, a dangling tab is repaired to `Exited`, findings are logged — nothing restarts.
  ADR-0018 #5.

- **An exited tab kept a live tab's replay budget — landed 2026-09-12** (v0.3.25). An exited tab
  is now a **record**: the last screen (mode preamble + replay snapshot) is written to
  `records/tab-<id>.bin` at exit and the `PtySession`, its replay buffer and its sink are all
  released, so a finished tab holds no session memory at full fidelity — the 128–256 KiB
  compromise this entry asked for is moot. The file is rendered read-only on the viewer lifecycle,
  survives a relaunch (`sanitize` keeps `Exited`, partly reversing ADR-0010), and is deleted by a
  successful Restart, by closing the tab and by a boot sweep.
  [ADR-0018](docs/adr/0018-exited-tab-as-terminal-record.md).

- **Per-tab shell history GC — landed 2026-08-22 as delete-on-close** (user decision,
  v0.3.11). Closing a tab now deletes its `~/.mast/history/tab-<id>`, its
  `~/.mast/resume/tab-<id>` and any `tab-<id>.tmp.<pid>` a killed hook left mid-write. The
  core reports the removal — `SessionHost::release_tabs` is reached from `CloseTab`,
  `ClosePane` and `CloseWorkspace` only, **never from `SessionExited`**, because an exited tab
  is revivable under the same id (ADR-0010) and has to find its own history when it comes back.
  The host runs one `wsl.exe --exec bash -c 'rm -f …'` for the **whole batch** on a detached
  thread: a batch because closing a workspace retires a dozen tabs at once and one `wsl.exe`
  each is the shape of the ADR-0010 boot-wave failure, and detached because the call sits under
  the dispatcher lock. `$HOME` is expanded inside WSL rather than assembled into a UNC path on
  the Windows side, the same discipline the `mkdir -p` in `bash_argv` follows. Kill precedes
  delete on purpose — a shell writes `HISTFILE` as it dies, so the reverse order lets the
  dying shell recreate what was just removed. **Still open**: files orphaned when the app is
  force-quit or crashes between the close and the `rm` — nothing sweeps those, and a boot-time
  sweep against the tab ids in `state.json` is what would. Decisions and the rejected
  alternatives: [ADR-0013](docs/adr/0013-retiring-a-closed-tab.md). Verification:
  WINDOWS-BUILD §10 v0.3.11 item 2.

- **Sessions do not survive a severed relay, and that is a deliberate limit** (considered
  2026-08-15, not planned). Putting a detach layer (`dtach`, ~50KB installed and <1MB per
  server) between the terminal and the shell would let a session live through a broken vsock
  channel, an app restart, even a mast crash — the agent process keeps running and reattaches
  where it left off, making the resume-hint feature unnecessary. It would not survive
  `wsl --shutdown` or a reboot, and output produced while detached is lost. Rejected for now on
  complexity, not cost: socket lifetime, attach-vs-new arbitration, resize forwarding and
  provisioning all grow. Sessions dying with the app is intended, memory pressure belongs to
  `.wslconfig`, and users who need more can run tmux themselves.

#### Build, release and adoption

- **Startup update notice — v0.3.31.** Native setup checks GitHub once on a short-lived
  background thread and caches the result for the process lifetime. WebView resets read the
  cache and receive a completion event, never request again. The sidebar shows the installed
  version and, only for a newer stable release, a fixed release-page link. WinHTTP has stage
  timeouts and header/body caps; failure is log-only. No updater, popup, polling or restart.
  [ADR-0024](docs/adr/0024-startup-update-notice.md).

- **CI takes whatever stable Rust the runner ships, so a new lint can turn a clean tree red**
  — 2026-08-22 the runner moved to 1.98 and `clippy::chunks_exact_to_as_chunks` failed two
  untouched UTF-16 decoders on a push that changed neither (fixed with the suggested
  `as_chunks::<2>()`, which also compiles on the older local toolchain). Pinning with a
  `rust-toolchain.toml` would make the gate reproducible, at the cost of not hearing about new
  lints until someone bumps the pin. Undecided; noted so the next occurrence is recognized as
  toolchain drift rather than a regression in the change under test.

- **Unsigned releases meet SmartScreen** (2026-09-11, not started). Windows code signing is the
  fix and it carries a running cost; revisit when external usage justifies it rather than ahead
  of it.

- **The README shows no screenshots and no hero clip** (2026-09-11, not started). The workflow
  it describes — several agents running, the sidebar status changing, opening a file or Markdown
  tab, checking and sending input from a phone — is exactly the part a reader cannot infer from
  prose.

- **No external users yet** (2026-09-11, open). Adoption is one maintainer using it daily, so
  every priority above is self-reported. Repeated-use feedback from a small set of real users is
  what should decide the next scope expansion — ahead of any generic terminal or IDE feature.

#### Code hygiene

- **`isCommandError`'s variant table is hand-maintained** — the `formatCommandError`
  switch is compile-time exhaustive via `assertNever`, but the type guard above it is a
  literal list, so a new `CommandError` variant falls silently through to the raw-JSON
  path. Force the table from the type.

- **OSC scanner C0 handling** — CAN/SUB abort is implemented; the remaining C0 cases were
  never reviewed against real terminal behavior (carried from ADR-0001).

- **The chime is gone but its class is not** — `features/notifications/chime.ts` still exports `Chime`,
  `installChimeUnlock` and `AudioContextFactory`, and nothing outside its own tests imports
  them (v0.3.7 removed the chime itself; `app/main.ts` takes only `detectNeedsInputOnset`,
  `needsInputToastTargets` and `needsInputToasts` from that module). Dead code with a live test surface, so deleting it
  is its own small change — noticed during the 2026-08-22 log cleanup, which is why three of the
  surviving `console.debug` lines sit in code that never runs.

## Layout

- `crates/mast-core` — framework-independent state model, command dispatcher and PTY
  execution core, including filesystem/process I/O. No Tauri dependency; `src/lib.rs`
  maps its modules. Unit/integration tests run without the desktop framework.
- `crates/mast-remote` — the LAN remote surface's HTTP server: head parser on `httparse`,
  route table, pairing token, per-IP limiter, handlers. Pure Rust, no Tauri; its integration
  tests run against a real listener on Linux (`tests/server.rs`, unix-only `tests/server_pty.rs`).
- `apps/mast` — the MVP app (계획 v2 section 17, stage 10 onward): Tauri v2 + vanilla TS
  frontend driving the `mast-core` `Dispatcher` over a single serializable `Command` bus.
  Architecture: ADR-0002 (state/bus/attach), ADR-0003 (split/tab UI).
  Frontend navigation: [source code map](apps/mast/src/README.md); Rust adapter navigation:
  the module map in `src-tauri/src/main.rs`.
- `apps/spike` — **frozen as the measurement harness** (ADR-0001 reproduction rig):
  feature work stops here, only compiling is maintained going forward. Its checklist and
  scripts keep serving as the MVP-era regression check (`docs/plans/spike-plan.md`
  sections 4 and 6).
- `scripts/wsl`, `scripts/win` — verification scripts (OSC emission, flood, RAM
  measurement).

## Gates (run before committing)

```bash
export PATH="$HOME/.local/node/bin:$HOME/.cargo/bin:$PATH"
cargo test -p mast-core
cargo test -p mast-remote
cargo clippy --workspace --all-targets --target x86_64-pc-windows-msvc -- -D warnings
cargo clippy --workspace --all-targets --target aarch64-pc-windows-msvc -- -D warnings
cargo check --workspace --target x86_64-pc-windows-msvc
cd apps/spike && npm run build && npx vitest run
cd apps/mast && npm run build && npx vitest run
```

The ARM64 clippy works on the Linux dev host because check-family commands never link —
no MSVC import libraries needed (계획 v2 section 13: x64 + ARM64 from day one). CI
(`.github/workflows/ci.yml`) runs the same gates on every push and builds x64 + ARM64
release artifacts on `workflow_dispatch` or a `v*` tag (kept off the per-push path —
Windows runners bill at 2x).

- `src-tauri` cannot compile for the Linux host (no webkit2gtk) — the Windows-target
  check/clippy IS the compile gate for the glue. It needs `llvm-rc` on PATH; the
  sudo-free setup (apt-get download + dpkg -x into `~/.local/llvm`) is in README
  "Development".
- Windows build/run and the manual verification flow: `docs/WINDOWS-BUILD.md`.
- The app spawns `wsl.exe [-d $MAST_DISTRO] -- bash -l` on Windows, `$SHELL -l` on Unix.

## Conventions

- Code comments are Korean prose; identifiers, commit messages, and tracked reference
  docs are English (this file, README, ADRs). Korean domain/plan docs keep their names.
- User-facing strings (UI text, script output, warnings, error messages) are English; code
  comments and test names may be Korean.
- The terminal output hot path stays raw binary end to end (`ipc::Channel` +
  `InvokeResponseBody::Raw`; xterm gets `Uint8Array`). No JSON on that path — JSON is
  fine for low-frequency events (`state-changed`, `terminal-exit`, stats). OSC no longer
  crosses the IPC boundary in `apps/mast` — it is routed into the model in Rust (stage 18);
  the `osc-event` emit survives only in the frozen `apps/spike`.
- Lock discipline in the glue: never hold the session-registry mutex across a blocking
  PTY call. Write/resize/spawn go through `spawn_blocking`; `ack_output` stays sync and
  cheap. See the module docs in `apps/spike/src-tauri/src/commands.rs`.
- Flow control must pause the PTY *read* (backpressure into the OS pipe), never just the
  delivery. See `mast-core::session` reader loop.

## Docs

- `docs/adr/` — decision records, English, numbered (`0001-...`).
- `docs/plans/` — Korean working plans for in-flight work. When a plan is executed,
  distill the outcome into an ADR and delete the plan file. Current exception:
  `spike-plan.md` stays because its section 4 is the module-contract reference that code
  comments point to; delete it when the MVP refactor replaces those contracts.
- **Renames are substituted retroactively, except where the old name is the fact being
  recorded.** A project rename rewrites every ADR, because they describe designs that are
  still live. Two things keep the former name verbatim: incident forensics — currently
  `0010-restart-dead-terminal-tabs.md`, whose paths, exit codes and tokens are what was
  observed — and the rename-migration sections of `docs/WINDOWS-BUILD.md`, which exist to tell
  a user what to move *from*. The rename itself gets its own ADR (`0017`).
