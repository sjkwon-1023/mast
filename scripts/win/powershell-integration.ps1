# PowerShell 탭 셸 래퍼 본문의 정본. WSL 쪽 scripts/wsl/launch.sh 의 짝이다.
#
# host.rs 의 powershell_spawn_spec 이 이 파일을 include_str! 로 넣고, 앞에 세 값을 작은따옴표
# 리터럴로 붙여 `powershell.exe -NoLogo -NoExit -EncodedCommand` 로 실행한다.
#   $MastTab  탭 id (10진수, 없으면 빈 문자열)
#   $MastBin  <mast.exe 폴더>\bin
#   $MastCwd  복원할 작업 폴더 (드라이브 경로일 때만, 아니면 빈 문자열)
# 세 값은 데이터다. 이 본문에 끼워 넣지 않는다. PowerShell 5.1 문법만 쓴다 (pwsh 7 은 비개발자 PC 에 없다).

# 시작 표식 (ADR-0009). 이 스크립트가 돌았다는 유일한 증거라서 첫 동작이어야 한다.
$MastEsc = [string][char]27
$MastBel = [string][char]7
[Console]::Write("${MastEsc}]777;mast-started${MastBel}")

# 탭 제목은 시작할 때 한 번만 짧은 이름으로 정한다. 두지 않으면 conhost 가 powershell.exe 전체 경로를
# 제목으로 보낸다. 프롬프트마다 제목을 보내면 ADR-0011 결정 2에 어긋난다.
[Console]::Title = 'PowerShell'

$env:MAST = '1'
$env:COLORTERM = 'truecolor'
if ($MastTab) {
    $env:MAST_TAB = $MastTab
} else {
    Remove-Item Env:MAST_TAB -ErrorAction SilentlyContinue
}
$env:MAST_SHELL_PID = $PID
$env:Path = "$MastBin;$env:Path"

# 앱은 폴더 존재를 확인하지 않는다. 끊긴 네트워크 드라이브에서 앱 전체가 멈추지 않도록 여기서 확인한다.
if ($MastCwd -and (Test-Path -LiteralPath $MastCwd -PathType Container)) {
    Set-Location -LiteralPath $MastCwd
}

# 프롬프트마다 현재 위치를 OSC 7 로 보고한다 (ADR-0011). 파일 시스템이 아니면 보고하지 않는다.
# 경로는 `\` 를 `/` 로 바꾼 뒤 UTF-8 바이트 단위로 인코딩한다: `%` 와 ASCII 가 아닌 바이트만
# %XX 가 되고 나머지는 그대로다. 콘솔 코드 페이지로 쓰면 한글 사용자 이름이 깨지므로 ASCII 로 보낸다.
# OSC 는 프롬프트 문자열 밖에서 Console.Write 로 쓴다. PSReadLine 은 프롬프트 문자열의 폭을 세므로
# 이스케이프를 프롬프트에 넣으면 입력 커서 위치가 틀어진다.
if (-not $global:MastPromptWrapped) {
    $global:MastPromptBase = (Get-Item Function:\prompt -ErrorAction SilentlyContinue).ScriptBlock
    $global:MastPromptWrapped = $true
}

function global:prompt {
    $here = Get-Location
    if ($here.Provider.Name -eq 'FileSystem') {
        $encoded = New-Object System.Text.StringBuilder
        foreach ($byte in [Text.Encoding]::UTF8.GetBytes($here.ProviderPath.Replace('\', '/'))) {
            if ($byte -lt 0x80 -and $byte -ne 0x25) {
                [void]$encoded.Append([char]$byte)
            } else {
                [void]$encoded.AppendFormat('%{0:X2}', $byte)
            }
        }
        [Console]::Write("${MastEsc}]7;file://$($env:COMPUTERNAME)/$($encoded.ToString())${MastBel}")
    }
    if ($global:MastPromptBase) {
        & $global:MastPromptBase
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
    }
}

# `mast update` 만 지원한다. 설치 스크립트가 도는 동안만 MAST_WINDOWS_SHELL 을 정하고 끝나면 되돌린다.
function global:mast {
    if ($args.Count -eq 1 -and $args[0] -eq 'update') {
        $previous = $env:MAST_WINDOWS_SHELL
        $env:MAST_WINDOWS_SHELL = 'powershell'
        try {
            Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/sjkwon-1023/mast/main/scripts/win/install.ps1' | Invoke-Expression
        } finally {
            $env:MAST_WINDOWS_SHELL = $previous
        }
        return
    }
    Write-Error 'mast: only "mast update" is supported in PowerShell mode'
    $global:LASTEXITCODE = 1
}
