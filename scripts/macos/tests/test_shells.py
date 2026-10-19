"""배포되는 시작 파일을 실제 PTY 와 실제 zsh/bash 로 실행해 본다.

macOS 는 `scripts/macos/launch.sh`, Linux 는 WSL 래퍼 본문 `scripts/wsl/launch.sh` 를 `bash -c` 인자 계약
그대로 실행한다. zsh 시작 파일 자체의 계약은 macOS 사례가 보고, WSL 사례는 래퍼의 셸 선택·fallback·cwd 전달만 본다.
"""
import contextlib
import errno
import fcntl
import importlib.util
import io
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import urllib.parse

ROOT = Path(__file__).resolve().parents[3]
PROMPT = b"MAST_READY> "
START_MARK = b"\x1b]777;mast-started\x07"
# zsh 와 bash 는 서로의 버전 변수를 정의하지 않으므로 실제로 도는 셸을 이것으로 가린다.
KIND_PROBE = 'printf "KIND:%s\\n" "${BASH_VERSION:+bash}${ZSH_VERSION:+zsh}"'
ZSH_NOT_INSTALLED = (
    "[mast] zsh integration is not installed yet; this tab starts without it. Once setup finishes, exit it and press Restart"
)
# (scripts/macos 의 원본, ~/.mast/shell 아래 설치 위치). WSL 에 설치되는 zsh 통합 자산 여섯 개다.
ZSH_ASSETS = [
    ("integration.sh", "integration.sh"),
    ("zsh-integration.zsh", "zsh-integration.zsh"),
    ("zshenv", "zsh/.zshenv"),
    ("zprofile", "zsh/.zprofile"),
    ("zshrc", "zsh/.zshrc"),
    ("zlogin", "zsh/.zlogin"),
]


class PtyShell(unittest.TestCase):
    """PTY 에 셸을 띄우고 출력을 기다린다. launcher 명령은 플랫폼 하위 클래스가 `command` 로 정한다."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mast-shell-")
        self.home = Path(self.temp.name)
        self.shell_dir = self.home / ".mast/shell"
        self.cwd = self.home / "project ' 한글:$(not-executed)"
        self.cwd.mkdir()
        self.pid = self.fd = None
        self.output = b""

    def tearDown(self):
        self.kill()
        self.temp.cleanup()

    def command(self, shell, tab, cwd):
        """(argv, 환경 덮어쓰기) 를 돌려준다. 값이 None 인 환경 변수는 지운다."""
        raise NotImplementedError

    def env(self, zdotdir=None, **overrides):
        env = dict(os.environ, HOME=str(self.home), PS1="MAST_READY> ")
        env.pop("ZDOTDIR", None)
        if zdotdir:
            env["ZDOTDIR"] = str(zdotdir)
        for name, value in overrides.items():
            if value is None:
                env.pop(name, None)
            else:
                env[name] = value
        return env

    def kill(self):
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
            self.pid = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def spawn(self, argv, env):
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(self.home)  # wsl.exe --cd ~ 과 같이 홈에서 시작한다.
                os.execve(argv[0], argv, env)
            finally:
                os._exit(127)
        self.pid, self.fd = pid, fd

    def begin(self, shell, tab="42", zdotdir=None, cwd=None, **env):
        argv, overrides = self.command(shell, tab, str(cwd or self.cwd))
        overrides.update(env)
        self.kill()
        self.output = b""
        self.spawn(argv, self.env(zdotdir, **overrides))

    def start(self, shell, tab="42", zdotdir=None, cwd=None, **env):
        self.begin(shell, tab, zdotdir, cwd, **env)
        self.read_until(PROMPT)

    def start_expect_exit(self, shell, tab="42", cwd=None, **env):
        self.begin(shell, tab, None, cwd, **env)
        return self.wait_exit("launcher did not exit")

    def read_until(self, token, count=1):
        deadline = time.monotonic() + 10
        while self.output.count(token) < count:
            self.assertLess(time.monotonic(), deadline, self.output.decode("utf-8", "replace"))
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        chunk = b""
                    else:
                        raise
                self.assertTrue(chunk, self.output.decode("utf-8", "replace"))
                self.output += chunk

    def drain(self):
        while select.select([self.fd], [], [], 0.05)[0]:
            try:
                chunk = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            if not chunk:
                return
            self.output += chunk

    def send(self, command):
        before = self.output.count(PROMPT)
        os.write(self.fd, (command + "\n").encode())
        self.read_until(PROMPT, before + 1)

    def finish(self, command=""):
        os.write(self.fd, (command + "\nexit\n").encode())
        return self.wait_exit("shell did not exit")

    def wait_exit(self, message):
        deadline = time.monotonic() + 10
        while True:
            self.assertLess(time.monotonic(), deadline, message)
            self.drain()
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.drain()
                self.pid = None
                return os.waitstatus_to_exitcode(status)

    def zsh_profile(self, directory):
        for name in (".zshenv", ".zprofile", ".zshrc", ".zlogin"):
            text = 'printf "%s\\n" "%s" >> "$HOME/loaded"\n' % ("%s", name)
            if name == ".zshrc":
                text += "PROMPT='MAST_READY> '\n"
            (directory / name).write_text(text)

    def install_zsh_assets(self):
        for source, target in ZSH_ASSETS:
            path = self.shell_dir / target
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.is_dir():
                shutil.rmtree(path)
            shutil.copyfile(ROOT / "scripts/macos" / source, path)

    def cwd_reports(self):
        """출력된 OSC 7 경로를 percent 디코드해 돌려준다. 왕복이 무손실인지 보려고 디코드한다."""
        return [urllib.parse.unquote_to_bytes(path).decode("utf-8")
                for path in re.findall(rb"\x1b\]7;file://([^\x07\x1b]*)\x07", self.output)]


# 자동 재실행의 인터프리터 대역. 실제 helper 를 그대로 실행하고 부하만 MAST_TEST_LOAD 로 바꾼다.
# "error" 는 부하 조회 실패(건너뜀), 숫자는 그 부하다. 부하가 높으면 helper 는 허가 전까지 대기한다.
LOAD_PATCH = '''import os, runpy, sys
load = os.environ.get("MAST_TEST_LOAD", "0")
if load == "error":
    def unavailable():
        raise OSError("load average unavailable")
    os.getloadavg = unavailable
else:
    os.getloadavg = lambda: (float(load),) * 3
args = sys.argv[1:]
if args[:1] == ["-I"]:
    args = args[1:]
sys.argv = args
runpy.run_path(args[0], run_name="__main__")
'''
# 에이전트 대역: 받은 인자와 실행 시점의 세대를 기록하고 바로 끝난다.
AGENT_FIXTURE = '#!/bin/sh\nprintf "NAME %s gen=%s\\n" "$*" "$MAST_PROMPT_GEN" >> "$HOME/agent-log"\n'


class AutoResumeCases:
    """자동 재실행의 판정·실행·정상 복귀를 실제 PTY 에서 본다. 플랫폼 클래스가 launcher 와 history 파일 이름을 정한다."""

    auto = ""
    bash_history = "tab-42"
    SHELLS = ("/bin/bash", "/bin/zsh")
    HINT = "claude --resume tok-2"

    def prepare(self):
        bin_dir = self.home / ".mast/bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(AUTO_RESUME, bin_dir / "mast-auto-resume.py")
        (bin_dir / "load_patch.py").write_text(LOAD_PATCH)
        interpreter = bin_dir / "mast-test-python"
        interpreter.write_text('#!/bin/sh\nexec "%s" -I "%s" "$@"\n' % (sys.executable, bin_dir / "load_patch.py"))
        interpreter.chmod(0o755)
        (bin_dir / "mast-python").write_text(str(interpreter) + "\n")
        for agent in ("claude", "codex", "opencode"):
            (bin_dir / agent).write_text(AGENT_FIXTURE.replace("NAME", agent))
            (bin_dir / agent).chmod(0o755)
        self.zsh_profile(self.home)
        (self.home / ".bashrc").write_text('PS1="MAST_READY> "\n')

    def reset(self):
        """이전 사례의 세대·hint·history·대기열 잠금을 지운다. 설치된 셸 자산과 대역은 그대로 둔다."""
        for name in (".mast/prompt", ".mast/resume", ".mast/history"):
            shutil.rmtree(self.home / name, ignore_errors=True)
        for name in ("agent-log", ".mast/auto-resume.lock"):
            (self.home / name).unlink(missing_ok=True)

    def write_state(self, hint, prompt):
        """hint 와 prompt 는 파일 내용이다. None 이면 그 파일을 만들지 않는다."""
        if prompt is not None:
            (self.home / ".mast/prompt").mkdir(parents=True, exist_ok=True)
            (self.home / ".mast/prompt/tab-42").write_text(prompt + "\n")
        if hint is not None:
            (self.home / ".mast/resume").mkdir(parents=True, exist_ok=True)
            (self.home / ".mast/resume/tab-42").write_text(hint)

    def generation(self):
        return (self.home / ".mast/prompt/tab-42").read_text().rstrip("\n")

    def agent_log(self):
        log = self.home / "agent-log"
        return log.read_text().splitlines() if log.exists() else []

    def history_text(self, shell):
        name = "zsh-tab-42" if shell.endswith("zsh") else self.bash_history
        return (self.home / ".mast/history" / name).read_text()

    def test_auto_resume_off_offers_the_hint_and_never_runs_it(self):
        self.prepare()
        for shell in self.SHELLS:
            with self.subTest(shell=shell):
                self.reset()
                self.write_state(self.HINT + "\n1\nold-1\n", "old-1")
                self.auto = ""
                self.start(shell)
                # 꺼져 있어도 세대는 기록한다. 나중에 켰을 때 첫 부팅부터 판정하려는 것이다.
                self.assertRegex(self.generation(), r"^\d+-\d+-1$")
                self.finish()
                self.assertIn(("resume previous agent: %s" % self.HINT).encode(), self.output)
                self.assertNotIn(b"auto-resume", self.output)
                self.assertEqual(self.agent_log(), [])

    def test_auto_resume_runs_a_matching_hint_once_and_records_new_generations(self):
        self.prepare()
        self.auto = "1"
        for shell in self.SHELLS:
            with self.subTest(shell=shell):
                self.reset()
                self.write_state(self.HINT + "\n1\nold-1\n", "old-1")
                self.start(shell)
                log = self.agent_log()
                self.assertEqual(len(log), 1)
                self.assertRegex(log[0], r"^claude --resume tok-2 gen=\d+-\d+-1$")
                # 실행 뒤 G2 가 기록돼야 같은 후보가 다음 부팅에서 다시 잡히지 않는다.
                nonce = log[0].split("gen=")[1].rsplit("-", 1)[0]
                self.assertEqual(self.generation(), nonce + "-2")
                self.assertIn(b"[mast] auto-resume: claude --resume tok-2", self.output)
                self.assertNotIn(b"resume previous agent", self.output)
                self.finish()
                self.assertEqual(self.history_text(shell).count(self.HINT), 1)

    def test_a_run_that_exits_normally_is_not_offered_to_run_again(self):
        self.prepare()
        self.auto = "1"
        for shell in self.SHELLS:
            with self.subTest(shell=shell):
                self.reset()
                self.write_state(self.HINT + "\n1\nold-1\n", "old-1")
                self.start(shell)
                self.finish()
                self.start(shell)
                self.finish()
                self.assertEqual(len(self.agent_log()), 1)
                self.assertNotIn(b"auto-resume:", self.output)

    def test_a_candidate_that_does_not_match_only_leaves_the_manual_hint(self):
        self.prepare()
        self.auto = "1"
        cases = {
            "two-line hint from an older writer": (self.HINT + "\n1\n", "old-1"),
            "other generation": (self.HINT + "\n1\nother-9\n", "old-1"),
            "no prompt file": (self.HINT + "\n1\nold-1\n", None),
            "extra line": (self.HINT + "\n1\nold-1\nextra\n", "old-1"),
        }
        for case, (hint, prompt) in cases.items():
            for shell in self.SHELLS:
                with self.subTest(case=case, shell=shell):
                    self.reset()
                    self.write_state(hint, prompt)
                    self.start(shell)
                    self.finish()
                    self.assertEqual(self.agent_log(), [])
                    self.assertIn(("resume previous agent: %s" % self.HINT).encode(), self.output)

    def test_forbidden_or_oversized_candidates_are_never_run(self):
        self.prepare()
        self.auto = "1"
        cases = {
            "metacharacter token": "claude --resume bad;touch PWNED\n1\nold-1\n",
            "command outside the three forms": "touch PWNED\n1\nold-1\n",
            "control character in token": "claude --resume ok\x07id\n1\nold-1\n",
            "token of 97 characters": "claude --resume %s\n1\nold-1\n" % ("a" * 97),
            "stamp that is not digits": self.HINT + "\nnow\nold-1\n",
        }
        for case, hint in cases.items():
            for shell in self.SHELLS:
                with self.subTest(case=case, shell=shell):
                    self.reset()
                    self.write_state(hint, "old-1")
                    self.start(shell)
                    self.finish()
                    self.assertEqual(self.agent_log(), [])
                    self.assertFalse((self.home / "PWNED").exists())
        # 경계: 96 자 token 은 허용된다.
        for shell in self.SHELLS:
            with self.subTest(case="token of 96 characters", shell=shell):
                self.reset()
                self.write_state("claude --resume %s\n1\nold-1\n" % ("a" * 96), "old-1")
                self.start(shell)
                self.finish()
                self.assertEqual(len(self.agent_log()), 1)

    def test_a_symlinked_hint_file_is_never_run(self):
        self.prepare()
        self.auto = "1"
        for shell in self.SHELLS:
            with self.subTest(shell=shell):
                self.reset()
                real = self.home / "real-hint"
                real.write_text(self.HINT + "\n1\nold-1\n")
                (self.home / ".mast/resume").mkdir(parents=True)
                (self.home / ".mast/resume/tab-42").symlink_to(real)
                self.write_state(None, "old-1")
                self.start(shell)
                self.finish()
                self.assertEqual(self.agent_log(), [])

    def test_helper_skip_and_cancel_return_to_the_prompt(self):
        self.prepare()
        self.auto = "1"
        for shell in self.SHELLS:
            with self.subTest(shell=shell, case="skip"):
                self.reset()
                self.write_state(self.HINT + "\n1\nold-1\n", "old-1")
                self.start(shell, MAST_TEST_LOAD="error")
                self.assertIn(b"[mast] auto-resume skipped: load average unavailable", self.output)
                self.assertIn(("resume previous agent: %s" % self.HINT).encode(), self.output)
                self.finish()
                self.assertEqual(self.agent_log(), [])
                self.assertNotEqual(self.generation(), "old-1")
            with self.subTest(shell=shell, case="cancel"):
                self.reset()
                self.write_state(self.HINT + "\n1\nold-1\n", "old-1")
                self.begin(shell, MAST_TEST_LOAD="1000")
                self.read_until(b"auto-resume queued")
                os.write(self.fd, b"\x03")
                self.read_until(PROMPT)
                self.assertIn(b"[mast] auto-resume cancelled", self.output)
                self.assertIn(("resume previous agent: %s" % self.HINT).encode(), self.output)
                self.finish()
                self.assertEqual(self.agent_log(), [])

    def test_nested_shells_neither_record_a_generation_nor_run_a_hint(self):
        self.prepare()
        self.auto = "1"
        for shell, nested in (("/bin/bash", "bash"), ("/bin/zsh", "zsh")):
            with self.subTest(shell=shell):
                self.reset()
                self.start(shell)  # 후보가 없으므로 이 셸은 세대만 올린다.
                root = self.generation()
                # 루트의 현재 세대와 맞는 hint 를 두고, 중첩 셸이 그것을 실행하지 않는지 본다.
                self.write_state("%s\n1\n%s\n" % (self.HINT, root), None)
                self.send(nested)
                self.send('printf "NESTED:%s|%s\\n" "$MAST_PROMPT_GEN" "$(< $HOME/.mast/prompt/tab-42)"')
                self.send("exit")
                self.assertIn(("NESTED:%s|%s" % (root, root)).encode(), self.output)
                self.assertNotIn(b"[mast] auto-resume:", self.output)
                self.assertEqual(self.agent_log(), [])
                self.finish()


@unittest.skipUnless(sys.platform == "darwin", "requires native macOS startup files and zsh")
class ShellStartup(AutoResumeCases, PtyShell):
    bash_history = "bash-tab-42"

    def setUp(self):
        super().setUp()
        self.shell_dir.mkdir(parents=True)
        for name in ("launch.sh", "integration.sh", "bashrc", "zsh-integration.zsh"):
            shutil.copyfile(ROOT / "scripts/macos" / name, self.shell_dir / name)
        (self.shell_dir / "zsh").mkdir()
        for name in ("zshenv", "zprofile", "zshrc", "zlogin"):
            shutil.copyfile(ROOT / "scripts/macos" / name, self.shell_dir / "zsh" / ("." + name))

    def command(self, shell, tab, cwd):
        argv = ["/bin/bash", str(self.shell_dir / "launch.sh"), shell, tab, cwd, str(self.home / "settings.json"),
                self.auto]
        return argv, {}

    def test_zsh_loads_user_startup_once_and_restores_custom_zdotdir(self):
        custom = self.home / "custom config"
        custom.mkdir()
        self.zsh_profile(custom)
        originals = {path: path.read_bytes() for path in custom.iterdir()}
        self.start("/bin/zsh", zdotdir=custom)
        self.finish("printf 'SHELL_RESULT:%s|%s|%s\\n' \"$ZDOTDIR\" \"$MAST_TAB\" \"$PWD\"")
        self.assertEqual((self.home / "loaded").read_text().splitlines(), [".zshenv", ".zprofile", ".zshrc", ".zlogin"])
        self.assertIn(("SHELL_RESULT:%s|42|%s" % (custom, self.cwd)).encode(), self.output)
        self.assertIn(b"\x1b]777;mast-started\x07", self.output)
        self.assertIn(b"\x1b]7;file://", self.output)
        self.assertTrue(all(path.read_bytes() == content for path, content in originals.items()))

    def test_zsh_restores_the_user_zdotdir_when_unset_or_changed_by_an_earlier_file(self):
        changed = self.home / "changed config"
        changed.mkdir()
        self.zsh_profile(changed)
        for case in ("unset", "changed"):
            with self.subTest(case=case):
                (self.home / "loaded").unlink(missing_ok=True)
                if case == "unset":
                    self.zsh_profile(self.home)
                    expected = "unset"
                else:
                    # 앞선 시작 파일이 ZDOTDIR 을 바꾸면 mast 래퍼가 그 값을 끝까지 따라가야 한다.
                    self.zsh_profile(self.home)
                    (self.home / ".zshenv").write_text(
                        'export ZDOTDIR="%s"\nprintf "%%s\\n" ".zshenv" >> "$HOME/loaded"\n' % changed
                    )
                    expected = str(changed)
                self.start("/bin/zsh")
                self.finish("printf 'ZD:%s\\n' \"${ZDOTDIR-unset}\"")
                self.assertIn(("ZD:%s" % expected).encode(), self.output)
                self.assertEqual((self.home / "loaded").read_text().splitlines(),
                                 [".zshenv", ".zprofile", ".zshrc", ".zlogin"])

    def test_zsh_resume_is_a_history_hint_not_execution(self):
        self.zsh_profile(self.home)
        resume = self.home / ".mast/resume"
        resume.mkdir()
        (resume / "tab-42").write_text("claude --resume saved-id\n1\n")
        self.start("/bin/zsh")
        self.finish("fc -ln -10; printf 'HISTORY_FILE:%s\\n' \"$HISTFILE\"")
        self.assertIn(b"resume previous agent: claude --resume saved-id", self.output)
        self.assertNotIn(b"command not found: claude", self.output)
        self.assertIn(b"zsh-tab-42", self.output)
        self.assertFalse((self.home / ".zsh_history").exists())

    def test_zsh_resume_is_the_newest_entry_over_saved_history(self):
        # zsh 는 시작 파일 뒤에 HISTFILE 을 다시 읽는다 — 그 전에 넣은 resume 줄은 저장된
        # 명령 뒤로 밀려 첫 Up 에 나오지 않았다.
        self.zsh_profile(self.home)
        history = self.home / ".mast/history"
        history.mkdir(parents=True)
        (history / "zsh-tab-42").write_text("echo older-command\n")
        resume = self.home / ".mast/resume"
        resume.mkdir()
        (resume / "tab-42").write_text("claude --resume saved-id\n1\n")
        self.start("/bin/zsh")
        self.finish("fc -ln -1 | sed 's/^/LAST:/'")
        self.assertIn(b"LAST:claude --resume saved-id", self.output)

    def test_zsh_resume_hint_for_each_supported_agent_is_the_newest_entry(self):
        self.zsh_profile(self.home)
        resume = self.home / ".mast/resume"
        resume.mkdir(parents=True)
        for hint in ("claude --resume claude-id", "codex resume codex-id", "opencode --session open_id"):
            with self.subTest(hint=hint):
                (resume / "tab-42").write_text(hint + "\n1\n")
                self.start("/bin/zsh")
                self.finish("fc -ln -1 | sed 's/^/LAST:/'")
                self.assertEqual(self.output.count(("resume previous agent: %s" % hint).encode()), 1)
                self.assertIn(b"LAST:" + hint.encode(), self.output)

    def test_zsh_loads_saved_history_once_and_keeps_the_user_history_apart(self):
        (self.home / ".zsh_history").write_text("echo global\n")
        (self.home / ".zshrc").write_text(
            "HISTFILE=$HOME/.zsh_history\nSAVEHIST=100\nHISTSIZE=100\nfc -R\nPROMPT='MAST_READY> '\n"
        )
        history = self.home / ".mast/history"
        history.mkdir(parents=True)
        (history / "zsh-tab-42").write_text("echo saved-a\necho saved-b\n")
        self.start("/bin/zsh")
        self.finish("fc -ln 1 | sed 's/^/HIST:/'")
        self.assertEqual(self.output.count(b"HIST:echo saved-a"), 1)
        self.assertEqual(self.output.count(b"HIST:echo saved-b"), 1)
        self.assertNotIn(b"HIST:echo global", self.output)
        self.assertEqual((self.home / ".zsh_history").read_text(), "echo global\n")

    def test_zsh_resume_saved_while_the_shell_runs_reaches_history_at_next_prompt(self):
        self.zsh_profile(self.home)
        self.start("/bin/zsh")
        resume = self.home / ".mast/resume"
        resume.mkdir(parents=True)
        (resume / "tab-42").write_text("claude --resume live-id\n2\n")
        self.finish("true\nfc -ln -3 | sed 's/^/HIST:/'")
        self.assertIn(b"HIST:claude --resume live-id", self.output)
        self.assertNotIn(b"resume previous agent", self.output)

    def test_zsh_changed_resume_hint_is_added_once_per_command_and_time(self):
        self.zsh_profile(self.home)
        resume = self.home / ".mast/resume"
        resume.mkdir(parents=True)
        self.start("/bin/zsh")
        (resume / "tab-42").write_text("claude --resume live-id\n2\n")
        self.send("true")
        self.send("true")
        (resume / "tab-42").write_text("claude --resume live-id\n2\n")  # 같은 (명령, 시각): 다시 넣지 않는다.
        self.send("true")
        (resume / "tab-42").write_text("codex resume next-id\n3\n")
        self.send("true")
        self.finish("fc -ln 1 | sed -n 's/^/HIST:/p'")
        self.assertEqual(self.output.count(b"HIST:claude --resume live-id"), 1)
        self.assertEqual(self.output.count(b"HIST:codex resume next-id"), 1)
        self.assertNotIn(b"resume previous agent", self.output)

    def test_zsh_invalid_resume_hints_stay_out_of_history_and_are_never_run(self):
        self.zsh_profile(self.home)
        resume = self.home / ".mast/resume"
        resume.mkdir(parents=True)
        for hint in ("claude --resume bad;touch PWNED", "claude --resume ok\x07id", "rm -rf nothing", ""):
            with self.subTest(hint=hint):
                (resume / "tab-42").write_text(hint + "\n1\n")
                self.start("/bin/zsh")
                self.finish("fc -ln 1 | sed 's/^/HIST:/'")
                self.assertNotIn(b"resume previous agent", self.output)
                self.assertNotIn(b"HIST:rm -rf", self.output)
                self.assertNotIn(b"HIST:claude --resume bad", self.output)
                self.assertNotIn(b"HIST:claude --resume ok", self.output)
                self.assertFalse((self.home / "PWNED").exists())

    def test_zsh_tab_history_is_read_for_its_own_tab_only(self):
        self.zsh_profile(self.home)
        history = self.home / ".mast/history"
        history.mkdir(parents=True)
        (history / "zsh-tab-7").write_text("echo other-tab-7\n")
        self.start("/bin/zsh")
        self.finish("echo kept-in-tab-42")
        self.start("/bin/zsh")
        self.finish("fc -ln 1 | sed 's/^/HIST:/'")
        self.assertIn(b"HIST:echo kept-in-tab-42", self.output)
        self.assertNotIn(b"HIST:echo other-tab-7", self.output)
        self.assertEqual((history / "zsh-tab-42").read_text().count("echo kept-in-tab-42"), 1)

    def test_zsh_reports_cwd_on_start_and_cd_and_keeps_the_user_precmd_hook(self):
        (self.home / ".zshrc").write_text(
            "PROMPT='MAST_READY> '\n"
            "theme_hook() { print -r -- THEME_HOOK; }\n"
            "precmd_functions+=(theme_hook)\n"
        )
        sub = self.home / "sub dir"
        sub.mkdir()
        self.start("/bin/zsh")
        self.send('cd "%s"' % sub)
        self.finish()
        reports = self.cwd_reports()
        self.assertEqual(reports[0], str(self.cwd))
        self.assertEqual(reports[-1], str(sub))
        self.assertGreaterEqual(self.output.count(b"THEME_HOOK"), 2)
        self.assertTrue(self.output.startswith(START_MARK))

    def test_zsh_startup_never_reads_the_bash_profile(self):
        # 현장의 `.profile` 이 zsh 로 바꾸는 우회 구문. bash 로그인이라면 이 파일이 읽혀 목록이 달라진다.
        (self.home / ".bash_profile").unlink(missing_ok=True)
        (self.home / ".profile").write_text('printf "profile\\n" >> "$HOME/loaded"\nexec /bin/zsh -l\n')
        self.zsh_profile(self.home)
        self.start("/bin/zsh")
        self.finish()
        self.assertEqual((self.home / "loaded").read_text().splitlines(), [".zshenv", ".zprofile", ".zshrc", ".zlogin"])

    def test_zsh_cwd_report_does_not_change_path_while_it_runs(self):
        # local 변수는 함수가 끝나면 복원되므로, 함수 안의 각 명령 직전에 PATH 를 기록해 실행 도중을 본다.
        script = r'''
source "$1"
original=$PATH
seen=()
trap '[[ ${funcstack[1]-} == _mast_cwd ]] && seen+=("$PATH")' DEBUG
_mast_cwd
trap - DEBUG
print -rN -- "$original" "${seen[@]}"
'''
        result = subprocess.run(["/bin/zsh", "-f", "-c", script, "zsh", str(self.shell_dir / "integration.sh")],
                                cwd=self.cwd, env=dict(os.environ, HOME=str(self.home), PWD=str(self.cwd)),
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        report, _, rest = result.stdout.partition(b"\x07")
        original, *seen = rest.split(b"\0")[:-1]
        self.assertTrue(seen, "the DEBUG trap did not observe commands inside _mast_cwd")
        self.assertEqual(set(seen), {original})
        self.assertEqual(report, b"\x1b]7;file://" + str(self.cwd).replace(" ", "%20").encode())

    def test_bash_resume_saved_while_the_shell_runs_reaches_history_at_next_prompt(self):
        (self.home / ".bashrc").write_text('PS1="MAST_READY> "\n')
        self.start("/bin/bash")
        resume = self.home / ".mast/resume"
        resume.mkdir(parents=True)
        (resume / "tab-42").write_text("codex resume live-id\n2\n")
        self.finish("true\nhistory 3 | sed 's/^/HIST:/'")
        self.assertRegex(self.output, rb"HIST: *\d+ +codex resume live-id")
        self.assertNotIn(b"resume previous agent", self.output)

    def test_bash_profile_is_not_sourced_twice_and_history_is_per_tab(self):
        (self.home / ".bash_profile").write_text('printf "profile\\n" >> "$HOME/loaded"\nsource "$HOME/.bashrc"\n')
        (self.home / ".bashrc").write_text('printf "rc\\n" >> "$HOME/loaded"\nPS1="MAST_READY> "\n')
        self.start("/bin/bash")
        self.finish("echo native-history-entry")
        self.assertEqual((self.home / "loaded").read_text().splitlines(), ["profile", "rc"])
        history = (self.home / ".mast/history/bash-tab-42").read_text()
        self.assertIn("echo native-history-entry", history)
        self.assertFalse((self.home / ".bash_history").exists())

    def test_missing_saved_directory_falls_back_to_home(self):
        (self.home / ".bashrc").write_text('PS1="MAST_READY> "\n')
        self.start("/bin/bash", cwd=self.home / "deleted")
        self.finish("printf 'FALLBACK:%s\\n' \"$PWD\"")
        self.assertIn(("FALLBACK:" + str(self.home)).encode(), self.output)
        self.assertIn(b"saved directory is unavailable", self.output)


@unittest.skipUnless(sys.platform.startswith("linux"), "the WSL launcher runs on Linux")
class WslShellStartup(AutoResumeCases, PtyShell):
    bash_history = "tab-42"

    @classmethod
    def setUpClass(cls):
        missing = [tool for tool in ("bash", "zsh", "python3") if shutil.which(tool) is None]
        if missing:
            raise AssertionError("WSL launcher tests need on PATH: " + ", ".join(missing))

    def setUp(self):
        super().setUp()
        self.install_zsh_assets()
        # Ubuntu 의 /etc/bash.bashrc 가 env PS1 을 덮으므로 프롬프트는 fixture 의 .bashrc 가 정한다.
        (self.home / ".bashrc").write_text('printf "rc\\n" >> "$HOME/loaded"\nPS1="MAST_READY> "\n')
        (self.home / ".bash_profile").write_text(
            'printf "profile\\n" >> "$HOME/loaded"\nsource "$HOME/.bashrc"\n'
        )

    def command(self, shell, tab, cwd):
        body = (ROOT / "scripts/wsl/launch.sh").read_text(encoding="utf-8")
        # wsl.exe 가 $SHELL 을 물려주는 것과 같다. PS1 은 물려주지 않는다. Ubuntu 의 /etc/zsh/zshrc 전역
        # compinit 은 CI 러너의 fpath 권한 때문에 y/n 질문에서 멈추고 래퍼와 무관하므로 끈다.
        return (["/bin/bash", "-c", body, "mast-wsl", tab, cwd, self.auto],
                {"SHELL": shell, "PS1": None, "skip_global_compinit": "1"})

    def test_bash_login_shell_reports_cwd_and_keeps_tab_env_and_theme_hook(self):
        sub = self.home / "sub dir"
        sub.mkdir()
        (self.home / ".bashrc").write_text(
            'printf "rc\\n" >> "$HOME/loaded"\n'
            'theme_hook() { printf "THEME_HOOK\\n"; }\n'
            'PROMPT_COMMAND="theme_hook${PROMPT_COMMAND:+; $PROMPT_COMMAND}"\n'
            'PS1="MAST_READY> "\n'
        )
        self.start("/bin/bash")
        self.send('printf "BASH:%s|%s|%s\\n" "$MAST_TAB" "$HISTFILE" "$PWD"')
        self.assertIn(("BASH:42|%s|%s" % (self.home / ".mast/history/tab-42", self.cwd)).encode(), self.output)
        self.send('cd "%s"' % sub)
        self.finish()
        reports = self.cwd_reports()
        self.assertEqual(reports[0], str(self.cwd))
        self.assertEqual(reports[-1], str(sub))
        self.assertGreaterEqual(self.output.count(b"THEME_HOOK"), 2)
        self.assertEqual((self.home / "loaded").read_text().splitlines(), ["profile", "rc"])
        self.assertFalse((self.home / ".bash_history").exists())
        self.assertTrue(self.output.startswith(START_MARK))

    def test_bash_with_a_stale_integration_keeps_the_previous_prompt_and_hint(self):
        # 앱의 launch.sh 는 업데이트 즉시 바뀌지만 ~/.mast/shell 자산은 프로비저닝이 끝나야 바뀐다. 그 사이의 셸은
        # _mast_prompt 가 없는 옛 integration.sh 를 만나므로, 이전 방식으로 힌트와 cwd 보고를 해야 한다.
        (self.shell_dir / "integration.sh").write_text(
            "export MAST=1\n_mast_cwd() { :; }\n_mast_resume() { :; }\n"
        )
        resume = self.home / ".mast/resume"
        resume.mkdir(parents=True)
        (resume / "tab-42").write_text("codex resume stale-id\n1\nany-gen\n")
        self.auto = "1"
        self.start("/bin/bash")
        self.send('printf "GEN:[%s]\\n" "${MAST_PROMPT_GEN-unset}"')
        self.finish()
        self.assertNotIn(b"command not found", self.output)
        self.assertIn(b"resume previous agent: codex resume stale-id", self.output)
        self.assertIn(b"GEN:[unset]", self.output)
        self.assertEqual(self.cwd_reports()[0], str(self.cwd))
        self.assertIn("codex resume stale-id", (self.home / ".mast/history/tab-42").read_text())

    def test_zsh_login_shell_reports_cwd_and_exports_the_tab_environment(self):
        self.zsh_profile(self.home)
        sub = self.home / "sub dir"
        sub.mkdir()
        self.start("/bin/zsh", PROMPT_COMMAND=None)
        self.send('printf "ENV:[%s]|%s|%s|%s\\n" "${PROMPT_COMMAND-unset}" "$MAST_TAB" "$HISTFILE" "$MAST"')
        self.assertIn(("ENV:[unset]|42|%s|1" % (self.home / ".mast/history/zsh-tab-42")).encode(), self.output)
        self.send('cd "%s"' % sub)
        self.finish()
        reports = self.cwd_reports()
        self.assertEqual(reports[0], str(self.cwd))
        self.assertEqual(reports[-1], str(sub))
        self.assertTrue(self.output.startswith(START_MARK))

    def test_cwd_argument_is_data_not_code_and_round_trips_through_osc7(self):
        self.zsh_profile(self.home)
        for shell in ("/bin/zsh", "/bin/bash"):
            with self.subTest(shell=shell):
                target = self.home / "x $(touch injected) %41 'q' \"d\" 한글"
                target.mkdir(exist_ok=True)
                self.start(shell, cwd=target)
                self.finish()
                self.assertFalse((target / "injected").exists())
                self.assertEqual(self.cwd_reports()[0], str(target))
                self.assertNotIn(b"\x1b]0;", self.output)
                self.assertNotIn(b"\x1b]2;", self.output)

    def test_missing_zsh_assets_fall_back_to_bash_and_zsh_starts_once_complete(self):
        self.zsh_profile(self.home)
        for kind in ("none", "one", "directory"):
            with self.subTest(kind=kind):
                self.install_zsh_assets()
                if kind == "none":
                    for _, target in ZSH_ASSETS:
                        (self.shell_dir / target).unlink()
                elif kind == "one":
                    (self.shell_dir / "zsh/.zshrc").unlink()
                else:
                    (self.shell_dir / "zsh/.zlogin").unlink()
                    (self.shell_dir / "zsh/.zlogin").mkdir()
                self.start("/bin/zsh")
                self.assertIn(ZSH_NOT_INSTALLED.encode(), self.output)
                self.send(KIND_PROBE)
                self.assertIn(b"KIND:bash", self.output)
                self.install_zsh_assets()
                self.start("/bin/zsh")
                self.assertNotIn(b"zsh integration is not installed", self.output)
                self.send(KIND_PROBE)
                self.assertIn(b"KIND:zsh", self.output)

    def test_shell_selection_follows_the_login_shell_policy(self):
        fakebin = self.home / "fakebin"
        fakebin.mkdir()
        getent = fakebin / "getent"
        getent.write_text('#!/bin/sh\nprintf "user:x:1000:1000::/home/user:%s\\n" "$FAKE_LOGIN_SHELL"\n')
        getent.chmod(0o755)
        path = "%s%s%s" % (fakebin, os.pathsep, os.environ["PATH"])
        # 상대경로 사례: 실행 가능한 zsh 가 cwd 에 실제로 있어도 절대경로가 아니므로 bash 로 가야 한다.
        (self.cwd / "bin").mkdir()
        (self.cwd / "bin/zsh").symlink_to("/bin/zsh")
        self.zsh_profile(self.home)
        # (SHELL, passwd 의 셸, 기대 셸, 기대 안내 또는 None). SHELL 을 지우면 bash 가 passwd 셸을 스스로
        # 채우므로, getent 분기를 타려면 빈 값으로 둬야 한다.
        cases = [
            ("", "/bin/zsh", "zsh", None),
            ("", "", "bash", "[mast] login shell '' is not zsh or bash; this tab runs /bin/bash"),
            ("/bin/bash", "/bin/zsh", "bash", None),
            ("/bin/zsh", "/bin/bash", "zsh", None),
            ("/bin/sh", "/bin/zsh", "bash", "[mast] login shell '/bin/sh' is not zsh or bash; this tab runs /bin/bash"),
            ("bin/zsh", "/bin/zsh", "bash", "[mast] login shell 'bin/zsh' is not zsh or bash; this tab runs /bin/bash"),
            ("/nonexistent/zsh", "/bin/zsh", "bash",
             "[mast] login shell '/nonexistent/zsh' is not zsh or bash; this tab runs /bin/bash"),
            ("/bin/zsh\x1b[31m", "/bin/zsh", "bash",
             "[mast] login shell '/bin/zsh?[31m' is not zsh or bash; this tab runs /bin/bash"),
        ]
        for shell, login_shell, kind, notice in cases:
            with self.subTest(shell=shell, login_shell=login_shell):
                self.start(shell, PATH=path, FAKE_LOGIN_SHELL=login_shell)
                self.send(KIND_PROBE)
                self.assertIn(("KIND:%s" % kind).encode(), self.output)
                if notice:
                    self.assertIn(notice.encode(), self.output)
                else:
                    self.assertNotIn(b"is not zsh or bash", self.output)
                self.assertNotIn(b"\x1b[31m", self.output)


AUTO_RESUME = ROOT / "scripts/wsl/mast-auto-resume.py"
QUEUE_MIN_INTERVAL = 3.0
# 허가 기록과 래퍼가 찍는 시각 사이의 수 ms 만큼 여유를 둔다.
PERMIT_SLACK = 0.05
LOAD_IDLE = 0
LOAD_BUSY = 1000
# 부하만 바꾼다. 래퍼가 os.getloadavg 를 덮고, 허가가 나면 종료 직전 시각을 파일로 남긴다.
LOAD_WRAPPER = """
import os, runpy, sys, time
load, helper, stamp = sys.argv[1], sys.argv[2], sys.argv[3]
os.getloadavg = lambda: (float(load),) * 3
sys.argv = [helper] + sys.argv[4:]
try:
    runpy.run_path(helper, run_name="__main__")
except SystemExit as done:
    if done.code == 0:
        with open(stamp, "w") as out:
            out.write(repr(time.monotonic()))
    raise
"""
QUEUED = "\033[2m[mast] auto-resume queued: claude --resume x (Ctrl+C to cancel)\033[0m\n"


def notice(message):
    return "\033[2m[mast] auto-resume %s\033[0m\n" % message


def load_auto_resume():
    spec = importlib.util.spec_from_file_location("mast_auto_resume", AUTO_RESUME)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AutoResumeQueueUnit(unittest.TestCase):
    """시계·sleep·부하를 패치해 대기열 계약을 짧게 검증한다."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mast-resume-queue-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.lock = self.home / ".mast/auto-resume.lock"
        self.queue = load_auto_resume()
        self.now = 1000.0
        self.patch(mock.patch.dict(os.environ, {"HOME": str(self.home)}))
        self.sleep = self.patch(mock.patch.object(self.queue.time, "sleep", side_effect=self.advance))
        self.patch(mock.patch.object(self.queue.time, "monotonic", side_effect=lambda: self.now))
        self.loadavg = self.patch(mock.patch.object(self.queue.os, "getloadavg", return_value=(0.0, 0.0, 0.0)))
        self.patch(mock.patch.object(self.queue.os, "cpu_count", return_value=4))

    def patch(self, patcher):
        self.addCleanup(patcher.stop)
        return patcher.start()

    def advance(self, seconds):
        self.now += seconds

    def write_lock(self, content):
        self.lock.parent.mkdir(exist_ok=True)
        self.lock.write_text(content)

    def sleeps(self):
        return [call.args[0] for call in self.sleep.call_args_list]

    def run_main(self, argv):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = self.queue.main(argv)
        return code, stderr.getvalue()

    def admit(self):
        return self.run_main(["mast-auto-resume.py", "wait", "claude --resume x"])

    def test_first_permit_is_immediate_and_silent(self):
        self.assertEqual(self.admit(), (0, ""))
        self.assertEqual(self.sleeps(), [])
        self.assertEqual(self.lock.read_text(), "1000.0")

    def test_permit_waits_out_the_rest_of_the_interval(self):
        self.write_lock("1000.0")
        self.now = 1001.0
        self.assertEqual(self.admit(), (0, QUEUED))
        self.assertEqual(self.sleeps(), [2.0])
        self.assertEqual(self.lock.read_text(), "1003.0")

    def test_interval_that_has_already_elapsed_is_not_waited(self):
        self.write_lock("1000.0")
        self.now = 1003.0
        self.assertEqual(self.admit(), (0, ""))
        self.assertEqual(self.sleeps(), [])

    def test_corrupt_or_future_record_means_no_previous_permit(self):
        self.now = 1001.0
        for content in ("", "garbage", "nan", "inf", "5000.0"):
            with self.subTest(content=content):
                self.write_lock(content)
                self.assertEqual(self.admit(), (0, ""))
                self.assertEqual(self.sleeps(), [])

    def test_high_load_waits_until_it_drops_below_the_cpu_count(self):
        self.loadavg.side_effect = [(4.0, 0.0, 0.0), (4.0, 0.0, 0.0), (0.5, 0.0, 0.0)]
        self.assertEqual(self.admit(), (0, QUEUED))
        self.assertEqual(self.sleeps(), [1.0, 1.0])
        self.assertEqual(self.lock.read_text(), "1002.0")

    def test_load_query_failure_skips_without_treating_load_as_zero(self):
        self.loadavg.side_effect = OSError("no loadavg")
        self.assertEqual(self.admit(), (1, notice("skipped: load average unavailable")))
        self.assertEqual(self.lock.read_text(), "")

    def test_load_wait_gives_up_at_the_120_second_cap(self):
        self.loadavg.return_value = (LOAD_BUSY, 0.0, 0.0)
        self.assertEqual(self.admit(), (1, QUEUED + notice("skipped: timed out")))
        self.assertEqual(self.sleeps(), [1.0] * 120)
        self.assertEqual(self.lock.read_text(), "")

    def test_lock_wait_gives_up_at_the_120_second_cap(self):
        self.write_lock("")
        holder = os.open(self.lock, os.O_RDWR)
        self.addCleanup(os.close, holder)
        fcntl.flock(holder, fcntl.LOCK_EX)
        self.assertEqual(self.admit(), (1, QUEUED + notice("skipped: timed out")))
        self.assertGreater(self.now, 1119.0)
        self.assertLessEqual(self.now, 1120.0 + 1e-6)
        self.assertEqual(self.lock.read_text(), "")

    def test_cancel_during_the_wait_releases_the_lock(self):
        self.loadavg.return_value = (LOAD_BUSY, 0.0, 0.0)
        self.sleep.side_effect = KeyboardInterrupt
        self.assertEqual(self.admit(), (130, QUEUED + notice("cancelled")))
        fd = os.open(self.lock, os.O_RDWR)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_bad_arguments_skip(self):
        for argv in (["mast-auto-resume.py"], ["mast-auto-resume.py", "start", "claude"]):
            with self.subTest(argv=argv):
                self.assertEqual(
                    self.run_main(argv),
                    (1, notice("skipped: invalid arguments; expected: wait <display-command>")),
                )

    def test_unusable_queue_directory_skips(self):
        (self.home / ".mast").write_text("not a directory")
        code, err = self.admit()
        self.assertEqual(code, 1)
        self.assertIn("skipped: queue state unavailable", err)
        self.assertEqual(err.count("\n"), 1)


class PtyProcess:
    """PTY 에 helper 를 띄운다. 대기자가 여럿이라 PtyShell 의 단일 세션 상태와 떼어 둔다."""

    def __init__(self, argv, env):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.execve(argv[0], argv, env)
            finally:
                os._exit(127)
        self.output = b""

    def text(self):
        return self.output.decode("utf-8", "replace")

    def write(self, data):
        os.write(self.fd, data)

    def read_until(self, token):
        deadline = time.monotonic() + 10
        while token not in self.output:
            if time.monotonic() > deadline or not self.pump(0.05):
                raise AssertionError("no %r in output: %s" % (token, self.text()))

    def pump(self, timeout):
        """timeout 안에 쓰인 출력을 모은다. PTY 가 닫혔으면 False 를 돌려준다."""
        if not select.select([self.fd], [], [], timeout)[0]:
            return True
        try:
            chunk = os.read(self.fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            return False
        self.output += chunk
        return bool(chunk)

    def exit_code(self, timeout=10):
        deadline = time.monotonic() + timeout
        while True:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                break
            if time.monotonic() > deadline:
                raise AssertionError("helper did not exit: %s" % self.text())
            self.pump(0.05)
        self.pid = None
        while self.pump(0.05):
            pass
        return os.waitstatus_to_exitcode(status)

    def kill(self):
        if self.pid is not None:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(self.pid, 0)
            self.pid = None
        os.close(self.fd)


class AutoResumeQueueProcess(unittest.TestCase):
    """실제 프로세스와 실제 flock 으로 여러 대기자의 간격과 취소를 검증한다."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mast-resume-queue-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.lock = self.home / ".mast/auto-resume.lock"
        self.env = dict(os.environ, HOME=str(self.home))

    def helper_argv(self, load, stamp):
        return [sys.executable, "-c", LOAD_WRAPPER, str(load), str(AUTO_RESUME), str(stamp),
                "wait", "claude --resume x"]

    def spawn(self, load, stamp):
        process = PtyProcess(self.helper_argv(load, stamp), self.env)
        self.addCleanup(process.kill)
        return process

    def test_helpers_sharing_a_home_are_admitted_one_at_a_time(self):
        stamps = [self.home / ("stamp-%d" % index) for index in range(3)]
        procs = [subprocess.Popen(self.helper_argv(LOAD_IDLE, stamp), env=self.env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                 for stamp in stamps]
        for proc in procs:
            out, err = proc.communicate(timeout=30)
            self.assertEqual((proc.returncode, out), (0, b""), err.decode("utf-8", "replace"))
        permits = sorted(float(stamp.read_text()) for stamp in stamps)
        for earlier, later in zip(permits, permits[1:]):
            self.assertGreaterEqual(later - earlier, QUEUE_MIN_INTERVAL - PERMIT_SLACK)

    def test_ctrl_c_cancels_the_holder_and_hands_the_lock_to_the_next_helper(self):
        holder = self.spawn(LOAD_BUSY, self.home / "holder-stamp")
        holder.read_until(b"auto-resume queued")
        waiter = self.spawn(LOAD_IDLE, self.home / "waiter-stamp")
        waiter.read_until(b"auto-resume queued")
        holder.write(b"\x03")
        self.assertEqual(holder.exit_code(), 130, holder.text())
        self.assertIn(b"auto-resume cancelled", holder.output)
        self.assertEqual(waiter.exit_code(), 0, waiter.text())
        self.assertFalse((self.home / "holder-stamp").exists())
        self.assertTrue((self.home / "waiter-stamp").exists())

    def test_sighup_ends_a_queued_helper_without_a_permit(self):
        holder = self.spawn(LOAD_BUSY, self.home / "holder-stamp")
        holder.read_until(b"auto-resume queued")
        os.kill(holder.pid, signal.SIGHUP)
        self.assertEqual(holder.exit_code(), -signal.SIGHUP, holder.text())
        self.assertNotIn(b"skipped", holder.output)
        self.assertNotIn(b"cancelled", holder.output)
        self.assertFalse((self.home / "holder-stamp").exists())
        self.assertEqual(self.lock.read_bytes(), b"")
        successor = self.spawn(LOAD_IDLE, self.home / "successor-stamp")
        self.assertEqual(successor.exit_code(), 0, successor.text())


if __name__ == "__main__":
    unittest.main()
