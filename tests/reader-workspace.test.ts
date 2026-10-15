// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ReaderWorkspace, type ReaderTransport } from '../packages/reader-runtime/src/workspace';
import type { OperationResult, SourceSnapshot } from '../packages/reader-protocol/src/index';
import { ChatReaderShell } from '../packages/reader-view/src/chat-shell';
import { DEFAULT_SETTINGS } from '../packages/storage/src/index';

const snapshot = (epoch = 'a', revision = 1, documentId = 'doc'): SourceSnapshot => ({ epoch, revision, status: 'ready', position: { documentId, chapter: '合成章', page: String(revision), key: `${epoch}:${revision}` }, capabilities: { 'next-page': true, 'previous-page': true }, document: { id: documentId, title: '合成标题', source: { kind: 'fixture' }, blocks: [{ id: `${documentId}:p`, type: 'paragraph', html: '专用合成测试文本。' }], toc: [], warnings: [] } });
const mapped = (value: SourceSnapshot): SourceSnapshot => ({ ...value, pageRange: { start: { documentId: value.document!.id, blockId: value.document!.blocks[0]!.id, offset: 0 }, end: { documentId: value.document!.id, blockId: value.document!.blocks[0]!.id, offset: 5 }, signature: 'synthetic-range', evidence: 'dom-range' } });
const view = () => ({ setDocument: vi.fn(), setStatus: vi.fn(), setNotice: vi.fn(), setNavigation: vi.fn(), setSourceLocation: vi.fn(), locate: vi.fn(() => true), scroller: document.createElement('main') });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function pendingNavigation() {
  const pending: Array<{ requestId: string; response: ReturnType<typeof deferred<OperationResult>> }> = [];
  const navigate = vi.fn<ReaderTransport['navigate']>((_action, requestId) => {
    const response = deferred<OperationResult>(); pending.push({ requestId, response }); return response.promise;
  });
  return { navigate, pending, finish(index: number, value: SourceSnapshot, ok = true) { const item = pending[index]!; item.response.resolve({ requestId: item.requestId, ok, ...(ok ? {} : { reason: 'not-confirmed' as const }), snapshot: value }); } };
}

describe('source-independent workspace', () => {
  it('keeps the displayed chapter when reconnection cannot obtain the new body', async () => {
    const display = view();
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({ ...snapshot('b'), status: 'unavailable', document: undefined });
    const workspace = new ReaderWorkspace({ read, navigate: vi.fn() }, display);
    await workspace.connect(); display.setStatus.mockClear(); display.scroller.scrollTop = 390;
    workspace.sourceLoading(); await workspace.connect();
    expect(display.setStatus).not.toHaveBeenCalled();
    expect(display.setDocument).toHaveBeenCalledTimes(1);
    expect(display.scroller.scrollTop).toBe(390);
    expect(display.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('当前章节已保留'));
  });

  it('keeps the old chapter during loading and starts a confirmed new chapter at the top', async () => {
    const display = view(); const operation = pendingNavigation();
    const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: operation.navigate }, display);
    await workspace.connect(); display.scroller.scrollTop = 610;
    const navigating = workspace.navigate('next-page');
    expect(display.setDocument).toHaveBeenCalledTimes(1);
    expect(display.scroller.scrollTop).toBe(610);
    const target = snapshot('a', 2, 'second-chapter');
    target.position.chapter = '第二章'; target.document!.title = '第二章';
    operation.finish(0, target); await navigating;
    expect(display.setDocument).toHaveBeenLastCalledWith(target.document);
    expect(display.scroller.scrollTop).toBe(0);
    expect(display.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('从章首'));
    display.scroller.scrollTop = 480;
    const returning = workspace.navigate('previous-page');
    expect(display.scroller.scrollTop).toBe(480);
    operation.finish(1, snapshot('a', 3)); await returning;
    expect(display.setDocument).toHaveBeenLastCalledWith(snapshot('a', 3).document);
    expect(display.scroller.scrollTop).toBe(0);
  });
  it('renders immediately without inventing a source position when no mapping exists', async () => {
    const display = view(); const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: vi.fn() }, display);
    await workspace.connect(); workspace.accept(snapshot('a', 2));
    expect(display.setDocument).toHaveBeenCalledTimes(1);
    expect(display.locate).not.toHaveBeenCalled();
    expect(display.setSourceLocation).toHaveBeenLastCalledWith({ available: false, pendingChapter: false });
    expect(display.setStatus).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('uses an actual content anchor once on initial entry and leaves later source pushes local-position neutral', async () => {
    const display = view(); const first = mapped(snapshot());
    const workspace = new ReaderWorkspace({ read: async () => first, navigate: vi.fn() }, display);
    await workspace.connect(); display.scroller.scrollTop = 419;
    workspace.accept(mapped(snapshot('a', 2)));
    expect(display.locate).toHaveBeenCalledExactlyOnceWith(first.pageRange!.start);
    expect(display.scroller.scrollTop).toBe(419);
    expect(display.setDocument).toHaveBeenCalledTimes(1);
  });

  it('reports a failed initial anchor restoration rather than claiming a precise position', async () => {
    const display = view(); display.locate.mockReturnValue(false);
    const workspace = new ReaderWorkspace({ read: async () => mapped(snapshot()), navigate: vi.fn() }, display);
    await workspace.connect();
    expect(display.setNotice).toHaveBeenLastCalledWith(expect.stringMatching(/无法定位|未能定位|定位失败/));
  });

  it('does not accept a reversed range as a reliable source location', async () => {
    const display = view(); const value = mapped(snapshot());
    value.pageRange!.start.offset = 5; value.pageRange!.end.offset = 1;
    const workspace = new ReaderWorkspace({ read: async () => value, navigate: vi.fn() }, display);
    await workspace.connect(); workspace.locateSource();
    expect(display.locate).not.toHaveBeenCalled();
    expect(display.setSourceLocation).toHaveBeenLastCalledWith({ available: false, pendingChapter: false });
  });

  it('keeps another chapter pending until the user explicitly chooses a reliable mapped location', async () => {
    const display = view(); const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: vi.fn() }, display);
    await workspace.connect(); display.scroller.scrollTop = 680;
    const next = mapped(snapshot('a', 2, 'next-chapter'));
    workspace.accept(next);
    expect(display.setDocument).toHaveBeenCalledTimes(1);
    expect(display.scroller.scrollTop).toBe(680);
    expect(display.locate).not.toHaveBeenCalled();
    expect(display.setSourceLocation).toHaveBeenLastCalledWith({ available: true, pendingChapter: true });
    workspace.locateSource();
    expect(display.setDocument).toHaveBeenLastCalledWith(next.document);
    expect(display.locate).toHaveBeenLastCalledWith(next.pageRange!.start);
    expect(display.setSourceLocation).toHaveBeenLastCalledWith({ available: true, pendingChapter: false });
  });

  it('does not replace the old chapter when the pending chapter has no reliable map', async () => {
    const display = view(); const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: vi.fn() }, display);
    await workspace.connect(); workspace.accept(snapshot('a', 2, 'next-chapter')); workspace.locateSource();
    expect(display.setDocument).toHaveBeenCalledTimes(1);
    expect(display.locate).not.toHaveBeenCalled();
    expect(display.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('尚无可靠'));
    expect(display.setSourceLocation).toHaveBeenLastCalledWith({ available: false, pendingChapter: true });
  });

  it('does not commit or locate a failed chapter display and allows it to be selected again after reconnect', async () => {
    const display = view(); let current = mapped(snapshot());
    const workspace = new ReaderWorkspace({ read: async () => current, navigate: vi.fn() }, display);
    await workspace.connect(); display.locate.mockClear();
    current = mapped(snapshot('a', 2, 'next-chapter')); workspace.accept(current);
    display.setDocument.mockImplementationOnce(() => { throw new Error('fixture-render-failure'); });
    expect(() => workspace.locateSource()).not.toThrow();
    expect(display.locate).not.toHaveBeenCalled();
    expect(display.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('当前内容已保留'));
    expect(display.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: false, busy: false });
    await workspace.connect();
    expect(display.setSourceLocation).toHaveBeenLastCalledWith({ available: true, pendingChapter: true });
    workspace.locateSource();
    expect(display.setDocument).toHaveBeenCalledTimes(3);
    expect(display.locate).toHaveBeenCalledExactlyOnceWith(current.pageRange!.start);
    expect(display.setSourceLocation).toHaveBeenLastCalledWith({ available: true, pendingChapter: false });
  });

  it('does not leave a neutral conversation when a new chapter arrives in the background', async () => {
    const shell = new ChatReaderShell({ ...DEFAULT_SETTINGS }, { onSettings: vi.fn(), onRestore: vi.fn() });
    shell.mount();
    try {
      const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: vi.fn() }, shell);
      await workspace.connect();
      const neutral = [...shell.shadow.querySelectorAll<HTMLButtonElement>('.session')].find(button => button.textContent === '周报内容整理')!;
      neutral.click();
      const visibleConversation = shell.shadow.querySelector('.neutral-view');
      const next = mapped(snapshot('a', 2, 'next-chapter'));
      workspace.accept(next);
      expect(shell.isReading()).toBe(false);
      expect(shell.shadow.querySelector('.neutral-view')).toBe(visibleConversation);
      workspace.locateSource();
      expect(shell.isReading()).toBe(true);
      expect(shell.shadow.getElementById('next-chapter:p')).not.toBeNull();
    } finally { shell.unmount(); }
  });

  it('ignores retired source epochs and older revisions without altering display state', async () => {
    const display = view(); const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: vi.fn() }, display);
    await workspace.connect(); const current = snapshot('b', 5); current.document!.title = '新的合成标题'; workspace.accept(current);
    const documents = display.setDocument.mock.calls.length, notices = display.setNotice.mock.calls.length;
    expect(workspace.accept(snapshot('a', 99))).toBe(false);
    expect(workspace.accept(snapshot('b', 4))).toBe(false);
    expect(workspace.accept({ ...snapshot('b'), revision: Number.NaN })).toBe(false);
    expect(display.setDocument).toHaveBeenCalledTimes(documents);
    expect(display.setNotice).toHaveBeenCalledTimes(notices);
  });

  it('keeps local scrolling unchanged after a confirmed source operation', async () => {
    const display = view(); const operation = pendingNavigation();
    const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: operation.navigate }, display);
    await workspace.connect(); display.scroller.scrollTop = 572;
    const navigating = workspace.navigate('next-page');
    expect(operation.navigate).toHaveBeenCalledWith('next-page', expect.any(String), 'a:1', 'a');
    operation.finish(0, mapped(snapshot('a', 2))); await navigating;
    expect(display.scroller.scrollTop).toBe(572);
    expect(display.locate).not.toHaveBeenCalled();
    expect(display.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('本地阅读位置保留'));
  });

  it('keeps the last body and reports unconfirmed navigation without repeating it', async () => {
    const display = view(); const transport: ReaderTransport = { read: async () => snapshot(), navigate: vi.fn<ReaderTransport['navigate']>(async (_action, requestId) => ({ requestId, ok: false, reason: 'not-confirmed', snapshot: { ...snapshot(), operationState: 'uncertain' } })) };
    const workspace = new ReaderWorkspace(transport, display); await workspace.connect(); await workspace.navigate('next-page'); await workspace.navigate('next-page');
    expect(display.setDocument).toHaveBeenCalledTimes(1);
    expect(display.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('未确认'));
    expect(transport.navigate).toHaveBeenCalledTimes(1);
    expect(display.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: false, busy: false });
  });

  it('does not let an old epoch result or its finally clear a newer busy operation', async () => {
    const display = view(); const operation = pendingNavigation();
    const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: operation.navigate }, display);
    await workspace.connect(); const first = workspace.navigate('next-page');
    workspace.accept(snapshot('b', 1)); const second = workspace.navigate('previous-page');
    const notices = display.setNotice.mock.calls.length, navigation = display.setNavigation.mock.calls.length;
    operation.finish(0, snapshot('a', 2)); await first;
    expect(display.setNotice).toHaveBeenCalledTimes(notices);
    expect(display.setNavigation).toHaveBeenCalledTimes(navigation);
    expect(display.setNavigation).toHaveBeenLastCalledWith({ previous: true, next: true, busy: true });
    operation.finish(1, snapshot('b', 2)); await second;
    expect(display.setNavigation).toHaveBeenLastCalledWith({ previous: true, next: true, busy: false });
  });

  it('does not overwrite a newer pushed revision with an older operation result', async () => {
    const display = view(); const operation = pendingNavigation();
    const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: operation.navigate }, display);
    await workspace.connect(); const navigating = workspace.navigate('next-page'); workspace.accept(snapshot('a', 9));
    const notices = display.setNotice.mock.calls.length;
    operation.finish(0, snapshot('a', 2)); await navigating;
    expect(display.setNotice).toHaveBeenCalledTimes(notices);
    expect(display.scroller.scrollTop).toBe(0);
  });

  it.each([false, true])('only completes a delayed chapter acknowledgement when newer content still matches (changed=%s)', async changed => {
    const display = view(); const operation = pendingNavigation();
    const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: operation.navigate }, display);
    await workspace.connect(); display.scroller.scrollTop = 430;
    const navigating = workspace.navigate('next-page');
    const confirmed = snapshot('a', 2, 'second');
    const newer = snapshot('a', 9, 'second');
    if (changed) newer.document!.blocks = [{ id: 'second:p', type: 'paragraph', html: '尚未确认的另一份正文。' }];
    workspace.accept(newer);
    operation.finish(0, confirmed); await navigating;
    expect(display.setDocument).toHaveBeenLastCalledWith(changed ? snapshot().document : newer.document);
    expect(display.scroller.scrollTop).toBe(changed ? 430 : 0);
  });

  it('does not skip an undisplayed chapter after a failed navigation or unsolicited source change', async () => {
    const display = view(); const operation = pendingNavigation();
    const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: operation.navigate }, display);
    await workspace.connect();
    const navigating = workspace.navigate('next-page');
    const target = snapshot('a', 2, 'second');
    workspace.accept(target); operation.finish(0, target, false); await navigating;
    expect(display.setDocument).toHaveBeenCalledTimes(1);
    expect(display.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: false, busy: false });
    await workspace.navigate('next-page');
    expect(operation.navigate).toHaveBeenCalledTimes(1);
  });

  it('preserves the body during loading but cancels all old-operation side effects', async () => {
    const display = view(); const operation = pendingNavigation();
    const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: operation.navigate }, display);
    await workspace.connect(); display.scroller.scrollTop = 723;
    const navigating = workspace.navigate('next-page'); workspace.sourceLoading();
    const notices = display.setNotice.mock.calls.length;
    operation.finish(0, snapshot('a', 2)); await navigating;
    expect(display.setDocument).toHaveBeenCalledTimes(1);
    expect(display.setNotice).toHaveBeenCalledTimes(notices);
    expect(display.scroller.scrollTop).toBe(723);
    expect(display.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: false, busy: false });
    expect(workspace.accept(snapshot('a', 99))).toBe(false);
  });

  it('does not resurrect content or controls after the source closes', async () => {
    const display = view(); const reading = deferred<SourceSnapshot>();
    const workspace = new ReaderWorkspace({ read: () => reading.promise, navigate: vi.fn() }, display);
    const connecting = workspace.connect(); workspace.disconnect(); reading.resolve(snapshot()); await connecting;
    expect(workspace.accept(snapshot('new'))).toBe(false);
    expect(display.setDocument).not.toHaveBeenCalled();
    expect(display.setStatus).toHaveBeenLastCalledWith('error', expect.anything());
    expect(display.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: false, busy: false });
  });

  it('allows an explicit current read to reauthorize the same surviving source after a failed refresh', async () => {
    const display = view(); const workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: vi.fn() }, display);
    await workspace.connect(); workspace.sourceLoading(); workspace.disconnect();
    await workspace.connect();
    expect(display.setDocument).toHaveBeenCalledTimes(2);
    expect(display.setNavigation).toHaveBeenLastCalledWith({ previous: true, next: true, busy: false });
  });

  it('isolates multiple reconnects from earlier read success and failure', async () => {
    const display = view(); const oldRead = deferred<SourceSnapshot>(), currentRead = deferred<SourceSnapshot>();
    const read = vi.fn<ReaderTransport['read']>().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(currentRead.promise);
    const workspace = new ReaderWorkspace({ read, navigate: vi.fn() }, display);
    const first = workspace.connect(); const second = workspace.connect();
    const current = snapshot('current'); currentRead.resolve(current); await second;
    oldRead.reject(new Error('outdated connection')); await first;
    expect(display.setDocument).toHaveBeenCalledExactlyOnceWith(current.document);
    expect(display.setStatus).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('does not let a failed initial read erase a newer ready push', async () => {
    const display = view(); const reading = deferred<SourceSnapshot>();
    const workspace = new ReaderWorkspace({ read: () => reading.promise, navigate: vi.fn() }, display);
    const connecting = workspace.connect(); workspace.accept(snapshot('new')); reading.reject(new Error('old source disappeared')); await connecting;
    expect(display.setDocument).toHaveBeenCalledTimes(1);
    expect(display.setStatus).not.toHaveBeenCalledWith('error', expect.anything());
  });
});
