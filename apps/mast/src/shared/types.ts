// mast-core 모델·커맨드의 수기 TS 미러.
// 정본은 crates/mast-core/src/{model,command}.rs 의 rustdoc, 직렬화 계약은
// fixtures/stage10-*.json — internal tag("type")·camelCase·nullable 필드·panes 맵
// 키가 문자열 숫자인 점을 그대로 미러한다. shared/types.test.ts 가 같은 fixture 를
// 소비해 표류를 잠근다 (10단계 계획 0-7 — Rust round-trip 단독으론 무효).

/** 안정 ID — Rust 쪽 u64 newtype(WorkspaceId/PaneId/TabId/SplitId)은 JSON 에서
 *  그냥 숫자다. AppState 단일 카운터 발급이라 종류 불문 전역 유일하다. */
export type WorkspaceId = number;
export type PaneId = number;
export type TabId = number;
export type SplitId = number;

/** 휘발성 PTY 세션 id (u32) — 안정 ID 와 별개 공간 (model.rs 참조). */
export type SessionId = number;

/** `get_state` 응답·`state-changed` emit 의 공통 형태 (command.rs StateSnapshot). */
export interface StateSnapshot {
  revision: number;
  state: AppState;
}

export interface AppState {
  workspaces: Workspace[];
  /** 마지막 워크스페이스를 닫으면 null. */
  activeWorkspace: WorkspaceId | null;
  nextId: number;
  revision: number;
}

export interface Workspace {
  id: WorkspaceId;
  name: string;
  rootPath: string | null;
  distro: string | null;
  /** git 정보 — 타입 공간만 확정, 값 채움은 19단계. */
  gitBranch: string | null;
  gitDirty: boolean | null;
  layout: SplitTree;
  /** Rust BTreeMap<PaneId, Pane> — JSON object 키 제약으로 키가 문자열 숫자("2")다.
   *  조회는 String(paneId) 로 한다. */
  panes: Record<string, Pane>;
  activePane: PaneId;
  agentStatus: AgentStatus;
  lastAgentMessage: string | null;
  /** agentStatus 를 마지막으로 기록한 탭 (18단계 needsInput 우선 규칙의 주체).
   *  코어가 `skip_serializing_if = "Option::is_none"` 이라 None 이면 JSON 에서
   *  키 자체가 빠진다 — 그래서 `| null` 이 아니라 optional 이다 (fixture 무변경). */
  agentStatusSource?: TabId;
}

export type AgentStatus = "running" | "needsInput" | "idle";

export type NotificationState = "none" | "unread";

export type SplitDirection = "horizontal" | "vertical";

/** 워크스페이스 레이아웃 이진 트리 — internal tag "type" (model.rs SplitTree). */
export type SplitTree =
  | { type: "leaf"; pane: PaneId }
  | {
      type: "split";
      /** split 노드의 안정 ID — resizeSplit 의 대상 주소 (계획 D1). */
      id: SplitId;
      direction: SplitDirection;
      /** first 가 차지하는 비율 (0.0~1.0 개구간). */
      ratio: number;
      first: SplitTree;
      second: SplitTree;
    };

/** pane(= TabContainer). 탭 0개인 빈 pane 허용 — 10단계 임시 상태. */
export interface Pane {
  id: PaneId;
  tabs: Tab[];
  activeTab: TabId | null;
}

export interface Tab {
  id: TabId;
  title: string;
  kind: TabKind;
  notification: NotificationState;
  lastActivityMs: number | null;
}

/** 탭 종류별 상태 — internal tag "type".
 *
 *  scrollTop 시맨틱은 종류마다 다르다: textViewer 는 최상단 가시 행의 전역 byte
 *  offset, markdownViewer 는 렌더된 픽셀 offset. folderBrowser·changesViewer 는
 *  스크롤 위치를 기억하지 않아 필드 자체가 없다 (setViewerScroll 대상이 되면
 *  kindMismatch). */
export type TabKind =
  | {
      type: "terminal";
      /** 휘발성 PTY 세션 id. 살아 있는 세션에만 실린다 — 셸이 끝나면 비워지고,
       *  마지막 화면은 기록 파일로 남는다 (ADR-0018). */
      ptySession: SessionId | null;
      status: TerminalStatus;
      cwd: string | null;
    }
  | { type: "folderBrowser"; path: string }
  | { type: "textViewer"; path: string; scrollTop: number }
  | { type: "markdownViewer"; path: string; scrollTop: number }
  | { type: "changesViewer"; path: string };

export type TerminalStatus =
  | { type: "running" }
  /** endedAtMs 는 종료 시각(epoch ms). 백엔드가 항상 직렬화하므로 선택 필드가
   *  아니다 — 이 필드를 모르는 구 state.json 에서만 null 로 온다. */
  | { type: "exited"; code: number | null; endedAtMs: number | null }
  /** 프로세스는 살아 있는데 시작 표식이 마감 안에 오지 않았다. 종착 상태가 아니다 —
   *  표식이 늦게 도착하면 running 으로 돌아온다 (근거는 model.rs 의 TerminalStatus). */
  | { type: "notStarted" };

/** 탭 생성 명세 (command.rs NewTab) — createTab·splitPane·createWorkspace 공유.
 *  21단계 뷰어 4종이 모두 착지해 TabKind 와 종류가 일대일이다. */
export type NewTab =
  | { type: "terminal"; cwd: string | null }
  /** path 가 null 이면 워크스페이스 rootPath, 그것도 null 이면 "/" (terminal
   *  cwd 와 대칭). */
  | { type: "folderBrowser"; path: string | null }
  | { type: "textViewer"; path: string }
  | { type: "markdownViewer"; path: string }
  | { type: "changesViewer"; path: string | null };

/** 직렬화 가능한 command bus 명령 집합 (command.rs Command).
 *  JSON 은 internal tag: {"type": "createWorkspace", "name": ...}. */
export type Command =
  /** tab 이 non-null 이면 초기 pane 에 그 탭까지 원자 생성 (계획 13-D1).
   *  필드 누락(undefined)은 null 과 동일 — 13단계 이전 클라이언트 하위호환. */
  | {
      type: "createWorkspace";
      name: string;
      rootPath: string | null;
      distro: string | null;
      tab?: NewTab | null;
    }
  | { type: "switchWorkspace"; workspace: WorkspaceId }
  | { type: "closeWorkspace"; workspace: WorkspaceId }
  /** 워크스페이스 이름만 변경 (사이드바 F2 인라인 편집). 빈/공백뿐인 이름은
   *  invalidName 에러 — 코어는 받은 값을 그대로 저장하므로 다듬기는 UI 몫이다. */
  | { type: "renameWorkspace"; workspace: WorkspaceId; name: string }
  /** 사이드바 드래그 재배치 — `workspace` 를 `before` 바로 앞으로, `before` 가
   *  null 이면 맨 뒤로. 목적지를 인덱스가 아니라 이웃 id 로 주는 이유는 코어
   *  rustdoc 참조 (낡은 스냅샷에서 조용히 엉뚱한 자리로 가지 않는다). 순서는 곧
   *  `Ctrl+1`~`Ctrl+9` 의 번호이고, 활성 워크스페이스는 바뀌지 않는다. */
  | { type: "moveWorkspace"; workspace: WorkspaceId; before: WorkspaceId | null }
  | { type: "focusPane"; pane: PaneId }
  /** tab 이 non-null 이면 새 pane 에 그 탭까지 원자 생성 (계획 D5). */
  | { type: "splitPane"; pane: PaneId; direction: SplitDirection; tab: NewTab | null }
  /** ratio 는 finite·개구간 (0, 1) — 아니면 invalidRatio 에러 (계획 D2). */
  | { type: "resizeSplit"; split: SplitId; ratio: number }
  | { type: "closePane"; pane: PaneId }
  | { type: "createTab"; pane: PaneId; tab: NewTab }
  | { type: "activateTab"; tab: TabId }
  | { type: "closeTab"; tab: TabId }
  /** folderBrowser 탭의 경로 변경 — 탐색도 dispatcher 를 경유한다 (21단계).
   *  대상이 folderBrowser 가 아니면 kindMismatch, 경로 형태가 불량하면
   *  invalidPath. 성공 시 탭 제목도 basename 으로 갱신된다. */
  | { type: "navigateFolder"; tab: TabId; path: string }
  /** 뷰어 스크롤 위치 기록 (unmount 복원·persist). scrollTop 은 finite·0 이상
   *  이어야 하고(아니면 invalidScroll), 값 시맨틱은 TabKind 참조. */
  | { type: "setViewerScroll"; tab: TabId; scrollTop: number };

/** dispatch 성공 결과 (command.rs CommandOutput). */
export type CommandOutput =
  /** createWorkspace 결과 — 생성된 안정 ID 전부. tab 은 createWorkspace.tab 이
   *  non-null 이었을 때만 non-null 이고, session 은 그 탭이 terminal 일 때만
   *  non-null 이다 (뷰어 탭은 스폰이 없다 — 21단계). */
  | {
      type: "workspaceCreated";
      workspace: WorkspaceId;
      pane: PaneId;
      tab: TabId | null;
      session: SessionId | null;
    }
  /** splitPane 결과 — 생성된 안정 ID 전부. tab 은 splitPane.tab 이 non-null
   *  이었을 때만, session 은 그 탭이 terminal 일 때만 non-null (D5·21단계). */
  | {
      type: "paneCreated";
      pane: PaneId;
      split: SplitId;
      tab: TabId | null;
      session: SessionId | null;
    }
  /** session 은 terminal 탭이면 스폰된 PTY 세션 id, 뷰어 탭이면 null. */
  | { type: "tabCreated"; tab: TabId; session: SessionId | null }
  | { type: "done" };

/** dispatch 실패 (command.rs CommandError) — invoke reject payload 로 도착한다. */
export type CommandError =
  | { type: "unknownTarget"; target: string }
  | { type: "lastPane" }
  | { type: "spawnFailed"; message: string }
  | { type: "invalidRatio"; ratio: number }
  /** 대상 탭의 종류가 이 명령을 받을 수 없다 — navigateFolder 는 folderBrowser
   *  만, setViewerScroll 은 스크롤 위치를 모델에 가진 뷰어만 받는다 (21단계). */
  | { type: "kindMismatch"; tab: TabId }
  /** 뷰어 경로 형태 불량 (wslpath 검증 사유 문자열). 실존 여부와는 무관하다. */
  | { type: "invalidPath"; message: string }
  /** setViewerScroll 의 scrollTop 이 finite·0 이상이 아니다. */
  | { type: "invalidScroll"; value: number }
  /** 이름 값 불량 — renameWorkspace 의 빈/공백뿐인 이름 (경로가 아니라
   *  invalidPath 를 재사용하지 않는다). */
  | { type: "invalidName"; message: string };
