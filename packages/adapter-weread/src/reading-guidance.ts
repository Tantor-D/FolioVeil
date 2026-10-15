import { readingLayout } from './reading-layout';

export const SINGLE_COLUMN_GUIDANCE = '建议使用微信读书的单栏（上下滚动）模式。双栏模式每次会连续翻多页，可能跨越多个章节。\n\n切换方法：回到微信读书页面，点击右侧工具栏的阅读模式切换按钮，切换到上下滚动阅读。随后刷新微信读书页面，关闭旧的 FolioVeil 阅读页，再从扩展重新打开阅读页。';

/** Inspect rendered controls before collection; absence of a pager is not evidence of scroll mode. */
export async function readWeReadGuidance(document: Document, wait: (ms: number) => Promise<void>): Promise<string | undefined> {
  for (let attempt = 0; attempt <= 75; attempt++) {
    const layout = readingLayout(document);
    if (layout) return layout === 'paginated' ? SINGLE_COLUMN_GUIDANCE : undefined;
    if (attempt < 75) await wait(40);
  }
  // Unknown layouts neither manufacture advice nor prevent the normal read.
}
