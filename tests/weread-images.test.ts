// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { WeReadBatchSource, WEREAD_BATCH_POLICY } from '../packages/adapter-weread/src/batch-source';
import { extractWeReadDocument } from '../packages/adapter-weread/src/structured';
import { DocumentStreamEncoder } from '../packages/content-model/src/stream-conversion';

const route = `https://weread.qq.com/web/reader/${'a'.repeat(23)}${'b'.repeat(24)}`;
const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const imageURL = 'https://fixtures.invalid/diagram.png';
let source: WeReadBatchSource | undefined;
afterEach(() => { source?.stop(); source = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function layout(body: string, title = '中性章节') {
  document.body.innerHTML = `<div class="readerChapterContent"><div class="preRenderContent"><div>${body}</div></div></div>
    <ul><li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_level_1"><span class="readerCatalog_list_item_title_text">${title}</span></div></li></ul>
    <button class="readerFooter_button">下一章</button>`;
  return document.querySelector('.preRenderContent')!;
}

it.each([3, 4, 5, 6])('recognizes a catalog-backed h%i chapter without consuming its subsection heading', level => {
  const root = layout(`<h${level}>中性章节</h${level}><h6>章内小标题</h6><p>中性正文</p>`);
  const result = extractWeReadDocument(root, route);
  expect(result.title).toBe('中性章节');
  expect(result.blocks).toMatchObject([{ type: 'heading', level: 6, html: '章内小标题' }, { type: 'paragraph', html: '中性正文' }]);
  expect(root.querySelector(`h${level}`)).not.toBeNull();
});

it('does not manufacture chapter identity from an unmatched subsection or adjacent h3', async () => {
  vi.useFakeTimers();
  layout('<h3>相邻章节</h3><p>相邻正文</p>');
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, timeoutMs: 600 });
  source.start();
  const pending = source.fetch('neutral-session', 'first', true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ status: 'partial', reason: 'source-not-ready', items: [] });
});

it('keeps a leading h3 subsection below an existing h2 chapter', () => {
  const root = layout('<h2>中性章节</h2><h3>章内小标题</h3><p>正文</p>');
  const result = extractWeReadDocument(root, route);
  expect(result.title).toBe('中性章节');
  expect(result.blocks[0]).toMatchObject({ type: 'heading', level: 3, html: '章内小标题' });
});

it('recognizes an h3 catalog leaf beneath its h2 section without dropping the section', () => {
  const root = layout('<h2>分卷</h2><h3>中性章节</h3><h4>章内标题</h4><p>正文</p>');
  document.querySelector('ul')!.insertAdjacentHTML('afterbegin', '<li class="readerCatalog_list_item"><div class="readerCatalog_list_item_level_0"><span class="readerCatalog_list_item_title_text">分卷</span></div></li>');
  const result = extractWeReadDocument(root, route);
  expect(result.title).toBe('中性章节');
  expect(result.blocks).toMatchObject([{ type: 'heading', html: '分卷' }, { type: 'heading', html: '章内标题' }, { type: 'paragraph', html: '正文' }]);
});

it('does not publish a catalog-backed neighboring h3 as the selected chapter', async () => {
  vi.useFakeTimers();
  layout('<h3>相邻章节</h3><p>相邻正文</p>');
  document.querySelector('ul')!.insertAdjacentHTML('beforeend', '<li class="readerCatalog_list_item"><div class="readerCatalog_list_item_level_1"><span class="readerCatalog_list_item_title_text">相邻章节</span></div></li>');
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, timeoutMs: 600 });
  source.start();
  const pending = source.fetch('neutral-session', 'first', true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ status: 'partial', reason: 'source-not-ready', items: [] });
});

it('uses the real lazy image resource, preserves image/text order and leaves the source untouched', () => {
  const root = layout(`<h2>中性章节</h2><p>图前<img src="${pixel}" data-src="${imageURL}" data-w="743px" data-ratio="0.351">图后</p><p><img src="${imageURL}"></p>`);
  const result = extractWeReadDocument(root, route);
  expect(result.blocks.map(b => b.type)).toEqual(['paragraph', 'image', 'paragraph', 'image']);
  expect(result.blocks[1]).toMatchObject({ type: 'image', src: imageURL });
  expect(result.blocks[3]).toMatchObject({ type: 'image', src: imageURL });
  expect(root.querySelector('img')?.getAttribute('src')).toBe(pixel);
  const register = vi.fn(() => 'controlled-resource');
  const batch = new DocumentStreamEncoder(document, register).append(result);
  expect(register).toHaveBeenCalledWith(imageURL);
  expect(register).not.toHaveBeenCalledWith(pixel);
  expect(batch.filter(i => i.kind === 'image')).toHaveLength(2);
  expect(JSON.stringify(batch)).not.toContain(imageURL);
});

it.each(['javascript:alert(1)', 'http://fixtures.invalid/image.png', 'https://user:secret@fixtures.invalid/image.png', ''])('keeps an explicit unavailable image for invalid lazy resource %s', value => {
  const root = layout(`<h2>中性章节</h2><p>图前<img src="${pixel}" data-src="${value}">图后</p>`);
  const result = extractWeReadDocument(root, route);
  expect(result.blocks[1]).toMatchObject({ type: 'image', unavailableReason: '图片资源暂不可用' });
  expect(result.blocks[1]).toMatchObject({ src: undefined });
  expect(result.blocks.map(b => b.type)).toEqual(['paragraph', 'image', 'paragraph']);
});

it('returns an h3 chapter with a lazy image through the real batch source after layout DOM is removed', async () => {
  vi.useFakeTimers();
  const root = layout(`<h3>中性章节</h3><p>图前</p><p><img src="${pixel}" data-src="${imageURL}"></p><h4>章内小标题</h4><p>图后</p>`);
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, timeoutMs: 600 });
  source.start(); root.remove();
  await vi.advanceTimersByTimeAsync(250);
  const pending = source.fetch('neutral-session', 'first', true);
  await vi.advanceTimersByTimeAsync(1000);
  const batch = await pending;
  expect(batch.status).toBe('complete');
  expect(batch.items.map(i => i.kind)).toEqual(['title', 'text', 'image', 'heading', 'text']);
  expect(batch.items.map(i => i.sequence)).toEqual([1, 2, 3, 4, 5]);
  expect(batch.items[2]).toMatchObject({ kind: 'image', data: { resourceId: expect.any(String) } });
  expect(await source.fetch('neutral-session', 'replay', true)).toEqual(batch);
  vi.useRealTimers();
  const image = batch.items[2];
  if (image.kind !== 'image') throw new Error('missing-image');
  expect(source.resolveResource('neutral-session', image.data.resourceId!)).toBe(imageURL);
  expect(() => source!.resolveResource('another-session', image.data.resourceId!)).toThrow('resource-unavailable');
  expect(() => source!.resolveResource('neutral-session', 'unissued')).toThrow('resource-unavailable');
  source.stop();
  expect(() => source!.resolveResource('neutral-session', image.data.resourceId!)).toThrow('resource-unavailable');
});

it('preserves image items through the paginated source and batch replay', async () => {
  vi.useFakeTimers();
  layout(`<h3>中性章节</h3><p>图前<img src="${pixel}" data-src="${imageURL}">图后</p>`);
  document.querySelector('.readerFooter_button')!.remove();
  document.body.insertAdjacentHTML('beforeend', '<button class="renderTarget_pager_button_right"></button>');
  const click = vi.fn(); document.querySelector('button')!.addEventListener('click', click);
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, timeoutMs: 600 });
  source.start(); await vi.advanceTimersByTimeAsync(250);
  const pending = source.fetch('neutral-session', 'first', true);
  await vi.advanceTimersByTimeAsync(6500);
  const batch = await pending;
  expect(batch.status).toBe('complete');
  expect(batch.items.map(i => i.kind)).toEqual(['title', 'text', 'image', 'text']);
  expect(click).toHaveBeenCalledTimes(10);
  expect(await source.fetch('neutral-session', 'replay', true)).toEqual(batch);
  expect(click).toHaveBeenCalledTimes(10);
});

it('retains the selected illustrated chapter when a dual-page layout reuses its root for adjacent prelayout', async () => {
  vi.useFakeTimers();
  const root = layout(`<h3>中性章节</h3><p>图前<img src="${pixel}" data-src="${imageURL}">图后</p>`);
  document.querySelector('.readerFooter_button')!.remove();
  document.body.insertAdjacentHTML('beforeend', '<button class="renderTarget_pager_button_right"></button>');
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, initialClicks: 0, timeoutMs: 600 });
  source.start();
  root.innerHTML = '<div><h2>相邻章节</h2><p>相邻正文</p></div>';
  await vi.advanceTimersByTimeAsync(250);
  const pending = source.fetch('neutral-session', 'first', true);
  await vi.advanceTimersByTimeAsync(1000);
  const batch = await pending;
  expect(batch.status).toBe('complete');
  expect(batch.items.map(i => i.kind)).toEqual(['title', 'text', 'image', 'text']);
  expect(batch.items[0]).toMatchObject({ kind: 'title', data: { text: '中性章节' } });
});

it('waits for catalog evidence when h3 image chapters are laid out and cleared before the catalog arrives', async () => {
  vi.useFakeTimers();
  const root = layout(`<h3>中性章节</h3><p>正文<img src="${pixel}" data-src="${imageURL}"></p>`);
  const catalog = document.querySelector('ul')!; catalog.remove();
  document.querySelector('.readerFooter_button')!.remove();
  document.body.insertAdjacentHTML('beforeend', '<button class="renderTarget_pager_button_right"></button>');
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, initialClicks: 0, timeoutMs: 600 });
  source.start(); root.replaceChildren();
  await vi.advanceTimersByTimeAsync(10);
  document.body.append(catalog);
  await vi.advanceTimersByTimeAsync(250);
  const pending = source.fetch('neutral-session', 'first', true);
  await vi.advanceTimersByTimeAsync(1000);
  const batch = await pending;
  expect(batch.status).toBe('complete');
  expect(batch.items.map(i => i.kind)).toEqual(['title', 'text', 'image']);
});

it.each([false, true])('keeps the captured image chapter when the paginated catalog selects its subsection (%s)', async subsection => {
  vi.useFakeTimers();
  layout(`<h3>中性章节</h3><p>图前</p><h4>重复小标题</h4><p><img src="${pixel}" data-src="${imageURL}"></p>`);
  document.querySelector('ul')!.innerHTML = [
    ['相邻章节', 3, false], ['重复小标题', 4, false],
    ['中性章节', 3, !subsection], ['重复小标题', 4, subsection],
    ['后续章节', 3, false]
  ].map(([title, level, selected]) => `<li class="readerCatalog_list_item ${selected ? 'readerCatalog_list_item_selected' : ''}"><div class="readerCatalog_list_item_level_${level}"><span class="readerCatalog_list_item_title_text">${title}</span></div></li>`).join('');
  document.querySelector('.readerFooter_button')!.remove();
  document.body.insertAdjacentHTML('beforeend', '<button class="renderTarget_pager_button_right"></button>');
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, initialClicks: 0, timeoutMs: 600 });
  const root = document.querySelector('.preRenderContent')!;
  const html = root.innerHTML;
  source.start(); root.replaceChildren();
  await vi.advanceTimersByTimeAsync(250);
  // The source may lay out the same chapter again after resizing or repaint.
  root.innerHTML = '<h2>后续章节</h2><p>相邻预排版正文</p>';
  await vi.advanceTimersByTimeAsync(10);
  root.innerHTML = html;
  await vi.advanceTimersByTimeAsync(10);
  root.replaceChildren();
  await vi.advanceTimersByTimeAsync(250);
  const pending = source.fetch('neutral-session', 'first', true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ status: 'complete', items: [
    { kind: 'title', data: { text: '中性章节' } }, { kind: 'text' }, { kind: 'heading' }, { kind: 'image' }
  ] });
});

it.each(['outside', 'missing'])('does not associate a selected subsection without both hierarchy and body evidence (%s)', async missing => {
  vi.useFakeTimers();
  layout(`<h3>中性章节</h3><p>正文</p>${missing === 'outside' ? '<h4>重复小标题</h4>' : ''}`);
  document.querySelector('ul')!.innerHTML = [
    ['中性章节', 3, false], ...(missing === 'outside' ? [['相邻章节', 3, false]] : []), ['重复小标题', 4, true]
  ].map(([title, level, selected]) => `<li class="readerCatalog_list_item ${selected ? 'readerCatalog_list_item_selected' : ''}"><div class="readerCatalog_list_item_level_${level}"><span class="readerCatalog_list_item_title_text">${title}</span></div></li>`).join('');
  document.querySelector('.readerFooter_button')!.remove();
  document.body.insertAdjacentHTML('beforeend', '<button class="renderTarget_pager_button_right"></button>');
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, initialClicks: 0, timeoutMs: 600 });
  source.start();
  const pending = source.fetch('neutral-session', 'first', true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ status: 'partial', items: [] });
});


it('keeps one image chapter identity while pagination selects its subsection', async () => {
  vi.useFakeTimers();
  layout(`<h3>中性章节</h3><p>正文</p><h4>章内小标题</h4><h4>第二小标题</h4><p><img src="${pixel}" data-src="${imageURL}"></p>`);
  document.querySelector('ul')!.insertAdjacentHTML('beforeend', '<li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_level_2"><span class="readerCatalog_list_item_title_text">章内小标题</span></div></li><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_level_2"><span class="readerCatalog_list_item_title_text">第二小标题</span></div></li>');
  document.querySelector('.readerFooter_button')!.remove();
  document.body.insertAdjacentHTML('beforeend', '<button class="renderTarget_pager_button_right"></button>');
  const rows = document.querySelectorAll('li'); rows[0]!.classList.remove('readerCatalog_list_item_selected');
  document.querySelector('button')!.addEventListener('click', () => {
    rows[1]!.classList.remove('readerCatalog_list_item_selected'); rows[2]!.classList.add('readerCatalog_list_item_selected');
  });
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, initialClicks: 0, subsequentClicks: 1, timeoutMs: 600 });
  source.start(); await vi.advanceTimersByTimeAsync(250);
  const first = source.fetch('neutral-session', 'first', true); await vi.advanceTimersByTimeAsync(1000);
  expect((await first).items.filter(item => item.kind === 'image')).toHaveLength(1);
  const next = source.fetch('neutral-session', 'next', false); await vi.advanceTimersByTimeAsync(1000);
  expect(await next).toMatchObject({ status: 'complete', items: [] });
});
