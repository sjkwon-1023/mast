//! 에이전트가 요청한 파일·디렉터리·diff 표시의 순수 규칙.
//!
//! OSC·CLI 요청은 [`parse_request`] 로 읽는다. 클릭은 상대 경로와 탭 cwd 를 받으므로 파싱을
//! 거치지 않고 [`resolve_path`] 로 바로 정규화한다. 두 경로 모두 같은 [`PathRules`] 를 쓴다.
//! 파일 stat, Git root 조회, 응답 파일 기록은 호출자가 한다. 이 모듈은 I/O 를 하지 않는다.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::command::{Placement, ViewerSpec};
use crate::model::{PaneId, SplitDirection};
use crate::platform;
use crate::wslpath;

/// JS number 로 정확히 왕복하는 가장 큰 정수 (2^53 - 1).
const MAX_PANE_ID: u64 = (1 << 53) - 1;

/// 표시 요청. 경로는 절대 경로이지만 아직 정규화하지 않았다. [`resolve_path`] 로 접는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Layout,
    Open { path: String, placement: Placement },
    Diff { path: String, placement: Placement },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRequest {
    action: Action,
    path: Option<String>,
    placement: Option<RawPlacement>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Layout,
    Open,
    Diff,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPlacement {
    pane: Option<u64>,
    split: Option<RawSplit>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSplit {
    pane: u64,
    direction: RawDirection,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawDirection {
    Right,
    Down,
}

impl RawPlacement {
    fn into_placement(self) -> Result<Placement, PresentationError> {
        match (self.pane, self.split) {
            (Some(pane), None) => Ok(Placement::Pane {
                pane: pane_id(pane)?,
            }),
            (None, Some(split)) => Ok(Placement::Split {
                pane: pane_id(split.pane)?,
                direction: match split.direction {
                    RawDirection::Right => SplitDirection::Horizontal,
                    RawDirection::Down => SplitDirection::Vertical,
                },
            }),
            (None, None) => Err(invalid_params("placement needs either pane or split")),
            (Some(_), Some(_)) => Err(invalid_params(
                "placement takes either pane or split, not both",
            )),
        }
    }
}

fn pane_id(value: u64) -> Result<PaneId, PresentationError> {
    if (1..=MAX_PANE_ID).contains(&value) {
        Ok(PaneId(value))
    } else {
        Err(invalid_params(format!(
            "pane id must be an integer from 1 to {MAX_PANE_ID}"
        )))
    }
}

/// OSC `presentation:` 의 디코드된 JSON 과 CLI 요청을 요청으로 읽는다.
///
/// 형태만 검증한다. 상대 경로는 거부하고, 경로 정규화, 종류 판정, 대상 워크스페이스 확인은 호출자가 한다.
pub fn parse_request(bytes: &[u8]) -> Result<Request, PresentationError> {
    let raw: RawRequest = serde_json::from_slice(bytes)
        .map_err(|error| invalid_params(format!("malformed presentation request: {error}")))?;
    match raw.action {
        Action::Layout => {
            if raw.path.is_some() || raw.placement.is_some() {
                return Err(invalid_params("layout takes neither path nor placement"));
            }
            Ok(Request::Layout)
        }
        Action::Open | Action::Diff => {
            let path = match raw.path {
                Some(path) if path.starts_with('/') => path,
                Some(_) => return Err(invalid_params("path must be an absolute POSIX path")),
                None => return Err(invalid_params("open and diff require a path")),
            };
            let placement = match raw.placement {
                Some(placement) => placement.into_placement()?,
                None => Placement::Default,
            };
            Ok(match raw.action {
                Action::Open => Request::Open { path, placement },
                _ => Request::Diff { path, placement },
            })
        }
    }
}

/// 경로 규칙의 대상 플랫폼. Linux·WSL 은 [`wslpath::validate_linux_path`],
/// macOS native 는 [`platform::validate_native_path`] 를 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathRules {
    Linux,
    Native,
}

impl PathRules {
    /// 이 빌드의 대상 플랫폼 규칙.
    pub fn host() -> Self {
        if cfg!(target_os = "macos") {
            Self::Native
        } else {
            Self::Linux
        }
    }

    fn validate(self, path: &str) -> Result<(), String> {
        match self {
            Self::Linux => wslpath::validate_linux_path(path),
            Self::Native => platform::validate_native_path(path),
        }
    }
}

/// 요청 경로를 절대 POSIX 경로로 만든다.
///
/// 상대 경로는 `cwd` 와 합친 뒤 `.`·`..` 를 문자열로 접는다. 루트 위의 `..` 는 루트에 머문다.
/// `symlink/..` 는 파일시스템의 해석과 다를 수 있으며 이는 의도된 한계다. 결과는 `rules` 로
/// 검증하지만 존재와 종류는 확인하지 않는다.
pub fn resolve_path(
    path: &str,
    cwd: Option<&str>,
    rules: PathRules,
) -> Result<String, PresentationError> {
    if path.is_empty() {
        return Err(invalid_path("path must not be empty"));
    }
    reject_before_join(path, rules)?;
    let joined = if path.starts_with('/') {
        path.to_owned()
    } else {
        let cwd =
            cwd.ok_or_else(|| invalid_path("a relative path needs the tab's working directory"))?;
        if !cwd.starts_with('/') {
            return Err(invalid_path(
                "the working directory must be an absolute path",
            ));
        }
        reject_before_join(cwd, rules)?;
        format!("{cwd}/{path}")
    };
    let resolved = fold_segments(&joined);
    rules.validate(&resolved).map_err(invalid_path)?;
    Ok(resolved)
}

/// 조립 전에 거부한다. NUL 과 Linux 규칙의 구분자·ADS 밀수는 조립 뒤에도 남으므로 순서만 앞당긴다.
fn reject_before_join(path: &str, rules: PathRules) -> Result<(), PresentationError> {
    if path.contains('\0') {
        return Err(invalid_path("path must not contain a NUL byte"));
    }
    if rules == PathRules::Linux {
        if path.contains('\\') {
            return Err(invalid_path("path must not contain a backslash"));
        }
        if path.split('/').any(|component| component.contains(':')) {
            return Err(invalid_path("path component must not contain ':'"));
        }
    }
    Ok(())
}

/// `.` 은 버리고 `..` 은 한 단계 올린다. 빈 세그먼트(중복·후행 `/`)도 버린다.
fn fold_segments(path: &str) -> String {
    let mut kept = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                kept.pop();
            }
            _ => kept.push(segment),
        }
    }
    format!("/{}", kept.join("/"))
}

/// 호출자가 stat 으로 얻은 대상 종류. 실제 stat 은 호출자가 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Directory,
    File,
    Other,
}

/// `open` 의 뷰어 명세. `.md` 확장자는 대소문자를 무시한다.
pub fn open_viewer(path: &str, kind: Kind) -> Result<ViewerSpec, PresentationError> {
    match kind {
        Kind::Directory => Ok(ViewerSpec::FolderBrowser {
            path: path.to_owned(),
        }),
        Kind::File if is_markdown(path) => Ok(ViewerSpec::MarkdownViewer {
            path: path.to_owned(),
        }),
        Kind::File => Ok(ViewerSpec::TextViewer {
            path: path.to_owned(),
        }),
        Kind::Other => Err(invalid_path(
            "only regular files and directories can be shown",
        )),
    }
}

fn is_markdown(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

/// `diff` 의 Git root 를 찾을 디렉터리. 파일이면 부모, 디렉터리면 자신이다.
/// 없는 경로는 호출자가 `not_found` 로 처리하며, 부모를 거슬러 올라가 추측하지 않는다.
pub fn diff_lookup_dir(path: &str, kind: Kind) -> Result<String, PresentationError> {
    match kind {
        Kind::Directory => Ok(path.to_owned()),
        Kind::File => Ok(parent_dir(path)),
        Kind::Other => Err(invalid_path(
            "only regular files and directories have a repository to show",
        )),
    }
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(index) => path[..index].to_owned(),
    }
}

/// 외부 계약의 오류 코드. 코드 문자열은 [`ErrorCode::as_str`] 이 단일 출처다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidParams,
    InvalidPath,
    NotFound,
    NotRepository,
    UnknownTarget,
    /// glue 의 Git 동시 실행 슬롯이 고갈된 경우에만 쓴다. 요청이 많다는 뜻으로 쓰지 않는다.
    Busy,
    Timeout,
    TooLarge,
    IoError,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InvalidParams => "invalid_params",
            Self::InvalidPath => "invalid_path",
            Self::NotFound => "not_found",
            Self::NotRepository => "not_repository",
            Self::UnknownTarget => "unknown_target",
            Self::Busy => "busy",
            Self::Timeout => "timeout",
            Self::TooLarge => "too_large",
            Self::IoError => "io_error",
        }
    }
}

/// 요청 처리의 실패. `message` 는 사용자에게 보이는 영어 문장이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentationError {
    pub code: ErrorCode,
    pub message: String,
}

impl PresentationError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn invalid_params(message: impl Into<String>) -> PresentationError {
    PresentationError::new(ErrorCode::InvalidParams, message)
}

fn invalid_path(message: impl Into<String>) -> PresentationError {
    PresentationError::new(ErrorCode::InvalidPath, message)
}

/// 성공 응답 본문 `{"result": ...}`. 기존 sink 응답과 같은 envelope 이다.
pub fn encode_result<T: Serialize>(value: &T) -> String {
    json!({ "result": value }).to_string()
}

/// 실패 응답 본문 `{"error": {"code", "message"}}`.
pub fn encode_error(error: &PresentationError) -> String {
    json!({ "error": { "code": error.code.as_str(), "message": error.message } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Request, PresentationError> {
        parse_request(text.as_bytes())
    }

    fn parse_code(text: &str) -> ErrorCode {
        parse(text).unwrap_err().code
    }

    #[test]
    fn parses_every_action_and_placement_form() {
        assert_eq!(parse(r#"{"action":"layout"}"#), Ok(Request::Layout));
        assert_eq!(
            parse(r#"{"action":"open","path":"/a.md"}"#),
            Ok(Request::Open {
                path: "/a.md".into(),
                placement: Placement::Default,
            })
        );
        assert_eq!(
            parse(r#"{"action":"open","path":"/a.md","placement":{"pane":3}}"#),
            Ok(Request::Open {
                path: "/a.md".into(),
                placement: Placement::Pane { pane: PaneId(3) },
            })
        );
        assert_eq!(
            parse(
                r#"{"action":"open","path":"/a.md","placement":{"split":{"pane":3,"direction":"right"}}}"#
            ),
            Ok(Request::Open {
                path: "/a.md".into(),
                placement: Placement::Split {
                    pane: PaneId(3),
                    direction: SplitDirection::Horizontal,
                },
            })
        );
        assert_eq!(
            parse(
                r#"{"action":"diff","path":"/repo","placement":{"split":{"pane":3,"direction":"down"}}}"#
            ),
            Ok(Request::Diff {
                path: "/repo".into(),
                placement: Placement::Split {
                    pane: PaneId(3),
                    direction: SplitDirection::Vertical,
                },
            })
        );
        assert_eq!(
            parse(r#"{"action":"diff","path":"/repo"}"#),
            Ok(Request::Diff {
                path: "/repo".into(),
                placement: Placement::Default,
            })
        );
        assert_eq!(
            parse(r#"{"action":"open","path":"/a","placement":{"pane":9007199254740991}}"#),
            Ok(Request::Open {
                path: "/a".into(),
                placement: Placement::Pane {
                    pane: PaneId(MAX_PANE_ID),
                },
            })
        );
    }

    #[test]
    fn rejects_malformed_requests_as_invalid_params() {
        for text in [
            r#"{"action":"open""#,
            r#"{"action":"layout","extra":1}"#,
            r#"{"action":"open","path":"/a","workspace":1}"#,
            r#"{"action":"open","path":"/a","placement":{"pane":1,"extra":1}}"#,
            r#"{"action":"open","path":"/a","placement":{"pane":1,"split":{"pane":1,"direction":"right"}}}"#,
            r#"{"action":"open","path":"/a","placement":{}}"#,
            r#"{"action":"open","path":"/a","placement":{"pane":0}}"#,
            r#"{"action":"open","path":"/a","placement":{"pane":-1}}"#,
            r#"{"action":"open","path":"/a","placement":{"pane":1.5}}"#,
            r#"{"action":"open","path":"/a","placement":{"pane":9007199254740992}}"#,
            r#"{"action":"open","path":"/a","placement":{"split":{"pane":1,"direction":"left"}}}"#,
            r#"{"action":"open"}"#,
            r#"{"action":"open","path":"relative.md"}"#,
            r#"{"action":"diff"}"#,
            r#"{"action":"diff","path":"repo"}"#,
            r#"{"action":"layout","path":"/a"}"#,
            r#"{"action":"close"}"#,
        ] {
            assert_eq!(parse_code(text), ErrorCode::InvalidParams, "{text}");
        }
    }

    #[test]
    fn resolves_absolute_and_cwd_relative_paths_by_folding_dot_segments() {
        let linux = PathRules::Linux;
        assert_eq!(resolve_path("/a/b.md", None, linux), Ok("/a/b.md".into()));
        assert_eq!(
            resolve_path("c/d.md", Some("/work"), linux),
            Ok("/work/c/d.md".into())
        );
        assert_eq!(
            resolve_path("./c", Some("/work"), linux),
            Ok("/work/c".into())
        );
        assert_eq!(
            resolve_path("../c", Some("/work/x"), linux),
            Ok("/work/c".into())
        );
        assert_eq!(
            resolve_path("../../../../c", Some("/work"), linux),
            Ok("/c".into())
        );
        assert_eq!(resolve_path("..", Some("/"), linux), Ok("/".into()));
        assert_eq!(resolve_path("/a//b/./c/", None, linux), Ok("/a/b/c".into()));
        assert_eq!(resolve_path("/", None, linux), Ok("/".into()));
    }

    #[test]
    fn keeps_spaces_and_hangul_in_components() {
        assert_eq!(
            resolve_path(
                "문서 메모.md",
                Some("/home/세진/work dir"),
                PathRules::Linux
            ),
            Ok("/home/세진/work dir/문서 메모.md".into())
        );
    }

    #[test]
    fn refuses_relative_paths_without_a_usable_cwd() {
        for (path, cwd) in [
            ("a.md", None),
            ("", Some("/work")),
            ("a.md", Some("work")),
            ("a.md", Some("")),
        ] {
            assert_eq!(
                resolve_path(path, cwd, PathRules::Linux).unwrap_err().code,
                ErrorCode::InvalidPath,
                "{path:?} {cwd:?}"
            );
        }
    }

    #[test]
    fn judges_nul_backslash_and_colon_by_each_rule_set() {
        let linux = PathRules::Linux;
        let native = PathRules::Native;
        for rules in [linux, native] {
            assert!(resolve_path("/a\0b", None, rules).is_err());
            assert!(resolve_path("a", Some("/w\0"), rules).is_err());
        }
        for path in ["/a\\b", "/a:b", "/a/file.md:stream", "/a/b."] {
            assert!(resolve_path(path, None, linux).is_err(), "{path}");
        }
        assert!(resolve_path("\\\\server\\share", Some("/w"), linux).is_err());
        for path in ["/a\\b", "/a:b", "/Users/세진/a:b", "/tmp/trailing. "] {
            assert_eq!(resolve_path(path, None, native), Ok(path.into()), "{path}");
        }
    }

    #[test]
    fn native_paths_are_folded_before_the_dot_segment_check() {
        assert_eq!(
            resolve_path("/Users/me/../you/./f", None, PathRules::Native),
            Ok("/Users/you/f".into())
        );
    }

    #[test]
    fn open_picks_the_viewer_from_the_kind_and_the_markdown_extension() {
        assert_eq!(
            open_viewer("/r", Kind::Directory),
            Ok(ViewerSpec::FolderBrowser { path: "/r".into() })
        );
        assert_eq!(
            open_viewer("/r/a.md", Kind::File),
            Ok(ViewerSpec::MarkdownViewer {
                path: "/r/a.md".into()
            })
        );
        assert_eq!(
            open_viewer("/r/A.MD", Kind::File),
            Ok(ViewerSpec::MarkdownViewer {
                path: "/r/A.MD".into()
            })
        );
        assert_eq!(
            open_viewer("/r/a.txt", Kind::File),
            Ok(ViewerSpec::TextViewer {
                path: "/r/a.txt".into()
            })
        );
        assert_eq!(
            open_viewer("/r/Makefile", Kind::File),
            Ok(ViewerSpec::TextViewer {
                path: "/r/Makefile".into()
            })
        );
        assert_eq!(
            open_viewer("/dev/tty", Kind::Other).unwrap_err().code,
            ErrorCode::InvalidPath
        );
    }

    #[test]
    fn diff_looks_up_the_parent_of_a_file_and_the_directory_itself() {
        assert_eq!(
            diff_lookup_dir("/r/src/a.ts", Kind::File),
            Ok("/r/src".into())
        );
        assert_eq!(diff_lookup_dir("/a.ts", Kind::File), Ok("/".into()));
        assert_eq!(
            diff_lookup_dir("/r/src", Kind::Directory),
            Ok("/r/src".into())
        );
        assert_eq!(
            diff_lookup_dir("/dev/tty", Kind::Other).unwrap_err().code,
            ErrorCode::InvalidPath
        );
    }

    #[test]
    fn error_codes_are_the_external_strings() {
        for (code, text) in [
            (ErrorCode::InvalidParams, "invalid_params"),
            (ErrorCode::InvalidPath, "invalid_path"),
            (ErrorCode::NotFound, "not_found"),
            (ErrorCode::NotRepository, "not_repository"),
            (ErrorCode::UnknownTarget, "unknown_target"),
            (ErrorCode::Busy, "busy"),
            (ErrorCode::Timeout, "timeout"),
            (ErrorCode::TooLarge, "too_large"),
            (ErrorCode::IoError, "io_error"),
        ] {
            assert_eq!(code.as_str(), text);
        }
    }

    #[test]
    fn replies_use_the_result_and_error_envelopes() {
        let ok: serde_json::Value = serde_json::from_str(&encode_result(&"/a")).unwrap();
        assert_eq!(ok, json!({ "result": "/a" }));
        let error = PresentationError::new(ErrorCode::InvalidPath, "path must be absolute");
        let envelope: serde_json::Value = serde_json::from_str(&encode_error(&error)).unwrap();
        assert_eq!(
            envelope,
            json!({ "error": { "code": "invalid_path", "message": "path must be absolute" } })
        );
    }
}
