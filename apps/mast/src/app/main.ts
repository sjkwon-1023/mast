import { installNavKeys } from "./navigation/actions";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ActivityPing } from "./activity-ping";
import {
  dispatch,
  getDiagnostics,
  getState,
  getUpdateInfo,
  getUiSettings,
  notifyToast,
  onUpdateChecked,
  openUrl,
  pickWorkspaceFolder,
  remoteStatus,
  resetUi,
  userActivity,
} from "../infrastructure/backend";
import {
  detectNeedsInputOnset,
  needsInputToasts,
  needsInputToastTargets,
} from "../features/notifications/chime";
import { formatCommandError } from "../shared/command-error";
import { activeTerminalCwd, activeWorkspace, pathBasename } from "../shared/keys";
import { openPairingDialog } from "../features/pairing/dialog";
import { Sidebar } from "../features/workspace/sidebar";
import { Store } from "./store";
import { SwitchTracer } from "../features/workspace/switch-trace";
import type { SwitchReport } from "../features/workspace/switch-trace";
import { installFrontEndLogging } from "../infrastructure/logging";
import { applyTerminalSettings } from "../features/terminal/settings";
import { applyHighlightSettings } from "../features/viewers/text/settings";
import { applyViewerFontSettings } from "../features/viewers/viewer-font";
import { applyTabIdSettings } from "../features/workspace/tab-id-settings";
import { initWindowVisibility } from "../infrastructure/window-visibility";
import { WorkspaceView } from "../features/workspace/workspace-view";
import type {
  AgentStatus,
  Command,
  CommandOutput,
  StateSnapshot,
  TabId,
} from "../shared/types";
import { initUpdateNotice as startUpdateNotice } from "./update-notice";
import { installShortcutGuide } from "./shortcut-guide";

declare global {
  interface Window {
    __mast: {
      dispatch: typeof dispatch;
      getState: typeof getState;
      reload: () => void;

      // UI 버튼이 없는 개발용 리셋·진단 경로다.
      resetUi: typeof resetUi;

      diagnostics: typeof getDiagnostics;

      lastSwitch: SwitchReport | null;
    };
  }
}

// F5는 터미널 앱에 전달하고 Ctrl+Shift+R만 WebView 리로드로 가로챈다.
function installReloadKey(): void {
  window.addEventListener(
    "keydown",
    (ev) => {
      if (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.code === "KeyR") {
        ev.preventDefault();
        location.reload();
      }
    },
    { capture: true },
  );
}

function installActivityPing(): void {
  const ping = new ActivityPing((visible) => {
    userActivity(visible).catch((err) => console.error("user_activity failed", err));
  });
  const onActivity = () => ping.activity(performance.now());
  window.addEventListener("wheel", onActivity, { capture: true, passive: true });
  window.addEventListener("mousedown", onActivity, { capture: true });
  window.addEventListener("keydown", onActivity, { capture: true });
  document.addEventListener("visibilitychange", () => {
    ping.visibility(document.visibilityState === "visible", performance.now());
  });
}

const ERROR_TTL_MS = 5000;

const WINDOW_FOCUS_EVENT = "window-focus";

function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id} element`);
  return el;
}

class App {
  private readonly statusEl = requireElement("status-line");
  private readonly viewEl = requireElement("view");
  private readonly store = new Store();

  private readonly tracer = new SwitchTracer((report) => {
    window.__mast.lastSwitch = report;
  });
  private readonly wsView = new WorkspaceView(
    this.viewEl,
    (cmd) => this.dispatchUI(cmd),
    this.tracer,

    {
      setPrompt: (text) => this.setPrompt(text),
      flashError: (text) => this.showError(text),
    },
  );
  private readonly sidebar = new Sidebar(
    requireElement("sidebar"),
    (cmd) => this.dispatchUI(cmd),

    () => this.createWorkspaceHere(),
    () => openPairingDialog(),
    (url) => {
      void openUrl(url).catch((err: unknown) => {
        console.debug("[mast] update link failed", err);
      });
    },
  );

  private agentStatuses: Map<TabId, AgentStatus> | null = null;

  private windowFocused = true;

  private focusEventSeen = false;
  private errorText: string | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  private picking = false;

  private promptText: string | null = null;

  async init(): Promise<void> {
    window.__mast = {
      dispatch,
      getState,
      reload: () => location.reload(),
      resetUi,
      diagnostics: getDiagnostics,
      lastSwitch: null,
    };

    this.initUpdateNotice();
    installReloadKey();
    installShortcutGuide();
    installActivityPing();
    this.installWindowFocus();

    initWindowVisibility().catch((err: unknown) => {
      console.error("window visibility listen failed", err);
    });
    installNavKeys({
      getSnapshot: () => this.store.snapshot,
      paneRects: () => this.wsView.paneRects(),
      dispatchUI: (command) => this.dispatchUI(command),
      createWorkspaceHere: () => this.createWorkspaceHere(),
      renameWorkspace: () => this.sidebar.beginRename(),
      closeWorkspace: () => this.sidebar.closeActive(),
    });

    try {
      const settings = await getUiSettings();

      // 첫 스냅샷이 뷰를 만들기 전에 설정과 로그를 적용한다.
      installFrontEndLogging(settings);
      applyTerminalSettings(settings);
      applyViewerFontSettings(settings);
      applyHighlightSettings(settings);
      applyTabIdSettings(settings);
    } catch (err) {
      console.error("get_ui_settings failed", err);
      this.showError(formatCommandError(err));
    }
    await this.initRemote();
    this.store.subscribe((snapshot) => this.render(snapshot));
    await this.store.init();
  }

  private initUpdateNotice(): void {
    startUpdateNotice(onUpdateChecked, getUpdateInfo, (info) =>
      this.sidebar.setUpdateInfo(info),
    );
  }

  private async initRemote(): Promise<void> {
    try {
      const status = await remoteStatus();
      // Local HTTP 서버가 실패로 떠 있으면 알린다. "Pair phone" 버튼은 이 상태와
      // 무관하게 항상 보인다 — 꺼져 있으면 다이얼로그가 설정·Secure Remote 안내를 한다.
      if (status.state === "failed") {
        this.showError(status.reason ?? "remote surface failed to start");
      }
    } catch (err) {
      console.error("remote_status failed", err);
    }
  }

  private installWindowFocus(): void {
    listen<boolean>(WINDOW_FOCUS_EVENT, (event) => {
      this.focusEventSeen = true;
      this.windowFocused = event.payload;
    }).catch((err: unknown) => {
      console.error("window focus listen failed", err);
    });

    void (async () => {
      try {
        const focused = await getCurrentWindow().isFocused();
        // 늦게 끝난 초기 조회가 더 최신 포커스 이벤트를 덮어쓰지 않게 한다.
        if (!this.focusEventSeen) this.windowFocused = focused;
      } catch (err) {
        console.error("window focus query failed", err);
      }
    })();
  }

  private createWorkspaceHere(): void {
    const snapshot = this.store.snapshot;
    const ws = snapshot === null ? null : activeWorkspace(snapshot);
    if (ws === null) {
      void this.openWorkspacePicker();
      return;
    }
    const cwd = activeTerminalCwd(ws);
    if (cwd === null) {
      this.showError("cannot create a workspace here: current directory unknown");
      return;
    }

    if (cwd === "/mnt" || cwd.startsWith("/mnt/")) {
      this.showError(
        "cannot create a workspace under /mnt: Windows drives are data-only — cd into the WSL filesystem first",
      );
      return;
    }
    void this.dispatchUI({
      type: "createWorkspace",
      name: pathBasename(cwd),
      rootPath: cwd,
      distro: ws.distro,
      tab: { type: "terminal", cwd: null },
    });
  }

  private async openWorkspacePicker(): Promise<void> {
    if (this.picking) return;
    this.picking = true;
    try {
      const picked = await pickWorkspaceFolder();
      if (picked === null) return;
      await this.dispatchUI({
        type: "createWorkspace",
        name: picked.name,
        rootPath: picked.linux_path,
        distro: picked.distro,
        tab: { type: "terminal", cwd: null },
      });
    } catch (err) {
      console.error("pick_workspace_folder failed", err);
      this.showError(formatCommandError(err));
    } finally {
      this.picking = false;
    }
  }

  private async dispatchUI(cmd: Command): Promise<CommandOutput | null> {
    let traceToken: number | null = null;
    if (cmd.type === "switchWorkspace") {
      const active = this.store.snapshot?.state.activeWorkspace ?? null;
      if (active !== cmd.workspace) {
        traceToken = this.tracer.begin(cmd.workspace, performance.now());
      }
    }
    try {
      const out = await dispatch(cmd);
      this.clearError();
      this.compensateFocus(cmd, out);
      return out;
    } catch (err) {
      if (traceToken !== null) this.tracer.discard(traceToken);
      console.error("dispatch failed", cmd, err);
      this.showError(formatCommandError(err));
      return null;
    }
  }

  // 명령 응답과 스냅샷의 도착 순서가 달라도 requestFocus가 렌더 이후 포커스를 보상한다.
  private compensateFocus(cmd: Command, out: CommandOutput): void {
    if (out.type === "tabCreated") {
      this.wsView.requestFocus({ kind: "tab", tab: out.tab });
      return;
    }
    if (out.type === "paneCreated" && out.tab !== null) {
      this.wsView.requestFocus({ kind: "tab", tab: out.tab });
      return;
    }
    if (out.type === "workspaceCreated" && out.tab !== null) {
      this.wsView.requestFocus({ kind: "tab", tab: out.tab });
      return;
    }
    if (cmd.type === "activateTab") {
      this.wsView.requestFocus({ kind: "tab", tab: cmd.tab });
      return;
    }
    if (cmd.type === "focusPane") {
      this.wsView.requestFocus({ kind: "pane", pane: cmd.pane });
      return;
    }
    if (
      cmd.type === "closeTab" ||
      cmd.type === "closePane" ||
      cmd.type === "closeWorkspace" ||
      cmd.type === "switchWorkspace"
    ) {
      this.wsView.requestFocus({ kind: "activePane" });
    }
  }

  private showError(text: string): void {
    this.errorText = text;
    if (this.errorTimer !== null) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null;
      this.clearError();
    }, ERROR_TTL_MS);
    this.renderStatusLine();
  }

  private setPrompt(text: string | null): void {
    if (this.promptText === text) return;
    this.promptText = text;
    this.renderStatusLine();
  }

  private clearError(): void {
    if (this.errorTimer !== null) {
      clearTimeout(this.errorTimer);
      this.errorTimer = null;
    }
    if (this.errorText === null) return;
    this.errorText = null;
    this.renderStatusLine();
  }

  private render(snapshot: StateSnapshot): void {
    this.tracer.markSnapshot(snapshot.state.activeWorkspace, performance.now());
    this.notifyNeedsInput(snapshot);
    this.sidebar.render(snapshot);
    this.wsView.render(snapshot);

    this.tracer.settle();
  }

  // 첫 스냅샷은 기준선이며 알리지 않는다. 이후 실제 needsInput 전이만 토스트로 보낸다.
  private notifyNeedsInput(snapshot: StateSnapshot): void {
    const { onsets, next } = detectNeedsInputOnset(
      this.agentStatuses,
      snapshot.state.workspaces,
    );
    this.agentStatuses = next;
    const targets = needsInputToastTargets(
      onsets,
      snapshot.state.activeWorkspace,
      this.windowFocused,
    );
    for (const toast of needsInputToasts(targets, snapshot.state.workspaces)) {
      notifyToast(toast.title, toast.body, toast.logLabel).catch((err) => {
        console.debug("[mast] needsInput toast failed", err);
      });
    }
  }

  private renderStatusLine(): void {
    const parts: string[] = [];
    if (this.promptText !== null) parts.push(this.promptText);
    if (this.errorText !== null) parts.push(`ERROR: ${this.errorText}`);
    this.statusEl.textContent = parts.join(" · ");
    this.statusEl.classList.toggle("error", this.errorText !== null);
    this.statusEl.hidden = parts.length === 0;
  }
}

async function main(): Promise<void> {
  const app = new App();
  await app.init();
}

main().catch((err) => {
  console.error("app bootstrap failed", err);

  const el = document.getElementById("status-line");
  if (el !== null) {
    el.textContent = `bootstrap failed: ${String(err)}`;
    el.classList.add("error");
    el.hidden = false;
  }
});
