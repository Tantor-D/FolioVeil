import type { SettingsV2 } from "../../storage/src/index";

export interface ControlsSurface {
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot | Document;
  readonly scroller: HTMLElement;
  readonly panel: HTMLElement;
  togglePanel(keyboard?: boolean): void;
  closePanel(restoreFocus?: boolean): void;
  isPanelOpen(): boolean;
  isPreviewOpen(): boolean;
  closePreview(restoreFocus?: boolean): void;
  navigate(direction: "previous" | "next"): void;
  requestFetchMore?(): void;
  getPrivacy(): boolean;
  setPrivacy(active: boolean): void;
}

/** Passive hit testing means the hotzone never intercepts content selection. */
export class ControlsController {
  private mounted = false;
  private dwell?: ReturnType<typeof setTimeout>;
  private hide?: ReturnType<typeof setTimeout>;
  private inHotzone = false;
  private mustLeave = false;
  private pointerDown = false;
  private panelObserver?: MutationObserver;
  private wasPanelOpen = false;
  private nextKeyHeld = false;

  constructor(private readonly shell: ControlsSurface, private settings: SettingsV2, private readonly options: { keyboardCommands?: boolean } = {}, private readonly win: Window = window) {}

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.wasPanelOpen = this.shell.isPanelOpen();
    this.panelObserver = new MutationObserver(() => {
      const open = this.shell.isPanelOpen();
      if (this.wasPanelOpen && !open) { this.mustLeave = this.inHotzone; this.clearTimers(); }
      this.wasPanelOpen = open;
    });
    this.panelObserver.observe(this.shell.panel, { attributes: true, attributeFilter: ["hidden"] });
    this.win.addEventListener("pointermove", this.onPointerMove, { passive: true });
    this.win.addEventListener("pointerdown", this.onPointerDown, true);
    this.win.addEventListener("pointerup", this.onPointerUp, true);
    this.win.addEventListener("pointercancel", this.onPointerUp, true);
    this.win.addEventListener("keydown", this.onKeyDown, true);
    this.win.addEventListener("keyup", this.onKeyUp, true);
    this.win.addEventListener("blur", this.onBlur);
    this.win.document.addEventListener("visibilitychange", this.onVisibility);
  }

  updateSettings(settings: SettingsV2): void { this.settings = settings; this.clearTimers(); }

  togglePanel(keyboard = true): void {
    this.clearTimers();
    if (this.shell.isPanelOpen()) { this.closePanel(); return; }
    this.shell.togglePanel(keyboard);
    this.wasPanelOpen = this.shell.isPanelOpen();
  }

  unmount(): void {
    this.mounted = false;
    this.panelObserver?.disconnect();
    this.clearTimers();
    this.win.removeEventListener("pointermove", this.onPointerMove);
    this.win.removeEventListener("pointerdown", this.onPointerDown, true);
    this.win.removeEventListener("pointerup", this.onPointerUp, true);
    this.win.removeEventListener("pointercancel", this.onPointerUp, true);
    this.win.removeEventListener("keydown", this.onKeyDown, true);
    this.win.removeEventListener("keyup", this.onKeyUp, true);
    this.nextKeyHeld = false;
    this.win.removeEventListener("blur", this.onBlur);
    this.win.document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private closePanel(restoreFocus = true): void {
    this.mustLeave = this.inHotzone;
    this.shell.closePanel(restoreFocus);
    this.wasPanelOpen = false;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointerDown = true;
    this.clearTimers();
    if (this.shell.isPanelOpen() && !event.composedPath().includes(this.shell.panel)) this.closePanel(false);
  };
  private readonly onPointerUp = (): void => { this.pointerDown = false; };
  private readonly onPointerMove = (event: PointerEvent): void => {
    const right = this.settings.hotzoneCorner.endsWith("right");
    const bottom = this.settings.hotzoneCorner.startsWith("bottom");
    const width = this.win.document.documentElement.clientWidth || this.win.innerWidth;
    const height = this.win.innerHeight;
    // Leave eight pixels beside the scrollbar; no DOM hit target is added.
    const horizontal = right ? event.clientX >= width - 32 && event.clientX <= width - 8 : event.clientX >= 8 && event.clientX <= 32;
    const vertical = bottom ? event.clientY >= height - 48 : event.clientY <= 48;
    const inside = horizontal && vertical;
    if (!inside) this.mustLeave = false;
    if (this.inHotzone && !inside && this.dwell) { clearTimeout(this.dwell); this.dwell = undefined; }
    this.inHotzone = inside;
    const inPanel = event.composedPath().includes(this.shell.panel);
    if (inside || inPanel) { if (this.hide) clearTimeout(this.hide); this.hide = undefined; }
    if (this.shell.isPanelOpen()) {
      if (!inside && !inPanel && !this.panelHasFocus() && !this.hide && !this.pointerDown) {
        this.hide = setTimeout(() => { this.hide = undefined; if (!this.panelHasFocus()) this.closePanel(false); }, this.settings.panelHideDelay);
      }
      return;
    }
    if (!inside || this.mustLeave || !this.canDwell() || this.dwell) return;
    this.dwell = setTimeout(() => {
      this.dwell = undefined;
      if (this.inHotzone && !this.mustLeave && this.canDwell()) this.togglePanel(false);
    }, this.settings.hotzoneDelay);
  };

  private canDwell(): boolean {
    return this.settings.hotzoneEnabled && !this.pointerDown && !this.shell.isPreviewOpen() && !this.win.document.hidden && this.win.document.hasFocus() && !this.hasSelection();
  }
  private panelHasFocus(): boolean { return !!this.shell.shadow.activeElement && this.shell.panel.contains(this.shell.shadow.activeElement); }
  private hasSelection(): boolean { return !!this.win.getSelection()?.toString() || !!(this.shell.shadow as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()?.toString(); }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const nextKey = event.code === "KeyN" || event.key.toLowerCase() === "n";
    const held = this.nextKeyHeld;
    // Remember even ignored presses: leaving an input or finishing a request
    // while the key is held must never start a deferred request.
    if (nextKey) this.nextKeyHeld = true;
    if (event.isComposing || event.keyCode === 229) return;
    const command = this.options.keyboardCommands !== false && event.shiftKey && !event.metaKey && ((event.ctrlKey && !event.altKey) || (event.altKey && !event.ctrlKey));
    if (command && event.code === "KeyO") { event.preventDefault(); event.stopImmediatePropagation(); this.togglePanel(); return; }
    if (command && event.code === "KeyP") { event.preventDefault(); event.stopImmediatePropagation(); this.shell.setPrivacy(!this.shell.getPrivacy()); this.clearTimers(); this.mustLeave = this.inHotzone; return; }
    if (event.key === "Escape") {
      if (this.shell.isPreviewOpen()) { this.shell.closePreview(true); event.preventDefault(); event.stopImmediatePropagation(); }
      else if (this.shell.isPanelOpen()) { this.closePanel(); event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    const target = event.composedPath()[0];
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || this.shell.getPrivacy() || this.shell.isPreviewOpen() || this.hasSelection() || this.panelHasFocus()) return;
    if (target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])"))) return;
    if (nextKey && this.shell.requestFetchMore) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!held && !event.repeat) this.shell.requestFetchMore();
      return;
    }
    if (this.settings.arrowNavigation && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault(); event.stopImmediatePropagation(); this.shell.navigate(event.key === "ArrowLeft" ? "previous" : "next");
    }
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "KeyN" || event.key.toLowerCase() === "n") this.nextKeyHeld = false;
  };
  private readonly onBlur = (): void => {
    this.nextKeyHeld = false;
    this.clearTimers(); this.pointerDown = false; this.mustLeave = this.inHotzone;
    this.closePanel(false); this.shell.closePreview(false);
    if (this.settings.autoPrivacy) this.shell.setPrivacy(true);
  };
  private readonly onVisibility = (): void => { if (this.win.document.hidden) this.onBlur(); };
  private clearTimers(): void {
    if (this.dwell) clearTimeout(this.dwell);
    if (this.hide) clearTimeout(this.hide);
    this.dwell = undefined; this.hide = undefined;
  }
}
