"""네이티브 어댑터. 어느 호스트에서든 Python 3.11+ 로 실행한다(셸 테스트는 POSIX 필요)."""
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
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

    def symlinked_skill_home(self):
        # 첫 skill 디렉터리를 다른 트리로 향하는 symlink 로 두고, 실제 외부 명령 없이 끝나는 OpenCode 만 연결 대상으로 남긴다.
        setup.BIN.mkdir(parents=True)
        for name in ("mast-skill.md", "mast-send-skill.md"):
            (setup.BIN / name).write_text("skill")
        (setup.BIN / "mast-opencode-plugin.js").write_text("// managed source")
        elsewhere = self.home / "elsewhere"
        elsewhere.mkdir()
        (self.home / ".claude/skills").mkdir(parents=True)
        (self.home / ".claude/skills/mast").symlink_to(elsewhere)
        for agent in ("claude", "codex"):
            (setup.MAST / ("no-" + agent + "-hooks")).touch()
        (self.home / ".opencode").mkdir()
        return elsewhere

    def run_setup(self, args):
        # 앱과 `mast skill-load` 가 부르는 것과 같은 방식으로 스크립트 진입점을 실행한다.
        config = self.home / ".config"
        result = subprocess.run([sys.executable, "-I", str(ROOT / "scripts/macos/setup.py")] + args,
                                env=dict(os.environ, HOME=str(self.home), XDG_CONFIG_HOME=str(config)),
                                capture_output=True, text=True, timeout=30)
        return result.returncode, result.stderr, config / "opencode/plugins/mast.js"

    def test_timed_out_command_ends_even_if_a_detached_descendant_keeps_the_pipe(self):
        # 새 세션으로 빠져나간 손자는 killpg 에 걸리지 않고 출력 파이프를 계속 쥔다. 손자의
        # 수명(LIFETIME)은 판정 상한(LIMIT)보다 길어서, bounded_run 이 손자를 기다리면 실패한다.
        # 손자는 끝에서 직접 치우고, 치우지 못해도 LIFETIME 뒤에는 스스로 끝난다.
        LIMIT, LIFETIME = 5, 12
        detached = ("import os, sys, time; os.setsid(); "
                    "open(sys.argv[1], 'w').write(str(os.getpid())); time.sleep(float(sys.argv[2]))")
        with tempfile.TemporaryDirectory() as scratch:
            pid_file = Path(scratch) / "detached.pid"
            started = time.monotonic()
            try:
                with self.assertRaises(ValueError):
                    setup.bounded_run(["/bin/sh", "-c", '"$0" -c "$1" "$2" "$3" & sleep 30',
                                       sys.executable, detached, str(pid_file), str(LIFETIME)], 0.5)
                self.assertLess(time.monotonic() - started, LIMIT)
            finally:
                # 손자가 아직 살아 있을 시간 안에서만 신호를 보낸다 — 끝난 뒤의 PID 는 재사용될 수 있다.
                if pid_file.exists() and pid_file.read_text() and time.monotonic() - started < LIFETIME - 1:
                    with contextlib.suppress(ProcessLookupError):
                        os.kill(int(pid_file.read_text()), 9)

    def test_skill_failure_is_reported_and_agents_are_still_connected(self):
        elsewhere = self.symlinked_skill_home()
        code, stderr, plugin = self.run_setup([])
        self.assertNotEqual(code, 0)
        self.assertIn(str(self.home / ".claude/skills/mast"), stderr)
        self.assertEqual(plugin.read_text(), "// managed source")
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_skills_only_reports_failure_without_connecting_agents(self):
        elsewhere = self.symlinked_skill_home()
        code, stderr, plugin = self.run_setup(["--skills-only"])
        self.assertNotEqual(code, 0)
        self.assertIn(str(self.home / ".claude/skills/mast"), stderr)
        self.assertFalse(plugin.exists())
        self.assertEqual(list(elsewhere.iterdir()), [])

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


@unittest.skipUnless(sys.platform == "darwin", "the shell setting exists only on macOS")
class NativeConfig(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.settings = self.root / "settings.json"

    def tearDown(self):
        self.temp.cleanup()

    def config(self, *args):
        return subprocess.run([sys.executable, "-I", str(ROOT / "scripts/wsl/mast-config.py"), *args],
                              env=dict(os.environ, MAST_CONFIG_PATH=str(self.settings)),
                              capture_output=True, text=True, timeout=30)

    def saved(self):
        return json.loads(self.settings.read_text()) if self.settings.exists() else {}

    def test_set_shell_rejects_a_missing_or_non_executable_file(self):
        shells = self.root / "shells"
        shells.mkdir()
        missing = shells / "zsh"
        not_executable = shells / "bash"
        not_executable.write_text("#!/bin/sh\n")
        # 소유자 실행 비트가 없으면 group/other 실행 비트가 있어도 현재 사용자는 실행할 수 없다(root 는 예외).
        modes = [0o644] + ([0o655] if os.geteuid() != 0 else [])
        for path, mode in [(missing, None)] + [(not_executable, mode) for mode in modes]:
            with self.subTest(path=path.name, mode=mode):
                if mode is not None:
                    path.chmod(mode)
                result = self.config("set", "shell", str(path))
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("shell", self.saved())

    def test_set_shell_accepts_an_executable_symlink(self):
        link = self.root / "links/bash"
        link.parent.mkdir()
        link.symlink_to("/bin/bash")
        result = self.config("set", "shell", str(link))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.saved()["shell"], str(link))

    def test_a_deleted_saved_shell_can_still_be_reset_or_replaced(self):
        for recovery in (["reset", "shell"], ["set", "shell", "/bin/zsh"]):
            with self.subTest(recovery=recovery):
                self.settings.write_text(json.dumps({"shell": str(self.root / "removed/zsh"), "fontSize": 14}))
                result = self.config(*recovery)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = {"fontSize": 14} if recovery[0] == "reset" else {"fontSize": 14, "shell": "/bin/zsh"}
                self.assertEqual(self.saved(), expected)


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
