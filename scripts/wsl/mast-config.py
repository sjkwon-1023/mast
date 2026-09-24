#!/usr/bin/env python3
"""mast의 저장된 Windows 설정을 수정한다. 실행 중인 앱에는 요청하지 않는다."""

import copy
import json
import math
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

MAX_BYTES = 1024 * 1024
DEFAULT_PORT = 7331
LANGUAGES = ["css", "html", "javascript", "json", "python", "rust", "toml", "typescript"]
KEYS = {"fontFamily", "fontSize", "highlightLanguages", "log", "remote", "remote.port", "showTabIds", "browser", "browser.enabled"}
DEFAULTS = {
    "fontFamily": "terminal: Consolas, 'Cascadia Mono', monospace; viewers: monospace",
    "fontSize": "terminal: 13px; viewers: 12px",
    "highlightLanguages": LANGUAGES,
    "log": False,
    "browser": {"enabled": True},
    "browser.enabled": True,
    "remote": False,
    "remote.port": "none while remote is off; set remote defaults to 7331",
    "showTabIds": True,
}
HELP = """usage:
  mast config                         show saved overrides, defaults and help
  mast config get [key]                inspect saved settings (not running state)
  mast config set browser.enabled <true|false>
  mast config set fontFamily <name>
  mast config set fontSize <6-72>
  mast config set highlightLanguages '["python","rust"]'
  mast config set log <true|false>
  mast config set showTabIds <true|false>
  mast config set remote [true|false] [--port <1024-65535>]
  mast config set remote.port <1024-65535>
  mast config reset <key>              remove an override; reset remote disables it

set remote enables port 7331 unless --port is given. false cannot take a port.
showTabIds defaults to true; set it to false to hide the #id badges on tab titles.
Changes require a full mast restart, which ends running terminal processes.
Ctrl+Shift+R only reloads the window. No command restarts mast automatically.
"""


def integer(value, low, high, name):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{name} must be an integer from {low} to {high}")


if sys.platform == "darwin":
    KEYS.update(("shell", "macOptionIsMeta"))
    DEFAULTS["shell"] = "macOS account login shell (zsh or bash)"
    DEFAULTS["macOptionIsMeta"] = False
    DEFAULTS["fontFamily"] = "terminal: Menlo, 'SFMono-Regular', monospace; viewers: monospace"
    HELP += ("\nmacOS: mast config set shell /bin/zsh (or /bin/bash); restart to apply.\n"
             "macOS: mast config set macOptionIsMeta <true|false> makes Option send Meta (ESC) "
             "instead of typing special characters; restart to apply.\n")


def validate(data):
    if not isinstance(data, dict):
        raise ValueError("settings must be a JSON object")
    if sys.platform == "darwin" and data.get("shell") is not None:
        shell = data["shell"]
        if not isinstance(shell, str) or not shell.startswith("/") or "\0" in shell or Path(shell).name not in ("zsh", "bash"):
            raise ValueError("shell must be an absolute zsh or bash executable path")
    family = data.get("fontFamily")
    if family is not None and (not isinstance(family, str) or not family.strip()):
        raise ValueError("fontFamily must be a non-blank string")
    if data.get("fontSize") is not None:
        integer(data["fontSize"], 6, 72, "fontSize")
    if data.get("log") is not None and type(data["log"]) is not bool:
        raise ValueError("log must be true or false")
    if data.get("showTabIds") is not None and type(data["showTabIds"]) is not bool:
        raise ValueError("showTabIds must be true or false")
    # 앱(Rust UiSettings)은 모든 플랫폼에서 이 키의 타입을 검사하므로 읽기 검증도 플랫폼과 무관하다.
    if data.get("macOptionIsMeta") is not None and type(data["macOptionIsMeta"]) is not bool:
        raise ValueError("macOptionIsMeta must be true or false")
    languages = data.get("highlightLanguages")
    if languages is not None and (
        not isinstance(languages, list)
        or any(not isinstance(item, str) or item not in LANGUAGES for item in languages)
    ):
        raise ValueError("highlightLanguages must be an array of: " + ", ".join(LANGUAGES))
    browser = data.get("browser")
    if browser is not None and (not isinstance(browser, dict) or type(browser.get("enabled")) is not bool):
        raise ValueError("browser must be an object with boolean enabled")
    remote = data.get("remote")
    if remote is not None:
        if not isinstance(remote, dict) or "port" not in remote:
            raise ValueError("remote must be an object with a port")
        integer(remote["port"], 1024, 65535, "remote.port")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key!r}")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError(f"invalid JSON constant: {value}")


def finite_float(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("JSON number is outside the finite range")
    return value


def parse(text):
    data = json.loads(text, object_pairs_hook=unique_object, parse_constant=reject_constant,
                      parse_float=finite_float)
    # Python은 단독 surrogate escape를 허용하지만 Rust의 JSON reader는 거부한다.
    json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
    return data


def read_settings(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {}, None
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("settings must be a regular file, not a symlink or special file")
    # FIFO로 바뀌어도 open에서 멈추지 않고, 심볼릭 링크 교체도 따라가지 않는다.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("settings must be a regular file")
        raw = handle.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("settings exceed the 1 MiB limit")
    data = parse(raw.decode("utf-8"))
    validate(data)
    return data, stat.S_IMODE(info.st_mode)


def boolean(text):
    if text not in ("true", "false"):
        raise ValueError("expected true or false")
    return text == "true"


def number(text):
    if not text.isascii() or not text.isdecimal():
        raise ValueError("expected an integer")
    return int(text)


def mutation(args):
    if len(args) < 2 or args[0] not in ("set", "reset") or args[1] not in KEYS:
        raise ValueError("expected set/reset and a known setting; use mast config --help")
    action, key, *values = args
    if action == "reset":
        if values or key == "remote.port":
            raise ValueError("reset takes one top-level key; use reset remote to disable it")
        return "browser" if key == "browser.enabled" else key, None, True
    if key in ("browser", "browser.enabled"):
        if len(values) != 1:
            raise ValueError("set browser.enabled requires true or false")
        return "browser", {"enabled": boolean(values[0])}, False
    if key == "remote":
        enabled, port = True, DEFAULT_PORT
        if values and values[0] in ("true", "false"):
            enabled = boolean(values.pop(0))
        if values:
            if not enabled or len(values) != 2 or values[0] != "--port":
                raise ValueError("expected remote [true|false] [--port N]; false cannot take a port")
            port = number(values[1])
        integer(port, 1024, 65535, "remote.port")
        return key, port, not enabled
    if len(values) != 1:
        raise ValueError(f"set {key} requires exactly one value")
    text = values[0]
    value = (number(text) if key in ("fontSize", "remote.port") else
             boolean(text) if key in ("log", "showTabIds", "macOptionIsMeta") else
             parse(text) if key == "highlightLanguages" else text)
    # null은 파일에서는 미설정으로 읽지만, CLI는 reset으로 의도를 명시한다.
    if key == "highlightLanguages" and not isinstance(value, list):
        raise ValueError("highlightLanguages must be a JSON array")
    validate({"remote": {"port": value}} if key == "remote.port" else {key: value})
    # shell 키는 macOS 에만 있다. 실행 가능 여부는 새 값을 저장할 때만 확인한다 — 읽기에도 쓰이는
    # validate() 에 넣으면 저장된 셸이 지워진 뒤 reset 이나 올바른 set 으로도 복구할 수 없게 된다.
    if key == "shell" and not (os.path.isfile(value) and os.access(value, os.X_OK)):
        raise ValueError("shell must be an existing file the current user can execute: " + value)
    return key, value, False


def update(path, change):
    key, value, remove = change
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_name(path.name + ".lock")
    try:
        lock.mkdir()
    except FileExistsError:
        raise ValueError(f"settings are busy: {lock}; if a writer was killed, confirm it has stopped before removing the empty lock directory") from None
    temporary = None
    try:
        data, mode = read_settings(path)
        updated = copy.deepcopy(data)
        if remove:
            updated.pop(key, None)
        elif key == "browser":
            browser = updated.get("browser") or {}
            browser["enabled"] = value["enabled"]
            updated["browser"] = browser
        elif key in ("remote", "remote.port"):
            remote = updated.get("remote") or {}
            remote["port"] = value
            updated["remote"] = remote
        else:
            updated[key] = value
        validate(updated)
        # UTF-8 인코딩까지 교체 전에 마쳐 잘못된 유니코드도 원본을 덮지 못하게 한다.
        content = (json.dumps(updated, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode("utf-8")
        if len(content) > MAX_BYTES:
            raise ValueError("updated settings exceed the 1 MiB limit")
        fd, temporary = tempfile.mkstemp(prefix=".mast-settings-", suffix=".tmp", dir=path.parent)
        with os.fdopen(fd, "wb") as handle:
            if mode is not None:
                os.fchmod(handle.fileno(), mode)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        try:
            if temporary is not None:
                os.unlink(temporary)
        finally:
            lock.rmdir()


def execute(args, path):
    if args in (["--help"], ["-h"], ["help"]):
        print(HELP)
        return
    if not args or args[0] == "get":
        if len(args) > 2 or (len(args) == 2 and args[1] not in KEYS):
            raise ValueError("get accepts one optional known setting name")
        data, _ = read_settings(path)
        print("Settings file: " + json.dumps(str(path)))
        if len(args) == 2:
            key = args[1]
            value = (data.get("remote") or {}).get("port") if key == "remote.port" else data.get(key)
            if key == "browser.enabled": value = (data.get("browser") or {}).get("enabled")
            print(json.dumps({"key": key, "saved": value, "default": DEFAULTS[key]}, indent=2))
        else:
            print("Saved overrides (not running state):")
            print(json.dumps(data, indent=2))
            print("Built-in defaults when unset:")
            print(json.dumps(DEFAULTS, indent=2))
        if not args:
            print(HELP)
        return
    change = mutation(args)
    update(path, change)
    print("Saved settings to " + json.dumps(str(path)))
    if change[0] in ("remote", "remote.port") and not change[2]:
        print(f"Phone access will use port {change[1]} after restart. Plain HTTP: use only a trusted LAN, never public internet exposure or port forwarding.")
    print("Restart mast fully to apply changes. Restarting ends running terminal processes; finish or save work first. Ctrl+Shift+R is not enough. No restart was performed.")


def windows_settings_path():
    powershell = shutil.which("powershell.exe")
    if powershell is None:
        powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    if not os.access(powershell, os.X_OK) or shutil.which("wslpath") is None:
        raise ValueError("Windows PowerShell and wslpath are required; enable WSL interop/drive access or edit settings.json from Windows")
    command = ('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); '
               '[Environment]::GetFolderPath("ApplicationData")')
    result = subprocess.run([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
                            check=True, capture_output=True, timeout=10, encoding="utf-8")
    folder = result.stdout.strip()
    if not folder or "\n" in folder or "\r" in folder:
        raise ValueError("Windows returned an invalid Application Data path")
    result = subprocess.run(["wslpath", "-u", folder + "\\app.mast.desktop\\settings.json"],
                            check=True, capture_output=True, timeout=5, encoding="utf-8")
    path = Path(result.stdout.strip())
    if not path.is_absolute():
        raise ValueError("wslpath did not return an absolute settings path")
    return path


def main():
    args = sys.argv[1:]
    try:
        if args in (["--help"], ["-h"], ["help"]):
            print(HELP)
            return 0
        # 인자 오류를 Windows 호출보다 먼저 드러낸다.
        if args:
            if args[0] == "get":
                if len(args) > 2 or (len(args) == 2 and args[1] not in KEYS):
                    raise ValueError("get accepts one optional known setting name")
            else:
                mutation(args)
        if sys.platform == "darwin":
            path = Path(os.environ.get("MAST_CONFIG_PATH") or
                        Path.home() / "Library/Application Support/app.mast.desktop/settings.json")
        else:
            path = windows_settings_path()
        execute(args, path)
        return 0
    except (ValueError, OSError, RecursionError, subprocess.SubprocessError) as error:
        print("mast config: " + ascii(str(error)), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
