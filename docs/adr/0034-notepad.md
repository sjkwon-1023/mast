# ADR-0034: A built-in notepad drawer

- Status: accepted
- Date: 2026-10-20
- Verification: automated Linux gates and the Windows native notes tests described under
  Verification. Windows and macOS field checks in `docs/WINDOWS-BUILD.md` §10 remain pending.

## Context

Agent work regularly needs a scratch buffer that is not part of a repository: a prompt to paste,
a command to remember, a few lines copied out of a terminal. Switching to a separate notes app
adds a window, a sync story and a second place to look. A workspace-scoped note is also useful
when several workspaces belong to different projects.

The existing product principles bound the answer: durable state belongs in Rust, views are
disposable, structures are bounded, and an unused feature should cost almost nothing (ADR-0030).
The Markdown editor already has a size limit, atomic save, and a sessionStorage draft, so the
notepad reuses those ideas without reusing its tab UI or discard flow.

## Decisions

### 1. A non-modal drawer over the pane

The notepad is a right-side drawer layered over the current pane. It is **not** a tab and not a
split: opening or closing it does not change the pane tree, the terminal grid, terminal
`cols`/`rows`, or the number of PTY resize requests. The drawer uses a non-modal `<dialog>` with
`open`, not `showModal`, so the pane behind it and the sidebar remain usable and no backdrop
blocks input. Its width is `min(420px, viewport - 16px)` and its height is capped by
`calc(100vh - 16px)`. These are the first-open defaults; ADR-0036 defines moving, resizing and
remembering the drawer.

The DOM is built on the first toggle and removed when the drawer closes. The view module is loaded
with a dynamic import at the first toggle; the state module is loaded only when the drawer opens
or when boot finds an unfinished draft. An app that never uses the notepad loads no notepad DOM,
starts no timer and reads no note file.

### 2. Shortcuts and focus

- Windows: `Ctrl+Shift+M` and `Alt+Shift+M`.
- macOS: `Cmd+Shift+M`, which avoids the system `Cmd+M` minimize binding.
- The same keydown is also the only close shortcut besides Esc and the close button. A repeated
  keydown is consumed but does not toggle again, so holding the key cannot flap the drawer.
- An IME composition is never interrupted: the shortcut and Esc do nothing while
  `isComposing` is set.
- Opening remembers the DOM focus and moves it to the textarea unless the user moved focus during
  the asynchronous read. Closing restores the previous focus when it is still valid, otherwise
  the active pane. The textarea carries `data-keep-focus` so a state snapshot update does not
  steal its focus.

The native browser keymaps mirror the TypeScript keymap, so the shortcut works while a browser
page, a Markdown textarea or a sidebar field has focus. The drawer is non-modal, so there is no
focus trap.

### 3. Scopes and identity

The drawer head switches between **This workspace** and **Global**. There is one note per
workspace plus one global note. Opening the drawer normally selects the current workspace; with
no workspaces it opens Global. An unfinished sessionStorage draft is opened at its own scope so
the user can see the draft and the error rather than being blocked by a scope mismatch.

A workspace note is keyed by the stable `WorkspaceId`. IDs are allocated by the state's
`next_id` counter and are not reused when a workspace closes, so a new workspace in the same
folder does not inherit the old workspace's note. A note follows the ID, not the workspace name,
sidebar position or folder path.

### 4. Storage and IPC boundary

Files live in the app data directory, next to `state.json`:

- `notes/global.txt`
- `notes/workspace-<decimal WorkspaceId>.txt`

The directory is created on the first write. Three commands are registered for the desktop main
webview only: `notes_read`, `notes_save` and `notes_workspace_has_content`. They accept a
`NoteScope`, not a path, distribution name or folder. The application capability is scoped to the
`main` webview and non-main webviews are rejected, so a browser page cannot reach them.

Note bodies and existence flags are not added to `AppState`, the state snapshot, `state.json`, the
phone remote or the secure remote. Saving a note does not change the structural revision.
Workspace deletion is not a public delete command: it happens inside the desktop
`CloseWorkspace` path only, and Global can never be a deletion target.

Reads accept strict UTF-8. A missing file is an empty note; an unreadable file, a symlink, a
non-regular file, invalid UTF-8 or a file above the size limit is an error, not an empty note.
The notes root and target files reject symlinks as well.

### 5. Save protocol

- **Limit:** 2 MiB of UTF-8 bytes for both the expected base and the new text. The frontend
  measures the encoded bytes; the backend checks again. A paste above the limit is rejected
  visibly rather than silently truncated, and there is no character-count `maxlength` substitute.
- **Atomic replace with compare-and-swap:** a save is accepted only when the file's current text
  equals the caller's `expected` text. The new text is written to a temporary file in the same
  directory, flushed with `sync_all`, the expected text is checked once more, and the temporary
  file is persisted over the target. A stale expected value returns a conflict with the current
  disk text and does not replace the file for that request. Content equality cannot detect a
  text that returns to an earlier value, so the ABA window below is accepted.
- **Bounded queue:** typing is debounced for 500 ms. At most one save request is in flight and at
  most one newer text waits behind it; intermediate keystrokes are coalesced rather than queued.
- **Draft backup:** every accepted input is first written synchronously to one sessionStorage
  slot, `mast.notepadDraft`, holding the scope, the last confirmed disk base, the latest text and,
  when present, the in-flight content. If the backup write fails, the input is rolled back and an
  error is shown; quota exhaustion cannot silently lose text. A finished save removes the backup
  only when it matches the saved text.
- **Recovery:** at boot the app checks only whether the backup slot exists. If it does, it loads
  the state module without creating the drawer, reads the scope once, and resumes the save when
  the disk matches the known base or the known in-flight content. If the disk already holds the
  latest text the draft converges and is removed. An unknown disk text puts that scope into a
  visible conflict state and stops automatic saving for it; the draft is preserved. There is no
  file polling, merge UI or endless conflict retry.

### 6. Workspace close and switch

A workspace close first asks the user when the workspace has running sessions, when its note file
is non-empty (whitespace counts), or both. The existing close confirmation gains one sentence:
`Its note will be deleted.` Only the reasons that apply are included.

The backend then holds the notes work lock and, while still holding it, briefly checks the
Dispatcher, deletes the workspace note and dispatches `CloseWorkspace`. The lock order is always
**notes → Dispatcher**, never the reverse, and file I/O happens without the Dispatcher lock. If
the note cannot be deleted, the close fails with a `noteStorage` command error, the workspace,
sessions and revision stay unchanged, and no state-changed event is published. If a save was
already waiting behind the lock it either lands before the delete or is rejected afterwards as
`unknown workspace`, so a late save cannot resurrect the deleted note. Global notes are kept.
When a snapshot no longer contains a workspace, any draft for that scope is discarded without a
save. Closing a workspace and disposing the session both invalidate every read still in progress,
so a late read result cannot reopen a discarded scope.

A workspace switch does not wait for the notepad. If the drawer is showing a workspace scope and
the active workspace changes, the drawer flushes the old scope and then reads the new workspace
note in the same drawer. If the flush fails, the drawer stays on the old explicit scope, keeps the
draft, shows the error, and displays that workspace's name in the header so it is clear the note
does not belong to the current workspace. Global is unaffected by workspace switches. A snapshot
that removes the open workspace discards that draft and closes the drawer. After the first open or
an explicit scope switch settles, the drawer compares the latest active workspace once more and
follows it when the shown scope is a workspace that is out of date; a snapshot skipped during the
switch is not dropped.

### 7. Quit and reload

Normal window close and quit first flush the note, regardless of whether Markdown drafts exist.
Note input is frozen before that flush starts: `acceptText` rejects and the textarea is disabled.
The freeze stays while the close proceeds and is lifted only when the close is cancelled (a failed
flush kept by the user, a failed confirmation dialog, or a declined Markdown confirmation).
Manual reload freezes input the same way before its flush. While the flush and any confirmation
are pending, another close request is prevented from re-entering. When the note is the only dirty source and the flush succeeds, there is no
note-specific confirmation; the app proceeds to the existing Markdown check, which also passes
when no Markdown draft exists. If the flush fails, one confirmation offers to quit anyway while
keeping the draft on cancel. This covers drafts that cannot be resolved automatically, such as a
deleted workspace or an unknown disk text.

Manual reload (`Ctrl/Cmd+Shift+R` and `window.__mast.reload()`) attempts the same flush but
reloads even when it fails; the sessionStorage draft survives the reload and boot recovery tries
again. Automatic WebView reloads do not wait for an asynchronous flush; they rely on the
synchronous backup and boot recovery.

On macOS the draft state reported to the native terminate guard is
`Markdown dirty || notepad active`, where "notepad active" means the drawer is open or an unsaved
backup or in-flight save exists. The drawer enables editing only after that dirty report has been
delivered, on every path that opens editing: the first open, a scope-button retry after a read
failure, and workspace following. A failed delivery keeps editing closed and shows an error. The existing Clean fast path in
`application_should_terminate` is retained: with no Markdown draft and no active note, Dock Quit
and logout still terminate immediately without a JS round trip.

### 8. Cost

- The view module and its DOM are created on the first toggle, not at boot.
- The state module is not read at boot unless the sessionStorage backup exists.
- The drawer DOM and clean text are dropped when the drawer closes.
- There is no polling loop, background worker, editor library or per-workspace cache.
- Closing the app uses the existing window, not a new service.

## Alternatives rejected

- **A note as a tab or split.** It would change the pane tree and trigger PTY resize cost, and
  the note would compete with the terminal layout the user arranged.
- **Folder-based note files.** The workspace working directory can be changed, shared or absent,
  and writing notes into a repository pollutes Git status.
- **A volatile note without disk storage.** It would not meet the requirement that the latest
  accepted input survives workspace switching, quit and reload.
- **A native close-ready handshake.** Rejected during implementation because it added a second
  lifecycle state machine for a narrow reload window; the accepted limits are documented below.
- **A note-specific discard confirmation on the success path.** The note flushes before closing
  or quitting, so a confirmation there would only add friction. A confirmation is used solely
  when the flush cannot complete.
- **A general atomic-file abstraction or a notes service.** The two note consumers use the same
  small store; a framework would add surface without a second real consumer.

## Accepted limits

- On Windows, a close that arrives during a reload before the JS close guard is installed can
  lose the sessionStorage note draft. This is the same window already accepted for Markdown
  drafts. Text already saved to disk is unaffected.
- If the disk file contains text the frontend does not recognize, there is no merge UI. The draft
  is preserved and automatic saving for that scope stops; the user can still quit through the
  "Quit anyway" confirmation.
- Saving compares content (CAS). The text can go A to B and back to A while a save of B is still
  in flight, and a WebView auto-reload can interleave with that save.
- If the recovery read sees A and finishes, and that stale B request then acquires the notes lock,
  the disk can end up as B.
- This requires an IPC call that was already sent to run later than the reload, the boot and the
  recovery read together.
- A revision-number CAS would close the window, but the cost was not considered worth it.
- Force kill, a power cut and disk failure are not covered by the atomic replace. The store
  guarantees the previous or the new complete file at the filesystem level, not durability
  through hardware failure.
- The notes files are user data under the app data directory. Deleting `state.json` or restoring
  an old state can leave orphaned note files; this ADR does not add an automatic sweep.

## Verification

Automated coverage:

- `crates/mast-core/src/notes.rs` tests: creation, overwrite, scope separation, non-ASCII text,
  empty values, root creation on first save, stale expected conflicts, concurrent saves from the
  same base, the 2 MiB boundary and limit-plus-one, invalid UTF-8, directory and symlink targets,
  idempotent deletion, global preservation, `has_content` semantics and serialization shape.
- `apps/mast/src/features/notepad/state.test.ts`: debounce coalescing, input during a save,
  out-of-order completion, failure retention, byte limit, backup quota rejection, reload recovery
  from base/in-flight/latest disk states, unknown conflicts, read invalidation on discard and
  disposal, closed-read marking and clean disposal.
- `apps/mast/src/features/notepad/view.test.ts`: drawer lifetime, keys, IME and repeat handling,
  scope switching, workspace following and re-alignment, stale reads, the dirty-report barrier on
  every editing path, focus, including a cancelled open, and close behavior.
- `apps/mast/src/app/lifecycle.test.ts` and the workspace/sidebar tests: quit and reload flushing,
  input freezing before flush and thawing on a cancelled close, failure confirmation,
  CloseWorkspace note deletion and the close confirmation text.
- The Linux gates and the Windows native `cargo test -p mast-core --target
  x86_64-pc-windows-msvc notes::` step in `windows-gates` run the native notes tests on their
  platforms.
- The built desktop entry is checked for the absence of a static notepad import, and the remote
  and secure-remote bundles are checked for note IPC names.

Field verification of the Windows and macOS checklists is **pending**. Nothing in
`docs/WINDOWS-BUILD.md` §10 or `docs/MACOS.md` is recorded as passed by this ADR.
