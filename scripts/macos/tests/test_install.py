"""install.sh 를 로컬 zip 과 임시 설치 폴더로 실행해 본다. 최신 릴리즈 판정은 GitHub 의
/releases/latest 리다이렉트를 흉내 내는 로컬 HTTP 서버로 확인한다."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

INSTALL = Path(__file__).resolve().parents[1] / "install.sh"


@unittest.skipUnless(sys.platform == "darwin", "requires macOS ditto and an Apple Silicon host")
class Install(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mast-install-")
        self.root = Path(self.temp.name)
        self.dest = self.root / "Applications"

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, name, marker, version="0.0.0"):
        app = self.root / "build" / name
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/MacOS/mast-app").write_text(marker)
        subprocess.run(
            ["plutil", "-create", "xml1", str(app / "Contents/Info.plist")], check=True
        )
        subprocess.run(
            ["plutil", "-insert", "CFBundleShortVersionString", "-string", version,
             str(app / "Contents/Info.plist")],
            check=True,
        )
        zip_path = self.root / f"{marker}.zip"
        subprocess.run(["ditto", "-c", "-k", "--keepParent", str(app), str(zip_path)], check=True)
        subprocess.run(["rm", "-rf", str(self.root / "build")], check=True)
        return zip_path

    def install(self, zip_path):
        env = dict(os.environ, MAST_DOWNLOAD_URL=zip_path.as_uri(), MAST_APP_DIR=str(self.dest))
        return subprocess.run(["/bin/bash", str(INSTALL)], env=env, capture_output=True, text=True)

    def installed(self):
        return (self.dest / "mast.app/Contents/MacOS/mast-app").read_text()

    def release_server(self, tag, zip_path):
        """`/releases/latest` 는 태그 페이지로 리다이렉트하고, 최신 zip 을 내준다."""
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
                elif self.path == "/releases/latest/download/mast-macos-arm64.zip":
                    body = zip_path.read_bytes()
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

    def update(self, repo):
        env = dict(os.environ, MAST_REPO_URL=repo, MAST_APP_DIR=str(self.dest))
        env.pop("MAST_DOWNLOAD_URL", None)
        return subprocess.run(["/bin/bash", str(INSTALL)], env=env, capture_output=True, text=True)

    def test_an_up_to_date_install_downloads_nothing(self):
        self.install(self.archive("mast.app", "current", version="1.2.3"))
        repo, requests = self.release_server("v1.2.3", self.archive("mast.app", "same", version="1.2.3"))
        result = self.update(repo)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1.2.3 is already the latest release", result.stdout)
        self.assertNotIn("/releases/latest/download/mast-macos-arm64.zip", requests)
        self.assertEqual(self.installed(), "current")

    def test_a_newer_release_replaces_the_installed_app(self):
        self.install(self.archive("mast.app", "old", version="1.2.2"))
        repo, _ = self.release_server("v1.2.3", self.archive("mast.app", "new", version="1.2.3"))
        result = self.update(repo)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed(), "new")

    def test_the_latest_release_installs_when_nothing_is_installed(self):
        repo, _ = self.release_server("v1.2.3", self.archive("mast.app", "fresh", version="1.2.3"))
        result = self.update(repo)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed(), "fresh")

    def test_installs_and_replaces_an_existing_app(self):
        self.assertEqual(self.install(self.archive("mast.app", "v1")).returncode, 0)
        self.assertEqual(self.installed(), "v1")
        result = self.install(self.archive("mast.app", "v2"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed(), "v2")
        self.assertEqual(sorted(p.name for p in self.dest.iterdir()), ["mast.app"])

    def test_a_download_without_the_app_keeps_the_installed_one(self):
        self.install(self.archive("mast.app", "v1"))
        result = self.install(self.archive("other.app", "broken"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not contain mast.app", result.stderr)
        self.assertEqual(self.installed(), "v1")

    def test_a_failed_download_keeps_the_installed_one(self):
        self.install(self.archive("mast.app", "v1"))
        result = self.install(self.root / "missing.zip")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.installed(), "v1")


if __name__ == "__main__":
    unittest.main()
