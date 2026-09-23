// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../infrastructure/backend", () => ({
  fsListDir: vi.fn(async () => ({ entries: [{ name: "child", is_dir: true, size: null }], truncated: false })),
  detachTerminal: vi.fn(async () => undefined),
}));
import { WorkspaceView } from "./workspace-view";
import { SwitchTracer } from "./switch-trace";
import type { StateSnapshot, Tab } from "../../shared/types";

function snapshot(closed: boolean, revision = 1): StateSnapshot {
  const tab = (id: number): Tab => ({ id, title: 'folder', kind: { type: 'folderBrowser', path: '/tmp' }, notification: 'none', lastActivityMs: null, agentStatus: 'idle', lastAgentMessage: null });
  return { revision, state: { revision, nextId: 10, activeWorkspace: 1, workspaces: [{ id: 1, name: 'ws', rootPath: '/tmp', distro: null, gitBranch: null, gitDirty: null, layout: { type: 'leaf', pane: 1 }, panes: { '1': { id: 1, activeTab: closed ? 2 : 3, tabs: closed ? [tab(2)] : [tab(2), tab(3)] } }, activePane: 1, agentStatus: 'idle', lastAgentMessage: null }] } };
}
let view: WorkspaceView;
afterEach(() => { if (view) { const empty = snapshot(true); empty.state.workspaces = []; empty.state.activeWorkspace = null; view.render(empty); } document.body.replaceChildren(); });
function setup(): HTMLElement {
  const root = document.createElement('div'); document.body.append(root);
  view = new WorkspaceView(root, async () => null, new SwitchTracer(() => undefined), { setPrompt: () => undefined, flashError: () => undefined });
  return root;
}
describe('tab close focus ordering', () => {
  it('focuses the remaining folder when its snapshot arrived before the command response', async () => {
    const root = setup();
    view.render(snapshot(false));
    view.render(snapshot(true, 2));
    view.requestFocus({ kind: 'activePane', after: { type: 'closeTab', tab: 3 } });
    await vi.waitFor(() => {
      const folder = root.querySelector('.folder-list');
      expect(folder).not.toBeNull();
      expect(document.activeElement).toBe(folder);
    });
  });
  it('waits through unrelated renders instead of focusing the tab about to close', async () => {
    const root = setup();
    view.render(snapshot(false));
    const outside = document.createElement('input'); document.body.append(outside); outside.focus();
    view.requestFocus({ kind: 'activePane', after: { type: 'closeTab', tab: 3 } });
    for (let i = 2; i <= 6; i++) view.render(snapshot(false, i));
    expect(document.activeElement).toBe(outside);
    view.render(snapshot(true, 7));
    await vi.waitFor(() => {
      const folder = root.querySelector('.folder-list');
      expect(folder).not.toBeNull();
      expect(document.activeElement).toBe(folder);
    });
  });
  it('does not take focus from the sidebar rename input that a card double-click just opened', async () => {
    const root = setup();
    view.render(snapshot(false));
    const rename = document.createElement('input'); rename.dataset.keepFocus = ''; document.body.append(rename); rename.focus();
    view.requestFocus({ kind: 'activePane', after: { type: 'closeTab', tab: 3 } });
    view.render(snapshot(true, 2));
    // 폴더 뷰는 지연 로드된다 — 로드가 끝난 뒤에도 포커스가 입력에 남아야 한다.
    await vi.waitFor(() => expect(root.querySelector('.folder-list')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(rename);
    expect(root.contains(document.activeElement)).toBe(false);
  });
});
