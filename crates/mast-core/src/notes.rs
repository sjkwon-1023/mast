//! 로컬 메모 파일 저장소. 범위마다 파일 하나를 원자 교체로 갱신한다.
//!
//! 파일 이름 규칙은 이 모듈이 소유한다. 호출자는 저장소 루트 디렉터리만 정하고
//! 개별 경로 문자열을 넘기지 않는다. 읽기·저장·삭제는 하나의 작업 잠금으로
//! 직렬화되며, [`NoteStore::lock`]으로 여러 작업을 한 잠금 안에서 묶을 수 있다.
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::document::MAX_DOCUMENT_BYTES;
use crate::model::WorkspaceId;

/// 메모 편집 범위. JSON은 `{"type":"global"}` 또는
/// `{"type":"workspace","workspace":<id>}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NoteScope {
    Global,
    Workspace { workspace: WorkspaceId },
}

/// 저장 결과. 충돌이면 디스크의 현재 원문을 함께 돌려준다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SaveOutcome {
    Saved,
    Conflict { current: String },
}

/// 메모 파일 저장소. 루트는 첫 쓰기 때 만들고 경로는 호출자가 정한다.
#[derive(Debug)]
pub struct NoteStore {
    root: PathBuf,
    work: Mutex<()>,
}

impl NoteStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            work: Mutex::new(()),
        }
    }

    /// 하나의 작업 잠금을 잡고 여러 작업을 묶어 실행한다. 잠금을 잡은 상태에서
    /// 다른 잠금(예: Dispatcher)을 짧게 잡는 호출자를 위해 노출한다.
    pub fn lock(&self) -> Result<NoteAccess<'_>, String> {
        let work = self
            .work
            .lock()
            .map_err(|_| "notes lock is poisoned".to_string())?;
        Ok(NoteAccess {
            root: &self.root,
            _work: work,
        })
    }

    pub fn read(&self, scope: NoteScope) -> Result<String, String> {
        self.lock()?.read(scope)
    }

    pub fn save(
        &self,
        scope: NoteScope,
        expected: &str,
        content: &str,
    ) -> Result<SaveOutcome, String> {
        self.lock()?.save(scope, expected, content)
    }

    pub fn has_content(&self, workspace: WorkspaceId) -> Result<bool, String> {
        self.lock()?.has_content(workspace)
    }

    /// global은 타입상 삭제 대상이 될 수 없다.
    pub fn delete_workspace(&self, workspace: WorkspaceId) -> Result<(), String> {
        self.lock()?.delete_workspace(workspace)
    }
}

/// 작업 잠금을 잡은 상태의 저장소 접근자.
pub struct NoteAccess<'a> {
    root: &'a Path,
    _work: MutexGuard<'a, ()>,
}

impl NoteAccess<'_> {
    pub fn read(&self, scope: NoteScope) -> Result<String, String> {
        if !check_root(self.root)? {
            return Ok(String::new());
        }
        read_note(&note_path(self.root, scope))
    }

    pub fn save(
        &self,
        scope: NoteScope,
        expected: &str,
        content: &str,
    ) -> Result<SaveOutcome, String> {
        if expected.len() > MAX_DOCUMENT_BYTES || content.len() > MAX_DOCUMENT_BYTES {
            return Err("note exceeds 2 MiB".to_string());
        }
        ensure_root(self.root)?;
        let target = note_path(self.root, scope);
        let current = read_note(&target)?;
        if current != expected {
            return Ok(SaveOutcome::Conflict { current });
        }
        let mut temp = tempfile::Builder::new()
            .prefix(".mast-note-")
            .tempfile_in(self.root)
            .map_err(|err| err.to_string())?;
        temp.write_all(content.as_bytes())
            .map_err(|err| err.to_string())?;
        temp.as_file().sync_all().map_err(|err| err.to_string())?;
        // 임시 파일을 쓰는 동안 외부에서 바뀐 경우에도 덮어쓰지 않는다.
        let latest = read_note(&target)?;
        if latest != expected {
            return Ok(SaveOutcome::Conflict { current: latest });
        }
        temp.persist(&target).map_err(|err| err.error.to_string())?;
        Ok(SaveOutcome::Saved)
    }

    pub fn has_content(&self, workspace: WorkspaceId) -> Result<bool, String> {
        if !check_root(self.root)? {
            return Ok(false);
        }
        let path = note_path(self.root, NoteScope::Workspace { workspace });
        match open_note(&path)? {
            Some(file) => Ok(file.metadata().map_err(|err| err.to_string())?.len() > 0),
            None => Ok(false),
        }
    }

    pub fn delete_workspace(&self, workspace: WorkspaceId) -> Result<(), String> {
        if !check_root(self.root)? {
            return Ok(());
        }
        let path = note_path(self.root, NoteScope::Workspace { workspace });
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.to_string()),
        };
        if meta.file_type().is_symlink() {
            return Err("note is a symbolic link".to_string());
        }
        if !meta.is_file() {
            return Err("note is not a regular file".to_string());
        }
        fs::remove_file(&path).map_err(|err| err.to_string())
    }
}

fn note_path(root: &Path, scope: NoteScope) -> PathBuf {
    let name = match scope {
        NoteScope::Global => "global.txt".to_string(),
        NoteScope::Workspace { workspace } => format!("workspace-{}.txt", workspace.0),
    };
    root.join(name)
}

/// 루트가 없으면 false. 심볼릭 링크이거나 디렉터리가 아니면 오류다.
fn check_root(root: &Path) -> Result<bool, String> {
    let meta = match fs::symlink_metadata(root) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err.to_string()),
    };
    if meta.file_type().is_symlink() {
        return Err("notes directory is a symbolic link".to_string());
    }
    if !meta.is_dir() {
        return Err("notes path is not a directory".to_string());
    }
    Ok(true)
}

fn ensure_root(root: &Path) -> Result<(), String> {
    if check_root(root)? {
        return Ok(());
    }
    fs::create_dir_all(root).map_err(|err| err.to_string())?;
    if check_root(root)? {
        Ok(())
    } else {
        Err("notes path is not a directory".to_string())
    }
}

/// 정규 파일만 연다. 파일이 없으면 None, 링크·비정규 파일은 오류다.
fn open_note(path: &Path) -> Result<Option<File>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    if meta.file_type().is_symlink() {
        return Err("note is a symbolic link".to_string());
    }
    if !meta.is_file() {
        return Err("note is not a regular file".to_string());
    }
    let file = File::open(path).map_err(|err| err.to_string())?;
    if !file.metadata().map_err(|err| err.to_string())?.is_file() {
        return Err("note is not a regular file".to_string());
    }
    Ok(Some(file))
}

fn read_note(path: &Path) -> Result<String, String> {
    let Some(file) = open_note(path)? else {
        return Ok(String::new());
    };
    let mut bytes = Vec::new();
    file.take((MAX_DOCUMENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err("note exceeds 2 MiB".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "note is not valid UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, NoteStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = NoteStore::new(dir.path().join("notes"));
        (dir, store)
    }

    fn workspace(id: u64) -> NoteScope {
        NoteScope::Workspace {
            workspace: WorkspaceId(id),
        }
    }

    #[test]
    fn creates_overwrites_and_separates_scopes() {
        let (dir, store) = store();
        let root = dir.path().join("notes");
        assert_eq!(store.read(NoteScope::Global).unwrap(), "");
        assert_eq!(
            store.save(NoteScope::Global, "", "전역 메모").unwrap(),
            SaveOutcome::Saved
        );
        assert_eq!(
            store.save(workspace(1), "", "워크스페이스 메모").unwrap(),
            SaveOutcome::Saved
        );
        assert_eq!(
            fs::read_to_string(root.join("global.txt")).unwrap(),
            "전역 메모"
        );
        assert_eq!(
            fs::read_to_string(root.join("workspace-1.txt")).unwrap(),
            "워크스페이스 메모"
        );
        assert_eq!(store.read(NoteScope::Global).unwrap(), "전역 메모");
        assert_eq!(store.read(workspace(1)).unwrap(), "워크스페이스 메모");
        assert_eq!(store.read(workspace(2)).unwrap(), "");
        assert_eq!(
            store.save(workspace(1), "워크스페이스 메모", "").unwrap(),
            SaveOutcome::Saved
        );
        assert_eq!(store.read(workspace(1)).unwrap(), "");
        assert_eq!(store.read(NoteScope::Global).unwrap(), "전역 메모");
    }

    #[test]
    fn does_not_create_the_root_until_the_first_save() {
        let (dir, store) = store();
        let root = dir.path().join("notes");
        assert_eq!(store.read(NoteScope::Global).unwrap(), "");
        assert!(!store.has_content(WorkspaceId(1)).unwrap());
        store.delete_workspace(WorkspaceId(1)).unwrap();
        assert!(!root.exists());
        store.save(NoteScope::Global, "", "x").unwrap();
        assert!(root.is_dir());
    }

    #[test]
    fn stale_expected_conflicts_without_touching_the_file() {
        let (dir, store) = store();
        let path = dir.path().join("notes/workspace-7.txt");
        store.save(workspace(7), "", "base").unwrap();
        assert_eq!(
            store.save(workspace(7), "base", "first").unwrap(),
            SaveOutcome::Saved
        );
        assert_eq!(
            store.save(workspace(7), "base", "late").unwrap(),
            SaveOutcome::Conflict {
                current: "first".into()
            }
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_saves_of_the_same_base_have_one_winner() {
        use std::sync::{Arc, Barrier};
        let contents = ["first", "second"];
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(NoteStore::new(dir.path().join("notes")));
        store.save(workspace(3), "", "base").unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let threads: Vec<_> = contents
            .into_iter()
            .map(|content| {
                let store = store.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.save(workspace(3), "base", content)
                })
            })
            .collect();
        let outcomes: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap().unwrap())
            .collect();
        let winner = outcomes.iter().position(|o| *o == SaveOutcome::Saved);
        assert_eq!(
            outcomes
                .iter()
                .filter(|o| **o == SaveOutcome::Saved)
                .count(),
            1
        );
        let Some(winner) = winner else { unreachable!() };
        assert_eq!(
            outcomes[1 - winner],
            SaveOutcome::Conflict {
                current: contents[winner].into()
            }
        );
        assert_eq!(store.read(workspace(3)).unwrap(), contents[winner]);
    }

    #[test]
    fn enforces_the_byte_limit_at_max_and_max_plus_one() {
        let (dir, store) = store();
        let path = dir.path().join("notes/workspace-6.txt");
        let max = "x".repeat(MAX_DOCUMENT_BYTES);
        assert_eq!(
            store.save(workspace(6), "", &max).unwrap(),
            SaveOutcome::Saved
        );
        assert_eq!(store.read(workspace(6)).unwrap(), max);
        assert!(store
            .save(workspace(6), &max, &"y".repeat(MAX_DOCUMENT_BYTES + 1))
            .is_err());
        assert!(store
            .save(workspace(6), &"y".repeat(MAX_DOCUMENT_BYTES + 1), "z")
            .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), max);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_utf8_is_an_error_not_an_empty_note() {
        let (dir, store) = store();
        let root = dir.path().join("notes");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("workspace-4.txt");
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(store.read(workspace(4)).is_err());
        assert!(store.save(workspace(4), "", "new").is_err());
        assert!(store.has_content(WorkspaceId(4)).unwrap());
        assert_eq!(fs::read(&path).unwrap(), [0xff, 0xfe, 0x00]);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn directory_targets_are_errors_for_read_save_and_delete() {
        let (dir, store) = store();
        let root = dir.path().join("notes");
        fs::create_dir_all(root.join("workspace-5.txt")).unwrap();
        assert!(store.read(workspace(5)).is_err());
        assert!(store.save(workspace(5), "", "new").is_err());
        assert!(store.has_content(WorkspaceId(5)).is_err());
        assert!(store.delete_workspace(WorkspaceId(5)).is_err());
        assert!(root.join("workspace-5.txt").is_dir());
    }

    #[test]
    fn a_root_that_is_a_regular_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("notes");
        fs::write(&root, "x").unwrap();
        let store = NoteStore::new(root);
        assert!(store.read(NoteScope::Global).is_err());
        assert!(store.save(NoteScope::Global, "", "new").is_err());
        assert!(store.has_content(WorkspaceId(1)).is_err());
        assert!(store.delete_workspace(WorkspaceId(1)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_roots_and_targets_are_rejected() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real_root = dir.path().join("real");
        fs::create_dir_all(&real_root).unwrap();
        let linked_root = dir.path().join("linked");
        symlink(&real_root, &linked_root).unwrap();
        let store = NoteStore::new(linked_root);
        assert!(store.read(NoteScope::Global).is_err());
        assert!(store.save(NoteScope::Global, "", "new").is_err());
        assert!(store.has_content(WorkspaceId(1)).is_err());
        assert!(store.delete_workspace(WorkspaceId(1)).is_err());

        let store = NoteStore::new(real_root.clone());
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, real_root.join("workspace-9.txt")).unwrap();
        assert!(store.read(workspace(9)).is_err());
        assert!(store.save(workspace(9), "", "new").is_err());
        assert!(store.has_content(WorkspaceId(9)).is_err());
        assert!(store.delete_workspace(WorkspaceId(9)).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
    }

    #[test]
    fn deleting_a_workspace_note_is_idempotent_and_keeps_global() {
        let (dir, store) = store();
        let root = dir.path().join("notes");
        store.save(NoteScope::Global, "", "global").unwrap();
        store.save(workspace(8), "", "ws").unwrap();
        store.delete_workspace(WorkspaceId(8)).unwrap();
        store.delete_workspace(WorkspaceId(8)).unwrap();
        assert!(!root.join("workspace-8.txt").exists());
        assert_eq!(store.read(NoteScope::Global).unwrap(), "global");
        assert_eq!(store.read(workspace(8)).unwrap(), "");
    }

    #[test]
    fn has_content_reports_length_not_text() {
        let (_, store) = store();
        assert!(!store.has_content(WorkspaceId(1)).unwrap());
        store.save(workspace(1), "", "   \n").unwrap();
        assert!(store.has_content(WorkspaceId(1)).unwrap());
        store.save(workspace(1), "   \n", "").unwrap();
        assert!(!store.has_content(WorkspaceId(1)).unwrap());
    }

    #[test]
    fn one_lock_covers_several_operations() {
        let (_, store) = store();
        let access = store.lock().unwrap();
        assert_eq!(
            access.save(workspace(2), "", "new").unwrap(),
            SaveOutcome::Saved
        );
        assert_eq!(access.read(workspace(2)).unwrap(), "new");
        assert!(access.has_content(WorkspaceId(2)).unwrap());
        access.delete_workspace(WorkspaceId(2)).unwrap();
        drop(access);
        assert_eq!(store.read(workspace(2)).unwrap(), "");
    }

    #[test]
    fn scope_and_outcome_serialize_with_the_shared_tag_shape() {
        assert_eq!(
            serde_json::to_value(NoteScope::Global).unwrap(),
            serde_json::json!({ "type": "global" })
        );
        assert_eq!(
            serde_json::to_value(workspace(12)).unwrap(),
            serde_json::json!({ "type": "workspace", "workspace": 12 })
        );
        assert_eq!(
            serde_json::from_value::<NoteScope>(
                serde_json::json!({ "type": "workspace", "workspace": 12 })
            )
            .unwrap(),
            workspace(12)
        );
        assert_eq!(
            serde_json::to_value(SaveOutcome::Saved).unwrap(),
            serde_json::json!({ "type": "saved" })
        );
        assert_eq!(
            serde_json::to_value(SaveOutcome::Conflict {
                current: "disk".into()
            })
            .unwrap(),
            serde_json::json!({ "type": "conflict", "current": "disk" })
        );
    }
}
