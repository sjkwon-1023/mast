# Frontend code map

The desktop and phone browser are separate entry points. Rust owns durable application
state; the frontend receives revisioned snapshots and renders disposable views.

| Location | Responsibility |
| --- | --- |
| `app/` | Desktop bootstrap, snapshot store, keyboard action wiring, activity reporting, update notice and app stylesheet. `app/main.ts` connects the features. |
| `features/workspace/` | Sidebar, panes, tabs, split layout, view reconciliation and workspace switching. `workspace-view.ts` owns the terminal/viewer registries. |
| `features/terminal/` | Live xterm view, shared terminal settings, attach framing, acknowledgements, scroll restoration and the macOS WebKit Hangul input adapter (`webkit-ime*.ts`). |
| `features/viewers/` | Common viewer lifetime/font/scroll contracts; `text/`, `markdown/`, `folder/` and `record/` own their respective views. |
| `features/changes/` | Git change selection and diff presentation. |
| `features/pairing/` | Desktop phone-pairing dialog and firewall feedback. |
| `features/notifications/` | Needs-input notification decisions and the existing dormant chime implementation. |
| `infrastructure/` | Tauri command/event wrappers, native window visibility and runtime logging. |
| `shared/` | Serialized Rust contracts, shared keyboard decisions/selectors, command error formatting and font bounds. |
| `remote/` | Phone browser entry point, HTTP protocol, polling and views. Built separately through `remote/index.html`. `transport.ts` is the network seam the two phone surfaces share; `app.ts` is the shared shell. |
| `secure-remote/` | Secure Remote static entry for the public HTTPS page: strict QR fragment parsing, the v1 WebTransport frame codec and client. Built separately through `secure-remote/index.html` with base `/mast/`. |

Import the module that owns a value directly. Settings and pure helpers have their own
modules so consumers do not load a view to use them. The workspace renderer assembles the
view features; the desktop bootstrap owns app-wide wiring. `remote/` shares serialized
types but does not load desktop bootstrap or Tauri adapters.

Tests live beside the modules they exercise. Outside `src/`, `tooling/` contains the xterm
Vite patch and its real-bundle regression tests; `tests/` contains WSL helper integration
tests. The desktop HTML points to `app/main.ts` and `app/styles.css`.
