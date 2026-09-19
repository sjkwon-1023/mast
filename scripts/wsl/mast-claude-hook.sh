#!/usr/bin/env bash
# Claude Code 훅 진입점. 이벤트 구분은 stdin 의 hook_event_name 이 하므로 모든 이벤트가 이 명령 하나를 쓴다.
#
# 결과와 무관하게 exit 0 이고 stdout 에는 아무것도 쓰지 않는다. Claude Code 는 exit 2 를
# block/deny 로, 일부 이벤트의 stdout 을 JSON 결정으로 읽는다. 그래서 인터프리터를 exec 하지
# 않는다 — exec 하면 python 크래시 코드가 그대로 Claude Code 에 전달된다.
MODE=claude
HOOK="$HOME/.mast/bin/mast-agent-hook.py"
DIAG_DIR="$HOME/.mast/agent-hooks"

# mast 밖의 터미널에서도 전역 훅은 실행된다. 탭이 없으면 python 을 띄우지 않는다.
# stdin 을 비우는 이유는 쓰는 쪽이 파이프가 찬 채로 막히지 않게 하기 위해서다.
case "${MAST_TAB:-}" in
  '' | *[!0-9]*)
    cat > /dev/null 2>&1
    exit 0
    ;;
esac

diag() {
  (umask 077 && mkdir -p "$DIAG_DIR") 2> /dev/null || return 0
  local target="$DIAG_DIR/tab-$MAST_TAB.diag"
  printf '%s %s-entry: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2> /dev/null)" "$MODE" "$1" \
    | head -c 1024 > "$target.tmp.$$" 2> /dev/null \
    && mv -f "$target.tmp.$$" "$target" 2> /dev/null
  rm -f "$target.tmp.$$" 2> /dev/null
  return 0
}

MAST_PY=""
if [[ -r "$HOME/.mast/bin/mast-python" ]]; then
  IFS= read -r MAST_PY < "$HOME/.mast/bin/mast-python" || true
fi

if [[ -n "$MAST_PY" && -f "$MAST_PY" && -x "$MAST_PY" && -r "$HOOK" ]]; then
  # python 의 stdout 은 버리고 stderr 만 모은다. 디스패처는 시작하자마자 둘 다 /dev/null 로
  # 돌리므로 여기에 남는 것은 SyntaxError 처럼 main 전에 난 실패뿐이다.
  ERR="$("$MAST_PY" -I "$HOOK" "$MODE" 2>&1 > /dev/null)"
  STATUS=$?
  if [[ "$STATUS" -ne 0 ]]; then
    diag "dispatcher exited with status $STATUS: ${ERR:0:512}"
  fi
else
  cat > /dev/null 2>&1
  diag "no usable interpreter recorded in ~/.mast/bin/mast-python; hook input discarded"
fi

exit 0
