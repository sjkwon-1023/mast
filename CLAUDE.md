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
(0005), OSC notification routing (0006), the keyboard model and the canonical
interception list (0007), viewer tabs (0008). Stage 19 (git branch display) is deferred
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
  Verification: WINDOWS-BUILD §10 v0.3.24.

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

- **Korean IME composition can get stuck, and every shortcut dies with it** (user report
  2026-08-22, not fixed). Typing Korean produced a previously typed syllable repeating, no
  shortcut worked, and clicking another pane and coming back cleared it. What the code settles:
  `keys.ts:212` drops **every** shortcut while `ev.isComposing` is true, so a dead Alt+Arrow is
  direct evidence that the browser still believed a composition was open; the repeated syllable
  is xterm's hidden textarea re-sending stale composition text; the click fixed it because blur
  forces the IME to commit. What the code cannot settle: whether `compositionend` never arrived
  or arrived without clearing. That is why the opt-in log (above) records the composition events
  and the swallowed shortcuts — the next reproduction answers it. Two candidate responses when it
  does: narrow the `isComposing` guard to unmodified keys (every mast shortcut carries Ctrl or
  Alt and no IME uses those, so this restores an escape hatch without touching the cause), or
  track composition state in the app and force it closed on blur and tab switch (heavier, and
  premature without knowing the trigger).

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
  the front end (user choice, the lighter of the two): `keys.ts::paneTerminalCwd` reads the
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
  sleep/shutdown, `wsl --shutdown`, WSL OOM, or typing `exit`. Landed: restore normalizes
  `Exited` → `Running` so a restart revives every tab in its stored `cwd`, `respawn_tab`
  accepts `Exited` (killing the stale replay session first), and the ADR-0009 pane banner now
  covers `exited` with a **Restart** button. Revival keeps the tab id, so `HISTFILE` and the
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
    two viewers hold coordinates the resize invalidates, so `viewer-font.ts` now owns a live-view
    registry (the counterpart of `terminal-view.ts`'s `liveViews`) driven in **two phases** —
    every view anchors its position *before* the variable changes, then re-seats itself after.
    `TextView` re-lays row height, spacer height and `scrollTop` around the **topmost visible
    line** (model coordinates are byte offsets, so holding the line holds the position and
    nothing goes back to the model). `MarkdownView` holds a **relative** anchor instead — its
    scroll coordinate is px and the prose reflows — and deliberately does not write the post-zoom
    px back, since a relaunch renders at the `settings.json` size where that px means a different
    place. The folder listing needs neither. The "never call this again after boot" warning on
    `viewer-font.ts` is gone with the hazard. Markdown prose now follows the **size** too (its
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

- **No Changes view beside the file viewer** (2026-09-11, not started). The wanted shape is a
  viewer-class surface, not an editor: changed files with `M/A/D/?`, a Working / Staged / All
  filter, and the selected file's diff fetched lazily instead of materializing a repository-wide
  diff in the DOM. Unified diff is the default renderer; side-by-side only if it stays cheap on
  large diffs. The later step is handing selected lines or collected review notes to the active
  Claude Code/Codex tab as file/line context over the existing send channel — that reuses
  `mast send` and keeps the surface a viewer.

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

- **Agent coverage beyond Claude Code and Codex — Antigravity CLI and opencode** (user
  request 2026-08-15, not started). Both would reuse the `mast:running` /
  `mast:needsInput` / `mast:idle` tokens and `mast-notify.sh` **unchanged**: nothing in
  `mast-core` (`osc.rs`, `notify.rs`) or the front-end (`chime.ts`, `main.ts`) is
  agent-specific. The work is `provision.rs` — the single source of truth for every notify
  script and every auto-wiring block — plus a `SETUP_VERSION` bump, a resume-command entry in
  `host.rs::bash_argv`'s whitelist (today `claude --resume` and `codex resume` only), and a
  matching section in `scripts/wsl/claude-hook-example.md`. What is *not* settled, per agent:
  - **Antigravity**: only the **CLI** is in scope. The IDE's agents do not run in a mast
    tab, so there is no pts to emit into and no tab to attribute a toast to. The CLI's hooks
    are near-isomorphic to Claude Code's — `hooks.json` under `.agents/` per workspace or
    `~/.gemini/config/` globally, the same `{"matcher": …, "hooks": [{"type": "command",
    "command": …, "timeout": …}]}` shape, payload on stdin — so the Claude half's Python
    merge is the template rather than new machinery. The gap is the **event mapping**: the
    documented events are `PreToolUse` / `PostToolUse` / `PreInvocation` / `PostInvocation` /
    `Stop`, so `Stop → mast:idle` is obvious, but there is **no `Notification` equivalent
    to carry `mast:needsInput`** — the one state the toast exists for. Until that is
    answered the integration is idle-only, which is half the feature. Payload keys are
    camelCase (`conversationId`, `transcriptPath`, `terminationReason`, `fullyIdle`); unlike
    Codex no snake-case fallback is in evidence. Version risk: hook delivery has been in flux
    (a field report of `Stop`/`PostToolUse` never firing on IDE 1.107.0, later addressed by
    running hooks.json hooks ahead of the built-in termination checks), so a field check must
    name the CLI version it passed on.
  - **opencode**: it has **no shell-command hook at all** — extension is TypeScript/JS
    plugins under `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global), a
    default-exported async function returning an event-hook object. The mapping is the better
    of the two (`session.idle → mast:idle`, `permission.asked → mast:needsInput`,
    `permission.replied → mast:running` covers all three states where Antigravity covers
    one), and the plugin context hands over Bun's `$` shell, so it can call
    `~/.mast/bin/mast-notify.sh` verbatim — no third notify script. The blocker is **tty
    attribution**: opencode plugins run in the server process with no controlling terminal,
    so `mast_emit` would always fall through to its ancestor-pts walk, and it is unverified
    whether that server sits in the tab's ancestor chain at all — or whether one server is
    shared across tabs, in which case a needsInput toast lands on the wrong tab or nowhere.
    Answer that before writing any provisioning. Writing a plugin file is also a different
    discipline from the "never rewrite an existing key" rule the Claude/Codex halves follow:
    a plugin file we create is ours to upgrade, one that already exists is not.

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
  WINDOWS-BUILD §10 v0.3.5.

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
    `chime.ts::needsInputToastTargets`, locked by vitest.
  Verification: WINDOWS-BUILD §10 v0.3.7 item 2 (field-only, as before).

- **needs-input chime removed — decided 2026-08-13** (user decision): the signal is the toast
  alone. The chime could not say *which* workspace was waiting, and its existence was the
  argument for suppressing toasts whenever the window had focus — the rule that hid a second
  project going quiet. `Chime`/`installChimeUnlock` and their tests stay in `chime.ts` as
  **dormant** code (the send-mode precedent: entry point unwired, contract still tested, reason
  recorded in the module header); only the wiring in `main.ts` was cut. `detectNeedsInputOnset`
  stays as the onset engine, minus its now-meaningless `chime` derived field — a **contract
  change**: `NeedsInputOnset` is `{ onsets, next }`.

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

- **No backend resource diagnostics for a long-running session** (2026-09-11, not started).
  When a warning fires there is nothing to capture: backend RSS/private bytes, live and exited
  session counts, replay bytes, handle and thread counts where available, orphan counts. It
  must not be paired with an automatic backend restart — that destroys live PTYs and the agents
  inside them, which the non-goals above rule out.

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

- **The persistence handoff channel is unbounded** (2026-09-11, not started). A producer burst
  can queue an arbitrary number of cloned `AppState` snapshots at the saver. Replace or wrap it
  with a latest-state slot or a bounded channel; the opt-in log's bounded, drop-rather-than-block
  queue (ADR-0014) is the precedent.

- **Nothing cross-checks the model's session ids against `SessionManager` and `SinkRegistry`**
  (2026-09-11, not started). Drift between the three is invisible today. Log a mismatch loudly,
  and auto-clean a session only when it is provably orphaned — ADR-0010 makes an exited tab
  revivable under the same id, so a missing sink is not by itself proof.

- **An exited tab keeps a live tab's replay budget** (2026-09-11, not started). A finished tab
  still holds up to 1 MiB of replay although nothing will attach to it again except to read the
  final screen. Measure whether 128–256 KiB still preserves a useful last screen and transcript
  before changing the per-session behaviour. Same cap as the *1MiB-replay workspace switch*
  entry, wanted smaller for a different reason.

- **Windows PTY resource soak — landed 2026-09-12 (compile-gated only; first Windows run
  pending)**. `crates/mast-core/tests/soak_windows.rs` (`#[ignore]`, Windows-only) rotates 500–
  1,000 create / kill / rapid-respawn cycles through `PtySession` and judges that handles,
  threads, private bytes and the `conhost`/`OpenConsole`/`wsl`/`wslhost`/`wslrelay` counts come
  back to a settled post-warm-up baseline — process counts with no slack, since a leftover relay
  is the defect itself. `scripts/win/soak-pty.ps1` runs it and keeps the log and CSV; the rule,
  the columns and the env knobs are in `docs/WINDOWS-BUILD.md` §13. It was written on the Linux
  box, so only the Windows-target clippy has seen it — nothing is verified until someone runs it.

- **The `portable-pty`/ConPTY shutdown path has never been audited on a supported Windows 11
  build** (2026-09-11, not started). Verify that pseudoconsole, pipe, process and thread handles
  are released on normal exit, explicit kill, failed spawn and rapid respawn. Verification work
  unless the soak test above turns up a leak. The soak test is the instrument for it — its three
  cycle patterns are exactly normal exit, explicit kill and rapid respawn, so the audit is
  reading its handle and process columns rather than building a second harness (failed spawn
  stays uncovered).

- **≤100MB RAM** — ~129MB at checkpoint 2 sits inside the 100–150MB adoption band
  (ADR-0001); getting under 100MB is a v2 optimization.

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

- **The chime is gone but its class is not** — `chime.ts` still exports `Chime`,
  `installChimeUnlock` and `AudioContextFactory`, and nothing outside its own tests imports
  them (v0.3.7 removed the chime itself; `main.ts` takes only `detectNeedsInputOnset` /
  `needsInputToastTargets` from that module). Dead code with a live test surface, so deleting it
  is its own small change — noticed during the 2026-08-22 log cleanup, which is why three of the
  surviving `console.debug` lines sit in code that never runs.

## Layout

- `crates/mast-core` — pure Rust core (PTY session, flow control, OSC scanner, replay
  buffer, and the `model`/`command` state + dispatcher). No Tauri dependency; this is
  where unit/integration tests live.
- `crates/mast-remote` — the LAN remote surface's HTTP server: head parser on `httparse`,
  route table, pairing token, per-IP limiter, handlers. Pure Rust, no Tauri; its integration
  tests run against a real listener on Linux (`tests/server.rs`, unix-only `tests/server_pty.rs`).
- `apps/mast` — the MVP app (계획 v2 section 17, stage 10 onward): Tauri v2 + vanilla TS
  frontend driving the `mast-core` `Dispatcher` over a single serializable `Command` bus.
  Architecture: ADR-0002 (state/bus/attach), ADR-0003 (split/tab UI).
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
