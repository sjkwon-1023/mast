//! 에이전트용 pane 간 텍스트 전송 채널의 순수 규약 — base64 페이로드 디코드와
//! 실패 종류 (스킬 문서: `scripts/wsl/skills/mast-send/SKILL.md`).
//!
//! 전송 요청은 [`OscEvent::Osc777Send`](crate::osc::OscEvent::Osc777Send) 로 도착한다:
//! `ESC ] 777 ; mast-send ; <target> ; <base64> BEL`. 이 모듈은 그중 payload 를
//! 바이트로 되돌리는 순수 함수만 담당하고, 대상 해석은
//! [`Dispatcher::resolve_send_target`](crate::command::Dispatcher::resolve_send_target),
//! 실제 stdin 쓰기는 글루가 한다.
//!
//! 같은 base64 규약을 쓰는 질의 채널([`OscEvent::Osc777Query`](crate::osc::OscEvent::Osc777Query))
//! 의 **회신 경로** 검증([`decode_reply_path`])도 여기 둔다 — 디코더를 재사용하고,
//! 열거 데이터 자체는 [`Dispatcher::list_tabs`](crate::command::Dispatcher::list_tabs)
//! 가 만든다.
//!
//! # 왜 base64 인가
//!
//! OSC payload 는 `;` 로 필드를 나누고 BEL/ST 로 끝난다 — 개행·제어문자·세미콜론이
//! 그대로 들어가면 시퀀스가 깨진다. 전송 텍스트는 **개행을 포함해야 실행되는** 종류의
//! 데이터라, 필드 안에서 안전한 알파벳으로 감싸는 base64 가 유일하게 온전한 방법이다.
//! UTF-8 은 요구하지 않는다 (디코드 결과는 바이트열 그대로 PTY 로 간다).
//!
//! # 크기 상한
//!
//! 디코드 결과는 [`MAX_SEND_BYTES`] 를 넘을 수 없다 — 넘으면 거부하고(loud) 아무것도
//! 쓰지 않는다. OSC 스캐너의 payload 상한(`osc::MAX_PAYLOAD_BYTES` = 64KiB)은 base64
//! 팽창(4/3)을 감안해 이 계약(32KiB)을 온전히 통과시키도록 잡혀 있다 — 스캐너 상한을
//! 넘는 시퀀스는 파서에 닿기 전에 통째로 폐기되므로, 이 검사는 그 아래에서 동작하는
//! 실질 상한이다.
//!
//! # 보안
//!
//! 같은 머신에서 pane 의 PTY 로 바이트를 흘릴 수 있는 어떤 터미널 프로그램이든 이
//! 채널로 다른 pane 에 입력을 넣을 수 있다. 본인 머신·협력 에이전트를 전제한 의도된
//! 기능이며, 상한·유일 매치·자기 제외·워크스페이스 격리가 오발사 가드다 (권한 경계가
//! 아니다).

use std::fmt;

/// 한 번에 전송할 수 있는 **디코드 후** 바이트 상한. 초과는 거부한다 (모듈 doc 의
/// "크기 상한" 참조 — 스캐너 payload 상한이 실효 상한을 더 낮게 잡는다).
pub const MAX_SEND_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendDecodeError {
    /// 표준 알파벳(`A-Za-z0-9+/`, 끝에 `=` 패딩) 밖의 문자거나 길이가 불가능한 값.
    InvalidBase64,
    /// 디코드 결과가 [`MAX_SEND_BYTES`] 초과.
    TooLarge { bytes: usize },
}

impl fmt::Display for SendDecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SendDecodeError::InvalidBase64 => {
                write!(f, "payload is not standard base64")
            }
            SendDecodeError::TooLarge { bytes } => write!(
                f,
                "payload is {bytes} bytes, over the {MAX_SEND_BYTES} byte limit"
            ),
        }
    }
}

impl std::error::Error for SendDecodeError {}

/// 전송 대상 해석 실패
/// ([`Dispatcher::resolve_send_target`](crate::command::Dispatcher::resolve_send_target)).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendTargetError {
    /// 후보 중 대상이 없다 — 제목·`#id` 가 일치하는 running 터미널 탭이 없거나,
    /// 일치하는 탭이 **송신자의 워크스페이스 밖**이라 애초에 후보가 아니었다
    /// (워크스페이스 격리 — `resolve_send_target` 의 같은 이름 절). 자기 자신도
    /// 애초에 제외된다.
    NoMatch,
    /// 둘 이상 일치 — **첫 매치를 고르지 않는다**. 엉뚱한 pane 에 명령이 들어가는
    /// 것보다 아무 데도 안 가는 쪽이 낫다 (오발사 방지).
    Ambiguous { count: usize },
}

impl fmt::Display for SendTargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SendTargetError::NoMatch => {
                write!(f, "no running terminal tab matches the target")
            }
            SendTargetError::Ambiguous { count } => write!(
                f,
                "{count} running terminal tabs match the target; the target must be unique"
            ),
        }
    }
}

impl std::error::Error for SendTargetError {}

/// base64 표준 알파벳 payload 를 바이트로 되돌린다 (순수 함수).
///
/// - 알파벳은 `A-Za-z0-9+/` — URL-safe(`-_`)·공백·개행은 전부 거부한다. `base64 -w0`
///   의 출력 형태 하나만 받는다는 뜻이다 (조용히 다른 인코딩으로 해석하지 않는다).
/// - 끝의 `=` 패딩은 최대 2개까지 허용하고, 패딩이 없어도 받는다. 나머지 길이가
///   4로 나눈 나머지 1이면(불가능한 길이) [`SendDecodeError::InvalidBase64`].
/// - 마지막 그룹의 남는 비트는 무시한다 (비정규 인코딩을 실패로 만들지 않는다).
/// - 빈 문자열은 빈 바이트열이다 — 쓰기가 0 bytes 인 무해한 no-op 이 된다.
/// - 크기 검사는 **디코드 전에** 길이로 판정한다 (거대한 입력을 메모리에 펼치지 않는다).
pub fn decode_send_text(text_b64: &str) -> Result<Vec<u8>, SendDecodeError> {
    let raw = text_b64.as_bytes();
    let mut end = raw.len();
    let mut pad = 0;
    while end > 0 && raw[end - 1] == b'=' && pad < 2 {
        end -= 1;
        pad += 1;
    }
    let body = &raw[..end];
    // 4로 나눈 나머지 1 = 6bit 하나만 남는 길이 — 어떤 바이트도 만들 수 없다.
    let tail = match body.len() % 4 {
        0 => 0,
        2 => 1,
        3 => 2,
        _ => return Err(SendDecodeError::InvalidBase64),
    };
    let out_len = body.len() / 4 * 3 + tail;
    if out_len > MAX_SEND_BYTES {
        return Err(SendDecodeError::TooLarge { bytes: out_len });
    }

    let mut out = Vec::with_capacity(out_len);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in body {
        let digit = decode_digit(b).ok_or(SendDecodeError::InvalidBase64)?;
        acc = (acc << 6) | u32::from(digit);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

/// 회신 파일 경로가 반드시 놓여야 하는 디렉터리 접두. 아래 [`decode_reply_path`]
/// 의 보안 근거 참조.
pub const REPLY_PATH_PREFIX: &str = "/tmp/";

/// 질의 회신 경로([`OscEvent::Osc777Query`](crate::osc::OscEvent::Osc777Query) 의
/// 세 번째 필드) 디코드 실패.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplyPathError {
    /// base64 payload 자체가 불량하다 ([`decode_send_text`] 와 같은 규약).
    Decode(SendDecodeError),
    /// 디코드 결과가 UTF-8 이 아니다. 전송 텍스트와 달리 회신 경로는 **경로 문자열**
    /// 이므로 바이트열을 그대로 받지 않는다.
    NotUtf8,
    /// 리눅스 절대 경로 형태가 불량하다 (사유는 `wslpath::validate_linux_path`).
    InvalidPath(String),
    /// [`REPLY_PATH_PREFIX`] 밖의 경로.
    OutsideTmp,
}

impl fmt::Display for ReplyPathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReplyPathError::Decode(err) => write!(f, "reply path: {err}"),
            ReplyPathError::NotUtf8 => write!(f, "reply path is not valid UTF-8"),
            ReplyPathError::InvalidPath(reason) => write!(f, "reply path: {reason}"),
            ReplyPathError::OutsideTmp => write!(
                f,
                "reply path must start with {REPLY_PATH_PREFIX:?} (only {REPLY_PATH_PREFIX} is writable for replies)"
            ),
        }
    }
}

impl std::error::Error for ReplyPathError {}

/// 질의의 **회신 파일 경로**를 base64 payload 에서 되돌린다 (순수 함수 — I/O 없음).
///
/// 통과 조건은 셋 다 필수다:
///
/// 1. [`decode_send_text`] 와 같은 base64 규약 (표준 알파벳, 상한 재사용).
/// 2. 디코드 결과가 **UTF-8** — 경로 문자열로 쓸 것이므로 바이트열을 받지 않는다.
/// 3. `wslpath::validate_linux_path` 통과 + **`/tmp/` 접두**
///    ([`REPLY_PATH_PREFIX`]).
///
/// # 보안 — 왜 `/tmp/` 로 가두는가
///
/// 회신은 **파일 쓰기**다. 내용은 앱이 만든 메타데이터 JSON 뿐이라 내용 자체로는
/// 위험이 없지만, 경로까지 임의로 열어 주면 이 PTY 에 바이트를 흘릴 수 있는
/// 아무 프로그램이나 `~/.bashrc`·`~/.claude/settings.json` 같은 dotfile 을 이
/// 채널로 **덮어쓸 수 있는 표면**이 된다 (쓰기 시점의 실행 주체는 mast 앱이다).
/// `/tmp/` 한 곳으로 가두면 **문자열 수준의** 그 표면이 임시 디렉터리로 좁혀진다.
/// 접두 검사 앞의 `validate_linux_path` 가 `..`·백슬래시·NUL 을 이미 거부하므로
/// `/tmp/../home/u/.bashrc` 같은 traversal 은 성립하지 않는다. 단 이 검사는
/// 심볼릭 링크를 보지 못한다 — `/tmp/x → $HOME` 같은 링크를 미리 만들면 쓰기가
/// 밖으로 따라간다 (리뷰 finding). 링크까지 막으려면 쓰기 시점 canonicalize 재검사가
/// 필요한데 9P 위 의미론이 실기 미검증이라 넣지 않았다 (CLAUDE.md 백로그) —
/// 심링크 경로는 아래 협력 전제에 맡긴다.
///
/// 이것은 오발사·유탄 방지 가드이며 권한 경계가 아니다 (모듈 doc 의 "보안" 참조 —
/// 같은 머신·협력 에이전트를 전제한다).
pub fn decode_reply_path(reply_b64: &str) -> Result<String, ReplyPathError> {
    let bytes = decode_send_text(reply_b64).map_err(ReplyPathError::Decode)?;
    let path = String::from_utf8(bytes).map_err(|_| ReplyPathError::NotUtf8)?;
    crate::wslpath::validate_linux_path(&path).map_err(ReplyPathError::InvalidPath)?;
    if !path.starts_with(REPLY_PATH_PREFIX) {
        return Err(ReplyPathError::OutsideTmp);
    }
    Ok(path)
}

/// base64 표준 알파벳 1글자 → 6bit 값. 알파벳 밖(패딩 `=` 포함)은 None.
fn decode_digit(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded(b64: &str) -> String {
        String::from_utf8(decode_send_text(b64).expect("decode")).expect("utf8")
    }

    #[test]
    fn decodes_standard_padded_base64() {
        // `printf '%s' 'cargo test' | base64 -w0` 의 결과 형태.
        assert_eq!(decoded("Y2FyZ28gdGVzdA=="), "cargo test");
        assert_eq!(decoded("aGVsbG8="), "hello");
        assert_eq!(decoded("YWJj"), "abc");
    }

    #[test]
    fn decodes_newline_terminated_payload() {
        // 개행이 실려야 대상 셸이 실제로 실행한다 — 왕복이 보존되는지 확인.
        assert_eq!(decoded("Y2FyZ28gdGVzdAo="), "cargo test\n");
    }

    #[test]
    fn decodes_non_utf8_bytes() {
        // UTF-8 은 요구하지 않는다 (바이트열 그대로 전달).
        assert_eq!(decode_send_text("//8A"), Ok(vec![0xff, 0xff, 0x00]));
    }

    #[test]
    fn empty_payload_decodes_to_no_bytes() {
        assert_eq!(decode_send_text(""), Ok(Vec::new()));
    }

    #[test]
    fn padding_is_optional() {
        assert_eq!(decoded("aGVsbG8"), "hello");
        assert_eq!(decoded("Y2FyZ28gdGVzdA"), "cargo test");
    }

    #[test]
    fn rejects_characters_outside_the_standard_alphabet() {
        // URL-safe 알파벳·공백·개행·필드 구분자는 전부 거부한다.
        for bad in ["aG-s", "aG_s", "aGVs bG8=", "aGVsbG8=\n", "aGk=;x", "aG*s"] {
            assert_eq!(
                decode_send_text(bad),
                Err(SendDecodeError::InvalidBase64),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn rejects_impossible_length() {
        // 패딩을 뺀 길이의 나머지가 1 = 6bit 만 남아 어떤 바이트도 못 만든다.
        assert_eq!(
            decode_send_text("aGVsbG8xMg=="),
            Ok(b"hello12".to_vec()),
            "정상 길이 대조군"
        );
        for bad in ["a", "aGVsb", "aGVsbG8xM=="] {
            assert_eq!(
                decode_send_text(bad),
                Err(SendDecodeError::InvalidBase64),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn rejects_interior_padding() {
        // `=` 는 끝의 최대 2개까지만 — 중간에 있으면 알파벳 밖 문자다.
        assert_eq!(
            decode_send_text("aG=sbG8="),
            Err(SendDecodeError::InvalidBase64)
        );
        assert_eq!(
            decode_send_text("aGVsbG8==="),
            Err(SendDecodeError::InvalidBase64)
        );
    }

    /// `bytes` 바이트를 만드는 (패딩 없는) base64 길이.
    fn b64_len_for(bytes: usize) -> usize {
        let groups = bytes / 3 * 4;
        match bytes % 3 {
            0 => groups,
            1 => groups + 2,
            _ => groups + 3,
        }
    }

    #[test]
    fn payload_at_the_cap_is_kept() {
        let b64 = "A".repeat(b64_len_for(MAX_SEND_BYTES));
        let bytes = decode_send_text(&b64).expect("cap 이내");
        assert_eq!(bytes.len(), MAX_SEND_BYTES);
    }

    #[test]
    fn payload_over_the_cap_is_rejected() {
        // 거부 사유에 실제 디코드 크기가 실린다.
        let b64 = "A".repeat(b64_len_for(MAX_SEND_BYTES + 1));
        assert_eq!(
            decode_send_text(&b64),
            Err(SendDecodeError::TooLarge {
                bytes: MAX_SEND_BYTES + 1
            })
        );
    }

    #[test]
    fn size_is_checked_before_the_alphabet() {
        // 거대한 입력은 내용을 훑기 전에 길이로 거부된다 (메모리에 펼치지 않는다).
        let b64 = "!".repeat(MAX_SEND_BYTES * 2);
        assert!(matches!(
            decode_send_text(&b64),
            Err(SendDecodeError::TooLarge { .. })
        ));
    }

    #[test]
    fn reply_path_accepts_tmp_paths() {
        // `printf '%s' '/tmp/mast-tabs-42.json' | base64 -w0` 형태.
        assert_eq!(
            decode_reply_path("L3RtcC9tYXN0LXRhYnMtNDIuanNvbg=="),
            Ok("/tmp/mast-tabs-42.json".to_owned())
        );
        assert_eq!(
            decode_reply_path("L3RtcC9kaXIvcmVwbHkuanNvbg=="),
            Ok("/tmp/dir/reply.json".to_owned())
        );
        // 비 ASCII 파일명도 UTF-8 이면 통과한다 ("/tmp/한글.json").
        assert_eq!(
            decode_reply_path("L3RtcC/tlZzquIAuanNvbg=="),
            Ok("/tmp/한글.json".to_owned())
        );
    }

    #[test]
    fn reply_path_rejects_paths_outside_tmp() {
        // 홈·dotfile 은 물론, `/tmp` 로 시작하기만 하는 형제 디렉터리도 거부한다.
        for (b64, what) in [
            ("L2hvbWUvdS8uYmFzaHJj", "/home/u/.bashrc"),
            ("L3RtcGZvby94", "/tmpfoo/x"),
            ("L3RtcA==", "/tmp"),
        ] {
            assert_eq!(
                decode_reply_path(b64),
                Err(ReplyPathError::OutsideTmp),
                "{what}"
            );
        }
    }

    #[test]
    fn reply_path_rejects_traversal_before_the_prefix_check() {
        // `..` 는 접두 검사에 닿기 전에 validate_linux_path 가 거부한다 —
        // `/tmp/` 로 시작하는 문자열로 밖을 가리키는 우회가 성립하지 않는다.
        let err = decode_reply_path("L3RtcC8uLi9ob21lL3UvLmJhc2hyYw==").unwrap_err();
        assert!(
            matches!(&err, ReplyPathError::InvalidPath(reason) if reason.contains("'..'")),
            "{err:?}"
        );
        // 백슬래시 밀수(Windows 구분자)도 같은 자리에서 막힌다.
        let err = decode_reply_path("L3RtcC9hXC4uXC4uXHg=").unwrap_err();
        assert!(
            matches!(&err, ReplyPathError::InvalidPath(reason) if reason.contains("backslash")),
            "{err:?}"
        );
    }

    #[test]
    fn reply_path_rejects_relative_paths() {
        let err = decode_reply_path("dG1wL3JlbC5qc29u").unwrap_err();
        assert!(
            matches!(&err, ReplyPathError::InvalidPath(reason) if reason.contains("absolute")),
            "{err:?}"
        );
    }

    #[test]
    fn reply_path_requires_utf8() {
        // 전송 텍스트와 달리 회신 경로는 바이트열을 받지 않는다.
        assert_eq!(decode_reply_path("//8A"), Err(ReplyPathError::NotUtf8));
    }

    #[test]
    fn reply_path_rejects_malformed_base64() {
        assert_eq!(
            decode_reply_path("aG-s"),
            Err(ReplyPathError::Decode(SendDecodeError::InvalidBase64))
        );
        // 빈 payload 는 빈 문자열 → 절대 경로가 아니므로 형태에서 걸린다.
        assert!(matches!(
            decode_reply_path(""),
            Err(ReplyPathError::InvalidPath(_))
        ));
    }

    #[test]
    fn reply_path_checks_shape_only() {
        // 코어는 I/O 를 하지 않는다 — 실존·쓰기 가능 여부는 검사하지 않으며
        // 디렉터리 경로("/tmp/")도 형태로는 통과한다 (쓰기 실패는 글루가 본다).
        assert_eq!(
            decode_reply_path("L3RtcC8="),
            Ok(REPLY_PATH_PREFIX.to_owned())
        );
        assert_eq!(decode_reply_path("L3RtcC94"), Ok("/tmp/x".to_owned()));
    }

    #[test]
    fn error_messages_are_english_one_liners() {
        // 사용자 대면(앱 로그) 문자열 — 영어 규약.
        assert_eq!(
            SendDecodeError::InvalidBase64.to_string(),
            "payload is not standard base64"
        );
        assert_eq!(
            SendDecodeError::TooLarge { bytes: 40000 }.to_string(),
            "payload is 40000 bytes, over the 32768 byte limit"
        );
        assert_eq!(
            SendTargetError::NoMatch.to_string(),
            "no running terminal tab matches the target"
        );
        assert_eq!(
            SendTargetError::Ambiguous { count: 3 }.to_string(),
            "3 running terminal tabs match the target; the target must be unique"
        );
        assert_eq!(
            ReplyPathError::NotUtf8.to_string(),
            "reply path is not valid UTF-8"
        );
        assert_eq!(
            ReplyPathError::Decode(SendDecodeError::InvalidBase64).to_string(),
            "reply path: payload is not standard base64"
        );
        assert_eq!(
            ReplyPathError::InvalidPath("path must be absolute: \"x\"".into()).to_string(),
            "reply path: path must be absolute: \"x\""
        );
        assert_eq!(
            ReplyPathError::OutsideTmp.to_string(),
            "reply path must start with \"/tmp/\" (only /tmp/ is writable for replies)"
        );
    }
}
