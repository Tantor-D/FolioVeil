import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { localize } from '../experiments/chatgpt-local-replay/localize.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const SOURCE = 'packages/theme-chatgpt/capture/document-source.json';
const SEND_BUTTON = 'packages/theme-chatgpt/capture/send-button.json';
const BLOCKS = ['paragraph','heading1','heading2','heading3','heading4','heading5','heading6','orderedList','unorderedList','listItem','quote','code','table','image','math'];
const within = (root, value) => { const resolved = path.resolve(root, value); if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Captured theme input outside project'); return resolved; };
async function configuration(root) {
  let value; try { value = JSON.parse(await readFile(path.join(root, SOURCE), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (value.format !== 'folioveil-captured-document-source') throw new Error('Unsupported captured document source');
  return { ...value, capture: within(root, value.capture), assetCache: within(root, value.assetCache), assetOverlay: value.assetOverlay ? within(root, value.assetOverlay) : undefined };
}
/** Exact source bytes which can affect the packaged document, including fonts. */
export async function capturedThemeInputs(root) {
  const config = await configuration(root); if (!config) return [];
  const cache = JSON.parse(await readFile(path.join(config.assetCache, 'manifest.json'), 'utf8'));
  const overlay = config.assetOverlay ? JSON.parse(await readFile(path.join(config.assetOverlay, 'manifest.json'), 'utf8')) : undefined;
  return [...new Set([path.join(root, SOURCE), path.join(root, SEND_BUTTON), config.capture, path.join(config.assetCache, 'manifest.json'), ...cache.resources.map(record => within(config.assetCache, record.file)), ...Object.values(config.tabIcons ?? {}).map(file => within(root, file)), ...Object.values(config.supplements ?? {}).map(file => within(root, file)), ...(config.sidebarStates ? [within(root, config.sidebarStates.expandedCapture)] : []), ...(config.colorStates ? Object.values(config.colorStates).map(file => within(root, file)) : []), ...(overlay ? [path.join(config.assetOverlay, 'manifest.json'), ...overlay.resources.map(record => within(config.assetOverlay, record.file))] : [])])].sort();
}
function unique(document, selector, label) {
  const nodes = document.querySelectorAll(selector);
  if (nodes.length !== 1) throw new Error(`Captured theme ${label} must match once (got ${nodes.length})`);
  return nodes[0];
}
function mark(node, name) { node.setAttribute('data-fv-frame-node', name); return `[data-fv-frame-node="${name}"]`; }
function content(root, selector, label) { return selector === ':scope' ? root : unique(root, selector, label); }

/** Generate an executable-code-free, self-contained local package. No network. */
export async function buildCapturedTheme(root, output) {
  const config = await configuration(root); if (!config) return undefined;
  const temporary = await mkdtemp(path.join(tmpdir(), 'folioveil-captured-theme-'));
  try {
    const replay = path.join(temporary, 'replay');
    await mkdir(replay);
    await cp(path.join(config.assetCache, 'assets'), path.join(replay, 'assets'), { recursive: true });
    await cp(path.join(config.assetCache, 'manifest.json'), path.join(replay, 'manifest.json'));
    if (config.assetOverlay) {
      const cached = JSON.parse(await readFile(path.join(replay, 'manifest.json'), 'utf8'));
      const overlay = JSON.parse(await readFile(path.join(config.assetOverlay, 'manifest.json'), 'utf8'));
      for (const record of overlay.resources) {
        const bytes = await readFile(within(config.assetOverlay, record.file));
        if (hash(bytes) !== record.hash) throw new Error('Captured asset overlay hash mismatch: ' + record.file);
        await writeFile(within(replay, record.file), bytes);
        cached.resources = cached.resources.filter(item => item.url !== record.url); cached.resources.push(record);
      }
      await writeFile(path.join(replay, 'manifest.json'), json(cached));
    }
    const result = await localize(config.capture, replay, { offline: true, reuseAssets: true });
    if (result.verification.status === 'failed') throw new Error('Captured theme localization failed: ' + JSON.stringify(result.verification.issues));
    const captureBytes = await readFile(config.capture);
    const capture = JSON.parse(captureBytes.toString());
    const localized = JSON.parse(await readFile(path.join(replay, 'manifest.json'), 'utf8'));
    const document = new JSDOM(await readFile(path.join(replay, 'reference.html'), 'utf8')).window.document;
    // The old capture had two unnamed pinned rows; the current Home capture
    // has an empty pinned section. Neither belongs in the local reader.
    const pinnedLabels = [...document.querySelectorAll('span')].filter(node =>
      !node.classList.contains('sr-only') && [...node.childNodes].some(child => child.nodeType === 3 && ['置顶', 'Pinned'].includes(child.textContent.trim())));
    if (pinnedLabels.length !== 1) throw new Error('Captured pinned section is ambiguous');
    const pinnedSection = pinnedLabels[0].closest('section');
    const pinnedRail = document.querySelector('button[aria-label="置顶"],button[aria-label="Pinned"]');
    if (!pinnedSection || ![0, 2].includes(pinnedSection.querySelectorAll('[role="listitem"]').length)) throw new Error('Captured pinned section changed');
    pinnedSection.remove();
    pinnedRail?.parentElement?.remove();
    const user = unique(document, capture.slots.user, 'user content'), assistant = unique(document, capture.slots.assistant, 'assistant content');
    let flow = user.parentElement;
    while (flow && !flow.contains(assistant)) flow = flow.parentElement;
    if (!flow || flow === document.body) throw new Error('No bounded captured message flow');
    const branch = node => { while (node.parentElement !== flow) node = node.parentElement; return node; };
    const messages = {};
    for (const [name, node] of [['user', user], ['assistant', assistant]]) {
      const root = branch(node);
      const width = node.closest(config.selectors.contentWidth);
      if (!width || !root.contains(width)) throw new Error(`Captured ${name} content width ancestor missing`);
      width.setAttribute('data-fv-content-width', '');
      messages[name] = { selector: mark(root, `message-${name}`), contentSelector: mark(node, `content-${name}`) };
    }
    const selectors = { messageFlow: mark(flow, 'message-flow') };
    for (const name of ['scroller','sidebar','conversationList','composer']) selectors[name] = mark(unique(document, config.selectors[name], name), name);
    const sendCapture = JSON.parse(await readFile(path.join(root, SEND_BUTTON), 'utf8'));
    const sendTemplate = document.createElement('template'); sendTemplate.innerHTML = sendCapture.html;
    const sendButton = unique(sendTemplate.content, 'button', 'captured send button');
    sendButton.setAttribute('type', 'button'); sendButton.setAttribute('data-fv-action', 'fetchMore');
    const composer = unique(document, selectors.composer, 'composer');
    unique(composer, 'button[aria-label="开始语音"],button[aria-label="Start Voice"]', 'composer primary action').replaceWith(sendButton);
    const sidebarItem = unique(document, config.selectors.sidebarItem, 'sidebar item');
    messages.sidebarItem = { selector: mark(sidebarItem, 'sidebar-item'), contentSelector: mark(content(sidebarItem, config.selectors.sidebarItemContent, 'sidebar text'), 'sidebar-item-content') };
    const blocks = {};
    for (const binding of config.actions ?? []) {
      const nodes = document.querySelectorAll(binding.selector);
      if (nodes.length !== binding.cardinality || !['toggleSidebar','newConversation','showControls'].includes(binding.action)) throw new Error('Ambiguous captured action binding');
      nodes.forEach(node => node.setAttribute('data-fv-action', binding.action));
    }
    // The captured toggle sits inside the content layer, which becomes inert
    // when the sidebar closes. Reuse that exact button in the persistent rail.
    const sidebarToggle = unique(document, '[data-fv-action="toggleSidebar"]', 'sidebar toggle');
    const rail = unique(document, config.sidebarStates.selectors[2], 'sidebar rail');
    const reopenToggle = sidebarToggle.cloneNode(true);
    reopenToggle.setAttribute('data-fv-sidebar-reopen', '');
    reopenToggle.setAttribute('aria-expanded', 'false');
    rail.insertBefore(reopenToggle, rail.children[1] ?? null);
    for (const [kind, spec] of Object.entries(config.blocks)) {
      if (!BLOCKS.includes(kind)) throw new Error('Unknown captured block kind: ' + kind);
      const root = unique(document, spec.selector, kind), target = content(root, spec.contentSelector, `${kind} content`);
      if (!assistant.contains(root)) throw new Error('Block template outside captured assistant content: ' + kind);
      // Separate attributes permit overlapping, genuinely captured list/item templates.
      root.setAttribute(`data-fv-template-${kind.toLowerCase()}`, '');
      target.setAttribute(`data-fv-content-${kind.toLowerCase()}`, '');
      blocks[kind] = { selector: `[data-fv-template-${kind.toLowerCase()}]`, contentSelector: root === target ? ':scope' : `[data-fv-content-${kind.toLowerCase()}]` };
      if (kind === 'code' || kind === 'table') {
        for (const button of root.querySelectorAll('button')) {
          if (/^(?:复制|Copy)$/.test(button.getAttribute('aria-label') ?? '')) { button.setAttribute('data-fv-content-action', 'copy'); button.setAttribute('type', 'button'); }
          else button.setAttribute('inert', '');
        }
        if (kind === 'code') {
          const label = [...root.querySelectorAll('div')].find(node => [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim() === 'Python'));
          if (!label) throw new Error('Captured code language label is missing');
          for (const text of [...label.childNodes].filter(node => node.nodeType === 3)) text.textContent = text.textContent.trim() ? 'Code' : '';
        }
      }
    }
    // The source site's handlers are deliberately absent. Retain its controls
    // and styling, but stop controls without a local action from accepting input.
    for (const button of document.querySelectorAll('button')) {
      if (!button.hasAttribute('data-fv-action') && !button.hasAttribute('data-fv-content-action')) button.setAttribute('inert', '');
    }
    const scrollToBottom = unique(document, 'main:has([data-local-slot="assistant"]) button[aria-label="滚动到底部"],main:has([data-local-slot="assistant"]) button[aria-label="Scroll to bottom"]', 'captured scroll button');
    scrollToBottom.style.display = 'none';
    scrollToBottom.setAttribute('aria-hidden', 'true');
    const supplements = [];
    for (const [kind, filename] of Object.entries(config.supplements ?? {})) {
      if (!BLOCKS.includes(kind) || blocks[kind]) throw new Error('Duplicate or unknown supplementary template');
      const bytes = await readFile(within(root, filename)), supplement = JSON.parse(bytes.toString());
      const styles = new Set(capture.styles.map(style => hash(style.cssText)));
      if (supplement.format !== 'folioveil-captured-template-supplement' || !supplement.sourceStyles.every(value => styles.has(value))) throw new Error('Supplementary template styles do not match the captured document');
      const template = document.createElement('template'); template.innerHTML = supplement.html;
      if (template.content.children.length !== 1 || template.content.querySelector('script,iframe,object,embed,form,input,[contenteditable]')) throw new Error('Invalid supplementary template');
      for (const node of template.content.querySelectorAll('*')) for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || ['src','href','xlink:href','action','formaction'].includes(attr.name) || /url\(/i.test(attr.value)) throw new Error('Active supplementary template');
      template.setAttribute('data-fv-supplement', kind); document.body.append(template);
      blocks[kind] = { selector: `template[data-fv-supplement="${kind}"]`, contentSelector: ':scope', templateElement: true };
      supplements.push(`${kind}:captured-supplement-sha256:${hash(bytes)}; source:${supplement.sourceCaptureSha256}`);
    }
    const baseScheme = document.documentElement.getAttribute('data-theme');
    if (baseScheme !== 'light' && baseScheme !== 'dark') throw new Error('Captured color state is missing');
    const appearance = { [baseScheme]: { captureHash: hash(captureBytes), patches: [] } };
    let codeAppearance;
    if (config.colorStates?.darkCapture) {
      const darkBytes = await readFile(within(root, config.colorStates.darkCapture));
      const dark = JSON.parse(darkBytes.toString());
      const darkDOM = new JSDOM(dark.html).window.document;
      const themeRoot = document.documentElement, sample = darkDOM.documentElement;
      if (sample.getAttribute('data-theme') !== 'dark' || themeRoot.getAttribute('data-theme') !== 'light') throw new Error('Captured color states are not light/dark');
      appearance.light = { captureHash: hash(captureBytes), patches: [{ selector: 'html', attributes: { 'data-theme': 'light', 'data-appearance-theme': null } }] };
      appearance.dark = { captureHash: hash(darkBytes), patches: [{ selector: 'html', attributes: { 'data-theme': 'dark', 'data-appearance-theme': sample.getAttribute('data-appearance-theme') } }] };
      const codeRoot = unique(document, config.blocks.code.selector, 'light code state');
      const darkCodeRoot = unique(darkDOM, config.blocks.code.selector, 'dark code state');
      const wrapperSelector = '[data-markdown-copy="code-block"]';
      const codeState = element => {
        const wrapper = unique(element, wrapperSelector, 'code wrapper');
        return { rootClass: element.getAttribute('class') ?? '', wrapperClass: wrapper.getAttribute('class') ?? '', theme: wrapper.getAttribute('data-theme') ?? '' };
      };
      codeAppearance = { wrapperSelector, light: codeState(codeRoot), dark: codeState(darkCodeRoot) };
      if (codeAppearance.light.theme !== 'light' || codeAppearance.dark.theme !== 'dark') throw new Error('Captured code color states are missing');
    }
    if (config.colorStates?.lightCapture) {
      const lightBytes = await readFile(within(root, config.colorStates.lightCapture));
      const light = JSON.parse(lightBytes.toString());
      const lightDOM = new JSDOM(light.html).window.document;
      if (baseScheme !== 'dark' || lightDOM.documentElement.getAttribute('data-theme') !== 'light') throw new Error('Captured color states are not dark/light');
      appearance.dark.patches.push({ selector: 'html', attributes: { 'data-theme': 'dark', 'data-appearance-theme': document.documentElement.getAttribute('data-appearance-theme') } });
      appearance.light = { captureHash: hash(lightBytes), patches: [{ selector: 'html', attributes: { 'data-theme': 'light', 'data-appearance-theme': lightDOM.documentElement.getAttribute('data-appearance-theme') } }] };
      const darkCode = unique(document, config.blocks.code.selector, 'dark code state');
      const lightCode = unique(lightDOM, config.blocks.code.selector, 'light code state');
      const wrapperSelector = '[data-markdown-copy="code-block"]';
      const codeState = element => {
        const wrapper = unique(element, wrapperSelector, 'code wrapper');
        return { rootClass: element.getAttribute('class') ?? '', wrapperClass: wrapper.getAttribute('class') ?? '', theme: wrapper.getAttribute('data-theme') ?? '' };
      };
      codeAppearance = { wrapperSelector, dark: codeState(darkCode), light: codeState(lightCode) };
    }
    if (config.sidebarStates) {
      const expandedBytes = await readFile(within(root, config.sidebarStates.expandedCapture)), expanded = JSON.parse(expandedBytes.toString());
      const styles = new Set(capture.styles.map(style => hash(style.cssText)));
      if (!expanded.styles.every(style => styles.has(hash(style.cssText)))) throw new Error('Expanded sidebar needs uncaptured styles');
      const collapsedDOM = new JSDOM(capture.html).window.document, expandedDOM = new JSDOM(expanded.html).window.document;
      const collapsedPatches = [], expandedPatches = [];
      for (const [index, selector] of config.sidebarStates.selectors.entries()) {
        const before = unique(collapsedDOM, selector, 'collapsed sidebar state'), after = unique(expandedDOM, selector, 'expanded sidebar state');
        const original = unique(document, selector, 'local sidebar state'); original.setAttribute('data-fv-state-node', String(index));
        const name = `[data-fv-state-node="${index}"]`, collapsedAttrs = {}, expandedAttrs = {};
        for (const attr of ['class','style','data-state','inert','aria-expanded','aria-hidden','data-app-shell-sidebar-open','data-app-shell-compact-page-gutter']) {
          if (before.getAttribute(attr) === after.getAttribute(attr)) continue;
          const left = before.getAttribute(attr), right = after.getAttribute(attr);
          if (attr === 'style' && /url\(|expression\(|@import/i.test((left ?? '') + (right ?? ''))) throw new Error('Unsafe sidebar style patch');
          collapsedAttrs[attr] = left; expandedAttrs[attr] = right;
        }
        collapsedPatches.push({ selector: name, attributes: collapsedAttrs }); expandedPatches.push({ selector: name, attributes: expandedAttrs });
      }
      appearance['sidebar-collapsed'] = { captureHash: hash(captureBytes), patches: collapsedPatches };
      appearance['sidebar-expanded'] = { captureHash: hash(expandedBytes), patches: expandedPatches };
      collapsedPatches.push({ selector: '[data-fv-sidebar-reopen]', attributes: { style: null } });
      expandedPatches.push({ selector: '[data-fv-sidebar-reopen]', attributes: { style: 'display: none;' } });
    }
    if (config.colorStates?.narrowDarkCollapsedCapture) {
      const narrowBytes = await readFile(within(root, config.colorStates.narrowDarkCollapsedCapture));
      const narrow = JSON.parse(narrowBytes.toString());
      if (narrow.source.viewport.width !== 400 || new JSDOM(narrow.html).window.document.documentElement.getAttribute('data-theme') !== 'dark') throw new Error('Narrow dark state is not the reviewed 400px capture');
      const narrowDOM = new JSDOM(narrow.html).window.document;
      const patches = [];
      for (const [index, selector] of config.sidebarStates.selectors.entries()) {
        const before = unique(document, selector, 'desktop state'), after = unique(narrowDOM, selector, 'narrow state');
        const attributes = {};
        for (const attr of ['class','style','data-state','inert','aria-expanded','aria-hidden','data-app-shell-sidebar-open','data-app-shell-compact-page-gutter']) {
          if (before.getAttribute(attr) === after.getAttribute(attr)) continue;
          const value = after.getAttribute(attr);
          if (attr === 'style' && /url\(|expression\(|@import/i.test(value ?? '')) throw new Error('Unsafe narrow style patch');
          attributes[attr] = value;
        }
        if (Object.keys(attributes).length) patches.push({ selector: `[data-fv-state-node="${index}"]`, attributes });
      }
      appearance['narrow-dark-collapsed'] = { captureHash: hash(narrowBytes), patches };
    }
    await mkdir(output, { recursive: true });
    const files = [];
    for (const file of [...new Set([...localized.resources, ...localized.styles].map(record => record.file))].sort()) {
      const bytes = await readFile(within(replay, file));
      await mkdir(path.dirname(path.join(output, file)), { recursive: true }); await writeFile(path.join(output, file), bytes);
      files.push({ file, sha256: hash(bytes), bytes: bytes.length, kind: /\.css$/.test(file) ? 'style' : /\.(woff2?|ttf|otf)$/.test(file) ? 'font' : 'image' });
    }
    const tabIcons = config.tabIcons ? {} : undefined;
    for (const format of ['ico', 'svg']) if (tabIcons) {
      const source = config.tabIcons[format];
      if (typeof source !== 'string' || !source.endsWith(`.${format}`)) throw new Error('Invalid captured tab icon source');
      const bytes = await readFile(within(root, source));
      if (format === 'svg' && /<\s*(?:script|foreignObject)\b|\bon\w+\s*=|\b(?:href|url)\s*=|url\s*\(/i.test(bytes.toString())) throw new Error('Unsafe captured tab icon');
      const file = `assets/chatgpt-favicon.${format}`;
      await mkdir(path.dirname(path.join(output, file)), { recursive: true });
      await writeFile(path.join(output, file), bytes);
      files.push({ file, sha256: hash(bytes), bytes: bytes.length, kind: 'image' });
      tabIcons[format] = file;
    }
    const html = '<!doctype html>\n' + document.documentElement.outerHTML;
    await writeFile(path.join(output, 'frame.html'), html);
    const manifest = {
      format: 'folioveil-captured-document', formatVersion: 1, id: 'chatgpt', packageHash: '',
      document: { file: 'frame.html', sha256: hash(html), bytes: Buffer.byteLength(html) }, files,
      selectors, messages, blocks, appearance, codeAppearance, tabIcons,
      evidence: { captureHash: hash(captureBytes), state: config.state, capturedAt: capture.source.capturedAt ?? null, viewport: capture.source.viewport, missingTemplates: BLOCKS.filter(kind => !blocks[kind]), browserReplay: 'not-checked', visualComparison: 'not-checked' },
      transformations: ['composer primary action replaced with neutral captured send-button.json; original button classes and icon retained; local fetchMore action only', ...localized.removed, ...supplements, `capture draft text nodes cleared before serialization:${Number(capture.redactions?.draftTextNodes ?? 0)}`, 'pinned section removed after verifying zero or two anonymized rows', 'captured sidebar toggle cloned into persistent rail for the collapsed state', 'official ChatGPT tab favicon bytes packaged without alteration', 'semantic-selector-markers-only; original root, classes, cascade and layout retained', 'unbound source controls inert; stale scroll-to-bottom control hidden', 'code language label neutralized; captured copy buttons bound locally; source execution inert', 'clone IDs are isolated by the runtime', 'application document owns CSP/title; replay CSP is not installed over source-image policy'],
      substitutedUnusedAssets: (localized.substitutedUnusedAssets ?? []).map(({ file, reason }) => ({ file, reason }))
    };
    manifest.packageHash = hash(JSON.stringify(manifest));
    await writeFile(path.join(output, 'manifest.json'), json(manifest));
    return manifest;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd(), output = path.resolve(process.argv[2] ?? 'dist/captured-chatgpt');
  const manifest = await buildCapturedTheme(root, output);
  if (!manifest) throw new Error('Missing captured document source configuration');
  console.log(JSON.stringify({ output, packageHash: manifest.packageHash, files: manifest.files.length, missingTemplates: manifest.evidence.missingTemplates, browserReplay: 'not-checked', visualComparison: 'not-checked' }, null, 2));
}
