import type { ContentBlock, ImageBlock } from '../../content-model/src/index';
import { sanitizeMarkup } from '../../content-model/src/sanitize';
import type { CapturedBlockKind, MountedCapturedFrame } from '../../display-sdk/src/captured-document';
import type { ImageMode } from '../../storage/src/index';

export function blockKinds(block: ContentBlock): CapturedBlockKind[] {
  switch (block.type) {
    case 'heading': return [`heading${Math.max(1, Math.min(6, block.level))}` as CapturedBlockKind];
    case 'list': return [block.ordered ? 'orderedList' : 'unorderedList', 'listItem'];
    default: return [block.type];
  }
}
export function blockLabel(kind: CapturedBlockKind): string {
  return ({ paragraph: '段落', quote: '引用', code: '代码', table: '表格', image: '图片', math: '公式', orderedList: '有序列表', unorderedList: '无序列表', listItem: '列表项' } as Partial<Record<CapturedBlockKind, string>>)[kind] ?? '标题';
}
interface Actions {
  imageMode: ImageMode;
  onPreview(block: ImageBlock, trigger: HTMLElement): void;
  onImageLayout(element: HTMLElement): void;
  onCopyFailure(): void;
}

/** Only content nodes change; captured wrapper classes and message branches stay intact. */
export function renderCapturedBlock(frame: MountedCapturedFrame, block: ContentBlock, actions: Actions): HTMLElement {
  const doc = frame.root.ownerDocument;
  const clone = frame.cloneBlock(blockKinds(block)[0]!);
  const { root, content } = clone;
  content.dataset.fvBlockContent = '';
  let node = root;
  switch (block.type) {
    case 'paragraph': case 'heading': case 'quote':
      fillTextContent(root, content, block.html, doc); break;
    case 'list': {
      const items = block.items.map(html => {
        const item = frame.cloneBlock('listItem');
        fillTextContent(item.root, item.content, html, doc); return item.root;
      });
      content.replaceChildren(...items); break;
    }
    case 'code': content.textContent = block.text; break;
    case 'math': {
      // Source MathML/text replaces the whole visible formula payload. Never
      // retain the captured example's precomputed glyphs or accessible label.
      content.replaceChildren(sanitizeMarkup(block.html, doc));
      if (!content.textContent?.trim()) content.textContent = block.text;
      root.removeAttribute('data-math-source'); root.setAttribute('aria-label', block.text);
      break;
    }
    case 'table': {
      fillTable(content, block.html, doc);
      if (block.caption || block.captionHtml) {
        const caption = doc.createElement('p'); caption.dataset.fvReaderUi = 'caption';
        if (block.captionHtml) caption.append(sanitizeMarkup(block.captionHtml, doc)); else caption.textContent = block.caption ?? '';
        root.append(caption);
      }
      break;
    }
    case 'image': {
      if (content.localName !== 'img') throw new Error('captured-frame:image-content-must-be-img');
      node = doc.createElement('figure'); node.dataset.fvImage = ''; node.className = `image-block mode-${actions.imageMode}`;
      const trigger = doc.createElement('button'); trigger.type = 'button'; trigger.className = 'image-trigger'; trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.textContent = actions.imageMode === 'hidden' ? `【${block.label} · 点击查看】` : `${block.label} · 点击查看`;
      const open = () => actions.onPreview(block, trigger);
      trigger.addEventListener('click', open);
      if (actions.imageMode !== 'hidden') {
        const image = content as HTMLImageElement;
        image.removeAttribute('srcset'); image.removeAttribute('sizes'); image.removeAttribute('width'); image.removeAttribute('height');
        image.alt = block.label; image.loading = 'lazy';
        const fail = () => {
          // Privacy detaches the reading view without retiring its image. Keep
          // this block's failure state; the shell filters layout notifications
          // from blocks that belong to a different, retired document.
          if (node.contains(image)) {
            image.remove();
            if (!node.querySelector('.image-failed')) { const notice = doc.createElement('span'); notice.className = 'image-failed'; notice.textContent = '暂时无法显示 · 点击重试'; node.prepend(notice); }
            actions.onImageLayout(node);
          }
        };
        image.addEventListener('load', () => actions.onImageLayout(image)); image.addEventListener('error', fail);
        if (block.src) image.src = block.src; else image.removeAttribute('src');
        image.addEventListener('click', open);
        if (block.src) node.append(root);
        else { const notice = doc.createElement('span'); notice.className = 'image-failed'; notice.textContent = '图片资源暂不可用'; node.append(notice); }
      }
      node.append(trigger);
      if (actions.imageMode === 'full' && (block.caption || block.captionHtml)) {
        const caption = doc.createElement('figcaption');
        if (block.captionHtml) caption.append(sanitizeMarkup(block.captionHtml, doc)); else caption.textContent = block.caption ?? '';
        node.append(caption);
      }
      break;
    }
  }
  for (const button of root.querySelectorAll<HTMLElement>('[data-fv-content-action="copy"]')) {
    button.removeAttribute('inert'); button.removeAttribute('aria-hidden');
    button.addEventListener('click', () => {
      const text = block.type === 'code' ? block.text : block.type === 'table' ? tableClipboardText(content as HTMLTableElement) : content.textContent ?? '';
      if (!doc.defaultView?.navigator.clipboard?.writeText) { actions.onCopyFailure(); return; }
      void doc.defaultView.navigator.clipboard.writeText(text).catch(actions.onCopyFailure);
    });
  }
  node.id = block.id; node.dataset.block = 'true'; node.dataset.blockType = block.type;
  return node;
}

function tableClipboardText(table: HTMLTableElement): string {
  const field = (cell: Element): string => {
    const value = cell.textContent ?? '';
    return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  const rows = [...table.rows].map(row => [...row.cells].map(field).join('\t'));
  if (table.caption) rows.unshift(field(table.caption));
  return rows.join('\n');
}

function fillTextContent(root: HTMLElement, content: HTMLElement, html: string, doc: Document): void {
  const safe = sanitizeMarkup(html, doc);
  // Captured block wrappers contain serialization line breaks around their
  // payload. They belong to the neutral template, not the new source text.
  // Remove only those sibling text nodes before inserting the source fragment;
  // all whitespace in that fragment remains untouched.
  for (let current: HTMLElement = content; current !== root && current.parentElement; current = current.parentElement) {
    for (const sibling of [...current.parentElement.childNodes]) {
      if (sibling.nodeType === 3 && !sibling.textContent?.trim()) sibling.remove();
    }
  }
  const blockTags = 'p,div,blockquote,ul,ol,pre,table,h1,h2,h3,h4,h5,h6';
  if (content !== root && content.localName === 'p' && safe.querySelector(blockTags)) {
    // Quotes and list items may carry several source paragraphs. Reuse the
    // captured paragraph per source paragraph instead of nesting <p> in <p>.
    const nodes = [...safe.childNodes].map(node => {
      if (node.nodeType !== 1 || (node as Element).localName !== 'p') return node;
      const paragraph = content.cloneNode(false) as HTMLElement;
      paragraph.removeAttribute('data-fv-block-content'); paragraph.append(...node.childNodes);
      return paragraph;
    });
    content.replaceWith(...nodes); root.dataset.fvBlockContent = '';
  } else content.replaceChildren(safe);
}

function fillTable(target: HTMLElement, html: string, doc: Document): void {
  if (target.localName !== 'table') throw new Error('captured-frame:table-content-must-be-table');
  const source = doc.createElement('div'); source.append(sanitizeMarkup(html, doc));
  const sourceTable = source.querySelector('table');
  if (!sourceTable) throw new Error('captured-frame:invalid-source-table');
  const prototypes = {
    head: target.querySelector('thead'), body: target.querySelector('tbody'),
    row: target.querySelector('tr'), th: target.querySelector('th'), td: target.querySelector('td')
  };
  if (!prototypes.row || !prototypes.th || !prototypes.td || !prototypes.body) throw new Error('captured-frame:incomplete-table-template');
  const copy = (template: Element) => template.cloneNode(false) as HTMLElement;
  const rows = (section: Element, into: HTMLElement) => {
    for (const child of section.childNodes) {
      if (child.nodeType === 3) { into.append(child.cloneNode()); continue; }
      if (child.nodeType !== 1) continue;
      const sourceRow = child as Element;
      if (sourceRow.localName !== 'tr') continue;
      const row = copy(prototypes.row!);
      for (const child of sourceRow.childNodes) {
        if (child.nodeType === 3) { row.append(child.cloneNode()); continue; }
        if (child.nodeType !== 1) continue;
        const sourceCell = child as Element;
        if (!['th', 'td'].includes(sourceCell.localName)) continue;
        const cell = copy(sourceCell.localName === 'th' ? prototypes.th! : prototypes.td!);
        for (const attribute of ['colspan', 'rowspan', 'scope']) { const value = sourceCell.getAttribute(attribute); if (value !== null) cell.setAttribute(attribute, value); }
        cell.append(...sourceCell.childNodes); row.append(cell);
      }
      into.append(row);
    }
  };
  // Inter-element source whitespace participates in source UTF-16 anchors.
  // Retain it while replacing only the structural elements with real templates.
  const output: Node[] = [];
  for (const child of sourceTable.childNodes) {
    if (child.nodeType === 3) { output.push(child.cloneNode()); continue; }
    if (child.nodeType !== 1) continue;
    const section = child as Element;
    if (section.localName === 'caption') { output.push(section.cloneNode(true) as HTMLElement); continue; }
    if (!['thead', 'tbody', 'tfoot'].includes(section.localName)) continue;
    const template = section.localName === 'thead' ? prototypes.head : prototypes.body;
    if (!template) throw new Error('captured-frame:missing-table-section');
    const group = section.localName === 'tfoot' ? doc.createElement('tfoot') : copy(template);
    rows(section, group); output.push(group);
  }
  target.replaceChildren(...output);
}
