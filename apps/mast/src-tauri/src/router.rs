//! OSC 알림 라우터 — PTY 리더가 감지한 OSC 이벤트를 flush 창 단위로 모아
//! Dispatcher 에 한 번에 반영한다 (18단계 계획 glue 계약, 계획 v2 9장).
//!
//! # 왜 배치인가
//!
//! OSC 는 이벤트당 상태 변이가 아니다. 이벤트마다 Dispatcher 를 건드리면 플러드
//! 하나가 스냅샷 발행·저장 예약을 이벤트 수만큼 유발한다 (ADR-0002 결정 1 의
//! snapshot-per-mutation cliff). 여기서는 리더가 [`OscBatch`] 슬롯에 흘려보내기만
//! 하고, worker 가 창당 한 번 [`Dispatcher::apply_osc`] 로 반영한다 — revision 도
//! 배치당 1회만 오른다.
//!
//! # 잠금 규율 (state.rs 잠금 규율의 연장)
//!
//! - [`OscRouter::push`] 는 pending lock 아래 merge + notify 뿐이다. **리더 스레드는
//!   Dispatcher lock 을 절대 잡지 않는다** — 잡는 순간 구조 변이(스폰 수십 ms)가
//!   터미널 리더를 멈춰 세우고 코얼레싱의 의미도 사라진다.
//! - worker 는 pending lock 을 **놓은 뒤에야** Dispatcher lock 을 잡는다. 두 lock 을
//!   동시에 쥐는 지점이 없어 잠금 순서 문제 자체가 성립하지 않는다.
//!
//! # 시각
//!
//! `apply_osc` 에 넣는 `now_ms` 는 UNIX epoch 기준 **벽시계** ms 다. `Tab.
//! last_activity_ms` 는 스냅샷에 실려 재시작을 넘어 남는 값이라, 프로세스 수명이
//! 원점인 reset supervisor 의 단조 시계와 달리 절대 시각이어야 한다.

use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use mast_core::notify::OscBatch;
use mast_core::osc::OscEvent;
use mast_core::session::SessionId;

use crate::state::{publish_state, AppState};
use crate::winlog;

/// 이 창 안에 도착한 OSC 는 한 배치로 합쳐진다.
const DEFAULT_FLUSH_MS: u64 = 100;

/// `MAST_OSC_FLUSH_MS` → flush 창 (`MAST_RESET_*` knob 과 같은 규율: 미설정은
/// 기본값, 잘못된 값은 기본값 + loud 경고 — 조용히 다른 의미로 해석하지 않는다).
/// 0 은 유효값이다: 창 없이 배치를 즉시 비운다 (코얼레싱만 꺼질 뿐 worker 는
/// 여전히 이벤트가 없으면 잠들어 있어 busy loop 이 아니다).
fn flush_window_from_env() -> Duration {
    let ms = match std::env::var("MAST_OSC_FLUSH_MS") {
        Err(std::env::VarError::NotPresent) => DEFAULT_FLUSH_MS,
        Err(err) => {
            winlog!(
                "osc: MAST_OSC_FLUSH_MS unreadable ({err}); \
                 using default {DEFAULT_FLUSH_MS}"
            );
            DEFAULT_FLUSH_MS
        }
        Ok(raw) => match raw.trim().parse::<u64>() {
            Ok(v) => v,
            Err(_) => {
                winlog!(
                    "osc: MAST_OSC_FLUSH_MS={raw:?} is not a non-negative integer; \
                     using default {DEFAULT_FLUSH_MS}"
                );
                DEFAULT_FLUSH_MS
            }
        },
    };
    Duration::from_millis(ms)
}

/// 시스템 시계가 epoch 이전이면(설정 이상) 0 — `last_activity_ms`·`ended_at_ms` 는 표시용
/// 타임스탬프라 여기서 부팅을 막을 이유는 없다.
pub(crate) fn now_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => u64::try_from(d.as_millis()).unwrap_or(u64::MAX),
        Err(_) => 0,
    }
}

struct RouterState {
    batch: OscBatch,
    /// [`OscRouter::drop`] 이 세운다 — worker 는 남은 배치를 비우고 종료한다.
    closed: bool,
}

/// `app` 은 반영 시점에만 쓰인다 (push 는 안 쓴다).
struct RouterInner {
    app: AppHandle,
    pending: Mutex<RouterState>,
    cond: Condvar,
}

/// sink(리더 스레드)와 관리 상태가 `Arc` 로 공유한다.
pub struct OscRouter {
    inner: Arc<RouterInner>,
    /// Drop 에서 join 하기 위해 Option — 꺼내서 join 한다 (Saver 와 같은 규율).
    worker: Option<thread::JoinHandle<()>>,
}

impl OscRouter {
    /// worker 스레드를 띄운다. `app` 은 반영 시점에 `AppState`(dispatcher)를 찾는
    /// 핸들 — manage 전에 만들어져도 무해하다 (배치가 생기려면 세션이 있어야 하고,
    /// 세션 스폰은 manage 뒤다 — main.rs 의 manage-first 불변식).
    pub fn spawn(app: AppHandle) -> Self {
        let window = flush_window_from_env();
        winlog!("osc: flush window {} ms", window.as_millis());
        let inner = Arc::new(RouterInner {
            app,
            pending: Mutex::new(RouterState {
                batch: OscBatch::default(),
                closed: false,
            }),
            cond: Condvar::new(),
        });
        let worker_inner = Arc::clone(&inner);
        let worker = thread::Builder::new()
            .name("mast-osc".into())
            .spawn(move || worker_loop(&worker_inner, window))
            // 스레드 생성 실패 = OSC 라우팅 전체 불능 — 가리지 않고 부팅 실패로.
            .expect("failed to spawn osc router thread");
        Self {
            inner,
            worker: Some(worker),
        }
    }

    /// **리더 스레드 핫패스** — 여기서 하는 일은 pending lock 아래 merge + notify 가
    /// 전부다 (모듈 doc 의 잠금 규율).
    pub fn push(&self, session: SessionId, event: &OscEvent) {
        let mut state = self.inner.pending.lock().unwrap();
        state.batch.merge(session, event);
        drop(state);
        self.inner.cond.notify_one();
    }

    /// 대기분을 지금 이 스레드에서 반영한다 — 앱 종료(`RunEvent::Exit`)에서
    /// **Saver flush 앞**에 부른다. 창(기본 100ms) 안의 마지막 cwd·상태가 정상
    /// 종료에서 유실되지 않게 하는 짝이다.
    pub fn flush_now(&self) {
        let batch = self.inner.pending.lock().unwrap().batch.take();
        apply_batch(&self.inner, batch);
    }
}

impl Drop for OscRouter {
    fn drop(&mut self) {
        // closed 를 세우고 깨우면 worker 는 남은 배치를 비운 뒤 루프를 빠져나온다.
        self.inner.pending.lock().unwrap().closed = true;
        self.inner.cond.notify_all();
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                winlog!("osc: router worker thread panicked");
            }
        }
    }
}

fn worker_loop(inner: &RouterInner, window: Duration) {
    loop {
        let mut state = inner.pending.lock().unwrap();
        // (1) predicate loop — 스퓨리어스 웨이크업에 안전하다.
        while state.batch.is_empty() && !state.closed {
            state = inner.cond.wait(state).unwrap();
        }
        if state.batch.is_empty() {
            // 여기 도달했으면 closed — 비울 것이 없으니 끝낸다.
            return;
        }
        // (2) 트레일링 대기: 창 안에 도착하는 후속 OSC 를 같은 배치에 모은다.
        //     종료 신호는 창 만료를 기다리지 않고 즉시 깬다 (Drop 의 join 지연 방지).
        let mut state = inner
            .cond
            .wait_timeout_while(state, window, |s| !s.closed)
            .unwrap()
            .0;
        // (3) take 직후 lock 해제 — Dispatcher lock 은 여기부터 잡는다.
        let batch = state.batch.take();
        drop(state);
        apply_batch(inner, batch);
    }
}

/// 배치를 Dispatcher 에 반영하고, **바뀐 경우에만** 스냅샷을 발행한다. 빈 배치는
/// lock 조차 잡지 않는다.
fn apply_batch(inner: &RouterInner, batch: OscBatch) {
    if batch.is_empty() {
        return;
    }
    let Some(managed) = inner.app.try_state::<AppState>() else {
        // 앱 teardown 중 관리 상태가 이미 내려간 경우뿐 — sink on_exit 과 같은 규율로
        // 기록만 남긴다.
        winlog!("osc: managed state unavailable; batch dropped");
        return;
    };
    let mut dispatcher = managed.dispatcher.lock().unwrap();
    if dispatcher.apply_osc(batch, now_ms()) {
        publish_state(&inner.app, &dispatcher);
    }
}
