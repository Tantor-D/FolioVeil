// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { WeReadBatchSource, WEREAD_BATCH_POLICY, type WeReadChapterInput } from '../packages/adapter-weread/src/batch-source';

let source: WeReadBatchSource;
let route: string;
let clicks: number;
const url = (n: number) => `https://weread.qq.com/web/reader/${'a'.repeat(23)}${String(n).padStart(24, '0')}`;
function render(n: number, titleOnly = false, end = false) {
  route = url(n);
  document.body.innerHTML = `<div class="readerChapterContent"><div class="preRenderContent"><h1>章节${n}</h1>${titleOnly ? '' : '<p>合法重复</p><p>合法重复</p>'}</div></div>
    <ul><li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_level_1"><span class="readerCatalog_list_item_title_text">章节${n}</span></div></li>
    ${titleOnly ? '<li class="readerCatalog_list_item"><div class="readerCatalog_list_item_level_2"><span class="readerCatalog_list_item_title_text">下一正文章</span></div></li>' : ''}</ul>
    <button class="readerHeaderButton">上一章</button>${end ? '<button>标记读完</button>' : '<button class="readerFooter_button">下一章</button>'}`;
  const next = document.querySelector<HTMLButtonElement>('.readerFooter_button');
  if (next) next.scrollIntoView = vi.fn();
}
async function setup(input?: WeReadChapterInput, titleOnly = false, end = false) {
  vi.useFakeTimers(); clicks = 0;
  render(1, titleOnly, end);
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, timeoutMs: 1000 }, undefined,
    input ?? (async () => { clicks++; render(clicks + 1); }));
  source.start(); await vi.advanceTimersByTimeAsync(250);
}
async function fetch(id: string, initial = false) {
  const pending = source.fetch('session', id, initial);
  await vi.advanceTimersByTimeAsync(1500);
  return pending;
}
afterEach(() => { source?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('returns the current chapter without clicking, then one chapter per request with global order and replay', async () => {
  await setup();
  // The website has removed its semantic DOM before the reader asks for it.
  document.querySelector('.preRenderContent')!.remove();
  const first = await fetch('first', true);
  expect(first).toMatchObject({ status: 'complete', batchSequence: 1, hasMore: true });
  expect(first.items.map(i => i.kind)).toEqual(['title', 'text', 'text']);
  expect(clicks).toBe(0);
  const second = await fetch('second');
  expect(second).toMatchObject({ status: 'complete', batchSequence: 2 });
  expect(second.items.map(i => i.sequence)).toEqual([4, 5, 6]);
  expect(second.items[0]!.data).toEqual({ text: '章节2' });
  expect(clicks).toBe(1);
  expect(await source.fetch('session', 'second', false)).toEqual(second);
  expect(await source.fetch('session', 'another-initial', true)).toEqual(first);
  expect(clicks).toBe(1);
  expect((await fetch('third')).items.map(i => i.sequence)).toEqual([7, 8, 9]);
  expect(clicks).toBe(2);
});

it('keeps a section-only page as a title batch rather than substituting its first child', async () => {
  await setup(undefined, true);
  const batch = await fetch('section', true);
  expect(batch.status).toBe('complete');
  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]).toMatchObject({ kind: 'title', data: { text: '章节1' } });
  expect(clicks).toBe(0);
});

it('recognizes a section title after decorative image paragraphs and preserves its introduction', async () => {
  await setup(async () => {
    clicks++; render(2, true);
    document.querySelector('.preRenderContent')!.innerHTML = '<p><img></p><p><img></p><p><img></p><h1>章节</h1><h1>2</h1><p>分卷引言正文</p>';
  });
  await fetch('first', true);
  const section = await fetch('section');
  expect(section.status).toBe('complete');
  expect(section.items[0]).toMatchObject({ kind: 'title', data: { text: '章节2' } });
  expect(section.items.at(-1)).toMatchObject({ kind: 'text', data: { text: '分卷引言正文' } });
  expect(clicks).toBe(1);
});

it('returns the final chapter and an explicit end, with no further clicks', async () => {
  await setup(undefined, false, true);
  expect(await fetch('last', true)).toMatchObject({ status: 'end', hasMore: false });
  expect(await fetch('past-end')).toMatchObject({ status: 'end', hasMore: false, items: [] });
  expect(clicks).toBe(0);
});

it('keeps distinct chapters with equal titles and text instead of deduplicating them', async () => {
  await setup(async () => {
    clicks++; render(2);
    document.querySelector('h1')!.textContent = '章节1';
    document.querySelector('.readerCatalog_list_item_title_text')!.textContent = '章节1';
  });
  const first = await fetch('first', true);
  const second = await fetch('same-title');
  expect(second.status).toBe('complete');
  expect(second.items).toHaveLength(3);
  expect(second.items[0]!.chapterId).not.toBe(first.items[0]!.chapterId);
  expect(second.items.map(i => i.sequence)).toEqual([4, 5, 6]);
});

it('waits for delayed new content and returns the last chapter before reporting end', async () => {
  await setup(async () => {
    clicks++;
    route = url(2);
    document.querySelector('.readerCatalog_list_item_title_text')!.textContent = '章节2';
    setTimeout(() => render(2, false, true), 300);
  });
  await fetch('first', true);
  expect(await fetch('last')).toMatchObject({ status: 'end', hasMore: false, items: [
    { kind: 'title', sequence: 4 }, { kind: 'text', sequence: 5 }, { kind: 'text', sequence: 6 }
  ] });
  expect(clicks).toBe(1);
  expect(await fetch('after-end')).toMatchObject({ status: 'end', items: [] });
  expect(clicks).toBe(1);
});

it('starts observing before the website mounts its first chapter', async () => {
  vi.useFakeTimers(); clicks = 0; route = url(1); document.body.innerHTML = '';
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, timeoutMs: 1000 });
  source.start();
  render(1);
  document.querySelector('.preRenderContent')!.remove();
  await vi.advanceTimersByTimeAsync(250);
  expect(await fetch('cold', true)).toMatchObject({ status: 'complete', items: [
    { kind: 'title' }, { kind: 'text' }, { kind: 'text' }
  ] });
});

it('does not relabel an old cached chapter when only the route changes with an equal title', async () => {
  await setup(async () => { clicks++; route = url(2); });
  await fetch('first', true);
  expect(await fetch('route-only')).toMatchObject({ status: 'partial', items: [], reason: 'content-not-confirmed' });
  expect(clicks).toBe(1);
});

it.each(['no-change', 'label-only', 'input-denied'])('does not accept old content or click twice after %s', async failure => {
  await setup(async () => {
    clicks++;
    if (failure === 'input-denied') throw new Error('trusted-input-unavailable');
    if (failure === 'label-only') {
      route = url(2);
      document.querySelector('.readerCatalog_list_item_title_text')!.textContent = '章节2';
    }
  });
  await fetch('first', true);
  const failed = await fetch('failed');
  expect(failed).toMatchObject({ status: 'partial', hasMore: false, items: [] });
  expect(clicks).toBe(1);
  expect(await source.fetch('session', 'failed', false)).toEqual(failed);
  await expect(source.fetch('session', 'retry-new', false)).rejects.toThrow('reconciliation-required');
  expect(clicks).toBe(1);
});

it('does not call a missing next button the end of the book', async () => {
  await setup(); await fetch('first', true);
  document.querySelector('.readerFooter_button')!.remove();
  expect(await fetch('next')).toMatchObject({ status: 'partial', reason: 'next-chapter-unavailable' });
  expect(clicks).toBe(0);
});

it('rejects concurrent requests, foreign sessions and external chapter movement', async () => {
  await setup(); await fetch('first', true);
  const pending = source.fetch('session', 'next', false);
  await expect(source.fetch('session', 'other', false)).rejects.toThrow('busy');
  await expect(source.fetch('foreign', 'next', false)).rejects.toThrow('source-session-in-use');
  await vi.advanceTimersByTimeAsync(1500); expect((await pending).status).toBe('complete');
  render(4); await vi.advanceTimersByTimeAsync(250);
  expect(await fetch('moved')).toMatchObject({ status: 'partial', reason: 'source-position-changed' });
  expect(clicks).toBe(1);
});

it('stops when the user switches to paginated mode between batches', async () => {
  await setup(); await fetch('first', true);
  document.querySelector('.readerHeaderButton')!.remove(); document.querySelector('.readerFooter_button')!.remove();
  document.body.insertAdjacentHTML('beforeend', '<button class="renderTarget_pager_button_right"></button>');
  expect(await fetch('switched')).toMatchObject({ status: 'partial', reason: 'source-layout-changed' });
  expect(clicks).toBe(0);
});

it('stops if the layout changes while the chapter input is in flight', async () => {
  await setup(async () => {
    clicks++;
    document.querySelector('.readerHeaderButton')!.remove(); document.querySelector('.readerFooter_button')!.remove();
    document.body.insertAdjacentHTML('beforeend', '<button class="renderTarget_pager_button_right"></button>');
  });
  await fetch('first', true);
  expect(await fetch('switched')).toMatchObject({ status: 'partial', items: [], reason: 'source-layout-changed' });
  expect(clicks).toBe(1);
});

it('requires positive layout evidence rather than treating a missing pager as scroll mode', async () => {
  await setup();
  document.querySelector('.readerHeaderButton')!.remove(); document.querySelector('.readerFooter_button')!.remove();
  expect(await fetch('unknown', true)).toMatchObject({ status: 'partial', reason: 'source-not-ready', hasMore: false });
  expect(clicks).toBe(0);
});
