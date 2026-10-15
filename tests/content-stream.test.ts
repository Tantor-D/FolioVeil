// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { StreamSequence, type StreamBatch } from '../packages/content-model/src/stream';
import { blockToItem, DocumentStreamEncoder, itemToBlock } from '../packages/content-model/src/stream-conversion';
import type { ReaderDocument } from '../packages/content-model/src/index';

const chapter = (id = 'a'): ReaderDocument => ({ id, title: id, source: { kind: 'fixture' }, toc: [], warnings: [], blocks: [
  { id: `${id}:1`, type: 'paragraph', html: '相同段落' }, { id: `${id}:2`, type: 'paragraph', html: '相同段落' }
] });
const batch = (): StreamBatch => ({ schemaVersion: 1, sessionId: 's', requestId: 'r', batchId: 'b', batchSequence: 1,
  items: new DocumentStreamEncoder(document).append(chapter()), status: 'complete', hasMore: true });

describe('ordered stream contract', () => {
  it('keeps legitimate repeated paragraphs, emits a title once, and appends the next chapter', () => {
    const encoder = new DocumentStreamEncoder(document);
    expect(encoder.append(chapter()).map(i => i.kind)).toEqual(['title', 'text', 'text']);
    expect(encoder.append(chapter())).toEqual([]);
    expect(encoder.append(chapter('b')).map(i => i.sequence)).toEqual([4, 5, 6]);
    expect(() => encoder.append(chapter())).toThrow('source-moved-backwards');
  });
  it('appends only a same-chapter suffix without removing legitimate repeated text', () => {
    const encoder = new DocumentStreamEncoder(document);
    encoder.append(chapter());
    const extended = chapter();
    extended.blocks.push({ id: 'a:3', type: 'paragraph', html: '相同段落' });
    const items = encoder.append(extended);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'text', sequence: 4, data: { text: '相同段落' } });
    expect(encoder.append(extended)).toEqual([]);
  });
  it('detects changed source prefixes without retiring previously returned blocks', () => {
    const encoder = new DocumentStreamEncoder(document); encoder.append(chapter());
    const value = chapter(); value.blocks[0] = { id: 'a:1', type: 'paragraph', html: 'changed' };
    expect(() => encoder.append(value)).toThrow('source-content-changed');
    expect(encoder.append(chapter())).toEqual([]);
  });
  it('rejects missing batches, replays exact duplicates, rejects conflicting identities', () => {
    const sequence = new StreamSequence(), value = batch();
    expect(() => sequence.prepare({ ...value, batchSequence: 2 })).toThrow('batch-out-of-order');
    sequence.prepare(value).commit(); expect(sequence.prepare(value).duplicate).toBe(true);
    expect(() => sequence.prepare({ ...value, hasMore: false })).toThrow('batch-conflict');
    expect(() => sequence.prepare({ ...value, sessionId: 'other' })).toThrow('session-mismatch');
  });
  it('does not consume a batch before successful rendering', () => {
    const sequence = new StreamSequence(), value = batch(); sequence.prepare(value);
    expect(sequence.prepare(value).duplicate).toBe(false);
    const invalid = structuredClone(value); invalid.items[1]!.chapterId = 'wrong';
    expect(() => sequence.prepare(invalid)).toThrow('missing-chapter-title');
    sequence.prepare(value).commit();
  });
  it('strips inline formatting, preserves text and line breaks, and escapes plain text on display', () => {
    const item = blockToItem({ id: 'p', type: 'paragraph', html: '<strong>A</strong><br><a href="https://example.com">B</a>&lt;script&gt;' }, 'a', 1, document);
    expect(item).toMatchObject({ kind: 'text', data: { text: 'A\nB<script>' } });
    if (item.kind !== 'title') expect(itemToBlock(item)).toMatchObject({ html: 'A<br>B&lt;script&gt;' });
  });
  it('preserves nested lists and table spans as structured data', () => {
    const list = blockToItem({ id: 'l', type: 'list', ordered: true, items: ['Parent<ul><li>Child</li></ul>'] }, 'a', 1, document);
    expect(list).toMatchObject({ kind: 'list', data: { items: [{ text: 'Parent', children: [{ ordered: false, items: [{ text: 'Child' }] }] }] } });
    const table = blockToItem({ id: 't', type: 'table', html: '<table><tr><th colspan="2">Title</th></tr><tr><td>A</td><td>B</td></tr></table>' }, 'a', 2, document);
    expect(table).toMatchObject({ kind: 'table', data: { rows: [[{ text: 'Title', header: true, colSpan: 2 }], [{ text: 'A' }, { text: 'B' }]] } });
  });
  it('uses opaque resources and retains unavailable images at their original position', () => {
    const item = blockToItem({ id: 'i', type: 'image', label: 'Illustration', caption: 'Caption', resourceKind: 'image', src: 'https://example.com/image.png' }, 'a', 1, document, () => 'resource-1');
    expect(JSON.stringify(item)).not.toContain('https://');
    expect(item).toMatchObject({ kind: 'image', data: { resourceId: 'resource-1' } });
    if (item.kind !== 'title') expect(itemToBlock(item)).toMatchObject({ type: 'image', src: undefined, label: 'Illustration' });
  });
});
