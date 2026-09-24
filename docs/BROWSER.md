# 내장 브라우저와 WSL 시작 안내

브라우저는 pane 안의 탭으로 열리며 Windows에서는 WebView2, macOS에서는 WKWebView를 사용한다. 터미널 셸이나 별도 브라우저 데몬을 만들지 않는다. pane 헤더의 `◎` 버튼으로 열고 주소창에 HTTP(S) URL을 입력한다. 워크스페이스가 없는 첫 화면에서도 **New browser tab**으로 시작할 수 있다. 브라우저 자체는 WSL 없이 사용할 수 있다.

## WSL이 준비되지 않은 경우

앱은 터미널을 시작하기 전에 WSL 배포판 목록과 사용할 배포판의 Bash 실행을 확인한다. WSL 미설치, 배포판 없음, 지정한 배포판 없음, 실행 실패, 시간 초과를 구분해 안내한다. 실패한 탭의 저장 상태와 종료 기록은 유지한다.

안내에서 설치 명령을 복사하거나 [Microsoft 설치 안내](https://learn.microsoft.com/en-us/windows/wsl/install)를 열 수 있다. 관리자 PowerShell에서 설치하고, 재부팅을 요구하면 재부팅한 뒤 배포판을 실행해 Linux 사용자 이름과 비밀번호 설정을 끝낸다. **Recheck**로 다시 검사한다. Mast가 설치나 재부팅을 대신 실행하지는 않는다. `MAST_DISTRO` 또는 저장된 워크스페이스의 배포판 이름이 설치 목록과 다르면 해당 이름도 안내에 표시한다.

## 설정과 자원 수명

기본값은 `browser.enabled: true`다. 설정은 완전히 종료하고 다시 실행해야 적용된다. `Ctrl+Shift+R`은 설정을 바꾸지 않는다.

```sh
mast config set browser.enabled false
mast config get browser.enabled
mast config set browser.enabled true
mast config reset browser.enabled
```

CLI를 쓸 수 없으면 settings.json을 직접 편집한다. 위치는 Windows `%AppData%\app.mast.desktop\settings.json`, macOS `~/Library/Application Support/app.mast.desktop/settings.json`이다.

```json
{
  "browser": { "enabled": false }
}
```

OFF에서는 브라우저 웹뷰·작업 스레드·타이머·이벤트 구독·자동화 초기화를 생성하지 않는다. 기존 Mast UI와 정적 설정·저장 데이터는 남는다. 저장된 브라우저 URL과 배치는 비활성 안내로 복원하며, UI와 에이전트 요청 모두 기능을 다시 켤 수 없다.

ON이어도 페이지를 표시하거나 에이전트가 페이지 작업을 요청하기 전에는 웹뷰를 만들지 않는다. Windows에서는 숨긴 탭에 WebView2 휴면을 요청하고, 작업할 때 깨운다. 휴면은 런타임이 거부할 수 있으며 메모리 반환을 보장하지 않는다. macOS에는 같은 공개 API가 없어, 숨긴 WKWebView의 타이머·렌더링 억제를 WebKit에 맡긴다. 닫으면 웹뷰와 페이지 버퍼를 해제한다. 입력 내용 손실을 피하기 위해 숨긴 페이지를 자동 폐기하지 않는다.

쿠키와 웹 저장소는 워크스페이스별로 분리한다. Windows는 `%AppData%\app.mast.desktop\browser\workspace-<id>` 프로필을 쓰고, macOS 14 이상은 워크스페이스 ID로 정한 WebKit 영속 저장소를 쓴다. macOS 13 이하에는 영속 저장소 식별자가 없어 비영속 저장소로 격리하므로, 앱을 다시 실행하면 로그인 상태가 사라진다. 같은 워크스페이스의 탭은 로그인 상태를 공유한다. 탭을 닫아도 프로필은 보존된다. 앱 재시작 시 URL과 배치만 복원하며 페이지의 미저장 입력·탐색 기록까지 복원하지는 않는다.

브라우저 웹뷰가 있는 동안 메모리 임계치만을 근거로 한 Mast UI 자동 리셋을 억제한다. 전체 프로세스 트리 메모리 측정은 계속 유지한다. 모든 브라우저 웹뷰를 닫으면 기존 메모리 리셋 정책이 다시 적용된다.

## 에이전트가 같은 탭 확인하기

Mast 안의 터미널(Windows는 WSL, macOS는 네이티브 셸)에서 `mast browser`를 사용한다. 기존 OSC 요청·응답 경로를 이용하며 별도 포트나 MCP 서버를 열지 않는다. 호출한 터미널과 같은 워크스페이스의 탭만 제어한다. 결과는 JSON이며 실패 시 종료 코드는 1이다.

```sh
mast browser open http://localhost:3000
mast browser list
mast browser wait '#42' --text '로그인' --timeout-ms 5000
mast browser snapshot '#42'
```

`open` 결과의 `tab` 값을 사용한다. `snapshot`은 화면 텍스트와 요소의 `ref`를 반환한다. 다음 명령의 `REF`를 해당 응답의 참조로 바꾼다.

```sh
mast browser fill '#42' REF '입력할 내용'
mast browser click '#42' REF
mast browser press '#42' REF Enter
mast browser scroll '#42' 500
mast browser screenshot '#42' --output /tmp/mast-page.png
mast browser console '#42'
mast browser errors '#42'
mast browser navigate '#42' http://localhost:3000/result
mast browser back '#42'
mast browser forward '#42'
mast browser reload '#42'
mast browser stop '#42'
mast browser close '#42'
```

새 snapshot이나 문서 탐색 후 이전 `ref`는 `stale_ref`로 거부된다. 변경 후에는 다시 snapshot이나 screenshot으로 결과를 확인한다. `press`는 Enter, Tab, Escape, Backspace, 방향키를 지원한다. `wait`는 최대 10초이며, `--text`를 생략하면 문서 로딩 완료를 확인한다. 탐색 직후 문서가 교체되는 동안 요청이 실패하면 로딩 후 다시 호출한다.

스크린샷은 현재 viewport의 PNG이며 최대 16메가픽셀이다. `--output`을 생략하면 `/tmp/mast-browser-*.png`(Windows는 WSL 안)에 저장하고 경로를 반환한다. 기존 파일을 덮어쓰지 않는다. 에이전트가 해당 경로를 읽어 확인한 뒤 필요 없는 캡처는 직접 삭제한다. 요청은 32 KiB, 응답은 24 MiB로 제한한다. snapshot은 최대 400개 요소와 본문 40,000자, 콘솔·오류 버퍼는 각각 최근 100개 항목을 보관한다.

## 지원 범위

- 주소 입력과 탐색은 HTTP(S)만 허용한다. 자격 증명을 URL에 넣거나 `file:`, `javascript:` 등의 스킴을 사용하는 요청은 거부한다.
- 페이지 팝업은 같은 pane의 브라우저 탭으로 전환한다. 다운로드와 카메라·마이크 등 웹 권한 요청은 거부한다. 필요한 경우 주소창 옆 외부 브라우저 버튼을 사용한다. Windows는 권한 거부 이유를 상태에 표시한다. macOS는 앱에 카메라·마이크·위치 사용 설명(Info.plist)이 없어 WebKit이 시스템 단계에서 거부하며, 별도 상태 문구는 없다.
- 탐색 실패는 브라우저 상태와 `mast browser list`의 `error`에 표시한다. macOS의 WebKit은 9번 같은 제한 포트로의 탐색을 콜백 없이 막으므로, 이 경우에는 이전 페이지가 그대로 남고 오류가 표시되지 않는다.
- 페이지를 누르면 그 탭의 pane이 활성화되며, 키보드 포커스는 페이지에 남는다. 브라우저가 키보드 포커스를 가진 동안에도 Mast의 탭·pane·워크스페이스 단축키는 앱이 처리한다(macOS는 한글 등 비 ASCII 입력 소스에서도 물리 키 위치로 판정한다). 주소창 포커스는 Windows `Ctrl+L`, macOS `Cmd+L`이다. 복사·붙여넣기와 페이지 자체 단축키는 페이지에 남긴다.
- 웹페이지에는 Mast IPC·셸·파일 권한을 부여하지 않는다. 임의 JavaScript 실행이나 외부 CDP 연결 명령은 제공하지 않는다.
- snapshot과 요소 조작은 최상위 문서의 DOM을 대상으로 한다. iframe 내부·shadow DOM 요소 선택과 실제 사용자 입력이 필수인 사이트의 모든 동작을 보장하지 않는다.
- 모바일 remote에는 데스크톱 전용 탭으로 표시한다. 브라우저 화면 스트리밍은 제공하지 않으며 `remote` 설정과 브라우저 설정은 독립이다.
- Windows 실제 UI·IME·클립보드·프로필 격리와 자원 사용량 검증은 [Windows 검증 절차](WINDOWS-BUILD.md#브라우저와-wsl-안내-검증)를 따른다. 자동 테스트 결과가 실기 검증을 대신하지 않는다.
