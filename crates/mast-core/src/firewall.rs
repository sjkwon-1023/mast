//! Windows 방화벽 규칙 판정과 netsh 스크립트 생성. Win32 I/O는 앱 글루가 맡는다.

/// Local HTTP(TCP)의 규칙 이름. 감지(stalePath·중복 제거)와 스크립트가 같은 문자열을
/// 봐야 하므로 상수 하나로 둔다.
pub const RULE_NAME: &str = "mast remote (LAN)";

/// Secure Remote(UDP 7331)의 규칙 이름. Local HTTP 와 **별개 규칙**이라 둘이 같은
/// 포트 번호를 써도 서로의 판정·삭제에 섞이지 않는다.
pub const SECURE_RULE_NAME: &str = "mast secure remote (LAN)";

/// `NET_FW_IP_PROTOCOL_TCP` / `_UDP` / `_ANY` 의 수치. 판정은 COM 없이 도는 순수
/// 함수라 windows 타입이 아니라 값으로 받는다.
const PROTOCOL_TCP: i32 = 6;
const PROTOCOL_UDP: i32 = 17;
const PROTOCOL_ANY: i32 = 256;

/// 판정 대상의 전송 프로토콜. 규칙 이름·COM 프로토콜 번호·스크립트 토큰이 이 값
/// 하나로 함께 갈린다 — TCP 와 UDP 는 같은 7331 을 써도 별개 표면이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Tcp,
    Udp,
}

impl Protocol {
    /// 우리가 소유한 규칙 이름 전부 — 글루의 규칙 수집이 "우리 이름"을 가릴 때 쓴다.
    pub const ALL: [Protocol; 2] = [Protocol::Tcp, Protocol::Udp];

    /// 이 표면 몫의 규칙 이름.
    pub fn rule_name(self) -> &'static str {
        match self {
            Protocol::Tcp => RULE_NAME,
            Protocol::Udp => SECURE_RULE_NAME,
        }
    }

    fn number(self) -> i32 {
        match self {
            Protocol::Tcp => PROTOCOL_TCP,
            Protocol::Udp => PROTOCOL_UDP,
        }
    }

    /// 프로토콜 Any(`NET_FW_IP_PROTOCOL_ANY`) 규칙은 두 표면 모두에 해당한다 —
    /// Windows 의 "이 앱의 통신을 허용" 프롬프트가 만드는 모양이다.
    fn covers(self, rule_protocol: i32) -> bool {
        rule_protocol == self.number() || rule_protocol == PROTOCOL_ANY
    }

    fn script_token(self) -> &'static str {
        match self {
            Protocol::Tcp => "TCP",
            Protocol::Udp => "UDP",
        }
    }
}

/// `NET_FW_PROFILE2_*` 의 비트값. 위와 같은 이유로 값으로 둔다.
pub const PROFILE_DOMAIN: i32 = 1;
pub const PROFILE_PRIVATE: i32 = 2;
pub const PROFILE_PUBLIC: i32 = 4;
/// `FirewallStatus::state` 문자열과 1:1 이고, 값을 들고 있는 갈래의 값이 그대로
/// `detail` 이 된다.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    FirewallOff,
    Blocked { rule: String },
    Allowed,
    StalePath { program: String },
    ProfileMismatch,
    Missing,
}

/// "지금 이 연결" — 판정이 규칙을 대조하는 기준.
pub struct Target {
    /// [`normalize_exe`] 를 통과한 현재 실행 파일 경로.
    pub exe: String,
    pub port: u16,
    /// `CurrentProfileTypes` 비트마스크.
    pub profiles: i32,
    /// 판정하려는 전송. 이 값(또는 Any)과 프로토콜이 맞는 규칙만 후보다.
    pub protocol: Protocol,
}

/// COM 규칙 하나를 판정에 필요한 만큼만 옮겨 담은 값. 판정이 COM 없이 테스트되도록
/// 이 구조체가 두 세계의 경계다.
#[derive(Debug)]
pub struct RuleRecord {
    pub name: String,
    pub enabled: bool,
    pub direction_in: bool,
    pub action_allow: bool,
    pub protocol: i32,
    pub local_ports: String,
    pub application_name: String,
    /// 실행 파일 경로가 비어도 패키지·소유자·서비스 제한이 있으면 mast용 규칙이 아니다.
    pub local_app_package_id: String,
    pub local_user_owner: String,
    pub service_name: String,
    pub profiles: i32,
    /// Allow·Block 양쪽이 본다. 원격 주소가 좁게 스코프된 Allow(예: 특정 IP 하나)는
    /// 폰을 들이지 못하는데, 그것을 `allowed` 로 읽으면 대화상자가 버튼까지 감추고
    /// "허용됨"이라 안심시키는 최악의 오판이 된다.
    pub remote_addresses: String,
}

/// `\\?\` 접두사와 앞뒤 공백을 떼고 소문자로 맞춘다. Windows 경로 비교는 대소문자를
/// 가리지 않고, 규칙의 `ApplicationName` 에는 그것을 만든 도구에 따라 확장 길이
/// 접두사가 붙기도 안 붙기도 한다.
pub fn normalize_exe(path: &str) -> String {
    let trimmed = path.trim();
    trimmed
        .strip_prefix(r"\\?\")
        .unwrap_or(trimmed)
        .to_ascii_lowercase()
}

/// Any 프로토콜·빈 값·*는 모든 포트다. RPC 등의 키워드는 판정 불가이므로 허용으로 보지 않는다.
fn ports_cover(protocol: i32, local_ports: &str, port: u16) -> bool {
    if protocol == PROTOCOL_ANY {
        return true;
    }
    let ports = local_ports.trim();
    if ports.is_empty() || ports == "*" {
        return true;
    }
    let wanted = u32::from(port);
    ports
        .split(',')
        .any(|item| match item.trim().split_once('-') {
            Some((low, high)) => match (low.trim().parse::<u32>(), high.trim().parse::<u32>()) {
                (Ok(low), Ok(high)) => low <= high && (low..=high).contains(&wanted),
                _ => false,
            },
            None => matches!(item.trim().parse::<u32>(), Ok(value) if value == wanted),
        })
}

/// 대화상자가 "지금 이 네트워크"를 그대로 보여 주는 데 쓴다.
pub fn profile_names(mask: i32) -> Vec<String> {
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

/// 활성 프로필이 하나도 없으면(네트워크 미연결) 꺼진 것으로 보지 않는다 — 그때는
/// 포트를 이야기할 무대 자체가 없고, "방화벽이 꺼져 있다"는 안내는 거짓이 된다.
pub fn firewall_off(enabled_per_active_profile: &[bool]) -> bool {
    !enabled_per_active_profile.is_empty() && enabled_per_active_profile.iter().all(|on| !on)
}

/// 인터넷 대역으로 스코프된 Block 은 흔하고 그것까지 `blocked` 로 세면 정상 PC 가
/// 막혔다고 보고되며, 반대로 특정 IP 로 스코프된 Allow 를 `allowed` 로 세면 폰이
/// 못 붙는데 버튼이 사라진다. 빈 값과 `*` 는 "모든 주소"다 (포트와 같은 규약).
fn remote_covers_lan(remote_addresses: &str) -> bool {
    let value = remote_addresses.trim();
    value.is_empty() || value == "*" || value.to_ascii_lowercase().contains("localsubnet")
}

/// COM 을 타지 않으므로 이 함수가 단위 테스트의 본체다.
pub fn judge(target: &Target, rules: &[RuleRecord], all_profiles_off: bool) -> Verdict {
    if all_profiles_off {
        return Verdict::FirewallOff;
    }

    let reaches_us = |rule: &RuleRecord| {
        rule.enabled
            && rule.local_app_package_id.trim().is_empty()
            && rule.local_user_owner.trim().is_empty()
            && rule.service_name.trim().is_empty()
            && rule.direction_in
            && target.protocol.covers(rule.protocol)
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
    // 이름은 이 표면 몫이다 — UDP 판정이 TCP 규칙의 옛 경로를 보고하지 않는다.
    if let Some(rule) = rules.iter().find(|rule| {
        rule.name == target.protocol.rule_name()
            && !rule.application_name.trim().is_empty()
            && !our_program(rule)
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

/// Local HTTP(TCP) 규칙을 만드는 스크립트 — 기존 계약 그대로다.
pub fn script_text(exe: &str, port: u16, delete_first: bool) -> Result<String, String> {
    script_text_for(Protocol::Tcp, exe, port, delete_first)
}

/// 승격할 스크립트의 입력은 current_exe 원문과 u16 포트만 허용한다. 따옴표 경로는 거부한다.
/// 기존 동명 규칙이 있을 때만 먼저 삭제한다. 규칙은 domain/private에만 적용한다 —
/// Public 프로필은 어느 프로토콜도 열지 않는다.
pub fn script_text_for(
    protocol: Protocol,
    exe: &str,
    port: u16,
    delete_first: bool,
) -> Result<String, String> {
    if exe.contains('"') {
        return Err("the executable path contains a quote character".to_owned());
    }
    let name = protocol.rule_name();
    let delete = if delete_first {
        format!("delete rule name=\"{name}\"\r\n")
    } else {
        String::new()
    };
    Ok(format!(
        "pushd advfirewall firewall\r\n\
         {delete}add rule name=\"{name}\" dir=in action=allow protocol={} \
         localport={port} program=\"{exe}\" profile=domain,private enable=yes\r\n\
         popd\r\n",
        protocol.script_token()
    ))
}

#[cfg(test)]
mod tests;
