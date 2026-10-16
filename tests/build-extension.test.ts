import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const script = path.resolve('tooling/build-extension.mjs');
const entries = ['background', 'content', 'popup', 'options', 'reader'];
const directories: string[] = [];
const children: ChildProcess[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'folioveil-build-test-')); directories.push(root);
  for (const directory of ['apps/extension-chromium/src', 'apps/extension-chromium/icons', 'apps/extension-chromium/_locales/zh_CN', 'apps/preview/src', 'packages/test-fixtures']) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.0', type: 'module' }));
  for (const entry of entries) await writeFile(path.join(root, `apps/extension-chromium/src/${entry}.ts`), `globalThis.${entry}Build = __FOLIOVEIL_BUILD_ID__;`);
  await writeFile(path.join(root, 'apps/preview/src/main.ts'), 'globalThis.previewBuild = __FOLIOVEIL_BUILD_ID__;');
  for (const file of ['popup.html', 'popup.css', 'options.html', 'options.css', 'reader.html', 'reader.css']) await writeFile(path.join(root, 'apps/extension-chromium', file), file.endsWith('.html') ? '<!doctype html><title>Synthetic</title>' : '/* synthetic fixture */');
  for (const size of [16, 32, 48, 128]) await writeFile(path.join(root, `apps/extension-chromium/icons/icon-${size}.png`), new Uint8Array([size]));
  await writeFile(path.join(root, 'apps/extension-chromium/manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Synthetic build test', version: '0.0.0' }));
  await writeFile(path.join(root, 'apps/extension-chromium/_locales/zh_CN/messages.json'), '{}');
  await writeFile(path.join(root, 'apps/preview/index.html'), '<!doctype html><title>Synthetic preview</title>');
  await writeFile(path.join(root, 'packages/test-fixtures/paper-sample.html'), '<p>Synthetic text.</p>');
  await writeFile(path.join(root, 'packages/test-fixtures/chatgpt-neutral-reader.json'), JSON.stringify({ title: 'Synthetic neutral sample', blocks: [] }));
  return root;
}
async function artifacts(root: string) {
  const extension = path.join(root, 'dist/extension-chromium');
  const preview = path.join(root, 'dist/preview');
  const info = JSON.parse(await readFile(path.join(extension, 'build-info.json'), 'utf8'));
  const previewInfo = JSON.parse(await readFile(path.join(preview, 'build-info.json'), 'utf8'));
  const code = await Promise.all([...entries.map(entry => readFile(path.join(extension, `${entry}.js`), 'utf8')), readFile(path.join(preview, 'preview.js'), 'utf8')]);
  return { info, previewInfo, code };
}
async function waitUntil(check: () => Promise<boolean>, details: () => string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* A directory replacement may briefly be unavailable. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for the build:\n${details()}`);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('build identity', () => {
  it('rejects a nested extension manifest before publishing the built package', async () => {
    const root = await fixture();
    const nested = path.join(root, 'apps/extension-chromium/icons/nested');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'manifest.json'), '{}');
    await expect(execute(process.execPath, [script], { cwd: root })).rejects.toThrow(/extension-package:multiple-manifests/);
    await expect(readFile(path.join(root, 'dist/extension-chromium/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('changes the build identity when a packaged font changes without any source-code change', async () => {
    const root = await fixture();
    const assets = path.join(root, 'packages/theme-chatgpt/assets');
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, 'captured-font.woff2'), new Uint8Array([1, 2, 3]));
    await execute(process.execPath, [script], { cwd: root });
    const before = await artifacts(root);
    await writeFile(path.join(assets, 'captured-font.woff2'), new Uint8Array([1, 2, 4]));
    await execute(process.execPath, [script], { cwd: root });
    const after = await artifacts(root);
    expect(after.info.buildId).not.toBe(before.info.buildId);
    expect(after.previewInfo).toEqual(after.info);
    after.code.forEach(code => expect(code).toContain(after.info.buildId));
  }, 15000);
  it('builds deterministic release entry points and preview with matching source maps and manifests', async () => {
    const root = await fixture();
    await execute(process.execPath, [script], { cwd: root });
    const first = await artifacts(root);
    expect(first.info.version).toBe('0.4.0'); expect(first.info.buildId).toMatch(/^[a-f0-9]{16}$/);
    expect(first.previewInfo).toEqual(first.info);
    expect((await readdir(path.join(root, 'dist/extension-chromium/icons'))).sort()).toEqual(['icon-128.png', 'icon-16.png', 'icon-32.png', 'icon-48.png']);
    first.code.forEach(code => expect(code).toContain(first.info.buildId));
    const mapPath = path.join(root, 'dist/extension-chromium/content.js.map');
    const firstMap = await readFile(mapPath, 'utf8');
    const sourceMap = JSON.parse(firstMap);
    expect(path.resolve(path.dirname(mapPath), sourceMap.sources[0])).toBe(path.join(root, 'apps/extension-chromium/src/content.ts'));
    await execute(process.execPath, [script], { cwd: root });
    expect(await artifacts(root)).toEqual(first);
    expect(await readFile(mapPath, 'utf8')).toBe(firstMap);
    expect((await readdir(path.join(root, 'dist'))).sort()).toEqual(['extension-chromium', 'preview']);
  }, 15000);

  it('gives every watch rebuild one fresh identity, copies static changes, and preserves good output after an error', async () => {
    const root = await fixture();
    const child = spawn(process.execPath, [script, '--watch'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    let log = ''; child.stdout!.on('data', chunk => { log += String(chunk); }); child.stderr!.on('data', chunk => { log += String(chunk); });
    await waitUntil(async () => { const value = await artifacts(root); return value.code.every(code => code.includes(value.info.buildId)) && value.info.buildId === value.previewInfo.buildId; }, () => log);
    const first = await artifacts(root);
    await writeFile(path.join(root, 'apps/extension-chromium/src/content.ts'), 'globalThis.changedContent = __FOLIOVEIL_BUILD_ID__;');
    await waitUntil(async () => { const value = await artifacts(root); return value.info.buildId !== first.info.buildId && value.code.every(code => code.includes(value.info.buildId)) && value.info.buildId === value.previewInfo.buildId; }, () => log);
    const second = await artifacts(root);
    expect(second.code[1]).toContain('changedContent');
    await writeFile(path.join(root, 'apps/extension-chromium/reader.css'), 'body { color: blue; }');
    await waitUntil(async () => { const value = await artifacts(root); return value.info.buildId !== second.info.buildId && value.code.every(code => code.includes(value.info.buildId)) && value.info.buildId === value.previewInfo.buildId && await readFile(path.join(root, 'dist/extension-chromium/reader.css'), 'utf8') === 'body { color: blue; }'; }, () => log);
    const lastGood = await artifacts(root);
    const oldLog = log.length;
    await writeFile(path.join(root, 'apps/extension-chromium/src/content.ts'), 'const broken = ;');
    await waitUntil(async () => /ERROR|Build failed/.test(log.slice(oldLog)), () => log);
    expect(await artifacts(root)).toEqual(lastGood);
    await writeFile(path.join(root, 'apps/extension-chromium/src/content.ts'), 'globalThis.recoveredContent = __FOLIOVEIL_BUILD_ID__;');
    await waitUntil(async () => { const value = await artifacts(root); return value.info.buildId !== lastGood.info.buildId && value.code.every(code => code.includes(value.info.buildId)) && value.info.buildId === value.previewInfo.buildId; }, () => log);
    expect((await artifacts(root)).code[1]).toContain('recoveredContent');
  }, 20000);
});
