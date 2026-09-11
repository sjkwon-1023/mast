//! Windows Defender 방화벽이 **이 exe** 의 **이 포트** 인바운드를 받는지 판정하고,
//! 사용자가 눌렀을 때 허용 규칙 하나를 만든다 (ADR-0016 amendment).
//!
//! 읽기와 쓰기의 수단이 다른 이유: 규칙 열거는 COM(`INetFwPolicy2`)으로 **일반
//! 권한**에서 되지만 규칙 생성은 관리자 권한이 필수다. 그래서 감지는 인프로세스 COM
//! 으로 조용히 돌리고(netsh·PowerShell 출력 파싱은 느린 데다 문구가 로캘에 따라
//! 바뀐다), 쓰기만 Microsoft 서명된 `netsh.exe` 를 UAC 한 번으로 승격해 넘긴다 —
//! 서명 없는 우리 exe 를 자기 승격시키면 "게시자: 알 수 없음" 경고가 뜨고 main 에
//! CLI 모드까지 필요하다.
//!
//! **적용 성공의 근거는 netsh 의 exit code 가 아니라 재감지다.** `netsh -f` 의 종료
//! 코드가 스크립트의 어느 줄을 반영하는지는 문서화돼 있지 않고, 우리가 알고 싶은
//! 것은 "지금 규칙이 있느냐" 하나뿐이다. exit code 는 로그로만 남겨 현장 진단에
//! 쓴다.
//!
//! 이 파일의 단위 테스트는 **Windows 타깃에서만** 컴파일·실행된다: `src-tauri` 는
//! webkit2gtk 부재로 Linux 호스트에서 컴파일되지 않아, 개발기의 게이트는
//! `--target x86_64-pc-windows-msvc` clippy 로 **컴파일만** 확인하고 실제 실행은 CI
//! 의 windows-artifacts job 이 한다. 같은 이유로 아래 `#[cfg(not(windows))]` 갈래는
//! **어떤 게이트도 컴파일하지 않는다** — Unix 에서 앱을 띄워 보는 경로에서 링크가
//! 깨지지 않게 자리만 지킨다.

#[cfg(windows)]
use crate::winlog;
#[cfg(windows)]
use windows::Win32::NetworkManagement::WindowsFirewall::INetFwRule;
#[cfg(windows)]
use windows::Win32::System::{Com::IDispatch, Variant::VARIANT};

/// 우리가 만드는 규칙의 이름. 감지(stalePath·중복 제거)와 스크립트가 같은 문자열을
/// 봐야 하므로 상수 하나로 둔다.
const RULE_NAME: &str = "mast remote (LAN)";

/// `NET_FW_IP_PROTOCOL_TCP` / `_ANY` 의 수치. 판정은 COM 없이 도는 순수 함수라
/// windows 타입이 아니라 값으로 받는다.
const PROTOCOL_TCP: i32 = 6;
const PROTOCOL_ANY: i32 = 256;

/// `NET_FW_PROFILE2_*` 의 비트값. 위와 같은 이유로 값으로 둔다.
const PROFILE_DOMAIN: i32 = 1;
const PROFILE_PRIVATE: i32 = 2;
const PROFILE_PUBLIC: i32 = 4;

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

/// 판정 결과. `FirewallStatus::state` 문자열과 1:1 이고, 값을 들고 있는 갈래의 값이
/// 그대로 `detail` 이 된다.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    FirewallOff,
    Blocked { rule: String },
    Allowed,
    StalePath { program: String },
    ProfileMismatch,
    Missing,
}

/// "지금 이 연결" — 판정이 규칙을 대조하는 기준.
struct Target {
    /// [`normalize_exe`] 를 통과한 현재 실행 파일 경로.
    exe: String,
    port: u16,
    /// `CurrentProfileTypes` 비트마스크.
    profiles: i32,
}

/// COM 규칙 하나를 판정에 필요한 만큼만 옮겨 담은 값. 판정이 COM 없이 테스트되도록
/// 이 구조체가 두 세계의 경계다.
#[derive(Debug)]
struct RuleRecord {
    name: String,
    enabled: bool,
    direction_in: bool,
    action_allow: bool,
    protocol: i32,
    local_ports: String,
    application_name: String,
    profiles: i32,
    /// Allow·Block 양쪽이 본다. 원격 주소가 좁게 스코프된 Allow(예: 특정 IP 하나)는
    /// 폰을 들이지 못하는데, 그것을 `allowed` 로 읽으면 대화상자가 버튼까지 감추고
    /// "허용됨"이라 안심시키는 최악의 오판이 된다.
    remote_addresses: String,
}

impl FirewallStatus {
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

/// `\\?\` 접두사와 앞뒤 공백을 떼고 소문자로 맞춘다. Windows 경로 비교는 대소문자를
/// 가리지 않고, 규칙의 `ApplicationName` 에는 그것을 만든 도구에 따라 확장 길이
/// 접두사가 붙기도 안 붙기도 한다.
fn normalize_exe(path: &str) -> String {
    let trimmed = path.trim();
    trimmed
        .strip_prefix(r"\\?\")
        .unwrap_or(trimmed)
        .to_ascii_lowercase()
}

/// 규칙의 `LocalPorts` 가 우리 포트를 덮는가.
///
/// `Protocol=Any` 면 포트는 그 규칙의 조건이 아니다 — Windows 의 "이 앱의 통신을
/// 허용하시겠습니까" 프롬프트가 만드는 규칙이 정확히 그 모양(프로그램만 지정,
/// 프로토콜 Any, 포트 없음)이라, 이 면제가 없으면 **가장 흔한 정상 허용**이
/// `missing` 으로 오판돼 중복 규칙을 만들게 된다. 빈 문자열과 `*` 도 "모든 포트"다.
///
/// `RPC`·`IPHTTPS` 같은 키워드 포트는 숫자로 답할 수 없으므로 덮는다고 주장하지
/// 않는다 — 거짓 `allowed` 보다 불필요한 규칙 하나가 낫다.
fn ports_cover(protocol: i32, local_ports: &str, port: u16) -> bool {
    if protocol == PROTOCOL_ANY {
        return true;
    }
    let ports = local_ports.trim();
    if ports.is_empty() || ports == "*" {
        return true;
    }
    let wanted = u32::from(port);
    ports.split(',').any(|item| match item.trim().split_once('-') {
        Some((low, high)) => {
            match (low.trim().parse::<u32>(), high.trim().parse::<u32>()) {
                (Ok(low), Ok(high)) => low <= high && (low..=high).contains(&wanted),
                _ => false,
            }
        }
        None => matches!(item.trim().parse::<u32>(), Ok(value) if value == wanted),
    })
}

/// 비트마스크를 사람이 읽는 프로필 이름으로. 대화상자가 "지금 이 네트워크"를
/// 그대로 보여 주는 데 쓴다.
fn profile_names(mask: i32) -> Vec<String> {
    [
        (PROFILE_DOMAIN, "Domain"),
        (PROFILE_PRIVATE, "Private"),
        (PROFILE_PUBLIC, "Public"),
    ]
    .into_iter()
    .filter(|(bit, _)| mask & bit != 0)
    .map(|(_, name)| name.to_owned())
    .collect()
}

/// 활성 프로필 **전부**에서 방화벽이 꺼져 있는가.
///
/// 활성 프로필이 하나도 없으면(네트워크 미연결) 꺼진 것으로 보지 않는다 — 그때는
/// 포트를 이야기할 무대 자체가 없고, "방화벽이 꺼져 있다"는 안내는 거짓이 된다.
fn firewall_off(enabled_per_active_profile: &[bool]) -> bool {
    !enabled_per_active_profile.is_empty() && enabled_per_active_profile.iter().all(|on| !on)
}

/// 규칙의 `RemoteAddresses` 가 폰이 오는 방향(같은 LAN)을 실제로 덮는가.
///
/// 인터넷 대역으로 스코프된 Block 은 흔하고 그것까지 `blocked` 로 세면 정상 PC 가
/// 막혔다고 보고되며, 반대로 특정 IP 로 스코프된 Allow 를 `allowed` 로 세면 폰이
/// 못 붙는데 버튼이 사라진다. 빈 값과 `*` 는 "모든 주소"다 (포트와 같은 규약).
fn remote_covers_lan(remote_addresses: &str) -> bool {
    let value = remote_addresses.trim();
    value.is_empty() || value == "*" || value.to_ascii_lowercase().contains("localsubnet")
}

/// 규칙 목록에서 상태 하나를 고른다. COM 을 타지 않으므로 이 함수가 단위 테스트의
/// 본체다.
fn judge(target: &Target, rules: &[RuleRecord], all_profiles_off: bool) -> Verdict {
    if all_profiles_off {
        return Verdict::FirewallOff;
    }

    let reaches_us = |rule: &RuleRecord| {
        rule.enabled
            && rule.direction_in
            && (rule.protocol == PROTOCOL_TCP || rule.protocol == PROTOCOL_ANY)
            && ports_cover(rule.protocol, &rule.local_ports, target.port)
    };
    let our_program = |rule: &RuleRecord| normalize_exe(&rule.application_name) == target.exe;
    let any_program = |rule: &RuleRecord| rule.application_name.trim().is_empty();
    let in_profile = |rule: &RuleRecord| rule.profiles & target.profiles != 0;

    // Windows 는 인바운드에서 Block 을 Allow 보다 먼저 적용한다. 허용 규칙이 있어도
    // 우리 exe 를 겨눈 Block 이 하나 있으면 폰은 계속 붙지 못하므로, 여기서 Allow 를
    // 이겨야 버튼이 "규칙을 더 만들었는데 여전히 안 된다"는 거짓말을 하지 않는다.
    // 매칭을 우리 exe 로 좁히는 이유는 "모든 프로그램 Block" 이 기본 정책에 가까운
    // 형태라 그것까지 세면 정상 PC 가 차단으로 보고되기 때문이다.
    if let Some(rule) = rules.iter().find(|rule| {
        reaches_us(rule)
            && in_profile(rule)
            && !rule.action_allow
            && our_program(rule)
            && remote_covers_lan(&rule.remote_addresses)
    }) {
        return Verdict::Blocked {
            rule: rule.name.clone(),
        };
    }

    let allows_us = |rule: &RuleRecord| {
        reaches_us(rule)
            && rule.action_allow
            && (any_program(rule) || our_program(rule))
            && remote_covers_lan(&rule.remote_addresses)
    };

    if rules.iter().any(|rule| allows_us(rule) && in_profile(rule)) {
        return Verdict::Allowed;
    }

    // 우리 이름의 규칙이 다른 경로를 가리킨다 = exe 를 옮겼다. 경로가 비어 있으면
    // "모든 프로그램" 규칙이라 보여 줄 옛 경로가 없으므로 이 갈래에 넣지 않는다.
    if let Some(rule) = rules.iter().find(|rule| {
        rule.name == RULE_NAME && !rule.application_name.trim().is_empty() && !our_program(rule)
    }) {
        return Verdict::StalePath {
            program: rule.application_name.clone(),
        };
    }

    // 프로필 조건만 빼고 허용 후보를 만족한다 = 규칙은 있는데 지금 네트워크가 그
    // 프로필이 아니다 (규칙은 Private, 지금은 Public 따위).
    if rules.iter().any(allows_us) {
        return Verdict::ProfileMismatch;
    }

    Verdict::Missing
}

/// 승격된 netsh 에 넘길 스크립트.
///
/// **입력은 `current_exe()` 원문과 `u16` 포트뿐이다** — 사용자·프론트가 고를 수 있는
/// 값이 한 글자도 들어가지 않아야 승격 실행이 인자 주입 표면이 되지 않는다. 경로에
/// `"` 가 있으면(Windows 파일명에는 나올 수 없다) 만들지 않고 거부한다.
///
/// delete 줄은 같은 이름의 규칙이 이미 있을 때만 넣는다 — 없는 규칙의 delete 는
/// netsh 가 오류로 끝낸다. 반대로 있을 때 지우지 않으면 포트를 바꾼 사용자가 같은
/// 이름의 규칙을 둘 갖게 된다.
///
/// 모양은 `netsh advfirewall firewall dump` 가 내놓는 스크립트와 같다 — `pushd` 로
/// 컨텍스트에 들어가 짧은 명령을 쓰고 `popd` 로 나온다. `-f` 가 소비하도록 만들어진
/// 형식이 그것이라, 완전 수식 명령이 컨텍스트를 바꾸는지 같은 문서에 없는 질문을
/// 피한다.
fn script_text(exe: &str, port: u16, delete_first: bool) -> Result<String, String> {
    if exe.contains('"') {
        return Err("the executable path contains a quote character".to_owned());
    }
    let delete = if delete_first {
        format!("delete rule name=\"{RULE_NAME}\"\r\n")
    } else {
        String::new()
    };
    Ok(format!(
        "pushd advfirewall firewall\r\n\
         {delete}add rule name=\"{RULE_NAME}\" dir=in action=allow protocol=TCP \
         localport={port} program=\"{exe}\" profile=domain,private enable=yes\r\n\
         popd\r\n"
    ))
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
    let path =
        std::env::current_exe().map_err(|err| format!("cannot read this executable's path: {err}"))?;
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

/// 이 스코프 동안 COM 아파트를 보장한다.
///
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

/// 규칙 하나를 COM 게터로 읽는다. 게터 실패는 그 규칙만 버린다 — 서드파티가 넣은
/// 규칙 하나가 깨졌다고 전체 판정을 포기할 이유가 없다.
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
    if name != RULE_NAME && !(enabled && direction_in) {
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

/// 방화벽 정책 전체를 한 번 읽는다. COM 스코프는 이 함수 안에서 열고 닫는다 —
/// 승격 실행([`run_elevated_netsh`])은 스코프 밖에서 돈다.
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
        let path = std::env::temp_dir().join(format!(
            "mast-firewall-{}-{nanos}.txt",
            std::process::id()
        ));
        // 승격 전에 완전히 쓰고 닫는다 — `fs::write` 가 반환할 때 핸들은 이미 닫혀
        // 있으므로, 뒤이어 뜨는 netsh 가 절반만 쓰인 파일을 읽는 창이 없다.
        std::fs::write(&path, encode_script(script))
            .map_err(|err| format!("cannot write the firewall script to {}: {err}", path.display()))?;
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

/// 승격된 netsh 를 띄우고 끝날 때까지 기다린다.
///
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

/// 규칙을 실제로 쓴다. 성공/거절은 `Ok`, 그 밖은 `Err(사유)`.
#[cfg(windows)]
fn apply(port: u16) -> Result<Applied, String> {
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
    let delete_first = collected
        .as_ref()
        .is_some_and(|collected| collected.rules.iter().any(|rule| rule.name == RULE_NAME));

    let script = script_text(&exe, port, delete_first)?;
    let scratch = TempScript::write(&script)?;
    // 본문 자체는 남기지 않는다 — 재현에 필요한 것은 어느 경로·포트로 무엇을 했나다.
    winlog!("remote: firewall apply {exe}:{port} (replacing an existing rule: {delete_first})");
    run_elevated_netsh(&scratch.path)
}

/// 지금 이 exe·이 포트가 허용돼 있는지 판정한다. 실패는 `unknown` 으로 나가고 오류로
/// 올라가지 않는다 — 대화상자는 "확인하지 못했다"를 보여 줄 수 있어야 한다.
#[cfg(windows)]
pub fn status(port: u16) -> FirewallStatus {
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
    let (outcome, detail) = match apply(port) {
        Ok(Applied::Ran) => ("applied", None),
        Ok(Applied::Declined) => ("declined", None),
        Err(reason) => ("failed", Some(reason)),
    };
    // 성공 근거는 exit code 가 아니라 이 재감지다 (모듈 doc).
    AllowOutcome {
        outcome,
        detail,
        status: status(port),
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
pub fn allow(port: u16) -> AllowOutcome {
    AllowOutcome {
        outcome: "failed",
        detail: Some("unsupported on this platform".to_owned()),
        status: status(port),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 주의: 이 테스트들은 Windows 타깃에서만 컴파일·실행된다 (모듈 doc 참조).
    // 리눅스 개발기의 게이트는 clippy 로 **컴파일만** 검증한다.

    const EXE: &str = r"C:\Users\me\Downloads\mast-x64.exe";
    const PORT: u16 = 7331;

    fn target() -> Target {
        Target {
            exe: normalize_exe(EXE),
            port: PORT,
            profiles: PROFILE_PRIVATE,
        }
    }

    /// 그대로면 `allowed` 가 되는 규칙. 테스트마다 한 필드씩 비튼다.
    fn allowing_rule() -> RuleRecord {
        RuleRecord {
            name: "some vendor rule".to_owned(),
            enabled: true,
            direction_in: true,
            action_allow: true,
            protocol: PROTOCOL_TCP,
            local_ports: PORT.to_string(),
            application_name: EXE.to_owned(),
            profiles: PROFILE_PRIVATE,
            remote_addresses: "*".to_owned(),
        }
    }

    fn blocking_rule() -> RuleRecord {
        RuleRecord {
            name: "vendor block".to_owned(),
            action_allow: false,
            ..allowing_rule()
        }
    }

    #[test]
    fn ports_cover_accepts_the_wildcard_and_the_empty_list() {
        assert!(ports_cover(PROTOCOL_TCP, "*", PORT));
        assert!(ports_cover(PROTOCOL_TCP, "", PORT));
        assert!(ports_cover(PROTOCOL_TCP, "   ", PORT));
    }

    #[test]
    fn ports_cover_ignores_the_port_list_when_the_protocol_is_any() {
        assert!(ports_cover(PROTOCOL_ANY, "80", PORT));
        assert!(ports_cover(PROTOCOL_ANY, "", PORT));
    }

    #[test]
    fn ports_cover_matches_single_values_and_comma_lists() {
        assert!(ports_cover(PROTOCOL_TCP, "7331", PORT));
        assert!(!ports_cover(PROTOCOL_TCP, "7332", PORT));
        assert!(ports_cover(PROTOCOL_TCP, "80, 443, 7331", PORT));
        assert!(!ports_cover(PROTOCOL_TCP, "80,443", PORT));
    }

    #[test]
    fn ports_cover_matches_ranges_including_their_bounds() {
        assert!(ports_cover(PROTOCOL_TCP, "7000-8000", PORT));
        assert!(ports_cover(PROTOCOL_TCP, "7331-7331", PORT));
        assert!(ports_cover(PROTOCOL_TCP, "7331-9000", PORT));
        assert!(ports_cover(PROTOCOL_TCP, "1-7331", PORT));
        assert!(!ports_cover(PROTOCOL_TCP, "7332-9000", PORT));
        assert!(!ports_cover(PROTOCOL_TCP, "1-7330", PORT));
    }

    #[test]
    fn ports_cover_rejects_a_reversed_range() {
        assert!(!ports_cover(PROTOCOL_TCP, "8000-7000", PORT));
    }

    #[test]
    fn ports_cover_rejects_keyword_ports() {
        assert!(!ports_cover(PROTOCOL_TCP, "RPC", PORT));
        assert!(!ports_cover(PROTOCOL_TCP, "RPC-EPMap", PORT));
        assert!(!ports_cover(PROTOCOL_TCP, "IPHTTPS,Teredo", PORT));
    }

    #[test]
    fn normalize_exe_drops_the_extended_prefix_and_the_case() {
        assert_eq!(
            normalize_exe(r"\\?\C:\Users\Me\MAST.exe"),
            r"c:\users\me\mast.exe"
        );
        assert_eq!(
            normalize_exe(r"  C:\Users\me\mast.exe  "),
            r"c:\users\me\mast.exe"
        );
        assert_eq!(normalize_exe(""), "");
    }

    #[test]
    fn profile_names_lists_only_the_set_bits() {
        assert_eq!(profile_names(0), Vec::<String>::new());
        assert_eq!(profile_names(PROFILE_PRIVATE), vec!["Private"]);
        assert_eq!(
            profile_names(PROFILE_DOMAIN | PROFILE_PUBLIC),
            vec!["Domain", "Public"]
        );
    }

    #[test]
    fn firewall_off_needs_every_active_profile_to_be_off() {
        assert!(firewall_off(&[false]));
        assert!(firewall_off(&[false, false]));
        assert!(!firewall_off(&[false, true]));
        assert!(!firewall_off(&[true]));
        // 활성 프로필이 없으면 꺼진 것으로 보지 않는다.
        assert!(!firewall_off(&[]));
    }

    #[test]
    fn judge_reports_missing_when_no_rule_matches() {
        assert_eq!(judge(&target(), &[], false), Verdict::Missing);
        let unrelated = RuleRecord {
            application_name: r"C:\Windows\System32\other.exe".to_owned(),
            ..allowing_rule()
        };
        assert_eq!(judge(&target(), &[unrelated], false), Verdict::Missing);
    }

    #[test]
    fn judge_accepts_an_exact_program_match() {
        assert_eq!(judge(&target(), &[allowing_rule()], false), Verdict::Allowed);
    }

    #[test]
    fn judge_accepts_a_rule_that_names_no_program() {
        let rule = RuleRecord {
            application_name: String::new(),
            ..allowing_rule()
        };
        assert_eq!(judge(&target(), &[rule], false), Verdict::Allowed);
    }

    #[test]
    fn judge_accepts_the_windows_prompt_shape() {
        // "이 앱의 통신을 허용" 프롬프트가 만드는 규칙: 프로그램만, 프로토콜 Any,
        // 포트 없음.
        let rule = RuleRecord {
            protocol: PROTOCOL_ANY,
            local_ports: String::new(),
            ..allowing_rule()
        };
        assert_eq!(judge(&target(), &[rule], false), Verdict::Allowed);
    }

    #[test]
    fn judge_ignores_an_allow_scoped_away_from_the_lan() {
        // 특정 IP 하나에만 열린 Allow 는 폰을 들이지 못한다 — allowed 로 읽으면 버튼이
        // 사라진 채 "허용됨"이 뜬다.
        let narrow = RuleRecord {
            remote_addresses: "10.0.0.5".to_owned(),
            ..allowing_rule()
        };
        assert_eq!(judge(&target(), &[narrow], false), Verdict::Missing);
        let empty_scope = RuleRecord {
            remote_addresses: String::new(),
            ..allowing_rule()
        };
        assert_eq!(judge(&target(), &[empty_scope], false), Verdict::Allowed);
    }

    #[test]
    fn judge_ignores_disabled_and_outbound_rules() {
        let disabled = RuleRecord {
            enabled: false,
            ..allowing_rule()
        };
        assert_eq!(judge(&target(), &[disabled], false), Verdict::Missing);
        let outbound = RuleRecord {
            direction_in: false,
            ..allowing_rule()
        };
        assert_eq!(judge(&target(), &[outbound], false), Verdict::Missing);
    }

    #[test]
    fn judge_reports_a_stale_path_for_our_own_rule() {
        let moved = RuleRecord {
            name: RULE_NAME.to_owned(),
            application_name: r"C:\Old\mast-x64.exe".to_owned(),
            ..allowing_rule()
        };
        assert_eq!(
            judge(&target(), &[moved], false),
            Verdict::StalePath {
                program: r"C:\Old\mast-x64.exe".to_owned()
            }
        );
    }

    #[test]
    fn judge_reports_a_profile_mismatch_when_only_the_profile_differs() {
        let other_profile = RuleRecord {
            profiles: PROFILE_PUBLIC,
            ..allowing_rule()
        };
        assert_eq!(
            judge(&target(), &[other_profile], false),
            Verdict::ProfileMismatch
        );
    }

    #[test]
    fn judge_lets_a_program_bound_block_beat_an_allow() {
        let rules = vec![allowing_rule(), blocking_rule()];
        assert_eq!(
            judge(&target(), &rules, false),
            Verdict::Blocked {
                rule: "vendor block".to_owned()
            }
        );
    }

    #[test]
    fn judge_ignores_a_block_that_names_no_program() {
        let any_program_block = RuleRecord {
            application_name: String::new(),
            ..blocking_rule()
        };
        let rules = vec![allowing_rule(), any_program_block];
        assert_eq!(judge(&target(), &rules, false), Verdict::Allowed);
    }

    #[test]
    fn judge_ignores_a_block_scoped_away_from_the_lan() {
        let internet_only = RuleRecord {
            remote_addresses: "Internet".to_owned(),
            ..blocking_rule()
        };
        let rules = vec![allowing_rule(), internet_only];
        assert_eq!(judge(&target(), &rules, false), Verdict::Allowed);
    }

    #[test]
    fn judge_accepts_a_block_scoped_to_the_local_subnet() {
        let local = RuleRecord {
            remote_addresses: "LocalSubnet,10.0.0.0/8".to_owned(),
            ..blocking_rule()
        };
        assert_eq!(
            judge(&target(), &[local], false),
            Verdict::Blocked {
                rule: "vendor block".to_owned()
            }
        );
    }

    #[test]
    fn judge_ignores_a_block_in_another_profile() {
        let other_profile_block = RuleRecord {
            profiles: PROFILE_PUBLIC,
            ..blocking_rule()
        };
        let rules = vec![allowing_rule(), other_profile_block];
        assert_eq!(judge(&target(), &rules, false), Verdict::Allowed);
    }

    #[test]
    fn judge_puts_firewall_off_above_everything_else() {
        let rules = vec![allowing_rule(), blocking_rule()];
        assert_eq!(judge(&target(), &rules, true), Verdict::FirewallOff);
    }

    #[test]
    fn judge_prefers_allowed_over_stale_path_and_profile_mismatch() {
        let moved = RuleRecord {
            name: RULE_NAME.to_owned(),
            application_name: r"C:\Old\mast-x64.exe".to_owned(),
            ..allowing_rule()
        };
        let other_profile = RuleRecord {
            profiles: PROFILE_PUBLIC,
            ..allowing_rule()
        };
        let rules = vec![moved, other_profile, allowing_rule()];
        assert_eq!(judge(&target(), &rules, false), Verdict::Allowed);
    }

    #[test]
    fn judge_prefers_stale_path_over_profile_mismatch() {
        let moved = RuleRecord {
            name: RULE_NAME.to_owned(),
            application_name: r"C:\Old\mast-x64.exe".to_owned(),
            ..allowing_rule()
        };
        let other_profile = RuleRecord {
            profiles: PROFILE_PUBLIC,
            ..allowing_rule()
        };
        assert_eq!(
            judge(&target(), &[moved, other_profile], false),
            Verdict::StalePath {
                program: r"C:\Old\mast-x64.exe".to_owned()
            }
        );
    }

    #[test]
    fn script_text_writes_only_the_add_line_by_default() {
        assert_eq!(
            script_text(EXE, PORT, false).unwrap(),
            "pushd advfirewall firewall\r\n\
             add rule name=\"mast remote (LAN)\" dir=in action=allow protocol=TCP \
             localport=7331 program=\"C:\\Users\\me\\Downloads\\mast-x64.exe\" \
             profile=domain,private enable=yes\r\n\
             popd\r\n"
        );
    }

    #[test]
    fn script_text_deletes_the_old_rule_first_when_asked() {
        assert_eq!(
            script_text(EXE, PORT, true).unwrap(),
            "pushd advfirewall firewall\r\n\
             delete rule name=\"mast remote (LAN)\"\r\n\
             add rule name=\"mast remote (LAN)\" dir=in action=allow protocol=TCP \
             localport=7331 program=\"C:\\Users\\me\\Downloads\\mast-x64.exe\" \
             profile=domain,private enable=yes\r\n\
             popd\r\n"
        );
    }

    #[test]
    fn script_text_refuses_a_quoted_path() {
        assert!(script_text(r#"C:\a"b\mast.exe"#, PORT, false).is_err());
    }

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
