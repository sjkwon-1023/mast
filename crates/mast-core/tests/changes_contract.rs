use mast_core::command::{Command, CommandError, CommandOutput, Dispatcher, NewTab, SessionHost};
use mast_core::git::{GitChange, GitDiff, GitDiffRequest, GitScope, GitStatus, DIFF_BYTES};
use mast_core::model::TabKind;
use mast_core::persist::{load, save_atomic, LoadOutcome};
use mast_core::session::SessionId;

struct NoSpawn;

impl SessionHost for NoSpawn {
    fn spawn_shell(&self, _spec: mast_core::command::ShellSpawnReq) -> anyhow::Result<SessionId> {
        panic!("Changes tabs must not spawn a terminal");
    }
    fn kill(&self, _session: SessionId) {}
}

#[test]
fn shared_fixture_covers_kind_creation_and_content_contracts() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/changes-viewer.json")).unwrap();
    let spec: NewTab = serde_json::from_value(fixture["newTab"].clone()).unwrap();
    assert!(matches!(spec, NewTab::ChangesViewer { path: None }));
    assert_eq!(serde_json::to_value(&spec).unwrap(), fixture["newTab"]);
    let kind: TabKind = serde_json::from_value(fixture["kind"].clone()).unwrap();
    assert_eq!(serde_json::to_value(&kind).unwrap(), fixture["kind"]);
    assert_eq!(DIFF_BYTES as u64, fixture["diffBytes"].as_u64().unwrap());
    let status = GitStatus {
        root: "/home/user/code/project/main".into(),
        unborn: false,
        entries: vec![GitChange {
            path: "new name.rs".into(),
            original_path: Some("old name.rs".into()),
            index_status: "R".into(),
            worktree_status: ".".into(),
            untracked: false,
            conflicted: false,
        }],
        truncated: false,
    };
    assert_eq!(serde_json::to_value(status).unwrap(), fixture["status"]);
    let request: GitDiffRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
    assert_eq!(request.scope, GitScope::Staged);
    assert_eq!(request.original_path.as_deref(), Some("old name.rs"));
    let diff = GitDiff {
        text: "rename from old name.rs\nrename to new name.rs\n".into(),
        truncated: false,
    };
    assert_eq!(serde_json::to_value(diff).unwrap(), fixture["diff"]);
}

#[test]
fn changes_tab_persists_supplied_root_without_scroll_or_terminal_session() {
    let mut dispatcher = Dispatcher::new(Box::new(NoSpawn));
    let output = dispatcher
        .dispatch(Command::CreateWorkspace {
            name: "changes".into(),
            root_path: Some("/home/user/code/project".into()),
            distro: None,
            tab: Some(NewTab::ChangesViewer { path: None }),
        })
        .unwrap();
    let CommandOutput::WorkspaceCreated {
        pane,
        tab: Some(tab),
        session: None,
        ..
    } = output
    else {
        panic!("{output:?}")
    };
    let saved_tab = dispatcher.state().workspaces[0].panes[&pane].tabs[0].clone();
    assert_eq!(saved_tab.title, "Changes");
    assert_eq!(
        saved_tab.kind,
        TabKind::ChangesViewer {
            path: "/home/user/code/project".into()
        }
    );
    assert_eq!(
        dispatcher.dispatch(Command::SetViewerScroll {
            tab,
            scroll_top: 5.0
        }),
        Err(CommandError::KindMismatch { tab })
    );
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    save_atomic(&path, dispatcher.state()).unwrap();
    let LoadOutcome::Restored { state, .. } = load(&path) else {
        panic!("Changes state did not restore")
    };
    assert_eq!(
        state.workspaces[0].panes[&pane].tabs[0].kind,
        saved_tab.kind
    );
}
