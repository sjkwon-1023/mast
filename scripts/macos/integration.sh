# bash/zsh 공용 통합. 이 파일은 실행하지 않고 source 한다.
export PATH="$HOME/.mast/bin:$PATH"
export MAST=1 TERM=xterm-256color COLORTERM=truecolor
_mast_cwd() {
  # OSC 종결자와 URI 에 민감한 문자를 이스케이프한다 — 원시 제어 바이트는 절대 출력하지 않는다.
  local _mast_p="$PWD"
  _mast_p=${_mast_p//\%/%25}; _mast_p=${_mast_p//\\/%5C}; _mast_p=${_mast_p// /%20}; _mast_p=${_mast_p//\#/%23}; _mast_p=${_mast_p//\?/%3F}
  _mast_p=${_mast_p//$'\x01'/%01}
  _mast_p=${_mast_p//$'\x02'/%02}
  _mast_p=${_mast_p//$'\x03'/%03}
  _mast_p=${_mast_p//$'\x04'/%04}
  _mast_p=${_mast_p//$'\x05'/%05}
  _mast_p=${_mast_p//$'\x06'/%06}
  _mast_p=${_mast_p//$'\x07'/%07}
  _mast_p=${_mast_p//$'\x08'/%08}
  _mast_p=${_mast_p//$'\x09'/%09}
  _mast_p=${_mast_p//$'\x0a'/%0A}
  _mast_p=${_mast_p//$'\x0b'/%0B}
  _mast_p=${_mast_p//$'\x0c'/%0C}
  _mast_p=${_mast_p//$'\x0d'/%0D}
  _mast_p=${_mast_p//$'\x0e'/%0E}
  _mast_p=${_mast_p//$'\x0f'/%0F}
  _mast_p=${_mast_p//$'\x10'/%10}
  _mast_p=${_mast_p//$'\x11'/%11}
  _mast_p=${_mast_p//$'\x12'/%12}
  _mast_p=${_mast_p//$'\x13'/%13}
  _mast_p=${_mast_p//$'\x14'/%14}
  _mast_p=${_mast_p//$'\x15'/%15}
  _mast_p=${_mast_p//$'\x16'/%16}
  _mast_p=${_mast_p//$'\x17'/%17}
  _mast_p=${_mast_p//$'\x18'/%18}
  _mast_p=${_mast_p//$'\x19'/%19}
  _mast_p=${_mast_p//$'\x1a'/%1A}
  _mast_p=${_mast_p//$'\x1b'/%1B}
  _mast_p=${_mast_p//$'\x1c'/%1C}
  _mast_p=${_mast_p//$'\x1d'/%1D}
  _mast_p=${_mast_p//$'\x1e'/%1E}
  _mast_p=${_mast_p//$'\x1f'/%1F}
  _mast_p=${_mast_p//$'\x7f'/%7F}
  _mast_p=${_mast_p//$'\xc2\x80'/%C2%80}
  _mast_p=${_mast_p//$'\xc2\x81'/%C2%81}
  _mast_p=${_mast_p//$'\xc2\x82'/%C2%82}
  _mast_p=${_mast_p//$'\xc2\x83'/%C2%83}
  _mast_p=${_mast_p//$'\xc2\x84'/%C2%84}
  _mast_p=${_mast_p//$'\xc2\x85'/%C2%85}
  _mast_p=${_mast_p//$'\xc2\x86'/%C2%86}
  _mast_p=${_mast_p//$'\xc2\x87'/%C2%87}
  _mast_p=${_mast_p//$'\xc2\x88'/%C2%88}
  _mast_p=${_mast_p//$'\xc2\x89'/%C2%89}
  _mast_p=${_mast_p//$'\xc2\x8a'/%C2%8A}
  _mast_p=${_mast_p//$'\xc2\x8b'/%C2%8B}
  _mast_p=${_mast_p//$'\xc2\x8c'/%C2%8C}
  _mast_p=${_mast_p//$'\xc2\x8d'/%C2%8D}
  _mast_p=${_mast_p//$'\xc2\x8e'/%C2%8E}
  _mast_p=${_mast_p//$'\xc2\x8f'/%C2%8F}
  _mast_p=${_mast_p//$'\xc2\x90'/%C2%90}
  _mast_p=${_mast_p//$'\xc2\x91'/%C2%91}
  _mast_p=${_mast_p//$'\xc2\x92'/%C2%92}
  _mast_p=${_mast_p//$'\xc2\x93'/%C2%93}
  _mast_p=${_mast_p//$'\xc2\x94'/%C2%94}
  _mast_p=${_mast_p//$'\xc2\x95'/%C2%95}
  _mast_p=${_mast_p//$'\xc2\x96'/%C2%96}
  _mast_p=${_mast_p//$'\xc2\x97'/%C2%97}
  _mast_p=${_mast_p//$'\xc2\x98'/%C2%98}
  _mast_p=${_mast_p//$'\xc2\x99'/%C2%99}
  _mast_p=${_mast_p//$'\xc2\x9a'/%C2%9A}
  _mast_p=${_mast_p//$'\xc2\x9b'/%C2%9B}
  _mast_p=${_mast_p//$'\xc2\x9c'/%C2%9C}
  _mast_p=${_mast_p//$'\xc2\x9d'/%C2%9D}
  _mast_p=${_mast_p//$'\xc2\x9e'/%C2%9E}
  _mast_p=${_mast_p//$'\xc2\x9f'/%C2%9F}
  printf '\033]7;file://%s\007' "$_mast_p"
}
# 에이전트 hook 은 셸이 살아 있는 동안에도 힌트를 다시 쓴다. 시작 때뿐 아니라 프롬프트마다
# (명령, 기록 시각)이 바뀌었는지 보고, 바뀐 힌트만 한 번 히스토리에 넣는다.
_mast_resume_seen=''
_mast_history_add() {
  if [[ -n ${ZSH_VERSION:-} ]]; then print -s -- "$1"; else history -s "$1"; history -a; fi
}
_mast_resume() {
  local cmd='' stamp='' token=''
  [[ $MAST_TAB != *[!0-9]* && -n $MAST_TAB ]] || return 0
  [[ -r "$HOME/.mast/resume/tab-$MAST_TAB" ]] || return 0
  { IFS= read -r cmd; IFS= read -r stamp; } < "$HOME/.mast/resume/tab-$MAST_TAB" || true
  [[ "$cmd"$'\n'"$stamp" != "$_mast_resume_seen" ]] || return 0
  _mast_resume_seen="$cmd"$'\n'"$stamp"
  case "$cmd" in
    'claude --resume '*) token=${cmd#'claude --resume '} ;;
    'codex resume '*) token=${cmd#'codex resume '} ;;
    'opencode --session '*) token=${cmd#'opencode --session '} ;;
    *) return 0 ;;
  esac
  case "$token" in ''|*[!A-Za-z0-9_-]*) return 0 ;; esac
  # 힌트일 뿐이다: 저장된 명령을 eval 하거나 실행하지 않는다.
  _mast_history_add "$cmd"
  # 프롬프트 훅(quiet)에서는 에이전트가 방금 자기 resume 안내를 출력했으므로 한 줄을 더하지 않는다.
  [[ ${1-} == quiet ]] || printf '\033[2m[mast] resume previous agent: %s\033[0m\n' "$cmd"
}

# 루트 셸만 세대를 기록하고 자동 실행을 판정한다. launch 가 MAST_SHELL_PID 로 넘긴 PID 가 이 셸의 PID 와
# 같을 때만 루트다. exec 는 PID 를 유지하고, 안에서 띄운 중첩 셸은 PID 가 달라 여기서 빠진다.
_mast_root_shell() {
  [[ ${MAST_SHELL_PID-} == "$$" && -n ${MAST_TAB-} && ${MAST_TAB} != *[!0-9]* ]]
}
# 중첩 셸은 상속받은 세대를 갱신하지 않는다. 남겨 두면 그 안에서 끝난 에이전트가 세대 3행 힌트로 기록돼
# 다음 부팅의 자동 실행 후보가 되므로, 이 파일을 읽는 시점에 지운다.
_mast_root_shell || unset MAST_PROMPT_GEN
_mast_first_prompt=${_mast_first_prompt-1}
_mast_gen_re='^[A-Za-z0-9_-]{1,128}$'
_mast_stamp_re='^[0-9]{1,20}$'
_mast_token_re='^[A-Za-z0-9_-]{1,96}$'

# 프롬프트 세대 `<nonce>-<counter>` 를 기록하고 export 한다. nonce 는 셸 시작 때 한 번 만든다.
# 짧은 단일 write 라 tmp+mv 원자 교체는 하지 않는다. 쓰다 끊긴 파일은 reader 의 형식 검사에서 거부된다.
# 기록이 실패하면 옛 세대가 디스크에 남아 다음 부팅의 후보가 되므로 파일을 지우고, 이 셸의 자동 재실행이
# 불가하다는 안내를 셸당 한 번 한다. 실패하면 MAST_PROMPT_GEN 을 지우고 1 을 돌려준다.
_mast_prompt_generation() {
  _mast_root_shell || return 0
  if [[ -z ${_mast_prompt_nonce-} ]]; then _mast_prompt_nonce="$$-$RANDOM$RANDOM"; fi
  _mast_prompt_count=$(( ${_mast_prompt_count:-0} + 1 ))
  local gen="$_mast_prompt_nonce-$_mast_prompt_count"
  [[ -d $HOME/.mast/prompt ]] || mkdir -p "$HOME/.mast/prompt" 2>/dev/null
  if { printf '%s\n' "$gen" >| "$HOME/.mast/prompt/tab-$MAST_TAB"; } 2>/dev/null; then
    MAST_PROMPT_GEN=$gen
    export MAST_PROMPT_GEN
    return 0
  fi
  unset MAST_PROMPT_GEN
  rm -f "$HOME/.mast/prompt/tab-$MAST_TAB" 2>/dev/null
  if [[ -z ${_mast_prompt_warned-} ]]; then
    _mast_prompt_warned=1
    printf '\033[2m[mast] auto-resume unavailable: cannot write ~/.mast/prompt/tab-%s\033[0m\n' "$MAST_TAB"
  fi
  return 1
}

# 일반 파일만 상한 안에서 읽어 _mast_blob 에 둔다. symlink, 디렉터리, 줄바꿈으로 끝나지 않는 내용,
# 상한 초과는 모두 실패다.
_mast_read_bounded() {
  _mast_blob=
  [[ -f $1 && ! -L $1 ]] || return 1
  _mast_blob=$(head -c "$(( $2 + 1 ))" -- "$1" 2>/dev/null; printf x)
  _mast_blob=${_mast_blob%x}
  [[ $_mast_blob == *$'\n' ]] && (( ${#_mast_blob} <= $2 ))
}

# 이전 셸이 마지막으로 남긴 세대와 hint 를 비교해 자동 실행 후보를 고른다. 세 줄이 모두 맞고 명령이
# 허용된 세 형태 가운데 하나일 때만 후보다. 후보가 없으면 _mast_auto_cmd 는 빈 값이다.
_mast_auto_candidate() {
  _mast_auto_cmd= _mast_auto_kind= _mast_auto_token= _mast_auto_seen=
  [[ ${MAST_AUTO_RESUME-} == 1 ]] || return 0
  _mast_read_bounded "$HOME/.mast/prompt/tab-$MAST_TAB" 256 || return 0
  local gen=${_mast_blob%$'\n'}
  [[ $gen =~ $_mast_gen_re ]] || return 0
  _mast_read_bounded "$HOME/.mast/resume/tab-$MAST_TAB" 1024 || return 0
  local hint=${_mast_blob%$'\n'} cmd stamp hint_gen extra token
  { IFS= read -r cmd && IFS= read -r stamp && IFS= read -r hint_gen && ! IFS= read -r extra; } <<< "$hint" || return 0
  [[ $hint_gen == "$gen" && $stamp =~ $_mast_stamp_re ]] || return 0
  case $cmd in
    'claude --resume '*) _mast_auto_kind=claude; token=${cmd#'claude --resume '} ;;
    'codex resume '*) _mast_auto_kind=codex; token=${cmd#'codex resume '} ;;
    'opencode --session '*) _mast_auto_kind=opencode; token=${cmd#'opencode --session '} ;;
    *) return 0 ;;
  esac
  [[ $token =~ $_mast_token_re ]] || { _mast_auto_kind=; return 0; }
  _mast_auto_cmd=$cmd _mast_auto_token=$token _mast_auto_seen=$cmd$'\n'$stamp
}

# 후보 하나를 한 번만 시도한다. 명령은 대기 전에 탭 history 에 넣어, 대기 중 취소하거나 건너뛰어도 수동
# hint 로 남는다. 허가는 대기열 helper 만 내리고, 허가받은 뒤에만 고정 argv 로 CLI 를 실행한다.
_mast_auto_run() {
  local interp rc cmd stamp
  printf '\033[2m[mast] auto-resume: %s\033[0m\n' "$_mast_auto_cmd"
  _mast_history_add "$_mast_auto_cmd"
  _mast_resume_seen=$_mast_auto_seen
  { interp=$(< "$HOME/.mast/bin/mast-python"); } 2>/dev/null
  if [[ -n ${interp-} && -f $HOME/.mast/bin/mast-auto-resume.py ]]; then
    "$interp" -I "$HOME/.mast/bin/mast-auto-resume.py" wait "$_mast_auto_cmd"
    rc=$?
  else
    rc=127
  fi
  if (( rc == 0 )); then
    case $_mast_auto_kind in
      claude) command claude --resume "$_mast_auto_token" ;;
      codex) command codex resume "$_mast_auto_token" ;;
      opencode) command opencode --session "$_mast_auto_token" ;;
    esac
    # 재개한 세션은 같은 명령을 새 시각으로 hint 에 다시 쓴다. 그 갱신을 새 hint 로 보고 다음 프롬프트가
    # history 에 또 넣지 않도록, 같은 명령이면 지금 내용을 이미 본 것으로 둔다. 다른 세션의 hint 는 그대로 받는다.
    if _mast_read_bounded "$HOME/.mast/resume/tab-$MAST_TAB" 1024; then
      { IFS= read -r cmd && IFS= read -r stamp; } <<< "$_mast_blob"
      [[ $cmd == "$_mast_auto_cmd" ]] && _mast_resume_seen=$cmd$'\n'$stamp
    fi
  else
    (( rc == 1 || rc == 130 )) || printf '\033[2m[mast] auto-resume helper failed (exit %s)\033[0m\n' "$rc"
    printf '\033[2m[mast] resume previous agent: %s\033[0m\n' "$_mast_auto_cmd"
  fi
  _mast_prompt_generation
}

# 첫 프롬프트의 판정. 실행까지 맡았으면 0, 아니면 1 이고 호출자가 수동 hint 를 안내한다. 자동 실행은
# 셸당 한 번이며, 판정 전에 세대를 올리면 같은 후보가 다음 부팅에서 다시 잡히지 않는다. 세대를 기록하지
# 못하면 후보가 있어도 실행하지 않는다. 기록되지 않은 세대로 끝난 에이전트가 다음 부팅에 다시 실행되기 때문이다.
_mast_auto_resume_first() {
  _mast_root_shell || return 1
  _mast_auto_candidate
  _mast_prompt_generation || return 1
  [[ -n $_mast_auto_cmd ]] || return 1
  _mast_auto_run
  return 0
}

# bash 프롬프트 훅. 루트 셸만 세대와 hint 를 다룬다. 중첩 셸은 상속된 PROMPT_COMMAND 로 여기 와도
# 탭 history 나 세대를 건드리지 않는다.
_mast_prompt() {
  if _mast_root_shell; then
    history -a
    if (( _mast_first_prompt )); then
      _mast_first_prompt=0
      _mast_auto_resume_first || _mast_resume
    else
      _mast_prompt_generation
      _mast_resume quiet
    fi
  fi
  _mast_cwd
}
