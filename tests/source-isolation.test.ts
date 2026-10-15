// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceIsolation } from "../packages/core-runtime/src/source-isolation";

describe("chat source isolation", () => {
  let isolation: SourceIsolation;
  beforeEach(() => {
    document.documentElement.innerHTML = '<head><title>Original title</title><link rel="icon" href="/source.ico"></head><body style="width:900px"><button id="original">Source action</button></body>';
    document.documentElement.removeAttribute("style");
    isolation = new SourceIsolation(document);
  });
  afterEach(() => isolation.restore());
  it("preserves source nodes and layout declarations, excludes interaction and restores original attributes and metadata", () => {
    const body = document.body;
    const originalStyle = body.getAttribute("style");
    const button = document.querySelector("#original")!;
    isolation.mount("项目方案讨论", true);
    expect(body.getAttribute("aria-hidden")).toBe("true");
    expect(body.hasAttribute("inert")).toBe(true);
    expect(body.style.display).not.toBe("none");
    expect(body.style.width).toBe("900px");
    expect(body.style.overflow).toBe("clip");
    expect(document.title).toBe("项目方案讨论");
    expect(document.querySelector("#original")).toBe(button);
    isolation.restore();
    expect(body.getAttribute("style")).toBe(originalStyle);
    expect(body.hasAttribute("inert")).toBe(false);
    expect(body.hasAttribute("aria-hidden")).toBe(false);
    expect(document.title).toBe("Original title");
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/source.ico");
    expect(document.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
    expect(document.documentElement.hasAttribute("style")).toBe(false);
  });
  it("isolates dynamic roots including SVG but keeps the registered shell available", async () => {
    const shell = document.createElement("div");
    isolation.addOwnedNode(shell); isolation.mount(); document.documentElement.append(shell);
    const popup = document.createElement("div");
    popup.style.cssText = "visibility:visible!important;width:840px;overflow:visible;opacity:.7;pointer-events:auto";
    popup.setAttribute("aria-hidden", "false");
    popup.setAttribute("inert", "original-value");
    popup.setAttribute("data-fv-isolated", "source-owned-value");
    const originalAttributes = Object.fromEntries(Array.from(popup.attributes, attribute => [attribute.name, attribute.value]));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    document.documentElement.append(popup, svg);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(popup.hasAttribute("inert")).toBe(true);
    expect(popup.style.visibility).toBe("hidden");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(shell.hasAttribute("inert")).toBe(false);
    // An asynchronous source style or accessibility update must not expose it.
    popup.style.setProperty("visibility", "visible", "important");
    popup.style.setProperty("opacity", "1", "important");
    popup.removeAttribute("inert"); popup.setAttribute("aria-hidden", "false");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(popup.style.visibility).toBe("hidden");
    expect(popup.style.opacity).toBe("0");
    expect(popup.getAttribute("aria-hidden")).toBe("true");
    expect(popup.hasAttribute("inert")).toBe(true);
    isolation.restore();
    expect(Object.fromEntries(Array.from(popup.attributes, attribute => [attribute.name, attribute.value]))).toEqual(originalAttributes);
    expect(svg.hasAttribute("aria-hidden")).toBe(false);
    shell.remove(); popup.remove(); svg.remove();
  });
  it("allows initial source metadata to finish loading before disguising and restoring it", async () => {
    isolation.mount("项目方案讨论", false);
    document.title = "Loaded paper title";
    await Promise.resolve();
    expect(document.title).toBe("Loaded paper title");
    isolation.update("项目方案讨论", true);
    expect(document.title).toBe("项目方案讨论");
    isolation.restore();
    expect(document.title).toBe("Loaded paper title");
  });

  it("restores a source title parsed after the early privacy cover", async () => {
    document.head.querySelector("title")!.remove();
    isolation.mount("项目方案讨论", true);
    expect(document.title).toBe("项目方案讨论");
    const parsedTitle = document.createElement("title");
    parsedTitle.textContent = "Late source title";
    document.head.append(parsedTitle);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(parsedTitle.textContent).toBe("项目方案讨论");
    isolation.restore();
    expect(document.querySelectorAll("title")).toHaveLength(1);
    expect(document.title).toBe("Late source title");
  });
});
