// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/platform")>()),
  IS_MAC: true,
}));

import type { UpdateInfo } from "../../infrastructure/backend";
import type { StateSnapshot, Workspace } from "../../shared/types";
import { Sidebar } from "./sidebar";

function workspace(): Workspace {
  return {
    id: 1,
    name: "Mac workspace",
    rootPath: "/Users/test/project",
    distro: null,
    gitBranch: null,
    gitDirty: null,
    layout: { type: "leaf", pane: 1 },
    panes: { "1": { id: 1, tabs: [], activeTab: null } },
    activePane: 1,
    agentStatus: "idle",
    lastAgentMessage: null,
  };
}

function snapshot(revision: number, workspaces: Workspace[]): StateSnapshot {
  return {
    revision,
    state: { workspaces, activeWorkspace: workspaces[0]?.id ?? null, nextId: 2, revision },
  };
}

describe("macOS sidebar pairing button", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("mac_connect_mobile_button_is_visible_and_opens_pairing", () => {
    const root = document.createElement("div");
    document.body.append(root);
    let pairingCalls = 0;
    const sidebar = new Sidebar(
      root,
      async () => null,
      () => {},
      () => {
        pairingCalls += 1;
      },
      () => {},
      () => {},
    );
    const pairButton = root.querySelector<HTMLButtonElement>(".sidebar-pair");
    const footer = root.querySelector<HTMLElement>(".sidebar-footer");
    const version = root.querySelector<HTMLElement>(".sidebar-version");
    if (pairButton === null || footer === null || version === null) {
      throw new Error("sidebar footer controls were not mounted");
    }

    expect(pairButton.hidden).toBe(false);
    pairButton.click();
    expect(pairingCalls).toBe(1);

    sidebar.render(snapshot(1, []));
    sidebar.render(snapshot(2, [workspace()]));
    const updateInfo: UpdateInfo = {
      currentVersion: "0.3.37",
      newerVersion: null,
      checked: false,
    };
    sidebar.setUpdateInfo(updateInfo);

    expect(pairButton.hidden).toBe(false);
    expect(footer.hidden).toBe(false);
    expect(version.hidden).toBe(false);
    expect(version.textContent).toBe("v0.3.37");
  });
});
