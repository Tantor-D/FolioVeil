import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { localize, verify } from '../experiments/chatgpt-local-replay/localize.mjs';

const directories = [];
const svgURL = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>')}`;
const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture({ body = '', css = '' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'folioveil-replay-test-')); directories.push(root);
  const output = path.join(root, 'replay');
  const html = `<!doctype html><html lang="zh-CN"><head><style class="captured-style"></style></head><body><main class="captured-shell"><section data-local-slot="user">中性问题</section><article data-local-slot="assistant">中性回答</article></main>${body}</body></html>`;
  const capture = { schemaVersion: 1, source: { url: 'https://chatgpt.com/?temporary-chat=true', note: 'Synthetic safety fixture, not a captured theme.' }, html, styles: [{ index: 0, cssText: css }], slots: { user: '[data-local-slot="user"]', assistant: '[data-local-slot="assistant"]' } };
  const source = path.join(root, 'capture.json');
  await writeFile(source, JSON.stringify(capture));
  const result = await localize(source, output, { offline: true });
  return { root, output, source, html, result };
}
async function documentAt(output, name = 'index.html') { return new JSDOM(await readFile(path.join(output, name), 'utf8')).window.document; }
async function editPage(output, change) {
  const document = await documentAt(output);
  change(document);
  await writeFile(path.join(output, 'index.html'), '<!doctype html>' + document.documentElement.outerHTML);
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('captured replay safety and local resource closure', () => {
  it('makes native forms, editors and file pickers decorative without replacing their captured structure or styles', async () => {
    const { output, html, result } = await fixture({ body: '<form id="composer" class="group/composer" action="https://invalid.example/submit" style="padding:12px"><div class="ProseMirror" contenteditable="true"><p>中性草稿</p></div><textarea class="fallback">中性草稿</textarea><input class="upload" type="file" style="display:none"><input type="submit"><select><option>中性</option></select><button class="send">发送</button></form><button class="external-send" form="composer" formaction="https://invalid.example/submit">发送</button><div class="other-editor" contenteditable="plaintext-only"></div>' });
    expect(result.verification.status).toBe('static-checks-passed');
    const shape = document => [...document.body.querySelectorAll('*')].map(node => [node.localName, node.getAttribute('class'), node.getAttribute('style')]);
    const original = new JSDOM(html).window.document;
    for (const name of ['reference.html', 'index.html']) {
      const document = await documentAt(output, name);
      expect(shape(document)).toEqual(shape(original));
      expect(document.querySelector('.ProseMirror').textContent).toBe('中性草稿');
      for (const node of document.querySelectorAll('form,input,textarea,select,[contenteditable]')) expect(node.hasAttribute('inert')).toBe(true);
      for (const node of document.querySelectorAll('[contenteditable]')) expect(node.getAttribute('contenteditable')).toBe('false');
      for (const node of document.querySelectorAll('button')) expect(node.type).toBe('button');
      expect(document.querySelector('[action],[form],[formaction]')).toBeNull();
      expect(document.querySelector('.upload').type).toBe('file');
      expect(document.querySelector('.upload').disabled).toBe(false);
    }
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
    expect(manifest.removed).toEqual(expect.arrayContaining(['form:made-inert', 'input:made-inert', 'contenteditable:disabled', 'button:submission-disabled']));
    expect(result.verification.visualComparison).toBe('not-checked');
  });

  it('independently rejects interactive native elements even when marked outside the captured shell signature', async () => {
    const { output } = await fixture();
    await editPage(output, document => {
      const region = document.createElement('div'); region.dataset.localReplayOwned = 'unexpected-control';
      region.innerHTML = '<form><input type="file"><button>发送</button></form><div contenteditable="true">草稿</div><button form="unexpected-form" formaction="https://invalid.example">发送</button>';
      document.body.append(region);
    });
    const report = await verify(output);
    expect(report.status).toBe('failed');
    expect(report.issues.map(issue => issue.reason)).toEqual(expect.arrayContaining(['active-form-control', 'active-editor', 'submitting-button', 'active-attribute']));
    expect(report.issues.some(issue => issue.reason === 'message-shell-or-cascade-changed')).toBe(false);
  });

  it('localizes srcset and image-set resources and detects a missing downloaded dependency', async () => {
    const { output, result } = await fixture({ body: `<img class="sample" src="${svgURL}" srcset="${svgURL} 1x, ${svgURL} 2x">`, css: `.sample{background-image:image-set("${svgURL}" 1x,url("${svgURL}") 2x)}` });
    expect(result.verification.status).toBe('static-checks-passed');
    const document = await documentAt(output);
    const image = document.querySelector('img');
    expect(image.getAttribute('srcset')).toMatch(/^assets\/[\da-f]+\.svg 1x, assets\/[\da-f]+\.svg 2x$/);
    expect(document.querySelector('style').textContent).not.toContain('data:');
    await rm(path.join(output, image.getAttribute('src')));
    const report = await verify(output);
    expect(report.status).toBe('failed');
    expect(report.issues.some(issue => issue.reason === 'missing-or-invalid-resource')).toBe(true);
  });

  it('rejects reintroduced external URLs in srcset and CSS image-set rather than trusting the CSP', async () => {
    const { output } = await fixture();
    await editPage(output, document => {
      const image = document.createElement('img'); image.dataset.localReplayOwned = 'unexpected-image'; image.setAttribute('srcset', 'https://invalid.example/image.png 2x');
      const style = document.createElement('style'); style.dataset.localReplayOwned = 'unexpected-style'; style.textContent = '.sample{background-image:image-set("https://invalid.example/background.png" 1x)}';
      document.body.append(image, style);
    });
    const report = await verify(output);
    expect(report.status).toBe('failed');
    expect(report.issues.filter(issue => issue.reason === 'non-local-resource').map(issue => issue.value)).toEqual(expect.arrayContaining(['https://invalid.example/image.png', 'https://invalid.example/background.png']));
  });

  it('checks SVG use and paint references against actual local IDs after sanitizing executable SVG content', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>throw Error("must be removed")</script><defs><g id="icon"><path d="M0 0"/></g><filter id="shade"/></defs><use href="#icon" onclick="alert(1)" style="filter:url(#shade)"/></svg>';
    const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const { output, result } = await fixture({ body: `<img src="${url}">` });
    expect(result.verification.status).toBe('static-checks-passed');
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
    const record = manifest.resources[0];
    const sanitized = await readFile(path.join(output, record.file), 'utf8');
    expect(sanitized).not.toMatch(/<script|onclick/);
    const svgDOM = new JSDOM(sanitized, { contentType: 'image/svg+xml' });
    svgDOM.window.document.querySelector('use').setAttribute('href', '#missing-icon');
    svgDOM.window.document.querySelector('use').setAttribute('style', 'filter:url(#missing-filter)');
    const broken = svgDOM.serialize();
    await writeFile(path.join(output, record.file), broken);
    record.hash = digest(broken); // A valid resource hash cannot prove referential integrity.
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest));
    const report = await verify(output);
    expect(report.issues.filter(issue => issue.reason === 'missing-local-fragment').map(issue => issue.value)).toEqual(expect.arrayContaining(['#missing-icon', '#missing-filter']));
    expect(report.issues.some(issue => issue.reason === 'asset-hash-mismatch')).toBe(false);
  });

  it('rejects manifest asset paths outside the replay archive even when their bytes and hashes match', async () => {
    const { root, output } = await fixture();
    const outside = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    await writeFile(path.join(root, 'outside.svg'), outside);
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
    manifest.resources.push({ file: '../outside.svg', status: 'saved', hash: digest(outside), contentType: 'image/svg+xml' });
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest));
    const report = await verify(output);
    expect(report.status).toBe('failed');
    expect(report.issues).toContainEqual({ file: '../outside.svg', reason: 'resource-outside-archive' });
  });
});
