// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractWeReadDocument, isWeReadUrl, WeReadContentSource } from "../packages/adapter-weread/src/structured";

const url = "https://weread.qq.com/web/reader/synthetic-book";
const chapter = '<h2 class="readerChapterContent_title">合成章节</h2><p id="a">第一段<strong>强调</strong>。</p><p id="b">第二段。</p><p>图前<img src="https://example.com/diagram.png">图后</p>';
let source: WeReadContentSource | undefined;
afterEach(() => { source?.stop(); source = undefined; vi.useRealTimers(); });

describe("WeRead structured source", () => {
  it('resolves a selected section to its first catalog leaf instead of waiting for section-only body', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">第二辑</span><ul><li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_level_1"><span class="readerCatalog_list_item_title_text">第二辑</span></div></li><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_level_2"><span class="readerCatalog_list_item_title_text">第一篇</span></div></li><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_level_2"><span class="readerCatalog_list_item_title_text">第二篇</span></div></li></ul><div class="readerChapterContent"><div class="preRenderContent"><h1>第二辑</h1><h2>第一篇</h2><p>第一篇正文。</p></div><div class="preRenderContent"><h2>第二篇</h2><p>相邻预排版正文。</p></div></div>';
    source = new WeReadContentSource(document, () => url); source.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(source.getDocument()?.title).toBe('第一篇');
    expect(source.getDocument()?.blocks.map(block => 'html' in block ? block.html : '')).toEqual(['第二辑', '第一篇正文。']);
  });
  it('uses the selected leaf chapter when its first layout also contains a catalog group heading', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">第二辑</span><ul><li class="readerCatalog_list_item"><div class="readerCatalog_list_item_level_1"><span class="readerCatalog_list_item_title_text">第二辑</span></div></li><li class="readerCatalog_list_item readerCatalog_list_item_selected"><div class="readerCatalog_list_item_level_2"><span class="readerCatalog_list_item_title_text">第一篇</span></div></li></ul><div class="readerChapterContent"><div class="preRenderContent"><div data-wr-bd="1"><h1>第二辑</h1><h2>第一篇</h2><h3>小节</h3><p>本章正文。</p></div></div></div>';
    source = new WeReadContentSource(document, () => url); source.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(source.getDocument()?.title).toBe('第一篇');
    expect(source.getDocument()?.blocks.map(block => 'html' in block ? block.html : '')).toEqual(['第二辑', '小节', '本章正文。']);
  });

  it("restricts the reader route and does not accept similarly named hosts", () => {
    expect(isWeReadUrl(url)).toBe(true);
    expect(isWeReadUrl("https://weread.qq.com/web/shelf")).toBe(false);
    expect(isWeReadUrl("https://weread.qq.com.evil.test/web/reader/id")).toBe(false);
  });

  it("preserves paragraph order and image positions without rendering native controls", () => {
    const root = document.createElement("div"); root.innerHTML = chapter + '<button>原站控件</button><div data-wr-ignore>不属于正文</div>';
    const content = extractWeReadDocument(root, url);
    expect(content.title).toBe("合成章节");
    expect(content.blocks.map(b => b.type)).toEqual(["paragraph", "paragraph", "paragraph", "image", "paragraph"]);
    expect(JSON.stringify(content)).toContain("<strong>强调</strong>");
    expect(JSON.stringify(content)).not.toContain("原站控件");
    expect(JSON.stringify(content)).not.toContain("不属于正文");
  });

  it("preserves an observed element id when converting a semantic div to a paragraph", () => {
    const root = document.createElement("div");
    root.innerHTML = '<h2>合成章节</h2><div id="observed-source-id" data-wr-id="source-marker">正常段落。</div>';
    const content = extractWeReadDocument(root, url);
    expect(content.blocks[0]?.sourceId).toBe("observed-source-id");
    expect(root.querySelector("div[data-wr-id]")).not.toBeNull();
  });

  it("never reads canvas pixels even if a canvas is nested inside the layout content", () => {
    const pixels = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,c3ludGhldGlj');
    try {
      const root = document.createElement('div');
      root.innerHTML = '<h2>合成章节</h2><p>正常正文<canvas></canvas>图后文字。</p><canvas></canvas>';
      const content = extractWeReadDocument(root, url);
      expect(pixels).not.toHaveBeenCalled();
      expect(content.blocks.map(block => block.type)).toEqual(['paragraph', 'image', 'paragraph', 'image']);
      expect(content.blocks[0]).toMatchObject({ type: 'paragraph', html: '正常正文' });
      expect(content.blocks[2]).toMatchObject({ type: 'paragraph', html: '图后文字。' });
      for (const block of content.blocks.filter(block => block.type === 'image')) {
        expect(block).toMatchObject({ resourceKind: 'canvas', unavailableReason: '图片资源暂不可用' });
        expect(block.src).toBeUndefined();
      }
    } finally { pixels.mockRestore(); }
  });

  it("captures an authorized layout DOM that is added and cleared in the same task", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">合成章节</span><div class="readerChapterContent"><div class="preRenderContent"></div><div class="renderTargetContainer"><canvas></canvas></div></div>';
    source = new WeReadContentSource(document, () => url); source.start();
    const root = document.querySelector(".preRenderContent")!;
    root.innerHTML = chapter;
    root.replaceChildren();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()?.title).toBe("合成章节");
    expect(source.getDocument()?.blocks).toHaveLength(5);
    expect(root.children).toHaveLength(0);
  });

  it("rejects canvas-only pages instead of reading toolbars or book covers", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">合成章节</span><div class="readerChapterContent"><div class="preRenderContent"></div><div class="renderTargetContainer"><p>目录和购买提示</p><canvas></canvas></div></div>';
    source = new WeReadContentSource(document, () => url); source.start();
    const result = source.read(50);
    const assertion = expect(result).rejects.toThrow("text_content_unavailable");
    await vi.advanceTimersByTimeAsync(60); await assertion;
    expect(source.getDocument()).toBeUndefined();
  });

  it("does not retain content after stop", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<span class="renderTargetPageInfo_header_chapterTitle">合成章节</span><div class="readerChapterContent"><div class="preRenderContent">${chapter}</div></div>`;
    source = new WeReadContentSource(document, () => url); source.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()).toBeDefined();
    source.stop();
    expect(source.getDocument()).toBeUndefined();
  });

  it("selects the visible chapter even when an adjacent chapter is laid out last", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">05 当前章节</span><div class="readerChapterContent"><div class="preRenderContent"></div></div>';
    source = new WeReadContentSource(document, () => url); source.start();
    const root = document.querySelector(".preRenderContent")!;
    root.innerHTML = '<h1>05</h1><h2>当前章节</h2><p>当前章第一段。</p>';
    root.replaceChildren();
    root.innerHTML = '<h1>06</h1><h2>相邻章节</h2><p>相邻章段落。</p>';
    root.replaceChildren();
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()?.title).toBe("05 当前章节");
    expect(JSON.stringify(source.getDocument())).not.toContain("相邻章段落");
    // A real source chapter change, rather than preloading, selects the candidate.
    document.querySelector(".renderTargetPageInfo_header_chapterTitle")!.textContent = "06 相邻章节";
    expect(source.getDocument()).toBeUndefined();
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()?.title).toBe("06 相邻章节");
  });

  it("does not republish on unrelated DOM changes or cosmetic title whitespace", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<span class="renderTargetPageInfo_header_chapterTitle">合成 章节</span><div class="readerChapterContent"><div class="preRenderContent">${chapter}</div></div>`;
    source = new WeReadContentSource(document, () => url); source.start();
    await vi.advanceTimersByTimeAsync(200);
    const revision = source.getRevision();
    document.body.append(document.createElement("div"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(source.getRevision()).toBe(revision);
  });

  it.each([false, true])("compares a re-rendered adjacent chapter by body rather than its capture route (changed=%s)", async changed => {
    vi.useFakeTimers();
    const book = 'b'.repeat(23);
    let currentUrl = `https://weread.qq.com/web/reader/${book}${'a'.repeat(24)}`;
    document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">第一章</span><div class="readerChapterContent"><div class="preRenderContent"><h2>第一章</h2><p>第一章正文。</p></div><div class="preRenderContent"><h2>第二章</h2><p>第二章正文。</p></div></div>';
    source = new WeReadContentSource(document, () => currentUrl); source.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()?.title).toBe('第一章');
    currentUrl = `https://weread.qq.com/web/reader/${book}${'c'.repeat(24)}`;
    document.querySelector('.renderTargetPageInfo_header_chapterTitle')!.textContent = '第二章';
    document.querySelector('.readerChapterContent')!.innerHTML = `<div class="preRenderContent"><h2>第二章</h2><p>${changed ? '同名但不同的正文。' : '第二章正文。'}</p></div>`;
    await vi.advanceTimersByTimeAsync(250);
    if (changed) expect(source.getDocument()).toBeUndefined();
    else {
      expect(source.getDocument()?.title).toBe('第二章');
      expect(source.getDocument()?.source.url).toBe(currentUrl);
      expect(source.getDocument()?.blocks).toHaveLength(1);
      expect(source.getDocument()?.blocks[0]).toMatchObject({ html: '第二章正文。' });
    }
  });

  it("cancels pending reads immediately on restore", async () => {
    document.body.innerHTML = "";
    source = new WeReadContentSource(document, () => url); source.start();
    const result = source.read();
    const assertion = expect(result).rejects.toThrow("text_content_unavailable");
    source.stop(); await assertion;
  });

  it("captures a whole layout subtree removed with its wrapper", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">合成章节</span><div class="readerChapterContent"></div>';
    source = new WeReadContentSource(document, () => url); source.start();
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<div class="preRenderContent">${chapter}</div>`;
    document.querySelector(".readerChapterContent")!.append(wrapper); wrapper.remove();
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()?.blocks).toHaveLength(5);
    expect(source.getDocument()?.warnings).toContain("chapter_completeness_unverified");
  });

  it("does not treat similarly named removed layout outside the reader as source content", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">合成章节</span>';
    source = new WeReadContentSource(document, () => url); source.start();
    const unrelated = document.createElement("div"); unrelated.className = "preRenderContent"; unrelated.innerHTML = chapter;
    document.body.append(unrelated); unrelated.remove();
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()).toBeUndefined();
  });

  it("does not choose between released chapters with the same title and different text", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">序言</span><div class="readerChapterContent"><div class="preRenderContent"></div></div>';
    source = new WeReadContentSource(document, () => url); source.start();
    const root = document.querySelector(".preRenderContent")!;
    root.innerHTML = '<h2>序言</h2><p>第一份不同正文。</p>'; root.replaceChildren();
    root.innerHTML = '<h2>序言</h2><p>第二份不同正文。</p>'; root.replaceChildren();
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()).toBeUndefined();
    const pending = source.read(50); const assertion = expect(pending).rejects.toThrow("text_content_unavailable");
    await vi.advanceTimersByTimeAsync(60); await assertion;
  });

  it("extends a live batch with full blocks and does not replace it with a transient prefix", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="renderTargetPageInfo_header_chapterTitle">合成章节</span><div class="readerChapterContent"><div class="preRenderContent"><h2>合成章节</h2><p>第一段。</p></div></div>';
    source = new WeReadContentSource(document, () => url); source.start();
    const root = document.querySelector(".preRenderContent")!;
    await vi.advanceTimersByTimeAsync(80);
    root.insertAdjacentHTML("beforeend", "<p>第二段。</p>");
    await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()?.blocks).toHaveLength(2);
    root.querySelector("p:last-child")!.remove();
    await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()?.blocks).toHaveLength(2);
  });

  it("does not let unrelated DOM activity continually postpone a matching batch", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<span class="renderTargetPageInfo_header_chapterTitle">合成章节</span><div class="readerChapterContent"><div class="preRenderContent">${chapter}</div></div>`;
    source = new WeReadContentSource(document, () => url); source.start();
    for (let index = 0; index < 6; index++) {
      document.body.append(document.createElement("span")); await vi.advanceTimersByTimeAsync(40);
    }
    expect(source.getDocument()?.blocks).toHaveLength(5);
  });

  it("does not relabel still-mounted old text after a SPA URL change", async () => {
    vi.useFakeTimers(); let currentUrl = url;
    document.body.innerHTML = `<span class="renderTargetPageInfo_header_chapterTitle">合成章节</span><div class="readerChapterContent"><div class="preRenderContent">${chapter}</div></div>`;
    source = new WeReadContentSource(document, () => currentUrl); source.start();
    await vi.advanceTimersByTimeAsync(200); expect(source.getDocument()).toBeDefined();
    currentUrl = "https://weread.qq.com/web/reader/another-book";
    expect(source.getDocument()).toBeUndefined();
    const pending = source.read(50); const assertion = expect(pending).rejects.toThrow("text_content_unavailable");
    await vi.advanceTimersByTimeAsync(60); await assertion;
    document.querySelector(".preRenderContent")!.innerHTML = '<h2>合成章节</h2><p>另一本书的新正文。</p>';
    await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()?.source.url).toBe(currentUrl);
    expect(JSON.stringify(source.getDocument())).toContain("另一本书的新正文");
  });

  it("does not publish a scheduled old-route candidate after the URL changes", async () => {
    vi.useFakeTimers(); let currentUrl = url;
    document.body.innerHTML = `<span class="renderTargetPageInfo_header_chapterTitle">合成章节</span><div class="readerChapterContent"><div class="preRenderContent">${chapter}</div></div>`;
    source = new WeReadContentSource(document, () => currentUrl); source.start();
    currentUrl = "https://weread.qq.com/web/reader/another-book";
    await vi.advanceTimersByTimeAsync(200);
    expect(source.getDocument()).toBeUndefined();
  });
});
