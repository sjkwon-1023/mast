# ADR-0035: Agent file and diff presentation

- Status: accepted
- Date: 2026-10-20
- Verification: the automated gates listed under Verification. The macOS compile and field checks,
  the Windows and WSL field checks (G3), and the ARM64 clippy gate remain pending. Nothing in
  `docs/WINDOWS-BUILD.md` §10 or `docs/MACOS.md` is recorded as passed by this ADR.

## Context

An agent running in a mast terminal could send text to another pane and list tabs, but it could
not show a file or a Git diff to the user inside mast. It had to print the content or start a
Windows application. The user also had no direct way to open a path that appears in terminal
output.

The goal is that an agent can put a file or a diff in a mast viewer pane beside its terminal,
without taking focus, switching workspaces, or rearranging the user's layout, and that the user
can Ctrl/⌘+click a path in terminal output to open it the same way. The product principles bound
the design (ADR-0030): viewers stay lazy and read-only, an inactive workspace keeps no renderer,
every long-lived structure is bounded, and no always-on service is added for this feature.

## Decisions

### 1. The viewer pane is an explicit workspace field

`Workspace.viewer_pane: Option<PaneId>` is part of the persisted model. The first successful call
without an explicit placement fills it; an explicit `--pane` or `--split` never changes it. The
slot survives app restarts and webview reloads. It is cleared when its pane is removed, including
when the last tab closes and the pane collapses. An empty pane that remains as the only pane is a
valid viewer pane.

Load (`persist.rs` `sanitize`) clears a dangling reference and records the reason. `Workspace::validate`
does not repair state, so a corrupt layout is not silently normalized.

### 2. One atomic `PresentViewer` command, with focus preserved

`Command::PresentViewer { source, viewer, placement }` is the only mutation for showing a viewer.
`viewer` is a `ViewerSpec` with four kinds (folder browser, changes, text, Markdown). It cannot
create a terminal or a browser tab. `source` must be a live terminal tab. Placement is `default`,
`pane`, or `split`.

Invariants:

1. A success is one revision, one state publish and one save schedule. A failure changes nothing:
   not the id counter, the tree, the tabs, the viewer slot or the active state.
2. Neither `activeWorkspace` nor any workspace's `activePane` changes. An explicit pane must belong
   to the source workspace.
3. When the target is the workspace's active pane and that pane has an active tab, the new tab is
   added in the background (`active: false`). Otherwise the new tab becomes the pane's active tab.
   A user reading or editing the current tab is never covered.
4. A split keeps existing panes and their active tabs. The new pane's tab is active.
5. The file and Git work runs before the dispatcher lock is taken. The source (its tab, the terminal
   session captured at receipt, and its workspace) and the target are checked again under the lock,
   once, before the single dispatch. A source whose session exited or was replaced by a respawn is
   `unknown_target`. A missing explicit pane is `unknown_target`. Nothing falls back to another pane.
6. Before a structural DOM change, the focused element is recorded. If the move alone leaves focus
   on `body`, the element is restored once. If the user moved focus to a sidebar, memo, browser or
   another app, nothing is restored (`workspace-view.ts` `restoreMovedFocus`).

Placement resolution (`command/mutations.rs`): `default` uses `viewerPane` when set; otherwise it
splits the source terminal's pane to the right and records the new pane as the viewer pane.
`pane` uses that pane. `split` creates a new pane on the named side and never records it.

### 3. Paths are folded as text, then checked by the existing validators

- The CLI makes the argument absolute from its own working directory with Python's
  `os.path.realpath`. The CLI runs in the distro that holds the path, so this is exact.
- A click joins a relative path with the source tab's working directory and folds `.` and `..`
  as text (`crates/mast-core/src/presentation.rs` `resolve_path`). `..` at the root stays at the
  root. Empty segments are dropped. Both forms then pass `wslpath::validate_linux_path` or
  `platform::validate_native_path`. macOS also folds before the tab is created, because native
  validation rejects `.` and `..`.
- A stat that follows links (`fs::metadata`) decides the kind. Only regular files and directories
  are shown. A missing path is `not_found`; any other non-regular kind is `invalid_path`.
- A `.md` extension, case-insensitively, opens the Markdown viewer. Other regular files open the
  text viewer. Directories open the folder browser.
- `diff` asks Git for the repository root of the path itself when it is a directory, or of its parent
  when it is a file, and opens the changes viewer at that root (`diff_lookup_dir`, `repository_root`).
  A missing path is not searched upward. A path outside a repository fails with `not_repository`.
- No WSL `realpath` subprocess is used. The `:line[:col]` suffix is not parsed by the CLI, and nothing
  jumps to a line. On Windows the Linux path rules (`wslpath::validate_linux_path`) refuse a `:` in
  any path component, so `mast open notes.md:12` fails with `invalid_path`. On macOS the same command
  names a file called `notes.md:12` and fails with `not_found` unless that file exists. A click strips
  the suffix and ignores it.

The viewers keep their existing size and encoding limits. A success response means the tab was
created; it does not promise that the content rendered.

### 4. Click recognition is text-only and bounded

The provider is an xterm link provider; the HTTP link addon is not replaced
(`features/terminal/file-links.ts`).

- Hover and recognition never call the filesystem, IPC or Git. Activation (Ctrl on Windows, ⌘ on
  macOS, plus a click) makes one `present_terminal_path` call. A plain click opens nothing.
- Recognized shapes: absolute paths, `./` and `../` paths, bare `dir/file` names, and names with an
  extension. Each may carry a trailing `:line` or `:line:col`. A path may be wrapped in single
  quotes, double quotes or backticks, and a quoted path may contain spaces. A quoted path needs no
  extension or slash (`"LICENSE"`, `"My Folder"`), but it must not be empty or padded with spaces. The
  quoted text is literal: no shell expansion and no environment variables.
- A quote opens only at the start of a word, after an opening bracket, or right after `=` or `:`
  (`key="a b.md"`). Its closing partner is the next identical quote. A quoted span is consumed
  whether it is accepted or rejected, so no word inside it becomes a link on its own. A rejected
  span also consumes the rest of its word: `"docs"/notes.md` does not link `/notes.md`. In that
  rest, a quote that opens after `=`, `:`, an opening bracket or `/` takes its closing partner with
  it, and the word is read on to its end again: `key="a b"="c d.md"` and `"src"/"my file.ts"` link
  nothing. An opening quote with no closing partner ends the scan for that logical line: the rest of
  the line gets no links.
- Trailing `.,;:)]}>'"` are removed from unquoted paths (F10).
- Not recognized: unquoted spaces, `~` and `$HOME` text, Windows `C:\` and UNC text, arbitrary URI
  ranges (`scheme://`), and bare words with no slash, extension or quote.
- A logical line (soft wraps included) is limited to 16 KiB and 64 candidates. Over the limit the
  line gets no links, and partial paths are never produced. A line whose first row is still marked
  as a soft-wrap continuation has lost its start to the scrollback, so it gets no links either.
- Clicks always use `Action::Open` with `Placement::Default`.

### 5. Requests, replies and errors

- Transport: the existing `OSC 777;mast-query;<kind>;<base64 reply path>` framing, with
  `kind = presentation:<base64 JSON>`. The reply path rules are the query channel's rules.
- Request: `{action: layout | open | diff, path?, placement?}`. `placement` is `{pane}` or
  `{split: {pane, direction}}`, where `direction` is `right` or `down`. Ids are positive safe
  integers no larger than 2^53 − 1. The server checks types, lengths and the mutual exclusion of
  placements again. The requester's session chooses the source; a request cannot name a workspace
  or a distro.
- The decoded request is limited to 32 KiB. The reply is limited to 1 MiB and is never truncated.
  A larger reply becomes `too_large`. The viewer tab stays open because the mutation already
  happened.
- Concurrency: presentation requests share the sink's in-flight cap of 8 with send and list
  queries. Over the cap no reply file is written, and the CLI sees a timeout.
- Deadlines: the server gives up at 15 s after receipt and mutates nothing past that point; the
  deadline is checked after the I/O returns. The CLI waits 20 s and never resends.
- Error codes are fixed. `ErrorCode::as_str` is the only source, and the messages are English:

  | Code | Used for |
  |---|---|
  | `invalid_params` | A malformed request |
  | `invalid_path` | A path that is not absolute, or not a regular file or directory; a relative click in a tab without a working directory |
  | `not_found` | The path does not exist |
  | `not_repository` | `diff` found no Git repository |
  | `unknown_target` | An explicit pane is not in the source workspace, or was closed. A pane of another workspace gives the same code |
  | `busy` | The glue's Git slots are exhausted. It is not a general request limit |
  | `timeout` | The server's 15 s deadline passed |
  | `too_large` | The reply would exceed 1 MiB |
  | `io_error` | Any other I/O failure |

- Success: `{"result": ...}`. The `open` and `diff` result is `{workspace, pane, tab, kind, path,
  active}`.
- The CLI adds no codes of its own (`scripts/wsl/mast-presentation.py`). A request it cannot send
  or a reply it cannot read is `io_error`. An oversize reply is `too_large`. No reply within 20 s is
  `timeout`. A usage error exits 2 before anything is sent.
- The click IPC `present_terminal_path` and the geometry IPC `report_pane_geometry` are reachable
  only from the main webview (`restrict_browser_ipc`).

### 6. Pane sizes are pushed, not requested

- The main webview's pane `ResizeObserver` (`pane-view.ts`) computes the grid. A terminal pane uses
  xterm's cols and rows. A viewer or empty pane divides its content box, less the computed padding and,
  for the width, the 14 px scrollbar column that FitAddon also reserves, by the cell size of the current
  terminal font. The result is raised to FitAddon's minimum of 2 columns and 1 row, and a 0×0
  content box is not reported. The cell is measured the way xterm measures it: canvas glyph
  metrics first, a DOM probe only where those are missing, then the line height and the device
  pixel ratio applied as the DOM renderer does. A probe is attached only while it is measured.
- Reports also follow the xterm grid of the shown terminal (fit and font zoom), a change of the shown
  tab, and a font change for viewer and empty panes. Without one of these events nothing is scheduled.
- A report is debounced (200 ms) and sent through `report_pane_geometry(pane, cols, rows)` only
  when it differs from the last value that was sent successfully (`features/workspace/pane-geometry.ts`).
  At most one report is in flight; a size that changes meanwhile is compared with the sent value when
  the report completes, and sent then if it differs. After a failed report, a change that arrived in flight
  is sent once more; a failure with no such change is not retried.
- The glue keeps the reports in memory (`apps/mast/src-tauri/src/presentation.rs`). The store is
  bounded by the number of live panes and is pruned when panes disappear. Nothing is written to disk.
  A grid with cols or rows above 10,000 is rejected. A report for an unknown pane is dropped silently. The lock
  order is Dispatcher, then the geometry store.
- Phone PTY sizes are not mixed in. There is no request-time measurement, no bridge, no timer and no
  service.

### 7. `mast layout` is a pure lookup

The result is `{workspace, revision, self, focused, viewerPane, tree, panes}`. The key is `tree`,
the existing split tree (the plan's working name `layout` was not used). `panes` is in leaf order.
Each entry has `id`, `activeTab`, `tabs` (each with `id`, `kind`, `title`, `path`, `url`), `cols`,
`rows`, `sizeSource` and `reportedAt`.

- `sizeSource: "measured"`: the last reported grid, with `reportedAt` in epoch milliseconds.
- `sizeSource: "unknown"`: nothing has been reported, so `cols` and `rows` are null.
- `focused` is the workspace's active pane only when that workspace is the active one; otherwise it is
  null. Panes of other workspaces are never exposed.
- An inactive workspace is answered from its last reported values. No renderer is created for it.
- The `layout_unavailable` and `stale_layout` codes of the first plan went away with the request-time
  bridge.

### 8. The bundled skill decides placement

`scripts/wsl/skills/mast/SKILL.md` carries the placement rules, and the agent follows them:

- By default a plain `open` or `diff` reuses the viewer pane. `layout` is queried only for a requested
  arrangement or when a new split might not fit.
- A pane the user named takes precedence. A pane that holds a terminal tab is never made a viewer
  pane unless the user named it.
- A new `right` split fits when each side is at least 60 columns after the split (the original at
  least 122). A new `down` split fits when each side is at least 12 rows (the original at least 28).
  The skill does not propose a split when `sizeSource` is `unknown`. These are advisory; the backend
  enforces nothing.
- With no room, the tab is added to an existing pane and may open with `active: false`.
- `unknown_target` gets one re-query. There is no polling, no retry loop, and no resend after a
  timeout. A timeout does not mean nothing changed.

### 9. The CLI and its installation

- `mast layout`, `mast open` and `mast diff` are implemented in `scripts/wsl/mast-presentation.py`.
  The setup script (`SETUP_VERSION` 25) installs the helper beside `mast-browser.py`, and the
  assembled `mast` dispatches to it. macOS dispatches through `scripts/macos/mast.py`.
- Exit codes: 0 on success; 1 on a failure, with the error envelope on stderr; 2 on a usage error,
  with nothing sent.
- The names differ on purpose. `mast open` shows a file in a mast viewer pane. `mast-open` and
  `xdg-open` hand the path to a Windows application.

## Alternatives rejected

- A request-time measurement bridge that asks the main webview for each `layout`. It needs a wait, a
  slot table and stale-layout retries, and pushed values answer the same agent question without a
  renderer.
- Estimated sizes for inactive workspaces, computed from the window and the split ratios. That is a
  number that was never displayed. The stored last value is labeled as such instead.
- A WSL `realpath` subprocess for canonicalization. It adds a distro process per click, a time budget
  and its own failure modes. The text fold and the stat check are accepted with the symlink limit below.
- A "last created pane" heuristic for the viewer slot. It changes meaning after a user split, a tab
  move or a restart. One persisted field is a smaller contract.
- A heuristic slot chosen from the current layout, such as the first viewer-only pane. The skill makes
  that choice explicitly instead.
- Two dispatches (split, then restore focus). They expose an intermediate snapshot and race with user
  input. One command keeps one revision.
- A CLI-only error code for local failures. It would extend the fixed contract. The failures map to
  `io_error`, `too_large` and `timeout` instead.

## Accepted limits

- `symlink/..` folds as text on the click path, so it can name a different file than the filesystem
  would. The CLI path uses `os.path.realpath`, which resolves symlinks.
- A relative click resolves against the tab's current working directory (from OSC 7), not against the
  directory at the time the output was printed. A tab without shell integration fails with
  `invalid_path`.
- An inactive workspace shows its last measured size. A UI reset keeps the last value: the user decided
  on 2026-10-20 to keep it rather than clear it. Sizes are not PTY sizes. They can be stale while the
  window is minimized or the workspace is not visible; a window resize is reported again.
- The `/tmp` reply path check is string-level. A pre-planted symlink can redirect a reply. This is the
  query channel's existing limit and is unchanged.
- Deadline checks run only after the I/O returns, and `std::fs` calls are not cancelled. The Git lookup
  runs for at most the smaller of its own 10 s bound and the time left in the request, and it does not
  start after the deadline or with 1 s or less left. On every platform, a Git timeout that fires before
  the deadline is reported as `io_error` with the 10-second message, not as `timeout`.
- A `timeout` can follow a committed change whose reply was lost. The CLI's message says the request may
  already have taken effect.
- A `too_large` reply after a successful change leaves the viewer tab open.
- `busy` reflects exhausted Git slots only.
- A `:line[:col]` suffix on a click is stripped and ignored. There is no line jump.
- On Windows, a Linux file whose name contains `:` cannot be opened (the existing viewer path rule).
- Ordinary words that look like extensions, such as `e.g` and `this.state`, also get hover links. A
  click without the modifier does nothing. Inside quotes no extension is required, so quoted plain
  words and JSON keys (`"ok"`, `"status"`) get hover links too.
- An opening quote with no closing partner ends the scan for the rest of its line (§4).
- A viewer grid can differ from the terminal's by one row or column when a cell is not a whole number of
  CSS pixels (the device pixel ratio is not 1, or the glyph width is fractional), and when FitAddon's
  `parseInt` truncation of the parent width leaves a 1 px difference. The measured grid is an approximation.
- macOS follows the same contract. Its path and window behavior are not verified on a device yet.

## Verification

Automated coverage:

- `crates/mast-core`: request parsing, path folding, kind judgement, placement and the atomic
  `PresentViewer` invariants (`presentation.rs`, `command/mutations.rs`, `command/tests.rs`).
- `apps/mast/src-tauri` `presentation::` tests: source and target re-checks, deadlines, the reply
  size boundary, error codes, and the geometry store. CI runs them on Windows (`windows-gates`,
  step `Presentation tests`).
- `features/terminal/file-links.test.ts`: recognition, quoting, suffix stripping, trailing
  punctuation, limits and the single activation call.
- `features/workspace/pane-geometry.test.ts`: debounce, duplicate suppression and disposal.
- `features/workspace/structure-focus.test.ts`: DOM focus preservation across structural changes,
  and no restoration after a user move.
- `tests/presentation-cli.test.ts`: parsing, placements, the request on the wire, error envelopes, the
  timeout message, the 1 MiB boundary, the pseudo-terminal fallback and the assembled CLI routing.
- `scripts/macos/tests/test_native.py` runs in CI `gates` on Linux. Its five macOS-only cases are
  skipped there.
- `tests/hook-example.test.ts` checks the documented setup marker against `SETUP_VERSION`.

Not verified by these gates:

- The diff's real `git` was run on Linux only. The Windows path was checked with injected repository
  probes.
- The macOS compile, the ⌘+click path, WKWebView focus, and the macOS CLI `layout`, `open` and `diff`
  are pending (`docs/MACOS.md`).
- The Windows and WSL field checks (`docs/WINDOWS-BUILD.md` §10, "Unreleased — agent file open field
  verification") are pending.
- The ARM64 clippy gate runs only in CI.
