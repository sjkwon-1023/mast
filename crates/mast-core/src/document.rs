//! 마크다운 편집 저장. 원문 비교 뒤 같은 디렉터리의 임시 파일로 교체한다.
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

static SAVE_LOCK: Mutex<()> = Mutex::new(());

pub const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;

fn read_document(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    if !file.metadata().map_err(|err| err.to_string())?.is_file() {
        return Err("not a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_DOCUMENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err("document exceeds 2 MiB".into());
    }
    Ok(bytes)
}

pub fn save_markdown(path: &Path, expected: &str, content: &str) -> Result<(), String> {
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if !extension.eq_ignore_ascii_case("md") && !extension.eq_ignore_ascii_case("markdown") {
        return Err("only Markdown documents can be edited".into());
    }
    if expected.len() > MAX_DOCUMENT_BYTES || content.len() > MAX_DOCUMENT_BYTES {
        return Err("document exceeds 2 MiB".into());
    }
    // 여러 탭에서 같은 원문을 동시에 저장해도 한 저장만 성공한다.
    let _guard = SAVE_LOCK.lock().map_err(|err| err.to_string())?;
    // 링크 자체를 교체하지 않고 사용자가 읽은 최종 파일을 저장한다.
    let target = fs::canonicalize(path).map_err(|err| err.to_string())?;
    if read_document(&target)? != expected.as_bytes() {
        return Err("file changed on disk; copy your edits before reloading".into());
    }
    let permissions = fs::metadata(&target)
        .map_err(|err| err.to_string())?
        .permissions();
    if permissions.readonly() {
        return Err("file is read-only".into());
    }
    let parent = target.parent().ok_or("file has no parent directory")?;
    let mut temp = tempfile::Builder::new()
        .prefix(".mast-edit-")
        .tempfile_in(parent)
        .map_err(|err| err.to_string())?;
    temp.write_all(content.as_bytes())
        .map_err(|err| err.to_string())?;
    temp.as_file()
        .set_permissions(permissions)
        .map_err(|err| err.to_string())?;
    temp.as_file().sync_all().map_err(|err| err.to_string())?;
    // 임시 파일을 쓰는 동안 외부 편집기가 저장한 경우에도 덮어쓰지 않는다.
    // 외부 프로세스와의 원자적 CAS는 파일시스템이 제공하지 않는다.
    if read_document(&target)? != expected.as_bytes() {
        return Err("file changed on disk; copy your edits before reloading".into());
    }
    temp.persist(&target).map_err(|err| err.error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saves_utf8_and_refuses_stale_edits_without_changing_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "# 원문\r\n").unwrap();
        save_markdown(&path, "# 원문\r\n", "# 수정\r\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# 수정\r\n");
        assert!(save_markdown(&path, "# 원문\r\n", "stale").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "# 수정\r\n");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn refuses_missing_oversized_and_non_markdown_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        assert!(save_markdown(&path, "", "new").is_err());
        fs::write(&path, "old").unwrap();
        assert!(save_markdown(&path, "old", &"x".repeat(MAX_DOCUMENT_BYTES + 1)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        let other = dir.path().join("note.txt");
        fs::write(&other, "old").unwrap();
        assert!(save_markdown(&other, "old", "new").is_err());
    }
    #[test]
    fn concurrent_edits_of_the_same_version_have_one_winner() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "base").unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let threads: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|content| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    save_markdown(&path, "base", content)
                })
            })
            .collect();
        let successes = threads
            .into_iter()
            .filter_map(|thread| thread.join().unwrap().ok())
            .count();
        assert_eq!(successes, 1);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_symlink_and_target_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.md");
        let link = dir.path().join("link.md");
        fs::write(&target, "old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&target, &link).unwrap();
        save_markdown(&link, "old", "new").unwrap();
        assert!(link.is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}
