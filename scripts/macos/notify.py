#!/usr/bin/env python3
"""네이티브 알림 / Codex-notify 브리지. 실패해도 에이전트를 깨뜨리지 않는다."""
import glob
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import time

BIN = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mast_hook", BIN / "mast-agent-hook.py")
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


def save_resume(command, session):
    tab = os.environ.get("MAST_TAB", "")
    if not re.fullmatch(r"[0-9]+", tab) or not isinstance(session, str):
        return
    if not re.fullmatch(r"[A-Za-z0-9_-]+", session):
        return
    directory = Path.home() / ".mast" / "resume"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="tab-%s.tmp." % tab, dir=str(directory))
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write("%s %s\n%d\n" % (command, session, time.time()))
        os.replace(temporary, directory / ("tab-" + tab))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def ownership(thread):
    if not isinstance(thread, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", thread):
        return "unknown", False
    home = os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
    pattern = os.path.join(home, "sessions", "*", "*", "*", "rollout-*-" + thread + ".jsonl")
    verdict = "unknown"
    with hook.deadline(2):
        for path in glob.iglob(pattern):
            try:
                with open(path, "rb") as handle:
                    line = handle.readline(1024 * 1024 + 1)
                if len(line) > 1024 * 1024:
                    continue
                record = json.loads(line)
            except (OSError, ValueError):
                continue
            payload = record.get("payload", {})
            if record.get("type") != "session_meta" or payload.get("id") != thread:
                continue
            source = payload.get("source")
            if isinstance(source, dict) and ("subagent" in source or "internal" in source):
                verdict = "rejected"
                continue
            return "confirmed", source in ("cli", "exec")
    return verdict, False


def main(args):
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    if os.environ.get("MAST") != "1" or not args:
        return
    if args[0] == "codex":
        raw = args[1] if len(args) > 1 else ""
        payload = json.loads(raw)
        thread = payload.get("thread-id", payload.get("thread_id"))
        if "CLAUDECODE" in os.environ:
            return
        if os.environ.get("CODEX_THREAD_ID") and os.environ["CODEX_THREAD_ID"] != thread:
            return
        try:
            verdict, resumable = ownership(thread)
        except hook.Deadline:
            verdict, resumable = "unknown", False
        if resumable:
            save_resume("codex resume", thread)
        hook.codex_notify([verdict, raw])
    else:
        status = args[0]
        if status not in (hook.IDLE, hook.RUNNING, hook.NEEDS_INPUT):
            return
        body = args[1] if len(args) > 1 else ""
        if not sys.stdin.isatty():
            try:
                with hook.deadline(0.5):
                    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
                payload = json.loads(raw) if raw and len(raw) <= 1024 * 1024 else {}
            except (ValueError, hook.Deadline):
                payload = {}
            if isinstance(payload, dict):
                body = payload.get("message") or body
                save_resume("claude --resume", payload.get("session_id"))
        body = hook.CONTROL_RE.sub(" ", str(body)).replace(";", ",")[:500]
        hook.write_osc(status, body)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception:
        # 상태 문제는 dispatcher 가 기록한다. 알림 실패를 실패한 도구나 중단된
        # 에이전트 세션으로 드러내면 안 된다.
        pass
