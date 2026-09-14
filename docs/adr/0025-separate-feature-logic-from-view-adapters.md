# ADR-0025: Separate feature logic from view adapters

- Status: accepted
- Date: 2026-09-14

## Context

The text and terminal view files each combined roughly 1,100 lines of rendering,
settings state and reusable logic. Startup, Markdown and terminal record views imported
settings or helpers through those view modules. Keyboard action execution also lived in
the application bootstrap. Rust's command dispatcher contained over 3,000 lines of tests,
and the Windows app crate owned firewall policy that could be tested without Windows.

## Decision

- Organize the desktop TypeScript source into `app/`, `features/`, `infrastructure/` and
  `shared/`. Group workspace, terminal, viewers, changes, pairing and notification code by
  feature, with tests beside their owners. Keep the phone browser's `remote/` as a separate
  entry point. `src/README.md` maps responsibilities and the desktop/remote boundary.
  Import the owning module directly; the old paths do not remain as re-export facades.
- `app/` owns bootstrap, snapshot distribution and app-wide wiring; `infrastructure/` owns
  Tauri calls, native visibility and logging. `shared/` holds serialized contracts and shared
  decisions. Move the Vite-only xterm patch and its regression tests into `tooling/`, and WSL
  helper integration tests into `tests/`. Update HTML, build and test file references together.
- `features/viewers/text/window.ts` owns byte-window and scroll geometry calculations; `features/viewers/text/settings.ts`
  owns configured languages; `features/viewers/text/highlight.ts` owns language selection, markup splitting
  and lazy highlighter loading. `features/viewers/text/view.ts` owns DOM and file-read orchestration.
  Language selection receives the configured list explicitly from the view.
- `features/terminal/settings.ts` owns font state, theme and the registry shared with record views.
  `features/terminal/interaction.ts` owns clipboard/link helpers; `features/terminal/scroll.ts` owns restoration
  decisions and the output-settle state machine. `features/terminal/view.ts` owns xterm and IPC.
- `features/viewers/viewer-scroll.ts` owns the scroll echo guard and debouncer shared by text and Markdown.
  `app/navigation/actions.ts` owns keyboard listener installation and action execution, receiving
  current state and UI actions through a small context. Shared workspace selection stays
  with the existing pure navigation helpers in `shared/keys.ts`.
- Keep Rust's existing feature modules. Extract command unit tests into the private child
  module `command/tests.rs`, preserving access to dispatcher internals. Split `impl Dispatcher`
  across private child modules: `mutations.rs` executes structural commands, `tabs.rs` prepares,
  respawns and retires tabs, `events.rs` applies session/OSC changes, and `queries.rs` handles
  lookups and agent targeting. `audit.rs` owns registry diagnostics and re-exports its existing
  public types/functions through `command`. The root retains public command contracts, state
  ownership, initialization and the single dispatch revision/invariant boundary. Cross-module
  helpers use `pub(super)` only; the crate's external API and operation ordering do not change.
- Describe Rust responsibilities with short module maps at the core, remote and Tauri entry
  points. Do not introduce `domain/application/infrastructure` directories. `mast-core` is
  framework-independent, but includes PTY, filesystem and process I/O; it is not a pure domain
  layer. `mast-remote` supplies the HTTP input adapter, and the Tauri app supplies desktop/OS
  integration and assembly.
- Move firewall policy and script generation into `mast_core::firewall`, retaining Win32
  collection and execution in the app (ADR-0016 amendment). Keep only the values and functions
  needed across that crate boundary public. Restrict `flow` and `replay` to `pub(crate)`;
  `ReplayBuffer::is_empty` is used only by unit tests and is compiled only for them.
- Keep source comments for contracts, units, ordering constraints and non-obvious failure
  modes. Existing ADRs carry the longer rationale and incident history.

## Consequences and verification

Settings consumers no longer load a terminal/text view module. Terminal calculation tests
run in the Node environment without a browser shim. Rendering lifetimes, IPC shapes,
keyboard mappings, zoom behavior and firewall decisions remain unchanged.

Existing text rendering, highlighting and terminal restoration tests follow their feature
folders. Navigation tests exercise latest-state selection, UI dispatch, shared zoom and
capture-phase interception. Firewall and dispatcher tests run through the existing core
suite; Windows-target workspace Clippy/check still validate the app boundary. Real UAC,
COM enumeration and WebView behavior remain covered by the Windows manual checks.
