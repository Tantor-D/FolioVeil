// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterSession } from "../packages/adapter-sdk/src/index";
import { WeReadAdapter } from "../packages/adapter-weread/src/index";
import { NativeTableOfContents } from "../packages/adapter-weread/src/native-toc";
import { NativeOverlay } from "../packages/core-runtime/src/native-overlay";
import { message } from "../packages/i18n/src/index";
import { DEFAULT_SETTINGS } from "../packages/storage/src/index";
import { MinimalAssistantShell } from "../packages/theme-minimal-assistant/src/shell";

const STYLE_ID = "folioveil-weread-native-controls";
const settings = { ...DEFAULT_SETTINGS, colorScheme: "light" as const };

describe("direct native table of contents", () => {
  let surface: HTMLElement;
  let button: HTMLButtonElement;
  let nativeToc: NativeTableOfContents | undefined;
  let session: AdapterSession | undefined;
  let overlay: NativeOverlay | undefined;
  let shell: MinimalAssistantShell | undefined;

  beforeEach(() => {
    document.documentElement.innerHTML = `
      <head><style id="native-control-styles">
        .readerControls { position: absolute; }
        .readerControls_item.catalog { position: absolute; }
      </style></head>
      <body>
        <main>
          <div class="readerChapterContent" id="native-reader">
            <div class="preRenderContainer"></div>
            <div class="renderTargetContainer"><canvas></canvas></div>
            <div class="readerControls" id="native-controls">
              <button type="button" class="readerControls_item prev">Previous</button>
              <button type="button" class="readerControls_item catalog" id="native-toc"
                aria-label="目录" aria-expanded="false" data-native-state="ready"
                style="--native-control-color: blue"><span>Native icon</span></button>
              <button type="button" class="readerControls_item next">Next</button>
            </div>
          </div>
        </main>
      </body>`;
    for (const { name } of [...document.documentElement.attributes]) {
      if (name.startsWith("data-folioveil")) document.documentElement.removeAttribute(name);
    }
    surface = document.getElementById("native-reader")!;
    button = document.querySelector<HTMLButtonElement>("#native-toc")!;
    // jsdom does not implement inert; the browser initially supplies false.
    surface.inert = false;
  });

  afterEach(async () => {
    shell?.unmount();
    shell = undefined;
    overlay?.unmount();
    overlay = undefined;
    await session?.unmount();
    session = undefined;
    nativeToc?.unmount();
    nativeToc = undefined;
    vi.restoreAllMocks();
  });

  it("preserves the native node, parent, children, attributes and event handlers through mount and unmount", () => {
    const parent = button.parentElement!;
    const icon = button.firstElementChild;
    const originalMarkup = surface.outerHTML;
    const directListener = vi.fn();
    const delegatedListener = vi.fn();
    const propertyListener = vi.fn();
    button.addEventListener("click", directListener);
    parent.addEventListener("click", delegatedListener);
    button.onclick = propertyListener;
    const click = vi.spyOn(button, "click");
    const dispatch = vi.spyOn(button, "dispatchEvent");

    nativeToc = NativeTableOfContents.mount(document, surface);
    expect(nativeToc).toBeDefined();
    expect(document.getElementById("native-toc")).toBe(button);
    expect(button.parentElement).toBe(parent);
    expect(button.firstElementChild).toBe(icon);
    expect(button.onclick).toBe(propertyListener);
    expect(surface.outerHTML).toBe(originalMarkup);
    expect(click).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(directListener).not.toHaveBeenCalled();

    // This test event checks listener preservation, not trusted browser input.
    button.click();
    expect(directListener).toHaveBeenCalledOnce();
    expect(delegatedListener).toHaveBeenCalledOnce();
    expect(propertyListener).toHaveBeenCalledOnce();

    nativeToc!.unmount();
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(document.getElementById("native-toc")).toBe(button);
    expect(button.parentElement).toBe(parent);
    expect(button.firstElementChild).toBe(icon);
    expect(button.onclick).toBe(propertyListener);
    expect(surface.outerHTML).toBe(originalMarkup);
    expect(click).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    button.click();
    expect(directListener).toHaveBeenCalledTimes(2);
    expect(delegatedListener).toHaveBeenCalledTimes(2);
    expect(propertyListener).toHaveBeenCalledTimes(2);
  });

  it("applies positioning only inside an active reading surface and removes its stylesheet on unmount", () => {
    const controls = button.parentElement!;
    const unrelatedControls = document.createElement("div");
    unrelatedControls.className = "readerControls";
    const unrelatedButton = button.cloneNode(true) as HTMLButtonElement;
    unrelatedButton.id = "other-native-toc";
    unrelatedControls.append(unrelatedButton);
    document.body.append(unrelatedControls);
    const nativeStyles = document.getElementById("native-control-styles");

    nativeToc = NativeTableOfContents.mount(document, surface);
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);
    // The native button may have only aria-label, not title. Keep a visible
    // label even when the site's original icon children are visually hidden.
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.getElementById(STYLE_ID)!.textContent).toContain(
      `content: ${JSON.stringify(message("tableOfContents"))} !important`
    );
    expect(getComputedStyle(controls).position).toBe("absolute");
    document.documentElement.dataset.folioveil = "active";
    expect(getComputedStyle(controls).position).toBe("absolute");
    surface.classList.add("folioveil-native-surface");
    expect(getComputedStyle(controls).position).toBe("fixed");
    expect(getComputedStyle(unrelatedControls).position).toBe("absolute");

    delete document.documentElement.dataset.folioveil;
    expect(getComputedStyle(controls).position).toBe("absolute");
    document.documentElement.dataset.folioveil = "active";
    nativeToc!.unmount();
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(document.getElementById("native-control-styles")).toBe(nativeStyles);
    expect(getComputedStyle(controls).position).toBe("absolute");
  });

  it("does not enable direct presentation or add styles when the reader has no native catalog button", async () => {
    button.remove();
    expect(NativeTableOfContents.mount(document, surface)).toBeUndefined();
    expect(document.getElementById(STYLE_ID)).toBeNull();
    session = await new WeReadAdapter().mount({ document, location });
    expect(session.getCapabilities().tableOfContents).toBe(false);
    expect(session.getCapabilities().tableOfContentsPresentation).toBeUndefined();
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it("does not capture a matching control outside the reader surface", () => {
    document.body.append(button.parentElement!);
    expect(NativeTableOfContents.mount(document, surface)).toBeUndefined();
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it("refuses synthetic TOC actions in direct mode while retaining page navigation and cleaning up on unmount", async () => {
    const click = vi.spyOn(button, "click");
    const dispatch = vi.spyOn(button, "dispatchEvent");
    const tocListener = vi.fn();
    const nextListener = vi.fn();
    button.addEventListener("click", tocListener);
    surface.querySelector(".next")!.addEventListener("click", nextListener);
    session = await new WeReadAdapter().mount({ document, location });
    expect(session.getCapabilities()).toMatchObject({
      tableOfContents: true,
      tableOfContentsPresentation: "native-control"
    });

    expect(await session.perform({ type: "open-toc" })).toEqual({ ok: false, reason: "unsupported" });
    expect(await session.perform({ type: "open-toc" })).toEqual({ ok: false, reason: "unsupported" });
    expect(click).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(tocListener).not.toHaveBeenCalled();
    expect(await session.perform({ type: "next-page" })).toEqual({ ok: true });
    expect(nextListener).toHaveBeenCalledOnce();

    await session.unmount();
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(document.getElementById("native-toc")).toBe(button);
  });

  it("renders only previous and next shell controls and hides all reading navigation in privacy mode", async () => {
    session = await new WeReadAdapter().mount({ document, location });
    overlay = new NativeOverlay(await session.getContentSurface(), settings);
    const onAction = vi.fn();
    shell = new MinimalAssistantShell(settings, session.getCapabilities(), {
      onAction,
      onTogglePrivacy: vi.fn(),
      onToggleSidebar: vi.fn()
    });
    shell.mount();
    const shadow = shell.host.shadowRoot!;
    const navigation = shadow.querySelector<HTMLElement>(".navigation")!;
    const buttons = [...navigation.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons).toHaveLength(2);
    buttons[0]!.click();
    buttons[1]!.click();
    expect(onAction.mock.calls.map(([action]) => action)).toEqual([
      { type: "previous-page" },
      { type: "next-page" }
    ]);
    expect(surface.contains(button)).toBe(true);
    expect(shadow.contains(button)).toBe(false);

    onAction.mockClear();
    buttons[0]!.focus();
    overlay.setPrivacy(true);
    shell.setPrivacy(true);
    expect(navigation.hidden).toBe(true);
    expect(navigation.hasAttribute("inert")).toBe(true);
    expect(navigation.getAttribute("aria-hidden")).toBe("true");
    expect(navigation.contains(shadow.activeElement)).toBe(false);
    expect(surface.inert).toBe(true);
    expect(getComputedStyle(surface).opacity).toBe("0");
    expect(getComputedStyle(surface).pointerEvents).toBe("none");
    for (const control of buttons) control.click();
    expect(onAction).not.toHaveBeenCalled();

    overlay.setPrivacy(false);
    shell.setPrivacy(false);
    expect(navigation.hidden).toBe(false);
    expect(navigation.hasAttribute("inert")).toBe(false);
    expect(surface.inert).toBe(false);
    expect(getComputedStyle(surface).opacity).not.toBe("0");
    buttons[1]!.click();
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: "next-page" });
  });
});
