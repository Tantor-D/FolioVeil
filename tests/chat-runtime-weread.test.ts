// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://weread.qq.com/web/reader/synthetic-book"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatReaderRuntime } from "../packages/core-runtime/src/chat-runtime";
import { DEFAULT_SETTINGS, type SettingsV2 } from "../packages/storage/src/index";

describe("WeRead chat integration", () => {
  let runtime: ChatReaderRuntime;
  let stored: SettingsV2;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    document.documentElement.innerHTML = '<head><title>源页面标题</title></head><body><span class="renderTargetPageInfo_header_chapterTitle">合成章节</span><div class="readerChapterContent"><div class="preRenderContent"></div><div class="renderTargetContainer"><canvas></canvas></div></div></body>';
    stored = { ...structuredClone(DEFAULT_SETTINGS), enabledSites: { weread: true, arxiv: true } };
    vi.stubGlobal("chrome", {
      storage: { local: { get: vi.fn(async () => ({ settings: stored })), set: vi.fn(async value => { stored = value.settings; }) }, onChanged: { addListener: vi.fn() } },
      runtime: { onMessage: { addListener: vi.fn() } }
    });
    runtime = new ChatReaderRuntime();
  });
  afterEach(async () => {
    await runtime.restore(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  function layout() {
    const root = document.querySelector(".preRenderContent")!;
    root.innerHTML = '<h1>合成章节</h1><p>合成测试正文，保持原文顺序。</p>';
    root.replaceChildren();
  }
  it("reflows transient source text and restores only the current site's preference", async () => {
    const start = runtime.start(); layout();
    await vi.advanceTimersByTimeAsync(250); await start;
    expect(runtime.getStatus()).toMatchObject({ supported: true, enabled: true, error: false });
    expect(document.querySelector("#folioveil-root")!.shadowRoot!.textContent).toContain("合成测试正文");
    expect(document.body.getAttribute("aria-hidden")).toBe("true");
    await runtime.restore();
    expect(stored.enabledSites).toEqual({ weread: false, arxiv: true });
    expect(document.title).toBe("源页面标题");
    expect(document.body.hasAttribute("inert")).toBe(false);
  });
  it("recovers when normal source loading finishes after the initial timeout", async () => {
    const start = runtime.start();
    await vi.advanceTimersByTimeAsync(10100); await start;
    expect(runtime.getStatus().error).toBe(true);
    expect(document.body.getAttribute("aria-hidden")).toBe("true");
    layout(); await vi.advanceTimersByTimeAsync(250);
    expect(runtime.getStatus().error).toBe(false);
    expect(document.querySelector("#folioveil-root")!.shadowRoot!.textContent).toContain("合成测试正文");
  });
});
