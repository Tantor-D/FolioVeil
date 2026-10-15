import { describe, expect, it, vi } from 'vitest';
import { SessionBroker } from '../packages/reader-runtime/src/session-broker';
import { PROTOCOL, RUNTIME_VERSION, RUNTIME_BUILD, type SourceInputRequest, type SourceSnapshot } from '../packages/reader-protocol/src/index';

const sourceUrl = (id: number) => `https://weread.qq.com/web/reader/synthetic-${id}`;
const snapshot = (epoch = 'source-1'): SourceSnapshot => ({ epoch, revision: 1, status: 'ready', position: { documentId: 'synthetic', chapter: '合成章', page: '1', key: '1' }, capabilities: { 'previous-page': true, 'next-page': true } });
function setup() {
  let data: Record<string, unknown> = {};
  let nextTabId = 2;
  const tabs = new Map<number, chrome.tabs.Tab>([[1, { id: 1, url: sourceUrl(1), windowId: 1, index: 0, active: false } as chrome.tabs.Tab]]);
  const epochs = new Map([[1, 'source-1']]);
  const versions = new Map([[1, RUNTIME_VERSION as string]]);
  const builds = new Map([[1, RUNTIME_BUILD]]);
  const api = {
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage: vi.fn(async (_message: unknown) => undefined) },
    windows: { update: vi.fn(async () => undefined), get: vi.fn(async () => ({ focused: true })) },
    debugger: { attach: vi.fn(async () => undefined), sendCommand: vi.fn(async (..._args: any[]) => undefined), detach: vi.fn(async () => undefined) },
    storage: { session: {
      get: vi.fn(async () => structuredClone(data)),
      set: vi.fn(async (patch: Record<string, unknown>) => { data = { ...data, ...structuredClone(patch) }; })
    } },
    tabs: {
      get: vi.fn(async (id: number) => { if (!tabs.has(id)) throw new Error('No tab'); return tabs.get(id)!; }),
      create: vi.fn(async (patch: chrome.tabs.CreateProperties) => { while (tabs.has(nextTabId)) nextTabId++; const tab = { id: nextTabId++, active: true, ...patch } as chrome.tabs.Tab; tabs.set(tab.id!, tab); return tab; }),
      update: vi.fn(async (id: number, patch: chrome.tabs.UpdateProperties) => { const tab = { ...tabs.get(id), ...patch } as chrome.tabs.Tab; tabs.set(id, tab); return tab; }),
      sendMessage: vi.fn(async (id: number, message: any, _options?: chrome.tabs.MessageSendOptions): Promise<any> => {
        if (!tabs.has(id)) throw new Error('No tab');
        if (message.type === 'source-ping') return { epoch: epochs.get(id), version: versions.get(id), build: builds.get(id) };
        if (message.type === 'source-read') return snapshot(epochs.get(id));
        if (message.type === 'source-navigate') return { requestId: message.requestId, ok: true, snapshot: snapshot(epochs.get(id)) };
        throw new Error('Unexpected message');
      }),
      reload: vi.fn(async (_id: number) => undefined)
    }
  };
  const readImage = vi.fn(async (_src: string, _source: string) => 'data:image/png;base64,AA==');
  const broker = new SessionBroker(api as unknown as typeof chrome, url => url.startsWith('https://weread.qq.com/web/reader/'), readImage);
  const popup = { id: 'test', url: api.runtime.getURL('popup.html') };
  const sourceSender = (id = 1) => ({ id: 'test', frameId: 0, url: sourceUrl(id), tab: tabs.get(id)! });
  const readerSender = (sessionId: string, readerTabId = 2) => ({ id: 'test', frameId: 0, url: api.runtime.getURL(`reader.html?session=${sessionId}`), tab: tabs.get(readerTabId)! });
  const open = async (sourceTabId = 1) => await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'open', sourceTabId }, popup) as { sessionId: string };
  const addSource = (id: number) => { tabs.set(id, { id, url: sourceUrl(id), windowId: 1, index: id } as chrome.tabs.Tab); epochs.set(id, `source-${id}`); versions.set(id, RUNTIME_VERSION); builds.set(id, RUNTIME_BUILD); };
  return { api, broker, readImage, tabs, epochs, versions, builds, popup, sourceSender, readerSender, open, addSource, getData: () => data };
}

describe('session routing', () => {
  it.each(['frozen', 'discarded'] as const)('does not queue startup guidance against a %s source', async state => {
    const { api, broker, open, readerSender, tabs } = setup();
    const { sessionId } = await open(); tabs.get(1)![state] = true; api.tabs.sendMessage.mockClear();
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read-guidance', sessionId }, readerSender(sessionId)))
      .rejects.toThrow(state === 'frozen' ? 'source-frozen' : 'source-discarded');
    expect(api.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('returns only bounded startup guidance from the reader’s own live source', async () => {
    const { api, broker, open, readerSender } = setup();
    const { sessionId } = await open();
    const original = api.tabs.sendMessage.getMockImplementation()!;
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => message.type === 'source-read-guidance'
      ? { epoch: 'source-1', message: '合成使用提示', privateMetadata: 'must not cross the boundary' } : original(id, message, options));
    const request = { protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read-guidance' as const, sessionId };
    await expect(broker.handle(request, { ...readerSender(sessionId), frameId: 1 })).rejects.toThrow('session-unavailable');
    expect(api.tabs.sendMessage).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'source-read-guidance' }), expect.anything());
    expect(await broker.handle(request, readerSender(sessionId))).toEqual({ epoch: 'source-1', message: '合成使用提示' });
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(1, { protocol: PROTOCOL, type: 'source-read-guidance', expectedEpoch: 'source-1' }, { frameId: 0 });
  });
  it.each(['replaced', 'oversized'])('rejects %s startup guidance', async mode => {
    const { api, broker, open, readerSender, epochs } = setup();
    const { sessionId } = await open();
    const original = api.tabs.sendMessage.getMockImplementation()!;
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
      if (message.type !== 'source-read-guidance') return original(id, message, options);
      if (mode === 'replaced') epochs.set(1, 'source-new');
      return { epoch: 'source-1', message: mode === 'oversized' ? 'x'.repeat(1001) : '旧实例提示' };
    });
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read-guidance', sessionId }, readerSender(sessionId))).rejects.toThrow('source-unavailable');
  });
  it('tracks the browser replacement of a discarded source and resumes only after reload', async () => {
    const { api, broker, open, readerSender, tabs, addSource, getData } = setup();
    const { sessionId } = await open();
    tabs.delete(1); addSource(3); tabs.get(3)!.discarded = true;
    api.tabs.sendMessage.mockClear(); api.runtime.sendMessage.mockClear();
    await broker.replaced(3, 1);
    expect(getData().readerBindings).toEqual([expect.objectContaining({ id: sessionId, sourceTabId: 3, state: 'loading' })]);
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'source-loading', sessionId }));
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'fetch-batch', sessionId, requestId: 'discarded', initial: true }, readerSender(sessionId))).rejects.toThrow('source-discarded');
    expect(api.tabs.sendMessage).not.toHaveBeenCalled();
    tabs.get(3)!.discarded = false;
    await broker.updated(3, { status: 'complete' }, tabs.get(3));
    expect(getData().readerBindings).toEqual([expect.objectContaining({ sourceTabId: 3, state: 'connected' })]);
    expect(api.tabs.sendMessage.mock.calls.every(([id]) => id === 3)).toBe(true);
  });
  it('does not revive a disconnected source through browser replacement', async () => {
    const { broker, open, tabs, addSource, getData } = setup();
    await open(); await broker.updated(1, { url: 'https://example.com/' });
    tabs.delete(1); addSource(3);
    await broker.replaced(3, 1);
    await broker.updated(3, { status: 'complete' }, tabs.get(3));
    expect(getData().readerBindings).toEqual([expect.objectContaining({ sourceTabId: 3, state: 'disconnected' })]);
  });
  it.each(['frozen', 'discarded'] as const)('does not queue collection against a %s source', async state => {
    const { api, broker, open, readerSender, tabs } = setup();
    const { sessionId } = await open(); tabs.get(1)![state] = true; api.tabs.sendMessage.mockClear();
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'fetch-batch', sessionId, requestId: 'sleeping', initial: true }, readerSender(sessionId)))
      .rejects.toThrow(state === 'frozen' ? 'source-frozen' : 'source-discarded');
    expect(api.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it('identifies an invalidated source script so the reader can show the refresh steps', async () => {
    const { api, broker, open, readerSender } = setup();
    const { sessionId } = await open();
    api.tabs.sendMessage.mockRejectedValueOnce(new Error('Extension context invalidated.'));
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'fetch-batch', sessionId, requestId: 'after-reload', initial: true }, readerSender(sessionId)))
      .rejects.toThrow('source-reload-required');
  });
  it.each([false, true])('waits for chapter loading to settle and checks whether the source instance changed: %s', async replaced => {
    const { api, broker, open, readerSender, epochs, tabs } = setup();
    const { sessionId } = await open(); api.runtime.sendMessage.mockClear();
    const original = api.tabs.sendMessage.getMockImplementation()!;
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
      if (message.type !== 'source-navigate') return original(id, message, options);
      const loading = broker.updated(id, { status: 'loading', url: sourceUrl(id) + '?chapter=2' }, tabs.get(id));
      if (replaced) epochs.set(id, 'replacement-document');
      await broker.updated(id, { status: 'complete' }, tabs.get(id));
      await loading;
      return { requestId: message.requestId, ok: true, snapshot: snapshot('source-1') };
    });
    const result = broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'navigate', sessionId, action: 'next-page', requestId: 'load-cycle', expectedPosition: '1', expectedEpoch: 'source-1' }, readerSender(sessionId));
    if (replaced) await expect(result).rejects.toThrow('source-unavailable');
    else {
      expect(await result).toMatchObject({ ok: true });
      expect(api.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'source-loading' }));
      expect(api.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'reconnected' }));
    }
  });

  it('limits debugger mouse input to the bound live reader navigation and detaches after each click', async () => {
    const { api, broker, open, readerSender, sourceSender } = setup();
    const { sessionId } = await open();
    const input = (phase: SourceInputRequest['phase']): SourceInputRequest => ({ protocol: PROTOCOL, type: 'source-input', build: RUNTIME_BUILD,
      phase, requestId: 'trusted-nav', expectedPosition: '1', expectedEpoch: 'source-1', route: sourceUrl(1), x: 120, y: 80, viewportWidth: 1200, viewportHeight: 800 });
    await expect(broker.input(input('catalog'), sourceSender())).rejects.toThrow('unauthorized');
    const original = api.tabs.sendMessage.getMockImplementation()!;
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
      if (message.type !== 'source-navigate') return original(id, message, options);
      await expect(broker.input({ ...input('catalog'), x: -1 }, sourceSender())).rejects.toThrow('unauthorized');
      await expect(broker.input({ ...input('catalog'), build: 'old-build' }, sourceSender())).rejects.toThrow('unauthorized');
      await expect(broker.input({ ...input('catalog'), route: sourceUrl(4) }, sourceSender())).rejects.toThrow('unauthorized');
      await expect(broker.input(input('catalog'), { ...sourceSender(), frameId: 1 })).rejects.toThrow('unauthorized');
      expect(await broker.input(input('catalog'), sourceSender())).toEqual({ ok: true });
      expect(await broker.input(input('chapter'), sourceSender())).toEqual({ ok: true });
      await expect(broker.input(input('chapter'), sourceSender())).rejects.toThrow('unauthorized');
      return { requestId: message.requestId, ok: true, snapshot: snapshot() };
    });
    await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'navigate', sessionId, action: 'next-page', requestId: 'trusted-nav', expectedPosition: '1', expectedEpoch: 'source-1' }, readerSender(sessionId));
    expect(api.debugger.attach).toHaveBeenCalledTimes(2);
    expect(api.debugger.sendCommand.mock.calls.map(([, method, params]) => [method, params.type])).toEqual([
      ['Input.dispatchMouseEvent', 'mouseMoved'], ['Input.dispatchMouseEvent', 'mousePressed'], ['Input.dispatchMouseEvent', 'mouseReleased'],
      ['Input.dispatchMouseEvent', 'mouseMoved'], ['Input.dispatchMouseEvent', 'mousePressed'], ['Input.dispatchMouseEvent', 'mouseReleased']
    ]);
    expect(api.debugger.detach).toHaveBeenCalledTimes(2);
    expect(api.debugger.sendCommand.mock.calls.map(([, , params]) => params.buttons)).toEqual([0, 1, 0, 0, 1, 0]);
    await expect(broker.input(input('chapter'), sourceSender())).rejects.toThrow('unauthorized');
  });

  it('does not dispatch input if debugger attachment is denied', async () => {
    const { api, broker, open, readerSender, sourceSender } = setup();
    const { sessionId } = await open();
    api.debugger.attach.mockRejectedValueOnce(new Error('denied'));
    const original = api.tabs.sendMessage.getMockImplementation()!;
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
      if (message.type !== 'source-navigate') return original(id, message, options);
      expect(await broker.input({ protocol: PROTOCOL, type: 'source-input', build: RUNTIME_BUILD, phase: 'catalog', requestId: 'denied-nav', expectedPosition: '1', expectedEpoch: 'source-1', route: sourceUrl(1), x: 120, y: 80, viewportWidth: 1200, viewportHeight: 800 }, sourceSender())).toEqual({ ok: false });
      return { requestId: message.requestId, ok: false, snapshot: snapshot() };
    });
    await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'navigate', sessionId, action: 'next-page', requestId: 'denied-nav', expectedPosition: '1', expectedEpoch: 'source-1' }, readerSender(sessionId));
    expect(api.debugger.sendCommand).not.toHaveBeenCalled();
    expect(api.debugger.detach).not.toHaveBeenCalled();
  });

  it('validates the live sender tab route when a content script retains its injection URL after a chapter change', async () => {
    const { api, broker, open, readerSender, sourceSender } = setup();
    const { sessionId } = await open();
    const request: SourceInputRequest = { protocol: PROTOCOL, type: 'source-input', build: RUNTIME_BUILD, phase: 'chapter', requestId: 'spa-chapter', expectedPosition: '1', expectedEpoch: 'source-1', route: sourceUrl(1), x: 120, y: 80, viewportWidth: 1200, viewportHeight: 800 };
    const original = api.tabs.sendMessage.getMockImplementation()!;
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
      if (message.type !== 'source-navigate') return original(id, message, options);
      const sender = sourceSender();
      await expect(broker.input(request, { ...sender, tab: { ...sender.tab, url: sourceUrl(4) } })).rejects.toThrow('unauthorized');
      expect(await broker.input(request, { ...sender, url: sourceUrl(4) })).toEqual({ ok: true });
      return { requestId: message.requestId, ok: true, snapshot: snapshot() };
    });
    await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'navigate', sessionId, action: 'next-page', requestId: 'spa-chapter', expectedPosition: '1', expectedEpoch: 'source-1' }, readerSender(sessionId));
    expect(api.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it('reserves an input phase before asynchronous checks so simultaneous repeats cannot click twice', async () => {
    const { api, broker, open, readerSender, sourceSender } = setup();
    const { sessionId } = await open();
    const original = api.tabs.sendMessage.getMockImplementation()!;
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
      if (message.type !== 'source-navigate') return original(id, message, options);
      const request: SourceInputRequest = { protocol: PROTOCOL, type: 'source-input', build: RUNTIME_BUILD, phase: 'catalog', requestId: 'concurrent', expectedPosition: '1', expectedEpoch: 'source-1', route: sourceUrl(1), x: 120, y: 80, viewportWidth: 1200, viewportHeight: 800 };
      const results = await Promise.allSettled([broker.input(request, sourceSender()), broker.input(request, sourceSender())]);
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
      return { requestId: message.requestId, ok: false, snapshot: snapshot() };
    });
    await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'navigate', sessionId, action: 'next-page', requestId: 'concurrent', expectedPosition: '1', expectedEpoch: 'source-1' }, readerSender(sessionId));
    expect(api.debugger.attach).toHaveBeenCalledTimes(1);
    expect(api.debugger.sendCommand.mock.calls.filter(([, , params]) => params.type === 'mousePressed')).toHaveLength(1);
  });

  it.each(['expired', 'inactive'])('cancels delayed attachment input if its reader request becomes %s', async state => {
    const { api, broker, open, readerSender, sourceSender, tabs } = setup();
    const { sessionId } = await open();
    let release!: () => void, attached!: () => void;
    const attaching = new Promise<void>(resolve => { attached = resolve; });
    api.debugger.attach.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); attached(); }));
    let input!: Promise<{ ok: boolean }>;
    const original = api.tabs.sendMessage.getMockImplementation()!;
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
      if (message.type !== 'source-navigate') return original(id, message, options);
      input = broker.input({ protocol: PROTOCOL, type: 'source-input', build: RUNTIME_BUILD, phase: 'catalog', requestId: 'delayed', expectedPosition: '1', expectedEpoch: 'source-1', route: sourceUrl(1), x: 120, y: 80, viewportWidth: 1200, viewportHeight: 800 }, sourceSender());
      await attaching;
      if (state === 'inactive') { tabs.get(2)!.active = false; release(); await input; }
      return { requestId: message.requestId, ok: false, snapshot: snapshot() };
    });
    await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'navigate', sessionId, action: 'next-page', requestId: 'delayed', expectedPosition: '1', expectedEpoch: 'source-1' }, readerSender(sessionId));
    if (state === 'expired') release();
    expect(await input).toEqual({ ok: false });
    expect(api.debugger.sendCommand).not.toHaveBeenCalled();
    expect(api.debugger.detach).toHaveBeenCalledTimes(1);
  });
  it('reuses a reader and persists only opaque bindings across worker restart', async () => {
    const { api, broker, getData, open, readerSender } = setup();
    const { sessionId } = await open(); await open();
    expect(api.tabs.create).toHaveBeenCalledTimes(1);
    expect(getData()).toEqual({ readerBindings: [{ id: sessionId, sourceTabId: 1, readerTabId: 2, state: 'connected' }] });
    const restarted = new SessionBroker(api as unknown as typeof chrome, url => url.startsWith('https://weread.qq.com/web/reader/'));
    await restarted.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read', sessionId }, readerSender(sessionId));
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(1, { protocol: PROTOCOL, type: 'source-read', expectedEpoch: 'source-1' }, { frameId: 0 });
    expect(broker).not.toBe(restarted);
  });

  it('refuses content scripts, forged popup tabs, other reader tabs, and reader subframes', async () => {
    const { api, broker, open, readerSender, sourceSender } = setup();
    const request = { protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'open' as const, sourceTabId: 1 };
    await expect(broker.handle(request, sourceSender())).rejects.toThrow('unauthorized');
    await expect(broker.handle(request, { id: 'test', url: api.runtime.getURL('popup.html'), tab: { id: 9 } as chrome.tabs.Tab })).rejects.toThrow('unauthorized');
    const { sessionId } = await open();
    const read = { protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read' as const, sessionId };
    await expect(broker.handle(read, { ...readerSender(sessionId), tab: { id: 99 } as chrome.tabs.Tab })).rejects.toThrow('session-unavailable');
    await expect(broker.handle(read, { ...readerSender(sessionId), frameId: 2 })).rejects.toThrow('session-unavailable');
  });

  it('rejects stale content-script versions and old expected epochs before navigation', async () => {
    const { api, broker, open, readerSender, versions } = setup();
    const { sessionId } = await open();
    versions.set(1, '0.3.0');
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read', sessionId }, readerSender(sessionId))).rejects.toThrow('source-version-mismatch');
    versions.set(1, RUNTIME_VERSION);
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'navigate', sessionId, action: 'next-page', requestId: 'one', expectedPosition: '1', expectedEpoch: 'old' }, readerSender(sessionId))).rejects.toThrow('source-unavailable');
    expect(api.tabs.sendMessage.mock.calls.some(([, message]) => message.type === 'source-navigate')).toBe(false);
  });

  it('refuses mixed builds even when all entry points advertise the same version', async () => {
    const { broker, open, readerSender, builds, popup } = setup();
    const { sessionId } = await open();
    builds.set(1, 'older-source-build');
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read', sessionId }, readerSender(sessionId))).rejects.toThrow('source-build-mismatch');
    builds.set(1, RUNTIME_BUILD);
    await expect(broker.handle({ protocol: PROTOCOL, build: 'older-reader-build', type: 'read', sessionId }, readerSender(sessionId))).rejects.toThrow('reader-build-mismatch');
    await expect(broker.handle({ protocol: PROTOCOL, type: 'open', sourceTabId: 1 }, popup)).rejects.toThrow('reader-build-mismatch');
  });

  it('marks a refresh loading and reconnects only after a current source handshake', async () => {
    const { api, broker, open, readerSender, epochs, sourceSender, getData } = setup();
    const { sessionId } = await open(); api.runtime.sendMessage.mockClear();
    await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'reload-source', sessionId }, readerSender(sessionId));
    expect(api.tabs.reload).toHaveBeenCalledWith(1);
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'source-loading', sessionId });
    epochs.set(1, 'refreshed');
    await broker.ready('source-1', RUNTIME_VERSION, sourceSender());
    expect((getData().readerBindings as any[])[0].state).toBe('loading');
    await broker.ready('refreshed', RUNTIME_VERSION, sourceSender());
    expect(api.runtime.sendMessage).toHaveBeenLastCalledWith({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'reconnected', sessionId });
  });

  it('keeps a source that left the site disconnected until the user retries', async () => {
    const { api, broker, tabs, epochs, open, readerSender, sourceSender, getData } = setup();
    const { sessionId } = await open();
    tabs.get(1)!.url = 'https://example.com/'; await broker.updated(1, { url: 'https://example.com/' }, tabs.get(1));
    tabs.get(1)!.url = sourceUrl(1); epochs.set(1, 'returned');
    await broker.updated(1, { url: sourceUrl(1), status: 'loading' }, tabs.get(1));
    await broker.ready('returned', RUNTIME_VERSION, sourceSender());
    await broker.forward(snapshot('returned'), sourceSender());
    expect((getData().readerBindings as any[])[0].state).toBe('disconnected');
    expect(api.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot' }));
    await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read', sessionId }, readerSender(sessionId));
    expect((getData().readerBindings as any[])[0].state).toBe('connected');
  });

  it('retains a closed source as an explicit reconnect choice, then removes it when its reader closes', async () => {
    const { api, broker, tabs, open, addSource, popup, getData } = setup();
    const { sessionId } = await open(); tabs.delete(1); await broker.removed(1);
    expect(getData()).toEqual({ readerBindings: [{ id: sessionId, sourceTabId: 1, readerTabId: 2, state: 'disconnected' }] });
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'disconnected', sessionId });
    addSource(4);
    expect(await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'list-reconnectable', sourceTabId: 4 }, popup)).toEqual([{ sessionId, readerTabId: 2, label: '当前窗口 · 第 2 个标签 · 阅读工作区' }]);
    // Listing choices never silently changes their source.
    expect((getData().readerBindings as any[])[0].sourceTabId).toBe(1);
    await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'reconnect', sourceTabId: 4, sessionId }, popup);
    expect(getData()).toEqual({ readerBindings: [{ id: sessionId, sourceTabId: 4, readerTabId: 2, state: 'connected' }] });
    await broker.removed(2); expect(getData()).toEqual({ readerBindings: [] });
  });

  it('does not let reconnect steal a live session or a source already bound to another reader', async () => {
    const { broker, tabs, open, addSource, popup } = setup();
    const { sessionId } = await open(); addSource(4);
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'reconnect', sourceTabId: 4, sessionId }, popup)).rejects.toThrow('session-unavailable');
    tabs.delete(1); await broker.removed(1); await open(4);
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'reconnect', sourceTabId: 4, sessionId }, popup)).rejects.toThrow('source-already-bound');
  });

  it('forwards only the current top-frame source epoch to its own session', async () => {
    const { api, broker, open, addSource, sourceSender, epochs } = setup();
    const first = await open(); addSource(4); const second = await open(4); api.runtime.sendMessage.mockClear();
    await broker.forward(snapshot('source-1'), { ...sourceSender(), frameId: 1 });
    epochs.set(1, 'new'); await broker.forward(snapshot('source-1'), sourceSender());
    expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    await broker.forward(snapshot('new'), sourceSender());
    expect(api.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'snapshot', sessionId: first.sessionId, snapshot: snapshot('new') });
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it('drops a read response that arrives after refresh or source rebinding', async () => {
    const { api, broker, open, readerSender, tabs, addSource, popup } = setup();
    const { sessionId } = await open();
    const original = api.tabs.sendMessage.getMockImplementation()!;
    let finish!: (value: SourceSnapshot) => void;
    let started!: () => void; const reading = new Promise<void>(resolve => { started = resolve; });
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
      if (message.type === 'source-read') { started(); return new Promise(resolve => { finish = resolve; }); }
      return original(id, message, options);
    });
    const response = broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read', sessionId }, readerSender(sessionId));
    const rejection = expect(response).rejects.toThrow('source-unavailable');
    await reading; tabs.delete(1); await broker.removed(1); addSource(4);
    await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'reconnect', sourceTabId: 4, sessionId }, popup);
    finish(snapshot('source-1')); await rejection;
  });

  it('rejects a pending navigation after full refresh but permits its confirmed SPA chapter epoch', async () => {
    const { api, broker, open, readerSender, epochs, tabs } = setup();
    const { sessionId } = await open();
    const original = api.tabs.sendMessage.getMockImplementation()!;
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
      if (message.type === 'source-navigate') {
        epochs.set(id, 'chapter-2'); tabs.get(id)!.url = sourceUrl(id) + '?chapter=2';
        await broker.updated(id, { url: tabs.get(id)!.url }, tabs.get(id));
        return { requestId: message.requestId, ok: true, snapshot: snapshot('chapter-2') };
      }
      return original(id, message, options);
    });
    const result = await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'navigate', sessionId, action: 'next-page', requestId: 'chapter', expectedPosition: '1', expectedEpoch: 'source-1' }, readerSender(sessionId));
    expect(result).toMatchObject({ ok: true, snapshot: { epoch: 'chapter-2' } });
    api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
      if (message.type === 'source-navigate') {
        await broker.updated(id, { status: 'loading' }, tabs.get(id));
        return { requestId: message.requestId, ok: true, snapshot: snapshot('chapter-2') };
      }
      return original(id, message, options);
    });
    await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'navigate', sessionId, action: 'next-page', requestId: 'refresh', expectedPosition: '1', expectedEpoch: 'chapter-2' }, readerSender(sessionId))).rejects.toThrow('source-unavailable');
  });

  it('authorizes popup controls through the broker rather than trusting content-script broadcasts', async () => {
    const { api, broker, open, popup, sourceSender } = setup(); await open(); api.runtime.sendMessage.mockClear();
    const request = { protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'control-reader' as const, readerTabId: 2, action: 'privacy' as const };
    await expect(broker.handle(request, sourceSender())).rejects.toThrow('unauthorized');
    await broker.handle(request, popup);
    expect(api.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'control', readerTabId: 2, action: 'privacy' });
    await expect(broker.control(1, 'controls')).rejects.toThrow('session-unavailable');
  });
});

it('routes batches and opaque image IDs only for the bound reader without debugger input', async () => {
  const { api, broker, open, readerSender, popup, tabs } = setup();
  const { sessionId } = await open(); const original = api.tabs.sendMessage.getMockImplementation()!;
  api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
    if (message.type === 'source-fetch-batch') {
      const loading = broker.updated(id, { status: 'loading' }, tabs.get(id));
      await broker.updated(id, { status: 'complete' }, tabs.get(id)); await loading;
      return { epoch: 'source-1', batch: { sessionId, batchId: 'b' } };
    }
    if (message.type === 'source-resolve-resource') return { epoch: 'source-1', src: 'https://res.weread.qq.com/wrepub/neutral.png' };
    return original(id, message, options);
  });
  const request = { protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'fetch-batch' as const, sessionId, requestId: 'r', initial: true };
  await expect(broker.handle(request, popup)).rejects.toThrow();
  expect(await broker.handle(request, readerSender(sessionId))).toMatchObject({ batch: { batchId: 'b' } });
  expect(await broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read-resource', sessionId, resourceId: 'image-id' }, readerSender(sessionId))).toMatchObject({ data: 'data:image/png;base64,AA==' });
  expect(api.debugger.attach).not.toHaveBeenCalled();
});


it('accepts only bounded scheduler requests from a current-build top-frame source', async () => {
  const { broker, sourceSender, popup } = setup();
  const request = { protocol: PROTOCOL, type: 'source-wait' as const, build: RUNTIME_BUILD, milliseconds: 0 };
  await expect(broker.wait(request, sourceSender())).resolves.toEqual({ ok: true });
  await expect(broker.wait(request, popup)).rejects.toThrow('unauthorized');
  await expect(broker.wait(request, { ...sourceSender(), frameId: 1 })).rejects.toThrow('unauthorized');
  await expect(broker.wait({ ...request, build: 'old' }, sourceSender())).rejects.toThrow('unauthorized');
  for (const milliseconds of [-1, NaN, Infinity, 10001]) {
    await expect(broker.wait({ ...request, milliseconds }, sourceSender())).rejects.toThrow('invalid-request');
  }
});

it.each([true, false])('authorizes one chapter input only for a noninitial batch: initial=%s', async initial => {
  const { api, broker, open, readerSender, sourceSender } = setup();
  const { sessionId } = await open();
  const request = { protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'fetch-batch' as const, sessionId, requestId: 'scroll', initial };
  const input: SourceInputRequest = { protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'source-input', phase: 'batch-chapter',
    requestId: 'scroll', expectedPosition: sourceUrl(1), expectedEpoch: 'source-1', route: sourceUrl(1), x: 120, y: 80, viewportWidth: 1200, viewportHeight: 800 };
  const original = api.tabs.sendMessage.getMockImplementation()!;
  api.tabs.sendMessage.mockImplementation(async (id, message, options) => {
    if (message.type !== 'source-fetch-batch') return original(id, message, options);
    await expect(broker.handle({ ...request, requestId: 'concurrent' }, readerSender(sessionId))).rejects.toThrow('busy');
    await expect(broker.input({ ...input, phase: 'catalog' }, sourceSender())).rejects.toThrow('unauthorized');
    await expect(broker.input({ ...input, requestId: 'foreign' }, sourceSender())).rejects.toThrow('unauthorized');
    if (initial) await expect(broker.input(input, sourceSender())).rejects.toThrow('unauthorized');
    else {
      const results = await Promise.allSettled([broker.input(input, sourceSender()), broker.input(input, sourceSender())]);
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
      expect(results[0]).toMatchObject({ value: { ok: true } });
    }
    return { epoch: 'source-1', batch: { sessionId, batchId: 'scroll-batch' } };
  });
  expect(await broker.handle(request, readerSender(sessionId))).toMatchObject({ batch: { batchId: 'scroll-batch' } });
  await expect(broker.input(input, sourceSender())).rejects.toThrow('unauthorized');
  expect(api.debugger.attach).toHaveBeenCalledTimes(initial ? 0 : 1);
  expect(api.debugger.detach).toHaveBeenCalledTimes(initial ? 0 : 1);
  expect(api.debugger.sendCommand).toHaveBeenCalledTimes(initial ? 0 : 3);
});


it.each(['epoch', 'binding', 'loading'])('discards image bytes when %s changes during the background read', async change => {
  const { api, broker, readImage, open, readerSender, epochs, tabs } = setup();
  const { sessionId } = await open();
  const original = api.tabs.sendMessage.getMockImplementation()!;
  api.tabs.sendMessage.mockImplementation(async (id, message, options) => message.type === 'source-resolve-resource'
    ? { epoch: 'source-1', src: 'https://res.weread.qq.com/wrepub/neutral.png' } : original(id, message, options));
  readImage.mockImplementation(async () => {
    if (change === 'epoch') epochs.set(1, 'new-instance');
    else if (change === 'binding') await broker.removed(2);
    else await broker.updated(1, { status: 'loading' }, tabs.get(1));
    return 'data:image/png;base64,AA==';
  });
  await expect(broker.handle({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read-resource', sessionId, resourceId: 'issued' }, readerSender(sessionId))).rejects.toThrow('source-unavailable');
  expect(readImage).toHaveBeenCalledExactlyOnceWith('https://res.weread.qq.com/wrepub/neutral.png', sourceUrl(1));
});

it('does not start a resource read for an unbound reader, wrong epoch, or unknown resource', async () => {
  const { api, broker, readImage, open, readerSender, popup } = setup();
  const { sessionId } = await open();
  const request = { protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read-resource' as const, sessionId, resourceId: 'unissued' };
  await expect(broker.handle(request, popup)).rejects.toThrow('session-unavailable');
  const original = api.tabs.sendMessage.getMockImplementation()!;
  api.tabs.sendMessage.mockImplementation(async (id, message, options) => message.type === 'source-resolve-resource'
    ? { epoch: 'old-instance', src: 'https://res.weread.qq.com/wrepub/neutral.png' } : original(id, message, options));
  await expect(broker.handle(request, readerSender(sessionId))).rejects.toThrow('source-unavailable');
  api.tabs.sendMessage.mockImplementation(async (id, message, options) => message.type === 'source-resolve-resource'
    ? { error: 'resource-unavailable' } : original(id, message, options));
  await expect(broker.handle(request, readerSender(sessionId))).rejects.toThrow('source-unavailable');
  expect(readImage).not.toHaveBeenCalled();
});
