# 수명·위생 배치 실행 계획 (2026-09-12)

> **상태: 실행 중.** 이 문서는 진행 중 작업의 기준선이다. 배치가 끝나면 각 PR 의 결정은 ADR 로
> 증류되고(ADR-0018 등) 이 파일은 삭제된다 (`CLAUDE.md` `## Docs` 규칙).

사용자 요청(2026-09-12)에서 Git/Changes viewer 를 제외한 나머지를 실행한다. 방향 서술(경량성
원칙·제품 방향·모바일 briefing UX)은 코드 작업이 아니라 `CLAUDE.md` 의 원칙 절에 이미 있으므로
여기서는 다루지 않는다.

## 1. 묶음과 순서

| # | 브랜치 / 워크트리 | 내용 | 리뷰 |
|---|---|---|---|
| 1 | `test/windows-pty-soak` / `../winmux-pty-soak` | ConPTY create/close/respawn soak 테스트 (Rust `#[ignore]` Windows 전용 + PowerShell 래퍼 + 문서) | 워크플로 내부 2렌즈 적대 리뷰 + 메인 검증. 실행은 사용자(Windows) |
| 2 | `fix/reattach-redraw` / `../winmux-reattach` | Codex scroll: reattach 경로(replay + 강제 SIGWINCH) 실측 조사 → 같은 WebView 수명 안 재표시에 대한 redraw 정책 축소 | Opus `change-critic` + **codex 옆 pane 리뷰** |
| 3 | `feat/exited-tab-record` / `../winmux-exited-record` | exited 탭 = terminal record + 백엔드 위생(정합성 검사·orphan 정리·진단·Saver 슬롯). ADR-0018 | `/review-plan`(Opus 초안·반증) → 구현 → `change-critic` → **codex 옆 pane 리뷰** |
| 4 | `chore/comment-cleanup` / `../winmux-comment-cleanup` | 쓸모없는 주석 정리 — PR 1~3 이 손대지 않는 파일만. PR 1~3 이 손대는 파일은 각 PR 안에서 별도 첫 커밋으로 정리 | 워크플로(정리 → 반증 검증) + 메인 diff 검토 |

원래 4개였던 3(record)·4(hygiene)는 사용자 결정으로 하나로 합쳤다 — exited 탭이 세션을 놓아야
"탭이 참조하지 않는 세션 = orphan" 규칙이 성립하기 때문이다.

모든 PR 은 `main`(e39d51b, PR #21 머지 후)에서 분기하고 서로 파일이 겹치지 않게 잡아 머지 순서에
의존하지 않는다. PR 제목은 영어(squash 머지 → main 의 영구 commit 제목), 본문은 한국어.

## 2. PR 3 — exited tab = terminal record + backend hygiene

확정 실행계획은 [`exited-tab-record-plan.md`](exited-tab-record-plan.md) 이다(`/review-plan` 의 반증 판정
**revise** 를 취합한 결과 — 채택·기각 목록은 그 문서 0절). 핵심 결정:

- **D1 기록 = raw 바이트.** exit 시 `reattach()` 와 같은 재료(DEC 모드 preamble + replay 스냅샷)를
  `<app_data_dir>/records/tab-<id>.bin` 에 원자적으로 쓴다. Rust 쪽 그리드 렌더러는 만들지 않는다.
- **D2 exit 처리 순서(waiter 스레드):** `take_record` → 파일 쓰기(Dispatcher lock 밖) → lock 안에서
  `SessionExited { code, ended_at_ms }` 적용(`pty_session = None`) + publish → lock 밖에서 sink·세션
  레지스트리 제거. 모델 갱신보다 파일이 먼저 있어야 프론트가 빈 기록을 보지 않는다.
- **D3 기록은 앱 재시작을 넘어 남는다.** `persist::sanitize` 는 `Exited` 를 유지하고 `NotStarted → Running`
  만 되돌린다. ADR-0010 의 "Exited → Running" 은 Restart 버튼이 없던 시절의 장치였고, 이제 되살리는
  길은 배너의 Restart 다. 절전으로 WSL 이 내려가도 앱은 살아 있으므로 탭별 Restart 로 복구한다.
- **D4 파일명은 탭 id 로 유도**, 모델에 경로를 저장하지 않는다.
- **D5 orphan 정리는 "레지스트리에 있는데 어떤 탭도 참조하지 않음" 만**, 잠금 순서는 레지스트리
  스냅샷 → Dispatcher lock 순(반대는 갓 만든 세션을 죽인다). 주기 타이머 없음. 반대 방향(탭이 참조하는데
  레지스트리에 없음)은 탭을 `Exited` 로 수리만 한다.
- **D6 원격 표면 불변** (폰은 exited 탭에 409 그대로). **D7 Saver 는 latest-state 슬롯**(대기 clone ≤ 1).

프론트: exited 탭은 `planViewSync` 의 `visible` 에서 자연히 빠지고, 새 `RecordView` 가 **뷰어 수명**
(활성 탭일 때만 마운트)으로 `viewerViews` 레지스트리 안에서 산다 — 읽기 전용 xterm, 채널·ack·resize 없음,
줌 키는 동일 적용. 배너에 exit code 와 종료 시각을 넣는다.

기록 파일 수명: exit 시 덮어쓰기 → `respawn_tab` 성공 직후 삭제 → Close* 경로에서 삭제(ADR-0013
확장) → 부팅 시 `Exited` 탭 id 집합 밖의 파일 sweep.

버전 **0.3.25**(PR 2 가 0.3.24). 문서: ADR-0018, ADR-0010·0013 개정 한 줄, `CLAUDE.md` 백로그 4항목 최소 갱신,
`docs/WINDOWS-BUILD.md` §10 v0.3.25.

## 3. PR 2 — reattach 경로와 Codex scroll

조사가 먼저다(가설 H1: SIGWINCH 가 Codex 의 transcript 스크롤을 리셋한다 / H2: 무손실 replay 를 새
터미널에 먹이면 스크롤된 화면이 재현된다 / H3: 앞이 evict 된 replay 는 전체 재그리기 없이는 화면이
틀린다). 이 박스의 `codex` 0.153.4 를 pty 에서 `resume` 으로 띄워 휠업 → SIGWINCH → 캡처를 headless
xterm 으로 렌더해 비교한다(모델에 메시지는 보내지 않는다).

실측 결과(2026-09-12): codex 0.153.4 기본 UI 는 대체 화면을 쓰지 않고 transcript 를 일반 버퍼 스크롤백에
인쇄하므로 스크롤 위치는 xterm 쪽 상태(`viewportY`)이고 바이트열에 없다 — nudge 는 원인이 아니며(대체 화면
오버레이에서는 SIGWINCH 뒤에도 위치 유지), 오히려 Codex 의 전체 히스토리 재인쇄(왕복당 약 192 KB)로
스크롤백을 복구해 준다. 그래서 nudge 는 유지하고, 프론트가 dispose 직전 "하단 기준 줄 수"를 탭별로
기억해 replay 직후와 재인쇄가 잠잠해진 뒤 두 번 되돌린다(WebView 수명 한정). ADR-0019, 버전 0.3.24.

## 4. PR 1 — soak 테스트

`crates/mast-core/tests/soak_windows.rs`(`#![cfg(windows)]`, `#[ignore]`): (A) 자연 종료 / (B) 실행 중
kill / (C) spawn 직후 kill 을 순환하며 handle·thread·private bytes·working set·conhost/OpenConsole/wsl/
wslhost/wslrelay 프로세스 수·pool 을 CSV 로 찍고, warm-up 뒤 baseline 대비 settle 후 복귀를 판정한다.
env 로 사이클 수·모드(`wsl`/`cmd`)·허용치 조정. 여기서는 Windows 타깃 clippy 로 컴파일만 검증하고
첫 실행은 사용자 몫이다.

## 5. PR 4 — 주석 정리

기준은 전역 `~/.claude/CLAUDE.md` "코드 · 주석": 이름을 풀어 쓴 doc, 바로 아래 코드를 옮겨 적은 줄,
구획 라벨, 절반 재진술 주석(실질만 남김)은 제거. 외부 시스템의 실제 동작·그렇게 짜야 했던 이유·
여러 모듈에 걸친 연결은 남긴다. `계획 v2 n장` 인용은 제거된 문서를 가리키지만 `CLAUDE.md` 가 git
history 로 읽으라고 명시하므로 그대로 둔다. `eslint-disable`·`allow(...)` 류 지시어는 코드로 취급.
`apps/spike` 는 동결 하네스라 제외.

## 6. 검증과 실측

자동 게이트는 `CLAUDE.md` `## Gates` 의 명령 전부. 사용자 실측(Windows)은 배치가 끝난 뒤 한 번에
한다 — 각 PR 은 `docs/WINDOWS-BUILD.md` §10 에 체크리스트만 남긴다. codex 리뷰는 PR 2·3 에 대해
`/peer-review` 경로 B(옆 pane `#6`, 일회성 실행, effort `xhigh`)로 받고, findings 는 메인이 코드로
확인한 뒤 채택한다.

## 7. 진행 상태

- [x] PR #21 머지, main 갱신, 워크트리 4개 생성
- [x] PR 1 soak 테스트 → #23
- [x] PR 2 스크롤 복원 → #25 (조사 → 구현 → change-critic → codex 리뷰 4건 반영, 0.3.24)
- [x] PR 3 exited-tab record + hygiene → #22 (`/review-plan` 확정 → 청크 1a·1b·2·3·4·5·6 → ADR-0018, 0.3.25;
      확정 실행계획 `exited-tab-record-plan.md` 는 ADR 로 증류되어 삭제됨)
- [x] PR 4 주석 정리 → #24
- [ ] 네 PR 머지 후 이 문서 삭제 (각 PR 본문과 ADR-0018·0019 가 기록을 대신한다)
