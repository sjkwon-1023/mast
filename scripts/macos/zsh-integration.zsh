source "$HOME/.mast/shell/integration.sh"
if [[ -n $MAST_TAB && $MAST_TAB != *[!0-9]* ]]; then
  mkdir -p "$HOME/.mast/history"
  # 별도 history 컨텍스트를 push 한다. 사용자의 전역 history 를 가져오거나 거기에 덧붙이지 않는다.
  fc -p "$HOME/.mast/history/zsh-tab-$MAST_TAB" 10000 10000
  unsetopt SHARE_HISTORY
  setopt APPEND_HISTORY INC_APPEND_HISTORY
  # zsh 는 시작 파일을 다 읽은 뒤 HISTFILE 을 한 번 더 읽어 그 내용을 목록 끝에 붙인다.
  # 여기서 바로 넣으면 resume 줄이 파일 내용 뒤에 묻혀 ↑ 로 나오지 않으므로 첫 프롬프트 직전에 넣는다.
  _mast_resume_first=1
  _mast_resume_prompt() {
    if (( _mast_resume_first )); then
      _mast_resume_first=0
      _mast_resume
    else
      _mast_resume quiet
    fi
  }
fi
autoload -Uz add-zsh-hook
add-zsh-hook precmd _mast_cwd
(( $+functions[_mast_resume_prompt] )) && add-zsh-hook precmd _mast_resume_prompt
_mast_cwd
