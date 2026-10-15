export const WEREAD_SELECTORS = {
  content: [
    ".readerChapterContent",
    ".readerContent .app_content",
    "main article"
  ],
  bookTitle: [
    ".readerTopBar_title",
    "[class*='readerTopBar_title']",
    "[class*='readerBookInfo'] h1",
    "header h1"
  ],
  chapterTitle: [
    ".readerChapterContent_title",
    "[class*='readerChapterContent_title']",
    "[class*='chapterTitle']",
    "article h1"
  ],
  progress: [
    ".readerFooter_progress",
    "[class*='readerFooter_progress']",
    "[aria-label*='进度']"
  ],
  previousPage: [
    ".renderTarget_pager_button:not(.renderTarget_pager_button_right)",
    ".readerControls_item.prev",
    "[class*='readerControls'] [class*='prev']",
    "button[aria-label*='上一页']",
    "button[title*='上一页']"
  ],
  nextPage: [
    ".renderTarget_pager_button_right",
    ".readerControls_item.next",
    "[class*='readerControls'] [class*='next']",
    "button[aria-label*='下一页']",
    "button[title*='下一页']"
  ],
  tableOfContents: [
    ".readerControls_item.catalog",
    "[class*='readerControls'] [class*='catalog']",
    "button[aria-label*='目录']",
    "button[title*='目录']"
  ],
  login: [".login_dialog", "[class*='loginDialog']", "[class*='qrCode']"]
} as const;

export function findContentSurface(document: Document): HTMLElement | null {
  for (const selector of WEREAD_SELECTORS.content) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      // Measurement/source copies must never be promoted into visible content.
      if (element.closest(".preRenderContainer, .preRenderContent, [hidden], [aria-hidden='true']")) continue;
      const style = document.defaultView?.getComputedStyle(element);
      if (style?.display === "none" || style?.visibility === "hidden") continue;
      return element;
    }
  }
  return null;
}

export function isPaginatedSurface(surface: HTMLElement): boolean {
  return !!surface.querySelector(".renderTargetContainer")
    && !!surface.querySelector(".preRenderContainer");
}

export function queryFirst<T extends Element>(document: Document, selectors: readonly string[]): T | null {
  for (const selector of selectors) {
    const element = document.querySelector<T>(selector);
    if (element) return element;
  }
  return null;
}

export function normalizedText(element: Element | null): string | undefined {
  const value = element?.textContent?.replace(/\s+/g, " ").trim();
  return value ? value.slice(0, 160) : undefined;
}
