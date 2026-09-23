"""Native adapters; run with Python 3.11+ on any host (shell tests require POSIX)."""
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load("native_cli", ROOT / "scripts/macos/mast.py")
setup = load("native_setup", ROOT / "scripts/macos/setup.py")


class NativeCli(unittest.TestCase):
    def test_send_uses_the_existing_osc_contract(self):
        with patch.object(cli, "emit", return_value=True) as emit, patch.object(cli.time, "sleep"):
            cli.send(["#42", "한글", "\"$(touch /tmp/no)\"\nline"])
        packets = [call.args[0] for call in emit.call_args_list]
        self.assertEqual(len(packets), 2)
        prefix = b"\x1b]777;mast-send;#42;"
        self.assertTrue(packets[0].startswith(prefix))
        self.assertEqual(base64.b64decode(packets[0][len(prefix):-1]).decode(), "한글 \"$(touch /tmp/no)\"\nline")
        self.assertEqual(base64.b64decode(packets[1][len(prefix):-1]), b"\r")

    def test_literal_send_does_not_submit(self):
        with patch.object(cli, "emit", return_value=True) as emit:
            cli.send(["-l", "#42", "draft"])
        self.assertEqual(emit.call_count, 1)

    def test_malicious_target_and_oversized_message_are_not_emitted(self):
        for args in [["#1;inject", "text"], ["bad\x07", "text"], ["bad\x9c", "text"],
                     ["#1", "x" * (24 * 1024 + 1)], ["--unknown", "#1", "text"]]:
            with self.subTest(args=str(args)[:50]), patch.object(cli, "emit") as emit:
                with self.assertRaises(ValueError):
                    cli.send(args)
                emit.assert_not_called()

    def test_ls_reads_a_private_reply_and_sanitizes_titles(self):
        directories = []
        def respond(packet):
            path = Path(base64.b64decode(packet.split(b";")[-1][:-1]).decode())
            self.assertTrue(str(path).startswith("/tmp/mast-query-"))
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            directories.append(path.parent)
            path.write_text(json.dumps({"self_tab": 1, "ttys": {"2": "/dev/ttys002"}, "tabs": [
                {"tab": 1, "title": "self", "workspaceName": "work", "status": "running"},
                {"tab": 2, "title": "evil\x1b]52;clipboard\x07\x9c", "workspaceName": "work", "status": "running"},
            ]}))
            return True
        out = io.StringIO()
        with patch.object(cli, "emit", side_effect=respond), \
             patch.object(cli, "commands_by_tty", return_value={"/dev/ttys002": "codex"}), \
             contextlib.redirect_stdout(out):
            cli.list_tabs([])
        self.assertIn("#1 *", out.getvalue())
        self.assertIn("codex", out.getvalue())
        for character in ("\x1b", "\x07", "\x9c"):
            self.assertNotIn(character, out.getvalue())
        self.assertTrue(all(not path.exists() for path in directories))

    def test_id_requires_a_numeric_mast_tab(self):
        with patch.dict(os.environ, {"MAST_TAB": "../../etc"}):
            with self.assertRaises(ValueError):
                cli.main(["id"])


class NativeInstaller(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.patchers = [patch.object(setup, "HOME", self.home),
                         patch.object(setup, "MAST", self.home / ".mast"),
                         patch.object(setup, "BIN", self.home / ".mast/bin")]
        for p in self.patchers:
            p.start()

    def tearDown(self):
        for p in reversed(self.patchers):
            p.stop()
        self.temp.cleanup()

    def config(self, text):
        path = self.home / ".codex/config.toml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def test_notify_added_at_root_once_without_rewriting_user_config(self):
        original = '# user comment\nmodel="example"\n[projects."/Users/me/work"]\ntrust_level="trusted"\n'
        path = self.config(original)
        setup.codex_notify()
        import tomllib
        document = tomllib.loads(path.read_text())
        self.assertEqual(document["notify"][0], "/bin/bash")
        self.assertTrue(path.read_text().endswith(original))
        first = path.read_bytes()
        setup.codex_notify()
        self.assertEqual(path.read_bytes(), first)
        self.assertEqual(path.with_name("config.toml.mast-before-macos").read_text(), original)

    def test_existing_notify_and_malformed_toml_are_preserved(self):
        for original in ['notify=["my-notify"]\nmodel="example"\n', 'broken = [\n']:
            path = self.config(original)
            try:
                setup.codex_notify()
            except ValueError:
                pass
            self.assertEqual(path.read_text(), original)

    def test_user_owned_opencode_plugin_is_not_overwritten(self):
        config = self.home / ".config"
        path = config / "opencode/plugins/mast.js"
        path.parent.mkdir(parents=True)
        path.write_text("// user integration")
        setup.BIN.mkdir(parents=True)
        (setup.BIN / "mast-opencode-plugin.js").write_text("// managed source")
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(config)}):
            with self.assertRaises(ValueError):
                setup.opencode_plugin()
        self.assertEqual(path.read_text(), "// user integration")

    def test_owned_opencode_plugin_can_be_updated_idempotently(self):
        config = self.home / ".config"
        setup.BIN.mkdir(parents=True)
        source = setup.BIN / "mast-opencode-plugin.js"
        source.write_text("// version 1")
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(config)}):
            setup.opencode_plugin()
            setup.opencode_plugin()
            source.write_text("// version 2")
            setup.opencode_plugin()
        self.assertEqual((config / "opencode/plugins/mast.js").read_text(), "// version 2")


class NativeResume(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bin = self.root / ".mast/bin"
        self.bin.mkdir(parents=True)
        for source, name in [("scripts/macos/notify.py", "mast-notify.py"),
                             ("scripts/wsl/mast-agent-hook.py", "mast-agent-hook.py")]:
            shutil.copyfile(ROOT / source, self.bin / name)
        self.env = patch.dict(os.environ, {"HOME": str(self.root), "MAST": "1", "MAST_TAB": "42"})
        self.env.start()
        self.notify = load("native_notify", self.bin / "mast-notify.py")

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_resume_hint_is_data_not_an_executable_script(self):
        self.notify.save_resume("claude --resume", "safe-id_123")
        path = self.root / ".mast/resume/tab-42"
        self.assertEqual(path.read_text().splitlines()[0], "claude --resume safe-id_123")
        before = path.read_bytes()
        for session in ("x;touch /tmp/no", "$(whoami)", "x\nother", "", "../1"):
            self.notify.save_resume("claude --resume", session)
            self.assertEqual(path.read_bytes(), before)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_codex_subagent_is_rejected_and_cli_session_can_resume(self):
        directory = self.root / ".codex/sessions/2026/09/23"
        directory.mkdir(parents=True)
        path = directory / "rollout-2026-test-thread.jsonl"
        for source, expected in [({"subagent": "review"}, ("rejected", False)),
                                 ("cli", ("confirmed", True)), ("appServer", ("confirmed", False))]:
            path.write_text(json.dumps({"type": "session_meta", "payload": {"id": "thread", "source": source}}) + "\n")
            with patch.dict(os.environ, {"CODEX_HOME": str(self.root / ".codex")}):
                self.assertEqual(self.notify.ownership("thread"), expected)


if __name__ == "__main__":
    unittest.main()
