//! `SessionSink` 구현 — 세션 출력·이벤트를 프론트엔드로 나른다.
//!
//! - 터미널 출력: `tauri::ipc::Channel` 에 `[u64 LE offset][bytes]` 프레임을
//!   `InvokeResponseBody::Raw` 로 전송한다 (JSON 직렬화 금지 — 계획 v2 2·12장).
//!   프론트는 offset 으로 replay 스냅샷과의 겹침을 dedup 한다 (계획 2장).
//! - exit: 마지막 화면을 기록 파일로 남기고, Dispatcher 에 `SessionExited` 를
//!   반영하고 `publish_state` 로 `state-changed` emit + 저장 예약한 뒤 세션·sink 를
//!   레지스트리에서 놓는다 (dispatch 와 함께 상태 변이의 유일한 두 경로 — 계획
//!   15단계 B-2 저장 훅. 순서 계약은 [`SinkHandle::on_exit`]).
//! - OSC: [`OscRouter`] 에 밀어넣기만 한다 — 모델 반영은 라우터 worker 가 flush
//!   창당 한 번 한다 (18단계 계획 glue 계약). 리더 스레드에서 Dispatcher lock 을
//!   잡지 않는 경계가 여기다.
//! - pane 간 전송(`OSC 777;mast-send`)·탭 열거 질의(`OSC 777;mast-query`)·
//!   색상 질의(`OSC 10/11 ;?`)만 예외로 라우터를 타지 않는다 — 상태 델타가 아니라
//!   **액션**이라 코얼레싱할 것이 없다 ([`deliver_send`]·[`deliver_query`]·
//!   [`answer_color_query`]).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};
use mast_core::command::{SessionEvent, TabInfo};
use mast_core::manager::{
    manager_reply_json, parse_manager_request, ManagerQueryError, ManagerRequest,
};
use mast_core::model::{AppState as CoreState, TabId, TabKind};
use mast_core::osc::OscEvent;
use mast_core::send::{decode_reply_path, decode_send_text};
use mast_core::session::{Delivery, SessionId, SessionSink};

use crate::router::{now_ms, OscRouter};
use crate::state::{publish_state, AppState, ExitInFlight};
use crate::{winlog, wintrace};

/// 세션 1개 분의 sink. 레지스트리(`SinkRegistry`)와 리더 스레드([`SinkHandle`])가
/// `Arc` 로 공유한다 — attach_terminal 이 실행 중인 세션의 채널 슬롯을 갈아끼울
/// 수 있어야 하기 때문.
pub struct TerminalSink {
    session: SessionId,
    /// 이 세션이 실린 터미널 탭 — exit 이 기록 파일을 어디에 쓸지 정하는 유일한
    /// 근거다 (파일명이 탭 id 유도, ADR-0018 D4). `ShellSpawnReq.history_tab` 이
    /// 없는 스폰(히스토리 미할당 경로)에서는 None 이고, 그 세션의 exit 은 기록을
    /// 남기지 않는다.
    tab: Option<TabId>,
    app: AppHandle,
    /// 프론트 출력 채널 슬롯. attach 시 장착되고, send 실패(webview 소멸 등)
    /// 시 해제된다 — 이후 출력은 Dropped(detach 모드)로 흐른다.
    channel: Mutex<Option<Channel<InvokeResponseBody>>>,
    /// 이 세션에 채널이 장착된 적이 있는가 — attach_terminal 이 "최초 attach"
    /// 판정에 쓴다. 최초 attach 의 replay 에 담긴 단말 질의(ConPTY 의 ESC[6n 등)
    /// 는 아직 아무도 응답하지 않은 **라이브 질의**라 xterm 이 응답해야 하고
    /// (미응답 시 conhost 가 CPR 을 기다리며 셸이 멈춘다 — 체크포인트 1 재시작
    /// 빈 화면 버그), 재-attach 의 replay 질의는 이전 프론트가 이미 응답한 낡은
    /// 질의라 응답을 억제해야 한다 (stray `R` 버그).
    attached_once: std::sync::atomic::AtomicBool,
    /// OSC 배치 라우터 — [`SessionSink::on_osc`] 가 이벤트를 흘려보내는 곳.
    router: Arc<OscRouter>,
}

impl TerminalSink {
    pub fn new(
        session: SessionId,
        tab: Option<TabId>,
        app: AppHandle,
        router: Arc<OscRouter>,
    ) -> Self {
        Self {
            session,
            tab,
            app,
            channel: Mutex::new(None),
            attached_once: std::sync::atomic::AtomicBool::new(false),
            router,
        }
    }

    /// attach 이력을 기록하고 **이전 값**(이미 attach 된 적 있었는지)을 돌려준다.
    pub fn mark_attached(&self) -> bool {
        self.attached_once
            .swap(true, std::sync::atomic::Ordering::Relaxed)
    }

    /// 새 출력 채널을 슬롯에 장착한다 (기존 채널은 대체·폐기).
    ///
    /// **호출 순서 불변식**: `attach_terminal` 은 반드시 이 장착을 먼저 하고
    /// `PtySession::reattach()` 를 나중에 호출해야 한다 — 순서를 바꾸면 그 사이
    /// 출력이 스냅샷에도 채널에도 담기지 않는 유실 창이 생긴다 (reattach rustdoc).
    pub fn attach(&self, channel: Channel<InvokeResponseBody>) {
        *self.channel.lock().unwrap() = Some(channel);
    }

    /// 채널 슬롯을 분리한다 — 뷰 dispose(탭 전환 등) 시 호출. 슬롯이 남아 있으면
    /// 이후 출력이 send 성공(Delivered)인데 프론트는 버리고 ack 하지 않아 pending
    /// 이 high_water 까지 쌓여 백그라운드 세션이 paused 에 고착된다. 분리하면
    /// 출력이 Dropped(detach 모드)로 보상 롤백돼 세션이 자유 진행한다.
    pub fn detach(&self) {
        *self.channel.lock().unwrap() = None;
    }
}

/// `SessionManager::create` 에 넘기는 `Box<dyn SessionSink>` 어댑터 —
/// 레지스트리와 같은 `TerminalSink` 를 공유한다.
pub struct SinkHandle(pub Arc<TerminalSink>);

impl SessionSink for SinkHandle {
    fn on_output(&self, offset: u64, bytes: &[u8]) -> Delivery {
        let mut slot = self.0.channel.lock().unwrap();
        let Some(channel) = slot.as_ref() else {
            // 채널 미장착(attach 전·해제 후) — 리더가 flow 를 보상 롤백하는
            // detach 모드. 출력은 replay buffer 에만 쌓인다.
            return Delivery::Dropped;
        };
        let mut frame = Vec::with_capacity(8 + bytes.len());
        frame.extend_from_slice(&offset.to_le_bytes());
        frame.extend_from_slice(bytes);
        match channel.send(InvokeResponseBody::Raw(frame)) {
            Ok(()) => Delivery::Delivered,
            Err(err) => {
                // send 실패(webview 소멸 등) — 죽은 채널을 슬롯에서 해제해 이후
                // chunk 가 send 시도 없이 Dropped 로 빠지게 한다. 실패 자체는
                // 삼키지 않고 stderr 에 남긴다.
                winlog!(
                    "output channel send failed (session={}): {err}",
                    self.0.session
                );
                *slot = None;
                Delivery::Dropped
            }
        }
    }

    fn on_osc(&self, event: &OscEvent) {
        match event {
            // 전송·질의는 상태 델타가 아니라 액션이다 — 배치에 넣으면 flush 창만큼
            // 늦어지고 코얼레싱(last-wins)이 두 번째 요청을 삼킨다. 둘 다 리더
            // 스레드에서는 넘기기만 하고 실제 작업은 blocking 풀에서 돈다.
            OscEvent::Osc777Send { target, text_b64 } => {
                deliver_send(&self.0.app, self.0.session, target, text_b64);
            }
            OscEvent::Osc777Query { kind, reply_b64 } => {
                deliver_query(&self.0.app, self.0.session, kind, reply_b64);
            }
            // 색상 질의도 같은 이유로 즉시 처리한다 — 질의를 낸 TUI 앱은 응답을
            // 기다리는 중이라 flush 창만큼 늦출 수 없다 ([`answer_color_query`]).
            OscEvent::OscColorQuery { code } => {
                answer_color_query(&self.0.app, self.0.session, *code);
            }
            // 리더 스레드 핫패스 — 배치에 합치고 깨우기만 한다. 모델 반영은 라우터
            // worker 가 flush 창당 한 번 하며, 여기서 Dispatcher lock 을 잡지 않는다
            // (router.rs 잠금 규율).
            _ => self.0.router.push(self.0.session, event),
        }
    }

    /// 끝난 셸을 **세션에서 기록으로** 바꾸는 자리 (ADR-0018 D2). 호출자는 세션당
    /// 정확히 한 번 도는 **waiter 스레드**다.
    ///
    /// 순서가 계약이다 — ① 기록 재료를 떠내고(`take_record`) **①.5 이 스폰을 모델이
    /// 채택했는지 확인한 뒤** ② 파일로 쓰고 ③ Dispatcher lock 아래에서 모델을
    /// 갱신·publish 하고, lock 을 놓은 다음에야 ④ 세션·sink 를 레지스트리에서 놓고
    /// ⑤ 정합성 검사를 돌린다. ②가 ③보다 뒤면 프론트가 `state-changed` 를 보고 아직
    /// 없는 기록을 읽는 창이 생기고, ④가 ③보다 앞이면 프론트가 "Running + 세션 있음"
    /// 스냅샷으로 attach 해 미지 세션 에러를 본다. 파일 I/O 가 lock 밖인 것은
    /// `state.rs` 잠금 규율 그대로다.
    ///
    /// Dispatcher lock 을 여기서 잡아도 교착이 없는 근거는 종전과 같다: dispatch 가
    /// lock 아래에서 부르는 kill 은 join 없는 신호라(코어 rustdoc) 이 스레드의 종료를
    /// 기다리지 않는다. 탭이 먼저 닫힌 경우(CloseTab 선행)는 코어 `apply_event` 가
    /// 미지 세션을 무해한 no-op 으로 흘린다.
    fn on_exit(&self, code: Option<u32>) {
        let Some(state) = self.0.app.try_state::<AppState>() else {
            // 앱 teardown 중 관리 상태가 이미 내려간 경우뿐 — 기록만 남긴다.
            winlog!(
                "on_exit: managed state unavailable (session={})",
                self.0.session
            );
            return;
        };
        wintrace!("session {} exited (code={code:?})", self.0.session);

        // ① 세션 핸들에 거는 유일한 호출이다 (join 도, 두 번째 메서드도 없다 —
        // 여기서 세션을 기다리면 waiter 스레드가 자기 자신을 기다린다). `None` 일 수
        // 있다: `SessionManager::create` 는 `PtySession::spawn` 이 **반환한 뒤**
        // 레지스트리에 넣는데(session.rs) waiter 는 그 spawn 안에서 이미 돌기 시작하므로,
        // 즉사한 셸의 exit 이 등록을 앞지른다.
        let mut record = state
            .sessions
            .get(self.0.session)
            .and_then(|session| session.take_record());

        // ①.5 등록 장벽 겸 채택 확인. 스폰하는 dispatch 는 **하나의 Dispatcher lock
        // 임계구역 안에서** 레지스트리 삽입과 `pty_session` 기록을 끝내므로, 여기서
        // lock 을 한 번 잡았다 놓는 것만으로 둘 다 끝난 뒤임이 보장된다 — 그래서 ① 이
        // 빈손이었더라도 여기서 다시 떠내면 등록을 앞지른 exit 의 화면을 잃지 않는다.
        // 재조회가 lock 안인 것은 `take_record` 가 세션 자기 mutex 만 건드리기
        // 때문이다(Dispatcher → 세션, dispatch 와 같은 방향). **파일 쓰기는 여전히
        // lock 밖**이다 (`state.rs` 잠금 규율).
        let adopted = {
            let dispatcher = state.dispatcher.lock().unwrap();
            let adopted = dispatcher.tab_of_session(self.0.session) == self.0.tab;
            if adopted && record.is_none() {
                record = state
                    .sessions
                    .get(self.0.session)
                    .and_then(|session| session.take_record());
            }
            adopted
        };

        // ② 기록은 모델 갱신보다 먼저 디스크에 있어야 한다(위 순서 계약). 실패는
        // 한 줄로 드러내되 나머지 단계를 끊지 않는다 — 기록을 못 남기는 것과 탭이
        // 영영 Running 으로 남는 것은 무게가 다르다.
        //
        // **채택된 세션만 기록을 건드린다.** 모델이 이 탭에 싣지 않은 스폰(데드라인을
        // 넘겨 실패한 Restart 의 늦은 세션, 또는 이미 닫힌·정리된 탭)의 exit 이 파일을
        // 쓰거나 지우면 남의 화면을 덮는다 — 실패한 Restart 는 이전 기록을 보존한다는
        // 계약(ADR-0018 D4)이 거기서 깨진다. 늦은 세션의 레지스트리 자리는 스폰 쪽의
        // late cleanup 이 치운다.
        if adopted {
            match (self.0.tab, record) {
                (Some(tab), Some(bytes)) if !bytes.is_empty() => {
                    if let Err(err) = state.records.write(tab, &bytes) {
                        winlog!("on_exit: cannot write the record of tab {}: {err}", tab.0);
                    }
                }
                // 남길 화면이 없다(`take_record` 의 빈 바이트 계약) — 낡은 기록이 방금
                // 끝난 셸의 화면 행세를 하지 않게 지운다.
                (Some(tab), Some(_)) => {
                    if let Err(err) = state.records.remove(tab) {
                        winlog!("on_exit: cannot remove the record of tab {}: {err}", tab.0);
                    }
                }
                // ① 도 ①.5 의 재조회도 빈손 — 탭은 여전히 이 세션을 가리키는데
                // 레지스트리에는 없다, 즉 정합성 검사의 고아 해제 같은 다른 경로가
                // 핸들을 먼저 놓았다. 남길 화면이 애초에 없으므로 기존 기록은 둔다.
                (Some(_), None) => wintrace!(
                    "on_exit: session {} is already released; no record taken",
                    self.0.session
                ),
                (None, _) => winlog!(
                    "on_exit: session {} has no tab; no record written",
                    self.0.session
                ),
            }
        } else {
            wintrace!(
                "on_exit: session {} is not the session of tab {:?}; record untouched",
                self.0.session,
                self.0.tab.map(|tab| tab.0)
            );
        }

        // ③④ 는 밖에서 보면 하나여야 한다: 그 사이의 세션은 탭이 놓았는데 레지스트리에는
        // 남아 있어 동시에 도는 정합성 검사가 고아로 읽는다. 표식은 ③ 의 lock 을 잡기
        // **전**에 세운다 — 검사는 lock 아래에서 이 집합을 먼저 읽으므로(`audit`), 그래야
        // 검사가 이 id 를 못 본 회차에는 ③ 이 아직 일어나지 않았음이 보장된다. 가드로
        // 드는 것은 되감기 때문이다: ③④ 사이의 패닉이 표식을 남기면 그 뒤의 모든 검사가
        // 조용히 고아 판정을 버린다.
        let exiting = ExitInFlight::enter(&state.exits_in_flight, self.0.session);

        let mut dispatcher = state.dispatcher.lock().unwrap();
        dispatcher.apply_event(SessionEvent::SessionExited {
            session: self.0.session,
            code,
            ended_at_ms: now_ms(),
        });
        publish_state(&self.0.app, &dispatcher);
        // ③ 의 끝 — lock 은 스코프 끝이 아니라 여기서 놓는다, ④ 가 lock 밖이어야
        // 한다 (위 순서 계약).
        drop(dispatcher);

        // ④ 레지스트리 해제 — 이 탭은 더 이상 세션을 참조하지 않으므로 남겨 두면
        // 아무도 닿지 못하는 replay 버퍼와 sink 가 된다. `remove` 의 kill 은 멱등이라
        // 이미 죽은 자식에 무해하다.
        state.sinks.remove(self.0.session);
        state.sessions.remove(self.0.session);
        // ④ 의 끝 — 표식은 여기서 내린다. 이 세션은 이제 어느 레지스트리에도 없으므로
        // 고아 후보로 잡힐 수 없다.
        drop(exiting);

        // ⑤ 이 exit 이 어긋남을 남기지 않았는지 본다 — 검사도 Dispatcher lock 을 잡으므로
        // ④ 뒤, 즉 이 함수가 레지스트리를 다 정리한 뒤여야 방금 놓은 세션이 고아로
        // 잡히지 않는다 (ADR-0018 D5).
        crate::audit::run_audit(&self.0.app, &state, "exit");
    }

    fn on_startup_timeout(&self) {
        // 워치독 스레드에서 Dispatcher lock 을 잡는다 — on_exit 과 같은 규율이고 같은
        // 이유로 안전하다. 다만 이쪽은 세션을 죽이지 않으므로, 표식이 늦게 도착하면
        // 라우터 경로(OscBatch)가 이 상태를 되돌린다.
        let Some(state) = self.0.app.try_state::<AppState>() else {
            winlog!(
                "on_startup_timeout: managed state unavailable (session={})",
                self.0.session
            );
            return;
        };
        let mut dispatcher = state.dispatcher.lock().unwrap();
        dispatcher.apply_event(SessionEvent::SessionStartupTimeout {
            session: self.0.session,
        });
        publish_state(&self.0.app, &dispatcher);
    }
}

/// 진행 중 blocking 태스크 상한 (보안 리뷰 finding) — 전송([`deliver_send`])과
/// 질의([`deliver_query`])가 **하나의 카운터를 공유**한다. 임의 PTY 프로그램이
/// 이 채널들을 고속 연사하면 태스크가 무한히 쌓여 blocking 풀을 포화시키고,
/// paused 대상에의 write 도 9P 회신 파일 쓰기도 스레드를 오래 점유할 수 있다.
/// 보호 대상이 같은 풀 하나이므로 상한도 하나여야 한다 (채널마다 따로 두면
/// 합산 상한이 두 배가 된다). 초과분은 로그와 함께 폐기한다 — 협력 에이전트의
/// 정상 사용(초당 몇 건)에는 닿지 않는 수치다.
const MAX_IN_FLIGHT: usize = 8;
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// 카운터를 어떤 return 경로에서도 되돌리는 Drop 가드. [`acquire_in_flight`] 만
/// 이것을 만들 수 있다 — 증가 없는 감소로 짝이 어긋나는 길을 막는다.
struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 슬롯 하나를 확보한다 — 상한을 넘으면 되돌리고 `None`. 리더 스레드에서 부르고
/// 얻은 가드를 blocking 클로저 안으로 옮긴다: 클로저가 어느 경로로 끝나든, 또는
/// 실행되지 못한 채 버려지든 카운터가 회수된다.
fn acquire_in_flight() -> Option<InFlightGuard> {
    if IN_FLIGHT.fetch_add(1, Ordering::AcqRel) >= MAX_IN_FLIGHT {
        IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
        return None;
    }
    Some(InFlightGuard)
}

/// pane 간 텍스트 전송 (에이전트 채널 — `scripts/wsl/skills/mast-send/SKILL.md`).
/// `OSC 777;mast-send;<target>;<base64>` 를 받은 세션이 호출한다.
///
/// # 왜 즉시 처리하나
///
/// 알림은 **상태**라 flush 창에 모아 last-wins 로 합치는 것이 옳지만, 전송은
/// **액션**이다. 배치에 넣으면 (1) 창만큼 늦어지고 (2) 같은 창의 두 번째 전송이
/// 첫 번째를 덮어써 사라진다. 그래서 코얼레싱을 건너뛴다. **모델** 변이가 없으므로
/// 스냅샷 발행·저장 예약도 하지 않는다 (성공·실패 모두) — 단 리더 루프의 공통 OSC
/// 계정(`osc_count`·`last_osc = "777-send:<target>"`·replay 버퍼의 원본 시퀀스)은
/// 다른 OSC 와 똑같이 남는다 (payload 는 요약에 싣지 않아 유출 없음).
///
/// # 스레드·잠금
///
/// 호출자는 PTY **리더 스레드**다. 여기서 Dispatcher lock 을 잡거나 대상 PTY 에
/// write 하면 송신자 pane 의 출력이 그동안 멈춘다 (대상이 paused 면 write 는
/// 무기한 블록될 수도 있다). 그래서 실제 작업은 통째로 blocking 풀로 넘기고
/// (`commands.rs` 의 write 경로와 같은 규율), 그 안에서도 Dispatcher lock 은
/// 대상 해석에만 잡았다가 **write 전에 놓는다** (state.rs 잠금 규율).
///
/// # 실패
///
/// 디코드·대상 해석·write 실패는 전부 stderr 로만 남기고 **송신자 세션에는 아무
/// 것도 쓰지 않는다** — 진단 문자열이 남의 터미널 화면(그리고 replay 버퍼)에
/// 섞이면 그게 더 나쁜 오염이다. 송신 측에서 보면 전송은 무음 fire-and-forget 이다.
fn deliver_send(app: &AppHandle, sender: SessionId, target: &str, text_b64: &str) {
    let Some(guard) = acquire_in_flight() else {
        winlog!(
            "send: dropped from session {sender}: too many deliveries in flight \
             (cap {MAX_IN_FLIGHT})"
        );
        return;
    };
    let app = app.clone();
    let target = target.to_owned();
    let text_b64 = text_b64.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let bytes = match decode_send_text(&text_b64) {
            Ok(bytes) => bytes,
            Err(err) => {
                winlog!("send: rejected from session {sender}: {err}");
                return;
            }
        };
        let Some(state) = app.try_state::<AppState>() else {
            // 앱 teardown 중 관리 상태가 이미 내려간 경우뿐 (on_exit 과 같은 규율).
            winlog!("send: managed state unavailable; dropped");
            return;
        };
        // 대상 해석은 순수 조회다 — lock 은 조회 동안만 잡고 곧바로 놓는다.
        let resolved = state
            .dispatcher
            .lock()
            .unwrap()
            .resolve_send_target(sender, &target);
        let session = match resolved {
            Ok(session) => session,
            Err(err) => {
                winlog!("send: {err} (target={target:?}, from session {sender})");
                return;
            }
        };
        let Some(handle) = state.sessions.get(session) else {
            // 해석과 write 사이에 탭이 닫힌 경우 — 드물지만 정상 순서다.
            winlog!("send: target session {session} is gone; dropped");
            return;
        };
        if let Err(err) = handle.write(&bytes) {
            winlog!("send: write to session {session} failed: {err:#}");
        }
    });
}

/// 이 글루가 답하는 유일한 질의 종류. 다른 값은 [`deliver_query`] 에서 무응답으로
/// 떨어진다 (전방 호환 — 새 kind 를 아는 CLI 가 옛 mast 를 만나도 안전하다).
const QUERY_KIND_LIST_TABS: &str = "list-tabs";

/// 관리자 query 회신 파일의 unix 권한 — 소유자만 읽고 쓴다. 개요·이벤트
/// 회신은 요청자 워크스페이스 밖의 메타데이터까지 실으므로 전역 읽기를 열어 두지 않는다.
const MANAGER_REPLY_FILE_MODE: u32 = 0o600;

/// 관리자 kind 의 payload(base64 JSON)를 요청으로 되돌린다. base64·4 KiB 초과·UTF-8·
/// JSON·스키마 오류를 전부 [`ManagerQueryError::InvalidParams`] 로 접는다 — 어느
/// 단계에서 걸렸든 요청자에게는 같은 invalid_params 회신이 간다.
fn decode_manager_request(payload: &str) -> Result<ManagerRequest, ManagerQueryError> {
    decode_send_text(payload)
        .map_err(|_| ManagerQueryError::InvalidParams)
        .and_then(|bytes| parse_manager_request(&bytes))
}

/// 질의 회신 JSON 의 최상위 형태 — `{"tabs": [...], "self_tab": <탭 id|null>}`.
///
/// `tabs` 의 원소는 코어 [`TabInfo`] 의 직렬화형이다. `self_tab` 은 **요청자
/// 자신의 탭 id** 로, CLI 가 자기 행을 표시하거나 목록에서 빼는 데 쓴다. 요청자
/// 세션에 대응하는 탭을 못 찾으면 `null` 이다 — 나머지 목록은 그대로 유효하므로
/// 회신 자체를 버리지 않는다.
#[derive(serde::Serialize)]
struct QueryReply<'a> {
    tabs: &'a [TabInfo],
    self_tab: Option<u64>,
    #[cfg(target_os = "macos")]
    ttys: std::collections::BTreeMap<u64, String>,
}

/// 에이전트 질의 채널 (`OSC 777;mast-query;<kind>;<base64 회신 경로>`) —
/// **요청자와 같은 워크스페이스**의 탭 목록을 요청자가 지정한 `/tmp` 파일로
/// 회신한다 (범위 결정은 코어 몫 — [`mast_core::command::Dispatcher::list_tabs`]).
///
/// # 왜 즉시 처리하나
///
/// [`deliver_send`] 와 같은 이유다: 질의도 상태 델타가 아니라 **액션**이라
/// flush 창에 모을 것이 없고, 코얼레싱하면 같은 창의 두 번째 질의가 사라진다.
/// 모델 변이가 없으므로 스냅샷 발행·저장 예약도 하지 않는다.
///
/// # 스레드·잠금
///
/// 호출자는 PTY **리더 스레드**다. 여기서는 넘기기만 하고, Dispatcher lock 도
/// 9P 파일 쓰기(수십 ms 이상)도 blocking 풀 안에서 한다 — 리더가 잡히면 요청자
/// pane 의 출력이 그동안 멈춘다. lock 은 열거·역매핑 동안만 잡고 **파일 I/O 전에
/// 놓는다** (state.rs 잠금 규율). 진행 중 태스크 상한은 전송과 [`IN_FLIGHT`] 를
/// 공유한다.
///
/// # 실패
///
/// 경로 디코드·직렬화·파일 쓰기 실패는 전부 stderr 로만 남기고 **요청자 세션에는
/// 아무것도 쓰지 않는다** (전송과 같은 무음 계약 — 진단 문자열이 남의 터미널
/// 화면과 replay 버퍼를 오염시키는 쪽이 더 나쁘다). 회신 파일이 나타나지 않는
/// 것이 요청자가 보는 유일한 신호다.
fn deliver_query(app: &AppHandle, requester: SessionId, kind: &str, reply_b64: &str) {
    let Some(guard) = acquire_in_flight() else {
        winlog!(
            "query: dropped from session {requester}: too many deliveries in flight \
             (cap {MAX_IN_FLIGHT})"
        );
        return;
    };
    let app = app.clone();
    let kind = kind.to_owned();
    let reply_b64 = reply_b64.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        // 회신 경로 검증이 먼저다 — 경로가 불량하면 어떤 kind 든 답할 곳이 없다.
        let reply_path = match decode_reply_path(&reply_b64) {
            Ok(path) => path,
            Err(err) => {
                winlog!("query: rejected from session {requester}: {err}");
                return;
            }
        };
        if let Some(payload) = kind.strip_prefix("browser:") {
            let Some(state) = app.try_state::<AppState>() else { return };
            let (workspace, distro) = {
                let d = state.dispatcher.lock().unwrap();
                let (tab, distro) = requester_tab_and_distro(d.state(), requester);
                let workspace = tab.and_then(|id| d.state().workspaces.iter().find(|w| w.panes.values().any(|p| p.tabs.iter().any(|t| t.id.0 == id))).map(|w| w.id.0));
                (workspace, distro)
            };
            let result = match workspace {
                Some(workspace) => decode_send_text(payload).map_err(|e| e.to_string())
                    .and_then(|bytes| serde_json::from_slice::<crate::browser::Request>(&bytes).map_err(|e| e.to_string()))
                    .map(|request| crate::browser::execute(&app, request, Some(workspace))),
                None => Err("requester terminal no longer exists".into()),
            };
            let response = match result {
                Ok(Ok(value)) => serde_json::json!({"result": value}),
                Ok(Err(err)) => serde_json::json!({"error": err}),
                Err(message) => serde_json::json!({"error": {"code": "invalid_params", "message": message}}),
            };
            match serde_json::to_vec(&response) {
                Ok(bytes) if bytes.len() <= 24 * 1024 * 1024 => {
                    if let Err(err) = write_reply_file(distro, &reply_path, &bytes, None) { winlog!("browser reply failed: {err}"); }
                }
                _ => {
                    let _ = write_reply_file(distro, &reply_path, br#"{"error":{"code":"too_large","message":"Browser response exceeds 24 MiB"}}"#, None);
                }
            }
            return;
        }
        if let Some(payload) = kind.strip_prefix("manager:") {
            let Some(state) = app.try_state::<AppState>() else { return };
            // 요청 디코드·파싱은 순수하고 Dispatcher 상태가 필요 없다 — 실패도 회신으로
            // 답한다(무응답이 아니라). 권한 판정과 distro 역매핑은 한 lock 스냅샷으로
            // 읽고, 직렬화·파일 I/O 는 lock 밖이다 (list-tabs 와 같은 잠금 규율).
            let request = decode_manager_request(payload);
            let (result, distro) = {
                let dispatcher = state.dispatcher.lock().unwrap();
                let result = match &request {
                    Ok(request) => dispatcher.manager_query(requester, request),
                    Err(error) => Err(*error),
                };
                let (_, distro) = requester_tab_and_distro(dispatcher.state(), requester);
                (result, distro)
            };
            // 거부는 회신으로만이 아니라 앱 로그에도 한 줄 남긴다 — 요청 내용과 경로는
            // 어느 쪽에도 싣지 않는다 (회신 경로 규율).
            if let Err(ManagerQueryError::Forbidden) = result {
                winlog!("manager query: forbidden from session {requester}");
            }
            let json = manager_reply_json(result);
            if let Err(err) = write_reply_file(
                distro,
                &reply_path,
                json.as_bytes(),
                Some(MANAGER_REPLY_FILE_MODE),
            ) {
                winlog!("manager query: reply for session {requester} failed: {err}");
            }
            return;
        }
        if kind != QUERY_KIND_LIST_TABS {
            winlog!(
                "query: unsupported kind {kind:?} from session {requester}; ignored"
            );
            return;
        }
        let Some(state) = app.try_state::<AppState>() else {
            // 앱 teardown 중 관리 상태가 이미 내려간 경우뿐 (send 와 같은 규율).
            winlog!("query: managed state unavailable; dropped");
            return;
        };
        // 열거와 요청자 역매핑은 둘 다 순수 조회다 — 한 번 잡은 lock 아래에서
        // 같이 읽어 두 조회가 서로 다른 순간의 상태를 보는 일을 막고, 파일 I/O
        // 전에 놓는다.
        // macOS 의 tty 이름표도 같은 lock 아래에서 만든다 — tabs·self_tab 과 다른
        // 순간의 상태를 보면 방금 열거한 탭의 세션이 바뀌어 있을 수 있다.
        #[cfg(target_os = "macos")]
        let ttys;
        let (tabs, self_tab, distro) = {
            let dispatcher = state.dispatcher.lock().unwrap();
            // 열거 범위는 코어가 요청자 세션에서 워크스페이스를 되짚어 정한다
            // (전송과 같은 격리 경계 — `Dispatcher::list_tabs`).
            let tabs = dispatcher.list_tabs(requester);
            let (self_tab, distro) = requester_tab_and_distro(dispatcher.state(), requester);
            #[cfg(target_os = "macos")]
            {
                let mut names = std::collections::BTreeMap::new();
                for ws in &dispatcher.state().workspaces {
                    for pane in ws.panes.values() {
                        for tab in &pane.tabs {
                            if !tabs.iter().any(|listed| listed.tab == tab.id.0) { continue; }
                            if let mast_core::model::TabKind::Terminal { pty_session: Some(id), .. } = &tab.kind {
                                if let Some(tty) = state.sessions.get(*id).and_then(|s| s.tty_name()) {
                                    names.insert(tab.id.0, tty);
                                }
                            }
                        }
                    }
                }
                ttys = names;
            }
            (tabs, self_tab, distro)
        };
        let json = match serde_json::to_vec(&QueryReply {
            tabs: &tabs,
            self_tab,
            #[cfg(target_os = "macos")]
            ttys,
        }) {
            Ok(json) => json,
            Err(err) => {
                winlog!("query: cannot serialize reply for session {requester}: {err}");
                return;
            }
        };
        if let Err(err) = write_reply_file(distro, &reply_path, &json, None) {
            winlog!("query: reply for session {requester} failed: {err}");
        }
    });
}

/// 요청자 세션의 **탭 id** 와 그 탭이 속한 워크스페이스의 **distro** 를 역으로
/// 찾는다 — `Dispatcher::resolve_send_target` 의 순회와 같은 모양이되, 거기가
/// 세션 → 상대라면 여기는 세션 → 자기 자신이다.
///
/// distro 가 필요한 이유는 회신이 **파일 쓰기**이기 때문이다: 요청자가 도는
/// 배포판의 `/tmp` 에 놓아야 그 셸이 방금 지정한 경로에서 읽는다. 못 찾으면
/// `None` 을 주고 `commands::host_path` 의 기본 해석에 맡긴다 (`MAST_DISTRO` →
/// `wsl.exe` 기본 배포판) — 터미널 스폰이 distro 없는 워크스페이스를 다루는
/// 방식과 같은 기본값이다.
///
/// 터미널 상태(Running/Exited)는 보지 않는다. 요청자는 방금 OSC 를 낸 살아 있는
/// 세션이고, 여기서 알아야 할 것은 "이 세션이 어느 탭·워크스페이스에 있나"뿐이다.
fn requester_tab_and_distro(
    state: &CoreState,
    requester: SessionId,
) -> (Option<u64>, Option<String>) {
    for ws in &state.workspaces {
        for pane in ws.panes.values() {
            for tab in &pane.tabs {
                let TabKind::Terminal {
                    pty_session: Some(session),
                    ..
                } = &tab.kind
                else {
                    continue;
                };
                if *session == requester {
                    return (Some(tab.id.0), ws.distro.clone());
                }
            }
        }
    }
    (None, None)
}

/// OSC 10/11 색상 질의에 대한 응답 시퀀스 — **테마 3자 동기화 계약**.
///
/// 값은 xterm 프론트의 `TERMINAL_THEME`(`apps/mast/src/features/terminal/settings.ts`)의
/// foreground `#cccccc` / background `#1e1e1e` 를, ConPTY 색 테이블에 내보내는
/// `host.rs` 의 `THEME_SYNC` 와 같은 색으로 적은 것이다. **셋 중 하나를 바꾸면
/// 나머지 둘도 같이 바꾼다** — 갈라지면 질의한 TUI 앱이 실제 배경과 다른 색을
/// 기준으로 자기 색을 골라 입력창이 배경에 묻힌다 (이 기능이 고치려는 그 결함).
///
/// 형식은 xterm 관례인 `rgb:<r>/<g>/<b>` 이고 컴포넌트마다 **4자리**(16bit
/// 확장 — `cc` → `cccc`), 종결은 ST(`ESC \`)다. Codex 의 `parse_osc_color` 가
/// 받는 형식이 이것이라 BEL 종결·짧은 자릿수로 줄이지 않는다.
const COLOR_REPLY_FOREGROUND: &str = "\x1b]10;rgb:cccc/cccc/cccc\x1b\\";
/// 배경(OSC 11) 응답 — 위 [`COLOR_REPLY_FOREGROUND`] 의 동기화 계약이 그대로 적용된다.
const COLOR_REPLY_BACKGROUND: &str = "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\";

/// OSC 10/11 색상 질의에 **질의를 낸 그 세션의 stdin** 으로 우리 테마 값을 답한다.
///
/// # 왜 앱이 답하나 (판단 반전)
///
/// 종전 판단은 "conhost 가 먼저 답하므로 응답기는 중복 = 역효과"였다. 2026-08-11
/// 실기 probe 가 그 전제를 뒤집었다 — **OSC 11 질의에 아무도 답하지 않았다**
/// (conhost 도, xterm 도). Codex 는 배경색을 못 받으면 입력창 배경을 아예 그리지
/// 않으므로 그 미응답이 곧 "입력칸 구분 없음"이다. 그래서 질의가 conhost 를
/// **통과해 우리 출력 스트림까지 도달한 경우**에 한해 우리가 덮어 답한다. 도달하지
/// 않으면 코어 스캐너가 이벤트를 내지 않아 이 경로가 발동조차 하지 않는다(무해).
/// 자세한 계약은 [`OscEvent::OscColorQuery`] rustdoc.
///
/// # 진단 관측점 (v0.3.1)
///
/// 응답할 때마다 stderr 에 한 줄 남긴다. **로그가 찍히지 않으면 질의가 conhost
/// 에서 소멸한 것**이고, 그러면 이 문제는 앱 밖(conhost) 문제로 종결된다 —
/// 검증 절차는 `docs/WINDOWS-BUILD.md` §10 "v0.3.1 — verification" 1번.
///
/// # 스레드·잠금
///
/// [`deliver_send`] 와 **같은 규율**이다: 호출자가 PTY 리더 스레드라 여기서 write
/// 하면 (대상이 paused 일 때) 그 pane 의 출력이 멈출 수 있다. 그래서 실제 쓰기는
/// `spawn_blocking` 으로 넘기고 진행 중 태스크 상한([`IN_FLIGHT`])도 전송·질의와
/// 공유한다 — 질의를 연사하는 TUI 앱이 blocking 풀을 포화시키지 못하게. Dispatcher
/// lock 은 아예 잡지 않는다 (대상이 요청자 자신이라 해석할 것이 없다).
///
/// # 실패
///
/// 전송·질의와 같은 무음 계약 — 실패는 stderr 로만 남긴다.
fn answer_color_query(app: &AppHandle, session: SessionId, code: u8) {
    let reply = match code {
        10 => COLOR_REPLY_FOREGROUND,
        11 => COLOR_REPLY_BACKGROUND,
        // 코어 파서가 10/11 만 이 이벤트로 만든다 — 다른 값이 오면 계약이 갈라진
        // 것이므로 지어낸 색으로 답하지 않고 드러낸다.
        other => {
            winlog!(
                "color query: unsupported code {other} (session={session}); ignored"
            );
            return;
        }
    };
    let Some(guard) = acquire_in_flight() else {
        winlog!(
            "color query: dropped from session {session}: too many deliveries in flight \
             (cap {MAX_IN_FLIGHT})"
        );
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let Some(state) = app.try_state::<AppState>() else {
            // 앱 teardown 중 관리 상태가 이미 내려간 경우뿐 (send 와 같은 규율).
            winlog!("color query: managed state unavailable; dropped");
            return;
        };
        let Some(handle) = state.sessions.get(session) else {
            // 질의와 write 사이에 탭이 닫힌 경우 — 드물지만 정상 순서다.
            winlog!("color query: session {session} is gone; dropped");
            return;
        };
        if let Err(err) = handle.write(reply.as_bytes()) {
            winlog!("color query: write to session {session} failed: {err:#}");
            return;
        }
        // v0.3.1 진단 관측점 — 이 줄이 없으면 질의가 conhost 에서 소멸한 것이다.
        winlog!("color query {code} answered (session={session})");
    });
}

/// 회신 JSON 을 **완성된 상태로만** 최종 경로에 나타나게 한다: 같은 디렉터리의
/// `<경로>.partial` 에 전부 쓰고 rename 한다.
///
/// 요청자 CLI 는 이 경로가 나타나기를 기다리다 읽는다. 최종 경로에 직접 쓰면
/// 아직 다 쓰이지 않은 파일을 읽어 JSON 파싱이 깨진다 (특히 9P 를 사이에 둔
/// 쓰기는 한 번에 끝나지 않는다). rename 은 같은 디렉터리 안이라 파일시스템
/// 경계를 넘지 않는다.
///
/// `mode` 가 `Some` 이면 unix 에서 회신 파일을 그 권한으로 만든다 — 관리자 query 만
/// [`MANAGER_REPLY_FILE_MODE`] 를 넘기고, `None`(list-tabs·browser)은 종전대로 시스템
/// 기본값을 쓴다. windows 호스트는 WSL 9P 경로에 쓰므로 권한 설정이 의미 없어 값을
/// 무시한다.
fn write_reply_file(
    distro: Option<String>,
    reply_path: &str,
    json: &[u8],
    mode: Option<u32>,
) -> Result<(), String> {
    let partial = crate::commands::host_path(distro.clone(), &format!("{reply_path}.partial"))?;
    let final_path = crate::commands::host_path(distro, reply_path)?;
    write_reply_partial(&partial, json, mode)
        .map_err(|err| format!("cannot write {}: {err}", partial.display()))?;
    std::fs::rename(&partial, &final_path).map_err(|err| {
        // 개명이 실패하면 우리가 만든 임시 파일만 남는다 — 치우고 나간다.
        let _ = std::fs::remove_file(&partial);
        format!(
            "cannot rename {} to {}: {err}",
            partial.display(),
            final_path.display()
        )
    })
}

/// [`write_reply_file`] 의 `.partial` 쓰기. `mode()` 는 **생성 시에만** 적용되므로,
/// 이전 회차가 다른 권한으로 남긴 `.partial` 이 있어도 `set_permissions` 로 계약 값을
/// 되찾는다. `mode: None` 은 `std::fs::write` 그대로다 (기존 두 회신의 동작 보존).
fn write_reply_partial(
    path: &std::path::Path,
    json: &[u8],
    mode: Option<u32>,
) -> std::io::Result<()> {
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::io::Write as _;
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(path)?;
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
        return file.write_all(json);
    }
    #[cfg(not(unix))]
    let _ = mode;
    std::fs::write(path, json)
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use super::*;

    /// 테스트별 새 임시 디렉터리 — 실제 쓰기·rename 을 확인하므로 빈 곳이 필요하다.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mast-sink-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn manager_payload_decodes_to_the_two_ops() {
        // `printf '%s' '<json>' | base64 -w0` 형태.
        assert_eq!(
            decode_manager_request("eyJvcCI6IndvcmtzcGFjZXMifQ==").unwrap(),
            ManagerRequest::Workspaces
        );
        assert_eq!(
            decode_manager_request("eyJvcCI6ImV2ZW50cyIsInNpbmNlIjozfQ==").unwrap(),
            ManagerRequest::Events { since: 3 }
        );
    }

    #[test]
    fn manager_payload_failures_map_to_the_invalid_params_reply_bytes() {
        for payload in [
            "not base64!",          // base64 알파벳 밖
            "bm90IGpzb24=",         // "not json"
            "eyJvcCI6Im5vcGUifQ==", // {"op":"nope"}
        ] {
            let error = decode_manager_request(payload).unwrap_err();
            assert_eq!(error, ManagerQueryError::InvalidParams, "{payload}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&manager_reply_json(Err(error))).unwrap(),
                serde_json::json!({
                    "error": {
                        "code": "invalid_params",
                        "message": "the manager request is not valid JSON within 4 KiB"
                    }
                })
            );
        }
        // 디코드 결과가 4 KiB 를 넘어도 같은 invalid_params 로 접힌다.
        let over = "A".repeat(mast_core::manager::MAX_MANAGER_REQUEST_BYTES / 3 * 4 + 4);
        assert_eq!(
            decode_manager_request(&over),
            Err(ManagerQueryError::InvalidParams)
        );
    }

    #[test]
    fn manager_reply_file_is_0600_even_over_a_stale_partial() {
        let dir = scratch("manager-reply");
        let path = dir.join("reply.json");
        let partial = dir.join("reply.json.partial");
        // 이전 회차가 남긴 .partial 의 권한이 달라도 계약(0600)을 되찾는다.
        std::fs::write(&partial, b"stale").unwrap();
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_reply_file(
            None,
            path.to_str().unwrap(),
            br#"{"result":{}}"#,
            Some(MANAGER_REPLY_FILE_MODE),
        )
        .unwrap();

        assert_eq!(mode_of(&path), 0o600);
        assert_eq!(std::fs::read(&path).unwrap(), br#"{"result":{}}"#);
        assert!(!partial.exists(), "partial 은 최종 이름으로 rename 된다");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_tabs_and_browser_replies_keep_the_stale_partial_mode() {
        let dir = scratch("default-reply");
        let path = dir.join("reply.json");
        let partial = dir.join("reply.json.partial");
        std::fs::write(&partial, b"stale").unwrap();
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_reply_file(None, path.to_str().unwrap(), br#"{}"#, None).unwrap();

        assert_eq!(mode_of(&path), 0o644, "기본 경로는 권한을 강제하지 않는다");
        std::fs::remove_dir_all(&dir).ok();
    }
}
