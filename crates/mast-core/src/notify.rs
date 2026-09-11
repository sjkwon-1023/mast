//! OSC 알림 coalescing 자료구조 + 규약 파서 (계획 v2 9장 "에이전트 상태 및 알림").
//!
//! PTY 리더는 OSC 이벤트를 감지할 때마다 [`OscBatch::merge`] 로 흘려보내기만 하고,
//! 실제 모델 반영은 flush 창(글루의 트레일링 타이머)마다 한 번 일어난다. 순수 모듈이다 —
//! 시계·스레드·락 무의존이며, 배치를 언제 비우고 누구에게 적용할지는 호출자가 정한다.
//!
//! # 메모리 상한
//!
//! 배치는 큐가 아니라 **세션당 슬롯 1개**(cell)다. 같은 세션에 OSC 가 아무리 쏟아져도
//! 그 세션의 [`OscDelta`] 를 덮어쓸 뿐이라, 배치 크기는 이벤트 수가 아니라 **살아 있는
//! 세션 수**로 상한이 잡힌다 (OSC 플러드가 메모리를 밀어올리지 못한다 — 계획 v2 9장의
//! coalescing 전제). 메시지도 [`MAX_MESSAGE_CHARS`] 로 절단해 슬롯 하나의 크기까지
//! 유계다.
//!
//! # OSC 의미 규약
//!
//! - OSC 777 `notify;title;body` 의 title 이 `mast:running` | `mast:needsInput` |
//!   `mast:idle` 이면 **상태 알림**: 해당 [`AgentStatus`] + body(비어있지 않으면)를
//!   메시지로. unread 는 `needsInput`·`idle` 만 세운다 — `running` 은 진행 신호라
//!   dot 을 만들지 않는다.
//! - 토큰이 안 맞는 777 과 OSC 9 는 **상태 중립 알림**: unread + 메시지만 반영하고
//!   상태는 건드리지 않는다 (OSC 9 는 ConEmu 진행률 등 타 도구 잡음이 섞일 수 있어
//!   상태를 주장하지 않는다).
//! - OSC 0(및 ConPTY 재인코딩 대비 별칭 OSC 2) → 탭 제목, OSC 7 → cwd. 둘 다 unread 없음.

use std::collections::BTreeMap;

use crate::model::AgentStatus;
use crate::osc::OscEvent;
use crate::session::SessionId;

/// 사이드바 미리보기로 보관할 메시지 상한 (chars — 바이트가 아니라 문자 수).
const MAX_MESSAGE_CHARS: usize = 500;

/// 한 세션에 대해 flush 창 동안 누적된 변경분. `None`·`false` 는 "이번 창에 그 필드에
/// 대한 신호가 없었다"는 뜻이므로, 적용 측은 값이 있는 필드만 모델에 반영한다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OscDelta {
    /// OSC 0/2 제목 — last-wins.
    pub(crate) title: Option<String>,
    /// OSC 7 의 percent-decode 된 경로 — last-wins.
    pub(crate) cwd: Option<String>,
    /// `mast:` 토큰이 붙은 777 의 상태 — last-wins.
    pub(crate) status: Option<AgentStatus>,
    /// 알림 본문 — last-non-empty (빈 body 는 앞서 온 메시지를 지우지 않는다).
    pub(crate) message: Option<String>,
    /// 한 번이라도 알림이 오면 세워지고 창이 끝날 때까지 내려가지 않는다 (sticky).
    pub(crate) unread: bool,
    /// 시작 표식이 도착했다 — sticky. 마감을 넘겨 "시작되지 않음"이 붙은 탭을 정상으로
    /// 되돌리는 신호이며, 늦게 온 표식도 같은 경로로 흘러 경고를 거둔다.
    pub(crate) started: bool,
}

/// flush 창 동안의 세션별 변경분 모음. 세션 id 순회 순서를 고정하려고 `BTreeMap` 을 쓴다
/// (창 안 cross-session 적용 순서가 재현 가능해진다).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OscBatch {
    /// 적용은 같은 크레이트의 `Dispatcher::apply_osc` 만 한다 — 글루는 merge/take 만 쓴다.
    pub(crate) entries: BTreeMap<SessionId, OscDelta>,
}

impl OscBatch {
    /// OSC 이벤트 하나를 해당 세션 슬롯에 병합한다. 슬롯 하나를 갱신할 뿐이라
    /// 이벤트 수와 무관하게 상수 작업·상수 메모리다 (리더 스레드 핫패스).
    pub fn merge(&mut self, session: SessionId, ev: &OscEvent) {
        match ev {
            OscEvent::Osc0Title(title) => {
                self.slot(session).title = Some(title.clone());
            }
            OscEvent::Osc7Cwd(uri) => {
                // 파스 실패는 빈 슬롯조차 만들지 않는다 — is_empty() 가 "적용할 게
                // 있는가"와 어긋나면 flush 가 헛돌고 revision 이 무의미하게 오른다.
                if let Some(path) = parse_file_uri(uri) {
                    self.slot(session).cwd = Some(path);
                }
            }
            OscEvent::Osc9Notify(body) => {
                let delta = self.slot(session);
                delta.unread = true;
                merge_message(delta, body);
            }
            OscEvent::Osc777Notify { title, body } => {
                let status = parse_status_token(title);
                let delta = self.slot(session);
                match status {
                    Some(status) => {
                        delta.status = Some(status);
                        // running 은 "일하는 중" 신호 — 사용자가 볼 것이 없으므로 dot 없음.
                        if status != AgentStatus::Running {
                            delta.unread = true;
                        }
                    }
                    // 토큰 불일치 = 상태 중립 알림. agent_status 를 주장하지 않는다.
                    None => delta.unread = true,
                }
                merge_message(delta, body);
            }
            // pane 간 전송·질의는 상태가 아니라 **액션**이라 배치에 담기지 않는다 —
            // 글루가 라우터에 밀어넣기 전에 가로채 즉시 처리한다 (crate::send).
            // 여기까지 온다면 배치에 슬롯조차 만들지 않는다: 코얼레싱은 상태
            // 델타 전용이고, 빈 델타를 만들면 flush 가 헛돌기 때문이다.
            OscEvent::Osc777Send { .. } | OscEvent::Osc777Query { .. } => {}
            // 표식은 액션이 아니라 상태 델타다 — 늦게 와도 경고를 거둬야 하므로
            // 코얼레싱 창에 담긴다. 세션당 한 번뿐이라 sticky 로 충분하다.
            OscEvent::Osc777Started => self.slot(session).started = true,
            // 색상 질의도 상태가 아니라 **액션**이다 — 글루가 그 세션의 stdin 에
            // 즉시 응답을 쓴다 (sink.rs). 여기 슬롯은 만들지 않는다: 질의는 TUI
            // 앱이 그릴 때마다 반복해서 오므로 배치에 담으면 flush 가 헛돈다.
            OscEvent::OscColorQuery { .. } => {}
            // DEC private mode·리셋은 OSC 가 아니다 — 리더가 재-attach preamble
            // 용으로 소비하므로 sink 가 이것들을 보는 일은 없다 (session.rs).
            OscEvent::DecPrivateMode { .. } | OscEvent::TerminalReset { .. } => {}
        }
    }

    /// 적용할 변경분이 하나도 없는가. 글루의 flush 루프가 헛도는 것을 막는 조건이다.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 누적분을 통째로 꺼내고 배치를 빈 상태로 되돌린다. 호출자는 이 반환값을 락 밖에서
    /// 적용한다 (pending 락과 dispatcher 락을 동시에 잡지 않기 위한 경계).
    pub fn take(&mut self) -> OscBatch {
        std::mem::take(self)
    }

    /// 세션 슬롯을 가져오거나 만든다.
    fn slot(&mut self, session: SessionId) -> &mut OscDelta {
        self.entries.entry(session).or_default()
    }
}

/// 알림 본문을 병합한다 — 빈 body 는 무시(last-non-empty), 아니면 절단해 덮어쓴다.
fn merge_message(delta: &mut OscDelta, body: &str) {
    if body.is_empty() {
        return;
    }
    delta.message = Some(truncate_chars(body, MAX_MESSAGE_CHARS));
}

/// 문자 수 기준 절단. 바이트로 자르면 멀티바이트 문자 중간에서 panic 하므로
/// char 경계에서만 자른다.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => s[..idx].to_string(),
        None => s.to_string(),
    }
}

/// OSC 777 title 의 `mast:` 상태 토큰을 파스한다. 규약 외 문자열은 `None`
/// (= 상태 중립 알림).
fn parse_status_token(title: &str) -> Option<AgentStatus> {
    match title {
        "mast:running" => Some(AgentStatus::Running),
        "mast:needsInput" => Some(AgentStatus::NeedsInput),
        "mast:idle" => Some(AgentStatus::Idle),
        _ => None,
    }
}

/// OSC 7 의 `file://host/path` 에서 경로만 뽑아 percent-decode 한다.
/// host 부분은 무시한다 — mast 는 자기 PTY 가 보고한 경로만 쓰므로 호스트명이 무엇이든
/// 의미가 없다. `file://` 스킴이 아니거나 경로가 없으면 `None` (cwd 를 건드리지 않는다).
fn parse_file_uri(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let slash = rest.find('/')?;
    Some(percent_decode(&rest[slash..]))
}

/// `%XX` 이스케이프를 바이트로 되돌린다. 유효하지 않은 이스케이프(`%` 뒤가 hex 2자리가
/// 아님)는 리터럴 `%` 로 남긴다. 디코드 결과는 바이트열이므로 UTF-8 lossy 로 문자열화한다
/// (osc.rs 의 payload 처리와 같은 규율).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notify(title: &str, body: &str) -> OscEvent {
        OscEvent::Osc777Notify {
            title: title.into(),
            body: body.into(),
        }
    }

    // 편의 헬퍼 — 세션 1개에 이벤트들을 순서대로 흘리고 그 델타를 돌려준다.
    fn merged(events: &[OscEvent]) -> OscDelta {
        let mut batch = OscBatch::default();
        for ev in events {
            batch.merge(1, ev);
        }
        batch.entries.get(&1).cloned().unwrap_or_default()
    }

    #[test]
    fn title_cwd_status_are_last_wins() {
        let delta = merged(&[
            OscEvent::Osc0Title("first".into()),
            OscEvent::Osc7Cwd("file://host/a".into()),
            notify("mast:running", ""),
            OscEvent::Osc0Title("second".into()),
            OscEvent::Osc7Cwd("file://host/b".into()),
            notify("mast:idle", ""),
        ]);
        assert_eq!(delta.title.as_deref(), Some("second"));
        assert_eq!(delta.cwd.as_deref(), Some("/b"));
        assert_eq!(delta.status, Some(AgentStatus::Idle));
    }

    #[test]
    fn message_is_last_non_empty() {
        // 빈 body(예: UserPromptSubmit→running)는 앞서 온 메시지를 지우지 않는다.
        let delta = merged(&[
            notify("mast:needsInput", "approve?"),
            notify("mast:running", ""),
        ]);
        assert_eq!(delta.message.as_deref(), Some("approve?"));
        assert_eq!(delta.status, Some(AgentStatus::Running));
    }

    #[test]
    fn unread_is_sticky_across_running() {
        // needsInput 으로 세운 unread 는 뒤따르는 running 이 내리지 못한다.
        let delta = merged(&[
            notify("mast:needsInput", "approve?"),
            notify("mast:running", ""),
        ]);
        assert!(delta.unread);
    }

    #[test]
    fn running_alone_sets_no_unread() {
        let delta = merged(&[notify("mast:running", "working")]);
        assert_eq!(delta.status, Some(AgentStatus::Running));
        assert!(!delta.unread);
    }

    #[test]
    fn needs_input_and_idle_set_unread() {
        assert!(merged(&[notify("mast:needsInput", "")]).unread);
        assert!(merged(&[notify("mast:idle", "done")]).unread);
    }

    #[test]
    fn osc9_is_status_neutral() {
        let delta = merged(&[OscEvent::Osc9Notify("build done".into())]);
        assert_eq!(delta.status, None);
        assert!(delta.unread);
        assert_eq!(delta.message.as_deref(), Some("build done"));
    }

    #[test]
    fn unknown_mast_token_is_status_neutral() {
        // 규약 밖 제목(다른 도구의 777)은 상태를 주장하지 못하고 알림만 남긴다.
        let delta = merged(&[notify("Build", "finished"), notify("mast:bogus", "")]);
        assert_eq!(delta.status, None);
        assert!(delta.unread);
        assert_eq!(delta.message.as_deref(), Some("finished"));
    }

    #[test]
    fn title_and_cwd_never_set_unread() {
        let delta = merged(&[
            OscEvent::Osc0Title("t".into()),
            OscEvent::Osc7Cwd("file://host/p".into()),
        ]);
        assert!(!delta.unread);
    }

    #[test]
    fn message_truncated_at_multibyte_boundary() {
        // 500자 초과 한글 메시지 — 바이트로 자르면 panic 하는 구간이다.
        let body: String = "한".repeat(600);
        let delta = merged(&[notify("mast:idle", &body)]);
        let msg = delta.message.expect("message");
        assert_eq!(msg.chars().count(), MAX_MESSAGE_CHARS);
        assert_eq!(msg.len(), MAX_MESSAGE_CHARS * 3);
        assert!(msg.chars().all(|c| c == '한'));
    }

    #[test]
    fn message_at_or_below_cap_kept_whole() {
        let body: String = "a".repeat(MAX_MESSAGE_CHARS);
        let delta = merged(&[notify("mast:idle", &body)]);
        assert_eq!(delta.message.as_deref(), Some(body.as_str()));
    }

    #[test]
    fn file_uri_percent_decoded_and_host_ignored() {
        let delta = merged(&[OscEvent::Osc7Cwd(
            "file://wsl-host/home/u/my%20dir/%ED%95%9C".into(),
        )]);
        assert_eq!(delta.cwd.as_deref(), Some("/home/u/my dir/한"));
    }

    /// 래퍼 emitter(`host.rs` 의 `OSC7`)와의 형태 계약 — 그쪽은 `%` 만 `%25` 로 바꾸고
    /// 공백·비ASCII 는 그대로 보낸다. 그 조합이 무손실로 돌아오는 것이 매 프롬프트마다
    /// 서브셸 없이 파라미터 확장만 쓰는 근거다 (인코딩을 늘리면 여기도 같이 늘어난다).
    #[test]
    fn wrapper_emitter_shape_round_trips() {
        let delta = merged(&[OscEvent::Osc7Cwd("file:///tmp/wm test/100%25dir/한".into())]);
        assert_eq!(delta.cwd.as_deref(), Some("/tmp/wm test/100%dir/한"));
    }

    #[test]
    fn file_uri_empty_host_and_bad_escape() {
        assert_eq!(
            merged(&[OscEvent::Osc7Cwd("file:///home/u".into())])
                .cwd
                .as_deref(),
            Some("/home/u")
        );
        // `%` 뒤가 hex 2자리가 아니면 리터럴로 남는다.
        assert_eq!(
            merged(&[OscEvent::Osc7Cwd("file://h/a%zz/b%".into())])
                .cwd
                .as_deref(),
            Some("/a%zz/b%")
        );
    }

    #[test]
    fn malformed_file_uri_creates_no_entry() {
        // 스킴 불일치·경로 없음은 슬롯조차 만들지 않아 배치가 빈 상태로 남는다.
        let mut batch = OscBatch::default();
        batch.merge(1, &OscEvent::Osc7Cwd("/plain/path".into()));
        batch.merge(1, &OscEvent::Osc7Cwd("file://hostonly".into()));
        assert!(batch.is_empty());
    }

    #[test]
    fn send_event_creates_no_batch_entry() {
        // 전송은 액션이라 코얼레싱 배치를 타지 않는다 (슬롯조차 만들지 않는다).
        let mut batch = OscBatch::default();
        batch.merge(
            1,
            &OscEvent::Osc777Send {
                target: "build".into(),
                text_b64: "aGk=".into(),
            },
        );
        assert!(batch.is_empty());
    }

    #[test]
    fn query_event_creates_no_batch_entry() {
        // 질의도 전송과 같은 규율 — 액션이라 슬롯조차 만들지 않는다.
        let mut batch = OscBatch::default();
        batch.merge(
            1,
            &OscEvent::Osc777Query {
                kind: "list-tabs".into(),
                reply_b64: "L3RtcC9yLmpzb24=".into(),
            },
        );
        assert!(batch.is_empty());
    }

    #[test]
    fn sessions_are_independent() {
        let mut batch = OscBatch::default();
        batch.merge(1, &notify("mast:needsInput", "a"));
        batch.merge(2, &OscEvent::Osc0Title("t".into()));
        assert_eq!(batch.entries.len(), 2);
        assert!(batch.entries[&1].unread);
        assert!(!batch.entries[&2].unread);
        assert_eq!(batch.entries[&2].title.as_deref(), Some("t"));
    }

    #[test]
    fn flood_of_events_keeps_one_slot_per_session() {
        // 세션당 슬롯 1개라는 메모리 상한을 관찰로 고정한다 (큐가 아니다).
        let mut batch = OscBatch::default();
        for i in 0..1000 {
            batch.merge(7, &OscEvent::Osc0Title(format!("t{i}")));
            batch.merge(7, &notify("mast:running", "x"));
        }
        assert_eq!(batch.entries.len(), 1);
        assert_eq!(batch.entries[&7].title.as_deref(), Some("t999"));
    }

    #[test]
    fn take_empties_the_batch() {
        let mut batch = OscBatch::default();
        batch.merge(1, &notify("mast:idle", "done"));
        assert!(!batch.is_empty());

        let taken = batch.take();
        assert!(batch.is_empty());
        assert_eq!(batch, OscBatch::default());
        assert_eq!(taken.entries.len(), 1);
        assert_eq!(taken.entries[&1].message.as_deref(), Some("done"));

        // 비워진 배치는 그대로 재사용된다.
        batch.merge(2, &OscEvent::Osc0Title("next".into()));
        assert_eq!(batch.entries.len(), 1);
        assert!(batch.entries.contains_key(&2));
    }
}
