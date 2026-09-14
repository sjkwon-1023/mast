import {
  activeWorkspace,
  keyAction,
  nextTab,
  nextWorkspace,
  paneInDirection,
  paneTerminalCwd,
  workspaceAtOrdinal,
} from "../../shared/keys";
import type { KeyAction, PaneRect } from "../../shared/keys";
import { logSwallowedShortcut } from "../../infrastructure/logging";
import { adjustFontSize, resetFontSize } from "../../features/terminal/settings";
import { adjustViewerFontSize, resetViewerFontSize } from "../../features/viewers/viewer-font";
import type { Command, CommandOutput, StateSnapshot } from "../../shared/types";

export interface NavigationContext {
  getSnapshot(): StateSnapshot | null;
  paneRects(): PaneRect[];
  dispatchUI(command: Command): Promise<CommandOutput | null>;
  createWorkspaceHere(): void;
  renameWorkspace(): void;
  closeWorkspace(): void;
}

// 가로채기 목록의 키는 대상이 없어도 소비한다. capture로 xterm보다 먼저 처리한다.
export function installNavKeys(context: NavigationContext): void {
  window.addEventListener(
    "keydown",
    (ev) => {
      const action = keyAction({
        key: ev.key,
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
        shift: ev.shiftKey,
        isComposing: ev.isComposing,
      });
      if (action === null) {
        if (ev.isComposing && (ev.ctrlKey || ev.altKey)) logSwallowedShortcut(ev);
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      runNavAction(context, action);
    },
    { capture: true },
  );
}

// 매 입력마다 최신 스냅샷을 읽고, 실제 명령은 UI의 오류 표시·포커스 보상 경로를 탄다.
export function runNavAction(context: NavigationContext, action: KeyAction): void {
  // 생성·사이드바 동작·전체 줌은 스냅샷이 없어도 처리한다.
  if (action.type === "newWorkspaceHere") {
    context.createWorkspaceHere();
    return;
  }
  if (action.type === "renameWorkspace") {
    context.renameWorkspace();
    return;
  }

  if (action.type === "closeWorkspace") {
    context.closeWorkspace();
    return;
  }

  if (action.type === "zoom") {
    adjustFontSize(action.delta);
    adjustViewerFontSize(action.delta);
    return;
  }
  if (action.type === "zoomReset") {
    resetFontSize();
    resetViewerFontSize();
    return;
  }
  const snapshot = context.getSnapshot();
  if (snapshot === null) return;
  if (action.type === "switchWorkspace") {
    const target = workspaceAtOrdinal(
      snapshot.state.workspaces.map((w) => w.id),
      action.ordinal,
    );
    if (target === null || target === snapshot.state.activeWorkspace) return;
    void context.dispatchUI({ type: "switchWorkspace", workspace: target });
    return;
  }
  if (action.type === "cycleWorkspace") {
    const target = nextWorkspace(
      snapshot.state.workspaces.map((w) => w.id),
      snapshot.state.activeWorkspace,
      action.delta,
    );
    if (target === null) return;
    void context.dispatchUI({ type: "switchWorkspace", workspace: target });
    return;
  }
  const ws = activeWorkspace(snapshot);
  if (ws === null) return;
  if (action.type === "focusPane") {
    const target = paneInDirection(context.paneRects(), ws.activePane, action.dir);
    if (target === null) return;
    void context.dispatchUI({ type: "focusPane", pane: target });
    return;
  }

  const pane = ws.panes[String(ws.activePane)];
  if (action.type === "newTab") {
    const tab =
      action.kind === "terminal"
        ? ({ type: "terminal", cwd: paneTerminalCwd(pane) } as const)
        : ({ type: "folderBrowser", path: null } as const);
    void context.dispatchUI({ type: "createTab", pane: ws.activePane, tab });
    return;
  }
  if (action.type === "splitPane") {
    void context.dispatchUI({
      type: "splitPane",
      pane: ws.activePane,
      direction: action.direction,
      tab: { type: "terminal", cwd: paneTerminalCwd(pane) },
    });
    return;
  }
  if (pane === undefined) return;
  if (action.type === "closeTab") {
    if (pane.activeTab === null) return;
    void context.dispatchUI({ type: "closeTab", tab: pane.activeTab });
    return;
  }
  const target = nextTab(
    pane.tabs.map((t) => t.id),
    pane.activeTab,
    action.delta,
  );
  if (target === null) return;
  void context.dispatchUI({ type: "activateTab", tab: target });
}
