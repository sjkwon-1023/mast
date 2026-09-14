# ADR-0014 — An opt-in runtime log

Status: accepted (2026-08-22) · Verification: WINDOWS-BUILD §10 v0.3.12

## Context

Everything mast says at runtime went to `eprintln!`, and the release build is
`windows_subsystem = "windows"` — there is no console for it to land in. Two field incidents
were reconstructed from evidence outside the app: `dmesg`, a process tree that happened to still
be alive, `state.json` after the fact. Both took hours, and in one of them two hypotheses were
chased and discarded before the process tree settled it.

The 2026-08-22 Korean IME report made the gap sharper. Typing produced a previously typed
syllable, repeating; every keyboard shortcut was dead; clicking another pane and coming back
cleared it. Reading the code established exactly one thing — `shared/keys.ts` drops every shortcut while
`ev.isComposing` is true, so a dead Alt+Arrow *is* the browser reporting an unfinished
composition — and could not establish the next thing: whether `compositionend` never arrived, or
arrived without clearing. That distinction lives entirely inside the WebView, where a backend log
would not have reached even if one had existed.

So the log has to cover both halves of the app, and it has to be something a user can turn on
when a rare bug is worth catching rather than something that runs for everyone all the time.

## Decisions

1. **Off by default, on from `settings.json`, read once at boot.** `"log": true` in the file the
   user already edits by hand. A restart is required; a runtime toggle would mean managing the
   file handle's lifetime for a workflow ("it happened again — turn it on and try to reproduce")
   that restarts anyway.

2. **Nothing exists while it is off.** No file is opened, no writer thread starts, and the front
   end does not install its composition listeners at all. `wintrace!` checks an `AtomicBool`
   before formatting its arguments, so a disabled trace does not even allocate a string. Cost
   when off is a predictable branch on paths that already spawn processes or cross IPC.

3. **Two macros, split by what the line is for.** `winlog!` writes to stderr *and* the file — it
   replaces the existing `eprintln!("[mast] …")` sites verbatim, so dev behaviour is unchanged
   and everything the app already says now has somewhere to land. `wintrace!` writes to the file
   only, and is where the per-event traces removed from the console earlier the same day came
   back. What was noise in a console is exactly the content of a diagnostic log.

4. **The front end writes through a command.** `log_line` takes a string, drops it when logging is
   off, and truncates over 2 KiB (marking that it did). Without this the IME class of bug stays
   invisible, which is the case that prompted the feature.

5. **Terminal output and typed text are never written.** Composition events record the *length* of
   the data, never the data; a swallowed shortcut records named keys (`ArrowLeft`, `Tab`) as
   themselves and any single printable character as `(char)`. Knowing a composition ended does not
   require knowing what it said. Without this rule the file becomes a transcript of everything the
   user typed and everything their agents read.

6. **The writer is a thread behind a bounded queue.** Callers hand off and return; the queue is
   1024 lines and a full queue drops rather than blocks, because logging slowing the terminal is
   the worst thing this feature could do. Dropped lines are counted and reported in the file — a
   gap that reads as "nothing happened" would be worse than a gap that says so.

7. **Two files, 4 MiB each.** The current file rotates into `.1`. Leaving logging on cannot fill a
   disk, and the failure to rotate is recorded rather than fatal.

8. **Local time, no new dependency.** `GetLocalTime` from `windows-sys`, already a direct
   dependency. The first use of this file is a user saying "it happened around 3pm", so UTC would
   add a conversion step at exactly the wrong moment.

## Consequences

- A reproduction of the IME bug now answers the question the code could not: the log shows whether
  `compositionend` arrived, and how long shortcuts kept being swallowed after it.
- The app's existing diagnostic output stops being write-only in release builds.
- Every new `eprintln!` in the glue is now a mistake — `winlog!` is the entry point, and a bare
  `eprintln!` silently keeps its line out of the file.
- The user must remember to turn it off. The rotation cap means forgetting costs 8 MiB, not a disk.

## Rejected

- **On by default.** Most users never hit these bugs, and a log that is always on is a privacy
  surface that has to be justified to every user instead of chosen by one.
- **Routing terminal output into it.** It is the single most useful thing for reproducing a
  terminal bug and the single worst thing to write to disk without asking.
- **A logging crate (`tracing`, `log` + a backend).** Levels, filters and subscribers for a
  feature whose entire contract is "write these lines to a file when a flag is on"; the dependency
  and its configuration surface would exceed the module it replaces.
- **A runtime toggle.** See decision 1.
