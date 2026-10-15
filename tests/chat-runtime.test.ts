// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://arxiv.org/html/2401.00001v1"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatReaderRuntime } from "../packages/core-runtime/src/chat-runtime";
import { DEFAULT_SETTINGS, type SettingsV2 } from "../packages/storage/src/index";

describe("chat runtime privacy boundary", () => {
  let runtime: ChatReaderRuntime;
  let stored: SettingsV2;
  let receiveMessage: (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  let settingsChanged: (changes: Record<string, { newValue: unknown }>, area: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    document.documentElement.innerHTML = '<head><title>Private paper title</title><link rel="icon" href="/paper.ico"></head><body><article class="ltx_document"><h1 class="ltx_title_document">Private paper title</h1><p>This is the private original paper text. The source text stays on this page and should not appear in the privacy scene. It is sufficiently long to be recognized as a readable article.</p></article></body>';
    stored = { ...structuredClone(DEFAULT_SETTINGS), disguiseTab: false, enabledSites: { weread: false, arxiv: true } };
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: vi.fn(async () => ({ settings: stored })), set: vi.fn(async (value: { settings: SettingsV2 }) => { stored = value.settings; }) },
        onChanged: { addListener: vi.fn(callback => { settingsChanged = callback; }) }
      },
      runtime: { onMessage: { addListener: vi.fn(callback => { receiveMessage = callback; }) } }
    });
    runtime = new ChatReaderRuntime();
  });
  afterEach(async () => {
    await runtime.restore();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  const send = (type: string) => receiveMessage({ type }, {}, () => undefined);

  it("forces neutral tab metadata throughout privacy even with disguise preference disabled", async () => {
    await runtime.start();
    expect(document.title).toBe("Private paper title");
    send("FV_TOGGLE_PRIVACY");
    expect(runtime.getStatus().privacy).toBe(true);
    expect(document.title).toBe(DEFAULT_SETTINGS.sessionName);
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toMatch(/^data:image\/svg\+xml/);
    const next = { ...stored, sessionName: "中性会话", disguiseTab: false };
    settingsChanged({ settings: { newValue: next } }, "local");
    expect(document.title).toBe("中性会话");
    send("FV_TOGGLE_CONTROLS");
    expect(document.title).toBe("中性会话");
    expect(runtime.getStatus().privacy).toBe(true);
    send("FV_TOGGLE_PRIVACY");
    expect(document.title).toBe("Private paper title");
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/paper.ico");
    expect(stored.disguiseTab).toBe(false);
  });

  it("starts protected when the popup enabled the reader after the page already lost focus", async () => {
    stored.autoPrivacy = true;
    stored.enabledSites.arxiv = false;
    await runtime.start();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await runtime.enable();
    expect(runtime.getStatus().privacy).toBe(true);
    expect(document.title).toBe(DEFAULT_SETTINGS.sessionName);
    const shadow = document.querySelector("#folioveil-root")!.shadowRoot!;
    expect(shadow.textContent).not.toContain("Private paper title");
    expect(shadow.textContent).not.toContain("This is the private original paper text");
    window.dispatchEvent(new Event("focus"));
    expect(runtime.getStatus().privacy).toBe(true);
  });

  it("respects explicitly disabled automatic privacy during inactive first enable", async () => {
    stored.autoPrivacy = false;
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await runtime.start();
    expect(runtime.getStatus().privacy).toBe(false);
    expect(document.title).toBe("Private paper title");
  });
});
