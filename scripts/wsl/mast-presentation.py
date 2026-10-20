#!/usr/bin/env python3
"""mast layout / open / diff: 실행 중인 Mast 앱에 뷰어 표시를 요청한다.

성공은 result JSON 한 줄(stdout)이다. 실패는 {"error":{"code","message"}} 한 줄(stderr)이고 종료 코드 1이다.
사용법 오류는 요청을 보내지 않고 종료 코드 2로 끝난다. 전송은 mast-browser.py 의 OSC 질의 채널을 그대로 쓴다.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

MAX_REPLY = 1024 * 1024
# mast-browser.py 의 _query_once 가 이 문구로 회신 크기 초과를 알린다. 같은 문구일 때만 too_large 로 바꾼다.
TOO_LARGE_REPLY = "presentation reply exceeds 1 MiB"
DEADLINE_SECONDS = 20
MAX_ID = 2 ** 53 - 1
TIMEOUT_MESSAGE = (
    f"Mast did not reply within {DEADLINE_SECONDS} s. Likely causes: not inside mast; "
    "the app is an older version; too many requests in flight. "
    "The request may already have taken effect, so check with 'mast layout' or 'mast ls' before retrying."
)


def load_browser():
    spec = importlib.util.spec_from_file_location("mast_browser", Path(__file__).resolve().parent / "mast-browser.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


browser = load_browser()
ReplyError = browser.ReplyError


def pane_id(value):
    # `#` 과 부호는 받지 않는다. 상한은 앱의 JSON 수치가 정확히 왕복하는 2^53-1 이다.
    if re.fullmatch(r"[0-9]{1,16}", value) and 0 < int(value) <= MAX_ID:
        return int(value)
    raise argparse.ArgumentTypeError("must be a positive integer")


def parse_args(argv=None):
    root = argparse.ArgumentParser(prog="mast")
    sub = root.add_subparsers(dest="action", required=True, metavar="{layout,open,diff}")
    sub.add_parser("layout", usage="mast layout")
    subparsers = {
        "open": sub.add_parser("open", usage="mast open [--pane ID | --split ID right|down] [--] <path>"),
        "diff": sub.add_parser("diff", usage="mast diff [--pane ID | --split ID right|down] [--] [path]"),
    }
    for name, parser in subparsers.items():
        group = parser.add_mutually_exclusive_group()
        group.add_argument("--pane", type=pane_id, metavar="ID")
        group.add_argument("--split", nargs=2, metavar=("ID", "right|down"))
        parser.add_argument("path", nargs=None if name == "open" else "?")
    args = root.parse_args(argv)
    if args.action == "layout":
        return args
    parser = subparsers[args.action]
    if args.split is not None:
        number, direction = args.split
        if direction not in ("right", "down"):
            parser.error("direction must be right or down")
        try:
            args.split = (pane_id(number), direction)
        except argparse.ArgumentTypeError as error:
            parser.error(f"argument --split: {error}")
    if args.path == "":
        parser.error("path must not be empty")
    return args


def make_request(args):
    if args.action == "layout":
        return {"action": "layout"}
    # 셸을 거치지 않고 호출 cwd 기준 절대 경로를 만든다. 존재 여부와 종류는 서버가 판정한다.
    path = os.getcwd() if args.path is None else os.path.realpath(args.path)
    request = {"action": args.action, "path": path}
    if args.pane is not None:
        request["placement"] = {"pane": args.pane}
    elif args.split is not None:
        request["placement"] = {"split": {"pane": args.split[0], "direction": args.split[1]}}
    return request


def query(request):
    return browser._query_once(
        request, time.monotonic() + DEADLINE_SECONDS, kind="presentation", max_reply=MAX_REPLY
    )


def fail(error):
    print(json.dumps({"error": error}, ensure_ascii=False), file=sys.stderr)
    return 1


def main(argv=None):
    args = parse_args(argv)
    try:
        result = query(make_request(args))
    except ReplyError as error:
        return fail(error.error)
    except TimeoutError:
        return fail({"code": "timeout", "message": TIMEOUT_MESSAGE})
    except OSError as error:
        return fail({"code": "io_error", "message": str(error)})
    except (KeyError, TypeError):
        return fail({"code": "io_error", "message": "Mast returned a reply without result or error"})
    except ValueError as error:
        # 보내지 못했거나 회신을 읽지 못한 실패는 io_error 다. 계약 목록 밖의 CLI 전용 코드는 만들지 않는다.
        code = "too_large" if str(error) == TOO_LARGE_REPLY else "io_error"
        return fail({"code": code, "message": str(error)})
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
