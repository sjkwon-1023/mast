source "$HOME/.mast/shell/integration.sh"
if [[ -n $MAST_TAB && $MAST_TAB != *[!0-9]* ]]; then
  mkdir -p "$HOME/.mast/history"
  # Push a separate history context. Do not import or append to the user's global history.
  fc -p "$HOME/.mast/history/zsh-tab-$MAST_TAB" 10000 10000
  unsetopt SHARE_HISTORY
  setopt APPEND_HISTORY INC_APPEND_HISTORY
  _mast_resume
fi
autoload -Uz add-zsh-hook
add-zsh-hook precmd _mast_cwd
_mast_cwd
