import type { ReaderDocument } from "../../content-model/src/index";
import { extractStructuredHTML } from "../../content-model/src/html";
import { catalogEntries, catalogLeafHeading, selectedChapterIndex, selectedChapterTitle } from './catalog';
import { readingLayout, type WeReadLayout } from './reading-layout';

const ROOT = ".readerChapterContent .preRenderContent";
const EXCLUDE = "script,style,[data-wr-ignore],.readerControls,.renderTargetContainer";

export function isWeReadUrl(url: string): boolean {
  try { const value = new URL(url); return value.protocol === "https:" && value.hostname === "weread.qq.com" && /^\/web\/reader\/[^/]+/.test(value.pathname); }
  catch { return false; }
}

/** Observed reader routes append a 24-character chapter token to a 23- or
 * 24-character book token. Keep this interpretation within the source layer. */
export function weReadBookIdentity(route: string): string | undefined {
  try {
    const segment = new URL(route).pathname.match(/^\/web\/reader\/([a-zA-Z0-9]+)$/)?.[1];
    if (!segment) return;
    return segment.length >= 47 ? segment.slice(0, -24) : segment;
  } catch { return; }
}

/** Only a DOM text source is reflowed. Rendered canvases and app internals are never used. */
export function extractWeReadDocument(root: Element, url: string, chapterTitle?: string): ReaderDocument {
  if (!isWeReadUrl(url)) throw new Error("unsupported_source");
  const copy = root.cloneNode(true) as Element;
  for (const node of copy.querySelectorAll(EXCLUDE)) node.remove();
  // WeRead's layout DOM uses a transparent GIF in src while data-src names
  // the real image. Normalize only our detached copy; an invalid lazy address
  // must remain unavailable rather than masquerade as a loaded placeholder.
  for (const image of copy.querySelectorAll('img[data-src]')) {
    const value = image.getAttribute('data-src')?.trim();
    image.removeAttribute('src'); image.removeAttribute('srcset');
    if (!value) continue;
    try {
      const resource = new URL(value, url);
      if (resource.protocol === 'https:' && !resource.username && !resource.password) image.setAttribute('src', resource.href);
    } catch { /* The semantic converter preserves the unavailable image. */ }
  }
  // Section openers can place decorative image-only paragraphs before their
  // heading. Only a paragraph with text establishes the start of prose.
  const firstParagraph = [...copy.querySelectorAll('p')].find(node => !!node.textContent?.trim());
  const allLeading = [...copy.querySelectorAll("h1,h2,h3,h4,h5,h6,.readerChapterContent_title")]
    .filter(node => !firstParagraph || !!(node.compareDocumentPosition(firstParagraph) & 4));
  let leadingHeadings = allLeading.filter(node => node.matches('h1,h2,.readerChapterContent_title'));
  const firstHeading = allLeading[0];
  // Deeper headings can be chapter titles in illustrated editions, but only
  // with matching catalog evidence. Later subsection headings stay in place.
  if (firstHeading && !firstHeading.matches('h1,h2,.readerChapterContent_title') &&
    catalogEntries(root.ownerDocument).some(entry => normalizeTitle(entry.title) === normalizeTitle(firstHeading.textContent ?? ''))) {
    leadingHeadings = [firstHeading];
  } else {
    for (const heading of allLeading.filter(node => !node.matches('h1,h2,.readerChapterContent_title'))) {
      if (!catalogLeafHeading(root.ownerDocument, [...leadingHeadings, heading])) break;
      leadingHeadings.push(heading);
    }
  }
  const leaf = catalogLeafHeading(root.ownerDocument, leadingHeadings);
  const title = (leaf?.textContent || leadingHeadings.map(node => node.textContent).join(" ") || chapterTitle || "当前章节").replace(/\s+/g, " ").trim();
  // The parent's section title is real source content; keep it in the body.
  (leaf ? [leaf] : leadingHeadings).forEach(node => node.remove());
  // Some editions use semantic divs for paragraphs. Preserve their original order.
  for (const node of copy.querySelectorAll("div[data-wr-co], div[data-wr-id]")) {
    if (node.querySelector("p,h1,h2,h3,h4,h5,h6,div,table,ul,ol")) continue;
    const paragraph = copy.ownerDocument.createElement("p");
    // Preserve observed source identifiers on our detached copy. Interpretation
    // of these attributes belongs to the semantic converter, never the view.
    for (const attribute of ["id", "data-wr-id", "data-wr-co"]) {
      const value = node.getAttribute(attribute);
      if (value !== null) paragraph.setAttribute(attribute, value);
    }
    paragraph.append(...node.childNodes);
    node.replaceWith(paragraph);
  }
  const metadata: Pick<ReaderDocument, 'id' | 'title' | 'source'> = {
    id: `weread:${new URL(url).pathname}:${title}`,
    title,
    source: { kind: "html", url, label: "微信读书 · 当前已加载章节" }
  };
  // An observed heading-only section is a real scroll-mode chapter. Do not
  // manufacture an empty chapter when the semantic root was never captured.
  if (readingLayout(root.ownerDocument) === 'scroll' && leadingHeadings.length &&
    !copy.textContent?.trim() && !copy.querySelector('img,picture,svg,canvas,object,table,[data-content-background]')) {
    return { ...metadata, blocks: [], toc: [], warnings: [] };
  }
  return extractStructuredHTML(copy, metadata, undefined, { readCanvasPixels: false });
}

/** WeRead clears its layout DOM after painting. Observe the normal DOM lifecycle,
 * including removed nodes. At most three already loaded layout candidates are
 * held in memory; only the chapter matching the current page is published. */
export class WeReadContentSource {
  private observer?: MutationObserver;
  private pending?: () => void;
  private pendingIdentity?: { id: number; title: string; document: ReaderDocument; catalogIndex?: number };
  private candidates = new Map<number, { document: ReaderDocument; signature: string; title: string; publishedId?: string; publishedKey?: string }>();
  private chapterIdentities = new Map<string, string>();
  private roots = new WeakMap<Element, { id: number; released: boolean }>();
  private observedHTML = new WeakMap<Element, string>();
  private blockedHTML = new WeakMap<Element, string>();
  private ambiguousTitles = new Set<string>();
  private sequence = 0;
  private content?: ReaderDocument;
  private published?: number;
  private waiting = new Set<() => void>();
  private route = "";
  private revision = 0;
  private layout?: WeReadLayout;
  private awaitingCatalog: Element[] = [];

  private listeners = new Set<() => void>();

  constructor(private readonly document: Document, private readonly url: () => string,
    private readonly schedule: (callback: () => void, ms: number) => () => void = (callback, ms) => {
      const timer = setTimeout(callback, ms); return () => clearTimeout(timer);
    }) {}

  start(): void {
    if (this.observer) return;
    this.route = this.url();
    this.observer = new MutationObserver(records => {
      // Mutation records can belong to the previous SPA document. They must not
      // be relabelled with the new URL when the route changes in the same task.
      if (this.route !== this.url()) { this.resetRoute(); this.captureCurrent(); this.selectCurrent(); return; }
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
        const root = target?.closest(".preRenderContent");
        if (root && (root.closest(".readerChapterContent") || this.observedHTML.has(root))) {
          if (this.hasText(root)) this.capture(root, root);
          // innerHTML is cleared after layout; removed nodes retain source order.
          else if (record.target === root && record.removedNodes.length) {
            const removed = this.document.createElement("div");
            for (const child of record.removedNodes) removed.append(child.cloneNode(true));
            if (this.hasText(removed)) this.capture(removed, root, true);
          }
        }
        // A renderer may remove its entire layout root (or wrapper), rather
        // than clear innerHTML. Only inspect that known layout subtree.
        for (const removed of record.removedNodes) {
          if (removed.nodeType !== 1) continue;
          const element = removed as Element;
          const roots = element.matches(".preRenderContent") ? [element] : [...element.querySelectorAll(".preRenderContent")];
          for (const detached of roots) {
            const knownLayout = detached.closest(".readerChapterContent") || target?.closest(".readerChapterContent") || this.observedHTML.has(detached);
            if (knownLayout && this.hasText(detached)) this.capture(detached, detached, true);
          }
        }
      }
      this.captureCurrent();
      this.selectCurrent();
    });
    this.observer.observe(this.document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    this.captureCurrent();
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getRevision(): number { return this.revision; }
  getDocument(): ReaderDocument | undefined {
    if (this.route !== this.url()) this.resetRoute();
    return this.route === this.url() && normalizeTitle(this.currentTitle()) === normalizeTitle(this.content?.title ?? "") ? this.content : undefined;
  }

  async read(timeout = 10000): Promise<ReaderDocument> {
    if (this.route !== this.url()) this.resetRoute();
    this.captureCurrent();
    const current = this.getDocument();
    if (current) return current;
    return new Promise((resolve, reject) => {
      const cancel = () => { cleanup(); reject(new Error("text_content_unavailable")); };
      const cancelTimer = this.schedule(cancel, timeout);
      const cleanup = () => { cancelTimer(); unsubscribe(); this.waiting.delete(cancel); };
      const unsubscribe = this.subscribe(() => {
        const content = this.getDocument();
        if (!content) return;
        cleanup(); resolve(content);
      });
      this.waiting.add(cancel);
    });
  }

  stop(): void {
    this.observer?.disconnect(); this.observer = undefined;
    this.pending?.(); this.pending = undefined; this.pendingIdentity = undefined;
    for (const cancel of this.waiting) cancel();
    this.awaitingCatalog = [];
    this.candidates.clear(); this.roots = new WeakMap(); this.observedHTML = new WeakMap(); this.blockedHTML = new WeakMap(); this.ambiguousTitles.clear(); this.content = undefined; this.published = undefined; this.listeners.clear();
    this.chapterIdentities.clear();
  }

  private resetRoute(): void {
    this.awaitingCatalog = [];
    for (const cancel of this.waiting) cancel();
    const sameBook = !!weReadBookIdentity(this.route) && weReadBookIdentity(this.route) === weReadBookIdentity(this.url());
    if (!sameBook) this.chapterIdentities.clear();
    this.blockedHTML = this.observedHTML;
    this.observedHTML = new WeakMap();
    this.route = this.url();
    // Scroll chapters have distinct routes. Old cached candidates must not be
    // relabelled as a new chapter merely because its title happens to repeat.
    this.layout = readingLayout(this.document) ?? this.layout;
    if (!sameBook || this.layout === 'scroll') { this.candidates.clear(); this.ambiguousTitles.clear(); }
    this.roots = new WeakMap(); this.content = undefined; this.published = undefined;
    this.pending?.(); this.pending = undefined; this.pendingIdentity = undefined;
  }

  private hasText(root: Element): boolean {
    return [...root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,div[data-wr-co],div[data-wr-id]")]
      .some(node => !node.closest(EXCLUDE) && !!node.textContent?.trim());
  }

  private captureCurrent(): void {
    if (this.awaitingCatalog.length && catalogEntries(this.document).length) {
      const waiting = this.awaitingCatalog; this.awaitingCatalog = [];
      for (const root of waiting) this.capture(root, root, true);
    }
    for (const root of this.document.querySelectorAll(ROOT)) if (this.hasText(root)) this.capture(root, root);
  }

  private capture(root: Element, origin: Element, released = false): void {
    try {
      const html = root.innerHTML;
      // A changed URL alone must not turn the previous document's still-mounted
      // layout into content belonging to the new document.
      if (this.blockedHTML.get(origin) === html) return;
      const tracked = this.roots.get(origin);
      if (tracked && this.observedHTML.get(origin) === html && this.candidates.has(tracked.id)) {
        if (released) tracked.released = true;
        return;
      }
      this.blockedHTML.delete(origin);
      this.observedHTML.set(origin, html);
      const next = extractWeReadDocument(root, this.route);
      // Dual-page layout may clear its DOM before the catalog is rendered.
      // Retain only bounded, session-local candidates and wait for the same
      // catalog evidence required by normal extraction; never invent a title.
      if (next.title === '当前章节' && root.querySelector('h3,h4,h5,h6') && !catalogEntries(this.document).length) {
        if (!this.awaitingCatalog.some(candidate => candidate.innerHTML === html)) this.awaitingCatalog.push(root.cloneNode(true) as Element);
        while (this.awaitingCatalog.length > 3) this.awaitingCatalog.shift();
        return;
      }
      // A quiet DOM or a released layout batch does not prove that the entire
      // chapter has loaded. Keep this limitation explicit until real-site
      // evidence establishes a reliable completeness signal.
      next.warnings.push("chapter_completeness_unverified");
      const title = normalizeTitle(next.title);
      const signature = candidateSignature(next);
      const previous = this.roots.get(origin);
      const existing = previous && this.candidates.get(previous.id);
      if (existing?.signature === signature) {
        if (released && previous) previous.released = true;
        return;
      }
      if (previous && !previous.released && existing?.title === title) {
        // During one layout batch, appending more full blocks can extend the
        // candidate, but a transient shortened root must not truncate it. A
        // non-prefix rewrite with the same title is not safe to identify.
        if (isBlockPrefix(next, existing.document)) return;
        if (!isBlockPrefix(existing.document, next)) this.ambiguousTitles.add(title);
      }
      // Dual-page prelayout reuses one root for adjacent chapters. A new
      // title must not overwrite the selected chapter awaiting publication.
      const id = previous && !previous.released && existing?.title === title ? previous.id : ++this.sequence;
      this.roots.set(origin, { id, released });
      const published = [...this.candidates.values()].find(candidate => candidate.title === title && candidate.signature === signature);
      this.candidates.set(id, { document: next, signature, title, publishedId: published?.publishedId, publishedKey: published?.publishedKey });
      // Different batches with the same title cannot be distinguished by the
      // page label. Fail closed instead of silently selecting the last one.
      const matches = [...this.candidates.values()].filter(candidate => candidate.title === title);
      if (matches.some(candidate => candidate.signature !== signature)) this.ambiguousTitles.add(title);
      // The source may lay out adjacent chapters. Bound this transient cache and
      // never show a candidate unless the current-page chapter label matches.
      while (this.candidates.size > 3) this.candidates.delete(this.candidates.keys().next().value!);
      this.selectCurrent();
    } catch { /* Never fall back to source toolbars or canvas UI. */ }
  }

  private selectCurrent(): void {
    const title = this.currentTitle();
    const normalized = normalizeTitle(title);
    if (this.content && (normalizeTitle(this.content.title) !== normalized || this.ambiguousTitles.has(normalized))) {
      this.content = undefined;
      for (const listener of this.listeners) listener();
    }
    if (!title || this.ambiguousTitles.has(normalized)) { this.cancelPending(); return; }
    const entry = [...this.candidates].find(([, candidate]) => candidate.title === normalized);
    if (!entry) { this.cancelPending(); return; }
    const [id, next] = entry;
    const catalogIndex = this.chapterCatalogIndex(title);
    const catalogKey = catalogIndex === undefined ? undefined : `weread:${weReadBookIdentity(this.route) ?? this.route}:catalog:${catalogIndex}`;
    // Paginated routes may advance before (or after) the displayed chapter.
    // Use the selected catalog identity; without a catalog, retain the identity
    // of the captured candidate across that route transition.
    const documentId = this.layout === 'scroll' ? undefined
      : catalogKey ? this.chapterIdentities.get(catalogKey) ?? (next.publishedKey === undefined ? next.publishedId : undefined) ?? catalogKey
      : next.publishedId ?? `weread:${weReadBookIdentity(this.route) ?? this.route}:candidate:${id}`;
    if (this.content && id === this.published && JSON.stringify(relabelDocument(next.document, this.route, title, documentId)) === JSON.stringify(this.content)) return;
    if (this.pendingIdentity?.id === id && this.pendingIdentity.title === normalized && this.pendingIdentity.document === next.document && this.pendingIdentity.catalogIndex === catalogIndex) return;
    this.cancelPending();
    this.pendingIdentity = { id, title: normalized, document: next.document, catalogIndex };
    const route = this.route;
    this.pending = this.schedule(() => {
      this.pending = undefined; this.pendingIdentity = undefined;
      // Recheck after the source has finished switching its page label.
      if (this.url() !== route || this.route !== route || this.ambiguousTitles.has(normalized) ||
        normalizeTitle(this.currentTitle()) !== normalized || this.candidates.get(id) !== next || this.chapterCatalogIndex(title) !== catalogIndex) return;
      this.content = relabelDocument(next.document, route, title, documentId);
      next.publishedId = this.content.id;
      if (catalogKey && this.layout !== 'scroll') { this.chapterIdentities.set(catalogKey, this.content.id); next.publishedKey = catalogKey; }
      this.published = id;
      ++this.revision;
      for (const listener of this.listeners) listener();
    }, 180);
  }

  private cancelPending(): void {
    this.pending?.(); this.pending = undefined; this.pendingIdentity = undefined;
  }

  /** currentTitle has already confirmed the captured chapter. A selected
   * subsection belongs to its ancestor, not to a new chapter identity. */
  private chapterCatalogIndex(title: string): number | undefined {
    const entries = catalogEntries(this.document);
    const selected = entries.filter(entry => entry.element.classList.contains('readerCatalog_list_item_selected'));
    if (selected.length !== 1) return;
    const current = selected[0]!, index = entries.indexOf(current), normalized = normalizeTitle(title);
    if (normalizeTitle(current.title) === normalized) return index;
    const leaf = selectedChapterIndex(this.document);
    if (leaf !== undefined && normalizeTitle(entries[leaf]!.title) === normalized) return leaf;
    let level = current.level;
    for (let ancestor = index - 1; ancestor >= 0; ancestor--) {
      const entry = entries[ancestor]!;
      if (!(entry.level < level)) continue;
      if (normalizeTitle(entry.title) === normalized) return ancestor;
      level = entry.level;
    }
  }

  private currentTitle(): string {
    // Scroll mode opens section rows as their own pages; the paginated reader
    // can combine a section and its first leaf on one spread.
    this.layout = readingLayout(this.document) ?? this.layout;
    if (this.layout === 'paginated') {
      const entries = catalogEntries(this.document);
      const selected = entries.filter(entry => entry.element.classList.contains('readerCatalog_list_item_selected'));
      if (selected.length === 1) {
        const current = selected[0]!, index = entries.indexOf(current);
        // The catalog also tracks headings inside a loaded chapter. An exact
        // captured chapter wins over an inferred first leaf; a subsection can
        // identify its ancestor only when that heading exists in its body.
        const candidates = [...this.candidates.values()].filter(candidate => {
          const matching = entries.filter(entry => normalizeTitle(entry.title) === candidate.title);
          if (matching.length !== 1) return false;
          const chapter = matching[0]!, start = entries.indexOf(chapter);
          if (chapter === current) return true;
          if (start >= index || !(chapter.level < current.level) ||
            entries.slice(start + 1, index).some(entry => entry.level <= chapter.level)) return false;
          return candidate.document.blocks.some(block => {
            if (block.type !== 'heading') return false;
            const text = this.document.createElement('div'); text.innerHTML = block.html;
            return normalizeTitle(text.textContent ?? '') === normalizeTitle(current.title);
          });
        }).filter((candidate, index, values) => values.findIndex(value => value.title === candidate.title) === index);
        const exact = candidates.filter(candidate => candidate.title === normalizeTitle(current.title));
        if (exact.length === 1) return exact[0]!.document.title;
        if (candidates.length === 1) return candidates[0]!.document.title;
        if (candidates.length > 1) return '';
      }
    }
    const selected = selectedChapterTitle(this.document, this.layout === 'scroll');
    if (selected) return selected;
    const label = this.document.querySelector(".renderTargetPageInfo_header_chapterTitle")
      ?? [...this.document.querySelectorAll(".readerChapterContent_title")].find(node => !node.closest(".preRenderContent"));
    return label?.textContent?.trim() ?? "";
  }
}

function normalizeTitle(value: string): string { return value.replace(/\s|[\u200b-\u200d\ufeff]/g, ""); }

/** Adjacent layout can be captured under the previous chapter's route. Compare
 * its actual payload and local block identities, not that temporary route. */
function candidateSignature(value: ReaderDocument): string {
  const localId = (id: string) => id.startsWith(`${value.id}:`) ? id.slice(value.id.length + 1) : id;
  return JSON.stringify({ title: normalizeTitle(value.title),
    blocks: value.blocks.map(block => ({ ...block, id: localId(block.id) })),
    toc: value.toc.map(item => ({ ...item, id: localId(item.id) })) });
}

function relabelDocument(value: ReaderDocument, route: string, title: string, identity?: string): ReaderDocument {
  const id = identity ?? `weread:${new URL(route).pathname}:${title}`;
  const remap = (blockId: string) => blockId.startsWith(`${value.id}:`) ? `${id}:${blockId.slice(value.id.length + 1)}` : blockId;
  return { ...value, id, title, source: { ...value.source, url: route },
    blocks: value.blocks.map(block => ({ ...block, id: remap(block.id) })),
    toc: value.toc.map(item => ({ ...item, id: remap(item.id) })) };
}

function isBlockPrefix(first: ReaderDocument, second: ReaderDocument): boolean {
  return first.blocks.length <= second.blocks.length && first.blocks.every((block, index) => JSON.stringify(block) === JSON.stringify(second.blocks[index]));
}
