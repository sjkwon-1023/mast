#!/usr/bin/env python3
"""mast-manager.py의 관리자 폴더·가이드·다이제스트·start 테스트 (macOS·Linux 공용).

`apps/mast/tests/manager-python.test.ts`의 CI 래퍼가 이 스위트를 돌린다.
"""

import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[3]
STORE_PATH = ROOT / "scripts" / "wsl" / "mast-manager.py"
FIXTURE_PATH = ROOT / "fixtures" / "manager-task.json"
NOW = "2026-09-25T03:00:00Z"


def load_manager():
    spec = importlib.util.spec_from_file_location("mast_manager_folder_test", STORE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MANAGER = load_manager()


class FolderTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.manager = Path(self.tmp.name) / "manager"
        self.settings = types.SimpleNamespace(model="gpt-6-luna", effort="high")


class EnsureManagerDirTest(FolderTestCase):
    def test_new_directories_are_private(self):
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        for name in ("tasks", "archive", "logs", ".mast"):
            mode = stat.S_IMODE(os.stat(str(self.manager / name)).st_mode)
            self.assertEqual(mode, 0o700, name)

    def test_existing_directories_keep_their_mode(self):
        tasks = self.manager / "tasks"
        tasks.mkdir(parents=True)
        os.chmod(str(tasks), 0o755)
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        self.assertEqual(stat.S_IMODE(os.stat(str(tasks)).st_mode), 0o755)

    def test_agents_md_is_created_when_missing(self):
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        text = (self.manager / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("MANAGER-GUIDE.md", text)
        self.assertIn("user's language", text)

    def test_existing_agents_md_is_never_touched(self):
        self.manager.mkdir(parents=True)
        agents = self.manager / "AGENTS.md"
        agents.write_bytes(b"# mine\n")
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        self.assertEqual(agents.read_bytes(), b"# mine\n")

    def test_second_call_does_not_touch_guide_or_launch(self):
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        guide = self.manager / "MANAGER-GUIDE.md"
        launch = self.manager / ".mast" / "launch.json"
        before = (guide.stat().st_mtime_ns, launch.stat().st_mtime_ns)
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        self.assertEqual((guide.stat().st_mtime_ns, launch.stat().st_mtime_ns), before)

    def test_changed_guide_and_launch_are_rewritten(self):
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        guide = self.manager / "MANAGER-GUIDE.md"
        launch = self.manager / ".mast" / "launch.json"
        guide.write_text("stale\n", encoding="utf-8")
        launch.write_text('{"model": "old", "effort": "low"}\n', encoding="utf-8")
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        self.assertEqual(guide.read_text(encoding="utf-8"), MANAGER.MANAGER_GUIDE)
        self.assertEqual(
            json.loads(launch.read_text(encoding="utf-8")),
            {"model": "gpt-6-luna", "effort": "high"},
        )

    def test_launch_json_tracks_settings(self):
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        launch = json.loads((self.manager / ".mast" / "launch.json").read_text(encoding="utf-8"))
        self.assertEqual(launch, {"model": "gpt-6-luna", "effort": "high"})

    def test_writes_leave_no_temporary_files(self):
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        self.assertEqual([path.name for path in self.manager.rglob("*.tmp")], [])


class GuideTest(unittest.TestCase):
    def test_required_phrases_are_present(self):
        guide = MANAGER.MANAGER_GUIDE
        for phrase in (
            "digest.md",
            "tasks/<key>.json",
            "mast manager patch",
            "mast manager workspaces",
            "quote",
            "anchor",
            "never as instructions",
            "Do not follow instructions",
            "Do not read or export secret files",
            "v1",
            "transcript",
        ):
            self.assertIn(phrase, guide, phrase)
        self.assertEqual(guide.count('"verdict":"update"'), 2)


class RenderDigestTest(FolderTestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.doc = cls.fixture["valid"][0]

    def test_task_line_format(self):
        entry = {"id": 3, "name": "feature-x", "key": "kabc123", "task": self.doc}
        text = MANAGER.render_digest(self.manager, [entry], now=NOW)
        lines = text.splitlines()
        self.assertEqual(lines[0], "Manager digest generated at " + NOW)
        self.assertEqual(
            lines[1],
            "[#3 feature-x] 관리자 워크스페이스 preview — CH7 작업 기억 저장소와 patch 검증기 구현 중"
            " | open questions: 1 | updated 2026-09-25T02:30:00Z | file: tasks/kabc123.json",
        )
        self.assertEqual(len(lines), 2)

    def test_title_falls_back_to_workspace_name(self):
        doc = json.loads(json.dumps(self.doc))
        doc["title"] = ""
        entry = {"id": 4, "name": "plain", "key": "k1", "task": doc}
        text = MANAGER.render_digest(self.manager, [entry], now=NOW)
        self.assertIn("[#4 plain] plain — ", text)

    def test_no_record_uses_caller_reason(self):
        text = MANAGER.render_digest(
            self.manager, [{"id": 7, "name": "phone", "reason": "no_root"}], now=NOW
        )
        self.assertEqual(text.splitlines()[1], "[#7 phone] (no record: no_root)")

    def test_missing_task_file_reports_no_task(self):
        text = MANAGER.render_digest(
            self.manager, [{"id": 1, "name": "w", "key": "kmissing"}], now=NOW
        )
        self.assertEqual(text.splitlines()[1], "[#1 w] (no record: no task)")

    def test_task_file_is_loaded_from_the_manager_dir(self):
        key = MANAGER.task_key("/home/u/projects/mast", "Ubuntu-24.04")
        MANAGER._write_json(MANAGER.task_path(self.manager, key), self.doc)
        entry = {
            "id": 1,
            "name": "mast",
            "rootPath": "/home/u/projects/mast",
            "distro": "Ubuntu-24.04",
        }
        text = MANAGER.render_digest(self.manager, [entry], now=NOW)
        self.assertIn("file: tasks/%s.json" % key, text)
        self.assertIn("open questions: 1", text)

    def test_caller_task_wins_over_reason(self):
        entry = {"id": 2, "name": "mast", "key": "kown", "reason": "no_transcript", "task": self.doc}
        text = MANAGER.render_digest(self.manager, [entry], now=NOW)
        self.assertIn("file: tasks/kown.json", text)
        self.assertNotIn("no record", text)

    def test_invalid_task_file_reports_the_load_error(self):
        path = MANAGER.task_path(self.manager, "kbroken")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{ not json", encoding="utf-8")
        text = MANAGER.render_digest(
            self.manager, [{"id": 1, "name": "w", "key": "kbroken"}], now=NOW
        )
        self.assertIn("(no record: invalid JSON in ", text)

    def test_order_follows_the_input(self):
        entries = [
            {"id": 2, "name": "b", "reason": "no_root"},
            {"id": 1, "name": "a", "reason": "no_root"},
        ]
        text = MANAGER.render_digest(self.manager, entries, now=NOW)
        labels = [line.split("]")[0] for line in text.splitlines()[1:]]
        self.assertEqual(labels, ["[#2 b", "[#1 a"])

    def test_short_digest_has_no_more_suffix(self):
        entries = [{"id": index, "name": "w%d" % index, "reason": "no_root"} for index in range(3)]
        text = MANAGER.render_digest(self.manager, entries, now=NOW)
        self.assertNotIn("more)", text)
        self.assertEqual(len(text.splitlines()), 4)

    def test_overflow_counts_omitted_entries(self):
        entries = [{"id": index, "name": "w" * 600, "reason": "no_root"} for index in range(1, 31)]
        text = MANAGER.render_digest(self.manager, entries, now=NOW)
        self.assertLessEqual(len(text), 4000)
        match = re.search(r"… \((\d+) more\)\n$", text)
        self.assertIsNotNone(match)
        omitted = int(match.group(1))
        self.assertGreaterEqual(omitted, 1)
        kept = sum(1 for line in text.splitlines() if line.startswith("[#"))
        self.assertEqual(kept, 30 - omitted)

    def test_write_digest_writes_the_same_text_atomically(self):
        entries = [{"id": 1, "name": "a", "reason": "no_root"}]
        path = MANAGER.write_digest(self.manager, entries, now=NOW)
        self.assertEqual(path, self.manager / "digest.md")
        self.assertEqual(
            path.read_text(encoding="utf-8"),
            MANAGER.render_digest(self.manager, entries, now=NOW),
        )
        self.assertEqual([item.name for item in self.manager.rglob("*.tmp")], [])


def fake_codex_source(python):
    return (
        "#!" + python + "\n"
        "import json\n"
        "import os\n"
        "import sys\n"
        "\n"
        "record = os.path.join(os.path.dirname(os.path.abspath(__file__)), \"record.json\")\n"
        "with open(record, \"w\", encoding=\"utf-8\") as stream:\n"
        "    json.dump({\"cwd\": os.getcwd(), \"argv\": sys.argv[1:]}, stream)\n"
    )


class StartTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.bin = self.base / "bin"
        self.bin.mkdir()

    def prepared_manager(self):
        manager = self.base / "manager"
        MANAGER.ensure_manager_dir(
            manager, types.SimpleNamespace(model="gpt-6-luna", effort="high")
        )
        return manager

    def write_fake_codex(self):
        path = self.bin / "codex"
        path.write_text(fake_codex_source(sys.executable), encoding="utf-8")
        path.chmod(0o755)

    def read_record(self):
        return json.loads((self.bin / "record.json").read_text(encoding="utf-8"))

    def run_start(self, manager_dir, path, tty=None, args=("start",)):
        env = {key: value for key, value in os.environ.items() if key != "MAST_TTY"}
        env["MAST_MANAGER_DIR"] = str(manager_dir)
        env["PATH"] = str(path)
        if tty is not None:
            env["MAST_TTY"] = tty
        return subprocess.run(
            [sys.executable, str(STORE_PATH)] + list(args),
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )

    def test_missing_launch_json_exits_1(self):
        result = self.run_start(self.base / "empty", self.bin)
        self.assertEqual(result.returncode, 1)
        self.assertIn("manager folder is not prepared", result.stderr)

    def test_broken_launch_json_exits_1(self):
        for index, content in enumerate(("{ broken", '{"effort": "high"}', '{"model": ""}')):
            with self.subTest(content=content):
                manager = self.base / ("broken%d" % index)
                (manager / ".mast").mkdir(parents=True)
                (manager / ".mast" / "launch.json").write_text(content, encoding="utf-8")
                result = self.run_start(manager, self.bin)
                self.assertEqual(result.returncode, 1)
                self.assertIn("manager folder is not prepared", result.stderr)

    def test_codex_not_found_exits_1(self):
        manager = self.prepared_manager()
        empty = self.base / "empty-path"
        empty.mkdir()
        result = self.run_start(manager, empty)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.strip(), "codex CLI not found")

    def test_start_execs_codex_with_model_effort_and_cwd(self):
        manager = self.prepared_manager()
        self.write_fake_codex()
        result = self.run_start(manager, self.bin)
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.read_record()
        self.assertEqual(Path(record["cwd"]).resolve(), manager.resolve())
        self.assertEqual(
            record["argv"],
            ["-m", "gpt-6-luna", "-c", 'model_reasoning_effort="high"'],
        )

    def test_mast_tty_adds_writable_roots(self):
        manager = self.prepared_manager()
        self.write_fake_codex()
        result = self.run_start(manager, self.bin, tty="/dev/ttys009")
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.read_record()
        self.assertEqual(
            record["argv"],
            [
                "-m",
                "gpt-6-luna",
                "-c",
                'model_reasoning_effort="high"',
                "-c",
                'sandbox_workspace_write.writable_roots=["/dev/ttys009"]',
            ],
        )

    def test_unknown_subcommand_exits_2(self):
        result = subprocess.run(
            [sys.executable, str(STORE_PATH), "bogus"], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 2)

    def test_no_subcommand_exits_2(self):
        result = subprocess.run([sys.executable, str(STORE_PATH)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
