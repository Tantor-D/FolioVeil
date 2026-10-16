import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildCapturedTheme, capturedThemeInputs } from './build-captured-theme.mjs';
import { validateExtensionPackage } from './extension-package.mjs';

const root = process.cwd();
const source = path.join(root, 'apps/extension-chromium');
const output = path.join(root, 'dist/extension-chromium');
const previewOutput = path.join(root, 'dist/preview');
const watch = process.argv.includes('--watch');
const script = fileURLToPath(import.meta.url);
const scriptContents = await readFile(script);
const staticFiles = ['manifest.json', 'popup.html', 'popup.css', 'options.html', 'options.css', 'reader.html', 'reader.css'];

async function fingerprint() {
  const hash = createHash('sha256');
  const add = (name, contents) => { hash.update(`${name.length}:${name}:${contents.length}:`); hash.update(contents); };
  async function tree(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const item of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const target = path.join(directory, item.name);
      if (item.isDirectory()) await tree(target);
      else if (/\.(?:[cm]?js|[jt]sx?|css|html|json|svg|woff2?|ttf|otf|png|jpe?g|webp|avif|gif|ico|bin)$/.test(item.name)) add(path.relative(root, target).split(path.sep).join('/'), await readFile(target));
    }
  }
  await tree(path.join(root, 'apps'));
  await tree(path.join(root, 'packages'));
  for (const target of await capturedThemeInputs(root)) add(path.relative(root, target).split(path.sep).join('/'), await readFile(target));
  for (const name of ['build-captured-theme.mjs', 'extension-package.mjs', '../experiments/chatgpt-local-replay/localize.mjs']) add(name, await readFile(new URL(name, import.meta.url)));
  for (const file of ['package.json', 'package-lock.json']) {
    try { add(file, await readFile(path.join(root, file))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const currentScript = await readFile(script);
  if (!currentScript.equals(scriptContents)) throw new Error('Build script changed; restart npm run dev before rebuilding.');
  add('tooling/build-extension.mjs', currentScript);
  return hash.digest('hex').slice(0, 16);
}

async function optionalCopy(from, to) {
  try { await cp(from, to, { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Publish a complete entry-point set; failed compilation leaves the last build intact. */
async function publish(staged, destination, backup) {
  let hadPrevious = false;
  try { await rename(destination, backup); hadPrevious = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(staged, destination); }
  catch (error) { if (hadPrevious) await rename(backup, destination); throw error; }
}

let previousBuild, failedBuild;
async function rebuild() {
  // A save during compilation must not label a mixed source tree with an old ID.
  for (let attempt = 0; attempt < 5; attempt++) {
    const buildId = await fingerprint();
    if (buildId === previousBuild || buildId === failedBuild) return;
    await mkdir(path.join(root, 'dist'), { recursive: true });
    const stage = await mkdtemp(path.join(root, 'dist/.folioveil-build-'));
    try {
      const extensionStage = path.join(stage, 'extension'), previewStage = path.join(stage, 'preview');
      await mkdir(extensionStage); await mkdir(previewStage);
      for (const file of staticFiles) await cp(path.join(source, file), path.join(extensionStage, file));
      await cp(path.join(source, 'icons'), path.join(extensionStage, 'icons'), { recursive: true });
      await cp(path.join(source, '_locales'), path.join(extensionStage, '_locales'), { recursive: true });
      await cp(path.join(root, 'apps/preview/index.html'), path.join(previewStage, 'index.html'));
      await cp(path.join(root, 'packages/test-fixtures/paper-sample.html'), path.join(previewStage, 'paper-sample.html'));
      await cp(path.join(root, 'packages/test-fixtures/chatgpt-neutral-reader.json'), path.join(previewStage, 'chatgpt-neutral-reader.json'));
      const theme = await buildCapturedTheme(root, path.join(extensionStage, 'themes/chatgpt'));
      if (theme) await cp(path.join(extensionStage, 'themes/chatgpt'), path.join(previewStage, 'themes/chatgpt'), { recursive: true });
      // Optional local QA gallery is never packaged with the extension.
      await optionalCopy(path.join(root, 'artifacts/p0'), path.join(previewStage, 'qa'));
      const manifest = JSON.parse(await readFile(path.join(extensionStage, 'manifest.json'), 'utf8'));
      manifest.version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
      await writeFile(path.join(extensionStage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      const common = { bundle: true, format: 'esm', target: 'chrome120', sourcemap: true, write: false, logLevel: 'warning', define: { __FOLIOVEIL_BUILD_ID__: JSON.stringify(buildId) } };
      // Use the final paths for esbuild's source maps, but stage all output bytes.
      const results = await Promise.all([
        build({ ...common, entryPoints: Object.fromEntries(['background', 'content', 'popup', 'options', 'reader'].map(name => [name, path.join(source, `src/${name}.ts`)])), outdir: output }),
        build({ ...common, entryPoints: [path.join(root, 'apps/preview/src/main.ts')], outfile: path.join(previewOutput, 'preview.js') })
      ]);
      for (const [index, result] of results.entries()) {
        for (const file of result.outputFiles) {
          const target = path.join(index === 0 ? extensionStage : previewStage, path.relative(index === 0 ? output : previewOutput, file.path));
          await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.contents);
        }
      }
      await validateExtensionPackage(extensionStage);
      if (buildId !== await fingerprint()) continue;
      const info = `${JSON.stringify({ version: manifest.version, buildId }, null, 2)}\n`;
      await writeFile(path.join(extensionStage, 'build-info.json'), info);
      await writeFile(path.join(previewStage, 'build-info.json'), info);
      await publish(extensionStage, output, path.join(stage, 'previous-extension'));
      await publish(previewStage, previewOutput, path.join(stage, 'previous-preview'));
      previousBuild = buildId; failedBuild = undefined;
      console.log(`Built unpacked extension at ${output} (${buildId})`);
      return;
    } catch (error) {
      failedBuild = buildId; throw error;
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  throw new Error('Sources kept changing during compilation; save the files and retry.');
}

if (!watch) {
  await rebuild();
} else {
  // esbuild contexts keep their initial defines. Serial fingerprint polling gives
  // every entry point one new identity and also observes copied HTML/CSS/locales.
  // It avoids native watcher limits; unchanged or failed trees are not recompiled.
  let closed = false;
  const close = () => { closed = true; };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  console.log(`Watching ${output}`);
  while (!closed) {
    try { await rebuild(); }
    catch (error) {
      console.error(error.message);
      if (error.message.startsWith('Build script changed')) { process.exitCode = 1; break; }
    }
    if (!closed) await new Promise(resolve => setTimeout(resolve, 500));
  }
}
