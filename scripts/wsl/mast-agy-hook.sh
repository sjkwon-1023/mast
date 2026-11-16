#!/usr/bin/env bash
# Antigravity CLI(agy) 훅. ~/.gemini/config/hooks.json 의 "mast" 훅이 PreInvocation 에서 running,
# Stop 에서 idle 인자로 부른다. agy payload 에는 이벤트 이름 필드가 없어서 인자로 구분한다.
#
# agy는 handler의 stdout을 JSON 객체로 해석한다. 빈 출력은 파싱 실패이고, PreInvocation·Stop 결과에
# 엉뚱한 필드가 섞이면 다음 모델 호출이나 종료 판단이 바뀐다. 그래서 내부 명령의 stdout은 전부
# /dev/null로 보내고, 원래 stdout(fd 3)에는 마지막에 "{}" 한 줄만 쓴다. 자식 프로세스에는 fd 3을
# 닫아 넘긴다 — 남은 자손이 fd 3을 쥐고 있으면 agy가 stdout EOF를 기다리며 멈춘다.

exec 3>&1 1>/dev/null 2>/dev/null
# agy가 결과를 읽기 전에 파이프를 닫아도 SIGPIPE로 non-zero 종료하지 않는다.
trap '' PIPE

INPUT=""

main() {
  # agy는 payload를 stdin 파이프로 준다. 앞 1 MiB만 보관하고 나머지는 EOF까지 비워서, 이 스크립트가
  # 일찍 끝나거나 게이트에 걸려도 agy의 쓰기가 막히거나 EPIPE로 실패하지 않게 한다.
  if [[ ! -t 0 ]]; then
    INPUT="$(head -c 1048576)"
    cat > /dev/null
  fi

  # hooks.json 은 전역이라 mast 밖에서 돈 agy 도 이 훅을 부른다. MAST_TAB 은 mast 탭 셸에만 export 되므로
  # (host.rs) 십진수가 아니면 방출하지 않는다. 범위식 [0-9] 는 로케일에 따라 다른 숫자까지 받으므로 나열한다.
  case "${MAST_TAB:-}" in
    '' | *[!0123456789]*) return ;;
  esac

  # 같은 탭의 Claude Code나 Codex가 띄운 agy다. 그 에이전트의 상태를 이 호출이 덮지 않게 한다.
  if [[ -n "${CLAUDECODE+set}" || -n "${CODEX_THREAD_ID+set}" ]]; then
    return
  fi

  local body=""
  case "${1:-}" in
    running)
      "$HOME/.mast/bin/mast-notify.sh" mast:running < /dev/null
      write_resume_hint
      ;;
    idle)
      if command -v jq > /dev/null; then
        # finalModelOutput은 agy 1.1.13 StopHookArgs의 string 필드(5)다. 문자열이 아니면 무시한다.
        # 본문은 터미널로 가는 OSC 안에 들어간다. C0·DEL 은 sequence 를 일찍 끝내고, C1 의 U+009C(ST)·
        # U+009B(CSI)는 xterm 파서가 OSC 안에서도 종결·CSI 시작으로 읽으므로 모두 공백으로 바꾼다. 정리와
        # 500자 자르기를 jq 안에서 코드포인트 단위로 하는 이유는 bash 의 [[:cntrl:]]·${var:0:n} 이 로케일을
        # 따라, C 로케일에서는 UTF-8 로 인코딩된 C1 을 놓치고 멀티바이트 문자를 바이트 중간에서 자르기 때문이다.
        body="$(printf '%s' "$INPUT" | jq -r '
          .finalModelOutput | strings
          | (split("\n") | .[0] // "")
          | explode
          | map(if . < 32 or (. >= 127 and . < 160) then 32 else . end)
          | .[:500]
          | if all(. == 32) then "" else implode end')"
      fi
      if [[ -z "$body" ]]; then
        body="done"
      fi
      "$HOME/.mast/bin/mast-notify.sh" mast:idle "$body" < /dev/null
      write_resume_hint
      ;;
  esac
}

# 재시작한 탭이 `agy --conversation <id>` 로 이 대화를 다시 열 수 있게 탭별 resume 힌트를 쓴다. 형식과 원자적
# 교체는 mast-notify.sh 의 Claude 힌트와 같다: 1행 명령, 2행 기록 시각, 3행은 MAST_PROMPT_GEN 이 올바를 때만.
# 서브에이전트 대화도 같은 훅을 부르고 parentConversationId 를 채우지 않는다(agy 1.5.9 에서 확인). 그 대화의
# lastUserInput 은 빈 문자열이라 이것이 루트 대화와의 유일한 차이다. 그래서 사용자 입력이 있는 대화만 기록한다.
# lastUserInput 이 없는 agy(1.4.7 이전)는 힌트를 쓰지 않는다. 실패는 모두 삼킨다.
write_resume_hint() {
  command -v jq > /dev/null || return
  local conversation
  conversation="$(printf '%s' "$INPUT" | jq -r '
    select((.lastUserInput | type) == "string" and .lastUserInput != "")
    | .conversationId
    | select(type == "string" and test("\\A[A-Za-z0-9_-]+\\z"))')"
  [[ -n "$conversation" && "$conversation" != *$'\n'* ]] || return

  local file="$HOME/.mast/resume/tab-$MAST_TAB"
  local lines=("agy --conversation $conversation" "$(date +%s || echo 0)")
  if [[ "${MAST_PROMPT_GEN:-}" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then lines+=("$MAST_PROMPT_GEN"); fi
  mkdir -p "$HOME/.mast/resume" || return
  if printf '%s\n' "${lines[@]}" > "$file.tmp.$$"; then
    mv -f "$file.tmp.$$" "$file"
  fi
  rm -f "$file.tmp.$$"
}

main "$@" 3>&-
printf '{}\n' >&3
exit 0
