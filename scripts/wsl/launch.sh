# WSL 탭 셸을 띄우는 래퍼 본문의 정본.
#
# host.rs 의 bash_argv 가 이 파일을 include_str! 로 넣어
#   wsl.exe --cd ~ [-d distro] --exec bash -c <이 본문> mast-wsl <탭 id 또는 ""> <cwd 또는 "">
# 로 실행한다. $1 은 10진수 탭 id 이고 빈 값이면 탭 id 가 없다. $2 는 목적지 cwd 이고 빈 값이면
# 홈에 머문다. 두 값은 데이터다 — 이 스크립트 텍스트에 끼워 넣거나 셸 코드로 다시 평가하지 않는다.

# 시작 표식. 이 래퍼가 WSL 안에서 실제로 돌았다는 유일한 증거라서 반드시 첫 출력이어야 하고,
# 뒤따르는 파일 I/O 나 셸 선택이 막혀도 도달 자체는 증명돼야 한다. OSC 777 을 쓰는 이유는
# mast_core::osc::OscEvent::Osc777Started 의 rustdoc 을 본다.
printf '\033]777;mast-started\007'

# 테마 동기화. WT 1.22+ 의 conhost 는 TUI 앱의 OSC 10/11 질의에 자기 색 테이블로 대신 답한다
# (ms/terminal#17729). Codex 처럼 배경색을 질의해 입력칸 배경을 고르는 앱은 검정 기준으로 색을 골라
# 우리 배경(#1e1e1e)과 겹친다. set 은 conhost 가 소비해 자기 테이블을 갱신하므로 이후의 질의에
# 올바른 값으로 답하게 된다. xterm 까지 오지 않아 프론트엔드에는 영향이 없다.
# 3자 동기화 계약: 이 두 값은 apps/mast/src/features/terminal/settings.ts 의 TERMINAL_THEME,
# apps/mast/src-tauri/src/sink.rs 의 COLOR_REPLY_FOREGROUND/BACKGROUND 와 같아야 한다. 하나를 바꾸면 셋 다 바꾼다.
printf '\033]10;#cccccc\033\\\033]11;#1e1e1e\033\\'

tab=${1-}
cwd=${2-}
auto=${3-}

# 탭 id 는 파일 경로에 들어가므로 파일을 건드리기 전에 10진수인지 확인한다.
case $tab in
  '') ;;
  *[!0-9]*) printf 'mast: tab id must be a decimal number\n' >&2; exit 1 ;;
esac

# 목적지 cwd 로 옮긴다. 래퍼는 --cd ~ 로 이미 홈에서 시작하므로 실패하면 홈에 머물고, 그 사실을
# 흐리게 알린다. 사용자가 왜 다른 곳에 있는지 알아야 해서 조용히 넘기지 않는다.
if [ -n "$cwd" ]; then
  cd -- "$cwd" 2>/dev/null || printf '\033[2m[mast] %s is gone; starting in $HOME\033[0m\n' "${cwd//[[:cntrl:]]/?}"
fi

# 로그인 셸은 $SHELL 을 쓰고, 비어 있으면 passwd 의 셸을 쓴다. 절대경로의 실행 가능한 bash 또는 zsh 가
# 아니면 /bin/bash 로 가며 그 사실을 흐리게 알린다. 안내 값의 제어문자는 그대로 내보내지 않는다.
shell=${SHELL:-}
if [ -z "$shell" ]; then
  shell=$(getent passwd "$(id -u)" | cut -d: -f7)
fi
shell_name=${shell##*/}
if [[ $shell != /* || ! -f $shell || ! -x $shell || ($shell_name != bash && $shell_name != zsh) ]]; then
  printf "\033[2m[mast] login shell '%s' is not zsh or bash; this tab runs /bin/bash\033[0m\n" "${shell//[[:cntrl:]]/?}"
  shell=/bin/bash
  shell_name=bash
fi

# zsh 는 mast 의 자산 여섯 개가 모두 읽을 수 있는 일반 파일일 때만 띄운다. 하나라도 빠지면 bash 로그인 경로로
# 시작한다. 업그레이드 직후의 첫 실행에서 zsh 탭이 exited 로 보이지 않게 하려는 선택이다. 이 경로는 사용자
# 로그인 파일이 셸을 다른 것으로 바꿀 수 있고, 그 셸에는 mast 통합(cwd 보고)이 없다.
zsh_assets_ready() {
  local asset
  for asset in integration.sh zsh-integration.zsh zsh/.zshenv zsh/.zprofile zsh/.zshrc zsh/.zlogin; do
    [ -f "$HOME/.mast/shell/$asset" ] && [ -r "$HOME/.mast/shell/$asset" ] || return 1
  done
}
if [ "$shell_name" = zsh ] && ! zsh_assets_ready; then
  printf '\033[2m[mast] zsh integration is not installed yet; this tab starts without it. Once setup finishes, exit it and press Restart\033[0m\n'
  shell=/bin/bash
  shell_name=bash
fi

# 탭 history 디렉터리는 셸 종류와 무관하게 탭 id 가 있으면 만든다. Windows 쪽에서 WSL 홈 경로를
# 추측하지 않도록 셸 안에서 만든다. 실패하면 셸을 띄우지 않고 끝나 탭이 exited 로 보인다 — 조용한 fallback 은 없다.
if [ -n "$tab" ] && ! mkdir -p "$HOME/.mast/history"; then
  printf 'mast: cannot create %s\n' "$HOME/.mast/history" >&2
  exit 1
fi

# PATH 앞에 프로비저닝이 까는 mast CLI 디렉터리를 붙여 탭 안에서 `mast` 를 경로 없이 부르게 한다.
# 로그인 셸이 덮지 않는 이유: Debian/Ubuntu 의 /etc/profile·~/.profile 은 PATH 를 `"...:$PATH"` 로
# 앞에 붙이므로 우리 항목은 밀릴 뿐 사라지지 않는다. 디렉터리가 아직 없어도 무해하다.
export PATH="$HOME/.mast/bin:$PATH"
# MAST=1: 탭 안의 에이전트·스크립트가 mast 안에서 도는지 스스로 알아야 send 채널·알림 계약을 쓸지
# 판단할 수 있다 (mast-send 스킬의 자가 인지 조건). COLORTERM 은 위 테마 동기화의 짝이다.
export COLORTERM=truecolor MAST=1
# 자동 재실행 opt-in. 정확한 1 만 켜고, 상속된 값은 지운다. 루트 셸 판정용 PID 는 exec 뒤에도 같다.
if [ "$auto" = 1 ]; then export MAST_AUTO_RESUME=1; else unset MAST_AUTO_RESUME; fi
export MAST_SHELL_PID=$$

if [ "$shell_name" = zsh ]; then
  # zsh 의 history·resume·cwd 보고는 zsh-integration.zsh 가 맡는다. bash 로그인 프로필은 읽지 않으므로
  # 현장의 .profile 이 zsh 로 바꾸는 우회도 이중으로 돌지 않는다. 사용자 ZDOTDIR 은 macOS 래퍼와 같이
  # 보존하며, 시작 파일 체인의 마지막 zlogin 이 최종 값을 되돌린다.
  if [ -n "$tab" ]; then export MAST_TAB="$tab"; else unset MAST_TAB; fi
  unset HISTFILE
  export MAST_USER_ZDOTDIR_SET="${ZDOTDIR+x}" MAST_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
  export ZDOTDIR="$HOME/.mast/shell/zsh"
  exec "$shell" -il
fi

# 설치된 통합 자산이 이 래퍼와 짝인 판(_mast_prompt 를 정의)인지 한 번만 본다. 이 래퍼는 앱에 내장돼 업데이트
# 즉시 바뀌지만 ~/.mast/shell 자산은 부팅 재스폰 뒤의 프로비저닝이 갱신하므로, 그 사이에 뜬 셸은 옛 자산을
# 만난다. 그때는 이전 방식(launch 시점 힌트 + OSC 7 PROMPT_COMMAND)을 그대로 쓴다 — 옛 파일을 읽어도
# _mast_prompt 가 생기지 않아 프롬프트마다 command not found 가 나고, 힌트도 어디서도 나오지 않는다.
integration="$HOME/.mast/shell/integration.sh"
integrated=
if [ -r "$integration" ] && grep -q '^_mast_prompt()' "$integration" 2>/dev/null; then integrated=1; fi

# bash 탭의 history 와 resume 힌트. 탭 id 가 없으면 MAST_TAB·HISTFILE 을 쓰지 않고, 상속된 다른 탭의 값이
# 남아 엉뚱한 history 를 읽지 않도록 지운다.
if [ -n "$tab" ]; then
  # 재시작 직전 세션의 resume 힌트 1행을 HISTFILE 끝에 덧붙여 ↑ 한 번에 나오게 한다. 자동 실행은
  # 하지 않는다. 짝인 통합 자산이 있으면 힌트의 안내·history 기록과 자동 재실행 판정을 첫 프롬프트
  # (integration.sh)가 맡으므로 여기서는 읽지 않는다. 옛 자산이거나 없을 때만 여기서 읽는다.
  # 2행은 기록 시각이며 신선도 판단에는 쓰지 않는다 (의도된 단순화).
  # 형태는 쓰는 쪽(mast-notify.sh, mast-codex-notify.sh)과 짝인 화이트리스트로 검증한다. 같은 uid 가
  # 파일을 바꿔치기해도 ↑+Enter 로 임의 명령을 띄우는 표면이 되지 않게 하는 오발 방지이며 권한 경계는
  # 아니다. 새 에이전트를 붙이려면 여기 패턴에도 형태를 추가해야 한다 — 쓰는 쪽만 고치면 힌트가 조용히 버려진다.
  # 힌트 파일의 부재·읽기 실패·append 실패 어느 것도 셸 시작을 막지 않는다.
  resume="$HOME/.mast/resume/tab-$tab"
  cmd=
  if [ -s "$resume" ] && [ -z "$integrated" ]; then
    IFS= read -r cmd < "$resume" || true
  fi
  hint_re='^(claude --resume|codex resume|opencode --session) [A-Za-z0-9_-]+$'
  [[ $cmd =~ $hint_re ]] || cmd=
  if [ -n "$cmd" ]; then
    printf '%s\n' "$cmd" >> "$HOME/.mast/history/tab-$tab"
    printf '\033[2m[mast] resume previous agent: %s\033[0m\n' "$cmd"
  fi

  # 탭별 history. Ubuntu 기본 .bashrc/.profile 은 HISTFILE 을 덮지 않으므로 export 한 값이 살아남는다.
  export MAST_TAB="$tab" HISTFILE="$HOME/.mast/history/tab-$tab"
else
  unset MAST_TAB HISTFILE
fi

# OSC 7 cwd 보고 (ADR-0011). 사용자 ~/.bashrc 가 아니라 여기서 거는 이유는 남의 파일을 고치지 않고,
# 재프로비저닝 없이 다음 실행부터 먹으며, 로그인 셸이 이 값을 덮지 않기 때문이다. starship 은 상속된
# PROMPT_COMMAND 를 STARSHIP_PROMPT_COMMAND 로 보존해 자기 precmd 뒤에 실행하므로 공존한다.
# `%` 만 미리 인코딩한다: 수신측(notify::parse_file_uri)이 %XX 만 디코드하므로 리터럴 % 만 되살리면
# 왕복이 무손실이다. 매 프롬프트에 도는 코드라 서브셸 없이 파라미터 확장으로 끝낸다.
# OSC 0(제목)은 절대 같이 내지 않는다 — 에이전트가 세운 탭 제목을 디렉터리 이름으로 덮어써 지운다.
# zsh 는 위에서 exec 로 빠지므로 이 값은 bash 에만 간다. zsh 의 보고는 zsh-integration.zsh 의 _mast_cwd 가 한다.
# 짝인 통합 자산이 있으면 첫 호출에서 integration.sh 를 한 번 읽어 그 _mast_prompt 가 세대·hint·cwd 를 맡는다.
# 사용자 rc 가 이 값 앞뒤에 훅을 붙여도 상속된 PROMPT_COMMAND 가 남는다. 자산이 없거나 옛 판이면 OSC 7 만 낸다.
if [ -n "$integrated" ]; then
  export PROMPT_COMMAND='declare -F _mast_prompt >/dev/null || . "$HOME/.mast/shell/integration.sh"; _mast_prompt'
else
  export PROMPT_COMMAND='printf "\033]7;file://%s\007" "${PWD//%/%25}"'
fi

# export 한 값만 새 셸의 환경으로 넘어가고, 위의 일반 셸 변수(cmd·resume)는 exec 와 함께 사라진다.
exec "$shell" -l
