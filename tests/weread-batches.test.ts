// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { WeReadBatchSource, WEREAD_BATCH_POLICY } from '../packages/adapter-weread/src/batch-source';
let source: WeReadBatchSource;
let route = '';
let clicks = 0;
async function setup(works = true, wait?: (ms: number) => Promise<void>) {
  vi.useFakeTimers(); clicks = 0;
  route = `https://weread.qq.com/web/reader/${'a'.repeat(23)}${'b'.repeat(24)}`;
  document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">初始章</span><div class="readerChapterContent"><div class="preRenderContent"><h2>初始章</h2><p>初始正文</p></div></div><div class="renderTargetContent"><div class="contentWrapper"></div></div><button class="renderTarget_pager_button_right"></button>';
  document.querySelector('button')!.addEventListener('click', () => {
    clicks++;
    if (!works) return;
    const chapter = Math.ceil(clicks / 2);
    document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent = `章${chapter}`;
    document.querySelector('.preRenderContent')!.innerHTML = `<h2>章${chapter}</h2><p>重复正文</p><p>重复正文</p>`;
    document.querySelector<HTMLElement>('.contentWrapper')!.style.transform = `translateX(${clicks}px)`;
  });
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, timeoutMs: 700 }, wait);
  source.start(); await vi.advanceTimersByTimeAsync(250);
}
afterEach(() => { source?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('collects ten sequential clicks, returns ordered chapters and paragraphs, and replays without extra clicks', async () => {
  await setup(); const pending = source.fetch('session', 'initial', true);
  await vi.advanceTimersByTimeAsync(6500); const batch = await pending;
  expect(clicks).toBe(10); expect(batch.status).toBe('complete');
  expect(batch.items.filter(i => i.kind === 'title')).toHaveLength(6);
  expect(batch.items.filter(i => i.kind === 'text')).toHaveLength(11);
  expect(batch.items.map(i => i.sequence)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
  expect(await source.fetch('session', 'initial', true)).toEqual(batch);
  expect(await source.fetch('session', 'initial-again', true)).toEqual(batch); expect(clicks).toBe(10);
  const next = source.fetch('session', 'next', false); await vi.advanceTimersByTimeAsync(6500);
  expect((await next).batchSequence).toBe(2); expect(clicks).toBe(20);
});

it('accepts unchanged content for ten clicks and a subsequent empty batch', async () => {
  await setup(false); const first = source.fetch('session', 'initial', true);
  await vi.advanceTimersByTimeAsync(6500);
  expect(await first).toMatchObject({ status: 'complete', hasMore: true });
  expect((await first).items.map(i => i.kind)).toEqual(['title', 'text']);
  const second = source.fetch('session', 'next', false);
  await vi.advanceTimersByTimeAsync(6500);
  expect(await second).toMatchObject({ status: 'complete', hasMore: true, items: [], batchSequence: 2 });
  expect(clicks).toBe(20);
});

it('stops when a new chapter has no available body, preserving confirmed content', async () => {
  await setup(false);
  document.querySelector('button')!.addEventListener('click', () => {
    document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent = '未加载章';
  });
  const pending = source.fetch('session', 'initial', true);
  await vi.advanceTimersByTimeAsync(1200);
  const batch = await pending;
  expect(clicks).toBe(1);
  expect(batch).toMatchObject({ status: 'partial', hasMore: false, reason: 'content-not-confirmed' });
  expect(batch.items).toHaveLength(2);
});

it('rejects concurrent requests and a different reader session', async () => {
  await setup(); const pending = source.fetch('session', 'initial', true);
  await expect(source.fetch('session', 'next', false)).rejects.toThrow('busy');
  await expect(source.fetch('other', 'initial', true)).rejects.toThrow('source-session-in-use');
  await vi.advanceTimersByTimeAsync(6500); await pending;
});

it('does not duplicate the previous chapter when the route updates before its page label', async () => {
  await setup(false);
  const button = document.querySelector('button')!;
  button.addEventListener('click', () => {
    if (clicks !== 1) return;
    route = `https://weread.qq.com/web/reader/${'a'.repeat(23)}${'c'.repeat(24)}`;
    document.body.append(document.createElement('aside'));
    setTimeout(() => {
      document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent = '后续章';
      document.querySelector('.preRenderContent')!.innerHTML = '<h2>后续章</h2><p>新的正文。</p>';
    }, 500);
  });
  const pending = source.fetch('session', 'initial', true);
  await vi.advanceTimersByTimeAsync(6500);
  const batch = await pending;
  expect(batch.status).toBe('complete');
  expect(batch.items.filter(item => item.kind === 'title').map(item => item.data.text)).toEqual(['初始章', '后续章']);
  expect(batch.items.filter(item => item.kind === 'text').map(item => item.data.text)).toEqual(['初始正文', '新的正文。']);
});

it('can explicitly retry a cold initial read after DOM arrives without skipping a batch', async () => {
  await setup(false);
  source.stop(); document.querySelector('.preRenderContent')!.replaceChildren();
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, timeoutMs: 700 }); source.start();
  const first = source.fetch('session', 'cold', true); await vi.advanceTimersByTimeAsync(1000);
  expect((await first).items).toEqual([]); expect(clicks).toBe(0);
  document.querySelector('.preRenderContent')!.innerHTML = '<h2>初始章</h2><p>初始正文</p>';
  await vi.advanceTimersByTimeAsync(250);
  const retry = source.fetch('session', 'retry', true); await vi.advanceTimersByTimeAsync(6500);
  expect(await retry).toMatchObject({ status: 'complete', batchSequence: 2, hasMore: true });
  expect((await retry).items.map(item => item.sequence)).toEqual([1, 2]);
  expect(clicks).toBe(10);
  expect(await source.fetch('session', 'cold', true)).toEqual(await first);
  expect(clicks).toBe(10);
});

it('does not deliver a delayed page click after a long suspension', async () => {
  let suspended = false;
  await setup(false, async ms => {
    if (ms > 70 && ms < 130 && !suspended) { suspended = true; vi.setSystemTime(Date.now() + 10000); }
    await new Promise<void>(resolve => setTimeout(resolve, ms));
  });
  const pending = source.fetch('session', 'initial', true); await vi.advanceTimersByTimeAsync(6500);
  expect(await pending).toMatchObject({ status: 'partial', reason: 'source-suspended', hasMore: false });
  expect(clicks).toBe(0);
});

it('keeps identical titles and paragraphs from distinct catalog chapters', async () => {
  await setup(false); source.stop();
  document.body.innerHTML = '<ul><li class="readerCatalog_list_item readerCatalog_list_item_selected"><span class="readerCatalog_list_item_title_text">同名章</span></li><li class="readerCatalog_list_item"><span class="readerCatalog_list_item_title_text">同名章</span></li></ul><div class="readerChapterContent"><div class="preRenderContent"><h2>同名章</h2><p>重复段落</p><p>重复段落</p></div></div><div class="renderTargetContent"><div class="contentWrapper"></div></div><button class="renderTarget_pager_button_right"></button>';
  document.querySelector('button')!.addEventListener('click', () => {
    if (++clicks !== 1) return;
    const rows = document.querySelectorAll('li'); rows[0]!.classList.remove('readerCatalog_list_item_selected'); rows[1]!.classList.add('readerCatalog_list_item_selected');
    route = `https://weread.qq.com/web/reader/${'a'.repeat(23)}${'c'.repeat(24)}`;
    document.querySelector('.preRenderContent')!.innerHTML = '<h2>同名章</h2><p>重复段落</p><p>重复段落</p>';
  });
  source = new WeReadBatchSource(document, () => route, { ...WEREAD_BATCH_POLICY, timeoutMs: 700 }); source.start();
  await vi.advanceTimersByTimeAsync(250);
  const pending = source.fetch('session', 'initial', true); await vi.advanceTimersByTimeAsync(6500);
  const batch = await pending;
  expect(batch.status).toBe('complete');
  const titles = batch.items.filter(item => item.kind === 'title');
  expect(titles).toHaveLength(2); expect(titles[0]!.chapterId).not.toBe(titles[1]!.chapterId);
  expect(batch.items.filter(item => item.kind === 'text')).toHaveLength(4);
});

it('stops before clicking after a user changes the source book', async () => {
  await setup(); route = `https://weread.qq.com/web/reader/${'z'.repeat(47)}`;
  const pending = source.fetch('session', 'initial', true); await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).status).toBe('partial'); expect(clicks).toBe(0);
});


it('uses the injected scheduler for jitter, polling and content settlement, and cancels on failure', async () => {
  let fail = false;
  const wait = vi.fn((ms: number) => fail ? Promise.reject(new Error('scheduler-unavailable')) : new Promise<void>(resolve => setTimeout(resolve, ms)));
  await setup(true, wait);
  const first = source.fetch('session', 'initial', true);
  await vi.advanceTimersByTimeAsync(6500);
  expect((await first).status).toBe('complete');
  expect(wait.mock.calls.some(([ms]) => ms === 180)).toBe(true);
  expect(wait.mock.calls.some(([ms]) => ms === 40)).toBe(true);
  fail = true;
  const next = await source.fetch('session', 'next', false);
  expect(next).toMatchObject({ status: 'partial', hasMore: false });
  expect(clicks).toBe(10);
});
