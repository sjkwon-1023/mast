"""mast-config.py의 `manager` 설정 검증·CLI 단위 테스트 (macOS·Linux 공용).

`apps/mast/tests/config-cli.test.ts`의 harness 스위트는 Linux 전용이라 macOS에서
skip된다. 이 파일은 같은 계약을 macOS에서 실제로 돌리기 위한 것이다.
"""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / "scripts" / "wsl" / "mast-config.py"
NOTICE = "manager is disabled; run mast config set manager.enabled true"


def load_helper():
    spec = importlib.util.spec_from_file_location("mast_config_manager_test", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CONFIG = load_helper()


class ManagerConfigTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.settings = self.root / "settings.json"

    def tearDown(self):
        self.temp.cleanup()

    def execute(self, *args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            CONFIG.execute(list(args), self.settings)
        return output.getvalue()

    def write(self, data):
        self.settings.write_text(json.dumps(data) + "\n", encoding="utf-8")

    def saved(self):
        return json.loads(self.settings.read_text(encoding="utf-8"))

    @contextlib.contextmanager
    def fake_codex(self, body):
        directory = self.root / "bin"
        directory.mkdir(exist_ok=True)
        executable = directory / "codex"
        executable.write_text("#!/bin/sh\n" + body + "\n", encoding="utf-8")
        executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
        with mock.patch.dict(os.environ, {"PATH": str(directory)}):
            yield

    def test_set_manager_enabled_and_each_field(self):
        with self.fake_codex("echo codex-cli 0.0.0"):
            output = self.execute("set", "manager.enabled", "true")
        self.assertIn("Saved settings to", output)
        self.assertNotIn(NOTICE, output)
        self.assertEqual(self.saved(), {"manager": {"enabled": True}})

        self.execute("set", "manager.model", "gpt-6.luna:v1_x-y")
        self.execute("set", "manager.effort", "xhigh")
        self.execute("set", "manager.summaryModel", "gpt-6-luna")
        self.execute("set", "manager.summaryEffort", "minimal")
        output = self.execute("set", "manager.idleSeconds", "600")
        self.assertNotIn(NOTICE, output)
        self.assertEqual(self.saved()["manager"], {
            "enabled": True,
            "model": "gpt-6.luna:v1_x-y",
            "effort": "xhigh",
            "summaryModel": "gpt-6-luna",
            "summaryEffort": "minimal",
            "idleSeconds": 600,
        })

    def test_set_manager_enabled_false_needs_no_codex_and_keeps_other_fields(self):
        self.write({"manager": {"enabled": True, "model": "gpt-6-luna"}, "fontSize": 15})
        with tempfile.TemporaryDirectory() as empty:
            with mock.patch.dict(os.environ, {"PATH": empty}):
                output = self.execute("set", "manager.enabled", "false")
        self.assertEqual(self.saved(), {"fontSize": 15, "manager": {"enabled": False, "model": "gpt-6-luna"}})
        self.assertNotIn(NOTICE, output)

    def test_subfield_set_without_manager_writes_disabled_object_and_prints_notice(self):
        output = self.execute("set", "manager.idleSeconds", "45")
        self.assertEqual(self.saved(), {"manager": {"enabled": False, "idleSeconds": 45}})
        self.assertIn(NOTICE, output)

        output = self.execute("set", "manager.model", "gpt-6-luna")
        self.assertIn(NOTICE, output)

    def test_subfield_set_on_disabled_manager_prints_notice(self):
        self.write({"manager": {"enabled": False}})
        output = self.execute("set", "manager.effort", "low")
        self.assertEqual(self.saved(), {"manager": {"enabled": False, "effort": "low"}})
        self.assertIn(NOTICE, output)

    def test_reset_manager_and_one_field(self):
        self.write({"fontSize": 15, "manager": {"enabled": True, "model": "gpt-6-luna", "effort": "low"}})
        self.execute("reset", "manager.model")
        self.assertEqual(self.saved(), {"fontSize": 15, "manager": {"enabled": True, "effort": "low"}})
        self.execute("reset", "manager.model")
        self.assertEqual(self.saved(), {"fontSize": 15, "manager": {"enabled": True, "effort": "low"}})

        self.execute("reset", "manager")
        self.assertEqual(self.saved(), {"fontSize": 15})
        self.execute("reset", "manager")
        self.assertEqual(self.saved(), {"fontSize": 15})

    def test_reset_manager_enabled_is_refused_and_changes_nothing(self):
        self.write({"manager": {"enabled": True}})
        before = self.settings.read_bytes()
        with self.assertRaises(ValueError) as caught:
            self.execute("reset", "manager.enabled")
        self.assertIn("use reset manager", str(caught.exception))
        self.assertEqual(self.settings.read_bytes(), before)

    def test_idle_seconds_boundaries_and_integer_only(self):
        for text in ("9", "601", "10.5", "-10", "abc"):
            with self.assertRaises(ValueError, msg=text):
                self.execute("set", "manager.idleSeconds", text)
        self.assertFalse(self.settings.exists())
        for text in ("10", "600"):
            self.execute("set", "manager.idleSeconds", text)
            self.assertEqual(self.saved()["manager"]["idleSeconds"], int(text))

    def test_effort_accepts_the_five_names_and_rejects_others(self):
        for effort in CONFIG.MANAGER_EFFORTS:
            self.execute("set", "manager.effort", effort)
            self.assertEqual(self.saved()["manager"]["effort"], effort)
            self.execute("set", "manager.summaryEffort", effort)
        for effort in ("max", "HIGH", "x-high", ""):
            with self.assertRaises(ValueError, msg=effort):
                self.execute("set", "manager.effort", effort)

    def test_model_charset_and_length_boundaries(self):
        maximum = "a" * 64
        self.execute("set", "manager.model", maximum)
        self.assertEqual(self.saved()["manager"]["model"], maximum)
        for value in ("a" * 65, "", "bad model", "prompt/../x", "한글"):
            with self.assertRaises(ValueError, msg=value):
                self.execute("set", "manager.model", value)
        with self.assertRaises(ValueError):
            self.execute("set", "manager.summaryModel", "bad!")

    def test_manager_object_requires_enabled_and_rejects_unknown_fields(self):
        invalid = (
            {"manager": {"model": "gpt-6-luna"}},
            {"manager": {}},
            {"manager": True},
            {"manager": "on"},
            {"manager": {"enabled": "yes"}},
            {"manager": {"enabled": True, "extra": 1}},
            {"manager": {"enabled": True, "model": 5}},
            {"manager": {"enabled": True, "effort": 1}},
            {"manager": {"enabled": True, "idleSeconds": True}},
            {"manager": {"enabled": True, "idleSeconds": 45.0}},
            {"manager": {"enabled": True, "idleSeconds": 9}},
            {"manager": {"enabled": True, "idleSeconds": 601}},
            {"manager": {"enabled": True, "model": "a" * 65}},
            {"manager": {"enabled": True, "model": ""}},
            {"manager": {"enabled": True, "model": "bad model"}},
            {"manager": {"enabled": True, "summaryEffort": "max"}},
        )
        for data in invalid:
            self.write(data)
            original = self.settings.read_bytes()
            with self.assertRaises(ValueError, msg=data):
                self.execute("get")
            with self.assertRaises(ValueError, msg=data):
                self.execute("set", "fontSize", "15")
            self.assertEqual(self.settings.read_bytes(), original)

    def test_manager_absent_or_null_stays_off(self):
        output = self.execute("get", "manager")
        self.assertIn('"saved": null', output)
        self.assertIn('"default"', output)
        self.assertIn('"enabled": false', output)
        output = self.execute("get", "manager.enabled")
        self.assertIn('"saved": null', output)
        self.assertIn('"default": false', output)
        self.write({"manager": None})
        self.assertEqual(self.saved(), {"manager": None})

    def test_get_reports_saved_values_and_built_in_defaults(self):
        self.write({"manager": {"enabled": False, "model": "gpt-6-luna", "idleSeconds": 60}})
        output = self.execute("get", "manager.idleSeconds")
        self.assertIn('"saved": 60', output)
        self.assertIn('"default": 45', output)
        output = self.execute("get", "manager.effort")
        self.assertIn('"saved": null', output)
        self.assertIn('"default": "high"', output)
        output = self.execute("get", "manager")
        self.assertIn('"saved": {', output)

    def test_set_top_level_manager_is_refused(self):
        with self.assertRaises(ValueError):
            self.execute("set", "manager", "true")
        self.assertFalse(self.settings.exists())

    def test_unknown_manager_field_is_not_a_known_key(self):
        with self.assertRaises(ValueError):
            self.execute("get", "manager.summarryModel")
        with self.assertRaises(ValueError):
            self.execute("set", "manager.summarryModel", "x")
        with self.assertRaises(ValueError):
            self.execute("reset", "manager.summarryModel")

    def test_enabling_manager_requires_codex_on_path(self):
        self.write({"showTabIds": False})
        before = self.settings.read_bytes()
        with tempfile.TemporaryDirectory() as empty:
            with mock.patch.dict(os.environ, {"PATH": empty}):
                with self.assertRaises(ValueError) as caught:
                    self.execute("set", "manager.enabled", "true")
        self.assertEqual(str(caught.exception), CONFIG.MANAGER_CODEX_MISSING)
        self.assertEqual(self.settings.read_bytes(), before)

    def test_enabling_manager_accepts_an_existing_codex(self):
        with self.fake_codex("echo codex-cli 0.0.0"):
            self.execute("set", "manager.enabled", "true")
        self.assertEqual(self.saved(), {"manager": {"enabled": True}})

    def test_enabling_manager_rejects_a_failing_codex(self):
        self.write({"manager": {"enabled": False}})
        before = self.settings.read_bytes()
        with self.fake_codex("exit 1"):
            with self.assertRaises(ValueError) as caught:
                self.execute("set", "manager.enabled", "true")
        self.assertEqual(str(caught.exception), CONFIG.MANAGER_CODEX_MISSING)
        self.assertEqual(self.settings.read_bytes(), before)

    def test_enabling_manager_rejects_codex_that_does_not_execute(self):
        directory = self.root / "bin"
        directory.mkdir()
        executable = directory / "codex"
        executable.write_text("#!/bin/sh\necho codex-cli 0.0.0\n", encoding="utf-8")
        executable.chmod(0o644)
        self.write({"showTabIds": False})
        before = self.settings.read_bytes()
        with mock.patch.dict(os.environ, {"PATH": str(directory)}):
            with self.assertRaises(ValueError):
                self.execute("set", "manager.enabled", "true")
        self.assertEqual(self.settings.read_bytes(), before)

    def test_main_reports_missing_codex_on_stderr_with_exit_one(self):
        self.write({"showTabIds": False})
        before = self.settings.read_bytes()
        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as empty, \
                mock.patch.dict(os.environ, {"PATH": empty, "MAST_CONFIG_PATH": str(self.settings)}), \
                mock.patch.object(CONFIG, "windows_settings_path", lambda: self.settings), \
                mock.patch.object(sys, "argv", ["mast-config.py", "set", "manager.enabled", "true"]), \
                contextlib.redirect_stderr(stderr):
            code = CONFIG.main()
        self.assertEqual(code, 1)
        self.assertIn(CONFIG.MANAGER_CODEX_MISSING, stderr.getvalue())
        self.assertEqual(self.settings.read_bytes(), before)

    def test_main_saves_through_the_exported_settings_path(self):
        stdout = io.StringIO()
        with self.fake_codex("echo codex-cli 0.0.0"), \
                mock.patch.dict(os.environ, {"MAST_CONFIG_PATH": str(self.settings)}), \
                mock.patch.object(CONFIG, "windows_settings_path", lambda: self.settings), \
                mock.patch.object(sys, "argv", ["mast-config.py", "set", "manager.enabled", "true"]), \
                contextlib.redirect_stdout(stdout):
            code = CONFIG.main()
        self.assertEqual(code, 0, stdout.getvalue())
        self.assertEqual(self.saved(), {"manager": {"enabled": True}})

    def test_help_lists_the_manager_commands(self):
        output = self.execute("--help")
        self.assertIn("mast config set manager.enabled", output)
        self.assertIn("mast config reset manager", output)


if __name__ == "__main__":
    unittest.main()
