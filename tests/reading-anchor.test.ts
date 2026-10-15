// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { captureReadingAnchor, restoreReadingAnchor } from '../packages/reader-view/src/anchor';

describe('content anchors across reflow', () => {
  it('restores the same character when the line width changes', () => {
    const scroller = document.createElement('main');
    const view = document.createElement('article');
    const paragraph = document.createElement('p');
    paragraph.dataset.block = 'true'; paragraph.id = 'p1'; paragraph.textContent = 'abcdefghijklmnopqrst';
    view.append(paragraph); scroller.append(view); document.body.append(scroller);
    scroller.scrollTop = 20;
    let charsPerLine = 5;
    const rect = (y:number,height=10) => ({x:0,y,top:y,bottom:y+height,left:0,right:100,width:100,height,toJSON:()=>({})}) as DOMRect;
    scroller.getBoundingClientRect = () => rect(0,100);
    paragraph.getBoundingClientRect = () => rect(-scroller.scrollTop,Math.ceil(20/charsPerLine)*10);
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function () { return rect(Math.floor(this.startOffset/charsPerLine)*10-scroller.scrollTop); };
    try {
      const anchor = captureReadingAnchor(view,scroller,'doc')!;
      expect(anchor).toMatchObject({documentId:'doc',blockId:'p1',offset:10,viewportOffset:0});
      charsPerLine = 2;
      expect(restoreReadingAnchor(view,scroller,'doc',anchor)).toBe(true);
      expect(scroller.scrollTop).toBe(50);
      expect(restoreReadingAnchor(view,scroller,'different',anchor)).toBe(false);
      expect(restoreReadingAnchor(view,scroller,'doc',{...anchor,blockId:'missing'})).toBe(false);
    } finally {
      if (original) Range.prototype.getBoundingClientRect = original;
      else delete (Range.prototype as Partial<Range>).getBoundingClientRect;
      scroller.remove();
    }
  });
});

// Geometry below is deliberately synthetic. jsdom does not lay out fonts or
// images; these cases verify coordinate arithmetic, not browser visual parity.
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const box = (y: number, height = 10): DOMRect => ({ x: 0, y, top: y, bottom: y + height, left: 0, right: 100, width: 100, height, toJSON: () => ({}) }) as DOMRect;
function textLeaves(element: Element): Text[] {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = []; let next: Node | null;
  while ((next = walker.nextNode())) nodes.push(next as Text);
  return nodes;
}
function rangeGeometry(read: (range: Range) => DOMRect): void {
  const previous = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, writable: true, value: function (this: Range) { return read(this); } });
  cleanups.push(() => { if (previous) Object.defineProperty(Range.prototype, 'getBoundingClientRect', previous); else delete (Range.prototype as Partial<Range>).getBoundingClientRect; });
}
function syntheticParagraph(html: string) {
  const scroller = document.createElement('main'), view = document.createElement('article'), block = document.createElement('p');
  block.id = 'stable-paragraph'; block.dataset.block = 'true'; block.innerHTML = html;
  view.append(block); scroller.append(view); document.body.append(scroller); cleanups.push(() => scroller.remove());
  const layout = { charsPerLine: 4, lineHeight: 10, precedingHeight: 0, viewportTop: 0 };
  const contentTop = () => layout.viewportTop + layout.precedingHeight - scroller.scrollTop;
  scroller.getBoundingClientRect = () => box(layout.viewportTop, 100);
  block.getBoundingClientRect = () => box(contentTop(), Math.ceil(Array.from(block.textContent ?? '').length / layout.charsPerLine) * layout.lineHeight);
  rangeGeometry(range => {
    const leaves = textLeaves(block), node = range.startContainer as Text;
    let globalOffset = range.startOffset;
    for (const leaf of leaves) { if (leaf === node) break; globalOffset += leaf.length; }
    // A surrogate pair occupies one simulated glyph; UTF-16 offsets still count
    // both code units, as DOM Range and the protocol require.
    const text = block.textContent ?? '';
    if (globalOffset > 0 && /[\uDC00-\uDFFF]/.test(text[globalOffset] ?? '') && /[\uD800-\uDBFF]/.test(text[globalOffset - 1] ?? '')) globalOffset--;
    const glyphIndex = Array.from(text.slice(0, globalOffset)).length;
    return box(contentTop() + Math.floor(glyphIndex / layout.charsPerLine) * layout.lineHeight, layout.lineHeight);
  });
  return { scroller, view, block, layout };
}

describe('semantic anchor boundaries with synthetic geometry', () => {
  it('counts UTF-16 across inline nodes and restores a node-boundary character after reflow', () => {
    const { scroller, view, block, layout } = syntheticParagraph('ab<strong>c😀</strong><em>def</em>gh');
    scroller.scrollTop = 10;
    const anchor = captureReadingAnchor(view, scroller, 'doc')!;
    expect(anchor).toEqual({ documentId: 'doc', blockId: block.id, offset: 5, viewportOffset: 0 });
    expect((block.textContent ?? '').slice(anchor.offset, anchor.offset + 1)).toBe('d');
    layout.charsPerLine = 2; layout.lineHeight = 18;
    expect(restoreReadingAnchor(view, scroller, 'doc', anchor)).toBe(true);
    expect(scroller.scrollTop).toBe(36);
  });

  it('keeps the same offset when inline wrappers are replaced but original text is unchanged', () => {
    const { scroller, view, block } = syntheticParagraph('ab<strong>c😀</strong><em>def</em>gh');
    scroller.scrollTop = 10;
    const anchor = captureReadingAnchor(view, scroller, 'doc')!;
    block.replaceChildren(document.createTextNode(block.textContent ?? ''));
    scroller.scrollTop = 0;
    expect(restoreReadingAnchor(view, scroller, 'doc', anchor)).toBe(true);
    expect(scroller.scrollTop).toBe(10);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 11])('rejects invalid or out-of-range offset %s without moving the viewport', offset => {
    const { scroller, view, block } = syntheticParagraph('0123456789'); scroller.scrollTop = 25;
    expect(restoreReadingAnchor(view, scroller, 'doc', { documentId: 'doc', blockId: block.id, offset })).toBe(false);
    expect(scroller.scrollTop).toBe(25);
  });

  it('preserves a partially visible line relative to a nonzero viewport origin', () => {
    const { scroller, view, layout } = syntheticParagraph('abcdefghijklmnop');
    layout.viewportTop = 80; scroller.scrollTop = 13;
    const anchor = captureReadingAnchor(view, scroller, 'doc')!;
    expect(anchor).toMatchObject({ offset: 4, viewportOffset: -3 });
    layout.lineHeight = 20;
    expect(restoreReadingAnchor(view, scroller, 'doc', anchor)).toBe(true);
    expect(scroller.scrollTop).toBe(23);
  });

  it('restores the same prose position when a preceding image shrinks and the font reflows', () => {
    const { scroller, view, layout } = syntheticParagraph('abcdefghijklmnopqrst');
    layout.precedingHeight = 120; layout.charsPerLine = 5; scroller.scrollTop = 140;
    const anchor = captureReadingAnchor(view, scroller, 'doc')!;
    expect(anchor).toMatchObject({ offset: 10, viewportOffset: 0 });
    // Simulates full image -> hidden marker together with a new text layout.
    layout.precedingHeight = 20; layout.charsPerLine = 4; layout.lineHeight = 15;
    expect(restoreReadingAnchor(view, scroller, 'doc', anchor)).toBe(true);
    expect(scroller.scrollTop).toBe(50);
  });

  it('restores a valid end offset despite an empty trailing inline text node', () => {
    const { scroller, view, block } = syntheticParagraph('abcdefghijkl');
    block.append(document.createTextNode(''));
    expect(restoreReadingAnchor(view, scroller, 'doc', { documentId: 'doc', blockId: block.id, offset: 12, viewportOffset: 0 })).toBe(true);
    expect(scroller.scrollTop).toBe(20);
  });

  it('anchors image blocks to their stable boundary instead of mode-dependent captions and buttons', () => {
    const scroller = document.createElement('main'), view = document.createElement('article'), image = document.createElement('figure');
    image.id = 'figure'; image.dataset.block = 'true'; image.dataset.blockType = 'image'; image.className = 'image-block mode-full';
    image.innerHTML = '<button>图片 · 点击查看</button><figcaption>完整图片说明的正文。</figcaption>';
    view.append(image); scroller.append(view); document.body.append(scroller); cleanups.push(() => scroller.remove());
    scroller.scrollTop = 100;
    scroller.getBoundingClientRect = () => box(0, 80);
    image.getBoundingClientRect = () => box(-scroller.scrollTop, 150);
    rangeGeometry(range => box(((range.startContainer.parentElement?.localName === 'figcaption' ? 100 : 80) + Math.floor(range.startOffset / 5) * 10) - scroller.scrollTop));
    const anchor = captureReadingAnchor(view, scroller, 'doc')!;
    expect(anchor).toEqual({ documentId: 'doc', blockId: 'figure', offset: 0, viewportOffset: -100 });
    image.className = 'image-block mode-hidden'; image.innerHTML = '<button>【图片 · 点击查看】</button>';
    expect(restoreReadingAnchor(view, scroller, 'doc', anchor)).toBe(true);
    expect(scroller.scrollTop).toBe(100);
  });
});
