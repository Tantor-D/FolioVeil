import type { ReaderDocument } from "../../content-model/src/index";
import { extractStructuredHTML } from "../../content-model/src/html";

/** Extract only the currently loaded, user-accessible HTML article. */
export function extractArxivDocument(document: Document, url: string): ReaderDocument {
  const article = document.querySelector<HTMLElement>("[data-folioveil-paper], article.ltx_document");
  if (!article) throw new Error("content_not_found");
  const isFixture = article.hasAttribute("data-folioveil-paper");
  const location = new URL(url, document.baseURI);
  if (!isFixture && (location.protocol !== "https:" || location.hostname !== "arxiv.org" || !location.pathname.startsWith("/html/"))) throw new Error("unsupported_source");
  const titleElement = article.querySelector(".ltx_title_document, h1");
  return extractStructuredHTML(article, {
    id: isFixture ? `fixture:${article.dataset.folioveilPaper || "paper-sample"}` : `arxiv:${location.pathname.slice(6).replace(/\/$/, "")}`,
    title: titleElement?.textContent?.replace(/\s+/g, " ").trim() || "未命名内容",
    source: { kind: isFixture ? "fixture" : "html", url: location.href, label: isFixture ? "自制论文样本" : "arXiv HTML" }
  }, titleElement);
}

/** Self-contained safe image URLs; there are no owned blob resources. */
export function releaseArxivResources(_document: ReaderDocument): void {}
