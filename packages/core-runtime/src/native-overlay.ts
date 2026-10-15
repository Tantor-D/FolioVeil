import type { ContentSurface } from "../../adapter-sdk/src/index";
import type { SettingsV1 } from "../../storage/src/index";

const SURFACE_CLASS = "folioveil-native-surface";
const STYLE_ID = "folioveil-native-styles";

export class NativeOverlay {
  private readonly surface: HTMLElement;
  private readonly style: HTMLStyleElement;
  private readonly layout: "flow" | "native-paginated";
  private readonly originalInert: boolean;

  constructor(contentSurface: ContentSurface, settings: SettingsV1) {
    if (contentSurface.mode !== "native-overlay") throw new Error("unsupported_surface_mode");
    this.surface = contentSurface.element;
    this.layout = contentSurface.layout ?? "flow";
    this.originalInert = this.surface.inert;
    this.style = document.createElement("style");
    this.style.id = STYLE_ID;
    this.surface.classList.add(SURFACE_CLASS);
    this.surface.dataset.folioveilLayout = this.layout;
    document.documentElement.dataset.folioveil = "active";
    document.head.append(this.style);
    this.update(settings);
  }

  update(settings: SettingsV1): void {
    document.documentElement.dataset.folioveilSidebar = settings.sidebarCollapsed ? "collapsed" : "expanded";
    document.documentElement.dataset.folioveilColorScheme = settings.colorScheme;
    this.style.textContent = createNativeStyles(settings, this.layout);
  }

  setPrivacy(active: boolean): void {
    document.documentElement.dataset.folioveilPrivacy = active ? "active" : "inactive";
    this.surface.inert = active || this.originalInert;
  }

  unmount(): void {
    this.surface.classList.remove(SURFACE_CLASS);
    delete this.surface.dataset.folioveilLayout;
    this.surface.inert = this.originalInert;
    this.style.remove();
    delete document.documentElement.dataset.folioveil;
    delete document.documentElement.dataset.folioveilSidebar;
    delete document.documentElement.dataset.folioveilPrivacy;
    delete document.documentElement.dataset.folioveilColorScheme;
  }
}

function createNativeStyles(settings: SettingsV1, layout: "flow" | "native-paginated"): string {
  const left = settings.sidebarCollapsed ? 0 : 260;
  const paginated = layout === "native-paginated";
  return `
    html[data-folioveil='active'] .${SURFACE_CLASS} {
      position: fixed !important;
      z-index: 2147482000 !important;
      top: 64px !important;
      right: 0 !important;
      bottom: 88px !important;
      left: ${left}px !important;
      width: auto !important;
      max-width: none !important;
      height: auto !important;
      min-height: 0 !important;
      margin: 0 !important;
      ${paginated ? "padding: 0 !important;" : `padding: 42px max(24px, calc((100vw - ${left}px - ${settings.contentWidth}px) / 2)) 64px !important;
      overflow: auto !important;
      color: #242426 !important;
      background: #fff !important;
      font-size: ${settings.fontSize}px !important;
      line-height: ${settings.lineHeight} !important;`}
      box-sizing: border-box !important;
      pointer-events: auto;
      overscroll-behavior: contain;
    }
    html[data-folioveil='active'][data-folioveil-privacy='active'] .${SURFACE_CLASS} {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    html[data-folioveil='active'] .${SURFACE_CLASS}[data-folioveil-layout='flow'] p { max-width: ${settings.contentWidth}px !important; margin-right: auto !important; margin-left: auto !important; }
    html[data-folioveil='active'][data-folioveil-color-scheme='dark'] .${SURFACE_CLASS}[data-folioveil-layout='flow'] {
      color: #ececf1 !important;
      background: #2b2c2f !important;
    }
    @media (prefers-color-scheme: dark) {
      html[data-folioveil='active'][data-folioveil-color-scheme='system'] .${SURFACE_CLASS}[data-folioveil-layout='flow'] {
        color: #ececf1 !important;
        background: #2b2c2f !important;
      }
    }
    @media (max-width: 820px) {
      html[data-folioveil='active'] .${SURFACE_CLASS} { left: 0 !important; ${paginated ? "" : "padding-right: 20px !important; padding-left: 20px !important;"} }
    }
  `;
}
