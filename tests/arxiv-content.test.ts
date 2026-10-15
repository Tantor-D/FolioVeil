// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractArxivDocument, releaseArxivResources } from "../packages/adapter-arxiv/src/index";

const URL = "https://arxiv.org/html/2401.04088v1";
function source(html: string): Document {
  return new DOMParser().parseFromString(`<article class="ltx_document"><h1 class="ltx_title_document">Synthetic Paper</h1>${html}</article>`, "text/html");
}

describe("structured arXiv HTML extraction", () => {
  it("extracts semantic order once, keeps formulas and table cells, and excludes source chrome", () => {
    const input = source(`<nav>Source menu</nav><div class="ltx_authors">Private Author</div><section id="S1"><h2>1 Introduction</h2><p id="p1">Before <math><mi>x</mi><mo>+</mo><mn>1</mn></math> after.</p><div class="ltx_equation" id="E1"><math display="block" alttext="x squared"><msup><mi>x</mi><mn>2</mn></msup></math><span>(1)</span></div><figure id="T1" class="ltx_table"><table class="ltx_tabular"><tr><th>A</th><td>1</td></tr></table><figcaption>Table 1: Data</figcaption></figure><p id="p2">Last.</p></section>`);
    input.body.setAttribute("inert", "");
    input.body.setAttribute("aria-hidden", "true");
    const result = extractArxivDocument(input, URL);
    expect(result.title).toBe("Synthetic Paper");
    expect(result.blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "math", "table", "paragraph"]);
    expect(result.blocks[0]?.sourceId).toBe("S1");
    expect(JSON.stringify(result.blocks)).not.toContain("Source menu");
    expect(JSON.stringify(result.blocks)).not.toContain("Private Author");
    const equation = result.blocks.find((block) => block.type === "math")!;
    expect(equation.type === "math" && equation.html).toContain("<msup>");
    const table = result.blocks.find((block) => block.type === "table")!;
    expect(table.type === "table" && table.caption).toBe("Table 1: Data");
    expect(result.blocks.map((block) => block.id)).toEqual(extractArxivDocument(input, URL).blocks.map((block) => block.id));
  });

  it("extracts the right image resource and caption without leaking them into prose", () => {
    const input = source(`<p id="p1">See <a href="#F1">Figure 1</a>.</p><figure id="F1"><picture><source srcset="ignored.webp"><img src="images/figure.png" alt="Very sensitive alternate description"></picture><figcaption><span class="ltx_tag">Figure 1:</span> Correct caption.</figcaption></figure><p>Follow <a href="/abs/2401.04088">the abstract</a>.</p>`);
    const result = extractArxivDocument(input, URL);
    const image = result.blocks.find((block) => block.type === "image")!;
    expect(image.type === "image" && image.src).toBe("https://arxiv.org/html/images/figure.png");
    expect(image.type === "image" && image.caption).toBe("Figure 1: Correct caption.");
    expect(image.sourceId).toBe("F1");
    expect(JSON.stringify(result.blocks)).not.toContain("Very sensitive alternate description");
    const paragraphs = result.blocks.filter((block) => block.type === "paragraph");
    expect(paragraphs[1]?.type === "paragraph" && paragraphs[1].html).toContain("https://arxiv.org/abs/2401.04088");
  });

  it("does not omit media mixed into a paragraph and sanitizes standalone SVG", () => {
    const input = source(`<p id="p1">Before <img src="https://example.org/a.png"> after.</p><svg viewBox="0 0 100 100" onload="bad()"><script>bad()</script><foreignObject><p>private</p></foreignObject><rect width="100" height="100" fill="#abc"/><image href="https://tracker.example/x"/></svg>`);
    const result = extractArxivDocument(input, URL);
    expect(result.blocks.map((block) => block.type)).toEqual(["paragraph", "image", "paragraph", "image"]);
    const svg = result.blocks[3]!;
    expect(svg.type).toBe("image");
    const decoded = decodeURIComponent(svg.type === "image" ? svg.src! : "");
    expect(decoded).toContain("<rect");
    expect(decoded).not.toMatch(/script|foreignObject|onload|tracker/);
  });

  it("converts embedded SVG into image resources and preserves table figures as tables", () => {
    const input = source(`<p>Some text.</p><figure id="F7"><object type="image/svg+xml" data="2401.04088v1/routing.svg"><p>Fallback</p></object><figcaption>Figure 7: <math><semantics><mi>x</mi><annotation encoding="application/x-tex">DUPLICATE</annotation></semantics></math> routes.</figcaption></figure><figure id="F5"><table><tr><td>0.9</td></tr></table><figcaption>Figure 5: Data.</figcaption></figure>`);
    const result = extractArxivDocument(input, URL);
    const image = result.blocks[1]!;
    expect(image.type === "image" && image.resourceKind).toBe("svg");
    expect(image.type === "image" && image.src).toBe("https://arxiv.org/html/2401.04088v1/routing.svg");
    expect(image.type === "image" && image.caption).toBe("Figure 7: x routes.");
    expect(result.blocks[2]?.type).toBe("table");
    expect(result.blocks[2]?.sourceId).toBe("F5");
  });

  it("keeps companion markers for images inside lists and tables, with explicit layout warnings", () => {
    const input = source(`<p>Some text.</p><ul><li>A <img data-formula src="https://example.org/formula.png"></li></ul><table><tr><td><img src="https://example.org/cell.png"></td></tr></table>`);
    const result = extractArxivDocument(input, URL);
    expect(result.blocks.map((block) => block.type)).toEqual(["paragraph", "list", "image", "table", "image"]);
    expect(result.warnings).toEqual(["list_contains_media", "table_contains_media"]);
    expect(result.blocks[2]?.type === "image" && result.blocks[2].label).toContain("公式图片");
  });

  it("turns source footnote popups into one inline note without duplicate source markers", () => {
    const input = source(`<p>Reading<span class="ltx_note"><sup class="ltx_note_mark">1</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">1</sup><span class="ltx_tag_note">1</span>Helpful note.</span></span></span> continues.</p>`);
    const result = extractArxivDocument(input, URL);
    const paragraph = result.blocks[0]!;
    const html = paragraph.type === "paragraph" ? paragraph.html : "";
    expect(html.match(/<sup>/g)).toHaveLength(1);
    expect(html.match(/Helpful note\./g)).toHaveLength(1);
    expect(html).not.toContain("ltx_note");
  });

  it("preserves class-based emphasis and omits duplicated source list bullets", () => {
    const input = source(`<p><span class="ltx_font_bold">Best</span> <span class="ltx_font_italic">variable</span> <a class="ltx_font_typewriter" href="https://example.org">link</a></p><ul><li><span class="ltx_tag_item">•</span> An item.</li></ul>`);
    const result = extractArxivDocument(input, URL);
    const paragraph = result.blocks[0]!;
    const html = paragraph.type === "paragraph" ? paragraph.html : "";
    expect(html).toContain("<strong>Best</strong>");
    expect(html).toContain("<em>variable</em>");
    expect(html).toContain("<code>link</code>");
    const list = result.blocks[1]!;
    expect(list.type === "list" && list.items[0]).not.toContain("•");
  });

  it("preserves fractional MathML in captions and uses source expressions for text fallback", () => {
    const input = source(`<p>Some text.</p><figure><img src="https://example.org/a.png"><figcaption>Figure 1: <math alttext="1/8"><semantics><mfrac><mn>1</mn><mn>8</mn></mfrac><annotation encoding="application/x-tex">DUPLICATE</annotation></semantics></math> of tokens.</figcaption></figure><table><caption>Table 1: <math><mfrac><mn>2</mn><mn>5</mn></mfrac></math></caption><tr><td>Value</td></tr></table>`);
    const result = extractArxivDocument(input, URL);
    const image = result.blocks[1]!;
    expect(image.type === "image" && image.caption).toBe("Figure 1: 1/8 of tokens.");
    expect(image.type === "image" && image.captionHtml).toContain("<mfrac>");
    expect(image.type === "image" && image.captionHtml).not.toContain("DUPLICATE");
    const table = result.blocks[2]!;
    expect(table.type === "table" && table.caption).toBe("Table 1: (2)/(5)");
    expect(table.type === "table" && table.captionHtml).toContain("<mfrac>");
    expect(table.type === "table" && table.html).not.toContain("<caption>");
  });

  it("keeps failed media as explicit markers, rejects unsupported pages and does not mutate source", () => {
    const input = source(`<p>Some text.</p><img src="javascript:alert(1)"><figure><figcaption>Figure 2: Missing.</figcaption></figure>`);
    const original = input.documentElement.outerHTML;
    const result = extractArxivDocument(input, URL);
    expect(result.blocks.filter((block) => block.type === "image")).toHaveLength(2);
    expect(result.warnings).toContain("image_resource_unavailable");
    releaseArxivResources(result);
    expect(input.documentElement.outerHTML).toBe(original);
    expect(() => extractArxivDocument(input, "https://example.org/html/paper")).toThrow("unsupported_source");
    expect(() => extractArxivDocument(source("<canvas></canvas>"), URL)).toThrow("text_content_unavailable");
  });

  it("provides a rich self-authored fixture using the same content path", () => {
    const fixture = readFileSync(resolve("packages/test-fixtures/paper-sample.html"), "utf8");
    const input = new DOMParser().parseFromString(fixture, "text/html");
    const result = extractArxivDocument(input, "http://localhost:4173/sample");
    expect(result.source.kind).toBe("fixture");
    expect(result.blocks.length).toBeGreaterThan(35);
    expect(result.blocks.filter((block) => block.type === "image")).toHaveLength(2);
    expect(result.blocks.some((block) => block.type === "table")).toBe(true);
    expect(result.blocks.some((block) => block.type === "math")).toBe(true);
    expect(result.blocks.some((block) => block.sourceId === "reference-1")).toBe(true);
    expect(JSON.stringify(result.blocks)).not.toContain("原站页脚");
  });
});
