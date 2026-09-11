#!/usr/bin/env bash
# OSC passthrough 수동 검증 스크립트 (계획 v2 3장 "OSC passthrough 검증", spike-plan 4.1)
#
# ConPTY가 WSL 안에서 방출한 OSC 0/7/9/777 시퀀스를 mast 앱(Rust PTY 리더)까지
# 그대로 통과시키는지 눈으로 확인하기 위한 스크립트다. 종결자는 BEL(\x07)과
# ST(ESC \) 두 가지를 모두 시험한다 — 구현에 따라 둘 중 하나만 인식하는 경우가 있다.
# 마지막 케이스는 시퀀스를 두 번의 write로 쪼개 청크 경계에 걸쳐도 감지되는지 확인한다.
#
# 사용법:
#   scripts/wsl/osc-test.sh
#
# 앱을 실행한 상태에서 이 스크립트가 붙어 있는 바로 그 터미널(WSL bash)에서
# 실행한다. spike 앱은 OSC 이벤트 로그에 케이스 1~9가 찍히는지 대조하고, mast
# 앱(18단계 이후 — osc-event 로그 없음)은 모델 라우팅 표면으로 확인한다: 케이스
# 5~9는 다른 탭에서 보면 탭 dot·pane ● 배지·사이드바 집계 dot(제목이 mast: 토큰이
# 아니라 상태 중립), 케이스 10~12는 사이드바 상태 아이콘·미리보기, 케이스 1~4는
# 탭 제목·cwd(재시작 후 respawn 경로) 갱신이다.
# 이 문서/스크립트가 방출하는 OSC 시퀀스의 실제 형식(예: OSC 777)은
# `\033]777;notify;제목;본문\007` 이다.

set -euo pipefail

ESC=$'\033'
BEL=$'\007'
ST="${ESC}\\"
TTY=/dev/tty

case_header() {
  echo
  echo "case $1: $2"
}

emit() {
  # emit <osc-body> <terminator>
  # osc-body는 "]" 다음부터 종결자 앞까지의 내용이다.
  printf '%s%s%s' "$ESC" "$1" "$2" > "$TTY"
}

# --- OSC 0: 아이콘 이름 + 창 제목 ---

case_header 1 "OSC 0 title, BEL terminator"
emit "]0;mast-osc-test-case-1" "$BEL"

case_header 2 "OSC 0 title, ST terminator"
emit "]0;mast-osc-test-case-2" "$ST"

# --- OSC 7: cwd (file:// URI) ---

HOST="$(hostname)"
CWD="$(pwd)"

case_header 3 "OSC 7 cwd, BEL terminator"
emit "]7;file://${HOST}${CWD}" "$BEL"

case_header 4 "OSC 7 cwd, ST terminator"
emit "]7;file://${HOST}${CWD}" "$ST"

# --- OSC 9: 알림 (iTerm2 계열, message만) ---

case_header 5 "OSC 9 notify, BEL terminator"
emit "]9;mast-osc-test-case-5" "$BEL"

case_header 6 "OSC 9 notify, ST terminator"
emit "]9;mast-osc-test-case-6" "$ST"

# --- OSC 777: 알림 (urxvt 계열, notify;title;body) ---
# 형식: \033]777;notify;제목;본문\007  (BEL) 또는 \033]777;notify;제목;본문\033\  (ST)

case_header 7 "OSC 777 notify, BEL terminator"
emit "]777;notify;mast-osc-test-case-7;OSC 777 BEL body" "$BEL"

case_header 8 "OSC 777 notify, ST terminator"
emit "]777;notify;mast-osc-test-case-8;OSC 777 ST body" "$ST"

# --- 분할 테스트: 한 시퀀스를 두 번의 write로 쪼개 청크 경계 처리 확인 ---
# PTY 리더가 feed()를 여러 번 호출받아도(청크 경계에 걸려도) 시퀀스를 이어 붙여
# 인식하는지 확인한다. 두 write 사이에 0.2초를 둔다.

case_header 9 "OSC 777, split across two writes (0.2s apart)"
printf '%s]777;notify;mast-osc-test-case-9;split-' "$ESC" > "$TTY"
sleep 0.2
printf 'payload%s' "$BEL" > "$TTY"

# --- mast: 상태 토큰 (18단계 hook 규약 — claude-hook-example.md) ---
# 제목이 mast:<status> 면 상태 알림이다: 사이드바 상태 아이콘이 바뀌고, unread 는
# needsInput·idle 만 세운다 (running 은 진행 신호 — dot 없음). 다른 워크스페이스로
# 전환한 뒤 실행하면 사이드바에서 순서대로 running → needsInput → idle 로 바뀌는
# 것을 볼 수 있다 (각 케이스 사이 2초).

case_header 10 "mast:running status token (no body)"
emit "]777;notify;mast:running;" "$BEL"
sleep 2

case_header 11 "mast:needsInput status token (preview body)"
emit "]777;notify;mast:needsInput;osc-test needs your input" "$BEL"
sleep 2

case_header 12 "mast:idle status token"
emit "]777;notify;mast:idle;done" "$BEL"

echo
echo "Done. In the spike app, verify cases 1-9 in the OSC event log; in the mast app,"
echo "verify the routing of cases 5-12 in the tab dot, pane badge, and sidebar (status icon,"
echo "preview, aggregate dot). If case 9 (split) is not detected, re-check OscScanner's"
echo "chunk-boundary handling."
