//! Windows 셸에 앱 신원(AppUserModelID)을 등록한다 — needsInput 토스트가
//! "mast" 발신자로 뜨게 하는 전제 조건.
//!
//! # 왜 필요한가
//!
//! mast 는 인스톨러 없이 단독 exe 로 배포되어 셸에 AUMID·시작 메뉴 바로가기가 등록되지
//! 않는다. WinRT 는 미등록 발신자의 토스트를 **조용히 버린다** — `CreateToastNotifierWithId`
//! 는 성공하고 표시만 안 된다.
//!
//! # 계약
//!
//! 등록 AUMID 와 토스트에 실리는 AUMID(`commands::notify_toast` 의 `Toast::new`)가
//! **정확히 같아야** 표시된다. 둘 다 [`APP_USER_MODEL_ID`] 상수 하나를 쓴다.
//!
//! 값을 바꾸면 기존 머신에서 .lnk 재작성과 셸 재색인이 일어나고 Windows 알림 설정의 옛 항목이
//! 고아로 남으므로 개명 같은 이유 없이는 바꾸지 않는다(ADR-0017 결정 3). 같은 문자열이 Tauri
//! 앱 데이터 디렉터리 이름(`%APPDATA%\app.mast.desktop` — `settings.json`, `toast.log`)이기도
//! 해서 아래 `const _` 가 `tauri.conf.json` 의 `identifier` 와 대조한다.
//!
//! 개발 빌드도 등록한다. 등록하지 않으면 개발 빌드의 토스트가 조용히 사라진다. 대가로
//! `npm run tauri dev` 도 `mast.lnk` 를 만들고, 개발 빌드와 배포본을 번갈아 실행하면 바로가기
//! target 이 바뀐다. 같은 exe 의 재실행은 [`needs_rewrite`] 가 무작업으로 판정한다.
//!
//! # 등록 방법 (Win32 정석)
//!
//! MSDN "How to enable desktop toast notifications through an AppUserModelID" 대로:
//! 시작 메뉴에 `System.AppUserModel.ID` 속성을 가진 바로가기(.lnk)를 설치해야 하고,
//! 프로세스는 `SetCurrentProcessExplicitAppUserModelID` 로 같은 AUMID 를 선언한다.
//! "Without a valid shortcut installed in the Start screen or in All Programs, you
//! cannot raise a toast notification from a desktop app" — 바로가기가 **필수**다.
//! 인스톨러가 없으므로 MSDN 이 권하는 "인스톨러에서 생성"을 못 하고, 같은 문서의
//! 앱 코드 예제(`TryCreateShortcut`/`InstallShortcut`)를 따라 앱 시작 시 만든다.

use std::path::{Path, PathBuf};
use crate::winlog;

/// AUMID 문자열 리터럴의 단일 출처. [`APP_USER_MODEL_ID`] 와 아래 컴파일 타임
/// 대조용 `concat!` 이 같은 리터럴을 쓰게 하려고 매크로로 둔다 (`concat!` 은 상수가
/// 아니라 리터럴만 받는다).
macro_rules! aumid_literal {
    () => {
        "app.mast.desktop"
    };
}

/// 셸에 등록하고 `commands::notify_toast` 가 토스트에 싣는 AppUserModelID — **하나의
/// 상수**다 (모듈 doc "어떤 AUMID 를 등록하나" 참조).
pub const APP_USER_MODEL_ID: &str = aumid_literal!();

/// 시작 메뉴에 만들 바로가기 파일명. 사용자에게 그대로 보이는 이름이라
/// `productName`("mast")과 맞춘다.
const SHORTCUT_FILE_NAME: &str = "mast.lnk";

/// `%APPDATA%` 아래 시작 메뉴 프로그램 폴더의 상대 경로 (per-user 설치).
const START_MENU_RELATIVE: &str = r"Microsoft\Windows\Start Menu\Programs";

/// [`APP_USER_MODEL_ID`] 가 `tauri.conf.json` 의 `identifier` 와 어긋나면 **빌드를
/// 깬다**. 토스트 발신 자체는 이제 identifier 와 무관하지만(우리 상수로 직접 발신),
/// identifier 는 앱 데이터 디렉터리 이름이라 둘이 갈라지면 진단 안내
/// (`%APPDATA%\app.mast.desktop\toast.log`)가 거짓이 된다. 갈라져도 앱은 멀쩡히
/// 뜨므로 런타임에 잡을 방법이 없다 — 그래서 컴파일 타임 대조다.
///
/// JSON 을 const 로 파싱할 수는 없어서 따옴표까지 포함한 값 문자열이 conf 안에
/// 있는지만 본다. identifier 를 바꾸면 이 assert 가 먼저 터져서 여기까지 같이
/// 고치게 된다.
const _: () = {
    const CONF: &str = include_str!("../tauri.conf.json");
    const QUOTED_AUMID: &str = concat!("\"", aumid_literal!(), "\"");
    assert!(
        contains(CONF.as_bytes(), QUOTED_AUMID.as_bytes()),
        "tauri.conf.json 의 identifier 가 APP_USER_MODEL_ID 와 다르다 — \
         플러그인이 싣는 AUMID 와 우리가 등록하는 AUMID 가 어긋나면 토스트가 조용히 사라진다"
    );
};

/// const 문맥에서 쓰는 부분 문자열 검사 (표준 `str::contains` 는 const 가 아니다).
const fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.len() > haystack.len() {
        return false;
    }
    let mut start = 0;
    while start + needle.len() <= haystack.len() {
        let mut i = 0;
        while i < needle.len() && haystack[start + i] == needle[i] {
            i += 1;
        }
        if i == needle.len() {
            return true;
        }
        start += 1;
    }
    false
}

fn shortcut_path_in(appdata: &Path) -> PathBuf {
    appdata.join(START_MENU_RELATIVE).join(SHORTCUT_FILE_NAME)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExistingLink {
    /// `IShellLink::GetPath(SLGP_RAWPATH)` 로 읽은 대상 exe. 읽기 실패면 `None`.
    target: Option<PathBuf>,
    /// 프로퍼티 스토어의 `System.AppUserModel.ID`. 없거나 문자열이 아니면 `None`.
    aumid: Option<String>,
}

/// 기존 바로가기를 다시 써야 하는지 — **멱등성의 핵심 판정**.
///
/// 버전 갈아끼우기로 exe 경로가 바뀌면 target 을 갱신해야 하고(안 그러면 시작 메뉴
/// 바로가기가 없어진 exe 를 가리킨다), AUMID 가 다르면 토스트가 안 뜬다. 둘 다 같으면
/// 무작업이다 — 매 부팅마다 .lnk 를 다시 쓰면 파일 mtime 이 계속 바뀌어 셸이 불필요하게
/// 재색인한다.
///
/// 경로는 Windows 파일시스템 규칙대로 **대소문자 무시**로 비교하고, AUMID 는 셸이
/// 정확 일치로 매칭하므로 **그대로** 비교한다.
fn needs_rewrite(existing: &ExistingLink, want_target: &Path, want_aumid: &str) -> bool {
    let target_ok = existing.target.as_deref().is_some_and(|have| {
        have.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&want_target.as_os_str().to_string_lossy())
    });
    let aumid_ok = existing.aumid.as_deref() == Some(want_aumid);
    !(target_ok && aumid_ok)
}

/// 이번 부팅에서 바로가기에 무슨 일을 했는지 — 로그 문구용.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShortcutOutcome {
    Created,
    Updated,
    UpToDate,
}

impl ShortcutOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Updated => "updated",
            Self::UpToDate => "up to date",
        }
    }
}

/// 앱 시작 시 1회 호출 — 프로세스 AUMID 를 선언하고 시작 메뉴 바로가기를 맞춘다.
///
/// **호출 위치가 계약이다**: 웹뷰·플러그인 초기화보다 먼저, `main()` 최선두여야 한다.
/// `SetCurrentProcessExplicitAppUserModelID` 는 프로세스가 창·타스크바와 얽히기 전에
/// 불려야 유효하기 때문이다.
///
/// 실패해도 앱을 죽이지 않는다 — 알림 하나 때문에 부팅이 막히면 손해가 크다. 대신
/// 원인을 한 줄로 남긴다 — 이게 실패하면 needsInput 알림 경로 전체가 죽는다.
pub fn register() {
    match register_inner() {
        Ok(outcome) => {
            winlog!(
                "app-identity: AUMID {APP_USER_MODEL_ID} registered; start menu shortcut {}",
                outcome.as_str()
            );
        }
        Err(err) => {
            // loud 하게 남긴다: 이게 실패하면 needsInput 토스트가 통째로 안 뜬다.
            winlog!(
                "app-identity: FAILED to register the shell identity; \
                 needs-input toasts will not appear: {err}"
            );
        }
    }
}

fn register_inner() -> Result<ShortcutOutcome, String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    // 바로가기 target 은 **canonicalize 하지 않은** 경로다 — Windows 의 canonicalize 는
    // `\\?\` verbatim 경로를 돌려주는데 그건 .lnk target 으로 부적절하다.
    let exe = std::env::current_exe().map_err(|err| format!("cannot resolve the exe path: {err}"))?;

    // 토스트 발신자 신원의 절반이고, 타스크바 그룹화·창 신원에도 쓰인다.
    let wide_aumid = to_wide(APP_USER_MODEL_ID);
    unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(wide_aumid.as_ptr())) }
        .map_err(|err| format!("SetCurrentProcessExplicitAppUserModelID failed: {err}"))?;

    let appdata = std::env::var_os("APPDATA")
        .ok_or_else(|| "the APPDATA environment variable is not set".to_string())?;
    let shortcut = shortcut_path_in(Path::new(&appdata));

    ensure_shortcut(&shortcut, &exe, APP_USER_MODEL_ID)
}

fn ensure_shortcut(
    shortcut: &Path,
    exe: &Path,
    aumid: &str,
) -> Result<ShortcutOutcome, String> {
    // COM 은 우리가 직접 잡는다 — 이 함수는 tauri 가 웹뷰용으로 COM 을 초기화하기
    // 훨씬 전(main 최선두)에 돌기 때문에 아파트가 아직 없다.
    let _com = ComScope::enter();

    let existed = shortcut.exists();
    if existed {
        // 읽기 실패는 "판정 불가" 로 취급해 덮어쓴다 — 손상된 .lnk 를 그대로 두면
        // 토스트가 계속 안 뜬다.
        let existing = read_shortcut(shortcut).unwrap_or_else(|err| {
            winlog!("app-identity: cannot read the existing shortcut, rewriting it: {err}");
            ExistingLink {
                target: None,
                aumid: None,
            }
        });
        if !needs_rewrite(&existing, exe, aumid) {
            return Ok(ShortcutOutcome::UpToDate);
        }
    }

    if let Some(parent) = shortcut.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("cannot create the start menu folder: {err}"))?;
    }

    write_shortcut(shortcut, exe, aumid)?;

    Ok(if existed {
        ShortcutOutcome::Updated
    } else {
        ShortcutOutcome::Created
    })
}

fn read_shortcut(shortcut: &Path) -> Result<ExistingLink, String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Com::{IPersistFile, STGM_READ};
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::SLGP_RAWPATH;

    let link = create_shell_link()?;
    let wide_path = to_wide_os(shortcut.as_os_str());

    let persist: IPersistFile = link
        .cast()
        .map_err(|err| format!("IShellLink does not expose IPersistFile: {err}"))?;
    unsafe { persist.Load(PCWSTR(wide_path.as_ptr()), STGM_READ) }
        .map_err(|err| format!("cannot load the existing shortcut: {err}"))?;

    // IShellLink::GetPath 의 계약상 버퍼는 MAX_PATH. 넘치면 잘린 값이 와서 비교가
    // 어긋나고 재작성될 뿐이라 안전하게 실패한다.
    let mut buf = [0u16; 260];
    let target = unsafe { link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32) }
        .ok()
        .and_then(|()| {
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            if end == 0 {
                None
            } else {
                Some(PathBuf::from(String::from_utf16_lossy(&buf[..end])))
            }
        });

    let store: IPropertyStore = link
        .cast()
        .map_err(|err| format!("IShellLink does not expose IPropertyStore: {err}"))?;
    let mut value: PROPVARIANT = unsafe { store.GetValue(&PKEY_AppUserModel_ID) }
        .map_err(|err| format!("cannot read System.AppUserModel.ID: {err}"))?;

    // SAFETY: GetValue 가 채운 PROPVARIANT 다. vt 를 먼저 확인하고 그 분기에서만
    // pwszVal 을 읽는다.
    let aumid = unsafe {
        if value.Anonymous.Anonymous.vt == VT_LPWSTR {
            let raw = value.Anonymous.Anonymous.Anonymous.pwszVal;
            if raw.is_null() {
                None
            } else {
                raw.to_string().ok()
            }
        } else {
            None
        }
    };

    // GetValue 가 준 PROPVARIANT 는 **우리 소유**라 반드시 해제한다.
    unsafe {
        let _ = PropVariantClear(&mut value);
    }

    Ok(ExistingLink { target, aumid })
}

/// 기존 파일이 있으면 덮어쓴다 (`IPersistFile::Save` overwrite).
fn write_shortcut(shortcut: &Path, exe: &Path, aumid: &str) -> Result<(), String> {
    use windows::core::{Interface, PCWSTR, PWSTR};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::IPersistFile;
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

    let link = create_shell_link()?;

    let wide_exe = to_wide_os(exe.as_os_str());
    unsafe { link.SetPath(PCWSTR(wide_exe.as_ptr())) }
        .map_err(|err| format!("IShellLink::SetPath failed: {err}"))?;

    // 시작 메뉴에서 직접 실행될 수 있는 바로가기이므로 작업 디렉터리도 맞춰 둔다.
    if let Some(dir) = exe.parent() {
        let wide_dir = to_wide_os(dir.as_os_str());
        unsafe { link.SetWorkingDirectory(PCWSTR(wide_dir.as_ptr())) }
            .map_err(|err| format!("IShellLink::SetWorkingDirectory failed: {err}"))?;
    }

    let store: IPropertyStore = link
        .cast()
        .map_err(|err| format!("IShellLink does not expose IPropertyStore: {err}"))?;

    // VT_LPWSTR PROPVARIANT 를 손으로 조립한다 — windows 0.61 에는
    // InitPropVariantFromString 바인딩이 없다.
    //
    // 이 버퍼는 **우리 소유**라 `PropVariantClear` 를 부르지 않는다 — CoTaskMemAlloc 으로
    // 잡지 않은 포인터를 넘기면 CoTaskMemFree 가 남의 힙을 건드린다. 대신 **버퍼 수명을
    // `IPersistFile::Save` 까지 끌고 간다**: 문서상 SetValue 는 변경을 in-memory 구조에
    // 쌓고 Commit 이 스트림에 쓴다고만 하지, 문자열을 정확히 언제 복사하는지는 계약에
    // 없다. MSDN 토스트 예제도 Save 를 **마친 뒤에야** PropVariantClear 를 부르므로 그
    // 순서를 그대로 따른다 (함수 끝의 `drop(wide_aumid)` 가 그 지점이다).
    let mut wide_aumid = to_wide(aumid);
    let mut value = PROPVARIANT::default();
    unsafe {
        // ManuallyDrop 유니온 필드는 자동 DerefMut 가 막혀 있어 명시적 `*` 로 쓴다
        // (rustc 지시). 안쪽은 VARENUM·유니온뿐이라 덮어써도 떨어질 소멸자가 없다.
        let raw = &mut *value.Anonymous.Anonymous;
        raw.vt = VT_LPWSTR;
        raw.Anonymous.pwszVal = PWSTR(wide_aumid.as_mut_ptr());
    }

    unsafe { store.SetValue(&PKEY_AppUserModel_ID, &value) }
        .map_err(|err| format!("cannot set System.AppUserModel.ID: {err}"))?;
    unsafe { store.Commit() }
        .map_err(|err| format!("cannot commit the shortcut property store: {err}"))?;

    let persist: IPersistFile = link
        .cast()
        .map_err(|err| format!("IShellLink does not expose IPersistFile: {err}"))?;
    let wide_path = to_wide_os(shortcut.as_os_str());
    unsafe { persist.Save(PCWSTR(wide_path.as_ptr()), true) }
        .map_err(|err| format!("cannot save the shortcut: {err}"))?;

    // 여기까지 `value` 안의 포인터가 이 버퍼를 가리킨다 — Save 를 마친 뒤에 놓는다.
    // (중간 `?` 로 일찍 빠져나가는 경로는 Save 도 안 했으므로 같이 끝나 문제없다.)
    drop(wide_aumid);

    Ok(())
}

fn create_shell_link() -> Result<windows::Win32::UI::Shell::IShellLinkW, String> {
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe { CoCreateInstance::<_, IShellLinkW>(&ShellLink, None, CLSCTX_INPROC_SERVER) }
        .map_err(|err| format!("cannot create the ShellLink COM object: {err}"))
}

/// `main()` 최선두에서 도는 코드라 아직 아무도 COM 을 초기화하지 않았다. 우리가 잡은
/// 초기화 카운트는 스코프를 나가며 정확히 하나 되돌려, 뒤이어 도는 tauri/wry 의 COM
/// 초기화에 간섭하지 않는다.
struct ComScope {
    /// `CoUninitialize` 를 우리가 불러야 하는가. `RPC_E_CHANGED_MODE`(이미 다른
    /// 아파트로 초기화됨)면 **우리 카운트가 아니므로** 해제하면 안 된다.
    owns_apartment: bool,
}

impl ComScope {
    fn enter() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

        // 셸 인터페이스는 STA 가 정석이다. S_OK(첫 초기화)와 S_FALSE(중첩 초기화)
        // 둘 다 우리 카운트가 하나 늘어난 것이라 해제 대상이다.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        Self {
            owns_apartment: hr.is_ok(),
        }
    }
}

impl Drop for ComScope {
    fn drop(&mut self) {
        use windows::Win32::System::Com::CoUninitialize;

        if self.owns_apartment {
            unsafe { CoUninitialize() };
        }
    }
}

/// null 종료 UTF-16 버퍼 (Win32 문자열 인자용).
fn to_wide(value: &str) -> Vec<u16> {
    to_wide_os(std::ffi::OsStr::new(value))
}

fn to_wide_os(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 주의: 이 테스트들은 `#[cfg(windows)]` 모듈 안이라 Windows 타깃에서만
    // 컴파일·실행된다. 리눅스 개발 환경의 게이트는 clippy 로 **컴파일만** 검증한다.

    #[test]
    fn shortcut_path_lands_in_the_start_menu_programs_folder() {
        let path = shortcut_path_in(Path::new(r"C:\Users\me\AppData\Roaming"));
        assert_eq!(
            path,
            PathBuf::from(
                r"C:\Users\me\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\mast.lnk"
            )
        );
    }

    #[test]
    fn matching_target_and_aumid_is_a_no_op() {
        let existing = ExistingLink {
            target: Some(PathBuf::from(r"C:\apps\mast.exe")),
            aumid: Some(APP_USER_MODEL_ID.to_string()),
        };
        assert!(!needs_rewrite(
            &existing,
            Path::new(r"C:\apps\mast.exe"),
            APP_USER_MODEL_ID
        ));
    }

    #[test]
    fn target_comparison_ignores_case_like_the_filesystem() {
        let existing = ExistingLink {
            target: Some(PathBuf::from(r"C:\Apps\Mast.exe")),
            aumid: Some(APP_USER_MODEL_ID.to_string()),
        };
        assert!(!needs_rewrite(
            &existing,
            Path::new(r"c:\apps\mast.exe"),
            APP_USER_MODEL_ID
        ));
    }

    #[test]
    fn a_moved_exe_forces_a_rewrite() {
        // 버전 갈아끼우기로 exe 가 다른 경로에서 실행된 경우.
        let existing = ExistingLink {
            target: Some(PathBuf::from(r"C:\old\mast.exe")),
            aumid: Some(APP_USER_MODEL_ID.to_string()),
        };
        assert!(needs_rewrite(
            &existing,
            Path::new(r"C:\new\mast.exe"),
            APP_USER_MODEL_ID
        ));
    }

    #[test]
    fn a_wrong_or_missing_aumid_forces_a_rewrite() {
        let target = PathBuf::from(r"C:\apps\mast.exe");
        let wrong = ExistingLink {
            target: Some(target.clone()),
            aumid: Some("something.else".to_string()),
        };
        assert!(needs_rewrite(&wrong, &target, APP_USER_MODEL_ID));

        let missing = ExistingLink {
            target: Some(target.clone()),
            aumid: None,
        };
        assert!(needs_rewrite(&missing, &target, APP_USER_MODEL_ID));
    }

    #[test]
    fn an_unreadable_shortcut_forces_a_rewrite() {
        let existing = ExistingLink {
            target: None,
            aumid: None,
        };
        assert!(needs_rewrite(
            &existing,
            Path::new(r"C:\apps\mast.exe"),
            APP_USER_MODEL_ID
        ));
    }
}
