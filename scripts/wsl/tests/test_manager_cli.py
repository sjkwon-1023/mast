#!/usr/bin/env python3
"""mast-manager.py의 관리자 query·`mast manager workspaces|events|patch` 테스트.

실제 mast 없이 송신 함수를 가짜로 바꾼다. 가짜는 보낸 바이트에서 회신 경로를
디코드해 테스트가 준비한 회신 JSON을 그 경로에 쓴다. macOS·Linux 공용이며
`apps/mast/tests/manager-python.test.ts`의 CI 래퍼가 이 스위트를 돌린다.
"""

import base64
import contextlib
import fcntl
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
NOW = "2026-09-25T03:00:00Z"
OSC_PREFIX = b"\x1b]777;mast-query;manager:"
MANAGER_ANCHOR = {
    "agent": "manager",
    "session_id": None,
    "tab": 6,
    "line_start": 0,
    "line_end": 0,
    "message_id": None,
}


def load_cli():
    spec = importlib.util.spec_from_file_location("mast_manager_cli_test", CLI_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CLI = load_cli()


def encode(text):
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


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

    def task_file(self, root_path="/home/u/projects/x", distro="Ubuntu-24.04"):
        return CLI.task_path(self.manager_dir, CLI.task_key(root_path, distro))


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
        for name in ("start", "workspaces", "events", "patch"):
            self.assertIn(name, text)
        self.assertIn(
            "The manager-tab check prevents mistakes; it is not a security boundary.",
            " ".join(text.split()),
        )


class PatchTest(CliTestCase):
    def patch(self, argv, patch_doc, workspaces=None, **kwargs):
        if workspaces is None:
            workspaces = (TARGET, MANAGER_WORKSPACE, NO_ROOT_WORKSPACE)
        return self.run_cli(argv, {"result": overview(*workspaces)}, stdin=json.dumps(patch_doc), **kwargs)

    def test_success_creates_the_file_with_a_manager_anchor(self):
        patch_doc = {"ops": [
            {"op": "add", "kind": "question", "text": "CLI 질문입니다", "quote": "관리자 탭에서 기록해 줘"},
            {"op": "add", "kind": "next", "text": "CLI 할 일입니다"},
        ]}
        code, out, err, transport = self.patch(["patch", "3"], patch_doc)
        self.assertEqual(code, 0, err)
        self.assertIn("applied: add question q1", out)
        self.assertIn("applied: add next n2", out)
        self.assertNotIn("rejected:", out)
        self.assertEqual(transport.requests, [{"op": "workspaces"}])

        path = self.task_file()
        doc = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(doc["open_questions"][0]["anchor"], MANAGER_ANCHOR)
        self.assertEqual(doc["open_questions"][0]["source"], "manager")
        self.assertEqual(doc["next"][0]["text"], "CLI 할 일입니다")
        self.assertEqual(doc["meta"]["workspace_key"]["root_path"], "/home/u/projects/x")

    def test_file_option_reads_the_patch_from_a_file(self):
        patch_file = self.root / "patch.json"
        patch_file.write_text(
            json.dumps({"verdict": "update", "notify": "none", "ops": [
                {"op": "set_headline", "text": "파일에서 읽은 patch"},
            ]}),
            encoding="utf-8",
        )
        code, out, err, _ = self.run_cli(
            ["patch", "3", "--file", str(patch_file)], {"result": overview(TARGET, MANAGER_WORKSPACE)},
        )
        self.assertEqual(code, 0, err)
        self.assertIn("applied: set_headline", out)
        doc = json.loads(self.task_file().read_text(encoding="utf-8"))
        self.assertEqual(doc["headline"], "파일에서 읽은 patch")

    def test_manager_workspace_id_is_rejected(self):
        code, out, err, _ = self.patch(["patch", "9"], {"ops": [{"op": "set_title", "text": "새 제목"}]})
        self.assertEqual(code, 1)
        self.assertIn("is the manager workspace", err)
        self.assertEqual(out, "")
        self.assertFalse(self.manager_dir.exists())

    def test_workspace_without_a_root_path_is_rejected(self):
        code, out, err, _ = self.patch(["patch", "4"], {"ops": [{"op": "set_title", "text": "새 제목"}]})
        self.assertEqual(code, 1)
        self.assertIn("has no root path", err)
        self.assertEqual(out, "")
        self.assertFalse(self.manager_dir.exists())

    def test_missing_workspace_id_is_rejected(self):
        code, out, err, _ = self.patch(["patch", "99"], {"ops": [{"op": "set_title", "text": "새 제목"}]})
        self.assertEqual(code, 1)
        self.assertIn("workspace 99 is not open", err)
        self.assertEqual(out, "")
        self.assertFalse(self.manager_dir.exists())

    def test_patch_needs_a_numeric_mast_tab(self):
        for value in ("", "abc"):
            with self.subTest(value=value):
                with mock.patch.dict(os.environ, {"MAST_TAB": value}):
                    code, out, err, _ = self.patch(
                        ["patch", "3"], {"ops": [{"op": "set_title", "text": "새 제목"}]},
                    )
                self.assertEqual(code, 1)
                self.assertIn("MAST_TAB", err)
                self.assertEqual(out, "")
                self.assertFalse(self.manager_dir.exists())

    def test_archived_workspace_is_rejected(self):
        key = CLI.task_key("/home/u/projects/x", "Ubuntu-24.04")
        CLI.update_task(
            self.manager_dir, key, lambda doc: None,
            create=lambda: CLI.new_task("/home/u/projects/x", "Ubuntu-24.04", NOW),
        )
        CLI.archive_task(self.manager_dir, key, NOW)
        archived = self.manager_dir / "archive" / (key + "--20260925T030000Z.json")
        before = archived.read_bytes()
        code, out, err, _ = self.patch(["patch", "3"], {"ops": [{"op": "set_title", "text": "새 제목"}]})
        self.assertEqual(code, 1)
        self.assertIn("Resume", err)
        self.assertIn("Start fresh", err)
        self.assertEqual(out, "")
        self.assertFalse(self.task_file().exists())
        self.assertEqual(archived.read_bytes(), before)

    def test_archived_choice_check_runs_inside_the_store_lock(self):
        key = CLI.task_key("/home/u/projects/x", "Ubuntu-24.04")
        archive = self.manager_dir / "archive" / (key + "--20260925T030000Z.json")
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_text("{}", encoding="utf-8")
        real_latest = CLI._latest_archive_path
        probes = []

        def probe(manager_dir, probe_key):
            # update_task의 flock이 잡혀 있으면 새 fd의 비차단 flock이 거부된다.
            handle = os.open(str(CLI.lock_path(manager_dir)), os.O_CREAT | os.O_RDWR, 0o600)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(handle)
            probes.append(probe_key)
            return real_latest(manager_dir, probe_key)

        with mock.patch.object(CLI, "_latest_archive_path", side_effect=probe):
            code, out, err, _ = self.patch(
                ["patch", "3"], {"ops": [{"op": "set_title", "text": "새 제목"}]})
        self.assertEqual(code, 1)
        self.assertIn("Start fresh", err)
        self.assertEqual(probes, [key], "보관 검사는 락 안에서 한 번만 한다")
        self.assertFalse(self.task_file().exists())

    def test_other_distro_workspace_is_rejected(self):
        other = workspace(5, "legacy", "/home/u/projects/legacy", distro="Ubuntu-22.04")
        code, out, err, _ = self.patch(
            ["patch", "5"], {"ops": [{"op": "set_title", "text": "새 제목"}]},
            workspaces=(other, MANAGER_WORKSPACE),
        )
        self.assertEqual(code, 1)
        self.assertIn("another distro", err)
        self.assertEqual(out, "")
        self.assertFalse(self.manager_dir.exists())

    def test_missing_manager_workspace_is_rejected(self):
        code, out, err, _ = self.patch(
            ["patch", "3"], {"ops": [{"op": "set_title", "text": "새 제목"}]},
            workspaces=(TARGET,),
        )
        self.assertEqual(code, 1)
        self.assertIn("no manager workspace", err)
        self.assertEqual(out, "")
        self.assertFalse(self.manager_dir.exists())

    def test_null_distros_are_treated_as_equal(self):
        manager_null = workspace(9, "manager", "/home/u/.mast/manager", distro=None, manager=True)
        target_null = workspace(6, "native", "/home/u/projects/native", distro=None)
        code, out, err, _ = self.patch(
            ["patch", "6"], {"ops": [{"op": "set_title", "text": "새 제목"}]},
            workspaces=(target_null, manager_null),
        )
        self.assertEqual(code, 0, err)
        self.assertTrue(self.task_file("/home/u/projects/native", None).is_file())

    def test_null_manager_distro_does_not_match_a_named_one(self):
        manager_null = workspace(9, "manager", "/home/u/.mast/manager", distro=None, manager=True)
        code, out, err, _ = self.patch(
            ["patch", "3"], {"ops": [{"op": "set_title", "text": "새 제목"}]},
            workspaces=(TARGET, manager_null),
        )
        self.assertEqual(code, 1)
        self.assertIn("another distro", err)
        self.assertEqual(out, "")
        self.assertFalse(self.manager_dir.exists())

    def test_partial_rejection_keeps_the_applied_ops(self):
        code, out, err, _ = self.patch(["patch", "3"], {"ops": [
            {"op": "set_title", "text": "새 제목"},
            {"op": "add", "kind": "decision", "text": "by 없는 결정", "quote": "인용문은 있지만 by가 없다"},
        ]})
        self.assertEqual(code, 1, err)
        self.assertIn("applied: set_title", out)
        self.assertIn("rejected: ops[1]: decision by must be user or ai", out)
        doc = json.loads(self.task_file().read_text(encoding="utf-8"))
        self.assertEqual(doc["title"], "새 제목")
        self.assertEqual(doc["meta"]["rejected_ops"], 1)

    def test_no_change_with_ops_leaves_the_file_untouched(self):
        key = CLI.task_key("/home/u/projects/x", "Ubuntu-24.04")
        CLI.update_task(
            self.manager_dir, key, lambda doc: None,
            create=lambda: CLI.new_task("/home/u/projects/x", "Ubuntu-24.04", NOW),
        )
        path = self.task_file()
        before = path.read_bytes()
        code, out, _err, _ = self.patch(
            ["patch", "3"],
            {"verdict": "no_change", "ops": [{"op": "set_title", "text": "새 제목"}]},
        )
        self.assertEqual(code, 1)
        self.assertIn("rejected: verdict no_change cannot carry ops", out)
        self.assertEqual(path.read_bytes(), before)

    def test_whole_rejection_does_not_create_a_file(self):
        code, out, _err, _ = self.patch(["patch", "3"], {"verdict": "maybe", "ops": []})
        self.assertEqual(code, 1)
        self.assertIn("rejected: patch.verdict", out)
        self.assertFalse(self.task_file().exists())

    def test_no_change_without_ops_succeeds_without_a_file(self):
        code, out, err, _ = self.patch(["patch", "3"], {"verdict": "no_change", "notify": "none", "ops": []})
        self.assertEqual(code, 0, err)
        self.assertEqual(out, "")
        # 파일을 쓰지 않으므로 작업 파일은 만들어지지 않는다(.mast/store.lock은 락 획득이 만든다).
        self.assertFalse(self.task_file().exists())
        self.assertFalse((self.manager_dir / "tasks").exists())

    def test_invalid_patch_json_exits_1(self):
        code, out, err, transport = self.run_cli(["patch", "3"], {"result": overview(TARGET)}, stdin="{ not json")
        self.assertEqual(code, 1)
        self.assertIn("the patch must be valid JSON", err)
        self.assertEqual(out, "")
        self.assertEqual(transport.sent, [])


if __name__ == "__main__":
    unittest.main()
