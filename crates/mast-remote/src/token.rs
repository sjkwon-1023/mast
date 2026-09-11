//! 페어링 토큰 — 생성·파일 로딩·상수 시간 비교.
//!
//! 토큰 파일은 `state.json` 옆(`<app_data_dir>/remote-token`)에 살고, 원격이 꺼져 있으면
//! 아무도 이 모듈을 부르지 않아 파일도 생기지 않는다(ADR-0016 결정 1).

use std::fmt;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;

/// 원시 토큰 바이트 수. 32B CSPRNG → base64url 무패딩 43자.
const TOKEN_BYTES: usize = 32;
/// 인코딩된 토큰의 길이. 파일에서 읽은 값을 이 길이로 먼저 거른다.
const TOKEN_CHARS: usize = 43;

#[derive(Debug)]
pub enum TokenError {
    Io(std::io::Error),
    /// 파일은 있는데 토큰으로 쓸 수 없다.
    Corrupt,
    /// CSPRNG 가 바이트를 주지 않았다. 약한 대체값으로 토큰을 만들지 않으므로 원격은
    /// 켜지지 않는다 — 부팅 자체는 계속된다 (글루가 `Failed` 로 보고).
    Entropy(getrandom::Error),
}

impl fmt::Display for TokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TokenError::Io(e) => write!(f, "failed to read the remote token: {e}"),
            TokenError::Corrupt => {
                write!(f, "remote-token is corrupt; delete it to regenerate")
            }
            TokenError::Entropy(e) => write!(f, "cannot draw a remote token: {e}"),
        }
    }
}

impl std::error::Error for TokenError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            TokenError::Io(e) => Some(e),
            TokenError::Corrupt | TokenError::Entropy(_) => None,
        }
    }
}

/// 토큰 파일을 읽고, 없으면 만든다.
///
/// 재부팅마다 재페어링을 강요하지 않으려고 기존 값을 그대로 재사용한다. 대신 **읽을 때
/// 검증**한다: 빈 파일·잘린 파일·다른 알파벳이 그대로 인증 비밀이 되면 추측 가능한 토큰으로
/// 원격이 열린다. 검증에 실패해도 **다시 만들지 않는다** — 조용히 재생성하면 이미 페어링한
/// 폰이 이유 없이 401 을 받고, 파일이 왜 깨졌는지(디스크·동기화 도구·수동 편집)도 묻히기
/// 때문이다. 사용자가 파일을 지우는 것이 재발급 절차다(ADR-0016 결정 9).
///
/// 생성은 원자적이다: 같은 디렉터리의 `<파일>.tmp` 에 쓰고 rename 한다. 부팅 중 죽어도
/// 반쯤 쓰인 파일이 다음 부팅의 토큰이 되지 않는다.
pub fn load_or_create_token(path: &Path) -> Result<String, TokenError> {
    match std::fs::read(path) {
        Ok(raw) => {
            let text = std::str::from_utf8(&raw).map_err(|_| TokenError::Corrupt)?;
            let trimmed = text.trim();
            if !is_valid_token(trimmed) {
                return Err(TokenError::Corrupt);
            }
            Ok(trimmed.to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let token = generate_token()?;
            let tmp = tmp_path(path);
            write_private(&tmp, token.as_bytes()).map_err(TokenError::Io)?;
            if let Err(e) = std::fs::rename(&tmp, path) {
                // 남은 tmp 는 다음 시도의 쓰기가 덮어쓰지만, 실패한 부팅이 파일을 흘리고
                // 가지 않게 지운다.
                let _ = std::fs::remove_file(&tmp);
                return Err(TokenError::Io(e));
            }
            Ok(token)
        }
        Err(e) => Err(TokenError::Io(e)),
    }
}

/// 32B CSPRNG → base64url 무패딩 43자.
///
/// 엔트로피를 못 얻은 자리에서 약한 대체값(시각·pid)으로 토큰을 만들면 원격이 열린 채
/// 추측 가능해지므로 대체 경로는 없다 — 실패는 [`TokenError::Entropy`] 로 돌려주고
/// 원격만 켜지지 않는다.
pub(crate) fn generate_token() -> Result<String, TokenError> {
    let mut raw = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut raw).map_err(TokenError::Entropy)?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

/// 토큰 파일 쓰기. unix 에서는 소유자만 읽게(0600) 만든다 — 개발기의 홈은 다른 계정이
/// 읽을 수 있고, 이 파일 하나가 원격 입력 권한이다. Windows 는 `%AppData%` 의 ACL 을
/// 상속하므로 별도 처리가 없다.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

/// 상수 시간 비교. **길이가 같은 경우에 대해서만** 상수 시간이다 — 길이가 다르면 즉시
/// false 이고, 토큰 길이(43)는 공개된 값이라 그것으로 새어 나갈 정보가 없다.
pub(crate) fn token_matches(expected: &str, given: &str) -> bool {
    let (expected, given) = (expected.as_bytes(), given.as_bytes());
    if expected.len() != given.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(given.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn is_valid_token(candidate: &str) -> bool {
    if candidate.len() != TOKEN_CHARS {
        return false;
    }
    if !candidate
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return false;
    }
    // 알파벳·길이가 맞아도 실제로 32바이트로 풀리는지까지 본다 — 우리가 쓴 값이라면 반드시
    // 통과한다.
    matches!(URL_SAFE_NO_PAD.decode(candidate), Ok(bytes) if bytes.len() == TOKEN_BYTES)
}

/// `with_extension` 을 쓰지 않는다 — 그것은 확장자를 **교체**하므로 파일 이름 규칙이
/// 바뀌면 엉뚱한 경로가 나온다. 이름 뒤에 `.tmp` 를 붙여 같은 디렉터리에 두는 것이
/// rename 이 원자적이기 위한 조건이기도 하다.
fn tmp_path(path: &Path) -> PathBuf {
    let mut raw = path.as_os_str().to_os_string();
    raw.push(".tmp");
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_token_is_43_url_safe_characters() {
        let token = generate_token().unwrap();
        assert_eq!(token.len(), TOKEN_CHARS);
        assert!(token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')));
        assert_eq!(
            URL_SAFE_NO_PAD.decode(&token).unwrap().len(),
            TOKEN_BYTES,
            "43자가 32바이트로 풀려야 한다"
        );
    }

    #[test]
    fn two_generated_tokens_differ() {
        assert_ne!(generate_token().unwrap(), generate_token().unwrap());
    }

    #[test]
    fn load_or_create_creates_then_reuses_the_same_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-token");

        let first = load_or_create_token(&path).unwrap();
        assert!(is_valid_token(&first));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
        assert!(
            !tmp_path(&path).exists(),
            "생성 뒤 .tmp 가 남아 있으면 안 된다"
        );

        let second = load_or_create_token(&path).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn a_trailing_newline_in_the_file_is_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-token");
        let token = generate_token().unwrap();
        std::fs::write(&path, format!("{token}\r\n")).unwrap();

        assert_eq!(load_or_create_token(&path).unwrap(), token);
    }

    #[test]
    fn an_empty_or_truncated_file_is_corrupt_not_regenerated() {
        let dir = tempfile::tempdir().unwrap();
        for (name, content) in [
            ("empty", String::new()),
            ("blank", "\n".to_string()),
            ("truncated", generate_token().unwrap()[..20].to_string()),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, &content).unwrap();

            assert!(
                matches!(load_or_create_token(&path), Err(TokenError::Corrupt)),
                "{name} 은 Corrupt 여야 한다"
            );
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                content,
                "{name} 이 조용히 재생성됐다"
            );
        }
    }

    #[test]
    fn a_file_with_a_non_base64url_byte_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-token");
        // 길이는 43 이지만 표준 base64 의 `+` `/` 는 url-safe 알파벳이 아니다.
        let token = generate_token().unwrap();
        let tampered = format!("+/{}", &token[2..]);
        assert_eq!(tampered.len(), TOKEN_CHARS);
        std::fs::write(&path, &tampered).unwrap();

        assert!(matches!(
            load_or_create_token(&path),
            Err(TokenError::Corrupt)
        ));
    }

    #[test]
    fn constant_time_compare_accepts_only_an_exact_match() {
        let token = generate_token().unwrap();
        assert!(token_matches(&token, &token));

        let mut wrong = token.clone().into_bytes();
        wrong[42] = if wrong[42] == b'A' { b'B' } else { b'A' };
        let wrong = String::from_utf8(wrong).unwrap();
        assert!(!token_matches(&token, &wrong));

        let mut wrong_first = token.clone().into_bytes();
        wrong_first[0] = if wrong_first[0] == b'A' { b'B' } else { b'A' };
        assert!(!token_matches(
            &token,
            &String::from_utf8(wrong_first).unwrap()
        ));
    }

    #[test]
    fn constant_time_compare_rejects_a_length_mismatch() {
        let token = generate_token().unwrap();
        assert!(!token_matches(&token, &token[..42]));
        assert!(!token_matches(&token, &format!("{token}x")));
        assert!(!token_matches(&token, ""));
    }
}
