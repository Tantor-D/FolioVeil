// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://local.test/reader.html"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountCapturedFrame } from '../packages/theme-chatgpt/src/captured-frame';
import type { CapturedFrameManifest, LoadedCapturedFrame } from '../packages/display-sdk/src/captured-document';
import { ChatReaderShell } from '../packages/reader-view/src/chat-shell';
import { ControlsController } from '../packages/core-runtime/src/controls-controller';
import { DEFAULT_SETTINGS } from '../packages/storage/src/index';
import type { ReaderDocument } from '../packages/content-model/src/index';
import { ReaderWorkspace } from '../packages/reader-runtime/src/workspace';
import type { SourceSnapshot } from '../packages/reader-protocol/src/index';

const body = `<div class="original-shell"><aside data-sidebar><nav data-conversations><a class="original-item" data-item><span data-item-label>Neutral</span></a></nav></aside><main data-scroll-root><div data-message-flow><section data-user class="original-user-branch"><div data-user-content class="original-bubble">Neutral user</div></section><section data-assistant class="original-assistant-branch"><article data-assistant-content class="original-prose"><p data-paragraph class="original-paragraph">Neutral paragraph</p><ol data-list><li data-list-item><p>Neutral item</p></li></ol><p data-image><img alt="neutral"></p><h2 data-heading>Neutral heading</h2><pre data-code><span>Code label</span><code>sample</code><button data-fv-content-action="copy">Copy</button></pre><span data-math role="math"><span>Neutral formula</span></span></article></section></div><div data-composer inert><span>Decorative input</span></div></main></div>`;
function fixture(): LoadedCapturedFrame {
  const html = `<!doctype html><html lang="zh-CN" class="captured-light" style="--original-root:1"><head><style data-original-style>:root{--original-variable:7}.original-shell{display:flex}.original-prose{font-size:16px}</style></head><body class="captured-body">${body}</body></html>`;
  const manifest: CapturedFrameManifest = {
    format: 'folioveil-captured-document', formatVersion: 1, id: 'chatgpt', packageHash: '0'.repeat(64),
    document: { file: 'frame.html', sha256: '0'.repeat(64), bytes: html.length }, files: [],
    selectors: { scroller: '[data-scroll-root]', messageFlow: '[data-message-flow]', sidebar: '[data-sidebar]', conversationList: '[data-conversations]', composer: '[data-composer]' },
    messages: { user: { selector: '[data-user]', contentSelector: '[data-user-content]' }, assistant: { selector: '[data-assistant]', contentSelector: '[data-assistant-content]' }, sidebarItem: { selector: '[data-item]', contentSelector: '[data-item-label]' } },
    blocks: { paragraph: { selector: '[data-paragraph]', contentSelector: ':scope' }, orderedList: { selector: '[data-list]', contentSelector: ':scope' }, listItem: { selector: '[data-list-item]', contentSelector: 'p' }, image: { selector: '[data-image]', contentSelector: 'img' }, heading2: { selector: '[data-heading]', contentSelector: ':scope' }, code: { selector: '[data-code]', contentSelector: 'code' }, math: { selector: '[data-math]', contentSelector: ':scope' } },
    evidence: { captureHash: '0'.repeat(64), state: 'synthetic-light-collapsed', capturedAt: null, viewport: { width: 1280, height: 720, dpr: 1 }, missingTemplates: [], browserReplay: 'not-checked', visualComparison: 'not-checked' }, transformations: [], substitutedUnusedAssets: []
  };
  return { manifest, html, packageURL: 'https://local.test/themes/chatgpt/' };
}
function reading(): ReaderDocument {
  return { id: 'fixture-document', title: '合成阅读标题', source: { kind: 'fixture', label: '合成来源' }, blocks: [{ id: 'paragraph', type: 'paragraph', html: '<span>精</span><span>确</span>原文 English spaces。' }, { id: 'image', type: 'image', src: 'https://fixtures.invalid/book-image.png', label: '图片 1', caption: '合成图注', resourceKind: 'image' }], toc: [], warnings: [] };
}
let shell: ChatReaderShell | undefined;
let controls: ControlsController | undefined;
beforeEach(() => { document.head.innerHTML = '<title>本地标题</title><style data-boot-style>body{margin:5px}</style>'; document.body.innerHTML = '<main id="boot">Loading</main>'; vi.spyOn(document, 'hasFocus').mockReturnValue(true); });
afterEach(() => { controls?.unmount(); controls = undefined; shell?.unmount(); shell = undefined; vi.restoreAllMocks(); });
function mount() {
  const frame = mountCapturedFrame(fixture());
  const callbacks = { onSettings: vi.fn(), onRestore: vi.fn(), onPrivacyChange: vi.fn(), onNavigate: vi.fn() };
  shell = new ChatReaderShell({ ...DEFAULT_SETTINGS, sidebarCollapsed: true }, callbacks, { id: 'chatgpt', css: '', documentFrame: frame });
  shell.mount(); shell.setDocument(reading());
  return { shell, callbacks };
}
function mappedReading(content = reading(), blockId = 'paragraph', epoch = 'mapped-source'): SourceSnapshot {
  return { epoch, revision: 1, status: 'ready', document: content, position: { documentId: content.id, chapter: content.title, page: '1', key: `${epoch}:${blockId}` }, capabilities: { 'previous-page': false, 'next-page': false }, pageRange: { evidence: 'dom-range', signature: `${epoch}:${blockId}`, start: { documentId: content.id, blockId, offset: 0 }, end: { documentId: content.id, blockId, offset: 5 } } };
}
function locateGeometry(shell: ChatReaderShell) {
  const rect = (top: number, height: number): DOMRect => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 400, width: 400, height, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.block) return rect((this.id === 'later' ? 600 : 120) - shell.scroller.scrollTop, 40);
    return rect(0, 400);
  });
}

describe('document reader integration (synthetic lifecycle coverage)', () => {
  it.each([false, true])('keeps startup advice ahead of the stream through loading, append and privacy (empty=%s)', empty => {
    shell = new ChatReaderShell({ ...DEFAULT_SETTINGS }, { onSettings: vi.fn(), onRestore: vi.fn() },
      { id: 'chatgpt', css: '', documentFrame: mountCapturedFrame(fixture()) });
    shell.mount();
    shell.setLocalPrompt('合成布局提示\n\n合成切换方法', []);
    shell.setStatus('loading');
    expect(document.querySelector('.fv-local-prompt')).not.toBeNull();
    const batch: import('../packages/content-model/src/stream').StreamBatch = {
      schemaVersion: 1, sessionId: 'guidance-session', requestId: 'request', batchId: 'one', batchSequence: 1,
      items: empty ? [] : [
        { id: 'title', chapterId: 'chapter', sequence: 1, kind: 'title', data: { text: '合成书籍标题' } },
        { id: 'body', chapterId: 'chapter', sequence: 2, kind: 'text', data: { text: '合成原文' } }
      ], status: empty ? 'partial' : 'complete', hasMore: !empty
    };
    expect(shell.appendBatch(batch)).toBe(true);
    expect(shell.appendBatch(batch)).toBe(true);
    shell.setNotice(empty ? '读取停止' : '');
    shell.setLocalPrompt('合成布局提示\n\n合成切换方法', []);
    shell.updateSettings({ ...DEFAULT_SETTINGS, imageMode: 'full' });
    expect(document.querySelectorAll('.fv-local-prompt')).toHaveLength(1);
    expect(document.querySelector('[data-message-flow]')?.firstElementChild).toBe(document.querySelector('.fv-local-prompt'));
    expect(document.querySelectorAll('.fv-local-prompt [data-block]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-block]')).toHaveLength(empty ? 0 : 1);
    shell.setPrivacy(true);
    expect(document.querySelector('.fv-local-prompt')).toBeNull();
    expect(document.body.textContent).not.toContain('合成切换方法');
    shell.setPrivacy(false);
    expect(document.querySelectorAll('.fv-local-prompt')).toHaveLength(1);
    expect(document.querySelector('[data-message-flow]')?.firstElementChild).toBe(document.querySelector('.fv-local-prompt'));
    shell.clearLocalPrompt(); expect(document.querySelector('.fv-local-prompt')).toBeNull();
  });
  it('uses the real document root and original cascade without legacy host, Shadow DOM, or frame CSS overrides', () => {
    const { shell } = mount();
    expect(shell.shadow).toBe(document); expect(shell.host).toBe(document.body); expect(shell.host.shadowRoot).toBeNull();
    expect(document.documentElement.className).toBe('captured-light'); expect(document.body.className).toBe('captured-body');
    expect(document.querySelector('[data-boot-style]')).toBeNull();
    expect(document.querySelector('[data-original-style]')?.textContent).toContain(':root{--original-variable:7}');
    expect(document.querySelector('#folioveil-root,.app,.stream,.sidebar')).toBeNull();
    expect(document.querySelector('[data-fv-reader-controls]')?.textContent).not.toContain(':host');
    expect(document.querySelector('[data-assistant-content]')?.className).toBe('original-prose');
    const flow = document.querySelector('[data-message-flow]')!;
    expect([...flow.children].map(node => node.className)).toEqual(['original-user-branch', 'original-assistant-branch']);
    expect(document.querySelector('[data-user]')?.parentElement).toBe(flow);
    expect(document.querySelector('[data-assistant]')?.parentElement).toBe(flow);
    expect(document.querySelector('#paragraph')?.textContent).toBe('精确原文 English spaces。');
    expect(document.querySelectorAll('[data-fv-topic]')).toHaveLength(12);
    expect(document.querySelector('[data-composer]')?.textContent).toBe('Decorative input');
  });

  it('suppresses the captured reverse-flow fade after switching chapters to top-down scroll', () => {
    const loaded = fixture();
    loaded.html = loaded.html.replace('<div data-message-flow>', '<div aria-hidden="true" class="sticky bottom-0"><div class="bg-gradient-to-t"></div></div><div data-message-flow>');
    const frame = mountCapturedFrame(loaded);
    shell = new ChatReaderShell({ ...DEFAULT_SETTINGS, sidebarCollapsed: true }, { onSettings: vi.fn(), onRestore: vi.fn() }, { id: 'chatgpt', css: '', documentFrame: frame });
    shell.mount(); shell.setDocument(reading());
    expect(shell.scroller.style.flexDirection).toBe('column');
    expect(document.querySelector<HTMLElement>('.sticky.bottom-0')?.style.display).toBe('none');
  });

  it('preserves default typography and applies explicit content settings without styling the outer frame', () => {
    const { shell } = mount();
    const body = document.querySelector<HTMLElement>('[data-fv-body]')!;
    expect(body.style.fontSize).toBe(''); expect(body.style.lineHeight).toBe('');
    shell.togglePanel();
    const input = shell.panel.querySelector<HTMLInputElement>('[data-setting="fontSize"]')!;
    input.value = '21'; input.dispatchEvent(new Event('input'));
    expect(body.style.fontSize).toBe('21px');
    expect(document.body.style.fontSize).toBe('');
    expect(document.querySelector<HTMLElement>('.original-shell')?.style.fontSize).toBe('');
    const lineHeight = shell.panel.querySelector<HTMLInputElement>('[data-setting="lineHeight"]')!;
    lineHeight.value = '2'; lineHeight.dispatchEvent(new Event('input'));
    expect(body.style.lineHeight).toBe('2');
  });

  it('keeps open settings groups and focused controls available when settings or source status rebuild the panel', () => {
    const { shell } = mount(); shell.togglePanel();
    const typography = [...shell.panel.querySelectorAll('details')].find(group => group.querySelector('summary')?.textContent === '排版与外观')!;
    const interaction = [...shell.panel.querySelectorAll('details')].find(group => group.querySelector('summary')?.textContent === '快捷键与唤出方式')!;
    typography.open = true; interaction.open = true;
    // Native select changes need not leave focus on the select itself.
    const select = shell.panel.querySelector<HTMLSelectElement>('[data-setting="colorScheme"]')!;
    select.value = 'dark'; select.dispatchEvent(new Event('change'));
    const nextSelect = shell.panel.querySelector<HTMLSelectElement>('[data-setting="colorScheme"]')!;
    expect(nextSelect.closest('details')?.open).toBe(true);
    expect(shell.panel.querySelector('[data-setting="autoPrivacy"]')?.closest('details')?.open).toBe(true);
    nextSelect.focus(); shell.setNavigation({ previous: true, next: false, busy: false });
    const focusedSelect = shell.panel.querySelector<HTMLSelectElement>('[data-setting="colorScheme"]')!;
    expect(focusedSelect.closest('details')?.open).toBe(true); expect(document.activeElement).toBe(focusedSelect);
    const range = shell.panel.querySelector<HTMLInputElement>('[data-setting="fontSize"]')!;
    range.focus(); range.value = '21'; range.dispatchEvent(new Event('input'));
    shell.setSourceLocation({ available: true, pendingChapter: false });
    expect(shell.panel.querySelector('[data-setting="fontSize"]')?.closest('details')?.open).toBe(true);
    expect(document.activeElement).toBe(shell.panel.querySelector('[data-setting="fontSize"]'));
    shell.closePanel(); shell.togglePanel();
    expect(shell.panel.querySelector('details[open]')).toBeNull();
  });

  it('keeps body/title/image references out of the live document during manual privacy and restores position on continue', () => {
    const { shell } = mount(); shell.scroller.scrollTop = 230;
    document.querySelector<HTMLButtonElement>('.image-trigger')!.click(); expect(shell.isPreviewOpen()).toBe(true);
    shell.setPrivacy(true);
    expect(shell.isPreviewOpen()).toBe(false); expect(shell.isPanelOpen()).toBe(false);
    expect(document.body.innerHTML).not.toContain('合成阅读标题'); expect(document.body.innerHTML).not.toContain('精确原文'); expect(document.body.innerHTML).not.toContain('book-image.png');
    shell.togglePanel(); expect(shell.getPrivacy()).toBe(true);
    shell.setPrivacy(false);
    expect(document.querySelector('#paragraph')?.textContent).toBe('精确原文 English spaces。');
    expect(shell.scroller.scrollTop).toBe(230);
  });

  it('defers the first reconnect location until explicit privacy continue without claiming the valid source anchor failed', async () => {
    const { shell } = mount(); locateGeometry(shell);
    const content = reading(); content.blocks.push({ id: 'later', type: 'paragraph', html: '来源当前位置的合成段落。' });
    let current = mappedReading(content);
    const workspace = new ReaderWorkspace({ read: async () => current, navigate: vi.fn() }, shell);
    await workspace.connect(); shell.setPrivacy(true); workspace.disconnect();
    current = mappedReading(content, 'later', 'reconnected-source');
    await workspace.connect();
    expect(shell.getPrivacy()).toBe(true); expect(document.querySelector('#later')).toBeNull();
    shell.setPrivacy(false);
    expect(shell.scroller.scrollTop).toBe(592);
    expect(shell.getReadingAnchor()?.blockId).toBe('later');
    expect(document.querySelector('[data-fv-reader-ui="status"]')?.textContent).not.toContain('无法定位');
    shell.setPrivacy(true); shell.setPrivacy(false);
    expect(shell.scroller.scrollTop).toBe(592);
  });

  it('validates deferred anchors without exposing or scrolling the hidden reading content', () => {
    const { shell } = mount(); locateGeometry(shell); shell.setPrivacy(true);
    const anchor = { documentId: reading().id, blockId: 'paragraph', offset: 0 };
    for (const invalid of [{ ...anchor, offset: -1 }, { ...anchor, offset: 0.5 }, { ...anchor, offset: 999 }, { ...anchor, blockId: 'missing' }, { ...anchor, documentId: 'other-document' }, { ...anchor, blockId: 'image', offset: 1 }]) expect(shell.locate(invalid)).toBe(false);
    expect(shell.locate(anchor)).toBe(true);
    expect(document.querySelector('#paragraph')).toBeNull(); expect(shell.scroller.scrollTop).toBe(0);
  });

  it('retains a deferred anchor across identical content delivery and replaces it with the latest valid request', () => {
    const { shell } = mount(); locateGeometry(shell);
    const content = reading(); content.blocks.push({ id: 'later', type: 'paragraph', html: '第二个合成定位目标。' });
    shell.setDocument(content); shell.setPrivacy(true);
    expect(shell.locate({ documentId: content.id, blockId: 'paragraph', offset: 0 })).toBe(true);
    expect(shell.locate({ documentId: content.id, blockId: 'later', offset: 0 })).toBe(true);
    shell.setDocument(structuredClone(content)); shell.setPrivacy(false);
    expect(shell.scroller.scrollTop).toBe(592); expect(shell.getReadingAnchor()?.blockId).toBe('later');
  });

  it.each(['content-update','document-change','disconnect','loading-status','source-loading'])('discards a deferred anchor after %s', change => {
    const { shell } = mount(); locateGeometry(shell);
    const content = reading(); content.blocks.push({ id: 'later', type: 'paragraph', html: '随后会过期的合成目标。' });
    shell.setDocument(content); shell.setPrivacy(true);
    expect(shell.locate({ documentId: content.id, blockId: 'later', offset: 0 })).toBe(true);
    if (change === 'content-update') shell.setDocument({ ...content, blocks: [...content.blocks, { id: 'new', type: 'paragraph', html: '新的内容版本。' }] });
    if (change === 'document-change') shell.setDocument({ ...content, id: 'next-document' });
    if (change === 'disconnect') { shell.setStatus('error', '合成断连'); shell.setDocument(content); }
    if (change === 'loading-status') shell.setStatus('loading');
    if (change === 'source-loading') shell.setSourceLocation({ available: false, pendingChapter: false });
    shell.setPrivacy(false); expect(shell.scroller.scrollTop).toBe(0);
  });

  it('reports an execution failure if a previously validated deferred target is no longer present', () => {
    const { shell } = mount(); locateGeometry(shell);
    const target = document.querySelector('#paragraph')!;
    shell.setPrivacy(true);
    expect(shell.locate({ documentId: reading().id, blockId: 'paragraph', offset: 0 })).toBe(true);
    // Simulates an unexpected local DOM invalidation after receipt. The final
    // restore must still validate, rather than treating queue acceptance as done.
    target.remove(); shell.setPrivacy(false);
    expect(document.querySelector('[data-fv-reader-ui="status"]')?.textContent).toContain('当前位置无法定位，请返回原页核对。');
    expect(shell.scroller.scrollTop).toBe(0);
  });

  it('keeps the captured sidebar action and setting consistent after a narrow-window conversation switch', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), addEventListener() {}, removeEventListener() {} }));
    try {
      const loaded = fixture();
      loaded.html = loaded.html.replace('<aside data-sidebar>', '<button data-fv-action="toggleSidebar">切换侧栏</button><aside data-sidebar>');
      loaded.manifest.appearance = {
        light: { captureHash: '0'.repeat(64), patches: [] },
        'sidebar-expanded': { captureHash: '0'.repeat(64), patches: [{ selector: '[data-sidebar]', attributes: { 'data-state': 'open' } }] },
        'sidebar-collapsed': { captureHash: '0'.repeat(64), patches: [{ selector: '[data-sidebar]', attributes: { 'data-state': 'closed' } }] }
      };
      const frame = mountCapturedFrame(loaded);
      shell = new ChatReaderShell({ ...DEFAULT_SETTINGS, sidebarCollapsed: true }, { onSettings: vi.fn(), onRestore: vi.fn() }, { id: 'chatgpt', css: '', documentFrame: frame });
      shell.mount(); shell.setDocument(reading());
      const toggle = document.querySelector<HTMLButtonElement>('[data-fv-action="toggleSidebar"]')!;
      toggle.click();
      expect(document.querySelector('[data-sidebar]')?.getAttribute('data-state')).toBe('open');
      document.querySelector<HTMLElement>('[data-fv-topic="周报内容整理"]')!.click();
      shell.togglePanel();
      const collapsed = shell.panel.querySelector<HTMLInputElement>('[data-setting="sidebarCollapsed"]')!;
      expect(collapsed.checked).toBe(false);
      shell.closePanel(); toggle.click();
      expect(document.querySelector('[data-sidebar]')?.getAttribute('data-state')).toBe('closed');
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps unchanged blocks and temporary image viewing alive through same-document updates', () => {
    const { shell } = mount();
    const paragraph = document.querySelector('#paragraph');
    document.querySelector<HTMLButtonElement>('.image-trigger')!.click();
    const preview = document.querySelector('[data-fv-reader-ui="preview"]');
    const next = reading(); next.blocks.push({ id: 'appended', type: 'paragraph', html: '新增合成段落' });
    shell.setDocument(next);
    expect(document.querySelector('#paragraph')).toBe(paragraph);
    expect(document.querySelector('[data-fv-reader-ui="preview"]')).toBe(preview);
    expect(shell.isPreviewOpen()).toBe(true);
    expect(document.querySelector('#appended')?.textContent).toBe('新增合成段落');
  });

  it('keeps manual privacy and keyboard controls in document mode while automatic privacy defaults off', () => {
    const { shell } = mount();
    controls = new ControlsController(shell, { ...DEFAULT_SETTINGS, sidebarCollapsed: true }); controls.mount();
    window.dispatchEvent(new Event('blur')); expect(shell.getPrivacy()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', ctrlKey: true, shiftKey: true, bubbles: true })); expect(shell.isPanelOpen()).toBe(true);
    expect(shell.panel.contains(document.activeElement)).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true })); expect(shell.getPrivacy()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true })); expect(shell.getPrivacy()).toBe(false);
  });

  it('rejects missing-template updates while preserving the last complete body and original frame', () => {
    const { shell } = mount(); const content = reading(); content.blocks.push({ id: 'quote', type: 'quote', html: '待采集引用' });
    const original = document.querySelector('[data-fv-body]');
    expect(shell.setDocument(content)).toBe(false);
    expect(document.body.textContent).toContain('本地展示模板尚未齐备：引用');
    expect(document.querySelector('[data-fv-body]')).toBe(original);
    expect(document.querySelector('#paragraph')?.textContent).toBe('精确原文 English spaces。');
    expect(document.querySelector('#quote')).toBeNull();
    expect(document.querySelector('.original-shell')).not.toBeNull(); expect(document.querySelector('.app')).toBeNull();
  });

  it('clears real content on disconnect and restores the previous document when unmounted', () => {
    const { shell } = mount(); shell.setStatus('error', '合成断连');
    expect(document.querySelector('#paragraph')).toBeNull(); expect(document.body.innerHTML).not.toContain('book-image.png');
    shell.unmount(); expect(document.querySelector('#boot')?.textContent).toBe('Loading'); expect(document.querySelector('[data-boot-style]')).not.toBeNull();
  });
});

describe('ordered content batches in the captured ChatGPT frame', () => {
  it('appends across chapters, preserves existing nodes and paragraph boundaries, and rejects missing batches', () => {
    shell = new ChatReaderShell({ ...DEFAULT_SETTINGS }, { onSettings: vi.fn(), onRestore: vi.fn() }, { id: 'chatgpt', css: '', documentFrame: mountCapturedFrame(fixture()) });
    shell.mount();
    const first = { schemaVersion: 1 as const, sessionId: 'stream', requestId: 'r1', batchId: 'b1', batchSequence: 1, status: 'complete' as const, hasMore: true,
      items: [
        { id: 't1', sequence: 1, chapterId: 'a', kind: 'title' as const, data: { text: '第一章' } },
        { id: 'p1', sequence: 2, chapterId: 'a', kind: 'text' as const, data: { text: '重复段落' } },
        { id: 'p2', sequence: 3, chapterId: 'a', kind: 'text' as const, data: { text: '重复段落' } }
      ] };
    expect(shell.appendBatch(first)).toBe(true);
    const original = document.getElementById('p1');
    shell.scroller.scrollTop = 140;
    const second = { ...first, requestId: 'r2', batchId: 'b2', batchSequence: 2,
      items: [
        { id: 'p3', sequence: 4, chapterId: 'a', kind: 'text' as const, data: { text: '后续段落' } },
        { id: 't2', sequence: 5, chapterId: 'b', kind: 'title' as const, data: { text: '第二章' } },
        { id: 'p4', sequence: 6, chapterId: 'b', kind: 'text' as const, data: { text: '<script>普通文本</script>' } }
      ] };
    expect(shell.appendBatch({ ...second, batchSequence: 3 })).toBe(false);
    expect(document.getElementById('p3')).toBeNull();
    expect(shell.appendBatch(second)).toBe(true);
    expect(document.getElementById('p1')).toBe(original); expect(shell.scroller.scrollTop).toBe(140);
    expect([...document.querySelectorAll('[data-fv-title]')].map(n => n.textContent)).toEqual(['第一章', '第二章']);
    expect([...document.querySelectorAll('[data-block]')].map(n => n.id)).toEqual(['p1','p2','p3','p4']);
    expect(document.getElementById('p4')!.querySelector('script')).toBeNull();
    expect(shell.appendBatch(second)).toBe(true); expect(document.querySelectorAll('[data-block]')).toHaveLength(4);
    shell.setNotice('来源只开放试读片段');
    const bodies = [...document.querySelectorAll('[data-fv-body]')];
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.querySelector('.reading-status')).toBeNull();
    expect(bodies[1]!.querySelector('.reading-status')?.textContent).toContain('来源只开放试读片段');
  });

  it('binds only the captured send action and disables it during a request', () => {
    const data = fixture(); data.html = data.html.replace('<span>Decorative input</span>', '<span>Decorative input</span><button data-fv-action="fetchMore" inert>Send</button>');
    data.html = data.html.replace('<div data-composer inert>', '<form inert><div data-composer inert>').replace('</div></main>', '</div></form></main>');
    const fetch = vi.fn();
    shell = new ChatReaderShell({ ...DEFAULT_SETTINGS }, { onSettings: vi.fn(), onRestore: vi.fn(), onFetchMore: fetch }, { id: 'chatgpt', css: '', documentFrame: mountCapturedFrame(data) });
    shell.mount(); const send = document.querySelector<HTMLButtonElement>('[data-fv-action="fetchMore"]')!;
    expect(send.closest('[inert]')).toBeNull(); expect(send.disabled).toBe(true);
    shell.setNavigation({ previous: false, next: true, busy: false }); send.click(); expect(fetch).toHaveBeenCalledOnce();
    shell.setNavigation({ previous: false, next: true, busy: true }); send.click(); expect(fetch).toHaveBeenCalledOnce();
  });
});
