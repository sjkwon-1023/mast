//! 좁은 플랫폼 경계. workspace/layout 모델과 PTY 파이프라인은 공유한 채로 둔다.

#[cfg(target_os = "macos")]
pub mod macos;

/// 네이티브 POSIX 경로에는 WSL 의 Windows-UNC alias 제약이 필요 없다.
/// 호출자가 경로 prefix 를 안전하게 따질 수 있도록 dot 컴포넌트는 계속 금지한다.
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
