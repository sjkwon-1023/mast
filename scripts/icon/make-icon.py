#!/usr/bin/env python3
"""Regenerate apps/mast/src-tauri/icons/icon.ico — the mast app icon.

The exe icon is the only icon the app ships: `tauri_build::build()` embeds
`icons/icon.ico` into the Windows resources (there is no bundler and no PNG set),
and Windows reuses that resource for the taskbar, the title bar, Alt+Tab and the
Start-menu shortcut that `app_identity.rs` registers. Explorer caches icons per exe
path, so a rebuilt exe at the same path may keep showing the old one until
`ie4uinit.exe -show` runs — a stale cache, not a bad build.

Requires Pillow (`pip install pillow`). Run from anywhere:

    python3 scripts/icon/make-icon.py            # writes the .ico
    python3 scripts/icon/make-icon.py --preview  # also writes icon-preview.png next to it
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ICO = Path(__file__).resolve().parents[2] / "apps" / "mast" / "src-tauri" / "icons" / "icon.ico"
# Windows 가 실제로 쓰는 크기들. 256 은 탐색기 큰 아이콘·Alt+Tab, 16 은 제목 표시줄·목록 보기.
SIZES = [16, 32, 48, 64, 128, 256]

# 앱 팔레트와 같은 근검정 바탕에 하늘색 주돛. 앞돛은 한 단계 어두운 파랑이라 16px 에서
# 두 돛이 한 덩어리로 뭉개지지 않는다. 돛대는 밝은 회색 — 파란 돛 위에서 1px 로도 보인다.
BG = (11, 14, 20, 255)
MAIN = (77, 163, 255, 255)
JIB = (43, 111, 214, 255)
MAST = (230, 237, 243, 255)

# 4096 에서 그려 1024 로 줄인다 — Pillow 의 polygon 은 안티에일리어싱이 없어서, 슈퍼샘플링
# 없이 바로 작은 크기로 내리면 돛의 빗변이 계단 모양으로 남는다.
CANVAS = 4096
MASTER = 1024


def draw_master() -> Image.Image:
    im = Image.new("RGBA", (CANVAS, CANVAS), BG)
    d = ImageDraw.Draw(im)

    def p(x: float, y: float) -> tuple[float, float]:
        return (x * CANVAS, y * CANVAS)

    d.rectangle([p(0.36, 0.10), p(0.43, 0.90)], fill=MAST)
    d.polygon([p(0.45, 0.12), p(0.45, 0.78), p(0.90, 0.78)], fill=MAIN)
    d.polygon([p(0.34, 0.32), p(0.34, 0.78), p(0.10, 0.78)], fill=JIB)
    return im.resize((MASTER, MASTER), Image.LANCZOS)


def main() -> None:
    master = draw_master()
    # 크기마다 1024 원본에서 직접 줄인다 — Pillow 의 ICO 저장기가 하는 연쇄 축소보다 작은
    # 크기의 윤곽이 또렷하다.
    frames = [master.resize((s, s), Image.LANCZOS) for s in SIZES]
    ICO.parent.mkdir(parents=True, exist_ok=True)
    frames[-1].save(ICO, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print(f"wrote {ICO} ({ICO.stat().st_size} bytes, sizes {SIZES})")

    if "--preview" in sys.argv[1:]:
        preview = ICO.with_name("icon-preview.png")
        master.resize((256, 256), Image.LANCZOS).save(preview)
        print(f"wrote {preview}")


if __name__ == "__main__":
    main()
