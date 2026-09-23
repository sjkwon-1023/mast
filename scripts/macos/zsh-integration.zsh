source "$HOME/.mast/shell/integration.sh"
if [[ -n $MAST_TAB && $MAST_TAB != *[!0-9]* ]]; then
  mkdir -p "$HOME/.mast/history"
  # 별도 history 컨텍스트를 push 한다. 사용자의 전역 history 를 가져오거나 거기에 덧붙이지 않는다.
  fc -p "$HOME/.mast/history/zsh-tab-$MAST_TAB" 10000 10000
  unsetopt SHARE_HISTORY
  setopt APPEND_HISTORY INC_APPEND_HISTORY
  _mast_resume
fi
autoload -Uz add-zsh-hook
add-zsh-hook precmd _mast_cwd
_mast_cwd
