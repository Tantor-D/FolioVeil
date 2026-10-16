import type { CapturedBlockKind, CapturedClone, CapturedFrameManifest, CapturedTemplateSpec, LoadedCapturedFrame, MountedCapturedFrame } from './captured-frame-contract';

const mountedDocuments = new WeakSet<Document>();
const allowedFiles = /^(?:frame\.html|assets\/[a-zA-Z0-9_-]+\.(?:css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico|bin))$/;
const failure = (reason: string): never => { throw new Error(`captured-theme:${reason}`); };
async function digest(bytes: ArrayBuffer): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); }
function unique(root: ParentNode, selector: string): HTMLElement {
  let nodes: NodeListOf<HTMLElement>; try { nodes = root.querySelectorAll<HTMLElement>(selector); } catch { return failure('invalid-selector'); }
  if (nodes.length !== 1) return failure(`ambiguous-selector:${selector}`);
  return nodes[0]!;
}
function content(root: HTMLElement, selector: string): HTMLElement { return selector === ':scope' ? root : unique(root, selector); }
function validateManifest(value: unknown): CapturedFrameManifest {
  const manifest = value as CapturedFrameManifest;
  if (!manifest || manifest.format !== 'folioveil-captured-document' || manifest.formatVersion !== 1 || manifest.id !== 'chatgpt' || manifest.document?.file !== 'frame.html') return failure('unsupported-package');
  if (!Array.isArray(manifest.files) || manifest.files.length > 1000 || !manifest.selectors || !manifest.messages || !manifest.blocks || !manifest.evidence) return failure('invalid-package');
  const records = [manifest.document, ...manifest.files], names = new Set<string>();
  let total = 0;
  for (const record of records) {
    if (!record || !allowedFiles.test(record.file) || names.has(record.file) || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > 20_000_000) return failure('invalid-resource-record');
    names.add(record.file); total += record.bytes;
  }
  if (manifest.tabIcons && (!/^assets\/[a-zA-Z0-9_-]+\.ico$/.test(manifest.tabIcons.ico) || !/^assets\/[a-zA-Z0-9_-]+\.svg$/.test(manifest.tabIcons.svg) || !names.has(manifest.tabIcons.ico) || !names.has(manifest.tabIcons.svg))) return failure('invalid-tab-icons');
  if (total > 200_000_000) return failure('resource-budget-exceeded');
  for (const selector of Object.values(manifest.selectors)) if (typeof selector !== 'string' || selector.length > 500) return failure('invalid-selector');
  for (const spec of [...Object.values(manifest.messages), ...Object.values(manifest.blocks)]) if (!spec || typeof spec.selector !== 'string' || typeof spec.contentSelector !== 'string') return failure('invalid-template');
  for (const appearance of Object.values(manifest.appearance ?? {})) for (const patch of appearance.patches) {
    if (typeof patch.selector !== 'string') return failure('invalid-appearance-selector');
    for (const [name, value] of Object.entries(patch.attributes)) if (!['class','style','data-state','inert','aria-expanded','aria-hidden','data-theme','data-appearance-theme','data-app-shell-sidebar-open','data-app-shell-compact-page-gutter'].includes(name) || value !== null && (typeof value !== 'string' || name === 'style' && /url\(|expression\(|@import/i.test(value))) return failure('unsafe-appearance-patch');
  }
  if (manifest.codeAppearance) {
    const code = manifest.codeAppearance;
    if (typeof code.wrapperSelector !== 'string' || code.wrapperSelector.length > 200 || !['light', 'dark'].every(color => {
      const value = code[color as 'light' | 'dark'];
      return value && value.theme === color && typeof value.rootClass === 'string' && value.rootClass.length < 1000 && typeof value.wrapperClass === 'string' && value.wrapperClass.length < 1000;
    })) return failure('invalid-code-appearance');
  }
  return manifest;
}

/** Fetches only a same-origin application package, never a website template. */
export async function loadCapturedFrame(packageURL = new URL('themes/chatgpt/', document.baseURI).href, ownerDocument: Document = document): Promise<LoadedCapturedFrame> {
  const base = new URL(packageURL, ownerDocument.baseURI), owner = new URL(ownerDocument.baseURI);
  if (base.protocol !== owner.protocol || base.host !== owner.host || !['chrome-extension:', 'http:', 'https:', 'file:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) return failure('non-local-package');
  const controller = new AbortController(), fetchLocal = fetch.bind(globalThis);
  const read = async (file: string): Promise<ArrayBuffer> => {
    let response: Response;
    try { response = await fetchLocal(new URL(file, base), { credentials: 'omit', redirect: 'error', signal: controller.signal }); }
    catch { return failure('resource-unavailable'); }
    if (!response.ok) return failure('resource-unavailable');
    try { return await response.arrayBuffer(); }
    catch { return failure('resource-unreadable'); }
  };
  const manifestBytes = await read('theme-manifest.json');
  if (manifestBytes.byteLength > 2_000_000) return failure('manifest-too-large');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(manifestBytes)); }
  catch { return failure('invalid-manifest-json'); }
  const manifest = validateManifest(parsed);
  const canonical = new TextEncoder().encode(JSON.stringify({ ...manifest, packageHash: '' }));
  if (await digest(canonical.buffer) !== manifest.packageHash) return failure('manifest-hash-mismatch');
  let html = '';
  let failed: unknown;
  const remaining = [manifest.document, ...manifest.files];
  // Bound parallel reads; every actual style/font/icon byte is checked.
  await Promise.all(Array.from({ length: Math.min(6, remaining.length) }, async () => {
    try {
      let record; while (!failed && (record = remaining.shift())) {
        const bytes = await read(record.file);
        if (bytes.byteLength !== record.bytes || await digest(bytes) !== record.sha256) failure(`resource-hash-mismatch:${record.file}`);
        if (record.file === manifest.document.file) html = new TextDecoder().decode(bytes);
      }
    } catch (error) { if (!failed) failed = error; controller.abort(); }
  }));
  if (failed) throw failed;
  return { manifest, html, packageURL: base.href };
}

/** Preserve captured classes and nesting; isolate IDs inside every cloned branch. */
function cloneTemplate(template: HTMLElement, spec: CapturedTemplateSpec, owner: Document, prefix: string): CapturedClone {
  const root = owner.importNode(template, true), mapping = new Map<string, string>();
  for (const node of [root, ...root.querySelectorAll<HTMLElement>('[id]')]) if (node.id) { const old = node.id; node.id = `${prefix}${old}`; mapping.set(old, node.id); }
  for (const node of [root, ...root.querySelectorAll<HTMLElement>('*')]) for (const attr of [...node.attributes]) {
    if (['aria-controls','aria-labelledby','aria-describedby','for'].includes(attr.name)) node.setAttribute(attr.name, attr.value.split(/\s+/).map(id => mapping.get(id) ?? id).join(' '));
    else if (['href','xlink:href'].includes(attr.name) && attr.value.startsWith('#') && mapping.has(attr.value.slice(1))) node.setAttribute(attr.name, '#' + mapping.get(attr.value.slice(1)));
    else if (attr.name === 'style' || ['fill','stroke','filter','clip-path','mask'].includes(attr.name)) node.setAttribute(attr.name, attr.value.replace(/url\(["']?#([^)'"\s]+)["']?\)/g, (original, id: string) => mapping.has(id) ? `url(#${mapping.get(id)})` : original));
  }
  return { root, content: content(root, spec.contentSelector) };
}
function attributes(element: Element): Array<[string, string]> { return [...element.attributes].map(attr => [attr.name, attr.value]); }
function replaceAttributes(element: Element, values: Array<[string, string]>): void { for (const attr of [...element.attributes]) element.removeAttribute(attr.name); for (const [name, value] of values) element.setAttribute(name, value); }

/** Installs original html/body/cascade into a dedicated reader document. */
export function mountCapturedFrame(loaded: LoadedCapturedFrame, ownerDocument: Document = document): MountedCapturedFrame {
  const manifest = validateManifest(loaded.manifest);
  if (mountedDocuments.has(ownerDocument)) return failure('document-already-mounted');
  const parser = new ownerDocument.defaultView!.DOMParser();
  const source = parser.parseFromString(loaded.html, 'text/html');
  const files = new Set(manifest.files.map(record => record.file));
  const packageURL = new URL(loaded.packageURL), ownerURL = new URL(ownerDocument.baseURI);
  if (packageURL.protocol !== ownerURL.protocol || packageURL.host !== ownerURL.host) return failure('non-local-package');
  const localURL = (value: string): string => {
    if (!value || value.startsWith('#')) return value;
    const [file, fragment] = value.split('#');
    if (!file || !files.has(file)) return failure(`unlisted-resource:${value}`);
    return new URL(file, packageURL).href + (fragment ? '#' + fragment : '');
  };
  const localCSS = (value: string): string => {
    // The localizer canonicalizes URL tokens to quoted local paths. Image-set
    // and @import string forms also contain only listed asset paths.
    const urls = value.replace(/(?<!\\)\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_match, double: string, single: string, bare: string) => `url("${localURL(double ?? single ?? bare.trim())}")`);
    return urls.replace(/(["'])(assets\/[a-zA-Z0-9_.\/-]+)\1/g, (_match, _quote: string, file: string) => `"${localURL(file)}"`);
  };
  for (const node of source.querySelectorAll('*')) {
    if (['script','iframe','frame','object','embed','base'].includes(node.localName)) return failure('executable-content');
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || ['action','formaction','form','formmethod','formtarget','srcdoc','ping','autofocus'].includes(attr.name)) return failure('active-attribute');
      if (['src','href','xlink:href','poster','background'].includes(attr.name)) node.setAttribute(attr.name, localURL(attr.value));
      if (['srcset','imagesrcset'].includes(attr.name)) node.setAttribute(attr.name, attr.value.split(',').map(part => { const tokens = part.trim().split(/\s+/); tokens[0] = localURL(tokens[0] ?? ''); return tokens.join(' '); }).join(', '));
      if (['style','fill','stroke','filter','clip-path','mask','cursor','marker-start','marker-mid','marker-end'].includes(attr.name)) node.setAttribute(attr.name, localCSS(attr.value));
    }
    if (node.localName === 'style') node.textContent = localCSS(node.textContent ?? '');
    if (['form','input','textarea','select'].includes(node.localName) && !node.hasAttribute('inert')) return failure('active-form-control');
    if (node.hasAttribute('contenteditable') && (node.getAttribute('contenteditable') !== 'false' || !node.hasAttribute('inert'))) return failure('active-editor');
  }
  const slots = Object.fromEntries(Object.entries(manifest.selectors).map(([name, selector]) => [name, unique(source, selector)])) as Record<keyof CapturedFrameManifest['selectors'], HTMLElement>;
  const templates = new Map<string, { element: HTMLElement; spec: CapturedTemplateSpec }>();
  for (const [name, spec] of [...Object.entries(manifest.messages), ...Object.entries(manifest.blocks).map(([name, spec]) => [`block:${name}`, spec] as const)]) {
    let element = unique(source, spec.selector);
    if (spec.templateElement) {
      if (element.localName !== 'template' || (element as HTMLTemplateElement).content.children.length !== 1) return failure('invalid-supplementary-template');
      element = (element as HTMLTemplateElement).content.firstElementChild as HTMLElement;
      if (element.matches('script,iframe,object,embed,form,input,[contenteditable]') || element.querySelector('script,iframe,object,embed,form,input,[contenteditable]')) return failure('active-supplementary-template');
      for (const node of [element, ...element.querySelectorAll('*')]) for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || ['src','href','xlink:href','action','formaction'].includes(attr.name)) return failure('active-supplementary-template');
    }
    content(element, spec.contentSelector); templates.set(name, { element, spec });
  }
  for (const role of ['user','assistant']) if (templates.get(role)!.element.parentElement !== slots.messageFlow) return failure('invalid-message-boundary');
  if (!slots.scroller.contains(slots.messageFlow) || !slots.sidebar.contains(slots.conversationList) || !slots.conversationList.contains(templates.get('sidebarItem')!.element)) return failure('invalid-semantic-tree');
  const saved = { html: attributes(ownerDocument.documentElement), body: attributes(ownerDocument.body), head: [...ownerDocument.head.childNodes], children: [...ownerDocument.body.childNodes] };
  const applicationHead = [...ownerDocument.head.querySelectorAll('meta[http-equiv],meta[name="referrer"],link[rel~="icon"]')].map(node => node.cloneNode(true));
  const title = ownerDocument.title;
  // The reader application owns its policy and title. A replay-only CSP would
  // incorrectly prevent authorized source images from loading in the reader.
  for (const node of source.querySelectorAll('meta[http-equiv],title')) node.remove();
  replaceAttributes(ownerDocument.documentElement, attributes(source.documentElement));
  replaceAttributes(ownerDocument.body, attributes(source.body));
  ownerDocument.head.replaceChildren(...[...source.head.childNodes].map(node => ownerDocument.importNode(node, true)));
  ownerDocument.head.prepend(...applicationHead);
  if (manifest.tabIcons) {
    for (const icon of ownerDocument.head.querySelectorAll('link[rel~="icon"]')) icon.remove();
    for (const [format, type] of [['ico', 'image/x-icon'], ['svg', 'image/svg+xml']] as const) {
      const icon = ownerDocument.createElement('link');
      icon.rel = 'icon'; icon.type = type; icon.href = localURL(manifest.tabIcons[format]);
      ownerDocument.head.append(icon);
    }
  }
  ownerDocument.body.replaceChildren(...[...source.body.childNodes].map(node => ownerDocument.importNode(node, true)));
  ownerDocument.title = title;
  mountedDocuments.add(ownerDocument);
  let sequence = 0, disposed = false;
  const clone = (name: string): CapturedClone => {
    if (disposed) return failure('disposed');
    const template = templates.get(name); if (!template) return failure(`template-missing:${name}`);
    const cloned = cloneTemplate(template.element, template.spec, ownerDocument, `fv-clone-${++sequence}-`);
    if (name === 'block:code') applyCodeAppearance(cloned.root);
    return cloned;
  };
  const applyCodeAppearance = (root: HTMLElement) => {
    const code = manifest.codeAppearance; if (!code) return;
    const color = ownerDocument.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const state = code[color], wrapper = unique(root, code.wrapperSelector);
    root.className = state.rootClass; wrapper.className = state.wrapperClass; wrapper.setAttribute('data-theme', state.theme);
  };
  return {
    root: ownerDocument.body,
    scroller: unique(ownerDocument, manifest.selectors.scroller), messageFlow: unique(ownerDocument, manifest.selectors.messageFlow),
    sidebar: unique(ownerDocument, manifest.selectors.sidebar), conversationList: unique(ownerDocument, manifest.selectors.conversationList), composer: unique(ownerDocument, manifest.selectors.composer), manifest,
    cloneMessage: role => clone(role), cloneSidebarItem: () => clone('sidebarItem'),
    supportsBlock: kind => !!manifest.blocks[kind], cloneBlock: (kind: CapturedBlockKind) => clone(`block:${kind}`),
    applyAppearance(value) {
      const missing: string[] = [];
      for (const name of [value.colorScheme, value.sidebarCollapsed ? 'sidebar-collapsed' : 'sidebar-expanded'] as const) {
        const state = manifest.appearance?.[name]; if (!state) { missing.push(name); continue; }
        for (const patch of state.patches) {
          const node = unique(ownerDocument, patch.selector);
          for (const [attribute, setting] of Object.entries(patch.attributes)) if (setting === null) node.removeAttribute(attribute); else node.setAttribute(attribute, setting);
        }
      }
      if (value.colorScheme === 'dark' && value.sidebarCollapsed && (ownerDocument.defaultView?.innerWidth ?? 1024) <= 400) {
        const state = manifest.appearance?.['narrow-dark-collapsed'];
        if (!state) missing.push('narrow-dark-collapsed');
        else for (const patch of state.patches) {
          const node = unique(ownerDocument, patch.selector);
          for (const [attribute, setting] of Object.entries(patch.attributes)) if (setting === null) node.removeAttribute(attribute); else node.setAttribute(attribute, setting);
        }
      }
      for (const code of ownerDocument.querySelectorAll<HTMLElement>('[data-block-type="code"]')) applyCodeAppearance(code);
      return { missing };
    },
    dispose() {
      if (disposed) return; disposed = true; mountedDocuments.delete(ownerDocument);
      replaceAttributes(ownerDocument.documentElement, saved.html); replaceAttributes(ownerDocument.body, saved.body);
      ownerDocument.head.replaceChildren(...saved.head); ownerDocument.body.replaceChildren(...saved.children);
    }
  };
}
