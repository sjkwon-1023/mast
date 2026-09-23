# settings.json reference

Use `mast config` in a mast Bash pane, or edit
`%AppData%\app.mast.desktop\settings.json` by hand. There is no settings screen.
After saving, fully quit and relaunch mast; `Ctrl+Shift+R` is only a window reload.
Restarting ends running terminal processes, so finish or save work first.

Three rules hold for every key below:

- **Everything is optional.** Leave a key out and the built-in default applies.
- **The file is read once, at boot.** Editing it while mast is running changes nothing until
  you restart.
- **A bad file reports itself.** If the JSON does not parse, or a value is out of range, the
  status line says so and the whole file is ignored — you never get a half-applied file, and
  a value is never silently corrected to something you did not write. Keys mast does not
  recognise are ignored rather than rejected, so a file written for a newer version still
  works on an older one.

## CLI

```sh
mast config                              # saved overrides, defaults and help
mast config get fontSize                 # inspect a saved override or its default
mast config set fontFamily "Cascadia Code, monospace"
mast config set fontSize 15
mast config set highlightLanguages '["python","rust"]'
mast config set log true
mast config set showTabIds false         # hide the #id badges on tab titles
mast config set remote                    # enable on 7331
mast config set remote true --port 7441   # enable on 7441
mast config set remote --port 7441        # same, true is optional
mast config set remote false              # remove remote, disabling it after restart
mast config reset fontSize                # remove this override
mast config reset showTabIds              # back to the default (shown)
mast config reset remote                  # disable phone access
```

The CLI displays **saved settings**, not a query of the running app. Commands never restart
mast or open a firewall rule. `set remote` always chooses 7331 when `--port` is omitted,
even if an older saved override used another port. `set remote.port N` also enables remote
access on that port. `false` cannot be combined with a port. Unknown setting names are errors.

The helper uses Python 3's standard library, Windows PowerShell and `wslpath`; Windows interop
and access to the Windows drive must be enabled. No daemon, socket or settings-write OSC command
is installed. Once provisioned, `~/.mast/bin/mast config` can also run from an ordinary WSL shell.
If Windows access is disabled in your distribution, edit the file from Windows instead.

Mutations validate the existing file and the proposed result, preserving unknown keys (also
inside `remote` when enabling or changing its port). Disabling/resetting a field intentionally
removes that entire field. An invalid existing file, duplicate JSON keys, a non-object root,
a symbolic-link target, or a file larger than 1 MiB is refused without replacement. Repair an
invalid file manually; `reset` is not a corruption-recovery command.

Writes use a temporary file in the same directory and replace the target only after a successful
write. A `settings.json.lock` directory serializes CLI writers across distributions; a second
writer fails as busy rather than overwriting the first. If a killed command leaves this directory
behind, confirm no `mast config` writer is running before removing that **empty lock directory**
and retrying. External editors do not participate in this lock: do not edit the file concurrently.

## Full JSON example

```json
{
  "fontFamily": "Cascadia Code, monospace",
  "fontSize": 15,
  "highlightLanguages": ["python", "javascript", "typescript", "rust", "json", "toml", "css", "html"],
  "log": false,
  "showTabIds": true,
  "remote": { "port": 7331 }
}
```

## `fontFamily`

A CSS `font-family` string. It sets the font for the terminal **and** for the viewers'
monospace content — the text viewer's lines, the folder listing, and Markdown code spans and
blocks. Markdown prose keeps its own face.

## `fontSize`

Size in pixels, **6 to 72**. A value outside that range is rejected rather than clamped.

The terminal and the viewers keep separate defaults — 13px and 12px — so one `fontSize`
moves both surfaces from where they each started. Markdown prose follows the *size* even
though it keeps its own face, so a larger `fontSize` scales a whole document. The rest of the
UI (sidebar, tab bars, status line) is never affected.

`Ctrl+=` / `Ctrl+-` / `Ctrl+0` zoom moves the terminal and all three viewer surfaces together.
Zoom is **session-only**: the two surfaces hold separate effective sizes and clamp
independently, `Ctrl+0` returns to the sizes set here, and a relaunch comes back at them too.
Nothing is written back to this file.

## `highlightLanguages`

Which languages the text viewer syntax-highlights. Eight are supported, and all eight are the
default when the key is absent:

`css`, `html`, `javascript`, `json`, `python`, `rust`, `toml`, `typescript`

The language comes from the file extension — `.jsx` highlights as `javascript`, `.tsx` as
`typescript` — and anything outside the set stays plain text. A name that is not on the list
is an error, not an ignored entry. `[]` turns highlighting off.

The highlighter loads on demand, one module per language, so a session that never opens a
matching file never pays for it.

## `log`

Writes a diagnostic log to `mast.log`, next to `settings.json`. Default **off**, and turning
it on takes a restart. While off, no file is opened, no writer thread starts, and nothing is
listened for.

While on, mast records what it does: startup, shell spawns and how long they took, session
exits, failures, and the browser-level input events that are otherwise invisible from outside
the window.

**Terminal output and the text you type are never written.** Composition events record how
many characters were involved, not which ones; a swallowed shortcut records named keys as
themselves and any printable character as `(char)`.

The file is capped at 4 MiB and rolls over into `mast.log.1`, so leaving it on will not fill a
disk. It is a different file from `toast.log`, which records Windows notification delivery and
exists whether or not `log` is on.

## `showTabIds`

Shows each tab's **stable id** next to its title, as `#12`. For terminal tabs, that is the
number `mast ls` prints in its `TAB` column and the address `mast send '#12' …` takes.
Viewer tabs have ids too, but `mast send` cannot target them. Default **on**; set it to
`false` to hide the badges:

```json
"showTabIds": false
```

Every tab carries its own id — active and inactive, terminal and viewer alike. The number is
not invented for the badge: it is the tab's model id, assigned when the tab is created and kept
across a restart, a rename and changes to the tab strip, so an address stays valid. `true` and
`false` are the only values; JSON `null` counts as unset, as it does for the other keys, and any
other type is an error. Read once at boot.

## `macOptionIsMeta` (macOS only)

Makes the Option key act as Meta in the terminal: Option+B sends `ESC b`, Option+F `ESC f`,
and so on, the way Terminal.app's "Use Option as Meta key" does. Default **off**, where Option
types the macOS special characters (Option+2 is `™`) and only Option+arrows are word moves.

```json
"macOptionIsMeta": true
```

From a Mast shell: `mast config set macOptionIsMeta true` (or `false`), and
`mast config reset macOptionIsMeta` to return to the default. `true` and `false` are the only
values; any other type is an error on every platform, but Windows ignores the setting.
Read once at boot.

## `remote` (Local HTTP)

Lets a phone on the same Wi-Fi read a tab and send it input. **This key controls the Local HTTP
mode only**; the separate Secure Remote mode has no setting and is described in its own section
below.

```json
"remote": { "port": 7331 }
```

**The key's presence is the switch.** Leave it out and no listener, no thread and no token
file exist. In JSON, `port` is still required; a missing `port` fails the whole file.
The CLI's explicit `set remote` action writes `{"port": 7331}` when no port is supplied.
This is a command default, not automatic first-run enablement. JSON `remote: true` or
`remote: false` is not supported; the CLI removes the key to turn it off. The accepted range
is **1024 to 65535**.

Changing this takes a restart, like `log`.

Pair a phone from the sidebar's *Pair phone* QR, choosing **Local HTTP**. The pairing token
arrives in the URL fragment and is kept in the phone browser's local storage, so a new browser —
or a cleared one — needs a fresh QR. The same dialog says whether Windows Firewall lets this exe
receive on the port — the allow rule is bound to the exe's path, so a moved or renamed exe loses
it — and offers to write the rule behind one UAC prompt; it never opens the port on a public
network.

This is **plain HTTP on your own LAN**, off by default, and deliberately not hardened for a
hostile network. The accepted limits are recorded in
[ADR-0016](./adr/0016-remote-surface-over-lan.md).

## Secure Remote

A second phone mode, always available from *Pair phone* → **Secure Remote**. It needs no
`settings.json` key and no restart: nothing exists until you select it, and everything is torn
down when the pairing or its connection ends.

- **Lifetime.** Selecting it creates a new self-signed certificate in memory, binds **UDP 7331**,
  and shows a QR. Unscanned, the QR waits up to two minutes; closing the dialog with no
  authenticated phone closes the listener immediately. Exactly **one** phone can be connected.
  When that connection ends (the phone closes the page, the network drops, or 30 seconds pass
  without a request or heartbeat), the endpoint, the TLS state and the private key are released,
  and the next pairing gets a new token and a new QR. The dialog polls the pairing every two
  seconds: once the phone connects — or the pairing expires, fails or ends — the QR and URL are
  removed from the screen, so a dead QR is never left on display.
- **How it connects.** The phone opens the public HTTPS page at
  `https://sjkwon-1023.github.io/mast/`, reads the IPv4 address, port and one-time token from the
  QR's URL fragment, and opens WebTransport to this PC's UDP port; it shows the `host:port` it
  is opening and keeps that line visible afterwards, so a QR naming another machine is visible
  before any input goes anywhere. The QR's SHA-256 fingerprint pins the pairing certificate for
  that connection only — it is **not** added to the browser's trust store. The page removes the
  fragment from the address bar as soon as it loads. The page's origin is public and shared by
  every GitHub Pages site on that account; it narrows what a browser lets the page reach, but
  the one-time token — not the origin — is what authorizes this connection.
- **Nothing is stored on the phone.** The token and fingerprint live in page memory only — not in
  local storage, session storage, cookies or IndexedDB — so reloading the page does not
  reconnect: scan a fresh QR from mast. Reopening the dialog also discards the old QR.
- **Browsers.** Recent Chrome or Edge are the initial phone test targets, but no real-phone
  browser has yet been verified. A browser without `WebTransport` shows an explicit error. A
  browser that has `WebTransport` but does not know `serverCertificateHashes` does not fail when
  the connection is constructed — unknown options are ignored silently — so the failure appears
  later at the TLS step as a plain connection error; there is no separate "cannot pin" message.
  The browser may ask for permission to access your local network; allow it for the page.
- **Firewall.** The listener is UDP 7331, independent of Local HTTP's TCP port (the two can run
  side by side, and the app's fixed secure port does not silently fall back to another one). The
  dialog shows whether Windows Firewall currently allows this exe on UDP 7331 and offers
  **Allow in Windows Firewall**, which writes a rule named `mast secure remote (LAN)` — UDP only,
  `domain,private` profiles only — behind one UAC prompt. The prompt appears only when you press
  that button; opening the dialog or creating a QR never elevates. A port conflict with another
  program is reported as an explicit failure.
- **Reach.** Each QR carries this PC's **LAN IPv4 address**, so pairing as generated works on
  the same network, and mast opens no path of its own beyond it — no cloud relay, no automatic
  VPN or port forwarding. Reaching this PC from outside the network requires a separate path
  you set up yourself — VPN, Tailscale or port forwarding — and mast neither creates nor
  configures one.
- **Failures.** A tampered or stale certificate fingerprint makes the browser refuse the
  connection at the TLS step; a wrong token is rejected as *Not authorized*; a second phone is
  told another phone is connected; a cancelled or already-finished pairing tells the page to
  scan a new QR. Unauthenticated connections are capped at four at a time (two from one address), a
  stalled rejection is cut after two seconds, the whole authentication step shares a ten-second
  deadline, a frame or input write that stalls for fifteen seconds is refused, and the phone
  times a request out after twenty seconds. More than ten failures from one address within a
  minute blocks that address for a minute. If the phone cannot connect at all, check the UDP
  firewall state in the dialog, confirm both devices are on the same Wi-Fi, and allow the
  local-network permission prompt.

Secure Remote does not change Local HTTP: its token file, `remote` setting and TCP firewall rule
stay as they were. Decisions and limits are recorded in
[ADR-0028](./adr/0028-secure-remote-webtransport.md); the Windows field checklist is
`WINDOWS-BUILD.md` §17.

## What else lives in `%AppData%\app.mast.desktop\`

`settings.json` shares its folder with the files mast writes for itself: `state.json` (the
workspace layout), `mast.log` and `toast.log`, the Local HTTP pairing token — and `records\`.

`records\tab-<id>.bin` is **the last screen of a terminal tab whose shell has exited**, held so
the tab can still be read after a restart instead of coming back empty
([ADR-0018](./adr/0018-exited-tab-as-terminal-record.md)). It is the terminal's own bytes in
plain text — whatever was on screen when the shell died, including command output and an agent's
last messages — capped by the 1 MiB replay window. Treat it like any other document on your disk:
nothing encrypts it, and copying the folder copies those screens.

A record is deleted when the tab's **Restart** succeeds (the pane now shows a new shell), when
the tab, its pane or its workspace is **closed**, and at **boot**, when mast removes every record
whose tab is no longer in `state.json` — which on a boot that starts fresh, because `state.json`
was missing or was set aside as `state.json.corrupt-<epoch>`, is every record there is. A shell that exited without printing anything leaves no
file at all. Deleting the folder by hand is safe: the affected tabs come back with an empty
record view and their Restart button.

**`mast.log` still never contains terminal output** — that separation is unchanged, and the two
files are written for different reasons.
