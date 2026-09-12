use std::process::Command;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::capture::{capture, CaptureLimits, CapturedOutput};

// 프론트 text-view.ts 의 WINDOW_BYTES 와 같은 읽기 예산이며 fixture 테스트로 맞춘다.
pub const DIFF_BYTES: usize = 512 * 1024;
const STATUS_BYTES: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 5_000;
const CONTROL_BYTES: usize = 64 * 1024;
const STDERR_BYTES: usize = 16 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub root: String,
    pub unborn: bool,
    pub entries: Vec<GitChange>,
    pub truncated: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitScope {
    Working,
    Staged,
    All,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffRequest {
    pub root: String,
    pub path: String,
    pub original_path: Option<String>,
    pub scope: GitScope,
    pub untracked: bool,
    pub unborn: bool,
}

#[derive(Debug, Serialize)]
pub struct GitDiff {
    pub text: String,
    pub truncated: bool,
}

pub fn status(distro: Option<&str>, path: &str) -> Result<GitStatus, String> {
    validate_root(path)?;
    let reader = GitReader::new(distro);
    let root = reader.resolve_root(path)?;
    let output = reader.run(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--no-ahead-behind",
            "--untracked-files=all",
            "--ignore-submodules=none",
            "--find-renames=50%",
        ],
        STATUS_BYTES,
    )?;
    check_output(&output, false, true)?;
    parse_status(root, &output.stdout, output.stdout_truncated)
}

pub fn diff(distro: Option<&str>, request: &GitDiffRequest) -> Result<GitDiff, String> {
    validate_root(&request.root)?;
    validate_file(&request.path)?;
    if let Some(original) = &request.original_path {
        validate_file(original)?;
    }
    if request.untracked && request.scope == GitScope::Staged {
        return Ok(GitDiff {
            text: String::new(),
            truncated: false,
        });
    }
    if request.path.ends_with('/') {
        return Err("Untracked repository directories have no file diff; open that repository in its own workspace".into());
    }
    let reader = GitReader::new(distro);
    let empty_tree;
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--patch",
        "--submodule=short",
        "--ignore-submodules=none",
        "--find-renames=50%",
        "--no-exit-code",
        "--no-quiet",
    ];
    if request.untracked {
        args.extend(["--no-index", "--", "/dev/null", &request.path]);
    } else {
        match request.scope {
            GitScope::Working => {}
            GitScope::Staged => args.push("--cached"),
            GitScope::All if request.unborn => {
                // -w 를 쓰지 않아 object DB 를 바꾸지 않는다. SHA-256 저장소에서도
                // Git 자신이 해당 object format 의 empty tree id 를 계산한다.
                empty_tree =
                    reader.control(&request.root, &["hash-object", "-t", "tree", "--stdin"])?;
                args.push(&empty_tree);
            }
            GitScope::All => args.push("HEAD"),
        }
        args.extend(["--", &request.path]);
        if let Some(original) = &request.original_path {
            args.push(original);
        }
    }
    let output = reader.run(&request.root, &args, DIFF_BYTES)?;
    check_output(&output, request.untracked, true)?;
    Ok(GitDiff {
        text: String::from_utf8_lossy(&output.stdout).into_owned(),
        truncated: output.stdout_truncated,
    })
}

struct GitReader<'a> {
    distro: Option<&'a str>,
    deadline: Instant,
}

impl<'a> GitReader<'a> {
    fn new(distro: Option<&'a str>) -> Self {
        Self {
            distro,
            deadline: Instant::now() + TIMEOUT,
        }
    }

    fn run(&self, root: &str, args: &[&str], cap: usize) -> Result<CapturedOutput, String> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let linux_timeout = remaining.saturating_sub(Duration::from_secs(1));
        if linux_timeout.is_zero() {
            return Err("Git query timed out after 10 seconds; refresh to retry".into());
        }
        let mut command = git_command(self.distro, root, args, linux_timeout)?;
        capture(
            &mut command,
            CaptureLimits {
                stdout_bytes: cap,
                stderr_bytes: STDERR_BYTES,
                timeout: remaining,
            },
        )
    }

    fn control(&self, root: &str, args: &[&str]) -> Result<String, String> {
        let output = self.run(root, args, CONTROL_BYTES)?;
        check_output(&output, false, false)?;
        let text = std::str::from_utf8(&output.stdout)
            .map_err(|_| "Git repository metadata is not valid UTF-8".to_owned())?;
        Ok(text.strip_suffix('\n').unwrap_or(text).to_owned())
    }

    fn resolve_root(&self, path: &str) -> Result<String, String> {
        match self
            .control(path, &["rev-parse", "--is-bare-repository"])?
            .as_str()
        {
            "false" => self.control(path, &["rev-parse", "--show-toplevel"]),
            "true" => {
                let branch = self.control(path, &["symbolic-ref", "HEAD"])?;
                let output = self.run(
                    path,
                    &["worktree", "list", "--porcelain", "-z"],
                    CONTROL_BYTES,
                )?;
                check_output(&output, false, false)?;
                let worktree = default_worktree(&output.stdout, &branch)?;
                validate_root(&worktree)?;
                self.control(&worktree, &["rev-parse", "--show-toplevel"])
            }
            other => Err(format!("Unexpected Git repository kind: {other:?}")),
        }
    }
}

fn git_command(
    distro: Option<&str>,
    root: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<Command, String> {
    if distro.is_some_and(|d| d.contains('\0')) {
        return Err("WSL distro must not contain a NUL byte".into());
    }
    #[cfg(windows)]
    let mut command = {
        let mut cmd = Command::new("wsl.exe");
        if let Some(distro) = distro.filter(|d| !d.is_empty()) {
            cmd.args(["--distribution", distro]);
        }
        cmd.args(["--exec", "/usr/bin/timeout"]);
        cmd
    };
    #[cfg(not(windows))]
    let mut command = Command::new("/usr/bin/timeout");

    // wsl.exe 를 끝내도 Linux 자손 종료는 보장되지 않는다. WSL 안의 timeout 이
    // 별도 process group 을 감독하고, 바깥 capture 는 relay·파이프의 마감도 지킨다.
    command.args([
        "--kill-after=1s",
        &format!("{:.3}s", timeout.as_secs_f64().max(0.001)),
    ]);
    command.arg("/usr/bin/env");
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_EXTERNAL_DIFF",
        "GIT_DIFF_OPTS",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_LITERAL_PATHSPECS",
        "GIT_GLOB_PATHSPECS",
        "GIT_NOGLOB_PATHSPECS",
        "GIT_ICASE_PATHSPECS",
    ] {
        command.args(["-u", name]);
    }
    command.args([
        "LC_ALL=C",
        "GIT_TERMINAL_PROMPT=0",
        "GIT_OPTIONAL_LOCKS=0",
        "git",
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-C",
        root,
    ]);
    command.args(args);
    Ok(command)
}

fn check_output(
    output: &CapturedOutput,
    no_index: bool,
    allow_truncated: bool,
) -> Result<(), String> {
    if output.timed_out
        || output
            .status
            .as_ref()
            .and_then(|s| s.code())
            .is_some_and(|c| c == 124 || c == 137)
    {
        return Err("Git query timed out after 10 seconds; refresh to retry".into());
    }
    if output.stderr_truncated {
        return Err(format!(
            "Git error output exceeded 16 KiB: {}",
            diagnostic(&output.stderr)
        ));
    }
    if output.stdout_truncated {
        return if allow_truncated {
            Ok(())
        } else {
            Err("Git repository metadata exceeded 64 KiB".into())
        };
    }
    let success = output.status.as_ref().is_some_and(|s| s.success());
    let different = no_index
        && output.status.as_ref().and_then(|s| s.code()) == Some(1)
        && !output.stdout.is_empty();
    if success || different {
        return Ok(());
    }
    Err(format!(
        "Git query failed ({}): {}",
        output
            .status
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_else(|| "terminated".into()),
        diagnostic(&output.stderr)
    ))
}

fn diagnostic(bytes: &[u8]) -> String {
    // WSL relay 오류는 UTF-16LE, Linux Git 오류는 UTF-8 이다.
    if bytes.contains(&0) {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        String::from_utf16_lossy(&units).trim().to_owned()
    } else {
        String::from_utf8_lossy(bytes).trim().to_owned()
    }
}

fn validate_root(path: &str) -> Result<(), String> {
    if !path.starts_with('/')
        || path.contains('\0')
        || path.split('/').any(|s| s == "." || s == "..")
    {
        return Err(
            "Git root must be an absolute Linux path without NUL, '.' or '..' components".into(),
        );
    }
    Ok(())
}

fn validate_file(path: &str) -> Result<(), String> {
    let path = path.strip_suffix('/').unwrap_or(path);
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\0')
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err("Git file must be a nonempty repository-relative path without NUL, '.' or '..' components".into());
    }
    Ok(())
}

fn default_worktree(bytes: &[u8], branch: &str) -> Result<String, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "Git worktree paths are not valid UTF-8".to_owned())?;
    for record in text.split("\0\0") {
        let fields: Vec<_> = record.split('\0').collect();
        if fields.contains(&"bare") || fields.iter().any(|s| s.starts_with("prunable")) {
            continue;
        }
        if fields
            .iter()
            .any(|s| s.strip_prefix("branch ") == Some(branch))
        {
            if let Some(path) = fields.iter().find_map(|s| s.strip_prefix("worktree ")) {
                return Ok(path.to_owned());
            }
        }
    }
    Err(format!("Bare repository has no available worktree for {branch}; open a workspace at a worktree path"))
}

fn parse_status(root: String, bytes: &[u8], mut truncated: bool) -> Result<GitStatus, String> {
    let end = if truncated {
        bytes.iter().rposition(|b| *b == 0).map_or(0, |i| i + 1)
    } else {
        if !bytes.is_empty() && bytes.last() != Some(&0) {
            return Err("Git status ended in an incomplete record".into());
        }
        bytes.len()
    };
    let mut records = bytes[..end].split(|b| *b == 0).filter(|r| !r.is_empty());
    let mut entries = Vec::new();
    let mut unborn = None;
    while let Some(record) = records.next() {
        let record = std::str::from_utf8(record)
            .map_err(|_| "Git status contains a filename that is not valid UTF-8".to_owned())?;
        if let Some(oid) = record.strip_prefix("# branch.oid ") {
            unborn = Some(oid == "(initial)");
            continue;
        }
        if record.starts_with("# ") {
            continue;
        }
        if entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        if let Some(path) = record.strip_prefix("? ") {
            validate_file(path)?;
            entries.push(GitChange {
                path: path.into(),
                original_path: None,
                index_status: "?".into(),
                worktree_status: "?".into(),
                untracked: true,
                conflicted: false,
            });
            continue;
        }
        let (count, renamed, conflicted) = match record.as_bytes().first() {
            Some(b'1') => (9, false, false),
            Some(b'2') => (10, true, false),
            Some(b'u') => (11, false, true),
            _ => return Err(format!("Unsupported Git status record: {record:?}")),
        };
        let fields: Vec<_> = record.splitn(count, ' ').collect();
        if fields.len() != count || fields[1].len() != 2 || !fields[1].is_ascii() {
            return Err("Malformed Git status record".into());
        }
        let path = fields[count - 1];
        validate_file(path)?;
        let original_path = if renamed {
            match records.next() {
                Some(original) => {
                    let original = std::str::from_utf8(original)
                        .map_err(|_| "Git rename source is not valid UTF-8".to_owned())?;
                    validate_file(original)?;
                    Some(original.into())
                }
                None if truncated => break,
                None => return Err("Git rename record has no source path".into()),
            }
        } else {
            None
        };
        entries.push(GitChange {
            path: path.into(),
            original_path,
            index_status: fields[1][..1].into(),
            worktree_status: fields[1][1..].into(),
            untracked: false,
            conflicted,
        });
    }
    Ok(GitStatus {
        root,
        unborn: unborn.ok_or("Git status did not report HEAD")?,
        entries,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncated_status_never_materializes_a_partial_filename_or_rename() {
        let prefix = b"# branch.oid (initial)\0? complete\0";
        let mut output = prefix.to_vec();
        output.extend_from_slice(b"? partial");
        let status = parse_status("/repo".into(), &output, true).unwrap();
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "complete");
        assert!(status.truncated);
        assert!(parse_status("/repo".into(), &output, false).is_err());
        let mut output = prefix.to_vec();
        output.extend_from_slice(
            b"2 R. N... 100644 100644 100644 aaa bbb R100 new name\0old partial",
        );
        let status = parse_status("/repo".into(), &output, true).unwrap();
        assert_eq!(status.entries.len(), 1);
        assert!(status.truncated);
    }

    #[test]
    fn porcelain_copy_and_unmerged_records_preserve_paths_with_spaces() {
        let output = b"# branch.oid aabbcc\0# future.header ignored\0\
2 C. N... 100644 100644 100644 aaa bbb C100 new copy\0old source\0\
u AA N... 000000 100644 100644 100644 aaa bbb ccc conflict file\0";
        let status = parse_status("/repo".into(), output, false).unwrap();
        assert_eq!(
            status.entries[0].original_path.as_deref(),
            Some("old source")
        );
        assert_eq!(status.entries[0].path, "new copy");
        assert_eq!(status.entries[1].path, "conflict file");
        assert!(status.entries[1].conflicted);
        assert!(!status.unborn);
    }

    #[test]
    fn invalid_utf8_names_are_refused_instead_of_aliasing_another_file() {
        let error = parse_status(
            "/repo".into(),
            b"# branch.oid (initial)\0? invalid\xff\0",
            false,
        )
        .unwrap_err();
        assert!(error.contains("UTF-8"));
    }

    #[test]
    fn command_keeps_paths_as_arguments_and_uses_nonzero_linux_supervision() {
        let command = git_command(
            Some("Ubuntu"),
            "/repo ' $(name)",
            &["diff", "--", "-oops", ":(glob)*"],
            Duration::from_nanos(1),
        )
        .unwrap();
        let args: Vec<_> = command.get_args().map(|s| s.to_str().unwrap()).collect();
        #[cfg(windows)]
        {
            assert_eq!(command.get_program(), "wsl.exe");
            assert_eq!(
                &args[..4],
                &["--distribution", "Ubuntu", "--exec", "/usr/bin/timeout"]
            );
        }
        assert!(args.windows(2).any(|p| p == ["--kill-after=1s", "0.001s"]));
        assert!(args.contains(&"--no-optional-locks"));
        assert!(args.contains(&"--literal-pathspecs"));
        assert!(args.windows(2).any(|p| p == ["-C", "/repo ' $(name)"]));
        assert_eq!(
            &args[args.len() - 4..],
            &["diff", "--", "-oops", ":(glob)*"]
        );
    }
}
