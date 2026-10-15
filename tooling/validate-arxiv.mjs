import { build } from "esbuild";
import { JSDOM } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Download only this explicitly requested public document. Full text is kept in
// process memory and is never written to fixtures, reports or diagnostic logs.
const sourceURL = new URL(process.argv[2] || "https://arxiv.org/html/2401.04088v1");
if (sourceURL.protocol !== "https:" || sourceURL.hostname !== "arxiv.org" || !/^\/html\/[\d.]+v\d+\/?$/.test(sourceURL.pathname)) {
  throw new Error("Expected a versioned https://arxiv.org/html/ paper URL");
}
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundled = await build({
  entryPoints: [path.join(root, "packages/adapter-arxiv/src/index.ts")],
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent"
});
const moduleURL = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`;
const { extractArxivDocument, releaseArxivResources } = await import(moduleURL);
const response = await fetch(sourceURL, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Source request failed (${response.status})`);
const source = new JSDOM(await response.text(), { url: sourceURL.href });
const sourceDoc = source.window.document;
const article = sourceDoc.querySelector("article.ltx_document");
if (!article) throw new Error("No supported HTML article");
const result = extractArxivDocument(sourceDoc, sourceURL.href);
const rendered = new JSDOM(result.blocks.map((block) => "html" in block ? block.html : block.type === "list" ? block.items.join("") : "").join(""));
// A multi-panel figure shares its source caption across image blocks. Deduplicate
// source figure identity, never caption text (different figures may repeat text).
const imageCaptionMarkup = new Map();
const tableCaptionMarkup = new Map();
for (const block of result.blocks) {
  if (!("captionHtml" in block) || !block.captionHtml) continue;
  const sourceNode = block.sourceId && sourceDoc.getElementById(block.sourceId);
  const identity = sourceNode && (sourceNode.closest("figure") || sourceNode) || block.id;
  const destination = block.type === "table" ? tableCaptionMarkup : imageCaptionMarkup;
  destination.set(identity, block.captionHtml);
}
const imageCaptions = new JSDOM([...imageCaptionMarkup.values()].join(""));
const tableCaptions = new JSDOM([...tableCaptionMarkup.values()].join(""));
const imageCaptionMath = imageCaptions.window.document.querySelectorAll("math").length;
const tableCaptionMath = tableCaptions.window.document.querySelectorAll("math").length;
const paragraphs = [...article.querySelectorAll("p")].filter((node) => !node.closest("li,table,figcaption,.ltx_authors"));
const bodyParagraphsPreserved = paragraphs.filter((node) => result.blocks.some((block) => block.type === "paragraph" && block.sourceId === node.id)).length;
const sourceNodes = result.blocks.flatMap((block) => {
  const node = block.sourceId && sourceDoc.getElementById(block.sourceId);
  return node ? [node] : [];
});
const outOfOrder = sourceNodes.slice(1).filter((node, index) => sourceNodes[index].compareDocumentPosition(node) & source.window.Node.DOCUMENT_POSITION_PRECEDING).length;
const counts = (node, selectors) => Object.fromEntries(selectors.map((selector) => [selector, node.querySelectorAll(selector).length]));
console.log(JSON.stringify({
  source: counts(article, ["p", "math", "figcaption math", "figure", "table.ltx_tabular", "table.ltx_equation", "img", "object[type='image/svg+xml']", "li.ltx_bibitem", "td,th"]),
  extractedBlockTypes: result.blocks.reduce((acc, block) => { acc[block.type] = (acc[block.type] || 0) + 1; return acc; }, {}),
  rendered: counts(rendered.window.document, ["math", "td,th"]),
  imageCaptionMath,
  tableCaptionMath,
  preservedCaptionMath: imageCaptionMath + tableCaptionMath,
  preservedMathTotal: rendered.window.document.querySelectorAll("math").length + imageCaptionMath + tableCaptionMath,
  bodyParagraphs: paragraphs.length,
  bodyParagraphsPreserved,
  sourceAnchorsOutOfOrder: outOfOrder,
  imageResourcesAvailable: result.blocks.filter((block) => block.type === "image" && block.src).length,
  warnings: result.warnings
}, null, 2));
releaseArxivResources(result);
rendered.window.close();
imageCaptions.window.close();
tableCaptions.window.close();
source.window.close();
