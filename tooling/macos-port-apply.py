"""Apply the reviewed platform-specific Git regression assertion, then self-remove in CI."""
import hashlib
from pathlib import Path

path = Path("crates/mast-core/src/git.rs")
data = path.read_bytes()
blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
if blob != "540ad5704cf739b1e31bc42b6b902f5dd420ebc9":
    raise SystemExit("git.rs changed since review; refusing to overwrite concurrent work")
text = data.decode("utf-8")
old_name = "fn command_keeps_paths_as_arguments_and_uses_nonzero_linux_supervision()"
new_name = "fn command_keeps_paths_as_arguments_and_uses_platform_supervision()"
old = '        assert!(args.windows(2).any(|p| p == ["--kill-after=1s", "0.001s"]));'
new = '''        #[cfg(not(any(windows, target_os = "macos")))]
        assert_eq!(command.get_program(), "/usr/bin/timeout");
        #[cfg(not(target_os = "macos"))]
        assert!(args.windows(2).any(|p| p == ["--kill-after=1s", "0.001s"]));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(command.get_program(), "/usr/bin/env");
            assert!(!args.iter().any(|arg| arg.starts_with("--kill-after=")));
            assert!(!args.contains(&"/usr/bin/timeout"));
            assert!(!args.contains(&"--distribution"));
            assert!(args.windows(2).any(|p| p == ["-u", "GIT_DIR"]));
        }'''
if text.count(old_name) != 1 or text.count(old) != 1:
    raise SystemExit("Expected Git regression test not found exactly once")
path.write_text(text.replace(old_name, new_name).replace(old, new), encoding="utf-8")
