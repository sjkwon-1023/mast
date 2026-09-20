// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../infrastructure/backend', () => ({ fsListDir: vi.fn(async () => ({ entries: [{ name: 'sub', is_dir: true, size: null }, { name: 'file.md', is_dir: false, size: 3 }], truncated: false })) }));
import { FolderView } from './view';
let view: FolderView;
afterEach(() => { view?.dispose(); document.body.replaceChildren(); });
it('uses left for parent and right only for a real child folder', async () => {
  const dispatch = vi.fn(async () => null);
  view = new FolderView(document.body, 1, 2, null, { type: 'folderBrowser', path: '/tmp' }, dispatch);
  await vi.waitFor(() => expect(view.root.querySelectorAll('.folder-row')).toHaveLength(3));
  const key = (key: string) => view.root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  key('ArrowRight'); expect(dispatch).toHaveBeenLastCalledWith({ type: 'navigateFolder', tab: 1, path: '/tmp/sub' });
  dispatch.mockClear();
  key('End'); key('ArrowRight'); expect(dispatch).not.toHaveBeenCalled();
  key('Home'); key('ArrowRight'); expect(dispatch).not.toHaveBeenCalled();
  key('ArrowLeft'); expect(dispatch).toHaveBeenLastCalledWith({ type: 'navigateFolder', tab: 1, path: '/' });
});
