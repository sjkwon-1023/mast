#!/usr/bin/env bash
# mast 탭의 `codex` 를 Codex 공유 app-server daemon 없이 띄운다. ~/.mast/bin/codex 로 설치되고, ~/.mast/bin 은
# mast 탭 셸의 PATH 맨 앞에만 있으므로(host.rs, integration.sh) mast 밖의 codex 는 그대로다. 셸 함수가 아니라
# PATH 의 실행 파일인 이유는 하네스처럼 PATH 에서 codex 를 찾아 직접 exec 하는 경로까지 덮기 위해서다.
#
# Codex 0.162 부터 TUI 는 공유 daemon(`codex app-server --managed-daemon`)에 붙고 훅·notify 를 그 daemon 이 실행한다.
# daemon 은 처음 띄운 탭의 환경(MAST_TAB·MAST_PROMPT_GEN)을 물려받은 채 tty 없이 앱 종료 뒤에도 남는다. 그래서
# 다른 탭의 resume 힌트와 상태가 그 탭으로 가거나 사라지고, 힌트 세대가 어느 셸과도 맞지 않아 autoResume 이
# 동작하지 않는다. `--no-daemon` 이면 TUI 안의 내장 서버가 이 탭의 환경과 tty 로 훅을 실행한다(ADR-0026).
# `features.daemon_auto_start=false` 는 이미 떠 있는 daemon 에 그대로 붙으므로 대안이 아니다.
#
# 0.163 은 루트의 `--no-daemon` 뒤에 오는 서브커맨드를 프롬프트로 읽고, resume·fork 는 자기 옵션으로 받는다.
# 그래서 대화형 실행에만 붙인다. 서브커맨드는 인자 전체에서 찾는다 — 첫 위치 인자만 보면 `-m <모델>` 같은
# 옵션 값에서 멈춘다. 목록에 없는 새 서브커맨드는 프롬프트로 읽히므로 Codex 를 올릴 때 이 목록을 맞춘다.

real=""
IFS=: read -r -a dirs <<< "$PATH"
for dir in "${dirs[@]}"; do
  case "$dir" in
    "" | "$HOME/.mast/bin" | "$HOME/.mast/bin/") continue ;;
  esac
  if [[ -f "$dir/codex" && -x "$dir/codex" ]]; then
    real="$dir/codex"
    break
  fi
done
if [[ -z "$real" ]]; then
  echo "codex: command not found (mast's codex wrapper found no other codex on PATH)" >&2
  exit 127
fi

for arg in "$@"; do
  case "$arg" in
    --no-daemon | --remote | --remote=*) exec "$real" "$@" ;;
  esac
done

for ((i = 1; i <= $#; i++)); do
  case "${!i}" in
    resume | fork) exec "$real" "${@:1:i}" --no-daemon "${@:i+1}" ;;
    agents | exec | e | review | login | logout | mcp | plugin | app-server | remote-control | completion \
      | update | doctor | sandbox | debug | apply | a | queue | archive | delete | migrate-rollouts \
      | unarchive | cloud | exec-server | features | help | responses-api-proxy | stdio-to-uds)
      exec "$real" "$@" ;;
  esac
done
exec "$real" --no-daemon "$@"
