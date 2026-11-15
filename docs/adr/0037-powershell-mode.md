# ADR-0037: Windows PowerShell mode for PCs without WSL

- Status: accepted
- Date: 2026-11-12
- Verification: the automated gates listed under Verification. The Windows field checks in
  `docs/WINDOWS-BUILD.md` §10 "Unreleased — Windows PowerShell mode field verification" have not
  been run on a device, so no item there is recorded as passed.

## Context

mast's terminal model is WSL2. Some non-developer users run Windows PCs without WSL, and for them
the maintainer installs Antigravity CLI (agy) and herdr. The goal of this mode is to run mast on those PCs
with terminal tabs in Windows PowerShell, and to keep agy's running and idle state on the sidebar
card, as WSL mode does.

`CLAUDE.md` had a non-goal, "Supporting PowerShell/CMD profiles; WSL2 remains the terminal execution
model". Decision 2 narrows it. Antigravity CLI has no input-wait signal (ADR-0026 decision 8), so this
mode sends no Windows notifications for agy; only running and idle reach the card.

On 2026-11-12 the user confirmed that these WSL features are not needed for the non-developer PCs:
the Git changes viewer, `mast ls`, `send`, `open`, `diff`, auto-resume, Claude Code,
Codex and OpenCode status. This mode leaves them out, and also leaves out cmd tabs and `mast config`.

The constraint that shaped every decision: an existing WSL install must not change. Without a
`windowsShell` key, the WSL code paths run as before, and the installer writes nothing new.

## Decisions

### 1. One app-wide setting, not a separate build or a per-workspace choice

`settings.json` gets `windowsShell`, with the value `"wsl"` or `"powershell"`. Absent and `null`
mean `"wsl"`. On Windows the key is read once at boot. Any other value or type stops startup with an
error, like other settings. macOS builds neither read nor validate it.

The key is not `shell`. On macOS, `shell` already holds the login-shell executable path
(`UiSettings.shell`). Using the same key for a mode would give one name two meanings, and the macOS
value `"/bin/zsh"` would fail the new mode check.

### 2. The non-goal is narrowed

`CLAUDE.md` now says that PowerShell and CMD profiles are not supported beyond the one PowerShell
mode for PCs without WSL. WSL2 remains the default execution model. cmd tabs and running both modes
in one install are not supported.

### 3. PowerShell tabs

In PowerShell mode each terminal tab starts as

```
powershell.exe -NoLogo -NoExit -EncodedCommand <UTF-16LE base64 of the integration script>
```

- The target is Windows PowerShell 5.1. Non-developer PCs do not have `pwsh` 7.
- The process working directory is always `%USERPROFILE%`.
- The saved folder goes into the script as a literal, and the script calls `Set-Location -LiteralPath`
  only if the folder exists. The app does not check folder existence itself, because a disconnected
  network drive can block the whole app. A folder is passed only when it is a drive path
  (`^[A-Za-z]:\\`). Any other value is not passed, and the tab starts in the profile folder.
- The tab id and `<mast.exe folder>\bin` are also literals in the decoded script. They are data, are
  quoted by doubling single quotes, and are never expanded.
- The assembled command line must stay under 32,767 characters. A longer one is refused before the
  spawn with an error. It is not truncated.
- `-EncodedCommand` needs no script file, so the execution policy does not apply, and no quoting is
  needed. The user's profile still loads.

### 4. The shell integration script

`scripts/win/powershell-integration.ps1` is the source of the script body. The app embeds it with
`include_str!`. It is PowerShell 5.1 syntax and does what the WSL launcher does, limited to what
this mode needs:

1. Its first action writes the start marker `ESC ] 777 ; mast-started BEL` (ADR-0009). Profile output
   may come first, so the marker is the script's first action, not the first output.
   - Its second action sets the tab title once to `PowerShell` with `[Console]::Title`. Without it,
     conhost reports the full `powershell.exe` path as the title. The short name does not tell tabs
     apart; the tab id badge, shown by default, does. The prompt never sets the title again.
2. It sets `MAST=1`, `COLORTERM=truecolor`, `MAST_TAB` (removed when there is no tab id) and
   `MAST_SHELL_PID`.
3. It puts `<mast.exe folder>\bin` at the front of `Path`.
4. It changes to the saved folder (decision 3).
5. It wraps `prompt`. While the location is a file-system path, each prompt writes OSC 7
   `file://<COMPUTERNAME>/<drive path>` (ADR-0011). The OSC is written with `[Console]::Write` outside
   the prompt string, because PSReadLine counts the width of the prompt string and an escape inside it
   would shift the input cursor.
   - The path encoding differs from the design. The design encoded only `%`. The implementation
     encodes `%` and every non-ASCII UTF-8 byte as `%XX` and leaves other bytes alone, so spaces stay
     raw. Writing the path through the console code page garbled a Korean user
     name on the Korean-locale test PC. The receiver already decodes `%XX`, so the round trip is
     lossless.
   - No OSC 0 per prompt (ADR-0011 decision 2), and no OSC 10/11 color setup. conhost handles colors
     for PowerShell (ADR-0009). The one start-up title from item 1 is the only OSC 0 this script causes.
6. It defines the `mast` function. Only `mast update` is supported. The function sets
   `MAST_WINDOWS_SHELL=powershell` while it runs the installer from `main`
   (`Invoke-RestMethod | Invoke-Expression`) and restores the previous value in `finally`. Any other
   argument writes `mast: only "mast update" is supported in PowerShell mode` as a non-terminating
   error and sets `$LASTEXITCODE` to 1. It does not call `exit`, which would close the tab.

### 5. Working folders

- **Conversion.** The OSC 7 path `/X:/...` becomes `X:\...` only in PowerShell mode. The conversion
  is the pure function `wslpath::to_windows_drive_path` in `crates/mast-core`. Any other value is
  stored as received, and restore does not pass it (decision 3). WSL mode does not convert, because a
  bash `cd //tmp` keeps `$PWD` as `//tmp`, and the WSL wrapper uses the stored value. A rewrite based
  on shape would break those WSL paths.
- **Display and names.** The sidebar shows `C:\Users\<name>` as `~` (`abbreviateDrivePath`). Basenames
  split on `\` as well as `/`: `windowsPathBasename` in the frontend and `windows_folder_name` in the
  Tauri glue. The shared `pathBasename` and `folder_name` are unchanged, because WSL and macOS use
  them and must not change.
- **Folder picker.** PowerShell mode accepts only a folder on a drive letter. A UNC path such as
  `\\server\share`, or a path without a drive letter, is refused with `PowerShell mode needs a folder
  on a drive letter; map the network folder to a drive first`. The design left this open. The
  decision was made during implementation. The picked path becomes the workspace root with
  `distro: null`.
- **`/mnt` check.** Creating a workspace from the current folder skips the WSL `/mnt` check in
  PowerShell mode.

### 6. PowerShell mode never starts `wsl.exe`

Two mechanisms work together.

- **The health probe.** `wsl_health::create` returns `NotApplicable` in PowerShell mode, the same probe
  non-Windows builds use. Spawn gating then passes, the WSL notice does not appear, and
  `wslBlocksTerminal` is false. No probe runs `wsl.exe`.
- **Direct gates.** Call sites that do not go through the probe have a first-line refusal or a
  no-op. `ensure_provisioned`, `warm_wsl` and `release_tab_files` do nothing. `host_path`, which all
  file viewers and file probes use, and the Git queries (`git_status`, `git_diff`) and the
  presentation repository-root probe refuse with an English `PowerShell mode does not support …`
  error. The folder-browser and Git Changes entry points are hidden on the frontend (decision 7).

Counting the `wsl.exe` launch sites: `rg 'Command::new("wsl.exe")'` finds seven, and the eighth is the
`SpawnSpec` program literal in `host.rs`. Each site is unreachable in PowerShell mode by reading its
callers. Nothing traced the processes. Two of the seven are in the probe path that `create(true)`
skips, and the rest are covered by the gates above.

The mode is kept in two places, both set from the same single read of `UiSettings` at boot.
`TabLaunch.powershell` carries it into `TauriHost`. A process-wide `OnceLock` in `host.rs`
(`set_powershell_mode`) serves the free functions that have no state object (`host_path`, the sink,
the presentation probe, the provisioning and warm-up gates). Passing the value through them would
have changed signatures in files outside this change. After boot the mode is not taken from the file again.
Later reads of `settings.json`, such as `get_ui_settings` on each frontend reload, still parse the file,
but they do not use `windowsShell` for the mode. `get_ui_settings` sends the boot value
(`apply_boot_windows_shell`), so a reload cannot show a mode that the running tabs do not use.

### 7. Hidden entry points

In PowerShell mode these entry points are not created: the folder-browser header button, the
`Ctrl+Shift+B` shortcut (the key goes to the shell, not consumed), the Git Changes button, and file
path links in terminal output. The not-started notice and the tab tooltip use shell-neutral wording
instead of the WSL wording. The notepad and the built-in browser tab do not depend on the shell, and
this mode does not change them. The phone remote is not changed either, but its use with PowerShell
tabs is a field item.

### 8. agy status through `mast-agy-hook.exe`

agy reports its running and idle state through hooks in `%USERPROFILE%\.gemini\config\hooks.json`.
In WSL mode a shell script does the reporting. Here a separate console program does it. It is a new
crate, `crates/mast-agy-hook`, with a Windows-only binary built on `windows-sys 0.61`. It is installed
as `<mast.exe folder>\bin\mast-agy-hook.exe`. Its steps, in order:

1. The arguments must be exactly one, `running` or `idle`. Otherwise it prints usage to stderr, exits 2,
   and writes nothing to stdout.
2. It writes `{}` and a newline to stdout and flushes. agy reads hook stdout as JSON.
3. If `MAST_TAB` is not a non-empty run of ASCII digits, it writes nothing. `hooks.json` is global, so
   agy runs outside mast also call the hook.
4. If `CLAUDECODE` or `CODEX_THREAD_ID` is set, it writes nothing. Another agent in the same tab owns
   that tab's state.
5. It opens `CONOUT$`, turns on VT processing, writes `ESC ] 777 ; notify ; mast:running ; BEL` or
   `ESC ] 777 ; notify ; mast:idle ; done BEL`, and restores the console mode. If `CONOUT$` cannot be
   opened, it exits quietly.
6. If stdin is not a console, it reads stdin to EOF, so agy's write never blocks. A console stdin is
   not read. This step runs after the OSC, so a stdin that stays open cannot hold back the state
   signal. After argument validation, every failure is ignored and the exit code is 0.

Why a separate binary: a PowerShell script hook would pay a PowerShell start on every call. Putting it
into `mast.exe` would make the hook depend on console behavior of a GUI executable.

Hook registration in the `mast` group of `hooks.json`: `PreInvocation` runs `mast-agy-hook running`,
and `Stop` runs `mast-agy-hook idle`, both with a timeout of 5. The commands have no quotes and no
full path. agy runs hooks through `cmd /c`, and a quoted command fails there. agy turns the quotes into
`\"`, and cmd does not recognize the result as a command. An unquoted full path and a PATH name both work. The tab
prepends `bin` to `Path` (decision 4), so the PATH name resolves inside mast. Outside mast the name
does not resolve, agy logs the error and keeps running.

The non-Windows build compiles and exits 1 with `mast-agy-hook runs only on Windows`.

### 9. Installer

`scripts/win/install.ps1` reads `MAST_WINDOWS_SHELL`. Unset means the previous behavior: only
`mast.exe` is installed, and no other file or registry value changes. The value `powershell` adds
these steps, in this order:

1. The value is checked before anything changes. It is case-sensitive, and any value other than
   `powershell` is refused, including `wsl` and `PowerShell`.
2. `settings.json` and `hooks.json` are read before anything is written. A missing file counts as an
   empty object. A file that is not valid JSON, or whose root is not an object, stops the installer
   with nothing written. The design put `mast.exe` first. Reading the JSON first means a bad file stops
   the installer before `mast.exe` is replaced.
3. `mast.exe` is installed as before. That code is now a function, so the early return for an
   already-latest version does not skip the following steps.
4. The hook exe is downloaded to a `.installing` file, its `MZ` header is checked, and it moves into
   `bin`. A running copy is renamed to `.old-<ticks>`, the same way `mast.exe` is handled.
5. In `hooks.json`, only the `mast` group is replaced. Other groups are kept.
6. In `settings.json`, `windowsShell` is set to `"powershell"` and other keys are kept. This is last,
   so a failed hook download leaves the settings unchanged.
7. Both JSON files are written as UTF-8 without BOM, through a temporary file and a move. agy (Go)
   cannot read a BOM. The serializer uses `ConvertTo-Json -Depth 32`.
8. The installer writes no registry value and does not change the user `PATH`.

The hook download uses `releases/latest` unless `MAST_HOOK_DOWNLOAD_URL` is set. `MAST_DOWNLOAD_URL`
does not pin the hook (see Accepted limits). `MAST_APP_DIR` is respected as before. `MAST_SHELL` is not
used, because the macOS app reads that name.

### 10. Release and CI

- `gates` (ubuntu) runs `cargo test -p mast-agy-hook`. `windows-gates` runs the hook tests natively,
  and the `wsl_health::` filter for the probe test. The `host::tests` and `commands::tests` filters
  already exist.
- `windows-artifacts` builds `mast-agy-hook` for x64 and ARM64. On a `v*` tag it attaches
  `mast-agy-hook-x64.exe` and `mast-agy-hook-arm64.exe` to the release. The job does not run on pull
  requests, so it is run once with `workflow_dispatch` on the branch before a tag.
- The hook's release build sets `RUSTFLAGS=-C target-feature=+crt-static` on its own step only. The exe
  then does not import `VCRUNTIME140.dll`, so it runs on a PC without the Visual C++ redistributable. The
  app build does not set the flag.
- ARM64 is built but not checked on hardware (user decision, 2026-11-12). The field checks are x64 only.

## Alternatives rejected

- **A separate build (`mast-win-native`).** It is built from the same code, so a common change hits
  both builds. The isolation gain is small, and the release assets, update path and CI matrix double.
- **A shell choice per workspace.** One state file would hold both `/home/...` and `C:\...` paths, and
  restore, validation and display would each need both. Non-developers use one shell, and WSL users do
  not need a PowerShell tab.
- **Reusing `shell` or `MAST_SHELL`.** `shell` is the macOS login-shell path. `MAST_SHELL` is the name
  the macOS app reads.
- **Putting mast on the user `PATH` in the registry.** It changes state outside mast's folder, and new
  shells need a sign-out. The tab prepends `bin` to `Path` instead.
- **`AttachConsole` in the hook.** The observed agy runs the hook on the tab console directly, so the
  hook does not need to attach (see Experiment evidence). It is the fallback if agy changes how it
  runs hooks.
- **A PowerShell script as the hook.** Each call would wait for a PowerShell start.
- **`pwsh` 7.** It is not installed on the target PCs.
- **Splitting `folder_name` on `\` in the shared function.** The function is shared with macOS. A
  Windows-specific function was added instead.

## Experiment evidence

Recorded on 2026-11-12 on Windows 11 24H2 (build 26100), x64, Korean locale. The harness and its raw
output are not in the repository. The conditions below are what reproduces the results.

### ConPTY and OSC from a hook process

A test harness opened a ConPTY the way portable-pty does: creation flags 0, standard handles through
`STARTF_USESTDHANDLES` with `INVALID_HANDLE_VALUE`, and a reply to `ESC[6n`. It started PowerShell in
the ConPTY, and ran hook-like processes that wrote OSC 777 to `CONOUT$`.

| How the hook runs | Plain write | After `AttachConsole` to the parent |
|---|---|---|
| Child of the shell | arrives | — |
| Inherits the console, standard handles redirected (Go default) | arrives | — |
| `CREATE_NO_WINDOW` (Node `windowsHide`) | does not arrive; writes to a hidden new console | arrives |
| `DETACHED_PROCESS` | does not arrive; `CONOUT$` cannot be opened | arrives |
| Two levels of `CREATE_NO_WINDOW` | does not arrive | does not arrive when attached to the parent; arrives when attached to `MAST_SHELL_PID` |

Conclusion: no new channel such as a named pipe is needed. In the worst case, `FreeConsole` followed by
`AttachConsole(MAST_SHELL_PID)` reaches the tab console.

### Antigravity CLI 1.5.6

The harness ran agy inside its PowerShell, in interactive (`-i`) and print (`-p`) modes, with a test
hook registered in `hooks.json`.

- Process chain: `hook.exe` ← `cmd.exe` ← `agy.exe` ← `powershell.exe` (the tab shell). The hook shares
  the tab shell's console.
- Plain writes delivered the OSC 777 signals: `running` by absolute path and by PATH name, and `idle` by
  absolute path, direct and attached. `idle` by PATH name was not run through agy.
- `hooks.json` loads and the hook runs in both interactive and print mode.
- Tab environment variables such as `MAST_TAB` reach the hook.
- agy writes the hook input as JSON on stdin (about 600 bytes: `artifactDirectoryPath`,
  `conversationId`, `cwd` and others).
- Quoted commands fail (see decision 8). Unquoted full paths and PATH names succeed.
- When the hook fails, agy logs the error and keeps working.

### Hook harness, Windows x64

The hook was run through `cmd.exe` with the PATH name, `running` and `idle`, in a ConPTY. The raw
output contained one `ESC]777;notify;mast:running;BEL` and one `ESC]777;notify;mast:idle;doneBEL`.
Stdout was exactly `{}` plus a newline. With `MAST_TAB` empty, no OSC was written. With `CLAUDECODE=1`,
no OSC was written. A console stdin did not block. The Stop path through agy itself was not tested
against a live agy session; the PATH-name `idle` path was tested through this harness.

After the final review, the same harness ran the static-CRT release build (see the next section). The
OSC is now written before stdin is drained (decision 8, step 5). Results: `running` and `idle` by PATH name
each wrote their OSC, and stdout was `{}`. With `MAST_TAB` empty nothing was written. Two arguments printed
the usage line and exited 2, with no `{}` on stdout.

### Integration script in a ConPTY

`-EncodedCommand` started the integration script in a ConPTY on the development PC. The raw output
contained the `mast-started` start marker, and the OSC 7 written after `Set-Location` carried the folder
path. The OSC bytes reach the ConPTY in the form the app reads.

On 2026-11-12 the script with the start-up title (`[Console]::Title = 'PowerShell'`) ran the same way, with
`-NoProfile`. The raw output had the start marker first, then conhost's `powershell.exe` path title, then
`PowerShell` as the last title, then OSC 7. The earlier run ended on the path title, so the new line
is what changes the last title.

### Hook VC runtime linkage

A release build of `mast-agy-hook` with the default MSVC runtime imports `VCRUNTIME140.dll`. The same
source built with `-C target-feature=+crt-static` imports no `VCRUNTIME140.dll` (`objdump -p`, x64). CI
builds the release asset with the flag (decision 10).

## Verification

Automated coverage, by area:

- Linux: `cargo test -p mast-core` covers the drive-path conversion and OSC 7 storage in both modes.
  `cargo test -p mast-remote` runs against the new `SessionHost` default. `cargo test -p mast-agy-hook`
  covers the argument check (exactly one `running` or `idle`), the `MAST_TAB` and other-agent decisions, the OSC bytes and the
  console-stdin decision.
- Windows x64, native (`--target x86_64-pc-windows-msvc`): `host::tests` (spawn arguments, folder
  passing, command-line limit, the WSL-feature refusal), `commands::tests` (`windowsShell` parse and
  refusal, UNC refusal, folder picker, `windows_folder_name`, the boot-mode value sent to the frontend), `wsl_health::` (the `NotApplicable`
  probe), `provision::tests`, and the full `mast-app` suite. `mast-agy-hook` has its own native test
  and release build. Clippy runs with `-D warnings`.
- Frontend: `npm run build`, `audit:secure-remote` with its self-test, and `npx vitest run`. The new
  and changed tests are in `shared/windows-shell.test.ts`, `shared/keys.test.ts` (current-folder
  workspace with the drive-letter refusal, `windowsPathBasename`), `features/workspace/sidebar-model.test.ts`
  (drive-path abbreviation, `Users` without case), `features/workspace/pane-view.test.ts` (hidden buttons, neutral notice),
  `app/navigation/actions.test.ts` (`Ctrl+Shift+B` passes through) and
  `features/terminal/file-links.test.ts` (no links).
- PowerShell 5.1: `powershell-integration.ps1` and `install.ps1` parse with no errors. The integration
  script was run with `-NoProfile` in a scenario check: the start marker came first, `prompt` wrote OSC 7,
  `MAST_TAB`, `MAST_SHELL_PID` and `Path` were set, a missing folder was not entered, and `mast foo`
  failed. `install.ps1` ran nine smoke cases in temporary folders. They covered: the variable unset;
  a fresh PowerShell-mode install; existing keys and groups kept; a failed hook download leaving the
  files unchanged; invalid settings or hooks JSON refused; invalid values refused; and the registry
  unchanged. The smoke cases are not kept in the repository. After the final review, the non-object JSON
  roots in both files (array, string, number, boolean, empty) and both hook-failure messages were checked
  again with the same method, and the PowerShell 5.1 parser reported no errors.

`scripts/win/tests/test_install.py` (19 tests, 13 of them new, including the already-latest early return
in PowerShell mode) passed on the development PC with Windows Python 3.15.2 and Windows PowerShell 5.1,
run with `PYTHONUTF8=0`: on a Korean-locale PC, PowerShell writes its error text in the console code page,
which the UTF-8 mode that Python 3.15 enables by default cannot decode. The `windows-gates` Python step
runs the same module; on Linux the module skips itself.

Not run on the development PC, so CI or a device must confirm them:

- `windows-artifacts`, which runs on tags and `workflow_dispatch` only.
- The field checks in `docs/WINDOWS-BUILD.md` §10 "Unreleased — Windows PowerShell mode field
  verification".

## Accepted limits

- **No Windows notification for agy in this mode.** agy has no input-wait signal, so the card shows only
  running and idle.
- **Restored viewers after a mode switch.** A folder-browser or Changes tab left over from WSL mode
  shows a `PowerShell mode does not support …` error. Nothing starts `wsl.exe`. Only the new entry
  points are hidden.
- **Saved folders that are not drive paths.** A workspace whose saved folder is a UNC path, or any value
  that is not a drive path, restores into `%USERPROFILE%`.
- **Switching an existing install between modes.** Not tested on a device. New installs are the
  supported path.
- **PSReadLine and prompt wrappers.** The OSC is written outside the prompt string, but PSReadLine's key
  handling and a user's prompt wrapper (for example oh-my-posh) are unverified. Korean IME composition
  in a PowerShell tab is unverified. All are field items.
- **Undocumented agy hook behavior.** Console inheritance and the `cmd /c` launch are not documented by
  agy. If they change, the fallback is `FreeConsole` followed by `AttachConsole(MAST_SHELL_PID)`, which
  is not implemented.
- **Hook version.** The hook always comes from the latest release, not from the release that
  `MAST_DOWNLOAD_URL` pins. No version pairing exists.
- **Unsigned binaries.** `mast.exe` and `mast-agy-hook.exe` are unsigned, as in ADR-0033. SmartScreen and
  Smart App Control can block either one.
- **Commands.** In PowerShell mode `mast update` is the only command that runs. `mast layout`, `ls`,
  `send`, `open`, `diff` and `config` return the error.
- **Restart and mode changes.** The mode is decided from `windowsShell` at boot, and it is a process-wide
  value, so a change needs a full restart of mast.
- **Gates confirmed by code reading only.** `ensure_provisioned`, `warm_wsl` and `release_tab_files`
  have no automated test, because the mode is process-global and a test cannot switch it without
  breaking WSL-mode tests in the same binary. Their `wsl.exe` reachability rests on the call-site
  reading in decision 6.
- **Reboot and shutdown.** Not verified for PowerShell tabs: the exit code a tab records when Windows
  shuts down, and whether the tab comes back after the next boot (ADR-0010, ADR-0018).
- **ARM64.** Built by CI but not checked (user decision).
- **macOS.** Not compiled on the development PC. The Windows-only code is behind `cfg`, and the macOS
  path is intended to be unchanged.
- **Encoded PowerShell launch.** Tabs start `powershell.exe -EncodedCommand`. Corporate endpoint
  protection (EDR) or Attack Surface Reduction rules may block that launch. Not checked on a managed PC.
- **Reload after an invalid settings edit.** If `settings.json` is edited into an invalid state while mast
  runs, `get_ui_settings` returns an error. The frontend then does not apply `windowsShell`, so the reloaded
  page shows the WSL-only entry points (folder browser, Git Changes) until the next start. The tabs keep the
  boot mode.
- **Install helper.** The installer's behavior under PowerShell 5.1 rests on the local smoke cases and
  `scripts/win/tests/test_install.py`, both listed under Verification. No real install on a device has
  been done.
- **Constrained Language Mode.** Not checked. Where AppLocker or WDAC sets PowerShell to Constrained
  Language Mode, the script's .NET calls (`[Console]::Write`, `[Console]::Title`, `[Text.Encoding]`) may
  be refused, and the start marker would not be sent. Whether the target PCs use such a policy is
  unknown, so check on a managed PC before relying on the mode there.

## Related

- [ADR-0007](0007-keyboard-model.md) keyboard model; `Ctrl+Shift+B` is the folder-browser shortcut.
- [ADR-0009](0009-startup-marker-and-spawn-deadline.md) start marker and spawn deadline.
- [ADR-0010](0010-restart-dead-terminal-tabs.md) and [ADR-0018](0018-exited-tab-as-terminal-record.md)
  restart and record of tabs whose shell exited, including exits caused by Windows shutdown.
- [ADR-0011](0011-tab-cwd-tracking.md) cwd tracking through OSC 7.
- [ADR-0022](0022-read-only-git-changes-viewer.md) Git changes viewer, refused in this mode.
- [ADR-0026](0026-tab-agent-state-and-hook-signals.md) agent state and hook signals.
- [ADR-0033](0033-unsigned-releases-installed-by-script.md) unsigned releases installed by script.
