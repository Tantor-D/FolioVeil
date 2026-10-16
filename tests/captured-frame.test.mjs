import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { buildCapturedTheme, capturedThemeInputs } from '../tooling/build-captured-theme.mjs';
import { loadCapturedFrame, mountCapturedFrame } from '../packages/theme-chatgpt/src/captured-frame.ts';

let directory, manifest, html;
const packageURL = 'http://127.0.0.1:4280/themes/chatgpt/';
const owner = () => new JSDOM('<!doctype html><html class="application"><head><title>阅读会话</title><meta name="referrer" content="no-referrer"><style id="old-style">body{margin:90px}</style></head><body><p id="boot">正在加载</p></body></html>', { url: 'http://127.0.0.1:4280/reader.html' }).window.document;
const loaded = () => ({ manifest, html, packageURL });
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'folioveil-captured-frame-test-'));
  manifest = await buildCapturedTheme(process.cwd(), directory);
  html = await readFile(path.join(directory, 'frame.html'), 'utf8');
}, 30000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllGlobals());

describe('original captured document package', () => {
  it('uses a theme-specific filename so the extension ZIP has no nested manifest.json', async () => {
    const files = await readdir(directory);
    expect(files).toContain('theme-manifest.json');
    expect(files).not.toContain('manifest.json');
    expect(JSON.parse(await readFile(path.join(directory, 'theme-manifest.json'), 'utf8'))).toEqual(manifest);
  });
  it('keeps the actual outer DOM/classes and records every local resource and captured content branch', async () => {
    const config = JSON.parse(await readFile('packages/theme-chatgpt/capture/document-source.json', 'utf8'));
    const capture = JSON.parse(await readFile(config.capture, 'utf8'));
    const source = new JSDOM(capture.html).window.document, packaged = new JSDOM(html).window.document;
    const sendCapture = JSON.parse(await readFile('packages/theme-chatgpt/capture/send-button.json', 'utf8'));
    const send = source.createElement('template'); send.innerHTML = sendCapture.html;
    source.querySelector(config.selectors.composer).querySelector('button[aria-label="Start Voice"]').replaceWith(send.content.firstElementChild);
    const shape = element => [element.localName, element.getAttribute('class'), [...element.children].map(shape)];
    expect(shape(packaged.querySelector(config.selectors.composer))).toEqual(shape(source.querySelector(config.selectors.composer)));
    expect(packaged.querySelector('[data-local-state-node="layout"]').className).toBe(source.querySelector('[data-local-state-node="layout"]').className);
    expect(packaged.querySelectorAll('section').length).toBeLessThan(source.querySelectorAll('section').length);
    expect(manifest.format).toBe('folioveil-captured-document');
    expect(manifest.tabIcons).toEqual({ ico: 'assets/chatgpt-favicon.ico', svg: 'assets/chatgpt-favicon.svg' });
    for (const format of ['ico', 'svg']) expect(await readFile(path.join(directory, manifest.tabIcons[format]))).toEqual(await readFile(`packages/theme-chatgpt/capture/tab-icon/favicon.${format}`));
    expect(manifest.evidence.missingTemplates).toEqual([]);
    expect(manifest.files.some(file => file.kind === 'font')).toBe(true);
    expect(manifest.files.some(file => file.kind === 'image')).toBe(true);
    expect(packaged.querySelectorAll('style,link[rel="stylesheet"]').length).toBe(capture.styles.length);
    expect(manifest.evidence.visualComparison).toBe('not-checked');
    expect(manifest.evidence.browserReplay).toBe('not-checked');
    const inputs = await capturedThemeInputs(process.cwd());
    expect(inputs.some(file => file.endsWith('.woff2'))).toBe(true);
    expect(inputs.some(file => file.endsWith('home-english-dark-expanded-full.json'))).toBe(true);
    expect(inputs.some(file => file.endsWith('home-english-dark-collapsed-full.json'))).toBe(true);
    expect(inputs.some(file => file.endsWith('home-english-light-collapsed-full.json'))).toBe(true);
  });

  it('checks actual bytes for fonts as well as HTML and refuses remote package URLs before fetching', async () => {
    const font = manifest.files.find(file => file.kind === 'font');
    const fetch = vi.fn(async value => {
      const url = new URL(value);
      if (!url.href.startsWith(packageURL)) throw new Error('Unexpected network request');
      const file = url.href.slice(packageURL.length);
      const bytes = await readFile(path.join(directory, file));
      return new Response(file === font.file ? Buffer.concat([bytes, Buffer.from('changed')]) : bytes);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(loadCapturedFrame('https://chatgpt.com/', owner())).rejects.toThrow('non-local-package');
    expect(fetch).not.toHaveBeenCalled();
    await expect(loadCapturedFrame(packageURL, owner())).rejects.toThrow('resource-hash-mismatch');
  });

  it.each(['fetch', 'http', 'body', 'json'])('classifies a %s manifest failure without leaking its contents or changing the document', async kind => {
    const privateDetail = 'https://private.invalid/neutral-example?session=do-not-disclose';
    const fetch = vi.fn(async () => {
      if (kind === 'fetch') throw new TypeError(`Failed to fetch ${privateDetail}`);
      if (kind === 'http') return new Response(privateDetail, { status: 404 });
      if (kind === 'body') return { ok: true, arrayBuffer: async () => { throw new Error(privateDetail); } };
      return new Response(`{"incomplete":"${privateDetail}`);
    });
    vi.stubGlobal('fetch', fetch);
    const document = owner(), before = document.documentElement.outerHTML;
    const expected = kind === 'json' ? 'invalid-manifest-json' : kind === 'body' ? 'resource-unreadable' : 'resource-unavailable';
    await expect(loadCapturedFrame(packageURL, document)).rejects.toEqual(new Error(`captured-theme:${expected}`));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('classifies an asset fetch rejection and settles aborted siblings before returning the failure', async () => {
    let active = 0;
    const signals = [];
    const fetch = vi.fn(async (value, options) => {
      if (new URL(value).pathname.endsWith('/theme-manifest.json')) return new Response(JSON.stringify(manifest));
      signals.push(options.signal);
      if (new URL(value).pathname.endsWith('/frame.html')) throw new TypeError('Failed to fetch a private local path');
      active++;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        active--; reject(new DOMException('Private resource request cancelled', 'AbortError'));
      }, { once: true }));
    });
    vi.stubGlobal('fetch', fetch);
    await expect(loadCapturedFrame(packageURL, owner())).rejects.toEqual(new Error('captured-theme:resource-unavailable'));
    expect(active).toBe(0);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('loads all local dependencies, installs original document semantics, and restores the owner on disposal', async () => {
    const fetch = vi.fn(async value => new Response(await readFile(path.join(directory, new URL(value).href.slice(packageURL.length)))));
    vi.stubGlobal('fetch', fetch);
    const document = owner(), before = document.documentElement.outerHTML;
    const frame = await loadCapturedFrame(packageURL, document);
    expect(fetch).toHaveBeenCalledTimes(manifest.files.length + 2);
    const mounted = mountCapturedFrame(frame, document);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.querySelector('#old-style')).toBeNull();
    expect(document.querySelector('meta[name="referrer"]').content).toBe('no-referrer');
    expect(document.title).toBe('阅读会话');
    expect(mounted.root).toBe(document.body);
    expect(mounted.scroller.contains(mounted.messageFlow)).toBe(true);
    expect(document.querySelector('link[rel="stylesheet"]').getAttribute('href')).toMatch(/^http:\/\/127\.0\.0\.1:4280\/themes\/chatgpt\/assets\//);
    expect([...document.querySelectorAll('link[rel~="icon"]')].map(icon => icon.getAttribute('href'))).toEqual([
      packageURL + manifest.tabIcons.ico, packageURL + manifest.tabIcons.svg
    ]);
    expect(() => mountCapturedFrame(frame, document)).toThrow('document-already-mounted');
    mounted.dispose(); mounted.dispose();
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('replaces only the reader tab favicon while mounted and restores the original head on disposal', () => {
    const document = owner();
    const original = document.createElement('link'); original.rel = 'icon'; original.href = '/folioveil.png'; document.head.append(original);
    const mounted = mountCapturedFrame(loaded(), document);
    expect(document.querySelectorAll('link[rel~="icon"]')).toHaveLength(2);
    expect([...document.querySelectorAll('link[rel~="icon"]')].every(icon => icon.href.startsWith(packageURL + 'assets/chatgpt-favicon.'))).toBe(true);
    mounted.dispose();
    expect(document.querySelectorAll('link[rel~="icon"]')).toHaveLength(1);
    expect(document.querySelector('link[rel~="icon"]').getAttribute('href')).toBe('/folioveil.png');
  });

  it('clones real content containers and isolates local IDs without damaging shared SVG icon references', () => {
    const document = owner(), mounted = mountCapturedFrame(loaded(), document);
    expect(mounted.cloneBlock('table').content.localName).toBe('table');
    expect(mounted.cloneBlock('image').content.localName).toBe('img');
    expect(mounted.cloneBlock('math').root.localName).toBe('span');
    expect(mounted.cloneBlock('math').content.hasAttribute('data-math-source')).toBe(true);
    const first = mounted.cloneBlock('code'), second = mounted.cloneBlock('code');
    expect(first.content.localName).toBe('code');
    expect(first.root).not.toBe(second.root);
    expect(first.root.querySelector('button[aria-label="Enable word wrap"]').hasAttribute('inert')).toBe(true);
    expect(first.root.querySelector('[data-fv-content-action="copy"]')).not.toBeNull();
    expect(first.root.textContent).not.toContain('Python');
    expect(mounted.cloneMessage('assistant').content.className).toContain('MarkdownRoot');
    expect(() => mounted.cloneBlock('not-captured')).toThrow('template-missing');
    mounted.dispose();
    expect(() => mounted.cloneMessage('user')).toThrow('disposed');
  });

  it('uses the captured sidebar and color states', () => {
    const document = owner(), mounted = mountCapturedFrame(loaded(), document);
    expect(mounted.applyAppearance({ colorScheme: 'dark', sidebarCollapsed: false })).toEqual({ missing: [] });
    expect(document.querySelector('[data-local-state-node="layout"]').getAttribute('data-app-shell-sidebar-open')).toBe('true');
    expect(document.querySelector('[data-local-state-node="rail"]').style.display).toBe('');
    expect(mounted.applyAppearance({ colorScheme: 'dark', sidebarCollapsed: true })).toEqual({ missing: [] });
    expect(document.querySelector('[data-local-state-node="layout"]').getAttribute('data-app-shell-sidebar-open')).toBe('false');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(mounted.applyAppearance({ colorScheme: 'light', sidebarCollapsed: false })).toEqual({ missing: [] });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(mounted.cloneBlock('code').root.querySelector('[data-markdown-copy="code-block"]').getAttribute('data-theme')).toBe('light');
    mounted.applyAppearance({ colorScheme: 'dark', sidebarCollapsed: true });
    expect(document.querySelector('[data-local-state-node="rail"]').style.display).toBe('');
    mounted.dispose();
  });

  it('fails ambiguous selectors and executable templates before changing the reader document', () => {
    const document = owner(), before = document.documentElement.outerHTML;
    const duplicate = { ...manifest, selectors: { ...manifest.selectors, scroller: 'div' } };
    expect(() => mountCapturedFrame({ ...loaded(), manifest: duplicate }, document)).toThrow('ambiguous-selector');
    expect(document.documentElement.outerHTML).toBe(before);
    expect(() => mountCapturedFrame({ ...loaded(), html: html.replace('</body>', '<script>throw Error("bad")</script></body>') }, document)).toThrow('executable-content');
    expect(document.documentElement.outerHTML).toBe(before);
  });
});
