import type { ImageBlock, ReaderDocument } from "./index";
import { sanitizeMarkup } from "./sanitize";

const OMIT = "script,style,nav,header,footer,form,button,iframe,object:not([type='image/svg+xml']),embed,.ltx_authors,.ltx_dates,.ltx_role_affiliation,.ltx_page_header,.ltx_page_footer,.ltx_title_document,.ltx_note_mark";
const MEDIA = "img,picture,svg,canvas,object[type='image/svg+xml'],[data-content-background]";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Shared semantic conversion; adapters choose the authorized root and identity. */
export function extractStructuredHTML(article: Element, metadata: Pick<ReaderDocument, "id" | "title" | "source">, titleElement?: Element | null, options: { readCanvasPixels?: boolean } = {}): ReaderDocument {
  const document = article.ownerDocument;
  const location = new URL(metadata.source.url || document.baseURI);
  const id = metadata.id;
  const result: ReaderDocument = { ...metadata, blocks: [], toc: [], warnings: [] };
  const usedIds = new Map<string, number>();
  let sequence = 0;
  let imageNumber = 0;

  function identity(element: Element): { id: string; sourceId?: string } {
    const sourceId = element.id || (element.localName === "p" && element.parentElement?.matches(".ltx_para[id]") ? element.parentElement.id : undefined);
    const seed = sourceId || `block-${++sequence}`;
    const occurrence = (usedIds.get(seed) ?? 0) + 1;
    usedIds.set(seed, occurrence);
    return { id: `${id}:${seed}${occurrence > 1 ? `-${occurrence}` : ""}`, ...(sourceId ? { sourceId } : {}) };
  }

  function safeHTML(html: string): string {
    const input = document.createElement("template");
    input.innerHTML = html;
    // LaTeXML frequently encodes emphasis and list markers in classes rather
    // than semantic tags. Translate meaning before discarding source styles.
    for (const marker of input.content.querySelectorAll(".ltx_tag_item")) marker.remove();
    for (const element of input.content.querySelectorAll(".ltx_font_bold, .ltx_font_italic, .ltx_font_typewriter")) {
      if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
      for (const [className, tag] of [["ltx_font_bold", "strong"], ["ltx_font_italic", "em"], ["ltx_font_typewriter", "code"]]) {
        if (!element.classList.contains(className!) || element.localName === tag) continue;
        const semantic = document.createElement(tag!);
        semantic.append(...element.childNodes);
        element.append(semantic);
      }
    }
    for (const note of input.content.querySelectorAll(".ltx_note")) {
      const content = note.querySelector(".ltx_note_content")?.cloneNode(true) as Element | undefined;
      if (!content) continue;
      for (const duplicate of content.querySelectorAll(".ltx_note_mark, .ltx_tag_note")) duplicate.remove();
      const replacement = document.createElement("span");
      const marker = note.querySelector(":scope > .ltx_note_mark");
      if (marker) replacement.append(marker.cloneNode(true));
      replacement.append(document.createTextNode("（"), ...content.childNodes, document.createTextNode("）"));
      note.replaceWith(replacement);
    }
    for (const anchor of input.content.querySelectorAll("a[href]")) {
      try {
        const link = new URL(anchor.getAttribute("href")!, location.href);
        const sameDocument = link.origin === location.origin && link.pathname === location.pathname && link.search === location.search;
        anchor.setAttribute("href", sameDocument && link.hash ? link.hash : link.href);
      } catch { anchor.removeAttribute("href"); }
    }
    const holder = document.createElement("div");
    holder.append(sanitizeMarkup(input.innerHTML, document));
    return holder.innerHTML;
  }

  function addImage(element: Element, caption = "", label?: string, captionHtml?: string): void {
    const index = ++imageNumber;
    const block: ImageBlock = {
      ...identity(element), type: "image", label: label || `图片 ${index}`, caption,
      resourceKind: "image", ...(captionHtml ? { captionHtml } : {})
    };
    const tag = element.localName;
    if (tag === "svg") {
      block.resourceKind = "svg";
      block.src = safeSVGImage(element, document);
    } else if (tag === "object") {
      // An SVG is loaded as an image, never as executable embedded source DOM.
      block.resourceKind = "svg";
      block.src = safeImageURL(element.getAttribute("data"), location.href);
    } else if (tag === "canvas") {
      block.resourceKind = "canvas";
      if (options.readCanvasPixels !== false) {
        try { block.src = (element as HTMLCanvasElement).toDataURL("image/png"); } catch { /* Cross-origin canvas cannot be read. */ }
      }
    } else if (element.hasAttribute("data-content-background") || element.hasAttribute("style") && /background(?:-image)?\s*:/i.test(element.getAttribute("style")!)) {
      block.resourceKind = "background";
      const style = element.getAttribute("style") ?? "";
      const background = element.getAttribute("data-content-background") || /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(style)?.[1];
      block.src = safeImageURL(background, location.href);
    } else {
      const image = tag === "picture" ? element.querySelector("img") : element as HTMLImageElement;
      if (image) {
        block.src = safeImageURL((image as HTMLImageElement).currentSrc || image.getAttribute("src"), location.href);
        if (image.matches(".ltx_math, [data-formula]")) {
          block.resourceKind = "formula";
          if (!label) block.label = `公式图片 ${index}`;
        }
      }
    }
    if (!block.src) {
      block.unavailableReason = "图片资源暂不可用";
      result.warnings.push(`${block.resourceKind}_resource_unavailable`);
    }
    result.blocks.push(block);
  }

  function addParagraph(element: Element, type: "paragraph" | "quote" = "paragraph"): void {
    const media = [...element.querySelectorAll(MEDIA)].filter((node) => !node.parentElement?.closest(MEDIA));
    if (!media.length) {
      const html = safeHTML(element.innerHTML);
      if (hasContent(html, document)) result.blocks.push({ ...identity(element), type, html });
      return;
    }
    // Split around inline media without losing the surrounding text or order.
    let pending = document.createElement("div");
    const flush = () => {
      const html = safeHTML(pending.innerHTML);
      if (hasContent(html, document)) result.blocks.push({ ...identity(element), type, html });
      pending = document.createElement("div");
    };
    const collect = (node: Node) => {
      if (node.nodeType === 1 && (node as Element).matches(MEDIA)) { flush(); addImage(node as Element); return; }
      if (node.nodeType === 1 && (node as Element).querySelector(MEDIA)) {
        for (const child of node.childNodes) collect(child);
      } else pending.append(node.cloneNode(true));
    };
    for (const node of element.childNodes) collect(node);
    flush();
  }

  function visit(element: Element): void {
    if (element === titleElement || element.matches(OMIT)) return;
    const tag = element.localName;
    if (element.matches(".ltx_equation, .ltx_equationgroup") || tag === "math" && element.getAttribute("display") === "block") {
      const html = safeHTML(element.outerHTML);
      result.blocks.push({ ...identity(element), type: "math", html, text: compact(element.querySelector("math")?.getAttribute("alttext") || element.getAttribute("alttext") || cleanText(html, document)) });
      return;
    }
    if (tag === "figure" || element.matches(".ltx_figure, .ltx_table")) {
      const captionElement = element.querySelector("figcaption, .ltx_caption");
      const captionHtml = captionElement ? safeHTML(captionElement.innerHTML) : "";
      const caption = captionText(captionHtml, document);
      const table = element.querySelector("table.ltx_tabular, table");
      if (table && !table.matches(".ltx_equation")) {
        result.blocks.push({ ...identity(element), type: "table", html: safeHTML(table.outerHTML), ...(caption ? { caption, captionHtml } : {}) });
        if (table.querySelector(MEDIA)) {
          result.warnings.push("table_contains_media");
          for (const media of table.querySelectorAll(MEDIA)) {
            if (!media.parentElement?.closest(MEDIA)) addImage(media, caption, undefined, captionHtml);
          }
        }
      } else {
        const media = [...element.querySelectorAll(MEDIA)].filter((node) => !node.parentElement?.closest(MEDIA) && !captionElement?.contains(node));
        const figureLabel = compact(captionElement?.querySelector(".ltx_tag")?.textContent).replace(/[:：]$/, "")
          || /^(?:Figure|Fig\.|图)\s*[\dA-Za-z.]+/i.exec(caption)?.[0];
        if (media.length) {
          media.forEach((node, index) => addImage(node, caption, figureLabel ? `${figureLabel}${media.length > 1 ? ` (${index + 1})` : ""}` : undefined, captionHtml));
          // The original figure ID is the destination of textual references.
          if (element.id) result.blocks[result.blocks.length - media.length]!.sourceId = element.id;
        } else {
          addImage(element, caption, figureLabel, captionHtml);
        }
      }
      return;
    }
    if (tag === "table") {
      const captionNode = element.querySelector(":scope > caption");
      const captionHtml = captionNode ? safeHTML(captionNode.innerHTML) : "";
      const caption = captionText(captionHtml, document);
      const tableBody = element.cloneNode(true) as Element;
      tableBody.querySelector(":scope > caption")?.remove();
      result.blocks.push({ ...identity(element), type: "table", html: safeHTML(tableBody.outerHTML), ...(caption ? { caption, captionHtml } : {}) });
      if (element.querySelector(MEDIA)) {
        result.warnings.push("table_contains_media");
        for (const media of element.querySelectorAll(MEDIA)) {
          if (!media.parentElement?.closest(MEDIA)) addImage(media, caption, undefined, captionHtml);
        }
      }
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      const block = { ...identity(element), type: "heading" as const, level: Number(tag.slice(1)), html: safeHTML(element.innerHTML) };
      result.blocks.push(block);
      result.toc.push({ id: block.id, label: compact(element.textContent), level: block.level });
      // arXiv section references use the section ID, not the heading ID.
      if (!block.sourceId && element.parentElement?.matches("section[id]")) block.sourceId = element.parentElement.id;
      return;
    }
    if (tag === "ul" || tag === "ol") {
      if (element.matches(".ltx_biblist")) {
        for (const item of element.children) addParagraph(item);
      } else {
        result.blocks.push({ ...identity(element), type: "list", ordered: tag === "ol", items: [...element.children].filter((item) => item.localName === "li").map((item) => safeHTML(item.innerHTML)) });
        if (element.querySelector(MEDIA)) {
          result.warnings.push("list_contains_media");
          for (const media of element.querySelectorAll(MEDIA)) {
            if (!media.parentElement?.closest(MEDIA)) addImage(media);
          }
        }
      }
      return;
    }
    if (tag === "pre") { result.blocks.push({ ...identity(element), type: "code", text: element.textContent ?? "" }); return; }
    if (tag === "p" || tag === "blockquote" || element.matches(".ltx_bibitem")) { addParagraph(element, tag === "blockquote" ? "quote" : "paragraph"); return; }
    if (element.matches(MEDIA) || /background(?:-image)?\s*:/i.test(element.getAttribute("style") ?? "")) { addImage(element); return; }
    for (const child of element.children) visit(child);
  }

  for (const child of article.children) visit(child);
  if (article.querySelector(".ltx_ERROR")) result.warnings.push("source_conversion_error");
  if (!result.blocks.some((block) => block.type === "paragraph" || block.type === "heading")) throw new Error("text_content_unavailable");
  result.warnings = [...new Set(result.warnings)];
  return result;
}

function compact(value: string | null | undefined): string { return value?.replace(/\s+/g, " ").trim() ?? ""; }
function cleanText(html: string, document: Document): string {
  const holder = document.createElement("div"); holder.innerHTML = html; return holder.textContent ?? "";
}
function captionText(html: string, document: Document): string {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  for (const math of holder.querySelectorAll("math")) {
    // sanitizeMarkup translates the source alttext to aria-label. Keep the
    // source expression as fallback instead of collapsing a fraction into 18.
    math.replaceWith(document.createTextNode(math.getAttribute("alttext") || math.getAttribute("aria-label") || mathText(math)));
  }
  return compact(holder.textContent);
}
function mathText(node: Node): string {
  if (node.nodeType !== 1) return node.textContent ?? "";
  const element = node as Element;
  const children = [...element.children];
  const child = (index: number) => children[index] ? mathText(children[index]!) : "";
  if (element.localName === "mfrac") return `(${child(0)})/(${child(1)})`;
  if (element.localName === "msub") return `${child(0)}_{${child(1)}}`;
  if (element.localName === "msup") return `${child(0)}^{${child(1)}}`;
  if (element.localName === "msubsup") return `${child(0)}_{${child(1)}}^{${child(2)}}`;
  if (element.localName === "msqrt") return `sqrt(${[...element.childNodes].map(mathText).join("")})`;
  if (element.localName === "mroot") return `root(${child(1)}, ${child(0)})`;
  return [...element.childNodes].map(mathText).join("");
}
function hasContent(html: string, document: Document): boolean { return compact(cleanText(html, document)).length > 0 || html.includes("<math"); }

function safeImageURL(value: string | null | undefined, base: string): string | undefined {
  if (!value) return;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) return value;
  try {
    const url = new URL(value, base);
    if (url.protocol === "https:" || url.protocol === "http:" && new URL(base).protocol === "http:") return url.href;
  } catch { /* A missing or unsafe source becomes an explicit image marker. */ }
}

function safeSVGImage(source: Element, document: Document): string | undefined {
  const tags = new Set(["svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "lineargradient", "radialgradient", "stop", "clippath", "marker"]);
  const attrs = new Set(["viewBox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "opacity", "fill-opacity", "stroke-opacity", "transform", "font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline", "offset", "stop-color", "stop-opacity"]);
  const rebuild = (element: Element): Element | undefined => {
    if (!tags.has(element.localName.toLowerCase())) return;
    const node = document.createElementNS(SVG_NS, element.localName);
    for (const attr of element.attributes) {
      if (attrs.has(attr.name) && !/url\s*\(|[<>]/i.test(attr.value)) node.setAttribute(attr.name, attr.value);
    }
    for (const child of element.childNodes) {
      if (child.nodeType === 3) node.append(document.createTextNode(child.textContent ?? ""));
      else if (child.nodeType === 1) { const safe = rebuild(child as Element); if (safe) node.append(safe); }
    }
    return node;
  };
  const safe = rebuild(source);
  if (!safe) return;
  safe.setAttribute("xmlns", SVG_NS);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safe.outerHTML)}`;
}
