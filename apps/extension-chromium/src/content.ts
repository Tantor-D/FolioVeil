import { WeReadSourceAdapter, type TrustedChapterClick } from '../../../packages/adapter-weread/src/source-adapter';
import { isWeReadUrl } from '../../../packages/adapter-weread/src/structured';
import { WeReadBatchSource } from '../../../packages/adapter-weread/src/batch-source';
import { readWeReadGuidance } from '../../../packages/adapter-weread/src/reading-guidance';
import { FanqieBatchSource, isFanqieReaderUrl } from '../../../packages/adapter-fanqie/src/index';
import { PROTOCOL, RUNTIME_VERSION, RUNTIME_BUILD, isProtocolMessage, isNavigation, type SourceInputRequest, type SourceRequest } from '../../../packages/reader-protocol/src/index';

// Source-only entry: no shell, isolation, title changes or preference-driven overlay.
if (isWeReadUrl(location.href)) {
  const sendInput = async (element: HTMLElement, phase: SourceInputRequest['phase'], context: { requestId: string; expectedPosition: string; expectedEpoch: string; route: string }) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
    const hit = document.elementFromPoint(x, y);
    if (!rect.width || !rect.height || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight || !hit || !(hit === element || element.contains(hit))) throw new Error('trusted-input-unavailable');
    const request: SourceInputRequest = { protocol: PROTOCOL, type: 'source-input', build: RUNTIME_BUILD,
      phase, requestId: context.requestId, expectedPosition: context.expectedPosition, expectedEpoch: context.expectedEpoch,
      route: context.route, x, y, viewportWidth, viewportHeight };
    const response = await chrome.runtime.sendMessage(request).catch(() => undefined) as { ok?: boolean; uncertain?: boolean } | undefined;
    if (!response?.ok) throw new Error(response?.uncertain ? 'trusted-input-uncertain' : 'trusted-input-unavailable');
  };
  const trustedClick: TrustedChapterClick = sendInput;
  // Allow bounded time for background input, catalog animation and body confirmation.
  const adapter = new WeReadSourceAdapter(document, () => location.href, 30000, undefined, trustedClick);
  adapter.start();
  const waitForSource = async (milliseconds: number) => {
    const response = await chrome.runtime.sendMessage({ protocol: PROTOCOL, type: 'source-wait', build: RUNTIME_BUILD, milliseconds });
    if (!response?.ok) throw new Error('source-scheduler-unavailable');
  };
  const batches = new WeReadBatchSource(document, () => location.href, undefined, waitForSource, async (button, context) => {
    if (location.href !== context.route) throw new Error('source-position-changed');
    await sendInput(button, 'batch-chapter', { ...context, expectedPosition: context.route, expectedEpoch: adapter.snapshot().epoch });
  }); batches.start();
  let announcedEpoch = '';
  const announce = () => {
    const epoch = adapter.snapshot().epoch;
    if (announcedEpoch === epoch) return;
    announcedEpoch = epoch;
    void chrome.runtime.sendMessage({ protocol: PROTOCOL, type: 'source-ready', epoch, version: RUNTIME_VERSION, build: RUNTIME_BUILD }).catch(() => undefined);
  };
  adapter.subscribe(snapshot => { announce(); void chrome.runtime.sendMessage({ protocol: PROTOCOL, type: 'source-snapshot', snapshot }).catch(() => undefined); });
  chrome.runtime.onMessage.addListener((value: unknown, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !isProtocolMessage(value)) return;
    const request = value as SourceRequest;
    if (request.type === 'source-read-guidance') {
      const epoch = adapter.snapshot().epoch;
      if (request.expectedEpoch !== epoch) { reply({ error: 'source-unavailable' }); return; }
      void readWeReadGuidance(document, waitForSource).then(message => {
        reply(adapter.snapshot().epoch === epoch ? { epoch, message } : { error: 'source-unavailable' });
      }).catch(() => reply({ error: 'source-unavailable' }));
      return true;
    }
    if (request.type === 'source-fetch-batch' || request.type === 'source-resolve-resource') {
      if (request.expectedEpoch !== adapter.snapshot().epoch) { reply({ error: 'source-unavailable' }); return; }
      const epoch = adapter.snapshot().epoch;
      const result = request.type === 'source-fetch-batch'
        ? batches.fetch(request.sessionId, request.requestId, request.initial).then(batch => ({ epoch, batch }))
        : Promise.resolve().then(() => ({ epoch, src: batches.resolveResource(request.sessionId, request.resourceId) }));
      void result.then(reply).catch(() => reply({ error: 'source-unavailable' })); return true;
    }
    if (request.type === 'source-ping') { reply({ epoch: adapter.snapshot().epoch, version: RUNTIME_VERSION, build: RUNTIME_BUILD }); return; }
    if ((request.type === 'source-read' || request.type === 'source-navigate') && request.expectedEpoch !== adapter.snapshot().epoch) { reply({ error: 'source-unavailable' }); return; }
    if (request.type === 'source-read') { void adapter.read().then(reply).catch(() => reply({ error: 'source-unavailable' })); return true; }
    if (request.type === 'source-navigate' && isNavigation(request.action) && typeof request.requestId === 'string' && typeof request.expectedPosition === 'string') {
      void adapter.perform(request.action, request.requestId, request.expectedPosition, request.expectedEpoch).then(reply).catch(() => reply({ error: 'source-unavailable' })); return true;
    }
  });
  announce();
  window.addEventListener('pageshow', event => { if (event.persisted) { announcedEpoch = ''; announce(); } });
  window.addEventListener('pagehide', event => { if (!event.persisted) { adapter.stop(); batches.stop(); } });
}
if (isFanqieReaderUrl(location.href)) {
  const epoch = crypto.randomUUID();
  const batches = new FanqieBatchSource(document, () => location.href);
  const announce = () => { void chrome.runtime.sendMessage({ protocol: PROTOCOL, type: 'source-ready', epoch,
    version: RUNTIME_VERSION, build: RUNTIME_BUILD }).catch(() => undefined); };
  chrome.runtime.onMessage.addListener((value: unknown, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !isProtocolMessage(value)) return;
    const request = value as SourceRequest;
    if (request.type === 'source-read-guidance') {
      reply(request.expectedEpoch === epoch ? { epoch } : { error: 'source-unavailable' }); return;
    }
    if (request.type === 'source-ping') { reply({ epoch, version: RUNTIME_VERSION, build: RUNTIME_BUILD }); return; }
    if (request.type === 'source-fetch-batch') {
      if (request.expectedEpoch !== epoch) { reply({ error: 'source-unavailable' }); return; }
      void batches.fetch(request.sessionId, request.requestId, request.initial).then(batch => reply({ epoch, batch }))
        .catch(() => reply({ error: 'source-unavailable' })); return true;
    }
    if (request.type === 'source-resolve-resource') { reply({ error: 'resource-unavailable' }); return; }
  });
  announce();
  window.addEventListener('pageshow', event => { if (event.persisted) announce(); });
  window.addEventListener('pagehide', event => { if (!event.persisted) batches.stop(); });
}
