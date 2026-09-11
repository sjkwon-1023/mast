//! `SessionSink` 구현 — mast-core 세션의 출력·이벤트를 프론트엔드로 나른다.
//!
//! - 터미널 출력: `tauri::ipc::Channel`에 `InvokeResponseBody::Raw`로 바이너리 그대로
//!   전송한다. JSON 직렬화 금지(계획 v2 2·12장) — 프론트엔드는 ArrayBuffer로 받는다.
//! - OSC·exit: 저빈도이므로 일반 Tauri 이벤트(JSON)로 emit한다.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use mast_core::osc::OscEvent;
use mast_core::session::{Delivery, SessionId, SessionSink};

/// `osc-event` 이벤트 payload — 프론트엔드 계약과 일치:
/// `{ id, kind: "777"|"9"|"7"|"0", title, body }`.
#[derive(Clone, serde::Serialize)]
pub struct OscEventPayload {
    pub id: u32,
    pub kind: &'static str,
    pub title: String,
    pub body: String,
}

impl OscEventPayload {
    /// mast-core `OscEvent` → 프론트엔드 계약 형태로 변환.
    /// kind별 배치: 777은 title/body 그대로, 9는 알림 메시지를 body에,
    /// 7은 cwd URI를 body에, 0은 창 제목을 title에 둔다 (비는 칸은 빈 문자열).
    pub fn from_event(id: u32, event: &OscEvent) -> Self {
        match event {
            OscEvent::Osc0Title(title) => Self {
                id,
                kind: "0",
                title: title.clone(),
                body: String::new(),
            },
            OscEvent::Osc7Cwd(uri) => Self {
                id,
                kind: "7",
                title: String::new(),
                body: uri.clone(),
            },
            OscEvent::Osc9Notify(message) => Self {
                id,
                kind: "9",
                title: String::new(),
                body: message.clone(),
            },
            OscEvent::Osc777Notify { title, body } => Self {
                id,
                kind: "777",
                title: title.clone(),
                body: body.clone(),
            },
            // pane 간 전송(mast-send)은 MVP 앱의 기능이고 이 계측 하네스는
            // 전달을 구현하지 않는다 (frozen — ADR-0001 재현 rig). 관측만 되게
            // 대상만 실어 보낸다: base64 payload 는 프론트 표시에 쓸모가 없다.
            OscEvent::Osc777Send { target, .. } => Self {
                id,
                kind: "777-send",
                title: target.clone(),
                body: String::new(),
            },
            // 질의(mast-query)도 전송과 같이 MVP 앱의 기능이다 — 관측만 되게
            // 종류만 싣는다 (회신 경로는 프론트 표시에 쓸모가 없다).
            OscEvent::Osc777Query { kind, .. } => Self {
                id,
                kind: "777-query",
                title: kind.clone(),
                body: String::new(),
            },
            // 색상 질의(OSC 10/11 `?`)에 대한 응답도 MVP 앱의 기능이다 — frozen
            // 하네스는 답하지 않고 관측만 한다 (10 = 전경, 11 = 배경).
            OscEvent::OscColorQuery { code } => Self {
                id,
                kind: "color-query",
                title: code.to_string(),
                body: String::new(),
            },
            // 시작 표식도 MVP 앱의 기능이다 — frozen 하네스는 관측만 한다.
            OscEvent::Osc777Started => Self {
                id,
                kind: "777-started",
                title: String::new(),
                body: String::new(),
            },
            // DEC private mode·리셋은 OSC 가 아니라 코어 세션이 소비한다
            // (재-attach preamble — mast-core session.rs). sink 까지 오지 않으므로
            // 여기 팔은 exhaustive 검사를 만족시키는 것이 전부다.
            OscEvent::DecPrivateMode { .. } | OscEvent::TerminalReset { .. } => Self {
                id,
                kind: "dec-mode",
                title: String::new(),
                body: String::new(),
            },
        }
    }
}

/// `terminal-exit` 이벤트 payload — `{ id, code }` (code는 null 가능).
#[derive(Clone, serde::Serialize)]
pub struct TerminalExitPayload {
    pub id: u32,
    pub code: Option<u32>,
}

/// 세션 1개 분의 sink. 리더 스레드에서 호출되므로 Send + 'static.
pub struct ChannelSink {
    id: SessionId,
    channel: Channel<InvokeResponseBody>,
    app: AppHandle,
}

impl ChannelSink {
    pub fn new(id: SessionId, channel: Channel<InvokeResponseBody>, app: AppHandle) -> Self {
        Self { id, channel, app }
    }
}

impl SessionSink for ChannelSink {
    fn on_output(&self, _offset: u64, bytes: &[u8]) -> Delivery {
        // offset 은 무시한다 — spike 프론트는 프레이밍 없이 raw 바이트를 그대로
        // 받는 기존 계약을 유지한다 (`[u64 LE offset]` 프레이밍은 새 앱 전용).
        match self.channel.send(InvokeResponseBody::Raw(bytes.to_vec())) {
            Ok(()) => Delivery::Delivered,
            Err(err) => {
                // 채널 send 실패(webview 소멸 등)는 Dropped 로 되돌린다 — 리더가
                // flow 계정을 보상 롤백하므로 세션은 detach 모드로 backpressure
                // 없이 자유 진행하며 replay buffer 에만 출력을 기록한다.
                // [측정 재현성 각주] 종전 spike 는 send 실패에도 계정을 유지해
                // webview 소멸 후 "paused 휴면"으로 갔다 — 이제는 "읽고 버림"으로
                // 거동이 달라지므로 spike-plan §6 측정 재현 시 이 차이를 감안할 것
                // (ADR-0002 시기의 변경). 실패 자체는 삼키지 않고 stderr 에 남긴다.
                eprintln!(
                    "[mast-spike] raw output channel send failed (id={}): {err}",
                    self.id
                );
                Delivery::Dropped
            }
        }
    }

    fn on_osc(&self, event: &OscEvent) {
        let payload = OscEventPayload::from_event(self.id, event);
        if let Err(err) = self.app.emit("osc-event", payload) {
            eprintln!("[mast-spike] osc-event emit failed (id={}): {err}", self.id);
        }
    }

    fn on_exit(&self, code: Option<u32>) {
        let payload = TerminalExitPayload { id: self.id, code };
        if let Err(err) = self.app.emit("terminal-exit", payload) {
            eprintln!(
                "[mast-spike] terminal-exit emit failed (id={}): {err}",
                self.id
            );
        }
    }
}
