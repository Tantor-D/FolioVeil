const HTML_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code",
  "dd", "del", "div", "dl", "dt", "em", "figcaption", "h1", "h2", "h3", "h4",
  "h5", "h6", "hr", "i", "kbd", "li", "mark", "ol", "p", "pre", "q", "s",
  "samp", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "u", "ul", "var", "wbr"
]);
const MATH_TAGS = new Set([
  "math", "maction", "menclose", "merror", "mfenced", "mfrac", "mi", "mmultiscripts",
  "mn", "mo", "mover", "mpadded", "mphantom", "mprescripts", "mroot", "mrow", "ms",
  "mspace", "msqrt", "mstyle", "msub", "msubsup", "msup", "mtable", "mtd", "mtext",
  "mtr", "munder", "munderover", "none", "semantics"
]);
const DROP_SUBTREE = new Set([
  "script", "style", "iframe", "object", "embed", "applet", "link", "meta", "base",
  "form", "input", "button", "select", "textarea", "video", "audio", "source", "track",
  "img", "picture", "svg", "canvas", "annotation", "annotation-xml", "noscript"
]);
const MATH_ATTRIBUTES = new Set([
  "display", "displaystyle", "mathvariant", "mathsize", "scriptlevel", "stretchy",
  "symmetric", "fence", "separator", "accent", "accentunder", "largeop", "movablelimits",
  "lspace", "rspace", "linethickness", "columnalign", "rowalign", "columnspacing",
  "rowspacing", "columnlines", "rowlines", "frame", "framespacing", "equalrows",
  "equalcolumns", "notation", "width", "height", "depth", "voffset", "open", "close",
  "separators", "rowspan", "columnspan"
]);
const MATH_NS = "http://www.w3.org/1998/Math/MathML";

/** Rebuild source markup; source images, styles and executable nodes never survive. */
export function sanitizeMarkup(html: string, doc: Document): DocumentFragment {
  const template = doc.createElement("template");
  template.innerHTML = html;
  const result = doc.createDocumentFragment();
  for (const node of template.content.childNodes) appendSafeNode(node, result, doc);
  return result;
}

function appendSafeNode(node: Node, parent: Node, doc: Document): void {
  if (node.nodeType === 3) {
    parent.appendChild(doc.createTextNode(node.textContent ?? ""));
    return;
  }
  if (node.nodeType !== 1) return;
  const source = node as Element;
  const tag = source.localName.toLowerCase();
  if (DROP_SUBTREE.has(tag)) return;
  const isMath = source.namespaceURI === MATH_NS && MATH_TAGS.has(tag);
  if (!isMath && !HTML_TAGS.has(tag)) {
    for (const child of source.childNodes) appendSafeNode(child, parent, doc);
    return;
  }
  const target = isMath ? doc.createElementNS(MATH_NS, tag) : doc.createElement(tag);
  if (isMath) {
    for (const attribute of source.attributes) {
      if (MATH_ATTRIBUTES.has(attribute.name) && attribute.value.length <= 120
        && !/[<>\\]|url\s*\(/i.test(attribute.value)) {
        target.setAttribute(attribute.name, attribute.value);
      }
    }
    if (tag === "math" && source.getAttribute("alttext")) {
      target.setAttribute("aria-label", source.getAttribute("alttext")!);
    }
  } else {
    if (tag === "a") {
      const href = safeLink(source.getAttribute("href"), doc.baseURI);
      if (href) {
        target.setAttribute("href", href);
        if (!href.startsWith("#")) {
          target.setAttribute("target", "_blank");
          target.setAttribute("rel", "noopener noreferrer");
        }
      }
    }
    if (tag === "td" || tag === "th") {
      for (const name of ["colspan", "rowspan"]) {
        const value = Number(source.getAttribute(name));
        if (Number.isInteger(value) && value >= 1 && value <= 100) target.setAttribute(name, String(value));
      }
      const scope = source.getAttribute("scope");
      if (scope && ["row", "col", "rowgroup", "colgroup"].includes(scope)) target.setAttribute("scope", scope);
    }
    if (tag === "ol") {
      const value = Number(source.getAttribute("start"));
      if (Number.isInteger(value) && value > 0 && value < 100_000) target.setAttribute("start", String(value));
    }
    const direction = source.getAttribute("dir");
    if (direction && ["ltr", "rtl", "auto"].includes(direction)) target.setAttribute("dir", direction);
  }
  for (const child of source.childNodes) appendSafeNode(child, target, doc);
  parent.appendChild(target);
}

function safeLink(value: string | null, base: string): string | undefined {
  if (!value) return;
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const url = new URL(trimmed, base);
    if (["https:", "http:", "mailto:"].includes(url.protocol)) return url.href;
  } catch { /* Invalid source links are rendered as text. */ }
}
