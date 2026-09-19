//! COM으로 규칙을 수집하고 사용자 요청 시 netsh를 승격한다 (ADR-0016).
//! 적용 성공 여부는 netsh 종료 코드가 아니라 재감지 결과로 판단한다.

#[cfg(any(windows, test))]
use mast_core::firewall::Verdict;
#[cfg(windows)]
use mast_core::firewall::{
    firewall_off, judge, normalize_exe, profile_names, script_text_for, Protocol, RuleRecord,
    Target, PROFILE_DOMAIN, PROFILE_PRIVATE, PROFILE_PUBLIC,
};

#[cfg(windows)]
use crate::winlog;
#[cfg(windows)]
use windows::Win32::NetworkManagement::WindowsFirewall::INetFwRule;
#[cfg(windows)]
use windows::Win32::System::{Com::IDispatch, Variant::VARIANT};

/// netsh **실행**의 상한. UAC 창 자체는 여기 들어가지 않는다 — `ShellExecuteExW` 의
/// `runas` 는 사용자가 그 창에 답할 때까지 반환하지 않으므로(그래서 거절이
/// `ERROR_CANCELLED` 로 구분된다) 그 대기에는 상한이 없고, 그동안 blocking 풀의
/// 스레드 하나가 잡혀 있다. 이 값은 그 뒤 몇 ms 짜리 netsh 가 걸렸을 때의 안전장치다.
#[cfg(windows)]
const NETSH_TIMEOUT_MS: u32 = 120_000;

/// 프론트가 읽는 감지 결과. 미러는 `backend.ts` 의 같은 이름 타입이다.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    pub state: &'static str,
    pub detail: Option<String>,
    pub exe: String,
    pub port: u16,
    pub current_profiles: Vec<String>,
}

/// [`allow`] 의 결과. `status` 는 **시도 뒤 재감지** 값이라, 프론트는 outcome 이
/// 무엇이든 이 필드 하나로 화면을 갱신하면 된다.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AllowOutcome {
    pub outcome: &'static str,
    pub detail: Option<String>,
    pub status: FirewallStatus,
}

impl FirewallStatus {
    #[cfg(any(windows, test))]
    fn new(verdict: Verdict, exe: String, port: u16, current_profiles: Vec<String>) -> Self {
        let profiles_text = current_profiles.join(", ");
        let (state, detail) = match verdict {
            Verdict::FirewallOff => ("firewallOff", None),
            Verdict::Blocked { rule } => ("blocked", Some(rule)),
            Verdict::Allowed => ("allowed", None),
            Verdict::StalePath { program } => ("stalePath", Some(program)),
            Verdict::ProfileMismatch => ("profileMismatch", Some(profiles_text)),
            Verdict::Missing => ("missing", None),
        };
        Self {
            state,
            detail,
            exe,
            port,
            current_profiles,
        }
    }

    /// 감지 자체가 실패했을 때. 프로필 목록을 비워 두는 것이 계약이다 — 프론트는
    /// `unknown` 에서 프로필이 비어 있어도 "네트워크 없음"으로 읽지 않는다.
    fn unknown(exe: String, port: u16, detail: String) -> Self {
        Self {
            state: "unknown",
            detail: Some(detail),
            exe,
            port,
            current_profiles: Vec::new(),
        }
    }
}

/// 표시·판정에 쓰는 현재 실행 파일 경로. Windows 경로는 UTF-16 이라 lossy 변환이
/// 실제로 글자를 잃는 경우는 짝 없는 서로게이트뿐이고 파일 경로에는 나올 수 없다.
#[cfg(windows)]
fn current_exe_text() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|err| format!("cannot read this executable's path: {err}"))
}

/// 규칙에 박히는 경로. 표시용과 달리 손실 변환을 허용하지 않는다 — 잘못 변환된
/// 경로로 만든 규칙은 아무것도 허용하지 않으면서 허용된 것처럼 보인다.
///
/// `\\?\` 접두사는 뗀다 — 규칙에 그대로 박히면 Windows 가 실행 중인 exe 와 맞추지
/// 못하는데, 재감지는 [`normalize_exe`] 가 접두사를 떼고 비교하므로 `allowed` 로
/// 읽어 버튼까지 감춘다. 대소문자는 그대로 둔다(표시용이기도 하다).
#[cfg(windows)]
fn current_exe_exact() -> Result<String, String> {
    let path = std::env::current_exe()
        .map_err(|err| format!("cannot read this executable's path: {err}"))?;
    let text = path
        .to_str()
        .ok_or_else(|| "this executable's path is not valid Unicode".to_owned())?;
    Ok(text.strip_prefix(r"\\?\").unwrap_or(text).to_owned())
}

/// COM 으로 한 번에 읽어 온 것들. 규칙·활성 프로필·방화벽 on/off 가 같은 스냅샷에서
/// 나와야 "Private 에서 켜져 있고 규칙도 Private" 같은 판정이 어긋나지 않는다.
#[cfg(windows)]
struct Collected {
    rules: Vec<RuleRecord>,
    current_profiles: i32,
    firewall_off: bool,
}

/// `app_identity::ComScope` 와 모양은 같지만 **아파트가 다르다**: 저쪽은 셸
/// 인터페이스라 STA 를, 여기는 `spawn_blocking` 풀의 아무 스레드에서나 도는
/// 인프로세스 서버라 MTA 를 요청한다. `RPC_E_CHANGED_MODE` 는 그 스레드가 이미 다른
/// 아파트로 초기화됐다는 뜻이고 COM 자체는 그대로 쓸 수 있으므로 진행하되, 우리
/// 카운트가 아니므로 `CoUninitialize` 는 부르지 않는다.
#[cfg(windows)]
struct ComScope {
    owns_apartment: bool,
}

#[cfg(windows)]
impl ComScope {
    fn enter() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

        // S_OK(첫 초기화)와 S_FALSE(중첩 초기화) 둘 다 우리 카운트가 하나 늘어난
        // 것이라 해제 대상이다.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Self {
            owns_apartment: hr.is_ok(),
        }
    }
}

#[cfg(windows)]
impl Drop for ComScope {
    fn drop(&mut self) {
        use windows::Win32::System::Com::CoUninitialize;

        if self.owns_apartment {
            unsafe { CoUninitialize() };
        }
    }
}

/// 열거가 건네주는 `VARIANT` 한 칸.
///
/// windows-rs 의 `VARIANT` 에는 `Drop` 이 **없다** — 정리를 호출자에게 남긴다. 열거는
/// 항목마다 새 VARIANT 를 채우므로 `continue`·`break`·에러 어느 경로로 나가든
/// `VariantClear` 가 정확히 한 번 도는 자리가 필요하고, 그 자리가 이 래퍼다.
#[cfg(windows)]
struct VariantSlot(VARIANT);

#[cfg(windows)]
impl VariantSlot {
    fn empty() -> Self {
        Self(VARIANT::default())
    }

    /// `VT_DISPATCH` 일 때만 참조를 하나 복제해 돌려준다. 원본은 `Drop` 이 정리한다.
    fn dispatch(&self) -> Option<IDispatch> {
        use windows::Win32::System::Variant::VT_DISPATCH;

        unsafe {
            let inner = &self.0.Anonymous.Anonymous;
            if inner.vt != VT_DISPATCH {
                return None;
            }
            (*inner.Anonymous.pdispVal).clone()
        }
    }
}

#[cfg(windows)]
impl Drop for VariantSlot {
    fn drop(&mut self) {
        use windows::Win32::System::Variant::VariantClear;

        let _ = unsafe { VariantClear(&mut self.0) };
    }
}

/// 게터 실패는 그 규칙만 버린다 — 서드파티가 넣은 규칙 하나가 깨졌다고 전체 판정을
/// 포기할 이유가 없다.
///
/// 이름을 먼저 읽는 것은 비용이 아니라 정확도 때문이다: 우리 이름의 규칙은 꺼져
/// 있거나 아웃바운드여도 stalePath 판정과 중복 제거(delete)가 봐야 한다. 그 밖의
/// 규칙은 Enabled·Direction 에서 탈락시켜 나머지 게터를 아예 부르지 않는다 (보통 한
/// PC 에 규칙이 수백 개 있다).
#[cfg(windows)]
fn read_rule(rule: &INetFwRule) -> Option<RuleRecord> {
    use windows::Win32::Foundation::VARIANT_FALSE;
    use windows::Win32::NetworkManagement::WindowsFirewall::{
        NET_FW_ACTION_ALLOW, NET_FW_RULE_DIR_IN,
    };

    let name = unsafe { rule.Name() }.ok()?.to_string();
    let enabled = unsafe { rule.Enabled() }.ok()? != VARIANT_FALSE;
    let direction_in = unsafe { rule.Direction() }.ok()? == NET_FW_RULE_DIR_IN;
    // 우리 이름의 규칙은 두 표면 모두 꺼져 있거나 아웃바운드여도 stalePath 판정과
    // 중복 제거(delete)가 봐야 한다.
    let ours = Protocol::ALL
        .iter()
        .any(|surface| surface.rule_name() == name);
    if !ours && !(enabled && direction_in) {
        return None;
    }

    let action_allow = unsafe { rule.Action() }.ok()? == NET_FW_ACTION_ALLOW;
    // 읽지 못한 값을 "모든 프로그램"·"모든 포트"로 치면 거짓 `allowed` 가 나온다 —
    // 못 읽은 규칙은 통째로 버리는 쪽이 안전한 방향이다.
    let application_name = unsafe { rule.ApplicationName() }.ok()?.to_string();
    let protocol = unsafe { rule.Protocol() }.ok()?;
    let local_ports = unsafe { rule.LocalPorts() }.ok()?.to_string();
    let profiles = unsafe { rule.Profiles() }.ok()?;
    let remote_addresses = unsafe { rule.RemoteAddresses() }.ok()?.to_string();

    Some(RuleRecord {
        name,
        enabled,
        direction_in,
        action_allow,
        protocol,
        local_ports,
        application_name,
        profiles,
        remote_addresses,
    })
}

/// COM 스코프는 이 함수 안에서 열고 닫는다 — 승격 실행([`run_elevated_netsh`])은
/// 스코프 밖에서 돈다.
#[cfg(windows)]
fn read_policy() -> Result<Collected, String> {
    use windows::core::Interface;
    use windows::Win32::Foundation::VARIANT_FALSE;
    use windows::Win32::NetworkManagement::WindowsFirewall::{
        INetFwPolicy2, NetFwPolicy2, NET_FW_PROFILE_TYPE2,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::System::Ole::IEnumVARIANT;

    let _com = ComScope::enter();

    let policy: INetFwPolicy2 =
        unsafe { CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER) }
            .map_err(|err| format!("cannot create the firewall policy object: {err}"))?;

    let current_profiles = unsafe { policy.CurrentProfileTypes() }
        .map_err(|err| format!("cannot read the active network profiles: {err}"))?;

    let mut enabled_per_active_profile = Vec::new();
    for bit in [PROFILE_DOMAIN, PROFILE_PRIVATE, PROFILE_PUBLIC] {
        if current_profiles & bit == 0 {
            continue;
        }
        let on = unsafe { policy.get_FirewallEnabled(NET_FW_PROFILE_TYPE2(bit)) }
            .map_err(|err| format!("cannot read whether the firewall is on: {err}"))?;
        enabled_per_active_profile.push(on != VARIANT_FALSE);
    }

    let collection = unsafe { policy.Rules() }
        .map_err(|err| format!("cannot open the firewall rule collection: {err}"))?;
    let enumerator: IEnumVARIANT = unsafe { collection._NewEnum() }
        .map_err(|err| format!("cannot enumerate the firewall rules: {err}"))?
        .cast()
        .map_err(|err| format!("the firewall rule collection is not enumerable: {err}"))?;

    let mut rules = Vec::new();
    loop {
        let mut slot = VariantSlot::empty();
        let mut fetched = 0u32;
        // 한 칸씩 받는다. S_FALSE(마지막 묶음이 모자람)도 `fetched` 로 판별되므로
        // HRESULT 의 성공/실패만 보면 된다.
        let hr = unsafe { enumerator.Next(std::slice::from_mut(&mut slot.0), &mut fetched) };
        if hr.is_err() || fetched == 0 {
            break;
        }
        let Some(dispatch) = slot.dispatch() else {
            continue;
        };
        let Ok(rule) = dispatch.cast::<INetFwRule>() else {
            continue;
        };
        if let Some(record) = read_rule(&rule) {
            rules.push(record);
        }
    }

    Ok(Collected {
        firewall_off: firewall_off(&enabled_per_active_profile),
        rules,
        current_profiles,
    })
}

/// `%TEMP%` 의 netsh 스크립트. 승격 실행이 어느 경로로 끝나든(거절·타임아웃·오류)
/// 파일은 지워져야 한다.
#[cfg(windows)]
struct TempScript {
    path: std::path::PathBuf,
}

#[cfg(windows)]
impl TempScript {
    fn write(script: &str) -> Result<Self, String> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let path =
            std::env::temp_dir().join(format!("mast-firewall-{}-{nanos}.txt", std::process::id()));
        // 승격 전에 완전히 쓰고 닫는다 — `fs::write` 가 반환할 때 핸들은 이미 닫혀
        // 있으므로, 뒤이어 뜨는 netsh 가 절반만 쓰인 파일을 읽는 창이 없다.
        std::fs::write(&path, encode_script(script)).map_err(|err| {
            format!(
                "cannot write the firewall script to {}: {err}",
                path.display()
            )
        })?;
        Ok(Self { path })
    }
}

#[cfg(windows)]
impl Drop for TempScript {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// `netsh -f` 가 읽을 바이트.
///
/// ASCII 로 끝나는 스크립트(대다수)는 바이트 그대로 쓴다 — cmd 리다이렉션이 만드는
/// ANSI 파일이 이 명령의 표준 입력 형태이고 ASCII 는 어느 해석에서도 같은 글자다.
/// 사용자 이름에 한글 등이 섞여 경로가 비 ASCII 가 되면 ANSI 해석이 코드페이지에
/// 걸려 경로가 깨지므로, **그때만** UTF-16LE + BOM 으로 쓴다 (PowerShell 5.1 의
/// `>` 가 만드는 형식이라 `netsh -f` 가 실제로 받아 온 형태다).
#[cfg(windows)]
fn encode_script(script: &str) -> Vec<u8> {
    if script.is_ascii() {
        return script.as_bytes().to_vec();
    }
    let mut bytes = vec![0xFF, 0xFE];
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

/// 적용 시도의 두 가지 정상 결말. 실패는 `Err(사유)` 로 나간다.
#[cfg(windows)]
enum Applied {
    Ran,
    Declined,
}

/// `C:\Windows\System32` 에 해당하는 경로를 커널에 묻는다. 버퍼가 모자라면(반환값이
/// 버퍼 길이 이상) 경로를 신뢰하지 않는다.
#[cfg(windows)]
fn system_directory() -> Result<std::path::PathBuf, String> {
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = [0u16; 260];
    let len = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if len == 0 || len >= buffer.len() {
        return Err("cannot resolve the Windows system directory".to_owned());
    }
    String::from_utf16(&buffer[..len])
        .map(std::path::PathBuf::from)
        .map_err(|_| "the Windows system directory path is not valid Unicode".to_owned())
}

/// `cmd.exe` 를 거치지 않고, netsh 는 시스템 디렉터리의 절대 경로로 부른다 (PATH
/// 탐색 금지 — ADR-0012 와 같은 규율). 그 디렉터리는 `%SystemRoot%` 환경변수가
/// 아니라 `GetSystemDirectoryW` 에서 얻는다: 환경변수는 같은 사용자 권한의 어떤
/// 프로세스든 고칠 수 있는데, 이 값이 **무엇을 승격시킬지**를 정한다.
#[cfg(windows)]
fn run_elevated_netsh(script: &std::path::Path) -> Result<Applied, String> {
    use windows::core::{HRESULT, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
        SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let netsh = system_directory()?.join("netsh.exe");
    let script = script
        .to_str()
        .ok_or_else(|| "the temporary script path is not valid Unicode".to_owned())?;
    // 스크립트 경로는 우리가 만들지만 `%TEMP%` 는 환경변수라 앞부분이 남의 값이다.
    // 인용부호가 섞이면 인자 경계가 무너지므로 여기서도 닫는다.
    if script.contains('"') {
        return Err("the temporary directory path contains a quote character".to_owned());
    }

    let verb = HSTRING::from("runas");
    let file = HSTRING::from(netsh.as_os_str());
    let parameters = HSTRING::from(format!("-f \"{script}\""));

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        // NOCLOSEPROCESS: 프로세스 핸들을 받아야 종료를 기다릴 수 있다. NOASYNC: 이
        // 스레드가 곧 blocking 대기로 들어가므로 셸이 비동기 실행을 골라서는 안 된다.
        // FLAG_NO_UI: 실패를 셸의 모달 오류창이 아니라 우리 오류 문자열로 받는다.
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    if let Err(err) = unsafe { ShellExecuteExW(&mut info) } {
        // UAC 를 거절하면 셸이 ERROR_CANCELLED(1223) 로 실패한다 — 사용자의 선택이지
        // 고장이 아니므로 오류와 구분해 보고한다.
        if err.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
            return Ok(Applied::Declined);
        }
        return Err(format!("cannot start the elevated netsh: {err}"));
    }

    if info.hProcess.is_invalid() {
        // NOCLOSEPROCESS 를 줬는데도 핸들이 없으면 기다릴 대상이 없다. 규칙이 실제로
        // 생겼는지는 어차피 재감지가 답하므로 실패로 몰지 않는다.
        winlog!("remote: firewall apply started without a process handle");
        return Ok(Applied::Ran);
    }

    let wait = unsafe { WaitForSingleObject(info.hProcess, NETSH_TIMEOUT_MS) };
    let outcome = if wait == WAIT_OBJECT_0 {
        let mut code = 0u32;
        match unsafe { GetExitCodeProcess(info.hProcess, &mut code) } {
            Ok(()) => winlog!("remote: firewall apply exit={code}"),
            Err(err) => winlog!("remote: firewall apply exit=unreadable ({err})"),
        }
        Ok(Applied::Ran)
    } else if wait == WAIT_TIMEOUT {
        // 여기 오면 UAC 는 이미 지났고(그 대기는 ShellExecuteExW 안이다) 몇 ms 짜리
        // netsh 가 걸린 것이다. 죽이지 않는다 — 비승격 프로세스는 승격된 것을 죽일
        // 수 없다. 반환하면서 스크립트 파일이 지워지므로 뒤늦게 읽으려 해도 실패하고,
        // 규칙이 생겼는지는 어차피 재감지가 답한다.
        Err(format!(
            "netsh did not finish within {} s",
            NETSH_TIMEOUT_MS / 1000
        ))
    } else {
        Err(format!("waiting for netsh failed (wait result {})", wait.0))
    };
    let _ = unsafe { CloseHandle(info.hProcess) };
    outcome
}

/// 성공/거절은 `Ok`, 그 밖은 `Err(사유)`. `protocol` 이 규칙 이름·스크립트·삭제
/// 대상을 가른다 — TCP 로 부르면 Local HTTP 의 기존 동작 그대로다.
#[cfg(windows)]
fn apply(protocol: Protocol, port: u16) -> Result<Applied, String> {
    let exe = current_exe_exact()?;

    // 수집 실패를 감내한다: COM 이 답하지 않아도 버튼은 동작해야 한다. 규칙 자체가
    // `profile=domain,private` 고정이라 가드 없이도 Public 에 포트를 열지 않는다 —
    // 보안 불변식은 가드가 아니라 규칙의 구성이 지킨다.
    let collected = read_policy().ok();
    if let Some(collected) = &collected {
        if collected.current_profiles == 0 {
            return Err("no active network profile".to_owned());
        }
        if collected.current_profiles & (PROFILE_DOMAIN | PROFILE_PRIVATE) == 0 {
            return Err(
                "no trusted network profile is active (connect to a private network first)"
                    .to_owned(),
            );
        }
    }
    let rule_name = protocol.rule_name();
    let delete_first = collected
        .as_ref()
        .is_some_and(|collected| collected.rules.iter().any(|rule| rule.name == rule_name));

    let script = script_text_for(protocol, &exe, port, delete_first)?;
    let scratch = TempScript::write(&script)?;
    // 본문 자체는 남기지 않는다 — 재현에 필요한 것은 어느 경로·포트로 무엇을 했나다.
    // TCP 문구는 현장 진단 문서가 그대로 인용하는 문장이라 유지하고, UDP 는 전송을 밝힌다.
    if protocol == Protocol::Tcp {
        winlog!("remote: firewall apply {exe}:{port} (replacing an existing rule: {delete_first})");
    } else {
        winlog!(
            "remote: firewall apply udp {exe}:{port} (replacing an existing rule: {delete_first})"
        );
    }
    run_elevated_netsh(&scratch.path)
}

/// 지금 이 exe·이 포트가 허용돼 있는지 판정한다. 실패는 `unknown` 으로 나가고 오류로
/// 올라가지 않는다 — 대화상자는 "확인하지 못했다"를 보여 줄 수 있어야 한다.
///
/// TCP 는 Local HTTP, UDP 는 Secure Remote 다. 같은 포트 번호라도 전송이 달라
/// 서로의 규칙·판정 결과에 영향을 주지 않는다.
#[cfg(windows)]
pub fn status(port: u16) -> FirewallStatus {
    status_for(Protocol::Tcp, port)
}

#[cfg(windows)]
pub fn secure_status(port: u16) -> FirewallStatus {
    status_for(Protocol::Udp, port)
}

#[cfg(windows)]
fn status_for(protocol: Protocol, port: u16) -> FirewallStatus {
    let exe = match current_exe_text() {
        Ok(exe) => exe,
        Err(err) => return FirewallStatus::unknown(String::new(), port, err),
    };
    let collected = match read_policy() {
        Ok(collected) => collected,
        Err(err) => return FirewallStatus::unknown(exe, port, err),
    };
    let target = Target {
        exe: normalize_exe(&exe),
        port,
        profiles: collected.current_profiles,
        protocol,
    };
    let verdict = judge(&target, &collected.rules, collected.firewall_off);
    FirewallStatus::new(
        verdict,
        exe,
        port,
        profile_names(collected.current_profiles),
    )
}

/// 사용자 클릭에만 반응하는 적용 경로. UAC 창이 한 번 뜬다.
#[cfg(windows)]
pub fn allow(port: u16) -> AllowOutcome {
    allow_for(Protocol::Tcp, port)
}

#[cfg(windows)]
pub fn secure_allow(port: u16) -> AllowOutcome {
    allow_for(Protocol::Udp, port)
}

#[cfg(windows)]
fn allow_for(protocol: Protocol, port: u16) -> AllowOutcome {
    let (outcome, detail) = match apply(protocol, port) {
        Ok(Applied::Ran) => ("applied", None),
        Ok(Applied::Declined) => ("declined", None),
        Err(reason) => ("failed", Some(reason)),
    };
    // 성공 근거는 exit code 가 아니라 이 재감지다 (모듈 doc).
    AllowOutcome {
        outcome,
        detail,
        status: status_for(protocol, port),
    }
}

#[cfg(not(windows))]
pub fn status(port: u16) -> FirewallStatus {
    FirewallStatus::unknown(
        String::new(),
        port,
        "unsupported on this platform".to_owned(),
    )
}

#[cfg(not(windows))]
pub fn secure_status(port: u16) -> FirewallStatus {
    status(port)
}

#[cfg(not(windows))]
pub fn allow(port: u16) -> AllowOutcome {
    AllowOutcome {
        outcome: "failed",
        detail: Some("unsupported on this platform".to_owned()),
        status: status(port),
    }
}

#[cfg(not(windows))]
pub fn secure_allow(port: u16) -> AllowOutcome {
    allow(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mast_core::firewall::{profile_names, PROFILE_PRIVATE, PROFILE_PUBLIC};
    const EXE: &str = r"C:\Users\me\Downloads\mast-x64.exe";
    const PORT: u16 = 7331;

    #[test]
    fn status_carries_the_profile_names_into_a_profile_mismatch_detail() {
        let status = FirewallStatus::new(
            Verdict::ProfileMismatch,
            EXE.to_owned(),
            PORT,
            profile_names(PROFILE_PRIVATE | PROFILE_PUBLIC),
        );
        assert_eq!(status.state, "profileMismatch");
        assert_eq!(status.detail.as_deref(), Some("Private, Public"));
    }
}
