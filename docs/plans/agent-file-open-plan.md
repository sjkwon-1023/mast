# 에이전트용 파일·diff 표시 계획

상태: 설계 방향만 합의했다. 구현은 시작하지 않았다. `CLAUDE.md` Backlog의 "Agent-facing file and diff presentation commands"(사용자 요청 2026-09-20) 항목을 구체화한 문서다.

## 목적

코딩 에이전트가 만들거나 고친 파일과 변경 내용을 mast 안의 기존 뷰어로 바로 보게 한다. 터미널 출력만으로 확인하던 것을 대신한다. 새 뷰어는 만들지 않고, 이미 있는 탭 종류를 여는 경로만 추가한다.

## 코드로 확인한 사실

- 뷰어 탭 종류는 이미 있다. `NewTab::{FolderBrowser, ChangesViewer, TextViewer, MarkdownViewer}`(`crates/mast-core/src/command.rs`, ADR-0008, ADR-0022)다.
- `Command::SplitPane { pane, direction, tab: Option<NewTab> }`는 split과 탭 생성을 원자적으로 처리한다(`crates/mast-core/src/command.rs`). CLI에서 split하며 열기는 새 dispatcher 명령 없이 가능하다.
- 참고할 선례는 `mast browser open`이다. 기존 OSC 요청·응답 경로를 쓰고, 호출한 터미널의 워크스페이스로 제한하며, `--pane`을 지원한다. `--pane`이 없으면 그 워크스페이스의 활성 pane에 탭을 만든다(`apps/mast/src-tauri/src/browser.rs`의 `open` 처리, `docs/BROWSER.md`).
- 경로 검증 규칙은 `mast-core::wslpath`에 있다(ADR-0008 결정 1).
- 터미널 링크는 현재 http(s)만 연다(`apps/mast/src/features/terminal/interaction.ts`의 `shouldOpenLink`). 파일 경로는 클릭할 수 없다.
- 지금 `mast` CLI 하위 명령은 `browser`, `ls`, `send`, `id`, `update`, `config`, `skill-load`다. 파일을 여는 명령은 없다.

## 설계 방향

세 부분으로 나눈다. 앞에서부터 구현하는 것을 권한다.

### 1. 터미널 파일 경로 Ctrl+클릭

에이전트가 출력한 파일 경로(`path`, `path:line`)를 Ctrl+클릭하면 아래 "뷰어 자리"에 연다. 에이전트 쪽 협조 없이 동작하므로 가장 자주 쓰일 경로다.

- 경로는 그 탭의 cwd(ADR-0011)를 기준으로 해석하고 `wslpath` 규칙으로 검증한다.
- 디렉터리는 `FolderBrowser`, `.md`는 `MarkdownViewer`, 그 밖의 파일은 `TextViewer`로 연다.
- 마우스 트래킹 모드와 macOS 수정자 규칙은 기존 `shouldOpenLink`와 같게 둔다.

### 2. `mast layout`

에이전트가 현재 워크스페이스의 pane 배치를 보고 어디에 띄울지 스스로 정하게 한다. mast는 조작만 제공하고, 배치 규칙은 번들 skill에 둔다.

- 출력: 호출한 워크스페이스의 pane 트리 JSON.
  - split 방향과 비율
  - pane별 크기(cols×rows)
  - 탭 목록(ID·종류·제목·경로 또는 URL), 활성 탭
  - `self`: 호출자 자신의 pane
  - `focused`: 사용자가 지금 포커스한 pane
- 크기는 필수다. 트리만으로는 split 후 pane이 너무 좁아지는지 판단할 수 없다.
- `mast ls`는 사람이 읽는 평면 탭 목록이므로 그대로 둔다.

### 3. `mast open <path>` / `mast diff [path]`

- `open`은 1과 같은 규칙으로 탭 종류를 고른다. `diff`는 `ChangesViewer`를 연다(git 레포 안의 경로만 받는다).
- `--pane <id>`: 해당 pane에 새 탭으로 연다.
- `--split <id> right|down`: 해당 pane을 나누고 연다(`SplitPane`).
- 옵션이 없으면 뷰어 자리 규칙을 따른다. 레이아웃을 조회하지 않는 에이전트도 무난하게 동작하게 하기 위해서다.
- 상대 경로는 CLI가 호출 위치 기준으로 `realpath`를 구해 절대 경로로 보낸다. 서버는 `wslpath` 규칙으로 다시 검증한다.

### 공통 규칙

- **뷰어 자리:** 호출할 때마다 split하면 pane이 계속 늘어난다. 워크스페이스당 뷰어 pane을 하나 정해 둔다. 처음에는 호출자 pane 옆에 split을 만들고, 이후에는 그 pane에 탭으로 추가한다. 이 pane을 모델에 표시할지, 휴리스틱(직전에 CLI가 만든 pane)으로 찾을지는 미정이다.
- **포커스 유지:** 에이전트나 CLI가 연 뷰어는 키보드 포커스를 가져가지 않는다. 사용자가 다른 pane에 입력하는 중일 수 있기 때문이다. 이 점에서 `mast browser open`과 동작이 다를 수 있으니 구현 때 확인한다.
- **워크스페이스 제한:** `mast browser`와 같이 호출한 워크스페이스의 pane만 대상으로 삼는다.
- **경로 범위:** 읽기 전용 뷰어이므로 워크스페이스 root 안으로 묶지 않는다(ADR-0008 결정 1과 같은 위협 모델).
- **낡은 조회 결과:** `layout` 조회와 실행 사이에 pane이 닫히면 dispatcher가 `UnknownTarget`으로 실패를 알린다. 에이전트는 다시 조회하면 된다.
- **비용:** 상주 서비스나 폴링을 추가하지 않는다. 모든 동작은 CLI 호출 또는 클릭 시점에만 일어난다.

## 미해결 질문

- 뷰어 자리 pane을 식별하는 방법(모델 필드 또는 휴리스틱)과 그 pane이 닫혔을 때의 동작
- 터미널 출력에서 경로를 인식하는 패턴의 범위(`path:line:col`, 공백이 들어간 경로, Windows 경로)
- `path:line`으로 열 때 TextViewer를 그 줄로 이동시킬지. 현재 뷰어는 512 KiB 창 단위로 읽는다(ADR-0008 결정 6).
- 번들 skill에 넣을 배치 규칙(최소 pane 폭, 기존 뷰어 pane 재사용 우선 등)

## 검증 방향

- `mast-core`: 경로 해석과 탭 종류 선택, 레이아웃 직렬화 단위 테스트
- 프런트: 링크 인식과 포커스 비이동 vitest
- CLI: `apps/mast/tests/browser-cli.test.ts`와 같은 방식의 CLI 테스트
- glue는 Linux에서 컴파일되지 않는다. `windows-gates`와 `docs/WINDOWS-BUILD.md` §10 수동 항목으로 확인한다.
