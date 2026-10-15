import type { StreamBatch, StreamItem } from '../../content-model/src/stream';
import type { ReadingUnit, UnitReadCursor } from '../../reader-protocol/src/index';

export const TXT_RULE_VERSION = 'txt-1';
export const SECTION_LENGTH = 3000;
export type TxtEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';
export interface TxtUnit extends ReadingUnit { kind: 'chapter' | 'section'; start: number; end: number; bodyStart: number }

export function decodeTxt(bytes: ArrayBuffer, selected?: TxtEncoding): { text: string; encoding: TxtEncoding; uncertain: boolean } {
  const data = new Uint8Array(bytes);
  if (!data.length) throw new Error('empty-file');
  const bom = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : undefined;
  const encoding = selected ?? bom ?? 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(data); }
  catch {
    if (selected || bom) throw new Error('invalid-encoding');
    try { text = new TextDecoder('gb18030', { fatal: true }).decode(data); }
    catch { throw new Error('invalid-encoding'); }
    validateText(text);
    return { text: text.replace(/^\uFEFF/, ''), encoding: 'gb18030', uncertain: true };
  }
  text = text.replace(/^\uFEFF/, '');
  validateText(text);
  return { text, encoding, uncertain: !bom && !selected && encoding !== 'utf-8' };
}
function validateText(text: string): void {
  if (!text.trim()) throw new Error('empty-file');
  if (/[\u0000-\u0008\u000e-\u001f]/u.test(text)) throw new Error('invalid-encoding');
}

type Heading = { start: number; end: number; title: string; family: string };
function headings(text: string): Heading[] {
  const result: Heading[] = [];
  const lines = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (const match of text.matchAll(lines)) {
    const line = match[0]; if (!line) continue;
    const title = line.trim(); if (!title || title.length > 70) continue;
    const chinese = /^第\s*[零〇一二三四五六七八九十百千万两0-9０-９]{1,12}\s*[章节回](?:\s|[：:、.．-]|$)/u.test(title);
    const compactChinese = !chinese && title.length <= 34 && !/[。！？.!?，,；;]/u.test(title) &&
      /^第\s*[零〇一二三四五六七八九十百千万两0-9０-９]{1,12}\s*[章节回][^\s：:、.．-]/u.test(title);
    const special = /^(?:序章|楔子|尾声|终章|番外[零〇一二三四五六七八九十0-9０-９]{0,4})(?:\s|[：:、.．-]|$)/u.test(title);
    const english = /^chapter\s+[0-9ivxlcdm]+(?:\s|[：:、.．-]|$)/iu.test(title);
    const numeric = /^[0-9０-９]{1,4}[.．、]\s*\S.{0,55}$/u.test(title);
    const family = chinese ? 'zh' : compactChinese ? 'zh-compact' : special ? 'special' : english ? 'en' : numeric ? 'numeric' : '';
    if (family) result.push({ start: match.index!, end: match.index! + line.length, title, family });
  }
  return result;
}
function reliable(text: string, candidates: Heading[]): Heading[] {
  const toc = /^(?:\uFEFF)?\s*(?:目录|目次|contents)\s*(?:\r\n|\n|\r)/iu.exec(text);
  const firstBreak = toc ? text.slice(toc[0].length).search(/(?:\r\n|\n|\r)\s*(?:\r\n|\n|\r)/u) : -1;
  const tocEnd = toc && firstBreak >= 0 ? toc[0].length + firstBreak : -1;
  const eligible = candidates.filter(h => h.start >= tocEnd);
  const strong = eligible.filter(h => h.family !== 'numeric');
  const chosen = strong.length ? strong : eligible.filter(h => h.family === 'numeric');
  // A printed contents page often has densely packed headings. Consecutive
  // headings with no body are retained in the text but never become units.
  const withBody = chosen.filter((h, i) => {
    const next = chosen[i + 1]?.start ?? text.length;
    return text.slice(h.end, next).trim().length >= 2;
  });
  if (withBody.length < 2 && !(withBody.length === 1 && withBody[0]!.start === 0)) return [];
  if (!strong.length && withBody.length < 3) return [];
  return withBody;
}
function codePointOffset(text: string, start: number, count: number): number {
  let offset = start;
  for (let i = 0; i < count && offset < text.length; i++) offset += text.codePointAt(offset)! > 0xffff ? 2 : 1;
  return offset;
}
function sectionEnd(text: string, start: number): number {
  const target = codePointOffset(text, start, SECTION_LENGTH);
  if (target >= text.length) return text.length;
  const lower = codePointOffset(text, start, 2400);
  const upper = codePointOffset(text, start, 3300);
  const window = text.slice(lower, upper);
  const choices = [...window.matchAll(/(?:\r\n|\n|\r){2,}|[。！？.!?][”’」』】）]?/gu)]
    .map(m => lower + m.index! + m[0].length).filter(n => n > start && n < text.length);
  if (!choices.length) return target;
  return choices.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best);
}
export function indexTxt(text: string, encoding: TxtEncoding): TxtUnit[] {
  const found = reliable(text, headings(text));
  const ranges: Array<{ start: number; end: number; bodyStart: number; title: string; kind: 'chapter' | 'section' }> = [];
  if (found.length) {
    if (found[0]!.start > 0) ranges.push({ start: 0, end: found[0]!.start, bodyStart: 0, title: '卷首', kind: 'chapter' });
    found.forEach((heading, i) => ranges.push({ start: heading.start, end: found[i + 1]?.start ?? text.length, bodyStart: heading.end, title: heading.title, kind: 'chapter' }));
  } else {
    let start = 0, number = 1;
    while (start < text.length) { const end = sectionEnd(text, start); ranges.push({ start, end, bodyStart: start, title: `第 ${number++} 节`, kind: 'section' }); start = end; }
  }
  return ranges.map((unit, sequence) => ({ ...unit, id: `${TXT_RULE_VERSION}:${encoding}:${unit.start}:${unit.end}`, sequence, hasNext: sequence < ranges.length - 1 }));
}
export class TxtSource {
  readonly units: TxtUnit[];
  private sessionId = crypto.randomUUID();
  private batchSequence = 0;
  private itemSequence = 0;
  private current = -1;
  constructor(readonly text: string, readonly encoding: TxtEncoding) { this.units = indexTxt(text, encoding); }
  get currentIndex(): number { return this.current; }
  checkpoint(): UnitReadCursor {
    return { sessionId: this.sessionId, batchSequence: this.batchSequence, itemSequence: this.itemSequence, current: this.current };
  }
  restore(value: UnitReadCursor): void { Object.assign(this, value); }
  read(unitId: string, requestId: string): StreamBatch {
    const index = this.units.findIndex(unit => unit.id === unitId);
    if (index < 0) throw new Error('unit-unavailable');
    const unit = this.units[index]!;
    if (index !== this.current + 1) { this.sessionId = crypto.randomUUID(); this.batchSequence = 0; this.itemSequence = 0; }
    const items: StreamItem[] = [{ id: `${unit.id}:title`, chapterId: unit.id, kind: 'title', sequence: ++this.itemSequence, data: { text: unit.title } }];
    const body = this.text.slice(unit.bodyStart, unit.end);
    const paragraphs = body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
    paragraphs.forEach((part, offset) => items.push({ id: `${unit.id}:text:${offset}`, chapterId: unit.id, kind: 'text', sequence: ++this.itemSequence, data: { text: part } }));
    this.current = index;
    return { schemaVersion: 1, sessionId: this.sessionId, requestId, batchId: `${this.sessionId}:${++this.batchSequence}`, batchSequence: this.batchSequence,
      items, status: unit.hasNext ? 'complete' : 'end', hasMore: unit.hasNext };
  }
}
