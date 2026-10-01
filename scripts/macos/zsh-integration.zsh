source "$HOME/.mast/shell/integration.sh"
if [[ -n $MAST_TAB && $MAST_TAB != *[!0-9]* ]]; then
  mkdir -p "$HOME/.mast/history"
  # 빈 history 컨텍스트를 push 해 사용자의 전역 history 를 가져오거나 거기에 덧붙이지 않는다.
  # 파일은 zsh 가 시작 파일 뒤에 HISTFILE 을 읽을 때 한 번만 읽힌다 — `fc -p <파일>` 로 지금
  # 읽으면 그 읽기와 겹쳐 저장된 명령이 두 번 들어간다.
  fc -p
  HISTFILE="$HOME/.mast/history/zsh-tab-$MAST_TAB" HISTSIZE=10000 SAVEHIST=10000
  unsetopt SHARE_HISTORY
  setopt APPEND_HISTORY INC_APPEND_HISTORY
  # 같은 이유로 여기서 바로 넣으면 resume 줄이 파일 내용 앞에 놓여 ↑ 로 나오지 않으므로 첫
  # 프롬프트 직전에 넣는다.
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
