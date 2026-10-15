import type { ContentBlock, ImageBlock, ReaderDocument } from '../../content-model/src/index';
import { sanitizeMarkup } from '../../content-model/src/sanitize';
import { DEFAULT_SETTINGS, displaySessionName, type SettingsV2 } from '../../storage/src/index';
import type { ContentAnchor, ViewAnchor } from '../../reader-protocol/src/index';
import { canRestoreReadingAnchor, captureReadingAnchor, restoreReadingAnchor } from './anchor';
import type { ThemeTemplate } from '../../display-sdk/src/template';
import { materializeThemeTemplate } from './template';
import type { MountedCapturedFrame } from '../../display-sdk/src/captured-document';
import { READER_CONTROLS_CSS } from './document-controls';
import { blockKinds, blockLabel, renderCapturedBlock } from './captured-content';
import { StreamSequence, type StreamBatch } from '../../content-model/src/stream';
import { itemToBlock, type ResourceResolver } from '../../content-model/src/stream-conversion';
import type { ReadingUnit } from '../../reader-protocol/src/index';
import { applyCapturedHomeLanguage, applyReaderControlsLanguage } from './captured-locale';

export type { DisplayCallbacks as ChatShellCallbacks } from '../../display-sdk/src/index';
import type { DisplayCallbacks as ChatShellCallbacks } from '../../display-sdk/src/index';
export interface ChatDisplaySkin {
  id: string;
  css: string;
  headerLabel?: string;
  sidebarToggle?: string;
  newChatIcon?: string;
  composerPlus?: string;
  composerMic?: string;
  template?: ThemeTemplate;
  allowCandidate?: boolean;
  /** Installed original document; this path never loads the legacy skin CSS. */
  documentFrame?: MountedCapturedFrame;
}
const TOPICS = ['周报内容整理', '项目方案讨论', '数据口径核对', '会议纪要优化', '摘要修改', '需求文档梳理', '季度目标回顾', '团队协作流程', '产品体验记录', '调研提纲完善', '工作计划安排', '邮件措辞优化'];
const EN_TOPICS = ['Weekly update', 'Project proposal', 'Data definitions', 'Meeting notes', 'Summary revision', 'Requirements review', 'Quarterly goals', 'Team workflow', 'Product experience', 'Research outline', 'Work plan', 'Email wording'];
const NEUTRAL: Record<string, [string, string, string[]]> = {
  '周报内容整理': ['把本周的工作进展整理成一份简洁的周报', '可以按「已完成、进行中、下周安排」三个部分组织，重点记录结果与需要协作的事项。', ['已完成：整理现有资料，确认关键需求与交付范围。', '进行中：对齐方案细节，汇总反馈并跟进待办。', '下周安排：完成阶段复盘，明确下一轮工作优先级。']],
  '数据口径核对': ['整理一下数据核对时需要确认的事项', '先统一统计范围，再检查时间与去重规则。保持口径一致，后续的对比才有参考意义。', ['确认统计周期、时区和数据更新时间。', '明确计数单位、过滤条件与去重方式。', '记录异常值的处理原则，保留可追溯的说明。']],
  '会议纪要优化': ['帮我梳理一下会议纪要的结构', '一份清楚的纪要应让没参加会议的人，也能快速了解已经达成的共识和接下来的行动。', ['先写讨论目标，再列出主要结论。', '对暂未达成共识的问题，注明需要补充的信息。', '行动项包含具体任务、负责人和预期完成时间。']]
};

/** Source-free view. All paper text and resource references stay in this instance's memory. */
export class ChatReaderShell {
  readonly host: HTMLElement = document.createElement('div');
  readonly shadow: ShadowRoot | Document;
  readonly scroller = el('main', 'scroller');
  readonly panel = el('section', 'controls');
  private readonly app = el('div', 'app');
  private readonly sidebar = el('aside', 'sidebar');
  private readonly headerTitle = el('span', 'header-title');
  private stream = el('div', 'stream');
  private documentFlowTemplate?: HTMLElement;
  private conversationList?: HTMLElement;
  private messageTemplates?: { user: HTMLElement; assistant: HTMLElement };
  private readonly status = el('p', 'reading-status');
  private document?: ReaderDocument;
  private readingView?: HTMLElement;
  private privacy = false;
  private mobileSidebarExpanded = false;
  private conversation = 'reading';
  private readingScroll = 0;
  private readingAnchor?: ViewAnchor;
  private pendingLocation?: { anchor: ContentAnchor; contentSignature: string };
  private mounted = false;
  private layoutFrame = 0;
  private layoutSize = '';
  private fontSet?: FontFaceSet;
  private layoutChanged = () => { if (this.documentFrame) this.applyAppearance(); this.queueLayoutRestore(); };
  private readingScrolled = () => {
    if (!this.isReading() || !this.readingView || !this.document || this.layoutFrame) return;
    // A resize can dispatch scroll before resize. Preserve the pre-layout anchor.
    if (this.layoutSize && this.layoutSize !== this.readingLayoutSize()) { this.queueLayoutRestore(); return; }
    if (this.scroller.scrollTop === this.readingScroll) return;
    this.rememberReadingPosition();
  };
  private scrollIntent = (event: Event) => {
    if (event.type === 'keydown' && !['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes((event as KeyboardEvent).key)) return;
    if (event.type === 'pointerdown' && event.target !== this.scroller) return;
    this.cancelLayoutRestore(); this.rememberReadingPosition();
  };
  private sourceLocation = { available: false, pendingChapter: false };
  private state: 'loading' | 'error' | 'ready' = 'loading';
  private panelFocus?: HTMLElement;
  private preview?: HTMLElement;
  private previewTrigger?: HTMLElement;
  private previewBlock?: ImageBlock;
  private modalStates = new Map<HTMLElement, { inert: boolean; aria: string | null }>();
  private mediaQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
  private modeListener = () => this.applyAppearance();
  private focusRequest = 0;
  private navigation = { previous: false, next: false, busy: false };
  private readonly skin: ChatDisplaySkin | undefined;
  private readonly documentFrame?: MountedCapturedFrame;
  private controlsStyle?: HTMLStyleElement;
  private appearanceNotice = '';
  private readingNotice = '';
  private typographyOverrides = new Set<'fontSize' | 'lineHeight' | 'contentWidth'>();
  private readonly handleRootKey = (event: Event) => this.handleKey(event as KeyboardEvent);
  private readonly handleRootClick = (event: Event) => {
    const anchor = (event.target as Element).closest?.('a[href^="#"]');
    if (!anchor || !this.readingView?.contains(anchor)) return;
    event.preventDefault();
    const sourceId = anchor.getAttribute('href')!.slice(1);
    const block = this.document?.blocks.find(b => b.sourceId === sourceId || b.id === sourceId);
    if (block) this.scrollToBlock(block.id);
  };

  constructor(private settings: SettingsV2, private callbacks: ChatShellCallbacks, skin?: ChatDisplaySkin) {
    this.skin = skin;
    this.documentFrame = skin?.documentFrame;
    if (this.documentFrame) {
      const frame = this.documentFrame;
      this.host = this.app = frame.root;
      this.shadow = document;
      this.sidebar = frame.sidebar;
      this.scroller = frame.scroller;
      // The captured chat scroller uses column-reverse so scrollTop=0 means the
      // newest message. Chapters read from their beginning, so keep its real
      // DOM/CSS and only change the local reader's flow direction.
      this.scroller.style.flexDirection = 'column';
      // Its sticky bottom fade belongs to the reverse chat flow. In chapter
      // order it sits over the middle of the body and hides table/code rows.
      // Keep the captured node in the package, but suppress it in this reader.
      const reverseFlowFade = this.scroller.querySelector<HTMLElement>('[aria-hidden="true"].sticky.bottom-0:has(.bg-gradient-to-t)');
      if (reverseFlowFade) reverseFlowFade.style.display = 'none';
      this.stream = frame.messageFlow;
      this.documentFlowTemplate = this.stream.cloneNode(false) as HTMLElement;
      for (const key of ['fontSize', 'lineHeight', 'contentWidth'] as const) if (settings[key] !== DEFAULT_SETTINGS[key]) this.typographyOverrides.add(key);
      this.conversationList = frame.conversationList;
      this.scroller.tabIndex = -1;
      this.scroller.setAttribute('aria-label', settings.displayLanguage === 'en' ? 'Conversation' : '会话内容');
      this.panel.dataset.fvReaderUi = 'controls';
      this.status.dataset.fvReaderUi = 'status';
      this.controlsStyle = document.createElement('style');
      this.controlsStyle.dataset.fvReaderControls = '';
      this.controlsStyle.textContent = READER_CONTROLS_CSS;
      document.head.append(this.controlsStyle);
      this.app.append(this.panel);
      this.stream.replaceChildren(this.status);
    } else {
    this.host.id = 'folioveil-root';
    this.host.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;inset:0!important;z-index:2147483647!important;visibility:visible!important;pointer-events:auto!important;color-scheme:light;';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = el('style'); style.textContent = STYLES + (skin?.css ?? '');
    this.shadow.append(style, this.app);
    this.app.append(this.sidebar);
    const workspace = el('div', 'workspace');
    const header = el('header', 'header');
    if (skin) {
      const toggle = button('', 'sidebar-toggle header-sidebar-toggle', () => this.toggleSidebar(), '展开侧栏');
      toggle.innerHTML = skin.sidebarToggle ?? '☰'; header.append(toggle);
    }
    header.append(this.headerTitle);
    const chevron = el('span', 'chevron', '⌄'); chevron.setAttribute('aria-hidden', 'true'); header.append(chevron);
    this.scroller.tabIndex = -1;
    this.scroller.setAttribute('aria-label', '会话内容');
    this.stream.append(this.status);
    this.scroller.append(this.stream);
    const composerWrap = el('div', 'composer-wrap');
    composerWrap.setAttribute('aria-hidden', 'true');
    const composer = el('div', 'composer');
    composer.append(el('span', 'composer-placeholder', '输入消息……'), el('span', 'send', '↑'));
    if (skin) {
      const plus = el('span', 'composer-icon'); plus.innerHTML = skin.composerPlus ?? '+';
      const mic = el('span', 'composer-icon composer-mic'); mic.innerHTML = skin.composerMic ?? '';
      composer.prepend(plus); composer.insertBefore(mic, composer.lastElementChild);
    }
    composerWrap.append(composer);
    workspace.append(header, this.scroller, composerWrap);
    this.app.append(workspace, this.panel);
    if (skin?.template) {
      const generated = materializeThemeTemplate(skin.template, document, { allowCandidate: skin.allowCandidate });
      this.messageTemplates = { user: generated.messageBranches.user.cloneNode(true) as HTMLElement, assistant: generated.messageBranches.assistant.cloneNode(true) as HTMLElement };
      this.app.remove();
      this.app = generated.root; this.app.classList.add('app', 'generated-theme');
      this.sidebar = generated.slots.sidebar; this.sidebar.classList.add('sidebar');
      this.scroller = generated.slots.scroller; this.scroller.classList.add('scroller');
      this.scroller.tabIndex = -1; this.scroller.setAttribute('aria-label', '会话内容');
      this.conversationList = generated.slots.conversationList;
      this.conversationList.classList.add('sessions'); this.conversationList.setAttribute('aria-label', '最近会话');
      const flow = generated.messageFlow;
      if (flow === this.scroller) { this.stream = el('div', 'stream'); flow.replaceChildren(this.stream); }
      else { this.stream = flow; this.stream.classList.add('stream'); this.stream.replaceChildren(); }
      generated.slots.header.classList.add('header'); generated.slots.header.append(this.headerTitle);
      const composer = generated.slots.composer;
      composer.classList.add('composer'); composer.setAttribute('aria-hidden', 'true'); composer.setAttribute('inert', '');
      composer.append(el('span', 'composer-placeholder', '输入消息……'));
      this.app.append(this.panel);
      this.shadow.append(generated.fragment);
      for (const action of this.app.querySelectorAll<HTMLElement>('[data-fv-action]')) {
        action.addEventListener('click', () => {
          switch (action.dataset.fvAction) {
            case 'toggleSidebar': this.toggleSidebar(); break;
            case 'newConversation': this.selectConversation('新任务'); break;
            case 'previous': this.navigate(-1); break;
            case 'next': this.navigate(1); break;
            case 'privacy': this.setPrivacy(!this.privacy); break;
            case 'showControls': this.togglePanel(); break;
            case 'returnSource': this.callbacks.onRestore(); break;
          }
        });
      }
    }
    }
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', '显示设置');
    this.panel.tabIndex = -1;
    this.hide(this.panel, true);
    if (!this.documentFrame) this.host.addEventListener('click', event => event.stopPropagation());
    this.shadow.addEventListener('keydown', this.handleRootKey);
    this.shadow.addEventListener('click', this.handleRootClick);
    if (this.documentFrame) for (const action of this.app.querySelectorAll<HTMLElement>('[data-fv-action]')) {
      action.addEventListener('click', event => {
        event.preventDefault();
        if (action.dataset.fvAction === 'toggleSidebar') this.toggleSidebar();
        if (action.dataset.fvAction === 'newConversation') this.selectConversation('新任务');
        if (action.dataset.fvAction === 'showControls' && !this.isPanelOpen()) this.togglePanel();
        if (action.dataset.fvAction === 'fetchMore') this.requestFetchMore();
      });
    }
    if (this.documentFrame && this.callbacks.onFetchMore) {
      const buttons = this.documentFrame.composer.querySelectorAll<HTMLButtonElement>('[data-fv-action="fetchMore"]');
      if (buttons.length !== 1) throw new Error('captured-theme:send-button-missing');
      const button = buttons[0]!;
      // The captured form can enclose the composer slot. Activate only the
      // send button's ancestor path; other controls keep their own inert flags.
      for (let node: HTMLElement | null = button; node && this.documentFrame.root.contains(node); node = node.parentElement) {
        node.removeAttribute('inert');
        if (node.localName === 'form') node.addEventListener('submit', event => event.preventDefault());
      }
      button.type = 'button'; button.setAttribute('aria-label', this.t('获取后续内容', 'Load more content')); button.disabled = true;
      this.documentFrame.composer.addEventListener('submit', event => event.preventDefault());
    }
    this.mediaQuery?.addEventListener('change', this.modeListener);
    this.applyAppearance(); this.applyLanguage(); this.renderSidebar();
  }
  mount(): void {
    if (!this.documentFrame) document.documentElement.append(this.host);
    if (this.mounted) return;
    this.mounted = true;
    this.scroller.addEventListener('scroll', this.readingScrolled, { passive: true });
    for (const event of ['wheel','touchmove','pointerdown','keydown']) this.scroller.addEventListener(event, this.scrollIntent, { passive: true });
    window.addEventListener('resize', this.layoutChanged);
    this.fontSet = document.fonts;
    this.fontSet?.addEventListener('loadingdone', this.layoutChanged);
    this.fontSet?.addEventListener('loadingerror', this.layoutChanged);
    this.rememberReadingPosition();
  }
  setDocument(value: ReaderDocument): boolean {
    // Repeated delivery of identical content keeps its deferred first location;
    // a different document or content revision must never reuse that request.
    if (this.pendingLocation && this.pendingLocation.contentSignature !== JSON.stringify(value)) this.pendingLocation = undefined;
    if (this.documentFrame) {
      const missing = [...new Set(value.blocks.flatMap(block => blockKinds(block).filter(kind => !this.documentFrame!.supportsBlock(kind))))];
      if (missing.length) {
        const message = `本地展示模板尚未齐备：${missing.map(blockLabel).join('、')}。请完成模板采集后重新连接。`;
        if (this.document) this.setNotice(message); else this.setStatus('error', message);
        return false;
      }
    }
    const sameDocument = this.document?.id === value.id;
    const anchor = sameDocument ? this.getReadingAnchor() : undefined;
    const atStart = this.readingScroll <= 0;
    if (this.documentFrame && sameDocument && this.document && this.readingView) {
      const previous = new Map(this.document.blocks.map(block => [block.id, JSON.stringify(block)]));
      const reply = this.readingView.querySelector<HTMLElement>('[data-fv-body]')!;
      const existing = new Map([...reply.children].filter(node => node.hasAttribute('data-block')).map(node => [node.id, node as HTMLElement]));
      // Prepare every changed block before touching the visible document. A
      // rejected table or template must not partially replace unread content.
      const prepared = value.blocks.map(block => {
        const node = existing.get(block.id);
        return node && previous.get(block.id) === JSON.stringify(block) ? node : this.renderBlock(block);
      });
      let cursor = reply.firstElementChild;
      for (let index = 0; index < value.blocks.length; index++) {
        const block = value.blocks[index]!, node = prepared[index]!;
        if (node === cursor) cursor = cursor.nextElementSibling;
        else reply.insertBefore(node, cursor);
        existing.delete(block.id);
      }
      while (cursor?.hasAttribute('data-block')) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
      for (const node of existing.values()) node.remove();
      const title = this.readingView.querySelector('[data-fv-title]'); if (title) title.textContent = value.title;
      const preview = this.previewBlock;
      this.document = value; this.setStatus('ready');
      if (preview) {
        const updated = value.blocks.find((block): block is ImageBlock => block.type === 'image' && block.id === preview.id);
        if (!updated) this.closePreview(false);
        else if (JSON.stringify(updated) !== JSON.stringify(preview)) {
          const trigger = this.readingView.querySelector<HTMLElement>(`[id="${escapeId(updated.id)}"] .image-trigger`);
          if (trigger) this.openPreview(updated, trigger);
        }
      }
      if (this.isReading()) {
        if (atStart) this.scroller.scrollTop = 0;
        else if (anchor) restoreReadingAnchor(this.readingView, this.scroller, value.id, anchor);
      }
      this.rememberReadingPosition();
      return true;
    }
    const readingView = this.buildReadingView(value);
    this.closePreview(false); this.closePanel(false);
    this.document = value; this.readingScroll = sameDocument ? this.readingScroll : 0; this.readingAnchor = anchor;
    this.readingView = readingView;
    this.setStatus('ready'); this.showConversation();
    return true;
  }
  private streamSequence = new StreamSequence();
  private streamReply?: HTMLElement;
  private contents?: { filename: string; units: readonly ReadingUnit[]; currentId?: string };
  private localPrompt?: HTMLElement;

  setContents(filename: string, units: readonly ReadingUnit[], currentId?: string): void {
    this.contents = { filename, units, currentId };
    if (this.conversation === 'toc') this.showConversation(); else this.renderSidebar();
  }
  setLocalPrompt(message: string, actions: Array<{ label: string; run(): void }>): void {
    this.localPrompt?.remove();
    const captured = this.documentFrame ? this.assistantMessage() : undefined;
    const box = captured?.root ?? el('section'); box.classList.add('fv-local-prompt'); box.dataset.fvReaderUi = 'local-prompt';
    const content = captured?.content ?? box;
    for (const paragraph of message.split('\n\n')) content.append(el('p', '', paragraph));
    for (const action of actions) content.append(button(action.label, '', action.run));
    this.localPrompt = box;
    if (this.isReading()) { this.stream.prepend(box); this.scroller.scrollTop = 0; }
  }
  clearLocalPrompt(): void { this.localPrompt?.remove(); this.localPrompt = undefined; }
  replaceBatch(batch: StreamBatch): boolean {
    try {
      const sequence = batch.sessionId === this.document?.id ? this.streamSequence : new StreamSequence();
      const transaction = sequence.prepare(batch);
      if (transaction.duplicate || batch.items[0]?.kind !== 'title') return false;
      const title = batch.items[0].data.text;
      const view = this.documentFlowTemplate ? this.documentFlowTemplate.cloneNode(false) as HTMLElement : el('div', 'reading-view');
      if (this.documentFrame) { view.dataset.fvReadingView = ''; view.style.paddingBottom = 'calc(var(--thread-scroll-padding-bottom, 124px) + 32px)'; }
      view.append(this.userMessage(title));
      const message = this.assistantMessage(); message.content.setAttribute('aria-label', '正文');
      const blocks: ContentBlock[] = [];
      for (const item of batch.items.slice(1)) {
        if (item.kind === 'title') throw new Error('multiple-unit-titles');
        const block = itemToBlock(item);
        if (this.documentFrame && blockKinds(block).some(kind => !this.documentFrame!.supportsBlock(kind))) throw new Error('missing-content-template');
        blocks.push(block); message.content.append(this.renderBlock(block));
      }
      view.append(message.root);
      transaction.commit();
      this.closePreview(false); this.closePanel(false); this.clearLocalPrompt();
      this.streamReply = message.content; this.readingView = view;
      this.document = { id: batch.sessionId, title, source: { kind: 'html' }, blocks, toc: [], warnings: [] };
      this.streamSequence = sequence;
      this.conversation = 'reading'; this.readingScroll = 0; this.readingAnchor = undefined;
      this.setStatus('ready'); this.showConversation(); this.scroller.scrollTop = 0; this.rememberReadingPosition();
      return true;
    } catch { this.setNotice('目标内容未能显示，已保留当前阅读单元。'); return false; }
  }

  /** Prepare the whole batch before changing the visible conversation. */
  appendBatch(batch: StreamBatch, resolve?: ResourceResolver): boolean {
    try {
      const transaction = this.streamSequence.prepare(batch);
      if (transaction.duplicate) return true;
      const blocks: ContentBlock[] = [];
      const additions: Array<{ parent: HTMLElement; node: HTMLElement }> = [];
      const first = !this.document;
      const view = this.readingView ?? (this.documentFlowTemplate ? this.documentFlowTemplate.cloneNode(false) as HTMLElement : el('div', 'reading-view'));
      if (this.documentFrame) { view.dataset.fvReadingView = ''; view.style.paddingBottom = 'calc(var(--thread-scroll-padding-bottom, 124px) + 32px)'; }
      let reply = this.streamReply;
      for (const item of batch.items) {
        if (item.kind === 'title') {
          additions.push({ parent: view, node: this.userMessage(item.data.text) });
          const message = this.assistantMessage(); reply = message.content;
          reply.setAttribute('aria-label', '正文');
          additions.push({ parent: view, node: message.root });
        } else {
          if (!reply) throw new Error('missing-chapter-title');
          const block = itemToBlock(item, resolve);
          if (this.documentFrame && blockKinds(block).some(kind => !this.documentFrame!.supportsBlock(kind))) throw new Error('missing-content-template');
          blocks.push(block); additions.push({ parent: reply, node: this.renderBlock(block) });
        }
      }
      const scroll = this.scroller.scrollTop;
      transaction.commit();
      additions.forEach(({ parent, node }) => parent.append(node));
      this.streamReply = reply; this.readingView = view;
      this.document = { id: batch.sessionId, title: this.document?.title ?? batch.items.find(item => item.kind === 'title')?.data.text ?? '阅读内容',
        source: { kind: 'html' }, blocks: [...this.document?.blocks ?? [], ...blocks], toc: [], warnings: [] };
      this.setStatus('ready');
      if (first) this.showConversation();
      this.scroller.scrollTop = scroll;
      this.rememberReadingPosition();
      return true;
    } catch {
      this.setNotice('内容批次顺序、格式或本地模板不匹配，已保留当前内容。');
      return false;
    }
  }
  setStatus(state: 'loading' | 'error' | 'ready', message?: string): void {
    if (state !== 'ready') this.pendingLocation = undefined;
    this.state = state;
    this.status.textContent = state === 'ready' ? '' : message ?? (state === 'loading' ? '正在加载内容' : '暂时无法继续，请通过操作面板重试或恢复页面。');
    this.status.hidden = state === 'ready';
    this.status.setAttribute('role', 'status');
    if (state === 'ready') this.setNotice('');
    if (state === 'error') {
      this.closePreview(false); this.document = undefined; this.readingView = undefined; this.readingScroll = 0; this.readingAnchor = undefined; this.panel.replaceChildren(); this.showConversation();
    }
    if (state !== 'ready') this.closePanel(false);
    if (!this.document) this.showConversation();
  }
  setNavigation(value: { previous: boolean; next: boolean; busy: boolean }): void {
    this.navigation = value;
    this.syncFetchControls();
    if (this.isPanelOpen()) this.renderPanel();
  }
  requestFetchMore(): void {
    if (this.isReading() && !this.preview && this.navigation.next && !this.navigation.busy) this.callbacks.onFetchMore?.();
  }
  private syncFetchControls(): void {
    const busy = this.navigation.busy && this.isReading();
    const waiting = this.t('正在获取后续内容，请稍候…', 'Loading more content, please wait…');
    if (this.callbacks.onFetchMore) for (const button of this.app.querySelectorAll<HTMLButtonElement>('[data-fv-action="fetchMore"]')) {
      button.disabled = this.navigation.busy || !this.navigation.next || !this.isReading();
      button.setAttribute('aria-busy', String(busy));
      button.setAttribute('aria-label', busy ? waiting : this.t('获取后续内容', 'Load more content'));
      button.setAttribute('aria-keyshortcuts', 'N');
      button.title = busy ? waiting : this.t('获取后续内容（N）', 'Load more content (N)');
    }
    const placeholder = this.documentFrame?.composer.querySelector('[data-composer-markdown] p[data-placeholder]');
    if (this.callbacks.onFetchMore && placeholder) placeholder.setAttribute('data-placeholder', busy ? waiting : this.t('询问 ChatGPT', 'Ask ChatGPT'));
  }
  setSourceLocation(value: { available: boolean; pendingChapter: boolean }): void {
    if (!value.available) this.pendingLocation = undefined;
    this.sourceLocation = value;
    if (this.isPanelOpen()) this.renderPanel();
  }
  getReadingAnchor(): ViewAnchor | undefined {
    if (this.readingAnchor && (this.layoutFrame || (this.scroller.scrollTop === this.readingScroll && this.layoutSize === this.readingLayoutSize()))) return this.readingAnchor;
    return this.isReading() && this.readingView && this.document
      ? captureReadingAnchor(this.readingView, this.scroller, this.document.id) : this.readingAnchor;
  }
  locate(anchor: ContentAnchor): boolean {
    this.pendingLocation = undefined;
    if (!this.readingView || !this.document || !canRestoreReadingAnchor(this.readingView, this.document.id, anchor)) return false;
    if (this.privacy) {
      // Accepted means the valid request is queued, not that private content
      // was exposed or the neutral conversation was scrolled.
      this.pendingLocation = { anchor: { ...anchor }, contentSignature: JSON.stringify(this.document) };
      return true;
    }
    this.cancelLayoutRestore();
    if (!this.isReading()) { this.conversation = 'reading'; this.showConversation(); }
    const result = restoreReadingAnchor(this.readingView, this.scroller, this.document.id, anchor);
    if (result) this.rememberReadingPosition();
    this.closePanel(false);
    return result;
  }
  setNotice(message: string): void {
    this.readingNotice = message;
    message = [message, this.appearanceNotice].filter(Boolean).join(' ');
    this.status.textContent = message; this.status.hidden = !message; this.status.setAttribute('role', 'status');
    const notice = this.panel.querySelector<HTMLElement>('.operation-status');
    if (notice) { notice.textContent = message; notice.hidden = !message; }
    if (this.conversation === 'toc' && !this.privacy && this.status.parentElement !== this.stream) this.stream.append(this.status);
    if (this.isReading()) {
      const body = this.streamReply && this.readingView?.contains(this.streamReply)
        ? this.streamReply : this.readingView?.querySelector('[data-fv-body]');
      const parent = this.documentFrame ? body ?? this.stream : this.stream;
      if (this.status.parentElement !== parent) parent.append(this.status);
    }
  }
  setPrivacy(active: boolean): void {
    if (active === this.privacy) { if (active) { this.closePanel(false); this.closePreview(false); } return; }
    this.closePreview(false); this.closePanel(false);
    if (active && this.conversation === 'reading') { this.readingAnchor = this.getReadingAnchor(); this.readingScroll = this.scroller.scrollTop; }
    this.privacy = active;
    this.panel.replaceChildren();
    window.getSelection()?.removeAllRanges();
    this.showConversation();
    if (!active && this.pendingLocation) {
      const pending = this.pendingLocation; this.pendingLocation = undefined;
      if (pending.contentSignature === JSON.stringify(this.document) && !this.locate(pending.anchor)) this.setNotice('当前位置无法定位，请返回原页核对。');
    }
    if (document.hasFocus()) this.scroller.focus({ preventScroll: true });
    this.callbacks.onPrivacyChange?.(active);
  }
  getPrivacy(): boolean { return this.privacy; }
  isPanelOpen(): boolean { return !this.panel.hidden; }
  isPreviewOpen(): boolean { return !!this.preview; }
  isReading(): boolean { return !this.privacy && this.conversation === 'reading'; }
  togglePanel(keyboard = true): void {
    if (this.isPanelOpen()) { this.closePanel(); return; }
    if (this.preview) return;
    this.panelFocus = this.shadow.activeElement as HTMLElement | undefined;
    this.renderPanel(); this.hide(this.panel, false);
    if (keyboard) this.panel.querySelector<HTMLElement>('button')?.focus();
  }
  closePanel(restoreFocus = true): void {
    if (!this.isPanelOpen()) return;
    const heldFocus = this.panel.contains(this.shadow.activeElement);
    this.hide(this.panel, true);
    this.panel.querySelectorAll('details').forEach(details => { details.open = false; });
    if (heldFocus && restoreFocus && document.hasFocus()) {
      const target = this.panelFocus?.isConnected && !this.panel.contains(this.panelFocus) ? this.panelFocus : this.scroller;
      target.focus({ preventScroll: true });
    } else if (heldFocus) (this.shadow.activeElement as HTMLElement)?.blur();
  }
  closePreview(restoreFocus = true): void {
    if (!this.preview) return;
    const trigger = this.previewTrigger;
    this.preview.remove(); this.preview = undefined; this.previewTrigger = undefined; this.previewBlock = undefined;
    this.hideReadingFromModal(false);
    if (restoreFocus && !this.privacy && trigger?.isConnected && document.hasFocus()) trigger.focus({ preventScroll: true });
  }
  navigate(input: -1 | 1 | "previous" | "next"): void {
    const direction = input === "previous" ? -1 : input === "next" ? 1 : input;
    if (!this.isReading() || this.preview || !this.document) return;
    this.cancelLayoutRestore();
    this.closePreview(false);
    if (this.callbacks.onNavigate) {
      const before = this.scroller.scrollTop;
      const height = this.scroller.clientHeight;
      if (height <= 0) return;
      const viewport = this.scroller.getBoundingClientRect();
      const composer = (this.documentFrame?.composer ?? this.shadow.querySelector<HTMLElement>('.composer-wrap,[data-fv-slot="composer"]'))?.getBoundingClientRect();
      // The decorative input can cover the bottom of the scrolling viewport.
      // Base the step on readable space so its covered lines are not skipped.
      const readable = composer && composer.height > 0 && composer.right > viewport.left && composer.left < viewport.right && composer.top < viewport.bottom && composer.bottom > viewport.top
        ? Math.min(height, Math.max(0, composer.top - viewport.top)) : height;
      const step = readable - Math.min(80, readable * .2);
      this.scroller.scrollTop = Math.max(0, Math.min(this.scroller.scrollHeight - height, before + direction * step));
      this.rememberReadingPosition();
      if (this.scroller.scrollTop === before) this.setNotice(direction === 1 ? '已到当前内容末尾。来源操作在操作面板中。' : '已到当前内容开头。');
      return;
    }
    const headings = this.document.toc.map(item => this.shadow.getElementById(item.id)).filter((n): n is HTMLElement => !!n);
    const top = this.scroller.getBoundingClientRect().top + 25;
    const target = direction === 1 ? headings.find(n => n.getBoundingClientRect().top > top + 10) : [...headings].reverse().find(n => n.getBoundingClientRect().top < top - 10);
    if (target) this.scrollToBlock(target.id);
    else { this.scroller.scrollTop = direction === 1 ? this.scroller.scrollHeight : 0; this.rememberReadingPosition(); }
  }
  updateSettings(next: SettingsV2): void {
    const previous = this.settings;
    if (this.documentFrame) for (const key of ['fontSize', 'lineHeight', 'contentWidth'] as const) if (next[key] !== previous[key]) this.typographyOverrides.add(key);
    const anchor = this.getReadingAnchor();
    this.cancelLayoutRestore();
    const scroll = this.scroller.scrollTop;
    if (previous.imageMode !== next.imageMode) this.closePreview(false);
    this.settings = next;
    this.applyAppearance(); this.applyLanguage(); this.renderSidebar();
    if (previous.displayLanguage !== next.displayLanguage && !this.isReading()) this.showConversation();
    if (previous.imageMode !== next.imageMode && this.document && this.readingView) {
      for (const block of this.document.blocks) {
        if (block.type !== 'image') continue;
        this.readingView.querySelector(`[id="${escapeId(block.id)}"]`)?.replaceWith(this.renderBlock(block));
      }
    }
    if (this.isPanelOpen()) {
      const active = this.shadow.activeElement as HTMLElement | null;
      const key = active?.dataset.setting;
      // Keep range/select nodes alive while they are being operated.
      this.panel.querySelectorAll<HTMLElement>('[data-image-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.imageMode === next.imageMode)));
      if (!key || previous.displayLanguage !== next.displayLanguage) this.renderPanel();
      else this.panel.querySelectorAll<HTMLOutputElement>('output[data-for]').forEach(output => {
        const field = output.dataset.for as 'fontSize' | 'contentWidth' | 'lineHeight'; output.value = String(next[field]);
      });
    }
    if (this.isReading() && scroll <= 0) this.scroller.scrollTop = 0;
    else if (anchor && this.readingView && this.document && this.isReading()) {
      if (!restoreReadingAnchor(this.readingView, this.scroller, this.document.id, anchor) &&
        !restoreReadingAnchor(this.readingView, this.scroller, this.document.id, { ...anchor, offset: 0, viewportOffset: 8 })) this.scroller.scrollTop = scroll;
    }
    else if (this.isReading()) this.scroller.scrollTop = scroll;
    if (this.isReading()) this.rememberReadingPosition(); else this.readingAnchor = anchor;
  }
  unmount(): void {
    this.pendingLocation = undefined;
    this.mounted = false; this.cancelLayoutRestore();
    this.scroller.removeEventListener('scroll', this.readingScrolled);
    for (const event of ['wheel','touchmove','pointerdown','keydown']) this.scroller.removeEventListener(event, this.scrollIntent);
    window.removeEventListener('resize', this.layoutChanged);
    this.fontSet?.removeEventListener('loadingdone', this.layoutChanged);
    this.fontSet?.removeEventListener('loadingerror', this.layoutChanged);
    cancelAnimationFrame(this.focusRequest); this.closePreview(false); this.mediaQuery?.removeEventListener('change', this.modeListener);
    this.shadow.removeEventListener('keydown', this.handleRootKey);
    this.shadow.removeEventListener('click', this.handleRootClick);
    this.controlsStyle?.remove();
    if (this.documentFrame) this.documentFrame.dispose(); else this.host.remove();
    this.document = undefined; this.readingView = undefined; this.panelFocus = undefined;
  }
  private readingLayoutSize(): string {
    return `${window.innerWidth}:${window.innerHeight}:${this.scroller.clientWidth}:${this.scroller.clientHeight}:${this.documentFrame ? this.scroller.scrollHeight : this.readingView?.getBoundingClientRect().height ?? 0}`;
  }
  private rememberReadingPosition(): void {
    if (!this.mounted || !this.isReading() || !this.readingView?.isConnected || !this.document) return;
    this.readingScroll = this.scroller.scrollTop;
    this.readingAnchor = captureReadingAnchor(this.readingView, this.scroller, this.document.id);
    this.layoutSize = this.readingLayoutSize();
  }
  private cancelLayoutRestore(): void {
    if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = 0;
  }
  private queueLayoutRestore(): void {
    if (this.layoutFrame || !this.mounted || !this.isReading() || !this.readingView?.isConnected || !this.document || !this.readingAnchor) return;
    const view = this.readingView, documentId = this.document.id, anchor = this.readingAnchor;
    const atStart = this.readingScroll <= 0;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = 0;
      if (!this.mounted || !this.isReading() || this.readingView !== view || this.document?.id !== documentId) return;
      // The title and original frame can reflow before the first body block.
      // At the document start the viewport boundary is authoritative; restoring
      // that body's old pixel offset would scroll an untouched first screen.
      if (atStart) { this.scroller.scrollTop = 0; this.rememberReadingPosition(); return; }
      if (restoreReadingAnchor(view, this.scroller, documentId, anchor)) {
        // The restored character can now be in the middle of a wrapped line.
        // Keep that character, not the newly visible line's earlier first one.
        this.readingScroll = this.scroller.scrollTop;
        this.layoutSize = this.readingLayoutSize();
      } else this.rememberReadingPosition();
    });
  }
  private buildReadingView(value: ReaderDocument): HTMLElement {
    const view = this.documentFlowTemplate ? this.documentFlowTemplate.cloneNode(false) as HTMLElement : el('div', 'reading-view');
    if (this.documentFrame) {
      view.dataset.fvReadingView = '';
      // The captured composer overlays the bottom of its chat scroller. Give
      // the final chapter block enough local scroll room to clear it.
      view.style.paddingBottom = 'calc(var(--thread-scroll-padding-bottom, 124px) + 32px)';
    }
    view.append(this.userMessage(value.title));
    const reply = this.assistantMessage(); reply.content.setAttribute('aria-label', this.t('正文', 'Response'));
    for (const block of value.blocks) reply.content.append(this.renderBlock(block));
    const end = el('div', 'end-note', this.callbacks.onNavigate ? this.t('当前已加载内容的末尾', 'End of loaded content') : this.t('已到末尾', 'End of content'));
    if (this.documentFrame) end.dataset.fvReaderUi = 'end';
    if (this.documentFrame) { reply.content.append(end); view.append(reply.root); }
    else view.append(reply.root, end);
    return view;
  }
  private userMessage(text: string): HTMLElement {
    if (this.documentFrame) {
      const message = this.documentFrame.cloneMessage('user');
      message.content.replaceChildren(document.createTextNode(text));
      message.content.dataset.fvTitle = '';
      applyCapturedHomeLanguage(message.root, this.settings.displayLanguage);
      this.applyMessageTypography(message.root);
      return message.root;
    }
    const root = this.messageTemplates ? this.messageTemplates.user.cloneNode(true) as HTMLElement : el('div', 'title-bubble');
    const title = root.matches('[data-fv-slot="userMessage"]') ? root : root.querySelector<HTMLElement>('[data-fv-slot="userMessage"]') ?? root;
    title.classList.add('title-bubble'); title.replaceChildren(document.createTextNode(text)); return root;
  }
  private assistantMessage(): { root: HTMLElement; content: HTMLElement } {
    if (this.documentFrame) {
      const message = this.documentFrame.cloneMessage('assistant');
      message.content.replaceChildren(); message.content.dataset.fvBody = '';
      applyCapturedHomeLanguage(message.root, this.settings.displayLanguage);
      this.applyMessageTypography(message.root);
      return message;
    }
    const root = this.messageTemplates ? this.messageTemplates.assistant.cloneNode(true) as HTMLElement : el('article', 'reply');
    const content = root.matches('[data-fv-slot="assistantMessage"]') ? root : root.querySelector<HTMLElement>('[data-fv-slot="assistantMessage"]') ?? root;
    content.classList.add('reply'); content.replaceChildren(); return { root, content };
  }
  private renderBlock(block: ContentBlock): HTMLElement {
    if (this.documentFrame) return this.renderCapturedBlock(block);
    let node: HTMLElement;
    switch (block.type) {
      case 'paragraph': case 'quote': case 'heading': {
        const tag = block.type === 'heading' ? `h${Math.max(2, Math.min(6, block.level))}` : block.type === 'quote' ? 'blockquote' : 'p';
        node = el(tag); node.append(sanitizeMarkup(block.html, document)); break;
      }
      case 'list': {
        node = el(block.ordered ? 'ol' : 'ul');
        block.items.forEach(item => { const li = el('li'); li.append(sanitizeMarkup(item, document)); node.append(li); }); break;
      }
      case 'code': { node = el('pre', 'code'); node.append(el('code', '', block.text)); break; }
      case 'math': { node = el('div', 'math-block'); node.append(sanitizeMarkup(block.html, document)); if (!node.textContent?.trim()) node.textContent = block.text; break; }
      case 'table': {
        node = el('figure', 'table-block'); const viewport = el('div', 'table-scroll'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', '表格，可横向滚动'); viewport.append(sanitizeMarkup(block.html, document)); node.append(viewport);
        if (block.caption || block.captionHtml) { const caption = el('figcaption'); if (block.captionHtml) caption.append(sanitizeMarkup(block.captionHtml, document)); else caption.textContent = block.caption ?? ''; node.append(caption); } break;
      }
      case 'image': {
        node = el('figure', `image-block mode-${this.settings.imageMode}`);
        const button = el('button', 'image-trigger') as HTMLButtonElement; button.type = 'button'; button.setAttribute('aria-haspopup', 'dialog');
        if (this.settings.imageMode === 'hidden') button.textContent = `【${block.label} · 点击查看】`;
        else {
          if (block.src) {
            const img = document.createElement('img'); img.src = block.src; img.alt = block.label; img.loading = 'lazy';
            img.addEventListener('load', () => { if (this.readingView?.contains(img)) this.queueLayoutRestore(); });
            img.addEventListener('error', () => { const reading = this.readingView?.contains(img); img.remove(); if (!button.querySelector('.image-failed')) button.append(el('span', 'image-failed', '暂时无法显示 · 点击重试')); if (reading) this.queueLayoutRestore(); }); button.append(img);
          }
          button.append(el('span', 'image-label', `${block.label} · 点击查看`));
        }
        button.addEventListener('click', () => { if (this.isReading()) this.openPreview(block, button); });
        node.append(button);
        if (this.settings.imageMode === 'full' && (block.caption || block.captionHtml)) { const caption = el('figcaption'); if (block.captionHtml) caption.append(sanitizeMarkup(block.captionHtml, document)); else caption.textContent = block.caption ?? ''; node.append(caption); }
        break;
      }
    }
    node.id = block.id; node.dataset.block = 'true'; node.dataset.blockType = block.type;
    return node;
  }
  private renderCapturedBlock(block: ContentBlock): HTMLElement {
    const node = renderCapturedBlock(this.documentFrame!, block, {
      imageMode: this.settings.imageMode,
      onPreview: (image, trigger) => { if (this.isReading()) this.openPreview(image, trigger); },
      onImageLayout: element => { if (this.readingView?.contains(element)) this.queueLayoutRestore(); },
      onCopyFailure: () => this.setNotice('无法访问剪贴板，请选择正文后复制。')
    });
    if (block.type === 'code') {
      for (const element of node.querySelectorAll<HTMLElement>('div')) for (const child of element.childNodes) {
        if (child.nodeType === 3 && child.textContent?.trim() === 'Code') child.textContent = this.t('代码', 'Code');
      }
      for (const button of node.querySelectorAll<HTMLButtonElement>('button')) {
        const label = button.getAttribute('aria-label');
        if (label === 'Enable word wrap') button.setAttribute('aria-label', this.t('启用自动换行', 'Enable word wrap'));
        if (label === 'Copy') button.setAttribute('aria-label', this.t('复制', 'Copy'));
      }
    }
    return node;
  }
  private showConversation(): void {
    this.cancelLayoutRestore();
    this.syncFetchControls();
    if (this.documentFrame) {
      const next = this.isReading() && this.readingView ? this.readingView
        : this.isReading() ? this.documentFlowTemplate!.cloneNode(false) as HTMLElement : this.conversation === 'toc' && this.contents ? this.contentsView() : this.neutralView();
      if (this.isReading()) {
        (this.streamReply && next.contains(this.streamReply) ? this.streamReply : next.querySelector('[data-fv-body]') ?? next).append(this.status);
        if (this.localPrompt) next.prepend(this.localPrompt);
        if (this.state === 'error') next.append(this.recoveryControls());
      }
      if (next !== this.stream) { this.stream.replaceWith(next); this.stream = next; }
      this.renderSidebar();
      this.scroller.scrollTop = this.isReading() ? this.readingScroll : 0;
      if (this.isReading() && this.readingScroll > 0 && this.readingView && this.readingAnchor && this.document) restoreReadingAnchor(this.readingView, this.scroller, this.document.id, this.readingAnchor);
      this.rememberReadingPosition(); return;
    }
    this.stream.replaceChildren();
    this.renderSidebar();
    if (this.isReading() && this.readingView) {
      this.stream.append(...(this.localPrompt ? [this.localPrompt] : []), this.readingView, this.status);
      this.scroller.scrollTop = this.readingScroll;
      if (this.readingScroll > 0 && this.readingAnchor && this.document && !restoreReadingAnchor(this.readingView, this.scroller, this.document.id, this.readingAnchor))
        restoreReadingAnchor(this.readingView, this.scroller, this.document.id, { ...this.readingAnchor, offset: 0, viewportOffset: 8 });
    } else if (this.isReading()) {
      this.stream.append(this.status);
      if (this.localPrompt) this.stream.prepend(this.localPrompt);
      if (this.state === 'error') {
        const recovery = el('div', 'recovery');
        if (this.documentFrame) recovery.dataset.fvReaderUi = 'recovery';
        if (this.callbacks.onRetry) recovery.append(button('重新连接', '', () => this.callbacks.onRetry?.()));
        if (this.callbacks.onReloadSource) recovery.append(button('刷新来源', '', () => this.callbacks.onReloadSource?.()));
        recovery.append(button('返回原阅读页', '', () => this.callbacks.onRestore()));
        this.stream.append(recovery);
      }
    }
    else { this.stream.append(this.conversation === 'toc' && this.contents ? this.contentsView() : this.neutralView()); this.scroller.scrollTop = 0; }
    this.rememberReadingPosition();
  }
  private recoveryControls(): HTMLElement {
    const recovery = el('div', 'recovery'); recovery.dataset.fvReaderUi = 'recovery';
    if (this.callbacks.onRetry) recovery.append(button('重新连接', '', () => this.callbacks.onRetry?.()));
    if (this.callbacks.onReloadSource) recovery.append(button('刷新来源', '', () => this.callbacks.onReloadSource?.()));
    recovery.append(button('返回原阅读页', '', () => this.callbacks.onRestore())); return recovery;
  }
  private neutralView(): HTMLElement {
    const topic = this.conversation === 'reading' ? displaySessionName(this.settings) : this.conversation;
    const englishTopic = EN_TOPICS[TOPICS.indexOf(topic)] ?? (topic === '新任务' ? 'the next steps' : topic);
    const data = this.settings.displayLanguage === 'en'
      ? [`Help me organize ${englishTopic.toLowerCase()}`, 'Start with the goal, current progress, and next steps. Here is a short outline for discussion.', ['Define the goal and expected result.', 'Summarize progress and open questions.', 'Assign the next actions and leave time for feedback.']] as [string, string, string[]]
      : NEUTRAL[topic] ?? [`梳理一下${topic === '新任务' ? '接下来的工作安排' : topic}`, '可以先把目标、当前进展和下一步行动分开整理，再按优先级逐项推进。下面是一份便于讨论和补充的工作提纲。', ['明确目标：对齐本阶段需要完成的事项和预期结果。', '整理进展：汇总已有资料，记录仍需确认的问题。', '安排协作：拆分具体行动，预留反馈与调整的时间。']];
    const view = this.documentFlowTemplate ? this.documentFlowTemplate.cloneNode(false) as HTMLElement : el('div', 'neutral-view');
    if (this.documentFrame) {
      view.dataset.fvNeutralView = '';
      view.append(this.userMessage(data[0]));
      const message = this.assistantMessage();
      if (this.documentFrame.supportsBlock('paragraph')) message.content.append(this.renderCapturedBlock({ id: 'neutral-intro', type: 'paragraph', html: escapeHTML(data[1]) }));
      if (this.documentFrame.supportsBlock('orderedList') && this.documentFrame.supportsBlock('listItem')) message.content.append(this.renderCapturedBlock({ id: 'neutral-items', type: 'list', ordered: true, items: data[2].map(escapeHTML) }));
      view.append(message.root); return view;
    }
    view.append(this.userMessage(data[0]));
    const message = this.assistantMessage(); const reply = message.content; reply.append(el('p', '', data[1]), el('h2', '', '先明确这三个方面'));
    const list = el('ol'); data[2].forEach(text => list.append(el('li', '', text))); reply.append(list);
    reply.append(el('h2', '', '接下来的安排'), el('p', '', '先完成信息收集与初步整理，再集中讨论关键问题。将需要他人配合的事项提前同步，减少反复确认。'));
    const table = el('table'); table.innerHTML = '<thead><tr><th>阶段</th><th>重点事项</th><th>预期结果</th></tr></thead><tbody><tr><td>准备</td><td>整理资料与问题</td><td>形成讨论提纲</td></tr><tr><td>推进</td><td>对齐方案与分工</td><td>明确行动项</td></tr><tr><td>回顾</td><td>汇总反馈与进展</td><td>更新下一步安排</td></tr></tbody>';
    reply.append(table, el('p', '', '每一轮结束后保留一份简洁记录，方便后续跟进。')); view.append(message.root); return view;
  }
  private renderSidebar(): void {
    if (this.documentFrame) {
      const items = TOPICS.map((topic, index) => {
        const name = index === 1 ? displaySessionName(this.settings) : this.settings.displayLanguage === 'en' ? EN_TOPICS[index]! : topic;
        const key = index === 1 ? 'reading' : index === 0 && this.contents ? 'toc' : name;
        const item = this.documentFrame!.cloneSidebarItem();
        item.content.textContent = name;
        item.root.dataset.fvTopic = key;
        const action = item.content.closest('a') ?? item.root;
        const selected = this.conversation === key;
        const row = item.root.querySelector<HTMLElement>('.sidebar-item');
        // The captured template is the selected source row. Clear that exact
        // source class on other cloned rows, keeping its original hover rules.
        row?.classList.toggle('bg-primary-ghost-hover', selected);
        if (selected) row?.setAttribute('aria-current', 'page'); else row?.removeAttribute('aria-current');
        // Both captured states use this original link attribute for selection;
        // aria-current on its outer <li> does not drive the original CSS.
        action.toggleAttribute('data-active', selected);
        action.setAttribute('aria-current', selected ? 'page' : 'false');
        action.setAttribute('role', 'button'); action.tabIndex = 0;
        action.title = key === 'reading'
          ? this.t('实际阅读内容', 'Your reading content')
          : key === 'toc' ? this.t('本地 TXT 目录', 'Local TXT contents') : name;
        action.removeAttribute('href');
        item.root.addEventListener('click', event => { event.preventDefault(); this.selectConversation(key); });
        item.root.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.selectConversation(key); } });
        return item.root;
      });
      this.documentFrame.conversationList.replaceChildren(...items);
      return;
    }
    if (!this.conversationList) this.sidebar.replaceChildren();
    const top = el('div', 'sidebar-top');
    if (this.skin) {
      const bar = el('div', 'sidebar-brand'); bar.append(el('span', 'brand-name', this.skin.headerLabel ?? this.settings.sessionName));
      const toggle = button('', 'sidebar-toggle', () => this.toggleSidebar(), '收起侧栏');
      toggle.innerHTML = this.skin.sidebarToggle ?? '☰'; bar.append(toggle); top.append(bar);
    }
    const newChat = button(this.skin ? '新聊天' : '新任务', 'new-chat', () => this.selectConversation('新任务'));
    if (this.skin?.newChatIcon) { const icon = el('span', 'nav-icon'); icon.innerHTML = this.skin.newChatIcon; newChat.prepend(icon); }
    top.append(newChat);
    const links = el('div', 'sidebar-links');
    links.append(button('资料', '', () => this.selectConversation('资料整理')), button('项目', '', () => this.selectConversation('项目规划'))); top.append(links);
    const nav = el('nav', 'sessions'); nav.setAttribute('aria-label', '最近会话'); nav.append(el('div', 'section-label', '最近'));
    TOPICS.forEach((topic, index) => {
      const isReading = index === 1; const name = isReading ? this.settings.sessionName : topic;
      const key = isReading ? 'reading' : index === 0 && this.contents ? 'toc' : name;
      const active = this.conversation === key;
      const item = button(name, `session${active ? ' active' : ''}`, () => this.selectConversation(key));
      item.setAttribute('aria-current', active ? 'page' : 'false');
      item.title = key === 'reading' ? this.t('实际阅读内容', 'Your reading content') : key === 'toc' ? this.t('本地 TXT 目录', 'Local TXT contents') : name;
      nav.append(item);
    });
    const bottom = el('div', 'sidebar-bottom'); const avatar = el('span', 'avatar', 'W'); avatar.setAttribute('aria-hidden', 'true'); bottom.append(avatar, el('span', '', '个人工作区'));
    if (this.conversationList) this.conversationList.replaceChildren(...nav.childNodes);
    else this.sidebar.append(top, nav, bottom);
    this.headerTitle.textContent = this.skin?.headerLabel ?? (this.conversation === 'reading' ? this.settings.sessionName : this.conversation);
  }
  private toggleSidebar(): void {
    // The captured frame owns its responsive layout. Its state must not depend
    // on the separate mobile drawer flag used by the historical skin.
    if (this.documentFrame) { this.patch({ sidebarCollapsed: !this.settings.sidebarCollapsed }); return; }
    const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
    this.patch({ sidebarCollapsed: narrow ? this.mobileSidebarExpanded : !this.settings.sidebarCollapsed });
  }
  private selectConversation(name: string): void {
    this.closePreview(false); this.closePanel(false);
    if (this.isReading()) { this.readingAnchor = this.getReadingAnchor(); this.readingScroll = this.scroller.scrollTop; }
    this.conversation = name; this.mobileSidebarExpanded = false; this.applyAppearance(); this.showConversation();
  }
  private contentsView(): HTMLElement {
    const view = this.documentFlowTemplate ? this.documentFlowTemplate.cloneNode(false) as HTMLElement : el('div', 'reading-view');
    view.dataset.fvReaderUi = 'contents-view';
    const box = el('section', 'fv-contents');
    box.append(el('h2', '', this.contents!.filename));
    const back = button('返回阅读', '', () => this.selectConversation('reading'));
    box.append(back);
    const list = el('div', 'fv-contents-list'); list.setAttribute('role', 'list');
    for (const unit of this.contents!.units) {
      const row = button(unit.title, '', () => this.callbacks.onSelectUnit?.(unit.id));
      row.dataset.unitId = unit.id;
      if (unit.id === this.contents!.currentId) { row.setAttribute('aria-current', 'true'); row.append(el('span', '', ' · 当前')); }
      list.append(row);
    }
    box.append(list); view.append(box, this.status); return view;
  }
  private applyAppearance(): void {
    if (this.documentFrame) {
      const colorScheme = this.settings.colorScheme === 'system' ? (this.mediaQuery?.matches ? 'dark' : 'light') : this.settings.colorScheme;
      const result = this.documentFrame.applyAppearance({ colorScheme, sidebarCollapsed: this.settings.sidebarCollapsed });
      this.appearanceNotice = result.missing.length ? this.t('此展示状态尚未采集，当前保留已采集的原框架。', 'This appearance has not been captured yet. The captured frame remains in use.') : '';
      if (this.state === 'ready') this.setNotice(this.readingNotice);
      this.panel.dataset.corner = this.settings.hotzoneCorner;
      if (this.readingView) this.applyMessageTypography(this.readingView);
      if (this.stream !== this.readingView) this.applyMessageTypography(this.stream);
      return;
    }
    this.app.dataset.scheme = this.settings.colorScheme === 'system' ? (this.mediaQuery?.matches ? 'dark' : 'light') : this.settings.colorScheme;
    this.app.dataset.sidebar = this.settings.sidebarCollapsed ? 'collapsed' : 'expanded';
    this.app.dataset.mobileSidebar = this.mobileSidebarExpanded ? 'expanded' : 'collapsed';
    this.app.style.setProperty('--font-size', `${this.settings.fontSize}px`);
    this.app.style.setProperty('--line-height', String(this.settings.lineHeight));
    this.app.style.setProperty('--content-width', `${this.settings.contentWidth}px`);
    this.panel.dataset.corner = this.settings.hotzoneCorner;
  }
  private t(zh: string, en: string): string { return this.settings.displayLanguage === 'en' ? en : zh; }
  private applyLanguage(): void {
    if (!this.documentFrame) return;
    this.documentFrame.root.ownerDocument.documentElement.lang = this.settings.displayLanguage === 'en' ? 'en' : 'zh-CN';
    applyCapturedHomeLanguage(this.documentFrame.root, this.settings.displayLanguage);
    this.scroller.setAttribute('aria-label', this.t('会话内容', 'Conversation'));
    this.syncFetchControls();
    this.panel.setAttribute('aria-label', this.t('显示设置', 'Display settings'));
    this.readingView?.querySelector<HTMLElement>('[data-fv-body]')?.setAttribute('aria-label', this.t('正文', 'Response'));
    for (const end of this.app.querySelectorAll<HTMLElement>('.end-note')) {
      end.textContent = this.callbacks.onNavigate ? this.t('当前已加载内容的末尾', 'End of loaded content') : this.t('已到末尾', 'End of content');
    }
    for (const block of this.app.querySelectorAll<HTMLElement>('[data-block-type="code"]')) {
      for (const element of block.querySelectorAll<HTMLElement>('div')) for (const child of element.childNodes) {
        if (child.nodeType === 3 && ['Code', '代码'].includes(child.textContent?.trim() ?? '')) child.textContent = this.t('代码', 'Code');
      }
      for (const button of block.querySelectorAll<HTMLButtonElement>('button')) {
        const label = button.getAttribute('aria-label');
        if (label === 'Enable word wrap' || label === '启用自动换行') button.setAttribute('aria-label', this.t('启用自动换行', 'Enable word wrap'));
        if (label === 'Copy' || label === '复制') button.setAttribute('aria-label', this.t('复制', 'Copy'));
      }
    }
  }
  private applyMessageTypography(root: HTMLElement): void {
    if (!this.documentFrame) return;
    for (const body of root.querySelectorAll<HTMLElement>('[data-fv-body]')) {
      if (this.typographyOverrides.has('fontSize')) body.style.fontSize = `${this.settings.fontSize}px`;
      if (this.typographyOverrides.has('lineHeight')) body.style.lineHeight = String(this.settings.lineHeight);
    }
    if (this.typographyOverrides.has('contentWidth')) for (const column of root.querySelectorAll<HTMLElement>('[data-fv-content-width]')) {
      column.style.setProperty('--thread-content-max-width', `${this.settings.contentWidth}px`);
      column.style.setProperty('--thread-content-width', `${this.settings.contentWidth}px`);
    }
  }
  private renderPanel(): void {
    const activeControl = this.shadow.activeElement as HTMLElement | null;
    const focusedSetting = activeControl?.dataset.setting;
    const focusedImageMode = activeControl?.dataset.imageMode;
    const expandedGroups = new Set([...this.panel.querySelectorAll<HTMLDetailsElement>('details[data-fv-panel-group][open]')].map(group => group.dataset.fvPanelGroup));
    this.panel.replaceChildren();
    const header = el('div', 'panel-header'); header.append(el('strong', '', '显示设置'), button('×', 'panel-close', () => this.closePanel(), '收起操作面板')); this.panel.append(header);
    if (!this.privacy) {
      const images = el('fieldset', 'setting-group'); images.append(el('legend', '', '图片展示'));
      const choices = el('div', 'segments');
      (['hidden', 'thumbnail', 'full'] as const).forEach((mode, i) => {
        const item = button(['禁止展示图片', '展示缩略图', '全图展示'][i]!, '', () => this.patch({ imageMode: mode }));
        item.dataset.imageMode = mode; item.setAttribute('aria-pressed', String(this.settings.imageMode === mode)); choices.append(item);
      }); images.append(choices, el('p', 'help', '禁止模式仍可点击文字标记临时查看。原站可能已加载图片资源。')); this.panel.append(images);
      const navigation = el('div', 'panel-navigation');
      const previous = button(this.callbacks.onNavigate ? '上一章' : '上一段', '', () => this.callbacks.onNavigate ? this.callbacks.onNavigate('previous') : this.navigate(-1));
      const next = button(this.callbacks.onNavigate ? '下一章' : '下一段', '', () => this.callbacks.onNavigate ? this.callbacks.onNavigate('next') : this.navigate(1));
      if (this.callbacks.onNavigate) { previous.disabled = this.navigation.busy || !this.navigation.previous; next.disabled = this.navigation.busy || !this.navigation.next; }
      navigation.append(previous, next); this.panel.append(navigation);
      if (this.callbacks.onLocateSource) {
        const locate = button(this.sourceLocation.pendingChapter ? '切换并定位到来源章节' : '定位到来源', 'panel-action', () => this.callbacks.onLocateSource?.());
        locate.disabled = !this.sourceLocation.available || this.navigation.busy;
        this.panel.append(locate, el('p', 'help', '左右键在章内滚动；上一章／下一章在加载成功后从章首展示。'));
      }
      const notice = el('p', 'help operation-status', this.status.textContent ?? ''); notice.hidden = !notice.textContent; notice.setAttribute('role', 'status'); this.panel.append(notice);
      if (this.document?.toc.length) {
        const toc = el('details', 'panel-details'); toc.dataset.fvPanelGroup = 'toc'; toc.append(el('summary', '', '内容目录'));
        const tocList = el('div', 'toc-list');
        this.document.toc.forEach(item => { const b = button(item.label, '', () => { this.scrollToBlock(item.id); this.closePanel(); }); b.style.paddingLeft = `${Math.max(0, item.level - 2) * 10 + 8}px`; tocList.append(b); });
        toc.append(tocList); this.panel.append(toc);
      }
    }
    const typography = el('details', 'panel-details'); typography.dataset.fvPanelGroup = 'typography'; typography.append(el('summary', '', '排版与外观'));
    const form = el('div', 'settings-form');
    if (this.documentFrame) form.append(el('p', 'help', '默认沿用当前外观的排版；调整只作用于阅读内容。'));
    form.append(this.range('字号', 'fontSize', 14, 26, 1), this.range('行距', 'lineHeight', 1.4, 2.2, 0.05), this.range('正文宽度', 'contentWidth', 560, 1000, 20));
    form.append(this.select('界面主题', 'colorScheme', [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']]));
    form.append(this.checkbox('收起侧栏', 'sidebarCollapsed'));
    if (!this.privacy && !this.skin) form.append(this.checkbox('标签标题与图标伪装', 'disguiseTab'));
    const name = document.createElement('input'); name.type = 'text'; name.maxLength = 40; name.value = this.settings.sessionName; name.dataset.setting = 'sessionName'; name.setAttribute('aria-label', '会话显示名称'); name.addEventListener('change', () => this.patch({ sessionName: name.value.trim() || '项目方案讨论' }));
    const nameLabel = el('label', 'setting-row', '会话显示名称'); nameLabel.append(name); form.append(nameLabel); typography.append(form); this.panel.append(typography);
    const interaction = el('details', 'panel-details'); interaction.dataset.fvPanelGroup = 'interaction'; interaction.append(el('summary', '', '快捷键与唤出方式'));
    const interactionForm = el('div', 'settings-form');
    interactionForm.append(el('p', 'help', '操作面板：Alt + Shift + O\n快速隐私：Alt + Shift + P\nmacOS 使用 Control + Shift。扩展快捷键可在浏览器的扩展管理页修改。'));
    if (this.callbacks.onFetchMore) interactionForm.append(el('p', 'help', this.t('获取后续内容：N。执行中重复按键无效，长按只触发一次；输入文字时不触发。', 'Load more content: N. Repeated requests are ignored while loading. Hold triggers once; typing does not trigger loading.')));
    interactionForm.append(this.checkbox('鼠标热区唤出', 'hotzoneEnabled'), this.select('热区位置', 'hotzoneCorner', [['top-right', '右上角'], ['top-left', '左上角'], ['bottom-right', '右下角'], ['bottom-left', '左下角']]), this.range('停留时间（毫秒）', 'hotzoneDelay', 300, 1500, 100), this.range('收起延迟（毫秒）', 'panelHideDelay', 300, 1500, 100), this.checkbox('失焦自动遮挡', 'autoPrivacy'), this.checkbox('左右键导航', 'arrowNavigation'));
    interaction.append(interactionForm); this.panel.append(interaction);
    if (!this.privacy && this.document) {
      const source = el('details', 'panel-details'); source.dataset.fvPanelGroup = 'source'; source.append(el('summary', '', '来源信息'));
      source.append(el('p', 'source-info', this.document.source.label ?? '当前文档'));
      if (this.document.source.url) source.append(el('p', 'source-info', this.document.source.url));
      if (this.document.warnings.length) source.append(el('p', 'help', '部分内容可能无法完整转换，请在恢复原页面后核对。'));
      this.panel.append(source);
    }
    if (this.callbacks.onChooseFile && !this.privacy) this.panel.append(button('选择 TXT 文件', 'panel-action', () => this.callbacks.onChooseFile?.()));
    if (this.callbacks.onReDecode && !this.privacy) this.panel.append(button('重新选择编码', 'panel-action', () => this.callbacks.onReDecode?.()));
    if (this.callbacks.onRetry && !this.privacy) this.panel.append(button('重新连接', 'panel-action', () => this.callbacks.onRetry?.()));
    if (this.callbacks.onReloadSource && !this.privacy) this.panel.append(button('刷新来源', 'panel-action', () => this.callbacks.onReloadSource?.()));
    const actions = el('div', 'panel-actions');
    actions.append(button(this.privacy ? '继续' : '快速隐私', 'panel-primary', () => this.setPrivacy(!this.privacy)), button(this.callbacks.onNavigate ? '返回原阅读页' : '恢复原页面', 'restore', () => this.callbacks.onRestore())); this.panel.append(actions);
    for (const group of this.panel.querySelectorAll<HTMLDetailsElement>('details[data-fv-panel-group]')) group.open = expandedGroups.has(group.dataset.fvPanelGroup);
    if (focusedSetting) this.panel.querySelector<HTMLElement>(`[data-setting="${focusedSetting}"]`)?.focus();
    else if (focusedImageMode) this.panel.querySelector<HTMLElement>(`[data-image-mode="${focusedImageMode}"]`)?.focus();
    if (this.documentFrame) applyReaderControlsLanguage(this.panel, this.settings.displayLanguage);
  }
  private range(label: string, key: 'fontSize' | 'lineHeight' | 'contentWidth' | 'hotzoneDelay' | 'panelHideDelay', min: number, max: number, step: number): HTMLElement {
    const value = this.typographyDisplayValue(key);
    const row = el('label', 'range-row'); const heading = el('span', 'range-label', label); const output = document.createElement('output'); output.value = String(value); output.dataset.for = key; heading.append(output);
    const input = document.createElement('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value); input.dataset.setting = key; input.setAttribute('aria-label', label);
    input.addEventListener('input', () => this.patch({ [key]: Number(input.value) })); row.append(heading, input); return row;
  }
  private typographyDisplayValue(key: 'fontSize' | 'lineHeight' | 'contentWidth' | 'hotzoneDelay' | 'panelHideDelay'): number {
    if (!this.documentFrame || key === 'hotzoneDelay' || key === 'panelHideDelay' || this.typographyOverrides.has(key)) return this.settings[key];
    const body = this.stream.querySelector<HTMLElement>('[data-fv-body]');
    if (!body) return this.settings[key];
    const style = getComputedStyle(body), fontSize = Number.parseFloat(style.fontSize);
    const value = key === 'fontSize' ? fontSize : key === 'lineHeight' ? Number.parseFloat(style.lineHeight) / fontSize
      : this.stream.querySelector<HTMLElement>('[data-fv-content-width]')?.getBoundingClientRect().width;
    return value && Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : this.settings[key];
  }
  private checkbox(label: string, key: 'sidebarCollapsed' | 'disguiseTab' | 'hotzoneEnabled' | 'autoPrivacy' | 'arrowNavigation'): HTMLElement {
    const row = el('label', 'check-row'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = !this.documentFrame && key === 'sidebarCollapsed' && typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches ? !this.mobileSidebarExpanded : this.settings[key]; input.dataset.setting = key; input.addEventListener('change', () => this.patch({ [key]: input.checked })); row.append(el('span', '', label), input); return row;
  }
  private select(label: string, key: 'colorScheme' | 'hotzoneCorner', options: string[][]): HTMLElement {
    const row = el('label', 'setting-row', label); const select = document.createElement('select'); select.dataset.setting = key;
    options.forEach(([value, title]) => { const option = document.createElement('option'); option.value = value!; option.textContent = title!; select.append(option); });
    select.value = this.settings[key]; select.setAttribute('aria-label', label); select.addEventListener('change', () => this.patch({ [key]: select.value } as Partial<SettingsV2>)); row.append(select); return row;
  }
  private patch(patch: Partial<SettingsV2>): void {
    if (this.documentFrame) for (const key of ['fontSize', 'lineHeight', 'contentWidth'] as const) if (patch[key] !== undefined) this.typographyOverrides.add(key);
    if (patch.sidebarCollapsed !== undefined) this.mobileSidebarExpanded = !patch.sidebarCollapsed;
    this.updateSettings({ ...this.settings, ...patch }); this.callbacks.onSettings(patch);
  }
  private scrollToBlock(id: string): void {
    if (!this.isReading()) return;
    const block = this.shadow.getElementById(id); if (!block) return;
    this.scroller.scrollTop += block.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - 25;
    this.rememberReadingPosition();
  }
  private openPreview(block: ImageBlock, trigger: HTMLElement): void {
    this.closePanel(false); this.closePreview(false); this.previewTrigger = trigger; this.previewBlock = block;
    const overlay = el('div', 'preview-overlay'); const dialog = el('section', 'preview-dialog');
    if (this.documentFrame) overlay.dataset.fvReaderUi = 'preview';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', block.label);
    const head = el('div', 'preview-head'); const close = button('×', '', () => this.closePreview(), '关闭图片'); head.append(el('strong', '', block.label), close); dialog.append(head);
    const body = el('div', 'preview-body');
    const loadImage = () => {
      body.replaceChildren();
      if (!block.src) { body.append(el('p', '', '暂时无法显示该图片，请恢复原页面后查看。')); return; }
      const img = document.createElement('img'); img.alt = block.label;
      img.addEventListener('error', () => { if (this.preview !== overlay) return; body.replaceChildren(el('p', '', '暂时无法显示图片'), button('重试', 'retry-image', loadImage)); });
      img.src = block.src; body.append(img);
    };
    loadImage(); dialog.append(body);
    if (block.caption || block.captionHtml) { const caption = el('div', 'preview-caption'); if (block.captionHtml) caption.append(sanitizeMarkup(block.captionHtml, document)); else caption.textContent = block.caption ?? ''; dialog.append(caption); }
    overlay.append(dialog); overlay.addEventListener('click', event => { if (event.target === overlay) this.closePreview(); });
    this.preview = overlay; this.app.append(overlay); this.hideReadingFromModal(true); close.focus();
  }
  private hideReadingFromModal(hidden: boolean): void {
    if (hidden) {
      for (const target of [...this.app.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== this.panel && node !== this.preview)) {
        this.modalStates.set(target, { inert: target.hasAttribute('inert'), aria: target.getAttribute('aria-hidden') });
        target.setAttribute('inert', ''); target.setAttribute('aria-hidden', 'true');
      }
    } else {
      for (const [target, original] of this.modalStates) {
        target.toggleAttribute('inert', original.inert);
        if (original.aria === null) target.removeAttribute('aria-hidden'); else target.setAttribute('aria-hidden', original.aria);
      }
      this.modalStates.clear();
    }
  }
  private handleKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (this.preview) { event.preventDefault(); event.stopPropagation(); this.closePreview(); }
      else if (this.isPanelOpen()) { event.preventDefault(); event.stopPropagation(); this.closePanel(); }
    }
    if (event.key === 'Tab' && this.preview) {
      const focusable = Array.from(this.preview.querySelectorAll<HTMLElement>('button,[href],input,select,[tabindex="0"]')).filter(node => !node.hasAttribute('disabled'));
      const index = focusable.indexOf(this.shadow.activeElement as HTMLElement);
      if (event.shiftKey ? index <= 0 : index === focusable.length - 1) { event.preventDefault(); focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus(); }
    }
  }
  private hide(node: HTMLElement, hidden: boolean): void { node.hidden = hidden; node.toggleAttribute('inert', hidden); node.setAttribute('aria-hidden', String(hidden)); }
}
function el(tag: string, className = '', text?: string): HTMLElement { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function escapeHTML(text: string): string { const node = document.createElement('span'); node.textContent = text; return node.innerHTML; }
function button(text: string, className: string, action: () => void, label?: string): HTMLButtonElement { const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = text; if (label) node.setAttribute('aria-label', label); node.addEventListener('click', action); return node; }
function escapeId(id: string): string { return id.replace(/["\\]/g, '\\$&'); }

const STYLES = `
.generated-theme [data-fv-slot=userMessage],.generated-theme [data-fv-slot=assistantMessage]{height:auto!important;max-height:none!important;overflow:visible!important}.generated-theme [data-fv-slot=assistantMessage]{width:100%;min-width:0}.generated-theme [data-fv-slot=scroller]{min-height:0;overflow:auto}.generated-theme .stream{height:auto;min-height:0}
.recovery{display:flex;gap:12px;flex-wrap:wrap}.recovery button{border:1px solid #ddd;border-radius:8px;padding:10px 16px;background:transparent}button:disabled{opacity:.4;cursor:default}
:host{all:initial;display:block;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#292b2c;text-align:left;font-synthesis:none}*{box-sizing:border-box} [hidden]{display:none!important}button,input,select{font:inherit}button{cursor:pointer}button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #5b807b;outline-offset:3px}button{color:inherit} .app{--bg:#fcfcfb;--sidebar:#f1f2ef;--text:#303432;--muted:#858983;--line:#e4e6e1;--bubble:#343b38;--hover:#e5e8e2;--card:#fff;position:fixed;inset:0;background:var(--bg);color:var(--text);display:flex;font-size:14px;line-height:1.5;overflow:hidden}.app[data-scheme=dark]{--bg:#222624;--sidebar:#1b1e1c;--text:#e3e7e2;--muted:#939b93;--line:#373e37;--bubble:#414a42;--hover:#303830;--card:#2b312c;color-scheme:dark}.sidebar{width:248px;flex:0 0 248px;background:var(--sidebar);display:flex;flex-direction:column;padding:30px 15px 18px;border-right:1px solid var(--line);overflow:hidden}.sidebar-top{padding:0 10px 26px}.new-chat{border:0;background:none;font-size:15px;font-weight:550;padding:9px 0;text-align:left;width:100%}.new-chat:before{content:'+';font-size:21px;font-weight:300;margin-right:12px;vertical-align:-1px}.sidebar-links{display:flex;gap:25px;padding:13px 0 0}.sidebar-links button{border:0;padding:0;background:none;color:var(--muted);font-size:13px}.sessions{flex:1;min-height:0;overflow:auto;scrollbar-width:thin}.section-label{font-size:11px;color:var(--muted);padding:0 12px 10px;letter-spacing:.08em}.session{position:relative;display:block;text-align:left;width:100%;height:41px;margin:2px 0;border:0;padding:0 14px;background:transparent;border-radius:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;letter-spacing:.01em}.session:hover{background:var(--hover)}.session.active{background:var(--hover);font-weight:550;padding-right:26px}.session.active:after{content:'';position:absolute;width:5px;height:5px;border-radius:50%;background:#78877b;right:13px;top:18px}.sidebar-bottom{display:flex;gap:10px;align-items:center;padding:22px 10px 0;color:var(--muted);font-size:12px}.avatar{display:grid;place-items:center;background:var(--hover);width:28px;height:28px;border-radius:50%;font-size:11px;color:var(--text)}.workspace{position:relative;flex:1;min-width:0;display:flex;flex-direction:column}.header{height:76px;flex:0 0 76px;display:flex;align-items:center;gap:10px;padding:0 38px;font-size:14px;font-weight:500}.chevron{color:var(--muted);font-size:17px;line-height:1}.scroller{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;outline:0}.stream{width:100%;max-width:calc(var(--content-width) + 80px);margin:auto;padding:30px 40px 155px;overflow-wrap:anywhere}.title-bubble{margin:0 0 48px auto;max-width:86%;width:fit-content;background:var(--bubble);color:#f7f9f6;border-radius:20px 20px 5px 20px;padding:17px 24px;font-size:16px;line-height:1.7;white-space:pre-wrap}.reply{font-size:var(--font-size);line-height:var(--line-height);font-weight:400}.reply>p{margin:0 0 16px}.reply h2,.reply h3,.reply h4,.reply h5,.reply h6{font-size:1.13em;line-height:1.5;font-weight:600;margin:31px 0 14px;color:var(--text)}.reply h2:first-child{margin-top:0}.reply h3{font-size:1.05em}.reply ul,.reply ol{padding-left:25px;margin:16px 0 22px}.reply li{margin:8px 0;padding-left:4px}.reply strong{font-weight:600}.reply a{color:#5a786c;text-decoration:none;border-bottom:1px solid #9bb0a0}.reply blockquote{margin:20px 0;padding:4px 0 4px 20px;border-left:3px solid var(--line);color:var(--muted)}.reply code{font-family:"SFMono-Regular",Consolas,monospace;font-size:.88em}.reply pre{padding:18px 20px;background:var(--sidebar);border-radius:8px;overflow:auto;white-space:pre;max-width:100%}.math-block{max-width:100%;overflow-x:auto;margin:25px 0;text-align:center;padding:10px 0}.reply math{font-family:"STIX Two Math","Cambria Math",serif;font-size:1.05em}.table-block{margin:24px 0}.table-scroll{max-width:100%;overflow-x:auto}.reply table{border-collapse:collapse;width:100%;text-align:left;font-size:.86em;margin:12px 0 20px;line-height:1.7}.reply th{font-weight:550;background:var(--sidebar)}.reply th,.reply td{padding:10px 14px;border-bottom:1px solid var(--line);min-width:75px}.reply figcaption{font-size:12px;line-height:1.6;color:var(--muted);margin:10px 0}.image-block{margin:24px 0}.image-trigger{display:flex;flex-direction:column;align-items:flex-start;max-width:100%;padding:0;border:0;background:transparent;font-size:13px;text-align:left;color:var(--muted);line-height:1.6}.image-trigger:hover{color:var(--text)}.mode-hidden .image-trigger{padding:7px 0}.image-trigger img{display:block;object-fit:contain;max-width:100%;height:auto;background:#fff;border-radius:4px}.mode-thumbnail .image-trigger img{max-width:160px;max-height:120px;width:auto;height:auto}.mode-thumbnail .image-label{margin-top:7px;font-size:11px}.mode-full .image-trigger{width:100%}.mode-full img{max-height:none;max-width:100%;width:auto;align-self:center}.mode-full .image-label{font-size:11px;margin-top:8px}.image-failed{display:block;padding:12px;background:var(--sidebar);border-radius:6px}.end-note{text-align:center;color:var(--muted);font-size:11px;margin:40px 0 0;letter-spacing:.04em}.reading-status{font-size:13px;color:var(--muted);padding:36px 0}.composer-wrap{position:absolute;left:0;right:0;bottom:0;padding:25px 40px 27px;background:linear-gradient(transparent,var(--bg) 22%);pointer-events:none}.composer{max-width:var(--content-width);margin:auto;border:1px solid var(--line);background:var(--bg);height:59px;border-radius:19px;display:flex;align-items:center;justify-content:space-between;padding:0 12px 0 21px;box-shadow:0 3px 12px #00000003}.composer-placeholder{font-size:13px;color:#999e98}.send{width:32px;height:32px;border-radius:50%;background:var(--hover);color:var(--muted);display:grid;place-items:center;font-size:20px}.app[data-sidebar=collapsed] .sidebar{display:none}.controls{position:fixed;right:26px;top:18px;width:338px;max-width:calc(100vw - 28px);max-height:calc(100vh - 36px);overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:0 14px 60px #00000020;z-index:10;font-size:12px;scrollbar-width:thin}.controls[data-corner=top-left]{left:26px;right:auto}.controls[data-corner=bottom-right]{top:auto;bottom:18px}.controls[data-corner=bottom-left]{top:auto;bottom:18px;left:26px;right:auto}.panel-header{display:flex;justify-content:space-between;align-items:center;font-size:14px;margin-bottom:16px}.panel-close,.preview-head button{font-size:22px;border:0;background:transparent;color:var(--muted);width:28px;height:28px;border-radius:6px;line-height:1}.setting-group{border:0;padding:0;margin:0 0 15px}.setting-group legend{padding:0;margin-bottom:10px;font-weight:500}.segments{display:grid;grid-template-columns:1.15fr 1fr .9fr;gap:4px;background:var(--sidebar);padding:4px;border-radius:8px}.segments button{padding:9px 3px;background:transparent;border:0;border-radius:6px;font-size:11px;white-space:nowrap}.segments button[aria-pressed=true]{background:var(--card);box-shadow:0 1px 4px #00000010;color:var(--text)}.help{font-size:11px;line-height:1.7;color:var(--muted);margin:9px 0 0;white-space:pre-line}.panel-navigation{display:flex;gap:8px;margin:14px 0}.panel-navigation button{flex:1;background:var(--sidebar);padding:8px;border:0;border-radius:6px}.panel-details{border-top:1px solid var(--line);padding:11px 0}.panel-details summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between}.panel-details summary:after{content:'+';color:var(--muted)}.panel-details[open] summary:after{content:'−'}.settings-form{display:flex;flex-direction:column;gap:15px;padding-top:17px}.range-row{display:flex;flex-direction:column;gap:8px}.range-label{display:flex;justify-content:space-between}.range-label output{color:var(--muted);font-variant-numeric:tabular-nums}.range-row input{width:100%;margin:0;accent-color:#566d60}.check-row,.setting-row{display:flex;justify-content:space-between;gap:12px;align-items:center}.check-row input{accent-color:#566d60}.setting-row select,.setting-row input{max-width:160px;min-width:0;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:6px;color:var(--text);font-size:12px}.toc-list{max-height:210px;overflow:auto;margin-top:10px}.toc-list button{display:block;width:100%;text-align:left;border:0;background:none;padding:7px 8px;font-size:12px;border-radius:5px}.toc-list button:hover{background:var(--sidebar)}.source-info{overflow-wrap:anywhere;font-size:11px;color:var(--muted)}.panel-actions{display:flex;gap:8px;margin-top:12px}.panel-actions button,.panel-action{border:1px solid var(--line);border-radius:7px;flex:1;background:transparent;padding:9px;font-size:12px}.panel-actions .panel-primary{background:var(--bubble);color:#fff;border-color:var(--bubble)}.preview-overlay{position:fixed;inset:0;background:#111b16b8;display:flex;align-items:center;justify-content:center;z-index:20;padding:20px}.preview-dialog{width:fit-content;max-width:90vw;max-height:80vh;background:var(--card);border-radius:14px;display:flex;flex-direction:column;padding:18px;overflow:hidden;box-shadow:0 25px 100px #0005}.preview-head{display:flex;justify-content:space-between;align-items:center;gap:40px;font-size:13px;flex-shrink:0;margin-bottom:12px}.preview-body{min-height:0;overflow:auto;text-align:center}.preview-body img{display:block;max-width:100%;max-height:56vh;width:auto;height:auto;object-fit:contain;margin:auto;background:white}.preview-caption{max-width:100%;overflow-wrap:anywhere;font-size:12px;line-height:1.65;color:var(--muted);margin:14px 0 0;max-width:800px;max-height:13vh;overflow:auto}.retry-image{background:var(--sidebar);color:var(--text);padding:8px 14px;border:1px solid var(--line);border-radius:6px}@media(max-width:1000px){.sidebar{width:220px;flex-basis:220px}.header{padding:0 28px}.stream{padding:25px 28px 140px}.composer-wrap{padding:25px 28px}}@media(max-width:760px){.sidebar{display:none}.app[data-mobile-sidebar=expanded] .sidebar{display:flex;position:absolute;inset:0 auto 0 0;width:248px;z-index:5;box-shadow:10px 0 40px #00000015}.header{height:60px;flex-basis:60px;padding:0 22px;font-size:13px}.stream{padding:20px 22px 132px}.title-bubble{max-width:95%;padding:14px 18px;font-size:15px;margin-bottom:32px}.reply{font-size:min(var(--font-size),17px)}.composer-wrap{padding:22px 18px}.composer{height:54px}.controls{right:14px;top:12px;max-height:calc(100vh - 24px)}.preview-dialog{max-width:94vw}.reply th,.reply td{padding:8px 10px}.reply table{font-size:.8em}}@media(prefers-reduced-motion:no-preference){.session{transition:background .12s}.image-trigger{transition:color .12s}}`;
