"""powershell-integration.ps1 의 resume 힌트·자동 재실행을 Windows PowerShell 5.1 로 실행해 본다
(CI windows-gates). 앱(host.rs)처럼 네 리터럴 뒤에 주석·빈 줄을 뺀 본문을 붙여 -EncodedCommand 로 넘긴다.
프로필 폴더와 PATH 는 스크립트 앞에서 임시 값으로 바꿔 실제 사용자 상태와 설치된 agy 가 섞이지 않게 한다."""
import base64
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

INTEGRATION = Path(__file__).resolve().parents[1] / "powershell-integration.ps1"
SYSTEM_ROOT = os.environ.get("SystemRoot", r"C:\Windows")
# cmd.exe(가짜 agy.cmd 실행)와 PowerShell 만 남긴다. 러너나 개발 PC 의 진짜 agy 가 잡히면 안 된다.
SYSTEM_PATH = rf"{SYSTEM_ROOT}\System32;{SYSTEM_ROOT}\System32\WindowsPowerShell\v1.0"
# 받은 인자와 실행 시점의 세대를 기록하고 바로 끝나는 agy 대역. 리디렉션을 앞에 두어야 세대 끝의 숫자가
# `3>>` 같은 핸들 리디렉션으로 읽히지 않는다.
FAKE_AGY = '@>>"%USERPROFILE%\\agent-log" echo %* gen=%MAST_PROMPT_GEN%\r\n'
TOKEN = "c18e460e-c48b-4597-b22c-3d777e0dbf67"
HINT = f"agy --conversation {TOKEN}"


def integration_body():
    """host.rs 의 powershell_integration_body 와 같다: 줄 전체가 주석인 줄과 빈 줄을 뺀다."""
    lines = INTEGRATION.read_text(encoding="utf-8").splitlines()
    return "".join(line + "\n" for line in lines if line.strip() and not line.lstrip().startswith("#"))


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def win(path):
    """스크립트에 넣을 Windows 경로."""
    return str(path)


@unittest.skipUnless(sys.platform == "win32", "requires Windows PowerShell")
class ResumeIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mast-ps-")
        # 러너의 TEMP 는 8.3 짧은 이름일 수 있어 긴 경로로 푼다.
        self.root = Path(self.temp.name).resolve()
        self.profile = self.root / "Profile"
        self.bin = self.root / "bin"
        self.profile.mkdir()
        self.bin.mkdir()
        self.state = self.profile / ".mast"

    def tearDown(self):
        self.temp.cleanup()

    def write_state(self, hint=None, prompt=None):
        """hint 와 prompt 는 파일 내용 그대로다. None 이면 만들지 않는다."""
        if prompt is not None:
            (self.state / "prompt").mkdir(parents=True, exist_ok=True)
            (self.state / "prompt" / "tab-42").write_bytes(prompt.encode())
        if hint is not None:
            (self.state / "resume").mkdir(parents=True, exist_ok=True)
            (self.state / "resume" / "tab-42").write_bytes(hint.encode())

    def run_tab(self, auto="", tab="42", tail="", agy=True):
        if agy:
            (self.bin / "agy.cmd").write_bytes(FAKE_AGY.encode())
        head = [
            f"$env:USERPROFILE = {literal(win(self.profile))}",
            f"$env:Path = {literal(SYSTEM_PATH)}",
            "Remove-Item Env:MAST_PROMPT_GEN -ErrorAction SilentlyContinue",
            f"$MastTab = {literal(tab)}",
            f"$MastBin = {literal(win(self.bin))}",
            "$MastCwd = ''",
            f"$MastAutoResume = {literal(auto)}",
        ]
        script = "\n".join(head) + "\n" + integration_body() + tail + "\n"
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            capture_output=True, timeout=120,
        )
        output = (result.stdout + result.stderr).decode("utf-8", "replace")
        self.assertEqual(result.returncode, 0, output)
        return output

    def agent_log(self):
        log = self.profile / "agent-log"
        return log.read_text().splitlines() if log.exists() else []

    def hint_lines(self):
        return (self.state / "resume" / "tab-42").read_bytes().decode().split("\n")

    def test_auto_resume_off_offers_the_hint_and_never_runs_it(self):
        self.write_state(f"{HINT}\n1\nold-1\n", "old-1\n")
        output = self.run_tab(auto="")
        self.assertIn(f"[mast] resume previous agent: {HINT}", output)
        self.assertNotIn("auto-resume", output)
        self.assertEqual(self.agent_log(), [])

    def test_a_matching_hint_runs_once_under_the_new_generation(self):
        self.write_state(f"{HINT}\n1\nold-1\n", "old-1\n")
        output = self.run_tab(auto="1", tail="prompt | Out-Null; 'GEN:' + $env:MAST_PROMPT_GEN")
        log = self.agent_log()
        self.assertEqual(len(log), 1, output)
        match = re.fullmatch(rf"--conversation {TOKEN} gen=(\d+-\d+)-1 *", log[0])
        self.assertIsNotNone(match, log[0])
        nonce = match.group(1)
        self.assertIn(f"[mast] auto-resume: {HINT}", output)
        self.assertNotIn("resume previous agent", output)
        # 실행 직전 3행을 이번 세대로 바꾸고, 다음 프롬프트는 새 세대를 기록한다.
        self.assertEqual(self.hint_lines(), [HINT, "1", f"{nonce}-1", ""])
        self.assertIn(f"GEN:{nonce}-2", output)
        self.assertEqual((self.state / "prompt" / "tab-42").read_text(), f"{nonce}-2\n")

    def test_a_session_that_ended_normally_is_offered_but_not_run(self):
        # 힌트를 쓴 뒤 프롬프트가 한 번 더 나왔다: agy 가 정상 종료한 세션이다.
        self.write_state(f"{HINT}\n1\nold-1\n", "old-2\n")
        output = self.run_tab(auto="1")
        self.assertIn(f"[mast] resume previous agent: {HINT}", output)
        self.assertNotIn("auto-resume", output)
        self.assertEqual(self.agent_log(), [])

    def test_hints_without_a_generation_or_with_a_bad_time_are_offered_but_not_run(self):
        for hint in (f"{HINT}\n1\n", f"{HINT}\nnow\nold-1\n", f"{HINT}\n1\nold-1\nextra\n"):
            with self.subTest(hint=hint):
                self.write_state(hint, "old-1\n")
                output = self.run_tab(auto="1")
                self.assertIn(f"[mast] resume previous agent: {HINT}", output)
                self.assertEqual(self.agent_log(), [])

    def test_hints_of_another_shape_are_neither_offered_nor_run(self):
        hints = {
            "another agent": "claude --resume abc\n1\nold-1\n",
            "metacharacter token": "agy --conversation bad;calc\n1\nold-1\n",
            "space in token": "agy --conversation a b\n1\nold-1\n",
            "token of 97 characters": "agy --conversation %s\n1\nold-1\n" % ("a" * 97),
            "carriage return": f"{HINT}\r\n1\r\nold-1\r\n",
            "no final newline": f"{HINT}\n1\nold-1",
            "empty": "",
        }
        for name, hint in hints.items():
            with self.subTest(name=name):
                self.write_state(hint, "old-1\n")
                output = self.run_tab(auto="1")
                self.assertNotIn("resume previous agent", output)
                self.assertNotIn("auto-resume", output)
                self.assertEqual(self.agent_log(), [])

    def test_each_prompt_records_and_exports_a_new_generation(self):
        output = self.run_tab(tail="prompt | Out-Null; 'A:' + $env:MAST_PROMPT_GEN; prompt | Out-Null; 'B:' + $env:MAST_PROMPT_GEN")
        first = re.search(r"A:(\d+-\d+)-1", output)
        self.assertIsNotNone(first, output)
        self.assertIn(f"B:{first.group(1)}-2", output)
        self.assertEqual((self.state / "prompt" / "tab-42").read_text(), f"{first.group(1)}-2\n")

    def test_an_unwritable_generation_is_reported_once_and_not_exported(self):
        (self.state / "prompt" / "tab-42").mkdir(parents=True)
        output = self.run_tab(tail="prompt | Out-Null; prompt | Out-Null; 'GEN:[' + $env:MAST_PROMPT_GEN + ']'")
        self.assertEqual(output.count("auto-resume unavailable: cannot write"), 1, output)
        self.assertIn("GEN:[]", output)

    def test_a_tab_without_an_id_records_nothing(self):
        output = self.run_tab(tab="", tail="prompt | Out-Null; 'GEN:[' + $env:MAST_PROMPT_GEN + ']'")
        self.assertIn("GEN:[]", output)
        self.assertFalse(self.state.exists())

    def test_runs_are_admitted_at_least_three_seconds_apart(self):
        output = self.run_tab(tail=(
            "$w = [Diagnostics.Stopwatch]::StartNew(); $a = MastAutoResumeAdmit 'one'; $b = MastAutoResumeAdmit 'two'; "
            "'ADMIT:{0},{1} ELAPSED:{2:F1}' -f $a, $b, $w.Elapsed.TotalSeconds"
        ))
        match = re.search(r"ADMIT:True,True ELAPSED:([\d.]+)", output)
        self.assertIsNotNone(match, output)
        self.assertGreaterEqual(float(match.group(1)), 2.5)
        self.assertIn("auto-resume queued: two (Ctrl+C to cancel)", output)
        self.assertNotIn("auto-resume queued: one", output)
        self.assertRegex((self.state / "auto-resume.lock").read_text(), r"^\d+$")

    def test_an_unusable_queue_skips_the_run_and_keeps_the_manual_hint(self):
        self.write_state(f"{HINT}\n1\nold-1\n", "old-1\n")
        (self.state / "auto-resume.lock").mkdir()
        output = self.run_tab(auto="1")
        self.assertIn("auto-resume skipped: queue state unavailable", output)
        self.assertIn(f"[mast] resume previous agent: {HINT}", output)
        self.assertEqual(self.agent_log(), [])

    def test_a_missing_agy_keeps_the_manual_hint(self):
        self.write_state(f"{HINT}\n1\nold-1\n", "old-1\n")
        output = self.run_tab(auto="1", agy=False)
        self.assertIn("auto-resume skipped: agy is not on PATH", output)
        self.assertIn(f"[mast] resume previous agent: {HINT}", output)


if __name__ == "__main__":
    unittest.main()
