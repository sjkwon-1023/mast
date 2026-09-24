"""macOS agy 설정 연결과 공유 상태 훅을 검증한다."""
import contextlib
import io
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SYSTEM_COMMANDS = {name: shutil.which(name) for name in ("head", "cat")}


def load(name, path):
    import importlib.util

    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


setup = load("agy_setup", ROOT / "scripts/macos/setup.py")


class AgYSetup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mast-agy-")
        self.home = Path(self.temp.name)
        self.path = self.home / "path"
        self.path.mkdir()
        for name, source in SYSTEM_COMMANDS.items():
            if source:
                (self.path / name).symlink_to(source)

        real_candidates = setup.candidates

        def scoped_candidates(name):
            for candidate in real_candidates(name):
                try:
                    Path(candidate).resolve().relative_to(self.home.resolve())
                except ValueError:
                    continue
                yield candidate

        self.patchers = [
            patch.object(setup, "HOME", self.home),
            patch.object(setup, "MAST", self.home / ".mast"),
            patch.object(setup, "BIN", self.home / ".mast/bin"),
            patch.dict(os.environ, {"PATH": str(self.path)}),
            patch.object(setup, "candidates", scoped_candidates),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    @property
    def marker(self):
        return setup.MAST / (".setup-macos-v%s-agy" % setup.VERSION)

    @property
    def hooks(self):
        return self.home / ".gemini/config/hooks.json"

    def prepare_cli(self):
        (self.home / ".gemini/antigravity-cli").mkdir(parents=True, exist_ok=True)
        setup.BIN.mkdir(parents=True, exist_ok=True)

    def install_merger(self):
        setup.BIN.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "scripts/wsl/mast-hooks-merge.py", setup.BIN / "mast-hooks-merge.py")

    @staticmethod
    def write_executable(path, contents):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        path.chmod(0o700)
        return path

    def add_shell_agy(self, directory, version, exit_code=0):
        return self.write_executable(
            directory / "agy",
            "#!/bin/sh\nprintf '%s\\n' %s\nexit %d\n"
            % ("%s", shlex.quote("agy version " + version), exit_code),
        )

    def add_env_node_agy(self, directory, version):
        self.write_executable(directory / "node", "#!/bin/sh\nprintf '%s\\n' %s\n" % (
            "%s", shlex.quote("agy version " + version)))
        return self.write_executable(directory / "agy", "#!/usr/bin/env node\n")

    def run_connect_agy(self):
        errors = []
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            setup.connect_agy(errors)
        return output.getvalue(), errors

    def test_absent_agy_is_retried_after_install(self):
        self.install_merger()
        output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        self.assertFalse(self.marker.exists())
        self.assertFalse(self.hooks.exists())

        (self.home / ".gemini/antigravity-cli").mkdir(parents=True)
        self.add_shell_agy(self.path, "1.1.10")
        output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        self.assertTrue(self.marker.exists())
        self.assertIn('"mast"', self.hooks.read_text())

    def test_opt_out_finishes_only_agy_step(self):
        self.prepare_cli()
        (setup.MAST / "no-agy-hooks").parent.mkdir(parents=True, exist_ok=True)
        (setup.MAST / "no-agy-hooks").touch()
        with patch.object(setup, "bounded_run") as run:
            output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        self.assertTrue(self.marker.exists())
        self.assertFalse(self.hooks.exists())
        run.assert_not_called()

    def test_existing_agy_marker_skips_work(self):
        self.prepare_cli()
        self.marker.parent.mkdir(parents=True, exist_ok=True)
        self.marker.touch()
        with patch.object(setup, "bounded_run") as run:
            output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        self.assertFalse(self.hooks.exists())
        run.assert_not_called()

    def test_skills_only_does_not_connect_agy(self):
        self.prepare_cli()
        with patch.object(setup, "skills"), patch.object(setup, "connect_agents") as connect:
            self.assertEqual(setup.main(["--skills-only"]), 0)
        connect.assert_not_called()
        self.assertFalse(self.marker.exists())
        self.assertFalse(self.hooks.exists())

    def test_lowest_readable_version_warns_but_still_merges(self):
        self.prepare_cli()
        self.install_merger()
        self.add_env_node_agy(self.path, "1.2.0")
        local = self.home / ".local/bin"
        self.add_env_node_agy(local, "1.1.10")
        nvm = self.home / ".nvm/versions/node/v20/bin"
        low_path = self.add_env_node_agy(nvm, "1.1.9")
        unreadable = self.add_shell_agy(self.home / ".bun/bin", "unknown", exit_code=7)

        output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        self.assertTrue(self.marker.exists())
        self.assertIn("could not read version from %s" % unreadable, output)
        self.assertIn("1.1.9 at %s" % low_path, output)
        self.assertIn("its Stop hook may not run", output)
        self.assertIn('"mast"', self.hooks.read_text())

        self.marker.unlink()
        self.add_env_node_agy(self.path, "1.1.10")
        self.add_env_node_agy(local, "1.2.0")
        self.add_env_node_agy(nvm, "1.1.10")
        output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        self.assertNotIn("is below 1.1.10", output)

        self.marker.unlink()
        for path in (
            self.path / "agy",
            local / "agy",
            local / "node",
            nvm / "agy",
            nvm / "node",
        ):
            path.unlink()
        output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        self.assertIn("agy version unknown: no readable candidate", output)
        self.assertTrue(self.marker.exists())

    def test_merge_is_idempotent_and_preserves_user_hooks(self):
        self.prepare_cli()
        self.install_merger()
        self.add_shell_agy(self.path, "1.1.10")
        self.hooks.parent.mkdir(parents=True)
        self.hooks.write_text(json.dumps({
            "user-hook": {"PostInvocation": [{"type": "command", "command": "user-command"}]}
        }))

        output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        first = self.hooks.read_bytes()
        document = json.loads(first)
        self.assertIn("mast", document)
        self.assertEqual(document["user-hook"]["PostInvocation"][0]["command"], "user-command")

        self.marker.unlink()
        output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        self.assertEqual(self.hooks.read_bytes(), first)

        document["mast"]["enabled"] = False
        self.hooks.write_text(json.dumps(document))
        disabled = self.hooks.read_bytes()
        self.marker.unlink()
        output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        self.assertEqual(self.hooks.read_bytes(), disabled)
        self.assertFalse(json.loads(disabled)["mast"]["enabled"])
        self.assertEqual(json.loads(disabled)["user-hook"], document["user-hook"])

    def test_content_refusal_marks_step_and_io_failure_retries(self):
        self.prepare_cli()
        self.install_merger()
        self.add_shell_agy(self.path, "1.1.10")
        self.hooks.parent.mkdir(parents=True)
        original = b'{"broken":'
        self.hooks.write_bytes(original)

        output, errors = self.run_connect_agy()
        self.assertEqual(errors, [])
        self.assertEqual(self.hooks.read_bytes(), original)
        self.assertTrue(self.marker.exists())
        self.assertIn(b"completed after content refusal", self.marker.read_bytes())
        self.assertIn("left unchanged", output)
        self.assertIn(str(self.marker), output)
        self.assertIn("to retry Mast's agy integration", output)

        self.marker.unlink()
        self.write_executable(
            setup.BIN / "mast-hooks-merge.py",
            "import sys\nprint('injected helper failure')\nsys.exit(9)\n",
        )
        output, errors = self.run_connect_agy()
        self.assertEqual(len(errors), 1)
        self.assertIn("agy hooks were not merged (exit 9)", errors[0])
        self.assertIn("injected helper failure", output)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.hooks.read_bytes(), original)

    def test_agy_runs_after_another_agent_stage_fails(self):
        self.prepare_cli()
        self.install_merger()
        self.add_shell_agy(self.path, "1.1.10")
        (self.home / ".claude").mkdir()
        errors = []
        with patch.object(setup, "claude_dispatcher_supported", return_value=True), \
             patch.object(setup, "merge", side_effect=ValueError("bad Claude settings")):
            setup.connect_agents(errors)
        self.assertIn("claude: bad Claude settings", errors)
        self.assertTrue(self.marker.exists())
        self.assertIn('"mast"', self.hooks.read_text())


@unittest.skipUnless(sys.platform == "darwin", "requires the native macOS TTY fallback")
class AgYSharedHook(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mast-agy-hook-")
        self.home = Path(self.temp.name)
        self.bin = self.home / ".mast/bin"
        self.bin.mkdir(parents=True)
        shutil.copyfile(ROOT / "scripts/macos/notify.py", self.bin / "mast-notify.py")
        shutil.copyfile(ROOT / "scripts/wsl/mast-agent-hook.py", self.bin / "mast-agent-hook.py")
        shutil.copyfile(ROOT / "scripts/wsl/mast-agy-hook.sh", self.bin / "mast-agy-hook.sh")
        (self.bin / "mast-agy-hook.sh").chmod(0o700)
        (self.bin / "mast-python").write_text(sys.executable + "\n")
        wrapper = '''#!/bin/bash
[[ ${MAST:-} == 1 ]] || exit 0
py=
IFS= read -r py < "$HOME/.mast/bin/mast-python" 2>/dev/null || true
if [[ -n $py && -x $py ]]; then
  "$py" -I "$HOME/.mast/bin/mast-notify.py" "$@" >/dev/null 2>&1
fi
exit 0
'''
        (self.bin / "mast-notify.sh").write_text(wrapper)
        (self.bin / "mast-notify.sh").chmod(0o700)

    def tearDown(self):
        self.temp.cleanup()

    def run_hook(self, event, overrides=None):
        master, slave = os.openpty()
        environment = dict(os.environ, HOME=str(self.home), MAST="1", MAST_TTY=os.ttyname(slave))
        environment.pop("CLAUDECODE", None)
        environment.pop("CODEX_THREAD_ID", None)
        environment["PATH"] = os.pathsep.join(
            str(path) for path in (Path(SYSTEM_COMMANDS["head"]).parent, Path(SYSTEM_COMMANDS["cat"]).parent)
        ) if SYSTEM_COMMANDS["head"] and SYSTEM_COMMANDS["cat"] else environment.get("PATH", "")
        if overrides:
            for key, value in overrides.items():
                if value is None:
                    environment.pop(key, None)
                else:
                    environment[key] = value
        try:
            result = subprocess.run(
                ["/bin/bash", str(self.bin / "mast-agy-hook.sh"), event],
                input=b"{}",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=environment,
                timeout=10,
                start_new_session=True,
            )
            output = bytearray()
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], 0.05)
                if ready:
                    try:
                        output.extend(os.read(master, 4096))
                    except OSError:
                        break
                elif output:
                    break
            return result, bytes(output)
        finally:
            os.close(slave)
            os.close(master)

    def test_shared_agy_hook_reaches_native_tty(self):
        result, terminal = self.run_hook("running", {"MAST_TAB": "42"})
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        self.assertEqual(result.stdout, b"{}\n")
        self.assertEqual(terminal, b"\x1b]777;notify;mast:running;\x07")
        self.assertFalse((self.home / ".mast/resume").exists())

    def test_nested_or_non_mast_agy_emits_nothing(self):
        cases = [
            ("running", {"MAST_TAB": "42", "CLAUDECODE": "1"}),
            ("running", {"MAST_TAB": "42", "CODEX_THREAD_ID": "thread"}),
            ("running", {"MAST_TAB": "not-a-number"}),
            ("running", {"MAST_TAB": None}),
            ("needsInput", {"MAST_TAB": "42"}),
            ("running", {"MAST": None, "MAST_TAB": "42"}),
        ]
        for event, overrides in cases:
            with self.subTest(event=event, overrides=overrides):
                result, terminal = self.run_hook(event, overrides)
                self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
                self.assertEqual(result.stdout, b"{}\n")
                self.assertEqual(terminal, b"")
        self.assertFalse((self.home / ".mast/resume").exists())
