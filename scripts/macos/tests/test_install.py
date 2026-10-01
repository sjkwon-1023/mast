"""install.sh 를 로컬 zip(file://)과 임시 설치 폴더로 실행해 본다."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
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

    def archive(self, name, marker):
        app = self.root / "build" / name
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/MacOS/mast-app").write_text(marker)
        zip_path = self.root / f"{marker}.zip"
        subprocess.run(["ditto", "-c", "-k", "--keepParent", str(app), str(zip_path)], check=True)
        subprocess.run(["rm", "-rf", str(self.root / "build")], check=True)
        return zip_path

    def install(self, zip_path):
        env = dict(os.environ, MAST_DOWNLOAD_URL=zip_path.as_uri(), MAST_APP_DIR=str(self.dest))
        return subprocess.run(["/bin/bash", str(INSTALL)], env=env, capture_output=True, text=True)

    def installed(self):
        return (self.dest / "mast.app/Contents/MacOS/mast-app").read_text()

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
