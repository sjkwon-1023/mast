#!/usr/bin/env python3
"""mast-manager.py의 관리자 query·`mast manager workspaces|events` 테스트.

실제 mast 없이 송신 함수를 가짜로 바꾼다. 가짜는 보낸 바이트에서 회신 경로를
디코드해 테스트가 준비한 회신 JSON을 그 경로에 쓴다. macOS·Linux 공용이며
`apps/mast/tests/manager-python.test.ts`의 CI 래퍼가 이 스위트를 돌린다.
"""

import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
CLI_PATH = ROOT / "scripts" / "wsl" / "mast-manager.py"
OSC_PREFIX = b"\x1b]777;mast-query;manager:"


def load_cli():
    spec = importlib.util.spec_from_file_location("mast_manager_cli_test", CLI_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CLI = load_cli()


def workspace(workspace_id, name, root_path, distro="Ubuntu-24.04", manager=False):
    return {
        "id": workspace_id,
        "name": name,
        "rootPath": root_path,
        "distro": distro,
        "manager": manager,
        "agentStatus": "idle",
        "tabs": [],
    }


TARGET = workspace(3, "feature-x", "/home/u/projects/x")
MANAGER_WORKSPACE = workspace(9, "manager", "/home/u/.mast/manager", manager=True)
NO_ROOT_WORKSPACE = workspace(4, "phone", None, distro=None)


def overview(*workspaces):
    return {"nextSeq": 10, "workspaces": list(workspaces)}


class FakeTransport:
    """OSC 송신을 가로채 회신 경로를 풀고 준비된 회신을 쓴다. reply=None이면 무응답."""

    def __init__(self, reply):
        self.reply = reply
        self.sent = []
        self.requests = []
        self.reply_paths = []

    def __call__(self, payload):
        self.sent.append(payload)
        assert payload.startswith(OSC_PREFIX), payload
        assert payload.endswith(b"\x07"), payload
        body = payload[len(OSC_PREFIX):-1].decode("ascii")
        request_b64, reply_b64 = body.split(";")
        self.requests.append(json.loads(base64.b64decode(request_b64).decode("utf-8")))
        reply_path = base64.b64decode(reply_b64).decode("utf-8")
        self.reply_paths.append(reply_path)
        if self.reply is not None:
            Path(reply_path).write_text(json.dumps(self.reply), encoding="utf-8")
        return True


@contextlib.contextmanager
def without_env(*names):
    with mock.patch.dict(os.environ):
        for name in names:
            os.environ.pop(name, None)
        yield


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manager_dir = self.root / "manager"
        patcher = mock.patch.dict(os.environ, {
            "MAST": "1",
            "MAST_TAB": "6",
            "MAST_MANAGER_DIR": str(self.manager_dir),
        })
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_with_transport(self, argv, transport, stdin=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(CLI, "emit_osc", transport):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                if stdin is None:
                    code = CLI.main(argv)
                else:
                    with mock.patch.object(sys, "stdin", io.StringIO(stdin)):
                        code = CLI.main(argv)
        return code, stdout.getvalue(), stderr.getvalue(), transport

    def run_cli(self, argv, reply, stdin=None):
        return self.run_with_transport(argv, FakeTransport(reply), stdin=stdin)


class QueryTest(CliTestCase):
    def test_missing_mast_exits_1(self):
        with without_env("MAST"):
            code, out, err, transport = self.run_cli(["workspaces"], {"result": overview()})
        self.assertEqual(code, 1)
        self.assertIn("run inside a Mast terminal", err)
        self.assertEqual(out, "")
        self.assertEqual(transport.sent, [])

    def test_terminal_write_failure_exits_1(self):
        code, out, err, _ = self.run_with_transport(["workspaces"], lambda payload: False)
        self.assertEqual(code, 1)
        self.assertIn("cannot query Mast: terminal write failed (check TTY permissions)", err)
        self.assertEqual(out, "")

    def test_forbidden_reply_exits_1(self):
        code, out, err, _ = self.run_cli(
            ["workspaces"],
            {"error": {
                "code": "forbidden",
                "message": "the requesting tab is not in a manager workspace",
            }},
        )
        self.assertEqual(code, 1)
        self.assertIn("forbidden: the requesting tab is not in a manager workspace", err)
        self.assertIn("this tab is not in the manager workspace", err)
        self.assertEqual(out, "")

    def test_timeout_exits_1_without_a_reply(self):
        with mock.patch.multiple(CLI, QUERY_SECONDS=0.02, QUERY_POLL_SECONDS=0.002):
            code, out, err, transport = self.run_cli(["workspaces"], None)
        self.assertEqual(code, 1)
        self.assertIn("no reply from Mast", err)
        self.assertIn("sandbox blocked the TTY", err)
        self.assertEqual(out, "")
        self.assertEqual(len(transport.sent), 1)

    def test_workspaces_sends_the_contract_osc_and_prints_the_result(self):
        result = overview(TARGET, MANAGER_WORKSPACE, NO_ROOT_WORKSPACE)
        code, out, err, transport = self.run_cli(["workspaces"], {"result": result})
        self.assertEqual(code, 0, err)
        self.assertEqual(err, "")
        self.assertEqual(out, json.dumps(result, ensure_ascii=False, indent=2) + "\n")

        self.assertEqual(len(transport.sent), 1)
        reply_path = transport.reply_paths[0]
        self.assertTrue(reply_path.startswith("/tmp/"), reply_path)
        self.assertFalse(Path(reply_path).exists(), "임시 디렉터리는 끝나면 지운다")
        expected = (
            OSC_PREFIX
            + base64.b64encode(b'{"op":"workspaces"}')
            + b";"
            + base64.b64encode(reply_path.encode("utf-8"))
            + b"\x07"
        )
        self.assertEqual(transport.sent[0], expected)
        self.assertEqual(transport.requests, [{"op": "workspaces"}])

    def test_events_passes_since_and_prints_the_result(self):
        events = {"events": [], "nextSeq": 7, "gap": False}
        code, out, err, transport = self.run_cli(["events", "--since", "7"], {"result": events})
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out), events)
        self.assertEqual(transport.requests, [{"op": "events", "since": 7}])

    def test_events_defaults_since_to_zero(self):
        code, _out, err, transport = self.run_cli(
            ["events"], {"result": {"events": [], "nextSeq": 0, "gap": False}},
        )
        self.assertEqual(code, 0, err)
        self.assertEqual(transport.requests, [{"op": "events", "since": 0}])

    def test_negative_since_is_rejected_locally(self):
        code, out, err, transport = self.run_cli(
            ["events", "--since", "-1"], {"result": overview()},
        )
        self.assertEqual(code, 1)
        self.assertIn("--since must be a non-negative integer", err)
        self.assertEqual(out, "")
        self.assertEqual(transport.sent, [])

    def test_help_lists_the_subcommands_and_the_gate_note(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as raised:
            CLI.main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        text = out.getvalue()
        for name in ("start", "workspaces", "events"):
            self.assertIn(name, text)
        self.assertNotIn("patch", text)
        self.assertIn(
            "The manager-tab check prevents mistakes; it is not a security boundary.",
            " ".join(text.split()),
        )


if __name__ == "__main__":
    unittest.main()
