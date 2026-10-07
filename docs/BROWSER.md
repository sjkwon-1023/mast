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

`mast browser eval`은 페이지의 로그인 세션으로 요청을 보내거나 `localStorage` 값을 읽을 수 있다. HttpOnly 쿠키는 JavaScript에서 읽을 수 없다. 페이지에 Mast IPC·셸·파일 권한이 없다는 사실은 로그인된 사이트에서 할 수 있는 동작까지 제한하지 않는다.

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

새 snapshot이나 문서 탐색 후 이전 `ref`는 `stale_ref`로 거부된다. 변경 후에는 다시 snapshot이나 screenshot으로 결과를 확인한다. `press`는 Enter, Tab, Escape, Backspace, 방향키를 지원한다. `wait`는 최대 10초이며, `--text`를 생략하면 문서 로딩 완료를 확인한다. 웹뷰가 아직 만들어지지 않았거나 페이지가 로딩 중이면 먼저 `wait`를 실행한다.

### 페이지 JavaScript 평가

`eval`은 최상위 문서에서 JavaScript 표현식 하나를 실행하고 Promise 결과를 기다린다. 여러 문장을 쓰려면 IIFE로 묶는다. 표현식 `-`는 표준 입력을 읽으며, 하이픈으로 시작하는 표현식은 `--` 뒤에 둔다.

```sh
mast browser eval '#42' 'document.title'
mast browser eval '#42' - <<'JS'
(() => {
  const links = document.querySelectorAll("a");
  return { title: document.title, links: links.length };
})()
JS
mast browser eval '#42' -- '-document.querySelectorAll("a").length'
```

`--timeout-ms`는 1–10,000ms이고 기본값은 5,000ms다. 성공은 `{"value": ...}`를 반환한다. 최상위 `undefined`는 `null`로 직렬화된다. 순환 참조와 `BigInt`처럼 JSON 직렬화할 수 없는 값은 `serialization_error`다. 성공 응답은 `{"value": ...}` 전체를 기준으로 1MiB까지이며, 오류 메시지는 UTF-8 기준 4KiB까지다. 요청 JSON은 32KiB까지다. 표현식의 실제 입력 상한은 JSON 이스케이프와 나머지 요청 필드 크기에 따라 달라진다. 응답 크기 제한은 페이지 코드가 실행 중 할당하는 메모리를 제한하지 않는다.

반환된 객체의 키 순서는 보존되지 않는다. 입력은 JavaScript 표현식이므로 끝에 세미콜론을 쓰면 구문 오류가 난다. `script_error`는 예외·구문 오류, `serialization_error`는 결과를 JSON으로 인코딩할 수 없거나 중첩이 128단계를 넘는 경우, `too_large`는 결과·캡처가 크기 상한을 넘은 경우다. `unauthorized`는 UI 경로에서 eval을 호출했거나 토큰이 없거나 형식이 잘못됐거나 일치하지 않는 경우, `disabled`는 브라우저 또는 eval 설정이 꺼진 경우다. `not_found`는 탭이 없거나 호출자 워크스페이스 밖에 있거나 페이지가 아직 준비되지 않은 경우, `invalid_params`는 인자 형식 오류, `not_supported`는 플랫폼이 요청한 동작을 지원하지 않는 경우, `timeout`은 요청 시간 상한 또는 탭의 미완료 eval 게이트, `browser_error`는 나머지 브라우저·네이티브 오류를 나타낸다.

`stale_ref`는 새 snapshot이나 문서 탐색으로 무효가 된 요소 참조를 뜻한다.

`eval`과 고정 크기 `screenshot --width`는 웹뷰를 새로 만들지 않는다. 페이지가 아직 없는 탭에서는 페이지 코드를 실행하지 않고 `Browser tab has no page yet; run mast browser wait or open it first`를 반환한다. 먼저 `mast browser wait`를 실행하거나 해당 탭을 연다.

실패도 CLI에서 JSON으로 출력하지만, 기존 CLI가 오류 JSON을 문자열로 한 번 더 감싸므로 이중 인코딩 형태다.

```json
{"error": "{\"code\": \"script_error\", \"message\": \"Error: boom\"}"}
```

시간 초과는 응답을 기다리는 상한이며 페이지 코드나 그 부작용을 취소하지 않는다. 늦은 완료 콜백이 오거나 문서가 교체될 때까지 해당 탭의 eval·snapshot·click·fill·press·scroll·wait·console·errors·screenshot은 실패한다. 완료를 기다리는 동안에는 숨긴 탭도 일시 중지하지 않아 타이머로 끝나는 Promise가 완료될 수 있으며, 완료되거나 문서가 바뀌면 다시 일시 중지한다. Promise가 영원히 pending이거나 동기 코드가 멈추면 `reload` 또는 `close`로 회복한다. macOS에서 동기 무한 루프가 `reload`로 풀리지 않으면 탭을 `close`한다.

CLI는 eval 요청마다 앱에서 토큰을 받아 요청에 넣는다. 회신 파일을 읽지 못하는 터미널 출력 주입(cat·ssh·빌드 로그)만으로는 eval 요청을 만들 수 없다. 이 보장은 같은 사용자의 로컬 프로세스, `/tmp`를 공유하거나 외부에 노출한 환경, 미리 심은 심볼릭 링크, 다른 셸에 입력을 넣는 기존 `mast send`에는 적용되지 않는다. 토큰은 비밀이 아니며 터미널 기록에 남을 수 있다. 회신 파일을 읽을 수 있다는 증명으로 사용한다.

Windows와 macOS 모두 사용자 동작이 있는 것으로 평가하므로 페이지의 팝업과 클립보드 쓰기가 가능하다. 팝업은 같은 pane의 브라우저 탭으로 열린다.

스크린샷은 현재 viewport의 PNG이며 최대 16메가픽셀이다. `--output`을 생략하면 `/tmp/mast-browser-*.png`(Windows는 WSL 안)에 저장하고 경로를 반환한다. 기존 파일을 덮어쓰지 않는다. 에이전트가 해당 경로를 읽어 확인한 뒤 필요 없는 캡처는 직접 삭제한다. 일반 요청은 32KiB, 응답은 24MiB로 제한한다. 앱 내부 상태 잠금이 비정상적으로 오래 유지되면 응답 시간 상한을 넘길 수 있지만, deadline이 지난 eval 요청은 페이지에서 실행되지 않는다. snapshot은 최대 400개 요소와 본문 40,000자, 콘솔·오류 버퍼는 각각 최근 100개 항목을 보관한다.

`screenshot TAB --width W [--height H]`는 캡처 순간 같은 페이지의 CSS viewport를 지정한다. W는 320–3840, H는 240–2160이며 H를 생략하면 `(W*10+8)/16`으로 16:10 높이를 정한다. 예를 들어 `--width 1280`은 1280×800 viewport다. 응답은 `{"path": ..., "bytes": ..., "width": W, "height": H}` 형태이며 `width`와 `height`는 CSS 픽셀이다. PNG의 물리 크기는 화면 배율(DPR)을 곱한 값이고 전체 이미지 상한은 16메가픽셀이다.

고정 크기 캡처 중 페이지는 `resize` 이벤트를 받는다. 사이트가 그 결과 DOM을 바꾸면 Mast가 DOM 상태까지 되돌리지는 않는다. 복원 뒤 최신 bounds에 맞춰 viewport를 판정한다. bounds 크기가 바뀌면 캡처 전 viewport에 적용 bounds와 캡처 전 bounds의 크기 비율을 곱해 반올림한 값에서 각각 2 CSS 픽셀 이내여야 하며, bounds 크기가 같으면 기존처럼 1 CSS 픽셀 이내여야 한다. 확인에 실패하면 `view was not restored`를 반환하고 다음 요청에서 복원을 다시 시도한다. Tauri의 표시·숨김 호출은 네이티브 작업을 전달했다는 것만 확인하므로, 실제 표시 상태를 별도로 검증할 수 없는 한계가 있다. 같은 문서가 유지된 경우에만 성능 타임 원점도 확인한 뒤 스크롤 위치를 되돌린다. 스크롤 복원은 크기 복원 예산 안에서 한 번만 시도하며, 시간이 남지 않으면 건너뛰고 실패하면 로그만 남기며, 어느 경우든 캡처 응답은 성공으로 돌아온다. 캡처를 시작하기 직전에 pane 크기가 바뀌면 요청은 실패하므로 다시 실행한다. Windows는 viewport 에뮬레이션을 사용하고 macOS는 웹뷰를 숨기지 않고 화면 밖으로 옮기므로 키보드 포커스는 페이지에 유지된다. 캡처 중 탐색되면 요청은 실패한다. Windows에서는 좁은 pane에 데스크톱 레이아웃 일부가 잠시 잘려 보일 수 있고, macOS에서는 pane이 잠시 비어 보일 수 있다.

복원 확인이 계속 실패해도 `reload`와 `navigate`는 진행하며, 복원 표지는 다음 JavaScript 명령에서 다시 확인한다. 최후 수단은 `close`다.

## 지원 범위

- 주소 입력과 탐색은 HTTP(S)만 허용한다. 자격 증명을 URL에 넣거나 `file:`, `javascript:` 등의 스킴을 사용하는 요청은 거부한다.
- 페이지 팝업은 같은 pane의 브라우저 탭으로 전환한다. 다운로드와 카메라·마이크 등 웹 권한 요청은 거부한다. 필요한 경우 주소창 옆 외부 브라우저 버튼을 사용한다. Windows는 권한 거부 이유를 상태에 표시한다. macOS는 앱에 카메라·마이크·위치 사용 설명(Info.plist)이 없어 WebKit이 시스템 단계에서 거부하며, 별도 상태 문구는 없다.
- 탐색 실패는 브라우저 상태와 `mast browser list`의 `error`에 표시한다. macOS의 WebKit은 9번 같은 제한 포트로의 탐색을 콜백 없이 막으므로, 이 경우에는 이전 페이지가 그대로 남고 오류가 표시되지 않는다.
- 페이지를 누르면 그 탭의 pane이 활성화되며, 키보드 포커스는 페이지에 남는다. 브라우저가 키보드 포커스를 가진 동안에도 Mast의 탭·pane·워크스페이스 단축키는 앱이 처리한다(macOS는 한글 등 비 ASCII 입력 소스에서도 물리 키 위치로 판정한다). 주소창 포커스는 Windows `Ctrl+L`, macOS `Cmd+L`이다. 복사·붙여넣기와 페이지 자체 단축키는 페이지에 남긴다.
- 웹페이지에는 Mast IPC·셸·파일 권한을 부여하지 않는다. 에이전트는 `mast browser eval`로 같은 탭의 JavaScript를 실행할 수 있다. 외부 CDP 연결, 서버, network interception 명령은 제공하지 않는다.
- snapshot과 요소 조작은 최상위 문서의 DOM을 대상으로 한다. iframe 내부·shadow DOM 요소 선택과 실제 사용자 입력이 필수인 사이트의 모든 동작을 보장하지 않는다.
- 모바일 remote에는 데스크톱 전용 탭으로 표시한다. 브라우저 화면 스트리밍은 제공하지 않으며 `remote` 설정과 브라우저 설정은 독립이다.
- Windows 실제 UI·IME·클립보드·프로필 격리와 자원 사용량 검증은 [Windows 검증 절차](WINDOWS-BUILD.md#브라우저와-wsl-안내-검증)를 따른다. 자동 테스트 결과가 실기 검증을 대신하지 않는다.
