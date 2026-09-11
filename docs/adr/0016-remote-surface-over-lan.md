# ADR-0016 — A poll-based remote surface over the LAN

Status: accepted (2026-09-05) · Verification: WINDOWS-BUILD §10 v0.3.17

## Context

The request was to see the workspaces, panes and tabs of a running mast from a phone on the
same router, read a terminal tab's current screen, and send text to it — "PC on, lying in bed,
answer the agent". Three constraints shaped the answer. mast must stay light, so whatever
serves the phone has to cost nothing while it is off. No streaming is needed: a poll every two
seconds is the whole interaction. And the PTY sessions live inside the mast process, so any
remote surface must be a door that mast itself opens — there is no adapter process that could
reach a session from outside.

Two facts about the existing code decided the shape. The Tauri glue (`apps/mast/src-tauri`)
cannot compile on the Linux dev host, so code placed there cannot be tested by `cargo test`;
authentication and request parsing are exactly the code that must be. And ADR-0002 made the
command bus and the state snapshot serializable, so the phone can be handed the very JSON the
desktop already receives.

## Decisions

1. **The HTTP server lives inside the mast process, on the Windows side, off by default.**
   `settings.json` gains `"remote": { "port": <1024-65535> }`; the key's presence turns the
   surface on, `port` is required and range-checked with the same loud failure as `fontSize`,
   and the file is read once at boot (ADR-0014's rule). While off nothing exists — no listener,
   no thread, no token file. Windows-side because a Windows process is reachable at the router
   IP without WSL2's NAT.

2. **A new crate, `crates/mast-remote`, owns everything network-facing** and knows nothing
   about Tauri. It receives `Arc<Mutex<Dispatcher>>` and `Arc<SessionManager>` from the glue
   plus two closures — one that resolves a static asset key, one that logs a line — and is
   tested on Linux against a real listener on `127.0.0.1:0`. The glue keeps only settings,
   the token file, boot wiring, the asset callback and two commands.

3. **Synchronous HTTP on `std::net::TcpListener` with `httparse`; no async runtime and no
   server crate.** The brief's candidate, `tiny_http` 0.12, was read and rejected: its request
   line and headers have no size cap (`client.rs:79-101` accumulates into an unbounded `Vec`),
   and dropping a request with an unread body allocates the declared `Content-Length` and reads
   it to the end (`util/equal_reader.rs:66-86`), which makes "reject before reading the body"
   impossible. Owning the ~250-line connection loop means the caps (8 KiB head, 32 headers,
   64 KiB body), the timeouts and the thread model are constants in our code. `httparse`,
   `getrandom` and `base64` were already in `Cargo.lock`, so no third-party package was added.

4. **The order inside a connection is the security contract.** A blocked IP is answered 429
   before its head is read; the head is capped; the route is decided (anything else, including
   `OPTIONS`, is 404); the limiter is checked again; only then is `Authorization: Bearer` compared
   in constant time. Ten failures in sixty seconds block the IP for sixty seconds for every
   request, static assets included, and the eleventh failure is itself the 429. No response
   carries a CORS or `Server` header, every response says `Connection: close`, and a token in
   the query string or a cookie is ignored. Requiring the header is also the CSRF defence: a
   page on another origin cannot add it without a preflight, and the preflight gets 404.

5. **Reading a screen is offset-based and read-only.** `PtySession::screen_since(since)` returns
   a raw delta from a stream offset, or — when the offset is absent, older than the retained
   replay window, or ahead of the stream — a reset payload built like `reattach()` (the DEC
   mode preamble of ADR-0015 plus the snapshot). Unlike `reattach()` it never resets flow
   control, never touches the sink and never wakes the reader: the phone watches the same
   session the desktop is attached to, and one poll must not erase the desktop's backpressure
   accounting. The session remembers its PTY size (an atomic written under the master guard)
   so the phone can build a terminal of the same size; the phone never resizes.

6. **Every screen and input carries a session token `<epoch>:<id>`.** `SessionId` restarts at 1
   in every process and a respawned tab (ADR-0010) is a new session whose stream restarts at
   0, so an offset alone can silently continue into the wrong session. The epoch is drawn at
   `serve()`; a delta request whose token does not match is served a reset, and an input whose
   token does not match is refused with 409 rather than typed into a shell the phone was not
   looking at.

7. **Input is raw bytes, and the phone's terminal never emits any.** The server writes the body
   to the PTY verbatim — no CR appended, no interpretation — and refuses chunked transfer,
   conflicting lengths, `Expect`, and any body that did not arrive whole. The phone does not
   run a DOM terminal at all: a headless xterm (`@xterm/headless`) at the PTY's size is the
   screen *model*, and its buffer is rendered as wrapped text, so the page scrolls vertically
   only and the font size is a CSS knob (v0.3.18 — the first field round found the desktop-width
   xterm unreadable and its input bar hidden under the phone keyboard). A headless instance has
   no input path, so the replayed terminal queries (`ESC[6n`) that the desktop guards with its
   `replayDone` gate cannot be answered into a PTY the desktop already answers for. The phone
   encodes input itself from `term.modes` — bracketed paste when the mode is on — sends actions
   one at a time, and sends Enter as a **separate** request at least 150 ms after a paste, for
   the reason recorded with the v0.3.16 `mast send` fix: both agent TUIs treat one burst as a
   paste and swallow a CR inside it. The page sizes itself to the visual viewport, since phone
   browsers shrink only the visible window when the keyboard opens.

   *Amendment (v0.3.20).* The text rendering has no history to show for the programs the surface
   exists for: Claude Code 2.1.x and Codex 0.153.x both run on the **alternate screen** by
   default and take the mouse (`?1049h`, `?1000/1002/1003/1006h`, read off a live tab), and an
   alternate buffer has no scrollback — the desktop shows earlier content only because the wheel
   reaches the TUI and it scrolls its own transcript. So the one exception to "the phone's
   terminal never emits any input" is deliberate and narrow: ▲/▼ buttons, shown only while the
   active buffer is the alternate one or mouse tracking is on, send five SGR wheel notches aimed
   at the screen centre, or PageUp/PageDown when the program has mouse tracking without SGR or
   no mouse at all — the phone tracks `?1006` with a CSI hook on the headless parser and never
   sends the X10 encoding. The mouse modes survive replay eviction because the snapshot preamble
   re-asserts them; 1049 does not (ADR-0015), which is why the mouse condition is part of the
   rule. Every input burst also triggers an immediate poll when the queue drains, since a
   2 s wait after a scroll tap reads as a dead button.

   *Amendment (v0.3.22).* "Rendered as wrapped text" was breaking every long line twice: the
   headless terminal has the PTY's width, so it soft-wraps a long line into several buffer
   rows, and the CSS then wrapped each row again at the phone's width. The rows a terminal
   wrapped are marked (`isWrapped`), so the phone now joins them back into one logical line
   before the CSS sees it, trimming the right only where the logical line ends. Rows a TUI drew
   with cursor moves are never marked and pass through unchanged, which is also the limit: a
   full-width TUI layout still fragments at the phone's width, and re-interpreting the byte
   stream at the phone's width cannot fix that because the stream carries absolute cursor
   positions for the desktop's width. The only correct narrow layout comes from the TUI itself,
   i.e. a PTY that follows the most recently active viewer (tmux's `window-size latest`) —
   that reverses decision 5's "the phone never resizes" and is recorded as a backlog item
   rather than decided here.

8. **Static assets are gated by the embedded key set.** Tauri's release asset lookup falls back
   to `index.html` for any unknown path (`manager/mod.rs:406-428` in 2.11.5), so without a gate
   `/remote/typo` would serve the desktop page to an unauthenticated client. The glue collects
   the embedded keys at boot (they carry a leading `/` that the lookup strips), serves only
   `/` → `remote/index.html` and `/remote/<safe segments>`, and refuses to start when the
   bundle has no `remote/index.html` at all. Path segments must match
   `^[A-Za-z0-9][A-Za-z0-9._-]*$` and are never percent-decoded — not decoding is the whole
   traversal defence. The phone page is a second Vite build (`dist/remote/`) so no desktop
   chunk lands under `/remote/`. Every response carries `Cache-Control: no-store` and
   `X-Content-Type-Options: nosniff`, and the HTML carries a `Content-Security-Policy` of
   `default-src 'self'` (inline styles allowed, since xterm attaches its own), so the page's
   `textContent`-only rule is enforced by the browser as well as by review.

9. **The pairing token is a 32-byte secret shown once as a QR.** It lives in `remote-token`
   next to `state.json`, is created atomically, validated on read (43 base64url characters that
   decode to 32 bytes) and never silently regenerated — a corrupt file fails loudly, and deleting
   it is the regeneration procedure. It reaches the phone only through the pairing dialog's URL
   fragment, which the page stores and strips from the address bar; `remote_status` reports
   on/off/failed without it so the token never crosses to the renderer at boot. On unix the
   file is created owner-readable only. A 401 makes the page forget its stored token, so the
   next visit starts from the pairing hint instead of repeating the failure.

## Consequences and accepted limits

- **Plain HTTP.** Anyone with the Wi-Fi password can read the token and the typed text, and
  `localStorage` is bound to `http://<ip>:<port>`, so a device that later receives that IP can
  impersonate the origin. TLS was excluded: a self-signed certificate has to be installed on
  the phone, and Tailscale — the upgrade path that adds encryption, device identity and valid
  HTTPS without touching mast — costs a separate process. The pairing dialog says so.
- **The connection cap does not stop a slowloris.** Thirty-two slots, a ten-second timeout per
  read and a fifteen-second deadline per request bound each connection; a LAN host can still
  cycle through the slots and deny the phone. It cannot reach the desktop.
- **A remote write shares the tab's `writer` mutex with the desktop.** If the child stops
  reading stdin, the desktop's typing into that tab waits behind the remote write, and closing
  the tab then waits on `PtySession::kill` under the Dispatcher lock — the same path a desktop
  paste already has (the "input stops reaching a shell" backlog item). What the remote adds is
  a trigger that sits across the network, and a second cost: thirty-two remote writes stuck this
  way also exhaust the connection pool. WINDOWS-BUILD §10 v0.3.17 measures it, and letting
  `kill()` drop the master before waiting on the writer is the recorded follow-up.
- **The first frame may be incomplete** until the TUI redraws: the desktop nudges a redraw with
  a rows-1/rows resize after attach, and the remote must not touch the desktop's PTY size. The
  same nudge can show the phone a rows-1 screen for one poll, after which it rebuilds.
- **A reset copies up to 1 MiB under the session lock**, the same cost as `reattach()`. The
  reader takes that lock only to commit a chunk, so nothing deadlocks; an authenticated client
  hammering `since`-less requests can make the reader wait, and the limiter counts only
  authentication failures.
- **Scrollback leaves the app.** `mast ls` deliberately returns metadata only (ADR-0005
  addendum); this surface returns a tab's replay bytes. The difference is that it is a named
  opt-in for the user's own device, locked by the token — the ADR-0005 rule that another radius
  arrives only as an explicit opt-in is exactly what `"remote"` is.

## Rejected

- **A separate adapter process.** With polling there is nothing for it to do but proxy, and
  the sessions are in-process anyway.
- **WebSocket / streaming, push notifications, MCP.** More moving parts than the bed use case
  needs; push in particular cannot work over plain HTTP on a LAN.
- **Per-IP connection caps, authenticated-client rate limits, token rotation from the UI,
  IPv6, a native app, resizing or workspace control from the phone.** Recorded as follow-ups.

## Amendment (v0.3.23) — the pairing dialog checks, and can write, the firewall rule

The surface above reads screens and writes input; nothing in it touched the PC's own
security settings. This amendment adds one such capability, deliberately narrow: **on the
user's click, the app writes one Windows Firewall allow rule for itself.**

The incident behind it: the rename to `mast` changed the exe's file name, and Windows Firewall
binds an allow rule to the exe **path**. The old rule kept allowing an exe that no longer ran,
the new exe had no rule, and on a PC whose firewall profiles have `NotifyOnListen` off — this
one — Windows never asked. The server logged `remote: listening on 0.0.0.0:7331`, the phone
timed out, and nothing in between said why.

1. **Detection is unprivileged COM, not a shell-out.** `firewall.rs` enumerates
   `INetFwPolicy2.Rules` in-process and judges whether an enabled inbound Allow rule reaches
   *this* exe on *this* port for the *current* profile from *this* LAN — a rule that names no
   program counts, a `Protocol=Any` rule is exempt from the port check because that is exactly
   the rule Windows's own "allow this app" prompt writes, and a rule whose remote scope
   excludes the local subnet does not count, since reading it as `allowed` would hide the
   button while the phone still cannot connect. Reading rules needs no elevation; parsing
   `netsh` or PowerShell output would be slow and would read a localized (Korean) Windows
   differently from an English one. The verdict is one of `allowed`, `blocked`, `stalePath`
   (our own rule points at another copy of the exe), `profileMismatch`, `missing`,
   `firewallOff`, or `unknown` when COM itself fails — and `unknown` keeps the button, because
   the judgment failing is not a reason to stop the user fixing the rule.
2. **Block beats Allow, as it does in Windows**, so a program-bound Block rule for this exe is
   reported as `blocked` with the rule's name and no button: adding an allow rule would change
   nothing, and the app does not delete rules it did not write. The match is narrow on purpose —
   only rules that name this exe and whose remote scope is `*` or includes `LocalSubnet` — so
   an internet-scoped Block or a policy-wide "block everything" rule does not turn a working PC
   into a false `blocked`, which, with the button hidden, would be worse than a false
   `allowed`.
3. **Writing goes through an elevated, Microsoft-signed `netsh.exe`, once.** The app never
   elevates itself: an unsigned exe's UAC prompt carries the yellow "unknown publisher" warning
   and self-elevation would need a command-line mode in `main`. Instead `ShellExecuteExW` with
   the `runas` verb runs `netsh.exe -f <script>` from the system directory reported by
   `GetSystemDirectoryW` (not `%SystemRoot%`, which any same-user process can change) — the standard UAC
   prompt, one click — and the script is built from `current_exe()` and the `u16` port and
   nothing else; a path containing `"` is refused, `cmd.exe` is never involved, and the script
   file in `%TEMP%` is removed on every exit path. When a rule of our name already exists it is
   deleted first so the name does not double — except when detection itself failed, where the
   script is a bare add and a duplicate is the accepted price of the button still working.
4. **Success is judged by re-detection, not by netsh's exit code.** Whether `netsh -f` stops at
   a failing line and what its exit code reflects is undocumented, so the code is logged
   (`remote: firewall apply exit=N`) and the dialog is updated from a fresh detection. A
   declined UAC prompt (`ERROR_CANCELLED`) is reported as declined, not as an error.
5. **The rule covers `domain,private` only.** No code path produces `profile=public` or `any`;
   when the current network is Public the dialog says to mark it Private instead of offering
   the button. Opening a port on a public network is the user's decision, made in Windows.
6. **One log line at boot** (`remote: firewall <state> for <exe>:<port>`) whenever the server is
   up, so the next "the phone does not load" report is answered by `mast.log`.

Accepted limits: third-party firewalls (V3, Norton…) are invisible to this API and the dialog
speaks only for Windows Defender Firewall; the Hyper-V/WSL firewall is out of scope; a
hand-made rule whose `ApplicationName` uses an environment variable (`%ProgramFiles%\…`)
reads as `missing`; rule scope is modelled as one check — the remote addresses are `*`, empty
or include `LocalSubnet` — on both Allow and Block, so interfaces, services and per-interface
profiles are not seen and a rule bound to another active profile's interface can still count;
the script file in `%TEMP%` is the one input the elevated `netsh` reads and a same-user process
could in principle replace it between write and read, accepted because UAC is not a security
boundary and the window is milliseconds; detection is a snapshot at dialog-open and boot, not a watch; the
`#[cfg(not(windows))]` stubs are compiled by no gate; and the module's unit tests run only on
the Windows CI job, since the glue does not build on the Linux dev host. Verification is
WINDOWS-BUILD §10 v0.3.23, all of it field-only.
