import type { StreamBatch, StreamItem } from '../../content-model/src/stream';
import { decodeFanqieText, FANQIE_FONT_FAMILY, FANQIE_FONT_FILE } from './font-map';

export function isFanqieReaderUrl(value: string): boolean {
  try { const url = new URL(value); return url.origin === 'https://fanqienovel.com' && /^\/reader\/\d+\/?$/.test(url.pathname); }
  catch { return false; }
}

interface Chapter { id: string; title: string; paragraphs: string[] }
const chapterId = (url: string): string | undefined => isFanqieReaderUrl(url) ? new URL(url).pathname.match(/\d+/)?.[0] : undefined;
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
function knownFont(doc: Document): boolean {
  for (const sheet of doc.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.cssText.startsWith('@font-face') && rule.cssText.includes(`font-family: ${FANQIE_FONT_FAMILY}`)
          && rule.cssText.includes(`/${FANQIE_FONT_FILE}`)) return true;
      }
    } catch { /* A foreign stylesheet may hide its rules. */ }
  }
  return false;
}

/** Reads only the current rendered reader container; no site API or hidden catalogue. */
export function readFanqieChapter(doc: Document, url: string): Chapter {
  const id = chapterId(url);
  const box = doc.querySelector<HTMLElement>('.muye-reader-box');
  const title = box?.querySelector<HTMLElement>('.muye-reader-box-header h1.muye-reader-title');
  const body = box?.querySelector<HTMLElement>('.muye-reader-content');
  if (!id || !box || !title || !body) throw new Error('chapter-not-ready');
  const nodes = [...body.querySelectorAll<HTMLParagraphElement>('p')];
  if (!nodes.length) throw new Error('chapter-not-ready');
  if (nodes.some(node => /[\ue000-\uf8ff]/u.test(node.textContent ?? '')) &&
    (!knownFont(doc) || nodes.some(node => !doc.defaultView?.getComputedStyle(node).fontFamily.includes(FANQIE_FONT_FAMILY))))
    throw new Error('fanqie-font-changed');
  const paragraphs = nodes.map(node => decodeFanqieText(node.textContent ?? '').trim()).filter(Boolean);
  const declared = box.querySelector('.muye-reader-box-header')?.textContent?.match(/本章字数\s*[：:]?\s*([\d,]+)\s*字/);
  if (!declared) throw new Error('chapter-length-unknown');
  const actualLength = nodes.reduce((total, node) => total + (node.textContent ?? '').length, 0);
  const declaredLength = Number(declared[1].replaceAll(',', ''));
  // The site can report one fewer character than the rendered paragraphs.
  const tolerance = Math.max(2, Math.ceil(declaredLength / 1000));
  if (Math.abs(actualLength - declaredLength) > tolerance) throw new Error(
    doc.body.textContent?.includes('扫码下载APP免费读') ? 'chapter-access-restricted' : 'chapter-incomplete');
  if (!paragraphs.length) throw new Error('chapter-not-ready');
  return { id, title: decodeFanqieText(title.textContent?.trim() ?? ''), paragraphs };
}

export class FanqieBatchSource {
  private session?: string;
  private sequence = 0;
  private batchSequence = 0;
  private chapter?: string;
  private initial?: Promise<StreamBatch>;
  private busy = false;
  private halted = false;
  private stopped = false;
  private results = new Map<string, Promise<StreamBatch>>();
  constructor(private readonly doc: Document, private readonly url: () => string,
    private readonly wait: (ms: number) => Promise<void> = pause) {}
  stop(): void { this.stopped = true; this.results.clear(); }
  fetch(sessionId: string, requestId: string, initial: boolean): Promise<StreamBatch> {
    if (this.stopped || !sessionId || !requestId) return Promise.reject(new Error('source-unavailable'));
    if (this.session && this.session !== sessionId) return Promise.reject(new Error('source-session-in-use'));
    const key = `${initial}:${requestId}`;
    const previous = this.results.get(key);
    if (previous) return previous;
    if (initial && this.initial) return this.initial;
    if (this.halted) return Promise.reject(new Error('reconciliation-required'));
    if (this.busy) return Promise.reject(new Error('busy'));
    if (!initial && !this.initial) return Promise.reject(new Error('initialization-required'));
    this.session = sessionId; this.busy = true;
    const result = this.collect(requestId, initial).finally(() => { this.busy = false; });
    this.results.set(key, result);
    if (initial) this.initial = result;
    return result;
  }
  private nextButton(): HTMLElement | undefined {
    return [...this.doc.querySelectorAll<HTMLElement>('.chapter-btn.next button')]
      .find(node => node.textContent?.trim() === '下一章' && !node.hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true');
  }
  private async ready(expected?: string, previousContent?: string): Promise<Chapter> {
    const deadline = Date.now() + 10000;
    let lastError: Error = new Error('chapter-not-ready');
    while (Date.now() < deadline && !this.stopped) {
      if (expected && chapterId(this.url()) !== expected) throw new Error('source-position-changed');
      try {
        if (previousContent && this.contentMarker() === previousContent) throw new Error('chapter-not-ready');
        return readFanqieChapter(this.doc, this.url());
      }
      catch (error) {
        lastError = error instanceof Error ? error : new Error('chapter-not-ready');
        if (!['chapter-not-ready', 'chapter-length-unknown', 'chapter-incomplete'].includes(lastError.message)) throw lastError;
      }
      await this.wait(50);
    }
    throw lastError;
  }
  private contentMarker(): string {
    return `${this.doc.querySelector('.muye-reader-title')?.textContent ?? ''}\n${this.doc.querySelector('.muye-reader-content')?.textContent ?? ''}`;
  }
  private async collect(requestId: string, initial: boolean): Promise<StreamBatch> {
    let items: StreamItem[] = [], status: StreamBatch['status'] = 'complete', reason: string | undefined;
    try {
      let previousContent: string | undefined;
      if (!initial) {
        if (!this.chapter || chapterId(this.url()) !== this.chapter) throw new Error('source-position-changed');
        const button = this.nextButton();
        if (!button) throw new Error('next-chapter-unavailable');
        previousContent = this.contentMarker();
        button.click();
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && chapterId(this.url()) === this.chapter && !this.stopped) await this.wait(50);
        if (chapterId(this.url()) === this.chapter) throw new Error('next-chapter-not-confirmed');
      }
      const expected = chapterId(this.url());
      const chapter = await this.ready(expected, previousContent);
      if (initial && this.chapter || !initial && this.chapter === chapter.id) throw new Error('duplicate-chapter');
      const data: StreamItem[] = [
        { id: `fanqie:${chapter.id}:title`, sequence: ++this.sequence, chapterId: chapter.id, kind: 'title', data: { text: chapter.title } },
        ...chapter.paragraphs.map((text, index): StreamItem => ({ id: `fanqie:${chapter.id}:p:${index}`, sequence: ++this.sequence,
          chapterId: chapter.id, kind: 'text', data: { text } }))
      ];
      this.chapter = chapter.id; items = data;
    } catch (error) { status = 'partial'; reason = error instanceof Error ? error.message : 'source-unavailable'; this.halted = true; }
    return { schemaVersion: 1, sessionId: this.session!, requestId, batchId: crypto.randomUUID(), batchSequence: ++this.batchSequence,
      items, status, hasMore: status === 'complete', ...(reason ? { reason } : {}) };
  }
}
