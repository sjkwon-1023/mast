use super::*;

const EXE: &str = r"C:\Users\me\Downloads\mast-x64.exe";
const PORT: u16 = 7331;

fn target() -> Target {
    Target {
        exe: normalize_exe(EXE),
        port: PORT,
        profiles: PROFILE_PRIVATE,
        protocol: Protocol::Tcp,
    }
}

/// Secure Remote(UDP) 판정 대상 — 같은 exe·포트·프로필, 전송만 다르다.
fn udp_target() -> Target {
    Target {
        protocol: Protocol::Udp,
        ..target()
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
    assert_eq!(
        judge(&target(), &[allowing_rule()], false),
        Verdict::Allowed
    );
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

// ---- Secure Remote(UDP) — Local HTTP(TCP) 규칙과 공존 불변식 ----

/// UDP 규칙의 정본. 테스트마다 한 필드씩 비튼다.
fn udp_allowing_rule() -> RuleRecord {
    RuleRecord {
        name: SECURE_RULE_NAME.to_owned(),
        protocol: PROTOCOL_UDP,
        ..allowing_rule()
    }
}

#[test]
fn the_two_surfaces_have_distinct_rule_names() {
    assert_ne!(Protocol::Tcp.rule_name(), Protocol::Udp.rule_name());
    assert_eq!(Protocol::ALL.len(), 2);
    assert!(Protocol::ALL.contains(&Protocol::Tcp));
    assert!(Protocol::ALL.contains(&Protocol::Udp));
}

#[test]
fn judge_does_not_let_a_tcp_allow_reach_the_udp_surface() {
    // 같은 프로그램·같은 포트·같은 프로필의 TCP 허용은 UDP 판정에 닿지 않는다.
    assert_eq!(
        judge(&udp_target(), &[allowing_rule()], false),
        Verdict::Missing
    );
}

#[test]
fn judge_does_not_let_a_udp_allow_reach_the_tcp_surface() {
    assert_eq!(
        judge(&target(), &[udp_allowing_rule()], false),
        Verdict::Missing
    );
}

#[test]
fn judge_allows_each_surface_independently_on_one_pc() {
    // Local HTTP TCP 와 Secure Remote UDP 가 같은 7331 을 써도 둘 다 허용될 수 있다.
    let rules = vec![allowing_rule(), udp_allowing_rule()];
    assert_eq!(judge(&target(), &rules, false), Verdict::Allowed);
    assert_eq!(judge(&udp_target(), &rules, false), Verdict::Allowed);
}

#[test]
fn judge_reads_an_any_protocol_allow_for_both_surfaces() {
    // Windows 의 "허용" 프롬프트가 만드는 프로토콜 Any 규칙은 두 표면 모두에 해당한다.
    let prompt = RuleRecord {
        protocol: PROTOCOL_ANY,
        local_ports: String::new(),
        ..allowing_rule()
    };
    assert_eq!(
        judge(&target(), std::slice::from_ref(&prompt), false),
        Verdict::Allowed
    );
    assert_eq!(
        judge(&udp_target(), std::slice::from_ref(&prompt), false),
        Verdict::Allowed
    );
}

#[test]
fn judge_reports_a_udp_stale_path_only_for_the_udp_rule() {
    let moved = RuleRecord {
        name: SECURE_RULE_NAME.to_owned(),
        application_name: r"C:\Old\mast-x64.exe".to_owned(),
        ..udp_allowing_rule()
    };
    assert_eq!(
        judge(&udp_target(), std::slice::from_ref(&moved), false),
        Verdict::StalePath {
            program: r"C:\Old\mast-x64.exe".to_owned()
        }
    );
    // 같은 규칙이 TCP 판정에는 남의 규칙이다 (이름이 다르고 프로토콜도 다르다).
    assert_eq!(judge(&target(), &[moved], false), Verdict::Missing);
}

#[test]
fn judge_lets_a_udp_program_block_beat_a_udp_allow() {
    let block = || RuleRecord {
        name: "vendor udp block".to_owned(),
        action_allow: false,
        ..udp_allowing_rule()
    };
    assert_eq!(
        judge(&udp_target(), &[udp_allowing_rule(), block()], false),
        Verdict::Blocked {
            rule: "vendor udp block".to_owned()
        }
    );
    // 그 Block 이 UDP 라도 TCP 판정에는 닿지 않는다 — 같은 목록에 Block 을 **넣은 채**
    // TCP 대상으로 판정해야 프로토콜 필터가 실제로 검증된다. Block 을 빼면 Allow 만
    // 남아 이 단언이 아무것도 검증하지 못한다.
    assert_eq!(
        judge(&target(), &[allowing_rule(), block()], false),
        Verdict::Allowed
    );
}

#[test]
fn udp_script_writes_the_secure_rule_and_never_public() {
    let script = script_text_for(Protocol::Udp, EXE, PORT, false).unwrap();
    assert_eq!(
        script,
        "pushd advfirewall firewall\r\n\
         add rule name=\"mast secure remote (LAN)\" dir=in action=allow protocol=UDP \
         localport=7331 program=\"C:\\Users\\me\\Downloads\\mast-x64.exe\" \
         profile=domain,private enable=yes\r\n\
         popd\r\n"
    );
    assert!(!script.contains("public"), "Public 프로필을 열면 안 된다");
}

#[test]
fn udp_script_deletes_only_its_own_rule_first() {
    let script = script_text_for(Protocol::Udp, EXE, PORT, true).unwrap();
    assert!(
        script.contains("delete rule name=\"mast secure remote (LAN)\"\r\n"),
        "{script}"
    );
    assert!(
        !script.contains(RULE_NAME),
        "UDP 스크립트가 TCP 규칙을 지우면 안 된다: {script}"
    );
}

#[test]
fn udp_script_refuses_a_quoted_path_too() {
    assert!(script_text_for(Protocol::Udp, r#"C:\a"b\mast.exe"#, PORT, false).is_err());
}
