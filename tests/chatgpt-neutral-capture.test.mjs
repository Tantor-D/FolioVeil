import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const collector = readFileSync('tooling/capture-chatgpt-neutral.browser.js', 'utf8');
const prompt = JSON.parse(collector.match(/\}\)\(("(?:[^"\\]|\\.)*"), window\.__fvCaptureState/)[1]);

function capture({ extraMessage = false, foreignImage = false, prepare, cssText = '.frame { display: grid }' } = {}) {
  const dom = new JSDOM(`<!doctype html><html class="light"><head><style>.frame { display: grid }</style></head><body>
    <div class="Layout-SYw9n4"><div class="fixture-layers"><div><nav data-app-navigation-rail></nav></div><div><aside><a href="/c/private-fixture" data-conversation-options-trigger="private-fixture" title="PRIVATE_HISTORY_SENTINEL">PRIVATE_HISTORY_SENTINEL</a><img src="https://private.invalid/avatar" alt="PRIVATE_ACCOUNT_SENTINEL"></aside></div></div>
    <main><article data-message-author-role="user"><div class="whitespace-pre-wrap"></div></article>
    <article data-message-author-role="assistant"><div class="MarkdownRoot-fixture"><h1>中性示例</h1><p>中性段落</p><blockquote>中性引用</blockquote><table><tbody><tr><td>中性单元格</td></tr></tbody></table><pre><code>print(1)</code></pre><p><span data-math-display="false" data-math-source="x=1">x=1</span></p><p><img alt="中性标志" src="${foreignImage ? 'https://private.invalid/secret' : 'https://www.w3.org/Icons/w3c_home.png'}"></p></div></article>
    <form><div role="textbox" class="original-editor" contenteditable="true" aria-valuetext="UNSENT_DRAFT_SENTINEL"><p data-placeholder="中性输入提示">UNSENT_DRAFT_SENTINEL</p></div><input value="UNSENT_INPUT_SENTINEL"><textarea>UNSENT_TEXTAREA_SENTINEL</textarea></form></main></div>
    <script>window.privateState='PRIVATE_SCRIPT_SENTINEL'</script></body></html>`, { url: 'https://chatgpt.com/c/private-fixture', runScripts: 'outside-only' });
  const { window } = dom;
  window.document.querySelector('.whitespace-pre-wrap').textContent = prompt;
  if (extraMessage) window.document.querySelector('main').append(window.document.querySelector('[data-message-author-role="user"]').cloneNode(true));
  prepare?.(window.document);
  Object.defineProperty(window.document, 'styleSheets', { value: [{ href: null, media: { mediaText: '' }, disabled: false, cssRules: [{ cssText }] }] });
  let output;
  window.Blob = class { constructor(parts) { output = JSON.parse(parts.join('')); this.size = parts.join('').length; } };
  window.URL.createObjectURL = () => 'blob:local-fixture';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  window.console.log = () => {};
  window.setTimeout = () => 0;
  try { window.eval(collector); return output; }
  finally { window.close(); }
}

describe('neutral ChatGPT capture boundary', () => {
  it('removes drafts, account/history text and scripts before serializing while retaining the editor structure', () => {
    const output = capture();
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE_\w+_SENTINEL|UNSENT_\w+_SENTINEL|\/c\/private-fixture/);
    const document = new JSDOM(output.html).window.document;
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('.original-editor > p')?.textContent).toBe('');
    expect(document.querySelector('.original-editor > p')?.getAttribute('data-placeholder')).toBe('中性输入提示');
    expect(document.querySelector('[data-local-slot="user"]')?.textContent).toBe(prompt);
    expect(document.querySelector('[data-local-slot="assistant"] table td')?.textContent).toBe('中性单元格');
    expect(output.styles[0].cssText).toBe('.frame { display: grid }');
  });

  it('rejects an additional exchange rather than exporting unreviewed conversation text', () => {
    expect(() => capture({ extraMessage: true })).toThrow('exact neutral exchange required');
  });

  it('rejects unexpected resources inside the permitted neutral exchange', () => {
    expect(() => capture({ foreignImage: true })).toThrow('unexpected neutral image resource');
  });

  it('clears draft metadata and text throughout editable descendants while preserving the neutral placeholder and DOM structure', () => {
    const output = capture({ prepare(document) {
      const editor = document.querySelector('.original-editor');
      editor.setAttribute('value', 'UNSENT_ROOT_VALUE_SENTINEL');
      editor.querySelector('p').setAttribute('aria-valuetext', 'UNSENT_PARAGRAPH_ARIA_SENTINEL');
      editor.querySelector('p').setAttribute('value', 'UNSENT_PARAGRAPH_VALUE_SENTINEL');
      editor.querySelector('p').insertAdjacentHTML('beforeend', '<span class="original-draft-wrapper" contenteditable="false" aria-valuetext="UNSENT_CHILD_ARIA_SENTINEL" value="UNSENT_CHILD_VALUE_SENTINEL"><b>UNSENT_CHILD_TEXT_SENTINEL</b></span>');
      for (const node of document.querySelectorAll('input,textarea')) node.setAttribute('aria-valuetext', 'UNSENT_FIELD_ARIA_SENTINEL');
    } });
    expect(JSON.stringify(output)).not.toMatch(/UNSENT_\w+_SENTINEL/);
    const document = new JSDOM(output.html).window.document;
    const editor = document.querySelector('.original-editor');
    expect(editor.textContent).toBe('');
    expect(editor.querySelectorAll('*')).toHaveLength(3);
    expect(editor.querySelector('p > .original-draft-wrapper > b')).not.toBeNull();
    expect(editor.querySelector('p').getAttribute('data-placeholder')).toBe('中性输入提示');
    expect(editor.querySelector('[contenteditable="false"]')).not.toBeNull();
    expect(document.querySelector('[value],[aria-valuetext]')).toBeNull();
    expect(document.querySelector('textarea').textContent).toBe('');
  });

  it('records live loading, scroll, sidebar and image geometry without guessing browser zoom', () => {
    const output = capture({ prepare(document) {
      Object.defineProperty(document, 'fonts', { value: { status: 'loaded' } });
      document.documentElement.className = 'dark';
      document.documentElement.style.colorScheme = 'dark';
      document.documentElement.setAttribute('data-chat-theme', 'black');
      document.documentElement.setAttribute('data-contrast', 'default');
      document.documentElement.setAttribute('data-ds-colored-user-message-bubbles', 'true');
      const main = document.querySelector('main');
      main.setAttribute('data-scroll-root', ''); main.scrollTop = 12; main.scrollLeft = 3;
      main.getBoundingClientRect = () => ({ x: 67, y: 52, width: 800, height: 500 });
      Object.defineProperties(main, { clientHeight: { value: 500 }, scrollHeight: { value: 1800 }, clientWidth: { value: 800 }, scrollWidth: { value: 900 } });
      const sidebar = document.querySelector('aside'); sidebar.id = 'stage-slideover-sidebar'; sidebar.setAttribute('data-state', 'open');
      sidebar.getBoundingClientRect = () => ({ x: 0, y: 0, width: 260, height: 700 });
      sidebar.insertAdjacentHTML('beforeend', '<div><div inert style="opacity:0"></div></div><div id="stage-sidebar-tiny-bar" style="display:none"></div><section style="overflow-y:auto"></section>');
      const pane = sidebar.querySelector('div > div'); pane.getBoundingClientRect = () => ({ x: 0, y: 0, width: 260, height: 700 });
      const nestedScroll = sidebar.querySelector('section');
      Object.defineProperties(nestedScroll, { clientHeight: { value: 200 }, scrollHeight: { value: 500 } });
      nestedScroll.getBoundingClientRect = () => ({ x: 0, y: 80, width: 260, height: 200 });
      const img = main.querySelector('img');
      Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 72 }, naturalHeight: { value: 48 } });
      img.getBoundingClientRect = () => ({ x: 80, y: 900, width: 72, height: 48 });
    } });
    expect(output.source.fontStatus).toBe('loaded'); expect(output.source.browserZoom).toBe('unknown');
    expect(output.measurements.rootTheme).toEqual({ themeClasses: ['dark'], inlineColorScheme: 'dark', computedColorScheme: 'dark', chatTheme: 'black', contrast: 'default', coloredUserMessageBubbles: 'true' });
    const scroll = output.measurements.scrollContainers.find(node => node.scope === 'message-scroll-root');
    expect(scroll).toMatchObject({ scrollTop: 12, scrollLeft: 3, scrollHeight: 1800, clientHeight: 500, rectangle: { x: 67, y: 52, width: 800, height: 500 } });
    expect(output.measurements.scrollContainers.filter(node => node.scope === 'message-scroll-root')).toHaveLength(1);
    expect(output.measurements.scrollContainers.find(node => node.scope === 'sidebar')).toMatchObject({ scrollTop: 0, scrollHeight: 500, clientHeight: 200 });
    expect(output.measurements.sidebars[0].nodes[0]).toMatchObject({ state: 'open', visibleByLayout: true, inert: false });
    expect(output.measurements.sidebars[1].nodes[0]).toMatchObject({ visibleByLayout: false, display: 'none' });
    expect(output.measurements.sidebars[2].nodes[0]).toMatchObject({ visibleByLayout: false, inert: true, opacity: '0' });
    expect(output.measurements.images).toEqual([{ index: 0, complete: true, naturalWidth: 72, naturalHeight: 48, rectangle: { x: 80, y: 900, width: 72, height: 48 } }]);
  });

  it('keeps the added evidence free of text, resource URLs and arbitrary node identifiers', () => {
    const output = capture({ prepare(document) {
      document.documentElement.classList.add('PRIVATE_ROOT_CLASS_SENTINEL');
      document.documentElement.setAttribute('data-chat-theme', 'PRIVATE_THEME_SENTINEL');
      const node = document.querySelector('aside'); node.id = 'PRIVATE_SCROLL_ID_SENTINEL'; node.className = 'PRIVATE_SCROLL_CLASS_SENTINEL'; node.scrollTop = 18;
      node.setAttribute('data-reference', 'https://private.invalid/PRIVATE_URL_SENTINEL');
    } });
    const evidence = JSON.stringify({ source: output.source, rootTheme: output.measurements.rootTheme, scrollContainers: output.measurements.scrollContainers, sidebars: output.measurements.sidebars, images: output.measurements.images });
    expect(evidence).not.toMatch(/PRIVATE_\w+_SENTINEL|UNSENT_\w+_SENTINEL|private\.invalid|\/c\/private-fixture|中性标志/);
    expect(output.source.fontStatus).toBe('unknown');
    expect(output.source.browserZoom).toBe('unknown');
    expect(output.measurements.rootTheme).toMatchObject({ themeClasses: ['light'], chatTheme: 'unknown' });
    expect(output.measurements.images[0]).toMatchObject({ naturalWidth: 0, naturalHeight: 0 });
  });

  it('rewrites known local SVG, CSS and accessibility ID references before rejecting unknown identifiers without broadening resource permissions', () => {
    const privateID = '00000000-0000-4000-8000-000000000000';
    const unknownID = '11111111-1111-4111-8111-111111111111';
    const remoteSprite = 'https://static.example.invalid/sprite.svg#neutral-symbol';
    const externalCSS = `https://static.example.invalid/sprite.svg#${privateID}`;
    const output = capture({
      cssText: `.local-mask { clip-path: url("#${privateID}"); background-image: url("${externalCSS}") }`,
      prepare(document) {
        document.querySelector('aside').insertAdjacentHTML('beforeend', `
          <span id="local-neutral-id-1"></span><span id="stable-label"></span>
          <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
            <defs><clipPath id="${privateID}"><rect width="4" height="4"></rect></clipPath></defs>
            <use class="local-href" href="#${privateID}"></use>
            <use class="local-xlink" xlink:href="#${privateID}"></use>
            <use class="remote-sprite" href="${remoteSprite}"></use>
            <use class="remote-sensitive" href="https://static.example.invalid/sprite.svg#${privateID}"></use>
            <use class="unknown-local" href="#${unknownID}"></use>
            <rect class="local-mask" clip-path="url('#${privateID}')" style="filter: url(#${privateID})"></rect>
          </svg>
          <button class="local-aria" aria-labelledby="${privateID} stable-label" aria-controls="${privateID}" aria-describedby="${privateID}" aria-owns="${privateID}" aria-activedescendant="${privateID}" data-unreviewed="${unknownID}"></button>
        `);
      },
    });
    const document = new JSDOM(output.html).window.document;
    const replacement = document.querySelector('clipPath').id;
    expect(replacement).toBe('local-neutral-id-2');
    expect(document.querySelectorAll('[id="local-neutral-id-1"]')).toHaveLength(1);
    expect(document.querySelector('.local-href').getAttribute('href')).toBe(`#${replacement}`);
    expect(document.querySelector('.local-xlink').getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe(`#${replacement}`);
    expect(document.querySelector('.local-mask').getAttribute('clip-path')).toBe(`url('#${replacement}')`);
    expect(document.querySelector('.local-mask').getAttribute('style')).toBe(`filter: url(#${replacement})`);
    expect(document.querySelector('.local-aria').getAttribute('aria-labelledby')).toBe(`${replacement} stable-label`);
    for (const name of ['aria-controls', 'aria-describedby', 'aria-owns', 'aria-activedescendant']) expect(document.querySelector('.local-aria').getAttribute(name)).toBe(replacement);
    expect(document.querySelector('.local-aria').hasAttribute('data-unreviewed')).toBe(false);
    expect(document.querySelector('.unknown-local').hasAttribute('href')).toBe(false);
    expect(document.querySelector('.remote-sensitive').hasAttribute('href')).toBe(false);
    expect(document.querySelector('.remote-sprite').getAttribute('href')).toBe(remoteSprite);
    expect(output.styles[0].cssText).toBe(`.local-mask { clip-path: url("#${replacement}"); background-image: url("${externalCSS}") }`);
    expect(output.html).not.toContain(privateID);
    expect(output.html).not.toContain(unknownID);
    expect(output.redactions.ids).toBe(1);
  });
});
