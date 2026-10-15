// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readWeReadGuidance, SINGLE_COLUMN_GUIDANCE } from '../packages/adapter-weread/src/reading-guidance';

afterEach(() => { document.body.replaceChildren(); });
it('recommends scroll mode for visible paginated controls without clicking or reading content', async () => {
  document.body.innerHTML = '<button class="renderTarget_pager_button_right">下一页</button>';
  const click = vi.fn(); document.querySelector('button')!.addEventListener('click', click);
  const wait = vi.fn();
  expect(await readWeReadGuidance(document, wait)).toBe(SINGLE_COLUMN_GUIDANCE);
  expect(click).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
});
it('gives no advice for a confirmed scroll layout', async () => {
  document.body.innerHTML = '<button class="readerFooter_button">下一章</button>';
  expect(await readWeReadGuidance(document, vi.fn())).toBeUndefined();
});
it('waits for controls that render after startup', async () => {
  const wait = vi.fn(async () => { document.body.innerHTML = '<button class="renderTarget_pager_button_right">下一页</button>'; });
  expect(await readWeReadGuidance(document, wait)).toBe(SINGLE_COLUMN_GUIDANCE);
  expect(wait).toHaveBeenCalledOnce();
});
it.each(['', '<div hidden><button class="renderTarget_pager_button_right">下一页</button></div>', '<button class="renderTarget_pager_button_right">下一页</button><button class="readerFooter_button">下一章</button>'])('does not label unknown or conflicting layout as dual columns: %s', async html => {
  document.body.innerHTML = html;
  const wait = vi.fn(async () => {});
  expect(await readWeReadGuidance(document, wait)).toBeUndefined();
  expect(wait).toHaveBeenCalledTimes(75);
});
