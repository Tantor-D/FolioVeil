/** Source-local navigation signals. A missing pager alone never proves scroll mode. */
export type WeReadLayout = 'paginated' | 'scroll';

export function displayed(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.matches('[hidden],[aria-hidden="true"]')) return false;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  }
  return true;
}

export function nextChapterButton(doc: Document): HTMLButtonElement | undefined {
  return [...doc.querySelectorAll<HTMLButtonElement>('button.readerFooter_button')].find(node =>
    node.textContent?.trim() === '下一章' && !node.disabled && node.getAttribute('aria-disabled') !== 'true' && displayed(node));
}

export function scrollBookEnd(doc: Document): boolean {
  return [...doc.querySelectorAll('button')].some(node => node.textContent?.trim() === '标记读完' && displayed(node));
}

export function readingLayout(doc: Document): WeReadLayout | undefined {
  const paginated = [...doc.querySelectorAll('.renderTarget_pager_button')].some(displayed)
    || [...doc.querySelectorAll('.renderTarget_pager_button_right')].some(displayed);
  const scroll = !!nextChapterButton(doc) || scrollBookEnd(doc)
    || [...doc.querySelectorAll('button.readerHeaderButton')].some(node => node.textContent?.trim() === '上一章' && displayed(node));
  return paginated === scroll ? undefined : paginated ? 'paginated' : 'scroll';
}
