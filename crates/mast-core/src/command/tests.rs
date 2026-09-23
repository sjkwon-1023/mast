use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use super::events::recompute_agent_summary;
use super::queries::parse_tab_id_target;
use super::*;
use crate::model::{
    AgentStatus, NotificationState, Pane, SplitTree, Tab, TabKind, TerminalStatus, Workspace,
};
use crate::notify::OscBatch;
use crate::osc::OscEvent;
use crate::send::SendTargetError;

/// 테스트용 fake 호스트 — 스폰 id 순차 발급(1부터), kill·스폰·해제 통지 기록,
/// 스폰 실패 주입.
#[derive(Default)]
struct FakeHostInner {
    next_session: AtomicU32,
    kills: Mutex<Vec<SessionId>>,
    spawns: Mutex<Vec<ShellSpawnReq>>,
    /// `release_tabs` 호출 한 번이 원소 하나 — 배치 계약(호출 횟수)까지
    /// 검사할 수 있게 탭 목록을 평탄화하지 않는다.
    releases: Mutex<Vec<(Vec<TabId>, Option<String>)>>,
    fail_spawn: AtomicBool,
}

#[derive(Clone, Default)]
struct FakeSessionHost(Arc<FakeHostInner>);

impl FakeSessionHost {
    fn kills(&self) -> Vec<SessionId> {
        self.0.kills.lock().unwrap().clone()
    }

    fn spawns(&self) -> Vec<ShellSpawnReq> {
        self.0.spawns.lock().unwrap().clone()
    }

    fn releases(&self) -> Vec<(Vec<TabId>, Option<String>)> {
        self.0.releases.lock().unwrap().clone()
    }

    fn set_fail_spawn(&self, fail: bool) {
        self.0.fail_spawn.store(fail, Ordering::SeqCst);
    }
}

impl SessionHost for FakeSessionHost {
    fn spawn_shell(&self, req: ShellSpawnReq) -> anyhow::Result<SessionId> {
        if self.0.fail_spawn.load(Ordering::SeqCst) {
            anyhow::bail!("injected spawn failure");
        }
        self.0.spawns.lock().unwrap().push(req);
        Ok(self.0.next_session.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn kill(&self, id: SessionId) {
        self.0.kills.lock().unwrap().push(id);
    }

    fn release_tabs(&self, tabs: &[TabId], distro: Option<&str>) {
        self.0
            .releases
            .lock()
            .unwrap()
            .push((tabs.to_vec(), distro.map(str::to_string)));
    }
}

fn dispatcher() -> (Dispatcher, FakeSessionHost) {
    let host = FakeSessionHost::default();
    (Dispatcher::new(Box::new(host.clone())), host)
}

/// 워크스페이스 1개(tab 없음)를 만들고 (workspace, 초기 pane) id 를
/// 돌려주는 헬퍼.
fn create_ws(d: &mut Dispatcher, name: &str) -> (WorkspaceId, PaneId) {
    match d
        .dispatch(Command::CreateWorkspace {
            name: name.into(),
            root_path: None,
            distro: None,
            tab: None,
        })
        .unwrap()
    {
        CommandOutput::WorkspaceCreated {
            workspace,
            pane,
            tab: None,
            session: None,
        } => (workspace, pane),
        other => panic!("unexpected output: {other:?}"),
    }
}

fn create_terminal_tab(d: &mut Dispatcher, pane: PaneId) -> (TabId, SessionId) {
    match d
        .dispatch(Command::CreateTab {
            pane,
            tab: NewTab::Terminal { cwd: None },
        })
        .unwrap()
    {
        CommandOutput::TabCreated {
            tab,
            session: Some(s),
        } => (tab, s),
        other => panic!("unexpected output: {other:?}"),
    }
}

/// 탭 없는 분할 헬퍼 — (새 pane, 새 split 노드) id 를 돌려준다.
fn split_empty(d: &mut Dispatcher, pane: PaneId, direction: SplitDirection) -> (PaneId, SplitId) {
    match d
        .dispatch(Command::SplitPane {
            pane,
            direction,
            tab: None,
        })
        .unwrap()
    {
        CommandOutput::PaneCreated {
            pane,
            split,
            tab: None,
            session: None,
        } => (pane, split),
        other => panic!("unexpected output: {other:?}"),
    }
}

#[test]
fn create_workspace_makes_empty_pane_and_activates() {
    let (mut d, _host) = dispatcher();
    let out = d
        .dispatch(Command::CreateWorkspace {
            name: "ws".into(),
            root_path: Some("/proj".into()),
            distro: Some("Ubuntu".into()),
            tab: None,
        })
        .unwrap();
    assert_eq!(
        out,
        CommandOutput::WorkspaceCreated {
            workspace: WorkspaceId(1),
            pane: PaneId(2),
            tab: None,
            session: None,
        }
    );
    let ws = d.state().workspace(WorkspaceId(1)).unwrap();
    assert_eq!(ws.layout, SplitTree::Leaf { pane: PaneId(2) });
    assert_eq!(ws.active_pane, PaneId(2));
    assert_eq!(ws.agent_status, AgentStatus::Idle);
    assert!(ws.panes[&PaneId(2)].tabs.is_empty());
    assert_eq!(ws.panes[&PaneId(2)].active_tab, None);
    assert_eq!(d.state().active_workspace, Some(WorkspaceId(1)));
    assert_eq!(d.state().revision, 1);
    assert_eq!(d.state().next_id, 3);
}

#[test]
fn create_workspace_with_tab_creates_tab_atomically() {
    let (mut d, host) = dispatcher();
    let out = d
        .dispatch(Command::CreateWorkspace {
            name: "ws".into(),
            root_path: Some("/proj".into()),
            distro: Some("Ubuntu".into()),
            tab: Some(NewTab::Terminal { cwd: None }),
        })
        .unwrap();
    // 생성된 안정 ID 전부 반환 (계획 13-D1) — 발급 순서는 workspace →
    // pane → tab.
    let CommandOutput::WorkspaceCreated {
        workspace,
        pane,
        tab: Some(tab),
        session: Some(session),
    } = out
    else {
        panic!("unexpected output: {out:?}");
    };
    assert!(workspace.0 < pane.0 && pane.0 < tab.0);

    let w = d.state().workspace(workspace).unwrap();
    assert_eq!(w.layout, SplitTree::Leaf { pane });
    assert_eq!(w.active_pane, pane);
    let p = &w.panes[&pane];
    assert_eq!(p.tabs.len(), 1);
    assert_eq!(p.tabs[0].id, tab);
    assert_eq!(p.active_tab, Some(tab));
    let TabKind::Terminal {
        pty_session,
        status,
        cwd,
    } = &p.tabs[0].kind
    else {
        panic!("terminal 탭이 아님");
    };
    assert_eq!(*pty_session, Some(session));
    assert_eq!(*status, TerminalStatus::Running);
    // cwd 미지정 → 워크스페이스 root_path 상속, distro 도 워크스페이스
    // 기본값 — CreateTab·SplitPane 과 공유하는 스폰 경로.
    assert_eq!(cwd.as_deref(), Some("/proj"));
    assert_eq!(host.spawns()[0].cwd.as_deref(), Some("/proj"));
    assert_eq!(host.spawns()[0].distro, expected_distro("Ubuntu"));
    assert_eq!(d.state().active_workspace, Some(workspace));
    assert_eq!(d.state().revision, 1);
}

#[test]
fn create_workspace_with_tab_spawn_failure_leaves_state_untouched() {
    let (mut d, host) = dispatcher();
    // 기존 워크스페이스를 하나 두어 active_workspace 불변까지 함께 잠근다.
    create_ws(&mut d, "existing");
    host.set_fail_spawn(true);
    let before = serde_json::to_value(d.state()).unwrap();

    let err = d
        .dispatch(Command::CreateWorkspace {
            name: "ws".into(),
            root_path: None,
            distro: None,
            tab: Some(NewTab::Terminal { cwd: None }),
        })
        .unwrap_err();
    assert!(matches!(err, CommandError::SpawnFailed { .. }));
    // 워크스페이스·pane·next_id·revision 전부 불변 (spawn-first 원자성).
    let after = serde_json::to_value(d.state()).unwrap();
    assert_eq!(before, after, "spawn 실패가 상태를 바꿈 (원자성 위반)");
}

#[test]
fn create_workspace_tab_field_missing_deserializes_to_none() {
    // 하위호환 (계획 13-D1): 13단계 이전 클라이언트의 tab 필드 없는 JSON 은
    // tab: None 으로 파싱된다 (fixture 쪽 잠금은 dispatcher.rs 참조).
    let cmd: Command = serde_json::from_str(
        r#"{ "type": "createWorkspace", "name": "ws", "rootPath": null, "distro": null }"#,
    )
    .unwrap();
    assert_eq!(
        cmd,
        Command::CreateWorkspace {
            name: "ws".into(),
            root_path: None,
            distro: None,
            tab: None,
        }
    );
}

#[test]
fn full_flow_kills_sessions_and_collapses() {
    let (mut d, host) = dispatcher();
    let (ws, pane1) = create_ws(&mut d, "ws");

    // 분할(탭 없음) → 새 빈 pane 이 second 로 생기고 포커스 이동.
    let (pane2, split_id) = split_empty(&mut d, pane1, SplitDirection::Vertical);
    {
        let w = d.state().workspace(ws).unwrap();
        assert_eq!(w.active_pane, pane2);
        assert_eq!(w.layout.leaves(), vec![pane1, pane2]);
        assert_eq!(w.layout.split_ids(), vec![split_id]);
    }

    // 탭 3개: pane1 에 1개, pane2 에 2개.
    let (_tab1, s1) = create_terminal_tab(&mut d, pane1);
    let (tab2, s2) = create_terminal_tab(&mut d, pane2);
    let (tab3, s3) = create_terminal_tab(&mut d, pane2);
    assert_eq!((s1, s2, s3), (1, 2, 3));
    assert_eq!(
        d.state().workspace(ws).unwrap().panes[&pane2].active_tab,
        Some(tab3)
    );

    // 탭 닫기 → 그 세션만 kill, active_tab 은 직전 탭으로.
    d.dispatch(Command::CloseTab { tab: tab3 }).unwrap();
    assert_eq!(host.kills(), vec![s3]);
    assert_eq!(
        d.state().workspace(ws).unwrap().panes[&pane2].active_tab,
        Some(tab2)
    );

    // pane 닫기 → 남은 세션 kill + tree collapse + 포커스 회귀.
    d.dispatch(Command::ClosePane { pane: pane2 }).unwrap();
    assert_eq!(host.kills(), vec![s3, s2]);
    {
        let w = d.state().workspace(ws).unwrap();
        assert_eq!(w.layout, SplitTree::Leaf { pane: pane1 });
        assert_eq!(w.active_pane, pane1);
    }

    // 워크스페이스 닫기 → 남은 세션 전부 kill, active 는 None.
    d.dispatch(Command::CloseWorkspace { workspace: ws })
        .unwrap();
    assert_eq!(host.kills(), vec![s3, s2, s1]);
    assert!(d.state().workspaces.is_empty());
    assert_eq!(d.state().active_workspace, None);

    // revision 은 dispatch 성공 횟수(8)와 일치 — 단조 증가.
    assert_eq!(d.state().revision, 8);
}

#[test]
fn closing_an_exited_tab_releases_its_files_without_a_kill() {
    // 자연 종료된 탭은 세션을 이미 놓았으므로(ADR-0018) kill 할 대상이 없다.
    // 그래도 탭 id 는 release 에 실려야 한다 — HISTFILE·resume 힌트는 세션이
    // 아니라 탭에 붙어 있고, 여기서 빠지면 그 파일이 영원히 남는다 (ADR-0013).
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws_on(&mut d, "ws", "Ubuntu");
    let (tab, session) = create_terminal_tab(&mut d, pane);
    d.apply_event(SessionEvent::SessionExited {
        session,
        code: Some(0),
        ended_at_ms: 1_700_000_000_000,
    });
    d.dispatch(Command::CloseTab { tab }).unwrap();
    assert!(host.kills().is_empty());
    assert_eq!(host.releases(), vec![(vec![tab], expected_distro("Ubuntu"))]);
}

#[test]
fn close_last_pane_is_rejected() {
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let rev = d.state().revision;
    let err = d.dispatch(Command::ClosePane { pane }).unwrap_err();
    assert_eq!(err, CommandError::LastPane);
    assert_eq!(d.state().revision, rev);
    assert!(host.kills().is_empty());
    assert!(d.state().workspaces[0].panes.contains_key(&pane));
}

#[test]
fn unknown_targets_error_without_state_change() {
    let (mut d, _host) = dispatcher();
    create_ws(&mut d, "ws");
    let rev = d.state().revision;
    let cases = [
        Command::SwitchWorkspace {
            workspace: WorkspaceId(99),
        },
        Command::CloseWorkspace {
            workspace: WorkspaceId(99),
        },
        Command::FocusPane { pane: PaneId(99) },
        Command::SplitPane {
            pane: PaneId(99),
            direction: SplitDirection::Horizontal,
            tab: None,
        },
        Command::ResizeSplit {
            split: SplitId(99),
            ratio: 0.5,
        },
        Command::ClosePane { pane: PaneId(99) },
        Command::CreateTab {
            pane: PaneId(99),
            tab: NewTab::Terminal { cwd: None },
        },
        Command::ActivateTab { tab: TabId(99) },
        Command::CloseTab { tab: TabId(99) },
        Command::NavigateFolder {
            tab: TabId(99),
            path: "/proj".into(),
        },
        Command::SetViewerScroll {
            tab: TabId(99),
            scroll_top: 0.0,
        },
    ];
    for cmd in cases {
        let err = d.dispatch(cmd.clone()).unwrap_err();
        assert!(
            matches!(err, CommandError::UnknownTarget { .. }),
            "{cmd:?} → {err:?}"
        );
        assert_eq!(d.state().revision, rev, "{cmd:?} 가 상태를 바꿈");
    }
}

#[test]
fn spawn_failure_leaves_state_untouched() {
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    host.set_fail_spawn(true);
    let before = serde_json::to_value(d.state()).unwrap();
    let err = d
        .dispatch(Command::CreateTab {
            pane,
            tab: NewTab::Terminal { cwd: None },
        })
        .unwrap_err();
    assert!(matches!(err, CommandError::SpawnFailed { .. }));
    let after = serde_json::to_value(d.state()).unwrap();
    assert_eq!(before, after, "spawn 실패가 상태를 바꿈 (원자성 위반)");
}

#[test]
fn resize_split_updates_ratio() {
    let (mut d, _host) = dispatcher();
    let (ws, pane1) = create_ws(&mut d, "ws");
    let (_pane2, split_id) = split_empty(&mut d, pane1, SplitDirection::Horizontal);
    let rev = d.state().revision;

    let out = d
        .dispatch(Command::ResizeSplit {
            split: split_id,
            ratio: 0.25,
        })
        .unwrap();
    assert_eq!(out, CommandOutput::Done);
    assert_eq!(d.state().revision, rev + 1);
    let SplitTree::Split { id, ratio, .. } = &d.state().workspace(ws).unwrap().layout else {
        panic!("split 이어야 함");
    };
    assert_eq!(*id, split_id);
    assert_eq!(*ratio, 0.25);
}

#[test]
fn resize_split_reaches_inactive_workspace() {
    // split id 탐색은 전 워크스페이스 범위 — 비활성 워크스페이스의 split 도
    // id 로 조준된다 (안정 ID 전역 유일).
    let (mut d, _host) = dispatcher();
    let (ws1, pane1) = create_ws(&mut d, "one");
    let (_pane2, split_id) = split_empty(&mut d, pane1, SplitDirection::Vertical);
    let (ws2, _) = create_ws(&mut d, "two");
    assert_eq!(d.state().active_workspace, Some(ws2));

    d.dispatch(Command::ResizeSplit {
        split: split_id,
        ratio: 0.7,
    })
    .unwrap();
    let SplitTree::Split { ratio, .. } = &d.state().workspace(ws1).unwrap().layout else {
        panic!("split 이어야 함");
    };
    assert_eq!(*ratio, 0.7);
}

#[test]
fn resize_split_stale_id_is_unknown_target() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane1) = create_ws(&mut d, "ws");
    let (pane2, split_id) = split_empty(&mut d, pane1, SplitDirection::Horizontal);
    // collapse 로 split 노드가 사라진 뒤 옛 id 로 resize — 스테일 주소.
    d.dispatch(Command::ClosePane { pane: pane2 }).unwrap();
    let rev = d.state().revision;

    let err = d
        .dispatch(Command::ResizeSplit {
            split: split_id,
            ratio: 0.5,
        })
        .unwrap_err();
    assert!(matches!(err, CommandError::UnknownTarget { .. }), "{err:?}");
    assert_eq!(d.state().revision, rev);
}

#[test]
fn resize_split_invalid_ratio_rejected_without_state_change() {
    let (mut d, _host) = dispatcher();
    let (ws, pane1) = create_ws(&mut d, "ws");
    let (_pane2, split_id) = split_empty(&mut d, pane1, SplitDirection::Horizontal);
    let rev = d.state().revision;

    // 개구간 (0, 1) 밖·비유한 값 전부 InvalidRatio — 경계 0.0·1.0 포함.
    for ratio in [f64::NAN, 0.0, 1.0, -0.25, 1.5, f64::INFINITY] {
        let err = d
            .dispatch(Command::ResizeSplit {
                split: split_id,
                ratio,
            })
            .unwrap_err();
        assert!(
            matches!(err, CommandError::InvalidRatio { .. }),
            "ratio {ratio} → {err:?}"
        );
        assert_eq!(d.state().revision, rev, "ratio {ratio} 가 상태를 바꿈");
    }
    let SplitTree::Split { ratio, .. } = &d.state().workspace(ws).unwrap().layout else {
        panic!("split 이어야 함");
    };
    assert_eq!(*ratio, 0.5, "실패한 resize 가 ratio 를 바꿈");
}

#[test]
fn split_pane_with_tab_creates_pane_and_tab_atomically() {
    let (mut d, host) = dispatcher();
    let out = d
        .dispatch(Command::CreateWorkspace {
            name: "ws".into(),
            root_path: Some("/proj".into()),
            distro: Some("Ubuntu".into()),
            tab: None,
        })
        .unwrap();
    let CommandOutput::WorkspaceCreated {
        workspace: ws,
        pane: pane1,
        ..
    } = out
    else {
        panic!("unexpected output: {out:?}");
    };

    let out = d
        .dispatch(Command::SplitPane {
            pane: pane1,
            direction: SplitDirection::Vertical,
            tab: Some(NewTab::Terminal { cwd: None }),
        })
        .unwrap();
    // 생성된 안정 ID 전부 반환 (계획 D5) — 발급 순서는 pane → split → tab.
    let CommandOutput::PaneCreated {
        pane: pane2,
        split,
        tab: Some(tab),
        session: Some(session),
    } = out
    else {
        panic!("unexpected output: {out:?}");
    };
    assert!(pane2.0 < split.0 && split.0 < tab.0);

    let w = d.state().workspace(ws).unwrap();
    assert_eq!(w.active_pane, pane2);
    assert_eq!(w.layout.leaves(), vec![pane1, pane2]);
    assert_eq!(w.layout.split_ids(), vec![split]);
    let p2 = &w.panes[&pane2];
    assert_eq!(p2.tabs.len(), 1);
    assert_eq!(p2.active_tab, Some(tab));
    let TabKind::Terminal {
        pty_session,
        status,
        cwd,
    } = &p2.tabs[0].kind
    else {
        panic!("terminal 탭이 아님");
    };
    assert_eq!(*pty_session, Some(session));
    assert_eq!(*status, TerminalStatus::Running);
    // 워크스페이스 기본값(cwd·distro) 적용 — CreateTab 과 공유하는 스폰 경로.
    assert_eq!(cwd.as_deref(), Some("/proj"));
    assert_eq!(host.spawns()[0].cwd.as_deref(), Some("/proj"));
    assert_eq!(host.spawns()[0].distro, expected_distro("Ubuntu"));
}

#[test]
fn split_pane_with_tab_spawn_failure_leaves_state_untouched() {
    let (mut d, host) = dispatcher();
    let (_ws, pane1) = create_ws(&mut d, "ws");
    host.set_fail_spawn(true);
    let before = serde_json::to_value(d.state()).unwrap();

    let err = d
        .dispatch(Command::SplitPane {
            pane: pane1,
            direction: SplitDirection::Horizontal,
            tab: Some(NewTab::Terminal { cwd: None }),
        })
        .unwrap_err();
    assert!(matches!(err, CommandError::SpawnFailed { .. }));
    // 트리·panes·next_id·revision 전부 불변 (spawn-first 원자성).
    let after = serde_json::to_value(d.state()).unwrap();
    assert_eq!(before, after, "spawn 실패가 상태를 바꿈 (원자성 위반)");
}

#[test]
fn close_last_tab_collapses_pane_and_fixes_focus() {
    // multi-pane 워크스페이스에서 pane 의 마지막 탭 닫기 → 세션 kill +
    // collapse + active_pane fixup (계획 D6).
    let (mut d, host) = dispatcher();
    let (ws, pane1) = create_ws(&mut d, "ws");
    let out = d
        .dispatch(Command::SplitPane {
            pane: pane1,
            direction: SplitDirection::Horizontal,
            tab: Some(NewTab::Terminal { cwd: None }),
        })
        .unwrap();
    let CommandOutput::PaneCreated {
        pane: pane2,
        tab: Some(tab2),
        session: Some(s2),
        ..
    } = out
    else {
        panic!("unexpected output: {out:?}");
    };
    assert_eq!(d.state().workspace(ws).unwrap().active_pane, pane2);

    d.dispatch(Command::CloseTab { tab: tab2 }).unwrap();
    assert_eq!(host.kills(), vec![s2]);
    let w = d.state().workspace(ws).unwrap();
    assert_eq!(w.layout, SplitTree::Leaf { pane: pane1 });
    assert!(!w.panes.contains_key(&pane2));
    // 닫힌 pane 이 포커스였으므로 leaf 순서상 첫 pane 으로 fixup.
    assert_eq!(w.active_pane, pane1);
}

#[test]
fn close_last_tab_of_inactive_pane_collapses_and_keeps_focus() {
    let (mut d, host) = dispatcher();
    let (ws, pane1) = create_ws(&mut d, "ws");
    let out = d
        .dispatch(Command::SplitPane {
            pane: pane1,
            direction: SplitDirection::Vertical,
            tab: Some(NewTab::Terminal { cwd: None }),
        })
        .unwrap();
    let CommandOutput::PaneCreated {
        pane: pane2,
        tab: Some(tab2),
        session: Some(s2),
        ..
    } = out
    else {
        panic!("unexpected output: {out:?}");
    };
    // 포커스를 pane1 로 되돌린 뒤 비활성 pane2 의 마지막 탭을 닫는다.
    d.dispatch(Command::FocusPane { pane: pane1 }).unwrap();

    d.dispatch(Command::CloseTab { tab: tab2 }).unwrap();
    assert_eq!(host.kills(), vec![s2]);
    let w = d.state().workspace(ws).unwrap();
    assert_eq!(w.layout, SplitTree::Leaf { pane: pane1 });
    assert!(!w.panes.contains_key(&pane2));
    // 포커스는 원래부터 pane1 — fixup 없이 그대로.
    assert_eq!(w.active_pane, pane1);
}

#[test]
fn create_tab_uses_workspace_defaults_for_spawn() {
    let (mut d, host) = dispatcher();
    let out = d
        .dispatch(Command::CreateWorkspace {
            name: "ws".into(),
            root_path: Some("/proj".into()),
            distro: Some("Ubuntu".into()),
            tab: None,
        })
        .unwrap();
    let CommandOutput::WorkspaceCreated { pane, .. } = out else {
        panic!("unexpected output: {out:?}");
    };

    // cwd 미지정 → root_path 상속, cols/rows 는 기본 80×24.
    create_terminal_tab(&mut d, pane);
    // cwd 명시 → 그대로 사용.
    d.dispatch(Command::CreateTab {
        pane,
        tab: NewTab::Terminal {
            cwd: Some("/elsewhere".into()),
        },
    })
    .unwrap();

    let spawns = host.spawns();
    assert_eq!(
        spawns[0],
        ShellSpawnReq {
            cwd: Some("/proj".into()),
            distro: expected_distro("Ubuntu"),
            cols: 80,
            rows: 24,
            // 워크스페이스(1)·pane(2) 다음 발급이므로 첫 탭은 3.
            history_tab: Some(3),
        }
    );
    assert_eq!(spawns[1].cwd, Some("/elsewhere".into()));

    // 탭에도 실제 적용된 cwd 가 기록된다.
    let ws = &d.state().workspaces[0];
    let TabKind::Terminal { cwd, .. } = &ws.panes[&pane].tabs[0].kind else {
        panic!("terminal 탭이 아님");
    };
    assert_eq!(cwd.as_deref(), Some("/proj"));
}

/// 탭별 명령 history 계약 (체크포인트 2 UX): 스폰 3경로 전부에서 호스트가
/// 받은 `history_tab` 이 **그 스폰으로 생긴 탭의 안정 ID** 와 같아야 한다.
/// 스폰이 id 발급보다 먼저라 peek 으로 계산하는 값이므로, 할당 순서가 바뀌면
/// 핸들러의 debug_assert 와 이 테스트가 함께 터진다.
#[test]
fn spawn_carries_history_tab_of_the_created_tab() {
    let (mut d, host) = dispatcher();
    // 1) CreateWorkspace(tab 동반) — 발급 순서 workspace → pane → tab.
    let out = d
        .dispatch(Command::CreateWorkspace {
            name: "ws".into(),
            root_path: None,
            distro: None,
            tab: Some(NewTab::Terminal { cwd: None }),
        })
        .unwrap();
    let CommandOutput::WorkspaceCreated {
        pane,
        tab: Some(ws_tab),
        ..
    } = out
    else {
        panic!("unexpected output: {out:?}");
    };
    // 2) CreateTab — 탭 id 만 발급.
    let (created_tab, _session) = create_terminal_tab(&mut d, pane);
    // 3) SplitPane(tab 동반) — 발급 순서 pane → split → tab.
    let out = d
        .dispatch(Command::SplitPane {
            pane,
            direction: SplitDirection::Vertical,
            tab: Some(NewTab::Terminal { cwd: None }),
        })
        .unwrap();
    let CommandOutput::PaneCreated {
        tab: Some(split_tab),
        ..
    } = out
    else {
        panic!("unexpected output: {out:?}");
    };

    let history: Vec<Option<u64>> = host.spawns().iter().map(|r| r.history_tab).collect();
    assert_eq!(
        history,
        vec![Some(ws_tab.0), Some(created_tab.0), Some(split_tab.0)]
    );
}

#[test]
fn close_tab_adjusts_active_to_previous() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (tab1, _) = create_terminal_tab(&mut d, pane);
    let (tab2, _) = create_terminal_tab(&mut d, pane);
    let (tab3, _) = create_terminal_tab(&mut d, pane);

    // active(=tab3) 닫기 → 직전 탭 tab2.
    d.dispatch(Command::CloseTab { tab: tab3 }).unwrap();
    let active = |d: &Dispatcher| d.state().workspace(ws).unwrap().panes[&pane].active_tab;
    assert_eq!(active(&d), Some(tab2));

    // active 가 아닌 첫 탭 닫기 → active 유지.
    d.dispatch(Command::CloseTab { tab: tab1 }).unwrap();
    assert_eq!(active(&d), Some(tab2));

    // 마지막 탭 닫기 → 워크스페이스의 마지막 pane 이므로 collapse 예외:
    // 빈 pane (active_tab = None)으로 남는다 (계획 D6).
    d.dispatch(Command::CloseTab { tab: tab2 }).unwrap();
    assert_eq!(active(&d), None);
    let w = d.state().workspace(ws).unwrap();
    assert!(w.panes[&pane].tabs.is_empty());
    assert_eq!(w.layout, SplitTree::Leaf { pane });
    assert_eq!(w.active_pane, pane);
}

#[test]
fn close_first_tab_while_active_falls_to_next() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (tab1, _) = create_terminal_tab(&mut d, pane);
    let (tab2, _) = create_terminal_tab(&mut d, pane);
    d.dispatch(Command::ActivateTab { tab: tab1 }).unwrap();

    // 첫 탭이 active 인 채로 닫기 → 다음 탭(tab2)으로.
    d.dispatch(Command::CloseTab { tab: tab1 }).unwrap();
    assert_eq!(
        d.state().workspace(ws).unwrap().panes[&pane].active_tab,
        Some(tab2)
    );
}

#[test]
fn focus_pane_does_not_switch_workspace() {
    let (mut d, _host) = dispatcher();
    let (ws1, _pane1) = create_ws(&mut d, "one");
    let (ws2, pane2) = create_ws(&mut d, "two");
    let (pane3, _split) = split_empty(&mut d, pane2, SplitDirection::Horizontal);

    d.dispatch(Command::SwitchWorkspace { workspace: ws1 })
        .unwrap();
    assert_eq!(d.state().active_workspace, Some(ws1));
    assert_eq!(d.state().workspace(ws2).unwrap().active_pane, pane3);

    // 비활성 워크스페이스의 pane 포커스 — 그 워크스페이스의 active_pane 만
    // 바뀌고 active_workspace 는 그대로 (명령 직교성).
    d.dispatch(Command::FocusPane { pane: pane2 }).unwrap();
    assert_eq!(d.state().active_workspace, Some(ws1));
    assert_eq!(d.state().workspace(ws2).unwrap().active_pane, pane2);
}

#[test]
fn close_active_workspace_falls_back_to_first_remaining() {
    let (mut d, _host) = dispatcher();
    let (ws1, _) = create_ws(&mut d, "one");
    let (ws2, _) = create_ws(&mut d, "two");
    assert_eq!(d.state().active_workspace, Some(ws2));
    d.dispatch(Command::CloseWorkspace { workspace: ws2 })
        .unwrap();
    assert_eq!(d.state().active_workspace, Some(ws1));

    // 비활성 워크스페이스를 닫으면 active 는 그대로.
    let (ws3, _) = create_ws(&mut d, "three");
    d.dispatch(Command::SwitchWorkspace { workspace: ws1 })
        .unwrap();
    d.dispatch(Command::CloseWorkspace { workspace: ws3 })
        .unwrap();
    assert_eq!(d.state().active_workspace, Some(ws1));
}

#[test]
fn rename_workspace_updates_only_the_name() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "one");
    let (tab, _session) = create_terminal_tab(&mut d, pane);
    let rev = d.state().revision;

    d.dispatch(Command::RenameWorkspace {
        workspace: ws,
        name: "renamed".into(),
    })
    .unwrap();

    assert_eq!(d.state().workspace(ws).unwrap().name, "renamed");
    assert_eq!(d.state().revision, rev + 1);
    // 탭 제목은 워크스페이스 이름과 별개 (OSC 2 소유).
    assert_eq!(tab_view(&d, tab).title, "Terminal");
    // 활성 워크스페이스도 그대로 — 이름 변경은 전환이 아니다.
    assert_eq!(d.state().active_workspace, Some(ws));
}

#[test]
fn rename_workspace_reaches_inactive_workspace() {
    let (mut d, _host) = dispatcher();
    let (ws1, _) = create_ws(&mut d, "one");
    let (ws2, _) = create_ws(&mut d, "two");
    assert_eq!(d.state().active_workspace, Some(ws2));

    d.dispatch(Command::RenameWorkspace {
        workspace: ws1,
        name: "background".into(),
    })
    .unwrap();

    assert_eq!(d.state().workspace(ws1).unwrap().name, "background");
    assert_eq!(d.state().workspace(ws2).unwrap().name, "two");
    assert_eq!(d.state().active_workspace, Some(ws2));
}

#[test]
fn rename_workspace_rejects_blank_names_without_state_change() {
    let (mut d, _host) = dispatcher();
    let (ws, _pane) = create_ws(&mut d, "one");
    let before = serde_json::to_value(d.state()).unwrap();

    for name in ["", " ", "\t\n  "] {
        let err = d
            .dispatch(Command::RenameWorkspace {
                workspace: ws,
                name: name.into(),
            })
            .unwrap_err();
        assert!(
            matches!(err, CommandError::InvalidName { .. }),
            "{name:?} → {err:?}"
        );
    }
    // 미지 워크스페이스는 UnknownTarget (검증은 이름이 먼저).
    let err = d
        .dispatch(Command::RenameWorkspace {
            workspace: WorkspaceId(999),
            name: "x".into(),
        })
        .unwrap_err();
    assert!(matches!(err, CommandError::UnknownTarget { .. }), "{err:?}");

    // 실패 dispatch 는 상태·revision 을 건드리지 않는다.
    assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
}

#[test]
fn rename_workspace_keeps_the_given_name_verbatim() {
    // 앞뒤 공백 다듬기는 코어의 일이 아니다 (입력 UI 몫) — 공백을 **포함한**
    // 이름은 정상 값이다.
    let (mut d, _host) = dispatcher();
    let (ws, _pane) = create_ws(&mut d, "one");
    d.dispatch(Command::RenameWorkspace {
        workspace: ws,
        name: " my  project ".into(),
    })
    .unwrap();
    assert_eq!(d.state().workspace(ws).unwrap().name, " my  project ");
}

#[test]
fn session_exited_drops_the_session_and_stamps_the_time() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (_tab, session) = create_terminal_tab(&mut d, pane);
    let rev = d.state().revision;

    d.apply_event(SessionEvent::SessionExited {
        session,
        code: Some(0),
        ended_at_ms: 1_700_000_000_000,
    });
    assert_eq!(d.state().revision, rev + 1);
    let TabKind::Terminal {
        pty_session,
        status,
        ..
    } = &d.state().workspace(ws).unwrap().panes[&pane].tabs[0].kind
    else {
        panic!("terminal 탭이 아님");
    };
    assert_eq!(*pty_session, None, "죽은 세션은 탭이 놓는다");
    assert_eq!(
        *status,
        TerminalStatus::Exited {
            code: Some(0),
            ended_at_ms: Some(1_700_000_000_000)
        }
    );

    // 같은 세션의 재도착은 이제 세션 id 로 찾히지 않는다 — 미지 세션 no-op 과
    // 같은 결과이고, 두 번째 시각이 첫 종료 시각을 덮지 않는다.
    d.apply_event(SessionEvent::SessionExited {
        session,
        code: Some(9),
        ended_at_ms: 1_700_000_999_999,
    });
    assert_eq!(d.state().revision, rev + 1);
    let TabKind::Terminal { status, .. } =
        &d.state().workspace(ws).unwrap().panes[&pane].tabs[0].kind
    else {
        panic!("terminal 탭이 아님");
    };
    assert_eq!(
        *status,
        TerminalStatus::Exited {
            code: Some(0),
            ended_at_ms: Some(1_700_000_000_000)
        }
    );
}

#[test]
fn session_exited_unknown_session_is_noop() {
    let (mut d, _host) = dispatcher();
    create_ws(&mut d, "ws");
    let before = serde_json::to_value(d.state()).unwrap();
    // CloseTab 선행 후 exit 통지가 도착하는 정상 순서 — 패닉·변이 없어야 한다.
    d.apply_event(SessionEvent::SessionExited {
        session: 999,
        code: None,
        ended_at_ms: 1_700_000_000_000,
    });
    assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
}

#[test]
fn revision_increases_by_one_per_successful_dispatch() {
    let (mut d, _host) = dispatcher();
    assert_eq!(d.state().revision, 0);
    let (_ws, pane) = create_ws(&mut d, "ws");
    assert_eq!(d.state().revision, 1);
    create_terminal_tab(&mut d, pane);
    assert_eq!(d.state().revision, 2);
    assert_eq!(d.snapshot().revision, 2);
}

// ---- 뷰어 탭 (21단계 계획 청크 A) ----

/// root_path 를 지정해 워크스페이스를 만드는 헬퍼 (뷰어 기본값 검증용).
fn create_ws_rooted(
    d: &mut Dispatcher,
    name: &str,
    root_path: Option<&str>,
) -> (WorkspaceId, PaneId) {
    match d
        .dispatch(Command::CreateWorkspace {
            name: name.into(),
            root_path: root_path.map(String::from),
            distro: None,
            tab: None,
        })
        .unwrap()
    {
        CommandOutput::WorkspaceCreated {
            workspace,
            pane,
            tab: None,
            session: None,
        } => (workspace, pane),
        other => panic!("unexpected output: {other:?}"),
    }
}

/// 뷰어 탭 생성 헬퍼 — 스폰이 없으므로 출력의 session 은 항상 None 이다.
fn create_viewer_tab(d: &mut Dispatcher, pane: PaneId, spec: NewTab) -> TabId {
    match d.dispatch(Command::CreateTab { pane, tab: spec }).unwrap() {
        CommandOutput::TabCreated { tab, session: None } => tab,
        other => panic!("unexpected output: {other:?}"),
    }
}

#[test]
fn create_folder_browser_inherits_root_path_without_spawning() {
    let (mut d, host) = dispatcher();
    let (ws, pane) = create_ws_rooted(&mut d, "ws", Some("/proj/app"));
    let tab = create_viewer_tab(&mut d, pane, NewTab::FolderBrowser { path: None });

    assert!(host.spawns().is_empty(), "뷰어 탭 생성은 스폰이 없다");
    let t = tab_view(&d, tab);
    // path 미지정 → 워크스페이스 root_path 상속, 제목은 basename.
    assert_eq!(
        t.kind,
        TabKind::FolderBrowser {
            path: "/proj/app".into()
        }
    );
    assert_eq!(t.title, "app");
    assert_eq!(
        d.state().workspace(ws).unwrap().panes[&pane].active_tab,
        Some(tab)
    );
}

#[test]
fn folder_browser_falls_back_to_root_when_both_paths_are_none() {
    // 탭 path 도 워크스페이스 root_path 도 없으면 "/" (계획 21단계 core 계약).
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let tab = create_viewer_tab(&mut d, pane, NewTab::FolderBrowser { path: None });
    let t = tab_view(&d, tab);
    assert_eq!(t.kind, TabKind::FolderBrowser { path: "/".into() });
    assert_eq!(t.title, "/");
}

#[test]
fn create_text_viewer_starts_at_offset_zero() {
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws_rooted(&mut d, "ws", Some("/proj"));
    let tab = create_viewer_tab(
        &mut d,
        pane,
        NewTab::TextViewer {
            path: "/proj/notes.txt".into(),
        },
    );
    assert!(host.spawns().is_empty());
    let t = tab_view(&d, tab);
    assert_eq!(
        t.kind,
        TabKind::TextViewer {
            path: "/proj/notes.txt".into(),
            scroll_top: 0.0,
        }
    );
    assert_eq!(t.title, "notes.txt");
}

#[test]
fn create_markdown_viewer_starts_at_pixel_zero() {
    // markdownViewer 는 TextViewer 와 같은 생성 계약(스폰 없음·basename 제목)
    // 이고 scroll_top 만 px 시맨틱이다 (21단계 청크 D).
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws_rooted(&mut d, "ws", Some("/proj"));
    let tab = create_viewer_tab(
        &mut d,
        pane,
        NewTab::MarkdownViewer {
            path: "/proj/README.md".into(),
        },
    );
    assert!(host.spawns().is_empty(), "뷰어 탭 생성은 스폰이 없다");
    let t = tab_view(&d, tab);
    assert_eq!(
        t.kind,
        TabKind::MarkdownViewer {
            path: "/proj/README.md".into(),
            scroll_top: 0.0,
        }
    );
    assert_eq!(t.title, "README.md");
}

#[test]
fn create_workspace_and_split_pane_accept_viewer_tabs_atomically() {
    let (mut d, host) = dispatcher();
    // 워크스페이스 + 뷰어 탭 원자 생성 — session 만 None 이고 tab 은 Some.
    let out = d
        .dispatch(Command::CreateWorkspace {
            name: "ws".into(),
            root_path: Some("/proj".into()),
            distro: None,
            tab: Some(NewTab::FolderBrowser { path: None }),
        })
        .unwrap();
    let CommandOutput::WorkspaceCreated {
        workspace,
        pane,
        tab: Some(tab),
        session: None,
    } = out
    else {
        panic!("unexpected output: {out:?}");
    };
    assert!(workspace.0 < pane.0 && pane.0 < tab.0);
    let p = &d.state().workspace(workspace).unwrap().panes[&pane];
    assert_eq!(p.tabs.len(), 1);
    assert_eq!(p.active_tab, Some(tab));
    assert_eq!(
        p.tabs[0].kind,
        TabKind::FolderBrowser {
            path: "/proj".into()
        }
    );

    // 분할 + 뷰어 탭 원자 생성.
    let out = d
        .dispatch(Command::SplitPane {
            pane,
            direction: SplitDirection::Vertical,
            tab: Some(NewTab::TextViewer {
                path: "/proj/a.txt".into(),
            }),
        })
        .unwrap();
    let CommandOutput::PaneCreated {
        pane: pane2,
        split,
        tab: Some(tab2),
        session: None,
    } = out
    else {
        panic!("unexpected output: {out:?}");
    };
    assert!(pane2.0 < split.0 && split.0 < tab2.0);
    let w = d.state().workspace(workspace).unwrap();
    assert_eq!(w.active_pane, pane2);
    assert_eq!(w.panes[&pane2].active_tab, Some(tab2));
    assert_eq!(tab_view(&d, tab2).title, "a.txt");
    assert!(host.spawns().is_empty(), "뷰어 탭 생성은 스폰이 없다");
}

#[test]
fn navigate_folder_updates_path_and_title() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let tab = create_viewer_tab(
        &mut d,
        pane,
        NewTab::FolderBrowser {
            path: Some("/proj".into()),
        },
    );

    let out = d
        .dispatch(Command::NavigateFolder {
            tab,
            path: "/proj/src/model".into(),
        })
        .unwrap();
    assert_eq!(out, CommandOutput::Done);
    let t = tab_view(&d, tab);
    assert_eq!(
        t.kind,
        TabKind::FolderBrowser {
            path: "/proj/src/model".into()
        }
    );
    assert_eq!(t.title, "model");

    // 루트로 올라가면 제목도 "/" (basename 이 없는 경로).
    d.dispatch(Command::NavigateFolder {
        tab,
        path: "/".into(),
    })
    .unwrap();
    let t = tab_view(&d, tab);
    assert_eq!(t.kind, TabKind::FolderBrowser { path: "/".into() });
    assert_eq!(t.title, "/");
}

#[test]
fn viewer_commands_reject_wrong_tab_kinds_without_state_change() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (terminal, _s) = create_terminal_tab(&mut d, pane);
    let folder = create_viewer_tab(
        &mut d,
        pane,
        NewTab::FolderBrowser {
            path: Some("/proj".into()),
        },
    );
    let text = create_viewer_tab(
        &mut d,
        pane,
        NewTab::TextViewer {
            path: "/proj/a.txt".into(),
        },
    );
    let markdown = create_viewer_tab(
        &mut d,
        pane,
        NewTab::MarkdownViewer {
            path: "/proj/a.md".into(),
        },
    );
    let before = serde_json::to_value(d.state()).unwrap();

    let cases = [
        // NavigateFolder 는 folderBrowser 만 받는다.
        (
            Command::NavigateFolder {
                tab: terminal,
                path: "/x".into(),
            },
            terminal,
        ),
        (
            Command::NavigateFolder {
                tab: text,
                path: "/x".into(),
            },
            text,
        ),
        (
            Command::NavigateFolder {
                tab: markdown,
                path: "/x".into(),
            },
            markdown,
        ),
        // SetViewerScroll 은 스크롤 위치를 모델에 가진 뷰어만 받는다 —
        // folderBrowser 는 그 필드가 없어 KindMismatch (기결정).
        (
            Command::SetViewerScroll {
                tab: folder,
                scroll_top: 10.0,
            },
            folder,
        ),
        (
            Command::SetViewerScroll {
                tab: terminal,
                scroll_top: 10.0,
            },
            terminal,
        ),
    ];
    for (cmd, target) in cases {
        let err = d.dispatch(cmd.clone()).unwrap_err();
        assert_eq!(err, CommandError::KindMismatch { tab: target }, "{cmd:?}");
        assert_eq!(
            serde_json::to_value(d.state()).unwrap(),
            before,
            "{cmd:?} 가 상태를 바꿈"
        );
    }
}

#[test]
#[cfg(not(target_os = "macos"))]
fn create_workspace_rejects_mnt_roots() {
    // Windows 스토리지는 워크스페이스 루트 금지 — /mnt 정확히·하위 경로 둘 다.
    // 접두 경계는 지킨다 (/mnta 는 무관한 디렉터리다). 거부는 상태 불변이다.
    let (mut d, _host) = dispatcher();
    let before = serde_json::to_string(&d.snapshot()).unwrap();
    for path in ["/mnt", "/mnt/c", "/mnt/c/Users/dev/code"] {
        let err = d
            .dispatch(Command::CreateWorkspace {
                name: "w".into(),
                root_path: Some(path.into()),
                distro: None,
                tab: None,
            })
            .unwrap_err();
        assert!(matches!(err, CommandError::InvalidPath { .. }), "{path}");
    }
    assert_eq!(serde_json::to_string(&d.snapshot()).unwrap(), before);
    d.dispatch(Command::CreateWorkspace {
        name: "w".into(),
        root_path: Some("/mnta/data".into()),
        distro: None,
        tab: None,
    })
    .unwrap();
}

#[test]
fn viewer_paths_are_validated_on_create_and_navigate() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let folder = create_viewer_tab(
        &mut d,
        pane,
        NewTab::FolderBrowser {
            path: Some("/proj".into()),
        },
    );
    let before = serde_json::to_value(d.state()).unwrap();

    // wslpath 거부 규칙별 대표 1개씩 — 사유는 wslpath.rs 테스트가 잠근다.
    for path in [
        "relative/path",
        "/proj/../etc",
        #[cfg(not(target_os = "macos"))]
        r"/proj/a\b",
        #[cfg(not(target_os = "macos"))]
        "/proj/a:stream",
        #[cfg(not(target_os = "macos"))]
        "/proj/trailing.",
        "",
    ] {
        for cmd in [
            Command::CreateTab {
                pane,
                tab: NewTab::TextViewer { path: path.into() },
            },
            Command::CreateTab {
                pane,
                tab: NewTab::MarkdownViewer { path: path.into() },
            },
            Command::CreateTab {
                pane,
                tab: NewTab::FolderBrowser {
                    path: Some(path.into()),
                },
            },
            Command::NavigateFolder {
                tab: folder,
                path: path.into(),
            },
        ] {
            let err = d.dispatch(cmd.clone()).unwrap_err();
            assert!(
                matches!(err, CommandError::InvalidPath { .. }),
                "{cmd:?} → {err:?}"
            );
            // next_id 까지 불변 (검증이 id 발급보다 먼저).
            assert_eq!(
                serde_json::to_value(d.state()).unwrap(),
                before,
                "{cmd:?} 가 상태를 바꿈"
            );
        }
    }
}

#[test]
fn set_viewer_scroll_records_offset_and_rejects_bad_values() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let tab = create_viewer_tab(
        &mut d,
        pane,
        NewTab::TextViewer {
            path: "/proj/a.txt".into(),
        },
    );

    let out = d
        .dispatch(Command::SetViewerScroll {
            tab,
            scroll_top: 4096.0,
        })
        .unwrap();
    assert_eq!(out, CommandOutput::Done);
    assert_eq!(
        tab_view(&d, tab).kind,
        TabKind::TextViewer {
            path: "/proj/a.txt".into(),
            scroll_top: 4096.0,
        }
    );

    // finite·0 이상이 아니면 InvalidScroll, 상태 불변 (0.0 은 유효 경계).
    let before = serde_json::to_value(d.state()).unwrap();
    for value in [f64::NAN, -1.0, f64::INFINITY, f64::NEG_INFINITY] {
        let err = d
            .dispatch(Command::SetViewerScroll {
                tab,
                scroll_top: value,
            })
            .unwrap_err();
        assert!(
            matches!(err, CommandError::InvalidScroll { .. }),
            "{value} → {err:?}"
        );
        assert_eq!(
            serde_json::to_value(d.state()).unwrap(),
            before,
            "{value} 가 상태를 바꿈"
        );
    }
    d.dispatch(Command::SetViewerScroll {
        tab,
        scroll_top: 0.0,
    })
    .unwrap();
}

#[test]
fn set_viewer_scroll_records_pixel_offset_for_markdown_viewer() {
    // 같은 명령이 markdownViewer 도 받는다 — 값은 렌더 px 지만 코어는 단위를
    // 해석하지 않고 f64 를 그대로 보관한다 (21단계 청크 D).
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let tab = create_viewer_tab(
        &mut d,
        pane,
        NewTab::MarkdownViewer {
            path: "/proj/README.md".into(),
        },
    );

    let out = d
        .dispatch(Command::SetViewerScroll {
            tab,
            scroll_top: 120.5,
        })
        .unwrap();
    assert_eq!(out, CommandOutput::Done);
    assert_eq!(
        tab_view(&d, tab).kind,
        TabKind::MarkdownViewer {
            path: "/proj/README.md".into(),
            scroll_top: 120.5,
        }
    );

    let before = serde_json::to_value(d.state()).unwrap();
    let err = d
        .dispatch(Command::SetViewerScroll {
            tab,
            scroll_top: -1.0,
        })
        .unwrap_err();
    assert!(matches!(err, CommandError::InvalidScroll { .. }), "{err:?}");
    assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
}

#[test]
fn viewer_tabs_survive_persist_round_trip() {
    // 뷰어 탭은 sanitize 대상이 아니다 — 경로·스크롤이 재시작을 넘어 남아야
    // 뷰어 재로드(계획 v2 "상태 저장")가 성립한다.
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws_rooted(&mut d, "ws", Some("/proj"));
    let (terminal, _s) = create_terminal_tab(&mut d, pane);
    let folder = create_viewer_tab(&mut d, pane, NewTab::FolderBrowser { path: None });
    let text = create_viewer_tab(
        &mut d,
        pane,
        NewTab::TextViewer {
            path: "/proj/notes.txt".into(),
        },
    );
    let markdown = create_viewer_tab(
        &mut d,
        pane,
        NewTab::MarkdownViewer {
            path: "/proj/README.md".into(),
        },
    );
    d.dispatch(Command::SetViewerScroll {
        tab: text,
        scroll_top: 4096.0,
    })
    .unwrap();
    d.dispatch(Command::SetViewerScroll {
        tab: markdown,
        scroll_top: 120.5,
    })
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    crate::persist::save_atomic(&path, d.state()).unwrap();
    let crate::persist::LoadOutcome::Restored { state, repairs } = crate::persist::load(&path)
    else {
        panic!("Restored 여야 함");
    };
    assert!(repairs.is_empty(), "정상 상태에 수리 사유: {repairs:?}");

    let kind_of = |state: &AppState, id: TabId| {
        state
            .workspaces
            .iter()
            .flat_map(|ws| ws.panes.values())
            .flat_map(|p| p.tabs.iter())
            .find(|t| t.id == id)
            .expect("탭이 존재해야 함")
            .kind
            .clone()
    };
    assert_eq!(
        kind_of(&state, folder),
        TabKind::FolderBrowser {
            path: "/proj".into()
        }
    );
    assert_eq!(
        kind_of(&state, text),
        TabKind::TextViewer {
            path: "/proj/notes.txt".into(),
            scroll_top: 4096.0,
        },
        "sanitize 가 뷰어 스크롤을 건드리면 안 된다"
    );
    assert_eq!(
        kind_of(&state, markdown),
        TabKind::MarkdownViewer {
            path: "/proj/README.md".into(),
            scroll_top: 120.5,
        }
    );

    // 재스폰 대상은 terminal 탭뿐 — 뷰어 탭은 열거에 끼지 않는다.
    let adopted = Dispatcher::adopt(state, Box::new(FakeSessionHost::default()));
    assert_eq!(adopted.running_terminal_tabs(), vec![terminal]);
}

// ---- OSC 델타 반영 (18단계 계획 core 계약) ----

fn status_notify(token: &str, body: &str) -> OscEvent {
    OscEvent::Osc777Notify {
        title: token.into(),
        body: body.into(),
    }
}

/// (세션, 이벤트) 목록을 한 배치로 병합한다 — 글루의 flush 창 한 번에 해당.
fn batch(events: &[(SessionId, OscEvent)]) -> OscBatch {
    let mut b = OscBatch::default();
    for (session, ev) in events {
        b.merge(*session, ev);
    }
    b
}

/// 워크스페이스의 파생 에이전트 상태 (상태, 미리보기 메시지).
fn agent(d: &Dispatcher, ws: WorkspaceId) -> (AgentStatus, Option<String>) {
    let w = d.state().workspace(ws).unwrap();
    (w.agent_status, w.last_agent_message.clone())
}

fn tab_agent(d: &Dispatcher, tab: TabId) -> (AgentStatus, Option<String>) {
    let t = tab_view(d, tab);
    (t.agent_status, t.last_agent_message.clone())
}

fn msg(text: &str) -> Option<String> {
    Some(text.to_owned())
}

/// 탭 값 관측 헬퍼 — 전 워크스페이스 범위 탐색.
fn tab_view(d: &Dispatcher, tab: TabId) -> &Tab {
    d.state()
        .workspaces
        .iter()
        .flat_map(|ws| ws.panes.values())
        .flat_map(|pane| pane.tabs.iter())
        .find(|t| t.id == tab)
        .expect("탭이 존재해야 함")
}

fn tab_cwd(d: &Dispatcher, tab: TabId) -> Option<String> {
    let TabKind::Terminal { cwd, .. } = &tab_view(d, tab).kind else {
        panic!("terminal 탭이어야 함");
    };
    cwd.clone()
}

#[test]
fn apply_osc_routes_delta_to_the_tab_owning_the_session() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (tab1, s1) = create_terminal_tab(&mut d, pane);
    // 나중에 만든 tab2 가 active — tab1 은 뒤에 숨는다.
    let (tab2, _s2) = create_terminal_tab(&mut d, pane);
    let rev = d.state().revision;

    let changed = d.apply_osc(
        batch(&[
            (s1, OscEvent::Osc0Title("agent".into())),
            (s1, OscEvent::Osc7Cwd("file://h/home/u/my%20proj".into())),
            (s1, status_notify("mast:needsInput", "approve?")),
        ]),
        1_000,
    );
    assert!(changed);
    assert_eq!(d.state().revision, rev + 1);

    // 역매핑된 탭에만 필드가 반영된다.
    let t1 = tab_view(&d, tab1);
    assert_eq!(t1.title, "agent");
    assert_eq!(t1.notification, NotificationState::Unread);
    assert_eq!(t1.last_activity_ms, Some(1_000));
    assert!(t1.last_agent_message_seq.is_some());
    assert_eq!(tab_cwd(&d, tab1).as_deref(), Some("/home/u/my proj"));
    assert_eq!(
        tab_agent(&d, tab1),
        (AgentStatus::NeedsInput, msg("approve?"))
    );

    // 같은 pane 의 다른 탭은 그대로.
    let t2 = tab_view(&d, tab2);
    assert_eq!(t2.title, "Terminal");
    assert_eq!(t2.notification, NotificationState::None);
    assert_eq!(t2.last_activity_ms, None);
    assert_eq!(tab_cwd(&d, tab2), None);
    assert_eq!(tab_agent(&d, tab2), (AgentStatus::Idle, None));

    // 워크스페이스는 탭에서 파생된다.
    assert_eq!(agent(&d, ws), (AgentStatus::NeedsInput, msg("approve?")));
}

#[test]
fn apply_osc_unknown_session_is_noop() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    create_terminal_tab(&mut d, pane);
    let before = serde_json::to_value(d.state()).unwrap();

    // 창이 열려 있는 동안 탭이 닫히는 정상 순서 — 패닉·변이 없이 false.
    assert!(!d.apply_osc(
        batch(&[(999, status_notify("mast:needsInput", "x"))]),
        1_000
    ));
    assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
}

#[test]
fn a_late_delta_cannot_reach_an_exited_tab() {
    // 100ms 창 안에서 세션이 끝나면 즉시 처리된 SessionExited 의 Idle 리셋 뒤에
    // 지연 배치가 도착한다 — 죽은 탭에 알림·상태를 다시 도장하면 안 된다. 이제
    // 그 탭은 세션을 놓은 상태라 역매핑(locate_session)에서 아예 빠진다.
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (tab, session) = create_terminal_tab(&mut d, pane);
    d.apply_osc(
        batch(&[(session, status_notify("mast:needsInput", "approve?"))]),
        1_000,
    );
    d.apply_event(SessionEvent::SessionExited {
        session,
        code: Some(0),
        ended_at_ms: 1_700_000_000_000,
    });
    assert_eq!(agent(&d, ws), (AgentStatus::Idle, None));
    assert_eq!(tab_agent(&d, tab), (AgentStatus::Idle, None));
    assert_eq!(terminal_of(&d, tab).1, None, "세션을 놓은 뒤가 전제다");
    let before = serde_json::to_value(d.state()).unwrap();

    // 제목·활동 시각까지 통째로 무해 — 상태 변화 없음.
    assert!(!d.apply_osc(
        batch(&[
            (session, OscEvent::Osc0Title("late".into())),
            (session, status_notify("mast:needsInput", "still?")),
        ]),
        2_000,
    ));
    assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
}

#[test]
fn apply_osc_keeps_needs_input_against_other_tabs() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (tab1, s1) = create_terminal_tab(&mut d, pane);
    let (tab2, s2) = create_terminal_tab(&mut d, pane);
    d.apply_osc(
        batch(&[(s1, status_notify("mast:needsInput", "approve?"))]),
        1_000,
    );

    // 다른 탭의 running·idle 은 입력 대기를 가리지 못하고, 그 탭 자신에만 남는다.
    for (token, status) in [
        ("mast:running", AgentStatus::Running),
        ("mast:idle", AgentStatus::Idle),
    ] {
        d.apply_osc(batch(&[(s2, status_notify(token, "other"))]), 2_000);
        assert_eq!(
            agent(&d, ws),
            (AgentStatus::NeedsInput, msg("approve?")),
            "{token}"
        );
        assert_eq!(tab_agent(&d, tab2), (status, msg("other")), "{token}");
    }

    // 두 번째 needsInput 은 더 최근이므로 미리보기가 그 탭으로 옮겨간다.
    d.apply_osc(
        batch(&[(s2, status_notify("mast:needsInput", "second"))]),
        3_000,
    );
    assert_eq!(agent(&d, ws), (AgentStatus::NeedsInput, msg("second")));
    assert_eq!(
        tab_agent(&d, tab1),
        (AgentStatus::NeedsInput, msg("approve?"))
    );
}

#[test]
fn apply_osc_lets_the_waiting_tab_leave_needs_input() {
    // 사용자가 응답하면 그 탭의 UserPromptSubmit(running)이 자연 강등한다.
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (tab1, s1) = create_terminal_tab(&mut d, pane);
    d.apply_osc(
        batch(&[(s1, status_notify("mast:needsInput", "approve?"))]),
        1_000,
    );
    assert!(d.apply_osc(batch(&[(s1, status_notify("mast:running", ""))]), 2_000));
    // 빈 body 는 앞선 메시지를 지우지 않는다 (notify.rs last-non-empty).
    assert_eq!(tab_agent(&d, tab1), (AgentStatus::Running, msg("approve?")));
    assert_eq!(agent(&d, ws), (AgentStatus::Running, msg("approve?")));
}

#[test]
fn apply_osc_suppresses_unread_on_visible_tab_only() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (tab1, s1) = create_terminal_tab(&mut d, pane);
    let (tab2, s2) = create_terminal_tab(&mut d, pane);

    d.apply_osc(
        batch(&[
            (s1, status_notify("mast:idle", "done")),
            (s2, status_notify("mast:idle", "done")),
        ]),
        1_000,
    );
    // 가시 탭(active 워크스페이스 + 그 pane 의 active_tab)은 억제, 숨은 탭은 세팅.
    assert_eq!(tab_view(&d, tab2).notification, NotificationState::None);
    assert_eq!(tab_view(&d, tab1).notification, NotificationState::Unread);

    // 다른 워크스페이스로 나가면 같은 탭도 비가시가 된다.
    create_ws(&mut d, "other");
    d.apply_osc(batch(&[(s2, status_notify("mast:idle", "done"))]), 2_000);
    assert_eq!(tab_view(&d, tab2).notification, NotificationState::Unread);
}

#[test]
fn activate_tab_clears_unread() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (tab1, s1) = create_terminal_tab(&mut d, pane);
    create_terminal_tab(&mut d, pane);
    d.apply_osc(batch(&[(s1, status_notify("mast:idle", "done"))]), 1_000);
    assert_eq!(tab_view(&d, tab1).notification, NotificationState::Unread);

    d.dispatch(Command::ActivateTab { tab: tab1 }).unwrap();
    assert_eq!(tab_view(&d, tab1).notification, NotificationState::None);
}

#[test]
fn switch_workspace_clears_unread_of_each_panes_active_tab() {
    let (mut d, _host) = dispatcher();
    let (ws1, pane1) = create_ws(&mut d, "one");
    let (tab_a, sa) = create_terminal_tab(&mut d, pane1);
    let (tab_b, sb) = create_terminal_tab(&mut d, pane1);
    let (pane2, _split) = split_empty(&mut d, pane1, SplitDirection::Horizontal);
    let (tab_c, sc) = create_terminal_tab(&mut d, pane2);
    // 다른 워크스페이스로 나가 전 탭을 비가시로 만든 뒤 알림을 세운다.
    create_ws(&mut d, "two");
    d.apply_osc(
        batch(&[
            (sa, status_notify("mast:idle", "a")),
            (sb, status_notify("mast:idle", "b")),
            (sc, status_notify("mast:idle", "c")),
        ]),
        1_000,
    );
    for tab in [tab_a, tab_b, tab_c] {
        assert_eq!(tab_view(&d, tab).notification, NotificationState::Unread);
    }

    d.dispatch(Command::SwitchWorkspace { workspace: ws1 })
        .unwrap();
    // 각 pane 의 active_tab 만 해제 — 뒤에 숨은 탭 a 는 그대로.
    assert_eq!(tab_view(&d, tab_b).notification, NotificationState::None);
    assert_eq!(tab_view(&d, tab_c).notification, NotificationState::None);
    assert_eq!(tab_view(&d, tab_a).notification, NotificationState::Unread);
}

#[test]
fn close_tab_clears_unread_of_promoted_tab_when_visible() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (tab_a, sa) = create_terminal_tab(&mut d, pane);
    let (tab_b, _sb) = create_terminal_tab(&mut d, pane);
    // tab_b 가 active 라 tab_a 는 숨어 있다 — unread 가 선다.
    d.apply_osc(batch(&[(sa, status_notify("mast:idle", "a"))]), 1_000);
    assert_eq!(tab_view(&d, tab_a).notification, NotificationState::Unread);

    // active 탭을 닫으면 tab_a 가 승격돼 곧바로 화면에 드러난다 — 가시화 = 읽음.
    d.dispatch(Command::CloseTab { tab: tab_b }).unwrap();
    assert_eq!(tab_view(&d, tab_a).notification, NotificationState::None);
}

#[test]
fn close_tab_keeps_unread_of_promoted_tab_in_background_workspace() {
    let (mut d, _host) = dispatcher();
    let (_ws1, pane) = create_ws(&mut d, "one");
    let (tab_a, sa) = create_terminal_tab(&mut d, pane);
    let (tab_b, _sb) = create_terminal_tab(&mut d, pane);
    create_ws(&mut d, "two"); // ws1 전체가 비가시로.
    d.apply_osc(batch(&[(sa, status_notify("mast:idle", "a"))]), 1_000);

    // 백그라운드 워크스페이스 안의 승격은 가시화가 아니다 — unread 유지.
    d.dispatch(Command::CloseTab { tab: tab_b }).unwrap();
    assert_eq!(tab_view(&d, tab_a).notification, NotificationState::Unread);
}

#[test]
fn close_workspace_fallback_clears_unread_of_newly_visible_tabs() {
    let (mut d, _host) = dispatcher();
    let (_ws1, pane) = create_ws(&mut d, "one");
    let (tab_a, sa) = create_terminal_tab(&mut d, pane);
    let (tab_b, sb) = create_terminal_tab(&mut d, pane);
    let (ws2, _pane2) = create_ws(&mut d, "two"); // ws1 비가시 상태에서 알림.
    d.apply_osc(
        batch(&[
            (sa, status_notify("mast:idle", "a")),
            (sb, status_notify("mast:idle", "b")),
        ]),
        1_000,
    );

    // active 워크스페이스를 닫으면 ws1 이 fallback 으로 드러난다 —
    // SwitchWorkspace 와 같은 규칙: active_tab(b)만 해제, 숨은 a 는 유지.
    d.dispatch(Command::CloseWorkspace { workspace: ws2 })
        .unwrap();
    assert_eq!(tab_view(&d, tab_b).notification, NotificationState::None);
    assert_eq!(tab_view(&d, tab_a).notification, NotificationState::Unread);
}

#[test]
fn close_tab_drops_the_closed_tabs_status_and_message() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (tab1, s1) = create_terminal_tab(&mut d, pane);
    create_terminal_tab(&mut d, pane);
    d.apply_osc(
        batch(&[(s1, status_notify("mast:needsInput", "approve?"))]),
        1_000,
    );

    d.dispatch(Command::CloseTab { tab: tab1 }).unwrap();
    // 메시지도 닫힌 탭과 함께 사라진다 — 남은 탭 중 알린 탭이 없다.
    assert_eq!(agent(&d, ws), (AgentStatus::Idle, None));
}

#[test]
fn close_pane_drops_agent_state_of_every_removed_tab() {
    // ClosePane 뒤 남은 탭들로 파생값을 다시 계산하지 않으면 제거된 탭의 needsInput
    // 이 사이드바에 남는다.
    let (mut d, _host) = dispatcher();
    let (ws, pane1) = create_ws(&mut d, "ws");
    let (pane2, _split) = split_empty(&mut d, pane1, SplitDirection::Vertical);
    create_terminal_tab(&mut d, pane2);
    let (_second, s2) = create_terminal_tab(&mut d, pane2);
    d.apply_osc(
        batch(&[(s2, status_notify("mast:needsInput", "approve?"))]),
        1_000,
    );
    assert_eq!(agent(&d, ws).0, AgentStatus::NeedsInput);

    d.dispatch(Command::ClosePane { pane: pane2 }).unwrap();
    assert_eq!(agent(&d, ws), (AgentStatus::Idle, None));
}

/// Windows/Linux 에서는 WSL distro 를 넘기지만, 새로 만든 네이티브 Mac workspace 는
/// 의도적으로 distro 가 없다. 두 플랫폼 계약을 모두 계속 테스트한다.
fn expected_distro(name: &str) -> Option<String> {
    if cfg!(target_os = "macos") { None } else { Some(name.to_owned()) }
}

/// distro 를 단 워크스페이스 헬퍼 — 해제 통지가 어느 배포판으로 가야 하는지
/// 검사하려면 distro 가 실려 있어야 한다.
fn create_ws_on(d: &mut Dispatcher, name: &str, distro: &str) -> (WorkspaceId, PaneId) {
    match d
        .dispatch(Command::CreateWorkspace {
            name: name.into(),
            root_path: None,
            distro: Some(distro.into()),
            tab: None,
        })
        .unwrap()
    {
        CommandOutput::WorkspaceCreated {
            workspace, pane, ..
        } => (workspace, pane),
        other => panic!("unexpected output: {other:?}"),
    }
}

/// 사이드바 순서 = `state.workspaces` 순서. 이름 목록으로 읽어야 재배치가
/// 눈에 보인다 (id 는 생성 순서라 순서 변화를 못 보여 준다).
fn order(d: &Dispatcher) -> Vec<&str> {
    d.state()
        .workspaces
        .iter()
        .map(|ws| ws.name.as_str())
        .collect()
}

#[test]
fn moving_a_workspace_puts_it_before_the_named_neighbour() {
    let (mut d, _host) = dispatcher();
    let (a, _) = create_ws(&mut d, "a");
    let (b, _) = create_ws(&mut d, "b");
    let (c, _) = create_ws(&mut d, "c");
    assert_eq!(order(&d), ["a", "b", "c"]);

    // 뒤에서 앞으로.
    d.dispatch(Command::MoveWorkspace {
        workspace: c,
        before: Some(a),
    })
    .unwrap();
    assert_eq!(order(&d), ["c", "a", "b"]);

    // 앞에서 뒤로 — 삽입 위치를 뺀 뒤의 목록에서 다시 찾지 않으면 여기서
    // 한 칸 어긋난다.
    d.dispatch(Command::MoveWorkspace {
        workspace: c,
        before: Some(b),
    })
    .unwrap();
    assert_eq!(order(&d), ["a", "c", "b"]);
}

#[test]
fn a_none_neighbour_moves_it_to_the_end() {
    let (mut d, _host) = dispatcher();
    let (a, _) = create_ws(&mut d, "a");
    create_ws(&mut d, "b");
    create_ws(&mut d, "c");

    d.dispatch(Command::MoveWorkspace {
        workspace: a,
        before: None,
    })
    .unwrap();
    assert_eq!(order(&d), ["b", "c", "a"]);
}

#[test]
fn moving_a_workspace_before_itself_changes_nothing() {
    // 제자리에 놓은 드래그 — 에러가 아니다 (variant rustdoc).
    let (mut d, _host) = dispatcher();
    let (a, _) = create_ws(&mut d, "a");
    create_ws(&mut d, "b");

    d.dispatch(Command::MoveWorkspace {
        workspace: a,
        before: Some(a),
    })
    .unwrap();
    assert_eq!(order(&d), ["a", "b"]);
}

#[test]
fn a_move_does_not_change_the_active_workspace() {
    // 정리하려고 끈 드래그가 화면까지 바꾸면 안 된다 (사용자 결정 2026-08-22).
    let (mut d, _host) = dispatcher();
    let (a, _) = create_ws(&mut d, "a");
    let (b, _) = create_ws(&mut d, "b");
    d.dispatch(Command::SwitchWorkspace { workspace: a })
        .unwrap();
    assert_eq!(d.state().active_workspace, Some(a));

    d.dispatch(Command::MoveWorkspace {
        workspace: b,
        before: Some(a),
    })
    .unwrap();
    assert_eq!(order(&d), ["b", "a"]);
    assert_eq!(d.state().active_workspace, Some(a));
}

#[test]
fn an_unknown_id_on_either_side_leaves_the_order_untouched() {
    // 낡은 스냅샷으로 사라진 이웃 앞에 놓으려 한 경우 — 인덱스 계약이었다면
    // 조용히 다른 자리로 갔을 자리다 (variant rustdoc).
    let (mut d, _host) = dispatcher();
    let (a, _) = create_ws(&mut d, "a");
    create_ws(&mut d, "b");
    let revision = d.snapshot().revision;

    assert!(matches!(
        d.dispatch(Command::MoveWorkspace {
            workspace: a,
            before: Some(WorkspaceId(999)),
        }),
        Err(CommandError::UnknownTarget { .. })
    ));
    assert!(matches!(
        d.dispatch(Command::MoveWorkspace {
            workspace: WorkspaceId(999),
            before: Some(a),
        }),
        Err(CommandError::UnknownTarget { .. })
    ));
    assert_eq!(order(&d), ["a", "b"]);
    assert_eq!(
        d.snapshot().revision,
        revision,
        "실패는 revision 도 안 올린다"
    );
}

#[test]
fn closing_a_tab_releases_its_shell_side_files() {
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws_on(&mut d, "ws", "Ubuntu");
    let (tab, _s) = create_terminal_tab(&mut d, pane);

    d.dispatch(Command::CloseTab { tab }).unwrap();

    assert_eq!(
        host.releases(),
        vec![(vec![tab], expected_distro("Ubuntu"))]
    );
}

#[test]
fn a_pane_or_workspace_releases_all_of_its_tabs_in_one_call() {
    // 배치 계약: 탭 N 개가 함께 사라져도 통지는 한 번이다. 탭마다 통지하면
    // 호스트가 정리 왕복을 N 개 동시에 띄운다 (SessionHost rustdoc).
    let (mut d, host) = dispatcher();
    let (_ws, pane1) = create_ws_on(&mut d, "ws", "Ubuntu");
    let (pane2, _split) = split_empty(&mut d, pane1, SplitDirection::Vertical);
    let (a, _sa) = create_terminal_tab(&mut d, pane2);
    let (b, _sb) = create_terminal_tab(&mut d, pane2);

    d.dispatch(Command::ClosePane { pane: pane2 }).unwrap();
    assert_eq!(host.releases(), vec![(vec![a, b], expected_distro("Ubuntu"))]);

    let (ws2, pane3) = create_ws_on(&mut d, "ws2", "Debian");
    let (c, _sc) = create_terminal_tab(&mut d, pane3);
    let (dd, _sd) = create_terminal_tab(&mut d, pane3);
    d.dispatch(Command::CloseWorkspace { workspace: ws2 })
        .unwrap();
    assert_eq!(
        host.releases().last().cloned(),
        Some((vec![c, dd], expected_distro("Debian")))
    );
}

#[test]
fn a_tab_whose_shell_exited_keeps_its_files() {
    // Exited 는 되살아나는 상태다 (ADR-0010) — 같은 탭 id 로 재시작하면 자기
    // history 를 다시 물어야 하므로 지우면 안 된다.
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws_on(&mut d, "ws", "Ubuntu");
    let (_tab, session) = create_terminal_tab(&mut d, pane);

    d.apply_event(SessionEvent::SessionExited {
        session,
        code: Some(1),
        ended_at_ms: 1_700_000_000_000,
    });

    assert!(host.releases().is_empty());
}

#[test]
fn a_terminal_tab_with_no_session_is_still_released() {
    // 세션을 잃은 탭 — 셸이 죽은 뒤 재시작마저 실패하면 `pty_session` 이
    // 비워진다 (ADR-0009). 그래도 HISTFILE 은 이미 만들어져 있으므로 세션
    // 유무로 거르면 그 파일이 영원히 남는다.
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws_on(&mut d, "ws", "Ubuntu");
    let (tab, session) = create_terminal_tab(&mut d, pane);
    d.apply_event(SessionEvent::SessionExited {
        session,
        code: Some(1),
        ended_at_ms: 1_700_000_000_000,
    });
    host.set_fail_spawn(true);
    assert!(d.respawn_tab(tab).is_err());

    d.dispatch(Command::CloseTab { tab }).unwrap();
    assert_eq!(host.releases(), vec![(vec![tab], expected_distro("Ubuntu"))]);
}

#[test]
fn closing_a_viewer_tab_releases_nothing() {
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws_on(&mut d, "ws", "Ubuntu");
    let tab = match d
        .dispatch(Command::CreateTab {
            pane,
            tab: NewTab::FolderBrowser { path: None },
        })
        .unwrap()
    {
        CommandOutput::TabCreated { tab, session: None } => tab,
        other => panic!("unexpected output: {other:?}"),
    };

    d.dispatch(Command::CloseTab { tab }).unwrap();

    assert!(host.releases().is_empty());
}

#[test]
fn session_exited_clears_the_exited_tabs_agent_state() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (_tab1, s1) = create_terminal_tab(&mut d, pane);
    let (tab2, s2) = create_terminal_tab(&mut d, pane);
    d.apply_osc(
        batch(&[(s2, status_notify("mast:needsInput", "approve?"))]),
        1_000,
    );

    // 기다리지 않던 탭의 종료는 워크스페이스를 건드리지 않는다.
    d.apply_event(SessionEvent::SessionExited {
        session: s1,
        code: Some(0),
        ended_at_ms: 1_700_000_000_000,
    });
    assert_eq!(agent(&d, ws), (AgentStatus::NeedsInput, msg("approve?")));

    // 기다리던 탭의 종료는 그 탭과 파생값을 함께 비운다.
    let rev = d.state().revision;
    d.apply_event(SessionEvent::SessionExited {
        session: s2,
        code: Some(0),
        ended_at_ms: 1_700_000_000_000,
    });
    assert_eq!(tab_agent(&d, tab2), (AgentStatus::Idle, None));
    assert_eq!(agent(&d, ws), (AgentStatus::Idle, None));
    assert_eq!(d.state().revision, rev + 1);
}

#[test]
fn apply_osc_bumps_revision_once_per_batch() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (_tab1, s1) = create_terminal_tab(&mut d, pane);
    let (_tab2, s2) = create_terminal_tab(&mut d, pane);
    let rev = d.state().revision;

    // 두 세션 × 여러 이벤트가 한 배치에 모여도 revision 은 1회만 오른다.
    assert!(d.apply_osc(
        batch(&[
            (s1, OscEvent::Osc0Title("a".into())),
            (s1, status_notify("mast:running", "one")),
            (s2, OscEvent::Osc0Title("b".into())),
            (s2, status_notify("mast:idle", "two")),
        ]),
        1_000,
    ));
    assert_eq!(d.state().revision, rev + 1);

    // 바뀔 것이 없는 배치는 false — 글루가 스냅샷 발행을 건너뛴다. 반복은 미리보기에
    // 이미 오른 탭(동률로 이긴 s1)의 것이어야 한다: 다른 탭의 반복 알림은 그 탭을
    // 최신으로 올려 미리보기를 실제로 바꾼다.
    assert!(!d.apply_osc(
        batch(&[
            (s1, OscEvent::Osc0Title("a".into())),
            (s1, status_notify("mast:running", "one")),
        ]),
        1_000,
    ));
    assert_eq!(d.state().revision, rev + 1);
}

#[test]
fn an_idle_from_the_tab_that_waited_does_not_mask_another_tabs_running() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (_a, sa) = create_terminal_tab(&mut d, pane);
    let (_b, sb) = create_terminal_tab(&mut d, pane);
    d.apply_osc(batch(&[(sa, status_notify("mast:needsInput", ""))]), 1_000);
    d.apply_osc(batch(&[(sb, status_notify("mast:running", ""))]), 2_000);
    d.apply_osc(batch(&[(sa, status_notify("mast:idle", ""))]), 3_000);
    assert_eq!(agent(&d, ws).0, AgentStatus::Running);
}

#[test]
fn another_tabs_idle_does_not_mask_running() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (_a, sa) = create_terminal_tab(&mut d, pane);
    let (_b, sb) = create_terminal_tab(&mut d, pane);
    d.apply_osc(batch(&[(sa, status_notify("mast:running", ""))]), 1_000);
    d.apply_osc(batch(&[(sb, status_notify("mast:idle", "done"))]), 2_000);
    assert_eq!(agent(&d, ws).0, AgentStatus::Running);
}

#[test]
fn one_tab_leaving_needs_input_keeps_the_other_waiting_tab() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (a, sa) = create_terminal_tab(&mut d, pane);
    let (b, sb) = create_terminal_tab(&mut d, pane);
    d.apply_osc(
        batch(&[(sa, status_notify("mast:needsInput", "approve A?"))]),
        1_000,
    );
    d.apply_osc(
        batch(&[(sb, status_notify("mast:needsInput", "approve B?"))]),
        2_000,
    );
    // A 의 running 문구가 가장 최근이어도 미리보기는 기다리는 탭(B)의 것이다.
    d.apply_osc(
        batch(&[(sa, status_notify("mast:running", "working"))]),
        3_000,
    );
    assert_eq!(tab_agent(&d, a), (AgentStatus::Running, msg("working")));
    assert_eq!(
        tab_agent(&d, b),
        (AgentStatus::NeedsInput, msg("approve B?"))
    );
    assert_eq!(agent(&d, ws), (AgentStatus::NeedsInput, msg("approve B?")));
}

#[test]
fn removing_the_waiting_tab_keeps_another_tabs_running() {
    enum Removal {
        CloseTab,
        ClosePane,
        SessionExited,
    }
    for removal in [Removal::CloseTab, Removal::ClosePane, Removal::SessionExited] {
        let (mut d, _host) = dispatcher();
        let (ws, pane1) = create_ws(&mut d, "ws");
        let (_b, sb) = create_terminal_tab(&mut d, pane1);
        let (pane2, _split) = split_empty(&mut d, pane1, SplitDirection::Vertical);
        let (a, sa) = create_terminal_tab(&mut d, pane2);
        d.apply_osc(
            batch(&[
                (sb, status_notify("mast:running", "building")),
                (sa, status_notify("mast:needsInput", "approve?")),
            ]),
            1_000,
        );
        assert_eq!(agent(&d, ws).0, AgentStatus::NeedsInput);

        let label = match removal {
            Removal::CloseTab => {
                d.dispatch(Command::CloseTab { tab: a }).unwrap();
                "CloseTab"
            }
            Removal::ClosePane => {
                d.dispatch(Command::ClosePane { pane: pane2 }).unwrap();
                "ClosePane"
            }
            Removal::SessionExited => {
                d.apply_event(SessionEvent::SessionExited {
                    session: sa,
                    code: Some(0),
                    ended_at_ms: 1_700_000_000_000,
                });
                "SessionExited"
            }
        };
        assert_eq!(
            agent(&d, ws),
            (AgentStatus::Running, msg("building")),
            "{label}"
        );
    }
}

#[test]
fn workspace_message_prefers_the_most_urgent_tab_over_a_newer_idle() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (_a, sa) = create_terminal_tab(&mut d, pane);
    let (_b, sb) = create_terminal_tab(&mut d, pane);
    d.apply_osc(
        batch(&[(sa, status_notify("mast:needsInput", "approve?"))]),
        1_000,
    );
    d.apply_osc(batch(&[(sb, status_notify("mast:idle", "done"))]), 2_000);
    assert_eq!(agent(&d, ws), (AgentStatus::NeedsInput, msg("approve?")));
}

#[test]
fn workspace_message_follows_arrival_order_not_tab_order_or_clock() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (a, sa) = create_terminal_tab(&mut d, pane);
    let (b, sb) = create_terminal_tab(&mut d, pane);
    assert!(a < b);
    // 늦게 온 쪽이 TabId 도 크고 벽시계도 뒤로 갔다 — 둘 중 하나로 고르면 a 가 이긴다.
    d.apply_osc(batch(&[(sa, status_notify("mast:idle", "a done"))]), 2_000);
    d.apply_osc(batch(&[(sb, status_notify("mast:idle", "b done"))]), 1_000);
    assert_eq!(agent(&d, ws), (AgentStatus::Idle, msg("b done")));

    // 한 배치 안의 동률은 작은 TabId 가 이긴다.
    d.apply_osc(
        batch(&[
            (sb, status_notify("mast:idle", "b again")),
            (sa, status_notify("mast:idle", "a again")),
        ]),
        3_000,
    );
    assert_eq!(agent(&d, ws), (AgentStatus::Idle, msg("a again")));
}

#[test]
fn a_repeated_message_makes_its_tab_the_newest() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (_a, sa) = create_terminal_tab(&mut d, pane);
    let (_b, sb) = create_terminal_tab(&mut d, pane);
    d.apply_osc(batch(&[(sa, status_notify("mast:idle", "done"))]), 1_000);
    d.apply_osc(batch(&[(sb, status_notify("mast:idle", "b done"))]), 2_000);
    assert_eq!(agent(&d, ws).1, msg("b done"));

    // 문구가 탭에 이미 있던 것과 같아도 도착 시각은 갱신된다.
    let rev = d.state().revision;
    assert!(d.apply_osc(batch(&[(sa, status_notify("mast:idle", "done"))]), 3_000));
    assert_eq!(agent(&d, ws), (AgentStatus::Idle, msg("done")));
    assert_eq!(d.state().revision, rev + 1);
}

#[test]
fn a_running_workspace_previews_a_message_from_a_tab_that_is_not_running() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (_a, sa) = create_terminal_tab(&mut d, pane);
    let (_b, sb) = create_terminal_tab(&mut d, pane);
    d.apply_osc(batch(&[(sb, status_notify("mast:idle", "done"))]), 1_000);
    d.apply_osc(batch(&[(sa, status_notify("mast:running", ""))]), 2_000);
    assert_eq!(agent(&d, ws), (AgentStatus::Running, msg("done")));
}

#[test]
fn a_running_tabs_stale_message_does_not_hide_a_newer_one() {
    // 실제 훅 순서: needsInput 에 본문, idle 에 본문, running 은 본문이 없어 A 의
    // 이전 문구가 탭에 그대로 남는다.
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (a, sa) = create_terminal_tab(&mut d, pane);
    let (_b, sb) = create_terminal_tab(&mut d, pane);
    d.apply_osc(
        batch(&[(sa, status_notify("mast:needsInput", "Claude is waiting"))]),
        1_000,
    );
    d.apply_osc(batch(&[(sb, status_notify("mast:idle", "done"))]), 2_000);
    d.apply_osc(batch(&[(sa, status_notify("mast:running", ""))]), 3_000);
    assert_eq!(
        tab_agent(&d, a),
        (AgentStatus::Running, msg("Claude is waiting"))
    );
    assert_eq!(agent(&d, ws), (AgentStatus::Running, msg("done")));
}

#[test]
fn a_needs_input_workspace_never_borrows_another_tabs_message() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (_a, sa) = create_terminal_tab(&mut d, pane);
    let (_b, sb) = create_terminal_tab(&mut d, pane);
    d.apply_osc(batch(&[(sb, status_notify("mast:idle", "done"))]), 1_000);
    d.apply_osc(batch(&[(sa, status_notify("mast:needsInput", ""))]), 2_000);
    assert_eq!(agent(&d, ws), (AgentStatus::NeedsInput, None));
}

#[test]
fn a_status_neutral_message_counts_when_it_is_the_newest() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (_a, sa) = create_terminal_tab(&mut d, pane);
    let (b, sb) = create_terminal_tab(&mut d, pane);
    d.apply_osc(batch(&[(sa, status_notify("mast:idle", "done"))]), 1_000);
    // 이미 Idle 인 탭에서는 상태 중립 알림이 Idle 을 주장해도 드러나지 않는다.
    d.apply_osc(batch(&[(sb, status_notify("mast:running", ""))]), 2_000);

    d.apply_osc(
        batch(&[(sb, OscEvent::Osc9Notify("build finished".into()))]),
        3_000,
    );
    assert_eq!(
        tab_agent(&d, b),
        (AgentStatus::Running, msg("build finished"))
    );
    assert_eq!(agent(&d, ws), (AgentStatus::Running, msg("build finished")));

    d.apply_osc(
        batch(&[(sb, status_notify("not-a-token", "heads up"))]),
        4_000,
    );
    assert_eq!(tab_agent(&d, b), (AgentStatus::Running, msg("heads up")));
    assert_eq!(agent(&d, ws), (AgentStatus::Running, msg("heads up")));
}

#[test]
fn startup_timeout_keeps_the_tabs_agent_state() {
    let (mut d, _host) = dispatcher();
    let (ws, pane) = create_ws(&mut d, "ws");
    let (tab, session) = create_terminal_tab(&mut d, pane);
    d.apply_osc(
        batch(&[(session, status_notify("mast:needsInput", "approve?"))]),
        1_000,
    );
    d.apply_event(SessionEvent::SessionStartupTimeout { session });
    assert_eq!(terminal_of(&d, tab).0, TerminalStatus::NotStarted);
    assert_eq!(
        tab_agent(&d, tab),
        (AgentStatus::NeedsInput, msg("approve?"))
    );
    assert_eq!(agent(&d, ws), (AgentStatus::NeedsInput, msg("approve?")));
}

#[test]
fn snapshot_fixture_workspace_agent_fields_match_their_tabs() {
    // tests/dispatcher.rs 의 round-trip 은 파생 규칙을 볼 수 없다
    // (recompute_agent_summary 가 크레이트 밖에 보이지 않는다).
    #[derive(serde::Deserialize)]
    struct Snapshot {
        state: AppState,
    }
    let snapshot: Snapshot =
        serde_json::from_str(include_str!("../../../../fixtures/stage10-snapshot.json")).unwrap();
    for ws in &snapshot.state.workspaces {
        let mut recomputed = ws.clone();
        assert!(
            !recompute_agent_summary(&mut recomputed),
            "workspace {:?} 의 파생값이 탭과 어긋남",
            ws.id
        );
        assert_eq!(&recomputed, ws);
    }
    assert!(
        snapshot
            .state
            .workspaces
            .iter()
            .any(|ws| ws.agent_status == AgentStatus::NeedsInput),
        "fixture 가 탭 needsInput → 워크스페이스 파생의 예시를 싣고 있어야 한다"
    );
}

/// pty_session 없는 터미널 탭 값 — persist sanitize 직후 형태.
fn sessionless_tab(id: u64, status: TerminalStatus, cwd: Option<&str>) -> Tab {
    Tab {
        id: TabId(id),
        title: format!("tab-{id}"),
        kind: TabKind::Terminal {
            pty_session: None,
            status,
            cwd: cwd.map(String::from),
        },
        notification: NotificationState::None,
        last_activity_ms: None,
        agent_status: AgentStatus::Idle,
        last_agent_message: None,
        last_agent_message_seq: None,
    }
}

/// 복원 직후(sanitize 완료) 모양의 상태 — ws 1, split 4 아래 pane 2·3.
/// pane 2: tab 5 (Running, cwd 없음 → root_path 상속 대상).
/// pane 3: tab 6 (Running, cwd /custom), tab 7 (Exited — 부팅 열거 비대상,
/// Restart 경로로는 되살아난다).
/// next_id 8, revision 3.
fn adopted_state() -> AppState {
    AppState {
        workspaces: vec![Workspace {
            id: WorkspaceId(1),
            name: "restored".into(),
            root_path: Some("/root".into()),
            distro: Some("Ubuntu".into()),
            git_branch: None,
            git_dirty: None,
            layout: SplitTree::Split {
                id: SplitId(4),
                direction: SplitDirection::Horizontal,
                ratio: 0.5,
                first: Box::new(SplitTree::Leaf { pane: PaneId(2) }),
                second: Box::new(SplitTree::Leaf { pane: PaneId(3) }),
            },
            panes: [
                (
                    PaneId(2),
                    Pane {
                        id: PaneId(2),
                        tabs: vec![sessionless_tab(5, TerminalStatus::Running, None)],
                        active_tab: Some(TabId(5)),
                    },
                ),
                (
                    PaneId(3),
                    Pane {
                        id: PaneId(3),
                        tabs: vec![
                            sessionless_tab(6, TerminalStatus::Running, Some("/custom")),
                            sessionless_tab(
                                7,
                                TerminalStatus::Exited {
                                    code: Some(1),
                                    ended_at_ms: Some(1_700_000_000_000),
                                },
                                None,
                            ),
                        ],
                        active_tab: Some(TabId(6)),
                    },
                ),
            ]
            .into(),
            active_pane: PaneId(2),
            agent_status: AgentStatus::Idle,
            last_agent_message: None,
        }],
        active_workspace: Some(WorkspaceId(1)),
        next_id: 8,
        revision: 3,
    }
}

fn adopted_dispatcher() -> (Dispatcher, FakeSessionHost) {
    let host = FakeSessionHost::default();
    (
        Dispatcher::adopt(adopted_state(), Box::new(host.clone())),
        host,
    )
}

/// `tab.kind` 의 (pty_session, status) 를 읽는 관측 헬퍼.
fn terminal_kind(d: &Dispatcher, pane: PaneId, ti: usize) -> (Option<SessionId>, TerminalStatus) {
    let TabKind::Terminal {
        pty_session,
        status,
        ..
    } = &d.state().workspaces[0].panes[&pane].tabs[ti].kind
    else {
        panic!("terminal 탭이어야 함");
    };
    (*pty_session, *status)
}

#[test]
fn adopt_takes_state_without_spawning() {
    let (d, host) = adopted_dispatcher();
    // 채택만 — 스폰·kill 부수효과 전혀 없음, 상태 원본 그대로.
    assert!(host.spawns().is_empty());
    assert!(host.kills().is_empty());
    assert_eq!(*d.state(), adopted_state());
}

#[test]
fn running_terminal_tabs_lists_only_sessionless_running() {
    let (mut d, _host) = adopted_dispatcher();
    // Exited 탭(7)은 제외 — Running·pty_session None 인 5·6 만.
    assert_eq!(d.running_terminal_tabs(), vec![TabId(5), TabId(6)]);
    // 재스폰돼 세션이 채워진 탭은 열거에서 빠진다.
    d.respawn_tab(TabId(5)).unwrap();
    assert_eq!(d.running_terminal_tabs(), vec![TabId(6)]);
}

#[test]
fn tab_of_session_names_the_adopting_tab_only() {
    let (mut d, _host) = adopted_dispatcher();
    let s5 = d.respawn_tab(TabId(5)).unwrap();
    assert_eq!(d.tab_of_session(s5), Some(TabId(5)));
    // 모델이 실은 적 없는 세션 id — 글루의 exit 경로는 이 답으로 "채택되지 않은
    // 스폰" 을 가려낸다.
    assert_eq!(d.tab_of_session(s5 + 1), None);
    // 탭이 세션을 놓으면(exit) 그 id 는 더 이상 어느 탭의 것도 아니다.
    d.apply_event(SessionEvent::SessionExited {
        session: s5,
        code: Some(0),
        ended_at_ms: 1,
    });
    assert_eq!(d.tab_of_session(s5), None);
}

#[test]
fn respawn_fills_session_and_bumps_revision() {
    let (mut d, host) = adopted_dispatcher();
    let s5 = d.respawn_tab(TabId(5)).unwrap();
    let s6 = d.respawn_tab(TabId(6)).unwrap();
    assert_eq!((s5, s6), (1, 2));
    assert_eq!(
        terminal_kind(&d, PaneId(2), 0),
        (Some(s5), TerminalStatus::Running)
    );
    assert_eq!(
        terminal_kind(&d, PaneId(3), 0),
        (Some(s6), TerminalStatus::Running)
    );
    // 회당 revision += 1 (스냅샷 전파) — adopted revision 3 에서 시작.
    assert_eq!(d.state().revision, 5);

    // 스폰 파라미터: cwd = 탭 cwd(없으면 root_path), distro = ws 기본, 80×24,
    // history_tab = 재스폰 대상 탭의 id (재시작 전과 같은 history 파일).
    let spawns = host.spawns();
    assert_eq!(
        spawns[0],
        ShellSpawnReq {
            cwd: Some("/root".into()),
            distro: Some("Ubuntu".into()),
            cols: 80,
            rows: 24,
            history_tab: Some(5),
        }
    );
    assert_eq!(spawns[1].cwd.as_deref(), Some("/custom"));
    // 탭에 기록된 cwd 는 재스폰이 바꾸지 않는다 (생성 시점 값 보존).
    let TabKind::Terminal { cwd, .. } = &d.state().workspaces[0].panes[&PaneId(2)].tabs[0].kind
    else {
        panic!("terminal 탭이어야 함");
    };
    assert_eq!(*cwd, None);
}

/// 재스폰은 탭 id 를 그대로 history 키로 쓴다 — 재시작 후에도 같은 탭이 같은
/// history 파일을 물게 하는 것이 탭별 history 의 요점이다 (체크포인트 2 UX).
#[test]
fn respawn_carries_history_tab_of_the_same_tab() {
    let (mut d, host) = adopted_dispatcher();
    d.respawn_tab(TabId(5)).unwrap();
    d.respawn_tab(TabId(6)).unwrap();
    let history: Vec<Option<u64>> = host.spawns().iter().map(|r| r.history_tab).collect();
    assert_eq!(history, vec![Some(TabId(5).0), Some(TabId(6).0)]);
}

#[test]
fn respawn_failure_demotes_tab_to_exited() {
    let (mut d, host) = adopted_dispatcher();
    host.set_fail_spawn(true);
    let err = d.respawn_tab(TabId(5)).unwrap_err();
    assert!(matches!(err, CommandError::SpawnFailed { .. }), "{err:?}");
    // 강등이 설계된 결과 상태 — pty_session 은 None 유지, revision 반영.
    assert_eq!(
        terminal_kind(&d, PaneId(2), 0),
        (
            None,
            TerminalStatus::Exited {
                code: None,
                ended_at_ms: None
            }
        )
    );
    assert_eq!(d.state().revision, 4);
    // 강등된 탭도 다시 시도할 수 있다 (ADR-0010 — pane 배너의 Restart).
    host.set_fail_spawn(false);
    let s5 = d.respawn_tab(TabId(5)).unwrap();
    assert_eq!(
        terminal_kind(&d, PaneId(2), 0),
        (Some(s5), TerminalStatus::Running)
    );
    // 부팅 열거는 여전히 세션 없는 Running 탭만 — 방금 살아난 탭은 빠진다.
    assert_eq!(d.running_terminal_tabs(), vec![TabId(6)]);
}

/// 실패한 재스폰은 **그 셸의 종료 정보를 지우지 않는다** (ADR-0018). 기록 파일은
/// 실패 시 남으므로 pane 에는 여전히 그 셸의 마지막 화면이 서 있고, 배너가 code·시각을
/// 잃으면 화면과 다른 이야기를 하게 된다.
#[test]
fn respawn_failure_keeps_the_exit_an_exited_tab_already_had() {
    let (mut d, host) = adopted_dispatcher();
    let s5 = d.respawn_tab(TabId(5)).unwrap();
    d.apply_event(SessionEvent::SessionExited {
        session: s5,
        code: Some(137),
        ended_at_ms: 1_700_000_000_000,
    });

    host.set_fail_spawn(true);
    let err = d.respawn_tab(TabId(5)).unwrap_err();
    assert!(matches!(err, CommandError::SpawnFailed { .. }), "{err:?}");
    assert_eq!(
        terminal_kind(&d, PaneId(2), 0),
        (
            None,
            TerminalStatus::Exited {
                code: Some(137),
                ended_at_ms: Some(1_700_000_000_000)
            }
        )
    );
}

/// 시작 표식을 못 낸 채 에이전트 알림을 남긴 탭 — 재시도 대상(NotStarted)이면서 세션을
/// 문 채 탭 상태가 살아 있는 형태다.
fn not_started_tab_waiting_for_input(d: &mut Dispatcher) -> SessionId {
    let s5 = d.respawn_tab(TabId(5)).unwrap();
    d.apply_osc(
        batch(&[(s5, status_notify("mast:needsInput", "approve?"))]),
        1_000,
    );
    d.apply_event(SessionEvent::SessionStartupTimeout { session: s5 });
    assert_eq!(
        agent(d, WorkspaceId(1)),
        (AgentStatus::NeedsInput, msg("approve?"))
    );
    s5
}

#[test]
fn respawn_failure_clears_the_tabs_agent_state() {
    let (mut d, host) = adopted_dispatcher();
    not_started_tab_waiting_for_input(&mut d);

    host.set_fail_spawn(true);
    d.respawn_tab(TabId(5)).unwrap_err();
    assert!(matches!(
        terminal_kind(&d, PaneId(2), 0).1,
        TerminalStatus::Exited { .. }
    ));
    assert_eq!(tab_agent(&d, TabId(5)), (AgentStatus::Idle, None));
    assert_eq!(agent(&d, WorkspaceId(1)), (AgentStatus::Idle, None));
}

#[test]
fn respawn_does_not_carry_the_previous_sessions_agent_state() {
    let (mut d, host) = adopted_dispatcher();
    let old = not_started_tab_waiting_for_input(&mut d);

    let revived = d.respawn_tab(TabId(5)).unwrap();
    assert_eq!(host.kills(), vec![old]);
    assert_eq!(
        terminal_kind(&d, PaneId(2), 0),
        (Some(revived), TerminalStatus::Running)
    );
    assert_eq!(tab_agent(&d, TabId(5)), (AgentStatus::Idle, None));
    assert_eq!(tab_view(&d, TabId(5)).last_agent_message_seq, None);
    assert_eq!(agent(&d, WorkspaceId(1)), (AgentStatus::Idle, None));
}

/// 실행 중 죽은 탭을 되살리는 경로 (ADR-0010). 정상 경로로 온 Exited 탭은 세션을
/// 이미 놓았으므로(ADR-0018) 정리할 대상이 없고, **같은 탭 id** 로 다시 스폰해
/// HISTFILE·resume 힌트를 그대로 물린다 — ↑ 한 번으로 죽은 에이전트 세션을 resume
/// 하는 것이 요점이다. 세션 id 를 문 채 Exited 인 형태는 아래
/// `respawn_kills_a_stale_session_an_exited_tab_still_holds` 가 잠근다.
#[test]
fn respawn_revives_a_tab_that_died_at_runtime() {
    let (mut d, host) = adopted_dispatcher();
    let s5 = d.respawn_tab(TabId(5)).unwrap();
    // 셸이 강제 종료됐다 (실기: PC 절전으로 WSL 이 통째로 내려간 경우의 코드).
    d.apply_event(SessionEvent::SessionExited {
        session: s5,
        code: Some(1_073_807_364),
        ended_at_ms: 1_700_000_000_000,
    });
    assert_eq!(
        terminal_kind(&d, PaneId(2), 0),
        (
            None,
            TerminalStatus::Exited {
                code: Some(1_073_807_364),
                ended_at_ms: Some(1_700_000_000_000)
            }
        ),
        "죽은 세션은 탭이 놓는다 — 마지막 화면은 기록 파일에 있다"
    );

    let revived = d.respawn_tab(TabId(5)).unwrap();
    assert_ne!(revived, s5);
    assert_eq!(
        terminal_kind(&d, PaneId(2), 0),
        (Some(revived), TerminalStatus::Running)
    );
    assert!(host.kills().is_empty(), "정리할 세션이 남아 있지 않다");
    assert_eq!(host.spawns().last().unwrap().history_tab, Some(TabId(5).0));
}

/// 방어 경로 — `SessionExited` 를 거치지 않고 세션 id 를 문 채 `Exited` 가 된 탭
/// (낡은 스냅샷·글루의 정합성 수리 전). 그 id 는 먼저 kill 로 정리해야 이후
/// attach 가 옛 id 로 새지 않는다.
#[test]
fn respawn_kills_a_stale_session_an_exited_tab_still_holds() {
    let (mut d, host) = adopted_dispatcher();
    let s5 = d.respawn_tab(TabId(5)).unwrap();
    force_exited_with_session(&mut d, TabId(5), s5);

    let revived = d.respawn_tab(TabId(5)).unwrap();
    assert_ne!(revived, s5);
    assert_eq!(host.kills(), vec![s5]);
    assert_eq!(
        terminal_kind(&d, PaneId(2), 0),
        (Some(revived), TerminalStatus::Running)
    );
}

/// `SessionExited` 로는 만들 수 없는 형태(Exited + 세션 id 유지)를 직접 세운다.
fn force_exited_with_session(d: &mut Dispatcher, tab: TabId, session: SessionId) {
    // 같은 모듈의 테스트라 비공개 상태에 직접 닿는다.
    for ws in &mut d.state.workspaces {
        for pane in ws.panes.values_mut() {
            for t in &mut pane.tabs {
                if t.id == tab {
                    t.kind = TabKind::Terminal {
                        pty_session: Some(session),
                        status: TerminalStatus::Exited {
                            code: Some(1),
                            ended_at_ms: Some(1_700_000_000_000),
                        },
                        cwd: None,
                    };
                }
            }
        }
    }
}

/// 디스크에서 온 `Exited` 탭(세션 id 없음)도 되살아난다 — 복원은 이제 그 상태를
/// 그대로 두므로(ADR-0018 D3) 이것이 재시작 후 Restart 가 타는 정상 경로다.
#[test]
fn respawn_revives_a_stored_exited_tab_without_a_session() {
    let (mut d, host) = adopted_dispatcher();
    let s7 = d.respawn_tab(TabId(7)).unwrap();
    assert_eq!(
        terminal_kind(&d, PaneId(3), 1),
        (Some(s7), TerminalStatus::Running)
    );
    // 정리할 세션이 없으므로 kill 은 일어나지 않는다.
    assert!(host.kills().is_empty());
    assert_eq!(host.spawns().last().unwrap().history_tab, Some(TabId(7).0));
}

#[test]
fn respawn_rejects_ineligible_targets_without_state_change() {
    let (mut d, host) = adopted_dispatcher();
    let s5 = d.respawn_tab(TabId(5)).unwrap();
    let before = serde_json::to_value(d.state()).unwrap();
    // 부적합 2종: 이미 세션 있는 Running 탭 / 미지 id — 둘 다 UnknownTarget
    // 에러이고 상태·revision 불변 (부적합 호출 = 프로그램 결함). Exited 탭은
    // ADR-0010 이후 부적합이 아니다 (아래 respawn_revives_* 참조).
    for tab in [TabId(5), TabId(99)] {
        let err = d.respawn_tab(tab).unwrap_err();
        assert!(
            matches!(err, CommandError::UnknownTarget { .. }),
            "tab {tab:?} → {err:?}"
        );
        assert_eq!(
            serde_json::to_value(d.state()).unwrap(),
            before,
            "tab {tab:?} 가 상태를 바꿈"
        );
    }
    // 성공한 첫 재스폰 외에 스폰이 더 일어나지 않았다.
    assert_eq!(host.spawns().len(), 1);
    assert_eq!(
        terminal_kind(&d, PaneId(2), 0),
        (Some(s5), TerminalStatus::Running)
    );
}

#[test]
fn adopt_preserves_id_continuity_for_later_dispatch() {
    let (mut d, _host) = adopted_dispatcher();
    d.respawn_tab(TabId(5)).unwrap();
    d.respawn_tab(TabId(6)).unwrap();
    // adopt 된 next_id(8)에서 발급이 이어진다 — 복원 후 생성이 기존 id 와
    // 충돌하지 않는다 (dispatch 가 debug 불변식 검사도 수행).
    let (tab, _session) = create_terminal_tab(&mut d, PaneId(2));
    assert_eq!(tab, TabId(8));
    assert_eq!(d.state().next_id, 9);
}

// ---- pane 간 전송 대상 해석 (에이전트 채널) ----

/// 탭 제목을 대상 탭이 스스로 정한 것처럼 세운다 (OSC 0 경로).
fn set_title(d: &mut Dispatcher, session: SessionId, title: &str) {
    d.apply_osc(
        batch(&[(session, OscEvent::Osc0Title(title.into()))]),
        1_000,
    );
}

#[test]
fn resolve_send_target_matches_title_substring_case_insensitively() {
    let (mut d, _host) = dispatcher();
    let (_ws1, pane1) = create_ws(&mut d, "one");
    let (_sender_tab, sender) = create_terminal_tab(&mut d, pane1);
    let (_tab_build, s_build) = create_terminal_tab(&mut d, pane1);
    set_title(&mut d, sender, "claude");
    set_title(&mut d, s_build, "Build Shell");

    // 부분일치 + 대소문자 무시.
    assert_eq!(d.resolve_send_target(sender, "build"), Ok(s_build));
    assert_eq!(d.resolve_send_target(sender, "UILD SH"), Ok(s_build));
    assert_eq!(d.resolve_send_target(sender, "Build Shell"), Ok(s_build));
}

/// 격리 반증 (사용자 결정 2026-08-11): 제목이 정확히 일치해도 다른 워크스페이스의
/// 탭에는 닿지 않는다. 예전 계약("전 워크스페이스 도달")을 뒤집은 테스트다.
#[test]
fn resolve_send_target_is_confined_to_the_senders_workspace() {
    let (mut d, _host) = dispatcher();
    let (_ws1, pane1) = create_ws(&mut d, "one");
    let (_sender_tab, sender) = create_terminal_tab(&mut d, pane1);
    // 두 번째 워크스페이스가 active 가 되므로 첫 워크스페이스가 백그라운드다.
    let (_ws2, pane2) = create_ws(&mut d, "two");
    let (_other_tab, other) = create_terminal_tab(&mut d, pane2);
    set_title(&mut d, sender, "claude");
    set_title(&mut d, other, "agent zero");

    // 백그라운드 → active, active → 백그라운드 어느 방향도 경계를 넘지 못한다.
    assert_eq!(
        d.resolve_send_target(sender, "agent"),
        Err(SendTargetError::NoMatch)
    );
    assert_eq!(
        d.resolve_send_target(other, "claude"),
        Err(SendTargetError::NoMatch)
    );

    // 회귀 대조군: 같은 워크스페이스 안에서는 (그 워크스페이스가 백그라운드여도)
    // 그대로 도달한다 — 좁아진 것은 반경뿐이다.
    let (_peer_tab, peer) = create_terminal_tab(&mut d, pane1);
    set_title(&mut d, peer, "agent one");
    assert_eq!(d.resolve_send_target(sender, "agent"), Ok(peer));
}

/// 송신자 세션이 어느 탭에도 없으면(이론상 불가) 경계를 정할 수 없다 — 조용히
/// 전 워크스페이스로 넓어지지 않고 NoMatch·빈 목록으로 닫힌다.
#[test]
fn agent_channel_closes_for_a_session_that_belongs_to_no_tab() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (target_tab, _target) = create_terminal_tab(&mut d, pane);
    let ghost: SessionId = 9_999;

    assert_eq!(
        d.resolve_send_target(ghost, "terminal"),
        Err(SendTargetError::NoMatch)
    );
    assert_eq!(
        d.resolve_send_target(ghost, &format!("#{}", target_tab.0)),
        Err(SendTargetError::NoMatch)
    );
    assert!(d.list_tabs(ghost).is_empty());
}

#[test]
fn resolve_send_target_excludes_the_sender() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (_t1, sender) = create_terminal_tab(&mut d, pane);
    let (_t2, twin) = create_terminal_tab(&mut d, pane);
    // 제목이 같은 두 탭 — 송신자를 뺀 나머지가 하나뿐이라 모호하지 않다.
    set_title(&mut d, sender, "twin");
    set_title(&mut d, twin, "twin");
    assert_eq!(d.resolve_send_target(sender, "twin"), Ok(twin));
    assert_eq!(d.resolve_send_target(twin, "twin"), Ok(sender));
}

#[test]
fn resolve_send_target_rejects_no_match_and_ambiguity() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (_t1, sender) = create_terminal_tab(&mut d, pane);
    let (_t2, _a) = create_terminal_tab(&mut d, pane);
    let (_t3, _b) = create_terminal_tab(&mut d, pane);
    set_title(&mut d, sender, "claude");

    assert_eq!(
        d.resolve_send_target(sender, "nope"),
        Err(SendTargetError::NoMatch)
    );
    // 갓 만든 탭의 기본 제목은 둘 다 "Terminal" — 첫 매치를 고르지 않는다.
    assert_eq!(
        d.resolve_send_target(sender, "terminal"),
        Err(SendTargetError::Ambiguous { count: 2 })
    );
}

#[test]
fn resolve_send_target_skips_exited_and_viewer_tabs() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (_t1, sender) = create_terminal_tab(&mut d, pane);
    let (_t2, dead) = create_terminal_tab(&mut d, pane);
    set_title(&mut d, sender, "claude");
    set_title(&mut d, dead, "build");
    // 뷰어 탭의 제목도 "build" 로 겹치게 만든다 (경로 마지막 조각이 제목).
    create_viewer_tab(
        &mut d,
        pane,
        NewTab::FolderBrowser {
            path: Some("/home/u/build".into()),
        },
    );

    // 아직 살아 있는 동안은 유일 매치.
    assert_eq!(d.resolve_send_target(sender, "build"), Ok(dead));

    // 세션이 죽으면 후보에서 빠진다 — 쓸 stdin 이 없다. 뷰어 탭은 제목이
    // 일치해도 애초에 후보가 아니므로 남는 매치는 0건이다.
    d.apply_event(SessionEvent::SessionExited {
        session: dead,
        code: Some(0),
        ended_at_ms: 1_700_000_000_000,
    });
    assert_eq!(
        d.resolve_send_target(sender, "build"),
        Err(SendTargetError::NoMatch)
    );
}

#[test]
fn resolve_send_target_is_a_pure_query() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (_t1, sender) = create_terminal_tab(&mut d, pane);
    let (_t2, other) = create_terminal_tab(&mut d, pane);
    set_title(&mut d, other, "build");
    let before = serde_json::to_value(d.state()).unwrap();

    // 성공·NoMatch·Ambiguous 어느 경로도 상태·revision 을 건드리지 않는다.
    assert_eq!(d.resolve_send_target(sender, "build"), Ok(other));
    assert_eq!(
        d.resolve_send_target(sender, "nope"),
        Err(SendTargetError::NoMatch)
    );
    assert_eq!(
        d.resolve_send_target(sender, ""),
        Ok(other),
        "빈 대상은 후보가 하나뿐일 때만 전달된다"
    );
    assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
}

// ---- id 주소지정 (`#<탭 id>`) ----

/// 격리 반증: 안정 ID 가 전역 유일하다는 사실은 주소의 성질이지 경계를 뚫는
/// 열쇠가 아니다 — 다른 워크스페이스의 `#id` 는 "없는 id" 와 같은 취급이다.
#[test]
fn resolve_send_target_by_tab_id_stops_at_the_workspace_boundary() {
    let (mut d, _host) = dispatcher();
    let (_ws1, pane1) = create_ws(&mut d, "one");
    let (_sender_tab, sender) = create_terminal_tab(&mut d, pane1);
    let (peer_tab, peer) = create_terminal_tab(&mut d, pane1);
    let (_decoy_tab, _decoy) = create_terminal_tab(&mut d, pane1);
    // 두 번째 워크스페이스가 active 가 되므로 첫 워크스페이스는 백그라운드다.
    let (_ws2, pane2) = create_ws(&mut d, "two");
    let (other_tab, _other) = create_terminal_tab(&mut d, pane2);

    assert_eq!(
        d.resolve_send_target(sender, &format!("#{}", other_tab.0)),
        Err(SendTargetError::NoMatch)
    );
    // 회귀 대조군: 같은 워크스페이스 안의 세 탭은 기본 제목이 모두 "Terminal"
    // 이라 제목으로는 모호하다. 그 상황에서도 id 는 유일하게 꽂힌다 — 그것이
    // 이 주소 형태의 요점이고, 격리는 그 요점을 건드리지 않는다.
    assert_eq!(
        d.resolve_send_target(sender, &format!("#{}", peer_tab.0)),
        Ok(peer)
    );
    assert_eq!(
        d.resolve_send_target(sender, "terminal"),
        Err(SendTargetError::Ambiguous { count: 2 })
    );
}

#[test]
fn resolve_send_target_by_tab_id_rejects_unknown_exited_viewer_and_self() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (sender_tab, sender) = create_terminal_tab(&mut d, pane);
    let (dead_tab, dead) = create_terminal_tab(&mut d, pane);
    let viewer_tab = create_viewer_tab(
        &mut d,
        pane,
        NewTab::FolderBrowser {
            path: Some("/home/u/build".into()),
        },
    );

    // 없는 id.
    assert_eq!(
        d.resolve_send_target(sender, "#9999"),
        Err(SendTargetError::NoMatch)
    );
    // 뷰어 탭 — 쓸 stdin 이 없다.
    assert_eq!(
        d.resolve_send_target(sender, &format!("#{}", viewer_tab.0)),
        Err(SendTargetError::NoMatch)
    );
    // 자기 자신 — 되먹임 금지.
    assert_eq!(
        d.resolve_send_target(sender, &format!("#{}", sender_tab.0)),
        Err(SendTargetError::NoMatch)
    );
    // 살아 있는 동안은 히트하고, 세션이 죽으면 같은 id 가 NoMatch 가 된다.
    assert_eq!(
        d.resolve_send_target(sender, &format!("#{}", dead_tab.0)),
        Ok(dead)
    );
    d.apply_event(SessionEvent::SessionExited {
        session: dead,
        code: Some(0),
        ended_at_ms: 1_700_000_000_000,
    });
    assert_eq!(
        d.resolve_send_target(sender, &format!("#{}", dead_tab.0)),
        Err(SendTargetError::NoMatch)
    );
}

#[test]
fn resolve_send_target_falls_back_to_title_when_the_hash_is_not_a_number() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (_t1, sender) = create_terminal_tab(&mut d, pane);
    let (_t2, hashed) = create_terminal_tab(&mut d, pane);
    // 제목이 `#` 로 시작하는 탭 — id 모드가 이 길을 죽이면 안 된다.
    set_title(&mut d, sender, "claude");
    set_title(&mut d, hashed, "#abc channel");

    for target in ["#abc", "#", "#1.2", "#-3", "#+4", "# 5"] {
        assert_eq!(
            parse_tab_id_target(target),
            None,
            "{target:?} 는 id 로 파싱되지 않는다"
        );
    }
    // 그래서 `#abc` 는 제목 매칭으로 흘러 그 탭에 도달한다.
    assert_eq!(d.resolve_send_target(sender, "#abc"), Ok(hashed));
    // u64 범위를 넘는 숫자도 파싱 실패 → 제목 매칭(일치 없음)으로 떨어진다.
    assert_eq!(parse_tab_id_target("#99999999999999999999999"), None);
    assert_eq!(
        d.resolve_send_target(sender, "#99999999999999999999999"),
        Err(SendTargetError::NoMatch)
    );
    // 대조군: 숫자만 있으면 id 모드다.
    assert_eq!(parse_tab_id_target("#42"), Some(TabId(42)));
    assert_eq!(parse_tab_id_target("#007"), Some(TabId(7)));
}

#[test]
fn resolve_send_target_by_tab_id_is_a_pure_query() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (_t1, sender) = create_terminal_tab(&mut d, pane);
    let (other_tab, other) = create_terminal_tab(&mut d, pane);
    let before = serde_json::to_value(d.state()).unwrap();

    assert_eq!(
        d.resolve_send_target(sender, &format!("#{}", other_tab.0)),
        Ok(other)
    );
    assert_eq!(
        d.resolve_send_target(sender, "#9999"),
        Err(SendTargetError::NoMatch)
    );
    assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
}

// ---- 탭 열거 (질의 채널) ----

/// 격리 반증 + 필드 계약: 요청자에게는 **자기 워크스페이스의 탭만** 보이고,
/// 반대편 요청자에게는 반대편 탭만 보인다. 워크스페이스 문맥 필드는 유지된다.
#[test]
fn list_tabs_is_scoped_to_the_requesters_workspace_with_exact_fields() {
    let (mut d, _host) = dispatcher();
    let (ws1, pane1) = create_ws(&mut d, "alpha");
    let (t_sender, sender) = create_terminal_tab(&mut d, pane1);
    let (t_dead, dead) = create_terminal_tab(&mut d, pane1);
    let viewer = create_viewer_tab(
        &mut d,
        pane1,
        NewTab::MarkdownViewer {
            path: "/home/u/notes.md".into(),
        },
    );
    // 두 번째 워크스페이스가 active 가 되므로 alpha 는 백그라운드다 — 요청자가
    // 백그라운드에 있어도 자기 워크스페이스는 온전히 열거된다.
    let (ws2, pane2) = create_ws(&mut d, "beta");
    let (t_other, other) = create_terminal_tab(&mut d, pane2);
    set_title(&mut d, sender, "claude");
    set_title(&mut d, dead, "build");
    set_title(&mut d, other, "agent");
    d.apply_event(SessionEvent::SessionExited {
        session: dead,
        code: Some(1),
        ended_at_ms: 1_700_000_000_000,
    });

    let tabs = d.list_tabs(sender);
    // pane id 순 → 탭 순. 뷰어 탭도 빠짐없이 실리고, beta 의 탭은 빠진다.
    assert_eq!(
        tabs.iter().map(|t| t.tab).collect::<Vec<_>>(),
        vec![t_sender.0, t_dead.0, viewer.0]
    );
    assert_eq!(
        tabs[0],
        TabInfo {
            tab: t_sender.0,
            title: "claude".into(),
            workspace_id: ws1.0,
            workspace_name: "alpha".into(),
            pane: pane1.0,
            active: false,
            kind: "terminal",
            status: "running",
        }
    );
    // 죽은 터미널은 status 로 드러난다 (목록에서 사라지지 않는다).
    assert_eq!(tabs[1].status, "exited");
    assert_eq!(tabs[1].kind, "terminal");
    assert_eq!(tabs[1].title, "build");
    // 뷰어 탭 — 프로세스가 없으므로 세 번째 상태. 제목은 경로의 basename.
    assert_eq!(tabs[2].kind, "markdownViewer");
    assert_eq!(tabs[2].status, "viewer");
    assert_eq!(tabs[2].title, "notes.md");
    // 마지막 생성 탭이 그 pane 의 active_tab 이다.
    assert!(tabs[2].active, "뷰어가 pane1 의 active_tab");

    // 반대편 요청자는 beta 만 본다 — 경계는 요청자마다 따로 그어진다.
    assert_eq!(
        d.list_tabs(other),
        vec![TabInfo {
            tab: t_other.0,
            title: "agent".into(),
            workspace_id: ws2.0,
            workspace_name: "beta".into(),
            pane: pane2.0,
            active: true,
            kind: "terminal",
            status: "running",
        }]
    );
}

#[test]
fn list_tabs_covers_every_tab_kind_and_pane() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    create_viewer_tab(
        &mut d,
        pane,
        NewTab::FolderBrowser {
            path: Some("/home/u/proj".into()),
        },
    );
    create_viewer_tab(
        &mut d,
        pane,
        NewTab::TextViewer {
            path: "/home/u/a.txt".into(),
        },
    );
    // 분할한 pane 의 탭도 같은 열거에 들어온다 — 격리 경계는 워크스페이스지
    // pane 이 아니다 (요청자는 pane_b 에 있고 pane 의 탭들도 보인다).
    let (pane_b, _split) = split_empty(&mut d, pane, SplitDirection::Horizontal);
    let (t_term, requester) = create_terminal_tab(&mut d, pane_b);

    let tabs = d.list_tabs(requester);
    assert_eq!(
        tabs.iter().map(|t| (t.pane, t.kind)).collect::<Vec<_>>(),
        vec![
            (pane.0, "folderBrowser"),
            (pane.0, "textViewer"),
            (pane_b.0, "terminal"),
        ]
    );
    assert_eq!(
        tabs.iter().map(|t| t.active).collect::<Vec<_>>(),
        vec![false, true, true],
        "pane 마다 자기 active_tab 이 따로 있다"
    );
    assert_eq!(tabs[2].tab, t_term.0);
}

#[test]
fn list_tabs_is_a_pure_query_and_serializes_camel_case() {
    let (mut d, _host) = dispatcher();
    assert!(
        d.list_tabs(999).is_empty(),
        "워크스페이스가 없으면(=요청자를 찾을 수 없으면) 빈 목록"
    );
    let (ws, pane) = create_ws(&mut d, "ws");
    let (tab, requester) = create_terminal_tab(&mut d, pane);
    let before = serde_json::to_value(d.state()).unwrap();

    let tabs = d.list_tabs(requester);
    assert_eq!(serde_json::to_value(d.state()).unwrap(), before);
    // JSON 출구 계약 — camelCase 키에 평평한 u64 id.
    assert_eq!(
        serde_json::to_value(&tabs[0]).unwrap(),
        serde_json::json!({
            "tab": tab.0,
            "title": "Terminal",
            "workspaceId": ws.0,
            "workspaceName": "ws",
            "pane": pane.0,
            "active": true,
            "kind": "terminal",
            "status": "running",
        })
    );
}

/// 시작 표식 계열 테스트가 보는 것 — 상태와 세션 보유 여부.
fn terminal_of(d: &Dispatcher, tab: TabId) -> (TerminalStatus, Option<SessionId>) {
    for ws in &d.state().workspaces {
        for pane in ws.panes.values() {
            for t in &pane.tabs {
                if t.id == tab {
                    if let TabKind::Terminal {
                        status,
                        pty_session,
                        ..
                    } = &t.kind
                    {
                        return (*status, *pty_session);
                    }
                }
            }
        }
    }
    panic!("terminal tab {tab:?} not found");
}

#[test]
fn startup_timeout_marks_the_tab_not_started_without_dropping_the_session() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (tab, session) = create_terminal_tab(&mut d, pane);
    let rev = d.state().revision;

    d.apply_event(SessionEvent::SessionStartupTimeout { session });

    // 세션을 유지하는 것이 계약이다 — 늦게 온 표식이 되돌릴 수 있어야 한다.
    assert_eq!(
        terminal_of(&d, tab),
        (TerminalStatus::NotStarted, Some(session))
    );
    assert!(
        d.state().revision > rev,
        "the transition must reach snapshots"
    );
}

#[test]
fn startup_timeout_does_not_touch_an_exited_tab() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (tab, session) = create_terminal_tab(&mut d, pane);
    d.apply_event(SessionEvent::SessionExited {
        session,
        code: Some(0),
        ended_at_ms: 1_700_000_000_000,
    });
    assert_eq!(terminal_of(&d, tab).1, None, "세션을 놓은 뒤가 전제다");
    let rev = d.state().revision;

    // 마감이 종료 직후에 지나가는 경합 — 끝난 탭이 "시작 안 됨"으로 되살아나면
    // 그 오분류는 워치독과 waiter 의 순서에 달려 재현조차 되지 않는다. 이제는
    // 세션 id 로 찾히지 않는 것이 그 방어다.
    d.apply_event(SessionEvent::SessionStartupTimeout { session });

    assert_eq!(
        terminal_of(&d, tab).0,
        TerminalStatus::Exited {
            code: Some(0),
            ended_at_ms: Some(1_700_000_000_000)
        }
    );
    assert_eq!(
        d.state().revision,
        rev,
        "a no-op must not bump the revision"
    );
}

#[test]
fn a_late_startup_marker_clears_not_started() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (tab, session) = create_terminal_tab(&mut d, pane);
    d.apply_event(SessionEvent::SessionStartupTimeout { session });

    let mut batch = OscBatch::default();
    batch.merge(session, &OscEvent::Osc777Started);
    assert!(d.apply_osc(batch, 1), "the marker must change state");

    assert_eq!(terminal_of(&d, tab).0, TerminalStatus::Running);
}

#[test]
fn retrying_a_not_started_tab_kills_the_session_it_still_holds() {
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (tab, session) = create_terminal_tab(&mut d, pane);
    d.apply_event(SessionEvent::SessionStartupTimeout { session });

    let new_session = d
        .respawn_tab(tab)
        .expect("a not-started tab must be respawnable");

    assert_ne!(new_session, session);
    assert_eq!(
        host.kills(),
        vec![session],
        "the session the tab still held must be cleaned up"
    );
    assert_eq!(
        terminal_of(&d, tab),
        (TerminalStatus::Running, Some(new_session))
    );
}

#[test]
fn a_marker_that_arrives_before_the_timeout_report_still_wins() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (tab, session) = create_terminal_tab(&mut d, pane);

    // 표식이 먼저 도착한다 — 이때 탭은 아직 Running 이라 되돌릴 것이 없고, 상태만
    // 보는 구현에서는 이 신호가 그대로 소모된다.
    let mut batch = OscBatch::default();
    batch.merge(session, &OscEvent::Osc777Started);
    d.apply_osc(batch, 1);

    // 뒤늦게 마감 보고가 들어온다. 두 신호는 서로 다른 경로(라우터 배치 / 워치독
    // 직행)로 오므로 이 순서가 실제로 발생하며, 여기서 NotStarted 가 되면 표식은
    // 세션당 한 번뿐이라 회복 수단이 남지 않는다.
    d.apply_event(SessionEvent::SessionStartupTimeout { session });

    assert_eq!(terminal_of(&d, tab).0, TerminalStatus::Running);
}

#[test]
fn a_failed_retry_does_not_keep_the_removed_session_id() {
    let (mut d, host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (tab, session) = create_terminal_tab(&mut d, pane);
    d.apply_event(SessionEvent::SessionStartupTimeout { session });
    host.set_fail_spawn(true);

    assert!(d.respawn_tab(tab).is_err());

    // 옛 세션은 kill 되어 레지스트리에서 사라졌다 — 그 id 를 탭에 남기면 이후
    // attach 가 미지 세션으로 실패한다.
    assert_eq!(
        terminal_of(&d, tab),
        (
            TerminalStatus::Exited {
                code: None,
                ended_at_ms: None
            },
            None
        )
    );
    assert_eq!(host.kills(), vec![session]);
}

// --- 레지스트리 정합성 검사 (ADR-0018 D5) ---

#[test]
fn a_clean_model_and_registry_pair_audits_empty() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (_t1, s1) = create_terminal_tab(&mut d, pane);
    let (_t2, s2) = create_terminal_tab(&mut d, pane);

    let audit = audit_registries(d.state(), &[s1, s2], &[s1, s2]);
    assert_eq!(audit, RegistryAudit::default());
    assert!(audit.is_empty());
}

#[test]
fn a_session_no_tab_references_is_an_orphan_in_both_registries() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (_tab, session) = create_terminal_tab(&mut d, pane);

    let audit = audit_registries(d.state(), &[session, 99], &[session, 99]);
    assert_eq!(audit.orphan_sessions, vec![99]);
    assert_eq!(audit.orphan_sinks, vec![99]);
    assert!(audit.dangling_tabs.is_empty());
}

#[test]
fn an_exited_tabs_former_session_becomes_an_orphan() {
    // 정확히 이 청소가 1a 의 계약 반전으로 가능해졌다 — exited 탭이 세션을
    // 놓으므로 남아 있는 레지스트리 항목은 참조자가 없다.
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (_tab, session) = create_terminal_tab(&mut d, pane);
    d.apply_event(SessionEvent::SessionExited {
        session,
        code: Some(0),
        ended_at_ms: 1_700_000_000_000,
    });

    let audit = audit_registries(d.state(), &[session], &[session]);
    assert_eq!(audit.orphan_sessions, vec![session]);
    assert_eq!(audit.orphan_sinks, vec![session]);
    assert!(audit.dangling_tabs.is_empty());
}

#[test]
fn a_tab_whose_session_is_missing_from_either_registry_is_dangling() {
    let (mut d, _host) = dispatcher();
    let (_ws, pane) = create_ws(&mut d, "ws");
    let (t1, s1) = create_terminal_tab(&mut d, pane);
    let (t2, s2) = create_terminal_tab(&mut d, pane);

    // 한쪽만 비어도 dangling 이다 — attach 는 sink·세션 둘 다 있어야 산다.
    let audit = audit_registries(d.state(), &[s1, s2], &[s2]);
    assert_eq!(audit.dangling_tabs, vec![(t1, s1)]);
    // 그리고 반대쪽에 남은 짝은 같은 pass 에서 고아로 나온다 — 탭이 곧 세션을
    // 놓으므로 s1 을 참조자로 세면 살아 있는 셸이 영원히 안 잡힌다.
    assert_eq!(audit.orphan_sessions, vec![s1]);
    assert!(audit.orphan_sinks.is_empty());

    let audit = audit_registries(d.state(), &[], &[]);
    assert_eq!(audit.dangling_tabs, vec![(t1, s1), (t2, s2)]);
}

#[test]
#[cfg(target_os = "macos")]
fn native_workspace_ignores_distro_and_accepts_native_paths() {
    let (mut d, _host) = dispatcher();
    d.dispatch(Command::CreateWorkspace {
        name: "native".into(), root_path: Some("/mnt/a:project".into()),
        distro: Some("Ubuntu".into()), tab: None,
    }).unwrap();
    let ws = &d.state().workspaces[0];
    assert_eq!(ws.distro, None);
    assert_eq!(ws.root_path.as_deref(), Some("/mnt/a:project"));
}
