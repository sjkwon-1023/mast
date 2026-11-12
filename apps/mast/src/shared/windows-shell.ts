// Windows 셸 모드 (settings.json `windowsShell`) — 부팅 때 한 번 적용하는 모듈 상태.
//
// `"powershell"` 이면 탭은 PowerShell 로 열리고, WSL 전용 진입점(폴더 브라우저·Git 변경 뷰어
// 버튼과 단축키, 터미널 경로 클릭)은 만들지 않는다. 키가 없으면 WSL 모드라 화면은 지금과 같다.
// 백엔드가 `"powershell"` 일 때만 값을 보내므로 판정은 `=== "powershell"` 하나다.

let powershell = false;

export function applyWindowsShellSettings(settings: { windowsShell?: string | null }): void {
  powershell = settings.windowsShell === "powershell";
}

export function isPowerShellMode(): boolean {
  return powershell;
}
