//! `fixtures/manager-protocol.json` 계약 테스트 — 앱↔하네스 stdio 메시지의
//! serde 형태와 overview·events_since·회신 오류가 같은 fixture 를 공유한다.
//! 이 fixture 는 이후 Python 하네스와 TS 보드 테스트도 읽는다.

use mast_core::manager::{
    manager_reply_json, parse_harness_line, parse_manager_request, AgentEvent, AgentEventKind,
    AppToHarness, EventWorkspace, EventsSince, HarnessAction, HarnessLine, HarnessSettings,
    HarnessState, HarnessToApp, ManagerOverview, ManagerQueryError, ManagerRequest, NotifyReason,
    OverviewTab, OverviewWorkspace, HARNESS_PROTOCOL, MAX_BOARD_ENTRIES, MAX_HARNESS_LINE_BYTES,
};
use mast_core::model::{AgentKind, AgentSession, AgentStatus};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/manager-protocol.json")).unwrap()
}

fn event_workspace() -> EventWorkspace {
    EventWorkspace {
        id: 1,
        name: "feature-x".into(),
        root_path: Some("/home/u/p/x".into()),
        distro: None,
    }
}

fn agent_session() -> AgentSession {
    AgentSession {
        agent: AgentKind::Claude,
        session_id: "abc".into(),
        transcript_path: "/home/u/.claude/projects/x/abc.jsonl".into(),
    }
}

fn overview() -> ManagerOverview {
    ManagerOverview {
        next_seq: 43,
        workspaces: vec![
            OverviewWorkspace {
                id: 1,
                name: "feature-x".into(),
                root_path: Some("/home/u/p/x".into()),
                distro: None,
                manager: false,
                agent_status: AgentStatus::Running,
                tabs: vec![OverviewTab {
                    tab: 4,
                    title: "claude".into(),
                    kind: "terminal",
                    status: "running",
                    agent_status: AgentStatus::Running,
                    last_agent_message: Some("running the test suite".into()),
                    agent_session: Some(agent_session()),
                }],
            },
            OverviewWorkspace {
                id: 7,
                name: "manager".into(),
                root_path: Some("/home/u/.mast/manager".into()),
                distro: Some("Ubuntu".into()),
                manager: true,
                agent_status: AgentStatus::Idle,
                tabs: vec![
                    OverviewTab {
                        tab: 1,
                        title: "manager".into(),
                        kind: "terminal",
                        status: "running",
                        agent_status: AgentStatus::Idle,
                        last_agent_message: None,
                        agent_session: None,
                    },
                    OverviewTab {
                        tab: 2,
                        title: "Board".into(),
                        kind: "managerBoard",
                        status: "viewer",
                        agent_status: AgentStatus::Idle,
                        last_agent_message: None,
                        agent_session: None,
                    },
                ],
            },
        ],
    }
}

fn events_since() -> EventsSince {
    EventsSince {
        events: vec![
            AgentEvent {
                seq: 41,
                kind: AgentEventKind::Session,
                workspace: event_workspace(),
                tab: Some(4),
                status: None,
                message: None,
                agent_session: Some(agent_session()),
            },
            AgentEvent {
                seq: 42,
                kind: AgentEventKind::Status,
                workspace: event_workspace(),
                tab: Some(4),
                status: Some(AgentStatus::Running),
                message: Some("running the test suite".into()),
                agent_session: None,
            },
        ],
        next_seq: 43,
        gap: false,
    }
}

/// fixture 키가 늘면 소비되지 않은 키를 이 테스트가 알아챈다.
#[test]
fn fixture_keys_and_lengths_are_locked() {
    let fixture = fixture();
    let mut keys: Vec<&str> = fixture
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "appToHarness",
            "errors",
            "eventsSince",
            "harnessToApp",
            "overview",
            "requests"
        ]
    );
    assert_eq!(fixture["appToHarness"].as_array().unwrap().len(), 4);
    assert_eq!(fixture["harnessToApp"].as_array().unwrap().len(), 3);
    assert_eq!(fixture["requests"].as_array().unwrap().len(), 2);
    assert_eq!(fixture["errors"].as_array().unwrap().len(), 3);
    assert_eq!(
        fixture["appToHarness"][1]["overview"], fixture["overview"],
        "snapshot 은 overview 와 같은 개요를 싣는다"
    );
    assert_eq!(
        fixture["appToHarness"][2]["events"], fixture["eventsSince"]["events"],
        "events 메시지는 eventsSince 와 같은 이벤트를 싣는다"
    );
}

#[test]
fn overview_serializes_to_the_fixture_shape() {
    let fixture = fixture();
    let overview = overview();
    assert_eq!(
        serde_json::to_value(&overview).unwrap(),
        fixture["overview"]
    );
    assert_eq!(
        serde_json::to_value(AppToHarness::Snapshot { overview }).unwrap(),
        fixture["appToHarness"][1]
    );
}

#[test]
fn events_since_serializes_to_the_fixture_shape() {
    let fixture = fixture();
    let events_since = events_since();
    assert_eq!(
        serde_json::to_value(&events_since).unwrap(),
        fixture["eventsSince"]
    );
    assert_eq!(
        serde_json::to_value(AppToHarness::Events {
            events: events_since.events,
            next_seq: events_since.next_seq,
        })
        .unwrap(),
        fixture["appToHarness"][2]
    );
}

#[test]
fn hello_and_action_serialize_to_the_fixture_shape() {
    let fixture = fixture();
    let hello = AppToHarness::Hello {
        protocol: HARNESS_PROTOCOL,
        manager_workspace: 7,
        manager_dir: "/home/u/.mast/manager".into(),
        manager_distro: Some("Ubuntu".into()),
        default_distro: Some("Ubuntu".into()),
        settings: HarnessSettings {
            model: "gpt-6-luna".into(),
            effort: "high".into(),
            summary_model: "gpt-6-luna".into(),
            summary_effort: "low".into(),
            idle_seconds: 45,
        },
    };
    assert_eq!(
        serde_json::to_value(&hello).unwrap(),
        fixture["appToHarness"][0]
    );
    assert_eq!(
        serde_json::to_value(AppToHarness::Action {
            action: HarnessAction::Resume,
            key: "k3f9c1a2b4d5e6f70819b".into(),
        })
        .unwrap(),
        fixture["appToHarness"][3]
    );
}

#[test]
fn fixture_requests_parse_with_parse_manager_request() {
    let fixture = fixture();
    let requests = fixture["requests"].as_array().unwrap();
    let parsed: Vec<ManagerRequest> = requests
        .iter()
        .map(|request| {
            let text = serde_json::to_string(request).unwrap();
            parse_manager_request(text.as_bytes()).unwrap()
        })
        .collect();
    assert_eq!(
        parsed,
        [
            ManagerRequest::Workspaces,
            ManagerRequest::Events { since: 3 }
        ]
    );
}

#[test]
fn fixture_errors_match_manager_reply_json() {
    let fixture = fixture();
    let errors = fixture["errors"].as_array().unwrap();
    for (index, error) in [
        ManagerQueryError::Forbidden,
        ManagerQueryError::InvalidParams,
        ManagerQueryError::TooLarge,
    ]
    .into_iter()
    .enumerate()
    {
        let reply: Value = serde_json::from_str(&manager_reply_json(Err(error))).unwrap();
        assert_eq!(reply, errors[index], "{error:?}");
    }
}

#[test]
fn fixture_harness_messages_parse_as_known_messages() {
    let fixture = fixture();
    let messages = fixture["harnessToApp"].as_array().unwrap();

    match parse_harness_line(&serde_json::to_string(&messages[0]).unwrap()) {
        HarnessLine::Known(HarnessToApp::Status {
            state,
            message,
            last_collected_at,
            log_path,
            codex_version,
        }) => {
            assert_eq!(state, HarnessState::Ok);
            assert_eq!(message.as_deref(), Some("watching 2 workspaces"));
            assert_eq!(last_collected_at.as_deref(), Some("2026-09-25T04:20:00Z"));
            assert_eq!(
                log_path.as_deref(),
                Some("/home/u/.mast/manager/logs/harness.log")
            );
            assert_eq!(codex_version.as_deref(), Some("codex-cli 0.9.1"));
        }
        other => panic!("status fixture: {other:?}"),
    }

    match parse_harness_line(&serde_json::to_string(&messages[1]).unwrap()) {
        HarnessLine::Known(HarnessToApp::Board {
            generated_at,
            entries,
        }) => {
            assert_eq!(generated_at, "2026-09-25T04:20:00Z");
            let states: Vec<&str> = entries
                .iter()
                .map(|entry| entry["state"].as_str().unwrap())
                .collect();
            assert_eq!(states, ["none", "unsupported", "choice"]);
            for entry in &entries {
                assert_eq!(entry["task"], Value::Null, "task 는 null 예시다");
            }
            assert_eq!(entries[1]["reason"], "other_distro");
        }
        other => panic!("board fixture: {other:?}"),
    }

    match parse_harness_line(&serde_json::to_string(&messages[2]).unwrap()) {
        HarnessLine::Known(HarnessToApp::Notify {
            workspace_id,
            reason,
            title,
            body,
        }) => {
            assert_eq!(workspace_id, 3);
            assert_eq!(reason, NotifyReason::Question);
            assert_eq!(title, "manager needs a choice");
            assert_eq!(
                body,
                "Resume the stored task or start fresh for workspace feature-x."
            );
        }
        other => panic!("notify fixture: {other:?}"),
    }
}

#[test]
fn parse_harness_line_classifies_unknown_and_invalid_lines() {
    assert_eq!(
        parse_harness_line(r#"{"type":"ping","nonce":7}"#),
        HarnessLine::Unknown("ping".into())
    );

    for line in ["not json", "[1,2]", r#"{"state":"ok"}"#, r#"{"type":7}"#] {
        assert!(
            matches!(parse_harness_line(line), HarnessLine::Invalid(_)),
            "line: {line}"
        );
    }

    let over_title = {
        let title = "a".repeat(81);
        json!({
            "type": "notify",
            "workspaceId": 3,
            "reason": "done",
            "title": title,
            "body": "done",
        })
    };
    assert!(matches!(
        parse_harness_line(&over_title.to_string()),
        HarnessLine::Invalid(_)
    ));

    let over_body = {
        let body = "b".repeat(201);
        json!({
            "type": "notify",
            "workspaceId": 3,
            "reason": "done",
            "title": "done",
            "body": body,
        })
    };
    assert!(matches!(
        parse_harness_line(&over_body.to_string()),
        HarnessLine::Invalid(_)
    ));

    let too_many_entries = {
        let entries: Vec<Value> = vec![json!({}); MAX_BOARD_ENTRIES + 1];
        json!({
            "type": "board",
            "generatedAt": "2026-09-25T04:20:00Z",
            "entries": entries,
        })
    };
    assert!(matches!(
        parse_harness_line(&too_many_entries.to_string()),
        HarnessLine::Invalid(_)
    ));

    // 유효한 JSON 이지만 4 MiB 를 넘는다 — 길이 검사가 파싱보다 먼저다.
    let oversized = format!(
        r#"{{"type":"status","state":"ok","message":"{}"}}"#,
        "a".repeat(MAX_HARNESS_LINE_BYTES)
    );
    assert!(matches!(
        parse_harness_line(&oversized),
        HarnessLine::Invalid(_)
    ));

    // 스키마 위반(모르는 state)도 Invalid 다.
    assert!(matches!(
        parse_harness_line(r#"{"type":"status","state":"sleeping"}"#),
        HarnessLine::Invalid(_)
    ));
}

#[test]
fn parse_harness_line_accepts_the_exact_limits() {
    let notify = {
        let title = "a".repeat(80);
        let body = "b".repeat(200);
        json!({
            "type": "notify",
            "workspaceId": 3,
            "reason": "question",
            "title": title,
            "body": body,
        })
    };
    assert!(matches!(
        parse_harness_line(&notify.to_string()),
        HarnessLine::Known(HarnessToApp::Notify { .. })
    ));

    let board = {
        let entries: Vec<Value> = vec![json!({}); MAX_BOARD_ENTRIES];
        json!({
            "type": "board",
            "generatedAt": "2026-09-25T04:20:00Z",
            "entries": entries,
        })
    };
    assert!(matches!(
        parse_harness_line(&board.to_string()),
        HarnessLine::Known(HarnessToApp::Board { .. })
    ));

    let prefix = r#"{"type":"status","state":"ok","message":""#;
    let suffix = r#""}"#;
    let padding = "a".repeat(MAX_HARNESS_LINE_BYTES - prefix.len() - suffix.len());
    let exact = format!("{prefix}{padding}{suffix}");
    assert_eq!(exact.len(), MAX_HARNESS_LINE_BYTES);
    assert!(matches!(
        parse_harness_line(&exact),
        HarnessLine::Known(HarnessToApp::Status { .. })
    ));
}
