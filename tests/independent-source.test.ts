// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeReadSourceAdapter, type WeReadPageRangeReader } from '../packages/adapter-weread/src/source-adapter';
import type { ReaderDocument } from '../packages/content-model/src/index';
let adapter: WeReadSourceAdapter;
const url = 'https://weread.qq.com/web/reader/synthetic';
let currentUrl = url;
let visibleOffset = 0;
let rangeAvailable = true;
/** Deliberately synthetic evidence for state-machine tests. Production does not
 * use this provider; these tests do not establish a WeRead DOM page mapping. */
function fixtureRange(content: ReaderDocument) {
  if (!rangeAvailable) return;
  const start = { documentId: content.id, blockId: content.blocks[0]!.id, offset: visibleOffset };
  return { start, end: { ...start, offset: visibleOffset + 2 }, signature: content.id + ':' + visibleOffset, evidence: 'dom-range' as const };
}
async function setup(provider?: WeReadPageRangeReader, paragraph = '专用合成测试文本。') {
  vi.useFakeTimers(); currentUrl = url; visibleOffset = 0; rangeAvailable = true;
  document.body.innerHTML = '<header>原网页</header><span class="renderTargetPageInfo_header_chapterTitle">合成章节</span><span class="readerFooter_progress">1 / 3</span><div class="readerChapterContent"><div class="preRenderContent"><h2>合成章节</h2><p>专用合成测试文本。</p></div></div><button aria-label="上一页">上一页</button><button aria-label="下一页">下一页</button>';
  document.querySelector('.preRenderContent p')!.textContent = paragraph;
  adapter = new WeReadSourceAdapter(document, () => currentUrl, 500, provider); adapter.start(); await vi.advanceTimersByTimeAsync(200);
}
const nextButton = () => document.querySelector<HTMLElement>('[aria-label="下一页"]')!;
function moveToNextRange() {
  visibleOffset += 2;
  document.querySelector('.readerFooter_progress')!.textContent = String(visibleOffset / 2 + 1) + ' / 3';
}
afterEach(() => { adapter?.stop(); vi.useRealTimers(); });
describe('independent source adapter', () => {
  it('captures text without changing the native UI, attributes or title', async () => {
    await setup(); const before = document.documentElement.outerHTML;
    const snapshot = await adapter.read();
    expect(snapshot.status).toBe('ready'); expect(snapshot.document?.blocks.length).toBe(1);
    expect(snapshot.contentEvidence?.completeness).toBe('unknown');
    expect(snapshot.pageRange).toBeUndefined();
    expect(document.documentElement.outerHTML).toBe(before);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
  it('does not offer or click navigation without verified page-range evidence', async () => {
    await setup(); const click = vi.fn(); nextButton().addEventListener('click', click);
    const snapshot = adapter.snapshot();
    expect(snapshot.capabilities).toEqual({ 'previous-page': false, 'next-page': false });
    expect(await adapter.perform('next-page', 'unmapped', snapshot.position.key)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(click).not.toHaveBeenCalled();
  });
  it('does not treat a click, page label, or unrelated DOM changes as navigation success', async () => {
    await setup(fixtureRange);
    nextButton().addEventListener('click', () => { document.querySelector('.readerFooter_progress')!.textContent = '2 / 3'; });
    const result = adapter.perform('next-page', 'no-effect', adapter.snapshot().position.key);
    document.body.append(document.createElement('div')); await vi.advanceTimersByTimeAsync(550);
    expect(await result).toMatchObject({ ok: false, reason: 'not-confirmed', snapshot: { operationState: 'uncertain' } });
  });
  it('requires the changed page range, rejects stale requests and never repeats a request id', async () => {
    await setup(fixtureRange); const before = adapter.snapshot(); const click = vi.fn(moveToNextRange);
    nextButton().addEventListener('click', click);
    const result = adapter.perform('next-page', 'one', before.position.key, before.epoch); await vi.advanceTimersByTimeAsync(200);
    expect(await result).toMatchObject({ ok: true, snapshot: { operationState: 'idle' } });
    expect(await adapter.perform('next-page', 'one', before.position.key, before.epoch)).toMatchObject({ ok: true });
    expect(await adapter.perform('previous-page', 'one', before.position.key, before.epoch)).toMatchObject({ ok: false, reason: 'stale-position' });
    expect(click).toHaveBeenCalledTimes(1);
    expect(await adapter.perform('next-page', 'two', before.position.key, before.epoch)).toMatchObject({ ok: false, reason: 'stale-position' });
  });
  it('uses content coordinates as position evidence when the native footer has no page number', async () => {
    await setup(fixtureRange); document.querySelector('.readerFooter_progress')!.textContent = '';
    nextButton().addEventListener('click', () => { visibleOffset = 2; });
    const result = adapter.perform('next-page', 'no-numeric-page', adapter.snapshot().position.key);
    expect(await result).toMatchObject({ ok: true, snapshot: { position: { page: '' } } });
  });
  it('does not confirm movement in the opposite content direction', async () => {
    await setup(fixtureRange); visibleOffset = 2;
    nextButton().addEventListener('click', () => { visibleOffset = 0; document.querySelector('.readerFooter_progress')!.textContent = '2 / 3'; });
    const result = adapter.perform('next-page', 'wrong-direction', adapter.snapshot().position.key);
    await vi.advanceTimersByTimeAsync(550);
    expect(await result).toMatchObject({ ok: false, reason: 'not-confirmed' });
  });
  it('shares an in-flight duplicate and rejects a second action without clicking twice', async () => {
    await setup(fixtureRange); const position = adapter.snapshot().position.key; const click = vi.fn();
    nextButton().addEventListener('click', click);
    const first = adapter.perform('next-page', 'first', position);
    const duplicate = adapter.perform('next-page', 'first', position);
    expect(await adapter.perform('next-page', 'second', position)).toMatchObject({ ok: false, reason: 'busy' });
    adapter.stop();
    expect(await first).toMatchObject({ ok: false, reason: 'source-unavailable' });
    expect(await duplicate).toMatchObject({ ok: false, reason: 'source-unavailable' });
    expect(click).toHaveBeenCalledTimes(1);
  });
  it('blocks retries after a timeout and reconciles verified late completion without another click', async () => {
    await setup(fixtureRange); const before = adapter.snapshot(); const click = vi.fn(); nextButton().addEventListener('click', click);
    const pending = adapter.perform('next-page', 'late', before.position.key, before.epoch);
    await vi.advanceTimersByTimeAsync(550); expect(await pending).toMatchObject({ ok: false, reason: 'not-confirmed' });
    expect(adapter.snapshot().capabilities['next-page']).toBe(false);
    expect(await adapter.perform('next-page', 'retry', adapter.snapshot().position.key)).toMatchObject({ ok: false, reason: 'reconciliation-required' });
    moveToNextRange(); await vi.advanceTimersByTimeAsync(200);
    expect(adapter.snapshot().operationState).toBe('idle');
    expect(await adapter.perform('next-page', 'late', before.position.key, before.epoch)).toMatchObject({ ok: true });
    expect(click).toHaveBeenCalledTimes(1);
  });
  it('does not clear uncertain state on read when only a page label changed', async () => {
    await setup(fixtureRange); const pending = adapter.perform('next-page', 'uncertain', adapter.snapshot().position.key);
    await vi.advanceTimersByTimeAsync(550); await pending;
    document.querySelector('.readerFooter_progress')!.textContent = '2 / 3'; await vi.advanceTimersByTimeAsync(200);
    expect((await adapter.read()).operationState).toBe('uncertain');
  });
  it('requires both matched new chapter content and a valid new range', async () => {
    await setup(fixtureRange); nextButton().addEventListener('click', () => { document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent = '第二章'; });
    const pending = adapter.perform('next-page', 'chapter', adapter.snapshot().position.key); let done = false; void pending.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(250); expect(done).toBe(false);
    document.querySelector('.preRenderContent')!.innerHTML = '<h2>第二章</h2><p>新章内容。</p>';
    await vi.advanceTimersByTimeAsync(230);
    expect(await pending).toMatchObject({ ok: true, snapshot: { document: { title: '第二章' } } });
  });
  it('does not confirm a new chapter when range evidence disappears', async () => {
    await setup(fixtureRange); nextButton().addEventListener('click', () => {
      rangeAvailable = false;
      document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent = '第二章';
      document.querySelector('.preRenderContent')!.innerHTML = '<h2>第二章</h2><p>新章内容。</p>';
    });
    const pending = adapter.perform('next-page', 'no-new-range', adapter.snapshot().position.key);
    await vi.advanceTimersByTimeAsync(550);
    expect(await pending).toMatchObject({ ok: false, reason: 'not-confirmed' });
  });
  it('rotates the epoch on SPA document changes without a DOM mutation and rejects old actions', async () => {
    await setup(fixtureRange); const before = adapter.snapshot(); const click = vi.fn(); nextButton().addEventListener('click', click);
    currentUrl = 'https://weread.qq.com/web/reader/another-synthetic-book';
    const next = adapter.snapshot();
    expect(next.epoch).not.toBe(before.epoch); expect(next.document).toBeUndefined();
    expect(await adapter.perform('next-page', 'old-document', before.position.key, before.epoch)).toMatchObject({ ok: false, reason: 'stale-position' });
    expect(click).not.toHaveBeenCalled();
  });
  it('cancels a pending action on SPA document change and does not keep its uncertain latch', async () => {
    await setup(fixtureRange); const before = adapter.snapshot();
    const pending = adapter.perform('next-page', 'old-pending', before.position.key, before.epoch);
    currentUrl = 'https://weread.qq.com/web/reader/another-synthetic-book';
    const after = adapter.snapshot();
    expect(await pending).toMatchObject({ ok: false, reason: 'source-unavailable' });
    expect(after.epoch).not.toBe(before.epoch); expect(after.operationState).toBe('idle');
  });
  it('recognizes the observed native pager selectors while ignoring hidden ancestors', async () => {
    await setup(fixtureRange);
    document.querySelector('[aria-label="上一页"]')!.remove(); nextButton().remove();
    document.body.insertAdjacentHTML('beforeend', '<div style="display:none"><button class="renderTarget_pager_button_right">隐藏</button></div><button class="renderTarget_pager_button">上一页</button><button class="renderTarget_pager_button renderTarget_pager_button_right">下一页</button>');
    const visible = document.querySelectorAll<HTMLElement>('.renderTarget_pager_button_right')[1]!;
    const click = vi.fn(moveToNextRange); visible.addEventListener('click', click);
    const pending = adapter.perform('next-page', 'native-pager', adapter.snapshot().position.key);
    expect(await pending).toMatchObject({ ok: true }); expect(click).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed or cross-chapter ranges instead of clipping a two-page spread', async () => {
    await setup(content => { const range = fixtureRange(content)!; return { ...range, end: { ...range.end, documentId: 'unrepresented-other-chapter' } }; });
    expect(adapter.snapshot().pageRange).toBeUndefined(); expect(adapter.snapshot().capabilities['next-page']).toBe(false);
    adapter.stop();
    await setup(content => { const range = fixtureRange(content)!; return { ...range, end: { ...range.end, offset: 9999 } }; });
    expect(adapter.snapshot().pageRange).toBeUndefined();
  });
  it('never clicks an old request again after its detailed result has left the bounded cache', async () => {
    await setup(fixtureRange, '足够长的合成段落。'.repeat(20));
    const original = adapter.snapshot(); const click = vi.fn(moveToNextRange); nextButton().addEventListener('click', click);
    for (let index = 0; index < 35; index++) {
      const before = adapter.snapshot();
      expect(await adapter.perform('next-page', 'request-' + index, before.position.key, before.epoch)).toMatchObject({ ok: true });
    }
    // Return the synthetic source to its original coordinates, so position-only
    // stale checks cannot conceal a missing request-ID tombstone.
    visibleOffset = 0; document.querySelector('.readerFooter_progress')!.textContent = '1 / 3';
    expect(adapter.snapshot().position.key).toBe(original.position.key);
    expect(await adapter.perform('next-page', 'request-0', original.position.key, original.epoch)).toMatchObject({ ok: false, reason: 'stale-position' });
    expect(click).toHaveBeenCalledTimes(35);
  });
  it('starts a fresh epoch when a stopped adapter instance is reused', async () => {
    await setup(fixtureRange); const before = adapter.snapshot();
    adapter.stop(); adapter.start(); await vi.advanceTimersByTimeAsync(200);
    expect(adapter.snapshot().epoch).not.toBe(before.epoch);
    expect(await adapter.perform('next-page', 'before-restart', before.position.key, before.epoch)).toMatchObject({ ok: false, reason: 'stale-position' });
  });
});
