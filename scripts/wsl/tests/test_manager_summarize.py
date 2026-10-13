#!/usr/bin/env python3
"""mast-manager-harness.py의 요약 호출·출력 검증·적용·알림 테스트 (macOS·Linux 공용).

`apps/mast/tests/manager-python.test.ts`의 CI 래퍼가 이 스위트를 돌린다.
실제 codex는 부르지 않는다. 테스트가 임시 디렉터리에 가짜 codex 실행 파일을 만들어
argv·환경·stdin을 기록하고 준비한 out.json을 `-o` 경로로 복사한다.
"""

import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
HARNESS_PATH = ROOT / "scripts" / "wsl" / "mast-manager-harness.py"
STORE_PATH = ROOT / "scripts" / "wsl" / "mast-manager.py"
FIXTURE_PATH = ROOT / "fixtures" / "manager-task.json"
NOW = "2026-09-25T03:00:00Z"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HARNESS = load_module("mast_manager_harness_test", HARNESS_PATH)
STORE = load_module("mast_manager_store_for_harness_test", STORE_PATH)
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
ROOT_WORKSPACE = FIXTURE["valid"][0]["meta"]["workspace_key"]

# 테스트 전용 codex 대역. 레포에 fixture 실행 파일로 두지 않고 테스트가 만든다.
FAKE_CODEX = '''#!/usr/bin/env python3
import json
import os
import shutil
import sys
import time


def main():
    argv = sys.argv[1:]
    record = {
        "argv": argv,
        "cwd": os.getcwd(),
        "env": {
            name: os.environ.get(name)
            for name in ("MAST", "MAST_TAB", "MAST_TTY", "CODEX_THREAD_ID")
        },
        "path": os.environ.get("PATH"),
        "stdin": sys.stdin.read(),
    }
    targets = {}
    for index, value in enumerate(argv):
        if value in ("-o", "--output-schema") and index + 1 < len(argv):
            targets[value] = argv[index + 1]
    schema = targets.get("--output-schema")
    if schema and os.path.isfile(schema):
        with open(schema, "r", encoding="utf-8") as stream:
            record["schema"] = json.load(stream)
    base = os.environ.get("FAKE_CODEX_DIR")
    if base:
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, "record.json"), "w", encoding="utf-8") as stream:
            json.dump(record, stream)
    sleep = float(os.environ.get("FAKE_CODEX_SLEEP") or "0")
    if sleep > 0:
        time.sleep(sleep)
    source = os.environ.get("FAKE_CODEX_OUT")
    out = targets.get("-o")
    if source and out:
        shutil.copyfile(source, out)
    sys.exit(int(os.environ.get("FAKE_CODEX_EXIT") or "0"))


main()
'''


def summary_output(progress="요약을 적용했다", needs_input="", next_step="", reason=None):
    return {
        "summary": {"progress": progress, "needs_input": needs_input, "next": next_step},
        "notify_reason": reason,
    }


def cursor_update(offset, session_id="sess-8f2c"):
    return {
        session_id: {
            "agent": "claude",
            "transcript_path": "/home/u/.claude/projects/mast/%s.jsonl" % session_id,
            "offset": offset,
            "tab": 4,
        }
    }


class HarnessTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.manager = self.base / "manager"
        self.bin_dir = self.base / "bin"
        self.bin_dir.mkdir()
        fake = self.bin_dir / "codex"
        fake.write_text(FAKE_CODEX, encoding="utf-8")
        fake.chmod(0o755)
        self.record_dir = self.base / "record"
        self.out_dir = self.base / "out"
        self.out_dir.mkdir()
        self.settings = types.SimpleNamespace(
            model="gpt-6-luna",
            effort="high",
            summaryModel="gpt-6-luna",
            summaryEffort="low",
        )
        self.workspace = {
            "rootPath": ROOT_WORKSPACE["root_path"],
            "distro": ROOT_WORKSPACE["distro"],
            "agentStatus": "idle",
        }

    def fake_env(self, **extra):
        env = {key: value for key, value in os.environ.items() if not key.startswith("FAKE_CODEX_")}
        env.update({
            "MAST": "1",
            "MAST_TAB": "9",
            "MAST_TTY": "/dev/ttys009",
            "CODEX_THREAD_ID": "thread-1",
            "FAKE_CODEX_DIR": str(self.record_dir),
            "PATH": str(self.bin_dir) + os.pathsep + os.environ.get("PATH", ""),
        })
        env.update(extra)
        return env

    def start_job(self, prompt="summary prompt", **extra):
        base = self.fake_env(**extra)
        env = HARNESS.summary_env(base, base["PATH"])
        return HARNESS.start_summary(prompt, self.settings, env)

    def wait_for_record(self, timeout=5.0):
        deadline = time.monotonic() + timeout
        path = self.record_dir / "record.json"
        while time.monotonic() < deadline:
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                time.sleep(0.02)
        self.fail("the fake codex did not write its record")

    def prepare_out(self, payload, name="out.json"):
        path = self.out_dir / name
        text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        path.write_text(text, encoding="utf-8")
        return path

    def summary_path(self):
        return Path(self.manager) / "summaries" / (
            STORE.task_key(self.workspace["rootPath"], self.workspace["distro"]) + ".json"
        )

    def seed_summary(self, doc=None):
        if doc is None:
            doc = STORE.new_summary(
                self.workspace["rootPath"], self.workspace["distro"], NOW)
        path = self.summary_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        return doc

    def load_summary(self):
        return json.loads(self.summary_path().read_text(encoding="utf-8"))


class SummarySchemaTest(unittest.TestCase):
    def test_schema_is_strict(self):
        schema = HARNESS.SUMMARY_SCHEMA
        self.assertEqual(schema["type"], "object")
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(sorted(schema["required"]), sorted(schema["properties"]))
        summary = schema["properties"]["summary"]
        self.assertFalse(summary["additionalProperties"])
        self.assertEqual(sorted(summary["required"]), sorted(summary["properties"]))
        self.assertEqual(summary["required"], list(STORE.SUMMARY_KEYS))

    def test_output_validation_accepts_the_contract(self):
        self.assertIsNone(HARNESS._summary_output_error(summary_output()))

    def test_output_validation_rejects_structure(self):
        cases = [
            ([], "JSON object"),
            ({"summary": {"progress": "x", "needs_input": "", "next": ""}}, "missing notify_reason"),
            ({"summary": {"progress": "x", "needs_input": "", "next": ""},
              "notify_reason": "maybe"}, "notify_reason"),
            ({"summary": {"progress": 7, "needs_input": "", "next": ""},
              "notify_reason": None}, "summary.progress"),
            ({"summary": {"progress": "x", "needs_input": "", "next": ""},
              "notify_reason": None, "extra": 1}, "unknown keys"),
            ({"summary": {"progress": "x", "needs_input": "", "next": "", "old": ""},
              "notify_reason": None}, "unknown keys"),
            ({"summary": {"progress": "   ", "needs_input": "", "next": ""},
              "notify_reason": None}, "must not be blank"),
            ({"summary": "x", "notify_reason": None}, "summary must be an object"),
        ]
        for output, snippet in cases:
            reason = HARNESS._summary_output_error(output)
            self.assertIsNotNone(reason, snippet)
            self.assertIn(snippet, reason)

    def test_normalize_truncates_by_code_points(self):
        long_progress = "가" * 450
        long_needs = "나" * 650
        long_next = "다" * 650
        normalized = HARNESS.normalize_summary(summary_output(long_progress, long_needs, long_next))
        self.assertEqual(len(normalized["summary"]["progress"]), 400)
        self.assertEqual(len(normalized["summary"]["needs_input"]), 600)
        self.assertEqual(len(normalized["summary"]["next"]), 600)
        self.assertTrue(normalized["summary"]["progress"].startswith("가"))

    def test_question_with_empty_needs_input_downgrades_the_notify_only(self):
        normalized = HARNESS.normalize_summary(
            summary_output(needs_input="  ", reason="question"))
        self.assertIsNone(normalized["notify_reason"])
        self.assertEqual(normalized["summary"]["progress"], "요약을 적용했다")

    def test_question_with_content_keeps_the_reason(self):
        normalized = HARNESS.normalize_summary(
            summary_output(needs_input="답이 필요하다", reason="question"))
        self.assertEqual(normalized["notify_reason"], "question")


class StartSummaryTest(HarnessTestCase):
    def test_arguments_environment_schema_and_stdin_match_contract(self):
        job = self.start_job(prompt="hello prompt")
        self.addCleanup(HARNESS.kill_summary, job)
        record = self.wait_for_record()
        self.assertEqual(record["stdin"], "hello prompt")
        self.assertEqual(record["schema"], HARNESS.SUMMARY_SCHEMA)
        argv = record["argv"]
        self.assertEqual(argv[:2], ["exec", "--ephemeral"])
        self.assertIn("read-only", argv)
        self.assertIn("--skip-git-repo-check", argv)
        self.assertIn("-m", argv)
        self.assertEqual(argv[argv.index("-m") + 1], "gpt-6-luna")
        self.assertIn('model_reasoning_effort="low"', argv)
        for name in ("MAST", "MAST_TAB", "MAST_TTY", "CODEX_THREAD_ID"):
            self.assertIsNone(record["env"][name], name)

    def test_settings_fall_back_to_the_manager_model(self):
        self.settings.summaryModel = None
        self.settings.summaryEffort = None
        job = self.start_job()
        self.addCleanup(HARNESS.kill_summary, job)
        record = self.wait_for_record()
        argv = record["argv"]
        self.assertEqual(argv[argv.index("-m") + 1], "gpt-6-luna")
        self.assertIn('model_reasoning_effort="high"', argv)

    def test_large_prompt_is_handed_over_as_a_file_without_blocking(self):
        # 실제 입력 상한(24,000자) 안의 한글 프롬프트는 64 KiB 파이프 버퍼를 넘는다.
        # 파이프가 아니라 파일 stdin이어야 메인 루프가 자식의 읽기를 기다리며 막히지 않는다.
        prompt = "가" * 23000
        job = self.start_job(prompt)
        self.addCleanup(HARNESS.kill_summary, job)
        self.assertIsNone(job.proc.stdin, "파이프가 아니라 파일 stdin이어야 한다")
        record = self.wait_for_record(timeout=10.0)
        self.assertEqual(len(record["stdin"]), len(prompt), "프롬프트 전문이 자식에게 간다")
        self.assertTrue(record["stdin"].startswith("가"))


class CollectSummaryTest(HarnessTestCase):
    def finished_job(self, payload=None, exit_code=0, name="out.json", write=True):
        tmpdir = Path(tempfile.mkdtemp(dir=str(self.base)))
        out_path = tmpdir / name
        if write:
            text = payload if isinstance(payload, str) else json.dumps(
                payload if payload is not None else summary_output(), ensure_ascii=False)
            out_path.write_text(text, encoding="utf-8")

        class Proc:
            def wait(self):
                return exit_code

        job = types.SimpleNamespace(
            proc=Proc(), out_path=out_path, tmpdir=str(tmpdir),
            stderr_path=str(tmpdir / "stderr.log"))
        return job

    def test_valid_output_is_normalized(self):
        output, error = HARNESS.collect_summary(self.finished_job(
            summary_output(needs_input="질문", reason="question")))
        self.assertIsNone(error)
        self.assertEqual(output["notify_reason"], "question")
        self.assertEqual(output["summary"]["needs_input"], "질문")

    def test_exit_code_and_missing_out_are_errors(self):
        output, error = HARNESS.collect_summary(self.finished_job(exit_code=3))
        self.assertIsNone(output)
        self.assertIn("exited with code 3", error)
        output, error = HARNESS.collect_summary(self.finished_job(name="other.json", write=False))
        self.assertIsNone(output)
        self.assertIn("no out.json", error)

    def test_invalid_json_and_schema_are_errors(self):
        output, error = HARNESS.collect_summary(self.finished_job("{ not json"))
        self.assertIsNone(output)
        self.assertIn("not valid JSON", error)
        output, error = HARNESS.collect_summary(self.finished_job(
            {"summary": {"progress": "", "needs_input": "", "next": ""}, "notify_reason": None}))
        self.assertIsNone(output)
        self.assertIn("does not match the schema", error)

    def test_oversized_output_is_rejected_without_reading_it_all(self):
        payload = summary_output(progress="x" * (HARNESS.SUMMARY_OUTPUT_MAX_BYTES + 10))
        output, error = HARNESS.collect_summary(self.finished_job(payload))
        self.assertIsNone(output)
        self.assertIn("exceeds 64 KiB", error)

    def test_truncation_happens_on_collect(self):
        output, error = HARNESS.collect_summary(self.finished_job(
            summary_output(progress="가" * 401)))
        self.assertIsNone(error)
        self.assertEqual(len(output["summary"]["progress"]), 400)
        output, error = HARNESS.collect_summary(self.finished_job(
            summary_output(progress=" " * 400 + "x")))
        self.assertIsNone(error)
        self.assertEqual(output["summary"]["progress"], "x",
                         "공백을 뗀 뒤 잘라 의미 있는 글자를 남긴다")


class BuildPromptTest(unittest.TestCase):
    def test_prompt_contract(self):
        doc = STORE.new_summary("/x", None, NOW)
        doc["summary"] = {"progress": "이전 진행", "needs_input": "이전 질문", "next": "이전 다음"}
        utterances = {
            "u1": {"speaker": "user", "text": "새 발화입니다"},
            "u2": {"speaker": "assistant", "text": "답변입니다"},
        }
        prompt, truncated = HARNESS.build_prompt(doc, utterances)
        self.assertFalse(truncated)
        for text in ("이전 진행", "이전 질문", "이전 다음"):
            self.assertIn(text, prompt, "이전 요약을 입력에 넣는다")
        self.assertIn("[user] 새 발화입니다", prompt)
        self.assertIn("[assistant] 답변입니다", prompt)
        self.assertIn(HARNESS.QUARANTINE, prompt, "발화는 데이터 격리 문구와 함께 들어간다")
        for field, limit in STORE.SUMMARY_LIMITS.items():
            self.assertIn(
                str(limit), prompt, "저장 상한 숫자를 프롬프트에 전달한다: " + field)

    def test_prompt_caps_utterances(self):
        doc = STORE.new_summary("/x", None, NOW)
        long_text = "x" * (HARNESS.MAX_UTTERANCE_TEXT + 100)
        utterances = {"u1": {"speaker": "user", "text": long_text}}
        prompt, truncated = HARNESS.build_prompt(doc, utterances)
        self.assertTrue(truncated)
        self.assertNotIn(long_text, prompt)
        self.assertIn("x" * 100, prompt)


class InputLimitTest(unittest.TestCase):
    def test_small_input_is_untouched(self):
        utterances = {"u1": {"speaker": "user", "text": "짧다"}}
        capped, truncated = HARNESS.limit_utterances(utterances)
        self.assertEqual(capped, utterances)
        self.assertFalse(truncated)
        self.assertIsNot(capped, utterances)

    def test_per_utterance_middle_is_omitted(self):
        text = "a" * 5000
        capped, truncated = HARNESS.limit_utterances(
            {"u1": {"speaker": "user", "text": text}})
        self.assertTrue(truncated)
        self.assertEqual(len(capped["u1"]["text"]), HARNESS.MAX_UTTERANCE_TEXT)
        self.assertIn("…", capped["u1"]["text"])
        self.assertEqual(capped["u1"]["speaker"], "user")

    def test_total_cap_keeps_newest_utterances(self):
        utterances = {
            "u%d" % index: {"speaker": "user", "text": "x" * 1900}
            for index in range(1, 16)
        }
        capped, truncated = HARNESS.limit_utterances(utterances)
        self.assertTrue(truncated)
        self.assertLessEqual(
            sum(len(item["text"]) for item in capped.values()),
            HARNESS.MAX_TOTAL_UTTERANCE_TEXT)
        self.assertIn("u15", capped)
        self.assertNotIn("u1", capped)


class SummaryEnvTest(unittest.TestCase):
    def test_removes_agent_environment_and_injects_path(self):
        base = {"MAST": "1", "MAST_TAB": "9", "MAST_TTY": "/dev/tty", "CODEX_THREAD_ID": "t",
                "PATH": "/old", "KEEP": "yes"}
        env = HARNESS.summary_env(base, "/login", "/codex-home")
        for name in ("MAST", "MAST_TAB", "MAST_TTY", "CODEX_THREAD_ID"):
            self.assertNotIn(name, env)
        self.assertEqual(env["PATH"], "/login")
        self.assertEqual(env["CODEX_HOME"], "/codex-home")
        self.assertEqual(env["KEEP"], "yes")

    def test_without_login_path_the_path_is_kept(self):
        env = HARNESS.summary_env({"PATH": "/old"}, None)
        self.assertEqual(env["PATH"], "/old")
        self.assertNotIn("CODEX_HOME", env)

    def test_non_mapping_base_starts_empty(self):
        self.assertEqual(HARNESS.summary_env(None, "/login"), {"PATH": "/login"})


class TimeoutTest(HarnessTestCase):
    def test_summary_expired_uses_injected_limit(self):
        job = types.SimpleNamespace(started=100.0)
        self.assertFalse(HARNESS.summary_expired(job, 105.0, limit=10.0))
        self.assertTrue(HARNESS.summary_expired(job, 110.0, limit=10.0))

    def test_kill_summary_kills_process_group_and_cleans_up(self):
        job = self.start_job()
        real_proc = job.proc

        class Proc:
            returncode = None
            pid = real_proc.pid
            stdin = None

            def wait(self, timeout=None):
                return 0

        job.proc = Proc()
        with mock.patch.object(HARNESS.os, "killpg") as killpg:
            HARNESS.kill_summary(job)
        killpg.assert_called_once()
        self.assertFalse(Path(job.tmpdir).exists(), "임시 디렉터리를 지운다")

        # 대역으로 바꾼 실제 codex 자식을 회수한다 — fixture의 subprocess 누수를 남기지 않는다.
        job.proc = real_proc
        HARNESS.kill_summary(job)

    def test_kill_summary_skips_the_group_when_the_child_is_reaped(self):
        job = self.start_job()
        tmpdir = Path(job.tmpdir)
        job.proc.kill()
        job.proc.wait()
        with mock.patch.object(HARNESS.os, "killpg") as killpg:
            HARNESS.kill_summary(job)
        killpg.assert_not_called()
        self.assertFalse(tmpdir.exists())


class FinishSummarySuccessTest(HarnessTestCase):
    def test_success_replaces_the_summary_and_advances_the_cursor(self):
        before = self.seed_summary(
            STORE.new_summary(self.workspace["rootPath"], self.workspace["distro"],
                              "2026-09-25T02:00:00Z"))
        result = HARNESS.finish_summary(
            self.manager, self.workspace, HARNESS.normalize_summary(summary_output(
                progress="새 진행", needs_input="", next_step="다음", reason="done")),
            None, cursor_update(120), False, NOW, {})
        self.assertIsNone(result["error"])
        self.assertTrue(result["changed"])
        doc = self.load_summary()
        self.assertEqual(doc["summary"], {"progress": "새 진행", "needs_input": "", "next": "다음"})
        self.assertEqual(doc["meta"]["last_collected_at"], NOW)
        self.assertIsNone(doc["meta"]["last_error"])
        self.assertFalse(doc["meta"]["input_truncated"])
        self.assertEqual(doc["meta"]["cursor"]["sess-8f2c"]["offset"], 120)
        self.assertEqual(doc["meta"]["cursor"]["sess-8f2c"]["tab"], 4)
        self.assertEqual(doc["meta"]["updated_at"], NOW)
        self.assertEqual(result["notify"], {
            "reason": "done", "title": "Work reported done", "body": "새 진행"})
        entry = HARNESS._board_entry(
            self.workspace, self.manager, ROOT_WORKSPACE["distro"], ROOT_WORKSPACE["distro"])
        self.assertEqual(entry["state"], "active")
        self.assertEqual(entry["summary"]["progress"], "새 진행")

    def test_same_summary_keeps_updated_at_and_sends_no_notify(self):
        first = HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output(progress="같은 진행", reason="done")),
            None, cursor_update(10), False, "2026-09-25T01:00:00Z", {})
        second = HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output(progress="같은 진행", reason="done")),
            None, cursor_update(20), False, "2026-09-25T02:00:00Z", {})
        self.assertTrue(first["changed"])
        self.assertFalse(second["changed"])
        self.assertIsNone(second["notify"])
        doc = self.load_summary()
        self.assertEqual(doc["meta"]["updated_at"], "2026-09-25T01:00:00Z")
        self.assertEqual(doc["meta"]["last_collected_at"], "2026-09-25T02:00:00Z")

    def test_truncated_flag_records_input_truncated(self):
        self.seed_summary()
        HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output()), None, cursor_update(1), True, NOW, {})
        self.assertTrue(self.load_summary()["meta"]["input_truncated"])
        HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output()), None, cursor_update(2), False,
            "2026-09-25T04:00:00Z", {})
        self.assertFalse(self.load_summary()["meta"]["input_truncated"])

    def test_whitespace_padded_progress_is_not_stored_blank(self):
        self.seed_summary()
        normalized = HARNESS.normalize_summary(summary_output(progress=" " * 400 + "x"))
        result = HARNESS.finish_summary(
            self.manager, self.workspace, normalized, None, cursor_update(5), False, NOW, {})
        self.assertIsNone(result["error"])
        self.assertEqual(self.load_summary()["summary"]["progress"], "x",
                         "공백만 남는 progress가 성공으로 저장되지 않는다")

    def test_repo_cache_is_recorded(self):
        self.seed_summary()
        repo = {"name": "mast", "path": "/home/u/projects/mast", "remote": None}
        HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output()), None, cursor_update(1), False, NOW,
            {self.workspace["rootPath"]: repo})
        self.assertEqual(self.load_summary()["repo"], repo)

    def test_null_repo_detection_keeps_the_stored_repo(self):
        doc = self.seed_summary()
        stored = doc["repo"]
        HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output()), None, cursor_update(1), False, NOW,
            {self.workspace["rootPath"]: None})
        self.assertEqual(self.load_summary()["repo"], stored)

    def test_missing_repo_mapping_keeps_the_stored_repo_without_git(self):
        doc = self.seed_summary()
        HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output()), None, cursor_update(1), False, NOW,
            {})
        self.assertEqual(self.load_summary()["repo"], doc["repo"])

    def test_cursor_updates_merge_into_the_latest_document(self):
        self.seed_summary()
        HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output()), None,
            cursor_update(1, "sess-a"), False, NOW, {})
        HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output()), None,
            cursor_update(2, "sess-b"), False, NOW, {})
        cursor = self.load_summary()["meta"]["cursor"]
        self.assertEqual(sorted(cursor), ["sess-a", "sess-b"])


class FinishSummaryFailureTest(HarnessTestCase):
    def test_failure_keeps_the_previous_summary_and_cursor(self):
        before = self.seed_summary()
        result = HARNESS.finish_summary(
            self.manager, self.workspace, None, "summary process exited with code 1",
            cursor_update(500), True, NOW, {})
        self.assertEqual(result["error"], "summary process exited with code 1")
        self.assertIsNone(result["notify"])
        doc = self.load_summary()
        self.assertEqual(doc["summary"], before["summary"])
        self.assertEqual(doc["meta"]["cursor"], before["meta"]["cursor"])
        self.assertEqual(doc["meta"]["last_collected_at"], before["meta"]["last_collected_at"])
        self.assertEqual(doc["meta"]["updated_at"], before["meta"]["updated_at"])
        self.assertIn("exited with code 1", doc["meta"]["last_error"])

    def test_first_failure_creates_an_empty_document_without_last_collected(self):
        result = HARNESS.finish_summary(
            self.manager, self.workspace, None, "boom", {}, False, NOW, {})
        self.assertEqual(result["error"], "boom")
        doc = self.load_summary()
        self.assertEqual(doc["summary"], {"progress": "", "needs_input": "", "next": ""})
        self.assertIsNone(doc["meta"]["last_collected_at"])
        self.assertEqual(doc["meta"]["last_error"], "boom")

        # 실패 뒤 발화 없는 빠른 경로가 시각만 채워도 오류 카드로 남는다.
        HARNESS.finish_fast(self.manager, self.workspace, {}, "2026-09-25T04:00:00Z", {})
        entry = HARNESS._board_entry(
            self.workspace, self.manager, ROOT_WORKSPACE["distro"], ROOT_WORKSPACE["distro"])
        self.assertEqual(entry["state"], "error")
        self.assertEqual(entry["error"], "boom")
        self.assertEqual(self.load_summary()["meta"]["last_collected_at"],
                         "2026-09-25T04:00:00Z")

    def test_failure_with_a_missing_summary_records_only_last_error(self):
        doc = self.load_summary() if self.summary_path().exists() else None
        self.assertIsNone(doc)
        HARNESS.finish_summary(self.manager, self.workspace, None, "x" * 2000, {}, False, NOW, {})
        doc = self.load_summary()
        self.assertLessEqual(len(doc["meta"]["last_error"]), STORE.MAX_LAST_ERROR)

    def test_error_on_a_broken_file_does_not_overwrite_it(self):
        path = self.summary_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{broken", encoding="utf-8")
        with self.assertRaises(ValueError):
            HARNESS.finish_summary(
                self.manager, self.workspace, None, "boom", {}, False, NOW, {})
        self.assertEqual(path.read_text(encoding="utf-8"), "{broken")


class NotifyTest(unittest.TestCase):
    def test_changed_reason_notifies(self):
        notice = HARNESS.decide_notify(
            "question", {"progress": "p", "needs_input": "무엇을 할까?", "next": ""}, "idle")
        self.assertEqual(notice["reason"], "question")
        self.assertEqual(notice["body"], "무엇을 할까?")

    def test_done_uses_the_progress_text(self):
        notice = HARNESS.decide_notify(
            "done", {"progress": "배포 완료", "needs_input": "", "next": ""}, "idle")
        self.assertEqual(notice["title"], "Work reported done")
        self.assertEqual(notice["body"], "배포 완료")

    def test_needs_input_suppresses(self):
        self.assertIsNone(HARNESS.decide_notify(
            "question", {"progress": "p", "needs_input": "q", "next": ""}, "needsInput"))

    def test_null_reason_does_not_notify(self):
        self.assertIsNone(HARNESS.decide_notify(
            None, {"progress": "p", "needs_input": "q", "next": ""}, "idle"))
        self.assertIsNone(HARNESS.decide_notify(
            "unknown", {"progress": "p", "needs_input": "q", "next": ""}, "idle"))

    def test_long_text_is_clipped_to_the_contract_limits(self):
        notice = HARNESS.decide_notify(
            "question", {"progress": "p", "needs_input": "가" * 500, "next": ""}, "idle")
        self.assertEqual(len(notice["body"]), HARNESS.NOTIFY_BODY_MAX)
        self.assertEqual(notice["body"], "가" * 199 + "…")

    def test_empty_content_uses_the_reason_fallback(self):
        notice = HARNESS.decide_notify(
            "failed", {"progress": "  ", "needs_input": "", "next": ""}, "idle")
        self.assertEqual(notice["body"], HARNESS._DEFAULT_NOTIFY_BODIES["failed"])


class FastPathTest(HarnessTestCase):
    def test_finish_fast_updates_cursor_and_timestamp_only(self):
        before = self.seed_summary()
        result = HARNESS.finish_fast(self.manager, self.workspace, cursor_update(77), NOW, {})
        doc = self.load_summary()
        self.assertEqual(doc["summary"], before["summary"])
        self.assertEqual(doc["meta"]["updated_at"], before["meta"]["updated_at"])
        self.assertEqual(doc["meta"]["last_collected_at"], NOW)
        self.assertEqual(doc["meta"]["cursor"]["sess-8f2c"]["offset"], 77)
        self.assertEqual(result["pruned_sessions"], [])
        self.assertIsNone(doc["meta"]["last_error"], "빠른 경로는 last_error를 바꾸지 않는다")

    def test_finish_fast_creates_a_missing_summary(self):
        result = HARNESS.finish_fast(self.manager, self.workspace, cursor_update(5), NOW, {})
        loaded = self.load_summary()
        self.assertEqual(loaded, result["doc"])
        self.assertEqual(loaded["meta"]["last_collected_at"], NOW)
        self.assertEqual(loaded["summary"], {"progress": "", "needs_input": "", "next": ""})
        self.assertEqual(loaded["meta"]["cursor"]["sess-8f2c"]["offset"], 5,
                         "빠른 경로는 커서를 보존·전진시킨다")
        entry = HARNESS._board_entry(
            self.workspace, self.manager, ROOT_WORKSPACE["distro"], ROOT_WORKSPACE["distro"])
        self.assertEqual(entry["state"], "none",
                         "내용 없는 metadata-only 수집은 active 카드가 아니다")
        self.assertIsNone(entry["summary"])

    def test_finish_fast_records_the_repo_cache(self):
        repo = {"name": "mast", "path": "/home/u/projects/mast", "remote": None}
        HARNESS.finish_fast(
            self.manager, self.workspace, cursor_update(5), NOW,
            {self.workspace["rootPath"]: repo})
        self.assertEqual(self.load_summary()["repo"], repo)

    def test_finish_fast_null_repo_keeps_the_stored_repo(self):
        doc = self.seed_summary()
        HARNESS.finish_fast(
            self.manager, self.workspace, cursor_update(5), NOW,
            {self.workspace["rootPath"]: None})
        self.assertEqual(self.load_summary()["repo"], doc["repo"])

    def test_finish_fast_prunes_old_cursor_entries(self):
        doc = STORE.new_summary(self.workspace["rootPath"], self.workspace["distro"], NOW)
        doc["meta"]["cursor"] = {
            "s%02d" % index: {
                "agent": "claude", "transcript_path": "/tmp/s%d.jsonl" % index,
                "offset": index, "updated": "2026-09-25T00:%02d:00Z" % index, "tab": 4,
            }
            for index in range(1, 31)
        }
        self.seed_summary(doc)
        additions = {}
        for order, session_id in enumerate(("new01", "new02", "new03"), start=1):
            additions[session_id] = {
                "agent": "claude",
                "transcript_path": "/tmp/%s.jsonl" % session_id,
                "offset": order,
                "updated": "2026-09-25T04:0%d:00Z" % order,
                "tab": 4,
            }
        result = HARNESS.finish_fast(self.manager, self.workspace, additions, NOW, {})
        self.assertEqual(result["pruned_sessions"], ["s01"])
        cursor = self.load_summary()["meta"]["cursor"]
        self.assertEqual(len(cursor), STORE.MAX_CURSOR_SESSIONS)
        self.assertIn("new03", cursor)


class ConcurrencyTest(HarnessTestCase):
    def test_finish_reads_the_latest_document_under_the_lock(self):
        self.seed_summary()
        HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output(progress="첫 요약")), None,
            cursor_update(1, "sess-a"), False, NOW, {})
        # 시작~완료 사이에 다른 writer가 커서를 더해도 최신본 위에 병합된다.
        HARNESS.finish_summary(
            self.manager, self.workspace,
            HARNESS.normalize_summary(summary_output(progress="둘째 요약")), None,
            cursor_update(2, "sess-b"), False, "2026-09-25T04:00:00Z", {})
        doc = self.load_summary()
        self.assertEqual(doc["summary"]["progress"], "둘째 요약")
        self.assertEqual(sorted(doc["meta"]["cursor"]), ["sess-a", "sess-b"])


if __name__ == "__main__":
    unittest.main()
