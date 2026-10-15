const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|avif)$/i;
const IMAGE_ORIGINS = new Set(['https://res.weread.qq.com', 'https://wrco-40036.sh.gfp.tencent-cloud.com']);

/** Called only by the extension worker, after resolving an issued session resource. */
export async function readWeReadImage(src: string, sourceUrl: string): Promise<string> {
  const source = new URL(sourceUrl);
  if (source.origin !== 'https://weread.qq.com' || !source.pathname.startsWith('/web/reader/')) throw new Error('resource-unavailable');
  const url = new URL(src);
  const inline = /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z0-9+/]*={0,2}$/i.test(src);
  if (!inline && (url.origin !== 'https://res.weread.qq.com' || !url.pathname.startsWith('/wrepub/') || url.username || url.password || url.hash))
    throw new Error('resource-unavailable');
  if (inline && src.length > Math.ceil(MAX_BYTES / 3) * 4 + 64) throw new Error('resource-too-large');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new Error('resource-timeout')); }, 10000);
  });
  try {
    const response = await Promise.race([fetch(url.href, {
      signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'follow'
    }), expired]);
    // A registered WeRead URL can redirect to its observed image CDN. Never
    // return a response from a different origin or expose signed CDN URLs.
    const finalUrl = new URL(response.url || (response.redirected ? '' : url.href));
    if (!inline && (!IMAGE_ORIGINS.has(finalUrl.origin) || finalUrl.username || finalUrl.password)) throw new Error('resource-unavailable');
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!response.ok || !IMAGE_TYPE.test(mime) || !response.body) throw new Error('resource-unavailable');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('resource-too-large');
    reader = response.body.getReader();
    const chunks: string[] = []; let size = 0;
    while (true) {
      const next = await Promise.race([reader.read(), expired]);
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_BYTES) throw new Error('resource-too-large');
      for (let offset = 0; offset < next.value.length; offset += 32768)
        chunks.push(String.fromCharCode(...next.value.subarray(offset, offset + 32768)));
    }
    if (!size) throw new Error('resource-unavailable');
    // FileReader is unavailable in service workers. Keep bytes in memory only.
    return `data:${mime};base64,${btoa(chunks.join(''))}`;
  } finally {
    clearTimeout(timeout); controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}
