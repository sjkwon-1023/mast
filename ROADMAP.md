# winmux roadmap

winmux is a **lightweight multi-agent coding workspace for Windows + WSL2**. The product goal is not to grow into a full IDE. It is to make several terminal coding agents easy to run, inspect, switch between, and control while keeping inactive UI cost low.

This file tracks user-facing work and reliability work that is worth doing next. Detailed implementation notes and historical decisions still live in `CLAUDE.md` and `docs/adr/`.

## Product principles

- Keep the Rust/session side durable and the WebView side disposable.
- Do not keep inactive workspace renderers alive just to preserve UI state.
- Bound queues, replay buffers, caches, and other long-lived structures.
- Prefer lazy/read-only viewer surfaces over embedding a full editor or IDE runtime.
- Preserve agent sessions across UI resets; never use backend restart as a routine memory-recovery mechanism.
- Add features only when their idle cost stays small for users with many workspaces and agents.

## Near term

### Terminal and workspace fidelity

- [ ] **Preserve Codex transcript/scroll state across workspace round-trips without workspace-wide keep-alive.** Investigate the reattach path first, especially replay followed by the forced `SIGWINCH` resize nudge. Keep the current model where inactive workspace xterm instances are disposed.
- [ ] **Revisit the attach-time redraw policy.** If a session has already been attached in the current WebView lifetime, avoid unnecessary redraw/resize side effects where possible while retaining the recovery path needed after an actual WebView reset.
- [ ] **Reduce retained memory for exited terminal tabs.** A finished tab no longer needs the same replay budget as an active session. Measure a smaller post-exit replay target (for example 128-256 KiB) that still preserves a useful final screen/transcript before changing the current 1 MiB/session behavior.

### Backend and Windows resource safety

- [ ] **Add a Windows PTY resource soak test.** Repeatedly create/close and respawn terminals (500-1,000 cycles) and record process private bytes, handle count, thread count, `conhost`/`OpenConsole` and `wsl.exe` process counts, plus system paged/nonpaged pool where practical. The important assertion is that resource counts return close to baseline rather than growing per cycle.
- [ ] **Audit the `portable-pty`/ConPTY shutdown path on supported Windows 11 builds.** Verify pseudoconsole, pipe, process, and thread handles are released on normal exit, explicit kill, failed spawn, and rapid respawn. Treat this as verification work unless the soak test shows a leak.
- [ ] **Add backend invariant diagnostics.** Compare terminal session IDs referenced by the model with `SessionManager` and `SinkRegistry`. Log mismatches loudly; only auto-clean a session when it is provably orphaned.
- [ ] **Expose backend resource diagnostics for long-running sessions.** On a warning, capture backend RSS/private bytes, live/exited session counts, replay bytes, handle/thread counts where available, and orphan counts. Do not automatically restart the backend because that would destroy live PTYs and agents.
- [ ] **Bound the persistence handoff explicitly.** Replace or wrap the current unbounded saver channel with a latest-state slot / bounded channel so a producer burst cannot queue an arbitrary number of cloned `AppState` snapshots.

### Git workflow

- [ ] **Populate workspace Git branch/dirty state.** The model already reserves `gitBranch` / `gitDirty`; wire them to the workspace root and keep refresh cost bounded.
- [ ] **Add a lightweight Changes view next to the existing file viewer.** Show changed files with `M/A/D/?`, support Working / Staged / All, and fetch the selected file's diff lazily rather than materializing the whole repository diff in the DOM.
- [ ] **Use a small diff renderer, not an IDE editor runtime.** Unified diff should be the default; optional side-by-side can be added only if it remains cheap for large diffs.
- [ ] **Add agent handoff from a diff later.** Allow selected lines or collected review notes to be sent to the active Claude Code/Codex tab as file/line context without turning the viewer into an editor.

### Public UX and onboarding

- [ ] **Add a short hero GIF/video and screenshots to the README.** Show the actual workflow: several agents running, sidebar status changing, opening a file/Markdown tab, and checking/sending input from a phone.
- [ ] **Keep first-run setup small.** Make automatic agent-hook provisioning obvious in the docs and surface failures clearly. Add a settings UI or setup assistant only if real users are blocked by the current file-based settings.
- [ ] **Reduce release friction if adoption grows.** Revisit Windows code signing/SmartScreen once external usage justifies the cost.
- [ ] **Collect a small set of real external users before broadening scope.** Prioritize repeated-use feedback over adding generic terminal/IDE features.

## Later / optional

- [ ] Phone image attachment: authenticated upload -> WSL-visible temporary file -> send path to the target agent, with a bounded size and cleanup policy.
- [ ] Built-in browser tab, if it can be isolated so an unused browser costs nothing.
- [ ] Keyboard splitter resize and other accessibility improvements.
- [ ] Revisit replay size/progressive replay if workspace reattach latency remains visible after the Codex/TUI work.

## Non-goals for now

- Keeping every workspace's xterm/renderer alive just to preserve visual state.
- Becoming a full code editor or IDE.
- Supporting PowerShell/CMD profiles; WSL2 remains the terminal execution model.
- Restarting the Rust backend as a routine memory watchdog action.
- Adding always-on services whose idle cost scales with the number of workspaces unless the feature clearly requires it.
