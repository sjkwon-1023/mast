# CLAUDE.md

mast — a lightweight cmux-style terminal for Windows, centered on WSL2 and coding agents
(Claude Code / Codex). Decisions: `docs/adr/`.

The product plan `터미널-계획-v2.md` (Korean) is **no longer in the tree** — it was removed
when the repo went public. "계획 v2 <n>장 / section <n>" citations in the ADRs and the
remaining plan docs still point at it; read it out of git history when one of them matters (`git show HEAD~1:터미널-계획-v2.md`, or any commit before
its removal).

## Current state

MVP stages 10–22 are complete and Windows-verified; stage 22 (CI) runs the gates on every PR
and on pushes to `main` or a `v*` tag. **Remaining: stage 23**, ARM64 device testing
(`docs/WINDOWS-BUILD.md` §11), which awaits hardware. Every decision lives in `docs/adr/`;
the WINDOWS-BUILD §10 subsections per release stay as regression checklists.

One field lesson worth keeping: synthetic needs-input tests must reset state first
(`mast:idle` then `mast:needsInput`) — the onset only fires on a transition.

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

Open work and accepted limits only, grouped by surface. Landed work is recorded in the ADRs
and git history — read the linked ADR before reopening a decision. Nothing here blocks the
MVP.

#### Terminal panes, tabs and splits

- **No way to split around an existing split** (user request 2026-08-15). The tree already
  represents the shape; only `SplitPane` exists and it targets one leaf. Smallest useful
  shape: a root wrap (`SplitRoot { direction, tab }`). Open: whether it takes the insertion
  side or is right/bottom-only.
- **Workspace switch with a 1 MiB replay is ~236 ms with visible flicker** (ADR-0004).
  Candidates: smaller replay cap, progressive replay, hide-until-parsed. ADR-0015 re-asserts
  modes, so a smaller cap now costs only redraw fidelity. The reattach reprint also spends
  ~192 KB of replay per round-trip; one resize instead of the two-step nudge is the cheaper
  lever (ADR-0019 decision 6).
- **Scroll restore across automatic reloads** (ADR-0019 amendment 2026-09-20): whether
  `pagehide` fires on the reset supervisor's reloads is unverified in the field.
- **Terminal modes after reattach** (ADR-0015): the alt screen is deliberately not
  re-asserted, so a TUI whose `?1049h` was evicted returns on the normal buffer; a paste
  during the replay gate is logged, not buffered.
- **Korean input on Windows still drops or overwrites syllables — diagnostics added 2026-10-20,
  waiting for the next reproduction** (ADR-0020, amended 2026-10-20). The cause is not confirmed.
  `@xterm/xterm` 6.0.0 ships the upstream composition fix and the 5.5 build-time patch is gone, but
  the field reports continue on 6.0: `수준이야` → `주주ㅇ야` (2026-10-18) and `이미지` → `미미지`
  (2026-10-19), each an earlier syllable overwritten by the next one, rarely. Once it happens it
  persists until the window loses focus to another app and comes back. `mast.log` at 2026-10-19
  22:15:31 holds the only out-of-order sequence among 809 composition events in that window: a
  `compositionstart` before the open composition ended, then an `update` and a second `end` after it
  closed — Microsoft IME overlapping compositions, which xterm's composition helper does not handle
  (upstream #6049 family; #6089 and #5778/#6140 also remain). The user remembers that in the bad state
  a neighbouring pane's ordinary shell also received the wrong characters, so the bytes likely reach
  the PTY and the stuck state is shared across panes (each pane has its own xterm and textarea) —
  confirm with `cat > /tmp/ime.txt` and `xxd` from another pane reached with `Alt+Shift+arrows` while
  the bad state persists (WINDOWS-BUILD §10 F1). The opt-in log now writes `ime: commit match=…` (or
  `match=unknown reason=…`) per terminal bundle — whether the committed text equals xterm's `onData`,
  with bounds and no content — and `pane: focus from=… to=…` from the same install (ADR-0020
  amendment). The next reproduction picks the fix: `match=true` with wrong text points at the IME or
  WebView2 side, where a per-textarea blur/refocus is unlikely to help (a pane switch already moves
  focus between textareas); `match=false` points at xterm, where a Windows input adapter that commits
  from the textarea value, like the macOS `webkit-ime.ts`, is the candidate. The `shared/keys.ts` `isComposing` guard and the
  composition log lines (ADR-0014) stay.
- **Splitter resize is mouse-drag only.**
- **Per-pane split-button affordance** (ADR-0004): a first-time user read the header
  buttons as "split the selected pane".

#### Workspaces and the sidebar

- **`git_branch`/`git_dirty` are reserved on the model and never populated.** Bounding the
  refresh cost for many workspaces decides the design.
- **Workspace drag has no autoscroll** past the visible list (`MoveWorkspace` rustdoc and
  the sidebar drag code record the decisions).

#### Viewers

- **Changes viewer** (ADR-0022): Windows field verification pending.
- **Notepad drawer** (ADR-0034): Windows and macOS field checks (WINDOWS-BUILD §10 "notepad field
  verification") not yet run; the macOS target was neither compiled nor tested for this change.
  Accepted: no merge UI for an unknown on-disk note.
- **Reload while minimized** resumes Markdown polling until the next minimize/restore
  cycle — accepted narrow window.

#### Agent integration — hooks, notify, resume, the `mast` CLI

- **Agent state per tab** (ADR-0026, WINDOWS-BUILD §10 v0.3.32 not yet run). Codex needs
  input is a 2 s timing heuristic with the false positives the ADR lists; Claude's
  feedbackless denial leaves a stale status until the next prompt; per-hook latency is
  unmeasured; no Python 3.6 interpreter, `wsl.exe` relay or Windows-only glue test has run
  against it.
- **Antigravity CLI** (ADR-0026 decision 8): no needs-input signal and no resume hint;
  field verification must name the CLI version.
- **OpenCode** (ADR-0027): Windows TUI, toast and restart checks pending.
- **`mast send`/`mast ls`**: reading a pane's scrollback needs an opt-in design;
  `mast ls` shows `?` in `COMMAND` for tabs in another distro. Reaching another workspace
  would need an explicit opt-in (ADR-0005 addendum).
- **Agent file and diff presentation — field verification pending** (ADR-0035). Windows and WSL
  checks are WINDOWS-BUILD §10 "Unreleased — agent file open field verification"; the macOS checks
  are in the feature-parity list of MACOS.md. The accepted limits are recorded in ADR-0035.
- **Query-reply `/tmp` confinement is string-level only** — a pre-planted symlink routes
  the reply outside; the canonicalize-at-write fix is unverified on 9P.
- **WSL zsh tabs are not yet field-verified** (ADR-0011 amendment 2026-10-14): cwd tracking is
  covered by Linux PTY tests only, the ↑ resume hint only by the macOS cases of the shared zsh
  files, and the zsh `PATH` has not been compared
  with a plain `wsl.exe` zsh login. The checklist is WINDOWS-BUILD §10 "Unreleased — WSL zsh login
  shell field verification".
- **Agent auto-resume is not field-verified** (ADR-0026 amendment 2026-10-19; WINDOWS-BUILD §10 "agent
  auto-resume field verification"). `autoResume` ships default off with no device run recorded. Accepted:
  a session with no written hint is not restored; a bash tab that starts before setup refreshes
  `integration.sh` shows only the manual hint; an agent exited inside a nested shell left open at quit runs once
  at the next boot (only a bash nested under a WSL bash root is protected). The dead-tab case
  (`0x40010004`) and Windows shutdown were out of scope of that amendment; ADR-0018's 2026-10-20
  amendment now revives that code at boot, so those tabs reach the resume rules above.

#### Phone remote surface

- **Secure pairing over Tailscale** (ADR-0016 amendment 2026-09-17): decided, not started.
  Open: Tailscale detection, whether mast runs `tailscale serve`, the admin-console HTTPS
  step, elevation.
- **Secure Remote** (ADR-0028): no real-device WebTransport connection verified yet; the
  Windows UAC/firewall and phone checks are pending (WINDOWS-BUILD §17).
- **Image attach from the phone** (user decision 2026-09-08): needs an upload endpoint, an
  ADR-0016 amendment for the new capability and an upload lifetime rule.
- **Phone PTY size**: a fixed-grid mode with horizontal scroll if reading is not the main
  use.
- **Local HTTP remote limits** (ADR-0016): `PtySession::kill` waits on the `writer` mutex
  under the Dispatcher lock, so a stuck remote write can stall `CloseTab`; authenticated
  clients can hammer `since`-less requests; the phone bundle carries its own xterm;
  `lan_ip()` may pick the wrong interface on a multi-homed PC.

#### Settings and first-run setup

- **First-run `settings.json` with the remote surface on and `log` off** (requested
  2026-09-12, not started). It reverses ADR-0016 decision 1 (opt-in, zero idle cost) and
  the non-optional `RemoteSettings::port`, so it must say why the new default is right and
  where the user is told, and must follow the "only add missing values" discipline.
- **First-run setup failures are quiet**; a settings UI earns its cost only once a real
  user is blocked by `settings.json`.

#### Logging and diagnostics

- **Nothing enforces `winlog!`** — a bare `eprintln!` in the glue keeps its line out of
  `mast.log` (ADR-0014).

#### Session and resource reliability

- **Input that stops reaching a shell is not flagged** (ADR-0009). A `write_stdin` that
  does not return within seconds is the candidate signal; it shares a fix with the
  `writer` mutex item above. Also open: failures after the startup marker, and whether
  killing `wsl.exe` reaps the Linux-side relay (WINDOWS-BUILD §10 v0.3.9 item 2).
- **The records directory has no total-size cap** (ADR-0018); a total cap or age sweep
  belongs in the existing boot sweep.
- **Tabs killed by a Windows shutdown, restart or sleep** (ADR-0010, ADR-0018; amended 2026-10-20).
  With mast open, a Windows restart takes WSL down first and mast records every shell as exited with `0x40010004`
  (`DBG_TERMINATE_PROCESS`); field 2026-10-19 07:33, a restart from the Start menu, and field
  2026-10-20 07:36, where 14 sessions recorded that code and the diagnostics line in the same log
  read `running=8 exited=10`. The two are separate events. **The next boot now revives them:** load
  normalizes exactly that code to `Running`, and the existing respawn wave brings the tab back with
  its id, cwd, distro and `autoResume` rules (ADR-0018 amendment). Only tabs saved with that code
  revive; code 0 and 1 stay records. A successful respawn replaces the previous screen, and a failed
  one leaves `Exited` without code or time — both accepted. Remaining follow-ups, separate from this
  fix: restart a dead tab while the app stays up when its workspace is opened (a sleep or
  `wsl --shutdown`; a bulk Restart is the same work), paced by the boot wave rather than all at
  once; and handle `WM_QUERYENDSESSION` so mast saves and quits before WSL is torn down, keeping the
  tabs `Running` without relying on the exit code.
- **ConPTY shutdown audit**: the soak test (WINDOWS-BUILD §13) covers normal exit, kill
  and rapid respawn; failed spawn is uncovered. Dropping the PTY writer while the child is
  alive makes conhost end it with `0xC000013A`, so keep the drop order in `session.rs`.
- **Closed-tab history files orphaned by a force-quit** are never swept (ADR-0013).
- **≤100 MB RAM** is a v2 optimization (~129 MB at checkpoint 2).
- **Sessions do not survive a severed relay** — deliberate; a detach layer (`dtach`) was
  rejected on complexity.

#### Build, release and adoption

- **CI takes whatever stable Rust the runner ships**, so a new lint can turn a clean tree
  red. Pinning is undecided — recognize it as toolchain drift.
- **Unsigned releases meet SmartScreen**; revisit code signing when external usage
  justifies it.
- **The README has no screenshots or hero clip.**
- **No external users yet** — repeated-use feedback should decide the next scope expansion.

#### Code hygiene

- **OSC scanner C0 handling** — CAN/SUB abort is implemented; the other C0 cases were never
  reviewed against real terminal behavior (ADR-0001).

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
cd apps/spike && npm run build && npx vitest run
cd apps/mast && npm run build && npm run audit:secure-remote && npm run audit:secure-remote:self-test && npx vitest run
```

The Windows-target gates are **CI's `windows-gates` job**, on a `windows-latest` runner for
every PR and for pushes to `main` or a `v*` tag: x64 and ARM64 clippy (`--all-targets
-- -D warnings`) and x64 native test runs (`cargo test -p
mast-remote` plus the glue's `secure_remote` tests, which bind and release real UDP sockets).
They no longer run on the Linux dev host by
default: a dependency's C build script (ring, since the secure remote transport landed) needs an
MSVC C toolchain even for check-family commands, so the old Linux cross compile — which needed
only `llvm-rc` on PATH for tauri's resource embedding — stopped working when that dependency
landed. A local x64 run through Windows interop still works
(`WSLENV=CARGO_INCREMENTAL CARGO_INCREMENTAL=0 /mnt/c/Users/<you>/.cargo/bin/cargo.exe …`):
`WSLENV` has to carry `CARGO_INCREMENTAL=0`, because WSL does not pass its environment into the
Windows process and rustc's incremental session lock cannot be created on the
Windows-visible 9P path without it. ARM64 additionally needs `clang` for ring's build script and
is **CI-only on this machine** — not a local green. `windows-artifacts` builds the x64 + ARM64
release artifacts and attaches them to a GitHub Release on `workflow_dispatch` or a `v*` tag, and
`macos-artifacts` does the same for an unsigned `mast-macos-arm64.zip`; the trigger is narrow
because a release build per push is not needed, not because of runner billing (standard Windows
runners are free for public repositories). Users install and update either with the
`scripts/macos/install.sh` / `scripts/win/install.ps1` one-liners (ADR-0033); `windows-gates`
also runs the Windows installer tests.

- `src-tauri` cannot compile for the Linux host (no webkit2gtk) — the `windows-gates` job
  IS the compile gate for the glue.
- Windows build/run and the manual verification flow: `docs/WINDOWS-BUILD.md`.
- The app spawns `wsl.exe --cd ~ [-d $MAST_DISTRO] --exec bash -c <scripts/wsl/launch.sh>` on
  Windows; that wrapper execs the WSL login shell, zsh or bash (falling back to `/bin/bash`), and
  `$SHELL -l` on Unix.

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
