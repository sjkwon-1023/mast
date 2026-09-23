# Shared bash/zsh integration. This file is sourced, not executed.
export PATH="$HOME/.mast/bin:$PATH"
export MAST=1 TERM=xterm-256color COLORTERM=truecolor
_mast_cwd() {
  # Escape OSC terminators and URI-sensitive characters; never print raw control bytes.
  local path="$PWD"
  path=${path//\%/%25}; path=${path//\\/%5C}; path=${path// /%20}; path=${path//\#/%23}; path=${path//\?/%3F}
  path=${path//$'\x01'/%01}
  path=${path//$'\x02'/%02}
  path=${path//$'\x03'/%03}
  path=${path//$'\x04'/%04}
  path=${path//$'\x05'/%05}
  path=${path//$'\x06'/%06}
  path=${path//$'\x07'/%07}
  path=${path//$'\x08'/%08}
  path=${path//$'\x09'/%09}
  path=${path//$'\x0a'/%0A}
  path=${path//$'\x0b'/%0B}
  path=${path//$'\x0c'/%0C}
  path=${path//$'\x0d'/%0D}
  path=${path//$'\x0e'/%0E}
  path=${path//$'\x0f'/%0F}
  path=${path//$'\x10'/%10}
  path=${path//$'\x11'/%11}
  path=${path//$'\x12'/%12}
  path=${path//$'\x13'/%13}
  path=${path//$'\x14'/%14}
  path=${path//$'\x15'/%15}
  path=${path//$'\x16'/%16}
  path=${path//$'\x17'/%17}
  path=${path//$'\x18'/%18}
  path=${path//$'\x19'/%19}
  path=${path//$'\x1a'/%1A}
  path=${path//$'\x1b'/%1B}
  path=${path//$'\x1c'/%1C}
  path=${path//$'\x1d'/%1D}
  path=${path//$'\x1e'/%1E}
  path=${path//$'\x1f'/%1F}
  path=${path//$'\x7f'/%7F}
  path=${path//$'\xc2\x80'/%C2%80}
  path=${path//$'\xc2\x81'/%C2%81}
  path=${path//$'\xc2\x82'/%C2%82}
  path=${path//$'\xc2\x83'/%C2%83}
  path=${path//$'\xc2\x84'/%C2%84}
  path=${path//$'\xc2\x85'/%C2%85}
  path=${path//$'\xc2\x86'/%C2%86}
  path=${path//$'\xc2\x87'/%C2%87}
  path=${path//$'\xc2\x88'/%C2%88}
  path=${path//$'\xc2\x89'/%C2%89}
  path=${path//$'\xc2\x8a'/%C2%8A}
  path=${path//$'\xc2\x8b'/%C2%8B}
  path=${path//$'\xc2\x8c'/%C2%8C}
  path=${path//$'\xc2\x8d'/%C2%8D}
  path=${path//$'\xc2\x8e'/%C2%8E}
  path=${path//$'\xc2\x8f'/%C2%8F}
  path=${path//$'\xc2\x90'/%C2%90}
  path=${path//$'\xc2\x91'/%C2%91}
  path=${path//$'\xc2\x92'/%C2%92}
  path=${path//$'\xc2\x93'/%C2%93}
  path=${path//$'\xc2\x94'/%C2%94}
  path=${path//$'\xc2\x95'/%C2%95}
  path=${path//$'\xc2\x96'/%C2%96}
  path=${path//$'\xc2\x97'/%C2%97}
  path=${path//$'\xc2\x98'/%C2%98}
  path=${path//$'\xc2\x99'/%C2%99}
  path=${path//$'\xc2\x9a'/%C2%9A}
  path=${path//$'\xc2\x9b'/%C2%9B}
  path=${path//$'\xc2\x9c'/%C2%9C}
  path=${path//$'\xc2\x9d'/%C2%9D}
  path=${path//$'\xc2\x9e'/%C2%9E}
  path=${path//$'\xc2\x9f'/%C2%9F}
  printf '\033]7;file://%s\007' "$path"
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
  # A hint only: never eval or execute the saved command.
  if [[ -n ${ZSH_VERSION:-} ]]; then print -s -- "$cmd"; else history -s "$cmd"; history -a; fi
  printf '\033[2m[mast] resume previous agent: %s\033[0m\n' "$cmd"
}
