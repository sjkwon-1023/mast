"""Exercise the shipped startup files with real macOS PTYs and real zsh/bash."""
import errno
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[3]


@unittest.skipUnless(sys.platform == "darwin", "requires native macOS startup files and zsh")
class ShellStartup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mast-shell-")
        self.home = Path(self.temp.name)
        self.shell_dir = self.home / ".mast/shell"
        self.shell_dir.mkdir(parents=True)
        for name in ("launch.sh", "integration.sh", "bashrc", "zsh-integration.zsh"):
            shutil.copyfile(ROOT / "scripts/macos" / name, self.shell_dir / name)
        (self.shell_dir / "zsh").mkdir()
        for name in ("zshenv", "zprofile", "zshrc", "zlogin"):
            shutil.copyfile(ROOT / "scripts/macos" / name, self.shell_dir / "zsh" / ("." + name))
        self.cwd = self.home / "project ' 한글:$(not-executed)"
        self.cwd.mkdir()
        self.pid = self.fd = None
        self.output = b""

    def tearDown(self):
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
        if self.fd is not None:
            os.close(self.fd)
        self.temp.cleanup()

    def start(self, shell, tab="42", zdotdir=None, cwd=None):
        pid, fd = pty.fork()
        if pid == 0:
            env = dict(os.environ, HOME=str(self.home), PS1="MAST_READY> ")
            env.pop("ZDOTDIR", None)
            if zdotdir:
                env["ZDOTDIR"] = str(zdotdir)
            os.execve("/bin/bash", ["/bin/bash", str(self.shell_dir / "launch.sh"), shell,
                      tab, str(cwd or self.cwd), str(self.home / "settings.json")], env)
        self.pid, self.fd = pid, fd
        self.read_until(b"MAST_READY> ")

    def read_until(self, token):
        deadline = time.monotonic() + 10
        while token not in self.output:
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

    def finish(self, command=""):
        os.write(self.fd, (command + "\nexit\n").encode())
        deadline = time.monotonic() + 10
        while True:
            self.assertLess(time.monotonic(), deadline, "shell did not exit")
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    self.output += os.read(self.fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.pid = None
                return

    def zsh_profile(self, directory):
        for name in (".zshenv", ".zprofile", ".zshrc", ".zlogin"):
            text = 'printf "%s\\n" "%s" >> "$HOME/loaded"\n' % ("%s", name)
            if name == ".zshrc":
                text += "PROMPT='MAST_READY> '\n"
            (directory / name).write_text(text)

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


if __name__ == "__main__":
    unittest.main()
