// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReaderDocument } from '../packages/content-model/src/index';
import { DEFAULT_SETTINGS, type SettingsV2 } from '../packages/storage/src/index';
import { ChatReaderShell } from '../packages/theme-minimal-assistant/src/chat-shell';

const SECRET_TITLE = 'Private research title that must wrap instead of being truncated';
const SECRET_TEXT = 'Private original paragraph, unchanged and selectable.';
const SECRET_HEADING = 'Confidential section heading';
const SECRET_CAPTION = 'Figure 7. Confidential experiment description.';
const SECRET_SOURCE = 'https://source.invalid/private-research';
const IMAGE = 'https://fixtures.invalid/plot.png';

function paper(): ReaderDocument {
  return {
    id: 'test-paper', title: SECRET_TITLE,
    source: { kind: 'fixture', label: 'Private source label', url: SECRET_SOURCE },
    blocks: [
      { id: 'intro', sourceId: 'source-intro', type: 'heading', level: 2, html: SECRET_HEADING },
      { id: 'paragraph-one', type: 'paragraph', html: `<strong>${SECRET_TEXT}</strong> <em>Emphasis</em> <a href="#source-intro">[1]</a>` },
      { id: 'figure-seven', type: 'image', src: IMAGE, label: '图片 7', caption: SECRET_CAPTION, resourceKind: 'image' },
      { id: 'paragraph-two', type: 'paragraph', html: 'Original paragraph following the image.' },
      { id: 'formula', type: 'math', html: '<math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>x</mi><mn>2</mn></msup><mo>=</mo><mn>4</mn></math>', text: 'x² = 4' },
      { id: 'wide-table', type: 'table', html: '<table><thead><tr><th scope="col" colspan="2">Wide heading</th><th>Third</th></tr></thead><tbody><tr><td>A</td><td>B</td><td>C</td></tr></tbody></table>', caption: 'Table 1. Original values.' },
    ],
    toc: [{ id: 'intro', label: SECRET_HEADING, level: 2 }], warnings: [],
  };
}

function namedButton(root: ParentNode, label: string): HTMLButtonElement {
  const node = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === label || button.getAttribute('aria-label') === label);
  if (!node) throw new Error(`Missing button: ${label}`);
  return node;
}

describe('chat reader shell', () => {
  const mounted: ChatReaderShell[] = [];
  afterEach(() => {
    mounted.splice(0).forEach(shell => shell.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mount(settings: Partial<SettingsV2> = {}, documentValue = paper()) {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onSettings = vi.fn();
    const onRestore = vi.fn();
    const onPrivacyChange = vi.fn();
    const shell = new ChatReaderShell({ ...DEFAULT_SETTINGS, ...settings }, { onSettings, onRestore, onPrivacyChange });
    shell.mount();
    shell.setDocument(documentValue);
    mounted.push(shell);
    return { shell, shadow: shell.shadow as ShadowRoot, onSettings, onRestore, onPrivacyChange };
  }

  it('starts with no interactive control panel and keeps the real title in the message stream', () => {
    const { shell, shadow } = mount();
    expect(shell.isPanelOpen()).toBe(false);
    expect(shell.panel.hidden).toBe(true);
    expect(shell.panel.hasAttribute('inert')).toBe(true);
    expect(shell.panel.getAttribute('aria-hidden')).toBe('true');
    expect(shell.panel.children).toHaveLength(0);
    expect(shadow.querySelector('.title-bubble')?.textContent).toBe(SECRET_TITLE);
    expect(shadow.querySelectorAll('.reply')).toHaveLength(1);
    expect(shadow.querySelector('.reply')?.textContent).toContain(SECRET_TEXT);
    expect(Array.from(shadow.querySelector('.reply')!.children).map(node => node.id)).toEqual(paper().blocks.map(block => block.id));
    expect(shadow.querySelector('.header-title')?.textContent).toBe('项目方案讨论');
    expect(shadow.querySelector('.sidebar')?.textContent).not.toContain(SECRET_TITLE);
    expect(shadow.querySelectorAll('.session')).toHaveLength(12);
    expect(shadow.querySelector('.composer-wrap')?.getAttribute('aria-hidden')).toBe('true');
    expect(shadow.querySelector('.composer input,.composer textarea,.composer button')).toBeNull();
    const app = shadow.querySelector<HTMLElement>('.app')!;
    expect(app.style.getPropertyValue('--content-width')).toBe('760px');
    expect(app.style.getPropertyValue('--font-size')).toBe('17px');
    expect(app.style.getPropertyValue('--line-height')).toBe('1.75');
  });

  it('opens keyboard controls without moving reading position and restores focus on close', () => {
    const { shell, shadow } = mount();
    const trigger = shadow.querySelector<HTMLButtonElement>('.image-trigger')!;
    trigger.focus(); shell.scroller.scrollTop = 418;
    shell.togglePanel();
    expect(shell.isPanelOpen()).toBe(true);
    expect(shell.panel.hasAttribute('inert')).toBe(false);
    expect(shell.panel.getAttribute('aria-hidden')).toBe('false');
    expect(shell.panel.contains(shadow.activeElement)).toBe(true);
    expect(shell.scroller.scrollTop).toBe(418);
    shell.panel.querySelectorAll('details').forEach(details => { details.open = true; });
    shell.togglePanel();
    expect(shell.isPanelOpen()).toBe(false);
    expect(shell.panel.hasAttribute('inert')).toBe(true);
    expect(Array.from(shell.panel.querySelectorAll('details')).every(details => !details.open)).toBe(true);
    expect(shadow.activeElement).toBe(trigger);
    expect(shell.scroller.scrollTop).toBe(418);
  });

  it('mouse panel opening does not steal focus and a new document closes controls', () => {
    const { shell, shadow } = mount();
    shell.scroller.focus();
    shell.togglePanel(false);
    expect(shadow.activeElement).toBe(shell.scroller);
    shell.setDocument({ ...paper(), id: 'next-paper', title: 'Next original title' });
    expect(shell.isPanelOpen()).toBe(false);
    expect(shadow.querySelectorAll('.title-bubble')).toHaveLength(1);
    expect(shadow.querySelector('.title-bubble')?.textContent).toBe('Next original title');
  });

  it('hidden images expose only a numbered entry and keep pixels, URLs and captions out of reading DOM', () => {
    const { shadow } = mount();
    expect(shadow.querySelector('.image-trigger')?.textContent).toBe('【图片 7 · 点击查看】');
    expect(shadow.querySelector('img,svg,canvas,picture')).toBeNull();
    expect(shadow.querySelector('.reading-view')?.innerHTML).not.toContain(IMAGE);
    expect(shadow.textContent).not.toContain(SECRET_CAPTION);
  });

  it('keeps mathematical image captions out of hidden/thumbnail DOM and preserves safe fractions in preview/full mode', () => {
    const secret = 'Private fraction-only caption';
    const privateAria = 'Private numerator over denominator';
    const doc = paper();
    const image = doc.blocks.find(block => block.type === 'image')!;
    if (image.type !== 'image') throw new Error('Missing fixture image');
    image.caption = `${secret}: x / 2`;
    image.captionHtml = `<span title="${secret}" aria-label="${privateAria}" onclick="captionAttack()">${secret}</span><math xmlns="http://www.w3.org/1998/Math/MathML" alttext="${privateAria}" onmouseover="captionAttack()"><mfrac><mi>x</mi><mn>2</mn></mfrac></math><script>captionAttack()</script>`;
    const { shell, shadow } = mount({}, doc);
    const assertSafeFraction = (caption: Element | null) => {
      expect(caption?.textContent).toContain(secret);
      expect(caption?.querySelector('mfrac')?.children).toHaveLength(2);
      expect(caption?.querySelector('mfrac mi')?.textContent).toBe('x');
      expect(caption?.querySelector('mfrac mn')?.textContent).toBe('2');
      expect(caption?.querySelector('script,[onclick],[onmouseover]')).toBeNull();
      expect(caption?.innerHTML).not.toContain('captionAttack');
    };
    for (const mode of ['hidden', 'thumbnail'] as const) {
      shell.updateSettings({ ...DEFAULT_SETTINGS, imageMode: mode });
      expect(shadow.querySelector('.image-block figcaption')).toBeNull();
      // Serialized DOM includes title/aria attributes as well as visible text.
      expect(shadow.innerHTML).not.toContain(secret);
      expect(shadow.innerHTML).not.toContain(privateAria);
      expect(shadow.querySelector('.image-block mfrac')).toBeNull();
      shadow.querySelector<HTMLButtonElement>('.image-trigger')!.click();
      assertSafeFraction(shadow.querySelector('.preview-caption'));
      shell.closePreview();
      expect(shadow.innerHTML).not.toContain(privateAria);
      expect(shadow.innerHTML).not.toContain(secret);
    }
    shell.updateSettings({ ...DEFAULT_SETTINGS, imageMode: 'full' });
    assertSafeFraction(shadow.querySelector('.image-block figcaption'));
    shell.updateSettings({ ...DEFAULT_SETTINGS, imageMode: 'hidden' });
    expect(shadow.innerHTML).not.toContain(secret);
    expect(shadow.innerHTML).not.toContain(privateAria);
  });

  it('renders a table mathematical caption independently of image mode with sanitized MathML structure', () => {
    const doc = paper();
    const table = doc.blocks.find(block => block.type === 'table')!;
    if (table.type !== 'table') throw new Error('Missing fixture table');
    table.caption = undefined;
    table.captionHtml = '<strong onpointerenter="tableAttack()">Table ratio</strong><math xmlns="http://www.w3.org/1998/Math/MathML" onclick="tableAttack()"><mfrac><mn>1</mn><mi>n</mi></mfrac></math><script>tableAttack()</script><img src="caption-pixel.png" onerror="tableAttack()">';
    const { shadow } = mount({ imageMode: 'hidden' }, doc);
    const caption = shadow.querySelector('#wide-table figcaption')!;
    expect(caption.querySelector('strong')?.textContent).toBe('Table ratio');
    expect(caption.querySelector('mfrac')?.children).toHaveLength(2);
    expect(caption.querySelector('mfrac mn')?.textContent).toBe('1');
    expect(caption.querySelector('mfrac mi')?.textContent).toBe('n');
    expect(caption.querySelector('script,img,[onpointerenter],[onclick],[onerror]')).toBeNull();
    expect(caption.innerHTML).not.toContain('tableAttack');
    expect(shadow.querySelector('.image-block figcaption')).toBeNull();
  });

  it.each(['Enter', ' '])('uses native button semantics and the keyboard activation click path for %j', key => {
    const { shell, shadow, onSettings } = mount();
    const trigger = shadow.querySelector<HTMLButtonElement>('.image-trigger')!;
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.type).toBe('button');
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    trigger.focus();
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    // jsdom does not implement button activation defaults. A browser emits this
    // zero-detail click for Enter/Space; physical key handling needs browser QA.
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(shell.isPreviewOpen()).toBe(true);
    expect(shadow.querySelector<HTMLImageElement>('.preview-body img')?.src).toBe(IMAGE);
    expect(shadow.querySelector('.preview-caption')?.textContent).toBe(SECRET_CAPTION);
    expect(shell.isPanelOpen()).toBe(false);
    namedButton(shadow, '关闭图片').click();
    expect(shell.isPreviewOpen()).toBe(false);
    expect(shadow.activeElement).toBe(trigger);
    expect(shadow.querySelector('img')).toBeNull();
    expect(onSettings).not.toHaveBeenCalled();
  });

  it('isolates preview focus, closes with Escape/backdrop, and does not reopen the panel', () => {
    const { shell, shadow } = mount();
    const trigger = shadow.querySelector<HTMLButtonElement>('.image-trigger')!;
    trigger.click();
    expect(shadow.querySelector('.workspace')?.hasAttribute('inert')).toBe(true);
    expect(shadow.querySelector('.sidebar')?.getAttribute('aria-hidden')).toBe('true');
    const close = namedButton(shadow, '关闭图片');
    expect(shadow.activeElement).toBe(close);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    close.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(shadow.activeElement).toBe(close);
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(shell.isPreviewOpen()).toBe(false);
    expect(shadow.querySelector('.workspace')?.hasAttribute('inert')).toBe(false);
    expect(shadow.activeElement).toBe(trigger);
    trigger.click();
    shadow.querySelector<HTMLElement>('.preview-overlay')!.click();
    expect(shell.isPreviewOpen()).toBe(false);
    expect(shell.isPanelOpen()).toBe(false);
  });

  it('applies three modes immediately and keeps the selected mode after a temporary preview', () => {
    const { shell, shadow, onSettings } = mount();
    shell.scroller.scrollTop = 506;
    shell.togglePanel(); namedButton(shell.panel, '展示缩略图').click();
    expect(shadow.querySelector('.image-block')?.classList.contains('mode-thumbnail')).toBe(true);
    expect(shadow.querySelector('.image-block img')).not.toBeNull();
    expect(shadow.querySelector('.image-block figcaption')).toBeNull();
    expect(onSettings).toHaveBeenLastCalledWith({ imageMode: 'thumbnail' });
    shadow.querySelector<HTMLButtonElement>('.image-trigger')!.click();
    shell.closePreview();
    expect(shadow.querySelector('.image-block')?.classList.contains('mode-thumbnail')).toBe(true);
    shell.togglePanel(); namedButton(shell.panel, '全图展示').click();
    expect(shadow.querySelector('.image-block')?.classList.contains('mode-full')).toBe(true);
    expect(shadow.querySelector('.image-block figcaption')?.textContent).toBe(SECRET_CAPTION);
    expect(shell.scroller.scrollTop).toBe(506);
    namedButton(shell.panel, '禁止展示图片').click();
    expect(shadow.querySelector('.image-block img')).toBeNull();
    expect(shadow.querySelector('.image-block figcaption')).toBeNull();
    expect(onSettings).toHaveBeenLastCalledWith({ imageMode: 'hidden' });
    expect(shell.scroller.scrollTop).toBe(506);
  });

  it('closes an active preview synchronously on stricter settings and keeps later documents hidden', () => {
    const { shell, shadow } = mount({ imageMode: 'full' });
    shadow.querySelector<HTMLButtonElement>('.image-trigger')!.click();
    const oldImage = shadow.querySelector<HTMLImageElement>('.preview-body img')!;
    shell.updateSettings({ ...DEFAULT_SETTINGS, imageMode: 'hidden' });
    expect(shell.isPreviewOpen()).toBe(false);
    expect(shadow.querySelector('img')).toBeNull();
    oldImage.dispatchEvent(new Event('error'));
    expect(shell.isPreviewOpen()).toBe(false);
    expect(shadow.querySelector('.retry-image')).toBeNull();
    shell.setDocument({ ...paper(), id: 'next-paper' });
    expect(shadow.querySelector('img')).toBeNull();
    expect(shadow.querySelector('.image-trigger')?.textContent).toBe('【图片 7 · 点击查看】');
  });

  it('removes real content, preview and stale panel metadata immediately on privacy entry', () => {
    const { shell, shadow, onPrivacyChange } = mount({ imageMode: 'full' });
    shell.scroller.scrollTop = 612;
    shell.togglePanel();
    expect(shell.panel.textContent).toContain(SECRET_SOURCE);
    shell.closePanel();
    shadow.querySelector<HTMLButtonElement>('.image-trigger')!.click();
    const oldImage = shadow.querySelector<HTMLImageElement>('.preview-body img')!;
    shell.setPrivacy(true);
    expect(shell.getPrivacy()).toBe(true);
    expect(shell.isPreviewOpen()).toBe(false);
    expect(shell.isPanelOpen()).toBe(false);
    expect(shadow.querySelector('.reading-view,img')).toBeNull();
    for (const secret of [SECRET_TITLE, SECRET_TEXT, SECRET_HEADING, SECRET_CAPTION, SECRET_SOURCE]) expect(shadow.textContent).not.toContain(secret);
    expect(shadow.querySelector('.neutral-view')).not.toBeNull();
    expect(onPrivacyChange).toHaveBeenLastCalledWith(true);
    oldImage.dispatchEvent(new Event('error'));
    expect(shadow.querySelector('img,.preview-overlay')).toBeNull();
    shell.setPrivacy(false);
    expect(shell.scroller.scrollTop).toBe(612);
    expect(shadow.querySelector('.title-bubble')?.textContent).toBe(SECRET_TITLE);
    expect(shell.isPanelOpen()).toBe(false);
    expect(shell.isPreviewOpen()).toBe(false);
  });

  it('opening controls during privacy exposes only safe controls and Continue explicitly restores reading', () => {
    const { shell, shadow } = mount();
    shell.scroller.scrollTop = 713; shell.setPrivacy(true); shell.togglePanel();
    expect(shell.getPrivacy()).toBe(true);
    expect(shadow.querySelector('.reading-view')).toBeNull();
    expect(shell.panel.querySelector('.toc-list,.source-info,.panel-navigation,[data-image-mode]')).toBeNull();
    for (const secret of [SECRET_TITLE, SECRET_TEXT, SECRET_HEADING, SECRET_SOURCE]) expect(shadow.textContent).not.toContain(secret);
    namedButton(shell.panel, '继续').click();
    expect(shell.getPrivacy()).toBe(false);
    expect(shell.isPanelOpen()).toBe(false);
    expect(shell.scroller.scrollTop).toBe(713);
    expect(shadow.querySelector('.title-bubble')?.textContent).toBe(SECRET_TITLE);
  });

  it('removes the tab disguise setting during privacy and restores it only after Continue', () => {
    const { shell } = mount();
    shell.togglePanel();
    expect(shell.panel.querySelector('[data-setting="disguiseTab"]')).not.toBeNull();
    shell.setPrivacy(true); shell.togglePanel();
    expect(shell.panel.querySelector('[data-setting="disguiseTab"]')).toBeNull();
    expect(shell.panel.textContent).not.toContain('标签标题与图标伪装');
    expect(shell.panel.querySelector('[data-setting="fontSize"]')).not.toBeNull();
    namedButton(shell.panel, '继续').click();
    shell.togglePanel();
    expect(shell.panel.querySelector('[data-setting="disguiseTab"]')).not.toBeNull();
  });

  it.each(['panel', 'preview'])('moves focus from %s to the neutral scroller on privacy entry while the document is focused', layer => {
    const { shell, shadow } = mount();
    if (layer === 'panel') shell.togglePanel();
    else shadow.querySelector<HTMLButtonElement>('.image-trigger')!.click();
    expect(shadow.activeElement).not.toBe(shell.scroller);
    const focus = vi.spyOn(shell.scroller, 'focus');
    shell.setPrivacy(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(shadow.activeElement).toBe(shell.scroller);
    expect(shadow.querySelector('.neutral-view')).not.toBeNull();
    expect(shell.isPanelOpen()).toBe(false);
    expect(shell.isPreviewOpen()).toBe(false);
  });

  it('does not request focus when privacy begins while the document is unfocused', () => {
    const { shell } = mount();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const focus = vi.spyOn(shell.scroller, 'focus');
    shell.setPrivacy(true);
    expect(shell.getPrivacy()).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus on the image mode control through panel reconstruction', () => {
    const { shell, shadow, onSettings } = mount();
    shell.togglePanel();
    for (const mode of ['thumbnail', 'full', 'hidden'] as const) {
      const control = shell.panel.querySelector<HTMLButtonElement>(`[data-image-mode="${mode}"]`)!;
      control.focus(); control.click();
      const active = shadow.activeElement as HTMLButtonElement;
      expect(shell.panel.contains(active)).toBe(true);
      expect(active.dataset.imageMode).toBe(mode);
      expect(active.getAttribute('aria-pressed')).toBe('true');
      expect(onSettings).toHaveBeenLastCalledWith({ imageMode: mode });
      expect(shell.isPanelOpen()).toBe(true);
    }
  });

  it('defaults the narrow sidebar to collapsed but allows an explicit setting to expand it', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => ({
      matches: query === '(max-width: 760px)', media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
      removeEventListener: vi.fn(), dispatchEvent: vi.fn(() => true)
    })));
    const { shell, shadow, onSettings } = mount();
    const app = shadow.querySelector<HTMLElement>('.app')!;
    expect(app.dataset.mobileSidebar).toBe('collapsed');
    shell.togglePanel();
    const checkbox = shell.panel.querySelector<HTMLInputElement>('[data-setting="sidebarCollapsed"]')!;
    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.dataset.mobileSidebar).toBe('expanded');
    expect(onSettings).toHaveBeenLastCalledWith({ sidebarCollapsed: false });
    shell.closePanel(); shell.togglePanel();
    expect(shell.panel.querySelector<HTMLInputElement>('[data-setting="sidebarCollapsed"]')!.checked).toBe(false);
    namedButton(shadow, '周报内容整理').click();
    expect(app.dataset.mobileSidebar).toBe('collapsed');
  });

  it('keeps privacy active through replacement content and sidebar navigation', () => {
    const { shell, shadow } = mount();
    shell.setPrivacy(true);
    shell.setDocument({ ...paper(), title: 'Replacement secret title' });
    namedButton(shadow, '周报内容整理').click();
    namedButton(shadow, '项目方案讨论').click();
    expect(shell.getPrivacy()).toBe(true);
    expect(shadow.querySelector('.reading-view')).toBeNull();
    expect(shadow.textContent).not.toContain('Replacement secret title');
  });

  it('preserves reading position and nodes while browsing neutral conversations and neutral entry points', () => {
    const { shell, shadow } = mount();
    const readingView = shadow.querySelector('.reading-view');
    shell.scroller.scrollTop = 834;
    namedButton(shadow, '周报内容整理').click();
    expect(shell.isReading()).toBe(false);
    expect(shadow.querySelector('.title-bubble')?.textContent).toContain('周报');
    expect(shadow.textContent).not.toContain(SECRET_TEXT);
    expect(shell.scroller.scrollTop).toBe(0);
    namedButton(shadow, '资料').click();
    expect(shadow.querySelector('.header-title')?.textContent).toBe('资料整理');
    expect(shadow.querySelector('iframe')).toBeNull();
    namedButton(shadow, '项目方案讨论').click();
    expect(shell.isReading()).toBe(true);
    expect(shadow.querySelector('.reading-view')).toBe(readingView);
    expect(shell.scroller.scrollTop).toBe(834);
  });

  it('keeps wide tables in a keyboard-scrollable wrapper and preserves MathML/inline semantics', () => {
    const doc = paper();
    doc.blocks.push({ id: 'untrusted', type: 'paragraph', html: '<strong style="background:url(private.png)" onclick="alert(1)">Safe emphasis</strong><script>secretScript()</script><img src="pixel.png"><svg><text>hidden graphic</text></svg><iframe src="https://bad.invalid"></iframe><a href="javascript:alert(1)">Unsafe URL</a><a href="https://example.org">Valid link</a>' });
    const { shadow } = mount({}, doc);
    const table = shadow.querySelector('.table-scroll')!;
    expect(table.getAttribute('tabindex')).toBe('0');
    expect(table.getAttribute('aria-label')).toContain('横向滚动');
    expect(table.querySelectorAll('th')).toHaveLength(2);
    expect(table.querySelector('th')?.getAttribute('colspan')).toBe('2');
    expect(table.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(shadow.querySelector('math msup')?.textContent).toBe('x2');
    expect(shadow.querySelector('#paragraph-one strong')?.textContent).toBe(SECRET_TEXT);
    const untrusted = shadow.getElementById('untrusted')!;
    expect(untrusted.querySelector('script,img,svg,iframe,[style],[onclick]')).toBeNull();
    expect(untrusted.textContent).not.toContain('secretScript');
    expect(untrusted.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(untrusted.querySelector('a[href]')?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('only requests original-page restoration through the explicit panel action', () => {
    const { shell, shadow, onRestore } = mount();
    namedButton(shadow, '周报内容整理').click();
    expect(onRestore).not.toHaveBeenCalled();
    shell.setPrivacy(true); shell.togglePanel();
    namedButton(shell.panel, '恢复原页面').click();
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it('retains failed image labels and supports retry inside its own preview', () => {
    const { shell, shadow } = mount({ imageMode: 'thumbnail' });
    shadow.querySelector('.image-block img')!.dispatchEvent(new Event('error'));
    expect(shadow.querySelector('.image-block img')).toBeNull();
    expect(shadow.querySelector('.image-block')?.textContent).toContain('图片 7');
    expect(shadow.querySelector('.image-failed')?.textContent).toContain('重试');
    shadow.querySelector<HTMLButtonElement>('.image-trigger')!.click();
    shadow.querySelector('.preview-body img')!.dispatchEvent(new Event('error'));
    expect(shadow.querySelector('.preview-body img')).toBeNull();
    expect(shadow.querySelector('.preview-caption')?.textContent).toBe(SECRET_CAPTION);
    namedButton(shadow, '重试').click();
    expect(shadow.querySelector<HTMLImageElement>('.preview-body img')?.src).toBe(IMAGE);
    expect(shell.isPanelOpen()).toBe(false);
  });

  it('does not silently delete an unavailable image and closes previews on document replacement', () => {
    const doc = paper();
    const image = doc.blocks.find(block => block.type === 'image')!;
    if (image.type === 'image') image.src = undefined;
    const { shell, shadow } = mount({}, doc);
    shadow.querySelector<HTMLButtonElement>('.image-trigger')!.click();
    expect(shadow.querySelector('.preview-body')?.textContent).toContain('暂时无法显示');
    expect(shadow.querySelector('.preview-body img')).toBeNull();
    expect(shadow.querySelector('.preview-caption')?.textContent).toBe(SECRET_CAPTION);
    shell.setDocument({ ...paper(), id: 'another-paper' });
    expect(shell.isPreviewOpen()).toBe(false);
    expect(shell.isPanelOpen()).toBe(false);
  });

  it('does not let a background document update leave the selected neutral conversation', () => {
    const { shell, shadow } = mount();
    shell.scroller.scrollTop = 931;
    namedButton(shadow, '周报内容整理').click();
    shell.togglePanel();
    shell.setDocument({ ...paper(), id: 'replacement', title: 'Replacement original title' });
    expect(shell.isReading()).toBe(false);
    expect(shell.isPanelOpen()).toBe(false);
    expect(shell.isPreviewOpen()).toBe(false);
    expect(shell.scroller.scrollTop).toBe(0);
    expect(shadow.querySelector('.header-title')?.textContent).toBe('周报内容整理');
    expect(shadow.querySelector('.title-bubble')?.textContent).not.toBe('Replacement original title');
    namedButton(shadow, '项目方案讨论').click();
    expect(shadow.querySelector('.title-bubble')?.textContent).toBe('Replacement original title');
  });

  it('fails closed with visible recovery, while keeping the normal panel hidden', () => {
    const onRetry = vi.fn(); const onRestore = vi.fn(); const onReloadSource = vi.fn();
    const shell = new ChatReaderShell({ ...DEFAULT_SETTINGS }, { onSettings: vi.fn(), onRetry, onRestore, onReloadSource });
    shell.mount(); shell.setDocument(paper()); mounted.push(shell);
    shell.togglePanel();
    shell.setStatus('error');
    expect(shell.isPanelOpen()).toBe(false);
    expect(shell.isPreviewOpen()).toBe(false);
    expect(shell.shadow.querySelector('.reading-view')).toBeNull();
    expect(shell.shadow.textContent).not.toContain(SECRET_TEXT);
    expect(shell.shadow.textContent).not.toContain(SECRET_SOURCE);
    expect(shell.shadow.querySelector('.reading-status')?.textContent).toContain('暂时无法继续');
    expect(onRestore).not.toHaveBeenCalled();
    const recovery = shell.shadow.querySelector('.recovery')!;
    namedButton(recovery, '重新连接').click();
    namedButton(recovery, '刷新来源').click();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onReloadSource).toHaveBeenCalledOnce();
    expect(onRestore).not.toHaveBeenCalled();
    shell.setPrivacy(true);
    expect(shell.shadow.querySelector('.recovery')).toBeNull();
    shell.togglePanel();
    expect(shell.panel.querySelector('.source-info,.toc-list')).toBeNull();
  });

  it('keeps local reading separate from explicit source navigation', () => {
    const onNavigate = vi.fn(); const onLocateSource = vi.fn();
    const shell = new ChatReaderShell({ ...DEFAULT_SETTINGS }, { onSettings: vi.fn(), onRestore: vi.fn(), onNavigate, onLocateSource });
    shell.mount(); shell.setDocument(paper()); mounted.push(shell);
    Object.defineProperties(shell.scroller, { clientHeight: {value:600}, scrollHeight:{value:2500} });
    shell.navigate('next');
    expect(shell.scroller.scrollTop).toBe(520);
    expect(onNavigate).not.toHaveBeenCalled();
    shell.setNavigation({previous:true,next:true,busy:false});
    shell.setSourceLocation({available:false,pendingChapter:true});
    shell.togglePanel();
    expect(namedButton(shell.panel,'切换并定位到来源章节').disabled).toBe(true);
    namedButton(shell.panel,'下一章').click();
    expect(onNavigate).toHaveBeenCalledWith('next');
    expect(shell.scroller.scrollTop).toBe(520);
    shell.setSourceLocation({available:true,pendingChapter:true});
    namedButton(shell.panel,'切换并定位到来源章节').click();
    expect(onLocateSource).toHaveBeenCalledOnce();
  });

  it('leaves readable overlap above a composer that covers the bottom of the viewport', () => {
    const shell = new ChatReaderShell({ ...DEFAULT_SETTINGS }, { onSettings: vi.fn(), onRestore: vi.fn(), onNavigate: vi.fn() });
    shell.mount(); shell.setDocument(paper()); mounted.push(shell);
    Object.defineProperties(shell.scroller, { clientHeight: { value: 600 }, scrollHeight: { value: 2500 } });
    shell.scroller.getBoundingClientRect = () => ({ top: 50, bottom: 650, left: 0, right: 800, height: 600 }) as DOMRect;
    shell.shadow.querySelector<HTMLElement>('.composer-wrap')!.getBoundingClientRect = () => ({ top: 510, bottom: 650, left: 0, right: 800, height: 140 }) as DOMRect;
    shell.navigate('next');
    // Only 460px is readable; leave another 80px of already-read context.
    expect(shell.scroller.scrollTop).toBe(380);
    shell.navigate('previous');
    expect(shell.scroller.scrollTop).toBe(0);
  });
});
