// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve('tooling/weread-dom-probe.browser.js'), 'utf8');
type Geometry = { valid: boolean; reason?: string; box?: { width: number }; rects?: Array<{ rectIndex: number; x: number }> };
type Sample = { rootId: number; nodeId: number; connected: boolean; counts: { textLength: number; images: number; truncated: boolean };
  geometry: Geometry; layout: Record<string, string> | null;
  elements: Array<{ attributes: Array<{ name: string; value?: number }>; geometry: Geometry }>;
  textRanges: Array<{ nodeId: number; length: number; geometry: Geometry }>;
  blockRanges: Array<{ nodeId: number; length: number; attributes: Array<{ name: string; value?: number }>; geometry: Geometry }> };
type Endpoint = { withinReader: boolean; offset?: number; tag?: string; attributes?: Array<{ name: string; value?: number }> };
type StableNode = { nodeId: number; tag: string; attributes: { values: Array<{ name: string; value?: number }> }; positionStyle: Record<string, string> };
type Summary = { format: string; stopped: boolean; limits: { events: number }; counters: { evictedEvents: number;
    unrelatedDiscoveryRecords: number; delegatedDiscoveryRecords: number; skippedMutationRecords: number; evictedSelectionSamples: number };
  events: Array<{ kind: string; sample?: Sample }>; earlySamples: Sample[]; current: Sample[];
  selectionSamples: Array<{ eventId: number; trigger: string; phase: string; focused: boolean; pointer?: { target: Endpoint }; selection: {
    rangeCount: number; length: number | null; anchor: Endpoint | null; scope: string } }>;
  stableDOM: { nodeCount: number; truncated: boolean; excludedSubtrees: number; nodes: StableNode[] };
  stableChanges: Array<{ exhaustive: boolean; truncated: boolean; differenceCount: number; added: StableNode[]; removed: StableNode[];
    changed: Array<{ nodeId: number; fields: string[]; before: StableNode; after: StableNode }> }> };
type Probe = { summary(): Summary; stop(): void };
const probeWindow = window as typeof window & { __folioVeilDOMProbe?: Probe };
const probe = () => probeWindow.__folioVeilDOMProbe!;
const run = () => new Function('globalThis', source)(window);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const box = (x = 10) => ({ x, y: 20, width: 100, height: 30, top: 20, left: x, right: x + 100, bottom: 50, toJSON: () => ({}) });
let originalRange: PropertyDescriptor | undefined;

beforeEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '<div class="readerChapterContent"><div class="preRenderContent"></div><div class="renderTargetContainer"><canvas width="1200" height="800"></canvas></div></div>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => box() as DOMRect);
  originalRange = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [box()] });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { throw new Error('must-not-read-canvas'); });
});
afterEach(() => {
  probeWindow.__folioVeilDOMProbe?.stop();
  window.getSelection()?.removeAllRanges();
  delete probeWindow.__folioVeilDOMProbe;
  if (originalRange) Object.defineProperty(Range.prototype, 'getClientRects', originalRange);
  else Reflect.deleteProperty(Range.prototype, 'getClientRects');
  vi.restoreAllMocks();
});

describe('anonymous WeRead normal DOM probe', () => {
  it('records live geometry then rejects detached and removal-time geometry without caching source text', async () => {
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p data-wr-id="private-source-identifier" data-wr-co="18" data-wr-width="554" data-wr-role="private-role-value">正文绝不能出现在诊断记录中。</p><img src="https://private.example/account.png">';
    const originalDOM = document.documentElement.outerHTML;
    run();
    expect(document.documentElement.outerHTML).toBe(originalDOM);
    const live = probe().summary();
    const layout = live.current.find(sample => sample.counts.textLength > 0)!;
    expect(layout.geometry.valid).toBe(true);
    expect(layout.textRanges[0]!.geometry.valid).toBe(true);
    expect(live.earlySamples.some(sample => sample.rootId === layout.rootId)).toBe(true);
    root.replaceChildren();
    await flush();
    const result = probe().summary();
    const removed = result.events.filter(event => event.kind === 'removed-node').map(event => event.sample!);
    expect(removed.length).toBe(2);
    for (const sample of removed) {
      expect(sample.connected).toBe(false);
      expect(sample.geometry).toEqual({ valid: false, reason: 'removal-record-no-live-layout-evidence' });
      expect(sample.elements.every(element => !element.geometry.valid)).toBe(true);
      expect(sample.textRanges.every(range => !range.geometry.valid)).toBe(true);
    }
    const output = JSON.stringify(result);
    for (const secret of ['正文绝不能', 'private-source-identifier', 'private-role-value', 'private.example', 'account.png']) expect(output).not.toContain(secret);
    expect(output).toContain('data-wr-id');
    expect(layout.elements.flatMap(element => element.attributes)).toContainEqual({ name: 'data-wr-co', value: 18 });
    expect(layout.elements.flatMap(element => element.attributes)).toContainEqual({ name: 'data-wr-id' });
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
  });

  it('does not invent an early live sample for content inserted and cleared in one task', async () => {
    run();
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p>同任务内消失的文字。</p>';
    root.replaceChildren();
    await flush();
    const result = probe().summary();
    expect(result.earlySamples).toHaveLength(0);
    const inserted = result.events.find(event => event.kind === 'inserted-node' && event.sample?.counts.textLength)!;
    expect(inserted.sample!.connected).toBe(false);
    expect(inserted.sample!.geometry).toEqual({ valid: false, reason: 'detached' });
    expect(result.events.some(event => event.kind === 'root-cleared')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('同任务内消失的文字');
  });

  it('marks removal events invalid even when nodes are reinserted before observer delivery', async () => {
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p>重插入合成文字。</p>';
    run();
    const node = root.firstChild!;
    node.remove(); root.append(node);
    await flush();
    const removed = probe().summary().events.find(event => event.kind === 'removed-node')!.sample!;
    expect(removed.connected).toBe(true);
    expect(removed.geometry.valid).toBe(false);
    expect(removed.textRanges[0]!.geometry.valid).toBe(false);
  });

  it('captures a removed layout wrapper without promoting similarly named unrelated DOM', async () => {
    run();
    const unrelated = document.createElement('div');
    unrelated.innerHTML = '<div class="preRenderContent"><p>不属于阅读器。</p></div>';
    document.body.append(unrelated); unrelated.remove();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<div class="preRenderContent"><p>正常排版临时批次。</p></div>';
    document.querySelector('.readerChapterContent')!.append(wrapper); wrapper.remove();
    await flush();
    const removed = probe().summary().events.filter(event => event.kind === 'removed-root');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.sample!.counts.textLength).toBe('正常排版临时批次。'.length);
    expect(removed[0]!.sample!.geometry.valid).toBe(false);
  });

  it('keeps first and last text blocks and column rectangles with safe column styles', () => {
    const root = document.querySelector('.preRenderContent') as HTMLElement;
    root.style.cssText = 'column-width:554px;column-count:6;column-gap:80px;direction:ltr;writing-mode:horizontal-tb;transform:matrix(1,0,0,1,-634,0);overflow:hidden;background-image:url(https://private.example/style.png)';
    root.innerHTML = Array.from({ length: 12 }, (_, index) => `<p data-wr-co="${index * 20}" data-wr-id="secret-${index}">${'中'.repeat(index + 1)}</p>`).join('');
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => Array.from({ length: 12 }, (_, index) => box(index * 634)) });
    run();
    const result = probe().summary();
    const sample = result.current.find(value => value.counts.textLength > 0)!;
    expect(sample.textRanges.map(range => range.length)).toEqual([1, 2, 3, 4, 9, 10, 11, 12]);
    expect(sample.blockRanges.map(range => range.length)).toEqual([1, 2, 3, 4, 9, 10, 11, 12]);
    expect(sample.textRanges[0]!.geometry.rects!.map(value => value.rectIndex)).toEqual([0, 1, 2, 3, 8, 9, 10, 11]);
    expect(sample.layout).toMatchObject({ columnWidth: '554px', columnCount: '6', columnGap: '80px', direction: 'ltr' });
    expect(JSON.stringify(result)).not.toContain('private.example');
    expect(JSON.stringify(result)).not.toContain('secret-');
  });

  it('bounds events and scan samples, stops observation, and stops an older instance on reinstall', async () => {
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p data-wr-id="private">合成样本。</p>'.repeat(2200);
    run();
    const old = probe();
    expect(old.summary().current[0]!.counts.truncated).toBe(true);
    for (let index = 0; index < 230; index++) document.dispatchEvent(new Event('scroll'));
    let result = old.summary();
    expect(result.events).toHaveLength(200);
    expect(result.counters.evictedEvents).toBeGreaterThan(0);
    const returned = old.summary(); returned.events.length = 0;
    expect(old.summary().events).toHaveLength(200);
    run();
    expect(old.summary().stopped).toBe(true);
    const oldCount = old.summary().events.length;
    probe().stop();
    result = probe().summary();
    root.replaceChildren(); document.dispatchEvent(new Event('scroll')); await flush();
    expect(old.summary().events).toHaveLength(oldCount);
    expect(probe().summary().events).toHaveLength(result.events.length);
  });

  it('samples Selection synchronously before a source handler clears it, without keeping selected text', async () => {
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p data-wr-co="12" data-wr-id="private-source-node">甲😀机密正文</p>';
    run();
    const paragraph = root.querySelector('p')!, text = paragraph.firstChild!;
    const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 3);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    paragraph.addEventListener('pointerup', () => selection.removeAllRanges(), { once: true });
    paragraph.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 240, clientY: 165 }));
    await flush();
    const summary = probe().summary(), samples = summary.selectionSamples.filter(sample => sample.trigger === 'pointerup');
    expect(samples.map(sample => sample.phase)).toEqual(['window-capture', 'capture', 'bubble', 'microtask']);
    expect(new Set(samples.map(sample => sample.eventId)).size).toBe(1);
    expect(samples[0]!.selection).toMatchObject({ rangeCount: 1, length: 2, scope: 'reader', anchor: { offset: 1, tag: '#text' } });
    expect(samples[0]!.selection.anchor!.attributes).toContainEqual({ name: 'data-wr-co', value: 12 });
    expect(samples.map(sample => sample.selection.length)).toEqual([2, 2, 0, 0]);
    expect(typeof samples[0]!.focused).toBe('boolean');
    expect(JSON.stringify(summary)).not.toContain('机密正文');
    expect(JSON.stringify(summary)).not.toContain('😀');
    expect(JSON.stringify(summary)).not.toContain('private-source-node');
  });

  it('samples window capture before a later source window handler clears Selection or stops propagation', async () => {
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p>合成选区</p>'; run();
    const paragraph = root.querySelector('p')!;
    const range = document.createRange(); range.selectNodeContents(paragraph);
    const selection = window.getSelection()!; selection.addRange(range);
    window.addEventListener('pointerup', () => selection.removeAllRanges(), { capture: true, once: true });
    paragraph.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); await flush();
    const samples = probe().summary().selectionSamples.filter(sample => sample.trigger === 'pointerup');
    expect(samples.map(sample => sample.phase)).toEqual(['window-capture', 'capture', 'bubble', 'microtask']);
    expect(samples.map(sample => sample.selection.rangeCount)).toEqual([1, 0, 0, 0]);
    expect(new Set(samples.map(sample => sample.eventId)).size).toBe(1);
    selection.addRange(range);
    window.addEventListener('pointerup', event => event.stopImmediatePropagation(), { capture: true, once: true });
    paragraph.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); await flush();
    const next = probe().summary().selectionSamples.filter(sample => sample.trigger === 'pointerup' && sample.eventId !== samples[0]!.eventId);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ phase: 'window-capture', selection: { rangeCount: 1, length: 4 } });
  });

  it('keeps a reader drag ending outside only under its reader context without reading outside text or identity', async () => {
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p>合成选区</p>';
    const outside = document.createElement('aside');
    outside.textContent = 'private-outside-text'; outside.setAttribute('data-wr-id', 'private-outside-id');
    document.body.append(outside); run();
    const paragraph = root.querySelector('p')!, range = document.createRange(); range.selectNodeContents(paragraph);
    const selection = window.getSelection()!; selection.addRange(range);
    // Even stopping pointerdown before document must not lose reader context.
    window.addEventListener('pointerdown', event => event.stopPropagation(), { capture: true, once: true });
    paragraph.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    outside.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); await flush();
    const samples = probe().summary().selectionSamples.filter(sample => sample.trigger === 'pointerup');
    expect(samples).toHaveLength(4);
    for (const sample of samples) {
      expect(sample.pointer!.target).toEqual({ withinReader: false, connected: true });
      expect(sample.selection).toMatchObject({ rangeCount: 1, length: 4, scope: 'reader' });
    }
    range.selectNodeContents(outside); selection.removeAllRanges(); selection.addRange(range);
    const stringify = vi.spyOn(selection, 'toString');
    outside.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); await flush();
    const later = probe().summary().selectionSamples.filter(sample => sample.trigger === 'pointerup').slice(4);
    expect(later).toHaveLength(4);
    for (const sample of later) {
      expect(sample.selection).toMatchObject({ scope: 'outside-reader', length: null });
      expect(sample.selection.anchor).toEqual({ withinReader: false, connected: true });
      expect(sample.pointer!.target).toEqual({ withinReader: false, connected: true });
    }
    expect(stringify).not.toHaveBeenCalled();
    const count = probe().summary().selectionSamples.length;
    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    outside.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); await flush();
    expect(probe().summary().selectionSamples).toHaveLength(count);
    expect(JSON.stringify(probe().summary())).not.toMatch(/private-outside-(?:text|id)/);
  });

  it('records selectionchange at the event and omits Selection text outside the reader', async () => {
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p>正常合成选区。</p>';
    run();
    const range = document.createRange(); range.selectNodeContents(root.querySelector('p')!);
    const selection = window.getSelection()!; selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await flush();
    expect(probe().summary().selectionSamples.some(sample => sample.trigger === 'selectionchange' && sample.phase === 'capture' && sample.selection.length === 7)).toBe(true);
    const outside = document.createElement('div'); outside.textContent = 'unrelated-private-text'; document.body.append(outside);
    range.selectNodeContents(outside); selection.removeAllRanges(); selection.addRange(range);
    root.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    const stringify = vi.spyOn(selection, 'toString');
    document.dispatchEvent(new Event('selectionchange')); await flush();
    const samples = probe().summary().selectionSamples;
    expect(samples.at(-1)!.selection).toMatchObject({ scope: 'outside-reader', length: null, anchor: { withinReader: false } });
    expect(stringify).not.toHaveBeenCalled();
    expect(JSON.stringify(samples)).not.toContain('unrelated-private-text');
  });

  it('filters unrelated global mutations before budgeting reader records', async () => {
    run();
    for (let index = 0; index < 350; index++) document.body.append(document.createElement('aside'));
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p>不能被全局噪声挤掉。</p>'; root.replaceChildren();
    await flush();
    const summary = probe().summary();
    expect(summary.counters.unrelatedDiscoveryRecords).toBeGreaterThanOrEqual(350);
    expect(summary.counters.delegatedDiscoveryRecords).toBeGreaterThanOrEqual(2);
    expect(summary.counters.skippedMutationRecords).toBe(0);
    expect(summary.events.some(event => event.kind === 'removed-node' && event.sample?.counts.textLength === '不能被全局噪声挤掉。'.length)).toBe(true);
  });

  it('prioritizes late root removal over a noisy reader batch and reports skipped records', async () => {
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p>合成文字</p>'; run();
    const text = root.querySelector('p')!.firstChild!;
    for (let index = 0; index < 250; index++) text.nodeValue = `合成${index}`;
    root.replaceChildren(); await flush();
    const summary = probe().summary();
    expect(summary.counters.skippedMutationRecords).toBeGreaterThan(0);
    expect(summary.events.some(event => event.kind === 'removed-node' && event.sample?.counts.textLength === '合成249'.length)).toBe(true);
    expect(summary.events.some(event => event.kind === 'root-cleared')).toBe(true);
  });

  it('discovers a reader added and cleared before its dedicated observer could attach', async () => {
    document.body.replaceChildren(); run();
    for (let index = 0; index < 150; index++) document.body.append(document.createElement('aside'));
    const reader = document.createElement('div'); reader.className = 'readerChapterContent';
    reader.innerHTML = '<div class="preRenderContent"></div><div class="renderTargetContainer"></div>';
    document.body.append(reader);
    const root = reader.querySelector('.preRenderContent')!;
    root.innerHTML = '<p>文档开始阶段的合成正文。</p>'; root.replaceChildren(); await flush();
    expect(probe().summary().events.some(event => event.kind === 'removed-node' && event.sample?.counts.textLength === '文档开始阶段的合成正文。'.length)).toBe(true);
    root.innerHTML = '<p>后续正文</p>'; await flush();
    expect(probe().summary().current.some(sample => sample.counts.textLength === 4)).toBe(true);
  });

  it('exports a complete non-SVG metadata snapshot and safe added/removed/changed differences', async () => {
    const render = document.querySelector('.renderTargetContainer')!;
    render.innerHTML = '<div class="wr_selection secret-class" data-wr-id="123456789" data-wr-page-index="2" data-private="secret-value" style="left:12px;background-image:url(https://private.example)">秘密正文</div><svg><text>秘密SVG</text></svg>';
    run();
    const original = probe().summary();
    expect(original.format).toBe('folioveil-normal-dom-probe/3');
    expect(original.stableDOM.truncated).toBe(false);
    expect(original.stableDOM.excludedSubtrees).toBe(1);
    expect(original.stableDOM.nodes.every(node => node.tag !== 'svg')).toBe(true);
    const selected = render.querySelector('div')!;
    selected.setAttribute('data-wr-page-index', '3'); (selected as HTMLElement).style.left = '24px';
    const child = document.createElement('p'); child.setAttribute('data-wr-co', '88'); selected.append(child);
    await flush();
    const next = probe().summary();
    expect(next.stableChanges.some(change => change.added.some(node => node.attributes.values.some(attribute => attribute.name === 'data-wr-co' && attribute.value === 88)))).toBe(true);
    expect(next.stableChanges.some(change => change.changed.some(node => node.fields.includes('positionStyle') && node.after.positionStyle.left === '24px'))).toBe(true);
    selected.remove(); await flush();
    const result = probe().summary();
    expect(result.stableChanges.some(change => change.removed.length > 0 && change.exhaustive)).toBe(true);
    const output = JSON.stringify(result);
    for (const secret of ['123456789', 'secret-class', 'secret-value', '秘密正文', '秘密SVG', 'private.example']) expect(output).not.toContain(secret);
    expect(output).toContain('data-private');
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
  });

  it('bounds stable metadata and differences and does not call truncated comparisons exhaustive', async () => {
    const render = document.querySelector('.renderTargetContainer')!;
    render.innerHTML = '<span data-wr-co="1"></span>'.repeat(1300);
    run();
    expect(probe().summary().stableDOM).toMatchObject({ nodeCount: 1200, truncated: true });
    render.innerHTML = '<p data-wr-co="2"></p>'.repeat(800); await flush();
    const result = probe().summary();
    expect(result.stableChanges.some(change => change.truncated && !change.exhaustive && change.differenceCount > 120)).toBe(true);
    for (const change of result.stableChanges) expect(change.added.length + change.removed.length + change.changed.length).toBeLessThanOrEqual(120);
    expect(result.stableChanges.length).toBeLessThanOrEqual(12);
  });

  it('bounds selection samples and cancels pending event samples and listeners on stop', async () => {
    const root = document.querySelector('.preRenderContent')!;
    root.innerHTML = '<p>合成选区</p>'; run();
    for (let index = 0; index < 18; index++) root.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await flush();
    expect(probe().summary().selectionSamples).toHaveLength(40);
    expect(probe().summary().counters.evictedSelectionSamples).toBeGreaterThan(0);
    const old = probe();
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    root.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); old.stop();
    for (const type of ['pointerdown', 'pointerup', 'selectionchange']) expect(removeWindowListener).toHaveBeenCalledWith(type, expect.any(Function), true);
    const count = old.summary().counters.evictedSelectionSamples;
    await flush();
    expect(old.summary().counters.evictedSelectionSamples).toBe(count);
    root.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(old.summary().counters.evictedSelectionSamples).toBe(count);
    run();
    root.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); await flush();
    expect(probe().summary().selectionSamples.filter(sample => sample.trigger === 'pointerup')).toHaveLength(4);
  });
});
