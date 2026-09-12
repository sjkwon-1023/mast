# settings.json reference

mast has no settings screen. Write `%AppData%\app.mast.desktop\settings.json` by hand and
restart the app.

Three rules hold for every key below:

- **Everything is optional.** Leave a key out and the built-in default applies.
- **The file is read once, at boot.** Editing it while mast is running changes nothing until
  you restart.
- **A bad file reports itself.** If the JSON does not parse, or a value is out of range, the
  status line says so and the whole file is ignored — you never get a half-applied file, and
  a value is never silently corrected to something you did not write. Keys mast does not
  recognise are ignored rather than rejected, so a file written for a newer version still
  works on an older one.

## Full example

```json
{
  "fontFamily": "Cascadia Code, monospace",
  "fontSize": 15,
  "highlightLanguages": ["python", "javascript", "typescript", "rust", "json", "toml", "css", "html"],
  "log": false,
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

## `remote`

Lets a phone on the same Wi-Fi read a tab and send it input.

```json
"remote": { "port": 7331 }
```

**The key's presence is the switch.** Leave it out and no listener, no thread and no token
file exist. `port` is required — there is no default, because a default would open a port on
your LAN that you never asked for. A missing `port` fails the whole file on purpose, so you
find out from the status line rather than from an open socket. The range is **1024 to 65535**;
below 1024 is the well-known range that needs administrator rights on Windows too.

Changing this takes a restart, like `log`.

Pair a phone from the sidebar's *Pair phone* QR. The pairing token arrives in the URL fragment
and is kept in the phone browser's local storage, so a new browser — or a cleared one — needs
a fresh QR. The same dialog says whether Windows Firewall lets this exe receive on the port —
the allow rule is bound to the exe's path, so a moved or renamed exe loses it — and offers to
write the rule behind one UAC prompt; it never opens the port on a public network.

This is **plain HTTP on your own LAN**, off by default, and deliberately not hardened for a
hostile network. The accepted limits are recorded in
[ADR-0016](./adr/0016-remote-surface-over-lan.md).

## What else lives in `%AppData%\app.mast.desktop\`

`settings.json` shares its folder with the files mast writes for itself: `state.json` (the
workspace layout), `mast.log` and `toast.log`, the remote pairing token — and `records\`.

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
