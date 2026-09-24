//! 내장 브라우저의 WKWebView 대응 — `windows.rs` 가 WebView2·CDP 로 하는 일을 WebKit 공개
//! API 로 채운다. 모든 WebKit 호출은 `with_webview` 로 메인 스레드에서 하고, 호출한 blocking
//! 스레드는 완료 블록의 응답을 상한 안에서 기다린다.

use std::collections::HashMap;
use std::ptr::NonNull;
use std::sync::mpsc::SyncSender;
use std::sync::{Mutex, MutexGuard, Once, OnceLock};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventMask, NSEventModifierFlags,
    NSEventType, NSImage, NSView,
};
use objc2_foundation::{
    NSDataBase64EncodingOptions, NSDictionary, NSError, NSOperatingSystemVersion, NSPoint,
    NSProcessInfo, NSString,
};
use objc2_web_kit::WKWebView;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Webview};

use super::{error, event, native, unsupported_key, Result};
use crate::winlog;

/// `NSURLErrorCancelled` — 멈춤·새 탐색으로 앞선 탐색이 취소됐다.
const URL_ERROR_CANCELLED: isize = -999;
/// `WebKitErrorFrameLoadInterruptedByPolicyChange` — `on_navigation` 거부나 다운로드 전환이
/// 끊은 탐색. 그 경로가 이미 사용자 문구를 남겼다.
const FRAME_LOAD_INTERRUPTED: isize = 102;

static APP: OnceLock<AppHandle> = OnceLock::new();
static HOOKS: Once = Once::new();

/// 브라우저 WKWebView 포인터 → 탭. wry 의 탐색 델리게이트와 AppKit 키 모니터는 뷰
/// 포인터만 넘기므로 여기서 탭을 찾는다. 메인 UI 웹뷰는 등록하지 않는다.
fn views() -> MutexGuard<'static, HashMap<usize, u64>> {
    static VIEWS: OnceLock<Mutex<HashMap<usize, u64>>> = OnceLock::new();
    VIEWS.get_or_init(Default::default).lock().unwrap()
}

/// 영속 `WKWebsiteDataStore(forIdentifier:)` 는 macOS 14 부터다.
pub(super) fn persistent_stores_available() -> bool {
    NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
        majorVersion: 14,
        minorVersion: 0,
        patchVersion: 0,
    })
}

/// 워크스페이스 ID 에서 만든 고정 저장소 식별자 — 재시작해도 같은 워크스페이스는 같은
/// 쿠키·저장소를 다시 쓴다.
pub(super) fn data_store_id(workspace: u64) -> [u8; 16] {
    let mut id = [0; 16];
    id[..8].copy_from_slice(b"mastbrws");
    id[8..].copy_from_slice(&workspace.to_be_bytes());
    id
}

fn on_main<T: Send + 'static>(
    view: &Webview,
    what: &'static str,
    run: impl FnOnce(&WKWebView, SyncSender<Result<T>>) + Send + 'static,
) -> Result<T> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |platform| {
        // SAFETY: with_webview 는 메인 스레드에서 살아 있는 WKWebView 를 넘긴다.
        let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
        run(webview, tx);
    })
    .map_err(native)?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| error("timeout", format!("WebKit did not respond to {what}")))?
}

/// WebKit 은 델리게이트를 붙이는 순간 응답하는 메서드를 캐시한다. 그래서 탐색 실패
/// 메서드는 첫 브라우저 웹뷰를 만들기 **전에**, 같은 델리게이트 클래스를 쓰는 메인
/// 웹뷰에서 추가한다.
pub(super) fn prepare(app: &AppHandle) -> Result<()> {
    let _ = APP.set(app.clone());
    if HOOKS.is_completed() {
        return Ok(());
    }
    let main = app
        .get_webview("main")
        .ok_or_else(|| error("not_found", "Main window is unavailable"))?;
    on_main(&main, "the browser setup", |webview, done| {
        HOOKS.call_once(|| install_hooks(webview));
        let _ = done.try_send(Ok(()));
    })
}

pub(super) fn configure(_app: &AppHandle, tab: u64, view: &Webview) -> Result<()> {
    on_main(view, "the browser setup", move |webview, done| {
        views().insert(webview as *const WKWebView as usize, tab);
        let _ = done.try_send(Ok(()));
    })
}

pub(super) fn release(view: &Webview) {
    let _ = view.with_webview(|platform| {
        views().remove(&(platform.inner() as usize));
    });
}

/// 숨긴 WKWebView 의 타이머·렌더링 억제는 WebKit 이 한다. WebView2 의 `TrySuspend` 같은
/// 공개 API 는 없다.
pub(super) fn suspend(_view: &Webview, _visible: bool) -> Result<()> {
    Ok(())
}

pub(super) fn evaluate(view: &Webview, expression: &str) -> Result<Value> {
    let script = format!("JSON.stringify({expression})");
    let text = on_main(view, "a page script", move |webview, done| {
        let handler = RcBlock::new(move |result: *mut AnyObject, failure: *mut NSError| {
            // SAFETY: WebKit 이 완료 블록 동안 살아 있는 결과·오류를 넘긴다.
            let outcome = match unsafe { (result.as_ref(), failure.as_ref()) } {
                (_, Some(failure)) => Err(error(
                    "browser_error",
                    format!(
                        "Page script failed or navigation replaced its document ({})",
                        failure.localizedDescription()
                    ),
                )),
                (Some(result), None) => Ok(result.downcast_ref::<NSString>().map(|s| s.to_string())),
                (None, None) => Ok(None),
            };
            let _ = done.try_send(outcome);
        });
        // SAFETY: 메인 스레드이고 블록은 WebKit 이 복사해 보관한다.
        unsafe {
            webview.evaluateJavaScript_completionHandler(&NSString::from_str(&script), Some(&handler))
        };
    })?;
    match text {
        Some(text) => serde_json::from_str(&text).map_err(native),
        None => Ok(Value::Null),
    }
}

pub(super) fn stop(view: &Webview) -> Result<Value> {
    on_main(view, "stop", |webview, done| {
        // SAFETY: 메인 스레드에서의 WKWebView 호출이다.
        unsafe { webview.stopLoading() };
        let _ = done.try_send(Ok(json!({})));
    })
}

pub(super) fn history(view: &Webview, back: bool) -> Result<Value> {
    on_main(view, "history navigation", move |webview, done| {
        // SAFETY: 메인 스레드에서의 WKWebView 호출이다.
        let moved = unsafe {
            if back {
                webview.canGoBack().then(|| webview.goBack())
            } else {
                webview.canGoForward().then(|| webview.goForward())
            }
        };
        let _ = done.try_send(match moved {
            Some(_) => Ok(json!({})),
            None => Err(error("not_found", "No history entry")),
        });
    })
}

pub(super) fn screenshot(view: &Webview) -> Result<Value> {
    on_main(view, "the screenshot", |webview, done| {
        let handler = RcBlock::new(move |image: *mut NSImage, failure: *mut NSError| {
            // SAFETY: WebKit 이 완료 블록 동안 살아 있는 이미지·오류를 넘긴다.
            let _ = done.try_send(unsafe { png(image.as_ref(), failure.as_ref()) });
        });
        // SAFETY: 메인 스레드이고 블록은 WebKit 이 복사해 보관한다.
        unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &handler) };
    })
}

fn png(image: Option<&NSImage>, failure: Option<&NSError>) -> Result<Value> {
    if let Some(failure) = failure {
        return Err(native(failure.localizedDescription()));
    }
    let image = image.ok_or_else(|| native("WebKit returned no screenshot"))?;
    let png = image
        .TIFFRepresentation()
        .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
        // SAFETY: 빈 속성 사전은 PNG 인코더가 받는 타입이다.
        .and_then(|rep| unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        })
        .ok_or_else(|| native("Cannot encode the screenshot as PNG"))?;
    Ok(json!({
        "data": png.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty()).to_string()
    }))
}

/// 포커스를 옮기지 않고 키 이벤트를 웹뷰에 직접 준다 — 사용자가 다른 pane 에서 입력하던
/// 중에도 자동화가 키보드 포커스를 빼앗지 않게 한다 (Windows 의 CDP 입력과 같은 성질).
pub(super) fn press(view: &Webview, key: &str) -> Result<Value> {
    let (code, text): (u16, &'static str) = match key {
        "Enter" => (36, "\r"),
        "Tab" => (48, "\t"),
        "Escape" => (53, "\u{1b}"),
        "Backspace" => (51, "\u{7f}"),
        "ArrowLeft" => (123, "\u{f702}"),
        "ArrowUp" => (126, "\u{f700}"),
        "ArrowRight" => (124, "\u{f703}"),
        "ArrowDown" => (125, "\u{f701}"),
        _ => return Err(unsupported_key()),
    };
    on_main(view, "the key press", move |webview, done| {
        let window = webview.window().map_or(0, |window| window.windowNumber());
        let text = NSString::from_str(text);
        let key_event = |kind| {
            NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                kind,
                NSPoint::ZERO,
                NSEventModifierFlags::empty(),
                0.0,
                window,
                None,
                &text,
                &text,
                false,
                code,
            )
        };
        let _ = done.try_send(match (key_event(NSEventType::KeyDown), key_event(NSEventType::KeyUp)) {
            (Some(down), Some(up)) => {
                webview.keyDown(&down);
                webview.keyUp(&up);
                Ok(json!({}))
            }
            _ => Err(native("Cannot create the key event")),
        });
    })
}

/// 앱 전체에 한 번만 건다 (첫 브라우저 웹뷰를 만들기 전, 메인 스레드).
fn install_hooks(webview: &WKWebView) {
    // SAFETY: 메인 스레드에서 wry 가 붙인 델리게이트를 읽는다.
    match unsafe { webview.navigationDelegate() } {
        Some(delegate) => {
            let class = AsRef::<AnyObject>::as_ref(&*delegate).class();
            add_navigation_failure(class, sel!(webView:didFailProvisionalNavigation:withError:));
            add_navigation_failure(class, sel!(webView:didFailNavigation:withError:));
        }
        None => winlog!("browser: no navigation delegate; navigation failures stay unreported"),
    }
    let monitor = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent { forward_shortcut(event) });
    // SAFETY: 메인 스레드이고 AppKit 이 블록을 복사해 보관한다.
    match unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &monitor) } {
        // 앱 수명 동안 두는 모니터라 해제 토큰을 쓸 일이 없다.
        Some(token) => std::mem::forget(token),
        None => winlog!("browser: the shortcut monitor was not installed"),
    }
}

/// wry 0.55 의 탐색 델리게이트는 실패 콜백을 구현하지 않아, 실패하면 로딩 표시가 풀리지
/// 않고 원인도 보이지 않는다. 클래스는 이름(모듈 경로와 wry 버전이 붙는다) 대신 실제
/// 델리게이트 객체에서 얻는다. 메인 UI 웹뷰도 같은 클래스를 쓰지만 핸들러는 등록된 브라우저
/// 뷰만 처리한다. wry 가 직접 구현하기 시작하면 덮지 않는다.
fn add_navigation_failure(class: &AnyClass, selector: Sel) {
    if class.instance_methods().iter().any(|method| method.name() == selector) {
        winlog!("browser: wry already implements {selector}; keeping its handler");
        return;
    }
    let handler: extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject) =
        navigation_failed;
    // SAFETY: 타입 인코딩 "v@:@@@" 는 핸들러 시그니처(void, self, _cmd, webView, navigation,
    // error)와 일치하고, 호출 규약이 같은 함수 포인터끼리의 변환이다.
    let added = unsafe {
        objc2::ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            selector,
            std::mem::transmute::<
                extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject),
                Imp,
            >(handler),
            c"v@:@@@".as_ptr(),
        )
    };
    if !added.as_bool() {
        winlog!("browser: adding {selector} to WryNavigationDelegate failed");
    }
}

extern "C" fn navigation_failed(
    _this: *mut AnyObject,
    _cmd: Sel,
    webview: *mut AnyObject,
    _navigation: *mut AnyObject,
    failure: *mut AnyObject,
) {
    let Some(tab) = views().get(&(webview as usize)).copied() else {
        return;
    };
    let Some(app) = APP.get() else { return };
    // SAFETY: WebKit 이 콜백 동안 살아 있는 NSError 를 넘긴다.
    let failure = unsafe { failure.cast::<NSError>().as_ref() };
    let (code, reason) = failure.map_or((0, "unknown error".to_owned()), |failure| {
        (failure.code(), failure.localizedDescription().to_string())
    });
    let message = (code != URL_ERROR_CANCELLED && code != FRAME_LOAD_INTERRUPTED)
        .then(|| format!("Navigation failed: {reason} Check the URL, server and certificate."));
    event(app, tab, |p| {
        p.loading = false;
        if message.is_some() {
            p.error = message.clone();
        }
    });
}

/// 브라우저 웹뷰가 키보드를 가진 동안에도 Mast 단축키가 동작하게, 해당 조합만 메인 UI
/// 로 넘긴다. 나머지는 페이지 몫으로 그대로 흘린다.
fn forward_shortcut(event: NonNull<NSEvent>) -> *mut NSEvent {
    let pass = event.as_ptr();
    let Some(mtm) = MainThreadMarker::new() else { return pass };
    // SAFETY: AppKit 이 모니터 호출 동안 살아 있는 이벤트를 넘긴다.
    let event = unsafe { event.as_ref() };
    let Some(tab) = focused_browser(event, mtm) else { return pass };
    let Some(app) = APP.get() else { return pass };
    let Some(ui) = app.get_webview("main") else { return pass };
    let flags = event.modifierFlags();
    let cmd = flags.contains(NSEventModifierFlags::Command);
    let ctrl = flags.contains(NSEventModifierFlags::Control);
    let alt = flags.contains(NSEventModifierFlags::Option);
    let shift = flags.contains(NSEventModifierFlags::Shift);
    let key = key_name(event);
    if cmd && !ctrl && !alt && !shift && key.eq_ignore_ascii_case("l") {
        let _ = ui.set_focus();
        let _ = app.emit_to("main", "browser-address-focus", tab);
        return std::ptr::null_mut();
    }
    if !is_mast_shortcut(&key, cmd, ctrl, alt, shift) {
        return pass;
    }
    let _ = ui.set_focus();
    let _ = ui.eval(format!(
        "window.dispatchEvent(new KeyboardEvent('keydown', {{key:{},metaKey:{cmd},ctrlKey:{ctrl},altKey:{alt},shiftKey:{shift},bubbles:true}}))",
        json!(key)
    ));
    std::ptr::null_mut()
}

fn focused_browser(event: &NSEvent, mtm: MainThreadMarker) -> Option<u64> {
    let responder = event.window(mtm)?.firstResponder()?;
    let mut view = responder.downcast::<NSView>().ok()?;
    let views = views();
    loop {
        if let Some(tab) = views.get(&(Retained::as_ptr(&view) as usize)) {
            return Some(*tab);
        }
        // SAFETY: 메인 스레드에서 뷰 계층을 읽는다.
        view = unsafe { view.superview() }?;
    }
}

/// `KeyboardEvent.key` 와 같은 이름 — `shared/keys.ts` 가 이 값으로 판정한다.
fn key_name(event: &NSEvent) -> String {
    match event.keyCode() {
        48 => "Tab".to_owned(),
        123 => "ArrowLeft".to_owned(),
        124 => "ArrowRight".to_owned(),
        125 => "ArrowDown".to_owned(),
        126 => "ArrowUp".to_owned(),
        _ => event
            .charactersIgnoringModifiers()
            .map(|chars| chars.to_string())
            .unwrap_or_default(),
    }
}

/// `shared/keys.ts::macKeyAction` 이 가로채는 조합 중 페이지 밖을 다루는 것 — pane 안 탭
/// 순환, pane 이동, 워크스페이스 전환, 분할과 `MAC_KEYS` 표. 확대(Cmd+=/-/0)는 페이지에
/// 남긴다. 표를 바꾸면 여기도 함께 바꾼다.
fn is_mast_shortcut(key: &str, cmd: bool, ctrl: bool, alt: bool, shift: bool) -> bool {
    if ctrl && !cmd && !alt {
        return key == "Tab";
    }
    if !cmd || ctrl {
        return false;
    }
    if alt {
        return !shift && key.starts_with("Arrow");
    }
    let key = key.to_lowercase();
    if shift {
        matches!(key.as_str(), "b" | "[" | "{" | "]" | "}" | "w" | "d")
    } else {
        matches!(key.as_str(), "w" | "t" | "n" | "d") || matches!(key.as_bytes(), [b'1'..=b'9'])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_store_id_is_stable_and_distinct_per_workspace() {
        assert_eq!(data_store_id(7), data_store_id(7));
        assert_ne!(data_store_id(7), data_store_id(8));
        assert_eq!(&data_store_id(7)[..8], b"mastbrws");
    }

    #[test]
    fn only_mast_navigation_shortcuts_leave_the_page() {
        assert!(is_mast_shortcut("Tab", false, true, false, false));
        assert!(is_mast_shortcut("Tab", false, true, false, true));
        assert!(is_mast_shortcut("3", true, false, false, false));
        assert!(is_mast_shortcut("w", true, false, false, false));
        assert!(is_mast_shortcut("W", true, false, false, true));
        assert!(is_mast_shortcut("{", true, false, false, true));
        assert!(is_mast_shortcut("ArrowLeft", true, false, true, false));

        assert!(!is_mast_shortcut("c", true, false, false, false));
        assert!(!is_mast_shortcut("v", true, false, false, false));
        assert!(!is_mast_shortcut("k", true, false, false, false));
        assert!(!is_mast_shortcut("=", true, false, false, false));
        assert!(!is_mast_shortcut("0", true, false, false, false));
        assert!(!is_mast_shortcut("a", false, true, false, false));
        assert!(!is_mast_shortcut("3", false, false, false, false));
    }
}
