// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { FanqieBatchSource, readFanqieChapter } from '../packages/adapter-fanqie/src/index';
import { decodeFanqieText } from '../packages/adapter-fanqie/src/font-map';

let source: FanqieBatchSource;
let url = 'https://fanqienovel.com/reader/100';
let clicks = 0;
function show(id: number, body = '\ue423\ue466\ue44d') {
  url = `https://fanqienovel.com/reader/${id}`;
  document.body.innerHTML = `<style>@font-face { font-family: DNMrHsV173Pd4pgy; src: url("https://example.test/dc027189e0ba4cd.woff2") format("woff2"); }</style><main class="muye-reader-box"><div class="muye-reader-box-header"><h1 class="muye-reader-title">第${id}章</h1><span>本章字数：${body.length} 字</span></div><div class="muye-reader-content"><p style="font-family:DNMrHsV173Pd4pgy">${body}</p></div></main><div class="chapter-btn next"><button type="button">下一章</button></div><aside>广告与推荐</aside>`;
  document.querySelector('button')!.addEventListener('click', () => { clicks++; show(id + 1); });
}
afterEach(() => { source?.stop(); document.body.innerHTML = ''; clicks = 0; });

it('contains exactly the 362 observed font mappings and rejects other private characters', () => {
  let mapped = 0;
  for (let codepoint = 0xe000; codepoint <= 0xf8ff; codepoint++) {
    try { decodeFanqieText(String.fromCodePoint(codepoint)); mapped++; }
    catch { /* Other private characters belong to an unknown font. */ }
  }
  expect(mapped).toBe(362);
});

it('maps the observed private characters and returns exactly one chapter per batch', async () => {
  show(100); source = new FanqieBatchSource(document, () => url);
  expect(decodeFanqieText('\ue423\ue466\ue44d')).toBe('大万里');
  const first = await source.fetch('session', 'initial', true);
  expect(first).toMatchObject({ status: 'complete', hasMore: true, batchSequence: 1 });
  expect(first.items.map(item => [item.kind, item.kind === 'title' || item.kind === 'text' ? item.data.text : ''])).toEqual([['title', '第100章'], ['text', '大万里']]);
  expect(clicks).toBe(0);
  expect(await source.fetch('session', 'initial', true)).toEqual(first);
  const next = await source.fetch('session', 'next', false);
  expect(next.items.map(item => item.chapterId)).toEqual(['101', '101']);
  expect(next.items.map(item => item.sequence)).toEqual([3, 4]);
  expect(clicks).toBe(1);
  expect(await source.fetch('session', 'next', false)).toEqual(next);
  expect(clicks).toBe(1);
});

it('rejects truncated chapters and keeps promotional text out of the content batch', async () => {
  show(100);
  document.querySelector('.muye-reader-box-header span')!.textContent = '本章字数：3390 字';
  document.body.insertAdjacentHTML('beforeend', '<div>扫码下载APP免费读</div>');
  source = new FanqieBatchSource(document, () => url);
  const batch = await source.fetch('session', 'initial', true);
  expect(batch).toMatchObject({ status: 'partial', hasMore: false, reason: 'chapter-access-restricted' });
  expect(batch.items).toEqual([]);
  await expect(source.fetch('session', 'later', false)).rejects.toThrow('reconciliation-required');
  expect(readFanqieChapter.bind(null, document, url)).toThrow('chapter-access-restricted');
});

it('keeps a confirmed chapter when the next chapter is restricted', async () => {
  show(100); source = new FanqieBatchSource(document, () => url);
  const first = await source.fetch('session', 'initial', true);
  document.querySelector('button')!.addEventListener('click', () => {
    document.querySelector('.muye-reader-box-header span')!.textContent = '本章字数：3390 字';
    document.body.insertAdjacentHTML('beforeend', '<div>扫码下载APP免费读</div>');
  });
  const next = await source.fetch('session', 'next', false);
  expect(first.items).toHaveLength(2);
  expect(next).toMatchObject({ status: 'partial', hasMore: false, reason: 'chapter-access-restricted', items: [] });
  expect(clicks).toBe(1);
});

it('accepts a one-character site word-count discrepancy but rejects a large gap', () => {
  show(100);
  document.querySelector('.muye-reader-box-header span')!.textContent = '本章字数：2 字';
  expect(readFanqieChapter(document, url).paragraphs).toEqual(['大万里']);
  document.querySelector('.muye-reader-box-header span')!.textContent = '本章字数：100 字';
  expect(readFanqieChapter.bind(null, document, url)).toThrow('chapter-incomplete');
});

it('stops when the source changes font or introduces an unknown private character', () => {
  show(100);
  document.querySelector('p')!.style.fontFamily = 'other-font';
  expect(readFanqieChapter.bind(null, document, url)).toThrow('fanqie-font-changed');
  show(100, '\ue600');
  expect(readFanqieChapter.bind(null, document, url)).toThrow('fanqie-font-unrecognized');
});
