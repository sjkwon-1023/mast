#!/usr/bin/env python3
"""mast-manager-harness.py의 하네스 루프(프로토콜·보드·시작 점검) 테스트 (macOS·Linux 공용).

`apps/mast/tests/manager-python.test.ts`의 CI 래퍼가 이 스위트를 돌린다.
하네스를 서브프로세스로 띄워 stdin에 hello/snapshot/events/action 줄을 쓰고
stdout의 status/board 줄을 `fixtures/manager-protocol.json`의 `harnessToApp` 키
집합과 함께 검사한다. 로그인 셸과 codex는 테스트가 임시 디렉터리에 만든 대역을
쓴다(레포에 실행 파일 fixture를 두지 않는다).
"""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
HARNESS_PATH = ROOT / "scripts" / "wsl" / "mast-manager-harness.py"
STORE_PATH = ROOT / "scripts" / "wsl" / "mast-manager.py"
PROTOCOL_PATH = ROOT / "fixtures" / "manager-protocol.json"
TASK_FIXTURE_PATH = ROOT / "fixtures" / "manager-task.json"
TRANSCRIPT_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "manager" / "claude-session.jsonl"

FAKE_CODEX_VERSION = "codex-cli 9.9.9-test"

# CH9의 대역처럼 argv·stdin·호출 횟수를 기록하고 준비한 patch를 -o 경로로 복사한다.
# 설정은 매 호출 `FAKE_CODEX_CONFIG` JSON에서 다시 읽어 테스트가 도중에 바꿀 수 있다.
FAKE_CODEX_SCRIPT = '''import json
import os
import shutil
import sys
import time


def main():
    argv = sys.argv[1:]
    if argv[:1] == ["--version"]:
        print("__VERSION__")
        return 0
    config = {}
    config_path = os.environ.get("FAKE_CODEX_CONFIG")
    if config_path and os.path.isfile(config_path):
        with open(config_path, "r", encoding="utf-8") as stream:
            value = json.load(stream)
        if isinstance(value, dict):
            config = value
    entry = {"argv": argv, "cwd": os.getcwd(), "stdin": sys.stdin.read(),
             "codex_home": os.environ.get("CODEX_HOME")}
    record = config.get("record")
    if record:
        with open(record, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False) + "\\n")
    pidfile = config.get("pidfile")
    if pidfile:
        with open(pidfile, "w", encoding="utf-8") as stream:
            stream.write(str(os.getpid()))
    sleep = float(config.get("sleep") or 0)
    if sleep > 0:
        time.sleep(sleep)
    targets = {}
    for index, value in enumerate(argv):
        if value in ("-o", "--output-schema") and index + 1 < len(argv):
            targets[value] = argv[index + 1]
    source = config.get("out")
    out = targets.get("-o")
    if source and out:
        shutil.copyfile(source, out)
    return int(config.get("exit") or 0)


sys.exit(main())
'''

NO_CHANGE_PATCH = {"verdict": "no_change", "notify": "none", "notify_reason": None, "ops": []}


def make_op(name, **fields):
    op = {
        "op": name,
        "kind": None,
        "id": None,
        "text": None,
        "by": None,
        "anchor_ref": None,
        "quote": None,
        "reported_done": None,
        "verified_done": None,
        "path": None,
        "goal": None,
        "steps": None,
    }
    op.update(fields)
    return op
ACTIVE_ROOT = "/home/u/p/x"
OTHER_ROOT = "/home/u/p/y"
PLAIN_ROOT = "/home/u/p/z"
SILENT_ROOT = "/home/u/p/w"
BROKEN_ROOT = "/home/u/p/broken"
ARCHIVE_ROOT = "/home/u/p/arch"
MANAGER_ROOT = "/home/u/m"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HARNESS = load_module("mast_manager_harness_loop_test", HARNESS_PATH)
STORE = load_module("mast_manager_store_for_loop_test", STORE_PATH)
PROTOCOL = json.loads(PROTOCOL_PATH.read_text(encoding="utf-8"))
TASK_FIXTURE = json.loads(TASK_FIXTURE_PATH.read_text(encoding="utf-8"))

EXPECTED_KEYS = {}
for example in PROTOCOL["harnessToApp"]:
    EXPECTED_KEYS.setdefault(example["type"], set(example))
BOARD_EXAMPLE = next(item for item in PROTOCOL["harnessToApp"] if item["type"] == "board")
BOARD_ENTRY_KEYS = set(BOARD_EXAMPLE["entries"][0])


def workspace(workspace_id, name, root_path=None, distro=None, manager=False, tabs=None):
    return {
        "id": workspace_id,
        "name": name,
        "rootPath": root_path,
        "distro": distro,
        "manager": manager,
        "agentStatus": "idle",
        "tabs": tabs if tabs is not None else [],
    }


def terminal_tab(tab_id=4, agent_session=None, last_message=None):
    return {
        "tab": tab_id,
        "title": "claude",
        "kind": "terminal",
        "status": "running",
        "agentStatus": "idle",
        "lastAgentMessage": last_message,
        "agentSession": agent_session,
    }


def claude_session(session_id="abc"):
    return {
        "agent": "claude",
        "sessionId": session_id,
        "transcriptPath": "/home/u/.claude/projects/x/%s.jsonl" % session_id,
    }


def sh_quote(value):
    return "'" + str(value).replace("'", "'\\''") + "'"


class LineStream:
    """파이프를 백그라운드 스레드로 읽어 timeout 있는 줄 단위 접근을 제공한다."""

    def __init__(self, stream):
        self.stream = stream
        self.queue = queue.Queue()
        self.thread = threading.Thread(target=self._pump, args=(stream,), daemon=True)
        self.thread.start()

    def _pump(self, stream):
        try:
            for line in iter(stream.readline, b""):
                self.queue.put(line)
        except (OSError, ValueError):
            pass
        finally:
            self.queue.put(None)

    def next_bytes(self, timeout):
        item = self.queue.get(timeout=timeout)
        if item is None:
            raise EOFError("stream closed before the next line")
        return item

    def next_json(self, timeout):
        return json.loads(self.next_bytes(timeout).decode("utf-8"))

    def close(self, timeout=1.0):
        try:
            self.stream.close()
        except (OSError, ValueError):
            pass
        self.thread.join(timeout=timeout)


class HarnessRun:
    """서브프로세스 하네스 하나. stdin 쓰기와 stdout 줄 읽기를 캡슐화한다."""

    def __init__(self, manager_dir, shell_path, extra_args=(), env_overrides=None):
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith("FAKE_CODEX_")
        }
        env["SHELL"] = str(shell_path)
        if env_overrides:
            env.update(env_overrides)
        self.proc = subprocess.Popen(
            [sys.executable, str(HARNESS_PATH)] + [str(arg) for arg in extra_args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.stdout = LineStream(self.proc.stdout)
        self.stderr_lines = LineStream(self.proc.stderr)

    def send(self, message):
        self.send_raw((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))

    def send_raw(self, data):
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def next_message(self, timeout=10.0):
        return self.stdout.next_json(timeout)

    def close_stdin(self):
        try:
            self.proc.stdin.close()
        except (OSError, ValueError):
            pass

    def wait(self, timeout=10.0):
        return self.proc.wait(timeout=timeout)

    def stop(self):
        if self.proc.poll() is None:
            self.close_stdin()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.stdout.close()
        self.stderr_lines.close()
        try:
            self.proc.stdin.close()
        except (OSError, ValueError):
            pass
        return self.proc.returncode

    def stderr_text(self, timeout=1.0):
        chunks = []
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                item = self.stderr_lines.queue.get(timeout=remaining)
            except queue.Empty:
                break
            if item is None:
                break
            chunks.append(item.decode("utf-8", "replace"))
        return "".join(chunks)


class HarnessTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.manager = self.base / "manager"
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.login_path = str(self.bin)
        self.codex_path = self.bin / "codex"
        self.shell_path = self.base / "login-shell"
        self.fake_config = self.base / "fake-config.json"
        self.fake_config.write_text("{}", encoding="utf-8")
        self.write_fake_codex()
        self.write_login_shell(str(self.codex_path))

    def write_fake_codex(self):
        script = FAKE_CODEX_SCRIPT.replace("__VERSION__", FAKE_CODEX_VERSION)
        self.codex_path.write_text("#!" + sys.executable + "\n" + script, encoding="utf-8")
        self.codex_path.chmod(0o755)

    def write_login_shell(self, codex_path=None, codex_home=None, noise=False, stdin_record=None):
        # `-lc` 인자는 무시하고 표식 줄로 PATH·CODEX_HOME을 출력한다. codex 경로는
        # 하네스가 얻은 PATH의 /bin/sh 탐색으로 찾으므로 없으면 실행 파일을 지운다.
        if codex_path is None:
            try:
                self.codex_path.unlink()
            except FileNotFoundError:
                pass
        lines = ["#!/bin/sh"]
        if stdin_record is not None:
            lines.append("cat > " + sh_quote(stdin_record))
        if noise:
            lines.append("printf '%s\\n' 'profile noise line'")
        lines.append("printf '__MAST_PATH__%s\\n' " + sh_quote(self.login_path))
        lines.append("printf '__MAST_CODEX__%s\\n' " + sh_quote(codex_path or ""))
        lines.append("printf '__MAST_CODEX_HOME__%s\\n' " + sh_quote(codex_home or ""))
        self.shell_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.shell_path.chmod(0o755)

    def start_harness(self, extra_args=(), env_overrides=None):
        env = {"FAKE_CODEX_CONFIG": str(self.fake_config)}
        if env_overrides:
            env.update(env_overrides)
        run = HarnessRun(self.manager, self.shell_path, extra_args, env)
        self.addCleanup(run.stop)
        return run

    def hello(self, protocol=1):
        return {
            "type": "hello",
            "protocol": protocol,
            "managerWorkspace": 7,
            "managerDir": str(self.manager),
            "managerDistro": "Ubuntu",
            "defaultDistro": "Ubuntu",
            "settings": {
                "model": "gpt-6-luna",
                "effort": "high",
                "summaryModel": "gpt-6-luna",
                "summaryEffort": "low",
                "idleSeconds": 1,
            },
        }

    def overview(self):
        return {
            "nextSeq": 43,
            "workspaces": [
                workspace(1, "feature-x", ACTIVE_ROOT, None),
                workspace(2, "no-root", None, None),
                workspace(3, "other", OTHER_ROOT, "Debian"),
                workspace(4, "plain", PLAIN_ROOT, None, tabs=[terminal_tab(4, claude_session())]),
                workspace(5, "silent", SILENT_ROOT, None, tabs=[terminal_tab(5)]),
                workspace(6, "broken", BROKEN_ROOT, None),
                workspace(7, "arch", ARCHIVE_ROOT, None),
                workspace(8, "manager", MANAGER_ROOT, "Ubuntu", manager=True),
            ],
        }

    def seed_task(self, root_path, distro=None, doc=None):
        if doc is None:
            doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
        path = self.manager / "tasks" / (STORE.task_key(root_path, distro) + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        return path

    def seed_archive(self, root_path, distro=None, doc=None):
        if doc is None:
            doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
        doc["meta"]["status"] = "archived"
        doc["meta"]["updated_at"] = "2026-09-25T03:00:00Z"
        key = STORE.task_key(root_path, distro)
        path = self.manager / "archive" / (key + "--20260925T030000Z.json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        return path

    def next_message(self, run, timeout=10.0):
        message = run.next_message(timeout)
        expected = EXPECTED_KEYS.get(message.get("type"))
        self.assertIsNotNone(expected, "unexpected message type: %r" % (message.get("type"),))
        self.assertEqual(set(message), expected, "key set mismatch for " + message["type"])
        return message

    def read_until(self, run, kind, timeout=10.0):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.fail("timed out waiting for a %s message" % kind)
            message = self.next_message(run, timeout=remaining)
            if message["type"] == kind:
                return message

    def expect_status(self, run, state, timeout=10.0):
        message = self.read_until(run, "status", timeout=timeout)
        self.assertEqual(message["state"], state)
        return message

    def start_ok(self, extra_args=()):
        run = self.start_harness(extra_args)
        run.send(self.hello())
        self.expect_status(run, "starting")
        self.expect_status(run, "ok")
        return run


class StartupTest(HarnessTestCase):
    def test_hello_starts_and_reports_codex_version(self):
        run = self.start_harness()
        run.send(self.hello())
        starting = self.expect_status(run, "starting")
        self.assertEqual(starting["codexVersion"], None)
        self.assertEqual(starting["logPath"], str(self.manager / "logs" / "harness.log"))

        ready = self.expect_status(run, "ok")
        self.assertEqual(ready["codexVersion"], FAKE_CODEX_VERSION)
        self.assertEqual(ready["logPath"], str(self.manager / "logs" / "harness.log"))
        self.assertEqual(ready["lastCollectedAt"], None)

        run.close_stdin()
        self.assertEqual(run.wait(), 0)

    def test_ok_reports_the_latest_collected_at(self):
        self.seed_task("/home/u/p/first", None)
        newest = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
        newest["meta"]["last_collected_at"] = "2026-09-25T05:00:00Z"
        self.seed_task("/home/u/p/second", None, doc=newest)
        run = self.start_harness()
        run.send(self.hello())
        self.expect_status(run, "starting")
        ready = self.expect_status(run, "ok")
        self.assertEqual(ready["lastCollectedAt"], "2026-09-25T05:00:00Z")

    def test_protocol_mismatch_is_unsupported_and_exits_3(self):
        run = self.start_harness()
        run.send(self.hello(protocol=2))
        message = self.next_message(run)
        self.assertEqual(message["type"], "status")
        self.assertEqual(message["state"], "unsupported")
        self.assertEqual(message["message"], "protocol mismatch")
        self.assertEqual(message["logPath"], None)
        self.assertEqual(run.wait(), 3)

    def test_missing_hello_times_out_unsupported(self):
        run = self.start_harness(["--hello-timeout", "0.3"])
        message = self.next_message(run)
        self.assertEqual(message["state"], "unsupported")
        self.assertEqual(message["message"], "protocol mismatch")
        self.assertEqual(run.wait(), 3)

    def test_codex_not_found_is_unsupported_and_exits_3(self):
        self.write_login_shell(codex_path=None)
        run = self.start_harness()
        run.send(self.hello())
        self.expect_status(run, "starting")
        message = self.expect_status(run, "unsupported")
        self.assertEqual(message["message"], "codex CLI not found in the login shell PATH")
        self.assertEqual(message["logPath"], str(self.manager / "logs" / "harness.log"))
        self.assertEqual(run.wait(), 3)

    def test_login_shell_noise_and_devnull_stdin(self):
        record = self.base / "shell-stdin.txt"
        self.write_login_shell(str(self.codex_path), noise=True, stdin_record=str(record))
        run = self.start_harness()
        run.send(self.hello())
        self.expect_status(run, "starting")
        ready = self.expect_status(run, "ok")
        self.assertEqual(ready["codexVersion"], FAKE_CODEX_VERSION)
        self.assertTrue(record.exists())
        self.assertEqual(record.read_text(encoding="utf-8"), "",
                         "자식 셸은 stdin을 읽지 않아야 한다(DEVNULL)")

    def test_second_instance_exits_5(self):
        first = self.start_ok()
        second = self.start_harness()
        second.send(self.hello())
        self.assertEqual(second.wait(), 5)
        self.assertIn("another harness instance", second.stderr_text())

        first.send({"type": "snapshot", "overview": {"nextSeq": 0, "workspaces": []}})
        board = self.read_until(first, "board")
        self.assertEqual(board["entries"], [])


class BoardTest(HarnessTestCase):
    def test_board_entries_follow_the_contract(self):
        self.seed_task(ACTIVE_ROOT, None)
        broken = self.manager / "tasks" / (STORE.task_key(BROKEN_ROOT, None) + ".json")
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text("{ not json", encoding="utf-8")
        self.seed_archive(ARCHIVE_ROOT, None)

        run = self.start_ok()
        run.send({"type": "snapshot", "overview": self.overview()})
        board = self.read_until(run, "board")

        entries = board["entries"]
        for entry in entries:
            self.assertEqual(set(entry), BOARD_ENTRY_KEYS)
        self.assertEqual([entry["workspaceId"] for entry in entries], [1, 2, 3, 4, 5, 6, 7])
        by_id = {entry["workspaceId"]: entry for entry in entries}

        self.assertEqual(by_id[1]["state"], "active")
        self.assertEqual(by_id[1]["key"], STORE.task_key(ACTIVE_ROOT, None))
        self.assertEqual(by_id[1]["task"]["title"], TASK_FIXTURE["valid"][0]["title"])
        self.assertIsNone(by_id[1]["reason"])

        self.assertEqual(by_id[2]["state"], "unsupported")
        self.assertEqual(by_id[2]["reason"], "no_root")
        self.assertIsNone(by_id[2]["key"])

        self.assertEqual(by_id[3]["state"], "unsupported")
        self.assertEqual(by_id[3]["reason"], "other_distro")
        self.assertEqual(by_id[3]["key"], STORE.task_key(OTHER_ROOT, "Debian"))

        self.assertEqual(by_id[4]["state"], "none")
        self.assertIsNone(by_id[4]["reason"])

        self.assertEqual(by_id[5]["state"], "none")
        self.assertEqual(by_id[5]["reason"], "no_transcript")

        self.assertEqual(by_id[6]["state"], "error")
        self.assertIn("invalid JSON", by_id[6]["error"])

        self.assertEqual(by_id[7]["state"], "choice")
        self.assertEqual(
            by_id[7]["archive"],
            {"count": 1, "latestClosedAt": "2026-09-25T03:00:00Z"},
        )

    def test_new_tab_events_clear_no_transcript(self):
        run = self.start_ok()
        overview = {
            "nextSeq": 5,
            "workspaces": [workspace(4, "plain", PLAIN_ROOT, None, tabs=[terminal_tab(4)])],
        }
        run.send({"type": "snapshot", "overview": overview})
        first = self.read_until(run, "board")
        self.assertEqual(first["entries"][0]["reason"], "no_transcript")

        event_workspace = {"id": 4, "name": "plain", "rootPath": PLAIN_ROOT, "distro": None}
        run.send({"type": "events", "events": [
            {
                "seq": 6, "kind": "session", "workspace": event_workspace, "tab": 9,
                "status": None, "message": None, "agentSession": claude_session("s9"),
            },
            {
                "seq": 7, "kind": "status", "workspace": event_workspace, "tab": 9,
                "status": "running", "message": "work", "agentSession": None,
            },
        ], "nextSeq": 8})
        second = self.read_until(run, "board")
        entry = second["entries"][0]
        self.assertEqual(entry["state"], "none")
        self.assertIsNone(entry["reason"], "새 탭의 세션을 overview가 알아야 한다")
        self.assertEqual(entry["task"], None)

    def test_workspace_opened_event_adds_a_board_entry(self):
        run = self.start_ok()
        run.send({"type": "snapshot", "overview": {"nextSeq": 1, "workspaces": []}})
        first = self.read_until(run, "board")
        self.assertEqual(first["entries"], [])

        run.send({"type": "events", "events": [{
            "seq": 2, "kind": "workspaceOpened",
            "workspace": {"id": 9, "name": "opened", "rootPath": PLAIN_ROOT, "distro": None},
            "tab": None, "status": None, "message": None, "agentSession": None,
        }], "nextSeq": 3})
        second = self.read_until(run, "board")
        self.assertEqual([entry["workspaceId"] for entry in second["entries"]], [9])
        self.assertEqual(second["entries"][0]["reason"], "no_transcript")

    def test_digest_body_is_not_rewritten_when_unchanged(self):
        self.seed_task(ACTIVE_ROOT, None)
        run = self.start_ok()
        run.send({"type": "snapshot", "overview": self.overview()})
        self.read_until(run, "board")
        digest = self.manager / "digest.md"
        self.assertTrue(digest.is_file())
        first_text = digest.read_text(encoding="utf-8")
        first_mtime = digest.stat().st_mtime_ns

        time.sleep(0.05)
        run.send({"type": "snapshot", "overview": self.overview()})
        self.read_until(run, "board")
        self.assertEqual(digest.stat().st_mtime_ns, first_mtime,
                         "본문이 같으면 digest.md를 다시 쓰지 않는다")
        self.assertEqual(digest.read_text(encoding="utf-8"), first_text)

        smaller = self.overview()
        smaller["workspaces"] = smaller["workspaces"][:1]
        time.sleep(0.05)
        run.send({"type": "snapshot", "overview": smaller})
        self.read_until(run, "board")
        self.assertNotEqual(digest.stat().st_mtime_ns, first_mtime)
        self.assertNotEqual(digest.read_text(encoding="utf-8"), first_text)

    def test_digest_is_written_with_the_board(self):
        self.seed_task(ACTIVE_ROOT, None)
        run = self.start_ok()
        run.send({"type": "snapshot", "overview": self.overview()})
        self.read_until(run, "board")
        digest = (self.manager / "digest.md").read_text(encoding="utf-8")
        self.assertIn("[#1 feature-x]", digest)
        self.assertIn(TASK_FIXTURE["valid"][0]["title"], digest)
        self.assertNotIn("[#8 manager]", digest)

    def test_invalid_lines_do_not_stop_the_loop(self):
        run = self.start_ok()
        run.send_raw(b"this is not json\n")
        run.send({"type": "mystery", "noise": 1})
        run.send_raw(b"x" * (HARNESS.MAX_INPUT_LINE_BYTES + 17) + b"\n")
        run.send({"type": "action", "action": "resume", "key": "k1"})
        run.send({"type": "snapshot", "overview": self.overview()})
        board = self.read_until(run, "board")
        self.assertEqual([entry["workspaceId"] for entry in board["entries"]],
                         [1, 2, 3, 4, 5, 6, 7])

    def test_events_update_the_board(self):
        run = self.start_ok()
        overview = {
            "nextSeq": 5,
            "workspaces": [workspace(4, "plain", PLAIN_ROOT, None, tabs=[terminal_tab(4)])],
        }
        run.send({"type": "snapshot", "overview": overview})
        first = self.read_until(run, "board")
        self.assertEqual(first["entries"][0]["reason"], "no_transcript")
        event_workspace = {"id": 4, "name": "plain", "rootPath": PLAIN_ROOT, "distro": None}
        run.send({"type": "events", "events": [
            {
                "seq": 6,
                "kind": "session",
                "workspace": event_workspace,
                "tab": 4,
                "status": None,
                "message": None,
                "agentSession": claude_session("s1"),
            },
            {
                "seq": 7,
                "kind": "status",
                "workspace": event_workspace,
                "tab": 4,
                "status": "running",
                "message": "working",
                "agentSession": None,
            },
        ], "nextSeq": 8})
        second = self.read_until(run, "board")
        self.assertEqual(second["entries"][0]["state"], "none")
        self.assertIsNone(second["entries"][0]["reason"])

    def test_task_change_resends_the_board(self):
        task = self.seed_task(ACTIVE_ROOT, None)
        run = self.start_ok(["--tick-seconds", "0.05", "--board-poll-seconds", "0.2"])
        run.send({"type": "snapshot", "overview": self.overview()})
        first = self.read_until(run, "board")
        by_id = {entry["workspaceId"]: entry for entry in first["entries"]}
        self.assertEqual(by_id[1]["task"]["title"], TASK_FIXTURE["valid"][0]["title"])

        doc = json.loads(task.read_text(encoding="utf-8"))
        doc["title"] = "changed title"
        task.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")

        second = self.read_until(run, "board", timeout=6.0)
        by_id = {entry["workspaceId"]: entry for entry in second["entries"]}
        self.assertEqual(by_id[1]["task"]["title"], "changed title")

    def test_log_rotation_keeps_one_previous_file(self):
        run = self.start_ok(["--log-max-bytes", "200", "--tick-seconds", "0.05"])
        for index in range(12):
            run.send({"type": "unknown-%d" % index})
        run.send({"type": "snapshot", "overview": self.overview()})
        self.read_until(run, "board")
        run.close_stdin()
        self.assertEqual(run.wait(), 0)

        log = self.manager / "logs" / "harness.log"
        rotated = self.manager / "logs" / "harness.log.1"
        self.assertTrue(rotated.is_file())
        self.assertLessEqual(log.stat().st_size, 200)
        text = rotated.read_text(encoding="utf-8") + log.read_text(encoding="utf-8")
        self.assertIn("ignored a message with unknown type", text)


class EventApplyTest(unittest.TestCase):
    def test_opened_closed_status_session_and_tab_gone(self):
        overview = {"nextSeq": 0, "workspaces": [
            {
                "id": 1,
                "name": "w",
                "rootPath": "/w",
                "distro": None,
                "manager": False,
                "agentStatus": "idle",
                "tabs": [terminal_tab(4)],
            },
        ]}
        event_workspace = {"id": 1, "name": "w", "rootPath": "/w", "distro": None}
        HARNESS._apply_event(overview, {
            "kind": "status", "workspace": event_workspace, "tab": 4,
            "status": "running", "message": "working", "agentSession": None,
        })
        tab = overview["workspaces"][0]["tabs"][0]
        self.assertEqual(tab["agentStatus"], "running")
        self.assertEqual(tab["lastAgentMessage"], "working")
        # notify 생략 판단이 읽는 live status도 탭 집계를 따라간다.
        self.assertEqual(overview["workspaces"][0]["agentStatus"], "running")

        HARNESS._apply_event(overview, {
            "kind": "session", "workspace": event_workspace, "tab": 4,
            "status": None, "message": None, "agentSession": claude_session("s2"),
        })
        self.assertEqual(tab["agentSession"], claude_session("s2"))

        HARNESS._apply_event(overview, {
            "kind": "tabGone", "workspace": event_workspace, "tab": 4,
            "status": None, "message": None, "agentSession": None,
        })
        self.assertEqual(len(overview["workspaces"][0]["tabs"]), 1,
                         "respawn도 tabGone을 내므로 탭 항목은 지우지 않는다")
        self.assertIsNone(tab["agentSession"])
        self.assertEqual(tab["agentStatus"], "idle")
        self.assertEqual(overview["workspaces"][0]["agentStatus"], "idle")

        HARNESS._apply_event(overview, {
            "kind": "workspaceClosed", "workspace": event_workspace, "tab": None,
            "status": None, "message": None, "agentSession": None,
        })
        self.assertEqual(overview["workspaces"], [])

        HARNESS._apply_event(overview, {
            "kind": "workspaceOpened",
            "workspace": {"id": 9, "name": "new", "rootPath": "/new", "distro": "Ubuntu"},
            "tab": None, "status": None, "message": None, "agentSession": None,
        })
        opened = overview["workspaces"][0]
        self.assertEqual(opened["id"], 9)
        self.assertFalse(opened["manager"])
        self.assertEqual(opened["tabs"], [])
        self.assertEqual(opened["agentStatus"], "idle")

    def test_workspace_opened_updates_existing_fields(self):
        overview = {"nextSeq": 0, "workspaces": [
            {
                "id": 1, "name": "before", "rootPath": "/old", "distro": None,
                "manager": True, "agentStatus": "idle", "tabs": [],
            },
        ]}
        HARNESS._apply_event(overview, {
            "kind": "workspaceOpened",
            "workspace": {"id": 1, "name": "after", "rootPath": "/new", "distro": "Ubuntu"},
            "tab": None, "status": None, "message": None, "agentSession": None,
        })
        workspace = overview["workspaces"][0]
        self.assertEqual(workspace["name"], "after")
        self.assertEqual(workspace["rootPath"], "/new")
        self.assertEqual(workspace["distro"], "Ubuntu")
        self.assertTrue(workspace["manager"], "기존 manager 표시는 유지한다")

    def test_status_event_adds_a_missing_tab(self):
        overview = {"nextSeq": 0, "workspaces": [
            {
                "id": 1, "name": "w", "rootPath": "/w", "distro": None,
                "manager": False, "agentStatus": "idle", "tabs": [],
            },
        ]}
        HARNESS._apply_event(overview, {
            "kind": "status",
            "workspace": {"id": 1, "name": "w", "rootPath": "/w", "distro": None},
            "tab": 5, "status": "running", "message": "working", "agentSession": None,
        })
        tabs = overview["workspaces"][0]["tabs"]
        self.assertEqual(len(tabs), 1)
        self.assertEqual(tabs[0], {
            "tab": 5,
            "title": "",
            "kind": "terminal",
            "status": "running",
            "agentStatus": "running",
            "lastAgentMessage": "working",
            "agentSession": None,
        })

    def test_session_event_adds_a_missing_tab(self):
        overview = {"nextSeq": 0, "workspaces": [
            {
                "id": 1, "name": "w", "rootPath": "/w", "distro": None,
                "manager": False, "agentStatus": "idle", "tabs": [],
            },
        ]}
        HARNESS._apply_event(overview, {
            "kind": "session",
            "workspace": {"id": 1, "name": "w", "rootPath": "/w", "distro": None},
            "tab": 6, "status": None, "message": None,
            "agentSession": claude_session("s6"),
        })
        tab = overview["workspaces"][0]["tabs"][0]
        self.assertEqual(tab["tab"], 6)
        self.assertEqual(tab["agentSession"], claude_session("s6"))

    def test_workspace_status_is_the_tab_aggregate(self):
        overview = {"nextSeq": 0, "workspaces": [
            {
                "id": 1, "name": "w", "rootPath": "/w", "distro": None,
                "manager": False, "agentStatus": "needsInput",
                "tabs": [
                    terminal_tab(4),
                    terminal_tab(5),
                ],
            },
        ]}
        tabs = overview["workspaces"][0]["tabs"]
        tabs[0]["agentStatus"] = "needsInput"
        tabs[1]["agentStatus"] = "idle"
        event_workspace = {"id": 1, "name": "w", "rootPath": "/w", "distro": None}
        HARNESS._apply_event(overview, {
            "kind": "status", "workspace": event_workspace, "tab": 5,
            "status": "idle", "message": "done", "agentSession": None,
        })
        self.assertEqual(tabs[1]["agentStatus"], "idle")
        self.assertEqual(overview["workspaces"][0]["agentStatus"], "needsInput",
                         "탭 B의 idle이 탭 A의 needsInput을 덮지 않는다")
        # 이 집계 위에서 report 알림은 생략된다.
        patch = {
            "verdict": "update", "notify": "report", "notify_reason": "question",
            "ops": [make_op("add", kind="question", text="배포는 언제 하나?")],
        }
        self.assertIsNone(
            HARNESS.decide_notify(patch, overview["workspaces"][0]["agentStatus"]))

        HARNESS._apply_event(overview, {
            "kind": "status", "workspace": event_workspace, "tab": 4,
            "status": "idle", "message": "cleared", "agentSession": None,
        })
        self.assertEqual(overview["workspaces"][0]["agentStatus"], "idle")


class CollectibleTest(unittest.TestCase):
    """대상 판정: build_board와 같은 제외 규칙."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.manager = self.base / "manager"
        hello = {
            "managerDir": str(self.manager),
            "managerDistro": "Ubuntu",
            "defaultDistro": "Ubuntu",
            "settings": {"idleSeconds": 1},
        }
        settings = HARNESS._hello_settings(hello)
        log = HARNESS.HarnessLog(
            self.manager / "logs" / "harness.log", error_stream=io.StringIO())
        args = HARNESS._parse_args([])
        self.harness = HARNESS.Harness(hello, settings, log, None, args)

    def test_excluded_workspaces_are_not_collectible(self):
        archive = self.manager / "archive" / (
            STORE.task_key("/w/4", None) + "--20260925T000000Z.json")
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_text(
            json.dumps({"meta": {"updated_at": "2026-09-25T00:00:00Z"}}), encoding="utf-8")

        self.assertIsNone(self.harness.collectible(
            workspace(1, "manager", "/w/1", None, manager=True)))
        self.assertIsNone(self.harness.collectible(workspace(2, "no-root", None, None)))
        self.assertIsNone(self.harness.collectible(workspace(3, "other", "/w/3", "Debian")))
        self.assertIsNone(self.harness.collectible(workspace(4, "choice", "/w/4", None)))

        plain = workspace(5, "plain", "/w/5", None, tabs=[terminal_tab(5, claude_session())])
        entry = self.harness.collectible(plain)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["state"], "none")

    def test_workspace_running_sees_a_tab_added_by_events(self):
        plain = workspace(5, "plain", "/w/5", None, tabs=[terminal_tab(5)])
        overview = {"nextSeq": 0, "workspaces": [plain]}
        HARNESS._apply_event(overview, {
            "kind": "status",
            "workspace": {"id": 5, "name": "plain", "rootPath": "/w/5", "distro": None},
            "tab": 9, "status": "running", "message": "work", "agentSession": None,
        })
        self.assertTrue(self.harness.workspace_running(plain))

    def pending_workspace(self, workspace_id, root):
        return workspace(
            workspace_id, "w%d" % workspace_id, root, None,
            tabs=[terminal_tab(workspace_id, claude_session("s%d" % workspace_id))])

    def test_idle_reservation_cancels_only_its_tab_and_waits_for_the_deadline(self):
        first = self.pending_workspace(1, "/w/1")
        second = self.pending_workspace(2, "/w/2")
        self.harness.schedule_idle(first, 1)
        self.harness.schedule_idle(second, 2)
        deadline = self.harness.idle_timers[(1, 1)]
        self.assertAlmostEqual(
            deadline - time.monotonic(), self.harness.idle_seconds, delta=0.5)

        self.assertIsNone(self.harness.next_ready(time.monotonic()))
        self.harness.cancel_idle(2, 2)
        self.assertNotIn((2, 2), self.harness.idle_timers)
        self.assertNotIn(2, self.harness.pending)
        self.assertEqual(self.harness.next_ready(deadline + 0.1), 1)

    def test_running_tab_defers_until_the_max_delay(self):
        workspace_running = self.pending_workspace(1, "/w/1")
        workspace_running["tabs"][0]["agentStatus"] = "running"
        self.harness.schedule_idle(workspace_running, 1)
        deadline = self.harness.idle_timers[(1, 1)]
        self.assertIsNone(
            self.harness.next_ready(deadline + 0.1),
            "다른 탭이 running이면 최대 지연 전에는 실행하지 않는다")
        since = self.harness.waiting_since[1]
        self.assertEqual(self.harness.next_ready(since + self.harness.idle_seconds * 4 + 0.1), 1)

    def session_event(self, session_id, tab=4):
        return {
            "kind": "session", "tab": tab,
            "agentSession": claude_session(session_id),
        }

    def test_event_sessions_are_capped_per_workspace(self):
        for index in range(40):
            self.harness.note_session_event(1, self.session_event("s%02d" % index))
        sessions = self.harness.event_sessions[1]
        self.assertEqual(len(sessions), HARNESS.MAX_EVENT_SESSIONS)
        self.assertNotIn("s00", sessions, "가장 오래 추가된 것부터 지운다")
        self.assertIn("s39", sessions)

    def test_workspace_closed_forgets_its_event_sessions(self):
        self.harness.overview = {"nextSeq": 0, "workspaces": [
            workspace(1, "w", "/w/1", None, tabs=[terminal_tab(4, claude_session("s1"))]),
        ]}
        self.harness.note_session_event(1, self.session_event("s2"))
        self.harness.note_event({
            "kind": "workspaceClosed",
            "workspace": {"id": 1, "name": "w", "rootPath": "/w/1", "distro": None},
            "tab": None, "status": None, "message": None, "agentSession": None,
        })
        self.assertNotIn(1, self.harness.event_sessions)
        snapshot = self.harness.pending_refs[1]
        sessions = {
            tab["agentSession"]["sessionId"]
            for tab in snapshot["tabs"]
            if isinstance(tab, dict) and isinstance(tab.get("agentSession"), dict)
        }
        self.assertEqual(sessions, {"s1", "s2"},
                         "닫힘 시점 탭과 이벤트 세션이 예약 스냅샷에 합쳐져야 한다")

    def test_after_summary_forgets_pruned_event_sessions(self):
        for index in range(3):
            self.harness.note_session_event(1, self.session_event("s%d" % index))
        self.harness.after_summary(1, {
            "pruned_sessions": ["s0", "s1"],
            "rejected": [],
            "notify": None,
            "error": None,
            "doc": None,
        })
        self.assertNotIn("s0", self.harness.event_sessions[1])
        self.assertNotIn("s1", self.harness.event_sessions[1])
        self.assertIn("s2", self.harness.event_sessions[1])


class SummaryTestCase(HarnessTestCase):
    """요약 트리거 통합 테스트의 공통 준비. fixture transcript를 임시 허용 루트에 복사한다."""

    def setUp(self):
        super().setUp()
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.transcripts = self.base / "transcripts"
        self.transcripts.mkdir()
        self.transcript = self.transcripts / "claude-session.jsonl"
        shutil.copyfile(str(TRANSCRIPT_FIXTURE), str(self.transcript))
        self.record = self.base / "codex-invocations.jsonl"
        self.pidfile = self.base / "codex.pid"
        self.configure_codex()

    def start_ok(self, extra_args=(), idle_seconds=1):
        args = (
            "--transcript-root", str(self.transcripts),
            "--tick-seconds", "0.05",
        ) + tuple(extra_args)
        run = self.start_harness(args)
        hello = self.hello()
        hello["settings"]["idleSeconds"] = idle_seconds
        run.send(hello)
        self.expect_status(run, "starting")
        self.expect_status(run, "ok")
        return run

    def configure_codex(self, patch=None, sleep=0.0, exit_code=0):
        doc = {
            "record": str(self.record),
            "pidfile": str(self.pidfile),
            "sleep": sleep,
            "exit": exit_code,
        }
        if patch is not None:
            path = self.base / "patch.json"
            path.write_text(json.dumps(patch, ensure_ascii=False), encoding="utf-8")
            doc["out"] = str(path)
        self.fake_config.write_text(json.dumps(doc), encoding="utf-8")

    def codex_calls(self):
        if not self.record.exists():
            return []
        return [
            json.loads(line) for line in self.record.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def wait_until(self, predicate, timeout=10.0, message="condition"):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail("timed out waiting for " + message)

    def task_doc(self):
        path = self.manager / "tasks" / (STORE.task_key(str(self.repo), None) + ".json")
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def session(self, path=None, session_id="sess-one"):
        return {
            "agent": "claude",
            "sessionId": session_id,
            "transcriptPath": str(path or self.transcript),
        }

    def summary_overview(self, session_path=None, tabs=None):
        if tabs is None:
            tabs = [terminal_tab(4, self.session(session_path))]
        return {
            "nextSeq": 1,
            "workspaces": [workspace(1, "feature-x", str(self.repo), None, tabs=tabs)],
        }

    def event(self, kind, tab=None, status=None, agent_session=None, workspace_id=1):
        return {
            "seq": 1,
            "kind": kind,
            "workspace": {
                "id": workspace_id, "name": "feature-x", "rootPath": str(self.repo), "distro": None,
            },
            "tab": tab,
            "status": status,
            "message": None,
            "agentSession": agent_session,
        }

    def send_snapshot(self, run, overview=None):
        run.send({"type": "snapshot", "overview": overview or self.summary_overview()})
        return self.read_until(run, "board")

    def send_events(self, run, events, next_seq=2):
        run.send({"type": "events", "events": events, "nextSeq": next_seq})
        return self.read_until(run, "board")

    def collect_until(self, run, predicate, timeout=10.0):
        collected = []
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.fail("timed out waiting for a matching message")
            message = self.next_message(run, timeout=remaining)
            collected.append(message)
            if predicate(message):
                return collected


class SummaryTriggerTest(SummaryTestCase):
    def test_idle_event_summarizes_after_idle_seconds(self):
        patch = {"verdict": "update", "notify": "board", "notify_reason": None, "ops": [
            make_op("set_progress", text="CH11b 요약 루프를 연결했다", reported_done=False),
        ]}
        self.configure_codex(patch=patch)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        ready = self.expect_status(run, "ok", timeout=10.0)
        board = self.read_until(run, "board")

        doc = self.task_doc()
        self.assertIsNotNone(doc)
        self.assertEqual(doc["progress"]["text"], "CH11b 요약 루프를 연결했다")
        self.assertIsNone(doc["meta"]["last_error"])
        self.assertEqual(doc["meta"]["model"], "gpt-6-luna")
        self.assertEqual(doc["meta"]["effort"], "low")
        self.assertIsNotNone(ready["lastCollectedAt"])
        self.assertEqual(len(self.codex_calls()), 1)
        entries = {entry["workspaceId"]: entry for entry in board["entries"]}
        self.assertEqual(entries[1]["task"]["progress"]["text"], "CH11b 요약 루프를 연결했다")

    def test_needs_input_summarizes_immediately(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        started = time.monotonic()
        self.send_events(run, [self.event("status", tab=4, status="needsInput")])
        self.expect_status(run, "busy", timeout=5.0)
        self.assertLess(
            time.monotonic() - started, 2.0,
            "needsInput은 idleSeconds를 기다리지 않아야 한다")

    def test_same_tab_running_cancels_the_idle_timer(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.send_events(run, [self.event("status", tab=4, status="running")], next_seq=3)
        time.sleep(1.6)
        self.send_snapshot(run)
        self.assertEqual(self.codex_calls(), [])
        self.assertIsNone(self.task_doc())

    def test_other_tab_running_defers_until_the_max_delay(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok()
        tabs = [terminal_tab(4, self.session()), terminal_tab(5, None)]
        self.send_snapshot(run, overview=self.summary_overview(tabs=tabs))
        started = time.monotonic()
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.send_events(run, [self.event("status", tab=5, status="running")], next_seq=3)
        time.sleep(1.5)
        self.assertEqual(
            self.codex_calls(), [],
            "다른 탭이 running이면 유휴 예약은 idleSeconds 뒤 바로 실행하지 않는다")
        self.wait_until(
            lambda: len(self.codex_calls()) >= 1,
            timeout=8.0,
            message="the max-delay summary",
        )
        self.assertGreaterEqual(
            time.monotonic() - started, 3.5,
            "워크스페이스별 최대 지연(idleSeconds × 4)보다 일찍 실행됐다")

    def test_repeated_events_summarize_once(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok()
        self.send_snapshot(run)
        events = [
            self.event("status", tab=4, status="idle"),
            self.event("status", tab=4, status="idle"),
            self.event("status", tab=4, status="needsInput"),
        ]
        self.send_events(run, events)
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1)
        time.sleep(0.5)
        self.assertEqual(len(self.codex_calls()), 1)

    def test_tab_gone_summarizes_immediately(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        started = time.monotonic()
        self.send_events(run, [
            self.event("session", tab=4, agent_session=self.session()),
            self.event("tabGone", tab=4),
        ])
        self.expect_status(run, "busy", timeout=5.0)
        self.assertLess(
            time.monotonic() - started, 2.0,
            "tabGone은 idleSeconds를 기다리지 않아야 한다")
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1)

    def test_workspace_closed_summarizes_immediately(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        started = time.monotonic()
        self.send_events(run, [
            self.event("session", tab=4, agent_session=self.session()),
            self.event("workspaceClosed", tab=4),
        ])
        self.expect_status(run, "busy", timeout=5.0)
        self.assertLess(
            time.monotonic() - started, 2.0,
            "workspaceClosed는 idleSeconds를 기다리지 않아야 한다")
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1)

    def test_second_trigger_without_new_lines_uses_the_fast_path(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        first = self.task_doc()
        self.assertEqual(len(self.codex_calls()), 1)

        self.send_events(run, [self.event("status", tab=4, status="idle")], next_seq=3)
        self.expect_status(run, "ok", timeout=5.0)
        self.read_until(run, "board")
        second = self.task_doc()
        self.assertEqual(len(self.codex_calls()), 1, "빠른 경로는 codex를 부르지 않는다")
        self.assertGreaterEqual(
            second["meta"]["last_collected_at"], first["meta"]["last_collected_at"])

    def test_schema_combo_patch_reports_failed_without_a_cursor_or_notify(self):
        bad = {"verdict": "no_change", "notify": "none", "notify_reason": None, "ops": [
            make_op("set_progress", text="반영되면 안 된다", reported_done=False),
        ]}
        self.configure_codex(patch=bad)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "failed", timeout=10.0)
        self.assertNotIn("notify", [m["type"] for m in messages])
        self.assertIn("patch schema", messages[-1]["message"])
        self.read_until(run, "board")

        doc = self.task_doc()
        self.assertEqual(doc["meta"]["cursor"], {})
        self.assertIsNone(doc["meta"]["last_collected_at"])
        self.assertIn("patch schema", doc["meta"]["last_error"])

    def test_report_reason_missing_reports_failed(self):
        bad = {"verdict": "update", "notify": "report", "notify_reason": None, "ops": [
            make_op("set_progress", text="x", reported_done=False),
        ]}
        self.configure_codex(patch=bad)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "failed", timeout=10.0)
        self.assertNotIn("notify", [m["type"] for m in messages])
        self.assertIn("notify_reason", messages[-1]["message"])
        self.read_until(run, "board")

        doc = self.task_doc()
        self.assertEqual(doc["meta"]["cursor"], {})
        self.assertIsNone(doc["meta"]["last_collected_at"])
        self.assertIn("notify report requires notify_reason", doc["meta"]["last_error"])

    def test_all_ops_rejected_reports_failed_but_advances_the_cursor(self):
        bad = {"verdict": "update", "notify": "report", "notify_reason": "question", "ops": [
            make_op("add", kind="decision", text="근거 없는 결정", by="user"),
        ]}
        self.configure_codex(patch=bad)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "failed", timeout=10.0)
        self.assertNotIn("notify", [m["type"] for m in messages])
        self.assertIn("all ops rejected", messages[-1]["message"])
        self.read_until(run, "board")

        doc = self.task_doc()
        # 결정적 거부의 무한 재시도를 막으려고 커서·수집 시각은 전진시킨다.
        self.assertTrue(doc["meta"]["cursor"], "전부 거부돼도 커서는 전진한다")
        self.assertIsNotNone(doc["meta"]["last_collected_at"])
        self.assertIn("all ops rejected", doc["meta"]["last_error"])

        log = (self.manager / "logs" / "harness.log").read_text(encoding="utf-8")
        self.assertIn("rejected an op", log)
        self.assertIn("anchor_ref", log)
        self.assertNotIn("근거 없는 결정", log)

    def test_partial_rejection_applies_and_logs_the_reason(self):
        mixed = {"verdict": "update", "notify": "none", "notify_reason": None, "ops": [
            make_op("set_progress", text="부분 적용", reported_done=False),
            make_op("add", kind="decision", text="근거 없는 결정", by="user"),
        ]}
        self.configure_codex(patch=mixed)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        doc = self.task_doc()
        self.assertEqual(doc["progress"]["text"], "부분 적용")
        self.assertIsNone(doc["meta"]["last_error"])
        self.assertTrue(doc["meta"]["cursor"])
        log = (self.manager / "logs" / "harness.log").read_text(encoding="utf-8")
        self.assertIn("rejected an op", log)
        self.assertNotIn("근거 없는 결정", log)

    def test_tab_aggregate_suppresses_report_notify(self):
        patch = {"verdict": "update", "notify": "report", "notify_reason": "question", "ops": [
            make_op(
                "add", kind="question", text="fixture transcript는 어디에 쓰나?",
                anchor_ref="u1", quote="throwaway session to record transcript fixtures"),
        ]}
        self.configure_codex(patch=patch)
        tabs = [
            terminal_tab(4, self.session()),
            terminal_tab(5, self.session(session_id="sess-two")),
        ]
        tabs[0]["agentStatus"] = "needsInput"
        tabs[0]["lastAgentMessage"] = "waiting"
        run = self.start_ok()
        self.send_snapshot(run, overview=self.summary_overview(tabs=tabs))
        self.send_events(run, [self.event("status", tab=5, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "ok", timeout=10.0)
        self.assertNotIn(
            "notify", [m["type"] for m in messages],
            "탭 B의 idle이 탭 A의 needsInput 집계를 덮으면 안 된다")
        self.assertIsNotNone(self.task_doc())

    def test_delta_cap_is_resumed_without_a_new_trigger(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok(("--delta-max-bytes", "4096"))
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])

        deadline = time.monotonic() + 20.0
        reached = False
        while time.monotonic() < deadline:
            remaining = max(0.1, deadline - time.monotonic())
            try:
                self.next_message(run, timeout=min(1.0, remaining))
            except queue.Empty:
                pass
            doc = self.task_doc()
            if doc is None:
                continue
            cursor = doc["meta"]["cursor"].get("sess-one") or {}
            if cursor.get("offset") == self.transcript.stat().st_size:
                reached = True
                break
        self.assertTrue(reached, "상한에 잘린 델타가 재예약으로 끝까지 읽혀야 한다")
        self.assertGreaterEqual(
            len(self.codex_calls()), 2, "상한 회차마다 이어서 읽어야 한다")

    def test_login_shell_codex_home_is_used(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        codex_home = self.base / "codex-home"
        sessions = codex_home / "sessions"
        sessions.mkdir(parents=True)
        transcript = sessions / "claude-session.jsonl"
        shutil.copyfile(str(TRANSCRIPT_FIXTURE), str(transcript))
        self.write_login_shell(str(self.codex_path), codex_home=str(codex_home))

        run = self.start_harness(("--tick-seconds", "0.05"))
        hello = self.hello()
        hello["settings"]["idleSeconds"] = 1
        run.send(hello)
        self.expect_status(run, "starting")
        self.expect_status(run, "ok")
        self.send_snapshot(run, overview=self.summary_overview(session_path=transcript))
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        calls = self.codex_calls()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["codex_home"], str(codex_home))

    def test_failed_summary_reports_failed_and_keeps_the_cursor(self):
        patch = {"verdict": "update", "notify": "board", "notify_reason": None, "ops": [
            make_op("set_progress", text="실패 뒤 성공", reported_done=False),
        ]}
        self.configure_codex(patch=patch, exit_code=1)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        failed = self.expect_status(run, "failed", timeout=10.0)
        self.assertIn("exited with code 1", failed["message"])
        self.read_until(run, "board")

        doc = self.task_doc()
        self.assertEqual(doc["meta"]["cursor"], {})
        self.assertIsNone(doc["meta"]["last_collected_at"])
        self.assertIn("exited with code 1", doc["meta"]["last_error"])

        self.configure_codex(patch=patch, exit_code=0)
        self.send_events(run, [self.event("status", tab=4, status="idle")], next_seq=3)
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        doc = self.task_doc()
        self.assertIsNone(doc["meta"]["last_error"])
        self.assertTrue(doc["meta"]["cursor"])
        self.assertEqual(len(self.codex_calls()), 2)

    def test_failed_summary_with_a_capped_delta_is_not_re_reserved(self):
        self.configure_codex(patch=NO_CHANGE_PATCH, exit_code=1)
        run = self.start_ok(("--delta-max-bytes", "4096"))
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "failed", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1)
        time.sleep(1.5)
        self.assertEqual(
            len(self.codex_calls()), 1,
            "실패한 요약은 more가 있어도 즉시 재예약하지 않는다")

    def test_event_session_tails_are_not_recollected_after_cursor_pruning(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok()
        sessions = {}
        for index in range(1, 43):
            session_id = "s%02d" % index
            path = self.transcripts / (session_id + ".jsonl")
            path.write_text(
                json.dumps({
                    "type": "user",
                    "sessionId": session_id,
                    "message": {"role": "user", "content": "prompt " + session_id},
                    "uuid": "u-" + session_id,
                }, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            sessions[session_id] = {
                "agent": "claude", "sessionId": session_id, "transcriptPath": str(path),
            }

        self.send_snapshot(run, overview=self.summary_overview(tabs=[]))
        for index in range(1, 33):
            self.send_events(run, [self.event(
                "session", tab=4, agent_session=sessions["s%02d" % index])])
        self.send_events(run, [self.event("status", tab=4, status="idle")], next_seq=3)
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1)

        for index in range(33, 43):
            self.send_events(run, [self.event(
                "session", tab=4, agent_session=sessions["s%02d" % index])])
        self.send_events(run, [self.event("status", tab=4, status="idle")], next_seq=3)
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 2)

        # 새 발화가 없으므로 이번 틱은 빠른 경로로 끝나야 한다. 커서에서 지운
        # 세션이 이벤트 목록으로 되살아나면 옛 꼬리를 다시 요약하게 된다.
        self.send_events(run, [self.event("status", tab=4, status="idle")], next_seq=3)
        self.expect_status(run, "ok", timeout=5.0)
        self.read_until(run, "board")
        time.sleep(0.5)
        self.assertEqual(
            len(self.codex_calls()), 2,
            "지워진 세션의 옛 꼬리가 다음 수집에 다시 들어가면 안 된다")

    def test_notify_question_is_emitted_when_live_status_is_idle(self):
        patch = {"verdict": "update", "notify": "report", "notify_reason": "question", "ops": [
            make_op(
                "add", kind="question", text="fixture transcript는 어디에 쓰나?",
                anchor_ref="u1", quote="throwaway session to record transcript fixtures"),
        ]}
        self.configure_codex(patch=patch)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        notify = self.read_until(run, "notify", timeout=10.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(notify["workspaceId"], 1)
        self.assertEqual(notify["reason"], "question")
        self.assertEqual(notify["title"], "fixture transcript는 어디에 쓰나?")
        self.assertTrue(notify["body"])

    def test_notify_is_suppressed_when_live_status_is_needs_input(self):
        patch = {"verdict": "update", "notify": "report", "notify_reason": "question", "ops": [
            make_op(
                "add", kind="question", text="fixture transcript는 어디에 쓰나?",
                anchor_ref="u1", quote="throwaway session to record transcript fixtures"),
        ]}
        self.configure_codex(patch=patch)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="needsInput")])
        self.expect_status(run, "busy", timeout=5.0)
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "ok", timeout=10.0)
        self.assertNotIn("notify", [m["type"] for m in messages])
        self.assertEqual(len(self.codex_calls()), 1)

    def test_snapshot_catches_up_a_stale_cursor(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        doc = STORE.new_task(str(self.repo), None, "2026-09-25T00:00:00Z")
        doc["meta"]["cursor"]["sess-one"] = {
            "agent": "claude",
            "transcript_path": str(self.transcript),
            "offset": 0,
            "tab": 4,
        }
        path = self.manager / "tasks" / (STORE.task_key(str(self.repo), None) + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")

        run = self.start_ok()
        self.send_snapshot(run)
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1)
        doc = self.task_doc()
        size = self.transcript.stat().st_size
        offsets = [entry.get("offset") for entry in doc["meta"]["cursor"].values()]
        self.assertIn(size, offsets)

    def test_transcript_outside_the_allowed_root_is_rejected(self):
        outside = self.base / "outside"
        outside.mkdir()
        path = outside / "claude-session.jsonl"
        shutil.copyfile(str(TRANSCRIPT_FIXTURE), str(path))
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok()
        self.send_snapshot(run, overview=self.summary_overview(session_path=path))
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        time.sleep(1.6)
        self.assertEqual(self.codex_calls(), [])
        self.assertIsNone(self.task_doc())
        log = (self.manager / "logs" / "harness.log").read_text(encoding="utf-8")
        self.assertIn("outside the allowed roots", log)


class SummaryProcessTest(SummaryTestCase):
    def test_stdin_messages_are_processed_while_summarizing(self):
        self.configure_codex(patch=NO_CHANGE_PATCH, sleep=2.0)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="needsInput")])
        self.expect_status(run, "busy", timeout=5.0)
        run.send({"type": "snapshot", "overview": self.summary_overview()})
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "ok", timeout=10.0)
        self.assertIn(
            "board", [m["type"] for m in messages],
            "요약 중에도 snapshot이 처리되어 보드가 나와야 한다")

    def test_task_write_failure_reports_failed_and_keeps_running(self):
        self.configure_codex(patch=NO_CHANGE_PATCH, sleep=1.5)
        self.seed_task(str(self.repo), None)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="needsInput")])
        self.expect_status(run, "busy", timeout=5.0)

        task_path = self.manager / "tasks" / (STORE.task_key(str(self.repo), None) + ".json")
        self.assertTrue(task_path.is_file())
        task_path.unlink()
        task_path.mkdir()

        failed = self.expect_status(run, "failed", timeout=10.0)
        self.assertIn("summary failed", failed["message"])
        log = (self.manager / "logs" / "harness.log").read_text(encoding="utf-8")
        self.assertIn("cannot record the failure", log)

        board = self.send_snapshot(run)
        self.assertEqual(board["entries"][0]["state"], "error",
                         "실패 뒤에도 루프가 돌아 보드를 낸다")

    def test_stdin_eof_kills_the_running_summary(self):
        self.configure_codex(patch=NO_CHANGE_PATCH, sleep=30.0)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="needsInput")])
        self.expect_status(run, "busy", timeout=5.0)
        self.wait_until(self.pidfile.exists, timeout=5.0, message="the fake codex pid file")
        pid = int(self.pidfile.read_text(encoding="utf-8"))
        self.assertTrue(_process_alive(pid))

        run.close_stdin()
        self.assertEqual(run.wait(timeout=10), 0)
        self.wait_until(lambda: not _process_alive(pid), timeout=5.0, message="the child to die")


class LifetimeTest(SummaryTestCase):
    """닫기 보관·snapshot 조정·choice·resume/fresh 처리."""

    def key(self):
        return STORE.task_key(str(self.repo), None)

    def task_path(self):
        return self.manager / "tasks" / (self.key() + ".json")

    def archive_paths(self):
        directory = self.manager / "archive"
        if not directory.is_dir():
            return []
        return sorted(directory.glob(self.key() + "--*.json"))

    def board_by_id(self, board):
        return {entry["workspaceId"]: entry for entry in board["entries"]}

    def test_workspace_closed_without_a_task_does_nothing(self):
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run, overview=self.summary_overview(tabs=[terminal_tab(4)]))
        self.send_events(run, [self.event("workspaceClosed", tab=4)])
        time.sleep(0.6)

        self.assertFalse(self.task_path().exists())
        self.assertEqual(self.archive_paths(), [])
        self.assertEqual(self.codex_calls(), [])

    def test_workspace_closed_without_a_collectible_session_still_archives(self):
        doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
        doc["meta"]["cursor"] = {"sess-missing": {
            "agent": "claude", "transcript_path": str(self.base / "missing.jsonl"),
            "offset": 0, "tab": 4,
        }}
        self.seed_task(str(self.repo), None, doc=doc)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run, overview=self.summary_overview(tabs=[terminal_tab(4)]))
        self.send_events(run, [self.event("workspaceClosed", tab=4)])

        self.wait_until(
            lambda: not self.task_path().exists(), message="the archive without a summary")
        self.assertEqual(len(self.archive_paths()), 1)
        self.assertEqual(self.codex_calls(), [], "수집할 세션이 없으면 요약하지 않는다")

    def test_workspace_closed_archives_after_the_final_summary(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        self.send_events(run, [
            self.event("session", tab=4, agent_session=self.session()),
            self.event("workspaceClosed", tab=4),
        ])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        self.wait_until(
            lambda: not self.task_path().exists(), message="the archived task file")
        archives = self.archive_paths()
        self.assertEqual(len(archives), 1)
        doc = json.loads(archives[0].read_text(encoding="utf-8"))
        self.assertEqual(doc["meta"]["status"], "archived")
        self.assertTrue(doc["meta"]["cursor"], "커서는 보관본 안에 그대로 남는다")
        self.assertEqual(len(self.codex_calls()), 1)

    def test_workspace_closed_collects_sessions_added_after_an_idle_reservation(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        second_path = self.transcripts / "session-b.jsonl"
        second_path.write_text(json.dumps({
            "type": "user",
            "sessionId": "sess-b",
            "message": {"role": "user", "content": "session B prompt"},
            "uuid": "u-sess-b",
        }) + "\n", encoding="utf-8")

        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        # 코어는 tabGone(터미널 탭마다)을 먼저, workspaceClosed를 마지막에 보낸다.
        self.send_events(run, [
            self.event("session", tab=5, agent_session={
                "agent": "claude", "sessionId": "sess-b",
                "transcriptPath": str(second_path),
            }),
            self.event("tabGone", tab=4),
            self.event("tabGone", tab=5),
            self.event("workspaceClosed", tab=4),
        ], next_seq=3)
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        self.wait_until(
            lambda: not self.task_path().exists(), message="the archived task file")
        archives = self.archive_paths()
        self.assertEqual(len(archives), 1)
        doc = json.loads(archives[0].read_text(encoding="utf-8"))
        self.assertIn("sess-one", doc["meta"]["cursor"])
        self.assertIn("sess-b", doc["meta"]["cursor"],
                      "닫히기 전에 시작한 세션도 마지막 수집에 들어가야 한다")
        calls = self.codex_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("session B prompt", calls[0]["stdin"])

    def test_workspace_closed_collects_a_snapshot_session_without_a_reservation(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        self.send_events(run, [
            self.event("tabGone", tab=4),
            self.event("tabGone", tab=5),
            self.event("workspaceClosed", tab=4),
        ])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        self.wait_until(
            lambda: not self.task_path().exists(), message="the archived task file")
        archives = self.archive_paths()
        self.assertEqual(len(archives), 1)
        doc = json.loads(archives[0].read_text(encoding="utf-8"))
        self.assertIn("sess-one", doc["meta"]["cursor"],
                      "스냅샷으로만 알던 세션도 마지막 수집에 들어가야 한다")
        calls = self.codex_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("throwaway session to record transcript fixtures", calls[0]["stdin"])

    def test_tab_gone_and_workspace_closed_in_separate_batches_keep_the_session(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        self.send_events(run, [self.event("tabGone", tab=4), self.event("tabGone", tab=5)])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        self.send_events(run, [self.event("workspaceClosed", tab=4)], next_seq=3)
        self.wait_until(
            lambda: not self.task_path().exists(), message="the archived task file")
        archives = self.archive_paths()
        self.assertEqual(len(archives), 1)
        doc = json.loads(archives[0].read_text(encoding="utf-8"))
        self.assertIn("sess-one", doc["meta"]["cursor"])
        calls = self.codex_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("throwaway session to record transcript fixtures", calls[0]["stdin"])

    def test_single_tab_gone_collects_the_snapshot_session_immediately(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        self.send_events(run, [self.event("tabGone", tab=4)])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        doc = self.task_doc()
        self.assertIsNotNone(doc)
        self.assertIn("sess-one", doc["meta"]["cursor"])
        calls = self.codex_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("throwaway session to record transcript fixtures", calls[0]["stdin"])

    def test_same_key_workspaces_archive_only_after_the_last_one_closes(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        run = self.start_ok(idle_seconds=5)
        overview = {
            "nextSeq": 1,
            "workspaces": [
                workspace(1, "first", str(self.repo), None,
                          tabs=[terminal_tab(4, self.session())]),
                workspace(2, "second", str(self.repo), None, tabs=[terminal_tab(5)]),
            ],
        }
        self.send_snapshot(run, overview=overview)
        self.send_events(run, [self.event("workspaceClosed", tab=4)])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        time.sleep(0.8)
        self.assertTrue(
            self.task_path().exists(),
            "같은 키의 워크스페이스가 남아 있으면 보관하지 않는다")
        self.assertEqual(self.archive_paths(), [])

        self.send_events(
            run, [self.event("workspaceClosed", tab=5, workspace_id=2)], next_seq=3)
        self.wait_until(
            lambda: not self.task_path().exists(), message="the second close to archive")
        archives = self.archive_paths()
        self.assertEqual(len(archives), 1)
        doc = json.loads(archives[0].read_text(encoding="utf-8"))
        self.assertEqual(doc["meta"]["status"], "archived")

    def test_snapshot_archives_tasks_with_no_open_workspace(self):
        stale_root = "/home/u/stale"
        other_root = "/home/u/other"
        self.seed_task(stale_root, None)
        self.seed_task(MANAGER_ROOT, "Ubuntu")
        self.seed_task(other_root, "Debian")
        run = self.start_ok()
        overview = {
            "nextSeq": 1,
            "workspaces": [
                workspace(1, "feature-x", str(self.repo), None, tabs=[terminal_tab(4)]),
                workspace(3, "other", other_root, "Debian"),
                workspace(8, "manager", MANAGER_ROOT, "Ubuntu", manager=True),
            ],
        }
        self.send_snapshot(run, overview=overview)

        for key, label in (
            (STORE.task_key(stale_root, None), "snapshot에 없는 키"),
            (STORE.task_key(other_root, "Debian"), "다른 배포판 워크스페이스의 키"),
            (STORE.task_key(MANAGER_ROOT, "Ubuntu"), "관리자 워크스페이스의 키"),
        ):
            self.assertFalse(
                (self.manager / "tasks" / (key + ".json")).exists(),
                "%s의 active 작업은 보관한다(F4)" % label)
            archives = sorted((self.manager / "archive").glob(key + "--*.json"))
            self.assertEqual(len(archives), 1)
            doc = json.loads(archives[0].read_text(encoding="utf-8"))
            self.assertEqual(doc["meta"]["status"], "archived")

    def test_snapshot_defers_archiving_while_a_summary_runs(self):
        self.configure_codex(patch=NO_CHANGE_PATCH, sleep=2.0)
        doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
        doc["meta"]["cursor"] = {"sess-one": {
            "agent": "claude", "transcript_path": str(self.transcript), "offset": 0, "tab": 4,
        }}
        self.seed_task(str(self.repo), None, doc=doc)
        run = self.start_ok()
        self.send_snapshot(run)
        self.expect_status(run, "busy", timeout=5.0)

        run.send({"type": "snapshot", "overview": {"nextSeq": 2, "workspaces": []}})
        self.read_until(run, "board")
        self.assertTrue(
            self.task_path().exists(), "요약이 도는 키는 끝난 뒤에 보관한다")

        self.expect_status(run, "ok", timeout=10.0)
        self.wait_until(lambda: not self.task_path().exists(), message="the deferred archive")
        self.assertEqual(len(self.archive_paths()), 1)

    def test_failed_final_summary_still_archives(self):
        self.configure_codex(patch=NO_CHANGE_PATCH, exit_code=1)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        self.send_events(run, [
            self.event("session", tab=4, agent_session=self.session()),
            self.event("workspaceClosed", tab=4),
        ])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "failed", timeout=10.0)
        self.read_until(run, "board")

        self.wait_until(
            lambda: not self.task_path().exists(), message="the archive after a failure")
        archives = self.archive_paths()
        self.assertEqual(len(archives), 1)
        doc = json.loads(archives[0].read_text(encoding="utf-8"))
        self.assertEqual(doc["meta"]["status"], "archived")
        self.assertIn("exited with code 1", doc["meta"]["last_error"])
        self.assertEqual(doc["meta"]["cursor"], {}, "실패한 요약은 커서를 전진시키지 않는다")

    def test_reopened_archive_shows_choice_and_blocks_collection(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        self.seed_archive(str(self.repo), None)
        run = self.start_ok()
        board = self.send_snapshot(run)
        entry = self.board_by_id(board)[1]
        self.assertEqual(entry["state"], "choice")
        self.assertEqual(entry["archive"]["count"], 1)
        self.assertIsNone(entry["task"])

        self.send_events(run, [self.event("status", tab=4, status="idle")])
        time.sleep(1.6)
        self.assertEqual(self.codex_calls(), [], "choice 상태에서는 요약하지 않는다")
        self.assertFalse(self.task_path().exists(), "choice 상태에서는 작업 파일을 만들지 않는다")

    def test_resume_restores_the_archive_and_catches_up(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
        doc["meta"]["cursor"] = {"sess-one": {
            "agent": "claude", "transcript_path": str(self.transcript), "offset": 0, "tab": 4,
        }}
        archive = self.seed_archive(str(self.repo), None, doc=doc)
        run = self.start_ok()
        board = self.send_snapshot(run)
        self.assertEqual(self.board_by_id(board)[1]["state"], "choice")

        run.send({"type": "action", "action": "resume", "key": self.key()})
        board = self.read_until(run, "board")
        self.assertEqual(self.board_by_id(board)[1]["state"], "active")
        self.assertFalse(archive.exists(), "resume은 최신 보관본을 active로 되돌린다")
        self.assertEqual(self.task_doc()["meta"]["status"], "active")

        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1, "resume은 커서 기반 따라잡기를 예약한다")

    def test_fresh_keeps_the_archive_and_starts_an_empty_task(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        archive = self.seed_archive(str(self.repo), None)
        run = self.start_ok()
        board = self.send_snapshot(run)
        self.assertEqual(self.board_by_id(board)[1]["state"], "choice")

        run.send({"type": "action", "action": "fresh", "key": self.key()})
        board = self.read_until(run, "board")
        self.assertEqual(self.board_by_id(board)[1]["state"], "active")
        self.assertTrue(archive.exists(), "fresh는 보관본을 그대로 둔다")
        doc = self.task_doc()
        self.assertEqual(doc["meta"]["status"], "active")
        self.assertEqual(doc["meta"]["cursor"], {})
        self.assertIsNone(doc["meta"]["last_collected_at"])
        self.assertEqual(doc["title"], "")

        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1, "fresh 뒤에는 일반 수집 대상이 된다")
        self.assertTrue(self.task_doc()["meta"]["cursor"])

    def test_actions_outside_choice_are_ignored(self):
        self.configure_codex(patch=NO_CHANGE_PATCH)
        task = self.seed_task(str(self.repo), None)
        before = task.read_text(encoding="utf-8")
        run = self.start_ok()
        board = self.send_snapshot(run)
        self.assertEqual(self.board_by_id(board)[1]["state"], "active")

        key = self.key()
        run.send({"type": "action", "action": "resume", "key": key})
        run.send({"type": "action", "action": "fresh", "key": key})
        run.send({"type": "action", "action": "explode", "key": key})
        run.send({"type": "action", "action": "resume", "key": "k" + "0" * 20})
        board = self.send_snapshot(run)

        self.assertEqual(self.board_by_id(board)[1]["state"], "active")
        self.assertEqual(task.read_text(encoding="utf-8"), before)
        self.assertEqual(self.archive_paths(), [])
        log = (self.manager / "logs" / "harness.log").read_text(encoding="utf-8")
        self.assertEqual(log.count("ignoring action"), 4)


class _FinishedProc:
    """폴링은 끝난 것처럼, wait·pid는 실제 자식을 가리키는 요약 프로세스 대역."""

    def __init__(self, proc):
        self.proc = proc
        self.pid = proc.pid
        self.stdin = None

    def poll(self):
        return 0

    def wait(self, timeout=None):
        return self.proc.wait(timeout=timeout)


class SummaryGuardTest(unittest.TestCase):
    """guard까지 올라온 요약 예외가 context·자식·status를 정리하는지."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.manager = self.base / "manager"
        hello = {
            "managerDir": str(self.manager),
            "managerDistro": "Ubuntu",
            "defaultDistro": "Ubuntu",
            "settings": {"idleSeconds": 1},
        }
        settings = HARNESS._hello_settings(hello)
        self.log = HARNESS.HarnessLog(
            self.manager / "logs" / "harness.log", error_stream=io.StringIO())
        args = HARNESS._parse_args([])
        self.harness = HARNESS.Harness(hello, settings, self.log, None, args)
        self.harness.overview = {"nextSeq": 0, "workspaces": [
            workspace(1, "w", "/w/1", None, tabs=[terminal_tab(4)]),
        ]}
        self.proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            stdin=subprocess.DEVNULL, start_new_session=True)
        self.addCleanup(self.reap)
        self.job = HARNESS.SummaryJob(
            _FinishedProc(self.proc), tempfile.mkdtemp(prefix="mast-summary-guard-"),
            time.monotonic(), None, None, None)
        self.harness.summary_job = self.job
        self.harness.summary_context = {
            "workspaceId": 1,
            "workspace": {"rootPath": "/w/1", "distro": None, "agentStatus": "idle"},
            "utterances": {},
            "cursor_updates": {},
            "plan_hashes": {},
            "allowed_plan_paths": [],
            "truncated": False,
            "more": False,
        }

    def reap(self):
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()

    def test_guard_cleans_a_failed_summary_and_reports_failed(self):
        with mock.patch.object(HARNESS, "collect_summary", side_effect=RuntimeError("boom")):
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.harness.guard(
                    "summary loop", self.harness.poll_summary, time.monotonic())

        self.assertIsNone(self.harness.summary_context)
        self.assertIsNone(self.harness.summary_job)
        self.assertIsNotNone(self.proc.poll(), "실행 중이던 자식은 kill한다")
        self.assertFalse(Path(self.job.tmpdir).exists())
        messages = [
            json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()
        ]
        failed = [
            message for message in messages
            if message.get("type") == "status" and message.get("state") == "failed"
        ]
        self.assertTrue(failed, "key가 busy로 남지 않게 status failed를 보낸다")
        self.assertIn("RuntimeError", failed[-1]["message"])
        self.assertEqual(
            self.log.error_stream.getvalue().count("RuntimeError"), 1,
            "같은 예외가 report_exception과 guard에서 두 번 로그되면 안 된다")


def _process_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


class BuildBoardTest(unittest.TestCase):
    def test_null_distros_resolve_to_the_wsl_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            overview = {"workspaces": [workspace(1, "w", "/w", None)]}
            entries = HARNESS.build_board(overview, tmp, None, None)
            self.assertEqual(entries[0]["state"], "none")
            self.assertEqual(entries[0]["reason"], "no_transcript")

    def test_board_caps_at_64_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            overview = {"workspaces": [
                workspace(index, "w%d" % index, "/w/%d" % index, None)
                for index in range(1, 70)
            ]}
            entries = HARNESS.build_board(overview, tmp, None, None)
            self.assertEqual(len(entries), 64)
            self.assertEqual(entries[0]["workspaceId"], 1)
            self.assertEqual(entries[-1]["workspaceId"], 64)


if __name__ == "__main__":
    unittest.main()
