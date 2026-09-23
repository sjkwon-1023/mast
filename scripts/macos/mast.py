#!/usr/bin/env python3
"""Native Mast CLI. Same OSC contract as WSL, without GNU tools or a daemon."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

BIN = Path(__file__).resolve().parent
HELP = """usage:
  mast ls                           list this workspace's tabs
  mast send [-l] <target> <text...>   type into another tab (-l: do not submit)
  mast id                           print this tab's stable ID
  mast config [get|set|reset ...]     inspect or change saved settings
  mast skill-load                   reinstall the bundled agent skills

Quote numeric addresses: mast send '#176' 'cargo test'. Sends stay in this
workspace and never target their sender. No agent command runs automatically
on restart. Agent sandboxes may require permission to access the real TTY and
shared /tmp; sandboxed sends cannot guarantee delivery.
"""


def hooks():
    spec = importlib.util.spec_from_file_location("mast_hook", BIN / "mast-agent-hook.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def emit(payload):
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    module = hooks()
    fd = module.open_terminal()
    if fd is None:
        return False
    try:
        result = module.write_bytes(fd, payload, module.WRITE_SECONDS)
        if result == "timeout":
            module.write_bytes(fd, b"\x07", module.BEL_SECONDS)
        return result == "ok"
    finally:
        os.close(fd)


def encode(text):
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def flat(value, limit):
    # Titles are untrusted terminal output, not executable terminal markup.
    return " ".join(re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", str(value)).split())[:limit]


def commands_by_tty():
    """A single on-demand ps snapshot, never a background process monitor."""
    try:
        result = subprocess.run(
            ["/bin/ps", "-axo", "pid=,pgid=,tpgid=,tty=,comm="],
            capture_output=True, text=True, timeout=1, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    commands = {}
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 4)
        if len(fields) != 5:
            continue
        pid, pgid, foreground, tty, command = fields
        if pgid == foreground and pid == pgid:
            commands["/dev/" + tty] = os.path.basename(command)
    return commands


def list_tabs(args):
    if args:
        raise ValueError("usage: mast ls")
    # Keep /tmp literal: the OSC reply-path contract is /tmp, not $TMPDIR or
    # canonical /private/tmp. The unpredictable 0700 directory owns the reply.
    directory = Path(tempfile.mkdtemp(prefix="mast-query-", dir="/tmp"))
    reply = directory / "tabs.json"
    try:
        emit(("\x1b]777;mast-query;list-tabs;%s\x07" % encode(str(reply))).encode())
        deadline = time.monotonic() + 2
        while not reply.exists():
            if time.monotonic() >= deadline:
                raise ValueError("no reply from Mast (not in a Mast tab, or sandbox blocked the TTY)")
            time.sleep(0.05)
        with reply.open("rb") as handle:
            data = handle.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError("reply exceeded 4 MiB")
        document = json.loads(data)
        process_names = commands_by_tty()
        rows = [["TAB", "TITLE", "WORKSPACE", "STATUS", "COMMAND"]]
        for tab in document["tabs"]:
            number = tab.get("tab")
            own = number == document.get("self_tab")
            command = "-"
            if tab.get("status") == "running" and not own:
                command = process_names.get(document.get("ttys", {}).get(str(number)), "?")
                if command in ("zsh", "bash"):
                    command = "-"
            rows.append([
                "#%s%s" % (number, " *" if own else ""),
                flat(tab.get("title", ""), 32), flat(tab.get("workspaceName", ""), 20),
                flat(tab.get("status", ""), 12), flat(command, 40),
            ])
        widths = [max(len(row[i]) for row in rows) for i in range(5)]
        for row in rows:
            print("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip())
    finally:
        shutil.rmtree(directory)


def send(args):
    submit = True
    if args and args[0] in ("-l", "--literal"):
        submit, args = False, args[1:]
    elif args and args[0] == "--":
        args = args[1:]
    elif args and args[0].startswith("-"):
        raise ValueError("unknown send option: " + args[0])
    if len(args) < 2:
        raise ValueError("usage: mast send [-l] <target> <text...>")
    target, text = args[0], " ".join(args[1:])
    if not target or re.search(r"[;\x00-\x1f\x7f-\x9f]", target):
        raise ValueError("target must not contain semicolons or control characters")
    if len(text.encode("utf-8")) > 24 * 1024:
        raise ValueError("send text exceeds 24 KiB; split it into smaller messages")
    def write(value):
        emit(("\x1b]777;mast-send;%s;%s\x07" % (target, encode(value))).encode("utf-8"))
    if text:
        write(text)
    if submit:
        time.sleep(0.2)
        write("\r")


def main(args):
    if not args or args[0] in ("help", "--help", "-h"):
        print(HELP)
        return 0 if args else 2
    command, rest = args[0], args[1:]
    if command == "ls":
        list_tabs(rest)
    elif command == "send":
        send(rest)
    elif command == "id":
        if rest or not re.fullmatch(r"[0-9]+", os.environ.get("MAST_TAB", "")):
            raise ValueError("mast id needs a Mast tab and no arguments")
        print(os.environ["MAST_TAB"])
    elif command in ("config", "skill-load"):
        script = "mast-config.py" if command == "config" else "mast-setup.py"
        if command == "skill-load":
            if rest:
                raise ValueError("usage: mast skill-load")
            rest = ["--skills-only"]
        os.execv(sys.executable, [sys.executable, str(BIN / script)] + rest)
    else:
        raise ValueError("unknown command: " + command)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print("mast: " + str(error), file=sys.stderr)
        sys.exit(1)
