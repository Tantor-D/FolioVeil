// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedBlockKind, MountedCapturedFrame } from '../packages/display-sdk/src/captured-document';
import { renderCapturedBlock } from '../packages/reader-view/src/captured-content';
import { restoreReadingAnchor } from '../packages/reader-view/src/anchor';

// Neutral templates actually captured from the authorized page. This is local
// content-mapping coverage, not a browser or visual acceptance claim.
const capture = JSON.parse(readFileSync('packages/theme-chatgpt/capture/neutral-0.5.0/desktop-light-collapsed.json', 'utf8'));
const source = new DOMParser().parseFromString(capture.html, 'text/html');
const specs: Partial<Record<CapturedBlockKind, [string, string]>> = {
  paragraph: ['p[data-local-template]', ':scope'], quote: ['blockquote[data-local-template]', 'p'], heading1: ['h1[data-local-template]', ':scope'],
  orderedList: ['ol[data-local-template]', ':scope'], unorderedList: ['ul[data-local-template]', ':scope'], listItem: ['ol[data-local-template]', 'p'],
  table: ['div[data-local-template]', 'table'], code: ['pre[data-local-template]', 'code'], math: ['[role="math"][aria-label="E=mc^2"]', ':scope'], image: ['p[data-local-template]:has(img)', 'img']
};
const frame = {
  root: document.body,
  cloneBlock(kind: CapturedBlockKind) {
    const [key, slot] = specs[kind]!;
    let root = document.importNode(source.querySelector(key)!, true) as HTMLElement;
    if (kind === 'listItem') root = root.querySelector('li')!;
    const content = slot === ':scope' ? root : root.querySelector<HTMLElement>(slot)!;
    return { root, content };
  }
} as MountedCapturedFrame;
const actions = () => ({ imageMode: 'hidden' as const, onPreview: vi.fn(), onImageLayout: vi.fn(), onCopyFailure: vi.fn() });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('captured content templates', () => {
  it('keeps original template classes and exact Chinese inline text through repeated paragraphs and list items', () => {
    const input = '<span>逐</span><span>字</span><strong>原文</strong>，保留 English spaces。';
    const paragraph = renderCapturedBlock(frame, { id: 'p', type: 'paragraph', html: input }, actions());
    expect(paragraph.textContent).toBe('逐字原文，保留 English spaces。');
    expect(paragraph.className).toBe(source.querySelector(specs.paragraph![0])!.className);
    const list = renderCapturedBlock(frame, { id: 'list', type: 'list', ordered: true, items: [input, '第二项'] }, actions());
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(list.querySelector('li')!.textContent).toBe('逐字原文，保留 English spaces。');
    expect(list.textContent).not.toContain('将桌面物品');
  });

  it('fills table rows and cells from captured templates without keeping neutral sample cells', () => {
    const table = renderCapturedBlock(frame, { id: 'table', type: 'table', html: '<table><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td colspan="2"><strong>合并</strong></td></tr></tbody></table>' }, actions());
    expect(table.className).toBe(source.querySelector(specs.table![0])!.className);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(table.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(table.querySelector('th')?.className).toBe(source.querySelector(specs.table![0] + ' th')!.className);
    expect(table.querySelector('table')?.textContent).toBe('甲乙合并');
    expect(table.querySelector('strong')?.textContent).toBe('合并');
  });

  it('keeps multiple source paragraphs in quotes and list items without nesting paragraphs or dropping text', () => {
    const html = '<p>引用第一段<strong>强调</strong>。</p><p>引用第二段。</p>';
    const quote = renderCapturedBlock(frame, { id: 'quote', type: 'quote', html }, actions());
    expect(quote.querySelectorAll(':scope > p')).toHaveLength(2);
    expect(quote.querySelector('p p')).toBeNull(); expect(quote.textContent).toBe('引用第一段强调。引用第二段。');
    const list = renderCapturedBlock(frame, { id: 'list', type: 'list', ordered: true, items: [html] }, actions());
    expect(list.textContent).toBe(quote.textContent); expect(list.querySelector('p p')).toBeNull();
    const spaced = renderCapturedBlock(frame, { id: 'spaced', type: 'quote', html: '  原文首尾空格\n' }, actions());
    expect(spaced.textContent).toBe('  原文首尾空格\n');
  });

  it('preserves table captions and footer text alongside external rich captions', () => {
    const table = renderCapturedBlock(frame, { id: 'table', type: 'table', html: '<table><caption>表内标题</caption><tbody><tr><td>中间</td></tr></tbody><tfoot><tr><td>合计</td></tr></tfoot></table>', captionHtml: '<strong>来源图注</strong>' }, actions());
    expect(table.querySelector('caption')?.textContent).toBe('表内标题');
    expect(table.querySelector('tfoot')?.textContent).toBe('合计');
    expect(table.querySelector('[data-fv-reader-ui="caption"] strong')?.textContent).toBe('来源图注');
  });

  it('preserves table whitespace used by source character offsets while cloning structural templates', () => {
    const html = '<table>\n<thead>\n<tr><th>甲</th> <th>乙</th></tr>\n</thead>\n<tbody>\n<tr><td>A</td> <td>B</td></tr>\n</tbody>\n<tfoot>\n<tr><td>末</td></tr>\n</tfoot>\n</table>';
    const original = new DOMParser().parseFromString(html, 'text/html').querySelector('table')!;
    const rendered = renderCapturedBlock(frame, { id: 'table', type: 'table', html }, actions());
    const view = document.createElement('div'); view.append(rendered); document.body.append(view);
    expect(rendered.querySelector('table')?.textContent).toBe(original.textContent);
    const scroller = document.createElement('main'), length = original.textContent!.length;
    expect(restoreReadingAnchor(view, scroller, 'doc', { documentId: 'doc', blockId: 'table', offset: length })).toBe(true);
    expect(restoreReadingAnchor(view, scroller, 'doc', { documentId: 'doc', blockId: 'table', offset: length + 1 })).toBe(false);
  });

  it('copies table rows and columns with separators while retaining exact code copy text', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const navigator = document.defaultView!.navigator;
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const copyFrame = { ...frame, cloneBlock(kind: CapturedBlockKind) {
      const clone = frame.cloneBlock(kind);
      for (const button of clone.root.querySelectorAll('button')) if (/复制/.test(button.getAttribute('aria-label') ?? '')) button.setAttribute('data-fv-content-action', 'copy');
      return clone;
    } };
    try {
      const table = renderCapturedBlock(copyFrame, { id: 'table', type: 'table', html: '<table><caption>标题\n副标题</caption><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>含\t制表符</td><td>引号"与\n换行</td></tr></tbody></table>' }, actions());
      table.querySelector<HTMLButtonElement>('[data-fv-content-action="copy"]')!.click();
      expect(writeText).toHaveBeenLastCalledWith('"标题\n副标题"\n甲\t乙\n1\t2\n"含\t制表符"\t"引号""与\n换行"');
      const code = renderCapturedBlock(copyFrame, { id: 'code', type: 'code', text: '  a\tb\n"c"\n' }, actions());
      code.querySelector<HTMLButtonElement>('[data-fv-content-action="copy"]')!.click();
      expect(writeText).toHaveBeenLastCalledWith('  a\tb\n"c"\n');
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('replaces all example formula glyphs and labels when rendering source MathML', () => {
    const math = renderCapturedBlock(frame, { id: 'math', type: 'math', text: 'x²=4', html: '<math><msup><mi>x</mi><mn>2</mn></msup><mo>=</mo><mn>4</mn></math>' }, actions());
    expect(math.querySelector('math')).not.toBeNull();
    expect(math.textContent).toBe('x2=4');
    expect(math.textContent).not.toContain('E');
    expect(math.getAttribute('aria-label')).toBe('x²=4');
    expect(math.querySelector('.katex-html')).toBeNull();
    expect(math.hasAttribute('data-math-source')).toBe(false);
  });

  it('uses only source code text as semantic anchor coordinates, excluding captured action labels', () => {
    const code = renderCapturedBlock(frame, { id: 'code', type: 'code', text: 'ab\ncd' }, actions());
    const view = document.createElement('div'); view.append(code); document.body.append(view);
    const scroller = document.createElement('main');
    expect(code.querySelector('code')?.textContent).toBe('ab\ncd');
    expect(restoreReadingAnchor(view, scroller, 'doc', { documentId: 'doc', blockId: 'code', offset: 5 })).toBe(true);
    expect(restoreReadingAnchor(view, scroller, 'doc', { documentId: 'doc', blockId: 'code', offset: 6 })).toBe(false);
  });

  it('keeps hidden image URLs out of live markup and reuses the original image template for full mode', () => {
    const image = { id: 'image', type: 'image' as const, src: 'https://fixtures.invalid/example.png', label: '图片 1', caption: '合成图注', resourceKind: 'image' as const };
    const callbacks = actions();
    const hidden = renderCapturedBlock(frame, image, callbacks);
    expect(hidden.querySelector('img')).toBeNull(); expect(hidden.outerHTML).not.toContain(image.src);
    hidden.querySelector('button')!.click(); expect(callbacks.onPreview).toHaveBeenCalledWith(image, expect.any(HTMLElement));
    const full = renderCapturedBlock(frame, image, { ...callbacks, imageMode: 'full' });
    expect(full.querySelector('img')?.src).toBe(image.src);
    expect(full.querySelector('p')?.className).toBe(source.querySelector(specs.image![0])!.className);
    expect(full.querySelector('figcaption')?.textContent).toBe(image.caption);
    expect(full.outerHTML).not.toContain('w3c_home');
  });

  it('retains an image failure received while its reading view is detached for privacy', () => {
    const image = { id: 'image', type: 'image' as const, src: 'https://fixtures.invalid/detached.png', label: '图片 1', caption: '合成图注', resourceKind: 'image' as const };
    const callbacks = { ...actions(), imageMode: 'full' as const };
    const block = renderCapturedBlock(frame, image, callbacks);
    const readingView = document.createElement('section'); readingView.append(block); document.body.append(readingView);
    const pending = block.querySelector('img')!;
    readingView.remove();
    expect(pending.isConnected).toBe(false);
    pending.dispatchEvent(new Event('error'));
    pending.dispatchEvent(new Event('error'));
    document.body.append(readingView);
    expect(block.querySelector('img')).toBeNull();
    expect(block.querySelectorAll('.image-failed')).toHaveLength(1);
    expect(block.querySelector('.image-failed')?.textContent).toContain('点击重试');
    expect(block.querySelector('figcaption')?.textContent).toBe(image.caption);
    expect(callbacks.onImageLayout).toHaveBeenCalledExactlyOnceWith(block);
    block.querySelector<HTMLButtonElement>('.image-trigger')!.click();
    expect(callbacks.onPreview).toHaveBeenCalledWith(image, expect.any(HTMLElement));
  });

  it('keeps an old document image error and load local to its own block after replacement', () => {
    const image = { id: 'image', type: 'image' as const, src: 'https://fixtures.invalid/old.png', label: '图片 1', caption: '', resourceKind: 'image' as const };
    let currentView = document.createElement('section');
    const layoutCurrent = vi.fn();
    const callbacks = { ...actions(), imageMode: 'full' as const, onImageLayout(element: HTMLElement) { if (currentView.contains(element)) layoutCurrent(element); } };
    const old = renderCapturedBlock(frame, image, callbacks);
    currentView.append(old); document.body.append(currentView);
    const pending = old.querySelector('img')!;
    currentView.remove(); currentView = document.createElement('section');
    const current = renderCapturedBlock(frame, { ...image, src: 'https://fixtures.invalid/current.png' }, callbacks);
    currentView.append(current); document.body.append(currentView);
    const before = current.outerHTML;
    pending.dispatchEvent(new Event('error')); pending.dispatchEvent(new Event('load'));
    expect(old.querySelector('.image-failed')).not.toBeNull();
    expect(current.outerHTML).toBe(before);
    expect(current.querySelector('.image-failed')).toBeNull();
    expect(layoutCurrent).not.toHaveBeenCalled();
    current.querySelector('img')!.dispatchEvent(new Event('load'));
    expect(layoutCurrent).toHaveBeenCalledExactlyOnceWith(current.querySelector('img'));
  });
});
