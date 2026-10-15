// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeMarkup } from "../packages/content-model/src/sanitize";

function render(html: string): HTMLElement {
  const holder = document.createElement("div");
  holder.append(sanitizeMarkup(html, document));
  return holder;
}

describe("content markup boundary", () => {
  it("removes executable content, source styling and every content image", () => {
    const safe = render(`<p class="source-ui" style="background:url(secret)" onclick="alert(1)">Read <strong>this</strong><script>private()</script><iframe src="secret"></iframe><img src="secret" alt="private caption"><svg><text>private graph</text></svg><canvas>private canvas</canvas></p>`);
    expect(safe.textContent).toBe("Read this");
    expect(safe.innerHTML).toBe("<p>Read <strong>this</strong></p>");
  });

  it("retains semantic MathML without TeX duplication or foreign HTML", () => {
    const safe = render(`<math display="block" href="javascript:alert(1)" style="position:fixed" alttext="x squared"><semantics><msup><mi>x</mi><mn>2</mn></msup><annotation encoding="application/x-tex">x^2</annotation><annotation-xml encoding="text/html"><img src="bad"><script>bad()</script></annotation-xml></semantics></math>`);
    const math = safe.querySelector("math")!;
    expect(math.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(math.getAttribute("display")).toBe("block");
    expect(math.getAttribute("aria-label")).toBe("x squared");
    expect(safe.textContent).toBe("x2");
    expect(safe.querySelector("annotation, annotation-xml, img, script")).toBeNull();
    expect(math.hasAttribute("href")).toBe(false);
    expect(math.hasAttribute("style")).toBe(false);
  });

  it("preserves table structure and bounded spans but rejects unsafe links", () => {
    const safe = render(`<table><tbody><tr><th scope="col" colspan="2">Header</th></tr><tr><td rowspan="99999"><a href="javascript:alert(1)">unsafe</a></td><td><a href="#S1">section</a><a href="https://example.org/paper">source</a></td></tr></tbody></table>`);
    expect(safe.querySelector("th")?.getAttribute("colspan")).toBe("2");
    expect(safe.querySelector("td")?.hasAttribute("rowspan")).toBe(false);
    const links = safe.querySelectorAll("a");
    expect(links[0]?.hasAttribute("href")).toBe(false);
    expect(links[1]?.getAttribute("href")).toBe("#S1");
    expect(links[2]?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
