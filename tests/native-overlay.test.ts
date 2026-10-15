// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeOverlay } from "../packages/core-runtime/src/native-overlay";
import { DEFAULT_SETTINGS } from "../packages/storage/src/index";

const fixture = readFileSync(resolve("packages/test-fixtures/weread-layered.html"), "utf8");

function styles(element: Element, properties: string[]): Record<string, string> {
  const computed = getComputedStyle(element);
  return Object.fromEntries(properties.map((property) => [property, computed.getPropertyValue(property)]));
}

describe("native overlay with a layered renderer", () => {
  let overlay: NativeOverlay | undefined;
  let surface: HTMLElement;

  beforeEach(() => {
    document.documentElement.innerHTML = fixture.match(/<html[^>]*>([\s\S]*)<\/html>/)?.[1] ?? fixture;
    surface = document.getElementById("native-reader")!;
    // jsdom does not implement inert; supply the initial browser property value.
    surface.inert = false;
  });

  afterEach(() => {
    overlay?.unmount();
    overlay = undefined;
  });

  function mount() {
    overlay = new NativeOverlay(
      { mode: "native-overlay", element: surface, layout: "native-paginated" },
      { ...DEFAULT_SETTINGS, colorScheme: "light" }
    );
    return overlay;
  }

  it("preserves native typography, colors, transparent background, and paragraph coordinates", () => {
    const paragraph = document.getElementById("native-selection")!;
    const source = document.getElementById("native-source")!;
    const surfaceProperties = ["font-size", "line-height", "color", "background-color"];
    const paragraphProperties = ["position", "top", "left", "width", "max-width", "margin-left", "margin-right", "font-size", "line-height", "color"];
    const nativeSurface = styles(surface, surfaceProperties);
    const nativeParagraph = styles(paragraph, paragraphProperties);
    expect(getComputedStyle(source).display).toBe("none");

    const mounted = mount();
    expect(styles(surface, surfaceProperties)).toEqual(nativeSurface);
    expect(styles(paragraph, paragraphProperties)).toEqual(nativeParagraph);
    expect(getComputedStyle(source).display).toBe("none");

    mounted.update({ ...DEFAULT_SETTINGS, colorScheme: "dark", fontSize: 26, lineHeight: 2.2, contentWidth: 560, sidebarCollapsed: true });
    expect(styles(surface, surfaceProperties)).toEqual(nativeSurface);
    expect(styles(paragraph, paragraphProperties)).toEqual(nativeParagraph);
    expect(getComputedStyle(source).display).toBe("none");
  });

  it("keeps the native elements, their inline styles, and their event handlers intact", () => {
    const renderer = document.getElementById("native-renderer")!;
    const paragraph = document.getElementById("native-selection")!;
    const canvas = renderer.querySelector("canvas")!;
    const originalParent = surface.parentElement;
    const originalMarkup = surface.innerHTML;
    const originalInlineStyle = surface.getAttribute("style");
    const onNativeSelection = vi.fn();
    paragraph.addEventListener("click", onNativeSelection);

    mount();
    expect(document.getElementById("native-reader")).toBe(surface);
    expect(surface.parentElement).toBe(originalParent);
    expect(surface.querySelector("#native-renderer")).toBe(renderer);
    expect(surface.querySelector("canvas")).toBe(canvas);
    expect(surface.querySelector("#native-selection")).toBe(paragraph);
    expect(surface.innerHTML).toBe(originalMarkup);
    expect(surface.getAttribute("style")).toBe(originalInlineStyle);
    paragraph.click();
    expect(onNativeSelection).toHaveBeenCalledOnce();
  });

  it.each([false, true])("restores the original inert=%s after privacy and unmount", (originalInert) => {
    surface.inert = originalInert;
    const mounted = mount();
    mounted.setPrivacy(true);
    expect(surface.inert).toBe(true);
    expect(getComputedStyle(surface).opacity).toBe("0");
    expect(getComputedStyle(surface).pointerEvents).toBe("none");

    mounted.setPrivacy(false);
    expect(surface.inert).toBe(originalInert);
    expect(getComputedStyle(surface).opacity).not.toBe("0");
    mounted.setPrivacy(true);
    mounted.unmount();
    expect(surface.inert).toBe(originalInert);
  });

  it("restores native styles and removes all extension markers across repeated mounts", () => {
    const originalClass = surface.className;
    const originalInlineStyle = surface.getAttribute("style");
    const originalStyles = styles(surface, ["position", "width", "height", "font-size", "line-height", "color", "background-color"]);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const mounted = mount();
      expect(document.querySelectorAll("#folioveil-native-styles")).toHaveLength(1);
      mounted.setPrivacy(true);
      mounted.unmount();

      expect(document.querySelectorAll("#folioveil-native-styles")).toHaveLength(0);
      expect(surface.className).toBe(originalClass);
      expect(surface.getAttribute("style")).toBe(originalInlineStyle);
      expect(surface.hasAttribute("data-folioveil-layout")).toBe(false);
      expect(styles(surface, Object.keys(originalStyles))).toEqual(originalStyles);
      expect(surface.inert).toBe(false);
      expect([...document.documentElement.attributes].filter(({ name }) => name.startsWith("data-folioveil"))).toHaveLength(0);
    }
  });
});
