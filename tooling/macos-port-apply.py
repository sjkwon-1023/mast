"""One-shot validation fixes; removed by the development workflow."""
from pathlib import Path
import struct

def edit(path, replacements):
    p = Path(path)
    s = p.read_text()
    for old, new, count in replacements:
        assert old in s, (path, old)
        s = s.replace(old, new, count)
    p.write_text(s)

edit('crates/mast-core/src/command/tests.rs', [
    ('/// distro 를 단 워크스페이스 헬퍼', '''/// WSL distro is forwarded on Windows/Linux, but newly created native Mac
/// workspaces intentionally have no distro. Keep testing both platform contracts.
fn expected_distro(name: &str) -> Option<String> {
    if cfg!(target_os = "macos") { None } else { Some(name.to_owned()) }
}

/// distro 를 단 워크스페이스 헬퍼''', 1),
    ('host.spawns()[0].distro.as_deref(), Some("Ubuntu")', 'host.spawns()[0].distro, expected_distro("Ubuntu")', -1),
    ('vec![(vec![tab], Some("Ubuntu".into()))]', 'vec![(vec![tab], expected_distro("Ubuntu"))]', -1),
    ('vec![(vec![tab], Some("Ubuntu".to_string()))]', 'vec![(vec![tab], expected_distro("Ubuntu"))]', -1),
    ('vec![(vec![a, b], Some("Ubuntu".into()))]', 'vec![(vec![a, b], expected_distro("Ubuntu"))]', -1),
    ('Some((vec![c, dd], Some("Debian".into())))', 'Some((vec![c, dd], expected_distro("Debian")))', -1),
    ('ShellSpawnReq {\n            cwd: Some("/proj".into()),\n            distro: Some("Ubuntu".into()),', 'ShellSpawnReq {\n            cwd: Some("/proj".into()),\n            distro: expected_distro("Ubuntu"),', 1),
])
edit('apps/mast/src/shared/keys.test.ts', [
    ('  keyAction,', '  keyAction as platformKeyAction,', 1),
    ('  shortcutBadge,', '  shortcutBadge as platformShortcutBadge,', 1),
    ('  shortcutLabel,', '  shortcutLabel as platformShortcutLabel,', 1),
    ('function spec(', '''// This suite describes the existing Windows keymap, on every test host.
const keyAction = (key: KeySpec) => platformKeyAction(key, false);
const shortcutBadge = (id: Parameters<typeof platformShortcutBadge>[0]) => platformShortcutBadge(id, false);
const shortcutLabel = (id: Parameters<typeof platformShortcutLabel>[0]) => platformShortcutLabel(id, false);

function spec(''', 1),
])
edit('apps/mast/src/features/terminal/terminal.test.ts', [
    ('altArrowSequence, isCopySelectionKey, shouldOpenLink', 'altArrowSequence, isCopySelectionKey as platformCopySelectionKey, shouldOpenLink', 1),
    ('describe("clampFontSize"', '''// Explicitly retain the Windows copy-selection contract; Mac is tested separately.
const isCopySelectionKey = (event: KeyboardEvent, selected: boolean) => platformCopySelectionKey(event, selected, false);

describe("clampFontSize"''', 1),
])
edit('apps/mast/tests/provision-hooks.test.ts', [('`cannot read ${path} (`', '`cannot read ${realpathSync(path)} (`', 1)])
edit('apps/mast/src-tauri/src/commands.rs', [('use mast_core::wslpath;', '#[cfg(not(target_os = "macos"))]\nuse mast_core::wslpath;', 1)])
edit('apps/mast/src-tauri/src/provision.rs', [('use crate::winlog;', '#[cfg(windows)]\nuse crate::winlog;', 1)])
edit('crates/mast-core/src/platform/macos.rs', [('if count < 0 {', 'if count <= 0 {', 1)])
# Reuse the existing Mast artwork. The largest ICO frame is already a PNG;
# Tauri's macOS context generator requires this cross-platform icon resource.
icon = Path('apps/mast/src-tauri/icons/icon.ico').read_bytes()
entries = [struct.unpack_from('<BBBBHHII', icon, 6 + 16*i) for i in range(struct.unpack_from('<H', icon, 4)[0])]
entry = max(entries, key=lambda e: (e[0] or 256)*(e[1] or 256))
png = icon[entry[-1]:entry[-1]+entry[-2]]
assert png.startswith(b'\x89PNG\r\n\x1a\n')
Path('apps/mast/src-tauri/icons/icon.png').write_bytes(png)
