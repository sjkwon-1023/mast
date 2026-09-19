#!/usr/bin/env python3
# mast 설치 스크립트(provision.rs)가 에이전트 훅 설정 파일에 mast 항목을 병합할 때 부르는 헬퍼.
#
# 설치 스크립트는 PATH 의 아무 python3 로 이 파일을 실행한다. 그래서 Python 3.6 문법과 표준
# 라이브러리만 쓴다(f-string 도 피한다).
#
# 채널 계약 — provision.rs 가 `< /dev/null >> "$LOG" 2> "$notice_tmp"` 로 부른다:
#   stdout  "<mode>: <action> ..." 형태의 기계 판독용 보고. setup.log 에 그대로 쌓인다. 마지막 줄은
#           result=written|unchanged|skipped-read-only|skipped-dangling-link|skipped-inline-hooks|failed.
#   stderr  사용자가 손대야 할 일만. 설치 스크립트가 앱 알림으로 넘긴다.
#   exit 0  병합함 / 할 일 없음 / 쓰기 불가·끊어진 링크라 건너뜀(이후 설치 단계를 막지 않는다) / 사용자 정의 존중
#   exit 1  병합하지 못함. 설치 스크립트는 마커를 쓰지 않아 다음 실행에서 다시 시도한다.
#   exit 2  사용법 오류.
#   exit 3  (codex·agy) 파일 내용 때문에 병합할 수 없음. 다시 돌려도 같은 결과라 설치 스크립트는 그 단계를 끝난
#           것으로 기록하고, 파일을 고친 뒤 다시 돌리는 방법을 안내한다.
#
# 모드마다 소유권 규칙이 다르므로 모드별 코드는 따로 두고, 공유하는 것은 JSON 읽기와 원자적
# 쓰기뿐이다.

import errno
import json
import os
import re
import stat
import sys
from collections import OrderedDict

USAGE = """usage:
  mast-hooks-merge.py claude <settings.json> <notify-cmd> <claude-hook-cmd> [--no-dispatcher]
  mast-hooks-merge.py codex <hooks.json> [--config <config.toml>] [--trust-notice launch|slash|none]
  mast-hooks-merge.py agy <hooks.json>"""

CONTRACT_DOC = "scripts/wsl/claude-hook-example.md"

# rename 이 막히는 경우까지 "쓸 수 없는 대상"으로 본다. EBUSY 는 파일 하나를 bind mount 한 경우다.
READ_ONLY_ERRNOS = (errno.EACCES, errno.EPERM, errno.EROFS, errno.EBUSY)

# 비어 있거나 공백뿐인 파일. JSON `null` 은 None 으로 남겨 다른 비객체 값처럼 거부한다.
BLANK = object()


class MergeError(Exception):
    pass


class ContentError(MergeError):
    """파일을 다시 읽어도 같은 이유로 병합할 수 없는 경우. 읽기·쓰기 실패나 경합은 MergeError 로 남긴다."""


class UsageError(Exception):
    pass


class JsonObject(OrderedDict):
    # 중복 키가 어느 객체에서 나왔는지 알아야 에이전트 파서가 실제로 거부하는 위치만 거를 수 있다.
    # 값은 나중 것이 남는다(serde_json Map·Go encoding/json 과 같다).
    def __init__(self, *args, **kwargs):
        super(JsonObject, self).__init__(*args, **kwargs)
        self.duplicates = []


def json_object(pairs):
    obj = JsonObject()
    for key, value in pairs:
        if key in obj:
            obj.duplicates.append(key)
        obj[key] = value
    return obj


def duplicates_of(obj):
    return getattr(obj, "duplicates", ())


def emit(stream, text):
    # 3.6 은 C 로케일에서 표준 스트림 인코딩이 ascii 라, 비 ASCII 경로나 스니펫에서 print 가 죽는다.
    stream.buffer.write((text + "\n").encode("utf-8", "replace"))
    stream.buffer.flush()


def report(mode, text):
    emit(sys.stdout, "%s: %s" % (mode, text))


def notice(text):
    emit(sys.stderr, "[mast] setup: %s" % text)


def dump_json(value):
    return json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False)


def document_text(value, path):
    # 1e400 처럼 float 로 넘친 값은 파싱을 통과해 inf 가 된다. Infinity 로 다시 쓰면 세 에이전트 모두 파일을
    # 읽지 못하므로 allow_nan=False 로 쓰기 전에 실패시킨다. NaN·Infinity 리터럴은 읽을 때 이미 거부했으니
    # 여기서 나는 ValueError 는 넘친 수뿐이다. 쓸 일이 없는 실행은 이 검사에 닿지 않는다.
    try:
        return dump_json(value) + "\n"
    except ValueError:
        raise ContentError("%s contains a number outside the range JSON writers can reproduce" % path)


def same_json(left, right):
    # dict == 비교는 true == 1, 5 == 5.0 을 같게 보고 OrderedDict 끼리는 키 순서를 따진다.
    return json.dumps(left, sort_keys=True) == json.dumps(right, sort_keys=True)


def read_bytes(path):
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except (IOError, OSError) as err:
        if err.errno == errno.ENOENT:
            return None
        raise MergeError("cannot read %s (%s)" % (path, err.strerror or err))


def load_json(raw, path):
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ContentError("%s is not valid UTF-8" % path)
    if not text.strip():
        return BLANK

    # Python 만 NaN·Infinity·-Infinity 를 받는다. serde_json·JSON.parse·Go encoding/json 은 파일 전체를 거부한다.
    def reject_constant(_literal):
        raise ContentError("%s does not parse as JSON (NaN/Infinity is not JSON)" % path)

    try:
        return json.loads(text, object_pairs_hook=json_object, parse_constant=reject_constant)
    except ValueError as err:
        raise ContentError("%s does not parse as JSON (%s)" % (path, err))


def read_document(path):
    """(대상 경로, 원본 바이트 또는 None, 값). 파일이 없거나 공백뿐이면 값은 BLANK."""
    # dotfiles 관리자(stow 등)가 건 링크를 끊지 않도록 링크가 가리키는 파일을 갱신한다.
    target = os.path.realpath(path)
    original = read_bytes(target)
    return target, original, BLANK if original is None else load_json(original, path)


def dangling_link(path):
    """경로가 지나는 링크 중 대상이 없는 것. 아직 clone 하지 않았거나 옮긴 dotfiles 를 가리키는 링크다."""
    current = os.path.abspath(path)
    while True:
        if os.path.islink(current) and not os.path.exists(current):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def writable(target):
    if os.path.lexists(target) and not os.access(target, os.W_OK):
        return False
    directory = os.path.dirname(target)
    while not os.path.isdir(directory):
        parent = os.path.dirname(directory)
        if parent == directory:
            return False
        directory = parent
    return os.access(directory, os.W_OK | os.X_OK)


def write_temp(tmp, data, mode):
    try:
        os.unlink(tmp)
    except OSError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
    try:
        if mode is not None:
            os.fchmod(fd, mode)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def remove_quietly(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def replace_file(path, target, original, text):
    """원자적 교체. "written", "skipped-read-only" 또는 "skipped-dangling-link"."""
    try:
        data = text.encode("utf-8")
    except UnicodeEncodeError as err:
        raise ContentError("the merged %s cannot be encoded as UTF-8 (%s)" % (path, err))
    # 끊어진 링크를 따라가 만들면 링크 대상 자리에 디렉터리 트리가 생겨, 뒤에 dotfiles 를 그 경로로
    # clone 하거나 옮기는 일이 막힌다.
    if original is None and dangling_link(path):
        return "skipped-dangling-link"
    if not writable(target):
        return "skipped-read-only"
    directory = os.path.dirname(target)
    tmp = os.path.join(directory, "%s.mast-tmp.%d" % (os.path.basename(target), os.getpid()))
    try:
        os.makedirs(directory, exist_ok=True)
        mode = None if original is None else stat.S_IMODE(os.stat(target).st_mode)
        write_temp(tmp, data, mode)
    except OSError as err:
        remove_quietly(tmp)
        if err.errno in READ_ONLY_ERRNOS:
            return "skipped-read-only"
        raise MergeError("cannot write next to %s (%s)" % (path, err.strerror or err))
    try:
        # 병합하는 사이 에이전트나 사용자가 파일을 고쳤다면 그 변경을 덮지 않는다.
        if read_bytes(target) != original:
            raise MergeError("%s changed while mast was merging it" % path)
        os.replace(tmp, target)
    except OSError as err:
        remove_quietly(tmp)
        if err.errno in READ_ONLY_ERRNOS:
            return "skipped-read-only"
        raise MergeError("cannot replace %s (%s)" % (path, err.strerror or err))
    except MergeError:
        remove_quietly(tmp)
        raise
    return "written"


def finish(mode, path, target, original, text, snippet):
    result = replace_file(path, target, original, text)
    if result == "skipped-read-only":
        resolved = "" if target == os.path.abspath(path) else " (resolves to %s)" % target
        notice(
            "%s%s is not writable (a read-only dotfiles link?), so mast left it untouched. "
            "Add this by hand:\n%s" % (path, resolved, snippet)
        )
    elif result == "skipped-dangling-link":
        notice(
            "%s resolves to %s, which does not exist (a dangling symlink), so mast did not create it. "
            "Once the link resolves, add this by hand:\n%s" % (path, target, snippet)
        )
    report(mode, "result=%s path=%s" % (result, path))
    return result


def handlers_of(groups):
    """command 가 문자열인 handler 와 그 group. 형태가 어긋난 항목은 고치지 않고 건너뛴다."""
    if not isinstance(groups, list):
        return
    for group in groups:
        if not isinstance(group, dict):
            continue
        handlers = group.get("hooks")
        if not isinstance(handlers, list):
            continue
        for handler in handlers:
            if isinstance(handler, dict) and isinstance(handler.get("command"), str):
                yield group, handler


def runs(groups, mark):
    return any(mark in handler["command"] for _group, handler in handlers_of(groups))


NOTIFY_MARK = "mast-notify.sh"
NEEDS_INPUT_TOKEN = "mast:needsInput"
CLAUDE_HOOK_MARK = "mast-claude-hook.sh"
# idle_prompt(턴이 끝나고 약 60초 뒤)는 빠진다. worker_permission_prompt 는 공식 목록에 없고
# Claude Code 2.1.270 번들의 agent teams 권한 요청이다.
NEEDS_INPUT_MATCHER = "|".join([
    "permission_prompt",
    "elicitation_dialog",
    "elicitation_url_dialog",
    "agent_needs_input",
    "quota_auto_resume_stale",
    "worker_permission_prompt",
])
LEGACY_NEEDS_INPUT_ARGS = NEEDS_INPUT_TOKEN + " 'needs input'"
STATUS_EVENTS = ("UserPromptSubmit", "Notification", "Stop")
POST_TOOL_EVENTS = ("PostToolUse", "PostToolUseFailure")
# (event, role, 상태 토큰 인자). 같은 이벤트 안에서는 이 순서로 붙는다.
# SessionStart 의 matcher 는 source(startup|resume|clear|compact|fork)를 거르지만, 다른 디스패처 행과
# 모양을 맞춰 "" 로 두고 어느 source 에서 대기를 비울지는 디스패처가 정한다.
CLAUDE_ROWS = [
    ("SessionStart", "dispatcher", None),
    ("UserPromptSubmit", "status", "mast:running"),
    ("UserPromptSubmit", "dispatcher", None),
    ("PermissionRequest", "dispatcher", None),
    ("PostToolUse", "dispatcher", None),
    ("PostToolUseFailure", "dispatcher", None),
    ("PostToolBatch", "dispatcher", None),
    ("SubagentStop", "dispatcher", None),
    ("Notification", "status", LEGACY_NEEDS_INPUT_ARGS),
    ("Stop", "status", "mast:idle done"),
    ("Stop", "dispatcher", None),
]
# 훅 명령의 첫 단어: "따옴표", '따옴표', 또는 공백 없는 연속. 경로만 갈아 끼우고 뒤의 인자는
# 사용자가 쓴 그대로 둔다.
FIRST_WORD = re.compile(r'^(\s*)("[^"]*"|\'[^\']*\'|\S+)')


def resolve_hook_path(word):
    return os.path.normpath(os.path.expanduser(os.path.expandvars(word)))


def matches_every_notification(matcher):
    if matcher is None or matcher in ("", "*"):
        return True
    return isinstance(matcher, str) and "idle_prompt" in matcher


def parse_claude_args(args):
    dispatcher = True
    positional = []
    for arg in args:
        if arg == "--no-dispatcher":
            dispatcher = False
        else:
            positional.append(arg)
    if len(positional) != 3 or not all(positional):
        raise UsageError("claude takes <settings.json> <notify-cmd> <claude-hook-cmd>")
    return positional[0], positional[1], positional[2], dispatcher


def merge_claude(args):
    settings_path, notify_cmd, hook_cmd, dispatcher = parse_claude_args(args)
    target, original, data = read_document(settings_path)
    if data is BLANK:
        data = OrderedDict()
    if not isinstance(data, dict):
        raise ContentError("%s is not a JSON object" % settings_path)
    if "hooks" not in data:
        data["hooks"] = OrderedDict()
    hooks = data["hooks"]
    if not isinstance(hooks, dict):
        raise ContentError('%s: "hooks" is not an object' % settings_path)

    rows = [row for row in CLAUDE_ROWS if dispatcher or row[1] == "status"]
    for event, _role, _args in rows:
        if event in hooks and not isinstance(hooks[event], list):
            raise ContentError("%s: hooks.%s is not an array" % (settings_path, event))

    changed = False
    manual = []

    # 문서의 수동 경로(~/.claude/hooks/mast-notify.sh 등)는 같은 계약의 옛 사본을 돌리므로 설치본으로
    # 옮긴다. 아래 Notification 좁히기는 이 결과와 비교하므로 반드시 먼저 한다.
    canonical = resolve_hook_path(notify_cmd.strip().strip('"').strip("'"))
    for event in STATUS_EVENTS:
        for _group, handler in handlers_of(hooks.get(event)):
            command = handler["command"]
            if NOTIFY_MARK not in command:
                continue
            match = FIRST_WORD.match(command)
            word = match.group(2) if match else ""
            if NOTIFY_MARK not in word:
                # 셸로 감싸거나 파이프로 연결한 경우는 안전하게 고칠 수 없고 이미 이벤트를 덮는다.
                report("claude", "untouched %s reason=not-leading-word" % event)
                continue
            if resolve_hook_path(word.strip('"').strip("'")) == canonical:
                continue
            handler["command"] = match.group(1) + notify_cmd + command[match.end():]
            changed = True
            report("claude", "migrated %s" % event)
            manual.append("in hooks.%s, change the command %s to %s"
                          % (event, json.dumps(command), json.dumps(handler["command"])))

    # v13 까지 mast 가 쓴 group 과 문자 그대로 같을 때만 matcher 를 좁힌다. 한 글자라도 다르면
    # 사용자가 손댄 것이므로 그대로 둔다.
    legacy = {
        "matcher": "",
        "hooks": [{"type": "command", "command": "%s %s" % (notify_cmd, LEGACY_NEEDS_INPUT_ARGS)}],
    }
    for group in hooks.get("Notification") or []:
        if not isinstance(group, dict) or not runs([group], NOTIFY_MARK):
            continue
        if same_json(group, legacy):
            group["matcher"] = NEEDS_INPUT_MATCHER
            changed = True
            report("claude", "narrowed Notification")
            manual.append('in hooks.Notification, set the matcher of the mast-notify.sh group to "%s"'
                          % NEEDS_INPUT_MATCHER)
            continue
        matcher = group.get("matcher")
        if matcher == NEEDS_INPUT_MATCHER:
            report("claude", "already-narrowed Notification")
            continue
        report("claude", "kept Notification matcher=%s" % json.dumps(matcher))
        # 다른 토큰(idle 등)을 보내는 사용자 매핑에 needsInput matcher 를 권하면 권한 프롬프트가 그 토큰으로
        # 보고된다.
        if matches_every_notification(matcher) and runs([group], NEEDS_INPUT_TOKEN):
            notice(
                "a Notification hook in %s runs mast-notify.sh with matcher %s, which also matches "
                "idle_prompt (sent about a minute after every finished turn) and reports it as needing "
                "input. mast left the hook as you wrote it; set its matcher to \"%s\" by hand."
                % (settings_path, json.dumps(matcher), NEEDS_INPUT_MATCHER)
            )

    appended = OrderedDict()
    for event, role, token_args in rows:
        groups = hooks.get(event)
        if role == "status":
            if runs(groups, NOTIFY_MARK):
                report("claude", "wired %s role=status" % event)
                continue
            matcher = NEEDS_INPUT_MATCHER if event == "Notification" else ""
            command = "%s %s" % (notify_cmd, token_args)
        else:
            user_mapping = event in POST_TOOL_EVENTS and runs(groups, NOTIFY_MARK)
            if user_mapping:
                report("claude", "respected %s reason=user-mast-notify" % event)
                notice(
                    "%s in %s already runs mast-notify.sh, so mast kept that hook and did not add its "
                    "dispatcher there. Approvals are then not paired with their tool calls: that event "
                    "reports running even while another call still waits for approval."
                    % (event, settings_path)
                )
            if runs(groups, CLAUDE_HOOK_MARK):
                report("claude", "wired %s role=dispatcher" % event)
                continue
            if user_mapping:
                continue
            matcher = ""
            command = hook_cmd
        group = OrderedDict([
            ("matcher", matcher),
            ("hooks", [OrderedDict([("type", "command"), ("command", command)])]),
        ])
        hooks.setdefault(event, []).append(group)
        appended.setdefault(event, []).append(group)
        changed = True
        report("claude", "added %s role=%s" % (event, role))

    if not changed:
        report("claude", "result=unchanged path=%s" % settings_path)
        return 0
    parts = [dump_json(OrderedDict([("hooks", appended)]))] if appended else []
    parts += ["and " + step for step in manual] if appended else manual
    finish("claude", settings_path, target, original, document_text(data, settings_path), "\n".join(parts))
    return 0


CODEX_HOOK_CMD = '"$HOME/.mast/bin/mast-codex-hook.sh"'
CODEX_HOOK_MARK = "mast-codex-hook.sh"
# matcher·timeout·async·command 는 모두 Codex trust hash 의 입력이다. 바꾸면 모든 사용자에게
# 재신뢰 모달이 뜨므로 이유 없이 바꾸지 않는다. Pre/Post/PermissionRequest/SubagentStop 은 matcher 키를
# 두지 않는다(없음 = 전체 일치, codex-rs hooks/src/events/common.rs matches_matcher). timeout 단위는 초다.
CODEX_HOOKS = [
    ("UserPromptSubmit", 5, False),
    ("PreToolUse", 5, False),
    ("PermissionRequest", 10, True),
    ("PostToolUse", 5, False),
    ("SubagentStop", 5, False),
    ("Stop", 5, False),
    ("Interrupt", 3, False),
]
# codex-rs hooks/src/lib.rs hook_event_key_label. 여기 없는 이벤트 키는 Codex 가 무시한다
# (config/src/hook_config.rs HookEventsToml 은 deny_unknown_fields 가 아니다).
CODEX_EVENT_LABELS = OrderedDict([
    ("PreToolUse", "pre_tool_use"),
    ("PermissionRequest", "permission_request"),
    ("PostToolUse", "post_tool_use"),
    ("PreCompact", "pre_compact"),
    ("PostCompact", "post_compact"),
    ("SessionStart", "session_start"),
    ("SessionEnd", "session_end"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("SubagentStart", "subagent_start"),
    ("SubagentStop", "subagent_stop"),
    ("Stop", "stop"),
    ("Interrupt", "interrupt"),
])
CODEX_EVENTS = tuple(CODEX_EVENT_LABELS)
# serde derive 는 이 필드들이 두 번 나오면 실패하고, 모르는 필드의 중복은 따지지 않는다. commandWindows 와
# command_windows 는 alias 라 둘이 함께 있어도 같은 필드의 중복이다.
CODEX_HANDLER_FIELDS = {
    "command": ("type", "command", "commandWindows", "command_windows", "timeout", "async",
                "statusMessage", "additionalContextLimit"),
    "mcp_tool": ("type", "server", "tool", "input", "timeout", "statusMessage"),
    "prompt": ("type",),
    "agent": ("type",),
}
# 디스패처(mast-agent-hook.py)의 AUTO_REVIEW_RE 와 같은 줄 패턴이다. guardian_subagent 는 같은 값의 옛 이름이다
# (codex-rs protocol/src/config_types.rs ApprovalsReviewer).
AUTO_REVIEW = re.compile(
    r"""^[ \t]*approvals_reviewer[ \t]*=[ \t]*["'](?:auto_review|guardian_subagent)["']"""
)
TOML_HEADER = re.compile(r"^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$")
TOML_KEY = re.compile(
    r"""^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*="""
)
TOML_KEY_PART = re.compile(r"""[A-Za-z0-9_-]+|"[^"]*"|'[^']*'""")


def is_uint(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def contains_null(value):
    if value is None:
        return True
    if isinstance(value, dict):
        return any(contains_null(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_null(item) for item in value)
    return False


def duplicate_field(obj, fields):
    for key in duplicates_of(obj):
        if key in fields:
            return 'has a duplicate "%s" key' % key
    return None


def codex_handler_error(handler):
    kind = handler.get("type")
    if not isinstance(kind, str) or kind not in CODEX_HANDLER_FIELDS:
        return "has type %s; Codex accepts only command, mcp_tool, prompt and agent" % json.dumps(kind)
    error = duplicate_field(handler, CODEX_HANDLER_FIELDS[kind])
    if error:
        return error
    if kind == "command":
        if not isinstance(handler.get("command"), str):
            return 'has no string "command"'
        if "commandWindows" in handler and "command_windows" in handler:
            return 'has both "commandWindows" and its alias "command_windows"'
        for key in ("commandWindows", "command_windows", "statusMessage"):
            if handler.get(key) is not None and not isinstance(handler[key], str):
                return '"%s" is not a string' % key
        for key in ("timeout", "additionalContextLimit"):
            if handler.get(key) is not None and not is_uint(handler[key]):
                return '"%s" is not a non-negative integer' % key
        if "async" in handler and not isinstance(handler["async"], bool):
            return '"async" is not true or false'
    elif kind == "mcp_tool":
        for key in ("server", "tool"):
            if not isinstance(handler.get(key), str):
                return 'has no string "%s"' % key
        if handler.get("statusMessage") is not None and not isinstance(handler["statusMessage"], str):
            return '"statusMessage" is not a string'
        if handler.get("timeout") is not None and not is_uint(handler["timeout"]):
            return '"timeout" is not a non-negative integer'
        if "input" in handler and (not isinstance(handler["input"], dict) or contains_null(handler["input"])):
            return '"input" is not an object without nulls'
    return None


def not_an_object(value, reason):
    # serde derive 구조체(HooksFile·HookEventsToml·MatcherGroup)와 내부 태그 enum(HookHandlerConfig)은 JSON
    # 배열도 필드·태그 순서대로 받는다(serde private/de.rs TaggedContentVisitor::visit_seq). 배열이면 Codex 는
    # 파일을 읽을 수도 있고, mast 가 이벤트 이름으로 병합할 수 없을 뿐이다.
    return reason, not isinstance(value, list)


def codex_shape_error(data):
    """(이유, Codex 도 파일 전체를 버리는지) 또는 None."""
    # Codex 는 hooks.json 을 serde 로 한 번에 읽고, 실패하면 경고 한 줄과 함께 파일 전체를 버린다
    # (codex-rs hooks/src/engine/discovery.rs load_hooks_json). 아래는 그 실패 조건을 따른다.
    if not isinstance(data, dict):
        return not_an_object(data, "the top level is not a JSON object")
    for key in data:
        if key not in ("description", "hooks"):
            return 'unknown top-level key "%s"' % key, True
    error = duplicate_field(data, ("description", "hooks"))
    if error:
        return "the top level %s" % error, True
    if data.get("description") is not None and not isinstance(data["description"], str):
        return '"description" is not a string', True
    if "hooks" not in data:
        return None
    hooks = data["hooks"]
    if not isinstance(hooks, dict):
        return not_an_object(hooks, '"hooks" is not an object')
    error = duplicate_field(hooks, CODEX_EVENTS)
    if error:
        return '"hooks" %s' % error, True
    for event in CODEX_EVENTS:
        if event not in hooks:
            continue
        groups = hooks[event]
        if not isinstance(groups, list):
            return "hooks.%s is not an array" % event, True
        for index, group in enumerate(groups):
            where = "hooks.%s[%d]" % (event, index)
            if not isinstance(group, dict):
                return not_an_object(group, "%s is not an object" % where)
            error = duplicate_field(group, ("matcher", "hooks"))
            if error:
                return "%s %s" % (where, error), True
            if group.get("matcher") is not None and not isinstance(group["matcher"], str):
                return "%s.matcher is not a string" % where, True
            if "hooks" not in group:
                continue
            if not isinstance(group["hooks"], list):
                return "%s.hooks is not an array" % where, True
            for handler_index, handler in enumerate(group["hooks"]):
                handler_where = "%s.hooks[%d]" % (where, handler_index)
                if not isinstance(handler, dict):
                    return not_an_object(handler, "%s is not an object" % handler_where)
                error = codex_handler_error(handler)
                if error:
                    return "%s %s" % (handler_where, error), True
    return None


def duplicate_keys(value, where=""):
    if isinstance(value, dict):
        for key in duplicates_of(value):
            yield where, key
        for key, item in value.items():
            yield from duplicate_keys(item, "%s.%s" % (where, key) if where else key)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from duplicate_keys(item, "%s[%d]" % (where, index))


def toml_key_parts(text):
    return [part.strip("\"'") for part in TOML_KEY_PART.findall(text)]


def inline_hook_events_by_pattern(text):
    # tomllib 이 없는(3.11 미만) 경우의 근사치: 테이블 헤더와 키 줄로 hooks.<Event> 를 찾는다.
    # 여러 줄 문자열 안의 헤더 모양 줄은 구분하지 못한다.
    found = []
    table = []
    for line in text.splitlines():
        header = TOML_HEADER.match(line)
        if header:
            table = toml_key_parts(header.group(1))
            key = table
        else:
            key_match = TOML_KEY.match(line)
            if not key_match:
                continue
            key = table + toml_key_parts(key_match.group(1))
        if len(key) >= 2 and key[0] == "hooks" and key[1] in CODEX_EVENTS and key[1] not in found:
            found.append(key[1])
    return found


def import_tomllib():
    try:
        import tomllib
    except ImportError:
        return None
    return tomllib


def disabled_feature_key(features):
    # Codex 는 [features] 를 키 이름순으로 적용해 codex_hooks(옛 이름) 뒤에 hooks 가 이긴다
    # (codex-rs features/src/lib.rs apply_map). 그래서 hooks 가 있으면 codex_hooks 는 보지 않는다.
    if not isinstance(features, dict):
        return None
    key = "hooks" if "hooks" in features else "codex_hooks"
    return key if features.get(key) is False else None


def auto_review_in_root_table(text):
    # 디스패처의 auto_review_configured() 는 첫 테이블 헤더 앞의 줄을 문자열로만 본다. 프로필 안의 값으로는 런타임에
    # needs input 이 꺼지지 않고, tomllib 로 root 키를 읽으면 여러 줄 문자열 안의 `[` 줄처럼 두 판정이 갈리는 입력이
    # 생긴다. 안내가 런타임 동작과 맞도록 같은 줄 검사만 쓴다.
    for line in text.split("\n"):
        if line.lstrip().startswith("["):
            break
        if AUTO_REVIEW.match(line):
            return True
    return False


def inspect_codex_config(config_path):
    """(inline hooks.<Event> 목록, enabled = false 인 hooks.state 키 집합). config.toml 에는 쓰지 않는다."""
    if config_path is None:
        return [], set()
    try:
        raw = read_bytes(config_path)
    except MergeError:
        report("codex", "config=unreadable path=%s" % config_path)
        return [], set()
    if raw is None:
        report("codex", "config=absent path=%s" % config_path)
        return [], set()
    text = raw.decode("utf-8", "replace")
    tomllib = import_tomllib()
    document = None
    if tomllib is not None:
        try:
            document = tomllib.loads(text)
        except Exception:
            document = None
    disabled_key = None
    disabled_states = set()
    if document is not None:
        parser = "tomllib"
        table = document.get("hooks")
        table = table if isinstance(table, dict) else {}
        # Codex 도 비어 있지 않은 이벤트 배열만 inline 훅으로 친다. hooks.state 는 trust·enable 기록이다.
        inline = [event for event in CODEX_EVENTS
                  if isinstance(table.get(event), list) and table.get(event)]
        states = table.get("state")
        if isinstance(states, dict):
            disabled_states = set(key for key, state in states.items()
                                  if isinstance(state, dict) and state.get("enabled") is False)
        disabled_key = disabled_feature_key(document.get("features"))
    else:
        parser = "patterns" if tomllib is None else "patterns-after-parse-error"
        inline = inline_hook_events_by_pattern(text)
    report("codex", "config=read parser=%s path=%s" % (parser, config_path))
    if disabled_key:
        report("codex", "hooks-feature=disabled key=%s" % disabled_key)
        notice("hooks disabled in config; mast hooks will not run (%s sets features.%s = false)"
               % (config_path, disabled_key))
    if auto_review_in_root_table(text):
        report("codex", "approvals-reviewer=auto_review")
        notice(
            "approvals_reviewer is auto_review in %s; mast does not report needs input for Codex "
            "approvals while it is set, because the automatic review usually outlasts mast's "
            "2-second hold-off and every reviewed request would look like a prompt." % config_path
        )
    if inline:
        report("codex", "inline-hooks events=%s" % ",".join(inline))
    return inline, disabled_states


def codex_key_sources(hooks_path):
    # trust·enable 키의 앞부분은 <CODEX_HOME>/hooks.json 이다(codex-rs hooks/src/lib.rs hook_key,
    # engine/discovery.rs load_hooks_json). CODEX_HOME 을 env 로 주면 canonicalize 한 경로를, 기본 ~/.codex 는
    # 링크를 풀지 않은 경로를 쓴다(utils/home-dir/src/lib.rs find_codex_home_from_env).
    folder = os.path.dirname(os.path.abspath(hooks_path))
    return [os.path.join(folder, "hooks.json"), os.path.join(os.path.realpath(folder), "hooks.json")]


# 훅을 실행하기 전에 사용자가 해야 할 일은 Codex 버전마다 다르고 버전은 설치 스크립트가 읽는다. launch 는 실행 시
# "Hooks need review" 창(0.131.0+), slash 는 그 창이 없고 /hooks 에서만 신뢰할 수 있는 0.129.x–0.130.x, none 은
# 신뢰 검토가 없는 0.129.0 미만이다.
TRUST_NOTICES = {
    "launch": 'Codex hooks are installed in %s but will not run until you trust them in "Hooks need review" on the '
              "next Codex launch.",
    "slash": "Codex hooks are installed in %s but will not run until you trust them from /hooks in Codex; this Codex "
             'has no "Hooks need review" prompt at launch.',
    "none": None,
}


def parse_codex_args(args):
    options = {"--config": None, "--trust-notice": "launch"}
    positional = []
    index = 0
    while index < len(args):
        if args[index] in options:
            if index + 1 >= len(args) or not args[index + 1]:
                raise UsageError("%s needs a value" % args[index])
            options[args[index]] = args[index + 1]
            index += 2
            continue
        positional.append(args[index])
        index += 1
    if len(positional) != 1 or not positional[0]:
        raise UsageError("codex takes <hooks.json> [--config <config.toml>] [--trust-notice launch|slash|none]")
    if options["--trust-notice"] not in TRUST_NOTICES:
        raise UsageError("--trust-notice takes launch, slash or none")
    return positional[0], options["--config"], TRUST_NOTICES[options["--trust-notice"]]


def merge_codex(args):
    hooks_path, config_path, trust_notice = parse_codex_args(args)
    codex_home = os.path.dirname(os.path.abspath(hooks_path))
    # 공유 app-server daemon 에 붙은 TUI 는 훅이 daemon 의 환경·tty 로 돈다(문서화된 한계).
    control_socket = os.path.join(codex_home, "app-server-control", "app-server-control.sock")
    report("codex", "app-server-control-socket=%s"
           % ("present" if os.path.exists(control_socket) else "absent"))

    inline, disabled_states = inspect_codex_config(config_path)
    if inline:
        # 두 표현이 모두 비어 있지 않으면 Codex 가 세션마다 경고한다(discovery.rs "loading hooks from both").
        notice(
            "Codex hooks are configured inline in %s (hooks.%s), so mast did not create or change %s: "
            "Codex warns on every launch when both hold hooks. Add the mast hooks to the inline "
            "[hooks] tables by hand; the snippet is in %s (Codex hooks)."
            % (config_path, ", hooks.".join(inline), hooks_path, CONTRACT_DOC)
        )
        report("codex", "result=skipped-inline-hooks path=%s" % hooks_path)
        return 0

    target, original, data = read_document(hooks_path)
    if data is BLANK:
        data = OrderedDict([("hooks", OrderedDict())])
    # serde 의 derive struct 는 JSON 배열도 필드 순서대로 받고 모든 이벤트가 default 라, 빈 배열은 이벤트 없는
    # hooks 로 읽힌다. 비어 있지 않은 배열은 위치로 이벤트에 대응돼 병합할 수 없으므로 아래 검사에서 거부한다.
    if isinstance(data, dict) and isinstance(data.get("hooks"), list) and not data["hooks"]:
        data["hooks"] = OrderedDict()
    shape = codex_shape_error(data)
    if shape:
        error, codex_rejects = shape
        if codex_rejects:
            raise ContentError(
                "%s is not a hooks file Codex accepts (%s); Codex ignores the whole file" % (hooks_path, error)
            )
        raise ContentError("%s is not a hooks file shape mast can merge (%s)" % (hooks_path, error))
    # 남은 중복은 Codex 가 나중 값만 읽는 자리다. 다시 쓰면 앞의 값이 파일에서 사라지므로 기록만 남긴다.
    for where, key in duplicate_keys(data):
        report("codex", "duplicate-key-kept-last key=%s in=%s" % (json.dumps(key, ensure_ascii=False), where))
    if "hooks" not in data:
        data["hooks"] = OrderedDict()
    hooks = data["hooks"]

    appended = OrderedDict()
    stale_states = []
    for event, timeout, is_async in CODEX_HOOKS:
        # 사용자 group 은 고치지도 옮기지도 않는다. 끝에만 붙여야 기존 group index 로 만든
        # trust key(<source>:<event>:<group>:<handler>)가 유지된다.
        if runs(hooks.get(event), CODEX_HOOK_MARK):
            report("codex", "wired %s" % event)
            continue
        handler = OrderedDict([("type", "command"), ("command", CODEX_HOOK_CMD), ("timeout", timeout)])
        if is_async:
            handler["async"] = True
        groups = hooks.setdefault(event, [])
        # 지운 group 의 enabled = false 기록은 config.toml 에 남고, 같은 index 에 붙인 새 group 을 끈다. TUI 의
        # trust 는 trusted_hash 만 병합해 넣으므로 신뢰해도 풀리지 않는다(tui/src/hooks_rpc.rs, config/src/merge.rs).
        for source in codex_key_sources(hooks_path):
            key = "%s:%s:%d:0" % (source, CODEX_EVENT_LABELS[event], len(groups))
            if key in disabled_states:
                stale_states.append((event, key))
                break
        groups.append(OrderedDict([("hooks", [handler])]))
        appended[event] = [groups[-1]]
        report("codex", "added %s" % event)

    if not appended:
        report("codex", "result=unchanged path=%s" % hooks_path)
        return 0
    snippet = dump_json(OrderedDict([("hooks", appended)]))
    result = finish("codex", hooks_path, target, original, document_text(data, hooks_path), snippet)
    if result == "written" and trust_notice:
        notice(trust_notice % hooks_path)
    for event, key in stale_states:
        report("codex", "stale-hook-state event=%s key=%s" % (event, key))
        notice(
            '%s still has [hooks.state."%s"] with enabled = false, left over from a hook that used to be '
            "at that position, so the mast %s hook there stays disabled even after you trust it. Remove "
            "that entry from config.toml." % (config_path, key, event)
        )
    return 0


AGY_HOOK_NAME = "mast"
AGY_HOOK_CMD = '"$HOME/.mast/bin/mast-agy-hook.sh"'
AGY_HOOK_MARK = "mast-agy-hook.sh"
AGY_FLAT_EVENTS = ("PreInvocation", "PostInvocation", "Stop", "SessionStart")
AGY_GROUPED_EVENTS = ("PreToolUse", "PostToolUse")


def agy_definition():
    # PreInvocation·Stop 은 handler 평면 배열 이벤트다(PreToolUse·PostToolUse 만 matcher group).
    def handler(token):
        return OrderedDict([
            ("type", "command"),
            ("command", "%s %s" % (AGY_HOOK_CMD, token)),
            ("timeout", 5),
        ])

    return OrderedDict([("PreInvocation", [handler("running")]), ("Stop", [handler("idle")])])


def agy_field(obj, name):
    # agy 1.2.2 의 jsonhook.ParseHooks·(*HookHandler).UnmarshalJSON 은 stdlib encoding/json.Unmarshal 과 같은
    # 옵션으로 json/v2 를 부른다(v1 규칙): 필드 이름은 대소문자를 가리지 않고 마지막 값이 남으며, null 은
    # 필드를 비워 둔다.
    value = None
    for key, item in obj.items():
        if key.lower() == name.lower():
            value = item
    return value


def agy_handler_error(handler, event):
    # 1.2.2 의 (*HookHandler).UnmarshalJSON 은 type·command·prompt·model 문자열과 int32 timeout 만 가진 보조
    # 구조체로 decode 하므로 다른 타입의 값은 decode 오류다. 빈 type 은 채워진 필드로 추론하지 않고 무조건
    # "command" 로 채운 뒤 종류별로 섞인 필드를 거부하고, 빈 command·prompt 와 PostToolUse 의 prompt hook 은
    # setDefaultsAndValidate 가 거부한다. type 값 비교는 대소문자를 가린다. model 이름 검사(ParseModelTier)는
    # 정규화 규칙을 확인하지 못해 따라 하지 않는다.
    if not isinstance(handler, dict):
        return "is not an object"
    fields = {}
    for name in ("type", "command", "prompt", "model"):
        value = agy_field(handler, name)
        if value is not None and not isinstance(value, str):
            return '"%s" is not a string' % name
        fields[name] = value or ""
    timeout = agy_field(handler, "timeout")
    if timeout is not None and not (
        isinstance(timeout, int) and not isinstance(timeout, bool) and -2 ** 31 <= timeout < 2 ** 31
    ):
        return '"timeout" is not a 32-bit integer'
    kind = fields["type"] or "command"
    if kind == "command":
        for name in ("prompt", "model"):
            if fields[name]:
                return 'sets "%s" on a command hook (a hook without a type is a command hook)' % name
        return None if fields["command"] else 'has no "command" string'
    if kind == "prompt":
        if fields["command"]:
            return 'sets "command" on a prompt hook'
        if event == "PostToolUse":
            return "is a prompt hook, which agy does not accept for PostToolUse"
        return None if fields["prompt"] else 'has no "prompt" string'
    return "has type %s; agy accepts only command and prompt" % json.dumps(kind)


def agy_hook_error(spec):
    # 이름 붙은 hook 하나라도 검증에 실패하면 ParseHooks 가 오류를 모아 map 전체를 버리고, 호출 측은
    # "Failed to parse hooks file" 로그만 남긴다(customizations.(*Manager).GetJSONHooks.func1). enabled 와
    # 무관하게 모든 hook 을 검증한다.
    if spec is None:
        return None
    if not isinstance(spec, dict):
        return "is not an object"
    enabled = agy_field(spec, "enabled")
    if enabled is not None and not isinstance(enabled, bool):
        return '"enabled" is not true or false'
    for event in AGY_FLAT_EVENTS:
        handlers = agy_field(spec, event)
        if handlers is None:
            continue
        if not isinstance(handlers, list):
            return "%s is not an array" % event
        for index, handler in enumerate(handlers):
            error = agy_handler_error(handler, event)
            if error:
                return "%s[%d] %s" % (event, index, error)
    for event in AGY_GROUPED_EVENTS:
        groups = agy_field(spec, event)
        if groups is None:
            continue
        if not isinstance(groups, list):
            return "%s is not an array" % event
        for index, group in enumerate(groups):
            where = "%s[%d]" % (event, index)
            if not isinstance(group, dict):
                return "%s is not a matcher group object" % where
            matcher = agy_field(group, "matcher")
            if matcher is not None and not isinstance(matcher, str):
                return "%s.matcher is not a string" % where
            handlers = agy_field(group, "hooks")
            if handlers is None:
                continue
            if not isinstance(handlers, list):
                return "%s.hooks is not an array" % where
            for handler_index, handler in enumerate(handlers):
                error = agy_handler_error(handler, event)
                if error:
                    return "%s.hooks[%d] %s" % (where, handler_index, error)
    return None


def agy_commands(spec):
    """검증을 통과한 hook 의 command 값들."""
    if spec is None:
        return
    for event in AGY_FLAT_EVENTS:
        for handler in agy_field(spec, event) or []:
            yield agy_field(handler, "command")
    for event in AGY_GROUPED_EVENTS:
        for group in agy_field(spec, event) or []:
            for handler in agy_field(group, "hooks") or []:
                yield agy_field(handler, "command")


def merge_agy(args):
    if len(args) != 1 or not args[0]:
        raise UsageError("agy takes <hooks.json>")
    hooks_path = args[0]
    target, original, data = read_document(hooks_path)
    if data is BLANK:
        data = OrderedDict()
    if not isinstance(data, dict):
        raise ContentError("%s is not a JSON object" % hooks_path)
    if AGY_HOOK_NAME in duplicates_of(data):
        raise ContentError(
            '%s defines the "%s" hook more than once; agy uses only the last one, and mast cannot tell '
            "which one you meant" % (hooks_path, AGY_HOOK_NAME)
        )
    for name, spec in data.items():
        error = agy_hook_error(spec)
        if error:
            raise ContentError(
                '%s: the "%s" hook is not one agy accepts (%s); agy skips the whole file, so none of its '
                "hooks run" % (hooks_path, name, error)
            )

    definition = agy_definition()
    snippet = dump_json(OrderedDict([(AGY_HOOK_NAME, definition)]))
    if AGY_HOOK_NAME in data:
        current = data[AGY_HOOK_NAME]
        if same_json(current, definition):
            report("agy", "wired %s" % AGY_HOOK_NAME)
        elif (isinstance(current, dict) and current.get("enabled") is False
              and same_json(OrderedDict((k, v) for k, v in current.items() if k != "enabled"), definition)):
            # 사용자가 우리 정의를 그대로 둔 채 끈 것은 opt-out 이다. 버전마다 안내를 반복하지 않는다.
            report("agy", "disabled %s" % AGY_HOOK_NAME)
        else:
            report("agy", "differs %s" % AGY_HOOK_NAME)
            notice(
                '%s already has a "%s" hook that differs from the one mast installs, so mast left it '
                "untouched. To use mast's definition, replace it with:\n%s"
                % (hooks_path, AGY_HOOK_NAME, snippet)
            )
        report("agy", "result=unchanged path=%s" % hooks_path)
        return 0
    for name, spec in data.items():
        if any(isinstance(command, str) and AGY_HOOK_MARK in command for command in agy_commands(spec)):
            report("agy", "wired %s via=%s" % (AGY_HOOK_NAME, json.dumps(name, ensure_ascii=False)))
            report("agy", "result=unchanged path=%s" % hooks_path)
            return 0

    data[AGY_HOOK_NAME] = definition
    report("agy", "added %s" % AGY_HOOK_NAME)
    finish("agy", hooks_path, target, original, document_text(data, hooks_path), snippet)
    return 0


# (병합 함수, 실패 결과 문구, 내용 때문에 거부한 경우의 종료 코드). Claude 는 내용 문제도 exit 1 로 매 실행 다시
# 시도한다: settings.json 이 깨지면 Claude Code 자신도 설정을 못 읽어 사용자가 곧 고치고, 고친 뒤 다음 실행에서
# 따로 할 일 없이 배선된다.
MODES = OrderedDict([
    ("claude", (merge_claude, "Claude Code hooks are not wired", 1)),
    ("codex", (merge_codex, "Codex hooks are not installed", 3)),
    ("agy", (merge_agy, "Antigravity CLI hooks are not installed", 3)),
])


def main(argv):
    if not argv or argv[0] not in MODES:
        emit(sys.stderr, USAGE)
        return 2
    mode = argv[0]
    merge, consequence, content_status = MODES[mode]
    status = 1
    try:
        return merge(argv[1:])
    except UsageError as err:
        emit(sys.stderr, "mast-hooks-merge.py: %s\n%s" % (err, USAGE))
        return 2
    except ContentError as err:
        reason = str(err)
        status = content_status
    except MergeError as err:
        reason = str(err)
    except Exception as err:
        reason = "unexpected %s: %s" % (type(err).__name__, err)
    report(mode, "result=failed reason=%s" % json.dumps(reason, ensure_ascii=False))
    if status == 1:
        notice("%s; left untouched. %s; mast retries on its next launch." % (reason, consequence))
    else:
        notice("%s; left untouched. %s." % (reason, consequence))
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
