#!/usr/bin/env python3
"""mast-manager-harness.py의 transcript 델타 읽기·발화 추출 테스트 (macOS·Linux 공용).

`apps/mast/tests/manager-python.test.ts`의 CI 래퍼가 이 스위트를 돌린다.
fixtures/manager/*.jsonl은 정제된 실제 transcript이며 수정하지 않고 읽기만 한다.
"""

import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
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
    lines, new_offset, _line, restarted, more, _skipped = HARNESS.read_delta(str(FIXTURE_DIR / name), 0)
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
        utterances = HARNESS.extract_claude(lines, None, 7)
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

        # 도구 출력·서브에이전트·메타·thinking 줄은 발화를 만들지 않는다.
        self.assertEqual(
            [u["anchor"]["line_start"] for u in utterances],
            [6, 12, 20, 21, 23, 26, 33, 38])
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

    def test_anchors_use_file_line_numbers_and_line_uuid(self):
        raw = fixture_lines(CLAUDE_SESSION)
        lines, _ = read_fixture(CLAUDE_SESSION)
        utterances = HARNESS.extract_claude(lines, "unused-hint", 7)

        prompt_line = json.loads(raw[5])
        asked_line = json.loads(raw[19])
        answer_line = json.loads(raw[20])
        prompt = single(utterances, lambda u: u["text"] == prompt_line["message"]["content"])
        self.assertEqual(prompt["anchor"], {
            "agent": "claude",
            "session_id": prompt_line["sessionId"],
            "tab": 7,
            "line_start": 6,
            "line_end": 6,
            "message_id": prompt_line["uuid"],
        })
        asked = single(utterances, lambda u: u["text"].startswith("Asked:"))
        self.assertEqual(asked["anchor"]["line_start"], 20)
        self.assertEqual(asked["anchor"]["line_end"], 20)
        self.assertEqual(asked["anchor"]["agent"], "claude")
        self.assertEqual(asked["anchor"]["session_id"], asked_line["sessionId"])
        self.assertEqual(asked["anchor"]["tab"], 7)
        self.assertEqual(asked["anchor"]["message_id"], asked_line["uuid"])
        answered = single(utterances, lambda u: u["text"].startswith("Answered:"))
        self.assertEqual(answered["anchor"]["line_start"], 21)
        self.assertEqual(answered["anchor"]["message_id"], answer_line["uuid"])

    def collect_split(self, name, cut_lines, meta_tab=4, session_id=None):
        """fixture를 cut_lines까지 잘라 두 번 collect한다. `(first, second, path)`."""
        raw = fixture_lines(name)
        cut = ("\n".join(raw[:cut_lines]) + "\n").encode("utf-8")
        path = self.write("split-" + name, cut)
        meta = {
            "agent": "claude",
            "sessionId": session_id,
            "transcriptPath": str(path),
            "tab": meta_tab,
        }
        first = HARNESS.collect(meta, None, [str(self.base)])
        with path.open("ab") as stream:
            stream.write(("\n".join(raw[cut_lines:]) + "\n").encode("utf-8"))
        second = HARNESS.collect(meta, first["cursor_updates"], [str(self.base)])
        return first, second, path

    def test_plan_approval_in_the_next_delta_uses_pending_plan_ids(self):
        plan_block = json.loads(fixture_lines(CLAUDE_PLAN_APPROVED)[24])["message"]["content"][0]
        self.assertEqual(plan_block["name"], "ExitPlanMode")
        first, second, path = self.collect_split(CLAUDE_PLAN_APPROVED, 25)
        self.assertEqual(
            [u["text"] for u in first["utterances"]][-1][:13], "Proposed plan")
        entry = first["cursor"]["pending_plan_ids"]
        self.assertEqual(entry, [plan_block["id"]])
        self.assertIn("Approved the plan.", texts_of(second["utterances"]))
        self.assertNotIn("pending_plan_ids", second["cursor"])
        self.assertEqual(second["cursor"]["offset"], path.stat().st_size)

    def test_plan_rejection_in_the_next_delta_uses_pending_plan_ids(self):
        raw = fixture_lines(CLAUDE_TOOL_REJECTED)
        plan_block = json.loads(raw[24])["message"]["content"][0]
        synthetic = copy.deepcopy(json.loads(raw[31]))
        synthetic["message"]["content"][0]["tool_use_id"] = plan_block["id"]
        path = self.write("reject-split.jsonl", (json.dumps(json.loads(raw[24])) + "\n").encode())
        meta = {
            "agent": "claude",
            "sessionId": None,
            "transcriptPath": str(path),
            "tab": 4,
        }
        first = HARNESS.collect(meta, None, [str(self.base)])
        self.assertEqual(first["cursor"]["pending_plan_ids"], [plan_block["id"]])
        with path.open("ab") as stream:
            stream.write((json.dumps(synthetic) + "\n").encode("utf-8"))
        second = HARNESS.collect(meta, first["cursor_updates"], [str(self.base)])
        self.assertIn("Rejected the plan.", texts_of(second["utterances"]))
        self.assertNotIn("pending_plan_ids", second["cursor"])

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
        utterances = HARNESS.extract_claude([(1, json.dumps(synthetic))], None, 4)
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
        utterances = HARNESS.extract_claude([(1, json.dumps(line))], None, 4)
        self.assertEqual(utterances, [])

    def test_session_hint_used_when_line_has_no_session(self):
        line = {
            "type": "user",
            "message": {"role": "user", "content": "hello there"},
            "uuid": "uuid-1",
        }
        utterances = HARNESS.extract_claude([(3, json.dumps(line))], "hint-sess", 4)
        self.assertEqual(len(utterances), 1)
        self.assertEqual(utterances[0]["anchor"], {
            "agent": "claude",
            "session_id": "hint-sess",
            "tab": 4,
            "line_start": 3,
            "line_end": 3,
            "message_id": "uuid-1",
        })

    def test_meta_tag_text_and_interrupt_are_dropped(self):
        lines = [
            (1, json.dumps({
                "type": "user",
                "message": {"role": "user", "content": "<system-reminder>\nkeep out"},
                "uuid": "a",
            })),
            (2, json.dumps({
                "type": "user",
                "message": {"role": "user", "content": [
                    {"type": "text", "text": "[Request interrupted by user for tool use]"}]},
                "uuid": "b",
            })),
            (3, json.dumps({
                "type": "user",
                "message": {"role": "user", "content": "real prompt"},
                "uuid": "c",
            })),
        ]
        self.assertEqual(texts_of(HARNESS.extract_claude(lines, None, 4)), ["real prompt"])

    def test_plan_approved_fixture(self):
        raw = fixture_lines(CLAUDE_PLAN_APPROVED)
        lines, _ = read_fixture(CLAUDE_PLAN_APPROVED)
        utterances = HARNESS.extract_claude(lines, None, 4)
        texts = texts_of(utterances)

        plan_line = json.loads(raw[24])
        plan = plan_line["message"]["content"][0]["input"]["plan"]
        proposed = single(utterances, lambda u: u["text"].startswith("Proposed plan:"))
        self.assertEqual(proposed["text"], "Proposed plan: " + plan)
        self.assertEqual(proposed["speaker"], "assistant")
        self.assertEqual(proposed["anchor"]["line_start"], 25)
        self.assertEqual(proposed["anchor"]["message_id"], plan_line["uuid"])
        approved = single(utterances, lambda u: u["text"] == "Approved the plan.")
        self.assertEqual(approved["speaker"], "user")
        self.assertEqual(approved["anchor"]["line_start"], 27)
        self.assertEqual(approved["anchor"]["message_id"], json.loads(raw[26])["uuid"])
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
        utterances = HARNESS.extract_claude(lines, None, 4)
        texts = texts_of(utterances)

        approved = single(utterances, lambda u: u["text"] == "Approved the plan.")
        self.assertEqual(approved["anchor"]["line_start"], 27)
        self.assertEqual(approved["anchor"]["message_id"], json.loads(raw[26])["uuid"])
        self.assertNotIn("Rejected the plan.", texts)
        for text in texts:
            self.assertNotIn("doesn't want to proceed", text)
            self.assertNotIn("[Request interrupted", text)
        self.assertEqual(len(utterances), 4)

    def test_exit_plan_rejection_rule_from_edit_rejection_shape(self):
        raw = fixture_lines(CLAUDE_TOOL_REJECTED)
        plan_line = json.loads(raw[24])
        edit_result = json.loads(raw[31])
        plan_block = plan_line["message"]["content"][0]
        edit_block = edit_result["message"]["content"][0]
        self.assertEqual(plan_block["name"], "ExitPlanMode")
        self.assertIs(edit_block["is_error"], True)
        self.assertEqual(edit_result["toolUseResult"], "User rejected tool use")

        synthetic = copy.deepcopy(edit_result)
        synthetic["message"]["content"][0]["tool_use_id"] = plan_block["id"]
        lines = [(1, json.dumps(plan_line)), (2, json.dumps(synthetic))]
        utterances = HARNESS.extract_claude(lines, None, 4)
        self.assertEqual(texts_of(utterances), [
            "Proposed plan: " + plan_block["input"]["plan"],
            "Rejected the plan.",
        ])
        self.assertEqual(utterances[1]["speaker"], "user")
        self.assertEqual(utterances[1]["anchor"]["line_start"], 2)
        self.assertEqual(utterances[1]["anchor"]["message_id"], synthetic["uuid"])

    def test_answer_without_question_uses_answers_key(self):
        raw = fixture_lines(CLAUDE_SESSION)
        answer_line = json.loads(raw[20])
        utterances = HARNESS.extract_claude([(1, json.dumps(answer_line))], None, 4)
        self.assertEqual(texts_of(utterances), [
            "Answered: Which color should the fixture use? → Red"])
        self.assertEqual(utterances[0]["speaker"], "user")
        self.assertEqual(utterances[0]["anchor"]["line_start"], 1)
        self.assertEqual(utterances[0]["anchor"]["message_id"], answer_line["uuid"])

    def test_tool_use_result_string_is_dropped(self):
        raw = fixture_lines(CLAUDE_SESSION)
        answer_line = json.loads(raw[20])
        answer_line["toolUseResult"] = "Your questions have been answered."
        utterances = HARNESS.extract_claude([(1, json.dumps(answer_line))], None, 4)
        self.assertEqual(utterances, [])


class TestCodexExtraction(ExtractTestCase):
    def test_request_input_fixture(self):
        raw = fixture_lines(CODEX_REQUEST_INPUT)
        lines, _ = read_fixture(CODEX_REQUEST_INPUT)
        utterances = HARNESS.extract_codex(lines, None, 5)
        texts = texts_of(utterances)

        meta = json.loads(raw[0])["payload"]
        prompt_line = json.loads(raw[6])
        asked_line = json.loads(raw[10])
        answer_line = json.loads(raw[12])
        commentary_line = json.loads(raw[9])
        final_line = json.loads(raw[17])

        self.assertEqual(
            texts.count(prompt_line["payload"]["content"][0]["text"]), 1)
        self.assertIn(commentary_line["payload"]["content"][0]["text"], texts)
        self.assertIn(final_line["payload"]["content"][0]["text"], texts)

        asked = single(utterances, lambda u: u["text"].startswith("Asked:"))
        self.assertEqual(
            asked["text"], "Asked: Fixture는 어떤 색상을 사용해야 하나요? (options: Red / Blue)")
        self.assertEqual(asked["speaker"], "assistant")
        self.assertEqual(asked["anchor"], {
            "agent": "codex",
            "session_id": meta["id"],
            "tab": 5,
            "line_start": 11,
            "line_end": 11,
            "message_id": asked_line["payload"]["id"],
        })
        answered = single(utterances, lambda u: u["text"].startswith("Answered:"))
        self.assertEqual(
            answered["text"], "Answered: Fixture는 어떤 색상을 사용해야 하나요? → Red")
        self.assertEqual(answered["speaker"], "user")
        self.assertEqual(answered["anchor"]["line_start"], 13)
        self.assertEqual(answered["anchor"]["message_id"], answer_line["payload"]["id"])

        # 지침(가림) 줄과 exec 입출력은 발화가 아니다.
        for text in texts:
            self.assertNotIn("(redacted instructions)", text)
            self.assertNotIn("Script completed", text)
            self.assertNotIn("tools.exec_command", text)
        self.assertEqual([u["speaker"] for u in utterances],
                         ["user", "assistant", "assistant", "user", "assistant"])

    def test_answer_without_question_uses_question_id(self):
        raw = fixture_lines(CODEX_REQUEST_INPUT)
        output_line = json.loads(raw[12])
        utterances = HARNESS.extract_codex([(1, json.dumps(output_line))], "hint", 4)
        self.assertEqual(texts_of(utterances), ["Answered: fixture_color → Red"])
        self.assertEqual(utterances[0]["anchor"]["session_id"], "hint")
        self.assertEqual(utterances[0]["anchor"]["line_start"], 1)
        self.assertEqual(utterances[0]["anchor"]["message_id"], output_line["payload"]["id"])

    def test_answer_in_the_next_delta_uses_pending_questions(self):
        raw = fixture_lines(CODEX_REQUEST_INPUT)
        call_line = json.loads(raw[10])
        call_id = call_line["payload"]["call_id"]
        cut = ("\n".join(raw[:11]) + "\n").encode("utf-8")
        path = self.write("codex-split.jsonl", cut)
        meta = {
            "agent": "codex",
            "sessionId": None,
            "transcriptPath": str(path),
            "tab": 5,
        }
        first = HARNESS.collect(meta, None, [str(self.base)])
        self.assertEqual(first["cursor"]["pending_questions"], {
            call_id: {"fixture_color": "Fixture는 어떤 색상을 사용해야 하나요?"},
        })
        with path.open("ab") as stream:
            stream.write(("\n".join(raw[11:]) + "\n").encode("utf-8"))
        second = HARNESS.collect(meta, first["cursor_updates"], [str(self.base)])
        self.assertIn(
            "Answered: Fixture는 어떤 색상을 사용해야 하나요? → Red",
            texts_of(second["utterances"]))
        self.assertNotIn("pending_questions", second["cursor"])

    def test_answers_in_the_next_delta_use_each_question_text(self):
        raw = fixture_lines(CODEX_REQUEST_INPUT)
        call_line = json.loads(raw[10])
        call_line["payload"]["arguments"] = json.dumps({
            "questions": [
                {"header": "색상", "id": "fixture_color",
                 "question": "Fixture는 어떤 색상을 사용해야 하나요?"},
                {"header": "크기", "id": "fixture_size",
                 "question": "Fixture는 어떤 크기를 사용해야 하나요?"},
            ],
        }, ensure_ascii=False)
        output_line = json.loads(raw[12])
        output_line["payload"]["output"] = json.dumps({
            "answers": {
                "fixture_color": {"answers": ["Red"]},
                "fixture_size": {"answers": ["Large"]},
            },
        }, ensure_ascii=False)

        path = self.write(
            "two-questions.jsonl", (json.dumps(call_line) + "\n").encode("utf-8"))
        meta = {
            "agent": "codex",
            "sessionId": None,
            "transcriptPath": str(path),
            "tab": 5,
        }
        first = HARNESS.collect(meta, None, [str(self.base)])
        call_id = call_line["payload"]["call_id"]
        self.assertEqual(first["cursor"]["pending_questions"], {
            call_id: {
                "fixture_color": "Fixture는 어떤 색상을 사용해야 하나요?",
                "fixture_size": "Fixture는 어떤 크기를 사용해야 하나요?",
            },
        })

        with path.open("ab") as stream:
            stream.write((json.dumps(output_line) + "\n").encode("utf-8"))
        second = HARNESS.collect(meta, first["cursor_updates"], [str(self.base)])
        texts = texts_of(second["utterances"])
        self.assertIn("Answered: Fixture는 어떤 색상을 사용해야 하나요? → Red", texts)
        self.assertIn("Answered: Fixture는 어떤 크기를 사용해야 하나요? → Large", texts)
        self.assertNotIn("pending_questions", second["cursor"])

    def test_invalid_question_ids_are_not_stored_for_the_next_delta(self):
        raw = fixture_lines(CODEX_REQUEST_INPUT)
        call_line = json.loads(raw[10])
        call_line["payload"]["arguments"] = json.dumps({"questions": [
            {"header": "빈", "id": "", "question": "빈 id 질문"},
            {"header": "숫자", "id": 3, "question": "숫자 id 질문"},
        ]}, ensure_ascii=False)
        output_line = json.loads(raw[12])
        output_line["payload"]["output"] = json.dumps({
            "answers": {"": {"answers": ["A"]}, "3": {"answers": ["B"]}},
        }, ensure_ascii=False)

        cut = ("\n".join(raw[:10] + [json.dumps(call_line)]) + "\n").encode("utf-8")
        path = self.write("invalid-question-ids.jsonl", cut)
        meta = {
            "agent": "codex",
            "sessionId": None,
            "transcriptPath": str(path),
            "tab": 5,
        }
        first = HARNESS.collect(meta, None, [str(self.base)])
        self.assertNotIn(
            "pending_questions", first["cursor"],
            "빈 문자열·문자열이 아닌 id는 저장소 검증을 깨뜨리므로 남기지 않는다")
        result = HARNESS.finish_summary(
            self.base / "manager",
            {"rootPath": "/home/u/p/x", "distro": None, "agentStatus": "idle"},
            {"verdict": "no_change", "notify": "none", "notify_reason": None, "ops": []},
            None, first["utterances"], first["cursor_updates"], {}, [], False,
            types.SimpleNamespace(model="m", effort="low"), "2026-09-25T03:00:00Z",
        )
        self.assertIsNone(result["error"], "커서가 update_task 검증을 통과해야 한다")

        with path.open("ab") as stream:
            stream.write((json.dumps(output_line) + "\n").encode("utf-8"))
        second = HARNESS.collect(meta, first["cursor_updates"], [str(self.base)])
        texts = texts_of(second["utterances"])
        self.assertIn("Answered:  → A", texts)
        self.assertIn("Answered: 3 → B", texts)
        self.assertNotIn("pending_questions", second["cursor"])

    def test_answers_use_the_question_text_of_their_own_call(self):
        raw = fixture_lines(CODEX_REQUEST_INPUT)
        first_call = json.loads(raw[10])
        first_call["payload"]["call_id"] = "call-a"
        first_call["payload"]["arguments"] = json.dumps({"questions": [
            {"header": "확인", "id": "confirm", "question": "앞 호출 질문 문구"},
        ]}, ensure_ascii=False)
        second_call = json.loads(raw[10])
        second_call["payload"]["call_id"] = "call-b"
        second_call["payload"]["id"] = "fc-call-b"
        second_call["payload"]["arguments"] = json.dumps({"questions": [
            {"header": "확인", "id": "confirm", "question": "뒤 호출 질문 문구"},
        ]}, ensure_ascii=False)
        answer_first = json.loads(raw[12])
        answer_first["payload"]["call_id"] = "call-a"
        answer_first["payload"]["output"] = json.dumps(
            {"answers": {"confirm": {"answers": ["yes"]}}}, ensure_ascii=False)
        answer_second = json.loads(raw[12])
        answer_second["payload"]["call_id"] = "call-b"
        answer_second["payload"]["output"] = json.dumps(
            {"answers": {"confirm": {"answers": ["no"]}}}, ensure_ascii=False)

        cut = ("\n".join(raw[:10] + [json.dumps(first_call)]) + "\n").encode("utf-8")
        path = self.write("two-calls.jsonl", cut)
        meta = {
            "agent": "codex",
            "sessionId": None,
            "transcriptPath": str(path),
            "tab": 5,
        }
        first = HARNESS.collect(meta, None, [str(self.base)])
        self.assertEqual(first["cursor"]["pending_questions"], {
            "call-a": {"confirm": "앞 호출 질문 문구"},
        })

        tail = "\n".join([
            json.dumps(second_call), json.dumps(answer_first), json.dumps(answer_second),
        ]) + "\n"
        with path.open("ab") as stream:
            stream.write(tail.encode("utf-8"))
        second = HARNESS.collect(meta, first["cursor_updates"], [str(self.base)])
        texts = texts_of(second["utterances"])
        self.assertIn("Answered: 앞 호출 질문 문구 → yes", texts)
        self.assertIn("Answered: 뒤 호출 질문 문구 → no", texts)

    def test_user_input_with_several_kinds_keeps_only_the_text(self):
        line = {
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "msg-with-image",
                "role": "user",
                "content": [
                    {"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
                    {"type": "input_text", "text": "이미지와 함께 보낸 질문"},
                ],
                "internal_chat_message_metadata_passthrough": {
                    "content_item_kinds": ["user.image", "user.text"],
                },
            },
        }
        utterances = HARNESS.extract_codex([(1, json.dumps(line))], None, 5)
        self.assertEqual(texts_of(utterances), ["이미지와 함께 보낸 질문"])


class TestReadDelta(ExtractTestCase):
    def test_reads_complete_lines_and_defers_incomplete_tail(self):
        path = self.write("t.jsonl", b'{"a": 1}\n{"b": 2}\n{"c"')
        lines, new_offset, line, restarted, more, _skipped = HARNESS.read_delta(str(path), 0)
        self.assertFalse(restarted)
        self.assertFalse(more)
        self.assertEqual(lines, [(1, '{"a": 1}'), (2, '{"b": 2}')])
        self.assertEqual(line, 2)
        self.assertEqual(new_offset, len(b'{"a": 1}\n{"b": 2}\n'))

        with path.open("ab") as stream:
            stream.write(b': 3}\n{"d": 4}\n')
        lines, new_offset, line, restarted, more, _skipped = HARNESS.read_delta(
            str(path), new_offset, line=line)
        self.assertFalse(restarted)
        self.assertFalse(more)
        self.assertEqual(lines, [(3, '{"c": 3}'), (4, '{"d": 4}')])
        self.assertEqual(line, 4)
        self.assertEqual(new_offset, path.stat().st_size)

    def test_small_file_first_read_starts_at_zero(self):
        path = self.write("t.jsonl", b"one\ntwo\n")
        lines, new_offset, line, restarted, more, _skipped = HARNESS.read_delta(str(path))
        self.assertFalse(restarted)
        self.assertFalse(more)
        self.assertEqual(lines, [(1, "one"), (2, "two")])
        self.assertEqual(line, 2)
        self.assertEqual(new_offset, path.stat().st_size)

    def test_size_below_offset_restarts_from_tail(self):
        path = self.write("t.jsonl", b"one\ntwo\n")
        _, offset, line, _, _, _ = HARNESS.read_delta(str(path), 0)
        lines, new_offset, new_line, restarted, more, _skipped = HARNESS.read_delta(
            str(path), offset + 4096, line=line)
        self.assertTrue(restarted)
        self.assertFalse(more)
        self.assertEqual(lines, [(1, "one"), (2, "two")])
        self.assertEqual(new_line, 2)
        self.assertEqual(new_offset, path.stat().st_size)

    def test_first_read_of_large_file_uses_aligned_tail(self):
        rows = [
            json.dumps({"i": index, "pad": "x" * 60}, separators=(",", ":"))
            for index in range(2000)
        ]
        data = ("\n".join(rows) + "\n").encode("utf-8")
        self.assertGreater(len(data), 64 * 1024)
        path = self.write("big.jsonl", data)

        lines, new_offset, line, restarted, more, _skipped = HARNESS.read_delta(str(path))
        self.assertFalse(restarted)
        self.assertFalse(more)
        tail_start = len(data) - 64 * 1024
        begin = data.find(b"\n", tail_start) + 1
        self.assertGreater(begin, tail_start)
        self.assertEqual(lines[0][0], data[:begin].count(b"\n") + 1)
        self.assertEqual(lines[0][1], rows[lines[0][0] - 1])
        self.assertEqual(lines[-1][0], len(rows))
        self.assertEqual(line, len(rows))
        self.assertLess(len(lines), len(rows))
        self.assertEqual(new_offset, len(data))

    def test_line_from_the_cursor_matches_a_full_read(self):
        data = fixture_bytes(CLAUDE_SESSION)
        cut = len(data) // 2
        path = self.write("split.jsonl", data[:cut])
        first, first_offset, first_line, _, _, _ = HARNESS.read_delta(str(path), 0)
        with path.open("ab") as stream:
            stream.write(data[cut:])
        second, second_offset, second_line, restarted, _, _ = HARNESS.read_delta(
            str(path), first_offset, line=first_line)
        whole, whole_offset, whole_line, _, _, _ = HARNESS.read_delta(str(path), 0)
        self.assertFalse(restarted)
        self.assertEqual(first + second, whole)
        self.assertEqual(second_line, whole_line)
        self.assertEqual(second_offset, whole_offset)

    def test_provided_line_skips_counting_from_the_start(self):
        rows = ["line %d" % index for index in range(1, 501)]
        path = self.write("counted.jsonl", ("\n".join(rows) + "\n").encode("utf-8"))
        with mock.patch.object(
                HARNESS, "_count_newlines",
                side_effect=AssertionError("커서 line이 있으면 처음부터 세지 않는다")):
            lines, offset, line, restarted, more, _skipped = HARNESS.read_delta(
                str(path), 0, line=0, max_bytes=4096)
        self.assertTrue(lines)
        self.assertTrue(more)
        self.assertFalse(restarted)
        self.assertEqual(lines[0][0], 1)
        self.assertEqual(line, len(lines))

    def test_offset_at_eof_reads_nothing(self):
        path = self.write("t.jsonl", b"one\ntwo\n")
        size = path.stat().st_size
        lines, new_offset, line, restarted, more, _skipped = HARNESS.read_delta(str(path), size, line=2)
        self.assertEqual(lines, [])
        self.assertEqual(new_offset, size)
        self.assertEqual(line, 2)
        self.assertFalse(restarted)
        self.assertFalse(more)

    def test_first_read_without_newline_after_tail_returns_previous_boundary(self):
        prefix = b"one\ntwo\n"
        long_line = b"x" * (64 * 1024 + 10)
        path = self.write("t.jsonl", prefix + long_line)
        lines, new_offset, line, restarted, more, _skipped = HARNESS.read_delta(str(path))
        self.assertEqual(lines, [])
        self.assertEqual(new_offset, len(prefix))
        self.assertEqual(line, 2)
        self.assertFalse(restarted)
        self.assertFalse(more)

        with path.open("ab") as stream:
            stream.write(b"\nthree\n")
        lines, new_offset, line, restarted, more, _skipped = HARNESS.read_delta(
            str(path), new_offset, line=line)
        self.assertEqual(lines, [(3, long_line.decode("utf-8")), (4, "three")])
        self.assertEqual(line, 4)
        self.assertEqual(new_offset, path.stat().st_size)

    def test_split_fixture_continues_without_duplicates(self):
        data = fixture_bytes(CLAUDE_SESSION)
        cut = len(data) // 2
        path = self.write("split.jsonl", data[:cut])

        first, first_offset, _line, restarted, _, _ = HARNESS.read_delta(str(path))
        self.assertFalse(restarted)
        with path.open("ab") as stream:
            stream.write(data[cut:])
        second, second_offset, _line, restarted, _, _ = HARNESS.read_delta(str(path), first_offset)
        self.assertFalse(restarted)
        self.assertEqual(second_offset, len(data))

        first_utterances = HARNESS.extract_claude(first, None, 4)
        second_utterances = HARNESS.extract_claude(second, None, 4)
        raw = fixture_lines(CLAUDE_SESSION)
        prompt = json.loads(raw[5])["message"]["content"]
        final = json.loads(raw[37])["message"]["content"][0]["text"]
        texts = texts_of(first_utterances + second_utterances)
        self.assertEqual(texts.count(prompt), 1)
        self.assertEqual(texts.count(final), 1)
        self.assertEqual(len(texts), len(set(texts)))
        first_max = max(u["anchor"]["line_end"] for u in first_utterances)
        second_min = min(u["anchor"]["line_start"] for u in second_utterances)
        self.assertLess(first_max, second_min)

    def test_byte_cap_splits_the_delta_without_gaps_or_duplicates(self):
        rows = [
            json.dumps({"i": index, "pad": "x" * 80}, separators=(",", ":"))
            for index in range(400)
        ]
        data = ("\n".join(rows) + "\n").encode("utf-8")
        path = self.write("capped.jsonl", data)
        cap = 4096

        whole, whole_offset, whole_line, _, whole_more, _ = HARNESS.read_delta(
            str(path), 0, max_bytes=len(data) + 1)
        self.assertFalse(whole_more)
        self.assertEqual(len(whole), len(rows))

        rounds = []
        offset, line = 0, 0
        while True:
            lines, offset, line, restarted, more, _skipped = HARNESS.read_delta(
                str(path), offset, line=line, max_bytes=cap)
            self.assertFalse(restarted)
            rounds.append(lines)
            if not more:
                break
            self.assertGreater(offset, 0, "상한 회차는 커서를 전진시켜야 한다")
        merged = [item for lines in rounds for item in lines]
        self.assertEqual(merged, whole)
        self.assertGreater(len(rounds), 1, "상한보다 큰 파일은 두 회차 이상이어야 한다")
        self.assertEqual(line, whole_line)
        self.assertEqual(offset, whole_offset)

    def test_oversized_line_is_skipped_and_the_next_line_is_read(self):
        long_line = b"x" * 5000
        data = long_line + b"\n" + b'{"a": 1}\n'
        path = self.write("huge.jsonl", data)

        lines, offset, line, restarted, more, skipped = HARNESS.read_delta(
            str(path), 0, max_bytes=1024)
        self.assertFalse(restarted)
        self.assertEqual(lines, [])
        self.assertEqual(skipped, len(long_line) + 1)
        self.assertEqual(offset, len(long_line) + 1)
        self.assertEqual(line, 1)
        self.assertTrue(more, "건너뛴 뒤 남은 바이트가 있으면 이어 읽는다")

        lines, offset, line, restarted, more, skipped = HARNESS.read_delta(
            str(path), offset, line=line, max_bytes=1024)
        self.assertFalse(restarted)
        self.assertEqual(lines, [(2, '{"a": 1}')])
        self.assertEqual(line, 2)
        self.assertEqual(offset, len(data))
        self.assertEqual(skipped, 0)
        self.assertFalse(more)

    def test_incomplete_oversized_line_is_still_deferred(self):
        data = b"x" * 5000
        path = self.write("huge-incomplete.jsonl", data)
        lines, offset, line, restarted, more, skipped = HARNESS.read_delta(
            str(path), 0, max_bytes=1024)
        self.assertEqual(lines, [])
        self.assertEqual(skipped, 0, "개행이 없으면 아직 보류한다")
        self.assertEqual(offset, 0)
        self.assertEqual(line, 0)
        self.assertFalse(more)

        with path.open("ab") as stream:
            stream.write(b"\nnext\n")
        lines, offset, line, restarted, more, skipped = HARNESS.read_delta(
            str(path), offset, line=line, max_bytes=1024)
        self.assertEqual(lines, [])
        self.assertEqual(skipped, len(data) + 1)
        self.assertEqual(line, 1)
        self.assertTrue(more)

        lines, offset, line, restarted, more, skipped = HARNESS.read_delta(
            str(path), offset, line=line, max_bytes=1024)
        self.assertEqual(lines, [(2, "next")])
        self.assertEqual(offset, path.stat().st_size)


class TestTranscriptAllowed(ExtractTestCase):
    def setUp(self):
        super().setUp()
        self.root = self.base / "projects"
        self.root.mkdir()

    def test_allowed_file_inside_root(self):
        path = self.root / "a.jsonl"
        path.write_text("{}\n", encoding="utf-8")
        ok, reason = HARNESS.transcript_allowed(str(path), [str(self.root)])
        self.assertTrue(ok)
        self.assertIsNone(reason)

    def test_outside_root_rejected(self):
        outside = self.base / "elsewhere"
        outside.mkdir()
        path = outside / "a.jsonl"
        path.write_text("{}\n", encoding="utf-8")
        ok, reason = HARNESS.transcript_allowed(str(path), [str(self.root)])
        self.assertFalse(ok)
        self.assertIn("outside", reason)

    def test_non_jsonl_rejected(self):
        path = self.root / "a.txt"
        path.write_text("{}\n", encoding="utf-8")
        ok, reason = HARNESS.transcript_allowed(str(path), [str(self.root)])
        self.assertFalse(ok)
        self.assertIn(".jsonl", reason)

    def test_directory_rejected(self):
        path = self.root / "a.jsonl"
        path.mkdir()
        ok, reason = HARNESS.transcript_allowed(str(path), [str(self.root)])
        self.assertFalse(ok)
        self.assertIn("regular file", reason)

    def test_symlink_to_outside_rejected(self):
        outside = self.base / "elsewhere"
        outside.mkdir()
        target = outside / "a.jsonl"
        target.write_text("{}\n", encoding="utf-8")
        link = self.root / "link.jsonl"
        link.symlink_to(target)
        ok, reason = HARNESS.transcript_allowed(str(link), [str(self.root)])
        self.assertFalse(ok)
        self.assertIn("outside", reason)

    def test_missing_file_rejected(self):
        ok, reason = HARNESS.transcript_allowed(
            str(self.root / "missing.jsonl"), [str(self.root)])
        self.assertFalse(ok)
        self.assertIn("cannot stat", reason)

    def test_default_roots_follow_home_and_codex_home(self):
        home = self.base / "home"
        codex = self.base / "codex-home"
        claude_file = home / ".claude" / "projects" / "c.jsonl"
        codex_file = codex / "sessions" / "x.jsonl"
        for path in (claude_file, codex_file):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}\n", encoding="utf-8")
        with mock.patch.dict(os.environ, {"HOME": str(home), "CODEX_HOME": str(codex)}):
            ok, reason = HARNESS.transcript_allowed(str(claude_file))
            self.assertTrue(ok, reason)
            ok, reason = HARNESS.transcript_allowed(str(codex_file))
            self.assertTrue(ok, reason)

    def test_codex_home_argument_overrides_environment(self):
        codex = self.base / "codex-home-arg"
        codex_file = codex / "sessions" / "x.jsonl"
        codex_file.parent.mkdir(parents=True, exist_ok=True)
        codex_file.write_text("{}\n", encoding="utf-8")
        other = self.base / "other-codex"
        (other / "sessions").mkdir(parents=True, exist_ok=True)
        with mock.patch.dict(os.environ, {"CODEX_HOME": str(other)}):
            ok, reason = HARNESS.transcript_allowed(str(codex_file), None, str(codex))
            self.assertTrue(ok, reason)


class TestCollect(ExtractTestCase):
    def setUp(self):
        super().setUp()
        self.root = self.base / "projects"
        self.root.mkdir()
        self.session_id = json.loads(fixture_lines(CLAUDE_SESSION)[5])["sessionId"]

    def session_meta(self, path, tab=8, agent="claude"):
        return {
            "agent": agent,
            "sessionId": self.session_id,
            "transcriptPath": str(path),
            "tab": tab,
        }

    def claude_file(self):
        path = self.root / "session.jsonl"
        path.write_bytes(fixture_bytes(CLAUDE_SESSION))
        return path

    def test_collect_reads_delta_and_builds_cursor(self):
        path = self.claude_file()
        size = path.stat().st_size
        result = HARNESS.collect(self.session_meta(path), None, [str(self.root)])
        self.assertIsNone(result["rejected_reason"])
        self.assertFalse(result["restarted"])
        self.assertFalse(result["more"])
        self.assertEqual(result["new_offset"], size)
        self.assertTrue(result["utterances"])
        cursor = result["cursor"]
        self.assertEqual(cursor["agent"], "claude")
        self.assertEqual(cursor["transcript_path"], str(path))
        self.assertEqual(cursor["offset"], size)
        self.assertEqual(cursor["line"], fixture_bytes(CLAUDE_SESSION).count(b"\n"))
        self.assertEqual(cursor["tab"], 8)
        self.assertIsNotNone(cursor["updated"])
        self.assertEqual(result["cursor_updates"], {self.session_id: cursor})

        again = HARNESS.collect(self.session_meta(path), result["cursor"], [str(self.root)])
        self.assertEqual(again["utterances"], [])
        self.assertEqual(again["new_offset"], size)
        self.assertFalse(again["restarted"])

    def test_collect_continues_a_capped_delta_without_duplicates(self):
        rows = []
        for index in range(1, 121):
            line = {
                "type": "user",
                "sessionId": "sess-capped",
                "message": {"role": "user", "content": "prompt %d" % index},
                "uuid": "uuid-%d" % index,
            }
            rows.append(json.dumps(line, ensure_ascii=False))
        path = self.write("projects/many.jsonl", ("\n".join(rows) + "\n").encode("utf-8"))
        meta = self.session_meta(path, tab=9)
        meta["sessionId"] = "sess-capped"

        first = HARNESS.collect(meta, None, [str(self.root)], max_bytes=2048)
        self.assertTrue(first["more"])
        cursor = first["cursor_updates"]
        utterances = list(first["utterances"])

        rounds = 0
        while True:
            result = HARNESS.collect(meta, cursor, [str(self.root)], max_bytes=2048)
            utterances.extend(result["utterances"])
            cursor = result["cursor_updates"]
            rounds += 1
            if not result["more"]:
                break
            self.assertLess(rounds, 20, "상한 읽기가 끝나지 않는다")

        texts = texts_of(utterances)
        self.assertEqual(texts, ["prompt %d" % index for index in range(1, 121)])
        starts = [u["anchor"]["line_start"] for u in utterances]
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(len(starts), len(set(starts)))

    def test_collect_accepts_the_whole_cursor_mapping(self):
        path = self.claude_file()
        first = HARNESS.collect(self.session_meta(path), None, [str(self.root)])
        again = HARNESS.collect(
            self.session_meta(path), first["cursor_updates"], [str(self.root)])
        self.assertEqual(again["utterances"], [])
        self.assertFalse(again["restarted"])

    def test_updated_moves_only_when_new_bytes_are_read(self):
        quiet = {}
        for index in range(1, 33):
            session_id = "q%02d" % index
            path = self.root / (session_id + ".jsonl")
            path.write_text(
                json.dumps({
                    "type": "user",
                    "sessionId": session_id,
                    "message": {"role": "user", "content": "prompt " + session_id},
                    "uuid": "u-" + session_id,
                }) + "\n",
                encoding="utf-8",
            )
            meta = {
                "agent": "claude", "sessionId": session_id,
                "transcriptPath": str(path), "tab": 4,
            }
            quiet[session_id] = meta

        active_path = self.root / "active.jsonl"
        first_prompt = {
            "type": "user", "sessionId": "sess-active",
            "message": {"role": "user", "content": "first prompt"},
            "uuid": "u-active-1",
        }
        active_path.write_text(json.dumps(first_prompt) + "\n", encoding="utf-8")
        active_meta = {
            "agent": "claude", "sessionId": "sess-active",
            "transcriptPath": str(active_path), "tab": 5,
        }

        cursor = {}
        for meta in list(quiet.values()) + [active_meta]:
            cursor.update(HARNESS.collect(
                meta, None, [str(self.root)], now="2026-09-25T00:00:00Z")["cursor_updates"])

        with active_path.open("ab") as stream:
            stream.write((json.dumps({
                "type": "user", "sessionId": "sess-active",
                "message": {"role": "user", "content": "second prompt"},
                "uuid": "u-active-2",
            }) + "\n").encode("utf-8"))

        updates = HARNESS.collect(
            active_meta, cursor, [str(self.root)], now="2026-09-25T01:00:00Z")["cursor_updates"]
        self.assertEqual(updates["sess-active"]["updated"], "2026-09-25T01:00:00Z")
        for meta in quiet.values():
            updates.update(HARNESS.collect(
                meta, cursor, [str(self.root)], now="2026-09-25T01:00:00Z")["cursor_updates"])
        self.assertEqual(updates["q01"]["updated"], "2026-09-25T00:00:00Z",
                         "새 바이트가 없으면 updated를 갱신하지 않는다")

        doc = HARNESS.MANAGER.new_task("/w/quiet", None, "2026-09-25T00:00:00Z")
        doc["meta"]["cursor"] = updates
        removed = HARNESS.MANAGER.prune_cursor(doc, "2026-09-25T01:00:00Z")
        self.assertNotIn("sess-active", removed,
                         "계속 읽는 세션은 조용한 세션보다 먼저 지워지면 안 된다")
        self.assertEqual(removed, ["q01"], "가장 오래 조용한 세션부터 지운다")
        self.assertEqual(len(doc["meta"]["cursor"]), HARNESS.MANAGER.MAX_CURSOR_SESSIONS)

    def test_collect_rejects_path_outside_roots(self):
        outside = self.base / "elsewhere"
        outside.mkdir()
        path = outside / "x.jsonl"
        path.write_bytes(b"")
        result = HARNESS.collect(self.session_meta(path, tab=3), None, [str(self.root)])
        self.assertIn("outside", result["rejected_reason"])
        self.assertEqual(result["utterances"], [])
        self.assertIsNone(result["new_offset"])
        self.assertIsNone(result["cursor"])
        self.assertEqual(result["cursor_updates"], {})

    def test_collect_restarts_when_offset_exceeds_size(self):
        path = self.claude_file()
        size = path.stat().st_size
        cursor = {
            "agent": "claude",
            "transcript_path": str(path),
            "offset": size + 4096,
            "tab": None,
        }
        result = HARNESS.collect(self.session_meta(path), cursor, [str(self.root)])
        self.assertTrue(result["restarted"])
        self.assertTrue(result["utterances"])
        self.assertEqual(result["new_offset"], size)

    def test_collect_uses_session_id_from_lines_when_hint_missing(self):
        path = self.claude_file()
        meta = self.session_meta(path)
        meta["sessionId"] = None
        result = HARNESS.collect(meta, None, [str(self.root)])
        self.assertEqual(list(result["cursor_updates"]), [self.session_id])
        for utterance in result["utterances"]:
            self.assertEqual(utterance["anchor"]["session_id"], self.session_id)

    def test_collect_rejects_unknown_agent(self):
        path = self.claude_file()
        result = HARNESS.collect(
            self.session_meta(path, agent="opencode"), None, [str(self.root)])
        self.assertIsNotNone(result["rejected_reason"])
        self.assertEqual(result["utterances"], [])


if __name__ == "__main__":
    unittest.main()
