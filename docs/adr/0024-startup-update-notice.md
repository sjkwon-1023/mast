# ADR-0024: A startup-only release notice

Status: accepted (2026-09-13)

## Decision

Native setup starts one short-lived background thread to query the public GitHub latest-release
endpoint. A process-lifetime cache holds the installed version, an optional newer stable version,
and whether the attempt finished. `get_update_info` only reads this cache; it never starts a
request. A WebView reload therefore cannot increase network traffic. Nothing is persisted.

The frontend subscribes to `update-checked` before reading the cache and does not let an older
pending snapshot overwrite a completed event. Sidebar footer nodes remain independent of workspace
card reconciliation. The installed version comes from Cargo package metadata, checked against the
Tauri version in a Windows test. A small update link appears only for a strictly newer stable
version and always opens the fixed repository release page through the existing URL opener.
No server-provided URL is opened.

There is no popup, polling, manual recheck, download, executable replacement or automatic restart.
Failed checks finish the attempt without a newer-version label; this is not a claim that the app
is up to date. The optional runtime log records errors. No session or dispatcher lock is held
across network I/O, and the dispatcher blocking pool is not used.

## Transport and accepted limits

WinHTTP uses the existing Windows bindings and OS TLS implementation, without a new HTTP/TLS
dependency or subprocess. The request is HTTPS to `api.github.com`, uses Windows proxy settings,
requires TLS 1.2 or 1.3, and leaves certificate verification enabled. Redirects, cookies and automatic
authentication are disabled. Headers are capped at 16 KiB and the body at 64 KiB. DNS, connect,
send and receive timeouts are set to 3 seconds. The body loop has an additional 8-second budget
and shrinks its per-call timeout to the remaining budget. These are WinHTTP stage timeouts, not a
hard wall-clock cancellation guarantee across OS proxy/TCP operations; no other thread closes
an in-flight synchronous handle. Handles are released in reverse order on success and error.

The request sends the mast version in User-Agent, but no workspace paths, terminal contents,
agent identifiers or credentials. GitHub can observe the normal request IP. There is no opt-out
setting in this small feature. Offline use and rate limiting do not prevent startup; retry waits
until the next app process. Only three-component numeric stable tags, optionally prefixed with
`v`, are accepted; draft/prerelease and unsupported tag formats never produce an update notice.

## Verification

Core tests cover numeric comparison, malformed/oversized JSON, draft/prerelease rejection,
concurrent once-only start and cached failure. Frontend tests cover the installed version,
conditional link, fixed destination and event/snapshot ordering. The ignored Windows test
`update::tests::github_release_probe` exercises the actual native request without launching the
GUI. Manual checks cover offline launch, a WebView reload after completion and opening the link
without ending a terminal session.

## Amendment (2026-09-24) — native macOS request

The native Apple Silicon build makes the same single startup check and uses the same
process-lifetime cache and fixed release-page link. It invokes `/usr/bin/curl` with a cleared
environment, `--disable` (no `.curlrc`), HTTPS-only protocol selection, TLS 1.2 or later,
HTTP/1.1 and the fixed `api.github.com/repos/sjkwon-1023/mast/releases/latest` endpoint. It
does not follow redirects, send credentials or use environment proxy settings. Response headers
are captured on stderr and capped at 16 KiB; the body is captured on stdout and capped at 64 KiB.
The version parser still accepts only a newer three-component stable tag, optionally prefixed
with `v`. Both streams are bounded in-memory captures; no response file is written.

The approved macOS timeout policy is deliberately bounded and differs from WinHTTP's stage
timeouts: curl uses a 3-second connect timeout, a 3-second low-speed timeout below 1 byte per
second, and an 11-second total request timeout; the process capture has a 12-second deadline.
This does not reproduce separate 3-second DNS/connect/send/receive stages or the Windows
additional 8-second body budget. Network failures, redirects, malformed responses and limit
exceedance do not produce an update label; errors are recorded when optional runtime logging is
enabled. The request remains a release notice, not an updater.

The ignored live macOS curl probe and offline/reload/link device checks are separate from the
document-link gate; this amendment does not claim that those checks have passed.
