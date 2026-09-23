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
_mast_resume() {
  local cmd='' token=''
  [[ $MAST_TAB != *[!0-9]* && -n $MAST_TAB ]] || return 0
  [[ -r "$HOME/.mast/resume/tab-$MAST_TAB" ]] || return 0
  IFS= read -r cmd < "$HOME/.mast/resume/tab-$MAST_TAB" || true
  case "$cmd" in
    'claude --resume '*) token=${cmd#'claude --resume '} ;;
    'codex resume '*) token=${cmd#'codex resume '} ;;
    'opencode --session '*) token=${cmd#'opencode --session '} ;;
    *) return 0 ;;
  esac
  case "$token" in ''|*[!A-Za-z0-9_-]*) return 0 ;; esac
  # 힌트일 뿐이다: 저장된 명령을 eval 하거나 실행하지 않는다.
  if [[ -n ${ZSH_VERSION:-} ]]; then print -s -- "$cmd"; else history -s "$cmd"; history -a; fi
  printf '\033[2m[mast] resume previous agent: %s\033[0m\n' "$cmd"
}
