// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL, RUNTIME_BUILD, type SourceSnapshot } from '../packages/reader-protocol/src/index';
import type { StreamBatch } from '../packages/content-model/src/stream';
import type { DisplayCallbacks } from '../packages/display-sdk/src/index';

const fixtures = vi.hoisted(() => ({ shell: undefined as any, controls: undefined as any, callbacks: undefined as DisplayCallbacks | undefined, loadFrame: vi.fn(), createAdapter: vi.fn() }));
vi.mock('../packages/theme-chatgpt/src/captured-frame', () => ({ loadCapturedFrame: (...args: unknown[]) => fixtures.loadFrame(...args) }));
vi.mock('../packages/theme-chatgpt/src/index', () => ({ createCapturedChatGPTDisplayAdapter: (...args: unknown[]) => fixtures.createAdapter(...args) }));
vi.mock('../packages/core-runtime/src/controls-controller', () => ({ ControlsController: class {
  constructor() { return fixtures.controls; }
} }));

type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender) => void;
const worker = { id: 'extension', url: 'chrome-extension://extension/background.js' };
const snapshot = (id = 'current'): SourceSnapshot => ({
  epoch: 'source', revision: 1, status: 'ready',
  position: { documentId: id, chapter: '合成章节', page: '1', key: '1' },
  capabilities: { 'previous-page': false, 'next-page': false },
  document: { id, title: '合成标题', source: { kind: 'fixture' }, blocks: [{ id: 'p', type: 'paragraph', html: '明确标记的合成正文。' }], toc: [], warnings: [] }
});
const response = (id = 'current'): { epoch: string; batch: StreamBatch } => ({ epoch: 'source', batch: {
  schemaVersion: 1, sessionId: 'session-one', requestId: 'request', batchId: id, batchSequence: 1,
  items: [{ id: 'title', chapterId: 'chapter', sequence: 1, kind: 'title', data: { text: '合成标题' } }], status: 'complete', hasMore: true
} });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const cleanups: Array<() => void> = [];
async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
async function setup(options: { frame?: Promise<unknown>; waitForReady?: boolean } = {}) {
  vi.resetModules(); window.history.replaceState(null, '', '/?session=session-one');
  let privateMode = false;
  const shell = {
    mount: vi.fn(), unmount: vi.fn(), updateSettings: vi.fn(), setDocument: vi.fn(), appendBatch: vi.fn(() => true), setStatus: vi.fn(), setNotice: vi.fn(),
    setLocalPrompt: vi.fn(), setNavigation: vi.fn(), setSourceLocation: vi.fn(), locate: vi.fn(), scroller: document.createElement('main'),
    setPrivacy: vi.fn((value: boolean) => { privateMode = value; }), getPrivacy: vi.fn(() => privateMode)
  };
  const controls = { mount: vi.fn(), unmount: vi.fn(), updateSettings: vi.fn(), togglePanel: vi.fn() };
  fixtures.shell = shell; fixtures.controls = controls; fixtures.callbacks = undefined;
  const frame = { verifiedLocalFrame: true };
  fixtures.loadFrame.mockReset().mockImplementation(() => options.frame ?? Promise.resolve(frame));
  fixtures.createAdapter.mockReset().mockReturnValue({ create: (_settings: unknown, callbacks: DisplayCallbacks) => { fixtures.callbacks = callbacks; return fixtures.shell; } });
  const read = deferred<ReturnType<typeof response>>();
  let receive!: MessageListener;
  const api = {
    runtime: {
      id: 'extension', getURL: (path: string) => 'chrome-extension://extension/' + path,
      sendMessage: vi.fn(async (request: { type: string }) => request.type === 'fetch-batch' ? read.promise : request.type === 'read-guidance' ? { epoch: 'source' } : { ok: true }),
      onMessage: { addListener: vi.fn((listener: MessageListener) => { receive = listener; }) }
    },
    tabs: { getCurrent: vi.fn(async () => ({ id: 7 })) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) }, onChanged: { addListener: vi.fn() } }
  };
  vi.stubGlobal('chrome', api);
  const events = vi.spyOn(window, 'addEventListener');
  await import('../apps/extension-chromium/src/reader'); await flush();
  if (options.waitForReady !== false) {
    // A failed async boot must report its boundary failure here, not wait on a
    // listener-registration promise that can never resolve.
    expect(api.runtime.onMessage.addListener, document.body.textContent ?? 'reader startup').toHaveBeenCalledOnce();
    expect(fixtures.loadFrame).toHaveBeenCalledExactlyOnceWith('chrome-extension://extension/themes/chatgpt/');
    expect(fixtures.createAdapter).toHaveBeenCalledExactlyOnceWith(frame);
  }
  cleanups.push(() => { for (const [name, listener] of events.mock.calls) if (name === 'pagehide') window.removeEventListener(name, listener); });
  return { shell, controls, api, read, callbacks: fixtures.callbacks!, emit: (event: unknown, sender: chrome.runtime.MessageSender = worker) => receive(event, sender) };
}
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

describe('reader entry event build boundary', () => {
  it('waits for validated local theme data before creating the display or reading the source', async () => {
    const frame = deferred<unknown>();
    const { shell, controls, api, read, emit } = await setup({ frame: frame.promise, waitForReady: false });
    expect(fixtures.loadFrame).toHaveBeenCalledExactlyOnceWith('chrome-extension://extension/themes/chatgpt/');
    expect(fixtures.createAdapter).not.toHaveBeenCalled(); expect(shell.mount).not.toHaveBeenCalled();
    expect(controls.mount).not.toHaveBeenCalled(); expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    expect(api.runtime.onMessage.addListener).not.toHaveBeenCalled();
    const verifiedFrame = { verifiedLocalFrame: true };
    frame.resolve(verifiedFrame); await flush();
    expect(fixtures.createAdapter).toHaveBeenCalledExactlyOnceWith(verifiedFrame);
    expect(shell.mount).toHaveBeenCalledOnce(); expect(api.runtime.onMessage.addListener).toHaveBeenCalledOnce();
    expect(api.runtime.sendMessage).toHaveBeenNthCalledWith(1, { protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'read-guidance', sessionId: 'session-one' });
    expect(api.runtime.sendMessage).toHaveBeenNthCalledWith(2, { protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'fetch-batch', sessionId: 'session-one', requestId: expect.any(String), initial: true });
    emit({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'snapshot', sessionId: 'session-one', snapshot: snapshot() });
    expect(shell.appendBatch).not.toHaveBeenCalled();
    read.resolve(response()); await flush();
  });

  it('reports failed local theme validation without starting a source read or accepting controls', async () => {
    const frame = deferred<unknown>();
    const { shell, controls, api } = await setup({ frame: frame.promise, waitForReady: false });
    frame.reject(new Error('captured-theme:resource-hash-mismatch:frame.html')); await flush();
    expect(document.body.textContent).toContain('本地展示资源不完整或版本不一致');
    expect(fixtures.createAdapter).not.toHaveBeenCalled(); expect(shell.mount).not.toHaveBeenCalled();
    expect(controls.mount).not.toHaveBeenCalled(); expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    expect(api.runtime.onMessage.addListener).not.toHaveBeenCalled();
  });

  it('routes current-build snapshots, lifecycle events, and controls normally', async () => {
    const { shell, controls, api, read, emit } = await setup();
    const event = { protocol: PROTOCOL, build: RUNTIME_BUILD, sessionId: 'session-one' };
    emit({ ...event, type: 'snapshot', snapshot: snapshot() });
    expect(shell.appendBatch).not.toHaveBeenCalled();
    emit({ ...event, type: 'source-loading' });
    expect(shell.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('等待来源正文出现，再刷新本阅读页'));
    emit({ ...event, type: 'reconnected' }); await flush();
    expect(api.runtime.sendMessage).toHaveBeenCalledTimes(2);
    emit({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'control', readerTabId: 7, action: 'controls' });
    expect(controls.togglePanel).toHaveBeenCalledOnce();
    emit({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'control', readerTabId: 7, action: 'privacy' });
    expect(shell.setPrivacy).toHaveBeenCalledExactlyOnceWith(true);
    emit({ ...event, type: 'disconnected' });
    expect(shell.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('来源已断开'));
    read.resolve(response()); await flush();
    expect(shell.appendBatch).not.toHaveBeenCalled();
  });

  it.each(['older-worker-build', undefined])('rejects snapshot build %s before a pending initial read can render', async build => {
    const { shell, api, read, callbacks, emit } = await setup();
    emit({ protocol: PROTOCOL, ...(build === undefined ? {} : { build }), type: 'snapshot', sessionId: 'session-one', snapshot: snapshot('old-worker') });
    expect(shell.appendBatch).not.toHaveBeenCalled();
    expect(shell.setStatus).toHaveBeenLastCalledWith('error', expect.stringContaining('版本不一致'));
    read.resolve(response('late-read')); await flush();
    expect(shell.appendBatch).not.toHaveBeenCalled();
    emit({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'snapshot', sessionId: 'session-one', snapshot: snapshot('late-event') });
    callbacks.onRetry!(); await flush();
    expect(shell.appendBatch).not.toHaveBeenCalled();
    expect(api.runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(shell.setStatus).toHaveBeenLastCalledWith('error', expect.stringContaining('版本不一致'));
  });

  it.each(['disconnected', 'source-loading', 'reconnected', 'control'])('rejects a missing build on %s without invoking its behavior', async type => {
    const { shell, controls, api, read, emit } = await setup();
    emit({ protocol: PROTOCOL, type, sessionId: 'session-one', readerTabId: 7, action: 'privacy' });
    expect(shell.setStatus).toHaveBeenLastCalledWith('error', expect.stringContaining('版本不一致'));
    expect(shell.setPrivacy).not.toHaveBeenCalled(); expect(controls.togglePanel).not.toHaveBeenCalled();
    expect(api.runtime.sendMessage).toHaveBeenCalledTimes(2);
    read.resolve(response()); await flush(); expect(shell.appendBatch).not.toHaveBeenCalled();
  });

  it('clears already rendered content and refuses later events from an incompatible worker', async () => {
    const { shell, controls, read, emit } = await setup();
    read.resolve(response()); await flush(); expect(shell.appendBatch).toHaveBeenCalledOnce();
    emit({ protocol: PROTOCOL, build: 'old', type: 'snapshot', sessionId: 'session-one', snapshot: snapshot('wrong') });
    expect(shell.setStatus).toHaveBeenLastCalledWith('error', expect.stringContaining('版本不一致'));
    emit({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'control', readerTabId: 7, action: 'controls' });
    expect(controls.togglePanel).not.toHaveBeenCalled(); expect(shell.appendBatch).toHaveBeenCalledOnce();
  });

  it('ignores unrelated sessions, other reader tabs, unknown types, and content-script senders', async () => {
    const { shell, read, emit } = await setup();
    emit({ protocol: PROTOCOL, type: 'snapshot', sessionId: 'different-session', snapshot: snapshot('wrong') });
    emit({ protocol: PROTOCOL, type: 'control', readerTabId: 999, action: 'privacy' });
    emit({ protocol: PROTOCOL, type: 'source-snapshot', sessionId: 'session-one', snapshot: snapshot('wrong') });
    emit({ protocol: PROTOCOL, type: 'snapshot', sessionId: 'session-one', snapshot: snapshot('wrong') }, { ...worker, tab: { id: 1 } as chrome.tabs.Tab });
    expect(shell.setStatus).not.toHaveBeenCalledWith('error', expect.anything());
    read.resolve(response()); await flush();
    expect(shell.appendBatch).toHaveBeenCalledExactlyOnceWith(response().batch, expect.any(Function));
  });
});
