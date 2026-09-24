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
- There is no arbitrary JavaScript evaluation command, no external CDP endpoint and no MCP
  server.

### 4. Agents drive the same tab through `mast browser` over the existing OSC query path

- `mast browser` (`scripts/wsl/mast-browser.py`, installed into WSL by provisioning — setup
  marker v19 — and as a native macOS asset) sends `OSC 777;mast-query;browser:<json>` and reads
  a private reply file, the same transport as `mast ls`. No port is opened.
- Requests address stable tab IDs and are limited to the caller's workspace. Commands: `open`,
  `list`, `navigate`, `back`, `forward`, `reload`, `stop`, `close`, `snapshot`, `click`, `fill`,
  `press`, `scroll`, `wait`, `screenshot`, `console`, `errors`. Errors are JSON with
  `disabled` / `not_found` / `timeout` / `stale_ref` / `not_supported` / `invalid_params` codes.
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

## Alternatives rejected

- **A separate headless browser or screen streaming** (as in herdr-browser) — an always-on process
  and a second view of the page the user is not looking at.
- **An `<iframe>` in the main UI** — shares the UI's origin and IPC, and most sites refuse framing.
- **Treating `wsl.exe` presence as readiness** — the failure that motivated decision 1.
- **Arbitrary `eval`, network interception, an external CDP port or an MCP server** — out of scope
  and a larger attack surface than the tasks need.

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
