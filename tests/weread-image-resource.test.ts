import { afterEach, expect, it, vi } from 'vitest';
import { readWeReadImage } from '../packages/adapter-weread/src/image-resource';

const source = 'https://weread.qq.com/web/reader/neutral';
const image = 'https://res.weread.qq.com/wrepub/neutral.png';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('reads bytes in the worker without FileReader, credentials or disk cache', async () => {
  vi.stubGlobal('FileReader', undefined);
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png; charset=binary' } }));
  vi.stubGlobal('fetch', fetcher);
  expect(await readWeReadImage(image, source)).toBe('data:image/png;base64,AQID');
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(image, expect.objectContaining({ credentials: 'omit', cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer' }));
});

it('keeps existing raster data images compatible without remote access', async () => {
  expect(await readWeReadImage('data:image/png;base64,AQID', source)).toBe('data:image/png;base64,AQID');
});

it.each([
  'https://example.com/wrepub/test.png', 'http://res.weread.qq.com/wrepub/test.png',
  'https://res.weread.qq.com:444/wrepub/test.png', 'https://res.weread.qq.com/other/test.png',
  'https://user:secret@res.weread.qq.com/wrepub/test.png', 'https://res.weread.qq.com/wrepub/../private',
  'data:text/html;base64,AQID', 'data:image/svg+xml;base64,AQID', 'file:///tmp/test.png'
])('rejects an out-of-scope resource before requesting it: %s', async url => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(readWeReadImage(url, source)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects another platform even when it supplies an allowed image URL', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(readWeReadImage(image, 'https://fanqienovel.com/reader/neutral')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['text/html', 'image/svg+xml', 'application/octet-stream'])('rejects unexpected content type %s', async type => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid', { headers: { 'content-type': type } })));
  await expect(readWeReadImage(image, source)).rejects.toThrow('resource-unavailable');
});

it.each(['status', 'redirect', 'empty', 'declared-size', 'stream-size'])('rejects invalid response: %s', async variant => {
  const response = new Response(variant === 'stream-size' ? new Uint8Array(8 * 1024 * 1024 + 1) : variant === 'empty' ? null : 'test', {
    status: variant === 'status' ? 403 : 200,
    headers: { 'content-type': 'image/png', ...(variant === 'declared-size' ? { 'content-length': String(8 * 1024 * 1024 + 1) } : {}) }
  });
  if (variant === 'redirect') {
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'url', { value: 'https://unapproved.example/test.png' });
  }
  vi.stubGlobal('fetch', vi.fn(async () => response));
  await expect(readWeReadImage(image, source)).rejects.toThrow(variant.includes('size') ? 'resource-too-large' : 'resource-unavailable');
});

it.each(['https://res.weread.qq.com', 'https://wrco-40036.sh.gfp.tencent-cloud.com'])('accepts an observed final image origin %s without exposing its URL', async origin => {
  const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  Object.defineProperties(response, { redirected: { value: true }, url: { value: `${origin}/neutral.jpg?sign=synthetic` } });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  expect(await readWeReadImage(image, source)).toBe('data:image/jpeg;base64,AQID');
});

it.each(['http://wrco-40036.sh.gfp.tencent-cloud.com/test.jpg', 'https://wrco-40036.sh.gfp.tencent-cloud.com.evil.example/test.jpg', 'https://wrco-40036.sh.gfp.tencent-cloud.com:444/test.jpg'])('rejects an unapproved final URL %s before reading its body', async url => {
  const response = new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { headers: { 'content-type': 'image/jpeg' } });
  Object.defineProperties(response, { redirected: { value: true }, url: { value: url } });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  await expect(readWeReadImage(image, source)).rejects.toThrow('resource-unavailable');
});

it.each(['headers', 'body'])('bounds time spent waiting for %s', async phase => {
  vi.useFakeTimers();
  const cancel = vi.fn(); let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    signal = options.signal;
    if (phase === 'headers') return new Promise(() => {});
    return new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'image/png' } });
  }));
  const result = expect(readWeReadImage(image, source)).rejects.toThrow('resource-timeout');
  await vi.advanceTimersByTimeAsync(10001); await result;
  expect(signal?.aborted).toBe(true);
  if (phase === 'body') expect(cancel).toHaveBeenCalled();
});
