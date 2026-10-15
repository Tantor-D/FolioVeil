// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WeReadAdapter } from "../packages/adapter-weread/src/index";

const fixture = readFileSync(resolve("packages/test-fixtures/weread-reader.html"), "utf8");

describe("WeRead adapter contract", () => {
  const adapter = new WeReadAdapter();

  beforeEach(() => {
    document.documentElement.innerHTML = fixture.match(/<html[^>]*>([\s\S]*)<\/html>/)?.[1] ?? fixture;
  });

  it("matches only the expected HTTPS reader route", () => {
    expect(adapter.matches(new URL("https://weread.qq.com/web/reader/abc") as unknown as Location)).toBe(true);
    expect(adapter.matches(new URL("https://weread.qq.com/web/bookDetail/abc") as unknown as Location)).toBe(false);
    expect(adapter.matches(new URL("https://example.com/web/reader/abc") as unknown as Location)).toBe(false);
  });

  it("probes a synthetic reader fixture without extracting body text into state", async () => {
    const probe = await adapter.probe(document);
    expect(probe.kind).toBe("reader");
    const session = await adapter.mount({ document, location });
    const state = await session.getState();
    expect(state.status).toBe("ready");
    expect(state.bookTitle).toBe("示例读物");
    expect(state.chapterTitle).toBe("示例章节");
    expect(JSON.stringify(state)).not.toContain("适配器测试编写");
    await session.unmount();
  });

  it("delegates navigation to native controls", async () => {
    const next = document.querySelector<HTMLButtonElement>("button[aria-label='下一页']")!;
    const click = vi.spyOn(next, "click");
    const session = await adapter.mount({ document, location });
    expect(await session.perform({ type: "next-page" })).toEqual({ ok: true });
    expect(click).toHaveBeenCalledOnce();
    await session.unmount();
  });

  it("fails safely when the content surface disappears", async () => {
    const session = await adapter.mount({ document, location });
    (await session.getContentSurface()).element.remove();
    expect(await session.healthCheck()).toEqual({ healthy: false, code: "surface-detached" });
    await session.unmount();
  });

  it("does not mount a non-reader fixture", async () => {
    document.body.innerHTML = "<main><p>Short page</p></main>";
    expect((await adapter.probe(document)).kind).toBe("unsupported");
    await expect(adapter.mount({ document, location })).rejects.toThrow("content_not_found");
  });
});
