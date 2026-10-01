#!/bin/bash
# Mast macOS 설치·업데이트. curl 로 받은 파일에는 격리 속성이 붙지 않아, 서명하지 않은 앱도
# Gatekeeper 확인 없이 열린다 (ADR-0033). 브라우저로 받은 zip 은 이 경로를 타지 않는다.
set -euo pipefail

repo="${MAST_REPO_URL:-https://github.com/sjkwon-1023/mast}"
url="${MAST_DOWNLOAD_URL:-}"
dest="${MAST_APP_DIR:-/Applications}"

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo "mast: this installer supports Apple Silicon Macs only" >&2
  exit 1
fi

# 버전을 고른 다운로드(MAST_DOWNLOAD_URL)는 항상 설치한다. 기본 경로만 최신 릴리즈와 비교한다 —
# /releases/latest 가 리다이렉트되는 태그 주소에서 읽어 API·JSON 파서에 기대지 않는다.
if [[ -z $url ]]; then
  url="$repo/releases/latest/download/mast-macos-arm64.zip"
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$repo/releases/latest")
  latest=${latest##*/tag/v}
  installed=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "$dest/mast.app/Contents/Info.plist" 2>/dev/null || true)
  if [[ -n $installed && $installed == "$latest" ]]; then
    echo "mast $installed is already the latest release"
    exit 0
  fi
fi

if pgrep -f "$dest/mast.app/Contents/MacOS/" >/dev/null; then
  echo "mast: quit Mast before installing" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
echo "Downloading $url"
curl -fL --progress-bar "$url" -o "$work/mast.zip"
ditto -x -k "$work/mast.zip" "$work/unpacked"
if [[ ! -d "$work/unpacked/mast.app" ]]; then
  echo "mast: the download does not contain mast.app" >&2
  exit 1
fi

mkdir -p "$dest"
rm -rf "$dest/mast.app"
ditto "$work/unpacked/mast.app" "$dest/mast.app"
echo "Installed $dest/mast.app"
