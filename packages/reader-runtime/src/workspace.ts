import type { ContentAnchor, Navigation, OperationResult, SourceSnapshot } from '../../reader-protocol/src/index';
import type { ReaderDocument } from '../../content-model/src/index';

export interface ReaderTransport {
  read(): Promise<SourceSnapshot>;
  navigate(action: Navigation, requestId: string, expectedPosition: string, expectedEpoch?: string): Promise<OperationResult>;
}
export interface ReaderView {
  setLocalPrompt?(message: string, actions: Array<{ label: string; run(): void }>): void;
  appendBatch?(batch: import('../../content-model/src/stream').StreamBatch, resolve?: import('../../content-model/src/stream-conversion').ResourceResolver): boolean;
  /** False rejects the update with visible feedback; a failed update preserves
   * any already displayed document. Legacy views may return void on success. */
  setDocument(value: ReaderDocument): boolean | void;
  setStatus(state: 'loading' | 'error' | 'ready', message?: string): void;
  setNotice(message: string): void;
  setNavigation(value: { previous: boolean; next: boolean; busy: boolean }): void;
  setSourceLocation?(value: { available: boolean; pendingChapter: boolean }): void;
  locate?(anchor: ContentAnchor): boolean;
  readonly scroller: HTMLElement;
}

/** Owns source state, not the reader's local scroll position or theme markup. */
export class ReaderWorkspace {
  private snapshot?: SourceSnapshot;
  private retiredEpochs = new Set<string>();
  private rendered = '';
  private displayedDocumentId?: string;
  private busy = false;
  private generation = 0;
  private operation = 0;
  private connected = true;
  private accepted = 0;
  constructor(private readonly transport: ReaderTransport, private readonly view: ReaderView) {}

  async connect(): Promise<void> {
    const generation = ++this.generation;
    const accepted = this.accepted;
    this.cancelPendingOperation();
    this.connected = true;
    if (!this.rendered) this.view.setStatus('loading');
    else this.view.setNotice('正在重新连接…');
    try {
      const snapshot = await this.transport.read();
      if (generation !== this.generation) return;
      if (this.accepted !== accepted && this.snapshot?.status === 'ready' &&
        (snapshot.epoch !== this.snapshot.epoch || snapshot.revision < this.snapshot.revision || snapshot.status !== 'ready')) return;
      // A current, broker-verified handshake may reconnect the same live source
      // after a temporary disconnect. Unsolicited retired pushes stay rejected.
      this.retiredEpochs.delete(snapshot.epoch);
      if (this.accept(snapshot) && snapshot.status === 'unavailable') {
        if (this.rendered) this.view.setNotice('暂时没有取得来源正文，当前章节已保留。请检查来源后重新连接。');
        else this.unavailable();
      }
    } catch (error) {
      if (generation !== this.generation || this.accepted !== accepted && this.snapshot?.status === 'ready') return;
      if (error instanceof Error && /^(reader-build-mismatch|source-build-mismatch|source-version-mismatch)$/.test(error.message)) {
        this.unavailable('扩展与页面版本不一致。请重新加载扩展、刷新来源，并重新打开独立阅读页。'); return;
      }
      if (this.rendered) { this.view.setNotice('暂时无法连接来源。可重新连接、刷新来源或返回原页。'); this.snapshot = undefined; this.navigation(); }
      else this.unavailable();
    }
  }

  /** Returns false for ignored snapshots or a document the view cannot display. */
  accept(snapshot: SourceSnapshot): boolean {
    if (!this.connected || !snapshot || typeof snapshot.epoch !== 'string' || !snapshot.position ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || this.retiredEpochs.has(snapshot.epoch)) return false;
    if (this.snapshot?.epoch === snapshot.epoch && snapshot.revision < this.snapshot.revision) return false;
    if (this.snapshot && this.snapshot.epoch !== snapshot.epoch) {
      this.retiredEpochs.add(this.snapshot.epoch);
      this.cancelPendingOperation();
    }
    this.snapshot = snapshot;
    ++this.accepted;
    if (snapshot.status === 'ready' && snapshot.document) {
      const next = snapshot.document;
      if (!this.displayedDocumentId || next.id === this.displayedDocumentId) {
        const first = !this.displayedDocumentId;
        const signature = JSON.stringify(next);
        if (signature !== this.rendered && !this.render(next, signature)) return false;
        const located = first && this.canLocate(snapshot) ? this.view.locate?.(snapshot.pageRange!.start) : undefined;
        this.view.setNotice(snapshot.operationState === 'uncertain'
          ? '上次切章结果尚未确认，已暂停新的操作。请检查来源后重新连接。'
          : located === false ? '已取得章节内容，但当前位置无法定位，请返回原页核对。'
            : '');
      } else {
        // Keep the current chapter and its local anchor. Only the latest source
        // snapshot is retained as pending; a background push never skips reading.
        this.view.setNotice(this.canLocate(snapshot)
          ? '来源章节已变化。当前内容保留，可从操作面板切换到来源章节。'
          : '来源章节已变化，当前内容已保留。如需读取来源当前章，请刷新此阅读页。');
      }
    } else if (!this.rendered) this.view.setStatus('loading');
    else this.view.setNotice('正在等待来源内容更新…');
    this.navigation();
    return true;
  }

  /** Explicit user action; never called by background updates or navigation. */
  locateSource(): void {
    const snapshot = this.snapshot;
    if (!this.connected || snapshot?.status !== 'ready' || !snapshot.document) return;
    if (!this.canLocate(snapshot)) {
      this.view.setNotice('尚无可靠的来源位置映射，请返回原页核对。'); return;
    }
    const signature = JSON.stringify(snapshot.document);
    if ((signature !== this.rendered || snapshot.document.id !== this.displayedDocumentId) && !this.render(snapshot.document, signature)) return;
    const located = this.view.locate?.(snapshot.pageRange!.start);
    this.view.setNotice(located === false ? '当前位置无法定位，请返回原页核对。' : '');
    this.navigation();
  }

  async navigate(action: Navigation): Promise<void> {
    if (this.busy || !this.connected || this.snapshot?.status !== 'ready' || !this.snapshot.capabilities[action] || this.snapshot.operationState === 'uncertain' || this.hasUndisplayedChapter()) return;
    const generation = this.generation, epoch = this.snapshot.epoch, previousId = this.displayedDocumentId;
    const operation = ++this.operation;
    const requestId = crypto.randomUUID();
    this.busy = true; this.navigation(); this.view.setNotice('正在加载相邻章节，当前章节仍可阅读…');
    try {
      const result = await this.transport.navigate(action, requestId, this.snapshot.position.key, epoch);
      if (generation !== this.generation || operation !== this.operation || result.requestId !== requestId ||
        this.snapshot?.epoch !== epoch || result.snapshot.epoch !== epoch) return;
      let confirmed = result.snapshot;
      if (confirmed.revision < this.snapshot.revision) {
        // A later push can describe the same confirmed chapter. Use that newer
        // state without allowing an old response to overwrite different content.
        const current = this.snapshot;
        if (!result.ok || confirmed.document?.id === previousId || confirmed.pageRange || current.pageRange ||
          current.status !== 'ready' || current.operationState === 'uncertain' ||
          !confirmed.document || confirmed.position.documentId !== current.position.documentId ||
          confirmed.position.chapter !== current.position.chapter || JSON.stringify(confirmed.document) !== JSON.stringify(current.document)) return;
        confirmed = current;
      }
      const accepted = this.accept(confirmed);
      if (!accepted && (this.snapshot?.document?.id !== confirmed.document?.id || this.snapshot?.epoch !== epoch)) return;
      if (!result.ok) this.view.setNotice(result.reason === 'unsupported'
        ? action === 'next-page' ? '没有可用的下一章，当前章节已保留。' : '没有可用的上一章，当前章节已保留。'
        : result.reason === 'input-unavailable'
        ? '无法操作后台微信读书目录，请检查扩展调试权限和来源页面。当前章节已保留。'
        : result.reason === 'stale-position'
        ? '来源位置已变化，已重新读取。请核对后再操作。'
        : result.reason === 'reconciliation-required'
          ? '上次切章尚未确认，已暂停新的操作。请检查来源或刷新后重连。'
          : '未确认切章完成。当前章节已保留，可返回原页面检查。');
      else {
        const next = confirmed.document;
        if (next?.id === previousId && confirmed.pageRange) {
          this.view.setNotice('来源翻页已确认。本地阅读位置保留，可从操作面板定位到来源。'); return;
        }
        if (!next || next.id === previousId || !this.render(next, JSON.stringify(next))) {
          this.view.setNotice('目标章节正文未能确认或显示，当前章节已保留。'); return;
        }
        this.view.scroller.scrollTop = 0;
        this.view.setNotice(`已切换到${next.title}，从章首开始阅读。`);
      }
    } catch {
      if (generation === this.generation && operation === this.operation) this.view.setNotice('暂时无法连接来源。请检查后重新连接。');
    } finally {
      if (operation === this.operation) { this.busy = false; this.navigation(); }
    }
  }

  sourceLoading(): void {
    ++this.generation; this.cancelPendingOperation(); this.connected = true;
    if (this.snapshot) this.retiredEpochs.add(this.snapshot.epoch);
    this.snapshot = undefined;
    if (this.rendered) this.view.setNotice('来源正在重新加载，当前阅读位置保留…');
    else this.view.setStatus('loading');
    this.navigation();
  }
  disconnect(): void {
    ++this.generation; this.connected = false; this.cancelPendingOperation();
    if (this.snapshot) this.retiredEpochs.add(this.snapshot.epoch);
    this.snapshot = undefined; this.rendered = ''; this.displayedDocumentId = undefined;
    this.view.setStatus('error', '来源已断开。原标签可用时请重新连接；若已关闭，请在新来源页的扩展弹窗中选择连接此阅读页。');
    this.navigation();
  }
  private unavailable(message = '暂时没有取得正文。可刷新来源并重试，或返回原页面检查。'): void {
    this.rendered = ''; this.snapshot = undefined; this.displayedDocumentId = undefined;
    this.view.setStatus('error', message); this.navigation();
  }
  private render(value: ReaderDocument, signature: string): boolean {
    try {
      if (this.view.setDocument(value) === false) {
        // The view has already explained the rejected update. Do not replace
        // that feedback with a source-position notice or cache it as rendered.
        this.snapshot = undefined; this.navigation(); return false;
      }
    } catch {
      this.snapshot = undefined;
      if (this.rendered) this.view.setNotice('新正文暂时无法显示，当前内容已保留。请重新连接重试。');
      else this.view.setStatus('error', '正文暂时无法显示。请重新连接重试；若仍失败，请重新加载扩展。');
      this.navigation(); return false;
    }
    this.rendered = signature; this.displayedDocumentId = value.id;
    return true;
  }
  private cancelPendingOperation(): void { ++this.operation; this.busy = false; }
  private canLocate(snapshot: SourceSnapshot): boolean {
    const range = snapshot.pageRange, doc = snapshot.document;
    if (!range || range.evidence !== 'dom-range' || !doc || range.start.documentId !== doc.id || range.end.documentId !== doc.id ||
      !Number.isSafeInteger(range.start.offset) || range.start.offset < 0 || !Number.isSafeInteger(range.end.offset) || range.end.offset < 0) return false;
    const start = doc.blocks.findIndex(block => block.id === range.start.blockId), end = doc.blocks.findIndex(block => block.id === range.end.blockId);
    return start >= 0 && end >= start && (end !== start || range.end.offset > range.start.offset);
  }
  private navigation(): void {
    const ready = this.connected && this.snapshot?.status === 'ready' && this.snapshot.operationState !== 'uncertain';
    const canNavigate = ready && !this.hasUndisplayedChapter();
    this.view.setNavigation({ previous: !!canNavigate && !!this.snapshot?.capabilities['previous-page'], next: !!canNavigate && !!this.snapshot?.capabilities['next-page'], busy: this.busy });
    this.view.setSourceLocation?.({ available: !!this.snapshot && !!ready && this.canLocate(this.snapshot), pendingChapter: !!this.snapshot?.document && !!this.displayedDocumentId && this.snapshot.document.id !== this.displayedDocumentId });
  }
  private hasUndisplayedChapter(): boolean {
    return !!this.snapshot?.document && !!this.displayedDocumentId && this.snapshot.document.id !== this.displayedDocumentId;
  }
}
