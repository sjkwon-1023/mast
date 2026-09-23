#!/usr/bin/env python3
"""멱등한 네이티브 에이전트 연결. Mast 소유 통합만 교체한다.

셸 프로필은 절대 수정하지 않는다. 기존의 형식이 잘못된 에이전트 설정이나 사용자 소유
에이전트 설정은 보존하고, 오류는 호스트가 ~/.mast/setup.log 에 기록한다.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import tomllib

HOME = Path.home()
MAST = HOME / ".mast"
BIN = MAST / "bin"
VERSION = "1"


def atomic(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".mast-install-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def bounded_run(args, seconds=8):
    # 깨진 버전 shim 때문에 자식이 우리 출력 파이프를 연 채 남으면 안 된다.
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=seconds)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        try:
            process.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            # 다른 세션으로 빠져나간 자손이 파이프를 쥐고 있어도 setup 은 끝나야 한다.
            process.stdout.close()
            process.wait()
        raise ValueError("timed out: " + str(args[0]))
    return process.returncode, output.decode("utf-8", "replace")


def candidates(name):
    paths = [shutil.which(name), str(HOME / ".local/bin" / name),
             "/opt/homebrew/bin/" + name, "/usr/local/bin/" + name,
             str(HOME / ".volta/bin" / name), str(HOME / ".bun/bin" / name),
             str(HOME / ".npm-global/bin" / name)]
    if name == "claude":
        paths.append(str(HOME / ".claude/local/claude"))
    if name == "opencode":
        paths.append(str(HOME / ".opencode/bin/opencode"))
    paths += [str(path) for path in (HOME / ".nvm/versions/node").glob("*/bin/" + name)]
    seen = set()
    for path in paths:
        if not path or not os.path.isfile(path) or not os.access(path, os.X_OK):
            continue
        resolved = os.path.realpath(path)
        if resolved not in seen:
            seen.add(resolved)
            yield path


def claude_dispatcher_supported():
    for path in candidates("claude"):
        try:
            code, output = bounded_run([path, "--version"], seconds=2)
            version = re.search(r"\b(\d+)\.(\d+)\.(\d+)\b", output)
            if code or not version or tuple(map(int, version.groups())) < (2, 1, 118):
                print("Claude approval tracking needs a readable Claude Code 2.1.118+; status hooks only: " + path)
                return False
        except (OSError, ValueError) as error:
            print(str(error))
            return False
    return True


def merge(args):
    code, output = bounded_run([sys.executable, "-I", str(BIN / "mast-hooks-merge.py")] + args)
    if output.strip():
        print(output.strip())
    if code:
        raise ValueError("agent settings were not merged (exit %d)" % code)


def skills():
    targets = [(HOME / ".claude/skills/mast", "mast-skill.md"),
               (HOME / ".claude/skills/mast-send", "mast-send-skill.md")]
    if (HOME / ".codex").is_dir():
        targets.append((HOME / ".codex/skills/mast", "mast-skill.md"))
    for directory, source in targets:
        # 기존 skill 디렉터리 symlink 를 따라 무관한 트리로 들어가지 않는다.
        if directory.is_symlink():
            raise ValueError("refusing symlinked skill directory: " + str(directory))
        atomic(directory / "SKILL.md", (BIN / source).read_bytes(), 0o644)


def codex_notify():
    path = HOME / ".codex/config.toml"
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8")
    document = tomllib.loads(text)
    if "notify" in document:
        print("Codex: keeping existing notify configuration")
        return
    value = ["/bin/bash", "-c", 'exec "$HOME/.mast/bin/mast-codex-notify.sh" "$0"']
    merged = "# mast: turn-completion notification; delete this entry to opt out\nnotify = %s\n\n%s" % (json.dumps(value), text)
    if tomllib.loads(merged).get("notify") != value:
        raise ValueError("refusing to alter Codex root TOML configuration")
    backup = path.with_name(path.name + ".mast-before-macos")
    if not backup.exists():
        atomic(backup, path.read_bytes(), path.stat().st_mode & 0o777)
    atomic(path, merged.encode("utf-8"), path.stat().st_mode & 0o777)


def opencode_plugin():
    config = Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config")
    target = config / "opencode/plugins/mast.js"
    owner_file = MAST / "opencode-plugin-owner.json"
    source = (BIN / "mast-opencode-plugin.js").read_bytes()
    digest = hashlib.sha256(source).hexdigest()
    owner = json.loads(owner_file.read_text()) if owner_file.exists() else {}
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError("OpenCode plugin is not a regular file; left unchanged: " + str(target))
    hashes = [digest]
    if target.exists():
        current = hashlib.sha256(target.read_bytes()).hexdigest()
        if owner.get("path") != str(target) or current not in owner.get("hashes", []):
            raise ValueError("OpenCode plugin is user-owned; left unchanged: " + str(target))
        if current == digest:
            return
        hashes.append(current)
    atomic(owner_file, json.dumps({"path": str(target), "hashes": hashes}).encode())
    atomic(target, source, 0o644)
    print("OpenCode: installed native-compatible Mast plugin")


def main(args):
    if args not in ([], ["--skills-only"]):
        raise ValueError("unknown setup arguments")
    errors = []
    # skill 설치 실패(예: symlink 로 된 skill 디렉터리)는 모아서 끝에 보고하고, 에이전트 연결은 계속한다.
    try:
        skills()
    except (OSError, ValueError) as error:
        errors.append("skills: " + str(error))
    if not args:
        connect_agents(errors)
    for error in errors:
        print(error, file=sys.stderr)
    return 1 if errors else 0


def connect_agents(errors):
    for agent in ("claude", "codex", "opencode"):
        marker = MAST / (".setup-macos-v%s-%s" % (VERSION, agent))
        if marker.exists() or (MAST / ("no-" + agent + "-hooks")).exists():
            continue
        # 이번 실행 뒤에 에이전트가 설치되면 다음 앱 실행에서 다시 시도한다.
        if not list(candidates(agent)) and not (HOME / ("." + agent)).is_dir():
            continue
        try:
            if agent == "claude":
                flags = [] if claude_dispatcher_supported() else ["--no-dispatcher"]
                merge(["claude", str(HOME / ".claude/settings.json"),
                       '"$HOME/.mast/bin/mast-notify.sh"',
                       '"$HOME/.mast/bin/mast-claude-hook.sh"'] + flags)
            elif agent == "codex":
                codex_notify()
                merge(["codex", str(HOME / ".codex/hooks.json"), "--config",
                       str(HOME / ".codex/config.toml"), "--trust-notice", "launch"])
            else:
                opencode_plugin()
            atomic(marker, b"native agent integration installed\n")
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            errors.append(agent + ": " + str(error))


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, ValueError) as error:
        print("mast setup: " + str(error), file=sys.stderr)
        sys.exit(1)
