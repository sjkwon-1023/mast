# WSL 안내와 내장 브라우저 구현 계획

- 버전: 2 / 날짜: 2026-09-23
- 승인: 최초 #44 OpenCode 위임 후 사용자가 “그냥 너가 이어서 작업해줘”로 메인의 직접 구현을 승인. 청크 01 결과의 F1~F5를 메인이 수정하고 청크 02~04를 직접 진행한다.
- 플랜 리뷰와 최종 병렬 리뷰는 사용자 요청으로 생략. 메인 청크 인수·통합 게이트는 유지.
- 기준: b8d7096790851fd574796e9ceb52d2ecda3e9879, feat/wsl-browser.

## 요구사항과 확정 방향

R1. WSL 미설치·배포판 없음·선택 배포판 없음·실행 실패/시간 초과를 앱에서 안내한다. 단순 wsl.exe 파일 존재를 준비 완료로 취급하지 않는다. 설치 명령 복사, 공식 안내 열기, 재검사, Windows 설정 파일 열기를 제공한다. 설치·재부팅을 자동 수행하지 않는다. 진단 실패는 원문 세부 정보와 분류를 함께 제공한다.
R2. Windows 시작 시 UI를 차단하지 않고 첫 스폰·복원·프로비저닝 전에 진단한다. 진단은 공유·캐시하고 명시적 재검사로 갱신한다. 정상 탭 생성마다 WSL 프로세스를 추가 실행하지 않는다. 배포판별 실패는 다른 정상 배포판을 막지 않는다. 저장 탭·기록을 보존하고 실패 자동 반복을 막는다. Unix 개발 실행 경로는 유지한다.
R3. 브라우저는 기존 pane에 들어가는 새 탭 종류다. WSL 없이도 앱과 브라우저는 작동한다. 주소창, 뒤/앞, 새로고침/중지, URL/제목/로딩/오류 표시, 탭 닫기·분할·전환·크기 변경을 지원한다. 터미널 PTY를 생성하지 않는다. URL과 배치를 저장하되 복원 시 페이지를 모두 로드하지 않는다.
R4. browser.enabled 기본값은 true다. false는 추가 웹뷰, 브라우저 작업 스레드·타이머·리스너·자동화 엔진을 만들지 않는다. ON이지만 미사용일 때도 미리 초기화하지 않는다. 기존 Mast UI 웹뷰와 정적 설정 데이터는 제외한 추가 실행 비용 기준이다. 설정은 기존 정책처럼 완전 재시작 후 적용하며 CLI와 JSON 편집을 지원한다. OFF 복원은 URL/배치를 보존한 비활성 표시이고 자동 로드하지 않는다. UI 및 백엔드 모두 생성·자동화 요청을 거부한다.
R5. 기존 WebView2 런타임의 네이티브 자식 웹뷰를 우선 사용하고 별도 Chromium/Node 브라우저 데몬을 상주시킬 수 없다. 보이지 않는 탭은 숨김·휴면, 닫을 때 웹뷰·구독·버퍼를 해제한다. 초기 버전은 사용자 입력 손실을 만드는 자동 페이지 폐기를 하지 않는다. 자동화 작업 동안 휴면을 제어하며 중복 생성·닫힘 경합을 처리한다. 워크스페이스별 프로필로 쿠키를 격리한다. 외부 웹페이지에 Mast IPC·셸·파일 권한을 부여하지 않는다. 앱 UI 디버깅 엔드포인트를 외부에 노출하지 않는다.
R6. 에이전트는 사용자가 보는 동일 탭을 안정 TabId로 제어한다. mast browser 명령 그룹으로 open/list/navigate/back/forward/reload/close, snapshot/screenshot, click/fill/press/scroll/wait, console/errors를 지원한다. JSON 결과와 명확한 disabled/not_found/timeout/stale_ref/not_supported 오류를 제공한다. snapshot 참조는 탐색 후 무효화한다. 화면 캡처는 WSL 에이전트가 읽을 수 있는 파일 경로로 반환하며 크기/로그 버퍼 상한을 둔다. 자동화 호출을 통한 암묵적 기능 활성화는 금지한다. 임의 JS eval·네트워크 가로채기·외부 CDP 연결·MCP 서버는 이번 범위 밖이다.
R7. WSL localhost 개발 서버 접근, 포커스·한국어 IME·클립보드·DPI/분할 크기, 팝업/다운로드/외부 스킴/웹 권한 처리 정책을 검증한다. 기본 HTTP(S) 탐색만 허용하고 위험한 스킴은 거부한다. 팝업은 제어된 브라우저 탭 생성으로 처리, 다운로드와 카메라/마이크 등 미지원 기능은 명시적으로 거부·안내한다. 외부 브라우저 열기는 명시적 사용자 동작이다. 인증서 오류는 자동 무시하지 않는다.
R8. 메모리 감시와 UI 리셋이 브라우저 페이지 비용을 터미널 누수로 오판하지 않도록 통합한다. 전체 프로세스 사용량 계측은 유지하고 브라우저가 있는 동안의 리셋 정책을 근거와 함께 정의한다. remote/모바일은 새 탭을 인식하고 지원하지 않는 표시를 제공하되 웹뷰를 원격 스트리밍하지 않는다. 브라우저 기능은 기존 remote.enabled와 독립이다.

## 근거와 구현 전 확인

현재 host.rs는 Windows에서 wsl.exe를 직접 실행한다. main.rs의 최초 CreateWorkspace 실패는 panic이고 boot.rs 복원·provision.rs 프로비저닝도 별도 실행된다. 모두 동일 준비 상태를 사용해야 한다. UiSettings는 commands.rs에 있고 설정 CLI는 scripts/wsl/mast-config.py다. TabKind는 Rust 모델과 shared/types.ts에 함께 반영해야 한다. reset_supervisor.rs는 WebView2 자손 전체 메모리를 합산한다.

- cmux: https://github.com/manaflow-ai/cmux/blob/main/docs/agent-browser-port-spec.md — 안정 ID와 snapshot/act/verify 계약 참고.
- Herdr: https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/plugins.mdx — 선택적 실행 경계 참고.
- 별도 플러그인: https://github.com/StructuPath/herdr-browser — 동일 세션과 종료 소유권 참고. 화면 스트리밍 구조를 그대로 도입하지 않는다.
- WebView2 CDP: https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.calldevtoolsprotocolmethodasync
- WSL: https://learn.microsoft.com/en-us/windows/wsl/install
- Tauri: https://v2.tauri.app/security/capabilities/

네이티브 자식 웹뷰·워크스페이스 프로필·휴면·CDP의 실제 Tauri/Rust 바인딩 지원을 청크 02 시작 시 확인한다. 계약을 충족할 수 없으면 임시 iframe·별도 헤드리스 브라우저로 대체하지 말고 근거를 보고한다.

## 청크와 소유 범위

### 01 — WSL 준비 상태와 안내 (R1/R2, R3의 WSL 독립 시작 전제)
선행 없음. worker 소유: apps/mast/src-tauri/src/{main,boot,host,provision,commands,state}.rs 및 WSL 진단 모듈, crates/mast-core/src의 테스트 가능한 진단/상태 로직, apps/mast/src의 시작 안내·백엔드 계약·테스트. 기존 상태/기록을 보존하고 시작 시 panic을 제거하며 첫 정상 시작/재검사 이후 터미널을 중복 생성하지 않는다. 브라우저 코드는 아직 구현하지 않는다.
검증: cargo test -p mast-core; npm --prefix apps/mast test; npm --prefix apps/mast run build; cargo check -p mast-app --target x86_64-pc-windows-msvc. WSL 없음/배포판 없음/배포판 일부 실패/시간 초과/UTF-16LE/재검사/중복 요청/기존 기록 보존을 의미 있는 테스트로 검증한다.

### 02 — 브라우저 탭·설정·수명 (R3/R4/R5/R7/R8)
선행 01 메인 인수. worker 소유: Rust TabKind/Command/persistence/fixtures, shared/types 및 workspace/viewers/navigation/remote 표시, 네이티브 브라우저 호스트, settings/CLI, capabilities, reset supervisor, 관련 테스트. 먼저 실제 Windows 타깃 컴파일로 네이티브 통합 가능성을 확인한다. 설정 OFF는 백엔드까지 일관되게 차단하며 탭 ID와 저장 상태 호환성을 유지한다. 네이티브 웹뷰가 모달·주소창을 가리거나 pane 밖에 표시되지 않도록 위치·z-order·가시성을 동기화한다.
검증: 두 Rust crate 테스트, 프론트 build/test, config-cli 테스트, x64/ARM64 check/clippy. 네이티브 수명과 IPC 격리·프로필 격리는 Windows 실기 증거가 별도로 필요하다.

### 03 — 에이전트 브라우저 CLI와 동일 세션 제어 (R6)
선행 02 메인 인수. worker 소유: scripts/wsl CLI·프로비저닝 배포, OSC 요청/응답 또는 기존 전송 경로 확장, Rust 브라우저 자동화 어댑터·테스트, 사용 문서. 기존 CLI 전송 방식을 우선 검토하고, 장기 요청 응답·스크린샷 파일의 접근성과 정리를 명시한다. 웹 콘텐츠를 명령 전송 권한으로 신뢰하지 않는다. 자동화 버퍼는 요청 시 만들고 상한을 둔다. 전체 캡처/네트워크 녹화는 추가하지 않는다.
검증: CLI 계약 테스트, 로컬 정적 테스트 페이지에서 open → snapshot → fill/click → wait → screenshot → console/errors → close 흐름. 비활성 기능·탭 닫힘·stale 참조·시간 초과 음성 케이스. 캡처 파일을 WSL에서 실제 읽기.

### 04 — 통합 회귀·Windows 계측·완료 문서
선행 03 메인 인수. worker 소유: 필요한 통합 테스트·계측 스크립트·docs/SETTINGS.md·docs/WINDOWS-BUILD.md·한국어 ADR. 범위 내 원인이 확인된 결함만 수정한다. 승인된 계획의 최종 계약을 ADR로 옮기고 완료 후 계획 파일을 삭제한다. 완료 전 삭제하지 않는다.
최종 필수 게이트: cargo test -p mast-core; cargo test -p mast-remote; cargo clippy --workspace --all-targets --target x86_64-pc-windows-msvc -- -D warnings; 같은 ARM64 clippy; cargo check --workspace --target x86_64-pc-windows-msvc; apps/mast와 apps/spike 각각 npm ci, npm run build, npm test. 의도한 의존성 변경 후 lockfile 정합성을 확인한다.
Windows 네이티브 빌드: apps/mast에서 npm run tauri build -- --no-bundle. 실기: WSL 미설치 VM(호스트 WSL 제거 금지), 정상 WSL, 배포판 오류, 브라우저 OFF/ON 미사용/1개/여러 개/휴면/모두 닫기에서 프로세스·CPU·메모리·종료 누수 기록. 기존 단일 웹뷰 기준과 같은 프로세스 트리 지표 사용. 자동화 중 사용자 탭 전환·닫기·복원·UI 리셋·로그인 격리 확인. 수치를 만들거나 모의 테스트를 실기 통과로 표시하지 않는다.

## 인수와 진행 규칙

메인이 매 청크의 코드·diff·게이트 로그를 직접 확인한 뒤 다음 청크를 지시한다. worker는 다른 작업자가 있음을 전제하고 기존 변경을 되돌리지 않으며 커밋/push/PR·재위임을 하지 않는다. 원인별 내부 수정 3회 실패, 환경 장애, 계약 변경 필요 시 증거와 함께 blocked 보고. Windows 검증을 실행할 환경이 없으면 미검증으로 남기고 완료·커밋하지 않는다. 사용자 승인으로 플랜 리뷰·최종 병렬 리뷰는 생략하지만 통합 검증은 생략하지 않는다. 성공 후 메인이 기능 worktree에서 커밋/push/PR을 진행한다. CI 등 장시간 작업은 완료 알림으로 재개한다.

## 직접 구현 현황 (2026-09-23)

- 청크 01: 배포판 목록뿐 아니라 실제 사용할 Bash의 실행을 검사한다. 실패한 배포판과
  MAST_DISTRO 누락을 안내하고 재검사 완료 후 대기 중인 부팅 작업을 재개한다.
  공유 검사 호출자의 대기 상한과 settings.json 최초 생성 경쟁을 수정했다.
- 청크 02: Tauri native child WebView2, 워크스페이스별 프로필, HTTP(S) 탐색,
  OFF 복원과 백엔드 차단, 숨김/휴면/닫기, IPC 권한 분리를 구현했다.
  웹뷰가 존재할 때만 메모리 임계치에 의한 UI 자동 리셋을 억제하며 원래 계측값은 유지한다.
- 청크 03: 기존 OSC 요청 경로에 mast browser를 연결했다. 별도 포트/데몬 없이 같은
  워크스페이스의 안정 TabId를 제어하고 WSL 파일로 캡처를 반환한다.
  snapshot/입력/클릭/이전 참조 거부/로그 상한은 DOM 테스트로 확인했다.
- 청크 04: core 480개, remote 80개, Mast 프론트 1,130개, spike 24개 테스트와
  프론트 빌드, Windows x64 check 및 x64/ARM64 clippy가 통과했다.
  추가한 프론트 수명 경합 회귀 테스트와 관련 브라우저 5개 테스트도 통과했다.
  Windows 네이티브 workspace 테스트와 릴리스 컴파일도 통과했다. 최종 웹 자산을
  내장하는 custom-protocol 실행 파일 빌드는 별도 진행하며 실기 검증은 미완료다.
- Windows의 모달/IME/DPI/localhost/동일 페이지 CLI 흐름, WSL 미설치 VM,
  프로세스 트리 CPU·메모리 수치는 아직 미검증이다. 이를 완료로 표시하지 않는다.
  상세 절차는 docs/WINDOWS-BUILD.md, 공개 사용 계약은 docs/BROWSER.md에 기록한다.
- 초기 스냅샷/조작은 최상위 DOM만 다룬다. 다운로드·웹 권한·임의 eval·외부 CDP·MCP는
  지원하지 않는다. UI 실기 통과 전 ADR 확정·계획 삭제·커밋/push/PR을 진행하지 않는다.
