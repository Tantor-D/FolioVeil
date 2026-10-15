import { message } from "../../i18n/src/index";

/** Keep the site's original button, event handlers and DOM ownership intact. */
export class NativeTableOfContents {
  private readonly style: HTMLStyleElement;

  static mount(document: Document, surface: HTMLElement): NativeTableOfContents | undefined {
    if (!surface.querySelector(".readerControls .readerControls_item.catalog")) return undefined;
    return new NativeTableOfContents(document);
  }

  private constructor(document: Document) {
    this.style = document.createElement("style");
    this.style.id = "folioveil-weread-native-controls";
    this.style.textContent = `
      html[data-folioveil='active'] .folioveil-native-surface .readerControls {
        position: fixed !important;
        top: auto !important;
        right: auto !important;
        bottom: 104px !important;
        left: calc(50% + 130px) !important;
        transform: translateX(-50%) !important;
        z-index: 20 !important;
        width: 64px !important;
        height: 32px !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      html[data-folioveil='active'] .folioveil-native-surface .readerControls > :not(:has(.catalog)):not(.catalog) {
        display: none !important;
      }
      html[data-folioveil='active'] .folioveil-native-surface .readerControls_item.catalog {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 64px !important;
        height: 32px !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 1px solid #6b6b6b !important;
        border-radius: 16px !important;
        background: #252527 !important;
        color: #f2f2f2 !important;
        font: 13px/30px -apple-system, BlinkMacSystemFont, sans-serif !important;
        cursor: pointer !important;
      }
      html[data-folioveil='active'] .folioveil-native-surface .readerControls_item.catalog::before {
        all: unset !important;
        content: ${JSON.stringify(message("tableOfContents"))} !important;
        white-space: nowrap !important;
      }
      html[data-folioveil='active'] .folioveil-native-surface .readerControls_item.catalog::after,
      html[data-folioveil='active'] .folioveil-native-surface .readerControls_item.catalog > * {
        display: none !important;
      }
      html[data-folioveil='active'][data-folioveil-sidebar='collapsed'] .folioveil-native-surface .readerControls {
        left: 50% !important;
      }
      @media (max-width: 820px) {
        html[data-folioveil='active'] .folioveil-native-surface .readerControls { left: 50% !important; }
      }
    `;
    document.head.append(this.style);
  }

  unmount(): void {
    this.style.remove();
  }
}
