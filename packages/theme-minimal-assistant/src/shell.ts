import type { ReaderAction, ReaderCapabilities, ReaderState } from "../../adapter-sdk/src/index";
import { message } from "../../i18n/src/index";
import type { ColorScheme, SettingsV1 } from "../../storage/src/index";
import { minimalAssistantTheme } from "./manifest";

export interface ShellCallbacks {
  onAction(action: ReaderAction): void;
  onTogglePrivacy(): void;
  onToggleSidebar(): void;
}

export class MinimalAssistantShell {
  readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly privacyView: HTMLElement;
  private readonly readingStatus: HTMLElement;
  private readonly navigation: HTMLElement;
  private readonly privacyButton: HTMLButtonElement;
  private readonly sidebar: HTMLElement;
  private state: ReaderState | undefined;
  private privacyActive = false;

  constructor(
    private settings: SettingsV1,
    capabilities: ReaderCapabilities,
    callbacks: ShellCallbacks
  ) {
    this.host = document.createElement("div");
    this.host.id = "folioveil-root";
    this.host.setAttribute("aria-label", message("appName"));
    // Native actions can open menus; keep the originating shell click from
    // reaching the site's outside-click handler and immediately closing them.
    this.host.addEventListener("click", (event) => event.stopPropagation());
    this.shadow = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = createShellStyles();
    this.shadow.append(style);

    const app = element("div", "app");
    app.dataset.scheme = resolveScheme(settings.colorScheme);
    if (settings.sidebarCollapsed) app.dataset.sidebar = "collapsed";

    const backdrop = element("div", "backdrop");
    backdrop.setAttribute("aria-hidden", "true");
    app.append(backdrop);

    this.sidebar = element("aside", "sidebar");
    this.sidebar.innerHTML = `
      <div class="brand"><span class="brand-mark">F</span><span class="brand-name"></span></div>
      <nav class="sessions" aria-label="Sessions">
        <button class="session active" type="button"><span class="dot"></span><span data-i18n="assistantName"></span></button>
        <button class="session" type="button"><span class="dot muted"></span><span>Notes &amp; drafts</span></button>
        <button class="session" type="button"><span class="dot muted"></span><span>Project review</span></button>
      </nav>
      <div class="local-note">Local-only reading view</div>`;
    this.sidebar.querySelector(".brand-name")!.textContent = message("appName");
    this.sidebar.querySelector("[data-i18n='assistantName']")!.textContent = message("assistantName");
    app.append(this.sidebar);

    const header = element("header", "header");
    const sidebarToggle = iconButton("☰", message("toggleSidebar"));
    sidebarToggle.classList.add("sidebar-toggle");
    sidebarToggle.addEventListener("click", callbacks.onToggleSidebar);
    const heading = element("div", "heading");
    this.title = element("div", "title");
    this.subtitle = element("div", "subtitle");
    heading.append(this.title, this.subtitle);
    const controls = element("div", "header-controls");
    this.privacyButton = iconButton("◫", message("privacyMode"));
    this.privacyButton.addEventListener("click", callbacks.onTogglePrivacy);
    const restore = iconButton("↗", message("restoreNative"));
    restore.addEventListener("click", () => callbacks.onAction({ type: "restore-native-view" }));
    controls.append(this.privacyButton, restore);
    header.append(sidebarToggle, heading, controls);
    app.append(header);

    this.privacyView = element("main", "privacy-view");
    const privacyCard = element("article", "privacy-card");
    const privacyEyebrow = element("div", "privacy-eyebrow");
    privacyEyebrow.textContent = "WORKSPACE / OVERVIEW";
    const privacyHeading = document.createElement("h1");
    privacyHeading.textContent = message("privacyHeading");
    const privacyBody = document.createElement("p");
    privacyBody.textContent = message("privacyBody");
    const tasks = element("div", "task-list");
    for (const text of ["Review current milestones", "Consolidate open questions", "Prepare a concise status update"]) {
      const task = element("div", "task");
      task.innerHTML = `<span class="checkbox" aria-hidden="true"></span><span></span>`;
      task.lastElementChild!.textContent = text;
      tasks.append(task);
    }
    privacyCard.append(privacyEyebrow, privacyHeading, privacyBody, tasks);
    this.privacyView.append(privacyCard);
    app.append(this.privacyView);

    const composer = element("div", "composer-wrap");
    this.navigation = element("div", "navigation");
    const navigate = (action: ReaderAction): void => {
      if (!this.privacyActive) callbacks.onAction(action);
    };
    this.navigation.append(
      actionButton("←", message("previousPage"), capabilities.previousPage, () => navigate({ type: "previous-page" })),
      ...(capabilities.tableOfContentsPresentation === "native-control" ? [] : [
        actionButton("☷", message("tableOfContents"), capabilities.tableOfContents, () => navigate({ type: "open-toc" }))
      ]),
      actionButton("→", message("nextPage"), capabilities.nextPage, () => navigate({ type: "next-page" }))
    );
    const composerBox = element("div", "composer");
    const composerText = element("span", "composer-text");
    composerText.textContent = message("decorativeComposer");
    const composerIcon = element("span", "composer-icon");
    composerIcon.textContent = "↑";
    composerBox.append(composerText, composerIcon);
    this.readingStatus = element("div", "status");
    this.progress = element("span", "progress");
    const statusText = document.createElement("span");
    statusText.textContent = message("statusReady");
    this.readingStatus.append(statusText, this.progress);
    composer.append(this.navigation, composerBox, this.readingStatus);
    app.append(composer);

    this.shadow.append(app);
    this.applyTokens(app.dataset.scheme as "light" | "dark");
    this.setPrivacy(false);
  }

  mount(): void {
    document.documentElement.append(this.host);
  }

  updateState(state: ReaderState): void {
    this.state = { ...state };
    this.renderState();
  }

  setPrivacy(active: boolean): void {
    this.privacyActive = active;
    const app = this.shadow.querySelector<HTMLElement>(".app")!;
    app.dataset.privacy = active ? "active" : "inactive";
    this.privacyView.setAttribute("aria-hidden", String(!active));
    this.privacyButton.title = active ? message("exitPrivacy") : message("privacyMode");
    this.privacyButton.setAttribute("aria-label", this.privacyButton.title);
    if (active && this.navigation.contains(this.shadow.activeElement)) this.privacyButton.focus();
    this.navigation.hidden = active;
    this.navigation.toggleAttribute("inert", active);
    this.navigation.setAttribute("aria-hidden", String(active));
    this.readingStatus.hidden = active;
    this.renderState();
  }

  setSidebarCollapsed(collapsed: boolean): void {
    const app = this.shadow.querySelector<HTMLElement>(".app")!;
    if (collapsed) app.dataset.sidebar = "collapsed";
    else delete app.dataset.sidebar;
  }

  updateSettings(settings: SettingsV1): void {
    this.settings = settings;
    const app = this.shadow.querySelector<HTMLElement>(".app")!;
    const scheme = resolveScheme(settings.colorScheme);
    app.dataset.scheme = scheme;
    this.applyTokens(scheme);
    this.setSidebarCollapsed(settings.sidebarCollapsed);
  }

  unmount(): void {
    this.host.remove();
  }

  private renderState(): void {
    this.title.textContent = this.privacyActive ? message("privacyHeading") : this.state?.bookTitle || message("untitledBook");
    this.subtitle.textContent = this.privacyActive ? "" : this.state?.chapterTitle || message("untitledChapter");
    this.progress.textContent = !this.privacyActive && this.state?.progressLabel ? ` · ${this.state.progressLabel}` : "";
  }

  private applyTokens(scheme: "light" | "dark"): void {
    const tokens = minimalAssistantTheme.tokens[scheme];
    for (const [key, value] of Object.entries(tokens)) {
      this.host.style.setProperty(`--fv-${toKebab(key)}`, value);
    }
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.className = className;
  return value;
}

function iconButton(icon: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.textContent = icon;
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

function actionButton(icon: string, label: string, enabled: boolean, callback: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nav-button";
  button.innerHTML = `<span aria-hidden="true">${icon}</span><span></span>`;
  button.lastElementChild!.textContent = label;
  button.disabled = !enabled;
  button.addEventListener("click", callback);
  return button;
}

function resolveScheme(scheme: ColorScheme): "light" | "dark" {
  if (scheme !== "system") return scheme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function toKebab(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function createShellStyles(): string {
  return `
    :host { all: initial; color-scheme: light dark; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button { font: inherit; }
    .app { color: var(--fv-text); font-size: 14px; }
    .backdrop { position: fixed; inset: 0; z-index: 2147481000; background: var(--fv-background); pointer-events: none; }
    .sidebar, .header, .composer-wrap, .privacy-view { position: fixed; z-index: 2147483000; pointer-events: auto; }
    .sidebar { inset: 0 auto 0 0; width: 260px; padding: 18px 12px; background: var(--fv-sidebar); border-right: 1px solid var(--fv-border); transition: transform 160ms ease; }
    .brand { display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 8px; font-weight: 650; letter-spacing: -0.01em; }
    .brand-mark { display: grid; place-items: center; width: 28px; height: 28px; color: #fff; background: var(--fv-accent); border-radius: 9px; font-size: 13px; }
    .sessions { display: grid; gap: 4px; margin-top: 24px; }
    .session { display: flex; gap: 10px; align-items: center; width: 100%; min-width: 0; padding: 10px; color: var(--fv-muted-text); background: transparent; border: 0; border-radius: 9px; text-align: left; cursor: default; }
    .session.active { color: var(--fv-text); background: color-mix(in srgb, var(--fv-surface) 72%, transparent); }
    .dot { flex: 0 0 auto; width: 7px; height: 7px; background: var(--fv-accent); border-radius: 50%; }
    .dot.muted { background: var(--fv-border); }
    .local-note { position: absolute; right: 20px; bottom: 20px; left: 20px; color: var(--fv-muted-text); font-size: 11px; }
    .header { top: 0; right: 0; left: 260px; display: flex; align-items: center; gap: 10px; height: 64px; padding: 0 20px; background: color-mix(in srgb, var(--fv-background) 94%, transparent); border-bottom: 1px solid var(--fv-border); backdrop-filter: blur(12px); transition: left 160ms ease; }
    .heading { min-width: 0; flex: 1; }
    .title, .subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title { font-size: 14px; font-weight: 620; }
    .subtitle { margin-top: 2px; color: var(--fv-muted-text); font-size: 11px; }
    .header-controls { display: flex; gap: 7px; }
    .icon-button { display: grid; place-items: center; width: 34px; height: 34px; color: var(--fv-muted-text); background: var(--fv-surface); border: 1px solid var(--fv-border); border-radius: 9px; cursor: pointer; }
    .icon-button:hover { color: var(--fv-text); border-color: var(--fv-muted-text); }
    .sidebar-toggle { display: grid; }
    .composer-wrap { right: 0; bottom: 0; left: 260px; display: grid; grid-template-columns: auto minmax(260px, 680px); justify-content: center; gap: 12px; min-height: 88px; padding: 10px 20px 8px; background: linear-gradient(to top, var(--fv-background) 76%, transparent); transition: left 160ms ease; }
    .navigation { display: flex; align-items: flex-start; gap: 5px; padding-top: 2px; }
    .nav-button { display: grid; place-items: center; width: 34px; height: 34px; color: var(--fv-muted-text); background: var(--fv-surface); border: 1px solid var(--fv-border); border-radius: 9px; cursor: pointer; }
    .nav-button span:last-child { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .nav-button:disabled { opacity: 0.35; cursor: not-allowed; }
    .composer { display: flex; align-items: center; min-height: 44px; padding: 0 12px 0 16px; color: var(--fv-muted-text); background: var(--fv-surface); border: 1px solid var(--fv-border); border-radius: 15px; box-shadow: var(--fv-shadow); }
    .composer-text { flex: 1; }
    .composer-icon { display: grid; place-items: center; width: 28px; height: 28px; color: #fff; background: var(--fv-accent); border-radius: 8px; }
    .status { grid-column: 2; justify-self: center; color: var(--fv-muted-text); font-size: 10px; }
    .privacy-view { inset: 64px 0 88px 260px; display: none; overflow: auto; padding: clamp(28px, 6vw, 86px); background: var(--fv-background); }
    .app[data-privacy='active'] .privacy-view { display: block; }
    .app[data-privacy='active'] .composer-wrap { grid-template-columns: minmax(0, 680px); }
    .privacy-card { max-width: 780px; margin: 0 auto; padding: clamp(28px, 4vw, 52px); background: var(--fv-surface); border: 1px solid var(--fv-border); border-radius: 18px; box-shadow: var(--fv-shadow); }
    .privacy-eyebrow { color: var(--fv-accent); font-size: 11px; font-weight: 700; letter-spacing: .12em; }
    .privacy-card h1 { margin: 18px 0 12px; font-size: clamp(26px, 4vw, 42px); font-weight: 650; letter-spacing: -.035em; }
    .privacy-card p { max-width: 620px; margin: 0; color: var(--fv-muted-text); font-size: 16px; line-height: 1.7; }
    .task-list { display: grid; gap: 10px; margin-top: 34px; }
    .task { display: flex; align-items: center; gap: 12px; padding: 13px 14px; border: 1px solid var(--fv-border); border-radius: 10px; }
    .checkbox { width: 16px; height: 16px; border: 1px solid var(--fv-muted-text); border-radius: 4px; }
    .app[data-sidebar='collapsed'] .sidebar { transform: translateX(-260px); }
    .app[data-sidebar='collapsed'] .header, .app[data-sidebar='collapsed'] .composer-wrap { left: 0; }
    .app[data-sidebar='collapsed'] .privacy-view { left: 0; }
    .app[data-sidebar='collapsed'] .sidebar-toggle { display: grid; }
    @media (max-width: 820px) {
      .sidebar { transform: translateX(-260px); }
      .header, .composer-wrap, .privacy-view { left: 0; }
      .sidebar-toggle { display: grid; }
      .composer-wrap { grid-template-columns: 1fr; padding-left: 12px; padding-right: 12px; }
      .navigation { display: none; }
      .status { grid-column: 1; }
    }
    @media (prefers-reduced-motion: reduce) { .sidebar, .header, .composer-wrap { transition: none; } }
  `;
}
