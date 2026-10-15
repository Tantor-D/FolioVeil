import { describe, expect, it, vi } from 'vitest';
import { decodeTxt, indexTxt, TxtSource } from '../packages/adapter-txt/src/index';
import { StreamSequence } from '../packages/content-model/src/stream';
import { UnitWorkspace } from '../packages/reader-runtime/src/unit-workspace';

describe('local TXT source', () => {
  it('rejects bursts until display persistence completes, with no queued chapter', async () => {
    const source = new TxtSource('第一章 开始\n正文。\n第二章 继续\n正文。\n第三章 末尾\n正文。', 'utf-8');
    let finish!: () => void;
    const displayed = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = { replaceBatch: vi.fn(() => true), setContents: vi.fn(), setNavigation: vi.fn(), setNotice: vi.fn() };
    const workspace = new UnitWorkspace(view, displayed); workspace.replace(source, 'neutral.txt');
    const pending = workspace.next();
    for (let i = 0; i < 10; i++) expect(await workspace.next()).toBe(false);
    expect(view.replaceBatch).toHaveBeenCalledTimes(1);
    expect(view.setNavigation).toHaveBeenLastCalledWith({ previous: false, next: false, busy: true });
    finish(); await pending; await Promise.resolve();
    expect(source.currentIndex).toBe(0); expect(view.replaceBatch).toHaveBeenCalledTimes(1);
    const second = workspace.next(); finish(); await second;
    expect(source.currentIndex).toBe(1); expect(view.replaceBatch).toHaveBeenCalledTimes(2);
  });
  it('decodes UTF-8, marked UTF-16 and GB18030 and rejects empty content', () => {
    const utf8 = new TextEncoder().encode('第一章 开始\n正文').buffer;
    expect(decodeTxt(utf8).text).toContain('正文');
    const utf16 = Uint8Array.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]).buffer;
    expect(decodeTxt(utf16)).toMatchObject({ text: '中文', encoding: 'utf-16le' });
    const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]).buffer;
    expect(decodeTxt(gbk)).toMatchObject({ text: '中文', encoding: 'gb18030' });
    expect(() => decodeTxt(new ArrayBuffer(0))).toThrow('empty-file');
  });

  it('recognizes ordinary headings, preserves a contents page and distinguishes repeated titles', () => {
    const text = '目录\n第一章 起点\n第二章 继续\n\n卷一\n卷首正文。\n第一章 起点\n正文甲。正文甲。\n第二章 继续\n正文乙。\n第一回 再来\n正文丙。\nChapter 4 End\nEnglish content here.\n';
    const units = indexTxt(text, 'utf-8');
    expect(units.map(u => u.title)).toEqual(['卷首', '第一章 起点', '第二章 继续', '第一回 再来', 'Chapter 4 End']);
    expect(units[0]!.start).toBe(0);
    expect(units.map(u => text.slice(u.start, u.end)).join('')).toBe(text);
    expect(new Set(units.map(u => u.id)).size).toBe(units.length);
  });

  it('uses sections for ordinary numbers and long Unicode text without losing a character', () => {
    const text = '卷一\n12 次尝试。\n---\n' + '😀一二三。'.repeat(1100) + '\n短尾';
    const units = indexTxt(text, 'utf-8');
    expect(units.length).toBeGreaterThan(1);
    expect(units.every(u => u.kind === 'section')).toBe(true);
    expect(units.map(u => text.slice(u.start, u.end)).join('')).toBe(text);
    expect(units.slice(0, -1).every(u => [...text.slice(u.start, u.end)].length >= 2400)).toBe(true);
  });

  it('emits a complete ordered unit and starts a new transport session on a jump', () => {
    const source = new TxtSource('第一章 起点\n相同段落。\n相同段落。\n第二章 继续\n第二章正文。\n第三章 终点\n末章正文。', 'utf-8');
    const order = new StreamSequence();
    const first = source.read(source.units[0]!.id, 'r1'); order.prepare(first).commit();
    expect(first.items[0]?.kind).toBe('title');
    expect(first.items.filter(i => i.kind === 'text').map(i => i.data.text).join('')).toContain('相同段落。\n相同段落。');
    const second = source.read(source.units[1]!.id, 'r2'); order.prepare(second).commit();
    const last = source.read(source.units[2]!.id, 'r3'); order.prepare(last).commit();
    expect(last).toMatchObject({ status: 'end', hasMore: false, batchSequence: 3 });
    const jump = source.read(source.units[0]!.id, 'r4');
    expect(jump.sessionId).not.toBe(last.sessionId);
    expect(jump.batchSequence).toBe(1);
    expect(() => order.prepare(jump)).toThrow('session-mismatch');
    new StreamSequence().prepare(jump).commit();
  });

  it('retains the previous unit when display rejects a target and blocks repeat clicks', async () => {
    const source = new TxtSource('第一章 起点\n正文足够长。\n第二章 继续\n后续正文足够长。', 'utf-8');
    let accept = true;
    const displayed = vi.fn(async () => undefined);
    const view = { replaceBatch: vi.fn(() => accept), setContents: vi.fn(), setNavigation: vi.fn(), setNotice: vi.fn() };
    const workspace = new UnitWorkspace(view, displayed);
    workspace.replace(source, 'sample.txt');
    expect(await workspace.next()).toBe(true);
    expect(source.currentIndex).toBe(0);
    accept = false;
    expect(await workspace.next()).toBe(false);
    expect(source.currentIndex).toBe(0);
    expect(displayed).toHaveBeenCalledTimes(1);
    accept = true;
    expect(await workspace.next()).toBe(true);
    expect(source.currentIndex).toBe(1);
    expect(await workspace.next()).toBe(false);
  });

  it('invalidates a pending save when another file replaces the source', async () => {
    const first = new TxtSource('第一章 开始\n旧文件正文足够长。', 'utf-8');
    const second = new TxtSource('第一章 开始\n新文件正文足够长。', 'utf-8');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const saved: string[] = [];
    const view = { replaceBatch: vi.fn(() => true), setContents: vi.fn(), setNavigation: vi.fn(), setNotice: vi.fn() };
    const workspace = new UnitWorkspace<TxtSource>(view, async (source, _index, valid) => { await pending; if (valid()) saved.push(source.text); });
    workspace.replace(first, 'old.txt');
    const oldRead = workspace.next();
    expect(await workspace.next()).toBe(false);
    workspace.replace(second, 'new.txt');
    const newRead = workspace.next();
    release(); await Promise.all([oldRead, newRead]);
    expect(saved).toEqual([second.text]);
    expect(workspace.currentSource).toBe(second);
  });
});
