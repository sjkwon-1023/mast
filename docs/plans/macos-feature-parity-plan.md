# macOS 기능 격차 해소 계획

> **진행 중 (2026-09-24 시작).** PR #53(네이티브 Apple Silicon macOS 지원) 뒤 "Windows 전용"으로 막아 둔
> 기능을 macOS 에서도 동작하게 하는 작업의 설계문서다. 실행이 끝나면 결정은 각 기능의 ADR
> (0016·0022·0024·0026·0028) 개정 문단으로 증류하고 이 파일은 삭제한다(레포 `CLAUDE.md` Docs 규칙).

## 1. 목표와 범위

macOS 네이티브 빌드에서 다음 여섯 가지를 Windows 와 같은 계약으로 동작시킨다. Windows 동작은 바꾸지 않고,
새 npm/cargo 의존성은 들이지 않는다(Cargo.lock 패키지 불변).

| # | 기능 | 현재 macOS 상태 | 이식의 핵심 |
|---|---|---|---|
| 1 | Git 변경사항/diff 뷰어 (ADR-0022) | 코어·glue 는 이미 동작, 프론트가 placeholder 와 버튼 숨김으로 막음 | 프론트 `IS_MAC` 가드 두 곳 제거 |
| 2 | 업데이트 알림 (ADR-0024) | WinHTTP FFI 전용, macOS 는 호출 안 함 | `/usr/bin/curl` 로 같은 계약 구현 |
| 3 | Antigravity CLI(agy) 상태 hook (ADR-0026 결정 8) | macOS setup 이 claude/codex/opencode 만 연결 | 기존 병합 스크립트·hook 재사용, setup.py 에 단계 추가 |
| 4 | macOS 방화벽 판정·허용 | 비-Windows 는 "unsupported" 스텁 | `socketfilterfw` 기반 신규 구현 |
| 5 | Local HTTP 원격 (ADR-0016) | glue 가 macOS 에서 조기 Off, 프론트·CLI 도 차단 | 가드 해제(4번 선행) |
| 6 | Secure Remote (ADR-0028) | `secure_remote_start` 가 macOS 에서 조기 Err | 가드 해제(4번 선행) |

**범위 밖**: macOS 배포(번들·서명·공증·릴리스 워크플로). 사용자 결정(2026-09-24)으로 별도 작업이다.

## 2. 확정된 결정

- **C1 — Secure Remote 계약**: 현행 ADR-0028(2026-09-20 개정 포함) 계약을 그대로 따른다. PC 는 인증서·키·토큰을
  메모리에만 두고 앱 종료 시 폐기한다. 처음 QR 전에는 120초 대기, 인증 후에는 인증서 만료(최대 14일)까지
  재접속을 받는다. 동시 연결은 하나다. 휴대폰은 localStorage `mast.secure-remote.pairing.v1` 에 인증을 기억한다.
- **C2 — 업데이트 확인 timeout**: WinHTTP 의 "단계별 3초 + 본문 8초"에 가장 가까운 curl 인자로 옮긴다.
  `--connect-timeout 3`(DNS·TCP·TLS), `--speed-limit 1 --speed-time 3`(3초 무응답 중단), `--max-time 11`(전체 상한).
  환경 변수 proxy 는 쓰지 않는다(Finder 로 띄운 앱에는 원래 없다). 헤더 16 KiB·본문 64 KiB 상한은 그대로다.
- **C4 — agy 버전 게이트**: 1.1.10 미만이면 Windows 와 같이 경고만 남기고 설치는 계속한다.
- **방화벽(보안 처방 구간)**: macOS Application Firewall 은 포트가 아니라 **앱 단위**라 TCP(Local HTTP)와
  UDP(Secure Remote)가 같은 앱 규칙을 공유한다.
  - 판정은 권한 없이 `socketfilterfw --getglobalstate / --getblockall / --getappblocked <현재 실행 파일>` 만 읽는다.
    알려진 출력 형식만 인정하고 나머지는 "알 수 없음"으로 둔다.
  - 허용은 사용자가 버튼을 눌렀을 때만 `osascript … with administrator privileges` 로 `--add`·`--unblockapp` 을 실행한다.
    명령에는 `current_exe()` 경로 하나만 들어가고 셸·AppleScript 양쪽 인용을 정확히 한다. 결과는 종료 코드가 아니라
    재판정으로 확인한다.
  - 금지: 앱 시작 시 자동 권한 상승, 전역 방화벽 끄기(`--setglobalstate`), block-all 변경.
- **원격은 기본 꺼짐**: settings 에 `remote` 가 없으면 macOS 도 리스너·스레드·토큰 파일이 없다(ADR-0016 결정 1).

## 3. 구현 청크

구현은 Codex(gpt-6-luna max)가 청크 하나씩 하고, 오케스트레이터(Claude)가 청크마다 diff 를 확인해 커밋한다.

1. **Git changes 뷰 연결** — 프론트 가드 제거, macOS 경로가 원문 그대로 조회에 도달하는지 테스트.
2. **curl 기반 업데이트 조회** — `update.rs` 의 macOS 모듈, C2 인자, 상한·실패 로그 테스트, 온라인 프로브(`#[ignore]`).
3. **agy 네이티브 연결** — setup.py 단계(설치 판정·opt-out·버전 경고), ASSETS 추가, 실제 PTY 로 OSC 도달 테스트.
4. **macOS 방화벽과 페어링 UI** — `firewall` macOS 모듈(판정·허용), 페어링 대화상자의 상태 표시.
5. **Local HTTP·Secure Remote 활성화** — glue·프론트·`mast config` 의 macOS 가드 해제, 사이드바 버튼 표시.
6. **문서 정합성** — ADR 개정 문단, `docs/MACOS.md`·`docs/SETTINGS.md`·README 갱신.

의존 관계: 1·3·4 는 서로 독립이고, 5 는 4 뒤에 온다. 2 는 C2 결정이 끝나 바로 진행할 수 있다.

## 4. 검증

- **청크 게이트**: 각 청크의 계획 명령(해당 cargo·python·vitest 테스트).
- **최종 게이트** (각 명령을 레포 루트에서 따로 실행):
  `cargo test -p mast-core/-p mast-remote/-p mast-app --locked`, mast-core clippy(macOS·Linux 타깃),
  `cargo build -p mast-app` 경고 수 ≤ 시작 baseline, `scripts/macos/tests`, `apps/mast` 빌드·secure-remote 감사·vitest
  (실패 목록 ⊆ 시작 baseline), `apps/spike` 빌드·vitest, Cargo.lock 패키지 불변.
- **CI**: `gates`·`windows-gates` green. mast-app 의 Windows clippy 는 CI 에서만 확인할 수 있다.
- **리뷰**: 모든 청크가 끝나면 Codex(gpt-6-astra) + Fable 두 엔진으로 완료 리뷰 후 PR.
- **사용자 실기 확인(macOS)**: Changes 탭 열기·diff 보기, 업데이트 알림(온라인/오프라인),
  agy 상태 표시, 방화벽 켬/끔 상태 표시와 허용 버튼(관리자 암호 창), Local HTTP QR 페어링·입력,
  Secure Remote 페어링·재접속.
