#!/usr/bin/env python3
"""Mast의 현재 워크스페이스 브라우저 탭을 기존 OSC 질의 채널로 제어한다."""
import argparse
import base64
import json
import os
from pathlib import Path
import tempfile
import time

MAX_REPLY = 24 * 1024 * 1024


def parser():
    root = argparse.ArgumentParser(prog="mast browser")
    sub = root.add_subparsers(dest="action", required=True)
    sub.add_parser("list")
    p = sub.add_parser("open")
    p.add_argument("url", nargs="?", default="")
    p.add_argument("--pane", type=int)
    for action in ("navigate", "back", "forward", "reload", "stop", "close", "snapshot", "screenshot", "click", "fill", "press", "scroll", "wait", "console", "errors"):
        p = sub.add_parser(action)
        p.add_argument("tab", type=lambda value: int(value[1:] if value.startswith("#") else value))
        if action == "navigate": p.add_argument("url")
        if action in ("click", "fill", "press"): p.add_argument("ref")
        if action == "fill": p.add_argument("text")
        if action == "press": p.add_argument("key")
        if action == "scroll": p.add_argument("y", type=int)
        if action == "wait":
            p.add_argument("--text", default="")
            p.add_argument("--timeout-ms", type=int, default=5000)
        if action == "screenshot": p.add_argument("--output", type=Path)
    return root


def make_request(args):
    values = vars(args).copy()
    request = {key: values.pop(key) for key in ("action", "tab", "pane", "url") if key in values}
    values.pop("output", None)
    if "timeout_ms" in values:
        if not 0 < values["timeout_ms"] <= 10000: raise ValueError("timeout must be 1..10000 ms")
        values["timeoutMs"] = values.pop("timeout_ms")
    request["args"] = values
    return request


def query(request):
    if not os.environ.get("MAST"): raise ValueError("run inside a Mast terminal")
    payload = json.dumps(request, ensure_ascii=False).encode()
    if len(payload) > 32768: raise ValueError("request exceeds 32 KiB")
    with tempfile.TemporaryDirectory(prefix="mast-browser-", dir="/tmp") as directory:
        reply = Path(directory) / "reply.json"
        sequence = b"\x1b]777;mast-query;browser:" + base64.b64encode(payload) + b";" + base64.b64encode(str(reply).encode()) + b"\x07"
        with open("/dev/tty", "wb", buffering=0) as tty:
            tty.write(sequence)
        deadline = time.monotonic() + 60
        while not reply.exists():
            if time.monotonic() >= deadline: raise TimeoutError("Mast did not reply within 60 seconds")
            time.sleep(0.05)
        with reply.open("rb") as file:
            raw = file.read(MAX_REPLY + 1)
        if len(raw) > MAX_REPLY: raise ValueError("browser reply exceeds 24 MiB")
        response = json.loads(raw)
        if "error" in response: raise ValueError(json.dumps(response["error"], ensure_ascii=False))
        return response["result"]


def save_screenshot(result, output):
    data = base64.b64decode(result["data"], validate=True)
    if not data.startswith(b"\x89PNG\r\n\x1a\n"): raise ValueError("invalid PNG screenshot")
    if output is None:
        fd, name = tempfile.mkstemp(prefix="mast-browser-", suffix=".png", dir="/tmp")
        with os.fdopen(fd, "wb") as file: file.write(data)
        output = Path(name)
    else:
        with output.open("xb") as file: file.write(data)
    return {"path": str(output.resolve()), "bytes": len(data)}


def main():
    args = parser().parse_args()
    try:
        result = query(make_request(args))
        if args.action == "screenshot": result = save_screenshot(result, args.output)
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, TimeoutError, KeyError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == "__main__": main()
