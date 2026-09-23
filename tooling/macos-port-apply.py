"""One-shot native compatibility correction; removed after application."""
from pathlib import Path
p = Path('crates/mast-core/src/git.rs')
s = p.read_text()
old = '''    #[cfg(not(windows))]
    let mut command = Command::new("/usr/bin/timeout");'''
new = '''    #[cfg(not(any(windows, target_os = "macos")))]
    let mut command = Command::new("/usr/bin/timeout");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/env");
    // Native capture already owns a process group and enforces the deadline.
    // Only the WSL relay needs a second, in-guest timeout supervisor.
    #[cfg(target_os = "macos")]
    let _ = timeout;'''
assert old in s
s = s.replace(old, new, 1)
old = '''    command.args([
        "--kill-after=1s",
        &format!("{:.3}s", timeout.as_secs_f64().max(0.001)),
    ]);
    command.arg("/usr/bin/env");'''
new = '''    #[cfg(not(target_os = "macos"))]
    {
        command.args([
            "--kill-after=1s",
            &format!("{:.3}s", timeout.as_secs_f64().max(0.001)),
        ]);
        command.arg("/usr/bin/env");
    }'''
assert old in s
p.write_text(s.replace(old, new, 1))
p = Path('crates/mast-core/tests/git_changes.rs')
s = p.read_text()
assert 'tempfile::tempdir().unwrap()' in s
s = s.replace('tempfile::tempdir().unwrap()', 'fixture_dir()')
s = s.replace('struct Repo(TempDir);', '''// macOS exposes /var through /private/var. Git returns the canonical path;
// construct fixtures there so path assertions mean the same thing on every OS.
fn fixture_dir() -> TempDir {
    let root = fs::canonicalize(std::env::temp_dir()).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

struct Repo(TempDir);''', 1)
p.write_text(s)
