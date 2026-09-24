use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Webview};

use super::{activate_pane, error, event, native, unsupported_key, Result};

pub(super) fn prepare(_app: &AppHandle) -> Result<()> {
    Ok(())
}

/// WebView2 의 자식 웹뷰는 메인 웹뷰와 같은 창 클라이언트 좌표를 쓴다.
pub(super) fn ui_origin(_app: &AppHandle) -> Result<(f64, f64)> {
    Ok((0.0, 0.0))
}

pub(super) fn configure(app: &AppHandle, tab: u64, view: &Webview) -> Result<()> {
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
                use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_SHIFT};
                use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                let Some(args) = args else { return Ok(()) };
                let mut kind = Default::default(); args.KeyEventKind(&mut kind)?;
                let mut key = 0; args.VirtualKey(&mut key)?;
                let control = GetKeyState(VK_CONTROL.0 as i32) < 0;
                let shift = GetKeyState(VK_SHIFT.0 as i32) < 0;
                if kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && control
                    && (key == 9 || (49..=57).contains(&key) || (shift && (key == 84 || key == 87)) || key == 76) {
                    args.SetHandled(true)?;
                    if key == 76 {
                        if let Some(ui) = keyboard_app.get_webview("main") { let _ = ui.set_focus(); }
                        let _ = keyboard_app.emit_to("main", "browser-address-focus", tab);
                    } else if let Some(ui) = keyboard_app.get_webview("main") {
                        let key = if key == 9 { "Tab".to_owned() } else { char::from_u32(key).unwrap_or_default().to_string() };
                        let _ = ui.set_focus();
                        let _ = ui.eval(format!("window.dispatchEvent(new KeyboardEvent('keydown', {{key:{},ctrlKey:true,shiftKey:{},bubbles:true}}))", json!(key), shift));
                    }
                }
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
    rx.recv_timeout(Duration::from_secs(10))
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

pub(super) fn evaluate(view: &Webview, expression: &str) -> Result<Value> {
    let result = cdp(
        view,
        "Runtime.evaluate",
        json!({"expression": expression, "returnByValue": true}),
    )?;
    if !result["exceptionDetails"].is_null() {
        return Err(error(
            "browser_error",
            "Page script failed or navigation replaced its document",
        ));
    }
    Ok(result["result"]["value"].clone())
}

pub(super) fn stop(view: &Webview) -> Result<Value> {
    cdp(view, "Page.stopLoading", json!({}))
}

pub(super) fn history(view: &Webview, back: bool) -> Result<Value> {
    let history = cdp(view, "Page.getNavigationHistory", json!({}))?;
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
    )
}

pub(super) fn screenshot(view: &Webview) -> Result<Value> {
    cdp(
        view,
        "Page.captureScreenshot",
        json!({"format": "png", "captureBeyondViewport": false}),
    )
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
    )?;
    cdp(
        view,
        "Input.dispatchKeyEvent",
        json!({"type": "keyUp", "key": key, "windowsVirtualKeyCode": code}),
    )
}

fn cdp(view: &Webview, method: &str, params: Value) -> Result<Value> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;
    let method = method.to_owned();
    let params = params.to_string();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |v| unsafe {
        let done = tx.clone();
        let callback =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, result| {
                let value = status.map_err(|e| e.to_string()).and_then(|_| {
                    serde_json::from_str::<Value>(&result).map_err(|e| e.to_string())
                });
                let _ = done.try_send(value);
                Ok(())
            }));
        let result = v.controller().CoreWebView2().and_then(|core| {
            core.CallDevToolsProtocolMethod(
                &HSTRING::from(method),
                &HSTRING::from(params),
                &callback,
            )
        });
        if let Err(err) = result {
            let _ = tx.try_send(Err(err.to_string()));
        }
    })
    .map_err(native)?;
    let result = rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| error("timeout", "WebView2 did not respond"))?
        .map_err(native)?;
    if !result["error"].is_null() {
        return Err(native(&result["error"]));
    }
    Ok(result)
}
