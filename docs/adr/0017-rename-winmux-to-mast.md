# ADR-0017 — Rename winmux to mast

Status: accepted (2026-09-11) · Verification: WINDOWS-BUILD §12

## Context

`winmux` was not a name this project could hold. GitHub carries 28 repositories named
`winmux`/`WinMux`; the largest is `ZimengXiong/winmux` — "WinMux for macOS", 251 stars, still
committing, with `winmux.dev` and a separate landing-page repository. That is a same-category
competitor owning the search term outright, which is a harder problem than sharing a name with
an unrelated project: someone told about this tool and searching for it lands on a different
terminal multiplexer. The `win-` prefix also read as "Windows-only by limitation" rather than
by choice, and `-mux` put the project inside the crowded `tmux`/`zellij`/`wemux` naming space
it is not actually a member of.

This is the second rename. `wmux` → `winmux` happened for the same reason and is recorded in
WINDOWS-BUILD §10 item 12; that round's playbook — no migration code, one developer, a written
manual procedure — worked and is reused here.

Two candidate names were researched against package registries, GitHub, domains and general
search: `mast` and `LiMAT`. `LiMAT` had every registry slot free but loses its capitalisation
everywhere that matters (npm forbids uppercase, PyPI normalises, and the thing a user types is
`limat ls`), sits one vowel from `limit` next to the `ulimit` builtin, and means "mucus" in
Finnish. `mast` has no same-name software in a developer context: crates.io and Homebrew are
free, the CLI verb does not collide with a package in any major distribution, and a search for
it surfaces sailing rigging and lightning protection — unrelated industries rather than a
competitor. Being buried by yacht hardware is a better position than being buried by another
agent terminal with your name on it.

## Decisions

1. **The project is `mast`, lowercase, everywhere** — repository, product name, crate prefix,
   npm package, CLI verb, the `MAST_*` environment variables and the `mast:*` OSC status
   tokens.

2. **The name is not presented as an acronym.** An expansion along the lines of "multi agents
   … terminal" collides head-on with MAST, the Multi-Agent System Failure Taxonomy
   (arXiv:2503.13657, NeurIPS 2025), in exactly the field this tool serves, and with Mastra
   (`mastracode`, a terminal coding agent) one prefix away. As a bare name `mast` carries
   neither association; as an acronym it invites both. Public documentation uses a product
   sentence, never an expansion.

3. **The Tauri identifier changes to `app.mast.desktop`.** Keeping `app.winmux.desktop` would
   have made the data migration free, at the cost of a state directory, an AppUserModelID and
   a toast sender identity permanently carrying the old brand. The identifier is also the
   `%APPDATA%` directory name that the docs tell users to open, so the divergence would be
   visible rather than internal. The cost is a manual state copy, documented in WINDOWS-BUILD
   §12.

4. **No migration code.** Nothing detects the old paths, aliases the old environment variables
   or cleans up the old hooks. The audience is one developer, star count is zero, and the
   alternative is four permanent legacy branches (Claude hook `MARK`, Codex `MARKS` and
   `LEGACY_VALUE`, and the `AGENTS.md` managed-block markers) carried forever for a single
   migration. `SETUP_VERSION` moves 10 → 11 so provisioning reruns; the rest is a checklist.

5. **ADR-0010 keeps the old name.** It is an incident record — the exit codes, paths and
   tokens in it are what was observed at the time, and substituting them would make it a
   record of something that did not happen. Every other ADR takes the substitution, because
   they describe designs that are still live. WINDOWS-BUILD's rename-migration sections keep
   their original names for the same reason.

## Consequences

Anyone with an existing install follows WINDOWS-BUILD §12 before first launch — in particular
the Codex and Claude Code hook cleanup, because provisioning does not recognise the old
entries and will not replace them, while still recording its completion marker. Release assets
are `mast-x64.exe` / `mast-arm64.exe` from v0.3.21 on; earlier releases keep their old asset
names, and GitHub's redirect keeps old repository URLs working as long as no new repository
takes the `winmux` name.
