import type { ContentAnchor, ViewAnchor } from '../../reader-protocol/src/index';

function textNodes(block: Element): Text[] {
  // Captured code/table wrappers also contain local buttons and labels. They
  // are presentation, never part of the source's UTF-16 content coordinates.
  const content = block.matches('[data-fv-block-content]') ? block : block.querySelector('[data-fv-block-content]') ?? block;
  const walker = block.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = []; let node: Node | null;
  while ((node = walker.nextNode())) if ((node as Text).length) nodes.push(node as Text);
  return nodes;
}
function characterRect(node: Text, offset: number): DOMRect | undefined {
  if (!node.length) return;
  const range = node.ownerDocument.createRange();
  range.setStart(node, Math.min(offset, node.length - 1));
  range.setEnd(node, Math.min(offset + 1, node.length));
  return typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : undefined;
}

/** UTF-16 text offsets refer to rendered semantic block text, not scroll pixels. */
export function captureReadingAnchor(view: HTMLElement, scroller: HTMLElement, documentId: string): ViewAnchor | undefined {
  const top = scroller.getBoundingClientRect().top;
  const blocks = [...view.querySelectorAll<HTMLElement>('[data-block]')];
  const block = blocks.find(node => node.getBoundingClientRect().bottom > top) ?? blocks[0];
  if (!block) return;
  // Captions and image action labels change with display policy. Anchor the
  // semantic image itself, never an offset into a transient control label.
  if (block.dataset.blockType === 'image') return { documentId, blockId: block.id, offset: 0, viewportOffset: block.getBoundingClientRect().top - top };
  let offset = 0;
  for (const node of textNodes(block)) {
    const last = characterRect(node, node.length - 1);
    if (!last || last.height === 0) { offset += node.length; continue; }
    if (last.bottom <= top) { offset += node.length; continue; }
    let low = 0, high = Math.max(0, node.length - 1);
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const rect = characterRect(node, middle);
      if (rect && rect.bottom <= top) low = middle + 1; else high = middle;
    }
    const rect = characterRect(node, low);
    return { documentId, blockId: block.id, offset: offset + low, viewportOffset: (rect?.top ?? block.getBoundingClientRect().top) - top };
  }
  return { documentId, blockId: block.id, offset: 0, viewportOffset: block.getBoundingClientRect().top - top };
}

function resolveReadingAnchor(view: HTMLElement, documentId: string, anchor: ContentAnchor): { block: HTMLElement; nodes: Text[] } | undefined {
  if (anchor.documentId !== documentId || !Number.isSafeInteger(anchor.offset) || anchor.offset < 0) return;
  const block = [...view.querySelectorAll<HTMLElement>('[data-block]')].find(node => node.id === anchor.blockId);
  if (!block) return;
  if (block.dataset.blockType === 'image') return anchor.offset === 0 ? { block, nodes: [] } : undefined;
  const nodes = textNodes(block);
  return anchor.offset <= nodes.reduce((length, node) => length + node.length, 0) ? { block, nodes } : undefined;
}

/** Validate detached/private content without reading geometry or moving a view. */
export function canRestoreReadingAnchor(view: HTMLElement, documentId: string, anchor: ContentAnchor): boolean {
  return !!resolveReadingAnchor(view, documentId, anchor);
}

export function restoreReadingAnchor(view: HTMLElement, scroller: HTMLElement, documentId: string, anchor: ContentAnchor & { viewportOffset?: number }): boolean {
  const resolved = resolveReadingAnchor(view, documentId, anchor);
  if (!resolved) return false;
  const { block, nodes } = resolved;
  if (block.dataset.blockType === 'image') {
    const rect = block.getBoundingClientRect();
    const requested = anchor.viewportOffset ?? 8;
    // Keep a partly visible image in place. If changing image mode shrinks the
    // block past that point, show its boundary rather than skipping beyond it.
    const viewportOffset = requested < 0 && -requested >= rect.height ? 8 : requested;
    scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - viewportOffset;
    return true;
  }
  let offset = anchor.offset, rect: DOMRect | undefined;
  for (const node of nodes) {
    if (offset < node.length || node === nodes[nodes.length - 1]) { rect = characterRect(node, Math.min(offset, Math.max(0, node.length - 1))); break; }
    offset -= node.length;
  }
  const top = rect && rect.height > 0 ? rect.top : block.getBoundingClientRect().top;
  scroller.scrollTop += top - scroller.getBoundingClientRect().top - (anchor.viewportOffset ?? 8);
  return true;
}
