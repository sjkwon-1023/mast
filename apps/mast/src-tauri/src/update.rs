use std::sync::Arc;

use mast_core::update::{newer_release, UpdateCheck, UpdateInfo};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct UpdateState(Arc<UpdateCheck>);

#[tauri::command]
pub fn get_update_info(state: State<'_, UpdateState>) -> UpdateInfo {
    state.0.snapshot()
}

pub fn init(app: &AppHandle) {
    let cache = Arc::new(UpdateCheck::new(env!("CARGO_PKG_VERSION")));
    app.manage(UpdateState(cache.clone()));
    if !cache.begin() {
        return;
    }
    let handle = app.clone();
    let worker_cache = cache.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("mast-update-check".into())
        .spawn(move || {
            let result =
                fetch_release().and_then(|body| newer_release(env!("CARGO_PKG_VERSION"), &body));
            let newer = match result {
                Ok(newer) => newer,
                Err(error) => {
                    crate::winlog!("update check failed: {error}");
                    None
                }
            };
            let info = worker_cache.finish(newer);
            if let Err(error) = handle.emit("update-checked", &info) {
                crate::winlog!("cannot publish update result: {error}");
            }
        })
    {
        cache.finish(None);
        crate::winlog!("cannot start update check: {error}");
    }
}

#[cfg(not(windows))]
fn fetch_release() -> Result<Vec<u8>, String> {
    Err("release checking is available on Windows only".into())
}

#[cfg(windows)]
fn fetch_release() -> Result<Vec<u8>, String> {
    native::fetch()
}

#[cfg(windows)]
mod native {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use std::time::{Duration, Instant};

    use mast_core::update::MAX_RELEASE_BYTES;
    use windows_sys::Win32::Networking::WinHttp::*;

    struct Handle(*mut c_void);

    impl Handle {
        fn new(raw: *mut c_void) -> Result<Self, String> {
            if raw.is_null() {
                Err(std::io::Error::last_os_error().to_string())
            } else {
                Ok(Self(raw))
            }
        }

        fn option(&self, name: u32, value: u32) -> Result<(), String> {
            checked(unsafe { WinHttpSetOption(self.0, name, (&value as *const u32).cast(), 4) })
        }

        fn timeouts(&self, milliseconds: i32) -> Result<(), String> {
            checked(unsafe {
                WinHttpSetTimeouts(
                    self.0,
                    milliseconds,
                    milliseconds,
                    milliseconds,
                    milliseconds,
                )
            })
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            // 동기 호출이 반환된 뒤 같은 스레드에서만 닫는다. 다른 스레드의 강제
            // CloseHandle은 WinHTTP 동기 요청과 경쟁하므로 timeout으로 종료한다.
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }

    fn checked(success: i32) -> Result<(), String> {
        if success == 0 {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(())
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    pub(super) fn fetch() -> Result<Vec<u8>, String> {
        let session = Handle::new(unsafe {
            WinHttpOpen(
                wide(concat!("mast/", env!("CARGO_PKG_VERSION"))).as_ptr(),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                null(),
                null(),
                0,
            )
        })?;
        session.timeouts(3000)?;
        session.option(
            WINHTTP_OPTION_SECURE_PROTOCOLS,
            WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3,
        )?;
        let connection = Handle::new(unsafe {
            WinHttpConnect(session.0, wide("api.github.com").as_ptr(), 443, 0)
        })?;
        let request = Handle::new(unsafe {
            WinHttpOpenRequest(
                connection.0,
                wide("GET").as_ptr(),
                wide("/repos/sjkwon-1023/mast/releases/latest").as_ptr(),
                null(),
                null(),
                null(),
                WINHTTP_FLAG_SECURE,
            )
        })?;
        request.option(
            WINHTTP_OPTION_DISABLE_FEATURE,
            WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION,
        )?;
        request.option(WINHTTP_OPTION_MAX_RESPONSE_HEADER_SIZE, 16 * 1024)?;
        request.timeouts(3000)?;
        let headers =
            wide("Accept: application/vnd.github+json\r\nX-GitHub-Api-Version: 2022-11-28\r\n");
        checked(unsafe {
            WinHttpSendRequest(
                request.0,
                headers.as_ptr(),
                (headers.len() - 1) as u32,
                null(),
                0,
                0,
                0,
            )
        })?;
        checked(unsafe { WinHttpReceiveResponse(request.0, null_mut()) })?;
        let mut status = 0_u32;
        let mut length = 4_u32;
        checked(unsafe {
            WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                null(),
                (&mut status as *mut u32).cast(),
                &mut length,
                null_mut(),
            )
        })?;
        if status != 200 {
            return Err(format!("GitHub returned HTTP {status}"));
        }
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut body = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or("release body read timed out")?;
            request.timeouts(remaining.as_millis().clamp(1, 3000) as i32)?;
            let mut read = 0_u32;
            checked(unsafe {
                WinHttpReadData(
                    request.0,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    &mut read,
                )
            })?;
            if Instant::now() >= deadline {
                return Err("release body read timed out".into());
            }
            if read == 0 {
                return Ok(body);
            }
            if body.len() + read as usize > MAX_RELEASE_BYTES {
                return Err("release response exceeds 64 KiB".into());
            }
            body.extend_from_slice(&buffer[..read as usize]);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn displayed_version_matches_tauri_version() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "manual GitHub network probe"]
    fn github_release_probe() {
        let body = super::fetch_release().unwrap();
        let latest = mast_core::update::newer_release("0.0.0", &body).unwrap();
        assert!(latest.is_some());
    }
}
