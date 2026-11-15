"""install.ps1 을 Windows PowerShell 5.1 로 실행해 본다 (CI windows-gates). `irm | iex` 와 같게
스크립트 본문을 문자열로 읽어 Invoke-Expression 에 넘긴다. 릴리즈 exe 대신 시스템 exe 를 쓴다."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

INSTALL = Path(__file__).resolve().parents[1] / "install.ps1"
SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
MAST_HOOKS = {
    "mast": {
        "PreInvocation": [{"type": "command", "command": "mast-agy-hook running", "timeout": 5}],
        "Stop": [{"type": "command", "command": "mast-agy-hook idle", "timeout": 5}],
    }
}


def squeezed(text):
    """콘솔 폭에서 꺾인 오류 문구를 비교하려고 공백과 줄바꿈을 모두 지운다."""
    return "".join(text.split())


@unittest.skipUnless(sys.platform == "win32", "requires Windows PowerShell")
class Install(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mast-install-")
        # 러너의 TEMP 는 8.3 짧은 이름(RUNNER~1)이라 프로세스 경로와 문자열이 달라진다 — 긴 경로로 푼다.
        self.root = Path(self.temp.name).resolve()
        self.dest = self.root / "Programs" / "mast"
        self.exe = self.dest / "mast.exe"
        self.hook = self.dest / "bin" / "mast-agy-hook.exe"
        self.appdata = self.root / "AppData"
        self.profile = self.root / "Profile"
        self.settings = self.appdata / "app.mast.desktop" / "settings.json"
        self.hooks = self.profile / ".gemini" / "config" / "hooks.json"

    def tearDown(self):
        self.temp.cleanup()

    def release(self, name):
        """시스템 exe 하나를 '릴리즈 exe' 로 쓴다."""
        target = self.root / f"release-{name}"
        shutil.copyfile(SYSTEM32 / name, target)
        return target

    def run_install(self, **env):
        # 사용자 프로필·설정·셸 선택이 실제 값으로 새지 않게 임시 폴더로 돌린다.
        full = dict(
            os.environ,
            MAST_APP_DIR=str(self.dest),
            APPDATA=str(self.appdata),
            USERPROFILE=str(self.profile),
            LOCALAPPDATA=str(self.root / "LocalAppData"),
        )
        for name in ("MAST_DOWNLOAD_URL", "MAST_HOOK_DOWNLOAD_URL", "MAST_WINDOWS_SHELL"):
            full.pop(name, None)
        full.update(env)
        command = f"Get-Content -Raw -Encoding UTF8 -LiteralPath '{INSTALL}' | Invoke-Expression"
        return subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            env=full, capture_output=True, text=True,
        )

    def install(self, path):
        return self.run_install(MAST_DOWNLOAD_URL=path.as_uri())

    def assert_error_message(self, result, phrase):
        output = result.stdout + result.stderr
        self.assertIn(squeezed(phrase), squeezed(output), output)

    def test_installs_into_the_folder(self):
        result = self.install(self.release("where.exe"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.exe.read_bytes(), (SYSTEM32 / "where.exe").read_bytes())
        self.assertEqual(sorted(p.name for p in self.dest.iterdir()), ["mast.exe"])

    def test_a_running_exe_is_renamed_aside_and_keeps_running(self):
        self.install(self.release("PING.EXE"))
        process = subprocess.Popen(
            [str(self.exe), "-n", "60", "127.0.0.1"], stdout=subprocess.DEVNULL
        )
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        time.sleep(1)

        result = self.install(self.release("where.exe"))

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("still running the previous version", result.stdout)
        self.assertIsNone(process.poll())
        self.assertEqual(self.exe.read_bytes(), (SYSTEM32 / "where.exe").read_bytes())
        olds = [p.name for p in self.dest.iterdir() if p.name.startswith("mast.exe.old-")]
        self.assertEqual(len(olds), 1)

        # 옛 exe 가 끝난 뒤 다음 설치가 비켜 둔 파일을 치운다.
        process.kill()
        process.wait()
        self.assertEqual(self.install(self.release("where.exe")).returncode, 0)
        self.assertEqual(sorted(p.name for p in self.dest.iterdir()), ["mast.exe"])

    def test_a_download_that_is_not_an_exe_keeps_the_installed_one(self):
        self.install(self.release("where.exe"))
        bogus = self.root / "bogus.exe"
        bogus.write_text("not an exe")
        result = self.install(bogus)
        self.assertNotEqual(result.returncode, 0)
        self.assert_error_message(result, "not a Windows executable")
        self.assertEqual(self.exe.read_bytes(), (SYSTEM32 / "where.exe").read_bytes())
        self.assertEqual(sorted(p.name for p in self.dest.iterdir()), ["mast.exe"])

    def test_a_failed_download_keeps_the_installed_one(self):
        self.install(self.release("where.exe"))
        result = self.install(self.root / "missing.exe")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.exe.read_bytes(), (SYSTEM32 / "where.exe").read_bytes())

    def release_server(self, tag, exe):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_HEAD(self):
                self.respond(head=True)

            def do_GET(self):
                self.respond(head=False)

            def respond(self, head):
                requests.append(self.path)
                if self.path == "/releases/latest":
                    self.send_response(302)
                    self.send_header("Location", f"/releases/tag/{tag}")
                    self.end_headers()
                elif self.path == f"/releases/tag/{tag}":
                    self.send_response(200)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif self.path.startswith("/releases/latest/download/mast-"):
                    body = exe.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    if not head:
                        self.wfile.write(body)
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}", requests

    def version_of(self, path):
        out = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command",
             f"$i=(Get-Item -LiteralPath '{path}').VersionInfo; "
             "'{0}.{1}.{2}' -f $i.FileMajorPart,$i.FileMinorPart,$i.FileBuildPart"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()

    def test_an_up_to_date_install_downloads_nothing(self):
        self.install(self.release("where.exe"))
        version = self.version_of(self.exe)
        repo, requests = self.release_server(f"v{version}", self.release("PING.EXE"))
        result = self.run_install(MAST_REPO_URL=repo)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"{version} is already the latest release", result.stdout)
        self.assertFalse(any(p.startswith("/releases/latest/download/") for p in requests))
        self.assertEqual(self.exe.read_bytes(), (SYSTEM32 / "where.exe").read_bytes())

    def test_a_different_release_replaces_the_installed_exe(self):
        self.install(self.release("where.exe"))
        repo, _ = self.release_server("v0.0.1", self.release("PING.EXE"))
        result = self.run_install(MAST_REPO_URL=repo)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.exe.read_bytes(), (SYSTEM32 / "PING.EXE").read_bytes())

    @staticmethod
    def snapshot(*paths):
        return {path: path.read_bytes() if path.exists() else None for path in paths}

    @staticmethod
    def user_environment():
        return subprocess.run(
            ["reg.exe", "query", r"HKCU\Environment"], capture_output=True, text=True, check=True
        ).stdout

    def install_powershell(self, mast, hook, **env):
        return self.run_install(
            MAST_DOWNLOAD_URL=mast.as_uri(),
            MAST_HOOK_DOWNLOAD_URL=hook.as_uri(),
            MAST_WINDOWS_SHELL="powershell",
            **env,
        )

    def test_without_the_variable_only_mast_changes(self):
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text('{"fontSize": 15}\n', encoding="utf-8")
        before = self.snapshot(self.settings)
        result = self.install(self.release("where.exe"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.snapshot(self.settings), before)
        self.assertFalse((self.dest / "bin").exists())
        self.assertFalse(self.hooks.exists())

    def test_powershell_mode_installs_the_hook_registers_it_then_sets_the_shell(self):
        result = self.install_powershell(self.release("where.exe"), self.release("PING.EXE"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.exe.read_bytes(), (SYSTEM32 / "where.exe").read_bytes())
        self.assertEqual(self.hook.read_bytes(), (SYSTEM32 / "PING.EXE").read_bytes())
        self.assertEqual(json.loads(self.hooks.read_text(encoding="utf-8")), MAST_HOOKS)
        self.assertEqual(
            json.loads(self.settings.read_text(encoding="utf-8")), {"windowsShell": "powershell"}
        )
        steps = [
            result.stdout.index(text)
            for text in (f"Installed {self.hook}", "Registered mast-agy-hook", "Set windowsShell")
        ]
        self.assertEqual(steps, sorted(steps))

    def test_powershell_mode_still_runs_when_mast_is_already_the_latest(self):
        self.install(self.release("where.exe"))
        repo, requests = self.release_server(f"v{self.version_of(self.exe)}", self.release("PING.EXE"))
        result = self.run_install(
            MAST_REPO_URL=repo,
            MAST_HOOK_DOWNLOAD_URL=self.release("PING.EXE").as_uri(),
            MAST_WINDOWS_SHELL="powershell",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("already the latest release", result.stdout)
        self.assertFalse(any(p.startswith("/releases/latest/download/") for p in requests))
        self.assertEqual(self.hook.read_bytes(), (SYSTEM32 / "PING.EXE").read_bytes())
        self.assertEqual(
            json.loads(self.settings.read_text(encoding="utf-8")), {"windowsShell": "powershell"}
        )

    def test_a_failed_hook_download_changes_neither_json_file(self):
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text('{"fontSize": 15}\n', encoding="utf-8")
        self.hooks.parent.mkdir(parents=True)
        self.hooks.write_text('{"other": {"Stop": []}}\n', encoding="utf-8")
        before = self.snapshot(self.settings, self.hooks)
        result = self.install_powershell(self.release("where.exe"), self.root / "missing.exe")
        self.assertNotEqual(result.returncode, 0)
        self.assert_error_message(result, "hook download failed")
        self.assert_error_message(result, "settings.json and hooks.json are unchanged")
        self.assertEqual(self.snapshot(self.settings, self.hooks), before)
        self.assertFalse(self.hook.exists())

    def test_a_hook_download_that_is_not_an_exe_is_rejected(self):
        bogus = self.root / "bogus-hook.exe"
        bogus.write_text("not an exe")
        result = self.install_powershell(self.release("where.exe"), bogus)
        self.assertNotEqual(result.returncode, 0)
        self.assert_error_message(result, "not a Windows executable")
        self.assertFalse(self.hook.exists())
        self.assertFalse(self.settings.exists())
        self.assertFalse(self.hooks.exists())

    def test_existing_settings_keys_and_hook_groups_are_kept(self):
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text(
            json.dumps({
                "fontSize": 15,
                "shell": "/bin/zsh",
                "windowsShell": "wsl",
                "highlightLanguages": ["python"],
                "emptyList": [],
                "remote": {"enabled": False, "port": 8787},
            }),
            encoding="utf-8",
        )
        other = {"other": {"Stop": [{"type": "command", "command": "other idle", "timeout": 3}]}}
        self.hooks.parent.mkdir(parents=True)
        self.hooks.write_text(json.dumps({**other, "mast": {"Stop": []}}), encoding="utf-8")

        result = self.install_powershell(self.release("where.exe"), self.release("PING.EXE"))

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            json.loads(self.settings.read_text(encoding="utf-8")),
            {
                "fontSize": 15,
                "shell": "/bin/zsh",
                "windowsShell": "powershell",
                "highlightLanguages": ["python"],
                "emptyList": [],
                "remote": {"enabled": False, "port": 8787},
            },
        )
        hooks = json.loads(self.hooks.read_text(encoding="utf-8"))
        self.assertEqual(hooks, {**other, **MAST_HOOKS})
        self.assertEqual(list(hooks), ["other", "mast"])

    def test_json_files_are_written_without_a_byte_order_mark(self):
        result = self.install_powershell(self.release("where.exe"), self.release("PING.EXE"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for path in (self.settings, self.hooks):
            with self.subTest(path=path.name):
                self.assertFalse(path.read_bytes().startswith(b"\xef\xbb\xbf"))

    def assert_invalid_json_is_refused(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        before = self.snapshot(self.settings, self.hooks)
        result = self.install_powershell(self.release("where.exe"), self.release("PING.EXE"))
        self.assertNotEqual(result.returncode, 0)
        self.assert_error_message(result, "is not valid JSON")
        self.assertEqual(self.snapshot(self.settings, self.hooks), before)
        self.assertFalse(self.exe.exists())
        self.assertFalse(self.hook.exists())

    def test_invalid_settings_json_is_refused_and_nothing_is_written(self):
        self.assert_invalid_json_is_refused(self.settings, '{"fontSize": ')

    def test_invalid_hooks_json_is_refused_and_nothing_is_written(self):
        self.assert_invalid_json_is_refused(self.hooks, '{"mast": ')

    def assert_non_object_root_is_refused(self, path, text):
        for other in (self.settings, self.hooks):
            other.unlink(missing_ok=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        before = self.snapshot(self.settings, self.hooks)
        result = self.install_powershell(self.release("where.exe"), self.release("PING.EXE"))
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_error_message(result, "must contain a JSON object")
        self.assertEqual(self.snapshot(self.settings, self.hooks), before)
        self.assertFalse(self.exe.exists())
        self.assertFalse(self.hook.exists())

    def test_a_json_root_that_is_not_an_object_is_refused_and_nothing_is_written(self):
        # `[PSCustomObject]` 검사는 PS 5.1 에서 이 값들도 통과시켜 기존 파일을 덮어쓰게 만들었다 (install.ps1 `Read-JsonObject`).
        for text in ("[]", '["mast"]', '"mast"', "5", "true", "null", ""):
            for path in (self.settings, self.hooks):
                with self.subTest(path=path.name, text=text):
                    self.assert_non_object_root_is_refused(path, text)

    def test_an_unknown_windows_shell_value_is_refused_before_anything_changes(self):
        for value in ("wsl", "cmd", "PowerShell"):
            with self.subTest(value=value):
                result = self.run_install(
                    MAST_DOWNLOAD_URL=self.release("where.exe").as_uri(),
                    MAST_WINDOWS_SHELL=value,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assert_error_message(result, "MAST_WINDOWS_SHELL must be")
                self.assertFalse(self.exe.exists())

    def test_the_user_registry_is_not_written(self):
        before = self.user_environment()
        result = self.install_powershell(self.release("where.exe"), self.release("PING.EXE"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.user_environment(), before)

    def test_the_script_parses_as_windows_powershell_5_1(self):
        command = (
            "$errors = $null; "
            f"[void][System.Management.Automation.Language.Parser]::ParseFile('{INSTALL}', [ref]$null, [ref]$errors); "
            "Write-Output ('PARSE_ERRORS=' + @($errors).Count)"
        )
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True, text=True,
        )
        self.assertIn("PARSE_ERRORS=0", result.stdout, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
