//! 클릭 없이 창이 활성화될 때 키보드 포커스를 웹뷰로 돌려준다 (Windows 전용).
//!
//! Tauri 의 `unstable`(다중 웹뷰) 빌드는 메인 웹뷰도 자식 웹뷰로 만들고, wry 는 자식 웹뷰에는
//! 부모 창의 `WM_SETFOCUS` 를 웹뷰로 넘기는 서브클래스를 달지 않는다 (wry 0.55.1
//! `webview2/mod.rs` 의 `if !is_child { attach_parent_subclass }`). 그래서 Alt+Tab·작업
//! 표시줄로 돌아오면 포커스가 최상위 창에 머물러, 웹뷰를 클릭하기 전까지 키 입력이 어디에도
//! 가지 않는다. 여기서 같은 서브클래스를 달아 마지막으로 포커스를 가졌던 웹뷰(메인 UI 또는
//! 브라우저 탭 페이지)로 넘긴다.
//!
//! tauri-runtime-wry 2.12.0 이 같은 처리를 넣었다 (tauri-apps/tauri#15625). 그 버전으로 올리면
//! 이 모듈을 지운다.

use std::cell::RefCell;

use tauri::{AppHandle, Manager};
use webview2_com::FocusChangedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::WM_SETFOCUS;

const SUBCLASS_ID: usize = 1;

thread_local! {
    // 웹뷰 이벤트와 창 프로시저가 모두 UI 스레드에서 돌아 잠금이 필요 없다.
    static MAIN: RefCell<Option<ICoreWebView2Controller>> = const { RefCell::new(None) };
    static LAST_FOCUSED: RefCell<Option<ICoreWebView2Controller>> = const { RefCell::new(None) };
}

/// 메인 창의 포커스를 웹뷰로 넘기기 시작한다. 실패는 기록만 한다 — 클릭 없는 복귀에서
/// 키 입력이 빠질 뿐 앱은 그대로 쓸 수 있다.
pub fn install(app: &AppHandle) {
    let (Some(window), Some(main)) = (app.get_window("main"), app.get_webview("main")) else {
        crate::winlog!("window focus: main window or webview not found");
        return;
    };
    let installed = window.hwnd().and_then(|window| {
        // HWND 는 Send 가 아니라 주소로 넘긴다. 클로저는 창을 소유한 UI 스레드에서 돈다.
        let window = window.0 as isize;
        main.with_webview(move |view| {
            if let Err(err) = attach(HWND(window as _), &view.controller()) {
                crate::winlog!("window focus: attach failed: {err}");
            }
        })
    });
    if let Err(err) = installed {
        crate::winlog!("window focus: install failed: {err}");
    }
}

fn attach(window: HWND, main: &ICoreWebView2Controller) -> windows::core::Result<()> {
    track(main)?;
    MAIN.with(|slot| *slot.borrow_mut() = Some(main.clone()));
    unsafe { SetWindowSubclass(window, Some(forward_focus), SUBCLASS_ID, 0) }.ok()
}

/// 이 웹뷰가 포커스를 받으면 복귀 대상으로 기억한다. UI 스레드에서 부른다.
pub fn track(view: &ICoreWebView2Controller) -> windows::core::Result<()> {
    let mut token = 0;
    unsafe {
        view.add_GotFocus(
            &FocusChangedEventHandler::create(Box::new(|sender, _| {
                LAST_FOCUSED.with(|slot| *slot.borrow_mut() = sender);
                Ok(())
            })),
            &mut token,
        )
    }
}

unsafe extern "system" fn forward_focus(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    let result = unsafe { DefSubclassProc(window, message, wparam, lparam) };
    if message == WM_SETFOCUS && !mouse_pressed() {
        restore();
    }
    result
}

/// 눌러서 활성화한 창은 눌린 웹뷰가 스스로 포커스를 가져간다. 그때 마지막 웹뷰로 넘기면
/// 방금 누른 웹뷰와 포커스를 다툰다.
fn mouse_pressed() -> bool {
    [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON]
        .iter()
        .any(|button| unsafe { GetAsyncKeyState(i32::from(button.0)) } < 0)
}

fn restore() {
    // 포커스 이동이 GotFocus 를 다시 부를 수 있어 빌림을 쥔 채 호출하지 않는다.
    let last = LAST_FOCUSED.with(|slot| slot.borrow().clone());
    if last.is_some_and(|view| focus(&view)) {
        return;
    }
    if let Some(main) = MAIN.with(|slot| slot.borrow().clone()) {
        focus(&main);
    }
}

/// 닫혔거나 숨은 브라우저 탭은 포커스를 받지 못한다 — 그때 false 를 돌려 메인 UI 로 넘어가게 한다.
fn focus(view: &ICoreWebView2Controller) -> bool {
    let mut visible = windows::core::BOOL::default();
    unsafe {
        view.IsVisible(&mut visible).is_ok()
            && visible.as_bool()
            && view
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
                .is_ok()
    }
}
