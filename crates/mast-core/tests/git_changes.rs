#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use mast_core::git::{self, GitChange, GitDiffRequest, GitScope};
use tempfile::TempDir;

struct Repo(TempDir);

impl Repo {
    fn new() -> Self {
        let repo = Self(tempfile::tempdir().unwrap());
        repo.git(&["init", "--initial-branch=main", "--template="]);
        repo.git(&["config", "user.name", "Changes test"]);
        repo.git(&["config", "user.email", "changes@example.invalid"]);
        repo
    }

    fn path(&self) -> &str {
        self.0.path().to_str().unwrap()
    }

    fn output(&self, args: &[&str]) -> Output {
        Command::new("git")
            .args([
                "-C",
                self.path(),
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        let output = self.output(args);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn write(&self, path: &str, text: impl AsRef<[u8]>) {
        fs::write(self.0.path().join(path), text).unwrap();
    }

    fn commit(&self) {
        self.git(&["add", "--all"]);
        self.git(&["commit", "--quiet", "-m", "Fixture"]);
    }

    fn status(&self) -> git::GitStatus {
        git::status(None, self.path()).unwrap()
    }

    fn diff(&self, entry: &GitChange, scope: GitScope, unborn: bool) -> git::GitDiff {
        git::diff(
            None,
            &GitDiffRequest {
                root: self.path().into(),
                path: entry.path.clone(),
                original_path: match scope {
                    GitScope::Working if !matches!(entry.worktree_status.as_str(), "R" | "C") => {
                        None
                    }
                    GitScope::Staged if !matches!(entry.index_status.as_str(), "R" | "C") => None,
                    _ => entry.original_path.clone(),
                },
                scope,
                untracked: entry.untracked,
                unborn,
            },
        )
        .unwrap()
    }
}

#[test]
fn working_staged_and_all_use_their_own_baselines() {
    let repo = Repo::new();
    repo.write("file", "base\n");
    repo.commit();
    repo.write("file", "staged\n");
    repo.git(&["add", "file"]);
    repo.write("file", "working\n");
    let status = repo.status();
    assert!(!status.unborn);
    assert_eq!(status.root, repo.path());
    let entry = &status.entries[0];
    assert_eq!((&*entry.index_status, &*entry.worktree_status), ("M", "M"));
    let working = repo.diff(entry, GitScope::Working, false).text;
    assert!(working.contains("-staged\n+working"));
    let staged = repo.diff(entry, GitScope::Staged, false).text;
    assert!(staged.contains("-base\n+staged"));
    let all = repo.diff(entry, GitScope::All, false).text;
    assert!(all.contains("-base\n+working"));
    repo.write("file", "base\n");
    assert!(repo.diff(entry, GitScope::All, false).text.is_empty());
}

#[test]
fn unborn_staged_working_and_untracked_files_are_readable_without_writes() {
    let repo = Repo::new();
    repo.write("added", "index\n");
    repo.git(&["add", "added"]);
    repo.write("added", "worktree\n");
    repo.write("new file", "untracked\n");
    let status = repo.status();
    assert!(status.unborn);
    let added = status.entries.iter().find(|e| e.path == "added").unwrap();
    assert!(repo
        .diff(added, GitScope::Staged, true)
        .text
        .contains("+index"));
    assert!(repo
        .diff(added, GitScope::All, true)
        .text
        .contains("+worktree"));
    assert!(repo
        .diff(added, GitScope::Working, true)
        .text
        .contains("-index\n+worktree"));
    let untracked = status.entries.iter().find(|e| e.untracked).unwrap();
    assert!(repo
        .diff(untracked, GitScope::All, true)
        .text
        .contains("+untracked"));
    assert!(repo
        .diff(untracked, GitScope::Working, true)
        .text
        .contains("+untracked"));
    assert!(repo.diff(untracked, GitScope::Staged, true).text.is_empty());
    fs::remove_file(repo.0.path().join("added")).unwrap();
    assert!(repo.diff(added, GitScope::All, true).text.is_empty());
    assert!(!repo
        .0
        .path()
        .join(".git/objects/4b/825dc642cb6eb9a060e54bf8d69288fbee4904")
        .exists());
}

#[test]
fn filenames_are_literal_and_nul_delimited_including_rename_sources() {
    let repo = Repo::new();
    let names = [
        "-oops.txt",
        ":(glob)*",
        "[abc].txt",
        "line\nbreak",
        "quote' \" 한글.txt",
        "$(touch SENTINEL)",
        "back\\slash",
    ];
    for name in names {
        repo.write(name, "old\n");
    }
    repo.commit();
    for name in names {
        repo.write(name, format!("new {name}\n"));
    }
    let status = repo.status();
    assert_eq!(status.entries.len(), names.len());
    for name in names {
        let entry = status.entries.iter().find(|e| e.path == name).unwrap();
        let diff = repo.diff(entry, GitScope::Working, false).text;
        assert_eq!(diff.matches("diff --git ").count(), 1, "{name:?}: {diff}");
        assert!(diff.contains("+new "));
    }
    assert!(!repo.0.path().join("SENTINEL").exists());
    repo.commit();
    repo.git(&["mv", "--", "line\nbreak", "renamed\nfile"]);
    let status = repo.status();
    let entry = &status.entries[0];
    assert_eq!(entry.original_path.as_deref(), Some("line\nbreak"));
    assert_eq!(entry.path, "renamed\nfile");
    let diff = repo.diff(entry, GitScope::Staged, false).text;
    assert!(diff.contains("rename from"));
    assert!(diff.contains("rename to"));
    assert!(repo.diff(entry, GitScope::Working, false).text.is_empty());
}

#[test]
fn conflicts_remain_visible_and_diffable() {
    let repo = Repo::new();
    repo.write("conflict", "base\n");
    repo.commit();
    repo.git(&["switch", "-c", "other"]);
    repo.write("conflict", "other\n");
    repo.commit();
    repo.git(&["switch", "main"]);
    repo.write("conflict", "main\n");
    repo.commit();
    let merge = repo.output(&["merge", "other"]);
    assert_eq!(merge.status.code(), Some(1));
    let status = repo.status();
    assert_eq!(status.entries.len(), 1);
    let entry = &status.entries[0];
    assert!(entry.conflicted);
    assert_eq!((&*entry.index_status, &*entry.worktree_status), ("U", "U"));
    assert!(repo
        .diff(entry, GitScope::Working, false)
        .text
        .contains("<<<<<<<"));
    assert!(repo
        .diff(entry, GitScope::All, false)
        .text
        .contains("<<<<<<<"));
    assert!(repo
        .diff(entry, GitScope::Staged, false)
        .text
        .contains("Unmerged path"));
}

#[test]
fn index_lock_and_external_helpers_do_not_interfere_or_run() {
    let repo = Repo::new();
    repo.write("file", "before\n");
    repo.write(".gitattributes", "file diff=unsafe\n");
    repo.commit();
    repo.git(&["config", "diff.unsafe.command", "touch EXTERNAL_RAN"]);
    repo.git(&["config", "diff.unsafe.textconv", "touch TEXTCONV_RAN"]);
    repo.git(&["config", "core.fsmonitor", "touch FSMONITOR_RAN"]);
    repo.write("file", "after\n");
    repo.write(".git/index.lock", "agent owns this lock\n");
    let index = fs::read(repo.0.path().join(".git/index")).unwrap();
    let status = repo.status();
    let entry = status.entries.iter().find(|e| e.path == "file").unwrap();
    assert!(repo
        .diff(entry, GitScope::Working, false)
        .text
        .contains("+after"));
    for name in ["EXTERNAL_RAN", "TEXTCONV_RAN", "FSMONITOR_RAN"] {
        assert!(!repo.0.path().join(name).exists());
    }
    assert_eq!(fs::read(repo.0.path().join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(repo.0.path().join(".git/index.lock")).unwrap(),
        "agent owns this lock\n"
    );
}

#[test]
fn binary_summaries_and_large_diff_truncation_are_explicit() {
    let repo = Repo::new();
    repo.write("binary", b"a\0b");
    repo.write("large", "base\n");
    repo.commit();
    repo.write("binary", b"c\0d");
    repo.write("large", "large line\n".repeat(100_000));
    let status = repo.status();
    let binary = status.entries.iter().find(|e| e.path == "binary").unwrap();
    let summary = repo.diff(binary, GitScope::Working, false);
    assert!(summary.text.contains("Binary files"));
    assert!(!summary.truncated);
    let large = status.entries.iter().find(|e| e.path == "large").unwrap();
    let diff = repo.diff(large, GitScope::Working, false);
    assert!(diff.truncated);
    assert!(diff.text.len() <= git::DIFF_BYTES);
    assert!(diff.text.contains("+large line"));
}

#[test]
fn subdirectory_and_bare_container_resolve_to_the_default_worktree() {
    let repo = Repo::new();
    repo.write("base", "base\n");
    repo.commit();
    fs::create_dir(repo.0.path().join("nested")).unwrap();
    assert_eq!(
        git::status(None, repo.0.path().join("nested").to_str().unwrap())
            .unwrap()
            .root,
        repo.path()
    );
    let container = tempfile::tempdir().unwrap();
    let bare = container.path().join(".bare");
    repo.git(&["clone", "--bare", repo.path(), bare.to_str().unwrap()]);
    fs::write(container.path().join(".git"), "gitdir: ./.bare\n").unwrap();
    let main = container.path().join("main\n checkout");
    let other = container.path().join("other");
    let run = |args: &[&str]| {
        let output = Command::new("git")
            .arg("-C")
            .arg(&bare)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(&[
        "worktree",
        "add",
        "-b",
        "other",
        other.to_str().unwrap(),
        "main",
    ]);
    run(&["worktree", "add", main.to_str().unwrap(), "main"]);
    fs::write(main.join("new"), "new\n").unwrap();
    let status = git::status(None, container.path().to_str().unwrap()).unwrap();
    assert_eq!(Path::new(&status.root), main);
    assert_eq!(status.entries[0].path, "new");
    run(&["worktree", "remove", "--force", main.to_str().unwrap()]);
    let error = git::status(None, container.path().to_str().unwrap()).unwrap_err();
    assert!(error.contains("no available worktree"), "{error}");
}

#[test]
fn staged_deletion_and_untracked_replacement_remain_distinct() {
    let repo = Repo::new();
    repo.write("file", "old\n");
    repo.commit();
    repo.git(&["rm", "--cached", "file"]);
    let status = repo.status();
    assert_eq!(status.entries.len(), 2);
    assert!(status.entries.iter().all(|e| e.path == "file"));
    let deleted = status.entries.iter().find(|e| !e.untracked).unwrap();
    let untracked = status.entries.iter().find(|e| e.untracked).unwrap();
    assert!(repo
        .diff(deleted, GitScope::Staged, false)
        .text
        .contains("-old"));
    assert!(repo
        .diff(untracked, GitScope::Working, false)
        .text
        .contains("+old"));
}

#[test]
fn missing_repositories_and_invalid_requests_fail_loudly() {
    let empty = tempfile::tempdir().unwrap();
    let error = git::status(None, empty.path().to_str().unwrap()).unwrap_err();
    assert!(error.contains("not a git repository"));
    for path in ["", "../outside", "/absolute", "a/../file", "nul\0name"] {
        let result = git::diff(
            None,
            &GitDiffRequest {
                root: empty.path().to_str().unwrap().into(),
                path: path.into(),
                original_path: None,
                scope: GitScope::All,
                untracked: true,
                unborn: true,
            },
        );
        assert!(result.unwrap_err().contains("repository-relative"));
    }
}

#[test]
fn status_listing_has_a_finite_entry_budget() {
    let repo = Repo::new();
    for i in 0..5_010 {
        repo.write(&format!("file-{i:05}"), "new\n");
    }
    let status = repo.status();
    assert!(status.truncated);
    assert_eq!(status.entries.len(), 5_000);
}

#[test]
fn untracked_option_like_paths_and_symlinks_are_read_without_following_targets() {
    let repo = Repo::new();
    for name in ["-oops", ":(glob)*", "한글 ' file"] {
        repo.write(name, "untracked\n");
    }
    std::os::unix::fs::symlink("/this-target-does-not-exist", repo.0.path().join("symlink"))
        .unwrap();
    let status = repo.status();
    for entry in &status.entries {
        let diff = repo.diff(entry, GitScope::All, true).text;
        assert_eq!(diff.matches("diff --git ").count(), 1);
        if entry.path == "symlink" {
            assert!(diff.contains("+/this-target-does-not-exist"));
        } else {
            assert!(diff.contains("+untracked"));
        }
    }
}

#[test]
fn an_untracked_nested_repository_does_not_break_the_file_list() {
    let repo = Repo::new();
    let nested = repo.0.path().join("nested");
    repo.git(&["init", "--initial-branch=main", nested.to_str().unwrap()]);
    repo.write("nested/file", "nested\n");
    repo.git(&[
        "-C",
        nested.to_str().unwrap(),
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "add",
        "file",
    ]);
    repo.git(&[
        "-C",
        nested.to_str().unwrap(),
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "nested",
    ]);
    repo.write("ordinary", "outside\n");
    let status = repo.status();
    assert!(status.entries.iter().any(|e| e.path == "ordinary"));
    let entry = status.entries.iter().find(|e| e.path == "nested/").unwrap();
    assert!(entry.untracked);
    let error = git::diff(
        None,
        &GitDiffRequest {
            root: repo.path().into(),
            path: entry.path.clone(),
            original_path: None,
            scope: GitScope::All,
            untracked: true,
            unborn: true,
        },
    )
    .unwrap_err();
    assert!(error.contains("own workspace"));
}

#[test]
fn unborn_all_uses_the_repository_object_format() {
    let repo = Repo(tempfile::tempdir().unwrap());
    repo.git(&[
        "init",
        "--object-format=sha256",
        "--initial-branch=main",
        "--template=",
    ]);
    repo.write("file", "initial\n");
    repo.git(&["add", "file"]);
    let status = repo.status();
    assert!(status.unborn);
    assert!(repo
        .diff(&status.entries[0], GitScope::All, true)
        .text
        .contains("+initial"));
}

#[test]
fn working_rename_keeps_both_sides_of_the_patch() {
    let repo = Repo::new();
    repo.write("old", "same content\n");
    repo.commit();
    fs::rename(repo.0.path().join("old"), repo.0.path().join("new")).unwrap();
    repo.git(&["add", "--intent-to-add", "--", "new"]);
    let status = repo.status();
    let entry = status.entries.iter().find(|e| e.path == "new").unwrap();
    assert_eq!((&*entry.index_status, &*entry.worktree_status), (".", "R"));
    assert_eq!(entry.original_path.as_deref(), Some("old"));
    let patch = repo.diff(entry, GitScope::Working, false).text;
    assert!(patch.contains("rename from old"), "{patch}");
    assert!(patch.contains("rename to new"), "{patch}");
}

#[test]
fn working_rename_preserves_staged_changes_at_its_source() {
    let repo = Repo::new();
    repo.write("old", "base\n");
    repo.commit();
    repo.write("old", "staged\n");
    repo.git(&["add", "--", "old"]);
    fs::rename(repo.0.path().join("old"), repo.0.path().join("new")).unwrap();
    repo.git(&["add", "--intent-to-add", "--", "new"]);
    let status = repo.status();
    let entry = status.entries.iter().find(|e| e.path == "new").unwrap();
    assert_eq!((&*entry.index_status, &*entry.worktree_status), (".", "R"));
    assert_eq!(entry.original_path.as_deref(), Some("old"));
    let staged_entry = status.entries.iter().find(|e| e.path == "old").unwrap();
    assert_eq!(staged_entry.index_status, "M");
    let patch = repo.diff(staged_entry, GitScope::Staged, false).text;
    assert!(patch.contains("-base"), "{patch}");
    assert!(patch.contains("+staged"), "{patch}");
}
