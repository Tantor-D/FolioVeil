// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://local.test/reader.html"}
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCapturedTheme } from '../tooling/build-captured-theme.mjs';
import { createCapturedChatGPTDisplayAdapter } from '../packages/theme-chatgpt/src/index.ts';
import { DEFAULT_SETTINGS } from '../packages/storage/src/index.ts';
import { ReaderWorkspace } from '../packages/reader-runtime/src/workspace.ts';
import { BatchWorkspace } from '../packages/reader-runtime/src/batch-workspace.ts';
import { ControlsController } from '../packages/core-runtime/src/controls-controller.ts';

let directory, loaded, shell;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'folioveil-package-reader-test-'));
  const manifest = await buildCapturedTheme(process.cwd(), directory);
  loaded = { manifest, html: await readFile(path.join(directory, 'frame.html'), 'utf8'), packageURL: 'https://local.test/themes/chatgpt/' };
}, 30000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
beforeEach(() => { document.head.innerHTML = '<title>本地会话</title>'; document.body.innerHTML = '<main>正在加载</main>'; });
afterEach(() => { shell?.unmount(); shell = undefined; vi.restoreAllMocks(); });

const paragraph = '<span>逐</span><span>字</span>内容与 English spaces。';
const code = 'const value = 42;\nvalue + 1;';
function reading() {
  return {
    id: 'neutral-package-fixture', title: '中性集成测试标题', source: { kind: 'fixture' }, toc: [], warnings: [],
    blocks: [
      ...Array.from({ length: 6 }, (_, index) => ({ id: 'heading-' + index, type: 'heading', level: index + 1, html: `层级 ${index + 1}` })),
      { id: 'paragraph', type: 'paragraph', html: paragraph },
      { id: 'quote', type: 'quote', html: '<p>引用第一段</p><p>引用第二段</p>' },
      { id: 'ordered', type: 'list', ordered: true, items: [paragraph, '有序第二项'] },
      { id: 'unordered', type: 'list', ordered: false, items: ['无序第一项', '无序第二项'] },
      { id: 'code-one', type: 'code', text: code }, { id: 'code-two', type: 'code', text: 'another code sample' },
      { id: 'table', type: 'table', html: '<table><thead><tr><th>列名</th></tr></thead><tbody><tr><td>数据</td></tr></tbody></table>', caption: '中性表注' },
      { id: 'math', type: 'math', text: 'x²=4', html: '<math><msup><mi>x</mi><mn>2</mn></msup><mo>=</mo><mn>4</mn></math>' },
      { id: 'image', type: 'image', src: 'https://fixtures.invalid/neutral-image.png', label: '图片 1', caption: '中性图注', resourceKind: 'image' }
    ]
  };
}
function mount() {
  const callbacks = { onSettings: vi.fn(), onRestore: vi.fn(), onPrivacyChange: vi.fn() };
  shell = createCapturedChatGPTDisplayAdapter(loaded).create({ ...DEFAULT_SETTINGS, colorScheme: 'light', sidebarCollapsed: true }, callbacks);
  shell.mount(); shell.setDocument(reading());
  return callbacks;
}
const flow = () => document.querySelector('[data-fv-frame-node="message-flow"]');
const snapshot = (content, revision = 1) => ({ epoch: 'neutral-package-epoch', revision, status: 'ready', document: content, position: { documentId: content.id, key: `neutral:${revision}` }, capabilities: { 'previous-page': true, 'next-page': true } });

describe('generated real capture package in the formal reader (local DOM acceptance)', () => {
  it.each(['complete', 'failure', 'disconnect', 'end'])('shares one pending request across N and clicks; completion=%s', async outcome => {
    let workspace, pending, resolve, reject;
    const transport = { fetch: vi.fn(() => new Promise((done, fail) => { resolve = done; reject = fail; })), resource: vi.fn() };
    shell = createCapturedChatGPTDisplayAdapter(loaded).create(DEFAULT_SETTINGS, {
      onSettings: vi.fn(), onRestore: vi.fn(), onPrivacyChange: vi.fn(), onFetchMore: () => { pending = workspace.fetch(); }
    });
    shell.mount(); workspace = new BatchWorkspace('neutral-session', transport, shell);
    const controls = new ControlsController(shell, DEFAULT_SETTINGS, { keyboardCommands: false }); controls.mount();
    const send = document.querySelector('[data-fv-action="fetchMore"]');
    const placeholder = document.querySelector('[data-fv-frame-node="composer"] [data-composer-markdown] p[data-placeholder]');
    const key = (type = 'keydown', repeat = false) => window.dispatchEvent(new KeyboardEvent(type, { key: 'n', code: 'KeyN', repeat, bubbles: true }));
    const batch = n => ({ schemaVersion: 1, sessionId: 'neutral-session', requestId: `r${n}`, batchId: `b${n}`, batchSequence: n, items: [], status: 'complete', hasMore: true });
    const burst = () => { for (let i = 0; i < 10; i++) { key(); send.click(); key('keyup'); } };
    try {
      const initial = workspace.connect(); burst();
      expect(transport.fetch).toHaveBeenCalledTimes(1); expect(send.disabled).toBe(true);
      expect(placeholder.getAttribute('data-placeholder')).toBe('正在获取后续内容，请稍候…');
      resolve({ epoch: 'neutral-epoch', batch: batch(1) }); await initial;
      expect(transport.fetch).toHaveBeenCalledTimes(1); expect(send.disabled).toBe(false);
      key(); // Leave held during completion to exercise the fast-result boundary.
      expect(transport.fetch).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 10; i++) { key('keydown', true); send.click(); }
      expect(transport.fetch).toHaveBeenCalledTimes(2);
      shell.updateSettings({ ...DEFAULT_SETTINGS, displayLanguage: 'en' });
      expect(placeholder.getAttribute('data-placeholder')).toBe('Loading more content, please wait…');
      if (outcome === 'disconnect') workspace.disconnect();
      if (outcome === 'failure') reject(new Error('unconfirmed'));
      else resolve({ epoch: 'neutral-epoch', batch: { ...batch(2), ...(outcome === 'end' ? { status: 'end', hasMore: false } : {}) } });
      await pending;
      key('keydown', true); await Promise.resolve();
      expect(transport.fetch).toHaveBeenCalledTimes(2);
      expect(placeholder.getAttribute('data-placeholder')).toBe('Ask ChatGPT');
      expect(send.disabled).toBe(outcome !== 'complete');
      key('keyup'); key();
      expect(transport.fetch).toHaveBeenCalledTimes(outcome === 'complete' ? 3 : 2);
      if (outcome === 'complete') { resolve({ epoch: 'neutral-epoch', batch: batch(3) }); await pending; }
    } finally { controls.unmount(); }
  });
  it('switches Home chrome and fake topics without changing reading content or recreating the view', () => {
    mount();
    const readingView = flow();
    const paragraphNode = document.querySelector('#paragraph');
    expect(document.querySelector('[aria-label="首页"]')).not.toBeNull();
    expect(document.documentElement.lang).toBe('zh-CN');
    shell.updateSettings({ ...DEFAULT_SETTINGS, colorScheme: 'dark', sidebarCollapsed: true, displayLanguage: 'en' });
    expect(document.documentElement.lang).toBe('en');
    expect(document.querySelector('[aria-label="Home"]')).not.toBeNull();
    expect(document.querySelector('[data-fv-topic]').textContent).toContain('Weekly update');
    expect([...document.querySelectorAll('[data-fv-topic]')].some(node => node.textContent.includes('Project proposal'))).toBe(true);
    expect(document.querySelector('h4')?.textContent).toBe('You said:');
    expect(document.querySelector('[data-fv-body]').getAttribute('aria-label')).toBe('Response');
    expect(flow()).toBe(readingView);
    expect(document.querySelector('#paragraph')).toBe(paragraphNode);
    expect(paragraphNode.textContent).toBe('逐字内容与 English spaces。');
    shell.togglePanel();
    expect(document.querySelector('[role="dialog"]').getAttribute('aria-label')).toBe('Display settings');
    expect(document.querySelector('[role="dialog"]').textContent).toContain('Typography and appearance');
    shell.updateSettings({ ...DEFAULT_SETTINGS, colorScheme: 'dark', sidebarCollapsed: true });
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.querySelector('[aria-label="首页"]')).not.toBeNull();
    expect(document.querySelector('[data-fv-topic]').textContent).toContain('周报内容整理');
    expect(document.querySelector('h4')?.textContent).toBe('你说：');
  });
  it('keeps the captured selected-row class on only the active conversation', () => {
    mount();
    const rows = [...document.querySelectorAll('[data-fv-topic] .sidebar-item')];
    expect(rows).toHaveLength(12);
    expect(rows.filter(row => row.classList.contains('bg-primary-ghost-hover'))).toHaveLength(1);
    expect(rows.filter(row => row.getAttribute('aria-current') === 'page')).toHaveLength(1);
  });
  it('renders every content family in original direct message branches with exact payload text', () => {
    mount();
    expect(shell.shadow).toBe(document); expect(document.body.shadowRoot).toBeNull();
    expect([...flow().children].map(node => node.getAttribute('data-fv-frame-node'))).toEqual(['message-user', 'message-assistant']);
    expect(document.querySelector('[data-fv-frame-node="message-user"] > *')).not.toBeNull();
    expect(document.querySelectorAll('[data-fv-topic]')).toHaveLength(12);
    expect(document.querySelectorAll('[data-block]')).toHaveLength(reading().blocks.length);
    expect(document.querySelector('#paragraph').textContent).toBe('逐字内容与 English spaces。');
    expect(document.querySelector('#quote').textContent).toBe('引用第一段引用第二段');
    expect(document.querySelector('#ordered li').textContent).toBe('逐字内容与 English spaces。');
    expect(document.querySelector('#table table').textContent).toBe('列名数据');
    expect(document.querySelector('#math').textContent).toBe('x2=4');
    expect(document.querySelector('#math .katex-html')).toBeNull();
    for (let i = 0; i < 6; i++) expect(document.querySelector('#heading-' + i).localName).toBe('h' + (i + 1));
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(document.querySelector('link[rel="stylesheet"]').href).toMatch(/^https:\/\/local.test\/themes\/chatgpt\/assets\//);
    expect(document.querySelector('#folioveil-root,.stream,.reply')).toBeNull();
    expect(shell.scroller.style.flexDirection).toBe('column');
    expect(flow().style.paddingBottom).toContain('--thread-scroll-padding-bottom');
    expect(document.querySelector('button[aria-label="滚动到底部"]').getAttribute('style')).toContain('display: none');
  });

  it('binds only local code copy and keeps captured run controls inert and language labels neutral', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount();
    const block = document.querySelector('#code-one');
    expect(block.querySelector('code').textContent).toBe(code);
    expect(block.textContent).not.toContain('Python'); expect(block.textContent).toContain('代码');
    expect(block.querySelector('button[aria-label="启用自动换行"]').hasAttribute('inert')).toBe(true);
    block.querySelector('[data-fv-content-action="copy"]').click();
    await Promise.resolve(); expect(writeText).toHaveBeenCalledExactlyOnceWith(code);
  });

  it('uses the captured sidebar states and changes typography only after an explicit content setting', () => {
    mount();
    const content = document.querySelector('[data-fv-body]');
    expect(content.style.fontSize).toBe(''); expect(content.style.lineHeight).toBe('');
    expect(document.querySelector('[data-fv-content-width]').style.getPropertyValue('--thread-content-max-width')).toBe('');
    shell.updateSettings({ ...DEFAULT_SETTINGS, colorScheme: 'light', sidebarCollapsed: false, fontSize: 21, lineHeight: 2, contentWidth: 840 });
    expect(document.querySelector('[data-local-state-node="layout"]').getAttribute('data-app-shell-sidebar-open')).toBe('true');
    expect(content.style.fontSize).toBe('21px'); expect(content.style.lineHeight).toBe('2');
    expect([...document.querySelectorAll('[data-fv-content-width]')].every(node => node.style.getPropertyValue('--thread-content-max-width') === '840px')).toBe(true);
    expect(document.body.style.fontSize).toBe('');
    shell.setNotice('本地操作结果');
    shell.updateSettings({ ...DEFAULT_SETTINGS, colorScheme: 'dark', sidebarCollapsed: true });
    expect(document.querySelector('[data-fv-reader-ui="status"]').textContent).toContain('本地操作结果');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.querySelector('#code-one [data-markdown-copy="code-block"]').getAttribute('data-theme')).toBe('dark');
  });

  it('can reopen the sidebar after collapsing it', () => {
    mount();
    const availableToggle = () => [...document.querySelectorAll('[data-fv-action="toggleSidebar"]')].find(button =>
      !button.closest('[inert]') && button.style.display !== 'none' &&
      button.closest('[data-fv-state-node="4"]')?.style.opacity !== '0');
    expect(availableToggle()).toBeDefined();
    availableToggle().click();
    expect(document.querySelector('[data-local-state-node="layout"]').getAttribute('data-app-shell-sidebar-open')).toBe('true');
    expect(availableToggle()).toBeDefined();
    availableToggle().click();
    expect(document.querySelector('[data-local-state-node="layout"]').getAttribute('data-app-shell-sidebar-open')).toBe('false');
    expect(availableToggle()).toBeDefined();
  });

  it('applies the original selected-row attribute to only the current local conversation', () => {
    mount();
    const selected = () => [...document.querySelectorAll('[data-fv-topic] a[data-active]')];
    expect(selected()).toHaveLength(1);
    expect(selected()[0].closest('[data-fv-topic]').dataset.fvTopic).toBe('reading');
    expect(selected()[0].getAttribute('aria-current')).toBe('page');
    expect(document.querySelectorAll('[data-fv-topic][tabindex]')).toHaveLength(0);
    document.querySelector('[data-fv-topic="周报内容整理"] a').click();
    expect(selected()).toHaveLength(1);
    expect(selected()[0].closest('[data-fv-topic]').dataset.fvTopic).toBe('周报内容整理');
    document.querySelector('[data-fv-topic="reading"] a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(selected()).toHaveLength(1);
    expect(selected()[0].closest('[data-fv-topic]').dataset.fvTopic).toBe('reading');
  });

  it('reports an actual initial table-render failure and retries the identical snapshot', async () => {
    const invalid = { ...reading(), blocks: [{ id: 'invalid-table', type: 'table', html: '<p>中性无表格节点</p>' }] };
    let current = snapshot(invalid);
    let workspace;
    shell = createCapturedChatGPTDisplayAdapter(loaded).create({ ...DEFAULT_SETTINGS, colorScheme: 'light' }, {
      onSettings: vi.fn(), onRestore: vi.fn(), onRetry: () => void workspace.connect()
    });
    shell.mount();
    const render = vi.spyOn(shell, 'setDocument');
    const navigation = vi.spyOn(shell, 'setNavigation');
    workspace = new ReaderWorkspace({ read: async () => current, navigate: vi.fn() }, shell);
    await workspace.connect();
    expect(document.querySelectorAll('[data-block]')).toHaveLength(0);
    expect(document.querySelector('[data-fv-reader-ui="status"]').textContent).toContain('正文暂时无法显示');
    expect([...document.querySelectorAll('[data-fv-reader-ui="recovery"] button')].some(button => button.textContent === '重新连接')).toBe(true);
    expect(navigation).toHaveBeenLastCalledWith({ previous: false, next: false, busy: false });
    await workspace.connect();
    expect(render).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-fv-reader-ui="status"]').textContent).toContain('正文暂时无法显示');
    current = snapshot(reading(), 2);
    await workspace.connect();
    expect(document.querySelector('#paragraph').textContent).toBe('逐字内容与 English spaces。');
    expect(navigation).toHaveBeenLastCalledWith({ previous: true, next: true, busy: false });
  });

  it('keeps the existing body intact when a later changed block fails to render', async () => {
    mount();
    let current = snapshot(reading());
    const workspace = new ReaderWorkspace({ read: async () => current, navigate: vi.fn() }, shell);
    await workspace.connect();
    const originalParagraph = document.querySelector('#paragraph');
    const updated = { ...reading(), blocks: reading().blocks.map(block => block.id === 'paragraph'
      ? { ...block, html: '尚未完整呈现的新内容' }
      : block.type === 'table' ? { ...block, html: '<p>中性无表格节点</p>' } : block) };
    current = snapshot(updated, 2);
    const render = vi.spyOn(shell, 'setDocument');
    expect(workspace.accept(current)).toBe(false);
    expect(document.querySelector('#paragraph')).toBe(originalParagraph);
    expect(originalParagraph.textContent).toBe('逐字内容与 English spaces。');
    expect(document.querySelector('#table table').textContent).toBe('列名数据');
    expect(document.querySelector('[data-fv-reader-ui="status"]').textContent).toContain('当前内容已保留');
    await workspace.connect();
    expect(render).toHaveBeenCalledTimes(2);
    expect(document.querySelector('#paragraph')).toBe(originalParagraph);
    current = snapshot({ ...updated, blocks: updated.blocks.map(block => block.type === 'table' ? reading().blocks.find(item => item.type === 'table') : block) }, 3);
    await workspace.connect();
    expect(document.querySelector('#paragraph').textContent).toBe('尚未完整呈现的新内容');
  });

  it('does not overwrite the explicit missing-template explanation with a location notice', async () => {
    const blocks = { ...loaded.manifest.blocks }; delete blocks.table;
    const partial = { ...loaded, manifest: { ...loaded.manifest, blocks } };
    shell = createCapturedChatGPTDisplayAdapter(partial).create({ ...DEFAULT_SETTINGS, colorScheme: 'light' }, { onSettings: vi.fn(), onRestore: vi.fn(), onRetry: vi.fn() });
    shell.mount();
    const render = vi.spyOn(shell, 'setDocument');
    const workspace = new ReaderWorkspace({ read: async () => snapshot(reading()), navigate: vi.fn() }, shell);
    await workspace.connect(); await workspace.connect();
    expect(render).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-fv-reader-ui="status"]').textContent).toContain('本地展示模板尚未齐备：表格');
    expect(document.querySelectorAll('[data-block]')).toHaveLength(0);
  });

  it('keeps image modes, temporary viewing, neutral conversations and manual privacy functional', () => {
    mount();
    expect(document.querySelector('#image img')).toBeNull();
    document.querySelector('#image .image-trigger').click(); expect(shell.isPreviewOpen()).toBe(true);
    shell.closePreview();
    shell.updateSettings({ ...DEFAULT_SETTINGS, colorScheme: 'light', sidebarCollapsed: true, imageMode: 'thumbnail' });
    expect(document.querySelector('#image img').src).toBe('https://fixtures.invalid/neutral-image.png');
    shell.updateSettings({ ...DEFAULT_SETTINGS, colorScheme: 'light', sidebarCollapsed: true, imageMode: 'full' });
    expect(document.querySelector('#image figcaption').textContent).toBe('中性图注');
    document.querySelector('[data-fv-topic="周报内容整理"]').click();
    expect(document.querySelector('#paragraph')).toBeNull(); expect(flow().children).toHaveLength(2);
    document.querySelector('[data-fv-topic="reading"]').click();
    expect(document.querySelector('#paragraph').textContent).toBe('逐字内容与 English spaces。');
    shell.setPrivacy(true);
    expect(document.body.innerHTML).not.toContain('中性集成测试标题'); expect(document.body.innerHTML).not.toContain('neutral-image.png');
    shell.setPrivacy(false); expect(document.querySelector('#image img')).not.toBeNull();
  });
});
