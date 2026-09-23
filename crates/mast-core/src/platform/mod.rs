//! Narrow platform boundaries. The workspace/layout model and PTY pipeline stay shared.

#[cfg(target_os = "macos")]
pub mod macos;

/// Native POSIX paths do not need WSL's Windows-UNC alias restrictions.
/// Dot components remain disallowed so callers can safely reason about path prefixes.
pub fn validate_native_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("expected an absolute POSIX path without NUL".into());
    }
    if path.split('/').any(|part| part == "." || part == "..") {
        return Err("path must not contain '.' or '..' components".into());
    }
    Ok(())
}

pub fn validate_viewer_path(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        validate_native_path(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::wslpath::validate_linux_path(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_paths_preserve_posix_filenames() {
        for path in [
            "/",
            "/Users/me/a:b",
            "/Volumes/work/a\\b",
            "/tmp/trailing. ",
            "/Users/세진/문서",
        ] {
            assert!(validate_native_path(path).is_ok(), "{path}");
        }
        for path in [
            "relative",
            "C:\\work",
            "/tmp/../home",
            "/tmp/./file",
            "/tmp/a\0b",
        ] {
            assert!(validate_native_path(path).is_err(), "{path}");
        }
    }
}
