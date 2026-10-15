// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { WeReadSourceAdapter, type TrustedChapterClick } from '../packages/adapter-weread/src/source-adapter';

const book = '67532b9071d3dced6757f99';
let route = `https://weread.qq.com/web/reader/${book}${'a'.repeat(24)}`;
let adapter: WeReadSourceAdapter;
function chapter(title: string, body: string) {
  selectChapter(title);
  document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent = title;
  document.querySelector('.preRenderContent')!.innerHTML = `<h2>${title}</h2><p>${body}</p>`;
}
function selectChapter(title: string) {
  for (const row of document.querySelectorAll('.readerCatalog_list_item')) row.classList.toggle('readerCatalog_list_item_selected', row.querySelector('.readerCatalog_list_item_title_text')?.textContent === title);
}
async function setup(trustedClick?: TrustedChapterClick) {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return DOMRect.fromRect({ width: this.matches('.readerCatalog_list_item') ? 180 : 0, height: this.matches('.readerCatalog_list_item') ? 32 : 0 });
  });
  route = `https://weread.qq.com/web/reader/${book}${'a'.repeat(24)}`;
  document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">第一章</span><div class="readerChapterContent"><div class="preRenderContent"><h2>第一章</h2><p>第一章完整正文。</p></div></div><button class="readerControls_item catalog" title="目录"></button>';
  const catalog = document.querySelector<HTMLElement>('.catalog')!;
  catalog.addEventListener('click', () => {
    document.body.insertAdjacentHTML('beforeend', '<ul class="readerCatalog_list"><li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_title_text">第一章</div></li><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_title_text">第二章</div></li></ul>');
    document.querySelectorAll<HTMLElement>('.readerCatalog_list_item')[1]!.addEventListener('click', () => {
      route = `https://weread.qq.com/web/reader/${book}${'b'.repeat(24)}`;
      chapter('第二章', '第二章完整正文，与前章不同。');
      document.querySelector('.readerCatalog_list')!.remove();
    });
  });
  adapter = new WeReadSourceAdapter(document, () => route, 800, undefined, trustedClick);
  adapter.start(); await vi.advanceTimersByTimeAsync(250);
}
afterEach(() => { adapter?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('switches through the selected catalog neighbor and confirms its distinct body', async () => {
  await setup();
  const before = adapter.snapshot();
  expect(before.capabilities['next-page']).toBe(true);
  const pending = adapter.perform('next-page', 'next-chapter', before.position.key, before.epoch);
  await vi.advanceTimersByTimeAsync(500);
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.snapshot.position.chapter).toBe('第二章');
  expect(result.snapshot.document?.blocks[0]).toMatchObject({ type: 'paragraph' });
  expect(result.snapshot.document?.id).not.toBe(before.document?.id);
  expect(result.snapshot.contentEvidence?.signature).not.toBe(before.contentEvidence?.signature);
});

it('navigates between leaf chapters across a section heading while preserving the section text', async () => {
  const clicks = vi.fn<TrustedChapterClick>(async element => { element.click(); });
  await setup(clicks);
  document.querySelector('.catalog')!.replaceWith(document.querySelector('.catalog')!.cloneNode(true));
  document.body.insertAdjacentHTML('beforeend', '<ul><li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_level_2"><span class="readerCatalog_list_item_title_text">第一章</span></div></li><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_level_1"><span class="readerCatalog_list_item_title_text">第二辑</span></div></li><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_level_2"><span class="readerCatalog_list_item_title_text">第二章</span></div></li></ul>');
  const rows = [...document.querySelectorAll<HTMLElement>('.readerCatalog_list_item')];
  rows[2]!.addEventListener('click', () => {
    route = `https://weread.qq.com/web/reader/${book}${'b'.repeat(24)}`;
    selectChapter('第二章');
    document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent = '第二辑';
    document.querySelector('.preRenderContent')!.innerHTML = '<h1>第二辑</h1><h2>第二章</h2><p>第二章完整正文。</p>';
  });
  rows[0]!.addEventListener('click', () => {
    route = `https://weread.qq.com/web/reader/${book}${'a'.repeat(24)}`;
    chapter('第一章', '第一章完整正文。');
  });
  const before = adapter.snapshot();
  const forward = adapter.perform('next-page', 'across-section', before.position.key, before.epoch);
  await vi.advanceTimersByTimeAsync(500);
  const result = await forward;
  expect(result).toMatchObject({ ok: true, snapshot: { position: { chapter: '第二章' }, document: { title: '第二章' } } });
  expect(result.snapshot.document?.blocks[0]).toMatchObject({ type: 'heading', html: '第二辑' });
  expect(clicks.mock.calls[0]?.[0]).toBe(rows[2]!.querySelector('.readerCatalog_list_item_title_text'));
  const back = adapter.perform('previous-page', 'back-across-section', result.snapshot.position.key, result.snapshot.epoch);
  await vi.advanceTimersByTimeAsync(500);
  expect(await back).toMatchObject({ ok: true, snapshot: { position: { chapter: '第一章' } } });
  expect(clicks.mock.calls[1]?.[0]).toBe(rows[0]!.querySelector('.readerCatalog_list_item_title_text'));
});

it('uses trusted catalog and adjacent-chapter input with the same request identity', async () => {
  const clicks = vi.fn<TrustedChapterClick>(async (element, _phase) => { element.click(); });
  await setup(clicks);
  const before = adapter.snapshot();
  const pending = adapter.perform('next-page', 'trusted-request', before.position.key, before.epoch);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({ ok: true, snapshot: { position: { chapter: '第二章' } } });
  expect(clicks.mock.calls.map(([, phase]) => phase)).toEqual(['catalog', 'chapter']);
  for (const [, , context] of clicks.mock.calls) expect(context).toMatchObject({ requestId: 'trusted-request', expectedPosition: before.position.key, expectedEpoch: before.epoch, route: before.position.documentId });
});

it('keeps the current chapter when privileged input is unavailable', async () => {
  await setup(async () => { throw new Error('trusted-input-unavailable'); });
  const before = adapter.snapshot();
  const pending = adapter.perform('next-page', 'denied-input', before.position.key, before.epoch);
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({ ok: false, reason: 'input-unavailable' });
  expect(adapter.snapshot().document?.id).toBe(before.document?.id);
});

it('opens a catalog whose selected row remains mounted but hidden', async () => {
  await setup();
  const original = document.querySelector('.catalog')!;
  const button = original.cloneNode(true) as HTMLElement;
  original.replaceWith(button);
  document.body.insertAdjacentHTML('beforeend', '<ul class="readerCatalog_list" style="display:none"><li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_title_text">第一章</div></li><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_title_text">第二章</div></li></ul>');
  button.addEventListener('click', () => { (document.querySelector('.readerCatalog_list') as HTMLElement).style.display = '' });
  document.querySelectorAll<HTMLElement>('.readerCatalog_list_item')[1]!.addEventListener('click', () => {
    route = `https://weread.qq.com/web/reader/${book}${'b'.repeat(24)}`;
    chapter('第二章', '第二章完整正文，与前章不同。');
  });
  const before = adapter.snapshot();
  const pending = adapter.perform('next-page', 'hidden-catalog', before.position.key, before.epoch);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({ ok: true, snapshot: { position: { chapter: '第二章' } } });
});

it('waits for a catalog animation before choosing the visible adjacent row', async () => {
  await setup();
  const original = document.querySelector('.catalog')!;
  const button = original.cloneNode(true) as HTMLElement;
  original.replaceWith(button);
  button.addEventListener('click', () => {
    document.body.insertAdjacentHTML('beforeend', '<ul class="readerCatalog_list" style="display:none"><li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_title_text">第一章</div></li><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_title_text">第二章</div></li></ul>');
    document.querySelectorAll<HTMLElement>('.readerCatalog_list_item')[1]!.addEventListener('click', () => {
      route = `https://weread.qq.com/web/reader/${book}${'b'.repeat(24)}`;
      chapter('第二章', '第二章完整正文，与前章不同。');
    });
    setTimeout(() => { (document.querySelector('.readerCatalog_list') as HTMLElement).style.display = ''; }, 120);
  });
  const before = adapter.snapshot();
  const pending = adapter.perform('next-page', 'animated-catalog', before.position.key, before.epoch);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({ ok: true, snapshot: { position: { chapter: '第二章' } } });
});

it('does not accept a changed chapter label before the target body arrives', async () => {
  await setup();
  document.querySelector('.catalog')!.replaceWith(document.querySelector('.catalog')!.cloneNode(true));
  document.querySelector('.catalog')!.addEventListener('click', () => {
    document.body.insertAdjacentHTML('beforeend', '<ul><li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_title_text">第一章</div></li><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_title_text">第二章</div></li></ul>');
    document.querySelectorAll<HTMLElement>('.readerCatalog_list_item')[1]!.addEventListener('click', () => {
      route = `https://weread.qq.com/web/reader/${book}${'b'.repeat(24)}`;
      document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent = '第二章';
      selectChapter('第二章');
    });
  });
  const before = adapter.snapshot();
  const pending = adapter.perform('next-page', 'label-only', before.position.key, before.epoch);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ ok: false, reason: 'not-confirmed', snapshot: { operationState: 'uncertain' } });
});

it('uses an already observed adjacent layout batch after the chapter route changes', async () => {
  await setup();
  const preloaded = document.createElement('div');
  preloaded.className = 'preRenderContent';
  preloaded.innerHTML = '<h2>第二章</h2><p>已提前排版的完整章节。</p>';
  document.querySelector('.readerChapterContent')!.append(preloaded);
  await vi.advanceTimersByTimeAsync(50);
  document.querySelector('.catalog')!.replaceWith(document.querySelector('.catalog')!.cloneNode(true));
  document.querySelector('.catalog')!.addEventListener('click', () => {
    document.body.insertAdjacentHTML('beforeend', '<ul><li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_title_text">第一章</div></li><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_title_text">第二章</div></li></ul>');
    document.querySelectorAll<HTMLElement>('.readerCatalog_list_item')[1]!.addEventListener('click', () => {
      route = `https://weread.qq.com/web/reader/${book}${'b'.repeat(24)}`;
      document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent = '第二章';
      selectChapter('第二章');
    });
  });
  const before = adapter.snapshot();
  const pending = adapter.perform('next-page', 'preloaded', before.position.key, before.epoch);
  await vi.advanceTimersByTimeAsync(500);
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.snapshot.document?.source.url).toContain('b'.repeat(24));
  expect(result.snapshot.document?.blocks[0]).toMatchObject({ type: 'paragraph', html: '已提前排版的完整章节。' });
});

it('moves to the previous catalog chapter and refuses an unavailable book boundary', async () => {
  await setup();
  route = `https://weread.qq.com/web/reader/${book}${'b'.repeat(24)}`;
  chapter('第二章', '第二章完整正文。');
  await vi.advanceTimersByTimeAsync(250);
  document.querySelector('.catalog')!.replaceWith(document.querySelector('.catalog')!.cloneNode(true));
  document.querySelector('.catalog')!.addEventListener('click', () => {
    const first = document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent === '第一章';
    document.body.insertAdjacentHTML('beforeend', `<ul><li class="readerCatalog_list_item ${first ? 'readerCatalog_list_item_selected' : ''}"><div class="readerCatalog_list_item_title_text">第一章</div></li><li class="readerCatalog_list_item ${first ? '' : 'readerCatalog_list_item_selected'}"><div class="readerCatalog_list_item_title_text">第二章</div></li></ul>`);
    document.querySelectorAll<HTMLElement>('.readerCatalog_list_item')[0]!.addEventListener('click', () => {
      route = `https://weread.qq.com/web/reader/${book}${'a'.repeat(24)}`;
      chapter('第一章', '第一章完整正文。');
      document.querySelector('ul')!.remove();
    });
  });
  const before = adapter.snapshot();
  const pending = adapter.perform('previous-page', 'previous', before.position.key, before.epoch);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({ ok: true, snapshot: { position: { chapter: '第一章' } } });
  const first = adapter.snapshot();
  const boundary = adapter.perform('previous-page', 'book-start', first.position.key, first.epoch);
  await vi.advanceTimersByTimeAsync(200);
  expect(await boundary).toMatchObject({ ok: false, reason: 'unsupported' });
  expect(adapter.snapshot().document?.id).toBe(first.document?.id);
});
