import type { AdapterSession, ReaderAdapter, ReaderState } from "../../adapter-sdk/src/index";
import { message } from "../../i18n/src/index";
import { type SettingsV1, loadSettings, saveSettings } from "../../storage/src/index";
import { MinimalAssistantShell } from "../../theme-minimal-assistant/src/shell";
import { NativeOverlay } from "./native-overlay";
import { appendSafeLog, createSafeLogEntry } from "./safe-log";

export interface RuntimeStatus {
  enabled: boolean;
  mounted: boolean;
  privacy: boolean;
  supported: boolean;
  state?: ReaderState;
}

export class ReaderRuntime {
  private settings: SettingsV1 | undefined;
  private session: AdapterSession | undefined;
  private shell: MinimalAssistantShell | undefined;
  private overlay: NativeOverlay | undefined;
  private unsubscribe: (() => void) | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private retryObserver: MutationObserver | undefined;
  private privacy = false;
  private state: ReaderState | undefined;
  private mounting = false;
  private destroyed = false;
  private lastUrl = location.href;

  constructor(private readonly adapter: ReaderAdapter) {}

  async start(): Promise<void> {
    this.settings = await loadSettings();
    this.installMessageListener();
    this.installStorageListener();
    this.installRouteWatcher();
    if (this.settings.enabledSites.weread) await this.enable(false);
  }

  async enable(persist = true): Promise<void> {
    if (!this.settings) this.settings = await loadSettings();
    this.settings.enabledSites.weread = true;
    if (persist) await saveSettings(this.settings);
    await this.tryMount();
  }

  async disable(persist = true): Promise<void> {
    if (!this.settings) this.settings = await loadSettings();
    this.settings.enabledSites.weread = false;
    if (persist) await saveSettings(this.settings);
    await this.unmount("restored");
  }

  async togglePrivacy(): Promise<void> {
    if (!this.session || !this.overlay || !this.shell) return;
    this.privacy = !this.privacy;
    this.overlay.setPrivacy(this.privacy);
    this.shell.setPrivacy(this.privacy);
    await this.log("privacy_toggled", this.privacy ? "active" : "inactive");
  }

  getStatus(): RuntimeStatus {
    return {
      enabled: this.settings?.enabledSites.weread ?? false,
      mounted: !!this.session,
      privacy: this.privacy,
      supported: this.adapter.matches(location),
      state: this.state
    };
  }

  private async tryMount(): Promise<void> {
    if (this.destroyed || this.mounting || this.session || !this.adapter.matches(location)) return;
    this.mounting = true;
    try {
      const probe = await this.adapter.probe(document);
      if (probe.kind !== "reader" || probe.confidence < 0.65) {
        await this.log("mount_skipped", probe.reason);
        this.watchForReadableSurface();
        return;
      }

      const session = await this.adapter.mount({ document, location });
      const contentSurface = await session.getContentSurface();
      const capabilities = session.getCapabilities();
      const settings = this.settings!;
      const overlay = new NativeOverlay(contentSurface, settings);
      const shell = new MinimalAssistantShell(settings, capabilities, {
        onAction: (action) => {
          if (action.type === "restore-native-view") void this.disable(true);
          else void session.perform(action);
        },
        onTogglePrivacy: () => void this.togglePrivacy(),
        onToggleSidebar: () => void this.toggleSidebar()
      });
      shell.mount();

      this.session = session;
      this.overlay = overlay;
      this.shell = shell;
      this.stopRetryObserver();
      this.unsubscribe = session.subscribe((state) => {
        this.state = state;
        shell.updateState(state);
        if (state.status === "signed-out" || state.status === "error") void this.failSafe(state.errorCode ?? state.status);
      });
      this.startHealthChecks();
      await this.log("mount_succeeded");
    } catch (error) {
      await this.log("mount_failed", safeErrorCode(error));
      await this.unmount();
      this.showNotice(message("adapterFailed"));
    } finally {
      this.mounting = false;
    }
  }

  private watchForReadableSurface(): void {
    if (this.retryObserver || !document.body) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.retryObserver = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void this.tryMount(), 250);
    });
    this.retryObserver.observe(document.body, { childList: true, subtree: true });
  }

  private stopRetryObserver(): void {
    this.retryObserver?.disconnect();
    this.retryObserver = undefined;
  }

  private startHealthChecks(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => void this.checkHealth(), 15_000);
  }

  private async checkHealth(): Promise<void> {
    if (!this.session) return;
    const health = await this.session.healthCheck();
    if (!health.healthy) await this.failSafe(health.code);
  }

  private async failSafe(code: string): Promise<void> {
    await this.log("health_failed", code);
    await this.unmount();
    this.showNotice(message("adapterFailed"));
  }

  private async unmount(logCode?: "restored"): Promise<void> {
    this.stopRetryObserver();
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.overlay?.unmount();
    this.overlay = undefined;
    this.shell?.unmount();
    this.shell = undefined;
    const currentSession = this.session;
    this.session = undefined;
    await currentSession?.unmount();
    this.privacy = false;
    this.state = undefined;
    if (logCode) await this.log(logCode);
  }

  private async toggleSidebar(): Promise<void> {
    if (!this.settings) return;
    this.settings.sidebarCollapsed = !this.settings.sidebarCollapsed;
    await saveSettings(this.settings);
    this.shell?.setSidebarCollapsed(this.settings.sidebarCollapsed);
    this.overlay?.update(this.settings);
  }

  private installMessageListener(): void {
    chrome.runtime.onMessage.addListener((request: unknown, _sender, sendResponse) => {
      const message = request as { type?: string; enabled?: boolean };
      if (message.type === "FV_GET_STATUS") {
        sendResponse(this.getStatus());
        return false;
      }
      if (message.type === "FV_SET_ENABLED") {
        void (message.enabled ? this.enable(true) : this.disable(true)).then(() => sendResponse(this.getStatus()));
        return true;
      }
      if (message.type === "FV_TOGGLE_PRIVACY") {
        void this.togglePrivacy().then(() => sendResponse(this.getStatus()));
        return true;
      }
      return false;
    });
  }

  private installStorageListener(): void {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes.settings?.newValue) return;
      void loadSettings().then((settings) => {
        const wasEnabled = this.settings?.enabledSites.weread ?? false;
        this.settings = settings;
        this.shell?.updateSettings(settings);
        this.overlay?.update(settings);
        if (settings.enabledSites.weread && !wasEnabled) void this.tryMount();
        if (!settings.enabledSites.weread && wasEnabled) void this.unmount();
      });
    });
  }

  private installRouteWatcher(): void {
    setInterval(() => {
      if (this.lastUrl === location.href) return;
      this.lastUrl = location.href;
      void this.unmount().then(() => {
        if (this.settings?.enabledSites.weread) void this.tryMount();
      });
    }, 750);
  }

  private showNotice(text: string): void {
    const existing = document.getElementById("folioveil-notice");
    existing?.remove();
    const host = document.createElement("div");
    host.id = "folioveil-notice";
    const shadow = host.attachShadow({ mode: "closed" });
    const notice = document.createElement("div");
    notice.textContent = text;
    notice.setAttribute("role", "status");
    notice.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;padding:12px 14px;color:#252527;background:#fff;border:1px solid #d8d8dd;border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.15);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
    shadow.append(notice);
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 6000);
  }

  private async log(code: Parameters<typeof createSafeLogEntry>[2], detail?: string): Promise<void> {
    await appendSafeLog(createSafeLogEntry(this.adapter.id, this.adapter.version, code, detail));
  }
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  return error.message.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "unknown";
}
