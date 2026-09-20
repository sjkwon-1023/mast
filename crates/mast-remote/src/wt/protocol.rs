//! Secure Remote 프레임 — `u32` big endian 길이 + UTF-8 JSON.
//!
//! 상한이 곧 계약이다: 프레임 1.5 MiB, 입력 원문 64 KiB, 화면 원문은 1 MiB replay +
//! 64개 DEC 모드 preamble(모드당 최대 9바이트). 화면이 1.5 MiB 안에 들어오는 근거는
//! base64url 이 4/3 로 늘어도 1.05 MiB → 약 1.4 MiB 라는 산수다 — replay 상한을
//! 늘리면 여기 상한도 같이 손봐야 한다.
//!
//! 파싱은 **명시적**이다. `serde` 의 내부 태그 파서에 맡기지 않고 `type` 을 먼저 읽어
//! 허용 필드 목록과 대조한다 — v1 계약에 없는 필드는 조용히 무시하지 않고 오류로
//! 처리한다. 오류 문구에는 필드 **이름**만 실리고 요청에서 온 값은 실리지 않는다
//! (토큰·입력이 로그·응답으로 새지 않게 하는 ADR-0016 의 규율).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::{Map, Value};
use web_transport_quinn::{RecvStream, SendStream};

/// QR 과 프레임 모두에 실리는 프로토콜 버전.
pub(crate) const VERSION: u8 = 1;
/// 직렬화된 JSON 프레임 하나의 상한.
pub(crate) const MAX_FRAME_BYTES: usize = 1_572_864;
/// `input` 프레임에서 디코딩한 원문 입력의 상한.
pub(crate) const MAX_INPUT_BYTES: usize = 65_536;
/// `screen` 이 돌려줄 수 있는 raw 화면의 상한 — replay 1 MiB + 64개 모드 preamble.
pub(crate) const MAX_SCREEN_BYTES: usize = 1_048_576 + 64 * 9;

/// 클라이언트가 보내는 요청 하나.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub(crate) id: u64,
    pub(crate) payload: Payload,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Payload {
    Auth {
        token: String,
    },
    State,
    Screen {
        tab: u64,
        since: Option<u64>,
        session: Option<String>,
    },
    Input {
        tab: u64,
        session: String,
        /// 디코딩된 원문 바이트. base64url 은 여기서 풀린다.
        data: Vec<u8>,
    },
    Heartbeat,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RequestError {
    NotJson,
    UnsupportedVersion(u64),
    BadField(&'static str),
    UnknownType,
    UnknownField(String),
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RequestError::NotJson => write!(f, "frame is not a JSON object"),
            RequestError::UnsupportedVersion(v) => write!(f, "unsupported version {v}"),
            RequestError::BadField(name) => write!(f, "bad or missing field: {name}"),
            RequestError::UnknownType => write!(f, "unknown request type"),
            RequestError::UnknownField(name) => write!(f, "unknown field: {name}"),
        }
    }
}

/// 프레임 하나를 파싱한다. 성공하면 요청, 실패하면 사유.
pub(crate) fn parse_request(raw: &[u8]) -> Result<Request, RequestError> {
    let value: Value = serde_json::from_slice(raw).map_err(|_| RequestError::NotJson)?;
    let Value::Object(obj) = &value else {
        return Err(RequestError::NotJson);
    };

    let v = obj
        .get("v")
        .and_then(Value::as_u64)
        .ok_or(RequestError::BadField("v"))?;
    if v != VERSION as u64 {
        return Err(RequestError::UnsupportedVersion(v));
    }
    let id = obj
        .get("id")
        .and_then(Value::as_u64)
        .ok_or(RequestError::BadField("id"))?;
    let kind = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or(RequestError::BadField("type"))?;

    let payload = match kind {
        "auth" => {
            allowed(obj, &["v", "id", "type", "token"])?;
            let token = obj
                .get("token")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
                .ok_or(RequestError::BadField("token"))?;
            Payload::Auth {
                token: token.to_string(),
            }
        }
        "state" => {
            allowed(obj, &["v", "id", "type"])?;
            Payload::State
        }
        "screen" => {
            allowed(obj, &["v", "id", "type", "tab", "since", "session"])?;
            let tab = obj
                .get("tab")
                .and_then(Value::as_u64)
                .ok_or(RequestError::BadField("tab"))?;
            let since = optional_u64(obj, "since")?;
            let session = optional_string(obj, "session")?;
            Payload::Screen {
                tab,
                since,
                session,
            }
        }
        "input" => {
            allowed(obj, &["v", "id", "type", "tab", "session", "data"])?;
            let tab = obj
                .get("tab")
                .and_then(Value::as_u64)
                .ok_or(RequestError::BadField("tab"))?;
            let session =
                optional_string(obj, "session")?.ok_or(RequestError::BadField("session"))?;
            let data = obj
                .get("data")
                .and_then(Value::as_str)
                .ok_or(RequestError::BadField("data"))?;
            let bytes = URL_SAFE_NO_PAD
                .decode(data)
                .map_err(|_| RequestError::BadField("data"))?;
            if bytes.len() > MAX_INPUT_BYTES {
                return Err(RequestError::BadField("data"));
            }
            Payload::Input {
                tab,
                session,
                data: bytes,
            }
        }
        "heartbeat" => {
            allowed(obj, &["v", "id", "type"])?;
            Payload::Heartbeat
        }
        _ => return Err(RequestError::UnknownType),
    };
    Ok(Request { id, payload })
}

/// 파싱에 실패한 프레임에서 **id 만** 읽어 본다. 오류 응답을 실패한 요청의 id 로
/// 돌려주면 클라이언트가 자기 pending 요청과 대조해 "unexpected reply" 대신 서버가 준
/// 상태 코드(예: 버전 불일치의 400)를 화면에 띄울 수 있다. id 가 없거나 u64 가 아니면
/// `None` — 상관할 수 없는 응답을 지어내지 않는다 (호출자는 0 으로 닫는다).
pub(crate) fn request_id(raw: &[u8]) -> Option<u64> {
    let value: Value = serde_json::from_slice(raw).ok()?;
    value.get("id").and_then(Value::as_u64)
}

/// 요청에 v1 이 모르는 필드가 있으면 오류다 — 조용히 무시하면 오타 난 필드가 기본값으로
/// 동작해 "보냈는데 안 된다"가 된다.
fn allowed(obj: &Map<String, Value>, names: &[&str]) -> Result<(), RequestError> {
    for key in obj.keys() {
        if !names.contains(&key.as_str()) {
            return Err(RequestError::UnknownField(key.clone()));
        }
    }
    Ok(())
}

fn optional_u64(obj: &Map<String, Value>, name: &'static str) -> Result<Option<u64>, RequestError> {
    match obj.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or(RequestError::BadField(name)),
    }
}

fn optional_string(
    obj: &Map<String, Value>,
    name: &'static str,
) -> Result<Option<String>, RequestError> {
    match obj.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.is_empty() => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(RequestError::BadField(name)),
    }
}

#[derive(Debug)]
pub(crate) enum FrameError {
    /// 스트림 오류·EOF·리셋. 사유는 **분류명만** 온다 — quinn 의 `ApplicationClose`
    /// reason 은 peer 가 정한 lossy UTF-8 이라 그대로 실으면 로그에 개행·가짜 줄을
    /// 넣을 수 있고, 그 문자열이 이 오류의 `Display` 를 타고 로그로 나간다.
    Io(&'static str),
    /// 선언한 길이가 0 이거나 상한을 넘었다. 바이트를 읽기 전에 걸린다.
    BadLength(usize),
    /// 직렬화한 응답이 상한을 넘었다 — 코드 결함이라 응답 대신 오류 프레임을 보낸다.
    TooLarge(usize),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Io(e) => write!(f, "stream error: {e}"),
            FrameError::BadLength(n) => write!(f, "frame length {n} out of bounds"),
            FrameError::TooLarge(n) => write!(f, "frame to send is {n} bytes"),
        }
    }
}

/// 길이 프리픽스만 읽는다. **idle 판정은 이 읽기에 걸고**, 시작된 프레임의 완성은
/// `frame_io` 마감으로 나눠 걸기 위해 분리했다 — 두 상한의 의미가 다르다.
pub(crate) async fn read_len(recv: &mut RecvStream, limit: usize) -> Result<usize, FrameError> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len)
        .await
        .map_err(|e| FrameError::Io(read_error_label(&e)))?;
    let n = u32::from_be_bytes(len) as usize;
    if n == 0 || n > limit {
        return Err(FrameError::BadLength(n));
    }
    Ok(n)
}

/// 길이를 이미 확인한 프레임의 본문. 선언만 큰 프레임에 메모리를 내주지 않는다.
pub(crate) async fn read_payload(recv: &mut RecvStream, len: usize) -> Result<Vec<u8>, FrameError> {
    let mut buf = vec![0u8; len];
    recv.read_exact(&mut buf)
        .await
        .map_err(|e| FrameError::Io(read_error_label(&e)))?;
    Ok(buf)
}

/// quinn 의 read 오류를 분류명으로만 줄인다. `SessionError::WebTransportError(Closed)`
/// 가 peer 의 close reason 을 문자열로 들고 있으므로, 오류를 그대로 포맷하면 peer 가
/// 로그 줄을 위조할 수 있다.
fn read_error_label(e: &web_transport_quinn::ReadExactError) -> &'static str {
    use web_transport_quinn::{ReadError, ReadExactError};
    match e {
        ReadExactError::FinishedEarly(_) => "stream ended early",
        ReadExactError::ReadError(inner) => match inner {
            ReadError::SessionError(_) => "connection lost",
            ReadError::Reset(_) | ReadError::InvalidReset(_) => "stream reset",
            ReadError::ClosedStream => "stream closed",
            ReadError::IllegalOrderedRead => "unordered read",
        },
    }
}

/// write 오류도 같은 이유로 분류명만 남긴다.
fn write_error_label(e: &web_transport_quinn::WriteError) -> &'static str {
    use web_transport_quinn::WriteError;
    match e {
        WriteError::Stopped(_) | WriteError::InvalidStopped(_) => "stream stopped",
        WriteError::SessionError(_) => "connection lost",
        WriteError::ClosedStream => "stream closed",
    }
}

/// 첫 프레임처럼 한 마감 안에 길이와 본문을 다 읽는 경우.
pub(crate) async fn read_frame(recv: &mut RecvStream, limit: usize) -> Result<Vec<u8>, FrameError> {
    let len = read_len(recv, limit).await?;
    read_payload(recv, len).await
}

/// 보내기 전에 상한을 본다. 넘으면 아무것도 쓰지 않고 오류다.
pub(crate) async fn write_frame(send: &mut SendStream, payload: &[u8]) -> Result<(), FrameError> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(payload.len()));
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    send.write_all(&frame)
        .await
        .map_err(|e| FrameError::Io(write_error_label(&e)))
}

/// `{"v":1,"id":N,"ok":true,...}` — `fields` 는 `v`·`id`·`ok` 를 뺀 나머지다.
pub(crate) fn ok_frame(id: u64, fields: &[(&str, Value)]) -> Vec<u8> {
    let mut obj = Map::new();
    obj.insert("v".into(), Value::from(VERSION));
    obj.insert("id".into(), Value::from(id));
    obj.insert("ok".into(), Value::from(true));
    for (name, value) in fields {
        obj.insert((*name).to_string(), value.clone());
    }
    serde_json::to_vec(&Value::Object(obj)).expect("response frame serializes")
}

/// `{"v":1,"id":N,"ok":false,"status":S,"message":"..."}` — `message` 는 코드 안의
/// 고정 문구만 온다.
pub(crate) fn error_frame(id: u64, status: u16, message: &str) -> Vec<u8> {
    let mut obj = Map::new();
    obj.insert("v".into(), Value::from(VERSION));
    obj.insert("id".into(), Value::from(id));
    obj.insert("ok".into(), Value::from(false));
    obj.insert("status".into(), Value::from(status));
    obj.insert("message".into(), Value::from(message));
    serde_json::to_vec(&Value::Object(obj)).expect("error frame serializes")
}

/// `screen` 응답에 싣는 base64url 인코딩.
pub(crate) fn encode_bytes(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `state` 응답 — 스냅샷을 **문자열이 아니라 JSON 오브젝트로** 끼워 넣는다. 스냅샷은
/// `serde_json` 이 만든 유효한 JSON 이므로 다시 파싱할 이유가 없다.
pub(crate) fn state_ok_frame(id: u64, snapshot: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(snapshot.len() + 48);
    out.extend_from_slice(
        format!("{{\"v\":{VERSION},\"id\":{id},\"ok\":true,\"state\":").as_bytes(),
    );
    out.extend_from_slice(snapshot);
    out.push(b'}');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Result<Request, RequestError> {
        parse_request(raw.as_bytes())
    }

    #[test]
    fn parses_every_v1_request() {
        assert_eq!(
            parse(r#"{"v":1,"id":7,"type":"auth","token":"abc"}"#).unwrap(),
            Request {
                id: 7,
                payload: Payload::Auth {
                    token: "abc".into()
                },
            }
        );
        assert_eq!(
            parse(r#"{"v":1,"id":8,"type":"state"}"#).unwrap().payload,
            Payload::State
        );
        assert_eq!(
            parse(r#"{"v":1,"id":9,"type":"screen","tab":3}"#)
                .unwrap()
                .payload,
            Payload::Screen {
                tab: 3,
                since: None,
                session: None
            }
        );
        assert_eq!(
            parse(r#"{"v":1,"id":10,"type":"screen","tab":3,"since":42,"session":"1:2"}"#)
                .unwrap()
                .payload,
            Payload::Screen {
                tab: 3,
                since: Some(42),
                session: Some("1:2".into())
            }
        );
        let input = parse(&format!(
            r#"{{"v":1,"id":11,"type":"input","tab":3,"session":"1:2","data":"{}"}}"#,
            encode_bytes(b"ls\r")
        ))
        .unwrap();
        assert_eq!(
            input.payload,
            Payload::Input {
                tab: 3,
                session: "1:2".into(),
                data: b"ls\r".to_vec()
            }
        );
        assert_eq!(
            parse(r#"{"v":1,"id":12,"type":"heartbeat"}"#)
                .unwrap()
                .payload,
            Payload::Heartbeat
        );
    }

    #[test]
    fn rejects_other_versions() {
        assert_eq!(
            parse(r#"{"v":2,"id":1,"type":"state"}"#),
            Err(RequestError::UnsupportedVersion(2))
        );
        assert_eq!(
            parse(r#"{"id":1,"type":"state"}"#),
            Err(RequestError::BadField("v"))
        );
    }

    #[test]
    fn rejects_unknown_types_and_fields() {
        assert_eq!(
            parse(r#"{"v":1,"id":1,"type":"exec","cmd":"rm"}"#),
            Err(RequestError::UnknownType)
        );
        assert_eq!(
            parse(r#"{"v":1,"id":1,"type":"state","extra":1}"#),
            Err(RequestError::UnknownField("extra".into()))
        );
        // auth 에 tab 을 붙이는 식의 혼합도 거부된다.
        assert_eq!(
            parse(r#"{"v":1,"id":1,"type":"auth","token":"t","tab":3}"#),
            Err(RequestError::UnknownField("tab".into()))
        );
    }

    #[test]
    fn rejects_wrongly_typed_or_missing_fields() {
        for raw in [
            r#"{"v":1,"id":1,"type":"screen"}"#,
            r#"{"v":1,"id":1,"type":"screen","tab":"3"}"#,
            r#"{"v":1,"id":1,"type":"screen","tab":3,"since":"4"}"#,
            r#"{"v":1,"id":1,"type":"input","tab":3,"data":"AAAA"}"#,
            r#"{"v":1,"id":1,"type":"input","tab":3,"session":"1:2"}"#,
            r#"{"v":1,"id":1,"type":"input","tab":3,"session":"1:2","data":"!!"}"#,
            r#"{"v":1,"id":1,"type":"auth"}"#,
            r#"{"v":1,"id":1,"type":"auth","token":""}"#,
            r#"{"v":1,"id":1,"type":"heartbeat","x":true}"#,
        ] {
            assert!(parse(raw).is_err(), "받아들이면 안 되는 요청: {raw}");
        }
    }

    #[test]
    fn rejects_non_object_and_non_json_frames() {
        assert_eq!(parse("[]"), Err(RequestError::NotJson));
        assert_eq!(parse("not json"), Err(RequestError::NotJson));
        assert_eq!(parse(""), Err(RequestError::NotJson));
    }

    #[test]
    fn request_id_is_recovered_from_frames_that_fail_to_parse() {
        // 버전 불일치와 v1 이 모르는 필드 — 둘 다 오류지만 id 는 읽을 수 있다.
        assert_eq!(request_id(br#"{"v":2,"id":7,"type":"state"}"#), Some(7));
        assert_eq!(
            request_id(br#"{"v":1,"id":8,"type":"state","extra":true}"#),
            Some(8)
        );
        assert_eq!(
            request_id(br#"{"v":1,"id":9,"type":"auth","token":"t","tab":3}"#),
            Some(9)
        );
        // id 자체가 없거나 u64 가 아니면 상관할 수 없다.
        assert_eq!(request_id(br#"{"v":1,"type":"state"}"#), None);
        assert_eq!(request_id(br#"{"v":1,"id":"8","type":"state"}"#), None);
        assert_eq!(request_id(br#"{"v":1,"id":-1,"type":"state"}"#), None);
        assert_eq!(request_id(b"not json"), None);
        assert_eq!(request_id(b"[]"), None);
        assert_eq!(request_id(b""), None);
    }

    #[test]
    fn input_over_64kib_is_rejected_at_parse_time() {
        let big = encode_bytes(&vec![b'x'; MAX_INPUT_BYTES + 1]);
        let raw =
            format!(r#"{{"v":1,"id":1,"type":"input","tab":1,"session":"1:2","data":"{big}"}}"#);
        assert!(parse(&raw).is_err());
        let ok = encode_bytes(&vec![b'x'; MAX_INPUT_BYTES]);
        let raw =
            format!(r#"{{"v":1,"id":1,"type":"input","tab":1,"session":"1:2","data":"{ok}"}}"#);
        assert!(parse(&raw).is_ok());
    }

    #[test]
    fn responses_carry_the_version_and_id() {
        let ok = ok_frame(5, &[("state", Value::from("x"))]);
        let parsed: Value = serde_json::from_slice(&ok).unwrap();
        assert_eq!(parsed["v"], 1);
        assert_eq!(parsed["id"], 5);
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["state"], "x");

        let err = error_frame(6, 404, "unknown tab");
        let parsed: Value = serde_json::from_slice(&err).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["status"], 404);
        assert_eq!(parsed["message"], "unknown tab");
    }

    #[test]
    fn state_ok_frame_embeds_the_snapshot_as_an_object() {
        let snapshot = serde_json::to_vec(&serde_json::json!({"workspaces": [1, 2]})).unwrap();
        let frame = state_ok_frame(9, &snapshot);
        let parsed: Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["id"], 9);
        assert_eq!(parsed["state"]["workspaces"][1], 2);
    }
}
