# PowerShell 탭 셸 래퍼 본문의 정본. WSL 쪽 scripts/wsl/launch.sh 의 짝이다.
#
# host.rs 의 powershell_spawn_spec 이 이 파일을 include_str! 로 넣고, 앞에 네 값을 작은따옴표
# 리터럴로 붙여 `powershell.exe -NoLogo -NoExit -EncodedCommand` 로 실행한다.
#   $MastTab         탭 id (10진수, 없으면 빈 문자열)
#   $MastBin         <mast.exe 폴더>\bin
#   $MastCwd         복원할 작업 폴더 (드라이브 경로일 때만, 아니면 빈 문자열)
#   $MastAutoResume  settings.json 의 autoResume 이 true 면 '1', 아니면 빈 문자열
# 네 값은 데이터다. 이 본문에 끼워 넣지 않는다. PowerShell 5.1 문법만 쓴다 (pwsh 7 은 비개발자 PC 에 없다).

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

# 현재 위치를 OSC 7 로 보고한다 (ADR-0011). 파일 시스템이 아니면 보고하지 않는다.
# 경로는 `\` 를 `/` 로 바꾼 뒤 UTF-8 바이트 단위로 인코딩한다: `%` 와 ASCII 가 아닌 바이트만
# %XX 가 되고 나머지는 그대로다. 콘솔 코드 페이지로 쓰면 한글 사용자 이름이 깨지므로 ASCII 로 보낸다.
# OSC 는 프롬프트 문자열 밖에서 Console.Write 로 쓴다. PSReadLine 은 프롬프트 문자열의 폭을 세므로
# 이스케이프를 프롬프트에 넣으면 입력 커서 위치가 틀어진다.
function global:MastReportCwd {
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
}

function global:MastNotice([string]$Message) {
    [Console]::Write("${MastEsc}[2m[mast] $Message${MastEsc}[0m`r`n")
}

# 탭별 상태 파일은 agy 훅(crates/mast-agy-hook)과 같은 %USERPROFILE%\.mast 아래에 둔다. WSL 의 ~/.mast 와
# 같은 배치다: prompt\tab-<id> 는 프롬프트 세대, resume\tab-<id> 는 agy 훅이 쓰는 resume 힌트다.
$MastStateDir = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.mast' } else { '' }
$MastPromptNonce = '{0}-{1}' -f $PID, [DateTime]::UtcNow.Ticks
$MastPromptCount = 0

# 프롬프트 세대 `<nonce>-<counter>` 를 기록하고 MAST_PROMPT_GEN 으로 내보낸다. agy 훅이 이 값을 힌트 3행에
# 복사하고, 다음 부팅은 3행이 이 파일의 마지막 세대와 같을 때만(종료 때 agy 가 실행 중이었을 때만) 자동 실행한다.
# WSL 의 _mast_prompt_generation 과 같은 규칙이다. 기록이 실패하면 옛 세대가 남아 다음 부팅의 후보가 되므로
# 파일을 지우고 셸당 한 번 알린다. 기록했으면 $true 다.
function global:MastRecordGeneration {
    if (-not $MastTab -or -not $MastStateDir) { return $false }
    $global:MastPromptCount += 1
    $generation = '{0}-{1}' -f $MastPromptNonce, $MastPromptCount
    $file = Join-Path $MastStateDir "prompt\tab-$MastTab"
    try {
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $file))
        [IO.File]::WriteAllText($file, "$generation`n")
        $env:MAST_PROMPT_GEN = $generation
        return $true
    } catch {
        Remove-Item Env:MAST_PROMPT_GEN -ErrorAction SilentlyContinue
        try { [IO.File]::Delete($file) } catch { }
        if (-not $global:MastPromptWarned) {
            $global:MastPromptWarned = $true
            MastNotice "auto-resume unavailable: cannot write $file"
        }
        return $false
    }
}

if (-not $global:MastPromptWrapped) {
    $global:MastPromptBase = (Get-Item Function:\prompt -ErrorAction SilentlyContinue).ScriptBlock
    $global:MastPromptWrapped = $true
}

function global:prompt {
    [void](MastRecordGeneration)
    MastReportCwd
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

# 일반 파일만 상한 안에서 읽는다. 재분석 지점(심볼릭 링크 등), 폴더, 빈 파일, 상한 초과, 줄바꿈으로 끝나지
# 않는 내용은 모두 $null 이다. 훅이 이름을 바꿔 교체하는 중에도 열 수 있게 공유 모드에 Delete 를 준다.
function global:MastReadBounded([string]$Path, [int]$Limit) {
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
        $buffer = New-Object byte[] ($Limit + 1)
        $count = 0
        $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
        try {
            while ($count -lt $buffer.Length) {
                $read = $stream.Read($buffer, $count, $buffer.Length - $count)
                if ($read -le 0) { break }
                $count += $read
            }
        } finally {
            $stream.Dispose()
        }
        if ($count -eq 0 -or $count -gt $Limit -or $buffer[$count - 1] -ne 10) { return $null }
        return [Text.Encoding]::ASCII.GetString($buffer, 0, $count - 1)
    } catch {
        return $null
    }
}

# 자동 실행 대기열. WSL 의 mast-auto-resume.py 와 같은 규칙으로 탭들이 한꺼번에 깨어나도 하나씩 내보낸다:
# %USERPROFILE%\.mast\auto-resume.lock 을 공유 없이 열어 잠그고, 직전 허가에서 3초가 지나야 허가하며, 120초를
# 넘기면 건너뛴다. 잠금은 허가를 내는 동안만 쥔다. 직전 허가 시각은 QueryPerformanceCounter 값(Stopwatch)이다.
# 이 시계는 프로세스 사이에서 같고 재부팅하면 리셋되므로, 현재보다 미래인 값은 "직전 허가 없음"으로 본다.
# Windows 에는 load average 가 없어 부하 대기는 하지 않는다. 허가면 $true, 건너뛰면 사유를 알리고 $false 다.
function global:MastAutoResumeAdmit([string]$Display) {
    $lockPath = Join-Path $MastStateDir 'auto-resume.lock'
    $limit = 120.0
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $queued = $false
    $stream = $null
    try {
        [void][IO.Directory]::CreateDirectory($MastStateDir)
        while ($null -eq $stream) {
            try {
                $stream = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
            } catch {
                $cause = $_.Exception
                while ($cause -is [Management.Automation.MethodInvocationException] -and $cause.InnerException) {
                    $cause = $cause.InnerException
                }
                # 32 는 공유 위반, 33 은 잠금 위반이다. 다른 탭이 잠근 경우만 기다린다.
                if (-not ($cause -is [IO.IOException] -and (($cause.HResult -band 0xFFFF) -in 32, 33))) {
                    MastNotice "auto-resume skipped: queue state unavailable: $($cause.Message)"
                    return $false
                }
                if ($clock.Elapsed.TotalSeconds + 0.1 -gt $limit) {
                    MastNotice 'auto-resume skipped: timed out'
                    return $false
                }
                if (-not $queued) {
                    $queued = $true
                    MastNotice "auto-resume queued: $Display (Ctrl+C to cancel)"
                }
                Start-Sleep -Milliseconds 100
            }
        }

        $buffer = New-Object byte[] 64
        $count = $stream.Read($buffer, 0, $buffer.Length)
        [long]$last = 0
        $now = [Diagnostics.Stopwatch]::GetTimestamp()
        if ([long]::TryParse([Text.Encoding]::ASCII.GetString($buffer, 0, $count), [ref]$last) -and
            $last -gt 0 -and $last -le $now) {
            $gap = 3.0 - ($now - $last) / [double][Diagnostics.Stopwatch]::Frequency
            if ($gap -gt 0) {
                if ($clock.Elapsed.TotalSeconds + $gap -gt $limit) {
                    MastNotice 'auto-resume skipped: timed out'
                    return $false
                }
                if (-not $queued) {
                    $queued = $true
                    MastNotice "auto-resume queued: $Display (Ctrl+C to cancel)"
                }
                Start-Sleep -Milliseconds ([int][Math]::Ceiling($gap * 1000))
            }
        }
        $stamp = [Text.Encoding]::ASCII.GetBytes([Diagnostics.Stopwatch]::GetTimestamp().ToString())
        $stream.SetLength(0)
        $stream.Write($stamp, 0, $stamp.Length)
        $stream.Flush()
        return $true
    } catch {
        MastNotice "auto-resume skipped: queue state unavailable: $($_.Exception.Message)"
        return $false
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

# 재시작한 탭의 resume 힌트 (ADR-0037 개정 2026-11-17). WSL 첫 프롬프트의 판정과 같은 규칙이다.
# 허용하는 명령은 agy 훅이 쓰는 `agy --conversation <token>` 하나이고, token 은 [A-Za-z0-9_-] 96자 이하다.
# autoResume 이 켜져 있고 힌트 3행이 이전 셸의 마지막 세대와 같으면(종료 때 agy 가 실행 중이었으면) 한 번
# 자동 실행한다. 그 밖에는 명령을 안내만 한다. 저장된 명령을 실행 문자열로 해석하지 않고, PATH 의 agy 실행
# 파일을 고정 인자로 부른다. 이 블록은 스크립트의 마지막이어야 한다: 대기 중 Ctrl+C 는 스크립트의 나머지를
# 멈추므로, 프롬프트와 mast 함수는 그 전에 정의돼 있어야 한다.
function global:MastResumeAtStart {
    if (-not $MastTab -or -not $MastStateDir) { return }
    $previous = MastReadBounded (Join-Path $MastStateDir "prompt\tab-$MastTab") 256
    $hintPath = Join-Path $MastStateDir "resume\tab-$MastTab"
    $hint = MastReadBounded $hintPath 1024
    if ($null -eq $hint) { return }
    $lines = $hint.Split("`n")
    if ($lines[0] -cnotmatch '\Aagy --conversation ([A-Za-z0-9_-]{1,96})\z') { return }
    $command = $lines[0]
    $token = $Matches[1]

    $candidate = $MastAutoResume -eq '1' -and $lines.Count -eq 3 -and
        $lines[1] -cmatch '\A[0-9]{1,20}\z' -and
        $lines[2] -cmatch '\A[A-Za-z0-9_-]{1,128}\z' -and $lines[2] -ceq $previous
    # 세대를 기록하지 못하면 실행하지 않는다. 기록되지 않은 세대로 끝난 agy 가 다음 부팅에 다시 실행되기 때문이다.
    if (-not $candidate -or -not (MastRecordGeneration)) {
        MastNotice "resume previous agent: $command"
        return
    }
    $agy = Get-Command agy -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $agy) {
        MastNotice 'auto-resume skipped: agy is not on PATH'
        MastNotice "resume previous agent: $command"
        return
    }

    MastNotice "auto-resume: $command"
    $outcome = 'cancelled'
    try {
        $outcome = if (MastAutoResumeAdmit $command) { 'admitted' } else { 'skipped' }
    } finally {
        if ($outcome -eq 'cancelled') { MastNotice 'auto-resume cancelled' }
        if ($outcome -ne 'admitted') { MastNotice "resume previous agent: $command" }
    }
    if ($outcome -ne 'admitted') { return }

    # 재개한 agy 는 사용자가 입력하기 전까지 힌트를 다시 쓰지 않는다. 3행을 이번 세대로 바꿔 두어야, 입력 없이
    # 실행 중인 채로 끝난 세션이 다음 부팅에서도 후보가 된다. 실패해도 원치 않는 실행은 생기지 않으므로 알리고 진행한다.
    $temp = "$hintPath.tmp.$PID"
    try {
        [IO.File]::WriteAllText($temp, "$command`n$($lines[1])`n$($env:MAST_PROMPT_GEN)`n")
        [IO.File]::Replace($temp, $hintPath, [NullString]::Value)
    } catch {
        try { [IO.File]::Delete($temp) } catch { }
        MastNotice "auto-resume: cannot update $hintPath; the next boot resumes this session only if it writes a new hint"
    }
    MastReportCwd
    & $agy.Path --conversation $token
}

MastResumeAtStart
