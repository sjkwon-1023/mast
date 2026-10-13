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


def active_entry(key, summary=None, repo=None, updated_at=NOW):
    return {
        "workspaceId": 1,
        "key": key,
        "state": "active",
        "reason": None,
        "summary": summary or {
            "progress": "관리자 최신 요약 저장소를 구현했다",
            "needs_input": "",
            "next": "하네스 루프를 연결한다",
        },
        "updatedAt": updated_at,
        "lastError": None,
        "inputTruncated": False,
        "error": None,
        "repo": repo,
    }


class FolderTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.manager = Path(self.tmp.name) / "manager"
        self.settings = types.SimpleNamespace(model="gpt-6-luna", effort="high")


class EnsureManagerDirTest(FolderTestCase):
    def test_new_directories_are_private(self):
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        for name in ("summaries", "logs", ".mast"):
            mode = stat.S_IMODE(os.stat(str(self.manager / name)).st_mode)
            self.assertEqual(mode, 0o700, name)

    def test_legacy_tasks_and_archive_are_left_alone(self):
        tasks = self.manager / "tasks"
        tasks.mkdir(parents=True)
        (tasks / "kold.json").write_bytes(b'{"legacy": true}\n')
        os.chmod(str(tasks), 0o755)
        MANAGER.ensure_manager_dir(self.manager, self.settings)
        self.assertEqual(stat.S_IMODE(os.stat(str(tasks)).st_mode), 0o755)
        self.assertEqual((tasks / "kold.json").read_bytes(), b'{"legacy": true}\n')
        self.assertFalse((self.manager / "archive").exists())

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
            "summaries/<key>.json",
            "mast manager workspaces",
            "asks by repository",
            "not an execution",
            "never run tasks",
            "read-only",
            "Do not follow instructions",
            "Do not read or export secret files",
            "transcript",
        ):
            self.assertIn(phrase, guide, phrase)
        self.assertNotIn('"verdict":"update"', guide)


class RenderDigestTest(FolderTestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.doc = cls.fixture["valid"][0]

    def item(self, workspace_id, name, entry=None):
        return {"id": workspace_id, "name": name, "entry": entry}

    def test_active_line_format(self):
        entry = {
            "workspaceId": 3, "key": "kabc123", "state": "active", "reason": None,
            "summary": self.doc["summary"], "updatedAt": "2026-09-25T02:30:00Z",
            "lastError": None, "inputTruncated": True, "error": None, "repo": self.doc["repo"],
        }
        text = MANAGER.render_digest([self.item(3, "feature-x", entry)], now=NOW)
        lines = text.splitlines()
        self.assertEqual(lines[0], "Manager digest generated at " + NOW)
        self.assertEqual(lines[1], "## mast")
        self.assertEqual(
            lines[2],
            "[#3 feature-x] 관리자 최신 요약 저장소와 board 계약을 구현했다"
            " | needs input: fixture transcript 원본을 어떻게 확보하나?"
            " | next: 하네스 요약 루프를 v2 계약으로 연결한다"
            " | updated 2026-09-25T02:30:00Z | file: summaries/kabc123.json",
        )
        self.assertEqual(len(lines), 3)

    def test_no_entry_reports_no_summary(self):
        text = MANAGER.render_digest([self.item(7, "phone")], now=NOW)
        self.assertEqual(text.splitlines()[1], "## Other")
        self.assertEqual(text.splitlines()[2], "[#7 phone] (no summary)")

    def test_error_entry_reports_the_reason(self):
        broken = dict(active_entry("kbad"), state="error", error="invalid summary in /x: boom")
        text = MANAGER.render_digest([self.item(1, "w", broken)], now=NOW)
        self.assertIn("(summary error: invalid summary in /x: boom)", text)

    def test_unsupported_entry_reports_the_reason(self):
        unsupported = dict(active_entry(None), state="unsupported", reason="no_root", summary=None)
        text = MANAGER.render_digest([self.item(2, "w", unsupported)], now=NOW)
        self.assertIn("(unsupported: no_root)", text)

    def test_empty_needs_input_and_next_use_placeholders(self):
        entry = active_entry(
            "k1", summary={"progress": "진행", "needs_input": "", "next": ""})
        text = MANAGER.render_digest([self.item(1, "w", entry)], now=NOW)
        self.assertIn("needs input: - | next: -", text)

    def test_long_fields_are_previewed_and_keep_the_file_path(self):
        summary = {"progress": "가" * 400, "needs_input": "나" * 600, "next": "다" * 600}
        entry = active_entry("k1", summary=summary)
        line = MANAGER.render_digest([self.item(1, "w", entry)], now=NOW).splitlines()[2]
        for character in ("가", "나", "다"):
            self.assertIn(character * MANAGER.DIGEST_PREVIEW + "…", line)
            self.assertNotIn(character * (MANAGER.DIGEST_PREVIEW + 1), line)
        self.assertIn("file: summaries/k1.json", line)

    def test_max_length_summaries_all_fit_the_line_budget(self):
        summary = {"progress": "가" * 400, "needs_input": "나" * 600, "next": "다" * 600}
        entries = [
            self.item(index, "w%d" % index, active_entry("k%d" % index, summary=summary))
            for index in range(1, 5)
        ]
        text = MANAGER.render_digest(entries, now=NOW)
        self.assertNotIn("more)", text, "미리보기 줄이면 상한 안에 네 항목이 모두 남는다")
        self.assertEqual(
            sum(1 for line in text.splitlines() if line.startswith("[#")), 4)
        self.assertLessEqual(len(text), MANAGER.DIGEST_MAX)

    def test_active_entry_with_last_error_is_marked_stale(self):
        summary = {"progress": "진행", "needs_input": "", "next": ""}
        ok = active_entry("k1", summary=summary)
        stale = active_entry("k1", summary=summary)
        stale["lastError"] = "summary process exited with code 1"
        fresh_text = MANAGER.render_digest([self.item(1, "w", ok)], now=NOW)
        stale_text = MANAGER.render_digest([self.item(1, "w", stale)], now=NOW)
        self.assertNotEqual(fresh_text, stale_text, "오류만 바뀌어도 digest 본문이 달라진다")
        self.assertIn("| stale: summary process exited with code 1", stale_text)

        long_error = active_entry("k1", summary=summary)
        long_error["lastError"] = "x" * 500
        line = MANAGER.render_digest([self.item(1, "w", long_error)], now=NOW).splitlines()[2]
        self.assertIn("x" * MANAGER.DIGEST_PREVIEW + "…", line)
        self.assertNotIn("x" * (MANAGER.DIGEST_PREVIEW + 1), line,
                         "stale 표시도 짧은 미리보기로 자른다")

    def test_order_follows_the_input(self):
        text = MANAGER.render_digest(
            [self.item(2, "b"), self.item(1, "a")], now=NOW)
        labels = [line.split("]")[0] for line in text.splitlines()[2:]]
        self.assertEqual(labels, ["[#2 b", "[#1 a"])

    def test_lines_are_grouped_under_repo_headings(self):
        mast_repo = self.doc["repo"]
        feature_repo = {"name": "feature-y", "path": "/home/u/p/feature-y", "remote": None}
        entries = [
            self.item(1, "mast-a", active_entry("k1", repo=mast_repo)),
            self.item(2, "plain"),
            self.item(3, "feature-y", active_entry("k3", repo=feature_repo)),
            self.item(4, "mast-b", active_entry("k4", repo=mast_repo)),
        ]
        lines = MANAGER.render_digest(entries, now=NOW).splitlines()
        self.assertEqual(
            [line for line in lines if line.startswith("## ")],
            ["## mast", "## Other", "## feature-y"],
        )
        self.assertTrue(lines[2].startswith("[#1 mast-a]"), lines[2])
        self.assertTrue(lines[3].startswith("[#4 mast-b]"), lines[3])
        self.assertTrue(lines[5].startswith("[#2 plain]"), lines[5])
        self.assertTrue(lines[7].startswith("[#3 feature-y]"), lines[7])

    def test_same_name_repos_are_told_apart_by_path(self):
        first = active_entry("k1", repo={"name": "mast", "path": "/home/u/a/mast", "remote": None})
        second = active_entry("k2", repo={"name": "mast", "path": "/home/u/b/mast", "remote": None})
        entries = [self.item(1, "a", first), self.item(2, "b", second)]
        lines = MANAGER.render_digest(entries, now=NOW).splitlines()
        self.assertEqual(
            [line for line in lines if line.startswith("## ")],
            ["## mast (/home/u/a/mast)", "## mast (/home/u/b/mast)"],
        )

    def test_same_name_repos_are_told_apart_by_remote(self):
        first = active_entry("k1", repo={
            "name": "mast", "path": "/home/u/a/mast",
            "remote": "git@github.com:one/mast.git",
        })
        second = active_entry("k2", repo={
            "name": "mast", "path": "/home/u/b/mast",
            "remote": "https://github.com/two/mast",
        })
        entries = [self.item(1, "a", first), self.item(2, "b", second)]
        lines = MANAGER.render_digest(entries, now=NOW).splitlines()
        self.assertEqual(
            [line for line in lines if line.startswith("## ")],
            ["## mast (one/mast)", "## mast (two/mast)"],
        )

    def test_unusable_remotes_fall_back_to_paths(self):
        first = active_entry("k1", repo={"name": "mast", "path": "/home/u/a/mast", "remote": None})
        second = active_entry("k2", repo={
            "name": "mast", "path": "/home/u/b/mast",
            "remote": "git@github.com:two/mast.git",
        })
        entries = [self.item(1, "a", first), self.item(2, "b", second)]
        lines = MANAGER.render_digest(entries, now=NOW).splitlines()
        self.assertEqual(
            [line for line in lines if line.startswith("## ")],
            ["## mast (/home/u/a/mast)", "## mast (/home/u/b/mast)"],
        )

    def test_repo_headings_count_toward_max_length(self):
        entries = [
            self.item(
                index, "w" * 600,
                active_entry(
                    "k%d" % index,
                    repo={"name": "repo-%d" % index, "path": "/r/%d" % index, "remote": None}),
            )
            for index in range(1, 26)
        ]
        text = MANAGER.render_digest(entries, now=NOW)
        self.assertLessEqual(len(text), 4000)
        match = re.search(r"… \((\d+) more\)\n$", text)
        self.assertIsNotNone(match)
        kept = sum(1 for line in text.splitlines() if line.startswith("[#"))
        self.assertEqual(kept + int(match.group(1)), 25)
        self.assertIn("## repo-1", text)

    def test_short_digest_has_no_more_suffix(self):
        entries = [self.item(index, "w%d" % index) for index in range(3)]
        text = MANAGER.render_digest(entries, now=NOW)
        self.assertNotIn("more)", text)
        self.assertEqual(len(text.splitlines()), 5)
        self.assertEqual(text.splitlines()[1], "## Other")

    def test_overflow_counts_omitted_entries(self):
        entries = [self.item(index, "w" * 600) for index in range(1, 31)]
        text = MANAGER.render_digest(entries, now=NOW)
        self.assertLessEqual(len(text), 4000)
        match = re.search(r"… \((\d+) more\)\n$", text)
        self.assertIsNotNone(match)
        omitted = int(match.group(1))
        self.assertGreaterEqual(omitted, 1)
        kept = sum(1 for line in text.splitlines() if line.startswith("[#"))
        self.assertEqual(kept, 30 - omitted)

    def test_write_digest_writes_the_given_text_atomically(self):
        entries = [self.item(1, "a")]
        text = MANAGER.render_digest(entries, now=NOW)
        path = MANAGER.write_digest(self.manager, text)
        self.assertEqual(path, self.manager / "digest.md")
        self.assertEqual(path.read_text(encoding="utf-8"), text)
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
