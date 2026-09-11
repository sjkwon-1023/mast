//! 요청 헤드 읽기 — 파서만이고 소켓·응답은 여기에 없다.
//!
//! 상한(ADR-0016 결정 4)은 이 모듈이 소유한다: 헤드 8 KiB·헤더 32개를 넘기면 서버가 431 로
//! 끊고, 본문 상한은 `Content-Length` 로 **읽기 전에** 판정한다. 프레이밍 관련 헤더
//! (`Content-Length` 중복, `Transfer-Encoding`, `Expect`)는 값을 해석하지 않고 사실만
//! 실어 보낸다 — 어떻게 응답할지는 서버의 판단이고, 파서는 판단 재료만 만든다.

use std::io::Read;

/// 요청 라인 + 헤더 전체의 바이트 상한. 넘기면 [`HeadError::TooLarge`] (서버는 431).
pub(crate) const MAX_HEAD_BYTES: usize = 8192;
/// 헤더 개수 상한 — httparse 에 넘기는 헤더 슬롯 배열의 크기가 곧 상한이다.
pub(crate) const MAX_HEADERS: usize = 32;
/// `POST /api/tabs/{id}/input` 본문 상한. 초과는 본문을 한 바이트도 읽기 전에 413.
pub(crate) const MAX_BODY_BYTES: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Method {
    Get,
    Post,
    /// 우리 라우트가 쓰지 않는 모든 메서드 — `OPTIONS` 를 포함해 전부 404 로 간다.
    Other,
}

/// 요청 헤드에서 서버가 실제로 쓰는 것만 남긴 것.
///
/// `Authorization`·`Content-Length`·`Transfer-Encoding`·`Expect` 외의 헤더는 이름도 값도
/// 보관하지 않는다. 쿠키·`X-Forwarded-*` 같은 값이 구조체에 실리지 않으면 로그·에러 본문에
/// 섞여 나갈 경로 자체가 없다(ADR-0016 결정 4의 로그 규율을 자료구조로 강제).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Head {
    pub(crate) method: Method,
    /// 쿼리를 뗀 경로. 퍼센트 디코딩하지 않는다(라우팅 규칙은 `routes` 참조).
    pub(crate) path: String,
    pub(crate) query: Option<String>,
    pub(crate) authorization: Option<String>,
    pub(crate) content_length: Option<usize>,
    /// `Content-Length` 가 서로 다른 값으로 두 번 이상 왔다 — 서버는 400.
    /// 같은 값의 반복은 프레이밍이 모호하지 않으므로 여기서 참이 되지 않는다.
    pub(crate) duplicate_content_length: bool,
    pub(crate) has_transfer_encoding: bool,
    pub(crate) has_expect: bool,
}

#[derive(Debug)]
pub(crate) enum HeadError {
    /// 헤드가 상한을 넘었거나 헤더가 너무 많다 — 서버는 431.
    TooLarge,
    /// 파싱 불가 — 서버는 400.
    Malformed,
    /// 헤드가 끝나기 전에 연결이 끊겼거나 읽기가 실패했다 — 응답 없이 닫는다.
    Eof,
}

/// `r` 에서 헤드가 완성될 때까지 읽어 `buf` 에 누적한다.
///
/// 반환 `usize` 는 **헤드의 길이**이고, `buf[len..]` 는 헤드와 같은 read 에 딸려 들어온
/// **본문 선두**다. 호출자는 그 바이트부터 이어서 본문을 모아야 한다 — 버리면 `POST` 본문의
/// 앞부분이 사라진다.
///
/// 헤드가 이미 `buf` 안에 완성돼 있으면 `r` 을 한 번도 읽지 않는다.
pub(crate) fn read_head<R: Read>(r: &mut R, buf: &mut Vec<u8>) -> Result<(Head, usize), HeadError> {
    let mut chunk = [0u8; 1024];
    loop {
        let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
        let mut req = httparse::Request::new(&mut headers);
        match req.parse(buf) {
            Ok(httparse::Status::Complete(len)) => return Ok((head_from(&req)?, len)),
            Ok(httparse::Status::Partial) => {
                // 상한에 닿았는데도 헤드가 안 끝났다 = 더 읽어 봐야 상한만 넘는다.
                if buf.len() >= MAX_HEAD_BYTES {
                    return Err(HeadError::TooLarge);
                }
            }
            Err(httparse::Error::TooManyHeaders) => return Err(HeadError::TooLarge),
            Err(_) => return Err(HeadError::Malformed),
        }
        match r.read(&mut chunk) {
            Ok(0) => return Err(HeadError::Eof),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // 타임아웃·리셋도 Eof 로 접는다: 어느 쪽이든 "헤드가 오지 않았다"는 같은 결론이고,
            // 서버가 사유별로 다르게 응답할 것이 없다.
            Err(_) => return Err(HeadError::Eof),
        }
    }
}

fn head_from(req: &httparse::Request<'_, '_>) -> Result<Head, HeadError> {
    let method = match req.method.ok_or(HeadError::Malformed)? {
        "GET" => Method::Get,
        "POST" => Method::Post,
        _ => Method::Other,
    };
    let target = req.path.ok_or(HeadError::Malformed)?;
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, Some(q.to_string())),
        None => (target, None),
    };

    let mut head = Head {
        method,
        path: path.to_string(),
        query,
        authorization: None,
        content_length: None,
        duplicate_content_length: false,
        has_transfer_encoding: false,
        has_expect: false,
    };

    for h in req.headers.iter() {
        if h.name.eq_ignore_ascii_case("authorization") {
            // 첫 값만 본다. 중복이 와도 비교에서 어긋나면 401 이라, 후보를 늘리는 것은
            // 공격자에게 시도 횟수를 공짜로 주는 것과 같다.
            if head.authorization.is_none() {
                head.authorization = std::str::from_utf8(h.value).ok().map(str::to_owned);
            }
        } else if h.name.eq_ignore_ascii_case("content-length") {
            let raw = std::str::from_utf8(h.value)
                .map_err(|_| HeadError::Malformed)?
                .trim();
            // `str::parse` 는 `+5` 도 5 로 받는다 — 같은 길이를 두 표기로 쓸 수 있으면
            // 중복 판정이 무의미해지므로 ASCII 숫자만 허용한다.
            if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return Err(HeadError::Malformed);
            }
            let value: usize = raw.parse().map_err(|_| HeadError::Malformed)?;
            match head.content_length {
                None => head.content_length = Some(value),
                Some(prev) if prev != value => head.duplicate_content_length = true,
                Some(_) => {}
            }
        } else if h.name.eq_ignore_ascii_case("transfer-encoding") {
            head.has_transfer_encoding = true;
        } else if h.name.eq_ignore_ascii_case("expect") {
            head.has_expect = true;
        }
        // 나머지 헤더는 이름도 값도 옮기지 않는다 — Head 의 rustdoc 참조.
    }

    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// read 한 번에 chunk 하나씩만 내주는 리더 — 헤드가 여러 read 에 걸쳐 도착하는 경우를
    /// 실제로 재현한다(`&[u8]` 리더는 한 번에 다 준다).
    struct ChunkReader {
        chunks: VecDeque<Vec<u8>>,
    }

    impl ChunkReader {
        fn new(chunks: &[&[u8]]) -> Self {
            Self {
                chunks: chunks.iter().map(|c| c.to_vec()).collect(),
            }
        }
    }

    impl Read for ChunkReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let Some(front) = self.chunks.front_mut() else {
                return Ok(0);
            };
            let n = front.len().min(out.len());
            out[..n].copy_from_slice(&front[..n]);
            front.drain(..n);
            if front.is_empty() {
                self.chunks.pop_front();
            }
            Ok(n)
        }
    }

    fn read_all(raw: &[u8]) -> Result<(Head, usize, Vec<u8>), HeadError> {
        let mut reader = raw;
        let mut buf = Vec::new();
        let (head, len) = read_head(&mut reader, &mut buf)?;
        let body = buf[len..].to_vec();
        Ok((head, len, body))
    }

    #[test]
    fn parses_a_minimal_get_request_line() {
        let (head, len, body) = read_all(b"GET /api/state HTTP/1.1\r\n\r\n").unwrap();
        assert_eq!(head.method, Method::Get);
        assert_eq!(head.path, "/api/state");
        assert_eq!(head.query, None);
        assert_eq!(head.authorization, None);
        assert_eq!(head.content_length, None);
        assert_eq!(len, b"GET /api/state HTTP/1.1\r\n\r\n".len());
        assert!(body.is_empty());
    }

    #[test]
    fn assembles_a_head_split_across_reads() {
        let mut reader = ChunkReader::new(&[
            b"GET /api/tabs/7/scr",
            b"een?since=42 HTTP/1.1\r\nAuthorization: Bearer abc\r",
            b"\n\r\n",
        ]);
        let mut buf = Vec::new();
        let (head, len) = read_head(&mut reader, &mut buf).unwrap();
        assert_eq!(head.path, "/api/tabs/7/screen");
        assert_eq!(head.query.as_deref(), Some("since=42"));
        assert_eq!(head.authorization.as_deref(), Some("Bearer abc"));
        assert_eq!(len, buf.len());
    }

    #[test]
    fn keeps_body_bytes_that_arrived_with_the_head() {
        let raw = b"POST /api/tabs/1/input HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello";
        let (head, len, body) = read_all(raw).unwrap();
        assert_eq!(head.method, Method::Post);
        assert_eq!(head.content_length, Some(5));
        assert_eq!(len, raw.len() - 5);
        assert_eq!(body, b"hello");
    }

    #[test]
    fn rejects_a_head_larger_than_the_cap() {
        let mut raw = b"GET / HTTP/1.1\r\nX-Long: ".to_vec();
        raw.extend(std::iter::repeat_n(b'a', MAX_HEAD_BYTES));
        // 종결 CRLFCRLF 를 붙이지 않는다 — 상한에 닿을 때까지 Partial 이어야 한다.
        let mut reader = raw.as_slice();
        let mut buf = Vec::new();
        assert!(matches!(
            read_head(&mut reader, &mut buf),
            Err(HeadError::TooLarge)
        ));
    }

    #[test]
    fn rejects_more_headers_than_the_cap() {
        let mut raw = b"GET / HTTP/1.1\r\n".to_vec();
        for i in 0..=MAX_HEADERS {
            raw.extend(format!("X-{i}: v\r\n").as_bytes());
        }
        raw.extend(b"\r\n");
        assert!(
            raw.len() < MAX_HEAD_BYTES,
            "헤드 크기가 아니라 헤더 수로 걸려야 한다"
        );
        let mut reader = raw.as_slice();
        let mut buf = Vec::new();
        assert!(matches!(
            read_head(&mut reader, &mut buf),
            Err(HeadError::TooLarge)
        ));
    }

    #[test]
    fn parses_content_length_and_rejects_a_non_numeric_value() {
        let (head, _, _) =
            read_all(b"POST /api/tabs/1/input HTTP/1.1\r\nContent-Length: 12\r\n\r\n").unwrap();
        assert_eq!(head.content_length, Some(12));

        for bad in [
            &b"POST / HTTP/1.1\r\nContent-Length: abc\r\n\r\n"[..],
            &b"POST / HTTP/1.1\r\nContent-Length: +5\r\n\r\n"[..],
            &b"POST / HTTP/1.1\r\nContent-Length: \r\n\r\n"[..],
        ] {
            assert!(
                matches!(read_all(bad), Err(HeadError::Malformed)),
                "받아들이면 안 되는 Content-Length: {:?}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn flags_duplicate_content_length_transfer_encoding_and_expect() {
        let (head, _, _) = read_all(
            b"POST / HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 9\r\n\
              Transfer-Encoding: chunked\r\nExpect: 100-continue\r\n\r\n",
        )
        .unwrap();
        assert!(head.duplicate_content_length);
        assert!(head.has_transfer_encoding);
        assert!(head.has_expect);
        assert_eq!(head.content_length, Some(5));

        let (same, _, _) =
            read_all(b"POST / HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\n").unwrap();
        assert!(
            !same.duplicate_content_length,
            "같은 값의 반복은 프레이밍이 모호하지 않다"
        );
        assert_eq!(same.content_length, Some(5));

        let (none, _, _) = read_all(b"POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\n").unwrap();
        assert!(!none.has_transfer_encoding);
        assert!(!none.has_expect);
    }

    #[test]
    fn keeps_no_header_value_other_than_authorization_and_content_length() {
        let (head, _, _) = read_all(
            b"GET /api/state HTTP/1.1\r\nHost: 192.168.0.9:7331\r\nCookie: session=swordfish\r\n\
              Authorization: Bearer keepme\r\nUser-Agent: probe/1.0\r\n\r\n",
        )
        .unwrap();
        let dumped = format!("{head:?}");
        for leaked in ["swordfish", "probe/1.0", "192.168.0.9"] {
            assert!(
                !dumped.contains(leaked),
                "{leaked} 이 Head 에 남았다: {dumped}"
            );
        }
        assert!(dumped.contains("keepme"));
    }
}
