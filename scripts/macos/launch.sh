#!/bin/bash
# Arguments, never shell interpolation: shell executable, stable tab ID, initial cwd.
set -eu
shell=$1
export MAST=1 MAST_TAB="$2" TERM=xterm-256color COLORTERM=truecolor
export MAST_TTY="$(/usr/bin/tty)"
export MAST_SHELL_PID=$$
export TERM_PROGRAM=mast BASH_SILENCE_DEPRECATION_WARNING=1
export MAST_CONFIG_PATH="${4:-}"
export PATH="$HOME/.mast/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# Finder does not necessarily inherit a UTF-8 locale from an interactive terminal.
if [[ -z ${LANG:-} && -z ${LC_ALL:-} && -z ${LC_CTYPE:-} ]]; then export LANG=en_US.UTF-8; fi
cd -- "$HOME"
if [[ -n $3 ]] && ! cd -- "$3" 2>/dev/null; then
  printf '\033[2m[mast] saved directory is unavailable; starting in $HOME\033[0m\n'
fi
printf '\033]777;mast-started\007\033]10;#cccccc\033\\\033]11;#1e1e1e\033\\'
case ${shell##*/} in
  zsh)
    export MAST_USER_ZDOTDIR_SET="${ZDOTDIR+x}" MAST_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
    export ZDOTDIR="$HOME/.mast/shell/zsh"
    exec "$shell" -il
    ;;
  bash) exec "$shell" --noprofile --rcfile "$HOME/.mast/shell/bashrc" -i ;;
  *) printf 'mast: supported shells are zsh and bash\n' >&2; exit 2 ;;
esac
