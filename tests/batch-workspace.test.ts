// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { BatchWorkspace } from '../packages/reader-runtime/src/batch-workspace';
import type { StreamBatch } from '../packages/content-model/src/stream';
const batch = (sequence = 1): StreamBatch => ({ schemaVersion: 1, sessionId: 'session', batchId: `b${sequence}`, requestId: 'r', batchSequence: sequence,
  items: sequence === 1 ? [{ id: 't', chapterId: 'c', sequence: 1, kind: 'title', data: { text: 'Chapter' } }] : [], status: 'complete', hasMore: true });
function setup() {
  const transport = { fetch: vi.fn(async () => ({ epoch: 'e', batch: batch() })), resource: vi.fn() };
  const view = { setLocalPrompt: vi.fn(), appendBatch: vi.fn((_batch: StreamBatch, _resolve?: (id: string) => string | undefined) => true), setDocument: vi.fn(), setStatus: vi.fn(), setNotice: vi.fn(), setNavigation: vi.fn(), scroller: document.createElement('div') };
  return { transport, view, workspace: new BatchWorkspace('session', transport, view) };
}
describe('batch workspace', () => {
  it('checks guidance after waking an initially frozen source and loads its image once', async () => {
    const { workspace, transport, view } = setup();
    const guidance = vi.fn().mockRejectedValueOnce(new Error('source-frozen')).mockResolvedValue({ epoch: 'e', message: '合成布局提示' });
    Object.assign(transport, { guidance });
    await workspace.connect();
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(view.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('来源页已被冻结'));
    transport.fetch.mockResolvedValue({ epoch: 'e', batch: { ...batch(), items: [...batch().items, { id: 'i', chapterId: 'c', sequence: 2, kind: 'image', data: { resourceId: 'image', alt: '合成图片' } }] } });
    transport.resource.mockResolvedValue({ epoch: 'e', data: 'data:image/png;base64,YQ==' });
    await workspace.connect();
    expect(guidance).toHaveBeenCalledTimes(2); expect(view.setLocalPrompt).toHaveBeenCalledExactlyOnceWith('合成布局提示', []);
    expect(transport.fetch).toHaveBeenLastCalledWith(expect.any(String), true);
    expect(transport.resource).toHaveBeenCalledExactlyOnceWith('image');
    const resolve = view.appendBatch.mock.calls[0]![1] as (id: string) => string | undefined;
    expect(resolve('image')).toBe('data:image/png;base64,YQ==');
    transport.fetch.mockResolvedValue({ epoch: 'e', batch: batch(2) }); await workspace.fetch();
    expect(guidance).toHaveBeenCalledTimes(2); expect(view.setLocalPrompt).toHaveBeenCalledOnce();
  });
  it('retains one startup notice when explicitly retrying an empty initial batch', async () => {
    const { workspace, transport, view } = setup();
    const guidance = vi.fn(async () => ({ epoch: 'e', message: '合成布局提示' })); Object.assign(transport, { guidance });
    transport.fetch.mockResolvedValueOnce({ epoch: 'e', batch: { ...batch(), items: [], status: 'partial', hasMore: false, reason: 'source-not-ready' } });
    await workspace.connect();
    transport.fetch.mockResolvedValue({ epoch: 'e', batch: { ...batch(2), items: batch().items } });
    await workspace.connect();
    expect(guidance).toHaveBeenCalledOnce(); expect(view.setLocalPrompt).toHaveBeenCalledOnce();
    expect(transport.fetch).toHaveBeenLastCalledWith(expect.any(String), true);
    expect(view.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: true, busy: false });
  });

  it('shows startup guidance before collection, once, even if the first batch stops with no content', async () => {
    const { workspace, transport, view } = setup();
    const guidance = vi.fn(async () => ({ epoch: 'e', message: '合成布局提示' })); Object.assign(transport, { guidance });
    transport.fetch.mockImplementation(async () => {
      expect(view.setLocalPrompt).toHaveBeenCalledExactlyOnceWith('合成布局提示', []);
      return { epoch: 'e', batch: { ...batch(), items: [], status: 'partial', hasMore: false } };
    });
    await workspace.connect(); await workspace.connect(); await workspace.fetch();
    expect(guidance).toHaveBeenCalledOnce(); expect(view.setLocalPrompt).toHaveBeenCalledOnce();
    expect(view.appendBatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ items: [] }), expect.any(Function));
  });
  it.each(['none', 'failed'])('continues reading without a prompt when guidance is %s', async mode => {
    const { workspace, transport, view } = setup();
    Object.assign(transport, { guidance: async () => { if (mode === 'failed') throw new Error('unavailable'); return { epoch: 'e' }; } });
    await workspace.connect();
    expect(transport.fetch).toHaveBeenCalledOnce(); expect(view.setLocalPrompt).not.toHaveBeenCalled();
  });
  it('discards pending guidance after a disconnect without beginning collection', async () => {
    const { workspace, transport, view } = setup();
    let resolve!: (value: { epoch: string; message: string }) => void;
    Object.assign(transport, { guidance: () => new Promise(done => { resolve = done; }) });
    const pending = workspace.connect(); workspace.disconnect(); resolve({ epoch: 'e', message: '旧实例提示' }); await pending;
    expect(view.setLocalPrompt).not.toHaveBeenCalled(); expect(transport.fetch).not.toHaveBeenCalled();
  });
  it('shows a slow-source recovery hint without unlocking or queuing another request', async () => {
    vi.useFakeTimers();
    try {
      const { workspace, transport, view } = setup(); let finish!: (value: { epoch: string; batch: StreamBatch }) => void;
      transport.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const pending = workspace.connect(); await vi.advanceTimersByTimeAsync(16000);
      expect(view.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('读取仍在等待'));
      await workspace.connect(); await workspace.fetch(); expect(transport.fetch).toHaveBeenCalledTimes(1);
      expect(view.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: false, busy: true });
      finish({ epoch: 'e', batch: batch() }); await pending;
      await vi.advanceTimersByTimeAsync(20000);
      expect(view.setNotice).toHaveBeenLastCalledWith('');
    } finally { vi.useRealTimers(); }
  });
  it('does not overwrite a disconnected notice with an old failed response', async () => {
    const { workspace, transport, view } = setup(); let fail!: (error: Error) => void;
    transport.fetch.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = workspace.connect(); workspace.disconnect(); fail(new Error('source-unavailable')); await pending;
    expect(view.setNotice).toHaveBeenLastCalledWith('来源已断开，已展示内容保留。');
  });
  it('retries a not-ready initial batch only after explicit recovery, retaining sequence order', async () => {
    const { workspace, transport, view } = setup();
    transport.fetch.mockResolvedValueOnce({ epoch: 'e', batch: { ...batch(), items: [], status: 'partial', hasMore: false, reason: 'source-not-ready' } });
    await workspace.connect(); await workspace.fetch(); expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(view.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('来源正文尚未准备好'));
    transport.fetch.mockResolvedValue({ epoch: 'e', batch: { ...batch(2), items: batch().items } });
    await workspace.connect();
    expect(transport.fetch).toHaveBeenLastCalledWith(expect.any(String), true);
    expect(view.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: true, busy: false });
    transport.fetch.mockResolvedValue({ epoch: 'e', batch: batch(3) }); await workspace.fetch();
    expect(transport.fetch).toHaveBeenLastCalledWith(expect.any(String), false);
  });
  it('can resume after an idle frozen tab is activated, without replaying the first chapter', async () => {
    const { workspace, transport, view } = setup(); await workspace.connect();
    transport.fetch.mockRejectedValueOnce(new Error('source-frozen')); await workspace.fetch();
    expect(view.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('来源页已被冻结'));
    await workspace.fetch(); expect(transport.fetch).toHaveBeenCalledTimes(2);
    transport.fetch.mockResolvedValue({ epoch: 'e', batch: batch(2) }); await workspace.connect();
    expect(transport.fetch).toHaveBeenLastCalledWith(expect.any(String), false);
    expect(view.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: true, busy: false });
  });
  it('tells the user how to recover a discarded page and refuses to mix new epochs into old content', async () => {
    const { workspace, transport, view } = setup(); await workspace.connect();
    transport.fetch.mockRejectedValueOnce(new Error('source-discarded')); await workspace.fetch();
    expect(view.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('重新加载'));
    transport.fetch.mockResolvedValue({ epoch: 'new', batch: batch() }); await workspace.connect(); await workspace.fetch();
    expect(transport.fetch).toHaveBeenCalledTimes(2); expect(view.appendBatch).toHaveBeenCalledTimes(1);
  });
  it('gives source and reader refresh steps when the source script is stale', async () => {
    const { workspace, transport, view } = setup();
    transport.fetch.mockRejectedValueOnce(new Error('source-reload-required'));
    await workspace.connect();
    expect(view.setNotice).toHaveBeenLastCalledWith('扩展更新后来源页面连接已失效。请先刷新来源页面，再刷新本阅读页。已显示的内容会保留。');
    expect(view.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: false, busy: false });
  });
  it('initializes automatically, then requests subsequent batches without page configuration', async () => {
    const { workspace, transport, view } = setup(); await workspace.connect();
    expect(transport.fetch).toHaveBeenCalledWith(expect.any(String), true);
    await workspace.connect(); expect(transport.fetch).toHaveBeenCalledTimes(1);
    transport.fetch.mockResolvedValue({ epoch: 'e', batch: batch(2) }); await workspace.fetch();
    expect(transport.fetch).toHaveBeenLastCalledWith(expect.any(String), false);
    expect(view.appendBatch).toHaveBeenCalledTimes(2);
    expect(view.setNotice).toHaveBeenLastCalledWith('本次未取得新增内容，可继续获取。');
    expect(view.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: true, busy: false });
    transport.fetch.mockResolvedValue({ epoch: 'e', batch: batch(3) }); await workspace.fetch();
    expect(transport.fetch).toHaveBeenCalledTimes(3);
  });
  it('rejects out-of-order batches without rendering and stops new requests', async () => {
    const { workspace, transport, view } = setup(); transport.fetch.mockResolvedValue({ epoch: 'e', batch: batch(2) });
    await workspace.connect(); await workspace.fetch(); expect(view.appendBatch).not.toHaveBeenCalled(); expect(transport.fetch).toHaveBeenCalledTimes(1);
  });
  it('ignores a response after disconnect', async () => {
    const { workspace, transport, view } = setup();
    let resolve!: (value: { epoch: string; batch: StreamBatch }) => void;
    transport.fetch.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = workspace.connect(); workspace.disconnect(); resolve({ epoch: 'e', batch: batch() }); await pending;
    expect(view.appendBatch).not.toHaveBeenCalled();
  });
  it('shows confirmed partial content and disables further collection', async () => {
    const { workspace, transport, view } = setup(); transport.fetch.mockResolvedValue({ epoch: 'e', batch: { ...batch(), status: 'partial', hasMore: false } });
    await workspace.connect(); await workspace.fetch(); expect(view.appendBatch).toHaveBeenCalledOnce(); expect(transport.fetch).toHaveBeenCalledOnce();
    expect(view.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: false, busy: false });
  });
});
