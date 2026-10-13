#!/usr/bin/env python3
"""mast-manager-harness.py의 하네스 루프(프로토콜·보드·시작 점검) 테스트 (macOS·Linux 공용).

`apps/mast/tests/manager-python.test.ts`의 CI 래퍼가 이 스위트를 돌린다.
하네스를 서브프로세스로 띄워 stdin에 hello/snapshot/events 줄을 쓰고
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

# CH9의 대역처럼 argv·stdin·호출 횟수를 기록하고 준비한 요약 출력을 -o 경로로 복사한다.
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

NO_CHANGE_OUTPUT = {
    "summary": {"progress": "요약을 적용했다", "needs_input": "", "next": ""},
    "notify_reason": None,
}


def summary_output(progress="요약을 적용했다", needs_input="", next_step="", reason=None):
    return {
        "summary": {"progress": progress, "needs_input": needs_input, "next": next_step},
        "notify_reason": reason,
    }


ACTIVE_ROOT = "/home/u/p/x"
OTHER_ROOT = "/home/u/p/y"
PLAIN_ROOT = "/home/u/p/z"
SILENT_ROOT = "/home/u/p/w"
BROKEN_ROOT = "/home/u/p/broken"
EMPTY_ROOT = "/home/u/p/arch"
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


def git_run(root, *args):
    """테스트용 git 실행. 실패하면 stderr를 담은 AssertionError."""
    result = subprocess.run(
        ["git", "-C", str(root)] + list(args),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    if result.returncode != 0:
        raise AssertionError("git %s failed: %s" % (
            " ".join(args), result.stderr.decode("utf-8", "replace")))
    return result.stdout.decode("utf-8", "replace")


def real_path(path):
    """git이 돌려주는 절대 경로에 맞춘 realpath (macOS `/var` 심볼릭 링크)."""
    return os.path.realpath(str(path))


def make_harness(manager_dir):
    """단위 테스트용 하네스 — hello/settings/log만 준비하고 overview는 각 테스트가 채운다."""
    hello = {
        "managerDir": str(manager_dir),
        "managerDistro": "Ubuntu",
        "defaultDistro": "Ubuntu",
        "settings": {"idleSeconds": 1},
    }
    settings = HARNESS._hello_settings(hello)
    log = HARNESS.HarnessLog(
        Path(manager_dir) / "logs" / "harness.log", error_stream=io.StringIO())
    return HARNESS.Harness(hello, settings, log, None, HARNESS._parse_args([]))


def make_bare_worktree(base, name="mast"):
    """`<base>/<name>/.bare` 베어 컨테이너와 커밋이 있는 워크트리를 만든다."""
    seed = base / (name + "-seed")
    seed.mkdir()
    git_run(seed, "init", "-b", "main")
    git_run(seed, "config", "user.email", "tests@example.com")
    git_run(seed, "config", "user.name", "Repo Test")
    (seed / "README.md").write_text("seed\n", encoding="utf-8")
    git_run(seed, "add", ".")
    git_run(seed, "commit", "-m", "seed")
    repo = base / name
    bare = repo / ".bare"
    bare.parent.mkdir()
    git_run(seed, "clone", "--bare", ".", str(bare))
    git_run(bare, "remote", "remove", "origin")
    worktree = repo / "wt"
    git_run(bare, "worktree", "add", str(worktree))
    return repo, bare, worktree


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

    def write_login_shell(self, codex_path=None, codex_home=None, noise=False,
                          stdin_record=None, path_value=None):
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
        lines.append("printf '__MAST_PATH__%s\\n' " + sh_quote(
            self.login_path if path_value is None else path_value))
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

    def hello(self, protocol=2):
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
                workspace(7, "arch", EMPTY_ROOT, None),
                workspace(8, "manager", MANAGER_ROOT, "Ubuntu", manager=True),
            ],
        }

    def seed_summary(self, root_path, distro=None, doc=None):
        if doc is None:
            doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
        path = self.manager / "summaries" / (STORE.task_key(root_path, distro) + ".json")
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
        self.seed_summary("/home/u/p/first", None)
        newest = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
        newest["meta"]["last_collected_at"] = "2026-09-25T05:00:00Z"
        self.seed_summary("/home/u/p/second", None, doc=newest)
        run = self.start_harness()
        run.send(self.hello())
        self.expect_status(run, "starting")
        ready = self.expect_status(run, "ok")
        self.assertEqual(ready["lastCollectedAt"], "2026-09-25T05:00:00Z")

    def test_protocol_mismatch_is_unsupported_and_exits_3(self):
        run = self.start_harness()
        run.send(self.hello(protocol=1))
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

    def test_login_shell_noise_only_output_is_an_error(self):
        self.shell_path.write_text("#!/bin/sh\nprintf '%s\\n' 'noise'\n", encoding="utf-8")
        self.shell_path.chmod(0o755)
        run = self.start_harness()
        run.send(self.hello())
        self.expect_status(run, "starting")
        message = self.expect_status(run, "unsupported")
        self.assertEqual(message["message"], "the login shell printed no PATH")
        self.assertEqual(run.wait(), 3)

    def test_fish_style_space_joined_path_is_normalized(self):
        other = self.base / "other-bin"
        other.mkdir()
        self.write_login_shell(
            str(self.codex_path),
            path_value=str(self.bin) + " " + str(other))
        run = self.start_harness()
        run.send(self.hello())
        self.expect_status(run, "starting")
        ready = self.expect_status(run, "ok")
        self.assertEqual(ready["codexVersion"], FAKE_CODEX_VERSION,
                         "공백 결합 PATH를 콜론으로 정규화해 codex를 찾는다")

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
        self.seed_summary(ACTIVE_ROOT, None)
        broken = self.manager / "summaries" / (STORE.task_key(BROKEN_ROOT, None) + ".json")
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text("{ not json", encoding="utf-8")

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
        self.assertEqual(by_id[1]["summary"], TASK_FIXTURE["valid"][0]["summary"])
        self.assertEqual(by_id[1]["updatedAt"], TASK_FIXTURE["valid"][0]["meta"]["updated_at"])
        self.assertIsNone(by_id[1]["lastError"])
        self.assertTrue(by_id[1]["inputTruncated"])
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

        self.assertEqual(by_id[7]["state"], "none")

    def test_initial_empty_failure_document_is_not_an_active_card(self):
        doc = STORE.new_summary(ACTIVE_ROOT, None, "2026-09-25T00:00:00Z")
        doc["meta"]["last_error"] = "boom"
        self.seed_summary(ACTIVE_ROOT, None, doc)
        run = self.start_ok()
        run.send({"type": "snapshot", "overview": self.overview()})
        board = self.read_until(run, "board")
        entry = next(item for item in board["entries"] if item["workspaceId"] == 1)
        self.assertEqual(entry["state"], "error")
        self.assertEqual(entry["error"], "boom")
        self.assertIsNone(entry["summary"])
        self.assertEqual(entry["updatedAt"], "2026-09-25T00:00:00Z")

    def test_empty_summary_documents_are_not_active_cards(self):
        # metadata-only 빠른 경로: 수집 시각만 있고 내용이 없다 → none.
        empty = STORE.new_summary(ACTIVE_ROOT, None, "2026-09-25T00:00:00Z")
        empty["meta"]["last_collected_at"] = "2026-09-25T01:00:00Z"
        self.seed_summary(ACTIVE_ROOT, None, empty)
        # 최초 실패 뒤 빠른 경로: last_collected_at이 채워져도 오류 카드다.
        failed = STORE.new_summary(SILENT_ROOT, None, "2026-09-25T00:00:00Z")
        failed["meta"]["last_collected_at"] = "2026-09-25T01:00:00Z"
        failed["meta"]["last_error"] = "boom"
        self.seed_summary(SILENT_ROOT, None, failed)

        run = self.start_ok()
        run.send({"type": "snapshot", "overview": {
            "nextSeq": 1,
            "workspaces": [
                workspace(1, "feature-x", ACTIVE_ROOT, None),
                workspace(5, "silent", SILENT_ROOT, None),
            ],
        }})
        board = self.read_until(run, "board")
        by_id = {entry["workspaceId"]: entry for entry in board["entries"]}
        self.assertEqual(by_id[1]["state"], "none")
        self.assertIsNone(by_id[1]["summary"])
        self.assertEqual(by_id[5]["state"], "error")
        self.assertEqual(by_id[5]["error"], "boom")

    def test_missing_required_keys_are_error_cards_without_stopping_the_board(self):
        self.seed_summary(ACTIVE_ROOT, None)
        damaged = {}
        for index, mutate in enumerate((
                lambda doc: doc.pop("repo"),
                lambda doc: doc["meta"].pop("last_collected_at"),
                lambda doc: doc["meta"].pop("last_error")), start=1):
            root = "/home/u/p/damaged-%d" % index
            doc = STORE.new_summary(root, None, "2026-09-25T00:00:00Z")
            doc["summary"] = {"progress": "이전 진행", "needs_input": "", "next": ""}
            mutate(doc)
            damaged[root] = self.seed_summary(root, None, doc).read_bytes()
        # 시작 scan과 board가 잘못된 UTF-8 저장본 한 건에서 멈추지 않고 error 카드로 격리한다.
        utf8_root = "/home/u/p/damaged-utf8"
        utf8_path = self.manager / "summaries" / (STORE.task_key(utf8_root, None) + ".json")
        utf8_path.parent.mkdir(parents=True, exist_ok=True)
        utf8_path.write_bytes(b"\xff\xfe\x00")
        damaged[utf8_root] = utf8_path.read_bytes()

        run = self.start_ok()
        run.send({"type": "snapshot", "overview": {
            "nextSeq": 1,
            "workspaces": [workspace(1, "feature-x", ACTIVE_ROOT, None)] + [
                workspace(2 + offset, "damaged-%d" % (offset + 1), root, None)
                for offset, root in enumerate(list(damaged)[:3])
            ] + [workspace(5, "damaged-utf8", utf8_root, None)],
        }})
        board = self.read_until(run, "board")
        by_id = {entry["workspaceId"]: entry for entry in board["entries"]}
        self.assertEqual(by_id[1]["state"], "active", "정상 카드는 계속 표시된다")
        for workspace_id in (2, 3, 4):
            entry = by_id[workspace_id]
            self.assertEqual(entry["state"], "error")
            self.assertIn("missing", entry["error"])
        self.assertEqual(by_id[5]["state"], "error")
        self.assertIn("invalid UTF-8", by_id[5]["error"])
        for root, before in damaged.items():
            path = self.manager / "summaries" / (STORE.task_key(root, None) + ".json")
            self.assertEqual(path.read_bytes(), before, "손상 원본은 바뀌지 않는다")

    def test_failed_but_collected_document_stays_active_with_last_error(self):
        doc = STORE.new_summary(ACTIVE_ROOT, None, "2026-09-25T00:00:00Z")
        doc["meta"]["last_collected_at"] = "2026-09-25T01:00:00Z"
        doc["summary"] = {"progress": "이전 진행", "needs_input": "", "next": ""}
        doc["meta"]["last_error"] = "later failure"
        self.seed_summary(ACTIVE_ROOT, None, doc)
        run = self.start_ok()
        run.send({"type": "snapshot", "overview": self.overview()})
        board = self.read_until(run, "board")
        entry = next(item for item in board["entries"] if item["workspaceId"] == 1)
        self.assertEqual(entry["state"], "active")
        self.assertEqual(entry["lastError"], "later failure")
        self.assertEqual(entry["summary"]["progress"], "이전 진행")

    def test_board_reports_the_bare_worktree_repo(self):
        repo, _, worktree = make_bare_worktree(self.base)
        run = self.start_ok()
        run.send({"type": "snapshot", "overview": {
            "nextSeq": 1,
            "workspaces": [workspace(
                4, "wt", str(worktree), None, tabs=[terminal_tab(4, claude_session())])],
        }})
        board = self.read_until(run, "board")
        self.assertEqual(
            board["entries"][0]["repo"],
            {"name": "mast", "path": real_path(repo), "remote": None},
        )
        digest = (self.manager / "digest.md").read_text(encoding="utf-8")
        self.assertIn("## mast\n", digest, "digest가 entry의 repo로 묶는다")

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
        self.assertIsNone(entry["summary"])

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
        self.seed_summary(ACTIVE_ROOT, None)
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
        self.seed_summary(ACTIVE_ROOT, None)
        run = self.start_ok()
        run.send({"type": "snapshot", "overview": self.overview()})
        self.read_until(run, "board")
        digest = (self.manager / "digest.md").read_text(encoding="utf-8")
        self.assertIn("[#1 feature-x]", digest)
        self.assertIn(TASK_FIXTURE["valid"][0]["summary"]["progress"], digest)
        self.assertNotIn("[#8 manager]", digest)

    def test_invalid_lines_do_not_stop_the_loop(self):
        run = self.start_ok()
        run.send_raw(b"this is not json\n")
        run.send({"type": "mystery", "noise": 1})
        run.send_raw(b"x" * (HARNESS.MAX_INPUT_LINE_BYTES + 17) + b"\n")
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
        # 이 집계 위에서 question 알림은 생략된다.
        self.assertIsNone(HARNESS.decide_notify(
            "question", {"progress": "p", "needs_input": "배포는 언제 하나?", "next": ""},
            overview["workspaces"][0]["agentStatus"]))

        HARNESS._apply_event(overview, {
            "kind": "status", "workspace": event_workspace, "tab": 4,
            "status": "idle", "message": "cleared", "agentSession": None,
        })
        self.assertEqual(overview["workspaces"][0]["agentStatus"], "idle")


class ReservationIdentityTest(unittest.TestCase):
    """root가 바뀌어도 예약은 예약 당시의 root로 남는다(실제 core 순서: closed → opened → session)."""

    def make(self):
        harness = HARNESS.Harness.__new__(HARNESS.Harness)
        harness.manager_distro = None
        harness.default_distro = None
        harness.pending = []
        harness.pending_refs = {}
        harness.pending_immediate = {}
        harness.pending_successors = set()
        harness.idle_timers = {}
        harness.waiting_since = {}
        harness.event_sessions = {}
        harness.idle_seconds = 45
        harness.overview = {"nextSeq": 0, "workspaces": [
            {"id": 1, "name": "w", "rootPath": "/old", "distro": None, "tabs": []}]}
        return harness

    def apply(self, harness, kind, root):
        event = {"kind": kind, "workspace": {
            "id": 1, "name": "w", "rootPath": root, "distro": None}, "tab": None}
        harness.note_event(event)
        HARNESS._apply_event(harness.overview, event)

    def test_reserved_old_root_is_not_replaced_by_the_new_live_root(self):
        harness = self.make()
        harness.reserve(harness.overview["workspaces"][0])
        self.apply(harness, "workspaceClosed", "/old")
        self.apply(harness, "workspaceOpened", "/new")

        self.assertEqual(harness.pending_refs[1]["rootPath"], "/old")
        self.assertEqual(harness.pending_workspace(1)["rootPath"], "/old")
        self.assertIn(1, harness.pending_successors)

    def test_new_root_requests_survive_the_old_reservation_being_consumed(self):
        harness = self.make()
        self.apply(harness, "workspaceClosed", "/old")
        self.apply(harness, "workspaceOpened", "/new")
        live = harness.overview["workspaces"][0]
        harness.reserve(live, immediate=True)
        self.assertEqual(harness.pending_workspace(1)["rootPath"], "/old")

        harness.drop_reservation(1)
        harness.reserve(live, immediate=True)
        self.assertEqual(harness.pending_workspace(1)["rootPath"], "/new")

    def test_same_root_reservation_follows_the_live_state(self):
        harness = self.make()
        harness.reserve(harness.overview["workspaces"][0])
        harness.overview["workspaces"][0]["agentStatus"] = "running"
        self.assertEqual(harness.pending_workspace(1)["agentStatus"], "running")

    def test_repeated_root_changes_keep_the_original_reservation(self):
        harness = self.make()
        harness.reserve(harness.overview["workspaces"][0])
        for kind, root in (("workspaceClosed", "/old"), ("workspaceOpened", "/new"),
                           ("workspaceClosed", "/new"), ("workspaceOpened", "/third")):
            self.apply(harness, kind, root)
        self.assertEqual(harness.pending_workspace(1)["rootPath"], "/old")

    def test_uncollectible_old_root_does_not_drop_the_new_request(self):
        harness = self.make()
        self.apply(harness, "workspaceClosed", "/old")
        self.apply(harness, "workspaceOpened", "/new")
        harness.log = io.StringIO()
        harness.workspace_key = lambda workspace: (
            None if workspace["rootPath"] == "/old" else "k")
        harness.start_collection(1)
        self.assertEqual(harness.pending_workspace(1)["rootPath"], "/new")
        self.assertEqual(harness.pending, [1])

    def test_collection_failure_is_reported_against_its_original_root(self):
        harness = self.make()
        harness.reserve(harness.overview["workspaces"][0], immediate=True)
        harness.summary_job = None
        failures = []

        def fail_collection(workspace_id):
            harness.drop_reservation(workspace_id)
            harness.overview["workspaces"][0] = {
                "id": 1, "rootPath": "/new", "distro": None, "tabs": []}
            harness.reserve(harness.overview["workspaces"][0], immediate=True)
            raise OSError("collection failed")

        harness.start_collection = fail_collection
        harness.report_exception = lambda action, error, **fields: failures.append(fields)
        harness.poll_summary_step(0)
        self.assertEqual(failures[0]["workspace"]["rootPath"], "/old")
        self.assertEqual(harness.pending_workspace(1)["rootPath"], "/new")


class RepoRootEventTest(unittest.TestCase):
    def test_workspace_opened_adds_and_refreshes_the_repo_root(self):
        overview = {"nextSeq": 0, "workspaces": []}
        ref = {"id": 1, "name": "w", "rootPath": "/w", "repoRoot": "/r", "distro": None}
        HARNESS._apply_event(overview, {"kind": "workspaceOpened", "workspace": ref})
        self.assertEqual(overview["workspaces"][0]["repoRoot"], "/r")
        HARNESS._apply_event(overview, {
            "kind": "workspaceOpened", "workspace": dict(ref, repoRoot=None)})
        self.assertIsNone(overview["workspaces"][0]["repoRoot"])
        self.assertEqual(len(overview["workspaces"]), 1)

    def test_repo_source_prefers_the_repo_root(self):
        self.assertEqual(HARNESS._repo_source({"rootPath": "/w", "repoRoot": "/r"}), "/r")
        self.assertEqual(HARNESS._repo_source({"rootPath": "/w", "repoRoot": None}), "/w")
        self.assertEqual(HARNESS._repo_source({"rootPath": "/w"}), "/w")


class CollectibleTest(unittest.TestCase):
    """대상 판정: workspace_key가 관리자·root 없음·다른 배포판을 제외한다(보드 읽기와 분리)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.manager = self.base / "manager"
        self.harness = make_harness(self.manager)

    def test_excluded_workspaces_have_no_key(self):
        self.assertIsNone(self.harness.workspace_key(
            workspace(1, "manager", "/w/1", None, manager=True)))
        self.assertIsNone(self.harness.workspace_key(workspace(2, "no-root", None, None)))
        self.assertIsNone(self.harness.workspace_key(workspace(3, "other", "/w/3", "Debian")))

        plain = workspace(5, "plain", "/w/5", None, tabs=[terminal_tab(5, claude_session())])
        self.assertIsNotNone(self.harness.workspace_key(plain))

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


class RepoDetectionTest(unittest.TestCase):
    """detect_repo: 공통 디렉터리 파싱과 실제 git 저장소 레이아웃."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def init_repo(self, path):
        """커밋이 있는 일반 레포를 만들고 경로를 돌려준다."""
        path.mkdir()
        git_run(path, "init", "-b", "main")
        git_run(path, "config", "user.email", "tests@example.com")
        git_run(path, "config", "user.name", "Repo Test")
        (path / "README.md").write_text("seed\n", encoding="utf-8")
        git_run(path, "add", ".")
        git_run(path, "commit", "-m", "seed")
        return path

    def test_common_dir_parsing(self):
        cases = [
            ("/home/u/p/mast/.bare", {"name": "mast", "path": "/home/u/p/mast"}),
            ("/home/u/p/x/.git", {"name": "x", "path": "/home/u/p/x"}),
            ("/home/u/p/x.git", {"name": "x", "path": "/home/u/p/x.git"}),
            ("/home/u/p/plain", {"name": "plain", "path": "/home/u/p/plain"}),
        ]
        for common_dir, expected in cases:
            self.assertEqual(HARNESS.repo_from_common_dir(common_dir), expected)
        for value in (None, "", "   ", "/"):
            self.assertIsNone(HARNESS.repo_from_common_dir(value))

    def test_plain_repository_uses_the_git_parent(self):
        root = self.base / "plain"
        root.mkdir()
        git_run(root, "init", "-b", "main")
        self.assertEqual(
            HARNESS.detect_repo(str(root)),
            {"name": "plain", "path": real_path(root), "remote": None},
        )

    def test_bare_container_worktree_uses_the_parent_directory(self):
        repo, bare, worktree = make_bare_worktree(self.base)
        expected = {"name": "mast", "path": real_path(repo), "remote": None}
        self.assertEqual(HARNESS.detect_repo(str(worktree)), expected)
        self.assertEqual(HARNESS.detect_repo(str(bare)), expected)

    def test_bare_repository_with_git_suffix(self):
        bare = self.base / "x.git"
        git_run(self.base, "init", "--bare", str(bare))
        self.assertEqual(
            HARNESS.detect_repo(str(bare)),
            {"name": "x", "path": real_path(bare), "remote": None},
        )

    def test_origin_remote_is_reported(self):
        root = self.base / "with-remote"
        root.mkdir()
        git_run(root, "init", "-b", "main")
        git_run(root, "remote", "add", "origin", "git@github.com:example/mast.git")
        self.assertEqual(
            HARNESS.detect_repo(str(root)),
            {"name": "with-remote", "path": real_path(root),
             "remote": "git@github.com:example/mast.git"},
        )

    def test_non_git_and_missing_roots_are_null(self):
        plain = self.base / "not-a-repo"
        plain.mkdir()
        self.assertIsNone(HARNESS.detect_repo(str(plain)))
        self.assertIsNone(HARNESS.detect_repo(str(self.base / "missing")))
        self.assertIsNone(HARNESS.detect_repo(None))

    def test_git_failure_is_null(self):
        root = self.base / "broken"
        root.mkdir()
        with mock.patch.object(HARNESS, "_git", return_value=(False, "", "boom")) as fake:
            self.assertIsNone(HARNESS.detect_repo(str(root)))
        self.assertEqual(fake.call_count, 1, "공통 디렉터리 질의가 실패하면 원격은 묻지 않는다")

    def test_common_dir_resolution(self):
        self.assertEqual(HARNESS._resolve_common_dir("/root", ".git\n"), "/root/.git")
        self.assertEqual(HARNESS._resolve_common_dir("/root", "sub/../.git\n"), "/root/.git")
        for output in ("", "   \n", "--path-format=absolute\n.git\n"):
            self.assertIsNone(HARNESS._resolve_common_dir("/root", output))

    def test_old_git_flag_echo_is_null(self):
        root = self.base / "flag-echo"
        root.mkdir()
        with mock.patch.object(
                HARNESS, "_git", return_value=(True, "--path-format=absolute\n.git\n", "")):
            self.assertIsNone(HARNESS.detect_repo(str(root)))

    def test_old_git_superproject_flag_echo_is_not_a_submodule(self):
        root = self.base / "old-git"
        root.mkdir()
        with mock.patch.object(
                HARNESS, "_git",
                side_effect=[
                    (True, str(root / ".git") + "\n", ""),
                    (True, "--show-superproject-working-tree\n", ""),
                    (False, "", "no remote")]) as git:
            repo = HARNESS.detect_repo(str(root))
        self.assertEqual(repo, {"name": "old-git", "path": str(root), "remote": None})
        self.assertNotIn(["rev-parse", "--show-toplevel"], [call.args[1] for call in git.call_args_list])

    def test_relative_common_dir_is_resolved_against_the_root(self):
        root = self.base / "relative"
        root.mkdir()
        with mock.patch.object(
                HARNESS, "_git",
                side_effect=[
                    (True, ".git\n", ""), (True, "\n", ""), (False, "", "no remote")]):
            repo = HARNESS.detect_repo(str(root))
        self.assertEqual(repo, {"name": "relative", "path": real_path(root), "remote": None})

    def test_plain_subdirectory_uses_the_repository_root(self):
        root = self.init_repo(self.base / "plain-sub")
        sub = root / "sub"
        sub.mkdir()
        self.assertEqual(
            HARNESS.detect_repo(str(sub)),
            {"name": "plain-sub", "path": real_path(root), "remote": None},
        )

    def test_bare_worktree_subdirectory_uses_the_repository_root(self):
        repo, _bare, worktree = make_bare_worktree(self.base, "bare-sub")
        sub = worktree / "sub"
        sub.mkdir()
        self.assertEqual(
            HARNESS.detect_repo(str(sub)),
            {"name": "bare-sub", "path": real_path(repo), "remote": None},
        )

    def test_linked_worktree_uses_the_main_repository(self):
        root = self.init_repo(self.base / "linked-main")
        linked = self.base / "linked-wt"
        git_run(root, "worktree", "add", str(linked))
        self.assertEqual(
            HARNESS.detect_repo(str(linked)),
            {"name": "linked-main", "path": real_path(root), "remote": None},
        )

    def test_submodule_uses_the_worktree_top_level(self):
        origin = self.init_repo(self.base / "sub-origin")
        super_repo = self.init_repo(self.base / "sub-super")
        git_run(super_repo, "-c", "protocol.file.allow=always",
                "submodule", "add", str(origin), "sub")
        sub = super_repo / "sub"
        git_run(sub, "remote", "remove", "origin")
        self.assertEqual(
            HARNESS.detect_repo(str(sub)),
            {"name": "sub", "path": real_path(sub), "remote": None},
        )

    def test_bare_worktree_submodule_uses_the_worktree_top_level(self):
        origin = self.init_repo(self.base / "bare-sub-origin")
        _repo, _bare, worktree = make_bare_worktree(self.base, "bare-submodule")
        git_run(worktree, "-c", "protocol.file.allow=always",
                "submodule", "add", str(origin), "libs/sub")
        sub = worktree / "libs" / "sub"
        git_run(sub, "remote", "remove", "origin")
        self.assertEqual(
            HARNESS.detect_repo(str(sub)),
            {"name": "sub", "path": real_path(sub), "remote": None},
        )

    def test_remote_credentials_are_not_recorded(self):
        root = self.base / "with-token"
        root.mkdir()
        git_run(root, "init", "-b", "main")
        git_run(root, "remote", "add", "origin", "https://tok@github.com/o/r.git")
        self.assertEqual(
            HARNESS.detect_repo(str(root))["remote"], "https://github.com/o/r.git")

    def test_remote_without_userinfo_parsing(self):
        cases = [
            ("https://tok@github.com/o/r.git", "https://github.com/o/r.git"),
            ("https://u:p@h/x", "https://h/x"),
            ("ssh://git@github.com/o/r.git", "ssh://github.com/o/r.git"),
            ("git@github.com:o/r.git", "git@github.com:o/r.git"),
        ]
        for remote, expected in cases:
            with self.subTest(remote=remote):
                self.assertEqual(HARNESS._remote_without_userinfo(remote), expected)
        for value in ("", "   ", "https://", None, 7):
            with self.subTest(value=value):
                self.assertIsNone(HARNESS._remote_without_userinfo(value))

    def test_remote_cleanup_drops_query_fragment_and_scp_credentials(self):
        cases = [
            # file 원문은 유지한다(자격 증명이 없는 스킴).
            ("file:///srv/git/r.git", "file:///srv/git/r.git"),
            ("file://server/share/r.git", "file://server/share/r.git"),
            # 쿼리·fragment의 토큰은 저장하지 않는다.
            ("https://host/o/r.git?access_token=abc", "https://host/o/r.git"),
            ("https://host/o/r.git#main", "https://host/o/r.git"),
            ("https://u:p@host/o/r.git?x=1#f", "https://host/o/r.git"),
            ("ssh://git@host:22/o/r.git", "ssh://host:22/o/r.git"),
            # scp 형식은 `@` 앞에 `:`가 있을 때만 자격 증명을 뗀다.
            ("u:tok@host:o/r.git", "host:o/r.git"),
            ("git@github.com:o/r.git", "git@github.com:o/r.git"),
            # 경로에 `@`가 있는 정상 원격과 로컬 경로는 자르지 않는다.
            ("git@host:org/repo@v2.git", "git@host:org/repo@v2.git"),
            ("user@host:/srv/git/pkg@1.0.git", "user@host:/srv/git/pkg@1.0.git"),
            ("/home/u/a:b@c/repo.git", "/home/u/a:b@c/repo.git"),
            ("C:/Users/first.last@corp/r.git", "C:/Users/first.last@corp/r.git"),
        ]
        for remote, expected in cases:
            with self.subTest(remote=remote):
                self.assertEqual(HARNESS._remote_without_userinfo(remote), expected)

    def test_long_values_are_clipped(self):
        common_dir = "/" + "d" * 1100 + "/" + "n" * 200
        parsed = HARNESS.repo_from_common_dir(common_dir)
        self.assertEqual(len(parsed["name"]), 200)
        root = self.base / "long"
        root.mkdir()
        git_run(root, "init", "-b", "main")
        with mock.patch.object(HARNESS, "_git", side_effect=[
            (True, common_dir + "\n", ""),
            (True, "\n", ""),
            (True, "r" * 1100 + "\n", ""),
        ]):
            repo = HARNESS.detect_repo(str(root))
        self.assertEqual(len(repo["name"]), STORE.MAX_REPO_NAME)
        self.assertEqual(len(repo["path"]), STORE.MAX_REPO_PATH)
        self.assertEqual(len(repo["remote"]), STORE.MAX_REPO_REMOTE)


class RepoCacheTest(unittest.TestCase):
    """캐시: 같은 root는 하네스 수명 동안 한 번만 계산하고, 보드는 git을 부르지 않는다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.manager = self.base / "manager"
        self.harness = make_harness(self.manager)
        self.calls = []
        self.root = self.base / "root"
        self.root.mkdir()

    def fake_git(self, root_path, args):
        self.calls.append((str(root_path), tuple(args)))
        return False, "", "not a repository"

    def overview(self, workspaces):
        return {"nextSeq": 0, "workspaces": workspaces}

    def test_collection_fills_the_cache_for_a_workspace_closed_before_prewarm(self):
        # 같은 배치에서 열리고 닫혀 prewarm을 거치지 않은 워크스페이스도 수집 전에 판별한다.
        root = str(self.root)
        self.harness.overview = self.overview([])
        self.harness.pending_refs[7] = workspace(7, "gone", root, "Ubuntu")
        self.harness.pending.append(7)
        with mock.patch.object(HARNESS, "_git", side_effect=self.fake_git), \
                mock.patch.object(self.harness, "drop_reservation"):
            self.harness.start_collection(7)
        self.assertIn(root, self.harness.repos)
        self.assertTrue(any(args[:1] == ("rev-parse",) for _, args in self.calls))

    def test_each_root_is_detected_once(self):
        root = str(self.root)
        self.harness.overview = self.overview([
            workspace(1, "w", root, None),
            workspace(2, "w2", root, None),
        ])
        with mock.patch.object(HARNESS, "_git", side_effect=self.fake_git):
            self.harness.prewarm_repos()
            detected = len(self.calls)
            self.harness.prewarm_repos()
            self.assertEqual(self.harness.repo_for(root), None)
            self.assertEqual(len(self.calls), detected)
            self.assertEqual(detected, 1, "같은 root는 한 번만 계산한다")
            self.assertIn(root, self.harness.repos)

    def timeout_git(self, root_path, args):
        self.calls.append((str(root_path), tuple(args)))
        return False, "", "git rev-parse --git-common-dir timed out"

    def test_transient_failure_is_not_cached_and_waits_for_the_retry_window(self):
        root = str(self.root)
        self.harness.repo_retry_seconds = 0.05
        replies = [
            (False, "", "git rev-parse --git-common-dir timed out"),
            (False, "", "git rev-parse --git-common-dir failed: exit 128"),
        ]
        with mock.patch.object(HARNESS, "_git", side_effect=replies) as fake:
            self.assertIsNone(self.harness.repo_for(root))
            self.assertNotIn(root, self.harness.repos, "일시 실패는 캐시하지 않는다")
            self.assertIsNone(self.harness.repo_for(root), "창 안에서는 캐시 미스로 본다")
            self.assertEqual(fake.call_count, 1, "창 안에서는 다시 판별하지 않는다")
            time.sleep(0.06)
            self.assertIsNone(self.harness.repo_for(root))
            self.assertEqual(fake.call_count, 2, "다음 창에서 다시 판별한다")
        self.assertIn(root, self.harness.repos, "비git null은 캐시해도 된다")
        self.assertNotIn(root, self.harness.repo_failures)

    def test_remote_query_timeout_is_not_cached_and_waits_for_the_retry_window(self):
        root = str(self.root)
        self.harness.repo_retry_seconds = 0.05
        replies = [
            (True, ".git\n", ""),
            (True, "\n", ""),
            (False, "", "git config --get remote.origin.url timed out"),
            (True, ".git\n", ""),
            (True, "\n", ""),
            (True, "git@github.com:o/r.git\n", ""),
        ]
        with mock.patch.object(HARNESS, "_git", side_effect=replies) as fake:
            self.assertIsNone(self.harness.repo_for(root))
            self.assertNotIn(root, self.harness.repos, "원격 질의 일시 실패도 캐시하지 않는다")
            self.assertIsNone(self.harness.repo_for(root))
            self.assertEqual(fake.call_count, 3, "창 안에서는 다시 판별하지 않는다")
            time.sleep(0.06)
            repo = self.harness.repo_for(root)
            self.assertEqual(fake.call_count, 6, "다음 창에서 다시 판별한다")
        self.assertEqual(repo["remote"], "git@github.com:o/r.git")
        self.assertEqual(self.harness.repos[root], repo)

    def test_events_do_not_retry_a_failing_root_within_the_window(self):
        root = str(self.root)
        self.harness.overview = self.overview([workspace(1, "w", root, None)])
        event = {
            "kind": "session",
            "workspace": {"id": 1, "name": "w", "rootPath": root, "distro": None},
            "tab": 4, "status": None, "message": None, "agentSession": None,
        }
        with mock.patch.object(HARNESS, "_git", side_effect=self.timeout_git) as fake, \
                mock.patch.object(HARNESS, "_emit"):
            for _ in range(4):
                self.harness.on_events([event])
        self.assertEqual(fake.call_count, 1, "실패한 root는 창 안에서 다시 판별하지 않는다")
        self.assertNotIn(root, self.harness.repos)

    def test_events_retry_a_failing_root_in_the_next_window(self):
        root = str(self.root)
        self.harness.repo_retry_seconds = 0.05
        self.harness.overview = self.overview([workspace(1, "w", root, None)])
        event = {
            "kind": "session",
            "workspace": {"id": 1, "name": "w", "rootPath": root, "distro": None},
            "tab": 4, "status": None, "message": None, "agentSession": None,
        }
        with mock.patch.object(HARNESS, "_git", side_effect=self.timeout_git) as fake, \
                mock.patch.object(HARNESS, "_emit"):
            self.harness.on_events([event])
            self.harness.on_events([event])
            self.assertEqual(fake.call_count, 1)
            time.sleep(0.06)
            self.harness.on_events([event])
            self.assertEqual(fake.call_count, 2, "다음 창에서는 다시 시도한다")

    def test_manager_workspace_roots_are_not_prewarmed(self):
        self.harness.overview = self.overview([
            workspace(1, "mgr", str(self.root), None, manager=True),
        ])
        with mock.patch.object(HARNESS, "_detect_repo", return_value=(None, False)) as fake:
            self.harness.prewarm_repos()
        self.assertEqual(fake.call_count, 0, "관리자 워크스페이스의 root는 판별하지 않는다")

    def test_board_reads_the_cache_without_calling_git(self):
        plain = workspace(
            1, "w", str(self.root), None, tabs=[terminal_tab(4, claude_session())])
        self.harness.overview = self.overview([plain])
        with mock.patch.object(HARNESS, "_git", side_effect=self.fake_git):
            self.harness.prewarm_repos()
            detected = len(self.calls)
            entries = HARNESS.build_board(
                self.harness.overview, self.manager, "Ubuntu", "Ubuntu", self.harness.repos)
            self.assertEqual(len(self.calls), detected)
        self.assertIn("repo", entries[0])
        self.assertIsNone(entries[0]["repo"])

    def test_other_distro_workspaces_keep_repo_null_and_skip_git(self):
        root = str(self.root)
        self.harness.overview = self.overview([
            workspace(1, "ubuntu", root, None),
            workspace(2, "debian", root, "Debian"),
        ])
        detected = {"name": "repo", "path": root, "remote": None}
        with mock.patch.object(
                HARNESS, "_detect_repo", return_value=(detected, False)) as fake:
            self.harness.prewarm_repos()
            self.assertEqual(fake.call_count, 1, "다른 배포판의 root에는 git을 부르지 않는다")
            entries = HARNESS.build_board(
                self.harness.overview, self.manager, "Ubuntu", "Ubuntu", self.harness.repos)
        by_id = {entry["workspaceId"]: entry for entry in entries}
        self.assertEqual(by_id[1]["repo"], detected)
        self.assertIsNone(by_id[2]["repo"], "다른 배포판 워크스페이스에는 캐시를 붙이지 않는다")
        self.assertEqual(by_id[2]["reason"], "other_distro")


class WarmedEventReuseTest(unittest.TestCase):
    """warmed 하네스의 순수 status 이벤트는 저장 파일·git·보드/digest를 다시 만지지 않는다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.manager = self.base / "manager"
        self.root = self.base / "root"
        self.root.mkdir()
        self.harness = make_harness(self.manager)
        self.workspace = workspace(
            1, "w", str(self.root), None,
            tabs=[terminal_tab(4, claude_session("sess-one"))])
        self.harness.overview = {"nextSeq": 0, "workspaces": [self.workspace]}

    def status_event(self, status):
        return {
            "kind": "status",
            "workspace": {"id": 1, "name": "w", "rootPath": str(self.root), "distro": None},
            "tab": 4, "status": status, "message": None, "agentSession": None,
        }

    def session_event(self, session_id):
        return {
            "kind": "session",
            "workspace": {"id": 1, "name": "w", "rootPath": str(self.root), "distro": None},
            "tab": 4, "status": None, "message": None,
            "agentSession": claude_session(session_id),
        }

    def repo_event(self, repo_root):
        return {
            "kind": "workspaceOpened",
            "workspace": {"id": 1, "name": "w", "rootPath": str(self.root),
                          "repoRoot": repo_root, "distro": None},
            "tab": None, "status": None, "message": None, "agentSession": None,
        }

    def test_pure_status_events_reuse_the_warmed_state(self):
        emitted = []
        with mock.patch.object(
                HARNESS.MANAGER, "load_summary",
                wraps=HARNESS.MANAGER.load_summary) as load, \
                mock.patch.object(HARNESS, "_git") as git, \
                mock.patch.object(HARNESS, "_emit", side_effect=emitted.append):
            self.harness.on_events([self.status_event("needsInput")])
        self.assertEqual(load.call_count, 0, "순수 status 이벤트는 요약 파일을 다시 읽지 않는다")
        self.assertEqual(git.call_count, 0, "순수 status 이벤트는 git을 부르지 않는다")
        self.assertEqual(emitted, [], "순수 status 이벤트는 보드/digest를 다시 만들지 않는다")
        self.assertEqual(self.harness.pending, [1], "needsInput은 요약을 예약한다")
        self.assertTrue(self.harness.pending_immediate[1])
        self.assertEqual(self.workspace["agentStatus"], "needsInput", "live 상태는 갱신된다")

    def test_repo_root_update_does_not_reserve_a_catch_up(self):
        transcript = self.base / "session.jsonl"
        transcript.write_text("x\n", encoding="utf-8")
        key = self.harness.workspace_key(self.workspace)
        doc = HARNESS.MANAGER.new_summary(str(self.root), None, "2026-09-25T00:00:00Z")
        doc["meta"]["cursor"] = {"sess-one": {
            "agent": "claude", "transcript_path": str(transcript), "offset": 0, "tab": 4}}
        HARNESS.MANAGER.update_summary(
            self.manager, key, lambda current: doc,
            create=lambda: HARNESS.MANAGER.new_summary(
                str(self.root), None, "2026-09-25T00:00:00Z"))

        with mock.patch.object(
                HARNESS, "_git", return_value=(False, "", "not a repository")), \
                mock.patch.object(HARNESS, "_emit"):
            self.harness.on_events([self.repo_event(str(self.base / "group"))])
        self.assertEqual(
            self.harness.pending, [],
            "이미 있는 같은 key의 repoRoot 갱신은 catch-up을 예약하지 않는다")

        # 대조군: 같은 저장 커서를 가진 대상이 실제로 다시 열리면 따라잡기를 예약한다.
        self.harness.overview["workspaces"] = []
        with mock.patch.object(
                HARNESS, "_git", return_value=(False, "", "not a repository")), \
                mock.patch.object(HARNESS, "_emit"):
            self.harness.on_events([self.repo_event(str(self.base / "group"))])
        self.assertEqual(
            self.harness.pending, [1],
            "없던 대상의 workspaceOpened는 기존 cursor 증가분을 예약한다")

    def test_session_change_refreshes_the_board(self):
        self.harness.overview = {"nextSeq": 0, "workspaces": [
            workspace(1, "w", str(self.root), None, tabs=[terminal_tab(4)])]}
        entries = HARNESS.build_board(
            self.harness.overview, self.manager, "Ubuntu", "Ubuntu", self.harness.repos)
        self.assertEqual(entries[0]["reason"], "no_transcript")

        emitted = []
        with mock.patch.object(
                HARNESS, "_git", return_value=(False, "", "not a repository")), \
                mock.patch.object(HARNESS, "_emit", side_effect=emitted.append):
            self.harness.on_events([self.session_event("sess-two")])
        boards = [message for message in emitted if message.get("type") == "board"]
        self.assertEqual(len(boards), 1, "세션 변화는 보드를 한 번 갱신한다")
        entry = boards[0]["entries"][0]
        self.assertEqual(entry["state"], "none")
        self.assertIsNone(entry["reason"], "세션을 알면 no_transcript가 아니다")

    def test_a_saved_summary_refreshes_the_board_and_the_scalar(self):
        key = self.harness.workspace_key(self.workspace)
        doc = HARNESS.MANAGER.new_summary(str(self.root), None, "2026-09-25T00:00:00Z")
        doc["meta"]["last_collected_at"] = "2026-09-25T01:00:00Z"
        doc["summary"] = {"progress": "저장된 진행", "needs_input": "", "next": ""}
        HARNESS.MANAGER.update_summary(
            self.manager, key, lambda current: doc,
            create=lambda: HARNESS.MANAGER.new_summary(
                str(self.root), None, "2026-09-25T00:00:00Z"))

        emitted = []
        with mock.patch.object(HARNESS, "_emit", side_effect=emitted.append):
            self.harness.after_summary(1, {
                "pruned_sessions": [], "notify": None, "error": None, "doc": doc})
        boards = [message for message in emitted if message.get("type") == "board"]
        self.assertEqual(len(boards), 1, "저장 결과는 보드에 반영한다")
        entry = next(item for item in boards[0]["entries"] if item["workspaceId"] == 1)
        self.assertEqual(entry["state"], "active")
        self.assertEqual(entry["summary"]["progress"], "저장된 진행")
        digest = (self.manager / "digest.md").read_text(encoding="utf-8")
        self.assertIn("저장된 진행", digest)
        self.assertEqual(
            self.harness.latest_collected_at(), "2026-09-25T01:00:00Z",
            "성공 저장 결과의 lastCollectedAt scalar를 재사용한다")

    def test_digest_renders_once_and_keeps_an_unchanged_file(self):
        with mock.patch.object(
                HARNESS.MANAGER, "render_digest",
                wraps=HARNESS.MANAGER.render_digest) as render, \
                mock.patch.object(
                    HARNESS.MANAGER, "write_digest",
                    wraps=HARNESS.MANAGER.write_digest) as write, \
                mock.patch.object(HARNESS, "_emit"):
            self.harness.send_board()
            self.assertEqual(render.call_count, 1, "보드 한 번에 digest를 한 번만 렌더한다")
            self.assertEqual(write.call_count, 1)
            path = self.manager / "digest.md"
            self.assertEqual(path.read_text(encoding="utf-8"), write.call_args.args[1])
            mtime = path.stat().st_mtime_ns
            self.harness.send_board()
        self.assertEqual(render.call_count, 2, "내용이 같아도 비교를 위해 한 번만 렌더한다")
        self.assertEqual(write.call_count, 1, "본문이 같으면 다시 쓰지 않는다")
        self.assertEqual(path.stat().st_mtime_ns, mtime)


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

    def configure_codex(self, output=None, sleep=0.0, exit_code=0):
        doc = {
            "record": str(self.record),
            "pidfile": str(self.pidfile),
            "sleep": sleep,
            "exit": exit_code,
        }
        if output is not None:
            path = self.base / "output.json"
            path.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
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

    def summary_doc(self):
        path = self.manager / "summaries" / (STORE.task_key(str(self.repo), None) + ".json")
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
        """이벤트 배치를 보낸다. 순수 status 배치는 보드를 만들지 않으므로 기다리지 않고,
        구성·세션·root가 바뀌는 배치만 board를 기다려 처리 완료를 맞춘다."""
        run.send({"type": "events", "events": events, "nextSeq": next_seq})
        if any(event.get("kind") != "status" for event in events):
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
        self.configure_codex(output=summary_output(progress="CH11b 요약 루프를 연결했다"))
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        ready = self.expect_status(run, "ok", timeout=10.0)
        board = self.read_until(run, "board")

        doc = self.summary_doc()
        self.assertIsNotNone(doc)
        self.assertEqual(doc["summary"]["progress"], "CH11b 요약 루프를 연결했다")
        self.assertIsNone(doc["meta"]["last_error"])
        self.assertIsNotNone(doc["meta"]["last_collected_at"])
        self.assertNotIn("model", doc["meta"])
        self.assertIsNotNone(ready["lastCollectedAt"])
        self.assertEqual(len(self.codex_calls()), 1)
        entries = {entry["workspaceId"]: entry for entry in board["entries"]}
        self.assertEqual(entries[1]["summary"]["progress"], "CH11b 요약 루프를 연결했다")
        self.assertEqual(entries[1]["state"], "active")

    def test_needs_input_summarizes_immediately(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        started = time.monotonic()
        self.send_events(run, [self.event("status", tab=4, status="needsInput")])
        self.expect_status(run, "busy", timeout=5.0)
        self.assertLess(
            time.monotonic() - started, 2.0,
            "needsInput은 idleSeconds를 기다리지 않아야 한다")

    def test_same_tab_running_cancels_the_idle_timer(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.send_events(run, [self.event("status", tab=4, status="running")], next_seq=3)
        time.sleep(1.6)
        self.send_snapshot(run)
        self.assertEqual(self.codex_calls(), [])
        self.assertIsNone(self.summary_doc())

    def test_other_tab_running_defers_until_the_max_delay(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
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
        self.configure_codex(output=NO_CHANGE_OUTPUT)
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
        self.configure_codex(output=NO_CHANGE_OUTPUT)
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
        self.configure_codex(output=NO_CHANGE_OUTPUT)
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
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        first = self.summary_doc()
        self.assertEqual(len(self.codex_calls()), 1)

        self.send_events(run, [self.event("status", tab=4, status="idle")], next_seq=3)
        self.expect_status(run, "ok", timeout=5.0)
        self.read_until(run, "board")
        second = self.summary_doc()
        self.assertEqual(len(self.codex_calls()), 1, "빠른 경로는 codex를 부르지 않는다")
        self.assertEqual(second["summary"], first["summary"])
        self.assertGreaterEqual(
            second["meta"]["last_collected_at"], first["meta"]["last_collected_at"])

    def test_blank_progress_reports_failed_without_a_cursor_or_notify(self):
        self.configure_codex(output=summary_output(progress="   "))
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "failed", timeout=10.0)
        self.assertNotIn("notify", [m["type"] for m in messages])
        self.assertIn("summary.progress must not be blank", messages[-1]["message"])
        self.read_until(run, "board")

        doc = self.summary_doc()
        self.assertEqual(doc["meta"]["cursor"], {})
        self.assertIsNone(doc["meta"]["last_collected_at"])
        self.assertIn("must not be blank", doc["meta"]["last_error"])

    def test_oversized_output_reports_failed(self):
        big = summary_output(progress="x" * (HARNESS.SUMMARY_OUTPUT_MAX_BYTES + 10))
        self.configure_codex(output=big)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "failed", timeout=10.0)
        self.assertIn("exceeds 64 KiB", messages[-1]["message"])
        doc = self.summary_doc()
        self.assertIn("exceeds 64 KiB", doc["meta"]["last_error"])
        self.assertIsNone(doc["meta"]["last_collected_at"])

    def test_delta_cap_is_resumed_without_a_new_trigger(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
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
            doc = self.summary_doc()
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
        self.configure_codex(output=NO_CHANGE_OUTPUT)
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
        self.configure_codex(output=NO_CHANGE_OUTPUT, exit_code=1)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        failed = self.expect_status(run, "failed", timeout=10.0)
        self.assertIn("exited with code 1", failed["message"])
        self.read_until(run, "board")

        doc = self.summary_doc()
        self.assertEqual(doc["meta"]["cursor"], {})
        self.assertIsNone(doc["meta"]["last_collected_at"])
        self.assertIn("exited with code 1", doc["meta"]["last_error"])

        self.configure_codex(output=NO_CHANGE_OUTPUT, exit_code=0)
        self.send_events(run, [self.event("status", tab=4, status="idle")], next_seq=3)
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        doc = self.summary_doc()
        self.assertIsNone(doc["meta"]["last_error"])
        self.assertTrue(doc["meta"]["cursor"])
        self.assertEqual(len(self.codex_calls()), 2)

    def test_failed_summary_with_a_capped_delta_is_not_re_reserved(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT, exit_code=1)
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
        self.configure_codex(output=NO_CHANGE_OUTPUT)
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
        self.configure_codex(output=summary_output(
            needs_input="fixture transcript는 어디에 쓰나?", reason="question"))
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        notify = self.read_until(run, "notify", timeout=10.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(notify["workspaceId"], 1)
        self.assertEqual(notify["reason"], "question")
        self.assertEqual(notify["title"], "Needs your input")
        self.assertEqual(notify["body"], "fixture transcript는 어디에 쓰나?")

    def test_notify_is_suppressed_when_live_status_is_needs_input(self):
        self.configure_codex(output=summary_output(
            needs_input="fixture transcript는 어디에 쓰나?", reason="question"))
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="needsInput")])
        self.expect_status(run, "busy", timeout=5.0)
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "ok", timeout=10.0)
        self.assertNotIn("notify", [m["type"] for m in messages])
        self.assertEqual(len(self.codex_calls()), 1)

    def test_notify_is_not_repeated_for_the_same_summary(self):
        output = summary_output(needs_input="같은 질문", reason="question")
        self.configure_codex(output=output)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        self.expect_status(run, "busy", timeout=5.0)
        first = self.read_until(run, "notify", timeout=10.0)
        self.assertEqual(first["reason"], "question")
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        self.send_events(run, [self.event("status", tab=4, status="needsInput")], next_seq=3)
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "ok", timeout=10.0)
        self.assertNotIn("notify", [m["type"] for m in messages],
                         "같은 요약이면 알림을 다시 내지 않는다")

    def test_snapshot_catches_up_a_stale_cursor(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        doc = STORE.new_summary(str(self.repo), None, "2026-09-25T00:00:00Z")
        doc["meta"]["cursor"]["sess-one"] = {
            "agent": "claude",
            "transcript_path": str(self.transcript),
            "offset": 0,
            "tab": 4,
        }
        path = self.manager / "summaries" / (STORE.task_key(str(self.repo), None) + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")

        run = self.start_ok()
        self.send_snapshot(run)
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1)
        doc = self.summary_doc()
        size = self.transcript.stat().st_size
        offsets = [entry.get("offset") for entry in doc["meta"]["cursor"].values()]
        self.assertIn(size, offsets)

    def test_snapshot_catches_up_a_shrunk_transcript(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        doc = STORE.new_summary(str(self.repo), None, "2026-09-25T00:00:00Z")
        doc["meta"]["cursor"]["sess-one"] = {
            "agent": "claude",
            "transcript_path": str(self.transcript),
            "offset": self.transcript.stat().st_size + 10,
            "tab": 4,
        }
        path = self.manager / "summaries" / (STORE.task_key(str(self.repo), None) + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        run = self.start_ok()
        self.send_snapshot(run)
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1)

    def test_transcript_outside_the_allowed_root_is_rejected(self):
        outside = self.base / "outside"
        outside.mkdir()
        path = outside / "claude-session.jsonl"
        shutil.copyfile(str(TRANSCRIPT_FIXTURE), str(path))
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        run = self.start_ok()
        self.send_snapshot(run, overview=self.summary_overview(session_path=path))
        self.send_events(run, [self.event("status", tab=4, status="idle")])
        time.sleep(1.6)
        self.assertEqual(self.codex_calls(), [])
        self.assertIsNone(self.summary_doc())
        log = (self.manager / "logs" / "harness.log").read_text(encoding="utf-8")
        self.assertIn("outside the allowed roots", log)


class SummaryProcessTest(SummaryTestCase):
    def test_stdin_messages_are_processed_while_summarizing(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT, sleep=2.0)
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

    def test_summary_write_failure_reports_failed_and_keeps_running(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT, sleep=1.5)
        run = self.start_ok()
        self.send_snapshot(run)
        self.send_events(run, [self.event("status", tab=4, status="needsInput")])
        self.expect_status(run, "busy", timeout=5.0)
        self.wait_until(self.pidfile.exists, timeout=5.0, message="the fake codex pid file")

        summaries = self.manager / "summaries"
        summaries.mkdir(parents=True, exist_ok=True)
        summaries.chmod(0o500)
        self.addCleanup(summaries.chmod, 0o700)
        messages = self.collect_until(
            run, lambda m: m["type"] == "status" and m["state"] == "failed", timeout=10.0)
        self.assertFalse((self.manager / "archive").exists())

        board = self.send_snapshot(run)
        self.assertEqual(board["entries"][0]["state"], "none",
                         "실패 뒤에도 루프가 돌아 보드를 낸다")

    def test_stdin_eof_kills_the_running_summary(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT, sleep=30.0)
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
    """닫기 뒤 마지막 수집, 재오픈 자동 재사용, snapshot 조정, 공유 키, root 변경 identity."""

    def key(self):
        return STORE.task_key(str(self.repo), None)

    def summary_path(self):
        return self.manager / "summaries" / (self.key() + ".json")

    def board_by_id(self, board):
        return {entry["workspaceId"]: entry for entry in board["entries"]}

    def seed_cursor_summary(self):
        doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
        doc["meta"]["cursor"] = {"sess-one": {
            "agent": "claude", "transcript_path": str(self.transcript), "offset": 0, "tab": 4,
        }}
        return self.seed_summary(str(self.repo), None, doc=doc)

    NOTIFY_OUTPUT = {
        "summary": {
            "progress": "transcript를 수집했다",
            "needs_input": "fixture transcript는 어디에 쓰나?",
            "next": "",
        },
        "notify_reason": "question",
    }

    def root_change_events(self, next_root, with_session=True):
        # 코어의 SetWorkspaceRoot 가 내는 순서: 옛 루트 closed → 새 루트 opened → session.
        opened = self.event("workspaceOpened")
        opened["workspace"]["rootPath"] = str(next_root)
        events = [self.event("workspaceClosed"), opened]
        if with_session:
            session = self.event("session", tab=4, agent_session=self.session())
            session["workspace"]["rootPath"] = str(next_root)
            events.append(session)
        return events

    def test_workspace_closed_without_a_summary_does_nothing(self):
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run, overview=self.summary_overview(tabs=[terminal_tab(4)]))
        self.send_events(run, [self.event("workspaceClosed", tab=4)])
        time.sleep(0.6)

        self.assertFalse(self.summary_path().exists())
        self.assertEqual(self.codex_calls(), [])

    def test_workspace_closed_without_a_collectible_session_keeps_the_file(self):
        doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
        doc["meta"]["cursor"] = {"sess-missing": {
            "agent": "claude", "transcript_path": str(self.base / "missing.jsonl"),
            "offset": 0, "tab": 4,
        }}
        summary = self.seed_summary(str(self.repo), None, doc=doc)
        before = summary.read_bytes()
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run, overview=self.summary_overview(tabs=[terminal_tab(4)]))
        self.send_events(run, [self.event("workspaceClosed", tab=4)])
        time.sleep(0.6)

        self.assertEqual(summary.read_bytes(), before)
        self.assertEqual(self.codex_calls(), [], "수집할 세션이 없으면 요약하지 않는다")

    def test_workspace_closed_keeps_the_summary_after_the_final_summary(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        self.send_events(run, [
            self.event("session", tab=4, agent_session=self.session()),
            self.event("workspaceClosed", tab=4),
        ])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        doc = self.summary_doc()
        self.assertTrue(doc["meta"]["cursor"])
        self.assertEqual(doc["summary"]["progress"], NO_CHANGE_OUTPUT["summary"]["progress"])
        self.assertEqual(len(self.codex_calls()), 1)
        self.assertFalse((self.manager / "archive").exists())

    def test_reopened_summary_is_shown_and_caught_up_without_an_action(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        self.seed_cursor_summary()
        run = self.start_ok()
        board = self.send_snapshot(run)
        entry = self.board_by_id(board)[1]
        self.assertEqual(entry["state"], "active")
        self.assertEqual(entry["summary"], TASK_FIXTURE["valid"][0]["summary"])

        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1, "재오픈은 커서 기반 따라잡기를 예약한다")

    def test_workspace_opened_event_catches_up_an_existing_cursor(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        self.seed_cursor_summary()
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run, overview={"nextSeq": 1, "workspaces": []})

        # 앱이 이미 실행 중인 상태에서 같은 key를 다시 연다 — status 이벤트 없이 opened만.
        self.send_events(run, [self.event("workspaceOpened")])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")
        self.assertEqual(len(self.codex_calls()), 1, "opened 이벤트가 커서 증가분을 수집한다")
        self.assertIn("throwaway session to record transcript fixtures",
                      self.codex_calls()[0]["stdin"])
        doc = self.summary_doc()
        self.assertEqual(doc["meta"]["cursor"]["sess-one"]["offset"],
                         self.transcript.stat().st_size)

        # 저장본 없는 신규 key는 열려도 즉시 예약하지 않는다.
        fresh_root = self.base / "fresh"
        fresh_root.mkdir()
        opened = self.event("workspaceOpened")
        opened["workspace"]["rootPath"] = str(fresh_root)
        self.send_events(run, [opened], next_seq=3)
        time.sleep(0.6)
        self.assertEqual(len(self.codex_calls()), 1, "신규 key는 요약을 예약하지 않는다")
        fresh_summary = self.manager / "summaries" / (
            STORE.task_key(str(fresh_root), None) + ".json")
        self.assertFalse(fresh_summary.exists())

    def test_root_change_collects_the_old_summary_last_and_starts_a_new_one(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        old_summary = self.seed_cursor_summary()
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        next_root = self.base / "repo-next"
        next_root.mkdir()
        self.send_events(run, self.root_change_events(next_root))

        next_summary = self.manager / "summaries" / (STORE.task_key(str(next_root), None) + ".json")
        self.wait_until(lambda: next_summary.exists(), message="the new root's summary")
        old_doc = json.loads(old_summary.read_text(encoding="utf-8"))
        self.assertGreater(old_doc["meta"]["cursor"]["sess-one"]["offset"], 0,
                           "옛 root의 마지막 수집은 옛 key의 파일에 남는다")
        doc = json.loads(next_summary.read_text(encoding="utf-8"))
        self.assertEqual(doc["meta"]["workspace_key"]["root_path"], str(next_root))
        self.assertIn("sess-one", doc["meta"]["cursor"], "살아 있는 세션을 새 요약이 이어 모은다")
        self.assertEqual(len(self.codex_calls()), 2, "옛 root 한 번, 새 root 한 번")

    def test_root_change_reservation_keeps_the_old_root_until_it_runs(self):
        """예약 시점 root가 실행에 그대로 쓰인다: live가 새 root여도 옛 key에 쓴다."""
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        self.seed_cursor_summary()
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        next_root = self.base / "repo-next"
        next_root.mkdir()
        self.send_events(run, self.root_change_events(next_root, with_session=False))
        self.collect_until(
            run, lambda message: message["type"] == "status" and message["state"] == "ok")
        doc = self.summary_doc()
        self.assertGreater(doc["meta"]["cursor"]["sess-one"]["offset"], 0)
        next_summary = self.manager / "summaries" / (STORE.task_key(str(next_root), None) + ".json")
        self.assertFalse(next_summary.exists(), "새 root 요청이 없으면 새 파일을 만들지 않는다")

    def test_same_root_summary_may_notify(self):
        self.configure_codex(output=self.NOTIFY_OUTPUT, sleep=0.5)
        self.seed_cursor_summary()
        run = self.start_ok()
        self.send_snapshot(run)
        self.expect_status(run, "busy", timeout=5.0)
        messages = self.collect_until(
            run, lambda message: message["type"] == "status" and message["state"] == "ok")
        self.assertEqual([m["type"] for m in messages].count("notify"), 1,
                         "root가 그대로면 이 요약은 알림을 낸다(아래 root 변경 테스트의 대조군)")

    def test_root_change_during_a_summary_writes_only_the_old_key(self):
        self.configure_codex(output=self.NOTIFY_OUTPUT, sleep=1.5)
        self.seed_cursor_summary()
        run = self.start_ok()
        self.send_snapshot(run)
        self.expect_status(run, "busy", timeout=5.0)

        next_root = self.base / "repo-next"
        next_root.mkdir()
        self.send_events(run, self.root_change_events(next_root))
        messages = self.collect_until(
            run, lambda message: message["type"] == "status" and message["state"] == "ok")
        self.read_until(run, "board")

        self.assertEqual([m for m in messages if m["type"] == "notify"], [],
                         "옛 root 요약의 알림은 새 root 작업으로 가지 않는다")
        doc = self.summary_doc()
        self.assertTrue(doc["meta"]["cursor"]["sess-one"]["offset"] > 0,
                        "이전 root 입력의 결과는 이전 key의 파일에 저장된다")
        next_summary = self.manager / "summaries" / (STORE.task_key(str(next_root), None) + ".json")
        self.assertFalse(next_summary.exists(), "새 root의 파일은 만들지 않는다")

    def test_workspace_closed_collects_sessions_added_after_an_idle_reservation(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
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

        doc = self.summary_doc()
        self.assertIn("sess-one", doc["meta"]["cursor"])
        self.assertIn("sess-b", doc["meta"]["cursor"],
                      "닫히기 전에 시작한 세션도 마지막 수집에 들어가야 한다")
        calls = self.codex_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("session B prompt", calls[0]["stdin"])

    def test_workspace_closed_collects_a_snapshot_session_without_a_reservation(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
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

        doc = self.summary_doc()
        self.assertIn("sess-one", doc["meta"]["cursor"],
                      "스냅샷으로만 알던 세션도 마지막 수집에 들어가야 한다")
        calls = self.codex_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("throwaway session to record transcript fixtures", calls[0]["stdin"])

    def test_tab_gone_and_workspace_closed_in_separate_batches_keep_the_session(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        self.send_events(run, [self.event("tabGone", tab=4), self.event("tabGone", tab=5)])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        self.send_events(run, [self.event("workspaceClosed", tab=4)], next_seq=3)
        self.wait_until(
            lambda: len(self.codex_calls()) >= 1, message="the final collection")
        doc = self.summary_doc()
        self.assertIn("sess-one", doc["meta"]["cursor"])
        calls = self.codex_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("throwaway session to record transcript fixtures", calls[0]["stdin"])

    def test_single_tab_gone_collects_the_snapshot_session_immediately(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        self.send_events(run, [self.event("tabGone", tab=4)])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "ok", timeout=10.0)
        self.read_until(run, "board")

        doc = self.summary_doc()
        self.assertIsNotNone(doc)
        self.assertIn("sess-one", doc["meta"]["cursor"])
        calls = self.codex_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("throwaway session to record transcript fixtures", calls[0]["stdin"])

    def test_same_key_workspaces_share_one_summary_file(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT)
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
        board = self.read_until(run, "board")

        entry = self.board_by_id(board)[2]
        self.assertEqual(entry["state"], "active")
        self.assertEqual(entry["key"], self.key())
        self.assertTrue(self.summary_path().exists())

    def test_snapshot_leaves_summaries_with_no_open_workspace_alone(self):
        stale_root = "/home/u/stale"
        other_root = "/home/u/other"
        paths = [
            self.seed_summary(stale_root, None),
            self.seed_summary(MANAGER_ROOT, "Ubuntu"),
            self.seed_summary(other_root, "Debian"),
        ]
        before = [path.read_bytes() for path in paths]
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

        self.assertEqual([path.read_bytes() for path in paths], before)
        self.assertFalse((self.manager / "archive").exists())

    def test_failed_final_summary_keeps_the_summary_and_the_cursor(self):
        self.configure_codex(output=NO_CHANGE_OUTPUT, exit_code=1)
        run = self.start_ok(idle_seconds=5)
        self.send_snapshot(run)
        self.send_events(run, [
            self.event("session", tab=4, agent_session=self.session()),
            self.event("workspaceClosed", tab=4),
        ])
        self.expect_status(run, "busy", timeout=5.0)
        self.expect_status(run, "failed", timeout=10.0)
        self.read_until(run, "board")

        doc = self.summary_doc()
        self.assertIn("exited with code 1", doc["meta"]["last_error"])
        self.assertEqual(doc["meta"]["cursor"], {}, "실패한 요약은 커서를 전진시키지 않는다")


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
        self.harness = make_harness(self.manager)
        self.log = self.harness.log
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

    def test_every_entry_has_a_repo_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            overview = {"workspaces": [
                workspace(1, "no-root", None, None),
                workspace(2, "plain", "/w/2", None),
            ]}
            entries = HARNESS.build_board(overview, tmp, None, None)
            self.assertEqual(set(entries[0]), BOARD_ENTRY_KEYS)
            self.assertEqual(set(entries[1]), BOARD_ENTRY_KEYS)
            self.assertIsNone(entries[0]["repo"])
            self.assertIsNone(entries[1]["repo"])

    def test_active_entry_falls_back_to_the_summary_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = Path(tmp) / "manager"
            doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
            path = manager / "summaries" / (STORE.task_key("/w/task", None) + ".json")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(doc), encoding="utf-8")
            overview = {"workspaces": [workspace(1, "w", "/w/task", None)]}
            entries = HARNESS.build_board(overview, manager, None, None)
            self.assertEqual(entries[0]["state"], "active")
            self.assertEqual(entries[0]["repo"], doc["repo"])

    def test_cache_value_wins_over_the_summary_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = Path(tmp) / "manager"
            doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
            path = manager / "summaries" / (STORE.task_key("/w/task", None) + ".json")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(doc), encoding="utf-8")
            overview = {"workspaces": [workspace(1, "w", "/w/task", None)]}
            cached = {"name": "cached", "path": "/w/cached", "remote": None}
            entries = HARNESS.build_board(overview, manager, None, None, {"/w/task": cached})
            self.assertEqual(entries[0]["state"], "active")
            self.assertEqual(entries[0]["repo"], cached)

    def test_repo_root_override_names_the_group_and_keeps_the_detected_remote(self):
        with tempfile.TemporaryDirectory() as tmp:
            item = workspace(1, "w", "/w/mast/main", None)
            item["repoRoot"] = "/w/mast/"
            detected = {"name": "other", "path": "/w/elsewhere", "remote": "git@h:o/mast.git"}
            entries = HARNESS.build_board(
                {"workspaces": [item]}, tmp, None, None, {"/w/mast/": detected})
            self.assertEqual(
                entries[0]["repo"],
                {"name": "mast", "path": "/w/mast/", "remote": "git@h:o/mast.git"})

    def test_repo_root_override_without_detection_has_no_remote(self):
        with tempfile.TemporaryDirectory() as tmp:
            item = workspace(1, "w", "/w/task", None)
            item["repoRoot"] = "/w/group"
            entries = HARNESS.build_board({"workspaces": [item]}, tmp, None, None, {})
            self.assertEqual(entries[0]["repo"], {"name": "group", "path": "/w/group", "remote": None})

    def test_cached_null_falls_back_to_the_summary_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = Path(tmp) / "manager"
            doc = json.loads(json.dumps(TASK_FIXTURE["valid"][0]))
            path = manager / "summaries" / (STORE.task_key("/w/task", None) + ".json")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(doc), encoding="utf-8")
            overview = {"workspaces": [workspace(1, "w", "/w/task", None)]}
            entries = HARNESS.build_board(overview, manager, None, None, {"/w/task": None})
            self.assertEqual(entries[0]["state"], "active")
            self.assertEqual(entries[0]["repo"], doc["repo"])
            item = dict(overview["workspaces"][0])
            item.update({"entry": entries[0]})
            text = STORE.render_digest([item], now="2026-09-25T03:00:00Z")
            self.assertIn("## mast", text, "보드와 digest가 같은 레포로 묶인다")
            self.assertNotIn("## Other", text)


if __name__ == "__main__":
    unittest.main()
