"""macOS Local HTTP 원격 설정 CLI 통합 테스트."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]


@unittest.skipUnless(sys.platform == "darwin", "the shell setting exists only on macOS")
class NativeRemoteConfig(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.settings = self.root / "exported-settings.json"

    def tearDown(self):
        self.temp.cleanup()

    def config(self, *args, home=None, settings="exported"):
        env = dict(os.environ, HOME=str(home or self.home))
        if settings == "exported":
            env["MAST_CONFIG_PATH"] = str(self.settings)
        else:
            env.pop("MAST_CONFIG_PATH", None)
        return subprocess.run(
            [sys.executable, "-I", str(ROOT / "scripts/wsl/mast-config.py"), *args],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    @staticmethod
    def saved(path):
        return json.loads(path.read_text(encoding="utf-8"))

    def test_darwin_remote_defaults_and_explicit_ports(self):
        cases = (
            (("set", "remote"), 7331),
            (("set", "remote", "true", "--port", "7441"), 7441),
            (("set", "remote.port", "7442"), 7442),
        )
        for args, port in cases:
            with self.subTest(args=args):
                result = self.config(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.saved(self.settings), {"remote": {"port": port}})
                self.assertIn("after restart", result.stdout)

    def test_disable_and_reset_remove_remote_without_losing_other_keys(self):
        result = self.config("get")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.settings.exists())

        self.settings.write_text(
            json.dumps({"fontSize": 15, "showTabIds": False}) + "\n",
            encoding="utf-8",
        )
        result = self.config("set", "remote", "false")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.saved(self.settings), {"fontSize": 15, "showTabIds": False})

        result = self.config("set", "remote")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.config("reset", "remote")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.saved(self.settings), {"fontSize": 15, "showTabIds": False})

    def test_darwin_remote_rejects_invalid_ports_without_writing(self):
        self.settings.write_bytes(b'{ "showTabIds": false }\n')
        original = self.settings.read_bytes()
        invalid = (
            ("set", "remote", "--port", "1023"),
            ("set", "remote", "true", "--port", "65536"),
            ("set", "remote.port", "not-a-port"),
            ("set", "remote", "false", "--port", "7441"),
            ("set", "remote.port"),
        )
        for args in invalid:
            with self.subTest(args=args):
                result = self.config(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.settings.read_bytes(), original)

    def test_darwin_uses_exported_or_application_support_path(self):
        exported_home = self.root / "exported-home"
        exported_home.mkdir()
        result = self.config(
            "set",
            "remote.port",
            "7441",
            home=exported_home,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(self.settings), result.stdout)
        self.assertEqual(self.saved(self.settings), {"remote": {"port": 7441}})
        self.assertFalse(
            (exported_home / "Library/Application Support/app.mast.desktop/settings.json").exists()
        )

        default_home = self.root / "default-home"
        default_home.mkdir()
        default_settings = (
            default_home / "Library/Application Support/app.mast.desktop/settings.json"
        )
        result = self.config("set", "remote", home=default_home, settings=None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(default_settings), result.stdout)
        self.assertEqual(self.saved(default_settings), {"remote": {"port": 7331}})
