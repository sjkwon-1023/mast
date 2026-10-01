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
- **IME** (ADR-0020): whether the 2026-08-22 "stuck composition" report was the patched
  xterm fault is unconfirmed, so the `shared/keys.ts` `isComposing` guard and the
  composition log lines stay. The eventual fix is the xterm 6 upgrade as its own change.
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
- **Agent-facing file and diff presentation commands** (user request 2026-09-20): define
  the target pane, workspace confinement, path validation and read-only diff contract
  first.
- **Query-reply `/tmp` confinement is string-level only** — a pre-planted symlink routes
  the reply outside; the canonicalize-at-write fix is unverified on 9P.
- **Resume-hint ↑ integration is bash-only.**

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
- **No bulk Restart of exited tabs** after a sleep; it needs the boot wave's pacing
  (ADR-0010 amendment).
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
`macos-artifacts` does the same for an unsigned `mast-macos-arm64.zip` (ADR-0033);
the trigger is narrow because a release build per push is not needed, not because of runner
billing (standard Windows runners are free for public repositories).

- `src-tauri` cannot compile for the Linux host (no webkit2gtk) — the `windows-gates` job
  IS the compile gate for the glue.
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
