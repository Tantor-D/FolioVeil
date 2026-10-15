#!/usr/bin/env node
/** Isolated ChatGPT display replay experiment. No source scripts are executed.
 * node localize.mjs capture.json [--out=DIR] [--offline] [--reuse-assets]
 * node localize.mjs --verify [DIR]
 * Download mode makes ordinary public requests without cookies or authorization.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const decodeCSS = value => value.replace(/\\([\da-f]{1,6})\s?|\\([^\r\n\f])/gi, (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char);
const quoted = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\f]/g, '')}"`;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

// Scan CSS tokens instead of matching url() inside comments or quoted text.
// Image-set's string form is a resource too. Other strings remain unchanged.
async function rewriteValue(value, rewrite, imageSet = false) {
  let output = '', i = 0;
  while (i < value.length) {
    const start = i;
    if (value.startsWith('/*', i)) {
      const end = value.indexOf('*/', i + 2); i = end < 0 ? value.length : end + 2;
      output += value.slice(start, i); continue;
    }
    if (value[i] === '"' || value[i] === "'") {
      const quote = value[i++]; let body = '';
      while (i < value.length && value[i] !== quote) { if (value[i] === '\\') body += value[i++]; body += value[i++] ?? ''; }
      if (value[i] === quote) i++;
      output += imageSet ? quoted(await rewrite(decodeCSS(body))) : value.slice(start, i); continue;
    }
    if (/[a-z_\\-]/i.test(value[i])) {
      while (i < value.length && /[\w\\-]/.test(value[i])) {
        if (value[i] === '\\') { const match = value.slice(i).match(/^\\(?:[\da-f]{1,6}\s?|[^\r\n\f])/i); i += match?.[0].length ?? 1; }
        else i++;
      }
      const name = decodeCSS(value.slice(start, i)).toLowerCase();
      if (value[i] !== '(') { output += value.slice(start, i); continue; }
      const opening = i++; let depth = 1, quote = '', comment = false;
      while (i < value.length && depth) {
        if (comment) { if (value.startsWith('*/', i)) { comment = false; i += 2; } else i++; continue; }
        if (quote) { if (value[i] === '\\') i += 2; else if (value[i++] === quote) quote = ''; continue; }
        if (value.startsWith('/*', i)) { comment = true; i += 2; continue; }
        if (value[i] === '"' || value[i] === "'") { quote = value[i++]; continue; }
        if (value[i] === '\\') { i += 2; continue; }
        if (value[i] === '(') depth++;
        if (value[i] === ')') depth--;
        i++;
      }
      if (depth) throw new Error('Unterminated CSS function');
      const body = value.slice(opening + 1, i - 1);
      if (name === 'url') {
        let raw = body.trim();
        if ((raw[0] === '"' || raw[0] === "'") && raw.at(-1) === raw[0]) raw = raw.slice(1, -1);
        output += `url(${quoted(await rewrite(decodeCSS(raw)))})`;
      } else output += value.slice(start, opening + 1) + await rewriteValue(body, rewrite, /^(?:-webkit-)?image-set$/.test(name)) + ')';
      continue;
    }
    output += value[i++];
  }
  return output;
}

async function rewriteCSS(css, resource, base, sheet = false) {
  const root = postcss.parse(css);
  const nodes = []; root.walk(node => nodes.push(node));
  for (const node of nodes) {
    if (node.type === 'decl') node.value = await rewriteValue(node.value, value => resource(value, base, false, sheet));
    if (node.type === 'atrule') {
      if (node.name.toLowerCase() === 'import') {
        const match = node.params.match(/^(\s*)(["'])((?:\\.|(?!\2).)*?)\2/s);
        if (match) node.params = match[1] + quoted(await resource(decodeCSS(match[3]), base, true, sheet)) + node.params.slice(match[0].length);
        else node.params = await rewriteValue(node.params, value => resource(value, base, true, sheet));
      } else node.params = await rewriteValue(node.params, value => resource(value, base, false, sheet));
    }
  }
  return root.toString();
}

async function rewriteSrcset(input, resource) {
  const result = []; let i = 0;
  while (i < input.length) {
    while (/[\s,]/.test(input[i] ?? '') && i < input.length) i++;
    const start = i; while (i < input.length && !/\s/.test(input[i])) i++;
    let url = input.slice(start, i); if (!url) break;
    const ended = /,$/.test(url); url = url.replace(/,+$/, '');
    let descriptor = '';
    if (!ended) { const begin = i; let depth = 0; while (i < input.length) { if (input[i] === '(') depth++; if (input[i] === ')') depth--; if (input[i] === ',' && depth === 0) break; i++; } descriptor = input.slice(begin, i).trim(); }
    result.push((await resource(url)) + (descriptor ? ' ' + descriptor : '')); i++;
  }
  return result.join(', ');
}

const URL_ATTRIBUTES = new Set(['src', 'href', 'xlink:href', 'poster', 'background']);
const PRESENTATION_ATTRIBUTES = new Set(['fill', 'stroke', 'filter', 'clip-path', 'mask', 'cursor', 'marker-start', 'marker-mid', 'marker-end']);
const ACTIVE_ATTRIBUTES = new Set(['action', 'formaction', 'form', 'formmethod', 'formtarget', 'formenctype', 'ping', 'srcdoc', 'autofocus']);
const FORM_FIELDS = new Set(['input', 'textarea', 'select']);
function cleanDocument(document, removals) {
  for (const element of [...document.querySelectorAll('script,base,iframe,frame,object,embed,meta[http-equiv],link')]) {
    if (element.localName === 'link' && element.relList.contains('stylesheet')) continue;
    removals.push(element.localName); element.remove();
  }
  for (const element of document.querySelectorAll('*')) {
    // Keep the captured form/editor structure and classes. Inert does not add
    // disabled-control styling, but prevents native editing, upload and submit
    // interactions in both the script-free reference and the local replay.
    if (element.localName === 'form' || FORM_FIELDS.has(element.localName) || element.hasAttribute('contenteditable')) {
      if (!element.hasAttribute('inert')) { element.setAttribute('inert', ''); removals.push(`${element.localName}:made-inert`); }
    }
    if (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false') {
      element.setAttribute('contenteditable', 'false'); removals.push('contenteditable:disabled');
    }
    if (element.localName === 'button' && (element.closest('form') || element.hasAttribute('form') || /^(submit|reset)$/i.test(element.getAttribute('type') ?? ''))) {
      if (element.getAttribute('type') !== 'button') { element.setAttribute('type', 'button'); removals.push('button:submission-disabled'); }
    }
    for (const attr of [...element.attributes]) {
      if (/^on/i.test(attr.name) || ACTIVE_ATTRIBUTES.has(attr.name) || ['nonce', 'integrity', 'crossorigin'].includes(attr.name)) element.removeAttribute(attr.name);
      else if (element.localName === 'a' && attr.name === 'href' && !attr.value.startsWith('#')) element.removeAttribute(attr.name);
    }
  }
}

function slotsOf(document, slots) {
  const found = {};
  for (const name of ['user', 'assistant']) {
    if (typeof slots?.[name] !== 'string') throw new Error(`Missing ${name} selector`);
    const nodes = document.querySelectorAll(slots[name]);
    if (nodes.length !== 1) throw new Error(`${name} slot must match exactly one node (got ${nodes.length})`);
    found[name] = nodes[0];
  }
  if (found.user.contains(found.assistant) || found.assistant.contains(found.user)) throw new Error('Message slots overlap');
  return found;
}
function textLeaves(document, element) {
  const nodes = [], walker = document.createTreeWalker(element, 4);
  while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) nodes.push(walker.currentNode);
  return nodes;
}
// Ignore only text within the two slots. Classes, nesting, attributes and all
// surrounding markup must remain identical between reference and local replay.
function shellSignature(document, slots) {
  const clone = document.documentElement.cloneNode(true);
  for (const selector of Object.values(slots)) for (const element of clone.querySelectorAll(selector)) {
    const walker = document.createTreeWalker(element, 4); while (walker.nextNode()) walker.currentNode.nodeValue = '';
  }
  for (const own of clone.querySelectorAll('[data-local-replay-owned]')) own.remove();
  return hash(clone.outerHTML);
}

async function visitResourceURLs(document, visit) {
  for (const element of document.querySelectorAll('*')) {
    for (const attr of element.attributes) {
      if (URL_ATTRIBUTES.has(attr.name)) await visit(attr.value);
      if (['srcset', 'imagesrcset'].includes(attr.name)) await rewriteSrcset(attr.value, visit);
      if (PRESENTATION_ATTRIBUTES.has(attr.name)) await rewriteValue(attr.value, visit);
    }
    if (element.hasAttribute('style')) await rewriteCSS(element.getAttribute('style'), visit, '');
    if (element.localName === 'style') await rewriteCSS(element.textContent, visit, '');
  }
}

const UNUSED_EXAMPLE_URL = 'https://example.com/x';
const UNUSED_EXAMPLE_CLASS = 'bg-[url(https://example.com/x)]';
async function isOnlyUnusedExample(capture, document) {
  if (document.getElementsByClassName(UNUSED_EXAMPLE_CLASS).length) return false;
  let references = 0, invalid = false;
  for (const sheet of capture.styles) {
    const root = postcss.parse(sheet.cssText), nodes = []; root.walk(node => nodes.push(node));
    for (const node of nodes) if (node.type === 'decl' || node.type === 'atrule') await rewriteValue(node.type === 'decl' ? node.value : node.params, async value => {
      if (value === UNUSED_EXAMPLE_URL) {
        references++;
        if (node.type !== 'decl' || node.prop !== 'background-image' || node.parent.type !== 'rule' || decodeCSS(node.parent.selector) !== '.' + UNUSED_EXAMPLE_CLASS) invalid = true;
      }
      return value;
    });
  }
  await visitResourceURLs(document, async value => { if (value === UNUSED_EXAMPLE_URL) invalid = true; return value; });
  return references > 0 && !invalid;
}

async function inlineSprites(document, directory) {
  const usages = [...document.querySelectorAll('use')].map(node => ({ node, attr: node.hasAttribute('href') ? 'href' : 'xlink:href', value: node.getAttribute('href') ?? node.getAttribute('xlink:href') })).filter(item => item.value && !item.value.startsWith('#'));
  const files = [...new Set(usages.map(item => item.value.split('#')[0]))], records = [];
  for (const file of files) {
    if (!/^assets\/[\da-f]+\.svg$/.test(file)) throw new Error('Unsupported external SVG use: ' + file);
    const svgDOM = new JSDOM(await readFile(path.join(directory, file), 'utf8'), { contentType: 'image/svg+xml' });
    const root = svgDOM.window.document.documentElement, prefix = `local-sprite-${hash(file).slice(0, 12)}-`;
    const symbols = new Map(); let duplicateSymbols = 0;
    for (const symbol of [...root.querySelectorAll('symbol[id]')]) {
      if (!symbols.has(symbol.id)) symbols.set(symbol.id, symbol.outerHTML);
      else if (symbols.get(symbol.id) === symbol.outerHTML) { symbol.remove(); duplicateSymbols++; }
      else throw new Error('Different SVG symbols share one ID: ' + symbol.id);
    }
    const all = [root, ...root.querySelectorAll('*')], globalIDs = new Map(), scopeIDs = new Map(), originalIDs = new Map();
    for (const node of all) if (node.id) {
      const id = node.id, symbol = node.localName === 'symbol' ? null : node.closest('symbol');
      const scope = symbol ? (scopeIDs.get(symbol) ?? new Map()) : globalIDs;
      if (symbol) scopeIDs.set(symbol, scope);
      if (scope.has(id)) throw new Error('Ambiguous SVG ID within one scope: ' + id);
      const local = prefix + (symbol ? symbol.id + '-' : '') + id;
      scope.set(id, local); originalIDs.set(node, local);
    }
    const remap = (node, value) => {
      if (!value.startsWith('#')) return value;
      const id = decodeURIComponent(value.slice(1)), symbol = node.closest('symbol');
      const local = scopeIDs.get(symbol)?.get(id) ?? globalIDs.get(id);
      if (!local) throw new Error('Missing internal SVG target: ' + id);
      return '#' + local;
    };
    for (const node of all) {
      for (const attr of [...node.attributes]) {
        if (['href', 'xlink:href'].includes(attr.name) && attr.value.startsWith('#')) node.setAttribute(attr.name, remap(node, attr.value));
        else if (PRESENTATION_ATTRIBUTES.has(attr.name) || attr.name === 'style') node.setAttribute(attr.name, await rewriteValue(attr.value, async value => remap(node, value)));
      }
      if (node.localName === 'style') throw new Error('SVG sprite stylesheet requires explicit selector mapping');
    }
    // Change IDs only after contextual references have been resolved.
    for (const [node, id] of originalIDs) node.id = id;
    const embedded = document.importNode(root, true);
    embedded.setAttribute('width', '0'); embedded.setAttribute('height', '0'); embedded.setAttribute('aria-hidden', 'true');
    embedded.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'); embedded.dataset.localReplayOwned = 'inline-sprite';
    document.body.append(embedded);
    let uses = 0;
    for (const usage of usages.filter(item => item.value.split('#')[0] === file)) {
      const id = decodeURIComponent(usage.value.split('#')[1] ?? ''), target = globalIDs.get(id);
      if (!target) throw new Error('Missing SVG symbol: ' + usage.value);
      usage.node.setAttribute(usage.attr, '#' + target); uses++;
    }
    records.push({ file, prefix, uses, ids: originalIDs.size, identicalDuplicateSymbolsRemoved: duplicateSymbols, method: 'inline-svg-with-scoped-prefixed-ids' });
  }
  return records;
}

export async function localize(capturePath, output, { offline = false, reuseAssets = false } = {}) {
  const capture = JSON.parse(await readFile(capturePath, 'utf8'));
  if (capture.schemaVersion !== 1 || !Array.isArray(capture.styles) || typeof capture.html !== 'string') throw new Error('Unsupported capture format');
  const base = new URL(capture.source?.url); if (base.origin !== 'https://chatgpt.com') throw new Error('Expected an authorized ChatGPT capture');
  await mkdir(path.join(output, 'assets'), { recursive: true });
  const manifest = { schemaVersion: 1, source: capture.source, captureHash: hash(await readFile(capturePath)), status: 'incomplete', offline, slots: capture.slots, styles: [], resources: [], missing: [], removed: [], checks: {} };
  const dom = new JSDOM(capture.html); const document = dom.window.document;
  cleanDocument(document, manifest.removed);
  const permitUnusedExample = await isOnlyUnusedExample(capture, document);
  const cache = new Map();
  let previous;
  if (reuseAssets) {
    try { previous = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let reused = 0, rejected = 0;
    for (const record of previous?.resources ?? []) {
      if (record.status !== 'saved') continue;
      const filename = path.resolve(output, record.file);
      if (!filename.startsWith(path.resolve(output, 'assets') + path.sep)) { rejected++; continue; }
      try {
        const bytes = await readFile(filename);
        if (hash(bytes) !== record.hash) { rejected++; continue; }
        cache.set(record.url, record.file);
        manifest.resources.push({ ...record, reused: true }); reused++;
      } catch { rejected++; }
    }
    // Validate each container's actual local dependency closure; an unrelated
    // failed URL must not invalidate an otherwise complete sprite or stylesheet.
    let reprocessContainers = 0;
    const validFiles = new Set(manifest.resources.map(record => path.resolve(output, record.file))), dependencies = new Map();
    for (const record of manifest.resources) {
      const filename = path.resolve(output, record.file), deps = new Set(); dependencies.set(filename, deps);
      const inspect = async value => {
        if (!value || value.startsWith('#')) return value;
        if (/^(?:[a-z][\w+.-]*:|\/\/|\/)/i.test(value)) deps.add('external:' + value);
        else deps.add(path.resolve(path.dirname(filename), decodeURIComponent(value.split(/[?#]/)[0])));
        return value;
      };
      const type = record.contentType ?? '';
      if (/\.css$/i.test(filename) || /text\/css/i.test(type)) await rewriteCSS(await readFile(filename, 'utf8'), inspect, '');
      else if (/\.svg$/i.test(filename) || /image\/svg\+xml/i.test(type)) await visitResourceURLs(new JSDOM(await readFile(filename, 'utf8'), { contentType: 'image/svg+xml' }).window.document, inspect);
    }
    let changed;
    do { changed = false; for (const [filename, deps] of dependencies) if (validFiles.has(filename) && [...deps].some(dep => !validFiles.has(dep))) { validFiles.delete(filename); changed = true; } } while (changed);
    manifest.resources = manifest.resources.filter(record => { if (validFiles.has(path.resolve(output, record.file))) return true; cache.delete(record.url); reused--; reprocessContainers++; return false; });
    manifest.assetReuse = { enabled: true, reused, rejected, reprocessContainers };
  }
  const missing = (url, reason) => { const file = `assets/missing-${hash(url).slice(0, 20)}.bin`; manifest.missing.push({ url, reason, file }); return file; };
  async function asset(raw, from, stylesheet = false, inSheet = false) {
    if (!raw || raw.startsWith('#')) return raw;
    let url; try { url = new URL(raw, from); } catch { const name = missing(raw, 'invalid-url'); return inSheet ? '../' + name : name; }
    const fragment = url.hash; url.hash = '';
    const key = url.href;
    const relative = name => (inSheet ? '../' : '') + name + fragment;
    if (url.username || url.password || !['http:', 'https:', 'data:'].includes(url.protocol)) return relative(missing(key, 'unsupported-or-credentialed-url'));
    if (cache.has(key)) return relative(cache.get(key));
    const known404 = previous?.missing?.some(item => item.url === key && item.reason === 'HTTP-404') || previous?.substitutedUnusedAssets?.some(item => item.url === key && item.originalFailure === 'HTTP-404');
    if (key === UNUSED_EXAMPLE_URL && permitUnusedExample && known404) {
      const filename = 'assets/unused-example-dot-com-x.svg', bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      await writeFile(path.join(output, filename), bytes); cache.set(key, filename);
      manifest.resources.push({ url: key, file: filename, status: 'substituted-unused', hash: hash(bytes), bytes: bytes.length, contentType: 'image/svg+xml' });
      manifest.substitutedUnusedAssets = [{ url: key, file: filename, originalFailure: 'HTTP-404', originalResourceAvailable: false, selector: '.' + UNUSED_EXAMPLE_CLASS, matchingDOMElements: 0, reason: 'Confirmed unused source example rule; transparent local placeholder is not the original resource.' }];
      return relative(filename);
    }
    if (cache.size >= 1000) return relative(missing(key, 'resource-limit'));
    let ext = stylesheet ? '.css' : path.extname(url.pathname).toLowerCase();
    if (url.protocol === 'data:' && !stylesheet) {
      const type = key.slice(5).split(/[;,]/, 1)[0].toLowerCase();
      ext = ({ 'image/svg+xml': '.svg', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf', 'text/css': '.css' })[type] ?? '.bin';
    }
    if (!/^\.(?:woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico|css)$/.test(ext)) ext = '.bin';
    const filename = `assets/${hash(key).slice(0, 24)}${ext}`; cache.set(key, filename);
    const record = { url: key, file: filename, status: 'missing' }; manifest.resources.push(record);
    try {
      let bytes, type = '', resolved = key;
      if (url.protocol === 'data:') {
        const match = key.match(/^data:([^,]*),(.*)$/s); if (!match) throw new Error('invalid-data-url');
        type = match[1].split(';')[0]; bytes = /;base64(?:;|$)/i.test(match[1]) ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]));
      } else {
        if (offline) throw new Error('offline-mode-resource-not-downloaded');
        const response = await fetch(key, { redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000), headers: { Accept: '*/*' } });
        if (!response.ok) throw new Error(`HTTP-${response.status}`);
        resolved = response.url; type = response.headers.get('content-type') ?? '';
        if (Number(response.headers.get('content-length')) > 20_000_000) throw new Error('resource-too-large');
        bytes = Buffer.from(await response.arrayBuffer());
      }
      if (bytes.length > 20_000_000) throw new Error('resource-too-large');
      if (stylesheet || /text\/css/i.test(type)) bytes = Buffer.from(await rewriteCSS(bytes.toString(), asset, resolved, true));
      else if (/javascript|text\/html/i.test(type)) throw new Error('unexpected-executable-resource');
      else if (/image\/svg\+xml/i.test(type) || ext === '.svg') {
        const svgDOM = new JSDOM(bytes.toString(), { contentType: 'image/svg+xml' });
        cleanDocument(svgDOM.window.document, manifest.removed);
        await rewriteDocumentResources(svgDOM.window.document, resolved, true);
        bytes = Buffer.from(svgDOM.serialize());
      }
      await writeFile(path.join(output, filename), bytes);
      Object.assign(record, { status: 'saved', hash: hash(bytes), bytes: bytes.length, contentType: type });
    } catch (error) { record.reason = String(error.message); manifest.missing.push({ url: key, file: filename, reason: record.reason }); }
    return relative(filename);
  }
  async function rewriteDocumentResources(document, from, inAsset = false) {
    for (const element of document.querySelectorAll('*')) {
      if (element.hasAttribute('style')) element.setAttribute('style', await rewriteCSS(element.getAttribute('style'), asset, from, inAsset));
      if (element.localName === 'style') element.textContent = await rewriteCSS(element.textContent, asset, from, inAsset);
      for (const attr of [...element.attributes]) {
        if (URL_ATTRIBUTES.has(attr.name) && !(element.localName === 'link' && element.relList.contains('stylesheet'))) element.setAttribute(attr.name, await asset(attr.value, from, false, inAsset));
        if (attr.name === 'srcset' || attr.name === 'imagesrcset') element.setAttribute(attr.name, await rewriteSrcset(attr.value, value => asset(value, from, false, inAsset)));
        if (PRESENTATION_ATTRIBUTES.has(attr.name)) element.setAttribute(attr.name, await rewriteValue(attr.value, value => asset(value, from, false, inAsset)));
      }
    }
  }
  const messageSlots = slotsOf(document, capture.slots);
  const textCounts = Object.fromEntries(Object.entries(messageSlots).map(([name, element]) => [name, textLeaves(document, element).length]));
  if (!textCounts.user || !textCounts.assistant) throw new Error('Each message slot needs existing text to preserve its structure');
  manifest.slotTextLeaves = textCounts;
  const originalSheets = [...document.querySelectorAll('style,link[rel~="stylesheet"]')];
  // A positional mapping is deliberately strict: silently appending missing
  // styles elsewhere could change the original cascade or selector semantics.
  const sheets = [...capture.styles].sort((a, b) => a.index - b.index);
  if (originalSheets.length === 0) {
    // Some capture exporters intentionally remove stylesheet elements after
    // exporting CSSOM. Restore their cascade order, and report this limitation.
    for (const _sheet of sheets) { const node = document.createElement('link'); node.rel = 'stylesheet'; document.head.append(node); originalSheets.push(node); }
    manifest.stylePlacement = 'capture-removed-style-nodes-restored-in-head-index-order';
  } else manifest.stylePlacement = 'original-style-node-positions';
  if (sheets.length !== originalSheets.length) throw new Error(`Stylesheet mapping mismatch: capture ${sheets.length}, DOM ${originalSheets.length}`);
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i], node = originalSheets[i];
    if (typeof sheet.cssText !== 'string') throw new Error(`Missing cssText for stylesheet ${i}`);
    const text = await rewriteCSS(sheet.cssText, asset, sheet.href || base.href, true);
    const file = `assets/sheet-${String(i).padStart(3, '0')}.css`; await writeFile(path.join(output, file), text);
    // Keep style/link node position, class and other presentation attributes.
    if (node.localName === 'style') { node.textContent = await rewriteCSS(sheet.cssText, asset, sheet.href || base.href, false); node.dataset.localCapturedStyle = String(i); }
    else { node.setAttribute('href', file); node.dataset.localCapturedStyle = String(i); }
    if (sheet.media) node.setAttribute('media', sheet.media);
    if (sheet.disabled) node.setAttribute('media', 'not all');
    manifest.styles.push({ index: sheet.index, sourceHref: sheet.href, file, hash: hash(text), disabled: !!sheet.disabled, media: sheet.media || '', node: node.localName });
  }
  // Do not rewrite the now-local stylesheet contents a second time.
  const styleText = new Map([...document.querySelectorAll('style')].map(node => [node, node.textContent]));
  for (const node of styleText.keys()) node.textContent = '';
  await rewriteDocumentResources(document, base.href);
  for (const [node, text] of styleText) node.textContent = text;
  manifest.inlinedSprites = await inlineSprites(document, output);
  const csp = document.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy'; csp.content = CSP; csp.dataset.localReplayOwned = 'csp'; document.head.prepend(csp);
  const baselineShellHash = shellSignature(document, capture.slots);
  const reference = '<!doctype html>\n' + document.documentElement.outerHTML;
  await writeFile(path.join(output, 'reference.html'), reference);
  for (const name of ['content.js', 'replay.js']) { const script = document.createElement('script'); script.src = name; script.defer = true; script.dataset.localReplayOwned = name; document.head.append(script); }
  await writeFile(path.join(output, 'index.html'), '<!doctype html>\n' + document.documentElement.outerHTML);
  const defaultText = name => Array.from({ length: textCounts[name] }, (_, i) => `${name === 'user' ? 'C' : 'D'}${textCounts[name] > 1 ? i + 1 : ''}：这是本地替换后的${name === 'user' ? '用户' : '助手'}消息。`);
  const defaults = Object.fromEntries(['user', 'assistant'].map(name => [name, textCounts[name] === 1 ? defaultText(name)[0] : defaultText(name)]));
  try { await stat(path.join(output, 'content.js')); } catch { await writeFile(path.join(output, 'content.js'), '// Edit this file to repeat the offline replacement. Arrays map to existing\n// non-empty text leaves and must have exactly the same number of entries.\nwindow.LOCAL_REPLAY_CONTENT = ' + json(defaults) + ';\n'); }
  await writeFile(path.join(output, 'replay.js'), `(() => {\n'use strict';\nconst selectors = ${JSON.stringify(capture.slots)};\nconst content = window.LOCAL_REPLAY_CONTENT;\nif (!content) throw new Error('Missing local content');\nfor (const name of ['user', 'assistant']) {\n  const matches = document.querySelectorAll(selectors[name]);\n  if (matches.length !== 1) throw new Error('Invalid local slot: ' + name);\n  const node = matches[0], walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);\n  const textNodes = []; while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) textNodes.push(walker.currentNode);\n  const values = Array.isArray(content[name]) ? content[name] : [content[name], ...textNodes.slice(1).map(() => '')];\n  if (values.length !== textNodes.length || values.some(value => typeof value !== 'string')) throw new Error('Text leaf count does not match: ' + name);\n  textNodes.forEach((text, index) => { text.nodeValue = values[index]; });\n}\ndocument.documentElement.dataset.localReplay = 'replaced';\n})();\n`);
  manifest.checks = { baselineShellHash, indexShellHash: shellSignature(document, capture.slots), originalScriptCount: document.querySelectorAll('script:not([data-local-replay-owned])').length };
  manifest.status = manifest.missing.length ? 'incomplete' : 'downloaded-pending-verification';
  await writeFile(path.join(output, 'manifest.json'), json(manifest));
  const verification = await verify(output); return { output, resources: manifest.resources.length, missing: manifest.missing.length, verification };
}

export async function verify(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const issues = [], checked = new Set();
  async function checkURL(raw, from, css = false) {
    if (!raw || raw.startsWith('#')) return raw;
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(raw) || raw.startsWith('/')) { issues.push({ file: from, reason: 'non-local-resource', value: raw }); return raw; }
    let target; try { target = path.resolve(path.dirname(from), decodeURIComponent(raw.split(/[?#]/)[0])); } catch { issues.push({ file: from, reason: 'invalid-local-url', value: raw }); return raw; }
    if (!target.startsWith(path.resolve(directory) + path.sep)) { issues.push({ file: from, reason: 'resource-outside-archive', value: raw }); return raw; }
    try {
      await stat(target);
      if (!checked.has(target) && (css || path.extname(target) === '.css')) { checked.add(target); await rewriteCSS(await readFile(target, 'utf8'), (value, _base, imported) => checkURL(value, target, imported), target); }
    } catch (error) { issues.push({ file: from, reason: 'missing-or-invalid-resource', value: raw, detail: error.message }); }
    return raw;
  }
  async function inspectDocument(document, file, name) {
    const documentURL = async (raw, css = false) => {
      if (raw.startsWith('#') && raw.length > 1) {
        let id; try { id = decodeURIComponent(raw.slice(1)); } catch { issues.push({ file: name, reason: 'invalid-local-fragment', value: raw }); return raw; }
        if (!document.getElementById(id)) issues.push({ file: name, reason: 'missing-local-fragment', value: raw });
        return raw;
      }
      return checkURL(raw, file, css);
    };
    for (const element of document.querySelectorAll('*')) {
      if (['script', 'iframe', 'object', 'embed', 'base', 'frame'].includes(element.localName)) {
        const allowed = name === 'index.html' && element.localName === 'script' && ['content.js', 'replay.js'].includes(element.getAttribute('src')) && element.hasAttribute('data-local-replay-owned') && !element.textContent;
        if (!allowed) issues.push({ file: name, reason: 'executable-or-embedded-content', tag: element.localName });
      }
      if ((element.localName === 'form' || FORM_FIELDS.has(element.localName)) && !element.hasAttribute('inert')) issues.push({ file: name, reason: 'active-form-control', tag: element.localName });
      if (element.hasAttribute('contenteditable') && (element.getAttribute('contenteditable') !== 'false' || !element.hasAttribute('inert'))) issues.push({ file: name, reason: 'active-editor' });
      if (element.localName === 'button' && (element.closest('form') || /^(submit|reset)$/i.test(element.getAttribute('type') ?? '')) && element.getAttribute('type') !== 'button') issues.push({ file: name, reason: 'submitting-button' });
      for (const attr of element.attributes) {
        if (/^on/i.test(attr.name) || ACTIVE_ATTRIBUTES.has(attr.name)) issues.push({ file: name, reason: 'active-attribute', attribute: attr.name });
        if (URL_ATTRIBUTES.has(attr.name)) await documentURL(attr.value, element.localName === 'link' && element.relList.contains('stylesheet'));
        if (['srcset', 'imagesrcset'].includes(attr.name)) await rewriteSrcset(attr.value, value => documentURL(value));
        if (PRESENTATION_ATTRIBUTES.has(attr.name)) await rewriteValue(attr.value, value => documentURL(value));
      }
      if (element.hasAttribute('style')) await rewriteCSS(element.getAttribute('style'), value => documentURL(value), file);
      if (element.localName === 'style') await rewriteCSS(element.textContent, (value, _base, imported) => documentURL(value, imported), file);
    }
  }
  for (const name of ['reference.html', 'index.html']) {
    const file = path.resolve(directory, name), dom = new JSDOM(await readFile(file, 'utf8')), document = dom.window.document;
    try { slotsOf(document, manifest.slots); } catch (error) { issues.push({ file: name, reason: error.message }); }
    if (shellSignature(document, manifest.slots) !== manifest.checks.baselineShellHash) issues.push({ file: name, reason: 'message-shell-or-cascade-changed' });
    if (document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content !== CSP) issues.push({ file: name, reason: 'missing-or-changed-csp' });
    await inspectDocument(document, file, name);
  }
  for (const record of [...manifest.resources, ...manifest.styles]) {
    if (record.status === 'missing') continue;
    try {
      const file = path.resolve(directory, record.file);
      if (!file.startsWith(path.resolve(directory) + path.sep)) { issues.push({ file: record.file, reason: 'resource-outside-archive' }); continue; }
      const bytes = await readFile(file);
      if (hash(bytes) !== record.hash) issues.push({ file: record.file, reason: 'asset-hash-mismatch' });
      if (/image\/svg\+xml/i.test(record.contentType ?? '') || path.extname(file) === '.svg') await inspectDocument(new JSDOM(bytes.toString(), { contentType: 'image/svg+xml' }).window.document, file, record.file);
    }
    catch { issues.push({ file: record.file, reason: 'missing-asset' }); }
  }
  const substituted = manifest.substitutedUnusedAssets?.length ?? 0;
  const report = { status: issues.length || manifest.missing.length ? 'failed' : substituted ? 'static-checks-passed-with-unused-substitution' : 'static-checks-passed', missingResources: manifest.missing.length, substitutedUnusedAssets: substituted, originalResourcesComplete: !manifest.missing.length && !substituted, issues, browserOfflineReplay: 'not-checked', visualComparison: 'not-checked', note: 'Static checks do not establish offline browser behavior or visual fidelity. An unused substitution is not a successfully downloaded original resource.' };
  await writeFile(path.join(directory, 'verify.json'), json(report)); return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), output = path.resolve(args.find(arg => arg.startsWith('--out='))?.slice(6) ?? path.join(HERE, 'replay'));
  try {
    const verifyDirectory = path.resolve(args.find(arg => !arg.startsWith('--')) ?? output);
    const result = args.includes('--verify') ? { ...(await verify(verifyDirectory)), output: verifyDirectory } : await localize(path.resolve(args.find(arg => !arg.startsWith('--')) ?? path.join(HERE, 'capture.json')), output, { offline: args.includes('--offline'), reuseAssets: args.includes('--reuse-assets') });
    const report = result.verification ?? result;
    console.log(json({ output: result.output ?? output, status: report.status, resources: result.resources, missingResources: report.missingResources, issues: report.issues.length, details: path.join(result.output ?? output, 'verify.json'), browserOfflineReplay: report.browserOfflineReplay, visualComparison: report.visualComparison }));
    if (report.status === 'failed') process.exitCode = 2;
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
