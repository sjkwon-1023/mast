//! WSL 경로 형태 검증 + `\\wsl.localhost` UNC 매핑 (21단계 계획 core 계약).
//!
//! 뷰어 탭(folderBrowser·textViewer)의 파일 접근은 Windows 쪽 Rust 가
//! `\\wsl.localhost\<distro>\...` UNC 경로로 수행한다 — Windows→WSL 방향이라
//! interop 을 잠근 배포판에서도 동작한다 (계획 v2 5장). 이 모듈은 그 매핑의
//! **형태 계약**만 담당하는 순수 함수 모음이다: 파일 실존·권한은 확인하지 않고
//! (코어 무 I/O), 없는 경로는 뷰 로드 실패로 표면화한다.
//!
//! 역방향([`from_windows_path`])도 여기 둔다 — Windows 네이티브 폴더 선택
//! 대화상자가 돌려준 경로를 워크스페이스의 리눅스 `root_path`·`distro` 로
//! 되돌리는 순수 함수로, 아래 거부 규칙을 그대로 재사용한다.
//!
//! # 거부 규칙
//!
//! [`validate_linux_path`] 는 "사용자가 의도한 것과 다른 Windows 경로가
//! 조립되는 것"을 막는다. 거부 사유와 근거:
//!
//! - **비절대 경로** — 기준 디렉터리가 없어 조립 결과가 정의되지 않는다.
//! - **NUL** — Win32 문자열이 조기 절단돼 다른 경로를 가리킨다.
//! - **백슬래시** — UNC 구분자 밀수. `/a\..\..\Windows` 는 리눅스에선 파일명
//!   하나지만 조립 후 Windows 에서는 공유 루트 밖으로 나간다.
//! - **`.` / `..` 컴포넌트** — 위와 같은 이유의 정공법 버전.
//! - **`:` 를 포함한 컴포넌트** — Windows 가 대체 데이터 스트림(`file:stream`)·
//!   드라이브 지정으로 해석한다.
//! - **점·공백으로 끝나는 컴포넌트** — Win32 가 조용히 절삭해 다른 파일을
//!   가리키는 alias 가 된다 (`foo.` → `foo`).
//!
//! 빈 세그먼트(`//`·후행 `/`)는 거부하지 않고 **정규화**한다 — POSIX 의미가
//! 같은 표기 차이일 뿐이다.
//!
//! 이 규칙 때문에 `\`·`:`·후행 점/공백을 이름에 가진 리눅스 파일은 뷰어로 열 수
//! 없다 — 밀수 차단을 위한 의도된 희생이다 (계획 21단계 리스크 [low]).
//!
//! # 위협 모델 — 심볼릭 링크
//!
//! 링크 해석은 9P 서버(WSL 쪽)가 하므로 이 검증만으로는 링크가 최종적으로
//! 가리키는 대상을 알 수 없다. 뷰어는 **읽기 전용**이고 대상은 사용자 본인
//! 머신의 자기 배포판이라 "링크를 통한 탈출"은 위협 모델이 아니다. 거부 규칙의
//! 목적은 어디까지나 경로 **조립**이 사용자 의도와 어긋나지 않게 하는 것이다.
//!
//! # 알려진 한계 — 경로 길이
//!
//! `\\wsl.localhost\<distro>\...` 는 MAX_PATH(260) 제약을 받는 API 에서 **약
//! 247자**를 넘으면 실패할 수 있다. verbatim 접두(`\\?\UNC\...`)는 MVP 에서
//! 채택하지 않았다 — verbatim 은 Win32 정규화를 통째로 건너뛰어 위 거부 규칙과
//! 별개의 검증 부담을 만든다. 긴 경로 실패는 뷰 로드 에러로 드러난다.

/// WSL2 파일시스템의 UNC 접두 (Windows 11 / 최신 Windows 10 의 표준 이름).
const UNC_PREFIX: &str = r"\\wsl.localhost";

/// 구버전 이름의 별칭 — 지금도 살아 있어 셸(폴더 선택 대화상자 포함)이 이 형태를
/// 돌려줄 수 있다. 역변환([`from_windows_path`])에서만 받아들이고, 조립([`to_unc`])은
/// 항상 표준 이름을 쓴다.
const UNC_PREFIX_LEGACY: &str = r"\\wsl$";

/// 드라이브 문자가 WSL 안에서 마운트되는 위치 — WSL 기본 automount 설정
/// (`/mnt/<letter>`)을 전제한다. `/etc/wsl.conf` 로 root 를 바꾼 사용자에게는
/// 어긋날 수 있고, 그 경우 조립된 경로가 존재하지 않는 것으로 드러난다
/// (코어 무 I/O — 여기서는 확인하지 않는다).
const DRIVE_MOUNT_ROOT: &str = "/mnt";

/// 리눅스 절대 경로의 형태를 검증한다. 실패 시 사람이 읽을 사유 문자열
/// (`CommandError::InvalidPath` 의 message 로 그대로 실린다).
///
/// 규칙과 근거는 모듈 rustdoc 참조. 통과한 경로는 [`to_unc`] 로 안전하게 조립할
/// 수 있다는 뜻이고, 그 경로가 **존재한다는 뜻은 아니다**.
pub fn validate_linux_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err(format!("path must be absolute: {path:?}"));
    }
    if path.contains('\0') {
        return Err("path must not contain a NUL byte".to_owned());
    }
    if path.contains('\\') {
        return Err(format!(
            "path must not contain a backslash (Windows separator): {path:?}"
        ));
    }
    for component in path.split('/') {
        // 빈 세그먼트는 정규화 대상 — `//` 와 후행 `/` 를 거부하지 않는다.
        if component.is_empty() {
            continue;
        }
        if component == "." || component == ".." {
            return Err(format!(
                "path must not contain a '.' or '..' component: {path:?}"
            ));
        }
        if component.contains(':') {
            return Err(format!(
                "path component must not contain ':' (Windows stream syntax): {component:?}"
            ));
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return Err(format!(
                "path component must not end with a dot or space (Win32 truncates it): {component:?}"
            ));
        }
    }
    Ok(())
}

/// 검증된 리눅스 절대 경로를 `\\wsl.localhost\<distro>\...` UNC 로 조립한다.
///
/// `distro` 도 검증한다 — 빈 문자열·`/`·`\`·NUL 은 공유 이름 자리를 벗어나므로
/// 거부한다. 빈 세그먼트는 여기서 정규화되고, 루트(`"/"`)는 공유 루트 자체를
/// 가리키는 `\\wsl.localhost\<distro>\` 가 된다 (후행 구분자를 남긴다 —
/// 공유 루트를 디렉터리로 여는 Win32 관례).
pub fn to_unc(distro: &str, linux_path: &str) -> Result<String, String> {
    validate_distro(distro)?;
    validate_linux_path(linux_path)?;
    let mut unc = format!(r"{UNC_PREFIX}\{distro}");
    let mut any = false;
    for component in linux_path.split('/').filter(|c| !c.is_empty()) {
        unc.push('\\');
        unc.push_str(component);
        any = true;
    }
    if !any {
        unc.push('\\');
    }
    Ok(unc)
}

/// Windows 경로 → (distro, 리눅스 절대 경로) 역변환 — [`to_unc`] 의 반대 방향.
///
/// Windows 네이티브 폴더 선택 대화상자가 돌려주는 경로를 워크스페이스
/// `root_path`·`distro` 로 바꾸는 순수 함수다 (글루가 호출, 코어 무 I/O —
/// 실존 여부는 확인하지 않는다).
///
/// 받아들이는 형태:
///
/// - `\\wsl.localhost\<distro>\p...` · `\\wsl$\<distro>\p...` →
///   `(Some(distro), "/p...")`. 접두 비교는 대소문자 무시(공유 이름 규칙),
///   distro 는 원문 그대로 보존한다.
/// - 드라이브 경로 `C:\p...` → `(None, "/mnt/c/p...")` — 드라이브 문자는
///   소문자로 접는다 (WSL automount 관례). distro 는 이 경로에서 알 수 없으므로
///   None 이고, 호출자가 기본 배포판 해석을 맡는다.
///
/// 거부하는 형태(전부 명확한 사유 문자열): 그 외 UNC(네트워크 공유 — 리눅스
/// 경로로 옮길 수 없다), 상대 경로·드라이브 상대 경로(`C:sub`), distro 이름이
/// 없는 WSL UNC. 조립된 리눅스 경로는 마지막에 [`validate_linux_path`] 로
/// 재검증하므로, 여기를 통과한 값은 그대로 [`to_unc`] 에 되먹일 수 있다.
///
/// `/` 는 `\` 와 동등한 구분자로 취급한다 (Win32 규칙) — 셸이 어느 쪽을 주든
/// 같은 결과가 나온다.
pub fn from_windows_path(path: &str) -> Result<(Option<String>, String), String> {
    let normalized = path.replace('/', "\\");
    let (distro, linux) = if let Some(rest) = strip_wsl_unc(&normalized) {
        // rest = `<distro>` 또는 `<distro>\p\...`.
        let (distro, tail) = rest.split_once('\\').unwrap_or((rest, ""));
        if distro.is_empty() {
            return Err(format!("WSL UNC path has no distro name: {path:?}"));
        }
        validate_distro(distro)?;
        (Some(distro.to_owned()), join_linux("", tail))
    } else if normalized.starts_with(r"\\") {
        // WSL 이 아닌 UNC — 네트워크 공유·`\\?\` verbatim 등. 리눅스 경로로
        // 옮길 대응이 없으므로 조용히 추측하지 않고 거부한다.
        return Err(format!(
            "only \\\\wsl.localhost or \\\\wsl$ UNC paths can be mapped to a WSL path: {path:?}"
        ));
    } else if let Some((letter, tail)) = strip_drive(&normalized) {
        (None, join_linux(&format!("{DRIVE_MOUNT_ROOT}/{letter}"), tail))
    } else {
        return Err(format!(
            "not an absolute Windows path (expected 'C:\\dir' or \
             '\\\\wsl.localhost\\<distro>\\dir'): {path:?}"
        ));
    };
    // 조립 결과는 코어의 다른 경로 소비자(뷰어 탭·터미널 cwd)와 같은 규칙을
    // 통과해야 한다 — 여기서 거르지 않으면 밀수 가드가 이 입구에만 없는
    // 비대칭이 된다.
    validate_linux_path(&linux)?;
    Ok((distro, linux))
}

/// WSL UNC 접두를 떼고 나머지(`<distro>[\...]`)를 돌려준다. 접두 바로 뒤는
/// 구분자이거나 문자열 끝이어야 한다 — `\\wsl.localhostx\...` 같은 다른 호스트가
/// 접두 매칭에 걸리지 않게 한다.
fn strip_wsl_unc(path: &str) -> Option<&str> {
    for prefix in [UNC_PREFIX, UNC_PREFIX_LEGACY] {
        // 접두는 ASCII 지만 path 는 아닐 수 있다 — 슬라이스 대신 get 으로
        // 문자 경계를 안전하게 처리한다.
        if !path
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        {
            continue;
        }
        let rest = &path[prefix.len()..];
        if rest.is_empty() {
            return Some(rest); // 접두 단독 — 호출자가 "distro 없음"으로 거부
        }
        if let Some(rest) = rest.strip_prefix('\\') {
            return Some(rest);
        }
    }
    None
}

/// `C:\p...` 의 (소문자 드라이브 문자, 꼬리). 드라이브 상대 경로(`C:sub`)와
/// 드라이브 지정만 있는 `C:` 는 절대 경로가 아니므로 None 이다.
fn strip_drive(path: &str) -> Option<(char, &str)> {
    let mut chars = path.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }
    let tail = path[2..].strip_prefix('\\')?;
    Some((letter.to_ascii_lowercase(), tail))
}

/// Windows 경로 꼬리(`\` 구분)를 `prefix` 뒤에 리눅스 표기로 잇는다. 빈
/// 세그먼트(중복·후행 구분자)는 [`to_unc`] 와 대칭으로 접고, 남는 것이 없으면
/// prefix 그대로다 — prefix 까지 비어 있으면 루트(`"/"`).
fn join_linux(prefix: &str, tail: &str) -> String {
    let mut out = prefix.to_owned();
    for component in tail.split('\\').filter(|c| !c.is_empty()) {
        out.push('/');
        out.push_str(component);
    }
    if out.is_empty() {
        "/".to_owned()
    } else {
        out
    }
}

/// UNC 의 공유 이름 자리에 그대로 들어가는 값이라 구분자·NUL·빈 이름을 거부하고,
/// 경로 컴포넌트와 같은 규칙(`.`/`..`, `:`, 후행 점·공백)도 적용한다 — 출처가
/// 본인 설정(env·워크스페이스 필드)이라 위협은 아니지만, 밀수 가드의 커버리지가
/// 경로에만 있고 공유 이름에는 없는 비대칭을 남기지 않는다 (21단계 리뷰 finding).
fn validate_distro(distro: &str) -> Result<(), String> {
    if distro.is_empty() {
        return Err("distro must not be empty".to_owned());
    }
    if distro.contains('/') || distro.contains('\\') || distro.contains('\0') {
        return Err(format!(
            "distro must not contain '/', '\\' or a NUL byte: {distro:?}"
        ));
    }
    if distro == "." || distro == ".." {
        return Err(format!("distro must not be a dot component: {distro:?}"));
    }
    if distro.contains(':') {
        return Err(format!("distro must not contain ':': {distro:?}"));
    }
    if distro.ends_with('.') || distro.ends_with(' ') {
        return Err(format!(
            "distro must not end with a dot or a space (Win32 trims them): {distro:?}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_absolute_paths() {
        for path in [
            "/",
            "/home",
            "/home/dev/code/mast",
            "/home/dev/my proj/notes.txt",
            // 컴포넌트 안(끝이 아닌 곳)의 점·공백, 한글·유니코드 이름은 정상.
            "/home/dev/.config/mast/state.json",
            "/home/dev/보고서 초안.md",
        ] {
            assert_eq!(validate_linux_path(path), Ok(()), "거부됨: {path}");
        }
    }

    #[test]
    fn normalizes_empty_segments_instead_of_rejecting() {
        // POSIX 의미가 같은 표기 차이 — 검증은 통과하고 조립에서 접힌다.
        for path in ["//home//dev/", "/home/dev/", "///"] {
            assert_eq!(validate_linux_path(path), Ok(()), "거부됨: {path}");
        }
        assert_eq!(
            to_unc("Ubuntu", "//home//dev/").unwrap(),
            r"\\wsl.localhost\Ubuntu\home\dev"
        );
        assert_eq!(
            to_unc("Ubuntu", "///").unwrap(),
            r"\\wsl.localhost\Ubuntu\"
        );
    }

    #[test]
    fn rejects_relative_paths() {
        for path in ["", "home/dev", "./x", "../x", "~/code"] {
            let err = validate_linux_path(path).unwrap_err();
            assert!(err.contains("absolute"), "{path:?} → {err}");
        }
    }

    #[test]
    fn rejects_nul_byte() {
        let err = validate_linux_path("/home/dev\0/x").unwrap_err();
        assert!(err.contains("NUL"), "{err}");
    }

    #[test]
    fn rejects_backslash_anywhere() {
        // UNC 구분자 밀수 — 리눅스에선 파일명 한 글자지만 조립 후엔 경로가 된다.
        for path in [r"/home\dev", r"/a\..\..\Windows", r"/trailing\"] {
            let err = validate_linux_path(path).unwrap_err();
            assert!(err.contains("backslash"), "{path:?} → {err}");
        }
    }

    #[test]
    fn rejects_dot_components() {
        for path in ["/home/./dev", "/home/../etc", "/..", "/home/dev/.."] {
            let err = validate_linux_path(path).unwrap_err();
            assert!(err.contains("'.' or '..'"), "{path:?} → {err}");
        }
        // 이름의 **일부**인 점은 이 규칙의 대상이 아니다 — 컴포넌트 전체가
        // `.`/`..` 일 때만 거부한다 (`..hidden` 은 후행 점도 없어 통과).
        assert_eq!(validate_linux_path("/home/..hidden"), Ok(()));
    }

    #[test]
    fn rejects_colon_in_component() {
        // Windows 의 대체 데이터 스트림 문법.
        let err = validate_linux_path("/home/dev/file:stream").unwrap_err();
        assert!(err.contains("':'"), "{err}");
        let err = validate_linux_path("/C:/Windows").unwrap_err();
        assert!(err.contains("':'"), "{err}");
    }

    #[test]
    fn rejects_trailing_dot_or_space_components() {
        // Win32 가 조용히 절삭해 다른 파일의 alias 가 되는 형태.
        for path in ["/home/dev/foo.", "/home/dev /x", "/home/dev/foo "] {
            let err = validate_linux_path(path).unwrap_err();
            assert!(err.contains("dot or space"), "{path:?} → {err}");
        }
    }

    #[test]
    fn to_unc_assembles_share_path() {
        assert_eq!(
            to_unc("Ubuntu-24.04", "/home/dev/code/mast").unwrap(),
            r"\\wsl.localhost\Ubuntu-24.04\home\dev\code\mast"
        );
        // 루트는 공유 루트 자체 — 후행 구분자를 남긴다.
        assert_eq!(to_unc("Ubuntu", "/").unwrap(), r"\\wsl.localhost\Ubuntu\");
        // 공백을 포함한 이름은 그대로 (인용은 호출자·API 몫이 아니라 불필요).
        assert_eq!(
            to_unc("Ubuntu", "/home/my proj/a.txt").unwrap(),
            r"\\wsl.localhost\Ubuntu\home\my proj\a.txt"
        );
    }

    #[test]
    fn to_unc_rejects_bad_distro() {
        // 경로 컴포넌트와 같은 밀수 가드를 공유 이름에도 적용한다 (커버리지 대칭).
        for distro in [
            "",
            "Ubuntu/x",
            r"Ubuntu\x",
            "Ubu\0ntu",
            ".",
            "..",
            "Ubuntu:22",
            "Ubuntu.",
            "Ubuntu ",
        ] {
            let err = to_unc(distro, "/home").unwrap_err();
            assert!(err.contains("distro"), "{distro:?} → {err}");
        }
    }

    #[test]
    fn to_unc_propagates_path_rejection() {
        let err = to_unc("Ubuntu", "home/dev").unwrap_err();
        assert!(err.contains("absolute"), "{err}");
    }

    // ---- 역변환 (폴더 선택 대화상자 → 워크스페이스 root_path·distro) ----

    /// 테스트 가독용 — (distro, path) 를 소유 문자열 쌍으로 편다.
    fn from_win(path: &str) -> (Option<String>, String) {
        from_windows_path(path).unwrap_or_else(|e| panic!("{path:?} 거부됨: {e}"))
    }

    #[test]
    fn maps_wsl_unc_to_distro_and_linux_path() {
        assert_eq!(
            from_win(r"\\wsl.localhost\Ubuntu-24.04\home\dev\code\mast"),
            (Some("Ubuntu-24.04".to_owned()), "/home/dev/code/mast".to_owned())
        );
        // 구 별칭도 같은 결과 (셸이 어느 이름을 주든 무관).
        assert_eq!(
            from_win(r"\\wsl$\Ubuntu\home\dev"),
            (Some("Ubuntu".to_owned()), "/home/dev".to_owned())
        );
        // 호스트 이름은 대소문자 무시, distro 이름은 원문 보존.
        assert_eq!(
            from_win(r"\\WSL.LOCALHOST\Ubuntu\home"),
            (Some("Ubuntu".to_owned()), "/home".to_owned())
        );
        // Win32 는 '/' 도 구분자로 받는다.
        assert_eq!(
            from_win(r"\\wsl.localhost\Ubuntu/home/dev"),
            (Some("Ubuntu".to_owned()), "/home/dev".to_owned())
        );
    }

    #[test]
    fn maps_drive_letters_to_the_automount_root() {
        assert_eq!(
            from_win(r"C:\Users\dev\project"),
            (None, "/mnt/c/Users/dev/project".to_owned())
        );
        // 소문자 드라이브도 같은 결과 — 문자는 소문자로 접는다.
        assert_eq!(from_win(r"d:\data"), (None, "/mnt/d/data".to_owned()));
        assert_eq!(from_win(r"D:\data"), (None, "/mnt/d/data".to_owned()));
    }

    #[test]
    fn maps_roots_and_folds_empty_segments() {
        // 공유 루트 = 배포판의 리눅스 루트.
        assert_eq!(
            from_win(r"\\wsl.localhost\Ubuntu"),
            (Some("Ubuntu".to_owned()), "/".to_owned())
        );
        assert_eq!(
            from_win(r"\\wsl.localhost\Ubuntu\"),
            (Some("Ubuntu".to_owned()), "/".to_owned())
        );
        // 드라이브 루트 — 후행 구분자를 남기지 않는다 (to_unc 로 되먹여도 동일).
        assert_eq!(from_win(r"C:\"), (None, "/mnt/c".to_owned()));
        assert_eq!(
            from_win(r"\\wsl.localhost\Ubuntu\home\\dev\"),
            (Some("Ubuntu".to_owned()), "/home/dev".to_owned())
        );
    }

    #[test]
    fn keeps_spaces_inside_path_components() {
        assert_eq!(
            from_win(r"C:\Users\my name\my proj"),
            (None, "/mnt/c/Users/my name/my proj".to_owned())
        );
        assert_eq!(
            from_win(r"\\wsl.localhost\Ubuntu\home\dev\보고서 초안"),
            (Some("Ubuntu".to_owned()), "/home/dev/보고서 초안".to_owned())
        );
    }

    #[test]
    fn round_trips_through_to_unc() {
        let (distro, path) = from_win(r"\\wsl.localhost\Ubuntu\home\dev\code");
        assert_eq!(
            to_unc(&distro.unwrap(), &path).unwrap(),
            r"\\wsl.localhost\Ubuntu\home\dev\code"
        );
    }

    #[test]
    fn rejects_relative_and_drive_relative_paths() {
        // 빈 문자열·공백뿐인 값·상대 경로·드라이브 상대 경로는 전부 절대가 아니다.
        for path in ["", "   ", r"home\dev", r"C:sub\dir", "C:", r"\etc", "/home/dev"] {
            let err = from_windows_path(path).unwrap_err();
            assert!(err.contains("absolute Windows path"), "{path:?} → {err}");
        }
    }

    #[test]
    fn rejects_non_wsl_unc_paths() {
        for path in [
            r"\\server\share\dir",
            r"\\?\C:\dir",
            r"\\wsl.localhostx\Ubuntu\home",
        ] {
            let err = from_windows_path(path).unwrap_err();
            assert!(err.contains("wsl.localhost"), "{path:?} → {err}");
        }
    }

    #[test]
    fn rejects_wsl_unc_without_a_distro() {
        for path in [r"\\wsl.localhost", r"\\wsl.localhost\", r"\\wsl$\"] {
            let err = from_windows_path(path).unwrap_err();
            assert!(err.contains("no distro name"), "{path:?} → {err}");
        }
        // 공유 이름 자리의 밀수 가드는 to_unc 와 같은 함수를 탄다.
        let err = from_windows_path(r"\\wsl.localhost\Ubu:ntu\home").unwrap_err();
        assert!(err.contains("distro"), "{err}");
    }

    #[test]
    fn revalidates_the_assembled_linux_path() {
        // 조립 결과가 코어의 경로 규칙을 어기면 여기서 걸린다 (밀수 가드 대칭).
        let err = from_windows_path(r"\\wsl.localhost\Ubuntu\home\..\etc").unwrap_err();
        assert!(err.contains("'.' or '..'"), "{err}");
        let err = from_windows_path("C:\\dir\0\\x").unwrap_err();
        assert!(err.contains("NUL"), "{err}");
        // Win32 가 절삭하는 후행 점·공백 컴포넌트도 통과시키지 않는다.
        let err = from_windows_path(r"C:\Users\dev.\x").unwrap_err();
        assert!(err.contains("dot or space"), "{err}");
    }
}
