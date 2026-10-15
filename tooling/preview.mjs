import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
const root = path.resolve('dist/preview');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const data = await readFile(filename);
    response.writeHead(200, { 'content-type': mime[path.extname(filename)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(4173, '127.0.0.1', () => console.log('P0 preview: http://127.0.0.1:4173'));
