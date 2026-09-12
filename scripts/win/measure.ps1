<#
.SYNOPSIS
    Periodically measures the private working set of the mast spike app,
    including the WebView2 process tree.

.DESCRIPTION
    The measurement tool for 계획 v2 section 3 "리소스 측정" / spike-plan.md
    section 6 checklist item 6. Starting from the target process (exe name)
    as the root, it walks parent-PID chains to find every descendant process
    (WebView2 renderer/GPU processes etc.), then sums each process's
    Private Working Set (Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate)
    per sample.

.PARAMETER ProcessName
    Target process name (without extension). Default: mast-spike
    (matches productName in apps/spike/src-tauri/tauri.conf.json).

.PARAMETER IntervalSec
    Sampling interval in seconds. Default: 5.

.PARAMETER Samples
    Total sample count. Default: 12 (about 60 seconds at IntervalSec 5).

.PARAMETER OutCsv
    CSV file path for the results. When given, records per-process rows plus a
    TOTAL row per sample; when omitted, prints the console table only.

.EXAMPLE
    .\measure.ps1
    Console-only output with the defaults (mast-spike, 5s interval, 12 samples).

.EXAMPLE
    .\measure.ps1 -ProcessName mast-spike -IntervalSec 5 -Samples 12 -OutCsv .\ram-4pane.csv
    Records the spike-plan.md section 6 scenario (4 terminals etc.) to CSV.

.NOTES
    No administrator rights needed — reading Win32_Process (parent PIDs) and
    Win32_PerfFormattedData_PerfProc_Process (WorkingSetPrivate) via
    Get-CimInstance, and current-user process names via Get-Process, all work
    with normal user privileges.
#>

[CmdletBinding()]
param(
    [string]$ProcessName = "mast-spike",
    [int]$IntervalSec = 5,
    [int]$Samples = 12,
    [string]$OutCsv
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-ProcessTreeIds {
    <#
        WebView2는 별도 프로세스 트리(브라우저/렌더러/GPU)로 뜨므로 부모 PID 체인을
        따라 자손까지 모아야 전체 비용이 잡힌다.
    #>
    param([string]$RootName)

    $allProcs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
    $rootIds = $allProcs |
        Where-Object { $_.Name -eq "$RootName.exe" } |
        Select-Object -ExpandProperty ProcessId

    $resultIds = [System.Collections.Generic.HashSet[uint32]]::new()
    foreach ($id in $rootIds) {
        [void]$resultIds.Add([uint32]$id)
    }

    if ($resultIds.Count -eq 0) {
        return @()
    }

    # 새로 추가된 PID가 없을 때까지 돌리므로 트리 깊이가 얼마든 수렴한다 —
    # WebView2 자손이 몇 단계든 상관없다.
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($p in $allProcs) {
            $ppid = [uint32]$p.ParentProcessId
            $pid_ = [uint32]$p.ProcessId
            if ($resultIds.Contains($ppid) -and -not $resultIds.Contains($pid_)) {
                [void]$resultIds.Add($pid_)
                $changed = $true
            }
        }
    }

    # HashSet을 그대로 return하면 파이프라인이 원소 단위로 unroll해 호출부 타입이
    # 흔들린다 (0개 → $null, 1개 → 스칼라). 항상 배열로 평탄화해 돌려준다 —
    # Windows PowerShell 5.1의 StrictMode에서는 $null/스칼라의 .Count 접근이 예외다.
    return @($resultIds)
}

function Get-SampleRows {
    param([string]$RootName, [datetime]$Timestamp)

    $ids = @(Get-ProcessTreeIds -RootName $RootName)
    if ($ids.Count -eq 0) {
        Write-Warning "Process '$RootName' not found (not started yet, or the name differs)."
        return @()
    }

    # WorkingSetPrivate은 바이트 단위. 이 클래스의 Name은 "이름#N" 형태로 중복 인스턴스를
    # 구분하므로 이름 대신 IDProcess(실제 PID)로 매칭한다.
    $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
        Where-Object { $ids -contains [uint32]$_.IDProcess }

    $rows = foreach ($p in $perf) {
        $procInfo = Get-Process -Id $p.IDProcess -ErrorAction SilentlyContinue
        [PSCustomObject]@{
            Timestamp           = $Timestamp
            ProcessId           = [int]$p.IDProcess
            ProcessName         = if ($procInfo) { $procInfo.ProcessName } else { $p.Name }
            PrivateWorkingSetMB = [math]::Round($p.WorkingSetPrivate / 1MB, 2)
        }
    }

    return @($rows)
}

Write-Host "Target: $ProcessName (descendant process tree included, WebView2 included)"
Write-Host "Interval: ${IntervalSec}s / Samples: $Samples"
Write-Host ""

$allRows = [System.Collections.Generic.List[object]]::new()

for ($i = 1; $i -le $Samples; $i++) {
    $ts = Get-Date
    # 함수 반환도 파이프라인 unroll 대상이므로 호출부에서 다시 배열로 감싼다 (PS 5.1 호환).
    $rows = @(Get-SampleRows -RootName $ProcessName -Timestamp $ts)

    if ($rows.Count -eq 0) {
        if ($i -lt $Samples) {
            Start-Sleep -Seconds $IntervalSec
        }
        continue
    }

    $totalMB = [math]::Round(($rows | Measure-Object -Property PrivateWorkingSetMB -Sum).Sum, 2)

    Write-Host ("[{0}] sample {1}/{2}" -f $ts.ToString("HH:mm:ss"), $i, $Samples)
    $rows | Sort-Object -Property PrivateWorkingSetMB -Descending |
        Format-Table -Property ProcessId, ProcessName, PrivateWorkingSetMB -AutoSize | Out-Host
    Write-Host ("  Total: {0} MB ({1} processes)" -f $totalMB, $rows.Count)
    Write-Host ""

    foreach ($r in $rows) { $allRows.Add($r) }
    $allRows.Add([PSCustomObject]@{
        Timestamp           = $ts
        ProcessId           = $null
        ProcessName         = "TOTAL"
        PrivateWorkingSetMB = $totalMB
    })

    if ($i -lt $Samples) {
        Start-Sleep -Seconds $IntervalSec
    }
}

if ($OutCsv) {
    $allRows | Export-Csv -Path $OutCsv -NoTypeInformation -Encoding UTF8
    Write-Host "CSV saved: $OutCsv"
}
