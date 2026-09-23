#!/usr/bin/env python3
"""mast 에이전트 훅 디스패처. Claude Code·Codex 훅 이벤트를 탭 상태 OSC 777 로 바꾼다.

진입점 `mast-claude-hook.sh`·`mast-codex-hook.sh` 가 `mast-python -I` 로 `claude`/`codex`
모드를 실행하고, `mast-codex-notify.sh` 가 `codex-notify <ownership> <payload>` 로 부른다.
Python 3.8 표준 라이브러리만 쓴다. 설치 기기의 python3 가 그 이상이라는 것만 보장되기 때문이다.

B 모드 설정은 `~/.mast/` 아래 마커 파일의 존재 여부다(내용은 읽지 않는다). 프로비저닝은
`touch`/`rm` 만 하면 되고, 설정 파일 형식을 따로 두지 않는다.
  - `codex-needs-input-off`: Codex PermissionRequest 로 needsInput 을 보내지 않는다(자동 승인
    오탐을 받아들이지 않는 사용자용. 훅 정의는 그대로라 켜고 끌 때 재신뢰가 필요 없다).
  - `claude-pairing-off`: Claude Post* 가 대기 짝짓기 없이 running 을 보낸다.
  - `no-codex-hooks`: Codex 훅 opt-out. 훅은 아무것도 하지 않고 notify 는 상태 없이 idle 을 보낸다.

`claude`/`codex` 모드는 모든 경로에서 stdout 0 byte·exit 0 이다. 두 에이전트 모두 exit 2 를
deny/block 으로 해석한다. `codex-notify` 만은 판정을 끝내지 못하고 죽었을 때 exit 1 을 내서
호출한 bash 스크립트가 기존 idle 방출로 fallback 하게 한다(notify 는 Codex 가 결과를 보지 않는
spawn 이다, codex-rs/hooks/src/legacy_notify.rs:61-69).
"""

import contextlib
import fcntl
import hashlib
import json
import os
import re
import signal
import sys
import time

STATE_VERSION = 1
PREFIX_BYTES = 1024 * 1024
TAIL_BYTES = 4 * 1024
STATE_BYTES = 32 * 1024
DIAG_BYTES = 1024
CONFIG_BYTES = 1024 * 1024
MAX_RECORDS = 64
MAX_ENDED = 8
MAX_SESSIONS = 8
BODY_CHARS = 500
SUMMARY_CHARS = 160
ID_CHARS = 96
TTY_HOPS = 8

# 훅 timeout 안에 반드시 끝나야 한다. Codex 는 timeout 에 process group 을 SIGKILL 하므로
# (codex-rs/hooks/src/engine/command_runner.rs:333-347) OSC 쓰기 도중 잘릴 수 있다. 반대로 lock 을
# 못 잡으면 그 이벤트의 상태 전이가 통째로 사라지므로 timeout 이 허락하는 만큼은 기다린다.
# 기동(bash 진입점 + python) ~0.1s, stdin ≤0.5s, 방출 ≤0.7s(쓰기 0.5 + BEL 0.2) 기준:
#   Codex 동기 5s(UPS/Pre/Post/Stop/SubagentStop): 0.1 + 0.5 + lock 3.0 + 0.7 = 4.3s
#   Codex Interrupt 3s:                              0.1 + 0.5 + lock 1.5 + 0.7 = 2.8s
#   Codex async PermissionRequest 10s: 0.1 + 0.5 + lock 2.5 + hold-off 2.0 + lock 2.5 + 0.7 = 8.3s
# Claude command 훅 timeout 기본값은 600s 지만(hooks.md "timeout") 훅이 끝날 때까지 도구 결과를
# 붙잡으므로 Codex 동기 예산을 같이 쓴다. codex-notify 는 Codex 가 기다리지 않는 spawn 이다.
STDIN_SECONDS = 0.5
SYNC_LOCK_SECONDS = 3.0
INTERRUPT_LOCK_SECONDS = 1.5
ASYNC_LOCK_SECONDS = 2.5
WRITE_SECONDS = 0.5
BEL_SECONDS = 0.2
HOLD_OFF_SECONDS = 2.0
RUNNING_DEDUP_SECONDS = 1.5
# 이보다 오래된 candidate 의 sleeper 는 확인 단계(hold-off + lock + 방출)를 이미 넘겼으니 죽은
# 것이다(lock timeout 으로 포기했거나 kill 됐다). 1.0s 는 부하로 sleep 이 늦게 깨는 여유다.
STALE_CANDIDATE_SECONDS = HOLD_OFF_SECONDS + ASYNC_LOCK_SECONDS + WRITE_SECONDS + BEL_SECONDS + 1.0

RUNNING = "mast:running"
NEEDS_INPUT = "mast:needsInput"
IDLE = "mast:idle"
ROOT = "root"
OPEN = "open"
CANDIDATE = "candidate"
EMITTED = "emitted"
CODEX_DEFAULT_BODY = "codex turn complete"
OWNERSHIPS = ("confirmed", "rejected", "unknown")

NEEDS_INPUT_OFF = "codex-needs-input-off"
PAIRING_OFF = "claude-pairing-off"
NO_CODEX_HOOKS = "no-codex-hooks"

CLAUDE_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "SubagentStop",
    "Stop",
)
CODEX_EVENTS = (
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "SubagentStop",
    "Stop",
    "Interrupt",
)
# 권한 UI 가 PostToolUse 전에 입력을 바꾸는 도구다(2.1.270 번들: 승인 뒤 `Ce=rMn(name,
# updatedInput,Ce)`/`Ce=DK(name,Ce)` 가 PostToolUse tool_input 이 된다 — AskUserQuestion 은 answers
# 가 붙고, ExitPlanMode 는 plan/planFilePath 가 빠지고, IDE 에서 고친 Edit 는 내용이 달라진다).
# 이름만으로 가장 오래된 대기를 풀어도 되는 근거가 둘로 갈린다.
#   - Edit·Write·NotebookEdit 는 isConcurrencySafe 를 정의하지 않아 빌더 기본값 `(e)=>!1` 이다.
#     직렬 실행이라 같은 이름의 앞선 대기는 창이 이미 닫힌 호출의 것이다.
#   - AskUserQuestion·ExitPlanMode 는 `isConcurrencySafe(){return!0}` 로 병렬일 수 있다. 대신
#     대화형 세션에서 checkPermissions 가 항상 "ask" 라 같은 이름의 Post 마다 자기 대기가 있다.
#     해제 순서가 틀려도 대기 개수(=running 억제 여부)는 맞다. 예외는 PreToolUse 훅이 allow +
#     updatedInput 으로 답한 호출(hooks.md "permissionDecision")이다.
# MultiEdit 는 2.1.270 에 도구로 존재하지 않는다.
INPUT_REWRITING_TOOLS = ("AskUserQuestion", "ExitPlanMode", "Edit", "Write", "NotebookEdit")
# 두 도구는 PermissionRequest 입력이 Pre/Post 입력과 모양이 달라 호출과 짝지을 수 없다
# (codex-rs/core/src/tools/approvals.rs:173-194,225-235, write_stdin.rs:124-130 은 Pre 없음).
CODEX_GAP_TOOLS = ("write_stdin", "request_permissions")

# Rust `char::is_whitespace`(Unicode White_Space) 집합. Python `str.strip()` 은 U+001C-U+001F 도
# 공백으로 보므로 apply_patch 정규화에 쓰면 Codex 와 결과가 달라진다.
RUST_WHITESPACE = (
    "\t\n\x0b\x0c\r \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007"
    "\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
)
PATCH_HEREDOC_OPENERS = ("<<EOF", "<<'EOF'", '<<"EOF"')

# xterm.js 는 UTF-8 로 풀린 C1(U+0080-U+009F)도 제어문자로 해석한다. U+009C(ST) 하나로
# OSC 가 일찍 끝나고 나머지 본문이 터미널 입력이 되므로 C0 와 함께 지운다.
CONTROL_RE = re.compile("[\x00-\x1f\x7f-\x9f]")
WHITESPACE_RE = re.compile(r"[ \t\n\r]*")
TAB_RE = re.compile(r"[0-9]{1,12}")
TOOL_USE_ID_RE = re.compile(rb'"tool_use_id"\s*:\s*"((?:[^"\\]|\\.){0,512})"')
AUTO_REVIEW_RE = re.compile(
    r"""^[ \t]*approvals_reviewer[ \t]*=[ \t]*["'](?:auto_review|guardian_subagent)["']"""
)

EMISSION_ATTEMPTED = [False]


class Deadline(Exception):
    pass


def _raise_deadline(_signum, _frame):
    raise Deadline()


@contextlib.contextmanager
def deadline(seconds):
    # blocking syscall 을 끊는 유일한 수단이다. PEP 475 이후 핸들러가 예외를 던지지 않으면
    # os.write/os.read/flock 이 EINTR 을 스스로 재시도해 deadline 이 무의미해진다.
    previous = signal.signal(signal.SIGALRM, _raise_deadline)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def mast_home():
    return os.path.join(os.environ.get("HOME") or os.path.expanduser("~"), ".mast")


def marker(name):
    return os.path.exists(os.path.join(mast_home(), name))


def tab_id():
    tab = os.environ.get("MAST_TAB", "")
    return tab if TAB_RE.fullmatch(tab) else None


def ident(value):
    if not isinstance(value, str) or not value:
        return None
    if len(value) <= ID_CHARS:
        return value
    return "sha256:" + hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()[:40]


def digest(*parts):
    hasher = hashlib.sha256()
    for part in parts:
        data = part.encode("utf-8", "surrogatepass")
        hasher.update(b"%d:" % len(data))
        hasher.update(data)
    return hasher.hexdigest()[:32]


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def clean_text(text, limit):
    return CONTROL_RE.sub(" ", text).replace(";", ",")[:limit]


def first_line(text):
    return text.split("\n", 1)[0] if isinstance(text, str) else ""


def end_body(message, default):
    body = clean_text(first_line(message), BODY_CHARS)
    return body if body.strip() else default


def read_stdin():
    prefix = bytearray()
    tail = bytearray()
    complete = False
    try:
        with deadline(STDIN_SECONDS):
            while True:
                chunk = os.read(0, 65536)
                if not chunk:
                    complete = True
                    break
                room = PREFIX_BYTES - len(prefix)
                if room > 0:
                    prefix += chunk[:room]
                    chunk = chunk[room:]
                if chunk:
                    tail += chunk
                    if len(tail) > TAIL_BYTES:
                        del tail[:-TAIL_BYTES]
    except (Deadline, OSError):
        pass
    return bytes(prefix), bytes(tail), complete


def parse_payload(prefix, tail, complete):
    text = prefix.decode("utf-8", "replace")
    if complete and not tail:
        try:
            value = json.loads(text)
        except ValueError:
            return None, False
        return (value if isinstance(value, dict) else None), False
    fields = scan_object_prefix(text)
    if "tool_use_id" not in fields:
        found = last_tool_use_id(prefix[-TAIL_BYTES:] + tail)
        if found is not None:
            fields["tool_use_id"] = found
    return fields, True


def scan_object_prefix(text):
    """잘린 JSON 객체에서 끝까지 들어온 최상위 필드만 순서대로 꺼낸다.

    두 에이전트 모두 큰 필드(tool_response)를 식별 필드 뒤에 직렬화한다
    (codex-rs/hooks/src/schema.rs:325-392, Claude Code 2.1.270 번들의 PostToolUse 입력 객체).
    """
    decoder = json.JSONDecoder()
    fields = {}
    index = WHITESPACE_RE.match(text, 0).end()
    if text[index:index + 1] != "{":
        return fields
    index += 1
    while True:
        index = WHITESPACE_RE.match(text, index).end()
        try:
            key, index = decoder.raw_decode(text, index)
        except ValueError:
            break
        index = WHITESPACE_RE.match(text, index).end()
        if not isinstance(key, str) or text[index:index + 1] != ":":
            break
        index = WHITESPACE_RE.match(text, index + 1).end()
        try:
            value, index = decoder.raw_decode(text, index)
        except ValueError:
            break
        fields[key] = value
        index = WHITESPACE_RE.match(text, index).end()
        if text[index:index + 1] != ",":
            break
        index += 1
    return fields


def last_tool_use_id(data):
    matches = TOOL_USE_ID_RE.findall(data)
    if not matches:
        return None
    try:
        value = json.loads(b'"' + matches[-1] + b'"')
    except ValueError:
        return None
    return value if isinstance(value, str) else None


class Event(object):
    def __init__(self, payload, truncated):
        self.payload = payload
        self.truncated = truncated
        name = payload.get("hook_event_name")
        self.name = name if isinstance(name, str) else None
        self.session = ident(payload.get("session_id"))
        self.scope = ident(payload.get("agent_id")) or ROOT
        self.turn = ident(payload.get("turn_id"))
        tool = payload.get("tool_name")
        self.tool = tool if isinstance(tool, str) else None
        self.tool_use_id = ident(payload.get("tool_use_id"))


def open_terminal():
    flags = os.O_WRONLY | os.O_NOCTTY | getattr(os, "O_CLOEXEC", 0)
    try:
        return os.open("/dev/tty", flags)
    except OSError:
        pass
    if sys.platform == "darwin":
        # 분리된 훅은 Mast 실행 래퍼가 준 slave TTY 를 그대로 물려받는다.
        # macOS 에는 /proc 이 없다. 물려받은 임의 경로는 절대 열지 않는다:
        # symlink 를 따라가지 않고, 같은 사용자의 실제 터미널 장치여야 한다.
        target = os.environ.get("MAST_TTY", "")
        if os.environ.get("MAST") != "1" or not re.fullmatch(r"/dev/ttys[0-9]+", target):
            return None
        descriptor = None
        try:
            import stat as stat_module
            descriptor = os.open(target, flags | getattr(os, "O_NOFOLLOW", 0))
            meta = os.fstat(descriptor)
            if stat_module.S_ISCHR(meta.st_mode) and meta.st_uid == os.geteuid() and os.isatty(descriptor):
                return descriptor
        except OSError:
            pass
        if descriptor is not None:
            os.close(descriptor)
        return None
    # Claude Code 훅 프로세스에는 controlling tty 가 없어 /dev/tty 가 ENXIO 다. mast-notify.sh 와
    # 같은 규율로 조상 8단계까지 fd 0/1/2 가 가리키는 pts 를 찾는다.
    pid = os.getpid()
    for _ in range(TTY_HOPS):
        if pid is None or pid <= 1:
            break
        for fd in (0, 1, 2):
            try:
                target = os.readlink("/proc/%d/fd/%d" % (pid, fd))
            except OSError:
                continue
            if target.startswith("/dev/pts/"):
                try:
                    return os.open(target, flags)
                except OSError:
                    continue
        pid = parent_pid(pid)
    return None


def parent_pid(pid):
    try:
        with open("/proc/%d/stat" % pid, "rb") as handle:
            stat = handle.read()
    except OSError:
        return None
    # comm 에 공백·괄호가 들어갈 수 있어 마지막 ')' 뒤에서 state, ppid 순으로 읽는다.
    fields = stat[stat.rfind(b")") + 1:].split()
    try:
        return int(fields[1])
    except (IndexError, ValueError):
        return None


def write_bytes(fd, data, seconds):
    written = 0
    try:
        with deadline(seconds):
            while written < len(data):
                written += os.write(fd, data[written:])
    except Deadline:
        return "timeout"
    except OSError:
        return "error"
    return "ok"


def write_osc(token, body):
    # O_NONBLOCK 은 쓰지 않는다. EAGAIN·부분 쓰기로 `ESC]777` 만 남으면 뒤따르는 에이전트 출력이
    # OSC payload 로 삼켜진다. blocking write 가 deadline 에 끊기면 부분 쓰기였을 수 있으므로
    # (핸들러가 os.write 반환 직후에 끼어들면 쓴 길이를 잃는다) BEL 종결을 한 번 더 시도한다.
    EMISSION_ATTEMPTED[0] = True
    data = ("\x1b]777;notify;%s;%s\x07" % (token, body)).encode("utf-8", "replace")
    fd = open_terminal()
    if fd is None:
        return False
    try:
        status = write_bytes(fd, data, WRITE_SECONDS)
        if status == "timeout":
            write_bytes(fd, b"\x07", BEL_SECONDS)
        return status == "ok"
    finally:
        os.close(fd)


def emit(tab, state, token, body="", dedup=False):
    now = time.monotonic()
    last = state.get("emit")
    if (
        dedup
        and last is not None
        and last["token"] == token
        and last["ok"]
        and 0 <= now - last["at"] < RUNNING_DEDUP_SECONDS
    ):
        return True
    ok = write_osc(token, clean_text(body, BODY_CHARS))
    state["emit"] = {"token": token, "at": now, "ok": ok}
    if not ok:
        tab.diag("could not write %s to the terminal" % token)
    return ok


def fresh_state():
    return {
        "version": STATE_VERSION,
        "seq": 0,
        "emit": None,
        "claude": {"awaiting": [], "sessions": []},
        "codex": None,
    }


def next_seq(state):
    state["seq"] += 1
    return state["seq"]


def _require(condition):
    if not condition:
        raise ValueError("unexpected state shape")


def _is_opt_str(value):
    return value is None or isinstance(value, str)


def check_state(state):
    _require(isinstance(state, dict) and state.get("version") == STATE_VERSION)
    _require(isinstance(state.get("seq"), int))
    last = state.get("emit")
    _require(
        last is None
        or (
            isinstance(last, dict)
            and isinstance(last.get("token"), str)
            and isinstance(last.get("at"), (int, float))
            and isinstance(last.get("ok"), bool)
        )
    )
    claude = state.get("claude")
    _require(isinstance(claude, dict))
    _require(isinstance(claude.get("awaiting"), list) and isinstance(claude.get("sessions"), list))
    for item in claude["awaiting"]:
        _require(isinstance(item, dict))
        _require(all(isinstance(item.get(key), str) for key in ("session", "scope", "tool")))
        _require(_is_opt_str(item.get("fp")) and isinstance(item.get("seq"), int))
    for item in claude["sessions"]:
        _require(isinstance(item, dict) and isinstance(item.get("session"), str))
        _require(isinstance(item.get("active"), bool) and isinstance(item.get("seq"), int))
    codex = state.get("codex")
    if codex is None:
        return
    _require(isinstance(codex, dict) and isinstance(codex.get("records"), list))
    root = codex.get("root")
    _require(isinstance(root, dict) and isinstance(root.get("session"), str))
    _require(isinstance(root.get("ups_seq"), int) and isinstance(root.get("end_seq"), int))
    _require(_is_opt_str(root.get("ups_turn")) and _is_opt_str(root.get("end_turn")))
    _require(isinstance(root.get("end_body"), str) and isinstance(root.get("ended"), list))
    for item in root["ended"]:
        _require(isinstance(item, dict) and isinstance(item.get("turn"), str))
        _require(isinstance(item.get("handled"), bool))
    for record in codex["records"]:
        _require(isinstance(record, dict) and isinstance(record.get("scope"), str))
        _require(all(_is_opt_str(record.get(key)) for key in ("turn", "id", "fp", "summary")))
        _require(isinstance(record.get("seq"), int))
        _require(record.get("state") in (OPEN, CANDIDATE, EMITTED))
        armed = record.get("armed_at")
        _require(armed is None or isinstance(armed, (int, float)))
    _require(_is_opt_str(codex.get("prev_session")))


def dump_state(state):
    return json.dumps(state, separators=(",", ":"), sort_keys=True)


def evict_one(state):
    codex = state.get("codex")
    records = codex["records"] if codex else []
    for index, record in enumerate(records):
        if record["state"] == OPEN:
            del records[index]
            return True
    claude = state["claude"]
    for key in ("awaiting", "sessions"):
        if claude[key]:
            del claude[key][0]
            return True
    if records:
        del records[0]
        return True
    if codex and codex.get("prev_session"):
        codex["prev_session"] = None
        return True
    if codex and codex["root"]["ended"]:
        del codex["root"]["ended"][0]
        return True
    return False


class Tab(object):
    def __init__(self, tab, mode, event_name):
        self.dir = os.path.join(mast_home(), "agent-hooks")
        self.state_path = os.path.join(self.dir, "tab-%s.json" % tab)
        self.lock_path = os.path.join(self.dir, "tab-%s.lock" % tab)
        self.diag_path = os.path.join(self.dir, "tab-%s.diag" % tab)
        self.label = "%s/%s" % (mode, event_name or "-")

    def ensure_dir(self):
        try:
            os.makedirs(self.dir, 0o700)
        except FileExistsError:
            return
        os.chmod(self.dir, 0o700)

    def diag(self, message):
        # 진단은 최신 1건만 남긴다. 정상 경로에서 payload·명령 본문을 넣지 않는다.
        line = "%s %s: %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), self.label, message)
        self.replace_file(self.diag_path, line.encode("utf-8", "replace")[:DIAG_BYTES])

    def replace_file(self, path, data):
        temporary = "%s.tmp.%d" % (path, os.getpid())
        try:
            self.ensure_dir()
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC, 0o600)
            try:
                view = memoryview(data)
                while view:
                    view = view[os.write(fd, view):]
            finally:
                os.close(fd)
            os.replace(temporary, path)
            return True
        except OSError:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            return False

    def transact(self, seconds, change, create=True):
        """lock 안에서 상태를 읽고 `change(state)` 를 적용해 바뀌었으면 쓴다. (잡았는지, 결과).

        `create=False` 는 lock 파일이 없으면 아무것도 만들지 않고 (False, None) 이다. 탭이 닫혀
        host 가 파일을 지운 뒤 깨어난 sleeper 가 고아 파일을 되살리지 않게 한다.
        """
        try:
            if create:
                self.ensure_dir()
                fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
            else:
                fd = os.open(self.lock_path, os.O_RDWR | os.O_CLOEXEC)
        except OSError as error:
            if create or not isinstance(error, FileNotFoundError):
                self.diag("cannot open the state lock (%s)" % error.strerror)
            return False, None
        try:
            try:
                with deadline(seconds):
                    fcntl.flock(fd, fcntl.LOCK_EX)
            except Deadline:
                self.diag("state lock not acquired within %.1fs" % seconds)
                return False, None
            state, before = self.load()
            result = change(state)
            # 파일이 없던 탭에서 아무것도 기록할 게 없으면 만들지 않는다. 닫힌 탭의 늦은 훅이
            # 빈 상태 파일을 되살리는 것을 막는다.
            if before is None and state == fresh_state():
                return True, result
            text = self.fit(state)
            if text != before and not self.replace_file(self.state_path, text.encode("ascii")):
                self.diag("could not write the state file")
            return True, result
        finally:
            os.close(fd)

    def load(self):
        try:
            with open(self.state_path, "rb") as handle:
                data = handle.read(STATE_BYTES + 1)
        except FileNotFoundError:
            return fresh_state(), None
        except OSError as error:
            self.diag("cannot read the state file (%s); starting fresh" % error.strerror)
            return fresh_state(), None
        try:
            if len(data) > STATE_BYTES:
                raise ValueError("oversized")
            text = data.decode("ascii")
            state = json.loads(text)
            check_state(state)
        except ValueError:
            self.diag("state file unreadable; reinitialized")
            return fresh_state(), None
        return state, text

    def fit(self, state):
        text = dump_state(state)
        evicted = 0
        while len(text) > STATE_BYTES and evict_one(state):
            evicted += 1
            text = dump_state(state)
        if evicted:
            self.diag("state exceeded %d bytes; evicted %d oldest entries" % (STATE_BYTES, evicted))
        return text


def claude_fingerprint(event):
    if "tool_input" not in event.payload:
        return None
    return digest(event.tool or "", canonical(event.payload["tool_input"]))


def set_session_active(state, session, active):
    sessions = [item for item in state["claude"]["sessions"] if item["session"] != session]
    sessions.append({"session": session, "active": active, "seq": next_seq(state)})
    state["claude"]["sessions"] = sessions[-MAX_SESSIONS:]


def session_active(state, session):
    return any(item["session"] == session and item["active"] for item in state["claude"]["sessions"])


def mark_root_working(state, event):
    # Stop 훅 block 으로 이어진 턴(/goal 등)은 UserPromptSubmit 없이 계속된다(2.1.270 번들
    # `transition:{reason:"stop_hook_blocking"}`). root 의 도구 이벤트가 곧 턴이 살아 있다는 증거다.
    # sync Post·Batch 훅은 다음 모델 호출 전에 끝나므로 진짜 Stop 뒤에 도착하지 않는다.
    if event.scope == ROOT and not session_active(state, event.session):
        set_session_active(state, event.session, True)


def drop_awaiting(state, keep):
    claude = state["claude"]
    before = len(claude["awaiting"])
    claude["awaiting"] = [item for item in claude["awaiting"] if keep(item)]
    return len(claude["awaiting"]) < before


def claude_session_start(tab, state, event):
    # `claude --resume <id>`·`--continue` 는 같은 session id 로 이어간다(2.1.270 번들: resume 의
    # SessionStart 는 `sessionId:!r.forkSession&&QIt(O,r)?O:X()`). 이전 프로세스가 WSL 절전·kill 로
    # SubagentStop 없이 죽었으면 그 서브에이전트 대기는 root UPS 가 남기는 대상이라 이어간 세션
    # 내내 root running 을 막는다. 새로 뜬 프로세스(startup·resume)에는 그 서브에이전트가 없다.
    # clear 는 새 id 를 발급해(`oqn` 의 `s=randomUUID()`) 지울 대기가 없는데, 훅이 지연 실행되어
    # (`deferHookMessages`) 곧바로 제출된 프롬프트의 UPS 뒤에 도착하면 막 활성화된 세션을 되돌린다.
    # compact 는 서브에이전트 창이 열린 채 세션 중간에 일어난다. fork 는 새 id 라 죽은 세션의
    # 대기는 다음 root UPS 가 다른 session 대기로 비운다.
    if event.payload.get("source") not in ("startup", "resume"):
        return
    drop_awaiting(state, lambda item: item["session"] != event.session)
    # 기록이 없는 session 은 이미 비활성으로 읽힌다. 새 세션마다 상태 파일을 만들지 않게 한다.
    if session_active(state, event.session):
        set_session_active(state, event.session, False)


def claude_prompt(tab, state, event):
    if event.scope != ROOT:
        return
    # payload 로는 사람 입력, 턴 중간에 fold 된 대기열 프롬프트, cron·/loop·ScheduleWakeup wakeup,
    # task-notification 을 가를 수 없다(2.1.270 번들 `PBe` 는 공통 필드와 prompt 만 싣는다). 규칙은
    # 발화 시점에서 나온다. 턴 중간 fold 는 PostToolBatch 뒤 배치 경계에서만(`Fcs`), idle 드레인은 root
    # 가 idle 일 때만 UPS 를 띄우므로 이때 root 권한 창은 열려 있을 수 없다. 서브에이전트 창은 둘 다
    # 막지 않으니 그 대기는 남기고 PostToolBatch·SubagentStop 이 거둔다. SubagentStop 은 중단된
    # 서브에이전트에도 발화한다(runAgent finally 의 "SubagentStop on interrupted query").
    # 다른 session 대기까지 비워야 Ctrl+C 로 끝난 이전 세션의 대기가 새 세션의 running 을 영구히
    # 막지 않는다. 같은 탭 Bash 안의 `claude -p` 가 바깥 대기를 지우는 것은 알려진 한계다.
    drop_awaiting(state, lambda item: item["session"] == event.session and item["scope"] != ROOT)
    # 사람 입력이 아니어도 UPS 는 query 할 명령에만 발화하므로(`G2e` 의 shouldQuery 검사, idle 드레인도
    # 같은 검사 뒤에 훅을 부른다) root 턴이 실제로 돌고 있다. 비활성으로 두면 그 사이 SubagentStop 이
    # idle 을 낸다.
    set_session_active(state, event.session, True)


def claude_permission(tab, state, event):
    mark_root_working(state, event)
    fingerprint = claude_fingerprint(event)
    if fingerprint is None:
        tab.diag("tool_input unreadable; waiting recorded without a fingerprint")
    awaiting = state["claude"]["awaiting"]
    awaiting.append(
        {
            "session": event.session,
            "scope": event.scope,
            "tool": ident(event.tool) or "",
            "fp": fingerprint,
            "seq": next_seq(state),
        }
    )
    if len(awaiting) > MAX_RECORDS:
        del awaiting[0]
        tab.diag("waiting limit reached; evicted the oldest")


def claude_release(tab, state, event):
    tool = ident(event.tool) or ""
    awaiting = state["claude"]["awaiting"]
    same_call = [
        item
        for item in awaiting
        if item["session"] == event.session and item["scope"] == event.scope and item["tool"] == tool
    ]
    fingerprint = claude_fingerprint(event)
    if fingerprint is None:
        if same_call:
            awaiting.remove(same_call[0])
            tab.diag("tool_input unreadable; released the oldest waiting call of that tool")
        return
    # 병렬로 권한을 묻는 concurrency-safe 도구(WebFetch 등)의 형제 호출을 구분하려면 입력까지
    # 같아야 해제한다. 입력을 모르고 기록된 대기는 같은 도구의 가장 오래된 것으로 대신 해제한다.
    for candidates in (
        [item for item in same_call if item["fp"] == fingerprint],
        [item for item in same_call if item["fp"] is None],
        same_call if tool in INPUT_REWRITING_TOOLS else [],
    ):
        if candidates:
            awaiting.remove(candidates[0])
            return


def claude_post(tab, state, event):
    # is_interrupt 도 다른 실패와 같게 다룬다. 도구 실행 중 Esc 는 이 훅을 부르지 않고(hooks.md
    # PostToolUseFailure "Cancelling a running tool does not fire this hook"), abort 된 신호로는 command
    # 훅을 띄우지도 않는다(2.1.270 번들 `if(m?.aborted)return`). true 는 턴이 계속되는 abort 계열 도구
    # 에러에서만 온다.
    mark_root_working(state, event)
    claude_release(tab, state, event)
    if not state["claude"]["awaiting"]:
        emit(tab, state, RUNNING, dedup=True)


def claude_batch(tab, state, event):
    # PostToolBatch 는 abort 되지 않은 배치가 모두 끝난 뒤 다음 모델 호출 전에 한 번 발화한다
    # (hooks.md "PostToolBatch"). Post 없이 끝난 거부·입력이 바뀐 호출의 대기를 여기서 거둔다.
    mark_root_working(state, event)
    drop_awaiting(state, lambda item: not (item["session"] == event.session and item["scope"] == event.scope))
    if not state["claude"]["awaiting"]:
        emit(tab, state, RUNNING, dedup=True)


def claude_subagent_stop(tab, state, event):
    if event.scope == ROOT:
        return
    removed = drop_awaiting(
        state, lambda item: not (item["session"] == event.session and item["scope"] == event.scope)
    )
    if removed and not state["claude"]["awaiting"]:
        if session_active(state, event.session):
            emit(tab, state, RUNNING, dedup=True)
        else:
            emit(tab, state, IDLE, "done")


def claude_stop(tab, state, event):
    if event.scope != ROOT:
        return
    drop_awaiting(state, lambda item: not (item["session"] == event.session and item["scope"] == ROOT))
    # 기록이 없는 session 은 이미 비활성으로 읽힌다. 닫힌 탭에 늦게 온 Stop 이 파일을 만들지 않게 한다.
    if session_active(state, event.session):
        set_session_active(state, event.session, False)


def claude_unpaired_post(tab, state, event):
    emit(tab, state, RUNNING, dedup=True)


CLAUDE_HANDLERS = {
    "SessionStart": claude_session_start,
    "UserPromptSubmit": claude_prompt,
    "PermissionRequest": claude_permission,
    "PostToolUse": claude_post,
    "PostToolUseFailure": claude_post,
    "PostToolBatch": claude_batch,
    "SubagentStop": claude_subagent_stop,
    "Stop": claude_stop,
}


def claude_hook(tab, event):
    if event.name not in CLAUDE_EVENTS:
        return
    if event.session is None:
        tab.diag("hook input has no session_id")
        return
    if marker(PAIRING_OFF):
        if event.name in ("PostToolUse", "PostToolUseFailure"):
            tab.transact(SYNC_LOCK_SECONDS, lambda state: claude_unpaired_post(tab, state, event))
        return
    handler = CLAUDE_HANDLERS[event.name]
    tab.transact(SYNC_LOCK_SECONDS, lambda state: handler(tab, state, event))


def rust_trim(text):
    return text.strip(RUST_WHITESPACE)


def rust_lines(text):
    # Rust `str::lines()`: '\n' 로 나누고, '\n' 앞의 '\r' 하나만 지운다. 마지막 개행 뒤 빈 조각은
    # 줄이 아니다. `splitlines()` 는 \x0b·\x1c·U+2028 등에서도 나눠 결과가 달라진다.
    if not text:
        return []
    parts = text.split("\n")
    trailing_newline = parts[-1] == ""
    if trailing_newline:
        parts.pop()
    lines = []
    for index, part in enumerate(parts):
        followed_by_newline = index < len(parts) - 1 or trailing_newline
        if followed_by_newline and part.endswith("\r"):
            part = part[:-1]
        lines.append(part)
    return lines


def normalize_patch(text):
    # PermissionRequest 는 `parse_patch` 가 정규화한 문자열, Pre/Post 는 모델 원문이다
    # (codex-rs/core/src/tools/handlers/apply_patch.rs:283-288,458-462,480-494 와
    # runtimes/apply_patch.rs:76-84). 양쪽을 parse_patch_text(apply-patch/src/parser.rs:193-201)
    # 와 lenient heredoc 제거(parser.rs:232-250)로 같은 형태로 만든다.
    lines = rust_lines(rust_trim(text))
    strict = (
        bool(lines)
        and rust_trim(lines[0]) == "*** Begin Patch"
        and rust_trim(lines[-1]) == "*** End Patch"
    )
    if (
        not strict
        and len(lines) >= 4
        and lines[0] in PATCH_HEREDOC_OPENERS
        and lines[-1].endswith("EOF")
    ):
        lines = lines[1:-1]
    return "\n".join(lines)


def codex_fingerprint(event):
    if "tool_input" not in event.payload:
        return None
    value = event.payload["tool_input"]
    tool = event.tool or ""
    if tool in ("Bash", "apply_patch"):
        # Bash PermissionRequest 는 {command, description?}, Pre/Post 는 {command} 다
        # (codex-rs/core/src/tools/sandboxing.rs:133-147, approvals.rs:166-172). network 승인도
        # 소유 exec 의 hook_command 를 command 로 싣는다(approvals.rs:216-224).
        command = value.get("command") if isinstance(value, dict) else None
        if not isinstance(command, str):
            return None
        return digest(tool, normalize_patch(command) if tool == "apply_patch" else command)
    # MCP 는 인자가 비면 양쪽 모두 {} 다(handlers/mcp.rs:499-505, approvals.rs:206-215).
    return digest(tool, canonical({} if value is None else value))


def codex_summary(event):
    tool = event.tool or "tool"
    value = event.payload.get("tool_input")
    text = tool
    if tool == "Bash" and isinstance(value, dict):
        description = value.get("description")
        if isinstance(description, str) and description.startswith("network-access "):
            text = "network access to " + description[len("network-access "):]
        elif isinstance(value.get("command"), str):
            text = first_line(value["command"])
    text = clean_text(text, SUMMARY_CHARS).strip()
    return text or tool


def codex_state(state, session):
    codex = state.get("codex")
    if codex is None or codex["root"]["session"] != session:
        # 이전 세션의 notify 는 Stop 훅 뒤 기다리지 않고 spawn 되어(codex-rs/core/src/session/turn.rs
        # :554-610, hooks/src/legacy_notify.rs:52-69) 다음 세션의 첫 UPS 보다 늦게 올 수 있다. 그
        # notify 를 알아보도록 직전 세션 하나만 남긴다.
        prev_session = codex["root"]["session"] if codex is not None else None
        codex = {
            "root": {
                "session": session,
                "ups_seq": 0,
                "ups_turn": None,
                "end_seq": 0,
                "end_turn": None,
                "end_body": CODEX_DEFAULT_BODY,
                "ended": [],
            },
            "records": [],
            "prev_session": prev_session,
        }
        state["codex"] = codex
    return codex


def root_active(root):
    return root["ups_seq"] > root["end_seq"]


def emitted_records(codex):
    return [record for record in codex["records"] if record["state"] == EMITTED]


def latest_summary(records):
    return max(records, key=lambda record: record["seq"])["summary"] or ""


def close_records(codex, closes):
    kept = []
    closed_emitted = False
    for record in codex["records"]:
        if closes(record):
            closed_emitted = closed_emitted or record["state"] == EMITTED
        else:
            kept.append(record)
    codex["records"] = kept
    return closed_emitted


def needs_input_shown(state):
    last = state.get("emit")
    return last is not None and last["token"] == NEEDS_INPUT and last["ok"]


def codex_decide(tab, state, codex, scope, screen_changed, released_emitted):
    emitted = emitted_records(codex)
    if emitted:
        # 확인 단계의 needsInput 쓰기가 막힌 pty 에서 실패했으면 다시 보낼 경로가 이것뿐이다.
        if screen_changed or not needs_input_shown(state):
            emit(tab, state, NEEDS_INPUT, latest_summary(emitted))
        return
    if root_active(codex["root"]) or scope == ROOT:
        emit(tab, state, RUNNING, dedup=True)
    elif released_emitted:
        emit(tab, state, IDLE, codex["root"]["end_body"])


def codex_prompt(tab, state, event):
    codex = codex_state(state, event.session)
    root = codex["root"]
    if event.scope != ROOT:
        closed = close_records(codex, lambda r: r["scope"] == event.scope and r["turn"] != event.turn)
        if closed:
            codex_decide(tab, state, codex, event.scope, False, True)
        return
    # 끝난 turn id 로 늦게 소비된 steer 는 새 턴이 아니다.
    if any(item["turn"] == event.turn for item in root["ended"]):
        return
    root["ups_seq"] = next_seq(state)
    root["ups_turn"] = event.turn
    # 서브에이전트 승인 창이 떠 있어도 queued 입력 자동 제출·steer 로 root UPS 가 발화한다
    # (codex-rs/tui/src/chatwidget/input_flow.rs:141-168). root scope 만 정리하고 나머지는 재주장한다.
    close_records(codex, lambda r: r["scope"] == ROOT)
    codex_decide(tab, state, codex, ROOT, True, False)


def codex_add_record(tab, codex, record):
    records = codex["records"]
    if len(records) >= MAX_RECORDS:
        for index, old in enumerate(records):
            if old["state"] == OPEN:
                del records[index]
                tab.diag("record limit reached; evicted the oldest open record")
                break
        else:
            tab.diag("record limit reached with no open record to evict; call not tracked")
            return
    records.append(record)


def codex_pre(tab, state, event):
    codex = codex_state(state, event.session)
    root = codex["root"]
    # 한 thread 는 한 번에 한 턴이라 다른 turn 의 기록은 죽은 기록이다.
    closed = close_records(codex, lambda r: r["scope"] == event.scope and r["turn"] != event.turn)
    resumed = False
    if event.scope == ROOT and event.turn == root["end_turn"] and not root_active(root):
        # Stop 훅 block 으로 UPS 없이 같은 턴이 이어졌다.
        root["ups_seq"] = next_seq(state)
        root["ups_turn"] = event.turn
        resumed = True
    codex_add_record(
        tab,
        codex,
        {
            "scope": event.scope,
            "turn": event.turn,
            "id": event.tool_use_id,
            "fp": codex_fingerprint(event),
            "seq": next_seq(state),
            "state": OPEN,
            "summary": None,
        },
    )
    # 다음 Pre 는 승인 해제 신호가 아니다. 병렬 형제 호출의 Pre 가 승인 창이 열린 채 도착한다
    # (codex-rs/core/src/tools/parallel.rs:148-156).
    if closed or resumed:
        codex_decide(tab, state, codex, event.scope, False, closed)


def codex_post(tab, state, event):
    codex = codex_state(state, event.session)
    record = None
    if event.tool_use_id is not None:
        # write_stdin poll 이 관측한 종료도 원래 exec_command 의 call id 로 온다
        # (codex-rs/core/src/tools/context.rs:390-402, write_stdin.rs:131-139).
        for candidate in codex["records"]:
            if candidate["scope"] == event.scope and candidate["id"] == event.tool_use_id:
                record = candidate
                break
    else:
        fingerprint = codex_fingerprint(event)
        matches = [
            r
            for r in codex["records"]
            if fingerprint is not None
            and r["scope"] == event.scope
            and r["turn"] == event.turn
            and r["fp"] == fingerprint
        ]
        if matches:
            record = max(matches, key=lambda r: r["seq"])
        tab.diag("PostToolUse without a readable tool_use_id; matched by fingerprint")
    released = False
    if record is not None:
        codex["records"].remove(record)
        released = record["state"] == EMITTED
    codex_decide(tab, state, codex, event.scope, False, released)


def codex_subagent_stop(tab, state, event):
    # ThreadSpawn 서브에이전트 턴이 정상 완료되면 발화한다(codex-rs/core/src/hook_runtime.rs:384-421,
    # session/turn.rs:554). 턴이 끝났으니 그 scope 의 기록은 모두 죽었다 — 승인 뒤 MCP isError·
    # handler 에러, 훅/Guardian 의 Denied 처럼 PostToolUse 가 없는 호출(tools/registry.rs:663-676)을
    # 여기서 거둔다. 정리 전용이다: idle 은 마지막 emitted 를 해제했고 root 가 끝나 있을 때만 decide()
    # 가 복원한다. 승인 Abort 는 턴을 TurnAborted 로 끝내(approvals.rs:460, turn.rs:615) 이 훅이 없다.
    codex = state.get("codex")
    if event.scope == ROOT or codex is None or codex["root"]["session"] != event.session:
        return
    before = len(codex["records"])
    closed_emitted = close_records(codex, lambda r: r["scope"] == event.scope)
    if len(codex["records"]) < before:
        codex_decide(tab, state, codex, event.scope, False, closed_emitted)


def codex_end(tab, state, event, body):
    codex = codex_state(state, event.session)
    root = codex["root"]
    root["end_seq"] = next_seq(state)
    root["end_turn"] = event.turn
    root["end_body"] = body
    close_records(codex, lambda r: r["scope"] == ROOT)
    emitted = emitted_records(codex)
    if emitted:
        handled = emit(tab, state, NEEDS_INPUT, latest_summary(emitted))
    else:
        handled = emit(tab, state, IDLE, body)
    ended = [item for item in root["ended"] if item["turn"] != event.turn]
    ended.append({"turn": event.turn, "handled": handled})
    root["ended"] = ended[-MAX_ENDED:]


def codex_stop(tab, state, event):
    codex_end(tab, state, event, end_body(event.payload.get("last_assistant_message"), CODEX_DEFAULT_BODY))


def codex_interrupt(tab, state, event):
    # root Esc 는 root task 만 abort 한다. 서브에이전트에는 Interrupt 훅이 없다
    # (codex-rs/core/src/hook_runtime.rs:491-493).
    codex_end(tab, state, event, "interrupted")


def auto_review_configured():
    # PermissionRequest 훅은 Guardian 리뷰보다 먼저 돈다(codex-rs/core/src/tools/approvals.rs:491-512).
    # 리뷰가 대개 2초를 넘겨 리뷰되는 모든 요청이 오탐이 되므로 끈다. guardian_subagent 는 같은 값의
    # 옛 이름이다(protocol/src/config_types.rs:187). 프로필·`-c` 오버라이드는 볼 수 없다.
    path = os.path.join(os.environ.get("HOME") or os.path.expanduser("~"), ".codex", "config.toml")
    try:
        with open(path, "rb") as handle:
            data = handle.read(CONFIG_BYTES)
    except OSError:
        return False
    for line in data.decode("utf-8", "replace").split("\n"):
        if line.lstrip().startswith("["):
            break
        if AUTO_REVIEW_RE.match(line):
            return True
    return False


def sleeper_alive(record, now):
    # time.monotonic() 은 Linux 에서 CLOCK_MONOTONIC 이라 프로세스 사이에 비교할 수 있다. 음수
    # 간격은 VM 재시작으로 시계가 초기화된 것이니 그 sleeper 도 이미 없다.
    armed = record.get("armed_at")
    return armed is not None and 0 <= now - armed < STALE_CANDIDATE_SECONDS


def codex_mark_candidate(tab, state, event, fingerprint, summary):
    codex = state.get("codex")
    records = codex["records"] if codex is not None and codex["root"]["session"] == event.session else []
    matches = [
        r
        for r in records
        if r["scope"] == event.scope and r["turn"] == event.turn and r["fp"] == fingerprint
    ]
    if not matches:
        tab.diag("PermissionRequest matched no pending tool call")
        return None
    # 순차 재시도(MCP isError 뒤 같은 인자 등)가 흔하므로 가장 최근 호출이다. 그 호출에 이미 살아 있는
    # sleeper 가 있으면(sandbox 재시도의 두 번째 요청, approvals.rs:489) 새로 만들지 않는다.
    record = max(matches, key=lambda r: r["seq"])
    now = time.monotonic()
    if record["state"] == EMITTED or (record["state"] == CANDIDATE and sleeper_alive(record, now)):
        return None
    record["state"] = CANDIDATE
    record["summary"] = summary
    record["armed_at"] = now
    return record["seq"], now


def codex_confirm(tab, state, event, seq, armed_at):
    codex = state.get("codex")
    if codex is None or codex["root"]["session"] != event.session:
        return
    for record in codex["records"]:
        if record["seq"] == seq and record["scope"] == event.scope and record["turn"] == event.turn:
            # 다시 무장된 기록은 새 sleeper 의 몫이다.
            if record["state"] == CANDIDATE and record.get("armed_at") == armed_at:
                record["state"] = EMITTED
                emit(tab, state, NEEDS_INPUT, record["summary"] or "")
            return


def codex_permission(tab, event):
    if marker(NEEDS_INPUT_OFF):
        tab.diag("needsInput disabled by ~/.mast/%s" % NEEDS_INPUT_OFF)
        return
    if auto_review_configured():
        tab.diag("approvals_reviewer is auto_review in ~/.codex/config.toml; needsInput disabled")
        return
    if event.tool in CODEX_GAP_TOOLS:
        tab.diag("%s approvals cannot be paired with a tool call" % event.tool)
        return
    fingerprint = codex_fingerprint(event)
    if fingerprint is None:
        tab.diag("PermissionRequest tool_input unreadable")
        return
    summary = codex_summary(event)
    _, armed = tab.transact(
        ASYNC_LOCK_SECONDS, lambda state: codex_mark_candidate(tab, state, event, fingerprint, summary)
    )
    if armed is None:
        return
    seq, armed_at = armed
    # async 훅 프로세스 자신이 sleeper 다. lock 은 잡지 않은 채 잔다. sync PreToolUse 기록이
    # handler 실행 전에 await 되므로(codex-rs/core/src/tools/registry.rs:567-619) 여기서 기록이
    # 여전히 candidate 면 그 호출은 2초 동안 끝나지 않은 것이다.
    time.sleep(HOLD_OFF_SECONDS)
    tab.transact(
        ASYNC_LOCK_SECONDS, lambda state: codex_confirm(tab, state, event, seq, armed_at), create=False
    )


CODEX_HANDLERS = {
    "UserPromptSubmit": codex_prompt,
    "PreToolUse": codex_pre,
    "PostToolUse": codex_post,
    "SubagentStop": codex_subagent_stop,
    "Stop": codex_stop,
    "Interrupt": codex_interrupt,
}


def codex_hook(tab, event):
    if event.name not in CODEX_EVENTS or marker(NO_CODEX_HOOKS):
        return
    transcript = event.payload.get("transcript_path")
    # 임시 thread 는 transcript 가 없다. SubagentStop 의 transcript_path 는 부모 rollout 경로이고
    # 부모를 읽지 못하면 null 이라(codex-rs/core/src/hook_runtime.rs:393-411) 이 게이트를 거치지
    # 않는다. 정리 전용이라 같은 세션에 기록이 있을 때만 무엇이든 바뀐다.
    if event.name != "SubagentStop" and (not isinstance(transcript, str) or not transcript.strip()):
        return
    session = event.payload.get("session_id")
    thread = os.environ.get("CODEX_THREAD_ID")
    # 훅 환경은 codex 프로세스 환경의 스냅샷이다(codex-rs/hooks/src/registry.rs:79,
    # engine/command_runner.rs:420-424). root codex 에는 CODEX_THREAD_ID 가 없고, Codex 가 띄운
    # 셸 안에서 다시 실행한 codex 에만 바깥 thread id 로 남는다.
    if thread and thread != session:
        return
    if event.session is None or event.turn is None:
        tab.diag("hook input has no session_id or turn_id")
        return
    if event.name == "PermissionRequest":
        codex_permission(tab, event)
        return
    handler = CODEX_HANDLERS[event.name]
    seconds = INTERRUPT_LOCK_SECONDS if event.name == "Interrupt" else SYNC_LOCK_SECONDS
    tab.transact(seconds, lambda state: handler(tab, state, event))


def parse_notify(raw):
    try:
        value = json.loads(raw)
    except ValueError:
        value = None
    if not isinstance(value, dict):
        return None, None, CODEX_DEFAULT_BODY

    def pick(kebab, snake):
        found = value.get(kebab)
        return found if found is not None else value.get(snake)

    # legacy notify payload 는 kebab-case 다(codex-rs/hooks/src/legacy_notify.rs:13-27).
    thread = pick("thread-id", "thread_id")
    turn = pick("turn-id", "turn_id")
    body = end_body(pick("last-assistant-message", "last_assistant_message"), CODEX_DEFAULT_BODY)
    return ident(thread), ident(turn), body


def codex_notify_decide(tab, state, ownership, thread, turn, body):
    if thread is None or turn is None:
        emit(tab, state, IDLE, body)
        return
    codex = state.get("codex")
    root = codex["root"] if codex is not None else None
    prev_session = codex.get("prev_session") if codex is not None else None
    if root is not None and root["session"] == thread:
        if any(item["turn"] == turn and item["handled"] for item in root["ended"]):
            return
        if root_active(root) and root["ups_turn"] != turn:
            return
        if ownership == "rejected" or emitted_records(codex):
            return
    elif prev_session == thread:
        # Stop 의 idle 쓰기가 실패한 turn 이어도 복구하지 않는다. 세션을 바꾼 이벤트는 새 세션이 일하고
        # 있거나(UPS·Pre·Post) 스스로 idle 을 냈다는(Stop·Interrupt) 뜻이라 직전 세션의 idle 은 낡았다.
        return
    elif ownership == "rejected":
        return
    elif ownership == "unknown" and root is not None:
        if root_active(root) or emitted_records(codex):
            return
    emit(tab, state, IDLE, body)


def codex_notify(args):
    ownership = args[0] if args and args[0] in OWNERSHIPS else "unknown"
    raw = args[1] if len(args) > 1 else ""
    number = tab_id()
    if number is None:
        return 0
    thread, turn, body = parse_notify(raw)
    if marker(NO_CODEX_HOOKS):
        write_osc(IDLE, body)
        return 0
    if "CLAUDECODE" in os.environ:
        return 0
    # legacy notify 는 그 codex 프로세스의 환경으로 뜬다(codex-rs/hooks/src/registry.rs:79,
    # legacy_notify.rs:45-69). 바깥 Codex 턴이 띄운 `codex exec` 는 바깥 thread 를 CODEX_THREAD_ID 로
    # 물려받으므로(core/src/unified_exec/process_manager.rs:1372-1376) 바깥 탭은 아직 일하는 중이다.
    outer = ident(os.environ.get("CODEX_THREAD_ID"))
    if outer is not None and outer != thread:
        return 0
    tab = Tab(number, "codex-notify", None)
    acquired, _ = tab.transact(
        SYNC_LOCK_SECONDS, lambda state: codex_notify_decide(tab, state, ownership, thread, turn, body)
    )
    # rejected 는 상태 없이도 무방출로 판정이 끝난다(id 가 없으면 fail-open idle 은 그대로).
    if not acquired and (ownership != "rejected" or thread is None or turn is None):
        write_osc(IDLE, body)
    return 0


def silence_output():
    try:
        null = os.open(os.devnull, os.O_WRONLY)
        os.dup2(null, 1)
        os.dup2(null, 2)
        os.close(null)
    except OSError:
        pass


def main(argv):
    silence_output()
    # Codex 훅은 process_group(0) 으로 뜬다(codex-rs/hooks/src/engine/command_runner.rs:224-225).
    # TOSTOP 이 켜진 pty 에서 백그라운드 그룹이 controlling tty 에 쓰면 SIGTTOU 로 멈춘다.
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    mode = argv[1] if len(argv) > 1 else ""
    if mode == "codex-notify":
        return codex_notify(argv[2:])
    if mode not in ("claude", "codex"):
        return 0
    prefix, tail, complete = read_stdin()
    number = tab_id()
    if number is None:
        return 0
    if mode == "codex" and "CLAUDECODE" in os.environ:
        return 0
    payload, truncated = parse_payload(prefix, tail, complete)
    event = Event(payload or {}, truncated)
    tab = Tab(number, mode, event.name)
    if payload is None:
        tab.diag("hook input is not a JSON object")
        return 0
    if mode == "claude":
        claude_hook(tab, event)
    else:
        codex_hook(tab, event)
    return 0


if __name__ == "__main__":
    notify_mode = len(sys.argv) > 1 and sys.argv[1] == "codex-notify"
    try:
        code = main(sys.argv)
    except BaseException as error:
        code = 1 if notify_mode and not EMISSION_ATTEMPTED[0] else 0
        try:
            number = tab_id()
            if number is not None:
                Tab(number, sys.argv[1] if len(sys.argv) > 1 else "-", None).diag(
                    "dispatcher failed: %s" % type(error).__name__
                )
        except BaseException:
            pass
    os._exit(code)
