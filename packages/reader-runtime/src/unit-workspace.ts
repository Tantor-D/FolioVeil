import { StreamSequence } from '../../content-model/src/stream';
import type { ReadingUnit, UnitNavigationSource } from '../../reader-protocol/src/index';

/** One source instance belongs to one selected file and one reader page. */
export class UnitWorkspace<Source extends UnitNavigationSource> {
  private source?: Source;
  private generation = 0;
  private busy = false;
  private sequence = new StreamSequence();
  private filename = '';
  constructor(private readonly view: {
    replaceBatch(batch: ReturnType<UnitNavigationSource['read']>): boolean;
    setContents(filename: string, units: readonly ReadingUnit[], currentId?: string): void;
    setNavigation(value: { previous: boolean; next: boolean; busy: boolean }): void;
    setNotice(message: string): void;
  }, private readonly displayed: (source: Source, index: number, valid: () => boolean) => Promise<void>) {}
  get currentIndex(): number { return this.source?.currentIndex ?? -1; }
  get currentSource(): Source | undefined { return this.source; }
  replace(source: Source, filename: string): void {
    ++this.generation; this.busy = false; this.source = source; this.filename = filename; this.sequence = new StreamSequence();
    this.view.setContents(filename, source.units);
    this.view.setNavigation({ previous: false, next: false, busy: false });
  }
  invalidate(): void { ++this.generation; this.busy = false; this.source = undefined; this.view.setNavigation({ previous: false, next: false, busy: false }); }
  async next(): Promise<boolean> {
    const source = this.source;
    if (!source || this.busy || source.currentIndex >= source.units.length - 1) return false;
    return this.read(source.units[source.currentIndex + 1]!.id);
  }
  async read(unitId: string): Promise<boolean> {
    const source = this.source;
    if (!source || this.busy || !source.units.some(unit => unit.id === unitId)) return false;
    this.busy = true;
    const generation = this.generation, checkpoint = source.checkpoint();
    this.view.setNavigation({ previous: false, next: false, busy: true });
    try {
      const batch = source.read(unitId, crypto.randomUUID());
      if (generation !== this.generation || source !== this.source) { source.restore(checkpoint); return false; }
      const validator = batch.sessionId === checkpoint.sessionId ? this.sequence : new StreamSequence();
      const transaction = validator.prepare(batch);
      if (!this.view.replaceBatch(batch)) throw new Error('display-rejected');
      transaction.commit(); this.sequence = validator;
      const index = source.currentIndex;
      this.view.setContents(this.filename, source.units, unitId);
      this.view.setNotice(source.units[index]!.hasNext ? '' : '已到文件末尾。');
      try { await this.displayed(source, index, () => generation === this.generation && source === this.source); }
      catch { if (generation === this.generation && source === this.source) this.view.setNotice('当前单元已显示，但阅读位置未能保存。'); }
      return true;
    } catch { source.restore(checkpoint); this.view.setNotice('读取失败，已保留原正文和阅读进度。'); return false; }
    finally {
      if (generation === this.generation && source === this.source) {
        this.busy = false;
        this.view.setNavigation({ previous: false, next: source.currentIndex < source.units.length - 1, busy: false });
      }
    }
  }
}
