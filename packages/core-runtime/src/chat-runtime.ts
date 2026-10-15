import { extractArxivDocument, releaseArxivResources } from "../../adapter-arxiv/src/index";
import { isWeReadUrl, WeReadContentSource } from "../../adapter-weread/src/structured";
import type { ReaderDocument } from "../../content-model/src/index";
import { DEFAULT_SETTINGS, loadSettings, migrateSettings, saveSettings, type SettingsV2 } from "../../storage/src/index";
import { ChatReaderShell } from "../../theme-minimal-assistant/src/chat-shell";
import { ControlsController } from "./controls-controller";
import { SourceIsolation } from "./source-isolation";

export interface ChatRuntimeStatus {
  enabled: boolean;
  mounted: boolean;
  privacy: boolean;
  supported: boolean;
  error: boolean;
}

export function isSupportedArxivUrl(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname === "arxiv.org" && /^\/html\/[^/]+/.test(parsed.pathname); }
  catch { return false; }
}

export function supportedSite(url: string): "weread" | "arxiv" | undefined {
  return isWeReadUrl(url) ? "weread" : isSupportedArxivUrl(url) ? "arxiv" : undefined;
}

/** Source-independent lifecycle; only the adapter knows the source DOM. */
export class ChatReaderRuntime {
  private settings = structuredClone(DEFAULT_SETTINGS);
  private shell?: ChatReaderShell;
  private controls?: ControlsController;
  private isolation?: SourceIsolation;
  private generation = 0;
  private currentDocument?: ReaderDocument;
  private error = false;
  private lastUrl = location.href;
  private readonly site = supportedSite(location.href);
  private weread?: WeReadContentSource;

  private get enabled(): boolean { return !!this.site && this.settings.enabledSites[this.site]; }

  private startSource(): void {
    if (this.site !== "weread" || this.weread) return;
    this.weread = new WeReadContentSource(document, () => location.href);
    this.weread.start();
    this.weread.subscribe(() => {
      if ((this.currentDocument || this.error) && this.shell) void this.readCurrentDocument();
    });
  }

  async start(): Promise<void> {
    if (!this.site) return;
    this.startSource();
    // The storage read is asynchronous. A neutral cover precedes it even on first use.
    // Disabled pages are released as soon as their preference is known.
    this.isolation = new SourceIsolation();
    this.isolation.mount(this.settings.sessionName, false);
    this.installMessages();
    this.installSettingsListener();
    try { this.settings = await loadSettings(); }
    catch { this.settings = structuredClone(DEFAULT_SETTINGS); }
    if (this.enabled) await this.mount();
    else { this.isolation.restore(); this.isolation = undefined; this.weread?.stop(); this.weread = undefined; }
    setInterval(() => {
      if (this.lastUrl === location.href) return;
      this.lastUrl = location.href;
      if (this.enabled) void this.readCurrentDocument();
    }, 500);
  }

  getStatus(): ChatRuntimeStatus {
    return { enabled: this.enabled, mounted: !!this.shell, privacy: this.shell?.getPrivacy() ?? false, supported: !!supportedSite(location.href), error: this.error };
  }

  async enable(): Promise<void> {
    if (!this.site) return;
    this.settings = migrateSettings({ ...this.settings, enabledSites: { ...this.settings.enabledSites, [this.site]: true } });
    await saveSettings(this.settings);
    await this.mount();
  }

  async restore(): Promise<void> {
    if (!this.site) return;
    this.settings = migrateSettings({ ...this.settings, enabledSites: { ...this.settings.enabledSites, [this.site]: false } });
    this.dispose();
    await saveSettings(this.settings);
  }

  private async mount(): Promise<void> {
    if (this.shell) return;
    this.startSource();
    if (!this.isolation) { this.isolation = new SourceIsolation(); this.isolation.mount(this.settings.sessionName, false); }
    this.shell = new ChatReaderShell(this.settings, {
      onSettings: patch => void this.setSettings(patch),
      onRestore: () => void this.restore(),
      onRetry: () => this.site === "weread" && !this.weread?.getDocument() ? location.reload() : void this.readCurrentDocument(),
      onPrivacyChange: active => this.isolation?.update(this.settings.sessionName, active || this.settings.disguiseTab)
    });
    this.isolation.addOwnedNode(this.shell.host);
    this.shell.mount();
    this.shell.setStatus("loading");
    // Opening the extension popup can blur the page before this listener exists.
    // Start protected when automatic privacy is enabled and the page is inactive.
    if (this.settings.autoPrivacy && (document.hidden || !document.hasFocus())) this.shell.setPrivacy(true);
    this.controls = new ControlsController(this.shell, this.settings, { keyboardCommands: false });
    this.controls.mount();
    this.isolation.revealShell();
    await this.readCurrentDocument();
  }

  private async readCurrentDocument(): Promise<void> {
    const generation = ++this.generation;
    const shell = this.shell;
    if (!shell) return;
    shell.closePanel();
    shell.closePreview(false);
    shell.setStatus("loading");
    if (document.readyState === "loading") await new Promise<void>(resolve => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
    if (generation !== this.generation || shell !== this.shell) return;
    this.isolation?.update(this.settings.sessionName, shell.getPrivacy() || this.settings.disguiseTab);
    try {
      if (supportedSite(location.href) !== this.site) throw new Error("unsupported-route");
      const content = this.site === "weread" ? await this.weread!.read() : extractArxivDocument(document, location.href);
      if (generation !== this.generation || shell !== this.shell) { releaseArxivResources(content); return; }
      if (this.currentDocument) releaseArxivResources(this.currentDocument);
      this.currentDocument = content;
      shell.setDocument(content);
      shell.setStatus("ready");
      this.error = false;
    } catch {
      if (generation !== this.generation || shell !== this.shell) return;
      this.error = true;
      // Failure never restores the underlying source or exposes error payloads.
      shell.setStatus("error", this.site === "weread" ? "暂时无法继续。请在操作面板中重试，以重新加载当前内容。" : "暂时无法继续，请通过操作面板重试或恢复原页面。");
    }
  }

  private async setSettings(patch: Partial<SettingsV2>): Promise<void> {
    this.settings = migrateSettings({ ...this.settings, ...patch });
    this.applySettings();
    await saveSettings(this.settings);
  }

  private applySettings(): void {
    this.shell?.updateSettings(this.settings);
    this.controls?.updateSettings(this.settings);
    if (this.settings.autoPrivacy && (document.hidden || !document.hasFocus())) this.shell?.setPrivacy(true);
    if (document.readyState !== "loading") this.isolation?.update(this.settings.sessionName, (this.shell?.getPrivacy() ?? false) || this.settings.disguiseTab);
  }

  private dispose(): void {
    ++this.generation;
    this.weread?.stop(); this.weread = undefined;
    this.controls?.unmount(); this.controls = undefined;
    this.shell?.unmount(); this.shell = undefined;
    if (this.currentDocument) releaseArxivResources(this.currentDocument);
    this.currentDocument = undefined;
    this.isolation?.restore(); this.isolation = undefined;
    this.error = false;
  }

  private installMessages(): void {
    chrome.runtime.onMessage.addListener((request: unknown, _sender, respond) => {
      const message = request as { type?: string; enabled?: boolean };
      if (message.type === "FV_GET_STATUS") { respond(this.getStatus()); return false; }
      if (message.type === "FV_SET_ENABLED") {
        void (message.enabled ? this.enable() : this.restore()).then(() => respond(this.getStatus())).catch(() => respond(this.getStatus()));
        return true;
      }
      if (message.type === "FV_TOGGLE_PRIVACY") { this.shell?.setPrivacy(!this.shell.getPrivacy()); respond(this.getStatus()); return false; }
      if (message.type === "FV_TOGGLE_CONTROLS") { this.controls?.togglePanel(); respond(this.getStatus()); return false; }
      return false;
    });
  }

  private installSettingsListener(): void {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.settings) return;
      const previousEnabled = this.enabled;
      this.settings = migrateSettings(changes.settings.newValue);
      if (this.enabled && !previousEnabled) void this.mount();
      else if (!this.enabled && previousEnabled) this.dispose();
      else this.applySettings();
    });
  }
}
