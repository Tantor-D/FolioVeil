import { WeReadContentSource, isWeReadUrl, weReadBookIdentity } from './structured';
import { WEREAD_SELECTORS } from './selectors';
import { catalogChapters, selectedChapterTitle } from './catalog';
import type { ReaderDocument } from '../../content-model/src/index';
import type { Navigation, OperationResult, ReadingPosition, SourceAdapter, SourcePageRange, SourceSnapshot } from '../../reader-protocol/src/index';

type Attempt = { action: Navigation; requestId: string; expectedPosition: string; expectedEpoch: string };
type ChapterTarget = { element: HTMLElement; title: string; index: number; route: string };
export type TrustedChapterClick = (element: HTMLElement, phase: 'catalog' | 'chapter', context: Attempt & { route: string }) => Promise<void>;
type RememberedResult = Attempt & Omit<OperationResult, 'snapshot'>;
/** A provider must derive its range from observed source DOM. Production has no
 * provider until the real site's page-to-content mapping has been verified. */
export type WeReadPageRangeReader = (content: ReaderDocument) => SourcePageRange | undefined;

/** Only reads DOM and invokes original controls. Does not change source styling. */
export class WeReadSourceAdapter implements SourceAdapter {
  readonly id = 'weread';
  private readonly content: WeReadContentSource;
  private epoch = crypto.randomUUID();
  private route: string;
  private observer?: MutationObserver;
  private timer?: ReturnType<typeof setTimeout>;
  private routeTimer?: ReturnType<typeof setInterval>;
  private listeners = new Set<(snapshot: SourceSnapshot) => void>();
  private lastSignature = '';
  private revision = 0;
  private operationState: 'idle' | 'pending' | 'uncertain' = 'idle';
  private stopped = false;
  private unsubscribe?: () => void;
  private results = new Map<string, RememberedResult>();
  // Retain only opaque IDs after the small result cache is evicted, so an old
  // request can never click the original control again in this source epoch.
  private attempted = new Set<string>();
  private inflight?: Attempt & { result: Promise<OperationResult> };
  private uncertain?: { attempt: Attempt; before: SourceSnapshot };
  private cancelOperation?: () => void;

  constructor(private readonly document: Document, private readonly url: () => string,
    private readonly operationTimeout = 8000, private readonly readPageRange?: WeReadPageRangeReader,
    private readonly trustedClick?: TrustedChapterClick) {
    this.route = url();
    this.content = new WeReadContentSource(document, url);
  }
  start(): void {
    if (this.observer) return;
    if (this.stopped) { this.epoch = crypto.randomUUID(); this.route = this.url(); this.revision = 0; this.lastSignature = ''; }
    this.stopped = false;
    this.content.start();
    this.unsubscribe = this.content.subscribe(() => this.publish());
    this.observer = new MutationObserver(() => {
      clearTimeout(this.timer); this.timer = setTimeout(() => this.publish(), 100);
    });
    this.observer.observe(this.document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class'] });
    // pushState need not mutate the DOM or emit popstate. Reads also check the
    // route, so background timer throttling cannot accept a stale request.
    this.routeTimer = setInterval(() => { if (this.route !== this.url()) this.publish(); }, 1000);
  }
  snapshot(): SourceSnapshot {
    this.syncRoute();
    const content = this.stopped || !isWeReadUrl(this.url()) ? undefined : this.content.getDocument();
    let pageRange: SourcePageRange | undefined;
    if (content) {
      try {
        const candidate = this.readPageRange?.(content);
        if (candidate && validRange(candidate, content, this.document)) {
          pageRange = { start: { ...candidate.start }, end: { ...candidate.end }, signature: candidate.signature, evidence: 'dom-range' };
        }
      } catch { /* Unreadable evidence never becomes a guessed range. */ }
    }
    const available = this.operationState === 'idle' && !!content;
    return { epoch: this.epoch, revision: this.revision,
      status: content ? 'ready' : this.stopped || !isWeReadUrl(this.url()) ? 'unavailable' : 'loading',
      position: this.position(pageRange), operationState: this.operationState,
      capabilities: { 'previous-page': available && (pageRange ? !!this.target('previous-page') : !!this.catalogButton()), 'next-page': available && (pageRange ? !!this.target('next-page') : !!this.catalogButton()) },
      ...(content ? { document: content, contentEvidence: {
        chapterIdentity: content.id, signature: fingerprint(JSON.stringify(content.blocks)),
        // Neither quiet DOM nor a layout-DOM removal proves a whole chapter.
        completeness: 'unknown' as const
      } } : {}),
      ...(pageRange ? { pageRange } : {}) };
  }
  async read(): Promise<SourceSnapshot> {
    this.syncRoute();
    if (this.stopped || !isWeReadUrl(this.url())) return this.snapshot();
    const epoch = this.epoch;
    try { await this.content.read(); }
    catch {
      const snapshot = this.snapshot();
      return epoch !== this.epoch || snapshot.status === 'ready' ? snapshot : { ...snapshot, status: 'unavailable' };
    }
    return this.snapshot();
  }
  subscribe(listener: (snapshot: SourceSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async perform(action: Navigation, requestId: string, expectedPosition: string, expectedEpoch?: string): Promise<OperationResult> {
    this.syncRoute();
    const attempt: Attempt = { action, requestId, expectedPosition, expectedEpoch: expectedEpoch ?? this.epoch };
    const fail = (reason: OperationResult['reason']): OperationResult => ({ requestId, ok: false, reason, snapshot: this.snapshot() });
    const previous = this.results.get(requestId);
    if (previous) return sameAttempt(attempt, previous) ? { requestId, ok: previous.ok, ...(previous.reason ? { reason: previous.reason } : {}), snapshot: this.snapshot() } : fail('stale-position');
    if (this.inflight?.requestId === requestId) return sameAttempt(attempt, this.inflight) ? this.inflight.result : fail('stale-position');
    if (this.attempted.has(requestId)) return fail('stale-position');
    if (this.stopped || !isWeReadUrl(this.url())) return fail('source-unavailable');
    if (this.operationState === 'uncertain') return fail('reconciliation-required');
    if (this.operationState === 'pending') return fail('busy');
    const before = this.snapshot();
    if (attempt.expectedEpoch !== this.epoch || expectedPosition !== before.position.key) return fail('stale-position');
    if (before.status !== 'ready') return fail('source-unavailable');
    const legacyPageTarget = before.pageRange ? this.target(action) : undefined;
    const catalog = before.pageRange ? undefined : this.catalogButton();
    if (!legacyPageTarget && !catalog) return fail('unsupported');
    this.operationState = 'pending';
    this.attempted.add(requestId);
    let resolve!: (value: OperationResult) => void;
    const result = new Promise<OperationResult>(complete => { resolve = complete; });
    this.inflight = { ...attempt, result };
    let finished = false;
    const finish = (ok: boolean, reason?: OperationResult['reason']) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); unsubscribe(); this.cancelOperation = undefined; this.inflight = undefined;
      const uncertain = reason === 'not-confirmed' && attempt.expectedEpoch === this.epoch && !this.stopped;
      this.operationState = uncertain ? 'uncertain' : 'idle';
      this.uncertain = uncertain ? { attempt, before } : undefined;
      this.remember({ ...attempt, ok, ...(reason ? { reason } : {}) });
      this.publish();
      resolve({ requestId, ok, ...(reason ? { reason } : {}), snapshot: this.snapshot() });
    };
    let target: ChapterTarget | undefined;
    // Register before clicking. A changed label alone is never sufficient.
    const unsubscribe = this.subscribe(snapshot => {
      if (legacyPageTarget ? confirmedChange(before, snapshot, action, this.document) : target && confirmedChapterChange(before, snapshot, target)) finish(true);
    });
    const timeout = setTimeout(() => finish(false, 'not-confirmed'), this.operationTimeout);
    this.cancelOperation = () => finish(false, 'source-unavailable');
    this.publish();
    try {
      if (legacyPageTarget) { legacyPageTarget.click(); this.publish(); return result; }
      const selected = this.document.querySelector<HTMLElement>('.readerCatalog_list_item_selected');
      if (!selected || !catalogItemVisible(selected, this.document)) await this.click(catalog!, 'catalog', attempt);
      target = await this.chapterTarget(action, before.position.chapter);
      if (!target) { finish(false, 'unsupported'); return result; }
      if (!this.currentChapterTarget(target, action, before.position.chapter)) { finish(false, 'stale-position'); return result; }
      // The row's center can hit its non-navigating info area. Use the actual
      // title control, after validating the row's current identity above.
      const titleControl = target.element.querySelector<HTMLElement>('.readerCatalog_list_item_title_text');
      if (!titleControl) { finish(false, 'unsupported'); return result; }
      await this.click(titleControl, 'chapter', attempt); this.publish();
    } catch (error) { finish(false, error instanceof Error && error.message === 'trusted-input-unavailable' ? 'input-unavailable' : 'not-confirmed'); }
    return result;
  }
  stop(): void {
    this.stopped = true; this.cancelOperation?.(); this.unsubscribe?.(); this.observer?.disconnect(); this.observer = undefined;
    clearTimeout(this.timer); clearInterval(this.routeTimer);
    this.operationState = 'idle'; this.uncertain = undefined;
    this.content.stop(); this.listeners.clear(); this.results.clear(); this.attempted.clear();
  }
  private syncRoute(): void {
    const route = this.url();
    if (route === this.route) return;
    if (weReadBookIdentity(route) && weReadBookIdentity(route) === weReadBookIdentity(this.route)) { this.route = route; return; }
    this.route = route; this.epoch = crypto.randomUUID(); this.revision = 0; this.lastSignature = '';
    this.cancelOperation?.();
    this.operationState = 'idle'; this.uncertain = undefined; this.results.clear(); this.attempted.clear();
    this.content.getDocument();
  }
  private position(range?: SourcePageRange): ReadingPosition {
    const text = (selector: string) => this.document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const chapter = selectedChapterTitle(this.document) || text('.renderTargetPageInfo_header_chapterTitle') || text('.readerChapterContent_title');
    const page = text('.renderTargetPageInfo_footer') || text('.readerFooter_progress') || text('.renderTargetPageInfo') || text('[aria-label="阅读进度"]');
    const documentId = this.url().split('#')[0]!;
    return { documentId, chapter, page, key: JSON.stringify([this.epoch, documentId, chapter, page, range?.start, range?.end]) };
  }
  private target(action: Navigation): HTMLElement | undefined {
    if (this.stopped) return;
    const selectors = action === 'next-page' ? WEREAD_SELECTORS.nextPage : WEREAD_SELECTORS.previousPage;
    return [...this.document.querySelectorAll<HTMLElement>(selectors.join(','))].find(node => {
      if (node.matches('[disabled],[aria-disabled="true"],.disabled') || node.closest('[hidden],[aria-hidden="true"]')) return false;
      for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
        const style = this.document.defaultView?.getComputedStyle(ancestor);
        if (style?.display === 'none' || style?.visibility === 'hidden') return false;
      }
      return true;
    });
  }
  private remember(result: RememberedResult): void {
    if (result.expectedEpoch !== this.epoch) return;
    this.results.set(result.requestId, result);
    while (this.results.size > 32) this.results.delete(this.results.keys().next().value!);
  }
  private publish(): void {
    let snapshot = this.snapshot();
    // A timeout is an unknown outcome, not cancellation of the original click.
    if (this.uncertain?.before.pageRange && confirmedChange(this.uncertain.before, snapshot, this.uncertain.attempt.action, this.document)) {
      this.remember({ ...this.uncertain.attempt, ok: true });
      this.uncertain = undefined; this.operationState = 'idle'; snapshot = this.snapshot();
    }
    const signature = JSON.stringify([snapshot.position, snapshot.status, snapshot.capabilities, snapshot.operationState, snapshot.contentEvidence, snapshot.pageRange, this.content.getRevision()]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature; snapshot.revision = ++this.revision;
    for (const listener of this.listeners) listener(snapshot);
  }

  private catalogButton(): HTMLElement | undefined {
    return [...this.document.querySelectorAll<HTMLElement>(WEREAD_SELECTORS.tableOfContents.join(','))]
      .find(node => visible(node, this.document));
  }

  private async click(element: HTMLElement, phase: 'catalog' | 'chapter', attempt: Attempt): Promise<void> {
    if (this.operationState !== 'pending' || this.epoch !== attempt.expectedEpoch || this.snapshot().position.key !== attempt.expectedPosition) throw new Error('stale-input');
    if (this.trustedClick) await this.trustedClick(element, phase, { ...attempt, route: this.url() });
    else element.click();
  }

  private currentChapterTarget(target: ChapterTarget, action: Navigation, chapter: string): boolean {
    if (this.url() !== target.route || this.operationState !== 'pending' || !catalogItemVisible(target.element, this.document)) return false;
    const items = catalogChapters(this.document);
    const selected = items.filter(item => item.classList.contains('readerCatalog_list_item_selected'));
    if (selected.length !== 1 || normalize(selected[0]!.querySelector('.readerCatalog_list_item_title_text')?.textContent) !== normalize(chapter)) return false;
    const next = items.indexOf(selected[0]!) + (action === 'next-page' ? 1 : -1);
    return items[next] === target.element && next === target.index && normalize(target.element.querySelector('.readerCatalog_list_item_title_text')?.textContent) === normalize(target.title);
  }

  private async chapterTarget(action: Navigation, chapter: string): Promise<ChapterTarget | undefined> {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && this.operationState === 'pending') {
      const items = catalogChapters(this.document);
      const selected = items.filter(item => item.classList.contains('readerCatalog_list_item_selected'));
      if (selected.length === 1 && normalize(selected[0]!.querySelector('.readerCatalog_list_item_title_text')?.textContent) === normalize(chapter)) {
        const index = items.indexOf(selected[0]!);
        const next = index + (action === 'next-page' ? 1 : -1);
        const element = items[next];
        const title = element?.querySelector('.readerCatalog_list_item_title_text')?.textContent?.trim();
        if (!element || !title) return;
        if (catalogItemVisible(element, this.document)) return { element, title, index: next, route: this.url() };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

function normalize(value?: string | null): string { return (value ?? '').replace(/\s|[\u200b-\u200d\ufeff]/g, ''); }
function visible(node: HTMLElement, owner: Document): boolean {
  if (node.matches('[disabled],[aria-disabled="true"],.disabled') || node.closest('[hidden],[aria-hidden="true"]')) return false;
  for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
    const style = owner.defaultView?.getComputedStyle(parent);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  }
  return true;
}
function catalogItemVisible(node: HTMLElement, owner: Document): boolean {
  if (!visible(node, owner)) return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function confirmedChapterChange(before: SourceSnapshot, after: SourceSnapshot, target: ChapterTarget): boolean {
  return before.epoch === after.epoch && after.status === 'ready' && !!before.document && !!after.document &&
    normalize(after.position.chapter) === normalize(target.title) && normalize(after.document.title) === normalize(target.title) &&
    after.position.documentId !== target.route && after.document.id !== before.document.id &&
    before.contentEvidence?.signature !== after.contentEvidence?.signature && !!after.document.blocks.length;
}

function sameAttempt(left: Attempt, right: Attempt): boolean {
  return left.action === right.action && left.expectedPosition === right.expectedPosition && left.expectedEpoch === right.expectedEpoch;
}

function validRange(range: SourcePageRange, content: ReaderDocument, owner: Document): boolean {
  if (range.evidence !== 'dom-range' || !range.signature) return false;
  // The protocol currently transports one chapter. A spread spanning chapters
  // cannot be verified against that body and must not be silently clipped.
  if ([range.start, range.end].some(anchor => anchor.documentId !== content.id || !Number.isInteger(anchor.offset) || anchor.offset < 0)) return false;
  const first = content.blocks.findIndex(block => block.id === range.start.blockId);
  const last = content.blocks.findIndex(block => block.id === range.end.blockId);
  if (first < 0 || last < first || first === last && range.end.offset <= range.start.offset) return false;
  return [range.start, range.end].every(anchor => {
    const block = content.blocks.find(value => value.id === anchor.blockId)!;
    if ('text' in block) return anchor.offset <= block.text.length;
    if (!('html' in block) && !('items' in block)) return false;
    const template = owner.createElement('template');
    template.innerHTML = 'html' in block ? block.html : block.items.join('');
    return anchor.offset <= (template.content.textContent ?? '').length;
  });
}

function confirmedChange(before: SourceSnapshot, after: SourceSnapshot, action: Navigation, owner: Document): boolean {
  if (before.epoch !== after.epoch || before.position.key === after.position.key || after.status !== 'ready' || !before.document || !after.document) return false;
  const from = before.pageRange; const to = after.pageRange;
  if (!from || !to || !validRange(from, before.document, owner) || !validRange(to, after.document, owner) || from.signature === to.signature) return false;
  const first = before.contentEvidence; const next = after.contentEvidence;
  if (!first || !next) return false;
  if (first.chapterIdentity !== next.chapterIdentity) {
    return before.position.chapter !== after.position.chapter && first.signature !== next.signature;
  }
  const firstIndex = after.document.blocks.findIndex(block => block.id === from.start.blockId);
  const nextIndex = after.document.blocks.findIndex(block => block.id === to.start.blockId);
  if (firstIndex < 0 || nextIndex < 0) return false;
  const direction = nextIndex === firstIndex ? Math.sign(to.start.offset - from.start.offset) : Math.sign(nextIndex - firstIndex);
  return direction === (action === 'next-page' ? 1 : -1);
}

/** Session-only change token, not a cryptographic integrity claim. */
function fingerprint(value: string): string {
  let first = 2166136261; let second = 5381;
  for (let index = 0; index < value.length; index++) {
    first = Math.imul(first ^ value.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ value.charCodeAt(index);
  }
  return value.length + ':' + (first >>> 0).toString(16) + ':' + (second >>> 0).toString(16);
}
