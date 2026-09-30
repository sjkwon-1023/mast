# Mast 코드 간소화 검토

- 검토일: 2026-09-30
- 기준: 원격 main `fc6c83e4bbda4a4291b9803507c48c75db8cb2ec`
- 상태: 정적 검토와 변경 후보 기록. 구현과 삭제는 승인되지 않았다.

현재 기능을 짧고 명확한 코드로 유지하기 위해 휴면 기능, 중복 구현, 테스트의 유지 가치와 런타임 검증 비용을 살폈다. 우선 후보는 작은 공통 동작과 테스트 준비 코드의 중복 제거다. 휴면 전송과 알림음은 삭제 효과가 더 크지만 기존 보존 결정을 재검토해야 한다. 큰 공통 클래스나 범용 실행기를 도입해 코드 길이를 줄이는 방식은 권하지 않는다.

## 검토 범위와 근거

원격 main을 `git pull --ff-only origin main`으로 확인했으며 이미 최신이었다. 데스크톱 프런트엔드, Rust 코어와 Tauri 글루, 원격 표면, 플랫폼 스크립트, 테스트와 CI를 정적으로 확인했다. 테스트 실행과 실제 CPU·RAM 측정은 하지 않았다. 아래 비용 판단은 호출 위치와 코드 흐름에 근거하며 측정 결과가 아니다.

`apps/`, `crates/`, `scripts/`의 추적된 `.ts`, `.rs`, `.py`, `.js`, `.mjs`, `.css`, `.sh`, `.ps1` 파일은 주석·빈 줄을 포함해 약 9.2만 줄이다. 테스트 전용 파일과 Rust 내부 테스트 모듈을 구분하면 약 4.4만 줄이 테스트에 해당한다. 내부 모듈 경계에 따른 오차가 있는 개략 집계이며 실행 코드만의 LOC나 번들 크기를 뜻하지 않는다. `apps/spike`와 지원 스크립트도 포함한다.

## 작은 공통화와 직접 간소화

### 프레임당 실행 예약

[TerminalView.scheduleFit](../../apps/mast/src/features/terminal/view.ts)과 [RecordView.scheduleFit](../../apps/mast/src/features/viewers/record/view.ts)은 예약 여부를 확인하고, `requestAnimationFrame` 콜백에서 예약을 풀고, dispose되지 않았으면 fit하는 같은 구현이다. [BrowserView.schedule](../../apps/mast/src/features/browser/view.ts)도 프레임당 한 번 실행하지만 프레임 핸들과 정리 방식이 다르다.

콜백을 프레임당 한 번 실행하는 작은 함수로 터미널과 기록 뷰의 중복을 줄일 수 있다. 화면별 fit 동작과 dispose 판정은 호출자에 남긴다. 브라우저는 취소·dispose 의미까지 일치하는지 확인한 뒤 포함하며, 억지로 같은 옵션 집합에 넣지 않는다. 터미널과 기록 뷰의 `fit()`도 같지만 크기 확인 두 줄만을 위해 별도 계층을 만들 필요는 없다.

검증은 같은 프레임의 연속 요청이 한 번 실행되는지, 이후 프레임에 다시 예약되는지, dispose 뒤 작업이 실행되지 않는지를 기존 뷰 테스트에서 확인한다. 헬퍼와 배선까지 포함한 순수 줄 수 감소가 작으면 기존 구현을 유지할 수 있다.

### 뷰어 배너 갱신

[폴더](../../apps/mast/src/features/viewers/folder/view.ts), [텍스트](../../apps/mast/src/features/viewers/text/view.ts), [Markdown](../../apps/mast/src/features/viewers/markdown/view.ts)의 `setBanner()`는 동일하다. `textContent`, `hidden`, `error` 클래스를 같은 방식으로 갱신한다.

배너 요소와 메시지·오류 여부를 받는 작은 함수로 묶을 수 있다. 각 뷰의 DOM 구조와 클래스 이름은 그대로 둔다. 공통 함수 위에 기존 래퍼 메서드를 모두 남기면 줄 수가 거의 줄지 않으므로 호출 배선까지 비교해야 한다. 배너 갱신에는 기존 뷰 테스트를 사용하고 별도 범용 컴포넌트 체계를 만들지 않는다.

### 오류 문자열 변환

위 세 뷰어와 [ChangesView](../../apps/mast/src/features/changes/changes-view.ts)의 `describeError()`는 `typeof err === "string" ? err : String(err)`를 반환한다. 문자열에도 `String()`이 같은 값을 반환하므로 호출 위치에서 `String(err)`로 직접 줄일 수 있다.

새 공통 오류 유틸은 필요 없다. [원격 탭](../../apps/mast/src/remote/tab-view.ts)의 변환은 `Error.message`를 사용하고, [명령 오류 포맷터](../../apps/mast/src/shared/command-error.ts)는 구조화된 오류를 처리하므로 함께 치환하지 않는다.

### 테스트 fixture와 파일 검사

[provision-setup.test.ts](../../apps/mast/tests/provision-setup.test.ts)와 [provision-hooks.test.ts](../../apps/mast/tests/provision-hooks.test.ts)는 훅 명령·정의, `fileText()`, `readJson()`, `fingerprint()`를 반복한다. 공통 fixture와 파일 검사 함수로 옮기면 같은 계약을 여러 곳에서 수정하는 부담을 줄일 수 있다.

이미 있는 [setup-script.ts](../../apps/mast/tests/setup-script.ts)의 책임과 겹치는지 먼저 확인한다. 설치 전체를 실행하는 `Distro`와 병합 헬퍼를 직접 실행하는 `Home`까지 하나의 테스트 환경 클래스로 합치는 것은 권하지 않는다. 두 테스트 층의 목적은 유지하고 공통 데이터와 동일 함수만 묶는다. 각 OS에서 기존 실행·skip 조건도 보존한다.

### 준비된 탭 추가

[mutations.rs](../../crates/mast-core/src/command/mutations.rs)의 `CreateWorkspace`, `SplitPane`, `CreateTab`에는 준비된 탭을 pane에 추가하고 `active_tab`을 갱신하는 반복이 있다. 이 짧은 동작을 함수로 묶을 여지는 있지만 줄 수 감소는 작다.

스폰·경로 검증, ID 예측·할당, 상태 반영은 현재 순서를 유지해야 한다. 실패 시 상태와 ID를 보존하는 원자성까지 범용 생성 함수에 넣지 않는다. 기존 [PreparedTab](../../crates/mast-core/src/command/tabs.rs)이 이미 준비와 탭 변환을 담당하므로 중복되는 추상화를 새로 만들지 않는다.

## 휴면 기능과 상시 계측

### 패널 간 수동 전송

[pane-view.ts](../../apps/mast/src/features/workspace/pane-view.ts)의 전송 버튼과 `armSend()` 호출자가 사라졌지만 [SendMode](../../apps/mast/src/features/workspace/send-mode.ts), [WorkspaceView](../../apps/mast/src/features/workspace/workspace-view.ts)의 대상 선택·전달 가드·클릭 차단·렌더 분기, 관련 CSS와 테스트는 남아 있다. 현재 UI에서 진입할 수 없는 경로이며 삭제 효과가 작은 공통화보다 크다.

[ADR-0005](../adr/0005-inter-pane-text-passing.md)는 사용자 결정으로 이 경로를 보존했다고 기록한다. 삭제는 이 결정을 재검토한 뒤 별도 변경으로 수행한다. 현재 에이전트 간 `mast send` 경로는 유지하고, 붙여넣기·선택·파일 드롭에서 공유하는 터미널 메서드는 사용처를 확인해 보존한다.

### 알림음

[chime.ts](../../apps/mast/src/features/notifications/chime.ts)의 `Chime`, 오디오 생성·재생, `installChimeUnlock`은 테스트 외 호출자가 없다. [chime.test.ts](../../apps/mast/src/features/notifications/chime.test.ts)의 오디오 fake와 휴면 기능 테스트를 함께 제거할 수 있다. 같은 모듈의 needs-input 전이·토스트 대상·문구 판정은 실제 사용 중이므로 유지한다.

기존 [CLAUDE.md](../../CLAUDE.md)는 알림음을 의도적으로 보존한 이력을 기록한다. 문서상 보존 이유를 재검토해야 한다. 오디오 컨텍스트가 현재 생성되지 않으므로 삭제의 주효과는 유지보수·테스트 코드 감소이며 RAM 감소를 약속할 근거는 없다.

### 워크스페이스 전환 계측

[SwitchTracer](../../apps/mast/src/features/workspace/switch-trace.ts)는 구현 162줄, 테스트 126줄이며 App·WorkspaceView·TerminalView에도 배선이 있다. [App](../../apps/mast/src/app/main.ts)은 일반 워크스페이스 전환에서 계측을 시작하고 결과를 `window.__mast.lastSwitch`에 저장한다.

개발 모드에서만 활성화하거나 제거하는 후보이다. [수동 검증 문서](../WINDOWS-BUILD.md)에서 전환 성능을 확인하는 데 사용하므로 계측을 제한하면 해당 절차도 조정한다. 제거가 전환 자체를 바꾸지는 않지만 현재 회귀 측정 수단을 잃는다. 시간·Map·완료 콜백의 비용은 실제로 측정하지 않았다.

## 테스트와 CI 축소 후보

[diff-presentation-view.test.ts](../../apps/mast/src/features/changes/diff-presentation-view.test.ts)는 CSS 원문에서 정확한 색상과 `min(24%, 240px)` 등의 표현을 정규식으로 고정한다. 컨테이너 기준 반응형 동작이라는 요구사항과 특정 CSS 표기를 분리해 후자의 검사를 축소할 수 있다. 소스를 읽는 테스트 전체가 불필요한 것은 아니다. 실제 브라우저 페이지 스크립트를 실행하는 테스트, Rust 직렬화와 프런트 타입을 함께 확인하는 fixture 테스트는 별도 목적이 있다.

설치 통합 테스트는 대표 설치·재실행·실패 전달 흐름을 맡고 병합 헬퍼 테스트는 상세 입력 경계를 맡도록 중복 범위를 점검한다. 현재 테스트 수만으로 삭제 목록을 확정하지 않는다. 사용자 설정 보존, 동시 변경, 심볼릭 링크, 저장 충돌, IME, attach/replay와 종료 정리 테스트는 구체적인 실패를 방지한다.

[CI](../../.github/workflows/ci.yml)는 같은 x64 Windows 타깃의 `clippy --workspace --all-targets` 뒤에 `cargo check --workspace`를 실행한다. 컴파일 범위가 겹치므로 별도 check를 제거할 후보이다. 린트·타깃·feature 조건이 같은지 구현 시 다시 확인한다.

`apps/spike`는 [ADR-0001](../adr/0001-adopt-tauri-webview2-xterm-stack.md)에 근거한 측정·재현 도구다. 기본 CI의 빌드·테스트를 별도 실행으로 옮길 수 있는지 검토하되, 제품 코드로 오인해 일괄 삭제하지 않는다.

## 런타임 검증의 유지 가치

| 대상 | 실행 조건과 코드 근거 | 판단 |
| --- | --- | --- |
| Windows 메모리 watchdog | [reset_supervisor.rs](../../apps/mast/src-tauri/src/reset_supervisor.rs)는 기본 60초마다 프로세스를 열거한다. 브라우저 탭이 있을 때도 측정한 뒤 리셋 정책에는 0을 전달한다. | 브라우저 탭 때문에 메모리 리셋을 억제하는 동안 측정을 먼저 생략할 후보이다. 샘플 값과 pending 상태 갱신 의미를 보존해야 한다. 전체 삭제는 장시간 메모리 증가에 대한 자동 UI 회수 기능을 잃는다. macOS에는 메모리 watchdog 구현이 없어 비활성화된다. |
| 명령 후 상태 불변식 검사 | [Workspace.debug_assert_invariants](../../crates/mast-core/src/model.rs)는 `debug_assertions` 조건에서만 검증한다. | 릴리즈 성능 절감을 위해 삭제할 대상이 아니다. 개발 중 잘못된 상태 변이를 잡는다. |
| 저장 상태 검증 | [persist.rs](../../crates/mast-core/src/persist.rs)는 시작 시 상태를 읽고 unknown tab 제거 전후를 검증한다. | 손상된 레이아웃·중복 ID를 막는다. 반복 검사 단순화 여지는 있어도 실행 빈도가 낮아 성능 우선순위는 낮다. |
| 세션 레지스트리 audit | [audit.rs](../../apps/mast/src-tauri/src/audit.rs)는 종료·닫기·부팅 완료·진단 요청 때 모델과 레지스트리를 대조한다. 주기 타이머는 없다. | 정리 누락과 끊어진 탭을 복구한다. 삭제보다 생명주기 정리 계약과 비용을 먼저 확인한다. 잠금 순서와 진행 중 exit 제외를 유지해야 한다. |
| 원격 인증·프레임·입력 상한 | [mast-remote](../../crates/mast-remote/src/lib.rs)와 [프레임 코덱](../../apps/mast/src/secure-remote/frames.ts)은 외부 요청을 제한한다. | 터미널 입력과 자원 소모를 제한하는 경계이므로 유지한다. |

[ADR-0030](../adr/0030-optional-runtime-cost.md)에 따라 리셋 트리거가 모두 꺼지면 supervisor worker와 프런트 활동 리스너를 만들지 않는다. 뷰어도 처음 표시할 때 로딩한다. 이미 없어진 초기화 비용을 새 절감 효과로 계산하지 않는다.

## 공통화하지 않을 부분과 다음 판단

스크롤 저장은 이미 [ScrollSettle](../../apps/mast/src/features/viewers/viewer-scroll.ts), 탭 준비는 `PreparedTab`, 글꼴 범위는 [clampFontSize](../../apps/mast/src/shared/font-size.ts)로 공통화돼 있다. 기존 기능을 먼저 재사용한다.

텍스트의 부분 읽기·가상 스크롤, Markdown의 전체 읽기·편집·mtime 폴링, 폴더의 목록 탐색은 서로 다른 책임이다. 공통 부모 뷰어나 범용 비동기 로더로 합치면 옵션과 예외 분기가 늘 수 있다. 터미널과 뷰어 글꼴도 xterm 적용, CSS 적용, 변경 전 스크롤 앵커 처리와 설정 초기화 규칙이 달라 전체 통합은 권하지 않는다.

권고 순서는 직접 오류 변환 간소화와 테스트 준비 코드 공통화, 프레임 예약·배너의 순수 코드 감소 확인, 휴면 기능 보존 결정 재검토다. 계측 제한과 watchdog 최적화는 별도로 검증한다. 큰 LOC 감소를 원한다면 내장 브라우저, Markdown 편집, 두 원격 접속 방식 같은 실제 기능 범위를 선택해야 한다. 현재 검토만으로 추상화가 수천 줄을 줄인다고 추정하지 않는다.

이 문서는 구현 계획이나 기존 ADR 변경의 승인이 아니다. 구현 범위가 정해지면 변경별 검증을 수행하고, 실제 변경 결과만 해당 ADR에 반영한다.
