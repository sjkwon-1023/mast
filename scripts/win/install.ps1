# Mast Windows 설치·업데이트. `irm <이 파일의 raw URL> | iex` 로 실행한다.
# curl.exe 로 받은 파일에는 Mark of the Web 이 붙지 않아, 서명하지 않은 exe 도 SmartScreen 확인
# 없이 열린다 (ADR-0033). Windows PowerShell 5.1 에서도 돌아야 한다.
# `iex` 는 호출한 세션의 범위에서 돌므로 변수와 설정이 새지 않게 스크립트 블록 안에서 실행한다.
& {
    $ErrorActionPreference = 'Stop'

    $repo = if ($env:MAST_REPO_URL) { $env:MAST_REPO_URL } else { 'https://github.com/sjkwon-1023/mast' }
    $dest = if ($env:MAST_APP_DIR) { $env:MAST_APP_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\mast' }
    $exe = Join-Path $dest 'mast.exe'

    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    $asset = switch ($arch) {
        'X64' { 'mast-x64.exe' }
        'Arm64' { 'mast-arm64.exe' }
        default { throw "mast: unsupported Windows architecture $arch" }
    }

    # 버전을 고른 다운로드(MAST_DOWNLOAD_URL)는 항상 설치한다. 기본 경로만 최신 릴리즈와 비교한다 —
    # /releases/latest 가 리다이렉트되는 태그 주소에서 읽어 API·JSON 파싱에 기대지 않는다.
    $url = $env:MAST_DOWNLOAD_URL
    if (-not $url) {
        $url = "$repo/releases/latest/download/$asset"
        $latest = & curl.exe -fsSLI -o NUL -w '%{url_effective}' "$repo/releases/latest"
        if ($LASTEXITCODE -ne 0) { throw 'mast: cannot reach the latest release' }
        $latest = ($latest -split '/tag/v')[-1]
        if (Test-Path -LiteralPath $exe) {
            # 문자열 FileVersion 에는 빌드 설명이 붙기도 하므로 숫자 필드로 비교한다.
            $info = (Get-Item -LiteralPath $exe).VersionInfo
            $installed = '{0}.{1}.{2}' -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart
            if ($installed -eq $latest) {
                Write-Host "mast $installed is already the latest release"
                return
            }
        }
    }

    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $staged = Join-Path $dest 'mast.exe.installing'
    Write-Host "Downloading $url"
    & curl.exe -fL --progress-bar -o $staged $url
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
        throw "mast: download failed ($url)"
    }
    $head = [System.IO.File]::ReadAllBytes($staged)[0..1]
    if ($head.Count -ne 2 -or $head[0] -ne 0x4D -or $head[1] -ne 0x5A) {
        Remove-Item -LiteralPath $staged -Force
        throw 'mast: the download is not a Windows executable'
    }

    # 실행 중인 exe 는 지우거나 덮어쓸 수 없지만 같은 폴더 안에서 이름은 바꿀 수 있다. 옛 exe 를
    # .old-<시각> 으로 비켜 두고 새 exe 를 그 자리에 놓으면, 실행 중인 Mast 는 옛 파일로 계속 돌고
    # 새 버전은 다음 실행에 적용된다. 경로가 같으므로 방화벽 규칙·시작 메뉴 바로가기도 그대로다.
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count -gt 0
    Get-ChildItem -LiteralPath $dest -Filter 'mast.exe.old-*' -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    $old = $null
    if (Test-Path -LiteralPath $exe) {
        $old = Join-Path $dest ("mast.exe.old-" + [DateTime]::UtcNow.Ticks)
        Rename-Item -LiteralPath $exe -NewName (Split-Path $old -Leaf)
    }
    try {
        Rename-Item -LiteralPath $staged -NewName 'mast.exe'
    } catch {
        if ($old) { Rename-Item -LiteralPath $old -NewName 'mast.exe' }
        throw
    }
    if ($old -and -not $running) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }

    Write-Host "Installed $exe"
    if ($running) {
        Write-Host 'Mast is still running the previous version. Quit and reopen it to use the new one.'
    }
}
