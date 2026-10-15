type AttributeSnapshot = Map<string, string | null>;
const ICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#343434"/><path d="M9 11h14M9 16h11M9 21h8" stroke="white" stroke-width="2"/></svg>');

/** Keeps source layout measurable while excluding it from input and accessibility. */
export class SourceIsolation {
  private readonly owned = new Set<Element>();
  private readonly roots = new Map<Element, AttributeSnapshot>();
  private readonly icons = new Map<HTMLLinkElement, string | null>();
  private readonly titles = new Map<HTMLTitleElement, string>();
  private observer?: MutationObserver;
  private style?: HTMLStyleElement;
  private cover?: HTMLDivElement;
  private icon?: HTMLLinkElement;
  private temporaryTitle?: HTMLTitleElement;
  private htmlStyle: string | null = null;
  private active = false;
  private disguise = true;
  private sessionName = "项目方案讨论";

  constructor(private readonly doc: Document = document) {}

  mount(sessionName = this.sessionName, disguise = true): void {
    if (this.active) return;
    this.active = true;
    this.sessionName = sessionName;
    this.disguise = disguise;
    this.htmlStyle = this.doc.documentElement.getAttribute("style");
    this.doc.documentElement.style.setProperty("overflow", "hidden", "important");
    this.doc.documentElement.style.setProperty("background", "#ffffff", "important");
    this.style = this.doc.createElement("style");
    this.owned.add(this.style);
    this.style.textContent = '[data-fv-isolated], [data-fv-isolated] * { visibility: hidden !important; pointer-events: none !important; }';
    this.doc.documentElement.append(this.style);
    this.cover = this.doc.createElement("div");
    this.owned.add(this.cover);
    this.cover.setAttribute("aria-label", "正在加载内容");
    this.cover.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:#fff;visibility:visible;pointer-events:auto";
    this.doc.documentElement.append(this.cover);
    this.scan();
    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(this.doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["rel", "href", "style", "inert", "aria-hidden", "data-fv-isolated"], characterData: true });
  }

  /** Register a detached host before mounting it. */
  addOwnedNode(node: Element): void { this.owned.add(node); }

  revealShell(): void { this.cover?.remove(); this.cover = undefined; }

  update(sessionName: string, disguise: boolean): void {
    if (!disguise && this.disguise) this.restoreMetadata();
    this.sessionName = sessionName;
    this.disguise = disguise;
    if (this.active) this.updateTab();
  }

  restore(): void {
    if (!this.active) return;
    this.active = false;
    this.observer?.disconnect();
    this.observer = undefined;
    this.style?.remove();
    this.cover?.remove();
    for (const [root, attributes] of this.roots) for (const [name, value] of attributes) restoreAttribute(root, name, value);
    this.roots.clear();
    this.restoreMetadata();
    restoreAttribute(this.doc.documentElement, "style", this.htmlStyle);
    this.owned.clear();
  }

  private scan(): void {
    if (!this.active) return;
    for (const node of Array.from(this.doc.documentElement.children)) {
      if (node.tagName === "HEAD" || this.owned.has(node)) continue;
      if (!this.roots.has(node)) this.roots.set(node, new Map(["inert", "aria-hidden", "data-fv-isolated", "style"].map(name => [name, node.getAttribute(name)])));
      if (!node.hasAttribute("inert")) node.setAttribute("inert", "");
      if (node.getAttribute("aria-hidden") !== "true") node.setAttribute("aria-hidden", "true");
      if (!node.hasAttribute("data-fv-isolated")) node.setAttribute("data-fv-isolated", "");
      if (node instanceof HTMLElement || node instanceof SVGElement) {
        if (node.style.getPropertyValue("visibility") !== "hidden" || node.style.getPropertyPriority("visibility") !== "important") node.style.setProperty("visibility", "hidden", "important");
        if (node.style.getPropertyValue("opacity") !== "0" || node.style.getPropertyPriority("opacity") !== "important") node.style.setProperty("opacity", "0", "important");
        if (node.style.getPropertyValue("pointer-events") !== "none") node.style.setProperty("pointer-events", "none", "important");
        // Clip source overflow without changing its display or measured child sizes.
        if (node.style.getPropertyValue("overflow") !== "clip") node.style.setProperty("overflow", "clip", "important");
      }
    }
    this.updateTab();
  }

  private updateTab(): void {
    if (!this.disguise) return;
    for (const icon of this.doc.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
      if (icon === this.icon) continue;
      if (!this.icons.has(icon)) this.icons.set(icon, icon.getAttribute("href"));
      if (icon.getAttribute("href") !== ICON) icon.setAttribute("href", ICON);
    }
    for (const title of this.doc.querySelectorAll<HTMLTitleElement>("head > title")) {
      if (title !== this.temporaryTitle && !this.titles.has(title)) this.titles.set(title, title.textContent ?? "");
      if (title.textContent !== this.sessionName) title.textContent = this.sessionName;
    }
    // A background page can enter privacy before its parser reaches <title>.
    // Keep our early title separate, so restoring reveals the later source title.
    if (!this.doc.querySelector("head > title") && this.doc.head) {
      this.temporaryTitle = this.doc.createElement("title");
      this.temporaryTitle.textContent = this.sessionName;
      this.doc.head.append(this.temporaryTitle);
    }
    if (!this.icon && this.doc.head) {
      this.icon = this.doc.createElement("link");
      this.icon.rel = "icon";
      this.icon.href = ICON;
      this.doc.head.append(this.icon);
    }
  }

  private restoreMetadata(): void {
    this.icon?.remove(); this.icon = undefined;
    this.temporaryTitle?.remove(); this.temporaryTitle = undefined;
    for (const [title, text] of this.titles) if (title.textContent !== text) title.textContent = text;
    for (const [icon, href] of this.icons) restoreAttribute(icon, "href", href);
    this.titles.clear(); this.icons.clear();
  }
}

function restoreAttribute(node: Element, name: string, value: string | null): void {
  if (value === null) { if (node.hasAttribute(name)) node.removeAttribute(name); }
  else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}
