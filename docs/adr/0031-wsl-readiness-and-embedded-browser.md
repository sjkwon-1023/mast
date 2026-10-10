# ADR-0031: WSL readiness guidance and an embedded browser tab

- Status: accepted
- Date: 2026-09-25
- Verification: automated gates on Windows (CI `windows-gates`), Linux (CI `gates`) and Apple
  Silicon; field checklists run by the user on Windows and macOS on 2026-09-25 (see
  Verification). Per-process CPU/memory figures were not recorded in the repository.

## Context

Two gaps came from the same user workflow — running coding agents that build web apps.

1. **A PC without a working WSL got no guidance.** The Windows host treated the presence of
   `wsl.exe` as ready. The first `CreateWorkspace` panicked on failure, boot restoration and
   provisioning each ran `wsl.exe` on their own, and a PC without WSL repeated the same failure on
   every launch.
2. **Agents could not see the page they were building.** Checking a dev server meant leaving
   Mast for an external browser, and an agent in a Mast terminal had no way to read, drive or
   screenshot the page the user was looking at.

The product principles bound the answer: idle cost near zero, bounded structures, a disposable
WebView, no always-on service whose cost scales with workspaces (CLAUDE.md "Product
principles"). The removed `◎` header button had been parked until "an unused browser tab can be
isolated well enough to cost nothing at idle".

## Decisions

### 1. One WSL diagnosis gates every WSL process

- `mast_core::wsl` owns the diagnosis and its classification: not installed, no distribution,
  the requested distribution missing, the chosen Bash failing to start, and timeout. It parses
  `wsl.exe` output as UTF-16LE and keeps the raw detail next to the class.
- `WslHealth` (glue `wsl_health.rs`) runs the diagnosis once at boot without blocking the UI,
  shares the result, and refreshes it only on an explicit **Recheck**. Every shell spawn
  (`host.rs::spawn_shell_inner`), boot restoration (`boot.rs`) and provisioning
  (`provision::ensure_provisioned`) waits for the first result and refuses with its reason
  instead of launching `wsl.exe`. A failing distribution does not block healthy ones. A normal
  tab spawn adds no `wsl.exe` round trip.
- The first-start panic is gone; saved tabs and their records are kept when WSL is not ready.
- The front end shows a banner with the install command to copy, the official guide, **Recheck**
  and "open settings file". Mast never installs WSL or reboots on the user's behalf.
- macOS has no WSL: the diagnosis reports `notApplicable`, and a macOS workspace never records a
  distribution.

### 2. The browser is a pane tab kind backed by the platform's native webview

- `TabKind::Browser { url }` / `NewTab::Browser` live in the core model, persist with the layout,
  and never create a PTY. The URL is saved; pages are not loaded on restore until shown.
- The page is a **child webview of the main window**: WebView2 on Windows, WKWebView on macOS.
  No Chromium, Node or headless browser daemon is added.
- A webview is created only when the tab is first shown or an agent acts on it. Hidden tabs are
  hidden (and on Windows asked to `TrySuspend`; macOS has no public equivalent and relies on
  WebKit's throttling of hidden views). Closing the tab closes the webview and drops its buffers.
  Hidden pages are never discarded automatically, so unsaved input is not lost.
- Cookies and storage are isolated **per workspace**: a WebView2 profile directory
  (`browser/workspace-<id>`) on Windows; a `WKWebsiteDataStore` identified by the workspace ID on
  macOS 14+, and a non-persistent store below macOS 14 (isolation kept, persistence lost).
- `browser.enabled` (default `true`, full restart to apply, `mast config set/reset
  browser.enabled`) turns the feature off at both ends: no webview, thread, timer, listener or
  automation state is created, and backend creation and automation requests fail with
  `disabled`. Saved browser tabs restore as an inert notice that keeps the URL.
- The memory-based UI reset does not fire while browser pages exist, because page memory is not
  a terminal leak; whole-process measurement continues.
- The phone remote lists browser tabs as desktop-only and never streams them; `remote` and
  `browser` are independent settings.

### 3. Pages get no Mast authority

- The main capability is scoped to the **webview** `main` (`capabilities/default.json`), not the
  window, so child page webviews inherit no IPC permission.
- Navigation accepts HTTP(S) only; URLs with embedded credentials and other schemes are refused.
  Popups become browser tabs in the same pane; downloads are refused with a message. Camera,
  microphone and location requests are denied — explicitly by WebView2, and on macOS by WebKit
  itself because the app declares no usage descriptions. Certificate errors are not ignored.
- Pages have no Mast IPC permission. The agent's explicit `mast browser eval` command runs
  JavaScript in the page's main world; it does not grant that page app commands or shell access.
- There is no external CDP endpoint or MCP server.

### 4. Agents drive the same tab through `mast browser` over the existing OSC query path

- `mast browser` (`scripts/wsl/mast-browser.py`, installed into WSL by provisioning — setup
  marker v19 — and as a native macOS asset) sends `OSC 777;mast-query;browser:<json>` and reads
  a private reply file, the same transport as `mast ls`. No port is opened.
- Requests address stable tab IDs and are limited to the caller's workspace. Commands: `open`,
  `list`, `navigate`, `back`, `forward`, `reload`, `stop`, `close`, `snapshot`, `click`, `fill`,
  `press`, `scroll`, `wait`, `screenshot`, `eval`, `console`, `errors`. Errors are returned as
  JSON: `unauthorized` means eval authorization or token rejection, `disabled` means the browser or
  eval setting is off, `not_found` means a missing tab, another workspace, or a page not ready yet,
  `too_large` means a size limit was exceeded, `script_error` means a page exception or syntax
  error, `serialization_error` means JSON serialization failed, `timeout` means a deadline or eval
  gate, `invalid_params` means invalid arguments, `stale_ref` means an outdated element reference,
  `not_supported` means the platform does not support the operation, and `browser_error` means
  another browser error. Eval object key order is not preserved, and a trailing semicolon is a
  syntax error.
- `snapshot` returns text and element refs scoped to one document generation; a new snapshot or
  navigation invalidates old refs. Bounds: 32 KiB request, 24 MiB reply, 400 elements, 40,000
  characters, 100 console and 100 error entries, `wait` ≤ 10 s, screenshots ≤ 16 megapixels
  written to a new file (never overwritten).
- `list` also reports each open page's `loading` and last `error`, so an agent sees a failed
  navigation without the UI.
- Automation reaches the page without taking keyboard focus: WebView2 through the DevTools
  protocol; WKWebView through `evaluateJavaScript`, `stopLoading`/`goBack`/`goForward`,
  `takeSnapshotWithConfiguration` and key events sent straight to the view.

### 5. The page behaves like part of its pane

- Clicking (macOS) or focusing (WebView2) a page activates its pane; keyboard focus stays in the
  page.
- While a page has focus, the Mast shortcuts that act outside the page are handed back to the UI:
  the Windows keymap (`Ctrl+Tab`, `Alt+Shift+arrows`, `Ctrl`/`Alt`+`Shift`+letter table,
  `Ctrl`/`Alt`+digit) through WebView2's accelerator event, including Alt combinations that arrive
  as system keys; the macOS keymap (`MAC_KEYS`, `Cmd+1–9`, `Cmd+⌥arrows`, `Ctrl+Tab`) through an
  AppKit local key monitor. `Ctrl+L` / `Cmd+L` focuses the address bar. Copy/paste, zoom and the
  page's own shortcuts stay in the page. Keys are matched by physical key when the input source
  is not ASCII, so Korean input does not break them. The native lists mirror `shared/keys.ts` and
  must change with it.
- Splitting a pane that shows a browser tab opens a terminal, like the keyboard split.

### 6. macOS specifics found in the field

- On macOS 26 the main webview covers the title bar and WebKit insets its page by
  `obscuredContentInsets`; child webview bounds are offset by the main webview's origin and that
  inset (read only where the selector exists), and position and size are applied in one
  `set_bounds` because AppKit's origin is the bottom-left corner.
- wry 0.55's navigation delegate does not implement the failure callbacks. Mast adds
  `webView:didFail(Provisional)Navigation:withError:` to the delegate's class — taken from the
  live object, not its versioned name — before the first browser webview exists, because WebKit
  caches the delegate's selectors when the delegate is set. It never replaces a method wry
  implements. WebKit blocks restricted ports (such as 9) without any callback, so those
  navigations report no error.
- Once a child webview exists, Tauri's `get_webview_window("main")` returns `None`; the Quit menu
  and the Dock-quit path look the window up with `get_window` instead.

## Amendment (2026-10-04): agent eval and fixed-size capture

This amendment updates Decisions 3 and 4. A page webview has no Mast IPC permission, while an
agent already has the user's shell and the existing `click`/`fill` browser actions. `eval` adds
access to the logged-in site's JavaScript context: it can read that site's `localStorage` and make
requests using its logged-in session. HttpOnly cookies remain unreadable from JavaScript. The
absence of Mast IPC, shell and file permissions on the page does not remove those site-session
capabilities.

`mast browser eval TAB EXPRESSION [--timeout-ms N]` runs one expression in the top-level page,
awaits a Promise, and returns `{"value": ...}`. The CLI obtains an app token through the existing
private reply-file path for each eval; the app requires that token on the eval request. This
prevents terminal-output injection that cannot read the reply file from creating eval requests.
It does not protect against same-user local processes, shared or externally exposed `/tmp`,
pre-planted symlinks, input injection into another shell with the existing `mast send`, or token
exposure in terminal records. The token is not a secret; it proves the caller could read the reply
file. Windows uses DevTools `Runtime.evaluate` with `userGesture: true`; macOS uses
`WKWebView.callAsyncJavaScript`. Both align eval with user-gesture APIs such as opening a popup
and writing to the clipboard.

The timeout defaults to 5,000 ms and is capped at 10,000 ms. It limits how long Mast waits for a
response; it does not cancel page code or its side effects. A timed-out eval keeps that tab's
JavaScript-based browser actions gated until its late completion callback arrives or a new document
is confirmed. While that eval is outstanding a hidden tab is not suspended, so a timer-driven
Promise can still finish; the tab is suspended again once the eval completes or the document
changes. A permanently pending Promise or synchronous infinite loop may require `reload` or
`close`; on macOS, close the tab if reload does not recover a synchronous loop. Requests are
limited to 32 KiB after JSON encoding, successful `{"value": ...}` responses to 1 MiB, and eval
error messages to 4 KiB. These response limits do not bound memory allocated by page code. The
default `browser.agentEval` setting is true and takes effect after a full restart. Turning it off
issues no eval token and rejects eval requests; no separate eval worker, timer or listener is
started. This is not a boundary against an agent with shell access, which can set it true for the
next restart. Close the tab to block it immediately.

The CLI eval deadline starts when `deliver_query` receives the request, so reply-path decoding and
Dispatcher/operation lock waits use the same budget. UI commands use their invocation time. An eval
whose deadline has expired is not run in the page. The closures scheduled on the main thread and
WebView2 check the deadline and observed document generation immediately before submission and
discard the request if either changed. A script already submitted to the page cannot be cancelled.
An unusually long wait for an internal state lock can exceed the response deadline, but an eval
whose deadline has expired is still not submitted to the page.

`eval` and fixed-size screenshots require an existing webview and do not create one. If a tab has
no page yet, the command returns `not_found` and `Browser tab has no page yet; run mast browser
wait or open it first`. After capture, Mast measures `innerWidth` and `innerHeight` against the
latest target bounds. When bounds sizes changed, the expected viewport is the captured viewport
scaled by the applied-to-captured bounds ratio in each dimension and rounded, with a two-CSS-pixel
tolerance; unchanged bounds retain the one-pixel tolerance. A mismatch or failed measurement keeps
the restore marker and returns `view was not restored`. Tauri's `show`/`hide` return values confirm
that a native operation was dispatched, not that the platform applied it; these APIs do not expose
a separate visibility check.

Fixed-size capture uses the same webview. Windows applies WebView2 CDP device-metrics emulation;
macOS moves the webview off screen without hiding it and changes its bounds. Page zoom is not used,
so the page switches to the responsive breakpoints and layout of the requested CSS viewport. While
the same webview is alive, the temporary emulation or bounds are restored after success or failure.
After the size is restored, the top-level document's scroll position is put back if the document
and webview generations the request observed are unchanged; a new document does not receive the old
position. DOM changes made in response to `resize` and other page side effects are not undone.
Later pane visibility and size intents take precedence, and a closed webview is not recreated. A
failed restore returns `view was not restored` and is retried on that tab's next browser request or
surface update.
External CDP, a server and network interception remain out of scope.

## Alternatives rejected

- **A separate headless browser or screen streaming** (as in herdr-browser) — an always-on process
  and a second view of the page the user is not looking at.
- **An `<iframe>` in the main UI** — shares the UI's origin and IPC, and most sites refuse framing.
- **Treating `wsl.exe` presence as readiness** — the failure that motivated decision 1.
- **An external CDP endpoint, network interception or an MCP server** — remain out of scope; page
  JavaScript evaluation is available only through the explicit `mast browser eval` command.

## Consequences

- An unused, enabled browser costs no webview; a disabled one costs none of its runtime parts.
- Each open page is a real WebView2/WKWebView process cost, excluded from the memory-reset trigger
  but still measured.
- Snapshot and element actions cover the top-level document only; iframes, shadow DOM and flows
  that need genuine user input are not guaranteed.
- The native shortcut lists are a second copy of `shared/keys.ts`; unit tests pin both copies.

## Verification

- CI on the merged head: `gates` (Linux: core/remote tests, Windows-target clippy, frontends) and
  `windows-gates` (Windows compile, clippy and tests) passed. Apple Silicon: `mast-core`,
  `mast-app` (except the pre-existing `update::macos` limit test that also fails on `main`),
  macOS script tests, frontend build and vitest (only the known node-26 `localStorage` failures).
- macOS field run with an isolated `HOME`: the full `mast browser` flow on a real WKWebView
  (open, wait, snapshot, fill, press Enter to submit, console, errors, scroll, screenshot, popup to
  tab, refused download, navigate, stale ref, back/forward and history end, refused `file:`,
  failed navigation to a closed port and an unknown host, close, closed-tab `not_found`); then the
  user's checks — layout inside the pane, pane activation, shortcuts with English and Korean input,
  IME and copy/paste in the page, cookie isolation between workspaces, restore and kept login after
  restart, and Cmd+Q.
- Windows field run by the user: the checklist in `docs/WINDOWS-BUILD.md` ("브라우저와 WSL 안내
  검증"), including page focus, the Windows shortcuts and splitting from a browser pane.
- The 2026-10-04 amendment's eval and fixed-size capture checks are listed in
  `docs/WINDOWS-BUILD.md`; platform field verification remains pending until recorded there.
