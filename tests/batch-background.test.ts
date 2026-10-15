import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handle: vi.fn(async () => ({ accepted: true })) }));
vi.mock('../packages/reader-runtime/src/session-broker', () => ({ SessionBroker: class { handle = mocks.handle; } }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); mocks.handle.mockClear(); });
it.each(['fetch-batch', 'read-resource', 'read-guidance'])('dispatches the new %s message to the authenticated broker', async type => {
  let receive!: (request: unknown, sender: unknown, reply: (value: unknown) => void) => boolean | undefined;
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', { runtime: { onInstalled: event(), onMessage: { addListener: (listener: typeof receive) => { receive = listener; } } },
    tabs: { onRemoved: event(), onUpdated: event(), onReplaced: event() }, commands: { onCommand: event() } });
  await import('../apps/extension-chromium/src/background');
  const request = { protocol: 'folioveil/2', type }, sender = { id: 'test' }, reply = vi.fn();
  expect(receive(request, sender, reply)).toBe(true);
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.handle).toHaveBeenCalledExactlyOnceWith(request, sender); expect(reply).toHaveBeenCalledWith({ accepted: true });
});
it.each(['source-reload-required', 'source-frozen', 'source-discarded'])('preserves %s across the background boundary', async reason => {
  let receive!: (request: unknown, sender: unknown, reply: (value: unknown) => void) => boolean | undefined;
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', { runtime: { onInstalled: event(), onMessage: { addListener: (listener: typeof receive) => { receive = listener; } } },
    tabs: { onRemoved: event(), onUpdated: event(), onReplaced: event() }, commands: { onCommand: event() } });
  mocks.handle.mockRejectedValueOnce(new Error(reason));
  await import('../apps/extension-chromium/src/background');
  const reply = vi.fn();
  expect(receive({ protocol: 'folioveil/2', type: 'fetch-batch' }, { id: 'test' }, reply)).toBe(true);
  await Promise.resolve(); await Promise.resolve();
  expect(reply).toHaveBeenCalledWith({ error: reason });
});
