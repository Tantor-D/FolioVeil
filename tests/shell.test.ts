// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReaderAction } from "../packages/adapter-sdk/src/index";
import { DEFAULT_SETTINGS } from "../packages/storage/src/index";
import { MinimalAssistantShell } from "../packages/theme-minimal-assistant/src/shell";

describe("reading shell privacy", () => {
  let shell: MinimalAssistantShell | undefined;

  afterEach(() => shell?.unmount());

  function mountShell(handleAction?: (action: ReaderAction) => void) {
    const onAction = vi.fn(handleAction);
    shell = new MinimalAssistantShell(
      { ...DEFAULT_SETTINGS, colorScheme: "light" },
      { nextPage: true, previousPage: false, tableOfContents: true, textSelection: true, nativeAnnotations: true },
      { onAction, onTogglePrivacy: vi.fn(), onToggleSidebar: vi.fn() }
    );
    shell.mount();
    return { shell, shadow: shell.host.shadowRoot!, onAction };
  }

  it("removes reading metadata throughout privacy mode and restores the latest state", () => {
    const { shell, shadow } = mountShell();
    shell.updateState({ status: "ready", bookTitle: "Private book", chapterTitle: "First chapter", progressLabel: "42%" });
    expect(shadow.querySelector(".title")?.textContent).toBe("Private book");

    shell.setPrivacy(true);
    expect(shadow.textContent).not.toContain("Private book");
    expect(shadow.textContent).not.toContain("First chapter");
    expect(shadow.textContent).not.toContain("42%");
    expect(shadow.querySelector<HTMLElement>(".status")?.hidden).toBe(true);

    shell.updateState({ status: "ready", bookTitle: "Another private book", chapterTitle: "Latest chapter", progressLabel: "57%" });
    expect(shadow.textContent).not.toContain("Another private book");
    expect(shadow.textContent).not.toContain("Latest chapter");
    expect(shadow.textContent).not.toContain("57%");

    shell.setPrivacy(false);
    expect(shadow.querySelector(".title")?.textContent).toBe("Another private book");
    expect(shadow.querySelector(".subtitle")?.textContent).toBe("Latest chapter");
    expect(shadow.querySelector(".progress")?.textContent).toBe(" · 57%");
    expect(shadow.querySelector<HTMLElement>(".status")?.hidden).toBe(false);
  });

  it("hides reading navigation, releases its focus, and blocks actions until privacy ends", () => {
    const { shell, shadow, onAction } = mountShell();
    const navigation = shadow.querySelector<HTMLElement>(".navigation")!;
    const buttons = navigation.querySelectorAll<HTMLButtonElement>("button");
    const next = buttons[2]!;
    next.focus();
    expect(shadow.activeElement).toBe(next);

    shell.setPrivacy(true);
    expect(navigation.hidden).toBe(true);
    expect(navigation.hasAttribute("inert")).toBe(true);
    expect(navigation.getAttribute("aria-hidden")).toBe("true");
    expect(navigation.contains(shadow.activeElement)).toBe(false);
    next.click();
    expect(onAction).not.toHaveBeenCalled();

    shell.setPrivacy(false);
    expect(navigation.hidden).toBe(false);
    expect(navigation.hasAttribute("inert")).toBe(false);
    expect(navigation.getAttribute("aria-hidden")).toBe("false");
    expect(buttons[0]?.disabled).toBe(true);
    next.click();
    expect(onAction).toHaveBeenCalledWith({ type: "next-page" });
  });

  it("allows native menu clicks without leaking the originating shell click to the page", () => {
    const nativeButton = document.createElement("button");
    document.body.append(nativeButton);
    let menuOpen = false;
    nativeButton.addEventListener("click", () => { menuOpen = true; });
    const pageClick = vi.fn((event: MouseEvent) => {
      if (event.target !== nativeButton) menuOpen = false;
    });
    document.addEventListener("click", pageClick);
    try {
      const { shadow, onAction } = mountShell((action) => {
        if (action.type === "open-toc") nativeButton.click();
      });
      shadow.querySelectorAll<HTMLButtonElement>(".navigation button")[1]!.click();

      expect(onAction).toHaveBeenCalledWith({ type: "open-toc" });
      expect(menuOpen).toBe(true);
      expect(pageClick).toHaveBeenCalledOnce();
      expect(pageClick.mock.calls[0]![0].target).toBe(nativeButton);
    } finally {
      document.removeEventListener("click", pageClick);
      nativeButton.remove();
    }
  });
});
