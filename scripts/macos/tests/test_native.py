"""네이티브 어댑터. 어느 호스트에서든 Python 3.11+ 로 실행한다(셸 테스트는 POSIX 필요)."""
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import shlex
import shutil
import signal
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

    def test_browser_hands_its_arguments_to_the_shared_browser_helper(self):
        with patch.object(cli.os, "execv") as execv:
            cli.main(["browser", "snapshot", "#42"])
        execv.assert_called_once_with(
            sys.executable,
            [sys.executable, str(cli.BIN / "mast-browser.py"), "snapshot", "#42"])

    def test_presentation_commands_hand_their_name_and_arguments_to_the_shared_helper(self):
        with patch.object(cli.os, "execv") as execv:
            cli.main(["open", "--pane", "3", "/x"])
        execv.assert_called_once_with(
            sys.executable,
            [sys.executable, str(cli.BIN / "mast-presentation.py"), "open", "--pane", "3", "/x"])

    def test_the_macos_bundle_ships_the_presentation_helper(self):
        source = (ROOT / "apps/mast/src-tauri/src/platform/macos.rs").read_text(encoding="utf-8")
        self.assertIn('asset!("bin/mast-presentation.py", "wsl/mast-presentation.py"),', source)


class NativeUpdate(unittest.TestCase):
    URL = "https://raw.githubusercontent.com/sjkwon-1023/mast/main/scripts/macos/install.sh"
    ENVIRONMENT = {"MAST_DOWNLOAD_URL": "https://example.invalid/mast.zip",
                   "MAST_REPO_URL": "https://example.invalid/repo",
                   "MAST_APP_DIR": "/Users/tester/Mast's $HOME"}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.handlers = {number: signal.getsignal(number) for number in (signal.SIGPIPE, signal.SIGXFSZ)}

    def tearDown(self):
        for number, handler in self.handlers.items():
            signal.signal(number, handler)
        self.temp.cleanup()

    def captured_update(self):
        with patch.object(cli.os, "execv") as execv:
            self.assertEqual(cli.main(["update"]), 0)
        execv.assert_called_once()
        return execv.call_args.args

    def run_captured(self, curl_body):
        # 가짜 curl 만 PATH 앞에 둔다. 실제 curl 과 설치기는 이 테스트에서 실행되지 않는다.
        bindir = self.root / "bin"
        bindir.mkdir()
        record = self.root / "curl-argv"
        curl = bindir / "curl"
        curl.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shlex.quote(str(record)) + "\n" + curl_body)
        curl.chmod(0o755)
        _, argv = self.captured_update()
        env = dict(os.environ, PATH=str(bindir) + os.pathsep + os.environ["PATH"], **self.ENVIRONMENT)
        result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=30)
        return result, record.read_text().splitlines()

    def test_update_runs_the_fixed_pipeline_in_system_bash(self):
        path, argv = self.captured_update()
        self.assertEqual(path, "/bin/bash")
        self.assertEqual(argv, ["/bin/bash", "-c", "set -o pipefail; curl -fsSL " + self.URL + " | /bin/bash"])

    def test_extra_arguments_exit_2_before_anything_runs(self):
        for extra in (["--help"], ["extra"], ["--", self.URL]):
            with self.subTest(extra=extra), patch.object(cli.os, "execv") as execv, \
                    contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(cli.main(["update", *extra]), 2)
            self.assertEqual(err.getvalue(), "usage: mast update\n")
            execv.assert_not_called()

    def test_start_failure_uses_the_generic_error_path(self):
        err = io.StringIO()
        with patch.object(sys, "argv", ["mast", "update"]), \
                patch.object(cli.os, "execv", side_effect=OSError("no /bin/bash")), \
                contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as exited:
                runpy.run_path(str(ROOT / "scripts/macos/mast.py"), run_name="__main__")
        self.assertEqual(exited.exception.code, 1)
        self.assertEqual(err.getvalue(), "mast: no /bin/bash\n")

    def test_update_needs_no_mast_tab_and_emits_no_osc(self):
        with patch.dict(os.environ), patch.object(cli, "emit") as emit:
            os.environ.pop("MAST_TAB", None)
            self.captured_update()
        emit.assert_not_called()

    def test_update_restores_the_default_signals_before_exec(self):
        seen = {}

        def record(path, argv):
            seen["handlers"] = [signal.getsignal(number) for number in (signal.SIGPIPE, signal.SIGXFSZ)]

        with patch.object(cli.os, "execv", side_effect=record):
            cli.main(["update"])
        self.assertEqual(seen["handlers"], [signal.SIG_DFL, signal.SIG_DFL])

    def test_a_failed_download_is_not_hidden_by_the_empty_installer_run(self):
        result, _ = self.run_captured("exit 22\n")
        self.assertEqual(result.returncode, 22)

    def test_installer_exit_code_and_output_pass_through_unchanged(self):
        installer = ("printf 'installer %s|%s|%s\\n' \"$MAST_DOWNLOAD_URL\" \"$MAST_REPO_URL\" \"$MAST_APP_DIR\"\n"
                     "printf 'installer stderr\\n' >&2\n"
                     "exit 23\n")
        result, record = self.run_captured("cat <<'INSTALLER'\n" + installer + "INSTALLER\n")
        self.assertEqual(record, ["-fsSL", self.URL])
        self.assertEqual(result.returncode, 23)
        self.assertEqual(result.stdout, "installer https://example.invalid/mast.zip|https://example.invalid/repo|"
                                        "/Users/tester/Mast's $HOME\n")
        self.assertEqual(result.stderr, "installer stderr\n")

    def test_successful_download_and_installer_exit_zero(self):
        result, _ = self.run_captured("cat <<'INSTALLER'\nprintf 'installed\\n'\nINSTALLER\n")
        self.assertEqual((result.returncode, result.stdout), (0, "installed\n"))


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

    def test_mac_option_is_meta_is_saved_as_a_boolean_and_reset(self):
        self.settings.write_text(json.dumps({"fontSize": 14}))
        result = self.config("set", "macOptionIsMeta", "true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.saved(), {"fontSize": 14, "macOptionIsMeta": True})
        for bad in ("yes", "1", "True"):
            with self.subTest(value=bad):
                result = self.config("set", "macOptionIsMeta", bad)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.saved()["macOptionIsMeta"], True)
        result = self.config("reset", "macOptionIsMeta")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.saved(), {"fontSize": 14})

    def test_a_non_boolean_mac_option_is_meta_in_the_file_is_reported(self):
        self.settings.write_text(json.dumps({"macOptionIsMeta": "yes"}))
        result = self.config("get")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("macOptionIsMeta", result.stderr)

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
                                 ("cli", ("confirmed", True)), ("vscode", ("confirmed", True)),
                                 ("appServer", ("confirmed", False))]:
            path.write_text(json.dumps({"type": "session_meta", "payload": {"id": "thread", "source": source}}) + "\n")
            with patch.dict(os.environ, {"CODEX_HOME": str(self.root / ".codex")}):
                self.assertEqual(self.notify.ownership("thread"), expected)

    def test_prompt_generation_is_the_third_line_only_when_well_formed(self):
        path = self.root / ".mast/resume/tab-42"
        for generation, lines in [(None, 2), ("", 2), ("gen_1-A", 3), ("g" * 128, 3), ("g" * 129, 2),
                                  ("gen 1", 2), ("gen;1", 2), ("gen$1", 2), ("gen\n1", 2)]:
            with patch.dict(os.environ):
                os.environ.pop("MAST_PROMPT_GEN", None)
                if generation is not None:
                    os.environ["MAST_PROMPT_GEN"] = generation
                self.notify.save_resume("claude --resume", "safe-id")
            with self.subTest(generation=generation):
                written = path.read_text().splitlines()
                self.assertEqual(len(written), lines)
                self.assertEqual(written[0], "claude --resume safe-id")
                if lines == 3:
                    self.assertEqual(written[2], generation)


if __name__ == "__main__":
    unittest.main()
