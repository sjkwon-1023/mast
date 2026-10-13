#!/usr/bin/env python3
"""mast-manager-harness.py의 transcript 델타 읽기·발화 추출 테스트 (macOS·Linux 공용).

`apps/mast/tests/manager-python.test.ts`의 CI 래퍼가 이 스위트를 돌린다.
fixtures/manager/*.jsonl은 정제된 실제 transcript이며 수정하지 않고 읽기만 한다.
"""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
HARNESS_PATH = ROOT / "scripts" / "wsl" / "mast-manager-harness.py"
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "manager"

CLAUDE_SESSION = "claude-session.jsonl"
CLAUDE_PLAN_APPROVED = "claude-plan-approved.jsonl"
CLAUDE_TOOL_REJECTED = "claude-tool-rejected.jsonl"
CODEX_REQUEST_INPUT = "codex-request-input.jsonl"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HARNESS = load_module("mast_manager_harness_extract_test", HARNESS_PATH)


def fixture_bytes(name):
    return (FIXTURE_DIR / name).read_bytes()


def fixture_lines(name):
    return fixture_bytes(name).decode("utf-8").splitlines()


def read_fixture(name):
    """fixture를 offset 0에서 읽는다. `(lines, new_offset)`. 파일 끝은 개행이다."""
    lines, new_offset, restarted, more, _skipped = HARNESS.read_delta(
        str(FIXTURE_DIR / name), 0)
    assert not restarted
    assert not more
    return lines, new_offset


def texts_of(utterances):
    return [utterance["text"] for utterance in utterances]


def speeches_of(utterances, speaker):
    return [utterance for utterance in utterances if utterance["speaker"] == speaker]


def single(utterances, predicate):
    found = [utterance for utterance in utterances if predicate(utterance)]
    assert len(found) == 1, "expected exactly one utterance, got %d" % len(found)
    return found[0]


class ExtractTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def write(self, name, data):
        path = self.base / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path


class TestClaudeExtraction(ExtractTestCase):
    def test_session_fixture_keeps_conversation_only(self):
        raw = fixture_lines(CLAUDE_SESSION)
        lines, new_offset = read_fixture(CLAUDE_SESSION)
        self.assertEqual(new_offset, len(fixture_bytes(CLAUDE_SESSION)))
        utterances = HARNESS.extract_claude(lines)
        texts = texts_of(utterances)

        prompt = json.loads(raw[5])["message"]["content"]
        self.assertEqual(texts.count(prompt), 1)

        asked = single(utterances, lambda u: u["text"].startswith("Asked: Which color"))
        self.assertEqual(
            asked["text"], "Asked: Which color should the fixture use? (options: Red / Blue)")
        self.assertEqual(asked["speaker"], "assistant")
        answered = single(utterances, lambda u: u["text"].startswith("Answered: Which color"))
        self.assertEqual(
            answered["text"], "Answered: Which color should the fixture use? → Red")
        self.assertEqual(answered["speaker"], "user")

        final = json.loads(raw[37])["message"]["content"][0]["text"]
        self.assertIn(final, texts)

        # 발화는 speaker/text 두 키만 가진다 — anchor·line·quote 저장은 없다.
        for utterance in utterances:
            self.assertEqual(sorted(utterance), ["speaker", "text"])

        # 도구 출력·서브에이전트·메타·thinking 줄은 발화를 만들지 않는다.
        for text in texts:
            self.assertNotIn("Async agent launched", text)
            self.assertNotIn("[Subagent hand-back]", text)
            self.assertNotIn("Another Claude session sent", text)
            self.assertNotIn("<task-notification>", text)
            self.assertNotIn("(thinking omitted)", text)
        # Bash 도구 결과("fixture-hello")가 발화로 들어가지 않는다.
        self.assertNotIn("fixture-hello", texts)
        self.assertEqual(len(speeches_of(utterances, "user")), 2)
        self.assertEqual(len(speeches_of(utterances, "assistant")), 6)

    def test_meta_tag_text_and_interrupt_are_dropped(self):
        lines = [
            json.dumps({
                "type": "user",
                "message": {"role": "user", "content": "<system-reminder>\nkeep out"},
                "uuid": "a",
            }),
            json.dumps({
                "type": "user",
                "message": {"role": "user", "content": [
                    {"type": "text", "text": "[Request interrupted by user for tool use]"}]},
                "uuid": "b",
            }),
            json.dumps({
                "type": "user",
                "message": {"role": "user", "content": "real prompt"},
                "uuid": "c",
            }),
        ]
        self.assertEqual(texts_of(HARNESS.extract_claude(lines)), ["real prompt"])

    def test_plan_approved_fixture(self):
        raw = fixture_lines(CLAUDE_PLAN_APPROVED)
        lines, _ = read_fixture(CLAUDE_PLAN_APPROVED)
        utterances = HARNESS.extract_claude(lines)
        texts = texts_of(utterances)

        plan_line = json.loads(raw[24])
        plan = plan_line["message"]["content"][0]["input"]["plan"]
        proposed = single(utterances, lambda u: u["text"].startswith("Proposed plan:"))
        self.assertEqual(proposed["text"], "Proposed plan: " + plan)
        self.assertEqual(proposed["speaker"], "assistant")
        approved = single(utterances, lambda u: u["text"] == "Approved the plan.")
        self.assertEqual(approved["speaker"], "user")
        self.assertEqual(len(utterances), 5)

        # Read/ToolSearch/Write/Edit/Bash 출력은 발화가 아니다.
        for text in texts:
            self.assertNotIn("file state is current", text)
            self.assertNotIn("File created successfully", text)
            self.assertNotIn("has been updated successfully", text)
            self.assertNotIn("tool_reference", text)
            self.assertNotIn("?? README.md", text)

    def test_tool_rejected_fixture_edit_rejection_is_not_an_utterance(self):
        raw = fixture_lines(CLAUDE_TOOL_REJECTED)
        lines, _ = read_fixture(CLAUDE_TOOL_REJECTED)
        utterances = HARNESS.extract_claude(lines)
        texts = texts_of(utterances)

        approved = single(utterances, lambda u: u["text"] == "Approved the plan.")
        self.assertEqual(approved["speaker"], "user")
        self.assertNotIn("Rejected the plan.", texts)
        for text in texts:
            self.assertNotIn("doesn't want to proceed", text)
            self.assertNotIn("[Request interrupted", text)
        self.assertEqual(len(utterances), 4)

    def test_exit_plan_rejection_is_recognized_within_a_delta(self):
        raw = fixture_lines(CLAUDE_TOOL_REJECTED)
        plan_line = json.loads(raw[24])
        edit_result = json.loads(raw[31])
        plan_block = plan_line["message"]["content"][0]
        edit_block = edit_result["message"]["content"][0]
        self.assertEqual(plan_block["name"], "ExitPlanMode")
        self.assertIs(edit_block["is_error"], True)
        self.assertEqual(edit_result["toolUseResult"], "User rejected tool use")

        synthetic = json.loads(json.dumps(edit_result))
        synthetic["message"]["content"][0]["tool_use_id"] = plan_block["id"]
        lines = [json.dumps(plan_line), json.dumps(synthetic)]
        utterances = HARNESS.extract_claude(lines)
        self.assertEqual(texts_of(utterances), [
            "Proposed plan: " + plan_block["input"]["plan"],
            "Rejected the plan.",
        ])
        self.assertEqual(utterances[1]["speaker"], "user")

    def test_plan_key_tool_use_result_is_a_rejection_without_a_known_id(self):
        synthetic = {
            "type": "user",
            "uuid": "u-reject",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "unknown-plan-tool", "is_error": True,
                 "content": "The user doesn't want to proceed with this tool use."},
            ]},
            "toolUseResult": {"plan": "# plan", "planFilePath": "/home/u/.claude/plans/x.md"},
        }
        utterances = HARNESS.extract_claude([json.dumps(synthetic)])
        self.assertEqual(texts_of(utterances), ["Rejected the plan."])

    def test_approval_prefix_in_another_tool_result_is_not_an_approval(self):
        line = {
            "type": "user",
            "uuid": "u-bash",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_bash", "is_error": False,
                 "content": "User has approved your plan\nbut this is command output"},
            ]},
            "toolUseResult": "Command output",
        }
        self.assertEqual(HARNESS.extract_claude([json.dumps(line)]), [])

    def test_answer_without_question_uses_answers_key(self):
        raw = fixture_lines(CLAUDE_SESSION)
        answer_line = json.loads(raw[20])
        utterances = HARNESS.extract_claude([json.dumps(answer_line)])
        self.assertEqual(texts_of(utterances), [
            "Answered: Which color should the fixture use? → Red"])
        self.assertEqual(utterances[0]["speaker"], "user")

    def test_tool_use_result_string_is_dropped(self):
        raw = fixture_lines(CLAUDE_SESSION)
        answer_line = json.loads(raw[20])
        answer_line["toolUseResult"] = "Your questions have been answered."
        self.assertEqual(HARNESS.extract_claude([json.dumps(answer_line)]), [])


class TestCodexExtraction(ExtractTestCase):
    def test_request_input_fixture(self):
        lines, _ = read_fixture(CODEX_REQUEST_INPUT)
        utterances = HARNESS.extract_codex(lines)
        texts = texts_of(utterances)

        asked = single(utterances, lambda u: u["text"].startswith("Asked: Fixture"))
        self.assertEqual(
            asked["text"], "Asked: Fixture는 어떤 색상을 사용해야 하나요? (options: Red / Blue)")
        self.assertEqual(asked["speaker"], "assistant")
        answered = single(utterances, lambda u: u["text"].startswith("Answered: Fixture"))
        self.assertEqual(
            answered["text"], "Answered: Fixture는 어떤 색상을 사용해야 하나요? → Red")
        self.assertEqual(answered["speaker"], "user")
        # exec·reasoning·developer 메시지는 발화가 아니다.
        for utterance in utterances:
            self.assertEqual(sorted(utterance), ["speaker", "text"])

    def test_answer_without_question_uses_question_id(self):
        raw = fixture_lines(CODEX_REQUEST_INPUT)
        output_line = json.loads(raw[12])
        utterances = HARNESS.extract_codex([json.dumps(output_line)])
        self.assertEqual(texts_of(utterances), ["Answered: fixture_color → Red"])
        self.assertEqual(utterances[0]["speaker"], "user")

    def test_answer_in_the_next_delta_keeps_the_answer_text(self):
        raw = fixture_lines(CODEX_REQUEST_INPUT)
        question_line = json.loads(raw[10])
        output_line = json.loads(raw[12])
        first = HARNESS.extract_codex([json.dumps(question_line)])
        self.assertEqual(texts_of(first), [
            "Asked: Fixture는 어떤 색상을 사용해야 하나요? (options: Red / Blue)"])
        second = HARNESS.extract_codex([json.dumps(output_line)])
        self.assertEqual(texts_of(second), ["Answered: fixture_color → Red"])

    def test_same_delta_question_text_is_used_for_the_answer(self):
        raw = fixture_lines(CODEX_REQUEST_INPUT)
        lines = [json.dumps(json.loads(raw[10])), json.dumps(json.loads(raw[12]))]
        utterances = HARNESS.extract_codex(lines)
        self.assertEqual(texts_of(utterances), [
            "Asked: Fixture는 어떤 색상을 사용해야 하나요? (options: Red / Blue)",
            "Answered: Fixture는 어떤 색상을 사용해야 하나요? → Red",
        ])

    def test_invalid_question_ids_fall_back_to_the_id(self):
        call = {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "request_user_input",
                "call_id": "call-1",
                "arguments": json.dumps({"questions": [
                    {"id": 7, "question": "정수 id 질문"},
                    {"id": "q1", "question": "정상 질문"},
                ]}),
            },
        }
        output = {
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-1",
                "output": json.dumps({"answers": {"q1": {"answers": ["A"]}, "7": {"answers": ["B"]}}}),
            },
        }
        utterances = HARNESS.extract_codex([json.dumps(call), json.dumps(output)])
        self.assertIn("Answered: 정상 질문 → A", texts_of(utterances))
        self.assertIn("Answered: 7 → B", texts_of(utterances))

    def test_user_input_with_several_kinds_keeps_only_the_text(self):
        raw = fixture_lines(CODEX_REQUEST_INPUT)
        line = json.loads(raw[5])
        metadata = line["payload"]["internal_chat_message_metadata_passthrough"]
        metadata["content_item_kinds"] = ["input_image", "user.text"]
        utterances = HARNESS.extract_codex([json.dumps(line)])
        self.assertEqual(len(utterances), 1)
        self.assertEqual(utterances[0]["speaker"], "user")
        self.assertNotIn("image", utterances[0]["text"])


class TestReadDelta(ExtractTestCase):
    def test_reads_complete_lines_and_defers_incomplete_tail(self):
        path = self.write("delta.jsonl", b'{"a":1}\n{"b":2}\n{"c"')
        lines, new_offset, restarted, more, skipped = HARNESS.read_delta(str(path), 0)
        self.assertEqual(lines, ['{"a":1}', '{"b":2}'])
        self.assertEqual(new_offset, len(b'{"a":1}\n{"b":2}\n'))
        self.assertFalse(restarted)
        self.assertFalse(more)
        self.assertEqual(skipped, 0)

    def test_small_file_first_read_starts_at_zero(self):
        path = self.write("small.jsonl", b"one\ntwo\n")
        lines, new_offset, _restarted, _more, _skipped = HARNESS.read_delta(
            str(path), None, tail_bytes=1024)
        self.assertEqual(lines, ["one", "two"])
        self.assertEqual(new_offset, path.stat().st_size)

    def test_size_below_offset_restarts_from_tail(self):
        path = self.write("shrink.jsonl", b"a\nb\n")
        lines, new_offset, restarted, _more, _skipped = HARNESS.read_delta(str(path), 99)
        self.assertTrue(restarted)
        self.assertEqual(lines, ["a", "b"])
        self.assertEqual(new_offset, path.stat().st_size)

    def test_first_read_of_large_file_uses_aligned_tail(self):
        path = self.write("large.jsonl", b"x" * 30 + b"\n" + b"tail\n")
        lines, new_offset, restarted, _more, _skipped = HARNESS.read_delta(
            str(path), None, tail_bytes=10)
        self.assertFalse(restarted)
        self.assertEqual(lines, ["tail"])
        self.assertEqual(new_offset, path.stat().st_size)

    def test_first_read_without_newline_after_tail_returns_previous_boundary(self):
        path = self.write("oneline.jsonl", b"x" * 50 + b"\n" + b"y" * 100)
        lines, new_offset, _restarted, _more, _skipped = HARNESS.read_delta(
            str(path), None, tail_bytes=10)
        self.assertEqual(lines, [])
        self.assertEqual(new_offset, 51, "tail 앞의 마지막 완전한 줄 경계로 돌아간다")

    def test_offset_at_eof_reads_nothing(self):
        path = self.write("eof.jsonl", b"one\n")
        before = path.stat().st_size
        lines, new_offset, restarted, more, skipped = HARNESS.read_delta(str(path), before)
        self.assertEqual(lines, [])
        self.assertEqual(new_offset, before)
        self.assertFalse(restarted)
        self.assertFalse(more)
        self.assertEqual(skipped, 0)

    def test_byte_cap_splits_the_delta_without_gaps_or_duplicates(self):
        path = self.write("cap.jsonl", b"one\ntwo\nthree\n")
        collected = []
        offset = 0
        rounds = 0
        while True:
            lines, offset, _restarted, more, _skipped = HARNESS.read_delta(
                str(path), offset, max_bytes=6)
            collected.extend(lines)
            rounds += 1
            if not more or rounds > 10:
                break
        self.assertEqual(collected, ["one", "two", "three"])
        self.assertEqual(offset, path.stat().st_size)

    def test_oversized_line_is_skipped_and_the_next_line_is_read(self):
        oversized = b"huge-" + b"x" * 200 + b"\n"
        path = self.write("oversized.jsonl", oversized + b"after\n")
        lines, new_offset, _restarted, more, skipped = HARNESS.read_delta(
            str(path), 0, max_bytes=32)
        self.assertEqual(lines, [])
        self.assertEqual(skipped, len(oversized))
        self.assertEqual(new_offset, len(oversized))
        self.assertTrue(more, "버린 줄 뒤의 다음 줄을 이어 읽는다")
        lines, new_offset, _restarted, more, skipped = HARNESS.read_delta(
            str(path), new_offset, max_bytes=32)
        self.assertEqual(lines, ["after"])
        self.assertEqual(new_offset, path.stat().st_size)
        self.assertFalse(more)

    def test_incomplete_oversized_line_is_still_deferred(self):
        path = self.write("partial-oversized.jsonl", b"x" * 200)
        lines, new_offset, _restarted, more, skipped = HARNESS.read_delta(
            str(path), 0, max_bytes=32)
        self.assertEqual(lines, [])
        self.assertEqual(new_offset, 0)
        self.assertEqual(skipped, 0)
        self.assertFalse(more)


class TestTranscriptAllowed(ExtractTestCase):
    def allowed_roots(self):
        return [str(self.base)]

    def test_allowed_file_inside_root(self):
        path = self.write("ok/session.jsonl", b"{}\n")
        ok, reason = HARNESS.transcript_allowed(str(path), self.allowed_roots())
        self.assertTrue(ok, reason)

    def test_outside_root_rejected(self):
        outside = Path(tempfile.mkdtemp()) / "session.jsonl"
        self.addCleanup(shutil.rmtree, str(outside.parent), True)
        outside.write_bytes(b"{}\n")
        ok, reason = HARNESS.transcript_allowed(str(outside), self.allowed_roots())
        self.assertFalse(ok)
        self.assertIn("outside the allowed roots", reason)

    def test_non_jsonl_rejected(self):
        path = self.write("session.txt", b"{}\n")
        ok, reason = HARNESS.transcript_allowed(str(path), self.allowed_roots())
        self.assertFalse(ok)
        self.assertIn(".jsonl", reason)

    def test_directory_rejected(self):
        target = self.base / "dir.jsonl"
        target.mkdir()
        ok, reason = HARNESS.transcript_allowed(str(target), self.allowed_roots())
        self.assertFalse(ok)
        self.assertIn("regular file", reason)

    def test_symlink_to_outside_rejected(self):
        outside = Path(tempfile.mkdtemp()) / "session.jsonl"
        self.addCleanup(shutil.rmtree, str(outside.parent), True)
        outside.write_bytes(b"{}\n")
        link = self.base / "link.jsonl"
        os.symlink(str(outside), str(link))
        ok, reason = HARNESS.transcript_allowed(str(link), self.allowed_roots())
        self.assertFalse(ok)
        self.assertIn("outside the allowed roots", reason)

    def test_missing_file_rejected(self):
        ok, reason = HARNESS.transcript_allowed(str(self.base / "nope.jsonl"), self.allowed_roots())
        self.assertFalse(ok)
        self.assertIn("cannot stat", reason)

    def test_default_roots_follow_home_and_codex_home(self):
        roots = HARNESS._transcript_roots("/tmp/codex-home")
        self.assertEqual(roots[0], os.path.expanduser("~/.claude/projects"))
        self.assertEqual(roots[1], "/tmp/codex-home/sessions")

    def test_codex_home_argument_overrides_environment(self):
        with mock.patch.dict(os.environ, {"CODEX_HOME": "/env"}):
            self.assertEqual(HARNESS._transcript_roots()[1], "/env/sessions")
            self.assertEqual(HARNESS._transcript_roots("/arg")[1], "/arg/sessions")


class TestCollect(ExtractTestCase):
    def collect(self, name="claude-session.jsonl"):
        path = self.write(name, fixture_bytes(name))
        meta = {
            "agent": "claude",
            "sessionId": "sess-fixed",
            "transcriptPath": str(path),
            "tab": 4,
        }
        return meta, path

    def test_collect_reads_delta_and_builds_cursor(self):
        meta, path = self.collect()
        result = HARNESS.collect(meta, None, [str(self.base)])
        self.assertIsNone(result["rejected_reason"])
        self.assertTrue(result["utterances"])
        self.assertEqual(result["new_offset"], path.stat().st_size)
        cursor = result["cursor"]
        self.assertEqual(cursor["agent"], "claude")
        self.assertEqual(cursor["transcript_path"], str(path))
        self.assertEqual(cursor["offset"], path.stat().st_size)
        self.assertEqual(cursor["tab"], 4)
        self.assertTrue(cursor["updated"])
        self.assertNotIn("line", cursor)
        self.assertNotIn("pending_plan_ids", cursor)
        self.assertNotIn("pending_questions", cursor)
        self.assertEqual(list(result["cursor_updates"]), ["sess-fixed"])

    def test_collect_continues_a_capped_delta_without_duplicates(self):
        meta, path = self.collect()
        first = HARNESS.collect(meta, None, [str(self.base)], max_bytes=2048)
        texts = texts_of(first["utterances"])
        rounds = 0
        while first["more"] and rounds < 100:
            first = HARNESS.collect(
                meta, first["cursor_updates"], [str(self.base)], max_bytes=2048)
            texts.extend(texts_of(first["utterances"]))
            rounds += 1
        self.assertFalse(first["more"])
        self.assertEqual(first["cursor"]["offset"], path.stat().st_size)
        self.assertEqual(len(texts), len(set(texts)), "중복 없이 이어 읽는다")

    def test_collect_accepts_the_whole_cursor_mapping(self):
        meta, _path = self.collect()
        cursor = {
            "sess-fixed": {
                "agent": "claude",
                "transcript_path": str(meta["transcriptPath"]),
                "offset": 0,
                "updated": None,
                "tab": 4,
            }
        }
        result = HARNESS.collect(meta, cursor, [str(self.base)])
        self.assertTrue(result["utterances"])

    def test_updated_moves_only_when_new_bytes_are_read(self):
        meta, path = self.collect()
        first = HARNESS.collect(meta, None, [str(self.base)], now="2026-09-25T01:00:00Z")
        second = HARNESS.collect(
            meta, first["cursor_updates"], [str(self.base)], now="2026-09-25T02:00:00Z")
        self.assertEqual(second["utterances"], [])
        self.assertEqual(
            second["cursor"]["updated"], "2026-09-25T01:00:00Z",
            "새 바이트가 없으면 updated를 유지한다")
        with path.open("ab") as stream:
            stream.write(json.dumps({
                "type": "user",
                "message": {"role": "user", "content": "new line"},
                "uuid": "new",
            }).encode("utf-8") + b"\n")
        third = HARNESS.collect(
            meta, second["cursor_updates"], [str(self.base)], now="2026-09-25T03:00:00Z")
        self.assertEqual(texts_of(third["utterances"]), ["new line"])
        self.assertEqual(third["cursor"]["updated"], "2026-09-25T03:00:00Z")

    def test_collect_rejects_path_outside_roots(self):
        path = self.write("session.jsonl", b"{}\n")
        meta = {"agent": "claude", "sessionId": "s", "transcriptPath": str(path), "tab": 4}
        result = HARNESS.collect(meta, None, [str(self.base / "elsewhere")])
        self.assertIsNotNone(result["rejected_reason"])
        self.assertEqual(result["utterances"], [])
        self.assertEqual(result["cursor_updates"], {})

    def test_collect_restarts_when_offset_exceeds_size(self):
        meta, path = self.collect()
        result = HARNESS.collect(meta, {"offset": path.stat().st_size + 10}, [str(self.base)])
        self.assertTrue(result["restarted"])
        self.assertEqual(result["cursor"]["offset"], path.stat().st_size)

    def test_collect_reads_a_changed_path_from_its_start(self):
        def user_line(text):
            return json.dumps({
                "type": "user",
                "message": {"role": "user", "content": text},
                "uuid": text,
            }).encode("utf-8") + b"\n"

        old_path = self.write("claude-old.jsonl", user_line("OLD"))
        meta = {
            "agent": "claude",
            "sessionId": "sess-fixed",
            "transcriptPath": str(old_path),
            "tab": 4,
        }
        first = HARNESS.collect(
            meta, None, [str(self.base)], now="2026-09-25T01:00:00Z")
        self.assertEqual(texts_of(first["utterances"]), ["OLD"])
        old_offset = first["cursor"]["offset"]

        new_path = self.write(
            "claude-new.jsonl",
            user_line("FIRST NEW MESSAGE MUST BE COLLECTED") + user_line("SECOND NEW MESSAGE"))
        self.assertGreater(new_path.stat().st_size, old_offset, "새 파일이 이전 offset보다 크다")
        meta["transcriptPath"] = str(new_path)
        second = HARNESS.collect(
            meta, first["cursor_updates"], [str(self.base)], now="2026-09-25T02:00:00Z")
        self.assertEqual(
            texts_of(second["utterances"]),
            ["FIRST NEW MESSAGE MUST BE COLLECTED", "SECOND NEW MESSAGE"],
            "경로가 바뀌면 이전 offset을 버리고 새 파일 처음부터 수집한다")
        self.assertEqual(second["cursor"]["transcript_path"], str(new_path))
        self.assertEqual(second["cursor"]["offset"], new_path.stat().st_size)
        self.assertEqual(second["cursor"]["updated"], "2026-09-25T02:00:00Z")

    def test_collect_uses_session_id_from_lines_when_hint_missing(self):
        meta, path = self.collect()
        meta["sessionId"] = None
        result = HARNESS.collect(meta, None, [str(self.base)])
        raw = json.loads(fixture_lines("claude-session.jsonl")[0])
        self.assertEqual(list(result["cursor_updates"]), [raw["sessionId"]])

    def test_collect_rejects_unknown_agent(self):
        meta, _path = self.collect()
        meta["agent"] = "gemini"
        result = HARNESS.collect(meta, None, [str(self.base)])
        self.assertIn("unsupported transcript agent", result["rejected_reason"])


if __name__ == "__main__":
    unittest.main()
