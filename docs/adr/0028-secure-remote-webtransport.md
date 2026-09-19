# ADR-0028: Secure Remote — a public HTTPS page opening a per-pairing WebTransport listener

- Status: accepted
- Date: 2026-09-18

## Context

ADR-0016 gave the phone a plain-HTTP surface: a listener that exists while a `settings.json`
key is present, paired once by QR, with the token kept in the phone browser's local storage.
Two properties of that surface are acceptable on a trusted LAN but were the reason for a second
mode: the listener is long-lived, and the token is stored on the phone.

The request was a phone mode that (a) opens a listener only for the pairing and tears it down
afterwards, (b) never stores the token on the phone, and (c) still does not provide an internet
relay — reaching the PC from outside the LAN stays the user's own VPN / port-forwarding path.
The public page needs a stable HTTPS origin, and the repository is public, so GitHub Pages is
the deployment target. Serving that page from public HTTPS creates a trust problem: the local
listener has only a self-signed certificate, which the browser would normally refuse.
WebTransport's certificate-hash pinning is the means to clear it — `serverCertificateHashes`
lets the page accept a certificate issued for this pairing (self-signed, ECDSA P-256, validity
capped at 14 days) for that one connection, without touching the browser's trust store.
Pinning does not by itself produce (a) or (b): the listener's lifetime and the phone's
no-storage rule are separate design choices that follow from treating the pairing as one-shot,
with the one-time token in the QR fragment as the thing that authorizes the single connection.

The phone screen itself was already implemented (headless xterm rendering, offset-based screen
deltas, paste/Enter separation, TUI scroll handling), and duplicating it was not acceptable.

## Decisions

1. **A separate public static bundle, deployed to GitHub Pages.** The `secure-remote` Vite
   entry builds with base `/mast/` into **`apps/mast/dist-secure-remote`** — deliberately outside
   Tauri's `frontendDist` (`apps/mast/dist`), so Pages-only assets are not embedded in the exe —
   and is published at `https://sjkwon-1023.github.io/mast/` from the `gh-pages` branch root
   (`index.html`, `assets/`, `.nojekyll`). That directory is gitignored and guarded by a CI
   bundle audit (`apps/mast/scripts/audit-secure-remote-bundle.mjs`) that fails on missing or
   empty output, sourcemap files or references, external references (any scheme or
   protocol-relative), unresolved `/mast/` references, a CSP that is not exactly the
   restrictive policy, and browser storage or plaintext-HTTP markers in the produced text.
   The marker half is a bounded literal scan (it also folds adjacent string-literal
   concatenation such as `"local" + "Storage"`); it does not prove that arbitrary obfuscation
   is absent, and source review remains the broader protection.
   The server accepts the exact Origin `https://sjkwon-1023.github.io` and the `/wt` path only.
   That Origin is shared by every GitHub Pages site on the account, so it narrows the
   browser-accessible surface but is **not** an identity or an authentication boundary; the
   one-time token authorizes the connection.

2. **The pairing secret travels in the QR fragment.** The QR is
   `…/mast/#v=1&host=<LAN IPv4>&port=7331&cert=<base64url(SHA-256(DER))>&token=<43-char base64url>`.
   The fragment carries the one-time authentication token and the certificate hash, so the QR
   is itself a secret: anyone who captures it before the scan could attempt that one
   connection. The fragment's purpose is that it never reaches the static server — the browser
   keeps fragments out of requests — and the page parses it strictly (exact field set, IPv4,
   port, 32-byte hash, 32-byte token), removes it from the address bar immediately for valid
   and invalid links alike, and keeps the values in page memory. The page shows the `host:port`
   it is connecting to and keeps that line visible in the phone UI — the QR can name any IPv4,
   so the destination is visible before input goes anywhere. The host is not restricted to
   private ranges: a public address works only if the user's own VPN or port-forwarding path
   delivers it, the same separate-path rule as reaching the LAN from outside. The token
   authorizes a single pairing that serves one connection and dies with it. The built artifact
   is checked for storage-API and plain-HTTP markers by the bundle audit above; that scan is
   bounded as described in decision 1, so it is evidence about this page's bytes, not a
   general proof.

3. **The listener exists only for the pairing.** Selecting Secure Remote generates an ECDSA
   P-256 self-signed X.509 certificate in memory, binds **UDP 7331** (fixed; a conflict is a
   loud failure, never a silent alternative port), and waits up to 120 seconds for the scan.
   Exactly one authenticated connection is served. Disconnect, EOF, or 30 seconds without a
   request or heartbeat tears down the endpoint, TLS state and private key; the next pairing
   gets a new token and a new certificate, and neither is ever written to disk. Unauthenticated
   QUIC connections are capped at four overall and two per source IP; the whole pre-auth phase
   (CONNECT response → first stream → first `auth` frame) shares a single 10-second deadline; a
   CONNECT rejection that cannot be delivered is cut after 2 seconds; and a frame read/write or
   a blocked input write is bounded at 15 seconds. Every pre-auth failure — a token mismatch as
   well as handshake, stream, frame and timeout failures — is counted per source IP, and more
   than ten failures within a minute block that IP for a minute. The desktop dialog polls the
   pairing every 2 seconds and removes the QR and URL once the phone connects or the pairing
   ends, so a stale QR is never left displayed as live.

4. **v1 framing over one bidirectional stream.** `u32` big-endian length + UTF-8 JSON, 1.5 MiB
   maximum, one in-flight request with monotonic ids. Only `auth`, `state`, `screen`, `input`
   and `heartbeat` are accepted; `auth` must be first and the token is compared in constant
   time. The version tag `v:1` is in both the QR and the frames so an old app fails loudly
   instead of misbehaving against a future page.

5. **The ADR-0016 handlers stay the single semantic source.** `state` returns the same
   `StateSnapshot`, `screen` the same offset-based delta (with `endOffset`, `reset`, `cols`,
   `rows`, `session`), and `input` the same raw-byte write with the same 404/409/500 meanings.
   Each pairing has a new epoch, so input built from an old screen cannot reach a new session.

6. **Both phone surfaces share the UI and differ only in transport.** `remote/app.ts` is the
   shared shell; `transport.ts` is the seam. The Secure Remote entry constructs the
   `WebTransportClient` and the Local HTTP entry the HTTP transport, and the existing polling,
   rendering, input separation and scroll behavior are unchanged.

7. **PTY writes go through one caller-owned coordinator.** `mast_remote::InputWriter` is
   created once for the app lifetime and shared by every `secure_remote_start`; a server holds
   only a per-pairing lease. Submission occupies the single slot or is refused with 503
   `input busy` — there is no queue — so repeated pairings cannot accumulate writer threads,
   and a write blocked before re-pairing keeps its lease visible to the next pairing. An
   already-started `write_all` still cannot be cancelled; that limit is accepted and surfaced
   as the busy rejection.

8. **Windows firewall handling is UDP-specific.** Detection and the `Allow in Windows Firewall`
   button use the rule `mast secure remote (LAN)`, UDP only, `domain,private` profiles only,
   built from `current_exe()` and the port. UAC appears only from the user's click; opening the
   dialog or creating a QR never elevates. The TCP rule `mast remote (LAN)` and its commands
   are untouched.

9. **No fallback and no reconnect.** When the WebTransport connection closes, polling and input
   stop and the page asks for a fresh QR. There is no plaintext HTTP fallback and no automatic
   reconnect; a backgrounded browser may be idled out, and re-scanning is the recovery. The
   phone gives each request 20 seconds — slightly longer than the server's 15-second frame
   deadline, so a recoverable refusal arrives before the client gives up — and heartbeats every
   10 seconds to stay inside the server's 30-second idle window.

10. **The Local HTTP mode of ADR-0016 stays as it was.** `settings.json`'s `remote` key, the
    token file, the TCP listener and the TCP firewall flow are unchanged. The two modes use
    different protocols on the same port number and can run at the same time.

## Dependencies and update responsibility

Secure Remote adds the repository's only native TLS stack, and it hangs off one adapter:
`web-transport-quinn` (0.12) wraps `quinn` (0.11, with `quinn-proto` and `quinn-udp`) and
`rustls` (0.23, with `rustls-webpki`), and `ring` (0.17) is the crypto provider all of them
use. `mast-remote` declares only `web-transport-quinn` with `default-features = false,
features = ["ring"]`, so the transport crates are not direct dependencies and move together
when the adapter moves; `rcgen` (certificate generation) and `sha2` (the QR certificate hash)
use the same provider, and the test client's `rustls` dev-dependency is pinned to `ring` for
the same reason. The `ring` choice is deliberate: `aws-lc-sys` would add cmake/NASM build
requirements on Windows that this repository does not assume. `Cargo.lock` pins the exact
versions for every build.

The adapter is the unit of upgrade: a `web-transport-quinn` bump must pass the Linux
`cargo test -p mast-remote` suite (the `tests/wt.rs` client) and the x64 native tests in CI's
`windows-gates` job before merging. The exposed surface is the **pre-auth path** — the QUIC/TLS
handshake, the CONNECT request and the first frames are parsed before any token check — so a
dependency advisory in `quinn-proto`, `rustls` or `ring` is a security matter for this feature,
not routine maintenance. There is **no** automated dependency-vulnerability gate yet (no
`cargo audit`, `cargo deny` or dependabot configuration); the lock as reviewed
(`quinn-proto` 0.11.18, `rustls` 0.23.45, `ring` 0.17.14) was patch-current, but that is a
point-in-time review, not something the build enforces.

## Deployment

### Initial publish (verified 2026-09-18)

The `gh-pages` branch was created as an orphan containing only the verified static bundle; the
remote tree hash `7641d007…` equals the locally built commit tree, and the published files'
SHA-256 hashes equal the local artifact hashes (`index-Dki3aDTa.js` `105bc077…`,
`index-9lycEHJa.css` `5e55fab8…`). Pages was enabled with branch source `gh-pages` `/`
(legacy build); `https://sjkwon-1023.github.io/mast/` returned HTTP 200 over a valid HTTPS
certificate, and the served HTML references `/mast/assets/`, which the browser resolves to the
published bundle. Those values describe **that** published bundle only.

### Follow-up redeployment (pending)

The follow-up review fixes and the later chunks changed the bundle, so the hashes above no
longer match the source tree and the published page predates those changes. The next deployment
copies `apps/mast/dist-secure-remote`'s `index.html` and `assets/` to the `gh-pages` root; that
deployment had not been performed or measured when this ADR was last edited, so no hash or
commit id for it is recorded here. The bundle audit above is the gate between deployments: it
checks the produced text and references, but its scope is bounded as described in decision 1.

## Consequences

- **Browser support follows capability; device tests are pending.** Recent Chrome or Edge are
  the initial phone test targets, but no real-phone browser has yet been verified. A browser
  without a `WebTransport` global gets an explicit notice. A browser that has `WebTransport` but
  does not understand `serverCertificateHashes` does not fail when the connection is
  constructed — unknown WebIDL dictionary members are ignored silently — so that option has no
  effect and the connection fails later at TLS with a generic connection error. There is no
  distinct "cannot pin" error to observe; capability is judged by the actual connection result
  and the §17 field checklist, not by browser name. The browser may also ask for Local Network
  Access permission. This is a narrower client surface than Local HTTP's.
- **Reload means re-scan.** Nothing survives on the phone, which is the point, but it also means
  a phone that drops its connection — including a backgrounded tab that stops heartbeating — is
  recovered only by scanning a new QR. There is no cloud relay; external reach needs the user's
  own VPN or port forwarding.
- **The page is a runtime dependency on GitHub Pages.** A future page revision must remain v1
  compatible or keep versioned pages, as the plan states; the app rejects unknown versions
  loudly rather than degrading quietly.
- **A blocked PTY write is refused, not cancelled.** Input during a hung write gets 503
  `input busy` and the phone restores the typed text; the write itself runs to completion. A
  write that has not finished 15 seconds after its request gets 503 `input write timed out` and
  the request loop continues, with the phone's 20-second request deadline as the outer bound.
  That timeout does **not** cancel the write: the bytes may still reach the PTY afterwards, so
  the phone separates it from the other 503s and warns *Delivery is uncertain — the input may
  still arrive. Check the terminal before sending again* instead of claiming it was not sent.
  The typed text stays in the input box and nothing is resent automatically.
- **The screen still uses the PTY width.** The phone reads the desktop layout, so a full-width
  TUI fragments at the phone width — the accepted ADR-0016 decision-7 limit applies here too.
- **Field verification remains pending.** Linux integration tests cover hash mismatch, token
  failure, state/screen/input, teardown/UDP release and re-pairing; the Windows UAC/firewall flow
  and real-phone handshake are the checklist in `docs/WINDOWS-BUILD.md` §17. ARM64 compilation
  is covered by the CI `windows-gates` job, not by real hardware.


## 2026-09-20 리뷰 수정과 main 통합

- `web_transport_quinn::Server::accept()`는 HTTP/3 CONNECT 이전 핸드셰이크를 내부에
  제한 없이 보관하므로 사용하지 않는다. Quinn Endpoint에서 직접 수락하고 QUIC 핸드셰이크
  이전부터 전체 4개·IP당 2개 슬롯을 예약한다. QUIC, HTTP/3, 첫 인증 프레임은 수락 시점부터
  같은 10초 마감을 공유한다. 실패한 연결은 닫고 슬롯을 회수한다.
- 차단된 IP와 슬롯 초과 연결은 QUIC 단계에서 거절한다. 따라서 이미 차단된 재시도는
  HTTP 429 대신 연결 거절을 받으며 시도별 로그를 추가하지 않는다.
- 실제 QUIC 연결로 HTTP/3 SETTINGS를 보내지 않는 경우의 IP별·전체 상한, 시간 만료,
  슬롯 회수와 다른 IP의 정상 인증을 검증한다.
- main의 Local HTTP Mobile/Desktop 기능은 선택적 `postResize` 전송 기능으로 유지한다.
  Secure Remote v1에는 resize 요청이 없으므로 해당 버튼을 표시하지 않는다.
  화면 응답의 `sizeOwner`는 실제 PTY 상태를 전달하며 구버전 v1 응답도 읽을 수 있다.
