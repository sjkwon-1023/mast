#!/usr/bin/env python3
"""Mast의 현재 워크스페이스 브라우저 탭을 기존 OSC 질의 채널로 제어한다."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

MAX_REPLY = 24 * 1024 * 1024


def bounded_integer(minimum, maximum):
    def parse(value):
        try:
            number = int(value)
        except ValueError as error:
            raise argparse.ArgumentTypeError("must be an integer") from error
        if not minimum <= number <= maximum:
            raise argparse.ArgumentTypeError(f"must be {minimum}..{maximum}")
        return number
    return parse


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
        if action == "screenshot":
            p.add_argument("--width", type=bounded_integer(320, 3840))
            p.add_argument("--height", type=bounded_integer(240, 2160))
            p.add_argument("--output", type=Path)
    p = sub.add_parser("eval", help="Evaluate a JavaScript expression in a browser tab",
                       epilog="Example: mast browser eval T - <<'JS' ... JS")
    p.add_argument("tab", type=lambda value: int(value[1:] if value.startswith("#") else value))
    p.add_argument("expression", help="JavaScript expression; use - to read stdin, or -- before an expression starting with -")
    p.add_argument("--timeout-ms", type=int, default=5000)
    return root


def parse_args(argv=None):
    root = parser()
    args = root.parse_args(argv)
    if args.action == "screenshot" and args.height is not None and args.width is None:
        root.error("--height requires --width")
    return args


def make_request(args):
    values = vars(args).copy()
    request = {key: values.pop(key) for key in ("action", "tab", "pane", "url") if key in values}
    values.pop("output", None)
    if request.get("action") == "screenshot":
        width = values.pop("width", None)
        height = values.pop("height", None)
        if width is not None:
            values["width"] = width
            if height is not None:
                values["height"] = height
    if request.get("action") == "eval":
        expression = values.get("expression")
        if expression == "-": expression = sys.stdin.read()
        if not isinstance(expression, str) or not expression.strip():
            raise ValueError("expression must not be empty")
        values["expression"] = expression
    if "timeout_ms" in values:
        if not 0 < values["timeout_ms"] <= 10000: raise ValueError("timeout must be 1..10000 ms")
        values["timeoutMs"] = values.pop("timeout_ms")
    request["args"] = values
    return request


def _query_once(request, deadline):
    if not os.environ.get("MAST"): raise ValueError("run inside a Mast terminal")
    payload = json.dumps(request, ensure_ascii=False).encode()
    if len(payload) > 32768: raise ValueError("request exceeds 32 KiB")
    with tempfile.TemporaryDirectory(prefix="mast-browser-", dir="/tmp") as directory:
        reply = Path(directory) / "reply.json"
        sequence = b"\x1b]777;mast-query;browser:" + base64.b64encode(payload) + b";" + base64.b64encode(str(reply).encode()) + b"\x07"
        with open("/dev/tty", "wb", buffering=0) as tty:
            if deadline <= time.monotonic(): raise TimeoutError("Mast did not reply before the request deadline")
            tty.write(sequence)
        while not reply.exists():
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError("Mast did not reply before the request deadline")
            time.sleep(min(0.05, remaining))
        with reply.open("rb") as file:
            raw = file.read(MAX_REPLY + 1)
        if len(raw) > MAX_REPLY: raise ValueError("browser reply exceeds 24 MiB")
        response = json.loads(raw)
        if "error" in response: raise ValueError(json.dumps(response["error"], ensure_ascii=False))
        return response["result"]


def _valid_eval_token(token):
    return isinstance(token, str) and len(token) == 43 and re.fullmatch(r"[A-Za-z0-9_-]{43}", token) is not None


def query(request):
    if request.get("action") == "eval":
        token = _query_once({"action": "eval-token", "args": {}}, time.monotonic() + 10)
        if not _valid_eval_token(token): raise ValueError("Mast returned an invalid eval token")
        request = {**request, "args": {**request["args"], "token": token}}
    return _query_once(request, time.monotonic() + 60)


def save_screenshot(result, output):
    data = base64.b64decode(result["data"], validate=True)
    if not data.startswith(b"\x89PNG\r\n\x1a\n"): raise ValueError("invalid PNG screenshot")
    if output is None:
        fd, name = tempfile.mkstemp(prefix="mast-browser-", suffix=".png", dir="/tmp")
        with os.fdopen(fd, "wb") as file: file.write(data)
        output = Path(name)
    else:
        with output.open("xb") as file: file.write(data)
    saved = {"path": str(output.resolve()), "bytes": len(data)}
    if "width" in result and "height" in result:
        saved["width"] = result["width"]
        saved["height"] = result["height"]
    return saved


def main():
    args = parse_args()
    try:
        result = query(make_request(args))
        if args.action == "screenshot": result = save_screenshot(result, args.output)
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, TimeoutError, KeyError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == "__main__": main()
