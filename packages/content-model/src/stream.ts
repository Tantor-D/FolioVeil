/** Public, source-independent, session-only wire format. No inline markup. */
export interface ListEntry { text: string; children?: { ordered: boolean; items: ListEntry[] }[] }
export interface TableCell { text: string; header?: boolean; rowSpan?: number; colSpan?: number }
export interface ItemData {
  title: { text: string };
  heading: { text: string; level: number };
  text: { text: string };
  quote: { text: string };
  code: { text: string; language?: string };
  math: { text: string; format: 'text' | 'mathml'; expression?: string };
  image: { resourceId?: string; alt: string; caption?: string; width?: number; height?: number; unavailableReason?: string };
  list: { ordered: boolean; items: ListEntry[] };
  table: { rows: TableCell[][]; caption?: string };
  unsupported: { label: string; reason: string };
}
export type StreamItem = { [K in keyof ItemData]: {
  id: string; sequence: number; chapterId: string; kind: K; data: ItemData[K];
} }[keyof ItemData];
export interface StreamBatch {
  schemaVersion: 1; sessionId: string; requestId: string; batchId: string; batchSequence: number;
  items: StreamItem[]; status: 'complete' | 'partial' | 'end'; hasMore: boolean;
  reason?: string;
}

/** Stage before rendering, commit only after the view accepts the entire batch. */
export class StreamSequence {
  private session?: string;
  private batches = new Map<string, string>();
  private ids = new Set<string>();
  private batchSequence = 0;
  private sequence = 0;
  private chapter?: string;

  prepare(batch: StreamBatch): { duplicate: boolean; commit(): void } {
    if (batch.schemaVersion !== 1 || !batch.sessionId || !batch.batchId || !batch.requestId ||
      !Array.isArray(batch.items) || !['complete', 'partial', 'end'].includes(batch.status) ||
      typeof batch.hasMore !== 'boolean' || batch.status === 'end' && batch.hasMore) throw new Error('invalid-batch');
    if (this.session && this.session !== batch.sessionId) throw new Error('session-mismatch');
    const signature = JSON.stringify(batch);
    const existing = this.batches.get(batch.batchId);
    if (existing) {
      if (existing !== signature) throw new Error('batch-conflict');
      return { duplicate: true, commit() {} };
    }
    if (batch.batchSequence !== this.batchSequence + 1) throw new Error('batch-out-of-order');
    let sequence = this.sequence, chapter = this.chapter;
    const ids = new Set<string>();
    for (const item of batch.items) {
      if (!item.id || !item.chapterId || item.sequence !== ++sequence || this.ids.has(item.id) || ids.has(item.id)) throw new Error('item-out-of-order');
      validateItem(item);
      if (item.kind === 'title') {
        if (chapter === item.chapterId) throw new Error('duplicate-chapter-title');
        chapter = item.chapterId;
      } else if (chapter !== item.chapterId) throw new Error('missing-chapter-title');
      ids.add(item.id);
    }
    const expected = this.batchSequence;
    return { duplicate: false, commit: () => {
      if (this.batchSequence !== expected) throw new Error('stale-batch');
      this.session = batch.sessionId; this.batches.set(batch.batchId, signature);
      this.batchSequence = batch.batchSequence; this.sequence = sequence; this.chapter = chapter;
      ids.forEach(id => this.ids.add(id));
    } };
  }
}

function validateItem(item: StreamItem): void {
  const d = item.data;
  if (!d || typeof d !== 'object') throw new Error('invalid-item');
  const string = (x: unknown) => { if (typeof x !== 'string') throw new Error('invalid-item'); };
  const span = (x: unknown) => x === undefined || typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
  const list = (entries: ListEntry[], depth = 0): void => {
    if (!Array.isArray(entries) || depth > 20) throw new Error('invalid-list');
    for (const entry of entries) {
      string(entry.text);
      if (entry.children !== undefined && !Array.isArray(entry.children)) throw new Error('invalid-list');
      for (const child of entry.children ?? []) { if (typeof child.ordered !== 'boolean') throw new Error('invalid-list'); list(child.items, depth + 1); }
    }
  };
  switch (item.kind) {
    case 'title': case 'text': case 'quote': case 'code': string(item.data.text); break;
    case 'heading': string(item.data.text); if (!Number.isInteger(item.data.level) || item.data.level < 1 || item.data.level > 6) throw new Error('invalid-heading'); break;
    case 'math': string(item.data.text); if (!['text', 'mathml'].includes(item.data.format)) throw new Error('invalid-math'); break;
    case 'image': string(item.data.alt); if (item.data.resourceId !== undefined) string(item.data.resourceId); break;
    case 'unsupported': string(item.data.label); string(item.data.reason); break;
    case 'list': if (typeof item.data.ordered !== 'boolean') throw new Error('invalid-list'); list(item.data.items); break;
    case 'table':
      if (!Array.isArray(item.data.rows)) throw new Error('invalid-table');
      for (const row of item.data.rows) {
        if (!Array.isArray(row)) throw new Error('invalid-table');
        for (const cell of row) { string(cell.text); if (!span(cell.rowSpan) || !span(cell.colSpan)) throw new Error('invalid-table'); }
      }
      break;
    default: throw new Error('unknown-item-kind');
  }
}
