#!/usr/bin/env python3
"""mast-manager.py의 최신 요약 저장소·스키마 검증 단위 테스트 (macOS·Linux 공용).

`apps/mast/tests/manager-python.test.ts`의 CI 래퍼가 이 스위트를 돌린다.
"""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
STORE_PATH = ROOT / "scripts" / "wsl" / "mast-manager.py"
FIXTURE_PATH = ROOT / "fixtures" / "manager-task.json"
NOW = "2026-09-25T03:00:00Z"


def load_store():
    spec = importlib.util.spec_from_file_location("mast_manager_store_test", STORE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE = load_store()


def cursor_entry(offset=0, updated=None, tab=4):
    entry = {
        "agent": "claude",
        "transcript_path": "/tmp/sess-%d.jsonl" % offset,
        "offset": offset,
        "tab": tab,
    }
    if updated is not None:
        entry["updated"] = updated
    return entry


class StoreTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.valid = cls.fixture["valid"][0]

    def fresh(self):
        return copy.deepcopy(self.valid)


class TaskKeyAndPathsTest(unittest.TestCase):
    def test_task_key_matches_contract(self):
        expected = "k" + hashlib.sha256(
            ("Ubuntu-24.04\0/home/u/projects/mast").encode("utf-8")
        ).hexdigest()[:20]
        self.assertEqual(STORE.task_key("/home/u/projects/mast", "Ubuntu-24.04"), expected)
        self.assertEqual(len(expected), 21)
        self.assertEqual(STORE.task_key("/home/u", None), STORE.task_key("/home/u", ""))
        self.assertNotEqual(STORE.task_key("/a", "d1"), STORE.task_key("/a", "d2"))

    def test_paths(self):
        manager = Path("/tmp/manager")
        self.assertEqual(STORE.summary_path(manager, "k1"), manager / "summaries" / "k1.json")
        self.assertEqual(STORE.lock_path(manager), manager / ".mast" / "store.lock")


class NewSummaryAndValidateTest(StoreTestCase):
    def test_new_summary_is_empty_and_valid(self):
        doc = STORE.new_summary("/home/u/projects/mast", "Ubuntu-24.04", NOW)
        self.assertIsNone(STORE.validate_summary(doc))
        self.assertEqual(doc["meta"]["schema_version"], 2)
        self.assertEqual(doc["meta"]["updated_at"], NOW)
        self.assertIsNone(doc["meta"]["last_collected_at"])
        self.assertIsNone(doc["meta"]["last_error"])
        self.assertFalse(doc["meta"]["input_truncated"])
        self.assertEqual(doc["meta"]["cursor"], {})
        self.assertEqual(doc["meta"]["workspace_key"],
                         {"root_path": "/home/u/projects/mast", "distro": "Ubuntu-24.04"})
        self.assertEqual(doc["summary"], {"progress": "", "needs_input": "", "next": ""})
        self.assertIsNone(doc["repo"])

    def test_fixture_valid_document(self):
        self.assertIsNone(STORE.validate_summary(self.fresh()))

    def test_fixture_invalid_documents_are_rejected(self):
        for doc in self.fixture["invalid"]:
            self.assertIsNotNone(STORE.validate_summary(doc), "invalid fixture passed validation")

    def test_missing_nullable_required_keys_are_rejected(self):
        cases = [
            (lambda doc: doc.pop("repo"), "missing repo"),
            (lambda doc: doc["meta"].pop("last_collected_at"), "missing last_collected_at"),
            (lambda doc: doc["meta"].pop("last_error"), "missing last_error"),
        ]
        for mutate, snippet in cases:
            doc = self.fresh()
            mutate(doc)
            reason = STORE.validate_summary(doc)
            self.assertIsNotNone(reason, snippet)
            self.assertIn(snippet, reason)

    def test_unknown_top_level_key_is_rejected(self):
        doc = self.fresh()
        doc["title"] = "옛 필드"
        self.assertIn("unknown top-level key", STORE.validate_summary(doc))

    def test_meta_violations(self):
        cases = [
            (lambda doc: doc["meta"].__setitem__("schema_version", 1), "schema_version"),
            (lambda doc: doc["meta"].__setitem__("workspace_key", "x"), "workspace_key"),
            (lambda doc: doc["meta"]["workspace_key"].__setitem__("root_path", ""), "root_path"),
            (lambda doc: doc["meta"]["workspace_key"].__setitem__("distro", ""), "distro"),
            (lambda doc: doc["meta"].__setitem__("updated_at", "2026-09-25"), "updated_at"),
            (lambda doc: doc["meta"].__setitem__("last_collected_at", "yesterday"),
             "last_collected_at"),
            (lambda doc: doc["meta"].__setitem__("last_error", "x" * 1001), "last_error"),
            (lambda doc: doc["meta"].__setitem__("input_truncated", "yes"), "input_truncated"),
            (lambda doc: doc["meta"].__setitem__("cursor", []), "cursor"),
            (lambda doc: doc["meta"].__setitem__("model", "gpt"), "unknown keys"),
        ]
        for mutate, snippet in cases:
            doc = self.fresh()
            mutate(doc)
            reason = STORE.validate_summary(doc)
            self.assertIsNotNone(reason, snippet)
            self.assertIn(snippet, reason)

    def test_summary_type_and_length_caps(self):
        cases = [
            (lambda doc: doc["summary"].__setitem__("progress", 7), "summary.progress"),
            (lambda doc: doc["summary"].__setitem__("needs_input", None), "summary.needs_input"),
            (lambda doc: doc["summary"].pop("next"), "summary.next must be a string"),
            (lambda doc: doc["summary"].__setitem__("extra", ""), "unknown keys"),
            (lambda doc: doc["summary"].__setitem__("progress", "x" * 401), "400"),
            (lambda doc: doc["summary"].__setitem__("needs_input", "x" * 601), "600"),
            (lambda doc: doc["summary"].__setitem__("next", "x" * 601), "600"),
        ]
        for mutate, snippet in cases:
            doc = self.fresh()
            mutate(doc)
            reason = STORE.validate_summary(doc)
            self.assertIsNotNone(reason, snippet)
            self.assertIn(snippet, reason)

    def test_empty_progress_is_storable_but_llm_progress_is_not(self):
        doc = self.fresh()
        doc["summary"] = {"progress": "", "needs_input": "", "next": ""}
        self.assertIsNone(STORE.validate_summary(doc))

    def test_repo_violations_are_rejected(self):
        cases = [
            (lambda doc: doc.__setitem__("repo", "mast"), "repo"),
            (lambda doc: doc.__setitem__("repo", {"name": "mast", "path": "/p"}), "remote"),
            (lambda doc: doc["repo"].__setitem__("name", ""), "name"),
            (lambda doc: doc["repo"].__setitem__("name", "m" * 121), "120"),
            (lambda doc: doc["repo"].__setitem__("path", "/" + "p" * 1024), "1024"),
            (lambda doc: doc["repo"].__setitem__("remote", "r" * 1025), "1024"),
            (lambda doc: doc["repo"].__setitem__("remote", 7), "remote"),
            (lambda doc: doc["repo"].__setitem__("extra", 1), "unknown"),
        ]
        for mutate, snippet in cases:
            doc = self.fresh()
            mutate(doc)
            reason = STORE.validate_summary(doc)
            self.assertIsNotNone(reason, snippet)
            self.assertIn(snippet, reason)

    def test_cursor_entry_violations(self):
        cases = [
            (lambda doc: doc["meta"].__setitem__("cursor", {"": cursor_entry(1)}), "keys"),
            (lambda doc: doc["meta"].__setitem__("cursor", {"s": "x"}), "entries"),
            (lambda doc: doc["meta"].__setitem__(
                "cursor", {"s": {"agent": "unknown", "transcript_path": "/x", "offset": 0}}),
             "cursor agent"),
            (lambda doc: doc["meta"].__setitem__(
                "cursor", {"s": {"agent": "claude", "transcript_path": "", "offset": 0}}),
             "transcript_path"),
            (lambda doc: doc["meta"].__setitem__(
                "cursor", {"s": {"agent": "claude", "transcript_path": "/x", "offset": -1}}),
             "offset"),
            (lambda doc: doc["meta"].__setitem__(
                "cursor", {"s": {"agent": "claude", "transcript_path": "/x", "offset": True}}),
             "offset"),
            (lambda doc: doc["meta"].__setitem__(
                "cursor", {"s": {"agent": "claude", "transcript_path": "/x", "offset": 0,
                                 "updated": "2026"}}),
             "cursor updated"),
            (lambda doc: doc["meta"].__setitem__(
                "cursor", {"s": {"agent": "claude", "transcript_path": "/x", "offset": 0,
                                 "tab": 0}}),
             "cursor tab"),
            (lambda doc: doc["meta"].__setitem__(
                "cursor", {"s": {"agent": "claude", "transcript_path": "/x", "offset": 0,
                                 "line": 3}}),
             "unknown keys"),
            (lambda doc: doc["meta"].__setitem__(
                "cursor", {"s": {"agent": "claude", "transcript_path": "/x", "offset": 0,
                                 "pending_questions": {}}}),
             "unknown keys"),
            (lambda doc: doc["meta"].__setitem__(
                "cursor", {"s%d" % index: cursor_entry(index) for index in range(33)}),
             "32 sessions"),
        ]
        for mutate, snippet in cases:
            doc = self.fresh()
            mutate(doc)
            reason = STORE.validate_summary(doc)
            self.assertIsNotNone(reason, snippet)
            self.assertIn(snippet, reason)

    def test_cursor_updated_is_optional(self):
        doc = self.fresh()
        doc["meta"]["cursor"]["stale"] = {
            "agent": "codex", "transcript_path": "/tmp/x.jsonl", "offset": 0, "tab": None,
        }
        self.assertIsNone(STORE.validate_summary(doc))

    def test_prune_cursor_keeps_the_newest_32(self):
        doc = self.fresh()
        doc["meta"]["cursor"] = {
            "s%02d" % index: cursor_entry(index, "2026-09-25T00:%02d:00Z" % index)
            for index in range(1, 35)
        }
        removed = STORE.prune_cursor(doc)
        self.assertEqual(removed, ["s01", "s02"])
        self.assertEqual(len(doc["meta"]["cursor"]), STORE.MAX_CURSOR_SESSIONS)
        self.assertNotIn("s01", doc["meta"]["cursor"])
        self.assertIsNone(STORE.validate_summary(doc))

    def test_prune_cursor_treats_missing_updated_as_the_oldest(self):
        doc = self.fresh()
        entries = {
            "new%02d" % index: cursor_entry(index, "2026-09-25T00:%02d:00Z" % index)
            for index in range(1, 34)
        }
        entries["stale"] = cursor_entry(99)
        doc["meta"]["cursor"] = entries
        removed = STORE.prune_cursor(doc)
        self.assertEqual(removed, ["stale", "new01"],
                         "updated가 없으면 가장 오래된 것으로 취급한다")
        self.assertEqual(len(doc["meta"]["cursor"]), STORE.MAX_CURSOR_SESSIONS)

class StoreUpdateTest(StoreTestCase):
    def test_create_and_load_round_trip_with_modes(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "1" * 20
            created = STORE.update_summary(
                manager_dir, key, lambda doc: None,
                create=lambda: STORE.new_summary("/work/repo", "Ubuntu-24.04", NOW),
            )
            self.assertEqual(created["meta"]["schema_version"], 2)
            path = STORE.summary_path(manager_dir, key)
            self.assertTrue(path.is_file())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            loaded, error = STORE.load_summary(manager_dir, key)
            self.assertIsNone(error)
            self.assertEqual(loaded, created)

    def test_missing_summary_without_create_is_an_error(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "2" * 20
            with self.assertRaises(ValueError):
                STORE.update_summary(manager_dir, key, lambda doc: None)
            self.assertFalse(STORE.summary_path(manager_dir, key).exists())

    def test_invalid_created_document_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "3" * 20
            with self.assertRaises(ValueError):
                STORE.update_summary(manager_dir, key, lambda doc: None, create=lambda: {"meta": {}})
            self.assertFalse(STORE.summary_path(manager_dir, key).exists())

    def test_invalid_mutation_is_refused_and_the_file_is_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "4" * 20
            STORE.update_summary(
                manager_dir, key, lambda doc: None,
                create=lambda: STORE.new_summary("/work/repo", None, NOW),
            )
            path = STORE.summary_path(manager_dir, key)
            before = path.read_bytes()

            def break_it(doc):
                doc["summary"]["progress"] = "x" * 500
                return doc

            with self.assertRaises(ValueError) as raised:
                STORE.update_summary(manager_dir, key, break_it)
            self.assertIn("progress", str(raised.exception))
            self.assertEqual(path.read_bytes(), before)

    def test_mutate_sees_the_latest_document(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "5" * 20
            STORE.update_summary(
                manager_dir, key, lambda doc: None,
                create=lambda: STORE.new_summary("/work/repo", None, NOW),
            )

            def first(doc):
                doc["summary"]["next"] = "첫 번째"
                return doc

            def second(doc):
                doc["summary"]["next"] = doc["summary"]["next"] + " + 두 번째"
                return doc

            STORE.update_summary(manager_dir, key, first)
            updated = STORE.update_summary(manager_dir, key, second)
            self.assertEqual(updated["summary"]["next"], "첫 번째 + 두 번째")

    def test_load_summary_reports_broken_files(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "6" * 20
            self.assertEqual(STORE.load_summary(manager_dir, key), (None, None))
            path = STORE.summary_path(manager_dir, key)
            path.parent.mkdir(parents=True)
            path.write_text("{not json", encoding="utf-8")
            doc, error = STORE.load_summary(manager_dir, key)
            self.assertIsNone(doc)
            self.assertIn("invalid JSON", error)
            path.write_bytes(b"\xff\xfe\x00")
            doc, error = STORE.load_summary(manager_dir, key)
            self.assertIsNone(doc)
            self.assertIn("invalid UTF-8", error)
            self.assertEqual(path.read_bytes(), b"\xff\xfe\x00", "손상 원본은 그대로 둔다")
            path.write_text(json.dumps({"meta": {}}), encoding="utf-8")
            doc, error = STORE.load_summary(manager_dir, key)
            self.assertIsNone(doc)
            self.assertIn("invalid summary", error)

    def test_update_summary_does_not_overwrite_a_broken_file(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "7" * 20
            path = STORE.summary_path(manager_dir, key)
            path.parent.mkdir(parents=True)
            path.write_text("{broken", encoding="utf-8")
            with self.assertRaises(ValueError):
                STORE.update_summary(
                    manager_dir, key, lambda doc: None,
                    create=lambda: STORE.new_summary("/x", None, NOW))
            self.assertEqual(path.read_text(encoding="utf-8"), "{broken")


CONCURRENT_WORKER = """
import importlib.util, sys
spec = importlib.util.spec_from_file_location("mast_manager_worker", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manager_dir, key, count = sys.argv[2], sys.argv[3], int(sys.argv[4])

def mutate(doc):
    doc["summary"]["progress"] = doc["summary"]["progress"] + "x"
    return doc

for _ in range(count):
    module.update_summary(manager_dir, key, mutate)
"""


class ConcurrentWriteTest(StoreTestCase):
    def test_two_processes_do_not_lose_updates(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = STORE.task_key("/work/repo", "Ubuntu-24.04")
            STORE.update_summary(
                manager_dir, key, lambda doc: None,
                create=lambda: STORE.new_summary("/work/repo", "Ubuntu-24.04", NOW),
            )
            workers = [
                subprocess.Popen(
                    [sys.executable, "-c", CONCURRENT_WORKER, str(STORE_PATH), str(manager_dir), key, "100"],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                )
                for _ in range(2)
            ]
            for worker in workers:
                _out, err = worker.communicate()
                self.assertEqual(worker.returncode, 0, err.decode("utf-8", "replace"))
            doc, error = STORE.load_summary(manager_dir, key)
            self.assertIsNone(error)
            self.assertEqual(len(doc["summary"]["progress"]), 200)
            self.assertIsNone(STORE.validate_summary(doc))


if __name__ == "__main__":
    unittest.main()
