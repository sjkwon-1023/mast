#!/usr/bin/env python3
"""mast-manager.py의 작업 저장소·patch 검증 단위 테스트 (macOS·Linux 공용).

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

ANCHOR = {
    "agent": "claude",
    "session_id": "s1",
    "tab": 4,
    "line_start": 1,
    "line_end": 2,
    "message_id": "m1",
}
MANAGER_ANCHOR = {
    "agent": "manager",
    "session_id": None,
    "tab": 6,
    "line_start": 0,
    "line_end": 0,
    "message_id": None,
}


def load_store():
    spec = importlib.util.spec_from_file_location("mast_manager_store_test", STORE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE = load_store()


def question_item(index, status="active", anchor=ANCHOR, quote="질문 인용입니다"):
    return {
        "id": "q%d" % index,
        "text": "질문 %d입니다" % index,
        "anchor": anchor,
        "quote": quote,
        "status": status,
        "created_at": NOW,
        "updated_at": NOW,
        "source": "harness",
        "resolution": None,
    }


def decision_item(index, status="active", by="user", superseded_by=None):
    return {
        "id": "d%d" % index,
        "text": "결정 %d입니다" % index,
        "anchor": ANCHOR,
        "quote": "결정 인용입니다 %d" % index,
        "status": status,
        "created_at": NOW,
        "updated_at": NOW,
        "source": "harness",
        "resolution": None,
        "by": by,
        "superseded_by": superseded_by,
    }


def next_item(index, status="active"):
    return {
        "id": "n%d" % index,
        "text": "할 일 %d입니다" % index,
        "anchor": None,
        "quote": None,
        "status": status,
        "created_at": NOW,
        "updated_at": NOW,
        "source": "harness",
        "resolution": None,
    }


def removed_plan(index):
    return {
        "path": "docs/plans/plan-%02d.md" % index,
        "hash": "b" * 64,
        "goal": "계획 목표 %d" % index,
        "steps": [],
        "status": "removed",
    }


def cursor_entry(index, updated=None):
    entry = {
        "agent": "claude",
        "transcript_path": "/tmp/sess-%02d.jsonl" % index,
        "offset": index,
        "tab": 4,
        "line": index,
    }
    if updated is not None:
        entry["updated"] = updated
    return entry


class StoreTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.valid = cls.fixture["valid"][0]
        cls.utterances = cls.fixture["utterances"]

    def fresh(self):
        return copy.deepcopy(self.valid)

    def make_op(self, name, **fields):
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

    def make_patch(self, ops, verdict="update", notify="none", notify_reason=None):
        return {"verdict": verdict, "notify": notify, "notify_reason": notify_reason, "ops": ops}

    def apply(self, ops, mode="harness", doc=None, **kwargs):
        kwargs.setdefault("utterances", self.utterances)
        kwargs.setdefault("manager_tab", 6)
        kwargs.setdefault("now", NOW)
        target = self.fresh() if doc is None else copy.deepcopy(doc)
        return STORE.apply_patch(target, self.make_patch(ops), mode, **kwargs)

    def apply_raw(self, patch, mode="harness", doc=None, **kwargs):
        kwargs.setdefault("utterances", self.utterances)
        kwargs.setdefault("manager_tab", 6)
        kwargs.setdefault("now", NOW)
        target = self.fresh() if doc is None else copy.deepcopy(doc)
        return STORE.apply_patch(target, patch, mode, **kwargs)


class TaskKeyAndPathsTest(unittest.TestCase):
    def test_task_key_matches_contract(self):
        expected = "k" + hashlib.sha256(
            ("Ubuntu-24.04\0/home/u/projects/mast").encode("utf-8")
        ).hexdigest()[:20]
        self.assertEqual(STORE.task_key("/home/u/projects/mast", "Ubuntu-24.04"), expected)
        self.assertEqual(len(expected), 21)
        self.assertEqual(STORE.task_key("/home/u", None), STORE.task_key("/home/u", ""))
        self.assertNotEqual(STORE.task_key("/a", "d1"), STORE.task_key("/a", "d2"))

    def test_paths_and_archive_names(self):
        manager = Path("/tmp/manager")
        self.assertEqual(STORE.task_path(manager, "k1"), manager / "tasks" / "k1.json")
        self.assertEqual(STORE.lock_path(manager), manager / ".mast" / "store.lock")
        self.assertEqual(
            STORE.archive_path(manager, "k1", "2026-09-25T03:04:05Z"),
            manager / "archive" / "k1--20260925T030405Z.json",
        )


class NewTaskAndValidateTest(StoreTestCase):
    def test_new_task_is_empty_and_valid(self):
        doc = STORE.new_task("/home/u/projects/mast", "Ubuntu-24.04", NOW)
        self.assertIsNone(STORE.validate_task(doc))
        self.assertEqual(doc["meta"]["status"], "active")
        self.assertEqual(doc["meta"]["next_id"], 1)
        self.assertEqual(doc["meta"]["created_at"], NOW)
        self.assertEqual(doc["meta"]["updated_at"], NOW)
        self.assertIsNone(doc["meta"]["last_collected_at"])
        self.assertIsNone(doc["meta"]["last_error"])
        self.assertEqual(doc["meta"]["limits"], [])
        self.assertEqual(doc["meta"]["rejected_ops"], 0)
        self.assertEqual(doc["meta"]["workspace_key"], {"root_path": "/home/u/projects/mast", "distro": "Ubuntu-24.04"})
        self.assertEqual(doc["open_questions"], [])
        self.assertEqual(doc["decisions"], [])
        self.assertEqual(doc["next"], [])
        self.assertEqual(doc["plans"], [])
        self.assertEqual(doc["progress"], {"text": "", "reported_done": False, "verified_done": False})
        self.assertIsNone(doc["git"]["branch"])

    def test_fixture_valid_document(self):
        self.assertIsNone(STORE.validate_task(self.fresh()))

    def test_fixture_invalid_documents_have_distinct_reasons(self):
        expected = ["meta.status", "anchor", "unknown top-level key"]
        self.assertEqual(len(self.fixture["invalid"]), 3)
        reasons = []
        for doc, snippet in zip(self.fixture["invalid"], expected):
            reason = STORE.validate_task(doc)
            self.assertIsNotNone(reason, "invalid fixture passed validation")
            self.assertIn(snippet, reason)
            reasons.append(reason)
        self.assertEqual(len(set(reasons)), 3)

    def test_unknown_top_level_key_is_rejected(self):
        doc = self.fresh()
        doc["board"] = {"pinned": True}
        self.assertIn("unknown top-level key", STORE.validate_task(doc))

    def test_meta_enum_and_type_violations(self):
        cases = [
            (lambda doc: doc["meta"].__setitem__("status", "paused"), "meta.status"),
            (lambda doc: doc["meta"].__setitem__("schema_version", 2), "meta.schema_version"),
            (lambda doc: doc["meta"].__setitem__("next_id", 0), "meta.next_id"),
            (lambda doc: doc["meta"].__setitem__("rejected_ops", -1), "meta.rejected_ops"),
            (lambda doc: doc["meta"].__setitem__("limits", ["nope"]), "meta.limits"),
            (lambda doc: doc["meta"].__setitem__("limits", ["next_capped", "next_capped"]), "duplicate"),
            (lambda doc: doc["meta"].__setitem__("created_at", "2026-09-25"), "meta.created_at"),
            (lambda doc: doc["meta"].__setitem__("effort", "turbo"), "meta.effort"),
            (lambda doc: doc["meta"].__setitem__("cursor", {"s": {"agent": "unknown", "transcript_path": "/x", "offset": 0, "tab": None}}), "cursor agent"),
        ]
        for mutate, snippet in cases:
            doc = self.fresh()
            mutate(doc)
            reason = STORE.validate_task(doc)
            self.assertIsNotNone(reason, snippet)
            self.assertIn(snippet, reason)

    def test_length_caps_are_enforced(self):
        cases = [
            (lambda doc: doc.__setitem__("title", "x" * 81), "title"),
            (lambda doc: doc.__setitem__("headline", "x" * 161), "headline"),
            (lambda doc: doc["progress"].__setitem__("text", "x" * 401), "progress.text"),
            (lambda doc: doc["open_questions"][0].__setitem__("text", "x" * 301), "text"),
            (lambda doc: doc["open_questions"][0].__setitem__("quote", "short"), "quote"),
            (lambda doc: doc["plans"][0].__setitem__("goal", "x" * 201), "goal"),
            (lambda doc: doc["plans"][0].__setitem__("steps", [{"text": "x" * 161, "done": False}]), "steps[0].text"),
        ]
        for mutate, snippet in cases:
            doc = self.fresh()
            mutate(doc)
            reason = STORE.validate_task(doc)
            self.assertIsNotNone(reason, snippet)
            self.assertIn(snippet, reason)

    def test_item_requirements(self):
        doc = self.fresh()
        doc["open_questions"][0]["anchor"] = None
        self.assertIn("needs anchor and quote", STORE.validate_task(doc))
        doc = self.fresh()
        doc["decisions"][0]["anchor"] = None
        self.assertIn("needs anchor and quote", STORE.validate_task(doc))
        doc = self.fresh()
        doc["decisions"][0]["by"] = "robot"
        self.assertIn(".by", STORE.validate_task(doc))
        doc = self.fresh()
        doc["next"][0]["id"] = "q9"
        self.assertIn("must start with n", STORE.validate_task(doc))
        doc = self.fresh()
        doc["open_questions"][0]["anchor"]["agent"] = "vscode"
        self.assertIn("agent", STORE.validate_task(doc))

    def test_count_caps_are_enforced(self):
        doc = self.fresh()
        doc["open_questions"] = [question_item(index) for index in range(1, 22)]
        self.assertIn("more than 20 active", STORE.validate_task(doc))
        doc = self.fresh()
        doc["next"] = [next_item(index) for index in range(1, 12)]
        self.assertIn("more than 10 active", STORE.validate_task(doc))
        doc = self.fresh()
        doc["decisions"] = [decision_item(index) for index in range(1, 82)]
        self.assertIn("more than 80 stored", STORE.validate_task(doc))

    def test_plan_hash_and_step_caps(self):
        doc = self.fresh()
        doc["plans"][0]["hash"] = "not-a-hash"
        self.assertIn("hash", STORE.validate_task(doc))
        doc = self.fresh()
        doc["plans"][0]["steps"] = [{"text": "단계", "done": False}] * 13
        self.assertIn("at most 12", STORE.validate_task(doc))
        doc = self.fresh()
        doc["plans"][0]["status"] = "done"
        self.assertIn(".status", STORE.validate_task(doc))

    def test_archived_status_and_resolution_are_valid(self):
        doc = self.fresh()
        doc["meta"]["status"] = "archived"
        doc["open_questions"][0]["status"] = "resolved"
        doc["open_questions"][0]["resolution"] = {"anchor": ANCHOR, "quote": "해결 인용입니다"}
        doc["decisions"][0]["status"] = "superseded"
        doc["decisions"][0]["superseded_by"] = "d2"
        self.assertIsNone(STORE.validate_task(doc))


class ApplyPatchBasicsTest(StoreTestCase):
    def test_fixture_harness_patch_applies_cleanly(self):
        patch = self.fixture["harnessPatch"]
        new_doc, applied, rejected = self.apply_raw(
            patch,
            "harness",
            allowed_plan_paths=["docs/plans/example-plan.md"],
            plan_hashes={"docs/plans/example-plan.md": "c" * 64},
        )
        self.assertEqual(rejected, [])
        self.assertEqual(len(applied), len(patch["ops"]))
        self.assertIsNone(STORE.validate_task(new_doc))
        by_id = {item["id"]: item for item in new_doc["decisions"]}
        self.assertEqual(by_id["d1"]["status"], "superseded")
        self.assertIn(by_id["d1"]["superseded_by"], by_id)
        self.assertEqual(new_doc["open_questions"][0]["status"], "resolved")
        self.assertEqual(new_doc["next"][0]["status"], "resolved")
        self.assertEqual(new_doc["plans"][0]["hash"], "c" * 64)
        self.assertEqual(new_doc["meta"]["updated_at"], NOW)

    def test_fixture_manager_patch_applies_cleanly(self):
        patch = self.fixture["managerPatch"]
        new_doc, applied, rejected = self.apply_raw(patch, "manager", manager_tab=6)
        self.assertEqual(rejected, [])
        self.assertEqual(len(applied), len(patch["ops"]))
        self.assertIsNone(STORE.validate_task(new_doc))
        self.assertTrue(new_doc["progress"]["verified_done"])
        self.assertTrue(new_doc["progress"]["reported_done"])
        added = new_doc["open_questions"][-1]
        self.assertEqual(added["anchor"], MANAGER_ANCHOR)
        self.assertEqual(added["source"], "manager")

    def test_ids_come_from_meta_next_id(self):
        doc = self.fresh()
        doc["meta"]["next_id"] = 40
        ops = [
            self.make_op("add", kind="next", text="첫 번째"),
            self.make_op("add", kind="next", text="두 번째"),
        ]
        new_doc, applied, rejected = self.apply(ops, doc=doc)
        self.assertEqual(rejected, [])
        self.assertEqual(applied, ["add next n40", "add next n41"])
        self.assertEqual([item["id"] for item in new_doc["next"][-2:]], ["n40", "n41"])
        self.assertEqual(new_doc["meta"]["next_id"], 42)

    def test_rejected_ops_accumulate_without_touching_applied_ops(self):
        doc = self.fresh()
        before = doc["meta"]["rejected_ops"]
        ops = [
            self.make_op("add", kind="question", text="정상 질문", anchor_ref="u1", quote="공개 가능한 걸로 지정할까?"),
            self.make_op("add", kind="question", text="잘못된 질문", anchor_ref="u9", quote="없는 발화 인용"),
        ]
        new_doc, applied, rejected = self.apply(ops, doc=doc)
        self.assertEqual(len(applied), 1)
        self.assertEqual(len(rejected), 1)
        self.assertIn("u9", rejected[0])
        self.assertEqual(new_doc["meta"]["rejected_ops"], before + 1)
        self.assertEqual(len(new_doc["open_questions"]), 2)

    def test_apply_does_not_mutate_input_document(self):
        doc = self.fresh()
        before = json.dumps(doc, ensure_ascii=False, sort_keys=True)
        self.apply([self.make_op("set_title", text="새 제목")], doc=doc)
        self.assertEqual(json.dumps(doc, ensure_ascii=False, sort_keys=True), before)


class AddOpsTest(StoreTestCase):
    def test_add_question_harness_accepts_a_matching_utterance(self):
        op = self.make_op(
            "add", kind="question", text="새 질문입니다", anchor_ref="u1",
            quote="공개 가능한 걸로 지정할까?",
        )
        new_doc, applied, rejected = self.apply([op])
        self.assertEqual(rejected, [])
        item = new_doc["open_questions"][-1]
        self.assertEqual(item["id"], "q2")
        self.assertEqual(item["anchor"], self.utterances["u1"]["anchor"])
        self.assertEqual(item["quote"], "공개 가능한 걸로 지정할까?")
        self.assertEqual(item["source"], "harness")

    def test_add_question_harness_rejects_an_unknown_anchor_ref(self):
        op = self.make_op("add", kind="question", text="질문", anchor_ref="u9", quote="없는 발화 인용문")
        _new_doc, applied, rejected = self.apply([op])
        self.assertEqual(applied, [])
        self.assertEqual(len(rejected), 1)
        self.assertIn("not in this input", rejected[0])

    def test_add_question_harness_rejects_a_quote_that_is_not_a_substring(self):
        op = self.make_op("add", kind="question", text="질문", anchor_ref="u1", quote="전혀 다른 인용문입니다")
        _new_doc, _applied, rejected = self.apply([op])
        self.assertIn("not part of the referenced utterance", rejected[0])

    def test_add_question_harness_rejects_a_short_quote(self):
        op = self.make_op("add", kind="question", text="질문", anchor_ref="u1", quote="짧은 인용")
        _new_doc, _applied, rejected = self.apply([op])
        self.assertIn("8..300", rejected[0])

    def test_add_decision_harness_expands_a_short_quote_to_the_utterance(self):
        text = "Answered: Which color should the fixture use? → Red"
        utterances = {"u1": {"speaker": "user", "text": text, "anchor": ANCHOR}}
        op = self.make_op(
            "add", kind="decision", text="fixture 색은 Red로 한다", by="user",
            anchor_ref="u1", quote="Red",
        )
        new_doc, applied, rejected = self.apply([op], utterances=utterances)
        self.assertEqual(rejected, [])
        self.assertEqual(applied, ["add decision d2"])
        item = new_doc["decisions"][-1]
        self.assertEqual(item["quote"], text)
        self.assertEqual(item["by"], "user")
        self.assertIsNone(STORE.validate_task(new_doc))

    def test_add_decision_harness_rejects_a_short_quote_for_a_long_utterance(self):
        text = "Red " + "x" * 300
        utterances = {"u1": {"speaker": "user", "text": text, "anchor": ANCHOR}}
        op = self.make_op(
            "add", kind="decision", text="fixture 색은 Red로 한다", by="user",
            anchor_ref="u1", quote="Red",
        )
        _new_doc, applied, rejected = self.apply([op], utterances=utterances)
        self.assertEqual(applied, [])
        self.assertIn("8..300", rejected[0])

    def test_add_decision_harness_rejects_a_short_quote_that_is_not_a_substring(self):
        op = self.make_op(
            "add", kind="decision", text="fixture 색은 Red로 한다", by="user",
            anchor_ref="u1", quote="Red",
        )
        _new_doc, applied, rejected = self.apply([op])
        self.assertEqual(applied, [])
        self.assertIn("8..300", rejected[0])

    def test_add_question_manager_accepts_a_user_quote(self):
        op = self.make_op("add", kind="question", text="새 질문입니다", quote="관리자 질문 인용입니다")
        new_doc, applied, rejected = self.apply([op], mode="manager")
        self.assertEqual(rejected, [])
        item = new_doc["open_questions"][-1]
        self.assertEqual(item["anchor"], MANAGER_ANCHOR)
        self.assertEqual(item["source"], "manager")
        self.assertIsNone(item["resolution"])

    def test_add_question_manager_rejects_a_missing_quote(self):
        op = self.make_op("add", kind="question", text="새 질문입니다")
        _new_doc, _applied, rejected = self.apply([op], mode="manager")
        self.assertIn("quote is required", rejected[0])

    def test_add_question_manager_rejects_anchor_ref(self):
        op = self.make_op(
            "add", kind="question", text="새 질문입니다", anchor_ref="u1",
            quote="공개 가능한 걸로 지정할까?",
        )
        _new_doc, _applied, rejected = self.apply([op], mode="manager")
        self.assertIn("cannot reference utterances", rejected[0])

    def test_add_decision_harness_accepts_a_matching_speaker(self):
        op = self.make_op(
            "add", kind="decision", text="AI 결정입니다", by="ai", anchor_ref="u4",
            quote="harness patch는 verified_done을 금지합니다",
        )
        new_doc, applied, rejected = self.apply([op])
        self.assertEqual(rejected, [])
        item = new_doc["decisions"][-1]
        self.assertEqual(item["by"], "ai")
        self.assertEqual(item["superseded_by"], None)
        self.assertEqual(item["anchor"], self.utterances["u4"]["anchor"])

    def test_add_decision_harness_rejects_a_by_mismatch(self):
        op = self.make_op(
            "add", kind="decision", text="AI 결정입니다", by="user", anchor_ref="u4",
            quote="harness patch는 verified_done을 금지합니다",
        )
        _new_doc, _applied, rejected = self.apply([op])
        self.assertIn("does not match", rejected[0])

    def test_add_decision_manager_accepts_by_and_quote(self):
        op = self.make_op(
            "add", kind="decision", text="관리자 결정입니다", by="user",
            quote="관리자 patch는 verified_done을 허용한다",
        )
        new_doc, applied, rejected = self.apply([op], mode="manager")
        self.assertEqual(rejected, [])
        item = new_doc["decisions"][-1]
        self.assertEqual(item["by"], "user")
        self.assertEqual(item["anchor"], MANAGER_ANCHOR)
        self.assertEqual(item["source"], "manager")

    def test_add_decision_manager_rejects_a_missing_by(self):
        op = self.make_op(
            "add", kind="decision", text="관리자 결정입니다",
            quote="관리자 patch는 verified_done을 허용한다",
        )
        _new_doc, _applied, rejected = self.apply([op], mode="manager")
        self.assertIn("decision by", rejected[0])

    def test_add_next_harness_needs_only_text(self):
        op = self.make_op("add", kind="next", text="텍스트만 있는 할 일")
        new_doc, applied, rejected = self.apply([op])
        self.assertEqual(rejected, [])
        item = new_doc["next"][-1]
        self.assertIsNone(item["anchor"])
        self.assertIsNone(item["quote"])

    def test_add_next_harness_accepts_optional_evidence(self):
        op = self.make_op(
            "add", kind="next", text="근거 있는 할 일", anchor_ref="u3",
            quote="최신본을 다시 읽고 적용하자",
        )
        new_doc, _applied, rejected = self.apply([op])
        self.assertEqual(rejected, [])
        item = new_doc["next"][-1]
        self.assertEqual(item["anchor"], self.utterances["u3"]["anchor"])
        self.assertEqual(item["quote"], "최신본을 다시 읽고 적용하자")

    def test_add_next_harness_rejects_a_missing_text(self):
        op = self.make_op("add", kind="next")
        _new_doc, _applied, rejected = self.apply([op])
        self.assertIn("text must be 1..300", rejected[0])

    def test_add_next_harness_rejects_a_quote_without_anchor_ref(self):
        op = self.make_op("add", kind="next", text="할 일", quote="근거 없는 인용문입니다")
        _new_doc, _applied, rejected = self.apply([op])
        self.assertIn("anchor_ref", rejected[0])

    def test_add_next_manager_accepts_optional_quote(self):
        op = self.make_op("add", kind="next", text="관리자 할 일", quote="관리자 할 일 인용문")
        new_doc, _applied, rejected = self.apply([op], mode="manager")
        self.assertEqual(rejected, [])
        item = new_doc["next"][-1]
        self.assertEqual(item["anchor"], MANAGER_ANCHOR)

    def test_add_next_manager_rejects_an_anchor_ref(self):
        op = self.make_op("add", kind="next", text="관리자 할 일", anchor_ref="u1", quote="최신본을 다시 읽고 적용하자")
        _new_doc, _applied, rejected = self.apply([op], mode="manager")
        self.assertIn("cannot reference utterances", rejected[0])

    def test_unknown_kind_and_text_are_rejected_per_op(self):
        ops = [
            self.make_op("add", kind="banana", text="무언가"),
            self.make_op("add", kind="next", text="  "),
        ]
        _new_doc, applied, rejected = self.apply(ops)
        self.assertEqual(applied, [])
        self.assertEqual(len(rejected), 2)


class ResolveSupersedeTest(StoreTestCase):
    def test_resolve_question_harness_needs_evidence(self):
        op = self.make_op("resolve", id="q1", anchor_ref="u1", quote="공개 가능한 걸로 지정할까?")
        new_doc, applied, rejected = self.apply([op])
        self.assertEqual(rejected, [])
        item = new_doc["open_questions"][0]
        self.assertEqual(item["status"], "resolved")
        self.assertEqual(item["resolution"]["anchor"], self.utterances["u1"]["anchor"])
        self.assertEqual(item["resolution"]["quote"], "공개 가능한 걸로 지정할까?")
        self.assertEqual(item["updated_at"], NOW)

    def test_resolve_question_harness_rejects_missing_evidence(self):
        op = self.make_op("resolve", id="q1")
        _new_doc, _applied, rejected = self.apply([op])
        self.assertEqual(len(rejected), 1)
        self.assertIn("anchor_ref", rejected[0])

    def test_resolve_next_harness_accepts_missing_evidence(self):
        op = self.make_op("resolve", id="n1")
        new_doc, applied, rejected = self.apply([op])
        self.assertEqual(rejected, [])
        item = new_doc["next"][0]
        self.assertEqual(item["status"], "resolved")
        self.assertEqual(item["resolution"], {"anchor": None, "quote": None})

    def test_resolve_next_harness_accepts_partial_evidence(self):
        op = self.make_op("resolve", id="n1", anchor_ref="u2", quote="CH8은 transcript 추출을 맡습니다")
        new_doc, _applied, rejected = self.apply([op])
        self.assertEqual(rejected, [])
        self.assertEqual(new_doc["next"][0]["resolution"]["anchor"], self.utterances["u2"]["anchor"])

    def test_resolve_manager_needs_quote(self):
        op = self.make_op("resolve", id="n1", quote="CH8은 다음 청크다")
        new_doc, applied, rejected = self.apply([op], mode="manager")
        self.assertEqual(rejected, [])
        self.assertEqual(new_doc["next"][0]["resolution"], {"anchor": MANAGER_ANCHOR, "quote": "CH8은 다음 청크다"})

    def test_resolve_manager_rejects_missing_quote(self):
        op = self.make_op("resolve", id="n1")
        _new_doc, _applied, rejected = self.apply([op], mode="manager")
        self.assertIn("quote is required", rejected[0])

    def test_resolve_rejects_unknown_and_inactive_targets(self):
        op = self.make_op("resolve", id="q9")
        _new_doc, _applied, rejected = self.apply([op])
        self.assertIn("not an active question or next", rejected[0])
        doc = self.fresh()
        doc["next"][0]["status"] = "resolved"
        op = self.make_op("resolve", id="n1")
        _new_doc, _applied, rejected = self.apply([op], doc=doc)
        self.assertIn("not active", rejected[0])

    def test_supersede_chain(self):
        doc = self.fresh()
        doc["meta"]["next_id"] = 2
        doc["decisions"] = [decision_item(1)]
        op = self.make_op(
            "supersede", id="d1", text="결정 v2", by="user", anchor_ref="u3",
            quote="store.lock flock 아래에서 최신본을 다시 읽고 적용하자",
        )
        new_doc, applied, rejected = self.apply([op], doc=doc)
        self.assertEqual(rejected, [])
        self.assertEqual(applied, ["supersede d1 -> d2"])
        self.assertEqual(new_doc["decisions"][0]["status"], "superseded")
        self.assertEqual(new_doc["decisions"][0]["superseded_by"], "d2")
        self.assertEqual(new_doc["decisions"][1]["id"], "d2")
        self.assertEqual(new_doc["decisions"][1]["status"], "active")

        op = self.make_op(
            "supersede", id="d2", text="결정 v3", by="user", anchor_ref="u3",
            quote="최신본을 다시 읽고 적용하자",
        )
        final_doc, applied, rejected = self.apply([op], doc=new_doc)
        self.assertEqual(rejected, [])
        self.assertEqual(applied, ["supersede d2 -> d3"])
        chain = {item["id"]: item for item in final_doc["decisions"]}
        self.assertEqual(chain["d1"]["superseded_by"], "d2")
        self.assertEqual(chain["d2"]["status"], "superseded")
        self.assertEqual(chain["d2"]["superseded_by"], "d3")
        self.assertEqual(chain["d3"]["status"], "active")
        self.assertEqual(final_doc["meta"]["next_id"], 4)
        self.assertIsNone(STORE.validate_task(final_doc))

    def test_supersede_harness_rejects_a_by_mismatch(self):
        doc = self.fresh()
        op = self.make_op(
            "supersede", id="d1", text="결정 v2", by="ai", anchor_ref="u3",
            quote="최신본을 다시 읽고 적용하자",
        )
        _new_doc, _applied, rejected = self.apply([op], doc=doc)
        self.assertIn("does not match", rejected[0])

    def test_supersede_manager_accepts_quote_and_anchor_rules(self):
        op = self.make_op(
            "supersede", id="d1", text="결정 v2", by="user",
            quote="작업 기억은 워크스페이스별 JSON 파일로 둔다",
        )
        new_doc, applied, rejected = self.apply([op], mode="manager")
        self.assertEqual(rejected, [])
        self.assertEqual(new_doc["decisions"][-1]["anchor"], MANAGER_ANCHOR)
        self.assertEqual(new_doc["decisions"][0]["superseded_by"], new_doc["decisions"][-1]["id"])

    def test_supersede_manager_rejects_missing_quote(self):
        op = self.make_op("supersede", id="d1", text="결정 v2", by="user")
        _new_doc, _applied, rejected = self.apply([op], mode="manager")
        self.assertIn("quote is required", rejected[0])

    def test_supersede_rejects_a_non_active_target_and_missing_fields(self):
        doc = self.fresh()
        doc["decisions"][0]["status"] = "superseded"
        op = self.make_op(
            "supersede", id="d1", text="결정 v2", by="user", anchor_ref="u3",
            quote="최신본을 다시 읽고 적용하자",
        )
        _new_doc, _applied, rejected = self.apply([op], doc=doc)
        self.assertIn("not active", rejected[0])
        op = self.make_op(
            "supersede", id="d1", by="user", anchor_ref="u3",
            quote="최신본을 다시 읽고 적용하자",
        )
        _new_doc, _applied, rejected = self.apply([op])
        self.assertIn("text must be 1..300", rejected[0])


class ProgressTitlePlanTest(StoreTestCase):
    def test_set_progress_harness_accepts_verified_done_null(self):
        op = self.make_op("set_progress", text="진행 상황", reported_done=True, verified_done=None)
        new_doc, applied, rejected = self.apply([op])
        self.assertEqual(rejected, [])
        self.assertEqual(new_doc["progress"], {"text": "진행 상황", "reported_done": True, "verified_done": False})

    def test_set_progress_harness_rejects_verified_done(self):
        op = self.make_op("set_progress", text="진행 상황", reported_done=True, verified_done=True)
        _new_doc, _applied, rejected = self.apply([op])
        self.assertIn("cannot set verified_done", rejected[0])

    def test_set_progress_manager_accepts_verified_done(self):
        op = self.make_op("set_progress", text="검증된 진행", reported_done=True, verified_done=True)
        new_doc, applied, rejected = self.apply([op], mode="manager")
        self.assertEqual(rejected, [])
        self.assertEqual(new_doc["progress"], {"text": "검증된 진행", "reported_done": True, "verified_done": True})

    def test_set_progress_manager_keeps_verified_done_when_null(self):
        doc = self.fresh()
        doc["progress"]["verified_done"] = True
        op = self.make_op("set_progress", text="진행만 갱신", reported_done=True, verified_done=None)
        new_doc, applied, rejected = self.apply([op], mode="manager", doc=doc)
        self.assertEqual(rejected, [])
        self.assertTrue(new_doc["progress"]["verified_done"])

    def test_set_progress_rejects_a_non_boolean_reported_done(self):
        op = self.make_op("set_progress", text="진행 상황", reported_done="yes")
        _new_doc, _applied, rejected = self.apply([op])
        self.assertIn("reported_done", rejected[0])

    def test_set_title_and_headline_caps(self):
        new_doc, applied, rejected = self.apply([
            self.make_op("set_title", text="새 제목"),
            self.make_op("set_headline", text="새 헤드라인"),
        ])
        self.assertEqual(rejected, [])
        self.assertEqual(new_doc["title"], "새 제목")
        self.assertEqual(new_doc["headline"], "새 헤드라인")
        _new_doc, _applied, rejected = self.apply([self.make_op("set_title", text="x" * 81)])
        self.assertIn("at most 80", rejected[0])
        _new_doc, _applied, rejected = self.apply([self.make_op("set_headline", text="x" * 161)])
        self.assertIn("at most 160", rejected[0])

    def test_set_plan_harness_accepts_allowed_path_with_hash(self):
        path = "docs/plans/example-plan.md"
        op = self.make_op(
            "set_plan", path=path, goal="새 목표", steps=[{"text": "단계 하나", "done": False}],
        )
        new_doc, applied, rejected = self.apply(
            [op], allowed_plan_paths=[path], plan_hashes={path: "d" * 64},
        )
        self.assertEqual(rejected, [])
        plan = new_doc["plans"][0]
        self.assertEqual(plan["hash"], "d" * 64)
        self.assertEqual(plan["goal"], "새 목표")
        self.assertEqual(plan["steps"], [{"text": "단계 하나", "done": False}])
        self.assertEqual(plan["status"], "active")

    def test_set_plan_harness_accepts_a_path_to_hash_mapping(self):
        path = "docs/plans/example-plan.md"
        op = self.make_op("set_plan", path=path, goal="목표", steps=[])
        new_doc, applied, rejected = self.apply([op], allowed_plan_paths={path: "e" * 64})
        self.assertEqual(rejected, [])
        self.assertEqual(new_doc["plans"][0]["hash"], "e" * 64)

    def test_set_plan_keeps_the_existing_hash_without_new_input(self):
        path = "docs/plans/example-plan.md"
        existing = self.fresh()["plans"][0]["hash"]
        op = self.make_op("set_plan", path=path, goal="목표", steps=[])
        new_doc, _applied, rejected = self.apply([op], allowed_plan_paths=[path])
        self.assertEqual(rejected, [])
        self.assertEqual(new_doc["plans"][0]["hash"], existing)

    def test_set_plan_rejects_a_path_outside_this_run(self):
        op = self.make_op("set_plan", path="docs/plans/other.md", goal="목표", steps=[])
        _new_doc, _applied, rejected = self.apply([op], allowed_plan_paths=["docs/plans/example-plan.md"])
        self.assertIn("was not provided", rejected[0])

    def test_set_plan_rejects_caps_and_unknown_hash(self):
        path = "docs/plans/example-plan.md"
        steps = [{"text": "단계", "done": False}] * 13
        op = self.make_op("set_plan", path=path, goal="목표", steps=steps)
        _new_doc, _applied, rejected = self.apply([op], allowed_plan_paths=[path], plan_hashes={path: "f" * 64})
        self.assertIn("at most 12", rejected[0])
        doc = self.fresh()
        doc["plans"] = []
        op = self.make_op("set_plan", path=path, goal="목표", steps=[])
        _new_doc, _applied, rejected = self.apply([op], doc=doc, allowed_plan_paths=[path])
        self.assertIn("no file hash", rejected[0])

    def test_set_plan_manager_is_rejected(self):
        path = "docs/plans/example-plan.md"
        op = self.make_op("set_plan", path=path, goal="목표", steps=[])
        _new_doc, _applied, rejected = self.apply([op], mode="manager", allowed_plan_paths=[path])
        self.assertIn("cannot set plans", rejected[0])


class EnvelopeTest(StoreTestCase):
    def test_no_change_with_ops_rejects_the_whole_patch(self):
        doc = self.fresh()
        patch = self.make_patch(
            [self.make_op("set_title", text="새 제목")], verdict="no_change",
        )
        new_doc, applied, rejected = self.apply_raw(patch, doc=doc)
        self.assertEqual(applied, [])
        self.assertEqual(len(rejected), 1)
        self.assertEqual(new_doc, doc)

    def test_no_change_without_ops_changes_nothing(self):
        doc = self.fresh()
        before = json.dumps(doc, ensure_ascii=False, sort_keys=True)
        new_doc, applied, rejected = self.apply_raw(self.make_patch([]), doc=doc)
        self.assertEqual(applied, [])
        self.assertEqual(rejected, [])
        self.assertEqual(json.dumps(new_doc, ensure_ascii=False, sort_keys=True), before)

    def test_report_without_reason_rejects_the_whole_patch(self):
        doc = self.fresh()
        patch = self.make_patch([self.make_op("set_title", text="새 제목")], notify="report", notify_reason=None)
        new_doc, applied, rejected = self.apply_raw(patch, doc=doc)
        self.assertEqual(applied, [])
        self.assertEqual(len(rejected), 1)
        self.assertIn("notify_reason", rejected[0])
        self.assertEqual(new_doc, doc)

    def test_report_with_reason_applies(self):
        patch = self.make_patch(
            [self.make_op("set_title", text="새 제목")],
            notify="report", notify_reason="question",
        )
        new_doc, applied, rejected = self.apply_raw(patch)
        self.assertEqual(rejected, [])
        self.assertEqual(applied, ["set_title"])
        self.assertEqual(new_doc["title"], "새 제목")

    def test_malformed_envelopes_are_rejected_as_a_whole(self):
        cases = [
            self.make_patch([], verdict="maybe"),
            self.make_patch([], notify="toast"),
            self.make_patch([], notify_reason="unknown"),
            self.make_patch(None),
            "not-a-patch",
        ]
        for patch in cases:
            new_doc, applied, rejected = self.apply_raw(patch)
            self.assertEqual(applied, [])
            self.assertEqual(len(rejected), 1)
            self.assertEqual(new_doc, self.valid)

    def test_unknown_ops_are_rejected_individually(self):
        ops = [
            {"op": "rewrite_everything"},
            "not-an-op",
            self.make_op("set_title", text="유효한 제목"),
        ]
        new_doc, applied, rejected = self.apply(ops)
        self.assertEqual(applied, ["set_title"])
        self.assertEqual(len(rejected), 2)
        self.assertEqual(new_doc["title"], "유효한 제목")
        self.assertEqual(new_doc["meta"]["rejected_ops"], self.valid["meta"]["rejected_ops"] + 2)


class CapsAndLimitsTest(StoreTestCase):
    def test_question_cap_rejects_the_add_and_records_the_limit(self):
        doc = self.fresh()
        doc["open_questions"] = [question_item(index) for index in range(1, 21)]
        doc["meta"]["next_id"] = 21
        op = self.make_op(
            "add", kind="question", text="스물한 번째 질문", anchor_ref="u1",
            quote="공개 가능한 걸로 지정할까?",
        )
        new_doc, applied, rejected = self.apply([op], doc=doc)
        self.assertEqual(applied, [])
        self.assertIn("limit", rejected[0])
        self.assertEqual(len(new_doc["open_questions"]), 20)
        self.assertIn("questions_capped", new_doc["meta"]["limits"])
        self.assertIsNone(STORE.validate_task(new_doc))

    def test_next_cap_rejects_the_add_and_deduplicates_the_limit(self):
        doc = self.fresh()
        doc["next"] = [next_item(index) for index in range(1, 11)]
        doc["meta"]["next_id"] = 11
        op = self.make_op("add", kind="next", text="열한 번째 할 일")
        new_doc, applied, rejected = self.apply([op], doc=doc)
        self.assertEqual(applied, [])
        self.assertIn("next_capped", new_doc["meta"]["limits"])
        again_doc, _applied, _rejected = self.apply([op], doc=new_doc)
        self.assertEqual(again_doc["meta"]["limits"].count("next_capped"), 1)
        self.assertEqual(len(again_doc["next"]), 10)

    def test_decision_cap_prunes_the_oldest_inactive_item(self):
        doc = self.fresh()
        decisions = [decision_item(index, status="superseded" if index == 1 else "active") for index in range(1, 81)]
        doc["decisions"] = decisions
        doc["meta"]["next_id"] = 100
        op = self.make_op("add", kind="decision", text="새 결정", by="user", quote="새 결정 인용문입니다")
        new_doc, applied, rejected = self.apply([op], mode="manager", doc=doc)
        self.assertEqual(rejected, [])
        self.assertEqual(len(new_doc["decisions"]), 80)
        self.assertNotIn("d1", [item["id"] for item in new_doc["decisions"]])
        self.assertEqual(new_doc["decisions"][-1]["id"], "d100")
        self.assertIn("decisions_capped", new_doc["meta"]["limits"])
        self.assertIsNone(STORE.validate_task(new_doc))

    def test_decision_cap_rejects_when_everything_is_active(self):
        doc = self.fresh()
        doc["decisions"] = [decision_item(index) for index in range(1, 81)]
        op = self.make_op("add", kind="decision", text="새 결정", by="user", quote="새 결정 인용문입니다")
        new_doc, applied, rejected = self.apply([op], mode="manager", doc=doc)
        self.assertEqual(applied, [])
        self.assertIn("limit", rejected[0])
        self.assertEqual(len(new_doc["decisions"]), 80)
        self.assertIn("decisions_capped", new_doc["meta"]["limits"])


class BoundsTest(StoreTestCase):
    def test_inactive_question_cap_prunes_the_oldest(self):
        doc = self.fresh()
        doc["open_questions"] = [question_item(index, status="resolved") for index in range(1, 32)]
        new_doc, applied, rejected = self.apply([self.make_op("set_title", text="정리")], doc=doc)
        self.assertEqual(rejected, [])
        self.assertEqual(applied, ["set_title"])
        self.assertEqual(len(new_doc["open_questions"]), STORE.MAX_INACTIVE_QUESTIONS)
        self.assertNotIn("q1", [item["id"] for item in new_doc["open_questions"]])
        self.assertIn("questions_pruned", new_doc["meta"]["limits"])
        self.assertIsNone(STORE.validate_task(new_doc))

    def test_inactive_next_cap_prunes_the_oldest(self):
        doc = self.fresh()
        doc["next"] = [next_item(index, status="resolved") for index in range(1, 32)]
        new_doc, _applied, rejected = self.apply([self.make_op("set_title", text="정리")], doc=doc)
        self.assertEqual(rejected, [])
        self.assertEqual(len(new_doc["next"]), STORE.MAX_INACTIVE_NEXT)
        self.assertNotIn("n1", [item["id"] for item in new_doc["next"]])
        self.assertIn("next_pruned", new_doc["meta"]["limits"])
        self.assertIsNone(STORE.validate_task(new_doc))

    def test_removed_plan_cap_prunes_the_oldest(self):
        doc = self.fresh()
        doc["plans"] = [removed_plan(index) for index in range(1, 12)]
        new_doc, _applied, rejected = self.apply([self.make_op("set_title", text="정리")], doc=doc)
        self.assertEqual(rejected, [])
        self.assertEqual(len(new_doc["plans"]), STORE.MAX_REMOVED_PLANS)
        self.assertNotIn("docs/plans/plan-01.md", [plan["path"] for plan in new_doc["plans"]])
        self.assertIn("plans_pruned", new_doc["meta"]["limits"])
        self.assertIsNone(STORE.validate_task(new_doc))

    def test_counts_beyond_the_new_caps_are_invalid(self):
        cases = [
            (
                lambda doc: doc.__setitem__(
                    "open_questions", [question_item(i, status="resolved") for i in range(1, 32)]),
                "30 inactive",
            ),
            (
                lambda doc: doc.__setitem__(
                    "next", [next_item(i, status="superseded") for i in range(1, 32)]),
                "30 inactive",
            ),
            (
                lambda doc: doc.__setitem__("plans", [removed_plan(i) for i in range(1, 12)]),
                "10 removed",
            ),
            (
                lambda doc: doc["meta"].__setitem__(
                    "cursor", {"s%02d" % i: cursor_entry(i) for i in range(1, 34)}),
                "32 sessions",
            ),
        ]
        for mutate, snippet in cases:
            doc = self.fresh()
            mutate(doc)
            reason = STORE.validate_task(doc)
            self.assertIsNotNone(reason, snippet)
            self.assertIn(snippet, reason)

    def test_cursor_line_and_updated_are_optional(self):
        doc = self.fresh()
        self.assertIsNone(STORE.validate_task(doc))
        entry = doc["meta"]["cursor"]["sess-8f2c"]
        entry["line"] = 12
        entry["updated"] = NOW
        self.assertIsNone(STORE.validate_task(doc))
        entry["line"] = -1
        self.assertIn("cursor line", STORE.validate_task(doc))
        entry["line"] = 12
        entry["updated"] = "2026-09-25"
        self.assertIn("cursor updated", STORE.validate_task(doc))

    def test_prune_cursor_keeps_the_newest_32(self):
        doc = self.fresh()
        doc["meta"]["cursor"] = {
            "s%02d" % index: cursor_entry(index, "2026-09-25T00:%02d:00Z" % index)
            for index in range(1, 35)
        }
        removed = STORE.prune_cursor(doc, NOW)
        self.assertEqual(removed, ["s01", "s02"])
        self.assertEqual(len(doc["meta"]["cursor"]), STORE.MAX_CURSOR_SESSIONS)
        self.assertNotIn("s01", doc["meta"]["cursor"])
        self.assertNotIn("s02", doc["meta"]["cursor"])
        self.assertIn("cursor_pruned", doc["meta"]["limits"])
        self.assertIsNone(STORE.validate_task(doc))

    def test_prune_cursor_treats_missing_updated_as_the_oldest(self):
        doc = self.fresh()
        entries = {
            "new%02d" % index: cursor_entry(index, "2026-09-25T00:%02d:00Z" % index)
            for index in range(1, 34)
        }
        entries["stale"] = cursor_entry(99)
        doc["meta"]["cursor"] = entries
        removed = STORE.prune_cursor(doc, NOW)
        self.assertEqual(removed, ["stale", "new01"],
                         "updated가 없으면 가장 오래된 것으로 취급한다")
        self.assertNotIn("stale", doc["meta"]["cursor"])
        self.assertEqual(len(doc["meta"]["cursor"]), STORE.MAX_CURSOR_SESSIONS)

    def test_cursor_pending_fields_are_optional_and_bounded(self):
        doc = self.fresh()
        entry = doc["meta"]["cursor"]["sess-8f2c"]
        entry["pending_plan_ids"] = ["toolu_1", "toolu_2"]
        entry["pending_questions"] = {"call_1": {"q1": "질문 문구"}}
        self.assertIsNone(STORE.validate_task(doc))

        entry["pending_plan_ids"] = [
            "t%d" % index for index in range(STORE.MAX_PENDING_PLAN_IDS + 1)]
        self.assertIn("pending_plan_ids", STORE.validate_task(doc))
        entry["pending_plan_ids"] = []
        entry["pending_questions"] = {
            "c%d" % index: {"q": "질문"}
            for index in range(STORE.MAX_PENDING_QUESTIONS + 1)}
        self.assertIn("pending_questions", STORE.validate_task(doc))
        entry["pending_questions"] = {"c1": {"q1": "x" * (STORE.MAX_PENDING_QUESTION_TEXT + 1)}}
        self.assertIn("pending_questions", STORE.validate_task(doc))
        entry["pending_questions"] = {"c1": 3}
        self.assertIn("pending_questions", STORE.validate_task(doc))
        entry["pending_questions"] = {"c1": {"q1": 3}}
        self.assertIn("pending_questions", STORE.validate_task(doc))
        entry["pending_questions"] = {"": {"q1": "질문 문구"}}
        self.assertIn("pending_questions", STORE.validate_task(doc))

        entry["pending_questions"] = None
        entry["pending_plan_ids"] = [1]
        self.assertIn("pending_plan_ids", STORE.validate_task(doc))


class StoreUpdateTest(StoreTestCase):
    def test_create_and_load_round_trip_with_modes(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "1" * 20
            created = STORE.update_task(
                manager_dir, key, lambda doc: None,
                create=lambda: STORE.new_task("/work/repo", "Ubuntu-24.04", NOW),
            )
            self.assertEqual(created["meta"]["next_id"], 1)
            path = STORE.task_path(manager_dir, key)
            self.assertTrue(path.is_file())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            loaded, error = STORE.load_task(manager_dir, key)
            self.assertIsNone(error)
            self.assertEqual(loaded, created)

    def test_missing_task_without_create_is_an_error(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "2" * 20
            with self.assertRaises(ValueError):
                STORE.update_task(manager_dir, key, lambda doc: None)
            self.assertFalse(STORE.task_path(manager_dir, key).exists())

    def test_invalid_created_document_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "3" * 20
            with self.assertRaises(ValueError):
                STORE.update_task(manager_dir, key, lambda doc: None, create=lambda: {"meta": {}})
            self.assertFalse(STORE.task_path(manager_dir, key).exists())

    def test_invalid_mutation_is_refused_and_the_file_is_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "4" * 20
            STORE.update_task(
                manager_dir, key, lambda doc: None,
                create=lambda: STORE.new_task("/work/repo", None, NOW),
            )
            path = STORE.task_path(manager_dir, key)
            before = path.read_bytes()

            def break_it(doc):
                doc["title"] = "x" * 200
                return doc

            with self.assertRaises(ValueError) as raised:
                STORE.update_task(manager_dir, key, break_it)
            self.assertIn("title", str(raised.exception))
            self.assertEqual(path.read_bytes(), before)

    def test_mutate_sees_the_latest_document(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "5" * 20
            STORE.update_task(
                manager_dir, key, lambda doc: None,
                create=lambda: STORE.new_task("/work/repo", None, NOW),
            )

            def first(doc):
                doc["meta"]["next_id"] = 10
                return doc

            def second(doc):
                doc["meta"]["next_id"] = doc["meta"]["next_id"] + 1
                return doc

            STORE.update_task(manager_dir, key, first)
            updated = STORE.update_task(manager_dir, key, second)
            self.assertEqual(updated["meta"]["next_id"], 11)

    def test_load_task_reports_broken_files(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "6" * 20
            self.assertEqual(STORE.load_task(manager_dir, key), (None, None))
            path = STORE.task_path(manager_dir, key)
            path.parent.mkdir(parents=True)
            path.write_text("{not json", encoding="utf-8")
            doc, error = STORE.load_task(manager_dir, key)
            self.assertIsNone(doc)
            self.assertIn("invalid JSON", error)
            path.write_text(json.dumps({"meta": {}}), encoding="utf-8")
            doc, error = STORE.load_task(manager_dir, key)
            self.assertIsNone(doc)
            self.assertIn("invalid task", error)

    def test_update_task_does_not_overwrite_a_broken_file(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = "k" + "7" * 20
            path = STORE.task_path(manager_dir, key)
            path.parent.mkdir(parents=True)
            path.write_text("{broken", encoding="utf-8")
            with self.assertRaises(ValueError):
                STORE.update_task(manager_dir, key, lambda doc: None, create=lambda: STORE.new_task("/x", None, NOW))
            self.assertEqual(path.read_text(encoding="utf-8"), "{broken")


class ArchiveResumeTest(StoreTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager_dir = Path(self.temp.name)
        self.key = "k" + "8" * 20
        STORE.update_task(
            self.manager_dir, self.key, lambda doc: None,
            create=lambda: STORE.new_task("/work/repo", "Ubuntu-24.04", NOW),
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_archive_moves_the_task_and_marks_it(self):
        archived = STORE.archive_task(self.manager_dir, self.key, "2026-09-25T04:00:00Z")
        self.assertEqual(archived["meta"]["status"], "archived")
        self.assertIsNone(STORE.load_task(self.manager_dir, self.key)[0])
        path = STORE.latest_archive(self.manager_dir, self.key)
        self.assertIsNotNone(path)
        self.assertEqual(path.name, self.key + "--20260925T040000Z.json")
        stored = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(stored["meta"]["status"], "archived")

    def test_latest_archive_returns_the_newest(self):
        STORE.archive_task(self.manager_dir, self.key, "2026-09-25T04:00:00Z")
        STORE.update_task(
            self.manager_dir, self.key, lambda doc: None,
            create=lambda: STORE.new_task("/work/repo", "Ubuntu-24.04", NOW),
        )
        STORE.archive_task(self.manager_dir, self.key, "2026-09-25T05:00:00Z")
        path = STORE.latest_archive(self.manager_dir, self.key)
        self.assertEqual(path.name, self.key + "--20260925T050000Z.json")

    def test_same_second_archives_get_suffixes_and_latest_is_the_last(self):
        STORE.archive_task(self.manager_dir, self.key, "2026-09-25T04:00:00Z")
        STORE.update_task(
            self.manager_dir, self.key, lambda doc: None,
            create=lambda: STORE.new_task("/work/repo", "Ubuntu-24.04", NOW),
        )
        STORE.archive_task(self.manager_dir, self.key, "2026-09-25T04:00:00Z")
        names = sorted(entry.name for entry in (self.manager_dir / "archive").iterdir())
        self.assertEqual(names, [
            self.key + "--20260925T040000Z-1.json",
            self.key + "--20260925T040000Z.json",
        ])
        self.assertEqual(
            STORE.latest_archive(self.manager_dir, self.key).name,
            self.key + "--20260925T040000Z-1.json",
        )

    def test_archives_keep_the_newest_five(self):
        for hour in range(1, 7):
            STORE.update_task(
                self.manager_dir, self.key, lambda doc: None,
                create=lambda: STORE.new_task("/work/repo", "Ubuntu-24.04", NOW),
            )
            STORE.archive_task(self.manager_dir, self.key, "2026-09-25T0%d:00:00Z" % hour)
        names = sorted(entry.name for entry in (self.manager_dir / "archive").iterdir())
        self.assertEqual(len(names), STORE.MAX_ARCHIVES)
        self.assertNotIn(self.key + "--20260925T010000Z.json", names)
        self.assertEqual(
            STORE.latest_archive(self.manager_dir, self.key).name,
            self.key + "--20260925T060000Z.json",
        )

    def test_resume_restores_the_latest_archive_and_deletes_it(self):
        STORE.archive_task(self.manager_dir, self.key, "2026-09-25T04:00:00Z")
        STORE.update_task(
            self.manager_dir, self.key, lambda doc: None,
            create=lambda: STORE.new_task("/work/repo", "Ubuntu-24.04", NOW),
        )
        STORE.archive_task(self.manager_dir, self.key, "2026-09-25T05:00:00Z")
        restored = STORE.resume_task(self.manager_dir, self.key, "2026-09-25T06:00:00Z")
        self.assertEqual(restored["meta"]["status"], "active")
        self.assertEqual(restored["meta"]["updated_at"], "2026-09-25T06:00:00Z")
        loaded, error = STORE.load_task(self.manager_dir, self.key)
        self.assertIsNone(error)
        self.assertEqual(loaded["meta"]["status"], "active")
        remaining = sorted(entry.name for entry in (self.manager_dir / "archive").iterdir())
        self.assertEqual(remaining, [self.key + "--20260925T040000Z.json"])
        self.assertEqual(STORE.latest_archive(self.manager_dir, self.key).name, remaining[0])

    def test_resume_without_archive_fails(self):
        other = "k" + "a" * 20
        with self.assertRaises(ValueError):
            STORE.resume_task(self.manager_dir, other)

    def test_resume_with_an_active_task_fails(self):
        STORE.archive_task(self.manager_dir, self.key, "2026-09-25T04:00:00Z")
        STORE.update_task(
            self.manager_dir, self.key, lambda doc: None,
            create=lambda: STORE.new_task("/work/repo", "Ubuntu-24.04", NOW),
        )
        with self.assertRaises(ValueError):
            STORE.resume_task(self.manager_dir, self.key, "2026-09-25T05:00:00Z")

    def test_archive_missing_task_fails(self):
        with self.assertRaises(ValueError):
            STORE.archive_task(self.manager_dir, "k" + "b" * 20, NOW)


CONCURRENT_WORKER = """
import importlib.util, sys
spec = importlib.util.spec_from_file_location("mast_manager_worker", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manager_dir, key, count = sys.argv[2], sys.argv[3], int(sys.argv[4])
patch = {
    "verdict": "update",
    "notify": "none",
    "notify_reason": None,
    "ops": [{
        "op": "add", "kind": "next", "id": None, "text": "동시 쓰기 할 일", "by": None,
        "anchor_ref": None, "quote": None, "reported_done": None, "verified_done": None,
        "path": None, "goal": None, "steps": None,
    }],
}

def mutate(doc):
    new_doc, applied, rejected = module.apply_patch(doc, patch, "manager", manager_tab=6)
    return new_doc

for _ in range(count):
    module.update_task(manager_dir, key, mutate)
"""


class ConcurrentWriteTest(StoreTestCase):
    def test_two_processes_do_not_lose_updates(self):
        with tempfile.TemporaryDirectory() as temp:
            manager_dir = Path(temp)
            key = STORE.task_key("/work/repo", "Ubuntu-24.04")
            STORE.update_task(
                manager_dir, key, lambda doc: None,
                create=lambda: STORE.new_task("/work/repo", "Ubuntu-24.04", NOW),
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
            doc, error = STORE.load_task(manager_dir, key)
            self.assertIsNone(error)
            self.assertEqual(len(doc["next"]), STORE.MAX_NEXT_ITEMS)
            self.assertEqual(doc["meta"]["next_id"], STORE.MAX_NEXT_ITEMS + 1)
            self.assertEqual(doc["meta"]["rejected_ops"], 200 - STORE.MAX_NEXT_ITEMS)
            self.assertIn("next_capped", doc["meta"]["limits"])
            self.assertIsNone(STORE.validate_task(doc))


if __name__ == "__main__":
    unittest.main()
