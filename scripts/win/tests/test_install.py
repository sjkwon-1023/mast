"""install.ps1 을 Windows PowerShell 5.1 로 실행해 본다 (CI windows-gates). `irm | iex` 와 같게
스크립트 본문을 문자열로 읽어 Invoke-Expression 에 넘긴다. 릴리즈 exe 대신 시스템 exe 를 쓴다."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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


@unittest.skipUnless(sys.platform == "win32", "requires Windows PowerShell")
class Install(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mast-install-")
        # 러너의 TEMP 는 8.3 짧은 이름(RUNNER~1)이라 프로세스 경로와 문자열이 달라진다 — 긴 경로로 푼다.
        self.root = Path(self.temp.name).resolve()
        self.dest = self.root / "Programs" / "mast"
        self.exe = self.dest / "mast.exe"

    def tearDown(self):
        self.temp.cleanup()

    def release(self, name):
        """시스템 exe 하나를 '릴리즈 exe' 로 쓴다."""
        target = self.root / f"release-{name}"
        shutil.copyfile(SYSTEM32 / name, target)
        return target

    def run_install(self, **env):
        full = dict(os.environ, MAST_APP_DIR=str(self.dest))
        full.pop("MAST_DOWNLOAD_URL", None)
        full.update(env)
        command = f"Get-Content -Raw -LiteralPath '{INSTALL}' | Invoke-Expression"
        return subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            env=full, capture_output=True, text=True,
        )

    def install(self, path):
        return self.run_install(MAST_DOWNLOAD_URL=path.as_uri())

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
        self.assertIn("not a Windows executable", result.stdout + result.stderr)
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


if __name__ == "__main__":
    unittest.main()
