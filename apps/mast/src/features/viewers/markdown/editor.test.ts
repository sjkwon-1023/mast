// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ source: '# 원문\r\n', save: vi.fn() }));
vi.mock('../../../infrastructure/backend', () => ({
  fsStat: vi.fn(async () => ({ size: new TextEncoder().encode(backend.source).length, mtime_ms: 1, is_dir: false })),
  fsReadChunk: vi.fn(async () => new TextEncoder().encode(backend.source).buffer),
  fsSaveMarkdown: backend.save,
}));
import { MarkdownView } from './view';
import { discardMarkdownDraft, markdownDraft } from './drafts';
let view: MarkdownView;
function mount() { return new MarkdownView(document.body, 99, 1, null, { type: 'markdownViewer', path: '/tmp/note.md', scrollTop: 0 }, async () => null); }
function click(selector: string) { (view.root.querySelector(selector) as HTMLButtonElement).click(); }
function editor() { return view.root.querySelector('textarea') as HTMLTextAreaElement; }
function type(text: string) { editor().value = text; editor().dispatchEvent(new Event('input')); }
beforeEach(() => { discardMarkdownDraft(99); backend.source = '# 원문\r\n'; backend.save.mockReset(); backend.save.mockImplementation(async (_d, _p, _b, content) => { backend.source = content; }); });
afterEach(() => { view?.dispose(); discardMarkdownDraft(99); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function edit() {
  view = mount();
  await vi.waitFor(() => expect((view.root.querySelector('.markdown-edit') as HTMLButtonElement).disabled).toBe(false));
  click('.markdown-edit');
}
describe('Markdown editing', () => {
  it('saves UTF-8 with original CRLF and refreshes the preview', async () => {
    await edit(); type('# 수정\n'); click('.markdown-save');
    await vi.waitFor(() => expect(backend.save).toHaveBeenCalledWith(null, '/tmp/note.md', '# 원문\r\n', '# 수정\r\n'));
    await vi.waitFor(() => expect(view.root.querySelector('h1')?.textContent).toBe('수정'));
    expect(editor().hidden).toBe(true); expect(markdownDraft(99)).toBeNull();
  });
  it('keeps source on save conflict and across unmount/remount', async () => {
    await edit(); type('my draft'); backend.save.mockRejectedValue(new Error('file changed on disk')); click('.markdown-save');
    await vi.waitFor(() => expect(view.root.querySelector('.markdown-banner')?.textContent).toContain('file changed'));
    expect(editor().value).toBe('my draft'); expect(editor().hidden).toBe(false);
    view.dispose(); backend.source = 'external edit'; view = mount();
    expect(editor().value).toBe('my draft'); expect(editor().hidden).toBe(false);
  });
  it('saves with Ctrl+S and refuses changes that cannot survive a reload', async () => {
    await edit(); type('accepted draft');
    const storage = sessionStorage;
    vi.stubGlobal('sessionStorage', {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: () => { throw new Error('quota exceeded'); },
    });
    type('unbacked change');
    expect(editor().value).toBe('accepted draft');
    expect(markdownDraft(99)?.text).toBe('accepted draft');
    expect(view.root.querySelector('.markdown-banner')?.textContent).toContain('not accepted');
    vi.unstubAllGlobals();
    editor().dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => expect(backend.save).toHaveBeenCalledWith(null, '/tmp/note.md', '# 원문\r\n', 'accepted draft'));
  });
  it('uses the saved base after a tab remount while saving', async () => {
    let finish!: () => void;
    backend.save.mockImplementationOnce(async () => new Promise<void>((resolve) => { finish = resolve; }));
    await edit(); type('first edit'); click('.markdown-save');
    view.dispose(); view = mount();
    finish();
    await vi.waitFor(() => expect(markdownDraft(99)).toBeNull());
    type('second edit'); click('.markdown-save');
    await vi.waitFor(() => expect(backend.save).toHaveBeenLastCalledWith(null, '/tmp/note.md', 'first edit', 'second edit'));
  });
  it('does not steal focus from another pane when restoring or finishing a save', async () => {
    await edit(); type('draft'); view.dispose();
    const otherPane = document.createElement('input'); document.body.append(otherPane); otherPane.focus();
    view = mount();
    expect(document.activeElement).toBe(otherPane);
    let finish!: () => void;
    backend.save.mockImplementationOnce(async () => new Promise<void>((resolve) => { finish = resolve; }));
    click('.markdown-save');
    otherPane.focus(); finish();
    await vi.waitFor(() => expect(editor().hidden).toBe(true));
    expect(document.activeElement).toBe(otherPane);
  });
  it('renders a UTF-8 BOM file and preserves its BOM when saving', async () => {
    backend.source = '\uFEFF# Title\n';
    await edit();
    expect(view.root.querySelector('h1')?.textContent).toBe('Title');
    expect(editor().value).toBe('\uFEFF# Title\n');
    type('\uFEFF# Updated\n'); click('.markdown-save');
    await vi.waitFor(() => expect(backend.save).toHaveBeenCalledWith(null, '/tmp/note.md', '\uFEFF# Title\n', '\uFEFF# Updated\n'));
  });
  it('requires confirmation to discard edits and loads the current disk file', async () => {
    await edit(); type('draft'); const confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
    click('.markdown-cancel'); expect(editor().hidden).toBe(false);
    confirm.mockReturnValue(true); backend.source = '# external'; click('.markdown-cancel');
    await vi.waitFor(() => expect(view.root.querySelector('h1')?.textContent).toBe('external'));
    expect(markdownDraft(99)).toBeNull();
  });
});
