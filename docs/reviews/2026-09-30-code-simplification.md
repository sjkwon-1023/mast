# Mast 코드 간소화 검토와 정리 결과

- 검토일: 2026-09-30
- 기준: main `fc6c83e`
- 범위: 데스크톱 프런트엔드, Rust 코어·글루, 원격 표면, 테스트, CI, `CLAUDE.md`

쓰이지 않는 코드, 반복 구현, 이력성 주석을 줄였다. 코드·테스트·CI는 88개 파일에서 1,783줄을 지우고 756줄을 더했다. `CLAUDE.md`는 1,167줄에서 255줄로 줄었다. 동작 변경은 SwitchTracer를 개발 빌드로 한정한 것 하나다.

## 적용한 정리

| 대상 | 변경 | 근거 |
| --- | --- | --- |
| 알림음 `Chime` | 클래스·unlock·오디오 fake 테스트 삭제. 남은 판정 모듈을 `notifications/needs-input.ts`로 개명 | v0.3.7부터 호출자가 없었다. |
| 수동 전송 모드 | `SendMode`, 전달 경로와 가드, `SendController`·`SendStatus`, 상태 라인 프롬프트, `.send-mode` CSS, 전달 전용 `TerminalView` 메서드 삭제 | 보존 이유였던 에이전트 채널이 `mast send`로 따로 구현됐다. [ADR-0005](../adr/0005-inter-pane-text-passing.md)에 삭제를 기록했다. |
| 오류 문자열 변환 | 네 곳의 `describeError`를 `String(err)`와 템플릿 보간으로 대체 | 문자열에도 `String()`의 결과가 같다. |
| 뷰어 배너 | 세 뷰어의 같은 `setBanner` 메서드를 `viewer-view.ts`의 함수 하나로 통합 | 구현이 같았다. |
| `isCommandError` | variant 목록을 `Record<CommandError["type"], true>`에서 판정 | variant가 늘면 컴파일이 실패한다. |
| 테스트 헬퍼 | `termOf`·`attachBody`·`deferred`를 `src/test-helpers.ts`로, provision 훅 정의·파일 검사를 `tests/provision-fixtures.ts`로 이동 | 6개·6개·2개 파일에 복제돼 있었다. |
| CI | `windows-gates`의 x64 `cargo check --workspace` 삭제 | `clippy --all-targets`가 같은 타깃의 lib·bin을 컴파일한다. |
| SwitchTracer | `import.meta.env.DEV`일 때만 계측 시작 | 릴리즈 빌드의 상시 계측을 없앤다. WINDOWS-BUILD 절차는 dev 빌드로 안내한다. |
| 코드 주석 | 단계 번호, 삭제된 계획 문서의 절 인용, "리뷰 finding", 버전·날짜 이력을 제거하고 이유만 남김 | 이력은 ADR과 git에 있다. |
| 루트 `AGENTS.md` | 삭제 (사용자 승인) | 병합이 끝난 PR #48·#49의 일회성 승인만 담고 있었다. |
| `CLAUDE.md` 백로그 | 반영된 기록을 지우고 남은 작업과 수용한 한계만 ADR 링크와 함께 유지 | 기록은 ADR에 있다. |

## 적용하지 않은 후보

- **프레임당 fit 예약 공통화**: 터미널과 기록 뷰의 구현은 같지만, 헬퍼 파일과 배선을 더하면 줄어드는 양이 거의 없다.
- **`mutations.rs`의 준비된 탭 추가 공통화**: 줄 수 감소가 작고, 스폰·ID 할당·상태 반영의 순서를 한 함수에 묶을 이유가 없다.
- **Windows 메모리 watchdog 측정 생략**: 브라우저 탭 때문에 리셋이 억제되는 동안 측정을 건너뛸 수 있다. 다만 샘플 값과 pending 상태의 의미를 따로 검증해야 한다.
- **CSS 원문을 고정하는 `diff-presentation-view.test.ts` 검사와 `apps/spike`의 기본 CI 포함**: 요구사항과 표기를 나누는 작업이라 이번 정리에서 제외했다.
- **런타임 검증** (`debug_assert_invariants`, 저장 상태 검증, 세션 레지스트리 audit, 원격 인증·프레임·입력 상한): 실패를 막는 경계이므로 유지한다.

## 남은 판단

- 주석은 이력성 표현만 걷었다. 이유를 길게 설명하는 주석은 파일을 고칠 때 함께 줄인다.

## 검증

- `cargo test -p mast-core` 통과.
- `apps/mast` 빌드, `tsc --noEmit`, vitest 통과(1158 passed). Linux 전용 `tests/` 스위트는 node 24 Linux 컨테이너에서 434건 통과.
- 로컬 macOS의 `cargo test -p mast-remote`는 WebTransport 테스트 7~9건이 수정 전 main에서도 똑같이 실패한다. 이 PR에서 해당 크레이트는 주석만 바뀌었다. Windows 타깃 clippy와 Linux 게이트는 CI가 맡는다.
