use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use mast_core::command::{Command, CommandOutput, NewTab};
use mast_core::model::{PaneId, TabId, TabKind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Webview};

use crate::state::{publish_state, AppState};

pub struct BrowserState {
    enabled: bool,
    operation: Mutex<()>,
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
}

impl BrowserState {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            operation: Mutex::new(()),
            pages: Mutex::new(HashMap::new()),
        }
    }
}

pub fn enabled(app: &AppHandle) -> bool {
    app.try_state::<BrowserState>().is_some_and(|s| s.enabled)
}

pub fn has_pages(app: &AppHandle) -> bool {
    app.try_state::<BrowserState>()
        .is_some_and(|s| !s.pages.lock().unwrap().is_empty())
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

fn event(app: &AppHandle, tab: u64, change: impl FnOnce(&mut Page)) {
    let state = app.state::<BrowserState>();
    let mut pages = state.pages.lock().unwrap();
    if let Some(page) = pages.get_mut(&tab) {
        change(page);
        let _ = app.emit_to("main", "browser-changed", page.clone());
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

pub fn prune(app: &AppHandle, model: &mast_core::model::AppState) {
    let Some(state) = app.try_state::<BrowserState>() else {
        return;
    };
    if !state.enabled {
        return;
    }
    let closed = {
        let mut pages = state.pages.lock().unwrap();
        let closed: Vec<u64> = pages
            .keys()
            .copied()
            .filter(|id| {
                !model
                    .workspaces
                    .iter()
                    .flat_map(|w| w.panes.values())
                    .flat_map(|p| &p.tabs)
                    .any(|t| t.id.0 == *id && matches!(t.kind, TabKind::Browser { .. }))
            })
            .collect();
        for id in &closed {
            pages.remove(id);
        }
        closed
    };
    for id in closed {
        if let Some(view) = app.get_webview(&label(id)) {
            let _ = view.close();
        }
    }
}

pub fn hide_all(app: &AppHandle) {
    let Some(state) = app.try_state::<BrowserState>() else {
        return;
    };
    let tabs: Vec<u64> = state
        .pages
        .lock()
        .unwrap()
        .values_mut()
        .map(|page| {
            page.visible = false;
            page.tab
        })
        .collect();
    for tab in tabs {
        if let Some(view) = app.get_webview(&label(tab)) {
            let _ = view.hide();
            let _ = suspend(&view, false);
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
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

fn ensure(app: &AppHandle, tab: u64) -> Result<Webview> {
    check_enabled(app)?;
    let (workspace, _, url) = target(app, tab)?;
    let url = mast_core::browser::normalize_url(&url).map_err(|e| error("invalid_params", e))?;
    if let Some(view) = app.get_webview(&label(tab)) {
        return Ok(view);
    }
    let state = app.state::<BrowserState>();
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
        },
    );
    let app_nav = app.clone();
    let app_load = app.clone();
    let app_title = app.clone();
    let app_popup = app.clone();
    let profile = app
        .path()
        .app_data_dir()
        .map_err(native)?
        .join("browser")
        .join(format!("workspace-{workspace}"));
    let initial = "about:blank";
    let builder = tauri::webview::WebviewBuilder::new(
        label(tab),
        tauri::WebviewUrl::External(initial.parse().map_err(native)?),
    )
    .data_directory(profile)
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
        let url = if payload.url().as_str() == "about:blank" {
            String::new()
        } else {
            payload.url().to_string()
        };
        event(&app_load, tab, |p| {
            p.loading = loading;
            p.url = url.clone();
            p.error = None;
        });
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
    let result = app
        .get_window("main")
        .ok_or_else(|| error("not_found", "Main window is unavailable"))?
        .add_child(
            builder,
            tauri::LogicalPosition::new(-20000.0, -20000.0),
            tauri::LogicalSize::new(1024.0, 768.0),
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
    if let Err(err) = configure(app, tab, &view) {
        let _ = view.close();
        state.pages.lock().unwrap().remove(&tab);
        return Err(err);
    }
    if !url.is_empty() {
        view.navigate(url.parse().map_err(native)?)
            .map_err(native)?;
    }
    if target(app, tab).is_err() {
        let _ = view.close();
        state.pages.lock().unwrap().remove(&tab);
        return Err(error("not_found", "Tab closed while browser was starting"));
    }
    Ok(view)
}

#[cfg(windows)]
fn configure(app: &AppHandle, tab: u64, view: &Webview) -> Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY;
    use webview2_com::{
        AcceleratorKeyPressedEventHandler, NavigationCompletedEventHandler,
        PermissionRequestedEventHandler,
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

#[cfg(not(windows))]
fn configure(_app: &AppHandle, _tab: u64, _view: &Webview) -> Result<()> {
    Err(error("not_supported", "Browser requires Windows WebView2"))
}

#[cfg(windows)]
fn suspend(view: &Webview, visible: bool) -> Result<()> {
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
#[cfg(not(windows))]
fn suspend(_view: &Webview, _visible: bool) -> Result<()> {
    Ok(())
}

#[tauri::command]
pub async fn browser_surface(
    app: AppHandle,
    tab: u64,
    owner: String,
    bounds: Option<Bounds>,
) -> Result<Value> {
    check_enabled(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        if let Some(bounds) = bounds {
            let _operation = state.operation.lock().unwrap();
            if !bounds.valid() {
                return Err(error("invalid_params", "Invalid browser bounds"));
            }
            let view = ensure(&app, tab)?;
            view.set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
                .map_err(native)?;
            view.set_size(tauri::LogicalSize::new(bounds.width, bounds.height))
                .map_err(native)?;
            suspend(&view, true)?;
            view.show().map_err(native)?;
            event(&app, tab, |p| {
                p.visible = true;
                p.owner = owner;
            });
        } else if state
            .pages
            .lock()
            .unwrap()
            .get(&tab)
            .is_some_and(|p| p.owner == owner)
        {
            event(&app, tab, |p| p.visible = false);
            if let Some(view) = app.get_webview(&label(tab)) {
                view.hide().map_err(native)?;
                if let Ok(_idle) = state.operation.try_lock() {
                    suspend(&view, false)?;
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
    check_enabled(&app)?;
    tauri::async_runtime::spawn_blocking(move || execute(&app, request, None))
        .await
        .map_err(native)?
}

pub fn execute(app: &AppHandle, request: Request, workspace: Option<u64>) -> Result<Value> {
    check_enabled(app)?;
    let browser = app.state::<BrowserState>();
    let _operation = browser.operation.lock().unwrap();
    if request.action == "list" {
        let state = app.state::<AppState>();
        let d = state.dispatcher.lock().unwrap();
        let tabs: Vec<Value> = d.state().workspaces.iter().filter(|w| workspace.is_none_or(|id| w.id.0 == id))
            .flat_map(|w| w.panes.values().flat_map(move |p| p.tabs.iter().filter_map(move |t| {
                if let TabKind::Browser { url } = &t.kind { Some(json!({"tab": t.id.0, "pane": p.id.0, "workspace": w.id.0, "url": url, "title": t.title})) } else { None }
            }))).collect();
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
    if request.action == "close" {
        let state = app.state::<AppState>();
        let mut d = state.dispatcher.lock().unwrap();
        d.dispatch(Command::CloseTab { tab: TabId(tab) })
            .map_err(native)?;
        publish_state(app, &d);
        return Ok(json!({"closed": tab}));
    }
    let view = ensure(app, tab)?;
    suspend(&view, true)?;
    let result = action(&view, &request);
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
    if !visible {
        let _ = suspend(&view, false);
    }
    if let Err(err) = &result {
        event(app, tab, |p| p.error = Some(err.message.clone()));
    }
    result
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
        "stop" => cdp(view, "Page.stopLoading", json!({})),
        "back" | "forward" => {
            let history = cdp(view, "Page.getNavigationHistory", json!({}))?;
            let current = history["currentIndex"].as_i64().unwrap_or(0);
            let index = current + if request.action == "back" { -1 } else { 1 };
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
        "screenshot" => {
            let size = cdp(
                view,
                "Runtime.evaluate",
                json!({"expression": "innerWidth * innerHeight * devicePixelRatio * devicePixelRatio", "returnByValue": true}),
            )?;
            if size["result"]["value"]
                .as_f64()
                .is_none_or(|area| area > 16_777_216.0)
            {
                return Err(error(
                    "too_large",
                    "Screenshot exceeds 16 megapixels; resize the browser pane",
                ));
            }
            cdp(
                view,
                "Page.captureScreenshot",
                json!({"format": "png", "captureBeyondViewport": false}),
            )
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
                let result = cdp(
                    view,
                    "Runtime.evaluate",
                    json!({"expression": expr, "returnByValue": true}),
                )?;
                if !result["exceptionDetails"].is_null() {
                    return Err(error(
                        "browser_error",
                        "Page script failed or navigation replaced its document",
                    ));
                }
                let value = result["result"]["value"].clone();
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
                    let code = match key { "Enter" => 13, "Tab" => 9, "Escape" => 27, "Backspace" => 8, "ArrowLeft" => 37, "ArrowUp" => 38, "ArrowRight" => 39, "ArrowDown" => 40, _ => return Err(error("not_supported", "Supported keys: Enter, Tab, Escape, Backspace, ArrowLeft/Up/Right/Down")) };
                    cdp(
                        view,
                        "Input.dispatchKeyEvent",
                        json!({"type": "keyDown", "key": key, "windowsVirtualKeyCode": code}),
                    )?;
                    return cdp(
                        view,
                        "Input.dispatchKeyEvent",
                        json!({"type": "keyUp", "key": key, "windowsVirtualKeyCode": code}),
                    );
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

#[cfg(windows)]
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
#[cfg(not(windows))]
fn cdp(_view: &Webview, _method: &str, _params: Value) -> Result<Value> {
    Err(error("not_supported", "WebView2 requires Windows"))
}
