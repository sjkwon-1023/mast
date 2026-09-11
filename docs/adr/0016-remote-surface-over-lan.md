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
