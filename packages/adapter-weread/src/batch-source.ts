import { WeReadContentSource, weReadBookIdentity } from './structured';
import { DocumentStreamEncoder } from '../../content-model/src/stream-conversion';
import type { StreamBatch } from '../../content-model/src/stream';
import { readingLayout, nextChapterButton, scrollBookEnd, type WeReadLayout } from './reading-layout';

export const WEREAD_BATCH_POLICY = Object.freeze({ initialClicks: 10, subsequentClicks: 10, intervalMs: 100, jitterMs: 20, settleMs: 200, timeoutMs: 8000 });
type Policy = { [K in keyof typeof WEREAD_BATCH_POLICY]: number };
export type WeReadChapterInput = (button: HTMLButtonElement, context: { requestId: string; route: string }) => Promise<void>;

/** View-specific collection stays behind the same ordered batch interface. */
export class WeReadBatchSource {
  private content: WeReadContentSource;
  private encoder: DocumentStreamEncoder;
  private session?: string;
  private batchSequence = 0;
  private busy = false;
  private uncertain = false;
  private stopped = false;
  private book: string | undefined;
  private results = new Map<string, Promise<StreamBatch>>();
  private resources = new Map<string, string>();
  private initial?: Promise<StreamBatch>;
  private lastPage?: string;
  private layout?: WeReadLayout;
  private ended = false;
  constructor(private readonly doc: Document, private readonly url: () => string, private readonly policy: Policy = WEREAD_BATCH_POLICY,
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly chapterInput?: WeReadChapterInput) {
    this.content = new WeReadContentSource(doc, url, (callback, ms) => {
      let cancelled = false;
      void this.wait(ms).then(() => { if (!cancelled) callback(); }).catch(() => { if (!cancelled) this.stop(); });
      return () => { cancelled = true; };
    });
    this.encoder = new DocumentStreamEncoder(doc, src => {
      const existing = [...this.resources].find(([, value]) => value === src);
      if (existing) return existing[0];
      const id = crypto.randomUUID(); this.resources.set(id, src); return id;
    });
    this.book = weReadBookIdentity(url());
  }
  start(): void { this.content.start(); }
  stop(): void { this.stopped = true; this.content.stop(); this.resources.clear(); this.results.clear(); }

  fetch(sessionId: string, requestId: string, initial: boolean): Promise<StreamBatch> {
    if (this.stopped || !sessionId || !requestId) return Promise.reject(new Error('source-unavailable'));
    if (this.session && this.session !== sessionId) return Promise.reject(new Error('source-session-in-use'));
    const key = `${initial}:${requestId}`;
    const existing = this.results.get(key);
    if (existing) return existing;
    if (initial && this.initial) return this.initial;
    if (this.busy) return Promise.reject(new Error('busy'));
    if (this.uncertain) return Promise.reject(new Error('reconciliation-required'));
    if (!initial && !this.initial) return Promise.reject(new Error('initialization-required'));
    this.session = sessionId; this.busy = true;
    const result = this.collect(requestId, initial).then(batch => {
      // An empty first read made no navigation and committed no content. Keep
      // its request replayable, but allow a fresh explicit initial request.
      if (batch.reason === 'source-not-ready') this.initial = undefined;
      return batch;
    }).finally(() => { this.busy = false; });
    this.results.set(key, result); if (initial) this.initial = result;
    return result;
  }

  private page(): string {
    const visible = [...this.doc.querySelectorAll<HTMLElement>('.renderTargetContent .contentWrapper')]
      .map((node, index) => ({ node, index })).filter(({ node }) => this.doc.defaultView?.getComputedStyle(node).display !== 'none');
    // Detect observable external movement; unchanged markers do not imply failure.
    return JSON.stringify([this.url(), this.doc.querySelector('.readerCatalog_list_item_selected')?.textContent,
      visible.map(({ node, index }) => [index, node.getAttribute('style')])]);
  }
  private button(): HTMLButtonElement | undefined {
    return [...this.doc.querySelectorAll<HTMLButtonElement>('.renderTarget_pager_button_right')].find(node =>
      !node.disabled && node.getAttribute('aria-disabled') !== 'true' && !node.closest('[hidden],[aria-hidden="true"]') &&
      this.doc.defaultView?.getComputedStyle(node).display !== 'none');
  }
  private valid(): boolean { return !this.stopped && !!this.book && weReadBookIdentity(this.url()) === this.book; }
  private async collectionWait(ms: number): Promise<void> {
    const started = Date.now();
    await this.wait(ms);
    // Resuming a frozen page must not deliver an old, delayed navigation click.
    if (Date.now() - started > ms + this.policy.timeoutMs) throw new Error('source-suspended');
  }
  private checkLayout(): void {
    const current = readingLayout(this.doc);
    if (current && this.layout && current !== this.layout) throw new Error('source-layout-changed');
  }
  private scrollPosition(): string {
    const entries = [...this.doc.querySelectorAll('.readerCatalog_list_item')];
    const selected = this.doc.querySelector('.readerCatalog_list_item_selected');
    return JSON.stringify([this.url(), selected ? entries.indexOf(selected) : -1,
      selected?.querySelector('.readerCatalog_list_item_title_text')?.textContent]);
  }
  private async collectChapter(requestId: string, initial: boolean): Promise<StreamBatch['items']> {
    const before = this.scrollPosition();
    if (!this.valid() || this.lastPage && this.lastPage !== before) throw new Error('source-position-changed');
    if (this.ended) return [];
    let previousId: string | undefined;
    if (!initial) {
      const previous = this.content.getDocument();
      if (!previous) throw new Error('text_content_unavailable');
      previousId = previous.id;
      if (scrollBookEnd(this.doc) && !nextChapterButton(this.doc)) { this.ended = true; return []; }
      const button = nextChapterButton(this.doc);
      if (!button) throw new Error('next-chapter-unavailable');
      if (!this.chapterInput) throw new Error('trusted-input-unavailable');
      button.scrollIntoView({ block: 'center', behavior: 'instant' });
      await this.collectionWait(40);
      this.checkLayout();
      if (!this.valid() || before !== this.scrollPosition() || button !== nextChapterButton(this.doc)) throw new Error('source-position-changed');
      await this.chapterInput(button, { requestId, route: this.url() });
    }
    const deadline = Date.now() + this.policy.timeoutMs;
    let revision = -1, position = '', since = 0;
    while (Date.now() < deadline) {
      this.checkLayout();
      if (!this.valid()) throw new Error('source-unavailable');
      const current = this.scrollPosition(), value = this.content.getDocument();
      // A settled old chapter is never success after a click, even with a new URL.
      if (!value || !initial && (current === before || value.id === previousId)) { since = 0; await this.collectionWait(40); continue; }
      if (initial && current !== before) throw new Error('source-position-changed');
      const nextRevision = this.content.getRevision();
      if (!since || position !== current || revision !== nextRevision) {
        position = current; revision = nextRevision; since = Date.now();
      } else if (Date.now() - since >= this.policy.settleMs) {
        const items = this.encoder.append(value);
        this.lastPage = current;
        this.ended = scrollBookEnd(this.doc) && !nextChapterButton(this.doc);
        return items;
      }
      await this.collectionWait(40);
    }
    throw new Error('content-not-confirmed');
  }
  private async collect(requestId: string, initial: boolean): Promise<StreamBatch> {
    const items: StreamBatch['items'] = [];
    let status: StreamBatch['status'] = 'complete', reason: string | undefined;
    try {
      const deadline = Date.now() + this.policy.timeoutMs;
      while (!readingLayout(this.doc) && Date.now() < deadline && this.valid()) await this.collectionWait(40);
      this.checkLayout();
      this.layout ??= readingLayout(this.doc);
      if (!this.layout) throw new Error('source-layout-unavailable');
      if (this.layout === 'scroll') {
        items.push(...await this.collectChapter(requestId, initial));
        if (this.ended) status = 'end';
      } else {
        const starting = await this.content.read(this.policy.timeoutMs);
        if (!this.valid() || this.lastPage && this.lastPage !== this.page()) throw new Error('source-position-changed');
        // Preserve the starting content before a click can leave its chapter.
        items.push(...this.encoder.append(starting));
        const count = initial ? this.policy.initialClicks : this.policy.subsequentClicks;
        for (let index = 0; index < count; index++) {
          this.checkLayout();
          if (!this.valid()) throw new Error('source-unavailable');
          const button = this.button();
          // A missing control may mean a changed layout, not necessarily the end.
          if (!button) throw new Error('next-page-unavailable');
          const before = this.page();
          const delay = this.policy.intervalMs + (Math.random() * 2 - 1) * this.policy.jitterMs;
          await this.collectionWait(delay);
          this.checkLayout();
          if (this.page() !== before || !this.valid()) throw new Error('source-position-changed');
          button.click();
          const deadline = Date.now() + this.policy.timeoutMs;
          let candidate = '', revision = -1, since = 0, confirmed = false;
          while (Date.now() < deadline && this.valid()) {
            await this.collectionWait(40);
            this.checkLayout();
            const page = this.page(), value = this.content.getDocument();
            if (!value) { candidate = ''; continue; }
            const currentRevision = this.content.getRevision();
            if (page !== candidate || revision !== currentRevision) { candidate = page; revision = currentRevision; since = Date.now(); continue; }
            if (Date.now() - since < this.policy.settleMs) continue;
            items.push(...this.encoder.append(value)); this.lastPage = page; confirmed = true; break;
          }
          if (!confirmed) throw new Error('content-not-confirmed');
        }
      }
    } catch (error) {
      status = 'partial'; reason = error instanceof Error ? error.message : 'source-unavailable';
      const retryable = initial && items.length === 0 && ['source-layout-unavailable', 'text_content_unavailable', 'content-not-confirmed'].includes(reason);
      this.uncertain = !retryable;
      if (retryable) reason = 'source-not-ready';
    }
    return { schemaVersion: 1 as const, sessionId: this.session!, requestId, batchId: crypto.randomUUID(), batchSequence: ++this.batchSequence,
      items, status, hasMore: !this.uncertain && !this.ended && reason !== 'source-not-ready', ...(reason ? { reason } : {}) };
  }

  /** Resolve only issued IDs; the extension worker owns the network request. */
  resolveResource(sessionId: string, id: string): string {
    const src = this.resources.get(id);
    if (!this.valid() || sessionId !== this.session || !src) throw new Error('resource-unavailable');
    return new URL(src, this.url()).href;
  }
}
