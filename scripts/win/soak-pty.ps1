<#
.SYNOPSIS
    Runs the Windows ConPTY resource soak test and tees its output to a
    timestamped log next to a CSV of the samples.

.DESCRIPTION
    A thin wrapper around

        cargo test -p mast-core --release --test soak_windows -- --ignored --nocapture

    The test (`crates/mast-core/tests/soak_windows.rs`) creates, kills and
    respawns a `PtySession` hundreds of times and checks that handles, threads,
    private bytes and the ConPTY/WSL helper process counts come back to the
    baseline taken after warm-up. This script only moves its parameters into the
    environment variables the test reads, and keeps the output.

    Every other knob (MAST_SOAK_SAMPLE_EVERY, MAST_SOAK_WARMUP,
    MAST_SOAK_SETTLE_SECS, MAST_SOAK_HANDLE_SLACK, MAST_SOAK_THREAD_SLACK,
    MAST_SOAK_PRIVATE_SLACK_MB) is read straight from the environment — set it
    before calling this script. See docs/WINDOWS-BUILD.md, "PTY resource soak test".

.PARAMETER Cycles
    Measured cycles after warm-up (MAST_SOAK_CYCLES). Default: 500.

.PARAMETER Mode
    'wsl' spawns `wsl.exe --exec …` (the path the app actually uses, WSL relay
    processes included); 'cmd' spawns `cmd.exe` and exercises ConPTY alone, much
    faster. Default: wsl.

.PARAMETER OutDir
    Directory for the log and the CSV. Created if missing.
    Default: .\soak-results under the repository root.

.EXAMPLE
    .\soak-pty.ps1
    500 WSL cycles with the default slack, results under .\soak-results.

.EXAMPLE
    .\soak-pty.ps1 -Cycles 1000 -Mode cmd -OutDir C:\temp\soak
    1,000 ConPTY-only cycles.

.NOTES
    No administrator rights needed. The test measures its own process only
    (GetProcessHandleCount, Toolhelp, K32GetProcessMemoryInfo) plus a
    system-wide process-name count, all of which work as a normal user.
    Run it on an otherwise quiet machine: the conhost/OpenConsole/wsl counts are
    system-wide, so other terminals opening and closing during the run show up
    as noise in those columns.
#>

[CmdletBinding()]
param(
    [int]$Cycles = 500,
    [ValidateSet("wsl", "cmd")]
    [string]$Mode = "wsl",
    [string]$OutDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# 스크립트는 scripts/win 에 있다 — cargo 는 워크스페이스 루트에서 돌린다.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $OutDir) {
    $OutDir = Join-Path $repoRoot "soak-results"
}
if (-not (Test-Path $OutDir)) {
    [void](New-Item -ItemType Directory -Path $OutDir)
}
$OutDir = (Resolve-Path $OutDir).Path

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $OutDir "soak-$Mode-$stamp.log"
$csvPath = Join-Path $OutDir "soak-$Mode-$stamp.csv"

# 테스트는 설정을 전부 env 로 읽는다. 여기서 넘기지 않는 나머지 knob 은 호출자가
# 미리 설정해 둔 값이 그대로 쓰인다.
$env:MAST_SOAK_CYCLES = "$Cycles"
$env:MAST_SOAK_MODE = $Mode
$env:MAST_SOAK_CSV = $csvPath

Write-Host "Repository: $repoRoot"
Write-Host "Mode: $Mode / Cycles: $Cycles"
Write-Host "Log: $logPath"
Write-Host "CSV: $csvPath"
Write-Host ""

$exitCode = 1
$prevErrorAction = $ErrorActionPreference
Push-Location $repoRoot
try {
    # 2>&1 로 cargo 의 진행 표시(stderr)까지 같은 파일에 남긴다 — 실패했을 때
    # 컴파일 에러인지 판정 실패인지가 로그 하나로 갈린다.
    #
    # 그 동안만 ErrorActionPreference 를 내린다. Windows PowerShell 5.1 은 리다이렉트된
    # 네이티브 stderr 한 줄 한 줄을 NativeCommandError 레코드로 감싸므로, Stop 이면
    # cargo 의 첫 "Compiling …" 에서 스크립트가 죽어 soak 가 시작조차 못 한다. PowerShell
    # 7.4+ 는 같은 설정($PSNativeCommandUseErrorActionPreference 기본값 true) 때문에
    # cargo 의 0 아닌 종료 코드에서 throw 해 아래 FAIL 안내를 건너뛴다.
    $ErrorActionPreference = "Continue"
    cargo test -p mast-core --release --test soak_windows -- --ignored --nocapture 2>&1 |
        Tee-Object -FilePath $logPath
    $exitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $prevErrorAction
    Pop-Location
}

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "PASS — see $logPath"
} else {
    Write-Warning "FAIL (cargo exit $exitCode) — the panic message at the end of $logPath names the counters that did not return."
}
exit $exitCode
