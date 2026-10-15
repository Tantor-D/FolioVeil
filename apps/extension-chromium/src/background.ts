import { DEFAULT_SETTINGS, migrateSettings } from '../../../packages/storage/src/index';
import { isProtocolMessage, type ReaderRequest, type SourceInputRequest, type SourceWaitRequest, type SourceSnapshot } from '../../../packages/reader-protocol/src/index';
import { SessionBroker } from '../../../packages/reader-runtime/src/session-broker';
import { isWeReadUrl } from '../../../packages/adapter-weread/src/structured';
import { isFanqieReaderUrl } from '../../../packages/adapter-fanqie/src/index';
import { readWeReadImage } from '../../../packages/adapter-weread/src/image-resource';
const broker = new SessionBroker(chrome, url => isWeReadUrl(url) || isFanqieReaderUrl(url), readWeReadImage);
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: settings ? migrateSettings(settings) : structuredClone(DEFAULT_SETTINGS) }));
});
chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (!isProtocolMessage(request)) return;
  if (request.type === 'source-snapshot') { void broker.forward((request as unknown as { snapshot: SourceSnapshot }).snapshot, sender).catch(() => undefined); return; }
  if (request.type === 'source-ready') {
    const source = request as unknown as { epoch: string; version: string };
    void broker.ready(source.epoch, source.version, sender).catch(() => undefined); return;
  }
  if (request.type === 'source-wait') {
    void broker.wait(request as SourceWaitRequest, sender).then(reply).catch(() => reply({ ok: false }));
    return true;
  }
  if (request.type === 'source-input') {
    void broker.input(request as SourceInputRequest, sender).then(reply).catch(() => reply({ ok: false }));
    return true;
  }
  if (!['open', 'read', 'navigate', 'fetch-batch', 'read-resource', 'read-guidance', 'return-source', 'reload-source', 'list-reconnectable', 'reconnect', 'control-reader'].includes(request.type)) return;
  void broker.handle(request as ReaderRequest, sender).then(reply).catch(error => {
    const reason = error instanceof Error && ['source-frozen', 'source-discarded', 'source-reload-required', 'source-version-mismatch', 'source-build-mismatch', 'reader-build-mismatch', 'source-already-bound', 'session-unavailable', 'unauthorized', 'invalid-request'].includes(error.message) ? error.message : 'source-unavailable';
    reply({ error: reason });
  });
  return true;
});
chrome.tabs.onRemoved.addListener(id => { void broker.removed(id).catch(() => undefined); });
chrome.tabs.onReplaced.addListener((added, removed) => { void broker.replaced(added, removed).catch(() => undefined); });
chrome.tabs.onUpdated.addListener((id, change, tab) => { if (change.url || change.status) void broker.updated(id, change, tab).catch(() => undefined); });
chrome.commands.onCommand.addListener(command => {
  if (command !== 'toggle-privacy' && command !== 'toggle-controls') return;
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id !== undefined) return broker.control(tab.id, command === 'toggle-privacy' ? 'privacy' : 'controls');
  }).catch(() => undefined);
});
