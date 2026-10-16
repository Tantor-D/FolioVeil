import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Web Store uploads must contain only the extension's root manifest.json. */
export async function validateExtensionPackage(directory) {
  const manifests = [];
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.name.toLowerCase() === 'manifest.json') manifests.push(name);
    }
  }
  await visit();
  if (manifests.length !== 1 || manifests[0] !== 'manifest.json') {
    throw new Error(`extension-package:multiple-manifests: expected only manifest.json; found ${manifests.sort().join(', ') || 'none'}`);
  }
}
