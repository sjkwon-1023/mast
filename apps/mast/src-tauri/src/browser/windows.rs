use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Webview};

use super::{activate_pane, error, event, native, unsupported_key, Result};

const NATIVE_WAIT: Duration = Duration::from_secs(10);

pub(super) fn prepare(_app: &AppHandle, _timeout: Duration) -> Result<()> {
    Ok(())
}

pub(super) fn configure(
    app: &AppHandle,
    tab: u64,
    view: &Webview,
    timeout: Duration,
) -> Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY;
    use webview2_com::{
        AcceleratorKeyPressedEventHandler, FocusChangedEventHandler,
        NavigationCompletedEventHandler, PermissionRequestedEventHandler,
    };
    let app = app.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |native_view| unsafe {
        let result = (|| -> windows::core::Result<()> {
            let core = native_view.controller().CoreWebView2()?;
            let mut token = 0;
            let keyboard_app = app.clone();
            native_view.controller().add_AcceleratorKeyPressed(&AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};
                use webview2_com::Microsoft::Web::WebView2::Win32::{
                    COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
                };
                let Some(args) = args else { return Ok(()) };
                let mut kind = Default::default(); args.KeyEventKind(&mut kind)?;
                // Alt 조합은 SYSTEM_KEY_DOWN 으로 온다.
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                    return Ok(());
                }
                let mut key = 0; args.VirtualKey(&mut key)?;
                let ctrl = GetKeyState(VK_CONTROL.0 as i32) < 0;
                let alt = GetKeyState(VK_MENU.0 as i32) < 0;
                let shift = GetKeyState(VK_SHIFT.0 as i32) < 0;
                let Some(ui) = keyboard_app.get_webview("main") else { return Ok(()) };
                if ctrl && !alt && !shift && key == 0x4C {
                    args.SetHandled(true)?;
                    let _ = ui.set_focus();
                    let _ = keyboard_app.emit_to("main", "browser-address-focus", tab);
                    return Ok(());
                }
                let Some(name) = key_name(key) else { return Ok(()) };
                if !is_mast_shortcut(&name, ctrl, alt, shift) {
                    return Ok(());
                }
                // 반복 keydown 은 메모장 토글 키만 소비한다 — 서랍이 열렸다 닫히는 흔들림을 막는다.
                if is_notepad_toggle_key(&name, ctrl, alt, shift) {
                    let mut physical = Default::default();
                    if args.PhysicalKeyStatus(&mut physical).is_ok() && physical.WasKeyDown.as_bool() {
                        args.SetHandled(true)?;
                        return Ok(());
                    }
                }
                args.SetHandled(true)?;
                let _ = ui.set_focus();
                let _ = ui.eval(format!(
                    "window.dispatchEvent(new KeyboardEvent('keydown', {{key:{},ctrlKey:{ctrl},altKey:{alt},shiftKey:{shift},bubbles:true}}))",
                    json!(name)
                ));
                Ok(())
            })), &mut token)?;
            let focus_app = app.clone();
            native_view.controller().add_GotFocus(&FocusChangedEventHandler::create(Box::new(move |_, _| {
                activate_pane(&focus_app, tab);
                Ok(())
            })), &mut token)?;
            let permissions_app = app.clone();
            core.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?; }
                event(&permissions_app, tab, |p| p.error = Some("This browser does not grant camera, microphone, location or clipboard-read permissions".into()));
                Ok(())
            })), &mut token)?;
            core.add_NavigationCompleted(&NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut successful = windows::core::BOOL::default();
                    args.IsSuccess(&mut successful)?;
                    if !successful.as_bool() {
                        let mut reason = Default::default();
                        args.WebErrorStatus(&mut reason)?;
                        event(&app, tab, |p| { p.loading = false; p.error = Some(format!("Navigation failed ({reason:?}). Check the URL, server and certificate.")); });
                    }
                }
                Ok(())
            })), &mut token)?;
            Ok(())
        })();
        let _ = tx.try_send(result.map_err(|e| e.to_string()));
    }).map_err(native)?;
    rx.recv_timeout(timeout)
        .map_err(|_| error("timeout", "Browser permission setup timed out"))?
        .map_err(native)
}

pub(super) fn release(_view: &Webview) {}

pub(super) fn suspend(view: &Webview, visible: bool) -> Result<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::ICoreWebView2_3, TrySuspendCompletedHandler,
    };
    use windows::core::Interface;
    view.with_webview(move |v| unsafe {
        let result = (|| -> windows::core::Result<()> {
            let core: ICoreWebView2_3 = v.controller().CoreWebView2()?.cast()?;
            if visible {
                core.Resume()?;
            } else {
                core.TrySuspend(&TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(()))))?;
            }
            Ok(())
        })();
        if let Err(err) = result {
            crate::winlog!("browser suspension failed: {err}");
        }
    })
    .map_err(native)
}

pub(super) fn evaluate(view: &Webview, expression: &str, timeout: Duration) -> Result<Value> {
    let result = cdp(
        view,
        "Runtime.evaluate",
        json!({"expression": expression, "returnByValue": true}),
        timeout,
    )?;
    if !result["exceptionDetails"].is_null() {
        return Err(error(
            "browser_error",
            "Page script failed or navigation replaced its document",
        ));
    }
    Ok(result["result"]["value"].clone())
}

pub(super) fn evaluate_agent(
    view: &Webview,
    expression: &str,
    timeout: Duration,
    may_submit: impl Fn() -> bool + Send + 'static,
    completed: impl FnOnce() + Send + 'static,
) -> Result<Value> {
    let body = include_str!("../browser-eval.js")
        .replace("__MAST_EVAL_EXPRESSION__", &format!("\n{expression}\n"));
    let script = format!("(async function() {{\n{body}\n}})()");
    let result = cdp_with_submit(
        view,
        "Runtime.evaluate",
        json!({
            "expression": script,
            "userGesture": true,
            "awaitPromise": true,
            "returnByValue": true,
            "timeout": timeout.as_millis(),
        }),
        timeout,
        Some(Box::new(completed)),
        Some(Box::new(may_submit)),
    )?;
    if !result["exceptionDetails"].is_null() {
        return Err(error(
            "script_error",
            result["exceptionDetails"]["exception"]["description"]
                .as_str()
                .unwrap_or("Page script failed"),
        ));
    }
    let text = result["result"]["value"]
        .as_str()
        .ok_or_else(|| error("script_error", "Page script returned no eval result"))?;
    super::parse_eval_envelope(text)
}

pub(super) fn stop(view: &Webview) -> Result<Value> {
    cdp(view, "Page.stopLoading", json!({}), NATIVE_WAIT)
}

pub(super) fn history(view: &Webview, back: bool) -> Result<Value> {
    let history = cdp(
        view,
        "Page.getNavigationHistory",
        json!({}),
        NATIVE_WAIT,
    )?;
    let current = history["currentIndex"].as_i64().unwrap_or(0);
    let index = current + if back { -1 } else { 1 };
    let entry = history["entries"]
        .as_array()
        .and_then(|a| usize::try_from(index).ok().and_then(|i| a.get(i)))
        .ok_or_else(|| error("not_found", "No history entry"))?;
    cdp(
        view,
        "Page.navigateToHistoryEntry",
        json!({"entryId": entry["id"]}),
        NATIVE_WAIT,
    )
}

pub(super) fn screenshot(view: &Webview) -> Result<Value> {
    screenshot_with_timeout(view, NATIVE_WAIT)
}

pub(super) fn screenshot_with_timeout(view: &Webview, timeout: Duration) -> Result<Value> {
    cdp(
        view,
        "Page.captureScreenshot",
        json!({"format": "png", "captureBeyondViewport": false}),
        timeout,
    )
}

pub(super) fn set_surface_bounds(
    _app: &AppHandle,
    view: &Webview,
    bounds: super::Bounds,
    _timeout: Duration,
) -> Result<()> {
    view.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
        size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
    })
    .map_err(native)
}

pub(super) fn capture_resize(
    _app: &AppHandle,
    view: &Webview,
    width: u32,
    height: u32,
    timeout: Duration,
) -> Result<()> {
    cdp(
        view,
        "Emulation.setDeviceMetricsOverride",
        json!({"width": width, "height": height, "deviceScaleFactor": 0, "mobile": false}),
        timeout,
    )?;
    Ok(())
}

pub(super) fn clear_capture_size(view: &Webview, timeout: Duration) -> Result<()> {
    cdp(
        view,
        "Emulation.clearDeviceMetricsOverride",
        json!({}),
        timeout,
    )?;
    Ok(())
}

pub(super) fn show_hidden_view_offscreen_for_capture(
    view: &Webview,
    width: u32,
    height: u32,
) -> Result<()> {
    view.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(-20000.0, -20000.0).into(),
        size: tauri::LogicalSize::new(f64::from(width), f64::from(height)).into(),
    })
    .map_err(native)?;
    view.show().map_err(native)
}

pub(super) fn press(view: &Webview, key: &str) -> Result<Value> {
    let code = match key {
        "Enter" => 13,
        "Tab" => 9,
        "Escape" => 27,
        "Backspace" => 8,
        "ArrowLeft" => 37,
        "ArrowUp" => 38,
        "ArrowRight" => 39,
        "ArrowDown" => 40,
        _ => return Err(unsupported_key()),
    };
    cdp(
        view,
        "Input.dispatchKeyEvent",
        json!({"type": "keyDown", "key": key, "windowsVirtualKeyCode": code}),
        NATIVE_WAIT,
    )?;
    cdp(
        view,
        "Input.dispatchKeyEvent",
        json!({"type": "keyUp", "key": key, "windowsVirtualKeyCode": code}),
        NATIVE_WAIT,
    )
}

fn cdp(
    view: &Webview,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value> {
    cdp_with_submit(view, method, params, timeout, None, None)
}

fn cdp_with_submit(
    view: &Webview,
    method: &str,
    params: Value,
    timeout: Duration,
    completed: Option<Box<dyn FnOnce() + Send>>,
    may_submit: Option<Box<dyn Fn() -> bool + Send>>,
) -> Result<Value> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;
    let method = method.to_owned();
    let params = params.to_string();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let completed = std::sync::Arc::new(std::sync::Mutex::new(completed));
    let callback_completed = completed.clone();
    view.with_webview(move |v| unsafe {
        let finish_without_submission = || {
            let completed = completed.lock().unwrap().take();
            if let Some(completed) = completed {
                completed();
            }
        };
        let done = tx.clone();
        let callback =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, result| {
                let completed = callback_completed.lock().unwrap().take();
                if let Some(completed) = completed {
                    completed();
                }
                let value = status
                    .map_err(native)
                    .and_then(|_| serde_json::from_str::<Value>(&result).map_err(native));
                let _ = done.try_send(value);
                Ok(())
            }));
        let core = match v.controller().CoreWebView2() {
            Ok(core) => core,
            Err(err) => {
                finish_without_submission();
                let _ = tx.try_send(Err(native(err)));
                return;
            }
        };
        if may_submit.as_ref().is_some_and(|check| !check()) {
            finish_without_submission();
            let _ = tx.try_send(Err(error("timeout", "Browser eval deadline expired")));
            return;
        }
        if let Err(err) = core.CallDevToolsProtocolMethod(
            &HSTRING::from(method),
            &HSTRING::from(params),
            &callback,
        ) {
            finish_without_submission();
            let _ = tx.try_send(Err(native(err)));
        }
    })
    .map_err(native)?;
    let result = rx
        .recv_timeout(timeout)
        .map_err(|_| error("timeout", "WebView2 did not respond"))??;
    if !result["error"].is_null() {
        return Err(native(&result["error"]));
    }
    Ok(result)
}

/// 가상 키 코드 → `KeyboardEvent.key`. 가상 키는 물리 키 기준이라 한글 입력 중에도 같다.
fn key_name(key: u32) -> Option<String> {
    Some(match key {
        0x09 => "Tab".to_owned(),
        0x25 => "ArrowLeft".to_owned(),
        0x26 => "ArrowUp".to_owned(),
        0x27 => "ArrowRight".to_owned(),
        0x28 => "ArrowDown".to_owned(),
        0xDB => "[".to_owned(),
        0xDD => "]".to_owned(),
        0x31..=0x39 | 0x41..=0x5A => char::from_u32(key)?.to_ascii_lowercase().to_string(),
        _ => return None,
    })
}

/// 반복 keydown 을 페이지로 넘기지 않고 소비만 하는 유일한 단축키 — 메모장 토글.
/// `shared/keys.ts` 의 `Ctrl+Shift+M` / `Alt+Shift+M` 판정과 같은 조합이다.
fn is_notepad_toggle_key(key: &str, ctrl: bool, alt: bool, shift: bool) -> bool {
    ctrl != alt && shift && key.eq_ignore_ascii_case("m")
}

/// `shared/keys.ts::keyAction` 의 Windows 분기가 가로채는 조합 중 페이지 밖을 다루는 것 —
/// `Ctrl+Tab` 탭 순환, `Alt+Shift+방향키` pane 이동, `Ctrl`/`Alt`+`Shift`+문자 표
/// (`CTRL_SHIFT_KEYS`·분할 `D`), `Ctrl`/`Alt`+숫자 워크스페이스 전환. 확대(`Ctrl+=/-/0`)는
/// 페이지에 남긴다. 표를 바꾸면 여기도 함께 바꾼다.
fn is_mast_shortcut(key: &str, ctrl: bool, alt: bool, shift: bool) -> bool {
    if ctrl && !alt && key == "Tab" {
        return true;
    }
    if ctrl == alt {
        return false;
    }
    if shift {
        if key.starts_with("Arrow") {
            return alt;
        }
        matches!(key, "d" | "w" | "t" | "b" | "n" | "[" | "]" | "q" | "m")
    } else {
        matches!(key.as_bytes(), [b'1'..=b'9'])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_keys_map_to_keyboard_event_names() {
        assert_eq!(key_name(0x44).as_deref(), Some("d"));
        assert_eq!(key_name(0x33).as_deref(), Some("3"));
        assert_eq!(key_name(0x25).as_deref(), Some("ArrowLeft"));
        assert_eq!(key_name(0xDB).as_deref(), Some("["));
        assert_eq!(key_name(0x30), None);
        assert_eq!(key_name(0x70), None);
    }

    #[test]
    fn only_the_notepad_toggle_blocks_key_repeat() {
        assert!(is_notepad_toggle_key("m", true, false, true));
        assert!(is_notepad_toggle_key("m", false, true, true));
        assert!(!is_notepad_toggle_key("m", true, false, false));
        assert!(!is_notepad_toggle_key("m", false, true, false));
        assert!(!is_notepad_toggle_key("m", true, true, true));
        assert!(!is_notepad_toggle_key("t", true, false, true));
        assert!(!is_notepad_toggle_key("ArrowLeft", false, true, true));
    }

    #[test]
    fn only_mast_navigation_shortcuts_leave_the_page() {
        assert!(is_mast_shortcut("Tab", true, false, false));
        assert!(is_mast_shortcut("Tab", true, false, true));
        assert!(is_mast_shortcut("ArrowLeft", false, true, true));
        assert!(is_mast_shortcut("d", false, true, true));
        assert!(is_mast_shortcut("d", true, false, true));
        assert!(is_mast_shortcut("t", false, true, true));
        assert!(is_mast_shortcut("]", true, false, true));
        assert!(is_mast_shortcut("m", true, false, true));
        assert!(is_mast_shortcut("m", false, true, true));
        assert!(is_mast_shortcut("2", false, true, false));
        assert!(is_mast_shortcut("2", true, false, false));

        assert!(!is_mast_shortcut("ArrowLeft", true, false, true));
        assert!(!is_mast_shortcut("c", true, false, true));
        assert!(!is_mast_shortcut("v", true, false, false));
        assert!(!is_mast_shortcut("m", true, false, false));
        assert!(!is_mast_shortcut("m", false, true, false));
        assert!(!is_mast_shortcut("d", true, true, true));
        assert!(!is_mast_shortcut("2", false, false, false));
        assert!(!is_mast_shortcut("Tab", false, true, false));
    }
}
