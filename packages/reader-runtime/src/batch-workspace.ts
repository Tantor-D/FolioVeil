import type { StreamBatch } from '../../content-model/src/stream';
import { StreamSequence } from '../../content-model/src/stream';
import type { ReaderView } from './workspace';

export interface BatchTransport {
  guidance?(): Promise<{ epoch: string; message?: string }>;
  fetch(requestId: string, initial: boolean): Promise<{ epoch: string; batch: StreamBatch }>;
  resource(id: string): Promise<{ epoch: string; data: string }>;
}
/** The source owns collection policy. This layer only orders and delivers batches. */
export class BatchWorkspace {
  private busy = false;
  private initialized = false;
  private guidanceChecked = false;
  private connected = true;
  private more = true;
  private retryInitial = false;
  private retryFrozen = false;
  private epoch?: string;
  private generation = 0;
  private sequence = new StreamSequence();
  private resources = new Map<string, string>();
  constructor(private readonly sessionId: string, private readonly transport: BatchTransport, private readonly view: ReaderView) {}
  connect(): Promise<void> {
    if ((this.retryInitial || this.retryFrozen) && this.connected && !this.busy) { this.more = true; return this.fetch(); }
    return this.initialized ? Promise.resolve() : this.fetch();
  }
  async fetch(): Promise<void> {
    if (this.busy || !this.connected || !this.more) return;
    this.busy = true; const generation = this.generation;
    this.view.setNavigation({ previous: false, next: false, busy: true });
    this.view.setNotice('正在读取后续内容…');
    const waiting = setTimeout(() => {
      if (this.busy && generation === this.generation) this.view.setNotice('读取仍在等待。若来源页休眠，请切到来源页等待其恢复，再返回本页；当前请求结束前不会接受新的读取请求。');
    }, 15000);
    try {
      if (!this.guidanceChecked && this.transport.guidance) {
        const guidance = await this.transport.guidance().catch(error => {
          if (error instanceof Error && ['source-frozen', 'source-discarded'].includes(error.message)) throw error;
          return undefined;
        });
        this.guidanceChecked = true;
        if (generation !== this.generation) return;
        if (guidance) {
          this.epoch = guidance.epoch;
          if (guidance.message) this.view.setLocalPrompt?.(guidance.message, []);
        }
      }
      const response = await this.transport.fetch(crypto.randomUUID(), !this.initialized || this.retryInitial);
      if (generation !== this.generation) return;
      if (response.batch.sessionId !== this.sessionId || this.epoch && this.epoch !== response.epoch) throw new Error('source-changed');
      const transaction = this.sequence.prepare(response.batch);
      if (!transaction.duplicate) {
        for (const item of response.batch.items) {
          if (item.kind !== 'image' || !item.data.resourceId || this.resources.has(item.data.resourceId)) continue;
          const id = item.data.resourceId;
          try {
            const image = await this.transport.resource(id);
            if (generation !== this.generation) return;
            if (image.epoch !== response.epoch || !/^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/.test(image.data)) continue;
            this.resources.set(id, image.data);
          } catch { /* Keep the image in place with an explicit unavailable state. */ }
        }
        if (generation !== this.generation) return;
        if (!this.view.appendBatch?.(response.batch, id => this.resources.get(id))) throw new Error('display-rejected');
        transaction.commit();
      }
      this.initialized = true; this.epoch = response.epoch; this.more = response.batch.hasMore;
      this.retryFrozen = false;
      this.retryInitial = response.batch.status === 'partial' && response.batch.items.length === 0 && response.batch.reason === 'source-not-ready';
      this.view.setNotice(this.retryInitial ? '来源正文尚未准备好。请切到来源页等待正文出现，再回到本页，通过“分享”打开面板并点击“重新连接”。若来源已刷新，请同时刷新本阅读页。'
        : response.batch.reason === 'source-suspended' ? '读取期间来源长时间暂停，已停止后续翻页。请激活并刷新来源页，再刷新本阅读页，从来源当前位置重新读取。'
        : response.batch.reason === 'chapter-access-restricted' ? '来源只开放本章试读片段，已在这里停止读取。'
        : response.batch.reason?.startsWith('fanqie-font-') ? '来源字体已变化，无法确认正文，已停止读取。'
        : response.batch.status === 'partial' ? '本次读取中途停止，已保留确认取得的内容。请检查来源页面。'
        : response.batch.status === 'end' ? '已到来源内容末尾。' : response.batch.items.length === 0 ? '本次未取得新增内容，可继续获取。' : '');
    } catch (error) {
      if (generation !== this.generation) return;
      this.more = false;
      const reason = error instanceof Error ? error.message : '';
      this.retryFrozen = reason === 'source-frozen';
      if (!this.retryFrozen) this.retryInitial = false;
      this.view.setNotice(this.retryFrozen
        ? '来源页已被冻结，尚未发送读取请求。请先切到来源页唤醒，再回到本页，通过“分享”打开面板并点击“重新连接”。'
        : reason === 'source-discarded' ? '来源页已被浏览器回收，需要重新加载。请先切到来源页等待正文出现，再刷新本阅读页；将从来源当前位置重新读取。'
        : reason === 'source-changed' ? '来源页面已重新加载，旧会话无法直接继续。请刷新本阅读页，从来源当前位置重新读取。'
        : reason === 'source-reload-required'
        ? '扩展更新后来源页面连接已失效。请先刷新来源页面，再刷新本阅读页。已显示的内容会保留。'
        : '未能确认本批内容，已暂停读取并保留现有内容。请检查来源页面。');
    } finally {
      clearTimeout(waiting);
      this.busy = false;
      this.view.setNavigation({ previous: false, next: this.connected && this.more, busy: false });
    }
  }
  disconnect(): void { this.connected = false; ++this.generation; this.resources.clear(); this.view.setNavigation({ previous: false, next: false, busy: false }); this.view.setNotice('来源已断开，已展示内容保留。'); }
  sourceLoading(): void { this.disconnect(); this.view.setNotice('来源页面已失效或正在重新加载，已展示内容保留。请切到来源页，等待来源正文出现，再刷新本阅读页，从来源当前位置重新读取。'); }
}
