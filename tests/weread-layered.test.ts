// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterSession } from "../packages/adapter-sdk/src/index";
import { WeReadAdapter } from "../packages/adapter-weread/src/index";
import { findContentSurface } from "../packages/adapter-weread/src/selectors";

const fixture = readFileSync(resolve("packages/test-fixtures/weread-layered.html"), "utf8");

describe("WeRead layered renderer", () => {
  const adapter = new WeReadAdapter();
  let session: AdapterSession | undefined;

  beforeEach(() => {
    document.documentElement.innerHTML = fixture.match(/<html[^>]*>([\s\S]*)<\/html>/)?.[1] ?? fixture;
  });

  afterEach(async () => {
    await session?.unmount();
    session = undefined;
  });

  it("selects the original visible reader instead of measurement or hidden copies", async () => {
    const nativeReader = document.getElementById("native-reader")!;
    expect(findContentSurface(document)).toBe(nativeReader);

    session = await adapter.mount({ document, location });
    const surface = await session.getContentSurface();
    expect(surface.element).toBe(nativeReader);
    expect(surface.layout).toBe("native-paginated");
    expect(surface.mode).toBe("native-overlay");
    expect(await session.healthCheck()).toEqual({ healthy: true, code: "ok" });
  });

  it("does not mistake helper class substrings or hidden copies for a content surface", async () => {
    document.getElementById("native-reader")!.remove();
    document.body.insertAdjacentHTML("beforeend", `
      <div class="readerChapterContent_title">Synthetic chapter label</div>
      <div aria-hidden="true"><div class="readerChapterContent">Synthetic inaccessible copy</div></div>
      <div class="readerChapterContent" style="display: none">Synthetic hidden copy</div>
      <div class="readerChapterContent" style="visibility: hidden">Synthetic invisible copy</div>
    `);

    expect(findContentSurface(document)).toBeNull();
    expect(await adapter.probe(document)).toMatchObject({ kind: "unsupported", reason: "content_not_found" });
    await expect(adapter.mount({ document, location })).rejects.toThrow("content_not_found");
  });

  it("recognizes a ready canvas page even when both layers contain no text", async () => {
    const nativeReader = document.getElementById("native-reader")!;
    nativeReader.innerHTML = `
      <div class="preRenderContainer"></div>
      <div class="renderTargetContainer"><canvas width="720" height="560"></canvas></div>
    `;
    expect(nativeReader.textContent?.trim()).toBe("");
    expect(await adapter.probe(document)).toMatchObject({ kind: "reader" });

    session = await adapter.mount({ document, location });
    expect((await session.getContentSurface()).layout).toBe("native-paginated");
  });

  it("does not use hidden source text as evidence that an empty renderer is ready", async () => {
    document.getElementById("native-renderer")!.replaceChildren();
    expect(await adapter.probe(document)).toMatchObject({ kind: "unsupported", reason: "renderer_not_ready" });
  });

  it("treats a conventional text reader as flow content", async () => {
    document.getElementById("native-source")!.remove();
    document.getElementById("native-renderer")!.innerHTML = "<p>Synthetic flow content</p>";
    session = await adapter.mount({ document, location });
    expect((await session.getContentSurface()).layout).toBe("flow");
  });
});
