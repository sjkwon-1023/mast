use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

use mast_core::command::{Command, CommandOutput, NewTab};
use mast_core::model::{PaneId, TabId, TabKind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Webview};

use crate::state::{publish_state, AppState};
use crate::winlog;

const NATIVE_WAIT: Duration = Duration::from_secs(10);
const EVAL_RESULT_LIMIT: usize = 1_048_576;
const EVAL_ERROR_LIMIT: usize = 4_096;
const MAX_SCREENSHOT_PIXELS: f64 = 16_777_216.0;
const CAPTURE_TOTAL: Duration = Duration::from_secs(15);
const CAPTURE_READY: Duration = Duration::from_secs(2);
const CAPTURE_RESTORE: Duration = Duration::from_secs(3);
const CAPTURE_SCROLL_RESTORE: Duration = Duration::from_millis(250);
const EVAL_TIMEOUT_MESSAGE: &str = "Browser eval response limit exceeded. Page code may continue running if it started; reload or close the tab if an infinite loop or pending Promise keeps it stuck.";
const EVAL_GATE_MESSAGE: &str =
    "A previous eval on this tab has not finished; reload or close the tab";
const CAPTURE_RESTORE_MESSAGE: &str = "view was not restored";

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "macos")]
use self::macos as platform;
#[cfg(windows)]
use self::windows as platform;

pub struct BrowserState {
    enabled: bool,
    agent_eval: bool,
    eval_token: Option<String>,
    next_eval_id: AtomicU64,
    next_view_id: AtomicU64,
    next_capture_id: AtomicU64,
    next_surface_sequence: AtomicU64,
    surface_intents: Mutex<HashMap<(u64, String), u64>>,
    surface_targets: Mutex<HashMap<u64, SurfaceTarget>>,
    operation: Mutex<()>,
    visibility_posting: Mutex<()>,
    pages: Mutex<HashMap<u64, Page>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    tab: u64,
    url: String,
    title: String,
    loading: bool,
    error: Option<String>,
    visible: bool,
    owner: String,
    #[serde(skip)]
    bounds: Bounds,
    #[serde(skip)]
    document_generation: u64,
    #[serde(skip)]
    eval_gate: EvalGate,
    #[serde(skip)]
    view_generation: u64,
    #[serde(skip)]
    restore_pending: Option<CaptureRestore>,
    #[serde(skip)]
    suspend_deferred: bool,
}

#[derive(Clone, Copy, Debug)]
struct CaptureDimensions {
    width: u32,
    height: u32,
}

#[derive(Clone)]
struct CaptureRestore {
    request_id: u64,
    view_generation: u64,
    bounds: Bounds,
    visible: bool,
    owner: String,
    viewport: (f64, f64),
}

#[derive(Clone, PartialEq)]
struct SurfaceTarget {
    owner: String,
    bounds: Bounds,
    visible: bool,
}

#[derive(Clone)]
struct SurfaceIntentSnapshot {
    sequence: Option<u64>,
    target: SurfaceTarget,
}

#[derive(Clone, Default)]
struct EvalGate {
    pending: Option<PendingEval>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PendingEval {
    request_id: u64,
    document_generation: u64,
    timed_out: bool,
}

impl EvalGate {
    fn start(&mut self, request_id: u64, document_generation: u64) -> bool {
        if self.pending.is_some() {
            return false;
        }
        self.pending = Some(PendingEval {
            request_id,
            document_generation,
            timed_out: false,
        });
        true
    }

    fn time_out(&mut self, request_id: u64, document_generation: u64) {
        if let Some(pending) = self.pending.as_mut().filter(|pending| {
            pending.request_id == request_id && pending.document_generation == document_generation
        }) {
            pending.timed_out = true;
        }
    }

    fn complete(&mut self, request_id: u64, document_generation: u64) -> bool {
        if self.pending.is_some_and(|pending| {
            pending.request_id == request_id && pending.document_generation == document_generation
        }) {
            self.pending = None;
            true
        } else {
            false
        }
    }

    fn document_changed(&mut self) {
        self.pending = None;
    }

    fn in_flight(&self) -> bool {
        self.pending.is_some()
    }

    fn is_blocked(&self) -> bool {
        self.pending.is_some_and(|pending| pending.timed_out)
    }
}

fn should_suspend_after_document_change(eval_gate_was_blocked: bool, hidden: bool) -> bool {
    eval_gate_was_blocked && hidden
}

impl BrowserState {
    pub fn new(enabled: bool, agent_eval: bool) -> Self {
        let eval_token = if enabled && agent_eval {
            Some(
                mast_remote::generate_secure_token()
                    .expect("cannot generate the secure browser eval token"),
            )
        } else {
            None
        };
        Self {
            enabled,
            agent_eval,
            eval_token,
            next_eval_id: AtomicU64::new(1),
            next_view_id: AtomicU64::new(1),
            next_capture_id: AtomicU64::new(1),
            next_surface_sequence: AtomicU64::new(1),
            surface_intents: Mutex::new(HashMap::new()),
            surface_targets: Mutex::new(HashMap::new()),
            operation: Mutex::new(()),
            visibility_posting: Mutex::new(()),
            pages: Mutex::new(HashMap::new()),
        }
    }
}

pub fn enabled(app: &AppHandle) -> bool {
    app.try_state::<BrowserState>().is_some_and(|s| s.enabled)
}

pub fn agent_eval(app: &AppHandle) -> bool {
    app.try_state::<BrowserState>().is_none_or(|s| s.agent_eval)
}

pub fn has_pages(app: &AppHandle) -> bool {
    app.try_state::<BrowserState>()
        .is_some_and(|s| !s.pages.lock().unwrap().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_eval_setting_is_available_in_browser_state() {
        assert!(BrowserState::new(true, true).agent_eval);
        assert!(!BrowserState::new(true, false).agent_eval);
    }

    #[test]
    fn eval_arguments_reject_empty_values_unknown_options_and_out_of_range_timeouts() {
        let token = "A".repeat(43);
        let valid = json!({"expression": "document.title", "token": token});
        let (expression, _, timeout) = parse_eval_args(&valid).unwrap();
        assert_eq!(expression, "document.title");
        assert_eq!(timeout, Duration::from_millis(5000));

        for args in [
            json!({"expression": "  ", "token": "A".repeat(43)}),
            json!({"expression": 1, "token": "A".repeat(43)}),
            json!({"expression": "1", "token": "A".repeat(43), "timeoutMs": 0}),
            json!({"expression": "1", "token": "A".repeat(43), "timeoutMs": 10001}),
            json!({"expression": "1", "token": "A".repeat(43), "timeoutMs": 1.5}),
            json!({"expression": "1", "token": "A".repeat(43), "other": true}),
        ] {
            assert_eq!(parse_eval_args(&args).unwrap_err().code, "invalid_params");
        }
        assert_eq!(
            parse_eval_args(&json!({"expression": "1"}))
                .unwrap_err()
                .code,
            "unauthorized"
        );
        assert_eq!(
            parse_eval_args(&json!({})).unwrap_err().code,
            "unauthorized"
        );
        assert_eq!(
            parse_eval_args(&json!({"expression": "1", "token": 1}))
                .unwrap_err()
                .code,
            "unauthorized"
        );
        assert_eq!(
            parse_eval_args(&json!({"expression": "1", "token": "bad"}))
                .unwrap_err()
                .code,
            "unauthorized"
        );
    }

    #[test]
    fn eval_token_precedes_other_eval_argument_validation() {
        assert_eq!(
            parse_eval_args(&json!({"other": true})).unwrap_err().code,
            "unauthorized"
        );
        assert_eq!(
            validate_eval_token(
                &json!({"token": "B".repeat(43), "expression": ""}),
                &"A".repeat(43),
            )
            .unwrap_err()
            .code,
            "unauthorized"
        );
    }

    #[test]
    fn eval_response_limits_utf8_and_escaped_json_bytes() {
        let boundary = "한".repeat((EVAL_RESULT_LIMIT - 12) / 3);
        assert!(eval_response(Value::String(boundary.clone())).is_ok());
        assert_eq!(
            eval_response(Value::String(format!("{boundary}a\n")))
                .unwrap_err()
                .code,
            "too_large"
        );
        assert_eq!(
            eval_response(Value::String("\\\n".repeat(EVAL_RESULT_LIMIT / 2)))
                .unwrap_err()
                .code,
            "too_large"
        );
    }

    #[test]
    fn eval_error_truncation_preserves_utf8_boundaries() {
        let message = truncate_eval_error("한🙂".repeat(3000));
        assert!(message.len() <= EVAL_ERROR_LIMIT);
        assert!(std::str::from_utf8(message.as_bytes()).is_ok());
    }

    #[test]
    fn eval_token_validation_and_comparison_use_the_shared_constant_time_helper() {
        let expected = "a".repeat(43);
        assert!(valid_eval_token(&expected));
        assert!(!valid_eval_token(&"a".repeat(42)));
        assert!(!valid_eval_token(&format!("{}!", "a".repeat(42))));
        assert!(mast_remote::token_matches(&expected, &expected));
        assert!(!mast_remote::token_matches(
            &expected,
            &format!("b{}", &expected[1..])
        ));
    }

    #[test]
    fn eval_gate_blocks_until_matching_late_completion_or_document_change() {
        let mut gate = EvalGate::default();
        assert!(gate.start(1, 4));
        gate.time_out(1, 4);
        assert!(gate.is_blocked());
        assert!(!gate.complete(2, 4));
        assert!(!gate.complete(1, 3));
        assert!(gate.is_blocked());
        assert!(gate.complete(1, 4));
        assert!(!gate.is_blocked());

        assert!(gate.start(3, 4));
        gate.time_out(3, 4);
        gate.document_changed();
        assert!(!gate.is_blocked());
        assert!(!gate.complete(3, 4));
    }

    #[test]
    fn eval_operation_lock_respects_its_deadline() {
        let browser = BrowserState::new(false, false);
        let guard = browser.operation.lock().unwrap();
        let started = Instant::now();
        let result =
            acquire_operation_until(&browser, started + Duration::from_millis(10), eval_timeout);
        assert_eq!(result.unwrap_err().code, "timeout");
        assert!(started.elapsed() < Duration::from_millis(500));
        drop(guard);

        assert!(acquire_operation_until(
            &browser,
            Instant::now() + Duration::from_secs(1),
            eval_timeout
        )
        .is_ok());
    }

    #[test]
    fn workspace_check_precedes_eval_gate_error() {
        let mut gate_checked = false;
        assert_eq!(
            check_workspace_and_eval_gate(41, Some(42), || {
                gate_checked = true;
                true
            })
            .unwrap_err()
            .code,
            "not_found"
        );
        assert!(!gate_checked);
        assert_eq!(
            check_workspace_and_eval_gate(41, Some(41), || true)
                .unwrap_err()
                .code,
            "timeout"
        );
    }

    #[test]
    fn request_deadline_uses_the_supplied_receipt_time() {
        let received = Instant::now() - Duration::from_secs(3);
        assert_eq!(
            request_deadline(received, Duration::from_secs(5)),
            received + Duration::from_secs(5)
        );
    }

    #[test]
    fn fixed_capture_dimensions_validate_ranges_and_default_to_sixteen_ten() {
        for (width, expected) in [(320, 200), (324, 203), (1280, 800), (3840, 2400)] {
            let dimensions = capture_dimensions(&json!({"width": width}))
                .unwrap()
                .unwrap();
            assert_eq!(dimensions.height, expected);
        }
        let explicit = capture_dimensions(&json!({"width": 1280, "height": 720}))
            .unwrap()
            .unwrap();
        assert_eq!((explicit.width, explicit.height), (1280, 720));
        assert!(capture_dimensions(&json!({})).unwrap().is_none());
        assert!(capture_dimensions(&json!({"legacyOption": true}))
            .unwrap()
            .is_none());
        for args in [
            json!({"width": 319}),
            json!({"width": 3841}),
            json!({"width": 1280, "height": 239}),
            json!({"width": 1280, "height": 2161}),
            json!({"height": 720}),
            json!({"width": 1280.5}),
        ] {
            assert_eq!(
                capture_dimensions(&args).unwrap_err().code,
                "invalid_params"
            );
        }
    }

    #[test]
    fn fixed_capture_pixel_limit_uses_display_scale() {
        assert_eq!(screenshot_pixel_count(1280, 800, 1.0).unwrap(), 1_024_000);
        assert_eq!(screenshot_pixel_count(1280, 800, 1.5).unwrap(), 2_304_000);
        assert_eq!(
            screenshot_pixel_count(3840, 2400, 2.0).unwrap_err().code,
            "too_large"
        );
    }

    #[test]
    fn png_dimensions_are_read_from_ihdr_and_checked_with_one_pixel_tolerance() {
        let png_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe";
        let actual = png_dimensions(png_1x1).unwrap();
        assert_eq!(actual, (1, 1));
        assert!(dimensions_match(actual, (2, 2)));
        assert!(!dimensions_match(actual, (3, 1)));
        assert_eq!(png_dimensions("not a png"), None);
    }

    #[test]
    fn fixed_capture_checks_per_owner_surface_intent_sequences() {
        assert!(surface_intent_is_current(Some(9), 9));
        assert!(!surface_intent_is_current(Some(10), 9));
        assert!(!surface_intent_is_current(None, 9));
        assert!(!surface_intent_needs_reconciliation(Some(9), Some(9)));
        assert!(surface_intent_needs_reconciliation(Some(9), Some(10)));
        assert!(surface_intent_needs_reconciliation(Some(9), None));
        let before = SurfaceIntentSnapshot {
            sequence: Some(9),
            target: SurfaceTarget {
                owner: "view".into(),
                bounds: offscreen_bounds(),
                visible: true,
            },
        };
        let hidden = SurfaceIntentSnapshot {
            sequence: Some(10),
            target: SurfaceTarget {
                visible: false,
                ..before.target.clone()
            },
        };
        assert!(surface_snapshot_needs_reconciliation(&before, &hidden));
        assert!(!surface_snapshot_needs_reconciliation(&before, &before));
    }

    #[test]
    fn hide_all_invalidates_a_pending_show_from_another_owner() {
        let browser = BrowserState::new(false, false);
        record_surface_intent(&browser, 42, "A", None);
        let show = record_surface_intent(&browser, 42, "B", Some(offscreen_bounds()));
        record_hide_all_intents(&browser, 42, Some("A"));
        let snapshot = surface_intent_snapshot(
            &browser,
            42,
            SurfaceTarget {
                owner: "B".into(),
                bounds: offscreen_bounds(),
                visible: true,
            },
        );
        assert!(!surface_intent_is_current(snapshot.sequence, show));
        assert!(!snapshot.target.visible);
    }

    #[test]
    fn hide_all_invalidates_a_show_intent_for_a_tab_without_a_page() {
        let browser = BrowserState::new(false, false);
        let show = record_surface_intent(&browser, 42, "B", Some(offscreen_bounds()));

        let targets = invalidate_hide_all_intents(&browser);

        assert_eq!(targets, vec![(42, None)]);
        assert!(!current_surface_intent(&browser, 42, "B", show));
    }

    #[test]
    fn document_start_suspends_only_for_a_released_gate_on_a_hidden_tab() {
        for eval_gate_was_blocked in [false, true] {
            for hidden in [false, true] {
                assert_eq!(
                    should_suspend_after_document_change(eval_gate_was_blocked, hidden),
                    eval_gate_was_blocked && hidden,
                );
            }
        }
    }

    #[test]
    fn a_timed_out_eval_keeps_the_tab_in_flight_until_it_completes() {
        let mut gate = EvalGate::default();
        assert!(!gate.in_flight());
        assert!(gate.start(1, 3));
        gate.time_out(1, 3);
        assert!(gate.in_flight());
        assert!(gate.complete(1, 3));
        assert!(!gate.in_flight());
    }

    #[test]
    fn deferred_suspends_recheck_visibility_and_pending_eval() {
        let browser = BrowserState::new(false, false);
        for (tab, visible, in_flight) in [(1, false, false), (2, true, false), (3, false, true)] {
            let mut page = test_page();
            page.tab = tab;
            page.visible = visible;
            page.suspend_deferred = true;
            if in_flight {
                page.eval_gate.start(9, 0);
            }
            browser.pages.lock().unwrap().insert(tab, page);
        }
        assert_eq!(take_deferred_suspends(&browser), vec![1]);
        assert!(browser
            .pages
            .lock()
            .unwrap()
            .values()
            .all(|page| !page.suspend_deferred));
        assert!(take_deferred_suspends(&browser).is_empty());
    }

    #[test]
    fn capture_restore_failure_allows_non_javascript_actions() {
        assert!(!capture_restore_failure_blocks_action("reload"));
        assert!(!capture_restore_failure_blocks_action("navigate"));
        assert!(capture_restore_failure_blocks_action("snapshot"));
        assert!(capture_restore_failure_blocks_action("screenshot"));
    }

    #[test]
    fn late_hide_does_not_replace_a_newer_show_intent() {
        let browser = BrowserState::new(false, false);
        let hide = record_surface_intent(&browser, 42, "owner", None);
        let show = record_surface_intent(&browser, 42, "owner", Some(offscreen_bounds()));
        assert!(!current_surface_intent(&browser, 42, "owner", hide));
        assert!(current_surface_intent(&browser, 42, "owner", show));
        assert!(browser.surface_targets.lock().unwrap()[&42].visible);
    }

    #[test]
    fn pruning_removes_intents_and_targets_for_tabs_missing_from_the_model() {
        let browser = BrowserState::new(false, false);
        record_surface_intent(&browser, 41, "live", Some(offscreen_bounds()));
        record_surface_intent(&browser, 42, "closed", Some(offscreen_bounds()));
        prune_surface_entries(&browser, &[41].into_iter().collect());
        assert!(browser.surface_targets.lock().unwrap().contains_key(&41));
        assert!(!browser.surface_targets.lock().unwrap().contains_key(&42));
        assert!(browser
            .surface_intents
            .lock()
            .unwrap()
            .keys()
            .all(|(tab, _)| *tab == 41));
    }

    #[test]
    fn hide_keeps_the_page_bounds_that_were_actually_applied() {
        let browser = BrowserState::new(false, false);
        let applied = Bounds {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        browser.pages.lock().unwrap().insert(
            42,
            Page {
                tab: 42,
                url: String::new(),
                title: String::new(),
                loading: false,
                error: None,
                visible: true,
                owner: "A".into(),
                bounds: applied,
                document_generation: 0,
                eval_gate: EvalGate::default(),
                view_generation: 7,
                restore_pending: None,
            suspend_deferred: false,
            },
        );
        record_surface_intent(
            &browser,
            42,
            "A",
            Some(Bounds {
                width: 900.0,
                ..applied
            }),
        );
        record_surface_intent(&browser, 42, "A", None);
        let hidden = surface_intent_snapshot(&browser, 42, offscreen_target("A"));
        let page =
            update_surface_page_if_current(&browser, 42, 7, hidden.sequence, &hidden.target).unwrap();
        assert!(!page.visible);
        assert_eq!(page.bounds, applied);
    }

    #[test]
    fn surface_owner_is_known_only_after_a_show_intent() {
        let browser = BrowserState::new(false, false);
        assert!(!surface_owner_is_known(&browser, 42, "never-shown"));
        record_surface_intent(&browser, 42, "shown", Some(offscreen_bounds()));
        assert!(surface_owner_is_known(&browser, 42, "shown"));
        assert!(!surface_owner_is_known(&browser, 42, "never-shown"));
    }

    #[test]
    fn applied_bounds_are_recorded_even_when_the_intent_was_superseded() {
        let browser = BrowserState::new(false, false);
        let mut page = test_page();
        page.view_generation = 7;
        browser.pages.lock().unwrap().insert(42, page);
        let applied = Bounds {
            x: 0.0,
            y: 0.0,
            width: 900.0,
            height: 600.0,
        };
        record_applied_bounds(&browser, 42, 6, applied);
        assert_eq!(browser.pages.lock().unwrap()[&42].bounds, offscreen_bounds());
        record_applied_bounds(&browser, 42, 7, applied);
        assert_eq!(browser.pages.lock().unwrap()[&42].bounds, applied);
    }

    fn test_page() -> Page {
        Page {
            tab: 42,
            url: String::new(),
            title: String::new(),
            loading: false,
            error: None,
            visible: false,
            owner: String::new(),
            bounds: offscreen_bounds(),
            document_generation: 0,
            eval_gate: EvalGate::default(),
            view_generation: 0,
            restore_pending: None,
            suspend_deferred: false,
        }
    }

    fn offscreen_target(owner: &str) -> SurfaceTarget {
        SurfaceTarget {
            owner: owner.into(),
            bounds: offscreen_bounds(),
            visible: false,
        }
    }

    #[test]
    fn capture_restore_marker_is_cleared_only_by_matching_successful_retry() {
        let mut page = Page {
            tab: 42,
            url: String::new(),
            title: String::new(),
            loading: false,
            error: None,
            visible: false,
            owner: String::new(),
            bounds: offscreen_bounds(),
            document_generation: 0,
            eval_gate: EvalGate::default(),
            view_generation: 7,
            restore_pending: None,
            suspend_deferred: false,
        };
        mark_capture_restore(
            &mut page,
            3,
            CaptureViewport {
                width: 800.0,
                height: 600.0,
                dpr: 1.0,
            },
        );
        assert!(page.restore_pending.is_some());
        assert!(!clear_capture_restore(&mut page, 3, 6));
        assert!(page.restore_pending.is_some());
        assert!(clear_capture_restore(&mut page, 3, 7));
        assert!(page.restore_pending.is_none());
    }

    #[test]
    fn capture_restore_matches_viewport_scaled_to_the_applied_bounds() {
        let bounds = |width: f64, height: f64| Bounds {
            x: 0.0,
            y: 0.0,
            width,
            height,
        };
        let captured = (800.0, 600.0);
        let captured_bounds = bounds(800.0, 600.0);
        let applied_bounds = bounds(900.0, 600.0);
        assert!(capture_viewport_matches(
            captured,
            captured_bounds,
            applied_bounds,
            CaptureViewport {
                width: 900.0,
                height: 600.0,
                dpr: 1.0,
            },
        ));
        assert!(!capture_viewport_matches(
            captured,
            captured_bounds,
            captured_bounds,
            CaptureViewport {
                width: 802.0,
                height: 600.0,
                dpr: 1.0,
            },
        ));
        assert!(capture_viewport_matches(
            captured,
            captured_bounds,
            captured_bounds,
            CaptureViewport {
                width: 801.0,
                height: 599.0,
                dpr: 1.0,
            },
        ));
        assert!(!capture_viewport_matches(
            captured,
            captured_bounds,
            captured_bounds,
            CaptureViewport {
                width: 1280.0,
                height: 800.0,
                dpr: 1.0,
            },
        ));
        assert!(!capture_viewport_matches(
            captured,
            bounds(0.0, 600.0),
            applied_bounds,
            CaptureViewport {
                width: 900.0,
                height: 600.0,
                dpr: 1.0,
            },
        ));
    }

    #[test]
    fn capture_restore_matches_viewport_scaled_from_creation_bounds() {
        let captured_bounds = offscreen_bounds();
        let applied_bounds = Bounds {
            x: 0.0,
            y: 0.0,
            width: 700.0,
            height: 500.0,
        };
        assert!(capture_viewport_matches(
            (1024.0, 768.0),
            captured_bounds,
            applied_bounds,
            CaptureViewport {
                width: 700.0,
                height: 500.0,
                dpr: 1.0,
            },
        ));
    }

    #[test]
    fn capture_scroll_restore_requires_the_same_document_and_webview_generations() {
        let captured = (7, 11);
        assert!(capture_state_matches(captured, Some(captured)));
        assert!(!capture_state_matches(captured, Some((7, 12))));
        assert!(!capture_state_matches(captured, Some((8, 11))));
        assert!(!capture_state_matches(captured, None));
    }

    #[test]
    fn capture_scroll_restore_checks_performance_time_origin_before_scrolling() {
        let expression = capture_scroll_restore_expression(CaptureScroll {
            x: 10.0,
            y: 20.0,
            time_origin: 1234.5,
        });
        assert!(expression.contains("performance.timeOrigin === 1234.5"));
        assert!(expression.contains("scrollTo(10, 20)"));
    }

    #[test]
    fn eval_envelope_parse_failures_are_serialization_errors() {
        assert_eq!(
            parse_eval_envelope(r#"{"value":"\ud800"}"#)
                .unwrap_err()
                .code,
            "serialization_error"
        );
    }
}

#[derive(Debug, Serialize)]
pub struct BrowserError {
    code: &'static str,
    message: String,
}
type Result<T> = std::result::Result<T, BrowserError>;
fn error(code: &'static str, message: impl ToString) -> BrowserError {
    BrowserError {
        code,
        message: message.to_string(),
    }
}
fn native(err: impl ToString) -> BrowserError {
    error("browser_error", err)
}
fn unsupported_key() -> BrowserError {
    error(
        "not_supported",
        "Supported keys: Enter, Tab, Escape, Backspace, ArrowLeft/Up/Right/Down",
    )
}
fn check_enabled(app: &AppHandle) -> Result<()> {
    if enabled(app) {
        Ok(())
    } else {
        Err(error(
            "disabled",
            "Browser is disabled; enable browser.enabled and restart Mast",
        ))
    }
}

fn check_eval_enabled(app: &AppHandle) -> Result<()> {
    let Some(browser) = app.try_state::<BrowserState>() else {
        return Err(error("disabled", "Browser is disabled"));
    };
    if !browser.agent_eval {
        return Err(error(
            "disabled",
            "Agent eval is disabled by the user's settings (browser.agentEval)",
        ));
    }
    if !browser.enabled || browser.eval_token.is_none() {
        return Err(error(
            "disabled",
            "Browser is disabled; enable browser.enabled and restart Mast",
        ));
    }
    Ok(())
}

fn valid_eval_token(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn eval_token(args: &Value) -> Result<&str> {
    args.get("token")
        .and_then(Value::as_str)
        .filter(|token| valid_eval_token(token))
        .ok_or_else(|| {
            error(
                "unauthorized",
                "CLI and Mast app do not match; restart the terminal session.",
            )
        })
}

fn validate_eval_token(args: &Value, expected: &str) -> Result<()> {
    if mast_remote::token_matches(expected, eval_token(args)?) {
        Ok(())
    } else {
        Err(error(
            "unauthorized",
            "CLI and Mast app do not match; restart the terminal session.",
        ))
    }
}

fn parse_eval_args(args: &Value) -> Result<(&str, &str, Duration)> {
    let token = eval_token(args)?;
    let object = args
        .as_object()
        .ok_or_else(|| error("invalid_params", "Eval args must be an object"))?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "expression" | "token" | "timeoutMs"))
    {
        return Err(error("invalid_params", "Unknown eval option"));
    }
    let expression = args["expression"]
        .as_str()
        .filter(|expression| !expression.trim().is_empty())
        .ok_or_else(|| error("invalid_params", "expression must be a non-empty string"))?;
    let timeout = match args.get("timeoutMs") {
        None => 5_000,
        Some(value) => value
            .as_u64()
            .filter(|timeout| (1..=10_000).contains(timeout))
            .ok_or_else(|| error("invalid_params", "timeoutMs must be 1..10000 ms"))?,
    };
    Ok((expression, token, Duration::from_millis(timeout)))
}

fn eval_response(value: Value) -> Result<Value> {
    let response = json!({"value": value});
    let size = serde_json::to_vec(&response).map_err(native)?.len();
    if size > EVAL_RESULT_LIMIT {
        return Err(error("too_large", "Eval result exceeds 1 MiB"));
    }
    Ok(response)
}

pub(super) fn parse_eval_envelope(text: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|_| {
        eval_error(
            "serialization_error",
            "Page result could not be encoded as JSON",
        )
    })
}

fn truncate_eval_error(message: impl ToString) -> String {
    let message = message.to_string();
    let mut end = EVAL_ERROR_LIMIT.min(message.len());
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message[..end].to_owned()
}

fn eval_error(code: &'static str, message: impl ToString) -> BrowserError {
    error(code, truncate_eval_error(message))
}

fn eval_timeout() -> BrowserError {
    eval_error("timeout", EVAL_TIMEOUT_MESSAGE)
}

fn capture_timeout() -> BrowserError {
    error("timeout", "Fixed-size screenshot timed out")
}

fn page_not_ready() -> BrowserError {
    error(
        "not_found",
        "Browser tab has no page yet; run mast browser wait or open it first",
    )
}

fn acquire_operation_until<'a>(
    browser: &'a BrowserState,
    deadline: Instant,
    timeout_error: fn() -> BrowserError,
) -> Result<MutexGuard<'a, ()>> {
    loop {
        match browser.operation.try_lock() {
            Ok(guard) if Instant::now() < deadline => return Ok(guard),
            Ok(_) => return Err(timeout_error()),
            Err(TryLockError::Poisoned(error)) => {
                if Instant::now() < deadline {
                    return Ok(error.into_inner());
                }
                return Err(timeout_error());
            }
            Err(TryLockError::WouldBlock) => {
                let now = Instant::now();
                if now >= deadline {
                    return Err(timeout_error());
                }
                std::thread::sleep(Duration::from_millis(1).min(deadline - now));
            }
        }
    }
}

fn request_deadline(received: Instant, budget: Duration) -> Instant {
    received + budget
}

fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(eval_timeout)
}

fn is_js_action(action: &str) -> bool {
    matches!(
        action,
        "eval"
            | "screenshot"
            | "snapshot"
            | "click"
            | "fill"
            | "press"
            | "scroll"
            | "wait"
            | "console"
            | "errors"
    )
}

fn capture_restore_failure_blocks_action(action: &str) -> bool {
    is_js_action(action)
}

fn eval_blocked(app: &AppHandle, tab: u64) -> bool {
    app.try_state::<BrowserState>().is_some_and(|browser| {
        browser
            .pages
            .lock()
            .unwrap()
            .get(&tab)
            .is_some_and(|page| page.eval_gate.is_blocked())
    })
}

fn check_eval_gate(app: &AppHandle, tab: u64) -> Result<()> {
    if eval_blocked(app, tab) {
        Err(error("timeout", EVAL_GATE_MESSAGE))
    } else {
        Ok(())
    }
}

fn check_workspace_and_eval_gate(
    tab_workspace: u64,
    caller_workspace: Option<u64>,
    gate_blocked: impl FnOnce() -> bool,
) -> Result<()> {
    if caller_workspace.is_some_and(|workspace| workspace != tab_workspace) {
        return Err(error("not_found", "Tab is outside the caller workspace"));
    }
    if gate_blocked() {
        return Err(error("timeout", EVAL_GATE_MESSAGE));
    }
    Ok(())
}

fn clear_eval_gate(app: &AppHandle, tab: u64, request_id: u64, document_generation: u64) -> bool {
    if let Some(browser) = app.try_state::<BrowserState>() {
        if let Some(page) = browser.pages.lock().unwrap().get_mut(&tab) {
            return page.eval_gate.complete(request_id, document_generation);
        }
    }
    false
}

fn mark_eval_timed_out(app: &AppHandle, tab: u64, request_id: u64, document_generation: u64) {
    if let Some(browser) = app.try_state::<BrowserState>() {
        if let Some(page) = browser.pages.lock().unwrap().get_mut(&tab) {
            page.eval_gate.time_out(request_id, document_generation);
        }
    }
}

fn document_generation_is_current(app: &AppHandle, tab: u64, generation: u64) -> bool {
    app.try_state::<BrowserState>().is_some_and(|browser| {
        browser
            .pages
            .lock()
            .unwrap()
            .get(&tab)
            .is_some_and(|page| page.document_generation == generation)
    })
}

// suspend 는 페이지 타이머를 멈추므로, 응답을 기다리는 eval 이 남은 탭은 그 eval 이 끝나거나
// 문서가 바뀔 때까지 깨워 둔다. 끝나면 완료 콜백이나 Started 경로가 다시 suspend 한다.
fn eval_in_flight(browser: &BrowserState, tab: u64) -> bool {
    browser
        .pages
        .lock()
        .unwrap()
        .get(&tab)
        .is_some_and(|page| page.eval_gate.in_flight())
}

fn suspend_if_hidden(app: &AppHandle, tab: u64, view: &Webview) {
    let hidden = app.try_state::<BrowserState>().is_some_and(|browser| {
        !eval_in_flight(&browser, tab)
            && browser
                .pages
                .lock()
                .unwrap()
                .get(&tab)
                .is_some_and(|page| !page.visible)
    });
    if hidden {
        let _ = platform::suspend(view, false);
    }
}

/// operation 밖에서 숨김 suspend 를 요청한다. 표지를 남긴 뒤 처리를 시도하고, 다른 작업이
/// operation 을 쥐고 있으면 그 작업이 operation 을 놓은 뒤 [`DeferredSuspendDrain`] 이 처리한다.
fn defer_hidden_suspend(app: &AppHandle, tab: u64) {
    let Some(browser) = app.try_state::<BrowserState>() else {
        return;
    };
    if let Some(page) = browser.pages.lock().unwrap().get_mut(&tab) {
        page.suspend_deferred = true;
    }
    // 메인 스레드(완료 콜백·Started)에서 바로 suspend 하면 Tauri 가 즉시 실행해 큐에 이미
    // 게시된 hide 를 앞지르므로, 작업 스레드에서 게시해 큐 순서를 지킨다.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || drain_deferred_suspends(&app));
}

fn has_deferred_suspends(browser: &BrowserState) -> bool {
    browser
        .pages
        .lock()
        .unwrap()
        .values()
        .any(|page| page.suspend_deferred)
}

/// 표지를 남긴 쪽은 "표지 → try_lock", operation 을 놓은 쪽은 "해제 → 표지 확인 → try_lock" 순서라,
/// 어느 순서로 겹쳐도 둘 중 하나는 표지를 보고 operation 을 얻어 처리한다.
fn drain_deferred_suspends(app: &AppHandle) {
    let Some(browser) = app.try_state::<BrowserState>() else {
        return;
    };
    while has_deferred_suspends(&browser) {
        let Ok(_operation) = browser.operation.try_lock() else {
            return;
        };
        for tab in take_deferred_suspends(&browser) {
            if let Some(view) = app.get_webview(&label(tab)) {
                let _ = platform::suspend(&view, false);
            }
        }
    }
}

/// 표지를 모두 지우고, 지금도 숨김이며 응답 대기 eval 이 없는 탭만 돌려준다.
fn take_deferred_suspends(browser: &BrowserState) -> Vec<u64> {
    browser
        .pages
        .lock()
        .unwrap()
        .values_mut()
        .filter_map(|page| {
            let deferred = std::mem::take(&mut page.suspend_deferred);
            (deferred && !page.visible && !page.eval_gate.in_flight()).then_some(page.tab)
        })
        .collect()
}

/// operation 가드보다 먼저 선언해 operation 이 풀린 뒤에 drop 되게 한다.
struct DeferredSuspendDrain<'a> {
    app: &'a AppHandle,
}

impl Drop for DeferredSuspendDrain<'_> {
    fn drop(&mut self) {
        drain_deferred_suspends(self.app);
    }
}

fn workspace_exists(app: &AppHandle, workspace: u64) -> bool {
    let state = app.state::<AppState>();
    let exists = state
        .dispatcher
        .lock()
        .unwrap()
        .state()
        .workspaces
        .iter()
        .any(|item| item.id.0 == workspace);
    exists
}
fn label(tab: u64) -> String {
    format!("browser-{tab}")
}

fn target(app: &AppHandle, id: u64) -> Result<(u64, u64, String)> {
    let state = app.state::<AppState>();
    let d = state.dispatcher.lock().unwrap();
    for w in &d.state().workspaces {
        for p in w.panes.values() {
            if let Some(t) = p.tabs.iter().find(|t| t.id.0 == id) {
                return match &t.kind {
                    TabKind::Browser { url } => Ok((w.id.0, p.id.0, url.clone())),
                    _ => Err(error("not_found", "Target is not a browser tab")),
                };
            }
        }
    }
    Err(error("not_found", "Browser tab was closed"))
}

fn model_has_browser_tab(app: &AppHandle, id: u64) -> bool {
    app.state::<AppState>()
        .dispatcher
        .lock()
        .unwrap()
        .state()
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.panes.values())
        .flat_map(|pane| &pane.tabs)
        .any(|tab| tab.id.0 == id && matches!(tab.kind, TabKind::Browser { .. }))
}

fn event(app: &AppHandle, tab: u64, change: impl FnOnce(&mut Page)) {
    let state = app.state::<BrowserState>();
    let page = {
        let mut pages = state.pages.lock().unwrap();
        pages.get_mut(&tab).map(|page| {
            change(page);
            page.clone()
        })
    };
    if let Some(page) = page {
        let _ = app.emit_to("main", "browser-changed", page);
    }
}

fn save_location(app: AppHandle, tab: u64, url: String, title: Option<String>) {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut d = state.dispatcher.lock().unwrap();
        if d.update_browser(TabId(tab), &url, title.as_deref()).is_ok() {
            publish_state(&app, &d);
        }
    });
}

/// 페이지를 누르면 그 탭의 pane 을 활성으로 만든다. 자식 웹뷰가 마우스·포커스를 받아 메인
/// UI 의 pane 클릭 처리가 돌지 않기 때문이다. 키보드 포커스는 페이지에 남긴다.
fn activate_pane(app: &AppHandle, tab: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Ok((workspace, pane, _)) = target(&app, tab) else {
            return;
        };
        let state = app.state::<AppState>();
        let mut d = state.dispatcher.lock().unwrap();
        let active = d
            .state()
            .workspaces
            .iter()
            .any(|w| w.id.0 == workspace && w.active_pane.0 == pane);
        if !active
            && d.dispatch(Command::FocusPane { pane: PaneId(pane) })
                .is_ok()
        {
            publish_state(&app, &d);
        }
    });
}

pub fn prune(app: &AppHandle, model: &mast_core::model::AppState) {
    let Some(state) = app.try_state::<BrowserState>() else {
        return;
    };
    if !state.enabled {
        return;
    }
    let live_browser_tabs: HashSet<u64> = model
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.panes.values())
        .flat_map(|pane| &pane.tabs)
        .filter(|tab| matches!(tab.kind, TabKind::Browser { .. }))
        .map(|tab| tab.id.0)
        .collect();
    let closed = {
        let mut pages = state.pages.lock().unwrap();
        let closed: Vec<u64> = pages
            .keys()
            .copied()
            .filter(|id| !live_browser_tabs.contains(id))
            .collect();
        for id in &closed {
            pages.remove(id);
        }
        closed
    };
    prune_surface_entries(&state, &live_browser_tabs);
    for id in closed {
        if let Some(view) = app.get_webview(&label(id)) {
            platform::release(&view);
            let _ = view.close();
        }
    }
}

fn prune_surface_entries(browser: &BrowserState, live_browser_tabs: &HashSet<u64>) {
    browser
        .surface_intents
        .lock()
        .unwrap()
        .retain(|(tab, _), _| live_browser_tabs.contains(tab));
    browser
        .surface_targets
        .lock()
        .unwrap()
        .retain(|tab, _| live_browser_tabs.contains(tab));
}

fn record_hide_all_intents(browser: &BrowserState, tab: u64, page_owner: Option<&str>) {
    let mut intents = browser.surface_intents.lock().unwrap();
    let mut targets = browser.surface_targets.lock().unwrap();
    let target_owner = targets.get(&tab).map(|target| target.owner.clone());
    let mut owners: Vec<String> = intents
        .keys()
        .filter(|(intent_tab, _)| *intent_tab == tab)
        .map(|(_, owner)| owner.clone())
        .collect();
    if let Some(owner) = page_owner {
        owners.push(owner.to_owned());
    }
    if let Some(owner) = target_owner.as_ref() {
        owners.push(owner.clone());
    }
    owners.sort();
    owners.dedup();
    for owner in owners {
        intents.insert(
            (tab, owner),
            browser
                .next_surface_sequence
                .fetch_add(1, Ordering::Relaxed),
        );
    }
    if let Some(target) = targets.get_mut(&tab) {
        target.visible = false;
    }
}

fn hide_all_targets(browser: &BrowserState) -> Vec<(u64, Option<String>)> {
    let intents = browser.surface_intents.lock().unwrap();
    let surface_targets = browser.surface_targets.lock().unwrap();
    let pages = browser.pages.lock().unwrap();
    let mut tabs: HashMap<u64, Option<String>> = pages
        .values()
        .map(|page| (page.tab, Some(page.owner.clone())))
        .collect();
    for tab in intents.keys().map(|(tab, _)| *tab) {
        tabs.entry(tab).or_insert(None);
    }
    for tab in surface_targets.keys().copied() {
        tabs.entry(tab).or_insert(None);
    }
    tabs.into_iter().collect()
}

fn invalidate_hide_all_intents(browser: &BrowserState) -> Vec<(u64, Option<String>)> {
    let targets = hide_all_targets(browser);
    for (tab, page_owner) in &targets {
        record_hide_all_intents(browser, *tab, page_owner.as_deref());
    }
    targets
}

/// 최신 표시 의도를 읽고 그대로 show/hide 를 게시한다. 읽기와 게시를 한 잠금으로 묶어
/// native 큐의 마지막 show/hide 가 항상 그 시점의 최신 의도가 되게 한다. 작업 스레드에서
/// Tauri 의 show/hide 는 FIFO 큐에 게시만 하므로 이 잠금을 쥔 채 기다리는 일은 없다.
fn post_latest_visibility(
    browser: &BrowserState,
    tab: u64,
    view: &Webview,
    fallback_visible: bool,
) -> tauri::Result<bool> {
    let _posting = browser.visibility_posting.lock().unwrap();
    let visible = browser
        .surface_targets
        .lock()
        .unwrap()
        .get(&tab)
        .map_or(fallback_visible, |target| target.visible);
    if visible {
        view.show()?;
    } else {
        view.hide()?;
    }
    Ok(visible)
}

pub fn hide_all(app: &AppHandle) {
    let Some(state) = app.try_state::<BrowserState>() else {
        return;
    };
    let targets = invalidate_hide_all_intents(&state);
    for (tab, _) in targets {
        event(app, tab, |page| page.visible = false);
        if let Some(view) = app.get_webview(&label(tab)) {
            // 메인 스레드에서 부르면 Tauri 가 큐를 건너 즉시 실행해 이미 큐에 있는 show 보다
            // 앞서므로, 작업 스레드에서 게시해 큐 순서를 지킨다.
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<BrowserState>();
                if let Ok(false) = post_latest_visibility(&state, tab, &view, false) {
                    defer_hidden_suspend(&app, tab);
                }
            });
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
impl Bounds {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.0 && *v < 32768.0)
            && self.width >= 1.0
            && self.height >= 1.0
    }
}

fn capture_dimensions(args: &Value) -> Result<Option<CaptureDimensions>> {
    let Some(object) = args.as_object() else {
        return Ok(None);
    };
    if !object.contains_key("width") && !object.contains_key("height") {
        return Ok(None);
    }
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "width" | "height"))
    {
        return Err(error("invalid_params", "Unknown screenshot option"));
    }
    let Some(width_value) = object.get("width") else {
        if object.contains_key("height") {
            return Err(error("invalid_params", "height requires width"));
        }
        return Ok(None);
    };
    let width = width_value
        .as_u64()
        .filter(|width| (320..=3840).contains(width))
        .ok_or_else(|| {
            error(
                "invalid_params",
                "width must be an integer from 320 to 3840",
            )
        })? as u32;
    let height = match object.get("height") {
        Some(value) => value
            .as_u64()
            .filter(|height| (240..=2160).contains(height))
            .ok_or_else(|| {
                error(
                    "invalid_params",
                    "height must be an integer from 240 to 2160",
                )
            })? as u32,
        None => (width * 10 + 8) / 16,
    };
    Ok(Some(CaptureDimensions { width, height }))
}

fn screenshot_pixel_count(width: u32, height: u32, dpr: f64) -> Result<u64> {
    if !dpr.is_finite() || dpr <= 0.0 {
        return Err(error(
            "not_supported",
            "The browser reported an invalid display scale",
        ));
    }
    let pixels = f64::from(width) * f64::from(height) * dpr * dpr;
    if !pixels.is_finite() || pixels > MAX_SCREENSHOT_PIXELS {
        return Err(error("too_large", "Screenshot exceeds 16 megapixels"));
    }
    Ok(pixels.ceil() as u64)
}

fn png_dimensions(data: &str) -> Option<(u32, u32)> {
    let mut bytes = Vec::with_capacity(24);
    let mut buffer = 0u32;
    let mut bits = 0;
    for character in data.bytes().take(32) {
        let value = match character {
            b'A'..=b'Z' => character - b'A',
            b'a'..=b'z' => character - b'a' + 26,
            b'0'..=b'9' => character - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    if bytes.len() < 24
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
        || &bytes[12..16] != b"IHDR"
    {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

fn expected_png_dimensions(width: u32, height: u32, dpr: f64) -> (u32, u32) {
    (
        (f64::from(width) * dpr).round() as u32,
        (f64::from(height) * dpr).round() as u32,
    )
}

fn dimensions_match(actual: (u32, u32), expected: (u32, u32)) -> bool {
    actual.0.abs_diff(expected.0) <= 1 && actual.1.abs_diff(expected.1) <= 1
}

fn capture_step_timeout(deadline: Instant) -> Result<Duration> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| *remaining > CAPTURE_RESTORE)
        .ok_or_else(capture_timeout)?;
    Ok(NATIVE_WAIT.min(remaining - CAPTURE_RESTORE))
}

fn is_fixed_screenshot(request: &Request) -> bool {
    request.action == "screenshot" && request.args.get("width").is_some()
}

fn surface_intent_is_current(latest: Option<u64>, request: u64) -> bool {
    latest == Some(request)
}

fn surface_intent_needs_reconciliation(applied: Option<u64>, latest: Option<u64>) -> bool {
    applied != latest
}

fn surface_snapshot_needs_reconciliation(
    applied: &SurfaceIntentSnapshot,
    latest: &SurfaceIntentSnapshot,
) -> bool {
    surface_intent_needs_reconciliation(applied.sequence, latest.sequence)
        || applied.target != latest.target
}

fn current_surface_intent(browser: &BrowserState, tab: u64, owner: &str, sequence: u64) -> bool {
    surface_intent_is_current(
        browser
            .surface_intents
            .lock()
            .unwrap()
            .get(&(tab, owner.to_owned()))
            .copied(),
        sequence,
    )
}

fn record_surface_intent(
    browser: &BrowserState,
    tab: u64,
    owner: &str,
    bounds: Option<Bounds>,
) -> u64 {
    let mut intents = browser.surface_intents.lock().unwrap();
    // 잠금 안에서 발급해야 늦게 잠금을 얻은 요청이 더 새 의도를 낡은 순번으로 덮어쓰지 않는다.
    let sequence = browser
        .next_surface_sequence
        .fetch_add(1, Ordering::Relaxed);
    if bounds.is_some() {
        intents.retain(|(intent_tab, intent_owner), _| *intent_tab != tab || intent_owner == owner);
    }
    intents.insert((tab, owner.to_owned()), sequence);
    let mut targets = browser.surface_targets.lock().unwrap();
    match bounds {
        Some(bounds) => {
            targets.insert(
                tab,
                SurfaceTarget {
                    owner: owner.to_owned(),
                    bounds,
                    visible: true,
                },
            );
        }
        None => {
            if let Some(target) = targets.get_mut(&tab).filter(|target| target.owner == owner) {
                target.visible = false;
            }
        }
    }
    sequence
}

fn surface_owner_is_known(browser: &BrowserState, tab: u64, owner: &str) -> bool {
    let intents = browser.surface_intents.lock().unwrap();
    let targets = browser.surface_targets.lock().unwrap();
    intents.contains_key(&(tab, owner.to_owned()))
        || targets.get(&tab).is_some_and(|target| target.owner == owner)
}

fn clear_surface_intent_if_current(browser: &BrowserState, tab: u64, owner: &str, sequence: u64) {
    let mut intents = browser.surface_intents.lock().unwrap();
    if !surface_intent_is_current(intents.get(&(tab, owner.to_owned())).copied(), sequence) {
        return;
    }
    intents.remove(&(tab, owner.to_owned()));
    let mut targets = browser.surface_targets.lock().unwrap();
    if targets
        .get(&tab)
        .is_some_and(|target| target.owner == owner)
    {
        targets.remove(&tab);
    }
}

fn surface_intent_snapshot(
    browser: &BrowserState,
    tab: u64,
    fallback: SurfaceTarget,
) -> SurfaceIntentSnapshot {
    let intents = browser.surface_intents.lock().unwrap();
    let targets = browser.surface_targets.lock().unwrap();
    let target = targets.get(&tab).cloned().unwrap_or(fallback);
    let sequence = intents.get(&(tab, target.owner.clone())).copied();
    SurfaceIntentSnapshot { sequence, target }
}

fn update_surface_page_if_current(
    browser: &BrowserState,
    tab: u64,
    view_generation: u64,
    sequence: Option<u64>,
    target: &SurfaceTarget,
) -> Option<Page> {
    let intents = browser.surface_intents.lock().unwrap();
    let targets = browser.surface_targets.lock().unwrap();
    let latest_target = targets.get(&tab).unwrap_or(target);
    let latest_sequence = intents.get(&(tab, latest_target.owner.clone())).copied();
    if surface_intent_needs_reconciliation(sequence, latest_sequence)
        || latest_target.owner != target.owner
        || latest_target.bounds != target.bounds
        || latest_target.visible != target.visible
    {
        return None;
    }
    let mut pages = browser.pages.lock().unwrap();
    let page = pages
        .get_mut(&tab)
        .filter(|page| page.view_generation == view_generation)?;
    page.visible = target.visible;
    page.owner = target.owner.clone();
    Some(page.clone())
}

// Page.bounds 는 복원 판정의 기준이라 의도 순번과 무관하게 native 로 적용한 직후의 크기를 기록한다.
fn record_applied_bounds(browser: &BrowserState, tab: u64, view_generation: u64, bounds: Bounds) {
    if let Some(page) = browser
        .pages
        .lock()
        .unwrap()
        .get_mut(&tab)
        .filter(|page| page.view_generation == view_generation)
    {
        page.bounds = bounds;
    }
}

fn mark_capture_restore(page: &mut Page, request_id: u64, viewport: CaptureViewport) {
    page.restore_pending = Some(CaptureRestore {
        request_id,
        view_generation: page.view_generation,
        bounds: page.bounds,
        visible: page.visible,
        owner: page.owner.clone(),
        viewport: (viewport.width, viewport.height),
    });
}

fn clear_capture_restore(page: &mut Page, request_id: u64, view_generation: u64) -> bool {
    if page.restore_pending.as_ref().is_some_and(|restore| {
        restore.request_id == request_id && restore.view_generation == view_generation
    }) {
        page.restore_pending = None;
        true
    } else {
        false
    }
}

#[derive(Clone, Copy)]
struct CaptureViewport {
    width: f64,
    height: f64,
    dpr: f64,
}

#[derive(Clone, Copy)]
struct CaptureScroll {
    x: f64,
    y: f64,
    time_origin: f64,
}

fn parse_capture_viewport(value: &Value) -> Result<CaptureViewport> {
    let width = value["width"]
        .as_f64()
        .ok_or_else(|| error("timeout", "Browser viewport measurement did not respond"))?;
    let height = value["height"]
        .as_f64()
        .ok_or_else(|| error("timeout", "Browser viewport measurement did not respond"))?;
    let dpr = value["dpr"]
        .as_f64()
        .ok_or_else(|| error("timeout", "Browser viewport measurement did not respond"))?;
    if !width.is_finite() || !height.is_finite() || !dpr.is_finite() || dpr <= 0.0 {
        return Err(error(
            "not_supported",
            "The browser reported an invalid viewport measurement",
        ));
    }
    Ok(CaptureViewport { width, height, dpr })
}

fn measure_capture_viewport(view: &Webview, timeout: Duration) -> Result<CaptureViewport> {
    let value = platform::evaluate(
        view,
        "({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})",
        timeout,
    )?;
    parse_capture_viewport(&value)
}

fn parse_capture_scroll(value: &Value) -> Result<CaptureScroll> {
    let x = value["x"]
        .as_f64()
        .ok_or_else(|| error("timeout", "Browser scroll measurement did not respond"))?;
    let y = value["y"]
        .as_f64()
        .ok_or_else(|| error("timeout", "Browser scroll measurement did not respond"))?;
    let time_origin = value["timeOrigin"]
        .as_f64()
        .ok_or_else(|| error("timeout", "Browser scroll measurement did not respond"))?;
    if !x.is_finite() || !y.is_finite() || !time_origin.is_finite() {
        return Err(error(
            "not_supported",
            "The browser reported an invalid scroll position",
        ));
    }
    Ok(CaptureScroll { x, y, time_origin })
}

fn measure_capture_scroll(view: &Webview, timeout: Duration) -> Result<CaptureScroll> {
    let value = platform::evaluate(
        view,
        "({x: scrollX, y: scrollY, timeOrigin: performance.timeOrigin})",
        timeout,
    )?;
    parse_capture_scroll(&value)
}

fn restore_capture_scroll(view: &Webview, scroll: CaptureScroll, timeout: Duration) -> Result<()> {
    let expression = capture_scroll_restore_expression(scroll);
    let restored = platform::evaluate(view, &expression, timeout)?;
    if restored.as_bool() == Some(true) {
        Ok(())
    } else {
        Err(error(
            "browser_error",
            "Browser did not confirm scroll restoration",
        ))
    }
}

fn capture_scroll_restore_expression(scroll: CaptureScroll) -> String {
    format!(
        "(performance.timeOrigin === {} ? (scrollTo({}, {}), true) : false)",
        scroll.time_origin, scroll.x, scroll.y
    )
}

fn wait_for_capture_size(
    view: &Webview,
    dimensions: CaptureDimensions,
    overall_deadline: Instant,
) -> Result<CaptureViewport> {
    let restore_deadline = overall_deadline
        .checked_sub(CAPTURE_RESTORE)
        .ok_or_else(|| error("timeout", "Fixed-size screenshot timed out"))?;
    let ready_deadline = (Instant::now() + CAPTURE_READY).min(restore_deadline);
    loop {
        let now = Instant::now();
        if now >= ready_deadline {
            return Err(error(
                "not_supported",
                "The browser did not reach the requested viewport size",
            ));
        }
        let timeout = NATIVE_WAIT.min(ready_deadline - now);
        let viewport = measure_capture_viewport(view, timeout).map_err(|err| {
            if err.code == "timeout" {
                error("timeout", "Browser viewport measurement timed out")
            } else {
                err
            }
        })?;
        if (viewport.width - f64::from(dimensions.width)).abs() <= 1.0
            && (viewport.height - f64::from(dimensions.height)).abs() <= 1.0
        {
            return Ok(viewport);
        }
        let remaining = ready_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(error(
                "not_supported",
                "The browser did not reach the requested viewport size",
            ));
        }
        std::thread::sleep(Duration::from_millis(16).min(remaining));
    }
}

fn wait_for_capture_restore_viewport(
    view: &Webview,
    captured_viewport: (f64, f64),
    captured_bounds: Bounds,
    applied_bounds: Bounds,
    deadline: Instant,
) -> Result<CaptureViewport> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(error("browser_error", CAPTURE_RESTORE_MESSAGE));
        }
        let timeout = NATIVE_WAIT.min(deadline - now);
        let measured = measure_capture_viewport(view, timeout)
            .map_err(|_| error("browser_error", CAPTURE_RESTORE_MESSAGE))?;
        if capture_viewport_matches(
            captured_viewport,
            captured_bounds,
            applied_bounds,
            measured,
        ) {
            return Ok(measured);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(error("browser_error", CAPTURE_RESTORE_MESSAGE));
        }
        std::thread::sleep(Duration::from_millis(16).min(remaining));
    }
}

fn validate_screenshot_png(
    screenshot: &Value,
    dimensions: CaptureDimensions,
    dpr: f64,
) -> Result<()> {
    let actual = screenshot["data"]
        .as_str()
        .and_then(png_dimensions)
        .ok_or_else(|| {
            error(
                "browser_error",
                "Browser returned an invalid PNG screenshot",
            )
        })?;
    if u64::from(actual.0) * u64::from(actual.1) > MAX_SCREENSHOT_PIXELS as u64 {
        return Err(error("too_large", "Screenshot exceeds 16 megapixels"));
    }
    let expected = expected_png_dimensions(dimensions.width, dimensions.height, dpr);
    if !dimensions_match(actual, expected) {
        return Err(error(
            "not_supported",
            "Browser screenshot dimensions do not match the requested viewport",
        ));
    }
    Ok(())
}

fn capture_page_state(browser: &BrowserState, tab: u64) -> Result<(u64, u64, Bounds, bool)> {
    let pages = browser.pages.lock().unwrap();
    let page = pages
        .get(&tab)
        .ok_or_else(|| error("not_found", "Browser tab was closed"))?;
    Ok((
        page.view_generation,
        page.document_generation,
        page.bounds,
        page.visible,
    ))
}

fn capture_state_matches(expected: (u64, u64), current: Option<(u64, u64)>) -> bool {
    current == Some(expected)
}

fn capture_viewport_matches(
    captured_viewport: (f64, f64),
    captured_bounds: Bounds,
    applied_bounds: Bounds,
    measured: CaptureViewport,
) -> bool {
    let values = [
        captured_viewport.0,
        captured_viewport.1,
        captured_bounds.width,
        captured_bounds.height,
        applied_bounds.width,
        applied_bounds.height,
    ];
    if values
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return false;
    }
    let expected_width =
        (captured_viewport.0 * applied_bounds.width / captured_bounds.width).round();
    let expected_height =
        (captured_viewport.1 * applied_bounds.height / captured_bounds.height).round();
    let width_tolerance = if applied_bounds.width == captured_bounds.width {
        1.0
    } else {
        2.0
    };
    let height_tolerance = if applied_bounds.height == captured_bounds.height {
        1.0
    } else {
        2.0
    };
    (measured.width - expected_width).abs() <= width_tolerance
        && (measured.height - expected_height).abs() <= height_tolerance
}

fn capture_state_is_current(
    browser: &BrowserState,
    tab: u64,
    view_generation: u64,
    document_generation: u64,
) -> bool {
    let pages = browser.pages.lock().unwrap();
    capture_state_matches(
        (view_generation, document_generation),
        pages
            .get(&tab)
            .map(|page| (page.view_generation, page.document_generation)),
    )
}

fn fixed_screenshot(
    app: &AppHandle,
    tab: u64,
    view: &Webview,
    dimensions: CaptureDimensions,
    deadline: Instant,
) -> Result<Value> {
    let browser = app.state::<BrowserState>();
    let (view_generation, document_generation, bounds, _visible) =
        capture_page_state(&browser, tab)?;
    let initial = measure_capture_viewport(view, capture_step_timeout(deadline)?)?;
    screenshot_pixel_count(dimensions.width, dimensions.height, initial.dpr)?;
    let scroll = measure_capture_scroll(view, capture_step_timeout(deadline)?)?;

    let request_id = browser.next_capture_id.fetch_add(1, Ordering::Relaxed);
    {
        let mut pages = browser.pages.lock().unwrap();
        let page = pages
            .get_mut(&tab)
            .filter(|page| page.view_generation == view_generation)
            .ok_or_else(|| error("not_found", "Browser tab was closed"))?;
        // 측정한 viewport 와 표지의 bounds 가 다른 크기를 가리키면 복원 판정이 영구히 어긋난다.
        if page.bounds != bounds {
            return Err(error(
                "browser_error",
                "The browser view was resized before the screenshot started; try again",
            ));
        }
        mark_capture_restore(page, request_id, initial);
    }

    let capture_result = (|| {
        platform::capture_resize(
            app,
            view,
            dimensions.width,
            dimensions.height,
            capture_step_timeout(deadline)?,
        )?;
        #[cfg(windows)]
        let screenshot = if !_visible {
            platform::show_hidden_view_offscreen_for_capture(
                view,
                dimensions.width,
                dimensions.height,
            )?;
            let viewport = wait_for_capture_size(view, dimensions, deadline)?;
            screenshot_pixel_count(dimensions.width, dimensions.height, viewport.dpr)?;
            let screenshot =
                platform::screenshot_with_timeout(view, capture_step_timeout(deadline)?)?;
            validate_screenshot_png(&screenshot, dimensions, viewport.dpr)?;
            screenshot
        } else {
            let viewport = wait_for_capture_size(view, dimensions, deadline)?;
            screenshot_pixel_count(dimensions.width, dimensions.height, viewport.dpr)?;
            let value =
                platform::screenshot_with_timeout(view, capture_step_timeout(deadline)?)?;
            validate_screenshot_png(&value, dimensions, viewport.dpr)?;
            value
        };
        #[cfg(not(windows))]
        let screenshot = {
            let viewport = wait_for_capture_size(view, dimensions, deadline)?;
            screenshot_pixel_count(dimensions.width, dimensions.height, viewport.dpr)?;
            let value = platform::screenshot_with_timeout(view, capture_step_timeout(deadline)?)?;
            validate_screenshot_png(&value, dimensions, viewport.dpr)?;
            value
        };

        if !capture_state_is_current(&browser, tab, view_generation, document_generation) {
            return Err(error(
                "browser_error",
                "The page navigated while the screenshot was being captured",
            ));
        }
        Ok(json!({
            "data": screenshot["data"],
            "width": dimensions.width,
            "height": dimensions.height,
        }))
    })();

    let restore_deadline = (Instant::now() + CAPTURE_RESTORE).min(deadline);
    let restore = retry_pending_capture_restore(
        app,
        tab,
        view,
        restore_deadline.saturating_duration_since(Instant::now()),
        false,
    );
    if restore.is_err() {
        return Err(error("browser_error", CAPTURE_RESTORE_MESSAGE));
    }
    if capture_state_is_current(&browser, tab, view_generation, document_generation) {
        let scroll_timeout =
            CAPTURE_SCROLL_RESTORE.min(restore_deadline.saturating_duration_since(Instant::now()));
        if !scroll_timeout.is_zero() {
            if let Err(err) = restore_capture_scroll(view, scroll, scroll_timeout) {
                winlog!(
                    "browser: scroll restore failed for tab {tab}: {}",
                    err.message
                );
            }
        }
    }
    capture_result
}

fn offscreen_bounds() -> Bounds {
    Bounds {
        x: -20000.0,
        y: -20000.0,
        width: 1024.0,
        height: 768.0,
    }
}

fn ensure(app: &AppHandle, tab: u64, timeout: Duration) -> Result<Webview> {
    check_enabled(app)?;
    let (workspace, _, url) = target(app, tab)?;
    let url = mast_core::browser::normalize_url(&url).map_err(|e| error("invalid_params", e))?;
    if let Some(view) = app.get_webview(&label(tab)) {
        return Ok(view);
    }
    platform::prepare(app, timeout)?;
    let state = app.state::<BrowserState>();
    let bounds = offscreen_bounds();
    let view_generation = state.next_view_id.fetch_add(1, Ordering::Relaxed);
    state.pages.lock().unwrap().insert(
        tab,
        Page {
            tab,
            url: url.clone(),
            title: "Browser".into(),
            loading: !url.is_empty(),
            error: None,
            visible: false,
            owner: String::new(),
            bounds,
            document_generation: 0,
            eval_gate: EvalGate::default(),
            view_generation,
            restore_pending: None,
            suspend_deferred: false,
        },
    );
    let app_nav = app.clone();
    let app_load = app.clone();
    let app_title = app.clone();
    let app_popup = app.clone();
    let initial = "about:blank";
    let builder = tauri::webview::WebviewBuilder::new(
        label(tab),
        tauri::WebviewUrl::External(initial.parse().map_err(native)?),
    )
    .focused(false)
    .initialization_script(include_str!("browser-page.js"))
    .on_navigation(move |url| {
        let allowed = url.as_str() == "about:blank"
            || mast_core::browser::normalize_url(url.as_str()).is_ok();
        if !allowed {
            event(&app_nav, tab, |p| {
                p.error = Some("Only HTTP(S) navigation is supported".into())
            });
        }
        allowed
    })
    .on_page_load(move |_view, payload| {
        let loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
        let eval_gate_was_blocked = loading
            && app_load
                .try_state::<BrowserState>()
                .is_some_and(|browser| {
                    browser
                        .pages
                        .lock()
                        .unwrap()
                        .get(&tab)
                        .is_some_and(|page| page.eval_gate.is_blocked())
                });
        let url = if payload.url().as_str() == "about:blank" {
            String::new()
        } else {
            payload.url().to_string()
        };
        event(&app_load, tab, |p| {
            if loading {
                p.document_generation = p.document_generation.wrapping_add(1);
                p.eval_gate.document_changed();
            }
            p.loading = loading;
            p.url = url.clone();
            p.error = None;
        });
        if loading {
            if let Some(browser) = app_load.try_state::<BrowserState>() {
                let hidden = browser
                    .pages
                    .lock()
                    .unwrap()
                    .get(&tab)
                    .is_some_and(|page| !page.visible);
                if should_suspend_after_document_change(eval_gate_was_blocked, hidden) {
                    defer_hidden_suspend(&app_load, tab);
                }
            }
        }
        if !url.is_empty() {
            save_location(app_load.clone(), tab, url, None);
        }
    })
    .on_document_title_changed(move |view, title| {
        let title: String = title.chars().take(256).collect();
        event(&app_title, tab, |p| p.title = title.clone());
        if let Ok(url) = view.url() {
            let url = if url.as_str() == "about:blank" {
                String::new()
            } else {
                url.to_string()
            };
            if !url.is_empty() {
                save_location(app_title.clone(), tab, url, Some(title));
            }
        }
    })
    .on_new_window(move |url, _| {
        if mast_core::browser::normalize_url(url.as_str()).is_ok() {
            let app = app_popup.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Ok((_, pane, _)) = target(&app, tab) {
                    let state = app.state::<AppState>();
                    let mut d = state.dispatcher.lock().unwrap();
                    if d.dispatch(Command::CreateTab {
                        pane: PaneId(pane),
                        tab: NewTab::Browser {
                            url: url.to_string(),
                        },
                    })
                    .is_ok()
                    {
                        publish_state(&app, &d);
                    }
                }
            });
        } else {
            event(&app_popup, tab, |p| {
                p.error = Some("Popup URL is not supported".into())
            });
        }
        tauri::webview::NewWindowResponse::Deny
    })
    .on_download(move |view, _| {
        event(view.app_handle(), tab, |p| {
            p.error =
                Some("Downloads are not supported; open this URL in your external browser".into())
        });
        false
    });
    let builder = isolate(app, builder, workspace)?;
    let result = app
        .get_window("main")
        .ok_or_else(|| error("not_found", "Main window is unavailable"))?
        .add_child(
            builder,
            tauri::LogicalPosition::new(bounds.x, bounds.y),
            tauri::LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(native);
    let view = match result {
        Ok(view) => view,
        Err(err) => {
            state.pages.lock().unwrap().remove(&tab);
            return Err(err);
        }
    };
    view.hide().map_err(native)?;
    if let Err(err) = platform::configure(app, tab, &view, timeout) {
        platform::release(&view);
        let _ = view.close();
        state.pages.lock().unwrap().remove(&tab);
        return Err(err);
    }
    if !url.is_empty() {
        view.navigate(url.parse().map_err(native)?)
            .map_err(native)?;
    }
    if target(app, tab).is_err() {
        platform::release(&view);
        let _ = view.close();
        state.pages.lock().unwrap().remove(&tab);
        return Err(error("not_found", "Tab closed while browser was starting"));
    }
    Ok(view)
}

fn pending_capture_restore(browser: &BrowserState, tab: u64) -> Option<CaptureRestore> {
    browser
        .pages
        .lock()
        .unwrap()
        .get(&tab)
        .and_then(|page| page.restore_pending.clone())
}

fn capture_restore_is_current(browser: &BrowserState, tab: u64, restore: &CaptureRestore) -> bool {
    browser.pages.lock().unwrap().get(&tab).is_some_and(|page| {
        page.view_generation == restore.view_generation
            && page
                .restore_pending
                .as_ref()
                .is_some_and(|pending| pending.request_id == restore.request_id)
    })
}

fn page_view_is_current(browser: &BrowserState, tab: u64, view_generation: u64) -> bool {
    browser
        .pages
        .lock()
        .unwrap()
        .get(&tab)
        .is_some_and(|page| page.view_generation == view_generation)
}

fn complete_capture_restore_if_current(
    browser: &BrowserState,
    tab: u64,
    restore: &CaptureRestore,
    sequence: Option<u64>,
    target: &SurfaceTarget,
) -> bool {
    let intents = browser.surface_intents.lock().unwrap();
    let targets = browser.surface_targets.lock().unwrap();
    let latest_target = targets.get(&tab).unwrap_or(target);
    let latest_sequence = intents.get(&(tab, latest_target.owner.clone())).copied();
    if surface_intent_needs_reconciliation(sequence, latest_sequence)
        || latest_target.owner != target.owner
        || latest_target.bounds != target.bounds
        || latest_target.visible != target.visible
    {
        return false;
    }
    let mut pages = browser.pages.lock().unwrap();
    let Some(page) = pages.get_mut(&tab).filter(|page| {
        page.view_generation == restore.view_generation
            && page
                .restore_pending
                .as_ref()
                .is_some_and(|pending| pending.request_id == restore.request_id)
    }) else {
        return false;
    };
    page.visible = target.visible;
    page.owner = target.owner.clone();
    clear_capture_restore(page, restore.request_id, restore.view_generation)
}

fn resume_and_retry_capture_restore(
    app: &AppHandle,
    tab: u64,
    view: &Webview,
    timeout: Duration,
) -> Result<()> {
    platform::suspend(view, true)?;
    retry_pending_capture_restore(app, tab, view, timeout, true)
}

fn retry_pending_capture_restore(
    app: &AppHandle,
    tab: u64,
    view: &Webview,
    timeout: Duration,
    suspend_hidden: bool,
) -> Result<()> {
    let browser = app.state::<BrowserState>();
    let Some(restore) = pending_capture_restore(&browser, tab) else {
        return Ok(());
    };
    if !capture_restore_is_current(&browser, tab, &restore) {
        return Ok(());
    }
    let fallback = SurfaceTarget {
        owner: restore.owner.clone(),
        bounds: restore.bounds,
        visible: restore.visible,
    };
    let mut applied = surface_intent_snapshot(&browser, tab, fallback.clone());
    let deadline = Instant::now() + timeout;
    let remaining = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| error("browser_error", CAPTURE_RESTORE_MESSAGE))
    };
    loop {
        if !capture_restore_is_current(&browser, tab, &restore) {
            return Ok(());
        }
        platform::clear_capture_size(view, remaining()?)
            .map_err(|_| error("browser_error", CAPTURE_RESTORE_MESSAGE))?;
        if !capture_restore_is_current(&browser, tab, &restore) {
            return Ok(());
        }
        let latest = surface_intent_snapshot(&browser, tab, fallback.clone());
        if surface_snapshot_needs_reconciliation(&applied, &latest) {
            applied = latest;
            continue;
        }
        platform::set_surface_bounds(app, view, applied.target.bounds, remaining()?)
            .map_err(|_| error("browser_error", CAPTURE_RESTORE_MESSAGE))?;
        record_applied_bounds(&browser, tab, restore.view_generation, applied.target.bounds);
        if !capture_restore_is_current(&browser, tab, &restore) {
            return Ok(());
        }
        let latest = surface_intent_snapshot(&browser, tab, fallback.clone());
        if surface_snapshot_needs_reconciliation(&applied, &latest) {
            applied = latest;
            continue;
        }
        if applied.target.visible {
            post_latest_visibility(&browser, tab, view, applied.target.visible)
                .map_err(|_| error("browser_error", CAPTURE_RESTORE_MESSAGE))?;
            if !capture_restore_is_current(&browser, tab, &restore) {
                return Ok(());
            }
            let latest = surface_intent_snapshot(&browser, tab, fallback.clone());
            if surface_snapshot_needs_reconciliation(&applied, &latest) {
                applied = latest;
                continue;
            }
            platform::suspend(view, true)
                .map_err(|_| error("browser_error", CAPTURE_RESTORE_MESSAGE))?;
        } else {
            post_latest_visibility(&browser, tab, view, applied.target.visible)
                .map_err(|_| error("browser_error", CAPTURE_RESTORE_MESSAGE))?;
            if !capture_restore_is_current(&browser, tab, &restore) {
                return Ok(());
            }
            let latest = surface_intent_snapshot(&browser, tab, fallback.clone());
            if surface_snapshot_needs_reconciliation(&applied, &latest) {
                applied = latest;
                continue;
            }
        }
        wait_for_capture_restore_viewport(
            view,
            restore.viewport,
            restore.bounds,
            applied.target.bounds,
            deadline,
        )?;
        if !capture_restore_is_current(&browser, tab, &restore) {
            return Ok(());
        }
        let latest = surface_intent_snapshot(&browser, tab, fallback.clone());
        if surface_snapshot_needs_reconciliation(&applied, &latest) {
            applied = latest;
            continue;
        }
        if !applied.target.visible && suspend_hidden && !eval_in_flight(&browser, tab) {
            platform::suspend(view, false)
                .map_err(|_| error("browser_error", CAPTURE_RESTORE_MESSAGE))?;
        }
        if !capture_restore_is_current(&browser, tab, &restore) {
            return Ok(());
        }
        let latest = surface_intent_snapshot(&browser, tab, fallback.clone());
        if !surface_snapshot_needs_reconciliation(&applied, &latest)
            && complete_capture_restore_if_current(
                &browser,
                tab,
                &restore,
                applied.sequence,
                &applied.target,
            )
        {
            return Ok(());
        }
        if !capture_restore_is_current(&browser, tab, &restore) {
            return Ok(());
        }
        applied = surface_intent_snapshot(&browser, tab, fallback.clone());
    }
}

/// 워크스페이스마다 쿠키·저장소를 따로 둔다.
#[cfg(windows)]
fn isolate(
    app: &AppHandle,
    builder: tauri::webview::WebviewBuilder<tauri::Wry>,
    workspace: u64,
) -> Result<tauri::webview::WebviewBuilder<tauri::Wry>> {
    let profile = app
        .path()
        .app_data_dir()
        .map_err(native)?
        .join("browser")
        .join(format!("workspace-{workspace}"));
    Ok(builder.data_directory(profile))
}

/// 워크스페이스마다 쿠키·저장소를 따로 둔다. 영속 저장소 식별자는 macOS 14 부터라,
/// 그 아래에서는 공유 기본 저장소 대신 비영속 저장소로 격리를 지킨다.
#[cfg(target_os = "macos")]
fn isolate(
    _app: &AppHandle,
    builder: tauri::webview::WebviewBuilder<tauri::Wry>,
    workspace: u64,
) -> Result<tauri::webview::WebviewBuilder<tauri::Wry>> {
    Ok(if macos::persistent_stores_available() {
        builder.data_store_identifier(macos::data_store_id(workspace))
    } else {
        builder.incognito(true)
    })
}

#[tauri::command]
pub async fn browser_surface(
    app: AppHandle,
    tab: u64,
    owner: String,
    bounds: Option<Bounds>,
) -> Result<Value> {
    check_enabled(&app)?;
    if bounds.is_some_and(|bounds| !bounds.valid()) {
        return Err(error("invalid_params", "Invalid browser bounds"));
    }
    if bounds.is_none() && !model_has_browser_tab(&app, tab) {
        return Ok(json!(null));
    }
    let browser = app.state::<BrowserState>();
    // 표시된 적 없는 뷰의 dispose 마다 의도 항목이 쌓이지 않게 한다.
    if bounds.is_none() && !surface_owner_is_known(&browser, tab, &owner) {
        return Ok(json!(browser.pages.lock().unwrap().get(&tab)));
    }
    let sequence = record_surface_intent(&browser, tab, &owner, bounds);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        if let Some(bounds) = bounds {
            let _drain = DeferredSuspendDrain { app: &app };
            let _operation = state.operation.lock().unwrap();
            if pending_capture_restore(&state, tab).is_some() {
                let view = app
                    .get_webview(&label(tab))
                    .ok_or_else(|| error("browser_error", CAPTURE_RESTORE_MESSAGE))?;
                resume_and_retry_capture_restore(&app, tab, &view, CAPTURE_RESTORE).inspect_err(
                    |_| {
                        // 재시도가 최신 show 를 이미 적용했을 수 있어 page.visible 대신 최신 의도로 판단한다.
                        let fallback = SurfaceTarget {
                            owner: owner.clone(),
                            bounds,
                            visible: true,
                        };
                        if !surface_intent_snapshot(&state, tab, fallback).target.visible
                            && !eval_in_flight(&state, tab)
                        {
                            let _ = platform::suspend(&view, false);
                        }
                    },
                )?;
            }
            if !current_surface_intent(&state, tab, &owner, sequence) {
                return Ok(json!(state.pages.lock().unwrap().get(&tab)));
            }
            let view = match ensure(&app, tab, NATIVE_WAIT) {
                Ok(view) => view,
                Err(err) => {
                    clear_surface_intent_if_current(&state, tab, &owner, sequence);
                    return Err(err);
                }
            };
            let view_generation = state
                .pages
                .lock()
                .unwrap()
                .get(&tab)
                .map(|page| page.view_generation)
                .ok_or_else(|| error("not_found", "Browser tab was closed"))?;
            let fallback = SurfaceTarget {
                owner: owner.clone(),
                bounds,
                visible: true,
            };
            let mut applied = surface_intent_snapshot(&state, tab, fallback.clone());
            if !surface_intent_is_current(applied.sequence, sequence) {
                return Ok(json!(state.pages.lock().unwrap().get(&tab)));
            }
            loop {
                if !page_view_is_current(&state, tab, view_generation) {
                    return Ok(json!(null));
                }
                platform::set_surface_bounds(&app, &view, applied.target.bounds, NATIVE_WAIT)?;
                record_applied_bounds(&state, tab, view_generation, applied.target.bounds);
                if !page_view_is_current(&state, tab, view_generation) {
                    return Ok(json!(null));
                }
                let latest = surface_intent_snapshot(&state, tab, fallback.clone());
                if surface_snapshot_needs_reconciliation(&applied, &latest) {
                    applied = latest;
                    continue;
                }
                if applied.target.visible {
                    platform::suspend(&view, true)?;
                    if !page_view_is_current(&state, tab, view_generation) {
                        return Ok(json!(null));
                    }
                    let latest = surface_intent_snapshot(&state, tab, fallback.clone());
                    if surface_snapshot_needs_reconciliation(&applied, &latest) {
                        applied = latest;
                        continue;
                    }
                    post_latest_visibility(&state, tab, &view, true).map_err(native)?;
                    if !page_view_is_current(&state, tab, view_generation) {
                        return Ok(json!(null));
                    }
                } else {
                    post_latest_visibility(&state, tab, &view, false).map_err(native)?;
                    if !page_view_is_current(&state, tab, view_generation) {
                        return Ok(json!(null));
                    }
                    let latest = surface_intent_snapshot(&state, tab, fallback.clone());
                    if surface_snapshot_needs_reconciliation(&applied, &latest) {
                        applied = latest;
                        continue;
                    }
                    if !eval_in_flight(&state, tab) {
                        platform::suspend(&view, false)?;
                    }
                    if !page_view_is_current(&state, tab, view_generation) {
                        return Ok(json!(null));
                    }
                }
                let latest = surface_intent_snapshot(&state, tab, fallback.clone());
                if surface_snapshot_needs_reconciliation(&applied, &latest) {
                    applied = latest;
                    continue;
                }
                if let Some(page) = update_surface_page_if_current(
                    &state,
                    tab,
                    view_generation,
                    applied.sequence,
                    &applied.target,
                ) {
                    let _ = app.emit_to("main", "browser-changed", page.clone());
                    return Ok(json!(page));
                }
                let latest = surface_intent_snapshot(&state, tab, fallback.clone());
                if !page_view_is_current(&state, tab, view_generation)
                    || !surface_snapshot_needs_reconciliation(&applied, &latest)
                {
                    return Ok(json!(state.pages.lock().unwrap().get(&tab)));
                }
                applied = latest;
            }
        } else {
            let fallback = state
                .pages
                .lock()
                .unwrap()
                .get(&tab)
                .map(|page| SurfaceTarget {
                    owner: page.owner.clone(),
                    bounds: page.bounds,
                    visible: page.visible,
                })
                .unwrap_or(SurfaceTarget {
                    owner: owner.clone(),
                    bounds: offscreen_bounds(),
                    visible: false,
                });
            let hidden = surface_intent_snapshot(&state, tab, fallback.clone());
            if !current_surface_intent(&state, tab, &owner, sequence)
                || hidden.target.owner != owner
                || hidden.target.visible
            {
                return Ok(json!(state.pages.lock().unwrap().get(&tab)));
            }
            let view = app.get_webview(&label(tab));
            let view_generation = state
                .pages
                .lock()
                .unwrap()
                .get(&tab)
                .map(|page| page.view_generation);
            if let (Some(view), Some(view_generation)) = (view, view_generation) {
                // 숨김은 operation 을 기다리지 않는다. 그사이 더 새 show 가 오면 게시는 그 의도를
                // 따르고, 크기 적용은 operation 아래에서 도는 그 show 요청에 맡겨 캡처와 겹치지 않게 한다.
                let mut applied = hidden;
                loop {
                    if post_latest_visibility(&state, tab, &view, false).map_err(native)? {
                        break;
                    }
                    let latest = surface_intent_snapshot(&state, tab, fallback.clone());
                    if surface_snapshot_needs_reconciliation(&applied, &latest) {
                        applied = latest;
                        continue;
                    }
                    if let Some(page) = update_surface_page_if_current(
                        &state,
                        tab,
                        view_generation,
                        applied.sequence,
                        &applied.target,
                    ) {
                        let _ = app.emit_to("main", "browser-changed", page);
                    }
                    // suspend 판단은 Page.visible 을 보므로 기록한 뒤에 요청한다.
                    defer_hidden_suspend(&app, tab);
                    break;
                }
            }
        }
        let page = json!(state.pages.lock().unwrap().get(&tab));
        Ok(page)
    })
    .await
    .map_err(native)?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub action: String,
    pub tab: Option<u64>,
    pub pane: Option<u64>,
    pub url: Option<String>,
    #[serde(default)]
    pub args: Value,
}

#[tauri::command]
pub async fn browser_request(app: AppHandle, request: Request) -> Result<Value> {
    let request_received = Instant::now();
    check_enabled(&app)?;
    tauri::async_runtime::spawn_blocking(move || execute(&app, request, None, request_received))
        .await
        .map_err(native)?
}

pub fn execute(
    app: &AppHandle,
    request: Request,
    workspace: Option<u64>,
    request_received: Instant,
) -> Result<Value> {
    if request.action == "eval-token" {
        return execute_eval_token(app, &request, workspace);
    }
    if request.action == "eval" {
        return execute_eval(app, &request, workspace, request_received);
    }
    check_enabled(app)?;
    let capture_dimensions = if request.action == "screenshot" {
        capture_dimensions(&request.args)?
    } else {
        None
    };
    let capture_deadline =
        capture_dimensions.map(|_| request_deadline(request_received, CAPTURE_TOTAL));
    let browser = app.state::<BrowserState>();
    if is_js_action(&request.action) {
        let tab = request
            .tab
            .ok_or_else(|| error("invalid_params", "A stable tab ID is required"))?;
        let (tab_workspace, _, _) = target(app, tab)?;
        check_workspace_and_eval_gate(tab_workspace, workspace, || eval_blocked(app, tab))?;
    }
    let _drain = DeferredSuspendDrain { app };
    let _operation = if let Some(deadline) = capture_deadline {
        acquire_operation_until(&browser, deadline, capture_timeout)?
    } else {
        browser.operation.lock().unwrap()
    };
    if request.action == "list" {
        let state = app.state::<AppState>();
        let d = state.dispatcher.lock().unwrap();
        // 웹뷰가 떠 있는 탭은 로딩·오류도 싣는다 — 에이전트가 탐색 실패를 UI 없이 알 수 있게.
        let pages = browser.pages.lock().unwrap();
        let tabs: Vec<Value> = d.state().workspaces.iter().filter(|w| workspace.is_none_or(|id| w.id.0 == id))
            .flat_map(|w| w.panes.values().flat_map(move |p| p.tabs.iter().map(move |t| (w, p, t))))
            .filter_map(|(w, p, t)| {
                let TabKind::Browser { url } = &t.kind else { return None };
                let page = pages.get(&t.id.0);
                Some(json!({"tab": t.id.0, "pane": p.id.0, "workspace": w.id.0, "url": url, "title": t.title,
                    "loading": page.is_some_and(|page| page.loading), "error": page.and_then(|page| page.error.clone())}))
            }).collect();
        return Ok(json!({"tabs": tabs}));
    }
    if request.action == "open" {
        let state = app.state::<AppState>();
        let mut d = state.dispatcher.lock().unwrap();
        let pane = request.pane.or_else(|| {
            d.state()
                .workspaces
                .iter()
                .find(|w| {
                    workspace.map_or(Some(w.id) == d.state().active_workspace, |id| w.id.0 == id)
                })
                .map(|w| w.active_pane.0)
        });
        let out = if let Some(pane) = pane {
            if workspace.is_some_and(|id| {
                !d.state()
                    .workspaces
                    .iter()
                    .any(|w| w.id.0 == id && w.panes.contains_key(&PaneId(pane)))
            }) {
                return Err(error("not_found", "Pane is outside the caller workspace"));
            }
            d.dispatch(Command::CreateTab {
                pane: PaneId(pane),
                tab: NewTab::Browser {
                    url: request.url.unwrap_or_default(),
                },
            })
        } else if workspace.is_none() {
            d.dispatch(Command::CreateWorkspace {
                name: "browser".into(),
                root_path: None,
                distro: None,
                tab: Some(NewTab::Browser {
                    url: request.url.unwrap_or_default(),
                }),
            })
        } else {
            return Err(error("not_found", "Caller workspace is unavailable"));
        }
        .map_err(native)?;
        publish_state(app, &d);
        let id = match out {
            CommandOutput::TabCreated { tab, .. } => Some(tab.0),
            CommandOutput::WorkspaceCreated { tab, .. } => tab.map(|t| t.0),
            _ => None,
        };
        return Ok(json!({"tab": id}));
    }
    let tab = request
        .tab
        .ok_or_else(|| error("invalid_params", "A stable tab ID is required"))?;
    let (ws, _, _) = target(app, tab)?;
    if workspace.is_some_and(|id| id != ws) {
        return Err(error("not_found", "Tab is outside the caller workspace"));
    }
    if is_js_action(&request.action) {
        check_eval_gate(app, tab)?;
    }
    if request.action == "close" {
        let state = app.state::<AppState>();
        let mut d = state.dispatcher.lock().unwrap();
        d.dispatch(Command::CloseTab { tab: TabId(tab) })
            .map_err(native)?;
        publish_state(app, &d);
        return Ok(json!({"closed": tab}));
    }
    if let Some(deadline) = capture_deadline {
        capture_step_timeout(deadline)?;
    }
    let view = if capture_deadline.is_some() {
        app.get_webview(&label(tab)).ok_or_else(page_not_ready)?
    } else {
        if pending_capture_restore(&browser, tab).is_some() {
            let view = app
                .get_webview(&label(tab))
                .ok_or_else(|| error("browser_error", CAPTURE_RESTORE_MESSAGE))?;
            if let Err(err) = resume_and_retry_capture_restore(app, tab, &view, CAPTURE_RESTORE) {
                if capture_restore_failure_blocks_action(&request.action) {
                    suspend_if_hidden(app, tab, &view);
                    return Err(err);
                }
            }
            view
        } else {
            ensure(app, tab, NATIVE_WAIT)?
        }
    };
    if let Some(deadline) = capture_deadline {
        if pending_capture_restore(&browser, tab).is_some() {
            let restore_timeout = remaining(deadline)
                .map(|left| left.min(CAPTURE_RESTORE))
                .map_err(|_| capture_timeout())?;
            resume_and_retry_capture_restore(app, tab, &view, restore_timeout)
                .inspect_err(|_| suspend_if_hidden(app, tab, &view))?;
        }
    }
    if let Some(deadline) = capture_deadline {
        capture_step_timeout(deadline)?;
    }
    platform::suspend(&view, true)?;
    let result = if let (Some(dimensions), Some(deadline)) = (capture_dimensions, capture_deadline)
    {
        fixed_screenshot(app, tab, &view, dimensions, deadline)
    } else {
        action(&view, &request)
    };
    if request.action == "navigate" && result.is_ok() {
        if let Some(url) = result.as_ref().ok().and_then(|v| v["url"].as_str()) {
            save_location(app.clone(), tab, url.to_owned(), None);
        }
    }
    let visible = browser
        .pages
        .lock()
        .unwrap()
        .get(&tab)
        .is_some_and(|p| p.visible);
    if !visible && !eval_in_flight(&browser, tab) {
        let _ = platform::suspend(&view, false);
    }
    if !is_fixed_screenshot(&request) {
        if let Err(err) = &result {
            event(app, tab, |p| p.error = Some(err.message.clone()));
        }
    }
    result
}

fn execute_eval_token(app: &AppHandle, request: &Request, workspace: Option<u64>) -> Result<Value> {
    let workspace = workspace.ok_or_else(|| {
        error(
            "unauthorized",
            "Browser eval tokens are unavailable to the UI",
        )
    })?;
    check_eval_enabled(app)?;
    if request.tab.is_some()
        || request.pane.is_some()
        || request.url.is_some()
        || !(request.args.is_null() || request.args.as_object().is_some_and(|args| args.is_empty()))
    {
        return Err(error(
            "invalid_params",
            "eval-token does not accept arguments",
        ));
    }
    if !workspace_exists(app, workspace) {
        return Err(error("not_found", "Caller workspace is unavailable"));
    }
    let browser = app.state::<BrowserState>();
    let token = browser.eval_token.as_ref().ok_or_else(|| {
        error(
            "disabled",
            "Agent eval is disabled by the user's settings (browser.agentEval)",
        )
    })?;
    Ok(json!(token))
}

fn execute_eval(
    app: &AppHandle,
    request: &Request,
    workspace: Option<u64>,
    request_received: Instant,
) -> Result<Value> {
    let workspace =
        workspace.ok_or_else(|| error("unauthorized", "Browser eval is unavailable to the UI"))?;
    check_eval_enabled(app)?;
    let browser = app.state::<BrowserState>();
    let expected = browser.eval_token.as_deref().ok_or_else(|| {
        error(
            "disabled",
            "Agent eval is disabled by the user's settings (browser.agentEval)",
        )
    })?;
    validate_eval_token(&request.args, expected)?;
    if request.pane.is_some() || request.url.is_some() {
        return Err(error("invalid_params", "eval does not accept pane or url"));
    }
    let tab = request
        .tab
        .ok_or_else(|| error("invalid_params", "A stable tab ID is required"))?;
    let (expression, _, timeout) = parse_eval_args(&request.args)?;
    let deadline = request_deadline(request_received, timeout);
    let (tab_workspace, _, _) = target(app, tab)?;
    check_workspace_and_eval_gate(tab_workspace, Some(workspace), || eval_blocked(app, tab))?;
    let _drain = DeferredSuspendDrain { app };
    let _operation = acquire_operation_until(&browser, deadline, eval_timeout)?;
    check_eval_gate(app, tab)?;
    if pending_capture_restore(&browser, tab).is_some() {
        let view = app.get_webview(&label(tab)).ok_or_else(page_not_ready)?;
        resume_and_retry_capture_restore(
            app,
            tab,
            &view,
            remaining(deadline)?.min(CAPTURE_RESTORE),
        )
        .inspect_err(|_| suspend_if_hidden(app, tab, &view))?;
    }
    remaining(deadline)?;
    let view = app.get_webview(&label(tab)).ok_or_else(page_not_ready)?;
    platform::suspend(&view, true).map_err(|err| {
        if err.code == "timeout" {
            eval_timeout()
        } else {
            eval_error(err.code, err.message)
        }
    })?;
    let native_timeout = match remaining(deadline) {
        Ok(timeout) => timeout,
        Err(timeout) => {
            suspend_if_hidden(app, tab, &view);
            return Err(timeout);
        }
    };

    let request_id = browser.next_eval_id.fetch_add(1, Ordering::Relaxed);
    let document_generation = {
        let mut pages = browser.pages.lock().unwrap();
        let page = pages
            .get_mut(&tab)
            .ok_or_else(|| error("not_found", "Browser tab was closed"))?;
        if !page.eval_gate.start(request_id, page.document_generation) {
            drop(pages);
            suspend_if_hidden(app, tab, &view);
            return Err(error("timeout", EVAL_GATE_MESSAGE));
        }
        page.document_generation
    };
    let callback_app = app.clone();
    let submit_app = app.clone();
    let result = platform::evaluate_agent(
        &view,
        expression,
        native_timeout,
        move || {
            document_generation_is_current(&submit_app, tab, document_generation)
                && Instant::now() < deadline
        },
        move || {
            if clear_eval_gate(&callback_app, tab, request_id, document_generation) {
                defer_hidden_suspend(&callback_app, tab);
            }
        },
    );
    match result {
        Ok(envelope) => {
            if Instant::now() >= deadline {
                mark_eval_timed_out(app, tab, request_id, document_generation);
                suspend_if_hidden(app, tab, &view);
                return Err(eval_timeout());
            }
            clear_eval_gate(app, tab, request_id, document_generation);
            suspend_if_hidden(app, tab, &view);
            eval_envelope(envelope)
        }
        Err(err) if err.code == "timeout" => {
            mark_eval_timed_out(app, tab, request_id, document_generation);
            suspend_if_hidden(app, tab, &view);
            Err(eval_timeout())
        }
        Err(err) => {
            clear_eval_gate(app, tab, request_id, document_generation);
            suspend_if_hidden(app, tab, &view);
            Err(eval_error(err.code, err.message))
        }
    }
}

fn eval_envelope(envelope: Value) -> Result<Value> {
    if let Some(error_value) = envelope.get("error") {
        let code = error_value["code"].as_str().unwrap_or("browser_error");
        return Err(match code {
            "script_error" | "serialization_error" => {
                let name = error_value["name"].as_str().unwrap_or("Error");
                let message = error_value["message"]
                    .as_str()
                    .unwrap_or("Page script failed");
                if code == "script_error" {
                    eval_error("script_error", format!("{name}: {message}"))
                } else {
                    eval_error("serialization_error", format!("{name}: {message}"))
                }
            }
            "too_large" => eval_error("too_large", "Eval result exceeds 1 MiB"),
            _ => eval_error(
                "browser_error",
                "Page script returned an invalid eval result",
            ),
        });
    }
    let value = envelope.get("value").cloned().ok_or_else(|| {
        eval_error(
            "browser_error",
            "Page script returned an invalid eval result",
        )
    })?;
    eval_response(value)
}

fn action(view: &Webview, request: &Request) -> Result<Value> {
    match request.action.as_str() {
        "navigate" => {
            let url = mast_core::browser::normalize_url(request.url.as_deref().unwrap_or_default())
                .map_err(|e| error("invalid_params", e))?;
            view.navigate(
                if url.is_empty() { "about:blank" } else { &url }
                    .parse()
                    .map_err(native)?,
            )
            .map_err(native)?;
            Ok(json!({"url": url}))
        }
        "reload" => {
            view.reload().map_err(native)?;
            Ok(json!({}))
        }
        "focus" => {
            view.set_focus().map_err(native)?;
            Ok(json!({}))
        }
        "stop" => platform::stop(view),
        "back" | "forward" => platform::history(view, request.action == "back"),
        "screenshot" => {
            let area = platform::evaluate(
                view,
                "innerWidth * innerHeight * devicePixelRatio * devicePixelRatio",
                NATIVE_WAIT,
            )?;
            if area.as_f64().is_none_or(|area| area > 16_777_216.0) {
                return Err(error(
                    "too_large",
                    "Screenshot exceeds 16 megapixels; resize the browser pane",
                ));
            }
            platform::screenshot(view)
        }
        "snapshot" | "click" | "fill" | "press" | "scroll" | "console" | "errors" | "wait" => {
            let timeout = request.args["timeoutMs"]
                .as_u64()
                .unwrap_or(5000)
                .min(10000);
            let deadline = std::time::Instant::now() + Duration::from_millis(timeout);
            loop {
                let args = if request.args.is_null() {
                    json!({})
                } else {
                    request.args.clone()
                };
                let expr = format!(
                    "window.__mastBrowser.run({},{})",
                    json!(request.action),
                    args
                );
                let value = platform::evaluate(view, &expr, NATIVE_WAIT)?;
                if !value.is_object() {
                    return Err(error(
                        "browser_error",
                        "The page did not return a browser result; wait for navigation and retry",
                    ));
                }
                if let Some(code) = value["error"].as_str() {
                    return Err(error(
                        if code == "stale_ref" {
                            "stale_ref"
                        } else {
                            "invalid_params"
                        },
                        value["message"].as_str().unwrap_or(code),
                    ));
                }
                if request.action == "press" {
                    let key = request.args["key"]
                        .as_str()
                        .ok_or_else(|| error("invalid_params", "key is required"))?;
                    return platform::press(view, key);
                }
                if request.action != "wait" || value["ready"] == true {
                    return Ok(value);
                }
                if std::time::Instant::now() >= deadline {
                    return Err(error("timeout", "Page condition did not become true"));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        _ => Err(error("not_supported", "Unknown browser action")),
    }
}
