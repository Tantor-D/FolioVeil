import { PROTOCOL, RUNTIME_VERSION, RUNTIME_BUILD, isNavigation, type ReaderEvent, type ReaderRequest, type SessionBinding, type SourceInputRequest, type SourceWaitRequest, type SourceSnapshot } from '../../reader-protocol/src/index';

type ConnectionState = 'connected' | 'loading' | 'disconnected';
type SourceInstance = { epoch: string; version: string; generation: number };
type ReconnectableSession = { sessionId: string; readerTabId: number; label: string };
type InputContext = { requestId: string; expectedPosition: string; epoch: string; route: string; generation: number; binding: SessionBinding; phases: Set<SourceInputRequest['phase']>; allowedPhases: SourceInputRequest['phase'][] };

/** The worker persists opaque tab bindings only. Source identity is verified live. */
export class SessionBroker {
  private mutation = Promise.resolve();
  private generations = new Map<number, number>();
  private disconnectedSources = new Set<number>();
  private trustedInput = new Map<number, InputContext>();
  private navigationLoads = new Map<number, { finish: (complete: boolean) => void; settled: Promise<void> }>();
  private batchOperations = new Map<number, { epoch: string; generation: number }>();
  constructor(private readonly api: typeof chrome, private readonly supportsSource: (url: string) => boolean,
    private readonly readImage?: (src: string, sourceUrl: string) => Promise<string>) {}

  private async bindings(): Promise<SessionBinding[]> {
    const result = await this.api.storage.session.get('readerBindings');
    return Array.isArray(result.readerBindings) ? result.readerBindings : [];
  }
  private save(bindings: SessionBinding[]): Promise<void> {
    // Whitelist fields: neither source snapshots nor URLs can enter session storage.
    return this.api.storage.session.set({ readerBindings: bindings.map(({ id, sourceTabId, readerTabId, state }) => ({ id, sourceTabId, readerTabId, ...(state ? { state } : {}) })) });
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutation.then(operation);
    this.mutation = task.then(() => undefined, () => undefined);
    return task;
  }
  private generation(tabId: number): number { return this.generations.get(tabId) ?? 0; }
  private invalidate(tabId: number): number {
    const generation = this.generation(tabId) + 1;
    this.generations.set(tabId, generation); return generation;
  }
  private isPopup(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === this.api.runtime.id && sender.url === this.api.runtime.getURL('popup.html') && !sender.tab;
  }
  private async source(tabId: number): Promise<chrome.tabs.Tab> {
    const source = await this.api.tabs.get(tabId).catch(() => undefined);
    if (!source || !this.supportsSource(source.url ?? '')) throw new Error('source-unavailable');
    return source;
  }
  private async reader(binding: SessionBinding): Promise<chrome.tabs.Tab | undefined> {
    if (binding.readerTabId === undefined) return;
    const tab = await this.api.tabs.get(binding.readerTabId).catch(() => undefined);
    return tab?.url === this.api.runtime.getURL(`reader.html?session=${binding.id}`) ? tab : undefined;
  }
  private async notify(type: 'source-loading' | 'reconnected' | 'disconnected', binding: SessionBinding): Promise<void> {
    await this.api.runtime.sendMessage({ protocol: PROTOCOL, build: RUNTIME_BUILD, type, sessionId: binding.id } satisfies ReaderEvent).catch(() => undefined);
  }
  private async setSourceState(tabId: number, state: ConnectionState, generation: number, notify = true): Promise<void> {
    await this.mutate(async () => {
      if (generation !== this.generation(tabId)) return;
      const bindings = await this.bindings();
      if (generation !== this.generation(tabId)) return;
      const changed = bindings.filter(binding => binding.sourceTabId === tabId && binding.state !== state);
      changed.forEach(binding => { binding.state = state; });
      if (changed.length) await this.save(bindings);
      if (notify && generation === this.generation(tabId)) {
        for (const binding of changed) await this.notify(state === 'connected' ? 'reconnected' : state === 'loading' ? 'source-loading' : 'disconnected', binding);
      }
    });
  }
  private async ping(tabId: number): Promise<SourceInstance> {
    const generation = this.generation(tabId);
    await this.source(tabId);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        this.api.tabs.sendMessage(tabId, { protocol: PROTOCOL, type: 'source-ping' }, { frameId: 0 }).catch(error => {
          if (error instanceof Error && /Extension context invalidated|Receiving end does not exist|Could not establish connection/i.test(error.message))
            throw new Error('source-reload-required');
          throw error;
        }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('source-unavailable')), 3000); })
      ]);
      if (generation !== this.generation(tabId) || !value || typeof value.epoch !== 'string' || !value.epoch || typeof value.version !== 'string') throw new Error('source-unavailable');
      if (value.version !== RUNTIME_VERSION) throw new Error('source-version-mismatch');
      if (value.build !== RUNTIME_BUILD) throw new Error('source-build-mismatch');
      return { epoch: value.epoch, version: value.version, generation };
    } finally { clearTimeout(timeout); }
  }
  private async assertCurrent(binding: SessionBinding, instance: SourceInstance, resultEpoch: string): Promise<void> {
    const current = (await this.bindings()).find(item => item.id === binding.id);
    if (!current || current.sourceTabId !== binding.sourceTabId || current.readerTabId !== binding.readerTabId || current.state === 'disconnected' || this.disconnectedSources.has(binding.sourceTabId) || this.generation(binding.sourceTabId) !== instance.generation) throw new Error('source-unavailable');
    const live = await this.ping(binding.sourceTabId);
    if (live.epoch !== resultEpoch || live.generation !== instance.generation) throw new Error('source-unavailable');
  }

  async handle(request: ReaderRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
    if (sender.id !== this.api.runtime.id) throw new Error('unauthorized');
    if ((request as { build?: string }).build !== RUNTIME_BUILD) throw new Error('reader-build-mismatch');
    if (request.type === 'control-reader') {
      if (!this.isPopup(sender)) throw new Error('unauthorized');
      return this.control(request.readerTabId, request.action);
    }
    if (request.type === 'open' || request.type === 'list-reconnectable' || request.type === 'reconnect') {
      if (!this.isPopup(sender) || !Number.isInteger(request.sourceTabId)) throw new Error('unauthorized');
      await this.source(request.sourceTabId);
      if (request.type === 'list-reconnectable') return this.listReconnectable(request.sourceTabId);
      if (request.type === 'reconnect') return this.reconnect(request.sourceTabId, request.sessionId);
      const result = await this.mutate(() => this.open(request.sourceTabId));
      await this.resumeSource(request.sourceTabId).catch(() => undefined);
      return result;
    }
    const binding = (await this.bindings()).find(item => item.id === request.sessionId);
    if (!binding || !Number.isInteger(sender.tab?.id) || sender.tab!.id !== binding.readerTabId || sender.frameId !== 0 || sender.url !== this.api.runtime.getURL(`reader.html?session=${binding.id}`)) throw new Error('session-unavailable');
    const requestGeneration = this.generation(binding.sourceTabId);
    const source = await this.source(binding.sourceTabId);
    if (requestGeneration !== this.generation(binding.sourceTabId)) throw new Error('source-unavailable');
    if (request.type === 'return-source') {
      await this.api.tabs.update(source.id!, { active: true });
      await this.api.windows.update(source.windowId, { focused: true }); return { ok: true };
    }
    if (request.type === 'reload-source') {
      this.disconnectedSources.delete(source.id!);
      await this.setSourceState(source.id!, 'loading', this.invalidate(source.id!));
      await this.api.tabs.reload(source.id!); return { ok: true };
    }
    if (request.type === 'read-guidance') {
      if (this.disconnectedSources.has(source.id!)) throw new Error('source-unavailable');
      if (source.discarded) throw new Error('source-discarded');
      if (source.frozen) throw new Error('source-frozen');
      const instance = await this.ping(source.id!);
      const result = await this.api.tabs.sendMessage(source.id!, { protocol: PROTOCOL, type: 'source-read-guidance', expectedEpoch: instance.epoch }, { frameId: 0 });
      if (result?.epoch !== instance.epoch || result.message !== undefined && (typeof result.message !== 'string' || result.message.length > 1000)) throw new Error('source-unavailable');
      await this.assertCurrent(binding, instance, result.epoch);
      return { epoch: result.epoch, ...(result.message ? { message: result.message } : {}) };
    }
    if (request.type === 'fetch-batch' || request.type === 'read-resource') {
      const id = request.type === 'fetch-batch' ? request.requestId : request.resourceId;
      if (typeof id !== 'string' || !id || id.length > 100 || request.type === 'fetch-batch' && typeof request.initial !== 'boolean') throw new Error('invalid-request');
      if (this.disconnectedSources.has(source.id!)) throw new Error('source-unavailable');
      // Do not let Chromium enqueue a new collection in a suspended document.
      if (source.discarded) throw new Error('source-discarded');
      if (source.frozen) throw new Error('source-frozen');
      const instance = await this.ping(source.id!);
      if (request.type === 'fetch-batch' && (this.batchOperations.has(source.id!) || this.trustedInput.has(source.id!))) throw new Error('busy');
      const context = { epoch: instance.epoch, generation: instance.generation };
      if (request.type === 'fetch-batch') this.batchOperations.set(source.id!, context);
      const inputContext: InputContext | undefined = request.type === 'fetch-batch' && !request.initial
        ? { ...context, requestId: request.requestId, expectedPosition: source.url!, route: source.url!, binding,
          phases: new Set(), allowedPhases: ['batch-chapter'] } : undefined;
      if (inputContext) this.trustedInput.set(source.id!, inputContext);
      try {
        const message = request.type === 'fetch-batch'
          ? { protocol: PROTOCOL, type: 'source-fetch-batch', sessionId: binding.id, requestId: request.requestId, initial: request.initial, expectedEpoch: instance.epoch }
          : { protocol: PROTOCOL, type: 'source-resolve-resource', sessionId: binding.id, resourceId: request.resourceId, expectedEpoch: instance.epoch };
        const result = await this.api.tabs.sendMessage(source.id!, message, { frameId: 0 });
        await this.navigationLoads.get(source.id!)?.settled;
        if (result?.epoch !== instance.epoch) throw new Error('source-unavailable');
        await this.assertCurrent(binding, instance, result.epoch);
        if (request.type === 'read-resource') {
          if (!this.readImage || typeof result.src !== 'string') throw new Error('resource-unavailable');
          const data = await this.readImage(result.src, source.url!);
          await this.assertCurrent(binding, instance, result.epoch);
          return { epoch: result.epoch, data };
        }
        return result;
      } finally {
        if (this.batchOperations.get(source.id!) === context) this.batchOperations.delete(source.id!);
        if (inputContext && this.trustedInput.get(source.id!) === inputContext) this.trustedInput.delete(source.id!);
      }
    }
    if (request.type !== 'read' && !(request.type === 'navigate' && isNavigation(request.action) && typeof request.requestId === 'string' && request.requestId.length > 0 && request.requestId.length < 100 && typeof request.expectedPosition === 'string' && typeof request.expectedEpoch === 'string')) throw new Error('invalid-request');
    if (request.type === 'read') {
      this.disconnectedSources.delete(source.id!);
      if (binding.state === 'disconnected') await this.setSourceState(source.id!, 'loading', this.generation(source.id!), false);
    }
    if (this.disconnectedSources.has(source.id!) || request.type === 'navigate' && binding.state === 'disconnected') throw new Error('source-unavailable');
    const instance = await this.ping(source.id!);
    if (request.type === 'navigate' && request.expectedEpoch !== instance.epoch) throw new Error('source-unavailable');
    await this.setSourceState(source.id!, 'connected', instance.generation, false);
    if (this.generation(source.id!) !== instance.generation) throw new Error('source-unavailable');
    const message = request.type === 'navigate'
      ? { protocol: PROTOCOL, type: 'source-navigate', action: request.action, requestId: request.requestId, expectedPosition: request.expectedPosition, expectedEpoch: instance.epoch }
      : { protocol: PROTOCOL, type: 'source-read', expectedEpoch: instance.epoch };
    const inputContext: InputContext | undefined = request.type === 'navigate'
      ? { requestId: request.requestId, expectedPosition: request.expectedPosition, epoch: instance.epoch, route: source.url!, generation: instance.generation, binding, phases: new Set(), allowedPhases: ['catalog', 'chapter'] }
      : undefined;
    if (inputContext) {
      if (this.trustedInput.has(source.id!) || this.batchOperations.has(source.id!)) throw new Error('source-unavailable');
      this.trustedInput.set(source.id!, inputContext);
    }
    try {
      const result = await this.api.tabs.sendMessage(source.id!, message, { frameId: 0 });
      await this.navigationLoads.get(source.id!)?.settled;
      const snapshot = request.type === 'read' ? result : result?.snapshot;
      if (typeof snapshot?.epoch !== 'string' || request.type === 'read' && snapshot.epoch !== instance.epoch || request.type === 'navigate' && result?.requestId !== request.requestId) throw new Error('source-unavailable');
      await this.assertCurrent(binding, instance, snapshot.epoch);
      return result;
    } finally { if (inputContext && this.trustedInput.get(source.id!) === inputContext) this.trustedInput.delete(source.id!); }
  }

  /** A bounded timer service for background source tabs. */
  async wait(request: SourceWaitRequest, sender: chrome.runtime.MessageSender): Promise<{ ok: true }> {
    if (!this.isSourceSender(sender) || request.build !== RUNTIME_BUILD) throw new Error('unauthorized');
    if (!Number.isFinite(request.milliseconds) || request.milliseconds < 0 || request.milliseconds > 10000) throw new Error('invalid-request');
    // Short one-shot replies only; no persistent keepalive or browser activation.
    await new Promise(resolve => setTimeout(resolve, request.milliseconds));
    return { ok: true };
  }

  /** One use per authorized phase: batch chapter, or legacy catalog + chapter. */
  async input(request: SourceInputRequest, sender: chrome.runtime.MessageSender): Promise<{ ok: boolean; uncertain?: boolean }> {
    if (!this.isSourceSender(sender) || request.build !== RUNTIME_BUILD) throw new Error('unauthorized');
    const tabId = sender.tab!.id!, context = this.trustedInput.get(tabId);
    // MessageSender.url can retain the injection URL after a same-document
    // chapter navigation. Its browser-provided tab URL and a fresh tabs.get
    // below identify the live route; the source epoch guards document changes.
    if (!context || sender.tab?.url !== context.route || request.requestId !== context.requestId || request.expectedPosition !== context.expectedPosition || request.expectedEpoch !== context.epoch || request.route !== context.route ||
      this.generation(tabId) !== context.generation || !context.allowedPhases.includes(request.phase) || context.phases.has(request.phase) ||
      ![request.x, request.y, request.viewportWidth, request.viewportHeight].every(Number.isFinite) ||
      request.viewportWidth <= 0 || request.viewportHeight <= 0 || request.viewportWidth > 10000 || request.viewportHeight > 10000 ||
      request.x < 0 || request.y < 0 || request.x >= request.viewportWidth || request.y >= request.viewportHeight) throw new Error('unauthorized');
    // Reserve synchronously; two messages must not both pass the one-use check
    // while either is waiting for tabs/storage/epoch validation.
    context.phases.add(request.phase);
    const target = { tabId };
    let attached = false, pressed = false, uncertain = false;
    try {
      await this.assertInputCurrent(tabId, context);
      await this.api.debugger.attach(target, '1.3'); attached = true;
      await this.assertInputCurrent(tabId, context);
      await this.api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: request.x, y: request.y, button: 'none', buttons: 0 });
      await this.assertInputCurrent(tabId, context);
      pressed = true;
      await this.api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: request.x, y: request.y, button: 'left', buttons: 1, clickCount: 1 });
      await this.api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: request.x, y: request.y, button: 'left', buttons: 0, clickCount: 1 }); pressed = false;
      return { ok: true };
    } catch {
      uncertain = pressed;
      return { ok: false, ...(uncertain ? { uncertain: true } : {}) };
    } finally {
      if (pressed) await this.api.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: request.x, y: request.y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => undefined);
      if (attached) await this.api.debugger.detach(target).catch(() => undefined);
    }
  }

  private async assertInputCurrent(tabId: number, context: InputContext): Promise<void> {
    await this.navigationLoads.get(tabId)?.settled;
    const source = await this.source(tabId);
    const reader = await this.reader(context.binding);
    const binding = (await this.bindings()).find(item => item.id === context.binding.id);
    if (source.url !== context.route || !reader?.active || context.binding.readerTabId === undefined ||
      !binding || binding.sourceTabId !== tabId || binding.readerTabId !== context.binding.readerTabId || binding.state === 'disconnected' ||
      !(await this.api.windows.get(reader.windowId)).focused ||
      this.disconnectedSources.has(tabId) || (await this.ping(tabId)).epoch !== context.epoch ||
      this.generation(tabId) !== context.generation || this.trustedInput.get(tabId) !== context) throw new Error('source-unavailable');
  }

  /** Only the current top-frame content script can announce a source instance. */
  async ready(epoch: string, version: string, sender: chrome.runtime.MessageSender): Promise<void> {
    if (!this.isSourceSender(sender) || typeof epoch !== 'string' || typeof version !== 'string') return;
    const tabId = sender.tab!.id!;
    await this.navigationLoads.get(tabId)?.settled;
    const live = await this.ping(tabId).catch(() => undefined);
    if (!live || live.epoch !== epoch || live.version !== version) return;
    // Leaving the source is a disconnect; returning needs the user's explicit retry.
    if (this.disconnectedSources.has(tabId) || (await this.bindings()).some(binding => binding.sourceTabId === tabId && binding.state === 'disconnected')) return;
    await this.setSourceState(tabId, 'connected', live.generation);
  }
  private isSourceSender(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === this.api.runtime.id && sender.tab?.id !== undefined && sender.frameId === 0 && this.supportsSource(sender.url ?? '');
  }
  async forward(snapshot: SourceSnapshot, sender: chrome.runtime.MessageSender): Promise<void> {
    if (!this.isSourceSender(sender) || !snapshot || typeof snapshot.epoch !== 'string') return;
    const tabId = sender.tab!.id!;
    await this.navigationLoads.get(tabId)?.settled;
    const live = await this.ping(tabId).catch(() => undefined);
    if (!live || snapshot.epoch !== live.epoch) return;
    for (const binding of await this.bindings()) {
      if (binding.sourceTabId !== tabId || binding.state === 'disconnected' || this.disconnectedSources.has(tabId) || live.generation !== this.generation(tabId)) continue;
      await this.api.runtime.sendMessage({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'snapshot', sessionId: binding.id, snapshot } satisfies ReaderEvent).catch(() => undefined);
    }
  }
  async control(readerTabId: number, action: 'privacy' | 'controls'): Promise<{ ok: true }> {
    if (!Number.isInteger(readerTabId) || action !== 'privacy' && action !== 'controls') throw new Error('invalid-request');
    const binding = (await this.bindings()).find(item => item.readerTabId === readerTabId);
    if (!binding || !await this.reader(binding)) throw new Error('session-unavailable');
    await this.api.runtime.sendMessage({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'control', readerTabId, action } satisfies ReaderEvent);
    return { ok: true };
  }
  async removed(tabId: number): Promise<void> {
    this.navigationLoads.get(tabId)?.finish(false);
    this.disconnectedSources.add(tabId);
    const generation = this.invalidate(tabId);
    await this.mutate(async () => {
      const bindings = await this.bindings();
      const remaining = bindings.filter(binding => binding.readerTabId !== tabId);
      for (const binding of remaining.filter(item => item.sourceTabId === tabId)) binding.state = 'disconnected';
      await this.save(remaining);
      if (generation === this.generation(tabId)) for (const binding of remaining.filter(item => item.sourceTabId === tabId)) await this.notify('disconnected', binding);
    });
  }
  /** Browser-owned tab replacement preserves the binding, never the old document. */
  async replaced(addedTabId: number, removedTabId: number): Promise<void> {
    this.navigationLoads.get(removedTabId)?.finish(false);
    this.invalidate(removedTabId); this.invalidate(addedTabId);
    this.trustedInput.delete(removedTabId); this.batchOperations.delete(removedTabId);
    await this.mutate(async () => {
      const bindings = await this.bindings();
      const source = await this.source(addedTabId).catch(() => undefined);
      const changed = bindings.filter(binding => binding.sourceTabId === removedTabId);
      for (const binding of changed) {
        const disconnected = !source || binding.state === 'disconnected' || this.disconnectedSources.has(removedTabId);
        binding.sourceTabId = addedTabId;
        binding.state = disconnected ? 'disconnected' : 'loading';
        if (disconnected) this.disconnectedSources.add(addedTabId);
      }
      if (changed.length) {
        await this.save(bindings);
        for (const binding of changed) await this.notify(binding.state === 'disconnected' ? 'disconnected' : 'source-loading', binding);
      }
    });
  }
  async updated(tabId: number, change: chrome.tabs.TabChangeInfo, tab?: chrome.tabs.Tab): Promise<void> {
    const url = change.url ?? tab?.url;
    if (url !== undefined && !this.supportsSource(url)) {
      this.navigationLoads.get(tabId)?.finish(false);
      this.disconnectedSources.add(tabId);
      await this.setSourceState(tabId, 'disconnected', this.invalidate(tabId)); return;
    }
    // Edge also reports loading/complete for same-document chapter routes.
    // During a reader navigation, hold messages until completion and verify the
    // source epoch instead of treating loading alone as a document replacement.
    if (change.status === 'loading') {
      const context = this.trustedInput.get(tabId) ?? this.batchOperations.get(tabId);
      if (context) { await this.checkNavigationLoad(tabId, context); return; }
      const generation = this.invalidate(tabId);
      // A source which was explicitly disconnected is not silently reattached.
      const disconnected = this.disconnectedSources.has(tabId) || (await this.bindings()).some(binding => binding.sourceTabId === tabId && binding.state === 'disconnected');
      await this.setSourceState(tabId, disconnected ? 'disconnected' : 'loading', generation);
    }
    if (change.status === 'complete') {
      const pending = this.navigationLoads.get(tabId);
      if (pending) { pending.finish(true); await pending.settled; }
      const disconnected = this.disconnectedSources.has(tabId) || (await this.bindings()).some(binding => binding.sourceTabId === tabId && binding.state === 'disconnected');
      if (!disconnected) await this.resumeSource(tabId).catch(() => undefined);
    }
  }
  private checkNavigationLoad(tabId: number, context: { epoch: string; generation: number }): Promise<void> {
    const existing = this.navigationLoads.get(tabId);
    if (existing) return existing.settled;
    let finish!: (complete: boolean) => void;
    const completion = new Promise<boolean>(resolve => { finish = resolve; });
    const timeout = setTimeout(() => finish(false), 3000);
    const settled = completion.then(async complete => {
      clearTimeout(timeout);
      const live = complete ? await this.ping(tabId).catch(() => undefined) : undefined;
      if (live?.epoch === context.epoch && live.generation === context.generation) return;
      if (this.generation(tabId) !== context.generation) return;
      const disconnected = this.disconnectedSources.has(tabId);
      await this.setSourceState(tabId, disconnected ? 'disconnected' : 'loading', this.invalidate(tabId));
    }).finally(() => { if (this.navigationLoads.get(tabId)?.settled === settled) this.navigationLoads.delete(tabId); });
    this.navigationLoads.set(tabId, { finish, settled });
    return settled;
  }
  private async resumeSource(tabId: number): Promise<void> {
    const live = await this.ping(tabId);
    await this.setSourceState(tabId, 'connected', live.generation);
  }
  private async recoverable(binding: SessionBinding): Promise<boolean> {
    if (!await this.reader(binding)) return false;
    return binding.state === 'disconnected' || !await this.source(binding.sourceTabId).catch(() => undefined);
  }
  private async listReconnectable(sourceTabId: number): Promise<ReconnectableSession[]> {
    const result: ReconnectableSession[] = [];
    const source = await this.source(sourceTabId);
    for (const binding of await this.bindings()) {
      if (binding.sourceTabId === sourceTabId || !await this.recoverable(binding)) continue;
      const reader = await this.reader(binding);
      if (reader) result.push({ sessionId: binding.id, readerTabId: binding.readerTabId!, label: `${reader.windowId === source.windowId ? '当前窗口' : '其他窗口'} · 第 ${reader.index + 1} 个标签 · ${reader.title || '阅读工作区'}` });
    }
    return result;
  }
  private async reconnect(sourceTabId: number, sessionId: string): Promise<{ sessionId: string }> {
    await this.mutate(async () => {
      const bindings = await this.bindings();
      const binding = bindings.find(item => item.id === sessionId);
      if (!binding || !await this.recoverable(binding)) throw new Error('session-unavailable');
      const existing = bindings.find(item => item.id !== sessionId && item.sourceTabId === sourceTabId);
      if (existing && await this.reader(existing)) throw new Error('source-already-bound');
      this.invalidate(binding.sourceTabId); this.invalidate(sourceTabId);
      this.disconnectedSources.delete(sourceTabId);
      binding.sourceTabId = sourceTabId; binding.state = 'loading';
      await this.save(bindings.filter(item => item === binding || item !== existing));
      await this.notify('source-loading', binding);
      const tab = await this.reader(binding);
      if (tab) { await this.api.tabs.update(tab.id!, { active: true }); await this.api.windows.update(tab.windowId, { focused: true }); }
    });
    await this.resumeSource(sourceTabId).catch(() => undefined);
    return { sessionId };
  }
  private async open(sourceTabId: number): Promise<{ sessionId: string }> {
    const source = await this.source(sourceTabId);
    this.disconnectedSources.delete(sourceTabId);
    const bindings = await this.bindings();
    const existing = bindings.find(item => item.sourceTabId === sourceTabId);
    const existingTab = existing && await this.reader(existing);
    if (existing && existingTab) {
      if (existing.state === 'disconnected') { existing.state = 'loading'; await this.save(bindings); await this.notify('source-loading', existing); }
      await this.api.tabs.update(existingTab.id!, { active: true });
      await this.api.windows.update(existingTab.windowId, { focused: true });
      return { sessionId: existing.id };
    }
    const binding: SessionBinding = { id: crypto.randomUUID(), sourceTabId, state: 'loading' };
    // Commit the binding before the independent page can send its initial read.
    const reader = await this.api.tabs.create({ url: 'about:blank', active: true, windowId: source.windowId, index: source.index + 1, openerTabId: sourceTabId });
    binding.readerTabId = reader.id;
    await this.save([...bindings.filter(item => item.sourceTabId !== sourceTabId), binding]);
    await this.api.tabs.update(reader.id!, { url: this.api.runtime.getURL(`reader.html?session=${binding.id}`) });
    return { sessionId: binding.id };
  }
}
