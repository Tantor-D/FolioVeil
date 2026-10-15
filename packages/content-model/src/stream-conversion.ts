import type { ContentBlock, ReaderDocument } from './index';
import type { ListEntry, StreamItem } from './stream';
import { sanitizeMarkup } from './sanitize';

export type ResourceRegistrar = (src: string) => string;
export type ResourceResolver = (id: string) => string | undefined;
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Convert source markup to plain block data before crossing the boundary. */
export function blockToItem(block: ContentBlock, chapterId: string, sequence: number, doc: Document, register?: ResourceRegistrar): StreamItem {
  const base = { id: `${chapterId}:item:${sequence}`, chapterId, sequence };
  const parse = (html: string) => { const root = doc.createElement('div'); root.append(sanitizeMarkup(html, doc)); return root; };
  const text = (html: string) => {
    const root = parse(html);
    root.querySelectorAll('br').forEach(n => n.replaceWith(doc.createTextNode('\n')));
    return root.textContent ?? '';
  };
  const listEntries = (root: Element): ListEntry[] => [...root.children].filter(n => n.localName === 'li').map(n => {
    const copy = n.cloneNode(true) as Element;
    const nested = [...copy.querySelectorAll('ul,ol')].filter(l => !l.parentElement?.closest('ul,ol'));
    const children = nested.map(l => ({ ordered: l.localName === 'ol', items: listEntries(l) }));
    nested.forEach(l => l.remove());
    return { text: text(copy.innerHTML), ...(children.length ? { children } : {}) };
  });
  switch (block.type) {
    case 'paragraph': return { ...base, kind: 'text', data: { text: text(block.html) } };
    case 'quote': return { ...base, kind: 'quote', data: { text: text(block.html) } };
    case 'heading': return { ...base, kind: 'heading', data: { text: text(block.html), level: block.level } };
    case 'code': return { ...base, kind: 'code', data: { text: block.text } };
    case 'math': {
      const math = parse(block.html).querySelector('math');
      return { ...base, kind: 'math', data: math ? { text: block.text, format: 'mathml', expression: math.outerHTML } : { text: block.text, format: 'text' } };
    }
    case 'image': return { ...base, kind: 'image', data: { alt: block.label, caption: block.caption,
      ...(block.src && register ? { resourceId: register(block.src) } : { unavailableReason: block.unavailableReason ?? 'resource-unavailable' }) } };
    case 'list': {
      const root = doc.createElement(block.ordered ? 'ol' : 'ul');
      for (const html of block.items) { const li = doc.createElement('li'); li.append(sanitizeMarkup(html, doc)); root.append(li); }
      return { ...base, kind: 'list', data: { ordered: block.ordered, items: listEntries(root) } };
    }
    case 'table': {
      const table = parse(block.html).querySelector('table');
      if (!table) return { ...base, kind: 'unsupported', data: { label: '表格', reason: 'invalid-table' } };
      return { ...base, kind: 'table', data: { caption: block.caption, rows: [...table.rows].map(row => [...row.cells].map(cell => ({
        text: text(cell.innerHTML), header: cell.localName === 'th', rowSpan: cell.rowSpan, colSpan: cell.colSpan
      }))) } };
    }
  }
}

/** Rendering bridge for the existing captured block templates. Strings are text, never HTML. */
export function itemToBlock(item: Exclude<StreamItem, { kind: 'title' }>, resolve?: ResourceResolver): ContentBlock {
  const base = { id: item.id };
  const lines = (text: string) => escape(text).replaceAll('\n', '<br>');
  const listHTML = (entries: ListEntry[]): string[] => entries.map(e => lines(e.text) + (e.children ?? []).map(c => {
    const tag = c.ordered ? 'ol' : 'ul'; return `<${tag}>${listHTML(c.items).map(v => `<li>${v}</li>`).join('')}</${tag}>`;
  }).join(''));
  switch (item.kind) {
    case 'text': return { ...base, type: 'paragraph', html: lines(item.data.text) };
    case 'heading': return { ...base, type: 'heading', level: item.data.level, html: lines(item.data.text) };
    case 'quote': return { ...base, type: 'quote', html: lines(item.data.text) };
    case 'code': return { ...base, type: 'code', text: item.data.text };
    case 'math': return { ...base, type: 'math', text: item.data.text, html: item.data.format === 'mathml' ? item.data.expression ?? escape(item.data.text) : escape(item.data.text) };
    case 'image': return { ...base, type: 'image', resourceKind: 'image', label: item.data.alt, caption: item.data.caption ?? '',
      src: item.data.resourceId ? resolve?.(item.data.resourceId) : undefined, unavailableReason: item.data.unavailableReason };
    case 'list': return { ...base, type: 'list', ordered: item.data.ordered, items: listHTML(item.data.items) };
    case 'table': return { ...base, type: 'table', caption: item.data.caption, html: `<table><tbody>${item.data.rows.map(row => `<tr>${row.map(c => {
      const tag = c.header ? 'th' : 'td'; return `<${tag} rowspan="${c.rowSpan ?? 1}" colspan="${c.colSpan ?? 1}">${lines(c.text)}</${tag}>`;
    }).join('')}</tr>`).join('')}</tbody></table>` };
    case 'unsupported': return { ...base, type: 'paragraph', html: lines(`【${item.data.label}：${item.data.reason}】`) };
  }
}

/** One chapter's source block identities, not text equality, define incremental additions. */
export class DocumentStreamEncoder {
  private sequence = 0;
  private chapters = new Map<string, string[]>();
  private currentChapter?: string;
  constructor(private readonly doc: Document, private readonly register?: ResourceRegistrar) {}
  append(value: ReaderDocument): StreamItem[] {
    const previous = this.chapters.get(value.id) ?? [];
    const signatures = value.blocks.map(block => JSON.stringify(block));
    if (previous.some((s, i) => s !== signatures[i])) throw new Error('source-content-changed');
    if (this.currentChapter !== value.id && this.chapters.has(value.id)) throw new Error('source-moved-backwards');
    let sequence = this.sequence;
    const items: StreamItem[] = [];
    if (this.currentChapter !== value.id) items.push({ id: `${value.id}:title`, chapterId: value.id, sequence: ++sequence, kind: 'title', data: { text: value.title } });
    for (let i = previous.length; i < value.blocks.length; i++) items.push(blockToItem(value.blocks[i]!, value.id, ++sequence, this.doc, this.register));
    this.sequence = sequence; this.currentChapter = value.id; this.chapters.set(value.id, signatures);
    return items;
  }
}
