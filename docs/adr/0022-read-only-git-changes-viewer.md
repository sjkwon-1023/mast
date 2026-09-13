# ADR-0022: Read-only Git Changes viewer with bounded WSL queries

- Status: accepted
- Date: 2026-09-13

## Context

Users inspecting coding agents need the changed-file list and one selected file's patch
beside their terminal. The expensive boundaries are persisted enum compatibility and
subprocess lifetime. ADR-0021 handles unknown persisted tab kinds independently and must
ship first. The existing viewer registry already disposes inactive views and recreates
them on return; it supplies the desired idle behavior without another renderer policy.

## Decisions

1. Add `changesViewer` with a persisted `path` only. Creation uses an explicit path, then
   the workspace root, then `/`. The pane-header Changes button uses the workspace root.
   The title is `Changes`. Selection, Working/Staged/All scope, and both scroll positions
   belong only to the mounted frontend instance. There is no selection command or
   `scrollTop` field. The content commands never dispatch or broadcast snapshots.
2. Show a changed-file column and a read-only patch surface (initially plain unified diff;
   the amendment below adds colored responsive comparison). Mount reads status once;
   selecting a file reads its diff. Refresh explicitly reloads the list and the current
   selection. Same-kind snapshot updates do nothing. Switching tabs/workspaces disposes
   the view immediately; late responses cannot mutate the replacement view. No polling,
   syntax highlighter, editor, staging, or commit surface is introduced.
3. `git_status(distro, path)` returns `{root, unborn, entries, truncated}`. Each entry has
   `{path, originalPath, indexStatus, worktreeStatus, untracked, conflicted}`. Porcelain v2
   with NUL delimiters preserves whitespace, newlines, rename sources and unmerged entries.
   The query includes all untracked files, explicit rename detection, and branch metadata
   without ahead/behind traversal. The parser discards only incomplete trailing records
   when the capture is truncated. It refuses non-UTF-8 filenames instead of opening a
   different path through lossy decoding.
4. Resolve the requested path to the working repository's top level for display and
   subsequent diffs. A bare repository uses the worktree whose branch matches its symbolic
   `HEAD`; it skips bare/prunable entries. If that branch has no available checkout, report
   an error asking for a workspace at an explicit worktree path. Never silently choose an
   unrelated checkout. The originally supplied path remains persisted.
5. `git_diff(distro, request)` returns `{text, truncated}`. The request has
   `{root, path, originalPath, scope, untracked, unborn}`. Working compares with the index,
   Staged uses `--cached`, and All compares tracked files with `HEAD`. In an unborn
   repository, Staged uses Git's implicit empty baseline and All obtains the empty-tree ID
   with `hash-object -t tree --stdin` without `-w`, so SHA-256 repositories also work.
   Untracked files use `--no-index` against `/dev/null`; its difference exit status is
   accepted only with actual patch output. The frontend includes the rename/copy source
   in the request for the scope whose status is R/C, and always for All. This also covers
   unstaged renames discovered through intent-to-add without including a staged rename's
   unrelated source changes in Working. A staged deletion and an untracked replacement can
   share a path and remain separate list entries. An empty combined patch is shown as empty,
   not an error. An untracked nested repository remains visible in the list; selecting its
   directory asks the user to open that repository as a workspace instead of recursing.
6. Only the two typed read-only operations cross IPC. Internal Git discovery commands and
   query argv are fixed; the caller never supplies a Git verb or command string. Paths
   remain individual arguments, all file pathspecs follow `--`, and `--literal-pathspecs`
   disables pathspec magic as well. `--no-optional-locks` permits reads alongside an agent's
   `index.lock`. External diff, textconv, color, and fsmonitor are disabled. Binary files
   keep Git's normal summary; `--text` is never used. All file content enters the DOM via
   `textContent`.
7. Bound subprocess output and lifetime before adding the content surface. The shared
   capture primitive drains stdout/stderr without blocking reader threads, applies byte
   caps and a deadline, and reaps stopped children. Unix uses nonblocking pipes and a
   process group; Windows probes anonymous pipes before reads and hides relay consoles.
   Inside WSL, GNU `timeout` supervises the Linux process group and escalates to KILL after
   one second. Stopping `wsl.exe` alone is not claimed to terminate Linux descendants.
   Repository discovery and status share one 10-second capture budget; each diff has the
   same budget. The Linux timer begins after WSL startup, not when the Windows relay is
   spawned: its TERM + KILL interval is at most 10 seconds from that later start. A timeout
   response or output-cap stop can therefore precede Linux cleanup. This bounds the
   blocking-pool work without promising synchronous cross-OS process-tree termination.
   Up to four content requests enter the blocking pool, with no waiting queue.
8. Cap diff stdout at 512 KiB, equal to the existing text viewer's byte window. A shared
   Rust/TS fixture checks that equality. Cap status stdout at 1 MiB and decoded entries at
   5,000, discovery metadata at 64 KiB, and stderr at 16 KiB. A truncated diff/list is
   labelled; timeout, metadata overflow and Git errors are explicit failures. Buffers are
   bounded independently of repository size. A disposed view can leave an already-started
   query until its deadline, but holds no live renderer or recurring work.
9. Reuse viewer font variables and zoom. Extend the font selector test and Rust/TS fixture
   mirrors. The phone's existing static tab list labels the kind `changes`; it has no Git
   endpoint or diff view. Sidebar `gitBranch`/`gitDirty` and selected-line sending remain
   outside this feature.

## Amendment: colored, responsive comparison (2026-09-13)

The user requested readable addition/deletion colors and a Before/After view, provided it
remained lightweight. Interpret the already-bounded unified patch in the frontend; do not
fetch full files, run another Git command, introduce an editor/highlighter dependency, or
recompute a text diff.

- Complete ordinary hunks show **changed sections**, not full file contents. Context appears
  on both sides; consecutive deletions/additions are paired in order, with blank alignment
  space on the shorter side. File and hunk metadata remain visible. No word-level matching
  or LCS is performed. Baseline labels follow Working (Index → working tree), Staged (HEAD
  → Index), All (HEAD → working tree), and the empty baseline for untracked/unborn files.
- The Changes root is a named inline-size CSS container. At **960 CSS px** and above,
  Before/After are side by side; below it the complete Before section precedes After.
  This follows the pane rather than the window. Resizing performs no parsing, IPC, or DOM
  reconstruction. A shared vertical viewport keeps the wide comparison aligned; each
  side can scroll long lines horizontally without widening the pane.
- Additions are green and deletions red, with contrasting backgrounds. Labels and +/-
  prefixes carry the same information without relying on color. File-header `---`/`+++`
  lines are metadata, not changed code. All content still uses `textContent`.
- Combined merge diffs, non-textual changes, and incomplete/unrecognized patches retain a
  unified representation rather than inventing an incorrect pair of versions. Notices
  identify fallback reasons where applicable; binary and rename-only metadata stay visible.
- Independently of the 512 KiB capture limit, display at most **5,000 input lines**, with a
  visible limit notice. Consecutive same-tone lines share a span. A clipped patch stays
  unified. This bounds parsing and DOM work even for hundreds of thousands of tiny lines.
  There is no timer, observer, persisted preference, or retained inactive renderer.

The parser, DOM renderer, ChangesView integration, and font-selector tests cover the new
surface. Real WebView2/WSL verification remains separate from automated DOM tests.

Local production builds measured about a 7.5 kB JavaScript increase (2.3 kB gzip) and a
0.8 kB CSS increase (0.2 kB gzip) over `d01d0c8`, with no dependency change. A Node-only
parser probe, after ten warm-ups and thirty measured iterations, took a median 1.44 ms
for 4,999 ordinary patch lines and 2.29 ms for a 512 KiB short-line input clipped to the
display limit. These are parsing measurements, not browser rendering or WebView2 latency.
Chromium layout verification was blocked locally by missing system libraries; the pane
breakpoint, overflow, and zoom checks in WINDOWS-BUILD section 14 remain pending.

## Verification and limits

Tests exercise real temporary Git repositories, mixed staged/working changes, unborn
branches, conflicts, renames, unusual names, untracked symlinks, binaries, oversized
diffs/lists, index locks, disabled external helpers, and bare containers. Capture tests
exercise subprocess output bounds and deadlines; frontend tests exercise selection and
refresh races, disposal, errors, font selectors, and shared DTO fixtures. Repository gates
include core/remote tests, x64/ARM64 Windows clippy, Windows check, and both frontend builds
and suites. Windows + WSL manual checks are recorded separately in WINDOWS-BUILD section 14.

Git data is a live view rather than an atomic transaction: another pane can change HEAD,
the index, files, or a worktree between listing and selection. Refresh obtains a new list;
there is no repository snapshot or content cache. WSL requires Git, `/usr/bin/env`, and
GNU `/usr/bin/timeout`; missing executables fail visibly. Linux tests and Windows target
compilation do not establish WebView2 behavior or WSL relay cleanup on a real Windows host.

The compatibility release must precede the Changes release (ADR-0021). The new kind does
not make older, unprotected builds safe to downgrade to.

## References

- [Git status porcelain v2](https://git-scm.com/docs/git-status#_porcelain_format_version_2)
- [Git diff baselines and no-index](https://git-scm.com/docs/git-diff)
- [Git worktree porcelain format](https://git-scm.com/docs/git-worktree#_porcelain_format)
