# Mast Windows 설치·업데이트. `irm <이 파일의 raw URL> | iex` 로 실행한다.
# curl.exe 로 받은 파일에는 Mark of the Web 이 붙지 않아, 서명하지 않은 exe 도 SmartScreen 확인
# 없이 열린다 (ADR-0033). Windows PowerShell 5.1 에서도 돌아야 한다.
# `iex` 는 호출한 세션의 범위에서 돌므로 변수와 설정이 새지 않게 스크립트 블록 안에서 실행한다.
# MAST_WINDOWS_SHELL=powershell 이면 PowerShell 탭용 agy 훅과 설정도 함께 둔다 (ADR-0037 결정 9).
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

    # `return` 이 PowerShell 단계를 건너뛰지 않도록 mast.exe 설치를 함수로 감싼다.
    function Install-MastExe {
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

    # JSON 객체 파일을 읽는다. 없으면 빈 객체, 잘못된 JSON 이나 객체가 아니면 아무것도 쓰지 않고 실패한다.
    # `[PSCustomObject]` 는 `[PSObject]` 의 별칭이라 PS 5.1 에서 배열·문자열도 통과하므로 전체 타입 이름으로 본다.
    function Read-JsonObject([string]$path) {
        if (-not (Test-Path -LiteralPath $path)) { return [PSCustomObject]@{} }
        $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
        try {
            $value = $text | ConvertFrom-Json
        } catch {
            throw "mast: $path is not valid JSON. Fix or move it aside, then run the installer again. Nothing was changed."
        }
        if ($value -isnot [System.Management.Automation.PSCustomObject]) {
            throw "mast: $path must contain a JSON object. Nothing was changed."
        }
        return $value
    }

    # BOM 없는 UTF-8 로 임시 파일에 쓴 뒤 옮긴다. agy(Go)는 BOM 이 있는 hooks.json 을 읽지 못하고,
    # 쓰는 도중 끊기면 반쯤 쓰인 JSON 이 남기 때문이다.
    function Write-JsonObject([string]$path, $value) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        $json = ConvertTo-Json -InputObject $value -Depth 32
        $temp = "$path.installing"
        [System.IO.File]::WriteAllText($temp, $json + "`n", (New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false))
        Move-Item -LiteralPath $temp -Destination $path -Force
    }

    function Install-PowerShellMode($settingsPath, $settings, $hooksPath, $hooks) {
        $hookAsset = switch ($arch) {
            'X64' { 'mast-agy-hook-x64.exe' }
            'Arm64' { 'mast-agy-hook-arm64.exe' }
        }
        $bin = Join-Path $dest 'bin'
        $hookExe = Join-Path $bin 'mast-agy-hook.exe'
        $hookUrl = if ($env:MAST_HOOK_DOWNLOAD_URL) { $env:MAST_HOOK_DOWNLOAD_URL } else { "$repo/releases/latest/download/$hookAsset" }

        # 1. 훅 exe 를 놓는다. mast.exe 와 같은 방식으로 검증하고 옛 파일을 비켜 둔다.
        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        $staged = Join-Path $bin 'mast-agy-hook.exe.installing'
        Write-Host "Downloading $hookUrl"
        & curl.exe -fL --progress-bar -o $staged $hookUrl
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
            throw "mast: hook download failed. mast.exe is up to date; settings.json and hooks.json are unchanged. Run the installer again. ($hookUrl)"
        }
        $head = [System.IO.File]::ReadAllBytes($staged)[0..1]
        if ($head.Count -ne 2 -or $head[0] -ne 0x4D -or $head[1] -ne 0x5A) {
            Remove-Item -LiteralPath $staged -Force
            throw 'mast: the hook download is not a Windows executable. mast.exe is up to date; settings.json and hooks.json are unchanged. Run the installer again.'
        }
        Get-ChildItem -LiteralPath $bin -Filter 'mast-agy-hook.exe.old-*' -ErrorAction SilentlyContinue |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
        $old = $null
        if (Test-Path -LiteralPath $hookExe) {
            $old = Join-Path $bin ("mast-agy-hook.exe.old-" + [DateTime]::UtcNow.Ticks)
            Rename-Item -LiteralPath $hookExe -NewName (Split-Path $old -Leaf)
        }
        try {
            Rename-Item -LiteralPath $staged -NewName 'mast-agy-hook.exe'
        } catch {
            if ($old) { Rename-Item -LiteralPath $old -NewName 'mast-agy-hook.exe' }
            throw
        }
        if ($old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
        Write-Host "Installed $hookExe"

        # 2. hooks.json 의 mast 그룹만 바꾼다. 다른 그룹은 그대로 둔다.
        $group = [PSCustomObject]@{
            PreInvocation = @([PSCustomObject]@{ type = 'command'; command = 'mast-agy-hook running'; timeout = 5 })
            Stop = @([PSCustomObject]@{ type = 'command'; command = 'mast-agy-hook idle'; timeout = 5 })
        }
        $hooks | Add-Member -MemberType NoteProperty -Name mast -Value $group -Force
        Write-JsonObject $hooksPath $hooks
        Write-Host "Registered mast-agy-hook in $hooksPath"

        # 3. 설정은 마지막에 쓴다. 훅이 없는데 PowerShell 모드인 상태가 남지 않게 하려는 순서다.
        $settings | Add-Member -MemberType NoteProperty -Name windowsShell -Value 'powershell' -Force
        Write-JsonObject $settingsPath $settings
        Write-Host "Set windowsShell to powershell in $settingsPath"
        Write-Host 'Quit and reopen mast to use PowerShell tabs.'
    }

    # 값이 없으면 mast.exe 만 설치한다. 다른 값은 아무것도 바꾸기 전에 거부한다.
    $windowsShell = $env:MAST_WINDOWS_SHELL
    if ($windowsShell -and $windowsShell -cne 'powershell') {
        throw "mast: MAST_WINDOWS_SHELL must be 'powershell' or unset, got '$windowsShell'"
    }
    if ($windowsShell) {
        # 두 JSON 파일을 먼저 읽어 검증한다. 잘못된 파일이면 mast.exe 도 바꾸지 않고 멈춘다.
        $settingsPath = Join-Path $env:APPDATA 'app.mast.desktop\settings.json'
        $hooksPath = Join-Path $env:USERPROFILE '.gemini\config\hooks.json'
        $settings = Read-JsonObject $settingsPath
        $hooks = Read-JsonObject $hooksPath
    }

    Install-MastExe
    if ($windowsShell) {
        Install-PowerShellMode $settingsPath $settings $hooksPath $hooks
    }
}
