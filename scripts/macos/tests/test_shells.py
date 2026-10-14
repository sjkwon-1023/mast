"""배포되는 시작 파일을 실제 PTY 와 실제 zsh/bash 로 실행해 본다.

macOS 는 `scripts/macos/launch.sh`, Linux 는 WSL 래퍼 본문 `scripts/wsl/launch.sh` 를 `bash -c` 인자 계약
그대로 실행한다. 두 플랫폼이 같은 zsh 시작 파일 계약을 따르므로 zsh 사례는 `ZshStartupCases` 를 함께 쓴다.
"""
import errno
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


class ZshStartupCases:
    """zsh 시작 계약. macOS 와 WSL 두 launcher 에서 같은 사례를 실행한다."""

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


@unittest.skipUnless(sys.platform == "darwin", "requires native macOS startup files and zsh")
class ShellStartup(ZshStartupCases, PtyShell):
    def setUp(self):
        super().setUp()
        self.shell_dir.mkdir(parents=True)
        for name in ("launch.sh", "integration.sh", "bashrc", "zsh-integration.zsh"):
            shutil.copyfile(ROOT / "scripts/macos" / name, self.shell_dir / name)
        (self.shell_dir / "zsh").mkdir()
        for name in ("zshenv", "zprofile", "zshrc", "zlogin"):
            shutil.copyfile(ROOT / "scripts/macos" / name, self.shell_dir / "zsh" / ("." + name))

    def command(self, shell, tab, cwd):
        argv = ["/bin/bash", str(self.shell_dir / "launch.sh"), shell, tab, cwd, str(self.home / "settings.json")]
        return argv, {}

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
class WslShellStartup(ZshStartupCases, PtyShell):
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
        # wsl.exe 가 $SHELL 을 물려주는 것과 같다. PS1 은 물려주지 않는다.
        return ["/bin/bash", "-c", body, "mast-wsl", tab, cwd], {"SHELL": shell, "PS1": None}

    def resume_dir(self):
        resume = self.home / ".mast/resume"
        resume.mkdir(parents=True, exist_ok=True)
        return resume

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

    def test_bash_resume_hint_is_appended_once_and_announced_at_start(self):
        history = self.home / ".mast/history/tab-42"
        for hint in ("claude --resume saved-id", "codex resume saved-id", "opencode --session ses_1"):
            with self.subTest(hint=hint):
                (self.resume_dir() / "tab-42").write_text(hint + "\n1\n")
                history.unlink(missing_ok=True)
                self.start("/bin/bash")
                self.send("history 2 | sed 's/^/HIST:/'")
                self.finish()
                self.assertEqual(self.output.count(("resume previous agent: %s" % hint).encode()), 1)
                self.assertRegex(self.output, rb"HIST: *\d+ +" + re.escape(hint.encode()))
                self.assertEqual(history.read_text().splitlines().count(hint), 1)
                self.assertFalse((self.home / ".bash_history").exists())

    def test_bash_invalid_resume_hint_is_neither_recorded_nor_run(self):
        history = self.home / ".mast/history/tab-42"
        for hint in ("claude --resume bad;touch PWNED", "claude --resume", "rm -rf nothing", ""):
            with self.subTest(hint=hint):
                (self.resume_dir() / "tab-42").write_text(hint + "\n1\n")
                history.unlink(missing_ok=True)
                self.start("/bin/bash")
                self.finish()
                self.assertNotIn(b"resume previous agent", self.output)
                recorded = history.read_text() if history.exists() else ""
                self.assertNotIn("bad;touch", recorded)
                self.assertNotIn("rm -rf", recorded)
                self.assertFalse((self.home / "PWNED").exists())

    def test_bash_restart_in_the_same_tab_keeps_its_history_and_skips_other_tabs(self):
        history_dir = self.home / ".mast/history"
        history_dir.mkdir(parents=True)
        (history_dir / "tab-7").write_text("echo other-tab-7\n")
        self.start("/bin/bash")
        self.finish("echo kept-in-tab-42")
        self.start("/bin/bash")
        self.finish("history | sed 's/^/HIST:/'")
        self.assertRegex(self.output, rb"HIST: *\d+ +echo kept-in-tab-42")
        self.assertNotRegex(self.output, rb"HIST: *\d+ +echo other-tab-7")

    def test_a_deleted_cwd_starts_in_home_with_a_notice(self):
        self.zsh_profile(self.home)
        gone = self.home / "deleted"
        for shell in ("/bin/zsh", "/bin/bash"):
            with self.subTest(shell=shell):
                self.start(shell, cwd=gone)
                self.send('printf "PWD:%s\\n" "$PWD"')
                self.assertIn(("PWD:%s" % self.home).encode(), self.output)
                self.assertIn(("[mast] %s is gone; starting in $HOME" % gone).encode(), self.output)

    def test_a_deleted_cwd_with_control_characters_prints_them_as_question_marks(self):
        self.zsh_profile(self.home)
        gone = self.home / "deleted\x1b[31m"
        shown = str(gone).replace("\x1b", "?")
        for shell in ("/bin/zsh", "/bin/bash"):
            with self.subTest(shell=shell):
                self.start(shell, cwd=gone)
                self.assertIn(("[mast] %s is gone; starting in $HOME" % shown).encode(), self.output)
                self.assertNotIn(b"deleted\x1b[31m", self.output)

    def test_zsh_path_exports_the_tab_environment_without_the_bash_prompt_hook(self):
        self.zsh_profile(self.home)
        self.start("/bin/zsh", PROMPT_COMMAND=None)
        self.send('printf "ENV:[%s]|%s|%s|%s\\n" "${PROMPT_COMMAND-unset}" "$MAST_TAB" "$HISTFILE" "$MAST"')
        self.finish()
        self.assertIn(("ENV:[unset]|42|%s|1" % (self.home / ".mast/history/zsh-tab-42")).encode(), self.output)

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

    def test_launch_without_a_tab_id_integrates_only_the_cwd(self):
        self.zsh_profile(self.home)
        (self.resume_dir() / "tab-42").write_text("claude --resume saved-id\n1\n")
        for shell in ("/bin/zsh", "/bin/bash"):
            with self.subTest(shell=shell):
                self.start(shell, tab="", HISTFILE="/inherited/tab-history", MAST_TAB="99")
                self.send('printf "NOTAB:[%s]|%s\\n" "$MAST_TAB" "$HISTFILE"')
                self.finish()
                self.assertIn(b"NOTAB:[]|", self.output)
                self.assertNotIn(b"/inherited/tab-history", self.output)
                self.assertNotIn(b"resume previous agent", self.output)
                self.assertFalse((self.home / ".mast/history").exists())
                self.assertEqual(self.cwd_reports()[0], str(self.cwd))

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

    def test_profile_exec_zsh_after_the_fallback_is_a_known_unintegrated_tab_until_restart(self):
        # 알려진 한계: 자산이 빠진 탭의 bash 로그인 경로에서 사용자 `.profile` 이 zsh 를 exec 하면 그 zsh 는
        # mast 의 ZDOTDIR 래퍼를 거치지 않아 OSC 7 cwd 보고가 전혀 없다. 자산을 갖춘 뒤 Restart 해야 통합된다.
        (self.home / ".bash_profile").unlink()
        (self.home / ".profile").write_text(
            'if [ -n "$BASH_VERSION" ] && [[ $- == *i* ]] && [ -z "$NO_ZSH" ] && [ -x /bin/zsh ]; then exec /bin/zsh -l; fi\n'
        )
        self.zsh_profile(self.home)
        sub = self.home / "sub dir"
        sub.mkdir()
        (self.shell_dir / "zsh/.zlogin").unlink()
        self.start("/bin/zsh")
        self.assertEqual(self.output.count(ZSH_NOT_INSTALLED.encode()), 1)
        self.send(KIND_PROBE)
        self.assertIn(b"KIND:zsh", self.output)
        self.send('cd "%s"' % sub)
        self.finish()
        self.assertEqual(self.cwd_reports(), [])
        self.install_zsh_assets()
        self.start("/bin/zsh")
        self.assertNotIn(b"zsh integration is not installed", self.output)
        self.send(KIND_PROBE)
        self.assertIn(b"KIND:zsh", self.output)
        self.send('cd "%s"' % sub)
        self.finish()
        reports = self.cwd_reports()
        self.assertEqual(reports[0], str(self.cwd))
        self.assertEqual(reports[-1], str(sub))

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

    def test_history_directory_failure_exits_nonzero_after_the_start_marker(self):
        self.zsh_profile(self.home)
        (self.home / ".mast").mkdir(exist_ok=True)
        blocker = self.home / ".mast/history"
        for shell in ("/bin/zsh", "/bin/bash"):
            with self.subTest(shell=shell):
                blocker.write_text("not a directory\n")
                code = self.start_expect_exit(shell)
                blocker.unlink()
                self.assertNotEqual(code, 0)
                self.assertTrue(self.output.startswith(START_MARK), self.output)
                self.assertIn(("mast: cannot create %s" % blocker).encode(), self.output)


if __name__ == "__main__":
    unittest.main()
